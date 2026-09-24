import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  FOUNDER,
  GROWER,
  NEIGHBOUR,
} from '../helpers/abilities-fixtures.ts'
import {
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const

function requestId(value: number): string {
  return '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
}

test('room pings use durable outcomes and pair history against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('room-talk-pings')
  try {
    let rooms = await resetCity(RESIDENTS)
    await standIn(FOUNDER.id, rooms.eastRoomId)
    await standIn(GROWER.id, rooms.eastRoomId)
    await standIn(NEIGHBOUR.id, rooms.westRoomId)

    const { invitePing, answerPing, dismissPing } = await import('../../src/room-ping-store.ts')
    const db = connectedDatabase()
    let requestNumber = 1
    const nextRequestId = () => requestId(requestNumber++)
    const reset = async () => {
      rooms = await resetCity(RESIDENTS)
      await standIn(FOUNDER.id, rooms.eastRoomId)
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.westRoomId)
      return rooms
    }
    const invite = (
      toHandle: unknown = GROWER.handle,
      resident: Readonly<{ id: number; handle: string }> = FOUNDER,
      id = nextRequestId(),
    ) => invitePing({
      residentId: resident.id,
      residentHandle: resident.handle,
      toHandle,
      requestId: id,
    })
    const answer = (
      pingId: unknown,
      answerValue: unknown = 'yes',
      resident: Readonly<{ id: number; handle: string }> = GROWER,
      id = nextRequestId(),
    ) => answerPing({
      residentId: resident.id,
      residentHandle: resident.handle,
      pingId,
      answer: answerValue,
      requestId: id,
    })
    const dismiss = (
      pingId: unknown,
      resident: Readonly<{ id: number; handle: string }> = GROWER,
      id = nextRequestId(),
    ) => dismissPing({ residentId: resident.id, pingId, requestId: id })
    const count = async (sql: string, values: readonly unknown[] = []) => Number(
      (await db.query<{ count: number }>(sql, [...values])).rows[0]!.count,
    )
    const seedPing = async (input: Readonly<{
      sender?: Readonly<{ id: number; handle: string }>
      target?: Readonly<{ id: number; handle: string }>
      placeId?: number
      sentAgoSeconds: number
      expiresAgoSeconds: number
      answer?: 'yes' | 'no' | 'in_a_moment' | null
      answeredAgoSeconds?: number | null
      staleArrival?: boolean
      id?: number
    }>): Promise<number> => {
      const sender = input.sender ?? FOUNDER
      const target = input.target ?? GROWER
      const placeId = input.placeId ?? rooms.eastRoomId
      const values = [
        input.id ?? null,
        placeId,
        sender.id,
        target.id,
        input.sentAgoSeconds,
        input.expiresAgoSeconds,
        input.answer ?? null,
        input.answeredAgoSeconds ?? null,
        input.staleArrival ?? false,
      ]
      const result = await db.query<{ id: number }>(`
        WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now),
        inserted AS (
          INSERT INTO pings (
            id, place_id, sender_id, target_id, sent_at, expires_at,
            sender_arrived_at, target_arrived_at, answer, answered_at
          )
          SELECT COALESCE($1::integer, nextval(pg_get_serial_sequence('pings', 'id'))::integer),
            $2, $3, $4,
            stamp.now - make_interval(secs => $5::double precision),
            stamp.now - make_interval(secs => $6::double precision),
            CASE WHEN $9::boolean THEN '2000-01-01T00:00:00Z'::timestamptz ELSE sender_presence.arrived_at END,
            CASE WHEN $9::boolean THEN '2000-01-01T00:00:00Z'::timestamptz ELSE target_presence.arrived_at END,
            $7::text,
            CASE WHEN $7::text IS NULL THEN NULL
              ELSE stamp.now - make_interval(secs => $8::double precision) END
          FROM stamp
          JOIN resident_presence sender_presence ON sender_presence.resident_id = $3
          JOIN resident_presence target_presence ON target_presence.resident_id = $4
          RETURNING id, target_id
        )
        INSERT INTO ping_receipts (ping_id, recipient_id)
        SELECT id, target_id FROM inserted
        RETURNING ping_id AS id
      `, values)
      return Number(result.rows[0]!.id)
    }
    const pingState = async (pingId: number) => (await db.query<{
      status: string
      still_together: boolean
      sender_arrived_at: Date
      sent_at: Date
    }>(`
      SELECT CASE
          WHEN ping.answer IS NOT NULL THEN 'answered'
          WHEN NOT coalesce(
            sender_presence.current_place_id = ping.place_id
              AND sender_presence.arrived_at = ping.sender_arrived_at
              AND target_presence.current_place_id = ping.place_id
              AND target_presence.arrived_at = ping.target_arrived_at,
            false
          ) OR stamp.now >= ping.expires_at THEN 'expired'
          ELSE 'offered'
        END AS status,
        coalesce(
          sender_presence.current_place_id = ping.place_id
            AND sender_presence.arrived_at = ping.sender_arrived_at
            AND target_presence.current_place_id = ping.place_id
            AND target_presence.arrived_at = ping.target_arrived_at,
          false
        ) AS still_together,
        ping.sender_arrived_at, ping.sent_at
      FROM pings ping
      LEFT JOIN resident_presence sender_presence ON sender_presence.resident_id = ping.sender_id
      LEFT JOIN resident_presence target_presence ON target_presence.resident_id = ping.target_id
      CROSS JOIN (SELECT clock_timestamp() AS now) stamp
      WHERE ping.id = $1
    `, [pingId])).rows[0]!
    const waitForLock = async (fragment: string) => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const waiting = await db.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query ILIKE $1
          ) AS waiting
        `, ['%' + fragment + '%'])
        if (waiting.rows[0]!.waiting) return
        await delay(10)
      }
      assert.fail('the expected ping transaction did not wait for its lock')
    }

    await t.test('invalid request shapes are refused before a ledger row is written', async () => {
      await reset()
      const badRequest = await invite(GROWER.handle, FOUNDER, 'not-a-uuid')
      const badAnswerId = await answer(0)
      const badAnswer = await answer(1, 'later')
      const badDismissId = await dismiss(-1)
      assert.deepEqual(badRequest, {
        ok: false,
        refusal: {
          status: 400,
          error: 'request_id must be a new lowercase UUID that you make up for this one line or ping action, like 3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f.',
        },
      })
      assert.deepEqual(badAnswerId, {
        ok: false,
        refusal: {
          status: 400,
          error: 'ping_id must be a positive whole number. Read your pending pings with me to find it.',
        },
      })
      assert.deepEqual(badAnswer, {
        ok: false,
        refusal: {
          status: 400,
          error: 'answer must be yes, no, or in_a_moment. Send one of those three words.',
        },
      })
      assert.deepEqual(badDismissId, badAnswerId)
      assert.equal(await count('SELECT count(*)::int AS count FROM ping_operations'), 0)
    })

    await t.test('an invite creates one offered ping, one private receipt, and one ping_sent event', async () => {
      await reset()
      const result = await invite()
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.status, 201)
      assert.equal(result.answer.replayed, false)
      assert.deepEqual(result.answer.ping, {
        id: result.answer.ping.id,
        status: 'offered',
        place_id: rooms.eastRoomId,
        sender_id: FOUNDER.id,
        sender: FOUNDER.handle,
        target_id: GROWER.id,
        target: GROWER.handle,
        sent_at: result.answer.ping.sent_at,
        expires_at: result.answer.ping.expires_at,
        answer: null,
        answered_at: null,
      })
      assert.ok(result.answer.ping.id > 0)
      assert.ok(Date.parse(result.answer.ping.expires_at) > Date.parse(result.answer.ping.sent_at))
      const receipts = (await db.query<{ ping_id: number; recipient_id: number; seen_at: Date | null; dismissed_at: Date | null }>(
        'SELECT ping_id, recipient_id, seen_at, dismissed_at FROM ping_receipts WHERE ping_id = $1',
        [result.answer.ping.id],
      )).rows
      assert.deepEqual(receipts, [{
        ping_id: result.answer.ping.id,
        recipient_id: GROWER.id,
        seen_at: null,
        dismissed_at: null,
      }])
      const events = (await db.query<{ at: Date; kind: string; actor: string; detail: Record<string, unknown> }>(
        "SELECT at, kind, actor, detail FROM events WHERE kind = 'ping_sent'",
      )).rows
      assert.equal(events.length, 1)
      assert.equal(events[0]!.actor, FOUNDER.handle)
      assert.deepEqual(events[0]!.detail, {
        ping_id: result.answer.ping.id,
        place_id: rooms.eastRoomId,
        target_type: 'resident',
        target_id: GROWER.id,
      })
    })

    await t.test('absent, elsewhere, and unknown handles share one refusal and write nothing public', async () => {
      await reset()
      await db.query('DELETE FROM resident_presence WHERE resident_id = $1', [GROWER.id])
      const absent = await invite(GROWER.handle)
      await standIn(GROWER.id, rooms.westRoomId)
      const elsewhere = await invite(GROWER.handle)
      const unknown = await invite('unknown-handle')
      const expected = {
        ok: false,
        refusal: {
          status: 403,
          error: "I can't deliver this ping here now. Ask the resident to meet you in this place, then try again.",
        },
      }
      assert.deepEqual(absent, expected)
      assert.deepEqual(elsewhere, expected)
      assert.deepEqual(unknown, expected)
      assert.equal(await count('SELECT count(*)::int AS count FROM pings'), 0)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind LIKE 'ping_%'"), 0)
      assert.equal(await count('SELECT count(*)::int AS count FROM ping_operations'), 3)
      assert.equal(await count('SELECT count(*)::int AS count FROM ping_operations WHERE ping_id IS NOT NULL'), 0)
    })

    await t.test('a resident cannot ping themself', async () => {
      await reset()
      const result = await invite(FOUNDER.handle)
      assert.deepEqual(result, {
        ok: false,
        refusal: {
          status: 400,
          error: 'A ping invites another resident. Ping someone else who stands in this place.',
        },
      })
      assert.equal(await count('SELECT count(*)::int AS count FROM pings'), 0)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind LIKE 'ping_%'"), 0)
      assert.equal(await count('SELECT count(*)::int AS count FROM ping_operations WHERE ping_id IS NULL'), 1)
    })

    await t.test('invite replay returns its first answer, conflicts on a changed handle, and serializes ten retries', async () => {
      await reset()
      const id = nextRequestId()
      const first = await invite(GROWER.handle, FOUNDER, id)
      const replay = await invite(GROWER.handle, FOUNDER, id)
      const changed = await invite(NEIGHBOUR.handle, FOUNDER, id)
      assert.equal(first.ok, true)
      assert.equal(replay.ok, true)
      if (!first.ok || !replay.ok) return
      assert.equal(first.status, 201)
      assert.equal(replay.status, 200)
      assert.equal(first.answer.replayed, false)
      assert.equal(replay.answer.replayed, true)
      assert.deepEqual(replay.answer.ping, first.answer.ping)
      assert.equal(changed.ok, false)
      if (!changed.ok) {
        assert.equal(changed.refusal.status, 409)
        assert.match(changed.refusal.error, /different ping invite/u)
      }
      await reset()
      const concurrentId = nextRequestId()
      const concurrent = await Promise.all(
        Array.from({ length: 10 }, () => invite(GROWER.handle, FOUNDER, concurrentId)),
      )
      assert.equal(concurrent.filter(result => result.ok && result.status === 201).length, 1)
      assert.equal(concurrent.filter(result => result.ok && result.status === 200).length, 9)
      assert.equal(concurrent.filter(result => !result.ok).length, 0)
      assert.equal(await count('SELECT count(*)::int AS count FROM pings'), 1)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'ping_sent'"), 1)
    })

    await t.test('a stored open-ping refusal replays after its offer window has passed', async () => {
      await reset()
      const pingId = await seedPing({
        sentAgoSeconds: 599.5,
        expiresAgoSeconds: -0.3,
      })
      const id = nextRequestId()
      const first = await invite(GROWER.handle, FOUNDER, id)
      assert.equal(first.ok, false)
      if (!first.ok) {
        assert.equal(first.refusal.status, 429)
        assert.equal(first.refusal.open_until !== undefined, true)
      }
      const ledger = (await db.query<{ ping_id: number | null }>(
        'SELECT ping_id FROM ping_operations WHERE request_id = $1::uuid',
        [id],
      )).rows[0]!
      assert.equal(ledger.ping_id, null)
      assert.ok(pingId > 0)
      await delay(400)
      const replay = await invite(GROWER.handle, FOUNDER, id)
      assert.deepEqual(replay, first)
      assert.equal(await count('SELECT count(*)::int AS count FROM pings'), 1)
    })

    await t.test('a not-found answer is stored without a ping and replays after that ID appears', async () => {
      await reset()
      const missingId = 2_000_000_000
      const request = nextRequestId()
      const first = await answer(missingId, 'yes', GROWER, request)
      assert.deepEqual(first, {
        ok: false,
        refusal: {
          status: 404,
          error: 'No ping has id 2000000000. Read your pending pings with me to find the one to answer.',
        },
      })
      const before = (await db.query<{ ping_id: number | null }>(
        'SELECT ping_id FROM ping_operations WHERE resident_id = $1 AND request_id = $2::uuid',
        [GROWER.id, request],
      )).rows[0]!
      assert.equal(before.ping_id, null)
      await seedPing({ sentAgoSeconds: 1, expiresAgoSeconds: -599, id: missingId })
      const replay = await answer(missingId, 'yes', GROWER, request)
      assert.deepEqual(replay, first)
      assert.equal(await count('SELECT count(*)::int AS count FROM pings WHERE id = $1', [missingId]), 1)
    })

    await t.test('answer replay returns the first answer and refuses a changed answer', async () => {
      await reset()
      const offered = await invite()
      assert.equal(offered.ok, true)
      if (!offered.ok) return
      const id = nextRequestId()
      const first = await answer(offered.answer.ping.id, 'yes', GROWER, id)
      const replay = await answer(offered.answer.ping.id, 'yes', GROWER, id)
      const changed = await answer(offered.answer.ping.id, 'no', GROWER, id)
      assert.equal(first.ok, true)
      assert.equal(replay.ok, true)
      if (!first.ok || !replay.ok) return
      assert.equal(first.status, 200)
      assert.equal(replay.status, 200)
      assert.equal(first.answer.replayed, false)
      assert.equal(replay.answer.replayed, true)
      assert.deepEqual(replay.answer.ping, first.answer.ping)
      assert.equal(replay.answer.ping.answer, 'yes')
      assert.equal(changed.ok, false)
      if (!changed.ok) {
        assert.equal(changed.refusal.status, 409)
        assert.match(changed.refusal.error, /different ping answer/u)
      }
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'ping_answered'"), 1)
    })

    await t.test('dismiss replay is exact and a used invite ID names the conflicting operation', async () => {
      await reset()
      const offered = await invite()
      assert.equal(offered.ok, true)
      if (!offered.ok) return
      await standIn(FOUNDER.id, rooms.westRoomId)
      const id = nextRequestId()
      const first = await dismiss(offered.answer.ping.id, GROWER, id)
      const replay = await dismiss(offered.answer.ping.id, GROWER, id)
      assert.equal(first.ok, true)
      assert.equal(replay.ok, true)
      if (!first.ok || !replay.ok) return
      assert.equal(first.status, 200)
      assert.equal(replay.status, 200)
      assert.equal(first.answer.replayed, false)
      assert.equal(replay.answer.replayed, true)
      assert.deepEqual(replay.answer.receipt, first.answer.receipt)

      await reset()
      const usedId = nextRequestId()
      const growerInvite = await invite(FOUNDER.handle, GROWER, usedId)
      const founderInvite = await invite(GROWER.handle, FOUNDER)
      assert.equal(growerInvite.ok, true)
      assert.equal(founderInvite.ok, true)
      if (!founderInvite.ok) return
      await standIn(FOUNDER.id, rooms.westRoomId)
      const reused = await dismiss(founderInvite.answer.ping.id, GROWER, usedId)
      assert.equal(reused.ok, false)
      if (!reused.ok) {
        assert.equal(reused.refusal.status, 409)
        assert.match(reused.refusal.error, /different ping invite/u)
      }
    })

    await t.test('only the target answers, and only while the offer and shared arrival are live', async () => {
      await reset()
      const offered = await invite()
      assert.equal(offered.ok, true)
      if (!offered.ok) return
      const wrongResident = await answer(offered.answer.ping.id, 'yes', NEIGHBOUR)
      assert.equal(wrongResident.ok, false)
      if (!wrongResident.ok) assert.deepEqual(wrongResident.refusal, {
        status: 403,
        error: 'Only the resident this ping invited can answer it or dismiss its receipt. Read your own pending pings with me.',
      })
      const liveAnswer = await answer(offered.answer.ping.id)
      assert.equal(liveAnswer.ok, true)

      await reset()
      const movedOffer = await invite()
      assert.equal(movedOffer.ok, true)
      if (!movedOffer.ok) return
      await standIn(FOUNDER.id, rooms.westRoomId)
      const movedAnswer = await answer(movedOffer.answer.ping.id)
      assert.equal(movedAnswer.ok, false)
      if (!movedAnswer.ok) assert.equal(movedAnswer.refusal.error,
        'This ping can no longer be answered. Read its receipt and send a new ping if you still want to talk.')

      await reset()
      const expiredId = await seedPing({ sentAgoSeconds: 660, expiresAgoSeconds: 60 })
      const expiredAnswer = await answer(expiredId)
      assert.equal(expiredAnswer.ok, false)
      if (!expiredAnswer.ok) assert.equal(expiredAnswer.refusal.status, 409)
    })

    await t.test('moving away and returning does not reopen an offer', async () => {
      await reset()
      const offered = await invite()
      assert.equal(offered.ok, true)
      if (!offered.ok) return
      await standIn(GROWER.id, rooms.westRoomId)
      await standIn(GROWER.id, rooms.eastRoomId)
      const state = await pingState(offered.answer.ping.id)
      assert.equal(state.still_together, false)
      assert.equal(state.status, 'expired')
      const result = await answer(offered.answer.ping.id)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.refusal.status, 409)
    })

    await t.test('a return move started before the ping keeps the offer expired', async () => {
      await reset()
      const connection = await db.connect()
      let pingId = 0
      try {
        await connection.query('BEGIN')
        const started = (await connection.query<{ started_at: Date }>('SELECT now() AS started_at')).rows[0]!
        await delay(20)
        const offered = await invite()
        assert.equal(offered.ok, true)
        if (!offered.ok) return
        pingId = offered.answer.ping.id
        await standIn(GROWER.id, rooms.westRoomId)
        await connection.query(
          'UPDATE resident_presence SET current_place_id = $2 WHERE resident_id = $1',
          [GROWER.id, rooms.eastRoomId],
        )
        await connection.query('COMMIT')
        const state = await pingState(pingId)
        assert.equal(state.sender_arrived_at.getTime() < state.sent_at.getTime(), true)
        assert.equal(state.still_together, false)
        assert.equal(state.status, 'expired')
        const result = await answer(pingId)
        assert.equal(result.ok, false)
        if (!result.ok) assert.equal(result.refusal.status, 409)
        assert.ok(started.started_at.getTime() < state.sent_at.getTime())
      } finally {
        await connection.query('ROLLBACK').catch(() => undefined)
        connection.release()
      }
    })

    await t.test('an answer and a move have one winner in either lock order', async () => {
      await reset()
      let offered = await invite()
      assert.equal(offered.ok, true)
      if (!offered.ok) return
      const moveFirst = await db.connect()
      try {
        await moveFirst.query('BEGIN')
        await moveFirst.query(
          'UPDATE resident_presence SET current_place_id = $2 WHERE resident_id = $1',
          [GROWER.id, rooms.westRoomId],
        )
        const answering = answer(offered.answer.ping.id)
        await waitForLock('FOR UPDATE OF presence')
        await moveFirst.query('COMMIT')
        const lost = await answering
        assert.equal(lost.ok, false)
        if (!lost.ok) assert.equal(lost.refusal.status, 409)
      } finally {
        await moveFirst.query('ROLLBACK').catch(() => undefined)
        moveFirst.release()
      }

      await reset()
      offered = await invite()
      assert.equal(offered.ok, true)
      if (!offered.ok) return
      const eventBlocker = await db.connect()
      const moving = await db.connect()
      try {
        await eventBlocker.query('BEGIN')
        await eventBlocker.query('LOCK TABLE events IN EXCLUSIVE MODE')
        const answering = answer(offered.answer.ping.id)
        await waitForLock('INSERT INTO events')
        await moving.query('BEGIN')
        const movingPromise = moving.query(
          'UPDATE resident_presence SET current_place_id = $2 WHERE resident_id = $1',
          [GROWER.id, rooms.westRoomId],
        )
        await waitForLock('UPDATE resident_presence')
        await eventBlocker.query('COMMIT')
        const won = await answering
        assert.equal(won.ok, true)
        await movingPromise
        await moving.query('COMMIT')
      } finally {
        await eventBlocker.query('ROLLBACK').catch(() => undefined)
        await moving.query('ROLLBACK').catch(() => undefined)
        eventBlocker.release()
        moving.release()
      }
    })

    await t.test('in_a_moment closes the offer and later talk needs a new ping', async () => {
      await reset()
      const offered = await invite()
      assert.equal(offered.ok, true)
      if (!offered.ok) return
      const answered = await answer(offered.answer.ping.id, 'in_a_moment')
      assert.equal(answered.ok, true)
      if (!answered.ok) return
      assert.equal(answered.answer.ping.status, 'answered')
      assert.equal(answered.answer.ping.answer, 'in_a_moment')
      const tooSoon = await invite()
      assert.equal(tooSoon.ok, false)
      if (!tooSoon.ok) assert.equal(tooSoon.refusal.status, 429)

      await reset()
      const oldMoment = await seedPing({
        sentAgoSeconds: 1_000,
        expiresAgoSeconds: 400,
        answer: 'in_a_moment',
        answeredAgoSeconds: 500,
      })
      const next = await invite()
      assert.equal(next.ok, true)
      if (next.ok) assert.notEqual(next.answer.ping.id, oldMoment)
      assert.equal(await count('SELECT count(*)::int AS count FROM pings'), 2)
    })

    await t.test('pair waits use answer time from sent_at and miss time from expires_at', async () => {
      await reset()
      const answeredId = await seedPing({
        sentAgoSeconds: 14 * 60,
        expiresAgoSeconds: 4 * 60,
        answer: 'yes',
        answeredAgoSeconds: 5 * 60,
      })
      const answeredRow = (await db.query<{ sent_at: Date }>(
        'SELECT sent_at FROM pings WHERE id = $1', [answeredId],
      )).rows[0]!
      const afterAnswer = await invite()
      assert.equal(afterAnswer.ok, false)
      if (!afterAnswer.ok) {
        assert.equal(afterAnswer.refusal.status, 429)
        assert.equal(afterAnswer.refusal.next_allowed_at, new Date(answeredRow.sent_at.getTime() + 15 * 60_000).toISOString())
      }

      await reset()
      await seedPing({
        sentAgoSeconds: 39 * 60,
        expiresAgoSeconds: 29 * 60,
        staleArrival: true,
      })
      const afterEarlyMove = await invite()
      assert.equal(afterEarlyMove.ok, false)
      if (!afterEarlyMove.ok) {
        assert.equal(afterEarlyMove.refusal.status, 429)
        assert.ok(Date.parse(afterEarlyMove.refusal.next_allowed_at ?? '') > Date.now())
      }

      await reset()
      await seedPing({
        sentAgoSeconds: 16 * 60,
        expiresAgoSeconds: 6 * 60,
        answer: 'yes',
        answeredAgoSeconds: 7 * 60,
      })
      const afterWait = await invite()
      assert.equal(afterWait.ok, true)
    })

    await t.test('a second invite while the first is open gives its end time', async () => {
      await reset()
      const first = await invite()
      assert.equal(first.ok, true)
      if (!first.ok) return
      const second = await invite()
      assert.equal(second.ok, false)
      if (!second.ok) {
        assert.equal(second.refusal.status, 429)
        assert.equal(second.refusal.open_until, first.answer.ping.expires_at)
      }
      assert.equal(await count('SELECT count(*)::int AS count FROM pings'), 1)
    })

    await t.test('three missed pings block only their UTC day', async () => {
      await reset()
      await db.query(`
        WITH day AS MATERIALIZED (
          SELECT date_trunc('day', now(), 'UTC') AS starts_at
        ),
        offsets(milliseconds) AS (VALUES (1), (2), (3)),
        inserted AS (
          INSERT INTO pings (
            place_id, sender_id, target_id, sent_at, expires_at,
            sender_arrived_at, target_arrived_at
          )
          SELECT $1, $2, $3,
            day.starts_at + offsets.milliseconds * interval '1 millisecond',
            day.starts_at + offsets.milliseconds * interval '1 millisecond' + interval '10 minutes',
            '2000-01-01T00:00:00Z'::timestamptz,
            '2000-01-01T00:00:00Z'::timestamptz
          FROM day CROSS JOIN offsets
          RETURNING id, target_id
        )
        INSERT INTO ping_receipts (ping_id, recipient_id)
        SELECT id, target_id FROM inserted
      `, [rooms.eastRoomId, FOUNDER.id, GROWER.id])
      const blocked = await invite()
      assert.equal(blocked.ok, false)
      if (!blocked.ok) {
        assert.equal(blocked.refusal.status, 429)
        assert.match(blocked.refusal.error, /three unanswered pings/u)
        assert.ok(Date.parse(blocked.refusal.next_allowed_at ?? '') > Date.now())
      }

      await reset()
      await db.query(`
        WITH day AS MATERIALIZED (
          SELECT date_trunc('day', now(), 'UTC') - interval '1 day' + interval '22 hours' AS starts_at
        ),
        offsets(milliseconds) AS (VALUES (1), (2), (3)),
        inserted AS (
          INSERT INTO pings (
            place_id, sender_id, target_id, sent_at, expires_at,
            sender_arrived_at, target_arrived_at
          )
          SELECT $1, $2, $3,
            day.starts_at + offsets.milliseconds * interval '1 millisecond',
            day.starts_at + offsets.milliseconds * interval '1 millisecond' + interval '10 minutes',
            '2000-01-01T00:00:00Z'::timestamptz,
            '2000-01-01T00:00:00Z'::timestamptz
          FROM day CROSS JOIN offsets
          RETURNING id, target_id
        )
        INSERT INTO ping_receipts (ping_id, recipient_id)
        SELECT id, target_id FROM inserted
      `, [rooms.eastRoomId, FOUNDER.id, GROWER.id])
      const nextDay = await invite()
      assert.equal(nextDay.ok, true)
    })

    await t.test('a no blocks the sender for 24 hours unless the target pings first', async () => {
      await reset()
      await seedPing({
        sentAgoSeconds: 20 * 60,
        expiresAgoSeconds: 10 * 60,
        answer: 'no',
        answeredAgoSeconds: 11 * 60,
      })
      const blocked = await invite()
      assert.equal(blocked.ok, false)
      if (!blocked.ok) {
        assert.equal(blocked.refusal.status, 429)
        assert.match(blocked.refusal.error, /said no/u)
      }
      const targetStarts = await invite(FOUNDER.handle, GROWER)
      assert.equal(targetStarts.ok, true)
      const senderRestarts = await invite()
      assert.equal(senderRestarts.ok, true)
    })

    await t.test('a moderated ping still counts toward pair limits', async () => {
      await reset()
      const offered = await invite()
      assert.equal(offered.ok, true)
      if (!offered.ok) return
      await db.query(
        "INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason) VALUES ('ping', $1, 'remove', $2, 'test moderation')",
        [offered.answer.ping.id, FOUNDER.id],
      )
      const blocked = await invite()
      assert.equal(blocked.ok, false)
      if (!blocked.ok) {
        assert.equal(blocked.refusal.status, 429)
        assert.equal(blocked.refusal.open_until, offered.answer.ping.expires_at)
      }
      assert.equal(await count('SELECT count(*)::int AS count FROM pings'), 1)
    })

    await t.test('changing place does not reset pair history', async () => {
      await reset()
      const offered = await invite()
      assert.equal(offered.ok, true)
      if (!offered.ok) return
      await standIn(FOUNDER.id, rooms.westRoomId)
      await standIn(GROWER.id, rooms.westRoomId)
      const blocked = await invite()
      assert.equal(blocked.ok, false)
      if (!blocked.ok) assert.equal(blocked.refusal.status, 429)
      assert.equal(await count('SELECT count(*)::int AS count FROM pings'), 1)
    })

    await t.test('silence writes no answer or expiry event', async () => {
      await reset()
      const offered = await invite()
      assert.equal(offered.ok, true)
      if (!offered.ok) return
      await standIn(GROWER.id, rooms.westRoomId)
      const ping = (await db.query<{ answer: string | null; answered_at: Date | null }>(
        'SELECT answer, answered_at FROM pings WHERE id = $1', [offered.answer.ping.id],
      )).rows[0]!
      assert.equal(ping.answer, null)
      assert.equal(ping.answered_at, null)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind IN ('ping_sent', 'ping_answered', 'ping_expired')"), 1)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'ping_expired'"), 0)
    })

    await t.test('dismiss is limited to the ended receipt recipient and adds no public event', async () => {
      await reset()
      const offered = await invite()
      assert.equal(offered.ok, true)
      if (!offered.ok) return
      const wrongResident = await dismiss(offered.answer.ping.id, FOUNDER)
      assert.equal(wrongResident.ok, false)
      if (!wrongResident.ok) assert.equal(wrongResident.refusal.status, 403)
      const stillOpen = await dismiss(offered.answer.ping.id)
      assert.equal(stillOpen.ok, false)
      if (!stillOpen.ok) assert.equal(stillOpen.refusal.status, 409)
      await standIn(FOUNDER.id, rooms.westRoomId)
      const eventCount = await count("SELECT count(*)::int AS count FROM events WHERE kind LIKE 'ping_%'")
      const dismissed = await dismiss(offered.answer.ping.id)
      assert.equal(dismissed.ok, true)
      if (!dismissed.ok) return
      assert.equal(dismissed.answer.receipt.ping_id, offered.answer.ping.id)
      const after = await count("SELECT count(*)::int AS count FROM events WHERE kind LIKE 'ping_%'")
      assert.equal(after, eventCount)
      const row = (await db.query<{ dismissed_at: Date | null }>(
        'SELECT dismissed_at FROM ping_receipts WHERE ping_id = $1',
        [offered.answer.ping.id],
      )).rows[0]!
      assert.ok(row.dismissed_at instanceof Date)
    })

    await t.test('ten concurrent invites with different IDs create exactly one ping', async () => {
      await reset()
      const results = await Promise.all(Array.from({ length: 10 }, () => invite()))
      assert.equal(results.filter(result => result.ok && result.status === 201).length, 1)
      assert.equal(results.filter(result => !result.ok && result.refusal.status === 429).length, 9)
      assert.equal(await count('SELECT count(*)::int AS count FROM pings'), 1)
      assert.equal(await count('SELECT count(*)::int AS count FROM ping_operations'), 10)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'ping_sent'"), 1)
    })

    await t.test('a quiet room takes pings', async () => {
      await reset()
      await db.query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.eastRoomId])
      const result = await invite()
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.status, 201)
      assert.equal(result.answer.ping.place_id, rooms.eastRoomId)
      assert.equal(await count("SELECT count(*)::int AS count FROM events WHERE kind = 'ping_sent'"), 1)
    })
  } finally {
    await postgres.stop()
  }
})
