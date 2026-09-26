import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PUBLIC_EVENT_KINDS } from '../src/public-events.ts'
import { splitSqlStatements } from '../scripts/migrate.ts'
import { WINDOW_JS } from '../src/window-client.ts'

const [schema, migration] = await Promise.all([
  readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'),
  readFile(new URL('../db/migrations/20260924_same_room_talk.sql', import.meta.url), 'utf8'),
])
const talkStores = await Promise.all([
  readFile(new URL('../src/room-line-store.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/room-ping-store.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/room-receipt-store.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/room-talk-reads.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/room-wait-store.ts', import.meta.url), 'utf8'),
])
const roomTalkRoutes = await readFile(new URL('../src/room-talk-routes.ts', import.meta.url), 'utf8')

const migrationStatements = splitSqlStatements(migration).map(statement => (
  statement.replace(/^\s*--.*$/gmu, '').trim()
))

const additiveStatementStarts = [
  /^DO\s+\$/iu,
  /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/iu,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/iu,
  /^CREATE\s+OR\s+REPLACE\s+FUNCTION\b/iu,
  /^DROP\s+TRIGGER\s+IF\s+EXISTS\b/iu,
  /^CREATE\s+TRIGGER\b/iu,
  /^CREATE\s+OR\s+REPLACE\s+VIEW\s+city_snapshot\.public_records_v3\b/iu,
  /^REVOKE\s+ALL\s+ON\s+city_snapshot\.public_records_v3\s+FROM\s+PUBLIC\b/iu,
  /^GRANT\s+SELECT\s+ON\s+city_snapshot\.public_records_v3\s+TO\s+city_snapshot_export\b/iu,
]

const talkEventKinds = new Set(['line_said', 'ping_sent', 'ping_answered'])

test('the same-room-talk migration closes the fresh schema byte for byte', () => {
  assert.equal(schema.endsWith(migration), true)
  assert.match(migration, /[^\n]\n$/u, 'migration ends with exactly one LF')
})

test('every same-room-talk statement is additive and repeatable', () => {
  assert.ok(migrationStatements.length > 0)
  for (const statement of migrationStatements) {
    assert.ok(
      additiveStatementStarts.some(pattern => pattern.test(statement)),
      `unexpected migration statement: ${statement.slice(0, 120)}`,
    )
    assert.doesNotMatch(statement, /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/iu)
    assert.doesNotMatch(statement, /\bDROP\s+(?:TABLE|COLUMN|INDEX|FUNCTION|VIEW|SEQUENCE)\b/iu)
  }
})

test("the fresh schema's moderation and flag target checks already allow line and ping", () => {
  const migrationStart = schema.length - migration.length
  const freshSchema = schema.slice(0, migrationStart)
  const occurrences = freshSchema.match(/'agreement', 'line', 'ping'/gu) ?? []
  assert.equal(occurrences.length, 3)
})

test('snapshot v3 reads no private talk table, request_id, or arrival mark', () => {
  const viewStart = migration.indexOf('CREATE OR REPLACE VIEW city_snapshot.public_records_v3')
  const revokeStart = migration.indexOf(
    'REVOKE ALL ON city_snapshot.public_records_v3',
    viewStart,
  )
  assert.notEqual(viewStart, -1)
  assert.notEqual(revokeStart, -1)
  const view = migration.slice(viewStart, revokeStart)

  assert.doesNotMatch(
    view,
    /\b(?:FROM|JOIN)\s+public\.(?:ping_receipts|ping_operations|wait_leases|line_quota|line_minute_quota)\b/iu,
  )
  assert.doesNotMatch(view, /request_id/iu)
  assert.doesNotMatch(view, /arrived_at/iu)
})

test('the change feed carries talk events, and Happenings, the replay file, and front-door activity leave them out', async () => {
  const { HUMAN_VIEW_EVENT_KINDS, HUMAN_VIEW_EVENT_LABELS } = await import('../src/public-events.ts')
  assert.deepEqual(PUBLIC_EVENT_KINDS.filter(kind => talkEventKinds.has(kind)), [...talkEventKinds])
  assert.deepEqual(HUMAN_VIEW_EVENT_KINDS.filter(kind => talkEventKinds.has(kind)), [])
  assert.deepEqual(Object.keys(HUMAN_VIEW_EVENT_LABELS).filter(kind => talkEventKinds.has(kind)), [])
})

test('the window program has no talk event label; lines reach humans through Talk', () => {
  assert.doesNotMatch(WINDOW_JS, /"line_said"|said a line/u)
})

test('talk stores never settle or wake a room, and only the contract names an error', () => {
  for (const source of talkStores) {
    assert.doesNotMatch(source, /(?:engine-settle|wake-guard|note-action)\.ts/u)
    assert.doesNotMatch(source, /\brunAction\b/u)
    assert.doesNotMatch(source, /error:/u)
  }
})

test('the talk routes read bodies only through text, json, or arrayBuffer', () => {
  assert.doesNotMatch(roomTalkRoutes, /raw\.(?:body|signal)|\.clone\(|\.formData\(|parseBody\(/u)
})
