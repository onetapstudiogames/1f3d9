import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveWindowDirectoryPlaces,
  listWindowDirectoryPlaces,
  searchWindowDirectory,
  windowDirectoryPlaceScopeIds,
  WINDOW_JS,
} from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

test('directory paths stay honest for broken or adversarial parent graphs', () => {
  const directory = deriveWindowDirectoryPlaces([
    { id: 1, parent_id: null, name: 'the_world' },
    { id: 2, parent_id: 1, name: 'garden' },
    { id: 3, parent_id: 99, name: 'orphan' },
    { id: 4, parent_id: 5, name: 'cycle_a' },
    { id: 5, parent_id: 4, name: 'cycle_b' },
    { id: 6, parent_id: null, name: 'first_duplicate' },
    { id: 6, parent_id: 1, name: 'second_duplicate' },
  ])

  assert.deepEqual(directory, [
    { id: 1, parent_id: null, name: 'the_world', path: 'the_world' },
    { id: 2, parent_id: 1, name: 'garden', path: 'the_world / garden' },
    { id: 3, parent_id: 99, name: 'orphan', path: 'orphan · Place #3' },
    { id: 4, parent_id: 5, name: 'cycle_a', path: 'cycle_a · Place #4' },
    { id: 5, parent_id: 4, name: 'cycle_b', path: 'cycle_b · Place #5' },
    { id: 6, parent_id: null, name: 'first_duplicate', path: 'first_duplicate · Place #6' },
  ])
})

test('directory path depth is capped without dropping the selected place name or id', () => {
  const rows = Array.from({ length: 35 }, (_, index) => ({
    id: index + 1,
    parent_id: index === 0 ? null : index,
    name: `room_${index + 1}`,
  }))

  const directory = deriveWindowDirectoryPlaces(rows)

  assert.equal(directory[31]?.path.split(' / ').length, 32)
  assert.equal(directory[32]?.path, 'room_33 · Place #33')
  assert.equal(directory[34]?.path, 'room_35 · Place #35')
})

test('place selector is a flat numbered hierarchy with one clickable continent row', () => {
  const options = listWindowDirectoryPlaces([
    { id: 1, parent_id: null, name: 'the world', path: 'the world' },
    { id: 2, parent_id: 1, name: 'the verge', path: 'the world / the verge' },
    { id: 3, parent_id: 2, name: 'lobby', path: 'the world / the verge / lobby' },
    { id: 4, parent_id: 3, name: 'coffee-shop', path: 'the world / the verge / lobby / coffee-shop' },
    { id: 5, parent_id: 1, name: 'the harbor', path: 'the world / the harbor' },
  ])

  assert.deepEqual(options, [
    { id: 1, depth: 0, label: 'the world · #1' },
    { id: 2, depth: 0, label: 'the verge · #2' },
    { id: 3, depth: 1, label: 'lobby · #3' },
    { id: 4, depth: 2, label: 'coffee-shop — in lobby · #4' },
    { id: 5, depth: 0, label: 'the harbor · #5' },
  ])
})

test('directory search returns its own place and resident results', () => {
  const places = deriveWindowDirectoryPlaces([
    { id: 1, parent_id: null, name: 'the world' },
    { id: 2, parent_id: 1, name: 'the verge' },
    { id: 3, parent_id: 2, name: 'lobby' },
    { id: 4, parent_id: 3, name: 'coffee-shop' },
    { id: 5, parent_id: 1, name: 'the harbor' },
  ])
  const residents = [
    { id: 9, handle: 'far-walker' },
    { id: 10, handle: 'coffee-keeper' },
  ]

  assert.deepEqual(searchWindowDirectory(places, residents, 'coffee'), [
    {
      kind: 'place', id: 4, value: '4', label: 'coffee-shop · #4',
      detail: 'the world / the verge / lobby / coffee-shop',
    },
    {
      kind: 'resident', id: 10, value: 'coffee-keeper', label: 'coffee-keeper · #10',
      detail: 'Resident',
    },
  ])
  assert.deepEqual(searchWindowDirectory(places, residents, 'THE VERGE').map(row => row.id), [2, 3, 4])
  assert.deepEqual(searchWindowDirectory(places, residents, '#5').map(row => row.id), [5])
  assert.deepEqual(searchWindowDirectory(places, residents, '#9'), [{
    kind: 'resident', id: 9, value: 'far-walker', label: 'far-walker · #9', detail: 'Resident',
  }])
  assert.deepEqual(searchWindowDirectory(places, residents, ''), [])
  assert.deepEqual(searchWindowDirectory(places, residents, 'nowhere'), [])
})

test('a watched place scope contains itself and every nested place', () => {
  const places = [
    { id: 1, parent_id: null, name: 'the world' },
    { id: 2, parent_id: 1, name: 'the verge' },
    { id: 3, parent_id: 2, name: 'lobby' },
    { id: 4, parent_id: 3, name: 'coffee-shop' },
    { id: 5, parent_id: 1, name: 'the harbor' },
    { id: 6, parent_id: 7, name: 'cycle-a' },
    { id: 7, parent_id: 6, name: 'cycle-b' },
  ]

  assert.deepEqual(windowDirectoryPlaceScopeIds(places, 2), [2, 3, 4])
  assert.deepEqual(windowDirectoryPlaceScopeIds(places, 3), [3, 4])
  assert.deepEqual(windowDirectoryPlaceScopeIds(places, 99), [99])
  assert.deepEqual(windowDirectoryPlaceScopeIds(places, 6), [6, 7])
})

test('place selector keeps malformed branches honest and duplicate names distinct', () => {
  const options = listWindowDirectoryPlaces(deriveWindowDirectoryPlaces([
    { id: 1, parent_id: null, name: 'the world' },
    { id: 2, parent_id: 1, name: 'same branch' },
    { id: 3, parent_id: 1, name: 'same branch' },
    { id: 4, parent_id: 99, name: 'orphan' },
    { id: 5, parent_id: 6, name: 'cycle-a' },
    { id: 6, parent_id: 5, name: 'cycle-b' },
  ]))

  assert.deepEqual(options, [
    { id: 1, depth: 0, label: 'the world · #1' },
    { id: 2, depth: 0, label: 'same branch · #2' },
    { id: 3, depth: 0, label: 'same branch · #3' },
    { id: 4, depth: 0, label: 'orphan · #4' },
    { id: 5, depth: 0, label: 'cycle-a · #5' },
    { id: 6, depth: 0, label: 'cycle-b · #6' },
  ])
})

test('the window distinguishes the complete directory from currently loaded contents', () => {
  assert.match(WINDOW_HTML, /id="directory-search"/)
  assert.match(WINDOW_HTML, /role="combobox"/)
  assert.match(WINDOW_HTML, /aria-controls="directory-search-results"/)
  assert.match(WINDOW_HTML, /id="directory-search-results"[^>]*role="listbox"/)
  assert.match(WINDOW_HTML, /type="search"/)
  assert.match(WINDOW_HTML, /Search places and residents/i)
  assert.match(WINDOW_HTML, />All places</)
  assert.match(WINDOW_HTML, />All residents</)
  assert.match(WINDOW_HTML, /id="directory-status"/)
  assert.match(WINDOW_HTML, /complete city directory/i)
  assert.match(WINDOW_HTML, /currently loaded/i)

  assert.match(WINDOW_JS, /searchParams\.set\('view', 'directory'\)/)
  assert.match(WINDOW_JS, /function loadFocusedPlace\(placeId, force\)/)
  assert.match(WINDOW_JS, /function loadFocusedResident\(handle, force\)/)
  assert.match(WINDOW_JS, /searchParams\.set\('handle', handle\)/)
  assert.match(WINDOW_JS, /Retry loading the complete directory/)
  assert.match(WINDOW_JS, /listWindowDirectoryPlaces/)
  assert.match(WINDOW_JS, /searchWindowDirectory/)
  assert.match(WINDOW_JS, /windowDirectoryPlaceScopeIds/)
  assert.doesNotMatch(WINDOW_JS, /createElement\('optgroup'\)/)
  assert.match(WINDOW_JS, /directory-search-option-/)
  assert.match(WINDOW_JS, /removeAttribute\('aria-activedescendant'\)/)
  assert.match(WINDOW_JS, /not currently loaded/)
})

test('directory search uses one quiet active cursor instead of a second hover highlight', () => {
  assert.doesNotMatch(WINDOW_CSS, /\.directory-search-option:hover/u)

  const activeRule = WINDOW_CSS.match(
    /\.directory-search-option\[aria-selected="true"\]\s*\{([^}]*)\}/u,
  )?.[1] ?? ''
  assert.match(activeRule, /background:\s*var\(--cursor-tint\)/u)
  assert.doesNotMatch(activeRule, /var\(--signal\)/u)
})
