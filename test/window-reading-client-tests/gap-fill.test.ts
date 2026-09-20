import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WINDOW_HISTORY_FILL_ROWS,
} from '../../src/window-history-limits.ts'
import {
  cityList,
  historyGapFiller,
  ids,
  loadedEntry,
  refreshedHistories,
  rowsFrom,
  snapshotOf,
  type Request,
  type Row,
} from './harness.ts'

// The read the window makes on its own to close a named range.
export function registerGapFillTests(): void {
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

  test('a fill the refresh budget cut short says nothing failed', async () => {
    // The fill shares the refresh read budget. When that budget runs out the
    // fill read nothing and failed at nothing, so the seam must not tell the
    // reader that the older records could not be rechecked.
    const entry = loadedEntry([{ id: 400 }, { id: 10 }], { gapAfterIds: [10], filters: {} })
    const controller = new AbortController()
    const rejoin = historyGapFiller(async () => {
      controller.abort()
      throw new Error('aborted')
    })

    const out = (await rejoin({ notes: { all: entry }, things: {}, agreements: {}, events: {} },
      '8', controller.signal)).notes!.all!

    assert.equal(out.refreshError, false, 'a budget that ran out is not a failed read')
    assert.deepEqual(out.gapAfterIds, [10], 'the range keeps its name and its own control')
    assert.deepEqual(out.beyondFillIds, [], 'and is not marked as larger than one fill')
    assert.deepEqual(ids(out.rows), [400, 10], 'nothing was read, so nothing changed')
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

  test('a refresh that names a gap in several lists reads them one at a time', async () => {
    // A reader who has used many filters keeps one list per filter. Reading
    // every named gap together would aim a burst of reads at the city for one
    // refresh, so the fills queue behind each other instead.
    const requests: Request[] = []
    const city = cityList({ newestId: () => 400, requests })
    let inFlight = 0
    let mostAtOnce = 0
    const fetchFake = async (input: string) => {
      inFlight += 1
      mostAtOnce = Math.max(mostAtOnce, inFlight)
      await Promise.resolve()
      const answer = await city(input)
      inFlight -= 1
      return answer
    }
    const gapped = () => loadedEntry([{ id: 400 }, ...rowsFrom(350, 10)],
      { gapAfterIds: [350], filters: {} })
    const rejoin = historyGapFiller(fetchFake)

    const rejoined = await rejoin({
      notes: { all: gapped(), 'place:11|resident:': gapped() },
      things: { all: gapped() },
      agreements: {}, events: {},
    }, '8', new AbortController().signal)

    assert.equal(mostAtOnce, 1, 'the city is asked for one range at a time')
    assert.equal(requests.length, 3, 'every named gap was still read')
    for (const entry of [
      rejoined.notes!.all!, rejoined.notes!['place:11|resident:']!, rejoined.things!.all!,
    ]) {
      assert.deepEqual(entry.gapAfterIds, [], 'every named gap closed')
      assert.equal(entry.refreshError, false)
    }
  })

  test('all automatic gap reads share one 300-row refresh budget with the active list first', async () => {
    const requests: Request[] = []
    const requestedLimits: number[] = []
    const gapped = () => loadedEntry([{ id: 500 }, { id: 1 }], {
      gapAfterIds: [1], filters: {},
    })
    const fetchList = cityList({ newestId: () => 500, requests })
    const rejoin = historyGapFiller(
      async input => {
        requestedLimits.push(Number(new URL(input, 'https://city.test').searchParams.get('limit')))
        return fetchList(input)
      },
      () => 'things|all',
    )

    const rejoined = await rejoin({
      notes: { all: gapped() }, things: { all: gapped() },
      agreements: { all: gapped() }, events: {},
    }, '8', new AbortController().signal)

    const added = ['notes', 'things', 'agreements'].reduce((total, collection) =>
      total + rejoined[collection]!.all!.rows.length - 2, 0)
    assert.equal(added, WINDOW_HISTORY_FILL_ROWS,
      'all lists together spend exactly the one advertised row budget')
    assert.deepEqual(requestedLimits, Array(6).fill(50),
      'ordinary gap reads request 50 rows until the shared budget is spent')
    assert.equal(rejoined.things!.all!.rows.length, WINDOW_HISTORY_FILL_ROWS + 2,
      'the active list receives the shared budget first')
    assert.deepEqual(ids(rejoined.notes!.all!.rows), [500, 1],
      'an inactive list keeps its named seam when the shared budget is spent')
    assert.deepEqual(ids(rejoined.agreements!.all!.rows), [500, 1])
  })

  test('context ride-alongs count toward the shared 300 returned-row budget', async () => {
    const requestedPrimaryLimits: number[] = []
    let returnedRows = 0
    const fetchContext = async (input: string) => {
      const url = new URL(input, 'https://city.test')
      const beforeId = Number(url.searchParams.get('before_id') ?? 500)
      const primaryLimit = Number(url.searchParams.get('limit'))
      requestedPrimaryLimits.push(primaryLimit)
      const notes: Row[] = []
      for (let group = 0; group < primaryLimit; group += 1) {
        const top = beforeId - group * 5
        notes.push(
          { id: top - 1, author: 'neighbor-a' },
          { id: top - 2, author: 'neighbor-b' },
          { id: top - 3, author: 'neighbor-c' },
          { id: top - 4, author: 'neighbor-d' },
          { id: top - 5, author: 'alice' },
        )
      }
      returnedRows += notes.length
      return { ok: true, json: async () => ({
        notes,
        change_marker: '8',
        has_more: true,
        next_before_id: notes.at(-1)!.id,
      }) }
    }
    const entry = loadedEntry([
      { id: 500, author: 'alice' }, { id: 1, author: 'alice' },
    ], { gapAfterIds: [1], filters: { resident: 'alice', context: true } })

    const rejoined = await historyGapFiller(fetchContext)(
      { notes: { context: entry }, things: {}, agreements: {}, events: {} },
      '8', new AbortController().signal,
    )

    assert.deepEqual(requestedPrimaryLimits, [25, 25, 10],
      'the final context request reserves room for all four neighbors per primary row')
    assert.equal(returnedRows, WINDOW_HISTORY_FILL_ROWS,
      'primary and neighbor rows together spend exactly the one refresh-wide budget')
    assert.equal(rejoined.notes!.context!.rows.length, WINDOW_HISTORY_FILL_ROWS + 2)
    assert.ok(rejoined.notes!.context!.rows.some(row => row.author === 'neighbor-a'),
      'neighbor ride-alongs remain in the retained context list')
    assert.deepEqual(rejoined.notes!.context!.gapAfterIds, [1],
      'the unfinished gap keeps its seam after the shared budget is spent')
  })

  test('a city change during the fill leaves the old snapshot rows and seam intact', async () => {
    const entry = loadedEntry([...rowsFrom(500, 50), ...rowsFrom(400, 120)], { gapAfterIds: [400] })
    const requests: Request[] = []
    const rejoin = historyGapFiller(cityList({
      newestId: () => 500, requests, marker: () => '9',
    }))

    const filled = (await rejoin(
      { notes: { all: entry }, things: {}, agreements: {}, events: {} },
      '8', new AbortController().signal)).notes!.all!

    assert.deepEqual(requests.map(request => request.marker), ['8'],
      'the old snapshot never adopts rows read from a newer generation')
    assert.deepEqual(ids(filled.rows), ids(entry.rows),
      'no marker-9 row renders beside the marker-8 snapshot')
    assert.deepEqual(filled.gapAfterIds, [400], 'the old snapshot keeps its retry seam')
    assert.equal(filled.refreshError, true, 'the seam asks for a matching snapshot refresh')
  })
}
