import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { BASE_USDC, SELLER_WALLET, BUYER_WALLET, hash, rejectsWithCode } from '../../helpers/payment-postgres-fixtures/attempts.ts'

export async function registerWorldReceiptBoundaryTests(
  t: TestContext,
  postgres: { client: Pool },
  resetFresh: (database: Pool) => Promise<void>,
): Promise<void> {
  await t.test('world receipts reject the exact reservation end boundary', async () => {
    await resetFresh(postgres.client)
    const seedFinalizedWorldPayment = async (
      digit: string,
      assetId: number,
      blockTime: string,
    ): Promise<{ offerId: number; txHash: string }> => {
      const txHash = hash(digit)
      const offerId = Number((await postgres.client.query<{ id: number }>(
        `SELECT nextval(pg_get_serial_sequence('transfer_offers', 'id'))::int AS id`,
      )).rows[0]!.id)
      const attemptId = `attempt_world_${digit.repeat(16)}`
      await postgres.client.query(`
          INSERT INTO payment_attempts (
            public_id, actor_id, counterparty_id, operation, target_key,
            offer_id, asset_type, asset_id, method, network, token,
            payer_wallet, payee_wallet, amount_units, start_time, end_time,
            status, tx_hash, finalized_block_number, finalized_block_hash,
            finalized_block_time, finalized_at, result_json,
            response_status, response_json, completed_at
          ) VALUES (
            $1, 2, 1, 'world_sale', 'offer:' || $2::text,
            $2::integer, 'thing', $3, 'x402', 'base', $4,
            $5, $6, 2000000, '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z',
            'completed', $7, 22000010, $8,
            $9, clock_timestamp(), jsonb_build_object('offer_id', $2),
            200, jsonb_build_object('ok', true), clock_timestamp()
          )
        `, [
        attemptId,
        offerId,
        assetId,
        BASE_USDC,
        BUYER_WALLET,
        SELLER_WALLET,
        txHash,
        hash('8'),
        blockTime,
      ])
      await postgres.client.query(`
          INSERT INTO transfer_offers (
            id, channel, asset_type, asset_id, seller_id, buyer_id,
            price_usdc, seller_wallet, buyer_wallet,
            market_draft_id, market_listing_id, market_checkout_id, market_buyer,
            pending_payment_attempt_id,
            pending_x402_tx_hash, pending_x402_payer, pending_x402_at,
            x402_evidence_state, status, reserved_by,
            reserved_at, reserved_until, claimed_at
          ) VALUES (
            $1, 'world', 'thing', $2, 1, 2,
            2, $6, $3,
            $2, $2, $2, 'market-buyer',
            $4,
            $5, $3, '2026-08-16T12:02:00Z',
            'pending', 'claimed', 2,
            '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z',
            '2026-08-16T12:04:00Z'
          )
        `, [offerId, assetId, BUYER_WALLET, attemptId, txHash, SELLER_WALLET])
      await postgres.client.query(`
          INSERT INTO payment_uses (
            tx_hash, payment_attempt_id, actor_id, purpose,
            payer_wallet, payee_wallet, amount_usdc
          ) VALUES ($1, $2, 2, 'sale', $3, $4, 2)
        `, [txHash, attemptId, BUYER_WALLET, SELLER_WALLET])
      return { offerId, txHash }
    }

    const boundary = await seedFinalizedWorldPayment(
      '9',
      303,
      '2026-08-16T12:05:00Z',
    )
    await rejectsWithCode(postgres.client.query(`
        INSERT INTO sale_payments (
          offer_id, buyer_id, payer_wallet, payee_wallet, amount_usdc,
          tx_hash, verified_via, block_time
        ) VALUES ($1, 2, $2, $3, 2, $4, 'x402', '2026-08-16T12:05:00Z')
      `, [boundary.offerId, BUYER_WALLET, SELLER_WALLET, boundary.txHash]), '23514')

    const inside = await seedFinalizedWorldPayment(
      '7',
      304,
      '2026-08-16T12:04:59Z',
    )
    await postgres.client.query(`
        INSERT INTO sale_payments (
          offer_id, buyer_id, payer_wallet, payee_wallet, amount_usdc,
          tx_hash, verified_via, block_time
        ) VALUES ($1, 2, $2, $3, 2, $4, 'x402', '2026-08-16T12:04:59Z')
      `, [inside.offerId, BUYER_WALLET, SELLER_WALLET, inside.txHash])
  })
}
