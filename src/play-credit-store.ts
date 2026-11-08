import { randomUUID } from 'node:crypto'
import { createGiftClaimToken, hashGiftClaimToken } from './prepaid-credit.ts'
import { PlayCreditFailure, playCredits, type PlayEnvironment, type PlayProduct } from './play-credit.ts'
import type { PayPalCreditStoreDatabase } from './paypal-credit-store.ts'

export type PlayCreditDatabase = PayPalCreditStoreDatabase
export type PlayOrder = Readonly<{
  public_id: string; request_id: string; recipient_id: number; resident_handle: string
  product_id: PlayProduct; amount_units: string; rc_app_user_id: string
  environment: PlayEnvironment; transaction_id: string | null; status: string; created_at: Date | string
}>

export async function readPlayOrder(db: PlayCreditDatabase, orderId: string): Promise<PlayOrder | null> {
  const rows = await db.query(`SELECT o.*, r.handle AS resident_handle FROM play_credit_orders o
    JOIN residents r ON r.id = o.recipient_id WHERE o.public_id = $1`, [orderId])
  return rows[0] as PlayOrder | undefined ?? null
}

export async function createPlayOrder(db: PlayCreditDatabase, input: Readonly<{
  requestId: string; recipientId: number; productId: PlayProduct; appUserId: string; environment: PlayEnvironment
}>): Promise<Readonly<{ order: PlayOrder; claimToken: string | null }>> {
  const credits = playCredits(input.productId)
  const token = createGiftClaimToken()
  const id = `city_play_${randomUUID().replaceAll('-', '')}`
  const rows = await db.query(`INSERT INTO play_credit_orders
    (public_id, request_id, recipient_id, product_id, amount_units, claim_token_hash, rc_app_user_id, environment)
    VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8)
    ON CONFLICT (request_id) DO NOTHING RETURNING public_id`,
  [id, input.requestId, input.recipientId, input.productId, String(credits * 1_000_000), hashGiftClaimToken(token), input.appUserId, input.environment])
  const prior = rows.length ? id : (await db.query('SELECT public_id FROM play_credit_orders WHERE request_id = $1', [input.requestId]))[0]?.public_id
  const order = await readPlayOrder(db, String(prior))
  if (!order || order.recipient_id !== input.recipientId || order.product_id !== input.productId
    || order.rc_app_user_id !== input.appUserId || order.environment !== input.environment) {
    throw new PlayCreditFailure(409, 'That request already belongs to a different Play order. Use a new request for a new purchase.')
  }
  return Object.freeze({ order, claimToken: rows.length ? token : null })
}

export async function applyPlayPurchase(db: PlayCreditDatabase, input: Readonly<{
  orderId: string | null; eventId: string; eventType: 'NON_RENEWING_PURCHASE' | 'CANCELLATION'
  transactionId: string; productId: PlayProduct; environment: PlayEnvironment
  configuredEnvironment: PlayEnvironment; purchasedAt: number; appUserIds: readonly string[]
}>): Promise<string> {
  const rows = await db.query(`SELECT deliver_play_credit($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::text[]) AS outcome`,
    [input.orderId, input.eventId, input.eventType, input.transactionId, input.productId, input.environment,
      input.configuredEnvironment, new Date(input.purchasedAt).toISOString(), input.appUserIds])
  return String(rows[0]?.outcome ?? 'unmatched')
}

export function playOrderReceipt(order: PlayOrder) {
  return { status: order.status, resident_handle: order.resident_handle, credits: playCredits(order.product_id) }
}
