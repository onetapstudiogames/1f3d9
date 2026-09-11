import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PaymentAttemptConflictError,
  appendLateFinalityEvidence,
  expirePaymentAttempt,
  invalidatePaymentAttempt,
  listRecoverablePaymentAttempts,
  markPaymentAttemptFounderReview,
  markPaymentAttemptNeedsReview,
  toPublicPaymentAttempt,
  PAYMENT_RECOVERY_WINDOW_MILLISECONDS,
} from '../../src/payment-attempts.ts'
import { BLOCK_HASH, TX, QueuedDatabase, row } from '../helpers/payment-attempts-fixtures/attempt-records.ts'

export function registerRecoveryTransitionsTests(): void {
  test('invalid and deadline expiry are forward-only terminal transitions', async () => {
    const invalid = row({ status: 'invalid', invalidReason: 'authorization did not settle' })
    const invalidDb = new QueuedDatabase([invalid])
    assert.equal((await invalidatePaymentAttempt(invalidDb, {
      publicId: invalid.publicId,
      leaseOwner: 'lease_winner',
      reason: 'authorization did not settle',
    })).status, 'invalid')
    assert.match(invalidDb.calls[0]?.text ?? '', /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*\)/iu)

    const expired = row({ status: 'expired', invalidReason: 'authorization expired unused' })
    const expiredDb = new QueuedDatabase([expired])
    assert.equal((await expirePaymentAttempt(expiredDb, {
      publicId: expired.publicId,
      leaseOwner: 'lease_winner',
      reason: 'authorization expired unused',
    })).status, 'expired')
    assert.match(expiredDb.calls[0]?.text ?? '', /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*\)/iu)
    assert.match(expiredDb.calls[0]?.text ?? '', /recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu)

    const completed = row({ status: 'completed' })
    const blockedDb = new QueuedDatabase([], [completed])
    await assert.rejects(
      invalidatePaymentAttempt(blockedDb, {
        publicId: completed.publicId,
        leaseOwner: 'lease_winner',
        reason: 'late invalidation',
      }),
      (error: unknown) => error instanceof PaymentAttemptConflictError,
    )
  })

  test('ambiguous settlement becomes durable review and never asks for another payment', async () => {
    const review = row({
      status: 'needs_review',
      invalidReason: 'facilitator outcome is ambiguous',
    })
    const database = new QueuedDatabase([review])
    const result = await markPaymentAttemptNeedsReview(database, {
      publicId: review.publicId,
      leaseOwner: 'lease_winner',
      reason: 'facilitator outcome is ambiguous',
    })

    assert.equal(result.status, 'needs_review')
    assert.equal(toPublicPaymentAttempt(result).do_not_pay_again, true)
    assert.match(database.calls[0]?.text ?? '', /status\s*=\s*'needs_review'/iu)
    assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*NULL/iu)
    assert.match(database.calls[0]?.text ?? '', /recovery_started_at\s*=\s*coalesce\s*\(\s*recovery_started_at/iu)
    assert.match(
      database.calls[0]?.text ?? '',
      new RegExp(`${PAYMENT_RECOVERY_WINDOW_MILLISECONDS}::bigint\\s*\\*\\s*interval\\s+'1 millisecond'`, 'iu'),
    )
  })

  test('bounded recovery scans are ordered, lease-aware, and reject unbounded limits', async () => {
    const due = row({
      status: 'payment_pending',
      txHash: TX,
      recoveryStartedAt: '2026-08-16T12:00:00.000Z',
      recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
    })
    const database = new QueuedDatabase([due])

    const attempts = await listRecoverablePaymentAttempts(database, { limit: 25 })

    assert.equal(attempts[0]?.publicId, due.publicId)
    assert.deepEqual(database.calls[0]?.params, [25])
    assert.match(database.calls[0]?.text ?? '', /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*\)/iu)
    assert.match(database.calls[0]?.text ?? '', /lease_expires_at\s+IS\s+NULL\s+OR\s+lease_expires_at\s*<=\s*clock_timestamp\(\)/iu)
    assert.match(database.calls[0]?.text ?? '', /ORDER\s+BY\s+recovery_deadline_at[\s\S]*updated_at[\s\S]*public_id/iu)
    await assert.rejects(
      listRecoverablePaymentAttempts(new QueuedDatabase(), { limit: 101 }),
      /limit/iu,
    )
  })

  test('a leased live attempt can become terminal founder review without a domain effect', async () => {
    const review = row({
      status: 'founder_review',
      txHash: TX,
      recoveryStartedAt: '2026-08-16T12:00:00.000Z',
      recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
      invalidReason: 'final payment disposition needs founder review',
    })
    const database = new QueuedDatabase([review])

    const result = await markPaymentAttemptFounderReview(database, {
      publicId: review.publicId,
      leaseOwner: 'lease_winner',
      reason: 'final payment disposition needs founder review',
    })

    assert.equal(result.status, 'founder_review')
    assert.match(database.calls[0]?.text ?? '', /status\s*=\s*'founder_review'/iu)
    assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*NULL/iu)
    assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*\$2/iu)
  })

  test('late finalized evidence is atomically appended only from expired into founder review', async () => {
    const late = row({
      status: 'founder_review',
      txHash: TX,
      finalizedBlockNumber: 22_000_010n,
      finalizedBlockHash: BLOCK_HASH,
      finalizedBlockTime: '2026-08-16T14:00:01.000Z',
      finalizedAt: '2026-08-16T14:01:00.000Z',
      recoveryStartedAt: '2026-08-16T12:00:00.000Z',
      recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
      invalidReason: 'automatic recovery deadline reached',
    })
    const database = new QueuedDatabase([late])

    const result = await appendLateFinalityEvidence(database, {
      publicId: late.publicId,
      txHash: TX,
      finality: {
        blockNumber: 22_000_010n,
        blockHash: BLOCK_HASH,
        blockTime: '2026-08-16T14:00:01.000Z',
        finalizedAt: '2026-08-16T14:01:00.000Z',
      },
      reason: 'matching payment finalized after automatic recovery ended',
    })

    assert.equal(result.status, 'founder_review')
    assert.match(database.calls[0]?.text ?? '', /status\s*=\s*'founder_review'/iu)
    assert.match(database.calls[0]?.text ?? '', /status\s*=\s*'expired'/iu)
    assert.match(database.calls[0]?.text ?? '', /tx_hash\s*=\s*coalesce\s*\(\s*tx_hash\s*,\s*lower/iu)
    assert.match(database.calls[0]?.text ?? '', /invalid_reason\s*=\s*coalesce\s*\(\s*invalid_reason\s*,\s*\$7\s*\)/iu)
    assert.equal(database.calls[0]?.params[6], 'matching payment finalized after automatic recovery ended')
    assert.match(database.calls[0]?.text ?? '', /tx_hash\s*=\s*lower\s*\(\s*\$2\s*\)/iu)
    assert.match(database.calls[0]?.text ?? '', /finalized_block_number\s+IS\s+NULL/iu)
    assert.match(database.calls[0]?.text ?? '', /recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu)
  })
}
