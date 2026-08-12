import { EngineError, type RuntimeTarget, type TaggedSql } from './engine.ts'

async function queryRows<T>(promise: Promise<unknown>): Promise<T[]> {
  const value = await promise
  if (!Array.isArray(value)) throw new EngineError(500, 'database returned an invalid result')
  return value as T[]
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new EngineError(500, `database returned an invalid ${field}`)
  }
  return parsed
}

export async function requireResidentAtActionPlace(
  residentId: number,
  actionPlaceId: number | null,
  db: TaggedSql,
): Promise<void> {
  const rows = await queryRows<Record<string, unknown>>(db`
    SELECT current_place_id FROM resident_presence
    WHERE resident_id = ${residentId} FOR UPDATE
  `)
  if (!rows[0]) throw new EngineError(404, 'resident presence not found')
  const currentPlaceId = rows[0].current_place_id
  if (actionPlaceId === null
    || currentPlaceId == null
    || positiveInteger(currentPlaceId, 'resident current place id') !== actionPlaceId) {
    throw new EngineError(403, 'resident target is not in the action place')
  }
}

/** Recheck caller-selected targets inside the action transaction before local state is read or changed. */
export async function requireCallerTargetScope(
  target: RuntimeTarget,
  actorId: number,
  actionPlaceId: number | null,
  db: TaggedSql,
): Promise<void> {
  if (target.type === 'resident') {
    return requireResidentAtActionPlace(target.id, actionPlaceId, db)
  }
  if (target.type === 'place') {
    if (actionPlaceId !== target.id) {
      throw new EngineError(403, 'place target is not the action place')
    }
    return
  }
  if (target.type === 'thing') {
    const rows = await queryRows<Record<string, unknown>>(db`
      SELECT place_id, withdrawn_at FROM things
      WHERE id = ${target.id} FOR UPDATE
    `)
    const thing = rows[0]
    if (!thing || thing.withdrawn_at != null) throw new EngineError(404, 'thing target not found')
    if (actionPlaceId === null
      || positiveInteger(thing.place_id, 'thing place id') !== actionPlaceId) {
      throw new EngineError(403, 'thing target is not in the action place')
    }
    return
  }

  const rows = await queryRows<Record<string, unknown>>(db`
    SELECT owner_id FROM kinds WHERE id = ${target.id} FOR UPDATE
  `)
  if (!rows[0]) throw new EngineError(404, 'kind target not found')
  if (positiveInteger(rows[0].owner_id, 'kind owner id') !== actorId) {
    throw new EngineError(403, 'kind target is not owned by the actor')
  }
}
