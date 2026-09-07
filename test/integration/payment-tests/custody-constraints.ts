import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { BASE_USDC, SELLER_WALLET, BUYER_WALLET, OTHER_WALLET, hash, postgresCode, rejectsWithCode, insertAttempt } from '../../helpers/payment-postgres-fixtures/attempts.ts'

export async function registerCustodyConstraintsTests(
  t: TestContext,
  postgres: { client: Pool },
  resetFresh: (database: Pool) => Promise<void>,
): Promise<void> {
  await t.test('an issued world payment parks after reservation expiry and keeps the offer locked', async () => {
    await resetFresh(postgres.client)
    const txHash = hash('6')
    const offer = await postgres.client.query<{ id: number }>(`
        INSERT INTO transfer_offers (
          channel, asset_type, asset_id, seller_id, buyer_id,
          price_usdc, seller_wallet, buyer_wallet,
          market_draft_id, market_listing_id, market_checkout_id, market_buyer,
          status, reserved_by, reserved_at, reserved_until
        ) VALUES (
          'world', 'thing', 206, 1, 2,
          2, $1, $2,
          706, 906, 806, 'market-buyer',
          'open', 2,
          date_trunc('second', clock_timestamp()) - interval '10 minutes',
          date_trunc('second', clock_timestamp()) - interval '5 minutes'
        )
        RETURNING id
      `, [SELLER_WALLET, BUYER_WALLET])
    const offerId = offer.rows[0]!.id
    await postgres.client.query(`
        INSERT INTO payment_attempts (
          public_id, actor_id, counterparty_id, operation, target_key,
          offer_id, asset_type, asset_id, request_hash, request_json,
          method, network, token, payer_wallet, payee_wallet, amount_units,
          x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
          start_block, start_time, end_time, status, tx_hash
        )
        SELECT
          'attempt_expired_world_001', 2, 1, 'world_sale', 'world-sale:' || id::text,
          id, 'thing', asset_id, repeat('1', 64), jsonb_build_object('offer_id', id),
          'x402', 'base', $2, $3, $4, 2000000,
          $5, repeat('2', 64), 1, 4102444800,
          22000000, reserved_at, reserved_until, 'payment_pending', $6
        FROM transfer_offers WHERE id = $1
      `, [
      offerId,
      BASE_USDC,
      BUYER_WALLET,
      SELLER_WALLET,
      hash('5'),
      txHash,
    ])

    await postgres.client.query(`
        UPDATE transfer_offers SET
          pending_payment_attempt_id = 'attempt_expired_world_001',
          pending_x402_tx_hash = $2,
          pending_x402_payer = $3,
          pending_x402_at = clock_timestamp()
        WHERE id = $1
      `, [offerId, txHash, BUYER_WALLET])
    const parked = await postgres.client.query(`
        SELECT pending_payment_attempt_id, pending_x402_tx_hash, x402_evidence_state
        FROM transfer_offers WHERE id = $1
      `, [offerId])
    assert.deepEqual(parked.rows, [{
      pending_payment_attempt_id: 'attempt_expired_world_001',
      pending_x402_tx_hash: txHash,
      x402_evidence_state: 'pending',
    }])
    await rejectsWithCode(
      postgres.client.query(`UPDATE transfer_offers SET status = 'canceled' WHERE id = $1`, [offerId]),
      '55000',
    )
  })

  await t.test('one live attempt owns an operation target', async () => {
    await resetFresh(postgres.client)
    await insertAttempt(postgres.client, {
      publicId: 'attempt_live_owner_0001',
      operation: 'frontier',
      targetKey: 'frontier:north',
    })
    await rejectsWithCode(insertAttempt(postgres.client, {
      publicId: 'attempt_live_owner_0002',
      operation: 'frontier',
      targetKey: 'frontier:north',
      status: 'payment_pending',
    }), '23505')

    await postgres.client.query(`
        UPDATE payment_attempts SET status = 'invalid'
        WHERE public_id = 'attempt_live_owner_0001'
      `)
    await insertAttempt(postgres.client, {
      publicId: 'attempt_live_replacement_1',
      operation: 'frontier',
      targetKey: 'frontier:north',
    })

    await insertAttempt(postgres.client, {
      publicId: 'attempt_other_operation_01',
      operation: 'kind_invention',
      targetKey: 'frontier:north',
    })
    assert.equal(
      Number((await postgres.client.query(
        `SELECT count(*)::int AS count FROM payment_attempts`,
      )).rows[0]!.count),
      3,
    )
  })

  await t.test('a Base USDC nonce is unique for its payer but reusable by another payer', async () => {
    await resetFresh(postgres.client)
    const nonce = hash('a')
    await insertAttempt(postgres.client, {
      publicId: 'attempt_nonce_owner_0001',
      operation: 'frontier',
      targetKey: 'frontier:east',
      payerWallet: BUYER_WALLET,
      nonce,
    })
    await rejectsWithCode(insertAttempt(postgres.client, {
      publicId: 'attempt_nonce_owner_0002',
      operation: 'kind_invention',
      targetKey: 'kind:bell',
      payerWallet: BUYER_WALLET,
      nonce,
    }), '23505')
    await insertAttempt(postgres.client, {
      publicId: 'attempt_nonce_other_0001',
      operation: 'kind_invention',
      targetKey: 'kind:chime',
      payerWallet: OTHER_WALLET,
      nonce,
    })
  })

  await t.test('one transaction hash cannot pay a fee, direct sale, or world sale twice', async () => {
    await resetFresh(postgres.client)
    const txHash = hash('b')
    await insertAttempt(postgres.client, {
      publicId: 'attempt_fee_hash_owner_01',
      operation: 'frontier',
      status: 'completed',
      txHash,
    })
    for (const [publicId, operation] of [
      ['attempt_direct_hash_0001', 'direct_sale'],
      ['attempt_world_hash_00001', 'world_sale'],
    ] as const) {
      await rejectsWithCode(insertAttempt(postgres.client, {
        publicId,
        operation,
        status: 'completed',
        txHash,
      }), '23505')
    }
  })

  await t.test('concurrent live claims have exactly one database winner', async () => {
    await resetFresh(postgres.client)
    const results = await Promise.allSettled([
      insertAttempt(postgres.client, {
        publicId: 'attempt_concurrent_one_01',
        operation: 'kind_revision',
        targetKey: 'kind:7:revision:2',
      }),
      insertAttempt(postgres.client, {
        publicId: 'attempt_concurrent_two_01',
        operation: 'kind_revision',
        targetKey: 'kind:7:revision:2',
      }),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.deepEqual(
      results.filter(result => result.status === 'rejected').map(result =>
        postgresCode((result as PromiseRejectedResult).reason),
      ),
      ['23505'],
    )
    const count = await postgres.client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM payment_attempts
         WHERE operation = 'kind_revision' AND target_key = 'kind:7:revision:2'`,
    )
    assert.deepEqual(count.rows, [{ count: 1 }])
  })
}
