import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { issueCityFeeCredit } from '../../../src/city-credit.ts'

import type { WorldTestContext } from '../../helpers/world-postgres-fixtures/harness.ts'

export async function registerRetirementConcurrencyTests(
  t: TestContext,
  {
    actor, app, assertWaitingOnDatabaseLock, bearer, database, founderSecret, moveResident,
    resetDatabase, setEngineTransactionRunnerForTests, transactionSql, withdrawThing,
  }: Pick<WorldTestContext,
    | 'actor' | 'app' | 'assertWaitingOnDatabaseLock' | 'bearer' | 'database'
    | 'founderSecret' | 'moveResident' | 'resetDatabase'
    | 'setEngineTransactionRunnerForTests' | 'transactionSql' | 'withdrawThing'
  >,
): Promise<void> {
  await t.test('retirement rechecks arrivals after its place lock before spending', async () => {
    setEngineTransactionRunnerForTests(async (_db, work) => {
      const connection = await database!.connect()
      try {
        await connection.query('BEGIN')
        const result = await work(transactionSql(connection), true)
        await connection.query('COMMIT')
        return result
      } catch (error) {
        await connection.query('ROLLBACK')
        throw error
      } finally {
        connection.release()
      }
    })
    try {
      for (const arrival of ['subplace', 'thing', 'resident'] as const) {
        const roomId = await resetDatabase()
        const withdrawn = await withdrawThing(actor, 1, 'withdrawn', 'test-object')
        assert.equal('error' in withdrawn, false)
        await issueCityFeeCredit({
          query: async (text, params = []) => (
            await database!.query(text, [...params])
          ).rows,
        }, {
          founderId: 1,
          residentId: 1,
          sourceKey: `place-retire-race-credit-${arrival}`,
          reason: `fund ${arrival} retirement race test`,
        })

        const arriving = await database!.connect()
        try {
          await arriving.query('BEGIN')
          if (arrival === 'subplace') {
            await arriving.query(`
                INSERT INTO places (parent_id, place_kind, name, description, owner_id)
                VALUES ($1, 'place', 'arriving-room', 'arrived during retirement', 1)
              `, [roomId])
          } else if (arrival === 'thing') {
            await arriving.query(`
                INSERT INTO things (id, place_id, name, body, owner_id, maker_id)
                VALUES (2, $1, 'arriving-thing', 'arrived during retirement', 1, 1)
              `, [roomId])
          } else {
            await arriving.query(`
                INSERT INTO resident_presence (resident_id, current_place_id)
                VALUES (2, $1)
              `, [roomId])
          }

          const responsePromise = app.request(`/api/place/${roomId}`, {
            method: 'PATCH',
            headers: {
              ...bearer(founderSecret),
              'content-type': 'application/json',
              'X-1F3D9-FEE-CREDIT': `place-retire-race-${arrival}-0001`,
            },
            body: JSON.stringify({ retired: true }),
          })
          let pending = false
          for (let check = 0; check < 100; check += 1) {
            const attempt = await database!.query(`
                SELECT 1 FROM payment_attempts
                WHERE operation = 'place_retire' AND status = 'payment_pending'
              `)
            if (attempt.rowCount) {
              pending = true
              break
            }
            await delay(10)
          }
          assert.equal(pending, true, `${arrival} race reached paid completion`)
          await arriving.query('COMMIT')
          const response = await responsePromise
          assert.equal(response.status, 409, await response.clone().text())
          assert.match(await response.text(), /place is not empty/iu)
        } catch (error) {
          await arriving.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          arriving.release()
        }

        const state = await database!.query(`
            SELECT place.retired_at, account.balance_units::text AS balance_units,
              (SELECT count(*)::integer FROM city_credit_entries
                WHERE resident_id = 1 AND entry_kind = 'spend') AS spends,
              (SELECT count(*)::integer FROM city_credit_entries
                WHERE resident_id = 1 AND entry_kind = 'return') AS returns
            FROM places place
            JOIN city_credit_accounts account ON account.resident_id = place.owner_id
            WHERE place.id = $1
          `, [roomId])
        assert.deepEqual(state.rows, [{
          retired_at: null,
          balance_units: '1000000',
          spends: 1,
          returns: 1,
        }])
      }
    } finally {
      setEngineTransactionRunnerForTests(null)
    }
  })

  await t.test('a move waits for retirement and then refuses the retired destination', async () => {
    const roomId = await resetDatabase()
    const originId = Number((await database!.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1',
      [roomId],
    )).rows[0]!.parent_id)
    await database!.query(`
        INSERT INTO resident_presence (resident_id, current_place_id)
        VALUES (2, $1)
      `, [originId])

    const retiring = await database!.connect()
    const moving = await database!.connect()
    try {
      await retiring.query('BEGIN')
      await retiring.query(`
          /* place-lifecycle:lock-before-recheck */
          SELECT id FROM places WHERE id = $1 FOR UPDATE
        `, [roomId])
      await retiring.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [roomId])

      await moving.query('BEGIN')
      const movingPid = Number((await moving.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0]!.pid)
      const move = moveResident(2, roomId, transactionSql(moving)).then(
        value => Object.freeze({ ok: true as const, value, error: null }),
        error => Object.freeze({ ok: false as const, value: null, error }),
      )

      await assertWaitingOnDatabaseLock(movingPid, 'resident movement')

      await retiring.query('COMMIT')
      const outcome = await move
      assert.equal(outcome.ok, false)
      assert.deepEqual(
        outcome.error && typeof outcome.error === 'object'
          ? {
            status: 'status' in outcome.error ? outcome.error.status : null,
            message: 'message' in outcome.error ? outcome.error.message : null,
          }
          : null,
        {
          status: 409,
          message: 'destination place is retired; restore it before moving there',
        },
      )
      await moving.query('ROLLBACK')
    } catch (error) {
      await retiring.query('ROLLBACK').catch(() => undefined)
      await moving.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      retiring.release()
      moving.release()
    }

    const presence = await database!.query<{ current_place_id: number }>(`
        SELECT current_place_id FROM resident_presence WHERE resident_id = 2
      `)
    assert.equal(presence.rows[0]?.current_place_id, originId)
  })
}
