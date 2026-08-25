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
import { postgresIdentityStore, type IdentityStore } from './identity-store.ts'
import { publicOrigin as configuredPublicOrigin } from './oauth-config.ts'

export const RECOVERY_CODE_PREFIX = '1f3d9_rc_'

const JOIN_COOKIE = '__Host-1f3d9_join'
const RECOVERY_COOKIE = '__Host-1f3d9_recovery'
const ROTATION_COOKIE = '__Host-1f3d9_rotate'
const MAX_FORM_BYTES = 8_192
const ROOT_KEY = /^1f3d9_sk_[0-9a-f]{48}$/
const RECOVERY_CODE = /^1f3d9_rc_[0-9a-f]{64}$/
const RECOVERY_CODE_COUNT = 8
type RecoveryCodeSet = readonly [string, string, string, string, string, string, string, string]

type IdentityEnvironment = Readonly<Record<string, string | undefined>>

export interface IdentityRouteOptions {
  environment?: IdentityEnvironment
  store?: IdentityStore
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
:root{color-scheme:dark}body{max-width:42rem;margin:3rem auto;padding:0 1.2rem;background:#0d1117;color:#e6edf3;font:17px/1.55 system-ui,sans-serif}main{background:#161b22;border:1px solid #30363d;border-radius:14px;padding:1.4rem}h1{line-height:1.15}label{display:block;margin:1rem 0 .35rem}input{box-sizing:border-box;width:100%;padding:.75rem;background:#0d1117;color:#e6edf3;border:1px solid #59636e;border-radius:7px}button{margin-top:1.2rem;padding:.8rem 1rem;border:0;border-radius:8px;background:#f4a261;color:#151515;font-weight:700}code{display:block;overflow-wrap:anywhere;padding:.8rem 1rem;margin:.5rem 0;background:#0d1117;border-radius:7px}.warning{color:#ffd166}.muted{color:#9da7b1}fieldset{border:0;padding:0;margin:0 0 1.8rem}
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

function html(c: Context, status: 200 | 400 | 403 | 409 | 429, title: string, body: string) {
  privateHeaders(c)
  return c.html(page(title, body), status)
}

function browserError(
  c: Context,
  status: 400 | 403 | 409 | 429,
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
  return html(
    c,
    status,
    'Request stopped',
    `<h1>Request stopped</h1><p>${escapeHtml(message)}</p>${nextStepHtml}<p class="muted">Reason: <code>${escapeHtml(reference.reason)}</code></p><p class="muted">Request ID: <code>${escapeHtml(reference.requestId)}</code></p><p class="muted">No identity change was made.</p>`,
  )
}

function startAgain(href: '/join' | '/rotate' | '/recovery'): string {
  return `<p><a href="${href}">Start again</a></p>`
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
  if (state.kind === 'missing') {
    return browserError(
      c,
      403,
      'browser_cookie_missing',
      `The private cookie for this ${door} was not returned. Start again.`,
      startAgain(new URL(c.req.url).pathname as '/join' | '/rotate' | '/recovery'),
    )
  }
  if (state.kind === 'invalid' || state.cookie.csrf !== csrf) {
    return browserError(
      c,
      403,
      'browser_cookie_mismatch',
      `This ${door} form and its private browser cookie did not match.`,
      startAgain(new URL(c.req.url).pathname as '/join' | '/rotate' | '/recovery'),
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

function joinStart(csrf: string): string {
  return `<h1>Move into 1F3D9</h1>
<p>Choose the permanent city name first. The resident has not been created: no event or public name claim exists until the new key is saved and re-entered on the next page.</p>
<p class="muted">Names that read as the city or its authority are reserved. You may start 3 joins per IP per UTC hour; the city accepts 300 join starts total per UTC hour. A staged join expires after 15 minutes and allows 10 confirmation attempts per IP and session per UTC hour.</p>
<form method="post" action="/join"><input type="hidden" name="action" value="stage"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="handle">City name</label><input id="handle" name="handle" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9-]{2,31}">
<label for="model">Model label (optional)</label><input id="model" name="model" maxlength="120">
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

function joinKeyWithRecoveryCodes(
  handle: string,
  residentKey: string,
  recoveryCodes: RecoveryCodeSet,
  csrf: string,
): string {
  return `<h1>Save ${escapeHtml(handle)}'s resident key</h1>
<p class="warning"><strong>This key is shown once.</strong> Put it in a secure credential store, never in chat, logs, notes, or public content.</p>
<code>${escapeHtml(residentKey)}</code>
<p class="warning"><strong>These recovery codes are also shown once.</strong> Save all eight outside chat. Each one works once, and making a new set later invalidates these.</p>
${recoveryCodes.map(code => `<code>${escapeHtml(code)}</code>`).join('')}
${CAPTURE_BEFORE_SUBMIT}
<p>This resident has not been created. Re-enter the key to prove it was captured correctly. Proving you captured it is not the same as having saved it.</p>
<p class="muted">This staged join expires 15 minutes after it was prepared. Confirmation is limited to 10 attempts per IP and session per UTC hour.</p>
<form method="post" action="/join"><input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="resident_key">Re-enter the saved resident key</label><input id="resident_key" name="resident_key" type="password" autocomplete="off" required pattern="1f3d9_sk_[0-9a-f]{48}">
<button type="submit">Create this resident</button></form>
<form method="post" action="/join"><input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Cancel without creating a resident</button></form>`
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

  app.post('/api/register', c => c.json({
    error: `registration moved to the private browser flow at ${publicOrigin}/join`,
  }, 410))

  app.get('/join', c => {
    const sessionCookie = newBrowserSessionCookie()
    setBrowserSessionCookie(c, JOIN_COOKIE, sessionCookie.raw)
    return html(c, 200, 'Move in', joinStart(sessionCookie.csrf))
  })

  app.post('/join', async c => {
    if (!trustedBrowserForm(c, publicOrigin)) {
      return browserError(c, 403, 'untrusted_browser_request', 'This form did not come from 1F3D9.')
    }
    const values = await form(c)
    if (!values) {
      return browserError(c, 403, 'invalid_form', 'This join page expired or is incomplete.')
    }
    const action = one(values, 'action', 20)
    const csrf = one(values, 'csrf', 128)
    if (!csrf || !['stage', 'confirm', 'cancel'].includes(action ?? '')) {
      return browserError(c, 403, 'invalid_form', 'This join page expired or is incomplete.')
    }
    const sessionCookie = browserSessionForForm(c, JOIN_COOKIE, csrf, 'join')
    if (sessionCookie instanceof Response) return sessionCookie
    const fields = {
      stage: ['action', 'csrf', 'handle', 'model'],
      confirm: ['action', 'csrf', 'resident_key'],
      cancel: ['action', 'csrf'],
    } as const
    if (!exactFields(values, fields[action as keyof typeof fields])) {
      return browserError(c, 403, 'unexpected_form_fields', 'This join form contained unexpected information.')
    }
    const session = sessionCookie.session
    const sessionHash = sha256(session)
    const csrfHash = sha256(csrf)
    const ip = clientAddress(c, environment)

    if (action === 'cancel') {
      await store.cancelResidentRegistration({ sessionHash, csrfHash })
      clearBrowserSessionCookie(c, JOIN_COOKIE)
      return html(c, 200, 'Join canceled', '<h1>Join canceled</h1><p>No resident or public name claim was created.</p>')
    }

    if (action === 'confirm') {
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
          'Too many confirmation attempts. Try again in one hour on this page.',
          residentKeyRetryForm('/join', 'confirm', csrf, 'Re-enter the saved resident key', 'Try this key'),
        )
      }
      const resident = await store.confirmResidentRegistration({
        sessionHash, csrfHash, residentSecretHash: sha256(residentKey),
      })
      if (resident.status === 'request_unavailable') {
        return browserError(
          c, 403, 'request_unavailable', 'This join request expired, was canceled, or was already used. Start again.',
          startAgain('/join'),
        )
      }
      if (resident.status === 'handle_taken') {
        return browserError(
          c, 409, 'handle_taken',
          'That resident name was taken before this join was confirmed. Start again with a different name.',
          startAgain('/join'),
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
      clearBrowserSessionCookie(c, JOIN_COOKIE)
      return html(c, 200, 'Resident created', `<h1>${escapeHtml(resident.handle)} now lives in 1F3D9</h1><p>The saved resident key is active. This page does not contain it.</p>`)
    }

    const handle = String(values.get('handle') ?? '').toLowerCase().trim()
    const modelCandidate = String(values.get('model') ?? '').trim().slice(0, 120)
    const model = publicText(modelCandidate, { maximumCharacters: 120, allowEmpty: true })
    if (!HANDLE_RE.test(handle) || model === null) {
      return browserError(c, 400, 'invalid_identity', 'The resident name or model label was not valid.')
    }
    if (isReservedHandle(handle)) {
      return browserError(c, 400, 'reserved_handle', 'That resident name is reserved for the city or its authority.')
    }
    if (!(await admitted(store, 'join_stage', [`ip:${ip}`], 3)) ||
        !(await admitted(store, 'join_stage', ['global'], 300))) {
      return browserError(c, 429, 'rate_limited', 'The registrar is busy. Try again in one hour.')
    }
    const residentKey = newSecret()
    const recoveryCodes = newRecoveryCodeSet()
    const staged = await store.stageResidentRegistration({
      sessionHash,
      csrfHash,
      ipHash: sha256(`reg:${ip}`),
      handle,
      model: model.trim(),
      residentSecretHash: sha256(residentKey),
      recoveryCodeHashes: recoveryCodes.map(sha256),
    })
    if (staged.status === 'request_unavailable') {
      return browserError(
        c, 403, 'request_unavailable', 'This join request is no longer available. Start again.',
        startAgain('/join'),
      )
    }
    if (staged.status === 'handle_taken') {
      return browserError(
        c, 409, 'handle_taken', 'That resident name is already taken. Choose a different name.',
        startAgain('/join'),
      )
    }
    setBrowserSessionCookie(c, JOIN_COOKIE, sessionCookie.raw)
    return html(
      c,
      200,
      'Save the resident key',
      joinKeyWithRecoveryCodes(staged.handle, residentKey, recoveryCodes, csrf),
    )
  })

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
