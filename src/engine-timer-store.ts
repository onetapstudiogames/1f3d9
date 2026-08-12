import { EngineError, type TaggedSql } from './engine.ts'

export const MAX_PENDING_EFFECTS_PER_PLACE = 512
export const MAX_PENDING_EFFECTS_PER_ACTOR = 1_024

const PLACE_QUEUE_LOCK_NAMESPACE = 0x1f3d9001
const ACTOR_QUEUE_LOCK_NAMESPACE = 0x1f3d9002

export interface PendingEffectInsert {
  readonly actionId: number | null
  readonly parentEffectId: number | null
  readonly placeId: number
  readonly actorId: number
  readonly sourceTraitId: number | null
  readonly sourceThingId: number | null
  readonly targetType: 'resident' | 'place' | 'thing' | 'kind' | null
  readonly targetId: number | null
  readonly destinationPlaceId: number | null
  readonly recipientId: number | null
  readonly payloadJson: string
  readonly logicalDueAt: string
  readonly generation: number
}

async function queryRows<T>(promise: Promise<unknown>): Promise<T[]> {
  const value = await promise
  if (!Array.isArray(value)) throw new EngineError(500, 'database returned an invalid result')
  return value as T[]
}

function queueCount(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new EngineError(500, `database returned an invalid ${field}`)
  }
  return parsed
}

async function enforcePendingLimits(input: PendingEffectInsert, db: TaggedSql): Promise<void> {
  await queryRows(db`
    SELECT pg_advisory_xact_lock(${PLACE_QUEUE_LOCK_NAMESPACE}, ${input.placeId})
  `)
  await queryRows(db`
    SELECT pg_advisory_xact_lock(${ACTOR_QUEUE_LOCK_NAMESPACE}, ${input.actorId})
  `)
  const rows = await queryRows<Record<string, unknown>>(db`
    SELECT
      (SELECT count(*)::integer FROM pending_effects pending
       WHERE pending.place_id = ${input.placeId} AND NOT EXISTS (
         SELECT 1 FROM effect_resolutions resolution
         WHERE resolution.pending_effect_id = pending.id
       )) AS place_pending,
      (SELECT count(*)::integer FROM pending_effects pending
       WHERE pending.actor_id = ${input.actorId} AND NOT EXISTS (
         SELECT 1 FROM effect_resolutions resolution
         WHERE resolution.pending_effect_id = pending.id
       )) AS actor_pending
  `)
  if (!rows[0]) throw new EngineError(500, 'pending effect counts are unavailable')
  if (queueCount(rows[0].place_pending, 'place pending count') >= MAX_PENDING_EFFECTS_PER_PLACE) {
    throw new EngineError(429, 'pending effect limit reached for place')
  }
  if (queueCount(rows[0].actor_pending, 'actor pending count') >= MAX_PENDING_EFFECTS_PER_ACTOR) {
    throw new EngineError(429, 'pending effect limit reached for actor')
  }
}

export async function insertPendingEffect(input: PendingEffectInsert, db: TaggedSql): Promise<void> {
  await enforcePendingLimits(input, db)
  const rows = await queryRows(db`
    WITH scheduled AS (
      INSERT INTO pending_effects (
        action_id, parent_effect_id, place_id, actor_id, source_trait_id,
        source_thing_id, target_type, target_id, destination_place_id,
        recipient_id, payload, due_at, generation
      ) VALUES (
        ${input.actionId}, ${input.parentEffectId}, ${input.placeId}, ${input.actorId},
        ${input.sourceTraitId}, ${input.sourceThingId}, ${input.targetType},
        ${input.targetId}, ${input.destinationPlaceId}, ${input.recipientId},
        ${input.payloadJson}::jsonb,
        GREATEST(${input.logicalDueAt}::timestamptz, now()), ${input.generation}
      ) RETURNING id, due_at, generation
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'effect_scheduled', resident.handle,
        jsonb_build_object('effect_id', scheduled.id, 'place_id', ${input.placeId},
          'due_at', scheduled.due_at, 'generation', scheduled.generation)
      FROM scheduled JOIN residents resident ON resident.id = ${input.actorId}
    ) SELECT id FROM scheduled
  `)
  if (!rows[0]) throw new EngineError(500, 'wait effect could not be scheduled')
}
