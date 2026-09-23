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
const WAKE_NOT_ROUGH_ERROR =
  'this room is not marked rough, so a thing waking here may only label, check, roll, or write about the resident who arrived or spoke'

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
 * its owner marked rough, read at the moment the step runs. Going home is never
 * blockable anywhere, so no block from a wake try can stop it.
 */
export async function requireRoughRoomFor(
  effect: Extract<Effect, { effect: 'block' | 'move' }>,
  context: WakeRunContext,
  db: TaggedSql,
): Promise<void> {
  if (context.fromWake !== true || effect.target !== 'actor') return
  requireWakeActor(context)
  if (context.placeId === null) throw new EngineError(409, WAKE_NOT_ROUGH_ERROR)
  const rows = await db`SELECT rough_room FROM places WHERE id = ${context.placeId}` as unknown
  const rough = Array.isArray(rows) && (rows[0] as { rough_room?: unknown } | undefined)?.rough_room === true
  if (!rough) throw new EngineError(409, WAKE_NOT_ROUGH_ERROR)
}
