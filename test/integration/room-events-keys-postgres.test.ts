// One room's events history (GET /api/events with place_id or within_place_id) through the
// room keys index, against real PostgreSQL on the full db/schema.sql and the five-states
// fixture. The read must answer exactly as today's statement, frozen from main before the
// room keys (test/helpers/room-events-oracle), at every moment: rows, order and all four
// totals, for every one-room shape, before and after things move, are withdrawn or end,
// notes and lines are removed and restored, offers come and go, rooms are moderated, the
// room tree changes and feed rooms change. It also proves the key function cannot refuse
// any detail an event can store, the migrations' order and recovery, and that both parts
// of the statement use the index at a seeded size.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  applyMigration,
  EVENTS_ROOM_KEYS_INDEX_STATE_QUERY,
} from '../../scripts/migrate.ts'
import { connectedDatabase, startNoteSuiteDatabase } from '../helpers/note-suite-fixtures/postgres.ts'
import { seedFiveStates } from '../helpers/thing-endings-fixtures/five-states.ts'
import { seedRoomEventsBenchmark } from '../helpers/room-events-benchmark/seed.ts'
import { budgetedExactStatement } from '../../src/public-exact-query.ts'
import {
  loadPublicEventCollectionRows,
  loadPublicEventPageRows,
  type PublicEventFilters,
  type PublicPage,
} from '../../src/public-pagination.ts'

const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const functionMigration = await readFile(new URL('../../db/migrations/20261124_event_room_keys_function.sql', import.meta.url), 'utf8')
const indexMigration = await readFile(new URL('../../db/migrations/20261124_events_room_keys_index.sql', import.meta.url), 'utf8')
const oracle = JSON.parse(await readFile(new URL('../helpers/room-events-oracle/main-af009f2.json', import.meta.url), 'utf8')) as
  { statements: Record<string, string> }

type Row = Record<string, unknown>
const FOUNDER = 1

async function one(text: string, values: unknown[] = []): Promise<number> {
  return Number((await connectedDatabase().query(text, values)).rows[0]!.id)
}

const event = (kind: string, detail: unknown, actor = 'ending-maker', at: string | null = null) => one(
  `INSERT INTO events (kind, actor, detail, at) VALUES ($1, $2, $3::jsonb, coalesce($4::timestamptz, now())) RETURNING id`,
  [kind, actor, JSON.stringify(detail), at])

const room = (parentId: number, name: string) => one(`INSERT INTO places
  (parent_id, place_kind, name, description, owner_id, open_to_notes, open_to_things)
  VALUES ($1, 'place', $2, 'a room for room reads', 2, TRUE, TRUE) RETURNING id`, [parentId, name])

const thing = (placeId: number, name: string) => one(`INSERT INTO things (place_id, name, body, owner_id, maker_id)
  VALUES ($1, $2, 'a thing for room reads', 2, 2) RETURNING id`, [placeId, name])

const note = (placeId: number, body: string) => one(
  'INSERT INTO notes (place_id, author_id, body) VALUES ($1, 2, $2) RETURNING id', [placeId, body])

const moderate = (targetType: string, targetId: number, action: 'remove' | 'restore') => connectedDatabase().query(
  `INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason, created_at)
   VALUES ($1, $2, $3, $4, 'room reads test', clock_timestamp())`, [targetType, targetId, action, FOUNDER])

const raw = async (text: string, params: readonly unknown[]): Promise<readonly Row[]> =>
  (await connectedDatabase().query(text, [...params])).rows

type Fixture = Readonly<{
  world: number; continent: number; home: number; square: number; side: number; below: number; corner: number
  feedBelow: number; small: number
  things: Readonly<{ square: number; side: number; below: number; feed: number; home: number; small: number; gone: number }>
  notes: Readonly<{ square: number; corner: number; feed: number; home: number }>
  lineId: number; dueLamp: number
}>

async function seedRoomReads(): Promise<Fixture> {
  const db = connectedDatabase()
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await db.query(schemaDdl)
  const five = await seedFiveStates(db)
  const home = five.rooms.home
  const continent = Number((await db.query('SELECT parent_id FROM places WHERE id = $1', [home])).rows[0]!.parent_id)
  const world = Number((await db.query('SELECT parent_id FROM places WHERE id = $1', [continent])).rows[0]!.parent_id)
  // The square, a feed room and a side room below it, a room below the side room and a
  // corner below that: two levels and more under the square.
  const square = await room(continent, 'Reading Square')
  const feedBelow = await room(square, 'Square Feed')
  await db.query('UPDATE places SET quiet = TRUE, feed = TRUE WHERE id = $1', [feedBelow])
  const side = await room(square, 'Square Side')
  const below = await room(side, 'Below The Side')
  const corner = await room(below, 'Far Corner')
  const small = await room(continent, 'Small Room')
  const things = {
    square: await thing(square, 'square lamp'),
    side: await thing(side, 'side cup'),
    below: await thing(below, 'below box'),
    feed: await thing(feedBelow, 'feed card'),
    home: await thing(home, 'home stone'),
    small: await thing(small, 'small bell'),
    gone: await thing(square, 'gone thing'),
  }
  await db.query('UPDATE things SET withdrawn_at = now() WHERE id = $1', [things.gone])
  const notes = {
    square: await note(square, 'a square note'),
    corner: await note(corner, 'a corner note'),
    feed: await note(feedBelow, 'a feed note'),
    home: await note(home, 'a home note'),
  }
  const lineId = 7101
  const offerOnPlace = await one(`INSERT INTO transfer_offers (channel, asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet)
    VALUES ('direct', 'place', $1, 2, 3, 4, '0x' || repeat('c', 40)) RETURNING id`, [side])
  const offerOnThing = await one(`INSERT INTO transfer_offers (channel, asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet)
    VALUES ('direct', 'thing', $1, 2, 3, 2, '0x' || repeat('d', 40)) RETURNING id`, [things.side])
  const outcome = (placeId: unknown, extra: Row = {}) => ({
    actor: 'ending-maker', operation: 'move', target_type: 'thing', target_id: things.square, place_id: placeId, ...extra,
  })
  const old = "now() - interval '3 hours'"
  const at = String((await db.query(`SELECT (${old})::text AS at`)).rows[0]!.at)
  // Every detail shape a one-room read matches, in the square, below it, in its feed room,
  // in other rooms, and odd shapes that must match nothing.
  const details: Array<readonly [string, unknown, string | null]> = [
    ['action', { applied_public_activity: [outcome(square)] }, at],
    ['action', { applied_public_activity: [outcome(String(square))] }, null],
    ['action', { applied_public_activity: [outcome(feedBelow)] }, null],
    ['action', { applied_public_activity: [outcome(feedBelow, { target_type: 'place', operation: 'rename' })] }, null],
    ['action', { applied_public_activity: [outcome(below), outcome(home)] }, null],
    ['action', { applied_public_activity: [outcome(corner, { target_id: things.below })] }, at],
    ['action', { applied_public_activity: [outcome(side, { actor: 'Not A Handle' })] }, null],
    // The city refuses odd outcome lists on activity kinds; any other kind may store one.
    ['rare_kind', { applied_public_activity: [7, 'x', null, [square], { place_id: null }, outcome(`0${square}`)] }, null],
    ['rare_kind', { applied_public_activity: { place_id: square } }, null],
    ['rare_kind', { applied_public_activity: [outcome(square), outcome(corner)] }, null],
    ['effect_resolved', { applied_public_activity: [outcome(square, { target_type: 'place', target_id: square })] }, null],
    ['note', { note_id: notes.square, place_id: square, body: 'said in the square' }, null],
    ['note', { note_id: notes.corner, place_id: corner, body: 'said in the corner' }, at],
    ['note', { note_id: notes.feed, place_id: feedBelow, body: 'said in the feed' }, null],
    ['note', { note_id: String(notes.home), body: 'named by id only' }, null],
    ['note', { note_id: notes.square, body: 'named by id only' }, null],
    ['line_said', { line_id: lineId, place_id: square, body: 'a line in the square' }, null],
    ['line_said', { line_id: lineId + 1, place_id: feedBelow, body: 'a line in the feed' }, null],
    ['ping_sent', { ping_id: 9, place_id: side }, null],
    ['thing_created', { thing_id: things.square, place_id: square }, null],
    ['thing_edited', { thing_id: things.side }, null],
    ['thing_edited', { thing_id: String(things.below) }, null],
    ['thing_edited', { thing_id: `00${things.below}` }, null],
    ['thing_moved', { thing_id: things.home, from_place_id: home, to_place_id: small }, null],
    ['thing_moved', { thing_id: things.feed, from_place_id: square, to_place_id: feedBelow }, at],
    ['thing_withdrawn', { thing_id: things.gone, place_id: square }, null],
    ['thing_edited', { thing_id: things.gone }, null],
    ['transfer', { asset_type: 'thing', asset_id: things.square, reason: 'gift' }, null],
    ['transfer', { asset_type: 'place', asset_id: side, reason: 'sale' }, null],
    ['transfer', { asset_type: 'place', asset_id: String(home) }, null],
    ['transfer', { type: 'thing', id: things.below }, null],
    ['transfer', { type: 'place', id: corner }, null],
    ['offer_made', { offer_id: offerOnPlace }, null],
    ['offer_made', { offer_id: offerOnThing }, null],
    ['offer_made', { offer_id: String(offerOnThing), asset_type: 'thing' }, null],
    ['place_edited', { place_id: side, hinge_to: square }, null],
    ['place_edited', { place_id: home, hinge_to: String(corner) }, null],
    ['place_created', { place_id: small }, null],
    ['note', { place_id: small, body: 'small talk' }, null],
    ['rare_kind', { place_id: `${square}.0`, thing_id: '3.0', note_id: -1, offer_id: '1234567890' }, null],
    ['rare_kind', { place_id: '99999999999', from_place_id: 'x'.repeat(5000), to_place_id: 'éé' }, null],
    ['rare_kind', { place_id: { id: square }, thing_id: [things.square], asset_type: 'thing', asset_id: null }, null],
    ['rare_kind', { body: 'nothing about any room' }, null],
  ]
  for (const [kind, detail, when] of details) await event(kind, detail, 'ending-maker', when)
  return Object.freeze({
    world, continent, home, square, side, below, corner, feedBelow, small, things, notes, lineId,
    dueLamp: five.things.due,
  })
}

function shapes(fixture: Fixture, ids: readonly number[]): ReadonlyArray<readonly [string, PublicEventFilters, PublicPage]> {
  const base: PublicEventFilters = { kind: null, actor: null, placeId: null, includeDescendants: false, withinSeconds: null, afterId: null }
  const pageOf = (cursor: number | null, limit: number): PublicPage => ({ ok: true, cursor, limit, fetchLimit: limit + 1 })
  const at = (share: number): number => ids[Math.floor(ids.length * share)]!
  const middle = at(1 / 2)
  const early = at(1 / 5)
  const late = at(4 / 5)
  // Every shape for the square and the side room (rooms below both); the main shapes for
  // a room below, the feed room, rooms elsewhere and a room that does not exist; and the
  // big rooms, the continent and the world, with the kinds they hold.
  const full = [fixture.square, fixture.side]
  const big = [fixture.continent, fixture.world]
  const rooms = [...full, ...big, fixture.below, fixture.feedBelow, fixture.home, fixture.small, 2_000_000_001]
  const out: Array<readonly [string, PublicEventFilters, PublicPage]> = []
  for (const placeId of rooms) {
    const every = full.includes(placeId)
    const kinds = every ? [null, 'action', 'note'] : big.includes(placeId) ? [null, 'action', 'note', 'rare_kind'] : [null, 'note']
    for (const includeDescendants of [false, true]) {
      for (const kind of kinds) {
        const filters = { ...base, placeId, includeDescendants, kind }
        const name = `${includeDescendants ? 'within_place_id' : 'place_id'}=${placeId} kind=${kind}`
        out.push([name, filters, pageOf(null, 50)])
        out.push([`${name} limit=2`, filters, pageOf(null, 2)])
        out.push([`${name} before_id`, filters, pageOf(middle, 50)])
        out.push([`${name} after_id before_id`, { ...filters, afterId: early }, pageOf(late, 3)])
        if (every || big.includes(placeId)) {
          // An actor or a time window, alone or with a kind: one of them can be the cheaper
          // way to start, so each also runs with each way forced.
          out.push([`${name} within_seconds`, { ...filters, withinSeconds: 3600 }, pageOf(null, 50)])
          out.push([`${name} within_seconds before_id`, { ...filters, withinSeconds: 3600 }, pageOf(middle, 50)])
          out.push([`${name} actor`, { ...filters, actor: 'ending-maker' }, pageOf(null, 50)])
          out.push([`${name} rare actor`, { ...filters, actor: 'the city' }, pageOf(null, 50)])
          out.push([`${name} rare actor within_seconds`, { ...filters, actor: 'the city', withinSeconds: 3600 }, pageOf(null, 50)])
        }
        if (!every) continue
        out.push([`${name} after_id`, { ...filters, afterId: early }, pageOf(null, 50)])
      }
    }
  }
  return out
}

// The statement picks, per read with a kind, an actor or a time window, between each room
// key's own lookup and one pass over the events those allow (ROOM_KEYS_PASS_RATIO in
// src/public-pagination.ts). Both ways must answer as today, so such a read also runs with
// each way forced.
const RATIO_MARKER = /\/\* room keys pass ratio \*\/ [0-9]+/u
const forcedWays = (text: string): readonly Readonly<{ way: string; text: string }>[] => {
  assert.match(text, RATIO_MARKER, 'a room read states its pass ratio')
  return [
    { way: 'each key', text: text.replace(RATIO_MARKER, '0') },
    { way: 'one pass', text: text.replace(RATIO_MARKER, '1000000000') },
  ]
}

/** Today's statement and the room keys statement, side by side, at the same moment. */
async function assertSameAsToday(fixture: Fixture, moment: string): Promise<number> {
  const ids = (await raw('SELECT id FROM events ORDER BY id', [])).map(row => Number(row.id))
  let matched = 0
  for (const [name, filters, page] of shapes(fixture, ids)) {
    const sent: Array<Readonly<{ text: string; params: readonly unknown[] }>> = []
    const capture = async (text: string, params: readonly unknown[]) => {
      sent.push({ text, params }); return await raw(text, params)
    }
    const counted = await loadPublicEventCollectionRows(capture, filters, page)
    const further = await loadPublicEventPageRows(capture, filters, page)
    assert.equal(sent.length, 2)
    assert.match(sent[0]!.text, /event_room_keys/u, `${moment}: ${name} must use the room keys`)
    const mode = filters.includeDescendants ? 'within' : 'exact'
    const today = await raw(oracle.statements[`${mode}Counted`]!, sent[0]!.params)
    const todayFurther = await raw(oracle.statements[`${mode}Uncounted`]!, sent[1]!.params)
    const now = await raw(sent[0]!.text, sent[0]!.params)
    assert.deepEqual(now, today, `${moment}: ${name} answers as today`)
    assert.deepEqual(await raw(sent[1]!.text, sent[1]!.params), todayFurther, `${moment}: ${name} further page answers as today`)
    if (filters.kind != null || filters.actor != null || filters.withinSeconds != null) {
      for (const { way, text } of forcedWays(sent[0]!.text)) {
        assert.deepEqual(await raw(text, sent[0]!.params), today, `${moment}: ${name} through ${way} answers as today`)
      }
      for (const { way, text } of forcedWays(sent[1]!.text)) {
        assert.deepEqual(await raw(text, sent[1]!.params), todayFurther, `${moment}: ${name} further page through ${way} answers as today`)
      }
    }
    assert.equal(counted.total.items, Number(today[0]!.total_items))
    assert.equal(further.length, todayFurther.filter(row => row.id != null).length)
    matched += now.filter(row => row.id != null).length
  }
  return matched
}

test('one room events reads through the room keys index, against PostgreSQL', { timeout: 1_200_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('room-events-keys')
  try {
    const db = connectedDatabase()

    await t.test('the key function never refuses a detail and lists exactly the keys it names', async () => {
      await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await db.query(schemaDdl)
      const keys = async (detail: unknown) => (await db.query<{ keys: string[] }>(
        'SELECT public.event_room_keys($1::jsonb) AS keys', [JSON.stringify(detail)])).rows[0]!.keys
      const sortedKeys = async (detail: unknown) => [...await keys(detail)].sort()
      assert.deepEqual(await keys({}), [])
      assert.deepEqual(await sortedKeys({ place_id: 3, from_place_id: '4', to_place_id: '03', hinge_to: 2147483647 }),
        ['p2147483647', 'p3', 'p4'])
      assert.deepEqual(await sortedKeys({ place_id: '3.0', from_place_id: -3, to_place_id: '0', hinge_to: '12345678901' }), [])
      assert.deepEqual(await sortedKeys({ place_id: 'x'.repeat(100_000), to_place_id: 'é', from_place_id: { a: 1 } }), [])
      assert.deepEqual(await sortedKeys({ applied_public_activity: [{ place_id: 5 }, { place_id: '6' }, 7, 'x', null, [8], { place_id: null }, { place_id: '09' }] }),
        ['p5', 'p6'])
      assert.deepEqual(await sortedKeys({ applied_public_activity: { place_id: 5 } }), [])
      assert.deepEqual(await sortedKeys({ applied_public_activity: 'not a list' }), [])
      assert.deepEqual(await sortedKeys({ thing_id: '007', note_id: 123456789, offer_id: '1234567890' }), ['n123456789', 't7'])
      assert.deepEqual(await sortedKeys({ thing_id: '-1', note_id: '1e3', offer_id: 4.5 }), [])
      assert.deepEqual(await sortedKeys({ asset_type: 'thing', asset_id: 9, type: 'place', id: '10' }), ['p10', 't9'])
      assert.deepEqual(await sortedKeys({ asset_type: 'place', asset_id: '11', type: 'thing', id: 12 }), ['p11', 't12'])
      assert.deepEqual(await sortedKeys({ asset_type: 'kind', asset_id: 13, type: 'kind', id: 14 }), [])
      assert.deepEqual(await sortedKeys({ place_id: 3, applied_public_activity: [{ place_id: 3 }], to_place_id: '3' }), ['p3'])
      // Every odd shape also stores: the index is maintained on insert and never refuses one.
      const odd = [
        {}, { place_id: null }, { applied_public_activity: [[], {}, true, 1.5, '\u0000'.slice(1)] },
        { thing_id: '9'.repeat(400) }, { place_id: '1'.repeat(11) }, { offer_id: '00000000001' },
        { applied_public_activity: Array.from({ length: 500 }, (_, index) => ({ place_id: index })) },
      ]
      for (const detail of odd) await event('rare_kind', detail, 'nobody')
      const stored = (await db.query(`SELECT count(*)::integer AS events FROM events
        WHERE public.event_room_keys(detail) && ARRAY['p1', 'p499']`)).rows[0]!.events
      assert.equal(stored, 1)
    })

    await t.test('every one room read answers exactly as today through every change', async () => {
      const fixture = await seedRoomReads()
      let total = await assertSameAsToday(fixture, 'seeded')
      assert.ok(total > 100, 'the shapes must return real rows, not only empty pages')
      const step = async (moment: string, change: () => Promise<unknown>) => {
        await change()
        total += await assertSameAsToday(fixture, moment)
      }
      const { things, notes } = fixture
      await step('a thing moves into the square', () => db.query('UPDATE things SET place_id = $2 WHERE id = $1', [things.home, fixture.square]))
      await step('a thing moves out of the square', () => db.query('UPDATE things SET place_id = $2 WHERE id = $1', [things.square, fixture.home]))
      await step('a thing moves to a room below', () => db.query('UPDATE things SET place_id = $2 WHERE id = $1', [things.side, fixture.corner]))
      await step('a thing is withdrawn', () => db.query('UPDATE things SET withdrawn_at = now() WHERE id = $1', [things.below]))
      await step('a thing that will end moves into the square', () => db.query('UPDATE things SET place_id = $2 WHERE id = $1', [fixture.dueLamp, fixture.square]))
      await step('a thing ends', async () => {
        await db.query(`UPDATE things SET ended_at = thing_end_due_at(id), ended_cause = 'at', ended_owner_id = owner_id,
            end_program_state = 'pending'
          WHERE id = $1 AND (SELECT set_config('city.ending_writer', 'record:' || $1::text, true)) IS NOT NULL`, [fixture.dueLamp])
        const ended = (await db.query('SELECT ended_at FROM things WHERE id = $1', [fixture.dueLamp])).rows[0]!.ended_at
        assert.ok(ended, 'the due lamp must have ended')
        await event('thing_ended', { thing_id: fixture.dueLamp, place_id: fixture.square, cause: 'at' }, 'the city')
      })
      await step('a note is removed', () => moderate('note', notes.square, 'remove'))
      await step('a note is restored', () => moderate('note', notes.square, 'restore'))
      await step('a line is removed', () => moderate('line', fixture.lineId, 'remove'))
      await step('a line is restored', () => moderate('line', fixture.lineId, 'restore'))
      await step('a room below is removed', () => moderate('place', fixture.below, 'remove'))
      await step('an outcome target is removed', () => moderate('thing', things.square, 'remove'))
      await step('the room below is restored', () => moderate('place', fixture.below, 'restore'))
      await step('an offer is made on a thing below', async () => {
        const offer = await one(`INSERT INTO transfer_offers (channel, asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet)
          VALUES ('direct', 'thing', $1, 2, 3, 1, '0x' || repeat('e', 40)) RETURNING id`, [things.feed])
        await event('offer_made', { offer_id: offer })
      })
      await step('an offer closes', () => db.query(`UPDATE transfer_offers SET status = 'canceled'
        WHERE asset_type = 'thing' AND asset_id = $1 AND status = 'open'`, [things.feed]))
      await step('an offered thing moves away', () => db.query('UPDATE things SET place_id = $2 WHERE id = $1', [things.side, fixture.small]))
      await step('a room leaves the tree', () => db.query('UPDATE places SET parent_id = $2 WHERE id = $1', [fixture.below, fixture.continent]))
      await step('the room comes back to the tree', () => db.query('UPDATE places SET parent_id = $2 WHERE id = $1', [fixture.below, fixture.side]))
      await step('a room becomes a feed room', () => db.query('UPDATE places SET quiet = TRUE, feed = TRUE WHERE id = $1', [fixture.side]))
      await step('the room stops being a feed room', () => db.query('UPDATE places SET feed = FALSE, quiet = FALSE WHERE id = $1', [fixture.side]))
      await step('new events arrive after the index exists', async () => {
        await event('note', { note_id: notes.corner, place_id: fixture.corner, body: 'later' })
        await event('action', { applied_public_activity: [{ actor: 'ending-maker', operation: 'move', target_type: 'thing', place_id: fixture.square }] })
        await event('thing_edited', { thing_id: things.home })
      })
      await step('without the index the same read is only slower', () => db.query('DROP INDEX public.events_room_keys'))
      await step('the index is back', () => db.query(`CREATE INDEX events_room_keys ON public.events
        USING gin (public.event_room_keys(detail)) WITH (fastupdate = off)`))
      assert.ok(total > 2_000, `the changes must keep real rows in the answers, saw ${total}`)
    })

    await t.test('the migrations run function first, build the index concurrently and recover', async () => {
      await db.query('DROP INDEX IF EXISTS public.events_room_keys')
      await db.query('DROP FUNCTION IF EXISTS public.event_room_keys(jsonb)')
      await assert.rejects(
        applyMigration(postgres.databaseUrl, 'db/migrations/20261124_events_room_keys_index.sql', indexMigration),
        /run the event-room-keys-function migration first/u)
      await db.query(functionMigration)
      await db.query(functionMigration)
      assert.equal(await applyMigration(postgres.databaseUrl, 'db/migrations/20261124_events_room_keys_index.sql', indexMigration), 1)
      const built = (await db.query(EVENTS_ROOM_KEYS_INDEX_STATE_QUERY)).rows
      assert.equal(built.length, 1)
      assert.equal(built[0]!.valid, true)
      assert.equal(built[0]!.ready, true)
      const oid = async () => (await db.query(`SELECT 'public.events_room_keys'::regclass::oid AS oid`)).rows[0]!.oid
      const first = await oid()
      assert.equal(await applyMigration(postgres.databaseUrl, 'db/migrations/20261124_events_room_keys_index.sql', indexMigration), 0)
      assert.equal(await oid(), first, 'a valid exact index is kept on a rerun')
      await db.query(`UPDATE pg_index SET indisvalid = FALSE, indisready = FALSE WHERE indexrelid = 'public.events_room_keys'::regclass`)
      assert.equal(await applyMigration(postgres.databaseUrl, 'db/migrations/20261124_events_room_keys_index.sql', indexMigration), 2)
      assert.notEqual(await oid(), first, 'a failed build is dropped and built again')
      // With the index built, the function migration refuses to run again.
      await assert.rejects(db.query(functionMigration), /never edit the key function in place/u)
      // A same-named index with another definition fails closed.
      await db.query('DROP INDEX public.events_room_keys')
      await db.query('CREATE INDEX events_room_keys ON public.events (id)')
      await assert.rejects(
        applyMigration(postgres.databaseUrl, 'db/migrations/20261124_events_room_keys_index.sql', indexMigration),
        /conflicts with the reviewed definition/u)
      await db.query('DROP INDEX public.events_room_keys')
      // A key function with another body is refused before any build.
      await db.query(`CREATE OR REPLACE FUNCTION public.event_room_keys(detail jsonb) RETURNS text[]
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $body$ SELECT ARRAY[]::text[] $body$`)
      await assert.rejects(
        applyMigration(postgres.databaseUrl, 'db/migrations/20261124_events_room_keys_index.sql', indexMigration),
        /does not match the reviewed function body/u)
    })

    await t.test('a busy room read looks up each room key, a big room read with a kind, an actor or a time window reads those events', async () => {
      await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await db.query(schemaDdl)
      await db.query(`INSERT INTO residents (id, handle, model, secret_hash) VALUES
        (1, 'founder', 'room-reads', repeat('1', 64)), (2, 'grower', 'room-reads', repeat('2', 64))`)
      await db.query('UPDATE resident_id_allocator SET last_id = 2 WHERE singleton')
      const worldId = Number((await db.query(`SELECT id FROM places WHERE place_kind = 'world'`)).rows[0]!.id)
      const continent = await one(`INSERT INTO places (parent_id, place_kind, name, description, owner_id)
        VALUES ($1, 'continent', 'Seeded Continent', 'seeded land', 1) RETURNING id`, [worldId])
      const rooms = await seedRoomEventsBenchmark(db, 50_000, continent)
      const base: PublicEventFilters = { kind: null, actor: null, placeId: null, includeDescendants: false, withinSeconds: null, afterId: null }
      // Each key while the room's keys are few beside the events the read's kind, actor and
      // time window allow; one pass over those events once the room holds so much of the
      // city (the continent, the world) or they are so few that a lookup per key would cost
      // more. The seed spreads event times about 15 s apart and gives about one event in 750
      // to 'quiet-reader', so a 30 minute window and that actor are small slices of the city.
      const cases: ReadonlyArray<readonly ['each key' | 'one pass', PublicEventFilters]> = [
        ['each key', { ...base, placeId: rooms.squareId, includeDescendants: true }],
        ['each key', { ...base, placeId: rooms.squareId }],
        ['each key', { ...base, placeId: rooms.smallRoomId, kind: 'action' }],
        ['each key', { ...base, placeId: continent, includeDescendants: true }],
        ['each key', { ...base, placeId: rooms.smallRoomId, actor: 'grower' }],
        ['one pass', { ...base, placeId: continent, includeDescendants: true, kind: 'note' }],
        ['one pass', { ...base, placeId: continent, includeDescendants: true, kind: 'rare_kind_25' }],
        ['one pass', { ...base, placeId: worldId, includeDescendants: true, kind: 'note' }],
        ['one pass', { ...base, placeId: worldId, includeDescendants: true, kind: 'action' }],
        ['one pass', { ...base, placeId: rooms.squareId, includeDescendants: true, kind: 'rare_kind_25' }],
        ['one pass', { ...base, placeId: continent, includeDescendants: true, actor: 'quiet-reader' }],
        ['one pass', { ...base, placeId: worldId, includeDescendants: true, actor: 'quiet-reader' }],
        ['one pass', { ...base, placeId: continent, includeDescendants: true, withinSeconds: 1800 }],
        ['one pass', { ...base, placeId: worldId, includeDescendants: true, withinSeconds: 1800 }],
        ['one pass', { ...base, placeId: worldId, includeDescendants: true, withinSeconds: 60 }],
        ['one pass', { ...base, placeId: rooms.squareId, includeDescendants: true, withinSeconds: 1800 }],
        ['one pass', { ...base, placeId: worldId, includeDescendants: true, actor: 'founder', withinSeconds: 1800 }],
      ]
      const slices = (await db.query(`SELECT count(*) FILTER (WHERE at >= now() - interval '1800 seconds')::integer AS recent,
          count(*) FILTER (WHERE actor = 'quiet-reader')::integer AS quiet
        FROM events`)).rows[0]!
      assert.ok(slices.quiet > 20 && slices.quiet < 200, `the seed's quiet actor has a small history: ${slices.quiet}`)
      assert.ok(slices.recent > 20 && slices.recent < 500, `a 30 minute window holds few events: ${slices.recent}`)
      for (const [way, filters] of cases) {
        for (const load of [loadPublicEventCollectionRows, loadPublicEventPageRows]) {
          let sent: Readonly<{ text: string; params: readonly unknown[] }> | null = null
          await load(async (text, params) => { sent = { text, params }; return [] },
            filters, { ok: true, cursor: null, limit: 20, fetchLimit: 21 }).catch(() => undefined)
          assert.ok(sent)
          const { text, params } = sent as Readonly<{ text: string; params: readonly unknown[] }>
          // As the route sends it: budgeted, in a read-only transaction, parallel workers off.
          // Today's statement runs in the same transaction, so a time window ends at the
          // same moment for both (the seeded events are 15 s apart up to now).
          const mode = filters.includeDescendants ? 'within' : 'exact'
          const counted = load === loadPublicEventCollectionRows
          const name = `${load.name} ${JSON.stringify(filters)}`
          const client = await db.connect()
          let plan: unknown
          let answer: readonly Row[]
          let today: readonly Row[]
          try {
            await client.query('BEGIN READ ONLY')
            await client.query('SET LOCAL max_parallel_workers_per_gather = 0')
            plan = (await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${budgetedExactStatement(text)}`, [...params])).rows[0]!['QUERY PLAN']
            answer = (await client.query(text, [...params])).rows
            today = (await client.query(oracle.statements[`${mode}${counted ? 'Counted' : 'Uncounted'}`]!, [...params])).rows
          } finally {
            await client.query('ROLLBACK')
            client.release()
          }
          assert.deepEqual(answer, today, `${name} answers as today`)
          // A 60 s window may already be empty by the time it runs; the others hold rows.
          if (filters.withinSeconds === 1800 || filters.actor === 'quiet-reader') {
            assert.ok(counted ? Number(answer[0]!.total_items) > 0 : answer.some(row => row.id != null), `${name} keeps real rows`)
          }
          // Only the events scans that ran: a branch the read did not take has no loops.
          // The choice itself (alias narrow_count) counts at most the ratio times the room's
          // keys of the events the kind, actor and window allow, and is left out here.
          const reads: string[] = []
          const walk = (node: Record<string, unknown>) => {
            const index = String(node['Index Name'] ?? '')
            if ((node['Relation Name'] === 'events' || index.startsWith('events_')) && Number(node['Actual Loops']) > 0
              && node.Alias !== 'narrow_count') {
              reads.push(`${node['Node Type']} ${index}`.trim())
            }
            for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child)
          }
          walk((plan as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan)
          const ran = reads
          if (way === 'each key') {
            assert.ok(reads.includes('Bitmap Index Scan events_room_keys'), `${name} looks up each room key: ${ran}`)
            assert.ok(reads.every(scan => ['Bitmap Heap Scan', 'Bitmap Index Scan events_room_keys', 'Index Scan events_pkey'].includes(scan)),
              `${name} never scans events another way: ${ran}`)
          } else {
            assert.ok(!ran.some(scan => scan.includes('events_room_keys')), `${name} never looks up each key: ${ran}`)
            // Through events_kind, events_actor_at_desc or events_at, or one sequential pass
            // when the kind is most of the city (as today's statement reads them too).
            assert.ok(reads.some(scan => /events_kind|events_actor_at_desc|events_at|^Seq Scan$/u.test(scan)),
              `${name} reads the kind's, actor's or window's events: ${ran}`)
          }
        }
      }
    })
  } finally {
    await postgres.stop()
  }
})
