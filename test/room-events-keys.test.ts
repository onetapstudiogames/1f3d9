// One room's events read through the room keys index: what may change and what may not,
// without a database. Every other events statement keeps main's text byte for byte; the
// room statement keeps today's filter word for word and only adds the room keys; the two
// migrations are exact, ordered, and the index one alone runs outside a transaction. The
// answers themselves are compared against today's statement on real PostgreSQL in
// test/integration/room-events-keys-postgres.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  assertReviewedEventRoomKeysFunction,
  EVENTS_ROOM_KEYS_INDEX_STATEMENT,
  eventsRoomKeysIndexRecoveryStatements,
  prepareMigrationExecution,
  resolveMigrationRun,
  reviewedEventRoomKeysBody,
  splitSqlStatements,
} from '../scripts/migrate.ts'
import { EVENTS_TALLY_READER_TOTALS_SQL } from '../src/events-totals-tally.ts'
import {
  loadPublicEventCollectionRows,
  loadPublicEventKeptCollectionRows,
  loadPublicEventPageRows,
  type PublicEventFilters,
  type PublicPage,
  type PublicQueryExecutor,
} from '../src/public-pagination.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const oracle = (JSON.parse(read('test/helpers/room-events-oracle/main-af009f2.json')) as { statements: Record<string, string> }).statements
const functionFile = 'db/migrations/20261124_event_room_keys_function.sql' as const
const indexFile = 'db/migrations/20261124_events_room_keys_index.sql' as const
const functionDdl = read(functionFile)
const indexDdl = read(indexFile)

const page: PublicPage = Object.freeze({ ok: true, cursor: null, limit: 20, fetchLimit: 21 })
const base: PublicEventFilters = Object.freeze({
  kind: null, actor: null, placeId: null, includeDescendants: false, withinSeconds: null, afterId: null,
})

async function sent(load: (query: PublicQueryExecutor) => Promise<unknown>): Promise<string> {
  let text = ''
  await load(async statement => { text = statement; return [] }).catch(() => undefined)
  assert.ok(text, 'the loader sent a statement')
  return text
}

test('every events read that is not one room keeps main\'s statement byte for byte', async () => {
  const kept = (filters: PublicEventFilters) => sent(query => loadPublicEventKeptCollectionRows(query, filters, page, EVENTS_TALLY_READER_TOTALS_SQL))
  assert.equal(await sent(query => loadPublicEventCollectionRows(query, base, page)), oracle.unfilteredCounted)
  assert.equal(await sent(query => loadPublicEventPageRows(query, base, page)), oracle.unfilteredUncounted)
  assert.equal(await sent(query => loadPublicEventCollectionRows(query, { ...base, kind: 'note' }, page)), oracle.kindCounted)
  assert.equal(await sent(query => loadPublicEventCollectionRows(query, { ...base, actor: 'founder' }, page)), oracle.actorCounted)
  assert.equal(await kept(base), oracle.keptCounted)
})

test('a one room read keeps today\'s filter word for word and adds only the room keys', async () => {
  const filterOf = (statement: string): string => {
    const start = statement.indexOf('not after_id either. */')
    const end = statement.indexOf('\n     )\n     SELECT page.id', start)
    assert.ok(start > 0 && end > start, 'today\'s statement has its totals filter')
    return statement.slice(statement.indexOf('WHERE ', start) + 'WHERE '.length, end)
  }
  for (const includeDescendants of [false, true]) {
    const filters = { ...base, placeId: 3, includeDescendants }
    const mode = includeDescendants ? 'within' : 'exact'
    const todayFilter = filterOf(oracle[`${mode}Counted`]!)
    for (const statement of [
      await sent(query => loadPublicEventCollectionRows(query, filters, page)),
      await sent(query => loadPublicEventPageRows(query, filters, page)),
    ]) {
      assert.ok(statement.includes(`WHERE ${todayFilter}\n     ), totals AS (`), `${mode}: today's filter, unchanged, decides every kept event`)
      assert.equal(statement.split(todayFilter).length, 2, `${mode}: the filter runs once, over the room's candidates`)
      assert.match(statement, /public\.event_room_keys\(keyed_event\.detail\) && ARRAY\[room_key\.key\]/u)
      assert.match(statement, /room_events AS MATERIALIZED/u)
      assert.match(statement, includeDescendants ? /WITH RECURSIVE selected_places AS/u : /\(VALUES \(\$3::integer\)\) room\(id\)/u)
    }
  }
  // The kept count never answers a room read: it sends nothing and the caller counts.
  let keptSent = 0
  assert.equal(await loadPublicEventKeptCollectionRows(async () => { keptSent += 1; return [] },
    { ...base, placeId: 3 }, page, EVENTS_TALLY_READER_TOTALS_SQL), null)
  assert.equal(keptSent, 0)
})

test('the room keys function migration is transactional, exact and refuses to replace an indexed body', () => {
  const execution = prepareMigrationExecution(functionFile, functionDdl)
  assert.equal(execution.mode, 'transactional')
  assert.match(functionDdl, /CREATE OR REPLACE FUNCTION public\.event_room_keys\(detail jsonb\)\s+RETURNS text\[\]\s+LANGUAGE plpgsql\s+IMMUTABLE\s+STRICT\s+PARALLEL SAFE/u)
  assert.match(functionDdl, /never edit the key function in place/u)
  assert.doesNotMatch(functionDdl, /\b(?:DROP|ALTER TABLE|UPDATE|DELETE|TRUNCATE|CREATE INDEX)\b/u)
  const schema = read('db/schema.sql')
  const body = reviewedEventRoomKeysBody(functionDdl)
  assert.equal(reviewedEventRoomKeysBody(schema.slice(schema.indexOf('CREATE OR REPLACE FUNCTION public.event_room_keys'))), body,
    'db/schema.sql installs the same function body as the migration')
  assert.match(schema, /CREATE INDEX IF NOT EXISTS events_room_keys ON public\.events USING gin \(public\.event_room_keys\(detail\)\) WITH \(fastupdate = off\);/u)
  const production = {
    CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
    NEON_API_KEY: 'secret-neon-key',
    NEON_PROJECT_ID: 'project-one',
    NEON_PRODUCTION_BRANCH_ID: 'branch-production',
    PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    PRODUCTION_SNAPSHOT_NAME: 'pre-room-keys',
  } as const
  const functionRun = resolveMigrationRun(['--target', 'production', '--migration', 'event-room-keys-function'], production)
  assert.equal(functionRun.migrationFile, functionFile)
  assert.equal(functionRun.executionMode, 'transactional')
  const indexRun = resolveMigrationRun(['--target', 'production', '--migration', 'events-room-keys-index'], production)
  assert.equal(indexRun.migrationFile, indexFile)
  assert.equal(indexRun.executionMode, 'nontransactional')
})

test('only the exact room keys index statement may run outside a transaction', () => {
  const statements = splitSqlStatements(indexDdl).map(statement => statement.replace(/^\s*--.*$/gmu, '').replace(/\s+/gu, ' ').trim()).filter(Boolean)
  assert.deepEqual(statements, [EVENTS_ROOM_KEYS_INDEX_STATEMENT])
  const execution = prepareMigrationExecution(indexFile, indexDdl)
  assert.equal(execution.mode, 'nontransactional')
  assert.equal(execution.statements.length, 1)
  assert.throws(() => prepareMigrationExecution(indexFile, 'CREATE INDEX CONCURRENTLY IF NOT EXISTS events_room_keys ON public.events USING gin (public.event_room_keys(detail));'),
    /does not match the reviewed concurrent-index statement/u)
  assert.throws(() => prepareMigrationExecution(functionFile, indexDdl), /allowlisted nontransactional migration/u)
})

test('the index is built only over the reviewed function and repaired only when a build failed', () => {
  const body = reviewedEventRoomKeysBody(functionDdl)
  const reviewed = { volatility: 'i', parallel: 's', strict: true, result_type: 'text[]', body }
  assert.doesNotThrow(() => assertReviewedEventRoomKeysFunction([reviewed], body))
  assert.throws(() => assertReviewedEventRoomKeysFunction([], body), /run the event-room-keys-function migration first/u)
  assert.throws(() => assertReviewedEventRoomKeysFunction([{ ...reviewed, volatility: 's' }], body), /must be immutable/u)
  assert.throws(() => assertReviewedEventRoomKeysFunction([{ ...reviewed, parallel: 'u' }], body), /must be immutable/u)
  assert.throws(() => assertReviewedEventRoomKeysFunction([{ ...reviewed, body: `${body} ` }], body), /reviewed function body/u)
  const exact = {
    index_name: 'events_room_keys', table_name: 'events', valid: true, ready: true,
    definition: 'CREATE INDEX events_room_keys ON public.events USING gin (event_room_keys(detail)) WITH (fastupdate=off)',
  }
  const create = EVENTS_ROOM_KEYS_INDEX_STATEMENT
  assert.deepEqual(eventsRoomKeysIndexRecoveryStatements([], create), [create])
  assert.deepEqual(eventsRoomKeysIndexRecoveryStatements([exact], create), [])
  assert.deepEqual(eventsRoomKeysIndexRecoveryStatements([{ ...exact, definition: exact.definition.replace('(event_room', '(public.event_room') }], create), [])
  assert.deepEqual(eventsRoomKeysIndexRecoveryStatements([{ ...exact, valid: false }], create),
    ['DROP INDEX CONCURRENTLY IF EXISTS public.events_room_keys', create])
  for (const other of [
    { ...exact, definition: exact.definition.replace('fastupdate=off', 'fastupdate=on') },
    { ...exact, definition: 'CREATE INDEX events_room_keys ON public.events USING btree (id)' },
    { ...exact, table_name: 'notes' },
  ]) {
    assert.throws(() => eventsRoomKeysIndexRecoveryStatements([other], create), /conflicts with the reviewed definition/u)
  }
})
