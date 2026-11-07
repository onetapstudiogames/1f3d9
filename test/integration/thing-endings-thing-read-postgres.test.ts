// Thing endings on the public thing read (T15), against real PostgreSQL on the full
// db/schema.sql, the five-states fixture and the real routes. GET /api/thing/:id carries
// the full ending object and end_program_summary beside on_use; a due or ended thing
// reads no current labels while its label rows stay; the read writes nothing; snapshot
// format 4 says the same as the read, field for field, for every thing in the fixture
// (with and without a maintainer-hidden kind) and the same offer phase; and a thing_ended
// event in a quiet room reaches the human views exactly as a thing_edited does.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { call, type CityApp, type Json } from '../helpers/abilities-fixtures.ts'
import { connectedDatabase, startNoteSuiteDatabase } from '../helpers/note-suite-fixtures/postgres.ts'
import {
  FIVE_STATES_RESIDENTS,
  seedFiveStates,
  type FiveStatesFixture,
} from '../helpers/thing-endings-fixtures/five-states.ts'

const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const TIME_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

/** Times as one shape (milliseconds, UTC): v4 writes PostgreSQL's, the read writes toISOString. */
function sameTimes(value: unknown): unknown {
  if (typeof value === 'string' && TIME_TEXT.test(value)) return new Date(value).toISOString()
  if (Array.isArray(value)) return value.map(sameTimes)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sameTimes(item)]))
  }
  return value
}

function withoutCheckedAt(ending: unknown): unknown {
  if (!ending || typeof ending !== 'object') return ending
  const { checked_at: _checkedAt, ...rest } = ending as Json
  return sameTimes(rest)
}

const EXPECTED_STATUS: Readonly<Record<keyof FiveStatesFixture['things'], string>> = Object.freeze({
  notPermitted: 'not_permitted_by_kind',
  unset: 'permitted_but_unset',
  kindlessUnset: 'permitted_but_unset',
  kindlessGiven: 'not_permitted_by_kind',
  active: 'active',
  activeTimed: 'active',
  due: 'due_waiting_settle',
  remnant: 'ended',
  ran: 'ended',
  wakeOff: 'permitted_but_unset',
  carried: 'permitted_but_unset',
  visiting: 'permitted_but_unset',
  blocked: 'permitted_but_unset',
  retiredRoom: 'permitted_but_unset',
})

function findPlace(places: unknown, id: number): Json | null {
  if (!Array.isArray(places)) return null
  for (const place of places as Json[]) {
    if (Number(place.id) === id) return place
    const child = findPlace(place.children, id)
    if (child) return child
  }
  return null
}

test('thing endings on the public thing read, against PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-thing-read')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { MODERATED_TEXT } = await import('../../src/moderation.ts')
    const db = connectedDatabase()

    let fixture: FiveStatesFixture
    const reset = async () => {
      await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await db.query(schemaDdl)
      fixture = await seedFiveStates(db)
    }
    const readThing = async (id: number): Promise<Json> => {
      const response = await call(app, null, 'GET', `/api/thing/${id}`)
      assert.equal(response.status, 200, JSON.stringify(response.json))
      return response.json.thing as Json
    }
    const v4 = async (className: string): Promise<Map<number, Json>> => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        await db.query('SET LOCAL ROLE city_snapshot_export')
        const rows = (await db.query<{ record_id: string; payload: Json }>(`
          SELECT record_id, payload FROM city_snapshot.public_records_v4 WHERE class_name = $1
        `, [className])).rows
        return new Map(rows.map(row => [Number(row.record_id), row.payload]))
      } finally {
        await db.query('ROLLBACK')
      }
    }
    const footprint = async () => (await db.query(`
      SELECT
        (SELECT coalesce(max(id), 0) FROM events)::bigint AS last_event,
        (SELECT count(*) FROM events)::int AS events,
        (SELECT count(*) FROM thing_ending_changes)::int AS ending_changes,
        (SELECT count(*) FROM active_labels)::int AS labels,
        (SELECT count(*) FROM wake_tries)::int AS wake_tries,
        (SELECT md5(string_agg(row_to_json(thing)::text, '|' ORDER BY thing.id)) FROM things thing) AS things
    `)).rows[0] as Json

    await t.test('the thing read carries every state of the full ending object beside on_use', async () => {
      await reset()
      const { things } = fixture
      for (const [name, status] of Object.entries(EXPECTED_STATUS)) {
        const read = await readThing(things[name as keyof typeof things])
        const ending = read.ending as Json
        assert.equal(ending.status, status, name)
        assert.equal(ending.remains, 'remnant', name)
        assert.equal(typeof ending.checked_at, 'string', name)
        assert.equal(Object.hasOwn(ending, 'end_program_summary'), false, `${name}: the summary is a sibling of ending`)
        const keys = Object.keys(read)
        assert.deepEqual(keys.slice(keys.indexOf('on_use')), ['on_use', 'ending', 'end_program_summary'], name)
      }
      const active = (await readThing(things.active)).ending as Json
      assert.equal(active.uses_left, 3)
      assert.equal(active.label, 'spent')
      assert.deepEqual(active.set_by, { id: FIVE_STATES_RESIDENTS.maker.id, handle: FIVE_STATES_RESIDENTS.maker.handle })
      assert.deepEqual(active.program, {
        state: 'none', result: null, has_end_trait: true, would_run: false, blocked_by: ['in_sale'],
      })
      const remnant = (await readThing(things.remnant)).ending as Json
      assert.equal(remnant.ended_cause, 'at')
      assert.deepEqual((remnant.copy_origin as Json).source_thing_id, things.active)
      assert.deepEqual(remnant.program, {
        state: 'pending', result: null, has_end_trait: true, would_run: false, blocked_by: ['visitors_not_waking'],
      })
      assert.deepEqual(((await readThing(things.ran)).ending as Json).program, {
        state: 'ran', result: { effects_applied: 0 }, has_end_trait: true, would_run: null, blocked_by: null,
      })
      for (const [name, gate] of [
        ['wakeOff', 'wake_off'], ['carried', 'carried'], ['visiting', 'visitors_not_waking'],
        ['blocked', 'visitors_not_waking'], ['retiredRoom', 'room_retired'],
      ] as const) {
        const program = ((await readThing(things[name])).ending as Json).program as Json
        assert.equal(program.would_run, false, name)
        assert.deepEqual(program.blocked_by, [gate], name)
      }
      assert.deepEqual(((await readThing(things.unset)).ending as Json).program,
        { state: 'none', result: null, has_end_trait: true, would_run: true, blocked_by: [] })

      // The sentence: a lamp names its end trait; a plain stone has no end program.
      assert.match(String((await readThing(things.active)).end_program_summary), /end-glow's end steps once\.$/u)
      assert.equal((await readThing(things.notPermitted)).end_program_summary, 'When this ends it becomes a remnant.')
      assert.equal(typeof (await readThing(things.active)).on_use, 'string')
    })

    await t.test('a due or ended thing reads no current labels while its label rows stay', async () => {
      await reset()
      const { things } = fixture
      const rows = async () => (await db.query<{ target_id: number; count: number }>(`
        SELECT target_id, count(*)::int AS count FROM active_labels
        WHERE target_type = 'thing' AND target_id = ANY($1::int[]) GROUP BY target_id ORDER BY target_id
      `, [[things.due, things.remnant]])).rows
      const before = await rows()
      assert.deepEqual(before.map(row => row.count), [1, 1])
      for (const id of [things.due, things.remnant, things.ran]) {
        const read = await readThing(id)
        assert.deepEqual(read.labels, [], String(id))
        assert.equal(read.labels_total, 0, String(id))
      }
      assert.deepEqual(await rows(), before, 'the label rows stay')
      // A thing whose end is still to come keeps its labels.
      const active = await readThing(things.active)
      assert.deepEqual((active.labels as Json[]).map(entry => entry.label), ['bright'])
      assert.equal(active.labels_total, 1)
      const unset = await readThing(things.unset)
      assert.deepEqual((unset.labels as Json[]).map(entry => entry.label), ['shiny'])
    })

    await t.test('reading every thing writes nothing and records no end', async () => {
      await reset()
      const before = await footprint()
      for (const id of Object.values(fixture.things)) await readThing(id)
      assert.deepEqual(await footprint(), before)
      assert.equal((await db.query('SELECT ended_at FROM things WHERE id = $1', [fixture.things.due])).rows[0]!.ended_at, null)
    })

    const assertParity = async (label: string) => {
      const exported = await v4('things')
      for (const [name, id] of Object.entries(fixture.things)) {
        const live = await readThing(id)
        const row = exported.get(id)
        assert.ok(row, `${label} ${name}: exported`)
        assert.deepEqual(withoutCheckedAt(live.ending), withoutCheckedAt(row.ending), `${label} ${name}: ending`)
        assert.deepEqual(live.labels_total, row.labels_total, `${label} ${name}: labels_total`)
        if ((live.labels as unknown[]).length === 0) assert.deepEqual(row.labels, [], `${label} ${name}: labels`)
      }
      const offers = await v4('world_market_offers')
      for (const offerId of Object.values(fixture.offers)) {
        const response = await call(app, null, 'GET', `/api/world/offer/${offerId}`)
        assert.equal(response.status, 200, JSON.stringify(response.json))
        const offer = response.json.offer as Json
        assert.equal(offer.phase, offers.get(offerId)?.phase, `${label} offer ${offerId}: phase`)
        assert.equal(offer.asset_state, offers.get(offerId)?.asset_state, `${label} offer ${offerId}: asset_state`)
      }
    }

    await t.test('snapshot v4 says what the thing read says, for every thing in the fixture', async () => {
      await reset()
      await assertParity('shown kind')
    })

    await t.test('a maintainer-hidden kind reads the same in the thing read and in v4', async () => {
      await reset()
      await db.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('kind', $1, 'remove', 1, 'thing read test')
      `, [fixture.kinds.lamp])
      await assertParity('hidden kind')
      const active = await readThing(fixture.things.active)
      const ending = active.ending as Json
      assert.equal(ending.label, MODERATED_TEXT)
      assert.deepEqual((ending.grant as Json & { limits: Json }).limits.labels, [MODERATED_TEXT])
      assert.equal((ending.conditions as Json[]).find(condition => 'label_added' in condition)?.label_added, MODERATED_TEXT)
      assert.equal(active.end_program_summary, null, 'a hidden kind names none of its traits')
      assert.equal(active.kind, MODERATED_TEXT)
      assert.doesNotMatch(JSON.stringify(active), /"spent"/u)
    })

    await t.test('a thing_ended in a quiet room reaches the human views exactly as a thing_edited does (#75)', async () => {
      await reset()
      const { rooms, things } = fixture
      await db.query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.visitors])
      const edited = Number((await db.query(`
        INSERT INTO events (kind, actor, detail)
        VALUES ('thing_edited', $1, jsonb_build_object('thing_id', $2::integer, 'place_id', $3::integer))
        RETURNING id
      `, [FIVE_STATES_RESIDENTS.maker.handle, things.remnant, rooms.visitors])).rows[0]!.id)
      const ended = fixture.endedEventIds[0]!
      const stored = (await db.query(`SELECT detail FROM events WHERE id = $1`, [ended])).rows[0]!.detail as Json
      assert.equal(stored.place_id, rooms.visitors, 'the remnant ended in the quiet room')

      const window = await call(app, null, 'GET', '/api/window')
      assert.equal(window.status, 200, JSON.stringify(window.json).slice(0, 400))
      const events = window.json.events as Json[]
      const shownEdited = events.find(event => Number(event.id) === edited)
      const shownEnded = events.find(event => Number(event.id) === ended)
      assert.ok(shownEdited && shownEnded, 'both reach the window, which hides a quiet room by its place')
      assert.equal((shownEnded.detail as Json).place_id, (shownEdited.detail as Json).place_id)
      assert.equal((shownEnded.detail as Json).thing_id, (shownEdited.detail as Json).thing_id)
      assert.equal(findPlace(window.json.places, rooms.visitors)?.quiet, true, 'and the window says the room is quiet')
    })
  } finally {
    await postgres.stop()
  }
})
