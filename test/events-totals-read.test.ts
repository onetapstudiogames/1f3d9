// Which events list reads take their totals from the kept count (decision #196, step 2),
// with a fake executor that records every statement. Switched shapes (no filter, one
// kind, before_id, after_id, both ends, limit, hidden) send the kept statement first and
// nothing else when it answers; every filter the count cannot answer sends only today's
// statement. A closed gate, a missing state row, an impossible total or the environment
// switch turn the read back to today's statement; a busy kept read stays busy. The same
// paths against real PostgreSQL are in test/integration/events-totals-read-postgres.test.ts.
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadEventsListCollection } from '../src/events-totals-read.ts'
import {
  eventTotalsFromKeptCount,
  loadPublicEventCollectionRows,
  type PublicEventFilters,
  type PublicPage,
} from '../src/public-pagination.ts'
import { PublicExactReadBusyError } from '../src/public-exact-query.ts'

const KEPT = '/* public:events-kept */'
const TODAY = '/* public:events */'
const PAGE: PublicPage = Object.freeze({ ok: true, cursor: null, limit: 2, fetchLimit: 3 })

type Rows = readonly Record<string, unknown>[]

const pageRows = (extra: Record<string, unknown>): Rows => [
  { id: 9, change_id: '19', at: '2026-11-20T00:00:00.000Z', kind: 'note', actor: 'founder', detail: {}, thing_has_drawing: null, ...extra },
  { id: 8, change_id: '18', at: '2026-11-20T00:00:00.000Z', kind: 'note', actor: 'founder', detail: {}, thing_has_drawing: null, ...extra },
]

const TODAY_TOTALS = { total_items: 7, total_text_bytes: 40, left_out_feed_rooms: 2, left_out_feed_room_ids: [12] }
const KEPT_TOTALS = { total_items: '7', total_text_bytes: '40', left_out_feed_rooms: '2', left_out_feed_room_ids: [12] }

function recorder(kept: (() => Rows) | Rows = pageRows({ ...KEPT_TOTALS, kept_state_rows: 1 })) {
  const sent: string[] = []
  const query = async (text: string): Promise<Rows> => {
    sent.push(text.includes(KEPT) ? 'kept' : text.includes(TODAY) ? 'today' : 'other')
    if (text.includes(KEPT)) return typeof kept === 'function' ? kept() : kept
    return pageRows(TODAY_TOTALS)
  }
  return { sent, query }
}

const base: PublicEventFilters = Object.freeze({
  kind: null, actor: null, placeId: null, includeDescendants: false, withinSeconds: null, afterId: null,
})

const SWITCHED: ReadonlyArray<readonly [string, PublicEventFilters, PublicPage]> = [
  ['no filter', base, PAGE],
  ['kind', { ...base, kind: 'note' }, PAGE],
  ['an unknown kind', { ...base, kind: 'never_written' }, PAGE],
  ['before_id', base, { ...PAGE, cursor: 40 }],
  ['after_id', { ...base, afterId: 3 }, PAGE],
  ['both ends', { ...base, afterId: 3 }, { ...PAGE, cursor: 40 }],
  ['kind and both ends', { ...base, kind: 'transfer', afterId: 3 }, { ...PAGE, cursor: 40 }],
  ['a large limit', base, { ok: true, cursor: null, limit: 200, fetchLimit: 201 }],
]

const UNCHANGED: ReadonlyArray<readonly [string, PublicEventFilters]> = [
  ['actor', { ...base, actor: 'founder' }],
  ['actor and kind', { ...base, actor: 'founder', kind: 'note' }],
  ['place_id', { ...base, placeId: 3 }],
  ['place_id and kind', { ...base, placeId: 3, kind: 'note' }],
  ['within_place_id', { ...base, placeId: 3, includeDescendants: true }],
  ['within_place_id and kind', { ...base, placeId: 3, includeDescendants: true, kind: 'note' }],
  ['within_seconds', { ...base, withinSeconds: 60 }],
  ['within_seconds and kind', { ...base, withinSeconds: 60, kind: 'note' }],
  ['actor and place_id', { ...base, actor: 'founder', placeId: 3 }],
  ['actor, within_seconds and after_id', { ...base, actor: 'founder', withinSeconds: 60, afterId: 3 }],
]

const ON = Object.freeze({})

test('switched shapes send only the kept statement when the count may be used', async () => {
  for (const [label, filters, page] of SWITCHED) {
    assert.equal(eventTotalsFromKeptCount(filters), true, label)
    const { sent, query } = recorder()
    const read = await loadEventsListCollection(query, filters, page, ON)
    assert.deepEqual(sent, ['kept'], label)
    assert.deepEqual(read.total, { items: 7, textBytes: 40 }, label)
    assert.equal(read.leftOutFeedRooms.count, 2, label)
    assert.deepEqual(read.leftOutFeedRooms.place_ids, [12], label)
    assert.ok(read.rows.every(row => !('kept_state_rows' in row) && !('total_items' in row)), label)
    assert.deepEqual(read.rows.map(row => row.id), [9, 8], label)
  }
})

test('the kept answer has the same shape and numbers as today\'s answer for the same totals', async () => {
  const today = await loadPublicEventCollectionRows(recorder().query, base, PAGE)
  const kept = await loadEventsListCollection(recorder().query, base, PAGE, ON)
  assert.deepEqual(kept, today)
})

test('filters the count cannot answer send only today\'s statement', async () => {
  for (const [label, filters] of UNCHANGED) {
    assert.equal(eventTotalsFromKeptCount(filters), false, label)
    for (const page of [PAGE, { ...PAGE, cursor: 40 }]) {
      const { sent, query } = recorder()
      await loadEventsListCollection(query, filters, page, ON)
      assert.deepEqual(sent, ['today'], label)
    }
  }
})

test('a closed gate, a missing state row or an impossible kept total reads today\'s way', async () => {
  const cases: ReadonlyArray<readonly [string, Rows]> = [
    ['gate closed', pageRows({ ...KEPT_TOTALS, kept_state_rows: 0 })],
    ['gate closed, empty page', [{ id: null, ...KEPT_TOTALS, kept_state_rows: 0 }]],
    ['state rows not a number', pageRows({ ...KEPT_TOTALS, kept_state_rows: null })],
    ['two state rows', pageRows({ ...KEPT_TOTALS, kept_state_rows: 2 })],
    ['negative items', pageRows({ ...KEPT_TOTALS, total_items: '-1', kept_state_rows: 1 })],
    ['negative text bytes', pageRows({ ...KEPT_TOTALS, total_text_bytes: '-5', kept_state_rows: 1 })],
    ['negative left out', pageRows({ ...KEPT_TOTALS, left_out_feed_rooms: '-2', kept_state_rows: 1 })],
    ['left out without a room', pageRows({ ...KEPT_TOTALS, left_out_feed_room_ids: null, kept_state_rows: 1 })],
    ['a room without anything left out', pageRows({ ...KEPT_TOTALS, left_out_feed_rooms: '0', kept_state_rows: 1 })],
    ['beyond a safe integer', pageRows({ ...KEPT_TOTALS, total_items: '9007199254740993', kept_state_rows: 1 })],
    ['no row at all', []],
  ]
  for (const [label, keptRows] of cases) {
    const { sent, query } = recorder(keptRows)
    const read = await loadEventsListCollection(query, base, PAGE, ON)
    assert.deepEqual(sent, ['kept', 'today'], label)
    assert.deepEqual(read, await loadPublicEventCollectionRows(recorder().query, base, PAGE), label)
  }
})

test('EVENTS_TOTALS_TALLY=off sends no kept statement; unset, empty or on uses it', async () => {
  for (const value of ['off', 'OFF', '0', 'false']) {
    const { sent, query } = recorder()
    await loadEventsListCollection(query, base, PAGE, { EVENTS_TOTALS_TALLY: value })
    assert.deepEqual(sent, ['today'], value)
  }
  for (const value of [undefined, '', 'on']) {
    const { sent, query } = recorder()
    await loadEventsListCollection(query, base, PAGE, { EVENTS_TOTALS_TALLY: value })
    assert.deepEqual(sent, ['kept'], String(value))
  }
})

test('a busy kept read answers busy and never falls back to the heavier count', async () => {
  const { sent, query } = recorder(() => { throw new PublicExactReadBusyError() })
  await assert.rejects(loadEventsListCollection(query, base, PAGE, ON), PublicExactReadBusyError)
  assert.deepEqual(sent, ['kept'])
})

test('the kept statement keeps the page part of today\'s statement and adds only the gate column', async () => {
  const texts: string[] = []
  const capture = async (text: string): Promise<Rows> => {
    texts.push(text)
    return [{ id: null, ...KEPT_TOTALS, kept_state_rows: 0, ...TODAY_TOTALS }]
  }
  await loadEventsListCollection(capture, base, PAGE, ON)
  const [kept, today] = texts as [string, string]
  assert.ok(kept.startsWith(KEPT) && today.startsWith(TODAY))
  const pagePart = (text: string) => text.slice(text.indexOf('LEFT JOIN LATERAL ('))
  assert.equal(pagePart(kept), pagePart(today))
  assert.match(kept, /totals\.state_rows AS kept_state_rows/u)
  assert.match(kept, /FROM events_totals_state WHERE singleton AND trusted AND NOT paused AND NOT held_off\s+AND caught_up_at IS NOT NULL AND rule_version = 1/u)
  assert.doesNotMatch(kept, /jit/iu, 'the reader sets nothing about JIT')
})
