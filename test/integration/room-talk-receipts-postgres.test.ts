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

const EXTRA_SENDERS = Array.from({ length: 23 }, (_, index) => ({
  id: index + 5,
  handle: `sender-${String(index + 5).padStart(2, '0')}`,
  secret: `1f3d9_sk_${String(index + 5).padStart(48, '0')}`,
}))
const SENDERS = [FOUNDER, NEIGHBOUR, ...EXTRA_SENDERS] as const
const RESIDENTS = [...SENDERS, GROWER] as const

function requestId(value: number): string {
  return '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
}

test('room talk receipts stay pending until seen or dismissed in PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('room-talk-receipts')
  try {
    let rooms = await resetCity(RESIDENTS)
    for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)

    const { answerPing, dismissPing, invitePing } = await import('../../src/room-ping-store.ts')
    const { markReceiptsSeen, readPendingPings, readPendingSummary } = await import('../../src/room-receipt-store.ts')
    const db = connectedDatabase()
    let requestNumber = 1
    const nextRequestId = () => requestId(requestNumber++)

    const reset = async () => {
      rooms = await resetCity(RESIDENTS)
      for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)
    }
    const invite = async (
      sender: Readonly<{ id: number; handle: string }> = FOUNDER,
      target: Readonly<{ id: number; handle: string }> = GROWER,
    ) => {
      const result = await invitePing({
        residentId: sender.id,
        residentHandle: sender.handle,
        toHandle: target.handle,
        requestId: nextRequestId(),
      })
      if (!result.ok) assert.fail(result.refusal.error)
      assert.equal(result.status, 201)
      return result.answer.ping
    }
    const answer = async (pingId: number) => answerPing({
      residentId: GROWER.id,
      residentHandle: GROWER.handle,
      pingId,
      answer: 'yes',
      requestId: nextRequestId(),
    })
    const dismiss = async (pingId: number) => dismissPing({
      residentId: GROWER.id,
      pingId,
      requestId: nextRequestId(),
    })
    const seedPing = async (input: Readonly<{
      sender?: Readonly<{ id: number; handle: string }>
      target?: Readonly<{ id: number; handle: string }>
      answer?: 'yes' | 'no' | 'in_a_moment' | null
      answeredAgoSeconds?: number | null
    }> = {}): Promise<number> => {
      const sender = input.sender ?? FOUNDER
      const target = input.target ?? GROWER
      const inserted = await db.query<{ id: number }>(`
        WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now)
        INSERT INTO pings (
          place_id, sender_id, target_id, sent_at, expires_at,
          sender_arrived_at, target_arrived_at, answer, answered_at
        )
        SELECT $1, $2, $3,
          stamp.now - interval '30 seconds', stamp.now + interval '9 minutes 30 seconds',
          sender_presence.arrived_at, target_presence.arrived_at, $4::text,
          CASE WHEN $4::text IS NULL THEN NULL
            ELSE stamp.now - make_interval(secs => $5::double precision) END
        FROM stamp
        JOIN resident_presence sender_presence ON sender_presence.resident_id = $2
        JOIN resident_presence target_presence ON target_presence.resident_id = $3
        RETURNING id
      `, [
        rooms.eastRoomId,
        sender.id,
        target.id,
        input.answer ?? null,
        input.answeredAgoSeconds ?? 10,
      ])
      const pingId = Number(inserted.rows[0]!.id)
      await db.query('INSERT INTO ping_receipts (ping_id, recipient_id) VALUES ($1, $2)', [pingId, target.id])
      return pingId
    }
    const read = (residentId = GROWER.id, beforePingId: number | null = null, limit = 20) => readPendingPings({
      residentId,
      beforePingId,
      limit,
    })

    await t.test('a new ping is pending for its target, a seen mark or a dismissal each ends that, and answering does not', async () => {
      await reset()
      const answered = await invite()
      assert.deepEqual((await read()).receipts.map(receipt => receipt.ping_id), [answered.id])
      const answerResult = await answer(answered.id)
      assert.equal(answerResult.ok, true)
      assert.deepEqual((await read()).receipts.map(receipt => receipt.ping_id), [answered.id])
      assert.deepEqual(await markReceiptsSeen({ residentId: GROWER.id, pingIds: [answered.id] }), { marked: 1 })
      assert.equal((await read()).total, 0)

      await reset()
      const dismissed = await invite()
      await standIn(FOUNDER.id, rooms.westRoomId)
      const dismissal = await dismiss(dismissed.id)
      assert.equal(dismissal.ok, true)
      assert.equal((await read()).total, 0)
    })

    await t.test('an answered pending ping shows its answer and status answered', async () => {
      await reset()
      const ping = await invite()
      const answered = await answer(ping.id)
      assert.equal(answered.ok, true)
      const result = await read()
      assert.equal(result.total, 1)
      assert.deepEqual(result.receipts[0], {
        ping_id: ping.id,
        status: 'answered',
        place_id: rooms.eastRoomId,
        sender_id: FOUNDER.id,
        sender: FOUNDER.handle,
        sent_at: ping.sent_at,
        expires_at: ping.expires_at,
        answer: 'yes',
      })
    })

    await t.test('the first page shows the newest pending ping from each sender and counts every one exactly', async () => {
      await reset()
      const olderFounder = await seedPing({ sender: FOUNDER })
      const newestFounder = await seedPing({ sender: FOUNDER })
      const neighbour = await seedPing({ sender: NEIGHBOUR })
      const sender = EXTRA_SENDERS[0]!
      const anotherSender = await seedPing({ sender })

      const result = await read(GROWER.id, null, 20)
      assert.equal(result.total, 4)
      assert.equal(result.senders, 3)
      assert.deepEqual(result.receipts.map(receipt => receipt.ping_id), [anotherSender, neighbour, newestFounder])
      assert.equal(result.hasMore, true)
      assert.equal(result.nextBeforePingId, olderFounder + 1)
    })

    await t.test('twenty-five senders give twenty on the first page and a cursor that reaches the other five, and every invite was admitted', async () => {
      await reset()
      const pingIds: number[] = []
      for (const sender of SENDERS) pingIds.push((await invite(sender, GROWER)).id)

      const first = await read(GROWER.id, null, 20)
      assert.equal(first.total, 25)
      assert.equal(first.senders, 25)
      assert.equal(first.receipts.length, 20)
      assert.deepEqual(first.receipts.map(receipt => receipt.ping_id), pingIds.slice(5).reverse())
      assert.equal(first.hasMore, true)
      assert.equal(first.nextBeforePingId, pingIds[5])

      const overflow = await read(GROWER.id, first.nextBeforePingId, 20)
      assert.deepEqual(overflow.receipts.map(receipt => receipt.ping_id), pingIds.slice(0, 5).reverse())
      assert.equal(overflow.hasMore, false)
      assert.equal(overflow.nextBeforePingId, null)
    })

    await t.test('the cursor walk never repeats a receipt shown on the first page once it is marked seen', async () => {
      await reset()
      const unshownFromAnotherSender = await seedPing({ sender: EXTRA_SENDERS[0]! })
      const shownFromNeighbour = await seedPing({ sender: NEIGHBOUR })
      const hiddenFromFounder = await seedPing({ sender: FOUNDER })
      const shownFromFounder = await seedPing({ sender: FOUNDER })
      const first = await read(GROWER.id, null, 2)
      assert.deepEqual(first.receipts.map(receipt => receipt.ping_id), [shownFromFounder, shownFromNeighbour])
      assert.equal(first.total, 4)
      assert.equal(first.nextBeforePingId, hiddenFromFounder + 1)
      assert.deepEqual(await markReceiptsSeen({
        residentId: GROWER.id,
        pingIds: first.receipts.map(receipt => receipt.ping_id),
      }), { marked: 2 })

      const overflow = await read(GROWER.id, first.nextBeforePingId, 1)
      assert.deepEqual(overflow.receipts.map(receipt => receipt.ping_id), [hiddenFromFounder])
      assert.equal(overflow.hasMore, true)
      assert.equal(overflow.nextBeforePingId, hiddenFromFounder)

      const lastPage = await read(GROWER.id, overflow.nextBeforePingId, 1)
      assert.deepEqual(lastPage.receipts.map(receipt => receipt.ping_id), [unshownFromAnotherSender])
      assert.equal(lastPage.hasMore, false)
      const shownIds = new Set(first.receipts.map(receipt => receipt.ping_id))
      assert.equal(overflow.receipts.some(receipt => shownIds.has(receipt.ping_id)), false)
      assert.equal(lastPage.receipts.some(receipt => shownIds.has(receipt.ping_id)), false)
    })

    await t.test('marking seen touches only the named receipts of that recipient and only once', async () => {
      await reset()
      let emptyCallCount = 0
      const unusedDatabase = (() => { emptyCallCount += 1 }) as never
      assert.deepEqual(await markReceiptsSeen({ residentId: GROWER.id, pingIds: [] }, unusedDatabase), { marked: 0 })
      assert.equal(emptyCallCount, 0)

      const first = await invite(FOUNDER, GROWER)
      const remaining = await invite(NEIGHBOUR, GROWER)
      const otherRecipient = await invite(GROWER, NEIGHBOUR)

      assert.deepEqual(await markReceiptsSeen({
        residentId: GROWER.id,
        pingIds: [first.id, otherRecipient.id],
      }), { marked: 1 })
      assert.deepEqual(await markReceiptsSeen({ residentId: GROWER.id, pingIds: [first.id] }), { marked: 0 })
      const receipts = (await db.query<{ ping_id: number; recipient_id: number; seen_at: Date | null }>(
        'SELECT ping_id, recipient_id, seen_at FROM ping_receipts ORDER BY ping_id',
      )).rows
      assert.deepEqual(receipts.map(row => [row.ping_id, row.recipient_id, row.seen_at !== null]), [
        [first.id, GROWER.id, true],
        [remaining.id, GROWER.id, false],
        [otherRecipient.id, NEIGHBOUR.id, false],
      ])
    })

    await t.test('the summary names the exact count, the senders, the newest pending ping, and a cursor, and marks nothing', async () => {
      await reset()
      await seedPing({ sender: FOUNDER })
      const neighbour = await seedPing({ sender: NEIGHBOUR })
      const newestFounder = await seedPing({ sender: FOUNDER })

      assert.deepEqual(await readPendingSummary(GROWER.id), {
        total: 3,
        senders: 2,
        newest: {
          ping_id: newestFounder,
          status: 'offered',
          place_id: rooms.eastRoomId,
          sender_id: FOUNDER.id,
          sender: FOUNDER.handle,
          sent_at: (await db.query<{ sent_at: Date }>('SELECT sent_at FROM pings WHERE id = $1', [newestFounder])).rows[0]!.sent_at.toISOString(),
          expires_at: (await db.query<{ expires_at: Date }>('SELECT expires_at FROM pings WHERE id = $1', [newestFounder])).rows[0]!.expires_at.toISOString(),
          answer: null,
        },
        nextBeforePingId: newestFounder,
      })
      assert.ok(neighbour < newestFounder)
      assert.equal((await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM ping_receipts WHERE seen_at IS NOT NULL OR dismissed_at IS NOT NULL',
      )).rows[0]!.count, 0)
    })

    await t.test('an expired unanswered ping stays pending, reads expired, and cannot be answered', async () => {
      await reset()
      const ping = await invite()
      await standIn(FOUNDER.id, rooms.westRoomId)

      const pending = await read()
      assert.equal(pending.total, 1)
      assert.equal(pending.receipts[0]?.ping_id, ping.id)
      assert.equal(pending.receipts[0]?.status, 'expired')
      const answerResult = await answer(ping.id)
      assert.equal(answerResult.ok, false)
      if (!answerResult.ok) assert.equal(answerResult.refusal.status, 409)
      assert.equal((await read()).receipts[0]?.status, 'expired')
    })
  } finally {
    await postgres.stop()
  }
})
