import type { Context } from 'hono'
import {
  auth,
  err,
  postgresErrorCode,
  WALLET_RE,
  type Resident,
} from './core.ts'
import {
  canonicalTxHash,
  challenge402,
  CLAIM_FEE_USDC,
  paymentResponseHeader,
  requirements,
  settleX402,
  TREASURY,
  verifyDirectPayment,
  type Settled,
} from './pay.ts'

export const DOMAIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3d9.com'
const DIRECT_FEE_MAX_AGE_MS = 60 * 60 * 1000
export const DESCRIPTION_MAX = 4_000
export const THING_BODY_MAX_BYTES = 65_536

export type JsonObject = Record<string, unknown>

interface FeePayment {
  txHash: string
  payerWallet: string
  settled: Settled | null
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
  return resident ?? err(c, 401, 'register first — POST /api/register')
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

export function hasDuplicateNames(source: unknown, normalized: string[]): boolean {
  return Array.isArray(source) && source.length !== normalized.length
}

export async function treasuryFee(
  c: Context,
  body: JsonObject,
  resource: string,
  description: string,
): Promise<FeePayment | Response> {
  const accepted = requirements(TREASURY, CLAIM_FEE_USDC, resource, description)
  const paymentHeader = c.req.header('x-payment')

  if (paymentHeader) {
    const settled = await settleX402(paymentHeader, accepted)
    if ('error' in settled) return challenge402(c, accepted, settled.error)
    if (!WALLET_RE.test(settled.payer)) {
      return challenge402(c, accepted, 'settlement did not identify a valid payer wallet')
    }
    return {
      txHash: settled.transaction,
      payerWallet: settled.payer.toLowerCase(),
      settled,
    }
  }

  if (body.fee_tx_hash == null) {
    return challenge402(
      c,
      accepted,
      'costs $1 USDC — pay via x402 (X-PAYMENT header) or include payer_wallet and fee_tx_hash',
    )
  }

  const txHash = canonicalTxHash(body.fee_tx_hash)
  if (!txHash) return err(c, 400, 'fee_tx_hash must be 0x followed by 64 hex characters')
  const payerWallet = typeof body.payer_wallet === 'string' ? body.payer_wallet : ''
  if (!WALLET_RE.test(payerWallet)) {
    return err(c, 400, 'payer_wallet must be 0x followed by 40 hex characters')
  }

  const direct = await verifyDirectPayment(
    txHash,
    TREASURY,
    CLAIM_FEE_USDC,
    new Date(Date.now() - DIRECT_FEE_MAX_AGE_MS),
  )
  if (!direct) {
    return err(c, 402, 'payment did not verify: send at least $1 USDC on Base to the treasury within the last hour')
  }
  if (direct.from.toLowerCase() !== payerWallet.toLowerCase()) {
    return err(c, 402, 'payment must come from the declared payer_wallet')
  }
  return { txHash, payerWallet: payerWallet.toLowerCase(), settled: null }
}

export function setPaymentHeader(c: Context, fee: FeePayment): void {
  if (fee.settled) c.header('X-PAYMENT-RESPONSE', paymentResponseHeader(fee.settled))
}

export function buildPlaceTree(
  rows: PlaceRow[],
  parentId: number | null,
): PlaceTreeRow[] {
  return rows
    .filter(row => (row.parent_id == null ? null : Number(row.parent_id)) === parentId)
    .map(row => ({ ...row, children: buildPlaceTree(rows, Number(row.id)) }))
}
