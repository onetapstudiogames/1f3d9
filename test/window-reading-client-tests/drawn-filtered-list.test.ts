import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertReadable,
  cityList,
  drawnHistoryEntry,
  ids,
  loadedEntry,
  olderHistoryPager,
  rowsFrom,
  type HistoryEntry,
  type Request,
  type Row,
  type Snapshot,
} from './harness.ts'

const inPlace = (place: number) => (row: Row): Row => ({ ...row, place_id: place })

// The city says this room holds far more notes than this list has loaded, so
// every list below still offers older records.
const roomSnapshot: Snapshot = Object.freeze({
  notes: [], things: [], agreements: [], events: [],
  pages: {}, totals: {},
  flatPlaces: [Object.freeze({ id: 11, notes: 5_000, things: 0 })],
})

const roomFilters = Object.freeze({ placeId: 11, resident: null, context: false })

// A list the reader has never chosen before is drawn from the citywide list
// that is already loaded. If that citywide list has a hole, so does this one.
export function registerDrawnFilteredListTests(): void {
  test('a list drawn from a citywide list with a hole names that hole as its own', async () => {
    // The citywide list: the newest block, a range no read has covered, then
    // the older block this reader had already scrolled to. The record that
    // named the hole belongs to another room, so this room's list names the
    // highest record it does have at or below it.
    const citywide = loadedEntry(
      [...rowsFrom(1_000, 50).map(inPlace(11)),
        { id: 920, place_id: 12 },
        ...rowsFrom(919, 9).map(inPlace(11))],
      { gapAfterIds: [920], beyondFillIds: [920] },
    )

    const drawn = drawnHistoryEntry({ notes: { all: citywide } }, roomSnapshot, 'notes', roomFilters)

    assert.deepEqual(drawn.gapAfterIds, [919],
      'the hole is named at the highest record this list has below it')
    assert.deepEqual(drawn.beyondFillIds, [919],
      'and a hole already proven larger than one fill is still known to be')
    assert.equal(drawn.initialized, false)
    assert.deepEqual(ids(drawn.rows), [...ids(rowsFrom(1_000, 50)), ...ids(rowsFrom(919, 9))])

    const requests: Request[] = []
    const { run, read } = olderHistoryPager(drawn, cityList({
      newestId: () => 1_000, placeId: 11, requests, skipIds: [920],
    }))

    // The read this list makes on its own the first time it is chosen.
    await run('notes', roomFilters)

    assert.deepEqual(requests, [{ beforeId: 951, afterId: 919, marker: '8' }],
      'the first read of this list asks for the range it has not loaded')
    const first = assertReadable('the first read of a drawn list', read(), drawn, requests, [920])
    assert.deepEqual(first.gapAfterIds, [], 'the covered range closed the hole')
    assert.equal(first.nextBeforeId, 911, 'load older continues from the lowest loaded record')

    // One Load older press after that: now there is no range left named, so it
    // simply continues below the lowest loaded record.
    await run('notes', roomFilters)

    assert.deepEqual(requests.at(-1), { beforeId: 911, afterId: null, marker: '8' })
    const older = assertReadable('load older', read(), first, requests.slice(1), [920])
    assert.deepEqual(ids(older.rows),
      ids(rowsFrom(1_000, 140)).filter(id => id !== 920),
      'every record between the newest and the lowest loaded one is in the list')
    assert.equal(older.nextBeforeId, 861)
  })

  test('a hole below every record of a drawn list is no hole in that list', async () => {
    // This room's records all sit above the citywide hole, so its own oldest
    // record is above the range and reading older simply continues past it.
    const citywide = loadedEntry(
      [...rowsFrom(1_000, 50).map(inPlace(11)), ...rowsFrom(600, 10).map(inPlace(12))],
      { gapAfterIds: [600], beyondFillIds: [600] },
    )

    const drawn: HistoryEntry =
      drawnHistoryEntry({ notes: { all: citywide } }, roomSnapshot, 'notes', roomFilters)

    assert.deepEqual(drawn.gapAfterIds, [], 'nothing of this list sits below the hole')
    assert.deepEqual(drawn.beyondFillIds, [])
    assert.deepEqual(ids(drawn.rows), ids(rowsFrom(1_000, 50)))

    const requests: Request[] = []
    const { run, read } = olderHistoryPager(drawn, cityList({
      newestId: () => 1_000, placeId: 11, requests,
    }))

    // The first read of this list is its own newest page, because there is no
    // range to ask for; one Load older press after it simply continues below.
    await run('notes', roomFilters)
    await run('notes', roomFilters)

    assert.deepEqual(requests, [
      { beforeId: null, afterId: null, marker: '8' },
      { beforeId: 951, afterId: null, marker: '8' },
    ], 'with no range named the list reads its newest page and then older records')
    assert.equal(read().error, false)
    assert.deepEqual(read().gapAfterIds, [], 'no range was ever named for this list')
    assert.deepEqual(ids(read().rows), ids(rowsFrom(1_000, 100)),
      'every record between the newest and the lowest loaded one is in the list')
  })
}
