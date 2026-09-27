import assert from 'node:assert/strict'
import test from 'node:test'
import { PUBLIC_CHANGE_PAGE_MAX, parsePublicChangeQuery } from '../src/public-changes.ts'
import { publicChangesPath } from '../src/window-client/changes.ts'
import { WINDOW_JS } from '../src/window-client.ts'

function queryOf(path: string): Record<string, string[]> {
  const url = new URL(path, 'https://city.test')
  assert.equal(url.pathname, '/api/changes')
  const query: Record<string, string[]> = {}
  for (const [key, value] of url.searchParams) (query[key] ??= []).push(value)
  return query
}

test('the window pages the change feed with since and the route maximum, which the route accepts', () => {
  assert.equal(
    publicChangesPath({ since: '42', limit: PUBLIC_CHANGE_PAGE_MAX }),
    '/api/changes?since=42&limit=' + PUBLIC_CHANGE_PAGE_MAX,
  )
  for (const since of ['0', '42', '9223372036854775807']) {
    const parsed = parsePublicChangeQuery(queryOf(publicChangesPath({ since, limit: PUBLIC_CHANGE_PAGE_MAX })))
    assert.equal(parsed.ok, true, JSON.stringify(parsed))
  }
})

test('the browser program asks the change feed nothing without a marker and pages at the route maximum', () => {
  assert.doesNotMatch(WINDOW_JS, /searchParams\.set\('limit', '200'\)/u)
  assert.doesNotMatch(WINDOW_JS, /new URL\('\/api\/changes'/u)
  assert.match(
    WINDOW_JS,
    /async function checkPublicChanges\(sinceMarker\) \{\s+(?:\/\/[^\n]*\n\s+)*if \(!\(sinceMarker \|\| state\.changeMarker\)\) \{\s+return Object\.freeze\(\{\s+status: 'unavailable', marker: null, changes: Object\.freeze\(\[\]\),\s+\}\)\s+\}\s+const controller = new AbortController\(\)/u,
    'no marker means no changes request',
  )
  assert.ok(WINDOW_JS.includes('const publicChangesPath = '), 'the helper is injected')
  assert.ok(WINDOW_JS.includes('const PUBLIC_CHANGE_PAGE_MAX = ' + PUBLIC_CHANGE_PAGE_MAX), 'the route maximum is injected')
  assert.ok(WINDOW_JS.includes('fetch(publicChangesPath({ since: cursor, limit: PUBLIC_CHANGE_PAGE_MAX })'))
  assert.match(
    WINDOW_JS,
    /function normalizePublicChanges\(values\) \{\s+if \(!Array\.isArray\(values\)\) return \[\]\s+return values\.slice\(0, PUBLIC_CHANGE_PAGE_MAX\)/u,
  )
})
