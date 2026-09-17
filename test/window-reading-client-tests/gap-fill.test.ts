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
}
