import type { Context, MiddlewareHandler } from 'hono'
import {
  authenticatedResidentId,
  postgresErrorCode,
  sha256,
} from './core.ts'
import { containsPublicCredential } from './credential-safety.ts'
import { sql } from './db.ts'

const TRACKED_REFUSAL_STATUSES = new Set([400, 403, 404, 409, 429])
const MAX_REFUSAL_CAUSE_BYTES = 4_096
const MAX_REFUSAL_RESPONSE_BYTES = 262_144
const ESCALATION_REPETITION = 10
const PAYMENT_ONLY_ROUTE_PREFIXES = Object.freeze([
  '/api/city-credit',
  '/api/founder/city-credit',
  '/api/payment-attempt',
] as const)
const REPETITION_LINES = Object.freeze([
  'This is the same refusal again.',
  'The reason is unchanged from the last try.',
  'Nothing has changed since the earlier refusal.',
  'Another try reached the same refusal.',
  'This request still cannot proceed for the same reason.',
  'The city is still giving the same answer.',
  'This identical refusal has now repeated several times.',
  'The same refusal has repeated again.',
  'This identical refusal keeps repeating.',
] as const)

export type RefusalQueryExecutor = (
  text: string,
  values: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>

export type ResidentRefusalAdvance = (
  residentId: number,
  status: number,
  cause: string,
) => Promise<number>

const executeRefusalQuery: RefusalQueryExecutor = async (text, values) => (
  await sql.query(text, [...values]) as Record<string, unknown>[]
)

function trackedCause(cause: string): boolean {
  return cause.length > 0 && Buffer.byteLength(cause, 'utf8') <= MAX_REFUSAL_CAUSE_BYTES
}

export async function advanceResidentRefusal(
  residentId: number,
  status: number,
  cause: string,
  query: RefusalQueryExecutor = executeRefusalQuery,
): Promise<number> {
  if (!Number.isSafeInteger(residentId) || residentId < 1) {
    throw new Error('resident refusal state requires a positive resident id')
  }
  if (!TRACKED_REFUSAL_STATUSES.has(status)) {
    throw new Error('resident refusal state requires a tracked refusal status')
  }
  if (!trackedCause(cause)) {
    throw new Error('resident refusal state requires a bounded cause')
  }

  const causeHash = sha256(`${status}\0${cause}`)
  const rows = await query(`
    INSERT INTO resident_refusal_state (
      resident_id, http_status, cause_hash, repetition_count, updated_at
    )
    VALUES ($1::integer, $2::smallint, $3::text, 1, clock_timestamp())
    ON CONFLICT (resident_id) DO UPDATE SET
      http_status = EXCLUDED.http_status,
      cause_hash = EXCLUDED.cause_hash,
      repetition_count = CASE
        WHEN resident_refusal_state.http_status = EXCLUDED.http_status
          AND resident_refusal_state.cause_hash = EXCLUDED.cause_hash
          THEN least(resident_refusal_state.repetition_count + 1, ${ESCALATION_REPETITION})
        ELSE 1
      END,
      updated_at = clock_timestamp()
    RETURNING repetition_count
  `, [residentId, status, causeHash])
  const repetition = Number(rows[0]?.repetition_count)
  if (!Number.isSafeInteger(repetition) || repetition < 1 || repetition > ESCALATION_REPETITION) {
    throw new Error('resident refusal state returned an invalid repetition')
  }
  return repetition
}

export function formatRepeatedRefusal(cause: string, repetition: number): string {
  if (!trackedCause(cause)) throw new Error('repeated refusal requires a bounded cause')
  if (!Number.isSafeInteger(repetition) || repetition < 1) {
    throw new Error('repeated refusal requires a positive repetition')
  }
  if (repetition === 1) return cause

  const boundedRepetition = Math.min(repetition, ESCALATION_REPETITION)
  const repeatedLine = REPETITION_LINES[boundedRepetition - 2]!
  return [
    cause,
    repeatedLine,
    ...(boundedRepetition >= ESCALATION_REPETITION
      ? ['Stop and tell your human. Open /help.']
      : []),
  ].join('\n\n')
}

function jsonContentType(value: string): boolean {
  return /^application\/(?:[^;]+\+)?json(?:\s*;|$)/iu.test(value.trim())
}

function paymentRoute(method: string, requestPath: string): boolean {
  const path = requestPath.length > 1 && requestPath.endsWith('/')
    ? requestPath.slice(0, -1)
    : requestPath
  if (PAYMENT_ONLY_ROUTE_PREFIXES.some(prefix => (
    path === prefix || path.startsWith(`${prefix}/`)
  ))) return true
  if (method !== 'POST') return false

  return path === '/api/place'
    || path === '/api/kind'
    || /^\/api\/kind\/[^/]+\/revise$/u.test(path)
    || path === '/api/transfer/offer'
    || /^\/api\/transfer\/[^/]+\/(?:claim|cancel)$/u.test(path)
    || /^\/api\/world\/offer\/[^/]+\/(?:claim|reconcile|cancel)$/u.test(path)
}

function paymentBoundary(c: Context, payload: Readonly<Record<string, unknown>>): boolean {
  if (
    c.req.header('x-payment') !== undefined
    || c.req.header('x-1f3d9-fee-credit') !== undefined
    || c.res.status === 402
    || c.res.headers.has('x-payment-response')
    || c.res.headers.has('x-payment-required')
    || paymentRoute(c.req.method, c.req.path)
  ) return true
  return Object.hasOwn(payload, 'city_fee_credit')
    || Object.hasOwn(payload, 'credit_attempt_id')
    || Object.hasOwn(payload, 'payment_attempt_id')
    || payload.do_not_pay_again === true
}

function withAuthorizationVary(headers: Headers): void {
  const names = (headers.get('vary') ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  if (!names.some(value => value.toLowerCase() === 'authorization')) {
    headers.set('Vary', [...names, 'Authorization'].join(', '))
  }
}

function privateRefusalHeaders(response: Response): Headers {
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('Cache-Control', 'no-store')
  headers.set('Pragma', 'no-cache')
  withAuthorizationVary(headers)
  return headers
}

function replaceResponse(c: Context, text: string, headers: Headers): void {
  c.res = new Response(text, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  })
}

function reportCounterFailure(error: unknown): void {
  const errorName = error instanceof Error
    && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name)
    ? error.name
    : 'Error'
  const errorCode = postgresErrorCode(error)
  console.error('resident_refusal_state_failure', JSON.stringify({
    event: 'resident_refusal_state_failure',
    error_name: errorName,
    ...(errorCode && /^[0-9A-Z]{5}$/u.test(errorCode) ? { error_code: errorCode } : {}),
  }))
}

/**
 * Vary authenticated rule-refusal text after credential safety has guarded it.
 * The original refusal always survives if the private counter is unavailable.
 */
export function residentRefusalGuidance(
  advance: ResidentRefusalAdvance = advanceResidentRefusal,
): MiddlewareHandler {
  return async (c, next) => {
    await next()
    if (
      !c.req.path.startsWith('/api/')
      || !TRACKED_REFUSAL_STATUSES.has(c.res.status)
      || c.req.method === 'HEAD'
      || c.res.body === null
      || !jsonContentType(c.res.headers.get('content-type') ?? '')
    ) return

    const residentId = authenticatedResidentId(c.req.raw)
    if (residentId === null) return

    const rawText = await c.res.clone().text()
    if (Buffer.byteLength(rawText, 'utf8') > MAX_REFUSAL_RESPONSE_BYTES) return
    let parsed: unknown
    try {
      parsed = JSON.parse(rawText) as unknown
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const payload = parsed as Record<string, unknown>
    if (paymentBoundary(c, payload)) return
    const cause = payload.error
    if (
      typeof cause !== 'string'
      || !trackedCause(cause)
      || containsPublicCredential(cause)
      || containsPublicCredential(c.req.path)
    ) return

    const refusalIdentity = sha256(`${c.req.method}\0${c.req.path}\0${cause}`)

    const headers = privateRefusalHeaders(c.res)
    let repetition: number
    try {
      repetition = await advance(residentId, c.res.status, refusalIdentity)
    } catch (error) {
      reportCounterFailure(error)
      replaceResponse(c, rawText, headers)
      return
    }

    const error = formatRepeatedRefusal(cause, repetition)
    const action = payload.action
    const nextAction = action && typeof action === 'object' && !Array.isArray(action)
      && (action as Record<string, unknown>).error === cause
      ? { ...(action as Record<string, unknown>), error }
      : action
    const nextPayload = {
      ...payload,
      error,
      ...(nextAction === undefined ? {} : { action: nextAction }),
    }
    replaceResponse(c, JSON.stringify(nextPayload), headers)
  }
}
