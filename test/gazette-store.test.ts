import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readCompleteGazetteIssue,
  readGazetteIssue,
  readGazetteIssueFacts,
  readGazetteSubmissionRoomState,
  type GazetteQueryDatabase,
} from '../src/gazette-store.ts'

const storedIssue = Object.freeze({
  issue_number: 7,
  scheduled_for: '2026-10-12T16:00:00.000Z',
  printed_at: '2026-10-12T16:00:12.193Z',
  header: 'THE GAZETTE — ISSUE 7',
  entry_count: 201,
})

test('the reading store collects every issue page without changing ordinal order', async () => {
  const entries = Array.from({ length: 201 }, (_, index) => Object.freeze({
    ordinal: index + 1,
    note_id: 8_000 + index,
    author_id: index % 2 === 0 ? 71 : 72,
    author: index % 2 === 0 ? 'first' : 'second',
    body: `entry ${index + 1}`,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, index % 60)).toISOString(),
    withdrawn: index === 0,
    withdrawal_note_id: index === 0 ? 9_001 : null,
    withdrawn_at: index === 0 ? '2026-10-11T15:59:00.000Z' : null,
  }))
  const entryCursors: Array<number | null> = []
  const database: GazetteQueryDatabase = {
    async query(text, params = []) {
      if (text.includes('gazette:read-issue')) return [storedIssue]
      if (text.includes('gazette:read-entries')) {
        const after = params[1] as number | null
        const requested = params[2] as number
        entryCursors.push(after)
        const start = after ?? 0
        return entries.slice(start, start + requested)
      }
      throw new Error(`unexpected query: ${text}`)
    },
  }

  const result = await readCompleteGazetteIssue(database, 7)

  assert.ok(result)
  assert.equal(result.entries.length, 201)
  assert.deepEqual(result.entries.map(entry => entry.ordinal), entries.map(entry => entry.ordinal))
  assert.deepEqual(entryCursors, [null, 200])
})

test('issue #71: an entry_text_limit_bytes budget admits whole entries in ordinal order and never cuts or skips one', async () => {
  // Ten default-page 4,000-byte entries, the exact aggregate shape issue #71
  // reports for note reads, reproduced here for the Gazette entry read.
  const bigEntries = Array.from({ length: 10 }, (_, index) => ({
    ordinal: index + 1,
    note_id: 500 + index,
    author_id: 1,
    author: 'tiny-lantern',
    body: 'x'.repeat(4_000),
    created_at: '2026-10-27T00:00:00.000Z',
    withdrawn: false,
    withdrawal_note_id: null,
    withdrawn_at: null,
  }))
  const storedIssue = Object.freeze({
    issue_number: 9,
    scheduled_for: '2026-11-02T16:00:00.000Z',
    printed_at: '2026-11-02T16:00:02.000Z',
    header: 'THE GAZETTE — ISSUE 9',
    entry_count: 10,
  })
  const database: GazetteQueryDatabase = {
    async query(text) {
      if (text.includes('gazette:read-issue')) return [storedIssue]
      if (text.includes('gazette:read-entries')) return bigEntries
      throw new Error(`unexpected query: ${text}`)
    },
  }

  // No text limit: the unprotected default shape (all ten ~4,000-byte
  // bodies, ~40KB, in one response, no aggregate ceiling).
  const unbudgeted = await readGazetteIssue(database, {
    issueNumber: 9, afterOrdinal: null, limit: 10,
  })
  assert.ok(unbudgeted)
  assert.equal(unbudgeted.entries.length, 10)
  assert.equal(unbudgeted.returnedTextBytes, 40_000)
  assert.equal(unbudgeted.stoppedForTextLimit, false)

  // A budget that fits exactly two entries admits exactly two, in ordinal
  // order, and stops rather than cutting a third short.
  const budgeted = await readGazetteIssue(database, {
    issueNumber: 9, afterOrdinal: null, limit: 10, textLimitBytes: 8_000,
  })
  assert.ok(budgeted)
  assert.deepEqual(budgeted.entries.map(entry => entry.ordinal), [1, 2])
  assert.equal(budgeted.returnedTextBytes, 8_000)
  assert.equal(budgeted.hasMore, true)
  assert.equal(budgeted.stoppedForTextLimit, true)
  assert.equal(budgeted.nextAfterOrdinal, 2)
  assert.equal(budgeted.nextItemOrdinal, 3)
  assert.equal(budgeted.nextItemNoteId, 502)
  assert.equal(budgeted.nextItemTextBytes, 4_000)

  // A budget below the smallest body returns an empty page — not a picked
  // subset — and names the one oversized entry it stopped at, with a null
  // paging cursor (the caller cannot skip past it via before/after_ordinal).
  const zeroBudget = await readGazetteIssue(database, {
    issueNumber: 9, afterOrdinal: null, limit: 10, textLimitBytes: 0,
  })
  assert.ok(zeroBudget)
  assert.equal(zeroBudget.entries.length, 0)
  assert.equal(zeroBudget.hasMore, true)
  assert.equal(zeroBudget.nextAfterOrdinal, null)
  assert.equal(zeroBudget.stoppedForTextLimit, true)
  assert.equal(zeroBudget.nextItemOrdinal, 1)
  assert.equal(zeroBudget.nextItemNoteId, 500)
})

test('the public room state makes the author withdrawal gate discoverable before use', async () => {
  const queries: string[] = []
  const database: GazetteQueryDatabase = {
    async query(text) {
      queries.push(text)
      return [{ submissions_open: true, withdrawals_open: false }]
    },
  }

  assert.deepEqual(await readGazetteSubmissionRoomState(database), {
    submissionsOpen: true,
    withdrawalsOpen: false,
  })
  assert.match(queries[0]!, /gazette_withdrawals_are_open\(\)/iu)
})

test('a withdrawal notice outranks moderation and exposes immutable relation facts', async () => {
  const queries: string[] = []
  const database: GazetteQueryDatabase = {
    async query(text) {
      queries.push(text)
      if (text.includes('gazette:read-issue')) return [{ ...storedIssue, entry_count: 1 }]
      if (text.includes('gazette:read-entries')) return [{
        ordinal: 1,
        note_id: 8_001,
        author_id: 17,
        author: 'first',
        body: 'note #8001, withdrawn by its author before the tick',
        created_at: '2026-10-01T00:00:00.000Z',
        withdrawn: true,
        withdrawal_note_id: 9_001,
        withdrawn_at: '2026-10-11T15:59:00.000Z',
      }]
      throw new Error(`unexpected query: ${text}`)
    },
  }

  const result = await readCompleteGazetteIssue(database, 7)
  assert.deepEqual(result?.entries, [{
    ordinal: 1,
    note_id: 8_001,
    author_id: 17,
    author: 'first',
    body: 'note #8001, withdrawn by its author before the tick',
    created_at: '2026-10-01T00:00:00.000Z',
    withdrawn: true,
    withdrawal_note_id: 9_001,
    withdrawn_at: '2026-10-11T15:59:00.000Z',
  }])
  const entryQuery = queries.find(query => query.includes('gazette:read-entries')) ?? ''
  assert.match(entryQuery, /LEFT JOIN gazette_withdrawals withdrawal/iu)
  assert.match(
    entryQuery,
    /CASE\s+WHEN withdrawal\.target_note_id IS NOT NULL[\s\S]*WHEN moderation\.action = 'remove'/iu,
  )
})

test('Gazette share facts are body-free and count distinct residents', async () => {
  const queries: string[] = []
  const database: GazetteQueryDatabase = {
    async query(text) {
      queries.push(text)
      return [{
        issue_number: 7,
        scheduled_for: storedIssue.scheduled_for,
        printed_at: storedIssue.printed_at,
        entry_count: 201,
        resident_count: 19,
      }]
    },
  }

  const result = await readGazetteIssueFacts(database, 7)

  assert.deepEqual(result, {
    issue_number: 7,
    scheduled_for: storedIssue.scheduled_for,
    printed_at: storedIssue.printed_at,
    entry_count: 201,
    resident_count: 19,
  })
  assert.equal(queries.length, 1)
  assert.match(queries[0]!, /count\s*\(\s*distinct\s+note\.author_id\s*\)/iu)
  assert.doesNotMatch(queries[0]!, /note\.body|\bbody\b/iu)
})

test('Gazette share facts return null for an unknown issue', async () => {
  const database: GazetteQueryDatabase = { query: async () => [] }
  assert.equal(await readGazetteIssueFacts(database, 99), null)
})
