import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  PaymentAttemptConflictError,
  acquireDueSettlementLease,
  completePaymentAttempt,
  expirePaymentAttempt,
  markPaymentAttemptFounderReview,
} from '../../../src/payment-attempts.ts'
import {
  RESPONSE,
  RESPONSE_BODY,
  insertAttempt,
} from '../../helpers/payment-recovery-postgres-fixtures/payment-attempts.ts'

export async function registerDeadlinesTests(
  t: TestContext,
  database: Pool,
  reset: (database: Pool) => Promise<void>,
  cityCreditMigrationDdl: string,
  recoveryTriggerRepairMigrationDdl: string,
): Promise<void> {
  await t.test('city credit cannot replace the newer payment transition rules', async () => {
    await reset(database)
    await database.query(cityCreditMigrationDdl)
    await database.query(recoveryTriggerRepairMigrationDdl)
    await database.query(recoveryTriggerRepairMigrationDdl)
    await insertAttempt(database, {
      publicId: 'pay_recovery_after_credit', targetKey: 'frontier:root:after-credit',
      leaseOwner: 'lease-after-credit', recovery: 'due',
    })

    const expired = await expirePaymentAttempt({ query: async (text, params = []) => (
      await database.query(text, [...params])
    ).rows }, {
      publicId: 'pay_recovery_after_credit',
      leaseOwner: 'lease-after-credit',
      reason: 'automatic payment recovery deadline passed',
    })
    assert.equal(expired.status, 'expired')
  })

  await t.test('recovery deadline is exactly two hours and equality cannot complete', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_before_boundary', targetKey: 'frontier:root:before-boundary',
      leaseOwner: 'lease-before', finalized: true, recovery: 'future',
    })
    const completed = await completePaymentAttempt({ query: async (text, params = []) => (
      await database.query(text, [...params])
    ).rows }, {
      publicId: 'pay_recovery_before_boundary',
      leaseOwner: 'lease-before',
      result: { place_id: 91 }, responseStatus: 201, response: RESPONSE,
      responseBody: RESPONSE_BODY,
    })
    assert.equal(completed.status, 'completed')

    await insertAttempt(database, {
      publicId: 'pay_recovery_at_boundary', targetKey: 'frontier:root:at-boundary',
      leaseOwner: 'lease-due', finalized: true, recovery: 'due',
    })
    await assert.rejects(
      completePaymentAttempt({ query: async (text, params = []) => (
        await database.query(text, [...params])
      ).rows }, {
        publicId: 'pay_recovery_at_boundary',
        leaseOwner: 'lease-due', result: { place_id: 92 }, responseStatus: 201,
        response: RESPONSE, responseBody: RESPONSE_BODY,
      }),
      (error: unknown) => error instanceof PaymentAttemptConflictError,
    )
    const expired = await expirePaymentAttempt({ query: async (text, params = []) => (
      await database.query(text, [...params])
    ).rows }, {
      publicId: 'pay_recovery_at_boundary', leaseOwner: 'lease-due',
      reason: 'automatic recovery deadline reached',
    })
    assert.equal(expired.status, 'expired')

    const windows = await database.query<{ exact: boolean }>(`
      SELECT bool_and(recovery_deadline_at = recovery_started_at + interval '2 hours') AS exact
      FROM payment_attempts WHERE recovery_started_at IS NOT NULL
    `)
    assert.equal(windows.rows[0]?.exact, true)
  })

  await t.test('due-only leases refuse one millisecond before, acquire at and after equality, and overlap safely', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_due_lease_boundary', targetKey: 'frontier:root:due-lease-boundary',
      status: 'payment_pending', leaseOwner: null, recovery: 'due',
    })
    const boundary = await database.query<{ recovery_deadline_at: Date }>(`
      SELECT recovery_deadline_at FROM payment_attempts
      WHERE public_id = 'pay_recovery_due_lease_boundary'
    `)
    const deadline = boundary.rows[0]?.recovery_deadline_at
    assert.ok(deadline instanceof Date)

    const databaseAt = (observedAt: Date) => ({
      query: async (text: string, params: readonly unknown[] = []) => {
        if (!text.includes('payment-attempts:lease-due */')) {
          return (await database.query(text, [...params])).rows
        }
        assert.match(text, /recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu)
        const controlled = text.replaceAll('clock_timestamp()', '$5::timestamptz')
        return (await database.query(controlled, [...params, observedAt.toISOString()])).rows
      },
    })
    const oneMillisecondBefore = new Date(deadline.getTime() - 1)
    const refused = await acquireDueSettlementLease(databaseAt(oneMillisecondBefore), {
      publicId: 'pay_recovery_due_lease_boundary', actorId: 2, leaseMilliseconds: 30_000,
    }, () => 'due_lease_before')
    assert.equal(refused.acquired, false)
    assert.equal(refused.attempt?.leaseOwner, null)

    const acquired = await acquireDueSettlementLease(databaseAt(deadline), {
      publicId: 'pay_recovery_due_lease_boundary', actorId: 2, leaseMilliseconds: 30_000,
    }, () => 'due_lease_exact')
    assert.equal(acquired.acquired, true)
    assert.equal(acquired.leaseOwner, 'due_lease_exact')

    await insertAttempt(database, {
      publicId: 'pay_recovery_due_lease_after', targetKey: 'frontier:root:due-lease-after',
      status: 'payment_pending', leaseOwner: null, recovery: 'due',
    })
    const afterBoundary = await database.query<{ recovery_deadline_at: Date }>(`
      SELECT recovery_deadline_at FROM payment_attempts
      WHERE public_id = 'pay_recovery_due_lease_after'
    `)
    const afterDeadline = afterBoundary.rows[0]?.recovery_deadline_at
    assert.ok(afterDeadline instanceof Date)
    const oneMillisecondAfter = new Date(afterDeadline.getTime() + 1)
    const acquiredAfter = await acquireDueSettlementLease(databaseAt(oneMillisecondAfter), {
      publicId: 'pay_recovery_due_lease_after', actorId: 2, leaseMilliseconds: 30_000,
    }, () => 'due_lease_after')
    assert.equal(acquiredAfter.acquired, true)
    assert.equal(acquiredAfter.leaseOwner, 'due_lease_after')

    await insertAttempt(database, {
      publicId: 'pay_recovery_due_lease_race', targetKey: 'frontier:root:due-lease-race',
      status: 'payment_pending', leaseOwner: null, recovery: 'due',
    })
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }
    const racers = await Promise.all([
      acquireDueSettlementLease(paymentDatabase, {
        publicId: 'pay_recovery_due_lease_race', actorId: 2, leaseMilliseconds: 30_000,
      }, () => 'due_lease_racer_a'),
      acquireDueSettlementLease(paymentDatabase, {
        publicId: 'pay_recovery_due_lease_race', actorId: 2, leaseMilliseconds: 30_000,
      }, () => 'due_lease_racer_b'),
    ])
    assert.equal(racers.filter(result => result.acquired).length, 1)
    assert.equal(racers.filter(result => !result.acquired).length, 1)
  })

  await t.test('terminal states release live targets and overlapping completion cannot win after deadline', async () => {
    await reset(database)
    await insertAttempt(database, {
      publicId: 'pay_recovery_race', targetKey: 'frontier:root:race-target',
      leaseOwner: 'lease-race', finalized: true, recovery: 'due',
    })
    const paymentDatabase = { query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows }
    const [expiry, completion] = await Promise.allSettled([
      expirePaymentAttempt(paymentDatabase, {
        publicId: 'pay_recovery_race', leaseOwner: 'lease-race',
        reason: 'automatic recovery deadline reached',
      }),
      completePaymentAttempt(paymentDatabase, {
        publicId: 'pay_recovery_race', leaseOwner: 'lease-race',
        result: { place_id: 93 }, responseStatus: 201, response: RESPONSE,
        responseBody: RESPONSE_BODY,
      }),
    ])
    assert.equal(expiry.status, 'fulfilled')
    assert.equal(completion.status, 'rejected')
    const row = await database.query<{ status: string; result_json: unknown; lease_owner: string | null }>(`
      SELECT status, result_json, lease_owner FROM payment_attempts
      WHERE public_id = 'pay_recovery_race'
    `)
    assert.deepEqual(row.rows, [{ status: 'expired', result_json: null, lease_owner: null }])

    await insertAttempt(database, {
      publicId: 'pay_recovery_reused_target', targetKey: 'frontier:root:race-target',
      status: 'settling', leaseOwner: null, txHash: null, recovery: 'none',
    })
    await insertAttempt(database, {
      publicId: 'pay_recovery_founder_live', targetKey: 'frontier:root:founder-target',
      leaseOwner: 'lease-founder', recovery: 'future',
    })
    const founderReview = await markPaymentAttemptFounderReview(paymentDatabase, {
      publicId: 'pay_recovery_founder_live', leaseOwner: 'lease-founder',
      reason: 'matching payment needs founder review',
    })
    assert.equal(founderReview.status, 'founder_review')
    await insertAttempt(database, {
      publicId: 'pay_recovery_founder_reuse', targetKey: 'frontier:root:founder-target',
      status: 'settling', leaseOwner: null, txHash: null, recovery: 'none',
    })
  })

}
