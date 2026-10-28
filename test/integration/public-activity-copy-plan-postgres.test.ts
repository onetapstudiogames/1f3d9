import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { seedKind, seedThing } from '../helpers/abilities-fixtures.ts'
import { connectedDatabase, resetCity, standIn, startNoteSuiteDatabase,
  withNoteSuiteQueryObserver } from '../helpers/note-suite-fixtures/postgres.ts'

const OWNER = Object.freeze({ id: 1, handle: 'plan-owner', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const RECIPIENT = Object.freeze({ id: 2, handle: 'plan-recipient', secret: `1f3d9_sk_${'2'.repeat(48)}` })
const CALLER = Object.freeze({ id: 3, handle: 'plan-caller', secret: `1f3d9_sk_${'3'.repeat(48)}` })
const COPY = Object.freeze({ effect: 'copy', to: 'here', copies: 'unlimited', generations: 8, inherit: [] })
type Observation = Readonly<{ text: string; values: readonly unknown[] }>

async function sourceFor(ownerId: number, placeId: number, recipe: unknown): Promise<number> {
  const db = connectedDatabase()
  const trait = Number((await db.query(`INSERT INTO traits (name, description, recipe, coiner_id)
    VALUES ('copy-plan', 'copy activity attribution', $1::jsonb, $2) RETURNING id`,
  [JSON.stringify(recipe), ownerId])).rows[0]!.id)
  const kind = await seedKind(ownerId, 'copy-plan-kind', [trait])
  return seedThing(ownerId, placeId, kind, 'copy plan source', { openToUse: true })
}

function assertResidentPlan(observations: readonly Observation[], expected: readonly number[]): void {
  const residentLocks = observations.filter(row => /FROM residents\b[\s\S]*FOR NO KEY UPDATE/u.test(row.text))
  assert.equal(residentLocks.length, 1, 'one reservation covers every resident before the rooms')
  assert.match(residentLocks[0]!.text, /ORDER BY id FOR NO KEY UPDATE/u)
  assert.deepEqual(residentLocks[0]!.values, [expected], 'resident ids are deduplicated and sorted')
  const roomLock = observations.findIndex(row => /ORDER BY planned.depth, planned.id FOR NO KEY UPDATE OF place/u.test(row.text))
  assert.ok(roomLock >= 0, 'the action takes its planned room locks')
  assert.ok(observations.indexOf(residentLocks[0]!) < roomLock, 'all authors are reserved before rooms')
}

async function waitForPause(): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = (await connectedDatabase().query(`SELECT 1 FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND datname = current_database()
        AND wait_event_type = 'Lock' AND query LIKE '%activity_owner_pause%'`)).rows
    if (rows.length > 0) return
    await delay(10)
  }
  assert.fail('the action did not pause after reading its possible copy owner')
}

async function publicWork(): Promise<unknown> {
  return (await connectedDatabase().query(`SELECT jsonb_build_object(
    'things', (SELECT jsonb_agg(jsonb_build_array(id, owner_id, copies_made, generation,
      parent_thing_id, family_id, state) ORDER BY id) FROM things),
    'residents', (SELECT jsonb_agg(jsonb_build_array(id, last_public_action_at) ORDER BY id) FROM residents),
    'places', (SELECT jsonb_agg(jsonb_build_array(id, last_public_action_at) ORDER BY id) FROM places),
    'events', (SELECT jsonb_agg(jsonb_build_array(id, kind, actor, detail) ORDER BY id)
      FROM events WHERE kind <> 'action'),
    'copy_counts', (SELECT count(*) FROM place_copy_counts),
    'growth_marks', (SELECT count(*) FROM family_growth_marks),
    'rolls', (SELECT count(*) FROM chance_rolls)) AS work`)).rows[0]!.work
}

test('copy attribution reserves changed owners before rooms against real PostgreSQL',
  { timeout: 180_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('activity-copy-plan')
  try {
    const { runAction } = await import('../../src/engine.ts')
    const db = connectedDatabase()
    for (const action of ['give', 'use'] as const) {
      await t.test(action === 'give' ? 'intrinsic give reserves the recipient before its copy'
        : 'a transfer then copy reserves the recipient before ownership changes', async () => {
        const rooms = await resetCity([OWNER, RECIPIENT, CALLER])
        await standIn(CALLER.id, rooms.eastRoomId)
        await db.query('UPDATE places SET open_to_things = true WHERE id = $1', [rooms.eastRoomId])
        const recipient = action === 'give' ? OWNER : RECIPIENT
        const source = await sourceFor(CALLER.id, rooms.eastRoomId, {
          [action]: action === 'give' ? [COPY]
            : [{ effect: 'transfer', target: 'source', to: 'recipient' }, COPY],
        })
        let observations: readonly Observation[] = []
        const result = await withNoteSuiteQueryObserver((text, values) => {
          observations = [...observations, { text, values: [...values] }]
          return text
        }, () => runAction({ actorId: CALLER.id, actorHandle: CALLER.handle, action,
          placeId: rooms.eastRoomId, sourceThingId: source, recipientId: recipient.id }))
        assert.equal(result.status, 'applied', JSON.stringify(result))
        assert.equal(result.effectsApplied, action === 'give' ? 1 : 2)
        assertResidentPlan(observations, [recipient.id, CALLER.id])
        assert.deepEqual((await db.query('SELECT owner_id, copies_made FROM things WHERE id = $1',
          [source])).rows, [{ owner_id: recipient.id, copies_made: 1 }])
        assert.deepEqual((await db.query(`SELECT owner_id, maker_id, generation FROM things
          WHERE parent_thing_id = $1`, [source])).rows,
        [{ owner_id: recipient.id, maker_id: recipient.id, generation: 1 }])
        const events = (await db.query(`SELECT actor, at FROM events WHERE kind = 'thing_created'`)).rows
        assert.equal(events.length, 1)
        assert.equal(events[0]!.actor, recipient.handle)
        const stamps = (await db.query(`SELECT id, last_public_action_at FROM residents
          WHERE id = ANY($1::int[]) ORDER BY id`, [[recipient.id, CALLER.id]])).rows
        assert.equal(stamps.length, 2)
        assert.ok(stamps.every(row => row.last_public_action_at instanceof Date))
        assert.equal(stamps[0]!.last_public_action_at.toISOString(), events[0]!.at.toISOString())
      })
    }

    await t.test('an owner changed after planning refuses before a copy draw, write, or late resident lock', async () => {
      const rooms = await resetCity([OWNER, RECIPIENT, CALLER])
      await standIn(CALLER.id, rooms.eastRoomId)
      await db.query(`UPDATE places SET open_to_things = true, allow_arriving_copies = true
        WHERE id = ANY($1::int[])`, [[rooms.continentId, rooms.eastRoomId]])
      await db.query(`INSERT INTO places (parent_id, place_kind, name, description, owner_id,
        allow_arriving_copies) VALUES ($1, 'place', 'copy child', 'second eligible destination', 1, true)`,
      [rooms.eastRoomId])
      const source = await sourceFor(OWNER.id, rooms.eastRoomId, { use: [{ ...COPY, to: 'adjacent' }] })
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973122)')
      let observations: readonly Observation[] = []
      let paused = false
      const action = withNoteSuiteQueryObserver((text, values) => {
        observations = [...observations, { text, values: [...values] }]
        if (!paused && /SELECT id FROM residents WHERE id = ANY/u.test(text)) {
          paused = true
          return `WITH activity_owner_pause AS MATERIALIZED (SELECT pg_advisory_xact_lock(1973122))
            ${text.replace('FROM residents', 'FROM residents CROSS JOIN activity_owner_pause')
              .replace('FOR NO KEY UPDATE', 'FOR NO KEY UPDATE OF residents')}`
        }
        return text
      }, () => runAction({ actorId: CALLER.id, actorHandle: CALLER.handle, action: 'use',
        placeId: rooms.eastRoomId, sourceThingId: source }))
      void action.catch(() => undefined)
      let before: unknown
      try {
        await waitForPause()
        assert.ok(observations.some(row => /SELECT owner_id FROM things WHERE id = ANY/u.test(row.text)),
          'the old copy owner was read before this ownership change')
        await db.query('UPDATE things SET owner_id = $1 WHERE id = $2', [RECIPIENT.id, source])
        before = await publicWork()
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973122)')
        barrier.release()
        await Promise.allSettled([action])
      }
      const result = await action
      assert.equal(result.status, 'failed', JSON.stringify(result))
      assert.equal(result.httpStatus, 409)
      assert.equal(result.error, 'another action changed the same records; retry')
      assert.equal(result.effectsApplied, 0)
      assertResidentPlan(observations, [OWNER.id, CALLER.id])
      assert.ok(observations.some(row => /FOR NO KEY UPDATE OF thing/u.test(row.text)),
        'copy rechecks the owner under its parent lock')
      assert.ok(!observations.some(row => /chance_rolls_id_seq|INSERT INTO (?:things|chance_rolls|family_growth_marks)/u.test(row.text)),
        'no copy, growth mark, or draw is attempted before the owner refusal')
      assert.deepEqual(await publicWork(), before, 'refusal preserves public work and every activity marker')
    })
  } finally { await postgres.stop() }
})
