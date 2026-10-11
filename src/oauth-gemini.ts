import { createHmac, timingSafeEqual } from 'node:crypto'
import { publicOrigin, type OAuthClient, type OAuthEnvironment } from './oauth-config.ts'

export const GEMINI_CLIENT_PREFIX = 'gemini.v1.'
const MAX_CLIENT_ID = 2_048
const MAX_REDIRECTS = 10

export function geminiSigningReady(environment: OAuthEnvironment): boolean {
  return /^[0-9a-f]{64}$/u.test(environment.GEMINI_DCR_SIGNING_KEY ?? '')
}

/** Match the raw spelling so URL normalization cannot admit ports or dot segments. */
export function geminiRedirects(value: unknown, environment: OAuthEnvironment, selectSupported = false): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REDIRECTS) return null
  if (value.some(uri => typeof uri !== 'string' || uri.length > 1_024)) return null
  const host = new URL(publicOrigin(environment)).hostname.replaceAll('.', '_')
  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const shape = new RegExp(`^https://oauth-redirect\\.googleusercontent\\.com/r/user_bound_custom-mcp-[0-9]+-${escapedHost}$`, 'u')
  const supported = (value as string[]).filter(uri => shape.test(uri) && !/\s/u.test(uri))
  // RFC 7591 registration returns only supported metadata. Issued IDs stay strict.
  if (!supported.length || (!selectSupported && supported.length !== value.length)) return null
  return [...new Set(supported)]
}

function signature(payload: string, environment: OAuthEnvironment): string {
  return createHmac('sha256', Buffer.from(environment.GEMINI_DCR_SIGNING_KEY!, 'hex'))
    .update(`1f3d9:gemini-client:v1:${publicOrigin(environment)}:${payload}`, 'utf8')
    .digest('base64url')
}

export function registerGeminiClient(redirects: string[], environment: OAuthEnvironment): string | null {
  if (!geminiSigningReady(environment)) return null
  const payload = Buffer.from(JSON.stringify(redirects), 'utf8').toString('base64url')
  const clientId = `${GEMINI_CLIENT_PREFIX}${payload}.${signature(payload, environment)}`
  return clientId.length <= MAX_CLIENT_ID ? clientId : null
}

/** A client ID is public registration data, never authority to act as a resident. */
export function resolveGeminiClient(clientId: string, environment: OAuthEnvironment): OAuthClient | null {
  if (!geminiSigningReady(environment) || clientId.length > MAX_CLIENT_ID) return null
  const match = /^gemini\.v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(clientId)
  if (!match) return null
  const payload = match[1]!
  if (!timingSafeEqual(Buffer.from(match[2]!, 'ascii'), Buffer.from(signature(payload, environment), 'ascii'))) return null
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8')
    const redirects = geminiRedirects(JSON.parse(decoded), environment)
    if (!redirects || Buffer.from(JSON.stringify(redirects)).toString('base64url') !== payload) return null
    return { clientId, clientName: 'Gemini', redirectUris: redirects }
  } catch {
    return null
  }
}
