// Apply the idempotent city schema to DATABASE_URL.
// Usage: DATABASE_URL=... npm run migrate
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { neon } from '@neondatabase/serverless'
import {
  isSafeIdentifier,
  requireDirectPostgresUrl,
  requireLoopbackPostgresUrl,
  requiredIdentifier,
  responseJson,
  verifyNeonDatabaseTarget,
} from './database-target.ts'

type SqlMode = 'normal' | 'single-quote' | 'double-quote' | 'line-comment' | 'block-comment' | 'dollar-quote'
type MigrationTarget = 'local' | 'preview' | 'production'
type RemoteMigration =
  | 'hosted-chat-signin'
  | 'world-root-expand'
  | 'world-root-topology'
  | 'public-pagination'
  | 'agreement-accession'
  | 'open-to-use'

type MigrationFile =
  | 'db/schema.sql'
  | 'db/migrations/20260813_hosted_chat_signin.sql'
  | 'db/migrations/20260814_world_root_expand.sql'
  | 'db/migrations/20260814_world_root_topology.sql'
  | 'db/migrations/20260814_public_pagination.sql'
  | 'db/migrations/20260814_agreement_accession.sql'
  | 'db/migrations/20260815_open_to_use.sql'

type MigrationEnvironment = Readonly<Record<string, string | undefined>>

export type MigrationRun = Readonly<{
  target: MigrationTarget
  databaseUrl: string
  migrationFile: MigrationFile
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
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/
const REMOTE_MIGRATIONS: Readonly<Record<RemoteMigration, MigrationFile>> = {
  'hosted-chat-signin': 'db/migrations/20260813_hosted_chat_signin.sql',
  'world-root-expand': 'db/migrations/20260814_world_root_expand.sql',
  'world-root-topology': 'db/migrations/20260814_world_root_topology.sql',
  'public-pagination': 'db/migrations/20260814_public_pagination.sql',
  'agreement-accession': 'db/migrations/20260814_agreement_accession.sql',
  'open-to-use': 'db/migrations/20260815_open_to_use.sql',
}

function namedArgument(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const joined = args.find(argument => argument.startsWith(prefix))
  if (joined) return joined.slice(prefix.length)

  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

function remoteMigrationArgument(args: readonly string[]): RemoteMigration {
  const requested = namedArgument(args, 'migration')
  if (!requested || !(requested in REMOTE_MIGRATIONS)) {
    throw new Error(
      'remote migration requires --migration hosted-chat-signin|world-root-expand|world-root-topology|public-pagination|agreement-accession|open-to-use',
    )
  }
  return requested as RemoteMigration
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

export async function applyMigration(databaseUrl: string, ddl: string): Promise<number> {
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

  const sql = neon(databaseUrl)
  await sql.transaction(transaction =>
    runnableStatements.map(statement => transaction.query(statement)),
  )
  return statements.length
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
  const statementCount = await applyMigration(run.databaseUrl, ddl)
  console.log(`applied ${statementCount} statements from ${run.migrationFile} to ${run.target}`)
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'migration failed')
    process.exitCode = 1
  })
}
