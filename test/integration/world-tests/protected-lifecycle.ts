import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { beginCityCreditSpend, issueCityFeeCredit, returnCityCreditSpend } from '../../../src/city-credit.ts'
import type { WorldTestContext } from '../../helpers/world-postgres-fixtures/harness.ts'

export async function registerProtectedLifecycleTests(
  t: TestContext,
  {
    app, bearer, database, founderSecret, insertProtectedGazetteRoom, resetDatabase,
  }: Pick<WorldTestContext,
    | 'app' | 'bearer' | 'database' | 'founderSecret' | 'insertProtectedGazetteRoom'
    | 'resetDatabase'
  >,
): Promise<void> {
  await t.test('protected place lifecycle refusals write no fee entry', async () => {
    const roomId = await resetDatabase()
    const parent = await database!.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1',
      [roomId],
    )
    await insertProtectedGazetteRoom(parent.rows[0]!.parent_id)
    await issueCityFeeCredit({
      query: async (text, params = []) => (
        await database!.query(text, [...params])
      ).rows,
    }, {
      founderId: 1,
      residentId: 1,
      sourceKey: 'protected-place-lifecycle-credit',
      reason: 'prove protected lifecycle refusal happens before debit',
    })

    const actions = [
      { body: { name: 'Forbidden rename' }, request: 'rename' },
      { body: { retired: true }, request: 'retire' },
      { body: { retired: false }, request: 'restore' },
    ] as const
    for (const placeId of [
      Number((await database!.query<{ id: number }>(
        "SELECT id FROM places WHERE place_kind = 'world'",
      )).rows[0]!.id),
      454,
    ]) {
      for (const action of actions) {
        const response = await app.request(`/api/place/${placeId}`, {
          method: 'PATCH',
          headers: {
            ...bearer(founderSecret),
            'content-type': 'application/json',
            'X-1F3D9-FEE-CREDIT': `protected-${placeId}-${action.request}`,
          },
          body: JSON.stringify(action.body),
        })
        assert.equal(response.status, 409, await response.clone().text())
        assert.deepEqual(await response.json(), {
          error: 'place is protected and cannot be renamed, retired, or restored',
        })
      }
    }

    assert.deepEqual((await database!.query(`
        SELECT account.balance_units::text AS balance_units,
          (SELECT count(*)::integer FROM city_credit_entries entry
            WHERE entry.resident_id = 1 AND entry.entry_kind IN ('spend', 'return')) AS fee_entries,
          (SELECT count(*)::integer FROM payment_attempts attempt
            WHERE attempt.actor_id = 1
              AND attempt.operation IN ('place_rename', 'place_retire', 'place_restore')) AS attempts
        FROM city_credit_accounts account WHERE account.resident_id = 1
      `)).rows, [{ balance_units: '1000000', fee_entries: 0, attempts: 0 }])
  })

  await t.test('locked lifecycle completion refuses a protected Gazette debit without an effect', async () => {
    const { completePlaceLifecycleOperation } = await import('../../../src/place-lifecycle-operation.ts')
    const roomId = await resetDatabase()
    const parent = await database!.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1',
      [roomId],
    )
    await insertProtectedGazetteRoom(parent.rows[0]!.parent_id)
    const creditDatabase = {
      query: async (text: string, params: readonly unknown[] | unknown[] = []) => (
        await database!.query(text, [...params])
      ).rows,
      transaction: async <T>(work: (transaction: {
        query: (text: string, params?: readonly unknown[] | unknown[]) => Promise<readonly Record<string, unknown>[]>
      }) => Promise<T>): Promise<T> => {
        const connection = await database!.connect()
        try {
          await connection.query('BEGIN')
          const result = await work({
            query: async (text, params = []) => (
              await connection.query(text, [...params])
            ).rows,
          })
          await connection.query('COMMIT')
          return result
        } catch (error) {
          await connection.query('ROLLBACK')
          throw error
        } finally {
          connection.release()
        }
      },
    }
    await issueCityFeeCredit(creditDatabase, {
      founderId: 1,
      residentId: 1,
      sourceKey: 'protected-gazette-locked-credit',
      reason: 'exercise the protected Gazette locked recheck',
    })
    const requestId = 'protected-gazette-locked-rename'
    const spend = await beginCityCreditSpend(creditDatabase, {
      actorId: 1,
      operation: 'place_rename',
      targetKey: `place:454:rename:${requestId}`,
      request: { place_id: 454, name: 'Forbidden rename' },
      requestId,
      assetType: 'place',
      assetId: 454,
    })
    assert.equal(spend.state, 'ready')
    if (spend.state !== 'ready') assert.fail('protected Gazette spend was not parked for completion')

    const completion = await completePlaceLifecycleOperation(creditDatabase, {
      attemptId: spend.attempt_id,
      leaseOwner: spend.lease_owner,
    })
    assert.deepEqual(completion, {
      state: 'target_changed',
      attemptId: spend.attempt_id,
      reason: 'place is protected and cannot be renamed, retired, or restored',
    })
    await returnCityCreditSpend(creditDatabase, {
      actorId: 1,
      attemptId: spend.attempt_id,
      leaseOwner: spend.lease_owner,
      reason: completion.reason,
      responseStatus: 409,
      response: { error: completion.reason },
    })

    assert.deepEqual((await database!.query(`
        SELECT place.name, place.retired_at,
          account.balance_units::text AS balance_units,
          (SELECT count(*)::integer FROM city_credit_entries entry
            WHERE entry.resident_id = 1 AND entry.entry_kind = 'spend') AS spends,
          (SELECT count(*)::integer FROM city_credit_entries entry
            WHERE entry.resident_id = 1 AND entry.entry_kind = 'return') AS returns,
          (SELECT count(*)::integer FROM events event
            WHERE event.kind IN ('place_renamed', 'place_retired', 'place_restored')) AS lifecycle_events
        FROM places place
        JOIN city_credit_accounts account ON account.resident_id = place.owner_id
        WHERE place.id = 454
      `)).rows, [{
      name: 'the gazette submission room',
      retired_at: null,
      balance_units: '1000000',
      spends: 1,
      returns: 1,
      lifecycle_events: 0,
    }])
  })
}
