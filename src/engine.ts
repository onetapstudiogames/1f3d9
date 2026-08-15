import { Pool, type PoolClient } from '@neondatabase/serverless'
import { runtimeDatabaseUrl, sql } from './db.ts'
import {
  effectsForAction,
  isBasicAction,
  type BasicAction,
  type Effect,
  type SymbolicTarget,
} from './physics.ts'
import {
  executeEffects,
  SHARED_SOURCE_MUTATION_ERROR,
  thingState,
  withdrawOwnedThing,
  type EffectExecutionContext,
} from './engine-effects.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'

export {
  MAX_DUE_EFFECTS_PER_OBSERVATION,
  resolveDueEffects,
} from './engine-effects.ts'
export {
  MAX_PENDING_EFFECTS_PER_ACTOR,
  MAX_PENDING_EFFECTS_PER_PLACE,
} from './engine-timer-store.ts'

export interface TaggedSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
  query?: (text: string, values?: readonly unknown[]) => Promise<unknown>
}

export const engineSql = sql as unknown as TaggedSql
let transactionPool: Pool | null = null
type TestTransactionRunner = (
  db: TaggedSql,
  work: (transaction: TaggedSql, atomic: boolean) => Promise<unknown>,
) => Promise<unknown>
let testTransactionRunner: TestTransactionRunner | null = null

/** Explicit harness seam; production code must never set this. */
export function setEngineTransactionRunnerForTests(runner: TestTransactionRunner | null): void {
  testTransactionRunner = runner
}

function pool(): Pool {
  if (transactionPool) return transactionPool
  let connectionString: string
  try {
    connectionString = runtimeDatabaseUrl()
  } catch (error) {
    throw new EngineError(500, error instanceof Error ? error.message : 'database is temporarily unavailable')
  }
  transactionPool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 })
  return transactionPool
}

function clientSql(client: PoolClient): TaggedSql {
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? ''
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1] ?? ''}`
    }
    return (await client.query(text, values)).rows
  }) as TaggedSql
  tagged.query = async (text: string, values: readonly unknown[] = []) => (
    await client.query(text, [...values])
  ).rows
  return tagged
}

/** Production actions use one interactive transaction; tagged fakes stay injectable. */
export async function withEngineTransaction<T>(
  db: TaggedSql,
  work: (transaction: TaggedSql, atomic: boolean) => Promise<T>,
): Promise<T> {
  if (testTransactionRunner) return testTransactionRunner(db, work) as Promise<T>
  if (db !== engineSql) return work(db, false)
  const client = await pool().connect()
  try {
    await client.query('BEGIN')
    const result = await work(clientSql(client), true)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

const MAX_JSON_BYTES = 65_536
type EngineStatus = 400 | 403 | 404 | 409 | 429 | 500
export type TargetType = 'resident' | 'place' | 'thing' | 'kind'
export type ResolutionStatus = 'applied' | 'blocked' | 'noop' | 'failed'

export class EngineError extends Error {
  readonly status: EngineStatus

  constructor(status: EngineStatus, message: string) {
    super(message)
    this.name = 'EngineError'
    this.status = status
  }
}

export interface RuntimeTarget {
  readonly type: TargetType
  readonly id: number
}

export interface Presence {
  readonly residentId: number
  readonly currentPlaceId: number | null
  readonly homePlaceId: number | null
  readonly updatedAt: string
}

export interface EffectiveLaw {
  readonly traitId: number
  readonly name: string
  readonly recipe: unknown
  readonly sourcePlaceId: number
  readonly position: number
}

interface StoredProgram {
  readonly effects: readonly Effect[]
  readonly sourceTraitId: number | null
  readonly sourceThingId: number | null
  readonly lawSourcePlaceId: number | null
}

interface BaseActionInput {
  readonly actorId: number
  readonly actorHandle: string
  readonly action: BasicAction
  readonly placeId?: number | null
  readonly sourceThingId?: number | null
  readonly target?: RuntimeTarget | null
  readonly destinationPlaceId?: number | null
  readonly recipientId?: number | null
  readonly payload?: Readonly<Record<string, unknown>>
}

export type ActionInput = BaseActionInput & (
  | {
    /** Server-only: the callback runs atomically with effects and resolution. */
    readonly primitiveHandledByCaller: true
    readonly performPrimitive: (transaction: TaggedSql) => Promise<void>
  }
  | {
    readonly primitiveHandledByCaller?: false
    readonly performPrimitive?: never
  }
)

export interface ActionExecution {
  readonly actionId: number
  readonly status: ResolutionStatus
  readonly httpStatus: number
  readonly error: string | null
  readonly effectsApplied: number
}

export interface SymbolicContext {
  readonly actorId: number
  readonly placeId: number | null
  readonly sourceThingId: number | null
  readonly target: RuntimeTarget | null
}

interface RequiredActionInput {
  readonly actorId: number
  readonly actorHandle: string
  readonly action: BasicAction
  readonly placeId: number | null
  readonly sourceThingId: number | null
  readonly target: RuntimeTarget | null
  readonly destinationPlaceId: number | null
  readonly recipientId: number | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly primitiveHandledByCaller: boolean
  readonly performPrimitive: ((transaction: TaggedSql) => Promise<void>) | null
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function positiveId(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new EngineError(400, `${field} must be a positive integer`)
  }
  return value as number
}

function optionalId(value: unknown, field: string): number | null {
  return value == null ? null : positiveId(value, field)
}

function integer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function rowId(value: unknown, field: string): number {
  const parsed = integer(value)
  if (parsed === null || parsed <= 0) throw new EngineError(500, `database returned an invalid ${field}`)
  return parsed
}

function nullableRowId(value: unknown, field: string): number | null {
  return value == null ? null : rowId(value, field)
}

function json(value: unknown): string {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new EngineError(400, 'payload must be valid JSON')
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) {
    throw new EngineError(400, 'payload is too large')
  }
  return encoded
}

async function queryRows<T>(promise: Promise<unknown>): Promise<T[]> {
  const value = await promise
  if (!Array.isArray(value)) throw new EngineError(500, 'database returned an invalid result')
  return value as T[]
}

function presenceFromRow(row: Record<string, unknown>, residentId: number): Presence {
  return {
    residentId,
    currentPlaceId: nullableRowId(row.current_place_id, 'current place id'),
    homePlaceId: nullableRowId(row.home_place_id, 'home place id'),
    updatedAt: String(row.updated_at ?? ''),
  }
}

function targetType(value: unknown): TargetType | null {
  return value === 'resident' || value === 'place' || value === 'thing' || value === 'kind'
    ? value
    : null
}

function normalizeTarget(value: RuntimeTarget | null | undefined): RuntimeTarget | null {
  if (value == null) return null
  if (!targetType(value.type)) throw new EngineError(400, 'target type is invalid')
  return { type: value.type, id: positiveId(value.id, 'target id') }
}

export function resolveSymbolicTarget(
  symbolic: SymbolicTarget,
  context: SymbolicContext,
): RuntimeTarget | null {
  if (symbolic === 'actor') return { type: 'resident', id: context.actorId }
  if (symbolic === 'source') {
    return context.sourceThingId === null ? null : { type: 'thing', id: context.sourceThingId }
  }
  if (symbolic === 'target') return context.target
  return context.placeId === null ? null : { type: 'place', id: context.placeId }
}

export async function effectiveLaws(
  placeId: number,
  db: TaggedSql = engineSql,
): Promise<EffectiveLaw[]> {
  const id = positiveId(placeId, 'place id')
  const rows = await queryRows<Record<string, unknown>>(db`
    WITH RECURSIVE ancestry AS (
      SELECT place.id, place.parent_id, place.owner_id,
        place.owner_id AS sovereign_owner, 0 AS depth
      FROM places place WHERE place.id = ${id}
      UNION ALL
      SELECT parent.id, parent.parent_id, parent.owner_id,
        ancestry.sovereign_owner, ancestry.depth + 1
      FROM places parent JOIN ancestry ON parent.id = ancestry.parent_id
      WHERE parent.owner_id = ancestry.sovereign_owner
        AND parent.place_kind <> 'world'
    ), ranked_changes AS (
      SELECT change.place_id, change.trait_id, change.change_type, change.position,
        ancestry.depth,
        row_number() OVER (
          PARTITION BY change.place_id, change.trait_id ORDER BY change.id DESC
        ) AS rank
      FROM ancestry JOIN place_law_changes change ON change.place_id = ancestry.id
    )
    SELECT trait.id AS trait_id, trait.name, trait.recipe,
      ranked.place_id AS source_place_id, ranked.position
    FROM ranked_changes ranked JOIN traits trait ON trait.id = ranked.trait_id
    WHERE ranked.rank = 1 AND ranked.change_type = 'add'
    ORDER BY ranked.depth ASC, ranked.position ASC, trait.id ASC
  `)
  const laws = rows.map(row => ({
    traitId: rowId(row.trait_id, 'law trait id'),
    name: String(row.name),
    recipe: row.recipe,
    sourcePlaceId: rowId(row.source_place_id, 'law source place id'),
    position: integer(row.position) ?? 0,
  }))
  return laws.filter((law, index) => (
    laws.findIndex(candidate => candidate.traitId === law.traitId) === index
  ))
}

export async function isActionBlocked(
  residentId: number,
  action: BasicAction,
  db: TaggedSql = engineSql,
): Promise<boolean> {
  const actorId = positiveId(residentId, 'resident id')
  if (!isBasicAction(action)) throw new EngineError(400, 'action is invalid')
  if (action === 'go_home') return false
  const rows = await queryRows<{ blocked?: unknown }>(db`
    SELECT EXISTS (
      SELECT 1 FROM active_blocks
      WHERE resident_id = ${actorId} AND action_name = ${action} AND expires_at > now()
    ) AS blocked
  `)
  return rows[0]?.blocked === true
}

export async function ensurePresence(
  residentId: number,
  db: TaggedSql = engineSql,
): Promise<Presence> {
  const actorId = positiveId(residentId, 'resident id')
  const rows = await queryRows<Record<string, unknown>>(db`
    WITH first_owned AS (
      SELECT place.id FROM places place WHERE place.owner_id = ${actorId}
      ORDER BY place.created_at ASC, place.id ASC LIMIT 1
    ), world_root AS (
      SELECT place.id FROM places place
      WHERE place.parent_id IS NULL AND place.owner_id IS NULL
        AND place.place_kind = 'world'
        AND place.name = ${WORLD_ROOT_NAME}
      ORDER BY place.created_at ASC, place.id ASC LIMIT 1
    ), seeded AS (
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      SELECT resident.id,
        COALESCE((SELECT id FROM world_root), (SELECT id FROM first_owned)),
        CASE
          WHEN EXISTS (SELECT 1 FROM world_root) THEN NULL
          ELSE (SELECT id FROM first_owned)
        END
      FROM residents resident WHERE resident.id = ${actorId}
      ON CONFLICT (resident_id) DO UPDATE SET
        current_place_id = COALESCE(resident_presence.current_place_id, EXCLUDED.current_place_id),
        home_place_id = COALESCE(resident_presence.home_place_id, EXCLUDED.home_place_id),
        updated_at = CASE
          WHEN (resident_presence.current_place_id IS NULL AND EXCLUDED.current_place_id IS NOT NULL)
            OR (resident_presence.home_place_id IS NULL AND EXCLUDED.home_place_id IS NOT NULL)
          THEN now() ELSE resident_presence.updated_at END
      RETURNING resident_id, current_place_id, home_place_id, updated_at
    ) SELECT resident_id, current_place_id, home_place_id, updated_at FROM seeded
  `)
  if (!rows[0]) throw new EngineError(404, 'resident not found')
  return presenceFromRow(rows[0], actorId)
}

export const residentPresence = ensurePresence

async function readPresence(residentId: number, db: TaggedSql): Promise<Presence> {
  const rows = await queryRows<Record<string, unknown>>(db`
    SELECT resident_id, current_place_id, home_place_id, updated_at
    FROM resident_presence WHERE resident_id = ${residentId}
  `)
  return rows[0] ? presenceFromRow(rows[0], residentId) : ensurePresence(residentId, db)
}

async function lockPresence(residentId: number, db: TaggedSql): Promise<void> {
  await queryRows(db`
    SELECT resident_id FROM resident_presence WHERE resident_id = ${residentId} FOR UPDATE
  `)
}

export async function setHome(
  residentId: number,
  placeId: number,
  db: TaggedSql = engineSql,
): Promise<Presence> {
  const actorId = positiveId(residentId, 'resident id')
  const homeId = positiveId(placeId, 'place id')
  const rows = await queryRows<Record<string, unknown>>(db`
    WITH eligible_home AS MATERIALIZED (
      SELECT ${actorId}::integer AS resident_id, owned.id AS place_id
      FROM places owned
      JOIN resident_presence presence ON presence.current_place_id = owned.id
      WHERE owned.id = ${homeId}
        AND owned.owner_id = ${actorId}
        AND presence.resident_id = ${actorId}
      FOR UPDATE OF owned, presence
    )
    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    SELECT resident_id, place_id, place_id FROM eligible_home
    ON CONFLICT (resident_id) DO UPDATE SET
      home_place_id = EXCLUDED.home_place_id, updated_at = now()
    WHERE resident_presence.current_place_id = EXCLUDED.current_place_id
    RETURNING resident_id, current_place_id, home_place_id, updated_at
  `)
  if (!rows[0]) throw new EngineError(403, 'home must be a place you own')
  return presenceFromRow(rows[0], actorId)
}

export async function moveResident(
  residentId: number,
  destinationPlaceId: number,
  db: TaggedSql = engineSql,
): Promise<Presence> {
  const actorId = positiveId(residentId, 'resident id')
  const destinationId = positiveId(destinationPlaceId, 'destination place id')
  const stored = await readPresence(actorId, db)
  const current = stored.currentPlaceId === null ? await ensurePresence(actorId, db) : stored
  if (current.currentPlaceId === null) {
    throw new EngineError(409, 'resident has no current place')
  }
  const requested = [current.currentPlaceId, destinationId]
  const places = await queryRows<{ id?: unknown; parent_id?: unknown }>(db`
    SELECT id, parent_id FROM places WHERE id = ANY (${requested}::int[])
  `)
  const destination = places.find(row => integer(row.id) === destinationId)
  if (!destination) throw new EngineError(404, 'destination place not found')
  if (current.currentPlaceId === destinationId) return current
  const oldPlace = places.find(row => integer(row.id) === current.currentPlaceId)
  const destinationParent = nullableRowId(destination.parent_id, 'destination parent id')
  const oldParent = oldPlace ? nullableRowId(oldPlace.parent_id, 'current parent id') : null
  if (destinationParent !== current.currentPlaceId && oldParent !== destinationId) {
    throw new EngineError(403, 'move must cross one parent-child edge')
  }
  return writeResidentLocation(actorId, destinationId, db)
}

async function writeResidentLocation(residentId: number, destinationId: number, db: TaggedSql) {
  const rows = await queryRows<Record<string, unknown>>(db`
    UPDATE resident_presence SET current_place_id = ${destinationId}, updated_at = now()
    WHERE resident_id = ${residentId}
    RETURNING resident_id, current_place_id, home_place_id, updated_at
  `)
  if (!rows[0]) throw new EngineError(404, 'resident presence not found')
  return presenceFromRow(rows[0], residentId)
}

export async function goHome(residentId: number, db: TaggedSql = engineSql): Promise<Presence> {
  const actorId = positiveId(residentId, 'resident id')
  await ensurePresence(actorId, db)
  const rows = await queryRows<Record<string, unknown>>(db`
    UPDATE resident_presence presence
    SET current_place_id = presence.home_place_id, updated_at = now()
    FROM places home
    WHERE presence.resident_id = ${actorId} AND home.id = presence.home_place_id
      AND home.owner_id = ${actorId}
    RETURNING presence.resident_id, presence.current_place_id,
      presence.home_place_id, presence.updated_at
  `)
  if (!rows[0]) throw new EngineError(409, 'home is unset or no longer owned')
  return presenceFromRow(rows[0], actorId)
}

export async function lawProgramsForAction(
  placeId: number,
  action: BasicAction,
  db: TaggedSql = engineSql,
): Promise<StoredProgram[]> {
  return (await effectiveLaws(placeId, db)).flatMap(law => {
    const effects = effectsForAction(law.recipe, action)
    return effects.length === 0 ? [] : [{
      effects, sourceTraitId: law.traitId,
      sourceThingId: null, lawSourcePlaceId: law.sourcePlaceId,
    }]
  })
}

export async function thingProgramsForAction(
  thingId: number,
  action: BasicAction,
  db: TaggedSql = engineSql,
): Promise<StoredProgram[]> {
  const id = positiveId(thingId, 'thing id')
  const rows = await queryRows<Record<string, unknown>>(db`
    SELECT trait.id AS trait_id, trait.recipe
    FROM things thing
    JOIN kind_revision_traits link
      ON link.kind_id = thing.kind_id AND link.revision = thing.current_revision
    JOIN traits trait ON trait.id = link.trait_id
    WHERE thing.id = ${id} AND thing.withdrawn_at IS NULL
    ORDER BY link.position ASC
  `)
  return rows.flatMap(row => {
    const effects = effectsForAction(row.recipe, action)
    return effects.length === 0 ? [] : [{
      effects, sourceTraitId: rowId(row.trait_id, 'source trait id'),
      sourceThingId: id, lawSourcePlaceId: null,
    }]
  })
}

function normalizeActionInput(input: ActionInput): RequiredActionInput {
  const actorId = positiveId(input.actorId, 'actor id')
  if (!isBasicAction(input.action)) throw new EngineError(400, 'action is invalid')
  if (typeof input.actorHandle !== 'string' || input.actorHandle.length > 120) {
    throw new EngineError(400, 'actor handle is invalid')
  }
  const payload = input.payload ?? {}
  if (!objectRecord(payload)) throw new EngineError(400, 'payload must be an object')
  json(payload)
  return {
    actorId,
    actorHandle: input.actorHandle,
    action: input.action,
    placeId: optionalId(input.placeId, 'place id'),
    sourceThingId: optionalId(input.sourceThingId, 'source thing id'),
    target: normalizeTarget(input.target),
    destinationPlaceId: optionalId(input.destinationPlaceId, 'destination place id'),
    recipientId: optionalId(input.recipientId, 'recipient id'),
    payload,
    primitiveHandledByCaller: input.primitiveHandledByCaller === true,
    performPrimitive: input.primitiveHandledByCaller === true ? input.performPrimitive : null,
  }
}

async function recordAction(input: RequiredActionInput, db: TaggedSql): Promise<number> {
  const rows = await queryRows<{ id?: unknown }>(db`
    INSERT INTO action_runs (
      actor_id, action_name, place_id, source_thing_id, target_type, target_id,
      destination_place_id, recipient_id, payload
    ) VALUES (
      ${input.actorId}, ${input.action}, ${input.placeId}, ${input.sourceThingId},
      ${input.target?.type ?? null}, ${input.target?.id ?? null},
      ${input.destinationPlaceId}, ${input.recipientId}, ${json(input.payload)}::jsonb
    ) RETURNING id
  `)
  if (!rows[0]) throw new EngineError(500, 'action could not be recorded')
  return rowId(rows[0].id, 'action id')
}

async function recordActionResolution(
  actionId: number,
  actorHandle: string,
  status: ResolutionStatus,
  detail: Readonly<Record<string, unknown>>,
  db: TaggedSql,
) {
  await queryRows(db`
    WITH resolution AS (
      INSERT INTO action_resolutions (action_run_id, status, detail)
      VALUES (${actionId}, ${status}, ${json(detail)}::jsonb)
      ON CONFLICT (action_run_id) DO NOTHING RETURNING id
    )
    INSERT INTO events (kind, actor, detail)
    SELECT 'action', ${actorHandle},
      ${json({ action_id: actionId, status, ...detail })}::jsonb FROM resolution
    RETURNING id
  `)
}

async function sourceReady(input: RequiredActionInput, db: TaggedSql) {
  if (input.sourceThingId === null) return null
  const thing = await thingState(input.sourceThingId, db, { forUpdate: true })
  if (!thing || thing.withdrawnAt !== null) throw new EngineError(404, 'source thing not found')
  const sharedUse = input.action === 'use' && thing.ownerId !== input.actorId && thing.openToUse === true
  if (thing.ownerId !== input.actorId && !sharedUse) throw new EngineError(403, 'source thing is not yours')
  if (thing.activeOfferId !== null || thing.hasOpenOffer) {
    throw new EngineError(409, 'source thing has an open sale offer')
  }
  if (
    (sharedUse && input.placeId === null)
    || (input.placeId !== null && thing.placeId !== input.placeId)
  ) {
    throw new EngineError(403, 'source thing is not in the action place')
  }
  return thing
}

function sharedUseTouchesSourceDestructively(
  effects: readonly Effect[],
  sourceThingId: number,
  target: RuntimeTarget | null,
): boolean {
  for (const effect of effects) {
    if (
      effect.effect === 'destroy'
      || effect.effect === 'move'
      || effect.effect === 'transfer'
    ) {
      const namesSharedSource = effect.target === 'source'
        || (
          effect.target === 'target'
          && target?.type === 'thing'
          && target.id === sourceThingId
        )
      if (namesSharedSource) return true
    }
    if (
      effect.effect === 'wait'
      && sharedUseTouchesSourceDestructively(effect.then, sourceThingId, target)
    ) return true
    if (
      effect.effect === 'check_label'
      && (
        sharedUseTouchesSourceDestructively(effect.then, sourceThingId, target)
        || sharedUseTouchesSourceDestructively(effect.else ?? [], sourceThingId, target)
      )
    ) return true
  }
  return false
}

async function loadPrograms(input: RequiredActionInput, db: TaggedSql): Promise<StoredProgram[]> {
  if (input.action === 'go_home') return []
  const fromThing = input.sourceThingId === null
    ? [] : await thingProgramsForAction(input.sourceThingId, input.action, db)
  const fromLaws = input.placeId === null
    ? [] : await lawProgramsForAction(input.placeId, input.action, db)
  return [...fromThing, ...fromLaws]
}

async function intrinsicAction(input: RequiredActionInput, db: TaggedSql): Promise<boolean> {
  if (input.primitiveHandledByCaller) return false
  if (input.action === 'move') {
    if (input.destinationPlaceId === null) throw new EngineError(400, 'move needs a destination place')
    await moveResident(input.actorId, input.destinationPlaceId, db)
    return true
  }
  if (input.action === 'give') {
    if ((input.sourceThingId === null && input.target === null) || input.recipientId === null) {
      throw new EngineError(400, 'give needs a source thing or target, plus a recipient')
    }
    // The transfer brick implementation owns the same guarded transfer path.
    await executeEffects([{
      effect: 'transfer',
      target: input.sourceThingId === null ? 'target' : 'source',
      to: 'recipient',
    }], actionContext(0, input), db)
    return true
  }
  return false
}

function actionContext(
  actionId: number,
  input: RequiredActionInput,
  sharedSourceThingId: number | null = null,
): EffectExecutionContext {
  return {
    actionId: actionId > 0 ? actionId : null,
    actorId: input.actorId,
    actorHandle: input.actorHandle,
    placeId: input.placeId,
    sourceThingId: input.sourceThingId,
    sharedSourceThingId,
    target: input.target,
    destinationPlaceId: input.destinationPlaceId,
    recipientId: input.recipientId,
    sourceTraitId: null,
    lawAuthority: null,
    parentEffectId: null,
    generation: 0,
    logicalAt: new Date(),
  }
}

export async function runAction(
  rawInput: ActionInput,
  db: TaggedSql = engineSql,
): Promise<ActionExecution> {
  const normalized = normalizeActionInput(rawInput)
  let input = normalized.action === 'go_home' ? { ...normalized, placeId: null } : normalized
  if (input.action !== 'go_home') {
    const presence = await readPresence(input.actorId, db)
    if (input.placeId !== null && input.placeId !== presence.currentPlaceId) {
      throw new EngineError(403, 'action place must be the actor current place')
    }
    input = { ...input, placeId: presence.currentPlaceId }
  }
  const actionId = await recordAction(input, db)
  try {
    return await withEngineTransaction(db, async transaction => {
      if (input.action === 'go_home') await ensurePresence(input.actorId, transaction)
      await lockPresence(input.actorId, transaction)
      if (input.action !== 'go_home') {
        const fresh = await readPresence(input.actorId, transaction)
        if (fresh.currentPlaceId !== input.placeId) {
          throw new EngineError(409, 'actor location changed; retry the action')
        }
      }
      if (await isActionBlocked(input.actorId, input.action, transaction)) {
        const error = 'action is temporarily blocked'
        await recordActionResolution(actionId, input.actorHandle, 'blocked', { error }, transaction)
        return { actionId, status: 'blocked', httpStatus: 403, error, effectsApplied: 0 }
      }
      if (input.action === 'go_home') {
        await goHome(input.actorId, transaction)
        await recordActionResolution(actionId, input.actorHandle, 'applied', { effects_applied: 0 }, transaction)
        return { actionId, status: 'applied', httpStatus: 200, error: null, effectsApplied: 0 }
      }

      const source = await sourceReady(input, transaction)
      const programs = await loadPrograms(input, transaction)
      const sharedSourceThingId = input.action === 'use'
        && source
        && source.ownerId !== input.actorId
        && source.openToUse === true
        ? source.id
        : null
      if (
        sharedSourceThingId !== null
        && programs.some(program => sharedUseTouchesSourceDestructively(
          program.effects,
          sharedSourceThingId,
          input.target,
        ))
      ) {
        throw new EngineError(403, SHARED_SOURCE_MUTATION_ERROR)
      }
      const intrinsicApplied = await intrinsicAction(input, transaction)
      const base = actionContext(actionId, input, sharedSourceThingId)
      let effectsApplied = 0
      for (const program of programs) {
        effectsApplied += await executeEffects(program.effects, {
          ...base,
          sourceTraitId: program.sourceTraitId,
          sourceThingId: program.sourceThingId ?? base.sourceThingId,
          lawAuthority: program.lawSourcePlaceId === null || program.sourceTraitId === null ? null : {
            traitId: program.sourceTraitId,
            sourcePlaceId: program.lawSourcePlaceId,
          },
        }, transaction)
      }
      if (input.primitiveHandledByCaller) {
        if (!input.performPrimitive) throw new EngineError(500, 'caller primitive callback is missing')
        await input.performPrimitive(transaction)
      }
      if (!input.primitiveHandledByCaller && input.action === 'consume') {
        if (input.sourceThingId === null) throw new EngineError(400, 'consume needs a source thing')
        await withdrawOwnedThing(input.sourceThingId, input.actorId, input.actorHandle, transaction)
      }
      const primitiveApplied = intrinsicApplied || input.primitiveHandledByCaller
      const status: ResolutionStatus = effectsApplied === 0 && !primitiveApplied
        && input.action === 'use' ? 'noop' : 'applied'
      await recordActionResolution(actionId, input.actorHandle, status, { effects_applied: effectsApplied }, transaction)
      return { actionId, status, httpStatus: 200, error: null, effectsApplied }
    })
  } catch (error) {
    const failure = error instanceof EngineError ? error : new EngineError(500, 'effect execution failed')
    await recordActionResolution(actionId, input.actorHandle, 'failed', { error: failure.message }, db)
    return {
      actionId, status: 'failed', httpStatus: failure.status,
      error: failure.message, effectsApplied: 0,
    }
  }
}
