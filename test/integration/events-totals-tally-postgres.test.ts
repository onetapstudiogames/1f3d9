// The kept events tally (decision #196) against real PostgreSQL: the real schema, the
// real migration, the real change-marker trigger. The tally's totals must equal the
// events list's own totals, total for total, for the whole list and every kind, after
// every case that can reach back into old history, while writes land during a fold,
// after a fold that runs twice or dies halfway, and through a first fill in steps.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Pool } from 'pg'
import { FEED_ROOM_EVENT_KINDS, feedRoomEventLateralSql, feedRoomIdsSql } from '../../src/feed-rooms.ts'
import { FOUNDER, GROWER, NEIGHBOUR, type CityApp } from '../helpers/abilities-fixtures.ts'
import {
  assertKeptMatchesList,
  changeMarker,
  insertEvents,
  insertThing,
  moveThing,
  setFeed,
  setQuiet,
  tallyDatabase,
  tallyState,
  type EventSeed,
} from '../helpers/events-totals-fixtures.ts'
import {
  bearer,
  resetCity,
  startNoteSuiteDatabase,
  withNoteSuiteQueryObserver,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const
const ACTIVITY_KINDS = ['action', 'effect_resolved', 'room_reached', 'wake_try_applied'] as const
const migration = await readFile(
  new URL('../../db/migrations/20261112_events_totals_tally.sql', import.meta.url),
  'utf8',
)
const UNLIMITED = Object.freeze({ chunkChanges: 1_000_000, maxChunks: 1_000, budgetMs: 600_000 })

type Rooms = Readonly<{ continentId: number; eastRoomId: number; westRoomId: number; extra: readonly number[] }>

async function cityWithRooms(pool: Pool): Promise<Rooms> {
  const rooms = await resetCity(RESIDENTS)
  const extra: number[] = []
  for (const name of ['North Room', 'South Room', 'Attic']) {
    const row = await pool.query<{ id: number }>(
      `INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_notes)
       VALUES ($1, 'place', $2, 'an extra room', 1, TRUE) RETURNING id`,
      [rooms.continentId, name],
    )
    extra.push(Number(row.rows[0]!.id))
  }
  return Object.freeze({ ...rooms, extra: Object.freeze(extra) })
}

function content(placeId: unknown): Record<string, unknown> {
  return { target_type: 'thing', operation: 'move', place_id: placeId, actor: 'founder' }
}

/** Every feed kind and activity kind across every detail shape the rule distinguishes. */
function detailShapes(rooms: Rooms, things: readonly number[], laterThingId: number): readonly EventSeed[] {
  const [north, south] = rooms.extra
  const placeShapes: Record<string, unknown>[] = [
    { place_id: rooms.westRoomId, body: 'west note' },
    { place_id: String(rooms.eastRoomId), description: 'east text' },
    { place_id: rooms.westRoomId, thing_id: things[1], reason: 'both named' },
    { place_id: '0', thing_id: things[0] },
    { place_id: 'abc', thing_id: things[1] },
    { place_id: '1234567890', thing_id: things[0] },
    { place_id: -4 },
    { thing_id: things[0], body: 'thing in west' },
    { thing_id: String(things[1]) },
    { thing_id: laterThingId },
    { thing_id: '0012' },
    { thing_id: 99_999_999 },
    { body: 'nothing named' },
    { body: 42, description: true, reason: null },
    { place_id: null, thing_id: null },
  ]
  const activityShapes: unknown[] = [
    [],
    [content(rooms.westRoomId)],
    [content(rooms.westRoomId), content(rooms.westRoomId)],
    [content(rooms.westRoomId), content(rooms.eastRoomId)],
    [content(north), content(rooms.westRoomId), content(south)],
    [content(rooms.westRoomId), { target_type: 'place', operation: 'move', place_id: rooms.westRoomId, actor: 'founder' }],
    [content(rooms.westRoomId), { target_type: 'thing', operation: 'look', place_id: rooms.westRoomId, actor: 'founder' }],
    [content(null)],
    [content(String(rooms.eastRoomId))],
  ]
  // Outcomes that are not objects, lack an actor or name an id out of range are refused
  // by the database when written and when a room's activity is recomputed, so no stored
  // event holds one; they are not shapes history can contain.
  const seeds: EventSeed[] = []
  for (const kind of FEED_ROOM_EVENT_KINDS) {
    for (const detail of placeShapes) seeds.push({ kind, detail })
  }
  for (const kind of ACTIVITY_KINDS) {
    for (const applied of activityShapes) {
      seeds.push({ kind, detail: { applied_public_activity: applied, place_id: rooms.westRoomId, thing_id: things[0] } })
    }
    seeds.push({ kind, detail: { place_id: rooms.westRoomId } })
  }
  for (const detail of placeShapes.slice(0, 4)) seeds.push({ kind: 'transfer', detail })
  seeds.push({ kind: 'place_edited', detail: { place_id: rooms.westRoomId, applied_public_activity: [content(rooms.westRoomId)] } })
  return seeds
}

// Each event's feed room by today's join, beside the room its tally rows give it.
async function keyAgreement(pool: Pool): Promise<ReadonlyArray<Readonly<{ id: number; kind: string; today: number | null; kept: number | null }>>> {
  const { eventTallyKeysSql } = await import('../../src/events-totals-tally.ts')
  const rows = await pool.query(`
    WITH ids AS (SELECT ${feedRoomIdsSql()} AS ids)
    SELECT event.id, event.kind, feed.feed_room_id AS today,
      (SELECT max(CASE tally_key.key_type
          WHEN 'place' THEN CASE WHEN tally_key.key_id = ANY(ids.ids) THEN tally_key.key_id END
          WHEN 'thing' THEN (SELECT thing.place_id FROM things thing
            WHERE thing.id = tally_key.key_id AND thing.place_id = ANY(ids.ids))
          WHEN 'rooms' THEN CASE WHEN tally_key.room_set <@ ids.ids THEN tally_key.key_id END
        END)
       FROM (SELECT 1) single ${eventTallyKeysSql('event')}
       WHERE tally_key.key_type <> 'all') AS kept,
      (SELECT count(*) FROM (SELECT 1) single ${eventTallyKeysSql('event')}
       WHERE tally_key.key_type <> 'all') AS specific_rows,
      (SELECT count(*) FROM (SELECT 1) single ${eventTallyKeysSql('event')}
       WHERE tally_key.key_type = 'all') AS all_rows
    FROM events event CROSS JOIN ids
    ${feedRoomEventLateralSql('event', feedRoomIdsSql())}
    ORDER BY event.id`)
  for (const row of rows.rows) {
    assert.equal(Number(row.all_rows), 1, `event ${row.id} has exactly one (kind, all) row`)
    assert.ok(Number(row.specific_rows) <= 1, `event ${row.id} has at most one room row`)
  }
  return rows.rows.map(row => Object.freeze({
    id: Number(row.id),
    kind: String(row.kind),
    today: row.today == null ? null : Number(row.today),
    kept: row.kept == null ? null : Number(row.kept),
  }))
}

async function foldAll(pool: Pool): Promise<void> {
  const { foldSettledEvents } = await import('../../src/events-totals-tally.ts')
  const result = await foldSettledEvents(tallyDatabase(pool), UNLIMITED)
  assert.equal(result.state, 'folded')
  assert.equal(result.caughtUp, true)
}

async function foldAndMatch(pool: Pool, label: string): Promise<void> {
  await foldAll(pool)
  await assertKeptMatchesList(pool, label)
  const { observeEventsTotals } = await import('../../src/events-totals-check.ts')
  const observed = await observeEventsTotals(tallyDatabase(pool))
  assert.deepEqual(observed.mismatches, [], label)
  assert.equal(observed.ok, true, label)
}

function randomFrom<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

type Served = Readonly<{ path: string; reader: string; status: number; headers: string; body: string }>

const SERVED_HEADERS = ['content-type', 'cache-control', 'vary', 'etag'] as const

// Every read the app serves for these paths, with the SQL it sent: status, the
// caching headers and the exact body text.
async function serve(
  app: CityApp,
  reads: ReadonlyArray<Readonly<{ path: string; secret: string | null }>>,
  statements: string[],
): Promise<readonly Served[]> {
  const served: Served[] = []
  for (const read of reads) {
    await withNoteSuiteQueryObserver(text => { statements.push(text); return text }, async () => {
      const response = await app.request(`http://city.test${read.path}`, {
        headers: read.secret === null ? {} : { authorization: `Bearer ${read.secret}` },
      })
      served.push(Object.freeze({
        path: read.path,
        reader: read.secret === null ? 'anyone' : 'signed in',
        status: response.status,
        headers: SERVED_HEADERS.map(name => `${name}=${response.headers.get(name) ?? ''}`).join('; '),
        body: await response.text(),
      }))
    })
  }
  return Object.freeze(served)
}

test('the kept events tally against real PostgreSQL', { timeout: 1_800_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('events-totals')
  const pool = postgres.client
  const db = tallyDatabase(pool)
  const tally = await import('../../src/events-totals-tally.ts')
  const check = await import('../../src/events-totals-check.ts')
  try {
    await t.test('the migration applies twice, adds only its own tables and row, and waits on no event writer', async () => {
      await cityWithRooms(pool)
      await insertEvents(pool, [{ kind: 'note', detail: { body: 'before the migration' } }])
      await pool.query('DROP TABLE events_totals_tally; DROP TABLE events_totals_state')
      const writer = await pool.connect()
      try {
        await writer.query('BEGIN')
        await writer.query(`INSERT INTO events (kind, actor, detail) VALUES ('note', 'founder', '{"body":"in flight"}')`)
        const started = Date.now()
        await pool.query(migration)
        await pool.query(migration)
        assert.ok(Date.now() - started < 4_000, 'the migration never waited on the open event writer')
        await writer.query('COMMIT')
      } finally {
        writer.release()
      }
      const state = await tallyState(pool)
      assert.equal(state.kept_change_id, '0')
      assert.equal(state.rule_version, 0)
      assert.equal(state.trusted, false)
      assert.equal(state.paused, false)
      const tables = await pool.query(`SELECT count(*)::integer AS n FROM events_totals_tally`)
      assert.equal(tables.rows[0]!.n, 0)
    })

    await t.test('every feed kind and activity kind in every detail shape: the tally rows give each event the same feed room as today\'s join', async () => {
      const rooms = await cityWithRooms(pool)
      const things = [await insertThing(pool, rooms.westRoomId), await insertThing(pool, rooms.eastRoomId)]
      const laterThingId = things[1]! + 1
      await insertEvents(pool, detailShapes(rooms, things, laterThingId))
      const [north, south, attic] = rooms.extra as [number, number, number]
      const feedSets: number[][] = [[], [rooms.westRoomId], [rooms.eastRoomId], [rooms.westRoomId, rooms.eastRoomId],
        [north, rooms.westRoomId, south], [attic]]
      let compared = 0
      let leftOut = 0
      for (const feed of feedSets) {
        await pool.query('UPDATE places SET feed = FALSE WHERE feed')
        for (const room of feed) await setFeed(pool, room, true)
        for (const phase of ['before', 'later thing exists', 'thing moved'] as const) {
          if (phase === 'later thing exists' && feed === feedSets[0]) await insertThing(pool, attic, 'born later')
          if (phase === 'thing moved') await moveThing(pool, things[0]!, rooms.eastRoomId)
          for (const row of await keyAgreement(pool)) {
            assert.equal(row.kept, row.today, `event ${row.id} (${row.kind}) with feed ${feed.join(',')} ${phase}`)
            compared += 1
            if (row.today !== null) leftOut += 1
          }
          if (phase === 'thing moved') await moveThing(pool, things[0]!, rooms.westRoomId)
        }
      }
      assert.ok(compared > 1_000, `compared ${compared}`)
      assert.ok(leftOut > 100, `left out ${leftOut}`)
    })

    await t.test('plain events, then every case that reaches back into old history, total for total', async () => {
      const rooms = await cityWithRooms(pool)
      const [north] = rooms.extra as [number]
      const thing = await insertThing(pool, rooms.westRoomId)
      const other = await insertThing(pool, rooms.eastRoomId)
      const notes = await insertEvents(pool, [
        { kind: 'note', actor: 'seed-keeper', detail: { place_id: rooms.westRoomId, note_id: 1, body: 'héllo west' } },
        { kind: 'note', detail: { place_id: rooms.eastRoomId, note_id: 2, body: 'east' } },
        { kind: 'thing_created', detail: { thing_id: thing, description: 'made' } },
        { kind: 'thing_edited', detail: { thing_id: other } },
        { kind: 'thing_moved', detail: { thing_id: thing, from_place_id: rooms.westRoomId, to_place_id: rooms.westRoomId } },
        { kind: 'action', detail: { applied_public_activity: [content(rooms.westRoomId)] } },
        { kind: 'transfer', detail: { asset_type: 'thing', asset_id: thing, reason: 'gift' } },
      ])
      await foldAndMatch(pool, 'plain events')

      await setFeed(pool, rooms.westRoomId, true)
      await assertKeptMatchesList(pool, 'west becomes a feed room')
      await foldAndMatch(pool, 'west becomes a feed room, folded')
      await moveThing(pool, other, rooms.westRoomId)
      await assertKeptMatchesList(pool, 'a thing moves into the feed room')
      await moveThing(pool, thing, north)
      await assertKeptMatchesList(pool, 'a thing moves out of the feed room')
      await setFeed(pool, rooms.westRoomId, false)
      await assertKeptMatchesList(pool, 'west stops being a feed room')
      await setQuiet(pool, rooms.eastRoomId, true)
      await assertKeptMatchesList(pool, 'east becomes quiet')
      await setQuiet(pool, rooms.eastRoomId, false)
      await assertKeptMatchesList(pool, 'east stops being quiet')
      await setFeed(pool, rooms.eastRoomId, true)
      await setFeed(pool, north, true)

      await pool.query(
        `INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason) VALUES ('note', 1, 'remove', 1, 'flooding')`,
      )
      await insertEvents(pool, [{ kind: 'moderation', detail: { target_type: 'note', target_id: 1, action: 'remove', reason: 'flooding' } }])
      await foldAndMatch(pool, 'a founder removal')
      await pool.query(
        `INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason) VALUES ('note', 1, 'restore', 1, 'restored')`,
      )
      await insertEvents(pool, [
        { kind: 'moderation', detail: { target_type: 'note', target_id: 1, action: 'restore', reason: 'restored' } },
        { kind: 'moderation', detail: { target_type: 'resident', target_id: 2, action: 'hold', reason: 'a dated hold' } },
      ])
      await foldAndMatch(pool, 'a restoration and a hold')

      await pool.query('UPDATE places SET retired_at = now() WHERE id = $1', [rooms.extra[2]])
      await insertEvents(pool, [{ kind: 'place_retired', detail: { place_id: rooms.extra[2] } }])
      await foldAndMatch(pool, 'a retirement')
      await pool.query('UPDATE places SET retired_at = NULL WHERE id = $1', [rooms.extra[2]])
      await insertEvents(pool, [{ kind: 'place_restored', detail: { place_id: rooms.extra[2] } }])
      await foldAndMatch(pool, 'a restoration')

      await pool.query('UPDATE things SET withdrawn_at = now() WHERE id = $1', [other])
      await insertEvents(pool, [
        { kind: 'thing_withdrawn', detail: { thing_id: other } },
        { kind: 'thing_ended', detail: { thing_id: other, reason: 'its ending came' } },
      ])
      await foldAndMatch(pool, 'a thing ending in a feed room')
      assert.ok(notes.length === 7)
    })

    await t.test('a fold twice adds nothing; a fold that dies halfway leaves the tally at its last commit', async () => {
      const rooms = await cityWithRooms(pool)
      await setFeed(pool, rooms.westRoomId, true)
      await insertEvents(pool, Array.from({ length: 40 }, (_, index) => ({
        kind: index % 2 ? 'note' : 'line_said', detail: { place_id: index % 3 ? rooms.westRoomId : rooms.eastRoomId, body: `n${index}` },
      })))
      await foldAndMatch(pool, 'first fold')
      const before = await tallyState(pool)
      const second = await tally.foldSettledEvents(db, UNLIMITED)
      assert.equal(second.events, 0)
      assert.deepEqual(await tallyState(pool), before)
      await assertKeptMatchesList(pool, 'fold twice')

      await insertEvents(pool, Array.from({ length: 25 }, (_, index) => ({ kind: 'note', detail: { place_id: rooms.westRoomId, body: `late ${index}` } })))
      const tallyBefore = (await pool.query('SELECT * FROM events_totals_tally ORDER BY 1, 2, 3, 4')).rows
      const dying = Object.freeze({
        ...db,
        transaction: async <T>(work: (transaction: { query: typeof db.query }) => Promise<T>): Promise<T> => {
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            await work({ query: async (text, params = []) => (await client.query(text, [...params])).rows })
            throw new Error('the run died before its commit')
          } finally {
            await client.query('ROLLBACK').catch(() => undefined)
            client.release()
          }
        },
      })
      await assert.rejects(tally.foldSettledEvents(dying, UNLIMITED), /died before its commit/u)
      assert.deepEqual(await tallyState(pool), before)
      assert.deepEqual((await pool.query('SELECT * FROM events_totals_tally ORDER BY 1, 2, 3, 4')).rows, tallyBefore)
      await assertKeptMatchesList(pool, 'after a dead fold')
      await foldAndMatch(pool, 'the next fold after a dead one')
    })

    await t.test('writes that land while a fold runs, and a writer holding the change lock, never wait and are counted exactly once', async () => {
      const rooms = await cityWithRooms(pool)
      await setFeed(pool, rooms.westRoomId, true)
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(`INSERT INTO events (kind, actor, detail) VALUES ('note', 'founder', $1)`,
          [JSON.stringify({ place_id: rooms.westRoomId, body: 'held open' })])
        const markerWhileHeld = await changeMarker(pool)
        const folded = await tally.foldSettledEvents(db, { chunkChanges: 3, maxChunks: 1_000, budgetMs: 60_000 })
        assert.equal(folded.keptChangeId?.toString(), markerWhileHeld, 'the fold stops at the settled marker')
        await assertKeptMatchesList(pool, 'while a writer holds the change lock')
        await holder.query('COMMIT')
      } finally {
        holder.release()
      }
      await assertKeptMatchesList(pool, 'after the held writer commits, before the next fold')
      for (let round = 0; round < 5; round += 1) {
        await Promise.all([
          tally.foldSettledEvents(db, { chunkChanges: 2, maxChunks: 50, budgetMs: 60_000 }),
          ...Array.from({ length: 6 }, (_, index) => insertEvents(pool, [
            { kind: 'note', detail: { place_id: index % 2 ? rooms.westRoomId : rooms.eastRoomId, body: `r${round}-${index}` } },
            { kind: 'thing_created', detail: { place_id: rooms.westRoomId } },
          ])),
          tally.foldSettledEvents(db, { chunkChanges: 5, maxChunks: 50, budgetMs: 60_000 }),
        ])
        await assertKeptMatchesList(pool, `concurrent round ${round}`)
      }
      await foldAndMatch(pool, 'after concurrent rounds')
    })

    await t.test('a first fill in bounded steps across runs, while new events keep arriving', async () => {
      const rooms = await cityWithRooms(pool)
      await setFeed(pool, rooms.westRoomId, true)
      await insertEvents(pool, Array.from({ length: 300 }, (_, index) => ({
        kind: randomFrom(seededRandom(index), ['note', 'action', 'ping_sent', 'transfer']),
        detail: index % 4 === 1
          ? { applied_public_activity: [content(rooms.westRoomId)] }
          : { place_id: index % 2 ? rooms.westRoomId : rooms.eastRoomId, body: `fill ${index}` },
      })))
      let runs = 0
      let caughtUp = false
      while (!caughtUp) {
        const run = await tally.foldSettledEvents(db, { chunkChanges: 20, maxChunks: 3, budgetMs: 60_000 })
        assert.ok(run.chunks <= 3)
        caughtUp = run.caughtUp
        runs += 1
        await assertKeptMatchesList(pool, `fill run ${runs}`)
        if (!caughtUp) {
          const hour = new Date(Date.UTC(2026, 10, 12, runs))
          assert.equal((await check.runHourlyEventsTotalsCheck(db, hour)).state, 'not_due',
            'the hourly check waits until the first fill has caught up')
        }
        if (runs % 2 === 0 && runs < 8) {
          await insertEvents(pool, [{ kind: 'note', detail: { place_id: rooms.westRoomId, body: `arrived ${runs}` } }])
        }
        assert.ok(runs < 50)
      }
      assert.ok(runs >= 5, `the fill took ${runs} runs`)
      assert.notEqual((await tallyState(pool)).caught_up_at, null)
    })

    await t.test('the cheap check and the hourly check catch a wrong tally, rebuild it, and hold it off after a second mismatch', async () => {
      const rooms = await cityWithRooms(pool)
      await setFeed(pool, rooms.westRoomId, true)
      const thing = await insertThing(pool, rooms.westRoomId)
      await insertEvents(pool, [
        { kind: 'note', detail: { place_id: rooms.westRoomId, body: 'kept out' } },
        { kind: 'thing_edited', detail: { thing_id: thing } },
        { kind: 'note', detail: { place_id: rooms.eastRoomId, body: 'kept in' } },
      ])
      await foldAll(pool)
      const firstHour = new Date('2026-11-12T10:03:00Z')
      const matched = await check.runHourlyEventsTotalsCheck(db, firstHour)
      assert.equal(matched.state, 'recorded')
      assert.equal(matched.state === 'recorded' && matched.trusted, true)
      assert.equal((await check.runHourlyEventsTotalsCheck(db, new Date('2026-11-12T10:40:00Z'))).state, 'not_due')

      await pool.query(`UPDATE events_totals_tally SET items = items + 1 WHERE key_type = 'all' AND kind = 'note'`)
      const cheap = await tally.checkKeptCountCheaply(db, () => new Date('2026-11-12T10:45:00Z'))
      assert.equal(cheap.state, 'mismatch')
      let state = await tallyState(pool)
      assert.equal(state.kept_change_id, '0')
      assert.equal(state.trusted, false)
      assert.equal(state.held_off, false)
      await foldAll(pool)
      assert.equal((await tally.checkKeptCountCheaply(db)).state, 'ok')

      // A wrong room row keeps every count's sum right, so only the full check sees it.
      await pool.query(`UPDATE events_totals_tally SET key_id = $1 WHERE key_type = 'place' AND key_id = $2`,
        [999_999, rooms.westRoomId])
      assert.equal((await tally.checkKeptCountCheaply(db)).state, 'ok')
      const caught = await check.runHourlyEventsTotalsCheck(db, new Date('2026-11-12T11:00:00Z'))
      assert.equal(caught.state, 'recorded')
      assert.ok(caught.state === 'recorded' && caught.observation.mismatches.length > 0)
      assert.ok(caught.state === 'recorded' && caught.observation.mismatches.every(found => (
        Object.keys(found).sort().join(',') === 'full,kept,kind')))
      state = await tallyState(pool)
      assert.equal(state.trusted, false)
      assert.equal(state.held_off, true, 'a second mismatch within 24 hours holds the tally off')
      assert.equal(state.last_check_ok, false)
      await foldAll(pool)
      const after = await check.runHourlyEventsTotalsCheck(db, new Date('2026-11-12T12:01:00Z'))
      assert.equal(after.state === 'recorded' && after.observation.ok, true)
      assert.equal(after.state === 'recorded' && after.trusted, false, 'held off stays untrusted until the operator clears it')
      await pool.query('UPDATE events_totals_state SET held_off = FALSE')
      const cleared = await check.runHourlyEventsTotalsCheck(db, new Date('2026-11-12T13:01:00Z'))
      assert.equal(cleared.state === 'recorded' && cleared.trusted, true)
    })

    await t.test('an event without its change row is a mismatch; a new rule version and paused are honoured', async () => {
      const rooms = await cityWithRooms(pool)
      await insertEvents(pool, [{ kind: 'note', detail: { place_id: rooms.westRoomId, body: 'logged' } }])
      await foldAll(pool)
      assert.equal((await check.observeEventsTotals(db)).ok, true)
      await pool.query('ALTER TABLE events DISABLE TRIGGER events_record_public_change')
      await insertEvents(pool, [{ kind: 'note', detail: { body: 'never logged' } }])
      await pool.query('ALTER TABLE events ENABLE TRIGGER events_record_public_change')
      const unlogged = await check.observeEventsTotals(db)
      assert.equal(unlogged.ok, false)
      assert.equal(unlogged.unloggedEvents, 1)

      await cityWithRooms(pool)
      await insertEvents(pool, [{ kind: 'note', detail: { body: 'one' } }, { kind: 'ping_sent', detail: { body: 'two' } }])
      await foldAll(pool)
      const generation = (await tallyState(pool)).generation
      await pool.query('UPDATE events_totals_state SET rule_version = rule_version + 7')
      await foldAll(pool)
      const rebuilt = await tallyState(pool)
      assert.equal(rebuilt.rule_version, tally.EVENTS_TOTALS_RULE_VERSION)
      assert.notEqual(rebuilt.generation, generation)
      await assertKeptMatchesList(pool, 'rebuilt under the current rule version')

      await pool.query('UPDATE events_totals_state SET paused = TRUE')
      await insertEvents(pool, [{ kind: 'note', detail: { body: 'while paused' } }])
      const pausedState = await tallyState(pool)
      assert.equal((await tally.foldSettledEvents(db, UNLIMITED)).state, 'paused')
      assert.equal((await tally.checkKeptCountCheaply(db)).state, 'paused')
      assert.equal((await check.runHourlyEventsTotalsCheck(db, new Date('2026-11-13T01:00:00Z'))).state, 'not_due')
      assert.deepEqual(await tallyState(pool), pausedState)
      const { runEventsTotalsMaintenance } = await import('../../src/events-totals-maintenance.ts')
      assert.equal((await runEventsTotalsMaintenance(db, {}, new Date('2026-11-13T01:00:00Z'))).state, 'paused')
      await pool.query('UPDATE events_totals_state SET paused = FALSE')
      assert.equal((await runEventsTotalsMaintenance(db, { EVENTS_TOTALS_TALLY: 'off' })).state, 'off')
      assert.deepEqual(await tallyState(pool), { ...pausedState, paused: false })
      assert.equal((await runEventsTotalsMaintenance(db, {}, new Date('2026-11-13T02:00:00Z'))).state, 'ran')
      await assertKeptMatchesList(pool, 'after the pause ends')
      const ran = await tallyState(pool)
      assert.equal(ran.trusted, true)
      assert.equal(ran.last_check_ok, true)
    })

    await t.test('a fold takes only share locks on events and the change log, and no lock any writer waits on', async () => {
      const rooms = await cityWithRooms(pool)
      await insertEvents(pool, Array.from({ length: 30 }, (_, index) => ({ kind: 'note', detail: { place_id: rooms.westRoomId, body: `l${index}` } })))
      await pool.query('UPDATE events_totals_state SET rule_version = $1', [tally.EVENTS_TOTALS_RULE_VERSION])
      const folder = await pool.connect()
      try {
        await folder.query('BEGIN')
        const result = await tally.foldOneChunk({ query: async (text, params = []) => (await folder.query(text, [...params])).rows }, 10_000, new Date())
        assert.equal(result.state, 'folded')
        const locks = (await folder.query(`
          SELECT coalesce(relation::regclass::text, locktype) AS target, mode
          FROM pg_locks WHERE pid = pg_backend_pid() AND granted
            AND (locktype = 'relation' AND relation::regclass::text NOT LIKE 'pg_%')
          ORDER BY 1, 2`)).rows.map(row => `${row.target} ${row.mode}`)
        const writerTables = ['events', 'public_change_log', 'public_change_state', 'things', 'places']
        for (const lock of locks) {
          const [target, mode] = lock.split(' ')
          if (target!.startsWith('events_totals_')) continue
          assert.equal(mode, 'AccessShareLock', `the fold holds ${lock}`)
        }
        assert.ok(locks.some(lock => lock === 'events AccessShareLock'))
        assert.ok(locks.every(lock => !writerTables.some(table => lock === `${table} RowExclusiveLock`)))
        console.info('events_totals_fold_locks', JSON.stringify(locks))
        // While the fold's transaction is still open, an ordinary event write commits at once.
        const started = Date.now()
        await pool.query(`SET lock_timeout = '1s'`)
        await insertEvents(pool, [{ kind: 'note', detail: { place_id: rooms.westRoomId, body: 'during the fold' } }])
        await pool.query(`UPDATE things SET name = name WHERE FALSE`)
        assert.ok(Date.now() - started < 1_000)
        await folder.query('COMMIT')
      } finally {
        folder.release()
        await pool.query('RESET lock_timeout')
      }
      await foldAndMatch(pool, 'after the lock check')
    })

    await t.test('10,000 folds on one tally equal a fresh full count', async () => {
      const rooms = await cityWithRooms(pool)
      const things = [await insertThing(pool, rooms.westRoomId), await insertThing(pool, rooms.eastRoomId)]
      await setFeed(pool, rooms.westRoomId, true)
      const random = seededRandom(10_000)
      const kinds = ['note', 'line_said', 'thing_moved', 'action', 'transfer', 'ping_answered']
      await insertEvents(pool, Array.from({ length: 10_000 }, (_, index) => {
        const kind = randomFrom(random, kinds)
        return {
          kind,
          detail: kind === 'action'
            ? { applied_public_activity: [content(randomFrom(random, [rooms.westRoomId, rooms.eastRoomId]))] }
            : random() < 0.5 ? { thing_id: randomFrom(random, things), body: `t${index}` }
              : { place_id: randomFrom(random, [rooms.westRoomId, rooms.eastRoomId]), body: `p${index}` },
        }
      }))
      let folds = 0
      let caughtUp = false
      for (let run = 0; run < 40 && !caughtUp; run += 1) {
        const result = await tally.foldSettledEvents(db, { chunkChanges: 1, maxChunks: 500, budgetMs: 600_000 })
        folds += result.chunks
        caughtUp = result.caughtUp
      }
      assert.ok(folds >= 10_000, `${folds} folds`)
      assert.equal((await tallyState(pool)).kept_change_id, await changeMarker(pool))
      await moveThing(pool, things[1]!, rooms.westRoomId)
      await assertKeptMatchesList(pool, 'after 10,000 folds')
      const fresh = (await pool.query('SELECT kind, key_type, key_id, room_set, items, text_bytes FROM events_totals_tally ORDER BY 1, 2, 3, 4')).rows
      await pool.query('UPDATE events_totals_state SET rule_version = 0')
      await foldAll(pool)
      assert.deepEqual(
        (await pool.query('SELECT kind, key_type, key_id, room_set, items, text_bytes FROM events_totals_tally ORDER BY 1, 2, 3, 4')).rows,
        fresh,
        'one-change folds build the same rows as one fresh build',
      )
    })

    await t.test('a randomized model: inserts of every shape, moves, feed changes, rollbacks and folds, compared after every step', async () => {
      const rooms = await cityWithRooms(pool)
      const roomIds = [rooms.westRoomId, rooms.eastRoomId, ...rooms.extra]
      const things: number[] = []
      for (const room of roomIds) things.push(await insertThing(pool, room))
      const random = seededRandom(195)
      const kinds = [...FEED_ROOM_EVENT_KINDS, ...ACTIVITY_KINDS, 'transfer', 'place_edited', 'moderation']
      const randomDetail = (): Record<string, unknown> => {
        const roll = random()
        if (roll < 0.25) return { place_id: randomFrom(random, roomIds), body: 'x'.repeat(Math.floor(random() * 5)) }
        if (roll < 0.45) return { thing_id: randomFrom(random, [...things, things.at(-1)! + 3]) }
        if (roll < 0.75) {
          return { applied_public_activity: Array.from({ length: Math.floor(random() * 4) }, () => (
            random() < 0.85 ? content(randomFrom(random, roomIds)) : { target_type: 'place', operation: 'move', place_id: randomFrom(random, roomIds), actor: 'founder' }
          )) }
        }
        return { reason: 'r', description: random() < 0.5 ? 'd' : 7 }
      }
      const steps = 1_500
      for (let step = 0; step < steps; step += 1) {
        const roll = random()
        if (roll < 0.45) {
          await insertEvents(pool, Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ kind: randomFrom(random, kinds), detail: randomDetail() })))
        } else if (roll < 0.55) {
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            await client.query(`INSERT INTO events (kind, actor, detail) VALUES ('note', 'founder', $1)`, [JSON.stringify(randomDetail())])
            await client.query('ROLLBACK')
          } finally {
            client.release()
          }
        } else if (roll < 0.65) {
          await moveThing(pool, randomFrom(random, things), randomFrom(random, roomIds))
        } else if (roll < 0.72) {
          const room = randomFrom(random, roomIds)
          const isFeed = (await pool.query('SELECT feed FROM places WHERE id = $1', [room])).rows[0]!.feed === true
          await setFeed(pool, room, !isFeed)
        } else if (roll < 0.75) {
          things.push(await insertThing(pool, randomFrom(random, roomIds)))
        } else {
          await tally.foldSettledEvents(db, { chunkChanges: 1 + Math.floor(random() * 6), maxChunks: 1 + Math.floor(random() * 3), budgetMs: 60_000 })
        }
        if (step % 3 === 0 || step === steps - 1) await assertKeptMatchesList(pool, `model step ${step}`)
      }
      await foldAndMatch(pool, 'model end')
    })
    await t.test("no read uses the tally: every events answer, the window's own reads and other city-wide reads are byte for byte the same with the tally absent, empty, full or wrong", async () => {
      const { default: app } = await import('../../src/index.ts') as { default: CityApp }
      const rooms = await cityWithRooms(pool)
      const thing = await insertThing(pool, rooms.westRoomId)
      await setFeed(pool, rooms.westRoomId, true)
      await insertEvents(pool, Array.from({ length: 30 }, (_, index) => ({
        kind: ['note', 'thing_edited', 'action', 'transfer', 'line_said'][index % 5]!,
        actor: index % 3 === 0 ? NEIGHBOUR.handle : FOUNDER.handle,
        detail: index % 5 === 1 ? { thing_id: thing, description: `edit ${index}` }
          : index % 5 === 2 ? { applied_public_activity: [content(index % 2 ? rooms.westRoomId : rooms.eastRoomId)] }
            : { place_id: index % 2 ? rooms.westRoomId : rooms.eastRoomId, body: `item ${index}` },
      })))
      const muted = await app.request('http://city.test/api/me/settings', {
        method: 'PATCH', headers: bearer(GROWER.secret), body: JSON.stringify({ mute: { type: 'resident', id: NEIGHBOUR.id } }),
      })
      assert.equal(muted.status, 200, await muted.text())
      const ids = (await pool.query<{ id: number }>('SELECT id FROM events ORDER BY id')).rows.map(row => Number(row.id))
      const middle = ids[Math.floor(ids.length / 2)]!
      const marker = await changeMarker(pool)
      const reads: Array<Readonly<{ path: string; secret: string | null }>> = []
      // The events list as callers and MCP browse view=events read it: first page,
      // older pages, newer pages, kinds, actor and place filters, and marker reads.
      for (const secret of [null, GROWER.secret]) {
        for (const path of [
          '/api/events', '/api/events?limit=5', `/api/events?limit=5&before_id=${middle}`,
          `/api/events?limit=5&after_id=${middle}`, '/api/events?kind=note', '/api/events?kind=thing_edited',
          '/api/events?kind=action&limit=3', `/api/events?actor=${NEIGHBOUR.handle}`,
          `/api/events?place_id=${rooms.eastRoomId}`, `/api/events?after_change_marker=${marker}`,
          '/api/events?hidden=outline&limit=4',
        ]) reads.push({ path, secret })
      }
      // The window's own history reads (src/window-client/program/33-agreements-and-history-controls.ts).
      for (const path of [
        '/api/events?limit=50', `/api/events?limit=50&within_place_id=${rooms.continentId}`,
        `/api/events?limit=50&actor=${FOUNDER.handle}`, `/api/events?limit=50&before_id=${middle}`,
        `/api/events?limit=50&before_id=${ids.at(-1)}&after_id=${ids[2]}`,
        `/api/events?limit=50&after_change_marker=${marker}`,
        `/api/events?limit=50&within_place_id=${rooms.continentId}&after_change_marker=${marker}`,
      ]) reads.push({ path, secret: null })
      // Other city-wide reads that count feed rooms or events.
      for (const path of ['/api/changes', '/api/changes?since=0&limit=20']) reads.push({ path, secret: null })

      const statements: string[] = []
      await pool.query('DROP TABLE events_totals_tally; DROP TABLE events_totals_state')
      const asMain = await serve(app, reads, statements)
      assert.ok(asMain.every(read => read.status === 200), JSON.stringify(asMain.filter(read => read.status !== 200)))
      assert.ok(asMain.some(read => read.body.includes('"left_out_feed_rooms":{"count":')), 'the reads count a feed room')

      await pool.query(migration)
      assert.deepEqual(await serve(app, reads, statements), asMain, 'the tally present and empty')
      await foldAll(pool)
      const checked = await check.runHourlyEventsTotalsCheck(db, new Date('2026-11-14T03:00:00Z'))
      assert.equal(checked.state === 'recorded' && checked.trusted, true)
      assert.deepEqual(await serve(app, reads, statements), asMain, 'the tally full, checked and trusted')
      await pool.query(`UPDATE events_totals_tally SET items = items + 1000, text_bytes = text_bytes + 7`)
      await pool.query('UPDATE events_totals_state SET trusted = TRUE')
      assert.deepEqual(await serve(app, reads, statements), asMain, 'the tally wrong and still marked trusted')

      assert.ok(statements.length > reads.length * 3, `observed ${statements.length} statements`)
      const touching = statements.filter(text => /events_totals/iu.test(text))
      assert.deepEqual(touching, [], 'no read statement touches the tally')
    })
  } finally {
    await postgres.stop()
  }
})
