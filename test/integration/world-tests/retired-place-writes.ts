import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { issueCityFeeCredit } from '../../../src/city-credit.ts'
import type { CraftSql } from '../../../src/crafting.ts'
import type { WorldTestContext } from '../../helpers/world-postgres-fixtures/harness.ts'

export async function registerRetiredPlaceWritesTests(
  t: TestContext,
  {
    actor, app, assertWaitingOnDatabaseLock, bearer, craftKindThing, database,
    executeEffects, founderSecret, makeThingThroughEngine, resetDatabase,
    setEngineTransactionRunnerForTests, transactionSql,
  }: Pick<WorldTestContext,
    | 'actor' | 'app' | 'assertWaitingOnDatabaseLock' | 'bearer' | 'craftKindThing'
    | 'database' | 'executeEffects' | 'founderSecret' | 'makeThingThroughEngine'
    | 'resetDatabase' | 'setEngineTransactionRunnerForTests' | 'transactionSql'
  >,
): Promise<void> {
  await t.test('thing movement and making wait for retirement and leave no partial writes', async t => {
    await t.test('an effect-driven thing move waits and refuses', async () => {
      const roomId = await resetDatabase()
      const originId = Number((await database!.query<{ parent_id: number }>(
        'SELECT parent_id FROM places WHERE id = $1',
        [roomId],
      )).rows[0]!.parent_id)
      await database!.query('UPDATE things SET place_id = $1 WHERE id = 1', [originId])

      const retiring = await database!.connect()
      const moving = await database!.connect()
      try {
        await retiring.query('BEGIN')
        await retiring.query('SELECT id FROM places WHERE id = $1 FOR UPDATE', [roomId])
        await retiring.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [roomId])
        await moving.query('BEGIN')
        const movingPid = Number((await moving.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid)
        const move = executeEffects([{
          effect: 'move', target: 'source', to: 'destination',
        }], {
          actionId: null,
          actorId: 1,
          actorHandle: 'founder',
          placeId: originId,
          sourceThingId: 1,
          sharedSourceThingId: null,
          target: null,
          destinationPlaceId: roomId,
          recipientId: null,
          sourceTraitId: null,
          lawAuthority: null,
          parentEffectId: null,
          generation: 0,
          logicalAt: new Date(),
        }, transactionSql(moving)).then(
          value => Object.freeze({ ok: true as const, value, error: null }),
          error => Object.freeze({ ok: false as const, value: null, error }),
        )
        await assertWaitingOnDatabaseLock(movingPid, 'effect-driven thing movement')
        await retiring.query('COMMIT')
        const outcome = await move
        assert.equal(outcome.ok, false)
        assert.match(String(outcome.error), /destination place is retired; restore it before moving a thing there/iu)
        await moving.query('ROLLBACK')
      } catch (error) {
        await retiring.query('ROLLBACK').catch(() => undefined)
        await moving.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        retiring.release()
        moving.release()
      }

      const unchanged = await database!.query(`
          SELECT thing.place_id,
            (SELECT count(*)::integer FROM events WHERE kind = 'thing_moved') AS move_events
          FROM things thing WHERE thing.id = 1
        `)
      assert.deepEqual(unchanged.rows, [{ place_id: originId, move_events: 0 }])
    })

    await t.test('typed crafting waits and refuses before quota or output changes', async () => {
      const roomId = await resetDatabase()
      const kindId = Number((await database!.query<{ id: number }>(`
          INSERT INTO kinds (name, owner_id, current_revision)
          VALUES ('retirement-race-kind', 1, 1)
          RETURNING id
        `)).rows[0]!.id)
      await database!.query(`
          INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
          VALUES ($1, 1, '', '{}', '[]')
        `, [kindId])

      const retiring = await database!.connect()
      const making = await database!.connect()
      try {
        await retiring.query('BEGIN')
        await retiring.query('SELECT id FROM places WHERE id = $1 FOR UPDATE', [roomId])
        await retiring.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [roomId])
        await making.query('BEGIN')
        const makingPid = Number((await making.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid)
        const crafted = craftKindThing(transactionSql(making) as unknown as CraftSql, {
          actor,
          kindId,
          placeId: roomId,
          name: 'must-not-be-crafted',
          body: '',
          openToUse: false,
          ingredientIds: [],
        })
        await assertWaitingOnDatabaseLock(makingPid, 'typed crafting')
        await retiring.query('COMMIT')
        assert.deepEqual(await crafted, {
          ok: false,
          status: 409,
          error: 'place is retired; restore it before making things there',
        })
        await making.query('ROLLBACK')
      } catch (error) {
        await retiring.query('ROLLBACK').catch(() => undefined)
        await making.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        retiring.release()
        making.release()
      }

      const unchanged = await database!.query(`
          SELECT resident.things_today,
            (SELECT count(*)::integer FROM things WHERE name = 'must-not-be-crafted') AS outputs
          FROM residents resident WHERE resident.id = 1
        `)
      assert.deepEqual(unchanged.rows, [{ things_today: 0, outputs: 0 }])
    })

    await t.test('kindless making waits and refuses before quota or output changes', async () => {
      const roomId = await resetDatabase()
      await database!.query(`
          INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
          VALUES (1, $1, $1)
        `, [roomId])
      const retiring = await database!.connect()
      setEngineTransactionRunnerForTests(async (_db, work) => {
        const connection = await database!.connect()
        try {
          await connection.query('BEGIN')
          const result = await work(transactionSql(connection), true)
          await connection.query('COMMIT')
          return result
        } catch (error) {
          await connection.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          connection.release()
        }
      })
      try {
        await retiring.query('BEGIN')
        await retiring.query('SELECT id FROM places WHERE id = $1 FOR UPDATE', [roomId])
        await retiring.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [roomId])
        let settled = false
        const making = makeThingThroughEngine({
          actor,
          placeId: roomId,
          name: 'must-not-be-made',
          body: '',
          kindId: null,
          ingredientIds: [],
        }).then(result => {
          settled = true
          return result
        })
        await delay(100)
        assert.equal(settled, false, 'kindless making did not wait for retirement')
        await retiring.query('COMMIT')
        assert.deepEqual(await making, {
          ok: false,
          status: 409,
          error: 'place is retired; restore it before making things there',
        })
      } catch (error) {
        await retiring.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        setEngineTransactionRunnerForTests(null)
        retiring.release()
      }

      const unchanged = await database!.query(`
          SELECT resident.things_today,
            (SELECT count(*)::integer FROM things WHERE name = 'must-not-be-made') AS outputs
          FROM residents resident WHERE resident.id = 1
        `)
      assert.deepEqual(unchanged.rows, [{ things_today: 0, outputs: 0 }])
    })
  })

  await t.test('place lifecycle fails closed before spending when its migration is absent', async () => {
    const roomId = await resetDatabase()
    await issueCityFeeCredit({
      query: async (text, params = []) => (
        await database!.query(text, [...params])
      ).rows,
    }, {
      founderId: 1,
      residentId: 1,
      sourceKey: 'place-lifecycle-missing-schema-credit',
      reason: 'prove lifecycle rollout fails before spending',
    })
    await database!.query('DROP TABLE place_name_history CASCADE')

    const response = await app.request(`/api/place/${roomId}`, {
      method: 'PATCH',
      headers: {
        ...bearer(founderSecret),
        'content-type': 'application/json',
        'X-1F3D9-FEE-CREDIT': 'place-lifecycle-missing-schema-0001',
      },
      body: JSON.stringify({ name: 'must-not-change' }),
    })
    assert.equal(response.status, 503, await response.clone().text())
    assert.deepEqual(await response.json(), {
      error: 'place rename, retire, and restore are unavailable until the place lifecycle migration has run',
    })
    const unchanged = await database!.query<{
      name: string
      balance_units: string
      spends: number
    }>(`
        SELECT place.name, account.balance_units::text,
          (SELECT count(*)::integer FROM city_credit_entries
            WHERE resident_id = 1 AND entry_kind = 'spend') AS spends
        FROM places place
        JOIN city_credit_accounts account ON account.resident_id = place.owner_id
        WHERE place.id = $1
      `, [roomId])
    assert.deepEqual(unchanged.rows, [{ name: 'test-room', balance_units: '1000000', spends: 0 }])
  })
}
