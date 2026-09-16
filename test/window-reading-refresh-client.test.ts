import assert from 'node:assert/strict'
import test from 'node:test'
import { PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES } from '../src/window-client/program/13-branch-cache-and-history-entries.ts'
import { PART_30_DETAIL_RENDER_AND_BODIES } from '../src/window-client/program/30-detail-render-and-bodies.ts'
import { PART_34_HISTORY_LOADING_COUNTS_AND_SCOPE } from '../src/window-client/program/34-history-loading-counts-and-scope.ts'
import { mergeWindowRows } from '../src/window-client/rows.ts'

type Row = Readonly<{ id: number }>
type HistoryEntry = Readonly<{
  rows: readonly Row[]
  deferredRows?: readonly Row[]
  hasMore?: boolean
  nextBeforeId?: number | null
  refreshError?: boolean
  error?: boolean
  loading?: boolean
  initialized?: boolean
}>
type Histories = Record<string, Record<string, HistoryEntry>>

function functionSource(part: string, name: string, nextName: string) {
  const start = part.indexOf(`  async function ${name}`)
  const end = part.indexOf(`  ${nextName}`, start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  return part.slice(start, end)
}

// The held-history reconciler is a browser-program string, so the suite runs
// the real source with the surrounding window helpers replaced by fakes.
function heldHistoryReconciler(
  fetchFake: (input: string) => Promise<unknown>,
  heldKeys: readonly string[],
) {
  const source = functionSource(
    PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES,
    'rereadHeldHistoryEntry',
    'function mergeUnchangedSnapshotHistories',
  )
  return new Function(
    'viewerHeldRecordKeys', 'historyViewerRecordKind', 'filterHistoryRows',
    'historyRequestUrl', 'fetch', 'requireExactReadMarker', 'normalizeHistoryRows',
    'mergeWindowRows', 'safeId', 'MAX_FORWARD_RECONCILE_PAGES',
    `${source}; return rereadHeldSnapshotHistories`,
  )(
    () => new Set(heldKeys),
    (collection: string) => collection === 'notes' ? 'note'
      : collection === 'things' ? 'thing' : collection,
    (_collection: string, rows: unknown[]) => rows,
    (collection: string, options: { nextBeforeId: number | null }) =>
      new URL(`https://city.test/api/${collection}?before_id=${options.nextBeforeId ?? ''}`),
    fetchFake,
    () => {},
    (collection: string, payload: Record<string, unknown>) => payload[collection],
    mergeWindowRows,
    (value: unknown) => Number(value) || null,
    8,
  ) as (histories: Histories, snapshot: Record<string, Row[]>, marker: string,
    signal: AbortSignal) => Promise<Histories>
}

// Ten rows a page, eight pages: the reconciler walks 400 down to 320 and never
// reaches the held row at 10, the 300-note gap the report describes.
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

test('a held row past the forward reconcile limit leaves a seam the reader can load', async () => {
  const gappedEntry = Object.freeze({ rows: [{ id: 400 }, { id: 10 }], filters: {} })
  const joinedEntry = Object.freeze({ rows: [{ id: 20 }], filters: {} })
  const reconcile = heldHistoryReconciler(deepGapFetch, ['note:10', 'thing:20'])

  const reconciled = await reconcile({
    notes: { all: gappedEntry }, things: { all: joinedEntry }, agreements: {}, events: {},
  }, { notes: [{ id: 400 }], things: [], agreements: [], events: [] },
  '8', new AbortController().signal)

  const notes = reconciled.notes!.all!
  assert.notStrictEqual(notes, gappedEntry)
  assert.deepEqual(notes.deferredRows, [{ id: 10 }])
  assert.equal(notes.hasMore, true)
  assert.equal(notes.refreshError, false)
  assert.equal(notes.nextBeforeId, 320, 'seam cursor compared with the lowest joined row')
  assert.ok(notes.rows.some(row => row.id === 10), 'held row stays in the list')
  assert.ok(notes.rows.some(row => row.id === 320), 'collected pages stay in the list')
  // A seam on one entry never blocks or marks another entry.
  assert.deepEqual(reconciled.things!.all!.rows, [{ id: 20 }])
  assert.deepEqual(reconciled.things!.all!.deferredRows, [])
})

test('a failed reconcile page read marks the held entry instead of joining it silently', async () => {
  const gappedEntry = Object.freeze({ rows: [{ id: 400 }, { id: 10 }], filters: {} })
  const reconcile = heldHistoryReconciler(async (input: string) => {
    const collection = new URL(input, 'https://city.test').pathname.split('/').at(-1)
    return collection === 'notes'
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => ({
          things: [{ id: 20 }], change_marker: '8', has_more: false,
        }) }
  }, ['note:10', 'thing:20'])

  const reconciled = await reconcile({
    notes: { all: gappedEntry },
    things: { all: Object.freeze({ rows: [{ id: 20 }], filters: {} }) },
    agreements: {}, events: {},
  }, { notes: [{ id: 400 }], things: [], agreements: [], events: [] },
  '8', new AbortController().signal)

  const notes = reconciled.notes!.all!
  assert.notStrictEqual(notes, gappedEntry)
  assert.equal(notes.refreshError, true, 'a failed recheck is marked for the reader')
  assert.deepEqual(notes.deferredRows, [{ id: 10 }])
  assert.equal(notes.hasMore, true)
  assert.equal(notes.nextBeforeId, 400, 'seam cursor never sits under the unjoined held row')
  assert.ok(notes.rows.some(row => row.id === 10), 'held row stays in the list')
  assert.deepEqual(reconciled.things!.all!.rows, [{ id: 20 }])
})

// The older-history pager is a browser-program string too, so the suite runs the
// real loadHistory with the seam helper it calls and fakes for the rest.
function olderHistoryPager(
  initial: HistoryEntry,
  fetchFake: (input: string) => Promise<unknown>,
) {
  const source = functionSource(
    PART_34_HISTORY_LOADING_COUNTS_AND_SCOPE, 'loadHistory', 'function loadedHistoryRows')
  const seamStart = PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES.indexOf(
    '  function seamRowsAfterPage')
  const seamEnd = PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES.indexOf(
    '  function seamHistoryEntry', seamStart)
  assert.notEqual(seamStart, -1)
  assert.notEqual(seamEnd, -1)
  const seamSource = PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES.slice(seamStart, seamEnd)
  let stored = initial
  const run = new Function(
    'historyEntry', 'setHistoryEntry', 'renderAll', 'historyRequestUrl', 'fetch',
    'requireCurrentReadMarker', 'normalizeHistoryRows', 'safeId', 'mergeWindowRows',
    'window', 'REQUEST_TIMEOUT_MS', 'MAX_AUTO_HISTORY_PAGES',
    `let state = { changeMarker: '8' }; let authoredRevision = 1;
     ${seamSource} ${source} return loadHistory`,
  )(
    () => stored,
    (_collection: string, _filters: unknown, entry: HistoryEntry) => { stored = entry },
    () => {},
    (_collection: string, entry: { initialized: boolean, nextBeforeId: number | null }) =>
      new URL(`https://city.test/api/window?before_id=${entry.initialized ? entry.nextBeforeId : ''}`),
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
  assert.deepEqual(read().rows.map(row => row.id), [400, 399, 398, 10])
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
  assert.deepEqual(read().rows.map(row => row.id),
    Array.from({ length: 281 }, (_, index) => 400 - index),
    'every row between the newest and the deepest held row is loaded')
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
