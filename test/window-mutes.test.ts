// Decision #160: the window's half of the browser mute list. The parser and the rule are
// a copy of the live view's (1f3d9-live src/browser-mutes.ts); the shared fixture below is
// byte for byte the live view's test/fixtures/browser-mutes-fixture.json (1f3d9-live
// 72131e9), so both halves answer every case the same way. Either repository changing
// that file must change both.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FOUNDER_RESIDENT_IDS } from '../src/founders.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import {
  WINDOW_MUTES_STORAGE_KEY,
  createWindowMuteHelpers,
  type WindowMute,
  type WindowMutePlace,
  type WindowMuteRowKind,
  type WindowMuteSubject,
} from '../src/window-client/mutes.ts'

const FIXTURE_URL = new URL('./fixtures/browser-mutes-fixture.json', import.meta.url)
const FIXTURE_BYTES = readFileSync(FIXTURE_URL)
// sha256 of the committed bytes in 1f3d9-live at 72131e9.
const LIVE_FIXTURE_SHA256 = '2407f9470ba595e86f546580f50d58b31bee6d1ea7dd5882cba7f7f5c310dbfb'

type Fixture = {
  key: string
  version: number
  max_items: number
  founder_resident_ids: number[]
  parse: { name: string; raw: string | null; items: WindowMute[] }[]
  places: WindowMutePlace[]
  judge: { name: string; items: WindowMute[]; subject: WindowMuteSubject; hidden: boolean }[]
}
const fixture = JSON.parse(FIXTURE_BYTES.toString('utf8')) as Fixture

const helpers = createWindowMuteHelpers(FOUNDER_RESIDENT_IDS)
// The same factory as the page runs it: rebuilt from its own source text, which proves it
// reads no outside name.
const injected = new Function('return (' + createWindowMuteHelpers.toString() + ')')()(
  [...FOUNDER_RESIDENT_IDS]) as typeof helpers

test('the shared fixture is byte for byte the live view copy', () => {
  assert.equal(createHash('sha256').update(FIXTURE_BYTES).digest('hex'), LIVE_FIXTURE_SHA256)
})

test('the fixture names the same key, version, cap and both founders as the window', () => {
  assert.equal(fixture.key, WINDOW_MUTES_STORAGE_KEY)
  assert.equal(fixture.version, 1)
  assert.equal(fixture.max_items, helpers.maxItems)
  assert.deepEqual(fixture.founder_resident_ids, [...FOUNDER_RESIDENT_IDS])
  assert.equal(fixture.parse.length, 38)
  assert.equal(fixture.judge.length, 98)
})

for (const row of fixture.parse) {
  test(`stored list: ${row.name}`, () => {
    assert.deepEqual(helpers.parse(row.raw), row.items)
    assert.deepEqual(injected.parse(row.raw), row.items)
  })
}

for (const row of fixture.judge) {
  test(`mute rule: ${row.name}`, () => {
    for (const copy of [helpers, injected]) {
      const rules = copy.compile(row.items)
      assert.equal(copy.hidden(row.subject, rules, copy.hiddenPlaces(rules, fixture.places)), row.hidden)
    }
  })
}

// The adapter half: each judge subject rebuilt as the row the window holds (handles, not
// numbers, for authors, makers and owners), turned back into a subject by the window's
// adapter, and judged again. The window has no listening marks; a mark is the same rule
// as a resident, so it is driven through the resident row.
const handleOf = (id: number | null | undefined): string | null =>
  typeof id === 'number' ? 'resident-' + String(id) : null
const residentId = (handle: unknown): number | null => {
  const match = typeof handle === 'string' ? /^resident-(\d+)$/u.exec(handle) : null
  return match ? Number(match[1]) : null
}

function windowRow(subject: WindowMuteSubject): { kind: WindowMuteRowKind; row: Record<string, unknown> } {
  switch (subject.type) {
    case 'resident':
    case 'mark':
      return { kind: 'resident', row: { id: subject.id, handle: handleOf(subject.id), current_place_id: subject.place_id ?? null } }
    case 'place':
      return { kind: 'place', row: { id: subject.id, owner: handleOf(subject.owner_id) } }
    case 'note':
      return { kind: 'note', row: { id: subject.id, place_id: subject.place_id, author: handleOf(subject.author_id) } }
    case 'line':
      return { kind: 'line', row: { id: subject.id, placeId: subject.place_id, author: handleOf(subject.author_id) } }
    case 'thing':
      return {
        kind: 'thing',
        row: {
          id: subject.id, place_id: subject.place_id, made_by: handleOf(subject.author_id),
          current_owner: handleOf(subject.owner_id), kind_id: subject.kind_id ?? null,
        },
      }
    case 'event':
      return {
        kind: 'event',
        row: {
          actor: handleOf(subject.author_id),
          detail: Object.fromEntries(Object.entries({
            note_id: subject.note_id, thing_id: subject.thing_id, kind_id: subject.kind_id,
            place_id: subject.place_id,
          }).filter(([, value]) => typeof value === 'number')),
        },
      }
  }
}

for (const row of fixture.judge) {
  test(`window rows judged through the adapter: ${row.name}`, () => {
    const { kind, row: windowShape } = windowRow(row.subject)
    const subject = helpers.subject(kind, windowShape, residentId)
    const rules = helpers.compile(row.items)
    assert.equal(helpers.hidden(subject, rules, helpers.hiddenPlaces(rules, fixture.places)), row.hidden)
  })
}

test('the adapter reads every place the window keeps an id under', () => {
  assert.deepEqual(helpers.subject('thing', {
    id: 9, place_id: 3, maker_id: 12, made_by: 'resident-99', current_owner_id: 13, kind_id: 39,
  }, residentId), { type: 'thing', id: 9, author_id: 12, owner_id: 13, kind_id: 39, place_id: 3 })
  assert.deepEqual(helpers.subject('thing-detail', {
    id: 9, placeId: 3, madeBy: 'resident-12', currentOwner: 'resident-13', kindId: 39,
  }, residentId), { type: 'thing', id: 9, author_id: 12, owner_id: 13, kind_id: 39, place_id: 3 })
  assert.deepEqual(helpers.subject('archive', {
    type: 'note', id: 5, placeId: 3, actor: 'resident-12',
  }, residentId), { type: 'note', id: 5, author_id: 12, place_id: 3 })
  // A search result carries no kind; the window fills kindId from a thing it already read.
  assert.deepEqual(helpers.subject('archive', {
    type: 'thing', id: 9, placeId: 3, makerId: 12, madeBy: 'resident-12', currentOwnerId: 13, kindId: 39,
  }, residentId), { type: 'thing', id: 9, author_id: 12, owner_id: 13, kind_id: 39, place_id: 3 })
  assert.deepEqual(helpers.subject('archive', {
    type: 'thing', id: 9, placeId: 3, makerId: 12, currentOwnerId: 13,
  }, residentId), { type: 'thing', id: 9, author_id: 12, owner_id: 13, kind_id: null, place_id: 3 })
  assert.deepEqual(helpers.subject('gazette', { noteId: 5, author: 'resident-12', placeId: 454 }, residentId),
    { type: 'note', id: 5, author_id: 12, place_id: 454 })
  assert.deepEqual(helpers.subject('event', {
    actor: 'resident-12', detail: { asset_type: 'thing', asset_id: 9 },
  }, residentId, 3), {
    type: 'event', author_id: 12, note_id: null, thing_id: 9, kind_id: null, place_id: 3,
  })
  assert.deepEqual(helpers.subject('place', { id: 249, owner_id: 2, owner: 'resident-12' }, residentId),
    { type: 'place', id: 249, owner_id: 2 })
})

test('a choice makes a new list, keeps the version 1 shape and never names a founder', () => {
  const empty = helpers.parse(null)
  const one = helpers.withChoice(empty, 'resident', 12, 'mute')
  assert.deepEqual(one, [{ type: 'resident', id: 12, choice: 'mute' }])
  assert.deepEqual(empty, [])
  const two = helpers.withChoice(one!, 'note', 5, 'allow')
  assert.deepEqual(helpers.parse(helpers.serialize(two!)), two)
  assert.equal(helpers.serialize(two!),
    '{"version":1,"items":[{"type":"resident","id":12,"choice":"mute"},{"type":"note","id":5,"choice":"allow"}]}')
  const moved = helpers.withChoice(two!, 'resident', 12, 'mute')
  assert.deepEqual(moved, [{ type: 'note', id: 5, choice: 'allow' }, { type: 'resident', id: 12, choice: 'mute' }])
  assert.deepEqual(helpers.withChoice(two!, 'resident', 12, null), [{ type: 'note', id: 5, choice: 'allow' }])
  for (const founder of FOUNDER_RESIDENT_IDS) {
    assert.equal(helpers.withChoice(empty, 'resident', founder, 'mute'), null)
  }
  assert.equal(helpers.withChoice(empty, 'resident', 12, 'allow'), null)
  assert.equal(helpers.withChoice(empty, 'kind', 39, 'allow'), null)
  assert.equal(helpers.withChoice(empty, 'note', 0, 'mute'), null)
  const full = Object.freeze(Array.from({ length: helpers.maxItems }, (_, index) =>
    Object.freeze({ type: 'note' as const, id: index + 1, choice: 'mute' as const })))
  assert.equal(helpers.withChoice(full, 'note', helpers.maxItems + 1, 'mute'), null)
  assert.equal(helpers.withChoice(full, 'note', 1, null)?.length, helpers.maxItems - 1)
})

test('the page injects the one factory with the founder pair and touches only its own storage key', () => {
  assert.ok(WINDOW_JS.includes('const windowMuteHelpers = (function createWindowMuteHelpers('))
  assert.ok(WINDOW_JS.includes(')(' + JSON.stringify([...FOUNDER_RESIDENT_IDS]) + ')'))
  assert.ok(WINDOW_JS.includes('const WINDOW_MUTES_STORAGE_KEY = ' + JSON.stringify(WINDOW_MUTES_STORAGE_KEY)))
  const storageCalls = [...WINDOW_JS.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(([^,)]+)/gu)]
    .map(match => match[1]!.trim())
  assert.deepEqual([...new Set(storageCalls)].sort(), [
    'ANNOUNCEMENT_STORAGE_KEY', 'WINDOW_MUTES_STORAGE_KEY', 'WINDOW_VIEWER_OPEN_STORAGE_KEY',
  ])
  // The list is never sent: no request in the page names the key or the list.
  assert.doesNotMatch(WINDOW_JS, /searchParams\.set\([^)]*mute/iu)
  assert.doesNotMatch(WINDOW_JS, /fetch\([^)]*mute/iu)
})
