import assert from 'node:assert/strict'
import { bindPaymentEvidence, canonicalPaymentRequest, findPaymentAttempt } from '../../../src/payment-attempts.ts'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { BASE_USDC, SELLER_WALLET, BUYER_WALLET, FACILITATOR_RESPONSE_HEADER, hash, rejectsWithCode } from '../../helpers/payment-postgres-fixtures/attempts.ts'

export async function registerCompletionReplayTests(
  t: TestContext,
  postgres: { client: Pool },
  resetFresh: (database: Pool) => Promise<void>,
  replayMigrationDdl: string,
  responseBodyMigrationDdl: string,
): Promise<void> {
  await t.test('atomic completion rolls back its business effect when lease ownership is lost', async () => {
    await resetFresh(postgres.client)
    const txHash = hash('6')
    await postgres.client.query(`
        INSERT INTO payment_attempts (
          public_id, actor_id, operation, target_key, request_hash, request_json,
          method, network, token, payer_wallet, payee_wallet, amount_units,
          x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
          start_block, start_time, end_time, status, lease_owner, lease_expires_at,
          tx_hash, finalized_block_number, finalized_block_hash,
          finalized_block_time, finalized_at
        ) VALUES (
          'attempt_atomic_completion_01', 1, 'frontier', 'frontier:atomic',
          repeat('a', 64), '{}'::jsonb,
          'x402', 'base', $1, $2, $3, 1000000,
          $4, repeat('b', 64), 1, 9999999999,
          10, '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z',
          'payment_pending', 'right-lease', clock_timestamp() + interval '1 minute',
          $5, 11, $6, '2026-08-16T12:01:00Z', '2026-08-16T12:02:00Z'
        )
      `, [BASE_USDC, BUYER_WALLET, SELLER_WALLET, hash('5'), txHash, hash('4')])

    await rejectsWithCode(postgres.client.query(`
        WITH business_effect AS (
          INSERT INTO events (kind, actor, detail)
          VALUES ('place_created', 'seller', '{"atomic":true}'::jsonb)
          RETURNING id
        )
        SELECT complete_payment_attempt(
          'attempt_atomic_completion_01',
          'wrong-lease',
          jsonb_build_object('event_id', business_effect.id),
          201::smallint,
          jsonb_build_object('ok', true)
        )
        FROM business_effect
      `), '55000')

    assert.equal(Number((await postgres.client.query(
      `SELECT count(*)::int AS count FROM events WHERE detail = '{"atomic":true}'::jsonb`,
    )).rows[0]!.count), 0)
    assert.equal((await postgres.client.query(
      `SELECT status FROM payment_attempts WHERE public_id = 'attempt_atomic_completion_01'`,
    )).rows[0]!.status, 'payment_pending')

    await postgres.client.query(`
        WITH business_effect AS (
          INSERT INTO events (kind, actor, detail)
          VALUES ('place_created', 'seller', '{"atomic":true}'::jsonb)
          RETURNING id
        )
        SELECT complete_payment_attempt(
          'attempt_atomic_completion_01',
          'right-lease',
          jsonb_build_object('event_id', business_effect.id),
          201::smallint,
          jsonb_build_object('ok', true)
        )
        FROM business_effect
      `)
    const completed = await postgres.client.query(
      `SELECT status, response_status, response_json, response_body_bytes FROM payment_attempts
         WHERE public_id = 'attempt_atomic_completion_01'`,
    )
    assert.deepEqual(completed.rows, [{
      status: 'completed',
      response_status: 201,
      response_json: { ok: true },
      response_body_bytes: null,
    }])
  })

  await t.test('completion preserves exact facilitator response bytes across a database reload', async () => {
    await resetFresh(postgres.client)
    await postgres.client.query(replayMigrationDdl)
    await postgres.client.query(replayMigrationDdl)
    await postgres.client.query(responseBodyMigrationDdl)
    await postgres.client.query(responseBodyMigrationDdl)
    const txHash = hash('4')
    const requestHash = canonicalPaymentRequest({}).hash
    await postgres.client.query(`
        INSERT INTO payment_attempts (
          public_id, actor_id, operation, target_key, offer_id, request_hash, request_json,
          method, network, token, payer_wallet, payee_wallet, amount_units,
          x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
          start_block, start_time, end_time, status, lease_owner, lease_expires_at
        ) VALUES (
          'attempt_exact_response_01', 2, 'frontier', 'frontier:exact-response', 91,
          $5, '{}'::jsonb,
          'x402', 'base', $1, $2, $3, 1000000,
          $4, repeat('b', 64), 1, 9999999999,
          10, '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z',
          'settling', 'response-lease', clock_timestamp() + interval '1 minute'
        )
      `, [BASE_USDC, BUYER_WALLET, SELLER_WALLET, hash('5'), requestHash])
    const database = {
      query: async (text: string, params: readonly unknown[] = []) =>
        (await postgres.client.query(text, [...params])).rows,
    }

    const pending = await bindPaymentEvidence(database, {
      publicId: 'attempt_exact_response_01',
      leaseOwner: 'response-lease',
      txHash,
      finality: {
        blockNumber: 11n,
        blockHash: hash('6'),
        blockTime: '2026-08-16T12:01:00Z',
        finalizedAt: '2026-08-16T12:02:00Z',
      },
      paymentResponseHeader: FACILITATOR_RESPONSE_HEADER,
    })
    assert.equal(pending.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
    await rejectsWithCode(postgres.client.query(`
        UPDATE payment_attempts SET response_json = '{}'::jsonb
        WHERE public_id = 'attempt_exact_response_01'
      `), '55000')

    const exactBody = '{\n  "thing": { "id": 42 },\n  "ok": true\n}'
    await postgres.client.query(`
        SELECT complete_payment_attempt(
          'attempt_exact_response_01',
          'response-lease',
          jsonb_build_object('thing_id', 42),
          201::smallint,
          jsonb_build_object('ok', true, 'thing', jsonb_build_object('id', 42)),
          convert_to($1, 'UTF8')
        )
      `, [exactBody])
    const stored = await postgres.client.query(`
        SELECT response_json, convert_from(response_body_bytes, 'UTF8') AS response_body
        FROM payment_attempts
        WHERE public_id = 'attempt_exact_response_01'
      `)
    assert.deepEqual(stored.rows, [{
      response_json: {
        __1f3d9_x402_response_v1: {
          header: FACILITATOR_RESPONSE_HEADER,
          body: { ok: true, thing: { id: 42 } },
        },
      },
      response_body: exactBody,
    }])

    const reloaded = await findPaymentAttempt(database, {
      actorId: 2,
      operation: 'frontier',
      offerId: 91,
    })
    assert.equal(reloaded?.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
    assert.deepEqual(reloaded?.response, { ok: true, thing: { id: 42 } })
    assert.equal(reloaded?.responseBody, exactBody)
    await rejectsWithCode(postgres.client.query(`
        UPDATE payment_attempts SET response_body_bytes = convert_to('{"ok":false}', 'UTF8')
        WHERE public_id = 'attempt_exact_response_01'
      `), '55000')
  })

  await t.test('byte-exact completion rejects invalid, mismatched, and oversized bodies atomically', async () => {
    for (const [suffix, body] of [
      ['invalid', '[]'],
      ['mismatch', '{"ok":false}'],
      ['oversized', `{"padding":"${'x'.repeat(200_000)}"}`],
    ] as const) {
      await resetFresh(postgres.client)
      await postgres.client.query(`
          INSERT INTO payment_attempts (
            public_id, actor_id, operation, target_key, request_hash, request_json,
            method, network, token, payer_wallet, payee_wallet, amount_units,
            x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
            start_block, start_time, end_time, status, lease_owner, lease_expires_at,
            tx_hash, finalized_block_number, finalized_block_hash,
            finalized_block_time, finalized_at
          ) VALUES (
            $1, 1, 'frontier', $2, repeat('a', 64), '{}'::jsonb,
            'x402', 'base', $3, $4, $5, 1000000,
            $6, repeat('b', 64), 1, 9999999999,
            10, '2026-08-16T12:00:00Z', '2026-08-16T12:05:00Z',
            'payment_pending', 'body-lease', clock_timestamp() + interval '1 minute',
            $7, 11, $8, '2026-08-16T12:01:00Z', '2026-08-16T12:02:00Z'
          )
        `, [
        `attempt_body_${suffix}_01`, `frontier:body-${suffix}`, BASE_USDC,
        BUYER_WALLET, SELLER_WALLET, hash(suffix === 'invalid' ? '1' : suffix === 'mismatch' ? '2' : '3'),
        hash(suffix === 'invalid' ? '4' : suffix === 'mismatch' ? '5' : '6'),
        hash(suffix === 'invalid' ? '7' : suffix === 'mismatch' ? '8' : '9'),
      ])
      await rejectsWithCode(postgres.client.query(`
          SELECT complete_payment_attempt(
            $1, 'body-lease', '{"thing_id":42}'::jsonb, 201::smallint,
            '{"ok":true}'::jsonb, convert_to($2, 'UTF8')
          )
        `, [`attempt_body_${suffix}_01`, body]), '23514')
      assert.equal((await postgres.client.query(
        'SELECT status FROM payment_attempts WHERE public_id = $1',
        [`attempt_body_${suffix}_01`],
      )).rows[0]!.status, 'payment_pending')
    }
  })
}
