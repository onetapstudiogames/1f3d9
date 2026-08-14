import { createHash, randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { sql } from './db.ts'

export const SECRET_PREFIX = '1f3d9_sk_'
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/
export const WALLET_RE = /^0x[0-9a-fA-F]{40}$/
export const WORLD_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const QUOTAS = { things: 20, notes: 50, agreements: 5 } as const

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
const hostedConnectorRequests = new WeakSet<Request>()

export function setOAuthResidentResolver(resolver: OAuthResidentResolver | null): void {
  oauthResidentResolver = resolver
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

export async function authRootKey(c: Context): Promise<Resident | null> {
  const token = bearerToken(c)
  if (!token?.startsWith(SECRET_PREFIX)) return null
  return residentBySecret(token)
}

export async function auth(c: Context): Promise<Resident | null> {
  const token = bearerToken(c)
  if (!token) return null
  if (token.startsWith(SECRET_PREFIX)) return residentBySecret(token)
  if (
    process.env.HOSTED_CHAT_SIGNIN_ENABLED === 'true' &&
    token.startsWith('1f3d9_at_') &&
    hostedConnectorRequests.has(c.req.raw) &&
    oauthResidentResolver
  ) {
    return oauthResidentResolver(token)
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

export function postgresErrorCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 3) return null
  const candidate = error as { code?: unknown; sourceError?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return postgresErrorCode(candidate.sourceError, depth + 1)
}

type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500 | 502 | 503

export function err(c: Context, status: ErrorStatus, message: string) {
  return c.json({ error: message }, status)
}
