import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  call,
  type CityApp,
} from '../helpers/abilities-fixtures.ts'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const

function requestId(value: number): string {
  return '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
}

test('same-room talk HTTP routes use real PostgreSQL and preserve their public contracts', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('room-talk-routes')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { RESIDENT_AUTH_REFUSAL } = await import('../../src/core.ts')
    const {
      LINE_FIELDS_REFUSAL,
      LINE_ID_REFUSAL,
      LINE_WALK_TO_READ_REFUSAL,
      LINES_PER_UTC_DAY,
      LINES_PER_UTC_MINUTE,
      PING_ANSWER_FIELDS_REFUSAL,
      PING_DISMISS_FIELDS_REFUSAL,
      PING_ID_REFUSAL,
      PING_NOT_HERE_REFUSAL,
      PING_READ_ID_REFUSAL,
      PING_INVITE_FIELDS_REFUSAL,
      PLACE_LINES_ID_REFUSAL,
      TALK_REQUEST_ID_REFUSAL,
      lineNotFoundRefusal,
      pingPairWaitRefusal,
      pingReadNotFoundRefusal,
      placeLinesNotFoundRefusal,
      requestReuseRefusal,
    } = await import('../../src/room-talk-contract.ts')
    const assertRefusalSentence = (actual: unknown, expected: string) => {
      assert.equal(typeof actual, 'string')
      assert.ok((actual as string).startsWith(expected), String(actual))
    }
    const db = connectedDatabase()
    let rooms = await resetCity(RESIDENTS)
    let nextRequestNumber = 1
    const nextRequestId = () => requestId(nextRequestNumber++)

    const reset = async () => {
      rooms = await resetCity(RESIDENTS)
      for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)
    }
    for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)

    const count = async (table: string, where = '', values: readonly unknown[] = []) => Number(
      (await db.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM ' + table + where,
        [...values],
      )).rows[0]!.count,
    )
    const waitForLease = async (residentId: number): Promise<void> => {
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline) {
        if (await count('wait_leases', ' WHERE resident_id = $1', [residentId]) > 0) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.fail('wait route did not open a lease')
    }
    const lastEventId = async () => Number((await db.query<{ id: number }>(
      'SELECT coalesce(max(id), 0)::integer AS id FROM events',
    )).rows[0]!.id)
    const eventKindsAfter = async (id: number) => (await db.query<{ kind: string }>(
      'SELECT kind FROM events WHERE id > $1 ORDER BY id',
      [id],
    )).rows.map(row => row.kind)
    const postWithHeaders = async (secret: string | null, path: string, body: unknown) => {
      const headers = new Headers(secret === null ? {} : bearer(secret))
      headers.set('Content-Type', 'application/json')
      return app.request('http://city.test' + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    }
    const seedHistoricalPing = async (input: Readonly<{
      sender: Readonly<{ id: number; handle: string }>
      target: Readonly<{ id: number; handle: string }>
      sentAgoSeconds: number
      expiresAgoSeconds: number
      answer?: 'yes' | 'no' | 'in_a_moment' | null
      answeredAgoSeconds?: number | null
    }>): Promise<number> => {
      const rows = await db.query<{ id: number }>(
        `WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now),
         inserted AS (
           INSERT INTO pings (
             place_id, sender_id, target_id, sent_at, expires_at,
             sender_arrived_at, target_arrived_at, answer, answered_at
           )
           SELECT $1, $2, $3,
             stamp.now - make_interval(secs => $4::double precision),
             stamp.now - make_interval(secs => $5::double precision),
             sender_presence.arrived_at, target_presence.arrived_at, $6::text,
             CASE WHEN $6::text IS NULL THEN NULL
               ELSE stamp.now - make_interval(secs => $7::double precision) END
           FROM stamp
           JOIN resident_presence sender_presence ON sender_presence.resident_id = $2
           JOIN resident_presence target_presence ON target_presence.resident_id = $3
           RETURNING id, target_id
         )
         INSERT INTO ping_receipts (ping_id, recipient_id)
         SELECT id, target_id FROM inserted
         RETURNING ping_id AS id`,
        [
          rooms.eastRoomId,
          input.sender.id,
          input.target.id,
          input.sentAgoSeconds,
          input.expiresAgoSeconds,
          input.answer ?? null,
          input.answeredAgoSeconds ?? null,
        ],
      )
      return Number(rows.rows[0]!.id)
    }
    const headersAreNoStore = (response: Response) => {
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
      assert.equal(response.headers.get('Pragma'), 'no-cache')
      assert.equal(response.headers.get('Vary'), 'Authorization')
    }

    await t.test('a resident in a quiet room says a line over HTTP with allowance and no settling', async () => {
      await reset()
      await db.query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.eastRoomId])
      const beforeEventId = await lastEventId()
      const result = await call(app, FOUNDER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId,
        body: 'hello',
        request_id: nextRequestId(),
      })
      assert.equal(result.status, 201)
      const line = result.json.line as Record<string, unknown>
      assert.equal(line.place_id, rooms.eastRoomId)
      assert.equal(line.author_id, FOUNDER.id)
      assert.equal(line.body, 'hello')
      assert.equal(line.body_bytes, 5)
      assert.equal(result.json.replayed, false)
      const allowance = result.json.line_quota as {
        per_utc_minute: Record<string, unknown>
        per_utc_day: Record<string, unknown>
      }
      assert.equal(allowance.per_utc_minute.used, 1)
      assert.equal(allowance.per_utc_minute.limit, LINES_PER_UTC_MINUTE)
      assert.equal(typeof allowance.per_utc_minute.reset_at, 'string')
      assert.equal(allowance.per_utc_day.used, 1)
      assert.equal(allowance.per_utc_day.limit, LINES_PER_UTC_DAY)
      assert.equal(typeof allowance.per_utc_day.reset_at, 'string')
      assert.equal(Object.hasOwn(result.json, 'settle'), false)
      assert.deepEqual(await eventKindsAfter(beforeEventId), ['line_said'])

      const savedRequestId = (await db.query<{ request_id: string }>(
        'SELECT request_id::text FROM room_lines WHERE id = $1',
        [line.id],
      )).rows[0]!.request_id
      const replay = await postWithHeaders(FOUNDER.secret, '/api/line', {
        place_id: rooms.eastRoomId,
        body: 'hello',
        request_id: savedRequestId,
      })
      headersAreNoStore(replay)
    })

    await t.test('an exact line retry replays and a changed body cannot reuse its request id', async () => {
      await reset()
      const body = { place_id: rooms.eastRoomId, body: 'same line', request_id: nextRequestId() }
      const first = await call(app, GROWER.secret, 'POST', '/api/line', body)
      const retry = await call(app, GROWER.secret, 'POST', '/api/line', body)
      const changed = await call(app, GROWER.secret, 'POST', '/api/line', { ...body, body: 'changed line' })
      assert.equal(first.status, 201)
      assert.equal(retry.status, 200)
      assert.equal(retry.json.replayed, true)
      assert.deepEqual(retry.json.line, first.json.line)
      assert.equal(changed.status, 409)
      assert.equal(changed.json.error, requestReuseRefusal('line').error)
      assert.equal(await count('room_lines'), 1)
    })

    await t.test('walk_to_read false is allowed, while true, a string, and unknown fields have their own refusal', async () => {
      await reset()
      const accepted = await call(app, FOUNDER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId,
        body: 'false is a harmless default',
        request_id: nextRequestId(),
        walk_to_read: false,
      })
      assert.equal(accepted.status, 201)
      for (const value of [true, 'false']) {
        const refused = await call(app, FOUNDER.secret, 'POST', '/api/line', {
          place_id: rooms.eastRoomId,
          body: 'refused line',
          request_id: nextRequestId(),
          walk_to_read: value,
        })
        assert.equal(refused.status, 400)
        assertRefusalSentence(refused.json.error, LINE_WALK_TO_READ_REFUSAL.error)
      }
      const extra = await call(app, FOUNDER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId,
        body: 'refused extra field',
        request_id: nextRequestId(),
        extra: true,
      })
      assert.equal(extra.status, 400)
      assertRefusalSentence(extra.json.error, LINE_FIELDS_REFUSAL.error)
      const nonObject = await call(app, FOUNDER.secret, 'POST', '/api/line', [])
      assert.equal(nonObject.status, 400)
      assertRefusalSentence(nonObject.json.error, LINE_FIELDS_REFUSAL.error)
      assert.equal(await count('room_lines'), 1)
    })

    await t.test('every talk write requires a resident key and leaves no rows without one', async () => {
      await reset()
      const before = {
        lines: await count('room_lines'),
        pings: await count('pings'),
        operations: await count('ping_operations'),
        events: await count('events'),
      }
      const writes = [
        ['/api/line', { place_id: rooms.eastRoomId, body: 'no key', request_id: nextRequestId() }],
        ['/api/ping', { to_handle: GROWER.handle, request_id: nextRequestId() }],
        ['/api/ping/1/answer', { answer: 'yes', request_id: nextRequestId() }],
        ['/api/ping/1/dismiss', { request_id: nextRequestId() }],
      ] as const
      for (const [path, body] of writes) {
        const result = await postWithHeaders(null, path, body)
        assert.equal(result.status, 401)
        headersAreNoStore(result)
        assert.equal((await result.json() as Record<string, unknown>).error, RESIDENT_AUTH_REFUSAL)
      }
      assert.deepEqual({
        lines: await count('room_lines'),
        pings: await count('pings'),
        operations: await count('ping_operations'),
        events: await count('events'),
      }, before)
    })

    await t.test('invite, answer, and ended-ping dismissal return their shapes and only store-owned events', async () => {
      await reset()
      const beforeEventId = await lastEventId()
      const inviteBody = { to_handle: GROWER.handle, request_id: nextRequestId() }
      const invited = await call(app, FOUNDER.secret, 'POST', '/api/ping', inviteBody)
      assert.equal(invited.status, 201)
      const ping = invited.json.ping as Record<string, unknown>
      assert.equal(ping.status, 'offered')
      assert.equal(ping.sender_id, FOUNDER.id)
      assert.equal(ping.target_id, GROWER.id)
      assert.equal(ping.answer, null)
      assert.equal(invited.json.replayed, false)
      const inviteReplay = await postWithHeaders(FOUNDER.secret, '/api/ping', inviteBody)
      headersAreNoStore(inviteReplay)
      assert.equal(inviteReplay.status, 200)

      const answered = await call(app, GROWER.secret, 'POST', '/api/ping/' + ping.id + '/answer', {
        answer: 'yes',
        request_id: nextRequestId(),
      })
      assert.equal(answered.status, 200)
      assert.equal(answered.json.replayed, false)
      assert.equal((answered.json.ping as Record<string, unknown>).answer, 'yes')
      assert.equal((answered.json.ping as Record<string, unknown>).status, 'answered')
      const answerRequestId = (await db.query<{ request_id: string }>(
        'SELECT request_id::text FROM ping_operations WHERE operation = $1 AND ping_id = $2',
        ['answer', ping.id],
      )).rows[0]!.request_id
      const answerReplay = await postWithHeaders(GROWER.secret, '/api/ping/' + ping.id + '/answer', {
        answer: 'yes',
        request_id: answerRequestId,
      })
      headersAreNoStore(answerReplay)
      assert.equal(answerReplay.status, 200)

      const endedId = await seedHistoricalPing({
        sender: FOUNDER,
        target: NEIGHBOUR,
        sentAgoSeconds: 660,
        expiresAgoSeconds: 60,
      })
      const dismissed = await call(app, NEIGHBOUR.secret, 'POST', '/api/ping/' + endedId + '/dismiss', {
        request_id: nextRequestId(),
      })
      assert.equal(dismissed.status, 200)
      assert.equal(dismissed.json.replayed, false)
      assert.equal((dismissed.json.receipt as Record<string, unknown>).ping_id, endedId)
      assert.equal(typeof (dismissed.json.receipt as Record<string, unknown>).dismissed_at, 'string')
      const dismissRequestId = (await db.query<{ request_id: string }>(
        'SELECT request_id::text FROM ping_operations WHERE operation = $1 AND ping_id = $2',
        ['dismiss', endedId],
      )).rows[0]!.request_id
      const dismissReplay = await postWithHeaders(NEIGHBOUR.secret, '/api/ping/' + endedId + '/dismiss', {
        request_id: dismissRequestId,
      })
      headersAreNoStore(dismissReplay)
      assert.equal(dismissReplay.status, 200)
      assert.deepEqual(await eventKindsAfter(beforeEventId), ['ping_sent', 'ping_answered'])
    })

    await t.test('absent, elsewhere, and unknown handles share one replayable refusal without public records', async () => {
      await reset()
      await standIn(NEIGHBOUR.id, rooms.westRoomId)
      const beforePings = await count('pings')
      const beforeEvents = await count('events')
      const fields = await call(app, FOUNDER.secret, 'POST', '/api/ping', {
        to_handle: GROWER.handle,
        request_id: nextRequestId(),
        extra: true,
      })
      assert.equal(fields.status, 400)
      assert.equal(fields.json.error, PING_INVITE_FIELDS_REFUSAL.error)
      for (const handle of ['absent-resident', NEIGHBOUR.handle, 'unknown-resident']) {
        const body = { to_handle: handle, request_id: nextRequestId() }
        const first = await call(app, FOUNDER.secret, 'POST', '/api/ping', body)
        const replay = await call(app, FOUNDER.secret, 'POST', '/api/ping', body)
        assert.equal(first.status, 403)
        assert.equal(replay.status, 403)
        assertRefusalSentence(first.json.error, PING_NOT_HERE_REFUSAL.error)
        assertRefusalSentence(replay.json.error, PING_NOT_HERE_REFUSAL.error)
      }
      assert.equal(await count('pings'), beforePings)
      assert.equal(await count('events'), beforeEvents)
    })

    await t.test('a pair wait is 429 with next_allowed_at and exact refusal replay survives its end', async () => {
      await reset()
      await seedHistoricalPing({
        sender: FOUNDER,
        target: GROWER,
        sentAgoSeconds: 897,
        expiresAgoSeconds: 297,
        answer: 'yes',
        answeredAgoSeconds: 298,
      })
      const body = { to_handle: GROWER.handle, request_id: nextRequestId() }
      const refused = await call(app, FOUNDER.secret, 'POST', '/api/ping', body)
      assert.equal(refused.status, 429)
      const nextAllowedAt = String(refused.json.next_allowed_at)
      assertRefusalSentence(refused.json.error, pingPairWaitRefusal(nextAllowedAt).error)
      let waitEnded = (await db.query<{ ended: boolean }>(
        'SELECT clock_timestamp() >= $1::timestamptz AS ended', [nextAllowedAt],
      )).rows[0]!.ended
      while (!waitEnded) {
        await new Promise(resolve => setTimeout(resolve, 10))
        waitEnded = (await db.query<{ ended: boolean }>(
          'SELECT clock_timestamp() >= $1::timestamptz AS ended', [nextAllowedAt],
        )).rows[0]!.ended
      }
      const replay = await call(app, FOUNDER.secret, 'POST', '/api/ping', body)
      assert.equal(replay.status, 429)
      assert.equal(replay.json.next_allowed_at, nextAllowedAt)
      assertRefusalSentence(replay.json.error, pingPairWaitRefusal(nextAllowedAt).error)
      const newInvite = await call(app, FOUNDER.secret, 'POST', '/api/ping', {
        to_handle: GROWER.handle,
        request_id: nextRequestId(),
      })
      assert.equal(newInvite.status, 201)
    })

    await t.test('answer and dismissal use the address id and pass field, request, and id errors through', async () => {
      await reset()
      const answerBody = { answer: 'yes', request_id: nextRequestId() }
      const answerExtra = await call(app, GROWER.secret, 'POST', '/api/ping/3/answer', {
        ...answerBody,
        unexpected: true,
      })
      assert.equal(answerExtra.status, 400)
      assert.equal(answerExtra.json.error, PING_ANSWER_FIELDS_REFUSAL.error)
      const answerRequest = await call(app, GROWER.secret, 'POST', '/api/ping/3/answer', {
        answer: 'yes',
        request_id: 'not-a-uuid',
      })
      assert.equal(answerRequest.status, 400)
      assert.equal(answerRequest.json.error, TALK_REQUEST_ID_REFUSAL.error)
      const answerId = await call(app, GROWER.secret, 'POST', '/api/ping/nope/answer', answerBody)
      assert.equal(answerId.status, 400)
      assert.equal(answerId.json.error, PING_ID_REFUSAL.error)

      const dismissBody = { request_id: nextRequestId() }
      const dismissExtra = await call(app, GROWER.secret, 'POST', '/api/ping/3/dismiss', {
        ...dismissBody,
        unexpected: true,
      })
      assert.equal(dismissExtra.status, 400)
      assert.equal(dismissExtra.json.error, PING_DISMISS_FIELDS_REFUSAL.error)
      const dismissRequest = await call(app, GROWER.secret, 'POST', '/api/ping/3/dismiss', {
        request_id: 'not-a-uuid',
      })
      assert.equal(dismissRequest.status, 400)
      assert.equal(dismissRequest.json.error, TALK_REQUEST_ID_REFUSAL.error)
      const dismissId = await call(app, GROWER.secret, 'POST', '/api/ping/nope/dismiss', dismissBody)
      assert.equal(dismissId.status, 400)
      assert.equal(dismissId.json.error, PING_ID_REFUSAL.error)
      assert.equal(await count('pings'), 0)
    })

    await t.test('public reads are anonymous, validate ids and options, and page newest first', async () => {
      await reset()
      const ids: number[] = []
      for (const text of ['oldest', 'middle', 'newest']) {
        const result = await call(app, FOUNDER.secret, 'POST', '/api/line', {
          place_id: rooms.eastRoomId,
          body: text,
          request_id: nextRequestId(),
        })
        assert.equal(result.status, 201)
        ids.push(Number((result.json.line as Record<string, unknown>).id))
      }
      const pingResult = await call(app, FOUNDER.secret, 'POST', '/api/ping', {
        to_handle: GROWER.handle,
        request_id: nextRequestId(),
      })
      const pingId = Number((pingResult.json.ping as Record<string, unknown>).id)
      const directLine = await call(app, null, 'GET', '/api/line/' + ids[2])
      const directPing = await call(app, null, 'GET', '/api/ping/' + pingId)
      assert.equal(directLine.status, 200)
      assert.equal((directLine.json.line as Record<string, unknown>).id, ids[2])
      assert.equal(directPing.status, 200)
      assert.equal((directPing.json.ping as Record<string, unknown>).id, pingId)
      const page = await call(app, null, 'GET', '/api/place/' + rooms.eastRoomId + '/lines?limit=2')
      assert.equal(page.status, 200)
      assert.deepEqual((page.json.lines as Record<string, unknown>[]).map(line => line.id), [ids[2], ids[1]])
      assert.deepEqual(page.json.lines_page, {
        total_items: 3,
        total_text_bytes: 18,
        returned_items: 2,
        returned_text_bytes: 12,
        has_more: true,
        next_before_line_id: ids[1],
      })

      const invalids = [
        ['/api/line/0', LINE_ID_REFUSAL.error],
        ['/api/ping/nope', PING_READ_ID_REFUSAL.error],
        ['/api/place/0/lines', PLACE_LINES_ID_REFUSAL.error],
      ] as const
      for (const [path, error] of invalids) {
        const result = await call(app, null, 'GET', path)
        assert.equal(result.status, 400)
        assert.equal(result.json.error, error)
      }
      const missingLine = await call(app, null, 'GET', '/api/line/2000000000')
      const missingPing = await call(app, null, 'GET', '/api/ping/2000000000')
      const missingPlace = await call(app, null, 'GET', '/api/place/2000000000/lines')
      assert.equal(missingLine.status, 404)
      assert.equal(missingPing.status, 404)
      assert.equal(missingPlace.status, 404)
      assert.equal(missingLine.json.error, lineNotFoundRefusal(2_000_000_000).error)
      assert.equal(missingPing.json.error, pingReadNotFoundRefusal(2_000_000_000).error)
      assert.equal(missingPlace.json.error, placeLinesNotFoundRefusal(2_000_000_000).error)
      for (const path of [
        '/api/line/' + ids[0] + '?unknown=1',
        '/api/ping/' + pingId + '?unknown=1',
        '/api/place/' + rooms.eastRoomId + '/lines?unknown=1',
        '/api/place/' + rooms.eastRoomId + '/lines?limit=0',
      ]) assert.equal((await call(app, null, 'GET', path)).status, 400)
    })

    await t.test('a place read lists body-free line headings newest first with the transcript address', async () => {
      await reset()
      const ids: number[] = []
      for (const body of ['oldest heading', 'middle heading', 'newest heading']) {
        const result = await call(app, FOUNDER.secret, 'POST', '/api/line', {
          place_id: rooms.eastRoomId,
          body,
          request_id: nextRequestId(),
        })
        assert.equal(result.status, 201)
        ids.push(Number((result.json.line as Record<string, unknown>).id))
      }

      const response = await call(app, null, 'GET', '/api/place/' + rooms.eastRoomId)
      assert.equal(response.status, 200)
      const headings = response.json.line_headings as Record<string, unknown>[]
      assert.deepEqual(headings.map(heading => heading.id), [...ids].reverse())
      assert.equal(headings.every(heading => !('body' in heading)), true)
      assert.deepEqual(response.json.line_headings_page, {
        total_items: 3,
        returned_items: 3,
        has_more: false,
        read: '/api/place/' + rooms.eastRoomId + '/lines',
      })
    })

    await t.test('a place read lists a resident as listening only while its wait is open and it has not moved', async () => {
      await reset()
      const placePath = '/api/place/' + rooms.eastRoomId
      const before = await call(app, null, 'GET', placePath)
      assert.deepEqual(before.json.listening_residents, [])
      assert.deepEqual(before.json.listening_residents_page, {
        total_items: 0,
        returned_items: 0,
        has_more: false,
      })

      const firstWait = call(app, FOUNDER.secret, 'POST', '/api/wait-here', { seconds: 5 })
      await waitForLease(FOUNDER.id)
      const listening = await call(app, null, 'GET', placePath)
      const listeners = listening.json.listening_residents as Record<string, unknown>[]
      assert.equal(listeners.length, 1)
      assert.equal(listeners[0]?.resident_id, FOUNDER.id)
      assert.equal(listeners[0]?.handle, FOUNDER.handle)
      assert.equal(typeof listeners[0]?.listening_until, 'string')
      assert.deepEqual(listening.json.listening_residents_page, {
        total_items: 1,
        returned_items: 1,
        has_more: false,
      })

      const said = await call(app, GROWER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId,
        body: 'end the first wait',
        request_id: nextRequestId(),
      })
      assert.equal(said.status, 201)
      const firstAnswer = await firstWait
      assert.equal(firstAnswer.status, 200)
      assert.equal(firstAnswer.json.reason, 'change')
      const afterWait = await call(app, null, 'GET', placePath)
      assert.deepEqual(afterWait.json.listening_residents, [])

      const secondWait = call(app, FOUNDER.secret, 'POST', '/api/wait-here', { seconds: 5 })
      await waitForLease(FOUNDER.id)
      await standIn(FOUNDER.id, rooms.westRoomId)
      const afterMove = await call(app, null, 'GET', placePath)
      assert.deepEqual(afterMove.json.listening_residents, [])
      const secondAnswer = await secondWait
      assert.equal(secondAnswer.status, 200)
      assert.equal(secondAnswer.json.reason, 'moved')
    })

    await t.test('public ping reads show unanswered for offered or expired and answered after a yes', async () => {
      await reset()
      const offered = await call(app, FOUNDER.secret, 'POST', '/api/ping', {
        to_handle: GROWER.handle,
        request_id: nextRequestId(),
      })
      const offeredId = Number((offered.json.ping as Record<string, unknown>).id)
      const offeredRead = await call(app, null, 'GET', '/api/ping/' + offeredId)
      assert.equal((offeredRead.json.ping as Record<string, unknown>).status, 'unanswered')
      assert.equal(JSON.stringify(offeredRead.json).includes('offered'), false)
      await standIn(GROWER.id, rooms.westRoomId)
      const expiredRead = await call(app, null, 'GET', '/api/ping/' + offeredId)
      assert.equal((expiredRead.json.ping as Record<string, unknown>).status, 'unanswered')
      assert.equal(JSON.stringify(expiredRead.json).includes('expired'), false)

      await reset()
      const second = await call(app, GROWER.secret, 'POST', '/api/ping', {
        to_handle: NEIGHBOUR.handle,
        request_id: nextRequestId(),
      })
      const secondId = Number((second.json.ping as Record<string, unknown>).id)
      await call(app, NEIGHBOUR.secret, 'POST', '/api/ping/' + secondId + '/answer', {
        answer: 'yes',
        request_id: nextRequestId(),
      })
      const answeredRead = await call(app, null, 'GET', '/api/ping/' + secondId)
      const publicPing = answeredRead.json.ping as Record<string, unknown>
      assert.equal(publicPing.status, 'answered')
      assert.equal(publicPing.answer, 'yes')
      assert.equal('expires_at' in publicPing, true)
    })

    await t.test('a quiet room line and ping read anonymously at their own addresses', async () => {
      await reset()
      await db.query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.eastRoomId])
      const lineResult = await call(app, FOUNDER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId,
        body: 'quiet line',
        request_id: nextRequestId(),
      })
      const pingResult = await call(app, FOUNDER.secret, 'POST', '/api/ping', {
        to_handle: GROWER.handle,
        request_id: nextRequestId(),
      })
      const lineId = Number((lineResult.json.line as Record<string, unknown>).id)
      const pingId = Number((pingResult.json.ping as Record<string, unknown>).id)
      assert.equal((await call(app, null, 'GET', '/api/line/' + lineId)).status, 200)
      assert.equal((await call(app, null, 'GET', '/api/ping/' + pingId)).status, 200)
    })

    await t.test('a removed line reads as its id and moderation marker directly and in the transcript', async () => {
      await reset()
      const said = await call(app, GROWER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId,
        body: 'moderated body',
        request_id: nextRequestId(),
      })
      const lineId = Number((said.json.line as Record<string, unknown>).id)
      const removed = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action: 'remove',
        target_type: 'line',
        target_id: lineId,
        reason: 'remove this line',
      })
      assert.equal(removed.status, 201)
      const direct = await call(app, null, 'GET', '/api/line/' + lineId)
      const transcript = await call(app, null, 'GET', '/api/place/' + rooms.eastRoomId + '/lines')
      const directMarker = direct.json.line as Record<string, unknown>
      const transcriptMarker = (transcript.json.lines as Record<string, unknown>[])[0]!
      for (const marker of [directMarker, transcriptMarker]) {
        assert.deepEqual(Object.keys(marker).sort(), ['id', 'moderated', 'moderation'])
        assert.equal(marker.id, lineId)
        assert.equal(marker.moderated, true)
        assert.equal((marker.moderation as Record<string, unknown>).reason, 'remove this line')
      }
    })
  } finally {
    await postgres.stop()
  }
})
