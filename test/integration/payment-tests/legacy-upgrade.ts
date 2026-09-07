import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { BASE_USDC, SELLER_WALLET, BUYER_WALLET, hash, rejectsWithCode } from '../../helpers/payment-postgres-fixtures/attempts.ts'

async function seedDirectLegacyPayment(database: Pool, txHash: string): Promise<number> {
  const offer = await database.query<{ id: number }>(`
    INSERT INTO transfer_offers (
      channel, asset_type, asset_id, seller_id, buyer_id,
      price_usdc, seller_wallet, status, claimed_at
    ) VALUES (
      'direct', 'thing', 101, 1, 2,
      3, $1, 'claimed', '2026-08-16T12:03:00Z'
    )
    RETURNING id
  `, [SELLER_WALLET])
  const offerId = offer.rows[0]!.id
  await database.query(`
    INSERT INTO payment_uses (
      tx_hash, actor_id, purpose, payer_wallet, payee_wallet, amount_usdc, created_at
    ) VALUES ($1, 2, 'sale', $2, $3, 3, '2026-08-16T12:03:00Z')
  `, [txHash, BUYER_WALLET, SELLER_WALLET])
  await database.query(`
    INSERT INTO sale_payments (
      offer_id, buyer_id, payer_wallet, payee_wallet, amount_usdc,
      tx_hash, verified_via, block_time
    ) VALUES ($1, 2, $2, $3, 3, $4, 'claim', '2026-08-16T12:02:00Z')
  `, [offerId, BUYER_WALLET, SELLER_WALLET, txHash])
  return offerId
}

async function seedPendingWorldPayment(database: Pool, txHash: string): Promise<number> {
  const offer = await database.query<{ id: number }>(`
    INSERT INTO transfer_offers (
      channel, asset_type, asset_id, seller_id, buyer_id,
      price_usdc, seller_wallet, buyer_wallet,
      market_draft_id, market_listing_id, market_checkout_id, market_buyer,
      pending_x402_tx_hash, pending_x402_payer, pending_x402_at,
      x402_evidence_state, status, reserved_by, reserved_at, reserved_until
    ) VALUES (
      'world', 'thing', 202, 1, 2,
      2, $1, $2,
      71, 91, 81, 'market-buyer',
      $3, $2, '2026-08-16T12:02:00Z',
      'pending', 'open', 2, '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z'
    )
    RETURNING id
  `, [SELLER_WALLET, BUYER_WALLET, txHash])
  return offer.rows[0]!.id
}

export async function registerLegacyUpgradeTests(
  t: TestContext,
  postgres: { client: Pool },
  resetLegacy: (database: Pool) => Promise<void>,
  migrationDdl: string,
): Promise<void> {
  await t.test('upgrade backfills recorded legacy facts and leaves unknown facts null', async () => {
    await resetLegacy(postgres.client)
    const unknownHash = hash('c')
    const directHash = hash('d')
    const pendingHash = hash('e')
    await postgres.client.query(`
        INSERT INTO payment_uses (
          tx_hash, actor_id, purpose, payer_wallet, payee_wallet, amount_usdc, created_at
        ) VALUES ($1, 1, 'custom_fee', NULL, NULL, NULL, '2026-08-16T11:00:00Z')
      `, [unknownHash])
    const directOfferId = await seedDirectLegacyPayment(postgres.client, directHash)
    const worldOfferId = await seedPendingWorldPayment(postgres.client, pendingHash)

    await postgres.client.query(migrationDdl)
    await postgres.client.query(migrationDdl)

    const attempts = await postgres.client.query(`
        SELECT public_id, actor_id, counterparty_id, operation, target_key,
          offer_id, asset_type, asset_id, request_hash, request_json,
          method, network, token, payer_wallet, payee_wallet, amount_units::text,
          x402_nonce, start_time, end_time, status, tx_hash,
          finalized_block_number, result_json, response_json
        FROM payment_attempts
        ORDER BY tx_hash
      `)
    assert.deepEqual(attempts.rows, [
      {
        public_id: `legacy_use_${unknownHash.slice(2)}`,
        actor_id: 1,
        counterparty_id: null,
        operation: 'legacy',
        target_key: null,
        offer_id: null,
        asset_type: null,
        asset_id: null,
        request_hash: null,
        request_json: null,
        method: null,
        network: 'base',
        token: BASE_USDC,
        payer_wallet: null,
        payee_wallet: null,
        amount_units: null,
        x402_nonce: null,
        start_time: null,
        end_time: null,
        status: 'legacy_completed',
        tx_hash: unknownHash,
        finalized_block_number: null,
        result_json: null,
        response_json: null,
      },
      {
        public_id: `legacy_use_${directHash.slice(2)}`,
        actor_id: 2,
        counterparty_id: 1,
        operation: 'direct_sale',
        target_key: `offer:${directOfferId}`,
        offer_id: directOfferId,
        asset_type: 'thing',
        asset_id: 101,
        request_hash: null,
        request_json: null,
        method: 'claim',
        network: 'base',
        token: BASE_USDC,
        payer_wallet: BUYER_WALLET,
        payee_wallet: SELLER_WALLET,
        amount_units: '3000000',
        x402_nonce: null,
        start_time: null,
        end_time: null,
        status: 'legacy_completed',
        tx_hash: directHash,
        finalized_block_number: null,
        result_json: null,
        response_json: null,
      },
      {
        public_id: `legacy_world_${pendingHash.slice(2)}`,
        actor_id: 2,
        counterparty_id: 1,
        operation: 'world_sale',
        target_key: `offer:${worldOfferId}`,
        offer_id: worldOfferId,
        asset_type: 'thing',
        asset_id: 202,
        request_hash: null,
        request_json: null,
        method: 'x402',
        network: 'base',
        token: BASE_USDC,
        payer_wallet: BUYER_WALLET,
        payee_wallet: SELLER_WALLET,
        amount_units: '2000000',
        x402_nonce: null,
        start_time: new Date('2026-08-16T12:00:00Z'),
        end_time: new Date('2026-08-16T12:05:00Z'),
        status: 'payment_pending',
        tx_hash: pendingHash,
        finalized_block_number: null,
        result_json: null,
        response_json: null,
      },
    ])
  })

  await t.test('upgrade aborts contradictory legacy custody instead of hiding a hash collision', async () => {
    await resetLegacy(postgres.client)
    const collidedHash = hash('f')
    await postgres.client.query(`
        INSERT INTO payment_uses (
          tx_hash, actor_id, purpose, payer_wallet, payee_wallet, amount_usdc
        ) VALUES ($1, 1, 'frontier', $2, $3, 1)
      `, [collidedHash, BUYER_WALLET, SELLER_WALLET])
    await seedPendingWorldPayment(postgres.client, collidedHash)

    const connection = await postgres.client.connect()
    try {
      await connection.query('BEGIN')
      await rejectsWithCode(connection.query(migrationDdl), '23505')
      await connection.query('ROLLBACK')
    } finally {
      connection.release()
    }
    const table = await postgres.client.query<{ table_name: string | null }>(
      `SELECT to_regclass('public.payment_attempts')::text AS table_name`,
    )
    assert.deepEqual(table.rows, [{ table_name: null }])
  })
}
