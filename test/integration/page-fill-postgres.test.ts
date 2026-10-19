// Full pages after hiding (src/page-fill.ts) against real PostgreSQL: the real schema and
// the real routes. A signed-in list read whose reader's mutes drop rows reads further
// rows until the page holds its page size of shown rows, within PAGE_FILL_EXTRA_READS
// further reads of one page size; the cursor names the last row the page looked at, so
// a walk sends every shown row exactly once, and every dropped row is counted on the
// page that dropped it. Anonymous reads, and readers with no mutes, are unchanged.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
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

// GROWER reads; NEIGHBOUR and the two quiet ones are muted; FAR_SHORE is anyone else.
const FAR_SHORE = Object.freeze({ id: 5, handle: 'far-shore', secret: `1f3d9_sk_${'5'.repeat(48)}` })
const QUIET_ONE = Object.freeze({ id: 6, handle: 'quiet-one', secret: `1f3d9_sk_${'6'.repeat(48)}` })
const QUIET_TWO = Object.freeze({ id: 7, handle: 'quiet-two', secret: `1f3d9_sk_${'7'.repeat(48)}` })
const LATE_SHORE = Object.freeze({ id: 8, handle: 'late-shore', secret: `1f3d9_sk_${'8'.repeat(48)}` })
const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR, FAR_SHORE, QUIET_ONE, QUIET_TWO, LATE_SHORE] as const

type Read = Readonly<{ status: number; text: string; json: Json }>

async function read(app: CityApp, path: string, secret: string | null = null): Promise<Read> {
  const response = await app.request(`http://city.test${path}`, {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, text, json: JSON.parse(text) as Json })
}

async function mute(app: CityApp, secret: string, type: string, id: number): Promise<void> {
  const response = await app.request('http://city.test/api/me/settings', {
    method: 'PATCH',
    headers: bearer(secret),
    body: JSON.stringify({ mute: { type, id } }),
  })
  assert.equal(response.status, 200, await response.text())
}

async function insertId(text: string, values: readonly unknown[]): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(text, [...values])).rows[0]!.id)
}

async function seedNote(placeId: number, authorId: number, body: string): Promise<number> {
  return insertId('INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, $3) RETURNING id', [placeId, authorId, body])
}

async function seedThing(placeId: number, makerId: number, name: string): Promise<number> {
  return insertId(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id) VALUES ($1, $2, $3, $4, $4) RETURNING id
  `, [placeId, name, `the ${name} body`, makerId])
}

async function seedTrait(coinerId: number, name: string): Promise<number> {
  return insertId('INSERT INTO traits (name, description, coiner_id) VALUES ($1, $2, $3) RETURNING id', [name, `${name} words`, coinerId])
}

function ids(rows: unknown, field = 'id'): number[] {
  return (rows as Json[]).map(row => Number(row[field]))
}

function hiddenIds(answer: Json): number[] {
  return ((answer.hidden_items ?? []) as Json[]).map(row => Number(row.id))
}

/** Interleave two residents' items oldest first: a kept one, then a muted one, count times. */
async function interleave(count: number, kept: (index: number) => Promise<number>, muted: (index: number) => Promise<number>) {
  const shown: number[] = []
  const hidden: number[] = []
  for (let index = 0; index < count; index += 1) {
    shown.push(await kept(index))
    hidden.push(await muted(index))
  }
  return { shown: shown.reverse(), hidden: hidden.reverse() }
}

test('full pages after hiding against real PostgreSQL', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('page-fill')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { PAGE_FILL_EXTRA_READS } = await import('../../src/page-fill.ts')
    assert.equal(PAGE_FILL_EXTRA_READS, 4)

    await t.test('a place read fills its notes and things pages, and the next page starts right after', async () => {
      const rooms = await resetCity(RESIDENTS)
      const notes = await interleave(12,
        index => seedNote(rooms.eastRoomId, FAR_SHORE.id, `shore words ${index}`),
        index => seedNote(rooms.eastRoomId, NEIGHBOUR.id, `next door words ${index}`))
      const things = await interleave(7,
        index => seedThing(rooms.eastRoomId, FAR_SHORE.id, `shore-thing-${index}`),
        index => seedThing(rooms.eastRoomId, NEIGHBOUR.id, `door-thing-${index}`))
      const path = `/api/place/${rooms.eastRoomId}?note_limit=5&thing_limit=3`
      const anonymousBefore = await read(app, path)
      const unmutedBefore = await read(app, path, GROWER.secret)
      await mute(app, GROWER.secret, 'resident', NEIGHBOUR.id)
      // Anonymous reads, and a reader with no mutes, are byte for byte what they were.
      assert.equal((await read(app, path)).text, anonymousBefore.text)
      assert.equal((await read(app, path, FAR_SHORE.secret)).text, unmutedBefore.text)
      assert.deepEqual(ids(anonymousBefore.json.notes), [notes.hidden[0], notes.shown[0], notes.hidden[1], notes.shown[1], notes.hidden[2]])

      const first = await read(app, `${path}&hidden=outline`, GROWER.secret)
      assert.equal(first.status, 200, first.text)
      assert.deepEqual(ids(first.json.notes), notes.shown.slice(0, 5), 'five shown notes, not two')
      assert.deepEqual(ids(first.json.things), things.shown.slice(0, 3), 'three shown things, not two')
      // Every row the page dropped while filling is counted and listed, and no other.
      assert.equal(first.json.hidden_by_your_mutes, 5 + 3)
      assert.deepEqual(hiddenIds(first.json).sort((a, b) => a - b), [...notes.hidden.slice(0, 5), ...things.hidden.slice(0, 3)].sort((a, b) => a - b))
      const notesPage = first.json.notes_page as Json
      assert.equal(notesPage.total_items, 24, 'totals still count hidden notes')
      assert.equal(notesPage.returned_items, 5)
      assert.equal(notesPage.has_more, true)
      assert.equal(notesPage.next_before_note_id, notes.shown[4], 'the cursor names the last note the page looked at')
      assert.equal((first.json.things_page as Json).next_before_thing_id, things.shown[2])

      // The walk sends every shown note exactly once, with no gap and no repeat.
      const walked: number[] = [...ids(first.json.notes)]
      let cursor: unknown = notesPage.next_before_note_id
      let pages = 1
      while (cursor !== null) {
        const next = await read(app, `${path}&before_note_id=${cursor}`, GROWER.secret)
        walked.push(...ids(next.json.notes))
        cursor = (next.json.notes_page as Json).next_before_note_id
        pages += 1
      }
      assert.deepEqual(walked, notes.shown)
      assert.equal(pages, 3)
    })

    await t.test('a page stops after four further reads of one page size, and says where it stopped', async () => {
      const rooms = await resetCity(RESIDENTS)
      const kept: number[] = []
      for (let index = 0; index < 3; index += 1) kept.unshift(await seedNote(rooms.westRoomId, FAR_SHORE.id, `kept ${index}`))
      const hidden: number[] = []
      for (let index = 0; index < 30; index += 1) hidden.unshift(await seedNote(rooms.westRoomId, NEIGHBOUR.id, `muted ${index}`))
      await mute(app, GROWER.secret, 'resident', NEIGHBOUR.id)
      const path = `/api/place/${rooms.westRoomId}?note_limit=5`
      const first = await read(app, path, GROWER.secret)
      assert.deepEqual(first.json.notes, [], 'the bound came first: no shown note yet')
      assert.equal(first.json.hidden_by_your_mutes, 5 * (1 + PAGE_FILL_EXTRA_READS))
      const page = first.json.notes_page as Json
      assert.equal(page.has_more, true)
      assert.equal(page.next_before_note_id, hidden[24])
      const second = await read(app, `${path}&before_note_id=${page.next_before_note_id}`, GROWER.secret)
      assert.deepEqual(ids(second.json.notes), kept)
      assert.equal(second.json.hidden_by_your_mutes, 5)
      assert.equal((second.json.notes_page as Json).has_more, false)
      assert.equal((second.json.notes_page as Json).next_before_note_id, null)
    })

    await t.test('events, lines, traits, kinds, agreements and the residents directory fill the same way', async () => {
      const rooms = await resetCity(RESIDENTS)
      for (const resident of [GROWER, NEIGHBOUR, FAR_SHORE]) await standIn(resident.id, rooms.eastRoomId)
      const written = async (secret: string, body: string) => {
        const answer = await call(app, secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body })
        assert.equal(answer.status, 201, JSON.stringify(answer.json))
        return Number((answer.json.note as Json).id)
      }
      const spoken = async (secret: string, body: string) => {
        const answer = await call(app, secret, 'POST', '/api/line', { place_id: rooms.eastRoomId, body, request_id: randomUUID() })
        assert.equal(answer.status, 201, JSON.stringify(answer.json))
        return Number((answer.json.line as Json).id)
      }
      const notes = await interleave(6,
        index => written(FAR_SHORE.secret, `kept note ${index}`),
        index => written(NEIGHBOUR.secret, `muted note ${index}`))
      const lines = await interleave(6,
        index => spoken(FAR_SHORE.secret, `kept line ${index}`),
        index => spoken(NEIGHBOUR.secret, `muted line ${index}`))
      const traits = await interleave(5,
        index => seedTrait(FAR_SHORE.id, `kept-trait-${index}`),
        index => seedTrait(NEIGHBOUR.id, `muted-trait-${index}`))
      const kinds = await interleave(4,
        index => seedKind(FAR_SHORE.id, `kept-kind-${index}`, []),
        index => seedKind(NEIGHBOUR.id, `muted-kind-${index}`, []))
      const agreements = await interleave(3,
        index => insertId('INSERT INTO agreements (created_by_id, body) VALUES ($1, $2) RETURNING id', [FAR_SHORE.id, `kept pact ${index}`]),
        index => insertId('INSERT INTO agreements (created_by_id, body) VALUES ($1, $2) RETURNING id', [NEIGHBOUR.id, `muted pact ${index}`]))
      for (const muted of [NEIGHBOUR, QUIET_ONE, QUIET_TWO]) await mute(app, GROWER.secret, 'resident', muted.id)

      const events = await read(app, `/api/events?place_id=${rooms.eastRoomId}&kind=note&limit=3`, GROWER.secret)
      assert.equal(events.status, 200, events.text)
      const noteIds = (answer: Read) => (answer.json.events as Json[]).map(row => Number((row.detail as Json).note_id))
      assert.deepEqual(noteIds(events), notes.shown.slice(0, 3))
      assert.equal(events.json.hidden_by_your_mutes, 3)
      assert.equal(events.json.returned_items, 3)
      assert.equal(events.json.total_items, 12)
      const nextEvents = await read(app, `/api/events?place_id=${rooms.eastRoomId}&kind=note&limit=3&before_id=${events.json.next_before_id}`, GROWER.secret)
      assert.deepEqual(noteIds(nextEvents), notes.shown.slice(3))
      assert.equal(nextEvents.json.hidden_by_your_mutes, 3)
      // The same list read through every place inside the continent fills the same way.
      const within = await read(app, `/api/events?within_place_id=${rooms.continentId}&kind=note&limit=3`, GROWER.secret)
      assert.equal(within.status, 200, within.text)
      assert.deepEqual(noteIds(within), notes.shown.slice(0, 3))
      assert.equal(within.json.total_items, 12, 'totals come from the first read only')
      assert.equal(nextEvents.json.has_more, false)

      const placeLines = await read(app, `/api/place/${rooms.eastRoomId}/lines?limit=4`, GROWER.secret)
      assert.deepEqual(ids(placeLines.json.lines), lines.shown.slice(0, 4))
      assert.equal(placeLines.json.hidden_by_your_mutes, 4)
      assert.equal((placeLines.json.lines_page as Json).next_before_line_id, lines.shown[3])

      const traitPage = await read(app, '/api/traits?limit=3', GROWER.secret)
      assert.deepEqual(ids(traitPage.json.traits), traits.shown.slice(0, 3))
      assert.equal(traitPage.json.hidden_by_your_mutes, 3)
      assert.equal(traitPage.json.next_before_id, traits.shown[2])

      const kindPage = await read(app, '/api/kinds?limit=2', GROWER.secret)
      assert.deepEqual(ids(kindPage.json.kinds), kinds.shown.slice(0, 2))
      assert.equal(kindPage.json.hidden_by_your_mutes, 2)

      const agreementPage = await read(app, '/api/agreements?limit=2', GROWER.secret)
      assert.equal(agreementPage.status, 200, agreementPage.text)
      assert.deepEqual(ids(agreementPage.json.agreements), agreements.shown.slice(0, 2))
      assert.equal(agreementPage.json.hidden_by_your_mutes, 2)
      assert.equal(agreementPage.json.next_before_id, agreements.shown[1])

      // Newest residents first: late-shore, quiet-two, quiet-one, far-shore, next-door, ...
      const directory = await read(app, '/api/residents?limit=2', GROWER.secret)
      assert.deepEqual((directory.json.residents as Json[]).map(row => row.handle), ['late-shore', 'far-shore'])
      assert.equal(directory.json.hidden_by_your_mutes, 2)
      assert.equal(directory.json.next_before_id, FAR_SHORE.id)
      const anonymousDirectory = await read(app, '/api/residents?limit=2')
      assert.deepEqual((anonymousDirectory.json.residents as Json[]).map(row => row.handle), ['late-shore', 'quiet-two'])
    })

    await t.test('one Gazette issue fills its page of entries and its cursor is the last ordinal it looked at', async () => {
      const rooms = await resetCity(RESIDENTS)
      const db = connectedDatabase()
      // The Gazette prints notes left in room #454, which begins as the city's closed shell
      // and opens, exactly as in the mutes suite.
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
      const authors = [NEIGHBOUR, FAR_SHORE, NEIGHBOUR, FAR_SHORE, LATE_SHORE]
      const entries: number[] = []
      for (const [index, author] of authors.entries()) {
        entries.push(await insertId(
          `INSERT INTO notes (place_id, author_id, body, created_at) VALUES (454, $1, $2, '2026-08-31T15:59:00Z') RETURNING id`,
          [author.id, `submission ${index}`],
        ))
      }
      await db.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
      const printer = await db.connect()
      try {
        await printer.query('BEGIN')
        const printed = Number((await printer.query<{ id: number }>(`INSERT INTO events (kind, actor, detail) VALUES ('gazette_printed', 'the Gazette printer', '{"issue_number":1,"place_id":454,"entry_count":5}'::jsonb) RETURNING id`)).rows[0]!.id)
        await printer.query(`INSERT INTO gazette_issues (issue_number, scheduled_for, printed_at, header, entry_count, event_id) VALUES (1, '2026-08-31T16:00:00Z', '2026-08-31T16:00:01Z', 'THE GAZETTE, ISSUE 1', 5, $1)`, [printed])
        for (const [index, noteId] of entries.entries()) {
          await printer.query('INSERT INTO gazette_issue_entries (issue_number, ordinal, note_id) VALUES (1, $1, $2)', [index + 1, noteId])
        }
        await printer.query('COMMIT')
      } catch (error) {
        await printer.query('ROLLBACK')
        throw error
      } finally {
        printer.release()
      }
      const anonymous = await read(app, '/api/gazette/1?limit=2')
      assert.deepEqual(ids(anonymous.json.entries, 'note_id'), entries.slice(0, 2))
      await mute(app, GROWER.secret, 'resident', NEIGHBOUR.id)
      const first = await read(app, '/api/gazette/1?limit=2', GROWER.secret)
      assert.equal(first.status, 200, first.text)
      assert.deepEqual(ids(first.json.entries, 'note_id'), [entries[1], entries[3]])
      assert.equal(first.json.hidden_by_your_mutes, 2)
      assert.equal(first.json.has_more, true)
      assert.equal(first.json.next_after_ordinal, 4)
      const next = await read(app, '/api/gazette/1?limit=2&after_ordinal=4', GROWER.secret)
      assert.deepEqual(ids(next.json.entries, 'note_id'), [entries[4]])
      assert.equal(next.json.has_more, false)
      assert.equal(next.json.next_after_ordinal, null)
      assert.equal((await read(app, '/api/gazette/1?limit=2')).text, anonymous.text, 'anonymous reads are unchanged')
    })
  } finally {
    await postgres.stop()
  }
})
