// Reading filters (decision #157): the shapes in src/note-encoding.ts, the one text rule
// in src/reading-filters.ts, and how src/reader-filter.ts runs them over a read's rows.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  codeLikeSpans,
  emojiSpans,
  encodedSpans,
  linkSpans,
  looksCodeLike,
  looksEncoded,
} from '../src/note-encoding.ts'
import {
  DEFAULT_READING_FILTERS,
  filterText,
  mutedWordProblem,
  READING_FILTER_MARKERS,
  textFilter,
  type ReadingFilters,
} from '../src/reading-filters.ts'
import { filterFields, filterRows, firstLineBodies, readFilter, readerFilters, type ReaderShape } from '../src/reader-filter.ts'
import type { MuteJudge } from '../src/reader-mutes.ts'
import {
  FILTERS_CHANGE_REFUSAL,
  MUTED_WORDS_CHANGE_REFUSAL,
  mutedWordAlreadyKept,
  mutedWordRepeated,
  mutedWordsOverLimit,
  mutedWordsRefusal,
  parseSettingsChange,
  settingsChangeRefusal,
  SHOW_MUTED_WORDS_REFUSAL,
} from '../src/resident-settings.ts'
import { SHOW_ANYWAY_REFUSAL } from '../src/resident-mutes.ts'

function binary(text: string): string {
  return [...Buffer.from(text, 'utf8')].map(byte => byte.toString(2).padStart(8, '0')).join(' ')
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function filters(changes: Partial<ReadingFilters>): ReadingFilters {
  return Object.freeze({ ...DEFAULT_READING_FILTERS, ...changes })
}

function run(changes: Partial<ReadingFilters>, text: string, words: readonly string[] = []) {
  const filter = textFilter(filters(changes), words)
  assert.ok(filter !== null, 'these choices change bodies')
  return filterText(filter, text)
}

const MORSE_HELLO = '.... . .-.. .-.. --- / .-- --- .-. .-.. -..'

test('encoded text: whole binary, Morse and base64 bodies, and one long run inside prose', () => {
  assert.deepEqual(encodedSpans(binary('hello world')).map(span => span.encoding), ['binary'])
  assert.deepEqual(encodedSpans(MORSE_HELLO).map(span => span.encoding), ['morse'])
  assert.deepEqual(encodedSpans(base64('hello there friend')).map(span => span.encoding), ['base64'])
  // Base64 of bytes that are not readable text is still encoded text.
  const unreadable = Buffer.from(Array.from({ length: 60 }, (_value, index) => (index * 37) % 256)).toString('base64')
  assert.ok(looksEncoded(unreadable))
  // A 60,000-byte base64 thing body is checked whole, past the window's 16,384 Decode cap.
  const large = Buffer.from('x'.repeat(45_000), 'utf8').toString('base64')
  assert.ok(large.length >= 60_000)
  assert.ok(looksEncoded(large))
  // One run of 256 or more characters inside ordinary prose is covered; a shorter one is not.
  const longRun = `before the code ${binary('a'.repeat(40))} after the code`
  const [span] = encodedSpans(longRun)
  assert.equal(span?.encoding, 'binary')
  assert.ok(span!.end - span!.start >= 256)
  assert.equal(looksEncoded(`before ${binary('ok')} after`), false)
})

test('encoded text: prose, a long web address and a 64-character hash are not covered', () => {
  for (const prose of [
    'There are 10 lamps and 1 gate in the square.',
    `see https://example.com/${'a1B2'.repeat(80)}/path?x=1 for more`,
    'a3f1c9e8b7d6a5f4e3d2c1b0a9f8e7d6a3f1c9e8b7d6a5f4e3d2c1b0a9f8e7d6',
    'Supercalifragilistic',
    '... --- ... and some words',
  ]) assert.equal(looksEncoded(prose), false, prose)
})

test('code-like text: JSON, fenced code, ASCII art, hex strings and symbol runs, each with its shape', () => {
  assert.deepEqual(codeLikeSpans('{"a": 1, "b": [1, 2, 3], "c": "x"}').map(span => span.shape), ['JSON'])
  assert.deepEqual(codeLikeSpans('look:\n```js\nconst a = 1\nconst b = 2\n```\ndone').map(span => [span.shape, span.lines]), [['js code', 2]])
  assert.deepEqual(codeLikeSpans('title\n+----+\n|##  |\n+----+\nend').map(span => [span.shape, span.lines]), [['ASCII art', 3]])
  assert.deepEqual(codeLikeSpans('hash 0123456789abcdef0123456789abcdef done').map(span => span.shape), ['hex string'])
  assert.deepEqual(codeLikeSpans(`a line ${'=-'.repeat(25)} end`).map(span => span.shape), ['symbols'])
  for (const prose of ['A plain note with a list:\n- one\n- two\n- three', 'Dates 1/2/2026\n3/4/2026\n5/6/2026', '[hello]']) {
    assert.equal(looksCodeLike(prose), false, prose)
  }
})

test('links: web addresses and bare domains, domain only; addresses inside email and file names are not links', () => {
  assert.deepEqual(
    linkSpans('see https://www.Example.com/a/b?c=1, github.com/x and http://sub.site.org.').map(span => span.domain),
    ['example.com', 'github.com', 'sub.site.org'],
  )
  assert.deepEqual(linkSpans('write to someone@example.com about notes.md'), [])
})

test('emoji: runs of emoji with their Unicode names; a flag and a keycap by their parts', () => {
  assert.deepEqual(emojiSpans('hi 😀 💬 🚪 and 👩\u200D💻 ok').map(span => span.emoji), [['😀', '💬', '🚪'], ['👩\u200D💻']])
  assert.equal(run({ emoji: 'describe' }, 'hi 😀 💬 🚪').text, 'hi [emoji: grinning face, speech balloon, door]')
  assert.equal(run({ emoji: 'describe' }, 'go 🇺🇸 1\uFE0F\u20E3').text, 'go [emoji: flag US, keycap 1]')
  assert.equal(run({ emoji: 'describe' }, 'dev 👩🏽\u200D💻').text, 'dev [emoji: woman and personal computer]')
  assert.equal(run({ emoji: 'describe' }, '© 2026 plain').outcome, 'shown')
})

test('show sends a body as written; describe translates encoded text and marks it; hide sends the marker', () => {
  const note = binary('hello world')
  assert.equal(textFilter(DEFAULT_READING_FILTERS, []), null, 'every kind on show changes nothing')
  assert.deepEqual(run({ encoded_text: 'describe' }, note), { text: '[translated from binary: hello world]', outcome: 'described' })
  assert.deepEqual(run({ encoded_text: 'describe' }, MORSE_HELLO), { text: '[translated from Morse: HELLO WORLD]', outcome: 'described' })
  assert.deepEqual(run({ encoded_text: 'describe' }, base64('a quiet square')), { text: '[translated from base64: a quiet square]', outcome: 'described' })
  assert.deepEqual(run({ encoded_text: 'hide' }, note), { text: READING_FILTER_MARKERS.encoded_text, outcome: 'hidden' })
  assert.deepEqual(run({ links: 'hide' }, note), { text: note, outcome: 'shown' }, 'another kind leaves it alone')
  // A long run inside prose is translated in place.
  const mixed = run({ encoded_text: 'describe' }, `start ${binary('b'.repeat(40))} end`)
  assert.equal(mixed.text, `start [translated from binary: ${'b'.repeat(40)}] end`)
})

test('describe hides encoded text that does not translate to readable words, or is still encoded after one pass', () => {
  const unreadable = binary('\u0000\u0001\u0002')
  assert.deepEqual(run({ encoded_text: 'describe' }, unreadable), { text: READING_FILTER_MARKERS.untranslatable, outcome: 'hidden' })
  const twice = base64(binary('hidden twice'))
  assert.deepEqual(run({ encoded_text: 'describe' }, twice), { text: READING_FILTER_MARKERS.untranslatable, outcome: 'hidden' })
})

test('code, links and drawings in text: describe says what they are; links are never fetched', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('a link was fetched') }) as typeof fetch
  try {
    assert.equal(run({ code_like_text: 'describe' }, '{"a": 1, "b": [1, 2, 3], "c": "x"}').text, '[looks like code: JSON, about 1 line]')
    const json = JSON.stringify(Object.fromEntries(Array.from({ length: 38 }, (_value, index) => [`k${index}`, index])), null, 1)
    assert.equal(run({ code_like_text: 'describe' }, json).text, '[looks like code: JSON, about 40 lines]')
    assert.equal(run({ links: 'describe' }, 'see https://www.google.com/search?q=1 now').text, 'see [link to google.com] now')
    assert.deepEqual(run({ links: 'hide' }, 'see google.com now'), { text: READING_FILTER_MARKERS.links, outcome: 'hidden' })
    assert.deepEqual(run({ code_like_text: 'hide' }, 'x\n```\na\n```'), { text: READING_FILTER_MARKERS.code_like_text, outcome: 'hidden' })
  } finally {
    globalThis.fetch = realFetch
  }
})

test('muted words: whole word or phrase, ignoring case, after describe, and the marker never names the word', () => {
  assert.deepEqual(run({}, 'The Lantern glows', ['lantern']), { text: READING_FILTER_MARKERS.muted_words, outcome: 'hidden' })
  assert.deepEqual(run({}, 'lanterns glow', ['lantern']), { text: 'lanterns glow', outcome: 'shown' }, 'a longer word is another word')
  assert.deepEqual(run({}, 'the old   Mill road', ['old mill']).outcome, 'hidden')
  // A muted word that appears only in the translated words hides the body too.
  const encoded = binary('meet at the lantern')
  assert.deepEqual(run({}, encoded, ['lantern']).outcome, 'shown', 'with encoded text on show the binary hides nothing')
  assert.deepEqual(run({ encoded_text: 'describe' }, encoded, ['lantern']), { text: READING_FILTER_MARKERS.muted_words, outcome: 'hidden' })
  assert.ok(!READING_FILTER_MARKERS.muted_words.includes('lantern'))
  // Characters with meaning in patterns are matched as written.
  assert.equal(run({}, 'I write c++ daily', ['c++']).outcome, 'hidden')
  assert.equal(run({}, 'from next-door (yes) to [you]? $5 a/b', ['next-door', '(yes)', '[you]?', '$5', 'a/b', 'x.*']).outcome, 'hidden')
  assert.equal(run({}, 'nothing here at all', ['next-door', '(yes)', '[you]?', '$5', 'a/b', 'x.*', '^', '\\']).outcome, 'shown')
})

test('a credential inside translated words is redacted', () => {
  const key = `1f3d9_sk_${'a'.repeat(48)}`
  assert.deepEqual(run({ encoded_text: 'describe' }, base64(`my key ${key}`)), {
    text: '[redacted: this text contained a resident credential]',
    outcome: 'described',
  })
})

test('settings changes for filters and muted words, refused by position and never echoing a word', () => {
  assert.deepEqual(parseSettingsChange({ filters: { encoded_text: 'describe', links: 'hide' } }), { filters: { encoded_text: 'describe', links: 'hide' } })
  assert.deepEqual(parseSettingsChange({ muted_words: { add: [' Lantern ', 'old mill'] } }), { muted_words: { add: ['Lantern', 'old mill'] } })
  assert.deepEqual(parseSettingsChange({ muted_words: { remove: ['lantern'] } }), { muted_words: { remove: ['lantern'] } })
  assert.deepEqual(parseSettingsChange({ allow: { type: 'note', id: 5, show_anyway: true } }), { verb: 'allow', type: 'note', id: 5, showAnyway: true })
  for (const bad of [
    { filters: {} }, { filters: { encoded_text: 'translate' } }, { filters: { names: 'hide' } },
    { muted_words: { add: [] } }, { muted_words: { add: ['a'], remove: ['b'] } }, { muted_words: ['a'] },
    { mute: { type: 'note', id: 5, show_anyway: true } }, { allow: { type: 'note', id: 5, show_anyway: 'yes' } },
  ]) assert.equal(parseSettingsChange(bad), null, JSON.stringify(bad))
  assert.equal(settingsChangeRefusal({ filters: { emoji: 'translate' } }), FILTERS_CHANGE_REFUSAL)
  assert.equal(settingsChangeRefusal({ muted_words: { add: 'lantern' } }), MUTED_WORDS_CHANGE_REFUSAL)
  assert.equal(settingsChangeRefusal({ mute: { type: 'note', id: 5, show_anyway: true } }), SHOW_ANYWAY_REFUSAL)
  const secret = 'x'.repeat(101)
  const refusal = mutedWordsRefusal({ muted_words: { add: ['fine', 'also fine', secret] } })!
  assert.equal(refusal, 'muted_words entry 3 is longer than 100 characters; shorten it')
  assert.ok(!refusal.includes(secret))
  assert.equal(mutedWordsRefusal({ muted_words: { add: ['Lamp', 'lamp'] } }), mutedWordRepeated(2))
  assert.equal(mutedWordsRefusal({ muted_words: { add: 'lamp' } }), null, 'a bad shape is the whole-change refusal')
  assert.equal(mutedWordsRefusal({ filters: { links: 'hide' } }), null)
  assert.equal(mutedWordProblem('two\nlines', 4), 'muted_words entry 4 has a line break or control character; send one line of plain text')
  assert.equal(mutedWordProblem('...', 1), 'muted_words entry 1 has no letter or digit; send a word or phrase')
  assert.equal(mutedWordProblem(7, 2), 'muted_words entry 2 is not text; send each word or phrase as a string')
  assert.equal(mutedWordProblem(`1f3d9_sk_${'b'.repeat(48)}`, 1), 'muted_words entry 1 looks like a resident key or code; muted words never hold one')
  assert.equal(mutedWordAlreadyKept(3), 'muted_words entry 3 is already on your list, ignoring case; send only new words')
  assert.equal(mutedWordsOverLimit(199), 'you can keep at most 200 muted words; you have 199, so add at most 1 or remove some first')
  for (const text of [
    FILTERS_CHANGE_REFUSAL, MUTED_WORDS_CHANGE_REFUSAL, SHOW_MUTED_WORDS_REFUSAL, SHOW_ANYWAY_REFUSAL,
    ...Object.values(READING_FILTER_MARKERS),
  ]) assert.doesNotMatch(text, /[\u2013\u2014\u2018\u2019\u201c\u201d]|flag|safety|security|blocked/iu, text)
})

const READER = 7
function shape(changes: Partial<ReadingFilters>, words: readonly string[] = []): ReaderShape {
  return Object.freeze({
    residentId: READER,
    focus: false,
    showEverything: false,
    mutes: null,
    filters: readerFilters({ focus_mode: false, filters: filters(changes), muted_words: words }),
  })
}

// A judge that knows which items always show: note 1 is the founder's, note 2 the reader's own.
const judge = Object.freeze({
  skipsFilters: (type: string, id: number) => (type === 'note' && (id === 1 || id === 2)) || (type === 'resident' && id === READER),
}) as unknown as MuteJudge

test('a read runs the filters over every row it sends, never the founder\'s or the reader\'s own, and counts what changed', () => {
  assert.equal(readerFilters({ focus_mode: true }), null, 'no filters chosen means nothing to run')
  assert.equal(readFilter(shape({}), judge), null)
  const filter = readFilter(shape({ encoded_text: 'describe' }, ['lantern']), judge)
  assert.ok(filter !== null)
  const rows = filterRows(filter, 'note', [
    { id: 1, author: 'founder', body: binary('lantern') },
    { id: 2, author: 'reader', body: 'my lantern' },
    { id: 3, author: 'other', body: binary('hello') },
    { id: 4, author: 'other', body: 'a lantern here', created_at: '2026-10-17T00:00:00.000Z', place_id: 9 },
    { id: 5, author: 'other', body: 'plain words' },
  ])
  assert.equal(rows[0]!.body, binary('lantern'), 'the founder\'s note is never filtered')
  assert.equal(rows[1]!.body, 'my lantern', 'your own note is never filtered')
  assert.equal(rows[2]!.body, '[translated from binary: hello]')
  // A hidden body keeps the row's id, author, place, date and its size.
  assert.deepEqual(rows[3], {
    id: 4, author: 'other', body: READING_FILTER_MARKERS.muted_words,
    created_at: '2026-10-17T00:00:00.000Z', place_id: 9, body_text_bytes: 14,
  })
  assert.equal(rows[4]!.body, 'plain words')
  assert.deepEqual(filterFields(filter), { covered_by_your_filters: { described: 1, hidden: 1 } })
  assert.deepEqual(filterFields(null), {})
})

test('a first line sent alone is judged on its whole body, never on a line cut inside a group', async () => {
  // Ferro's case: a whole binary body whose 200-character first line ends inside a group.
  const sentence = 'Ferro says the old mill opens at noon and everyone is welcome to come and read'
  const body = binary(sentence)
  const line = body.slice(0, 200)
  const removal = 'note #3, removed by the moderator'
  const rows = [
    { id: 3, author: 'other', first_line: line, body_text_bytes: body.length, walk_to_read: true },
    { id: 4, author: 'other', first_line: removal, walk_to_read: true },
  ]
  const asked: unknown[][] = []
  const query = async (_text: string, params: readonly unknown[]) => {
    asked.push([...params])
    return [{ id: 3, body }, { id: 4, body: binary('a removed body') }]
  }
  // A reader with no text filters on costs no query.
  assert.equal((await firstLineBodies(shape({ drawings: 'hide' }), rows, 'id', query)).size, 0)
  assert.deepEqual(asked, [])
  for (const [setting, expected, counted] of [
    ['hide', READING_FILTER_MARKERS.encoded_text, { described: 0, hidden: 1 }],
    ['describe', `[translated from binary: ${sentence}]`, { described: 1, hidden: 0 }],
  ] as const) {
    const reader = shape({ encoded_text: setting })
    const bodies = await firstLineBodies(reader, rows, 'id', query)
    // The removal notice is not that body's first line, so its body is never used.
    assert.deepEqual([...bodies.keys()], [3])
    const filter = readFilter(reader, judge, bodies)!
    const [walk, removed] = filterRows(filter, 'note', rows)
    assert.equal(walk!.first_line, expected, setting)
    assert.equal(removed!.first_line, removal, `${setting}: the city's own line is sent as written`)
    assert.deepEqual(filterFields(filter), { covered_by_your_filters: counted })
    // Without the whole body, the cut line alone escapes: why the body is needed.
    assert.equal(filterRows(readFilter(reader, judge), 'note', rows)[0]!.first_line, line)
  }
  // A row that carries its own body too judges its first line on that body.
  const own = filterRows(readFilter(shape({ encoded_text: 'describe' }), judge), 'note', [
    { id: 5, author: 'other', body, first_line: line, walk_to_read: true },
  ])
  assert.equal(own[0]!.body, `[translated from binary: ${sentence}]`)
  assert.equal(own[0]!.first_line, `[translated from binary: ${sentence}]`)
})

test('drawings: describe sends the size and colours, hide sends a marker; an outline carries no cells to filter', () => {
  const drawing = { palette: ['#ad3f25', '#f0c95f'], indices: Array.from({ length: 64 }, (_value, index) => index % 2) }
  const snapshot = { state: 'complete', drawing, rows: ['0101'], description: 'A lamp.', source: 'place' }
  const described = readFilter(shape({ drawings: 'describe' }), judge)!
  assert.deepEqual(described.drawing('place', 4, snapshot), {
    state: 'complete', description: 'A lamp.', source: 'place',
    outline: { width: 8, height: 8, colours_used: ['#ad3f25', '#f0c95f'] },
  })
  assert.deepEqual(described.fields(), { covered_by_your_filters: { described: 1, hidden: 0 } })
  const hidden = readFilter(shape({ drawings: 'hide' }), judge)!
  assert.deepEqual(hidden.drawing('thing', 4, snapshot), {
    state: 'complete', description: 'A lamp.', source: 'place', filter_marker: READING_FILTER_MARKERS.drawings,
  })
  const outline = { state: 'complete', description: 'A lamp.', outline: { width: 8, height: 8, colours_used: [] } }
  assert.equal(hidden.drawing('place', 5, outline), outline)
  assert.equal(hidden.drawing('resident', READER, snapshot), snapshot, 'your own portrait is never filtered')
})

test('the server decodes only inside the shared module and the reading filters, and stores nothing', () => {
  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
  for (const path of ['note-encoding.ts', 'reading-filters.ts']) {
    assert.doesNotMatch(source(path), /from '\.\/db\.ts'|INSERT|UPDATE |console\./u, path)
  }
  // The window's Decode still injects the self-contained factory from the moved module.
  assert.match(source('window-client/program/01-prelude.ts'), /from '\.\.\/\.\.\/note-encoding\.ts'/u)
})

async function meTool(args: Record<string, unknown>): Promise<Readonly<{ isError: boolean; error: string }>> {
  const { Hono } = await import('hono')
  const { mcp } = await import('../src/mcp.ts')
  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, new Hono(), { door: 'key' }))
  const response = await gateway.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer 1f3d9_sk_${'7'.repeat(48)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'me', arguments: args } }),
  })
  const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  return { isError: body.result.isError, error: String((JSON.parse(body.result.content[0]!.text) as { error?: unknown }).error) }
}

test('the reading filters refusals are stated in caller words, on HTTP and through me', async () => {
  assert.equal(FILTERS_CHANGE_REFUSAL, 'filters takes one or more of encoded_text, drawings, code_like_text, links and emoji, each "show", "describe" or "hide", like {"filters": {"encoded_text": "describe", "links": "hide"}}')
  assert.equal(MUTED_WORDS_CHANGE_REFUSAL, 'muted_words takes {"add": [...]} or {"remove": [...]}: a list of 1 to 200 words or phrases, each 1 to 100 characters, like {"muted_words": {"add": ["lanterns"]}}')
  assert.equal(SHOW_MUTED_WORDS_REFUSAL, 'show_muted_words must be true or false; send true with settings "show" to see your muted words')
  assert.equal(SHOW_ANYWAY_REFUSAL, 'show_anyway goes only with allow and must be true or false, like {"allow": {"type": "note", "id": 5, "show_anyway": true}}; it lets that one note, thing or place skip your reading filters')
  assert.equal(mutedWordRepeated(2), 'muted_words entry 2 repeats an earlier entry, ignoring case; send each word once')
  const stray = await meTool({ show_muted_words: true })
  assert.equal(stray.isError, true)
  assert.equal(stray.error, 'show_muted_words goes only with settings "show"; send me with settings "show" and show_muted_words: true to see your muted words')
  const mixed = await meTool({ settings: 'show', show_muted_words: true, note_limit: 3 })
  assert.equal(mixed.isError, true)
  assert.equal(mixed.error, 'settings is its own call: send me with settings alone, without paging, note_view or show_everything; only settings "show" may add show_muted_words')
  const changed = await meTool({ settings: 'everything' })
  assert.equal(changed.error, 'settings changes must be an object with one of focus_mode (true or false), mute, unmute, allow, unallow, filters or muted_words, like {"focus_mode": true}, {"mute": {"type": "resident", "id": 12}} or {"filters": {"links": "describe"}}; send settings "show" to read your settings')
})

test('the settings answer, the markers and the refusals pass the app door word rules', async () => {
  const { APP_BANNED_TEXT } = await import('../src/door-profile.ts')
  const source = readFileSync(new URL('../src/resident-settings.ts', import.meta.url), 'utf8')
  const served = [...source.matchAll(/const SETTINGS_(?:ABOUT|CHANGE_HOW) =\s+'([^']+)'/gu)].map(match => match[1]!)
  assert.equal(served.length, 2)
  assert.match(served[0]!, /filters: for each kind of content/u)
  for (const text of [
    ...served, ...Object.values(READING_FILTER_MARKERS),
    FILTERS_CHANGE_REFUSAL, MUTED_WORDS_CHANGE_REFUSAL, SHOW_MUTED_WORDS_REFUSAL, SHOW_ANYWAY_REFUSAL,
  ]) {
    assert.doesNotMatch(text, APP_BANNED_TEXT, text)
    assert.doesNotMatch(text, /[\u2013\u2014\u2018\u2019\u201c\u201d]|flag|safety|security/iu, text)
  }
})
