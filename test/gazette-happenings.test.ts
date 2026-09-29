import assert from 'node:assert/strict'
import test from 'node:test'

import type { TaggedSql } from '../src/engine.ts'
import { printGazetteIssuesDue } from '../src/gazette.ts'
import { setEngineTransactionRunnerForTests } from '../src/engine.ts'
import {
  GAZETTE_HAPPENINGS_EMPTY_SENTENCE,
  GAZETTE_HAPPENINGS_FAILURE_SENTENCE,
  GAZETTE_HAPPENINGS_HEADING,
  GAZETTE_HAPPENINGS_INTRO,
  GAZETTE_HAPPENINGS_PLACE_ID,
  formatGazetteHappenings,
  gazetteHappeningsFromRows,
  parseGazetteHappenings,
  readGazetteHappeningsRows,
  type GazetteHappeningsFacts,
  type GazetteWeek,
} from '../src/gazette-happenings.ts'

const week: GazetteWeek = Object.freeze({
  startsAt: '2026-10-02T00:00:00.000Z',
  endsAt: '2026-10-06T00:00:00.000Z',
})

type Call = Readonly<{ text: string; values: readonly unknown[] }>

function fakeSql(run: (text: string, values: readonly unknown[]) => Promise<unknown>): {
  database: TaggedSql
  calls: Call[]
} {
  const calls: Call[] = []
  const database = (async () => []) as TaggedSql
  database.query = async (text, values = []) => {
    calls.push(Object.freeze({ text, values: [...values] }))
    return run(text, values)
  }
  return { database, calls }
}

function baseFacts(overrides: Partial<GazetteHappeningsFacts> = {}): GazetteHappeningsFacts {
  return Object.freeze({
    placesFounded: Object.freeze([]),
    morePlaces: 0,
    showingRoom: Object.freeze([]),
    firstLines: Object.freeze([]),
    moreFirstLines: 0,
    smallCorner: null,
    ...overrides,
  })
}

test('the four reads use the fixed hidden-place and latest-moderation rules', async () => {
  const { database, calls } = fakeSql(async () => [])
  await readGazetteHappeningsRows(database, week, GAZETTE_HAPPENINGS_PLACE_ID)

  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map(call => call.values), Array.from({ length: 4 }, () => [
    week.startsAt,
    week.endsAt,
    GAZETTE_HAPPENINGS_PLACE_ID,
  ]))
  assert.deepEqual(calls.map(call => call.text.match(/gazette:happenings-[a-z-]+/u)?.[0]), [
    'gazette:happenings-places',
    'gazette:happenings-showing-room',
    'gazette:happenings-first-lines',
    'gazette:happenings-small-corner',
  ])
  for (const { text } of calls) {
    assert.match(text, /WITH RECURSIVE hidden\(id\) AS \(\s*SELECT id FROM places WHERE quiet\s*UNION\s*SELECT child\.id FROM places child JOIN hidden ON child\.parent_id = hidden\.id/u)
    assert.match(text, /moderation_actions moderation[\s\S]*ORDER BY moderation\.created_at DESC, moderation\.id DESC\s+LIMIT 1/u)
    assert.match(text, /retired_at IS NULL/u)
    assert.match(text, /place_kind <> 'world'/u)
    assert.match(text, /NOT EXISTS[\s\S]*hidden/u)
    assert.match(text, /IS DISTINCT FROM 'remove'/u)
    assert.match(text, /\$1::[a-z]+/u)
    assert.match(text, /\$2::[a-z]+/u)
    assert.match(text, /\$3::[a-z]+/u)
    assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE)\s+INTO\b/iu)
  }
  assert.match(calls[0]!.text, /gazette:happenings-places[\s\S]*created_at >= \$1::timestamptz[\s\S]*created_at < \$2::timestamptz[\s\S]*owner_id/u)
  assert.match(calls[0]!.text, /WITH RECURSIVE[\s\S]*root_owner[\s\S]*UNION ALL[\s\S]*parent_id[\s\S]*IS NOT DISTINCT FROM/u)
  assert.match(calls[1]!.text, /gazette:happenings-showing-room[\s\S]*note\.author_id = place\.owner_id[\s\S]*walk_to_read = FALSE[\s\S]*\$2::timestamptz - interval '30 days'[\s\S]*body ~ '\^THE \[A-Z\]\+ QUESTION:'[\s\S]*\$1::timestamptz < \$2::timestamptz/u)
  assert.match(calls[2]!.text, /target_type = 'line'[\s\S]*line\.created_at < \$2::timestamptz[\s\S]*DISTINCT ON \(line\.place_id\)[\s\S]*first_line\.created_at >= \$1::timestamptz/u)
  assert.match(calls[3]!.text, /DISTINCT ON \(note\.place_id\)[\s\S]*count_note\.created_at < \$2::timestamptz[\s\S]*\) < 10[\s\S]*ORDER BY created_at DESC, place_id DESC[\s\S]*LIMIT 22/u)
})

test('the public record becomes the design Happenings block in fixed section order', () => {
  const places = [
    { id: 1202, owner_id: 1, place_kind: 'continent' },
    { id: 1180, owner_id: 2, place_kind: 'place' },
    { id: 1150, owner_id: 3, place_kind: 'place' },
    ...Array.from({ length: 31 }, (_, index) => ({
      id: 2000 + index,
      owner_id: (index % 3) + 1,
      place_kind: 'place',
    })),
  ]
  const facts = gazetteHappeningsFromRows({
    places,
    showingRoom: [{
      id: 24966,
      body: 'THE WEATHER QUESTION: Will it rain? 2026-10-04 at 15:00:00 UTC and 2026-10-05 at 15:00:00 UTC',
    }],
    firstLines: [{ place_id: 310 }, { place_id: 1093 }],
    smallCorner: [{ place_id: 1188, note_id: 24890 }],
  }, week)

  assert.equal(facts.morePlaces, 31)
  assert.equal(formatGazetteHappenings(facts, 'issue header'), [
    'HAPPENINGS',
    'Written by the Gazette printer from the public record of the week ending at this print. Fixed published rules pick these few items; no person or AI chooses them, and this column is not a submission.',
    'Places founded: place #1202 (continent), place #1180, place #1150.',
    'And 31 more qualifying places were founded; browse with view events and kind place_created lists every place, including quiet and nested ones.',
    'In the Showing Room, place #438: question note #24966, times named 2026-10-04 at 15:00 UTC and 2026-10-05 at 15:00 UTC, closed before this print.',
    'First lines said: place #310, place #1093.',
    'A small corner: place #1188, first note #24890.',
  ].join('\n'))
})

test('empty weeks, one-item sentences, time validation, owner caps, and no duplicate places are fixed', () => {
  assert.equal(formatGazetteHappenings(baseFacts(), 'header'), [
    GAZETTE_HAPPENINGS_HEADING,
    GAZETTE_HAPPENINGS_INTRO,
    GAZETTE_HAPPENINGS_EMPTY_SENTENCE,
  ].join('\n'))

  const facts = gazetteHappeningsFromRows({
    places: [
      { id: 100, owner_id: 1, place_kind: 'place' },
      { id: 101, owner_id: 1, place_kind: 'place' },
      ...Array.from({ length: 11 }, (_, index) => ({
        id: index + 200,
        owner_id: index + 2,
        place_kind: 'place',
      })),
    ],
    showingRoom: [{
      id: 10,
      body: 'THE FIRST QUESTION: 2026-02-30 at 12:00:00 UTC; 2026-10-03 at 15:00:30 UTC; 2026-10-04 at 15:00:00 UTC',
    }, {
      id: 11,
      body: 'THE FIRST QUESTION: 2026-10-05 at 15:00:00 UTC',
    }, {
      id: 12,
      body: 'THE NO_TIME QUESTION: no date appears here',
    }, {
      id: 13,
      body: 'THE OLD QUESTION: 2026-10-01 at 15:00:00 UTC',
    }],
    firstLines: [
      { place_id: 100 },
      ...Array.from({ length: 13 }, (_, index) => ({ place_id: index + 2 })),
    ],
    smallCorner: [
      { place_id: 100, note_id: 100 },
      { place_id: 99, note_id: 101 },
    ],
  }, week)

  assert.equal(facts.placesFounded.length, 10)
  assert.equal(facts.placesFounded[0]?.place_id, 100)
  assert.equal(facts.morePlaces, 3)
  assert.equal(facts.showingRoom.length, 1)
  assert.deepEqual(facts.showingRoom[0]?.times, [
    '2026-10-03 at 15:00:30 UTC',
    '2026-10-04 at 15:00 UTC',
  ])
  assert.equal(facts.showingRoom[0]?.openAtPrint, false)
  assert.deepEqual(facts.firstLines, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(facts.moreFirstLines, 3)
  assert.deepEqual(facts.smallCorner, { placeId: 99, noteId: 101 })

  const singular = formatGazetteHappenings(gazetteHappeningsFromRows({
    places: [
      { id: 15, owner_id: 15, place_kind: 'place' },
      { id: 16, owner_id: 15, place_kind: 'place' },
    ],
    showingRoom: [{ id: 20, body: 'THE OPEN QUESTION: 2026-10-06 at 15:00:20 UTC' }],
    firstLines: [{ place_id: 51 }, { place_id: 52 }],
    smallCorner: [],
  }, week), 'header')
  assert.match(singular, /Places founded: place #15\./u)
  assert.match(singular, /And 1 more qualifying place was founded;/u)
  assert.match(singular, /times named 2026-10-06 at 15:00:20 UTC, still open at this print\./u)
  assert.match(singular, /First lines said: place #51, place #52\./u)
  const oneFirstLine = formatGazetteHappenings(baseFacts({ firstLines: Object.freeze([51]) }), 'header')
  assert.match(oneFirstLine, /First lines said: place #51\./u)
  const oneMoreFirstLine = formatGazetteHappenings(baseFacts({
    firstLines: Object.freeze(Array.from({ length: 10 }, (_, index) => index + 51)),
    moreFirstLines: 1,
  }), 'header')
  assert.match(oneMoreFirstLine, /And 1 more room had its first line said\./u)
})

test('the header byte cap yields the fixed unavailable block', () => {
  const block = formatGazetteHappenings(baseFacts({
    firstLines: Object.freeze([1]),
  }), 'x'.repeat(3990))
  assert.equal(block, [GAZETTE_HAPPENINGS_HEADING, GAZETTE_HAPPENINGS_FAILURE_SENTENCE].join('\n'))
})

test('the parser reads every stored section after the exact heading and skips unknown lines', () => {
  const header = [
    'place #454',
    GAZETTE_HAPPENINGS_HEADING,
    'Places founded: place #1202 (continent), place #1180.',
    'And 31 more qualifying places were founded; browse with view events and kind place_created lists every place, including quiet and nested ones.',
    'In the Showing Room, place #438: question note #24966, times named 2026-10-04 at 15:00 UTC and 2026-10-05 at 15:00 UTC, still open at this print.',
    'First lines said: place #310, place #1093.',
    'And 4 more rooms had their first lines said.',
    'A small corner: place #1188, first note #24890.',
    GAZETTE_HAPPENINGS_EMPTY_SENTENCE,
    GAZETTE_HAPPENINGS_FAILURE_SENTENCE,
    'place #777 is not a section',
  ].join('\n')
  const parsed = parseGazetteHappenings(header)
  assert.deepEqual(parsed, [
    { section: 'places_founded', place_id: 1202, place_kind: 'continent' },
    { section: 'places_founded', place_id: 1180 },
    { section: 'more_places', count: 31 },
    {
      section: 'showing_room',
      place_id: 438,
      note_id: 24966,
      times: ['2026-10-04 at 15:00 UTC', '2026-10-05 at 15:00 UTC'],
      open_at_print: true,
    },
    { section: 'first_lines', place_id: 310 },
    { section: 'first_lines', place_id: 1093 },
    { section: 'more_first_lines', count: 4 },
    { section: 'small_corner', place_id: 1188, note_id: 24890 },
    { section: 'nothing_new' },
    { section: 'unavailable' },
  ])
  assert.deepEqual(parseGazetteHappenings(`place #454\n${header}`), parsed)
})

test('atomic printing brackets all four reads and releases the savepoint before the first event insert', async t => {
  const calls: Call[] = []
  const transaction = fakeSql(async (text, values) => {
    if (text.includes('gazette_submission_room_is_open()')) return [{ submissions_open: true }]
    if (text.includes('FROM gazette_issues')) return []
    if (text.includes('INSERT INTO events')) return [{ id: 501 }]
    if (text.includes('INSERT INTO gazette_issues')) return [{
      issue_number: 1,
      scheduled_for: '2026-08-31T16:00:00.000Z',
      entry_count: 0,
    }]
    return []
  })
  const record = transaction.database.query!
  transaction.database.query = async (text, values = []) => {
    calls.push(Object.freeze({ text, values: [...values] }))
    return record(text, values)
  }
  setEngineTransactionRunnerForTests(async (_database, work) => work(transaction.database, true))
  t.after(() => setEngineTransactionRunnerForTests(null))

  await printGazetteIssuesDue(transaction.database, '2026-08-31T16:00:00.000Z')
  const markers = calls.flatMap(call => {
    const marker = call.text.match(/gazette:happenings-[a-z-]+/u)?.[0]
    return marker ? [marker] : []
  })
  assert.deepEqual(markers, [
    'gazette:happenings-savepoint',
    'gazette:happenings-timeout',
    'gazette:happenings-places',
    'gazette:happenings-showing-room',
    'gazette:happenings-first-lines',
    'gazette:happenings-small-corner',
    'gazette:happenings-rollback',
    'gazette:happenings-release',
  ])
  assert.equal(calls.filter(call => /gazette:happenings-(?:places|showing-room|first-lines|small-corner)/u.test(call.text)).length, 4)
  const eventIndex = calls.findIndex(call => call.text.includes('INSERT INTO events'))
  const releaseIndex = calls.findIndex(call => call.text.includes('gazette:happenings-release'))
  assert.ok(eventIndex > releaseIndex)
  assert.ok(calls.slice(0, eventIndex).every(call => !/\b(?:INSERT|UPDATE|DELETE)\s+INTO\b/iu.test(call.text)))
})

test('a failed Happenings read prints an unavailable block and leaves the issue insert running', async t => {
  const calls: Call[] = []
  const transaction = fakeSql(async (text, values) => {
    if (text.includes('gazette_submission_room_is_open()')) return [{ submissions_open: true }]
    if (text.includes('FROM gazette_issues')) return []
    if (text.includes('gazette:happenings-showing-room')) {
      throw Object.assign(new Error('not printed'), { code: '42P18' })
    }
    if (text.includes('INSERT INTO events')) return [{ id: 502 }]
    if (text.includes('INSERT INTO gazette_issues')) return [{
      issue_number: 1,
      scheduled_for: '2026-08-31T16:00:00.000Z',
      entry_count: 0,
    }]
    return []
  })
  const record = transaction.database.query!
  transaction.database.query = async (text, values = []) => {
    calls.push(Object.freeze({ text, values: [...values] }))
    return record(text, values)
  }
  setEngineTransactionRunnerForTests(async (_database, work) => work(transaction.database, true))
  t.after(() => setEngineTransactionRunnerForTests(null))

  await printGazetteIssuesDue(transaction.database, '2026-08-31T16:00:00.000Z')
  const issueInsert = calls.find(call => call.text.includes('INSERT INTO gazette_issues'))
  assert.ok(issueInsert)
  assert.ok(String(issueInsert.values[2]).endsWith([
    GAZETTE_HAPPENINGS_HEADING,
    GAZETTE_HAPPENINGS_FAILURE_SENTENCE,
  ].join('\n')))
  assert.ok(calls.some(call => call.text.includes('gazette:happenings-rollback')))
  assert.ok(calls.some(call => call.text.includes('gazette:happenings-release')))
  assert.ok(calls.some(call => call.text.includes('INSERT INTO events')))
})
