// The window's place rows (T17a): a thing card and a front matter heading keep the
// city's short status, ends, and show it as a few words beside the thing's other facts.
// Exercised through the shipped client source.
import assert from 'node:assert/strict'
import test from 'node:test'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_CLIENT_SAFETY_JS } from '../src/window-client-safety.ts'

const SAFE_HANDLE_LINE = /^ {2}const SAFE_HANDLE = .*$/mu.exec(WINDOW_JS)?.[0] ?? ''
const START = WINDOW_JS.indexOf('  function normalizeShortEnds(')
const END = WINDOW_JS.indexOf('  function normalizeAgreements(')

type Helpers = Readonly<{
  normalizeShortEnds: (value: unknown) => unknown
  shortEndsText: (ends: unknown) => string | null
  normalizeThings: (values: unknown) => Array<Record<string, unknown>>
  normalizeThingHeadings: (values: unknown) => Array<Record<string, unknown>>
}>

const helpers = new Function(SAFE_HANDLE_LINE + '\n' + WINDOW_CLIENT_SAFETY_JS + WINDOW_JS.slice(START, END) +
  '\nreturn { normalizeShortEnds, shortEndsText, normalizeThings, normalizeThingHeadings }')() as Helpers

const local = (iso: string) => new Date(iso).toLocaleString()

test('the client source this test slices is present', () => {
  assert.notEqual(SAFE_HANDLE_LINE, '')
  assert.ok(START > 0 && END > START)
  assert.ok(WINDOW_JS.includes("shortEndsText(thing.ends)"), 'a thing card shows its end')
  assert.ok(WINDOW_JS.includes("shortEndsText(heading.ends)"), 'a front matter heading shows its end')
  assert.ok(WINDOW_JS.includes('ends: normalizeShortEnds(rawHeading.ends)'), 'front matter keeps its end')
})

test('the short status reads as set, set with no time known, or ended', () => {
  const { normalizeShortEnds, shortEndsText } = helpers
  const set = normalizeShortEnds({ state: 'set', at: '2026-11-20T10:00:00.000Z' })
  assert.deepEqual(set, { state: 'set', at: '2026-11-20T10:00:00.000Z' })
  assert.equal(shortEndsText(set), 'ends on ' + local('2026-11-20T10:00:00.000Z'))
  assert.equal(shortEndsText(normalizeShortEnds({ state: 'set', at: null })), 'has an end set')
  assert.equal(shortEndsText(normalizeShortEnds({ state: 'ended', at: '2026-11-07T08:00:00.000Z' })),
    'ended on ' + local('2026-11-07T08:00:00.000Z'))
  for (const bad of [null, undefined, 'set', { state: 'gone', at: null }, { state: 'ended', at: null },
    { state: 'set', at: 'soon' }]) {
    assert.equal(normalizeShortEnds(bad), null, JSON.stringify(bad))
  }
  assert.equal(shortEndsText(null), null)
})

test('a thing card and a thing heading keep ends, and a row without one reads null', () => {
  const row = {
    id: 41, place_id: 2, name: 'counting lamp', body: 'warm', maker_id: 7, made_by: 'ending-maker',
    current_owner_id: 7, current_owner: 'ending-maker', owner: 'ending-maker',
    created_at: '2026-11-01T00:00:00.000Z',
  }
  const [card, plain] = helpers.normalizeThings([
    { ...row, ends: { state: 'ended', at: '2026-11-07T08:00:00.000Z' } },
    { ...row, id: 42 },
  ])
  assert.deepEqual(card?.ends, { state: 'ended', at: '2026-11-07T08:00:00.000Z' })
  assert.equal(plain?.ends, null)
  const { body: _body, ...headingRow } = row
  const [heading] = helpers.normalizeThingHeadings([
    { ...headingRow, body_text_bytes: 4, ends: { state: 'set', at: null } },
  ])
  assert.deepEqual(heading?.ends, { state: 'set', at: null })
})
