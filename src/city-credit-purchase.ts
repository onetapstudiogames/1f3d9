import type { Context, Hono } from 'hono'
import { NETWORK, USDC } from './chain.ts'
import { CITY_FEE_CREDIT_UNITS, formatUsdcUnits } from './city-credit.ts'
import type { CityCreditDatabase } from './city-credit.ts'
import { parseCityCreditRequestId } from './city-credit.ts'
import {
  completedPaymentResponse,
  paymentJsonResponse,
  resumeDurableX402,
  runDurableX402,
  type DurableX402Result,
} from './payment-flow.ts'
import {
  findReplayableTargetPaymentAttempt,
  markPaymentAttemptFounderReview,
  PaymentAttemptConflictError,
  type PaymentAttemptDatabase,
} from './payment-attempts.ts'
import {
  challenge402,
  CLAIM_WINDOW_SECONDS,
  paymentReadinessResponse,
  TREASURY,
  type PaymentRequirements,
} from './pay.ts'

export const CITY_CREDIT_PURCHASE_MIN_DOLLARS = 1n
export const CITY_CREDIT_PURCHASE_MAX_DOLLARS = 10_000n
const PURCHASE_RESOURCE = '/api/city-credit/purchase/x402'
const MAX_PURCHASE_BODY_BYTES = 1_024

type QueryRow = Record<string, unknown>
type AuthenticatedResident = Readonly<{ id: number }>

export type CityCreditPurchaseDatabase = CityCreditDatabase & PaymentAttemptDatabase

export interface CityCreditPurchaseRouteDependencies {
  authenticate(c: Context): Promise<AuthenticatedResident | null>
  database: CityCreditPurchaseDatabase
}

function positiveResidentId(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > 2_147_483_647
  ) throw new TypeError('credit buyer id is invalid')
  return value
}

function integerString(value: unknown, label: string): string {
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '')
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) throw new TypeError(`${label} is invalid`)
  return text
}

function positiveId(value: unknown, label: string): string {
  const text = integerString(value, label)
  if (BigInt(text) < 1n) throw new TypeError(`${label} is invalid`)
  return text
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${label} is invalid`)
  }
  return parsed as Record<string, unknown>
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]))
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && jsonValuesEqual(leftRecord[key], rightRecord[key]))
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; sourceError?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return candidate.sourceError === error ? null : errorCode(candidate.sourceError)
}

/** Parse human-facing whole dollars without ever crossing floating point. */
export function parseCityCreditPurchaseAmount(value: unknown): Readonly<{
  dollars: bigint
  amountUnits: bigint
}> {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/u.test(value)) {
    throw new TypeError('credit purchase amount must be a whole dollar from 1 to 10000')
  }
  const dollars = BigInt(value)
  if (
    dollars < CITY_CREDIT_PURCHASE_MIN_DOLLARS
    || dollars > CITY_CREDIT_PURCHASE_MAX_DOLLARS
  ) throw new TypeError('credit purchase amount must be a whole dollar from 1 to 10000')
  return Object.freeze({ dollars, amountUnits: dollars * CITY_FEE_CREDIT_UNITS })
}

export function cityCreditPurchaseTargetKey(actorIdInput: number, requestIdInput: unknown): string {
  const actorId = positiveResidentId(actorIdInput)
  const requestId = parseCityCreditRequestId(requestIdInput)
  if (!requestId) throw new TypeError('credit purchase request id is invalid')
  return `city-credit-purchase:${actorId}:${requestId}`
}

export async function completeCityCreditPurchase(
  database: CityCreditDatabase,
  input: Readonly<{ attemptId: string; leaseOwner: string }>,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(input.attemptId)) {
    throw new TypeError('credit purchase attempt id is invalid')
  }
  if (
    typeof input.leaseOwner !== 'string'
    || Buffer.byteLength(input.leaseOwner, 'utf8') < 8
    || Buffer.byteLength(input.leaseOwner, 'utf8') > 128
    || !/^[\u0021-\u007e]+$/u.test(input.leaseOwner)
  ) throw new TypeError('credit purchase lease owner is invalid')

  const rows = await database.query(`
    /* city-credit-purchase:complete
       One PostgreSQL function owns the atomic payment_uses,
       city_credit_entries, and complete_payment_attempt transition. */
    SELECT *
    FROM complete_city_credit_purchase($1::text, $2::text)
  `, [input.attemptId, input.leaseOwner]) as readonly QueryRow[]
  const row = rows[0]
  const state = String(row?.state ?? '')
  const attemptId = String(row?.attempt_id ?? '')
  if (attemptId !== input.attemptId) {
    throw new Error('credit purchase completion no longer owns this exact payment')
  }
  if (state === 'deadline_passed') {
    return Object.freeze({ state: 'deadline_passed' as const, attemptId })
  }
  if (state === 'target_changed' && typeof row?.reason === 'string' && row.reason.length > 0) {
    return Object.freeze({ state: 'target_changed' as const, attemptId, reason: row.reason })
  }
  if (!row || state !== 'completed') {
    throw new TypeError('credit purchase completion is invalid')
  }
  const amountUnits = integerString(row.amount_units, 'credit purchase amount')
  const amount = BigInt(amountUnits)
  if (
    amount % CITY_FEE_CREDIT_UNITS !== 0n
    || amount < CITY_CREDIT_PURCHASE_MIN_DOLLARS * CITY_FEE_CREDIT_UNITS
    || amount > CITY_CREDIT_PURCHASE_MAX_DOLLARS * CITY_FEE_CREDIT_UNITS
  ) throw new TypeError('credit purchase completion amount is invalid')
  const response = jsonObject(row.response_json, 'credit purchase response')
  const responseBody = String(row.response_body ?? '')
  let decodedBody: unknown
  try {
    decodedBody = JSON.parse(responseBody) as unknown
  } catch {
    decodedBody = null
  }
  if (!jsonValuesEqual(decodedBody, response)) {
    throw new TypeError('credit purchase response bytes are not canonical')
  }
  const status = Number(row.response_status)
  if (!Number.isSafeInteger(status) || status !== 201) {
    throw new TypeError('credit purchase response status is invalid')
  }
  const paymentResponseHeader = typeof row.payment_response_header === 'string'
    && row.payment_response_header.length > 0
    ? row.payment_response_header
    : null
  if (!paymentResponseHeader) throw new TypeError('credit purchase payment receipt is invalid')
  return Object.freeze({
    state: 'completed' as const,
    attemptId,
    actorId: positiveResidentId(Number(row.actor_id)),
    amount: formatUsdcUnits(amount),
    amountUnits,
    receiptId: positiveId(row.entry_id, 'credit purchase receipt id'),
    status,
    response,
    responseBody,
    paymentResponseHeader,
  })
}

function purchasePaymentRequirements(amountUnits: bigint, dollars: bigint): PaymentRequirements {
  return Object.freeze({
    scheme: 'exact' as const,
    network: NETWORK,
    maxAmountRequired: amountUnits.toString(),
    resource: PURCHASE_RESOURCE,
    description: `Buy ${dollars.toString()} prepaid 1F3D9 fee credit`,
    mimeType: 'application/json' as const,
    payTo: TREASURY,
    maxTimeoutSeconds: CLAIM_WINDOW_SECONDS,
    asset: USDC,
    extra: { name: 'USD Coin' as const, version: '2' as const },
  })
}

function privateHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Vary', 'Authorization')
}

async function purchaseRequest(c: Context): Promise<Readonly<{
  requestId: string
  amountDollars: string
  amountUnits: bigint
}> | null> {
  const contentLength = c.req.header('content-length')
  if (
    !contentLength
    || !/^[0-9]+$/u.test(contentLength)
    || BigInt(contentLength) > BigInt(MAX_PURCHASE_BODY_BYTES)
  ) return null
  const raw = await c.req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_PURCHASE_BODY_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 2
    || !Object.hasOwn(record, 'request_id')
    || !Object.hasOwn(record, 'amount_dollars')
  ) return null
  try {
    const requestId = parseCityCreditRequestId(record.request_id)
    if (!requestId) return null
    const amount = parseCityCreditPurchaseAmount(record.amount_dollars)
    return Object.freeze({
      requestId,
      amountDollars: amount.dollars.toString(),
      amountUnits: amount.amountUnits,
    })
  } catch {
    return null
  }
}

function purchaseFailure(
  c: Context,
  requestId: string,
  attemptId: string | null = null,
): Response {
  return c.json({
    error: 'credit purchase is temporarily unavailable; retry this same request_id without paying again',
    request_id: requestId,
    ...(attemptId ? { payment_attempt_id: attemptId } : {}),
    do_not_pay_again: true,
  }, 503)
}

function terminalPaymentResponse(c: Context, payment: DurableX402Result): Response | null {
  if (payment.state === 'completed') return completedPaymentResponse(payment)
  if (payment.state === 'payment_pending') return c.json(payment.body, 202)
  if (payment.state === 'unavailable') return c.json(payment.body, 503)
  if (payment.state === 'rejected') return c.json(payment.body, payment.status)
  return null
}

async function finishPurchase(
  c: Context,
  deps: CityCreditPurchaseRouteDependencies,
  payment: DurableX402Result,
  requestId: string,
): Promise<Response> {
  if (payment.state !== 'ready') {
    return terminalPaymentResponse(c, payment) ?? purchaseFailure(c, requestId)
  }
  try {
    const completed = await completeCityCreditPurchase(deps.database, {
      attemptId: payment.attemptId,
      leaseOwner: payment.leaseOwner,
    })
    if (completed.state !== 'completed') {
      const reason = completed.state === 'deadline_passed'
        ? 'matching payment finalized after automatic recovery closed'
        : completed.reason
      await markPaymentAttemptFounderReview(deps.database, {
        publicId: payment.attemptId,
        leaseOwner: payment.leaseOwner,
        reason,
      })
      return paymentJsonResponse(JSON.stringify({
        payment: 'founder_review',
        payment_attempt_id: payment.attemptId,
        transaction: payment.txHash,
        do_not_pay_again: true,
        error: 'payment needs founder review; no credit was added',
      }), 409, payment.paymentResponseHeader)
    }
    return paymentJsonResponse(
      completed.responseBody,
      completed.status,
      completed.paymentResponseHeader ?? payment.paymentResponseHeader,
    )
  } catch (error) {
    if (errorCode(error) === '23505') {
      return c.json({
        error: 'this payment transaction is already assigned; inspect this request before paying again',
        payment_attempt_id: payment.attemptId,
        do_not_pay_again: true,
      }, 409)
    }
    return purchaseFailure(c, requestId, payment.attemptId)
  }
}

/** Mount authenticated self-funding through the existing durable x402 custody lane. */
export function mountCityCreditPurchaseRoutes(
  app: Hono,
  deps: CityCreditPurchaseRouteDependencies,
): void {
  app.post('/api/city-credit/purchase/x402', async c => {
    privateHeaders(c)
    if (Object.keys(c.req.queries()).length > 0) {
      return c.json({ error: 'credit purchase accepts no query options' }, 400)
    }
    const resident = await deps.authenticate(c)
    if (!resident) return c.json({ error: 'bad or missing bearer secret' }, 401)
    const parsed = await purchaseRequest(c)
    if (!parsed) {
      return c.json({
        error: 'credit purchase needs only request_id and amount_dollars as a whole-dollar string from 1 to 10000',
      }, 400)
    }
    const targetKey = cityCreditPurchaseTargetKey(resident.id, parsed.requestId)
    const request = {
      request_id: parsed.requestId,
      amount_dollars: parsed.amountDollars,
    }
    const accepted = purchasePaymentRequirements(parsed.amountUnits, BigInt(parsed.amountDollars))
    const paymentHeader = c.req.header('x-payment')
    try {
      const existing = await findReplayableTargetPaymentAttempt(deps.database, {
        actorId: resident.id,
        operation: 'credit_purchase',
        targetKey,
        request,
      })
      let payment: DurableX402Result | Response
      if (existing) {
        payment = await resumeDurableX402({
          database: deps.database,
          attempt: existing,
          actorId: resident.id,
        })
      } else {
        const unavailable = paymentReadinessResponse(c)
        if (unavailable) return unavailable
        payment = paymentHeader
          ? await runDurableX402({
              database: deps.database,
              paymentHeader,
              accepted,
              actorId: resident.id,
              operation: 'credit_purchase',
              targetKey,
              request,
            })
          : challenge402(
              c,
              accepted,
              'This prepaid credit purchase uses x402; send the X-PAYMENT header.',
            )
      }
      if (payment instanceof Response) return payment
      return await finishPurchase(c, deps, payment, parsed.requestId)
    } catch (error) {
      if (error instanceof PaymentAttemptConflictError) {
        return c.json({ error: error.message, do_not_pay_again: true }, 409)
      }
      return purchaseFailure(c, parsed.requestId)
    }
  })
}
