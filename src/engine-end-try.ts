/**
 * The settle step of things ending (decisions #106 and #173): a room settle records up to
 * 64 ends that came in the room, then runs each recorded thing's end program once, as an
 * end try beside the wake tries, under the same gates and inside the same budget. A write
 * from anywhere else only records the end; the program waits for a resident in the room.
 * Exactly one try ever: the try re-checks the thing under its row lock and moves its
 * program from pending to ran or skipped in the same transaction, under the end_try writer.
 */
import {
  EngineError,
  logUnrecognizedExecutionFailure,
  lockPlaceRowsTopDown,
  publicSkippedEffects,
  withEngineTransaction,
  type TaggedSql,
} from './engine.ts'
import { newRollLog, recordFailedRolls } from './engine-chance.ts'
import {
  executeEffectsWithOutcome,
  newAbilityLog,
  type AppliedPublicActivity,
  type EffectExecutionContext,
} from './engine-effects.ts'
import { effectPlaceIds, lockEffectResidents } from './engine-place-plan.ts'
import { endProgramOf } from './physics.ts'
import { recordDueEndQuietly } from './thing-ending-record.ts'
import { END_TRY_SKIP_REASONS, thingEndingGuardRefusal } from './thing-ending-refusals.ts'
import { endTryGates, type EndTryGate } from './thing-endings.ts'

export const NO_LONGER_ELIGIBLE = 'no longer eligible'
export const INTERNAL_TRY_ERROR = 'the city could not complete this wake try'
/** Each settle records at most this many ends in its room, and claims at most this many end tries. */
export const ROOM_END_BATCH = 64
/**
 * A claimed end unit with no try recorded counts as still running for this long, twice a
 * function's longest run (vercel.json maxDuration 300), and may then be claimed again.
 * The locked pending check in the try is what makes one try ever; this only avoids waste.
 */
const END_CLAIM_RUNNING_SECONDS = 600
/**
 * A room settles at most once per 10-second quiet, so its latest 64 settles reach back
 * further than END_CLAIM_RUNNING_SECONDS; the claim marker reads no more than these.
 */
const END_CLAIM_RECENT_SETTLES = 64

export type UnitReason = 'arrive' | 'talk' | 'clock' | 'end'
export type TryStatus = 'woke' | 'quiet' | 'failed' | 'stopped'

export interface Unit {
  readonly thingId: number
  readonly unitIndex: number
  readonly reason: UnitReason
  readonly pinned: boolean
}

export interface RoomEnds {
  readonly recorded: readonly number[]
  readonly moreDue: boolean
}

type Row = Record<string, unknown>

function ids(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(id => Number.isSafeInteger(id) && id > 0) : []
}

/** One wake_tries row for a claimed unit; returns its id. */
export async function recordTry(
  settleId: number,
  unit: Unit,
  status: TryStatus,
  details: Readonly<{ effectsApplied?: number; skipped?: readonly unknown[]; error?: string | null }>,
  db: TaggedSql,
): Promise<number> {
  const rows = await db`
    INSERT INTO wake_tries (
      settle_id, thing_id, reason, unit_index, status, effects_applied, skipped_effects, error
    ) VALUES (
      ${settleId}, ${unit.thingId}, ${unit.reason}, ${unit.unitIndex}, ${status},
      ${details.effectsApplied ?? 0}, ${JSON.stringify(details.skipped ?? [])}::jsonb,
      ${details.error ?? null}
    )
    RETURNING id
  ` as Array<{ id?: unknown }>
  return Number(rows[0]?.id)
}

/** The one wake_try_applied writer: a try that changed the record stamps its owner (#166). */
export async function recordWakeTryApplied(
  settleId: number,
  unit: Unit,
  ownerHandle: string,
  changed: readonly AppliedPublicActivity[],
  db: TaggedSql,
): Promise<void> {
  if (changed.length === 0) return
  await db`
    INSERT INTO events (kind, actor, detail)
    VALUES ('wake_try_applied', ${ownerHandle}, jsonb_build_object(
      'settle_id', ${settleId}::bigint,
      'thing_id', ${unit.thingId}::integer,
      'reason', ${unit.reason}::text,
      'unit_index', ${unit.unitIndex}::integer,
      'applied_public_activity', ${JSON.stringify(changed)}::jsonb
    ))
  `
}

/**
 * Record up to 64 ends that had come in the room when this settle started, by id. Each is
 * recorded on its own, quietly, so one bad thing never stops the rest or the settle.
 */
export async function recordRoomEnds(placeId: number, db: TaggedSql): Promise<RoomEnds> {
  const rows = await db`
    /* thing-endings:room-due */
    SELECT thing.id FROM things thing
    WHERE thing.place_id = ${placeId} AND thing.ending_rule IS NOT NULL
      AND EXISTS (SELECT 1 FROM residents owner WHERE owner.id = thing.owner_id AND owner.retirement_state = 'active')
      AND thing.ended_at IS NULL AND thing.withdrawn_at IS NULL
      AND coalesce(thing_end_due_at_row(thing) <= transaction_timestamp(), false)
    ORDER BY thing.id
    LIMIT ${ROOM_END_BATCH + 1}
  ` as Row[]
  const due = ids(rows.map(row => row.id))
  const recorded: number[] = []
  for (const thingId of due.slice(0, ROOM_END_BATCH)) {
    recorded.push(...await recordDueEndQuietly([thingId], db))
  }
  return Object.freeze({ recorded: Object.freeze(recorded), moreDue: due.length > ROOM_END_BATCH })
}

/**
 * The room's remnants whose end try waits, oldest end first, at most 64. A thing that an
 * earlier settle claimed, whose try has not recorded an outcome, is left out while that
 * claim may still be running. A remnant hidden by moderation waits, unclaimed.
 */
export async function loadEndUnits(placeId: number, db: TaggedSql): Promise<number[]> {
  const rows = await db`
    /* thing-endings:end-claim */
    WITH recent AS MATERIALIZED (
      SELECT latest.id, latest.units FROM (
        SELECT settle.id, settle.units, settle.created_at FROM wake_settles settle
        WHERE settle.place_id = ${placeId}
        ORDER BY settle.place_id, settle.id DESC LIMIT ${END_CLAIM_RECENT_SETTLES}
      ) latest
      WHERE latest.created_at > now() - make_interval(secs => ${END_CLAIM_RUNNING_SECONDS})
    )
    SELECT thing.id FROM things thing
    WHERE thing.place_id = ${placeId} AND thing.end_program_state = 'pending'
      AND EXISTS (SELECT 1 FROM residents owner WHERE owner.id = thing.owner_id AND owner.retirement_state = 'active')
      AND thing.ended_at IS NOT NULL AND thing.withdrawn_at IS NULL
      AND coalesce((
        SELECT moderation.action FROM moderation_actions moderation
        WHERE moderation.target_type = 'thing' AND moderation.target_id = thing.id
        ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
      ), 'restore') <> 'remove'
      AND NOT EXISTS (
        SELECT 1 FROM recent claimed
        WHERE claimed.units @> jsonb_build_array(jsonb_build_object('thing_id', thing.id, 'reason', 'end'))
          AND NOT EXISTS (
            SELECT 1 FROM wake_tries attempt
            WHERE attempt.thing_id = thing.id AND attempt.settle_id = claimed.id AND attempt.reason = 'end'
          )
      )
    ORDER BY thing.ended_at, thing.id
    LIMIT ${ROOM_END_BATCH}
  ` as Row[]
  return ids(rows.map(row => row.id))
}

interface EndTryFacts {
  readonly ownerId: number
  readonly traitId: number | null
  readonly traitName: string | null
  readonly recipe: unknown
}

/** The thing's owner now and the end trait of its effective revision, read before the locks. */
async function endTryFacts(thingId: number, db: TaggedSql): Promise<EndTryFacts | null> {
  const rows = await db`
    SELECT thing.owner_id, trait.id AS trait_id, trait.name AS trait_name, trait.recipe
    FROM things thing
    LEFT JOIN LATERAL (
      SELECT end_trait.id, end_trait.name, end_trait.recipe
      FROM kind_revision_traits link
      JOIN traits end_trait ON end_trait.id = link.trait_id
      WHERE link.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
        AND link.revision = coalesce(thing.as_revision, thing.current_revision)
        AND end_trait.recipe ? 'end'
      ORDER BY link.position LIMIT 1
    ) trait ON TRUE
    WHERE thing.id = ${thingId}
  ` as Row[]
  const row = rows[0]
  if (!row) return null
  return Object.freeze({
    ownerId: Number(row.owner_id),
    traitId: row.trait_id == null ? null : Number(row.trait_id),
    traitName: row.trait_name == null ? null : String(row.trait_name),
    recipe: row.recipe ?? null,
  })
}

interface LockedEndTry {
  readonly ownerHandle: string
  readonly blockedBy: readonly EndTryGate[]
}

/**
 * Lock the thing and judge it again: still in this room, not withdrawn, recorded, its
 * program pending, not hidden, and owned by the owner the locks were planned for. Null
 * when not; otherwise the owner's handle and the closed gates, read under the lock.
 */
async function lockEndTry(
  thingId: number,
  placeId: number,
  ownerId: number,
  db: TaggedSql,
): Promise<LockedEndTry | null> {
  const rows = await db`
    SELECT thing.owner_id, owner.handle AS owner_handle, thing.place_id, thing.withdrawn_at,
      thing.ended_at, thing.end_program_state, thing.wake_enabled, thing.held_by,
      (thing.active_offer_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM transfer_offers offer
        WHERE offer.asset_type = 'thing' AND offer.asset_id = thing.id AND offer.status = 'open'
      )) AS in_sale,
      coalesce((
        SELECT moderation.action FROM moderation_actions moderation
        WHERE moderation.target_type = 'thing' AND moderation.target_id = thing.id
        ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
      ), 'restore') = 'remove' AS removed,
      place.owner_id AS room_owner_id, place.wake_visitors, place.wake_pins,
      place.wake_block_thing_ids, place.wake_block_resident_ids, place.retired_at
    FROM things thing
    JOIN residents owner ON owner.id = thing.owner_id
    JOIN places place ON place.id = thing.place_id
    WHERE thing.id = ${thingId}
      AND owner.retirement_state = 'active'
    FOR UPDATE OF thing
  ` as Row[]
  const row = rows[0]
  if (!row || Number(row.place_id) !== placeId || row.withdrawn_at != null || row.ended_at == null
    || row.end_program_state !== 'pending' || row.removed === true || Number(row.owner_id) !== ownerId) {
    return null
  }
  const gates = endTryGates({
    id: thingId,
    owner_id: ownerId,
    wake_enabled: row.wake_enabled === true,
    held_by: row.held_by == null ? null : Number(row.held_by),
    in_sale: row.in_sale === true,
    end_program_state: 'pending',
    has_end_trait: true,
  }, {
    owner_id: row.room_owner_id == null ? null : Number(row.room_owner_id),
    wake_visitors: row.wake_visitors === true,
    wake_pins: ids(row.wake_pins),
    wake_block_thing_ids: ids(row.wake_block_thing_ids),
    wake_block_resident_ids: ids(row.wake_block_resident_ids),
    retired_at: row.retired_at == null ? null : String(row.retired_at),
  })
  return Object.freeze({ ownerHandle: String(row.owner_handle), blockedBy: gates.blocked_by ?? [] })
}

/** Name the end try's writer for this thing, so its own program and outcome pass the guard. */
async function asEndTry(thingId: number, db: TaggedSql): Promise<void> {
  await db`SELECT set_config('city.ending_writer', 'end_try:' || ${thingId}::text, true)`
}

/**
 * Move a pending program to ran or skipped with its result, and write its one 'program'
 * change row. A thing withdrawn or already moved meanwhile is left as it is; returns
 * whether the program moved.
 */
async function finishEndTry(
  thingId: number,
  settleId: number,
  outcome: 'ran' | 'skipped',
  result: Readonly<Record<string, unknown>>,
  actorId: number | null,
  db: TaggedSql,
): Promise<boolean> {
  await asEndTry(thingId, db)
  const rows = await db`
    WITH finished AS (
      UPDATE things SET end_program_state = ${outcome}, end_program_result = ${JSON.stringify(result)}::jsonb
      WHERE id = ${thingId} AND end_program_state = 'pending' AND withdrawn_at IS NULL
        AND ended_at IS NOT NULL
      RETURNING id, owner_id
    ), change AS (
      INSERT INTO thing_ending_changes (thing_id, change, actor_id, result, settle_id)
      SELECT finished.id, 'program', coalesce(${actorId}::integer, finished.owner_id),
        ${JSON.stringify(result)}::jsonb, ${settleId}::bigint
      FROM finished
      RETURNING id
    )
    SELECT id FROM finished
  ` as Row[]
  return rows.length === 1
}

function errorMessage(error: unknown): string {
  const guard = thingEndingGuardRefusal(error)
  if (guard !== null) return guard
  return error instanceof EngineError && error.status < 500 ? error.message : INTERNAL_TRY_ERROR
}

/**
 * Run one claimed end try in its own transaction. A closed gate records the try quiet
 * with its reason and skips the program for good; a run records ran with its result; a
 * thing that left the room, was withdrawn, or already ran records quiet and nothing else.
 */
export async function runEndTry(
  settleId: number,
  unit: Unit,
  placeId: number,
  db: TaggedSql,
): Promise<TryStatus | { applied: number }> {
  const thingId = unit.thingId
  const rollLog = newRollLog()
  try {
    return await withEngineTransaction(db, async transaction => {
      const facts = await endTryFacts(thingId, transaction)
      if (facts === null) {
        await recordTry(settleId, unit, 'quiet', { error: NO_LONGER_ELIGIBLE }, transaction)
        return 'quiet' as const
      }
      // A malformed stored end key loads as no program: skipped, and it never runs.
      const program = endProgramOf(facts.recipe)
      const then = program?.then ?? []
      // Lock in the same order as a wake try: residents, then rooms top down, then the thing.
      const reservedResidentIds = await lockEffectResidents(then, {
        actorId: facts.ownerId, sourceThingId: thingId, recipientId: null,
      }, transaction)
      const reservedPlaceIds = await effectPlaceIds(then, {
        actorId: facts.ownerId, actorSymbolId: null, placeId, sourceThingId: thingId,
        target: null, destinationPlaceId: null, recipientId: null,
      }, transaction)
      await lockPlaceRowsTopDown(transaction, {
        placeIds: reservedPlaceIds, lawChainFrom: null, carryDestinationId: null,
      })
      const locked = await lockEndTry(thingId, placeId, facts.ownerId, transaction)
      if (locked === null) {
        await recordTry(settleId, unit, 'quiet', { error: NO_LONGER_ELIGIBLE }, transaction)
        return 'quiet' as const
      }
      await asEndTry(thingId, transaction)
      if (program === null || facts.traitId === null) {
        await recordTry(settleId, unit, 'quiet', {}, transaction)
        await finishEndTry(thingId, settleId, 'skipped', { skipped: 'no_program' }, facts.ownerId, transaction)
        return 'quiet' as const
      }
      const gate = locked.blockedBy[0]
      if (gate !== undefined) {
        const reason = END_TRY_SKIP_REASONS[gate]
        const wakeTryId = await recordTry(settleId, unit, 'quiet', { error: reason }, transaction)
        await finishEndTry(thingId, settleId, 'skipped', {
          skipped: gate, blocked_by: locked.blockedBy, reason, wake_try_id: wakeTryId,
        }, facts.ownerId, transaction)
        return 'quiet' as const
      }
      const context: EffectExecutionContext = {
        reservedResidentIds,
        reservedPlaceIds,
        actionId: null,
        actorId: facts.ownerId,
        actorHandle: locked.ownerHandle,
        // Nobody arrived or spoke for an end try, so actor names nobody.
        actorSymbolId: null,
        fromWake: true,
        trigger: 'wake_end',
        rollLog,
        // An end try is its owner's own thing acting for its owner.
        ownProgram: true,
        abilityLog: newAbilityLog(),
        settleId,
        placeId,
        sourceThingId: thingId,
        sharedSourceThingId: null,
        target: null,
        destinationPlaceId: null,
        recipientId: null,
        sourceTraitId: facts.traitId,
        sourceTraitName: facts.traitName,
        lawAuthority: null,
        originThingId: thingId,
        originPlaceId: null,
        parentEffectId: null,
        generation: 0,
        logicalAt: new Date(),
        sameUseDestroySkip: true,
        destroyedThingIds: [],
        // The end_try writer lets its own write and copy steps through (skipAfterOwnEnd).
        endingThingIds: [],
      }
      const outcome = await executeEffectsWithOutcome(then, context, transaction)
      const status = outcome.effectsApplied > 0 ? 'woke' as const : 'quiet' as const
      const wakeTryId = await recordTry(settleId, unit, status, {
        effectsApplied: outcome.effectsApplied,
        skipped: publicSkippedEffects(outcome.skippedEffects ?? []),
      }, transaction)
      await recordWakeTryApplied(settleId, unit, locked.ownerHandle, outcome.allChangedPublicActivity ?? [], transaction)
      await finishEndTry(thingId, settleId, 'ran', {
        ran: true, wake_try_id: wakeTryId, effects_applied: outcome.effectsApplied,
      }, facts.ownerId, transaction)
      return { applied: outcome.effectsApplied }
    })
  } catch (error) {
    if (thingEndingGuardRefusal(error) === null && (!(error instanceof EngineError) || error.status >= 500)) {
      logUnrecognizedExecutionFailure('wake try', settleId, error)
    }
    const message = errorMessage(error)
    try {
      // A failed try is recorded failed and its program skipped with the failure, so it
      // is never tried again; a thing withdrawn meanwhile is left as it is.
      await withEngineTransaction(db, async transaction => {
        const wakeTryId = await recordTry(settleId, unit, 'failed', { error: message }, transaction)
        await recordFailedRolls(rollLog, transaction)
        await finishEndTry(thingId, settleId, 'skipped', {
          skipped: 'failed', reason: message, wake_try_id: wakeTryId,
        }, null, transaction)
      })
    } catch (recordError) {
      logUnrecognizedExecutionFailure('wake try', settleId, recordError)
    }
    return 'failed'
  }
}
