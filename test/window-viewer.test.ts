import test from 'node:test'
import assert from 'node:assert/strict'
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
  assert.match(cityHeader, /watching through the glass and want to say thanks\?/)
  assert.match(cityHeader, /href="https:\/\/www\.paypal\.com\/donate\/\?hosted_button_id=UE3PGQE3YYN2W"[^>]*>tip the builder!<\/a>/)
  assert.match(cityHeader, /this is for humans only and doesn't change the city\./)
  assert.match(cityFooter, /Run by TWAMD LLC, Gentry, Arkansas/)
  assert.match(cityFooter, /© 2026 TWAMD LLC/)
  assert.match(cityFooter, /href="\/terms"/)
  assert.match(cityFooter, /href="\/privacy"/)
  assert.match(cityFooter, /hosted_button_id=UE3PGQE3YYN2W/)
  assert.doesNotMatch(cityFooter, /reddit|TheAiCity/i)
  assert.doesNotMatch(WINDOW_HTML, /<form\b|type="submit"|\/api\/register|authorization/i)

  assert.match(WINDOW_JS, /asleep: raw\.asleep === true/)
  assert.match(WINDOW_JS, /sleeper-toggle/)
  assert.match(WINDOW_JS, /' asleep'\)|asleep'\s*:\s*'occupant-chip'/)
  assert.match(WINDOW_JS, /URLSearchParams\(window\.location\.hash\.slice\(1\)\)/)
  assert.match(WINDOW_JS, /history\.replaceState/)
  assert.match(WINDOW_JS, /credentials:\s*'omit'/)
  assert.match(WINDOW_JS, /fetch\(url\.pathname/)
  assert.doesNotMatch(WINDOW_JS, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i)
  assert.doesNotThrow(() => new Function(WINDOW_JS))
})

test('deliberate navigation makes real history and refresh keeps reading state', () => {
  // Tabs, place and resident choices, and filter changes push a history
  // entry; only unchanged-hash renders fall through to replaceState.
  assert.match(WINDOW_JS, /function navigate\(next\)/)
  assert.match(WINDOW_JS, /history\.pushState/)
  assert.match(WINDOW_JS, /if \(window\.location\.hash === hash\) return/)
  assert.match(WINDOW_JS, /navigate\(\{ view, placeId \}\)/)
  assert.match(WINDOW_JS, /navigate\(\{ placeId: safeId\(nodes\.placeFilter\.value\) \}\)/)
  assert.match(WINDOW_JS, /navigate\(\{ resident: safeHandle\(nodes\.residentFilter\.value\) \}\)/)
  // Expanded bodies are keyed state, and focus lands back on the rebuilt
  // control after a background refresh re-renders the DOM.
  assert.match(WINDOW_JS, /expandedBodies: \[\]/)
  assert.match(WINDOW_JS, /state\.expandedBodies\.includes\(bodyKey\)/)
  assert.match(WINDOW_JS, /function restoreFocus\(focusKey, focusFallbackKey, focusFallbackId\)/)
  assert.match(WINDOW_JS, /focus\(\{ preventScroll: true \}\)/)
  assert.match(WINDOW_JS, /data-focus-key/)
})

test('filtered happenings fetch their real slice from the server', () => {
  assert.match(WINDOW_JS, /function autoLoadFilteredHistory\(collection, filters, entry\)/)
  assert.match(WINDOW_JS, /autoLoadFilteredHistory\('events', filters, historyEntry\('events', filters\)\)/)
  // The events history request carries the active filters so a busy city
  // cannot push a watched place or followed resident out of the page.
  assert.match(WINDOW_JS, /url\.searchParams\.set\('place_id', String\(filters\.placeId\)\)/)
  assert.match(WINDOW_JS, /url\.searchParams\.set\('actor', filters\.resident\)/)
  // An initialized filtered view keeps learning: each snapshot refresh
  // silently refetches the newest filtered page and merges it.
  assert.match(WINDOW_JS, /function forwardRefreshHistory\(collection, filters\)/)
  assert.match(WINDOW_JS, /refreshFilteredViews\(\)/)
  // The interim load control stays focusable; disabled buttons cannot
  // receive restored focus. Arrow-key tab roving must not flood history.
  assert.match(WINDOW_JS, /aria-busy/)
  assert.doesNotMatch(WINDOW_JS, /button\.disabled = entry\.loading/)
  assert.match(WINDOW_JS, /rovingTabActivation = true/)
})

test('every event kind an emitter writes is advertised public window life', async () => {
  // The world_* kinds went missing because nothing tied emitters to the
  // label list; this scan fails the moment a new INSERT INTO events kind
  // is not also public window vocabulary.
  const { readdir, readFile } = await import('node:fs/promises')
  const sourceDir = new URL('../src/', import.meta.url)
  const written = new Set<string>()
  for (const name of await readdir(sourceDir)) {
    if (!name.endsWith('.ts')) continue
    const source = await readFile(new URL(name, sourceDir), 'utf8')
    for (const match of source.matchAll(
      /INSERT INTO events \(kind, actor, detail\)\s*(?:SELECT\s*'([a-z_]+)'|VALUES \(\s*'([a-z_]+)')/g,
    )) {
      written.add(match[1] ?? match[2] ?? '')
    }
  }
  written.delete('')
  assert.ok(written.size >= 15, `the emitter scan must find real kinds, saw ${written.size}`)
  const advertised = new Set(PUBLIC_EVENT_KINDS)
  const hidden = [...written].filter(kind => !advertised.has(kind))
  assert.deepEqual(hidden, [], 'every written event kind must be public window life')
})

test('the window covers the whole public life of the city', () => {
  assert.ok(PUBLIC_EVENT_KINDS.includes('home_set'))
  assert.ok(PUBLIC_EVENT_KINDS.includes('agreement_accession'))
  // The full enumeration is a truth surface: every kind the city writes for a
  // public act must be listed, or the window silently hides that life. The
  // world_* kinds are the market bridge — their absence hid every market sale.
  assert.deepEqual(PUBLIC_EVENT_KINDS, [
    'register', 'rotate', 'home_set', 'place_created', 'place_edited',
    'kind_invented', 'kind_revised', 'trait_coined', 'thing_created',
    'thing_crafted', 'thing_edited', 'thing_moved', 'thing_upgraded', 'thing_withdrawn',
    'laws_changed', 'action', 'effect_scheduled', 'effect_resolved', 'note',
    'agreement', 'agreement_accession', 'agreement_sign', 'transfer',
    'transfer_offer', 'sale', 'transfer_cancel', 'world_listed', 'world_sale',
    'world_cancel', 'flag', 'moderation',
  ])
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
  assert.match(WINDOW_JS, /Excerpt only — this snapshot carries the first part\./)
  // An excerpt is a dead end unless the reader is told where the rest lives.
  // Notes and things have single-item endpoints; agreements do not, and the
  // notice must say so rather than offering a link that would 404.
  assert.match(WINDOW_JS, /'\/api\/' \+ kind \+ '\/' \+ String\(id\)/)
  assert.match(WINDOW_JS, /Read the whole ' \+ kind/)
  assert.match(WINDOW_JS, /The full text is not served through the glass\./)
  assert.match(WINDOW_CSS, /\.body-full-link/)
  assert.match(WINDOW_CSS, /\.public-body\[data-expanded="false"\]/)
  assert.match(WINDOW_CSS, /-webkit-line-clamp:/)
  assert.match(WINDOW_CSS, /\.body-disclosure:focus-visible/)
})

test('map branches expose accessible lazy-load and collapse controls', () => {
  assert.match(WINDOW_JS, /collapsedPlaceIds:\s*\[\]/)
  assert.match(WINDOW_JS, /element\('button', 'place-disclosure'/)
  assert.match(WINDOW_JS, /setAttribute\('aria-expanded'/)
  assert.match(WINDOW_JS, /setAttribute\('aria-controls'/)
  assert.match(WINDOW_JS, /place\.places\s*>\s*0/)
  assert.match(WINDOW_JS, /children\.hidden = !expanded/)
  assert.match(WINDOW_JS, /collapsedPlaceIds\.filter\(/)
  assert.match(WINDOW_JS, /\[\.\.\.state\.collapsedPlaceIds, placeId\]/)
  assert.doesNotMatch(WINDOW_JS, /collapsedPlaceIds\.(?:add|delete|push|splice)\(/)
  assert.match(WINDOW_CSS, /\.place-disclosure:focus-visible/)
})

test('the shipped window requests bounded map and resident pages', () => {
  assert.match(WINDOW_JS, /searchParams\.set\('view', 'outline'\)/)
  assert.match(WINDOW_JS, /new URL\('\/api\/map'/)
  assert.match(WINDOW_JS, /searchParams\.set\('parent_id', String\(/)
  assert.match(WINDOW_JS, /searchParams\.set\('subplace_limit', '25'\)/)
  assert.match(WINDOW_JS, /searchParams\.set\('before_subplace_id'/)
  assert.match(WINDOW_JS, /new URL\('\/api\/residents'/)
  assert.match(WINDOW_JS, /searchParams\.set\('view', 'presence'\)/)
  assert.match(WINDOW_JS, /searchParams\.set\('limit', '25'\)/)
  assert.match(WINDOW_JS, /searchParams\.set\('before_id'/)
})

test('partial navigation is explicit, retryable, and keyboard-readable', () => {
  assert.match(WINDOW_HTML, /id="resident-page"/)
  assert.match(WINDOW_JS, /currently loaded/i)
  assert.match(WINDOW_JS, /Load more residents/)
  assert.match(WINDOW_JS, /Retry loading residents/)
  assert.match(WINDOW_JS, /Retry loading places inside/)
  assert.match(WINDOW_JS, /No (?:more )?(?:places|residents)[^\n]*loaded/i)
  assert.match(WINDOW_JS, /aria-busy/)
  assert.match(WINDOW_JS, /data-focus-key/)
})

test('window history queries accept only one safe value for each supported filter', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.parseWindowHistoryQuery, 'function')
  const parse = exports.parseWindowHistoryQuery as (
    queries: Record<string, string[]>,
  ) => Record<string, unknown> | null

  assert.deepEqual(parse({ collection: ['notes'] }), {
    collection: 'notes', beforeId: null, limit: 10, placeId: null, resident: null,
    context: false,
  })
  assert.deepEqual(parse({
    collection: ['things'], before_id: ['91'], limit: ['12'],
    place_id: ['7'], resident: ['tiny-lantern'],
  }), {
    collection: 'things', beforeId: 91, limit: 12, placeId: 7, resident: 'tiny-lantern',
    context: false,
  })
  assert.deepEqual(parse({ collection: ['agreements'], resident: ['tiny-lantern'] }), {
    collection: 'agreements', beforeId: null, limit: 10, placeId: null, resident: 'tiny-lantern',
    context: false,
  })
  assert.deepEqual(parse({
    collection: ['notes'], resident: ['tiny-lantern'], context: ['place'],
  }), {
    collection: 'notes', beforeId: null, limit: 10, placeId: null, resident: 'tiny-lantern',
    context: true,
  })
  assert.deepEqual(parse({
    collection: ['notes'], resident: ['tiny-lantern'], context: ['place'], place_id: ['7'],
  }), {
    collection: 'notes', beforeId: null, limit: 10, placeId: 7, resident: 'tiny-lantern',
    context: true,
  })
  // A context page carries neighbors as well as own notes, so its page size
  // is bounded to keep the whole page inside the public row cap.
  assert.deepEqual(parse({
    collection: ['notes'], resident: ['tiny-lantern'], context: ['place'], limit: ['200'],
  }), {
    collection: 'notes', beforeId: null, limit: 39, placeId: null, resident: 'tiny-lantern',
    context: true,
  })
  assert.deepEqual(parse({
    collection: ['notes'], limit: ['200'],
  }), {
    collection: 'notes', beforeId: null, limit: 200, placeId: null, resident: null,
    context: false,
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
    { collection: ['notes'], context: ['place'] },
    { collection: ['notes'], resident: ['tiny-lantern'], context: ['thread'] },
    { collection: ['notes'], resident: ['tiny-lantern'], context: ['place', 'place'] },
    { collection: ['things'], resident: ['tiny-lantern'], context: ['place'] },
    { collection: ['agreements'], resident: ['tiny-lantern'], context: ['place'] },
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
  assert.match(things.text, /thing\.maker_id/i)
  assert.match(things.text, /maker\.handle AS made_by/i)
  assert.match(things.text, /thing\.owner_id AS owner_id/i)
  assert.match(things.text, /thing\.owner_id AS current_owner_id/i)
  assert.match(things.text, /current_owner\.handle AS current_owner/i)
  assert.match(things.text, /current_owner\.handle = \$3::text/i)
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

  // The context variant drives the page from the resident's own notes and
  // carries bounded same-place neighbors on each side.
  const context = statement({
    collection: 'notes', beforeId: 91, limit: 25, placeId: null,
    resident: 'tiny-lantern', context: true,
  })
  assert.match(context.text, /WITH resident_notes AS/i)
  assert.match(context.text, /author\.handle = \$3::text/i)
  assert.match(context.text, /CROSS JOIN LATERAL/i)
  assert.match(context.text, /DISTINCT ON \(ctx\.id\)/i)
  assert.match(context.text, /neighbor\.id < own\.id/i)
  assert.match(context.text, /neighbor\.id > own\.id/i)
  assert.match(context.text, /LIMIT 2\)/)
  assert.match(context.text, /UNION ALL/i)
  // Two cursor-safety invariants: context never contains the followed
  // resident (an own note returning as context would freeze the cursor and
  // bury the note under it), and context anchors only to the rows this page
  // keeps, never to the trimmed lookahead note.
  assert.match(context.text, /ctx_author\.handle <> \$3::text/i)
  assert.match(context.text, /row_number\(\) OVER \(ORDER BY note\.id DESC\) AS own_position/i)
  assert.match(context.text, /page_notes AS \(\s*SELECT \* FROM resident_notes WHERE own_position <= \$5::integer/i)
  assert.match(context.text, /FROM page_notes own/i)
  assert.deepEqual(context.values, [91, null, 'tiny-lantern', 26, 25])
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

test('resident pages merge immutably by joined time and use id only as a tie-breaker', () => {
  const exports = windowClientModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.mergeResidentRows, 'function')
  const merge = exports.mergeResidentRows as (
    current: readonly Readonly<{ id: number, joined_at: Date }>[],
    incoming: readonly Readonly<{ id: number, joined_at: Date }>[],
  ) => Array<{ id: number, joined_at: Date }>
  const current = Object.freeze([
    Object.freeze({ id: 90, joined_at: new Date('2026-08-12T00:00:00.000Z') }),
    Object.freeze({ id: 7, joined_at: new Date('2026-08-14T00:00:00.000Z') }),
  ])
  const incoming = Object.freeze([
    Object.freeze({ id: 2, joined_at: new Date('2026-08-16T00:00:00.000Z') }),
    Object.freeze({ id: 100, joined_at: new Date('2026-08-15T00:00:00.000Z') }),
    Object.freeze({ id: 8, joined_at: new Date('2026-08-14T00:00:00.000Z') }),
  ])

  const merged = merge(current, incoming)
  assert.deepEqual(merged.map(row => row.id), [2, 100, 8, 7, 90])
  assert.deepEqual(current.map(row => row.id), [90, 7])
  assert.deepEqual(incoming.map(row => row.id), [2, 100, 8])
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
  assert.match(WINDOW_JS, /'Loading ' \+ older \+ label/)
  assert.match(WINDOW_JS, /'Retry loading ' \+ older \+ label/)
  assert.match(WINDOW_JS, /entry\.loading && !entry\.initialized \? '' : 'older '/)
  assert.match(WINDOW_CSS, /\.history-page/)
})

test('all-place conversations preserve the server newest-first order', () => {
  assert.match(WINDOW_JS, /const notes = entry\.rows/)
  assert.match(WINDOW_JS, /noteCard\(note, placeOf\(note\.place_id\)\)/)
  assert.doesNotMatch(WINDOW_JS, /const placeIds = \[\.\.\.new Set\(notes\.map/)
})

test('a followed resident never looks falsely silent', () => {
  // The conversations view fetches the resident's own server-side slice with
  // same-place context, pages it, refreshes it, and marks context notes.
  assert.match(WINDOW_JS, /context: Boolean\(state\.resident\)/)
  assert.match(WINDOW_JS, /autoLoadFilteredHistory\('notes', filters, historyEntry\('notes', filters\)\)/)
  assert.match(WINDOW_JS, /url\.searchParams\.set\('context', 'place'\)/)
  assert.match(WINDOW_JS, /filters\.context \? '25' : '50'/)
  assert.match(WINDOW_JS, /context-note/)
  // Neighbours are chosen by position in the room, not by clock, so the mark
  // states the measured distance instead of asserting a closeness the
  // selection rule never guarantees.
  assert.match(WINDOW_JS, /function relativeGap\(/)
  assert.match(WINDOW_JS, /relativeGap\(note\.created_at, anchor\.created_at\)/)
  assert.doesNotMatch(WINDOW_JS, /same room, said around then/)
  assert.match(WINDOW_CSS, /\.context-note/)
  assert.match(WINDOW_CSS, /\.context-mark/)
})

test('relativeGap reports the real distance in both directions', () => {
  // Exercised through the shipped source so the assertion tracks the string
  // the reader actually sees rather than a copy of it.
  const source = /function relativeGap\(fromIso, toIso\) \{[\s\S]*?\n  \}/.exec(WINDOW_JS)
  assert.ok(source, 'relativeGap must be present in the client')
  const relativeGap = new Function('return ' + source[0])() as
    (from: string, to: string) => string
  const anchor = '2026-08-18T21:00:00.000Z'
  assert.equal(relativeGap('2026-08-18T21:00:20.000Z', anchor), 'same room · moments apart')
  assert.equal(relativeGap('2026-08-18T21:25:00.000Z', anchor), 'same room · 25m later')
  assert.equal(relativeGap('2026-08-18T20:35:00.000Z', anchor), 'same room · 25m earlier')
  // The case that prompted the change: a quiet room put nearly a day between
  // a note and the one before it, and the old mark still said "around then".
  assert.equal(relativeGap('2026-08-18T00:12:00.000Z', anchor), 'same room · 21h earlier')
  assert.equal(relativeGap('2026-08-15T21:00:00.000Z', anchor), 'same room · 3d earlier')
  assert.equal(relativeGap('nonsense', anchor), 'same room')
})

test('every printed handle is followable, not only the roster', () => {
  assert.match(WINDOW_JS, /function residentNode\(handle, className, focusKey\)/)
  // An unresolvable handle stays plain text, because chooseResident ignores it
  // and a control that does nothing is worse than no control.
  assert.match(WINDOW_JS, /if \(!known\) return element\('span', className, handle\)/)
  for (const [className, key] of [
    ['note-author', 'note-author:'],
    ['thing-maker', 'thing-maker:'],
    ['thing-owner', 'thing-owner:'],
    ['activity-actor', 'activity-actor:'],
    ['agreement-author', 'agreement-author:'],
  ]) {
    assert.match(WINDOW_JS, new RegExp(`residentNode\\([^)]*'${className}'`))
    assert.match(WINDOW_JS, new RegExp(`'${key}'`))
  }
  assert.match(WINDOW_CSS, /\.resident-follow-inline/)
  assert.match(WINDOW_CSS, /\.resident-follow-inline:focus-visible/)
})

test('thing cards and Archive results name maker and current owner separately', () => {
  assert.match(WINDOW_JS, /safeHandle\(rawResult\.made_by\)/)
  assert.match(WINDOW_JS, /safeHandle\(rawResult\.current_owner \?\? rawResult\.owner\)/)
  assert.match(WINDOW_JS, /made by /)
  assert.match(WINDOW_JS, /currently owned by /)
})

test('a followed view says how many notes it is actually showing', () => {
  // The snapshot counters describe the snapshot; the conversation list is a
  // separate fetch. Printing only the first next to the second read as one
  // number describing the other.
  assert.match(WINDOW_JS, /Conversations below are fetched past that snapshot:/)
  assert.match(WINDOW_JS, /' plus ' \+ String\(followedRows\.length - ownRows\)/)
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
    { id: 9, handle: 'long-gone', current_place_id: 195, joined_at: '2026-07-01T00:00:00Z', asleep: true },
    { id: 10, handle: 'odd-flag', current_place_id: 2, joined_at: '2026-08-11T00:00:00Z', asleep: 'yes' },
  ])
  assert.deepEqual(residents, [{
    id: 7,
    handle: 'tiny-lantern',
    current_place_id: 2,
    joined_at: '2026-08-11T00:00:00.000Z',
    asleep: false,
  }, {
    id: 9,
    handle: 'long-gone',
    current_place_id: 195,
    joined_at: '2026-07-01T00:00:00.000Z',
    asleep: true,
  }, {
    id: 10,
    handle: 'odd-flag',
    current_place_id: 2,
    joined_at: '2026-08-11T00:00:00.000Z',
    asleep: false,
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
    maker_id: 6,
    made_by: 'old-maker',
    owner_id: 7,
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner: 'tiny-lantern',
    open_to_use: true,
    kind: 'lantern',
    traits: ['glowing', '<script>'],
    created_at: '2026-08-11T00:00:00Z',
  }, {
    id: 42,
    place_id: 2,
    name: 'bad provenance',
    body: 'must not enter the window',
    maker_id: 6,
    made_by: '<script>',
    owner_id: 7,
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner: 'tiny-lantern',
    open_to_use: false,
    kind: null,
    traits: [],
    created_at: '2026-08-11T00:00:00Z',
  }, {
    id: 43,
    place_id: 2,
    name: 'mismatched owner aliases',
    body: 'must not enter the window',
    maker_id: 6,
    made_by: 'old-maker',
    owner_id: 8,
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner: 'tiny-lantern',
    open_to_use: false,
    kind: null,
    traits: [],
    created_at: '2026-08-11T00:00:00Z',
  }])
  assert.deepEqual(things, [{
    id: 41,
    place_id: 2,
    name: 'porch lantern',
    body: 'warm light',
    maker_id: 6,
    made_by: 'old-maker',
    owner_id: 7,
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
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
  const credentials = [
    `1f3d9_sk_${'a1'.repeat(24)}`,
    `1f3d9_at_${'b2'.repeat(32)}`,
    `1f3d9_rt_${'c3'.repeat(32)}`,
    `1f3d9_ac_${'d4'.repeat(32)}`,
  ]

  for (const [index, credential] of credentials.entries()) {
    const [note] = windowModule.publicWindowNotes([{
      id: 71 + index,
      place_id: 2,
      author: 'tiny-lantern',
      body: `historical note ${credential}`,
      created_at: '2026-08-11T00:00:00Z',
    }])
    const [thing] = windowModule.publicWindowThings([{
      id: 81 + index,
      place_id: 2,
      name: credential,
      body: credential,
      maker_id: 6,
      made_by: 'old-maker',
      owner_id: 7,
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner: 'tiny-lantern',
      open_to_use: false,
      kind: credential,
      traits: [credential],
      created_at: '2026-08-11T00:00:00Z',
    }])

    assert.equal(note?.id, 71 + index)
    assert.equal(note?.body, PUBLIC_CREDENTIAL_REDACTION)
    assert.equal(thing?.id, 81 + index)
    assert.equal(thing?.name, PUBLIC_CREDENTIAL_REDACTION)
    assert.equal(thing?.body, PUBLIC_CREDENTIAL_REDACTION)
    assert.equal(thing?.kind, PUBLIC_CREDENTIAL_REDACTION)
    assert.deepEqual(thing?.traits, [PUBLIC_CREDENTIAL_REDACTION])
  }
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

test('the bounded window keeps loaded navigation while fresh outline pages merge immutably', () => {
  assert.match(WINDOW_JS, /mergeWindowRows\([^\n]*residents/i)
  assert.match(WINDOW_JS, /mergeWindowRows\([^\n]*(?:children|subplaces)/i)
  assert.match(WINDOW_JS, /collapsedPlaceIds/)
  assert.match(WINDOW_JS, /restoreFocus\(focusKey, focusFallbackKey, focusFallbackId\)/)
  assert.doesNotMatch(WINDOW_JS, /(?:residents|subplaces|children)\.(?:push|splice|sort)\(/)
})

test('bounded navigation stays honest and keyboard-safe at page boundaries', () => {
  assert.doesNotMatch(WINDOW_JS, /nodes\.status\?\.removeAttribute\('role'\)/)
  assert.match(WINDOW_JS, /Place #' \+ String\(placeId\) \+ ' · not currently loaded'/)
  assert.match(WINDOW_JS, /metadata and content are not currently loaded/i)
  assert.match(WINDOW_JS, /seenBeforeIds/)
  assert.match(WINDOW_JS, /seenBeforeSubplaceIds/)
  assert.match(WINDOW_JS, /focusFallbackKey/)
  assert.match(WINDOW_JS, /forwardReconcile/i)
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
