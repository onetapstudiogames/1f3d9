import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  mountOAuthRoutes,
  type OAuthDiagnosticRecord,
} from '../../src/oauth.ts'
import { EXISTING_KEY, MemoryOAuthStore } from './memory-oauth-store.ts'

export const ORIGIN = 'https://1f3d9.com'
export const RESOURCE = `${ORIGIN}/mcp/connect`
export const CLIENT_ID = 'hosted-chat-flow-test'
export const CALLBACK = 'https://chat.example.test/oauth/callback'
export const STATE = 'client-state-that-must-survive'
export const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
export const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

export function assertSecretsAbsent(surface: string, secrets: readonly string[]): void {
  for (const secret of secrets) assert.equal(surface.includes(secret), false)
}

export const environment = {
  PUBLIC_ORIGIN: ORIGIN,
  HOSTED_CHAT_SIGNIN_ENABLED: 'true',
  HOSTED_CHAT_OAUTH_CLIENTS: JSON.stringify([{
    client_id: CLIENT_ID,
    client_name: 'Hosted Chat Flow Test',
    redirect_uris: [CALLBACK],
  }]),
  HOSTED_CHAT_CIMD_ORIGINS: '',
} as const

export interface BrowserSession {
  cookie: string
  rawSession: string
  csrf: string
  html: string
  location: string
}

interface TokenPair {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  scope: string
}

export function appFor(
  memory: MemoryOAuthStore,
  diagnostics?: (record: Readonly<OAuthDiagnosticRecord>) => void,
): Hono {
  const app = new Hono()
  app.onError(() => new Response('Internal Server Error', { status: 500 }))
  mountOAuthRoutes(app, {
    environment,
    store: memory.api,
    fetcher: (async input => {
      throw new Error(`unexpected network call: ${String(input)}`)
    }) as typeof fetch,
    // Decision row 74 security fix: this fixture backs the pairing-code
    // tests below, which exercise the deployment where
    // CODING_IDENTITY_DOORS_ENABLED is on. The dedicated disabled-gate test
    // builds its own app with pairingEnabled left at its false default.
    pairingEnabled: true,
    ...(diagnostics ? { diagnostics } : {}),
  })
  return app
}

export function fixture() {
  const memory = new MemoryOAuthStore()
  const app = appFor(memory)
  return { app, memory }
}

export function authorizationUrl(patch: Record<string, string> = {}): string {
  const values = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    resource: RESOURCE,
    scope: 'city:resident',
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...patch,
  }
  return `/oauth/authorize?${new URLSearchParams(values)}`
}

export async function begin(app: Hono, url = authorizationUrl()): Promise<BrowserSession> {
  const response = await app.request(url)
  assert.equal(response.status, 200)
  assertPrivate(response, true)
  assert.equal(response.headers.get('location'), null)
  const setCookie = response.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /^__Host-1f3d9_oauth=[^;]+;/u)
  assert.match(setCookie, /; Path=\//i)
  assert.match(setCookie, /; Secure/i)
  assert.match(setCookie, /; HttpOnly/i)
  assert.match(setCookie, /; SameSite=Lax/i)
  const cookie = setCookie.split(';', 1)[0]!
  const rawSession = cookie.split('=', 2)[1]!.split('.', 2)[0]!
  assert.match(
    response.headers.get('content-security-policy') ?? '',
    /form-action 'self' https:\/\/chat\.example\.test;/u,
  )
  const html = await response.text()
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
  assert.ok(csrf)
  assert.doesNotMatch(html, /name="session_cookie"|_1f3d9_cookie_/u)
  return { cookie, rawSession, csrf, html, location: url }
}

export function assertPrivate(response: Response, html = false): void {
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.equal(response.headers.get('referrer-policy'), html ? 'same-origin' : 'no-referrer')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  if (html) assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/i)
}

export async function browserPost(
  app: Hono,
  session: BrowserSession,
  fields: Record<string, string> | URLSearchParams,
  origin: string | null = ORIGIN,
  referer?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const body = fields instanceof URLSearchParams
    ? new URLSearchParams(fields)
    : new URLSearchParams(fields)
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    cookie: session.cookie,
    ...extraHeaders,
  }
  if (origin !== null) headers.origin = origin
  if (referer !== undefined) headers.referer = referer
  return app.request('/oauth/authorize', {
    method: 'POST',
    headers,
    body,
  })
}

export function authorizationCode(response: Response): string {
  assert.equal(response.status, 303)
  assertPrivate(response)
  const location = new URL(response.headers.get('location') ?? '')
  assert.equal(`${location.origin}${location.pathname}`, CALLBACK)
  assert.equal(location.searchParams.get('state'), STATE)
  const code = location.searchParams.get('code')
  assert.match(code ?? '', /^1f3d9_ac_[0-9a-f]{64}$/)
  return code!
}

export async function exchangeCode(app: Hono, code: string, patch: Record<string, string> = {}) {
  return app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      resource: RESOURCE,
      code,
      code_verifier: VERIFIER,
      ...patch,
    }),
  })
}

export async function readTokenPair(response: Response): Promise<TokenPair> {
  assert.equal(response.status, 200)
  assertPrivate(response)
  const pair = await response.json() as TokenPair
  assert.match(pair.access_token, /^1f3d9_at_[0-9a-f]{64}$/)
  assert.match(pair.refresh_token, /^1f3d9_rt_[0-9a-f]{64}$/)
  assert.equal(pair.token_type, 'Bearer')
  assert.equal(pair.scope, 'city:resident')
  return pair
}

export async function authorizeExisting(app: Hono): Promise<{ code: string; session: BrowserSession }> {
  const session = await begin(app)
  const response = await browserPost(app, session, {
    action: 'link',
    csrf: session.csrf,
    resident_key: EXISTING_KEY,
  })
  const responseBody = await response.clone().text()
  const responseSurface = `${responseBody}\n${[...response.headers].flat().join('\n')}`
  assert.doesNotMatch(responseSurface, new RegExp(EXISTING_KEY, 'i'))
  return { code: authorizationCode(response), session }
}

export async function initialPair(app: Hono): Promise<TokenPair> {
  const { code } = await authorizeExisting(app)
  return readTokenPair(await exchangeCode(app, code))
}
