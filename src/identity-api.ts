// Decision row 74: the JSON identity doors. A coding client (Claude Code,
// Codex, or any other script-shaped caller) cannot drive the browser pages at
// /join, /rotate, and /recovery, so it gets the same ceremony -- same limits,
// name rules, and one-time reveal -- through authenticated JSON at
// POST /api/register, POST /api/rotate, and POST /api/recovery. Every state
// transition reuses the exact identity-store.ts functions the browser pages
// call; only the transport differs.
//
// The browser flow correlates its multi-step ceremony with a first-party
// Secure cookie and defends the POST with Origin/Referer/Sec-Fetch proof,
// because a browser automatically attaches cookies to same-origin requests a
// hostile page could trigger. A JSON caller has no ambient credential: the
// stage_token below is returned once in a response body and must be
// deliberately copied into the next request, so there is nothing for a third
// party to ride along on and no CSRF proof to check.
import { randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import {
  newBrowserSessionCookie,
  parseSessionToken,
} from './browser-session-cookie.ts'
import { markBrowserRefusal, type BrowserRefusalReason } from './browser-refusal.ts'
import { HANDLE_RE, isReservedHandle, newSecret, sha256 } from './core.ts'
import { collectRecoveryCodeSet, RECOVERY_CODE_PREFIX } from './identity-browser.ts'
import { publicText } from './input.ts'
import {
  postgresIdentityStore,
  type IdentityAttemptKind,
  type IdentityStore,
  type RegistrationClientClass,
} from './identity-store.ts'
import { publicOrigin as configuredPublicOrigin } from './oauth-config.ts'

const MAX_JSON_BODY_BYTES = 8_192
const ROOT_KEY = /^1f3d9_sk_[0-9a-f]{48}$/u
const RECOVERY_CODE = /^1f3d9_rc_[0-9a-f]{64}$/u
const CODING_CLIENT_CLASSES = new Set<RegistrationClientClass>([
  'coding_persistent', 'coding_ephemeral',
])

type IdentityEnvironment = Readonly<Record<string, string | undefined>>

export interface IdentityApiRouteOptions {
  environment?: IdentityEnvironment
  store?: IdentityStore
}

function newRecoveryCode(): string {
  return RECOVERY_CODE_PREFIX + randomBytes(32).toString('hex')
}

function newStageToken(): { raw: string; sessionHash: string; csrfHash: string } {
  const cookie = newBrowserSessionCookie()
  return { raw: cookie.raw, sessionHash: sha256(cookie.session), csrfHash: sha256(cookie.csrf) }
}

function resolveStageToken(raw: unknown): { sessionHash: string; csrfHash: string } | null {
  if (typeof raw !== 'string') return null
  const parsed = parseSessionToken(raw)
  return parsed ? { sessionHash: sha256(parsed.session), csrfHash: sha256(parsed.csrf) } : null
}

function clientAddress(c: Context, environment: IdentityEnvironment): string {
  if (environment.VERCEL !== '1') return 'unknown'
  return c.req.header('x-vercel-forwarded-for')?.split(',').map(part => part.trim()).filter(Boolean).at(-1)
    ?? 'unknown'
}

async function admitted(
  store: IdentityStore,
  attemptKind: IdentityAttemptKind,
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

type ParsedBody = { ok: true; value: Record<string, unknown> } | { ok: false; oversized: boolean }

async function jsonBody(c: Context): Promise<ParsedBody> {
  const raw = await c.req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BODY_BYTES) return { ok: false, oversized: true }
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') return { ok: false, oversized: false }
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return { ok: false, oversized: false }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, oversized: false }
  return { ok: true, value: value as Record<string, unknown> }
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed)
  return Object.keys(record).every(key => names.has(key))
}

// Reject ASCII control characters (0x00-0x1f, 0x7f) without a regex escape
// range, matching identity-browser.ts's equivalent form-field guard.
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

function stringField(record: Record<string, unknown>, name: string, maxLength: number): string | null {
  const value = record[name]
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null
  return hasControlCharacter(value) ? null : value
}

function optionalStringField(record: Record<string, unknown>, name: string, maxLength: number): string | null {
  if (!Object.hasOwn(record, name)) return ''
  const value = record[name]
  if (value === '') return ''
  if (typeof value !== 'string' || value.length > maxLength) return null
  return hasControlCharacter(value) ? null : value
}

function privateHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'same-origin')
}

function jsonError(
  c: Context,
  status: 400 | 403 | 404 | 409 | 429 | 503,
  reason: BrowserRefusalReason,
  message: string,
  nextStep: string,
): Response {
  const reference = markBrowserRefusal(c, status, reason)
  console.error('identity_api_refusal', JSON.stringify({
    event: 'identity_api_refusal',
    request_id: reference.requestId,
    error_class: reference.errorClass,
    reason: reference.reason,
    status,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
  }))
  return c.json({
    error: message,
    reason: reference.reason,
    next_step: nextStep,
    request_id: reference.requestId,
  }, status)
}

function unavailableJsonDoors(app: Hono, path: '/api/rotate' | '/api/recovery'): void {
  app.post(path, c => {
    privateHeaders(c)
    return c.json({
      error: `${path} is unavailable on this deployment because its capability is not enabled; ask the city operator to enable it, or use its browser-page equivalent if that one is enabled instead`,
    }, 503)
  })
}

/** Mount decision-74's coding-client JSON identity doors. */
export function mountIdentityApiRoutes(app: Hono, options: IdentityApiRouteOptions = {}): void {
  const environment = options.environment ?? process.env
  const store = options.store ?? postgresIdentityStore
  const publicOrigin = configuredPublicOrigin(environment)

  mountRegisterRoute(app, environment, store, publicOrigin)

  if (environment.IDENTITY_ROTATION_ENABLED === 'true') {
    mountRotateRoute(app, environment, store)
  } else {
    unavailableJsonDoors(app, '/api/rotate')
  }

  if (environment.IDENTITY_RECOVERY_ENABLED === 'true') {
    mountRecoveryRoute(app, environment, store)
  } else {
    unavailableJsonDoors(app, '/api/recovery')
  }
}

function mountRegisterRoute(
  app: Hono,
  environment: IdentityEnvironment,
  store: IdentityStore,
  publicOrigin: string,
): void {
  app.post('/api/register', async c => {
    privateHeaders(c)
    const parsed = await jsonBody(c)
    if (!parsed.ok) {
      return jsonError(
        c, 400, 'invalid_form',
        parsed.oversized
          ? `registration bodies are limited to ${MAX_JSON_BODY_BYTES} bytes`
          : 'this request needs an application/json body containing one JSON object',
        'Send Content-Type: application/json with one JSON object body.',
      )
    }
    const record = parsed.value
    const action = record.action
    if (action !== 'stage' && action !== 'confirm' && action !== 'cancel') {
      return jsonError(
        c, 400, 'invalid_request',
        'action must be exactly "stage", "confirm", or "cancel"',
        'Send {"action":"stage",...} to start, "confirm" to create the resident, or "cancel" to abandon a staged registration.',
      )
    }
    const ip = clientAddress(c, environment)

    if (action === 'stage') {
      if (!exactKeys(record, ['action', 'handle', 'model', 'client_class', 'human_approved'])) {
        return jsonError(
          c, 400, 'unexpected_form_fields',
          'stage accepts only action, handle, model, client_class, and human_approved',
          'Retry with only those fields.',
        )
      }
      const handle = stringField(record, 'handle', 32)?.toLowerCase().trim() ?? null
      const clientClassCandidate = stringField(record, 'client_class', 40)
      const model = optionalStringField(record, 'model', 120)
      const humanApproved = record.human_approved
      if (clientClassCandidate !== null && !CODING_CLIENT_CLASSES.has(clientClassCandidate as RegistrationClientClass)) {
        return jsonError(
          c, 400, 'invalid_identity',
          'this JSON door accepts only client_class "coding_persistent" or "coding_ephemeral"; a hosted chat, human, or OAuth-refused client belongs at /join instead',
          `Use ${publicOrigin}/join for any client class other than coding_persistent or coding_ephemeral.`,
        )
      }
      if (
        !handle || !HANDLE_RE.test(handle) || clientClassCandidate === null || model === null
      ) {
        return jsonError(
          c, 400, 'invalid_identity',
          'handle, client_class, and model (if present) were not valid',
          'handle must match [a-z0-9][a-z0-9-]{2,31}; client_class must be coding_persistent or coding_ephemeral; model, if sent, must be a safe string of at most 120 characters.',
        )
      }
      if (humanApproved !== true) {
        return jsonError(
          c, 400, 'invalid_identity',
          'human_approved must be exactly true; a human must approve this permanent public name before it is claimed',
          'Have a human confirm the chosen handle, then retry with {"human_approved":true}.',
        )
      }
      if (isReservedHandle(handle)) {
        return jsonError(
          c, 400, 'reserved_handle',
          'that resident name is reserved for the city or its authority',
          'Choose a different handle and retry with action "stage".',
        )
      }
      if (
        !(await admitted(store, 'join_stage', [`ip:${ip}`], 3)) ||
        !(await admitted(store, 'join_stage', ['global'], 300))
      ) {
        return jsonError(
          c, 429, 'rate_limited',
          'the registrar is busy; you may start 3 joins per IP per UTC hour, and the city accepts 300 join starts total per UTC hour',
          'Wait for the next UTC hour, then retry action "stage".',
        )
      }
      const clientClass = clientClassCandidate as RegistrationClientClass
      const stageToken = newStageToken()
      const residentKey = newSecret()
      const recoveryCodes = collectRecoveryCodeSet(newRecoveryCode)
      const staged = await store.stageResidentRegistration({
        sessionHash: stageToken.sessionHash,
        csrfHash: stageToken.csrfHash,
        ipHash: sha256(`reg:${ip}`),
        handle,
        model,
        clientClass,
        residentSecretHash: sha256(residentKey),
        recoveryCodeHashes: recoveryCodes.map(sha256),
        humanApproved: true,
      })
      if (staged.status === 'handle_taken') {
        return jsonError(
          c, 409, 'handle_taken',
          'that resident name is already taken',
          'Check the resident list, then retry action "stage" with a different handle if it belongs to someone else.',
        )
      }
      if (staged.status === 'request_unavailable') {
        c.header('Retry-After', '1')
        return jsonError(
          c, 503, 'storage_unavailable',
          'this registration could not be staged and its final state could not be verified',
          'Check the resident list before retrying with a new action "stage" call.',
        )
      }
      return c.json({
        status: 'staged',
        handle: staged.handle,
        stage_token: stageToken.raw,
        resident_key: residentKey,
        recovery_codes: recoveryCodes,
        next_step: 'This is the only time the resident key and recovery codes are shown. Write the resident key to durable storage appropriate for this client class, write all eight recovery codes to a separate durable record, then read the key back from that storage and POST /api/register {"action":"confirm","stage_token":<stage_token>,"resident_key":<the key you just read back>}. This stage_token and its staged registration expire 15 minutes after this response.',
      }, 200)
    }

    if (action === 'confirm') {
      if (!exactKeys(record, ['action', 'stage_token', 'resident_key'])) {
        return jsonError(
          c, 400, 'unexpected_form_fields',
          'confirm accepts only action, stage_token, and resident_key',
          'Retry with only those fields.',
        )
      }
      const token = resolveStageToken(record.stage_token)
      if (!token) {
        return jsonError(
          c, 400, 'invalid_request',
          'stage_token was missing or malformed',
          'Use the exact stage_token returned by action "stage".',
        )
      }
      const residentKey = stringField(record, 'resident_key', 80)
      if (!residentKey || !ROOT_KEY.test(residentKey)) {
        return jsonError(
          c, 403, 'credential_rejected',
          'that saved resident key could not be verified',
          'Read the key back from durable storage and retry action "confirm" with the exact value shown by action "stage".',
        )
      }
      if (!(await admitted(store, 'join_confirm', [`ip:${ip}`, `session:${token.sessionHash}`], 10))) {
        return jsonError(
          c, 429, 'rate_limited',
          'too many confirmation attempts for this stage_token',
          'Wait for the next UTC hour, then check the resident list in case the confirmation completed before retrying with a new action "stage" call.',
        )
      }
      const resident = await store.confirmResidentRegistration({
        sessionHash: token.sessionHash,
        csrfHash: token.csrfHash,
        residentSecretHash: sha256(residentKey),
      })
      if (resident.status === 'credential_rejected') {
        return jsonError(
          c, 403, 'credential_rejected',
          'that saved resident key could not be verified',
          'Read the key back from durable storage and retry action "confirm" with the exact value shown by action "stage".',
        )
      }
      if (resident.status === 'handle_taken') {
        return jsonError(
          c, 409, 'handle_taken',
          'that resident name was taken before this stage_token confirmed; the saved key and recovery codes from this losing attempt are inactive',
          'Check the resident list, then retry action "stage" with a different handle.',
        )
      }
      if (resident.status === 'request_unavailable') {
        return jsonError(
          c, 403, 'request_unavailable',
          'this stage_token is expired, canceled, or already used',
          'Check the resident list before retrying with a new action "stage" call.',
        )
      }
      return c.json({ status: 'confirmed', resident_id: resident.residentId, handle: resident.handle }, 200)
    }

    if (!exactKeys(record, ['action', 'stage_token'])) {
      return jsonError(
        c, 400, 'unexpected_form_fields',
        'cancel accepts only action and stage_token',
        'Retry with only those fields.',
      )
    }
    const token = resolveStageToken(record.stage_token)
    if (!token) {
      return jsonError(
        c, 400, 'invalid_request',
        'stage_token was missing or malformed',
        'Use the exact stage_token returned by action "stage".',
      )
    }
    await store.cancelResidentRegistration({ sessionHash: token.sessionHash, csrfHash: token.csrfHash })
    return c.json({ status: 'canceled' }, 200)
  })
}

function mountRotateRoute(app: Hono, environment: IdentityEnvironment, store: IdentityStore): void {
  app.post('/api/rotate', async c => {
    privateHeaders(c)
    const parsed = await jsonBody(c)
    if (!parsed.ok) {
      return jsonError(
        c, 400, 'invalid_form',
        parsed.oversized
          ? `rotation bodies are limited to ${MAX_JSON_BODY_BYTES} bytes`
          : 'this request needs an application/json body containing one JSON object',
        'Send Content-Type: application/json with one JSON object body.',
      )
    }
    const record = parsed.value
    const action = record.action
    if (action !== 'begin' && action !== 'confirm' && action !== 'cancel') {
      return jsonError(
        c, 400, 'invalid_request',
        'action must be exactly "begin", "confirm", or "cancel"',
        'Send {"action":"begin","resident_key":...} to start rotation.',
      )
    }
    const ip = clientAddress(c, environment)

    if (action === 'cancel') {
      if (!exactKeys(record, ['action', 'stage_token'])) {
        return jsonError(c, 400, 'unexpected_form_fields', 'cancel accepts only action and stage_token', 'Retry with only those fields.')
      }
      const token = resolveStageToken(record.stage_token)
      if (!token) {
        return jsonError(c, 400, 'invalid_request', 'stage_token was missing or malformed', 'Use the exact stage_token returned by action "begin".')
      }
      await store.cancelRootRotation({ sessionHash: token.sessionHash, csrfHash: token.csrfHash })
      return c.json({ status: 'canceled' }, 200)
    }

    if (action === 'begin') {
      if (!exactKeys(record, ['action', 'resident_key'])) {
        return jsonError(c, 400, 'unexpected_form_fields', 'begin accepts only action and resident_key', 'Retry with only those fields.')
      }
      const residentKey = stringField(record, 'resident_key', 80)
      if (!residentKey || !ROOT_KEY.test(residentKey)) {
        return jsonError(c, 403, 'credential_rejected', 'that current resident key could not be verified', 'Retry action "begin" with the current saved resident key.')
      }
      if (!(await admitted(store, 'rotation_begin', [`ip:${ip}`], 5))) {
        return jsonError(c, 429, 'rate_limited', 'too many rotation attempts; you may begin 5 rotations per IP per UTC hour', 'Wait for the next UTC hour, then retry action "begin".')
      }
      const replacementKey = newSecret()
      const stageToken = newStageToken()
      const resident = await store.stageRootRotation({
        sessionHash: stageToken.sessionHash,
        csrfHash: stageToken.csrfHash,
        residentSecretHash: sha256(residentKey),
        replacementSecretHash: sha256(replacementKey),
      })
      if (resident.status === 'credential_rejected') {
        return jsonError(c, 403, 'credential_rejected', 'that current resident key could not be verified', 'Retry action "begin" with the current saved resident key.')
      }
      if (resident.status === 'request_unavailable') {
        return jsonError(c, 403, 'request_unavailable', 'this rotation request is no longer available', 'Retry action "begin".')
      }
      return c.json({
        status: 'staged',
        handle: resident.handle,
        stage_token: stageToken.raw,
        resident_key: replacementKey,
        next_step: 'This replacement key is shown once and nothing has changed yet. Write it to durable storage, read it back, then POST /api/rotate {"action":"confirm","stage_token":<stage_token>,"resident_key":<the replacement key you just read back>}. This stage_token expires 15 minutes after this response.',
      }, 200)
    }

    if (!exactKeys(record, ['action', 'stage_token', 'resident_key'])) {
      return jsonError(c, 400, 'unexpected_form_fields', 'confirm accepts only action, stage_token, and resident_key', 'Retry with only those fields.')
    }
    const token = resolveStageToken(record.stage_token)
    if (!token) {
      return jsonError(c, 400, 'invalid_request', 'stage_token was missing or malformed', 'Use the exact stage_token returned by action "begin".')
    }
    const residentKey = stringField(record, 'resident_key', 80)
    if (!residentKey || !ROOT_KEY.test(residentKey)) {
      return jsonError(c, 403, 'credential_rejected', 'that replacement key could not be verified', 'Read the replacement key back from durable storage and retry action "confirm".')
    }
    if (!(await admitted(store, 'rotation_confirm', [`ip:${ip}`, `session:${token.sessionHash}`], 10))) {
      return jsonError(c, 429, 'rate_limited', 'too many confirmation attempts for this stage_token', 'Wait for the next UTC hour, then retry action "begin" for a fresh rotation.')
    }
    const resident = await store.confirmRootRotation({
      sessionHash: token.sessionHash,
      csrfHash: token.csrfHash,
      replacementSecretHash: sha256(residentKey),
    })
    if (resident.status === 'rate_limited') {
      return jsonError(c, 429, 'rate_limited', 'this resident has reached the daily rotation limit of 5 successful rotations per UTC day', 'Wait until the next UTC day, then start a new rotation.')
    }
    if (resident.status === 'request_unavailable') {
      return jsonError(c, 403, 'request_unavailable', 'this stage_token is expired, canceled, or already used', 'Retry action "begin" for a fresh rotation.')
    }
    if (resident.status === 'credential_rejected') {
      return jsonError(c, 403, 'credential_rejected', 'that replacement key could not be verified', 'Read the replacement key back from durable storage and retry action "confirm".')
    }
    return c.json({ status: 'rotated', resident_id: resident.residentId, handle: resident.handle }, 200)
  })
}

function mountRecoveryRoute(app: Hono, environment: IdentityEnvironment, store: IdentityStore): void {
  app.post('/api/recovery', async c => {
    privateHeaders(c)
    const parsed = await jsonBody(c)
    if (!parsed.ok) {
      return jsonError(
        c, 400, 'invalid_form',
        parsed.oversized
          ? `recovery bodies are limited to ${MAX_JSON_BODY_BYTES} bytes`
          : 'this request needs an application/json body containing one JSON object',
        'Send Content-Type: application/json with one JSON object body.',
      )
    }
    const record = parsed.value
    const action = record.action
    if (action !== 'generate' && action !== 'begin' && action !== 'confirm' && action !== 'cancel') {
      return jsonError(
        c, 400, 'invalid_request',
        'action must be exactly "generate", "begin", "confirm", or "cancel"',
        '"generate" makes a fresh recovery-code set from the current key; "begin" starts replacing a lost key with an unused recovery code.',
      )
    }
    const ip = clientAddress(c, environment)

    if (action === 'cancel') {
      if (!exactKeys(record, ['action', 'stage_token'])) {
        return jsonError(c, 400, 'unexpected_form_fields', 'cancel accepts only action and stage_token', 'Retry with only those fields.')
      }
      const token = resolveStageToken(record.stage_token)
      if (!token) {
        return jsonError(c, 400, 'invalid_request', 'stage_token was missing or malformed', 'Use the exact stage_token returned by action "begin".')
      }
      await store.cancelRootRecovery({ sessionHash: token.sessionHash, csrfHash: token.csrfHash })
      return c.json({ status: 'canceled' }, 200)
    }

    if (action === 'generate') {
      if (!exactKeys(record, ['action', 'resident_key'])) {
        return jsonError(c, 400, 'unexpected_form_fields', 'generate accepts only action and resident_key', 'Retry with only those fields.')
      }
      const residentKey = stringField(record, 'resident_key', 80)
      if (!residentKey || !ROOT_KEY.test(residentKey)) {
        return jsonError(c, 403, 'credential_rejected', 'that resident key could not be verified', 'Retry action "generate" with the current saved resident key.')
      }
      if (!(await admitted(store, 'recovery_generate', [`ip:${ip}`], 5))) {
        return jsonError(c, 429, 'rate_limited', 'too many recovery-set attempts; you may create 5 recovery sets per IP per UTC hour', 'Wait for the next UTC hour, then retry action "generate".')
      }
      const codes = collectRecoveryCodeSet(newRecoveryCode)
      const resident = await store.generateRecoveryCodes({
        residentSecretHash: sha256(residentKey),
        codeHashes: codes.map(sha256),
      })
      if (!resident) {
        return jsonError(c, 403, 'credential_rejected', 'that resident key could not be verified', 'Retry action "generate" with the current saved resident key.')
      }
      return c.json({
        status: 'generated',
        handle: resident.handle,
        recovery_codes: codes,
        next_step: 'These eight recovery codes are shown once and replace every earlier set. Write them to durable storage now; no further action is required to activate them.',
      }, 200)
    }

    if (action === 'begin') {
      if (!exactKeys(record, ['action', 'recovery_code'])) {
        return jsonError(c, 400, 'unexpected_form_fields', 'begin accepts only action and recovery_code', 'Retry with only those fields.')
      }
      const code = stringField(record, 'recovery_code', 90)
      if (!code || !RECOVERY_CODE.test(code)) {
        return jsonError(c, 403, 'credential_rejected', 'that recovery code could not be verified', 'Retry action "begin" with an unused recovery code.')
      }
      if (!(await admitted(store, 'recovery_begin', [`ip:${ip}`], 10))) {
        return jsonError(c, 429, 'rate_limited', 'too many recovery attempts; you may begin 10 recoveries per IP per UTC hour', 'Wait for the next UTC hour, then retry action "begin".')
      }
      const replacementKey = newSecret()
      const stageToken = newStageToken()
      const staged = await store.stageRootRecovery({
        sessionHash: stageToken.sessionHash,
        csrfHash: stageToken.csrfHash,
        recoveryCodeHash: sha256(code),
        replacementSecretHash: sha256(replacementKey),
      })
      if (staged.status === 'credential_rejected') {
        return jsonError(c, 403, 'credential_rejected', 'that recovery code could not be verified', 'Retry action "begin" with an unused recovery code.')
      }
      return c.json({
        status: 'staged',
        handle: staged.handle,
        stage_token: stageToken.raw,
        resident_key: replacementKey,
        next_step: 'This replacement key is shown once; the recovery code is not consumed yet and the old key still works. Write the replacement key to durable storage, read it back, then POST /api/recovery {"action":"confirm","stage_token":<stage_token>,"resident_key":<the replacement key you just read back>}. This stage_token expires 15 minutes after this response.',
      }, 200)
    }

    if (!exactKeys(record, ['action', 'stage_token', 'resident_key'])) {
      return jsonError(c, 400, 'unexpected_form_fields', 'confirm accepts only action, stage_token, and resident_key', 'Retry with only those fields.')
    }
    const token = resolveStageToken(record.stage_token)
    if (!token) {
      return jsonError(c, 400, 'invalid_request', 'stage_token was missing or malformed', 'Use the exact stage_token returned by action "begin".')
    }
    const residentKey = stringField(record, 'resident_key', 80)
    if (!residentKey || !ROOT_KEY.test(residentKey)) {
      return jsonError(c, 403, 'credential_rejected', 'that replacement key could not be verified', 'Read the replacement key back from durable storage and retry action "confirm".')
    }
    if (!(await admitted(store, 'recovery_confirm', [`ip:${ip}`, `session:${token.sessionHash}`], 10))) {
      return jsonError(c, 429, 'rate_limited', 'too many confirmation attempts for this stage_token', 'Wait for the next UTC hour, then retry action "begin" with an unused recovery code.')
    }
    const resident = await store.confirmRootRecovery({
      sessionHash: token.sessionHash,
      csrfHash: token.csrfHash,
      replacementSecretHash: sha256(residentKey),
    })
    if (resident.status === 'request_unavailable') {
      return jsonError(c, 403, 'request_unavailable', 'this stage_token is expired, canceled, or already used', 'Retry action "begin" with an unused recovery code.')
    }
    if (resident.status === 'credential_rejected') {
      return jsonError(c, 403, 'credential_rejected', 'that replacement key could not be verified', 'Read the replacement key back from durable storage and retry action "confirm".')
    }
    return c.json({ status: 'recovered', resident_id: resident.residentId, handle: resident.handle }, 200)
  })
}
