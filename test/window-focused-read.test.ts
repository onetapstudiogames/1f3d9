import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FOCUSED_READ_OVERTAKEN_LIMIT,
  focusedReadOvertaken,
  overtakenReadIsDue,
} from '../src/window-client/focused-read.ts'
import { WINDOW_JS } from '../src/window-client.ts'

test('a focused read is overtaken when its reply is newer or the city view moved during the read', () => {
  // The live case: the first city view is an edge copy at 20 and the room read answers 21.
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: '21', viewMarker: '20' }), true)
  // A city refresh landed while the read was in flight.
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: '20', viewMarker: '21' }), true)
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: null, viewMarker: '21' }), true)
  // Markers compare as numbers, not text.
  assert.equal(focusedReadOvertaken({ requestMarker: '9', replyMarker: '10', viewMarker: '9' }), true)
  assert.equal(focusedReadOvertaken({
    requestMarker: '9223372036854775806',
    replyMarker: '9223372036854775807',
    viewMarker: '9223372036854775806',
  }), true)
  // Not overtaken: an exact reply, an older reply, no usable reply marker, or no marker asked.
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: '20', viewMarker: '20' }), false)
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: '19', viewMarker: '20' }), false)
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: null, viewMarker: '20' }), false)
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: '021', viewMarker: '20' }), false)
  assert.equal(focusedReadOvertaken({ requestMarker: null, replyMarker: '21', viewMarker: '20' }), false)
})

test('an overtaken read is read again only once the city view passes the marker it asked at', () => {
  assert.equal(overtakenReadIsDue({ entry: { loading: false, overtakenAt: '20' }, viewMarker: '21' }), true)
  assert.equal(overtakenReadIsDue({ entry: { loading: false, overtakenAt: '9' }, viewMarker: '10' }), true)
  assert.equal(overtakenReadIsDue({ entry: { loading: false, overtakenAt: '20' }, viewMarker: '20' }), false)
  assert.equal(overtakenReadIsDue({ entry: { loading: true, overtakenAt: '20' }, viewMarker: '21' }), false)
  assert.equal(overtakenReadIsDue({ entry: { loading: false, overtakenAt: null }, viewMarker: '21' }), false)
  assert.equal(overtakenReadIsDue({ entry: { loading: false }, viewMarker: '21' }), false)
  assert.equal(overtakenReadIsDue({ entry: undefined, viewMarker: '21' }), false)
  assert.equal(overtakenReadIsDue({ entry: null, viewMarker: '21' }), false)
  assert.equal(overtakenReadIsDue({ entry: { loading: false, overtakenAt: '20' }, viewMarker: null }), false)
})

test('the browser program carries both rules and the limit', () => {
  assert.equal(FOCUSED_READ_OVERTAKEN_LIMIT, 3)
  assert.ok(WINDOW_JS.includes('const focusedReadOvertaken = '), 'the overtaken rule is injected')
  assert.ok(WINDOW_JS.includes('const overtakenReadIsDue = '), 'the due rule is injected')
  assert.match(WINDOW_JS, /const FOCUSED_READ_OVERTAKEN_LIMIT = 3\n/u)
})

test('the browser program reads an overtaken place again and never leaves it loading with nothing in flight', () => {
  assert.match(WINDOW_JS, /focusedReadOvertaken\(\{\s*requestMarker, replyMarker, viewMarker: state\.changeMarker,\s*\}\)/u)
  assert.match(WINDOW_JS, /overtakenReads > 0 && overtakenReads <= FOCUSED_READ_OVERTAKEN_LIMIT/u)
  assert.match(WINDOW_JS, /error: !overtakenWaiting && !retainedCovers,/u)
  assert.match(WINDOW_JS, /if \(overtakenWaiting\) void ensureFocusedSelection\(\)/u)
  assert.equal(
    WINDOW_JS.match(/if \(!entry \|\| overtakenDue \|\| \(forcePlace && Boolean\(entry\.place\)\)\) \{/gu)?.length,
    2,
    'both focused place paths read a due overtaken place again',
  )
  assert.doesNotMatch(WINDOW_JS, /if \(!entry \|\| \(forcePlace && Boolean\(entry\.place\)\)\)/u)
  assert.match(WINDOW_JS, /refreshing: false \}\s+settleOvertakenFocusedPlaces\(\)/u)
  // Residents keep their own rule: every forced refresh reads a focused resident again.
  assert.match(WINDOW_JS, /if \(!entry \|\| forceResident\) \{/u)
})
