import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  bearer, connectedDatabase, resetCity, standIn, startNoteSuiteDatabase,
  withNoteSuiteQueryObserver,
} from '../helpers/note-suite-fixtures/postgres.ts'

const OWNER = Object.freeze({ id: 1, handle: 'activity-owner', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const READER = Object.freeze({ id: 3, handle: 'activity-reader', secret: `1f3d9_sk_${'3'.repeat(48)}` })

async function wakeThing(placeId: number, effects: readonly unknown[], suffix = 'one', trigger = 'wake'): Promise<number> {
  const db = connectedDatabase()
  const trait = `activity-wake-${suffix}`
  await db.query(`INSERT INTO traits (name, description, recipe, coiner_id)
    VALUES ($1, 'a test clock', $2::jsonb, 1)`, [trait, JSON.stringify({
    [trigger]: trigger === 'wake' ? { on: ['clock'], every_seconds: 10, then: effects } : effects,
  })])
  const kind = (await db.query(`INSERT INTO kinds (name, owner_id)
    VALUES ($1, 1) RETURNING id`, [`activity-kind-${suffix}`])).rows[0].id
  await db.query(`INSERT INTO kind_revisions (kind_id, revision, traits)
    VALUES ($1, 1, ARRAY[$2]::text[])`, [kind, trait])
  const thing = (await db.query(`INSERT INTO things
    (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision, wake_enabled)
    VALUES ($1, $2, '', 1, 1, $3, 1, 1, true) RETURNING id`, [placeId, trait, kind])).rows[0].id
  await db.query(`INSERT INTO thing_wake_state (thing_id, clock_at)
    VALUES ($1, now() - interval '11 seconds')`, [thing])
  return Number(thing)
}

async function waitForDatabaseLock(pattern: string): Promise<void> {
  const db = connectedDatabase()
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = (await db.query(`SELECT 1 FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ~ $1`, [pattern])).rows
    if (rows.length > 0) return
    await delay(10)
  }
  assert.fail(`the concurrent request did not reach its expected lock: ${pattern}`)
}

test('public activity follows changed work committed by each wake try', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('public-activity-stamps')
  try {
    const { settleRoom } = await import('../../src/engine-settle.ts')
    const { default: app } = await import('../../src/index.ts')

    await t.test('a committed label keeps its own carrier when the final summary fails', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const thingId = await wakeThing(rooms.eastRoomId,
        [{ effect: 'label', target: 'source', label: 'committed-clock-label' }])
      let summaryBlocked = false
      const crashDb = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.reduce((text, part, index) =>
          text + part + (index < values.length ? `$${index + 1}` : ''), '')
        if (/INSERT INTO events/u.test(statement) && /'room_settled'/u.test(statement)) {
          summaryBlocked = true
          throw new Error('test interruption after the try committed')
        }
        return (await db.query(statement, values)).rows
      }, { query: async (statement: string, values: readonly unknown[] = []) =>
        (await db.query(statement, [...values])).rows })
      await settleRoom(rooms.eastRoomId, 'me', READER.id, crashDb)
      assert.equal(summaryBlocked, true)
      assert.equal((await db.query(`SELECT count(*)::int AS count FROM active_labels
        WHERE label = 'committed-clock-label'`)).rows[0].count, 1)
      assert.deepEqual((await db.query(`SELECT status, effects_applied FROM wake_tries
        WHERE thing_id = $1`, [thingId])).rows, [{ status: 'woke', effects_applied: 1 }])
      const events = (await db.query(`SELECT actor, detail FROM events
        WHERE kind = 'wake_try_applied' ORDER BY id`)).rows
      assert.equal(events.length, 1, 'each committed public wake change needs its event in that try')
      assert.equal(events[0].actor, OWNER.handle)
      assert.deepEqual(events[0].detail.applied_public_activity,
        [{ actor: OWNER.handle, operation: 'label', place_id: rooms.eastRoomId,
          target_type: 'thing', target_id: thingId }])
      assert.equal((await db.query(`SELECT count(*)::int AS count FROM events
        WHERE kind = 'room_settled'`)).rows[0].count, 0)
      const stamps = (await db.query(`SELECT id, last_public_action_at FROM residents ORDER BY id`)).rows
      assert.ok(stamps.find(row => row.id === OWNER.id)?.last_public_action_at)
      assert.equal(stamps.find(row => row.id === READER.id)?.last_public_action_at, null)
      assert.ok((await db.query('SELECT last_public_action_at FROM places WHERE id = $1',
        [rooms.eastRoomId])).rows[0].last_public_action_at)
    })

    await t.test('same-room movement records an explicit empty changed outcome', async () => {
      const rooms = await resetCity([OWNER, READER])
      await standIn(OWNER.id, rooms.eastRoomId)
      const response = await app.request('http://city.test/api/action', {
        method: 'POST', headers: bearer(OWNER.secret),
        body: JSON.stringify({ action: 'move', to_place_id: rooms.eastRoomId }),
      })
      assert.equal(response.status, 200, await response.text())
      const event = (await connectedDatabase().query(`SELECT detail FROM events
        WHERE kind = 'action' ORDER BY id DESC LIMIT 1`)).rows[0]
      assert.deepEqual(event.detail.applied_public_activity, [])
    })

    await t.test('a repeated home selection and unchanged empty laws prove no change', async () => {
      const rooms = await resetCity([OWNER, READER])
      await standIn(OWNER.id, rooms.eastRoomId)
      const { setHomeAndRecordEvent } = await import('../../src/actions.ts')
      await setHomeAndRecordEvent(OWNER, rooms.eastRoomId)
      await setHomeAndRecordEvent(OWNER, rooms.eastRoomId)
      const home = (await connectedDatabase().query(`SELECT detail FROM events
        WHERE kind = 'home_set' ORDER BY id DESC LIMIT 1`)).rows[0]
      assert.deepEqual(home.detail.applied_public_activity, [])
      const response = await app.request(`http://city.test/api/place/${rooms.eastRoomId}/laws`, {
        method: 'PUT', headers: bearer(OWNER.secret), body: JSON.stringify({ traits: [] }),
      })
      assert.equal(response.status, 200, await response.text())
      const laws = (await connectedDatabase().query(`SELECT detail FROM events
        WHERE kind = 'laws_changed' ORDER BY id DESC LIMIT 1`)).rows[0]
      assert.deepEqual(laws.detail.applied_public_activity, [])
      await connectedDatabase().query(`INSERT INTO traits (name, description, recipe, coiner_id)
        VALUES ('unchanged-law', 'a repeated law', '{"use":[]}'::jsonb, 1)`)
      const setLaws = async () => app.request(`http://city.test/api/place/${rooms.eastRoomId}/laws`, {
        method: 'PUT', headers: bearer(OWNER.secret), body: JSON.stringify({ traits: ['unchanged-law'] }),
      })
      assert.equal((await setLaws()).status, 200)
      const before = (await connectedDatabase().query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0]
      assert.equal((await setLaws()).status, 200)
      assert.deepEqual((await connectedDatabase().query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0], before)
      assert.deepEqual((await connectedDatabase().query(`SELECT detail FROM events
        WHERE kind = 'laws_changed' ORDER BY id DESC LIMIT 1`)).rows[0].detail.applied_public_activity, [])
    })

    await t.test('same-room concurrent writers finish without a shared-place stamp lock cycle', async () => {
      const rooms = await resetCity([OWNER, READER])
      await standIn(OWNER.id, rooms.eastRoomId)
      await standIn(READER.id, rooms.eastRoomId)
      const responses = await Promise.all([OWNER, READER].map(resident =>
        app.request('http://city.test/api/note', {
          method: 'POST', headers: bearer(resident.secret),
          body: JSON.stringify({ place_id: rooms.eastRoomId, body: `a note by ${resident.handle}` }),
        })))
      for (const response of responses) assert.equal(response.status, 201, await response.text())
      const residents = (await connectedDatabase().query(`SELECT id, last_public_action_at
        FROM residents ORDER BY id`)).rows
      assert.ok(residents.every(resident => resident.last_public_action_at !== null))
    })

    await t.test('a later failed try and its summary cannot undo or advance the first committed stamp', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const thingId = await wakeThing(rooms.eastRoomId,
        [{ effect: 'label', target: 'source', label: 'first-try-only' }])
      await db.query(`UPDATE thing_wake_state SET clock_at = now() - interval '21 seconds'
        WHERE thing_id = $1`, [thingId])
      await db.query(`CREATE FUNCTION reject_second_test_label() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM active_labels WHERE label = 'first-try-only') THEN
            RAISE EXCEPTION 'test second try interruption';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_second_test_label BEFORE INSERT ON active_labels
          FOR EACH ROW EXECUTE FUNCTION reject_second_test_label()`)
      await settleRoom(rooms.eastRoomId, 'me', READER.id)
      assert.deepEqual((await db.query(`SELECT status FROM wake_tries WHERE thing_id = $1
        ORDER BY unit_index`, [thingId])).rows.map(row => row.status), ['woke', 'failed'])
      const carrier = (await db.query(`SELECT at FROM events WHERE kind = 'wake_try_applied'`)).rows
      assert.equal(carrier.length, 1)
      const owner = (await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0]
      const room = (await db.query('SELECT last_public_action_at FROM places WHERE id = $1', [rooms.eastRoomId])).rows[0]
      assert.deepEqual(owner.last_public_action_at, carrier[0].at)
      assert.deepEqual(room.last_public_action_at, carrier[0].at)
      assert.equal((await db.query(`SELECT count(*)::int AS count FROM events
        WHERE kind = 'room_settled'`)).rows[0].count, 1)
      await db.query(`INSERT INTO events (kind, actor, detail) VALUES
        ('room_settled', $1, $2::jsonb)`, [READER.handle,
        JSON.stringify({ place_id: rooms.eastRoomId, status: 'woke', woke: 1 })])
      assert.deepEqual((await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0], owner)
      assert.deepEqual((await db.query('SELECT last_public_action_at FROM places WHERE id = $1', [rooms.eastRoomId])).rows[0], room)
    })

    await t.test('an aborted first try leaves no public effect, carrier or stamp', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const thingId = await wakeThing(rooms.eastRoomId,
        [{ effect: 'label', target: 'source', label: 'rolled-back-label' }])
      await db.query(`CREATE FUNCTION abort_first_test_try() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status = 'woke' THEN RAISE EXCEPTION 'test first try interruption'; END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER abort_first_test_try BEFORE INSERT ON wake_tries
          FOR EACH ROW EXECUTE FUNCTION abort_first_test_try()`)
      await settleRoom(rooms.eastRoomId, 'me', READER.id)
      assert.deepEqual((await db.query('SELECT status FROM wake_tries WHERE thing_id = $1', [thingId])).rows,
        [{ status: 'failed' }])
      assert.equal((await db.query('SELECT count(*)::int AS count FROM active_labels')).rows[0].count, 0)
      assert.equal((await db.query(`SELECT count(*)::int AS count FROM events WHERE kind = 'wake_try_applied'`)).rows[0].count, 0)
      assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0].last_public_action_at, null)
      assert.equal((await db.query('SELECT last_public_action_at FROM places WHERE id = $1', [rooms.eastRoomId])).rows[0].last_public_action_at, null)
    })

    await t.test('a no-op wake try records no public activity', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const thingId = await wakeThing(rooms.eastRoomId, [{ effect: 'check_label', target: 'source',
        label: 'absent-label', then: [{ effect: 'label', target: 'source', label: 'never-applied' }] }])
      await settleRoom(rooms.eastRoomId, 'me', READER.id)
      assert.deepEqual((await db.query('SELECT status FROM wake_tries WHERE thing_id = $1', [thingId])).rows,
        [{ status: 'quiet' }])
      assert.equal((await db.query(`SELECT count(*)::int AS count FROM events WHERE kind = 'wake_try_applied'`)).rows[0].count, 0)
      assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0].last_public_action_at, null)
    })

    await t.test('me attributes real due work to its owner even when the reader owns it', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      await standIn(OWNER.id, rooms.eastRoomId)
      await wakeThing(rooms.eastRoomId, [{ effect: 'label', target: 'source', label: 'owner-read-work' }])
      const response = await app.request('http://city.test/api/me', { headers: bearer(OWNER.secret) })
      assert.equal(response.status, 200, await response.text())
      assert.ok((await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0].last_public_action_at)
      assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id = 3')).rows[0].last_public_action_at, null)
    })

    await t.test('a refused move preserves independently committed due work without stamping its reader', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      await standIn(READER.id, rooms.eastRoomId)
      await wakeThing(rooms.eastRoomId, [{ effect: 'label', target: 'source', label: 'before-refusal' }])
      const response = await app.request('http://city.test/api/action', {
        method: 'POST', headers: bearer(READER.secret),
        body: JSON.stringify({ action: 'move', to_place_id: rooms.westRoomId }),
      })
      assert.equal(response.status, 403, await response.text())
      assert.ok((await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0].last_public_action_at)
      assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id = 3')).rows[0].last_public_action_at, null)
    })

    await t.test('caller savepoint rollback discards collected public effects with the changed rows', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const { runAction, EngineError } = await import('../../src/engine.ts')
      await standIn(OWNER.id, rooms.eastRoomId)
      const thingId = await wakeThing(rooms.eastRoomId,
        [{ effect: 'label', target: 'source', label: 'savepoint-label' }], 'savepoint', 'talk')
      const outcome = await runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'talk',
        sourceThingId: thingId, placeId: rooms.eastRoomId, primitiveHandledByCaller: true,
        primitiveEmitsTypedEvent: true, performPrimitive: async () => {
          throw new EngineError(409, 'test primitive changed before the note was left')
        } })
      assert.equal(outcome.status, 'failed')
      assert.equal((await db.query('SELECT count(*)::int AS count FROM active_labels')).rows[0].count, 0)
      assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0].last_public_action_at, null)
    })

    await t.test('a typed withdrawal and an uncovered label both survive in their own public records', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      await standIn(OWNER.id, rooms.eastRoomId)
      const thingId = await wakeThing(rooms.eastRoomId,
        [{ effect: 'label', target: 'source', label: 'before-withdrawal' },
          { effect: 'destroy', target: 'source' }], 'mixed', 'use')
      const response = await app.request('http://city.test/api/action', {
        method: 'POST', headers: bearer(OWNER.secret), body: JSON.stringify({ action: 'use', thing_id: thingId }),
      })
      assert.equal(response.status, 200, await response.text())
      const events = (await db.query(`SELECT kind, detail FROM events WHERE kind IN ('action', 'thing_withdrawn') ORDER BY id`)).rows
      assert.deepEqual(events.map(event => event.kind), ['thing_withdrawn', 'action'])
      assert.deepEqual(events[1].detail.applied_public_activity.map((entry: { operation: string }) => entry.operation), ['label'])
      assert.ok((await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0].last_public_action_at)
    })

    await t.test('moving another resident and their held thing stamps only the responsible owner', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const { runAction } = await import('../../src/engine.ts')
      await standIn(OWNER.id, rooms.eastRoomId)
      await standIn(READER.id, rooms.eastRoomId)
      const thingId = await wakeThing(rooms.eastRoomId,
        [{ effect: 'move', target: 'target', to: 'destination' }], 'move-reader', 'use')
      const luggage = (await db.query(`INSERT INTO things (place_id, name, body, owner_id, maker_id, held_by)
        VALUES ($1, 'held reader luggage', '', 3, 3, 3) RETURNING id`, [rooms.eastRoomId])).rows[0].id
      const outcome = await runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'use',
        sourceThingId: thingId, placeId: rooms.eastRoomId, destinationPlaceId: rooms.continentId,
        target: { type: 'resident', id: READER.id } })
      assert.equal(outcome.status, 'applied', outcome.error ?? '')
      const carried = (await db.query(`SELECT actor, detail FROM events WHERE kind = 'thing_moved'
        AND (detail->>'thing_id')::integer = $1`, [luggage])).rows[0]
      assert.equal(carried.actor, READER.handle)
      assert.equal(carried.detail.applied_public_activity[0].actor, OWNER.handle)
      assert.ok((await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0].last_public_action_at)
      assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id = 3')).rows[0].last_public_action_at, null)
      assert.ok((await db.query('SELECT last_public_action_at FROM places WHERE id = $1', [rooms.continentId])).rows[0].last_public_action_at)
    })

    await t.test('a resident move effect and a room use reserve the room before presence', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const { runAction } = await import('../../src/engine.ts')
      await standIn(OWNER.id, rooms.eastRoomId)
      await standIn(READER.id, rooms.eastRoomId)
      const source = await wakeThing(rooms.eastRoomId,
        [{ effect: 'move', target: 'target', to: 'destination' }], 'presence-lock', 'use')
      const member = await wakeThing(rooms.eastRoomId,
        [{ effect: 'label', target: 'source', label: 'used-while-present' }], 'presence-use', 'use')
      await db.query('UPDATE things SET owner_id = 3 WHERE id = $1', [member])
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973103)')
      const move = withNoteSuiteQueryObserver(statement => {
        if (!statement.includes('SELECT current_place_id AS place_id FROM resident_presence')) return statement
        return `WITH held_presence_barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973103)) ${statement}`
          .replace('FROM resident_presence', 'FROM resident_presence CROSS JOIN held_presence_barrier')
      }, () => runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'use',
        sourceThingId: source, placeId: rooms.eastRoomId, destinationPlaceId: rooms.eastRoomId,
        target: { type: 'resident', id: READER.id } }))
      let use: ReturnType<typeof runAction> | undefined
      try {
        await waitForDatabaseLock('held_presence_barrier')
        use = runAction({ actorId: READER.id, actorHandle: READER.handle, action: 'use',
          sourceThingId: member, placeId: rooms.eastRoomId })
        await waitForDatabaseLock('planned.depth')
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973103)')
        barrier.release()
      }
      for (const outcome of await Promise.all([move, use])) {
        assert.equal(outcome?.status, 'applied', outcome?.error ?? '')
      }
      assert.equal((await db.query(`SELECT count(*)::integer AS count FROM active_labels
        WHERE target_type = 'thing' AND target_id = $1`, [member])).rows[0].count, 1)
    })

    await t.test('an adjacent copy reserves its destination before a room edit reaches the public checkpoint', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const { runAction } = await import('../../src/engine.ts')
      await standIn(OWNER.id, rooms.eastRoomId)
      await db.query(`UPDATE places SET owner_id = 3, allow_arriving_copies = true,
        growth_cap_per_day = 100, growth_share_per_family = 100 WHERE id = $1`, [rooms.continentId])
      const source = await wakeThing(rooms.eastRoomId, [
        { effect: 'write', key: 'copies', op: 'set', value: 1 },
        { effect: 'copy', to: 'adjacent', copies: 1, generations: 1, inherit: [] },
      ], 'adjacent-lock', 'use')
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973104)')
      const copy = withNoteSuiteQueryObserver(statement => {
        if (!statement.includes('coalesce(thing.family_id, thing.id) AS family_id')) return statement
        return `WITH held_copy_barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973104)) ${statement}`
          .replace('FROM things thing', 'FROM things thing CROSS JOIN held_copy_barrier')
      }, () => runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'use',
        sourceThingId: source, placeId: rooms.eastRoomId }))
      let edit: Promise<Response> | undefined
      try {
        await waitForDatabaseLock('held_copy_barrier')
        edit = Promise.resolve(app.request(`http://city.test/api/place/${rooms.continentId}`, {
          method: 'PATCH', headers: bearer(READER.secret), body: JSON.stringify({ description: 'edited beside a copy' }),
        }))
        await waitForDatabaseLock('activity_actor')
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973104)')
        barrier.release()
      }
      const copied = await copy
      assert.equal(copied.status, 'applied', copied.error ?? '')
      const edited = await edit
      assert.equal(edited?.status, 200, edited ? await edited.text() : '')
      assert.equal((await db.query('SELECT count(*)::integer AS count FROM things WHERE parent_thing_id = $1', [source])).rows[0].count, 1)
    })

    await t.test('a new adjacent copy candidate after the room snapshot retries before drawing', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const { runAction } = await import('../../src/engine.ts')
      const { ensureChanceDays } = await import('../../src/engine-chance.ts')
      await ensureChanceDays()
      await standIn(OWNER.id, rooms.eastRoomId)
      await db.query(`UPDATE places SET allow_arriving_copies = true,
        growth_cap_per_day = 100, growth_share_per_family = 100 WHERE id = $1`, [rooms.continentId])
      const source = await wakeThing(rooms.eastRoomId,
        [{ effect: 'copy', to: 'adjacent', copies: 1, generations: 1, inherit: [] }], 'new-neighbor', 'use')
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973105)')
      let firstRoomPlan = true
      const copy = withNoteSuiteQueryObserver(statement => {
        if (!firstRoomPlan || !statement.includes('WITH RECURSIVE tree AS')) return statement
        firstRoomPlan = false
        return statement.replace('WITH RECURSIVE tree AS',
          'WITH RECURSIVE held_candidate_barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973105)), tree AS')
          .replace('FROM places place JOIN planned', 'FROM places place CROSS JOIN held_candidate_barrier JOIN planned')
      }, () => runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'use',
        sourceThingId: source, placeId: rooms.eastRoomId }))
      try {
        await waitForDatabaseLock('held_candidate_barrier')
        await db.query(`INSERT INTO places (parent_id, place_kind, name, description, owner_id,
          allow_arriving_copies, growth_cap_per_day, growth_share_per_family)
          VALUES ($1, 'place', 'new copy neighbor', '', 3, true, 100, 100)`, [rooms.eastRoomId])
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973105)')
        barrier.release()
      }
      const outcome = await copy
      assert.equal(outcome.status, 'failed')
      assert.equal(outcome.error, 'another action changed the same records; retry')
      assert.equal((await db.query('SELECT count(*)::integer AS count FROM things WHERE parent_thing_id = $1', [source])).rows[0].count, 0)
      assert.equal((await db.query(`SELECT count(*)::integer AS count FROM events WHERE kind = 'chance_rolled'`)).rows[0].count, 0)
    })

    await t.test('room planning keeps one copy draw and its sorted destination choice', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const { runAction } = await import('../../src/engine.ts')
      const { ensureChanceDays } = await import('../../src/engine-chance.ts')
      await ensureChanceDays()
      await standIn(OWNER.id, rooms.eastRoomId)
      await db.query(`UPDATE places SET allow_arriving_copies = true,
        growth_cap_per_day = 100, growth_share_per_family = 100 WHERE id = $1`, [rooms.continentId])
      const child = (await db.query(`INSERT INTO places (parent_id, place_kind, name, description, owner_id,
        allow_arriving_copies, growth_cap_per_day, growth_share_per_family)
        VALUES ($1, 'place', 'second copy neighbor', '', 3, true, 100, 100) RETURNING id`, [rooms.eastRoomId])).rows[0].id
      const source = await wakeThing(rooms.eastRoomId,
        [{ effect: 'copy', to: 'adjacent', copies: 1, generations: 1, inherit: [] }], 'copy-draw', 'use')
      const action = await runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'use',
        sourceThingId: source, placeId: rooms.eastRoomId })
      assert.equal(action.status, 'applied', action.error ?? '')
      const rolls = (await db.query('SELECT purpose, sides, roll, outcome FROM chance_rolls ORDER BY id')).rows
      assert.equal(rolls.length, 1)
      assert.equal(rolls[0].purpose, 'copy_place')
      assert.equal(rolls[0].sides, 2)
      assert.equal(rolls[0].outcome, 'counted')
      const ordered = [rooms.continentId, child].sort((left, right) => left - right)
      assert.equal((await db.query('SELECT place_id FROM things WHERE parent_thing_id = $1', [source])).rows[0].place_id,
        ordered[rolls[0].roll - 1])
    })

    await t.test('a shared source upgraded after the room plan retries without running a stale recipe', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const { runAction } = await import('../../src/engine.ts')
      await standIn(READER.id, rooms.eastRoomId)
      const source = await wakeThing(rooms.eastRoomId,
        [{ effect: 'label', target: 'source', label: 'old-source-recipe' }], 'source-refresh', 'use')
      const kindId = (await db.query('UPDATE things SET open_to_use = true WHERE id = $1 RETURNING kind_id', [source])).rows[0].kind_id
      await db.query(`INSERT INTO traits (name, description, recipe, coiner_id)
        VALUES ('new-source-recipe', '', $1::jsonb, 1)`, [JSON.stringify({ use:
        [{ effect: 'label', target: 'source', label: 'new-source-recipe' }] })])
      await db.query(`INSERT INTO kind_revisions (kind_id, revision, traits)
        VALUES ($1, 2, ARRAY['new-source-recipe']::text[])`, [kindId])
      await db.query('UPDATE kinds SET current_revision = 2 WHERE id = $1', [kindId])
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973110)')
      let firstRoomPlan = true
      const use = withNoteSuiteQueryObserver(statement => {
        if (!firstRoomPlan || !statement.includes('WITH RECURSIVE tree AS')) return statement
        firstRoomPlan = false
        return statement.replace('WITH RECURSIVE tree AS',
          'WITH RECURSIVE held_source_plan AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973110)), tree AS')
          .replace('FROM places place JOIN planned', 'FROM places place CROSS JOIN held_source_plan JOIN planned')
      }, () => runAction({ actorId: READER.id, actorHandle: READER.handle, action: 'use',
        sourceThingId: source, placeId: rooms.eastRoomId }))
      try {
        await waitForDatabaseLock('held_source_plan')
        const upgraded = await app.request(`http://city.test/api/thing/${source}/upgrade`, {
          method: 'POST', headers: bearer(OWNER.secret), body: '{}',
        })
        assert.equal(upgraded.status, 200, await upgraded.text())
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973110)')
        barrier.release()
      }
      const outcome = await use
      assert.equal(outcome.status, 'failed')
      assert.equal(outcome.error, 'another action changed the same records; retry')
      assert.equal((await db.query('SELECT count(*)::integer AS count FROM active_labels')).rows[0].count, 0)
      assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id = 3')).rows[0].last_public_action_at, null)
    })

    await t.test('a resident move home reserves the beneficiary home before a room edit', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const { runAction } = await import('../../src/engine.ts')
      await standIn(OWNER.id, rooms.eastRoomId)
      await standIn(READER.id, rooms.eastRoomId)
      await db.query('UPDATE places SET owner_id = 3 WHERE id = $1', [rooms.westRoomId])
      await db.query('UPDATE resident_presence SET home_place_id = $1 WHERE resident_id = 3', [rooms.westRoomId])
      const source = await wakeThing(rooms.eastRoomId, [
        { effect: 'write', key: 'homeward', op: 'set', value: 1 },
        { effect: 'move', target: 'target', to: 'home' },
      ], 'beneficiary-home', 'use')
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973106)')
      const move = withNoteSuiteQueryObserver(statement => {
        if (!statement.includes('SELECT current_place_id AS place_id FROM resident_presence')) return statement
        return `WITH held_home_barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973106)) ${statement}`
          .replace('FROM resident_presence', 'FROM resident_presence CROSS JOIN held_home_barrier')
      }, () => runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'use',
        sourceThingId: source, placeId: rooms.eastRoomId, target: { type: 'resident', id: READER.id } }))
      let edit: Promise<Response> | undefined
      try {
        await waitForDatabaseLock('held_home_barrier')
        edit = Promise.resolve(app.request(`http://city.test/api/place/${rooms.westRoomId}`, {
          method: 'PATCH', headers: bearer(READER.secret), body: JSON.stringify({ description: 'a home edited during arrival' }),
        }))
        await waitForDatabaseLock('activity_actor')
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973106)')
        barrier.release()
      }
      const moved = await move
      assert.equal(moved.status, 'applied', moved.error ?? '')
      const edited = await edit
      assert.equal(edited?.status, 200, edited ? await edited.text() : '')
      assert.equal((await db.query('SELECT current_place_id FROM resident_presence WHERE resident_id = 3')).rows[0].current_place_id, rooms.westRoomId)
    })

    await t.test('a reach and a member use reserve the room before their things', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const { runAction } = await import('../../src/engine.ts')
      await standIn(OWNER.id, rooms.eastRoomId)
      await standIn(READER.id, rooms.eastRoomId)
      const source = await wakeThing(rooms.eastRoomId, [{ effect: 'reach', over: 'things', max: 20,
        then: [{ effect: 'label', target: 'target', label: 'reached-concurrently' }] }], 'reach-lock', 'use')
      const member = await wakeThing(rooms.eastRoomId,
        [{ effect: 'label', target: 'source', label: 'used-concurrently' }], 'member-lock', 'use')
      await db.query('UPDATE things SET owner_id = 3 WHERE id = $1', [member])
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973102)')
      const reach = withNoteSuiteQueryObserver(statement => {
        if (!statement.includes('count(*) OVER () AS total') || !statement.includes('FROM things thing')) return statement
        return `WITH held_test_barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973102)) ${statement}`
          .replace('FROM things thing', 'FROM things thing CROSS JOIN held_test_barrier')
      }, () => runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'use',
        sourceThingId: source, placeId: rooms.eastRoomId }))
      let use: ReturnType<typeof runAction> | undefined
      try {
        await waitForDatabaseLock('held_test_barrier')
        use = runAction({ actorId: READER.id, actorHandle: READER.handle, action: 'use',
          sourceThingId: member, placeId: rooms.eastRoomId })
        await waitForDatabaseLock('planned.depth')
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973102)')
        barrier.release()
      }
      const outcomes = await Promise.all([reach, use])
      for (const outcome of outcomes) assert.equal(outcome?.status, 'applied', outcome?.error ?? '')
      assert.equal((await db.query(`SELECT count(*)::integer AS count FROM active_labels
        WHERE target_type = 'thing' AND target_id = $1`, [member])).rows[0].count, 2)
      assert.equal((await db.query(`SELECT count(*)::integer AS count FROM residents
        WHERE id IN (1, 3) AND last_public_action_at IS NOT NULL`)).rows[0].count, 2)
    })

    await t.test('an immediate constraint mode records the applied action and stamps before commit', async () => {
      const rooms = await resetCity([OWNER, READER])
      await standIn(OWNER.id, rooms.eastRoomId)
      const { runAction, withEngineTransaction, engineSql } = await import('../../src/engine.ts')
      await withEngineTransaction(engineSql, async transaction => {
        await transaction`SET CONSTRAINTS ALL IMMEDIATE`
        const action = await runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'move',
          placeId: rooms.eastRoomId, destinationPlaceId: rooms.continentId }, transaction)
        assert.equal(action.status, 'applied', action.error ?? '')
        const stamps = await transaction`SELECT last_public_action_at FROM residents WHERE id = 1` as
          Array<{ last_public_action_at: unknown }>
        assert.ok(stamps[0]?.last_public_action_at)
      })
    })

    await t.test('a standalone state clear reserves its room before its thing and public event', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const { runAction, engineSql } = await import('../../src/engine.ts')
      const { clearStateBox } = await import('../../src/engine-state.ts')
      await standIn(OWNER.id, rooms.eastRoomId)
      const target = await wakeThing(rooms.eastRoomId,
        [{ effect: 'label', target: 'source', label: 'changed-after-clear' }], 'state-clear', 'use')
      await db.query('UPDATE things SET state = $1::jsonb WHERE id = $2', [JSON.stringify({ count: 1 }), target])
      await db.query(`CREATE FUNCTION hold_test_state_clear() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.state IS DISTINCT FROM OLD.state THEN PERFORM pg_advisory_xact_lock(1973107); END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER hold_test_state_clear BEFORE UPDATE ON things
          FOR EACH ROW EXECUTE FUNCTION hold_test_state_clear()`)
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973107)')
      const clear = clearStateBox(target, OWNER.id, engineSql)
      const clearResult = clear.then(version => ({ version }), (error: unknown) => ({ error }))
      let use: ReturnType<typeof runAction> | undefined
      try {
        await waitForDatabaseLock('activity_actor|UPDATE things SET state')
        use = runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'use',
          sourceThingId: target, placeId: rooms.eastRoomId })
        await waitForDatabaseLock('SELECT id FROM residents|FROM things WHERE id = ANY')
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973107)')
        barrier.release()
      }
      const result = await use
      assert.equal(result?.status, 'applied', result?.error ?? '')
      assert.deepEqual(await clearResult, { version: 1 })
      assert.deepEqual((await db.query('SELECT state FROM things WHERE id = $1', [target])).rows[0].state, {})
    })

    await t.test('a Gazette submission and its printer reserve the room before their print lock', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      const { engineSql, runAction } = await import('../../src/engine.ts')
      const { GAZETTE_FIRST_PRINT_AT, printGazetteIssuesDue } = await import('../../src/gazette.ts')
      await db.query(`INSERT INTO places (id, parent_id, place_kind, name, description, purpose, owner_id,
        open_to_building, open_to_things, open_to_notes)
        VALUES (454, $1, 'place', 'the gazette submission room',
          'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
          '', 1, false, false, false)`, [rooms.continentId])
      await db.query(await readFile(new URL('../../db/migrations/20260827_gazette_room_activation.sql', import.meta.url), 'utf8'))
      await standIn(READER.id, 454)
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973108)')
      let firstActorLock = true
      const note = withNoteSuiteQueryObserver(statement => {
        if (!firstActorLock || !statement.includes('SELECT id FROM residents') || !statement.includes('FOR NO KEY UPDATE')) return statement
        firstActorLock = false
        return `WITH held_gazette_barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973108)) ${statement}`
          .replace('FROM residents', 'FROM residents CROSS JOIN held_gazette_barrier')
      }, () => Promise.resolve(app.request('http://city.test/api/note', {
        method: 'POST', headers: bearer(READER.secret), body: JSON.stringify({ place_id: 454, body: 'a note beside the printer' }),
      })))
      let printing: ReturnType<typeof printGazetteIssuesDue> | undefined
      let printFinished = false
      try {
        await waitForDatabaseLock('held_gazette_barrier')
        printing = printGazetteIssuesDue(engineSql, GAZETTE_FIRST_PRINT_AT)
        void printing.then(() => { printFinished = true }, () => { printFinished = true })
        for (let attempt = 0; attempt < 500 && !printFinished; attempt += 1) {
          const rows = (await db.query(`SELECT 1 FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
              AND query LIKE 'SELECT pg_advisory_xact_lock($1::integer, $2::integer)%'`)).rows
          if (rows.length > 0) break
          await delay(10)
        }
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973108)')
        barrier.release()
      }
      const submitted = await note
      assert.equal(submitted.status, 201, await submitted.text())
      assert.equal((await printing)?.length, 1)

      await db.query('UPDATE places SET owner_id = 3 WHERE id = $1', [rooms.continentId])
      await db.query('UPDATE resident_presence SET home_place_id = $1 WHERE resident_id = 3', [rooms.continentId])
      await standIn(OWNER.id, rooms.continentId)
      const homeBarrier = await db.connect()
      await homeBarrier.query('SELECT pg_advisory_lock(1973109)')
      let actorLocks = 0
      const homeNote = withNoteSuiteQueryObserver(statement => {
        if (!statement.includes('SELECT id FROM residents') || !statement.includes('FOR NO KEY UPDATE')) return statement
        actorLocks += 1
        if (actorLocks !== 2) return statement
        return `WITH held_gazette_home AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973109)) ${statement}`
          .replace('FROM residents', 'FROM residents CROSS JOIN held_gazette_home')
      }, () => Promise.resolve(app.request('http://city.test/api/note', {
        method: 'POST', headers: bearer(READER.secret), body: JSON.stringify({ place_id: 454, body: 'a note while someone arrives' }),
      })))
      let arrival: ReturnType<typeof runAction> | undefined
      try {
        await waitForDatabaseLock('held_gazette_home')
        arrival = runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'move',
          placeId: rooms.continentId, destinationPlaceId: 454 })
        await waitForDatabaseLock('planned.depth')
      } finally {
        await homeBarrier.query('SELECT pg_advisory_unlock(1973109)')
        homeBarrier.release()
      }
      const [arrived, withHome] = await Promise.all([arrival, homeNote])
      assert.equal(arrived?.status, 'applied', arrived?.error ?? '')
      assert.equal(withHome.status, 201, await withHome.text())

      await db.query('UPDATE resident_presence SET home_place_id = NULL WHERE resident_id = 3')
      await db.query('UPDATE places SET owner_id = 1 WHERE id = $1', [rooms.continentId])
      const trait = (await db.query(`INSERT INTO traits (name, description, recipe, coiner_id)
        VALUES ('gazette-parent-law', 'an inherited public mark', $1::jsonb, 1) RETURNING id`,
      [JSON.stringify({ talk: [{ effect: 'label', target: 'law_place', label: 'inherited-note', seconds: 60 }] })])).rows[0].id
      await db.query(`INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
        VALUES ($1, $2, 1, 'add', 0)`, [rooms.continentId, trait])
      await standIn(OWNER.id, rooms.continentId)
      const inheritedBarrier = await db.connect()
      await inheritedBarrier.query('SELECT pg_advisory_lock(1973110)')
      actorLocks = 0
      const inheritedNote = withNoteSuiteQueryObserver(statement => {
        if (!statement.includes('SELECT id FROM residents') || !statement.includes('FOR NO KEY UPDATE')) return statement
        actorLocks += 1
        if (actorLocks !== 2) return statement
        return `WITH held_gazette_inherited AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973110)) ${statement}`
          .replace('FROM residents', 'FROM residents CROSS JOIN held_gazette_inherited')
      }, () => Promise.resolve(app.request('http://city.test/api/note', {
        method: 'POST', headers: bearer(READER.secret), body: JSON.stringify({ place_id: 454, body: 'a note under an inherited law' }),
      })))
      let inheritedArrival: ReturnType<typeof runAction> | undefined
      try {
        await waitForDatabaseLock('held_gazette_inherited')
        inheritedArrival = runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'move',
          placeId: rooms.continentId, destinationPlaceId: 454 })
        await waitForDatabaseLock('planned.depth')
      } finally {
        await inheritedBarrier.query('SELECT pg_advisory_unlock(1973110)')
        inheritedBarrier.release()
      }
      const [inheritedArrived, inheritedSubmitted] = await Promise.all([inheritedArrival, inheritedNote])
      assert.equal(inheritedArrived?.status, 'applied', inheritedArrived?.error ?? '')
      assert.equal(inheritedSubmitted.status, 201, await inheritedSubmitted.text())
      assert.equal((await db.query(`SELECT count(*)::int AS count FROM active_labels
        WHERE target_type = 'place' AND target_id = $1 AND label = 'inherited-note'`, [rooms.continentId])).rows[0].count, 1)

      const { replacePlaceLaws } = await import('../../src/laws.ts')
      const lawOwner = { id: OWNER.id, handle: OWNER.handle } as Parameters<typeof replacePlaceLaws>[0]
      assert.ok(Array.isArray(await replacePlaceLaws(lawOwner, rooms.continentId, [])))
      const laterLawBarrier = await db.connect()
      await laterLawBarrier.query('SELECT pg_advisory_lock(1973111)')
      actorLocks = 0
      const changedLawNote = withNoteSuiteQueryObserver(statement => {
        if (!statement.includes('SELECT id FROM residents') || !statement.includes('FOR NO KEY UPDATE')) return statement
        actorLocks += 1
        if (actorLocks !== 2) return statement
        return `WITH held_gazette_new_law AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973111)) ${statement}`
          .replace('FROM residents', 'FROM residents CROSS JOIN held_gazette_new_law')
      }, () => Promise.resolve(app.request('http://city.test/api/note', {
        method: 'POST', headers: bearer(READER.secret), body: JSON.stringify({ place_id: 454, body: 'a note after the room plan changed' }),
      })))
      try {
        await waitForDatabaseLock('held_gazette_new_law')
        assert.ok(Array.isArray(await replacePlaceLaws(lawOwner, rooms.continentId, ['gazette-parent-law'])))
      } finally {
        await laterLawBarrier.query('SELECT pg_advisory_unlock(1973111)')
        laterLawBarrier.release()
      }
      const changedLawResponse = await changedLawNote
      assert.equal(changedLawResponse.status, 409, await changedLawResponse.text())
      assert.equal((await db.query(`SELECT count(*)::int AS count FROM active_labels
        WHERE target_type = 'place' AND target_id = $1 AND label = 'inherited-note'`, [rooms.continentId])).rows[0].count, 1)
    })

    await t.test('a drawing and an action take the responsible resident lock before the public checkpoint', async () => {
      const rooms = await resetCity([OWNER, READER])
      const db = connectedDatabase()
      await standIn(OWNER.id, rooms.eastRoomId)
      await db.query(`CREATE FUNCTION hold_test_drawing() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(1973101); RETURN NEW; END $$;
        CREATE TRIGGER hold_test_drawing BEFORE INSERT ON resident_drawing_rate_limits
          FOR EACH ROW EXECUTE FUNCTION hold_test_drawing()`)
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973101)')
      let drawing: Promise<Response> | undefined
      const { runAction, setEngineTransactionRunnerForTests } = await import('../../src/engine.ts')
      let releaseAction!: () => void
      let enteredAction!: () => void
      const actionMayRun = new Promise<void>(resolve => { releaseAction = resolve })
      const actionEntered = new Promise<void>(resolve => { enteredAction = resolve })
      setEngineTransactionRunnerForTests(async (_database, work) => {
        const connection = await db.connect()
        try {
          await connection.query('BEGIN')
          enteredAction()
          await actionMayRun
          const transaction = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const statement = strings.reduce((text, part, index) =>
              text + part + (index < values.length ? `$${index + 1}` : ''), '')
            return (await connection.query(statement, values)).rows
          }, { query: async (statement: string, values: readonly unknown[] = []) =>
            (await connection.query(statement, [...values])).rows })
          const result = await work(transaction, true)
          await connection.query('COMMIT')
          return result
        } catch (error) {
          await connection.query('ROLLBACK')
          throw error
        } finally { connection.release() }
      })
      const action = runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'move',
        placeId: rooms.eastRoomId, destinationPlaceId: rooms.continentId })
      try {
        await actionEntered
        drawing = Promise.resolve(app.request('http://city.test/api/me/drawing', {
          method: 'PATCH', headers: bearer(OWNER.secret), body: JSON.stringify({
            drawing: { palette: ['#112233'], indices: [0, ...Array(63).fill(null)] },
            drawing_state: 'complete', drawing_description: 'the concurrent drawing',
          }),
        }))
        await waitForDatabaseLock('drawing:resident-write')
        releaseAction()
        await waitForDatabaseLock('SELECT id FROM residents|^COMMIT$')
      } finally {
        releaseAction()
        await barrier.query('SELECT pg_advisory_unlock(1973101)')
        barrier.release()
      }
      const response = await drawing
      assert.equal(response.status, 200, await response.text())
      const actionResult = await action
      assert.equal(actionResult.status, 'applied', actionResult.error ?? '')
      assert.deepEqual((await db.query(`SELECT kind FROM events
        WHERE kind IN ('resident_edited', 'action') ORDER BY id`)).rows.map(row => row.kind),
      ['resident_edited', 'action'])
      assert.ok((await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0].last_public_action_at)
    })
  } finally {
    await postgres.stop()
  }
})
