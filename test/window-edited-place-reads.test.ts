import assert from 'node:assert/strict'
import test from 'node:test'
import { EDITED_PLACE_READS_PER_REFRESH, placesToReadAtRefresh } from '../src/window-client/quiet.ts'
import { WINDOW_JS } from '../src/window-client.ts'

const edit = (placeId: unknown) => ({ kind: 'place_edited', detail: { place_id: placeId } })
const none = {
  complete: true, heldQuietIds: [], retryIds: [], loadedIds: [11, 12], selectedIds: [], limit: 10,
}

test('a refresh reads each room a place edit names, newest first, once', () => {
  assert.deepEqual(
    placesToReadAtRefresh({ ...none, changes: [edit(77), { kind: 'note', detail: { place_id: 78 } }, edit(79), edit(77)] }),
    { now: [77, 79], later: [] },
  )
})

test('a refresh leaves out loaded rooms and puts off selected rooms until they are not selected', () => {
  assert.deepEqual(
    placesToReadAtRefresh({ ...none, selectedIds: [79, 81], changes: [edit(11), edit(77), edit(79), edit(12), edit(81)] }),
    { now: [77], later: [79, 81] },
  )
  assert.deepEqual(
    placesToReadAtRefresh({ ...none, selectedIds: [79], retryIds: [81], changes: [] }),
    { now: [81], later: [] },
  )
})

test('only a safe place id on a place_edited change counts', () => {
  assert.deepEqual(
    placesToReadAtRefresh({
      ...none,
      changes: [edit('77'), edit(0), edit(-3), edit(1.5), edit(null), { kind: 'place_edited' }, { kind: 'place_edited', detail: null }],
    }),
    { now: [], later: [] },
  )
})

test('a room whose read failed or did not fit is read at the next refresh, after the edited rooms', () => {
  assert.deepEqual(
    placesToReadAtRefresh({ ...none, retryIds: [80, 77], changes: [edit(77)] }),
    { now: [77, 80], later: [] },
  )
})

test('when the changes are not known up to the new marker, every held quiet room is read as well', () => {
  assert.deepEqual(
    placesToReadAtRefresh({ ...none, complete: false, changes: [edit(79)], heldQuietIds: [77, 11, 81], retryIds: [80] }),
    { now: [79, 77, 81, 80], later: [] },
  )
  assert.deepEqual(
    placesToReadAtRefresh({ ...none, changes: [edit(79)], heldQuietIds: [77, 81] }),
    { now: [79], later: [] },
  )
})

test('a refresh reads at most ten rooms and leaves the rest for the next one', () => {
  assert.equal(EDITED_PLACE_READS_PER_REFRESH, 10)
  const changes = Array.from({ length: 12 }, (_, index) => edit(100 + index))
  assert.deepEqual(
    placesToReadAtRefresh({ ...none, changes, selectedIds: [105], limit: EDITED_PLACE_READS_PER_REFRESH }),
    { now: [100, 101, 102, 103, 104, 106, 107, 108, 109, 110], later: [111, 105] },
  )
})

test('the browser program reads edited rooms before it draws a refresh and keeps what they said', () => {
  assert.ok(WINDOW_JS.includes('const placesToReadAtRefresh = '), 'the helper is injected')
  assert.match(WINDOW_JS, /const EDITED_PLACE_READS_PER_REFRESH = 10\n/u)
  assert.match(
    WINDOW_JS,
    /const editedPlaces = hadSnapshot && replaceAuthored\s+\? await readEditedPlaces\(changeState, snapshot, refreshMarker, controller\.signal\)\s+: null/u,
  )
  assert.match(WINDOW_JS, /if \(editedPlaces\) editedPlaceRetryIds = editedPlaces\.retryIds\n/u)
  assert.match(
    WINDOW_JS,
    /focusedPlaces: editedPlaces \? \{ \.\.\.state\.focusedPlaces, \.\.\.editedPlaces\.entries \} : state\.focusedPlaces,/u,
  )
  const read = WINDOW_JS.indexOf('await readEditedPlaces(')
  const navigationCheck = WINDOW_JS.indexOf('if (navigationRevision !== navigationRevisionAtStart)', read)
  const retry = WINDOW_JS.indexOf('if (editedPlaces) editedPlaceRetryIds')
  const store = WINDOW_JS.indexOf('focusedPlaces: editedPlaces ?')
  assert.ok(read < navigationCheck && navigationCheck < retry && retry < store,
    'the reads finish before the navigation check, and the retry list and entries are kept only when the view is stored')
  assert.match(WINDOW_JS, /url\.searchParams\.set\('after_change_marker', marker\)/u)
  assert.match(
    WINDOW_JS,
    /const gap = known && !markerCovers\(known\.marker, marker\)\s+\? await checkPublicChanges\(known\.marker\)\s+: null/u,
  )
  assert.match(WINDOW_JS, /const staleDue = heldPlaceReadIsStale\(entry\)\n[^\n]*\n\s+await loadFocusedPlace\(explicitPlaceId, forcePlace \|\| overtakenDue \|\| staleDue\)/u)
  assert.match(WINDOW_JS, /const staleDue = heldPlaceReadIsStale\(entry\)\n[^\n]*\n\s+await loadFocusedPlace\(currentPlaceId, forcePlace \|\| overtakenDue \|\| staleDue\)/u)
})
