import test from 'node:test'
import assert from 'node:assert/strict'
import {
  acquireDueSettlementLease,
  acquireSettlementLease,
  releaseSettlementLease,
} from '../../src/payment-attempts.ts'
import { TX, QueuedDatabase, row } from '../helpers/payment-attempts-fixtures/attempt-records.ts'

export function registerSettlementLeasesTests(): void {
  test('settlement leases use an atomic compare-and-swap and do not expose a losing token', async () => {
    const leased = row({ leaseOwner: 'lease_winner', leaseExpiresAt: '2026-08-16T12:01:00.000Z' })
    const winnerDb = new QueuedDatabase([leased])
    const winner = await acquireSettlementLease(
      winnerDb,
      { publicId: leased.publicId, actorId: leased.actorId, leaseMilliseconds: 30_000 },
      () => 'lease_winner',
    )

    assert.equal(winner.acquired, true)
    if (winner.acquired) assert.equal(winner.leaseOwner, 'lease_winner')
    assert.match(winnerDb.calls[0]?.text ?? '', /UPDATE\s+payment_attempts/iu)
    assert.match(winnerDb.calls[0]?.text ?? '', /lease_expires_at\s*<=\s*now\(\)/iu)
    assert.match(winnerDb.calls[0]?.text ?? '', /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*\)/iu)

    const loserDb = new QueuedDatabase([], [row({ leaseOwner: 'lease_winner' })])
    const loser = await acquireSettlementLease(
      loserDb,
      { publicId: leased.publicId, actorId: leased.actorId, leaseMilliseconds: 30_000 },
      () => 'lease_loser',
    )
    assert.deepEqual(loser, { acquired: false, attempt: row({ leaseOwner: 'lease_winner' }) })
  })

  test('due-only settlement leases use the database deadline and read current state on a miss', async () => {
    const due = row({
      status: 'payment_pending',
      txHash: TX,
      recoveryStartedAt: '2026-08-16T12:00:00.000Z',
      recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
      leaseOwner: 'due_worker',
      leaseExpiresAt: '2026-08-16T14:00:30.000Z',
    })
    const winnerDatabase = new QueuedDatabase([due])

    const winner = await acquireDueSettlementLease(
      winnerDatabase,
      { publicId: due.publicId, actorId: due.actorId, leaseMilliseconds: 30_000 },
      () => 'due_worker',
    )

    assert.equal(winner.acquired, true)
    assert.match(winnerDatabase.calls[0]?.text ?? '', /payment-attempts:lease-due/iu)
    assert.match(
      winnerDatabase.calls[0]?.text ?? '',
      /recovery_deadline_at\s+IS\s+NOT\s+NULL[\s\S]*recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu,
    )
    assert.match(
      winnerDatabase.calls[0]?.text ?? '',
      /lease_expires_at\s+IS\s+NULL\s+OR\s+lease_expires_at\s*<=\s*clock_timestamp\(\)/iu,
    )

    const beforeDeadline = row({
      status: 'payment_pending',
      txHash: TX,
      recoveryStartedAt: '2026-08-16T12:00:00.001Z',
      recoveryDeadlineAt: '2026-08-16T14:00:00.001Z',
    })
    const loserDatabase = new QueuedDatabase([], [beforeDeadline])
    const loser = await acquireDueSettlementLease(
      loserDatabase,
      { publicId: beforeDeadline.publicId, actorId: beforeDeadline.actorId, leaseMilliseconds: 30_000 },
      () => 'losing_worker',
    )
    assert.equal(loser.acquired, false)
    assert.equal(loser.attempt?.recoveryDeadlineAt, '2026-08-16T14:00:00.001Z')
    assert.match(loserDatabase.calls[1]?.text ?? '', /payment-attempts:lease-due-read/iu)
  })

  test('a pending or pre-settlement retry releases only its own lease', async () => {
    const pending = row({ status: 'payment_pending', leaseOwner: null, leaseExpiresAt: null })
    const database = new QueuedDatabase([pending])

    const result = await releaseSettlementLease(database, {
      publicId: pending.publicId,
      leaseOwner: 'lease_winner',
    })

    assert.equal(result.status, 'payment_pending')
    assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*NULL/iu)
    assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*\$2/iu)
    assert.match(database.calls[0]?.text ?? '', /status\s+IN\s*\(/iu)
  })
}
