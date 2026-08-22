// Apply the idempotent city schema to DATABASE_URL.
// Usage: DATABASE_URL=... npm run migrate
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { neon } from '@neondatabase/serverless'
import { Client } from 'pg'
import {
  PUBLIC_SEARCH_EXTENSION_STATE_QUERY,
  PUBLIC_SEARCH_INDEX_NAMES,
  PUBLIC_SEARCH_INDEX_STATE_QUERY,
  publicSearchIndexRecoveryStatements,
} from './public-search-index-migration.ts'
import {
  isSafeIdentifier,
  requireDirectPostgresUrl,
  requireLoopbackPostgresUrl,
  requiredIdentifier,
  responseJson,
  verifyNeonDatabaseTarget,
} from './database-target.ts'

export { publicSearchIndexRecoveryStatements } from './public-search-index-migration.ts'

type SqlMode = 'normal' | 'single-quote' | 'double-quote' | 'line-comment' | 'block-comment' | 'dollar-quote'
type MigrationTarget = 'local' | 'preview' | 'production'
type RemoteMigration =
  | 'hosted-chat-signin'
  | 'world-root-expand'
  | 'world-root-topology'
  | 'public-pagination'
  | 'agreement-accession'
  | 'open-to-use'
  | 'payment-attempts'
  | 'payment-response-replay'
  | 'payment-response-body-replay'
  | 'payment-response-body-rollout'
  | 'payment-response-body-validate'
  | 'identity-recovery'
  | 'identity-rotation'
  | 'initial-recovery-codes'
  | 'signin-retention'
  | 'flag-limits'
  | 'affordable-reading-totals'
  | 'events-presence-index'
  | 'public-search-indexes'
  | 'public-change-markers'
  | 'thing-maker'
  | 'later-holder-marks'
  | 'city-credit'
  | 'payment-recovery'

export type MigrationFile =
  | 'db/schema.sql'
  | 'db/migrations/20260813_hosted_chat_signin.sql'
  | 'db/migrations/20260814_world_root_expand.sql'
  | 'db/migrations/20260814_world_root_topology.sql'
  | 'db/migrations/20260814_public_pagination.sql'
  | 'db/migrations/20260814_agreement_accession.sql'
  | 'db/migrations/20260815_open_to_use.sql'
  | 'db/migrations/20260816_payment_attempts.sql'
  | 'db/migrations/20260816_payment_response_replay.sql'
  | 'db/migrations/20260817_payment_response_body_replay.sql'
  | 'db/migrations/20260818_payment_response_body_rollout.sql'
  | 'db/migrations/20260818_payment_response_body_validate.sql'
  | 'db/migrations/20260816_identity_recovery.sql'
  | 'db/migrations/20260816_identity_rotation.sql'
  | 'db/migrations/20260817_initial_recovery_codes.sql'
  | 'db/migrations/20260818_signin_retention.sql'
  | 'db/migrations/20260818_flag_limits.sql'
  | 'db/migrations/20260820_affordable_reading_totals.sql'
  | 'db/migrations/20260821_events_presence_index.sql'
  | 'db/migrations/20260821_public_search_indexes.sql'
  | 'db/migrations/20260821_public_change_markers.sql'
  | 'db/migrations/20260822_thing_maker.sql'
  | 'db/migrations/20260822_later_holder_marks.sql'
  | 'db/migrations/20260822_city_credit.sql'
  | 'db/migrations/20260822_payment_recovery.sql'

export type MigrationExecutionMode = 'transactional' | 'nontransactional'

type MigrationEnvironment = Readonly<Record<string, string | undefined>>

export type MigrationRun = Readonly<{
  target: MigrationTarget
  databaseUrl: string
  migrationFile: MigrationFile
  executionMode: MigrationExecutionMode
  preview?: Readonly<{
    projectId: string
    branchId: string
    productionBranchId: string
  }>
  snapshot?: Readonly<{
    projectId: string
    branchId: string
    name: string
  }>
}>

const PRODUCTION_ACKNOWLEDGEMENT = 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION'
const PREVIEW_ACKNOWLEDGEMENT = 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW'
const LOCAL_ACKNOWLEDGEMENT = 'APPLY_FULL_SCHEMA_TO_LOOPBACK_DATABASE'
const WORLD_ROOT_TOPOLOGY_ACKNOWLEDGEMENT = 'REPARENT_CONTINENTS_UNDER_UNOWNED_WORLD_ROOT'
const CITY_CREDIT_ACKNOWLEDGEMENT = 'INSTALL_PRIVATE_CITY_CREDIT_LEDGER'
const CITY_CREDIT = Object.freeze({ 'city-credit': '20260822_city_credit.sql' } as const)
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/
const REMOTE_MIGRATIONS: Readonly<Record<RemoteMigration, MigrationFile>> = {
  'hosted-chat-signin': 'db/migrations/20260813_hosted_chat_signin.sql',
  'world-root-expand': 'db/migrations/20260814_world_root_expand.sql',
  'world-root-topology': 'db/migrations/20260814_world_root_topology.sql',
  'public-pagination': 'db/migrations/20260814_public_pagination.sql',
  'agreement-accession': 'db/migrations/20260814_agreement_accession.sql',
  'open-to-use': 'db/migrations/20260815_open_to_use.sql',
  'payment-attempts': 'db/migrations/20260816_payment_attempts.sql',
  'payment-response-replay': 'db/migrations/20260816_payment_response_replay.sql',
  'payment-response-body-replay': 'db/migrations/20260817_payment_response_body_replay.sql',
  'payment-response-body-rollout': 'db/migrations/20260818_payment_response_body_rollout.sql',
  'payment-response-body-validate': 'db/migrations/20260818_payment_response_body_validate.sql',
  'identity-recovery': 'db/migrations/20260816_identity_recovery.sql',
  'identity-rotation': 'db/migrations/20260816_identity_rotation.sql',
  'initial-recovery-codes': 'db/migrations/20260817_initial_recovery_codes.sql',
  'signin-retention': 'db/migrations/20260818_signin_retention.sql',
  'flag-limits': 'db/migrations/20260818_flag_limits.sql',
  'affordable-reading-totals': 'db/migrations/20260820_affordable_reading_totals.sql',
  'events-presence-index': 'db/migrations/20260821_events_presence_index.sql',
  'public-search-indexes': 'db/migrations/20260821_public_search_indexes.sql',
  'public-change-markers': 'db/migrations/20260821_public_change_markers.sql',
  'thing-maker': 'db/migrations/20260822_thing_maker.sql',
  'later-holder-marks': 'db/migrations/20260822_later_holder_marks.sql',
  'city-credit': `db/migrations/${CITY_CREDIT['city-credit']}`,
  'payment-recovery': 'db/migrations/20260822_payment_recovery.sql',
}
const EVENTS_PRESENCE_INDEX_MIGRATION_FILE: MigrationFile =
  'db/migrations/20260821_events_presence_index.sql'
const PUBLIC_SEARCH_INDEX_MIGRATION_FILE: MigrationFile =
  'db/migrations/20260821_public_search_indexes.sql'
const NONTRANSACTIONAL_MIGRATION_FILES = new Set<MigrationFile>([
  EVENTS_PRESENCE_INDEX_MIGRATION_FILE,
  PUBLIC_SEARCH_INDEX_MIGRATION_FILE,
])

function namedArgument(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const joined = args.find(argument => argument.startsWith(prefix))
  if (joined) return joined.slice(prefix.length)

  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

function remoteMigrationArgument(args: readonly string[]): RemoteMigration {
  const requested = namedArgument(args, 'migration')
  if (!requested || !Object.hasOwn(REMOTE_MIGRATIONS, requested)) {
    throw new Error(
      `remote migration requires --migration ${Object.keys(REMOTE_MIGRATIONS).join('|')}`,
    )
  }
  return requested as RemoteMigration
}

function migrationExecutionMode(migrationFile: MigrationFile): MigrationExecutionMode {
  return NONTRANSACTIONAL_MIGRATION_FILES.has(migrationFile)
    ? 'nontransactional'
    : 'transactional'
}

/**
 * Select a migration connection without ever inferring preview or production.
 * Remote targets require exact operator acknowledgement and authoritative Neon target
 * details; production additionally requires a real snapshot configuration. Connection
 * values are returned to the caller, never logged.
 */
export function resolveMigrationRun(
  args: readonly string[],
  environment: MigrationEnvironment,
): MigrationRun {
  const requestedTarget = namedArgument(args, 'target')
  if (!['local', 'preview', 'production'].includes(requestedTarget ?? '')) {
    throw new Error('migration requires --target local|preview|production')
  }

  const target = requestedTarget as MigrationTarget
  if (target === 'local') {
    if (namedArgument(args, 'migration')) {
      throw new Error('local migration always applies db/schema.sql and does not accept --migration')
    }
    if (environment.CONFIRM_LOCAL_SCHEMA !== LOCAL_ACKNOWLEDGEMENT) {
      throw new Error(`local migration requires CONFIRM_LOCAL_SCHEMA=${LOCAL_ACKNOWLEDGEMENT}`)
    }
    return {
      target,
      databaseUrl: requireLoopbackPostgresUrl(
        requireDirectPostgresUrl(
          environment.LOCAL_DATABASE_URL_UNPOOLED,
          'LOCAL_DATABASE_URL_UNPOOLED',
        ),
      ),
      migrationFile: 'db/schema.sql',
      executionMode: 'transactional',
    }
  }

  const migration = remoteMigrationArgument(args)
  const migrationFile = REMOTE_MIGRATIONS[migration]
  if (
    migration === 'world-root-topology' &&
    environment.CONFIRM_WORLD_ROOT_TOPOLOGY !== WORLD_ROOT_TOPOLOGY_ACKNOWLEDGEMENT
  ) {
    throw new Error(
      `world-root topology requires CONFIRM_WORLD_ROOT_TOPOLOGY=${WORLD_ROOT_TOPOLOGY_ACKNOWLEDGEMENT}`,
    )
  }
  if (
    migration === 'city-credit' &&
    environment.CONFIRM_CITY_CREDIT !== CITY_CREDIT_ACKNOWLEDGEMENT
  ) {
    throw new Error(
      `city credit requires CONFIRM_CITY_CREDIT=${CITY_CREDIT_ACKNOWLEDGEMENT}`,
    )
  }

  if (target === 'preview') {
    if (environment.CONFIRM_PREVIEW_MIGRATION !== PREVIEW_ACKNOWLEDGEMENT) {
      throw new Error(
        `preview migration requires CONFIRM_PREVIEW_MIGRATION=${PREVIEW_ACKNOWLEDGEMENT}`,
      )
    }
    if (!environment.NEON_API_KEY?.trim()) throw new Error('preview migration requires NEON_API_KEY')
    const projectId = requiredIdentifier(environment.NEON_PROJECT_ID, 'NEON_PROJECT_ID')
    const branchId = requiredIdentifier(
      environment.NEON_PREVIEW_BRANCH_ID,
      'NEON_PREVIEW_BRANCH_ID',
    )
    const productionBranchId = requiredIdentifier(
      environment.NEON_PRODUCTION_BRANCH_ID,
      'NEON_PRODUCTION_BRANCH_ID',
    )
    if (branchId === productionBranchId) {
      throw new Error('preview branch must not be the production branch')
    }
    return {
      target,
      databaseUrl: requireDirectPostgresUrl(
        environment.PREVIEW_DATABASE_URL_UNPOOLED,
        'PREVIEW_DATABASE_URL_UNPOOLED',
      ),
      migrationFile,
      executionMode: migrationExecutionMode(migrationFile),
      preview: { projectId, branchId, productionBranchId },
    }
  }

  if (environment.CONFIRM_PRODUCTION_MIGRATION !== PRODUCTION_ACKNOWLEDGEMENT) {
    throw new Error(
      `production migration requires CONFIRM_PRODUCTION_MIGRATION=${PRODUCTION_ACKNOWLEDGEMENT}`,
    )
  }
  if (!environment.NEON_API_KEY?.trim()) throw new Error('production migration requires NEON_API_KEY')
  const snapshotName = environment.PRODUCTION_SNAPSHOT_NAME?.trim() ?? ''
  if (!SNAPSHOT_NAME.test(snapshotName)) {
    throw new Error('production migration requires a safe PRODUCTION_SNAPSHOT_NAME')
  }

  return {
    target,
    databaseUrl: requireDirectPostgresUrl(
      environment.PRODUCTION_DATABASE_URL_UNPOOLED,
      'PRODUCTION_DATABASE_URL_UNPOOLED',
    ),
    migrationFile,
    executionMode: migrationExecutionMode(migrationFile),
    snapshot: {
      projectId: requiredIdentifier(environment.NEON_PROJECT_ID, 'NEON_PROJECT_ID'),
      branchId: requiredIdentifier(environment.NEON_PRODUCTION_BRANCH_ID, 'NEON_PRODUCTION_BRANCH_ID'),
      name: snapshotName,
    },
  }
}

type SnapshotResponse = Readonly<{
  snapshot?: Readonly<{
    id?: unknown
    name?: unknown
    source_branch_id?: unknown
  }>
  operations?: readonly Readonly<{ id?: unknown; status?: unknown }>[]
}>

/**
 * Prove that the preview URL belongs to the exact isolated read-write Neon branch.
 * This read-only API check finishes before a database client is created.
 */
export async function verifyPreviewDatabaseTarget(
  preview: NonNullable<MigrationRun['preview']>,
  databaseUrl: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (preview.branchId === preview.productionBranchId) {
    throw new Error('preview branch must not be the production branch')
  }
  await verifyNeonDatabaseTarget(preview, databaseUrl, apiKey, 'preview', fetcher)
}

/**
 * Prove that the production connection points at the read-write compute returned
 * by Neon's project-and-branch-scoped endpoint API. No database connection or
 * mutating Neon request is made until this check succeeds.
 */
export async function verifyProductionDatabaseTarget(
  snapshot: NonNullable<MigrationRun['snapshot']>,
  databaseUrl: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await verifyNeonDatabaseTarget(snapshot, databaseUrl, apiKey, 'production', fetcher)
}

/** Create and verify a real Neon snapshot immediately before production DDL. */
export async function createProductionSnapshot(
  snapshot: NonNullable<MigrationRun['snapshot']>,
  apiKey: string,
  fetcher: typeof fetch = fetch,
  pause: (milliseconds: number) => Promise<void> = milliseconds =>
    new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<string> {
  const base = `https://console.neon.tech/api/v2/projects/${snapshot.projectId}`
  const url = new URL(`${base}/branches/${snapshot.branchId}/snapshot`)
  url.searchParams.set('name', snapshot.name)
  const created = await responseJson(await fetcher(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
  }), 'Neon snapshot creation') as SnapshotResponse
  const record = created.snapshot
  if (
    !record || !isSafeIdentifier(record.id) ||
    record.name !== snapshot.name || record.source_branch_id !== snapshot.branchId
  ) {
    throw new Error('Neon did not confirm the requested production snapshot')
  }

  await Promise.all((created.operations ?? []).map(async operation => {
    if (typeof operation.id !== 'string' || !operation.id) {
      throw new Error('Neon snapshot creation returned an invalid operation')
    }
    if (operation.status === 'finished') return
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (attempt > 0) await pause(1_000)
      const status = await responseJson(await fetcher(
        `${base}/operations/${encodeURIComponent(operation.id)}`,
        {
          method: 'GET',
          redirect: 'error',
          headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        },
      ), 'Neon snapshot operation') as { operation?: { status?: unknown } }
      const current = status.operation?.status
      if (current === 'finished') return
      if (['failed', 'cancelled', 'skipped'].includes(String(current))) {
        throw new Error(`Neon snapshot operation ended as ${String(current)}`)
      }
    }
    throw new Error('Neon snapshot did not become ready in 30 seconds')
  }))
  return record.id
}

/** Verify the database target first, then create the production restore point. */
export async function prepareProductionMigration(
  snapshot: NonNullable<MigrationRun['snapshot']>,
  databaseUrl: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
  pause: (milliseconds: number) => Promise<void> = milliseconds =>
    new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<string> {
  await verifyProductionDatabaseTarget(snapshot, databaseUrl, apiKey, fetcher)
  return createProductionSnapshot(snapshot, apiKey, fetcher, pause)
}

function dollarDelimiterAt(sql: string, offset: number): string | null {
  const match = sql.slice(offset).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)
  return match?.[0] ?? null
}

/**
 * Split trusted migration SQL without treating semicolons inside strings,
 * comments, identifiers, or PostgreSQL dollar-quoted bodies as boundaries.
 */
export function splitSqlStatements(ddl: string): string[] {
  const statements: string[] = []
  let statement = ''
  let mode: SqlMode = 'normal'
  let blockCommentDepth = 0
  let dollarDelimiter = ''

  const finishStatement = () => {
    const trimmed = statement.trim()
    if (trimmed) statements.push(trimmed)
    statement = ''
  }

  for (let index = 0; index < ddl.length; index += 1) {
    const character = ddl[index]!
    const next = ddl[index + 1]

    if (mode === 'normal') {
      if (character === '-' && next === '-') {
        statement += '--'
        index += 1
        mode = 'line-comment'
      } else if (character === '/' && next === '*') {
        statement += '/*'
        index += 1
        blockCommentDepth = 1
        mode = 'block-comment'
      } else if (character === "'") {
        statement += character
        mode = 'single-quote'
      } else if (character === '"') {
        statement += character
        mode = 'double-quote'
      } else if (character === '$') {
        const delimiter = dollarDelimiterAt(ddl, index)
        if (delimiter) {
          statement += delimiter
          index += delimiter.length - 1
          dollarDelimiter = delimiter
          mode = 'dollar-quote'
        } else {
          statement += character
        }
      } else if (character === ';') {
        finishStatement()
      } else {
        statement += character
      }
      continue
    }

    if (mode === 'line-comment') {
      statement += character
      if (character === '\n') mode = 'normal'
      continue
    }

    if (mode === 'block-comment') {
      if (character === '/' && next === '*') {
        statement += '/*'
        index += 1
        blockCommentDepth += 1
      } else if (character === '*' && next === '/') {
        statement += '*/'
        index += 1
        blockCommentDepth -= 1
        if (blockCommentDepth === 0) mode = 'normal'
      } else {
        statement += character
      }
      continue
    }

    if (mode === 'dollar-quote') {
      if (ddl.startsWith(dollarDelimiter, index)) {
        statement += dollarDelimiter
        index += dollarDelimiter.length - 1
        dollarDelimiter = ''
        mode = 'normal'
      } else {
        statement += character
      }
      continue
    }

    statement += character
    if (mode === 'single-quote' && character === "'") {
      if (next === "'") {
        statement += next
        index += 1
      } else {
        mode = 'normal'
      }
    } else if (mode === 'double-quote' && character === '"') {
      if (next === '"') {
        statement += next
        index += 1
      } else {
        mode = 'normal'
      }
    }
  }

  if (mode === 'single-quote') throw new Error('migration SQL has an unterminated single-quoted string')
  if (mode === 'double-quote') throw new Error('migration SQL has an unterminated quoted identifier')
  if (mode === 'block-comment') throw new Error('migration SQL has an unterminated block comment')
  if (mode === 'dollar-quote') throw new Error(`migration SQL has an unterminated ${dollarDelimiter} block`)

  finishStatement()
  return statements
}

export const MIGRATION_LOCK_TIMEOUT = '5s'
export const MIGRATION_STATEMENT_TIMEOUT = '120s'

/**
 * Every transactional migration statement runs inside one transaction whose first commands
 * enforce short lock and statement time limits, so a bad deploy can neither
 * wait on nor hold a live lock indefinitely. A migration that needs different
 * limits sets its own SET LOCAL afterwards, which wins for the rest of its
 * transaction. A timeout aborts the whole transaction, so nothing partial
 * ever commits.
 */
export function prepareMigrationStatements(ddl: string): string[] {
  const statements = splitSqlStatements(ddl)
  if (statements.length === 0) throw new Error('migration contains no SQL statements')

  const beginsTransaction = /^BEGIN(?:\s+(?:WORK|TRANSACTION))?$/i.test(statements[0]!)
  const commitsTransaction = /^COMMIT(?:\s+(?:WORK|TRANSACTION))?$/i.test(statements.at(-1)!)
  if (beginsTransaction !== commitsTransaction) {
    throw new Error('migration transaction boundary is incomplete')
  }

  const runnableStatements = beginsTransaction ? statements.slice(1, -1) : statements
  if (runnableStatements.length === 0) throw new Error('migration contains no SQL statements')
  if (runnableStatements.some(statement =>
    /^(?:BEGIN|COMMIT|ROLLBACK)(?:\s+(?:WORK|TRANSACTION))?$/i.test(statement)
  )) {
    throw new Error('migration contains an unexpected transaction boundary')
  }
  if (runnableStatements.some(statement =>
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(statement)
  )) {
    throw new Error('concurrent index requires an explicitly allowlisted nontransactional migration')
  }

  return [
    `SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`,
    `SET LOCAL statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`,
    ...runnableStatements,
  ]
}

export type PreparedMigrationExecution = Readonly<{
  mode: MigrationExecutionMode
  sessionStatements: readonly string[]
  statements: readonly string[]
}>

export const EVENTS_PRESENCE_INDEX_STATE_QUERY = `
  SELECT index_namespace.nspname AS index_schema,
    index_relation.relname AS index_name,
    table_namespace.nspname AS table_schema,
    table_relation.relname AS table_name,
    index_catalog.indisvalid AS valid,
    index_catalog.indisready AS ready,
    index_catalog.indisunique AS unique_index,
    access_method.amname AS access_method,
    index_catalog.indnkeyatts::integer AS key_column_count,
    index_catalog.indnatts::integer AS total_column_count,
    index_catalog.indoption::smallint[] AS options,
    index_catalog.indpred IS NULL AS unfiltered,
    ARRAY(
      SELECT pg_get_indexdef(index_relation.oid, position, true)
      FROM generate_series(1, index_catalog.indnatts) AS position
      ORDER BY position
    ) AS columns
  FROM pg_class AS index_relation
  JOIN pg_namespace AS index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  LEFT JOIN pg_index AS index_catalog
    ON index_catalog.indexrelid = index_relation.oid
  LEFT JOIN pg_am AS access_method
    ON access_method.oid = index_relation.relam
  LEFT JOIN pg_class AS table_relation
    ON table_relation.oid = index_catalog.indrelid
  LEFT JOIN pg_namespace AS table_namespace
    ON table_namespace.oid = table_relation.relnamespace
  WHERE index_namespace.nspname = 'public'
    AND index_relation.relname = 'events_actor_at_desc'
`

function exactEventsPresenceIndex(row: Readonly<Record<string, unknown>>): boolean {
  const columns = row.columns
  return row.index_schema === 'public' &&
    row.index_name === 'events_actor_at_desc' &&
    row.table_schema === 'public' &&
    row.table_name === 'events' &&
    row.unique_index === false &&
    row.access_method === 'btree' &&
    row.key_column_count === 2 &&
    row.total_column_count === 2 &&
    Array.isArray(row.options) &&
    row.options.length === 2 &&
    row.options[0] === 0 &&
    row.options[1] === 3 &&
    row.unfiltered === true &&
    Array.isArray(columns) &&
    columns.length === 2 &&
    columns[0] === 'actor' &&
    columns[1] === 'at' &&
    typeof row.valid === 'boolean' &&
    typeof row.ready === 'boolean'
}

/**
 * Keep an exact valid index untouched. A failed concurrent build is safe to
 * remove and retry; a same-named relation with any other definition fails closed.
 */
export function eventsPresenceIndexRecoveryStatements(
  rows: readonly Readonly<Record<string, unknown>>[],
  createStatement: string,
): readonly string[] {
  if (rows.length === 0) return Object.freeze([createStatement])
  if (rows.length !== 1 || !exactEventsPresenceIndex(rows[0]!)) {
    throw new Error('events_actor_at_desc conflicts with the reviewed definition')
  }
  if (rows[0]!.valid === true && rows[0]!.ready === true) return Object.freeze([])
  return Object.freeze([
    'DROP INDEX CONCURRENTLY IF EXISTS public.events_actor_at_desc',
    createStatement,
  ])
}

function normalizedExecutableStatement(statement: string): string {
  return statement
    .replace(/^\s*--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Select transaction semantics by the exact reviewed migration filename.
 * No SQL content or caller flag can opt another migration out of atomic execution.
 */
export function prepareMigrationExecution(
  migrationFile: MigrationFile,
  ddl: string,
): PreparedMigrationExecution {
  if (!NONTRANSACTIONAL_MIGRATION_FILES.has(migrationFile)) {
    return Object.freeze({
      mode: 'transactional',
      sessionStatements: Object.freeze([]),
      statements: Object.freeze(prepareMigrationStatements(ddl)),
    })
  }

  const statements = splitSqlStatements(ddl)
  const executableStatements = statements
    .map(normalizedExecutableStatement)
    .filter(Boolean)
  if (migrationFile === EVENTS_PRESENCE_INDEX_MIGRATION_FILE) {
    const expected =
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS events_actor_at_desc ON public.events (actor, at DESC)'
    if (executableStatements.length !== 1 || executableStatements[0] !== expected) {
      throw new Error('events presence index migration does not match the reviewed concurrent-index statement')
    }
  } else {
    const expected = [
      'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public',
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS notes_public_search_words ON public.notes USING GIN (to_tsvector('simple', body))",
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS notes_public_search_phrase ON public.notes USING GIN (lower(body) public.gin_trgm_ops)',
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS things_public_search_words_active ON public.things USING GIN (to_tsvector('simple', name || ' ' || body)) WHERE withdrawn_at IS NULL",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS things_public_search_phrase_active ON public.things USING GIN (lower(name || ' ' || body) public.gin_trgm_ops) WHERE withdrawn_at IS NULL",
    ]
    if (
      executableStatements.length !== expected.length ||
      executableStatements.some((statement, index) => statement !== expected[index])
    ) {
      throw new Error('public search index migration does not match the reviewed extension and concurrent-index statements')
    }
  }

  return Object.freeze({
    mode: 'nontransactional',
    sessionStatements: Object.freeze([
      `SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`,
      `SET statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`,
    ]),
    statements: Object.freeze([...statements]),
  })
}

async function applyEventsPresenceIndexMigration(
  client: Client,
  createStatement: string,
): Promise<number> {
  const before = await client.query(EVENTS_PRESENCE_INDEX_STATE_QUERY)
  const recoveryStatements = eventsPresenceIndexRecoveryStatements(
    before.rows as readonly Record<string, unknown>[],
    createStatement,
  )
  for (const statement of recoveryStatements) await client.query(statement)

  const after = await client.query(EVENTS_PRESENCE_INDEX_STATE_QUERY)
  if (eventsPresenceIndexRecoveryStatements(
    after.rows as readonly Record<string, unknown>[],
    createStatement,
  ).length !== 0) {
    throw new Error('events_actor_at_desc did not become valid and ready')
  }
  return recoveryStatements.length
}

async function applyPublicSearchIndexMigration(
  client: Client,
  statements: readonly string[],
): Promise<number> {
  const extensionStatement = statements[0]!
  const createStatements = statements.slice(1)
  await client.query(extensionStatement)
  const extension = await client.query(PUBLIC_SEARCH_EXTENSION_STATE_QUERY)
  if (
    extension.rows.length !== 1 ||
    extension.rows[0]?.extension_schema !== 'public'
  ) {
    throw new Error('pg_trgm must be installed in the public schema')
  }

  const before = await client.query(PUBLIC_SEARCH_INDEX_STATE_QUERY, [PUBLIC_SEARCH_INDEX_NAMES])
  const recoveryStatements = publicSearchIndexRecoveryStatements(
    before.rows as readonly Record<string, unknown>[],
    createStatements,
  )
  for (const statement of recoveryStatements) await client.query(statement)

  const after = await client.query(PUBLIC_SEARCH_INDEX_STATE_QUERY, [PUBLIC_SEARCH_INDEX_NAMES])
  if (publicSearchIndexRecoveryStatements(
    after.rows as readonly Record<string, unknown>[],
    createStatements,
  ).length !== 0) {
    throw new Error('public search indexes did not all become valid and ready')
  }
  return 1 + recoveryStatements.length
}

export async function applyMigration(
  databaseUrl: string,
  migrationFile: MigrationFile,
  ddl: string,
): Promise<number> {
  const execution = prepareMigrationExecution(migrationFile, ddl)
  if (execution.mode === 'nontransactional') {
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      for (const statement of execution.sessionStatements) {
        await client.query(statement)
      }
      return migrationFile === EVENTS_PRESENCE_INDEX_MIGRATION_FILE
        ? await applyEventsPresenceIndexMigration(client, execution.statements[0]!)
        : await applyPublicSearchIndexMigration(client, execution.statements)
    } finally {
      await client.end()
    }
  }

  const sql = neon(databaseUrl)
  await sql.transaction(transaction =>
    execution.statements.map(statement => transaction.query(statement)),
  )
  return execution.statements.length
}

async function main(): Promise<void> {
  const run = resolveMigrationRun(process.argv.slice(2), process.env)

  if (run.target === 'preview') {
    await verifyPreviewDatabaseTarget(
      run.preview!,
      run.databaseUrl,
      process.env.NEON_API_KEY!,
    )
    console.log('verified isolated preview database target')
  } else if (run.target === 'production') {
    const snapshotId = await prepareProductionMigration(
      run.snapshot!,
      run.databaseUrl,
      process.env.NEON_API_KEY!,
    )
    console.log(`verified production snapshot ${snapshotId}`)
  }

  const ddl = readFileSync(new URL(`../${run.migrationFile}`, import.meta.url), 'utf8')
  const statementCount = await applyMigration(run.databaseUrl, run.migrationFile, ddl)
  console.log(`applied ${statementCount} statements from ${run.migrationFile} to ${run.target}`)
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'migration failed')
    process.exitCode = 1
  })
}
