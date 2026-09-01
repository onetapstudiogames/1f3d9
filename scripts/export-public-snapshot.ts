import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import {
  createSnapshotBundle,
  type PublicSnapshotRecord,
  type SnapshotBundle,
} from '../src/public-snapshot-format.ts'
import {
  configuredPublicDomain,
  publicOfficialFacts,
  publicPhysicsFacts,
} from '../src/public-reference-facts.ts'
import { withoutInheritedGitEnvironment } from './child-process-environment.ts'

const SNAPSHOT_ROLE = 'city_snapshot_export'
const SNAPSHOT_VIEW_COLUMNS = Object.freeze(['class_name', 'record_id', 'sort_key', 'payload'])
const SNAPSHOT_URL_NAME = 'SNAPSHOT_DATABASE_URL'
const LEGACY_FOUNDER_NOTE_BODY_EXCLUSIONS: Readonly<Record<string, Readonly<{
  createdAt: string
}>>> = Object.freeze({
  '56': Object.freeze({ createdAt: '2026-08-13T04:32:00.687149+00:00' }),
  '57': Object.freeze({ createdAt: '2026-08-13T04:36:04.669429+00:00' }),
})
const LEGACY_FOUNDER_NOTE_EXCLUSION_REASON = 'legacy resident key safety'

type SnapshotEnvironment = Readonly<Record<string, string | undefined>>

export interface SnapshotDatabaseClient {
  connect(): Promise<unknown>
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[] }>
  end(): Promise<void>
}

export function resolveSnapshotDatabaseUrl(environment: SnapshotEnvironment = process.env): string {
  const value = environment[SNAPSHOT_URL_NAME]?.trim()
  if (!value) throw new Error(`${SNAPSHOT_URL_NAME} is required; the exporter never uses DATABASE_URL`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${SNAPSHOT_URL_NAME} must be a PostgreSQL URL`)
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${SNAPSHOT_URL_NAME} must use postgres or postgresql`)
  }
  if (decodeURIComponent(url.username) !== SNAPSHOT_ROLE) {
    throw new Error(`${SNAPSHOT_URL_NAME} must use the dedicated ${SNAPSHOT_ROLE} account`)
  }
  if (!url.password || !url.hostname || !url.pathname || url.pathname === '/') {
    throw new Error(`${SNAPSHOT_URL_NAME} must include a password, host, and database`)
  }
  if (/(?:^|[.-])pooler(?:[.-]|$)/iu.test(url.hostname)) {
    throw new Error(`${SNAPSHOT_URL_NAME} must use a direct database endpoint, not a pooler`)
  }
  return value
}

function sourceCommitFromGit(): string {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: withoutInheritedGitEnvironment(),
    windowsHide: true,
  }).trim()
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('Git did not return a full lowercase source commit')
  return commit
}

function staticRecords(): readonly PublicSnapshotRecord[] {
  const domainConfiguration = configuredPublicDomain()
  const identityRecoveryEnabled = domainConfiguration.identityBrowserReady
    && process.env.IDENTITY_RECOVERY_ENABLED === 'true'
  const identityRotationEnabled = domainConfiguration.identityBrowserReady
    && process.env.IDENTITY_ROTATION_ENABLED === 'true'
  return Object.freeze([
    Object.freeze({
      class_name: 'official',
      record_id: 'official',
      sort_key: '0',
      payload: Object.freeze({
        id: 'official',
        status: 'exported',
        ...publicOfficialFacts({
          domain: domainConfiguration.domain,
          marketOrigin: process.env.MARKET_ORIGIN,
          identityBrowserReady: domainConfiguration.identityBrowserReady,
          identityRecoveryEnabled,
          identityRotationEnabled,
        }),
      }),
    }),
    Object.freeze({
      class_name: 'physics',
      record_id: 'physics',
      sort_key: '0',
      payload: Object.freeze({
        id: 'physics',
        status: 'exported',
        ...publicPhysicsFacts(),
      }),
    }),
  ])
}

const BEGIN_SNAPSHOT_SQL = `
  BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
  SET LOCAL TIME ZONE 'UTC';
  SET LOCAL statement_timeout = '60s';
  SET LOCAL lock_timeout = '5s';
  SET LOCAL idle_in_transaction_session_timeout = '90s';
`

const ATTEST_ROLE_SQL = `
  /* snapshot-export:attest-role */
  SELECT current_user,
    current_setting('transaction_read_only') AS transaction_read_only,
    has_table_privilege(current_user, 'city_snapshot.public_records_v2', 'SELECT') AS can_read_view,
    has_table_privilege(current_user, 'city_snapshot.public_records', 'SELECT') AS can_read_legacy_view,
    has_table_privilege(current_user, 'public.residents', 'SELECT') AS can_read_residents,
    has_table_privilege(current_user, 'public.residents', 'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write_residents,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege(current_user, relation.oid, 'SELECT')
    ) AS can_read_public_base,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege(current_user, relation.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
    ) AS can_write_public_base,
    EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'public.oauth_tokens', 'public.flags', 'public.payment_attempts',
        'public.city_credit_entries', 'public.thing_later_holder_marks',
        'public.resident_refusal_state'
      ]) AS private_table(name)
      WHERE has_table_privilege(current_user, private_table.name, 'SELECT')
    ) AS can_read_private,
    (
      SELECT array_agg(columns.column_name::TEXT ORDER BY columns.ordinal_position)
      FROM information_schema.columns columns
      WHERE columns.table_schema = 'city_snapshot'
        AND columns.table_name = 'public_records_v2'
    ) AS view_columns
`

const READ_RECORDS_SQL = `
  /* snapshot-export:records */
  SELECT records.class_name,
    records.record_id,
    records.sort_key::text AS sort_key,
    records.payload,
    to_char(
      transaction_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) AS exported_at
  FROM city_snapshot.public_records_v2 records
  ORDER BY records.class_name COLLATE "C", records.sort_key, records.record_id COLLATE "C"
`

function boolean(value: unknown): boolean {
  return value === true || value === 'true'
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : []
}

function attestRestrictedRole(rows: readonly Record<string, unknown>[]): void {
  const row = rows[0]
  if (!row || rows.length !== 1) throw new Error('snapshot role attestation was unavailable')
  const failures = [
    row.current_user !== SNAPSHOT_ROLE ? 'role' : null,
    row.transaction_read_only !== 'on' ? 'transaction-read-only' : null,
    !boolean(row.can_read_view) ? 'view-read' : null,
    boolean(row.can_read_residents) ? 'base-read' : null,
    boolean(row.can_write_residents) ? 'base-write' : null,
    boolean(row.can_read_public_base) ? 'any-base-read' : null,
    boolean(row.can_write_public_base) ? 'any-base-write' : null,
    boolean(row.can_read_private) ? 'private-read' : null,
    JSON.stringify(stringArray(row.view_columns)) !== JSON.stringify(SNAPSHOT_VIEW_COLUMNS)
      ? `view-columns(${stringArray(row.view_columns).join('|') || 'none'})`
      : null,
  ].filter((failure): failure is string => failure !== null)
  if (failures.length !== 0) {
    throw new Error(`snapshot account is not the exact restricted read-only role: ${failures.join(', ')}`)
  }
}

function approvedDatabasePayload(
  className: string,
  recordId: string,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const exclusion = className === 'notes'
    ? LEGACY_FOUNDER_NOTE_BODY_EXCLUSIONS[recordId]
    : undefined
  if (!exclusion) {
    return payload
  }
  const id = Number(recordId)
  if (
    payload.id !== id || payload.status !== 'exported' || payload.place_id !== 3 ||
    payload.author_id !== 1 || payload.author !== 'founder' ||
    payload.created_at !== exclusion.createdAt
  ) {
    throw new Error(`legacy founder note ${recordId} no longer matches its approved exclusion`)
  }
  return Object.freeze({
    id,
    status: 'body_not_exported',
    reason: LEGACY_FOUNDER_NOTE_EXCLUSION_REASON,
    place_id: payload.place_id,
    author_id: payload.author_id,
    author: payload.author,
    created_at: payload.created_at,
  })
}

function databaseRecords(rows: readonly Record<string, unknown>[]): Readonly<{
  exportedAt: string
  records: readonly PublicSnapshotRecord[]
}> {
  if (rows.length === 0) throw new Error('snapshot view returned no public records')
  const exportedAt = rows[0]?.exported_at
  if (typeof exportedAt !== 'string') throw new Error('snapshot view returned no frozen export time')
  const records = rows.map((row, index) => {
    if (
      typeof row.class_name !== 'string' ||
      typeof row.record_id !== 'string' ||
      typeof row.sort_key !== 'string' ||
      !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload) ||
      row.exported_at !== exportedAt
    ) throw new Error(`snapshot view returned an invalid row at position ${index}`)
    const className = row.class_name
    const recordId = row.record_id
    const payload = row.payload as Readonly<Record<string, unknown>>
    return Object.freeze({
      class_name: className,
      record_id: recordId,
      sort_key: row.sort_key,
      payload: approvedDatabasePayload(className, recordId, payload),
    })
  })
  return Object.freeze({ exportedAt, records: Object.freeze(records) })
}

export async function exportPublicSnapshot(input: Readonly<{
  outputDirectory: string
  databaseUrl: string
  sourceCommit?: string
  client?: SnapshotDatabaseClient
}>): Promise<SnapshotBundle> {
  const databaseUrl = resolveSnapshotDatabaseUrl({ SNAPSHOT_DATABASE_URL: input.databaseUrl })
  const client = input.client ?? new Client({
    connectionString: databaseUrl,
    application_name: '1f3d9-public-snapshot-export',
  })
  await client.connect()
  let transactionOpen = false
  try {
    await client.query(BEGIN_SNAPSHOT_SQL)
    transactionOpen = true
    const attestation = await client.query(ATTEST_ROLE_SQL)
    attestRestrictedRole(attestation.rows)
    const selected = databaseRecords((await client.query(READ_RECORDS_SQL)).rows)
    await client.query('COMMIT')
    transactionOpen = false
    return await createSnapshotBundle({
      outputDirectory: input.outputDirectory,
      exportedAt: selected.exportedAt,
      sourceCommit: input.sourceCommit ?? sourceCommitFromGit(),
      records: Object.freeze([...selected.records, ...staticRecords()]),
    })
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // The original fail-closed export error remains the useful cause.
      }
    }
    throw error
  } finally {
    await client.end()
  }
}

function option(arguments_: readonly string[], name: string): string | null {
  const index = arguments_.indexOf(`--${name}`)
  if (index === -1 || !arguments_[index + 1] || arguments_[index + 1]!.startsWith('--')) return null
  if (arguments_.filter(argument => argument === `--${name}`).length !== 1) {
    throw new Error(`--${name} must appear exactly once`)
  }
  return arguments_[index + 1]!
}

async function main(): Promise<void> {
  const outputDirectory = option(process.argv.slice(2), 'out')
  if (!outputDirectory || process.argv.length !== 4) {
    throw new Error('Usage: npm run snapshot:export -- --out <empty-directory>')
  }
  const result = await exportPublicSnapshot({
    outputDirectory,
    databaseUrl: resolveSnapshotDatabaseUrl(),
  })
  console.log(JSON.stringify({
    snapshot: result.tag,
    city_root_sha256: result.city_root_sha256,
    files: result.files.length,
    counts: result.counts,
  }))
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'public snapshot export failed')
    process.exitCode = 1
  })
}
