import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WINDOW_HISTORY_KEEP_ROWS,
} from '../../src/window-history-limits.ts'
import {
  COLLECTIONS,
  cityList,
  historyGapFiller,
  ids,
  loadedEntry,
  refreshedHistories,
  rowsFrom,
  snapshotOf,
  type Request,
} from './harness.ts'

// What a changed refresh keeps, what it drops, and which ranges it names.
export function registerRefreshRetentionTests(): void {
  test('a changed refresh keeps every older page the reader loaded in every list it pages', () => {
    // Three loaded pages per list; the newest page still reaches the reader's own
    // top row, so nothing sits between them.
    const loaded = rowsFrom(400, 120)
    const previous = Object.fromEntries(COLLECTIONS.map(collection =>
      [collection, { all: loadedEntry(loaded) }]))
    const fresh = [{ id: 401 }, ...rowsFrom(400, 49)]
    const snapshot = snapshotOf(Object.fromEntries(
      COLLECTIONS.map(collection => [collection, fresh])))

    const histories = refreshedHistories(previous, snapshot)

    for (const collection of COLLECTIONS) {
      const entry = histories[collection]!.all!
      assert.deepEqual(ids(entry.rows), [401, ...ids(loaded)],
        `${collection} keeps every loaded row and the newly arrived one`)
      assert.deepEqual(entry.gapAfterIds, [],
        `${collection} newest page reaching the kept rows leaves no gap`)
      assert.equal(entry.nextBeforeId, 281,
        `${collection} load older continues from the lowest loaded row`)
      assert.equal(entry.hasMore, true)
    }
  })

  test('a changed refresh keeps a filtered list it paged as well as the unfiltered one', () => {
    const loaded = rowsFrom(400, 60).map(row => ({ ...row, place_id: 11 }))
    const previous = {
      notes: {
        all: loadedEntry(loaded),
        'place:11|resident:': loadedEntry(loaded, { filters: { placeId: 11 } }),
      },
      things: {}, agreements: {}, events: {},
    }
    const fresh = [{ id: 401, place_id: 11 }, ...rowsFrom(400, 49).map(row => ({ ...row, place_id: 11 }))]

    const histories = refreshedHistories(previous, snapshotOf({ notes: fresh }))

    assert.deepEqual(ids(histories.notes!['place:11|resident:']!.rows), [401, ...ids(loaded)],
      'the filtered list keeps its own loaded pages')
    assert.equal(histories.notes!['place:11|resident:']!.nextBeforeId, 341)
    assert.deepEqual(histories.notes!['place:11|resident:']!.gapAfterIds, [])
  })

  test('a changed refresh that outruns the newest page names the gap above the kept rows', () => {
    const loaded = rowsFrom(400, 120)
    const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }
    // Every row of the newest page is new, so nothing proves the two ends join.
    const fresh = rowsFrom(500, 50)

    const entry = refreshedHistories(previous, snapshotOf({ notes: fresh })).notes!.all!

    assert.deepEqual(entry.gapAfterIds, [400],
      'the top of the kept block names the range the fill must read')
    assert.equal(entry.nextBeforeId, 281, 'load older still continues from the lowest loaded row')
    assert.equal(entry.hasMore, true)
    assert.ok(ids(entry.rows).includes(281), 'the kept rows are still in the list')
    assert.ok(ids(entry.rows).includes(451), 'the newest page is in the list too')
  })

  test('the keep bound trims the oldest rows first', () => {
    const loaded = rowsFrom(5_000, WINDOW_HISTORY_KEEP_ROWS + 200)
    const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }

    const fresh = [{ id: 5_001 }, ...rowsFrom(5_000, 49)]

    const entry = refreshedHistories(previous, snapshotOf({ notes: fresh })).notes!.all!

    assert.equal(entry.rows.length, WINDOW_HISTORY_KEEP_ROWS)
    assert.equal(entry.rows[0]!.id, 5_001, 'the newest row is kept')
    assert.equal(entry.rows.at(-1)!.id, 5_002 - WINDOW_HISTORY_KEEP_ROWS,
      'the oldest rows are the ones dropped')
    assert.deepEqual(entry.gapAfterIds, [], 'trimming the bottom leaves no hole inside the list')
    assert.equal(entry.hasMore, true, 'a trimmed list still offers its older records')
    assert.equal(entry.nextBeforeId, 5_002 - WINDOW_HISTORY_KEEP_ROWS)
  })

  test('the keep bound never trims a record the reader is holding open', () => {
    const loaded = rowsFrom(5_000, WINDOW_HISTORY_KEEP_ROWS + 200)
    const oldestId = loaded.at(-1)!.id
    const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }

    const fresh = [{ id: 5_001 }, ...rowsFrom(5_000, 49)]

    const entry = refreshedHistories(previous, snapshotOf({ notes: fresh }),
      { heldKeys: [`note:${oldestId}`] }).notes!.all!

    assert.equal(entry.rows.length, WINDOW_HISTORY_KEEP_ROWS + 1)
    assert.equal(entry.rows.at(-1)!.id, oldestId, 'the held row survives the trim')
    // The trim left a hole above that row, so the row is named rather than joined
    // to the rows above it in silence.
    assert.deepEqual(entry.gapAfterIds, [oldestId],
      'the held row below the keep bound names the range above it')
  })

  test('the keep bound names every hole it leaves, not only the first', () => {
    // Two held records at different depths below the bound leave two holes, and
    // the records between them are unloaded, so both are named.
    const loaded = rowsFrom(50_000, 3_500)
    const heldIds = [46_900, 46_600]
    const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }

    const fresh = [{ id: 50_001 }, ...rowsFrom(50_000, 49)]

    const entry = refreshedHistories(previous, snapshotOf({ notes: fresh }),
      { heldKeys: heldIds.map(id => `note:${id}`) }).notes!.all!

    assert.equal(entry.rows.length, WINDOW_HISTORY_KEEP_ROWS + heldIds.length,
      'both held rows survive the trim')
    assert.deepEqual(entry.gapAfterIds, heldIds,
      'each held row below the bound names the range above it')
    assert.equal(entry.hasMore, true)
  })

  test('a refresh whose changes read failed keeps no older rows', () => {
    const loaded = rowsFrom(400, 120)
    const previous = {
      notes: { all: loadedEntry(loaded), 'place:11|resident:': loadedEntry(loaded) },
      things: {}, agreements: {}, events: {},
    }
    const fresh = [{ id: 401 }, ...rowsFrom(400, 49)]

    // A changes read the window could not complete cannot name a moderated or
    // removed older record, so the refresh shows the city's own newest page.
    const histories = refreshedHistories(previous, snapshotOf({ notes: fresh }),
      { changes: null })

    assert.deepEqual(ids(histories.notes!.all!.rows), ids(fresh))
    assert.deepEqual(histories.notes!.all!.gapAfterIds, [])
    assert.deepEqual(Object.keys(histories.notes!), ['all'],
      'a filtered list the reader paged is not kept either')
  })

  test('a list the city says is empty keeps nothing and names no gap', () => {
    // An empty newest page can mean a quiet filtered list or an empty city. The
    // city's own total for this list is what tells the two apart.
    const previous = {
      things: { all: loadedEntry(rowsFrom(400, 60)) }, notes: {}, agreements: {}, events: {},
    }

    const entry = refreshedHistories(previous, snapshotOf({ things: [] }, { things: 0 }))
      .things!.all!

    assert.deepEqual(entry.rows, [], 'a record the city no longer has is not kept')
    assert.deepEqual(entry.gapAfterIds, [], 'an empty list has no range worth naming')
  })

  test('a moderated row leaves the rows and names the range that answers for it', () => {
    // The public change log says a record was moderated, never whether it was
    // taken down or put back. The window cannot answer that on the reader's
    // behalf, so it stops showing the text it knows is old and names the range
    // the city itself answers for.
    const loaded = rowsFrom(400, 60)
    const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }

    const entry = refreshedHistories(previous, snapshotOf({ notes: rowsFrom(400, 50) }), {
      changes: [{ kind: 'moderation', detail: { target_type: 'note', target_id: 345 } }],
    }).notes!.all!

    assert.equal(ids(entry.rows).includes(345), false, 'the old text is not shown again')
    assert.equal(ids(entry.rows).includes(344), true)
    assert.deepEqual(entry.gapAfterIds, [344],
      'the record still below it names the range the read answers')
  })

  test('a changed agreement comes back with fresh text instead of vanishing', async () => {
    // Round two of this change: somebody signs an agreement the reader loaded
    // below the newest page. Dropping it left the list short of one record until
    // a full page reload, which the window notice promises it is not.
    const loaded = rowsFrom(400, 60)
    const previous = {
      agreements: { all: loadedEntry(loaded) }, notes: {}, things: {}, events: {},
    }

    const entry = refreshedHistories(previous, snapshotOf({ agreements: rowsFrom(400, 50) }), {
      changes: [{ kind: 'agreement_sign', detail: { agreement_id: 345 } }],
    }).agreements!.all!

    assert.deepEqual(entry.gapAfterIds, [344], 'the signed agreement is named, not dropped')
    assert.equal(entry.hasMore, true)
    assert.equal(entry.nextBeforeId, 341, 'load older still continues from the lowest row')

    // And the fill the same refresh runs reads exactly that record back.
    const requests: Request[] = []
    const rejoin = historyGapFiller(cityList({ newestId: () => 401, requests }))
    const filled = (await rejoin({ agreements: { all: entry } },
      '8', new AbortController().signal)).agreements!.all!

    assert.deepEqual(requests, [{ beforeId: 346, afterId: 344, marker: '8' }],
      'the fill asks the city for exactly the record that changed')
    assert.equal(ids(filled.rows).includes(345), true, 'the agreement is back in the list')
    assert.deepEqual(ids(filled.rows), ids(loaded), 'and nothing else moved')
    assert.deepEqual(filled.gapAfterIds, [], 'the answered range closed')
  })

  test('an edited thing comes back with fresh text instead of vanishing', async () => {
    const loaded = rowsFrom(400, 60)
    const previous = { things: { all: loadedEntry(loaded) }, notes: {}, agreements: {}, events: {} }

    const entry = refreshedHistories(previous, snapshotOf({ things: rowsFrom(400, 50) }), {
      changes: [{ kind: 'thing_edited', detail: { thing_id: 345 } }],
    }).things!.all!

    assert.deepEqual(entry.gapAfterIds, [344], 'the edited thing is named, not dropped')

    const rejoin = historyGapFiller(cityList({ newestId: () => 401 }))
    const filled = (await rejoin({ things: { all: entry } },
      '8', new AbortController().signal)).things!.all!

    assert.deepEqual(ids(filled.rows), ids(loaded), 'the list is whole again')
    assert.deepEqual(filled.gapAfterIds, [])
  })

  test('a withdrawn thing is dropped outright, because the city no longer has it', () => {
    // Withdrawal is the one change that says the record is gone, so no range is
    // named and no read is spent asking for it.
    const loaded = rowsFrom(400, 60)
    const previous = { things: { all: loadedEntry(loaded) }, notes: {}, agreements: {}, events: {} }

    const entry = refreshedHistories(previous, snapshotOf({ things: rowsFrom(400, 50) }), {
      changes: [{ kind: 'thing_withdrawn', detail: { thing_id: 345 } }],
    }).things!.all!

    assert.equal(ids(entry.rows).includes(345), false)
    assert.deepEqual(entry.gapAfterIds, [], 'a record the city no longer has is not a range')
  })

  test('a changed record below every kept row is still offered by load older', () => {
    const loaded = rowsFrom(400, 60)
    const previous = {
      agreements: { all: loadedEntry(loaded, { hasMore: false, nextBeforeId: null }) },
      notes: {}, things: {}, events: {},
    }

    const entry = refreshedHistories(previous, snapshotOf({ agreements: rowsFrom(400, 50) }), {
      changes: [{ kind: 'agreement_sign', detail: { agreement_id: 341 } }],
    }).agreements!.all!

    assert.equal(ids(entry.rows).includes(341), false)
    assert.deepEqual(entry.gapAfterIds, [], 'nothing of this list is below it to name the range')
    assert.equal(entry.hasMore, true, 'so reading older is what brings it back')
    assert.equal(entry.nextBeforeId, 342)
  })

  test('a place the bounded outline does not carry keeps the pages the reader loaded', () => {
    // A place chosen from the complete directory is deliberately outside the
    // bounded outline, so the outline's count for it is zero only because the
    // window never loaded it. That is not the city saying the room is empty.
    const loaded = rowsFrom(400, 60).map(row => ({ ...row, place_id: 77 }))
    const previous = {
      notes: { 'place:77|resident:': loadedEntry(loaded, { filters: { placeId: 77 } }) },
      things: {}, agreements: {}, events: {},
    }

    const entry = refreshedHistories(previous,
      snapshotOf({ notes: [] }, {}, [{ id: 1, notes: 40, things: 0 }]))
      .notes!['place:77|resident:']!

    assert.deepEqual(ids(entry.rows), ids(loaded), 'every page the reader loaded is still here')
    assert.equal(entry.hasMore, true)
  })

  test('a place the outline does carry, and says is empty, keeps nothing', () => {
    // The same gate, on a count the window really holds: here it fires.
    const loaded = rowsFrom(400, 60).map(row => ({ ...row, place_id: 77 }))
    const previous = {
      notes: { 'place:77|resident:': loadedEntry(loaded, { filters: { placeId: 77 } }) },
      things: {}, agreements: {}, events: {},
    }

    const entry = refreshedHistories(previous,
      snapshotOf({ notes: [] }, {}, [{ id: 77, notes: 0, things: 0 }]))
      .notes!['place:77|resident:']!

    assert.deepEqual(entry.rows, [], 'a room the city counts as empty keeps nothing')
    assert.deepEqual(entry.gapAfterIds, [])
  })

  test('a moderated gap marker hands its name to the record below it', () => {
    // The reader loaded a newer block and, below a gap, a deeper block whose top
    // row names the gap. The city then takes that very row down.
    const loaded = [...rowsFrom(400, 50), ...rowsFrom(200, 10)]
    const previous = {
      notes: { all: loadedEntry(loaded, { gapAfterIds: [200] }) },
      things: {}, agreements: {}, events: {},
    }
    const fresh = [{ id: 401 }, ...rowsFrom(400, 49)]

    const entry = refreshedHistories(previous, snapshotOf({ notes: fresh }), {
      changes: [{ kind: 'moderation', detail: { target_type: 'note', target_id: 200 } }],
    }).notes!.all!

    assert.equal(ids(entry.rows).includes(200), false, 'the moderated row leaves the list')
    assert.deepEqual(entry.gapAfterIds, [199],
      'the highest record still below the gap takes the marker place')
    assert.equal(ids(entry.rows).includes(191), true, 'the rows below the gap stay loaded')
  })

  test('a record the newest page no longer carries is dropped, not kept for ever', () => {
    const loaded = rowsFrom(400, 60)
    const previous = { notes: { all: loadedEntry(loaded) }, things: {}, agreements: {}, events: {} }
    // The newest page is the city's own newest block. Note 380 sits inside it and
    // is gone from it, so it is gone from the city, not merely paged out of sight.
    const fresh = rowsFrom(400, 50).filter(row => row.id !== 380)

    const entry = refreshedHistories(previous, snapshotOf({ notes: fresh })).notes!.all!

    assert.equal(ids(entry.rows).includes(380), false)
    assert.equal(ids(entry.rows).includes(341), true, 'rows below the newest page still stay')
    assert.deepEqual(entry.gapAfterIds, [], 'a removed row is not a gap')
  })
}
