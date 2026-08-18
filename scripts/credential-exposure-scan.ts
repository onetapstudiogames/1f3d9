// Read-only, ID-only scan for credential-shaped text in public city records.
// Usage: node --experimental-strip-types scripts/credential-exposure-scan.ts --target local --database city
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import {
  PUBLIC_CREDENTIAL_PATTERN_SOURCE,
  extractResidentCredentials,
  containsPublicCredential,
  type ResidentCredentialKind,
} from '../src/credential-safety.ts'
import {
  describeDatabaseUrl,
  requireDatabaseName,
  requireLoopbackPostgresUrl,
  requiredIdentifier,
  verifyNeonDatabaseTarget,
  type DatabaseIdentity,
  type DatabaseTargetMode,
} from './database-target.ts'

export const LOCAL_SCAN_ACKNOWLEDGEMENT = 'SCAN_1F3D9_LOCAL_PUBLIC_CREDENTIAL_EXPOSURE'
export const PREVIEW_SCAN_ACKNOWLEDGEMENT = 'SCAN_1F3D9_PREVIEW_PUBLIC_CREDENTIAL_EXPOSURE'
export const PRODUCTION_SCAN_ACKNOWLEDGEMENT = 'SCAN_1F3D9_PRODUCTION_PUBLIC_CREDENTIAL_EXPOSURE'

const ACKNOWLEDGEMENTS: Readonly<Record<DatabaseTargetMode, string>> = Object.freeze({
  local: LOCAL_SCAN_ACKNOWLEDGEMENT,
  preview: PREVIEW_SCAN_ACKNOWLEDGEMENT,
  production: PRODUCTION_SCAN_ACKNOWLEDGEMENT,
})

type ScanEnvironment = Readonly<Record<string, string | undefined>>

export interface CredentialScanClient {
  connect(): Promise<unknown>
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[] }>
  end(): Promise<void>
}

export type CredentialScanOptions = Readonly<{
  target: DatabaseTargetMode
  expectedDatabase: string
}>

type ScanTarget = Readonly<{
  mode: DatabaseTargetMode
  identity: DatabaseIdentity
  projectId?: string
  branchId?: string
}>

export type CredentialExposureScanResult = Readonly<{
  schema_version: 1
  target: Readonly<{
    mode: DatabaseTargetMode
    database: string
    endpoint_fingerprint: string
    project_id?: string
    branch_id?: string
  }>
  associated_resident_ids: readonly number[]
  credential_owner_resident_ids: readonly number[]
  live_credential_owner_resident_ids: readonly number[]
  counts: Readonly<{
    public_fields: number
    exact_credentials: number
    partial_shapes: number
    live_credentials: number
    inactive_credentials: number
    unresolved_credentials: number
    resident_key: number
    oauth_access_token: number
    oauth_refresh_token: number
    oauth_authorization_code: number
    recovery_code: number
  }>
}>

type ExposureRow = Readonly<{
  associated_resident_id: number | null
  content: string
}>

type IdentityRow = Readonly<{
  credential_hash: string
  credential_kind: ResidentCredentialKind
  resident_id: number
  live: boolean
}>

export const PUBLIC_EXPOSURE_SQL = `
  /* public_credential_exposures */
  SELECT id::bigint AS row_id, id AS associated_resident_id, model AS content
  FROM public.residents WHERE model ~* $1
  UNION ALL
  SELECT id::bigint, owner_id, name FROM public.places WHERE name ~* $1
  UNION ALL
  SELECT id::bigint, owner_id, description FROM public.places WHERE description ~* $1
  UNION ALL
  SELECT id::bigint, coiner_id, name FROM public.traits WHERE name ~* $1
  UNION ALL
  SELECT id::bigint, coiner_id, description FROM public.traits WHERE description ~* $1
  UNION ALL
  SELECT id::bigint, coiner_id, recipe::text FROM public.traits
    WHERE recipe IS NOT NULL AND recipe::text ~* $1
  UNION ALL
  SELECT id::bigint, owner_id, name FROM public.kinds WHERE name ~* $1
  UNION ALL
  SELECT revision.kind_id::bigint, kind.owner_id, revision.description
  FROM public.kind_revisions revision
  JOIN public.kinds kind ON kind.id = revision.kind_id
  WHERE revision.description ~* $1
  UNION ALL
  SELECT revision.kind_id::bigint, kind.owner_id, array_to_string(revision.traits, ' ')
  FROM public.kind_revisions revision
  JOIN public.kinds kind ON kind.id = revision.kind_id
  WHERE array_to_string(revision.traits, ' ') ~* $1
  UNION ALL
  SELECT revision.kind_id::bigint, kind.owner_id, revision.recipe::text
  FROM public.kind_revisions revision
  JOIN public.kinds kind ON kind.id = revision.kind_id
  WHERE revision.recipe::text ~* $1
  UNION ALL
  SELECT id::bigint, owner_id, name FROM public.things WHERE name ~* $1
  UNION ALL
  SELECT id::bigint, owner_id, body FROM public.things WHERE body ~* $1
  UNION ALL
  SELECT id::bigint, author_id, body FROM public.notes WHERE body ~* $1
  UNION ALL
  SELECT id::bigint, created_by_id, body FROM public.agreements WHERE body ~* $1
  UNION ALL
  SELECT id::bigint, actor_id, label FROM public.active_labels WHERE label ~* $1
  UNION ALL
  SELECT id::bigint, actor_id, reason FROM public.moderation_actions WHERE reason ~* $1
  UNION ALL
  SELECT event.id::bigint, resident.id, event.detail::text
  FROM public.events event
  LEFT JOIN public.residents resident ON resident.handle = event.actor
  WHERE event.detail::text ~* $1
`

const IDENTITY_MATCH_SQL = `
  /* credential_identity_matches */
  SELECT secret_hash AS credential_hash, 'resident_key'::text AS credential_kind,
    id AS resident_id, true AS live
  FROM public.residents WHERE secret_hash = ANY($1::text[])
  UNION ALL
  SELECT code.code_hash, 'oauth_authorization_code'::text, code.resident_id,
    (code.used_at IS NULL AND code.expires_at > statement_timestamp()) AS live
  FROM public.oauth_authorization_codes code WHERE code.code_hash = ANY($1::text[])
  UNION ALL
  SELECT token.token_hash,
    CASE token.token_type
      WHEN 'access' THEN 'oauth_access_token'::text
      ELSE 'oauth_refresh_token'::text
    END,
    family.resident_id,
    (token.used_at IS NULL AND token.revoked_at IS NULL
      AND token.expires_at > statement_timestamp()
      AND family.revoked_at IS NULL AND family.expires_at > statement_timestamp()) AS live
  FROM public.oauth_tokens token
  JOIN public.oauth_token_families family ON family.id = token.family_id
  WHERE token.token_hash = ANY($1::text[])
  UNION ALL
  SELECT code.code_hash, 'recovery_code'::text, code.resident_id,
    (code.used_at IS NULL AND code.invalidated_at IS NULL) AS live
  FROM public.resident_recovery_codes code WHERE code.code_hash = ANY($1::text[])
`

function argumentValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
  return value
}

export function parseCredentialScanArgs(args: readonly string[]): CredentialScanOptions {
  let target: DatabaseTargetMode | undefined
  let expectedDatabase: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!
    if (!['--target', '--database'].includes(flag)) {
      throw new Error(`unknown credential scan argument: ${JSON.stringify(flag)}`)
    }
    if (seen.has(flag)) throw new Error(`duplicate credential scan argument: ${flag}`)
    seen.add(flag)
    const value = argumentValue(args, index, flag)
    index += 1
    if (flag === '--target') {
      if (!['local', 'preview', 'production'].includes(value)) {
        throw new Error('credential scan requires --target local|preview|production')
      }
      target = value as DatabaseTargetMode
    } else {
      expectedDatabase = requireDatabaseName(value, '--database')
    }
  }
  if (!target) throw new Error('credential scan requires --target local|preview|production')
  if (!expectedDatabase) throw new Error('credential scan requires --database <expected-name>')
  return Object.freeze({ target, expectedDatabase })
}

function resolveScanTarget(
  options: CredentialScanOptions,
  environment: ScanEnvironment,
): ScanTarget {
  const confirmation = `CONFIRM_${options.target.toUpperCase()}_CREDENTIAL_SCAN`
  if (environment[confirmation] !== ACKNOWLEDGEMENTS[options.target]) {
    throw new Error(
      `${options.target} credential scan requires ${confirmation}=${ACKNOWLEDGEMENTS[options.target]}`,
    )
  }
  const urlVariable = `${options.target.toUpperCase()}_DATABASE_URL_UNPOOLED`
  const identity = describeDatabaseUrl(environment[urlVariable] ?? '', urlVariable)
  if (identity.databaseName !== options.expectedDatabase) {
    throw new Error(
      `${urlVariable} names database ${JSON.stringify(identity.databaseName)}, ` +
      `not expected database ${JSON.stringify(options.expectedDatabase)}`,
    )
  }
  if (options.target === 'local') {
    requireLoopbackPostgresUrl(identity.databaseUrl, 'local credential scan')
    return Object.freeze({ mode: options.target, identity })
  }

  const parsed = new URL(identity.databaseUrl)
  if (!['require', 'verify-ca', 'verify-full'].includes(parsed.searchParams.get('sslmode') ?? '')) {
    throw new Error(`${urlVariable} must use TLS with sslmode=require, verify-ca, or verify-full`)
  }
  if (identity.port !== '5432') {
    throw new Error(`${urlVariable} must use the proven Neon endpoint port 5432`)
  }
  if (!environment.NEON_API_KEY?.trim()) {
    throw new Error(`${options.target} credential scan requires NEON_API_KEY`)
  }
  const projectId = requiredIdentifier(environment.NEON_PROJECT_ID, 'NEON_PROJECT_ID')
  const productionBranchId = requiredIdentifier(
    environment.NEON_PRODUCTION_BRANCH_ID,
    'NEON_PRODUCTION_BRANCH_ID',
  )
  const branchVariable = options.target === 'preview'
    ? 'NEON_PREVIEW_BRANCH_ID'
    : 'NEON_PRODUCTION_BRANCH_ID'
  const branchId = requiredIdentifier(environment[branchVariable], branchVariable)
  if (options.target === 'preview' && branchId === productionBranchId) {
    throw new Error('preview branch must not be the production branch')
  }
  return Object.freeze({ mode: options.target, identity, projectId, branchId })
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function positiveResidentId(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function parseExposureRows(rows: readonly Record<string, unknown>[]): readonly ExposureRow[] {
  return Object.freeze(rows.map(row => {
    const associatedResidentId = row.associated_resident_id == null
      ? null
      : positiveResidentId(row.associated_resident_id)
    if (
      typeof row.content !== 'string' ||
      (row.associated_resident_id != null && associatedResidentId === null)
    ) {
      throw new Error('credential scan received an invalid public record shape')
    }
    return Object.freeze({
      associated_resident_id: associatedResidentId,
      content: row.content,
    })
  }))
}

function parseIdentityRows(rows: readonly Record<string, unknown>[]): readonly IdentityRow[] {
  const kinds = new Set<ResidentCredentialKind>([
    'resident_key',
    'oauth_access_token',
    'oauth_refresh_token',
    'oauth_authorization_code',
    'recovery_code',
  ])
  return Object.freeze(rows.map(row => {
    const residentId = positiveResidentId(row.resident_id)
    if (
      typeof row.credential_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.credential_hash) ||
      !kinds.has(row.credential_kind as ResidentCredentialKind) ||
      !residentId || typeof row.live !== 'boolean'
    ) throw new Error('credential scan received invalid identity evidence')
    return Object.freeze({
      credential_hash: row.credential_hash,
      credential_kind: row.credential_kind as ResidentCredentialKind,
      resident_id: residentId,
      live: row.live,
    })
  }))
}

function sortedIds(values: ReadonlySet<number>): readonly number[] {
  return Object.freeze([...values].sort((left, right) => left - right))
}

function buildResult(
  target: ScanTarget,
  exposures: readonly ExposureRow[],
  identities: readonly IdentityRow[],
): CredentialExposureScanResult {
  const associatedResidents = new Set<number>()
  const credentialOwners = new Set<number>()
  const liveCredentialOwners = new Set<number>()
  const identityByHash = new Map<string, IdentityRow>()
  for (const identity of identities) {
    if (identityByHash.has(identity.credential_hash)) {
      throw new Error('credential scan received ambiguous identity evidence')
    }
    identityByHash.set(identity.credential_hash, identity)
  }

  const kindCounts: Record<ResidentCredentialKind, number> = {
    resident_key: 0,
    oauth_access_token: 0,
    oauth_refresh_token: 0,
    oauth_authorization_code: 0,
    recovery_code: 0,
  }
  let exactCredentials = 0
  let partialShapes = 0
  let liveCredentials = 0
  let inactiveCredentials = 0
  let unresolvedCredentials = 0

  for (const exposure of exposures) {
    if (!containsPublicCredential(exposure.content)) continue
    if (exposure.associated_resident_id) associatedResidents.add(exposure.associated_resident_id)
    const matches = extractResidentCredentials(exposure.content)
    if (matches.length === 0) partialShapes += 1
    for (const match of matches) {
      exactCredentials += 1
      kindCounts[match.kind] += 1
      const identity = identityByHash.get(sha256(match.token))
      if (!identity) {
        unresolvedCredentials += 1
        continue
      }
      credentialOwners.add(identity.resident_id)
      if (identity.live) {
        liveCredentials += 1
        liveCredentialOwners.add(identity.resident_id)
      } else {
        inactiveCredentials += 1
      }
    }
  }

  const targetEvidence = Object.freeze({
    mode: target.mode,
    database: target.identity.databaseName,
    endpoint_fingerprint: target.identity.endpointFingerprint,
    ...(target.projectId ? { project_id: target.projectId } : {}),
    ...(target.branchId ? { branch_id: target.branchId } : {}),
  })
  return Object.freeze({
    schema_version: 1,
    target: targetEvidence,
    associated_resident_ids: sortedIds(associatedResidents),
    credential_owner_resident_ids: sortedIds(credentialOwners),
    live_credential_owner_resident_ids: sortedIds(liveCredentialOwners),
    counts: Object.freeze({
      public_fields: exposures.length,
      exact_credentials: exactCredentials,
      partial_shapes: partialShapes,
      live_credentials: liveCredentials,
      inactive_credentials: inactiveCredentials,
      unresolved_credentials: unresolvedCredentials,
      ...kindCounts,
    }),
  })
}

export function safeCredentialScanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(new RegExp(PUBLIC_CREDENTIAL_PATTERN_SOURCE, 'gi'), '[redacted credential]')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[redacted database URL]')
    .replace(/(?:password|NEON_API_KEY)\s*[=:]\s*[^\s]+/gi, 'credential=[redacted]')
}

function defaultClient(databaseUrl: string): CredentialScanClient {
  return new Client({
    connectionString: databaseUrl,
    application_name: '1f3d9-credential-exposure-scan',
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
  }) as CredentialScanClient
}

export async function runCredentialExposureScan(options: Readonly<{
  argv?: readonly string[]
  environment?: ScanEnvironment
  fetcher?: typeof fetch
  createClient?: (databaseUrl: string) => CredentialScanClient
  log?: (line: string) => void
}> = {}): Promise<CredentialExposureScanResult> {
  const args = parseCredentialScanArgs(options.argv ?? process.argv.slice(2))
  const environment = options.environment ?? process.env
  const target = resolveScanTarget(args, environment)
  if (target.mode !== 'local') {
    await verifyNeonDatabaseTarget(
      { projectId: target.projectId!, branchId: target.branchId! },
      target.identity.databaseUrl,
      environment.NEON_API_KEY!,
      target.mode,
      options.fetcher ?? fetch,
    )
  }

  let client: CredentialScanClient
  try {
    client = (options.createClient ?? defaultClient)(target.identity.databaseUrl)
  } catch (error) {
    throw new Error(safeCredentialScanError(error))
  }

  let transactionStarted = false
  let result: CredentialExposureScanResult | undefined
  let failure: unknown
  try {
    await client.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionStarted = true
    await client.query('SET LOCAL search_path = pg_catalog, public')
    await client.query("SET LOCAL statement_timeout = '15s'")
    await client.query("SET LOCAL lock_timeout = '2s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '20s'")
    const exposureRows = parseExposureRows(
      (await client.query(PUBLIC_EXPOSURE_SQL, [PUBLIC_CREDENTIAL_PATTERN_SOURCE])).rows,
    )
    const credentialHashes = Object.freeze([...new Set(exposureRows.flatMap(row => (
      extractResidentCredentials(row.content).map(match => sha256(match.token))
    )))])
    const identityRows = credentialHashes.length === 0
      ? Object.freeze([]) as readonly IdentityRow[]
      : parseIdentityRows((await client.query(IDENTITY_MATCH_SQL, [credentialHashes])).rows)
    result = buildResult(target, exposureRows, identityRows)
    await client.query('COMMIT')
    transactionStarted = false
  } catch (error) {
    failure = error
    if (transactionStarted) {
      await client.query('ROLLBACK').catch(() => {})
      transactionStarted = false
    }
  }

  try {
    await client.end()
  } catch (error) {
    failure ??= error
  }
  if (failure) throw new Error(safeCredentialScanError(failure))
  if (!result) throw new Error('credential scan did not produce a result')
  ;(options.log ?? console.log)(JSON.stringify(result))
  return result
}

function isMainModule(): boolean {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url
}

if (isMainModule()) {
  void runCredentialExposureScan().catch(error => {
    console.error(`credential scan failed: ${safeCredentialScanError(error)}`)
    process.exitCode = 1
  })
}
