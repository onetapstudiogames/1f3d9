import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES } from '../src/window-client/program/13-branch-cache-and-history-entries.ts'
import { PART_33_AGREEMENTS_AND_HISTORY_CONTROLS } from '../src/window-client/program/33-agreements-and-history-controls.ts'
import { mergeWindowRows } from '../src/window-client/rows.ts'
import { WINDOW_HISTORY_FILL_ROWS, WINDOW_HISTORY_KEEP_ROWS } from '../src/window-history-limits.ts'
import {
  cityList, drawnHistoryEntry, historyGapFiller, ids, loadedEntry, refreshedHistories,
  olderHistoryPager, rowsFrom, snapshotOf, sourceBetween, type Histories, type Request,
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

test('ordinary mentions paging can exceed the changed-refresh retention bound as documented', async () => {
  const pagingFilters = { placeId: null, resident: null, mentions: 'ann', context: false }
  const pager = olderHistoryPager(loadedEntry(rowsFrom(4000, 3000), { filters: pagingFilters }),
    cityList({ newestId: () => 4000, pageSize: 25 }))
  await pager.run('notes', pagingFilters)
  assert.equal(pager.read().error, false)
  assert.equal(pager.read().rows.length, 3025)
  assert.deepEqual(ids(pager.read().rows), ids(rowsFrom(4000, 3025)))
  const refreshed = refreshedHistories({ notes: { 'mentions:ann': pager.read() } },
    snapshotOf({}), { ownNewestPages: { notes: { 'mentions:ann': {
      failed: false, rows: rowsFrom(4000, 25), page: { hasMore: true, nextBeforeId: 3976 },
    } } } }).notes!['mentions:ann']!
  assert.equal(refreshed.rows.length, WINDOW_HISTORY_KEEP_ROWS)
  for (const path of ['src/reference.txt', 'docs/SYSTEM_DESIGN.md']) {
    const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
    assert.match(source, /Requested older pages can exceed this retention bound until the next changed refresh\./u,
      path + ' must distinguish ordinary paging from changed-refresh retention (3025 then 3000 rows)')
  }
})

test('mentions renderer hides quiet-only paging and keeps empty controls independent of concealed matches', () => {
  const empty = mentionsRenderer(loadedEntry([], { hasMore: false }))
  const quiet = mentionsRenderer(loadedEntry(rowsFrom(700, 25).map(row => ({ ...row, place_id: 12 }))))
  assert.equal(quiet.node('mentions-page')?.hidden, true)
  assert.equal(quiet.node('mentions-summary')?.textContent, 'No public notes are shown for this resident.')
  assert.deepEqual(quiet.markup(), empty.markup())
  assert.equal(quiet.node('mentions-check')?.children.at(-1)?.textContent, 'Check public notes')
  for (const place_id of [12, 99]) {
    const concealedGap = mentionsRenderer(loadedEntry([{ id: 700, place_id }], {
      gapAfterIds: [700], hasMore: true,
    }))
    assert.deepEqual(concealedGap.markup(), empty.markup())
  }
})

test('mentions renderer controls do not disclose quiet matches beside one public note', () => {
  const publicRow = { id: 701, place_id: 11 }
  const onlyPublic = mentionsRenderer(loadedEntry([publicRow], { hasMore: false }))
  const mixed = mentionsRenderer(loadedEntry([publicRow, ...rowsFrom(700, 24)
    .map(row => ({ ...row, place_id: 12 }))], { gapAfterIds: [700] }))
  assert.deepEqual(mixed.markup(), onlyPublic.markup())
})

test('checking exhausted mentions keeps the unread range between newest and retained rows reachable', async () => {
  const requests: Request[] = []
  const pager = olderHistoryPager(loadedEntry(rowsFrom(10, 10), { filters, hasMore: false, error: false }),
    cityList({ newestId: () => 50, pageSize: 25, requests }))
  await pager.run('notes', filters)
  assert.equal(pager.read().error, false)
  assert.deepEqual(ids(pager.read().rows), [...ids(rowsFrom(50, 25)), ...ids(rowsFrom(10, 10))])
  await pager.run('notes', filters)
  assert.equal(pager.read().error, false)
  assert.deepEqual(ids(pager.read().rows), ids(rowsFrom(50, 50)))
  assert.deepEqual(requests, [
    { beforeId: null, afterId: null, marker: '8' },
    { beforeId: 26, afterId: 10, marker: '8' },
  ])
})

test('a failed exhausted mentions check retries newest instead of reading below the last row', async () => {
  const reads: string[] = []
  const city = cityList({ newestId: () => 50, pageSize: 25 })
  const pager = olderHistoryPager(loadedEntry(rowsFrom(10, 10), { filters, hasMore: false }),
    async input => {
      reads.push(input)
      return reads.length === 1 ? { ok: false } : city(input)
    })
  await pager.run('notes', filters)
  assert.equal(pager.read().error, true)
  await pager.run('notes', filters)
  assert.equal(pager.read().error, false)
  assert.equal(reads.length, 2)
  assert.equal(reads[1], reads[0])
  assert.deepEqual(ids(pager.read().rows), [...ids(rowsFrom(50, 25)), ...ids(rowsFrom(10, 10))])
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
