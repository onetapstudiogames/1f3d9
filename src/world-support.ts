import type { Context } from 'hono'
import {
  auth,
  err,
  postgresErrorConstraint,
  postgresErrorCode,
  postgresErrorMessage,
  type Resident,
} from './core.ts'
import {
  challenge402,
  CLAIM_FEE_USDC,
  paymentReadinessResponse,
  requirements,
  TREASURY,
} from './pay.ts'
import { sql } from './db.ts'
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
  releaseSettlementLease,
  type PaymentAttemptRecord,
} from './payment-attempts.ts'
import {
  beginCityCreditSpend,
  CityCreditConflictError,
  parseCityCreditRequestId,
  returnCityCreditSpend,
} from './city-credit.ts'
import type { DrawingState, DrawingVariant } from './drawing.ts'

export const DOMAIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3d9.com'
export const DESCRIPTION_MAX = 4_000
export const THING_BODY_MAX_BYTES = 65_536

export type JsonObject = Record<string, unknown>

interface X402FeePayment {
  rail: 'x402'
  txHash: string
  payerWallet: string
  attemptId: string
  leaseOwner: string
  blockTime: string
  responseHeader: string
}

interface CityCreditFeePayment {
  rail: 'credit'
  txHash: null
  payerWallet: null
  attemptId: string
  leaseOwner: string
  blockTime: null
  responseHeader: null
}

export type FeePayment = X402FeePayment | CityCreditFeePayment

interface TreasuryFeeOperation {
  operation: 'frontier' | 'kind_invention' | 'kind_revision'
  targetKey: string
  assetType?: PaymentAttemptRecord['assetType']
  assetId?: number | null
  request: Record<string, unknown>
}

export interface PlaceRow {
  id: number
  parent_id: number | null
  name: string
  description: string
  drawing?: unknown
  drawing_state?: DrawingState
  drawing_description?: string | null
  purpose: string
  front_matter_thing_ids?: readonly number[]
  front_matter?: readonly object[]
  owner_id: number | null
  owner: string | null
  open_to_building: boolean
  open_to_things: boolean
  open_to_notes: boolean
  places?: number
  things?: number
  notes?: number
  created_at: string
}

export interface PlaceTreeRow extends PlaceRow {
  [key: string]: unknown
  children: PlaceTreeRow[]
}

export interface KindRow {
  id: number
  name: string
  owner_id: number
  owner: string
  revision: number
  description: string
  drawing?: unknown
  drawing_state?: DrawingState
  drawing_description?: string | null
  drawing_variants?: readonly DrawingVariant[] | unknown
  traits: string[]
  recipe: unknown
  created_at: string
}

export interface ThingRow {
  id: number
  place_id: number
  name: string
  body: string
  drawing?: unknown
  drawing_state?: DrawingState
  drawing_description?: string | null
  drawing_variant_name?: string | null
  maker_id: number
  made_by: string
  current_owner_id: number
  current_owner: string
  owner_id: number
  owner: string
  open_to_use: boolean
  kind_id: number | null
  kind: string | null
  birth_revision: number | null
  current_revision: number | null
  created_at: string
}

export async function jsonBody(c: Context): Promise<JsonObject | null> {
  const value = await c.req.json().catch(() => null) as unknown
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

export function hasOnly(body: JsonObject, fields: readonly string[]): boolean {
  const allowed = new Set(fields)
  return Object.keys(body).every(key => allowed.has(key))
}

export async function requireResident(c: Context): Promise<Resident | Response> {
  const resident = await auth(c)
  return resident ?? err(c, 401, 'resident sign-in required — use the private browser flow at /join')
}

export function isResponse(value: Resident | Response): value is Response {
  return value instanceof Response
}

export function openOffer(row: { has_open_offer?: unknown }): boolean {
  return row.has_open_offer === true || row.has_open_offer === 'true'
}

export function conflictMessage(error: unknown, fallback: string): string | null {
  return postgresErrorCode(error) === '23505' ? fallback : null
}

// link_kind_revision_traits raises 23503 with a message the caller can act on.
// Without this the reason is discarded and a paid request answers "internal".
export function unknownTraitMessage(error: unknown): string | null {
  if (postgresErrorCode(error) !== '23503') return null
  const raised = postgresErrorMessage(error) ?? ''
  return raised.includes('unknown or duplicate trait')
    ? 'names an unknown or duplicate trait; coin each trait first with POST /api/trait'
    : null
}

function safeTreasuryCompletionText(error: unknown): string | null {
  const detail = postgresErrorMessage(error) ?? (error instanceof Error ? error.message : null)
  if (!detail) return null
  return detail
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, '[redacted database URL]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/1f3d9_sk_[A-Za-z0-9_-]+/giu, '[redacted resident key]')
    .slice(0, 240)
}

export function reportTreasuryCompletionFailure(
  input: Readonly<{
    operation: 'frontier' | 'kind_invention' | 'kind_revision'
    rail: FeePayment['rail']
    attemptId: string
    status: number
  }>,
  error: unknown,
): void {
  const code = postgresErrorCode(error)
  const constraint = postgresErrorConstraint(error)
  const detail = safeTreasuryCompletionText(error)
  console.error('treasury_completion_failure', JSON.stringify({
    event: 'treasury_completion_failure',
    operation: input.operation,
    rail: input.rail,
    attempt_id: input.attemptId,
    status: Number.isSafeInteger(input.status) && input.status >= 100 && input.status <= 599
      ? input.status
      : 500,
    ...(code && /^[0-9A-Z]{5}$/u.test(code) ? { error_code: code } : {}),
    ...(constraint && /^[A-Za-z0-9_.-]{1,120}$/u.test(constraint)
      ? { constraint }
      : {}),
    ...(detail ? { error: detail } : {}),
  }))
}

export function hasDuplicateNames(source: unknown, normalized: string[]): boolean {
  return Array.isArray(source) && source.length !== normalized.length
}

export function feeSelectionConflict(c: Context): Response | null {
  return c.req.header('x-payment') && c.req.header('x-1f3d9-fee-credit')
    ? c.json({ error: 'choose one payment method: X-PAYMENT or city fee credit, never both' }, 400)
    : null
}

export async function treasuryFee(
  c: Context,
  resource: string,
  description: string,
  actorId: number,
  details: TreasuryFeeOperation,
): Promise<FeePayment | Response> {
  const paymentHeader = c.req.header('x-payment')
  const creditHeader = c.req.header('x-1f3d9-fee-credit')
  const selectionConflict = feeSelectionConflict(c)
  if (selectionConflict) return selectionConflict
  if (creditHeader) {
    let requestId: string
    try {
      requestId = parseCityCreditRequestId(creditHeader)!
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'invalid city credit request id' }, 400)
    }
    try {
      const credit = await beginCityCreditSpend({ query: sql.query }, {
        actorId,
        operation: details.operation,
        targetKey: details.targetKey,
        request: details.request,
        requestId,
        ...(details.assetType === undefined ? {} : { assetType: details.assetType }),
        ...(details.assetId === undefined ? {} : { assetId: details.assetId }),
      })
      if (credit.state === 'completed' || credit.state === 'returned') {
        return paymentJsonResponse(
          credit.response_body ?? JSON.stringify(credit.response),
          credit.response_status,
          null,
        )
      }
      if (credit.state === 'busy') {
        return c.json({
          city_fee_credit: 'payment_pending',
          credit_attempt_id: credit.attempt_id,
          retry: 'retry this same request with the same city fee credit request id',
        }, 202)
      }
      return {
        rail: 'credit',
        txHash: null,
        payerWallet: null,
        attemptId: credit.attempt_id,
        leaseOwner: credit.lease_owner,
        blockTime: null,
        responseHeader: null,
      }
    } catch (error) {
      const message = postgresErrorMessage(error) ?? (error instanceof Error ? error.message : '')
      if (/insufficient city fee credit/iu.test(message)) {
        return c.json({
          error: 'insufficient city fee credit; buy or receive one city fee credit, then retry this same request_id; no x402 payment was attempted',
        }, 409)
      }
      if (error instanceof CityCreditConflictError) {
        return c.json({ error: error.message, retry: 'use the same request id only for the same request' }, 409)
      }
      return c.json({
        error: 'city fee credit is temporarily unavailable; retry the same request id',
      }, 503)
    }
  }
  const unavailable = paymentReadinessResponse(c)
  if (unavailable) return unavailable
  const accepted = requirements(TREASURY, CLAIM_FEE_USDC, resource, description)
  const payment = paymentHeader
    ? await runDurableX402({
      database: { query: sql.query },
      paymentHeader,
      accepted,
      actorId,
      operation: details.operation,
      targetKey: details.targetKey,
      ...(details.assetType !== undefined ? { assetType: details.assetType } : {}),
      ...(details.assetId !== undefined ? { assetId: details.assetId } : {}),
      request: details.request,
    })
    : await replayTreasuryFee({
      accepted,
      actorId,
      details,
      challenge: () => challenge402(c, accepted, 'costs $1 USDC through x402; send the X-PAYMENT header'),
    })
  if (payment instanceof Response) return payment
  return treasuryFeeFromPayment(c, payment)
}

async function replayTreasuryFee(input: {
  accepted: ReturnType<typeof requirements>
  actorId: number
  details: TreasuryFeeOperation
  challenge: () => Response
}): Promise<DurableX402Result | Response> {
  try {
    const existing = await findReplayableTargetPaymentAttempt({ query: sql.query }, {
      actorId: input.actorId,
      operation: input.details.operation,
      targetKey: input.details.targetKey,
      ...(input.details.assetType !== undefined ? { assetType: input.details.assetType } : {}),
      ...(input.details.assetId !== undefined ? { assetId: input.details.assetId } : {}),
      request: input.details.request,
    })
    if (!existing) return input.challenge()
    return resumeDurableX402({
      database: { query: sql.query },
      attempt: existing,
      actorId: input.actorId,
    })
  } catch (error) {
    if (!(error instanceof PaymentAttemptConflictError)) throw error
    return new Response(JSON.stringify({ error: error.message, do_not_pay_again: true }), {
      status: 409,
      headers: { 'content-type': 'application/json; charset=UTF-8' },
    })
  }
}

function treasuryFeeFromPayment(
  c: Context,
  payment: DurableX402Result,
): FeePayment | Response {
  if (payment.state === 'completed') {
    return completedPaymentResponse(payment)
  }
  if (payment.state === 'payment_pending') return c.json(payment.body, 202)
  if (payment.state === 'unavailable') return c.json(payment.body, 503)
  if (payment.state === 'rejected') {
    return payment.status === 409
      ? c.json(payment.body, 409)
      : c.json(payment.body, 400)
  }

  return {
    rail: 'x402',
    txHash: payment.txHash,
    payerWallet: payment.payerWallet,
    attemptId: payment.attemptId,
    leaseOwner: payment.leaseOwner,
    blockTime: payment.blockTime,
    responseHeader: payment.paymentResponseHeader,
  }
}

export function completedTreasuryFeeResponse(
  responseBody: string,
  status: number,
  paymentResponseHeader: string | null,
): Response {
  return paymentJsonResponse(responseBody, status, paymentResponseHeader)
}

export async function releasePaymentLease(
  fee: Pick<FeePayment, 'attemptId' | 'leaseOwner'>,
): Promise<void> {
  try {
    await releaseSettlementLease({ query: sql.query }, {
      publicId: fee.attemptId,
      leaseOwner: fee.leaseOwner,
    })
  } catch {
    // Durable evidence remains safe; lease expiry is the fallback retry path.
  }
}

export async function returnFailedTreasuryFee(
  fee: FeePayment,
  actorId: number,
  reason: string,
  status = 409,
): Promise<Response | null> {
  if (fee.rail === 'x402') {
    await releasePaymentLease(fee)
    return null
  }
  const response = {
    error: `${reason}; city fee credit returned`,
    city_fee_credit: 'credit_returned',
    returned_usdc: '1.000000',
  }
  try {
    const returned = await returnCityCreditSpend({ query: sql.query }, {
      actorId,
      attemptId: fee.attemptId,
      leaseOwner: fee.leaseOwner,
      reason,
      responseStatus: status,
      response,
    })
    return paymentJsonResponse(JSON.stringify(returned.response), returned.response_status, null)
  } catch (error) {
    // A completed action must never be reversed after an ambiguous database
    // response. The same request id will replay completion or retry this exact
    // spend after its lease expires; returnCityCreditSpend remains the only
    // path that can append the matching credit return.
    return new Response(JSON.stringify({
      city_fee_credit: 'payment_pending',
      credit_attempt_id: fee.attemptId,
      error: error instanceof Error
        ? 'credit return is being reconciled; retry the same request id'
        : 'credit return is being reconciled',
    }), {
      status: 202,
      headers: { 'content-type': 'application/json; charset=UTF-8' },
    })
  }
}

export async function reconcileTreasuryCompletionNoEffect(
  c: Context,
  fee: FeePayment,
  actorId: number,
  reason: string,
): Promise<Response> {
  if (fee.rail === 'credit') {
    return await returnFailedTreasuryFee(fee, actorId, reason, 409) as Response
  }
  await markPaymentAttemptFounderReview({ query: sql.query }, {
    publicId: fee.attemptId,
    leaseOwner: fee.leaseOwner,
    reason,
  })
  return c.json({
    payment: 'founder_review',
    payment_attempt_id: fee.attemptId,
    fee_tx: fee.txHash,
    do_not_pay_again: true,
    reason,
  }, 409)
}

export function buildPlaceTree(
  rows: PlaceRow[],
  parentId: number | null,
): PlaceTreeRow[] {
  return rows
    .filter(row => (row.parent_id == null ? null : Number(row.parent_id)) === parentId)
    .map(row => ({ ...row, children: buildPlaceTree(rows, Number(row.id)) }))
}
