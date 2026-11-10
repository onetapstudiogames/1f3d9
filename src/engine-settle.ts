/**
 * Lazy settle (decisions #105 and #106): nothing runs while nobody is there. When
 * a resident arrives, speaks, acts, or reads `me` in a room, the room first
 * resolves its due timers, then records up to 64 ends that came there (things
 * ending), then runs each recorded thing's end try once and the wake tries its things
 * are owed, sharing one budget.
 */
import {
  EngineError,
  engineSql,
  logUnrecognizedExecutionFailure,
  lockPlaceRowsTopDown,
  publicSkippedEffects,
  resolveDueEffects,
  withEngineTransaction,
  type TaggedSql,
} from './engine.ts'
import {
  currentDaySecret,
  ensureChanceDays,
  newRollLog,
  nextRollId,
  recordFailedRolls,
  recordRoll,
  wakePickKey,
} from './engine-chance.ts'
import {
  executeEffectsWithOutcome,
  newAbilityLog,
  type EffectExecutionContext,
} from './engine-effects.ts'
import { GAZETTE_ROOM_ID } from './gazette.ts'
import {
  MAX_WAKE_EFFECTS_PER_SETTLE,
  MAX_WAKE_TRIES_PER_THING_PER_SETTLE,
  WAKE_SETTLE_MIN_INTERVAL_SECONDS,
} from './engine-limits.ts'
import { wakeProgramOf, type WakeProgram } from './physics.ts'
import { effectPlaceIds, lockEffectResidents } from './engine-place-plan.ts'
import {
  INTERNAL_TRY_ERROR,
  loadEndUnits,
  NO_LONGER_ELIGIBLE,
  recordRoomEnds,
  recordTry,
  recordWakeTryApplied,
  runEndTry,
  type RoomEnds,
  type TryStatus,
  type Unit,
} from './engine-end-try.ts'
import { thingEndingGuardRefusal } from './thing-ending-refusals.ts'

const WAKE_SETTLE_LOCK_CLASS = 0x1f3d9003

export type SettleTrigger = 'arrive' | 'talk' | 'act' | 'me'

export interface SettleSummary {
  /** Null when the settle only recorded ends and claimed no tries. */
  readonly settle_id: number | null
  /** Tries run, end tries included; a try the budget never started is not counted. */
  readonly tried: number
  readonly woke: number
  readonly forfeited: number
  /** Ends this settle recorded in its room. */
  readonly ended: number
  /** End tries this settle ran. */
  readonly end_tries: number
  /** More ends had come in the room than one settle records; the next settle records them. */
  readonly more_due: boolean
}

/** A settle's public summary, and the things it recorded, for the door that called it. */
export interface RoomSettleResult {
  readonly settle: SettleSummary | null
  readonly recordedThingIds: readonly number[]
}

const NO_ENDS: RoomEnds = Object.freeze({ recorded: Object.freeze([]), moreDue: false })

interface Candidate {
  readonly thingId: number
  readonly ownerId: number
  readonly kindId: number
  readonly revision: number
  readonly traitId: number
  readonly traitName: string
  readonly program: WakeProgram
  readonly lastTryAt: number | null
  readonly clockAt: number | null
}

interface RoomDials {
  readonly ownerId: number | null
  readonly wakeVisitors: boolean
  readonly pins: readonly number[]
  readonly blockedThingIds: readonly number[]
  readonly blockedResidentIds: readonly number[]
  readonly randomCap: number
}

interface Claim {
  readonly settleId: number
  readonly budget: number
  /** End units first (outside the random pick), then pinned wake units, then the picked ones. */
  readonly runOrder: readonly Unit[]
  readonly forfeited: number
  readonly candidates: ReadonlyMap<number, Candidate>
  readonly settlerHandle: string
}

function ids(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(id => Number.isSafeInteger(id) && id > 0) : []
}

function millis(value: unknown): number | null {
  if (value == null) return null
  const time = new Date(value as string | Date).getTime()
  return Number.isFinite(time) ? time : null
}

function allowedHere(candidate: Candidate, room: RoomDials): boolean {
  if (room.blockedThingIds.includes(candidate.thingId)) return false
  if (room.blockedResidentIds.includes(candidate.ownerId)) return false
  return candidate.ownerId === room.ownerId || room.wakeVisitors || room.pins.includes(candidate.thingId)
}

async function loadCandidates(placeId: number, db: TaggedSql): Promise<Candidate[]> {
  const rows = await db`
    SELECT thing.id, thing.owner_id,
      coalesce(thing.as_kind_id, thing.kind_id) AS kind_id,
      coalesce(thing.as_revision, thing.current_revision) AS current_revision,
      trait.id AS trait_id, trait.name AS trait_name, trait.recipe,
      state.last_try_at, state.clock_at
    FROM things thing
    JOIN kind_revision_traits link
      ON link.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
      AND link.revision = coalesce(thing.as_revision, thing.current_revision)
    JOIN traits trait ON trait.id = link.trait_id
    LEFT JOIN thing_wake_state state ON state.thing_id = thing.id
    WHERE thing.place_id = ${placeId} AND thing.withdrawn_at IS NULL AND thing.wake_enabled
      AND EXISTS (SELECT 1 FROM residents owner WHERE owner.id = thing.owner_id AND owner.retirement_state = 'active')
      AND thing.held_by IS NULL AND thing.active_offer_id IS NULL
      -- A thing whose end has come never wakes here; a thing with no end costs no more.
      AND (thing.ending_rule IS NULL OR (thing.ended_at IS NULL
        AND NOT coalesce(thing_end_due_at_row(thing) <= transaction_timestamp(), false)))
      AND trait.recipe ? 'wake'
      AND NOT EXISTS (
        SELECT 1 FROM transfer_offers offer
        WHERE offer.asset_type = 'thing' AND offer.asset_id = thing.id AND offer.status = 'open'
      )
      AND coalesce((
        SELECT moderation.action FROM moderation_actions moderation
        WHERE moderation.target_type = 'thing' AND moderation.target_id = thing.id
        ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
      ), 'restore') <> 'remove'
    ORDER BY thing.id, link.position
  ` as Array<Record<string, unknown>>
  const byThing = new Map<number, Candidate>()
  for (const row of rows) {
    const thingId = Number(row.id)
    const program = wakeProgramOf(row.recipe)
    if (byThing.has(thingId) || program === null) continue
    byThing.set(thingId, Object.freeze({
      thingId,
      ownerId: Number(row.owner_id),
      kindId: Number(row.kind_id),
      revision: Number(row.current_revision),
      traitId: Number(row.trait_id),
      traitName: String(row.trait_name),
      program,
      lastTryAt: millis(row.last_try_at),
      clockAt: millis(row.clock_at),
    }))
  }
  return [...byThing.values()]
}

/**
 * One cheap read that lets a room with no waking things and no end try waiting skip the
 * wake part entirely. A remnant never wakes, but its pending end try still needs a claim.
 */
async function roomMayWake(placeId: number, db: TaggedSql): Promise<boolean> {
  const rows = await db`
    /* wake:probe */
    SELECT EXISTS (
      SELECT 1 FROM things thing
      JOIN kind_revision_traits link
        ON link.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
        AND link.revision = coalesce(thing.as_revision, thing.current_revision)
      JOIN traits trait ON trait.id = link.trait_id
      WHERE thing.place_id = ${placeId} AND thing.withdrawn_at IS NULL AND thing.wake_enabled
        AND EXISTS (SELECT 1 FROM residents owner WHERE owner.id = thing.owner_id AND owner.retirement_state = 'active')
        AND (thing.ending_rule IS NULL OR (thing.ended_at IS NULL
          AND NOT coalesce(thing_end_due_at_row(thing) <= transaction_timestamp(), false)))
        AND trait.recipe ? 'wake'
    ) OR EXISTS (
      SELECT 1 FROM things pending
      WHERE pending.place_id = ${placeId} AND pending.end_program_state = 'pending'
        AND EXISTS (SELECT 1 FROM residents owner WHERE owner.id = pending.owner_id AND owner.retirement_state = 'active')
        AND pending.withdrawn_at IS NULL
    ) AS waking
  ` as Array<{ waking?: unknown }>
  return rows[0]?.waking === true
}

interface Plan {
  readonly units: readonly Unit[]
  readonly forfeited: number
  readonly clockAdvance: ReadonlyMap<number, number>
  readonly anchors: readonly number[]
}

/** Work out what each allowed thing is owed right now; the rest of its owed clock tries are forfeited. */
function planUnits(
  candidates: readonly Candidate[],
  room: RoomDials,
  trigger: SettleTrigger,
  now: number,
): Plan {
  const units: Unit[] = []
  const clockAdvance = new Map<number, number>()
  const anchors: number[] = []
  let forfeited = 0
  for (const candidate of candidates) {
    if (!allowedHere(candidate, room)) continue
    const everyMs = candidate.program.every_seconds * 1_000
    const pinned = room.pins.includes(candidate.thingId)
    let index = 0
    if (
      (trigger === 'arrive' || trigger === 'talk')
      && candidate.program.on.includes(trigger)
      && (candidate.lastTryAt === null || now - candidate.lastTryAt >= everyMs)
    ) {
      units.push({ thingId: candidate.thingId, unitIndex: index, reason: trigger, pinned })
      index += 1
    }
    if (!candidate.program.on.includes('clock')) continue
    if (candidate.clockAt === null) {
      anchors.push(candidate.thingId)
      continue
    }
    const owed = Math.max(0, Math.floor((now - candidate.clockAt) / everyMs))
    if (owed === 0) continue
    const run = Math.min(owed, MAX_WAKE_TRIES_PER_THING_PER_SETTLE - index)
    for (let count = 0; count < run; count += 1) {
      units.push({ thingId: candidate.thingId, unitIndex: index, reason: 'clock', pinned })
      index += 1
    }
    forfeited += owed - run
    clockAdvance.set(candidate.thingId, owed * everyMs)
  }
  return Object.freeze({ units, forfeited, clockAdvance, anchors })
}

function unitJson(unit: Unit) {
  return { thing_id: unit.thingId, unit_index: unit.unitIndex, reason: unit.reason, pinned: unit.pinned }
}

/**
 * Claim this settle's tries under the room's settle lock, in one short
 * transaction, and write the claim before anything runs. Two settles can never
 * claim the same owed interval, and no thing row is written here.
 */
async function claimSettle(
  placeId: number,
  trigger: SettleTrigger,
  residentId: number,
  db: TaggedSql,
): Promise<Claim | null> {
  return withEngineTransaction(db, async transaction => {
    await transaction`SELECT pg_advisory_xact_lock(${WAKE_SETTLE_LOCK_CLASS}::int, ${placeId}::int)`
    const places = await transaction`
      SELECT place.place_kind, place.owner_id, place.retired_at, place.wake_visitors,
        place.wake_pins, place.wake_block_thing_ids, place.wake_block_resident_ids,
        place.wake_random_cap, settler.handle AS settler_handle,
        extract(epoch FROM now()) * 1000 AS now_ms,
        EXISTS (
          SELECT 1 FROM wake_settles recent
          WHERE recent.place_id = place.id
            AND recent.created_at > now() - make_interval(secs => ${WAKE_SETTLE_MIN_INTERVAL_SECONDS})
        ) AS in_quiet
      FROM places place JOIN residents settler ON settler.id = ${residentId}
      WHERE place.id = ${placeId}
    ` as Array<Record<string, unknown>>
    const place = places[0]
    if (!place || place.place_kind === 'world' || placeId === GAZETTE_ROOM_ID
      || place.retired_at != null || place.in_quiet === true) return null
    const room: RoomDials = {
      ownerId: place.owner_id == null ? null : Number(place.owner_id),
      wakeVisitors: place.wake_visitors === true,
      pins: ids(place.wake_pins),
      blockedThingIds: ids(place.wake_block_thing_ids),
      blockedResidentIds: ids(place.wake_block_resident_ids),
      randomCap: Number(place.wake_random_cap),
    }
    const now = Number(place.now_ms)
    // End tries waiting in the room run first, outside wake_random_cap and the random pick.
    const endUnits: Unit[] = (await loadEndUnits(placeId, transaction))
      .map(thingId => Object.freeze({ thingId, unitIndex: 0, reason: 'end' as const, pinned: false }))
    const candidates: Candidate[] = []
    for (const candidate of await loadCandidates(placeId, transaction)) {
      // This is the claim's ownership check; a later transfer follows the claim.
      // Hold retirement off through every clock/anchor write, without locking the
      // thing: an action holding it must neither delay nor lose its owed tries.
      const owners = await transaction`
        /* wake:current-owner */
        SELECT thing.owner_id FROM things thing
        JOIN residents owner ON owner.id = thing.owner_id
        WHERE thing.id = ${candidate.thingId} AND owner.retirement_state = 'active'
        FOR KEY SHARE OF owner
      ` as Array<{ owner_id: number }>
      if (Number(owners[0]?.owner_id) === candidate.ownerId) candidates.push(candidate)
    }
    const plan = planUnits(candidates, room, trigger, now)
    const nowIso = new Date(now).toISOString()
    for (const thingId of plan.anchors) {
      await transaction`
        INSERT INTO thing_wake_state (thing_id, clock_at) VALUES (${thingId}, ${nowIso}::timestamptz)
        ON CONFLICT (thing_id) DO UPDATE SET clock_at = coalesce(thing_wake_state.clock_at, EXCLUDED.clock_at)
      `
    }
    if (plan.units.length === 0 && endUnits.length === 0) return null

    const settleRows = await transaction`SELECT nextval('wake_settles_id_seq')::bigint AS id` as Array<{ id?: unknown }>
    const settleId = Number(settleRows[0]?.id)
    const pinned = plan.units
      .filter(unit => unit.pinned)
      .sort((a, b) => room.pins.indexOf(a.thingId) - room.pins.indexOf(b.thingId) || a.unitIndex - b.unitIndex)
    const others = plan.units.filter(unit => !unit.pinned)
    let picked = others
    let pickDay: Awaited<ReturnType<typeof currentDaySecret>> | null = null
    if (others.length > room.randomCap) {
      pickDay = await currentDaySecret(transaction)
      const secret = pickDay.secret
      picked = others
        .map(unit => ({ unit, key: wakePickKey(secret, settleId, unit.thingId, unit.unitIndex) }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, room.randomCap)
        .map(entry => entry.unit)
    }
    const pickedSet = new Set(picked)
    const unpickedClock = others.filter(unit => !pickedSet.has(unit) && unit.reason === 'clock').length
    const forfeited = plan.forfeited + unpickedClock
    const wakeOrder = [...pinned, ...picked]
    const runOrder = [...endUnits, ...wakeOrder]
    await transaction`
      INSERT INTO wake_settles (id, place_id, trigger, resident_id, budget, units, picked, forfeited)
      VALUES (
        ${settleId}, ${placeId}, ${trigger}, ${residentId}, ${room.randomCap},
        ${JSON.stringify([...endUnits, ...plan.units].map(unitJson))}::jsonb,
        ${JSON.stringify(runOrder.map(unitJson))}::jsonb, ${forfeited}
      )
    `
    if (pickDay !== null) {
      await recordRoll({
        rollId: await nextRollId(transaction),
        day: pickDay.day,
        commitment: pickDay.commitment,
        purpose: 'wake_pick',
        placeId,
        sourceThingId: null,
        sourceTraitId: null,
        authorityId: residentId,
        actionId: null,
        settleId,
        percent: null,
        sides: others.length,
        roll: null,
        branch: null,
      }, 'counted', transaction)
    }
    const triedThings = new Set(wakeOrder.map(unit => unit.thingId))
    for (const candidate of candidates) {
      const advance = plan.clockAdvance.get(candidate.thingId)
      if (advance === undefined && !triedThings.has(candidate.thingId)) continue
      const clockAt = advance === undefined || candidate.clockAt === null
        ? null
        : new Date(candidate.clockAt + advance).toISOString()
      const lastTryAt = triedThings.has(candidate.thingId) ? nowIso : null
      await transaction`
        INSERT INTO thing_wake_state (thing_id, last_try_at, clock_at)
        VALUES (${candidate.thingId}, ${lastTryAt}::timestamptz, ${clockAt}::timestamptz)
        ON CONFLICT (thing_id) DO UPDATE SET
          last_try_at = coalesce(EXCLUDED.last_try_at, thing_wake_state.last_try_at),
          clock_at = coalesce(EXCLUDED.clock_at, thing_wake_state.clock_at)
      `
    }
    return Object.freeze({
      settleId,
      budget: room.randomCap,
      runOrder,
      forfeited,
      candidates: new Map(candidates.map(candidate => [candidate.thingId, candidate])),
      settlerHandle: String(place.settler_handle),
    })
  })
}

/**
 * Recheck, inside the try's own transaction, that the thing may still wake here (its end
 * has not come), and say who owns it now and whether it has an end set.
 */
async function stillEligible(
  candidate: Candidate,
  placeId: number,
  ownerId: number,
  db: TaggedSql,
): Promise<Readonly<{ ownerId: number; ownerHandle: string; endingSet: boolean }> | null> {
  const rows = await db`
    SELECT owner.handle AS owner_handle, thing.owner_id,
      thing.ending_rule IS NOT NULL AS ending_set,
      place.owner_id AS room_owner_id, place.wake_visitors, place.wake_pins,
      place.wake_block_thing_ids, place.wake_block_resident_ids
    FROM things thing
    JOIN residents owner ON owner.id = thing.owner_id
    JOIN places place ON place.id = thing.place_id
    JOIN kind_revision_traits link ON link.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
      AND link.revision = coalesce(thing.as_revision, thing.current_revision)
      AND link.trait_id = ${candidate.traitId}
    WHERE thing.id = ${candidate.thingId} AND thing.place_id = ${placeId}
      AND thing.owner_id = ${ownerId}
      AND owner.retirement_state = 'active'
      AND thing.withdrawn_at IS NULL AND thing.wake_enabled
      AND thing.held_by IS NULL AND thing.active_offer_id IS NULL
      -- A thing whose end has come never wakes here; a thing with no end costs no more.
      AND (thing.ending_rule IS NULL OR (thing.ended_at IS NULL
        AND NOT coalesce(thing_end_due_at_row(thing) <= transaction_timestamp(), false)))
      AND coalesce(thing.as_kind_id, thing.kind_id) = ${candidate.kindId}
      AND coalesce(thing.as_revision, thing.current_revision) = ${candidate.revision}
      AND place.retired_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM transfer_offers offer
        WHERE offer.asset_type = 'thing' AND offer.asset_id = thing.id AND offer.status = 'open'
      )
    FOR UPDATE OF thing
  ` as Array<Record<string, unknown>>
  const row = rows[0]
  if (!row) return null
  const room: RoomDials = {
    ownerId: row.room_owner_id == null ? null : Number(row.room_owner_id),
    wakeVisitors: row.wake_visitors === true,
    pins: ids(row.wake_pins),
    blockedThingIds: ids(row.wake_block_thing_ids),
    blockedResidentIds: ids(row.wake_block_resident_ids),
    randomCap: 0,
  }
  // The thing may have changed hands since the claim; its try answers to whoever owns it now.
  const current = { ...candidate, ownerId: Number(row.owner_id) }
  return allowedHere(current, room)
    ? Object.freeze({
      ownerId: current.ownerId, ownerHandle: String(row.owner_handle), endingSet: row.ending_set === true,
    })
    : null
}

/** Run one claimed try in its own transaction; a failed try never undoes anything else. */
async function runTry(
  claim: Claim,
  unit: Unit,
  placeId: number,
  residentId: number,
  db: TaggedSql,
): Promise<TryStatus | { applied: number }> {
  const candidate = claim.candidates.get(unit.thingId)!
  const rollLog = newRollLog()
  try {
    return await withEngineTransaction(db, async transaction => {
      const owners = await transaction`
        SELECT owner_id FROM things WHERE id = ${candidate.thingId}
      ` as Array<{ owner_id: number }>
      const ownerId = owners[0]?.owner_id ?? candidate.ownerId
      const reservedResidentIds = await lockEffectResidents(candidate.program.then, {
        actorId: ownerId, sourceThingId: candidate.thingId, recipientId: null,
      }, transaction)
      const reservedPlaceIds = await effectPlaceIds(candidate.program.then, {
        actorId: ownerId, actorSymbolId: unit.reason === 'clock' ? null : residentId,
        placeId, sourceThingId: candidate.thingId, target: null,
        destinationPlaceId: null, recipientId: null,
      }, transaction)
      await lockPlaceRowsTopDown(transaction, {
        placeIds: reservedPlaceIds, lawChainFrom: null, carryDestinationId: null,
      })
      const owner = await stillEligible(candidate, placeId, ownerId, transaction)
      if (owner === null) {
        await recordTry(claim.settleId, unit, 'quiet', { error: NO_LONGER_ELIGIBLE }, transaction)
        return 'quiet' as const
      }
      const context: EffectExecutionContext = {
        reservedResidentIds,
        reservedPlaceIds,
        actionId: null,
        actorId: owner.ownerId,
        actorHandle: owner.ownerHandle,
        actorSymbolId: unit.reason === 'clock' ? null : residentId,
        fromWake: true,
        trigger: `wake_${unit.reason}`,
        rollLog,
        // A wake try is its owner's own thing acting for its owner.
        ownProgram: true,
        abilityLog: newAbilityLog(),
        settleId: claim.settleId,
        placeId,
        sourceThingId: candidate.thingId,
        sharedSourceThingId: null,
        target: null,
        destinationPlaceId: null,
        recipientId: null,
        sourceTraitId: candidate.traitId,
        sourceTraitName: candidate.traitName,
        lawAuthority: null,
        originThingId: candidate.thingId,
        originPlaceId: null,
        parentEffectId: null,
        generation: 0,
        logicalAt: new Date(),
        sameUseDestroySkip: true,
        destroyedThingIds: [],
        // A waking thing with an end can fall due during its own try (a label step), so its
        // own write and copy steps re-read due before they run.
        endingThingIds: owner.endingSet ? [candidate.thingId] : [],
      }
      const outcome = await executeEffectsWithOutcome(candidate.program.then, context, transaction)
      const status = outcome.effectsApplied > 0 ? 'woke' as const : 'quiet' as const
      await recordTry(claim.settleId, unit, status, {
        effectsApplied: outcome.effectsApplied,
        skipped: publicSkippedEffects(outcome.skippedEffects ?? []),
      }, transaction)
      await recordWakeTryApplied(
        claim.settleId, unit, owner.ownerHandle, outcome.allChangedPublicActivity ?? [], transaction,
      )
      return { applied: outcome.effectsApplied }
    })
  } catch (error) {
    // The ending guard is a known refusal: its own words, never an unrecognized failure.
    const guard = thingEndingGuardRefusal(error)
    if (guard === null && (!(error instanceof EngineError) || error.status >= 500)) {
      logUnrecognizedExecutionFailure('wake try', claim.settleId, error)
    }
    const message = guard
      ?? (error instanceof EngineError && error.status < 500 ? error.message : INTERNAL_TRY_ERROR)
    await withEngineTransaction(db, async transaction => {
      await recordTry(claim.settleId, unit, 'failed', { error: message }, transaction)
      await recordFailedRolls(rollLog, transaction)
    })
    return 'failed'
  }
}

interface SettleCounts {
  readonly settleId: number | null
  readonly budget: number | null
  readonly status: 'woke' | 'quiet'
  readonly tried: number
  readonly woke: number
  readonly forfeited: number
  readonly endTries: number
}

const NOTHING_CLAIMED: SettleCounts = Object.freeze({
  settleId: null, budget: null, status: 'quiet', tried: 0, woke: 0, forfeited: 0, endTries: 0,
})

/** The one room_settled writer, for a claimed settle and for one that only recorded ends. */
async function recordRoomSettled(
  placeId: number,
  trigger: SettleTrigger,
  residentId: number,
  counts: SettleCounts,
  ends: RoomEnds,
  db: TaggedSql,
): Promise<SettleSummary> {
  await db`
    INSERT INTO events (kind, actor, detail)
    SELECT 'room_settled', settler.handle, jsonb_build_object(
      'settle_id', ${counts.settleId}::bigint,
      'place_id', ${placeId}::integer,
      'mode', ${trigger}::text,
      'status', ${counts.status}::text,
      'tried', ${counts.tried}::integer,
      'woke', ${counts.woke}::integer,
      'forfeited', ${counts.forfeited}::integer,
      'budget', coalesce(${counts.budget}::integer, room.wake_random_cap::integer),
      'ended', ${ends.recorded.length}::integer,
      'end_tries', ${counts.endTries}::integer,
      'more_due', ${ends.moreDue}::boolean
    )
    FROM residents settler, places room
    WHERE settler.id = ${residentId} AND room.id = ${placeId}
  `
  return Object.freeze({
    settle_id: counts.settleId,
    tried: counts.tried,
    woke: counts.woke,
    forfeited: counts.forfeited,
    ended: ends.recorded.length,
    end_tries: counts.endTries,
    more_due: ends.moreDue,
  })
}

async function settleWake(
  placeId: number,
  trigger: SettleTrigger,
  residentId: number,
  ends: RoomEnds,
  db: TaggedSql,
): Promise<SettleSummary | null> {
  const claim = placeId === GAZETTE_ROOM_ID || !await roomMayWake(placeId, db)
    ? null
    : await claimSettle(placeId, trigger, residentId, db)
  if (claim === null) {
    // A settle that only recorded ends still says so; one that did nothing writes nothing.
    return ends.recorded.length === 0
      ? null
      : recordRoomSettled(placeId, trigger, residentId, NOTHING_CLAIMED, ends, db)
  }
  let applied = 0
  let tried = 0
  let woke = 0
  let endTries = 0
  let stoppedClock = 0
  for (const unit of claim.runOrder) {
    // No new try starts once the budget is spent; an end try not started stays pending.
    if (applied >= MAX_WAKE_EFFECTS_PER_SETTLE) {
      await recordTry(claim.settleId, unit, 'stopped', {}, db)
      if (unit.reason === 'clock') stoppedClock += 1
      continue
    }
    tried += 1
    if (unit.reason === 'end') endTries += 1
    const result: TryStatus | { applied: number } = unit.reason === 'end'
      ? await runEndTry(claim.settleId, unit, placeId, db)
      : await runTry(claim, unit, placeId, residentId, db)
    if (typeof result === 'object') {
      applied += result.applied
      if (result.applied > 0) woke += 1
    }
  }
  return recordRoomSettled(placeId, trigger, residentId, {
    settleId: claim.settleId,
    budget: claim.budget,
    status: woke > 0 ? 'woke' : 'quiet',
    tried,
    woke,
    forfeited: claim.forfeited + stoppedClock,
    endTries,
  }, ends, db)
}

/** Day secrets, then due timers exactly as before; no wake tries. */
export async function settleTimers(placeId: number, db: TaggedSql = engineSql): Promise<void> {
  await ensureChanceDays(db)
  await resolveDueEffects(placeId, db)
}

/**
 * Settle a room when a resident arrives, speaks, acts, or reads `me` there: day
 * secrets first, then due timers exactly as before, then the ends that came in the
 * room, then end tries and owed wake tries. Also returns the ids this settle recorded,
 * so a door that settles before its own write can tell a thing that just ended.
 */
export async function settleRoomAndRecord(
  placeId: number | null,
  trigger: SettleTrigger,
  residentId: number,
  db: TaggedSql = engineSql,
): Promise<RoomSettleResult> {
  if (placeId === null) return Object.freeze({ settle: null, recordedThingIds: Object.freeze([]) })
  await settleTimers(placeId, db)
  // Neither part ever blocks the act that set it off: an end not recorded is recorded by
  // the next settle or write, an unclaimed try stays owed, and every claimed try records
  // its own outcome. A recorder failure never stops the wake part.
  let ends = NO_ENDS
  try {
    ends = await recordRoomEnds(placeId, db)
  } catch (error) {
    logUnrecognizedExecutionFailure('room settle', placeId, error)
  }
  let settle: SettleSummary | null = null
  try {
    settle = await settleWake(placeId, trigger, residentId, ends, db)
  } catch (error) {
    logUnrecognizedExecutionFailure('room settle', placeId, error)
  }
  return Object.freeze({ settle, recordedThingIds: ends.recorded })
}

/** settleRoomAndRecord, for a caller that needs only the public summary. */
export async function settleRoom(
  placeId: number | null,
  trigger: SettleTrigger,
  residentId: number,
  db: TaggedSql = engineSql,
): Promise<SettleSummary | null> {
  return (await settleRoomAndRecord(placeId, trigger, residentId, db)).settle
}
