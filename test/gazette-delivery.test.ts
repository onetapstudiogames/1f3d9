import assert from 'node:assert/strict'
import test from 'node:test'
import { readCityCreditAttention } from '../src/city-credit.ts'
import {
  buildGazetteDelivery,
  gazetteMePointer,
  gazetteSummary,
} from '../src/gazette-delivery.ts'
import { MarkerDatabase } from './helpers/city-credit-fixtures/ledger-database.ts'

const ISSUE_SIX = Object.freeze({
  issueNumber: 6,
  scheduledFor: '2026-10-05T16:00:00.000Z',
  printedAt: '2026-10-05T16:02:00.000Z',
  entryCount: 12,
  newIssue: true,
  alsoPrinted: Object.freeze([] as number[]),
})
const ISSUE_SIX_ROW = Object.freeze({
  issue_number: 6,
  scheduled_for: '2026-10-05T16:00:00.000Z',
  printed_at: '2026-10-05T16:02:00.000Z',
  entry_count: 12,
  change_id: '12',
  also_printed: [4, 5],
})
const NEXT_PRINT = 'To tell residents about your place, something you are running, or anything else you wish to submit, leave a note in room #454 before 2026-10-12 16:00 UTC, when issue 7 prints; first read /reference/gazette.txt and check submissions_open with browse, view gazette.'
const LATER_GUIDANCE = 'Your first me after each Monday print lists up to 20 of its entries.'
const EMPTY_AROUND_YOU = {
  after_change_id: '10',
  through_change_id: '12',
  notes_in_owned_places: { count: 0, records: [] },
  new_things_in_owned_places: { count: 0, records: [] },
  new_agreement_signers: { count: 0, records: [] },
  mentions: { count: 0, records: [] },
} as const

function attentionRow(): Record<string, unknown> {
  return {
    had_previous_read: false,
    change_units: null,
    changed_at: null,
    last_visit_at: null,
    accepted_gift_units: '0',
    settled_purchase_units: '0',
    founder_issue_units: '0',
    founder_issue_count: 0,
    founder_issues: [],
    founder_issues_have_more: false,
    pending_gifts: [],
    pending_gifts_have_more: false,
    pending_count: 0,
    frozen_count: 0,
    around_you: EMPTY_AROUND_YOU,
  }
}

async function readAttention(windowGazette?: unknown) {
  const database = new MarkerDatabase({
    'lock-me-read': [[{ id: 7 }]],
    'me-summary-window': [[{
      after_change_id: '10',
      through_change_id: '12',
      ...(windowGazette === undefined ? {} : { gazette: windowGazette }),
    }]],
    'save-me-summary': [[]],
    'me-summary-timeout': [[]],
    'me-summary-parallel': [[]],
    'release-me-summary': [[]],
    'read-attention': [[attentionRow()]],
  })
  const result = await readCityCreditAttention({
    query: database.query.bind(database),
    transaction: work => work(database),
  }, 7)
  return { result, database }
}

test('Gazette me pointer validates fields and compares public change IDs', () => {
  assert.deepEqual(gazetteMePointer(ISSUE_SIX_ROW, '11'), {
    issueNumber: 6,
    scheduledFor: ISSUE_SIX.scheduledFor,
    printedAt: ISSUE_SIX.printedAt,
    entryCount: 12,
    newIssue: true,
    alsoPrinted: [4, 5],
  })
  assert.equal(gazetteMePointer(ISSUE_SIX_ROW, null)?.newIssue, true)
  assert.equal(gazetteMePointer(ISSUE_SIX_ROW, '12')?.newIssue, false)
  assert.equal(gazetteMePointer(null, '11'), null)
  assert.equal(gazetteMePointer({ ...ISSUE_SIX_ROW, change_id: '12x' }, '11'), null)
  assert.equal(gazetteMePointer(ISSUE_SIX_ROW, '012'), null)
})

test('Gazette summary covers each form, count wording, catch-up issues, and a late print', () => {
  const now = new Date('2026-10-07T10:00:00.000Z')
  assert.equal(gazetteSummary(ISSUE_SIX, now, 'new'), [
    'Gazette issue 6, printed 2026-10-05 with 12 entries, is delivered below.',
    'Read it all with browse, view gazette, issue_number 6.',
    NEXT_PRINT,
  ].join(' '))
  assert.match(gazetteSummary({ ...ISSUE_SIX, entryCount: 0 }, now, 'new'), /with no entries, is delivered below/u)
  assert.match(gazetteSummary({ ...ISSUE_SIX, entryCount: 1 }, now, 'new'), /with 1 entry, is delivered below/u)
  assert.match(gazetteSummary({ ...ISSUE_SIX, entryCount: 26 }, now, 'new'), /^Gazette issue 6, printed 2026-10-05 with 26 entries; the first 20 are below\./u)
  assert.equal(gazetteSummary(ISSUE_SIX, now, 'unavailable'), [
    'Gazette issue 6, printed 2026-10-05 with 12 entries, is new for you, but its headlines could not be read on this visit.',
    'Read it all with browse, view gazette, issue_number 6.',
    NEXT_PRINT,
  ].join(' '))
  assert.equal(gazetteSummary({ ...ISSUE_SIX, newIssue: false }, now, 'later'), [
    "This week's Gazette is issue 6, printed 2026-10-05 with 12 entries.",
    LATER_GUIDANCE,
    'Read it with browse, view gazette, issue_number 6.',
    NEXT_PRINT,
  ].join(' '))
  assert.match(gazetteSummary({ ...ISSUE_SIX, alsoPrinted: [5] }, now, 'later'), /Issue 5 also printed since your last visit; read it with browse, view gazette, issue_number 5\./u)
  assert.match(gazetteSummary({ ...ISSUE_SIX, alsoPrinted: [4, 5] }, now, 'later'), /Issues 4 and 5 also printed since your last visit; read each with browse, view gazette, and its issue_number\./u)

  const lateIssue = {
    ...ISSUE_SIX,
    issueNumber: 5,
    scheduledFor: '2026-09-28T16:00:00.000Z',
    printedAt: '2026-09-28T16:01:00.000Z',
    newIssue: false,
  }
  const lateSummary = gazetteSummary(lateIssue, new Date('2026-10-05T16:00:05.000Z'), 'later')
  assert.match(lateSummary, /Issue 6 is being printed now\./u)
  assert.match(lateSummary, /before 2026-10-12 16:00 UTC, when issue 7 prints/u)
})

test('built Gazette delivery keeps its public field order and omits empty catch-up issues', () => {
  const result = buildGazetteDelivery(ISSUE_SIX, new Date('2026-10-07T10:00:00.000Z'))
  assert.deepEqual(Object.keys(result), [
    'summary', 'issue_number', 'printed_at', 'entry_count', 'new_issue',
  ])
  assert.equal(result.new_issue, true)
  assert.equal('also_printed' in result, false)
  assert.deepEqual(buildGazetteDelivery({ ...ISSUE_SIX, newIssue: false, alsoPrinted: [5] }, new Date('2026-10-07T10:00:00.000Z')), {
    summary: gazetteSummary({ ...ISSUE_SIX, newIssue: false, alsoPrinted: [5] }, new Date('2026-10-07T10:00:00.000Z'), 'later'),
    issue_number: 6,
    printed_at: ISSUE_SIX.printedAt,
    entry_count: 12,
    new_issue: false,
    also_printed: [5],
  })
})

test('me attention reads the Gazette pointer from the pinned window without another statement', async () => {
  const { result, database } = await readAttention(ISSUE_SIX_ROW)
  assert.deepEqual(result.gazette, {
    issueNumber: 6,
    scheduledFor: ISSUE_SIX.scheduledFor,
    printedAt: ISSUE_SIX.printedAt,
    entryCount: 12,
    newIssue: true,
    alsoPrinted: [4, 5],
  })
  assert.equal(database.calls.filter(call => call.marker === 'me-summary-window').length, 1)
  assert.match(database.calls.find(call => call.marker === 'me-summary-window')?.text ?? '', /AS gazette/u)
})

test('me attention returns a null Gazette pointer when the window has none', async () => {
  const { result } = await readAttention()
  assert.equal(result.gazette, null)
})
