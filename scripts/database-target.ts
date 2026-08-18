import { createHash } from 'node:crypto'

export type DatabaseTargetMode = 'local' | 'preview' | 'production'

export type DatabaseIdentity = Readonly<{
  databaseUrl: string
  hostname: string
  databaseName: string
  port: string
  pooled: boolean
  endpointFingerprint: string
}>

export type NeonDatabaseTarget = Readonly<{
  projectId: string
  branchId: string
}>

const NEON_ID = /^[a-z0-9-]{1,60}$/
const DATABASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

type EndpointsResponse = Readonly<{ endpoints?: unknown }>

export function requiredIdentifier(
  value: string | undefined,
  variableName: string,
): string {
  if (!value || !NEON_ID.test(value)) {
    throw new Error(`${variableName} is invalid or missing`)
  }
  return value
}

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && NEON_ID.test(value)
}

export function requireDatabaseName(value: string | undefined, label: string): string {
  if (!value || !DATABASE_NAME.test(value)) {
    throw new Error(`${label} must be a safe PostgreSQL database name`)
  }
  return value
}

export function requireDirectPostgresUrl(
  value: string | undefined,
  variableName: string,
): string {
  if (!value) throw new Error(`${variableName} not set`)

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${variableName} must be a valid Postgres connection URL`)
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${variableName} must be a Postgres connection URL`)
  }
  if (!parsed.hostname || !parsed.username || !parsed.pathname.slice(1)) {
    throw new Error(`${variableName} must name a host, role, and database`)
  }
  if (parsed.hostname.toLowerCase().includes('-pooler')) {
    throw new Error(`${variableName} must use a direct, non-pooled connection`)
  }
  return value
}

export function requireLoopbackPostgresUrl(value: string, label = 'local operation'): string {
  const hostname = new URL(value).hostname.toLowerCase()
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`${label} requires a loopback Postgres host`)
  }
  return value
}

export function describeDatabaseUrl(
  value: string,
  variableName: string,
): DatabaseIdentity {
  const databaseUrl = requireDirectPostgresUrl(value, variableName)
  const parsed = new URL(databaseUrl)
  let databaseName: string
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1))
  } catch {
    throw new Error(`${variableName} contains an invalid database name`)
  }
  requireDatabaseName(databaseName, variableName)
  const hostname = parsed.hostname.toLowerCase()
  const endpointFingerprint = createHash('sha256')
    .update(`${hostname}:${parsed.port || '5432'}:${databaseName}`, 'utf8')
    .digest('hex')
    .slice(0, 16)

  return Object.freeze({
    databaseUrl,
    hostname,
    databaseName,
    port: parsed.port || '5432',
    pooled: hostname.includes('-pooler'),
    endpointFingerprint,
  })
}

export async function responseJson(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`)
  const decoded = await response.json().catch(() => null)
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error(`${label} returned an invalid response`)
  }
  return decoded as Record<string, unknown>
}

export async function verifyNeonDatabaseTarget(
  target: NeonDatabaseTarget,
  databaseUrl: string,
  apiKey: string,
  label: 'preview' | 'production',
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const failure = `Could not prove the ${label} database target`
  if (!apiKey.trim()) throw new Error(failure)

  let databaseHost: string
  try {
    databaseHost = describeDatabaseUrl(
      databaseUrl,
      label === 'preview'
        ? 'PREVIEW_DATABASE_URL_UNPOOLED'
        : 'PRODUCTION_DATABASE_URL_UNPOOLED',
    ).hostname
  } catch {
    throw new Error(failure)
  }

  const base = `https://console.neon.tech/api/v2/projects/${target.projectId}`
  const response = await responseJson(await fetcher(
    `${base}/branches/${target.branchId}/endpoints`,
    {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    },
  ), `Neon ${label} endpoint verification`) as EndpointsResponse

  if (!Array.isArray(response.endpoints)) throw new Error(failure)
  const matchingEndpoints = response.endpoints.filter(endpoint => {
    if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) return false
    const record = endpoint as Record<string, unknown>
    return (
      typeof record.id === 'string' && NEON_ID.test(record.id) &&
      typeof record.host === 'string' && record.host.toLowerCase() === databaseHost &&
      record.project_id === target.projectId &&
      record.branch_id === target.branchId &&
      record.type === 'read_write'
    )
  })

  if (matchingEndpoints.length !== 1) throw new Error(failure)
}
