import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import {
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  type CityApp,
} from '../helpers/abilities-fixtures.ts'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const EXTRA_SENDERS = Array.from({ length: 23 }, (_, index) => ({
  id: index + 5,
  handle: `talk-sender-${String(index + 5).padStart(2, '0')}`,
  secret: `1f3d9_sk_${String(index + 5).padStart(48, '0')}`,
}))
const SENDERS = [FOUNDER, NEIGHBOUR, ...EXTRA_SENDERS] as const
const RESIDENTS = [...SENDERS, GROWER] as const

function requestId(value: number): string {
  return '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
}

test('me pages pending room pings and signed in tools carry their summary', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('room-talk-me')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { PENDING_PAGE_REFUSAL } = await import('../../src/room-talk-contract.ts')
    const db = connectedDatabase()
    let rooms = await resetCity(RESIDENTS)
    let requestNumber = 1

    const nextRequestId = () => requestId(requestNumber++)
    const reset = async () => {
      rooms = await resetCity(RESIDENTS)
      for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)
    }
    for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)

    const me = async (query = '', secret = GROWER.secret) => {
      const response = await app.request(`http://city.test/api/me${query}`, {
        headers: bearer(secret),
      })
      const text = await response.text()
      return Object.freeze({
        status: response.status,
        text,
        json: text === '' ? {} : JSON.parse(text) as Record<string, unknown>,
      })
    }
    const invite = async (
      sender: Readonly<{ id: number; handle: string; secret: string }>,
      target: Readonly<{ id: number; handle: string; secret: string }> = GROWER,
    ) => {
      const response = await app.request('http://city.test/api/ping', {
        method: 'POST',
        headers: bearer(sender.secret),
        body: JSON.stringify({ to_handle: target.handle, request_id: nextRequestId() }),
      })
      const json = await response.json() as Record<string, unknown>
      assert.equal(response.status, 201, JSON.stringify(json))
      return json.ping as Record<string, unknown>
    }
    const seedPing = async (
      sender: Readonly<{ id: number; handle: string }>,
      target: Readonly<{ id: number; handle: string }> = GROWER,
      answer: 'yes' | 'no' | 'in_a_moment' | null = null,
    ): Promise<number> => {
      const inserted = await db.query<{ id: number }>(`
        WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now)
        INSERT INTO pings (
          place_id, sender_id, target_id, sent_at, expires_at,
          sender_arrived_at, target_arrived_at, answer, answered_at
        )
        SELECT $1, $2, $3,
          stamp.now - interval '30 seconds', stamp.now + interval '9 minutes 30 seconds',
          sender_presence.arrived_at, target_presence.arrived_at, $4::text,
          CASE WHEN $4::text IS NULL THEN NULL ELSE stamp.now - interval '10 seconds' END
        FROM stamp
        JOIN resident_presence sender_presence ON sender_presence.resident_id = $2
        JOIN resident_presence target_presence ON target_presence.resident_id = $3
        RETURNING id
      `, [rooms.eastRoomId, sender.id, target.id, answer])
      const pingId = Number(inserted.rows[0]!.id)
      await db.query('INSERT INTO ping_receipts (ping_id, recipient_id) VALUES ($1, $2)', [pingId, target.id])
      return pingId
    }
    const receiptRows = async (residentId: number = GROWER.id) => (await db.query<{
      ping_id: number
      seen_at: Date | null
      dismissed_at: Date | null
    }>(`
      SELECT ping_id, seen_at, dismissed_at
      FROM ping_receipts
      WHERE recipient_id = $1
      ORDER BY ping_id
    `, [residentId])).rows
    const addWalkNote = async (): Promise<number> => {
      const response = await app.request('http://city.test/api/note', {
        method: 'POST',
        headers: bearer(GROWER.secret),
        body: JSON.stringify({
          place_id: rooms.eastRoomId,
          body: 'a note for this room',
          walk_to_read: true,
        }),
      })
      const json = await response.json() as { note: { id: number } }
      assert.equal(response.status, 201)
      return Number(json.note.id)
    }
    const tool = async (
      name: string,
      args: Record<string, unknown>,
      secret = GROWER.secret,
      cityApp: CityApp = app,
    ): Promise<Record<string, unknown>> => {
      const response = await cityApp.request('http://city.test/mcp', {
        method: 'POST',
        headers: bearer(secret),
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
        }),
      })
      const rpc = await response.json() as {
        result: { isError: boolean; content: Array<{ text: string }> }
      }
      assert.equal(response.status, 200)
      assert.equal(rpc.result.isError, false, rpc.result.content[0]?.text)
      return JSON.parse(rpc.result.content[0]!.text) as Record<string, unknown>
    }

    await t.test('me puts pending_pings first with exact counts and the newest ping from each sender, then marks those seen', async () => {
      await reset()
      const olderFounder = await seedPing(FOUNDER)
      const neighbour = await seedPing(NEIGHBOUR)
      const newestFounder = await seedPing(FOUNDER)

      const result = await me()
      assert.equal(result.status, 200)
      assert.equal(result.text.startsWith('{"pending_pings":'), true)
      assert.equal(Object.keys(result.json)[0], 'pending_pings')
      assert.deepEqual(result.json.pending_pings, {
        total: 3,
        senders: 2,
        receipts: [
          {
            ping_id: newestFounder,
            status: 'offered',
            place_id: rooms.eastRoomId,
            sender_id: FOUNDER.id,
            sender: FOUNDER.handle,
            sent_at: (result.json.pending_pings as { receipts: Array<{ sent_at: string }> }).receipts[0]!.sent_at,
            expires_at: (result.json.pending_pings as { receipts: Array<{ expires_at: string }> }).receipts[0]!.expires_at,
            answer: null,
          },
          {
            ping_id: neighbour,
            status: 'offered',
            place_id: rooms.eastRoomId,
            sender_id: NEIGHBOUR.id,
            sender: NEIGHBOUR.handle,
            sent_at: (result.json.pending_pings as { receipts: Array<{ sent_at: string }> }).receipts[1]!.sent_at,
            expires_at: (result.json.pending_pings as { receipts: Array<{ expires_at: string }> }).receipts[1]!.expires_at,
            answer: null,
          },
        ],
        has_more: true,
        next_pending_before_ping_id: olderFounder + 1,
      })
      assert.deepEqual((await receiptRows()).map(row => [row.ping_id, row.seen_at !== null]), [
        [olderFounder, false], [neighbour, true], [newestFounder, true],
      ])
    })

    await t.test('a second me shows the pings the first did not and the cursor pages the rest', async () => {
      await reset()
      const olderFounder = await seedPing(FOUNDER)
      await seedPing(NEIGHBOUR)
      const newestFounder = await seedPing(FOUNDER)
      const newestOther = await seedPing(EXTRA_SENDERS[0]!)

      const first = await me('?pending_limit=1')
      const firstPage = first.json.pending_pings as Record<string, unknown>
      assert.equal(first.status, 200)
      assert.deepEqual((firstPage.receipts as Array<{ ping_id: number }>).map(row => row.ping_id), [newestOther])
      assert.equal(firstPage.next_pending_before_ping_id, olderFounder + 3)

      const second = await me(`?pending_before_ping_id=${firstPage.next_pending_before_ping_id}&pending_limit=2`)
      const secondPage = second.json.pending_pings as Record<string, unknown>
      assert.equal(second.status, 200)
      assert.deepEqual((secondPage.receipts as Array<{ ping_id: number }>).map(row => row.ping_id), [newestFounder, olderFounder + 1])
      assert.equal(secondPage.has_more, true)
      assert.equal(secondPage.next_pending_before_ping_id, olderFounder + 1)

      const third = await me(`?pending_before_ping_id=${secondPage.next_pending_before_ping_id}&pending_limit=2`)
      const thirdPage = third.json.pending_pings as Record<string, unknown>
      assert.equal(third.status, 200)
      assert.deepEqual((thirdPage.receipts as Array<{ ping_id: number }>).map(row => row.ping_id), [olderFounder])
      assert.equal(thirdPage.has_more, false)
      assert.equal(thirdPage.next_pending_before_ping_id, null)
      assert.equal((await receiptRows()).every(row => row.seen_at !== null), true)
    })

    await t.test('twenty-five senders all ping one resident and me pages all twenty-five', async () => {
      await reset()
      const pingIds: number[] = []
      for (const sender of SENDERS) pingIds.push(Number((await invite(sender)).id))

      const first = await me()
      const firstPage = first.json.pending_pings as Record<string, unknown>
      assert.equal(first.status, 200)
      assert.equal(firstPage.total, 25)
      assert.equal(firstPage.senders, 25)
      assert.deepEqual((firstPage.receipts as Array<{ ping_id: number }>).map(row => row.ping_id), pingIds.slice(5).reverse())
      assert.equal(firstPage.has_more, true)
      assert.equal(firstPage.next_pending_before_ping_id, pingIds[5])

      const overflow = await me(`?pending_before_ping_id=${firstPage.next_pending_before_ping_id}`)
      const overflowPage = overflow.json.pending_pings as Record<string, unknown>
      assert.equal(overflow.status, 200)
      assert.equal(overflowPage.total, 5)
      assert.equal(overflowPage.senders, 5)
      assert.deepEqual((overflowPage.receipts as Array<{ ping_id: number }>).map(row => row.ping_id), pingIds.slice(0, 5).reverse())
      assert.equal(overflowPage.has_more, false)
      assert.equal(overflowPage.next_pending_before_ping_id, null)
      assert.equal((await receiptRows()).every(row => row.seen_at !== null), true)
    })

    await t.test('a bad pending cursor or pending_limit of 21 is refused with the exact sentence', async () => {
      await reset()
      const badCursor = await me('?pending_before_ping_id=0')
      const badLimit = await me('?pending_limit=21')
      assert.equal(badCursor.status, 400)
      assert.equal(badLimit.status, 400)
      assert.equal((badCursor.json.error as string).split('\n')[0], PENDING_PAGE_REFUSAL.error)
      assert.equal((badLimit.json.error as string).split('\n')[0], PENDING_PAGE_REFUSAL.error)
    })

    await t.test('a signed in MCP answer has a pending summary while keyed look, later_holder_items, and plain HTTP do not', async () => {
      await reset()
      await invite(GROWER, FOUNDER)
      const secondWaitingPing = await invite(NEIGHBOUR, FOUNDER)
      const noteId = await addWalkNote()

      const toolAnswer = await tool('read_here', { note_id: noteId }, FOUNDER.secret)
      assert.equal(Object.keys(toolAnswer)[0], 'pending_pings')
      assert.equal((toolAnswer.pending_pings as Record<string, unknown>).total, 2)
      assert.equal((toolAnswer.pending_pings as Record<string, unknown>).next_pending_before_ping_id, secondWaitingPing.id)

      const keyedLook = await tool('look', { place_id: rooms.eastRoomId }, FOUNDER.secret)
      const laterHolder = await tool('later_holder_items', { mode: 'later_holder_notice' }, FOUNDER.secret)
      const direct = await app.request(`http://city.test/api/note/${noteId}/here`, {
        headers: bearer(FOUNDER.secret),
      })
      const directBody = await direct.json() as Record<string, unknown>
      assert.equal(direct.status, 200)
      assert.equal(Object.hasOwn(keyedLook, 'pending_pings'), false)
      assert.equal(Object.hasOwn(laterHolder, 'pending_pings'), false)
      assert.equal(Object.hasOwn(directBody, 'pending_pings'), false)
    })

    await t.test('the summary never marks a receipt seen and disappears after a completed me', async () => {
      await reset()
      await invite(GROWER, FOUNDER)
      const noteId = await addWalkNote()

      const summary = await tool('read_here', { note_id: noteId }, FOUNDER.secret)
      assert.equal(Object.hasOwn(summary, 'pending_pings'), true)
      assert.equal((await receiptRows(FOUNDER.id))[0]!.seen_at, null)

      const completedMe = await me('', FOUNDER.secret)
      assert.equal(completedMe.status, 200)
      assert.notEqual((await receiptRows(FOUNDER.id))[0]!.seen_at, null)
      const afterMe = await tool('read_here', { note_id: noteId }, FOUNDER.secret)
      assert.equal(Object.hasOwn(afterMe, 'pending_pings'), false)
    })

    await t.test('a removed ping appears in me and a tool summary only as its id and moderation marker', async () => {
      await reset()
      const ping = await invite(GROWER, FOUNDER)
      const noteId = await addWalkNote()
      const removal = await app.request(`http://city.test/api/moderation`, {
        method: 'POST',
        headers: bearer(FOUNDER.secret),
        body: JSON.stringify({
          action: 'remove', target_type: 'ping', target_id: ping.id, reason: 'remove this ping',
        }),
      })
      assert.equal(removal.status, 201)

      const summaryAnswer = await tool('read_here', { note_id: noteId }, FOUNDER.secret)
      const summary = summaryAnswer.pending_pings as { newest: Record<string, unknown> }

      const meAnswer = await me('', FOUNDER.secret)
      const mePings = meAnswer.json.pending_pings as { receipts: Array<Record<string, unknown>> }
      const meMarker = mePings.receipts[0]!
      assert.deepEqual(Object.keys(meMarker).sort(), ['moderated', 'moderation', 'ping_id'])
      assert.equal(meMarker.ping_id, ping.id)
      assert.equal(meMarker.moderated, true)
      assert.equal((meMarker.moderation as Record<string, unknown>).reason, 'remove this ping')

      assert.deepEqual(summary.newest, meMarker)
    })

    await t.test('an answered ping stays pending until me shows it and dismissal clears a receipt immediately', async () => {
      await reset()
      const answeredPing = await invite(FOUNDER, GROWER)
      const answer = await app.request(`http://city.test/api/ping/${answeredPing.id}/answer`, {
        method: 'POST',
        headers: bearer(GROWER.secret),
        body: JSON.stringify({ answer: 'yes', request_id: nextRequestId() }),
      })
      assert.equal(answer.status, 200)
      const beforeMe = await db.query<{ seen_at: Date | null }>(
        'SELECT seen_at FROM ping_receipts WHERE ping_id = $1', [answeredPing.id],
      )
      assert.equal(beforeMe.rows[0]!.seen_at, null)
      const answered = await me()
      const answeredReceipts = (answered.json.pending_pings as { receipts: Array<Record<string, unknown>> }).receipts
      assert.equal(answeredReceipts[0]!.ping_id, answeredPing.id)
      assert.equal(answeredReceipts[0]!.status, 'answered')
      assert.equal(answeredReceipts[0]!.answer, 'yes')
      assert.notEqual((await db.query<{ seen_at: Date | null }>(
        'SELECT seen_at FROM ping_receipts WHERE ping_id = $1', [answeredPing.id],
      )).rows[0]!.seen_at, null)

      await reset()
      const dismissedPing = await invite(NEIGHBOUR, GROWER)
      await standIn(NEIGHBOUR.id, rooms.westRoomId)
      const dismissed = await app.request(`http://city.test/api/ping/${dismissedPing.id}/dismiss`, {
        method: 'POST',
        headers: bearer(GROWER.secret),
        body: JSON.stringify({ request_id: nextRequestId() }),
      })
      assert.equal(dismissed.status, 200)
      const dismissedReceipt = (await db.query<{ dismissed_at: Date | null }>(
        'SELECT dismissed_at FROM ping_receipts WHERE ping_id = $1', [dismissedPing.id],
      )).rows[0]!
      assert.notEqual(dismissedReceipt.dismissed_at, null)
      assert.deepEqual((await me()).json.pending_pings, {
        total: 0,
        senders: 0,
        receipts: [],
        has_more: false,
        next_pending_before_ping_id: null,
      })
    })

    await t.test('a withheld tool guard leaves every pending receipt unseen', async () => {
      await reset()
      const ping = await invite(FOUNDER, GROWER)
      const actualMcp = await import('../../src/mcp.ts')
      const originalExports = Object.fromEntries(Object.entries(actualMcp))
      const mockedMcp = mock.module(new URL('../../src/mcp.ts', import.meta.url), {
        namedExports: {
          ...originalExports,
          safeguardToolResponse: () => Object.freeze({ text: 'withheld', withheld: true }),
        },
      })
      try {
        const guardedIndexUrl = new URL('../../src/index.ts?room-talk-withheld', import.meta.url).href
        const { default: guardedApp } = await import(guardedIndexUrl) as { default: CityApp }
        const response = await guardedApp.request('http://city.test/api/me', {
          headers: bearer(GROWER.secret),
        })
        assert.equal(response.status, 200)
        const body = await response.json() as { pending_pings: { receipts: Array<{ ping_id: number }> } }
        assert.deepEqual(body.pending_pings.receipts.map(receipt => receipt.ping_id), [ping.id])
        assert.equal((await receiptRows())[0]!.seen_at, null)
      } finally {
        mockedMcp.restore()
      }
    })
  } finally {
    await postgres.stop()
  }
})
