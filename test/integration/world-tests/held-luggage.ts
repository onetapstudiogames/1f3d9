import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { TestContext } from 'node:test'
import type { WorldTestContext } from '../../helpers/world-postgres-fixtures/harness.ts'

const heldLuggageMigration = await readFile(
  new URL('../../../db/migrations/20260913_held_luggage.sql', import.meta.url), 'utf8',
)

export async function registerHeldLuggageTests(
  t: TestContext,
  { actor, app, assertWaitingOnDatabaseLock, bearer, database, executeEffects, founderSecret,
    insertProtectedGazetteRoom, resetDatabase,
    setEngineTransactionRunnerForTests, sql, transactionSql, withdrawThing }:
    Pick<WorldTestContext,
      'actor' | 'app' | 'assertWaitingOnDatabaseLock' | 'bearer' | 'database' |
      'executeEffects' | 'founderSecret' | 'insertProtectedGazetteRoom' | 'resetDatabase' |
      'setEngineTransactionRunnerForTests' | 'sql' | 'transactionSql' | 'withdrawThing'>,
): Promise<void> {
  const { runAction } = await import('../../../src/engine.ts')
  const run = async (
    action: 'move' | 'go_home' | 'use' | 'consume' | 'give',
    destinationPlaceId: number | null,
    carryThingId: number | null = null,
    sourceThingId: number | null = null,
    recipientId: number | null = null,
  ) => {
    setEngineTransactionRunnerForTests(async (_db, work) => {
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        const result = await work(transactionSql(client), true)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    })
    try {
      return await runAction({
        actorId: 1,
        actorHandle: 'founder',
        action,
        destinationPlaceId,
        carryThingId,
        sourceThingId,
        recipientId,
      }, sql)
    } finally {
      setEngineTransactionRunnerForTests(null)
    }
  }

  await t.test('the named held-luggage migration applies twice over the baseline', async () => {
    await resetDatabase()
    await database.query(heldLuggageMigration)
    await database.query(heldLuggageMigration)
    assert.deepEqual((await database.query(`
      SELECT count(*)::integer AS count FROM pg_trigger
      WHERE tgrelid = 'places'::regclass AND tgname = 'places_release_held_luggage'
    `)).rows, [{ count: 1 }])
    assert.deepEqual((await database.query(`
      SELECT count(*)::integer AS count FROM pg_indexes
      WHERE tablename = 'things' AND indexname = 'things_one_held_per_resident'
    `)).rows, [{ count: 1 }])
  })

  await t.test('held luggage crosses the world, follows a plain move, and becomes ordinary at home', async () => {
    const roomId = await resetDatabase()
    const continentId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [roomId],
    )).rows[0]!.parent_id)
    const worldId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [continentId],
    )).rows[0]!.parent_id)
    await database.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1) ON CONFLICT (resident_id) DO UPDATE
      SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
    `, [roomId])

    assert.equal((await run('move', continentId, 1)).status, 'applied')
    assert.equal((await run('move', worldId, 1)).status, 'applied')
    assert.deepEqual((await database.query(`
      SELECT thing.place_id, thing.held_by, presence.current_place_id
      FROM things thing JOIN resident_presence presence ON presence.resident_id = 1
      WHERE thing.id = 1
    `)).rows, [{ place_id: worldId, held_by: 1, current_place_id: worldId }])
    await assert.rejects(database.query('UPDATE things SET held_by = NULL WHERE id = 1'))
    await assert.rejects(database.query(`
      INSERT INTO notes (place_id, author_id, body) VALUES ($1, 1, 'world note')
    `, [worldId]))
    await assert.rejects(database.query(`
      INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
      VALUES ($1, 1, 1, 'add', 0)
    `, [worldId]))
    await assert.rejects(database.query(`
      UPDATE resident_presence SET home_place_id = $1 WHERE resident_id = 1
    `, [worldId]))

    const automatic = await run('move', continentId)
    assert.equal(automatic.status, 'applied')
    assert.deepEqual((await database.query(`
      SELECT thing.place_id, thing.held_by, presence.current_place_id
      FROM things thing JOIN resident_presence presence ON presence.resident_id = 1
      WHERE thing.id = 1
    `)).rows, [{ place_id: continentId, held_by: null, current_place_id: continentId }])
    assert.deepEqual((await database.query(`
      SELECT detail->>'mode' AS mode, (detail->>'thing_id')::integer AS thing_id
      FROM events WHERE kind = 'action' AND (detail->>'action_id')::integer = $1
    `, [automatic.actionId])).rows, [{ mode: 'carry', thing_id: 1 }])

    assert.equal((await run('move', worldId, 1)).status, 'applied')
    await database.query(`
      INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
      VALUES ('thing', 1, 'remove', 1, 'post-pickup test hold')
    `)
    const home = await run('go_home', null)
    assert.equal(home.status, 'applied')
    assert.deepEqual((await database.query(`
      SELECT thing.place_id, thing.held_by, presence.current_place_id
      FROM things thing JOIN resident_presence presence ON presence.resident_id = 1
      WHERE thing.id = 1
    `)).rows, [{ place_id: roomId, held_by: null, current_place_id: roomId }])
    assert.deepEqual((await database.query(`
      SELECT detail->>'mode' AS mode, (detail->>'thing_id')::integer AS thing_id
      FROM events WHERE kind = 'action' AND (detail->>'action_id')::integer = $1
    `, [home.actionId])).rows, [{ mode: 'carry', thing_id: 1 }])
  })

  await t.test('a foreign closed room holds one thing and refuses actions that would release it', async () => {
    const roomId = await resetDatabase()
    const continentId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [roomId],
    )).rows[0]!.parent_id)
    const foreignId = Number((await database.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      VALUES ($1, 'place', 'closed room', '', 2) RETURNING id
    `, [continentId])).rows[0]!.id)
    await database.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1) ON CONFLICT (resident_id) DO UPDATE
      SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
    `, [roomId])
    assert.equal((await run('move', continentId, 1)).status, 'applied')
    assert.equal((await run('move', foreignId, 1)).status, 'applied')
    assert.deepEqual((await database.query('SELECT place_id, held_by FROM things WHERE id = 1')).rows,
      [{ place_id: foreignId, held_by: 1 }])

    for (const action of ['use', 'consume', 'give'] as const) {
      const refused = await run(action, null, null, 1, action === 'give' ? 2 : null)
      assert.equal(refused.status, 'failed')
      assert.match(refused.error ?? '', /held thing cannot be left.*go home/iu)
    }
    await database.query(`
      INSERT INTO things (id, place_id, name, body, owner_id, maker_id)
      VALUES (2, $1, 'ordinary other thing', '', 1, 1)
    `, [foreignId])
    const other = await run('move', continentId, 2)
    assert.equal(other.status, 'failed')
    assert.match(other.error ?? '', /held thing cannot be left.*go home/iu)
    assert.deepEqual((await database.query(`
      SELECT current_place_id FROM resident_presence WHERE resident_id = 1
    `)).rows, [{ current_place_id: foreignId }])

    const { setLaterHolderMark, LaterHolderHeldThingError } = await import('../../../src/later-holder.ts')
    await assert.rejects(() => setLaterHolderMark(
      async (text, params) => (await database.query(text, [...params])).rows,
      1, 1, true,
    ), LaterHolderHeldThingError)
    assert.deepEqual(await withdrawThing(actor, 1, 'withdrawn', 'wrong name'), {
      error: 'thing_name does not exactly match the current name of thing_id 1; re-read the thing and send its exact current name',
      status: 409,
    })
    setEngineTransactionRunnerForTests(async (_db, work) => {
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        const result = await work(transactionSql(client), true)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    })
    try {
      const gift = await app.request('/api/transfer', {
        method: 'POST',
        headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'thing', id: 1, to_handle: 'neighbor' }),
      })
      assert.equal(gift.status, 409, await gift.clone().text())
      const offer = await app.request('/api/transfer/offer', {
        method: 'POST',
        headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'thing', id: 1, to_handle: 'neighbor',
          price_usdc: 1, seller_wallet: `0x${'1'.repeat(40)}` }),
      })
      assert.equal(offer.status, 409, await offer.clone().text())
      assert.match((await gift.json() as { error: string }).error, /held thing.*go home/iu)
      assert.match((await offer.json() as { error: string }).error, /held thing.*go home/iu)
    } finally {
      setEngineTransactionRunnerForTests(null)
    }
    assert.equal((await run('move', continentId)).status, 'applied')
    assert.deepEqual((await database.query('SELECT place_id, held_by FROM things WHERE id = 1')).rows,
      [{ place_id: continentId, held_by: null }])
  })

  await t.test('closing a room does not turn an ordinary deposited thing into held luggage', async () => {
    const roomId = await resetDatabase()
    const continentId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [roomId],
    )).rows[0]!.parent_id)
    const foreignId = Number((await database.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_things)
      VALUES ($1, 'place', 'once open', '', 2, true) RETURNING id
    `, [continentId])).rows[0]!.id)
    await database.query('UPDATE things SET place_id = $1 WHERE id = 1', [foreignId])
    await database.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $2) ON CONFLICT (resident_id) DO UPDATE
      SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
    `, [foreignId, roomId])
    await database.query('UPDATE places SET open_to_things = false WHERE id = $1', [foreignId])
    assert.equal((await run('move', continentId)).status, 'applied')
    assert.deepEqual((await database.query('SELECT place_id, held_by FROM things WHERE id = 1')).rows,
      [{ place_id: foreignId, held_by: null }])
  })

  await t.test('opening or acquiring a closed room releases held luggage permanently', async () => {
    const roomId = await resetDatabase()
    const continentId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [roomId],
    )).rows[0]!.parent_id)
    const foreignId = Number((await database.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      VALUES ($1, 'place', 'room with changing access', '', 2) RETURNING id
    `, [continentId])).rows[0]!.id)
    await database.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1) ON CONFLICT (resident_id) DO UPDATE
      SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
    `, [roomId])
    assert.equal((await run('move', continentId, 1)).status, 'applied')
    assert.equal((await run('move', foreignId, 1)).status, 'applied')
    await database.query('UPDATE places SET open_to_things = true WHERE id = $1', [foreignId])
    assert.deepEqual((await database.query('SELECT held_by FROM things WHERE id = 1')).rows, [{ held_by: null }])
    await database.query('UPDATE places SET open_to_things = false WHERE id = $1', [foreignId])
    assert.equal((await run('move', continentId)).status, 'applied')
    assert.deepEqual((await database.query('SELECT place_id, held_by FROM things WHERE id = 1')).rows,
      [{ place_id: foreignId, held_by: null }])

    await database.query('UPDATE things SET place_id = $1 WHERE id = 1', [continentId])
    await database.query('UPDATE resident_presence SET current_place_id = $1 WHERE resident_id = 1', [continentId])
    assert.equal((await run('move', foreignId, 1)).status, 'applied')
    await database.query('UPDATE places SET owner_id = 1 WHERE id = $1', [foreignId])
    assert.deepEqual((await database.query('SELECT held_by FROM things WHERE id = 1')).rows, [{ held_by: null }])
    await database.query('UPDATE places SET owner_id = 2 WHERE id = $1', [foreignId])
    assert.equal((await run('move', continentId)).status, 'applied')
    assert.deepEqual((await database.query('SELECT place_id, held_by FROM things WHERE id = 1')).rows,
      [{ place_id: foreignId, held_by: null }])
  })

  await t.test('opening a room and moving its held resident serialize on the place lock', async () => {
    const roomId = await resetDatabase()
    const continentId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [roomId],
    )).rows[0]!.parent_id)
    const closedId = Number((await database.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      VALUES ($1, 'place', 'concurrent opening', '', 2) RETURNING id
    `, [continentId])).rows[0]!.id)
    await database.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1) ON CONFLICT (resident_id) DO UPDATE
      SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
    `, [roomId])
    assert.equal((await run('move', continentId, 1)).status, 'applied')
    assert.equal((await run('move', closedId, 1)).status, 'applied')

    const opening = await database.connect()
    const moving = await database.connect()
    let pendingMove: ReturnType<typeof runAction> | null = null
    try {
      await opening.query('BEGIN')
      await opening.query('SELECT id FROM places WHERE id = $1 FOR NO KEY UPDATE', [closedId])
      await moving.query('BEGIN')
      const movingPid = Number((await moving.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0]!.pid)
      setEngineTransactionRunnerForTests(async (_db, work) => work(transactionSql(moving), true))
      pendingMove = runAction({
        actorId: 1, actorHandle: 'founder', action: 'move', destinationPlaceId: continentId,
      }, sql)
      await assertWaitingOnDatabaseLock(movingPid, 'held resident movement')
      await opening.query('UPDATE places SET open_to_things = true WHERE id = $1', [closedId])
      await opening.query('COMMIT')
      assert.equal((await pendingMove).status, 'applied')
      await moving.query('COMMIT')
      assert.deepEqual((await database.query(`
        SELECT presence.current_place_id, thing.place_id, thing.held_by
        FROM resident_presence presence JOIN things thing ON thing.id = 1
        WHERE presence.resident_id = 1
      `)).rows, [{ current_place_id: continentId, place_id: closedId, held_by: null }])
    } catch (error) {
      await opening.query('ROLLBACK').catch(() => undefined)
      await moving.query('ROLLBACK').catch(() => undefined)
      await pendingMove?.catch(() => undefined)
      throw error
    } finally {
      setEngineTransactionRunnerForTests(null)
      opening.release()
      moving.release()
    }
  })

  await t.test('the protected Gazette permits only transient held luggage', async () => {
    const roomId = await resetDatabase()
    const continentId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [roomId],
    )).rows[0]!.parent_id)
    await insertProtectedGazetteRoom(continentId)
    await database.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1) ON CONFLICT (resident_id) DO UPDATE
      SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
    `, [roomId])
    assert.equal((await run('move', continentId, 1)).status, 'applied')
    assert.equal((await run('move', 454, 1)).status, 'applied')
    assert.deepEqual((await database.query('SELECT place_id, held_by FROM things WHERE id = 1')).rows,
      [{ place_id: 454, held_by: 1 }])
    assert.deepEqual((await database.query(`
      SELECT gazette_submission_room_has_no_forbidden_contents() AS ready
    `)).rows, [{ ready: true }])
    await assert.rejects(database.query(`
      INSERT INTO things (id, place_id, name, body, owner_id, maker_id)
      VALUES (2, 454, 'ordinary', '', 1, 1)
    `))
    assert.equal((await run('move', continentId)).status, 'applied')
    assert.deepEqual((await database.query('SELECT place_id, held_by FROM things WHERE id = 1')).rows,
      [{ place_id: continentId, held_by: null }])
    assert.deepEqual((await database.query(`
      SELECT gazette_submission_room_has_no_forbidden_contents() AS ready
    `)).rows, [{ ready: true }])
  })

  await t.test('the owner withdraws a held thing in the world and a non-owner cannot', async () => {
    const roomId = await resetDatabase()
    const continentId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [roomId],
    )).rows[0]!.parent_id)
    const worldId = Number((await database.query<{ id: number }>(
      "SELECT id FROM places WHERE place_kind = 'world'",
    )).rows[0]!.id)
    await database.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1) ON CONFLICT (resident_id) DO UPDATE
      SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
    `, [roomId])
    assert.equal((await run('move', continentId, 1)).status, 'applied')
    assert.equal((await run('move', worldId, 1)).status, 'applied')
    assert.deepEqual((await database.query('SELECT place_id, held_by FROM things WHERE id = 1')).rows,
      [{ place_id: worldId, held_by: 1 }])

    assert.deepEqual(await withdrawThing({ ...actor, id: 2, handle: 'neighbor' }, 1, 'withdrawn', 'test-object'), {
      error: 'only the thing owner may withdraw it',
      status: 403,
    })
    assert.deepEqual(await withdrawThing(actor, 1, 'withdrawn', 'wrong name'), {
      error: 'thing_name does not exactly match the current name of thing_id 1; re-read the thing and send its exact current name',
      status: 409,
    })
    assert.deepEqual((await database.query('SELECT withdrawn_at, held_by FROM things WHERE id = 1')).rows,
      [{ withdrawn_at: null, held_by: 1 }])

    const withdrawn = await withdrawThing(actor, 1, 'withdrawn', 'test-object')
    assert.ok(!('error' in withdrawn), JSON.stringify(withdrawn))
    assert.equal(withdrawn.id, 1)
    assert.deepEqual((await database.query(`
      SELECT place_id, held_by, withdrawn_at IS NOT NULL AS gone FROM things WHERE id = 1
    `)).rows, [{ place_id: worldId, held_by: null, gone: true }])
    assert.deepEqual((await database.query(`
      SELECT detail->>'reason' AS reason FROM events WHERE kind = 'thing_withdrawn'
    `)).rows, [{ reason: 'withdrawn' }])
  })

  await t.test('the owner withdraws held luggage inside the protected Gazette room', async () => {
    const roomId = await resetDatabase()
    const continentId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [roomId],
    )).rows[0]!.parent_id)
    await insertProtectedGazetteRoom(continentId)
    await database.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1) ON CONFLICT (resident_id) DO UPDATE
      SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
    `, [roomId])
    assert.equal((await run('move', continentId, 1)).status, 'applied')
    assert.equal((await run('move', 454, 1)).status, 'applied')
    const withdrawn = await withdrawThing(actor, 1, 'withdrawn', 'test-object')
    assert.ok(!('error' in withdrawn), JSON.stringify(withdrawn))
    assert.deepEqual((await database.query(`
      SELECT place_id, held_by, withdrawn_at IS NOT NULL AS gone FROM things WHERE id = 1
    `)).rows, [{ place_id: 454, held_by: null, gone: true }])
    assert.deepEqual((await database.query(`
      SELECT gazette_submission_room_has_no_forbidden_contents() AS ready
    `)).rows, [{ ready: true }])
  })

  await t.test('a destroy effect ends the owner’s held thing but never a stranger’s', async () => {
    const roomId = await resetDatabase()
    const continentId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [roomId],
    )).rows[0]!.parent_id)
    const foreignId = Number((await database.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      VALUES ($1, 'place', 'destroy room', '', 2) RETURNING id
    `, [continentId])).rows[0]!.id)
    await database.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1) ON CONFLICT (resident_id) DO UPDATE
      SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
    `, [roomId])
    assert.equal((await run('move', continentId, 1)).status, 'applied')
    assert.equal((await run('move', foreignId, 1)).status, 'applied')
    const context = {
      actionId: null, actorHandle: 'founder', placeId: foreignId,
      sourceThingId: null, sharedSourceThingId: null, target: { type: 'thing' as const, id: 1 },
      destinationPlaceId: null, recipientId: null, sourceTraitId: null,
      parentEffectId: null, generation: 0, logicalAt: new Date(),
    }
    await assert.rejects(() => executeEffects([{ effect: 'destroy', target: 'target' }], {
      ...context, actorId: 2, actorHandle: 'neighbor',
      lawAuthority: { traitId: 2, sourcePlaceId: foreignId },
    }, sql), /held thing cannot be left.*go home/iu)
    assert.deepEqual((await database.query('SELECT held_by, withdrawn_at FROM things WHERE id = 1')).rows,
      [{ held_by: 1, withdrawn_at: null }])

    assert.equal(await executeEffects([{ effect: 'destroy', target: 'target' }], {
      ...context, actorId: 1, lawAuthority: null,
    }, sql), 1)
    assert.deepEqual((await database.query(`
      SELECT place_id, held_by, withdrawn_at IS NOT NULL AS gone FROM things WHERE id = 1
    `)).rows, [{ place_id: foreignId, held_by: null, gone: true }])
  })

  await t.test('a resident move effect carries its target resident’s held thing', async () => {
    const roomId = await resetDatabase()
    const continentId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [roomId],
    )).rows[0]!.parent_id)
    const closedId = Number((await database.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      VALUES ($1, 'place', 'effect origin', '', 1) RETURNING id
    `, [continentId])).rows[0]!.id)
    await database.query('INSERT INTO resident_presence (resident_id, current_place_id) VALUES (2, $1)', [closedId])
    await database.query(`
      INSERT INTO things (id, place_id, name, body, owner_id, maker_id, held_by)
      VALUES (2, $1, 'held by target', '', 2, 2, 2)
    `, [closedId])
    const applied = await executeEffects([{ effect: 'move', target: 'target', to: 'destination' }], {
      actionId: null, actorId: 1, actorHandle: 'founder', placeId: closedId,
      sourceThingId: null, sharedSourceThingId: null, target: { type: 'resident', id: 2 },
      destinationPlaceId: continentId, recipientId: null, sourceTraitId: null,
      lawAuthority: null, parentEffectId: null, generation: 0, logicalAt: new Date(),
    }, sql)
    assert.equal(applied, 1)
    assert.deepEqual((await database.query(`
      SELECT presence.current_place_id, thing.place_id, thing.held_by
      FROM resident_presence presence JOIN things thing ON thing.id = 2
      WHERE presence.resident_id = 2
    `)).rows, [{ current_place_id: continentId, place_id: continentId, held_by: 2 }])
  })

  await t.test('failed luggage arrival rolls the resident and thing back together', async () => {
    const roomId = await resetDatabase()
    const continentId = Number((await database.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1', [roomId],
    )).rows[0]!.parent_id)
    const closedId = Number((await database.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      VALUES ($1, 'place', 'rollback origin', '', 2) RETURNING id
    `, [continentId])).rows[0]!.id)
    await database.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1) ON CONFLICT (resident_id) DO UPDATE
      SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
    `, [roomId])
    assert.equal((await run('move', continentId, 1)).status, 'applied')
    assert.equal((await run('move', closedId, 1)).status, 'applied')
    await database.query(`
      CREATE FUNCTION refuse_held_exit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.held_by IS NOT NULL AND NEW.place_id IS DISTINCT FROM OLD.place_id THEN
          RAISE EXCEPTION 'arrival refused' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_held_exit BEFORE UPDATE OF place_id ON things
      FOR EACH ROW EXECUTE FUNCTION refuse_held_exit()
    `)
    const refused = await run('move', continentId)
    assert.equal(refused.status, 'failed')
    assert.deepEqual((await database.query(`
      SELECT presence.current_place_id, thing.place_id, thing.held_by
      FROM resident_presence presence JOIN things thing ON thing.id = 1
      WHERE presence.resident_id = 1
    `)).rows, [{ current_place_id: closedId, place_id: closedId, held_by: 1 }])
  })
}
