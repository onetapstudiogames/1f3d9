import { randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { trustedBrowserForm } from './browser-form.ts'
import {
  HANDLE_RE,
  newSecret,
  postgresErrorCode,
  setOAuthResidentResolver,
  sha256,
  type Resident,
} from './core.ts'
import { publicText } from './input.ts'
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_AUTHORIZATION_CODE_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAUTH_SCOPE,
  oauthEnabled,
  oauthResource,
  parseCimdOrigins,
  parseOAuthClients,
  publicOrigin,
  resolveOAuthClient,
  tokenLooksSensitive,
  validateAuthorizationRequest,
  verifyPkceS256,
  type OAuthEnvironment,
} from './oauth-config.ts'
import {
  postgresOAuthStore,
  type AuthorizationRequestRecord,
} from './oauth-store.ts'

export {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_AUTHORIZATION_CODE_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAUTH_RESOURCE,
  OAUTH_SCOPE,
  oauthEnabled,
  parseCimdOrigins,
  parseOAuthClients,
  tokenLooksSensitive,
  validateAuthorizationRequest,
  verifyPkceS256,
} from './oauth-config.ts'

const SESSION_COOKIE = '__Host-1f3d9_oauth'
const MAX_FORM_BYTES = 8_192
const MAX_UI_LOCALES = 256
const UI_LOCALES = /^[A-Za-z0-9-]{1,35}(?: [A-Za-z0-9-]{1,35}){0,9}$/
const ACCESS_TOKEN_SECONDS = 10 * 60
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60
const RECOVERY_CODE_COUNT = 8
const RECOVERY_CODE_PREFIX = '1f3d9_rc_'
type RecoveryCodeSet = readonly [string, string, string, string, string, string, string, string]

type OAuthStore = typeof postgresOAuthStore

export interface OAuthRouteOptions {
  environment?: OAuthEnvironment
  store?: OAuthStore
  fetcher?: typeof fetch
}

interface OAuthRuntime {
  environment: OAuthEnvironment
  store: OAuthStore
  fetcher: typeof fetch
  origin: string
  resource: string
  staticClients: ReturnType<typeof parseOAuthClients>
  cimdOrigins: ReturnType<typeof parseCimdOrigins>
}

function opaque(prefix = ''): string {
  return prefix + randomBytes(32).toString('hex')
}

function newRecoveryCode(): string {
  return RECOVERY_CODE_PREFIX + randomBytes(32).toString('hex')
}

export function collectRecoveryCodeSet(makeCode: () => string): RecoveryCodeSet {
  const codes = new Set<string>()
  for (let attempt = 0; codes.size < RECOVERY_CODE_COUNT; attempt += 1) {
    if (attempt >= 64) throw new Error('secure recovery-code generation failed')
    codes.add(makeCode())
  }
  const values = [...codes]
  return [
    values[0]!, values[1]!, values[2]!, values[3]!,
    values[4]!, values[5]!, values[6]!, values[7]!,
  ]
}

function newRecoveryCodeSet(): RecoveryCodeSet {
  return collectRecoveryCodeSet(newRecoveryCode)
}

function lastAddress(value: string | undefined): string | undefined {
  return value?.split(',').map(part => part.trim()).filter(Boolean).at(-1)
}

function clientAddress(c: Context, environment: OAuthEnvironment): string {
  if (environment.VERCEL !== '1') return 'unknown'
  return lastAddress(c.req.header('x-vercel-forwarded-for')) ?? 'unknown'
}

function privateHeaders(c: Context, html = false, callbackOrigin?: string): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Referrer-Policy', html ? 'same-origin' : 'no-referrer')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.res.headers.delete('Access-Control-Allow-Origin')
  c.res.headers.delete('Access-Control-Allow-Credentials')
  if (html) {
    const formAction = callbackOrigin
      ? `form-action 'self' ${callbackOrigin}; `
      : "form-action 'self'; "
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; " + formAction +
        "base-uri 'none'; frame-ancestors 'none'",
    )
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)} · 1F3D9</title><style>
:root{color-scheme:dark}body{max-width:42rem;margin:3rem auto;padding:0 1.2rem;background:#0d1117;color:#e6edf3;font:17px/1.55 system-ui,sans-serif}main{background:#161b22;border:1px solid #30363d;border-radius:14px;padding:1.4rem}h1{line-height:1.15}label{display:block;margin:1rem 0 .35rem}input{box-sizing:border-box;width:100%;padding:.75rem;background:#0d1117;color:#e6edf3;border:1px solid #59636e;border-radius:7px}button{margin-top:1.2rem;padding:.8rem 1rem;border:0;border-radius:8px;background:#f4a261;color:#151515;font-weight:700}code{display:block;overflow-wrap:anywhere;padding:1rem;background:#0d1117;border-radius:7px}.warning{color:#ffd166}.muted{color:#9da7b1}fieldset{border:0;padding:0;margin:0 0 1.6rem}
</style></head><body><main>${body}</main></body></html>`
}

function html(
  c: Context,
  status: 200 | 400 | 403 | 409 | 429,
  title: string,
  body: string,
  callbackOrigin?: string,
) {
  privateHeaders(c, true, callbackOrigin)
  return c.html(page(title, body), status)
}

function registeredCallbackOrigin(redirectUri: string): string {
  const redirect = new URL(redirectUri)
  if (redirect.protocol !== 'https:' || redirect.origin === 'null') {
    throw new Error('registered OAuth callback must use HTTPS')
  }
  return redirect.origin
}

function browserError(c: Context, status: 400 | 403 | 409 | 429, message: string) {
  return html(
    c,
    status,
    'Sign-in stopped',
    `<h1>Sign-in stopped</h1><p>${escapeHtml(message)}</p><p class="muted">You can close this page safely. Nothing was linked.</p>`,
  )
}

function cookieValue(c: Context): string | null {
  const raw = c.req.header('cookie') ?? ''
  for (const part of raw.split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === SESSION_COOKIE) return value.join('=') || null
  }
  return null
}

function setSessionCookie(c: Context, session: string): void {
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${session}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax`,
  )
}

function clearSessionCookie(c: Context): void {
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  )
}

async function form(c: Context): Promise<URLSearchParams | null> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/x-www-form-urlencoded') return null
  const declared = Number(c.req.header('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return null
  const raw = await c.req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_FORM_BYTES) return null
  return new URLSearchParams(raw)
}

function one(params: URLSearchParams, name: string, maximum = 4_096): string | null {
  const values = params.getAll(name)
  if (values.length !== 1 || !values[0] || values[0]!.length > maximum) return null
  if (/[\u0000-\u001f\u007f]/u.test(values[0]!)) return null
  return values[0]!
}

function hasExactlyKnownFields(params: URLSearchParams, allowed: readonly string[]): boolean {
  const allowedNames = new Set(allowed)
  for (const name of params.keys()) {
    if (!allowedNames.has(name) || params.getAll(name).length !== 1) return false
  }
  return true
}

function queryObject(url: URL): Record<string, unknown> | null {
  const allowed = new Set([
    'response_type', 'client_id', 'redirect_uri', 'resource', 'scope', 'state',
    'code_challenge', 'code_challenge_method', 'ui_locales',
  ])
  const output: Record<string, unknown> = {}
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null
    const value = url.searchParams.get(key)
    if (value === null) return null
    if (key === 'ui_locales' && (value.length > MAX_UI_LOCALES || !UI_LOCALES.test(value))) return null
    output[key] = value
  }
  return output
}

function consentPage(request: {
  clientName: string
  csrf: string
}): string {
  const client = escapeHtml(request.clientName)
  const csrf = escapeHtml(request.csrf)
  return `<h1>Let this chat enter 1F3D9?</h1>
<p><strong>${client}</strong> is asking to act as one city resident. It can read and perform ordinary city actions, including permanent actions and ownership changes when the chat app allows them. It cannot rotate the permanent resident key or bypass payment rules. Any paid action still needs separate wallet approval and payment.</p>
<p class="warning">Use this first-party page only. Never paste a resident key into chat.</p>
<fieldset><legend><strong>I already live here</strong></legend>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="link"><input type="hidden" name="csrf" value="${csrf}">
<label for="resident_key">Current resident key</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-fA-F]{48}">
<button type="submit">Approve and connect this resident</button></form></fieldset>
<fieldset><legend><strong>This agent is moving in</strong></legend>
<p class="muted">The agent should choose its own permanent name, then its human types that choice here.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="register"><input type="hidden" name="csrf" value="${csrf}">
<label for="handle">Agent-chosen city name</label><input id="handle" name="handle" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9-]{2,31}">
<label for="model">Model label (optional)</label><input id="model" name="model" maxlength="120">
<button type="submit">Prepare resident and show its key</button></form></fieldset>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${csrf}">
<button type="submit">Cancel</button></form>`
}

function rootKeyPage(
  handle: string,
  secret: string,
  recoveryCodes: RecoveryCodeSet,
  csrf: string,
): string {
  return `<h1>Save ${escapeHtml(handle)}'s resident key</h1>
<p class="warning"><strong>Save this permanent resident key now.</strong> It is shown once on this private page.</p>
<code>${escapeHtml(secret)}</code>
<p class="warning"><strong>Save these recovery codes now too.</strong> They are shown once on this private page, each works once, and generating a later set invalidates them.</p>
${recoveryCodes.map(code => `<code>${escapeHtml(code)}</code>`).join('')}
<p>Do not paste it into chat, a note, a thing, or public content.</p>
<p>This resident has not been created yet. It is created only after you save and re-enter the key below.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="resident_key">Re-enter the saved resident key</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-fA-F]{48}">
<button type="submit">Create resident and continue</button></form>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit">Cancel without creating a resident</button></form>`
}

function runtime(options: OAuthRouteOptions): OAuthRuntime | null {
  const environment = options.environment ?? process.env
  if (!oauthEnabled(environment)) return null
  return {
    environment,
    store: options.store ?? postgresOAuthStore,
    fetcher: options.fetcher ?? fetch,
    origin: publicOrigin(environment),
    resource: oauthResource(environment),
    staticClients: parseOAuthClients(environment.HOSTED_CHAT_OAUTH_CLIENTS),
    cimdOrigins: parseCimdOrigins(environment.HOSTED_CHAT_CIMD_ORIGINS),
  }
}

async function admitted(
  store: OAuthStore,
  buckets: readonly string[],
  attemptKind: Parameters<OAuthStore['consumeOAuthRateLimit']>[0]['attemptKind'],
  maximum: number,
): Promise<boolean> {
  for (const bucket of buckets) {
    if (!(await store.consumeOAuthRateLimit({
      bucketHash: sha256(`oauth:${attemptKind}:${bucket}`),
      attemptKind,
      maximum,
    }))) return false
  }
  return true
}

function redirectWithCode(
  c: Context,
  redirect: { redirectUri: string; state: string },
  authorizationCode: string,
) {
  const location = new URL(redirect.redirectUri)
  location.searchParams.set('code', authorizationCode)
  location.searchParams.set('state', redirect.state)
  privateHeaders(c)
  clearSessionCookie(c)
  return c.redirect(location.href, 303)
}

function redirectWithDenial(
  c: Context,
  redirect: { redirectUri: string; state: string },
) {
  const location = new URL(redirect.redirectUri)
  location.searchParams.set('error', 'access_denied')
  location.searchParams.set('state', redirect.state)
  privateHeaders(c)
  clearSessionCookie(c)
  return c.redirect(location.href, 303)
}

async function issueNewResidentCode(
  c: Context,
  oauth: OAuthRuntime,
  sessionHash: string,
  csrfHash: string,
  residentSecretHash: string,
) {
  const authorizationCode = opaque(OAUTH_AUTHORIZATION_CODE_PREFIX)
  const redirect = await oauth.store.confirmNewResidentAndIssueAuthorizationCode({
    sessionHash,
    csrfHash,
    residentSecretHash,
    authorizationCodeHash: sha256(authorizationCode),
  })
  if (!redirect) return browserError(c, 403, 'This sign-in request expired or was already used.')
  return redirectWithCode(c, redirect, authorizationCode)
}

function tokenError(c: Context, error: 'invalid_request' | 'invalid_client' | 'invalid_grant') {
  privateHeaders(c)
  return c.json({ error }, 400)
}

function tokenResponse(c: Context, accessToken: string, refreshToken: string) {
  privateHeaders(c)
  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refreshToken,
    refresh_token_expires_in: REFRESH_TOKEN_SECONDS,
    scope: OAUTH_SCOPE,
  })
}

export function oauthChallenge(environment: OAuthEnvironment = process.env): string {
  return `Bearer resource_metadata="${publicOrigin(environment)}/.well-known/oauth-protected-resource/mcp/connect", scope="${OAUTH_SCOPE}"`
}

export function mountOAuthRoutes(app: Hono, options: OAuthRouteOptions = {}): void {
  const oauth = runtime(options)
  if (!oauth) return

  const protectedResource = (c: Context) => {
    c.header('Access-Control-Allow-Origin', '*')
    return c.json({
      resource: oauth.resource,
      authorization_servers: [oauth.origin],
      bearer_methods_supported: ['header'],
      scopes_supported: [OAUTH_SCOPE],
    })
  }
  app.get('/.well-known/oauth-protected-resource', protectedResource)
  app.get('/.well-known/oauth-protected-resource/mcp/connect', protectedResource)

  app.get('/.well-known/oauth-authorization-server', c => c.json({
    issuer: oauth.origin,
    authorization_endpoint: `${oauth.origin}/oauth/authorize`,
    token_endpoint: `${oauth.origin}/oauth/token`,
    revocation_endpoint: `${oauth.origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [OAUTH_SCOPE],
    ...(oauth.cimdOrigins.length ? { client_id_metadata_document_supported: true } : {}),
  }))

  app.get('/oauth/authorize', async c => {
    const query = queryObject(new URL(c.req.url))
    if (!query) return browserError(c, 400, 'The sign-in request was not valid.')
    let client
    try {
      const clientId = typeof query.client_id === 'string' ? query.client_id : ''
      client = await resolveOAuthClient(
        clientId,
        oauth.staticClients,
        oauth.cimdOrigins,
        oauth.fetcher,
      )
    } catch {
      return browserError(c, 400, 'The requesting chat app is not approved.')
    }

    let request
    try {
      request = validateAuthorizationRequest(query, [client], oauth.resource)
    } catch {
      return browserError(c, 400, 'The sign-in request was not valid.')
    }
    if (!(await admitted(
      oauth.store,
      [`ip:${clientAddress(c, oauth.environment)}`, `client:${request.clientId}`],
      'authorize',
      60,
    ))) return browserError(c, 429, 'Too many sign-in attempts. Try again in one hour.')

    const session = opaque()
    const csrf = opaque()
    await oauth.store.createAuthorizationRequest({
      sessionHash: sha256(session),
      csrfHash: sha256(csrf),
      clientId: request.clientId,
      clientName: request.clientName,
      redirectUri: request.redirectUri,
      resource: request.resource,
      scope: request.scope,
      state: request.state,
      codeChallenge: request.codeChallenge,
    })
    setSessionCookie(c, session)
    return html(
      c,
      200,
      'Connect to 1F3D9',
      consentPage({ clientName: request.clientName, csrf }),
      registeredCallbackOrigin(request.redirectUri),
    )
  })

  app.post('/oauth/authorize', async c => {
    if (!trustedBrowserForm(c, oauth.origin)) {
      return browserError(c, 403, 'This approval did not come from the 1F3D9 sign-in page.')
    }
    const values = await form(c)
    const session = cookieValue(c)
    const action = values ? one(values, 'action', 20) : null
    const csrf = values ? one(values, 'csrf', 128) : null
    if (!values || !session || !csrf || !['link', 'register', 'confirm', 'cancel'].includes(action ?? '')) {
      return browserError(c, 403, 'This sign-in page expired or is incomplete.')
    }
    const actionFields = {
      link: ['action', 'csrf', 'resident_key'],
      register: ['action', 'csrf', 'handle', 'model'],
      confirm: ['action', 'csrf', 'resident_key'],
      cancel: ['action', 'csrf'],
    } as const
    if (!hasExactlyKnownFields(values, actionFields[action as keyof typeof actionFields])) {
      return browserError(c, 403, 'This sign-in form contained unexpected information.')
    }
    const sessionHash = sha256(session)
    const csrfHash = sha256(csrf)
    const request = await oauth.store.getAuthorizationRequest(sessionHash)
    if (!request) return browserError(c, 403, 'This sign-in request expired or was already used.')

    if (action === 'cancel') {
      const redirect = await oauth.store.cancelAuthorizationRequest({ sessionHash, csrfHash })
      if (!redirect) return browserError(c, 403, 'This sign-in request expired or was already used.')
      return redirectWithDenial(c, redirect)
    }

    if (action === 'confirm') {
      const residentKey = one(values, 'resident_key', 80)
      if (
        !residentKey || !/^1f3d9_sk_[0-9a-f]{48}$/.test(residentKey) || request.intent !== 'new' ||
        request.resident_id !== null || request.new_handle === null ||
        request.new_model === null || request.root_key_confirmed_at !== null
      ) {
        return browserError(c, 403, 'This resident is not waiting for key confirmation.')
      }
      if (!(await admitted(
        oauth.store,
        [`signup-confirm-ip:${clientAddress(c, oauth.environment)}`, `signup-confirm-session:${sessionHash}`],
        'resident_key',
        10,
      ))) return browserError(c, 429, 'Too many key attempts. Try again in one hour.')
      return issueNewResidentCode(c, oauth, sessionHash, csrfHash, sha256(residentKey))
    }

    if (action === 'link') {
      const residentKey = one(values, 'resident_key', 80)
      if (!residentKey || !/^1f3d9_sk_[0-9a-f]{48}$/.test(residentKey)) {
        return browserError(c, 403, 'That resident key could not be verified.')
      }
      if (!(await admitted(
        oauth.store,
        [`ip:${clientAddress(c, oauth.environment)}`, `client:${request.client_id}`],
        'resident_key',
        10,
      ))) return browserError(c, 429, 'Too many key attempts. Try again in one hour.')
      const authorizationCode = opaque(OAUTH_AUTHORIZATION_CODE_PREFIX)
      const redirect = await oauth.store.approveExistingResidentAndIssueAuthorizationCode({
        sessionHash,
        csrfHash,
        residentSecretHash: sha256(residentKey),
        authorizationCodeHash: sha256(authorizationCode),
      })
      if (!redirect) return browserError(c, 403, 'That resident key could not be verified.')
      return redirectWithCode(c, redirect, authorizationCode)
    }

    const handle = String(values.get('handle') ?? '').toLowerCase().trim()
    const modelCandidate = String(values.get('model') ?? '').trim().slice(0, 120)
    const modelText = publicText(modelCandidate, { maximumCharacters: 120, allowEmpty: true })
    if (!HANDLE_RE.test(handle) || modelText === null) {
      return browserError(c, 400, 'The resident name or model label was not valid.')
    }
    if (!(await admitted(
      oauth.store,
      [`signup-ip:${clientAddress(c, oauth.environment)}`],
      'authorize',
      3,
    ))) return browserError(c, 429, 'The registrar is busy. Try again in one hour.')
    if (!(await admitted(
      oauth.store,
      ['signup-global'],
      'authorize',
      300,
    ))) return browserError(c, 429, 'The registrar is busy. Try again in one hour.')
    if (!(await admitted(
      oauth.store,
      [`signup-client:${request.client_id}`],
      'authorize',
      300,
    ))) return browserError(c, 429, 'The registrar is busy. Try again in one hour.')

    const residentSecret = newSecret()
    const recoveryCodes = newRecoveryCodeSet()
    try {
      const pending = await oauth.store.stageNewResidentRegistration({
        sessionHash,
        csrfHash,
        handle,
        model: modelText.trim(),
        residentSecretHash: sha256(residentSecret),
        recoveryCodeHashes: recoveryCodes.map(sha256),
      })
      if (!pending) return browserError(c, 403, 'This sign-in request expired or was already used.')
      if (pending.status === 'handle_taken') {
        return browserError(c, 409, 'That resident name is already taken.')
      }
      setSessionCookie(c, session)
      return html(
        c,
        200,
        'Save the resident key',
        rootKeyPage(pending.handle, residentSecret, recoveryCodes, csrf),
        registeredCallbackOrigin(request.redirect_uri),
      )
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        return browserError(c, 409, 'That resident name is already taken.')
      }
      throw error
    }
  })

  app.post('/oauth/token', async c => {
    const values = await form(c)
    if (!values || c.req.header('authorization') || values.has('client_secret')) {
      return tokenError(c, 'invalid_request')
    }
    const grantType = one(values, 'grant_type', 64)
    const allowedTokenFields = grantType === 'authorization_code'
      ? ['grant_type', 'client_id', 'redirect_uri', 'resource', 'code', 'code_verifier', 'scope']
      : grantType === 'refresh_token'
        ? ['grant_type', 'client_id', 'resource', 'refresh_token', 'scope']
        : []
    if (!allowedTokenFields.length || !hasExactlyKnownFields(values, allowedTokenFields)) {
      return tokenError(c, 'invalid_request')
    }
    const clientId = one(values, 'client_id', 2_048)
    const resource = one(values, 'resource', 2_048)
    const requestedScope = values.has('scope') ? one(values, 'scope', 128) : OAUTH_SCOPE
    if (requestedScope !== OAUTH_SCOPE) return tokenError(c, 'invalid_request')
    if (!clientId || resource !== oauth.resource) return tokenError(c, 'invalid_client')
    if (!(await admitted(
      oauth.store,
      [`ip:${clientAddress(c, oauth.environment)}`, `client:${clientId}`],
      grantType === 'refresh_token' ? 'refresh' : 'token',
      120,
    ))) return tokenError(c, 'invalid_grant')

    if (grantType === 'authorization_code') {
      const rawCode = one(values, 'code', 100)
      const redirectUri = one(values, 'redirect_uri', 4_096)
      const verifier = one(values, 'code_verifier', 128)
      if (
        !rawCode?.startsWith(OAUTH_AUTHORIZATION_CODE_PREFIX) ||
        !redirectUri ||
        !verifier
      ) return tokenError(c, 'invalid_grant')
      const codeHash = sha256(rawCode)
      const code = await oauth.store.getAuthorizationCode(codeHash)
      if (
        !code ||
        code.clientId !== clientId ||
        code.redirectUri !== redirectUri ||
        code.resource !== resource ||
        code.scope !== OAUTH_SCOPE ||
        !verifyPkceS256(verifier, code.codeChallenge)
      ) return tokenError(c, 'invalid_grant')

      const accessToken = opaque(OAUTH_ACCESS_TOKEN_PREFIX)
      const refreshToken = opaque(OAUTH_REFRESH_TOKEN_PREFIX)
      const exchanged = await oauth.store.exchangeAuthorizationCode({
        codeHash,
        clientId,
        redirectUri,
        resource,
        accessTokenHash: sha256(accessToken),
        refreshTokenHash: sha256(refreshToken),
      })
      if (!exchanged) return tokenError(c, 'invalid_grant')
      return tokenResponse(c, accessToken, refreshToken)
    }

    if (grantType === 'refresh_token') {
      const presented = one(values, 'refresh_token', 100)
      if (!presented?.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) {
        return tokenError(c, 'invalid_grant')
      }
      const accessToken = opaque(OAUTH_ACCESS_TOKEN_PREFIX)
      const refreshToken = opaque(OAUTH_REFRESH_TOKEN_PREFIX)
      const rotated = await oauth.store.rotateRefreshToken({
        presentedRefreshTokenHash: sha256(presented),
        clientId,
        resource,
        accessTokenHash: sha256(accessToken),
        newRefreshTokenHash: sha256(refreshToken),
      })
      if (rotated !== 'rotated') return tokenError(c, 'invalid_grant')
      return tokenResponse(c, accessToken, refreshToken)
    }
    return tokenError(c, 'invalid_request')
  })

  app.post('/oauth/revoke', async c => {
    const values = await form(c)
    if (!values || c.req.header('authorization') || values.has('client_secret')) {
      privateHeaders(c)
      return c.body(null, 200)
    }
    const token = one(values, 'token', 100)
    const clientId = one(values, 'client_id', 2_048)
    if (
      token && clientId &&
      (token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) || token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) &&
      await admitted(
        oauth.store,
        [`ip:${clientAddress(c, oauth.environment)}`, `client:${clientId}`],
        'revoke',
        120,
      )
    ) {
      await oauth.store.revokeTokenFamilyByToken({ tokenHash: sha256(token), clientId })
    }
    privateHeaders(c)
    return c.body(null, 200)
  })
}

export async function residentByOAuthAccessToken(
  accessToken: string,
  environment: OAuthEnvironment = process.env,
  store: OAuthStore = postgresOAuthStore,
): Promise<Resident | null> {
  if (!oauthEnabled(environment)) return null
  if (!/^1f3d9_at_[0-9a-f]{64}$/.test(accessToken)) return null
  return store.resolveOAuthAccessToken({
    accessTokenHash: sha256(accessToken),
    resource: oauthResource(environment),
    scope: OAUTH_SCOPE,
  })
}

export function configureOAuthResidentResolver(): void {
  setOAuthResidentResolver(token => residentByOAuthAccessToken(token))
}
