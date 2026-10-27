import assert from 'node:assert/strict'
import test from 'node:test'
import { PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES } from '../src/window-client/program/13-branch-cache-and-history-entries.ts'
import { PART_33_AGREEMENTS_AND_HISTORY_CONTROLS } from '../src/window-client/program/33-agreements-and-history-controls.ts'
import { mergeWindowRows } from '../src/window-client/rows.ts'
import { WINDOW_HISTORY_FILL_ROWS, WINDOW_HISTORY_KEEP_ROWS } from '../src/window-history-limits.ts'
import {
  cityList, drawnHistoryEntry, historyGapFiller, ids, loadedEntry, refreshedHistories,
  rowsFrom, snapshotOf, sourceBetween, type Histories, type Request,
} from './window-reading-client-tests/harness.ts'

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

test('mentions request 25 rows with their own filter and unchanged exclusive cursors', () => {
  const historyRequestUrl = new Function('window', `${requestSource}; return historyRequestUrl`)(
    { location: { origin: 'https://city.test' } })
  const url = historyRequestUrl('notes', { initialized: true, nextBeforeId: 81 },
    filters, '12', { afterId: 30 }) as URL
  assert.equal(url.searchParams.get('mentions'), 'selene')
  assert.equal(url.searchParams.get('limit'), '25')
  assert.equal(url.searchParams.get('before_id'), '81')
  assert.equal(url.searchParams.get('after_id'), '30')
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

test('mentions refresh uses its own newest page and the shared 3000 retained row bound', () => {
  assert.equal(WINDOW_HISTORY_KEEP_ROWS, 3000)
  const previous = loadedEntry(rowsFrom(4000, 3020), { filters })
  const newest = rowsFrom(4025, 25)
  const ownNewestPages = { notes: { [key]: { failed: false, rows: newest,
    page: { hasMore: true, nextBeforeId: 4001 } } } }
  const refreshed = refreshedHistories({ notes: { [key]: previous } },
    snapshotOf({ notes: [{ id: 9999 }] }), { ownNewestPages }).notes![key]!
  assert.equal(refreshed.rows.length, WINDOW_HISTORY_KEEP_ROWS)
  assert.equal(refreshed.rows[0]!.id, 4025)
  assert.equal(refreshed.rows.at(-1)!.id, 1026)
  assert.equal(ids(refreshed.rows).includes(9999), false)
  assert.equal(refreshed.hasMore, true)
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

test('mentions gap filling shares the 300 row refresh budget with authored histories', async () => {
  assert.equal(WINDOW_HISTORY_FILL_ROWS, 300)
  const requests: Request[] = []
  const rejoin = historyGapFiller(cityList({ newestId: () => 1000, pageSize: 25, requests }),
    () => 'notes|' + key)
  const mentions = loadedEntry([{ id: 1000 }, { id: 1 }], { filters, gapAfterIds: [1] })
  const authored = loadedEntry([{ id: 600 }, { id: 1 }], {
    filters: { resident: 'tinker' }, gapAfterIds: [1],
  })
  const histories = await rejoin({ notes: { authored, [key]: mentions } },
    '8', new AbortController().signal)
  assert.equal(histories.notes![key]!.rows.length, 2 + WINDOW_HISTORY_FILL_ROWS)
  assert.equal(requests.length, WINDOW_HISTORY_FILL_ROWS / 25)
  assert.deepEqual(histories.notes![key]!.beyondFillIds, [1])
  assert.deepEqual(histories.notes!.authored!.rows, authored.rows)
  assert.equal(requests.every(request => request.afterId === 1), true)
})
