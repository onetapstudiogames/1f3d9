// Thing endings on the reader's own answers and every outline (T17a), against real
// PostgreSQL on the full db/schema.sql, the five-states fixture and the real routes.
// me carries the short status, key ends, on its owned things (carried ones included)
// and its open offers, and a live remnant count beside each place's thing count; the
// held gifts in settings carry it; a hidden outline (hidden=outline, a direct read of a
// muted thing, a maintainer-removed thing) and a focus outline carry it; the window's
// place rows and front matter carry it. No read writes anything.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

const SECRETS = Object.freeze({
  maker: `1f3d9_sk_${'2'.repeat(48)}`,
  visitor: `1f3d9_sk_${'3'.repeat(48)}`,
  buyer: `1f3d9_sk_${'5'.repeat(48)}`,
})

type Ends = Readonly<{ state: 'set' | 'ended'; at: string | null }>

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString()
}

function byId(rows: unknown, field = 'id'): Map<number, Json> {
  assert.ok(Array.isArray(rows), 'a list of rows')
  return new Map((rows as Json[]).map(row => [Number(row[field]), row]))
}

test('thing endings on me, gifts, outlines and the window, against PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-me')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await db.query(schemaDdl)
    const fixture: FiveStatesFixture = await seedFiveStates(db)
    const { things, rooms, offers } = fixture
    const { maker, visitor, buyer } = FIVE_STATES_RESIDENTS
    for (const [id, secret] of [[maker.id, SECRETS.maker], [visitor.id, SECRETS.visitor], [buyer.id, SECRETS.buyer]] as const) {
      await db.query('UPDATE residents SET secret_hash = $2 WHERE id = $1', [
        id, createHash('sha256').update(secret, 'utf8').digest('hex'),
      ])
    }
    // Nobody stands anywhere, so me settles no room and records nothing.
    await db.query('DELETE FROM resident_presence')

    // The carried lamp becomes a carried remnant: its date passed, and its end is recorded.
    await db.query(`
      UPDATE things SET ending_rule = jsonb_build_object('any', jsonb_build_array(
          jsonb_build_object('at', to_char((now() - interval '2 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))),
        ending_grant = (SELECT ending_grant FROM things WHERE id = $2),
        ending_set_by = owner_id, ending_set_at = now() - interval '3 hours',
        ending_deadline = date_trunc('milliseconds', now() - interval '2 hours')
      WHERE id = $1
    `, [things.carried, things.active])
    await db.query(`
      UPDATE things SET ended_at = thing_end_due_at(id), ended_cause = 'at',
        ended_owner_id = owner_id, end_program_state = 'pending'
      WHERE id = $1
        AND (SELECT set_config('city.ending_writer', 'record:' || $1::text, true)) IS NOT NULL
    `, [things.carried])

    // Two things the buyer made and owns in the home room, one ending and one ended, so a
    // reader that mutes the buyer has them hidden (things a founder made never are).
    const buyerThing = async (name: string): Promise<number> => Number((await db.query(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision)
      VALUES ($1, $2, $3, $4, $4, $5, 1, 1) RETURNING id
    `, [rooms.home, name, `the body of ${name}`, buyer.id, fixture.kinds.lamp])).rows[0]!.id)
    const buyerActive = await buyerThing('buyer lamp')
    const buyerDue = await buyerThing('buyer due lamp')
    const buyerRemoved = await buyerThing('buyer removed lamp')
    for (const [id, offset] of [[buyerActive, '5 days'], [buyerDue, '-10 minutes'], [buyerRemoved, '4 days']] as const) {
      await db.query(`
        UPDATE things SET ending_rule = jsonb_build_object('any', jsonb_build_array(
            jsonb_build_object('at', to_char((now() + $2::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))),
          ending_grant = (SELECT ending_grant FROM things WHERE id = $3),
          ending_set_by = owner_id, ending_set_at = now() - interval '1 hour',
          ending_deadline = date_trunc('milliseconds', now() + $2::interval)
        WHERE id = $1
      `, [id, offset, things.active])
    }
    await db.query(`
      INSERT INTO moderation_actions (target_type, target_id, action, reason, actor_id)
      VALUES ('thing', $1, 'remove', 'a removal for the outline test', 1)
    `, [buyerRemoved])

    // Held gifts from the maker to the visitor: one with an end set, one whose end came,
    // one with no end, and a kind.
    for (const [type, id] of [['thing', things.active], ['thing', things.due], ['thing', things.unset], ['kind', fixture.kinds.stone]] as const) {
      await db.query(`
        INSERT INTO waiting_transfers (giver_id, recipient_id, asset_type, asset_id) VALUES ($1, $2, $3, $4)
      `, [maker.id, visitor.id, type, id])
    }

    const stored = new Map((await db.query(`
      SELECT id, ended_at, ending_deadline, ending_idle_anchor, ending_idle_seconds FROM things
    `)).rows.map(row => [Number(row.id), row]))
    const column = (id: number, name: string) => stored.get(id)![name]
    const timedIdle = new Date(Date.parse(iso(column(things.activeTimed, 'ending_idle_anchor')))
      + Number(column(things.activeTimed, 'ending_idle_seconds')) * 1000).toISOString()
    const expected = new Map<number, Ends | undefined>([
      [things.active, { state: 'set', at: iso(column(things.active, 'ending_deadline')) }],
      [things.activeTimed, { state: 'set', at: [iso(column(things.activeTimed, 'ending_deadline')), timedIdle].sort()[0]! }],
      [things.due, { state: 'ended', at: iso(column(things.due, 'ending_deadline')) }],
      [things.remnant, { state: 'ended', at: iso(column(things.remnant, 'ended_at')) }],
      [things.ran, { state: 'ended', at: iso(column(things.ran, 'ended_at')) }],
      [things.carried, { state: 'ended', at: iso(column(things.carried, 'ended_at')) }],
      [buyerActive, { state: 'set', at: iso(column(buyerActive, 'ending_deadline')) }],
      [buyerDue, { state: 'ended', at: iso(column(buyerDue, 'ending_deadline')) }],
      [buyerRemoved, { state: 'set', at: iso(column(buyerRemoved, 'ending_deadline')) }],
      [things.notPermitted, undefined],
      [things.unset, undefined],
      [things.wakeOff, undefined],
      [things.visiting, undefined],
    ])
    const assertEnds = (row: Json | undefined, id: number, where: string) => {
      assert.ok(row, `${where}: thing ${id} is listed`)
      const want = expected.get(id)
      if (want === undefined) assert.equal(Object.hasOwn(row, 'ends'), false, `${where}: thing ${id} carries no ends`)
      else assert.deepEqual(row.ends, want, `${where}: thing ${id}`)
    }
    const footprint = async () => (await db.query(`
      SELECT
        (SELECT coalesce(max(id), 0) FROM events)::bigint AS last_event,
        (SELECT count(*) FROM thing_ending_changes)::int AS ending_changes,
        (SELECT count(*) FROM wake_tries)::int AS wake_tries,
        (SELECT md5(string_agg(row_to_json(thing)::text, '|' ORDER BY thing.id)) FROM things thing) AS things
    `)).rows[0] as Json
    const before = await footprint()

    await t.test('me carries ends on owned things, a carried remnant included, and on open offers', async () => {
      const me = await call(app, SECRETS.maker, 'GET', '/api/me?thing_limit=50&offer_limit=50')
      assert.equal(me.status, 200, JSON.stringify(me.json))
      const owned = byId(me.json.things)
      for (const id of [things.active, things.activeTimed, things.due, things.remnant, things.ran, things.carried, things.unset, things.notPermitted]) {
        assertEnds(owned.get(id), id, 'me things')
      }
      const offerRows = byId(me.json.offers)
      assert.deepEqual(offerRows.get(offers.active)?.ends, expected.get(things.active))
      assert.deepEqual(offerRows.get(offers.due)?.ends, expected.get(things.due))
    })

    await t.test('me counts remnants live beside each place thing count', async () => {
      const me = await call(app, SECRETS.maker, 'GET', '/api/me?place_limit=50')
      assert.equal(me.status, 200, JSON.stringify(me.json))
      const places = byId(me.json.places)
      // The home room keeps every thing as an item; its remnants are the due lamp, the
      // spent lamp, the carried lamp and the buyer's due lamp.
      assert.equal(places.get(rooms.home)?.thing_count, 14)
      assert.equal(places.get(rooms.home)?.remnant_count, 4)
      assert.equal(places.get(rooms.retired)?.remnant_count, 0)
    })

    await t.test('held gifts in settings carry ends on things only', async () => {
      const answer = await call(app, SECRETS.visitor, 'GET', '/api/me/settings')
      assert.equal(answer.status, 200, JSON.stringify(answer.json))
      const waiting = (answer.json.waiting_transfers as Json).oldest as Json[]
      assert.equal(waiting.length, 4)
      const thingsWaiting = byId(waiting.filter(row => row.type === 'thing'), 'asset_id')
      for (const id of [things.active, things.due, things.unset]) assertEnds(thingsWaiting.get(id), id, 'waiting')
      const kindRow = waiting.find(row => row.type === 'kind')
      assert.equal(Object.hasOwn(kindRow!, 'ends'), false)
    })

    await t.test('a hidden outline carries ends', async () => {
      const muted = await call(app, SECRETS.visitor, 'PATCH', '/api/me/settings', { mute: { type: 'resident', id: buyer.id } })
      assert.equal(muted.status, 200, JSON.stringify(muted.json))
      const place = await call(app, SECRETS.visitor, 'GET', `/api/place/${rooms.home}?view=full&thing_limit=50&hidden=outline`)
      assert.equal(place.status, 200, JSON.stringify(place.json))
      const hidden = byId((place.json.hidden_items as Json[]).filter(row => row.type === 'thing'))
      assert.deepEqual([...hidden.keys()].sort((a, b) => a - b), [buyerActive, buyerDue, buyerRemoved])
      for (const id of [buyerActive, buyerDue, buyerRemoved]) assertEnds(hidden.get(id), id, 'hidden outline')
      // A maintainer-removed thing's outline names nobody and still carries its end.
      assert.equal(hidden.get(buyerRemoved)?.author, null)
      assert.deepEqual(Object.keys(hidden.get(buyerActive)!).sort(),
        ['author', 'date', 'ends', 'id', 'kind', 'place_id', 'size', 'type'])
      // A direct read of the muted thing sends that outline, ends included.
      const direct = await call(app, SECRETS.visitor, 'GET', `/api/thing/${buyerDue}`)
      assert.equal(direct.status, 200, JSON.stringify(direct.json))
      assertEnds(direct.json.thing as Json, buyerDue, 'direct muted read')
      assert.equal(Object.hasOwn(direct.json.thing as Json, 'name'), false)
    })

    await t.test('a focus outline carries ends', async () => {
      const focus = await call(app, SECRETS.buyer, 'PATCH', '/api/me/settings', { focus_mode: true })
      assert.equal(focus.status, 200, JSON.stringify(focus.json))
      const place = await call(app, SECRETS.buyer, 'GET', `/api/place/${rooms.home}?view=full&thing_limit=50`)
      assert.equal(place.status, 200, JSON.stringify(place.json))
      assert.equal((place.json.reading as Json).focus_mode, true)
      const rows = byId(place.json.things)
      for (const id of [things.active, things.due, things.ran, things.carried, buyerActive, buyerDue, things.unset]) {
        const row = rows.get(id)
        assertEnds(row, id, 'focus outline')
        assert.equal(Object.hasOwn(row!, 'body'), false, `focus outline ${id} sends no body`)
      }
    })

    await t.test('the window place rows and front matter carry ends', async () => {
      await db.query('UPDATE places SET front_matter_thing_ids = $2::integer[] WHERE id = $1', [
        rooms.home, [things.active, things.ran, things.unset],
      ])
      for (const presentation of ['', '&presentation=headings']) {
        const history = await call(app, null, 'GET', `/api/window?collection=things&place_id=${rooms.home}&limit=50${presentation}`)
        assert.equal(history.status, 200, JSON.stringify(history.json))
        const rows = byId(history.json.things ?? history.json.items)
        for (const id of [things.active, things.activeTimed, things.due, things.ran, things.carried, things.unset]) {
          assertEnds(rows.get(id), id, `window things${presentation}`)
        }
      }
      const snapshot = await call(app, null, 'GET', '/api/window')
      assert.equal(snapshot.status, 200)
      const find = (places: unknown): Json | undefined => {
        for (const place of (Array.isArray(places) ? places : []) as Json[]) {
          if (Number(place.id) === rooms.home) return place
          const child = find(place.children)
          if (child) return child
        }
        return undefined
      }
      const home = find(snapshot.json.places)
      assert.ok(home, 'the home room is in the window snapshot')
      const headings = byId(home.front_matter)
      for (const id of [things.active, things.ran, things.unset]) assertEnds(headings.get(id), id, 'window front matter')
    })

    await t.test('no read writes anything', async () => {
      assert.deepEqual(await footprint(), before)
    })
  } finally {
    await postgres.stop()
  }
})
