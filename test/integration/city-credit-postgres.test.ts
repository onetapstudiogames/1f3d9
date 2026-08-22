import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  beginCityCreditSpend,
  completeCityCreditAttempt,
  issueCityFeeCredit,
  readCityCreditAccount,
  returnCityCreditSpend,
  type CityCreditDatabase,
} from '../../src/city-credit.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'city_credit_integration'
const CREDIT_UNITS = '1000000'
const MIGRATION_URL = new URL('../../db/migrations/20260822_city_credit.sql', import.meta.url)
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-city-credit-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])

  try {
    const portOutput = runDocker(['port', containerName, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const client = new Pool({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: POSTGRES_DATABASE,
      ssl: false,
      max: 8,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        await client.query('SELECT 1')
        return { client, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await client.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null
}

async function rejectsWithCode(promise: Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(promise, error => postgresCode(error) === expected)
}

async function resetFresh(database: Pool): Promise<void> {
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'city-credit-test', repeat('1', 64)),
      (2, 'resident-two', 'city-credit-test', repeat('2', 64)),
      (3, 'resident-three', 'city-credit-test', repeat('3', 64))
  `)
}

function cityCreditDatabase(database: Pool): CityCreditDatabase {
  return {
    query: async (text, params = []) => (await database.query(text, [...params])).rows,
  }
}

async function issueCredit(
  database: Pool,
  residentId: number,
  sourceKey: string,
  founderId = 1,
  amountUnits = CREDIT_UNITS,
): Promise<string> {
  const issued = await database.query<{ id: string }>(`
    INSERT INTO city_credit_entries (
      resident_id, entry_kind, amount_units, founder_id, source_key, reason
    ) VALUES ($1, 'founder_issue', $2, $3, $4, 'PostgreSQL integration-test issuance')
    RETURNING id::text
  `, [residentId, amountUnits, founderId, sourceKey])
  return issued.rows[0]!.id
}

async function insertCreditAttempt(
  database: Pool,
  publicId: string,
  residentId: number,
  operation: 'frontier' | 'kind_invention' | 'kind_revision',
  targetKey: string,
  leaseOwner = `credit-lease-${publicId}`,
): Promise<void> {
  await database.query(`
    INSERT INTO payment_attempts (
      public_id, actor_id, operation, target_key,
      request_hash, request_json, method, amount_units, asset_type, asset_id,
      status, lease_owner, lease_expires_at
    ) VALUES (
      $1, $2, $3, $4,
      repeat('a', 64), jsonb_build_object('target', $4::text), 'credit', $5,
      CASE WHEN $3 = 'kind_revision' THEN 'kind' END,
      CASE WHEN $3 = 'kind_revision' THEN 3 END,
      'settling', $6, clock_timestamp() + interval '1 minute'
    )
  `, [publicId, residentId, operation, targetKey, CREDIT_UNITS, leaseOwner])
}

async function spendCredit(
  database: Pool,
  residentId: number,
  attemptId: string,
  requestId: string,
  amountUnits = CREDIT_UNITS,
): Promise<string> {
  const spent = await database.query<{ id: string }>(`
    INSERT INTO city_credit_entries (
      resident_id, entry_kind, amount_units, payment_attempt_id, request_id
    ) VALUES ($1, 'spend', $2, $3, $4)
    RETURNING id::text
  `, [residentId, amountUnits, attemptId, requestId])
  return spent.rows[0]!.id
}

async function accountAndLedger(database: Pool, residentId: number): Promise<{
  balance_units: string
  ledger_units: string
}> {
  const result = await database.query<{
    balance_units: string
    ledger_units: string
  }>(`
    SELECT account.balance_units::text,
      COALESCE(sum(CASE
        WHEN entry.entry_kind IN ('founder_issue', 'return', 'admin_credit')
          THEN entry.amount_units
        ELSE -entry.amount_units
      END), 0)::text AS ledger_units
    FROM city_credit_accounts AS account
    LEFT JOIN city_credit_entries AS entry
      ON entry.resident_id = account.resident_id
    WHERE account.resident_id = $1
    GROUP BY account.resident_id, account.balance_units
  `, [residentId])
  assert.ok(result.rows[0], `resident ${residentId} must have a credit account`)
  return result.rows[0]
}

test('city fee credit remains founder-issued, append-only, and race-safe in PostgreSQL', {
  timeout: 120_000,
}, async t => {
  assert.equal(
    existsSync(MIGRATION_URL),
    true,
    'add db/migrations/20260822_city_credit.sql before running the PostgreSQL gate',
  )
  const migrationDdl = await readFile(MIGRATION_URL, 'utf8')
  const postgres = await startPostgres()
  try {
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

    await t.test('concurrent TypeScript issuance safely replays one founder source', async () => {
      await resetFresh(postgres.client)
      const database = cityCreditDatabase(postgres.client)
      const input = {
        founderId: 1,
        residentId: 2,
        sourceKey: 'service-concurrent-issue-0001',
        reason: 'one concurrent founder accounting fact',
      }
      const issued = await Promise.all([
        issueCityFeeCredit(database, input),
        issueCityFeeCredit(database, input),
      ])
      assert.deepEqual(issued.map(result => result.disposition).sort(), ['created', 'existing'])
      const stored = await postgres.client.query<{ entries: number; balance_units: string }>(`
        SELECT count(entry.id)::int AS entries,
          coalesce(account.balance_units, 0)::text AS balance_units
        FROM residents resident
        LEFT JOIN city_credit_entries entry
          ON entry.resident_id = resident.id AND entry.source_key = $1
        LEFT JOIN city_credit_accounts account ON account.resident_id = resident.id
        WHERE resident.id = 2
        GROUP BY account.balance_units
      `, [input.sourceKey])
      assert.deepEqual(stored.rows, [{ entries: 1, balance_units: CREDIT_UNITS }])
    })

    await t.test('the TypeScript service durably binds a kind revision credit attempt to its kind', async () => {
      await resetFresh(postgres.client)
      const database = cityCreditDatabase(postgres.client)
      await issueCityFeeCredit(database, {
        founderId: 1,
        residentId: 2,
        sourceKey: 'service-kind-revision-issue-0001',
        reason: 'kind revision asset-binding integration test',
      })
      const ready = await beginCityCreditSpend(database, {
        actorId: 2,
        operation: 'kind_revision',
        targetKey: 'kind-revision:3:2',
        request: { kind_id: 3, description: 'revised with credit' },
        requestId: 'service-kind-revision-spend-0001',
        assetType: 'kind',
        assetId: 3,
      })
      assert.equal(ready.state, 'ready')
      if (ready.state !== 'ready') throw new Error('kind revision credit did not acquire its lease')

      const attempt = await postgres.client.query<{
        operation: string
        target_key: string
        asset_type: string | null
        asset_id: string | null
      }>(`
        SELECT operation, target_key, asset_type, asset_id::text
        FROM payment_attempts
        WHERE public_id = $1
      `, [ready.attempt_id])
      assert.deepEqual(attempt.rows, [{
        operation: 'kind_revision',
        target_key: 'kind-revision:3:2',
        asset_type: 'kind',
        asset_id: '3',
      }])
    })

    await t.test('the TypeScript service performs one atomic spend, replay, completion, and exact return', async () => {
      await resetFresh(postgres.client)
      const database = cityCreditDatabase(postgres.client)
      await issueCityFeeCredit(database, {
        founderId: 1,
        residentId: 2,
        sourceKey: 'service-roundtrip-issue-0001',
        reason: 'service round-trip integration test',
      })
      const frontierInput = {
        actorId: 2,
        operation: 'frontier' as const,
        targetKey: 'frontier:service-roundtrip',
        request: { name: 'service-roundtrip', parent_id: null },
        requestId: 'service-roundtrip-spend-0001',
      }
      const ready = await beginCityCreditSpend(database, frontierInput)
      assert.equal(ready.state, 'ready')
      if (ready.state !== 'ready') throw new Error('city credit spend did not acquire its lease')
      assert.equal((await readCityCreditAccount(database, 2)).balance_units, '0')
      assert.deepEqual(await beginCityCreditSpend(database, frontierInput), {
        state: 'busy',
        attempt_id: ready.attempt_id,
      })

      const completionResponse = { ok: true, place: { id: 91 } }
      await completeCityCreditAttempt(database, {
        actorId: 2,
        attemptId: ready.attempt_id,
        leaseOwner: ready.lease_owner,
        result: { kind: 'place', id: 91 },
        responseStatus: 201,
        response: completionResponse,
      })
      const completed = await beginCityCreditSpend(database, frontierInput)
      assert.equal(completed.state, 'completed')
      if (completed.state === 'completed') assert.deepEqual(completed.response, completionResponse)

      await issueCityFeeCredit(database, {
        founderId: 1,
        residentId: 2,
        sourceKey: 'service-roundtrip-issue-0002',
        reason: 'service round-trip return test',
      })
      const kindInput = {
        actorId: 2,
        operation: 'kind_invention' as const,
        targetKey: 'kind-invention:service-roundtrip',
        request: { name: 'service-roundtrip-kind' },
        requestId: 'service-roundtrip-spend-0002',
      }
      const returnReady = await beginCityCreditSpend(database, kindInput)
      assert.equal(returnReady.state, 'ready')
      if (returnReady.state !== 'ready') throw new Error('city credit return spend did not acquire its lease')
      const returned = await returnCityCreditSpend(database, {
        actorId: 2,
        attemptId: returnReady.attempt_id,
        leaseOwner: returnReady.lease_owner,
        reason: 'eligible action failed after debit',
        responseStatus: 409,
        response: { error: 'eligible action failed; city fee credit returned' },
      })
      assert.equal(returned.disposition, 'created')
      assert.equal((await returnCityCreditSpend(database, {
        actorId: 2,
        attemptId: returnReady.attempt_id,
        leaseOwner: returnReady.lease_owner,
        reason: 'eligible action failed after debit',
        responseStatus: 409,
        response: { error: 'eligible action failed; city fee credit returned' },
      })).disposition, 'existing')
      assert.equal((await beginCityCreditSpend(database, kindInput)).state, 'returned')
      assert.equal((await readCityCreditAccount(database, 2)).balance_units, CREDIT_UNITS)
    })
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
