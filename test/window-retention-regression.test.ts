import assert from 'node:assert/strict'
import test from 'node:test'
import { PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES } from '../src/window-client/program/13-branch-cache-and-history-entries.ts'
import { mergeWindowRows } from '../src/window-client/rows.ts'
import { WINDOW_HISTORY_KEEP_ROWS } from '../src/window-history-limits.ts'

type Row = Readonly<{ id: number }>

function freshSnapshotSource(part: string): string {
  const start = part.indexOf('  function historyKey')
  const possibleEnds = [
    part.indexOf('  function filledHistoryEntry', start),
    part.indexOf('  async function rereadHeldHistoryEntry', start),
  ].filter(index => index > start)
  assert.notEqual(start, -1)
  assert.ok(possibleEnds.length > 0)
  return part.slice(start, Math.min(...possibleEnds))
}

export function refreshNotes(
  part: string,
  loaded: readonly Row[],
  newest: readonly Row[],
): readonly Row[] {
  const snapshot = {
    notes: newest, things: [], agreements: [], events: [],
    pages: {
      notes: { hasMore: true, nextBeforeId: newest.at(-1)?.id ?? null },
      things: { hasMore: false, nextBeforeId: null },
      agreements: { hasMore: false, nextBeforeId: null },
      events: { hasMore: false, nextBeforeId: null },
    },
    totals: { conversations: 10_000, things: 0, agreements: 0, events: 0 },
    flatPlaces: [],
  }
  const previous = {
    notes: { all: {
      rows: loaded, hasMore: true, nextBeforeId: loaded.at(-1)?.id ?? null,
      initialized: true,
    } },
    things: {}, agreements: {}, events: {},
  }
  return new Function(
    'previous', 'snapshot', 'mergeWindowRows', 'WINDOW_HISTORY_KEEP_ROWS',
    'viewerHeldRecordKeys', 'changedViewerRecordKeys', 'removedViewerRecordKeys',
    'placeScopeSet', 'eventPlaceId',
    `let state = { histories: previous, snapshot };
     ${freshSnapshotSource(part)}
     return freshSnapshotHistories(snapshot, []).notes.all.rows`,
  )(
    previous, snapshot, mergeWindowRows, WINDOW_HISTORY_KEEP_ROWS,
    () => new Set(), () => new Set(), () => new Set(),
    () => new Set(), () => null,
  ) as readonly Row[]
}

test('a changed refresh keeps ordinary loaded older rows, not only open ones', () => {
  const loaded = Array.from({ length: 100 }, (_, index) => ({ id: 200 - index }))
  const newest = Array.from({ length: 50 }, (_, index) => ({ id: 250 - index }))

  const refreshed = refreshNotes(PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES, loaded, newest)

  assert.ok(refreshed.some(row => row.id === 101), 'the oldest loaded row remains')
  assert.deepEqual(refreshed.slice(0, 3).map(row => row.id), [250, 249, 248])
})
