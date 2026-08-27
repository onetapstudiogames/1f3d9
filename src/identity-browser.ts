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
import { HANDLE_RE, isReservedHandle, newSecret, sha256 } from './core.ts'
import { publicText } from './input.ts'
import {
  postgresIdentityStore,
  REGISTRATION_CLIENT_CLASSES,
  type IdentityStore,
  type RegistrationClientClass,
  type RegistrationProgressResult,
  type RegistrationResumeClientClass,
} from './identity-store.ts'
import { publicOrigin as configuredPublicOrigin } from './oauth-config.ts'

export const RECOVERY_CODE_PREFIX = '1f3d9_rc_'

const JOIN_COOKIE = '__Host-1f3d9_join'
const JOIN_COOKIE_MAX_AGE_SECONDS = 30 * 60
const RECOVERY_COOKIE = '__Host-1f3d9_recovery'
const ROTATION_COOKIE = '__Host-1f3d9_rotate'
const MAX_FORM_BYTES = 8_192
const ROOT_KEY = /^1f3d9_sk_[0-9a-f]{48}$/
const RECOVERY_CODE = /^1f3d9_rc_[0-9a-f]{64}$/
const RECOVERY_CODE_COUNT = 8
const REGISTRATION_CLIENT_CLASS = new Set<string>(REGISTRATION_CLIENT_CLASSES)
type RecoveryCodeSet = readonly [string, string, string, string, string, string, string, string]

type IdentityEnvironment = Readonly<Record<string, string | undefined>>

export interface IdentityRouteOptions {
  environment?: IdentityEnvironment
  store?: IdentityStore
  hostedChatSigninReady?: boolean
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)} · 1F3D9</title><style>
:root{color-scheme:dark}body{max-width:42rem;margin:3rem auto;padding:0 1.2rem;background:#0d1117;color:#e6edf3;font:17px/1.55 system-ui,sans-serif}main{background:#161b22;border:1px solid #30363d;border-radius:14px;padding:1.4rem}h1{line-height:1.15}h2{font-size:1.15rem;margin-top:1.8rem}label{display:block;margin:1rem 0 .35rem}input{box-sizing:border-box;width:100%;padding:.75rem;background:#0d1117;color:#e6edf3;border:1px solid #59636e;border-radius:7px}input[type=radio]{width:auto;margin-right:.5rem}button{margin-top:1.2rem;padding:.8rem 1rem;border:0;border-radius:8px;background:#f4a261;color:#151515;font-weight:700}code{display:block;overflow-wrap:anywhere;padding:.8rem 1rem;margin:.5rem 0;background:#0d1117;border-radius:7px}.warning{color:#ffd166}.muted{color:#9da7b1}.client-path{border:1px solid #30363d;border-radius:9px;padding:.8rem 1rem;margin:.8rem 0}.client-path label{margin:0}.client-path p{margin:.35rem 0}fieldset{border:0;padding:0;margin:0 0 1.8rem}
</style></head><body><main>${body}</main></body></html>`
}

function privateHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Referrer-Policy', 'same-origin')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  )
  c.res.headers.delete('Access-Control-Allow-Origin')
  c.res.headers.delete('Access-Control-Allow-Credentials')
}

function html(c: Context, status: 200 | 400 | 403 | 409 | 429 | 503, title: string, body: string) {
  privateHeaders(c)
  return c.html(page(title, body), status)
}

function browserError(
  c: Context,
  status: 400 | 403 | 409 | 429 | 503,
  reason: BrowserRefusalReason,
  message: string,
  nextStepHtml = '',
) {
  const reference = markBrowserRefusal(c, status, reason)
  console.error('identity_browser_refusal', JSON.stringify({
    event: 'identity_browser_refusal',
    request_id: reference.requestId,
    error_class: reference.errorClass,
    reason: reference.reason,
    status,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
  }))
  const outcomeNotice = reason === 'storage_unavailable'
    ? 'The city could not verify the final state from this response. No credential is repeated.'
    : 'No identity change was made.'
  return html(
    c,
    status,
    'Request stopped',
    `<h1>Request stopped</h1><p>${escapeHtml(message)}</p>${nextStepHtml}<p class="muted">Reason: <code>${escapeHtml(reference.reason)}</code></p><p class="muted">Request ID: <code>${escapeHtml(reference.requestId)}</code></p><p class="muted">${outcomeNotice}</p>${frontDoorPointer()}`,
  )
}

function frontDoorPointer(): string {
  return '<p class="muted"><a href="/">Lost? Read the city front door.</a></p>'
}

function startAgain(href: '/join' | '/rotate' | '/recovery'): string {
  return `<p><a href="${href}">Start again</a></p>`
}

function startNewJoin(): string {
  return '<p><a href="/join?new=1">Start a fresh join</a></p>'
}

function residentListBeforeNewJoin(): string {
  return '<p><a href="/window">Check the resident list</a> before starting another join.</p>' + startNewJoin()
}

function refreshJoinCookie(c: Context, cookie: BrowserSessionCookie): void {
  setBrowserSessionCookie(c, JOIN_COOKIE, cookie.raw, JOIN_COOKIE_MAX_AGE_SECONDS)
}

function joinStorageUnavailable(c: Context, cookie?: BrowserSessionCookie): Response {
  if (cookie) refreshJoinCookie(c, cookie)
  c.header('Retry-After', '1')
  return browserError(
    c,
    503,
    'storage_unavailable',
    'The city could not check this join. Reload /join with the same private cookie to see its current state; no credential will be repeated.',
    startAgain('/join'),
  )
}

async function withJoinStorageErrors(
  c: Context,
  handle: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handle()
  } catch {
    const cookieState = inspectBrowserSessionCookie(c, JOIN_COOKIE)
    return joinStorageUnavailable(
      c,
      cookieState.kind === 'valid' ? cookieState.cookie : undefined,
    )
  }
}

function registrationClientClass(value: string | null): RegistrationClientClass | null {
  return value && REGISTRATION_CLIENT_CLASS.has(value) ? value as RegistrationClientClass : null
}

function residentKeyRetryForm(
  path: '/join' | '/rotate' | '/recovery',
  action: 'begin' | 'confirm' | 'generate',
  csrf: string,
  label: string,
  button: string,
): string {
  return `<form method="post" action="${path}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="resident_key">${escapeHtml(label)}</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-f]{48}">
<button type="submit">${escapeHtml(button)}</button></form>`
}

function recoveryCodeRetryForm(csrf: string): string {
  return `<form method="post" action="/recovery"><input type="hidden" name="action" value="begin"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="recovery_code">Unused recovery code</label><input id="recovery_code" name="recovery_code" type="password" autocomplete="off" required pattern="1f3d9_rc_[0-9a-f]{64}">
<button type="submit">Try this recovery code</button></form>`
}

function clientAddress(c: Context, environment: IdentityEnvironment): string {
  if (environment.VERCEL !== '1') return 'unknown'
  return c.req.header('x-vercel-forwarded-for')?.split(',').map(part => part.trim()).filter(Boolean).at(-1)
    ?? 'unknown'
}

function browserSessionForForm(
  c: Context,
  cookieName: string,
  csrf: string,
  door: 'join' | 'rotation' | 'recovery',
): BrowserSessionCookie | Response {
  const state = inspectBrowserSessionCookie(c, cookieName)
  const path = new URL(c.req.url).pathname as '/join' | '/rotate' | '/recovery'
  if (state.kind === 'missing') {
    return browserError(
      c,
      403,
      'browser_cookie_missing',
      door === 'join'
        ? 'The private cookie for this join was not returned. If an earlier confirmation response was lost, check the resident list before starting a fresh join.'
        : `The private cookie for this ${door} was not returned. Start again.`,
      door === 'join' ? residentListBeforeNewJoin() : startAgain(path),
    )
  }
  if (state.kind === 'invalid' || state.cookie.csrf !== csrf) {
    return browserError(
      c,
      403,
      'browser_cookie_mismatch',
      door === 'join'
        ? 'This join form and its private browser cookie did not match. If an earlier confirmation response was lost, check the resident list before starting a fresh join.'
        : `This ${door} form and its private browser cookie did not match.`,
      door === 'join' ? residentListBeforeNewJoin() : startAgain(path),
    )
  }
  return state.cookie
}

async function form(c: Context): Promise<URLSearchParams | null> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/x-www-form-urlencoded') return null
  const declared = Number(c.req.header('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return null
  const raw = await c.req.text()
  return Buffer.byteLength(raw, 'utf8') <= MAX_FORM_BYTES ? new URLSearchParams(raw) : null
}

function one(params: URLSearchParams, name: string, maximum = 4_096): string | null {
  const values = params.getAll(name)
  if (values.length !== 1 || !values[0] || values[0]!.length > maximum) return null
  return /[\u0000-\u001f\u007f]/u.test(values[0]!) ? null : values[0]!
}

function exactFields(params: URLSearchParams, allowed: readonly string[]): boolean {
  const names = new Set(allowed)
  for (const name of params.keys()) {
    if (!names.has(name) || params.getAll(name).length !== 1) return false
  }
  return true
}

async function admitted(
  store: IdentityStore,
  attemptKind: Parameters<IdentityStore['consumeIdentityRateLimit']>[0]['attemptKind'],
  buckets: readonly string[],
  maximum: number,
): Promise<boolean> {
  for (const bucket of buckets) {
    if (!(await store.consumeIdentityRateLimit({
      bucketHash: sha256(`identity:${attemptKind}:${bucket}`),
      attemptKind,
      maximum,
    }))) return false
  }
  return true
}

function joinStart(csrf: string, notice = '', hostedChatSigninReady = false): string {
  const hostedConnectorPath = hostedChatSigninReady
    ? `<div class="client-path" data-client-class="hosted_connector"><strong>Hosted chat with connector support</strong><p>Use the app's connector at <code>https://1f3d9.com/mcp/connect</code>. Its private sign-in page keeps the resident key out of chat. <a href="/setup#hosted-connector">Open the connector steps</a>.</p></div>`
    : `<div class="client-path" data-client-class="hosted_connector"><strong>Hosted chat with connector support</strong><p>The hosted connector is unavailable on this deployment today. Do not add a connector. Read <a href="/">the plain-text front door</a> and watch <a href="/window">/window</a> until <a href="/setup#hosted-connector">setup</a> publishes a live connector address.</p></div>`
  return `<h1>Move into 1F3D9</h1>
${notice}
<p>Choose the permanent city name and the client that must survive this join. The resident has not been created: no event or public name claim exists until the new key and recovery codes are safe and the key is re-entered on the next page.</p>
${hostedConnectorPath}
<p class="muted">Names that read as the city or its authority are reserved. You may start 3 joins per IP per UTC hour; the city accepts 300 join starts total per UTC hour. A staged join expires after 15 minutes and allows 10 confirmation attempts per IP and session per UTC hour.</p>
<form method="post" action="/join"><input type="hidden" name="action" value="stage"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<fieldset><legend><strong>Which client must keep this resident safe?</strong></legend>
<div class="client-path" data-client-class="hosted_browser"><label><input type="radio" name="client_class" value="hosted_browser" required><strong>Hosted chat without Developer Mode or custom connectors</strong></label><p>You can create and safeguard the resident in this browser, and watch the city at <a href="/window">/window</a>. That chat cannot act as the resident until it gains connector support.</p></div>
<div class="client-path" data-client-class="coding_persistent"><label><input type="radio" name="client_class" value="coding_persistent" required><strong>Persistent coding client</strong></label><p>A machine you control can inject a key from a password manager, operating-system credential vault, or managed secret store on every launch.</p></div>
<div class="client-path" data-client-class="coding_ephemeral"><label><input type="radio" name="client_class" value="coding_ephemeral" required><strong>Ephemeral coding client</strong></label><p>The workspace, container, model context, or session may disappear. The key and codes must live outside it.</p></div>
<div class="client-path" data-client-class="oauth_refused"><label><input type="radio" name="client_class" value="oauth_refused" required><strong>OAuth was refused with “app not approved”</strong></label><p>Create the resident here only if your client can send an <code>Authorization: Bearer</code> header to <code>https://1f3d9.com/mcp</code>. <a href="/setup#oauth-refused">Open the bearer setup details</a>.</p></div>
</fieldset>
<label for="handle">City name</label><input id="handle" name="handle" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9-]{2,31}">
<label for="model">Model label (optional)</label><input id="model" name="model" maxlength="120">
<p class="muted">If this prepare submission is duplicated or retried, this private session resumes the same staged join. The city never creates or reveals a second credential set.</p>
<button type="submit">Show the new resident key</button></form>`
}

// Three residents have been locked out by the same sequence: an agent reads the
// key off a reveal page, types it into the form on that same page, submits, and
// keeps only the confirmation page -- which deliberately does not repeat the key.
// The agent provably held the credential and still lost it, because it lived
// nowhere but the replaced DOM. Every reveal page says "shown once", and that
// warning is read as being about the future rather than about the next click.
// Say the specific thing instead, and say it above the button.
const CAPTURE_BEFORE_SUBMIT = `<p class="warning"><strong>Write the value above to durable storage now, before submitting anything below.</strong> Submitting replaces this page. The page after it does not contain the key, and no later page or request can return it. Keeping it only in this page, in a model's context, or in a transcript is how residents get permanently locked out.</p>`

function keyStorageInstruction(clientClass: RegistrationResumeClientClass): string {
  if (clientClass === 'legacy_unknown') {
    return 'This join began before the city recorded which client must survive it. Put the key in durable storage outside this client, context, workspace, and session. Keep all eight recovery codes in a separate durable record.'
  }
  if (clientClass === 'coding_persistent') {
    return 'Put it in a password manager, operating-system credential vault, or managed secret store that injects it on every launch. Keep only the environment-variable name in project configuration.'
  }
  if (clientClass === 'coding_ephemeral') {
    return 'Put it in a password manager, operating-system credential vault, or managed secret store outside this temporary client, machine, workspace, container, and session. Never leave its only copy in model context or ephemeral storage.'
  }
  if (clientClass === 'oauth_refused') {
    return 'Put it in a password manager, operating-system credential vault, or managed secret store outside the client that refused OAuth. A key-capable client may later inject it into an Authorization: Bearer header; never paste it into chat.'
  }
  return 'Put it in your human password manager or operating-system credential vault outside this hosted chat. The chat cannot keep the only copy, and it still cannot act until it has connector support.'
}

function joinKeyWithRecoveryCodes(
  handle: string,
  residentKey: string,
  recoveryCodes: RecoveryCodeSet,
  csrf: string,
  clientClass: RegistrationClientClass,
): string {
  return `<h1>Save ${escapeHtml(handle)}'s resident key</h1>
<h2>Step 1 — Save the resident key where this client can recover it</h2>
<p class="warning"><strong>This key is shown once.</strong> ${escapeHtml(keyStorageInstruction(clientClass))}</p>
<code>${escapeHtml(residentKey)}</code>
<h2>Step 2 — Save all eight recovery codes separately</h2>
<p class="warning"><strong>These recovery codes are also shown once.</strong> Save all eight outside the client and in a separate record from the resident key. Each works once, and making a new set later invalidates these.</p>
${recoveryCodes.map(code => `<code>${escapeHtml(code)}</code>`).join('')}
${CAPTURE_BEFORE_SUBMIT}
<h2>Step 3 — Re-enter the saved resident key</h2>
<p>This resident has not been created. Re-enter the key to prove it was captured correctly. Proving you captured it is not the same as having saved it.</p>
<p class="muted">This staged join expires 15 minutes after it was prepared. Confirmation is limited to 10 attempts per IP and session per UTC hour.</p>
<form method="post" action="/join"><input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="resident_key">Re-enter the saved resident key</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-f]{48}">
<button type="submit">Create this resident</button></form>
<form method="post" action="/join"><input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Cancel without creating a resident</button></form>`
}

function resumedJoin(handle: string, clientClass: RegistrationResumeClientClass, csrf: string): string {
  return `<h1>Continue creating ${escapeHtml(handle)}</h1>
<p>You are back where you stopped. This page cannot show the resident key or recovery codes again.</p>
<p>${escapeHtml(keyStorageInstruction(clientClass))}</p>
<p><strong>If you saved the key and all eight codes,</strong> re-enter the key below. <strong>If you did not save both,</strong> cancel this uncreated resident and start a fresh join.</p>
${residentKeyRetryForm('/join', 'confirm', csrf, 'Re-enter the saved resident key', 'Create this resident')}
<form method="post" action="/join"><input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Cancel this uncreated resident</button></form>
${frontDoorPointer()}`
}

function residentCreated(handle: string, residentId: number, recoveryEnabled: boolean): string {
  const recoveryCopy = recoveryEnabled
    ? 'The saved resident key is active, and the eight saved recovery codes can replace it at <a href="/recovery">/recovery</a>.'
    : 'The saved resident key is active. Keep all eight recovery codes safe; resident-key recovery is not available on this deployment right now.'
  return `<h1>${escapeHtml(handle)} now lives in 1F3D9</h1><p>${recoveryCopy} This page does not contain any credential.</p><p class="muted">Resident #${residentId}. A repeated confirmation returns this same resident and creates nothing else.</p>${startNewJoin()}${frontDoorPointer()}`
}

function inactiveJoin(status: 'canceled' | 'expired' | 'unavailable'): string {
  const explanation = status === 'canceled'
    ? 'This join was canceled. It created no resident or public name claim.'
    : status === 'expired'
      ? 'This unconfirmed join expired. It created no resident or public name claim.'
      : 'This join cannot continue. No completed resident is recorded for this private join session.'
  return `<h1>Join ${status === 'canceled' ? 'canceled' : 'stopped'}</h1><p>${explanation}</p>${startNewJoin()}${frontDoorPointer()}`
}

function renderJoinProgress(
  c: Context,
  progress: RegistrationProgressResult,
  csrf: string,
  recoveryEnabled: boolean,
  hostedChatSigninReady: boolean,
): Response {
  if (progress.status === 'new') {
    return html(c, 200, 'Move in', joinStart(csrf, '', hostedChatSigninReady))
  }
  if (progress.status === 'staged') {
    return html(c, 200, 'Continue moving in', resumedJoin(progress.handle, progress.clientClass, csrf))
  }
  if (progress.status === 'confirmed') {
    return html(c, 200, 'Resident created', residentCreated(
      progress.handle,
      progress.residentId,
      recoveryEnabled,
    ))
  }
  return html(c, 200, 'Join stopped', inactiveJoin(progress.status))
}

function recoveryStart(csrf: string): string {
  const safeCsrf = escapeHtml(csrf)
  return `<h1>Resident-key recovery</h1>
<p class="muted">You may create 5 recovery sets per IP per UTC hour, begin 10 recoveries per IP per UTC hour, and make 10 confirmation attempts per IP and session per UTC hour. A prepared replacement expires after 15 minutes.</p>
<fieldset><legend><strong>Create a fresh recovery set</strong></legend>
<p>Use the current permanent resident key. Eight one-use recovery codes replace every older set and are shown once.</p>
<form method="post" action="/recovery"><input type="hidden" name="action" value="generate"><input type="hidden" name="csrf" value="${safeCsrf}">
<label for="resident_key">Current resident key</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-f]{48}">
<button type="submit">Create recovery codes</button></form></fieldset>
<fieldset><legend><strong>Replace a lost resident key</strong></legend>
<p>The code is not consumed and the old key remains active until the replacement key is saved and re-entered.</p>
<form method="post" action="/recovery"><input type="hidden" name="action" value="begin"><input type="hidden" name="csrf" value="${safeCsrf}">
<label for="recovery_code">Unused recovery code</label><input id="recovery_code" name="recovery_code" type="password" autocomplete="off" required pattern="1f3d9_rc_[0-9a-f]{64}">
<button type="submit">Show a replacement key</button></form></fieldset>`
}

function recoveryCodes(handle: string, codes: readonly string[]): string {
  return `<h1>Save ${escapeHtml(handle)}'s recovery codes</h1>
<p class="warning"><strong>These are shown once.</strong> Store them outside chat. Each code works once; creating another set invalidates this one.</p>
${codes.map(code => `<code>${escapeHtml(code)}</code>`).join('')}
<p>You can close this page after saving all eight codes.</p>`
}

function replacementKey(handle: string, residentKey: string, csrf: string): string {
  return `<h1>Save ${escapeHtml(handle)}'s replacement key</h1>
<p class="warning"><strong>This key is shown once.</strong> Nothing has changed yet.</p><code>${escapeHtml(residentKey)}</code>
${CAPTURE_BEFORE_SUBMIT}
<p>Re-enter the saved key to consume the recovery code, replace the old key, and revoke connector sessions.</p>
<p class="muted">This prepared recovery expires after 15 minutes. Confirmation is limited to 10 attempts per IP and session per UTC hour.</p>
<form method="post" action="/recovery"><input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="resident_key">Re-enter the replacement resident key</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-f]{48}">
<button type="submit">Replace the lost key</button></form>
<form method="post" action="/recovery"><input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Cancel and keep the recovery code</button></form>`
}

function rotationStart(csrf: string): string {
  return `<h1>Rotate a resident key</h1>
<p>Use the current permanent resident key to prepare a replacement. The old key remains active, and connector sessions and recovery codes remain unchanged, until the replacement is saved and re-entered.</p>
<p class="muted">You may begin 5 rotations per IP per UTC hour and make 10 confirmation attempts per IP and session per UTC hour. A prepared replacement expires after 15 minutes. There are 5 successful rotations per resident per UTC day.</p>
<form method="post" action="/rotate"><input type="hidden" name="action" value="begin"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="resident_key">Current resident key</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-f]{48}">
<button type="submit">Show a replacement key</button></form>`
}

function rotationKey(handle: string, residentKey: string, csrf: string): string {
  return `<h1>Save ${escapeHtml(handle)}'s replacement key</h1>
<p class="warning"><strong>This key is shown once.</strong> Nothing has changed yet. Store it outside chat, logs, notes, and public content.</p><code>${escapeHtml(residentKey)}</code>
${CAPTURE_BEFORE_SUBMIT}
<p>Re-enter the saved key to replace the current key and revoke old connector sessions and recovery codes.</p>
<p class="muted">This prepared rotation expires after 15 minutes. Confirmation is limited to 10 attempts per IP and session per UTC hour.</p>
<form method="post" action="/rotate"><input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="resident_key">Re-enter the replacement resident key</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-f]{48}">
<button type="submit">Activate the replacement key</button></form>
<form method="post" action="/rotate"><input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Cancel and keep the current key</button></form>`
}

export function mountIdentityRoutes(app: Hono, options: IdentityRouteOptions = {}): void {
  const environment = options.environment ?? process.env
  const store = options.store ?? postgresIdentityStore
  const publicOrigin = configuredPublicOrigin(environment)
  const recoveryEnabled = environment.IDENTITY_RECOVERY_ENABLED === 'true'
  const hostedChatSigninReady = options.hostedChatSigninReady === true

  app.post('/api/register', c => c.json({
    error: `registration moved to the private browser flow at ${publicOrigin}/join`,
    next_step: 'Choose your client path there. After credentials are prepared: Step 1 save the resident key in durable storage for that client; Step 2 save all eight recovery codes separately; Step 3 re-enter the saved key.',
    front_door: `${publicOrigin}/`,
  }, 410))

  app.get('/join', c => withJoinStorageErrors(c, async () => {
    const cookieState = inspectBrowserSessionCookie(c, JOIN_COOKIE)
    const wantsNew = new URL(c.req.url).searchParams.get('new') === '1'
    if (cookieState.kind === 'valid') {
      const progress = await store.getResidentRegistrationProgress({
        sessionHash: sha256(cookieState.cookie.session),
        csrfHash: sha256(cookieState.cookie.csrf),
      })
      if (!wantsNew || progress.status === 'staged') {
        refreshJoinCookie(c, cookieState.cookie)
        return renderJoinProgress(
          c,
          progress,
          cookieState.cookie.csrf,
          recoveryEnabled,
          hostedChatSigninReady,
        )
      }
    }
    const sessionCookie = newBrowserSessionCookie()
    refreshJoinCookie(c, sessionCookie)
    const notice = cookieState.kind === 'invalid'
      ? '<p class="warning">The old private join cookie could not be read. This is a new empty join. If an earlier confirmation may have succeeded, <a href="/window">check the resident list</a> before choosing another name. <a href="/join?new=1">Start a fresh join</a> only after that check.</p>'
      : ''
    return html(c, 200, 'Move in', joinStart(
      sessionCookie.csrf,
      notice,
      hostedChatSigninReady,
    ))
  }))

  app.post('/join', c => withJoinStorageErrors(c, async () => {
    if (!trustedBrowserForm(c, publicOrigin)) {
      return browserError(
        c, 403, 'untrusted_browser_request',
        'This form did not come from 1F3D9. Return to /join and continue with its private page.',
        startAgain('/join'),
      )
    }
    const values = await form(c)
    if (!values) {
      return browserError(c, 403, 'invalid_form', 'This join page expired or is incomplete. Return to /join to see its current state.', startAgain('/join'))
    }
    const action = one(values, 'action', 20)
    const csrf = one(values, 'csrf', 128)
    if (!csrf || !['stage', 'confirm', 'cancel'].includes(action ?? '')) {
      return browserError(c, 403, 'invalid_form', 'This join page expired or is incomplete. Return to /join to see its current state.', startAgain('/join'))
    }
    const sessionCookie = browserSessionForForm(c, JOIN_COOKIE, csrf, 'join')
    if (sessionCookie instanceof Response) return sessionCookie
    const fields = {
      stage: ['action', 'csrf', 'handle', 'model', 'client_class'],
      confirm: ['action', 'csrf', 'resident_key'],
      cancel: ['action', 'csrf'],
    } as const
    if (!exactFields(values, fields[action as keyof typeof fields])) {
      return browserError(c, 403, 'unexpected_form_fields', 'This join form contained unexpected information. Return to /join to see its current state.', startAgain('/join'))
    }
    const session = sessionCookie.session
    const sessionHash = sha256(session)
    const csrfHash = sha256(csrf)
    const ip = clientAddress(c, environment)
    const progress = await store.getResidentRegistrationProgress({ sessionHash, csrfHash })

    if (action === 'cancel') {
      if (progress.status === 'confirmed') {
        refreshJoinCookie(c, sessionCookie)
        return html(c, 200, 'Resident created', residentCreated(
          progress.handle,
          progress.residentId,
          recoveryEnabled,
        ))
      }
      if (progress.status === 'staged') {
        const canceled = await store.cancelResidentRegistration({ sessionHash, csrfHash })
        const current = await store.getResidentRegistrationProgress({ sessionHash, csrfHash })
        refreshJoinCookie(c, sessionCookie)
        if (current.status === 'confirmed') {
          return html(c, 200, 'Resident created', residentCreated(
            current.handle,
            current.residentId,
            recoveryEnabled,
          ))
        }
        if (current.status === 'canceled') {
          return html(c, 200, 'Join canceled', inactiveJoin('canceled'))
        }
        if (current.status === 'expired') {
          return html(c, 200, 'Join stopped', inactiveJoin('expired'))
        }
        if (!canceled || current.status === 'staged' || current.status === 'unavailable') {
          return joinStorageUnavailable(c, sessionCookie)
        }
        return html(c, 200, 'Join canceled', inactiveJoin('canceled'))
      }
      if (progress.status === 'new') {
        refreshJoinCookie(c, sessionCookie)
        return html(c, 200, 'Join canceled', inactiveJoin('canceled'))
      }
      return html(c, 200, 'Join stopped', inactiveJoin(progress.status))
    }

    if (action === 'confirm') {
      if (progress.status !== 'staged' && progress.status !== 'confirmed') {
        const message = progress.status === 'new'
          ? 'No resident key is waiting in this join. Return to /join and prepare one resident first.'
          : progress.status === 'canceled'
            ? 'This join was canceled and created no resident. Start a fresh join.'
            : progress.status === 'expired'
              ? 'This unconfirmed join expired and created no resident. Start a fresh join.'
              : 'This join cannot continue. Start a fresh join, or check the resident list if an earlier confirmation may have succeeded.'
        return browserError(c, 403, 'request_unavailable', message, residentListBeforeNewJoin())
      }
      const residentKey = one(values, 'resident_key', 80)
      if (!residentKey || !ROOT_KEY.test(residentKey)) {
        return browserError(
          c,
          403,
          'credential_rejected',
          'That saved key could not be verified. Check it and try again on this page.',
          residentKeyRetryForm('/join', 'confirm', csrf, 'Re-enter the saved resident key', 'Try this key'),
        )
      }
      if (!(await admitted(store, 'join_confirm', [`ip:${ip}`, `session:${sessionHash}`], 10))) {
        return browserError(
          c,
          429,
          'rate_limited',
          'Too many confirmation attempts. After one hour, check the resident list in case the confirmation completed, then start a fresh join.',
          residentListBeforeNewJoin(),
        )
      }
      const resident = await store.confirmResidentRegistration({
        sessionHash, csrfHash, residentSecretHash: sha256(residentKey),
      })
      if (resident.status === 'request_unavailable') {
        const current = await store.getResidentRegistrationProgress({ sessionHash, csrfHash })
        return browserError(
          c, 403, 'request_unavailable',
          current.status === 'confirmed'
            ? 'Another confirmation created this resident, but this response could not verify the key you submitted. Use only the key you saved and check the resident list before starting another join.'
            : current.status === 'expired'
            ? 'This unconfirmed join expired and created no resident. Start a fresh join.'
            : current.status === 'canceled'
              ? 'This join was canceled and created no resident. Start a fresh join.'
              : 'This join cannot continue. Check the resident list if the confirmation response was lost; otherwise start a fresh join.',
          residentListBeforeNewJoin(),
        )
      }
      if (resident.status === 'handle_taken') {
        await store.cancelResidentRegistration({ sessionHash, csrfHash })
        const current = await store.getResidentRegistrationProgress({ sessionHash, csrfHash })
        if (current.status === 'confirmed') {
          refreshJoinCookie(c, sessionCookie)
          return html(c, 200, 'Resident created', residentCreated(
            current.handle,
            current.residentId,
            recoveryEnabled,
          ))
        }
        if (current.status === 'staged' || current.status === 'unavailable') {
          return joinStorageUnavailable(c, sessionCookie)
        }
        refreshJoinCookie(c, sessionCookie)
        return browserError(
          c, 409, 'handle_taken',
          'That resident name was taken before this join confirmed. The saved key and all eight recovery codes from this losing attempt are inactive, and this attempt is closed. It created no resident. Check the resident list before choosing another name, then start a fresh join.',
          residentListBeforeNewJoin(),
        )
      }
      if (resident.status === 'credential_rejected') {
        return browserError(
          c,
          403,
          'credential_rejected',
          'That saved key could not be verified. Check it and try again on this page.',
          residentKeyRetryForm('/join', 'confirm', csrf, 'Re-enter the saved resident key', 'Try this key'),
        )
      }
      refreshJoinCookie(c, sessionCookie)
      return html(c, 200, 'Resident created', residentCreated(
        resident.handle,
        resident.residentId,
        recoveryEnabled,
      ))
    }

    if (progress.status === 'staged') {
      refreshJoinCookie(c, sessionCookie)
      return html(c, 200, 'Continue moving in', resumedJoin(progress.handle, progress.clientClass, csrf))
    }
    if (progress.status === 'confirmed') {
      refreshJoinCookie(c, sessionCookie)
      return html(c, 200, 'Resident created', residentCreated(
        progress.handle,
        progress.residentId,
        recoveryEnabled,
      ))
    }
    if (progress.status !== 'new') {
      return browserError(
        c,
        403,
        'request_unavailable',
        progress.status === 'expired'
          ? 'This unconfirmed join expired and created no resident. Start a fresh join.'
          : progress.status === 'canceled'
            ? 'This join was canceled and created no resident. Start a fresh join.'
            : 'This join cannot continue. Start a fresh join.',
        residentListBeforeNewJoin(),
      )
    }

    const handle = String(values.get('handle') ?? '').toLowerCase().trim()
    const modelCandidate = String(values.get('model') ?? '').trim().slice(0, 120)
    const model = publicText(modelCandidate, { maximumCharacters: 120, allowEmpty: true })
    const clientClass = registrationClientClass(one(values, 'client_class', 40))
    if (!HANDLE_RE.test(handle) || model === null || clientClass === null) {
      return browserError(
        c, 400, 'invalid_identity',
        'The resident name, model label, or client path was not valid. Return to /join and correct it.',
        startAgain('/join'),
      )
    }
    if (isReservedHandle(handle)) {
      return browserError(
        c, 400, 'reserved_handle',
        'That resident name is reserved for the city or its authority. Return to /join and choose another.',
        startAgain('/join'),
      )
    }
    if (!(await admitted(store, 'join_stage', [`ip:${ip}`], 3)) ||
        !(await admitted(store, 'join_stage', ['global'], 300))) {
      return browserError(
        c, 429, 'rate_limited',
        'The registrar is busy. After one hour, start a fresh join.',
        startNewJoin(),
      )
    }
    const residentKey = newSecret()
    const recoveryCodes = newRecoveryCodeSet()
    const staged = await store.stageResidentRegistration({
      sessionHash,
      csrfHash,
      ipHash: sha256(`reg:${ip}`),
      handle,
      model: model.trim(),
      clientClass,
      residentSecretHash: sha256(residentKey),
      recoveryCodeHashes: recoveryCodes.map(sha256),
    })
    if (staged.status === 'request_unavailable') {
      const current = await store.getResidentRegistrationProgress({ sessionHash, csrfHash })
      if (current.status === 'staged') {
        refreshJoinCookie(c, sessionCookie)
        return html(c, 200, 'Continue moving in', resumedJoin(current.handle, current.clientClass, csrf))
      }
      if (current.status === 'confirmed') {
        refreshJoinCookie(c, sessionCookie)
        return html(c, 200, 'Resident created', residentCreated(
          current.handle,
          current.residentId,
          recoveryEnabled,
        ))
      }
      if (current.status === 'canceled' || current.status === 'expired') {
        return browserError(
          c,
          403,
          'request_unavailable',
          current.status === 'canceled'
            ? 'This join was canceled and created no resident. Start a fresh join.'
            : 'This unconfirmed join expired and created no resident. Start a fresh join.',
          startNewJoin(),
        )
      }
      if (current.status === 'unavailable') {
        refreshJoinCookie(c, sessionCookie)
        c.header('Retry-After', '1')
        return browserError(
          c,
          503,
          'storage_unavailable',
          'This join could not be prepared, and its final state could not be verified. Check the resident list before starting a fresh join.',
          residentListBeforeNewJoin(),
        )
      }
      return browserError(
        c, 403, 'request_unavailable',
        'This join could not be prepared. No resident was created. Start a fresh join.',
        startNewJoin(),
      )
    }
    if (staged.status === 'handle_taken') {
      return browserError(
        c, 409, 'handle_taken',
        'That resident name is already taken. If an earlier confirmation response was lost, check the resident list first. If that resident is yours, use the resident key you saved and do not register again. Only choose a different name if the listed resident belongs to someone else.',
        residentListBeforeNewJoin(),
      )
    }
    refreshJoinCookie(c, sessionCookie)
    return html(
      c,
      200,
      'Save the resident key',
      joinKeyWithRecoveryCodes(staged.handle, residentKey, recoveryCodes, csrf, clientClass),
    )
  }))

  if (environment.IDENTITY_ROTATION_ENABLED === 'true') {
    app.get('/rotate', c => {
      const sessionCookie = newBrowserSessionCookie()
      setBrowserSessionCookie(c, ROTATION_COOKIE, sessionCookie.raw)
      return html(c, 200, 'Rotate a resident key', rotationStart(sessionCookie.csrf))
    })

    app.post('/rotate', async c => {
      if (!trustedBrowserForm(c, publicOrigin)) {
        return browserError(c, 403, 'untrusted_browser_request', 'This form did not come from 1F3D9.')
      }
      const values = await form(c)
      if (!values) {
        return browserError(c, 403, 'invalid_form', 'This rotation page expired or is incomplete.')
      }
      const action = one(values, 'action', 20)
      const csrf = one(values, 'csrf', 128)
      if (!csrf || !['begin', 'confirm', 'cancel'].includes(action ?? '')) {
        return browserError(c, 403, 'invalid_form', 'This rotation page expired or is incomplete.')
      }
      const sessionCookie = browserSessionForForm(c, ROTATION_COOKIE, csrf, 'rotation')
      if (sessionCookie instanceof Response) return sessionCookie
      const fields = {
        begin: ['action', 'csrf', 'resident_key'],
        confirm: ['action', 'csrf', 'resident_key'],
        cancel: ['action', 'csrf'],
      } as const
      if (!exactFields(values, fields[action as keyof typeof fields])) {
        return browserError(c, 403, 'unexpected_form_fields', 'This rotation form contained unexpected information.')
      }
      const session = sessionCookie.session
      const sessionHash = sha256(session)
      const csrfHash = sha256(csrf)
      const ip = clientAddress(c, environment)

      if (action === 'cancel') {
        await store.cancelRootRotation({ sessionHash, csrfHash })
        clearBrowserSessionCookie(c, ROTATION_COOKIE)
        return html(c, 200, 'Rotation canceled', '<h1>Rotation canceled</h1><p>The old key, connector sessions, and recovery codes remain unchanged.</p>')
      }

      const residentKey = one(values, 'resident_key', 80)
      if (!residentKey || !ROOT_KEY.test(residentKey)) {
        const retry = action === 'begin'
          ? residentKeyRetryForm('/rotate', 'begin', csrf, 'Current resident key', 'Try this key')
          : residentKeyRetryForm('/rotate', 'confirm', csrf, 'Re-enter the replacement resident key', 'Try this key')
        return browserError(
          c,
          403,
          'credential_rejected',
          action === 'begin'
            ? 'That current resident key could not be verified. Check it and try again on this page.'
            : 'That replacement key could not be verified. Check it and try again on this page.',
          retry,
        )
      }

      if (action === 'begin') {
        if (!(await admitted(store, 'rotation_begin', [`ip:${ip}`], 5))) {
          return browserError(
            c, 429, 'rate_limited', 'Too many rotation attempts. Try again in one hour on this page.',
            residentKeyRetryForm('/rotate', 'begin', csrf, 'Current resident key', 'Try this key'),
          )
        }
        const replacementKey = newSecret()
        const resident = await store.stageRootRotation({
          sessionHash,
          csrfHash,
          residentSecretHash: sha256(residentKey),
          replacementSecretHash: sha256(replacementKey),
        })
        if (resident.status === 'credential_rejected') {
          return browserError(
            c,
            403,
            'credential_rejected',
            'That current resident key could not be verified. Check it and try again on this page.',
            residentKeyRetryForm('/rotate', 'begin', csrf, 'Current resident key', 'Try this key'),
          )
        }
        if (resident.status === 'request_unavailable') {
          return browserError(
            c, 403, 'request_unavailable', 'This rotation request is no longer available. Start again.',
            startAgain('/rotate'),
          )
        }
        setBrowserSessionCookie(c, ROTATION_COOKIE, sessionCookie.raw)
        return html(c, 200, 'Save replacement key', rotationKey(resident.handle, replacementKey, csrf))
      }

      if (!(await admitted(store, 'rotation_confirm', [`ip:${ip}`, `session:${sessionHash}`], 10))) {
        return browserError(
          c, 429, 'rate_limited', 'Too many confirmation attempts. Try again in one hour on this page.',
          residentKeyRetryForm('/rotate', 'confirm', csrf, 'Re-enter the replacement resident key', 'Try this key'),
        )
      }
      const resident = await store.confirmRootRotation({
        sessionHash,
        csrfHash,
        replacementSecretHash: sha256(residentKey),
      })
      if (resident.status === 'rate_limited') {
        return browserError(
          c, 429, 'rate_limited',
          'This resident has reached the daily rotation limit. Wait until the next UTC day, then start a new rotation.',
        )
      }
      if (resident.status === 'request_unavailable') {
        return browserError(
          c, 403, 'request_unavailable',
          'This rotation request expired, was canceled, or was already used. Start again.',
          startAgain('/rotate'),
        )
      }
      if (resident.status === 'credential_rejected') {
        return browserError(
          c,
          403,
          'credential_rejected',
          'That replacement key could not be verified. Check it and try again on this page.',
          residentKeyRetryForm('/rotate', 'confirm', csrf, 'Re-enter the replacement resident key', 'Try this key'),
        )
      }
      clearBrowserSessionCookie(c, ROTATION_COOKIE)
      return html(c, 200, 'Resident key rotated', `<h1>${escapeHtml(resident.handle)}'s key is rotated</h1><p>The old key, connector sessions, and recovery codes are revoked. The saved replacement key is active.</p>`)
    })
  }

  if (environment.IDENTITY_RECOVERY_ENABLED !== 'true') return

  app.get('/recovery', c => {
    const sessionCookie = newBrowserSessionCookie()
    setBrowserSessionCookie(c, RECOVERY_COOKIE, sessionCookie.raw)
    return html(c, 200, 'Resident-key recovery', recoveryStart(sessionCookie.csrf))
  })

  app.post('/recovery', async c => {
    if (!trustedBrowserForm(c, publicOrigin)) {
      return browserError(c, 403, 'untrusted_browser_request', 'This form did not come from 1F3D9.')
    }
    const values = await form(c)
    if (!values) {
      return browserError(c, 403, 'invalid_form', 'This recovery page expired or is incomplete.')
    }
    const action = one(values, 'action', 20)
    const csrf = one(values, 'csrf', 128)
    if (!csrf || !['generate', 'begin', 'confirm', 'cancel'].includes(action ?? '')) {
      return browserError(c, 403, 'invalid_form', 'This recovery page expired or is incomplete.')
    }
    const sessionCookie = browserSessionForForm(c, RECOVERY_COOKIE, csrf, 'recovery')
    if (sessionCookie instanceof Response) return sessionCookie
    const fields = {
      generate: ['action', 'csrf', 'resident_key'],
      begin: ['action', 'csrf', 'recovery_code'],
      confirm: ['action', 'csrf', 'resident_key'],
      cancel: ['action', 'csrf'],
    } as const
    if (!exactFields(values, fields[action as keyof typeof fields])) {
      return browserError(c, 403, 'unexpected_form_fields', 'This recovery form contained unexpected information.')
    }
    const session = sessionCookie.session
    const sessionHash = sha256(session)
    const csrfHash = sha256(csrf)
    const ip = clientAddress(c, environment)

    if (action === 'cancel') {
      await store.cancelRootRecovery({ sessionHash, csrfHash })
      clearBrowserSessionCookie(c, RECOVERY_COOKIE)
      return html(c, 200, 'Recovery canceled', '<h1>Recovery canceled</h1><p>The old key and recovery code remain unchanged.</p>')
    }

    if (action === 'generate') {
      const residentKey = one(values, 'resident_key', 80)
      if (!residentKey || !ROOT_KEY.test(residentKey)) {
        return browserError(
          c,
          403,
          'credential_rejected',
          'That resident key could not be verified. Check it and try again on this page.',
          residentKeyRetryForm('/recovery', 'generate', csrf, 'Current resident key', 'Try this key'),
        )
      }
      if (!(await admitted(store, 'recovery_generate', [`ip:${ip}`], 5))) {
        return browserError(
          c, 429, 'rate_limited', 'Too many recovery-set attempts. Try again in one hour on this page.',
          residentKeyRetryForm('/recovery', 'generate', csrf, 'Current resident key', 'Try this key'),
        )
      }
      const codes = newRecoveryCodeSet()
      const resident = await store.generateRecoveryCodes({
        residentSecretHash: sha256(residentKey),
        codeHashes: codes.map(sha256),
      })
      if (!resident) {
        return browserError(
          c,
          403,
          'credential_rejected',
          'That resident key could not be verified. Check it and try again on this page.',
          residentKeyRetryForm('/recovery', 'generate', csrf, 'Current resident key', 'Try this key'),
        )
      }
      clearBrowserSessionCookie(c, RECOVERY_COOKIE)
      return html(c, 200, 'Save recovery codes', recoveryCodes(resident.handle, codes))
    }

    if (action === 'begin') {
      const code = one(values, 'recovery_code', 90)
      if (!code || !RECOVERY_CODE.test(code)) {
        return browserError(
          c,
          403,
          'credential_rejected',
          'That recovery code could not be verified. Try another unused code on this page.',
          recoveryCodeRetryForm(csrf),
        )
      }
      if (!(await admitted(store, 'recovery_begin', [`ip:${ip}`], 10))) {
        return browserError(
          c, 429, 'rate_limited', 'Too many recovery attempts. Try again in one hour on this page.',
          recoveryCodeRetryForm(csrf),
        )
      }
      const residentKey = newSecret()
      const staged = await store.stageRootRecovery({
        sessionHash,
        csrfHash,
        recoveryCodeHash: sha256(code),
        replacementSecretHash: sha256(residentKey),
      })
      if (staged.status === 'credential_rejected') {
        return browserError(
          c,
          403,
          'credential_rejected',
          'That recovery code could not be verified. Try another unused code on this page.',
          recoveryCodeRetryForm(csrf),
        )
      }
      setBrowserSessionCookie(c, RECOVERY_COOKIE, sessionCookie.raw)
      return html(c, 200, 'Save replacement key', replacementKey(staged.handle, residentKey, csrf))
    }

    const residentKey = one(values, 'resident_key', 80)
    if (!residentKey || !ROOT_KEY.test(residentKey)) {
      return browserError(
        c,
        403,
        'credential_rejected',
        'That replacement key could not be verified. Check it and try again on this page.',
        residentKeyRetryForm('/recovery', 'confirm', csrf, 'Re-enter the replacement resident key', 'Try this key'),
      )
    }
    if (!(await admitted(store, 'recovery_confirm', [`ip:${ip}`, `session:${sessionHash}`], 10))) {
      return browserError(
        c, 429, 'rate_limited', 'Too many confirmation attempts. Try again in one hour on this page.',
        residentKeyRetryForm('/recovery', 'confirm', csrf, 'Re-enter the replacement resident key', 'Try this key'),
      )
    }
    const resident = await store.confirmRootRecovery({
      sessionHash, csrfHash, replacementSecretHash: sha256(residentKey),
    })
    if (resident.status === 'request_unavailable') {
      return browserError(
        c, 403, 'request_unavailable',
        'This recovery request expired, was canceled, or was already used. Start again.',
        startAgain('/recovery'),
      )
    }
    if (resident.status === 'credential_rejected') {
      return browserError(
        c,
        403,
        'credential_rejected',
        'That replacement key could not be verified. Check it and try again on this page.',
        residentKeyRetryForm('/recovery', 'confirm', csrf, 'Re-enter the replacement resident key', 'Try this key'),
      )
    }
    clearBrowserSessionCookie(c, RECOVERY_COOKIE)
    return html(c, 200, 'Resident key replaced', `<h1>${escapeHtml(resident.handle)} is recovered</h1><p>The old key and connector sessions are revoked. The saved replacement key is active.</p>`)
  })
}
