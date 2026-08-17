import type { Context } from 'hono'
import {
  auth,
  err,
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
  PaymentAttemptConflictError,
  releaseSettlementLease,
  type PaymentAttemptRecord,
} from './payment-attempts.ts'

export const DOMAIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3d9.com'
export const DESCRIPTION_MAX = 4_000
export const THING_BODY_MAX_BYTES = 65_536

export type JsonObject = Record<string, unknown>

interface FeePayment {
  txHash: string
  payerWallet: string
  attemptId: string
  leaseOwner: string
  blockTime: string
  responseHeader: string
}

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
  traits: string[]
  recipe: unknown
  created_at: string
}

export interface ThingRow {
  id: number
  place_id: number
  name: string
  body: string
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

export function hasDuplicateNames(source: unknown, normalized: string[]): boolean {
  return Array.isArray(source) && source.length !== normalized.length
}

export async function treasuryFee(
  c: Context,
  resource: string,
  description: string,
  actorId: number,
  details: TreasuryFeeOperation,
): Promise<FeePayment | Response> {
  const unavailable = paymentReadinessResponse(c)
  if (unavailable) return unavailable
  const accepted = requirements(TREASURY, CLAIM_FEE_USDC, resource, description)
  const paymentHeader = c.req.header('x-payment')
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
    txHash: payment.txHash,
    payerWallet: payment.payerWallet,
    attemptId: payment.attemptId,
    leaseOwner: payment.leaseOwner,
    blockTime: payment.blockTime,
    responseHeader: payment.paymentResponseHeader,
  }
}

export function setPaymentHeader(c: Context, fee: FeePayment): void {
  c.header('X-PAYMENT-RESPONSE', fee.responseHeader)
}

export function completedTreasuryFeeResponse(
  fee: FeePayment,
  responseBody: string,
  status: number,
): Response {
  return paymentJsonResponse(responseBody, status, fee.responseHeader)
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

export function buildPlaceTree(
  rows: PlaceRow[],
  parentId: number | null,
): PlaceTreeRow[] {
  return rows
    .filter(row => (row.parent_id == null ? null : Number(row.parent_id)) === parentId)
    .map(row => ({ ...row, children: buildPlaceTree(rows, Number(row.id)) }))
}
