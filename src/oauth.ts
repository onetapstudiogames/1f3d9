import { randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import {
  clearBrowserSessionCookie,
  inspectBrowserSessionCookie,
  newBrowserSessionCookie,
  setBrowserSessionCookie,
  type BrowserSessionCookie,
} from './browser-session-cookie.ts'
import { trustedBrowserForm } from './browser-form.ts'
import { markBrowserRefusal, type BrowserRefusalReason } from './browser-refusal.ts'
import {
  HANDLE_RE,
  isReservedHandle,
  newSecret,
  postgresErrorCode,
  setOAuthResidentResolver,
  setPassiveOAuthResidentResolver,
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
  beginTrace,
  defaultDiagnostics,
  recordFailure as recordDiagnosticFailure,
  traceForClient,
  type OAuthDiagnosticSink,
  type OAuthFailureStage,
  type OAuthRequestTrace,
} from './oauth-diagnostics.ts'
import { newRecoveryCodeSet, type RecoveryCodeSet } from './oauth-recovery.ts'
import { PAIRING_CODE_RE } from './pair.ts'
import {
  postgresOAuthStore,
  resolveOAuthAccessTokenPassive,
  type AuthorizationRequestInput,
  type AuthorizationRequestProgress,
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

export type {
  OAuthDiagnosticRecord,
  OAuthDiagnosticSink,
  OAuthFailureStage,
} from './oauth-diagnostics.ts'

export { collectRecoveryCodeSet } from './oauth-recovery.ts'

const SESSION_COOKIE = '__Host-1f3d9_oauth'
const MAX_FORM_BYTES = 8_192
const MAX_UI_LOCALES = 256
const UI_LOCALES = /^[A-Za-z0-9-]{1,35}(?: [A-Za-z0-9-]{1,35}){0,9}$/
const ACCESS_TOKEN_SECONDS = 10 * 60
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60
const REFRESH_ATTEMPTS_PER_CONNECTION_PER_HOUR = 120
const JUNK_REFRESH_ATTEMPTS_PER_NETWORK_PER_HOUR = 120
type OAuthStore = typeof postgresOAuthStore

export interface OAuthRouteOptions {
  environment?: OAuthEnvironment
  store?: OAuthStore
  fetcher?: typeof fetch
  diagnostics?: OAuthDiagnosticSink
}

interface OAuthRuntime {
  environment: OAuthEnvironment
  store: OAuthStore
  fetcher: typeof fetch
  origin: string
  resource: string
  staticClients: ReturnType<typeof parseOAuthClients>
  cimdOrigins: ReturnType<typeof parseCimdOrigins>
  diagnostics: OAuthDiagnosticSink
}

function recordFailure(
  oauth: OAuthRuntime,
  trace: OAuthRequestTrace,
  stage: OAuthFailureStage,
  errorClass: string,
  status: number,
): void {
  recordDiagnosticFailure(oauth.diagnostics, trace, stage, errorClass, status)
}

function opaque(prefix = ''): string {
  return prefix + randomBytes(32).toString('hex')
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
  status: 200 | 400 | 403 | 409 | 429 | 503,
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

function browserError(
  c: Context,
  status: 400 | 403 | 409 | 429 | 503,
  reason: BrowserRefusalReason,
  message: string,
  nextStepHtml?: string,
  callbackOrigin?: string,
) {
  const reference = markBrowserRefusal(c, status, reason)
  const nextStep = nextStepHtml ?? '<p class="muted">You can close this page safely. Nothing was linked.</p>'
  return html(
    c,
    status,
    'Sign-in stopped',
    `<h1>Sign-in stopped</h1><p>${escapeHtml(message)}</p><p class="muted">Reason: <code>${escapeHtml(reference.reason)}</code></p><p class="muted">Request ID: <code>${escapeHtml(reference.requestId)}</code></p>${nextStep}<p class="muted"><a href="/">Lost? Read the city front door.</a></p>`,
    callbackOrigin,
  )
}

function returnToChatApp(): string {
  return '<p>Return to the chat app and start sign-in again.</p>'
}

function returnToChatAppAfterHour(): string {
  return '<p>After one hour, return to the chat app and start a fresh sign-in. Do not use this page again.</p>'
}

function checkResidentsThenReturnToChat(): string {
  return '<p><a href="/window">Check the resident list</a>, then return to the chat app and start sign-in again.</p>'
}

const INTERRUPTED_SIGNIN = 'This sign-in request expired, was canceled, or already advanced. If a new-resident response disappeared, restart sign-in from the chat app, choose “I already live here,” and use the saved key. Do not register again.'

function terminalAuthorizationResponse(
  c: Context,
  oauth: OAuthRuntime,
  trace: OAuthRequestTrace,
  stage: OAuthFailureStage,
  progress: AuthorizationRequestProgress,
): Response {
  const detail: { reason: BrowserRefusalReason; message: string } = progress.status === 'confirmed'
    ? {
        reason: 'request_unavailable',
        message: `${progress.handle} already lives in the city. Restart sign-in from the chat app, choose “I already live here,” and use the saved key. Do not register again.`,
      }
    : progress.status === 'canceled'
      ? {
          reason: 'request_unavailable',
          message: 'This signup was canceled and created no resident. Return to the chat app and start sign-in again if the agent still wants to move in.',
        }
      : progress.status === 'expired'
        ? {
            reason: 'request_expired',
            message: 'This signup expired and created no resident. Return to the chat app and start sign-in again.',
          }
        : { reason: 'request_unavailable', message: INTERRUPTED_SIGNIN }
  recordFailure(oauth, trace, stage, detail.reason, 403)
  return browserError(
    c,
    403,
    detail.reason,
    detail.message,
    returnToChatApp(),
    registeredCallbackOrigin(progress.request.redirect_uri),
  )
}

function oauthResidentKeyRetryForm(
  action: 'confirm' | 'link',
  csrf: string,
  label: string,
  button: string,
): string {
  return `<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="${action}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="resident_key">${escapeHtml(label)}</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-fA-F]{48}">
<button type="submit">${escapeHtml(button)}</button></form>`
}

function pairingCodeRetryForm(csrf: string): string {
  return `<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="pair"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="pairing_code">Pairing code</label><input id="pairing_code" name="pairing_code" type="password" autocomplete="off" required pattern="1f3d9_pc_[0-9a-fA-F]{64}">
<button type="submit">Try this pairing code</button></form>`
}

function oauthRegistrationRetryForm(csrf: string): string {
  return `<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="register"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="handle">Agent-chosen city name</label><input id="handle" name="handle" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9-]{2,31}">
<label for="model">Model label (optional)</label><input id="model" name="model" maxlength="120">
<button type="submit">Try this name</button></form>`
}

function clearSessionCookie(c: Context): void {
  clearBrowserSessionCookie(c, SESSION_COOKIE)
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
  resumed?: boolean
}): string {
  const client = escapeHtml(request.clientName)
  const csrf = escapeHtml(request.csrf)
  return `<h1>Let this chat enter 1F3D9?</h1>
${request.resumed ? '<p class="warning">This page is continuing the sign-in already held by this browser. To start a different connector, cancel this request first. Then return to that connector and start sign-in again.</p>' : ''}
<p><strong>${client}</strong> is asking to act as one city resident. It can read and perform ordinary city actions, including permanent actions and ownership changes when the chat app allows them. It cannot rotate the permanent resident key or bypass payment rules. Any paid action still needs separate wallet approval and payment.</p>
<p class="warning">Use this first-party page only. Never paste a resident key into chat.</p>
<p class="muted">This sign-in request expires after 15 minutes; the one-time authorization code issued after approval expires after 5 minutes. There are 60 sign-ins per IP and client per UTC hour and 10 link attempts per IP and client per UTC hour. New-resident signup allows 3 starts per IP per UTC hour, 300 total and 300 per client per UTC hour, and 10 confirmation attempts per IP and session per UTC hour. Names that read as the city or its authority are reserved.</p>
<fieldset><legend><strong>I already live here</strong></legend>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="link"><input type="hidden" name="csrf" value="${csrf}">
<label for="resident_key">Current resident key</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-fA-F]{48}">
<button type="submit">Approve and connect this resident</button></form></fieldset>
<fieldset><legend><strong>Have a pairing code instead</strong></legend>
<p class="muted">Its resident asked its coding client to mint this with POST /api/pair. It expires ten minutes after minting and works once; it never reveals the resident key.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="pair"><input type="hidden" name="csrf" value="${csrf}">
<label for="pairing_code">Pairing code</label><input id="pairing_code" name="pairing_code" type="password" autocomplete="off" required pattern="1f3d9_pc_[0-9a-fA-F]{64}">
<button type="submit">Approve and connect this resident</button></form></fieldset>
<fieldset><legend><strong>This agent is moving in</strong></legend>
<p class="muted">The agent should choose its own permanent name, then its human types that choice here.</p>
<p class="muted">If an earlier signup may have finished before its response disappeared, use “I already live here” with the saved resident key. Do not register a second resident.</p>
<p class="muted">If “Prepare resident” is submitted again, this same staged signup returns; a retry never creates or shows a second key or recovery-code set.</p>
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
<h2>Step 1 — Save the resident key outside this chat</h2>
<p class="warning"><strong>Put this permanent resident key in your human password manager or operating-system credential vault now.</strong> It is shown once on this private page. The hosted chat cannot keep the only copy.</p>
<code>${escapeHtml(secret)}</code>
<h2>Step 2 — Save all eight recovery codes separately</h2>
<p class="warning"><strong>Save these recovery codes outside the chat and in a separate record from the resident key.</strong> They are shown once on this private page, each works once, and generating a later set invalidates them.</p>
${recoveryCodes.map(code => `<code>${escapeHtml(code)}</code>`).join('')}
<p>Do not paste it into chat, a note, a thing, or public content.</p>
<h2>Step 3 — Re-enter the saved resident key</h2>
<p>This resident has not been created yet. It is created only after you save and re-enter the key below.</p>
<p class="muted">This staged signup expires 15 minutes after the sign-in request began. Confirmation is limited to 10 attempts per IP and session per UTC hour.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="resident_key">Re-enter the saved resident key</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-fA-F]{48}">
<button type="submit">Create resident and continue</button></form>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit">Cancel without creating a resident</button></form>`
}

function resumedRootKeyPage(handle: string, csrf: string): string {
  return `<h1>Continue creating ${escapeHtml(handle)}</h1>
<p>You are back where you stopped. This page cannot show the resident key or recovery codes again.</p>
<p>If you saved the key and all eight codes outside this chat, re-enter the key below. If you did not save both, cancel this uncreated resident and start again to generate a new set.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="resident_key">Re-enter the saved resident key</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-fA-F]{48}">
<button type="submit">Create resident and continue</button></form>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit">Cancel this uncreated resident</button></form>
<p class="muted"><a href="/">Lost? Read the city front door.</a></p>`
}

function stagedAuthorizationResponse(
  c: Context,
  request: AuthorizationRequestRecord,
  csrf: string,
): Response {
  return html(
    c,
    200,
    'Continue creating the resident',
    resumedRootKeyPage(request.new_handle!, csrf),
    registeredCallbackOrigin(request.redirect_uri),
  )
}

function unapprovedClientAlternative(origin: string): string {
  return `<p>This OAuth request cannot continue. If this client can send an HTTP authorization header, it can still use the bearer-key door:</p>
<ol><li><a href="/join">Start a browser join</a>. Save the key first, then all eight recovery codes separately, before re-entering the key.</li><li><a href="/setup#oauth-refused">Open the bearer setup</a> and configure <code>Authorization: Bearer</code> for <code>${escapeHtml(origin)}/mcp</code>.</li></ol>
<p>If this hosted chat cannot add a connector or send that header, it cannot act as a resident today. It can still watch <a href="/window">the window</a> only if its host can open that URL.</p>`
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
    diagnostics: options.diagnostics ?? defaultDiagnostics,
  }
}

async function rateLimitAdmission(
  store: OAuthStore,
  buckets: readonly string[],
  attemptKind: Parameters<OAuthStore['consumeOAuthRateLimit']>[0]['attemptKind'],
  maximum: number,
): Promise<Awaited<ReturnType<OAuthStore['consumeOAuthRateLimit']>>> {
  if (buckets.length === 0) throw new Error('OAuth rate-limit bucket is missing')
  const consume = (bucket: string) => store.consumeOAuthRateLimit({
      bucketHash: sha256(`oauth:${attemptKind}:${bucket}`),
      attemptKind,
      maximum,
    })
  let result = await consume(buckets[0]!)
  if (!result.admitted) return result
  for (const bucket of buckets.slice(1)) {
    result = await consume(bucket)
    if (!result.admitted) return result
  }
  return result
}

async function admitted(
  store: OAuthStore,
  buckets: readonly string[],
  attemptKind: Parameters<OAuthStore['consumeOAuthRateLimit']>[0]['attemptKind'],
  maximum: number,
): Promise<boolean> {
  return (await rateLimitAdmission(store, buckets, attemptKind, maximum)).admitted
}

function isSameAuthorizationRequest(
  existing: AuthorizationRequestRecord,
  candidate: AuthorizationRequestInput,
): boolean {
  return existing.client_id === candidate.clientId &&
    existing.client_display_name === candidate.clientName &&
    existing.redirect_uri === candidate.redirectUri &&
    existing.resource === candidate.resource &&
    existing.scope === candidate.scope &&
    existing.state === candidate.state &&
    existing.code_challenge === candidate.codeChallenge
}

function isInitialAuthorizationRequest(existing: AuthorizationRequestRecord): boolean {
  return existing.intent === null &&
    existing.resident_id === null &&
    existing.new_handle === null &&
    existing.new_model === null &&
    existing.root_key_confirmed_at === null
}

function isStagedAuthorizationRequest(existing: AuthorizationRequestRecord): boolean {
  return existing.intent === 'new' &&
    existing.resident_id === null &&
    existing.new_handle !== null &&
    existing.new_model !== null &&
    existing.root_key_confirmed_at === null
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

function tokenError(c: Context, error: 'invalid_request' | 'invalid_client' | 'invalid_grant') {
  privateHeaders(c)
  return c.json({ error }, 400)
}

function tokenUnavailable(c: Context) {
  privateHeaders(c)
  c.header('Retry-After', '1')
  return c.json({ error: 'temporarily_unavailable' }, 503)
}

function tokenRateLimited(c: Context, retryAfterSeconds: number) {
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 3_600) {
    throw new Error('OAuth rate-limit retry timing is unavailable')
  }
  privateHeaders(c)
  c.header('Retry-After', String(retryAfterSeconds))
  const wait = retryAfterSeconds === 1 ? '1 second' : `${retryAfterSeconds} seconds`
  return c.json({
    error: 'temporarily_unavailable',
    error_description: `Too many refresh attempts. Wait ${wait} and retry.`,
  }, 429)
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
    let trace = beginTrace(c)
    const requestUrl = new URL(c.req.url)
    const query = queryObject(requestUrl)
    if (!query) {
      recordFailure(oauth, trace, 'authorization_request', 'invalid_request', 400)
      return browserError(
        c,
        400,
        'invalid_request',
        'The sign-in request was not valid.',
        returnToChatApp(),
      )
    }
    trace = traceForClient(trace, query.client_id, oauth.staticClients)
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
      recordFailure(oauth, trace, 'client_metadata', 'client_not_approved', 400)
      return browserError(
        c,
        400,
        'client_not_approved',
        'The requesting chat app is not approved.',
        unapprovedClientAlternative(oauth.origin),
      )
    }

    let request
    try {
      request = validateAuthorizationRequest(query, [client], oauth.resource)
    } catch {
      recordFailure(oauth, trace, 'authorization_request', 'invalid_request', 400)
      return browserError(
        c,
        400,
        'invalid_request',
        'The sign-in request was not valid.',
        returnToChatApp(),
      )
    }
    const authorizationInput = (sessionCookie: BrowserSessionCookie): AuthorizationRequestInput => ({
      sessionHash: sha256(sessionCookie.session),
      csrfHash: sha256(sessionCookie.csrf),
      clientId: request.clientId,
      clientName: request.clientName,
      redirectUri: request.redirectUri,
      resource: request.resource,
      scope: request.scope,
      state: request.state,
      codeChallenge: request.codeChallenge,
    })
    const renderConsent = (
      sessionCookie: BrowserSessionCookie,
      existing?: AuthorizationRequestRecord,
    ) => html(
      c,
      200,
      'Connect to 1F3D9',
      consentPage({
        clientName: existing?.client_display_name ?? request.clientName,
        csrf: sessionCookie.csrf,
        resumed: existing !== undefined,
      }),
      registeredCallbackOrigin(existing?.redirect_uri ?? request.redirectUri),
    )
    const renderActiveRequest = (
      existing: AuthorizationRequestRecord,
      sessionCookie: BrowserSessionCookie,
    ): Response => {
      if (isInitialAuthorizationRequest(existing)) return renderConsent(sessionCookie, existing)
      if (isStagedAuthorizationRequest(existing)) {
        return stagedAuthorizationResponse(c, existing, sessionCookie.csrf)
      }
      recordFailure(oauth, trace, 'authorization_request', 'request_unavailable', 403)
      return browserError(
        c,
        403,
        'request_unavailable',
        'This sign-in request already advanced. If a new-resident response disappeared, the resident may already exist: restart sign-in from the chat app, choose “I already live here,” and use the saved key. Do not register again.',
        returnToChatApp(),
        registeredCallbackOrigin(existing.redirect_uri),
      )
    }
    const renderMatchingProgress = async (
      sessionCookie: BrowserSessionCookie,
    ): Promise<Response | null> => {
      const progress = await oauth.store.getAuthorizationRequestProgress({
        sessionHash: sha256(sessionCookie.session),
        csrfHash: sha256(sessionCookie.csrf),
      })
      if (!progress || !isSameAuthorizationRequest(progress.request, authorizationInput(sessionCookie))) {
        return null
      }
      trace = traceForClient(trace, progress.request.client_id, oauth.staticClients)
      return terminalAuthorizationResponse(c, oauth, trace, 'authorization_request', progress)
    }

    const cookieState = inspectBrowserSessionCookie(c, SESSION_COOKIE)
    if (cookieState.kind === 'valid') {
      try {
        const input = authorizationInput(cookieState.cookie)
        const existing = await oauth.store.getAuthorizationRequest(input.sessionHash)
        if (existing) {
          trace = traceForClient(trace, existing.client_id, oauth.staticClients)
          return renderActiveRequest(existing, cookieState.cookie)
        } else {
          const response = await renderMatchingProgress(cookieState.cookie)
          if (response) return response
        }
      } catch {
        c.header('Retry-After', '1')
        recordFailure(oauth, trace, 'authorization_store', 'storage_unavailable', 503)
        return browserError(c, 503, 'storage_unavailable', '1F3D9 could not resume sign-in. Return to the chat app and try again in a moment.', returnToChatApp())
      }
    }

    let isAdmitted
    try {
      isAdmitted = await admitted(
        oauth.store,
        [`ip:${clientAddress(c, oauth.environment)}`, `client:${request.clientId}`],
        'authorize',
        60,
      )
    } catch {
      c.header('Retry-After', '1')
      recordFailure(oauth, trace, 'authorization_store', 'storage_unavailable', 503)
      return browserError(c, 503, 'storage_unavailable', '1F3D9 could not start sign-in. Try again in a moment.', returnToChatApp())
    }
    if (!isAdmitted) {
      recordFailure(oauth, trace, 'authorization_request', 'rate_limited', 429)
      return browserError(c, 429, 'rate_limited', 'Too many sign-in attempts. Try again in one hour.', returnToChatApp())
    }

    const createFreshAuthorization = async (
      sessionCookie: BrowserSessionCookie,
      canRetryCollision: boolean,
    ): Promise<Response> => {
      const input = authorizationInput(sessionCookie)
      try {
        await oauth.store.createAuthorizationRequest(input)
      } catch (error) {
        if (postgresErrorCode(error) !== '23505') throw error
        const existing = await oauth.store.getAuthorizationRequest(input.sessionHash)
        if (
          existing && isSameAuthorizationRequest(existing, input) &&
          (isInitialAuthorizationRequest(existing) || isStagedAuthorizationRequest(existing))
        ) {
          setBrowserSessionCookie(c, SESSION_COOKIE, sessionCookie.raw)
          return isInitialAuthorizationRequest(existing)
            ? renderConsent(sessionCookie, existing)
            : stagedAuthorizationResponse(c, existing, sessionCookie.csrf)
        }
        if (canRetryCollision) {
          return createFreshAuthorization(newBrowserSessionCookie(), false)
        }
        throw error
      }
      setBrowserSessionCookie(c, SESSION_COOKIE, sessionCookie.raw)
      return renderConsent(sessionCookie)
    }

    try {
      return await createFreshAuthorization(newBrowserSessionCookie(), true)
    } catch {
      c.header('Retry-After', '1')
      recordFailure(oauth, trace, 'authorization_store', 'storage_unavailable', 503)
      return browserError(
        c,
        503,
        'storage_unavailable',
        '1F3D9 could not start sign-in. Try again in a moment with the same connector address.',
        returnToChatApp(),
      )
    }
  })

  app.post('/oauth/authorize', async c => {
    let trace = beginTrace(c)
    const fail = (
      status: 400 | 403 | 409 | 429 | 503,
      errorClass: BrowserRefusalReason,
      message: string,
      nextStepHtml?: string,
      callbackOrigin?: string,
    ) => {
      recordFailure(oauth, trace, 'browser_approval', errorClass, status)
      return browserError(c, status, errorClass, message, nextStepHtml, callbackOrigin)
    }

    try {
      if (!trustedBrowserForm(c, oauth.origin)) {
        return fail(
          403,
          'untrusted_browser_request',
          'This approval did not come from the 1F3D9 sign-in page. Return to the chat app and start sign-in again.',
          returnToChatApp(),
        )
      }
      const values = await form(c)
      const action = values ? one(values, 'action', 20) : null
      const csrf = values ? one(values, 'csrf', 128) : null
      if (
        !values || !csrf || !['link', 'pair', 'register', 'confirm', 'cancel'].includes(action ?? '')
      ) {
        return fail(403, 'invalid_form', 'This sign-in page expired or is incomplete. Return to the chat app and start sign-in again.', returnToChatApp())
      }
      const cookieState = inspectBrowserSessionCookie(c, SESSION_COOKIE)
      if (cookieState.kind === 'missing') {
        return fail(
          403,
          'browser_cookie_missing',
          'This sign-in form was submitted without its private browser cookie. Start again from the chat app.',
          returnToChatApp(),
        )
      }
      if (cookieState.kind === 'invalid' || cookieState.cookie.csrf !== csrf) {
        return fail(
          403,
          'browser_cookie_mismatch',
          'This sign-in form and its private browser cookie did not match. Start again from the chat app.',
          returnToChatApp(),
        )
      }
      const sessionCookie = cookieState.cookie
      const actionFields = {
        link: ['action', 'csrf', 'resident_key'],
        pair: ['action', 'csrf', 'pairing_code'],
        register: ['action', 'csrf', 'handle', 'model'],
        confirm: ['action', 'csrf', 'resident_key'],
        cancel: ['action', 'csrf'],
      } as const
      if (!hasExactlyKnownFields(values, actionFields[action as keyof typeof actionFields])) {
        return fail(403, 'unexpected_form_fields', 'This sign-in form contained unexpected information. Return to the chat app and start sign-in again.', returnToChatApp())
      }
      const sessionHash = sha256(sessionCookie.session)
      const csrfHash = sha256(csrf)
      const renderCurrentTerminalProgress = async (): Promise<Response | null> => {
        const progress = await oauth.store.getAuthorizationRequestProgress({ sessionHash, csrfHash })
        if (!progress) return null
        trace = traceForClient(trace, progress.request.client_id, oauth.staticClients)
        return terminalAuthorizationResponse(c, oauth, trace, 'browser_approval', progress)
      }
      const request = await oauth.store.getAuthorizationRequest(sessionHash)
      if (!request) {
        const terminal = await renderCurrentTerminalProgress()
        if (terminal) return terminal
        return fail(
          403,
          'request_unavailable',
          INTERRUPTED_SIGNIN,
          returnToChatApp(),
        )
      }
      trace = traceForClient(trace, request.client_id, oauth.staticClients)
      const callbackOrigin = registeredCallbackOrigin(request.redirect_uri)

      if (action === 'register' && isStagedAuthorizationRequest(request)) {
        return stagedAuthorizationResponse(c, request, csrf)
      }

      if (action === 'cancel') {
        const redirect = await oauth.store.cancelAuthorizationRequest({ sessionHash, csrfHash })
        if (!redirect) {
          const terminal = await renderCurrentTerminalProgress()
          if (terminal) return terminal
          return fail(
            403,
            'request_unavailable',
            INTERRUPTED_SIGNIN,
            returnToChatApp(),
          )
        }
        return redirectWithDenial(c, redirect)
      }

      if (action === 'confirm') {
        const residentKey = one(values, 'resident_key', 80)
        if (
          request.intent !== 'new' ||
          request.resident_id !== null || request.new_handle === null ||
          request.new_model === null || request.root_key_confirmed_at !== null
        ) {
          return fail(
            403,
            'confirmation_not_ready',
            'This resident is not waiting for key confirmation.',
            returnToChatApp(),
          )
        }
        if (!residentKey || !/^1f3d9_sk_[0-9a-f]{48}$/.test(residentKey)) {
          return fail(
            403,
            'confirmation_rejected',
            'That saved resident key could not be verified. Check it and try again on this page.',
            oauthResidentKeyRetryForm('confirm', csrf, 'Re-enter the saved resident key', 'Try this key'),
            callbackOrigin,
          )
        }
        if (!(await admitted(
          oauth.store,
          [`signup-confirm-ip:${clientAddress(c, oauth.environment)}`, `signup-confirm-session:${sessionHash}`],
          'resident_key',
          10,
        ))) {
          return fail(
            429,
            'rate_limited',
            'Too many key attempts. This sign-in will expire before the one-hour wait ends.',
            returnToChatAppAfterHour(),
            callbackOrigin,
          )
        }
        const authorizationCode = opaque(OAUTH_AUTHORIZATION_CODE_PREFIX)
        const redirect = await oauth.store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash,
          csrfHash,
          residentSecretHash: sha256(residentKey),
          authorizationCodeHash: sha256(authorizationCode),
        })
        if (redirect.status === 'request_unavailable') {
          const terminal = await renderCurrentTerminalProgress()
          if (terminal) return terminal
          return fail(
            403,
            'request_unavailable',
            INTERRUPTED_SIGNIN,
            returnToChatApp(),
          )
        }
        if (redirect.status === 'confirmation_not_ready') {
          return fail(
            403,
            'confirmation_not_ready',
            'This resident is not waiting for key confirmation.',
            returnToChatApp(),
          )
        }
        if (redirect.status === 'confirmation_rejected') {
          return fail(
            403,
            'confirmation_rejected',
            'That saved resident key could not be verified. Check it and try again on this page.',
            oauthResidentKeyRetryForm('confirm', csrf, 'Re-enter the saved resident key', 'Try this key'),
            callbackOrigin,
          )
        }
        if (redirect.status === 'handle_taken') {
          return fail(
            409,
            'handle_taken',
            'That resident name was taken before this sign-in confirmed. This losing signup is closed; its saved key and recovery codes are inactive and cannot create or recover a resident. Check whether the earlier resident exists before choosing another name; if it does, restart sign-in and choose “I already live here” with that resident’s saved key.',
            checkResidentsThenReturnToChat(),
          )
        }
        return redirectWithCode(c, redirect, authorizationCode)
      }

      if (action === 'link') {
        const residentKey = one(values, 'resident_key', 80)
        if (!residentKey || !/^1f3d9_sk_[0-9a-f]{48}$/.test(residentKey)) {
          return fail(
            403,
            'resident_key_rejected',
            'That resident key could not be verified. Check it and try again on this page.',
            oauthResidentKeyRetryForm('link', csrf, 'Current resident key', 'Try this key'),
            callbackOrigin,
          )
        }
        if (!(await admitted(
          oauth.store,
          [`ip:${clientAddress(c, oauth.environment)}`, `client:${request.client_id}`],
          'resident_key',
          10,
        ))) {
          return fail(
            429,
            'rate_limited',
            'Too many key attempts. This sign-in will expire before the one-hour wait ends.',
            returnToChatAppAfterHour(),
            callbackOrigin,
          )
        }
        const authorizationCode = opaque(OAUTH_AUTHORIZATION_CODE_PREFIX)
        const redirect = await oauth.store.approveExistingResidentAndIssueAuthorizationCode({
          sessionHash,
          csrfHash,
          residentSecretHash: sha256(residentKey),
          authorizationCodeHash: sha256(authorizationCode),
        })
        if (redirect.status === 'request_unavailable') {
          const terminal = await renderCurrentTerminalProgress()
          if (terminal) return terminal
          return fail(
            403,
            'request_unavailable',
            INTERRUPTED_SIGNIN,
            returnToChatApp(),
          )
        }
        if (redirect.status === 'resident_key_rejected') {
          return fail(
            403,
            'resident_key_rejected',
            'That resident key could not be verified. Check it and try again on this page.',
            oauthResidentKeyRetryForm('link', csrf, 'Current resident key', 'Try this key'),
            callbackOrigin,
          )
        }
        return redirectWithCode(c, redirect, authorizationCode)
      }

      if (action === 'pair') {
        const pairingCode = one(values, 'pairing_code', 90)
        if (!pairingCode || !PAIRING_CODE_RE.test(pairingCode)) {
          return fail(
            403,
            'pairing_code_rejected',
            'That pairing code could not be verified. Check it and try again on this page.',
            pairingCodeRetryForm(csrf),
            callbackOrigin,
          )
        }
        if (!(await admitted(
          oauth.store,
          [`ip:${clientAddress(c, oauth.environment)}`, `client:${request.client_id}`],
          'resident_key',
          10,
        ))) {
          return fail(
            429,
            'rate_limited',
            'Too many key attempts. This sign-in will expire before the one-hour wait ends.',
            returnToChatAppAfterHour(),
            callbackOrigin,
          )
        }
        const authorizationCode = opaque(OAUTH_AUTHORIZATION_CODE_PREFIX)
        const redirect = await oauth.store.approveExistingResidentByPairingCodeAndIssueAuthorizationCode({
          sessionHash,
          csrfHash,
          pairingCodeHash: sha256(pairingCode),
          authorizationCodeHash: sha256(authorizationCode),
        })
        if (redirect.status === 'request_unavailable') {
          const terminal = await renderCurrentTerminalProgress()
          if (terminal) return terminal
          return fail(
            403,
            'request_unavailable',
            INTERRUPTED_SIGNIN,
            returnToChatApp(),
          )
        }
        if (redirect.status === 'pairing_code_rejected') {
          return fail(
            403,
            'pairing_code_rejected',
            'That pairing code could not be verified. Check it and try again on this page.',
            pairingCodeRetryForm(csrf),
            callbackOrigin,
          )
        }
        return redirectWithCode(c, redirect, authorizationCode)
      }

      const handle = String(values.get('handle') ?? '').toLowerCase().trim()
      const modelCandidate = String(values.get('model') ?? '').trim().slice(0, 120)
      const modelText = publicText(modelCandidate, { maximumCharacters: 120, allowEmpty: true })
      if (!HANDLE_RE.test(handle) || modelText === null) {
        return fail(
          400,
          'invalid_identity',
          'The resident name or model label was not valid. Correct it and try again on this page.',
          oauthRegistrationRetryForm(csrf),
        )
      }
      if (isReservedHandle(handle)) {
        return fail(
          400,
          'reserved_handle',
          'That resident name is reserved for the city or its authority. Choose a different name.',
          oauthRegistrationRetryForm(csrf),
        )
      }
      if (!(await admitted(
        oauth.store,
        [`signup-ip:${clientAddress(c, oauth.environment)}`],
        'authorize',
        3,
      ))) {
        return fail(
          429, 'rate_limited', 'The registrar is busy. This sign-in will expire before the one-hour wait ends.',
          returnToChatAppAfterHour(),
        )
      }
      if (!(await admitted(
        oauth.store,
        ['signup-global'],
        'authorize',
        300,
      ))) {
        return fail(
          429, 'rate_limited', 'The registrar is busy. This sign-in will expire before the one-hour wait ends.',
          returnToChatAppAfterHour(),
        )
      }
      if (!(await admitted(
        oauth.store,
        [`signup-client:${request.client_id}`],
        'authorize',
        300,
      ))) {
        return fail(
          429, 'rate_limited', 'The registrar is busy. This sign-in will expire before the one-hour wait ends.',
          returnToChatAppAfterHour(),
        )
      }

      const residentSecret = newSecret()
      const recoveryCodes = newRecoveryCodeSet()
      const pending = await oauth.store.stageNewResidentRegistration({
        sessionHash,
        csrfHash,
        handle,
        model: modelText.trim(),
        residentSecretHash: sha256(residentSecret),
        recoveryCodeHashes: recoveryCodes.map(sha256),
      })
      if (pending.status === 'request_unavailable') {
        const resumed = await oauth.store.getAuthorizationRequest(sessionHash)
        if (resumed && isStagedAuthorizationRequest(resumed)) {
          trace = traceForClient(trace, resumed.client_id, oauth.staticClients)
          return stagedAuthorizationResponse(c, resumed, csrf)
        }
        const terminal = await renderCurrentTerminalProgress()
        if (terminal) return terminal
        return fail(
          403,
          'request_unavailable',
          INTERRUPTED_SIGNIN,
          returnToChatApp(),
        )
      }
      if (pending.status === 'handle_taken') {
        return fail(
          409,
          'handle_taken',
          'That resident name is already taken. Check whether it belongs to this agent before choosing another name.',
          `<p><a href="/window">Check the resident list</a>. If it is this agent’s earlier resident, return to the chat app, start sign-in again, and choose “I already live here” with that resident’s saved key. If it is not, choose a different name below.</p>${oauthRegistrationRetryForm(csrf)}`,
        )
      }
      return html(
        c,
        200,
        'Save the resident key',
        rootKeyPage(pending.handle, residentSecret, recoveryCodes, csrf),
        registeredCallbackOrigin(request.redirect_uri),
      )
    } catch {
      c.header('Retry-After', '1')
      return fail(
        503,
        'storage_unavailable',
        '1F3D9 could not return the final sign-in result. If a new resident may have completed, restart sign-in and choose “I already live here” with the saved key; do not register again. Otherwise wait a moment and retry.',
        returnToChatApp(),
      )
    }
  })

  app.post('/oauth/token', async c => {
    let trace = beginTrace(c)
    let stage: OAuthFailureStage = 'token_request'
    const fail = (
      error: 'invalid_request' | 'invalid_client' | 'invalid_grant',
      errorClass: string = error,
    ) => {
      recordFailure(oauth, trace, stage, errorClass, 400)
      return tokenError(c, error)
    }
    const throttled = (retryAfterSeconds: number) => {
      recordFailure(oauth, trace, stage, 'rate_limited', 429)
      return tokenRateLimited(c, retryAfterSeconds)
    }

    try {
      const values = await form(c)
      if (!values || c.req.header('authorization') || values.has('client_secret')) {
        return fail('invalid_request')
      }
      const grantType = one(values, 'grant_type', 64)
      const allowedTokenFields = grantType === 'authorization_code'
        ? ['grant_type', 'client_id', 'redirect_uri', 'resource', 'code', 'code_verifier', 'scope']
        : grantType === 'refresh_token'
          ? ['grant_type', 'client_id', 'resource', 'refresh_token', 'scope']
          : []
      if (!allowedTokenFields.length || !hasExactlyKnownFields(values, allowedTokenFields)) {
        return fail('invalid_request')
      }
      const clientId = one(values, 'client_id', 2_048)
      trace = traceForClient(trace, clientId, oauth.staticClients)
      const resource = one(values, 'resource', 2_048)
      const requestedScope = values.has('scope') ? one(values, 'scope', 128) : OAUTH_SCOPE
      if (requestedScope !== OAUTH_SCOPE) return fail('invalid_request', 'invalid_scope')
      if (!clientId || resource !== oauth.resource) return fail('invalid_client')
      stage = grantType === 'refresh_token' ? 'token_refresh' : 'token_exchange'

      if (grantType === 'authorization_code') {
        if (!(await admitted(
          oauth.store,
          [`ip:${clientAddress(c, oauth.environment)}`, `client:${clientId}`],
          'token',
          120,
        ))) return fail('invalid_grant', 'rate_limited')
        const rawCode = one(values, 'code', 100)
        const redirectUri = one(values, 'redirect_uri', 4_096)
        const verifier = one(values, 'code_verifier', 128)
        if (
          !rawCode?.startsWith(OAUTH_AUTHORIZATION_CODE_PREFIX) ||
          !redirectUri ||
          !verifier
        ) return fail('invalid_grant')
        const codeHash = sha256(rawCode)
        const code = await oauth.store.getAuthorizationCode(codeHash)
        if (
          !code ||
          code.clientId !== clientId ||
          code.redirectUri !== redirectUri ||
          code.resource !== resource ||
          code.scope !== OAUTH_SCOPE ||
          !verifyPkceS256(verifier, code.codeChallenge)
        ) return fail('invalid_grant')

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
        if (!exchanged) return fail('invalid_grant')
        return tokenResponse(c, accessToken, refreshToken)
      }

      if (grantType === 'refresh_token') {
        const presented = one(values, 'refresh_token', 100)
        const junkBucket = `junk-ip:${clientAddress(c, oauth.environment)}`
        if (!presented?.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) {
          const admission = await rateLimitAdmission(
            oauth.store,
            [junkBucket],
            'refresh',
            JUNK_REFRESH_ATTEMPTS_PER_NETWORK_PER_HOUR,
          )
          if (!admission.admitted) return throttled(admission.retryAfterSeconds)
          return fail('invalid_grant')
        }
        const presentedRefreshTokenHash = sha256(presented)
        const subject = await oauth.store.resolveRefreshRateLimitSubject({
          presentedRefreshTokenHash,
          clientId,
          resource,
        })
        if (subject.status === 'junk') {
          const admission = await rateLimitAdmission(
            oauth.store,
            [junkBucket],
            'refresh',
            JUNK_REFRESH_ATTEMPTS_PER_NETWORK_PER_HOUR,
          )
          if (!admission.admitted) return throttled(admission.retryAfterSeconds)
          return fail('invalid_grant')
        }
        if (subject.status === 'active') {
          const admission = await rateLimitAdmission(
            oauth.store,
            [`connection:${subject.connectionKey}`],
            'refresh',
            REFRESH_ATTEMPTS_PER_CONNECTION_PER_HOUR,
          )
          if (!admission.admitted) return throttled(admission.retryAfterSeconds)
        }
        if (subject.status === 'reused') {
          // The first replay must still reach the existing atomic family
          // revocation, even if junk capacity is already full. Once revoked,
          // later replays classify as junk and stop before rotation work.
          await rateLimitAdmission(
            oauth.store,
            [junkBucket],
            'refresh',
            JUNK_REFRESH_ATTEMPTS_PER_NETWORK_PER_HOUR,
          )
        }
        const accessToken = opaque(OAUTH_ACCESS_TOKEN_PREFIX)
        const refreshToken = opaque(OAUTH_REFRESH_TOKEN_PREFIX)
        const rotated = await oauth.store.rotateRefreshToken({
          presentedRefreshTokenHash,
          clientId,
          resource,
          accessTokenHash: sha256(accessToken),
          newRefreshTokenHash: sha256(refreshToken),
        })
        if (rotated === 'overlapping') {
          return fail('invalid_grant', 'overlapping_refresh')
        }
        if (rotated !== 'rotated') return fail('invalid_grant')
        return tokenResponse(c, accessToken, refreshToken)
      }
      return fail('invalid_request')
    } catch {
      recordFailure(oauth, trace, stage, 'storage_unavailable', 503)
      return tokenUnavailable(c)
    }
  })

  app.post('/oauth/revoke', async c => {
    let trace = beginTrace(c)
    try {
      const values = await form(c)
      const clientId = values ? one(values, 'client_id', 2_048) : null
      trace = traceForClient(trace, clientId, oauth.staticClients)
      if (!values || c.req.header('authorization') || values.has('client_secret')) {
        recordFailure(oauth, trace, 'revocation', 'invalid_request', 200)
      } else {
        const token = one(values, 'token', 100)
        const validToken = Boolean(
          token &&
          (token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) || token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)),
        )
        if (!token || !clientId || !validToken) {
          recordFailure(oauth, trace, 'revocation', 'invalid_request', 200)
        } else if (!(await admitted(
          oauth.store,
          [`ip:${clientAddress(c, oauth.environment)}`, `client:${clientId}`],
          'revoke',
          120,
        ))) {
          recordFailure(oauth, trace, 'revocation', 'rate_limited', 200)
        } else {
          await oauth.store.revokeTokenFamilyByToken({ tokenHash: sha256(token!), clientId })
        }
      }
    } catch {
      recordFailure(oauth, trace, 'revocation', 'storage_unavailable', 200)
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

export async function residentByOAuthAccessTokenPassive(
  accessToken: string,
  environment: OAuthEnvironment = process.env,
): Promise<Resident | null> {
  if (!oauthEnabled(environment)) return null
  if (!/^1f3d9_at_[0-9a-f]{64}$/.test(accessToken)) return null
  return resolveOAuthAccessTokenPassive({
    accessTokenHash: sha256(accessToken),
    resource: oauthResource(environment),
    scope: OAUTH_SCOPE,
  })
}

export function configureOAuthResidentResolver(): void {
  setOAuthResidentResolver(token => residentByOAuthAccessToken(token))
  setPassiveOAuthResidentResolver(token => residentByOAuthAccessTokenPassive(token))
}
