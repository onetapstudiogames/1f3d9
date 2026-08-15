import { QUOTAS, type Resident } from './core.ts'
import { craftKindThing, type CraftedThing, type CraftSql } from './crafting.ts'
import { EngineError, runAction, type ActionExecution } from './engine.ts'
import type { ThingRow } from './world-support.ts'

type MakeFailureStatus = 400 | 403 | 404 | 409 | 429 | 500

export interface MakeThingInput {
  readonly actor: Resident
  readonly placeId: number
  readonly name: string
  readonly body: string
  readonly openToUse?: boolean
  readonly kindId: number | null
  readonly ingredientIds: unknown
}

export type MakeThingResult =
  | Readonly<{
    ok: true
    thing: ThingRow | CraftedThing
    consumedIngredientIds: readonly number[] | null
  }>
  | Readonly<{
    ok: false
    status: MakeFailureStatus
    error: string
  }>

type MakeSuccess = Extract<MakeThingResult, { ok: true }>
type MakeFailure = Extract<MakeThingResult, { ok: false }>

function actionFailure(action: ActionExecution): MakeThingResult {
  return Object.freeze({
    ok: false,
    status: action.httpStatus as MakeFailureStatus,
    error: action.error ?? 'thing could not be made',
  })
}

async function actionBoundary(
  work: () => Promise<ActionExecution>,
): Promise<Readonly<{ ok: true; action: ActionExecution }> | MakeFailure> {
  try {
    return Object.freeze({ ok: true, action: await work() })
  } catch (error) {
    if (error instanceof EngineError) {
      return Object.freeze({ ok: false, status: error.status, error: error.message })
    }
    throw error
  }
}

async function makeCraftedThing(input: MakeThingInput): Promise<MakeThingResult> {
  if (input.kindId === null) throw new EngineError(500, 'typed thing needs a kind')
  const completed = Promise.withResolvers<MakeSuccess>()
  const boundary = await actionBoundary(() => runAction({
    actorId: input.actor.id,
    actorHandle: input.actor.handle,
    action: 'make',
    placeId: input.placeId,
    primitiveHandledByCaller: true,
    performPrimitive: async transaction => {
      const result = await craftKindThing(transaction as unknown as CraftSql, {
        actor: input.actor,
        kindId: input.kindId,
        placeId: input.placeId,
        name: input.name,
        body: input.body,
        openToUse: input.openToUse === true,
        ingredientIds: input.ingredientIds,
      })
      if (!result.ok) throw new EngineError(result.status, result.error)
      completed.resolve(Object.freeze({
        ok: true,
        thing: result.thing,
        consumedIngredientIds: result.consumedIngredientIds,
      }))
    },
  }))
  if (!boundary.ok) return boundary
  const action = boundary.action
  if (action.error) return actionFailure(action)
  return completed.promise
}

async function makeKindlessThing(input: MakeThingInput): Promise<MakeThingResult> {
  const completed = Promise.withResolvers<MakeSuccess>()
  const boundary = await actionBoundary(() => runAction({
    actorId: input.actor.id,
    actorHandle: input.actor.handle,
    action: 'make',
    placeId: input.placeId,
    primitiveHandledByCaller: true,
    performPrimitive: async transaction => {
      const rows = (await transaction`
        WITH permitted_place AS (
          SELECT place.id
          FROM places place
          WHERE place.id = ${input.placeId}
            AND (place.owner_id = ${input.actor.id} OR place.open_to_things)
            AND place.owner_id IS NOT NULL
          FOR UPDATE
        ), quota_spend AS (
          UPDATE residents SET things_today = things_today + 1
          WHERE id = ${input.actor.id}
            AND things_today < ${QUOTAS.things}
            AND EXISTS (SELECT 1 FROM permitted_place)
          RETURNING id
        ), new_thing AS (
          INSERT INTO things (place_id, name, body, owner_id, open_to_use)
          SELECT permitted_place.id, ${input.name}, ${input.body}, ${input.actor.id}, ${input.openToUse === true}
          FROM permitted_place CROSS JOIN quota_spend
          RETURNING *
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'thing_created', ${input.actor.handle}, jsonb_build_object(
            'thing_id', id, 'place_id', place_id, 'name', name,
            'kind_id', kind_id, 'birth_revision', birth_revision
          ) FROM new_thing
        )
        SELECT new_thing.*, ${input.actor.handle}::text AS owner, NULL::text AS kind
        FROM new_thing
      `) as ThingRow[]
      const thing = rows[0]
      if (!thing) {
        const quotaRows = (await transaction`
          SELECT things_today < ${QUOTAS.things} AS available
          FROM residents WHERE id = ${input.actor.id}
        `) as Array<{ available: boolean }>
        if (quotaRows[0]?.available === false) {
          throw new EngineError(429, `daily thing limit reached (${QUOTAS.things})`)
        }
        throw new EngineError(409, 'place changed before the thing could be made; retry')
      }
      completed.resolve(Object.freeze({
        ok: true,
        thing,
        consumedIngredientIds: null,
      }))
    },
  }))
  if (!boundary.ok) return boundary
  const action = boundary.action
  if (action.error) return actionFailure(action)
  return completed.promise
}

/** Make a typed or kindless thing as the primitive inside one engine action. */
export function makeThingThroughEngine(input: MakeThingInput): Promise<MakeThingResult> {
  return input.kindId === null ? makeKindlessThing(input) : makeCraftedThing(input)
}
