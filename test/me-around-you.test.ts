import assert from 'node:assert/strict'
import test from 'node:test'
import { mapAroundYou } from '../src/me-around-you.ts'
import { AROUND_YOU_CHANGE_LIMIT } from '../src/me-around-you-limit.ts'

const empty = () => ({ count: 0, records: [] })
const snapshot = () => ({
  after_change_id: '15', through_change_id: '100',
  notes_in_owned_places: empty(), new_things_in_owned_places: empty(),
  new_agreement_signers: empty(), mentions: empty(),
})

test('a migrated resident establishes a public baseline independently of their prior visit time', () => {
  const report = mapAroundYou({ ...snapshot(), after_change_id: null })
  assert.ok(report.available)
  assert.equal(report.baseline, true)
  assert.equal(report.after_change_id, null)
  assert.equal(report.through_change_id, '100')
  assert.deepEqual(report.mentions, { count: 0, records: [], has_more: false, more_href: null })
})

test('counts stay exact beyond ten links and continuation starts after the last supplied record', () => {
  const records = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, change_id: String(index + 16) }))
  const report = mapAroundYou({ ...snapshot(), notes_in_owned_places: { count: 120, records } })
  assert.ok(report.available)
  assert.equal(report.baseline, false)
  assert.equal(report.notes_in_owned_places.count, 120)
  assert.equal(report.notes_in_owned_places.records.length, 10)
  assert.equal(report.notes_in_owned_places.has_more, true)
  assert.equal(report.notes_in_owned_places.more_href, '/api/changes?since=25&limit=200')
  assert.equal(report.notes_in_owned_places.records[0]!.href, '/api/note/1')
  assert.match(report.scope, /through_change_id/u)
  assert.match(report.scope, /broader public change log/u)
})

test('record links use existing note, thing and agreement reads and omit source bodies', () => {
  const report = mapAroundYou({
    ...snapshot(),
    mentions: { count: 1, records: [{ id: 9, change_id: '16', body: 'do not copy this' }] },
    new_things_in_owned_places: { count: 1, records: [{ id: 3, change_id: '17', body: 'private input' }] },
    new_agreement_signers: { count: 1, records: [{ id: 23, change_id: '18', signer: 'new-signer', body: 'terms' }] },
  })
  assert.ok(report.available)
  assert.equal(report.mentions.records[0]!.href, '/api/note/9')
  assert.equal(report.new_things_in_owned_places.records[0]!.href, '/api/thing/3')
  assert.equal(report.new_agreement_signers.records[0]!.href, '/api/agreements?before_id=24&limit=1')
  assert.equal(report.new_agreement_signers.records[0]!.signer, 'new-signer')
  assert.doesNotMatch(JSON.stringify(report), /do not copy this|private input|terms|"body"/u)
  const maximum = mapAroundYou({ ...snapshot(), new_agreement_signers: {
    count: 1, records: [{ id: 2_147_483_647, change_id: '19', signer: 'new-signer' }],
  } })
  assert.ok(maximum.available)
  assert.equal(maximum.new_agreement_signers.records[0]!.href, '/api/agreements?limit=1')
})

test('invalid checkpoints or reversed intervals fail instead of advancing an untrustworthy report', () => {
  for (const bad of [null, {}, { ...snapshot(), after_change_id: '101' },
    { ...snapshot(), through_change_id: '9223372036854775808' },
    { ...snapshot(), through_change_id: -1 }]) {
    assert.throws(() => mapAroundYou(bad), /around-you/u)
  }
})

test('unsafe or inconsistent counts cannot be presented as exact', () => {
  for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.throws(() => mapAroundYou({ ...snapshot(), mentions: { count, records: [] } }), /around-you/u)
  }
  for (const records of [[], Array.from({ length: 11 }, (_, i) => ({ id: i + 1, change_id: String(i + 16) }))]) {
    assert.throws(() => mapAroundYou({ ...snapshot(), mentions: { count: 12, records } }), /around-you/u)
  }
  assert.throws(() => mapAroundYou({ ...snapshot(), after_change_id: null,
    mentions: { count: 1, records: [{ id: 1, change_id: '16' }] },
  }), /around-you/u)
})

test('out-of-window records, invalid identifiers and unsafe signer handles are rejected', () => {
  for (const record of [{ id: 0, change_id: '16' }, { id: 2_147_483_648, change_id: '16' },
    { id: 1, change_id: '15' }, { id: 1, change_id: '101' }, { id: 1, change_id: 'x' }]) {
    assert.throws(() => mapAroundYou({ ...snapshot(), mentions: { count: 1, records: [record] } }), /around-you/u)
  }
  assert.throws(() => mapAroundYou({ ...snapshot(), new_agreement_signers: {
    count: 1, records: [{ id: 1, change_id: '16', signer: 'not a handle' }],
  } }), /around-you/u)
  assert.throws(() => mapAroundYou({ ...snapshot(), mentions: { count: 2,
    records: [{ id: 2, change_id: '17' }, { id: 1, change_id: '16' }],
  } }), /around-you/u)
})

test('an interval above the change limit is explicitly unread, body-free, and links the whole skipped interval', () => {
  const after = 9_007_199_254_740_993n
  const through = after + BigInt(AROUND_YOU_CHANGE_LIMIT) + 1n
  const report = mapAroundYou({
    after_change_id: String(after), through_change_id: String(through),
    notes_in_owned_places: null, new_things_in_owned_places: null,
    new_agreement_signers: null, mentions: null,
  })
  assert.equal(report.available, false)
  assert.equal(report.baseline, false)
  assert.equal(report.after_change_id, String(after))
  assert.equal(report.through_change_id, String(through))
  if (report.available) assert.fail('an over-limit interval must not claim available counts')
  assert.equal(report.read_href, '/api/changes?since=9007199254740993&limit=200')
  assert.equal(report.message, 'Too much happened since your last visit to summarize here. This interval was not read; follow read_href through through_change_id.')
  assert.equal(report.notes_in_owned_places, null)
  assert.equal(report.new_things_in_owned_places, null)
  assert.equal(report.new_agreement_signers, null)
  assert.equal(report.mentions, null)
  assert.doesNotMatch(JSON.stringify(report), /"count":0|"body"/u)
})

test('exactly the change limit is eligible and a first-read baseline skips any amount of history', () => {
  const boundary = mapAroundYou({ ...snapshot(), after_change_id: '20', through_change_id: String(20 + AROUND_YOU_CHANGE_LIMIT) })
  assert.equal(boundary.available, true)
  const baseline = mapAroundYou({ ...snapshot(), after_change_id: null, through_change_id: '1000000' })
  assert.equal(baseline.available, true)
  assert.equal(baseline.baseline, true)
  assert.equal(baseline.notes_in_owned_places?.count, 0)
  assert.match(boundary.scope, /Your own notes and things, and notes containing your own handle, count too/u)
  assert.ok(boundary.scope.includes(`at most ${AROUND_YOU_CHANGE_LIMIT.toLocaleString('en-US')}`))
  assert.ok(boundary.scope.includes(`including exactly ${AROUND_YOU_CHANGE_LIMIT.toLocaleString('en-US')}`))
})

test('an unavailable interval cannot carry fabricated counts or bodies', () => {
  assert.throws(() => mapAroundYou({ ...snapshot(), through_change_id: String(16 + AROUND_YOU_CHANGE_LIMIT) }), /around-you/u)
  assert.throws(() => mapAroundYou({
    ...snapshot(), notes_in_owned_places: null, new_things_in_owned_places: null,
    new_agreement_signers: null, mentions: null,
  }), /around-you/u)
})

test('a time or admission budget skip names the unread interval without inventing counts', () => {
  const report = mapAroundYou({
    ...snapshot(), unavailable_reason: 'budget', body: 'must not escape',
    notes_in_owned_places: null, new_things_in_owned_places: null,
    new_agreement_signers: null, mentions: null,
  })
  assert.equal(report.available, false)
  assert.equal(report.baseline, false)
  assert.equal(report.after_change_id, '15')
  assert.equal(report.through_change_id, '100')
  assert.equal(report.read_href, '/api/changes?since=15&limit=200')
  assert.equal(report.message, 'The around-you summary was too busy or took too long. This interval was not summarized; follow read_href through through_change_id.')
  assert.equal(report.notes_in_owned_places, null)
  assert.equal(report.new_things_in_owned_places, null)
  assert.equal(report.new_agreement_signers, null)
  assert.equal(report.mentions, null)
  assert.doesNotMatch(JSON.stringify(report), /must not escape|"count":0|"body"/u)
})

test('a budget skip cannot carry counts, a missing prior checkpoint, or an unknown reason', () => {
  assert.throws(() => mapAroundYou({ ...snapshot(), unavailable_reason: 'budget' }), /around-you/u)
  assert.throws(() => mapAroundYou({ ...snapshot(), unavailable_reason: 'database internals' }), /around-you/u)
  assert.throws(() => mapAroundYou({ ...snapshot(), after_change_id: null, unavailable_reason: 'budget' }), /around-you/u)
})
