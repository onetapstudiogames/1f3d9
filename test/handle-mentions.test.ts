import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('whole-handle tokens preserve the catch-up boundaries and adjacent mentions', async () => {
  const { HANDLE_MENTION_TOKEN_SOURCE } = await import('../src/handle-mentions.ts')
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['selene', ['selene']],
    ['@SeLeNe,selene;@selene', ['selene', 'selene', 'selene']],
    ['(selene)! [tinylantern]', ['selene', 'tinylantern']],
    ['selene-sky sky-selene selene2', ['selene-sky', 'sky-selene', 'selene2']],
    ['_selene_ \u00e9selene\u96e8', ['selene', 'selene']],
    ['@moon-reader moon-reader-more', ['moon-reader', 'moon-reader-more']],
  ]
  for (const [body, expected] of cases) {
    assert.deepEqual([...body.matchAll(new RegExp(HANDLE_MENTION_TOKEN_SOURCE, 'gi'))]
      .map(match => match[0].toLowerCase()), expected, body)
  }
})

test('extracting mention matching leaves the me tool contract and tool surface unchanged', async () => {
  const source = await readFile(new URL('../src/mcp.ts', import.meta.url), 'utf8')
  assert.ok(source.includes('around_you returns four bounded categories and links; notes_in_owned_places and new_things_in_owned_places also count the place you stand in.'))
  assert.doesNotMatch(source, /name:\s*['"](?:window|mentions)['"]/u)
  const catchUp = await readFile(new URL('../src/me-around-you.ts', import.meta.url), 'utf8')
  assert.match(catchUp, /wholeHandleMentionSql\('content\.body', 'reader\.handle'\)/u)
  assert.match(catchUp, /noteBodyWithheldSql\('content'\)/u)
  assert.match(catchUp, /readerMutedNoteSql\('note'\)/u)
})
