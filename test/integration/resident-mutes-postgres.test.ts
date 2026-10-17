// Mutes and allows (decision #156) against real PostgreSQL: the real schema, the real
// routes, the real migration. Every signed-in resident read drops what its reader muted
// and counts it; anonymous reads, and a signed-in read with no mutes, are unchanged.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Hono } from 'hono'
import {
  call,
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  seedKind,
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

// GROWER is the reader; NEIGHBOUR is the resident it mutes; FAR_SHORE is anyone else.
const FAR_SHORE = Object.freeze({ id: 5, handle: 'far-shore', secret: `1f3d9_sk_${'5'.repeat(48)}` })
const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR, FAR_SHORE] as const

const migration = await readFile(
  new URL('../../db/migrations/20261017_resident_mutes.sql', import.meta.url),
  'utf8',
)

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

async function mcpCall(app: CityApp, secret: string, name: string, args: Json): Promise<Json> {
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

async function settings(app: CityApp, secret: string, change: Json): Promise<Read> {
  const response = await app.request('http://city.test/api/me/settings', {
    method: 'PATCH',
    headers: bearer(secret),
    body: JSON.stringify(change),
  })
  const text = await response.text()
  return Object.freeze({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text,
    json: JSON.parse(text) as Json,
  })
}

async function mute(app: CityApp, secret: string, verb: string, type: string, id: number): Promise<Json> {
  const changed = await settings(app, secret, { [verb]: { type, id } })
  assert.equal(changed.status, 200, changed.text)
  return changed.json
}

async function insertId(text: string, values: readonly unknown[]): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(text, [...values])).rows[0]!.id)
}

async function seedPlace(parentId: number, name: string, ownerId: number): Promise<number> {
  return insertId(`
    INSERT INTO places (parent_id, place_kind, name, description, purpose, owner_id, open_to_notes, open_to_things)
    VALUES ($1, 'place', $2, $3, $4, $5, TRUE, TRUE) RETURNING id
  `, [parentId, name, `the ${name} description`, `the ${name} purpose`, ownerId])
}

async function seedNote(placeId: number, authorId: number, body: string): Promise<number> {
  return insertId('INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, $3) RETURNING id', [placeId, authorId, body])
}

async function seedThing(placeId: number, makerId: number, name: string, body: string, kindId: number | null = null): Promise<number> {
  return insertId(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision)
    VALUES ($1, $2, $3, $4, $4, $5, $6, $6) RETURNING id
  `, [placeId, name, body, makerId, kindId, kindId === null ? null : 1])
}

async function seedPing(placeId: number, senderId: number, targetId: number): Promise<number> {
  const db = connectedDatabase()
  const pingId = await insertId(`
    WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now)
    INSERT INTO pings (place_id, sender_id, target_id, sent_at, expires_at, sender_arrived_at, target_arrived_at)
    SELECT $1, $2, $3, stamp.now - interval '30 seconds', stamp.now + interval '9 minutes 30 seconds',
      sender_presence.arrived_at, target_presence.arrived_at
    FROM stamp
    JOIN resident_presence sender_presence ON sender_presence.resident_id = $2
    JOIN resident_presence target_presence ON target_presence.resident_id = $3
    RETURNING id
  `, [placeId, senderId, targetId])
  await db.query('INSERT INTO ping_receipts (ping_id, recipient_id) VALUES ($1, $2)', [pingId, targetId])
  return pingId
}

async function say(app: CityApp, secret: string, placeId: number, body: string): Promise<number> {
  const said = await call(app, secret, 'POST', '/api/line', { place_id: placeId, body, request_id: randomUUID() })
  assert.equal(said.status, 201, JSON.stringify(said.json))
  return Number((said.json.line as Json).id)
}

async function note(app: CityApp, secret: string, placeId: number, body: string): Promise<number> {
  const written = await call(app, secret, 'POST', '/api/note', { place_id: placeId, body })
  assert.equal(written.status, 201, JSON.stringify(written.json))
  return Number((written.json.note as Json).id)
}

function ids(rows: unknown): number[] {
  return (rows as Json[]).map(row => Number(row.id))
}

function hiddenIds(answer: Json): string[] {
  return ((answer.hidden_items ?? []) as Json[]).map(row => `${row.type}:${row.id}`).sort()
}

// An outline names id, type, author, kind, size, date and place, and never a body or a name.
function assertOutline(outline: Json, type: string, id: number): void {
  assert.deepEqual(Object.keys(outline).sort(), ['author', 'date', 'id', 'kind', 'place_id', 'size', 'type'])
  assert.equal(outline.type, type)
  assert.equal(outline.id, id)
}

test('mutes and allows against real PostgreSQL', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('resident-mutes')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const {
      ALLOW_TYPE_REFUSAL,
      MUTE_FOUNDER_REFUSAL,
      MUTE_SELF_REFUSAL,
      MUTE_TARGET_REFUSAL,
      muteTargetNotFound,
    } = await import('../../src/resident-mutes.ts')
    const { HIDDEN_REFUSAL } = await import('../../src/reader-filter.ts')
    const db = connectedDatabase()

    await t.test('the migration applies twice, changes no resident, and its checks hold', async () => {
      await resetCity(RESIDENTS)
      const catalog = async () => (await db.query(
        'SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint ' +
          "WHERE conrelid = 'resident_mutes'::regclass ORDER BY conname",
      )).rows
      const fresh = await catalog()
      assert.equal(fresh.length, 9)
      assert.ok(fresh.every(row => row.convalidated === true))
      await db.query('DROP TABLE resident_mutes')
      const residentsBefore = (await db.query('SELECT * FROM residents ORDER BY id')).rows
      await db.query(migration)
      await db.query(migration)
      assert.deepEqual(await catalog(), fresh)
      assert.deepEqual((await db.query('SELECT * FROM residents ORDER BY id')).rows, residentsBefore)
      assert.equal(Number((await db.query('SELECT count(*) FROM resident_mutes')).rows[0]!.count), 0)
      const refused = async (sql: string) => {
        await assert.rejects(db.query(sql), /violates/u, sql)
      }
      await refused(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES (2, 'resident', 1, 'mute')`)
      await refused(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES (2, 'resident', 2, 'mute')`)
      await refused(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES (2, 'resident', 3, 'allow')`)
      await refused(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES (2, 'kind', 3, 'allow')`)
      await refused(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES (2, 'trait', 3, 'mute')`)
      await refused(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES (2, 'note', 0, 'mute')`)
      await refused(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES (2, 'note', 4, 'hide')`)
      await db.query(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES (2, 'resident', 3, 'mute')`)
      await refused(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES (2, 'resident', 3, 'mute')`)
    })

    await t.test('settings mute, allow, unmute and unallow, refused in caller words', async () => {
      const rooms = await resetCity(RESIDENTS)
      const founderNote = await seedNote(rooms.eastRoomId, FOUNDER.id, 'founder words')
      const ownNote = await seedNote(rooms.eastRoomId, GROWER.id, 'my own words')
      const refusals: Array<[Json, number, string]> = [
        [{ mute: { type: 'resident', id: FOUNDER.id } }, 400, MUTE_FOUNDER_REFUSAL],
        [{ mute: { type: 'note', id: founderNote } }, 400, MUTE_FOUNDER_REFUSAL],
        [{ mute: { type: 'resident', id: GROWER.id } }, 400, MUTE_SELF_REFUSAL],
        [{ mute: { type: 'note', id: ownNote } }, 400, MUTE_SELF_REFUSAL],
        [{ mute: { type: 'thing', id: 999 } }, 404, muteTargetNotFound('thing', 999)],
        [{ mute: { type: 'resident', id: 999 } }, 404, muteTargetNotFound('resident', 999)],
        [{ allow: { type: 'resident', id: NEIGHBOUR.id } }, 400, ALLOW_TYPE_REFUSAL],
        [{ allow: { type: 'kind', id: 1 } }, 400, ALLOW_TYPE_REFUSAL],
        [{ mute: { type: 'trait', id: 1 } }, 400, MUTE_TARGET_REFUSAL],
        [{ mute: { type: 'resident' } }, 400, MUTE_TARGET_REFUSAL],
      ]
      for (const [change, status, error] of refusals) {
        const refused = await settings(app, GROWER.secret, change)
        assert.equal(refused.status, status, JSON.stringify(change))
        // A repeated refusal may carry the city's repeated-refusal notice after it.
        assert.ok(String(refused.json.error).startsWith(error), `${JSON.stringify(change)}: ${refused.json.error}`)
      }
      assert.equal(Number((await db.query('SELECT count(*) FROM resident_mutes')).rows[0]!.count), 0)

      const muted = await mute(app, GROWER.secret, 'mute', 'resident', NEIGHBOUR.id)
      assert.equal(muted.changed, true)
      const listed = (muted.settings as Json).mutes as Json[]
      assert.deepEqual(listed.map(row => [row.type, row.id, row.choice]), [['resident', NEIGHBOUR.id, 'mute']])
      assert.equal((await mute(app, GROWER.secret, 'mute', 'resident', NEIGHBOUR.id)).changed, false)
      const shown = await read(app, '/api/me/settings', GROWER.secret)
      assert.deepEqual(((shown.json.settings as Json).mutes as Json[]).map(row => row.id), [NEIGHBOUR.id])
      assert.equal(shown.headers['cache-control'], 'no-store')
      // A mute and an allow on one target: the newest choice is the one kept.
      assert.equal((await mute(app, GROWER.secret, 'mute', 'place', rooms.westRoomId)).changed, true)
      assert.equal((await mute(app, GROWER.secret, 'allow', 'place', rooms.westRoomId)).changed, true)
      assert.deepEqual((await db.query(
        `SELECT choice FROM resident_mutes WHERE resident_id = $1 AND target_type = 'place'`, [GROWER.id],
      )).rows, [{ choice: 'allow' }])
      assert.equal((await mute(app, GROWER.secret, 'unmute', 'place', rooms.westRoomId)).changed, false)
      assert.equal((await mute(app, GROWER.secret, 'unallow', 'place', rooms.westRoomId)).changed, true)
      assert.equal((await mute(app, GROWER.secret, 'unmute', 'resident', NEIGHBOUR.id)).changed, true)
      assert.equal(Number((await db.query('SELECT count(*) FROM resident_mutes')).rows[0]!.count), 0)
      // Nobody is told: no event, no change notice.
      assert.equal(Number((await db.query(`SELECT count(*) FROM events WHERE detail::text LIKE '%mute%'`)).rows[0]!.count), 0)
      // The same verbs through me on the key door.
      const viaMe = await mcpCall(app, GROWER.secret, 'me', { settings: { mute: { type: 'resident', id: NEIGHBOUR.id } } })
      assert.equal(viaMe.changed, true)
      const hiddenRefused = await read(app, `/api/place/${rooms.eastRoomId}?hidden=all`, GROWER.secret)
      assert.equal(hiddenRefused.status, 400)
      assert.equal(hiddenRefused.json.error, HIDDEN_REFUSAL)
    })

    await t.test('every resident read path drops a muted author\'s items and counts them; anonymous reads are unchanged', async () => {
      const rooms = await resetCity(RESIDENTS)
      const hall = await seedPlace(rooms.continentId, 'Neighbour Hall', NEIGHBOUR.id)
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      await standIn(FAR_SHORE.id, rooms.eastRoomId)
      await db.query('UPDATE places SET open_to_things = TRUE WHERE id = $1', [rooms.eastRoomId])
      // The reader's first me sets its visit baseline, so the next one summarizes.
      assert.equal((await call(app, GROWER.secret, 'GET', '/api/me')).status, 200)

      const mutedNote = await note(app, NEIGHBOUR.secret, rooms.eastRoomId, 'lanterns, muted words from next-door for seed-keeper')
      const keptNote = await note(app, FAR_SHORE.secret, rooms.eastRoomId, 'lanterns, plain words from far-shore')
      const mutedThing = await seedThing(rooms.eastRoomId, NEIGHBOUR.id, 'muted lantern', 'a lantern by next-door')
      const keptThing = await seedThing(rooms.eastRoomId, FAR_SHORE.id, 'kept lantern', 'a lantern by far-shore')
      const mutedLine = await say(app, NEIGHBOUR.secret, rooms.eastRoomId, 'a muted line')
      const keptLine = await say(app, FAR_SHORE.secret, rooms.eastRoomId, 'a kept line')
      const mutedPing = await seedPing(rooms.eastRoomId, NEIGHBOUR.id, GROWER.id)
      const mutedKind = await seedKind(NEIGHBOUR.id, 'muted-kind', [])
      const keptKind = await seedKind(FAR_SHORE.id, 'kept-kind', [])
      const mutedTrait = await insertId(`INSERT INTO traits (name, description, coiner_id) VALUES ('muted-trait', 'by next-door', $1) RETURNING id`, [NEIGHBOUR.id])
      const keptTrait = await insertId(`INSERT INTO traits (name, description, coiner_id) VALUES ('kept-trait', 'by far-shore', $1) RETURNING id`, [FAR_SHORE.id])
      const mutedAgreement = await insertId(`INSERT INTO agreements (created_by_id, body) VALUES ($1, 'a pact by next-door') RETURNING id`, [NEIGHBOUR.id])
      await db.query('INSERT INTO agreement_parties (agreement_id, resident_id) VALUES ($1, $2)', [mutedAgreement, NEIGHBOUR.id])
      const partyAgreement = await insertId(`INSERT INTO agreements (created_by_id, body) VALUES ($1, 'a pact with seed-keeper') RETURNING id`, [NEIGHBOUR.id])
      await db.query('INSERT INTO agreement_parties (agreement_id, resident_id) VALUES ($1, $2), ($1, $3)', [partyAgreement, NEIGHBOUR.id, GROWER.id])
      const removedNote = await seedNote(rooms.eastRoomId, FAR_SHORE.id, 'a removed note')
      await db.query(`INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason) VALUES ('note', $1, 'remove', 1, 'fixture removal')`, [removedNote])
      // A Gazette issue that printed the muted note and the kept one.
      // The Gazette prints notes left in room #454 before its print.
      // It begins as the city's closed shell and opens, as in the public snapshot suite.
      await db.query(`
        INSERT INTO places (id, parent_id, place_kind, name, description, purpose, owner_id, open_to_building, open_to_things, open_to_notes)
        VALUES (454, $1, 'place', 'the gazette submission room',
          'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
          '', 1, FALSE, FALSE, FALSE)
      `, [rooms.continentId])
      await db.query(`INSERT INTO events (kind, actor, detail, at) VALUES ('place_edited', 'the city', '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb, '2026-08-30T00:00:00Z')`)
      await db.query(`
        UPDATE places
        SET description = 'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted note made before the cutoff to the next issue, verbatim with its author, note ID, and time. Printing never deletes, edits, moves, or copies the source note.',
          purpose = 'Residents may submit up to three notes per Gazette week (Monday 16:00 UTC to Monday 16:00 UTC); each submission also uses the ordinary daily note quota.',
          open_to_notes = TRUE
        WHERE id = 454
      `)
      await db.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
      const mutedEntry = await insertId(`INSERT INTO notes (place_id, author_id, body, created_at) VALUES (454, $1, 'a muted submission', '2026-08-31T15:59:58Z') RETURNING id`, [NEIGHBOUR.id])
      const keptEntry = await insertId(`INSERT INTO notes (place_id, author_id, body, created_at) VALUES (454, $1, 'a kept submission', '2026-08-31T15:59:59Z') RETURNING id`, [FAR_SHORE.id])
      await db.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
      const printer = await db.connect()
      try {
        await printer.query('BEGIN')
        const printed = Number((await printer.query<{ id: number }>(`INSERT INTO events (kind, actor, detail) VALUES ('gazette_printed', 'the Gazette printer', '{"issue_number":1,"place_id":454,"entry_count":2}'::jsonb) RETURNING id`)).rows[0]!.id)
        await printer.query(`INSERT INTO gazette_issues (issue_number, scheduled_for, printed_at, header, entry_count, event_id) VALUES (1, '2026-08-31T16:00:00Z', '2026-08-31T16:00:01Z', 'THE GAZETTE, ISSUE 1', 2, $1)`, [printed])
        await printer.query('INSERT INTO gazette_issue_entries (issue_number, ordinal, note_id) VALUES (1, 1, $1), (1, 2, $2)', [mutedEntry, keptEntry])
        await printer.query('COMMIT')
      } catch (error) {
        await printer.query('ROLLBACK')
        throw error
      } finally {
        printer.release()
      }

      const portraitDrawing = {
        palette: ['#ad3f25', '#f0c95f'],
        indices: Array.from({ length: 64 }, (_, index) => index % 3 === 0 ? null : index % 2),
      }
      const drew = await call(app, NEIGHBOUR.secret, 'PATCH', '/api/me/drawing', {
        drawing: portraitDrawing, drawing_state: 'complete', drawing_description: 'a lantern',
      })
      assert.equal(drew.status, 200, JSON.stringify(drew.json))

      const paths = [
        `/api/place/${rooms.eastRoomId}`,
        `/api/place/${rooms.eastRoomId}?view=full`,
        `/api/place/${rooms.eastRoomId}?view=full&note_text_limit_bytes=20&thing_text_limit_bytes=10`,
        `/api/place/${rooms.continentId}?view=full`,
        `/api/map?view=outline&parent_id=${rooms.continentId}`,
        `/api/map?view=continent&continent_id=${rooms.continentId}`,
        '/api/map',
        `/api/thing/${mutedThing}`,
        `/api/note/${mutedNote}`,
        `/api/note/${removedNote}`,
        `/api/line/${mutedLine}`,
        `/api/ping/${mutedPing}`,
        `/api/place/${rooms.eastRoomId}/lines`,
        '/api/search?q=lanterns',
        '/api/search?q=lantern&type=thing',
        '/api/changes?since=0&limit=200',
        `/api/events?place_id=${rooms.eastRoomId}&limit=200`,
        '/api/kinds',
        '/api/traits',
        '/api/agreements',
        '/api/residents',
        `/api/residents?view=presence&handle=${NEIGHBOUR.handle}`,
        '/api/gazette/1',
        `/api/drawing/resident/${NEIGHBOUR.id}`,
        `/api/drawing/place/${hall}`,
        `/api/drawing/place/${hall}/history`,
      ]
      const anonymousBefore = new Map<string, Read>()
      for (const path of paths) anonymousBefore.set(path, await read(app, path))
      // A signed-in reader with no mutes reads exactly what anyone reads.
      for (const path of paths) {
        const keyed = await read(app, path, FAR_SHORE.secret)
        assert.equal(keyed.text, anonymousBefore.get(path)!.text, `keyed without mutes ${path}`)
      }

      await mute(app, GROWER.secret, 'mute', 'resident', NEIGHBOUR.id)

      // Anonymous reads are byte for byte the same once someone has mutes.
      for (const path of paths) {
        const after = await read(app, path)
        assert.equal(after.text, anonymousBefore.get(path)!.text, `anonymous ${path}`)
        assert.equal(after.status, anonymousBefore.get(path)!.status, `anonymous ${path}`)
      }
      const anonymousMap = await read(app, '/api/map?view=outline')
      assert.match(anonymousMap.headers['cache-control']!, /^public, max-age=15/u)
      assert.equal(anonymousMap.headers.vary, 'Authorization')

      // 1. Place read and look: muted notes, things and line headings dropped and counted.
      const place = await read(app, `/api/place/${rooms.eastRoomId}?view=full&hidden=outline`, GROWER.secret)
      assert.equal(place.status, 200, place.text)
      assert.equal(place.headers['cache-control'], 'private, no-store')
      assert.equal(place.headers.vary, 'Authorization')
      assert.equal(ids(place.json.notes).includes(mutedNote), false)
      assert.equal(ids(place.json.notes).includes(keptNote), true)
      assert.deepEqual(ids(place.json.things), [keptThing])
      assert.deepEqual(ids(place.json.line_headings), [keptLine])
      assert.equal(place.json.hidden_by_your_mutes, 3)
      assert.deepEqual(hiddenIds(place.json), [`line:${mutedLine}`, `note:${mutedNote}`, `thing:${mutedThing}`].sort())
      for (const outline of place.json.hidden_items as Json[]) assertOutline(outline, String(outline.type), Number(outline.id))
      assert.doesNotMatch(place.text, /muted words|a lantern by next-door|a muted line|muted lantern/u)
      assert.equal((place.json.notes_page as Json).total_items, (anonymousBefore.get(`/api/place/${rooms.eastRoomId}?view=full`)!.json.notes_page as Json).total_items)
      assert.equal((place.json.things_page as Json).returned_items, 1)
      // The page's returned text bytes stop counting exactly what the mutes dropped.
      const anonymousFull = anonymousBefore.get(`/api/place/${rooms.eastRoomId}?view=full`)!.json
      assert.equal(
        (place.json.notes_page as Json).returned_text_bytes,
        Number((anonymousFull.notes_page as Json).returned_text_bytes) - Buffer.byteLength('lanterns, muted words from next-door for seed-keeper'),
      )
      assert.equal(
        (place.json.things_page as Json).returned_text_bytes,
        Number((anonymousFull.things_page as Json).returned_text_bytes) - Buffer.byteLength('a lantern by next-door'),
      )
      assert.match(String(place.json.hidden_next_step), /hidden=outline/u)
      const placeWithoutOutline = await read(app, `/api/place/${rooms.eastRoomId}`, GROWER.secret)
      assert.equal(placeWithoutOutline.json.hidden_by_your_mutes, 3)
      assert.equal(Object.hasOwn(placeWithoutOutline.json, 'hidden_items'), false)
      const looked = await mcpCall(app, GROWER.secret, 'look', { place_id: rooms.eastRoomId, hidden: 'outline' })
      assert.equal(looked.hidden_by_your_mutes, 3)
      assert.equal(Object.hasOwn(looked, 'pending_pings'), false, 'a look still carries no ping summary')

      // A place owned by a muted resident stays listed, marked, without its words.
      const continent = await read(app, `/api/place/${rooms.continentId}?view=full`, GROWER.secret)
      const hallRow = (continent.json.subplaces as Json[]).find(row => row.id === hall)!
      assert.equal(hallRow.muted, true)
      assert.equal(Object.hasOwn(hallRow, 'description'), false)
      assert.equal(Object.hasOwn(hallRow, 'purpose'), false)
      assert.equal(hallRow.name, 'Neighbour Hall')
      const eastRow = (continent.json.subplaces as Json[]).find(row => row.id === rooms.eastRoomId)!
      assert.equal(eastRow.description, 'the east room')
      const hallRead = await read(app, `/api/place/${hall}`, GROWER.secret)
      assert.equal((hallRead.json.place as Json).muted, true)
      assert.equal(Object.hasOwn(hallRead.json.place as Json, 'description'), false)
      assert.deepEqual(hallRead.json.front_matter, [])
      assert.ok(Array.isArray((hallRead.json.place as Json).laws), 'the laws of a place always show')

      // 2. Map: keyed answers are shaped and never shared; the root keeps its arrival line.
      const map = await read(app, `/api/map?view=outline&parent_id=${rooms.continentId}`, GROWER.secret)
      assert.equal(map.headers['cache-control'], 'private, no-store')
      assert.equal(map.headers.vary, 'Authorization')
      assert.equal((map.json.subplaces as Json[]).find(row => row.id === hall)!.muted, true)
      const fullMap = await read(app, '/api/map', GROWER.secret)
      assert.match(fullMap.text, /"muted":true/u)
      assert.doesNotMatch(fullMap.text, /the Neighbour Hall description/u)
      const continentMap = await read(app, `/api/map?view=continent&continent_id=${rooms.continentId}`, GROWER.secret)
      assert.equal((continentMap.json.places as Json[]).find(row => row.id === hall)!.muted, true)
      const rootLook = await mcpCall(app, GROWER.secret, 'look', {})
      assert.ok(rootLook.place, 'the root outline still reads')

      // 3 and 4. One thing and one note by id: only the outline and the allow call.
      const thing = await read(app, `/api/thing/${mutedThing}`, GROWER.secret)
      assertOutline(thing.json.thing as Json, 'thing', mutedThing)
      assert.equal(thing.json.hidden_by_your_mutes, 1)
      assert.match(String(thing.json.next_step), /"allow": \{"type": "thing", "id": \d+\}/u)
      const oneNote = await read(app, `/api/note/${mutedNote}`, GROWER.secret)
      assertOutline(oneNote.json.note as Json, 'note', mutedNote)
      assert.equal((oneNote.json.note as Json).author, NEIGHBOUR.handle)
      assert.doesNotMatch(oneNote.text, /muted words/u)
      assert.match(String((await read(app, `/api/note/${keptNote}`, GROWER.secret)).json.note && 'ok'), /ok/u)

      // 5. read_here: standing there does not open a muted note.
      const here = await read(app, `/api/note/${mutedNote}/here`, GROWER.secret)
      assert.equal(here.status, 200, here.text)
      assertOutline(here.json.note as Json, 'note', mutedNote)

      // 6. Lines: one line by id and the place's lines.
      const line = await read(app, `/api/line/${mutedLine}`, GROWER.secret)
      assertOutline(line.json.line as Json, 'line', mutedLine)
      assert.match(String(line.json.next_step), /unmute/u)
      const lines = await read(app, `/api/place/${rooms.eastRoomId}/lines?hidden=outline`, GROWER.secret)
      assert.deepEqual(ids(lines.json.lines), [keptLine])
      assert.equal(lines.json.hidden_by_your_mutes, 1)
      assert.deepEqual(hiddenIds(lines.json), [`line:${mutedLine}`])

      // 7. One ping by id from a muted resident: its outline only.
      const ping = await read(app, `/api/ping/${mutedPing}`, GROWER.secret)
      assertOutline(ping.json.ping as Json, 'ping', mutedPing)

      // 9. Search.
      const search = await read(app, '/api/search?q=lanterns&hidden=outline', GROWER.secret)
      assert.deepEqual(ids(search.json.results), [keptNote])
      assert.equal(search.json.hidden_by_your_mutes, 1)
      assert.equal(search.json.total_items, anonymousBefore.get('/api/search?q=lanterns')!.json.total_items)
      const thingSearch = await read(app, '/api/search?q=lantern&type=thing', GROWER.secret)
      assert.deepEqual(ids(thingSearch.json.results), [keptThing])
      assert.equal(thingSearch.json.hidden_by_your_mutes, 1)

      // 10. Changes.
      const changes = await read(app, '/api/changes?since=0&limit=200&hidden=outline', GROWER.secret)
      const changeRows = changes.json.changes as Json[]
      assert.equal(changeRows.some(row => row.actor === NEIGHBOUR.handle), false)
      assert.ok(Number(changes.json.hidden_by_your_mutes) >= 2)
      assert.equal(changes.json.next_since, anonymousBefore.get('/api/changes?since=0&limit=200')!.json.next_since)

      // 11. Events.
      const events = await read(app, `/api/events?place_id=${rooms.eastRoomId}&limit=200&hidden=outline`, GROWER.secret)
      assert.equal((events.json.events as Json[]).some(row => row.actor === NEIGHBOUR.handle), false)
      assert.ok(Number(events.json.hidden_by_your_mutes) >= 2)
      assert.equal(events.json.total_items, anonymousBefore.get(`/api/events?place_id=${rooms.eastRoomId}&limit=200`)!.json.total_items)

      // 12. Browse views: kinds, traits, agreements (a party always sees its own), residents, Gazette.
      const kinds = await read(app, '/api/kinds?hidden=outline', GROWER.secret)
      assert.deepEqual(ids(kinds.json.kinds), [keptKind])
      assert.deepEqual(hiddenIds(kinds.json), [`kind:${mutedKind}`])
      const traits = await read(app, '/api/traits', GROWER.secret)
      assert.equal(ids(traits.json.traits).includes(mutedTrait), false)
      assert.equal(ids(traits.json.traits).includes(keptTrait), true)
      assert.equal(traits.json.hidden_by_your_mutes, 1)
      const agreements = await read(app, '/api/agreements', GROWER.secret)
      assert.deepEqual(ids(agreements.json.agreements), [partyAgreement])
      assert.equal(agreements.json.hidden_by_your_mutes, 1)
      const residents = await read(app, '/api/residents', GROWER.secret)
      assert.equal((residents.json.residents as Json[]).some(row => row.handle === NEIGHBOUR.handle), false)
      assert.equal(residents.json.hidden_by_your_mutes, 1)
      assert.equal(residents.json.total_items, anonymousBefore.get('/api/residents')!.json.total_items)
      const focused = await read(app, `/api/residents?view=presence&handle=${NEIGHBOUR.handle}`, GROWER.secret)
      assert.equal(focused.json.hidden_by_your_mutes, 1)
      assert.equal((focused.json.resident as Json).type, 'resident')
      const gazette = await read(app, '/api/gazette/1?hidden=outline', GROWER.secret)
      assert.equal(gazette.status, 200, gazette.text)
      assert.deepEqual((gazette.json.entries as Json[]).map(row => row.note_id), [keptEntry])
      assert.deepEqual(hiddenIds(gazette.json), [`note:${mutedEntry}`])
      const moderation = await read(app, '/api/moderation', GROWER.secret)
      assert.equal(moderation.text, (await read(app, '/api/moderation')).text, 'the moderation log is never shaped')

      // 15. Drawings of a muted record come as outlines.
      const portrait = await read(app, `/api/drawing/resident/${NEIGHBOUR.id}`, GROWER.secret)
      assert.equal(portrait.json.hidden_by_your_mutes, 1)
      assert.equal(Object.hasOwn(portrait.json, 'rows'), false)
      assert.ok(portrait.json.outline, 'the muted portrait comes as its size and colours')
      assert.equal(Object.hasOwn((await read(app, `/api/drawing/resident/${NEIGHBOUR.id}`)).json, 'rows'), true)
      const hallDrawing = await read(app, `/api/drawing/place/${hall}/history`, GROWER.secret)
      assert.equal(hallDrawing.json.hidden_by_your_mutes, 1)

      // 14. The pending-ping summary leaves a muted resident's ping out, and adds none when
      // every pending ping is from one.
      // read_here signs its caller in, so its answer is one that carries the summary.
      const signedIn = await mcpCall(app, GROWER.secret, 'read_here', { note_id: keptNote })
      assert.equal(Object.hasOwn(signedIn, 'pending_pings'), false)
      const kept = await seedPing(rooms.eastRoomId, FAR_SHORE.id, GROWER.id)
      const summarized = await mcpCall(app, GROWER.secret, 'read_here', { note_id: keptNote })
      assert.equal((summarized.pending_pings as Json).total, 1)
      assert.equal(((summarized.pending_pings as Json).newest as Json).ping_id, kept)

      // 13. me: the muted ping is counted, never shown, and marked seen as if shown;
      // around_you leaves the muted note out and counts it; the Gazette headline too.
      const me = await read(app, '/api/me?hidden=outline', GROWER.secret)
      assert.equal(me.status, 200, me.text)
      const pending = me.json.pending_pings as Json
      assert.equal(pending.total, 1)
      assert.deepEqual((pending.receipts as Json[]).map(row => row.ping_id), [kept])
      assert.ok(hiddenIds(me.json).includes(`ping:${mutedPing}`))
      assert.ok(Number(me.json.hidden_by_your_mutes) >= 1)
      const aroundYou = (me.json.since_last_visit as Json).around_you as Json
      assert.equal(((aroundYou.notes_in_owned_places as Json).records as Json[]).some(row => row.id === mutedNote), false)
      assert.equal(((aroundYou.mentions as Json).records as Json[]).some(row => row.id === mutedNote), false)
      assert.ok(Number(aroundYou.hidden_by_your_mutes) >= 1)
      assert.deepEqual((await db.query(
        'SELECT ping_id, seen_at IS NOT NULL AS seen FROM ping_receipts WHERE recipient_id = $1 ORDER BY ping_id', [GROWER.id],
      )).rows.map(row => [Number(row.ping_id), row.seen]), [[mutedPing, true], [kept, true]])
    })

    await t.test('wait_here: a muted resident\'s line never ends the wait, and is counted', async () => {
      const rooms = await resetCity(RESIDENTS)
      for (const resident of [GROWER, NEIGHBOUR, FAR_SHORE]) await standIn(resident.id, rooms.eastRoomId)
      await mute(app, GROWER.secret, 'mute', 'resident', NEIGHBOUR.id)
      const marker = String((await read(app, '/api/changes')).json.change_marker)
      await say(app, NEIGHBOUR.secret, rooms.eastRoomId, 'a muted line while you wait')
      const started = Date.now()
      const waited = await call(app, GROWER.secret, 'POST', '/api/wait-here', {
        after_line_change: marker, after_ping_change: marker, seconds: 3,
      })
      assert.equal(waited.status, 200, JSON.stringify(waited.json))
      assert.equal(waited.json.reason, 'timeout')
      assert.ok(Date.now() - started >= 2_500, 'the wait ran to its end')
      assert.deepEqual(waited.json.lines, [])
      assert.equal(waited.json.hidden_by_your_mutes, 1)
      assert.ok(BigInt(String(waited.json.next_after_line_change)) > BigInt(marker), 'the cursor moved past the muted line')

      // The next unmuted arrival ends the wait, and only it is sent.
      const after = String((await read(app, '/api/changes')).json.change_marker)
      await say(app, NEIGHBOUR.secret, rooms.eastRoomId, 'muted again')
      await say(app, FAR_SHORE.secret, rooms.eastRoomId, 'a kept line')
      const second = await call(app, GROWER.secret, 'POST', '/api/wait-here', {
        after_line_change: after, after_ping_change: after, seconds: 3,
      })
      assert.equal(second.json.reason, 'change')
      assert.deepEqual((second.json.lines as Json[]).map(row => row.body), ['a kept line'])
      assert.equal(second.json.hidden_by_your_mutes, 1)
    })

    await t.test('a place mute covers the places inside it, and an allow on a child lets it through', async () => {
      const rooms = await resetCity(RESIDENTS)
      const garden = await seedPlace(rooms.continentId, 'Garden', FAR_SHORE.id)
      const shed = await seedPlace(garden, 'Shed', FAR_SHORE.id)
      const potting = await seedPlace(shed, 'Potting Bench', FAR_SHORE.id)
      const gardenNote = await seedNote(garden, FAR_SHORE.id, 'garden words')
      const shedNote = await seedNote(shed, FAR_SHORE.id, 'shed words')
      const pottingNote = await seedNote(potting, FAR_SHORE.id, 'potting words')
      await mute(app, GROWER.secret, 'mute', 'place', garden)
      await mute(app, GROWER.secret, 'allow', 'place', shed)
      const gardenRead = await read(app, `/api/place/${garden}`, GROWER.secret)
      assert.equal((gardenRead.json.place as Json).muted, true)
      assert.equal(ids(gardenRead.json.notes).includes(gardenNote), false)
      assert.equal((gardenRead.json.subplaces as Json[]).find(row => row.id === shed)!.muted, undefined)
      const shedRead = await read(app, `/api/place/${shed}`, GROWER.secret)
      assert.equal(ids(shedRead.json.notes).includes(shedNote), true)
      assert.equal((shedRead.json.place as Json).muted, undefined)
      // The allow covers the shed and every place inside it.
      assert.equal(ids((await read(app, `/api/place/${potting}`, GROWER.secret)).json.notes).includes(pottingNote), true)
      // A mute inside the allowed shed is nearer, so it wins there.
      await mute(app, GROWER.secret, 'mute', 'place', potting)
      assert.equal(ids((await read(app, `/api/place/${potting}`, GROWER.secret)).json.notes).includes(pottingNote), false)
    })

    await t.test('an item allow beats a resident mute; founder items and founder-owned places pass a mute on the room', async () => {
      const rooms = await resetCity(RESIDENTS)
      const allowedNote = await seedNote(rooms.eastRoomId, NEIGHBOUR.id, 'the one allowed note')
      const otherNote = await seedNote(rooms.eastRoomId, NEIGHBOUR.id, 'another muted note')
      await mute(app, GROWER.secret, 'mute', 'resident', NEIGHBOUR.id)
      await mute(app, GROWER.secret, 'allow', 'note', allowedNote)
      const room = await read(app, `/api/place/${rooms.eastRoomId}`, GROWER.secret)
      assert.equal(ids(room.json.notes).includes(allowedNote), true)
      assert.equal(ids(room.json.notes).includes(otherNote), false)
      assert.match((await read(app, `/api/note/${allowedNote}`, GROWER.secret)).text, /the one allowed note/u)

      const founderNote = await seedNote(rooms.westRoomId, FOUNDER.id, 'the founder speaks')
      const farNote = await seedNote(rooms.westRoomId, FAR_SHORE.id, 'far-shore speaks')
      await mute(app, GROWER.secret, 'mute', 'place', rooms.westRoomId)
      const west = await read(app, `/api/place/${rooms.westRoomId}?view=full`, GROWER.secret)
      assert.equal(ids(west.json.notes).includes(founderNote), true)
      assert.equal(ids(west.json.notes).includes(farNote), false)
      assert.equal((west.json.place as Json).description, 'the west room')
      assert.equal((west.json.place as Json).muted, undefined)
      const continent = await read(app, `/api/place/${rooms.continentId}?view=full`, GROWER.secret)
      assert.equal((continent.json.subplaces as Json[]).find(row => row.id === rooms.westRoomId)!.description, 'the west room')
    })

    await t.test('the map drops a muted maker\'s front matter headings and counts them; anonymous maps are unchanged', async () => {
      const rooms = await resetCity(RESIDENTS)
      const thingName = 'zq front matter lantern by next-door'
      const frontThing = await seedThing(rooms.eastRoomId, NEIGHBOUR.id, thingName, 'a lantern body')
      const keptThing = await seedThing(rooms.eastRoomId, FAR_SHORE.id, 'zq kept front matter lamp', 'a lamp body')
      await db.query('UPDATE places SET front_matter_thing_ids = ARRAY[$2, $3]::integer[] WHERE id = $1', [rooms.eastRoomId, frontThing, keptThing])
      const continent = `/api/map?view=continent&continent_id=${rooms.continentId}`
      const outline = `/api/map?view=outline&parent_id=${rooms.continentId}`
      const paths = ['/api/map', '/api/map?view=full', outline, continent]
      const withHidden = (path: string): string => `${path}${path.includes('?') ? '&' : '?'}hidden=outline`
      // The anonymous map and outline are shared for 30 seconds; step past an earlier
      // subtest's copy so these reads build from this city.
      const realNow = Date.now
      Date.now = () => realNow() + 120_000
      let anonymousBefore: Read[]
      try {
        anonymousBefore = await Promise.all(paths.map(path => read(app, path)))
      } finally {
        Date.now = realNow
      }
      assert.match(anonymousBefore[0]!.text, /zq front matter lantern/u)
      assert.match(anonymousBefore[2]!.text, /zq front matter lantern/u)

      await mute(app, GROWER.secret, 'mute', 'resident', NEIGHBOUR.id)
      const eastRow = (answer: Json): Json => {
        const rows: Json[] = []
        const walk = (list: unknown): void => {
          for (const row of (list ?? []) as Json[]) {
            rows.push(row)
            walk(row.children)
          }
        }
        walk(answer.places)
        walk(answer.subplaces)
        return rows.find(row => row.id === rooms.eastRoomId)!
      }
      for (const path of ['/api/map', '/api/map?view=full', outline]) {
        const keyed = await read(app, path, GROWER.secret)
        assert.equal(keyed.status, 200, keyed.text)
        assert.doesNotMatch(keyed.text, /zq front matter lantern/u, path)
        assert.deepEqual(ids(eastRow(keyed.json).front_matter), [keptThing], path)
        assert.equal(keyed.json.hidden_by_your_mutes, 1, path)
        assert.equal(typeof keyed.json.hidden_next_step, 'string', path)
        assert.equal(keyed.headers['cache-control'], 'private, no-store', path)
        const listed = await read(app, withHidden(path), GROWER.secret)
        assert.deepEqual(hiddenIds(listed.json), [`thing:${frontThing}`], path)
        assertOutline((listed.json.hidden_items as Json[])[0]!, 'thing', frontThing)
        assert.doesNotMatch(listed.text, /zq front matter lantern/u, path)
      }
      const keyedContinent = await read(app, continent, GROWER.secret)
      assert.equal(keyedContinent.json.hidden_by_your_mutes, 0)
      const refused = await read(app, '/api/map?hidden=all', GROWER.secret)
      assert.equal(refused.status, 400)
      assert.equal(refused.json.error, HIDDEN_REFUSAL)
      const lookedRoot = await mcpCall(app, GROWER.secret, 'look', { hidden: 'outline' })
      assert.equal(lookedRoot.hidden_by_your_mutes, 0)
      const looked = await mcpCall(app, GROWER.secret, 'look', { view: 'full', hidden: 'outline' })
      assert.doesNotMatch(JSON.stringify(looked), /zq front matter lantern/u)
      assert.deepEqual(hiddenIds(looked), [`thing:${frontThing}`])
      // The place read counts the same heading once, though it is also on its things page.
      const east = await read(app, `/api/place/${rooms.eastRoomId}?hidden=outline`, GROWER.secret)
      assert.doesNotMatch(east.text, /zq front matter lantern/u)
      assert.deepEqual(ids(east.json.front_matter), [keptThing])
      assert.deepEqual(hiddenIds(east.json), [`thing:${frontThing}`])

      const anonymousAfter = await Promise.all(paths.map(path => read(app, path)))
      assert.deepEqual(anonymousAfter.map(answer => answer.text), anonymousBefore.map(answer => answer.text))
      const anonymousHidden = await Promise.all(paths.map(path => read(app, withHidden(path))))
      assert.deepEqual(anonymousHidden.map(answer => answer.text), anonymousBefore.map(answer => answer.text))
    })

    await t.test('a muted resident\'s drawing and drawing history send no description on any door', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GROWER.id, rooms.eastRoomId)
      const cells = { palette: ['#ad3f25', '#f0c95f'], indices: Array.from({ length: 64 }, (_, i) => i % 2) }
      for (const words of ['zq first portrait words', 'zq second portrait words']) {
        const drew = await call(app, NEIGHBOUR.secret, 'PATCH', '/api/me/drawing', {
          drawing: cells,
          drawing_state: 'complete',
          drawing_description: words,
        })
        assert.equal(drew.status, 200, JSON.stringify(drew.json))
      }
      const thing = await seedThing(rooms.eastRoomId, NEIGHBOUR.id, 'a drawn lantern', 'a lantern body')
      await db.query(
        `UPDATE things SET drawing = $2::jsonb, drawing_state = 'complete', drawing_description = 'zq thing drawing words' WHERE id = $1`,
        [thing, JSON.stringify(cells)],
      )
      const portrait = `/api/drawing/resident/${NEIGHBOUR.id}`
      assert.match((await read(app, portrait, GROWER.secret)).text, /zq second portrait words/u)
      assert.match((await read(app, `${portrait}/history`, GROWER.secret)).text, /zq first portrait words/u)

      await mute(app, GROWER.secret, 'mute', 'resident', NEIGHBOUR.id)
      for (const path of [portrait, `${portrait}/history`, `/api/drawing/thing/${thing}`, `/api/drawing/thing/${thing}/history`]) {
        const keyed = await read(app, path, GROWER.secret)
        assert.equal(keyed.status, 200, keyed.text)
        assert.doesNotMatch(keyed.text, /zq [a-z ]*words/u, path)
        assert.equal(keyed.json.hidden_by_your_mutes, 1, path)
      }
      const single = (await read(app, portrait, GROWER.secret)).json
      assert.deepEqual((single.outline as Json).colours_used, ['#ad3f25', '#f0c95f'])
      assert.equal(single.drawing, undefined)
      assert.equal(single.description, undefined)
      const history = (await read(app, `${portrait}/history`, GROWER.secret)).json
      assert.equal((history.revisions as Json[]).length, 2)
      assert.match((await read(app, portrait)).text, /zq second portrait words/u)

      const previousSignin = process.env.HOSTED_CHAT_SIGNIN_ENABLED
      process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
      try {
        const { mcp } = await import('../../src/mcp.ts')
        const { configureOAuthResidentResolver } = await import('../../src/oauth.ts')
        const { oauthResourceFor } = await import('../../src/oauth-config.ts')
        configureOAuthResidentResolver()
        const tokenFor = async (door: 'connect' | 'app'): Promise<string> => {
          const token = `1f3d9_at_${(door === 'app' ? 'ab' : 'cd').repeat(32)}`
          const family = await db.query<{ id: string }>(`
            INSERT INTO oauth_token_families (resident_id, client_id, resource, scope, expires_at)
            VALUES ($1, 'mutes-client', $2, 'city:resident', now() + interval '1 day') RETURNING id
          `, [GROWER.id, oauthResourceFor(door)])
          await db.query(
            `INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at) VALUES ($1, 'access', $2, now() + interval '9 minutes')`,
            [createHash('sha256').update(token, 'utf8').digest('hex'), family.rows[0]!.id],
          )
          return token
        }
        const hosted = new Hono()
        hosted.post('/mcp', c => mcp(c, app as unknown as Hono, { door: 'key' }))
        hosted.post('/mcp/connect', c => mcp(c, app as unknown as Hono, { hostedChat: true, forwardUnauthorizedStatus: true }))
        hosted.post('/mcp/app', c => mcp(c, app as unknown as Hono, { door: 'app', forwardUnauthorizedStatus: true }))
        const doors: ReadonlyArray<readonly [string, string]> = [
          ['/mcp', GROWER.secret],
          ['/mcp/connect', await tokenFor('connect')],
          ['/mcp/app', await tokenFor('app')],
        ]
        const calls: ReadonlyArray<readonly [string, Json]> = [
          ['drawing', { type: 'resident', id: NEIGHBOUR.id }],
          ['drawing_history', { type: 'resident', id: NEIGHBOUR.id }],
          ['drawing', { type: 'thing', id: thing }],
        ]
        for (const [door, token] of doors) {
          for (const [name, args] of calls) {
            const response = await hosted.request(`http://city.test${door}`, {
              method: 'POST',
              headers: { ...bearer(token), accept: 'application/json, text/event-stream' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
            }, { outgoing: Object.assign(new EventEmitter(), { destroyed: false }) })
            const text = await response.text()
            assert.equal(response.status, 200, `${door} ${name} ${text}`)
            assert.match(text, /hidden_by_your_mutes/u, `${door} ${name} ${text}`)
            assert.doesNotMatch(text, /zq [a-z ]*words/u, `${door} ${name}`)
          }
        }
      } finally {
        if (previousSignin === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
        else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousSignin
      }
    })
  } finally {
    await postgres.stop()
  }
})
