// Reading settings and focus mode (decisions #154 and #155) against real PostgreSQL:
// the real schema, the real routes, the real migration. A signed-in read may look up
// its own reader's settings and still changes nothing; anonymous reads are unchanged
// byte for byte; a settings call through me is not a me read.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
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
const WRONG_KEY = `1f3d9_sk_${'f'.repeat(48)}`

const migration = await readFile(
  new URL('../../db/migrations/20261017_resident_settings.sql', import.meta.url),
  'utf8',
)

type Read = Readonly<{ status: number; headers: readonly (readonly [string, string])[]; text: string; json: Json }>

async function read(app: CityApp, path: string, secret: string | null = null): Promise<Read> {
  const response = await app.request(`http://city.test${path}`, {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  })
  const text = await response.text()
  return Object.freeze({
    status: response.status,
    headers: [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
    text,
    json: text === '' ? {} : JSON.parse(text) as Json,
  })
}

async function mcpTool(app: CityApp, secret: string, name: string, args: Json): Promise<Json> {
  const response = await app.request('http://city.test/mcp', {
    method: 'POST',
    headers: { ...bearer(secret), accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  assert.equal(response.status, 200)
  const rpc = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  assert.equal(rpc.result.isError, false, rpc.result.content[0]?.text)
  return JSON.parse(rpc.result.content[0]!.text) as Json
}

async function settingsCatalog(): Promise<Json> {
  const db = connectedDatabase()
  const columns = await db.query(
    'SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns ' +
      "WHERE table_schema = 'public' AND table_name = 'resident_settings' ORDER BY ordinal_position",
  )
  const constraints = await db.query(
    'SELECT contype, convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint ' +
      "WHERE conrelid = to_regclass('public.resident_settings') ORDER BY contype",
  )
  return { columns: columns.rows, constraints: constraints.rows }
}

async function seedNotes(placeId: number, authorId: number, bodies: readonly string[]): Promise<void> {
  for (const body of bodies) {
    await connectedDatabase().query(
      'INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, $3)',
      [placeId, authorId, body],
    )
  }
}

async function seedPing(placeId: number, senderId: number, targetId: number): Promise<number> {
  const db = connectedDatabase()
  const inserted = await db.query<{ id: number }>(`
    WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now)
    INSERT INTO pings (place_id, sender_id, target_id, sent_at, expires_at, sender_arrived_at, target_arrived_at)
    SELECT $1, $2, $3, stamp.now - interval '30 seconds', stamp.now + interval '9 minutes 30 seconds',
      sender_presence.arrived_at, target_presence.arrived_at
    FROM stamp
    JOIN resident_presence sender_presence ON sender_presence.resident_id = $2
    JOIN resident_presence target_presence ON target_presence.resident_id = $3
    RETURNING id
  `, [placeId, senderId, targetId])
  const pingId = Number(inserted.rows[0]!.id)
  await db.query('INSERT INTO ping_receipts (ping_id, recipient_id) VALUES ($1, $2)', [pingId, targetId])
  return pingId
}

async function focusOn(app: CityApp, secret: string, focus: boolean): Promise<Json> {
  const changed = await call(app, secret, 'PATCH', '/api/me/settings', { focus_mode: focus })
  assert.equal(changed.status, 200, JSON.stringify(changed.json))
  return changed.json
}

test('reading settings and focus mode against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('reading-settings')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()

    await t.test('the migration applies twice to a city without the table, changes no resident, and ends in the fresh shape', async () => {
      await resetCity(RESIDENTS)
      const fresh = await settingsCatalog()
      assert.deepEqual(fresh, {
        columns: [
          { column_name: 'resident_id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'focus', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
          { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
        ],
        constraints: [
          { contype: 'f', convalidated: true, definition: 'FOREIGN KEY (resident_id) REFERENCES residents(id) ON DELETE CASCADE' },
          { contype: 'p', convalidated: true, definition: 'PRIMARY KEY (resident_id)' },
        ],
      })
      await db.query('DROP TABLE resident_settings')
      const residentsBefore = (await db.query('SELECT * FROM residents ORDER BY id')).rows
      await db.query(migration)
      await db.query(migration)
      assert.deepEqual(await settingsCatalog(), fresh)
      assert.deepEqual((await db.query('SELECT * FROM residents ORDER BY id')).rows, residentsBefore)
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM resident_settings')).rows[0]!.n), 0)
    })

    await t.test('an anonymous place read is byte-identical, body and headers, whatever readers chose, and a wrong key reads as anyone', async () => {
      const rooms = await resetCity(RESIDENTS)
      await seedNotes(rooms.eastRoomId, GROWER.id, ['first note in the east room', 'second note, a little longer'])
      const path = `/api/place/${rooms.eastRoomId}?view=full`
      const before = await read(app, path)
      assert.equal(before.status, 200)
      // The anonymous answer sets no cache rule and no Vary, exactly as before this change.
      assert.deepEqual(
        before.headers.map(([name]) => name),
        ['access-control-allow-origin', 'content-type', 'referrer-policy', 'x-content-type-options'],
      )

      await focusOn(app, GROWER.secret, true)
      await focusOn(app, NEIGHBOUR.secret, false)
      const after = await read(app, path)
      assert.deepEqual(after, before)
      const wrongKey = await read(app, path, WRONG_KEY)
      assert.deepEqual(wrongKey, before)
      const outline = await read(app, `/api/place/${rooms.eastRoomId}`)
      assert.equal(Object.hasOwn(outline.json, 'reading'), false)
    })

    await t.test('a keyed place read under focus mode sends outlines for view=full, and show_everything sends bodies', async () => {
      const rooms = await resetCity(RESIDENTS)
      await seedNotes(rooms.eastRoomId, GROWER.id, ['first note in the east room', 'second note, a little longer'])
      const path = `/api/place/${rooms.eastRoomId}?view=full`
      const anonymous = await read(app, path)
      await focusOn(app, GROWER.secret, true)

      const focused = await read(app, path, GROWER.secret)
      assert.equal(focused.status, 200)
      assert.equal(focused.json.view, 'outline')
      const notes = focused.json.notes as Json[]
      assert.equal(notes.length, 2)
      assert.equal(notes.some(note => Object.hasOwn(note, 'body')), false)
      assert.deepEqual(notes.map(note => note.body_text_bytes), [28, 27])
      assert.deepEqual(focused.json.reading, {
        focus_mode: true,
        items: 2,
        bodies_sent: 0,
        show_everything: false,
        next_step: 'Focus mode sent outlines only. Read one item by its id for its body, or send show_everything: true with this same read to see every body just this once.',
      })
      const headers = new Map(focused.headers)
      assert.equal(headers.get('cache-control'), 'private, no-store')
      assert.equal(headers.get('vary'), 'Authorization')

      const once = await read(app, `${path}&show_everything=true`, GROWER.secret)
      assert.equal(once.json.view, 'full')
      assert.deepEqual((once.json.notes as Json[]).map(note => note.body), ['second note, a little longer', 'first note in the east room'])
      assert.equal((once.json.reading as Json).bodies_sent, 2)
      assert.equal(new Map(once.headers).get('cache-control'), 'private, no-store')

      // A reader with focus mode off gets the anonymous body, sent as its own answer.
      await focusOn(app, NEIGHBOUR.secret, false)
      const unfocused = await read(app, path, NEIGHBOUR.secret)
      assert.equal(unfocused.text, anonymous.text)
      assert.equal(new Map(unfocused.headers).get('vary'), 'Authorization')
      const neverSaved = await read(app, path, FOUNDER.secret)
      assert.equal(neverSaved.text, anonymous.text)

      // One note by id is a single-record read and still sends its body.
      const noteId = Number(notes[0]!.id)
      const single = await read(app, `/api/note/${noteId}`, GROWER.secret)
      assert.equal((single.json.note as Json).body, 'second note, a little longer')
    })

    await t.test('a keyed MCP look carries no pending-ping summary, and a settings call through me is not a me read', async () => {
      const rooms = await resetCity(RESIDENTS)
      for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)
      await seedNotes(rooms.eastRoomId, NEIGHBOUR.id, ['a note to look at'])
      const pingId = await seedPing(rooms.eastRoomId, NEIGHBOUR.id, GROWER.id)
      const counts = async () => (await db.query(`
        SELECT
          (SELECT count(*)::int FROM chance_days) AS chance_days,
          (SELECT count(*)::int FROM events) AS events,
          (SELECT count(*)::int FROM city_credit_last_me_reads WHERE resident_id = ${GROWER.id}) AS me_markers,
          (SELECT count(*)::int FROM ping_receipts WHERE ping_id = ${pingId} AND seen_at IS NULL) AS unseen
      `)).rows[0]
      const start = await counts()
      assert.deepEqual(start, { chance_days: 0, events: 0, me_markers: 0, unseen: 1 })

      const changed = await mcpTool(app, GROWER.secret, 'me', { settings: { focus_mode: true } })
      assert.deepEqual((changed.settings as Json), { focus_mode: true })
      assert.equal(changed.changed, true)
      // A signed-in tool answer carries the summary, so the ping is pending here.
      assert.equal((changed.pending_pings as Json).total, 1)
      const shown = await mcpTool(app, GROWER.secret, 'me', { settings: 'show' })
      assert.deepEqual(shown.settings, { focus_mode: true })
      assert.equal(typeof shown.updated_at, 'string')
      const again = await mcpTool(app, GROWER.secret, 'me', { settings: { focus_mode: true } })
      assert.equal(again.changed, false)
      assert.deepEqual(await counts(), start, 'no settle, no event, no visit marker, no ping seen')

      const look = await mcpTool(app, GROWER.secret, 'look', { place_id: rooms.eastRoomId, view: 'full' })
      assert.equal(Object.hasOwn(look, 'pending_pings'), false)
      assert.equal(look.view, 'outline')
      assert.equal((look.reading as Json).items, 1)
      const lookOnce = await mcpTool(app, GROWER.secret, 'look', { place_id: rooms.eastRoomId, view: 'full', show_everything: true })
      assert.equal(Object.hasOwn(lookOnce, 'pending_pings'), false)
      assert.equal(((lookOnce.notes as Json[])[0]!).body, 'a note to look at')
      assert.equal((await counts())!.unseen, 1)

      // The control: an ordinary me read settles, marks the visit, and sees the ping.
      const me = await read(app, '/api/me', GROWER.secret)
      assert.equal(me.status, 200)
      const end = await counts()
      assert.ok(Number(end!.chance_days) > 0)
      assert.equal(end!.me_markers, 1)
      assert.equal(end!.unseen, 0)
    })

    await t.test('me note_view works for everyone, and focus mode makes outline the default', async () => {
      const rooms = await resetCity(RESIDENTS)
      await seedNotes(rooms.eastRoomId, NEIGHBOUR.id, ['neighbour note one', 'neighbour note two'])
      await seedNotes(rooms.eastRoomId, GROWER.id, ['grower note'])

      const outline = await read(app, '/api/me?note_view=outline', NEIGHBOUR.secret)
      assert.equal(outline.status, 200)
      assert.deepEqual((outline.json.notes as Json[]).map(note => [note.body, note.body_text_bytes]), [[undefined, 18], [undefined, 18]])
      assert.equal(Object.hasOwn(outline.json, 'reading'), false)
      const full = await read(app, '/api/me', NEIGHBOUR.secret)
      assert.deepEqual((full.json.notes as Json[]).map(note => note.body), ['neighbour note two', 'neighbour note one'])

      await focusOn(app, GROWER.secret, true)
      const focused = await read(app, '/api/me?note_view=full', GROWER.secret)
      assert.deepEqual((focused.json.notes as Json[]).map(note => [note.body, note.body_text_bytes]), [[undefined, 11]])
      assert.deepEqual([(focused.json.reading as Json).items, (focused.json.reading as Json).bodies_sent], [1, 0])
      const once = await read(app, '/api/me?show_everything=true', GROWER.secret)
      assert.deepEqual((once.json.notes as Json[]).map(note => note.body), ['grower note'])

      const refused = await read(app, '/api/me?note_view=sideways', GROWER.secret)
      assert.equal(refused.status, 400)
      assert.equal(refused.json.error, 'note_view must be outline or full; outline sends each of your notes with its size instead of its body')
      const badShow = await read(app, '/api/me?show_everything=please', GROWER.secret)
      assert.equal(badShow.json.error, 'show_everything must be true or false; send true to see every body in this one read')
    })

    await t.test('browse agreements under focus mode sends each agreement as an outline', async () => {
      await resetCity(RESIDENTS)
      await db.query('INSERT INTO agreements (created_by_id, body) VALUES ($1, $2), ($1, $3)', [GROWER.id, 'we share the well', 'we mend the fence'])
      await focusOn(app, GROWER.secret, true)
      const anonymous = await read(app, '/api/agreements')
      const focused = await read(app, '/api/agreements', GROWER.secret)
      assert.deepEqual((focused.json.agreements as Json[]).map(row => [row.body, row.body_text_bytes]), [[undefined, 17], [undefined, 17]])
      assert.equal(focused.json.returned_text_bytes, 0)
      assert.deepEqual([(focused.json.reading as Json).items, (focused.json.reading as Json).bodies_sent], [2, 0])
      const once = await read(app, '/api/agreements?show_everything=true', GROWER.secret)
      assert.deepEqual((once.json.agreements as Json[]).map(row => row.body), ['we mend the fence', 'we share the well'])
      const again = await read(app, '/api/agreements')
      assert.deepEqual(again, anonymous)
    })

    await t.test('the settings routes are private, refuse a bad change in caller words, and need a key', async () => {
      await resetCity(RESIDENTS)
      const shown = await read(app, '/api/me/settings', GROWER.secret)
      assert.equal(shown.status, 200)
      assert.deepEqual(shown.json.settings, { focus_mode: false })
      assert.equal(shown.json.updated_at, null)
      const headers = new Map(shown.headers)
      assert.equal(headers.get('cache-control'), 'no-store')
      assert.equal(headers.get('vary'), 'Authorization')
      for (const body of [{ focus_mode: 'on' }, {}, { focus_mode: true, mute: 3 }, ['focus_mode']]) {
        const refused = await call(app, GROWER.secret, 'PATCH', '/api/me/settings', body)
        assert.equal(refused.status, 400, JSON.stringify(body))
        // A repeated identical refusal gains the city's same-refusal line after it.
        assert.ok(String(refused.json.error).startsWith('settings changes must be an object with focus_mode set to true or false, like {"focus_mode": true}; send settings "show" to read your settings'))
      }
      const anonymous = await call(app, null, 'GET', '/api/me/settings')
      assert.equal(anonymous.status, 401)
      const wrong = await call(app, WRONG_KEY, 'PATCH', '/api/me/settings', { focus_mode: true })
      assert.equal(wrong.status, 401)
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM resident_settings')).rows[0]!.n), 0)
      // Each resident reads only its own settings.
      await focusOn(app, GROWER.secret, true)
      assert.deepEqual((await read(app, '/api/me/settings', NEIGHBOUR.secret)).json.settings, { focus_mode: false })
    })

    await t.test('timing: a keyed place read with and without a settings row (risk 8 baseline)', async () => {
      const rooms = await resetCity(RESIDENTS)
      await seedNotes(rooms.eastRoomId, GROWER.id, Array.from({ length: 10 }, (_, index) => `timed note ${index}`))
      const path = `/api/place/${rooms.eastRoomId}?view=full`
      const median = async (secret: string | null): Promise<number> => {
        const samples: number[] = []
        for (let index = 0; index < 40; index += 1) {
          const started = performance.now()
          const response = await app.request(`http://city.test${path}`, {
            headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
          })
          await response.arrayBuffer()
          samples.push(performance.now() - started)
        }
        samples.sort((a, b) => a - b)
        return samples[Math.floor(samples.length / 2)]!
      }
      await median(null)
      const anonymous = await median(null)
      const keyedNoRow = await median(NEIGHBOUR.secret)
      await focusOn(app, GROWER.secret, false)
      await db.query('INSERT INTO resident_settings (resident_id, focus) VALUES ($1, false) ON CONFLICT DO NOTHING', [GROWER.id])
      const keyedWithRow = await median(GROWER.secret)
      t.diagnostic(`median ms: anonymous ${anonymous.toFixed(2)}, keyed without a settings row ${keyedNoRow.toFixed(2)}, keyed with a settings row ${keyedWithRow.toFixed(2)}`)
      assert.ok(keyedWithRow > 0 && keyedNoRow > 0 && anonymous > 0)
    })
  } finally {
    await postgres.stop()
  }
})
