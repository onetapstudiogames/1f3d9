// Reading filters (decision #157) against real PostgreSQL: the real schema, the real
// routes, the real migration. A signed-in reader's filters change how the bodies it
// still reads are sent: show as written, describe, or hide, then its own muted words.
// The founder's items and the reader's own never change, an allow with show_anyway lets
// one item through, and anonymous reads, and a reader with every filter on show, read
// exactly what anyone reads.
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

// GROWER is the reader; NEIGHBOUR writes what it reads; FAR_SHORE chooses every filter on show.
const FAR_SHORE = Object.freeze({ id: 5, handle: 'far-shore', secret: `1f3d9_sk_${'5'.repeat(48)}` })
const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR, FAR_SHORE] as const

const migration = await readFile(
  new URL('../../db/migrations/20261017_reading_filters.sql', import.meta.url),
  'utf8',
)

const MARKERS = Object.freeze({
  encoded: '[hidden by your reading filters: encoded text]',
  untranslatable: '[hidden by your reading filters: encoded text that does not translate to readable words]',
  code: '[hidden by your reading filters: code-like text]',
  link: '[hidden by your reading filters: a link]',
  emoji: '[hidden by your reading filters: emoji]',
  drawing: '[hidden by your reading filters: a drawing]',
  muted: '[hidden by your reading filters: one of your muted words]',
})

type Read = Readonly<{ status: number; headers: Readonly<Record<string, string>>; text: string; json: Json }>

async function read(app: CityApp, path: string, secret: string | null = null): Promise<Read> {
  const response = await app.request(`http://city.test${path}`, {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  })
  const text = await response.text()
  return Object.freeze({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text,
    json: text === '' ? {} : JSON.parse(text) as Json,
  })
}

async function mcpCall(app: CityApp, secret: string, name: string, args: Json): Promise<{ isError: boolean; text: string }> {
  const response = await app.request('http://city.test/mcp', {
    method: 'POST',
    headers: { ...bearer(secret), accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  assert.equal(response.status, 200)
  const rpc = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  return { isError: rpc.result.isError, text: rpc.result.content[0]!.text }
}

async function settings(app: CityApp, secret: string, change: Json): Promise<Read> {
  const response = await app.request('http://city.test/api/me/settings', {
    method: 'PATCH',
    headers: bearer(secret),
    body: JSON.stringify(change),
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, headers: {}, text, json: JSON.parse(text) as Json })
}

async function change(app: CityApp, secret: string, body: Json): Promise<Json> {
  const changed = await settings(app, secret, body)
  assert.equal(changed.status, 200, changed.text)
  return changed.json
}

async function insertId(text: string, values: readonly unknown[]): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(text, [...values])).rows[0]!.id)
}

async function seedNote(placeId: number, authorId: number, body: string): Promise<number> {
  return insertId('INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, $3) RETURNING id', [placeId, authorId, body])
}

async function seedThing(placeId: number, makerId: number, name: string, body: string): Promise<number> {
  return insertId(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id) VALUES ($1, $2, $3, $4, $4) RETURNING id
  `, [placeId, name, body, makerId])
}

async function say(app: CityApp, secret: string, placeId: number, body: string): Promise<number> {
  const said = await call(app, secret, 'POST', '/api/line', { place_id: placeId, body, request_id: randomUUID() })
  assert.equal(said.status, 201, JSON.stringify(said.json))
  return Number((said.json.line as Json).id)
}

function binary(text: string): string {
  return [...Buffer.from(text, 'utf8')].map(byte => byte.toString(2).padStart(8, '0')).join(' ')
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function byId(rows: unknown): Map<number, Json> {
  return new Map((rows as Json[]).map(row => [Number(row.id), row]))
}

const MORSE_HELLO = '.... . .-.. .-.. --- / .-- --- .-. .-.. -..'
const JSON_BODY = JSON.stringify(Object.fromEntries(Array.from({ length: 38 }, (_value, index) => [`k${index}`, index])), null, 1)
const EVERY_DESCRIBE = Object.freeze({
  encoded_text: 'describe', drawings: 'describe', code_like_text: 'describe', links: 'describe', emoji: 'describe',
})
const EVERY_HIDE = Object.freeze({ encoded_text: 'hide', drawings: 'hide', code_like_text: 'hide', links: 'hide', emoji: 'hide' })
const EVERY_SHOW = Object.freeze({ encoded_text: 'show', drawings: 'show', code_like_text: 'show', links: 'show', emoji: 'show' })

async function settingsCatalog(): Promise<Json> {
  const db = connectedDatabase()
  const columns = await db.query(
    'SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns ' +
      "WHERE table_schema = 'public' AND table_name IN ('resident_settings', 'resident_mutes') ORDER BY table_name, ordinal_position",
  )
  const constraints = await db.query(
    'SELECT conrelid::regclass::text AS table_name, conname, convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint ' +
      "WHERE conrelid IN ('resident_settings'::regclass, 'resident_mutes'::regclass) ORDER BY 1, conname",
  )
  return { columns: columns.rows, constraints: constraints.rows }
}

test('reading filters against real PostgreSQL', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('reading-filters')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()

    await t.test('the migration applies twice to a city without the columns, changes no row, and its checks hold', async () => {
      await resetCity(RESIDENTS)
      const fresh = await settingsCatalog()
      assert.equal((fresh.constraints as Json[]).filter(row => /filter_known|muted_words_count|show_anyway_on_allow/u.test(String(row.conname))).length, 7)
      await db.query(`INSERT INTO resident_settings (resident_id, focus) VALUES (${GROWER.id}, TRUE)`)
      await db.query(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES (${GROWER.id}, 'resident', ${NEIGHBOUR.id}, 'mute')`)
      await db.query(`
        ALTER TABLE resident_settings
          DROP COLUMN encoded_text_filter, DROP COLUMN drawings_filter, DROP COLUMN code_like_text_filter,
          DROP COLUMN links_filter, DROP COLUMN emoji_filter, DROP COLUMN muted_words;
        ALTER TABLE resident_mutes DROP COLUMN show_anyway;
      `)
      const before = (await db.query('SELECT resident_id, focus FROM resident_settings')).rows
      const mutesBefore = (await db.query('SELECT id, resident_id, target_type, target_id, choice FROM resident_mutes')).rows
      const residentsBefore = (await db.query('SELECT * FROM residents ORDER BY id')).rows
      await db.query(migration)
      await db.query(migration)
      assert.deepEqual(await settingsCatalog(), fresh)
      assert.deepEqual((await db.query('SELECT resident_id, focus FROM resident_settings')).rows, before)
      assert.deepEqual((await db.query('SELECT id, resident_id, target_type, target_id, choice FROM resident_mutes')).rows, mutesBefore)
      assert.deepEqual((await db.query('SELECT * FROM residents ORDER BY id')).rows, residentsBefore)
      assert.deepEqual(
        (await db.query('SELECT encoded_text_filter, emoji_filter, muted_words FROM resident_settings')).rows,
        [{ encoded_text_filter: 'show', emoji_filter: 'show', muted_words: [] }],
      )
      const refused = async (statement: string) => {
        await assert.rejects(db.query(statement), /violates check constraint/u, statement)
      }
      await refused(`UPDATE resident_settings SET encoded_text_filter = 'translate'`)
      await refused(`UPDATE resident_settings SET links_filter = 'Show'`)
      await refused(`UPDATE resident_settings SET muted_words = array_fill('w'::text, ARRAY[201])`)
      await refused(`UPDATE resident_mutes SET show_anyway = TRUE WHERE choice = 'mute'`)
      await db.query(`UPDATE resident_settings SET muted_words = array_fill('w'::text, ARRAY[200])`)
    })

    await t.test('settings set the filters and keep the muted words private: counted, never echoed unless asked', async () => {
      await resetCity(RESIDENTS)
      const set = await change(app, GROWER.secret, { filters: { encoded_text: 'describe', links: 'hide' } })
      assert.equal(set.changed, true)
      assert.deepEqual((set.settings as Json).filters, {
        encoded_text: 'describe', drawings: 'show', code_like_text: 'show', links: 'hide', emoji: 'show',
      })
      assert.equal((await change(app, GROWER.secret, { filters: { links: 'hide' } })).changed, false)
      assert.equal((await change(app, GROWER.secret, { filters: { links: 'show' } })).changed, true)

      const added = await change(app, GROWER.secret, { muted_words: { add: ['Lantern', 'old mill'] } })
      assert.equal(added.changed, true)
      assert.equal((added.settings as Json).muted_words_count, 2)
      assert.equal(Object.hasOwn(added.settings as Json, 'muted_words'), false, 'a change never echoes the list')
      assert.equal(JSON.stringify(added).includes('old mill'), false)
      const shown = await read(app, '/api/me/settings', GROWER.secret)
      assert.equal(JSON.stringify(shown.json).includes('Lantern'), false, 'settings "show" gives only the count')
      assert.equal((shown.json.settings as Json).muted_words_count, 2)
      const asked = await read(app, '/api/me/settings?show_muted_words=true', GROWER.secret)
      assert.deepEqual((asked.json.settings as Json).muted_words, ['Lantern', 'old mill'])
      assert.equal(asked.headers['cache-control'], 'no-store')
      // The same through me on the key door: only with settings "show" and show_muted_words.
      const viaMe = await mcpCall(app, GROWER.secret, 'me', { settings: 'show', show_muted_words: true })
      assert.equal(viaMe.isError, false, viaMe.text)
      assert.deepEqual(((JSON.parse(viaMe.text) as Json).settings as Json).muted_words, ['Lantern', 'old mill'])
      const plainMe = await mcpCall(app, GROWER.secret, 'me', { settings: 'show' })
      assert.equal(plainMe.text.includes('Lantern'), false)
      const strayAsk = await mcpCall(app, GROWER.secret, 'me', { show_muted_words: true })
      assert.equal(strayAsk.isError, true)
      assert.match(strayAsk.text, /show_muted_words goes only with settings \\"show\\"/u)
      assert.equal((await read(app, '/api/me/settings?show_muted_words=yes', GROWER.secret)).status, 400)

      // Refusals name a bad entry by its position, never its text, and save nothing.
      const already = await settings(app, GROWER.secret, { muted_words: { add: ['new word', 'LANTERN'] } })
      assert.equal(already.status, 400)
      assert.ok(String(already.json.error).startsWith('muted_words entry 2 is already on your list, ignoring case'), already.text)
      assert.equal(already.text.includes('LANTERN'), false)
      const tooLong = await settings(app, GROWER.secret, { muted_words: { add: ['fine', `secret-${'x'.repeat(100)}`] } })
      assert.equal(tooLong.status, 400)
      assert.ok(String(tooLong.json.error).startsWith('muted_words entry 2 is longer than 100 characters'), tooLong.text)
      assert.equal(tooLong.text.includes('secret-'), false)
      const words = (await db.query('SELECT muted_words FROM resident_settings WHERE resident_id = $1', [GROWER.id])).rows[0]!.muted_words
      assert.deepEqual(words, ['Lantern', 'old mill'])

      // Removal ignores case; a word not kept changes nothing.
      assert.equal((await change(app, GROWER.secret, { muted_words: { remove: ['OLD MILL'] } })).changed, true)
      assert.equal((await change(app, GROWER.secret, { muted_words: { remove: ['never kept'] } })).changed, false)
      // At most 200 words.
      const many = Array.from({ length: 199 }, (_value, index) => `word${index}`)
      assert.equal(((await change(app, GROWER.secret, { muted_words: { add: many } })).settings as Json).muted_words_count, 200)
      const over = await settings(app, GROWER.secret, { muted_words: { add: ['one more'] } })
      assert.equal(over.status, 400)
      assert.ok(String(over.json.error).startsWith('you can keep at most 200 muted words; you have 200'), over.text)

      // show_anyway rides only on an allow.
      const rooms = await resetCity(RESIDENTS)
      const neighbourNote = await seedNote(rooms.eastRoomId, NEIGHBOUR.id, 'words')
      const allowed = await change(app, GROWER.secret, { allow: { type: 'note', id: neighbourNote, show_anyway: true } })
      assert.deepEqual(((allowed.settings as Json).mutes as Json[]).map(row => [row.type, row.id, row.choice, row.show_anyway]), [['note', neighbourNote, 'allow', true]])
      const onMute = await settings(app, GROWER.secret, { mute: { type: 'note', id: neighbourNote, show_anyway: true } })
      assert.equal(onMute.status, 400)
      assert.ok(String(onMute.json.error).startsWith('show_anyway goes only with allow'), onMute.text)
      // A mute that replaces the allow clears show_anyway; the database check holds.
      await change(app, GROWER.secret, { mute: { type: 'note', id: neighbourNote } })
      assert.deepEqual((await db.query('SELECT choice, show_anyway FROM resident_mutes')).rows, [{ choice: 'mute', show_anyway: false }])
      // Nobody is told.
      assert.equal(Number((await db.query(`SELECT count(*) FROM events WHERE detail::text LIKE '%filter%' OR detail::text LIKE '%muted_words%'`)).rows[0]!.count), 0)
    })

    await t.test('every read path describes or hides what the reader chose; the founder\'s and its own items never change', async () => {
      const rooms = await resetCity(RESIDENTS)
      for (const resident of [GROWER, NEIGHBOUR, FAR_SHORE]) await standIn(resident.id, rooms.eastRoomId)
      await db.query('UPDATE places SET open_to_things = TRUE WHERE id = $1', [rooms.eastRoomId])
      const hall = await insertId(`
        INSERT INTO places (parent_id, place_kind, name, description, purpose, owner_id, open_to_notes)
        VALUES ($1, 'place', 'Neighbour Hall', 'see https://www.google.com/maps for the way', 'a hall 😀 for all', $2, TRUE) RETURNING id
      `, [rooms.continentId, NEIGHBOUR.id])
      const notes = {
        binary: await seedNote(rooms.eastRoomId, NEIGHBOUR.id, binary('meet me at the old mill')),
        morse: await seedNote(rooms.eastRoomId, NEIGHBOUR.id, MORSE_HELLO),
        base64: await seedNote(rooms.eastRoomId, NEIGHBOUR.id, base64('a quiet square')),
        unreadable: await seedNote(rooms.eastRoomId, NEIGHBOUR.id, binary('\u0000\u0001\u0002')),
        link: await seedNote(rooms.eastRoomId, NEIGHBOUR.id, 'read https://www.google.com/maps now'),
        emoji: await seedNote(rooms.eastRoomId, NEIGHBOUR.id, 'hello 😀 💬 🚪'),
        muted: await seedNote(rooms.eastRoomId, NEIGHBOUR.id, 'the Lantern glows'),
        insideTranslation: await seedNote(rooms.eastRoomId, NEIGHBOUR.id, binary('a lantern inside')),
        plain: await seedNote(rooms.eastRoomId, NEIGHBOUR.id, 'plain words only'),
        founder: await seedNote(rooms.eastRoomId, FOUNDER.id, binary('founder words lantern')),
        own: await seedNote(rooms.eastRoomId, GROWER.id, binary('my own lantern')),
      }
      const jsonThing = await seedThing(rooms.eastRoomId, NEIGHBOUR.id, 'a ledger', JSON_BODY)
      const removedNote = await seedNote(rooms.eastRoomId, NEIGHBOUR.id, binary('a removed note'))
      await db.query(`INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason) VALUES ('note', $1, 'remove', 1, 'fixture removal')`, [removedNote])
      const line = await say(app, NEIGHBOUR.secret, rooms.eastRoomId, 'see example.com 😀')
      // kind_revisions is append-only, so the coded description is written with the revision.
      const kind = await insertId('INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id', ['coded-kind', NEIGHBOUR.id])
      await db.query(`
        INSERT INTO kind_revisions (kind_id, revision, traits, drawing_state, description) VALUES ($1, 1, '{}'::text[], 'undrawn', $2)
      `, [kind, binary('a kind of lantern')])
      await db.query('UPDATE kinds SET current_revision = 1 WHERE id = $1', [kind])
      const agreement = await insertId(`INSERT INTO agreements (created_by_id, body) VALUES ($1, $2) RETURNING id`, [NEIGHBOUR.id, 'terms at https://pact.example.org/terms'])
      await db.query('INSERT INTO agreement_parties (agreement_id, resident_id) VALUES ($1, $2)', [agreement, NEIGHBOUR.id])
      const portrait = {
        palette: ['#ad3f25', '#f0c95f'],
        indices: Array.from({ length: 64 }, (_value, index) => index % 3 === 0 ? null : index % 2),
      }
      const drew = await call(app, NEIGHBOUR.secret, 'PATCH', '/api/me/drawing', {
        drawing: portrait, drawing_state: 'complete', drawing_description: 'a lantern',
      })
      assert.equal(drew.status, 200, JSON.stringify(drew.json))

      const paths = [
        `/api/place/${rooms.eastRoomId}`,
        `/api/place/${rooms.eastRoomId}?view=full&note_limit=50`,
        `/api/place/${rooms.eastRoomId}?view=full&note_text_limit_bytes=200&thing_text_limit_bytes=10`,
        `/api/place/${rooms.continentId}?view=full`,
        `/api/map?view=outline&parent_id=${rooms.continentId}`,
        `/api/map?view=continent&continent_id=${rooms.continentId}`,
        '/api/map',
        `/api/thing/${jsonThing}`,
        `/api/note/${notes.binary}`,
        `/api/note/${notes.binary}?body_start_byte=1&body_limit_bytes=100`,
        `/api/note/${removedNote}`,
        `/api/line/${line}`,
        `/api/place/${rooms.eastRoomId}/lines`,
        '/api/search?q=lantern',
        '/api/kinds',
        '/api/agreements',
        `/api/drawing/resident/${NEIGHBOUR.id}`,
        `/api/drawing/resident/${NEIGHBOUR.id}/history`,
      ]
      const anonymousBefore = new Map<string, Read>()
      for (const path of paths) anonymousBefore.set(path, await read(app, path))

      // A reader with every filter on show and no muted words reads exactly what anyone reads.
      await change(app, FAR_SHORE.secret, { filters: EVERY_SHOW })
      for (const path of paths) {
        const keyed = await read(app, path, FAR_SHORE.secret)
        assert.equal(keyed.text, anonymousBefore.get(path)!.text, `keyed with every filter on show ${path}`)
      }

      await change(app, GROWER.secret, { filters: EVERY_DESCRIBE })
      await change(app, GROWER.secret, { muted_words: { add: ['lantern'] } })

      // 1. A place read, view=full: every body is described, or hidden by a muted word.
      const place = await read(app, `/api/place/${rooms.eastRoomId}?view=full&note_limit=50`, GROWER.secret)
      assert.equal(place.status, 200, place.text)
      assert.equal(place.headers['cache-control'], 'private, no-store')
      const placeNotes = byId(place.json.notes)
      assert.equal(placeNotes.get(notes.binary)!.body, '[translated from binary: meet me at the old mill]')
      assert.equal(placeNotes.get(notes.morse)!.body, '[translated from Morse: HELLO WORLD]')
      assert.equal(placeNotes.get(notes.base64)!.body, '[translated from base64: a quiet square]')
      assert.equal(placeNotes.get(notes.unreadable)!.body, MARKERS.untranslatable)
      assert.equal(placeNotes.get(notes.link)!.body, 'read [link to google.com] now')
      assert.equal(placeNotes.get(notes.emoji)!.body, 'hello [emoji: grinning face, speech balloon, door]')
      assert.equal(placeNotes.get(notes.muted)!.body, MARKERS.muted)
      assert.equal(placeNotes.get(notes.insideTranslation)!.body, MARKERS.muted, 'a muted word in the translation hides it')
      assert.equal(placeNotes.get(notes.plain)!.body, 'plain words only')
      assert.equal(placeNotes.get(notes.founder)!.body, binary('founder words lantern'), 'the founder\'s note is never filtered')
      assert.equal(placeNotes.get(notes.own)!.body, binary('my own lantern'), 'your own note is never filtered')
      // A hidden body keeps its id, author, place, date and its size.
      const hiddenNote = placeNotes.get(notes.muted)!
      assert.equal(hiddenNote.author, NEIGHBOUR.handle)
      assert.equal(hiddenNote.body_text_bytes, Buffer.byteLength('the Lantern glows'))
      assert.ok(typeof hiddenNote.created_at === 'string')
      assert.equal(byId(place.json.things).get(jsonThing)!.body, '[looks like code: JSON, about 40 lines]')
      assert.deepEqual(place.json.covered_by_your_filters, { described: 6, hidden: 3 })
      for (const original of ['the Lantern glows', 'https://www.google.com/maps', '😀', binary('meet me at the old mill'), MORSE_HELLO, '"k37"']) {
        assert.equal(place.text.includes(original), false, `the raw answer never carries ${original}`)
      }
      // The place's own words and a subplace's, on the continent read and the map.
      const continent = await read(app, `/api/place/${rooms.continentId}?view=full`, GROWER.secret)
      const hallRow = byId(continent.json.subplaces).get(hall)!
      assert.equal(hallRow.description, 'see [link to google.com] for the way')
      assert.equal(hallRow.purpose, 'a hall [emoji: grinning face] for all')
      for (const path of [`/api/map?view=outline&parent_id=${rooms.continentId}`, `/api/map?view=continent&continent_id=${rooms.continentId}`, '/api/map']) {
        const map = await read(app, path, GROWER.secret)
        assert.equal(map.status, 200, map.text)
        assert.equal(map.text.includes('😀'), false, path)
        // A continent page carries only ids and names, so it has nothing to describe.
        if (!path.includes('view=continent')) assert.ok(map.text.includes('a hall [emoji: grinning face] for all'), path)
        assert.ok(map.json.covered_by_your_filters !== undefined, path)
      }
      // A text-limit read filters the same bodies.
      const limited = await read(app, `/api/place/${rooms.eastRoomId}?view=full&note_text_limit_bytes=200&thing_text_limit_bytes=10`, GROWER.secret)
      assert.equal(limited.text.includes('the Lantern glows'), false)

      // 2. One note, in pieces after the whole body is described; a hidden one is whole.
      const one = await read(app, `/api/note/${notes.binary}`, GROWER.secret)
      assert.equal((one.json.note as Json).body, '[translated from binary: meet me at the old mill]')
      assert.deepEqual(one.json.covered_by_your_filters, { described: 1, hidden: 0 })
      const piece = await read(app, `/api/note/${notes.binary}?body_start_byte=1&body_limit_bytes=100`, GROWER.secret)
      assert.equal((piece.json.note as Json).body, 'translated from binary: meet me at the old mill]')
      assert.equal((piece.json.note as Json).body_piece_start_byte, 1)
      const hiddenPiece = await read(app, `/api/note/${notes.muted}?body_start_byte=4&body_limit_bytes=100`, GROWER.secret)
      assert.equal((hiddenPiece.json.note as Json).body, MARKERS.muted)
      assert.equal((hiddenPiece.json.note as Json).body_text_bytes, Buffer.byteLength('the Lantern glows'))
      // read_here, standing in the room.
      const here = await read(app, `/api/note/${notes.emoji}/here`, GROWER.secret)
      assert.equal(here.status, 200, here.text)
      assert.equal((here.json.note as Json).body, 'hello [emoji: grinning face, speech balloon, door]')
      // Through look on the key door, the same answer.
      const looked = await mcpCall(app, GROWER.secret, 'look', { note_id: notes.morse })
      assert.equal(looked.isError, false, looked.text)
      assert.equal(((JSON.parse(looked.text) as Json).note as Json).body, '[translated from Morse: HELLO WORLD]')

      // 3. Lines, one and many, and a wait that returns with a line.
      assert.equal(((await read(app, `/api/line/${line}`, GROWER.secret)).json.line as Json).body, 'see [link to example.com] [emoji: grinning face]')
      const lines = await read(app, `/api/place/${rooms.eastRoomId}/lines`, GROWER.secret)
      assert.equal((lines.json.lines as Json[])[0]!.body, 'see [link to example.com] [emoji: grinning face]')
      const marker = String((await read(app, '/api/changes')).json.change_marker)
      await say(app, NEIGHBOUR.secret, rooms.eastRoomId, 'the lantern is lit')
      const waited = await call(app, GROWER.secret, 'POST', '/api/wait-here', { after_line_change: marker, after_ping_change: marker, seconds: 3 })
      assert.equal(waited.json.reason, 'change', JSON.stringify(waited.json))
      assert.deepEqual((waited.json.lines as Json[]).map(row => row.body), [MARKERS.muted])
      assert.deepEqual(waited.json.covered_by_your_filters, { described: 0, hidden: 1 })

      // 4. One thing, kinds and agreements.
      assert.equal(((await read(app, `/api/thing/${jsonThing}`, GROWER.secret)).json.thing as Json).body, '[looks like code: JSON, about 40 lines]')
      const kinds = await read(app, '/api/kinds', GROWER.secret)
      assert.equal(byId(kinds.json.kinds).get(kind)!.description, MARKERS.muted, 'the translated kind description holds a muted word')
      const agreements = await read(app, '/api/agreements', GROWER.secret)
      assert.equal(byId(agreements.json.agreements).get(agreement)!.body, 'terms at [link to pact.example.org]')

      // 5. Drawings: the size and colours, never the cells; the description through the text filters.
      const drawing = await read(app, `/api/drawing/resident/${NEIGHBOUR.id}`, GROWER.secret)
      assert.deepEqual(drawing.json.outline, { width: 8, height: 8, colours_used: ['#ad3f25', '#f0c95f'] })
      assert.equal(Object.hasOwn(drawing.json, 'drawing'), false)
      assert.equal(drawing.json.description, MARKERS.muted)
      const history = await read(app, `/api/drawing/resident/${NEIGHBOUR.id}/history`, GROWER.secret)
      assert.equal(history.text.includes('"indices"'), false)
      const ownPortrait = await call(app, GROWER.secret, 'PATCH', '/api/me/drawing', {
        drawing: portrait, drawing_state: 'complete', drawing_description: 'my lantern',
      })
      assert.equal(ownPortrait.status, 200)
      const ownDrawing = await read(app, `/api/drawing/resident/${GROWER.id}`, GROWER.secret)
      assert.ok(ownDrawing.json.drawing !== undefined && ownDrawing.json.drawing !== null, 'your own drawing is never filtered')

      // 6. Hide: each kind sends its marker instead of the body.
      await change(app, GROWER.secret, { filters: EVERY_HIDE })
      const hidden = byId((await read(app, `/api/place/${rooms.eastRoomId}?view=full&note_limit=50`, GROWER.secret)).json.notes)
      assert.equal(hidden.get(notes.binary)!.body, MARKERS.encoded)
      assert.equal(hidden.get(notes.link)!.body, MARKERS.link)
      assert.equal(hidden.get(notes.emoji)!.body, MARKERS.emoji)
      assert.equal(hidden.get(notes.plain)!.body, 'plain words only')
      assert.equal(hidden.get(notes.founder)!.body, binary('founder words lantern'))
      const hiddenThing = (await read(app, `/api/thing/${jsonThing}`, GROWER.secret)).json.thing as Json
      assert.equal(hiddenThing.body, MARKERS.code)
      assert.equal(hiddenThing.body_text_bytes, Buffer.byteLength(JSON_BODY))
      const hiddenDrawing = await read(app, `/api/drawing/resident/${NEIGHBOUR.id}`, GROWER.secret)
      assert.equal(hiddenDrawing.json.filter_marker, MARKERS.drawing)
      assert.equal(Object.hasOwn(hiddenDrawing.json, 'outline'), false)

      // 7. show_anyway: an allowed note skips the filters; a plain allow does not.
      await change(app, GROWER.secret, { allow: { type: 'note', id: notes.binary } })
      assert.equal(byId((await read(app, `/api/place/${rooms.eastRoomId}?view=full&note_limit=50`, GROWER.secret)).json.notes).get(notes.binary)!.body, MARKERS.encoded)
      await change(app, GROWER.secret, { allow: { type: 'note', id: notes.binary, show_anyway: true } })
      const anyway = byId((await read(app, `/api/place/${rooms.eastRoomId}?view=full&note_limit=50`, GROWER.secret)).json.notes)
      assert.equal(anyway.get(notes.binary)!.body, binary('meet me at the old mill'))
      assert.equal(anyway.get(notes.morse)!.body, MARKERS.encoded, 'only that one note')

      // 8. Focus mode composes: outlines carry no body; show_everything sends bodies, then filters apply.
      await change(app, GROWER.secret, { focus_mode: true })
      const focused = await read(app, `/api/place/${rooms.eastRoomId}?view=full&note_limit=50`, GROWER.secret)
      assert.equal(byId(focused.json.notes).get(notes.morse)!.body, undefined)
      const everything = await read(app, `/api/place/${rooms.eastRoomId}?view=full&note_limit=50&show_everything=true`, GROWER.secret)
      assert.equal(byId(everything.json.notes).get(notes.morse)!.body, MARKERS.encoded)

      // Anonymous reads never change, whatever any reader chose: the world moved during this
      // test (a look, a wait, a line), so compare anonymous reads around one more change.
      const settled = new Map<string, Read>()
      for (const path of paths) settled.set(path, await read(app, path))
      await change(app, GROWER.secret, { filters: EVERY_DESCRIBE })
      await change(app, GROWER.secret, { muted_words: { add: ['square'] } })
      for (const path of paths) {
        const after = await read(app, path)
        assert.equal(after.text, settled.get(path)!.text, `anonymous ${path}`)
        assert.deepEqual(after.headers, settled.get(path)!.headers, `anonymous headers ${path}`)
      }
    })
  } finally {
    await postgres.stop()
  }
})
