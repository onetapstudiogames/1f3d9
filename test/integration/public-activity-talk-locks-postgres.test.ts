import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  connectedDatabase, resetCity, standIn, startNoteSuiteDatabase,
  withNoteSuiteQueryObserver,
} from '../helpers/note-suite-fixtures/postgres.ts'

const SENDER = Object.freeze({ id: 1, handle: 'talk-lock-sender', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const TARGET = Object.freeze({ id: 3, handle: 'talk-lock-target', secret: `1f3d9_sk_${'3'.repeat(48)}` })
const REQUEST = '00000000-0000-4000-8000-000000000001'
const NEXT_REQUEST = '00000000-0000-4000-8000-000000000002'
const DISMISS_REQUEST = '00000000-0000-4000-8000-000000000003'

async function waitForLock(pattern: string, excludeBarrier = false): Promise<void> {
  const db = connectedDatabase()
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = (await db.query(`SELECT 1 FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND datname = current_database()
        AND wait_event_type = 'Lock' AND query ~ $1
        AND (NOT $2::boolean OR query NOT LIKE '%held_talk_action%')`,
    [pattern, excludeBarrier])).rows
    if (rows.length > 0) return
    await delay(10)
  }
  assert.fail(`the talk request did not reach its expected lock: ${pattern}`)
}

test('public talk activity locks precede presence and ping resources', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('public-activity-talk-locks')
  try {
    const { runAction } = await import('../../src/engine.ts')
    const { sayLine } = await import('../../src/room-line-store.ts')
    const { invitePing, answerPing, dismissPing } = await import('../../src/room-ping-store.ts')
    const db = connectedDatabase()
    const prepare = async () => {
      const rooms = await resetCity([SENDER, TARGET])
      await standIn(SENDER.id, rooms.eastRoomId)
      await standIn(TARGET.id, rooms.eastRoomId)
      return rooms
    }
    const invite = () => invitePing({ residentId: SENDER.id, residentHandle: SENDER.handle,
      toHandle: TARGET.handle, requestId: REQUEST })

    const withContendingAction = async <T>(
      resident: typeof SENDER | typeof TARGET, placeId: number, talk: () => Promise<T>,
    ): Promise<T> => {
      const barrier = await db.connect()
      await barrier.query('SELECT pg_advisory_lock(1973111)')
      const action = withNoteSuiteQueryObserver(statement => {
        if (!/SELECT id FROM residents WHERE id = \$1 FOR NO KEY UPDATE/u.test(statement)) return statement
        return `WITH held_talk_action AS MATERIALIZED (${statement})
          SELECT id, pg_advisory_xact_lock(1973111) FROM held_talk_action`
      }, () => runAction({ actorId: resident.id, actorHandle: resident.handle, action: 'move',
        placeId, destinationPlaceId: placeId }))
      let request: Promise<T> | undefined
      let waitingError: unknown
      try {
        await waitForLock('held_talk_action')
        request = talk()
        // Attach a handler before the deadlock detector can settle either request.
        void request.catch(() => undefined)
        await waitForLock('COMMIT|FROM residents', true)
      } catch (error) {
        waitingError = error
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(1973111)')
        barrier.release()
      }
      const results = await Promise.allSettled([action, request])
      if (waitingError) throw waitingError
      assert.equal(results[0]!.status, 'fulfilled', JSON.stringify(results[0]))
      assert.equal(results[1]!.status, 'fulfilled', JSON.stringify(results[1]))
      const moved = (results[0] as PromiseFulfilledResult<Awaited<typeof action>>).value
      assert.equal(moved.status, 'applied', moved.error ?? '')
      return (results[1] as PromiseFulfilledResult<T>).value
    }

    await t.test('a line and an action by its author both finish', async () => {
      const rooms = await prepare()
      const outcome = await withContendingAction(SENDER, rooms.eastRoomId, () => sayLine({
        residentId: SENDER.id, residentHandle: SENDER.handle, placeId: rooms.eastRoomId,
        body: 'A line after the action lock.', requestId: REQUEST,
      }))
      assert.equal(outcome.ok, true, JSON.stringify(outcome))
      assert.equal((await db.query('SELECT count(*)::int AS n FROM room_lines')).rows[0].n, 1)
      assert.equal((await db.query('SELECT used FROM line_quota WHERE resident_id = 1')).rows[0].used, 1)
      assert.ok((await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0].last_public_action_at)
      assert.ok((await db.query('SELECT last_public_action_at FROM places WHERE id = $1',
        [rooms.eastRoomId])).rows[0].last_public_action_at)
    })

    await t.test('a ping invite and an action by its sender both finish', async () => {
      const rooms = await prepare()
      const outcome = await withContendingAction(SENDER, rooms.eastRoomId, invite)
      assert.equal(outcome.ok, true, JSON.stringify(outcome))
      assert.equal((await db.query("SELECT count(*)::int AS n FROM events WHERE kind = 'ping_sent'")).rows[0].n, 1)
      assert.ok((await db.query('SELECT last_public_action_at FROM residents WHERE id = 1')).rows[0].last_public_action_at)
      assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id = 3')).rows[0].last_public_action_at, null)
    })

    await t.test('a ping answer and an action by its target both finish', async () => {
      const rooms = await prepare()
      const invited = await invite()
      assert.equal(invited.ok, true)
      if (!invited.ok) return
      const outcome = await withContendingAction(TARGET, rooms.eastRoomId, () => answerPing({
        residentId: TARGET.id, residentHandle: TARGET.handle, pingId: invited.answer.ping.id,
        answer: 'yes', requestId: NEXT_REQUEST,
      }))
      assert.equal(outcome.ok, true, JSON.stringify(outcome))
      assert.equal((await db.query("SELECT count(*)::int AS n FROM events WHERE kind = 'ping_answered'")).rows[0].n, 1)
      assert.ok((await db.query('SELECT last_public_action_at FROM residents WHERE id = 3')).rows[0].last_public_action_at)
    })

    await t.test('private dismissal preserves public timestamps and a stored replay skips new locks', async () => {
      await prepare()
      const invited = await invite()
      assert.equal(invited.ok, true)
      if (!invited.ok) return
      const pingId = invited.answer.ping.id
      const answered = await answerPing({ residentId: TARGET.id, residentHandle: TARGET.handle,
        pingId, answer: 'no', requestId: NEXT_REQUEST })
      assert.equal(answered.ok, true, JSON.stringify(answered))
      const before = (await db.query(`SELECT 'resident' AS kind, id, last_public_action_at FROM residents
        UNION ALL SELECT 'place', id, last_public_action_at FROM places ORDER BY kind, id`)).rows
      const eventsBefore = (await db.query('SELECT count(*)::int AS n FROM events')).rows[0].n
      const dismissed = await dismissPing({ residentId: TARGET.id, pingId, requestId: DISMISS_REQUEST })
      assert.equal(dismissed.ok, true, JSON.stringify(dismissed))
      const blocker = await db.connect()
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM residents WHERE id = 3 FOR NO KEY UPDATE')
      try {
        const replay = await Promise.race([
          dismissPing({ residentId: TARGET.id, pingId, requestId: DISMISS_REQUEST }),
          delay(2_000).then(() => { throw new Error('the stored replay waited for a new activity lock') }),
        ])
        assert.equal(replay.ok, true)
        if (replay.ok) assert.equal(replay.answer.replayed, true)
      } finally {
        await blocker.query('ROLLBACK')
        blocker.release()
      }
      assert.deepEqual((await db.query(`SELECT 'resident' AS kind, id, last_public_action_at FROM residents
        UNION ALL SELECT 'place', id, last_public_action_at FROM places ORDER BY kind, id`)).rows, before)
      assert.equal((await db.query('SELECT count(*)::int AS n FROM events')).rows[0].n, eventsBefore)
    })
  } finally {
    await postgres.stop()
  }
})
