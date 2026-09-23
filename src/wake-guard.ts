/**
 * The one place that says what a waking thing may do to the resident who
 * arrived or spoke (decisions #105 and #109). Coining refuses what no room can
 * allow; the room decides the rest at the moment a step runs.
 */
import { EngineError, type TaggedSql } from './engine.ts'
import type { Effect } from './physics.ts'

const WAKE_NO_ACTOR_ERROR =
  "this wake try came from the thing's clock, so there is no actor; name source or place instead"
export const WAKE_HAND_OVER_ERROR =
  'a wake program may never hand a thing over, because nobody who arrives or speaks asked for it; drop the transfer step'
export const WAKE_SCOPE_ERROR =
  'a wake try has no target or destination of its own; name actor, source, or place, and move only to home'
const WAKE_NO_HOME_ERROR =
  'the resident who arrived or spoke owns no home, so this wake try could not send them home; nothing moved'
const WAKE_NOT_ROUGH_ERROR =
  'this room is not marked rough, so a thing waking here may only label, check, roll, or write about the resident who arrived or spoke'
const WAKE_ROUGH_AFTER_ENTRY_ERROR =
  'this room turned rough after the resident who arrived or spoke came in, or they are no longer here, so a thing waking here may only label, check, roll, or write about them until they come back in while it is rough'

/** Where a program came from, as far as the wake rules care. */
export interface WakeRunContext {
  readonly fromWake?: boolean
  readonly actorSymbolId?: number | null
  readonly placeId: number | null
}

/** A clock try has no resident who arrived or spoke, so actor names nobody. */
export function requireWakeActor(context: WakeRunContext): void {
  if (context.fromWake === true && context.actorSymbolId === null) {
    throw new EngineError(409, WAKE_NO_ACTOR_ERROR)
  }
}

/**
 * Holding or moving the resident who arrived or spoke is allowed only in a room
 * its owner marked rough, read at the moment the step runs, and only when that
 * resident is still in the room and came in at or after the moment the owner
 * last switched rough_room on: a visitor knew the room was rough before
 * entering. Going home is never blockable anywhere, so no block from a wake try
 * can stop it.
 */
export async function requireRoughRoomFor(
  effect: Extract<Effect, { effect: 'block' | 'move' }>,
  context: WakeRunContext,
  db: TaggedSql,
): Promise<void> {
  if (context.fromWake !== true || effect.target !== 'actor') return
  requireWakeActor(context)
  if (context.placeId === null) throw new EngineError(409, WAKE_NOT_ROUGH_ERROR)
  const rows = await db`
    SELECT place.rough_room,
      coalesce(presence.current_place_id = place.id
        AND presence.arrived_at >= place.rough_since, false) AS entered_rough
    FROM places place
    LEFT JOIN resident_presence presence ON presence.resident_id = ${context.actorSymbolId ?? null}::integer
    WHERE place.id = ${context.placeId}
  ` as unknown
  const row = Array.isArray(rows) ? rows[0] as { rough_room?: unknown; entered_rough?: unknown } | undefined : undefined
  if (row?.rough_room !== true) throw new EngineError(409, WAKE_NOT_ROUGH_ERROR)
  if (row.entered_rough !== true) throw new EngineError(409, WAKE_ROUGH_AFTER_ENTRY_ERROR)
}

/**
 * A wake try that sends the resident who arrived or spoke home, when they own
 * no usable home, fails in words for the thing's owner, who reads last_try;
 * go_home's own refusal is advice to a resident about their own home.
 */
export async function requireWakeHome(
  residentId: number,
  context: WakeRunContext,
  db: TaggedSql,
): Promise<void> {
  if (context.fromWake !== true) return
  const rows = await db`
    SELECT 1 AS usable
    FROM resident_presence presence
    JOIN places home ON home.id = presence.home_place_id
    WHERE presence.resident_id = ${residentId}
      AND home.owner_id = ${residentId}
      AND home.retired_at IS NULL
  ` as unknown
  if (!Array.isArray(rows) || rows.length === 0) throw new EngineError(409, WAKE_NO_HOME_ERROR)
}
