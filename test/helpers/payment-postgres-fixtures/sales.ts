import { canonicalPaymentRequest } from '../../../src/payment-attempts.ts'
import type { PaymentSaleDatabase } from '../../../src/payment-sale-operations.ts'
import type { Pool } from 'pg'
import { BASE_USDC, SELLER_WALLET, BUYER_WALLET, FACILITATOR_RESPONSE_HEADER, hash } from './attempts.ts'

interface RecoverableSaleSeed {
  attemptId: string
  assetId: number
  leaseOwner: string
  offerId: number
  txHash: string
}

export function saleDatabase(database: Pool): PaymentSaleDatabase {
  return {
    query: async (text, params = []) => (await database.query(text, [...params])).rows,
  }
}

export async function seedRecoverableSale(
  database: Pool,
  operation: 'direct_sale' | 'world_sale',
  digit: string,
  options: Readonly<{
    activeReservation?: boolean
    ambiguousNoTx?: boolean
  }> = {},
): Promise<RecoverableSaleSeed> {
  const activeReservation = options.activeReservation === true
  const ambiguousNoTx = options.ambiguousNoTx === true
  const assetId = operation === 'direct_sale' ? 401 : 402
  const txHash = hash(digit)
  const attemptId = `attempt_${operation}_${digit.repeat(16)}`
  const leaseOwner = `sale-worker-${digit.repeat(12)}`
  const place = await database.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, owner_id)
    SELECT id, 'continent', 'sale integration', 1
    FROM places WHERE place_kind = 'world'
    RETURNING id
  `)
  await database.query(`
    INSERT INTO things (id, place_id, name, owner_id, maker_id)
    VALUES ($1, $2, $3, 1, 1)
  `, [assetId, place.rows[0]!.id, operation === 'direct_sale' ? 'direct lantern' : 'world lantern'])
  const offer = await database.query<{
    id: number
    reserved_at: Date
    reserved_until: Date
  }>(`
    INSERT INTO transfer_offers (
      channel, asset_type, asset_id, seller_id, buyer_id,
      price_usdc, seller_wallet, buyer_wallet,
      market_draft_id, market_listing_id, market_checkout_id, market_buyer,
      status, reserved_by, reserved_at, reserved_until
    ) VALUES (
      $1, 'thing', $2, 1, 2,
      2, $3, $4,
      CASE WHEN $1 = 'world' THEN 71 ELSE NULL END,
      CASE WHEN $1 = 'world' THEN 91 ELSE NULL END,
      CASE WHEN $1 = 'world' THEN 81 ELSE NULL END,
      CASE WHEN $1 = 'world' THEN 'market-buyer' ELSE NULL END,
      'open', 2,
      statement_timestamp() - CASE WHEN $5::boolean
        THEN interval '4 minutes' ELSE interval '15 minutes' END,
      statement_timestamp() + CASE WHEN $5::boolean
        THEN interval '1 minute' ELSE interval '-10 minutes' END
    )
    RETURNING id, reserved_at, reserved_until
  `, [
    operation === 'direct_sale' ? 'direct' : 'world',
    assetId,
    SELLER_WALLET,
    BUYER_WALLET,
    activeReservation,
  ])
  const createdOffer = offer.rows[0]!
  await database.query(`UPDATE things SET active_offer_id = $1 WHERE id = $2`, [createdOffer.id, assetId])
  const request = operation === 'direct_sale'
    ? {
        offer_id: createdOffer.id,
        buyer_wallet: BUYER_WALLET,
        seller_wallet: SELLER_WALLET,
        price_usdc: 2,
        asset_type: 'thing',
        asset_id: assetId,
      }
    : {
        offer_id: createdOffer.id,
        market_checkout_id: 81,
        market_listing_id: 91,
        market_draft_id: 71,
        market_buyer: 'market-buyer',
        buyer_wallet: BUYER_WALLET,
        seller_wallet: SELLER_WALLET,
        price_usdc: 2,
        asset_id: assetId,
      }
  const canonical = canonicalPaymentRequest(request)
  await database.query(`
    INSERT INTO payment_attempts (
      public_id, actor_id, counterparty_id, operation, target_key,
      offer_id, asset_type, asset_id, request_hash, request_json,
      method, network, token, payer_wallet, payee_wallet, amount_units,
      x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
      start_block, start_time, end_time, status, lease_owner, lease_expires_at,
      tx_hash, finalized_block_number, finalized_block_hash,
      finalized_block_time, finalized_at, response_json,
      recovery_started_at, recovery_deadline_at, created_at, updated_at
    ) VALUES (
      $1, 2, 1, $2, $3,
      $4, 'thing', $5, $6, $7::jsonb,
      'x402', 'base', $8, $9, $10, 2000000,
      $11, $12, 1, 4102444800,
      100,
      date_trunc('second', $13::timestamptz)
        + CASE WHEN $13::timestamptz > date_trunc('second', $13::timestamptz)
          THEN interval '1 second' ELSE interval '0 seconds' END,
      date_trunc('second', $14::timestamptz),
      $19, $15,
      clock_timestamp() + interval '30 seconds',
      $16,
      CASE WHEN $19 = 'payment_pending' THEN 123 ELSE NULL END,
      CASE WHEN $19 = 'payment_pending' THEN $17 ELSE NULL END,
      CASE WHEN $19 = 'payment_pending'
        THEN date_trunc('second', $13::timestamptz) + interval '2 minutes 1 second'
        ELSE NULL END,
      CASE WHEN $19 = 'payment_pending' THEN clock_timestamp() ELSE NULL END,
      CASE WHEN $18::text IS NULL THEN NULL ELSE jsonb_build_object(
        '__1f3d9_x402_response_v1', jsonb_build_object('header', $18::text)
      ) END,
      statement_timestamp() - CASE WHEN $19 = 'needs_review'
        THEN interval '121 minutes' ELSE interval '15 minutes' END,
      statement_timestamp() + CASE WHEN $19 = 'needs_review'
        THEN interval '-1 minute' ELSE interval '105 minutes' END,
      statement_timestamp() - CASE WHEN $19 = 'needs_review'
        THEN interval '121 minutes' ELSE interval '15 minutes' END,
      statement_timestamp()
    )
  `, [
    attemptId,
    operation,
    `${operation === 'direct_sale' ? 'direct-sale' : 'world-sale'}:${createdOffer.id}`,
    createdOffer.id,
    assetId,
    canonical.hash,
    canonical.json,
    BASE_USDC,
    BUYER_WALLET,
    SELLER_WALLET,
    hash('a'),
    'b'.repeat(64),
    createdOffer.reserved_at.toISOString(),
    createdOffer.reserved_until.toISOString(),
    leaseOwner,
    ambiguousNoTx ? null : txHash,
    ambiguousNoTx ? null : hash('c'),
    ambiguousNoTx ? null : FACILITATOR_RESPONSE_HEADER,
    ambiguousNoTx ? 'needs_review' : 'payment_pending',
  ])
  return { attemptId, assetId, leaseOwner, offerId: createdOffer.id, txHash }
}
