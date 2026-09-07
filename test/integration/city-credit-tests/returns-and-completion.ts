import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  CREDIT_UNITS,
  accountAndLedger,
  insertCreditAttempt,
  issueCredit,
  postgresCode,
  rejectsWithCode,
  spendCredit,
} from '../../helpers/city-credit-postgres-fixtures/ledger.ts'

export async function registerReturnsAndCompletionTests(
  t: TestContext,
  postgres: { client: Pool },
  resetFresh: (database: Pool) => Promise<void>,
): Promise<void> {
  await t.test('a return is exact, same-resident, spend-backed, and one-time', async () => {
    await resetFresh(postgres.client)
    const residentTwoIssue = await issueCredit(
      postgres.client,
      2,
      'return-seed-resident-two-0001',
    )
    await issueCredit(postgres.client, 3, 'return-seed-resident-three-01')
    const attemptId = 'credit_return_attempt_postgres_01'
    const leaseOwner = `credit-lease-${attemptId}`
    await insertCreditAttempt(
      postgres.client,
      attemptId,
      2,
      'frontier',
      'frontier:return-test',
      leaseOwner,
    )
    const spendId = await spendCredit(
      postgres.client,
      2,
      attemptId,
      'credit-return-spend-postgres-001',
    )

    await rejectsWithCode(
      postgres.client.query(`
          INSERT INTO city_credit_entries (
            resident_id, entry_kind, amount_units,
            payment_attempt_id, related_spend_id, reason
          ) VALUES (2, 'return', $1, $2, $3, 'wrong related entry kind')
        `, [CREDIT_UNITS, attemptId, residentTwoIssue]),
      '23514',
    )
    await rejectsWithCode(
      postgres.client.query(`
          INSERT INTO city_credit_entries (
            resident_id, entry_kind, amount_units,
            payment_attempt_id, related_spend_id, reason
          ) VALUES (3, 'return', $1, $2, $3, 'cross-resident return')
        `, [CREDIT_UNITS, attemptId, spendId]),
      '23514',
    )
    await rejectsWithCode(
      postgres.client.query(`
          INSERT INTO city_credit_entries (
            resident_id, entry_kind, amount_units,
            payment_attempt_id, related_spend_id, reason
          ) VALUES (2, 'return', 999999, $1, $2, 'wrong amount return')
        `, [attemptId, spendId]),
      '23514',
    )

    const returnReason = 'eligible operation failed after debit'
    const returnBody = JSON.stringify({ error: 'city fee credit returned' })
    const returnResponse = { error: 'city fee credit returned' }
    const returnAttempt = async () => postgres.client.query<{
      status: string
      response_status: number
      response_json: Record<string, unknown>
      response_body_hex: string
    }>(`
        SELECT returned.status, returned.response_status, returned.response_json,
          encode(returned.response_body_bytes, 'hex') AS response_body_hex
        FROM return_city_credit_spend(
          $1, $2, $3, $4, $5::jsonb, convert_to($6, 'UTF8')
        ) AS returned
      `, [
      attemptId,
      leaseOwner,
      returnReason,
      409,
      JSON.stringify(returnResponse),
      returnBody,
    ])
    const returned = await returnAttempt()
    assert.deepEqual(returned.rows, [{
      status: 'credit_returned',
      response_status: 409,
      response_json: returnResponse,
      response_body_hex: Buffer.from(returnBody, 'utf8').toString('hex'),
    }])
    assert.deepEqual((await returnAttempt()).rows, returned.rows)

    let changedTermsReturnedARow = false
    try {
      const changed = await postgres.client.query(`
          SELECT returned.status
          FROM return_city_credit_spend(
            $1, $2, $3, $4, $5::jsonb, convert_to($6, 'UTF8')
          ) AS returned
          WHERE returned IS NOT NULL
        `, [
        attemptId,
        leaseOwner,
        'changed return reason',
        409,
        JSON.stringify(returnResponse),
        returnBody,
      ])
      changedTermsReturnedARow = changed.rowCount === 1
    } catch (error) {
      assert.equal(postgresCode(error), '55000')
    }
    assert.equal(changedTermsReturnedARow, false, 'changed return terms must not replay')

    const returnState = await postgres.client.query<{
      resident_id: number
      amount_units: string
      payment_attempt_id: string
      related_spend_id: string
      returns: number
      status: string
    }>(`
        SELECT entry.resident_id, entry.amount_units::text,
          entry.payment_attempt_id, entry.related_spend_id::text,
          (SELECT count(*)::int FROM city_credit_entries
            WHERE related_spend_id = $1 AND entry_kind = 'return') AS returns,
          attempt.status
        FROM city_credit_entries AS entry
        JOIN payment_attempts AS attempt
          ON attempt.public_id = entry.payment_attempt_id
        WHERE entry.related_spend_id = $1 AND entry.entry_kind = 'return'
      `, [spendId])
    assert.deepEqual(returnState.rows, [{
      resident_id: 2,
      amount_units: CREDIT_UNITS,
      payment_attempt_id: attemptId,
      related_spend_id: spendId,
      returns: 1,
      status: 'credit_returned',
    }])
    assert.deepEqual(await accountAndLedger(postgres.client, 2), {
      balance_units: CREDIT_UNITS,
      ledger_units: CREDIT_UNITS,
    })

    await rejectsWithCode(
      postgres.client.query(`
          INSERT INTO city_credit_entries (
            resident_id, entry_kind, amount_units,
            payment_attempt_id, related_spend_id, reason
          ) VALUES (2, 'return', $1, $2, $3, 'second direct return')
        `, [CREDIT_UNITS, attemptId, spendId]),
      '23505',
    )
  })

  await t.test('a credit attempt completes only after its matching spend exists', async () => {
    await resetFresh(postgres.client)
    const attemptId = 'credit_completion_attempt_000001'
    const leaseOwner = `credit-lease-${attemptId}`
    await insertCreditAttempt(
      postgres.client,
      attemptId,
      2,
      'kind_invention',
      'kind:completed-credit-test',
      leaseOwner,
    )

    const completionResponse = { ok: true, kind: { id: 91 } }
    const completionBody = JSON.stringify(completionResponse)
    let missingSpendReturnedARow = false
    try {
      const missingSpend = await postgres.client.query(`
          SELECT completed.status
          FROM complete_city_credit_attempt(
            $1, $2, $3::jsonb, $4, $5::jsonb, convert_to($6, 'UTF8')
          ) AS completed
          WHERE completed IS NOT NULL
        `, [
        attemptId,
        leaseOwner,
        JSON.stringify({ kind_id: 91 }),
        201,
        JSON.stringify(completionResponse),
        completionBody,
      ])
      missingSpendReturnedARow = missingSpend.rowCount === 1
    } catch (error) {
      assert.ok(['23514', '55000'].includes(postgresCode(error) ?? ''))
    }
    assert.equal(missingSpendReturnedARow, false, 'an unspent credit attempt must not complete')
    const unchanged = await postgres.client.query<{
      status: string
      lease_owner: string
    }>('SELECT status, lease_owner FROM payment_attempts WHERE public_id = $1', [attemptId])
    assert.deepEqual(unchanged.rows, [{ status: 'settling', lease_owner: leaseOwner }])

    await issueCredit(postgres.client, 2, 'completion-seed-postgres-0001')
    await spendCredit(
      postgres.client,
      2,
      attemptId,
      'credit-completion-spend-000001',
    )
    const completed = await postgres.client.query<{
      status: string
      response_status: number
      response_json: Record<string, unknown>
      response_body_hex: string
    }>(`
        SELECT completed.status, completed.response_status, completed.response_json,
          encode(completed.response_body_bytes, 'hex') AS response_body_hex
        FROM complete_city_credit_attempt(
          $1, $2, $3::jsonb, $4, $5::jsonb, convert_to($6, 'UTF8')
        ) AS completed
      `, [
      attemptId,
      leaseOwner,
      JSON.stringify({ kind_id: 91 }),
      201,
      JSON.stringify(completionResponse),
      completionBody,
    ])
    assert.deepEqual(completed.rows, [{
      status: 'completed',
      response_status: 201,
      response_json: completionResponse,
      response_body_hex: Buffer.from(completionBody, 'utf8').toString('hex'),
    }])

    const finalState = await postgres.client.query<{
      status: string
      lease_owner: string | null
      spends: number
    }>(`
        SELECT attempt.status, attempt.lease_owner,
          (SELECT count(*)::int FROM city_credit_entries
            WHERE payment_attempt_id = attempt.public_id
              AND entry_kind = 'spend') AS spends
        FROM payment_attempts AS attempt
        WHERE attempt.public_id = $1
      `, [attemptId])
    assert.deepEqual(finalState.rows, [{ status: 'completed', lease_owner: null, spends: 1 }])
  })
}
