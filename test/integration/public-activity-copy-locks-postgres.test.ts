import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { connectedDatabase, resetCity, standIn, startNoteSuiteDatabase,
  withNoteSuiteQueryObserver } from '../helpers/note-suite-fixtures/postgres.ts'
import { seedKind, seedThing } from '../helpers/abilities-fixtures.ts'

const OWNER = Object.freeze({ id: 1, handle: 'copy-owner', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const CALLER = Object.freeze({ id: 3, handle: 'copy-caller', secret: `1f3d9_sk_${'3'.repeat(48)}` })

async function waitForLock(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = (await connectedDatabase().query(`SELECT 1 FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND datname = current_database()
        AND wait_event_type = 'Lock' AND query ~ $1`, [pattern])).rows
    if (rows.length > 0) return
    await delay(10)
  }
  assert.fail(`did not reach expected lock: ${pattern}`)
}

// Preserve the review probe: only the COMMIT pause controls overlap; the two
// actions themselves acquire every resident and room row in the tested cycle.
for (const delayed of [false, true]) {
test(`${delayed ? 'delayed' : 'shared'} copy and its owner action finish without a late owner stamp lock`,
  { timeout: 180_000 }, async () => {
  const postgres = await startNoteSuiteDatabase('activity-copy-locks')
  try {
    const { runAction } = await import('../../src/engine.ts')
    const { resolveDueEffects } = await import('../../src/engine-effects.ts')
    const db = connectedDatabase()
    for (const stampEnabled of [false, true]) {
      const rooms = await resetCity([OWNER, CALLER])
      await standIn(OWNER.id, rooms.eastRoomId)
      await standIn(CALLER.id, rooms.eastRoomId)
      await db.query(`UPDATE places SET open_to_things=true,
        growth_cap_per_day=100,growth_share_per_family=100 WHERE id=$1`, [rooms.eastRoomId])
      const copy = { effect: 'copy', to: 'here', copies: 'unlimited', generations: 8, inherit: [] }
      const trait = (await db.query(`INSERT INTO traits (name,description,recipe,coiner_id)
        VALUES ('activity-copy','copy lock regression',$1::jsonb,1) RETURNING id`,
      [JSON.stringify({ use: delayed ? [{ effect: 'wait', seconds: 1, then: [copy] }] : [copy] })])).rows[0].id
      const kind = await seedKind(OWNER.id, 'copy-kind', [trait])
      const thing = await seedThing(OWNER.id, rooms.eastRoomId, kind, 'copy source', { openToUse: true })
      const use = () => runAction({ actorId: CALLER.id, actorHandle: CALLER.handle,
        action: 'use', sourceThingId: thing, placeId: rooms.eastRoomId })
      if (delayed) {
        assert.equal((await use()).status, 'applied')
        await delay(1_100)
      }
      if (!stampEnabled) await db.query('ALTER TABLE events DISABLE TRIGGER events_stamp_public_activity')
      const failures: { code: unknown; message: string; statement: string }[] = []
      const capture = (error: unknown, statement: string) => {
        const record = error as Record<string, unknown>
        failures.push({ code: record.code, message: String(record.message), statement })
      }
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973121)')
      let held = false
      const copying = withNoteSuiteQueryObserver(statement => {
        if (!held && statement === 'COMMIT') {
          held = true
          return 'SELECT pg_advisory_xact_lock(1973121); COMMIT'
        }
        return statement
      }, async () => delayed ? resolveDueEffects(rooms.eastRoomId) : use(), undefined, capture)
      void copying.catch(() => undefined)
      let moving: ReturnType<typeof runAction> | undefined
      try {
        await waitForLock('pg_advisory_xact_lock\\(1973121\\)')
        moving = withNoteSuiteQueryObserver(statement => statement,
          () => runAction({ actorId: OWNER.id, actorHandle: OWNER.handle, action: 'move',
            placeId: rooms.eastRoomId, destinationPlaceId: rooms.eastRoomId }), undefined, capture)
        void moving.catch(() => undefined)
        // Before the fix it waits for the room while holding the owner. After
        // the fix it waits for the owner before it can take any room lock.
        await waitForLock('FROM residents.*|ORDER BY planned.depth, planned.id FOR NO KEY UPDATE OF place')
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973121)')
        barrier.release()
        await Promise.allSettled([copying, moving])
      }
      const [copied, moved] = await Promise.all([copying, moving!])
      console.log(JSON.stringify({ delayed, stampEnabled, failures, copied, moved }))
      assert.deepEqual(failures, [], 'the deferred stamp must not acquire the copy owner after the room')
      if (delayed) assert.deepEqual(copied, { resolved: 1, failed: 0, capped: false })
      else assert.equal('status' in copied && copied.status, 'applied')
      assert.equal(moved.status, 'applied')
      const events = (await db.query(`SELECT at FROM events
        WHERE kind='thing_created' AND actor=$1`, [OWNER.handle])).rows
      assert.equal(events.length, 1)
      const owner = (await db.query('SELECT last_public_action_at FROM residents WHERE id=1')).rows[0]
      assert.equal(owner.last_public_action_at?.toISOString() ?? null,
        stampEnabled ? events[0].at.toISOString() : null)
    }
  } finally { await postgres.stop() }
})
}
