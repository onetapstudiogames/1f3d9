import assert from 'node:assert/strict'
import test from 'node:test'
import { staleFocusedPlaceStaysQuiet } from '../src/window-client/quiet.ts'
import { WINDOW_JS } from '../src/window-client.ts'

test('only the picked place keeps a stale read, and only while that read said quiet', () => {
  assert.equal(staleFocusedPlaceStaysQuiet({ placeId: 77, pickedPlaceId: 77, place: { quiet: true } }), true)
  assert.equal(staleFocusedPlaceStaysQuiet({ placeId: 77, pickedPlaceId: '77', place: { quiet: true } }), true)
  assert.equal(staleFocusedPlaceStaysQuiet({ placeId: 77, pickedPlaceId: 77, place: { quiet: false } }), false)
  assert.equal(staleFocusedPlaceStaysQuiet({ placeId: 77, pickedPlaceId: 77, place: {} }), false)
  assert.equal(staleFocusedPlaceStaysQuiet({ placeId: 77, pickedPlaceId: 77, place: null }), false)
  assert.equal(staleFocusedPlaceStaysQuiet({ placeId: 77, pickedPlaceId: 78, place: { quiet: true } }), false)
  assert.equal(staleFocusedPlaceStaysQuiet({ placeId: 77, pickedPlaceId: null, place: { quiet: true } }), false)
})

test('the browser program keeps the picked quiet place through a stale marker', () => {
  assert.ok(WINDOW_JS.includes('const staleFocusedPlaceStaysQuiet = '), 'the helper is injected')
  assert.match(
    WINDOW_JS,
    /if \(place && state\.changeMarker && !markerCovers\(entry\?\.marker, state\.changeMarker\) &&\s+!staleFocusedPlaceStaysQuiet\(\{ placeId, pickedPlaceId: state\.placeId, place \}\)\) return null/u,
  )
})
