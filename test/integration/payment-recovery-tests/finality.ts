import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  appendLateFinalityEvidence,
  bindPaymentEvidence,
  completePaymentAttempt,
} from '../../../src/payment-attempts.ts'
import {
  BLOCK_HASH,
  RESPONSE,
  RESPONSE_BODY,
  TX,
  insertAttempt,
  postgresCode,
} from '../../helpers/payment-recovery-postgres-fixtures/payment-attempts.ts'

export async function registerFinalityTests(
  t: TestContext,
  database: Pool,
  reset: (database: Pool) => Promise<void>,
): Promise<void> {
  await t.test('recovery timestamps never move after first evidence', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_immutable', targetKey: 'frontier:root:immutable',
      status: 'settling', leaseOwner: 'lease-immutable', txHash: null, recovery: 'none',
    })
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }
    await bindPaymentEvidence(paymentDatabase, {
      publicId: 'pay_recovery_immutable', leaseOwner: 'lease-immutable', txHash: TX,
      finality: null,
    })
    const before = await database.query<{
      recovery_started_at: Date
      recovery_deadline_at: Date
    }>(`SELECT recovery_started_at, recovery_deadline_at FROM payment_attempts
        WHERE public_id = 'pay_recovery_immutable'`)
    await delay(20)
    await bindPaymentEvidence(paymentDatabase, {
      publicId: 'pay_recovery_immutable', leaseOwner: 'lease-immutable', txHash: TX,
      finality: null,
    })
    const after = await database.query<{
      recovery_started_at: Date
      recovery_deadline_at: Date
    }>(`SELECT recovery_started_at, recovery_deadline_at FROM payment_attempts
        WHERE public_id = 'pay_recovery_immutable'`)
    assert.deepEqual(after.rows, before.rows)
    await assert.rejects(
      database.query(`UPDATE payment_attempts
        SET recovery_started_at = recovery_started_at + interval '1 second',
            recovery_deadline_at = recovery_deadline_at + interval '1 second'
        WHERE public_id = 'pay_recovery_immutable'`),
      (error: unknown) => postgresCode(error) === '55000',
    )
  })

  await t.test('finality arriving after a pending observation completes inside the recovery window', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_finality_inside_window',
      targetKey: 'frontier:root:finality-inside-window',
      status: 'settling', leaseOwner: 'lease-finality-inside', txHash: null, recovery: 'none',
    })
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }

    const pending = await bindPaymentEvidence(paymentDatabase, {
      publicId: 'pay_recovery_finality_inside_window',
      leaseOwner: 'lease-finality-inside',
      txHash: TX,
      finality: null,
    })
    assert.equal(pending.status, 'payment_pending')
    assert.equal(pending.finalizedAt, null)
    assert.ok(pending.recoveryStartedAt)
    assert.ok(pending.recoveryDeadlineAt)

    await delay(20)
    const finalizedAt = new Date().toISOString()
    const finalized = await bindPaymentEvidence(paymentDatabase, {
      publicId: 'pay_recovery_finality_inside_window',
      leaseOwner: 'lease-finality-inside',
      txHash: TX,
      finality: {
        blockNumber: 50_000_001n,
        blockHash: BLOCK_HASH,
        blockTime: new Date(Date.now() - 30_000).toISOString(),
        finalizedAt,
      },
    })
    assert.equal(finalized.status, 'payment_pending')
    assert.equal(finalized.finalizedAt, finalizedAt)
    assert.equal(finalized.recoveryStartedAt, pending.recoveryStartedAt)
    assert.equal(finalized.recoveryDeadlineAt, pending.recoveryDeadlineAt)
    const timing = await database.query<{
      finality_inside_window: boolean
      window_still_open: boolean
    }>(`
      SELECT finalized_at < recovery_deadline_at AS finality_inside_window,
             clock_timestamp() < recovery_deadline_at AS window_still_open
      FROM payment_attempts WHERE public_id = 'pay_recovery_finality_inside_window'
    `)
    assert.deepEqual(timing.rows, [{ finality_inside_window: true, window_still_open: true }])

    const completed = await completePaymentAttempt(paymentDatabase, {
      publicId: 'pay_recovery_finality_inside_window',
      leaseOwner: 'lease-finality-inside',
      result: { place_id: 94 },
      responseStatus: 201,
      response: RESPONSE,
      responseBody: RESPONSE_BODY,
    })
    assert.equal(completed.status, 'completed')
  })

  await t.test('expired late finality appends founder review without deleting or rewriting history', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_late', targetKey: 'frontier:root:late',
      status: 'expired', leaseOwner: null, txHash: null, finalized: false, recovery: 'due',
    })
    const before = await database.query<{
      request_json: unknown
      invalid_reason: string
      created_at: Date
    }>(`SELECT request_json, invalid_reason, created_at FROM payment_attempts
        WHERE public_id = 'pay_recovery_late'`)
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }
    const late = await appendLateFinalityEvidence(paymentDatabase, {
      publicId: 'pay_recovery_late', txHash: TX,
      finality: {
        blockNumber: 50_000_001n, blockHash: BLOCK_HASH,
        blockTime: new Date(Date.now() - 30_000).toISOString(),
        finalizedAt: new Date().toISOString(),
      },
      reason: 'matching payment finalized after automatic recovery ended',
    })
    assert.equal(late.status, 'founder_review')
    const after = await database.query<{
      status: string
      request_json: unknown
      invalid_reason: string
      created_at: Date
      finalized_block_number: string
      tx_hash: string
    }>(`SELECT status, request_json, invalid_reason, created_at,
               finalized_block_number::text, tx_hash
        FROM payment_attempts WHERE public_id = 'pay_recovery_late'`)
    assert.deepEqual(after.rows[0]?.request_json, before.rows[0]?.request_json)
    assert.equal(after.rows[0]?.invalid_reason, before.rows[0]?.invalid_reason)
    assert.deepEqual(after.rows[0]?.created_at, before.rows[0]?.created_at)
    assert.equal(after.rows[0]?.finalized_block_number, '50000001')
    assert.equal(after.rows[0]?.tx_hash, TX)

    const founderReason = 'matching payment finalized after automatic recovery ended'
    await insertAttempt(database, {
      publicId: 'pay_recovery_late_reason', targetKey: 'frontier:root:late-reason',
      status: 'expired', leaseOwner: null, txHash: null, finalized: false,
      recovery: 'due', invalidReason: null,
    })
    const reasoned = await appendLateFinalityEvidence(paymentDatabase, {
      publicId: 'pay_recovery_late_reason', txHash: `0x${'5'.repeat(64)}`,
      finality: {
        blockNumber: 50_000_002n, blockHash: `0x${'6'.repeat(64)}`,
        blockTime: new Date(Date.now() - 20_000).toISOString(),
        finalizedAt: new Date().toISOString(),
      },
      reason: founderReason,
    })
    assert.equal(reasoned.status, 'founder_review')
    assert.equal(reasoned.invalidReason, founderReason)

    await assert.rejects(
      database.query("DELETE FROM payment_attempts WHERE public_id = 'pay_recovery_late'"),
      (error: unknown) => postgresCode(error) === '55000',
    )
    await assert.rejects(
      database.query(`UPDATE payment_attempts SET request_json = '{"name":"rewritten"}'::jsonb
        WHERE public_id = 'pay_recovery_late'`),
      (error: unknown) => postgresCode(error) === '55000',
    )
  })

}
