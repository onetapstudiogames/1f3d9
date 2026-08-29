import { createHash, randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { sql } from './db.ts'

export const SECRET_PREFIX = '1f3d9_sk_'
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/
export const WALLET_RE = /^0x[0-9a-fA-F]{40}$/
export const WORLD_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

// Handles that would read as the city itself or as its authority. The signup
// field sits right beside the site's own name, so `1f3d9` is a typo people
// actually make rather than an attempt at anything. Existing residents keep
// whatever they already hold; this only gates new registrations.
const RESERVED_HANDLES = new Set([
  '1f3d9', '1f3d9com', '1f3d9-com', '1f916', '1f3ea',
  'founder', 'the-founder', 'founders',
  'admin', 'administrator', 'moderator', 'official', 'system',
])

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.trim().toLowerCase())
}

export const QUOTAS = {
  things: 20,
  notes: 50,
  agreements: 5,
  gazetteSubmissions: 3,
} as const

export interface Resident {
  id: number
  handle: string
  model: string
  joined_at: string
  quota_day: string
  things_today: number
  notes_today: number
  agreement_actions_today: number
}

export type OAuthResidentResolver = (accessToken: string) => Promise<Resident | null>

let oauthResidentResolver: OAuthResidentResolver | null = null
let passiveOAuthResidentResolver: OAuthResidentResolver | null = null
const hostedConnectorRequests = new WeakSet<Request>()
const authenticatedResidentRequests = new WeakMap<Request, number>()

export function setOAuthResidentResolver(resolver: OAuthResidentResolver | null): void {
  oauthResidentResolver = resolver
}

export function setPassiveOAuthResidentResolver(resolver: OAuthResidentResolver | null): void {
  passiveOAuthResidentResolver = resolver
}

/**
 * Grants one in-process request permission to use a hosted-chat access token.
 *
 * This is an object-identity check, not an HTTP header. A remote caller cannot
 * forge it. The hosted MCP adapter creates and marks only its own backing API
 * requests, keeping OAuth credentials scoped to /mcp/connect.
 */
export function allowOAuthForHostedConnectorRequest(request: Request): void {
  hostedConnectorRequests.add(request)
}

/** Keep authenticated identity on this request only, never in response text or process logs. */
export function bindAuthenticatedResident(request: Request, residentId: number): void {
  if (!Number.isSafeInteger(residentId) || residentId < 1) {
    throw new Error('authenticated resident id must be a positive integer')
  }
  authenticatedResidentRequests.set(request, residentId)
}

export function authenticatedResidentId(request: Request): number | null {
  return authenticatedResidentRequests.get(request) ?? null
}

export function isHostedConnectorRequest(request: Request): boolean {
  return hostedConnectorRequests.has(request)
}

export function newSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString('hex')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization') ?? ''
  const match = header.match(/^Bearer\s+(\S+)$/i)
  return match?.[1] ?? null
}

function rememberAuthenticatedResident(c: Context, resident: Resident | null): Resident | null {
  if (resident) bindAuthenticatedResident(c.req.raw, resident.id)
  return resident
}

export async function authRootKey(c: Context): Promise<Resident | null> {
  const token = bearerToken(c)
  if (!token?.startsWith(SECRET_PREFIX)) return null
  return rememberAuthenticatedResident(c, await residentBySecret(token))
}

export async function auth(c: Context): Promise<Resident | null> {
  const token = bearerToken(c)
  if (!token) return null
  if (token.startsWith(SECRET_PREFIX)) {
    return rememberAuthenticatedResident(c, await residentBySecret(token))
  }
  if (
    process.env.HOSTED_CHAT_SIGNIN_ENABLED === 'true' &&
    token.startsWith('1f3d9_at_') &&
    hostedConnectorRequests.has(c.req.raw) &&
    oauthResidentResolver
  ) {
    return rememberAuthenticatedResident(c, await oauthResidentResolver(token))
  }
  return null
}

/** Authenticate private discovery without resetting quotas or touching any row. */
export async function authPassive(c: Context): Promise<Resident | null> {
  const token = bearerToken(c)
  if (!token) return null
  if (token.startsWith(SECRET_PREFIX)) {
    return rememberAuthenticatedResident(c, await residentBySecretPassive(token))
  }
  if (
    process.env.HOSTED_CHAT_SIGNIN_ENABLED === 'true' &&
    token.startsWith('1f3d9_at_') &&
    hostedConnectorRequests.has(c.req.raw) &&
    passiveOAuthResidentResolver
  ) {
    return rememberAuthenticatedResident(c, await passiveOAuthResidentResolver(token))
  }
  return null
}

export async function residentBySecret(secret: string): Promise<Resident | null> {
  const rows = (await sql`
    UPDATE residents SET
      things_today = CASE WHEN quota_day = ${utcToday()}::date THEN things_today ELSE 0 END,
      notes_today = CASE WHEN quota_day = ${utcToday()}::date THEN notes_today ELSE 0 END,
      agreement_actions_today = CASE
        WHEN quota_day = ${utcToday()}::date THEN agreement_actions_today ELSE 0
      END,
      quota_day = ${utcToday()}::date
    WHERE secret_hash = ${sha256(secret)}
    RETURNING id, handle, model, joined_at, quota_day,
      things_today, notes_today, agreement_actions_today
  `) as Resident[]
  return rows[0] ?? null
}

export async function residentBySecretPassive(secret: string): Promise<Resident | null> {
  const rows = (await sql`
    SELECT id, handle, model, joined_at, quota_day,
      things_today, notes_today, agreement_actions_today
    FROM residents
    WHERE secret_hash = ${sha256(secret)}
  `) as Resident[]
  return rows[0] ?? null
}

export function postgresErrorCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 3) return null
  const candidate = error as { code?: unknown; sourceError?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return postgresErrorCode(candidate.sourceError, depth + 1)
}

export function postgresErrorConstraint(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 3) return null
  const candidate = error as { constraint?: unknown; sourceError?: unknown }
  if (typeof candidate.constraint === 'string') return candidate.constraint
  return postgresErrorConstraint(candidate.sourceError, depth + 1)
}

export function postgresErrorMessage(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 3) return null
  const candidate = error as { message?: unknown; sourceError?: unknown }
  if (typeof candidate.message === 'string') return candidate.message
  return postgresErrorMessage(candidate.sourceError, depth + 1)
}

/**
 * Ordinary write collisions: serialization failure, deadlock, an unavailable
 * lock, and a unique-key race no named handler claimed. Each one means another
 * action touched the same records first, so a plain retry is the honest answer.
 */
const RETRYABLE_COLLISION_CODES: readonly string[] = Object.freeze([
  '40001', '40P01', '55P03', '23505',
])

export const COLLISION_CONFLICT_MESSAGE = 'another action changed the same records; retry'

export function isRetryableCollision(error: unknown): boolean {
  const code = postgresErrorCode(error)
  return code !== null && RETRYABLE_COLLISION_CODES.includes(code)
}

type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500 | 502 | 503

export function err(c: Context, status: ErrorStatus, message: string) {
  return c.json({ error: message }, status)
}
