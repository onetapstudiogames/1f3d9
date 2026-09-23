/**
 * Lazy settle (decisions #105 and #106): nothing runs while nobody is there. When
 * a resident arrives, speaks, acts, or reads `me` in a room, the room first
 * resolves its due timers, then runs the wake tries its things are owed.
 */
import {
  EngineError,
  engineSql,
  logUnrecognizedExecutionFailure,
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

const WAKE_SETTLE_LOCK_CLASS = 0x1f3d9003
const NO_LONGER_ELIGIBLE = 'no longer eligible'
const INTERNAL_TRY_ERROR = 'the city could not complete this wake try'

export type SettleTrigger = 'arrive' | 'talk' | 'act' | 'me'
type UnitReason = 'arrive' | 'talk' | 'clock'

export interface SettleSummary {
  readonly settle_id: number
  readonly tried: number
  readonly woke: number
  readonly forfeited: number
}

interface Unit {
  readonly thingId: number
  readonly unitIndex: number
  readonly reason: UnitReason
  readonly pinned: boolean
}

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
    SELECT thing.id, thing.owner_id, thing.kind_id, thing.current_revision,
      trait.id AS trait_id, trait.name AS trait_name, trait.recipe,
      state.last_try_at, state.clock_at
    FROM things thing
    JOIN kind_revision_traits link
      ON link.kind_id = thing.kind_id AND link.revision = thing.current_revision
    JOIN traits trait ON trait.id = link.trait_id
    LEFT JOIN thing_wake_state state ON state.thing_id = thing.id
    WHERE thing.place_id = ${placeId} AND thing.withdrawn_at IS NULL AND thing.wake_enabled
      AND thing.held_by IS NULL AND thing.active_offer_id IS NULL
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

/** One cheap read that lets a room with no waking things skip the wake part entirely. */
async function roomMayWake(placeId: number, db: TaggedSql): Promise<boolean> {
  const rows = await db`
    /* wake:probe */
    SELECT EXISTS (
      SELECT 1 FROM things thing
      JOIN kind_revision_traits link
        ON link.kind_id = thing.kind_id AND link.revision = thing.current_revision
      JOIN traits trait ON trait.id = link.trait_id
      WHERE thing.place_id = ${placeId} AND thing.withdrawn_at IS NULL AND thing.wake_enabled
        AND trait.recipe ? 'wake'
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
    const candidates = await loadCandidates(placeId, transaction)
    const plan = planUnits(candidates, room, trigger, now)
    const nowIso = new Date(now).toISOString()
    for (const thingId of plan.anchors) {
      await transaction`
        INSERT INTO thing_wake_state (thing_id, clock_at) VALUES (${thingId}, ${nowIso}::timestamptz)
        ON CONFLICT (thing_id) DO UPDATE SET clock_at = coalesce(thing_wake_state.clock_at, EXCLUDED.clock_at)
      `
    }
    if (plan.units.length === 0) return null

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
    const runOrder = [...pinned, ...picked]
    await transaction`
      INSERT INTO wake_settles (id, place_id, trigger, resident_id, budget, units, picked, forfeited)
      VALUES (
        ${settleId}, ${placeId}, ${trigger}, ${residentId}, ${room.randomCap},
        ${JSON.stringify(plan.units.map(unitJson))}::jsonb,
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
    const triedThings = new Set(runOrder.map(unit => unit.thingId))
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

/** Recheck, inside the try's own transaction, that the thing may still wake here, and say who owns it now. */
async function stillEligible(
  candidate: Candidate,
  placeId: number,
  db: TaggedSql,
): Promise<Readonly<{ ownerId: number; ownerHandle: string }> | null> {
  const rows = await db`
    SELECT owner.handle AS owner_handle, thing.owner_id,
      place.owner_id AS room_owner_id, place.wake_visitors, place.wake_pins,
      place.wake_block_thing_ids, place.wake_block_resident_ids
    FROM things thing
    JOIN residents owner ON owner.id = thing.owner_id
    JOIN places place ON place.id = thing.place_id
    JOIN kind_revision_traits link ON link.kind_id = thing.kind_id
      AND link.revision = thing.current_revision AND link.trait_id = ${candidate.traitId}
    WHERE thing.id = ${candidate.thingId} AND thing.place_id = ${placeId}
      AND thing.withdrawn_at IS NULL AND thing.wake_enabled
      AND thing.held_by IS NULL AND thing.active_offer_id IS NULL
      AND thing.kind_id = ${candidate.kindId} AND thing.current_revision = ${candidate.revision}
      AND place.retired_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM transfer_offers offer
        WHERE offer.asset_type = 'thing' AND offer.asset_id = thing.id AND offer.status = 'open'
      )
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
    ? Object.freeze({ ownerId: current.ownerId, ownerHandle: String(row.owner_handle) })
    : null
}

type TryStatus = 'woke' | 'quiet' | 'failed' | 'stopped'

async function recordTry(
  settleId: number,
  unit: Unit,
  status: TryStatus,
  details: Readonly<{ effectsApplied?: number; skipped?: readonly unknown[]; error?: string | null }>,
  db: TaggedSql,
): Promise<void> {
  await db`
    INSERT INTO wake_tries (
      settle_id, thing_id, reason, unit_index, status, effects_applied, skipped_effects, error
    ) VALUES (
      ${settleId}, ${unit.thingId}, ${unit.reason}, ${unit.unitIndex}, ${status},
      ${details.effectsApplied ?? 0}, ${JSON.stringify(details.skipped ?? [])}::jsonb,
      ${details.error ?? null}
    )
  `
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
      const owner = await stillEligible(candidate, placeId, transaction)
      if (owner === null) {
        await recordTry(claim.settleId, unit, 'quiet', { error: NO_LONGER_ELIGIBLE }, transaction)
        return 'quiet' as const
      }
      const context: EffectExecutionContext = {
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
      }
      const outcome = await executeEffectsWithOutcome(candidate.program.then, context, transaction)
      const status = outcome.effectsApplied > 0 ? 'woke' as const : 'quiet' as const
      await recordTry(claim.settleId, unit, status, {
        effectsApplied: outcome.effectsApplied,
        skipped: publicSkippedEffects(outcome.skippedEffects ?? []),
      }, transaction)
      return { applied: outcome.effectsApplied }
    })
  } catch (error) {
    if (!(error instanceof EngineError) || error.status >= 500) {
      logUnrecognizedExecutionFailure('wake try', claim.settleId, error)
    }
    const message = error instanceof EngineError && error.status < 500 ? error.message : INTERNAL_TRY_ERROR
    await withEngineTransaction(db, async transaction => {
      await recordTry(claim.settleId, unit, 'failed', { error: message }, transaction)
      await recordFailedRolls(rollLog, transaction)
    })
    return 'failed'
  }
}

async function settleWake(
  placeId: number,
  trigger: SettleTrigger,
  residentId: number,
  db: TaggedSql,
): Promise<SettleSummary | null> {
  if (placeId === GAZETTE_ROOM_ID || !await roomMayWake(placeId, db)) return null
  const claim = await claimSettle(placeId, trigger, residentId, db)
  if (claim === null) return null
  let applied = 0
  let tried = 0
  let woke = 0
  let stoppedClock = 0
  for (const unit of claim.runOrder) {
    if (applied >= MAX_WAKE_EFFECTS_PER_SETTLE) {
      await recordTry(claim.settleId, unit, 'stopped', {}, db)
      if (unit.reason === 'clock') stoppedClock += 1
      continue
    }
    tried += 1
    const result = await runTry(claim, unit, placeId, residentId, db)
    if (typeof result === 'object') {
      applied += result.applied
      if (result.applied > 0) woke += 1
    }
  }
  const forfeited = claim.forfeited + stoppedClock
  await db`
    INSERT INTO events (kind, actor, detail)
    VALUES ('room_settled', ${claim.settlerHandle}, jsonb_build_object(
      'settle_id', ${claim.settleId}::bigint,
      'place_id', ${placeId}::integer,
      'mode', ${trigger}::text,
      'status', ${woke > 0 ? 'woke' : 'quiet'}::text,
      'tried', ${tried}::integer,
      'woke', ${woke}::integer,
      'forfeited', ${forfeited}::integer,
      'budget', ${claim.budget}::integer
    ))
  `
  return Object.freeze({ settle_id: claim.settleId, tried, woke, forfeited })
}

/** Day secrets, then due timers exactly as before; no wake tries. */
export async function settleTimers(placeId: number, db: TaggedSql = engineSql): Promise<void> {
  await ensureChanceDays(db)
  await resolveDueEffects(placeId, db)
}

/**
 * Settle a room when a resident arrives, speaks, acts, or reads `me` there: day
 * secrets first, then due timers exactly as before, then owed wake tries.
 */
export async function settleRoom(
  placeId: number | null,
  trigger: SettleTrigger,
  residentId: number,
  db: TaggedSql = engineSql,
): Promise<SettleSummary | null> {
  if (placeId === null) return null
  await settleTimers(placeId, db)
  // The wake part never blocks the act that set it off: an unclaimed try stays
  // owed for the next settle, and every claimed try records its own outcome.
  try {
    return await settleWake(placeId, trigger, residentId, db)
  } catch (error) {
    logUnrecognizedExecutionFailure('room settle', placeId, error)
    return null
  }
}
