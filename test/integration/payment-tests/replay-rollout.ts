import assert from 'node:assert/strict'
import { canonicalPaymentRequest, findReplayableTargetPaymentAttempt } from '../../../src/payment-attempts.ts'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { BUYER_WALLET, hash, insertAttempt } from '../../helpers/payment-postgres-fixtures/attempts.ts'

export async function registerReplayRolloutTests(
  t: TestContext,
  postgres: { client: Pool },
  resetFresh: (database: Pool) => Promise<void>,
  responseBodyRolloutMigrationDdl: string,
  responseBodyValidationMigrationDdl: string,
): Promise<void> {
  await t.test('headerless replay deterministically selects the higher public id on equal timestamps', async () => {
    await resetFresh(postgres.client)
    const request = { purchase: 'same-target' }
    const requestHash = canonicalPaymentRequest(request).hash
    const targetKey = 'direct_sale:offer:91:v3'
    const createdAt = '2026-08-16T12:00:01Z'
    await insertAttempt(postgres.client, {
      publicId: 'pay_replay_tie_0001',
      actorId: 2,
      counterpartyId: 1,
      operation: 'direct_sale',
      targetKey,
      status: 'completed',
      payerWallet: BUYER_WALLET,
      nonce: hash('a'),
      txHash: hash('b'),
      requestHash,
      request,
      createdAt,
    })
    await insertAttempt(postgres.client, {
      publicId: 'pay_replay_tie_0002',
      actorId: 2,
      counterpartyId: 1,
      operation: 'direct_sale',
      targetKey,
      status: 'completed',
      payerWallet: BUYER_WALLET,
      nonce: hash('c'),
      txHash: hash('d'),
      requestHash,
      request,
      createdAt,
    })

    const found = await findReplayableTargetPaymentAttempt(
      async (text, params = []) => (await postgres.client.query(text, [...params])).rows,
      {
        actorId: 2,
        counterpartyId: 1,
        operation: 'direct_sale',
        targetKey,
        request,
      },
    )

    assert.equal(found?.publicId, 'pay_replay_tie_0002')
  })

  await t.test('response-body validation commits in a separate idempotent phase', async () => {
    await resetFresh(postgres.client)
    await postgres.client.query(`
        ALTER TABLE payment_attempts
          DROP CONSTRAINT payment_attempts_response_body_bytes_valid
      `)
    await postgres.client.query(responseBodyRolloutMigrationDdl)
    await postgres.client.query(responseBodyRolloutMigrationDdl)
    const phaseA = await postgres.client.query<{ convalidated: boolean }>(`
        SELECT convalidated
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'payment_attempts'::regclass
          AND conname = 'payment_attempts_response_body_bytes_valid'
      `)
    assert.deepEqual(phaseA.rows, [{ convalidated: false }])
    const overloads = await postgres.client.query<{
      legacy_completion: string | null
      exact_completion: string | null
    }>(`
        SELECT
          to_regprocedure(
            'public.complete_payment_attempt(text,text,jsonb,smallint,jsonb)'
          )::text AS legacy_completion,
          to_regprocedure(
            'public.complete_payment_attempt(text,text,jsonb,smallint,jsonb,bytea)'
          )::text AS exact_completion
      `)
    assert.deepEqual(overloads.rows, [{
      legacy_completion: 'complete_payment_attempt(text,text,jsonb,smallint,jsonb)',
      exact_completion: 'complete_payment_attempt(text,text,jsonb,smallint,jsonb,bytea)',
    }])

    await postgres.client.query(responseBodyValidationMigrationDdl)
    await postgres.client.query(responseBodyValidationMigrationDdl)
    const phaseB = await postgres.client.query<{ convalidated: boolean }>(`
        SELECT convalidated
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'payment_attempts'::regclass
          AND conname = 'payment_attempts_response_body_bytes_valid'
      `)
    assert.deepEqual(phaseB.rows, [{ convalidated: true }])
  })
}
