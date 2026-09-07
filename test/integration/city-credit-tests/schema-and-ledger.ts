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

export async function registerSchemaAndLedgerTests(
  t: TestContext,
  postgres: { client: Pool },
  resetFresh: (database: Pool) => Promise<void>,
  migrationDdl: string,
): Promise<void> {
  await t.test('the additive migration runs twice without issuing any credit', async () => {
    await resetFresh(postgres.client)
    await postgres.client.query(migrationDdl)
    await postgres.client.query(migrationDdl)

    const installed = await postgres.client.query<{
      accounts: string | null
      entries: string | null
      complete_function: string | null
      return_function: string | null
      issued_entries: number
    }>(`
        SELECT
          to_regclass('public.city_credit_accounts')::text AS accounts,
          to_regclass('public.city_credit_entries')::text AS entries,
          to_regprocedure(
            'public.complete_city_credit_attempt(text,text,jsonb,smallint,jsonb,bytea)'
          )::text AS complete_function,
          to_regprocedure(
            'public.return_city_credit_spend(text,text,text,smallint,jsonb,bytea)'
          )::text AS return_function,
          (SELECT count(*)::int FROM city_credit_entries) AS issued_entries
      `)
    assert.deepEqual(installed.rows, [{
      accounts: 'city_credit_accounts',
      entries: 'city_credit_entries',
      complete_function: 'complete_city_credit_attempt(text,text,jsonb,smallint,jsonb,bytea)',
      return_function: 'return_city_credit_spend(text,text,text,smallint,jsonb,bytea)',
      issued_entries: 0,
    }])
  })

  await t.test('only founder resident 1 issues one fixed credit unit and the ledger is append-only', async () => {
    await resetFresh(postgres.client)
    const issueId = await issueCredit(
      postgres.client,
      2,
      'founder-issue-postgres-0001',
    )

    await rejectsWithCode(issueCredit(
      postgres.client,
      2,
      'wrong-founder-postgres-0001',
      2,
    ), '23514')
    await rejectsWithCode(issueCredit(
      postgres.client,
      2,
      'wrong-amount-postgres-0001',
      1,
      '999999',
    ), '23514')

    const entry = await postgres.client.query<{
      entry_kind: string
      amount_units: string
      founder_id: number
    }>(`
        SELECT entry_kind, amount_units::text, founder_id
        FROM city_credit_entries WHERE id = $1
      `, [issueId])
    assert.deepEqual(entry.rows, [{
      entry_kind: 'founder_issue',
      amount_units: CREDIT_UNITS,
      founder_id: 1,
    }])
    assert.deepEqual(await accountAndLedger(postgres.client, 2), {
      balance_units: CREDIT_UNITS,
      ledger_units: CREDIT_UNITS,
    })

    await rejectsWithCode(
      postgres.client.query(
        `UPDATE city_credit_entries SET reason = 'rewritten' WHERE id = $1`,
        [issueId],
      ),
      '55000',
    )
    await rejectsWithCode(
      postgres.client.query('DELETE FROM city_credit_entries WHERE id = $1', [issueId]),
      '55000',
    )
    await rejectsWithCode(
      postgres.client.query(
        'UPDATE city_credit_accounts SET balance_units = 9000000 WHERE resident_id = 2',
      ),
      '55000',
    )
    assert.deepEqual(await accountAndLedger(postgres.client, 2), {
      balance_units: CREDIT_UNITS,
      ledger_units: CREDIT_UNITS,
    })
  })

  await t.test('concurrent different-target spends have one winner and never go negative', async () => {
    await resetFresh(postgres.client)
    await issueCredit(postgres.client, 2, 'concurrent-seed-postgres-0001')
    await insertCreditAttempt(
      postgres.client,
      'credit_concurrent_frontier_0001',
      2,
      'frontier',
      'frontier:credit-race-north',
    )
    await insertCreditAttempt(
      postgres.client,
      'credit_concurrent_kind_0000001',
      2,
      'kind_invention',
      'kind:credit-race-bell',
    )

    const results = await Promise.allSettled([
      spendCredit(
        postgres.client,
        2,
        'credit_concurrent_frontier_0001',
        'credit-spend-race-frontier-0001',
      ),
      spendCredit(
        postgres.client,
        2,
        'credit_concurrent_kind_0000001',
        'credit-spend-race-kind-000000001',
      ),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.ok(rejected?.status === 'rejected')
    assert.equal(postgresCode(rejected.reason), '23514')

    const state = await postgres.client.query<{
      spends: number
      minimum_balance: string
    }>(`
        SELECT
          (SELECT count(*)::int FROM city_credit_entries
            WHERE resident_id = 2 AND entry_kind = 'spend') AS spends,
          (SELECT balance_units::text FROM city_credit_accounts
            WHERE resident_id = 2) AS minimum_balance
      `)
    assert.deepEqual(state.rows, [{ spends: 1, minimum_balance: '0' }])
    assert.deepEqual(await accountAndLedger(postgres.client, 2), {
      balance_units: '0',
      ledger_units: '0',
    })
  })

  await t.test('one payment attempt can own only one spend', async () => {
    await resetFresh(postgres.client)
    await issueCredit(postgres.client, 2, 'attempt-spend-seed-postgres-01')
    await issueCredit(postgres.client, 2, 'attempt-spend-seed-postgres-02')
    await insertCreditAttempt(
      postgres.client,
      'credit_one_spend_attempt_00001',
      2,
      'kind_revision',
      'kind:17:credit-revision',
    )
    await spendCredit(
      postgres.client,
      2,
      'credit_one_spend_attempt_00001',
      'credit-spend-once-postgres-0001',
    )
    await rejectsWithCode(spendCredit(
      postgres.client,
      2,
      'credit_one_spend_attempt_00001',
      'credit-spend-twice-postgres-001',
    ), '23505')

    const spends = await postgres.client.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM city_credit_entries
        WHERE payment_attempt_id = 'credit_one_spend_attempt_00001'
          AND entry_kind = 'spend'
      `)
    assert.deepEqual(spends.rows, [{ count: 1 }])
    assert.deepEqual(await accountAndLedger(postgres.client, 2), {
      balance_units: CREDIT_UNITS,
      ledger_units: CREDIT_UNITS,
    })
  })
}
