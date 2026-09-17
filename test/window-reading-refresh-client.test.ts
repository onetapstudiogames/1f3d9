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
  gapAfterIds?: readonly number[]
  beyondFillIds?: readonly number[]
  hasMore?: boolean
  nextBeforeId?: number | null
  refreshError?: boolean
  error?: boolean
  loading?: boolean
  initialized?: boolean
  filters?: Readonly<Record<string, unknown>>
}>
type Histories = Record<string, Record<string, HistoryEntry>>
type Snapshot = Record<string, unknown>
type Request = Readonly<{ beforeId: number | null, afterId: number | null, marker: string | null }>

const COLLECTIONS = ['notes', 'things', 'agreements', 'events'] as const

function functionSource(part: string, name: string, nextName: string) {
  const start = part.indexOf(`  async function ${name}`)
  const end = part.indexOf(`  ${nextName}`, start)
  assert.notEqual(start, -1, name)
  assert.notEqual(end, -1, nextName)
  return part.slice(start, end)
}

function sourceBetween(part: string, start: string, end: string, ...required: string[]) {
  const from = part.indexOf(start)
  const to = part.indexOf(end, from)
  assert.notEqual(from, -1, start)
  assert.notEqual(to, -1, end)
  const source = part.slice(from, to)
  // The slice is keyed to function names, so a rename must fail loudly here
  // rather than quietly hand a later test the wrong region of the program.
  for (const name of required) assert.ok(source.includes(name), `${start} is missing ${name}`)
  return source
}

// Naming a gap and reading the rows off a list are the shared helpers every
// harness below loads, so all of them run the same real source.
const GAP_SOURCE = sourceBetween(
  PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES,
  '  function gapUpperBound',
  '  function freshHistoryEntry',
  'function namedHistoryGap', 'function keptHistoryRows', 'function keptGapAfterIds',
)
const REFRESH_SOURCE = sourceBetween(
  PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES,
  '  function freshHistoryEntry',
  '  function filledHistoryEntry',
  'function retainedHistoryEntry', 'function freshSnapshotHistories',
)
const FILL_SOURCE = sourceBetween(
  PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES,
  '  function filledHistoryEntry',
  '  function mergeUnchangedSnapshotHistories',
  'async function fillHistoryGap', 'async function rejoinSnapshotHistories',
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
    gapAfterIds: [],
    beyondFillIds: [],
    hasMore: true,
    nextBeforeId: rows.at(-1)?.id ?? null,
    initialized: true,
    ...entry,
  })
}

// A dense list the city really has, from oldestId up to newestId. It answers
// the same read shape the window sends: a newer end, an optional older end, and
// an honest has_more for whatever range the two describe.
function cityList(options: Readonly<{
  newestId: () => number
  pageSize?: number
  oldestId?: number
  requests?: Request[]
  placeId?: number
  marker?: () => string
}>) {
  const pageSize = options.pageSize ?? 50
  const oldestId = options.oldestId ?? 1
  return async (input: string) => {
    const url = new URL(input, 'https://city.test')
    const collection = url.pathname.split('/').at(-1)!
    const beforeText = url.searchParams.get('before_id')
    const afterText = url.searchParams.get('after_id')
    const beforeId = beforeText ? Number(beforeText) : null
    const afterId = afterText ? Number(afterText) : null
    options.requests?.push(Object.freeze({
      beforeId, afterId, marker: url.searchParams.get('after_change_marker'),
    }))
    const top = Math.min(beforeId === null ? options.newestId() : beforeId - 1, options.newestId())
    const floor = Math.max(afterId ?? 0, oldestId - 1)
    const rows: Row[] = []
    for (let id = top; id > floor && rows.length < pageSize; id -= 1) {
      rows.push(options.placeId ? { id, place_id: options.placeId } : { id })
    }
    const lowest = rows.at(-1)?.id ?? null
    const hasMore = lowest !== null && lowest - 1 > floor
    return { ok: true, json: async () => ({
      [collection]: rows,
      change_marker: options.marker ? options.marker() : '8',
      has_more: hasMore,
      next_before_id: hasMore ? lowest : null,
    }) }
  }
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
    `const state = { histories }; ${GAP_SOURCE} ${REFRESH_SOURCE}
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

function historyRequestUrlFake(
  collection: string,
  entry: { initialized: boolean, nextBeforeId: number | null },
  _filters: unknown,
  marker: string | null,
  gap: { afterId: number } | null,
) {
  const url = new URL(`https://city.test/api/${collection}`)
  if (entry.initialized && entry.nextBeforeId) {
    url.searchParams.set('before_id', String(entry.nextBeforeId))
  }
  if (gap) url.searchParams.set('after_id', String(gap.afterId))
  if (marker) url.searchParams.set('after_change_marker', marker)
  return url
}

// The automatic gap fill is a browser-program string too, so the suite runs the
// real source with fakes for the window helpers and the real row bounds.
function historyGapFiller(fetchFake: (input: string) => Promise<unknown>) {
  return new Function(
    'historyRequestUrl', 'fetch', 'safeChangeMarker', 'markerCovers', 'normalizeHistoryRows',
    'mergeWindowRows', 'WINDOW_HISTORY_FILL_ROWS', 'WINDOW_HISTORY_KEEP_ROWS',
    `${GAP_SOURCE} ${FILL_SOURCE}; return rejoinSnapshotHistories`,
  )(
    historyRequestUrlFake,
    fetchFake,
    (value: unknown) => typeof value === 'string' && /^[0-9]+$/.test(value) ? value : null,
    (actual: string | null, minimum: string | null) =>
      Boolean(actual && minimum && BigInt(actual) >= BigInt(minimum)),
    (collection: string, payload: Record<string, unknown>) => payload[collection],
    mergeWindowRows,
    WINDOW_HISTORY_FILL_ROWS,
    WINDOW_HISTORY_KEEP_ROWS,
  ) as (histories: Partial<Histories>, marker: string, signal: AbortSignal) => Promise<Histories>
}

// The list's own control is a browser-program string too, so the suite runs the
// real loadHistory with the gap helpers it calls and fakes for the rest.
function olderHistoryPager(
  initial: HistoryEntry,
  fetchFake: (input: string) => Promise<unknown>,
) {
  const source = functionSource(
    PART_34_HISTORY_LOADING_COUNTS_AND_SCOPE, 'loadHistory', 'function loadedHistoryRows')
  let stored = initial
  const run = new Function(
    'historyEntry', 'setHistoryEntry', 'renderAll', 'historyRequestUrl', 'fetch',
    'requireCurrentReadMarker', 'normalizeHistoryRows', 'safeId', 'mergeWindowRows',
    'window', 'REQUEST_TIMEOUT_MS', 'WINDOW_HISTORY_KEEP_ROWS',
    `let state = { changeMarker: '8' }; let authoredRevision = 1;
     ${GAP_SOURCE} ${FILL_SOURCE} ${source} return loadHistory`,
  )(
    () => stored,
    (_collection: string, _filters: unknown, entry: HistoryEntry) => { stored = entry },
    () => {},
    historyRequestUrlFake,
    fetchFake,
    () => {}, (_collection: string, payload: { notes: Row[] }) => payload.notes,
    (value: unknown) => Number(value) || null, mergeWindowRows,
    { setTimeout: () => 1, clearTimeout: () => {} }, 10_000, WINDOW_HISTORY_KEEP_ROWS,
  ) as (collection: string, filters: unknown) => Promise<void>
  return { run, read: () => stored }
}

// Three rules every scenario checks, because each earlier round of this change
// kept one of them and broke another: the list's control never reads below a
// gap the list has named, that control never errors, and a named gap loses its
// name only once the records it named have been read.
function assertReadable(
  label: string,
  entry: HistoryEntry,
  previous: HistoryEntry | null,
  reads: readonly Request[] = [],
  // Records the city took down inside a range: the list is whole without them.
  absent: readonly number[] = [],
) {
  const waiting = entry.gapAfterIds ?? []
  assert.notEqual(entry.error, true, `${label}: the list's own control errored`)
  const namedBefore = previous?.gapAfterIds ?? []
  if (namedBefore.length) {
    const gapId = Math.max(...namedBefore)
    for (const read of reads) {
      assert.equal(read.afterId, gapId,
        `${label}: a read asked below the gap named at ${gapId} instead of asking for it`)
    }
  }
  for (const droppedId of namedBefore) {
    if (waiting.includes(droppedId)) continue
    const above = ids(entry.rows).filter(candidate => candidate >= droppedId)
    const whole = ids(rowsFrom(above[0]!, above[0]! - droppedId + 1))
      .filter(id => !absent.includes(id))
    assert.deepEqual(above, whole,
      `${label}: the gap at ${droppedId} lost its name with records above it unloaded`)
  }
  return entry
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
    assert.deepEqual(entry.gapAfterIds, [],
      `${collection} newest page reaching the kept rows leaves no gap`)
    assert.equal(entry.nextBeforeId, 281,
      `${collection} load older continues from the lowest loaded row`)
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
  assert.deepEqual(histories.notes!['place:11|resident:']!.gapAfterIds, [])
})

test('a changed refresh that outruns the newest page names the gap above the kept rows', () => {
  const loaded = rowsFrom(400, 120)
  const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }
  // Every row of the newest page is new, so nothing proves the two ends join.
  const fresh = rowsFrom(500, 50)

  const entry = refreshedHistories(previous, snapshotOf({ notes: fresh })).notes!.all!

  assert.deepEqual(entry.gapAfterIds, [400],
    'the top of the kept block names the range the fill must read')
  assert.equal(entry.nextBeforeId, 281, 'load older still continues from the lowest loaded row')
  assert.equal(entry.hasMore, true)
  assert.ok(ids(entry.rows).includes(281), 'the kept rows are still in the list')
  assert.ok(ids(entry.rows).includes(451), 'the newest page is in the list too')
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
  assert.deepEqual(entry.gapAfterIds, [], 'trimming the bottom leaves no hole inside the list')
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
  assert.deepEqual(entry.gapAfterIds, [oldestId],
    'the held row below the keep bound names the range above it')
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
  assert.deepEqual(entry.gapAfterIds, heldIds,
    'each held row below the bound names the range above it')
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
  assert.deepEqual(histories.notes!.all!.gapAfterIds, [])
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
  assert.deepEqual(entry.gapAfterIds, [], 'a record the city took down is not a gap')
})

test('a moderated gap marker hands its name to the record below it', () => {
  // The reader loaded a newer block and, below a gap, a deeper block whose top
  // row names the gap. The city then takes that very row down.
  const loaded = [...rowsFrom(400, 50), ...rowsFrom(200, 10)]
  const previous = {
    notes: { all: loadedEntry(loaded, { gapAfterIds: [200] }) },
    things: {}, agreements: {}, events: {},
  }
  const fresh = [{ id: 401 }, ...rowsFrom(400, 49)]

  const entry = refreshedHistories(previous, snapshotOf({ notes: fresh }),
    { invalidatedKeys: ['note:200'] }).notes!.all!

  assert.equal(ids(entry.rows).includes(200), false, 'the moderated row leaves the list')
  assert.deepEqual(entry.gapAfterIds, [199],
    'the highest record still below the gap takes the marker place')
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
  assert.deepEqual(entry.gapAfterIds, [], 'a removed row is not a gap')
})

test('the automatic fill reads exactly the gap and closes it in one read', async () => {
  const kept = rowsFrom(400, 120)
  const entry = loadedEntry([...rowsFrom(500, 50), ...kept], { gapAfterIds: [400] })
  const requests: Request[] = []
  const rejoin = historyGapFiller(cityList({ newestId: () => 500, requests }))

  const filled = (await rejoin({ notes: { all: entry }, things: {}, agreements: {}, events: {} },
    '8', new AbortController().signal)).notes!.all!

  assert.deepEqual(filled.gapAfterIds, [], 'a closed gap leaves no seam')
  assert.equal(filled.refreshError, false)
  assert.deepEqual(ids(filled.rows), ids(rowsFrom(500, 220)),
    'every record between the newest and the kept rows is loaded')
  assert.equal(filled.nextBeforeId, 281, 'load older continues from the lowest loaded row')
  assert.deepEqual(requests, [{ beforeId: 451, afterId: 400, marker: '8' }],
    'the fill asks for the gap itself, not for the newest page again')
})

test('a gap past the fill bound leaves a seam the reader can load', async () => {
  const gappedEntry = loadedEntry([{ id: 400 }, { id: 10 }], { gapAfterIds: [10], filters: {} })
  const joinedEntry = loadedEntry([{ id: 20 }], { filters: {} })
  const requests: Request[] = []
  // Ten rows a page: one whole fill walks 399 downward and never reaches 10.
  const rejoin = historyGapFiller(
    cityList({ newestId: () => 400, pageSize: 10, requests }))

  const rejoined = await rejoin({
    notes: { all: gappedEntry }, things: { all: joinedEntry }, agreements: {}, events: {},
  }, '8', new AbortController().signal)

  const notes = rejoined.notes!.all!
  assert.deepEqual(notes.gapAfterIds, [10], 'the gap past the bound keeps its name')
  assert.deepEqual(notes.beyondFillIds, [10], 'and is recorded as larger than one fill')
  assert.equal(notes.refreshError, false, 'a gap larger than the bound is not a failed read')
  assert.equal(requests.every(request => request.afterId === 10), true,
    'every read of the gap is bounded by the gap itself')
  assert.equal(requests.length, WINDOW_HISTORY_FILL_ROWS / 10,
    'the fill spends exactly its row bound before naming the seam')
  assert.equal(ids(notes.rows).filter(id => id > 10).at(-1), 400 - WINDOW_HISTORY_FILL_ROWS,
    'the records the fill did read are in the list')
  assert.ok(ids(notes.rows).includes(10), 'the kept row stays in the list')
  // A seam on one entry never blocks or marks another entry.
  assert.deepEqual(ids(rejoined.things!.all!.rows), [20])
  assert.deepEqual(rejoined.things!.all!.gapAfterIds, [])
})

test('a failed fill read marks the list instead of joining it silently', async () => {
  const gappedEntry = loadedEntry([{ id: 400 }, { id: 10 }], { gapAfterIds: [10], filters: {} })
  const rejoin = historyGapFiller(async () => ({ ok: false, json: async () => ({}) }))

  const rejoined = await rejoin({
    notes: { all: gappedEntry },
    things: { all: loadedEntry([{ id: 20 }], { filters: {} }) },
    agreements: {}, events: {},
  }, '8', new AbortController().signal)

  const notes = rejoined.notes!.all!
  assert.equal(notes.refreshError, true, 'a failed fill is marked for the reader')
  assert.deepEqual(notes.gapAfterIds, [10])
  assert.deepEqual(notes.beyondFillIds, [],
    'a read that failed proves nothing about the size of the gap')
  assert.ok(ids(notes.rows).includes(10), 'the kept row stays in the list')
  assert.deepEqual(ids(rejoined.things!.all!.rows), [20])
})

test('a filtered list with no fresh row above its top row names and reads only that gap', async () => {
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
  assert.deepEqual(refreshed.gapAfterIds, [100], 'the gap above the top row is named')

  const requests: Request[] = []
  const rejoin = historyGapFiller(cityList({
    newestId: () => 300, placeId: 11, requests, oldestId: 1,
  }))
  const filled = (await rejoin({ notes: { 'place:11|resident:': refreshed } },
    '8', new AbortController().signal)).notes!['place:11|resident:']!

  assert.deepEqual(requests, [
    { beforeId: null, afterId: 100, marker: '8' },
    { beforeId: 251, afterId: 100, marker: '8' },
    { beforeId: 201, afterId: 100, marker: '8' },
    { beforeId: 151, afterId: 100, marker: '8' },
  ], 'with nothing loaded above it the fill reads from the newest record down to the gap')
  assert.deepEqual(filled.gapAfterIds, [], 'the fill closed the gap')
  assert.deepEqual(ids(filled.rows), ids(rowsFrom(300, 210)), 'the list is whole again')
  assert.equal(filled.nextBeforeId, 91, 'load older continues from the lowest loaded row')
})

test('a gap the fill proved larger than its bound is not read again on every refresh', async () => {
  // Reading it again on every changed refresh would spend the whole fill budget
  // for ever and end at the same seam.
  const entry = loadedEntry([{ id: 400 }, { id: 10 }], { gapAfterIds: [10], filters: {} })
  const requests: Request[] = []
  const rejoin = historyGapFiller(
    cityList({ newestId: () => 400, pageSize: 10, requests }))

  const first = (await rejoin({ notes: { all: entry }, things: {}, agreements: {}, events: {} },
    '8', new AbortController().signal)).notes!.all!
  const spent = requests.length

  assert.ok(spent > 1, 'the first fill spent its bound on the gap')
  assert.deepEqual(first.gapAfterIds, [10])
  assert.deepEqual(first.beyondFillIds, [10])

  const second = await rejoin({ notes: { all: first }, things: {}, agreements: {}, events: {} },
    '8', new AbortController().signal)

  assert.equal(requests.length, spent, 'the next changed refresh reads nothing for that gap')
  assert.strictEqual(second.notes!.all!, first, 'the named gap is left exactly as it was')

  // The record survives the refresh that rebuilds the list, so the gap is not
  // read again the moment the entry is rebuilt either.
  const kept = refreshedHistories({ notes: { 'place:11|resident:': first } },
    snapshotOf({ notes: rowsFrom(401, 50) })).notes!['place:11|resident:']!
  assert.deepEqual(kept.gapAfterIds, [10], 'the gap is still named after a refresh')
  assert.deepEqual(kept.beyondFillIds, [10], 'and is still known to be larger than one fill')
})

test('a fill that closes the gap gives back the bottom of a list the reader had reached', async () => {
  // This reader had paged to the very bottom of the list, so nothing older
  // exists. Closing the gap must not leave a control that fetches nothing.
  const previous = {
    notes: { all: loadedEntry(rowsFrom(400, 120), { hasMore: false, nextBeforeId: null }) },
    things: {}, agreements: {}, events: {},
  }

  const refreshed = refreshedHistories(previous, snapshotOf({ notes: rowsFrom(500, 50) }))
    .notes!.all!
  assert.deepEqual(refreshed.gapAfterIds, [400])
  assert.equal(refreshed.hasMore, false, 'nothing older appeared, so nothing older is promised')

  const rejoin = historyGapFiller(cityList({ newestId: () => 500, oldestId: 281 }))
  const filled = (await rejoin(
    { notes: { all: refreshed }, things: {}, agreements: {}, events: {} },
    '8', new AbortController().signal)).notes!.all!

  assert.deepEqual(filled.gapAfterIds, [], 'the fill closed the gap')
  assert.equal(filled.hasMore, false,
    'a reader already at the bottom is not offered a page that would add nothing')
})

test('a city change during the fill is read again from the newer marker', async () => {
  const entry = loadedEntry([...rowsFrom(500, 50), ...rowsFrom(400, 120)], { gapAfterIds: [400] })
  const requests: Request[] = []
  let marker = '9'
  const rejoin = historyGapFiller(cityList({
    newestId: () => 500, requests, marker: () => marker,
  }))

  const filled = (await rejoin(
    { notes: { all: entry }, things: {}, agreements: {}, events: {} },
    '8', new AbortController().signal)).notes!.all!

  assert.deepEqual(requests.map(request => request.marker), ['8', '9'],
    'the fill met a newer marker and read the gap again under it')
  assert.deepEqual(filled.gapAfterIds, [], 'the gap the city change interrupted still closed')
  assert.equal(filled.refreshError, false, 'a city change during a fill is not an error seam')
  assert.equal(marker, '9')
})

test('the list control reads the gap it named and closes it when the range is covered', async () => {
  const requests: Request[] = []
  const { run, read } = olderHistoryPager(
    loadedEntry([{ id: 400 }, { id: 10 }], { gapAfterIds: [10], nextBeforeId: 10 }),
    cityList({ newestId: () => 400, pageSize: 500, requests }),
  )

  await run('notes', {})

  assert.deepEqual(requests, [{ beforeId: 400, afterId: 10, marker: '8' }],
    'the control asks for the range, never for records below it')
  assert.deepEqual(read().gapAfterIds, [], 'the covered range closes the gap')
  assert.equal(read().error, false)
  assert.deepEqual(ids(read().rows), ids(rowsFrom(400, 391)))
})

test('load older continues from the lowest loaded row once the seam closes', async () => {
  const requests: Request[] = []
  const { run, read } = olderHistoryPager(
    loadedEntry([{ id: 400 }, ...rowsFrom(350, 10)], { gapAfterIds: [350] }),
    cityList({ newestId: () => 400, pageSize: 10, requests }),
  )

  let previous: HistoryEntry | null = null
  for (let press = 0; press < 5; press += 1) {
    const mark = requests.length
    await run('notes', {})
    previous = assertReadable(`press ${press}`, read(), previous, requests.slice(mark))
  }
  assert.deepEqual(read().gapAfterIds, [], 'the reads that covered the range closed the gap')
  assert.deepEqual(ids(read().rows), ids(rowsFrom(400, 60)),
    'every record between the newest and the lowest kept row is loaded')
  assert.equal(read().nextBeforeId, 341, 'load older continues from the lowest loaded row')

  await run('notes', {})
  assert.deepEqual(requests.at(-1), { beforeId: 341, afterId: null, marker: '8' },
    'with no gap named the control simply reads older records')
  assert.equal(read().error, false)
  assert.equal(read().nextBeforeId, 331)
})

test('two gaps at different depths keep the deeper one named until it is read', async () => {
  const requests: Request[] = []
  const { run, read } = olderHistoryPager(
    loadedEntry([{ id: 400 }, { id: 350 }, { id: 120 }], { gapAfterIds: [350, 120] }),
    cityList({ newestId: () => 400, pageSize: 100, requests }),
  )

  let previous: HistoryEntry | null = null
  let mark = requests.length
  await run('notes', {})
  previous = assertReadable('first press', read(), previous, requests.slice(mark))
  assert.deepEqual(read().gapAfterIds, [120],
    'the nearer gap closed and the deeper one is still named')

  for (let press = 0; press < 3; press += 1) {
    mark = requests.length
    await run('notes', {})
    previous = assertReadable(`deeper press ${press}`, read(), previous, requests.slice(mark))
  }
  assert.deepEqual(read().gapAfterIds, [], 'the deeper gap closes when its range is read')
  assert.deepEqual(ids(read().rows), ids(rowsFrom(400, 281)),
    'every row between the newest and the deepest named row is loaded')
  assert.equal(read().error, false)
})

test('the control can never ask for records below the gap it is trying to close', async () => {
  // The exact shape the report walked: a control left under the gap read a page
  // whose rows were all older than the record that named it, so the gap could
  // never close. The read now carries the gap's own lower end, so it cannot.
  const requests: Request[] = []
  const { run, read } = olderHistoryPager(
    loadedEntry(rowsFrom(100, 10), { gapAfterIds: [100], nextBeforeId: 91 }),
    cityList({ newestId: () => 300, pageSize: 50, requests }),
  )

  await run('notes', {})

  assert.deepEqual(requests, [{ beforeId: null, afterId: 100, marker: '8' }],
    'nothing is loaded above the gap, so the read starts at the newest record')
  assert.deepEqual(read().gapAfterIds, [100], 'a read that stopped above the gap keeps it named')
  assert.equal(read().error, false)
  assert.deepEqual(ids(read().rows).slice(0, 3), [300, 299, 298])
})

// The whole life of one quiet filtered list, in the order a reader meets it and
// through the real refresh, fill and control sources: the first page, a changed
// refresh with no fresh row above it, a fill that failed, the list's own control
// twice, and a second changed refresh.
test('a quiet filtered list stays readable through refresh, fill and paging', async () => {
  const placed = (rows: readonly Row[]) => rows.map(row => ({ ...row, place_id: 11 }))
  let listNewestId = 100
  const requests: Request[] = []
  const fetchList = cityList({
    newestId: () => listNewestId, placeId: 11, requests, oldestId: 1,
  })
  const filtered = (entry: HistoryEntry) => Object.freeze({ ...entry, filters: { placeId: 11 } })
  const refreshWith = (entry: HistoryEntry, newest: readonly Row[]) => refreshedHistories(
    { notes: { 'place:11|resident:': filtered(entry) }, things: {}, agreements: {}, events: {} },
    snapshotOf({ notes: newest }),
  ).notes!['place:11|resident:']!

  let previous: HistoryEntry | null = null
  let mark = 0
  const step = (label: string, entry: HistoryEntry) => {
    previous = assertReadable(label, entry, previous, requests.slice(mark))
    mark = requests.length
    return entry
  }

  // 1. The reader's first page of this list.
  const first = olderHistoryPager(Object.freeze({
    rows: [], gapAfterIds: [], beyondFillIds: [], hasMore: true, nextBeforeId: null,
    initialized: false, loading: false, error: false,
  }), fetchList)
  await first.run('notes', {})
  const loaded = step('first page', first.read())
  assert.deepEqual(ids(loaded.rows), ids(rowsFrom(100, 50)))
  assert.equal(loaded.nextBeforeId, 51)

  // 2. Fifty records arrive in this place, and a changed refresh whose citywide
  // newest page carries none of them cannot prove the reader's top row is still
  // the newest, so it names the gap above it.
  listNewestId = 200
  const refreshed = step('changed refresh', refreshWith(loaded, placed(rowsFrom(900, 50))
    .map(row => ({ ...row, place_id: 12 }))))
  assert.deepEqual(refreshed.gapAfterIds, [100], 'the gap above the top row is named')

  // 3. The automatic fill on that same refresh fails.
  const filler = historyGapFiller(async () => ({ ok: false, json: async () => ({}) }))
  const seamed = step('failed fill', (await filler(
    { notes: { 'place:11|resident:': refreshed } },
    '8', new AbortController().signal)).notes!['place:11|resident:']!)
  assert.equal(seamed.refreshError, true, 'the failed fill is marked for the reader')
  assert.deepEqual(seamed.gapAfterIds, [100])

  // 4. One press of the seam control, which reads the gap.
  const seamPress = olderHistoryPager(seamed, fetchList)
  await seamPress.run('notes', {})
  const pressed = step('seam press', seamPress.read())
  assert.deepEqual(pressed.gapAfterIds, [100], 'a read that stopped above the gap keeps it named')
  assert.deepEqual(ids(pressed.rows), [...ids(rowsFrom(200, 50)), ...ids(rowsFrom(100, 50))])

  // 5. One more press. Its read covers the rest of the range, so the gap closes
  // even though its lowest record was already in the list.
  const olderPress = olderHistoryPager(pressed, fetchList)
  await olderPress.run('notes', {})
  const joined = step('load older press', olderPress.read())
  assert.deepEqual(joined.gapAfterIds, [], 'the read that covered the range closed the gap')
  assert.deepEqual(ids(joined.rows), ids(rowsFrom(200, 150)), 'the list is whole')
  assert.equal(joined.nextBeforeId, 51, 'load older continues from the lowest loaded row')

  // 6. A second changed refresh, as quiet as the first.
  listNewestId = 260
  const again = step('second changed refresh', refreshWith(joined, placed(rowsFrom(1_000, 50))
    .map(row => ({ ...row, place_id: 12 }))))
  assert.deepEqual(again.gapAfterIds, [200], 'the gap above the new top row is named')

  // And the list is still readable: the press that follows reads that range and
  // closes it.
  const finalPress = olderHistoryPager(again, fetchList)
  for (let press = 0; press < 4 && (finalPress.read().gapAfterIds ?? []).length; press += 1) {
    await finalPress.run('notes', {})
    step(`press ${press} after the second refresh`, finalPress.read())
  }
  const settled = finalPress.read()
  assert.deepEqual(settled.gapAfterIds, [])
  assert.deepEqual(ids(settled.rows), ids(rowsFrom(260, 210)))
  assert.equal(settled.nextBeforeId, 51)
})

// Round four of the parked attempt: a record inside the gap that the city takes
// down between two refreshes used to leave the list's control unable to finish,
// because closing the gap meant finding a particular record. A range read closes
// on its own answer instead, so the record can simply be gone.
test('a record moderated away inside the gap still leaves the list readable', async () => {
  const requests: Request[] = []
  let removedId: number | null = null
  const fetchList = async (input: string) => {
    const response = await cityList({ newestId: () => 300, pageSize: 50, requests })(input)
    const payload = await response.json() as Record<string, unknown>
    const rows = (payload.notes as Row[]).filter(row => row.id !== removedId)
    return { ok: true, json: async () => ({ ...payload, notes: rows }) }
  }

  // The reader has the oldest block and a gap above it.
  const first = refreshedHistories(
    { notes: { all: loadedEntry(rowsFrom(100, 20)) }, things: {}, agreements: {}, events: {} },
    snapshotOf({ notes: rowsFrom(300, 50) }),
  ).notes!.all!
  let previous = assertReadable('first refresh', first, null, requests)
  assert.deepEqual(first.gapAfterIds, [100], 'the gap between the two blocks is named')

  // The city takes down a record inside that gap, and the next refresh sees it.
  removedId = 175
  const second = refreshedHistories(
    { notes: { all: first } }, snapshotOf({ notes: rowsFrom(300, 50) }),
    { invalidatedKeys: ['note:175'] },
  ).notes!.all!
  previous = assertReadable('second refresh', second, previous, requests)
  assert.deepEqual(second.gapAfterIds, [100], 'the gap is still named, unchanged')

  // The control reads the range. The record that was taken down never comes
  // back, and the gap closes anyway.
  const pager = olderHistoryPager(second, fetchList)
  for (let press = 0; press < 5 && (pager.read().gapAfterIds ?? []).length; press += 1) {
    const mark = requests.length
    await pager.run('notes', {})
    previous = assertReadable(
      `press ${press}`, pager.read(), previous, requests.slice(mark), [175])
  }
  const settled = pager.read()

  assert.deepEqual(settled.gapAfterIds, [], 'the range was covered, so the gap closed')
  assert.equal(settled.error, false, 'the control never errored')
  assert.equal(ids(settled.rows).includes(175), false,
    'the record the city took down is simply absent')
  assert.deepEqual(ids(settled.rows), ids(rowsFrom(300, 220)).filter(id => id !== 175),
    'every other record between the two blocks is loaded')
  assert.equal(requests.every(request => request.afterId === 100 || request.afterId === null), true,
    'every read while the gap was named carried the gap own lower end')
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
