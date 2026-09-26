import assert from 'node:assert/strict'
import test from 'node:test'
import { WINDOW_JS } from '../src/window-client.ts'
import { WALK_TO_READ_WINDOW_LABEL } from '../src/walk-to-read.ts'
import { MODERATED_WINDOW_LABEL } from '../src/moderation.ts'

test('the two labels the founder promised in note 23132 are exact and reach the browser program', () => {
  assert.equal(WALK_TO_READ_WINDOW_LABEL, 'Walk to read, first line only')
  assert.equal(MODERATED_WINDOW_LABEL, 'Removed by the maintainer.')
  assert.ok(WINDOW_JS.includes(JSON.stringify(WALK_TO_READ_WINDOW_LABEL)))
  assert.ok(WINDOW_JS.includes(JSON.stringify(MODERATED_WINDOW_LABEL)))
})

test('a walk-to-read card, archive result, and detail put the label above the first line', () => {
  assert.match(WINDOW_JS, /function walkToReadNoteBlock\(note\) \{\s*const block = element\('div', 'walk-to-read-block'\)\s*block\.append\(element\('p', 'walk-to-read-label', WALK_TO_READ_WINDOW_LABEL\)\)/u)
  assert.match(WINDOW_JS, /function walkToReadDetailNode\(record\) \{[\s\S]{0,200}'walk-to-read-label', WALK_TO_READ_WINDOW_LABEL/u)
})

test('a removed note card shows the removed label and never its placeholder text or the tombstone words', () => {
  assert.match(WINDOW_JS, /if \(note\.moderated\) \{\s*card\.append\(meta, element\('p', 'removed-label', MODERATED_WINDOW_LABEL\)\)/u)
  assert.doesNotMatch(WINDOW_JS, /Removed text retained as a tombstone'\)\)\s*return viewerRecordNode\(card, 'note'/u)
})

test('a quiet note card names its room above the quiet sentence (owner, Q7)', () => {
  assert.match(WINDOW_JS, /function quietRoomName\(place, placeId\) \{/u)
  assert.match(WINDOW_JS, /element\('p', 'quiet-room-context', 'A note in ' \+ quietRoomName\(place, note\.place_id\) \+ '\.'\)/u)
})
