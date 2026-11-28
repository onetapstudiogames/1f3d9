import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  GROK_CALLBACK, GROK_REGISTERED_CLIENT_PREFIX, publicOrigin, type OAuthClient, type OAuthEnvironment,
} from './oauth-config.ts'
import {
  REGISTRATION_FIELD_NAMES,
  type ClientRefusalCheck,
  type GrokRegistrationFacts,
  type RedirectShape,
  type RegistrationShapes,
} from './oauth-diagnostics.ts'

// The two chat apps that register themselves at POST /oauth/register: Gemini (decisions
// 143 and 186) and Grok (decision 206). Both client IDs are signed with the one
// registration key, each under its own label, so neither needs a client table.

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

/** Shapes of a refused Gemini registration for the host log; no submitted character survives. */
function geminiRegistrationShapes(value: unknown, userAgent: string | undefined, environment: OAuthEnvironment): RegistrationShapes {
  const list: readonly unknown[] = Array.isArray(value) ? value.slice(0, MAX_REDIRECTS) : []
  const cityHost = cityHostSegment(environment)
  return {
    addressCount: list.length,
    addresses: list.map(uri => redirectShape(uri, cityHost)),
    userAgentClass: userAgent === 'OpenAuth' ? 'OpenAuth' : 'other',
  }
}

function signature(family: 'gemini' | 'grok', payload: string, environment: OAuthEnvironment): string {
  return createHmac('sha256', Buffer.from(environment.GEMINI_DCR_SIGNING_KEY!, 'hex'))
    .update(`1f3d9:${family}-client:v1:${publicOrigin(environment)}:${payload}`, 'utf8')
    .digest('base64url')
}

function sameSignature(presented: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(presented, 'ascii'), Buffer.from(expected, 'ascii'))
}

export function registerGeminiClient(redirects: string[], environment: OAuthEnvironment): string | null {
  if (!geminiSigningReady(environment)) return null
  const payload = Buffer.from(JSON.stringify(redirects), 'utf8').toString('base64url')
  const clientId = `${GEMINI_CLIENT_PREFIX}${payload}.${signature('gemini', payload, environment)}`
  return clientId.length <= MAX_CLIENT_ID ? clientId : null
}

/** A client ID is public registration data, never authority to act as a resident. */
export function resolveGeminiClient(clientId: string, environment: OAuthEnvironment): OAuthClient | null {
  if (!geminiSigningReady(environment) || clientId.length > MAX_CLIENT_ID) return null
  const match = /^gemini\.v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(clientId)
  if (!match) return null
  const payload = match[1]!
  if (!sameSignature(match[2]!, signature('gemini', payload, environment))) return null
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8')
    const redirects = geminiRedirects(JSON.parse(decoded), environment)
    if (!redirects || Buffer.from(JSON.stringify(redirects)).toString('base64url') !== payload) return null
    return { clientId, clientName: 'Gemini', redirectUris: redirects }
  } catch {
    return null
  }
}

/** Decision 206: Grok registers only its one return page, as exactly one byte-exact entry. */
export function isGrokRegistration(redirects: unknown): boolean {
  return Array.isArray(redirects) && redirects.length === 1 && redirects[0] === GROK_CALLBACK
}

/** The one Grok client ID for this city: its return page is fixed, so only the signature varies. */
export function registerGrokClient(environment: OAuthEnvironment): string | null {
  if (!geminiSigningReady(environment)) return null
  return `${GROK_REGISTERED_CLIENT_PREFIX}${signature('grok', GROK_CALLBACK, environment)}`
}

export function resolveGrokClient(clientId: string, environment: OAuthEnvironment): OAuthClient | null {
  if (!geminiSigningReady(environment)) return null
  const match = /^grok\.v1\.([A-Za-z0-9_-]{43})$/u.exec(clientId)
  if (!match || !sameSignature(match[1]!, signature('grok', GROK_CALLBACK, environment))) return null
  return { clientId, clientName: 'Grok', redirectUris: [GROK_CALLBACK] }
}

/**
 * A self-registered client ID resolved by its own rule, or null when the ID is not one.
 * A null client means the city did not sign the ID, which `check` names for the host log.
 */
export function selfRegisteredClient(clientId: string, environment: OAuthEnvironment): {
  client: OAuthClient | null
  check: Extract<ClientRefusalCheck, 'gemini_client_unrecognized' | 'grok_client_unrecognized'>
} | null {
  if (clientId.startsWith(GEMINI_CLIENT_PREFIX)) {
    return { client: resolveGeminiClient(clientId, environment), check: 'gemini_client_unrecognized' }
  }
  if (clientId.startsWith(GROK_REGISTERED_CLIENT_PREFIX)) {
    return { client: resolveGrokClient(clientId, environment), check: 'grok_client_unrecognized' }
  }
  return null
}

function namesGrok(uri: unknown): boolean {
  if (typeof uri !== 'string') return false
  try {
    const { hostname } = new URL(uri.trim())
    return hostname === 'grok.com' || hostname.endsWith('.grok.com')
  } catch {
    return false
  }
}

/**
 * Decision 206: the log facts for a refused registration whose return addresses name
 * grok.com, or null when none does. Only known metadata names are listed; nothing the
 * caller wrote as a value, and no unknown field name, reaches the record.
 */
function grokRegistrationFacts(body: Readonly<Record<string, unknown>>): GrokRegistrationFacts | null {
  const requested = body.redirect_uris
  if (!Array.isArray(requested) || !requested.some(namesGrok)) return null
  const names = Object.keys(body)
  const fieldNames = names.filter(name => REGISTRATION_FIELD_NAMES.has(name)).sort()
  const check = 'software_statement' in body
    ? 'grok_registration_software_statement'
    : requested.includes(GROK_CALLBACK) ? 'grok_registration_extra_address' : 'grok_registration_inexact_address'
  return { check, fieldNames, otherFieldCount: names.length - fieldNames.length }
}

/** A refused registration for the host log: Gemini's address shapes, and decision 206's facts when it names grok.com. */
export function registrationShapes(
  body: Readonly<Record<string, unknown>>, userAgent: string | undefined, environment: OAuthEnvironment,
): RegistrationShapes {
  const grok = grokRegistrationFacts(body)
  return { ...geminiRegistrationShapes(body.redirect_uris, userAgent, environment), ...(grok ? { grok } : {}) }
}
