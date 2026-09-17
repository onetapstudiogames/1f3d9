import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { renderCityFactTokens } from '../src/city-facts.ts'
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

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the two window history bounds are the owner chosen ones', () => {
  assert.equal(WINDOW_HISTORY_KEEP_ROWS, 3_000)
  assert.equal(WINDOW_HISTORY_FILL_ROWS, 300)
  assert.equal(WINDOW_HISTORY_KEEP_ROWS_TEXT, '3,000')
  assert.equal(WINDOW_HISTORY_FILL_ROWS_TEXT, '300')
})

test('every surface that states a window history bound prints it from the one module', () => {
  // The browser program takes the numbers themselves, so the code that keeps
  // and fills cannot drift from the text that promises it.
  assert.match(WINDOW_JS, new RegExp(
    `const WINDOW_HISTORY_KEEP_ROWS = ${WINDOW_HISTORY_KEEP_ROWS}\\b`, 'u'))
  assert.match(WINDOW_JS, new RegExp(
    `const WINDOW_HISTORY_FILL_ROWS = ${WINDOW_HISTORY_FILL_ROWS}\\b`, 'u'))

  const keep = WINDOW_HISTORY_KEEP_ROWS_TEXT
  const fill = WINDOW_HISTORY_FILL_ROWS_TEXT
  const reference = renderCityFactTokens(read('src/reference.txt'))
  for (const [surface, text] of [
    ['the window notice', WINDOW_HTML],
    ['the resident reference', reference],
    ['the generated resident reference', REFERENCE],
    ['the changelog', read('CHANGELOG.md')],
    ['the recorded decision', read('docs/DECISIONS.md')],
    ['the system design', read('docs/SYSTEM_DESIGN.md')],
  ] as const) {
    assert.ok(text.includes(keep), `${surface} states the keep bound`)
    assert.ok(text.includes(fill), `${surface} states the fill bound`)
  }

  // The refresh that cannot check the city is one sentence, written once.
  assert.ok(WINDOW_HTML.includes(WINDOW_HISTORY_UNCHECKED_REFRESH_TEXT))
  assert.ok(reference.includes(WINDOW_HISTORY_UNCHECKED_REFRESH_TEXT))
  assert.ok(REFERENCE.includes(WINDOW_HISTORY_UNCHECKED_REFRESH_TEXT))

  // Nothing types the numbers into served copy by hand.
  for (const path of ['src/reference.txt', 'src/window-page.ts']) {
    const source = read(path)
    assert.equal(source.includes('3,000'), false, `${path} types the keep bound by hand`)
    assert.equal(/\b300 older records\b/u.test(source) && !source.includes('${WINDOW_HISTORY_FILL_ROWS_TEXT}'),
      false, `${path} types the fill bound by hand`)
  }
})

test('the range read is stated where a caller reads before it is used', () => {
  const reference = renderCityFactTokens(read('src/reference.txt'))
  assert.match(reference, /A window history read takes before_id, after_id, or both\./u)
  assert.match(reference, /after_id must\s+be lower than before_id/u)
  assert.match(reference,
    /Withdrawn things are absent from a range[\s\S]{0,180}text replaced rather than missing\./u)
  assert.match(reference, /collection=notes\|things\|agreements&before_id=&after_id=/u)
  assert.match(reference, /\/api\/events\?kind=&actor=&place_id=&within_place_id=&before_id=&after_id=/u)
  assert.match(REFERENCE, /A window history read takes before_id, after_id, or both\./u)
})
