import { createHash, timingSafeEqual } from 'node:crypto'

export const OAUTH_RESOURCE = 'https://1f3d9.com/mcp/connect'
export const OAUTH_SCOPE = 'city:resident'
export const OAUTH_AUTHORIZATION_CODE_PREFIX = '1f3d9_ac_'
export const OAUTH_ACCESS_TOKEN_PREFIX = '1f3d9_at_'
export const OAUTH_REFRESH_TOKEN_PREFIX = '1f3d9_rt_'

const HTTPS = 'https:'
const MAX_CLIENT_ID = 2_048
const MAX_CLIENT_NAME = 240
const MAX_REDIRECT_URI = 4_096
const MAX_STATE = 4_096
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
const CREDENTIAL = /1f3d9_(?:sk|at|rt|ac)_[0-9a-f]{8,}/i

export type OAuthEnvironment = Readonly<Record<string, string | undefined>>

export interface OAuthClient {
  clientId: string
  clientName: string
  redirectUris: string[]
}

export interface ValidAuthorizationRequest {
  clientId: string
  clientName: string
  redirectUri: string
  resource: string
  scope: string
  state: string
  codeChallenge: string
}

export function oauthEnabled(environment: OAuthEnvironment = process.env): boolean {
  return environment.HOSTED_CHAT_SIGNIN_ENABLED === 'true'
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum) {
    throw new Error(`${label} is invalid`)
  }
  if (/[\u0000-\u001f\u007f]/u.test(value) || CREDENTIAL.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function exactHttpsRedirect(value: unknown): string {
  const candidate = text(value, 'redirect URI', MAX_REDIRECT_URI)
  if (candidate.includes('*')) throw new Error('redirect URI must be exact')
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('redirect URI must be a valid URL')
  }
  if (
    parsed.protocol !== HTTPS ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.origin === 'null'
  ) {
    throw new Error('redirect URI must be an exact HTTPS URL without credentials or a fragment')
  }
  return parsed.href
}

function stringArray(value: unknown, label: string, maximum = 20): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty array`)
  }
  if (value.some(item => typeof item !== 'string')) throw new Error(`${label} must contain strings`)
  return value as string[]
}

export function parseOAuthClients(raw: string | undefined): OAuthClient[] {
  if (!raw) return []
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new Error('HOSTED_CHAT_OAUTH_CLIENTS must be valid JSON')
  }
  if (!Array.isArray(decoded) || decoded.length > 50) {
    throw new Error('HOSTED_CHAT_OAUTH_CLIENTS must be an array of at most 50 clients')
  }

  const clients = decoded.map((candidate, index) => {
    const item = record(candidate, `OAuth client ${index + 1}`)
    const allowed = new Set(['client_id', 'client_name', 'redirect_uris'])
    if (Object.keys(item).some(key => !allowed.has(key))) {
      throw new Error(`OAuth client ${index + 1} contains an unsupported field`)
    }
    const clientId = text(item.client_id, 'client_id', MAX_CLIENT_ID)
    const clientName = text(item.client_name, 'client_name', MAX_CLIENT_NAME)
    const redirectUris = [...new Set(
      stringArray(item.redirect_uris, 'redirect_uris').map(exactHttpsRedirect),
    )]
    return { clientId, clientName, redirectUris }
  })

  if (new Set(clients.map(client => client.clientId)).size !== clients.length) {
    throw new Error('OAuth client IDs must be unique')
  }
  return clients
}

export function parseCimdOrigins(raw: string | undefined): string[] {
  if (!raw) return []
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new Error('HOSTED_CHAT_CIMD_ORIGINS must be valid JSON')
  }
  const origins = stringArray(decoded, 'HOSTED_CHAT_CIMD_ORIGINS', 20).map(value => {
    if (value.includes('*')) throw new Error('CIMD origins cannot contain wildcards')
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error('CIMD origins must be valid URLs')
    }
    if (
      parsed.protocol !== HTTPS ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      value !== parsed.origin
    ) {
      throw new Error('CIMD origins must be exact HTTPS origins')
    }
    return parsed.origin
  })
  return [...new Set(origins)]
}

function requestText(value: unknown, label: string, maximum: number): string {
  return text(value, label, maximum)
}

export function validateAuthorizationRequest(
  request: Record<string, unknown>,
  clients: readonly OAuthClient[],
  expectedResource = OAUTH_RESOURCE,
): ValidAuthorizationRequest {
  if (request.response_type !== 'code') throw new Error('only authorization code is supported')
  const clientId = requestText(request.client_id, 'client_id', MAX_CLIENT_ID)
  const client = clients.find(candidate => candidate.clientId === clientId)
  if (!client) throw new Error('unknown OAuth client')
  const redirectUri = requestText(request.redirect_uri, 'redirect_uri', MAX_REDIRECT_URI)
  if (!client.redirectUris.includes(redirectUri)) throw new Error('redirect_uri is not registered')
  if (request.resource !== expectedResource) throw new Error('wrong protected resource')
  if (request.scope !== OAUTH_SCOPE) throw new Error('wrong OAuth scope')
  if (request.code_challenge_method !== 'S256') throw new Error('PKCE S256 is required')
  const codeChallenge = requestText(request.code_challenge, 'code_challenge', 128)
  if (!PKCE_CHALLENGE.test(codeChallenge)) throw new Error('invalid PKCE challenge')
  const state = requestText(request.state, 'state', MAX_STATE)
  return {
    clientId,
    clientName: client.clientName,
    redirectUri,
    resource: expectedResource,
    scope: OAUTH_SCOPE,
    state,
    codeChallenge,
  }
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function verifyPkceS256(verifier: string, expectedChallenge: string): boolean {
  if (!PKCE_VERIFIER.test(verifier) || !PKCE_CHALLENGE.test(expectedChallenge)) return false
  const actual = Buffer.from(pkceChallenge(verifier), 'ascii')
  const expected = Buffer.from(expectedChallenge, 'ascii')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function tokenLooksSensitive(value: unknown): boolean {
  return typeof value === 'string' && CREDENTIAL.test(value)
}

export function publicOrigin(environment: OAuthEnvironment = process.env): string {
  const configured = environment.PUBLIC_ORIGIN ?? 'https://1f3d9.com'
  let parsed: URL
  try {
    parsed = new URL(configured)
  } catch {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin')
  }
  if (
    parsed.protocol !== HTTPS ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin')
  }
  return parsed.origin
}

export function oauthResource(environment: OAuthEnvironment = process.env): string {
  return `${publicOrigin(environment)}/mcp/connect`
}

interface CimdDocument {
  client_id?: unknown
  client_name?: unknown
  redirect_uris?: unknown
  token_endpoint_auth_method?: unknown
  token_endpoint_auth_methods_supported?: unknown
}

export async function resolveOAuthClient(
  clientId: string,
  staticClients: readonly OAuthClient[],
  cimdOrigins: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<OAuthClient> {
  if (tokenLooksSensitive(clientId)) throw new Error('unknown OAuth client')
  const configured = staticClients.find(client => client.clientId === clientId)
  if (configured) return configured
  if (clientId.length > MAX_CLIENT_ID) throw new Error('unknown OAuth client')

  let metadataUrl: URL
  try {
    metadataUrl = new URL(clientId)
  } catch {
    throw new Error('unknown OAuth client')
  }
  if (
    metadataUrl.protocol !== HTTPS ||
    metadataUrl.username ||
    metadataUrl.password ||
    metadataUrl.pathname === '/' ||
    metadataUrl.search ||
    metadataUrl.hash ||
    !cimdOrigins.includes(metadataUrl.origin)
  ) {
    throw new Error('unknown OAuth client')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 4_000)
  let response: Response
  try {
    response = await fetcher(metadataUrl.href, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
  } catch {
    throw new Error('OAuth client metadata could not be verified')
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok || response.status >= 300) throw new Error('OAuth client metadata was rejected')
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType && !/^application\/(?:[a-z0-9.+-]+\+)?json$/i.test(contentType)) {
    throw new Error('OAuth client metadata must be JSON')
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > 65_536) throw new Error('OAuth client metadata is too large')
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > 65_536) throw new Error('OAuth client metadata is too large')

  let decoded: CimdDocument
  try {
    decoded = record(JSON.parse(body), 'OAuth client metadata') as CimdDocument
  } catch {
    throw new Error('OAuth client metadata is invalid')
  }
  if (decoded.client_id !== clientId) {
    throw new Error('OAuth client metadata identity mismatch')
  }
  const method = decoded.token_endpoint_auth_method
  const supportedMethods = decoded.token_endpoint_auth_methods_supported
  if (method === undefined && supportedMethods === undefined) {
    throw new Error('OAuth client authentication method is required')
  }
  if (method !== undefined && method !== 'none') {
    throw new Error('OAuth client authentication method is unsupported')
  }
  if (
    supportedMethods !== undefined &&
    !stringArray(
      supportedMethods,
      'token_endpoint_auth_methods_supported',
    ).includes('none')
  ) {
    throw new Error('OAuth client must support public PKCE exchange')
  }
  const clientName = text(decoded.client_name, 'client_name', MAX_CLIENT_NAME)
  const redirectUris = [...new Set(
    stringArray(decoded.redirect_uris, 'redirect_uris').map(exactHttpsRedirect),
  )]
  return { clientId, clientName, redirectUris }
}
