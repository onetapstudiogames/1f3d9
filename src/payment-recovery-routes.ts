import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { err } from './core.ts'
import type {
  PaymentRecoveryAttempt,
  PaymentRecoveryBatchResult,
  PaymentRecoveryOutcome,
} from './payment-recovery.ts'

const PAYMENT_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u
const CRON_SECRET = /^[\x21-\x7e]{32,512}$/u
const MAX_EMPTY_BODY_BYTES = 1_024
const RECOVERY_BATCH_LIMIT = 10

type AuthenticatedResident = Readonly<{ id: number }>

export interface PaymentRecoveryRouteDependencies<Attempt = PaymentRecoveryAttempt> {
  authenticate(c: Context): Promise<AuthenticatedResident | null>
  getOwnedAttempt(publicId: string, actorId: number): Promise<Attempt | null>
  privateView(attempt: Attempt): Record<string, unknown>
  recheck(attempt: Attempt): Promise<PaymentRecoveryOutcome>
  runBatch(limit: number): Promise<PaymentRecoveryBatchResult>
  environment: Readonly<Record<string, string | undefined>>
}

function privateHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Vary', 'Authorization')
}

function noQueryOptions(c: Context): boolean {
  return Object.keys(c.req.queries()).length === 0
}

function safeAttemptId(value: string): string | null {
  return PAYMENT_ATTEMPT_ID.test(value) ? value : null
}

async function hasEmptyObjectBody(c: Context): Promise<boolean> {
  const contentLength = c.req.header('content-length')
  if (contentLength && (/^\d+$/u.test(contentLength) === false || Number(contentLength) > MAX_EMPTY_BODY_BYTES)) {
    return false
  }
  const raw = await c.req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_EMPTY_BODY_BYTES) return false
  if (!raw.trim()) return true
  try {
    const decoded: unknown = JSON.parse(raw)
    return Boolean(
      decoded
      && typeof decoded === 'object'
      && !Array.isArray(decoded)
      && Object.keys(decoded).length === 0,
    )
  } catch {
    return false
  }
}

function configuredCronSecret(environment: Readonly<Record<string, string | undefined>>): string | null {
  const secret = environment.CRON_SECRET
  return secret && CRON_SECRET.test(secret) ? secret : null
}

function bearerValue(c: Context): string | null {
  const match = (c.req.header('authorization') ?? '').match(/^Bearer ([^\s]+)$/u)
  return match?.[1] ?? null
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest()
  const rightHash = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(leftHash, rightHash)
}

function recheckStatus(outcome: PaymentRecoveryOutcome): 200 | 202 {
  return ['payment_pending', 'busy', 'unavailable'].includes(outcome.state) ? 202 : 200
}

/** Mount actor-private inspection/recheck plus the Vercel cron entry point. */
export function mountPaymentRecoveryRoutes<Attempt>(
  app: Hono,
  deps: PaymentRecoveryRouteDependencies<Attempt>,
): void {
  app.get('/api/payment-attempt/:id', async c => {
    privateHeaders(c)
    if (!noQueryOptions(c)) return err(c, 400, 'payment attempt inspection accepts no query options')
    const publicId = safeAttemptId(c.req.param('id'))
    if (!publicId) return err(c, 400, 'invalid payment attempt id')
    const resident = await deps.authenticate(c)
    if (!resident) return err(c, 401, 'bad or missing bearer secret')
    const attempt = await deps.getOwnedAttempt(publicId, resident.id)
    if (!attempt) return err(c, 404, 'payment attempt not found')
    return c.json({ payment_attempt: deps.privateView(attempt) })
  })

  app.post('/api/payment-attempt/:id/recheck', async c => {
    privateHeaders(c)
    if (!noQueryOptions(c)) return err(c, 400, 'payment attempt recheck accepts no query options')
    const publicId = safeAttemptId(c.req.param('id'))
    if (!publicId) return err(c, 400, 'invalid payment attempt id')
    const resident = await deps.authenticate(c)
    if (!resident) return err(c, 401, 'bad or missing bearer secret')
    if (!await hasEmptyObjectBody(c)) {
      return err(c, 400, 'payment attempt recheck accepts only an empty JSON object')
    }
    const attempt = await deps.getOwnedAttempt(publicId, resident.id)
    if (!attempt) return err(c, 404, 'payment attempt not found')
    const recovered = await deps.recheck(attempt)
    const latest = await deps.getOwnedAttempt(publicId, resident.id)
    if (!latest) return err(c, 404, 'payment attempt not found')
    return c.json({ payment_attempt: deps.privateView(latest) }, recheckStatus(recovered))
  })

  app.get('/api/internal/payment-recovery', async c => {
    privateHeaders(c)
    if (!noQueryOptions(c)) return err(c, 400, 'payment recovery accepts no query options')
    const expected = configuredCronSecret(deps.environment)
    if (!expected) return err(c, 503, 'payment recovery is unavailable')
    const supplied = bearerValue(c)
    if (!supplied || !constantTimeEqual(supplied, expected)) {
      return err(c, 401, 'payment recovery authorization failed')
    }
    const result = await deps.runBatch(RECOVERY_BATCH_LIMIT)
    return c.json({ ok: true, ...result })
  })
}
