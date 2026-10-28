import assert from 'node:assert/strict'
import test from 'node:test'
import { FOUNDER, GROWER, NEIGHBOUR } from '../helpers/abilities-fixtures.ts'
import { resetCity, startNoteSuiteDatabase } from '../helpers/note-suite-fixtures/postgres.ts'

test('stored activity maintenance proves historical rooms and changed outcomes', { timeout: 600_000 }, async t => {
  let postgres: Awaited<ReturnType<typeof startNoteSuiteDatabase>> | undefined
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { postgres = await startNoteSuiteDatabase('activity-room-proof'); break } catch (error) { if (attempt === 3) throw error }
  }
  assert.ok(postgres)
  const db = postgres.client
  const event = async (kind: string, detail: Record<string, unknown>) => Number((await db.query(
    'INSERT INTO events(kind,actor,detail) VALUES ($1,$2,$3::jsonb) RETURNING id', [kind, GROWER.handle, JSON.stringify(detail)],
  )).rows[0]!.id)
  const candidates = async (id: number) => (await db.query(`SELECT activity.* FROM events event
    CROSS JOIN LATERAL public_activity_candidates(event.id,event.kind,event.actor,event.detail) activity WHERE event.id=$1`, [id])).rows
  try {
    await t.test('a changed historical move with zero extra effects counts, while a same-room move does not', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      for (const destination of [rooms.westRoomId, rooms.eastRoomId]) {
        const action = (await db.query(`INSERT INTO action_runs(actor_id,action_name,place_id,destination_place_id)
          VALUES (2,'move',$1,$2) RETURNING id`, [rooms.eastRoomId, destination])).rows[0]!.id
        await db.query(`INSERT INTO action_resolutions(action_run_id,status,detail) VALUES ($1,'applied','{"effects_applied":0}')`, [action])
        const id = await event('action', { action_id: action, action: 'move', status: 'applied', effects_applied: 0 })
        assert.deepEqual(await candidates(id), destination === rooms.westRoomId
          ? [{ actor_handle: GROWER.handle, place_id: destination, proved: true }] : [])
      }
    })
    await t.test('thing locations follow complete creation and movement chains in public change order', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      await event('thing_created', { thing_id: 42, place_id: rooms.eastRoomId })
      await event('thing_moved', { thing_id: 42, from_place_id: rooms.eastRoomId, place_id: rooms.continentId })
      const edited = await event('thing_edited', { thing_id: 42 })
      await event('thing_moved', { thing_id: 42, from_place_id: rooms.continentId, place_id: rooms.westRoomId })
      assert.deepEqual(await candidates(edited), [{ actor_handle: GROWER.handle, place_id: rooms.continentId, proved: true }])
      await event('thing_moved', { thing_id: 42, from_place_id: rooms.eastRoomId, place_id: rooms.westRoomId })
      const broken = await candidates(await event('thing_edited', { thing_id: 42 }))
      assert.ok(broken.some(row => row.place_id === null && row.proved === false))
    })
    await t.test('a first legacy home row cannot prove a change from an automatically selected home', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      await db.query('INSERT INTO resident_presence(resident_id,current_place_id,home_place_id) VALUES (2,$1,$1)', [rooms.eastRoomId])
      const first = await event('home_set', { place_id: rooms.eastRoomId })
      assert.deepEqual(await candidates(first), [{ actor_handle: GROWER.handle, place_id: rooms.eastRoomId, proved: false }])
      const next = await event('home_set', { place_id: rooms.westRoomId })
      assert.deepEqual(await candidates(next), [{ actor_handle: GROWER.handle, place_id: rooms.westRoomId, proved: true }])
    })
    await t.test('held work and summaries never count, while missing dynamic outcomes remain unproved', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      assert.deepEqual(await candidates(await event('action', { status: 'applied', applied_public_activity: [] })), [])
      assert.deepEqual(await candidates(await event('room_settled', { woke: 1, applied_public_activity: [{ actor: GROWER.handle, operation: 'label', place_id: rooms.eastRoomId }] })), [])
      const delayed = await candidates(await event('effect_resolved', { status: 'applied', effects_applied: 1 }))
      assert.deepEqual(delayed, [{ actor_handle: GROWER.handle, place_id: null, proved: false }])
      const reached = await candidates(await event('room_reached', { effects_applied: 1 }))
      assert.deepEqual(reached, [{ actor_handle: GROWER.handle, place_id: null, proved: false }])
    })
    await t.test('carrier outcomes obey feed and targeted moderation exclusions', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      await db.query('UPDATE places SET quiet=true,feed=true WHERE id=$1', [rooms.eastRoomId])
      const outcome = { actor: GROWER.handle, operation: 'label', place_id: rooms.eastRoomId, target_type: 'thing', target_id: 42 }
      for (const kind of ['action', 'effect_resolved', 'room_reached', 'wake_try_applied']) {
        const id = await event(kind, { status: 'applied', applied_public_activity: [outcome] })
        assert.deepEqual(await candidates(id), [{ actor_handle: null, place_id: rooms.eastRoomId, proved: true }], kind)
      }
      assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id=2')).rows[0]!.last_public_action_at, null)
      await db.query(`INSERT INTO moderation_actions(target_type,target_id,action,actor_id,reason) VALUES ('thing',42,'remove',1,'removed outcome target')`)
      assert.deepEqual(await candidates(await event('wake_try_applied', { applied_public_activity: [outcome] })), [])
    })
    await t.test('hidden public sources cannot store future or non-finite times for a later restore', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const note = Number((await db.query('INSERT INTO notes(place_id,author_id,body) VALUES ($1,2,$2) RETURNING id', [rooms.eastRoomId, 'hidden source'])).rows[0]!.id)
      await db.query(`INSERT INTO moderation_actions(target_type,target_id,action,actor_id,reason) VALUES ('note',$1,'remove',1,'hidden source')`, [note])
      for (const at of [new Date(Date.now() + 3_600_000).toISOString(), 'infinity']) {
        await assert.rejects(db.query('INSERT INTO events(kind,actor,detail,at) VALUES ($1,$2,$3::jsonb,$4)',
          ['note', GROWER.handle, JSON.stringify({ note_id: note, place_id: rooms.eastRoomId }), at]), /event time/u)
      }
      await db.query(`INSERT INTO moderation_actions(target_type,target_id,action,actor_id,reason) VALUES ('note',$1,'restore',1,'restored source')`, [note])
      assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id=2')).rows[0]!.last_public_action_at, null)
    })
    await t.test('scoped invalidation preserves a newer unrelated action committed while its affected actor is locked', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const note = Number((await db.query('INSERT INTO notes(place_id,author_id,body) VALUES ($1,2,$2) RETURNING id',
        [rooms.eastRoomId, 'affected note'])).rows[0]!.id)
      await db.query(`INSERT INTO events(kind,actor,detail,at) VALUES ('note',$1,$2::jsonb,now()-interval '2 hours'),
        ('action',$3,$4::jsonb,now()-interval '2 hours')`, [GROWER.handle, JSON.stringify({ note_id: note, place_id: rooms.eastRoomId }),
        NEIGHBOUR.handle, JSON.stringify({ applied_public_activity: [{ actor: NEIGHBOUR.handle, operation: 'move', place_id: rooms.westRoomId }] })])
      const blocker = await db.connect()
      const invalidator = await db.connect()
      let pending: Promise<unknown> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM residents WHERE id=2 FOR NO KEY UPDATE')
        const pid = Number((await invalidator.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
        pending = invalidator.query(`INSERT INTO moderation_actions(target_type,target_id,action,actor_id,reason)
          VALUES ('note',$1,'remove',1,'scoped invalidation')`, [note])
        let waiting = false
        for (let attempt = 0; attempt < 200; attempt += 1) {
          waiting = Boolean((await db.query('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting', [pid])).rows[0]!.waiting)
          if (waiting) break
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.ok(waiting, 'invalidation reached the affected resident lock')
        await db.query(`INSERT INTO events(kind,actor,detail) VALUES ('action',$1,$2::jsonb)`, [NEIGHBOUR.handle,
          JSON.stringify({ applied_public_activity: [{ actor: NEIGHBOUR.handle, operation: 'move', place_id: rooms.westRoomId }] })])
        const fresh = (await db.query('SELECT last_public_action_at FROM residents WHERE id=3')).rows[0]!.last_public_action_at
        await blocker.query('COMMIT')
        await pending
        assert.deepEqual((await db.query('SELECT last_public_action_at FROM residents WHERE id=3')).rows[0]!.last_public_action_at, fresh)
        assert.deepEqual((await db.query('SELECT last_public_action_at FROM places WHERE id=$1', [rooms.westRoomId])).rows[0]!.last_public_action_at, fresh)
        assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id=2')).rows[0]!.last_public_action_at, null)
      } finally {
        await blocker.query('ROLLBACK')
        await pending?.catch(() => undefined)
        blocker.release()
        invalidator.release()
      }
    })
  } finally { await postgres.stop() }
})
