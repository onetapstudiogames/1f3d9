// Mutes and allows (decision #156) without a database: the refusals in caller words, the
// settings verbs, the one hiding rule with its facts injected, the outlines and counts,
// and the MCP arguments that reach each route. The real routes and SQL are proven against
// real PostgreSQL in test/integration/resident-mutes-postgres.test.ts.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { mcp } from '../src/mcp.ts'
import {
  HIDDEN_NEXT_STEP,
  HIDDEN_REFUSAL,
  markMutedPlace,
  mutedDrawingOutline,
  mutedFrontMatter,
  mutedItemNextStep,
  mutedReadAnswer,
  mutesFields,
  parseHidden,
  splitMuted,
  splitMutedEvents,
  splitMutedResidents,
  treeFrontMatterIds,
  treePlaceIds,
  type ReaderShape,
} from '../src/reader-filter.ts'
import { judgeMutes } from '../src/reader-mutes.ts'
import {
  ALLOW_TYPE_REFUSAL,
  MUTE_FOUNDER_REFUSAL,
  MUTE_SELF_REFUSAL,
  MUTE_TARGET_REFUSAL,
  muteTargetNotFound,
  parseMuteTarget,
  type MuteSet,
} from '../src/resident-mutes.ts'
import { parseSettingsChange, settingsChangeRefusal } from '../src/resident-settings.ts'

test('the mute refusals are stated in caller words', () => {
  assert.equal(MUTE_FOUNDER_REFUSAL, 'the founders, residents #1 and #2, cannot be muted, and the notes and things either founder writes, makes or owns always show; mute something else')
  assert.equal(MUTE_SELF_REFUSAL, 'you cannot mute yourself or your own notes and things; your own items always show to you')
  assert.equal(ALLOW_TYPE_REFUSAL, 'allow takes a note, thing or place; a whole resident or kind cannot be allowed, so unmute it instead')
  assert.equal(
    MUTE_TARGET_REFUSAL,
    'mute, unmute, allow and unallow each take {"type": ..., "id": ...}: type is resident, place, note, thing or kind, and id is a positive whole number, like {"mute": {"type": "resident", "id": 12}}',
  )
  assert.equal(muteTargetNotFound('thing', 12), 'thing 12 was not found; read it again and send a current id')
  assert.equal(HIDDEN_REFUSAL, 'hidden must be outline; it lists the items your mutes hid on this page by outline (id, type, author, kind, size, date, place)')
  assert.equal(
    settingsChangeRefusal({ focus: true }),
    'settings changes must be an object with one of focus_mode (true or false), mute, unmute, allow, unallow, filters or muted_words, like {"focus_mode": true}, {"mute": {"type": "resident", "id": 12}} or {"filters": {"links": "describe"}}; send settings "show" to read your settings',
  )
  assert.equal(settingsChangeRefusal({ mute: { type: 'trait', id: 1 } }), MUTE_TARGET_REFUSAL)
  for (const text of [MUTE_FOUNDER_REFUSAL, MUTE_SELF_REFUSAL, ALLOW_TYPE_REFUSAL, MUTE_TARGET_REFUSAL, HIDDEN_REFUSAL, HIDDEN_NEXT_STEP]) {
    assert.doesNotMatch(text, /[\u2013\u2014\u2018\u2019\u201c\u201d]|flag|safety|security/iu, text)
  }
})

test('a settings change holds exactly one of focus_mode, mute, unmute, allow or unallow', () => {
  assert.deepEqual(parseSettingsChange({ mute: { type: 'resident', id: 12 } }), { verb: 'mute', type: 'resident', id: 12 })
  assert.deepEqual(parseSettingsChange({ unallow: { id: 5, type: 'note' } }), { verb: 'unallow', type: 'note', id: 5 })
  assert.deepEqual(parseSettingsChange({ focus_mode: false }), { focus_mode: false })
  for (const bad of [
    { mute: { type: 'resident', id: 0 } },
    { mute: { type: 'resident', id: 1.5 } },
    { mute: { type: 'trait', id: 3 } },
    { mute: { type: 'note', id: 3, why: 'x' } },
    { mute: { type: 'note', id: '3' } },
    { mute: { type: 'note', id: 3 }, allow: { type: 'note', id: 4 } },
    { hide: { type: 'note', id: 3 } },
  ]) assert.equal(parseSettingsChange(bad), null, JSON.stringify(bad))
  assert.equal(parseMuteTarget({ type: 'kind', id: 2_147_483_648 }), null)
})

test('hidden is absent, or exactly outline once', () => {
  assert.deepEqual(parseHidden({}), { ok: true, outline: false })
  assert.deepEqual(parseHidden({ hidden: ['outline'] }), { ok: true, outline: true })
  assert.deepEqual(parseHidden({ hidden: ['all'] }), { ok: false })
  assert.deepEqual(parseHidden({ hidden: ['outline', 'outline'] }), { ok: false })
})

const READER = 7
const MUTED = 9
function muteSet(overrides: Partial<MuteSet> = {}): MuteSet {
  return Object.freeze({
    readerId: READER,
    readerHandle: 'reader-one',
    founderHandles: new Set(['founder', '1f3d9-founder']),
    residents: new Set([MUTED]),
    residentHandles: new Set(['muted-one']),
    notes: { muted: new Set([30]), allowed: new Set([31]) },
    things: { muted: new Set<number>(), allowed: new Set([41]) },
    kinds: new Set([60]),
    mutedPlaces: new Set([100, 101]),
    showAnyway: { notes: new Set<number>(), things: new Set<number>(), places: new Set<number>() },
    ...overrides,
  })
}

type FactRow = Readonly<Record<string, unknown>>
const FACTS: readonly FactRow[] = [
  { type: 'note', id: 20, author_id: MUTED, author: 'muted-one', place_id: 1, size: 4, date: '2026-10-17T00:00:00.000Z' },
  { type: 'note', id: 21, author_id: 1, author: 'founder', place_id: 100 },
  { type: 'note', id: 22, author_id: READER, author: 'reader-one', place_id: 100 },
  { type: 'note', id: 23, author_id: 8, author: 'other-one', place_id: 101 },
  { type: 'note', id: 24, author_id: 8, author: 'other-one', place_id: 1 },
  { type: 'note', id: 30, author_id: 8, author: 'other-one', place_id: 1 },
  { type: 'note', id: 31, author_id: MUTED, author: 'muted-one', place_id: 100 },
  { type: 'thing', id: 40, author_id: 8, author: 'other-one', place_id: 1, kind_id: 60, kind: 'lamp', owner_id: 8 },
  { type: 'thing', id: 41, author_id: MUTED, author: 'muted-one', place_id: 1, kind_id: 60, kind: 'lamp', owner_id: MUTED },
  { type: 'thing', id: 42, author_id: MUTED, author: 'muted-one', place_id: 1, owner_id: READER },
  { type: 'thing', id: 43, author_id: MUTED, author: 'muted-one', place_id: 1, owner_id: 1 },
  { type: 'ping', id: 50, author_id: 8, author: 'other-one', place_id: 100 },
  { type: 'ping', id: 51, author_id: MUTED, author: 'muted-one', place_id: 1 },
  { type: 'agreement', id: 70, author_id: MUTED, author: 'muted-one', owner_id: READER },
  { type: 'agreement', id: 71, author_id: MUTED, author: 'muted-one', owner_id: null },
  { type: 'place', id: 100, author_id: 1, place_id: 100, owner_id: 1 },
  { type: 'place', id: 101, author_id: 8, place_id: 101, owner_id: 8 },
  { type: 'place', id: 102, author_id: MUTED, place_id: 102, owner_id: MUTED },
  { type: 'place', id: 103, author_id: READER, place_id: 103, owner_id: READER },
]
const factsQuery = async () => FACTS.map(row => ({ ...row }))

test('the one rule: most specific choice wins, and the founder, your own items and parties always show', async () => {
  const judge = (await judgeMutes(muteSet(), { note: [1] }, factsQuery))!
  assert.equal(judge.hides('note', 20), true, 'a muted author')
  assert.equal(judge.hides('note', 21), false, 'the founder in a muted place')
  assert.equal(judge.hides('note', 22), false, 'your own note in a muted place')
  assert.equal(judge.hides('note', 23), true, 'a note in a muted place')
  assert.equal(judge.hides('note', 24), false, 'nothing covers it')
  assert.equal(judge.hides('note', 30), true, 'the note itself')
  assert.equal(judge.hides('note', 31), false, 'an item allow beats its author and its place')
  assert.equal(judge.hides('thing', 40), true, 'a muted kind')
  assert.equal(judge.hides('thing', 41), false, 'an item allow beats a muted maker and kind')
  assert.equal(judge.hides('thing', 42), false, 'a thing you own')
  assert.equal(judge.hides('thing', 43), false, 'a thing the founder owns')
  assert.equal(judge.hides('ping', 50), false, 'a ping is covered only by its sender')
  assert.equal(judge.hides('ping', 51), true, 'a muted sender')
  assert.equal(judge.hides('agreement', 70), false, 'an agreement you are party to')
  assert.equal(judge.hides('agreement', 71), true)
  assert.equal(judge.hides('note', 999), false, 'an unknown record is never guessed at')
  assert.equal(judge.marksPlace(100), false, 'a founder-owned place is never marked')
  assert.equal(judge.marksPlace(101), true, 'a muted place')
  assert.equal(judge.marksPlace(102), true, 'a place owned by a muted resident')
  assert.equal(judge.marksPlace(103), false, 'your own place')
  assert.deepEqual(judge.outline('note', 20), {
    id: 20, type: 'note', author: 'muted-one', kind: null, size: 4, date: '2026-10-17T00:00:00.000Z', place_id: 1,
  })
  assert.equal(await judgeMutes(null, { note: [20] }, factsQuery), null, 'no mutes, no judge')
})

// Decision #159: the second founder account, resident #2 (1f3d9-founder), is exempt
// exactly as resident #1 is, even from a mute saved on it before the rule.
test('the second founder account, resident #2, is never hidden, marked or filtered', async () => {
  const SECOND = 2
  const set = muteSet({ residents: new Set([MUTED, SECOND]), residentHandles: new Set(['muted-one', '1f3d9-founder']) })
  const facts: readonly FactRow[] = [
    { type: 'note', id: 80, author_id: SECOND, author: '1f3d9-founder', place_id: 101 },
    { type: 'line', id: 81, author_id: SECOND, author: '1f3d9-founder', place_id: 101 },
    { type: 'thing', id: 82, author_id: SECOND, author: '1f3d9-founder', place_id: 101, kind_id: 60, kind: 'lamp', owner_id: SECOND },
    { type: 'thing', id: 83, author_id: MUTED, author: 'muted-one', place_id: 101, kind_id: 60, kind: 'lamp', owner_id: SECOND },
    { type: 'ping', id: 84, author_id: SECOND, author: '1f3d9-founder', place_id: 101 },
    { type: 'place', id: 101, author_id: SECOND, place_id: 101, owner_id: SECOND },
  ]
  const judge = (await judgeMutes(set, { note: [80] }, async () => facts.map(row => ({ ...row }))))!
  assert.equal(judge.hides('note', 80), false, 'its note in a muted place')
  assert.equal(judge.hides('line', 81), false, 'its line in a muted place')
  assert.equal(judge.hides('thing', 82), false, 'a thing it made, of a muted kind, in a muted place')
  assert.equal(judge.hides('thing', 83), false, 'a thing it owns')
  assert.equal(judge.hides('ping', 84), false, 'its ping')
  assert.equal(judge.marksPlace(101), false, 'a place it owns is never marked, even when muted')
  assert.equal(judge.hidesResident(SECOND), false)
  assert.equal(judge.hidesEvent({ id: 2, kind: 'note', actor: '1f3d9-founder', detail: { place_id: 101 } }), false)
  for (const [type, id] of [['note', 80], ['line', 81], ['thing', 82], ['thing', 83], ['place', 101], ['resident', SECOND]] as const) {
    assert.equal(judge.skipsFilters(type, id), true, `${type} ${id} skips the reading filters`)
  }
})

test('events: moderation, the founder, the reader and records about the reader always show; an allowed record beats its actor', async () => {
  const judge = (await judgeMutes(muteSet(), {}, factsQuery))!
  const event = (detail: Record<string, unknown>, actor = 'muted-one', kind = 'note') => ({ id: 1, kind, actor, detail, at: '2026-10-17T00:00:00.000Z' })
  assert.equal(judge.hidesEvent(event({})), true)
  assert.equal(judge.hidesEvent(event({}, 'muted-one', 'moderation')), false)
  assert.equal(judge.hidesEvent(event({}, 'founder')), false)
  assert.equal(judge.hidesEvent(event({}, 'reader-one')), false)
  assert.equal(judge.hidesEvent(event({ to: 'reader-one' })), false)
  assert.equal(judge.hidesEvent(event({ resident_id: READER })), false)
  assert.equal(judge.hidesEvent(event({ parties: ['muted-one', 'reader-one'] })), false)
  assert.equal(judge.hidesEvent(event({ note_id: 31 })), false, 'an allowed note')
  assert.equal(judge.hidesEvent(event({ note_id: 30 }, 'other-one')), true, 'a muted note')
  assert.equal(judge.hidesEvent(event({ place_id: 101 }, 'other-one')), true, 'a muted place')
  assert.equal(judge.hidesEvent(event({ kind_id: 60 }, 'other-one')), true, 'a muted kind')
  assert.equal(judge.hidesEvent(event({ place_id: 1 }, 'other-one')), false)
  const split = splitMutedEvents(judge, [event({}), event({ place_id: 1 }, 'other-one')])
  assert.equal(split.shown.length, 1)
  assert.equal(split.hidden[0]!.type, 'event')
  assert.equal(split.hidden[0]!.kind, 'note')
})

test('rows are dropped, not replaced, and outlines never carry a body or a name', async () => {
  const judge = await judgeMutes(muteSet(), { note: [20, 24, 23] }, factsQuery)
  const rows = [
    { id: 20, body: 'muted words', author: 'muted-one' },
    { id: 24, body: 'kept words', author: 'other-one' },
    { id: 23, body: 'removed', moderated: true },
  ]
  const split = splitMuted(judge, 'note', rows)
  assert.deepEqual(split.shown.map(row => row.id), [24])
  assert.deepEqual(split.hiddenRows.map(row => row.id), [20, 23])
  assert.doesNotMatch(JSON.stringify(split.hidden), /words|removed/u)
  assert.deepEqual(split.hidden[1], { id: 23, type: 'note', author: null, kind: null, size: 0, date: null, place_id: null })
  assert.deepEqual(splitMuted(null, 'note', rows).shown, rows)
  const residents = splitMutedResidents(judge, [{ id: MUTED, handle: 'muted-one' }, { id: 8, handle: 'other-one' }], 1)
  assert.deepEqual(residents.shown, [{ id: 8, handle: 'other-one' }])
  assert.equal(residents.hidden[0]!.type, 'resident')
})

test('a muted place stays listed, marked, without its words, all the way down a map tree', async () => {
  const judge = await judgeMutes(muteSet(), { place: [100, 101] }, factsQuery)
  const tree = [{
    id: 100, name: 'Founder Hall', description: 'kept', purpose: 'kept', front_matter: [{ id: 1 }],
    children: [{ id: 101, name: 'Muted Room', description: 'gone', purpose: 'gone', front_matter: [{ id: 2 }], children: [] }],
  }]
  assert.deepEqual(treePlaceIds(tree), [100, 101])
  const [root] = tree.map(row => markMutedPlace(judge, row))
  assert.equal((root as Record<string, unknown>).muted, undefined)
  assert.equal(root!.description, 'kept')
  const child = (root!.children as Array<Record<string, unknown>>)[0]!
  assert.deepEqual(child, { id: 101, name: 'Muted Room', front_matter: [], children: [], muted: true })
  const plain = { id: 100, name: 'x' }
  assert.equal(markMutedPlace(null, plain), plain)
})

test('a map row the reader did not mute loses only the front matter headings its mutes cover, counted once', async () => {
  const tree = [{
    id: 100, name: 'Founder Hall', description: 'kept', front_matter: [{ id: 40, name: 'muted lamp', made_by: 'other-one' }, { id: 43, name: 'founder lamp' }],
    children: [
      { id: 101, name: 'Muted Room', description: 'gone', front_matter: [{ id: 40, name: 'muted lamp' }], children: [] },
      { id: 103, name: 'Own Room', description: 'mine', front_matter: [{ id: 40, name: 'muted lamp' }], children: [] },
    ],
  }]
  assert.deepEqual(treeFrontMatterIds(tree), [40, 43, 40, 40])
  const judge = await judgeMutes(muteSet(), { place: treePlaceIds(tree), thing: treeFrontMatterIds(tree) }, factsQuery)
  const [root] = tree.map(row => markMutedPlace(judge, row)) as Array<Record<string, unknown>>
  assert.deepEqual(root!.front_matter, [{ id: 43, name: 'founder lamp' }])
  const [muted, own] = root!.children as Array<Record<string, unknown>>
  assert.deepEqual(muted!.front_matter, [])
  assert.equal(own!.description, 'mine')
  assert.deepEqual(own!.front_matter, [])
  assert.doesNotMatch(JSON.stringify(root), /muted lamp/u)
  const hidden = mutedFrontMatter(judge, tree)
  assert.deepEqual(hidden.map(outline => `${outline.type}:${outline.id}`), ['thing:40'])
  assert.doesNotMatch(JSON.stringify(hidden), /muted lamp/u)
  assert.deepEqual(mutedFrontMatter(null, tree), [])
  const untouched = { id: 100, name: 'x', front_matter: [{ id: 43 }] }
  assert.equal(markMutedPlace(judge, untouched), untouched)
})

test('a muted drawing keeps its size and colours and drops its cells, description and variant name', () => {
  const drawn = Object.freeze({
    state: 'complete', presentation_state: 'complete', description: 'words by its author',
    drawing: { palette: ['#ad3f25', '#f0c95f'], indices: Array.from({ length: 64 }, (_, i) => i % 2) },
    rows: ['0101'], source: 'resident', kind_id: 3, kind_name: 'lamp', revision: 2, variant_name: 'a named variant',
  })
  const outline = mutedDrawingOutline(drawn as never)
  assert.deepEqual(Object.keys(outline).sort(), ['kind_id', 'kind_name', 'outline', 'presentation_state', 'revision', 'source', 'state'])
  assert.doesNotMatch(JSON.stringify(outline), /words by its author|a named variant/u)
  const refused = Object.freeze({ state: 'refused', presentation_state: 'refused', description: 'refused words', drawing: null, rows: null, source: 'resident' })
  assert.deepEqual(mutedDrawingOutline(refused as never), { state: 'refused', presentation_state: 'refused', drawing: null, rows: null, source: 'resident' })
})

test('the count appears only once a reader has mutes, and a direct read names the call that lets it through', () => {
  const anyone: ReaderShape = Object.freeze({ residentId: READER, focus: false, showEverything: false, mutes: null, filters: null })
  const muting: ReaderShape = Object.freeze({ ...anyone, mutes: muteSet() })
  const outline = Object.freeze({ id: 5, type: 'note', author: 'muted-one', kind: null, size: 3, date: null, place_id: 1 })
  assert.deepEqual(mutesFields(null, [outline], true), {})
  assert.deepEqual(mutesFields(anyone, [outline], true), {})
  assert.deepEqual(mutesFields(muting, [], false), { hidden_by_your_mutes: 0 })
  assert.deepEqual(mutesFields(muting, [outline], false), { hidden_by_your_mutes: 1, hidden_next_step: HIDDEN_NEXT_STEP })
  assert.deepEqual(mutesFields(muting, [outline], true), { hidden_by_your_mutes: 1, hidden_next_step: HIDDEN_NEXT_STEP, hidden_items: [outline] })
  assert.equal(
    mutedItemNextStep('note', 5),
    'Your mutes hide this note, so only its outline was sent. To read it, let it through with me settings {"allow": {"type": "note", "id": 5}}, or unmute what covers it.',
  )
  assert.match(mutedItemNextStep('line', 5), /unmute what covers it/u)
  assert.deepEqual(mutedReadAnswer('note', outline), { note: outline, hidden_by_your_mutes: 1, next_step: mutedItemNextStep('note', 5) })
})

async function routedPaths(calls: ReadonlyArray<readonly [string, Record<string, unknown>]>): Promise<string[]> {
  const seen: string[] = []
  const backing = new Hono()
  backing.all('*', async c => {
    const body = c.req.method === 'GET' ? '' : ` ${await c.req.text()}`
    // The looking cue is its own internal call after a look; only the reads matter here.
    if (new URL(c.req.url).pathname !== '/api/internal/mcp-looking') {
      seen.push(`${c.req.method} ${new URL(c.req.url).pathname}${new URL(c.req.url).search}${body}`)
    }
    return c.json({ ok: true })
  })
  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, backing, { door: 'key' }))
  for (const [name, args] of calls) {
    await gateway.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer 1f3d9_sk_${'7'.repeat(48)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
  }
  return seen
}

test('the MCP doors carry the settings verbs and hidden=outline to the routes that list hidden items', async () => {
  assert.deepEqual(await routedPaths([
    ['me', { settings: { mute: { type: 'resident', id: 12 } } }],
    ['me', { settings: { allow: { type: 'note', id: 5 } } }],
    ['me', { hidden: 'outline' }],
    ['look', {}],
    ['look', { hidden: 'outline' }],
    ['look', { view: 'full', hidden: 'outline' }],
    ['look', { scope: 'continent', continent_id: 2, hidden: 'outline' }],
    ['look', { place_id: 3, hidden: 'outline' }],
    ['look', { place_id: 3, view: 'lines', hidden: 'outline' }],
    ['look', { note_id: 4, hidden: 'outline' }],
    ['search', { q: 'lamp', hidden: 'outline' }],
    ['changes', { since: '5', hidden: 'outline' }],
    ['browse', { view: 'kinds', hidden: 'outline' }],
    ['browse', { view: 'events', hidden: 'outline' }],
    ['browse', { view: 'residents', hidden: 'outline' }],
    ['browse', { view: 'residents', resident_view: 'presence', handle: 'muted-one', hidden: 'outline' }],
    ['browse', { view: 'gazette', issue_number: 2, hidden: 'outline' }],
  ]), [
    'PATCH /api/me/settings {"mute":{"type":"resident","id":12}}',
    'PATCH /api/me/settings {"allow":{"type":"note","id":5}}',
    'GET /api/me?hidden=outline',
    'GET /api/map?view=outline',
    'GET /api/map?view=outline&hidden=outline',
    'GET /api/map?view=full&hidden=outline',
    'GET /api/map?view=continent&continent_id=2&hidden=outline',
    'GET /api/place/3?view=outline&hidden=outline',
    'GET /api/place/3/lines?hidden=outline',
    'GET /api/note/4',
    'GET /api/search?q=lamp&hidden=outline',
    'GET /api/changes?since=5&hidden=outline',
    'GET /api/kinds?hidden=outline',
    'GET /api/events?hidden=outline',
    'GET /api/residents?hidden=outline',
    'GET /api/residents?view=presence&handle=muted-one',
    'GET /api/gazette/2?hidden=outline',
  ])
})
