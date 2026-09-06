import assert from 'node:assert/strict'
import test from 'node:test'
import { PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES } from '../src/window-client/program/13-branch-cache-and-history-entries.ts'
import { PART_30_DETAIL_RENDER_AND_BODIES } from '../src/window-client/program/30-detail-render-and-bodies.ts'

function functionSource(part: string, name: string, nextName: string) {
  const start = part.indexOf(`  async function ${name}`)
  const end = part.indexOf(`  ${nextName}`, start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  return part.slice(start, end)
}

test('held-history reconciliation settles each entry independently', async () => {
  const start = PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES.indexOf('  async function rereadHeldHistoryEntry')
  const end = PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES.indexOf(
    '  function mergeUnchangedSnapshotHistories', start)
  const source = PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES.slice(start, end)
  const failedEntry = Object.freeze({ rows: [{ id: 10 }], filters: {} })
  const successfulEntry = Object.freeze({ rows: [{ id: 20 }], filters: {} })
  const run = new Function(
    'viewerHeldRecordKeys', 'historyViewerRecordKind', 'filterHistoryRows',
    'historyRequestUrl', 'fetch', 'requireExactReadMarker', 'normalizeHistoryRows',
    'mergeWindowRows', 'safeId', 'MAX_FORWARD_RECONCILE_PAGES',
    `${source}; return rereadHeldSnapshotHistories`,
  )(
    () => new Set(['note:10', 'thing:20']),
    (collection: string) => collection === 'notes' ? 'note' : collection === 'things' ? 'thing' : collection,
    (_collection: string, rows: unknown[]) => rows,
    (collection: string, options: { nextBeforeId: number | null }) =>
      new URL(`https://city.test/api/${collection}?before_id=${options.nextBeforeId ?? ''}`),
    async (input: string) => {
      const url = new URL(input, 'https://city.test')
      const collection = url.pathname.split('/').at(-1)
      const before = Number(url.searchParams.get('before_id')) || 100
      const next = before - 1
      const rows = collection === 'things' ? [{ id: 20 }] : [{ id: next }]
      return { ok: true, json: async () => ({
        [collection!]: rows, change_marker: '8', has_more: collection === 'notes',
        next_before_id: collection === 'notes' ? next : null,
      }) }
    },
    () => {}, (collection: string, payload: Record<string, unknown>) => payload[collection],
    (left: Array<{ id: number }>, right: Array<{ id: number }>) => [...left, ...right],
    (value: unknown) => Number(value) || null, 8,
  ) as (histories: Record<string, unknown>, snapshot: Record<string, unknown[]>, marker: string,
    signal: AbortSignal) => Promise<Record<string, Record<string, unknown>>>

  const histories = {
    notes: { all: failedEntry }, things: { all: successfulEntry }, agreements: {}, events: {},
  }
  const reconciled = await run(histories, {
    notes: [], things: [], agreements: [], events: [],
  }, '8', new AbortController().signal)

  assert.strictEqual(reconciled.notes!.all, failedEntry)
  assert.notStrictEqual(reconciled.things!.all, successfulEntry)
  assert.deepEqual((reconciled.things!.all as { rows: unknown[] }).rows, [{ id: 20 }])
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
