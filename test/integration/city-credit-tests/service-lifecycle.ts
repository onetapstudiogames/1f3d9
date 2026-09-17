import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import {
  beginCityCreditSpend,
  completeCityCreditAttempt,
  issueCityFeeCredit,
  readCityCreditAccount,
  returnCityCreditSpend,
} from '../../../src/city-credit.ts'
import { CREDIT_REQUEST_ID_RECORDED_CONFLICT_PENDING } from '../../../src/city-fee-facts.ts'
import { canonicalPaymentRequest } from '../../../src/payment-attempts.ts'
import { CREDIT_UNITS } from '../../helpers/city-credit-postgres-fixtures/ledger.ts'
import { cityCreditDatabase } from '../../helpers/city-credit-postgres-fixtures/service-database.ts'

export async function registerServiceLifecycleTests(
  t: TestContext,
  postgres: { client: Pool },
  resetFresh: (database: Pool) => Promise<void>,
): Promise<void> {
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

  await t.test('an action recorded under a number-shaped request id says what it can do, then finishes on a fresh id', async () => {
    const attemptId = 'credit_attempt_number_shaped_000001'
    const recorded = canonicalPaymentRequest({ name: 'service-number-shaped', parent_id: null })
    const liveInput = {
      actorId: 2,
      operation: 'frontier' as const,
      targetKey: 'frontier:service-number-shaped',
      request: { name: 'service-number-shaped', parent_id: null },
      requestId: 'fee-service-number-shaped-0001',
    }
    // History: `1.000000` is what `me` printed, so it reached the ledger before the
    // rule that now refuses it. The resident can no longer send that id at all.
    const recordPending = async (startedAgo: string) => {
      await resetFresh(postgres.client)
      await issueCityFeeCredit(cityCreditDatabase(postgres.client), {
        founderId: 1,
        residentId: 2,
        sourceKey: 'service-number-shaped-issue-0001',
        reason: 'a pending spend recorded before the new-id rule existed',
      })
      await postgres.client.query(`
        WITH recovery AS (
          SELECT statement_timestamp() - $4::interval AS started_at
        )
        INSERT INTO payment_attempts (
          public_id, actor_id, operation, target_key,
          request_hash, request_json, method, amount_units, status,
          recovery_started_at, recovery_deadline_at
        )
        SELECT $1, 2, 'frontier', 'frontier:service-number-shaped',
          $2, $3::jsonb, 'credit', 1000000, 'payment_pending',
          recovery.started_at, recovery.started_at + interval '2 hours'
        FROM recovery
      `, [attemptId, recorded.hash, recorded.json, startedAgo])
      await postgres.client.query(`
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, request_id, payment_attempt_id
        ) VALUES (2, 'spend', 1000000, '1.000000', $1)
      `, [attemptId])
      return cityCreditDatabase(postgres.client)
    }

    const live = await recordPending('1 minute')
    await assert.rejects(beginCityCreditSpend(live, liveInput), (error: unknown) => {
      assert.equal(
        error instanceof Error ? error.message : '',
        CREDIT_REQUEST_ID_RECORDED_CONFLICT_PENDING,
      )
      return true
    })
    assert.equal((await readCityCreditAccount(live, 2)).balance_units, '0')

    // Past its deadline the recorded credit returns on its own, and a fresh id works.
    const expired = await recordPending('2 hours 1 second')
    const later = await beginCityCreditSpend(expired, liveInput)
    assert.equal(later.state, 'ready')
    if (later.state !== 'ready') throw new Error('the returned credit did not start a fresh attempt')
    assert.notEqual(later.attempt_id, attemptId)
    assert.equal((await readCityCreditAccount(expired, 2)).balance_units, '0')

    const ledger = await postgres.client.query<{ spends: number; returns: number }>(`
      SELECT count(*) FILTER (WHERE entry_kind = 'spend')::int AS spends,
        count(*) FILTER (WHERE entry_kind = 'return')::int AS returns
      FROM city_credit_entries WHERE resident_id = 2
    `)
    assert.deepEqual(ledger.rows, [{ spends: 2, returns: 1 }], 'exactly one credit stays spent')
  })
}
