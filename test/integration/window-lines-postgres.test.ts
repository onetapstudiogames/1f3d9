import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  call,
  type CityApp,
  type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const

function requestId(value: number): string {
  return '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
}

test('GET /api/window?collection=lines reads lines from real PostgreSQL', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('window-lines')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    let rooms = await resetCity(RESIDENTS)
    let requestNumber = 1
    const nextRequestId = () => requestId(requestNumber++)

    const reset = async () => {
      rooms = await resetCity(RESIDENTS)
      for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)
    }
    const sayLine = async (
      body: string,
      resident: (typeof RESIDENTS)[number] = FOUNDER,
      placeId = rooms.eastRoomId,
    ): Promise<Json> => {
      const result = await call(app, resident.secret, 'POST', '/api/line', {
        place_id: placeId,
        body,
        request_id: nextRequestId(),
      })
      assert.equal(result.status, 201, JSON.stringify(result.json))
      return result.json.line as Json
    }
    const readLines = async (query = '') => call(
      app, null, 'GET', '/api/window?collection=lines' + query,
    )
    const expectedLine = (line: Json, placeId: number, author: string, body: string): Json => ({
      id: Number(line.id),
      place_id: placeId,
      author,
      body,
      created_at: line.created_at,
    })

    for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)

    await t.test('lines read newest first, whole, with the next cursor', async () => {
      await reset()
      const first = await sayLine('first line')
      const second = await sayLine('second line')
      const third = await sayLine('third line')

      const page = await readLines('&limit=2')
      assert.equal(page.status, 200, JSON.stringify(page.json))
      assert.deepEqual(page.json.lines, [
        expectedLine(third, rooms.eastRoomId, FOUNDER.handle, 'third line'),
        expectedLine(second, rooms.eastRoomId, FOUNDER.handle, 'second line'),
      ])
      assert.equal(page.json.has_more, true)
      assert.equal(page.json.next_before_id, Number(second.id))

      const older = await readLines('&limit=2&before_id=' + second.id)
      assert.equal(older.status, 200, JSON.stringify(older.json))
      assert.deepEqual(older.json.lines, [
        expectedLine(first, rooms.eastRoomId, FOUNDER.handle, 'first line'),
      ])
      assert.equal(older.json.has_more, false)
    })

    await t.test('a place filter keeps to that place and a within-place filter includes nested places', async () => {
      await reset()
      await standIn(GROWER.id, rooms.westRoomId)
      const eastLine = await sayLine('east line')
      const westLine = await sayLine('west line', GROWER, rooms.westRoomId)

      const east = await readLines('&place_id=' + rooms.eastRoomId)
      assert.equal(east.status, 200, JSON.stringify(east.json))
      assert.deepEqual(east.json.lines, [
        expectedLine(eastLine, rooms.eastRoomId, FOUNDER.handle, 'east line'),
      ])

      const continent = await readLines('&within_place_id=' + rooms.continentId)
      assert.equal(continent.status, 200, JSON.stringify(continent.json))
      assert.deepEqual(continent.json.lines, [
        expectedLine(westLine, rooms.westRoomId, GROWER.handle, 'west line'),
        expectedLine(eastLine, rooms.eastRoomId, FOUNDER.handle, 'east line'),
      ])
    })

    await t.test('a removed line reads as its id alone, and a resident filter never matches it', async () => {
      await reset()
      const line = await sayLine('to be removed')
      const targetId = Number(line.id)
      const removed = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action: 'remove',
        target_type: 'line',
        target_id: targetId,
        reason: 'window lines test removal',
      })
      assert.equal(removed.status, 201, JSON.stringify(removed.json))

      for (const result of [
        await readLines(),
        await readLines('&place_id=' + rooms.eastRoomId),
      ]) {
        assert.equal(result.status, 200, JSON.stringify(result.json))
        const target = (result.json.lines as Json[]).find(row => row.id === targetId)
        assert.deepEqual(target, { id: targetId, moderated: true })
      }

      const resident = await readLines('&resident=' + FOUNDER.handle)
      assert.equal(resident.status, 200, JSON.stringify(resident.json))
      assert.equal((resident.json.lines as Json[]).some(row => row.id === targetId), false)
    })

    await t.test('after_change_marker makes a shared 2-second read and names its marker', async () => {
      await reset()
      await sayLine('marked line')
      const head = await call(app, null, 'GET', '/api/changes')
      assert.equal(head.status, 200, JSON.stringify(head.json))
      const marker = String(head.json.change_marker)

      const marked = await app.request(
        'http://city.test/api/window?collection=lines&limit=5&after_change_marker=' + marker,
      )
      assert.equal(marked.status, 200, await marked.clone().text())
      assert.equal(marked.headers.get('Cache-Control'), 'public, max-age=0, s-maxage=2')
      const markedBody = await marked.json() as Json
      assert.equal(typeof markedBody.change_marker, 'string')
      assert.ok(BigInt(String(markedBody.change_marker)) >= BigInt(marker))

      const ordinary = await app.request(
        'http://city.test/api/window?collection=lines&limit=5',
      )
      assert.equal(ordinary.status, 200, await ordinary.clone().text())
      assert.equal(
        ordinary.headers.get('Cache-Control'),
        'public, max-age=15, s-maxage=60, stale-while-revalidate=300',
      )

      const notes = await app.request(
        'http://city.test/api/window?collection=notes&limit=5&after_change_marker=' + marker,
      )
      assert.equal(notes.status, 200, await notes.clone().text())
      assert.equal(notes.headers.get('Cache-Control'), 'no-store')
    })
  } finally {
    await postgres.stop()
  }
})
