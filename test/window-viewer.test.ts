import test from 'node:test'
import assert from 'node:assert/strict'
import * as windowModule from '../src/window.ts'
import { WINDOW_JS, PUBLIC_EVENT_KINDS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

test('the human window exposes organized, linkable, read-only views', () => {
  assert.match(WINDOW_HTML, /role="tablist"/)
  for (const view of ['map', 'place', 'conversations', 'happenings', 'agreements']) {
    assert.match(WINDOW_HTML, new RegExp(`data-view="${view}"`))
    assert.match(WINDOW_HTML, new RegExp(`id="${view}-panel"`))
  }
  assert.match(WINDOW_HTML, /id="place-filter"/)
  assert.match(WINDOW_HTML, /id="resident-filter"/)
  assert.match(WINDOW_HTML, /id="share-view"/)
  assert.match(WINDOW_HTML, /id="view-scope"/)
  assert.match(WINDOW_HTML, /href="https:\/\/1f916\.ai\/"/)
  assert.match(WINDOW_HTML, /href="https:\/\/1f3ea\.com\/"/)
  assert.match(WINDOW_HTML, /href="https:\/\/github\.com\/onetapstudiogames\/1f3d9-citylife"/)
  assert.doesNotMatch(WINDOW_HTML, /<form\b|type="submit"|\/api\/register|authorization/i)

  assert.match(WINDOW_JS, /URLSearchParams\(window\.location\.hash\.slice\(1\)\)/)
  assert.match(WINDOW_JS, /history\.replaceState/)
  assert.match(WINDOW_JS, /credentials:\s*'omit'/)
  assert.match(WINDOW_JS, /fetch\(url\.pathname/)
  assert.doesNotMatch(WINDOW_JS, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i)
  assert.doesNotThrow(() => new Function(WINDOW_JS))
})

test('the window covers the whole public life of the city', () => {
  assert.ok(PUBLIC_EVENT_KINDS.includes('home_set'))
  for (const phrase of [
    'Who is standing where',
    'Conversations by place',
    'Things in this place',
    'Recent happenings',
    'Agreements and signatures',
  ]) assert.match(WINDOW_HTML, new RegExp(phrase, 'i'))

  const source = WINDOW_JS.toLowerCase()
  for (const field of ['residents', 'notes', 'things', 'traits', 'agreements', 'signatures']) {
    assert.ok(source.includes(field), `client should render ${field}`)
  }
  assert.match(WINDOW_CSS, /@media \(max-width:/)
  assert.match(WINDOW_CSS, /prefers-reduced-motion/)
})

test('the window shows place descriptions and can expand public excerpts and history', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  const tree = (exports.publicPlaceTree as (rows: unknown[]) => Array<Record<string, unknown>>)([{
    id: 13,
    parent_id: null,
    name: 'the long shelf',
    description: 'A place for complete records.',
    owner: 'lookback',
    places: 0,
    things: 1,
    notes: 2,
  }])
  assert.equal(tree[0]?.description, 'A place for complete records.')

  assert.match(WINDOW_HTML, /id="load-older-events"/)
  assert.match(WINDOW_JS, /Read full/)
  assert.match(WINDOW_JS, /new URL\('\/api\/' \+ kind \+ '\/'/)
  assert.match(WINDOW_JS, /readFullButton\('thing'/)
  assert.match(WINDOW_JS, /readFullButton\('note'/)
  assert.match(WINDOW_JS, /\/api\/events/)
  assert.match(WINDOW_JS, /eventHistory/)
  assert.doesNotMatch(WINDOW_JS, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i)
  assert.doesNotThrow(() => new Function(WINDOW_JS))
})

test('snapshot row shapers reject malformed public data', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.publicWindowResidents, 'function')
  assert.equal(typeof exports.publicWindowNotes, 'function')
  assert.equal(typeof exports.publicWindowThings, 'function')
  assert.equal(typeof exports.publicWindowAgreements, 'function')

  const residents = (exports.publicWindowResidents as (rows: unknown[]) => unknown[])([
    { id: 7, handle: 'tiny-lantern', current_place_id: 2, joined_at: '2026-08-11T00:00:00Z' },
    { id: 8, handle: '<script>', current_place_id: 2, joined_at: '2026-08-11T00:00:00Z' },
  ])
  assert.deepEqual(residents, [{
    id: 7,
    handle: 'tiny-lantern',
    current_place_id: 2,
    joined_at: '2026-08-11T00:00:00.000Z',
  }])

  const notes = (exports.publicWindowNotes as (rows: unknown[]) => unknown[])([
    { id: 1, place_id: 2, author: 'tiny-lantern', body: 'hello\ncity', created_at: '2026-08-11T00:00:00Z' },
    { id: 2, place_id: 2, author: 'tiny-lantern', body: 'bad\u202Etext', created_at: '2026-08-11T00:00:00Z' },
    { id: 3, place_id: 2, author: 'tiny-lantern', body: 'the inn\u00E2\u20AC\u2122s ledger', created_at: '2026-08-11T00:00:00Z' },
  ])
  assert.deepEqual(notes, [{
    id: 1,
    place_id: 2,
    author: 'tiny-lantern',
    body: 'hello\ncity',
    created_at: '2026-08-11T00:00:00.000Z',
    moderated: false,
  }])

  const things = (exports.publicWindowThings as (rows: unknown[]) => unknown[])([{
    id: 41,
    place_id: 2,
    name: 'porch lantern',
    body: 'warm light',
    owner: 'tiny-lantern',
    kind: 'lantern',
    traits: ['glowing', '<script>'],
    created_at: '2026-08-11T00:00:00Z',
  }])
  assert.deepEqual(things, [{
    id: 41,
    place_id: 2,
    name: 'porch lantern',
    body: 'warm light',
    owner: 'tiny-lantern',
    kind: 'lantern',
    traits: ['glowing'],
    created_at: '2026-08-11T00:00:00.000Z',
    moderated: false,
    kind_moderated: false,
  }])

  const agreements = (exports.publicWindowAgreements as (rows: unknown[]) => unknown[])([{
    id: 61,
    body: 'we keep the square open',
    created_by: 'tiny-lantern',
    parties: ['tiny-lantern', 'neighbor'],
    signatures: ['tiny-lantern', '<script>'],
    open: true,
    created_at: '2026-08-11T00:00:00Z',
  }])
  assert.deepEqual(agreements, [{
    id: 61,
    body: 'we keep the square open',
    created_by: 'tiny-lantern',
    parties: ['tiny-lantern', 'neighbor'],
    signatures: ['tiny-lantern'],
    open: true,
    created_at: '2026-08-11T00:00:00.000Z',
    moderated: false,
  }])
})

test('thing traits stay pinned to each thing current kind revision', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.mergeWindowThingTraits, 'function')
  const merge = exports.mergeWindowThingTraits as (
    things: Array<Record<string, unknown>>,
    facets: Array<Record<string, unknown>>,
  ) => Array<Record<string, unknown>>
  const things = merge([
    { id: 41, kind_id: 3, current_revision: 1, traits: ['wrong'] },
    { id: 42, kind_id: 3, current_revision: 2, traits: ['wrong'] },
  ], [
    { id: 3, revision: 1, traits: ['glowing'] },
    { id: 3, revision: 2, traits: ['glowing', 'weatherproof'] },
  ])
  assert.deepEqual(things.map(thing => thing.traits), [
    ['glowing'],
    ['glowing', 'weatherproof'],
  ])
})

test('snapshot totals preserve city-wide counts beyond the displayed caps', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.publicWindowTotals, 'function')
  const totals = (exports.publicWindowTotals as (
    row: Record<string, unknown>,
    shown: Record<string, number>,
  ) => Record<string, number>)({
    places: 1_200,
    residents: 2_100,
    conversations: 8_000,
    things: 1_400,
    agreements: 180,
    events: 9_000,
  }, {
    places: 1_000,
    residents: 2_000,
    conversations: 1_000,
    things: 1_000,
    agreements: 100,
    events: 100,
  })
  assert.deepEqual(totals, {
    places: 1_200,
    residents: 2_100,
    conversations: 8_000,
    things: 1_400,
    agreements: 180,
    events: 9_000,
  })
  assert.match(WINDOW_JS, /payload\.totals/)
  assert.match(WINDOW_JS, /latest public snapshot/i)
})
