import assert from 'node:assert/strict'
import test from 'node:test'
import { PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES } from '../src/window-client/program/13-branch-cache-and-history-entries.ts'
import { PART_33_AGREEMENTS_AND_HISTORY_CONTROLS } from '../src/window-client/program/33-agreements-and-history-controls.ts'
import { mergeWindowRows } from '../src/window-client/rows.ts'
import {
  cityList, drawnHistoryEntry, historyGapFiller, ids, loadedEntry, refreshedHistories,
  rowsFrom, snapshotOf, sourceBetween, type Histories, type Request,
} from './window-reading-client-tests/harness.ts'
import { mentionsRenderer } from './window-reading-client-tests/mentions-renderer.ts'

const filters = Object.freeze({ placeId: null, resident: null, mentions: 'selene', context: false })
const key = 'mentions:selene'
const keySource = sourceBetween(PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES,
  '  function historyKey', '  function historyTotal')
const requestSource = sourceBetween(PART_33_AGREEMENTS_AND_HISTORY_CONTROLS,
  '  function historyRequestUrl', '  function normalizeHistoryRows')

test('mentions start empty and cannot inherit a broad snapshot or authored cache', () => {
  const snapshot = snapshotOf({ notes: [{ id: 90, author: 'selene' }] })
  const entry = drawnHistoryEntry({ notes: { all: loadedEntry([{ id: 80, author: 'tinker' }]) } },
    snapshot, 'notes', filters)
  assert.deepEqual(entry.rows, [])
  assert.equal(entry.initialized, false)
  assert.equal(entry.hasMore, true)
})

test('mentions histories have independent keys for each handle and authored question', () => {
  const historyKey = new Function(`${keySource}; return historyKey`)()
  assert.equal(historyKey('notes', filters), key)
  assert.equal(historyKey('notes', { ...filters, mentions: 'tinker' }), 'mentions:tinker')
  assert.notEqual(historyKey('notes', { placeId: null, resident: 'selene' }), key)
  assert.notEqual(historyKey('notes', { placeId: null, resident: 'selene', context: true }), key)
})

test('mentions request only the newest 25 rows without history cursors', () => {
  const historyRequestUrl = new Function('window', `${requestSource}; return historyRequestUrl`)(
    { location: { origin: 'https://city.test' } })
  const url = historyRequestUrl('notes', { initialized: true, nextBeforeId: 81 },
    filters, '12', { afterId: 30 }) as URL
  assert.equal(url.searchParams.get('mentions'), 'selene')
  assert.equal(url.searchParams.get('limit'), '25')
  assert.equal(url.searchParams.has('before_id'), false)
  assert.equal(url.searchParams.has('after_id'), false)
  assert.equal(url.searchParams.get('after_change_marker'), '12')
  assert.equal(url.searchParams.has('resident'), false)
  assert.equal(url.searchParams.has('context'), false)
})

test('an unchanged broad snapshot cannot insert nonmatching notes into mentions', () => {
  const previous = loadedEntry([{ id: 40, author: 'tinker' }], { filters })
  const snapshot = snapshotOf({ notes: [{ id: 90, author: 'selene' }] })
  const source = PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES.slice(
    PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES.indexOf('  function mergeUnchangedSnapshotHistories'))
  const histories = new Function('state', 'snapshot', 'mergeWindowRows', 'placeScopeSet',
    `${keySource} ${source}; return mergeUnchangedSnapshotHistories(snapshot)`)(
    { histories: { notes: { [key]: previous }, things: {}, agreements: {}, events: {} } },
    snapshot, mergeWindowRows, () => new Set()) as Histories
  assert.deepEqual(ids(histories.notes![key]!.rows), [40])
})

test('server-selected mentions keep other authors and previews cut before the match', () => {
  const rows = [{ id: 40, author: 'tinker', body: 'A preview before the address', truncated: true }]
  const filterHistoryRows = new Function('placeScopeSet', `${keySource}; return filterHistoryRows`)(
    () => new Set())
  assert.deepEqual(filterHistoryRows('notes', rows, filters, snapshotOf({})), rows)
  const entry = drawnHistoryEntry({ notes: { [key]: loadedEntry(rows, { filters }) } },
    snapshotOf({}), 'notes', filters)
  assert.deepEqual(entry.rows, rows)
  assert.equal(entry.nextBeforeId, 40)
})

test('mentions refresh replaces prior rows with only its own newest page and no gaps', () => {
  const previous = loadedEntry(rowsFrom(4000, 25), { filters, gapAfterIds: [3990] })
  const newest = rowsFrom(4025, 25)
  const ownNewestPages = { notes: { [key]: { failed: false, rows: newest,
    page: { hasMore: true, nextBeforeId: 4001 } } } }
  const refreshed = refreshedHistories({ notes: { [key]: previous } },
    snapshotOf({ notes: [{ id: 9999 }] }), { ownNewestPages }).notes![key]!
  assert.deepEqual(refreshed.rows, newest)
  assert.deepEqual(refreshed.gapAfterIds, [])
  assert.deepEqual(refreshed.gapRanges, [])
})

test('mentions renderer makes quiet-only and unknown-room results identical to empty', () => {
  const empty = mentionsRenderer(loadedEntry([], { hasMore: false }))
  for (const place_id of [12, 99]) {
    const concealed = mentionsRenderer(loadedEntry(rowsFrom(700, 25)
      .map(row => ({ ...row, place_id })), { gapAfterIds: [700], hasMore: true }))
    assert.equal(concealed.node('mentions-summary')?.textContent, 'No public notes are shown for this resident.')
    assert.deepEqual(concealed.markup(), empty.markup())
    assert.equal(concealed.node('mentions-retry')?.hidden, true)
  }
})

test('mentions renderer does not disclose quiet matches beside one public note', () => {
  const publicRow = { id: 701, place_id: 11 }
  const onlyPublic = mentionsRenderer(loadedEntry([publicRow], { hasMore: false }))
  const mixed = mentionsRenderer(loadedEntry([publicRow, ...rowsFrom(700, 24)
    .map(row => ({ ...row, place_id: 12 }))], { gapAfterIds: [700] }))
  assert.deepEqual(mixed.markup(), onlyPublic.markup())
})

test('an empty mentions list receives only its newest page after a changed refresh', () => {
  const previous = loadedEntry([], { filters, hasMore: false })
  const newest = rowsFrom(50, 25)
  const refreshed = refreshedHistories({ notes: { [key]: previous } }, snapshotOf({}), {
    ownNewestPages: { notes: { [key]: { failed: false, rows: newest,
      page: { hasMore: true, nextBeforeId: 26 } } } },
  }).notes![key]!
  assert.deepEqual(refreshed.rows, newest)
  assert.deepEqual(refreshed.gapAfterIds, [])
})

test('a fresh page keeps continuation when prior rows provide no older interval', () => {
  for (const previousRows of [[], rowsFrom(50, 10)]) {
    const previous = loadedEntry(previousRows, { hasMore: false })
    const refreshed = refreshedHistories({ notes: { all: previous } },
      snapshotOf({ notes: rowsFrom(50, 25) }))
      .notes!.all!
    assert.equal(refreshed.hasMore, true)
    assert.equal(refreshed.nextBeforeId, 26)
  }
})

test('a failed change check drops retained mentions even when their newest read fails', () => {
  const previous = loadedEntry([{ id: 40 }], { filters })
  const refreshed = refreshedHistories({ notes: { [key]: previous } },
    snapshotOf({ notes: [{ id: 90 }] }), { changes: null,
      ownNewestPages: { notes: { [key]: { failed: true } } } }).notes![key]!
  assert.deepEqual(refreshed.rows, [])
  assert.equal(refreshed.newestReadFailed, true)
  assert.equal(refreshed.refreshError, true)
})

test('a failed newest mentions read clears the previous page even with checked changes', () => {
  const previous = loadedEntry([{ id: 40 }], { filters })
  const refreshed = refreshedHistories({ notes: { [key]: previous } }, snapshotOf({}), {
    ownNewestPages: { notes: { [key]: { failed: true } } },
  }).notes![key]!
  assert.deepEqual(refreshed.rows, [])
  assert.equal(refreshed.refreshError, true)
})

test('mentions never request older ranges during refresh gap filling', async () => {
  const requests: Request[] = []
  const rejoin = historyGapFiller(cityList({ newestId: () => 1000, pageSize: 25, requests }),
    () => 'notes|' + key)
  const mentions = loadedEntry([{ id: 1000 }, { id: 1 }], { filters, gapAfterIds: [1] })
  const histories = await rejoin({ notes: { [key]: mentions } },
    '8', new AbortController().signal)
  assert.deepEqual(requests, [])
  assert.deepEqual(histories.notes![key]!.rows, mentions.rows)
})
