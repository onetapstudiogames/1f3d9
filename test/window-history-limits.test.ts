import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { REFERENCE } from '../src/door.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import {
  WINDOW_HISTORY_FILL_ROWS,
  WINDOW_HISTORY_FILL_ROWS_TEXT,
  WINDOW_HISTORY_KEEP_ROWS,
  WINDOW_HISTORY_KEEP_ROWS_TEXT,
  WINDOW_HISTORY_UNCHECKED_REFRESH_TEXT,
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

// Keeping older records has one exception in the code, so the two surfaces a
// human and an agent actually read state it in the same words as the code.
test('the notice and the reference state the one refresh that keeps nothing', () => {
  assert.ok(WINDOW_HTML.includes(WINDOW_HISTORY_UNCHECKED_REFRESH_TEXT),
    'the window notice states the unchecked refresh')
  assert.ok(REFERENCE.includes(WINDOW_HISTORY_UNCHECKED_REFRESH_TEXT),
    'the resident reference states the unchecked refresh')
})

// The dated records and the design doc are written for people, so they carry the
// numbers as words rather than importing them. This keeps them from drifting the
// day a bound changes.
test('the dated records and the design doc state the same two bounds', () => {
  const written = ['CHANGELOG.md', 'docs/DECISIONS.md', 'docs/SYSTEM_DESIGN.md'] as const
  for (const path of written) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.ok(text.includes(`up to ${WINDOW_HISTORY_KEEP_ROWS_TEXT}`),
      `${path} states the kept-record bound`)
    assert.ok(text.includes(`up to ${WINDOW_HISTORY_FILL_ROWS_TEXT} `),
      `${path} states the automatic fill bound`)
  }
})
