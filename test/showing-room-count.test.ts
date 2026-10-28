import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  countShowingRoom, countShowingRoomWords, parseShowingRoomBallot, parseShowingRoomEntry,
  type ShowingRoomCountRules, type ShowingRoomNote,
} from '../src/showing-room-count.ts'

type PublicFixture = {
  records: { source: string; body_sha256: string; record: { note: {
    id: number; place_id: number; author: string; body: string;
    created_at: string; body_text_bytes: number;
  } } }[]
  authors: { record: { resident: { id: number; handle: string } } }[]
}
const fixture = (question: string): PublicFixture => JSON.parse(readFileSync(
  new URL(`./fixtures/showing-room-${question}-public.json`, import.meta.url), 'utf8'))
const q9 = fixture('q9')
const q10 = fixture('q10')
const publicNotes = (source: PublicFixture): ShowingRoomNote[] => source.records.map(({ record }) => ({
  ...record.note,
  author_id: source.authors.find(author => author.record.resident.handle === record.note.author)!
    .record.resident.id,
  walk_to_read: false,
  removed: false,
}))
const q9EntryIds = [36700, 36751, 36760, 36870, 37377, 38941, 39109]
const historicalRules: ShowingRoomCountRules = {
  rule_version: 'q9-replay-v1', rules_note_id: 36699,
  opens_at: publicNotes(q9).find(note => note.id === 36699)!.created_at,
  entries_close_at: '2026-10-24T15:00:00.000Z', votes_close_at: '2026-10-26T15:00:00.000Z',
  // Published count #40224 records the founder's real-place and prior-visit findings.
  // This list admits historical content only; parser output determines every vote.
  historical_eligible_entry_ids: q9EntryIds,
}
const rules: ShowingRoomCountRules = {
  rule_version: 'showing-room-v1', rules_note_id: 100,
  opens_at: '2026-11-02T15:00:00.000Z', entries_close_at: '2026-11-07T15:00:00.000Z',
  votes_close_at: '2026-11-09T15:00:00.000Z',
}
const note = (id: number, author_id: number, body: string,
  overrides: Partial<ShowingRoomNote> = {}): ShowingRoomNote => ({
  id, author_id, author: `resident-${author_id}`, body, place_id: 438,
  created_at: '2026-11-03T12:00:00.000Z', walk_to_read: false, removed: false, ...overrides,
})
const entry = (id: number, author_id: number, overrides: Partial<ShowingRoomNote> = {}) =>
  note(id, author_id, 'ENTRY A title\nA small notice.', overrides)
const ballot = (id: number, author_id: number, body: string,
  overrides: Partial<ShowingRoomNote> = {}) => note(id, author_id, body, {
  created_at: '2026-11-08T12:00:00.000Z', ...overrides,
})
const withdraw = (id: number, author_id: number, target: number,
  overrides: Partial<ShowingRoomNote> = {}) => ballot(id, author_id, `WITHDRAW #${target}`, overrides)

test('public q9 and q10 fixtures retain exact decoded UTF-8 bodies and sources', () => {
  for (const source of [q9, q10]) for (const item of source.records) {
    assert.equal(item.source, `https://1f3d9.com/api/note/${item.record.note.id}`)
    assert.equal(Buffer.byteLength(item.record.note.body), item.record.note.body_text_bytes)
    assert.equal(createHash('sha256').update(item.record.note.body).digest('hex'), item.body_sha256)
  }
})

test('question nine reproduces seven entries, four ballots, ten selections and the published tie', () => {
  const result = countShowingRoom(historicalRules, publicNotes(q9))
  assert.deepEqual(result.entries.map(item => item.id), q9EntryIds)
  assert.deepEqual(result.valid_ballots.map(item => [item.id, item.choices]), [
    [39346, [36760, 37377, 38941]], [39870, [38941]],
    [39875, [36760, 36751, 39109]], [39991, [38941, 36760, 36751]],
  ])
  assert.deepEqual(result.totals, q9EntryIds.map((entry_id, index) => ({
    entry_id, votes: [0, 2, 3, 0, 1, 3, 1][index],
  })))
  assert.equal(result.selection_count, 10)
  assert.deepEqual(result.winners.map(item => [item.id, item.author, item.votes]), [
    [36760, 'elias', 3], [38941, 'pauses-to-look', 3],
  ])
  assert.ok(result.ballot_records.find(item => item.id === 37042)?.reason)
})

test('q9 parser preserves same-line review, place title, emoji and signature boundaries', () => {
  const parsed = new Map(publicNotes(q9).filter(item => q9EntryIds.includes(item.id))
    .map(item => [item.id, parseShowingRoomEntry(item, 'q9-replay-v1')]))
  assert.equal(parsed.get(37377)?.word_count, 99)
  assert.equal(parsed.get(37377)?.signature, 'handwriting #75')
  assert.equal(parsed.get(37377)?.eligible, true)
  assert.ok(parsed.get(36700)?.signature?.includes('first-light'))
  assert.ok(parsed.get(36700)?.review.length)
  assert.ok(parsed.get(36870)?.review.length)
  assert.equal(parsed.get(36870)?.eligible, true)
  assert.equal(parsed.get(36760)?.signature, null)
  assert.ok(parsed.get(36760)?.title.length)
})

test('q9 only omits a terminal attribution matching its actual author and paragraph boundary', () => {
  const base = note(101, 10, 'ENTRY 3 Square\nA review.\n\nresident-10 #10')
  assert.equal(parseShowingRoomEntry(base, 'q9-replay-v1')?.word_count, 2)
  for (const body of ['ENTRY 3 Square\nA review. resident-10 #10',
    'ENTRY 3 Square\nA review.\n\nother-resident #10',
    'ENTRY 3 Square\nA review.\n\nresident-10 #11']) {
    assert.equal(parseShowingRoomEntry({ ...base, body }, 'q9-replay-v1')?.word_count, 4)
  }
  assert.equal(parseShowingRoomEntry({ ...base, body: 'ENTRY 3 Square\nA review.\u2014RESIDENT-10, #10' },
    'q9-replay-v1')?.word_count, 2)
})

test('question ten actual standalone entries preserve the colon and Japanese title', () => {
  for (const current of publicNotes(q10).filter(item => item.id !== 40225)) {
    const parsed = parseShowingRoomEntry(current, 'showing-room-v1')
    assert.ok(parsed, `entry #${current.id}`)
    assert.equal(parsed.title, current.body.trim().split(/\r?\n/u).slice(1).find(line => line.trim())!.trim())
    assert.equal(parsed.eligible, true, `entry #${current.id}`)
  }
})

test('future titles keep colons, numbers and Unicode and do not count toward 75 words', () => {
  for (const body of ['ENTRY Chapter 9: \u591c\u306e\u304a\u77e5\u3089\u305b\nword',
    '\n\nENTRY\n\nChapter 9: \u591c\u306e\u304a\u77e5\u3089\u305b\nword']) {
    const parsed = parseShowingRoomEntry(note(101, 10, body), 'showing-room-v1')
    assert.equal(parsed?.title, 'Chapter 9: \u591c\u306e\u304a\u77e5\u3089\u305b')
    assert.equal(parsed.word_count, 1)
    assert.equal(parsed.eligible, true)
  }
})

test('75 body words are eligible and 76 including an author signature are too long', () => {
  assert.equal(parseShowingRoomEntry(note(101, 10, `ENTRY Long title\n${'word '.repeat(75)}`),
    'showing-room-v1')?.eligible, true)
  const over = parseShowingRoomEntry(note(102, 10, `ENTRY title\n${'word '.repeat(75)}\n\nresident-10`),
    'showing-room-v1')
  assert.equal(over?.word_count, 76)
  assert.equal(over?.eligible, false)
})

test('Unicode word runs join inner apostrophes and hyphens but not other punctuation', () => {
  assert.equal(countShowingRoomWords("can't can\u2019t well-made well\u2010made well\u2011made"), 5)
  assert.equal(countShowingRoomWords('one,two three:four five\u2014six'), 6)
  assert.equal(countShowingRoomWords('e\u0301lan \u65e5\u672c\u8a9e 123 \u0627\u0644\u0639\u0631\u0628\u064a\u0629'), 4)
  assert.equal(countShowingRoomWords('... !!! --- \ud83d\udc7b'), 0)
})

test('future entries need exact uppercase opening word, a title and a counted body word', () => {
  for (const body of ['ENTRYPOINT title\nword', 'entry title\nword', '01000101 01001110',
    'Before ENTRY title\nword']) assert.equal(parseShowingRoomEntry(note(101, 10, body), 'showing-room-v1'), null)
  for (const body of ['ENTRY', 'ENTRY title', 'ENTRY title\n!!!', 'ENTRY\n\n']) {
    assert.equal(parseShowingRoomEntry(note(101, 10, body), 'showing-room-v1')?.eligible, false)
  }
})

test('ballots read only the opening list before prose and never later-line numbers', () => {
  for (const [body, expected] of [
    ['VOTE #101, 102 #103, in no order. More #999', [101, 102, 103]],
    ['VOTE #101 \u2014 no order. #999\n#888', [101]],
    ['\nVOTE 101. I am resident #999.\n102', [101]],
    ['VOTE 101 - no order.', [101]],
  ] as const) assert.deepEqual(parseShowingRoomBallot(body), { choices: expected, reason: null })
  assert.equal(parseShowingRoomBallot('VOTER 101'), null)
  assert.ok(parseShowingRoomBallot('VOTE prose #101')?.reason)
})

test('duplicate, fourth, zero, fractional and oversized ballot choices invalidate the ballot', () => {
  for (const body of ['VOTE 101 101', 'VOTE 101,102,103,104', 'VOTE 0', 'VOTE -101',
    'VOTE 101.5', 'VOTE 9007199254740992', 'VOTE 101#102', 'VOTE 101 102x',
    'VOTE 101 -102']) assert.ok(parseShowingRoomBallot(body)?.reason, body)
})

test('Unicode spaces separate every ballot choice and cannot hide a fourth choice', () => {
  for (const space of ['\u00a0', '\u2009', '\u202f', '\u3000']) {
    assert.deepEqual(parseShowingRoomBallot(`VOTE 101${space}102`), { choices: [101, 102], reason: null })
    assert.ok(parseShowingRoomBallot(`VOTE 101${space}102${space}103${space}104`)?.reason)
  }
})

test('newest eligible entry wins but overlong, hidden and malformed replacements do not erase it', () => {
  for (const replacement of [entry(102, 10, { body: `ENTRY title\n${'word '.repeat(76)}` }),
    entry(102, 10, { removed: true }), entry(102, 10, { walk_to_read: true }),
    entry(102, 10, { body: 'ENTRY title' })]) {
    assert.deepEqual(countShowingRoom(rules, [entry(101, 10), replacement]).entries.map(item => item.id), [101])
  }
  assert.deepEqual(countShowingRoom(rules, [entry(101, 10), entry(102, 10)]).entries.map(item => item.id), [102])
  assert.deepEqual(countShowingRoom(rules, [entry(101, 10, { created_at: '2026-11-04T00:00:00.000Z' }),
    entry(102, 10)]).entries.map(item => item.id), [101])
})

test('q9 uses newest ENTRY, so a bad newer replacement removes the older entry', () => {
  const source = publicNotes(q9).find(item => item.id === 36700)!
  const result = countShowingRoom({ ...historicalRules, historical_eligible_entry_ids: [36700, 36701] },
    [source, { ...source, id: 36701, body: 'ENTRY 3 Square' }])
  assert.equal(result.entries.length, 0)
})

test('entries exclude both founders, other rooms, rules or older notes, and the exact Saturday close', () => {
  const result = countShowingRoom(rules, [entry(101, 1), entry(102, 2), entry(103, 10, { place_id: 439 }),
    entry(99, 11, { created_at: rules.opens_at }), entry(100, 12, { created_at: rules.opens_at }),
    entry(104, 13, { created_at: rules.entries_close_at }),
    entry(105, 14, { created_at: '2026-11-07T14:59:59.999Z' }),
    entry(106, 15, { created_at: rules.opens_at })])
  assert.deepEqual(result.entries.map(item => item.id), [105, 106])
})

test('ballot window includes Saturday close but excludes early and Monday exact or late notes', () => {
  const result = countShowingRoom(rules, [entry(101, 10),
    ballot(110, 20, 'VOTE 101', { created_at: '2026-11-07T14:59:59.999Z' }),
    ballot(111, 21, 'VOTE 101', { created_at: rules.entries_close_at }),
    ballot(112, 22, 'VOTE 101', { created_at: '2026-11-09T14:59:59.999Z' }),
    ballot(113, 23, 'VOTE 101', { created_at: rules.votes_close_at }),
    ballot(114, 24, 'VOTE 101', { created_at: '2026-11-09T15:00:00.001Z' })])
  assert.deepEqual(result.valid_ballots.map(item => item.id), [111, 112])
})

test('newest malformed, unreadable or removed ballot cancels the old ballot without revival', () => {
  for (const replacement of [ballot(112, 20, 'VOTE explanation before 101'),
    ballot(112, 20, 'VOTE 101', { removed: true }), ballot(112, 20, 'VOTE 101', { walk_to_read: true })]) {
    const result = countShowingRoom(rules, [entry(101, 10), ballot(111, 20, 'VOTE 101'), replacement])
    assert.equal(result.valid_ballots.length, 0)
    assert.equal(result.ballot_records.find(item => item.id === 112)?.selected, true)
    assert.ok(result.ballot_records.find(item => item.id === 112)?.reason)
  }
  const byTime = countShowingRoom(rules, [entry(101, 10), ballot(111, 20, 'VOTE 101', {
    created_at: '2026-11-08T13:00:00.000Z',
  }), ballot(112, 20, 'VOTE 999')])
  assert.deepEqual(byTime.valid_ballots.map(item => item.id), [111])
})

test('out-of-window ballots cannot replace an in-window ballot and both founders may vote', () => {
  const result = countShowingRoom(rules, [entry(101, 10), ballot(111, 1, 'VOTE 101'),
    ballot(112, 2, 'VOTE 101'), ballot(113, 1, 'VOTE 999', { created_at: rules.votes_close_at })])
  assert.deepEqual(result.valid_ballots.map(item => item.id), [111, 112])
})

test('one invalid choice rejects the whole ballot for self, duplicate, foreign or absent entry', () => {
  for (const choices of ['101 102', '102 102', '102 999', '102 103']) {
    const result = countShowingRoom(rules, [entry(101, 10), entry(102, 11),
      entry(103, 12, { created_at: '2026-10-01T00:00:00.000Z' }), ballot(111, 10, `VOTE ${choices}`)])
    assert.equal(result.valid_ballots.length, 0)
    assert.equal(result.selection_count, 0)
  }
})

test('positive ties include every winner while zero ballots and zero entries award nothing', () => {
  const result = countShowingRoom(rules, [entry(101, 10), entry(102, 11), entry(103, 12),
    ballot(111, 20, 'VOTE 101 102 103')])
  assert.deepEqual(result.winners.map(item => item.id), [101, 102, 103])
  assert.equal(countShowingRoom(rules, [entry(101, 10)]).winners.length, 0)
  assert.equal(countShowingRoom(rules, [ballot(111, 20, 'VOTE 999')]).winners.length, 0)
})

test('a complete snapshot counts more entries than the public page and is input-order independent', () => {
  const notes = [...Array.from({ length: 250 }, (_, i) => entry(101 + i, 10 + i)),
    ballot(500, 900, 'VOTE 101 350')]
  const forward = countShowingRoom(rules, notes)
  assert.equal(forward.entries.length, 250)
  assert.deepEqual(countShowingRoom(rules, [...notes].reverse()), forward)
  assert.match(forward.content_fingerprint, /^[a-f0-9]{64}$/u)
  assert.notEqual(countShowingRoom(rules, notes.map(item => item.id === 101
    ? { ...item, body: 'ENTRY new title\nnew body' } : item)).content_fingerprint,
  forward.content_fingerprint)
})

test('author withdrawal during voting removes the chosen entry and invalidates the entire earlier ballot', () => {
  const result = countShowingRoom(rules, [entry(101, 10), entry(102, 11), ballot(111, 20, 'VOTE 101 102'),
    withdraw(112, 10, 101)])
  assert.deepEqual(result.entries.map(item => item.id), [102])
  assert.equal(result.withdrawals[0]?.accepted, true)
  assert.equal(result.valid_ballots.length, 0)
  assert.equal(result.selection_count, 0)
  assert.ok(result.ballot_records.find(item => item.id === 111)?.reason)
})

test('wrong-author, other-room, other-question, early, exact-close and malformed withdrawal do nothing', () => {
  for (const invalid of [withdraw(112, 11, 101), withdraw(112, 10, 101, { place_id: 439 }),
    withdraw(112, 10, 99), withdraw(100, 10, 101, { created_at: '2026-11-03T12:00:00.000Z' }),
    withdraw(112, 10, 101, { created_at: rules.votes_close_at }),
    withdraw(112, 10, 101, { body: 'WITHDRAW #101 please' }),
    withdraw(112, 10, 101, { walk_to_read: true })]) {
    assert.deepEqual(countShowingRoom(rules, [entry(101, 10), invalid]).entries.map(item => item.id), [101])
  }
})

test('hidden author withdrawal stays final but cannot revive an older selected entry', () => {
  const result = countShowingRoom(rules, [entry(101, 10), entry(102, 10),
    withdraw(112, 10, 102, { removed: true, body: 'WITHDRAW #102\nAn explanation.' })])
  assert.equal(result.entries.length, 0)
  assert.equal(result.withdrawals[0]?.accepted, true)
  assert.ok(result.entry_records.find(item => item.id === 102)?.reason)
})

test('a fresh eligible entry before Saturday can replace a withdrawn entry', () => {
  const result = countShowingRoom(rules, [entry(101, 10),
    withdraw(102, 10, 101, { created_at: '2026-11-04T12:00:00.000Z' }),
    entry(103, 10, { created_at: '2026-11-05T12:00:00.000Z' })])
  assert.deepEqual(result.entries.map(item => item.id), [103])
})

test('same-time withdrawal orders by note ID and a replacement ballot may avoid it', () => {
  const result = countShowingRoom(rules, [entry(101, 10), entry(102, 11),
    withdraw(103, 10, 101, { created_at: '2026-11-03T12:00:00.000Z' }),
    ballot(111, 20, 'VOTE 101 102'), ballot(112, 20, 'VOTE 102')])
  assert.equal(result.withdrawals[0]?.accepted, true)
  assert.deepEqual(result.valid_ballots.map(item => item.id), [112])
})

test('historical q9 profile never invents the future author withdrawal rule', () => {
  const notes = publicNotes(q9)
  const original = notes.find(item => item.id === 36760)!
  const result = countShowingRoom(historicalRules, [...notes,
    { ...original, id: 39999, created_at: '2026-10-25T12:00:00.000Z', body: 'WITHDRAW #36760' }])
  assert.deepEqual(result.winners.map(item => item.id), [36760, 38941])
})

test('a wrong-room or non-opening VOTE never replaces the authors public ballot', () => {
  const result = countShowingRoom(rules, [entry(101, 10), ballot(111, 20, 'VOTE 101'),
    ballot(112, 20, 'VOTE 999', { place_id: 439 }), ballot(113, 20, 'An explanation\nVOTE 999')])
  assert.deepEqual(result.valid_ballots.map(item => item.id), [111])
})

test('a removed entry cannot win and frozen output contains no hidden body or title', () => {
  const secret = 'HIDDEN-BODY-CANARY'
  const result = countShowingRoom(rules, [entry(101, 10, { removed: true, body: `ENTRY ${secret}\n${secret}` }),
    ballot(111, 20, `VOTE 101\n${secret}`, { walk_to_read: true })])
  assert.equal(result.entries.length, 0)
  assert.equal(result.valid_ballots.length, 0)
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(result.entry_records[0]?.id, 101)
  assert.equal(result.ballot_records[0]?.id, 111)
})

test('database microseconds take priority over note IDs for entry and ballot replacements', () => {
  const result = countShowingRoom(rules, [
    entry(102, 10, { created_at: '2026-11-03T12:00:00.000001Z' }),
    entry(101, 10, { created_at: '2026-11-03T12:00:00.000002Z' }),
    ballot(112, 20, 'VOTE 102', { created_at: '2026-11-08T12:00:00.000001Z' }),
    ballot(111, 20, 'VOTE 101', { created_at: '2026-11-08T12:00:00.000002Z' }),
  ])
  assert.deepEqual(result.entries.map(item => item.id), [101])
  assert.deepEqual(result.valid_ballots.map(item => item.id), [111])
})
