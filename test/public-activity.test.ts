import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PUBLIC_EVENT_KINDS } from '../src/public-events.ts'

test('stored activity computes only the four bands and omits unknown or future history', async () => {
  const { publicActivitySql, publicActivityFields } = await import('../src/public-activity.ts')
  const sql = publicActivitySql('resident', true)
  for (const band of ['active now', 'today', 'this week', 'longer']) {
    assert.deepEqual(publicActivityFields(band), { last_active: band })
  }
  for (const value of [null, undefined, '', 'off', 'unavailable', 'tomorrow']) {
    assert.deepEqual(publicActivityFields(value), {})
  }
  assert.match(sql, /WHEN NOT resident\.show_activity THEN NULL/u)
  assert.match(sql, /last_public_action_at IS NULL THEN NULL/u)
  assert.match(sql, /last_public_action_at > statement_timestamp\(\) THEN NULL/u)
  for (const boundary of ['1 hour', '24 hours', '7 days']) assert.ok(sql.includes(boundary))
  assert.doesNotMatch(sql, />=/u, 'exact boundaries use the older band')
  assert.doesNotMatch(sql, /\b(?:JOIN|events|resident_settings)\b/u)
  assert.doesNotMatch(publicActivitySql('p', false), /show_activity/u)
})

test('every public kind is classified in the sole stored-summary writer', async () => {
  const migration = await readFile(new URL('../db/migrations/20261028_stored_public_activity.sql', import.meta.url), 'utf8')
  const classifier = migration.match(/CREATE OR REPLACE FUNCTION public_activity_candidates\([\s\S]+?(?=CREATE OR REPLACE FUNCTION|$)/u)?.[0]
  const potential = migration.match(/CREATE OR REPLACE FUNCTION public_activity_potential_kind\([\s\S]+?(?=CREATE OR REPLACE FUNCTION|$)/u)?.[0]
  assert.ok(classifier, 'the migration must own one explicit event classifier')
  assert.ok(potential)
  assert.match(classifier, /public_activity_potential_kind\(event_kind\)/u)
  for (const kind of PUBLIC_EVENT_KINDS) {
    assert.ok(`${potential}${classifier}`.includes(`'${kind}'`), `${kind} has no activity decision`)
  }
  assert.match(classifier, /applied_public_activity/u)
  assert.match(classifier, /room_settled/u)
  assert.match(classifier, /chance_rolled/u)
  assert.match(classifier, /copy_skipped/u)
})

test('wake work has its own committed public carrier', async () => {
  const { PUBLIC_EVENT_KIND_DETAIL_FIELDS } = await import('../src/public-events.ts')
  assert.ok(PUBLIC_EVENT_KINDS.includes('wake_try_applied'))
  for (const field of ['settle_id', 'reason', 'unit_index']) {
    assert.ok(PUBLIC_EVENT_KIND_DETAIL_FIELDS.wake_try_applied?.includes(field))
  }
})
