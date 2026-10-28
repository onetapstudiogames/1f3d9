import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  bearer, connectedDatabase, resetCity, standIn, startNoteSuiteDatabase, withNoteSuiteQueryObserver,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = Object.freeze(Array.from({ length: 8 }, (_, index) => Object.freeze({
  id: index === 3 ? 14 : index + 1, handle: `writer-${index + 1}`,
  secret: `1f3d9_sk_${String(index + 1).repeat(48)}`,
})))

async function waitForLock(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await connectedDatabase().query(`SELECT 1 FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ~ $1`, [pattern])
    if (result.rows.length > 0) return
    await delay(10)
  }
  const active = (await connectedDatabase().query(`SELECT wait_event_type, wait_event, left(query, 600) AS query
    FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle'`)).rows
  assert.fail(`the writer did not reach its lock: ${pattern}; ${JSON.stringify(active)}`)
}

function paymentDatabase() {
  const db = connectedDatabase()
  return {
    query: async (text: string, values: readonly unknown[] = []) => (await db.query(text, [...values])).rows,
    transaction: async <T>(work: (database: { query: (text: string, values?: readonly unknown[]) =>
      Promise<Record<string, unknown>[]> }) => Promise<T>) => {
      const connection = await db.connect()
      try {
        await connection.query('BEGIN')
        const result = await work({ query: async (text, values = []) =>
          (await connection.query(text, [...values])).rows })
        await connection.query('COMMIT')
        return result
      } catch (error) {
        await connection.query('ROLLBACK')
        throw error
      } finally { connection.release() }
    },
  }
}

test('direct public writers share the resident then room lock order', { timeout: 240_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('public-activity-writers')
  try {
    const { default: app } = await import('../../src/index.ts')
    const { runAction } = await import('../../src/engine.ts')
    const { beginCityCreditSpend, issueCityFeeCredit } = await import('../../src/city-credit.ts')
    const { completePlaceLifecycleOperation } = await import('../../src/place-lifecycle-operation.ts')
    const request = (id: number, path: string, body: unknown, method = 'POST') =>
      Promise.resolve(app.request(`http://city.test${path}`, {
        method, headers: bearer(RESIDENTS[id - 1]!.secret), body: JSON.stringify(body),
      }))

    await t.test('thing editing and movement cannot acquire the same actor and room in reverse order', async () => {
      const rooms = await resetCity(RESIDENTS)
      const db = connectedDatabase()
      await standIn(1, rooms.eastRoomId)
      const thing = (await db.query(`INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'edited thing', '', 1, 1) RETURNING id`, [rooms.eastRoomId])).rows[0].id
      await db.query(`CREATE FUNCTION pause_test_thing() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(1973102); RETURN NEW; END $$;
        CREATE TRIGGER pause_test_thing BEFORE UPDATE ON things
          FOR EACH ROW EXECUTE FUNCTION pause_test_thing()`)
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973102)')
      const editing = request(1, `/api/thing/${thing}`, { body: 'edited public body' }, 'PATCH')
      let moving: ReturnType<typeof runAction> | undefined
      try {
        await waitForLock('activity_actor')
        moving = runAction({ actorId: 1, actorHandle: RESIDENTS[0]!.handle, action: 'move',
          placeId: rooms.eastRoomId, destinationPlaceId: rooms.continentId })
        await waitForLock('SELECT[[:space:]]+id[[:space:]]+FROM[[:space:]]+residents')
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973102)')
        barrier.release()
        await Promise.allSettled([editing, moving])
      }
      const edited = await editing
      assert.equal(edited.status, 200, await edited.text())
      const moved = await moving
      assert.equal(moved?.status, 'applied', moved?.error ?? '')
    })

    await t.test('paid place completion and movement take the resident before the place', async () => {
      const rooms = await resetCity(RESIDENTS)
      const db = connectedDatabase()
      await standIn(1, rooms.eastRoomId)
      const paymentDb = paymentDatabase()
      await issueCityFeeCredit(paymentDb, { founderId: 1, residentId: 1,
        sourceKey: 'writer-place-credit', reason: 'prove completion ordering' })
      const spend = await beginCityCreditSpend(paymentDb, { actorId: 1, operation: 'place_rename',
        targetKey: `place:${rooms.eastRoomId}:rename:writer-place-rename`,
        assetType: 'place', assetId: rooms.eastRoomId,
        request: { place_id: rooms.eastRoomId, name: 'Completed Room' }, requestId: 'writer-place-rename' })
      assert.equal(spend.state, 'ready')
      if (spend.state !== 'ready') assert.fail('the credit was not ready')
      await db.query(`CREATE FUNCTION pause_test_place() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.name <> OLD.name THEN PERFORM pg_advisory_xact_lock(1973103); END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER pause_test_place BEFORE UPDATE ON places
          FOR EACH ROW EXECUTE FUNCTION pause_test_place()`)
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973103)')
      const completion = completePlaceLifecycleOperation(paymentDb,
        { attemptId: spend.attempt_id, leaseOwner: spend.lease_owner })
      let moving: ReturnType<typeof runAction> | undefined
      try {
        await waitForLock('place-lifecycle:complete')
        moving = runAction({ actorId: 1, actorHandle: RESIDENTS[0]!.handle, action: 'move',
          placeId: rooms.eastRoomId, destinationPlaceId: rooms.continentId })
        await waitForLock('SELECT[[:space:]]+id[[:space:]]+FROM[[:space:]]+residents|INSERT INTO action_runs')
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973103)')
        barrier.release()
        await Promise.allSettled([completion, moving])
      }
      assert.equal((await completion).state, 'completed')
      const moved = await moving
      assert.equal(moved?.status, 'applied', moved?.error ?? '')
      assert.equal((await db.query('SELECT name FROM places WHERE id = $1', [rooms.eastRoomId])).rows[0].name,
        'Completed Room')
    })

    await t.test('eight mixed applied writers finish and stamp every responsible resident', async () => {
      const rooms = await resetCity(RESIDENTS)
      const db = connectedDatabase()
      await db.query(`UPDATE places SET open_to_building = true, open_to_things = true
        WHERE id = $1`, [rooms.eastRoomId])
      for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)
      const things = (await db.query(`INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'edit me', '', 1, 1), ($1, 'withdraw me', '', 2, 2) RETURNING id`,
      [rooms.eastRoomId])).rows
      const queryFailures: unknown[] = []
      const activeQueries = new Map<number, string>()
      const write = (id: number, path: string, body: unknown, method = 'POST') =>
        withNoteSuiteQueryObserver(statement => {
          activeQueries.set(id, statement)
          return statement
        }, () => request(id, path, body, method), () => { activeQueries.delete(id) }, (error, statement) => {
            const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {}
            queryFailures.push({ writer: id, path, statement,
              message: error instanceof Error ? error.message : String(error),
              code: failure.code, detail: failure.detail, where: failure.where,
              active: [...activeQueries].map(([writer, query]) => ({ writer, query })) })
          })
      const responses = await Promise.all([
        write(1, `/api/thing/${things[0].id}`, { body: 'changed' }, 'PATCH'),
        write(2, `/api/thing/${things[1].id}/withdraw`, { thing_name: 'withdraw me' }),
        write(3, '/api/note', { place_id: rooms.eastRoomId, body: 'a concurrent note' }),
        write(4, '/api/thing', { place_id: rooms.eastRoomId, name: 'made together', body: '' }),
        write(5, '/api/trait', { name: 'concurrent-trait', description: 'a plain trait' }),
        write(6, '/api/line', { place_id: rooms.eastRoomId, body: 'a concurrent line',
          request_id: '8b7fcb8c-4325-46a9-bbe4-cee78609c10e' }),
        write(7, '/api/flag', { target_type: 'thing', target_id: things[0].id, reason: 'a public report' }),
        write(8, '/api/place', { parent_id: rooms.eastRoomId, name: 'Made Together Room' }),
      ])
      assert.deepEqual(queryFailures, [], JSON.stringify(queryFailures, null, 2))
      for (const [index, response] of responses.entries()) {
        assert.ok(response.ok, `writer ${index + 1}, ${response.status}: ${await response.text()}`)
      }
      const stamps = (await db.query('SELECT id, last_public_action_at FROM residents ORDER BY id')).rows
      assert.equal(stamps.length, 8)
      assert.ok(stamps.every(row => row.last_public_action_at !== null))
      assert.ok((await db.query('SELECT last_public_action_at FROM places WHERE id = $1',
        [rooms.eastRoomId])).rows[0].last_public_action_at)
    })

    await t.test('a note receipt cannot deadlock with a thing maker already holding the room', async () => {
      const rooms = await resetCity(RESIDENTS)
      const db = connectedDatabase()
      await db.query('UPDATE places SET open_to_things = true WHERE id = $1', [rooms.eastRoomId])
      await standIn(3, rooms.eastRoomId)
      await standIn(14, rooms.eastRoomId)
      const queryFailures: unknown[] = []
      const failed = (writer: string) => (error: unknown, statement: string) => {
        const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {}
        queryFailures.push({ writer, statement, message: error instanceof Error ? error.message : String(error),
          code: failure.code, detail: failure.detail, where: failure.where })
      }
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973106)')
      const making = withNoteSuiteQueryObserver(statement =>
        /WITH permitted_place AS/.test(statement) && /quota_spend AS/.test(statement)
          ? statement.replace('SELECT place.id',
            'SELECT place.id, pg_advisory_xact_lock(1973106) AS before_make')
          : statement,
      () => request(4, '/api/thing', { place_id: rooms.eastRoomId, name: 'ordered making', body: '' }),
      undefined, failed('maker'))
      let writing: Promise<Response> | undefined
      try {
        await waitForLock('pg_advisory_xact_lock\\(1973106\\)')
        writing = withNoteSuiteQueryObserver(statement => statement,
          () => request(3, '/api/note', { place_id: rooms.eastRoomId, body: 'ordered note receipt' }),
          undefined, failed('note'))
        await waitForLock('ORDER BY planned.depth, planned.id FOR NO KEY UPDATE OF place')
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973106)')
        barrier.release()
        await Promise.allSettled([making, writing])
      }
      const responses = await Promise.all([making, writing!])
      assert.deepEqual(queryFailures, [], JSON.stringify(queryFailures, null, 2))
      for (const response of responses) assert.equal(response.status, 201, await response.text())
      assert.deepEqual((await db.query(`SELECT id FROM residents
        WHERE id IN (3, 14) AND last_public_action_at IS NOT NULL ORDER BY id`)).rows, [{ id: 3 }, { id: 14 }])
      assert.ok((await db.query('SELECT last_public_action_at FROM places WHERE id = $1',
        [rooms.eastRoomId])).rows[0].last_public_action_at)
    })

    await t.test('ordinary note replay does not acquire rooms or create another action', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(3, rooms.eastRoomId)
      const { runTalkNoteAction } = await import('../../src/note-action.ts')
      const input = { residentId: 3, residentHandle: RESIDENTS[2]!.handle,
        placeId: rooms.eastRoomId, text: 'one ordinary note' }
      const first = await runTalkNoteAction(input)
      assert.ok(first.ok)
      if (!first.ok) assert.fail('the original note must be written')
      const statements: string[] = []
      const replay = await withNoteSuiteQueryObserver(statement => {
        statements.push(statement)
        return statement
      }, () => runTalkNoteAction(input))
      assert.ok(replay.ok)
      if (!replay.ok) assert.fail('the original note must replay')
      assert.equal(replay.replayed, true)
      assert.deepEqual(replay.note, first.note)
      assert.ok(statements.every(statement => !/FOR NO KEY UPDATE OF place|INSERT INTO action_runs/.test(statement)))
      assert.equal((await connectedDatabase().query('SELECT count(*)::int AS count FROM action_runs')).rows[0].count, 1)
    })

    await t.test('paid continent completion locks the later-numbered world before its older child', async () => {
      const rooms = await resetCity(RESIDENTS)
      const db = connectedDatabase()
      const originalWorld = Number((await db.query(`SELECT id FROM places WHERE place_kind = 'world'`)).rows[0].id)
      // Build the valid legacy topology left by the world-root migration.
      await db.query(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE places SET id = 10000 WHERE place_kind = 'world';
        UPDATE places SET parent_id = 10000 WHERE parent_id = ${originalWorld}; COMMIT`)
      assert.ok(10000 > rooms.continentId)
      const paymentDb = paymentDatabase()
      await issueCityFeeCredit(paymentDb, { founderId: 1, residentId: 1,
        sourceKey: 'legacy-world-credit', reason: 'prove room ordering' })
      const spend = await beginCityCreditSpend(paymentDb, { actorId: 1, operation: 'place_rename',
        targetKey: `place:${rooms.continentId}:rename:legacy-world-rename`,
        assetType: 'place', assetId: rooms.continentId,
        request: { place_id: rooms.continentId, name: 'Legacy Ordered Continent' }, requestId: 'legacy-world-rename' })
      assert.equal(spend.state, 'ready')
      if (spend.state !== 'ready') assert.fail('the credit was not ready')
      const worldBarrier = await db.connect()
      const childProbe = await db.connect()
      await worldBarrier.query('BEGIN')
      await worldBarrier.query('SELECT id FROM places WHERE id = 10000 FOR NO KEY UPDATE')
      const completing = completePlaceLifecycleOperation(paymentDb,
        { attemptId: spend.attempt_id, leaseOwner: spend.lease_owner })
      try {
        await waitForLock('place-lifecycle:lock-public-activity')
        await childProbe.query('BEGIN')
        await childProbe.query('SELECT id FROM places WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [rooms.continentId])
        await childProbe.query('COMMIT')
      } finally {
        await childProbe.query('ROLLBACK')
        childProbe.release()
        await worldBarrier.query('ROLLBACK')
        worldBarrier.release()
        await Promise.allSettled([completing])
      }
      assert.equal((await completing).state, 'completed')
    })

    await t.test('feed changes lock an affected author before the room they share', async () => {
      const rooms = await resetCity(RESIDENTS)
      const db = connectedDatabase()
      await standIn(3, rooms.eastRoomId)
      const note = await request(3, '/api/note', { place_id: rooms.eastRoomId, body: 'before the feed change' })
      assert.equal(note.status, 201, await note.text())
      await db.query(`CREATE FUNCTION pause_test_feed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.feed IS DISTINCT FROM OLD.feed THEN PERFORM pg_advisory_xact_lock(1973104); END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER pause_test_feed BEFORE UPDATE ON places
          FOR EACH ROW EXECUTE FUNCTION pause_test_feed()`)
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973104)')
      const changing = request(1, `/api/place/${rooms.eastRoomId}`, { quiet: true, feed: true }, 'PATCH')
      let moving: ReturnType<typeof runAction> | undefined
      try {
        await waitForLock('activity_actor')
        moving = runAction({ actorId: 3, actorHandle: RESIDENTS[2]!.handle, action: 'move',
          placeId: rooms.eastRoomId, destinationPlaceId: rooms.continentId })
        await waitForLock('SELECT[[:space:]]+id[[:space:]]+FROM[[:space:]]+residents')
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973104)')
        barrier.release()
        await Promise.allSettled([changing, moving])
      }
      const changed = await changing
      assert.equal(changed.status, 200, await changed.text())
      const moved = await moving
      assert.equal(moved?.status, 'applied', moved?.error ?? '')
    })

    await t.test('initial visibility locks work before the stored marker migration', async () => {
      const rooms = await resetCity(RESIDENTS)
      const db = connectedDatabase()
      const { lockPublicActivityInvalidation } = await import('../../src/public-activity-locks.ts')
      await db.query(`ALTER TABLE residents DROP COLUMN last_public_action_at CASCADE;
        ALTER TABLE residents DROP COLUMN show_activity CASCADE;
        ALTER TABLE places DROP COLUMN last_public_action_at CASCADE;
        DROP FUNCTION public_activity_invalidation_scope(integer,text,integer) CASCADE`)
      const locks: Array<{ resident_ids: number[]; place_ids: number[] }> = []
      await lockPublicActivityInvalidation(async (text, values = []) => {
        const result = await db.query(text, [...values])
        if (Array.isArray(result.rows[0].resident_ids)) locks.push(result.rows[0])
        return result
      }, 1, 'place', rooms.eastRoomId)
      assert.deepEqual(locks, Array(2).fill({ resident_ids: [1], place_ids: [rooms.eastRoomId] }))
    })

    await t.test('a new author committed during the room wait restarts before the feed mutation', async () => {
      const rooms = await resetCity(RESIDENTS)
      const db = connectedDatabase()
      await standIn(3, rooms.eastRoomId)
      await db.query(`CREATE FUNCTION pause_first_history() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.kind = 'note' THEN PERFORM pg_advisory_xact_lock(1973105); END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER pause_first_history BEFORE INSERT ON events
          FOR EACH ROW EXECUTE FUNCTION pause_first_history()`)
      const firstBarrier = await db.connect()
      const validationBarrier = await db.connect()
      await firstBarrier.query('SELECT pg_advisory_lock(1973105)')
      await validationBarrier.query('SELECT pg_advisory_lock(1973106)')
      const note = request(3, '/api/note', { place_id: rooms.eastRoomId, body: 'the new author first history' })
      let changing: Promise<Response> | undefined
      let moving: ReturnType<typeof runAction> | undefined
      let acquisitions = 0
      let validations = 0
      try {
        await waitForLock('WITH place_state')
        changing = withNoteSuiteQueryObserver(statement => {
          if (statement.includes('/* public activity acquire */')) acquisitions += 1
          if (statement.includes('/* public activity validate */')) {
            validations += 1
            if (validations === 1) return statement.replace('WITH',
              'WITH test_pause AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973106)),') + ' FROM test_pause'
          }
          return statement
        }, () => request(1, `/api/place/${rooms.eastRoomId}`, { quiet: true, feed: true }, 'PATCH'))
        await waitForLock('public activity acquire')
        await firstBarrier.query('SELECT pg_advisory_unlock(1973105)')
        const written = await note
        assert.equal(written.status, 201, await written.text())
        await waitForLock('public activity validate')
        moving = runAction({ actorId: 3, actorHandle: RESIDENTS[2]!.handle, action: 'move',
          placeId: rooms.eastRoomId, destinationPlaceId: rooms.continentId })
        await waitForLock('WITH RECURSIVE tree')
      } finally {
        await firstBarrier.query('SELECT pg_advisory_unlock(1973105)')
        await validationBarrier.query('SELECT pg_advisory_unlock(1973106)')
        firstBarrier.release()
        validationBarrier.release()
        await Promise.allSettled([note, changing, moving])
      }
      const changed = await changing
      assert.equal(changed?.status, 200, await changed?.text())
      assert.equal((await moving)?.status, 'applied')
      assert.equal(acquisitions, 2, 'the complete transaction must restart with the new author included')
      assert.equal((await db.query(`SELECT count(*)::int AS count FROM events WHERE kind = 'place_edited'`)).rows[0].count, 1)
    })

    await t.test('a founder payment repair reserves its actor before the public checkpoint', async () => {
      const rooms = await resetCity(RESIDENTS)
      const db = connectedDatabase()
      await standIn(1, rooms.eastRoomId)
      const { deliveredGift } = await import('../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts')
      const { dispute } = await import('../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts')
      const { applyPayPalCreditDispute, resolveFounderPayPalCreditDispute } =
        await import('../../src/paypal-credit-dispute.ts')
      const paymentDb = { query: async (text: string, values: readonly unknown[] = []) =>
        (await db.query(text, [...values])).rows }
      const gift = await deliveredGift(paymentDb, 3)
      await applyPayPalCreditDispute(paymentDb, dispute({ eventId: 'WH-WRITER-REPAIR',
        eventKind: 'CUSTOMER.DISPUTE.RESOLVED', disputeId: 'PP-D-WRITER-REPAIR',
        captureId: gift.captureId, updateTime: '2026-08-28T01:00:00.000Z', outcomeCode: 'RESOLVED_WITH_PAYOUT' }))
      await db.query(`CREATE FUNCTION pause_test_repair() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.kind = 'payment_repair' THEN PERFORM pg_advisory_xact_lock(1973107); END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER zzzz_pause_test_repair AFTER INSERT ON events
          FOR EACH ROW EXECUTE FUNCTION pause_test_repair()`)
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973107)')
      const repairing = resolveFounderPayPalCreditDispute(paymentDb,
        { founderId: 1, disputeId: 'PP-D-WRITER-REPAIR', decision: 'seller_favour' })
      let moving: ReturnType<typeof runAction> | undefined
      try {
        await waitForLock('paypal-credit:founder-dispute-resolution')
        moving = runAction({ actorId: 1, actorHandle: RESIDENTS[0]!.handle, action: 'move',
          placeId: rooms.eastRoomId, destinationPlaceId: rooms.continentId })
        await waitForLock('SELECT[[:space:]]+id[[:space:]]+FROM[[:space:]]+residents')
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973107)')
        barrier.release()
        await Promise.allSettled([repairing, moving])
      }
      assert.equal((await repairing).disposition, 'created')
      assert.equal((await moving)?.status, 'applied')
      assert.equal((await resolveFounderPayPalCreditDispute(paymentDb,
        { founderId: 1, disputeId: 'PP-D-WRITER-REPAIR', decision: 'seller_favour' })).disposition, 'existing')
    })
  } finally {
    await postgres.stop()
  }
})
