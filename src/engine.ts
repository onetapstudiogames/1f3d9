import { Pool, type PoolClient } from '@neondatabase/serverless'
import { COLLISION_CONFLICT_MESSAGE, isRetryableCollision } from './core.ts'
import { runtimeDatabaseUrl, sql } from './db.ts'
import {
  effectsForAction,
  isBasicAction,
  type BasicAction,
  type Effect,
  type SymbolicTarget,
} from './physics.ts'
import {
  executeEffectsWithOutcome,
  SHARED_SOURCE_MUTATION_ERROR,
  thingState,
  withdrawOwnedThing,
  type EffectExecutionContext,
} from './engine-effects.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'
import { gazetteRoomLifecycleRefusal } from './gazette-room.ts'
import { placePermission, withPlacePermission } from './place-permission.ts'

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
const activeTestTransactions = new WeakSet<TaggedSql>()

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

/**
 * COMMIT itself failed, so the transaction may or may not have applied.
 * Callers must resolve the canonical stored outcome instead of assuming either.
 */
export class CommitOutcomeUnknownError extends Error {
  readonly sourceError: unknown

  constructor(sourceError: unknown) {
    super('transaction commit outcome is unknown')
    this.name = 'CommitOutcomeUnknownError'
    this.sourceError = sourceError
  }
}

/** The transaction is already doomed; a failed ROLLBACK must not mask the cause. */
async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {
    // A dead connection cannot roll back; releasing it discards the transaction.
  }
}

/** Production actions use one interactive transaction; tagged fakes stay injectable. */
export async function withEngineTransaction<T>(
  db: TaggedSql,
  work: (transaction: TaggedSql, atomic: boolean) => Promise<T>,
): Promise<T> {
  if (activeTestTransactions.has(db)) return work(db, false)
  if (testTransactionRunner) {
    return testTransactionRunner(db, async (transaction, atomic) => {
      activeTestTransactions.add(transaction)
      try {
        return await work(transaction, atomic)
      } finally {
        activeTestTransactions.delete(transaction)
      }
    }) as Promise<T>
  }
  if (db !== engineSql) return work(db, false)
  const client = await pool().connect()
  try {
    await client.query('BEGIN')
    let result: T
    try {
      result = await work(clientSql(client), true)
    } catch (error) {
      await rollbackQuietly(client)
      throw error
    }
    try {
      await client.query('COMMIT')
    } catch (error) {
      await rollbackQuietly(client)
      throw new CommitOutcomeUnknownError(error)
    }
    return result
  } finally {
    client.release()
  }
}

const MAX_JSON_BYTES = 65_536
type EngineStatus = 400 | 403 | 404 | 409 | 429 | 500
export type TargetType = 'resident' | 'place' | 'thing' | 'kind'
export type ResolutionStatus = 'applied' | 'blocked' | 'noop' | 'failed'
/** What a caller may see: stored statuses plus the honest not-knowable one. */
export type ActionOutcomeStatus = ResolutionStatus | 'unconfirmed'

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
  readonly carryThingId?: number | null
  readonly recipientId?: number | null
  readonly payload?: Readonly<Record<string, unknown>>
}

export type ActionInput = BaseActionInput & (
  | {
    /** Server-only: the callback runs atomically with effects and resolution. */
    readonly primitiveHandledByCaller: true
    /** Server-only: the callback guarantees a typed event in the same transaction. */
    readonly primitiveEmitsTypedEvent?: true
    readonly performPrimitive: (transaction: TaggedSql) => Promise<void>
  }
  | {
    readonly primitiveHandledByCaller?: false
    readonly primitiveEmitsTypedEvent?: never
    readonly performPrimitive?: never
  }
)

export interface ActionExecution {
  readonly actionId: number
  readonly status: ActionOutcomeStatus
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
  readonly carryThingId: number | null
  readonly recipientId: number | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly primitiveHandledByCaller: boolean
  readonly primitiveEmitsTypedEvent: boolean
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
    throw new EngineError(400, `payload exceeds ${MAX_JSON_BYTES} UTF-8 bytes; send a smaller payload`)
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
  if (!targetType(value.type)) throw new EngineError(400, 'target type is invalid; use resident, place, thing, or kind')
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

interface ActiveActionBlock {
  readonly sourceTraitId: number | null
  readonly traitName: string | null
  readonly sourcePlaceId: number | null
  readonly sourceThingId: number | null
}

async function activeActionBlock(
  residentId: number,
  action: BasicAction,
  db: TaggedSql = engineSql,
): Promise<ActiveActionBlock | null> {
  const actorId = positiveId(residentId, 'resident id')
  if (!isBasicAction(action)) throw new EngineError(400, 'action is invalid; use talk, move, use, give, consume, make, or go_home')
  if (action === 'go_home') return null
  const rows = await queryRows<Record<string, unknown>>(db`
    SELECT block.id IS NOT NULL AS blocked, block.source_trait_id,
      CASE WHEN moderation.action = 'remove' THEN NULL ELSE trait.name END AS trait_name,
      block.source_place_id, block.source_thing_id,
      COALESCE((
        SELECT provenance.change_type = 'add'
        FROM place_law_changes provenance
        WHERE provenance.place_id = block.source_place_id
          AND provenance.trait_id = block.source_trait_id
          AND provenance.created_at <= block.created_at
        ORDER BY provenance.created_at DESC, provenance.id DESC
        LIMIT 1
      ), false) AS law_source_matches_trait
    FROM (VALUES (1)) AS singleton(value)
    LEFT JOIN LATERAL (
      SELECT active.id, active.source_trait_id, active.created_at,
        active.source_place_id, active.source_thing_id
      FROM active_blocks active
      WHERE active.resident_id = ${actorId} AND active.action_name = ${action}
        AND active.expires_at > now()
      ORDER BY active.expires_at ASC, active.id DESC
      LIMIT 1
    ) block ON true
    LEFT JOIN traits trait ON trait.id = block.source_trait_id
    LEFT JOIN LATERAL (
      SELECT action.action
      FROM moderation_actions action
      WHERE action.target_type = 'trait' AND action.target_id = block.source_trait_id
      ORDER BY action.created_at DESC, action.id DESC
      LIMIT 1
    ) moderation ON true
  `)
  const row = rows[0]
  if (!row || row.blocked !== true) return null
  const sourceTraitId = nullableRowId(row.source_trait_id, 'block source trait id')
  const sourceThingId = nullableRowId(row.source_thing_id, 'block source thing id')
  const storedSourcePlaceId = nullableRowId(row.source_place_id, 'block source place id')
  const sourcePlaceId = sourceThingId !== null
    || (sourceTraitId !== null && row.law_source_matches_trait !== true)
    ? null
    : storedSourcePlaceId
  return Object.freeze({
    sourceTraitId,
    traitName: typeof row.trait_name === 'string' && row.trait_name.length > 0
      ? row.trait_name
      : null,
    sourcePlaceId,
    sourceThingId,
  })
}

export async function isActionBlocked(
  residentId: number,
  action: BasicAction,
  db: TaggedSql = engineSql,
): Promise<boolean> {
  return await activeActionBlock(residentId, action, db) !== null
}

interface ActiveBlockCause {
  readonly callerError: string
  readonly resolutionDetail: Readonly<Record<string, unknown>>
}

function activeBlockCause(action: BasicAction, block: ActiveActionBlock): ActiveBlockCause {
  let callerSource: string
  let stableSource: string
  if (block.sourceThingId !== null) {
    if (block.traitName !== null) {
      callerSource = `by thing trait "${block.traitName}" from thing_id ${block.sourceThingId}`
    } else if (block.sourceTraitId === null) {
      callerSource = `by a thing trait from thing_id ${block.sourceThingId}; its trait identity is unavailable`
    } else {
      callerSource = `by thing trait_id ${block.sourceTraitId} from thing_id ${block.sourceThingId}; its name is unavailable`
    }
    stableSource = block.sourceTraitId === null
      ? `${action} is temporarily blocked by a thing trait from thing_id ${block.sourceThingId}; its trait identity is unavailable`
      : `${action} is temporarily blocked by thing trait_id ${block.sourceTraitId} from thing_id ${block.sourceThingId}`
  } else if (block.sourcePlaceId !== null) {
    if (block.traitName !== null) {
      callerSource = `by law "${block.traitName}" from place_id ${block.sourcePlaceId}`
    } else if (block.sourceTraitId === null) {
      callerSource = `by a law from place_id ${block.sourcePlaceId}; its trait identity is unavailable`
    } else {
      callerSource = `by law trait_id ${block.sourceTraitId} from place_id ${block.sourcePlaceId}; its name is unavailable`
    }
    stableSource = block.sourceTraitId === null
      ? `${action} is temporarily blocked by a law from place_id ${block.sourcePlaceId}; its trait identity is unavailable`
      : `${action} is temporarily blocked by law trait_id ${block.sourceTraitId} from place_id ${block.sourcePlaceId}`
  } else if (block.sourceTraitId !== null) {
    callerSource = block.traitName === null
      ? `by trait_id ${block.sourceTraitId}; its name and source are unavailable`
      : `by trait "${block.traitName}"; its source is unavailable`
    stableSource = `${action} is temporarily blocked by trait_id ${block.sourceTraitId}; its source is unavailable`
  } else {
    callerSource = block.traitName === null
      ? 'this block has no stored law or thing-trait source'
      : `by trait "${block.traitName}"; its source is unavailable`
    stableSource = `${action} is temporarily blocked; this block has no stored law or thing-trait source`
  }
  const callerError = callerSource.startsWith('by ')
    ? `${action} is temporarily blocked ${callerSource}`
    : `${action} is temporarily blocked; ${callerSource}`
  return Object.freeze({
    callerError,
    resolutionDetail: Object.freeze({
      error: stableSource,
      ...(block.sourceTraitId === null ? {} : { trait_id: block.sourceTraitId }),
      ...(block.traitName === null ? {} : { trait: block.traitName }),
      ...(block.sourcePlaceId === null ? {} : { source_place_id: block.sourcePlaceId }),
      ...(block.sourceThingId === null ? {} : { source_thing_id: block.sourceThingId }),
    }),
  })
}

export async function ensurePresence(
  residentId: number,
  db: TaggedSql = engineSql,
): Promise<Presence> {
  const actorId = positiveId(residentId, 'resident id')
  const rows = await queryRows<Record<string, unknown>>(db`
    WITH first_owned AS (
      SELECT place.id FROM places place
      WHERE place.owner_id = ${actorId} AND place.retired_at IS NULL
      ORDER BY place.created_at ASC, place.id ASC LIMIT 1
      FOR SHARE OF place
    ), world_root AS (
      SELECT place.id FROM places place
      WHERE place.parent_id IS NULL AND place.owner_id IS NULL
        AND place.place_kind = 'world'
        AND place.name = ${WORLD_ROOT_NAME}
      ORDER BY place.created_at ASC, place.id ASC LIMIT 1
      FOR SHARE OF place
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
  if (!rows[0]) {
    throw new EngineError(
      404,
      `resident_id ${actorId} was not found; reconnect with the current resident key and retry`,
    )
  }
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

async function lockPresence(residentId: number, db: TaggedSql): Promise<Presence> {
  const rows = await queryRows<Record<string, unknown>>(db`
    SELECT resident_id, current_place_id, home_place_id, updated_at
    FROM resident_presence WHERE resident_id = ${residentId} FOR UPDATE
  `)
  if (!rows[0]) throw new EngineError(404, 'resident presence was not found; reconnect with the current resident key and retry')
  return presenceFromRow(rows[0], residentId)
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
        AND owned.retired_at IS NULL
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
  if (!rows[0]) throw new EngineError(403, 'home must be the owned place where you are standing')
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
    throw new EngineError(409, 'resident has no current place; reconnect with the current resident key and retry, then contact the city operator')
  }
  const requested = [current.currentPlaceId, destinationId]
  const places = await queryRows<{ id?: unknown; parent_id?: unknown; retired_at?: unknown }>(db`
    SELECT id, parent_id, retired_at FROM places
    WHERE id = ANY (${requested}::int[])
    FOR SHARE
  `)
  const destination = places.find(row => integer(row.id) === destinationId)
  if (!destination) {
    throw new EngineError(
      404,
      `destination place_id ${destinationId} was not found; use GET /api/map?view=outline&parent_id=${current.currentPlaceId} to choose a public adjacent destination`,
    )
  }
  if (destination.retired_at != null) {
    throw new EngineError(409, 'destination place is retired; restore it before moving there')
  }
  if (current.currentPlaceId === destinationId) return current
  const oldPlace = places.find(row => integer(row.id) === current.currentPlaceId)
  const destinationParent = nullableRowId(destination.parent_id, 'destination parent id')
  const oldParent = oldPlace ? nullableRowId(oldPlace.parent_id, 'current parent id') : null
  if (destinationParent !== current.currentPlaceId && oldParent !== destinationId) {
    throw new EngineError(
      403,
      `place_id ${destinationId} exists, but entry is closed from your current place_id ${current.currentPlaceId}; entry opens when you stand in its parent or one of its direct children, so use the public map outline to move one parent-child edge at a time`,
    )
  }
  return writeResidentLocation(actorId, destinationId, db)
}

async function writeResidentLocation(residentId: number, destinationId: number, db: TaggedSql) {
  const rows = await queryRows<Record<string, unknown>>(db`
    UPDATE resident_presence SET current_place_id = ${destinationId}, updated_at = now()
    WHERE resident_id = ${residentId}
    RETURNING resident_id, current_place_id, home_place_id, updated_at
  `)
  if (!rows[0]) throw new EngineError(404, 'resident presence was not found; reconnect with the current resident key and retry')
  return presenceFromRow(rows[0], residentId)
}

export async function goHome(residentId: number, db: TaggedSql = engineSql): Promise<Presence> {
  const actorId = positiveId(residentId, 'resident id')
  await ensurePresence(actorId, db)
  const rows = await queryRows<Record<string, unknown>>(db`
    WITH usable_home AS MATERIALIZED (
      SELECT home.id
      FROM resident_presence presence
      JOIN places home ON home.id = presence.home_place_id
      WHERE presence.resident_id = ${actorId}
        AND home.owner_id = ${actorId}
        AND home.retired_at IS NULL
      FOR SHARE OF home
    )
    UPDATE resident_presence presence
    SET current_place_id = presence.home_place_id, updated_at = now()
    FROM usable_home home
    WHERE presence.resident_id = ${actorId} AND home.id = presence.home_place_id
    RETURNING presence.resident_id, presence.current_place_id,
      presence.home_place_id, presence.updated_at
  `)
  if (!rows[0]) throw new EngineError(409, 'home is unset or no longer owned; move normally or claim an owned home before using go_home')
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
  if (!isBasicAction(input.action)) throw new EngineError(400, 'action is invalid; use talk, move, use, give, consume, make, or go_home')
  if (typeof input.actorHandle !== 'string' || input.actorHandle.length > 120) {
    throw new EngineError(400, 'actor handle is invalid; reconnect with the current resident key and retry')
  }
  const payload = input.payload ?? {}
  if (!objectRecord(payload)) throw new EngineError(400, 'payload must be an object')
  json(payload)
  const carryThingId = optionalId(input.carryThingId, 'carry thing id')
  if (carryThingId !== null && input.action !== 'move') {
    throw new EngineError(400, 'carry_thing_id is accepted only for move')
  }
  return {
    actorId,
    actorHandle: input.actorHandle,
    action: input.action,
    placeId: optionalId(input.placeId, 'place id'),
    sourceThingId: optionalId(input.sourceThingId, 'source thing id'),
    target: normalizeTarget(input.target),
    destinationPlaceId: optionalId(input.destinationPlaceId, 'destination place id'),
    carryThingId,
    recipientId: optionalId(input.recipientId, 'recipient id'),
    payload: carryThingId === null ? payload : {
      ...payload,
      carry_thing_id: carryThingId,
    },
    primitiveHandledByCaller: input.primitiveHandledByCaller === true,
    primitiveEmitsTypedEvent: input.primitiveHandledByCaller === true
      && input.primitiveEmitsTypedEvent === true,
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
  if (!rows[0]) throw new EngineError(500, 'action could not be recorded because the city write returned no record; retry once, then contact the city operator')
  return rowId(rows[0].id, 'action id')
}

function publicActionEventDetail(
  actionId: number,
  action: BasicAction,
  status: ResolutionStatus,
  detail: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const effectsApplied = integer(detail.effects_applied)
  const error = typeof detail.error === 'string' ? detail.error : null
  const fromPlaceId = integer(detail.from_place_id)
  const toPlaceId = integer(detail.to_place_id)
  const traitId = integer(detail.trait_id)
  const trait = typeof detail.trait === 'string' && detail.trait.length > 0
    ? detail.trait
    : null
  const sourcePlaceId = integer(detail.source_place_id)
  const sourceThingId = integer(detail.source_thing_id)
  const thingId = integer(detail.thing_id)
  const placeId = integer(detail.place_id)
  const mode = detail.mode === 'carry' ? 'carry' : null
  return Object.freeze({
    action_id: actionId,
    action,
    status,
    ...(effectsApplied === null ? {} : { effects_applied: effectsApplied }),
    ...(fromPlaceId === null || fromPlaceId <= 0 ? {} : { from_place_id: fromPlaceId }),
    ...(toPlaceId === null || toPlaceId <= 0 ? {} : { to_place_id: toPlaceId }),
    ...(error === null ? {} : { error }),
    ...(traitId === null || traitId <= 0 ? {} : { trait_id: traitId }),
    ...(trait === null ? {} : { trait }),
    ...(sourcePlaceId === null || sourcePlaceId <= 0 ? {} : { source_place_id: sourcePlaceId }),
    ...(sourceThingId === null || sourceThingId <= 0 ? {} : { source_thing_id: sourceThingId }),
    ...(thingId === null || thingId <= 0 ? {} : { thing_id: thingId }),
    ...(placeId === null || placeId <= 0 ? {} : { place_id: placeId }),
    ...(mode === null ? {} : { mode }),
  })
}

async function recordActionResolution(
  actionId: number,
  actorHandle: string,
  action: BasicAction,
  status: ResolutionStatus,
  detail: Readonly<Record<string, unknown>>,
  db: TaggedSql,
  emitPublicEvent = true,
) {
  const publicDetail = publicActionEventDetail(actionId, action, status, detail)
  const rows = await queryRows(db`
    WITH resolution AS (
      INSERT INTO action_resolutions (action_run_id, status, detail)
      VALUES (${actionId}, ${status}, ${json(detail)}::jsonb)
      ON CONFLICT (action_run_id) DO NOTHING RETURNING id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'action', ${actorHandle},
        ${json(publicDetail)}::jsonb FROM resolution
      WHERE ${emitPublicEvent}
      RETURNING id
    )
    SELECT resolution.id FROM resolution
    LEFT JOIN new_event ON true
  `)
  // The unique action_run_id index makes this insert wait on any in-doubt
  // transaction for the same run, so losing the conflict proves an earlier
  // resolution committed and is now visible.
  return rows.length > 0
}

export const UNCONFIRMED_ACTION_ERROR =
  'the action outcome could not be confirmed; re-read your state before repeating it'

function resolutionDetail(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return objectRecord(JSON.parse(value)) ?? {}
    } catch {
      return {}
    }
  }
  return objectRecord(value) ?? {}
}

/** The resolution row commits atomically with the action, so it is the canonical outcome. */
async function committedResolution(
  actionId: number,
  db: TaggedSql,
): Promise<ActionExecution | null> {
  const rows = await queryRows<Record<string, unknown>>(db`
    SELECT status, detail FROM action_resolutions WHERE action_run_id = ${actionId}
  `)
  const row = rows[0]
  if (!row) return null
  const detail = resolutionDetail(row.detail)
  if (row.status === 'applied' || row.status === 'noop') {
    return {
      actionId,
      status: row.status,
      httpStatus: 200,
      error: null,
      effectsApplied: integer(detail.effects_applied) ?? 0,
    }
  }
  if (row.status === 'blocked') {
    const message = typeof detail.error === 'string'
      ? detail.error
      : 'action is temporarily blocked'
    return { actionId, status: 'blocked', httpStatus: 403, error: message, effectsApplied: 0 }
  }
  return null
}

export function logUnrecognizedExecutionFailure(
  subject: 'action' | 'stored effect',
  executionId: number,
  error: unknown,
): void {
  const fields: Record<string, unknown> = subject === 'action'
    ? { action_id: executionId }
    : { effect_id: executionId }
  if (error instanceof Error) {
    fields.error_name = error.name.slice(0, 120)
    fields.error_message = error.message.slice(0, 1_000)
  } else {
    fields.error_type = typeof error
  }
  const stored = objectRecord(error)
  if (
    typeof stored?.code === 'string'
    && /^[a-z0-9]{1,16}$/iu.test(stored.code)
  ) fields.error_code = stored.code
  // Deliberately do not log the action/effect payload, SQL text, parameters, or
  // database detail: any of those may contain resident-authored text.
  try {
    console.error(`unrecognized ${subject} execution failure`, fields)
  } catch {
    // Observability cannot be allowed to replace the canonical action outcome.
  }
}

function failureFromError(error: unknown, actionId: number): EngineError {
  if (error instanceof EngineError && error.status < 500) return error
  const gazetteRoomError = gazetteRoomLifecycleRefusal(error)
  if (gazetteRoomError) return new EngineError(409, gazetteRoomError)
  if (isRetryableCollision(error)) return new EngineError(409, COLLISION_CONFLICT_MESSAGE)
  logUnrecognizedExecutionFailure('action', actionId, error)
  return new EngineError(500, 'the city could not complete this action because its primitive failed; correct the primitive refusal shown in action.error before retrying')
}

async function recordFailedExecution(
  actionId: number,
  actorHandle: string,
  action: BasicAction,
  error: unknown,
  db: TaggedSql,
): Promise<ActionExecution> {
  const failure = failureFromError(error, actionId)
  const won = await recordActionResolution(
    actionId, actorHandle, action, 'failed', { error: failure.message }, db,
  )
  if (!won) {
    // A resolution already committed — possibly the very transaction whose
    // commit acknowledgement was lost. That stored row is the one canonical
    // outcome, so it wins over the failure this call meant to record.
    const committed = await committedResolution(actionId, db)
    if (committed) return committed
  }
  return {
    actionId,
    status: 'failed',
    httpStatus: failure.status,
    error: failure.message,
    effectsApplied: 0,
  }
}

/**
 * The commit outcome is unknown, so the database decides. A visible committed
 * resolution is returned as-is. Otherwise the failure insert settles the race:
 * its unique index waits out the in-doubt transaction, and losing the conflict
 * means the action committed after all, so the stored outcome is returned. An
 * unreadable record must never claim failure or invite repeating work that may
 * already have applied.
 */
async function resolveUncertainCommit(
  actionId: number,
  actorHandle: string,
  action: BasicAction,
  failure: CommitOutcomeUnknownError,
  db: TaggedSql,
): Promise<ActionExecution> {
  try {
    const committed = await committedResolution(actionId, db)
    if (committed) return committed
    return await recordFailedExecution(actionId, actorHandle, action, failure.sourceError, db)
  } catch {
    return {
      actionId,
      status: 'unconfirmed',
      httpStatus: 500,
      error: UNCONFIRMED_ACTION_ERROR,
      effectsApplied: 0,
    }
  }
}

async function sourceReady(input: RequiredActionInput, db: TaggedSql) {
  if (input.sourceThingId === null) return null
  const thing = await thingState(input.sourceThingId, db, { forUpdate: true })
  if (!thing || thing.withdrawnAt !== null) {
    throw new EngineError(404, 'thing_id was not found or is withdrawn; use a current active thing_id from GET /api/things')
  }
  const sharedUse = input.action === 'use' && thing.ownerId !== input.actorId && thing.openToUse === true
  if (thing.ownerId !== input.actorId && !sharedUse) {
    throw new EngineError(
      403,
      'thing_id is not yours; use a thing you own, or use an open_to_use thing without destructive effects',
    )
  }
  if (thing.activeOfferId !== null || thing.hasOpenOffer) {
    throw new EngineError(409, 'thing_id has an open sale offer; cancel the offer or use another active thing')
  }
  if (sharedUse && input.placeId === null) {
    throw new EngineError(
      403,
      `thing_id ${input.sourceThingId} cannot be used because your current place_id is unset`,
    )
  }
  if (input.placeId !== null && thing.placeId !== input.placeId) {
    throw new EngineError(
      403,
      `thing_id ${input.sourceThingId} must be in place_id ${input.placeId}; its current place_id is ${thing.placeId}`,
    )
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

interface IntrinsicActionOutcome {
  readonly applied: boolean
  readonly emittedTypedPublicEvent: boolean
}

function intrinsicActionOutcome(
  applied: boolean,
  emittedTypedPublicEvent: boolean,
): IntrinsicActionOutcome {
  return Object.freeze({ applied, emittedTypedPublicEvent })
}

async function moveResidentWithCarry(
  input: RequiredActionInput,
  actionId: number,
  db: TaggedSql,
): Promise<void> {
  if (input.destinationPlaceId === null) throw new EngineError(400, 'move needs a destination place')
  if (input.carryThingId === null) {
    await moveResident(input.actorId, input.destinationPlaceId, db)
    return
  }
  if (input.placeId === null) {
    throw new EngineError(409, 'you cannot carry a thing because your current place is unset; reconnect with the current resident key and retry')
  }
  if (input.destinationPlaceId === input.placeId) {
    throw new EngineError(400, 'carry_thing_id requires a move to a different adjacent place')
  }
  const rows = await queryRows<Record<string, unknown>>(db`
    SELECT thing.id, thing.owner_id, thing.place_id, thing.withdrawn_at,
      thing.active_offer_id,
      EXISTS (
        SELECT 1 FROM transfer_offers offer
        WHERE offer.asset_type = 'thing' AND offer.asset_id = thing.id
          AND offer.status = 'open'
      ) AS has_open_offer,
      EXISTS (
        SELECT 1 FROM thing_later_holder_marks mark
        WHERE mark.thing_id = thing.id AND mark.resident_id <> ${input.actorId}
      ) AS marked_by_other,
      (
        SELECT moderation.action FROM moderation_actions moderation
        WHERE moderation.target_type = 'thing' AND moderation.target_id = thing.id
        ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
      ) AS moderation_action
    FROM things thing
    WHERE thing.id = ${input.carryThingId}
    FOR UPDATE OF thing
  `)
  const thing = rows[0]
  if (!thing || thing.withdrawn_at !== null) {
    throw new EngineError(404, 'carry_thing_id was not found or is withdrawn; choose a current active thing you own')
  }
  const ownerId = rowId(thing.owner_id, 'carry thing owner id')
  const placeId = rowId(thing.place_id, 'carry thing place id')
  if (ownerId !== input.actorId) throw new EngineError(403, 'you can carry only a thing you own')
  if (placeId !== input.placeId) {
    throw new EngineError(
      403,
      `carry_thing_id must be in the place you are leaving (place_id ${input.placeId}); its current place_id is ${placeId}`,
    )
  }
  if (thing.active_offer_id !== null || thing.has_open_offer === true) {
    throw new EngineError(409, 'carry_thing_id has an open sale offer or market lock; cancel the offer, wait for the lock to clear, or carry another owned thing')
  }
  if (thing.marked_by_other === true) {
    throw new EngineError(409, 'carry_thing_id is marked for a later holder by another resident; wait for that mark to clear or carry another owned thing')
  }
  if (thing.moderation_action === 'remove') {
    throw new EngineError(409, 'carry_thing_id is under a moderation hold; wait for the hold to clear or carry another owned thing')
  }

  const destinations = await queryRows<Record<string, unknown>>(withPlacePermission(db)`
    SELECT destination.id, destination.retired_at,
      ${placePermission('destination', 'open_to_things', input.actorId)} AS destination_permits_things
    FROM places destination
    WHERE destination.id = ${input.destinationPlaceId}
    FOR UPDATE OF destination
  `)
  if (destinations[0]?.retired_at != null) {
    throw new EngineError(409, 'destination place is retired; restore it before moving there')
  }
  if (destinations[0] && destinations[0].destination_permits_things !== true) {
    throw new EngineError(
      403,
      'destination place does not accept visitor things; drop the carry and walk, or go where things are welcome',
    )
  }

  await moveResident(input.actorId, input.destinationPlaceId, db)
  const moved = await queryRows(db`
    WITH carry_request AS (
      SELECT ${input.carryThingId}::integer AS thing_id,
        ${input.actorId}::integer AS actor_id,
        ${input.placeId}::integer AS origin_place_id,
        ${input.destinationPlaceId}::integer AS destination_place_id,
        ${actionId}::bigint AS action_id
    ), carried AS (
      UPDATE things carrying SET place_id = carry_request.destination_place_id
      FROM carry_request
      WHERE carrying.id = carry_request.thing_id
        AND carrying.owner_id = carry_request.actor_id
        AND carrying.place_id = carry_request.origin_place_id
        AND carrying.withdrawn_at IS NULL AND carrying.active_offer_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM transfer_offers offer
          WHERE offer.asset_type = 'thing' AND offer.asset_id = carrying.id
            AND offer.status = 'open'
        )
        AND NOT EXISTS (
          SELECT 1 FROM thing_later_holder_marks mark
          WHERE mark.thing_id = carrying.id AND mark.resident_id <> carry_request.actor_id
        )
        AND COALESCE((
          SELECT moderation.action FROM moderation_actions moderation
          WHERE moderation.target_type = 'thing' AND moderation.target_id = carrying.id
          ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
        ), 'restore') <> 'remove'
      RETURNING carrying.id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'thing_moved', resident.handle, jsonb_build_object(
        'thing_id', carried.id,
        'action_id', carry_request.action_id,
        'resident_id', carry_request.actor_id,
        'mode', 'carry',
        'from_place_id', carry_request.origin_place_id,
        'place_id', carry_request.destination_place_id
      )
      FROM carried
      CROSS JOIN carry_request
      JOIN residents resident ON resident.id = carry_request.actor_id
    )
    SELECT id FROM carried
  `)
  if (!moved[0]) {
    throw new EngineError(
      409,
      'carry_thing_id, ownership, place, sale/lock, later-holder mark, or moderation hold changed before the move; re-read it',
    )
  }
}

async function intrinsicAction(
  input: RequiredActionInput,
  actionId: number,
  db: TaggedSql,
): Promise<IntrinsicActionOutcome> {
  if (input.primitiveHandledByCaller) return intrinsicActionOutcome(false, false)
  if (input.action === 'move') {
    await moveResidentWithCarry(input, actionId, db)
    return intrinsicActionOutcome(true, false)
  }
  if (input.action === 'give') {
    if ((input.sourceThingId === null && input.target === null) || input.recipientId === null) {
      throw new EngineError(400, 'give needs a source thing or target, plus a recipient')
    }
    // The transfer brick implementation owns the same guarded transfer path.
    const outcome = await executeEffectsWithOutcome([{
      effect: 'transfer',
      target: input.sourceThingId === null ? 'target' : 'source',
      to: 'recipient',
    }], actionContext(0, input), db)
    return intrinsicActionOutcome(true, outcome.emittedTypedPublicEvent)
  }
  return intrinsicActionOutcome(false, false)
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

/** Keep the action run, but erase every effect before a refused caller primitive is resolved. */
async function withCallerPrimitiveEffectsSavepoint<T>(
  transaction: TaggedSql,
  enabled: boolean,
  work: () => Promise<T>,
): Promise<T> {
  if (!enabled) return work()
  await queryRows(transaction`SAVEPOINT caller_primitive_effects`)
  try {
    const result = await work()
    await queryRows(transaction`RELEASE SAVEPOINT caller_primitive_effects`)
    return result
  } catch (error) {
    try {
      await queryRows(transaction`ROLLBACK TO SAVEPOINT caller_primitive_effects`)
      await queryRows(transaction`RELEASE SAVEPOINT caller_primitive_effects`)
    } catch {
      throw error
    }
    throw error
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
      throw new EngineError(
        403,
        `you must be standing in place_id ${input.placeId}; your current place_id is ${presence.currentPlaceId ?? 'unset'}`,
      )
    }
    input = { ...input, placeId: presence.currentPlaceId }
  }
  const actionId = await recordAction(input, db)
  try {
    return await withEngineTransaction(db, async transaction => {
      if (input.action === 'go_home') await ensurePresence(input.actorId, transaction)
      const lockedPresence = await lockPresence(input.actorId, transaction)
      if (input.action !== 'go_home') {
        if (lockedPresence.currentPlaceId !== input.placeId) {
          const message = lockedPresence.currentPlaceId === null
            ? 'your current place_id is now unset; check where you are standing before retrying'
            : `your current place_id changed to ${lockedPresence.currentPlaceId}; retry with place_id ${lockedPresence.currentPlaceId}`
          throw new EngineError(409, message)
        }
      }
      const block = await activeActionBlock(input.actorId, input.action, transaction)
      if (block) {
        const cause = activeBlockCause(input.action, block)
        await recordActionResolution(
          actionId,
          input.actorHandle,
          input.action,
          'blocked',
          cause.resolutionDetail,
          transaction,
        )
        return {
          actionId,
          status: 'blocked',
          httpStatus: 403,
          error: cause.callerError,
          effectsApplied: 0,
        }
      }
      if (input.action === 'go_home') {
        const home = await goHome(input.actorId, transaction)
        await recordActionResolution(
          actionId,
          input.actorHandle,
          input.action,
          'applied',
          {
            effects_applied: 0,
            from_place_id: lockedPresence.currentPlaceId,
            to_place_id: home.currentPlaceId,
          },
          transaction,
        )
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
      const actionOutcome = await withCallerPrimitiveEffectsSavepoint(
        transaction,
        input.primitiveHandledByCaller,
        async () => {
          const intrinsic = await intrinsicAction(input, actionId, transaction)
          const base = actionContext(actionId, input, sharedSourceThingId)
          let effectsApplied = 0
          let emittedTypedPublicEvent = intrinsic.emittedTypedPublicEvent
          for (const program of programs) {
            const outcome = await executeEffectsWithOutcome(program.effects, {
              ...base,
              sourceTraitId: program.sourceTraitId,
              sourceThingId: program.sourceThingId ?? base.sourceThingId,
              originThingId: program.sourceThingId,
              originPlaceId: program.lawSourcePlaceId,
              lawAuthority: program.lawSourcePlaceId === null || program.sourceTraitId === null
                ? null
                : {
                    traitId: program.sourceTraitId,
                    sourcePlaceId: program.lawSourcePlaceId,
                  },
            }, transaction)
            effectsApplied += outcome.effectsApplied
            emittedTypedPublicEvent ||= outcome.emittedTypedPublicEvent
          }
          if (input.primitiveHandledByCaller) {
            if (!input.performPrimitive) {
              throw new EngineError(500, 'caller primitive callback is missing, so the action cannot run; retry once, then contact the city operator')
            }
            await input.performPrimitive(transaction)
            emittedTypedPublicEvent ||= input.primitiveEmitsTypedEvent
          }
          if (!input.primitiveHandledByCaller && input.action === 'consume') {
            if (input.sourceThingId === null) {
              throw new EngineError(400, 'consume needs a source thing; send thing_id for one active thing')
            }
            await withdrawOwnedThing(
              input.sourceThingId,
              input.actorId,
              input.actorHandle,
              transaction,
            )
            emittedTypedPublicEvent = true
          }
          return {
            effectsApplied,
            emittedTypedPublicEvent,
            primitiveApplied: intrinsic.applied || input.primitiveHandledByCaller,
          }
        },
      )
      const { effectsApplied, emittedTypedPublicEvent, primitiveApplied } = actionOutcome
      const status: ResolutionStatus = effectsApplied === 0 && !primitiveApplied
        && input.action === 'use' ? 'noop' : 'applied'
      await recordActionResolution(
        actionId,
        input.actorHandle,
        input.action,
        status,
        {
          effects_applied: effectsApplied,
          ...(input.action === 'move'
            && input.placeId !== null
            && input.destinationPlaceId !== null
            ? {
                from_place_id: input.placeId,
                to_place_id: input.destinationPlaceId,
                ...(input.carryThingId === null
                  ? {}
                  : { thing_id: input.carryThingId, mode: 'carry' }),
              }
            : {}),
          ...(input.action === 'use' && input.sourceThingId !== null
            ? {
                place_id: lockedPresence.currentPlaceId,
                source_thing_id: input.sourceThingId,
              }
            : {}),
        },
        transaction,
        input.action === 'move' || !emittedTypedPublicEvent,
      )
      return { actionId, status, httpStatus: 200, error: null, effectsApplied }
    })
  } catch (error) {
    if (error instanceof CommitOutcomeUnknownError) {
      return resolveUncertainCommit(actionId, input.actorHandle, input.action, error, db)
    }
    return recordFailedExecution(actionId, input.actorHandle, input.action, error, db)
  }
}
