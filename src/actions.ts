import type { Context, Hono } from 'hono'
import { auth, err, HANDLE_RE, type Resident } from './core.ts'
import { sql } from './db.ts'
import {
  EngineError,
  engineSql,
  residentPresence,
  resolveDueEffects,
  runAction,
  setHome,
  withEngineTransaction,
  type ActionExecution,
  type Presence,
  type TaggedSql,
  type RuntimeTarget,
  type TargetType,
} from './engine.ts'
import { isBasicAction, type BasicAction } from './physics.ts'
import { positiveId } from './input.ts'

type JsonObject = Record<string, unknown>
type FailureStatus = 400 | 403 | 404 | 409 | 429 | 500

export async function setHomeAndRecordEvent(
  resident: Pick<Resident, 'id' | 'handle'>,
  placeId: number,
  db: TaggedSql = engineSql,
): Promise<Presence> {
  return withEngineTransaction(db, async transaction => {
    const presence = await setHome(resident.id, placeId, transaction)
    await transaction`
      INSERT INTO events (kind, actor, detail)
      VALUES (
        'home_set',
        ${resident.handle},
        jsonb_build_object('place_id', ${placeId}::integer)
      )
    `
    return presence
  })
}

const ACTION_FIELDS = Object.freeze([
  'action',
  'thing_id',
  'target_type',
  'target_id',
  'to_place_id',
  'to_handle',
] as const)

function hasOnly(value: JsonObject, fields: readonly string[]): boolean {
  const allowed = new Set(fields)
  return Object.keys(value).every(key => allowed.has(key))
}

async function jsonBody(c: Context): Promise<JsonObject | null> {
  const value = await c.req.json().catch(() => null)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function runtimeTargetType(value: unknown): TargetType | null {
  return value === 'resident' || value === 'place' || value === 'thing' || value === 'kind'
    ? value
    : null
}

function actionTarget(body: JsonObject): RuntimeTarget | null | undefined {
  const hasType = Object.hasOwn(body, 'target_type')
  const hasId = Object.hasOwn(body, 'target_id')
  if (hasType !== hasId) return undefined
  if (!hasType) return null
  const type = runtimeTargetType(body.target_type)
  const id = positiveId(body.target_id)
  return type && id ? Object.freeze({ type, id }) : undefined
}

async function recipientId(handle: unknown): Promise<number | null | undefined> {
  if (handle == null) return null
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) return undefined
  const rows = await sql`
    SELECT id FROM residents WHERE handle = ${handle}
  ` as Array<{ id: number }>
  return rows[0]?.id ?? undefined
}

function actionFieldsAllowed(action: BasicAction, body: JsonObject): boolean {
  const present = Object.keys(body)
  if (action === 'go_home') return present.every(key => key === 'action')
  if (action === 'move') return present.every(key => key === 'action' || key === 'to_place_id')
  if (action === 'give') return present.every(key => (
    key === 'action' || key === 'thing_id' || key === 'target_type'
      || key === 'target_id' || key === 'to_handle'
  ))
  return hasOnly(body, ACTION_FIELDS)
}

function expectedPlaceAfterAction(
  action: BasicAction,
  result: ActionExecution,
  before: Presence,
  destinationPlaceId: number | null,
): number | null {
  if (result.httpStatus !== 200) return before.currentPlaceId
  if (action === 'move') return destinationPlaceId
  if (action === 'go_home') return before.homePlaceId
  return before.currentPlaceId
}

/**
 * The action outcome is already durably recorded, so observing the city after
 * it is best-effort: a failed read or due-effect pass must never repaint a
 * committed action as an error. Deferred effects stay due for the next observer.
 */
async function observePlaceAfterAction(
  residentId: number,
  action: BasicAction,
  result: ActionExecution,
  before: Presence,
  destinationPlaceId: number | null,
): Promise<number | null> {
  let placeId = expectedPlaceAfterAction(action, result, before, destinationPlaceId)
  try {
    const after = await residentPresence(residentId)
    placeId = after.currentPlaceId
    if (result.httpStatus === 200 && after.currentPlaceId !== null
      && after.currentPlaceId !== before.currentPlaceId) {
      await resolveDueEffects(after.currentPlaceId)
    }
  } catch (error) {
    console.error('post-action observation failed', error)
  }
  return placeId
}

async function runResidentAction(
  c: Context,
  resident: Resident,
  body: JsonObject,
): Promise<Response> {
  const action = body.action
  if (!isBasicAction(action)) return err(c, 400, 'action is not in the frozen basic-action list')
  if (action === 'talk' || action === 'make') {
    return err(c, 400, `${action} requires its dedicated content endpoint`)
  }
  if (!actionFieldsAllowed(action, body)) return err(c, 400, `unsupported field for ${action}`)

  const thingId = body.thing_id == null ? null : positiveId(body.thing_id)
  if (body.thing_id != null && !thingId) return err(c, 400, 'thing_id must be a positive integer')
  const target = actionTarget(body)
  if (target === undefined) return err(c, 400, 'target_type and target_id must be a valid pair')
  const destinationPlaceId = body.to_place_id == null ? null : positiveId(body.to_place_id)
  if (body.to_place_id != null && !destinationPlaceId) {
    return err(c, 400, 'to_place_id must be a positive integer')
  }
  const toResidentId = await recipientId(body.to_handle)
  if (toResidentId === undefined) return err(c, 404, 'recipient handle not found')

  if (action === 'move' && destinationPlaceId === null) {
    return err(c, 400, 'move requires to_place_id')
  }
  if ((action === 'use' || action === 'consume') && thingId === null) {
    return err(c, 400, `${action} requires thing_id`)
  }
  if (action === 'give' && toResidentId === null) return err(c, 400, 'give requires to_handle')
  const transferTarget = action === 'give' && target === null && thingId !== null
    ? Object.freeze({ type: 'thing' as const, id: thingId })
    : target
  if (action === 'give' && transferTarget === null) {
    return err(c, 400, 'give requires thing_id or a target_type/target_id pair')
  }

  try {
    const before = await residentPresence(resident.id)
    if (before.currentPlaceId !== null) await resolveDueEffects(before.currentPlaceId)
    const result = await runAction({
      actorId: resident.id,
      actorHandle: resident.handle,
      action,
      sourceThingId: thingId,
      target: transferTarget,
      destinationPlaceId,
      recipientId: toResidentId,
      payload: {},
    })
    const placeId = await observePlaceAfterAction(
      resident.id, action, result, before, destinationPlaceId,
    )
    const publicAction = {
      id: result.actionId,
      action,
      status: result.status,
      place_id: placeId,
      effects_applied: result.effectsApplied,
    }
    if (result.error) {
      return c.json({ error: result.error, action: publicAction }, result.httpStatus as FailureStatus)
    }
    return c.json({ action: publicAction })
  } catch (error) {
    if (error instanceof EngineError) return err(c, error.status, error.message)
    throw error
  }
}

async function actionRequest(c: Context, forced?: Partial<JsonObject>): Promise<Response> {
  const resident = await auth(c)
  if (!resident) return err(c, 401, 'bad or missing bearer secret')
  const contentLength = c.req.header('content-length')
  const supplied = forced && (contentLength == null || contentLength === '0')
    ? {}
    : await jsonBody(c)
  if (supplied === null) return err(c, 400, 'body must be a JSON object')
  const body = { ...supplied, ...forced }
  return runResidentAction(c, resident, body)
}

export function mountActionRoutes(app: Hono): void {
  app.post('/api/action', c => actionRequest(c))
  app.post('/api/go-home', c => actionRequest(c, { action: 'go_home' }))
  app.post('/api/thing/:id/use', c => actionRequest(c, {
    action: 'use',
    thing_id: Number(c.req.param('id')),
  }))
  app.post('/api/thing/:id/consume', c => actionRequest(c, {
    action: 'consume',
    thing_id: Number(c.req.param('id')),
  }))

  app.post('/api/me/home', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, 'bad or missing bearer secret')
    const body = await jsonBody(c)
    if (!body || !hasOnly(body, ['place_id']) || Object.keys(body).length !== 1) {
      return err(c, 400, 'need exactly place_id')
    }
    const placeId = positiveId(body.place_id)
    if (!placeId) return err(c, 400, 'place_id must be a positive integer')
    try {
      const presence = await setHomeAndRecordEvent(resident, placeId)
      return c.json({
        resident: {
          current_place_id: presence.currentPlaceId,
          home_place_id: presence.homePlaceId,
        },
      })
    } catch (error) {
      if (error instanceof EngineError) return err(c, error.status, error.message)
      throw error
    }
  })
}
