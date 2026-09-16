import assert from 'node:assert/strict'
import test from 'node:test'
import { REFERENCE } from '../src/door.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import {
  WINDOW_HISTORY_FILL_ROWS,
  WINDOW_HISTORY_FILL_ROWS_TEXT,
  WINDOW_HISTORY_KEEP_ROWS,
  WINDOW_HISTORY_KEEP_ROWS_TEXT,
} from '../src/window-history-limits.ts'

test('the window program carries both kept-page bounds as the one source states them', () => {
  assert.ok(WINDOW_JS.includes(`const WINDOW_HISTORY_KEEP_ROWS = ${WINDOW_HISTORY_KEEP_ROWS}`))
  assert.ok(WINDOW_JS.includes(`const WINDOW_HISTORY_FILL_ROWS = ${WINDOW_HISTORY_FILL_ROWS}`))
  assert.ok(
    WINDOW_JS.includes(`const WINDOW_HISTORY_FILL_ROWS_TEXT = ${JSON.stringify(WINDOW_HISTORY_FILL_ROWS_TEXT)}`),
  )
  // The seam a reader sees names the fill bound rather than restating it.
  assert.match(WINDOW_JS, /closes a gap of up to ' \+ WINDOW_HISTORY_FILL_ROWS_TEXT/u)
  assert.doesNotMatch(
    WINDOW_JS,
    new RegExp(`closes a gap of up to ${WINDOW_HISTORY_FILL_ROWS_TEXT}`, 'u'),
  )
})

test('the window notice states both bounds it actually keeps', () => {
  assert.ok(WINDOW_HTML.includes(`up to ${WINDOW_HISTORY_KEEP_ROWS_TEXT} records`),
    'the notice states the kept-record bound')
  assert.ok(WINDOW_HTML.includes(`up to ${WINDOW_HISTORY_FILL_ROWS_TEXT} older records on its own`),
    'the notice states the automatic fill bound')
  assert.match(WINDOW_HTML, /never one you are holding open/u)
})

test('the resident reference states the same two bounds', () => {
  assert.ok(REFERENCE.includes(`up to ${WINDOW_HISTORY_KEEP_ROWS_TEXT}`),
    'the reference states the kept-record bound')
  assert.ok(REFERENCE.includes(`up to ${WINDOW_HISTORY_FILL_ROWS_TEXT} older records on its own`),
    'the reference states the automatic fill bound')
  assert.match(REFERENCE, /Load older always\ncontinues from the lowest connected row/u)
  assert.doesNotMatch(REFERENCE, /\{\{WINDOW_HISTORY_BOUNDS\}\}/u)
})
