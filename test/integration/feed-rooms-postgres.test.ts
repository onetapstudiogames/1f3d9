// Feed rooms (decision #153), against real PostgreSQL: the real schema, the real
// routes, the real migration. A quiet room its owner marks feed keeps its notes,
// lines, things and pings out of search, events, changes, the front door's recent
// activity and the mention lookups in me, and every one of those answers counts what
// it left out; the room's own reads, read_here and wait_here are unchanged.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  call,
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  type CityApp,
  type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const

const migration = await readFile(
  new URL('../../db/migrations/20261016_place_feed.sql', import.meta.url),
  'utf8',
)

const PRE_FEED_DDL = `
  ALTER TABLE places DROP CONSTRAINT places_feed_needs_quiet;
  ALTER TABLE places DROP COLUMN feed;
`

async function feedCatalog(): Promise<Readonly<Record<string, unknown>>> {
  const db = connectedDatabase()
  const column = await db.query(
    'SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns ' +
      "WHERE table_schema = 'public' AND table_name = 'places' AND column_name = 'feed'",
  )
  const check = await db.query(
    'SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint ' +
      "WHERE conrelid = 'places'::regclass AND conname = 'places_feed_needs_quiet'",
  )
  return Object.freeze({ column: column.rows, check: check.rows })
}

async function mcp(
  app: CityApp,
  door: '/mcp',
  secret: string | null,
  method: string,
  params: Json = {},
): Promise<Json> {
  const response = await app.request(`http://city.test${door}`, {
    method: 'POST',
    headers: secret === null
      ? { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
      : { ...bearer(secret), accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  assert.equal(response.status, 200, `${door} ${method}`)
  return await response.json() as Json
}

async function mcpTool(app: CityApp, secret: string, name: string, args: Json): Promise<Json> {
  const payload = await mcp(app, '/mcp', secret, 'tools/call', { name, arguments: args })
  const result = payload.result as { isError: boolean; content: Array<{ text: string }> }
  assert.equal(result.isError, false, result.content[0]?.text)
  return JSON.parse(result.content[0]!.text) as Json
}

async function changeMarker(app: CityApp): Promise<string> {
  const read = await call(app, null, 'GET', '/api/changes')
  assert.equal(read.status, 200)
  return String(read.json.change_marker)
}

async function makeFeedRoom(app: CityApp, roomId: number): Promise<void> {
  const edited = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${roomId}`, { quiet: true, feed: true })
  assert.equal(edited.status, 200, JSON.stringify(edited.json))
  assert.equal((edited.json.place as Json).feed, true)
}

test('feed rooms against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('feed-rooms')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const {
      FEED_KEEPS_QUIET_REFUSAL,
      FEED_NEEDS_QUIET_REFUSAL,
      FEED_ROOMS_READ_LINE,
    } = await import('../../src/feed-rooms.ts')
    const db = connectedDatabase()

    await t.test('the migration applies twice to a city without feed, changes no row, and ends in the fresh shape', async () => {
      const rooms = await resetCity(RESIDENTS)
      const freshCatalog = await feedCatalog()
      assert.deepEqual(freshCatalog, {
        column: [{ column_name: 'feed', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }],
        check: [{ conname: 'places_feed_needs_quiet', convalidated: true, definition: 'CHECK (((NOT feed) OR quiet))' }],
      })
      await db.query(PRE_FEED_DDL)
      await db.query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.westRoomId])
      const before = (await db.query('SELECT * FROM places ORDER BY id')).rows

      await db.query(migration)
      await db.query(migration)

      assert.deepEqual(await feedCatalog(), freshCatalog)
      const after = (await db.query('SELECT * FROM places ORDER BY id')).rows
      assert.deepEqual(after.map(row => ({ ...row, feed: undefined })), before.map(row => ({ ...row, feed: undefined })))
      assert.equal(after.every(row => row.feed === false), true)
    })

    await t.test('the database refuses a feed room that is not quiet', async () => {
      const rooms = await resetCity(RESIDENTS)
      await assert.rejects(
        db.query('UPDATE places SET feed = TRUE WHERE id = $1', [rooms.westRoomId]),
        /places_feed_needs_quiet/u,
      )
      await db.query('UPDATE places SET quiet = TRUE, feed = TRUE WHERE id = $1', [rooms.westRoomId])
      await assert.rejects(
        db.query('UPDATE places SET quiet = FALSE WHERE id = $1', [rooms.westRoomId]),
        /places_feed_needs_quiet/u,
      )
    })

    await t.test('place_edit sets feed only on a quiet room, keeps quiet on while feed is on, and keeps the event keys', async () => {
      const rooms = await resetCity(RESIDENTS)
      const notQuiet = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.westRoomId}`, { feed: true })
      assert.equal(notQuiet.status, 409)
      assert.equal(notQuiet.json.error, FEED_NEEDS_QUIET_REFUSAL)

      const notOwner = await call(app, GROWER.secret, 'PATCH', `/api/place/${rooms.westRoomId}`, { quiet: true, feed: true })
      assert.equal(notOwner.status, 403)

      const badType = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.westRoomId}`, { feed: 'yes' })
      assert.equal(badType.status, 400)
      assert.match(String(badType.json.error), /quiet, feed, or permission switches/u)

      const eventsBefore = Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE kind = 'place_edited'")).rows[0]!.n)
      await makeFeedRoom(app, rooms.westRoomId)
      const edited = (await db.query<{ detail: Json }>(
        "SELECT detail FROM events WHERE kind = 'place_edited' ORDER BY id DESC LIMIT 1",
      )).rows[0]!.detail
      assert.deepEqual(edited, { place_id: rooms.westRoomId })
      assert.equal(Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE kind = 'place_edited'")).rows[0]!.n), eventsBefore + 1)

      const quietOff = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.westRoomId}`, { quiet: false })
      assert.equal(quietOff.status, 409)
      assert.equal(quietOff.json.error, FEED_KEEPS_QUIET_REFUSAL)
      const quietOffFeedOn = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.westRoomId}`, { quiet: false, feed: true })
      assert.equal(quietOffFeedOn.status, 409)
      assert.equal(quietOffFeedOn.json.error, FEED_NEEDS_QUIET_REFUSAL)

      const bothOff = await call(app, FOUNDER.secret, 'PATCH', `/api/place/${rooms.westRoomId}`, { quiet: false, feed: false })
      assert.equal(bothOff.status, 200, JSON.stringify(bothOff.json))
      assert.equal((bothOff.json.place as Json).feed, false)
      assert.equal((bothOff.json.place as Json).quiet, false)

      const viaTool = await mcpTool(app, FOUNDER.secret, 'place_edit', { place_id: rooms.westRoomId, quiet: true, feed: true })
      assert.equal((viaTool.place as Json).feed, true)
    })

    await t.test('the mark shows wherever rough_room shows', async () => {
      const rooms = await resetCity(RESIDENTS)
      await makeFeedRoom(app, rooms.westRoomId)

      const place = await call(app, null, 'GET', `/api/place/${rooms.westRoomId}`)
      assert.equal(place.status, 200)
      assert.equal((place.json.place as Json).feed, true)
      assert.equal((place.json.place as Json).rough_room, false)
      const east = await call(app, null, 'GET', `/api/place/${rooms.eastRoomId}`)
      assert.equal((east.json.place as Json).feed, false)

      const parent = await call(app, null, 'GET', `/api/place/${rooms.continentId}`)
      const subplaces = parent.json.subplaces as Json[]
      assert.deepEqual(
        subplaces.map(row => [row.id, row.feed]).sort((a, b) => Number(a[0]) - Number(b[0])),
        [[rooms.eastRoomId, false], [rooms.westRoomId, true]],
      )

      const outline = await call(app, null, 'GET', `/api/map?view=outline&parent_id=${rooms.continentId}`)
      assert.equal(outline.status, 200, JSON.stringify(outline.json))
      const outlineRows = (outline.json.subplaces as Json[])
      assert.equal(outlineRows.find(row => row.id === rooms.westRoomId)?.feed, true)
      assert.equal(outlineRows.find(row => row.id === rooms.eastRoomId)?.feed, false)
      const self = await call(app, null, 'GET', `/api/map?view=outline&parent_id=${rooms.westRoomId}`)
      assert.equal((self.json.place as Json).feed, true)

      const continent = await call(app, null, 'GET', `/api/map?view=continent&continent_id=${rooms.continentId}`)
      assert.equal(continent.status, 200, JSON.stringify(continent.json))
      const continentRows = continent.json.places as Json[]
      assert.equal(continentRows.find(row => row.id === rooms.westRoomId)?.feed, true)
      assert.equal((continent.json.continent as Json).feed, false)

      const looked = await mcpTool(app, GROWER.secret, 'look', { place_id: rooms.continentId })
      assert.match(JSON.stringify(looked), /"feed":true/u)
    })

    await t.test('place_edit on every door names feed and carries it in the schema', async () => {
      const { mcp: serveMcp } = await import('../../src/mcp.ts')
      const { Hono } = await import('hono')
      const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
      process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
      try {
      for (const door of ['key', 'connect', 'app'] as const) {
        const gateway = new Hono()
        gateway.post('/mcp', c => serveMcp(c, new Hono(), { door, authenticateLegacyCatalog: async () => true }))
        const response = await gateway.request('/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        })
        assert.equal(response.status, 200, door)
        const listed = await response.json() as Json
        const tools = (listed.result as { tools: Array<{ name: string; description: string; inputSchema: Json }> }).tools
        const placeEdit = tools.find(tool => tool.name === 'place_edit')
        assert.ok(placeEdit, `${door} lists place_edit`)
        assert.match(placeEdit.description, /feed room/u, door)
        assert.match(placeEdit.description, /mention lookups/u, door)
        assert.ok(placeEdit.description.length <= 1_950, door)
        assert.equal(((placeEdit.inputSchema.properties as Json).feed as Json).type, 'boolean', door)
      }
      } finally {
        if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
        else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
      }
    })

    await t.test('city-wide lists leave feed-room content out and count it; the room\'s own reads keep it', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GROWER.id, rooms.westRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      await db.query('UPDATE places SET open_to_things = TRUE WHERE id = $1', [rooms.westRoomId])
      // The neighbour's first me sets its baseline, so the next one summarizes.
      assert.equal((await call(app, NEIGHBOUR.secret, 'GET', '/api/me')).status, 200)
      const before = await changeMarker(app)

      const ordinary = await call(app, NEIGHBOUR.secret, 'POST', '/api/note', {
        place_id: rooms.eastRoomId, body: 'lanterns at dusk in the east room',
      })
      assert.equal(ordinary.status, 201, JSON.stringify(ordinary.json))
      await makeFeedRoom(app, rooms.westRoomId)
      const feedNote = await call(app, GROWER.secret, 'POST', '/api/note', {
        place_id: rooms.westRoomId, body: 'wire headline: lanterns everywhere, says next-door',
      })
      assert.equal(feedNote.status, 201, JSON.stringify(feedNote.json))
      const feedNoteId = Number((feedNote.json.note as Json).id)
      const feedThing = await call(app, GROWER.secret, 'POST', '/api/thing', {
        place_id: rooms.westRoomId, name: 'lantern clipping', body: 'lanterns, from the wire',
      })
      assert.equal(feedThing.status, 201, JSON.stringify(feedThing.json))
      const lineBefore = await changeMarker(app)
      const feedLine = await call(app, GROWER.secret, 'POST', '/api/line', {
        place_id: rooms.westRoomId, body: 'lanterns on the wire', request_id: randomUUID(),
      })
      assert.equal(feedLine.status, 201, JSON.stringify(feedLine.json))

      // Search: the feed note and thing are counted, not listed.
      const search = await call(app, null, 'GET', '/api/search?q=lanterns')
      assert.equal(search.status, 200, JSON.stringify(search.json))
      assert.deepEqual((search.json.results as Json[]).map(row => [row.type, row.place_id]), [['note', rooms.eastRoomId]])
      assert.deepEqual(search.json.left_out_feed_rooms, { count: 2, place_ids: [rooms.westRoomId], read: FEED_ROOMS_READ_LINE })
      const nothingLeft = await call(app, null, 'GET', '/api/search?q=dusk')
      assert.deepEqual(nothingLeft.json.left_out_feed_rooms, { count: 0, place_ids: [] })
      const feedPlaceFound = await call(app, null, 'GET', '/api/search?q=West&type=place')
      assert.equal((feedPlaceFound.json.results as Json[]).some(row => row.id === rooms.westRoomId), true)

      // Events: city-wide and above the feed room leave it out; scoped to it, it stays.
      const events = await call(app, null, 'GET', '/api/events?limit=200')
      assert.equal(events.status, 200, JSON.stringify(events.json))
      const eventRows = events.json.events as Json[]
      const inFeedRoom = (row: Json) => (row.detail as Json).place_id === rooms.westRoomId && row.kind !== 'place_edited'
      assert.equal(eventRows.some(inFeedRoom), false)
      assert.equal(eventRows.some(row => row.kind === 'place_edited' && (row.detail as Json).place_id === rooms.westRoomId), true)
      const leftOut = events.json.left_out_feed_rooms as Json
      assert.equal(leftOut.count, 3)
      assert.deepEqual(leftOut.place_ids, [rooms.westRoomId])
      assert.equal(events.json.total_items, eventRows.length)
      const notesOnly = await call(app, null, 'GET', '/api/events?kind=note')
      assert.deepEqual((notesOnly.json.events as Json[]).map(row => (row.detail as Json).note_id), [Number((ordinary.json.note as Json).id)])
      assert.equal((notesOnly.json.left_out_feed_rooms as Json).count, 1)
      const own = await call(app, null, 'GET', `/api/events?place_id=${rooms.westRoomId}`)
      assert.equal((own.json.events as Json[]).some(row => (row.detail as Json).note_id === feedNoteId), true)
      assert.equal((own.json.left_out_feed_rooms as Json).count, 0)
      const ownWithin = await call(app, null, 'GET', `/api/events?within_place_id=${rooms.westRoomId}`)
      assert.equal((ownWithin.json.events as Json[]).some(row => (row.detail as Json).note_id === feedNoteId), true)
      const above = await call(app, null, 'GET', `/api/events?within_place_id=${rooms.continentId}`)
      assert.equal((above.json.events as Json[]).some(row => (row.detail as Json).note_id === feedNoteId), false)
      assert.equal((above.json.left_out_feed_rooms as Json).count, 3)
      const browsed = await mcpTool(app, NEIGHBOUR.secret, 'browse', { view: 'events', kind: 'note' })
      assert.equal((browsed.left_out_feed_rooms as Json).count, 1)

      // Changes: one page and a page-by-page walk count each left-out change once.
      const changes = await call(app, null, 'GET', `/api/changes?since=${before}&limit=200`)
      assert.equal(changes.status, 200, JSON.stringify(changes.json))
      const changeRows = changes.json.changes as Json[]
      assert.equal(changeRows.some(inFeedRoom), false)
      assert.equal(changeRows.some(row => row.kind === 'place_edited'), true)
      assert.equal((changes.json.left_out_feed_rooms as Json).count, 3)
      assert.equal(changes.json.next_since, changes.json.change_marker)
      let since = before
      let walked = 0
      let pages = 0
      for (;;) {
        const page = await call(app, null, 'GET', `/api/changes?since=${since}&limit=1`)
        assert.equal(page.status, 200)
        assert.equal((page.json.changes as Json[]).some(inFeedRoom), false)
        walked += Number((page.json.left_out_feed_rooms as Json).count)
        since = String(page.json.next_since)
        pages += 1
        if (page.json.has_more !== true) break
      }
      assert.equal(walked, 3)
      assert.ok(pages >= 2)
      const viaTool = await mcpTool(app, NEIGHBOUR.secret, 'changes', { since: before })
      assert.equal((viaTool.left_out_feed_rooms as Json).count, 3)

      // The front door's recent activity skips the feed room and says how many it skipped.
      const door = await app.request('http://city.test/')
      const doorText = await door.text()
      const activity = doorText.slice(doorText.indexOf('RECENT ACTIVITY'))
      assert.match(activity, /2 newer notes or things in feed rooms were left out; they are read in the room\./u)
      assert.doesNotMatch(activity.split('\n').slice(2, 7).join('\n'), /seed-keeper {2}(left a note|made a thing)/u)

      // me: the mention in the feed room is left out and counted.
      const me = await call(app, NEIGHBOUR.secret, 'GET', '/api/me')
      assert.equal(me.status, 200)
      const around = (me.json.since_last_visit as Json).around_you as Json
      assert.equal(around.available, true)
      assert.equal((around.mentions as Json).count, 0)
      assert.deepEqual(around.left_out_feed_rooms, { count: 1, place_ids: [rooms.westRoomId], read: FEED_ROOMS_READ_LINE })
      assert.equal((around.notes_in_owned_places as Json).count, 1)

      // The founder owns the feed room: away from it, its notes and things are counted, not listed.
      assert.equal((await call(app, FOUNDER.secret, 'GET', '/api/me')).status, 200)
      await call(app, GROWER.secret, 'POST', '/api/note', { place_id: rooms.westRoomId, body: 'another wire item' })
      await standIn(FOUNDER.id, rooms.eastRoomId)
      const ownerAway = (((await call(app, FOUNDER.secret, 'GET', '/api/me')).json.since_last_visit as Json).around_you as Json)
      assert.equal((ownerAway.notes_in_owned_places as Json).count, 0)
      assert.equal((ownerAway.left_out_feed_rooms as Json).count, 1)
      await call(app, GROWER.secret, 'POST', '/api/note', { place_id: rooms.westRoomId, body: 'a third wire item' })
      await standIn(FOUNDER.id, rooms.westRoomId)
      const ownerThere = (((await call(app, FOUNDER.secret, 'GET', '/api/me')).json.since_last_visit as Json).around_you as Json)
      assert.equal((ownerThere.notes_in_owned_places as Json).count, 1)
      assert.deepEqual(ownerThere.left_out_feed_rooms, { count: 0, place_ids: [] })

      // The room's own reads: a resident standing there reads its notes and hears its lines.
      await standIn(NEIGHBOUR.id, rooms.westRoomId)
      const room = await call(app, null, 'GET', `/api/place/${rooms.westRoomId}`)
      assert.equal((room.json.notes as Json[]).some(row => row.id === feedNoteId), true)
      const here = await mcpTool(app, NEIGHBOUR.secret, 'read_here', { note_id: feedNoteId })
      assert.match(JSON.stringify(here), /wire headline/u)
      const waited = await call(app, NEIGHBOUR.secret, 'POST', '/api/wait-here', {
        after_line_change: lineBefore, after_ping_change: lineBefore, seconds: 1,
      })
      assert.equal(waited.status, 200, JSON.stringify(waited.json))
      assert.match(JSON.stringify(waited.json), /lanterns on the wire/u)
    })
  } finally {
    await postgres.stop()
  }
})
