import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { setTimeout as delay } from 'node:timers/promises'
import {
  beginCityCreditSpend,
  completeCityCreditAttempt,
  issueCityFeeCredit,
  returnCityCreditSpend,
  returnExpiredCityCreditSpend,
} from '../../../src/city-credit.ts'
import { canonicalPaymentRequest } from '../../../src/payment-attempts.ts'
import { CREDIT_UNITS } from '../../helpers/city-credit-postgres-fixtures/ledger.ts'
import { cityCreditDatabase } from '../../helpers/city-credit-postgres-fixtures/service-database.ts'

export async function registerRecoveryDeadlineTests(
  t: TestContext,
  postgres: { client: Pool },
  resetFresh: (database: Pool) => Promise<void>,
): Promise<void> {
  await t.test('one statement cutoff cannot lease before the boundary and mark due after it', async () => {
    await resetFresh(postgres.client)
    const database = cityCreditDatabase(postgres.client)
    await issueCityFeeCredit(database, {
      founderId: 1,
      residentId: 2,
      sourceKey: 'boundary-cutoff-issue-0001',
      reason: 'single statement recovery-cutoff integration test',
    })
    const attemptId = 'credit_attempt_boundary_cutoff_0001'
    const requestId = 'boundary-cutoff-request-0001'
    const request = { name: 'boundary-cutoff', parent_id: null }
    const canonical = canonicalPaymentRequest(request)
    const inserted = await postgres.client.query<{ recovery_deadline_at: Date }>(`
        WITH recovery AS (
          SELECT clock_timestamp() + interval '2 seconds' AS deadline_at
        )
        INSERT INTO payment_attempts (
          public_id, actor_id, operation, target_key,
          request_hash, request_json, method, amount_units, status,
          recovery_started_at, recovery_deadline_at
        )
        SELECT $1, 2, 'frontier', 'frontier:boundary-cutoff',
          $2, $3::jsonb, 'credit', $4, 'payment_pending',
          recovery.deadline_at - interval '2 hours', recovery.deadline_at
        FROM recovery
        RETURNING recovery_deadline_at
      `, [attemptId, canonical.hash, canonical.json, CREDIT_UNITS])
    await postgres.client.query(`
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, request_id, payment_attempt_id
        ) VALUES (2, 'spend', $1, $2, $3)
      `, [CREDIT_UNITS, requestId, attemptId])

    const gate = await postgres.client.connect()
    await gate.query('BEGIN')
    await gate.query('SELECT 1 FROM payment_attempts WHERE public_id = $1 FOR UPDATE', [attemptId])
    const beginPromise = beginCityCreditSpend(database, {
      actorId: 2,
      operation: 'frontier',
      targetKey: 'frontier:boundary-cutoff',
      request,
      requestId,
    })
    try {
      const waitDeadline = Date.now() + 1_000
      let blocked = false
      while (!blocked && Date.now() < waitDeadline) {
        const activity = await postgres.client.query<{ blocked: boolean }>(`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE '%city-credit:begin-spend%'
            ) AS blocked
          `)
        blocked = activity.rows[0]?.blocked === true
        if (!blocked) await delay(20)
      }
      assert.equal(blocked, true, 'begin-spend did not reach the row lock before its deadline')
      const recoveryDeadline = inserted.rows[0]!.recovery_deadline_at
      let deadlinePassed = false
      while (!deadlinePassed) {
        const clock = await postgres.client.query<{ passed: boolean }>(
          'SELECT clock_timestamp() >= $1::timestamptz AS passed',
          [recoveryDeadline],
        )
        deadlinePassed = clock.rows[0]?.passed === true
        if (!deadlinePassed) await delay(20)
      }
      await gate.query('COMMIT')
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined)
      gate.release()
    }

    const ready = await beginPromise
    assert.equal(ready.state, 'ready')
    if (ready.state !== 'ready') throw new Error('pre-boundary statement did not keep one cutoff')
    assert.equal(ready.attempt_id, attemptId)
    await assert.rejects(
      completeCityCreditAttempt(database, {
        actorId: 2,
        attemptId,
        leaseOwner: ready.lease_owner,
        result: { kind: 'place', id: 91 },
        responseStatus: 201,
        response: { ok: true, place: { id: 91 } },
      }),
      /no longer owns|cannot complete|completion/iu,
    )
    const returned = await returnExpiredCityCreditSpend(database, {
      actorId: 2,
      attemptId,
      leaseOwner: ready.lease_owner,
    })
    assert.equal(returned.state, 'credit_returned')
    const facts = await postgres.client.query<{
      status: string
      returns: number
      balance_units: string
    }>(`
        SELECT attempt.status, count(returned.id)::int AS returns,
          account.balance_units::text
        FROM payment_attempts attempt
        JOIN city_credit_entries spend
          ON spend.payment_attempt_id = attempt.public_id AND spend.entry_kind = 'spend'
        LEFT JOIN city_credit_entries returned
          ON returned.related_spend_id = spend.id AND returned.entry_kind = 'return'
        JOIN city_credit_accounts account ON account.resident_id = attempt.actor_id
        WHERE attempt.public_id = $1
        GROUP BY attempt.status, account.balance_units
      `, [attemptId])
    assert.deepEqual(facts.rows, [{
      status: 'credit_returned', returns: 1, balance_units: CREDIT_UNITS,
    }])
  })

  await t.test('the deadline returns one exact spend before the same live target is reused', async () => {
    await resetFresh(postgres.client)
    const database = cityCreditDatabase(postgres.client)
    await issueCityFeeCredit(database, {
      founderId: 1,
      residentId: 2,
      sourceKey: 'deadline-reuse-issue-0001',
      reason: 'deadline target-reuse integration test',
    })

    const expiredAttemptId = 'credit_attempt_deadline_reuse_0001'
    await postgres.client.query(`
        WITH recovery AS (
          SELECT statement_timestamp() - interval '2 hours' AS started_at
        )
        INSERT INTO payment_attempts (
          public_id, actor_id, operation, target_key,
          request_hash, request_json, method, amount_units, status,
          recovery_started_at, recovery_deadline_at
        )
        SELECT $1, 2, 'frontier', 'frontier:deadline-target-reuse',
          repeat('d', 64), jsonb_build_object('name', 'expired-holder'),
          'credit', $2, 'payment_pending',
          recovery.started_at, recovery.started_at + interval '2 hours'
        FROM recovery
      `, [expiredAttemptId, CREDIT_UNITS])
    await postgres.client.query(`
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, request_id, payment_attempt_id
        ) VALUES (2, 'spend', $1, 'deadline-reuse-old-request-0001', $2)
      `, [CREDIT_UNITS, expiredAttemptId])

    const later = await beginCityCreditSpend(database, {
      actorId: 2,
      operation: 'frontier',
      targetKey: 'frontier:deadline-target-reuse',
      request: { name: 'deadline-target-reuse', parent_id: null },
      requestId: 'deadline-reuse-new-request-0001',
    })
    assert.equal(later.state, 'ready')
    if (later.state !== 'ready') throw new Error('later target did not acquire its credit lease')
    assert.notEqual(later.attempt_id, expiredAttemptId)

    const replay = await returnExpiredCityCreditSpend(database, {
      actorId: 2,
      attemptId: expiredAttemptId,
    })
    assert.equal(replay.state, 'credit_returned')
    if (replay.state !== 'credit_returned') throw new Error('expired credit was not returned')
    assert.equal(replay.disposition, 'existing')

    const stored = await postgres.client.query<{
      founder_issues: number
      spends: number
      returns: number
      balance_units: string
      old_status: string
      live_targets: number
      exact_return: boolean
    }>(`
        SELECT
          count(*) FILTER (WHERE entry.entry_kind = 'founder_issue')::int AS founder_issues,
          count(*) FILTER (WHERE entry.entry_kind = 'spend')::int AS spends,
          count(*) FILTER (WHERE entry.entry_kind = 'return')::int AS returns,
          account.balance_units::text AS balance_units,
          max(attempt.status) FILTER (WHERE attempt.public_id = $1) AS old_status,
          count(DISTINCT attempt.public_id) FILTER (
            WHERE attempt.operation = 'frontier'
              AND attempt.target_key = 'frontier:deadline-target-reuse'
              AND attempt.status IN ('settling', 'payment_pending', 'needs_review')
          )::int AS live_targets,
          bool_and(
            entry.entry_kind <> 'return'
            OR (
              entry.related_spend_id = old_spend.id
              AND entry.amount_units = old_spend.amount_units
              AND entry.payment_attempt_id = old_spend.payment_attempt_id
            )
          ) AS exact_return
        FROM city_credit_entries entry
        CROSS JOIN city_credit_accounts account
        LEFT JOIN payment_attempts attempt ON attempt.public_id = entry.payment_attempt_id
        LEFT JOIN city_credit_entries old_spend
          ON old_spend.payment_attempt_id = $1 AND old_spend.entry_kind = 'spend'
        WHERE entry.resident_id = 2 AND account.resident_id = 2
        GROUP BY account.balance_units
      `, [expiredAttemptId])
    assert.deepEqual(stored.rows, [{
      founder_issues: 1,
      spends: 2,
      returns: 1,
      balance_units: '0',
      old_status: 'credit_returned',
      live_targets: 1,
      exact_return: true,
    }])

    const duplicateReturnInput = {
      actorId: 2,
      attemptId: later.attempt_id,
      leaseOwner: later.lease_owner,
      reason: 'overlapping exact-return integration test',
      responseStatus: 409,
      response: { error: 'overlapping exact-return integration test; city fee credit returned' },
    }
    const returnGate = await postgres.client.connect()
    await returnGate.query('BEGIN')
    await returnGate.query(
      'SELECT 1 FROM payment_attempts WHERE public_id = $1 FOR UPDATE',
      [later.attempt_id],
    )
    const overlappingPromise = Promise.all([
      returnCityCreditSpend(database, duplicateReturnInput),
      returnCityCreditSpend(database, duplicateReturnInput),
    ])
    try {
      const overlapDeadline = Date.now() + 1_000
      let blockedReturns = 0
      while (blockedReturns < 2 && Date.now() < overlapDeadline) {
        const activity = await postgres.client.query<{ blocked: number }>(`
            SELECT count(*)::int AS blocked
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE '%city-credit:return-spend%'
          `)
        blockedReturns = activity.rows[0]?.blocked ?? 0
        if (blockedReturns < 2) await delay(20)
      }
      assert.equal(blockedReturns, 2, 'both duplicate returns must overlap on the row lock')
      await returnGate.query('COMMIT')
    } finally {
      await returnGate.query('ROLLBACK').catch(() => undefined)
      returnGate.release()
    }
    const overlapping = await overlappingPromise
    for (const result of overlapping) {
      assert.equal(result.state, 'returned')
    }
    assert.deepEqual(
      overlapping.map(result => result.disposition).sort(),
      ['created', 'existing'],
    )
    const duplicateFacts = await postgres.client.query<{
      returns: number
      balance_units: string
    }>(`
        SELECT count(returned.id)::int AS returns, account.balance_units::text
        FROM city_credit_entries spend
        JOIN city_credit_entries returned
          ON returned.related_spend_id = spend.id AND returned.entry_kind = 'return'
        JOIN city_credit_accounts account ON account.resident_id = spend.resident_id
        WHERE spend.payment_attempt_id = $1 AND spend.entry_kind = 'spend'
        GROUP BY account.balance_units
      `, [later.attempt_id])
    assert.deepEqual(duplicateFacts.rows, [{ returns: 1, balance_units: CREDIT_UNITS }])
  })
}
