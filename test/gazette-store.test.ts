import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readCompleteGazetteIssue,
  readGazetteIssueFacts,
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
    author: index % 2 === 0 ? 'first' : 'second',
    body: `entry ${index + 1}`,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, index % 60)).toISOString(),
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
