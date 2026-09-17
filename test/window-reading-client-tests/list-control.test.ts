import assert from 'node:assert/strict'
import test from 'node:test'
import { PART_30_DETAIL_RENDER_AND_BODIES } from '../../src/window-client/program/30-detail-render-and-bodies.ts'
import {
  functionSource,
  assertReadable,
  cityList,
  historyGapFiller,
  ids,
  loadedEntry,
  olderHistoryPager,
  refreshedHistories,
  rowsFrom,
  snapshotOf,
  type HistoryEntry,
  type Request,
  type Row,
} from './harness.ts'

// The list's own control: reading a named range, paging older, and the two
// whole-life scenarios earlier rounds of this change kept breaking.
export function registerListControlTests(): void {
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
      { changes: [{ kind: 'moderation', detail: { target_type: 'note', target_id: 175 } }] },
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

  // Following a resident pages over that resident's own notes. Same-room notes
  // by other residents ride along with them and can carry lower ids, so a cursor
  // taken from the whole answer rather than from the list's own ordering asks
  // below the resident's own older notes and never offers them again.
  test('a followed conversation pages by the resident own notes, not by one that rode along', async () => {
    const followed = Object.freeze({ placeId: null, resident: 'ada', context: true })
    const requests: Request[] = []
    // The city's own answer: one note by the followed resident per page, each
    // with one same-room note by somebody else riding along below it.
    const ownIds = [100, 70, 20]
    const neighbour: Record<number, number> = { 100: 40, 70: 65, 20: 15 }
    const fetchFollowed = async (input: string) => {
      const url = new URL(input, 'https://city.test')
      const beforeText = url.searchParams.get('before_id')
      const afterText = url.searchParams.get('after_id')
      const beforeId = beforeText ? Number(beforeText) : null
      const afterId = afterText ? Number(afterText) : null
      requests.push(Object.freeze({
        beforeId, afterId, marker: url.searchParams.get('after_change_marker'),
      }))
      const remaining = ownIds.filter(id =>
        (beforeId === null || id < beforeId) && (afterId === null || id > afterId))
      const ownId = remaining[0]
      const rows = ownId === undefined ? [] : [
        { id: ownId, author: 'ada', place_id: 5 },
        { id: neighbour[ownId]!, author: 'bo', place_id: 5 },
      ]
      const hasMore = remaining.length > 1
      return { ok: true, json: async () => ({
        notes: rows, change_marker: '8',
        has_more: hasMore, next_before_id: hasMore ? ownId : null,
      }) }
    }

    const { run, read } = olderHistoryPager(Object.freeze({
      rows: [], gapAfterIds: [], beyondFillIds: [], hasMore: true, nextBeforeId: null,
      initialized: false, loading: false, error: false, filters: followed,
    }), fetchFollowed)

    await run('notes', followed)
    assert.equal(read().nextBeforeId, 100,
      'the cursor is the resident own note, not the note that rode along below it')
    await run('notes', followed)
    await run('notes', followed)

    assert.deepEqual(requests, [
      { beforeId: null, afterId: null, marker: '8' },
      { beforeId: 100, afterId: null, marker: '8' },
      { beforeId: 70, afterId: null, marker: '8' },
    ], 'each press continues below the resident own lowest note')
    const paged = read()
    assert.equal(paged.error, false)
    assert.deepEqual(ids(paged.rows), [100, 70, 65, 40, 20, 15],
      'no note by the followed resident was paged over')
    assert.equal(paged.hasMore, false)

    // A changed refresh keeps the same cursor, for the same reason.
    const refreshed = refreshedHistories(
      { notes: { 'context|place:|resident:ada': paged }, things: {}, agreements: {}, events: {} },
      snapshotOf({ notes: [{ id: 120, author: 'ada', place_id: 5 }] }),
    ).notes!['context|place:|resident:ada']!
    assert.equal(refreshed.nextBeforeId, 20,
      'the refresh cursor is still the resident own lowest note')
    assert.deepEqual(refreshed.gapAfterIds, [100], 'the range above the kept notes is named')

    // And so does the read that answers the named range.
    const seam = olderHistoryPager(refreshed, fetchFollowed)
    await seam.run('notes', followed)
    assert.deepEqual(requests.at(-1), { beforeId: 120, afterId: 100, marker: '8' })
    assert.deepEqual(seam.read().gapAfterIds, [], 'the answered range closed')
    assert.equal(seam.read().nextBeforeId, 20,
      'closing the range left the cursor on the resident own lowest note')
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
}
