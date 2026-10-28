import assert from 'node:assert/strict'
import test from 'node:test'
import {
  planShowingResultParts,
  renderShowingOpeningReport,
  renderShowingResult,
  renderShowingRules,
  showingQuestionHeading,
  type ShowingResultCopy,
  type ShowingRulesCopy,
} from '../src/showing-room-copy.ts'
import { gazetteHappeningsFromRows } from '../src/gazette-happenings.ts'
import { countShowingRoom, parseShowingRoomBallot, parseShowingRoomEntry, type ShowingRoomNote } from '../src/showing-room-count.ts'

const rules: ShowingRulesCopy = Object.freeze({
  questionNumber: 11,
  title: 'A synthetic title',
  prompt: 'Write a notice for an imaginary room.',
  entryClosesAt: '2026-11-07T15:00:00.000Z',
  voteClosesAt: '2026-11-09T15:00:00.000Z',
})

function result(overrides: Partial<ShowingResultCopy> = {}): ShowingResultCopy {
  return Object.freeze({
    questionNumber: 11,
    rulesNoteId: 8000,
    entryCount: 2,
    ballotCount: 2,
    selectionCount: 2,
    entries: [
      { noteId: 8001, residentId: 181, handle: 'first-winner', votes: 1 },
      { noteId: 8002, residentId: 182, handle: 'second-winner', votes: 1 },
    ],
    winners: [
      { noteId: 8001, residentId: 181, handle: 'first-winner', votes: 1 },
      { noteId: 8002, residentId: 182, handle: 'second-winner', votes: 1 },
    ],
    excludedBallots: [],
    withdrawals: [],
    late: false,
    ...overrides,
  })
}

function links(detailCount: number, nextRules: number | null = 9000) {
  return Object.freeze({ count: 8100, winners: 8101, details: Array.from({ length: detailCount }, (_, index) => 8200 + index), nextRules })
}

test('rules publish participation, replacement, withdrawal and all cutoff boundaries before use', () => {
  const body = renderShowingRules(rules)
  assert.match(body, /^THE ELEVENTH QUESTION:\n/u)
  assert.ok(body.includes(rules.title))
  assert.ok(body.includes(rules.prompt))
  for (const phrase of [
    'Start with ENTRY and a title on that line, or put ENTRY alone and the title on the next nonblank line',
    'up to 75 words excluding ENTRY and the title',
    'Start a ballot with VOTE and one to three different entry-note IDs',
    'with or without #, separated by spaces or commas',
    'only the opening list counts',
    'WITHDRAW #<entry-note-id>',
    'A ballot naming a withdrawn entry is invalid in full',
    'Unicode letters or numbers',
    'combining marks',
    'apostrophes and hyphens',
    'Signatures and afterwords count',
    'newest eligible entry',
    'newest VOTE',
    'does not restore an older ballot',
    'does not revive an older entry',
    'resident #1 and resident #2',
    'own entry',
    'at or after the entry close',
    'at the entry close',
    'before the vote close',
    'no valid ballots',
    'no credit',
    'one full fee credit',
    'founder, resident #1',
  ]) assert.ok(body.includes(phrase), `rules must explain ${phrase}`)
  assert.ok(body.length <= 4000)
  assert.doesNotMatch(body, /[\u2013\u2014\u2018\u2019\u201c\u201d]/u)
})

test('rules promise the Monday count honestly and keep entry then vote as the first two full dates', () => {
  const body = renderShowingRules({
    ...rules,
    title: 'A title mentioning 2026-01-01 at 12:00:00 UTC',
    prompt: 'A synthetic prompt mentioning 2026-01-02 at 12:00:00 UTC.',
  })
  assert.ok(body.includes('Entries close Saturday 2026-11-07 at 15:00:00 UTC; voting opens then and closes Monday 2026-11-09 at 15:00:00 UTC; the count posts here at the Monday close, followed by the winners and the next question if one is ready.'))
  assert.ok(body.includes('These UTC times do not shift with daylight saving. If the count is delayed, the closing times still hold and a later note will state the delay.'))
  assert.deepEqual([...body.matchAll(/\d{4}-\d{2}-\d{2} at \d{2}:\d{2}:\d{2} UTC/gu)].slice(0, 2).map(match => match[0]), [
    '2026-11-07 at 15:00:00 UTC',
    '2026-11-09 at 15:00:00 UTC',
  ])
})

test('question headings remain unique beyond twenty through the maximum stored question number', () => {
  const headings = Array.from({ length: 120 }, (_, index) => showingQuestionHeading(index + 1))
  assert.equal(new Set(headings).size, 120)
  assert.equal(headings[20], 'THE TWENTY-FIRST QUESTION')
  assert.equal(headings[99], 'THE ONE-HUNDREDTH QUESTION')
  assert.equal(showingQuestionHeading(2147483647), 'THE TWO-BILLION-ONE-HUNDRED-FORTY-SEVEN-MILLION-FOUR-HUNDRED-EIGHTY-THREE-THOUSAND-SIX-HUNDRED-FORTY-SEVENTH QUESTION')
  assert.throws(() => showingQuestionHeading(0), /positive whole number/u)
  assert.throws(() => showingQuestionHeading(1.5), /positive whole number/u)
})

test('Happenings reads the first two dates under a hyphenated ordinal question heading', () => {
  const body = renderShowingRules({ ...rules, questionNumber: 21 })
  const facts = gazetteHappeningsFromRows({
    places: [], showingRoom: [{ id: 9001, body }], firstLines: [], smallCorner: [],
  }, { startsAt: '2026-11-02T16:00:00.000Z', endsAt: '2026-11-09T16:00:00.000Z' })
  assert.deepEqual(facts.showingRoom, [{ note_id: 9001, times: ['2026-11-07 at 15:00 UTC', '2026-11-09 at 15:00 UTC'], openAtPrint: false }])
})

test('rendered rules enforce the ordinary 4000 character limit without silently cutting a prompt', () => {
  assert.throws(() => renderShowingRules({ ...rules, prompt: 'a'.repeat(4000) }), /rules.*4000|4000.*rules/iu)
  const available = 4000 - Array.from(renderShowingRules({ ...rules, prompt: '' })).length
  const prompt = '\u{1f31f}'.repeat(available)
  const body = renderShowingRules({ ...rules, prompt })
  assert.equal(Array.from(body).length, 4000)
  assert.ok(body.includes(prompt))
  assert.throws(() => renderShowingRules({ ...rules, prompt: `${prompt}x` }), /rules.*4000|4000.*rules/iu)
})

test('every published participation example is accepted by the actual future parser', () => {
  const examples = [...renderShowingRules(rules).matchAll(/```\n([\s\S]+?)\n```/gu)].map(match => match[1]!)
  assert.equal(examples.length, 5, 'publish both entry forms, both ballot separators and a withdrawal example')
  const note = (id: number, body: string, created_at: string): ShowingRoomNote => ({
    id, body, created_at, place_id: 438, author_id: 181, author: 'synthetic-resident', walk_to_read: false, removed: false,
  })
  for (const body of examples.filter(body => body.startsWith('ENTRY'))) {
    const parsed = parseShowingRoomEntry(note(123, body, '2026-11-03T15:00:00.000Z'), 'showing-room-v1')
    assert.equal(parsed?.eligible, true)
    assert.equal(parsed?.title, 'An example title')
    assert.equal(parsed?.review, 'An example entry.')
  }
  for (const body of examples.filter(body => body.startsWith('VOTE'))) {
    assert.deepEqual(parseShowingRoomBallot(body), { choices: [123, 456], reason: null })
  }
  const withdrawal = examples.find(body => body.startsWith('WITHDRAW'))!
  const counted = countShowingRoom({
    rule_version: 'showing-room-v1', rules_note_id: 100,
    opens_at: '2026-11-02T15:00:00.000Z',
    entries_close_at: rules.entryClosesAt, votes_close_at: rules.voteClosesAt,
  }, [
    note(123, 'ENTRY An example title\nAn example entry.', '2026-11-03T15:00:00.000Z'),
    note(124, withdrawal, '2026-11-08T15:00:00.000Z'),
  ])
  assert.deepEqual(counted.withdrawals.map(row => ({ entryId: row.entry_id, accepted: row.accepted })), [{ entryId: 123, accepted: true }])
  assert.equal(counted.entries.length, 0)
})

test('bootstrap announces the opening question without inventing an earlier result', () => {
  const body = renderShowingOpeningReport(11, 9000)
  assert.match(body, /the showing room/u)
  assert.match(body, /THE ELEVENTH QUESTION/u)
  assert.match(body, /#9000/u)
  assert.match(body, /founder, resident #1/u)
  assert.doesNotMatch(body, /winner|awarded|credit|counted/iu)
  assert.ok(body.length <= 4000)
})

test('a tie names every winner, complete counts and linked rules with one full credit each', () => {
  const input = result()
  const output = renderShowingResult(input, links(planShowingResultParts(input)))
  assert.match(output.count, /2 eligible entries, 2 valid ballots, 2 selections/u)
  assert.match(output.count, /#8000/u)
  for (const handle of ['first-winner', 'second-winner']) assert.ok(output.winners.includes(handle))
  assert.match(output.winners, /one full fee credit each/u)
  assert.match(output.gazette, /2 winners/u)
  assert.match(output.gazette, /#8101/u)
  assert.match(output.gazette, /#9000/u)
  for (const body of [output.count, output.winners, ...output.details, output.gazette, output.square]) {
    assert.ok(body.length > 0 && body.length <= 4000)
    assert.match(body, /founder, resident #1/u)
  }
})

test('large counts preserve every entry, winner and exclusion in linked bounded parts', () => {
  const entries = Array.from({ length: 800 }, (_, index) => ({
    noteId: 10000 + index, residentId: 1000 + index, handle: `resident-${index}`, votes: 1,
  }))
  const input = result({
    entries, winners: entries, entryCount: 800, ballotCount: 800, selectionCount: 800,
    excludedBallots: Array.from({ length: 80 }, (_, index) => ({ noteId: 20000 + index, reason: 'names an entry withdrawn by its author' })),
    withdrawals: [{ noteId: 21000, entryNoteId: 9999 }],
  })
  const detailCount = planShowingResultParts(input)
  assert.ok(detailCount > 1, 'a large complete result requires continuation notes')
  const noteLinks = links(detailCount)
  const output = renderShowingResult(input, noteLinks)
  const complete = [output.count, output.winners, ...output.details].join('\n')
  assert.equal(output.details.length, detailCount)
  for (const entry of entries) {
    assert.ok(complete.includes(`#${entry.noteId}`), `entry #${entry.noteId} must not disappear`)
    assert.ok(complete.includes(entry.handle), `winner ${entry.handle} must not disappear`)
  }
  for (const ballot of input.excludedBallots) assert.ok(complete.includes(`#${ballot.noteId}: ${ballot.reason}`))
  assert.ok(complete.includes('#21000'))
  assert.ok(complete.includes('#9999'))
  for (const id of noteLinks.details) assert.ok(complete.includes(`#${id}`), `continuation #${id} must be reachable`)
  assert.match(output.gazette, /800 winners/u)
  assert.match(output.gazette, /#8101/u)
  for (const body of [output.count, output.winners, ...output.details, output.gazette, output.square]) assert.ok(body.length <= 4000)
  assert.ok(output.count.includes(`/api/note/${noteLinks.details[0]}`))
  assert.ok(output.winners.includes(`/api/note/${noteLinks.details[0]}`))
  output.details.forEach((body, index) => {
    assert.ok(body.includes(`part ${index + 1} of ${detailCount}`))
    assert.ok(body.includes('/api/note/8100'))
    if (index > 0) assert.ok(body.includes(`/api/note/${noteLinks.details[index - 1]}`))
    if (index + 1 < detailCount) assert.ok(body.includes(`/api/note/${noteLinks.details[index + 1]}`))
  })
  assert.throws(() => renderShowingResult(input, links(detailCount - 1)), /complete count.*note links/iu)
})

test('small complete results need no continuation and never quote a hidden body', () => {
  const input = result({
    excludedBallots: [{ noteId: 9123, reason: 'The newest ballot is not readable from the window.' }],
  })
  const withExtraBody = { ...input, hiddenBody: 'PRIVATE_BODY_CANARY_81972' }
  assert.equal(planShowingResultParts(withExtraBody), 0)
  const output = renderShowingResult(withExtraBody, links(0))
  assert.match(output.count, /#9123: The newest ballot is not readable from the window\./u)
  assert.match(output.count, /#8001/u)
  assert.match(output.count, /#8002/u)
  assert.deepEqual(output.details, [])
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_BODY_CANARY_81972/u)
})

test('zero outcomes and late reports state the actual outcome without inventing prizes or print membership', () => {
  for (const entryCount of [0, 2]) {
    const input = result({ entryCount, entries: [], winners: [], ballotCount: 0, selectionCount: 0, late: true })
    const output = renderShowingResult(input, links(planShowingResultParts(input), null))
    assert.match(output.count, /no winner and no credit/iu)
    assert.match(output.gazette, /no new question this week/iu)
    assert.match(output.gazette, /late/iu)
    assert.doesNotMatch(output.gazette, /included in|printed in|appears in this issue/iu)
  }
})
