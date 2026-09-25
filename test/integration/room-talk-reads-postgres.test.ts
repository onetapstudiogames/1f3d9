import assert from 'node:assert/strict'
import test from 'node:test'
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

test('room talk reads use shared public status and permanent transcripts in PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('room-talk-reads')
  try {
    let rooms = await resetCity(RESIDENTS)
    await standIn(FOUNDER.id, rooms.eastRoomId)
    await standIn(GROWER.id, rooms.eastRoomId)
    await standIn(NEIGHBOUR.id, rooms.eastRoomId)

    const { sayLine } = await import('../../src/room-line-store.ts')
    const { answerPing: storeAnswerPing, invitePing: storeInvitePing } = await import('../../src/room-ping-store.ts')
    const { readLine, readLineHeadings, readPing, readPlaceLines } = await import('../../src/room-talk-reads.ts')
    const { readPublicPings } = await import('../../src/room-ping-store.ts')
    const db = connectedDatabase()
    let requestNumber = 1
    const nextRequestId = () => requestId(requestNumber++)

    const reset = async () => {
      rooms = await resetCity(RESIDENTS)
      await standIn(FOUNDER.id, rooms.eastRoomId)
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
    }
    const say = async (
      resident: Readonly<{ id: number; handle: string }>,
      body: string,
    ) => {
      const result = await sayLine({
        residentId: resident.id,
        residentHandle: resident.handle,
        placeId: rooms.eastRoomId,
        body,
        requestId: nextRequestId(),
      })
      if (!result.ok) assert.fail(result.refusal.error)
      return result.answer.line
    }
    const invite = async (
      sender: Readonly<{ id: number; handle: string }>,
      target: Readonly<{ id: number; handle: string }>,
    ) => {
      const result = await storeInvitePing({
        residentId: sender.id,
        residentHandle: sender.handle,
        toHandle: target.handle,
        requestId: nextRequestId(),
      })
      if (!result.ok) assert.fail(result.refusal.error)
      return result.answer.ping
    }
    const answer = async (
      pingId: number,
      resident: Readonly<{ id: number; handle: string }>,
    ) => {
      const result = await storeAnswerPing({
        residentId: resident.id,
        residentHandle: resident.handle,
        pingId,
        answer: 'yes',
        requestId: nextRequestId(),
      })
      if (!result.ok) assert.fail(result.refusal.error)
      return result.answer.ping
    }

    await t.test('one line reads back exactly as said, and an unknown id reads as null', async () => {
      const line = await say(FOUNDER, 'The café is open 🏙')
      assert.deepEqual(await readLine(line.id), line)
      assert.equal(await readLine(2_000_000_000), null)
    })

    await t.test('a public ping read says unanswered after a move ends it, and answered with its fixed answer', async () => {
      await reset()
      const moved = await invite(FOUNDER, GROWER)
      assert.equal((await readPing(moved.id))?.status, 'unanswered')
      await standIn(FOUNDER.id, rooms.westRoomId)
      const afterMove = await readPing(moved.id)
      assert.equal(afterMove?.status, 'unanswered')
      assert.equal(afterMove?.answer, null)

      const answered = await invite(GROWER, NEIGHBOUR)
      const fixedAnswer = await answer(answered.id, NEIGHBOUR)
      const publicRead = await readPing(answered.id)
      assert.equal(publicRead?.status, 'answered')
      assert.equal(publicRead?.answer, 'yes')
      assert.equal(publicRead?.answered_at, fixedAnswer.answered_at)
    })

    await t.test('readPublicPings gives offered, answered, and expired, and skips an empty query', async () => {
      await reset()
      const offered = await invite(FOUNDER, GROWER)
      const answered = await invite(GROWER, NEIGHBOUR)
      await answer(answered.id, NEIGHBOUR)
      const expired = await invite(FOUNDER, NEIGHBOUR)
      await standIn(NEIGHBOUR.id, rooms.westRoomId)

      const pings = await readPublicPings([offered.id, answered.id, expired.id])
      assert.equal(pings.get(offered.id)?.status, 'offered')
      assert.equal(pings.get(answered.id)?.status, 'answered')
      assert.equal(pings.get(expired.id)?.status, 'expired')

      let queryCount = 0
      const unusedDatabase = (() => { queryCount += 1 }) as never
      assert.equal((await readPublicPings([], unusedDatabase)).size, 0)
      assert.equal(queryCount, 0)
    })

    await t.test('a place transcript pages newest first with exact totals and exclusive cursors', async () => {
      await reset()
      const first = await say(FOUNDER, 'first 🏙')
      const second = await say(GROWER, 'second')
      const third = await say(NEIGHBOUR, 'third 🌱')
      const totalTextBytes = [first, second, third]
        .reduce((total, line) => total + line.body_bytes, 0)

      const firstPage = await readPlaceLines({
        placeId: rooms.eastRoomId,
        beforeLineId: null,
        afterLineId: null,
        limit: 2,
      })
      assert.deepEqual(firstPage.lines.map(line => line.id), [third.id, second.id])
      assert.equal(firstPage.placeExists, true)
      assert.equal(firstPage.totalItems, 3)
      assert.equal(firstPage.totalTextBytes, totalTextBytes)
      assert.equal(firstPage.hasMore, true)

      const before = await readPlaceLines({
        placeId: rooms.eastRoomId,
        beforeLineId: third.id,
        afterLineId: null,
        limit: 2,
      })
      assert.deepEqual(before.lines.map(line => line.id), [second.id, first.id])
      assert.equal(before.hasMore, false)

      const after = await readPlaceLines({
        placeId: rooms.eastRoomId,
        beforeLineId: null,
        afterLineId: first.id,
        limit: 2,
      })
      assert.deepEqual(after.lines.map(line => line.id), [third.id, second.id])
      assert.equal(after.hasMore, false)
    })

    await t.test('a retired place still reads its transcript, and a missing place says so', async () => {
      await reset()
      const line = await say(FOUNDER, 'still on the record')
      await standIn(FOUNDER.id, rooms.westRoomId)
      await standIn(GROWER.id, rooms.westRoomId)
      await standIn(NEIGHBOUR.id, rooms.westRoomId)
      await db.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [rooms.eastRoomId])

      const retired = await readPlaceLines({
        placeId: rooms.eastRoomId,
        beforeLineId: null,
        afterLineId: null,
        limit: 10,
      })
      assert.equal(retired.placeExists, true)
      assert.deepEqual(retired.lines, [line])
      assert.equal(retired.totalItems, 1)
      assert.equal(retired.totalTextBytes, line.body_bytes)

      assert.deepEqual(await readPlaceLines({
        placeId: 2_000_000_000,
        beforeLineId: null,
        afterLineId: null,
        limit: 10,
      }), {
        placeExists: false,
        lines: [],
        totalItems: 0,
        totalTextBytes: 0,
        hasMore: false,
      })
    })

    await t.test('line headings are newest first and carry no body', async () => {
      await reset()
      const first = await say(FOUNDER, 'heading one')
      const second = await say(GROWER, 'heading two')
      const third = await say(NEIGHBOUR, 'heading three')
      const result = await readLineHeadings({ placeId: rooms.eastRoomId, limit: 2 })

      assert.deepEqual(result.headings.map(heading => heading.id), [third.id, second.id])
      assert.equal(result.total, 3)
      assert.equal('body' in result.headings[0]!, false)
      assert.deepEqual(result.headings[0], {
        id: third.id,
        author_id: NEIGHBOUR.id,
        author: NEIGHBOUR.handle,
        body_bytes: third.body_bytes,
        created_at: third.created_at,
      })
      assert.ok(first.id < second.id)
    })

    await t.test("a quiet room's lines read like any other", async () => {
      await reset()
      await db.query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.eastRoomId])
      const line = await say(FOUNDER, 'quiet room record')
      assert.deepEqual(await readLine(line.id), line)
      const transcript = await readPlaceLines({
        placeId: rooms.eastRoomId,
        beforeLineId: null,
        afterLineId: null,
        limit: 10,
      })
      assert.deepEqual(transcript.lines, [line])
      assert.equal(transcript.totalItems, 1)
    })
  } finally {
    await postgres.stop()
  }
})
