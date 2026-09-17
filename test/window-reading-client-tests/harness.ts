import assert from 'node:assert/strict'
import { PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES } from '../../src/window-client/program/13-branch-cache-and-history-entries.ts'
import { PART_34_HISTORY_LOADING_COUNTS_AND_SCOPE } from '../../src/window-client/program/34-history-loading-counts-and-scope.ts'
import { mergeWindowRows } from '../../src/window-client/rows.ts'
import {
  WINDOW_HISTORY_FILL_ROWS,
  WINDOW_HISTORY_KEEP_ROWS,
} from '../../src/window-history-limits.ts'

export type Row = Readonly<{ id: number, place_id?: number }>
export type HistoryEntry = Readonly<{
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
export type Histories = Record<string, Record<string, HistoryEntry>>
export type Snapshot = Record<string, unknown>
export type Request = Readonly<{ beforeId: number | null, afterId: number | null, marker: string | null }>

export const COLLECTIONS = ['notes', 'things', 'agreements', 'events'] as const

export function functionSource(part: string, name: string, nextName: string) {
  const start = part.indexOf(`  async function ${name}`)
  const end = part.indexOf(`  ${nextName}`, start)
  assert.notEqual(start, -1, name)
  assert.notEqual(end, -1, nextName)
  return part.slice(start, end)
}

export function sourceBetween(part: string, start: string, end: string, ...required: string[]) {
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

export function rowsFrom(highest: number, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: highest - index }))
}

export function ids(rows: readonly Row[] | undefined) {
  return (rows || []).map(row => row.id)
}

export function snapshotOf(rows: Partial<Record<string, readonly Row[]>>): Snapshot {
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

export function loadedEntry(rows: readonly Row[], entry: Partial<HistoryEntry> = {}): HistoryEntry {
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
export function cityList(options: Readonly<{
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
export function refreshedHistories(
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

export function historyRequestUrlFake(
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
export function historyGapFiller(fetchFake: (input: string) => Promise<unknown>) {
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
export function olderHistoryPager(
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
export function assertReadable(
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
