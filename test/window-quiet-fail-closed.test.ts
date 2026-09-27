import assert from 'node:assert/strict'
import test from 'node:test'
import { staleFocusedPlaceStaysQuiet } from '../src/window-client/quiet.ts'
import { WINDOW_JS } from '../src/window-client.ts'

test('a stale read that said quiet holds for any room outside the loaded places, and only while it said quiet', () => {
  assert.equal(staleFocusedPlaceStaysQuiet({ place: { quiet: true }, inLoadedPlaces: true }), false)
  assert.equal(staleFocusedPlaceStaysQuiet({ place: { quiet: true }, inLoadedPlaces: false }), true)
  assert.equal(staleFocusedPlaceStaysQuiet({ place: { quiet: false }, inLoadedPlaces: false }), false)
  assert.equal(staleFocusedPlaceStaysQuiet({ place: {}, inLoadedPlaces: false }), false)
  assert.equal(staleFocusedPlaceStaysQuiet({ place: null, inLoadedPlaces: false }), false)
})

test('the browser program keeps a quiet room outside the loaded places through a stale marker', () => {
  assert.ok(WINDOW_JS.includes('const staleFocusedPlaceStaysQuiet = '), 'the helper is injected')
  assert.match(
    WINDOW_JS,
    /if \(place && state\.changeMarker && !markerCovers\(entry\?\.marker, state\.changeMarker\) &&\s+!staleFocusedPlaceStaysQuiet\(\{\s+place,\s+inLoadedPlaces: Boolean\(state\.snapshot\?\.flatPlaces\.some\(candidate => candidate\.id === placeId\)\),\s+\}\)\) return null/u,
  )
  assert.doesNotMatch(WINDOW_JS, /pickedPlaceId: state\.placeId, place \}/u)
})
