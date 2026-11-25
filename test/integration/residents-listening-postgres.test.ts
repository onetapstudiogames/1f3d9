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
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
  withNoteSuiteQueryObserver,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const

// Residents can see who is listening right now, city-wide (browse resident_view=listening,
// GET /api/residents?view=listening). Quiet rooms are included for residents; retired
// residents and retired rooms never are; a reader's mutes leave a resident out and count it.
test('GET /api/residents?view=listening reads everyone listening now from real PostgreSQL', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('residents-listening')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { readResidentListening } = await import('../../src/talk-now.ts')
    const db = connectedDatabase()
    let rooms = await resetCity(RESIDENTS)

    const reset = async () => {
      rooms = await resetCity(RESIDENTS)
      await standIn(FOUNDER.id, rooms.eastRoomId)
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.westRoomId)
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
    const readListening = async (secret: string | null = null, query = '') => {
      const response = await app.request('http://city.test/api/residents?view=listening' + query, {
        headers: secret === null ? {} : bearer(secret),
      })
      return Object.freeze({ response, body: await response.json() as Json })
    }
    const ids = (body: Json) => (body.listening as Json[]).map(row => row.resident_id)
    const mcpBrowse = async (secret: string | null, args: Json): Promise<Json> => {
      const response = await app.request('http://city.test/mcp', {
        method: 'POST',
        headers: {
          ...(secret === null ? { 'content-type': 'application/json' } : bearer(secret)),
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'browse', arguments: { view: 'residents', resident_view: 'listening', ...args } },
        }),
      })
      assert.equal(response.status, 200)
      const payload = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
      assert.equal(payload.result.isError, false, payload.result.content[0]?.text)
      return JSON.parse(payload.result.content[0]!.text) as Json
    }

    await reset()

    await t.test('an empty city answers an empty list and an exact page, never cached', async () => {
      const { response, body } = await readListening()
      assert.equal(response.status, 200, JSON.stringify(body))
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
      assert.deepEqual(Object.keys(body).sort(), ['listening', 'listening_page'])
      assert.deepEqual(body.listening, [])
      assert.deepEqual(body.listening_page, { total_items: 0, returned_items: 0, has_more: false })
    })

    await t.test('listeners in every room are listed with the fields a place read shows', async () => {
      await reset()
      await listen(FOUNDER.id)
      await listen(NEIGHBOUR.id)
      const { body } = await readListening()
      const east = await call(app, null, 'GET', '/api/place/' + rooms.eastRoomId)
      const west = await call(app, null, 'GET', '/api/place/' + rooms.westRoomId)
      const eastListener = (east.json.listening_residents as Json[])[0]!
      const westListener = (west.json.listening_residents as Json[])[0]!
      assert.deepEqual(body.listening, [
        { place_id: rooms.eastRoomId, resident_id: FOUNDER.id, handle: FOUNDER.handle, listening_until: eastListener.listening_until },
        { place_id: rooms.westRoomId, resident_id: NEIGHBOUR.id, handle: NEIGHBOUR.handle, listening_until: westListener.listening_until },
      ])
      assert.deepEqual(body.listening_page, { total_items: 2, returned_items: 2, has_more: false })
      assert.deepEqual(await mcpBrowse(null, {}), body, 'anonymous /mcp browse gives the same answer')
    })

    await t.test('a quiet room is included for residents while the human talk view still leaves it out', async () => {
      await reset()
      await listen(FOUNDER.id)
      await listen(GROWER.id)
      await db.query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.eastRoomId])
      assert.deepEqual(ids((await readListening()).body).sort(), [FOUNDER.id, GROWER.id])
      const human = await call(app, null, 'GET', '/api/talk/now')
      assert.equal(human.status, 200, JSON.stringify(human.json))
      assert.deepEqual(human.json.listening, [], 'GET /api/talk/now is unchanged')
    })

    await t.test('a retired resident and a retired room are never listed', async () => {
      await reset()
      await listen(FOUNDER.id)
      await listen(GROWER.id)
      await listen(NEIGHBOUR.id)
      await db.query(`
        UPDATE residents SET retirement_state = 'retiring',
          retirement_requested_at = clock_timestamp() - interval '31 days'
        WHERE id = $1
      `, [GROWER.id])
      assert.deepEqual(ids((await readListening()).body).sort(), [FOUNDER.id, GROWER.id, NEIGHBOUR.id], 'a retiring resident still shows')
      await db.query(`UPDATE residents SET retirement_state = 'retired', retired_at = clock_timestamp() WHERE id = $1`, [GROWER.id])
      assert.deepEqual(ids((await readListening()).body).sort(), [FOUNDER.id, NEIGHBOUR.id])
      await db.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [rooms.westRoomId])
      assert.deepEqual(ids((await readListening()).body), [FOUNDER.id])
    })

    await t.test('a reader\'s mutes leave a resident out and count it, on HTTP and /mcp alike', async () => {
      await reset()
      await listen(FOUNDER.id)
      await listen(NEIGHBOUR.id)
      await db.query(
        `INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES ($1, 'resident', $2, 'mute')`,
        [GROWER.id, NEIGHBOUR.id],
      )
      const { response, body } = await readListening(GROWER.secret)
      assert.equal(response.status, 200, JSON.stringify(body))
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
      assert.deepEqual(ids(body), [FOUNDER.id])
      assert.equal(body.hidden_by_your_mutes, 1)
      assert.deepEqual(body.listening_page, { total_items: 2, returned_items: 1, has_more: false })
      const outlined = (await readListening(GROWER.secret, '&hidden=outline')).body
      assert.deepEqual((outlined.hidden_items as Json[]).map(item => [item.type, item.id, item.author, item.place_id]), [
        ['resident', NEIGHBOUR.id, NEIGHBOUR.handle, rooms.westRoomId],
      ])
      const keyed = await mcpBrowse(GROWER.secret, {})
      assert.deepEqual(ids(keyed), [FOUNDER.id])
      assert.equal(keyed.hidden_by_your_mutes, 1)
      assert.deepEqual(ids((await readListening()).body).sort(), [FOUNDER.id, NEIGHBOUR.id], 'anonymous reads are unchanged')
    })

    await t.test('reading writes nothing and wakes nothing, and costs the same queries however many listen', async () => {
      await reset()
      await listen(FOUNDER.id)
      const state = async () => (await db.query(`
        SELECT (SELECT count(*) FROM events)::text AS events,
          (SELECT current_change_id::text FROM public_change_state WHERE singleton) AS change_id,
          (SELECT json_agg(lease ORDER BY resident_id)::text FROM wait_leases lease) AS leases,
          (SELECT json_agg(presence ORDER BY resident_id)::text FROM resident_presence presence) AS presence
      `)).rows[0]
      const queriesFor = async (secret: string | null): Promise<number> => {
        let count = 0
        await withNoteSuiteQueryObserver(text => { count++; return text }, async () => {
          const { response } = await readListening(secret)
          assert.equal(response.status, 200)
        })
        return count
      }
      const before = await state()
      const anonymousOne = await queriesFor(null)
      const signedOne = await queriesFor(GROWER.secret)
      assert.deepEqual(await state(), before, 'a read changes no row')
      await listen(GROWER.id)
      await listen(NEIGHBOUR.id)
      assert.equal(await queriesFor(null), anonymousOne, 'no query per listener')
      assert.equal(await queriesFor(GROWER.secret), signedOne, 'no query per listener when signed in')
    })

    await t.test('past the limit the page says so', async () => {
      await reset()
      for (const resident of RESIDENTS) await listen(resident.id)
      const execute = async (text: string, params: readonly unknown[]) =>
        (await db.query(text, [...params])).rows as Record<string, unknown>[]
      const page = await readResidentListening(execute, 2)
      assert.equal(page.listening.length, 2)
      assert.deepEqual(page.listening_page, { total_items: 3, returned_items: 2, has_more: true })
    })

    await t.test('the listening view takes no paging, handle, or marker, and names what it takes', async () => {
      for (const query of ['&limit=5', '&before_id=3', '&after_change_marker=1']) {
        const { response, body } = await readListening(null, query)
        assert.equal(response.status, 400, query)
        assert.match(String(body.error), /view=listening takes only hidden=outline; it lists everyone listening now, up to 200, with listening_page/u, query)
      }
      const unknown = await app.request('http://city.test/api/residents?view=nobody')
      assert.equal(unknown.status, 400)
      assert.match(String((await unknown.json() as Json).error), /^view must be presence or listening$/u)
    })
  } finally {
    await postgres.stop()
  }
})
