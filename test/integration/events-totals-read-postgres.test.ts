// The events list's totals from the kept count (decision #196, step 2) against real
// PostgreSQL: the real schema, the real change-marker trigger, the real routes. While the
// count may be trusted, the kept read must equal today's full count on every page shape
// and kind, through every case that reaches back into old history and while writes land;
// as soon as it may not be trusted, or its state row is gone, the read counts today's
// way; the 1.5 s guard and its two slots still decide busy; and every page that shows
// these totals shows the same numbers, byte for byte, whichever path answered.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import type { PublicEventFilters, PublicPage } from '../../src/public-pagination.ts'
import { FOUNDER, GROWER, NEIGHBOUR, type CityApp, type Json } from '../helpers/abilities-fixtures.ts'
import {
  assertKeptReadMatchesList,
  changeMarker,
  insertEvents,
  insertThing,
  moveThing,
  setFeed,
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
const UNLIMITED = Object.freeze({ chunkChanges: 1_000_000, maxChunks: 1_000, budgetMs: 600_000 })
const BASE: PublicEventFilters = Object.freeze({
  kind: null, actor: null, placeId: null, includeDescendants: false, withinSeconds: null, afterId: null,
})
const KEPT = '/* public:events-kept */'
const COUNTED = 'These totals count the whole filtered list'
const EXACT_SLOTS = 524_128_259

function pageOf(limit: number, cursor: number | null = null): PublicPage {
  return Object.freeze({ ok: true, cursor, limit, fetchLimit: limit + 1 })
}

function moved(placeId: unknown): Record<string, unknown> {
  return { target_type: 'thing', operation: 'move', place_id: placeId, actor: 'founder' }
}

/** A fresh city with the two seeded rooms and `extra` more on the same continent. */
async function cityWithRooms(pool: Pool, extra: number): Promise<Readonly<{ continentId: number; rooms: readonly number[] }>> {
  const seeded = await resetCity(RESIDENTS)
  const rooms = [seeded.westRoomId, seeded.eastRoomId]
  for (let index = 0; index < extra; index += 1) {
    const row = await pool.query<{ id: number }>(
      `INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_notes)
       VALUES ($1, 'place', $2, 'an extra room', 1, TRUE) RETURNING id`,
      [seeded.continentId, `Room ${index}`],
    )
    rooms.push(Number(row.rows[0]!.id))
  }
  return Object.freeze({ continentId: seeded.continentId, rooms: Object.freeze(rooms) })
}

type Shape = readonly [string, PublicEventFilters, PublicPage]

async function everyShape(pool: Pool): Promise<readonly Shape[]> {
  const ids = (await pool.query<{ id: number }>('SELECT id FROM events ORDER BY id')).rows.map(row => Number(row.id))
  const kinds = (await pool.query<{ kind: string }>('SELECT DISTINCT kind FROM events ORDER BY kind')).rows.map(row => row.kind)
  const middle = ids[Math.floor(ids.length / 2)] ?? 1
  const low = ids[Math.floor(ids.length / 5)] ?? 1
  const shapes: Shape[] = [
    ['first page', BASE, pageOf(3)],
    ['before_id', BASE, pageOf(3, middle)],
    ['after_id', { ...BASE, afterId: middle }, pageOf(3)],
    ['both ends', { ...BASE, afterId: low }, pageOf(3, middle)],
    ['limit 200', BASE, pageOf(200)],
  ]
  for (const kind of [...kinds, 'never_written']) {
    shapes.push([`kind ${kind}`, { ...BASE, kind }, pageOf(2)])
    shapes.push([`kind ${kind} before_id`, { ...BASE, kind }, pageOf(2, middle)])
    shapes.push([`kind ${kind} after_id`, { ...BASE, kind, afterId: low }, pageOf(2)])
  }
  return shapes
}

async function assertEveryShapeMatches(pool: Pool, label: string): Promise<number> {
  let fresh = 0
  for (const [shape, filters, page] of await everyShape(pool)) {
    fresh = (await assertKeptReadMatchesList(pool, filters, page, `${label}: ${shape}`)).freshChanges
  }
  return fresh
}

type Served = Readonly<{ path: string; reader: string; status: number; headers: string; body: string; statements: readonly string[] }>

const SERVED_HEADERS = ['content-type', 'cache-control', 'vary', 'etag', 'retry-after'] as const

async function serve(
  app: CityApp,
  reads: ReadonlyArray<Readonly<{ path: string; secret: string | null }>>,
): Promise<readonly Served[]> {
  const served: Served[] = []
  for (const read of reads) {
    const statements: string[] = []
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
        statements: Object.freeze(statements),
      }))
    })
  }
  return Object.freeze(served)
}

const answers = (served: readonly Served[]) => served.map(({ statements: _statements, ...answer }) => answer)

/** Whether the kept count may answer this read's totals: the events list with no actor, place or time filter. */
function switched(path: string): boolean {
  const url = new URL(`http://city.test${path}`)
  return url.pathname === '/api/events'
    && !['actor', 'place_id', 'within_place_id', 'within_seconds'].some(name => url.searchParams.has(name))
}

async function mcpBrowse(app: CityApp, secret: string, args: Json): Promise<Json> {
  const response = await app.request('http://city.test/mcp', {
    method: 'POST',
    headers: { ...bearer(secret), accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browse', arguments: args } }),
  })
  assert.equal(response.status, 200)
  const payload = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  assert.equal(payload.result.isError, false, payload.result.content[0]?.text)
  return JSON.parse(payload.result.content[0]!.text) as Json
}

test('the events list totals from the kept count against real PostgreSQL', { timeout: 1_800_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('events-totals-read')
  const pool = postgres.client
  const db = tallyDatabase(pool)
  const tally = await import('../../src/events-totals-tally.ts')
  const check = await import('../../src/events-totals-check.ts')
  const { loadEventsListCollection } = await import('../../src/events-totals-read.ts')
  const { executeBudgetedExactQuery, PUBLIC_EXACT_READ_BUSY_MESSAGE } = await import('../../src/public-exact-query.ts')
  const { loadPublicEventCollectionRows } = await import('../../src/public-pagination.ts')
  let checkHour = Date.UTC(2026, 10, 21, 0)

  const foldAll = async (): Promise<void> => {
    const folded = await tally.foldSettledEvents(db, UNLIMITED)
    assert.equal(folded.state, 'folded')
    assert.equal(folded.caughtUp, true)
  }
  const checkNow = async () => {
    checkHour += 3_600_000
    return await check.runHourlyEventsTotalsCheck(db, new Date(checkHour))
  }
  const trustCount = async (): Promise<void> => {
    await foldAll()
    const checked = await checkNow()
    assert.equal(checked.state, 'recorded')
    assert.equal(checked.state === 'recorded' && checked.trusted, true)
  }
  // The route's own read: the real budgeted executor (one READ COMMITTED read-only
  // transaction, the production mode), with the statements it sent.
  const routeRead = async (filters: PublicEventFilters, page: PublicPage, environment: Readonly<Record<string, string>> = {}) => {
    const sent: string[] = []
    const result = await withNoteSuiteQueryObserver(text => { sent.push(text); return text }, async () => (
      await loadEventsListCollection(executeBudgetedExactQuery, filters, page, environment)
    ))
    const paths = sent.filter(text => text.includes('/* public:budgeted-exact */'))
      .map(text => text.includes(KEPT) ? 'kept' : text.includes(COUNTED) ? 'today' : 'other')
    return Object.freeze({ result, paths })
  }
  const todayRead = async (filters: PublicEventFilters, page: PublicPage) => (
    await loadPublicEventCollectionRows(executeBudgetedExactQuery, filters, page)
  )

  try {
    await t.test('every case that reaches back into old history: the kept read equals today\'s on every page shape and kind', async () => {
      const { rooms } = await cityWithRooms(pool, 14)
      const [west, east, north, south, ...more] = rooms as [number, number, number, number, ...number[]]
      const thing = await insertThing(pool, west)
      const other = await insertThing(pool, east)
      const laterThingId = other + 1
      const seeds: EventSeed[] = [
        { kind: 'note', detail: { place_id: west, note_id: 1, body: 'héllo west' } },
        { kind: 'note', detail: { place_id: east, note_id: 2, body: 'east' } },
        { kind: 'line_said', detail: { place_id: north, body: 'a line in north' } },
        { kind: 'thing_created', detail: { thing_id: thing, description: 'made' } },
        { kind: 'thing_edited', detail: { thing_id: other, description: 'edited' } },
        { kind: 'thing_edited', detail: { thing_id: laterThingId, description: 'not made yet' } },
        { kind: 'ping_sent', detail: { place_id: south } },
        { kind: 'action', detail: { applied_public_activity: [moved(west)] } },
        { kind: 'action', detail: { applied_public_activity: [moved(west), moved(east)] } },
        { kind: 'effect_resolved', detail: { applied_public_activity: [moved(west), { target_type: 'place', operation: 'move', place_id: west, actor: 'founder' }] } },
        { kind: 'room_reached', detail: { applied_public_activity: [moved(null)] } },
        { kind: 'transfer', detail: { asset_type: 'thing', asset_id: thing, reason: 'a gift' } },
        { kind: 'place_created', detail: { place_id: north } },
      ]
      await insertEvents(pool, seeds)
      await trustCount()
      await assertEveryShapeMatches(pool, 'no feed room')
      await setFeed(pool, west, true)
      await assertEveryShapeMatches(pool, 'one feed room')
      for (const room of [east, north, south, ...more.slice(0, 8)]) await setFeed(pool, room, true)
      assert.equal(Number((await pool.query('SELECT count(*) FROM places WHERE feed')).rows[0]!.count), 12)
      await assertEveryShapeMatches(pool, 'twelve feed rooms')
      await pool.query('UPDATE places SET feed = FALSE WHERE feed')
      await setFeed(pool, west, true)
      await moveThing(pool, other, west)
      await assertEveryShapeMatches(pool, 'a thing moved into the feed room')
      await moveThing(pool, other, east)
      await assertEveryShapeMatches(pool, 'the thing moved out again')
      await setFeed(pool, west, false)
      await assertEveryShapeMatches(pool, 'west stops being a feed room')
      await setFeed(pool, west, true)
      assert.equal(await insertThing(pool, west, 'born later'), laterThingId)
      await assertEveryShapeMatches(pool, 'a thing an old event named is made later, in a feed room')

      // Written after the last fold: the kept part plus the fresh part.
      await pool.query(`INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('note', 1, 'remove', 1, 'flooding')`)
      await insertEvents(pool, [{ kind: 'moderation', detail: { target_type: 'note', target_id: 1, action: 'remove', reason: 'flooding' } }])
      await pool.query('UPDATE things SET withdrawn_at = now() WHERE id = $1', [thing])
      await insertEvents(pool, [
        { kind: 'thing_withdrawn', detail: { thing_id: thing } },
        { kind: 'thing_ended', detail: { thing_id: thing, reason: 'its ending came' } },
        { kind: 'note', detail: { place_id: west, body: 'fresh in the feed room' } },
        { kind: 'action', detail: { applied_public_activity: [moved(west), moved(east)] } },
      ])
      assert.ok(await assertEveryShapeMatches(pool, 'a removed note, a withdrawn and ended thing, all after the fold') > 0)
      await foldAll()
      assert.equal(await assertEveryShapeMatches(pool, 'after the next fold'), 0)
      await insertEvents(pool, [{ kind: 'note', detail: { place_id: east, body: 'before the feed change' } }])
      await setFeed(pool, east, true)
      await insertEvents(pool, [{ kind: 'note', detail: { place_id: east, body: 'after the feed change' } }])
      assert.ok(await assertEveryShapeMatches(pool, 'fresh events with a feed change between them') > 0)
      assert.equal((await tallyState(pool)).trusted, true)
    })

    await t.test('a writer holding the change lock while a fold and both reads run, then committing', async () => {
      const { rooms } = await cityWithRooms(pool, 0)
      const [west, east] = rooms as [number, number]
      await setFeed(pool, west, true)
      await insertEvents(pool, Array.from({ length: 20 }, (_, index) => ({
        kind: index % 2 ? 'note' : 'line_said', detail: { place_id: index % 3 ? west : east, body: `n${index}` },
      })))
      await trustCount()
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(`INSERT INTO events (kind, actor, detail) VALUES ('note', 'founder', $1), ('note', 'founder', $2)`,
          [JSON.stringify({ place_id: west, body: 'held open' }), JSON.stringify({ place_id: east, body: 'held too' })])
        const marker = await changeMarker(pool)
        const folded = await tally.foldSettledEvents(db, { chunkChanges: 3, maxChunks: 1_000, budgetMs: 60_000 })
        assert.equal(folded.keptChangeId?.toString(), marker, 'the fold stops at the settled marker')
        for (const kind of [null, 'note']) {
          assert.equal((await assertKeptReadMatchesList(pool, { ...BASE, kind }, pageOf(5), `held, kind ${kind}`)).freshChanges, 0)
        }
        await holder.query('COMMIT')
      } finally {
        holder.release()
      }
      for (const kind of [null, 'note']) {
        assert.equal((await assertKeptReadMatchesList(pool, { ...BASE, kind }, pageOf(5), `committed, kind ${kind}`)).freshChanges, 2)
      }
      await foldAll()
      assert.equal((await assertKeptReadMatchesList(pool, BASE, pageOf(5), 'folded')).freshChanges, 0)
    })

    await t.test('about 300 rounds of writers, rollbacks, folds, moves and feed changes while a reader compares both paths', async () => {
      const { rooms } = await cityWithRooms(pool, 2)
      const [west, east, north] = rooms as [number, number, number]
      await setFeed(pool, west, true)
      const things = [await insertThing(pool, west), await insertThing(pool, east)]
      await insertEvents(pool, Array.from({ length: 50 }, (_, index) => ({
        kind: 'note', detail: { place_id: index % 2 ? west : east, body: `seed ${index}` },
      })))
      await trustCount()
      let random = 20261120
      const next = () => { random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0; return random / 2 ** 32 }
      const seed = (round: number, writer: number): EventSeed => {
        const pick = next()
        const room = [west, east, north][Math.floor(next() * 3)]
        if (pick < 0.3) return { kind: 'note', detail: { place_id: room, body: `r${round} w${writer}` } }
        if (pick < 0.5) return { kind: 'thing_edited', detail: { thing_id: things[Math.floor(next() * 2)], description: 'x'.repeat(round % 7) } }
        if (pick < 0.7) return { kind: 'action', detail: { applied_public_activity: next() < 0.5 ? [moved(room)] : [moved(west), moved(room)] } }
        if (pick < 0.85) return { kind: 'transfer', detail: { asset_type: 'thing', asset_id: things[0], reason: 'trade' } }
        return { kind: 'ping_sent', detail: { place_id: room } }
      }
      const write = async (round: number, writer: number): Promise<void> => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const events = Array.from({ length: 1 + Math.floor(next() * 3) }, () => seed(round, writer))
          await client.query(
            `INSERT INTO events (kind, actor, detail)
             SELECT seed.kind, 'founder', seed.detail FROM jsonb_to_recordset($1::jsonb) AS seed(kind text, detail jsonb)`,
            [JSON.stringify(events)],
          )
          await client.query(next() < 0.2 ? 'ROLLBACK' : 'COMMIT')
        } finally {
          client.release()
        }
      }
      const shapes: readonly Shape[] = [
        ['first page', BASE, pageOf(5)],
        ['kind note', { ...BASE, kind: 'note' }, pageOf(5)],
        ['before_id', BASE, pageOf(5, 1_000_000)],
        ['kind thing_edited after_id', { ...BASE, kind: 'thing_edited', afterId: 3 }, pageOf(5)],
        ['kind action', { ...BASE, kind: 'action' }, pageOf(5)],
      ]
      const keptMarkers = new Set<string>()
      let freshReads = 0
      const rounds = 300
      for (let round = 0; round < rounds; round += 1) {
        const [label, filters, page] = shapes[round % shapes.length]!
        const [, , , compared] = await Promise.all([
          write(round, 0),
          write(round, 1),
          tally.foldSettledEvents(db, { chunkChanges: 1 + (round % 4), maxChunks: 2, budgetMs: 60_000 }),
          assertKeptReadMatchesList(pool, filters, page, `round ${round}: ${label}`),
        ])
        if (compared.freshChanges > 0) freshReads += 1
        keptMarkers.add(String((await tallyState(pool)).kept_change_id))
        if (round % 40 === 13) await moveThing(pool, things[round % 2]!, [west, east, north][round % 3]!)
        if (round % 60 === 29) await setFeed(pool, north, round % 120 === 29)
      }
      assert.ok(keptMarkers.size > 50, `the kept marker moved ${keptMarkers.size} times`)
      assert.ok(freshReads > 50, `${freshReads} reads counted a fresh part`)
      assert.equal((await tallyState(pool)).trusted, true)

      // The production mode right after the writers stop: one READ COMMITTED statement.
      const viaRoute = await routeRead(BASE, pageOf(10))
      assert.deepEqual(viaRoute.paths, ['kept'])
      assert.deepEqual(viaRoute.result, await todayRead(BASE, pageOf(10)))
    })

    await t.test('the count turning untrusted or its state row going missing between two reads falls back to today\'s count', async () => {
      const { rooms } = await cityWithRooms(pool, 0)
      const [west, east] = rooms as [number, number]
      await setFeed(pool, west, true)
      await insertEvents(pool, [
        { kind: 'line_said', detail: { place_id: west, body: 'only in the feed room' } },
        { kind: 'note', detail: { place_id: east, body: 'kept in' } },
        { kind: 'note', detail: { place_id: west, body: 'kept out' } },
      ])
      await trustCount()
      const shapes: readonly Shape[] = [
        ['first page', BASE, pageOf(5)],
        ['kind note', { ...BASE, kind: 'note' }, pageOf(5)],
        ['before_id', BASE, pageOf(5, 1_000_000)],
      ]
      const expectPaths = async (label: string, paths: readonly string[], environment: Readonly<Record<string, string>> = {}) => {
        for (const [shape, filters, page] of shapes) {
          const read = await routeRead(filters, page, environment)
          assert.deepEqual(read.paths, paths, `${label}: ${shape}`)
          assert.deepEqual(read.result, await todayRead(filters, page), `${label}: ${shape}`)
        }
      }
      await expectPaths('trusted', ['kept'])
      // The database itself refuses trusted while held off or not caught up, so those two
      // states always come with trusted off.
      const cases: ReadonlyArray<readonly [string, string, string]> = [
        ['not trusted', 'UPDATE events_totals_state SET trusted = FALSE', 'UPDATE events_totals_state SET trusted = TRUE'],
        ['paused', 'UPDATE events_totals_state SET paused = TRUE', 'UPDATE events_totals_state SET paused = FALSE'],
        ['held off', 'UPDATE events_totals_state SET trusted = FALSE, held_off = TRUE',
          'UPDATE events_totals_state SET held_off = FALSE, trusted = TRUE'],
        ['not caught up', 'UPDATE events_totals_state SET trusted = FALSE, caught_up_at = NULL',
          "UPDATE events_totals_state SET caught_up_at = '2026-11-12T17:55:23.910Z', trusted = TRUE"],
        ['an older rule version', 'UPDATE events_totals_state SET rule_version = 0', 'UPDATE events_totals_state SET rule_version = 1'],
        ['the state row missing',
          'CREATE TABLE saved_events_totals_state AS SELECT * FROM events_totals_state; DELETE FROM events_totals_state',
          'INSERT INTO events_totals_state SELECT * FROM saved_events_totals_state; DROP TABLE saved_events_totals_state'],
      ]
      for (const [label, enter, leave] of cases) {
        await pool.query(enter)
        await expectPaths(label, ['kept', 'today'])
        await pool.query(leave)
        await expectPaths(`${label}, restored`, ['kept'])
      }
      await expectPaths('EVENTS_TOTALS_TALLY=off', ['today'], { EVENTS_TOTALS_TALLY: 'off' })

      // A wrong room row, still marked trusted, that drives a kept total below zero.
      await pool.query(`UPDATE events_totals_tally SET items = items * 2, text_bytes = text_bytes * 2
        WHERE key_type = 'place' AND kind = 'line_said'`)
      const lineSaid = await routeRead({ ...BASE, kind: 'line_said' }, pageOf(5))
      assert.deepEqual(lineSaid.paths, ['kept', 'today'])
      assert.deepEqual(lineSaid.result, await todayRead({ ...BASE, kind: 'line_said' }, pageOf(5)))
      const { default: app } = await import('../../src/index.ts') as { default: CityApp }
      const served = await app.request('http://city.test/api/events?kind=line_said')
      assert.equal(served.status, 200, await served.text())
      await pool.query(`UPDATE events_totals_tally SET items = items / 2, text_bytes = text_bytes / 2
        WHERE key_type = 'place' AND kind = 'line_said'`)
      await expectPaths('the wrong row put back', ['kept'])
    })

    await t.test('with both exact-read slots taken, a switched read is busy whether or not the count may be used', async () => {
      const { default: app } = await import('../../src/index.ts') as { default: CityApp }
      await cityWithRooms(pool, 0)
      await insertEvents(pool, [{ kind: 'note', detail: { body: 'one' } }])
      await trustCount()
      const holders = [await pool.connect(), await pool.connect()]
      try {
        await holders[0]!.query('SELECT pg_advisory_lock($1, 0)', [EXACT_SLOTS])
        await holders[1]!.query('SELECT pg_advisory_lock($1, 1)', [EXACT_SLOTS])
        for (const trusted of [true, false]) {
          await pool.query('UPDATE events_totals_state SET trusted = $1', [trusted])
          for (const path of ['/api/events', '/api/events?kind=note', '/api/events?before_id=1000000']) {
            const response = await app.request(`http://city.test${path}`)
            assert.equal(response.status, 503, `${path}, trusted ${trusted}`)
            assert.equal(response.headers.get('retry-after'), '1')
            assert.ok((await response.text()).includes(PUBLIC_EXACT_READ_BUSY_MESSAGE))
          }
        }
      } finally {
        for (const [slot, holder] of holders.entries()) {
          await holder.query('SELECT pg_advisory_unlock($1, $2)', [EXACT_SLOTS, slot]).catch(() => undefined)
          holder.release()
        }
      }
      const freed = await app.request('http://city.test/api/events')
      assert.equal(freed.status, 200)
    })

    await t.test("every page that shows these totals is byte for byte the same with the count untrusted, trusted, and caught wrong", async () => {
      const { default: app } = await import('../../src/index.ts') as { default: CityApp }
      const { continentId, rooms } = await cityWithRooms(pool, 0)
      const [west, east] = rooms as [number, number]
      const thing = await insertThing(pool, west)
      await setFeed(pool, west, true)
      await insertEvents(pool, Array.from({ length: 30 }, (_, index) => ({
        kind: ['note', 'thing_edited', 'action', 'transfer', 'line_said'][index % 5]!,
        actor: index % 3 === 0 ? NEIGHBOUR.handle : FOUNDER.handle,
        detail: index % 5 === 1 ? { thing_id: thing, description: `edit ${index}` }
          : index % 5 === 2 ? { applied_public_activity: [moved(index % 2 ? west : east)] }
            : { place_id: index % 2 ? west : east, body: `item ${index}` },
      })))
      const muted = await app.request('http://city.test/api/me/settings', {
        method: 'PATCH', headers: bearer(GROWER.secret), body: JSON.stringify({ mute: { type: 'resident', id: NEIGHBOUR.id } }),
      })
      assert.equal(muted.status, 200, await muted.text())
      await trustCount()
      await insertEvents(pool, [{ kind: 'note', detail: { place_id: west, body: 'after the fold' } }])
      const ids = (await pool.query<{ id: number }>('SELECT id FROM events ORDER BY id')).rows.map(row => Number(row.id))
      const middle = ids[Math.floor(ids.length / 2)]!
      const marker = await changeMarker(pool)
      const reads: Array<Readonly<{ path: string; secret: string | null }>> = []
      // The events list as callers and MCP browse view=events read it.
      for (const secret of [null, GROWER.secret]) {
        for (const path of [
          '/api/events', '/api/events?limit=5', `/api/events?limit=5&before_id=${middle}`,
          `/api/events?limit=5&after_id=${middle}`, '/api/events?kind=note', '/api/events?kind=thing_edited',
          '/api/events?kind=action&limit=3', '/api/events?kind=never_written', `/api/events?actor=${NEIGHBOUR.handle}`,
          `/api/events?place_id=${east}`, '/api/events?within_seconds=600', `/api/events?after_change_marker=${marker}`,
          '/api/events?hidden=outline&limit=4',
        ]) reads.push({ path, secret })
      }
      // The window's history reads (src/window-client/program/33-agreements-and-history-controls.ts),
      // its outline, and the other city-wide reads that count feed rooms or events.
      for (const path of [
        '/api/events?limit=50', `/api/events?limit=50&within_place_id=${continentId}`,
        `/api/events?limit=50&actor=${FOUNDER.handle}`, `/api/events?limit=50&before_id=${middle}`,
        `/api/events?limit=50&before_id=${ids.at(-1)}&after_id=${ids[2]}`,
        `/api/events?limit=50&after_change_marker=${marker}`,
        `/api/events?limit=50&within_place_id=${continentId}&after_change_marker=${marker}`,
        '/api/window', '/api/changes', '/api/changes?since=0&limit=20',
      ]) reads.push({ path, secret: null })

      await pool.query('UPDATE events_totals_state SET trusted = FALSE')
      const untrusted = await serve(app, reads)
      assert.ok(untrusted.every(read => read.status === 200), JSON.stringify(untrusted.filter(read => read.status !== 200)))
      assert.ok(untrusted.some(read => read.body.includes('"left_out_feed_rooms":{"count":')), 'the reads count a feed room')
      await pool.query('UPDATE events_totals_state SET trusted = TRUE')
      const trusted = await serve(app, reads)
      assert.deepEqual(answers(trusted), answers(untrusted), 'the count trusted')
      for (const read of trusted) {
        if (switched(read.path)) {
          assert.ok(read.statements.some(text => text.includes(KEPT)), `${read.path} used the kept count`)
          assert.ok(!read.statements.some(text => text.includes(COUNTED)), `${read.path} did not count the whole list`)
        } else {
          assert.ok(!read.statements.some(text => /events_totals/u.test(text)), `${read.path} never reads the tally`)
        }
      }

      // MCP browse view=events calls the same route, so it gives the same totals.
      for (const args of [{ view: 'events' }, { view: 'events', kind: 'note' }, { view: 'events', before_id: middle }]) {
        const query = new URLSearchParams(Object.entries(args).filter(([key]) => key !== 'view').map(([key, value]) => [key, String(value)]))
        const direct = await (await app.request(`http://city.test/api/events?${query}`, { headers: { authorization: `Bearer ${FOUNDER.secret}` } })).json() as Json
        const statements: string[] = []
        const browsed = await withNoteSuiteQueryObserver(text => { statements.push(text); return text }, async () => (
          await mcpBrowse(app, FOUNDER.secret, args)
        ))
        assert.ok(statements.some(text => text.includes(KEPT)), `browse ${JSON.stringify(args)} used the kept count`)
        for (const field of ['total_items', 'total_text_bytes', 'left_out_feed_rooms', 'has_more', 'next_before_id']) {
          assert.deepEqual(browsed[field], direct[field], `browse ${JSON.stringify(args)}: ${field}`)
        }
        assert.deepEqual((browsed.events as Json[]).map(event => event.id), (direct.events as Json[]).map(event => event.id))
      }

      // A wrong count still marked trusted is served by the switched reads only, until
      // the hourly check catches it; then every read matches again.
      await pool.query(`UPDATE events_totals_tally SET items = items + 1000, text_bytes = text_bytes + 7 WHERE key_type = 'all'`)
      const wrong = await serve(app, reads)
      for (const [index, read] of wrong.entries()) {
        if (switched(read.path)) {
          if (!read.path.includes('never_written')) assert.notEqual(read.body, untrusted[index]!.body, `${read.path} answers from the count`)
        } else {
          assert.deepEqual(answers([read]), answers([untrusted[index]!]), `${read.path} is unchanged`)
        }
      }
      const caught = await checkNow()
      assert.equal(caught.state === 'recorded' && caught.observation.ok, false)
      assert.equal((await tallyState(pool)).trusted, false)
      assert.deepEqual(answers(await serve(app, reads)), answers(untrusted), 'caught and counted today\'s way')
      await trustCount()
      const rebuilt = await serve(app, reads)
      assert.deepEqual(answers(rebuilt), answers(untrusted), 'rebuilt and trusted again')
      assert.ok(rebuilt.filter(read => switched(read.path)).every(read => read.statements.some(text => text.includes(KEPT))))
    })
  } finally {
    await postgres.stop()
  }
})
