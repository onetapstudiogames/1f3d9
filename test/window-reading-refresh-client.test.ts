import assert from 'node:assert/strict'
import test from 'node:test'
import { PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES } from '../src/window-client/program/13-branch-cache-and-history-entries.ts'
import { PART_30_DETAIL_RENDER_AND_BODIES } from '../src/window-client/program/30-detail-render-and-bodies.ts'
import { PART_34_HISTORY_LOADING_COUNTS_AND_SCOPE } from '../src/window-client/program/34-history-loading-counts-and-scope.ts'
import { mergeWindowRows } from '../src/window-client/rows.ts'
import {
  WINDOW_HISTORY_FILL_ROWS,
  WINDOW_HISTORY_KEEP_ROWS,
} from '../src/window-history-limits.ts'

type Row = Readonly<{ id: number, place_id?: number }>
type HistoryEntry = Readonly<{
  rows: readonly Row[]
  deferredRows?: readonly Row[]
  hasMore?: boolean
  nextBeforeId?: number | null
  refreshError?: boolean
  error?: boolean
  loading?: boolean
  initialized?: boolean
  olderRowsRemain?: boolean
  beyondFillIds?: readonly number[]
  filters?: Readonly<Record<string, unknown>>
}>
type Histories = Record<string, Record<string, HistoryEntry>>
type Snapshot = Record<string, unknown>

const COLLECTIONS = ['notes', 'things', 'agreements', 'events'] as const

function functionSource(part: string, name: string, nextName: string) {
  const start = part.indexOf(`  async function ${name}`)
  const end = part.indexOf(`  ${nextName}`, start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  return part.slice(start, end)
}

function sourceBetween(part: string, start: string, end: string) {
  const from = part.indexOf(start)
  const to = part.indexOf(end, from)
  assert.notEqual(from, -1, start)
  assert.notEqual(to, -1, end)
  return part.slice(from, to)
}

// Keeping, trimming and the connected cursor are the shared helpers both the
// refresh and the fill run, so both harnesses below load the same real source.
const KEEP_AND_CURSOR_SOURCE = sourceBetween(
  PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES,
  '  function keptHistoryRows',
  '  async function fillHistoryGap',
)

function rowsFrom(highest: number, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: highest - index }))
}

function ids(rows: readonly Row[] | undefined) {
  return (rows || []).map(row => row.id)
}

function snapshotOf(rows: Partial<Record<string, readonly Row[]>>): Snapshot {
  const snapshot: Record<string, unknown> = { pages: {} }
  for (const collection of COLLECTIONS) {
    const collectionRows = rows[collection] ?? []
    snapshot[collection] = collectionRows
    ;(snapshot.pages as Record<string, unknown>)[collection] = {
      hasMore: true, nextBeforeId: collectionRows.at(-1)?.id ?? null,
    }
  }
  return snapshot
}

function loadedEntry(rows: readonly Row[], entry: Partial<HistoryEntry> = {}): HistoryEntry {
  return Object.freeze({
    rows,
    deferredRows: [],
    hasMore: true,
    nextBeforeId: rows.at(-1)?.id ?? null,
    initialized: true,
    ...entry,
  })
}

// freshSnapshotHistories is a browser-program string, so the suite runs the real
// source with the surrounding window helpers replaced by fakes.
function refreshedHistories(
  previous: Partial<Histories>,
  snapshot: Snapshot,
  options: Readonly<{
    heldKeys?: readonly string[]
    invalidatedKeys?: readonly string[]
    // null says the window could not read what the city changed.
    changes?: readonly unknown[] | null
  }> = {},
): Histories {
  return new Function(
    'histories', 'snapshot', 'changes', 'viewerHeldRecordKeys', 'changedViewerRecordKeys',
    'historyViewerRecordKind', 'filterHistoryRows', 'mergeWindowRows',
    'WINDOW_HISTORY_KEEP_ROWS',
    `const state = { histories }; ${KEEP_AND_CURSOR_SOURCE}
     return freshSnapshotHistories(snapshot, changes)`,
  )(
    previous, snapshot, options.changes === undefined ? [] : options.changes,
    () => new Set(options.heldKeys ?? []),
    () => new Set(options.invalidatedKeys ?? []),
    (collection: string) => collection === 'notes' ? 'note'
      : collection === 'things' ? 'thing'
        : collection === 'agreements' ? 'agreement' : 'event',
    (_collection: string, rows: readonly Row[], filters: { placeId?: number }) =>
      filters?.placeId ? rows.filter(row => row.place_id === filters.placeId) : rows,
    mergeWindowRows,
    WINDOW_HISTORY_KEEP_ROWS,
  ) as Histories
}

// The automatic gap fill is a browser-program string too, so the suite runs the
// real source with fakes for the window helpers and the real row bound.
function historyGapFiller(fetchFake: (input: string) => Promise<unknown>) {
  const source = functionSource(
    PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES,
    'fillHistoryGap',
    'function mergeUnchangedSnapshotHistories',
  )
  return new Function(
    'historyRequestUrl', 'fetch', 'safeChangeMarker', 'markerCovers', 'normalizeHistoryRows',
    'mergeWindowRows', 'safeId', 'WINDOW_HISTORY_FILL_ROWS', 'WINDOW_HISTORY_KEEP_ROWS',
    `${KEEP_AND_CURSOR_SOURCE} ${source}; return rejoinSnapshotHistories`,
  )(
    (collection: string, options: { nextBeforeId: number | null },
      _filters: unknown, marker: string) =>
      new URL(`https://city.test/api/${collection}?before_id=${options.nextBeforeId ?? ''}` +
        `&after_change_marker=${marker ?? ''}`),
    fetchFake,
    (value: unknown) => typeof value === 'string' && /^[0-9]+$/.test(value) ? value : null,
    (actual: string | null, minimum: string | null) =>
      Boolean(actual && minimum && BigInt(actual) >= BigInt(minimum)),
    (collection: string, payload: Record<string, unknown>) => payload[collection],
    mergeWindowRows,
    (value: unknown) => Number(value) || null,
    WINDOW_HISTORY_FILL_ROWS,
    WINDOW_HISTORY_KEEP_ROWS,
  ) as (histories: Partial<Histories>, snapshot: Record<string, Row[]>, marker: string,
    signal: AbortSignal) => Promise<Histories>
}

function pagedFetch(pageSize: number, newest: number, floor = 0) {
  return async (input: string) => {
    const url = new URL(input, 'https://city.test')
    const collection = url.pathname.split('/').at(-1)!
    const before = Number(url.searchParams.get('before_id')) || newest + 1
    const rows = Array.from({ length: pageSize }, (_, index) => ({ id: before - 1 - index }))
      .filter(row => row.id > floor)
    const next = rows.at(-1)?.id ?? null
    return { ok: true, json: async () => ({
      [collection]: rows,
      change_marker: '8',
      has_more: next !== null && next > floor + 1,
      next_before_id: next,
    }) }
  }
}

// Ten rows a page from 400: a fill that spends its whole bound walks 399 down to
// 100 and never reaches the row at 10, the deep gap the report describes.
async function deepGapFetch(input: string) {
  const url = new URL(input, 'https://city.test')
  const collection = url.pathname.split('/').at(-1)!
  const before = Number(url.searchParams.get('before_id')) || 400
  const rows = collection === 'things'
    ? [{ id: 20 }]
    : Array.from({ length: 10 }, (_, index) => ({ id: before - 1 - index }))
  const next = rows.at(-1)!.id
  return { ok: true, json: async () => ({
    [collection]: rows,
    change_marker: '8',
    has_more: collection === 'notes',
    next_before_id: collection === 'notes' ? next : null,
  }) }
}

test('a changed refresh keeps every older page the reader loaded in every list it pages', () => {
  // Three loaded pages per list; the newest page still reaches the reader's own
  // top row, so nothing sits between them.
  const loaded = rowsFrom(400, 120)
  const previous = Object.fromEntries(COLLECTIONS.map(collection =>
    [collection, { all: loadedEntry(loaded) }]))
  const fresh = [{ id: 401 }, ...rowsFrom(400, 49)]
  const snapshot = snapshotOf(Object.fromEntries(
    COLLECTIONS.map(collection => [collection, fresh])))

  const histories = refreshedHistories(previous, snapshot)

  for (const collection of COLLECTIONS) {
    const entry = histories[collection]!.all!
    assert.deepEqual(ids(entry.rows), [401, ...ids(loaded)],
      `${collection} keeps every loaded row and the newly arrived one`)
    assert.deepEqual(entry.deferredRows, [],
      `${collection} newest page reaching the kept rows leaves no gap`)
    assert.equal(entry.nextBeforeId, 281,
      `${collection} load older continues from the lowest connected row`)
    assert.equal(entry.hasMore, true)
  }
})

test('a changed refresh keeps a filtered list it paged as well as the unfiltered one', () => {
  const loaded = rowsFrom(400, 60).map(row => ({ ...row, place_id: 11 }))
  const previous = {
    notes: {
      all: loadedEntry(loaded),
      'place:11|resident:': loadedEntry(loaded, { filters: { placeId: 11 } }),
    },
    things: {}, agreements: {}, events: {},
  }
  const fresh = [{ id: 401, place_id: 11 }, ...rowsFrom(400, 49).map(row => ({ ...row, place_id: 11 }))]

  const histories = refreshedHistories(previous, snapshotOf({ notes: fresh }))

  assert.deepEqual(ids(histories.notes!['place:11|resident:']!.rows), [401, ...ids(loaded)],
    'the filtered list keeps its own loaded pages')
  assert.equal(histories.notes!['place:11|resident:']!.nextBeforeId, 341)
})

test('a changed refresh that outruns the newest page names the gap above the kept rows', () => {
  const loaded = rowsFrom(400, 120)
  const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }
  // Every row of the newest page is new, so nothing proves the two ends join.
  const fresh = rowsFrom(500, 50)

  const entry = refreshedHistories(previous, snapshotOf({ notes: fresh })).notes!.all!

  assert.deepEqual(entry.deferredRows, [{ id: 400 }],
    'the top of the kept block is what the fill must reach')
  assert.equal(entry.nextBeforeId, 451, 'the cursor stays above the gap')
  assert.equal(entry.hasMore, true)
  assert.ok(ids(entry.rows).includes(281), 'the kept rows are still in the list')
})

test('the keep bound trims the oldest rows first', () => {
  const loaded = rowsFrom(5_000, WINDOW_HISTORY_KEEP_ROWS + 200)
  const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }

  const fresh = [{ id: 5_001 }, ...rowsFrom(5_000, 49)]

  const entry = refreshedHistories(previous, snapshotOf({ notes: fresh })).notes!.all!

  assert.equal(entry.rows.length, WINDOW_HISTORY_KEEP_ROWS)
  assert.equal(entry.rows[0]!.id, 5_001, 'the newest row is kept')
  assert.equal(entry.rows.at(-1)!.id, 5_002 - WINDOW_HISTORY_KEEP_ROWS,
    'the oldest rows are the ones dropped')
  assert.equal(entry.hasMore, true, 'a trimmed list still offers its older records')
  assert.equal(entry.nextBeforeId, 5_002 - WINDOW_HISTORY_KEEP_ROWS)
})

test('the keep bound never trims a record the reader is holding open', () => {
  const loaded = rowsFrom(5_000, WINDOW_HISTORY_KEEP_ROWS + 200)
  const oldestId = loaded.at(-1)!.id
  const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }

  const fresh = [{ id: 5_001 }, ...rowsFrom(5_000, 49)]

  const entry = refreshedHistories(previous, snapshotOf({ notes: fresh }),
    { heldKeys: [`note:${oldestId}`] }).notes!.all!

  assert.equal(entry.rows.length, WINDOW_HISTORY_KEEP_ROWS + 1)
  assert.equal(entry.rows.at(-1)!.id, oldestId, 'the held row survives the trim')
  // The trim left a hole above that row, so the row is named rather than joined
  // to the rows above it in silence.
  assert.deepEqual(ids(entry.deferredRows), [oldestId],
    'the held row below the keep bound is named as waiting')
  assert.equal(entry.nextBeforeId, 5_002 - WINDOW_HISTORY_KEEP_ROWS,
    'load older continues above the hole, not below it')
})

test('the keep bound names every hole it leaves, not only the first', () => {
  // Two held records at different depths below the bound leave two holes, and
  // the records between them are unloaded, so both are named.
  const loaded = rowsFrom(50_000, 3_500)
  const heldIds = [46_900, 46_600]
  const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }

  const fresh = [{ id: 50_001 }, ...rowsFrom(50_000, 49)]

  const entry = refreshedHistories(previous, snapshotOf({ notes: fresh }),
    { heldKeys: heldIds.map(id => `note:${id}`) }).notes!.all!

  assert.equal(entry.rows.length, WINDOW_HISTORY_KEEP_ROWS + heldIds.length,
    'both held rows survive the trim')
  assert.deepEqual(ids(entry.deferredRows), heldIds,
    'each held row below the bound is named as waiting')
  assert.equal(entry.nextBeforeId, 50_002 - WINDOW_HISTORY_KEEP_ROWS,
    'load older continues above the highest hole')
  assert.equal(entry.hasMore, true)
})

test('a refresh whose changes read failed keeps no older rows', () => {
  const loaded = rowsFrom(400, 120)
  const previous = {
    notes: { all: loadedEntry(loaded), 'place:11|resident:': loadedEntry(loaded) },
    things: {}, agreements: {}, events: {},
  }
  const fresh = [{ id: 401 }, ...rowsFrom(400, 49)]

  // A changes read the window could not complete cannot name a moderated or
  // removed older record, so the refresh shows the city's own newest page.
  const histories = refreshedHistories(previous, snapshotOf({ notes: fresh }),
    { changes: null })

  assert.deepEqual(ids(histories.notes!.all!.rows), ids(fresh))
  assert.deepEqual(histories.notes!.all!.deferredRows, [])
  assert.deepEqual(Object.keys(histories.notes!), ['all'],
    'a filtered list the reader paged is not kept either')
})

test('a moderated row is dropped from the kept rows instead of being kept for ever', () => {
  const loaded = rowsFrom(400, 60)
  const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }

  const entry = refreshedHistories(previous, snapshotOf({ notes: rowsFrom(400, 50) }),
    { invalidatedKeys: ['note:345'] }).notes!.all!

  assert.equal(ids(entry.rows).includes(345), false)
  assert.equal(ids(entry.rows).includes(344), true)
})

test('a moderated seam row keeps its gap named', () => {
  // The reader loaded a newer block and, below a gap, a deeper block whose top
  // row is the named waiting marker. The city then moderates that very row.
  const loaded = [...rowsFrom(400, 50), ...rowsFrom(200, 10)]
  const previous = {
    notes: { all: loadedEntry(loaded, { deferredRows: [{ id: 200 }], nextBeforeId: 351 }) },
    things: {}, agreements: {}, events: {},
  }
  const fresh = [{ id: 401 }, ...rowsFrom(400, 49)]

  const entry = refreshedHistories(previous, snapshotOf({ notes: fresh }),
    { invalidatedKeys: ['note:200'] }).notes!.all!

  assert.equal(ids(entry.rows).includes(200), false, 'the moderated row leaves the list')
  assert.deepEqual(ids(entry.deferredRows), [199],
    'the highest row still below the gap takes the marker place')
  assert.equal(entry.nextBeforeId, 351, 'load older stays above the hole, not below it')
  assert.equal(entry.hasMore, true)
  assert.equal(ids(entry.rows).includes(191), true, 'the rows below the gap stay loaded')
})

test('a record the newest page no longer carries is dropped, not kept for ever', () => {
  const loaded = rowsFrom(400, 60)
  const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }
  // The newest page is the city's own newest block. Note 380 sits inside it and
  // is gone from it, so it is gone from the city, not merely paged out of sight.
  const fresh = rowsFrom(400, 50).filter(row => row.id !== 380)

  const entry = refreshedHistories(previous, snapshotOf({ notes: fresh })).notes!.all!

  assert.equal(ids(entry.rows).includes(380), false)
  assert.equal(ids(entry.rows).includes(341), true, 'rows below the newest page still stay')
  assert.deepEqual(entry.deferredRows, [], 'a removed row is not a gap')
})

test('the automatic fill closes a gap under the fill bound without a seam', async () => {
  const kept = rowsFrom(400, 120)
  const entry = loadedEntry([...rowsFrom(500, 50), ...kept], {
    deferredRows: [{ id: 400 }], nextBeforeId: 451,
  })
  const page = pagedFetch(50, 500)
  const requested: string[] = []
  const rejoin = historyGapFiller(async (input: string) => {
    requested.push(new URL(input, 'https://city.test').searchParams.get('before_id') || '')
    return page(input)
  })

  const filled = (await rejoin({ notes: { all: entry }, things: {}, agreements: {}, events: {} },
    { notes: rowsFrom(500, 50), things: [], agreements: [], events: [] },
    '8', new AbortController().signal)).notes!.all!

  assert.deepEqual(filled.deferredRows, [], 'a closed gap leaves no seam')
  assert.equal(filled.refreshError, false)
  assert.deepEqual(ids(filled.rows), ids(rowsFrom(500, 220)),
    'every record between the newest and the kept rows is loaded')
  assert.equal(filled.nextBeforeId, 281, 'load older continues from the lowest connected row')
  assert.deepEqual(requested, ['451', '401'],
    'the fill starts under the connected rows rather than re-reading the newest page')
})

test('a gap past the fill bound leaves a seam the reader can load', async () => {
  const gappedEntry = Object.freeze({
    rows: [{ id: 400 }, { id: 10 }], deferredRows: [{ id: 10 }], filters: {},
  })
  const joinedEntry = Object.freeze({
    rows: [{ id: 20 }], deferredRows: [{ id: 20 }], filters: {},
  })
  const rejoin = historyGapFiller(deepGapFetch)

  const reconciled = await rejoin({
    notes: { all: gappedEntry }, things: { all: joinedEntry }, agreements: {}, events: {},
  }, { notes: [{ id: 400 }], things: [], agreements: [], events: [] },
  '8', new AbortController().signal)

  const notes = reconciled.notes!.all!
  assert.notStrictEqual(notes, gappedEntry)
  assert.deepEqual(notes.deferredRows, [{ id: 10 }])
  assert.equal(notes.hasMore, true)
  assert.equal(notes.refreshError, false)
  assert.equal(notes.nextBeforeId, 400 - WINDOW_HISTORY_FILL_ROWS,
    'the fill spends exactly its row bound before naming the seam')
  assert.ok(notes.rows.some(row => row.id === 10), 'the kept row stays in the list')
  // A seam on one entry never blocks or marks another entry.
  assert.deepEqual(reconciled.things!.all!.rows, [{ id: 20 }])
  assert.deepEqual(reconciled.things!.all!.deferredRows, [])
})

test('a failed fill read marks the list instead of joining it silently', async () => {
  const gappedEntry = Object.freeze({
    rows: [{ id: 400 }, { id: 10 }], deferredRows: [{ id: 10 }], filters: {},
  })
  const rejoin = historyGapFiller(async (input: string) => {
    const collection = new URL(input, 'https://city.test').pathname.split('/').at(-1)
    return collection === 'notes'
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => ({
          things: [{ id: 20 }], change_marker: '8', has_more: false,
        }) }
  })

  const reconciled = await rejoin({
    notes: { all: gappedEntry },
    things: { all: Object.freeze({
      rows: [{ id: 20 }], deferredRows: [{ id: 20 }], filters: {},
    }) },
    agreements: {}, events: {},
  }, { notes: [{ id: 400 }], things: [], agreements: [], events: [] },
  '8', new AbortController().signal)

  const notes = reconciled.notes!.all!
  assert.notStrictEqual(notes, gappedEntry)
  assert.equal(notes.refreshError, true, 'a failed fill is marked for the reader')
  assert.deepEqual(notes.deferredRows, [{ id: 10 }])
  assert.equal(notes.hasMore, true)
  assert.equal(notes.nextBeforeId, 400, 'the cursor never sits under the unfilled gap')
  assert.ok(notes.rows.some(row => row.id === 10), 'the kept row stays in the list')
  assert.deepEqual(reconciled.things!.all!.rows, [{ id: 20 }])
})

test('a filtered list with no fresh row above its top row keeps its cursor above the gap', async () => {
  // A quiet place: the city's own newest page carries no row of this list, so
  // nothing proves the reader's own top row is still the newest one.
  const loaded = rowsFrom(100, 10).map(row => ({ ...row, place_id: 11 }))
  const previous = {
    notes: { 'place:11|resident:': loadedEntry(loaded, { filters: { placeId: 11 } }) },
    things: {}, agreements: {}, events: {},
  }
  const citywideNewest = rowsFrom(900, 50).map(row => ({ ...row, place_id: 12 }))

  const refreshed = refreshedHistories(previous, snapshotOf({ notes: citywideNewest }))
    .notes!['place:11|resident:']!
  assert.deepEqual(ids(refreshed.deferredRows), [100], 'the gap above the top row is named')
  assert.equal(refreshed.nextBeforeId, null,
    'with nothing loaded above the gap the next read starts at the newest page')

  // The automatic fill then fails, which is where the cursor used to fall back
  // to the bottom of the list, below the gap it had just named.
  const rejoin = historyGapFiller(async () => ({ ok: false, json: async () => ({}) }))
  const seamed = (await rejoin({ notes: { 'place:11|resident:': refreshed } },
    { notes: [], things: [], agreements: [], events: [] },
    '8', new AbortController().signal)).notes!['place:11|resident:']!

  assert.equal(seamed.refreshError, true, 'a failed fill is marked for the reader')
  assert.deepEqual(ids(seamed.deferredRows), [100], 'the failed fill leaves the gap named')
  assert.equal(seamed.nextBeforeId, null, 'the cursor never drops below the gap it names')

  // One press of the list's own control reads this list's newest page and pages
  // down towards the gap. It cannot clear the marker without loading it.
  const { run, read } = olderHistoryPager(seamed, async (input: string) => {
    const before = Number(new URL(input, 'https://city.test').searchParams.get('before_id')) || 301
    const rows = rowsFrom(before - 1, 50)
    return { ok: true, json: async () => ({
      notes: rows, change_marker: '8', has_more: true, next_before_id: rows.at(-1)!.id,
    }) }
  })

  await run('notes', {})
  assert.deepEqual(ids(read().deferredRows), [100],
    'a page that stopped above the gap leaves it named')
  assert.equal(read().nextBeforeId, 251, 'the cursor stays above the gap')
  assert.equal(read().rows[0]!.id, 300, 'the newest page of this list is what loaded')

  for (let page = 0; page < 4; page += 1) await run('notes', {})
  assert.deepEqual(read().deferredRows, [], 'the page that reaches the top row closes the gap')
  assert.deepEqual(ids(read().rows), ids(rowsFrom(300, 250)),
    'every record between this list newest and its kept rows is loaded')
})

test('a gap the fill proved larger than its bound is not read again on every refresh', async () => {
  // Ten rows a page from 400: the first fill walks its whole bound without
  // reaching the row at 10, which is the hole the keep bound leaves above a
  // record the reader is holding open far below it. Reading it again on every
  // changed refresh would spend the whole fill budget for ever and end at the
  // same seam.
  const entry = Object.freeze({
    rows: [{ id: 400 }, { id: 10 }], deferredRows: [{ id: 10 }], filters: {},
  })
  let reads = 0
  const rejoin = historyGapFiller(async (input: string) => {
    reads += 1
    return deepGapFetch(input)
  })
  const snapshot = { notes: [{ id: 400 }], things: [], agreements: [], events: [] }

  const first = (await rejoin({ notes: { all: entry }, things: {}, agreements: {}, events: {} },
    snapshot, '8', new AbortController().signal)).notes!.all!
  const spent = reads

  assert.ok(spent > 1, 'the first fill spent its bound on the gap')
  assert.deepEqual(ids(first.deferredRows), [10], 'the gap past the bound keeps its name')
  assert.deepEqual(first.beyondFillIds, [10], 'and is recorded as larger than one fill')

  const second = await rejoin({ notes: { all: first }, things: {}, agreements: {}, events: {} },
    snapshot, '8', new AbortController().signal)

  assert.equal(reads, spent, 'the next changed refresh reads nothing for that gap')
  assert.strictEqual(second.notes!.all!, first, 'the named gap is left exactly as it was')

  // The record survives the refresh that rebuilds the list, so the gap is not
  // read again the moment the entry is rebuilt either.
  const kept = refreshedHistories({ notes: { 'place:11|resident:': first } },
    snapshotOf({ notes: rowsFrom(401, 50) })).notes!['place:11|resident:']!
  assert.deepEqual(ids(kept.deferredRows), [10], 'the gap is still named after a refresh')
  assert.deepEqual(kept.beyondFillIds, [10], 'and is still known to be larger than one fill')
})

test('a fill that closes the gap gives back the bottom of a list the reader had reached', async () => {
  // This reader had paged to the very bottom of the list, so nothing older
  // exists. A named gap opens the Load older control; closing that gap must
  // hand the bottom answer back rather than leave a control that fetches
  // nothing.
  const previous = {
    notes: { all: loadedEntry(rowsFrom(400, 120), { hasMore: false, nextBeforeId: null }) },
    things: {}, agreements: {}, events: {},
  }

  const refreshed = refreshedHistories(previous, snapshotOf({ notes: rowsFrom(500, 50) }))
    .notes!.all!
  assert.deepEqual(ids(refreshed.deferredRows), [400])
  assert.equal(refreshed.hasMore, true, 'a named gap opens the control')

  const rejoin = historyGapFiller(pagedFetch(50, 500))
  const filled = (await rejoin(
    { notes: { all: refreshed }, things: {}, agreements: {}, events: {} },
    { notes: rowsFrom(500, 50), things: [], agreements: [], events: [] },
    '8', new AbortController().signal)).notes!.all!

  assert.deepEqual(filled.deferredRows, [], 'the fill closed the gap')
  assert.equal(filled.hasMore, false,
    'a reader already at the bottom is not offered a page that would add nothing')
})

test('a city change during the fill is read again from the newer marker', async () => {
  const entry = loadedEntry([...rowsFrom(500, 50), ...rowsFrom(400, 120)], {
    deferredRows: [{ id: 400 }], nextBeforeId: 451,
  })
  const markers: string[] = []
  const page = pagedFetch(50, 500)
  const rejoin = historyGapFiller(async (input: string) => {
    const marker = new URL(input, 'https://city.test').searchParams.get('after_change_marker') || ''
    markers.push(marker)
    // The city changed between the snapshot read and the first fill read.
    if (marker === '8') {
      return { ok: true, json: async () => ({ notes: [], change_marker: '9', has_more: true }) }
    }
    const payload = await (await page(input)).json() as Record<string, unknown>
    return { ok: true, json: async () => ({ ...payload, change_marker: '9' }) }
  })

  const filled = (await rejoin(
    { notes: { all: entry }, things: {}, agreements: {}, events: {} },
    { notes: rowsFrom(500, 50), things: [], agreements: [], events: [] },
    '8', new AbortController().signal)).notes!.all!

  assert.deepEqual(markers, ['8', '9', '9'],
    'the fill met a newer marker and read the gap again under it')
  assert.deepEqual(filled.deferredRows, [], 'the gap the city change interrupted still closed')
  assert.equal(filled.refreshError, false, 'a city change during a fill is not an error seam')
})

// The older-history pager is a browser-program string too, so the suite runs the
// real loadHistory with the seam helpers it calls and fakes for the rest.
function olderHistoryPager(
  initial: HistoryEntry,
  fetchFake: (input: string) => Promise<unknown>,
) {
  const source = functionSource(
    PART_34_HISTORY_LOADING_COUNTS_AND_SCOPE, 'loadHistory', 'function loadedHistoryRows')
  const seamSource = sourceBetween(PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES,
    '  function seamRowsAfterPage', '  function filledHistoryEntry')
  const cursorSource = sourceBetween(PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES,
    '  function connectedHistoryCursor', '  function retainedHistoryEntry')
  let stored = initial
  const run = new Function(
    'historyEntry', 'setHistoryEntry', 'renderAll', 'historyRequestUrl', 'fetch',
    'requireCurrentReadMarker', 'normalizeHistoryRows', 'safeId', 'mergeWindowRows',
    'window', 'REQUEST_TIMEOUT_MS', 'MAX_AUTO_HISTORY_PAGES',
    `let state = { changeMarker: '8' }; let authoredRevision = 1;
     ${cursorSource} ${seamSource} ${source} return loadHistory`,
  )(
    () => stored,
    (_collection: string, _filters: unknown, entry: HistoryEntry) => { stored = entry },
    () => {},
    (_collection: string, entry: { initialized: boolean, nextBeforeId: number | null }) =>
      new URL('https://city.test/api/window?before_id=' +
        (entry.initialized && entry.nextBeforeId ? String(entry.nextBeforeId) : '')),
    fetchFake,
    () => {}, (_collection: string, payload: { notes: Row[] }) => payload.notes,
    (value: unknown) => Number(value) || null, mergeWindowRows,
    { setTimeout: () => 1, clearTimeout: () => {} }, 10_000, 8,
  ) as (collection: string, filters: unknown) => Promise<void>
  return { run, read: () => stored }
}

test('an older-history page that reaches the deferred rows closes the seam', async () => {
  const pages = new Map<number, { rows: Row[], hasMore: boolean }>([
    [400, { rows: [{ id: 399 }, { id: 398 }], hasMore: true }],
    [398, { rows: [{ id: 10 }], hasMore: true }],
  ])
  const { run, read } = olderHistoryPager(Object.freeze({
    rows: [{ id: 400 }, { id: 10 }],
    deferredRows: [{ id: 10 }],
    hasMore: true,
    nextBeforeId: 400,
    initialized: true,
    loading: false,
    error: false,
  }), async (input: string) => {
    const before = Number(new URL(input, 'https://city.test').searchParams.get('before_id'))
    const page = pages.get(before)
    assert.ok(page, `unexpected older-history cursor ${before}`)
    return { ok: true, json: async () => ({
      notes: page.rows,
      change_marker: '8',
      has_more: page.hasMore,
      next_before_id: page.hasMore ? page.rows.at(-1)!.id : null,
    }) }
  })

  await run('notes', {})
  assert.deepEqual(read().deferredRows, [{ id: 10 }], 'a page above the seam keeps it')
  assert.equal(read().error, false)
  assert.equal(read().nextBeforeId, 398)

  await run('notes', {})
  assert.deepEqual(read().deferredRows, [], 'reaching the deferred rows closes the seam')
  assert.equal(read().error, false)
  assert.deepEqual(ids(read().rows), [400, 399, 398, 10])
})

test('load older continues from the lowest kept row once the seam closes', async () => {
  // The gap above a kept block is one seam. The page that reaches its top row
  // lands inside records the reader already has, so the next cursor is the
  // bottom of the kept block rather than the middle of it.
  const { run, read } = olderHistoryPager(Object.freeze({
    rows: [{ id: 400 }, ...rowsFrom(350, 10)],
    deferredRows: [{ id: 350 }],
    hasMore: true,
    nextBeforeId: 400,
    initialized: true,
    loading: false,
    error: false,
  }), async (input: string) => {
    const before = Number(new URL(input, 'https://city.test').searchParams.get('before_id'))
    const rows = rowsFrom(before - 1, 10)
    return { ok: true, json: async () => ({
      notes: rows, change_marker: '8', has_more: true, next_before_id: rows.at(-1)!.id,
    }) }
  })

  await run('notes', {})
  assert.deepEqual(read().deferredRows, [{ id: 350 }], 'a page above the gap keeps it named')
  assert.equal(read().nextBeforeId, 390, 'the cursor stays above the gap')

  for (let page = 0; page < 4; page += 1) await run('notes', {})
  assert.deepEqual(read().deferredRows, [], 'the page that reaches the kept block closes the gap')
  assert.equal(read().error, false)
  assert.equal(read().nextBeforeId, 341, 'load older continues from the lowest kept row')
  assert.deepEqual(ids(read().rows), ids(rowsFrom(400, 60)),
    'every record between the newest and the lowest kept row is loaded')
})

test('two held rows at different depths keep the deeper gap named until it is reached', async () => {
  // A reader who opened two notes at different depths has a gap above each one.
  // Ten rows a page from 400: the page ending at 350 reaches the first held row
  // while 349 down to 121 are still missing directly above the second.
  const { run, read } = olderHistoryPager(Object.freeze({
    rows: [{ id: 400 }, { id: 350 }, { id: 120 }],
    deferredRows: [{ id: 350 }, { id: 120 }],
    hasMore: true,
    nextBeforeId: 400,
    initialized: true,
    loading: false,
    error: false,
  }), async (input: string) => {
    const before = Number(new URL(input, 'https://city.test').searchParams.get('before_id'))
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: before - 1 - index }))
    return { ok: true, json: async () => ({
      notes: rows, change_marker: '8', has_more: true, next_before_id: rows.at(-1)!.id,
    }) }
  })

  for (let page = 0; page < 5; page += 1) await run('notes', {})
  assert.equal(read().nextBeforeId, 350, 'five pages of ten reach the first held row')
  assert.deepEqual(read().deferredRows, [{ id: 120 }],
    'the gap above the deeper held row is still named')
  assert.equal(read().error, false)

  for (let page = 0; page < 23; page += 1) await run('notes', {})
  assert.equal(read().nextBeforeId, 120, 'paging on reaches the deeper held row')
  assert.deepEqual(read().deferredRows, [], 'the last gap closes when a page reaches it')
  assert.equal(read().error, false)
  assert.deepEqual(ids(read().rows),
    Array.from({ length: 281 }, (_, index) => 400 - index),
    'every row between the newest and the deepest held row is loaded')
})

test('a page entirely below a waiting row can never clear its gap', async () => {
  // The exact sequence the report walked: a cursor left under the gap reads a
  // page whose rows are all older than the record that named it. That page
  // reached nothing it named, so the gap stays named, and the cursor corrects
  // itself to start above the gap again.
  const { run, read } = olderHistoryPager(Object.freeze({
    rows: rowsFrom(100, 10),
    deferredRows: [{ id: 100 }],
    hasMore: true,
    nextBeforeId: 91,
    initialized: true,
    loading: false,
    error: false,
  }), async (input: string) => {
    const before = Number(new URL(input, 'https://city.test').searchParams.get('before_id'))
    const rows = rowsFrom(before - 1, 50)
    return { ok: true, json: async () => ({
      notes: rows, change_marker: '8', has_more: true, next_before_id: rows.at(-1)!.id,
    }) }
  })

  await run('notes', {})

  assert.deepEqual(ids(read().deferredRows), [100],
    'a page below the gap does not clear it')
  assert.equal(read().nextBeforeId, null,
    'and the cursor starts again at the newest page rather than under the gap')
  assert.equal(read().error, false)
})

test('a superseded complete-body read synchronizes its restored disclosure state', async () => {
  const loadSource = functionSource(
    PART_30_DETAIL_RENDER_AND_BODIES, 'loadFullBody', 'function revalidateViewerFullBodies')
  const disclosureStart = PART_30_DETAIL_RENDER_AND_BODIES.indexOf('  function bodyDisclosureLabel')
  const disclosureEnd = PART_30_DETAIL_RENDER_AND_BODIES.indexOf('  let bodyDisclosureFrame', disclosureStart)
  const disclosureSource = PART_30_DETAIL_RENDER_AND_BODIES.slice(disclosureStart, disclosureEnd)
  const initialState = { fullBodies: { 'thing:401': Object.freeze({
    body: null, recordVersion: null, loading: false, error: false, requestRevision: null,
  }) }, expandedBodies: ['thing:401'] }
  let resolveFetch: ((value: unknown) => void) | undefined
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve })
  const bodyNode = {
    dataset: { bodyKey: 'thing:401', bodyKind: 'thing', truncated: 'true', expanded: 'true' },
    __viewerRecordVersion: null,
    getBoundingClientRect: () => ({ height: bodyNode.dataset.expanded === 'true' ? 20 : 10 }),
  }
  const attributes = new Map<string, string>()
  const disclosure = {
    hidden: false,
    textContent: 'Loading the whole thing…',
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  }
  const block = {
    closest: () => null,
    querySelector: (selector: string) => selector === '.public-body' ? bodyNode
      : selector === '.body-disclosure' ? disclosure : null,
  }
  const run = new Function(
    'fetch', 'window', 'renderAll', 'storeViewerOpenKeys', 'safeId', 'safeText',
    'viewerInvalidatedRecordKeys', 'viewerReadingViewIsActive', 'document', 'CSS', 'REQUEST_TIMEOUT_MS',
    `let state = ${JSON.stringify(initialState)}; let authoredRevision = 1;
     ${loadSource}
     ${disclosureSource}
     return { loadFullBody, syncBodyDisclosures,
       supersede() { authoredRevision += 1; return authoredRevision }, state: () => state }`,
  )(
    () => pendingFetch, {
      location: { origin: 'https://127.0.0.1' }, setTimeout: () => 1, clearTimeout: () => {},
    }, () => {},
    (keys: string[]) => keys, (value: unknown) => Number(value), (value: unknown) => String(value),
    new Set(), () => false, { querySelectorAll: () => [block] },
    { escape: (value: string) => value }, 10_000,
  ) as {
    loadFullBody: (kind: string, id: number, recordVersion: null, revalidate: boolean) => Promise<void>
    supersede: () => number
    syncBodyDisclosures: () => void
    state: () => { fullBodies: Record<string, { loading: boolean, error: boolean }> }
  }

  const read = run.loadFullBody('thing', 401, null, true)
  run.syncBodyDisclosures()
  assert.equal(attributes.get('aria-busy'), 'true')
  assert.equal(disclosure.textContent, 'Loading the whole thing…')
  assert.equal(run.supersede(), 2)
  resolveFetch?.({ ok: true, json: async () => ({ thing: { id: 401, body: 'complete' } }) })
  await read

  assert.equal(run.state().fullBodies['thing:401']?.loading, false)
  assert.equal(run.state().fullBodies['thing:401']?.error, false)
  assert.equal(attributes.get('aria-busy'), 'false')
  assert.equal(disclosure.textContent, 'Read the whole thing')
})
