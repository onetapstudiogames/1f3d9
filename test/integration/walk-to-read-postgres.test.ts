// Walk-to-read notes (docs/DECISIONS.md row 102) against real PostgreSQL: the
// column, the write, every remote read that must withhold the body, the one
// passive signed-in read that opens it where the reader stands, the retired-place
// opening, the unchanged moderation reach, search on the public first line only, and
// the dated snapshot that keeps every body and carries the mark.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
  type SeededRooms,
} from '../helpers/note-suite-fixtures/postgres.ts'

const migrationDdl = await readFile(
  new URL('../../db/migrations/20260922_note_walk_to_read.sql', import.meta.url),
  'utf8',
)
const previousSnapshotViewDdl = await readFile(
  new URL('../../db/migrations/20260902_public_snapshot_quiet.sql', import.meta.url),
  'utf8',
)
const snapshotMarkMigrationDdl = await readFile(
  new URL('../../db/migrations/20260922_public_snapshot_walk_to_read.sql', import.meta.url),
  'utf8',
)

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const WRITER = Object.freeze({ id: 2, handle: 'serein-walks', secret: `1f3d9_sk_${'2'.repeat(48)}` })
const WALKER = Object.freeze({ id: 3, handle: 'far-walker', secret: `1f3d9_sk_${'3'.repeat(48)}` })
const NEWCOMER = Object.freeze({ id: 5, handle: 'no-place-yet', secret: `1f3d9_sk_${'5'.repeat(48)}` })

// The sentinel sits only after the first line, so any leak of the withheld body
// shows up as this word anywhere in a remote response.
const SENTINEL = 'kestrelvault'
const FIRST_LINE = 'Field note, east wall'
const WALK_BODY = `${FIRST_LINE}\nThe key is under the third stone: ${SENTINEL}. far-walker should look here.`
const ORDINARY_BODY = 'An ordinary note anyone reads from anywhere. far-walker was here.'

function readInPerson(noteId: number, placeId: number): string {
  return `This note is walk-to-read: its body is read in person. Stand in place_id ${placeId}, then call read_here with note_id ${noteId}, or use GET /api/note/${noteId}/here if your client can open URLs. It is not private: anyone who walks there can read it.`
}

// A repeated refusal adds plain wording after a blank line; the cause is the first line.
function firstLine(error: string): string {
  return error.split('\n')[0]!
}

type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>

async function json<T>(response: Response, status: number, label: string): Promise<T> {
  const text = await response.text()
  assert.equal(response.status, status, `${label}: ${text}`)
  return JSON.parse(text) as T
}

async function withoutSentinel(response: Response, label: string): Promise<string> {
  const text = await response.text()
  assert.equal(response.status, 200, `${label}: ${text}`)
  assert.equal(text.includes(SENTINEL), false, `${label} leaked the withheld body`)
  return text
}

async function say(
  app: CityApp,
  secret: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request('http://city.test/api/note', {
    method: 'POST', headers: bearer(secret), body: JSON.stringify(body),
  })
}

async function readHere(app: CityApp, secret: string | null, noteId: number): Promise<Response> {
  return app.request(`http://city.test/api/note/${noteId}/here`, {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  })
}

async function mcpCall(
  app: CityApp,
  secret: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Readonly<{ isError: boolean; text: string }>> {
  const response = await app.request('http://city.test/mcp', {
    method: 'POST',
    headers: bearer(secret),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const payload = await json<{ result: { isError: boolean; content: Array<{ text: string }> } }>(
    response, 200, `MCP ${name}`,
  )
  return Object.freeze({ isError: payload.result.isError, text: payload.result.content[0]!.text })
}

type Seeded = SeededRooms & Readonly<{ walkNoteId: number; ordinaryNoteId: number }>

async function seedNotes(app: CityApp): Promise<Seeded> {
  const rooms = await resetCity([FOUNDER, WRITER, WALKER, NEWCOMER])
  await standIn(WRITER.id, rooms.eastRoomId)
  await standIn(WALKER.id, rooms.westRoomId)
  await standIn(FOUNDER.id, rooms.westRoomId)
  const walk = await json<{ note: Record<string, unknown> }>(
    await say(app, WRITER.secret, { place_id: rooms.eastRoomId, body: WALK_BODY, walk_to_read: true }),
    201,
    'walk-to-read write',
  )
  const ordinary = await json<{ note: Record<string, unknown> }>(
    await say(app, WRITER.secret, { place_id: rooms.eastRoomId, body: ORDINARY_BODY }),
    201,
    'ordinary write',
  )
  return Object.freeze({
    ...rooms,
    walkNoteId: Number(walk.note.id),
    ordinaryNoteId: Number(ordinary.note.id),
  })
}

test('walk-to-read notes withhold their body remotely and open where the reader stands', {
  timeout: 300_000,
}, async t => {
  const postgres = await startNoteSuiteDatabase('walk-to-read')
  try {
    const { default: app } = await import('../../src/index.ts')

    await t.test('the additive migration runs twice and every existing note stays ordinary', async () => {
      const rooms = await resetCity([FOUNDER, WRITER])
      await connectedDatabase().query(
        `INSERT INTO notes (place_id, author_id, body) VALUES ($1, 2, 'written before the column')`,
        [rooms.eastRoomId],
      )
      await connectedDatabase().query(migrationDdl)
      await connectedDatabase().query(migrationDdl)
      const column = (await connectedDatabase().query(`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'walk_to_read'
      `)).rows
      assert.deepEqual(column, [{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }])
      const counts = (await connectedDatabase().query(
        'SELECT count(*) FILTER (WHERE walk_to_read)::integer AS walk, count(*)::integer AS notes FROM notes',
      )).rows[0]
      assert.deepEqual(counts, { walk: 0, notes: 1 })
    })

    await t.test('the writer chooses per note and the stored mark never changes', async () => {
      const seeded = await seedNotes(app)
      const rows = (await connectedDatabase().query(
        'SELECT id, walk_to_read FROM notes ORDER BY id',
      )).rows
      assert.deepEqual(rows, [
        { id: seeded.walkNoteId, walk_to_read: true },
        { id: seeded.ordinaryNoteId, walk_to_read: false },
      ])
      await assert.rejects(
        connectedDatabase().query('UPDATE notes SET walk_to_read = FALSE WHERE id = $1', [seeded.walkNoteId]),
      )
    })

    await t.test('the write answer shows the writer its own body and the mark', async () => {
      const rooms = await resetCity([FOUNDER, WRITER])
      await standIn(WRITER.id, rooms.eastRoomId)
      const written = await json<{ note: Record<string, unknown> }>(
        await say(app, WRITER.secret, { place_id: rooms.eastRoomId, body: WALK_BODY, walk_to_read: true }),
        201,
        'walk-to-read write',
      )
      assert.equal(written.note.body, WALK_BODY)
      assert.equal(written.note.walk_to_read, true)
      const replay = await json<{ note: Record<string, unknown> }>(
        await say(app, WRITER.secret, { place_id: rooms.eastRoomId, body: WALK_BODY, walk_to_read: true }),
        200,
        'identical retry',
      )
      assert.equal(replay.note.id, written.note.id)
      assert.equal(replay.note.walk_to_read, true)
      const ordinaryTwin = await json<{ note: Record<string, unknown> }>(
        await say(app, WRITER.secret, { place_id: rooms.eastRoomId, body: WALK_BODY }),
        201,
        'same body without the mark',
      )
      assert.notEqual(ordinaryTwin.note.id, written.note.id)
      assert.equal(Object.hasOwn(ordinaryTwin.note, 'walk_to_read'), false)
      // The meter's first read counts the ordinary twin's body but not the withheld one,
      // while the room's stored total still counts both.
      const room = (await connectedDatabase().query(
        'SELECT (octet_length(description) + octet_length(purpose))::integer AS bytes FROM places WHERE id = $1',
        [rooms.eastRoomId],
      )).rows[0] as { bytes: number }
      const meter = (ordinaryTwin as unknown as { reading_cost: Record<string, unknown> }).reading_cost
      const bodyBytes = Buffer.byteLength(WALK_BODY, 'utf8')
      assert.equal(meter.current_first_read_text_bytes, room.bytes + bodyBytes)
      assert.equal(meter.room_stored_text_bytes, room.bytes + 2 * bodyBytes)
    })

    await t.test('the write refuses a non-boolean mark and any walk-to-read note in the Gazette room', async () => {
      const rooms = await resetCity([FOUNDER, WRITER])
      await standIn(WRITER.id, rooms.eastRoomId)
      for (const value of ['yes', 1, null, 'true']) {
        const refused = await json<{ error: string }>(
          await say(app, WRITER.secret, { place_id: rooms.eastRoomId, body: 'x', walk_to_read: value }),
          400,
          `walk_to_read ${JSON.stringify(value)}`,
        )
        assert.equal(firstLine(refused.error), 'walk_to_read must be true or false')
      }
      const unknown = await json<{ error: string }>(
        await say(app, WRITER.secret, { place_id: rooms.eastRoomId, body: 'x', secret_note: true }),
        400,
        'unknown field',
      )
      assert.equal(firstLine(unknown.error), 'send place_id and body, plus optional walk_to_read true or false, and no other field')
      const gazette = await json<{ error: string }>(
        await say(app, WRITER.secret, { place_id: 454, body: 'x', walk_to_read: true }),
        400,
        'Gazette room',
      )
      assert.equal(
        firstLine(gazette.error),
        'room #454 is the Gazette submission room, where every submission is printed for everyone to read, so a note there cannot be walk-to-read; send walk_to_read false, or leave the walk-to-read note in another room',
      )
      const stored = (await connectedDatabase().query('SELECT count(*)::integer AS notes FROM notes')).rows[0]
      assert.deepEqual(stored, { notes: 0 })
    })

    await t.test('every remote read shows id, author, place, time, size, and first line only', async () => {
      const seeded = await seedNotes(app)
      const expected = {
        id: seeded.walkNoteId,
        place_id: seeded.eastRoomId,
        author: WRITER.handle,
        walk_to_read: true,
        first_line: FIRST_LINE,
        body_text_bytes: Buffer.byteLength(WALK_BODY, 'utf8'),
        read_in_person: readInPerson(seeded.walkNoteId, seeded.eastRoomId),
      }

      const direct = JSON.parse(await withoutSentinel(
        await app.request(`http://city.test/api/note/${seeded.walkNoteId}`), 'GET /api/note/:id',
      )) as { note: Record<string, unknown> }
      const { created_at: createdAt, ...directNote } = direct.note
      assert.equal(typeof createdAt, 'string')
      assert.deepEqual(directNote, expected)

      const ordinary = await json<{ note: Record<string, unknown> }>(
        await app.request(`http://city.test/api/note/${seeded.ordinaryNoteId}`), 200, 'ordinary note',
      )
      assert.equal(ordinary.note.body, ORDINARY_BODY)
      assert.equal(Object.hasOwn(ordinary.note, 'walk_to_read'), false)

      const full = JSON.parse(await withoutSentinel(
        await app.request(`http://city.test/api/place/${seeded.eastRoomId}?view=full`), 'full place read',
      )) as { notes: Array<Record<string, unknown>>; notes_page: Record<string, unknown> }
      const fullWalk = full.notes.find(note => note.id === seeded.walkNoteId)!
      assert.equal(fullWalk.first_line, FIRST_LINE)
      assert.equal(fullWalk.read_in_person, expected.read_in_person)
      assert.equal(Object.hasOwn(fullWalk, 'body'), false)
      assert.equal(full.notes_page.returned_text_bytes, Buffer.byteLength(ORDINARY_BODY, 'utf8'))
      assert.equal(
        full.notes_page.total_text_bytes,
        Buffer.byteLength(ORDINARY_BODY, 'utf8') + Buffer.byteLength(WALK_BODY, 'utf8'),
      )

      const budgeted = JSON.parse(await withoutSentinel(
        await app.request(`http://city.test/api/place/${seeded.eastRoomId}?view=full&note_text_limit_bytes=65536`),
        'text-limited place read',
      )) as { notes: Array<Record<string, unknown>>; notes_page: Record<string, unknown> }
      assert.equal(budgeted.notes.find(note => note.id === seeded.walkNoteId)?.first_line, FIRST_LINE)
      assert.equal(budgeted.notes_page.returned_text_bytes, Buffer.byteLength(ORDINARY_BODY, 'utf8'))

      const outline = JSON.parse(await withoutSentinel(
        await app.request(`http://city.test/api/place/${seeded.eastRoomId}`), 'outline place read',
      )) as { notes: Array<Record<string, unknown>> }
      const outlineWalk = outline.notes.find(note => note.id === seeded.walkNoteId)!
      assert.equal(outlineWalk.walk_to_read, true)
      assert.equal(outlineWalk.read_in_person, expected.read_in_person)
      assert.equal(outlineWalk.body_text_bytes, Buffer.byteLength(WALK_BODY, 'utf8'))

      for (const path of [
        '/api/window?collection=notes',
        `/api/window?collection=notes&place_id=${seeded.eastRoomId}`,
        `/api/window?collection=notes&resident=${WRITER.handle}&context=place`,
        '/api/window?view=outline',
        '/api/window?view=full',
        '/api/changes?since=0&limit=200',
        '/api/events?limit=200',
        `/window/note/${seeded.walkNoteId}`,
      ]) {
        const text = await withoutSentinel(await app.request(`http://city.test${path}`), path)
        if (path.startsWith('/api/window?collection')) {
          const page = JSON.parse(text) as { notes: Array<Record<string, unknown>> }
          const windowWalk = page.notes.find(note => note.id === seeded.walkNoteId)
          assert.equal(windowWalk?.first_line, FIRST_LINE, path)
          assert.equal(windowWalk?.walk_to_read, true, path)
        }
      }
    })

    await t.test('search matches only the public first line and shows what the note read shows', async () => {
      const seeded = await seedNotes(app)
      const noteRead = await json<{ note: Record<string, unknown> }>(
        await app.request(`http://city.test/api/note/${seeded.walkNoteId}`), 200, 'note read',
      )
      const expected = {
        type: 'note',
        id: seeded.walkNoteId,
        place_id: seeded.eastRoomId,
        author_id: WRITER.id,
        author: WRITER.handle,
        body_text_bytes: noteRead.note.body_text_bytes,
        walk_to_read: true,
        first_line: noteRead.note.first_line,
        read_in_person: noteRead.note.read_in_person,
        href: `/api/note/${seeded.walkNoteId}`,
      }
      assert.equal(expected.first_line, FIRST_LINE)
      for (const [q, mode, type] of [
        ['Field note east wall', 'words', 'note'],
        ['note, east wall', 'phrase', 'note'],
        ['wall', 'words', 'all'],
      ] as const) {
        const label = `search ${mode} ${type} ${q}`
        const found = await json<{ results: Array<Record<string, unknown>>; total_items: number }>(
          await app.request(`http://city.test/api/search?q=${encodeURIComponent(q)}&mode=${mode}&type=${type}`),
          200, label,
        )
        assert.equal(found.total_items, 1, label)
        const { created_at: createdAt, ...result } = found.results[0]!
        assert.equal(typeof createdAt, 'string', label)
        assert.deepEqual(result, expected, label)
        assert.equal(JSON.stringify(found.results).includes(SENTINEL), false, `${label} leaked the body`)
      }
      // The answer echoes the query itself, so only its results are checked for the note.
      for (const [q, mode] of [
        [SENTINEL, 'words'],
        [SENTINEL, 'phrase'],
        ['third stone', 'phrase'],
        ['east kestrelvault', 'words'],
      ] as const) {
        const missed = await json<{ results: unknown[]; total_items: number }>(
          await app.request(`http://city.test/api/search?q=${encodeURIComponent(q)}&mode=${mode}&type=all`),
          200, `search ${mode} ${q}`,
        )
        assert.deepEqual(missed.results, [], q)
        assert.equal(missed.total_items, 0, q)
      }
      const ordinary = await json<{ results: Array<Record<string, unknown>> }>(
        await app.request('http://city.test/api/search?q=ordinary%20note&type=note'), 200, 'ordinary search',
      )
      assert.deepEqual(ordinary.results.map(result => result.id), [seeded.ordinaryNoteId])
      assert.equal(Object.hasOwn(ordinary.results[0]!, 'walk_to_read'), false)
      assert.equal(Object.hasOwn(ordinary.results[0]!, 'first_line'), false)

      const tool = await mcpCall(app, WALKER.secret, 'search', { q: 'east wall', type: 'note' })
      assert.equal(tool.isError, false)
      assert.equal(tool.text.includes(SENTINEL), false)
      const toolResults = (JSON.parse(tool.text) as { results: Array<Record<string, unknown>> }).results
      assert.deepEqual(toolResults.map(({ created_at: _createdAt, ...result }) => result), [expected])
    })

    await t.test('search cuts the first line exactly where the note read cuts it', async () => {
      const rooms = await resetCity([FOUNDER, WRITER])
      await standIn(WRITER.id, rooms.eastRoomId)
      const ids: number[] = []
      for (const body of [
        `Tide table posted\r\n${SENTINEL} after a carriage return`,
        `${'word '.repeat(39)}wordy cliffmarker past the cut\nsecond line`,
        `${'\u{1F30A}'.repeat(199)}Zq wave count past the cut`,
      ]) {
        const written = await json<{ note: { id: number } }>(
          await say(app, WRITER.secret, { place_id: rooms.eastRoomId, body, walk_to_read: true }),
          201, 'edge note',
        )
        ids.push(written.note.id)
      }
      // The write door refuses a line separator today, but an older note may hold one,
      // and the first-line rule breaks there too.
      ids.push(Number((await connectedDatabase().query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body, walk_to_read)
        VALUES ($1, $2, $3, TRUE) RETURNING id
      `, [rooms.eastRoomId, WRITER.id, `Harbor lamp lit\u2028${SENTINEL} after a line separator`])).rows[0]!.id))

      // The real search SQL runs directly here, so these cases spend none of the
      // per-caller search allowance the HTTP and MCP cases above use.
      const { loadPublicSearchResults, parsePublicSearchQuery } = await import('../../src/public-search.ts')
      const search = async (q: string, mode: 'words' | 'phrase'): Promise<number[]> => {
        const parsed = parsePublicSearchQuery({ q: [q], mode: [mode], type: ['note'] })
        assert.ok(parsed.ok, q)
        const found = await loadPublicSearchResults(
          async (text, params) => (await connectedDatabase().query(text, [...params])).rows,
          parsed,
        )
        const results = found.items as ReadonlyArray<{ id: number; first_line: unknown }>
        for (const result of results) {
          const read = await json<{ note: Record<string, unknown> }>(
            await app.request(`http://city.test/api/note/${result.id}`), 200, `note ${result.id}`,
          )
          assert.equal(result.first_line, read.note.first_line, `first line of note ${result.id}`)
        }
        return results.map(result => result.id)
      }
      assert.deepEqual(await search('table posted', 'words'), [ids[0]])
      assert.deepEqual(await search('wordy', 'words'), [ids[1]])
      assert.deepEqual(await search('cliffmarker', 'words'), [])
      assert.deepEqual(await search('\u{1F30A}Z', 'phrase'), [ids[2]])
      assert.deepEqual(await search('Zq', 'phrase'), [])
      assert.deepEqual(await search('lamp lit', 'phrase'), [ids[3]])
      assert.deepEqual(await search(SENTINEL, 'words'), [])
    })

    await t.test('a walk-to-read body never counts as a mention remotely, while its writer keeps it in me', async () => {
      const rooms = await resetCity([FOUNDER, WRITER, WALKER])
      await standIn(WRITER.id, rooms.eastRoomId)
      await standIn(WALKER.id, rooms.westRoomId)
      await json(await app.request('http://city.test/api/me', { headers: bearer(WALKER.secret) }), 200, 'baseline me')
      const walk = await json<{ note: { id: number } }>(
        await say(app, WRITER.secret, { place_id: rooms.eastRoomId, body: WALK_BODY, walk_to_read: true }),
        201, 'walk-to-read write',
      )
      const ordinary = await json<{ note: { id: number } }>(
        await say(app, WRITER.secret, { place_id: rooms.eastRoomId, body: ORDINARY_BODY }),
        201, 'ordinary write',
      )
      const walker = JSON.parse(await withoutSentinel(
        await app.request('http://city.test/api/me', { headers: bearer(WALKER.secret) }), 'walker me',
      )) as { since_last_visit: { around_you: { mentions: { records: Array<{ id: number }> } } } }
      assert.deepEqual(
        walker.since_last_visit.around_you.mentions.records.map(record => record.id),
        [ordinary.note.id],
      )
      const writer = await json<{ notes: Array<Record<string, unknown>> }>(
        await app.request('http://city.test/api/me', { headers: bearer(WRITER.secret) }), 200, 'writer me',
      )
      const own = writer.notes.find(note => note.id === walk.note.id)!
      assert.equal(own.body, WALK_BODY)
      assert.equal(own.walk_to_read, true)
    })

    await t.test('read_here opens the body only where the reader stands and changes nothing', async () => {
      const seeded = await seedNotes(app)
      const before = (await connectedDatabase().query(`
        SELECT
          (SELECT count(*)::integer FROM events) AS events,
          (SELECT count(*)::integer FROM resident_presence) AS presence_rows,
          (SELECT current_place_id FROM resident_presence WHERE resident_id = 3) AS walker_place,
          (SELECT updated_at::text FROM resident_presence WHERE resident_id = 3) AS walker_updated,
          (SELECT quota_day::text || '/' || notes_today FROM residents WHERE id = 3) AS walker_quota
      `)).rows[0]

      const away = await json<{ error: string }>(await readHere(app, WALKER.secret, seeded.walkNoteId), 403, 'away')
      assert.equal(
        firstLine(away.error),
        `note_id ${seeded.walkNoteId} is walk-to-read, so its body opens only to a resident standing in place_id ${seeded.eastRoomId}, and you are standing in place_id ${seeded.westRoomId}; walk to place_id ${seeded.eastRoomId}, then call read_here with note_id ${seeded.walkNoteId} again, or use GET /api/note/${seeded.walkNoteId}/here if your client can open URLs`,
      )
      assert.equal(away.error.includes(SENTINEL), false)

      const unset = await json<{ error: string }>(await readHere(app, NEWCOMER.secret, seeded.walkNoteId), 403, 'unset')
      assert.equal(
        firstLine(unset.error),
        `note_id ${seeded.walkNoteId} is walk-to-read, so its body opens only to a resident standing in place_id ${seeded.eastRoomId}, and your standing place is unset; call me to see where you stand, walk to place_id ${seeded.eastRoomId}, then call read_here with note_id ${seeded.walkNoteId} again, or use GET /api/note/${seeded.walkNoteId}/here if your client can open URLs`,
      )

      const anonymous = await readHere(app, null, seeded.walkNoteId)
      assert.equal(anonymous.status, 401)
      assert.equal((await anonymous.text()).includes(SENTINEL), false)

      const missing = await json<{ error: string }>(await readHere(app, WALKER.secret, 999_999), 404, 'missing')
      assert.equal(firstLine(missing.error), "note_id 999999 was not found; re-read the place's recent notes and use a current note_id")

      const after = (await connectedDatabase().query(`
        SELECT
          (SELECT count(*)::integer FROM events) AS events,
          (SELECT count(*)::integer FROM resident_presence) AS presence_rows,
          (SELECT current_place_id FROM resident_presence WHERE resident_id = 3) AS walker_place,
          (SELECT updated_at::text FROM resident_presence WHERE resident_id = 3) AS walker_updated,
          (SELECT quota_day::text || '/' || notes_today FROM residents WHERE id = 3) AS walker_quota
      `)).rows[0]
      assert.deepEqual(after, before, 'a refused read_here records nothing and seeds no presence')

      await standIn(WALKER.id, seeded.eastRoomId)
      const presenceBefore = (await connectedDatabase().query(
        'SELECT current_place_id, updated_at::text FROM resident_presence WHERE resident_id = 3',
      )).rows
      const eventsBefore = (await connectedDatabase().query('SELECT count(*)::integer AS events FROM events')).rows
      const opened = await readHere(app, WALKER.secret, seeded.walkNoteId)
      assert.equal(opened.headers.get('cache-control'), 'no-store')
      const here = await json<{ note: Record<string, unknown> }>(opened, 200, 'standing there')
      assert.equal(here.note.body, WALK_BODY)
      assert.equal(here.note.walk_to_read, true)
      assert.equal(Object.hasOwn(here.note, 'read_in_person'), false)
      assert.deepEqual((await connectedDatabase().query(
        'SELECT current_place_id, updated_at::text FROM resident_presence WHERE resident_id = 3',
      )).rows, presenceBefore)
      assert.deepEqual((await connectedDatabase().query('SELECT count(*)::integer AS events FROM events')).rows, eventsBefore)
      assert.deepEqual((await connectedDatabase().query(
        'SELECT count(*)::integer AS looking FROM resident_looking',
      )).rows, [{ looking: 0 }])

      const ordinaryAnywhere = await json<{ note: Record<string, unknown> }>(
        await readHere(app, NEWCOMER.secret, seeded.ordinaryNoteId), 200, 'ordinary note anywhere',
      )
      assert.equal(ordinaryAnywhere.note.body, ORDINARY_BODY)
    })

    await t.test('the read_here tool gives the same answer on the key-capable MCP door', async () => {
      const seeded = await seedNotes(app)
      const away = await mcpCall(app, WALKER.secret, 'read_here', { note_id: seeded.walkNoteId })
      assert.equal(away.isError, true)
      assert.equal(away.text.includes(SENTINEL), false)
      assert.match(away.text, /walk to place_id \d+, then call read_here/u)
      await standIn(WALKER.id, seeded.eastRoomId)
      const here = await mcpCall(app, WALKER.secret, 'read_here', { note_id: seeded.walkNoteId })
      assert.equal(here.isError, false)
      assert.equal((JSON.parse(here.text) as { note: { body: string } }).note.body, WALK_BODY)
      const looked = await mcpCall(app, WALKER.secret, 'look', { note_id: seeded.walkNoteId })
      assert.equal(looked.isError, false)
      assert.equal(looked.text.includes(SENTINEL), false, 'look stays a remote read even while standing there')
    })

    await t.test('the founder keeps moderation reach: a full read anywhere and removal everywhere', async () => {
      const seeded = await seedNotes(app)
      const founderRead = await json<{ note: Record<string, unknown> }>(
        await readHere(app, FOUNDER.secret, seeded.walkNoteId), 200, 'founder read',
      )
      assert.equal(founderRead.note.body, WALK_BODY)
      const removed = await app.request('http://city.test/api/moderation', {
        method: 'POST',
        headers: bearer(FOUNDER.secret),
        body: JSON.stringify({
          action: 'remove', target_type: 'note', target_id: seeded.walkNoteId, reason: 'illegal content test',
        }),
      })
      assert.equal(removed.status, 201, await removed.clone().text())
      const direct = await json<{ note: Record<string, unknown> }>(
        await app.request(`http://city.test/api/note/${seeded.walkNoteId}`), 200, 'moderated note',
      )
      assert.equal(direct.note.first_line, '[removed by maintainer]')
      assert.equal(direct.note.moderated, true)
      await standIn(WALKER.id, seeded.eastRoomId)
      const here = await json<{ note: Record<string, unknown> }>(
        await readHere(app, WALKER.secret, seeded.walkNoteId), 200, 'moderated read here',
      )
      assert.equal(here.note.body, '[removed by maintainer]')
    })

    await t.test('a retired place opens its walk-to-read bodies to everyone, and restoring closes them again', async () => {
      const seeded = await seedNotes(app)
      await connectedDatabase().query('DELETE FROM resident_presence WHERE current_place_id = $1', [seeded.eastRoomId])
      await connectedDatabase().query('UPDATE places SET retired_at = now() WHERE id = $1', [seeded.eastRoomId])
      const opened = await json<{ note: Record<string, unknown> }>(
        await app.request(`http://city.test/api/note/${seeded.walkNoteId}`), 200, 'retired place note',
      )
      assert.equal(opened.note.body, WALK_BODY)
      assert.equal(opened.note.walk_to_read, true)
      const tombstone = await json<{ notes: Array<Record<string, unknown>> }>(
        await app.request(`http://city.test/api/place/${seeded.eastRoomId}?view=full`), 200, 'tombstone',
      )
      assert.equal(tombstone.notes.find(note => note.id === seeded.walkNoteId)?.body, WALK_BODY)
      const found = await json<{ results: Array<{ id: number }> }>(
        await app.request(`http://city.test/api/search?q=${SENTINEL}&type=note`), 200, 'retired search',
      )
      assert.deepEqual(found.results.map(result => result.id), [seeded.walkNoteId])
      const anywhere = await json<{ note: Record<string, unknown> }>(
        await readHere(app, WALKER.secret, seeded.walkNoteId), 200, 'read_here in a retired place',
      )
      assert.equal(anywhere.note.body, WALK_BODY)

      await connectedDatabase().query('UPDATE places SET retired_at = NULL WHERE id = $1', [seeded.eastRoomId])
      await withoutSentinel(
        await app.request(`http://city.test/api/note/${seeded.walkNoteId}`), 'restored place note',
      )
    })

    await t.test('the dated public snapshot keeps every body and carries the walk_to_read mark', async () => {
      const seeded = await seedNotes(app)
      const snapshotNotes = async (): Promise<Map<number, Record<string, unknown>>> => new Map(
        (await connectedDatabase().query<{ payload: Record<string, unknown> }>(`
          SELECT payload FROM city_snapshot.public_records_v2
          WHERE class_name = 'notes' AND payload->>'status' = 'exported'
        `)).rows.map(row => [Number(row.payload.id), row.payload]),
      )
      const current = await snapshotNotes()
      assert.equal(current.get(seeded.walkNoteId)?.body, WALK_BODY)
      assert.equal(current.get(seeded.walkNoteId)?.walk_to_read, true)
      assert.equal(current.get(seeded.ordinaryNoteId)?.body, ORDINARY_BODY)
      assert.equal(current.get(seeded.ordinaryNoteId)?.walk_to_read, false)

      // A database still on the earlier snapshot view gains the mark from the migration,
      // and running it again changes nothing.
      await connectedDatabase().query(previousSnapshotViewDdl)
      const before = await snapshotNotes()
      assert.equal(Object.hasOwn(before.get(seeded.walkNoteId)!, 'walk_to_read'), false)
      assert.equal(before.get(seeded.walkNoteId)?.body, WALK_BODY)
      await connectedDatabase().query(snapshotMarkMigrationDdl)
      await connectedDatabase().query(snapshotMarkMigrationDdl)
      assert.deepEqual(await snapshotNotes(), current)
    })
  } finally {
    await postgres.stop()
  }
})
