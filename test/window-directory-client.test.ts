import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveWindowDirectoryPlaces,
  groupWindowDirectoryPlaces,
  WINDOW_JS,
} from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'

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

test('place selector groups branches and shortens deep labels', () => {
  const groups = groupWindowDirectoryPlaces([
    { id: 1, parent_id: null, name: 'the world', path: 'the world' },
    { id: 2, parent_id: 1, name: 'the verge', path: 'the world / the verge' },
    { id: 3, parent_id: 2, name: 'lobby', path: 'the world / the verge / lobby' },
    { id: 4, parent_id: 3, name: 'coffee-shop', path: 'the world / the verge / lobby / coffee-shop' },
    { id: 5, parent_id: 1, name: 'the harbor', path: 'the world / the harbor' },
  ])

  assert.deepEqual(groups, [
    {
      label: 'World root',
      options: [{ id: 1, label: 'the world · Place #1' }],
    },
    {
      label: 'the verge',
      options: [
        { id: 2, label: 'the verge · Place #2' },
        { id: 3, label: 'lobby · Place #3' },
        { id: 4, label: 'coffee-shop — in lobby · Place #4' },
      ],
    },
    {
      label: 'the harbor',
      options: [{ id: 5, label: 'the harbor · Place #5' }],
    },
  ])
})

test('place selector keeps malformed branches honest and duplicate names distinct', () => {
  const groups = groupWindowDirectoryPlaces(deriveWindowDirectoryPlaces([
    { id: 1, parent_id: null, name: 'the world' },
    { id: 2, parent_id: 1, name: 'same branch' },
    { id: 3, parent_id: 1, name: 'same branch' },
    { id: 4, parent_id: 99, name: 'orphan' },
    { id: 5, parent_id: 6, name: 'cycle-a' },
    { id: 6, parent_id: 5, name: 'cycle-b' },
  ]))

  assert.deepEqual(groups, [
    {
      label: 'World root',
      options: [{ id: 1, label: 'the world · Place #1' }],
    },
    {
      label: 'same branch',
      options: [
        { id: 2, label: 'same branch · Place #2' },
        { id: 3, label: 'same branch · Place #3' },
      ],
    },
    {
      label: 'Other places',
      options: [
        { id: 4, label: 'orphan · Place #4' },
        { id: 5, label: 'cycle-a · Place #5' },
        { id: 6, label: 'cycle-b · Place #6' },
      ],
    },
  ])
})

test('the window distinguishes the complete directory from currently loaded contents', () => {
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
  assert.match(WINDOW_JS, /groupWindowDirectoryPlaces/)
  assert.match(WINDOW_JS, /createElement\('optgroup'\)/)
  assert.match(WINDOW_JS, /Current selection/)
})
