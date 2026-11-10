import { createHmac, timingSafeEqual } from 'node:crypto'
import { publicOrigin, type OAuthClient, type OAuthEnvironment } from './oauth-config.ts'
import type { RedirectShape, RegistrationShapes } from './oauth-diagnostics.ts'

export const GEMINI_CLIENT_PREFIX = 'gemini.v1.'
const MAX_CLIENT_ID = 2_048
const MAX_REDIRECTS = 10

export function geminiSigningReady(environment: OAuthEnvironment): boolean {
  return /^[0-9a-f]{64}$/u.test(environment.GEMINI_DCR_SIGNING_KEY ?? '')
}

function cityHostSegment(environment: OAuthEnvironment): string {
  return new URL(publicOrigin(environment)).hostname.replaceAll('.', '_')
}

/**
 * Match the raw spelling so URL normalization cannot admit ports or dot segments.
 * Decision 143 form: digits, a hyphen and this city's host. Decision 186 form: Google's
 * newer opaque user-bound segment of 16 to 64 letters or digits, which names no server.
 * The one group keeps both forms anchored to the fixed Google host and /r/ path.
 */
export function geminiRedirects(value: unknown, environment: OAuthEnvironment, selectSupported = false): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REDIRECTS) return null
  if (value.some(uri => typeof uri !== 'string' || uri.length > 1_024)) return null
  const escapedHost = cityHostSegment(environment).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const shape = new RegExp(`^https://oauth-redirect\\.googleusercontent\\.com/r/user_bound_custom-mcp-(?:[0-9]+-${escapedHost}|[0-9A-Za-z]{16,64})$`, 'u')
  const supported = (value as string[]).filter(uri => shape.test(uri) && !/\s/u.test(uri))
  // RFC 7591 registration returns only supported metadata. Issued IDs stay strict.
  if (!supported.length || (!selectSupported && supported.length !== value.length)) return null
  return [...new Set(supported)]
}

const GOOGLE_HOSTS: Readonly<Record<string, RedirectShape['host_class']>> = {
  'oauth-redirect.googleusercontent.com': 'main',
  'oauth-redirect-test.googleusercontent.com': 'test',
  'oauth-redirect-sandbox.googleusercontent.com': 'sandbox',
}
const USER_BOUND_PREFIX = 'user_bound_custom-mcp-'
const MAX_SEGMENT_LENGTH = 1_024

function segmentClass(segment: string, cityHost: string): RedirectShape['segment_class'] {
  if (!segment) return 'empty'
  if (/^[0-9]+$/u.test(segment)) return 'digits'
  if (/^[0-9a-f]+$/u.test(segment)) return 'hex_lower'
  if (/^[0-9A-Za-z]+$/u.test(segment)) return 'alnum'
  const october = /^[0-9]+-([A-Za-z0-9_-]+)$/u.exec(segment)
  if (october) return october[1] === cityHost ? 'old_this_city' : 'old_other_host'
  if (/^[A-Za-z0-9_-]+$/u.test(segment)) return 'base64url'
  return /[./%]/u.test(segment) ? 'has_dot_slash_percent' : 'other'
}

function redirectShape(uri: unknown, cityHost: string): RedirectShape {
  const text = typeof uri === 'string' ? uri : ''
  const afterScheme = text.includes('://') ? text.slice(text.indexOf('://') + 3) : ''
  const authority = /^[^/?#]*/u.exec(afterScheme)![0]
  const path = /^[^?#]*/u.exec(afterScheme.slice(authority.length))![0]
  const pathClass = path.startsWith('/r/') ? 'r' : path.startsWith('/a/') ? 'a' : 'other'
  const tail = path.slice(3)
  const prefixMatch = pathClass !== 'other' && tail.startsWith(USER_BOUND_PREFIX)
  const segment = prefixMatch ? tail.slice(USER_BOUND_PREFIX.length) : ''
  return {
    host_class: GOOGLE_HOSTS[authority] ?? 'other',
    scheme_ok: text.startsWith('https://'),
    path_class: pathClass,
    prefix_match: prefixMatch,
    segment_length: Math.min(segment.length, MAX_SEGMENT_LENGTH),
    segment_class: segmentClass(segment, cityHost),
    has_port_query_fragment_userinfo_whitespace: /[?#@\s]/u.test(text) || authority.includes(':'),
    non_string: typeof uri !== 'string',
  }
}

/** Shapes of a refused registration for the host log; no submitted character survives. */
export function geminiRegistrationShapes(value: unknown, userAgent: string | undefined, environment: OAuthEnvironment): RegistrationShapes {
  const list: readonly unknown[] = Array.isArray(value) ? value.slice(0, MAX_REDIRECTS) : []
  const cityHost = cityHostSegment(environment)
  return {
    addressCount: list.length,
    addresses: list.map(uri => redirectShape(uri, cityHost)),
    userAgentClass: userAgent === 'OpenAuth' ? 'OpenAuth' : 'other',
  }
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
