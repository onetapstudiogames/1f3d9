import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import {
  PaymentAttemptConflictError,
  appendLateFinalityEvidence,
  canonicalPaymentRequest,
} from '../../../src/payment-attempts.ts'
import { mountPaymentRecoveryRoutes } from '../../../src/payment-recovery-routes.ts'
import type { createPaymentRecoveryRuntime as CreatePaymentRecoveryRuntime } from '../../../src/payment-recovery-runtime.ts'
import {
  PAYEE,
  PAYER,
  USDC,
  postgresCode,
} from '../../helpers/payment-recovery-postgres-fixtures/payment-attempts.ts'

const SPUTNIK_ATTEMPT_ID = 'pay_d5ca0953164f3787bd1ce39b80dbad535739f334a778a0a17d67cd211a01fe25'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function topicAddress(address: string): string {
  return `0x${address.slice(2).padStart(64, '0')}`
}

export async function registerExplicitRecheckTests(
  t: TestContext,
  database: Pool,
  reset: (database: Pool) => Promise<void>,
  previousLateFinalityGuardDdl: () => string,
  lateFinalityRecheckMigrationDdl: string,
  createPaymentRecoveryRuntime: typeof CreatePaymentRecoveryRuntime,
): Promise<void> {
  await t.test('sputnik-shaped explicit recheck preserves existing late finality and enters founder review', async t => {
    await reset(database)
    await database.query(previousLateFinalityGuardDdl())
    await database.query(`
      INSERT INTO residents (id, handle, model, secret_hash)
      VALUES (66, 'sputnik', 'integration-test', repeat('6', 64))
    `)
    const request = {
      name: 'Sputnik Late Kind',
      description: 'Synthetic regression fixture',
      traits: [],
      recipe: [],
    }
    const canonical = canonicalPaymentRequest(request)
    const blockNumber = 50_391_542n
    const blockHash = `0x${'7'.repeat(64)}`
    const txHash = `0x${'8'.repeat(64)}`
    const nonce = `0x${'9'.repeat(64)}`
    const blockTime = '2026-08-24T11:53:51.000Z'
    const firstObservedFinality = '2026-08-24T12:15:46.453Z'
    await database.query(`
      INSERT INTO payment_attempts (
        public_id, actor_id, operation, target_key, request_hash, request_json,
        method, network, token, payer_wallet, payee_wallet, amount_units,
        x402_nonce, x402_payload_digest, start_block, start_time, end_time,
        status, tx_hash,
        finalized_block_number, finalized_block_hash, finalized_block_time, finalized_at,
        recovery_started_at, recovery_deadline_at, invalid_reason,
        created_at, updated_at
      ) VALUES (
        $1, 66, 'kind_invention', 'kind:sputnik-late-kind', $2, $3::jsonb,
        'x402', 'base', $4, $5, $6, 1000000,
        $7, repeat('a', 64), 50380000,
        '2026-08-24T11:48:50.722Z', '2026-08-24T12:03:50.722Z',
        'expired', $8,
        $9, $10, $11::timestamptz, $12::timestamptz,
        '2026-08-24T11:53:50.722Z', '2026-08-24T13:53:50.722Z',
        'automatic payment recovery deadline passed',
        '2026-08-24T11:48:50.722Z', '2026-08-24T13:55:46.494Z'
      )
    `, [
      SPUTNIK_ATTEMPT_ID,
      canonical.hash,
      canonical.json,
      USDC,
      PAYER,
      PAYEE,
      nonce,
      txHash,
      blockNumber.toString(),
      blockHash,
      blockTime,
      firstObservedFinality,
    ])

    const originalFetch = globalThis.fetch
    const rpcMethods: string[] = []
    let rpcAvailable = false
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as {
        id: number
        method: string
        params: readonly unknown[]
      }
      rpcMethods.push(requestBody.method)
      if (!rpcAvailable) throw new Error('simulated Base RPC outage')
      const blockHex = `0x${blockNumber.toString(16)}`
      let result: unknown = null
      if (requestBody.method === 'eth_getTransactionReceipt') {
        result = {
          status: '0x1',
          blockHash,
          blockNumber: blockHex,
          logs: [{
            address: USDC,
            topics: [TRANSFER_TOPIC, topicAddress(PAYER), topicAddress(PAYEE)],
            data: '0xf4240',
          }],
        }
      } else if (requestBody.method === 'eth_getBlockByNumber') {
        result = requestBody.params[0] === 'finalized'
          ? { number: blockHex }
          : { number: blockHex, hash: blockHash }
      } else if (requestBody.method === 'eth_getBlockByHash') {
        result = {
          timestamp: `0x${BigInt(Math.floor(Date.parse(blockTime) / 1_000)).toString(16)}`,
        }
      }
      return Response.json({ jsonrpc: '2.0', id: requestBody.id, result })
    }) as typeof fetch
    t.after(() => { globalThis.fetch = originalFetch })

    const paymentDatabase = {
      query: async (text: string, params: readonly unknown[] = []) => (
        await database.query(text, [...params])
      ).rows,
    }
    await assert.rejects(
      appendLateFinalityEvidence(paymentDatabase, {
        publicId: SPUTNIK_ATTEMPT_ID,
        txHash,
        finality: {
          blockNumber,
          blockHash,
          blockTime,
          finalizedAt: '2026-08-24T14:00:00.000Z',
        },
        reason: 'matching payment finalized after automatic recovery ended',
      }),
      (error: unknown) => postgresCode(error) === '55000',
    )
    await database.query(lateFinalityRecheckMigrationDdl)
    await database.query(lateFinalityRecheckMigrationDdl)
    await assert.rejects(
      appendLateFinalityEvidence(paymentDatabase, {
        publicId: SPUTNIK_ATTEMPT_ID,
        txHash,
        finality: {
          blockNumber,
          blockHash: `0x${'f'.repeat(64)}`,
          blockTime,
          finalizedAt: '2026-08-24T14:00:00.000Z',
        },
        reason: 'matching payment finalized after automatic recovery ended',
      }),
      PaymentAttemptConflictError,
    )
    const unchangedAfterConflict = await database.query<{
      status: string
      finalized_block_hash: string
      finalized_at: Date
    }>(`
      SELECT status, finalized_block_hash, finalized_at
      FROM payment_attempts WHERE public_id = $1
    `, [SPUTNIK_ATTEMPT_ID])
    assert.deepEqual(unchangedAfterConflict.rows.map(row => ({
      ...row,
      finalized_at: row.finalized_at.toISOString(),
    })), [{
      status: 'expired',
      finalized_block_hash: blockHash,
      finalized_at: firstObservedFinality,
    }])

    const runtime = createPaymentRecoveryRuntime(paymentDatabase)
    const app = new Hono()
    mountPaymentRecoveryRoutes(app, {
      authenticate: async (c: Context) => c.req.header('authorization') === 'Bearer sputnik'
        ? { id: 66 }
        : null,
      getOwnedAttempt: runtime.getOwnedAttempt,
      privateView: runtime.privateView,
      recheck: runtime.recheck,
      runBatch: runtime.runBatch,
      environment: {},
    })

    const beforeUnavailable = await database.query(`
      SELECT status, tx_hash, finalized_block_number::text, finalized_block_hash,
             finalized_block_time, finalized_at, invalid_reason, updated_at
      FROM payment_attempts WHERE public_id = $1
    `, [SPUTNIK_ATTEMPT_ID])
    const unavailable = await app.request(`/api/payment-attempt/${SPUTNIK_ATTEMPT_ID}/recheck`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sputnik',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(unavailable.status, 503, await unavailable.clone().text())
    assert.equal(unavailable.headers.get('retry-after'), '1')
    assert.deepEqual(await unavailable.json(), {
      error: 'payment attempt recheck is temporarily unavailable; retry this same attempt without paying again',
      do_not_pay_again: true,
    })
    const afterUnavailable = await database.query(`
      SELECT status, tx_hash, finalized_block_number::text, finalized_block_hash,
             finalized_block_time, finalized_at, invalid_reason, updated_at
      FROM payment_attempts WHERE public_id = $1
    `, [SPUTNIK_ATTEMPT_ID])
    assert.deepEqual(afterUnavailable.rows, beforeUnavailable.rows)
    assert.deepEqual(rpcMethods, ['eth_getTransactionReceipt'])
    rpcMethods.length = 0
    rpcAvailable = true

    const response = await app.request(`/api/payment-attempt/${SPUTNIK_ATTEMPT_ID}/recheck`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sputnik',
        'content-type': 'application/json',
      },
      body: '{}',
    })

    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as {
      payment_attempt: { state: string; next_action: string; do_not_pay_again: boolean }
    }
    assert.deepEqual(body.payment_attempt, {
      ...body.payment_attempt,
      state: 'founder_review',
      next_action: 'await_founder_review',
      do_not_pay_again: true,
    })
    assert.deepEqual(rpcMethods, [
      'eth_getTransactionReceipt',
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
      'eth_getBlockByHash',
    ])
    const repeated = await app.request(`/api/payment-attempt/${SPUTNIK_ATTEMPT_ID}/recheck`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sputnik',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(repeated.status, 200, await repeated.clone().text())
    assert.equal((await repeated.json() as {
      payment_attempt: { next_action: string }
    }).payment_attempt.next_action, 'await_founder_review')
    assert.equal(rpcMethods.length, 4)
    const preserved = await database.query<{
      status: string
      tx_hash: string
      finalized_block_number: string
      finalized_block_hash: string
      finalized_block_time: Date
      finalized_at: Date
    }>(`
      SELECT status, tx_hash, finalized_block_number::text, finalized_block_hash,
             finalized_block_time, finalized_at
      FROM payment_attempts WHERE public_id = $1
    `, [SPUTNIK_ATTEMPT_ID])
    assert.equal(preserved.rows[0]?.status, 'founder_review')
    assert.equal(preserved.rows[0]?.tx_hash, txHash)
    assert.equal(preserved.rows[0]?.finalized_block_number, blockNumber.toString())
    assert.equal(preserved.rows[0]?.finalized_block_hash, blockHash)
    assert.equal(preserved.rows[0]?.finalized_block_time.toISOString(), blockTime)
    assert.equal(preserved.rows[0]?.finalized_at.toISOString(), firstObservedFinality)
    const kinds = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kinds WHERE lower(name) = 'sputnik late kind'",
    )
    assert.equal(kinds.rows[0]?.count, '0')
  })

}
