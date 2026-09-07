import test from 'node:test'
import assert from 'node:assert/strict'
import * as windowModule from '../../src/window.ts'
import * as windowClientModule from '../../src/window-client.ts'
import { WINDOW_JS } from '../../src/window-client.ts'
import { WINDOW_HTML } from '../../src/window-page.ts'
import { WINDOW_CSS } from '../../src/window-style.ts'
import { PUBLIC_CREDENTIAL_PATTERN_SOURCE } from '../../src/credential-safety.ts'

export function registerWindowCollectionsAndFollowTests(): void {
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

    const insideNotes = statement({
      collection: 'notes', beforeId: 91, limit: 50, placeId: 7, resident: null,
      includeDescendants: true,
    })
    assert.match(insideNotes.text, /WITH RECURSIVE selected_places/i)
    assert.match(insideNotes.text, /child\.parent_id = selected\.id/i)
    assert.match(insideNotes.text, /note\.place_id IN \(SELECT id FROM selected_places\)/i)
    assert.deepEqual(insideNotes.values, [91, 7, null, 51])

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

    const thingHeadings = statement({
      collection: 'things', beforeId: null, limit: 25, placeId: 7, resident: null,
      includeDescendants: true, presentation: 'headings', find: 'Signal Lamp',
    })
    assert.match(thingHeadings.text, /WITH RECURSIVE selected_places/i)
    assert.match(thingHeadings.text, /octet_length\(thing\.body\)::integer AS body_text_bytes/i)
    assert.doesNotMatch(thingHeadings.text, /thing\.body\s*(?:,|AS\s+body)/i)
    assert.match(thingHeadings.text, /thing\.name ILIKE/iu)
    const moderationPosition = thingHeadings.text.search(/FROM moderation_actions moderation/iu)
    const nameMatchPosition = thingHeadings.text.search(/thing\.name ILIKE/iu)
    assert.ok(moderationPosition >= 0 && moderationPosition < nameMatchPosition)
    assert.match(thingHeadings.text, /coalesce\([\s\S]*?'restore'\) <> 'remove'/iu)
    assert.match(thingHeadings.text,
      /\(\$5::text IS NULL AND \$6::integer IS NULL\) OR coalesce/iu)
    assert.doesNotMatch(thingHeadings.text, /thing\.name\s*\|\|[\s\S]*?thing\.body/iu)
    assert.match(thingHeadings.text, /ORDER BY thing\.id DESC/i)
    assert.deepEqual(thingHeadings.values, [
      null, 7, null, 26, 'Signal Lamp', null, PUBLIC_CREDENTIAL_PATTERN_SOURCE,
    ])

    const thingById = statement({
      collection: 'things', beforeId: null, limit: 20, placeId: null, resident: null,
      presentation: 'headings', find: '#401',
    })
    assert.match(thingById.text, /thing\.id = \$6::integer/iu)
    assert.deepEqual(thingById.values, [
      null, null, null, 21, null, 401, PUBLIC_CREDENTIAL_PATTERN_SOURCE,
    ])

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
    assert.match(WINDOW_JS, /entry\.initialized \? 'older ' : ''/)
    assert.match(WINDOW_CSS, /\.history-page/)
  })

  test('all-place conversations preserve the server newest-first order', () => {
    assert.match(WINDOW_JS, /const notes = entry\.rows/)
    assert.match(WINDOW_JS, /noteCard\(note, placeOf\(note\.place_id\)\)/)
    assert.doesNotMatch(WINDOW_JS, /const placeIds = \[\.\.\.new Set\(notes\.map/)
  })

  test('a followed resident defaults to their own history and keeps room context explicit', () => {
    assert.match(WINDOW_HTML, /Conversation question/)
    assert.match(WINDOW_JS, /What ' \+ state\.resident \+ ' said/)
    assert.match(WINDOW_JS, /What was said around ' \+ state\.resident/)
    assert.match(WINDOW_JS, /context: Boolean\(state\.resident && state\.conversationContext\)/)
    assert.doesNotMatch(WINDOW_JS, /context: Boolean\(state\.resident\)/)
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
    // The complete directory is enough to make a printed handle useful even
    // before that resident's focused presence row has been fetched.
    assert.doesNotMatch(WINDOW_JS,
      /const known = state\.snapshot &&\s*state\.snapshot\.residents\.some/)
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
}
