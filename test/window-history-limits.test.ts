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

test('served and recorded window history facts print the two shared bounds', () => {
  assert.match(WINDOW_JS, new RegExp(
    `const WINDOW_HISTORY_KEEP_ROWS = ${WINDOW_HISTORY_KEEP_ROWS}\\b`, 'u'))
  assert.match(WINDOW_JS, new RegExp(
    `const WINDOW_HISTORY_FILL_ROWS = ${WINDOW_HISTORY_FILL_ROWS}\\b`, 'u'))

  const reference = renderCityFactTokens(read('src/reference.txt'))
  for (const [surface, text] of [
    ['the window notice', WINDOW_HTML],
    ['the resident reference', reference],
    ['the generated resident reference', REFERENCE],
    ['the changelog', read('CHANGELOG.md')],
    ['the recorded decision', read('docs/DECISIONS.md')],
    ['the system design', read('docs/SYSTEM_DESIGN.md')],
  ] as const) {
    assert.ok(text.includes(WINDOW_HISTORY_KEEP_ROWS_TEXT), `${surface} states the keep bound`)
    assert.ok(text.includes(WINDOW_HISTORY_FILL_ROWS_TEXT), `${surface} states the fill bound`)
  }

  assert.ok(WINDOW_HTML.includes(WINDOW_HISTORY_UNCHECKED_REFRESH_TEXT))
  assert.ok(reference.includes(WINDOW_HISTORY_UNCHECKED_REFRESH_TEXT))
  assert.ok(REFERENCE.includes(WINDOW_HISTORY_UNCHECKED_REFRESH_TEXT))

  for (const path of ['src/reference.txt', 'src/window-page.ts']) {
    const source = read(path)
    assert.equal(source.includes('3,000'), false, `${path} types the keep bound by hand`)
    assert.equal(/\b300 missing records\b/u.test(source) &&
      !source.includes('${WINDOW_HISTORY_FILL_ROWS_TEXT}'), false,
    `${path} types the fill bound by hand`)
  }
})

test('the reference states same-list retention and the privacy fallback', () => {
  const reference = renderCityFactTokens(read('src/reference.txt'))
  assert.match(reference, /Each filtered list\s+checks its own newest page/iu)
  assert.match(reference, /plus any extra records held open/iu)
  assert.match(reference, /One changed refresh reads up to\s+300 missing records in total/iu)
  assert.match(WINDOW_HTML, /One refresh reads up to 300 missing records in total/iu)
  assert.match(reference, /Changed, removed, moved, or moderated public text is never kept\s+as stale text/iu)
  assert.match(reference, /cannot check what the city changed keeps no older records/iu)
})
