import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { canonicalPaymentRequest } from '../../../src/payment-attempts.ts'
import {
  PAYEE,
  PAYER,
  USDC,
  postgresCode,
} from '../../helpers/payment-recovery-postgres-fixtures/payment-attempts.ts'

export async function registerDirectSalesTests(
  t: TestContext,
  database: Pool,
  reset: (database: Pool) => Promise<void>,
): Promise<void> {
  await t.test('a finalized direct sale can claim after wall-clock reservation expiry only from stored terms', async () => {
    await reset(database)
    const offer = await database.query<{
      id: number
      reserved_at: Date
      reserved_until: Date
    }>(`
      WITH reservation AS MATERIALIZED (
        SELECT clock_timestamp() - interval '10 minutes' AS reserved_at
      )
      INSERT INTO transfer_offers (
        channel, asset_type, asset_id, seller_id, buyer_id, price_usdc,
        seller_wallet, buyer_wallet, status, reserved_by, reserved_at, reserved_until
      ) SELECT
        'direct', 'thing', 777, 1, 2, 1.000000,
        $1, $2, 'open', 2,
        reserved_at, reserved_at + interval '5 minutes'
      FROM reservation
      RETURNING id, reserved_at, reserved_until
    `, [PAYEE, PAYER])
    const storedOffer = offer.rows[0]
    assert.ok(storedOffer)
    const request = {
      offer_id: storedOffer.id,
      buyer_wallet: PAYER,
      seller_wallet: PAYEE,
      price_usdc: 1,
      asset_type: 'thing',
      asset_id: 777,
    }
    const canonical = canonicalPaymentRequest(request)
    const finalizedBlockTime = new Date(storedOffer.reserved_at.getTime() + 60_000)
    await database.query(`
      INSERT INTO payment_attempts (
        public_id, actor_id, counterparty_id, operation, target_key, offer_id,
        asset_type, asset_id, request_hash, request_json, method, network, token,
        payer_wallet, payee_wallet, amount_units, x402_nonce, x402_payload_digest,
        start_block, start_time, end_time, status, lease_owner, lease_expires_at,
        tx_hash, finalized_block_number, finalized_block_hash,
        finalized_block_time, finalized_at, recovery_started_at, recovery_deadline_at
      ) VALUES (
        'pay_recovery_delayed_direct', 2, 1, 'direct_sale', $1, $2,
        'thing', 777, $3, $4::jsonb, 'x402', 'base', $5,
        $6, $7, 1000000, $8, repeat('7', 64),
        50000000, $9, $10, 'payment_pending', 'delayed_direct_lease',
        clock_timestamp() + interval '30 seconds', $11, 50000001, $12,
        $13, clock_timestamp(),
        statement_timestamp() - interval '1 hour', statement_timestamp() + interval '1 hour'
      )
    `, [
      `direct-sale:${storedOffer.id}`,
      storedOffer.id,
      canonical.hash,
      canonical.json,
      USDC,
      PAYER,
      PAYEE,
      `0x${'8'.repeat(64)}`,
      storedOffer.reserved_at.toISOString(),
      storedOffer.reserved_until.toISOString(),
      `0x${'9'.repeat(64)}`,
      `0x${'a'.repeat(64)}`,
      finalizedBlockTime.toISOString(),
    ])

    const claimed = await database.query<{ status: string }>(`
      UPDATE transfer_offers
      SET status = 'claimed', claimed_at = clock_timestamp()
      WHERE id = $1
      RETURNING status
    `, [storedOffer.id])
    assert.deepEqual(claimed.rows, [{ status: 'claimed' }])
  })

  await t.test('a matching terminal direct attempt releases an otherwise active reservation', async () => {
    await reset(database)
    const offer = await database.query<{ id: number; reserved_at: Date; reserved_until: Date }>(`
      WITH reservation AS MATERIALIZED (
        SELECT clock_timestamp() AS reserved_at
      )
      INSERT INTO transfer_offers (
        channel, asset_type, asset_id, seller_id, buyer_id, price_usdc,
        seller_wallet, buyer_wallet, status, reserved_by, reserved_at, reserved_until
      ) SELECT
        'direct', 'thing', 778, 1, 2, 1.000000,
        $1, $2, 'open', 2, reserved_at, reserved_at + interval '5 minutes'
      FROM reservation
      RETURNING id, reserved_at, reserved_until
    `, [PAYEE, PAYER])
    const storedOffer = offer.rows[0]
    assert.ok(storedOffer)
    const request = {
      offer_id: storedOffer.id,
      buyer_wallet: PAYER,
      seller_wallet: PAYEE,
      price_usdc: 1,
      asset_type: 'thing',
      asset_id: 778,
    }
    const canonical = canonicalPaymentRequest(request)
    await database.query(`
      INSERT INTO payment_attempts (
        public_id, actor_id, counterparty_id, operation, target_key, offer_id,
        asset_type, asset_id, request_hash, request_json, method, network, token,
        payer_wallet, payee_wallet, amount_units, x402_nonce, x402_payload_digest,
        start_block, start_time, end_time, status, tx_hash, invalid_reason,
        recovery_started_at, recovery_deadline_at
      ) VALUES (
        'pay_recovery_invalid_direct', 2, 1, 'direct_sale', $1, $2,
        'thing', 778, $3, $4::jsonb, 'x402', 'base', $5,
        $6, $7, 1000000, $8, repeat('b', 64),
        50000000, $9, $10, 'invalid', $11,
        'confirmed payment does not match the immutable direct sale',
        statement_timestamp() - interval '1 minute',
        statement_timestamp() + interval '119 minutes'
      )
    `, [
      `direct-sale:${storedOffer.id}`,
      storedOffer.id,
      canonical.hash,
      canonical.json,
      USDC,
      PAYER,
      PAYEE,
      `0x${'c'.repeat(64)}`,
      storedOffer.reserved_at.toISOString(),
      storedOffer.reserved_until.toISOString(),
      `0x${'d'.repeat(64)}`,
    ])

    await database.query(`
      INSERT INTO payment_attempts (
        public_id, actor_id, counterparty_id, operation, target_key, offer_id,
        asset_type, asset_id, request_hash, request_json, method, network, token,
        payer_wallet, payee_wallet, amount_units, x402_nonce, x402_payload_digest,
        start_block, start_time, end_time, status
      ) VALUES (
        'pay_recovery_live_direct_retry', 2, 1, 'direct_sale', $1, $2,
        'thing', 778, $3, $4::jsonb, 'x402', 'base', $5,
        $6, $7, 1000000, $8, repeat('e', 64),
        50000000, $9, $10, 'settling'
      )
    `, [
      `direct-sale:${storedOffer.id}`,
      storedOffer.id,
      canonical.hash,
      canonical.json,
      USDC,
      PAYER,
      PAYEE,
      `0x${'f'.repeat(64)}`,
      storedOffer.reserved_at.toISOString(),
      storedOffer.reserved_until.toISOString(),
    ])

    await assert.rejects(
      database.query(`UPDATE transfer_offers
        SET status = 'canceled', canceled_at = clock_timestamp()
        WHERE id = $1`, [storedOffer.id]),
      (error: unknown) => postgresCode(error) === '55000',
    )
    await database.query(`
      UPDATE payment_attempts
      SET status = 'invalid', invalid_reason = 'retry was conclusively rejected',
          updated_at = clock_timestamp()
      WHERE public_id = 'pay_recovery_live_direct_retry'
    `)

    const canceled = await database.query<{ status: string }>(`
      UPDATE transfer_offers
      SET status = 'canceled', canceled_at = clock_timestamp()
      WHERE id = $1
      RETURNING status
    `, [storedOffer.id])
    assert.deepEqual(canceled.rows, [{ status: 'canceled' }])
  })

}
