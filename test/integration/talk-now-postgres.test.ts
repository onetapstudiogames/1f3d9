import assert from 'node:assert/strict'
import test from 'node:test'
import { readTalkNow } from '../../src/talk-now.ts'
import {
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  call,
  type CityApp,
  type Json,
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

test('GET /api/talk/now reads the line marker and listening from real PostgreSQL', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('talk-now')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()
    let rooms = await resetCity(RESIDENTS)
    let requestNumber = 1
    const nextRequestId = () => requestId(requestNumber++)

    const reset = async () => {
      rooms = await resetCity(RESIDENTS)
      for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)
    }
    const sayLine = async (body = 'a public line'): Promise<number> => {
      const result = await call(app, FOUNDER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId,
        body,
        request_id: nextRequestId(),
      })
      assert.equal(result.status, 201, JSON.stringify(result.json))
      return Number((result.json.line as Json).id)
    }
    const sendPing = async (): Promise<number> => {
      const result = await call(app, FOUNDER.secret, 'POST', '/api/ping', {
        to_handle: GROWER.handle,
        request_id: nextRequestId(),
      })
      assert.equal(result.status, 201, JSON.stringify(result.json))
      return Number((result.json.ping as Json).id)
    }
    const listen = async (residentId: number, seconds = 30): Promise<void> => {
      await db.query(`
        INSERT INTO wait_leases (resident_id, place_id, arrived_at, lease_id, started_at, expires_at)
        SELECT presence.resident_id, presence.current_place_id, presence.arrived_at, $2::uuid,
          clock_timestamp(), clock_timestamp() + make_interval(secs => $3::integer)
        FROM resident_presence presence
        WHERE presence.resident_id = $1
      `, [residentId, '00000000-0000-4000-9000-' + String(residentId).padStart(12, '0'), seconds])
    }
    const execute = async (text: string, params: readonly unknown[]) =>
      (await db.query(text, [...params])).rows as Record<string, unknown>[]
    const readNow = async (): Promise<Readonly<{ response: Response; body: Json }>> => {
      const response = await app.request('http://city.test/api/talk/now')
      return Object.freeze({ response, body: await response.json() as Json })
    }

    for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)

    await t.test('an empty city answers its line marker, the interval, and nothing listening, with the shared cache header', async () => {
      const { response, body } = await readNow()
      assert.equal(response.status, 200, JSON.stringify(body))
      assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, s-maxage=2')
      assert.deepEqual(Object.keys(body).sort(), ['check_interval_ms', 'line_marker', 'listening', 'listening_page'])
      assert.match(String(body.line_marker), /^\d+$/u)
      const changes = await call(app, null, 'GET', '/api/changes')
      assert.equal(changes.status, 200, JSON.stringify(changes.json))
      assert.ok(BigInt(String(body.line_marker)) <= BigInt(String(changes.json.change_marker)))
      assert.equal(body.check_interval_ms, 2000)
      assert.deepEqual(body.listening, [])
      assert.deepEqual(body.listening_page, { total_items: 0, returned_items: 0, has_more: false })
    })

    await t.test('a listener shows the fields a place read shows, and drops out after moving', async () => {
      await standIn(FOUNDER.id, rooms.eastRoomId)
      await listen(FOUNDER.id)
      const place = await call(app, null, 'GET', '/api/place/' + rooms.eastRoomId)
      assert.equal(place.status, 200, JSON.stringify(place.json))
      const placeListeners = place.json.listening_residents as Json[]
      assert.equal(placeListeners.length, 1)
      const { response, body } = await readNow()
      assert.equal(response.status, 200, JSON.stringify(body))
      assert.deepEqual(body.listening, [{
        place_id: rooms.eastRoomId,
        resident_id: placeListeners[0]?.resident_id,
        handle: placeListeners[0]?.handle,
        listening_until: placeListeners[0]?.listening_until,
      }])

      await db.query(
        'UPDATE resident_presence SET current_place_id = $2, arrived_at = clock_timestamp() WHERE resident_id = $1',
        [FOUNDER.id, rooms.westRoomId],
      )
      assert.deepEqual((await readNow()).body.listening, [])
    })

    await t.test('a line moves the line marker, and a lines read at that marker has the line', async () => {
      await reset()
      const before = String((await readNow()).body.line_marker)
      const lineId = await sayLine('marker line')
      const after = String((await readNow()).body.line_marker)
      assert.ok(BigInt(after) > BigInt(before))
      const response = await app.request(
        'http://city.test/api/window?collection=lines&place_id=' + rooms.eastRoomId + '&limit=5&after_change_marker=' + after,
      )
      assert.equal(response.status, 200)
      const body = await response.json() as Json
      assert.equal((body.lines as Json[])[0]?.id, lineId)
    })

    await t.test('a removed line moves the line marker', async () => {
      await reset()
      const lineId = await sayLine()
      const before = String((await readNow()).body.line_marker)
      const removed = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action: 'remove',
        target_type: 'line',
        target_id: lineId,
        reason: 'talk now marker test removal',
      })
      assert.equal(removed.status, 201, JSON.stringify(removed.json))
      const after = String((await readNow()).body.line_marker)
      assert.ok(BigInt(after) > BigInt(before))
    })

    await t.test('a change that is not about a line moves the change marker and not the line marker', async () => {
      await reset()
      const beforeLine = String((await readNow()).body.line_marker)
      const beforeChanges = await call(app, null, 'GET', '/api/changes')
      assert.equal(beforeChanges.status, 200, JSON.stringify(beforeChanges.json))
      const pingId = await sendPing()
      assert.ok(pingId > 0)
      const afterChanges = await call(app, null, 'GET', '/api/changes')
      assert.equal(afterChanges.status, 200, JSON.stringify(afterChanges.json))
      assert.ok(BigInt(String(afterChanges.json.change_marker)) > BigInt(String(beforeChanges.json.change_marker)))
      assert.equal(String((await readNow()).body.line_marker), beforeLine)
    })

    await t.test('a quiet room is left out, a room inside a quiet place stays, and the place read still lists them', async () => {
      await reset()
      await listen(FOUNDER.id)
      await listen(GROWER.id)
      await db.query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.eastRoomId])
      assert.deepEqual((await readNow()).body.listening, [])
      const quietRoom = await call(app, null, 'GET', '/api/place/' + rooms.eastRoomId)
      assert.equal(quietRoom.status, 200, JSON.stringify(quietRoom.json))
      assert.deepEqual(
        (quietRoom.json.listening_residents as Json[]).map(row => row.resident_id).sort(),
        [FOUNDER.id, GROWER.id],
      )

      await reset()
      await listen(FOUNDER.id)
      await listen(GROWER.id)
      await db.query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.continentId])
      const insideQuietPlace = (await readNow()).body.listening as Json[]
      assert.deepEqual(insideQuietPlace.map(row => row.resident_id).sort(), [FOUNDER.id, GROWER.id])
    })

    await t.test('a retired room is left out', async () => {
      await reset()
      await listen(FOUNDER.id)
      await listen(GROWER.id)
      await db.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [rooms.eastRoomId])
      assert.deepEqual((await readNow()).body.listening, [])
    })

    await t.test('past the listening limit the page says so', async () => {
      await reset()
      for (const resident of RESIDENTS) await listen(resident.id)
      const answer = await readTalkNow(execute, { listeningLimit: 2 })
      assert.equal(answer.listening.length, 2)
      assert.deepEqual(answer.listening_page, { total_items: 3, returned_items: 2, has_more: true })
    })

    await t.test('a request with a credential header gets a private answer', async () => {
      const cookie = await app.request('http://city.test/api/talk/now', { headers: { cookie: 'a=b' } })
      assert.equal(cookie.status, 200)
      assert.equal(cookie.headers.get('Cache-Control'), 'private, no-store')
      const keyed = await app.request('http://city.test/api/talk/now', {
        headers: {
          authorization: 'Bearer ' + FOUNDER.secret,
          'x-1f3d9-tool-call': '1',
        },
      })
      assert.equal(keyed.status, 200)
      assert.equal(keyed.headers.get('Cache-Control'), 'private, no-store')
    })

    await t.test('the read takes no options', async () => {
      const response = await app.request('http://city.test/api/talk/now?x=1')
      assert.equal(response.status, 400)
    })
  } finally {
    await postgres.stop()
  }
})
