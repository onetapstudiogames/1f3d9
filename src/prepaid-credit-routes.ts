import { createHash } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { declaredBodyLength } from './bounded-body.ts'
import { HANDLE_RE } from './core.ts'
import { takePayPalCreditRateLimit } from './paypal-credit-store.ts'
import {
  acceptCreditGift,
  PrepaidCreditConflictError,
  redirectCreditGift,
  refuseCreditGift,
} from './prepaid-credit.ts'
import type { CityCreditDatabase } from './city-credit.ts'

const GIFT_PUBLIC_ID_RE = /^city_gift_[0-9a-f]{32}$/u
const MAX_ACTION_BODY_BYTES = 1_024
const GIFT_REDIRECTS_PER_CALLER_HOUR = 30

type AuthenticatedResident = Readonly<{ id: number; handle?: string }>

export interface PrepaidCreditGiftRouteDependencies {
  authenticate(c: Context): Promise<AuthenticatedResident | null>
  database: CityCreditDatabase
  environment?: Readonly<Record<string, string | undefined>>
}

function privateHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Vary', 'Authorization')
}

function hasNoQueryOptions(c: Context): boolean {
  return Object.keys(c.req.queries()).length === 0
}

function safeGiftId(value: string): string | null {
  return GIFT_PUBLIC_ID_RE.test(value) ? value : null
}

function callerAddress(
  c: Context,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (environment.VERCEL !== '1') return 'local-or-unattributed'
  return c.req.header('x-vercel-forwarded-for')
    ?.split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .at(-1) ?? 'unattributed'
}

async function requireGiftRedirectRateSlot(
  c: Context,
  dependencies: PrepaidCreditGiftRouteDependencies,
): Promise<Response | null> {
  const address = callerAddress(c, dependencies.environment ?? process.env)
  const callerHash = createHash('sha256')
    .update(`prepaid-credit:gift-redirect:anonymous:${address}`, 'utf8')
    .digest('hex')
  if (await takePayPalCreditRateLimit(
    dependencies.database,
    callerHash,
    GIFT_REDIRECTS_PER_CALLER_HOUR,
  )) return null
  c.header('Retry-After', '3600')
  return c.json({
    error: 'Too many gift redirect attempts were received. Wait one hour before trying a gift redirect again.',
  }, 429)
}

type BoundedBodyResult =
  | Readonly<{ state: 'ok'; raw: string }>
  | Readonly<{ state: 'unusable_declaration' }>
  | Readonly<{ state: 'oversized' }>

async function boundedBody(c: Context): Promise<BoundedBodyResult> {
  // An absent Content-Length is what the production edge forwards; the
  // enforced bound is the actual byte count below.
  if (declaredBodyLength(c.req.header('content-length'), MAX_ACTION_BODY_BYTES) === 'unusable') {
    return { state: 'unusable_declaration' }
  }
  const raw = await c.req.text()
  return Buffer.byteLength(raw, 'utf8') <= MAX_ACTION_BODY_BYTES
    ? { state: 'ok', raw }
    : { state: 'oversized' }
}

// The two body-bound refusals name their real causes; every other refusal on
// these routes speaks about fields, so a size or header problem must never
// borrow a field message.
function bodyBoundFailure(
  c: Context,
  state: 'unusable_declaration' | 'oversized',
): Response {
  if (state === 'unusable_declaration') {
    return c.json({
      error: `this gift request declared an unusable Content-Length; declare one decimal byte count no larger than ${MAX_ACTION_BODY_BYTES}, or omit the header`,
    }, 400)
  }
  return c.json({
    error: `gift request bodies are limited to ${MAX_ACTION_BODY_BYTES} bytes`,
  }, 400)
}

async function emptyActionBodyFailure(
  c: Context,
  action: 'accept' | 'refuse',
): Promise<Response | null> {
  if (c.req.raw.body == null) return null
  const body = await boundedBody(c)
  if (body.state !== 'ok') return bodyBoundFailure(c, body.state)
  if (body.raw.trim() === '') return null
  try {
    const value: unknown = JSON.parse(body.raw)
    if (value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 0) return null
  } catch {
    // fall through to the honest field answer below
  }
  return c.json({ error: `gift ${action} accepts an empty body only` }, 400)
}

function positiveResidentNumber(value: unknown): number | null {
  const number = typeof value === 'string' && /^[1-9][0-9]{0,9}$/u.test(value)
    ? Number(value)
    : value
  return typeof number === 'number'
    && Number.isSafeInteger(number)
    && number > 0
    && number <= 2_147_483_647
    ? number
    : null
}

function redirectInput(raw: string): Readonly<{
  claimToken: string
  recipientNumber: number
  recipientHandle: string
  requestId: string
}> | null {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (
    Object.keys(body).length !== 4
    || !Object.hasOwn(body, 'claim_token')
    || !Object.hasOwn(body, 'recipient_number')
    || !Object.hasOwn(body, 'recipient_handle')
    || !Object.hasOwn(body, 'request_id')
  ) return null
  const recipientNumber = positiveResidentNumber(body.recipient_number)
  if (
    recipientNumber == null
    || typeof body.recipient_handle !== 'string'
    || !HANDLE_RE.test(body.recipient_handle)
    || typeof body.claim_token !== 'string'
    || typeof body.request_id !== 'string'
  ) return null
  return Object.freeze({
    claimToken: body.claim_token,
    recipientNumber,
    recipientHandle: body.recipient_handle,
    requestId: body.request_id,
  })
}

async function confirmedResident(
  database: CityCreditDatabase,
  number: number,
  handle: string,
): Promise<number | null> {
  const rows = await database.query(`
    /* prepaid-credit-routes:resident-confirmation */
    SELECT id, handle
    FROM residents
    WHERE id = $1::integer AND handle = $2::text
    LIMIT 1
  `, [number, handle]) as readonly Record<string, unknown>[]
  const row = rows[0]
  return Number(row?.id) === number && row?.handle === handle ? number : null
}

function conflictResponse(c: Context, error: unknown): Response {
  if (error instanceof PrepaidCreditConflictError) {
    return c.json({ error: error.message, do_not_retry_with_changed_terms: true }, 409)
  }
  if (error instanceof TypeError) return c.json({ error: error.message }, 400)
  throw error
}

/** Mount private recipient actions and one anonymous, claim-token buyer redirect action. */
export function mountPrepaidCreditGiftRoutes(
  app: Hono,
  deps: PrepaidCreditGiftRouteDependencies,
): void {
  app.get('/api/city-credit/gifts/residents/:number', async c => {
    privateHeaders(c)
    if (!hasNoQueryOptions(c)) {
      return c.json({ error: 'gift resident lookup accepts no query options' }, 400)
    }
    const number = positiveResidentNumber(c.req.param('number'))
    if (number == null) {
      return c.json({ error: 'resident number must be one positive integer' }, 400)
    }
    const rows = await deps.database.query(`
      /* prepaid-credit-routes:resident-lookup */
      SELECT id, handle FROM residents WHERE id = $1::integer LIMIT 1
    `, [number]) as readonly Record<string, unknown>[]
    const row = rows[0]
    if (Number(row?.id) !== number || typeof row?.handle !== 'string' || !HANDLE_RE.test(row.handle)) {
      return c.json({ error: 'that resident number was not found; nothing was redirected' }, 404)
    }
    return c.json({ resident_number: number, resident_handle: row.handle })
  })

  for (const action of ['accept', 'refuse'] as const) {
    app.post(`/api/city-credit/gifts/:giftId/${action}`, async c => {
      privateHeaders(c)
      if (!hasNoQueryOptions(c)) return c.json({ error: 'gift actions accept no query options' }, 400)
      const resident = await deps.authenticate(c)
      if (!resident) return c.json({ error: 'bad or missing bearer secret' }, 401)
      const giftId = safeGiftId(c.req.param('giftId'))
      if (!giftId) return c.json({ error: 'gift id is invalid' }, 400)
      const bodyFailure = await emptyActionBodyFailure(c, action)
      if (bodyFailure) return bodyFailure
      try {
        return c.json(await (action === 'accept' ? acceptCreditGift : refuseCreditGift)(
          deps.database,
          { residentId: resident.id, giftId },
        ))
      } catch (error) {
        return conflictResponse(c, error)
      }
    })
  }

  app.post('/api/city-credit/gifts/:giftId/redirect', async c => {
    privateHeaders(c)
    if (!hasNoQueryOptions(c)) return c.json({ error: 'gift redirect accepts no query options' }, 400)
    const giftId = safeGiftId(c.req.param('giftId'))
    if (!giftId) return c.json({ error: 'gift id is invalid' }, 400)
    const rateLimitResponse = await requireGiftRedirectRateSlot(c, deps)
    if (rateLimitResponse) return rateLimitResponse
    const body = await boundedBody(c)
    if (body.state !== 'ok') return bodyBoundFailure(c, body.state)
    const input = redirectInput(body.raw)
    if (!input) {
      return c.json({
        error: 'gift redirect needs only claim_token, recipient_number, recipient_handle, and request_id',
      }, 400)
    }
    const target = await confirmedResident(
      deps.database,
      input.recipientNumber,
      input.recipientHandle,
    )
    if (target == null) {
      return c.json({
        error: 'resident number and handle did not identify the same resident; no gift was redirected',
      }, 404)
    }
    try {
      const result = await redirectCreditGift(deps.database, {
        giftId,
        claimToken: input.claimToken,
        residentId: target,
        requestId: input.requestId,
      })
      return c.json({ ...result, message: 'gift redirected; the new recipient must accept it' })
    } catch (error) {
      return conflictResponse(c, error)
    }
  })
}
