import { COLLISION_CONFLICT_MESSAGE } from './core.ts'
import { EngineError, type TaggedSql } from './engine.ts'
import type { EffectExecutionContext } from './engine-effects.ts'
import type { Effect } from './physics.ts'

type PlaceContext = Pick<EffectExecutionContext,
  'actorId' | 'actorSymbolId' | 'placeId' | 'sourceThingId' | 'target' | 'destinationPlaceId' | 'recipientId'>
  & Partial<Pick<EffectExecutionContext, 'originPlaceId' | 'lawAuthority'>>

function immediateEffects(effects: readonly Effect[]): readonly Effect[] {
  return effects.flatMap(effect => [effect, ...(
    effect.effect === 'wait' ? [] : 'then' in effect
      ? immediateEffects([...effect.then, ...('else' in effect ? effect.else ?? [] : [])]) : []
  )])
}

function placeIds(values: readonly unknown[]): number[] {
  return [...new Set(values.map(Number).filter(value => Number.isSafeInteger(value) && value > 0))]
}

/** Resolve possible rooms before a writer takes a thing, a presence, or an event lock. */
export async function effectPlaceIds(
  effects: readonly Effect[], context: PlaceContext, db: TaggedSql,
): Promise<readonly number[]> {
  const immediate = immediateEffects(effects)
  const needsHome = immediate.some(effect => effect.effect === 'move' || effect.effect === 'transfer')
  const reachesResidents = immediate.some(effect => effect.effect === 'reach' && effect.over === 'residents')
  const copiesAdjacent = immediate.some(effect => effect.effect === 'copy' && effect.to === 'adjacent')
  const things = placeIds([context.sourceThingId, context.target?.type === 'thing' ? context.target.id : null])
  const thingRooms = things.length === 0 ? [] : await db`
    SELECT place_id FROM things WHERE id = ANY(${things}::int[])
  ` as Array<{ place_id: number }>
  const residents = placeIds([context.actorId, context.actorSymbolId, context.recipientId,
    context.target?.type === 'resident' ? context.target.id : null])
  const homes = !needsHome ? [] : await db`
    SELECT home_place_id FROM resident_presence
    WHERE resident_id = ANY(${residents}::int[])
      OR (${reachesResidents}::boolean AND current_place_id = ${context.placeId})
  ` as Array<{ home_place_id: number | null }>
  const known = placeIds([context.placeId, context.destinationPlaceId,
    context.originPlaceId, context.lawAuthority?.sourcePlaceId,
    context.target?.type === 'place' ? context.target.id : null,
    ...thingRooms.map(row => row.place_id), ...homes.map(row => row.home_place_id)])
  if (!copiesAdjacent || known.length === 0) return known
  // Include closed neighbours too, so opening an existing neighbour cannot escape the plan.
  const neighbours = await db`
    SELECT id FROM places WHERE parent_id = ANY(${known}::int[])
      OR id IN (SELECT parent_id FROM places WHERE id = ANY(${known}::int[]))
  ` as Array<{ id: number }>
  return placeIds([...known, ...neighbours.map(row => row.id)])
}

/** Recheck a source or caller target after its planned rooms have been reserved. */
export async function lockEffectThings(
  context: Pick<EffectExecutionContext, 'sourceThingId' | 'target' | 'reservedPlaceIds'>, db: TaggedSql,
): Promise<void> {
  const things = placeIds([context.sourceThingId, context.target?.type === 'thing' ? context.target.id : null])
  if (things.length === 0) return
  const rows = await db`
    SELECT id, place_id FROM things WHERE id = ANY(${things}::int[]) ORDER BY id FOR UPDATE
  ` as Array<{ place_id: number | null }>
  for (const row of rows) requireReservedEffectPlace(row.place_id ?? null, context)
}

/** A new room or changed home after planning retries before another row lock or draw. */
export function requireReservedEffectPlace(
  placeId: number | null, context: Pick<EffectExecutionContext, 'reservedPlaceIds'>,
): void {
  if (placeId !== null && context.reservedPlaceIds !== undefined
    && !context.reservedPlaceIds.includes(placeId)) {
    throw new EngineError(409, COLLISION_CONFLICT_MESSAGE)
  }
}
