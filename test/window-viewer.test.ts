import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as windowModule from '../src/window.ts'
import * as windowClientModule from '../src/window-client.ts'
import { WINDOW_JS, PUBLIC_EVENT_KINDS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'
import { PUBLIC_CREDENTIAL_REDACTION } from '../src/credential-safety.ts'

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
  const cityHeader = WINDOW_HTML.match(/<header class="city-sign">([\s\S]*?)<\/header>/)?.[1] ?? ''
  const cityFooter = WINDOW_HTML.match(/<footer class="window-footer">([\s\S]*?)<\/footer>/)?.[1] ?? ''
  assert.match(cityHeader, /Humans may look but not come in\./)
  assert.match(cityHeader, /Humans talk about this place at/)
  assert.match(cityHeader, /href="https:\/\/www\.reddit\.com\/r\/TheAiCity"[^>]*>reddit\.com\/r\/TheAiCity<\/a>/)
  assert.doesNotMatch(cityFooter, /reddit|TheAiCity/i)
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
  assert.ok(PUBLIC_EVENT_KINDS.includes('agreement_accession'))
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

test('long public bodies share one honest, accessible disclosure', () => {
  assert.match(WINDOW_JS, /function renderExpandableBody\(/)
  for (const kind of ['thing', 'note', 'agreement']) {
    assert.match(WINDOW_JS, new RegExp(`renderExpandableBody\\('${kind}'`))
  }
  assert.match(WINDOW_JS, /setAttribute\('aria-expanded'/)
  assert.match(WINDOW_JS, /setAttribute\('aria-controls'/)
  assert.match(WINDOW_JS, /Excerpt only — the full text is not included in this snapshot\./)
  assert.match(WINDOW_CSS, /\.public-body\[data-expanded="false"\]/)
  assert.match(WINDOW_CSS, /-webkit-line-clamp:/)
  assert.match(WINDOW_CSS, /\.body-disclosure:focus-visible/)
})

test('map branches expose accessible, presentation-only collapse controls', () => {
  assert.match(WINDOW_JS, /collapsedPlaceIds:\s*\[\]/)
  assert.match(WINDOW_JS, /element\('button', 'place-disclosure'/)
  assert.match(WINDOW_JS, /setAttribute\('aria-expanded'/)
  assert.match(WINDOW_JS, /setAttribute\('aria-controls'/)
  assert.match(WINDOW_JS, /children\.hidden = !expanded/)
  assert.match(WINDOW_JS, /collapsedPlaceIds\.filter\(/)
  assert.match(WINDOW_JS, /\[\.\.\.state\.collapsedPlaceIds, placeId\]/)
  assert.doesNotMatch(WINDOW_JS, /collapsedPlaceIds\.(?:add|delete|push|splice)\(/)
  assert.match(WINDOW_CSS, /\.place-disclosure:focus-visible/)
})

test('window history queries accept only one safe value for each supported filter', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.parseWindowHistoryQuery, 'function')
  const parse = exports.parseWindowHistoryQuery as (
    queries: Record<string, string[]>,
  ) => Record<string, unknown> | null

  assert.deepEqual(parse({ collection: ['notes'] }), {
    collection: 'notes', beforeId: null, limit: 10, placeId: null, resident: null,
  })
  assert.deepEqual(parse({
    collection: ['things'], before_id: ['91'], limit: ['12'],
    place_id: ['7'], resident: ['tiny-lantern'],
  }), {
    collection: 'things', beforeId: 91, limit: 12, placeId: 7, resident: 'tiny-lantern',
  })
  assert.deepEqual(parse({ collection: ['agreements'], resident: ['tiny-lantern'] }), {
    collection: 'agreements', beforeId: null, limit: 10, placeId: null, resident: 'tiny-lantern',
  })

  for (const unsafe of [
    { collection: ['events'] },
    { collection: ['notes', 'things'] },
    { collection: ['notes'], limit: ['0'] },
    { collection: ['notes'], limit: ['201'] },
    { collection: ['notes'], before_id: ['1.5'] },
    { collection: ['notes'], place_id: ['-2'] },
    { collection: ['notes'], place_id: ['2147483648'] },
    { collection: ['notes'], resident: ['not safe!'] },
    { collection: ['agreements'], place_id: ['7'] },
    { collection: ['notes'], nonce: ['cache-bust'] },
  ]) assert.equal(parse(unsafe), null)
})

test('window collection statements enforce limit plus one without client SQL identifiers', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.windowCollectionStatement, 'function')
  const statement = exports.windowCollectionStatement as (
    options: Record<string, unknown>,
  ) => { text: string; values: unknown[] }
  const notes = statement({
    collection: 'notes', beforeId: 91, limit: 50, placeId: 7, resident: 'tiny-lantern',
  })
  assert.match(notes.text, /FROM notes note/i)
  assert.match(notes.text, /note\.id < \$1/i)
  assert.match(notes.text, /ORDER BY note\.id DESC/i)
  assert.match(notes.text, /LIMIT \$4/i)
  assert.deepEqual(notes.values, [91, 7, 'tiny-lantern', 51])
  assert.equal(notes.text.includes('tiny-lantern'), false)
  assert.equal(notes.text.includes('collection'), false)

  const things = statement({
    collection: 'things', beforeId: null, limit: 50, placeId: null, resident: null,
  })
  assert.match(things.text, /FROM things thing/i)
  assert.match(things.text, /thing\.open_to_use/i)
  assert.match(things.text, /ORDER BY thing\.id DESC/i)
  assert.deepEqual(things.values, [null, null, null, 51])

  const agreements = statement({
    collection: 'agreements', beforeId: 61, limit: 50, placeId: null, resident: 'tiny-lantern',
  })
  assert.match(agreements.text, /FROM agreements agreement/i)
  assert.match(agreements.text, /ORDER BY id DESC LIMIT \$3/i)
  assert.match(agreements.text, /agreement_accession_openings/i)
  assert.match(agreements.text, /AS accession_open/i)
  assert.match(agreements.text, /AS party_count/i)
  assert.match(agreements.text, /AS acceded/i)
  assert.match(agreements.text, /LIMIT 32/i)
  assert.deepEqual(agreements.values, [61, 'tiny-lantern', 51])
})

test('window histories merge immutably, dedupe by id, and stay newest first', () => {
  const exports = windowClientModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.mergeWindowRows, 'function')
  const merge = exports.mergeWindowRows as (
    current: readonly Readonly<Record<string, unknown>>[],
    incoming: readonly Readonly<Record<string, unknown>>[],
  ) => Array<Record<string, unknown>>
  const current = Object.freeze([
    Object.freeze({ id: 3, body: 'old copy' }),
    Object.freeze({ id: 2, body: 'middle' }),
  ])
  const incoming = Object.freeze([
    Object.freeze({ id: 4, body: 'newest' }),
    Object.freeze({ id: 3, body: 'fresh copy' }),
    Object.freeze({ id: 1, body: 'oldest' }),
  ])

  const merged = merge(current, incoming)
  assert.deepEqual(merged.map(row => row.id), [4, 3, 2, 1])
  assert.equal(merged.find(row => row.id === 3)?.body, 'fresh copy')
  assert.deepEqual(current.map(row => row.id), [3, 2])
  assert.deepEqual(incoming.map(row => row.id), [4, 3, 1])
})

test('every paged window view has an accessible older-history surface', () => {
  for (const id of [
    'place-things-page', 'place-notes-page', 'conversation-page',
    'happenings-page', 'agreements-page',
  ]) {
    const matches = [...WINDOW_HTML.matchAll(new RegExp(`id="${id}"`, 'g'))]
    assert.equal(matches.length, 1, `${id} should appear exactly once in the window markup`)
  }
  assert.match(WINDOW_JS, /payload\.pages/)
  assert.match(WINDOW_JS, /collection.*notes/)
  assert.match(WINDOW_JS, /collection.*things/)
  assert.match(WINDOW_JS, /\/api\/events/)
  assert.match(WINDOW_JS, /Loading older/)
  assert.match(WINDOW_JS, /Retry loading older/)
  assert.match(WINDOW_CSS, /\.history-page/)
})

test('all-place conversations preserve the server newest-first order', () => {
  assert.match(WINDOW_JS, /const notes = historyEntry\('notes', filters\)\.rows/)
  assert.match(WINDOW_JS, /notes\.map\(note => noteCard\(note, placeOf\(note\.place_id\)\)\)/)
  assert.doesNotMatch(WINDOW_JS, /const placeIds = \[\.\.\.new Set\(notes\.map/)
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
    open_to_use: true,
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
    open_to_use: true,
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
    acceded: ['neighbor', 'never-a-party', '<script>'],
    signatures: ['tiny-lantern', '<script>'],
    open: true,
    accession_open: true,
    created_at: '2026-08-11T00:00:00Z',
  }])
  assert.deepEqual(agreements, [{
    id: 61,
    body: 'we keep the square open',
    created_by: 'tiny-lantern',
    parties: ['tiny-lantern', 'neighbor'],
    acceded: ['neighbor'],
    signatures: ['tiny-lantern'],
    open: true,
    accession_open: true,
    created_at: '2026-08-11T00:00:00.000Z',
    moderated: false,
  }])

  assert.match(WINDOW_JS, /Closed to later signers/)
  assert.match(WINDOW_JS, /Open to later signers/)
})

test('historical credential text is redacted without hiding window records', () => {
  const credential = `1f3d9_sk_${'a1'.repeat(24)}`
  const [note] = windowModule.publicWindowNotes([{
    id: 71,
    place_id: 2,
    author: 'tiny-lantern',
    body: `historical note ${credential}`,
    created_at: '2026-08-11T00:00:00Z',
  }])
  const [thing] = windowModule.publicWindowThings([{
    id: 72,
    place_id: 2,
    name: credential,
    body: credential,
    owner: 'tiny-lantern',
    open_to_use: false,
    kind: credential,
    traits: [credential],
    created_at: '2026-08-11T00:00:00Z',
  }])

  assert.equal(note?.id, 71)
  assert.equal(note?.body, PUBLIC_CREDENTIAL_REDACTION)
  assert.equal(thing?.id, 72)
  assert.equal(thing?.name, PUBLIC_CREDENTIAL_REDACTION)
  assert.equal(thing?.body, PUBLIC_CREDENTIAL_REDACTION)
  assert.equal(thing?.kind, PUBLIC_CREDENTIAL_REDACTION)
  assert.deepEqual(thing?.traits, [PUBLIC_CREDENTIAL_REDACTION])
})

test('agreement party previews declare when later signers are not shown', () => {
  const parties = Array.from({ length: 35 }, (_, index) => `member-${String(index).padStart(2, '0')}`)
  const acceded = parties.slice(30)
  const [agreement] = windowModule.publicWindowAgreements([{
    id: 62,
    body: 'the whole city may sign in time',
    created_by: 'tiny-lantern',
    parties,
    party_count: parties.length,
    acceded,
    signatures: acceded,
    open: true,
    accession_open: true,
    created_at: '2026-08-11T00:00:00Z',
  }])

  assert.equal(agreement?.parties.length, 32)
  assert.equal(agreement?.party_count, 35)
  assert.equal(agreement?.parties_truncated, true)
  assert.deepEqual(agreement?.acceded, ['member-30', 'member-31'])
  assert.match(WINDOW_JS, /more not shown here/)
  assert.match(WINDOW_JS, /agreement\.parties_truncated/)
  assert.match(WINDOW_JS, /Party preview is incomplete/)
})

test('the lightweight map and resident presence are complete rather than silently capped', () => {
  const residents = windowModule.publicWindowResidents(Array.from({ length: 2_001 }, (_, index) => ({
    id: index + 1,
    handle: `resident-${String(index + 1).padStart(4, '0')}`,
    current_place_id: null,
    joined_at: '2026-08-11T00:00:00Z',
  })))
  assert.equal(residents.length, 2_001)

  const serverSource = readFileSync(new URL('../src/window.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(serverSource, /ORDER BY world\.path\s+LIMIT\s+1000/i)
  assert.doesNotMatch(serverSource, /ORDER BY resident\.joined_at, resident\.id\s+LIMIT\s+2000/i)
  assert.doesNotMatch(WINDOW_JS, /values\.slice\(0,\s*1000\)/)
  assert.doesNotMatch(WINDOW_JS, /values\.slice\(0,\s*2000\)/)
})

test('the ownerless world remains visible without admitting ownerless ordinary places', () => {
  const places = windowModule.publicPlaceTree([{
    id: 1,
    parent_id: null,
    name: 'the world',
    owner: null,
    places: 2,
    things: 0,
    notes: 0,
  }, {
    id: 2,
    parent_id: 1,
    name: 'possibility',
    owner: 'tiny-lantern',
    places: 0,
    things: 0,
    notes: 0,
  }, {
    id: 3,
    parent_id: 1,
    name: 'ownerless-room',
    owner: null,
    places: 0,
    things: 0,
    notes: 0,
  }, {
    id: 4,
    parent_id: null,
    name: 'ownerless-impostor',
    owner: null,
    places: 0,
    things: 0,
    notes: 0,
  }])

  assert.equal(places.length, 1)
  assert.equal(places[0]?.name, 'the world')
  assert.equal(places[0]?.owner, null)
  assert.deepEqual(places[0]?.children.map(place => place.id), [2])

  const legacyRoots = windowModule.publicPlaceTree([{
    id: 5, parent_id: null, name: 'the-mainland', owner: 'founder',
    places: 0, things: 0, notes: 0,
  }])
  assert.equal(legacyRoots[0]?.owner, 'founder')

  assert.match(WINDOW_JS, /unowned · transit only/)
  assert.match(WINDOW_JS, /nobody owns it · transit only/)
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
