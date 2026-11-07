// Thing endings on the public lists (T16), against real PostgreSQL on the full
// db/schema.sql, the five-states fixture and the real routes. Every public list row that
// names a thing carries the short status, key ends: left out when no end is set and the
// thing never ended, {"state": "set", "at": soonest known end} while an end is set, and
// {"state": "ended", "at": ...} once the end has come, recorded or only due. The place
// read keeps counting remnants as items and adds a live remnant count; a drawing read of
// a remnant shows its stored presentation exactly and writes no revision; no list writes.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { call, type CityApp, type Json } from '../helpers/abilities-fixtures.ts'
import { connectedDatabase, startNoteSuiteDatabase } from '../helpers/note-suite-fixtures/postgres.ts'
import { seedFiveStates, type FiveStatesFixture } from '../helpers/thing-endings-fixtures/five-states.ts'
import { placeRemnantCountSql } from '../../src/thing-ending-short.ts'

const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

type Ends = Readonly<{ state: 'set' | 'ended'; at: string | null }>

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString()
}

function byId(rows: unknown): Map<number, Json> {
  assert.ok(Array.isArray(rows), 'a list of rows')
  return new Map((rows as Json[]).map(row => [Number(row.id), row]))
}

function findPlace(places: unknown, id: number): Json | null {
  if (!Array.isArray(places)) return null
  for (const place of places as Json[]) {
    if (Number(place.id) === id) return place
    const child = findPlace(place.children, id)
    if (child) return child
  }
  return null
}

test('thing endings on the public lists, against PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-lists')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await db.query(schemaDdl)
    const fixture: FiveStatesFixture = await seedFiveStates(db)
    const { things, rooms } = fixture
    await db.query('UPDATE places SET front_matter_thing_ids = $2::integer[] WHERE id = $1', [
      rooms.home, [things.active, things.ran, things.unset],
    ])
    const continent = Number((await db.query('SELECT parent_id FROM places WHERE id = $1', [rooms.home])).rows[0]!.parent_id)

    // The expected short status, worked out here from the stored columns.
    const stored = new Map((await db.query(`
      SELECT id, ended_at, ending_deadline, ending_idle_anchor, ending_idle_seconds FROM things
    `)).rows.map(row => [Number(row.id), row]))
    const column = (id: number, name: string) => stored.get(id)![name]
    const timedIdle = new Date(Date.parse(iso(column(things.activeTimed, 'ending_idle_anchor')))
      + Number(column(things.activeTimed, 'ending_idle_seconds')) * 1000).toISOString()
    const expected: ReadonlyMap<number, Ends | undefined> = new Map<number, Ends | undefined>([
      [things.active, { state: 'set', at: iso(column(things.active, 'ending_deadline')) }],
      [things.activeTimed, { state: 'set', at: [iso(column(things.activeTimed, 'ending_deadline')), timedIdle].sort()[0]! }],
      [things.due, { state: 'ended', at: iso(column(things.due, 'ending_deadline')) }],
      [things.remnant, { state: 'ended', at: iso(column(things.remnant, 'ended_at')) }],
      [things.ran, { state: 'ended', at: iso(column(things.ran, 'ended_at')) }],
      [things.notPermitted, undefined],
      [things.unset, undefined],
      [things.kindlessUnset, undefined],
      [things.kindlessGiven, undefined],
      [things.wakeOff, undefined],
      [things.carried, undefined],
      [things.visiting, undefined],
      [things.blocked, undefined],
    ])
    const assertEnds = (rows: Map<number, Json>, where: string, ids?: readonly number[]) => {
      const checked = ids ?? [...rows.keys()].filter(id => expected.has(id))
      assert.ok(checked.length > 0, `${where}: names at least one fixture thing`)
      for (const id of checked) {
        const row = rows.get(id)
        assert.ok(row, `${where}: thing ${id} is listed`)
        const want = expected.get(id)
        if (want === undefined) {
          assert.equal(Object.hasOwn(row, 'ends'), false, `${where}: thing ${id} carries no ends`)
        } else {
          assert.deepEqual(row.ends, want, `${where}: thing ${id}`)
        }
      }
    }
    const footprint = async () => (await db.query(`
      SELECT
        (SELECT coalesce(max(id), 0) FROM events)::bigint AS last_event,
        (SELECT count(*) FROM thing_ending_changes)::int AS ending_changes,
        (SELECT count(*) FROM drawing_revisions)::int AS drawing_revisions,
        (SELECT count(*) FROM wake_tries)::int AS wake_tries,
        (SELECT md5(string_agg(row_to_json(thing)::text, '|' ORDER BY thing.id)) FROM things thing) AS things
    `)).rows[0] as Json
    const before = await footprint()

    await t.test('place thing rows carry ends in the outline, the full view and a byte-limited page', async () => {
      for (const query of ['thing_limit=50', 'view=full&thing_limit=50', 'view=full&thing_limit=50&thing_text_limit_bytes=100000']) {
        const response = await call(app, null, 'GET', `/api/place/${rooms.home}?${query}`)
        assert.equal(response.status, 200, JSON.stringify(response.json))
        const rows = byId(response.json.things)
        assertEnds(rows, `home ${query}`, [
          things.active, things.activeTimed, things.due, things.ran, things.unset, things.notPermitted,
        ])
      }
      const visitors = await call(app, null, 'GET', `/api/place/${rooms.visitors}`)
      assert.equal(visitors.status, 200)
      assertEnds(byId(visitors.json.things), 'visitors', [things.remnant, things.visiting])
    })

    await t.test('the place count keeps remnants as items and adds a live remnant count', async () => {
      const visitors = (await call(app, null, 'GET', `/api/place/${rooms.visitors}`)).json.things_page as Json
      assert.equal(visitors.total_items, 2, 'the remnant is still an item')
      assert.equal(visitors.remnant_items, 1)
      // The home room holds one due lamp, not yet recorded, and one recorded remnant.
      const home = (await call(app, null, 'GET', `/api/place/${rooms.home}?view=full&thing_text_limit_bytes=100000`)).json.things_page as Json
      assert.equal(home.total_items, 11)
      assert.equal(home.remnant_items, 2)
    })

    await t.test('the recorded half of the remnant count reads the things_remnant index', async () => {
      // Sequential scans are switched off so the small fixture table shows which index the
      // count can use; on a busy room the planner picks it on cost alone.
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL enable_seqscan = off')
        const plan = (await client.query(`EXPLAIN SELECT ${placeRemnantCountSql('$1::integer')} AS n`, [rooms.home]))
          .rows.map(row => String(row['QUERY PLAN'])).join('\n')
        assert.match(plan, /\bthings_remnant\b/u, plan)
        const counted = (await client.query(`SELECT ${placeRemnantCountSql('$1::integer')} AS n`, [rooms.home])).rows[0]!
        assert.equal(Number(counted.n), 2, 'the index changes no count')
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    })

    await t.test('front matter carries ends on the place read and both map reads', async () => {
      const place = await call(app, null, 'GET', `/api/place/${rooms.home}`)
      const frontMatter = byId(place.json.front_matter)
      assert.deepEqual([...frontMatter.keys()], [things.active, things.ran, things.unset])
      assertEnds(frontMatter, 'place front matter')

      const outline = await call(app, null, 'GET', `/api/map?view=outline&parent_id=${continent}`)
      assert.equal(outline.status, 200, JSON.stringify(outline.json))
      const home = (outline.json.subplaces as Json[]).find(row => Number(row.id) === rooms.home)
      assert.ok(home, 'the home room is an outline subplace')
      assertEnds(byId(home.front_matter), 'map outline front matter')

      const map = await call(app, null, 'GET', '/api/map?view=full')
      assert.equal(map.status, 200)
      const mapHome = findPlace(map.json.places, rooms.home)
      assert.ok(mapHome, 'the home room is on the map')
      assertEnds(byId(mapHome.front_matter), 'map front matter')
    })

    await t.test('search hits carry ends', async () => {
      const response = await call(app, null, 'GET', '/api/search?q=lamp&type=thing&limit=50')
      assert.equal(response.status, 200, JSON.stringify(response.json))
      const items = response.json.items ?? response.json.results
      assertEnds(byId(items), 'search', [
        things.active, things.activeTimed, things.due, things.remnant, things.ran, things.unset,
      ])
    })

    await t.test('a drawing read and its history carry ends and show the stored presentation', async () => {
      const remnant = await call(app, null, 'GET', `/api/drawing/thing/${things.remnant}`)
      assert.equal(remnant.status, 200, JSON.stringify(remnant.json))
      assert.deepEqual(remnant.json.ends, expected.get(things.remnant))
      const active = await call(app, null, 'GET', `/api/drawing/thing/${things.active}`)
      assert.deepEqual(active.json.ends, expected.get(things.active))
      // A lamp with no end, of the same kind and revision, shows the same presentation.
      const plain = await call(app, null, 'GET', `/api/drawing/thing/${things.unset}`)
      assert.equal(plain.status, 200)
      assert.equal(Object.hasOwn(plain.json, 'ends'), false)
      const { ends: _ends, id: _remnantId, ...remnantDrawing } = remnant.json
      const { id: _plainId, ...plainDrawing } = plain.json
      assert.deepEqual(remnantDrawing, plainDrawing)

      for (const id of [things.remnant, things.due]) {
        const history = await call(app, null, 'GET', `/api/drawing/thing/${id}/history`)
        assert.equal(history.status, 200, JSON.stringify(history.json))
        assert.deepEqual(history.json.ends, expected.get(id))
      }
      const plainHistory = await call(app, null, 'GET', `/api/drawing/thing/${things.unset}/history`)
      assert.equal(Object.hasOwn(plainHistory.json, 'ends'), false)
    })

    await t.test('no list writes anything', async () => {
      assert.deepEqual(await footprint(), before)
    })
  } finally {
    await postgres.stop()
  }
})
