import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  applyMigration,
  splitSqlStatements,
  type MigrationFile,
} from '../../scripts/migrate.ts'
import {
  loadPublicSearchResults,
  parsePublicSearchQuery,
  type PublicSearchMode,
  type PublicSearchQuery,
  type PublicSearchResults,
  type PublicSearchType,
} from '../../src/public-search.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'public_search_index_integration'
const MIGRATION_URL = new URL(
  '../../db/migrations/20260821_public_search_indexes.sql',
  import.meta.url,
)
const MIGRATION_FILE = 'db/migrations/20260821_public_search_indexes.sql' as MigrationFile
const INDEX_NAMES = Object.freeze({
  noteWords: 'notes_public_search_words',
  notePhrase: 'notes_public_search_phrase',
  thingWords: 'things_public_search_words_active',
  thingPhrase: 'things_public_search_phrase_active',
  placeName: 'place_name_history_name_search',
})

interface PostgresInstance {
  readonly client: Pool
  readonly containerName: string
  readonly databaseUrl: string
}

interface SearchRun {
  readonly result: PublicSearchResults
  readonly sql: string
  readonly values: readonly unknown[]
}

interface PlanNode {
  readonly 'Node Type'?: string
  readonly 'Relation Name'?: string
  readonly 'Index Name'?: string
  readonly Plans?: readonly PlanNode[]
}

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<PostgresInstance> {
  const containerName = `1f3d9-search-index-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])

  try {
    const portOutput = runDocker(['port', containerName, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      const client = new Pool({
        host: '127.0.0.1', port, user: 'postgres', password,
        database: POSTGRES_DATABASE, ssl: false,
      })
      try {
        await client.query('SELECT 1')
        return {
          client,
          containerName,
          databaseUrl: `postgresql://postgres:${password}@127.0.0.1:${port}/${POSTGRES_DATABASE}`,
        }
      } catch (error) {
        lastError = error
        await client.end().catch(() => undefined)
        await delay(200)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

function searchQuery(
  q: string,
  mode: PublicSearchMode,
  type: PublicSearchType,
  limit = 10,
  before: string | null = null,
  maker: string | null = null,
): PublicSearchQuery {
  const parsed = parsePublicSearchQuery({
    q: [q], mode: [mode], type: [type], limit: [String(limit)],
    ...(before === null ? {} : { before: [before] }),
    ...(maker === null ? {} : { maker: [maker] }),
  })
  if (!parsed.ok) assert.fail(parsed.error)
  return parsed
}

async function runSearch(client: Pool, query: PublicSearchQuery): Promise<SearchRun> {
  let capturedSql = ''
  let capturedValues: readonly unknown[] = []
  const result = await loadPublicSearchResults(async (sql, values) => {
    capturedSql = sql
    capturedValues = values
    return (await client.query(sql, [...values])).rows as Record<string, unknown>[]
  }, query)
  assert.ok(capturedSql, 'search did not issue SQL')
  return Object.freeze({ result, sql: capturedSql, values: capturedValues })
}

function flattenPlan(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(flattenPlan)]
}

async function explain(client: Pool, search: SearchRun): Promise<PlanNode[]> {
  const explained = await client.query<{ 'QUERY PLAN': readonly [{ Plan: PlanNode }] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${search.sql}`,
    [...search.values],
  )
  const plan = explained.rows[0]?.['QUERY PLAN']?.[0]?.Plan
  assert.ok(plan, 'PostgreSQL returned no search plan')
  return flattenPlan(plan)
}

function assertUsesIndexWithoutSourceWalk(
  nodes: readonly PlanNode[],
  table: 'notes' | 'things' | 'place_name_history',
  indexName: string,
): void {
  assert.ok(
    nodes.some(node => node['Index Name'] === indexName),
    `selective ${table} search did not use ${indexName}`,
  )
  assert.equal(
    nodes.some(node => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === table),
    false,
    `selective search walked every ${table} row`,
  )
}

async function indexState(client: Pool, name: string): Promise<Readonly<{
  oid: number
  valid: boolean
  ready: boolean
}>> {
  const state = await client.query<{
    oid: number
    valid: boolean
    ready: boolean
  }>(`
    SELECT index_relation.oid::integer AS oid,
      index_catalog.indisvalid AS valid,
      index_catalog.indisready AS ready
    FROM pg_class index_relation
    JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
    JOIN pg_index index_catalog ON index_catalog.indexrelid = index_relation.oid
    WHERE namespace.nspname = 'public' AND index_relation.relname = $1
  `, [name])
  assert.equal(state.rows.length, 1, `${name} is missing or ambiguous`)
  return Object.freeze(state.rows[0]!)
}

async function leaveInterruptedIndex(
  client: Pool,
  indexName: string,
  createStatement: string,
  table: 'notes' | 'place_name_history' = 'notes',
): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS public.${indexName}`)
  const blocker = await client.connect()
  const builder = await client.connect()
  try {
    await blocker.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await blocker.query(`SELECT count(*) FROM ${table}`)
    const pid = Number((await builder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
    const build = builder.query(createStatement).then(
      () => Object.freeze({ ok: true as const, error: null }),
      error => Object.freeze({ ok: false as const, error }),
    )
    const deadline = Date.now() + 15_000
    let interrupted = false
    while (Date.now() < deadline) {
      const state = await client.query<{ valid: boolean }>(`
        SELECT index_catalog.indisvalid AS valid
        FROM pg_class index_relation
        JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
        JOIN pg_index index_catalog ON index_catalog.indexrelid = index_relation.oid
        WHERE namespace.nspname = 'public' AND index_relation.relname = $1
      `, [indexName])
      if (state.rows[0]?.valid === false) {
        await client.query('SELECT pg_cancel_backend($1)', [pid])
        interrupted = true
        break
      }
      await delay(25)
    }
    if (!interrupted) await client.query('SELECT pg_cancel_backend($1)', [pid])
    const outcome = await build
    assert.equal(interrupted, true, `could not interrupt ${indexName} in its retryable state`)
    assert.equal(outcome.ok, false, `${indexName} build unexpectedly completed`)
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined)
    blocker.release()
    builder.release()
  }
  const interrupted = await indexState(client, indexName)
  assert.equal(interrupted.valid && interrupted.ready, false, `${indexName} was not left retryable`)
}

test('large public searches use maintained indexes without changing archive truth', async t => {
  assert.equal(
    existsSync(MIGRATION_URL),
    true,
    'add db/migrations/20260821_public_search_indexes.sql before running the PostgreSQL gate',
  )
  const postgres = await startPostgres()
  try {
    const [schema, migration] = await Promise.all([
      readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'),
      readFile(MIGRATION_URL, 'utf8'),
    ])
    await postgres.client.query(schema)
    await postgres.client.query(`
      INSERT INTO residents (id, handle, model, secret_hash) VALUES
        (1, 'maintainer', 'search-index-test', repeat('1', 64)),
        (2, 'archivist', 'search-index-test', repeat('2', 64)),
        (3, 'other-maker', 'search-index-test', repeat('3', 64))
    `)
    const world = Number((await postgres.client.query<{ id: number }>(
      `SELECT id FROM places WHERE place_kind = 'world'`,
    )).rows[0]!.id)
    const continent = Number((await postgres.client.query<{ id: number }>(
      `INSERT INTO places (parent_id, place_kind, name, owner_id)
       VALUES ($1, 'continent', 'Search Index Continent', 1) RETURNING id`,
      [world],
    )).rows[0]!.id)
    const place = Number((await postgres.client.query<{ id: number }>(
      `INSERT INTO places (parent_id, place_kind, name, owner_id)
       VALUES ($1, 'place', 'Search Index Archive', 1) RETURNING id`,
      [continent],
    )).rows[0]!.id)

    await postgres.client.query(`
      INSERT INTO notes (place_id, author_id, body, created_at)
      SELECT $1, 2, 'ordinary archive note ' || item_number,
        '2026-01-01T00:00:00Z'::timestamptz + item_number * interval '1 millisecond'
      FROM generate_series(1, 30000) AS item_number
    `, [place])
    await postgres.client.query(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
      SELECT $1, 'ordinary archive thing ' || item_number,
        'ordinary object body ' || item_number, 2, 2,
        '2026-01-02T00:00:00Z'::timestamptz + item_number * interval '1 millisecond'
      FROM generate_series(1, 30000) AS item_number
    `, [place])

    const notes = await postgres.client.query<{ id: number; body: string }>(`
      INSERT INTO notes (place_id, author_id, body, created_at) VALUES
        ($1, 2, 'rareindexproof oldest note', '2026-02-01T00:00:01Z'),
        ($1, 2, 'rareindexproof newest note', '2026-02-01T00:00:05Z'),
        ($1, 2, 'rareindexproof restored note', '2026-02-01T00:00:04Z'),
        ($1, 2, 'rareindexproof removed note', '2026-02-01T00:00:06Z'),
        ($1, 2, 'A literal 100%_archive phrase appears.', '2026-02-02T00:00:02Z'),
        ($1, 2, 'A literal 100XXarchive phrase appears.', '2026-02-02T00:00:01Z')
      RETURNING id, body
    `, [place])
    const noteId = (body: string) => {
      const id = notes.rows.find(row => row.body === body)?.id
      assert.ok(id, `missing seeded note: ${body}`)
      return id
    }
    await postgres.client.query(`
      INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason, created_at)
      VALUES
        ('note', $1, 'remove', 1, 'integration test', '2026-02-03T00:00:01Z'),
        ('note', $2, 'remove', 1, 'integration test', '2026-02-03T00:00:02Z'),
        ('note', $2, 'restore', 1, 'integration test', '2026-02-03T00:00:03Z')
    `, [
      noteId('rareindexproof removed note'),
      noteId('rareindexproof restored note'),
    ])

    const things = await postgres.client.query<{ id: number; name: string; body: string }>(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at, withdrawn_at) VALUES
        ($1, 'Rareindexproof Lantern', 'visible thing body', 2, 2, '2026-02-01T00:00:03Z', NULL),
        ($1, 'Rareindexproof Withdrawn', 'withdrawn thing body', 2, 2,
          '2026-02-01T00:00:07Z', '2026-02-04T00:00:00Z'),
        ($1, 'Rareindexproof Removed', 'removed thing body', 2, 2, '2026-02-01T00:00:08Z', NULL),
        ($1, 'Phrase Vessel', 'literal 100%_archive phrase', 2, 2, '2026-02-02T00:00:04Z', NULL),
        ($1, 'Near Phrase Vessel', 'literal 100XXarchive phrase', 2, 2, '2026-02-02T00:00:03Z', NULL)
      RETURNING id, name, body
    `, [place])
    const thingId = (name: string) => {
      const id = things.rows.find(row => row.name === name)?.id
      assert.ok(id, `missing seeded thing: ${name}`)
      return id
    }
    await postgres.client.query(`
      INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason, created_at)
      VALUES ('thing', $1, 'remove', 1, 'integration test', '2026-02-03T00:00:04Z')
    `, [thingId('Rareindexproof Removed')])
    await postgres.client.query('ANALYZE notes')
    await postgres.client.query('ANALYZE things')
    await postgres.client.query('ANALYZE moderation_actions')

    await postgres.client.query(`
      INSERT INTO notes (place_id, author_id, body, created_at) VALUES
        ($1, 2, 'makerfilterproof note', '2026-02-07T00:00:03Z')
    `, [place])
    await postgres.client.query(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at) VALUES
        ($1, 'Makerfilterproof Archivist', 'archivist body', 2, 2, '2026-02-07T00:00:02Z'),
        ($1, 'Makerfilterproof Other', 'other body', 3, 3, '2026-02-07T00:00:01Z')
    `, [place])
    await postgres.client.query(`
      UPDATE things SET owner_id = 1
      WHERE name IN ('Makerfilterproof Archivist', 'Makerfilterproof Other')
    `)
    await postgres.client.query('ANALYZE notes')
    await postgres.client.query('ANALYZE things')

    await t.test('the migration is idempotent and retries an interrupted concurrent build', async () => {
      await postgres.client.query(`
        DROP INDEX public.notes_public_search_words,
          public.notes_public_search_phrase,
          public.things_public_search_words_active,
          public.things_public_search_phrase_active,
          public.place_name_history_name_search;
        DROP EXTENSION pg_trgm;
      `)
      const absent = await postgres.client.query<{ indexes: string; extensions: string }>(`
        SELECT
          (SELECT count(*)::text
           FROM pg_class index_relation
           JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
           WHERE namespace.nspname = 'public'
             AND index_relation.relname = ANY($1::text[])) AS indexes,
          (SELECT count(*)::text FROM pg_extension WHERE extname = 'pg_trgm') AS extensions
      `, [Object.values(INDEX_NAMES)])
      assert.deepEqual(absent.rows[0], { indexes: '0', extensions: '0' })

      await applyMigration(postgres.databaseUrl, MIGRATION_FILE, migration)
      const created = new Map<string, number>()
      for (const name of Object.values(INDEX_NAMES)) {
        created.set(name, (await indexState(postgres.client, name)).oid)
      }
      await applyMigration(postgres.databaseUrl, MIGRATION_FILE, migration)
      for (const [name, oid] of created) assert.equal((await indexState(postgres.client, name)).oid, oid)

      const createNoteWords = splitSqlStatements(migration).find(statement => (
        new RegExp(`CREATE\\s+INDEX\\s+CONCURRENTLY[\\s\\S]*\\b${INDEX_NAMES.noteWords}\\b`, 'iu')
          .test(statement)
      ))
      assert.ok(createNoteWords, `${INDEX_NAMES.noteWords} concurrent statement is missing`)
      await leaveInterruptedIndex(postgres.client, INDEX_NAMES.noteWords, createNoteWords)
      await applyMigration(postgres.databaseUrl, MIGRATION_FILE, migration)
      const recovered = await indexState(postgres.client, INDEX_NAMES.noteWords)
      assert.equal(recovered.valid, true)
      assert.equal(recovered.ready, true)
      const recoveredOid = recovered.oid
      await applyMigration(postgres.databaseUrl, MIGRATION_FILE, migration)
      assert.equal((await indexState(postgres.client, INDEX_NAMES.noteWords)).oid, recoveredOid)

      const createPlaceNames = splitSqlStatements(migration).find(statement => (
        new RegExp(`CREATE\\s+INDEX\\s+CONCURRENTLY[\\s\\S]*\\b${INDEX_NAMES.placeName}\\b`, 'iu')
          .test(statement)
      ))
      assert.ok(createPlaceNames, `${INDEX_NAMES.placeName} concurrent statement is missing`)
      await leaveInterruptedIndex(
        postgres.client,
        INDEX_NAMES.placeName,
        createPlaceNames,
        'place_name_history',
      )
      await applyMigration(postgres.databaseUrl, MIGRATION_FILE, migration)
      const recoveredPlaceNames = await indexState(postgres.client, INDEX_NAMES.placeName)
      assert.equal(recoveredPlaceNames.valid, true)
      assert.equal(recoveredPlaceNames.ready, true)
      const recoveredPlaceOid = recoveredPlaceNames.oid
      await applyMigration(postgres.databaseUrl, MIGRATION_FILE, migration)
      assert.equal(
        (await indexState(postgres.client, INDEX_NAMES.placeName)).oid,
        recoveredPlaceOid,
      )
    })

    await t.test('selective word and literal-phrase searches use all maintained indexes', async () => {
      for (const [query, table, indexName] of [
        [searchQuery('rareindexproof', 'words', 'note'), 'notes', INDEX_NAMES.noteWords],
        [searchQuery('rareindexproof', 'words', 'thing'), 'things', INDEX_NAMES.thingWords],
        [searchQuery('literal 100%_archive phrase', 'phrase', 'note'), 'notes', INDEX_NAMES.notePhrase],
        [searchQuery('literal 100%_archive phrase', 'phrase', 'thing'), 'things', INDEX_NAMES.thingPhrase],
      ] as const) {
        const run = await runSearch(postgres.client, query)
        assertUsesIndexWithoutSourceWalk(await explain(postgres.client, run), table, indexName)
      }

      await postgres.client.query(`
        SELECT setval(
          pg_get_serial_sequence('places', 'id')::regclass,
          GREATEST((SELECT max(id) FROM places), 454),
          true
        )
      `)
      await postgres.client.query(`
        INSERT INTO places (parent_id, place_kind, name, owner_id, created_at)
        SELECT $1, 'place', 'ordinary former place ' || item_number, 1,
          '2026-01-03T00:00:00Z'::timestamptz + item_number * interval '1 millisecond'
        FROM generate_series(1, 30000) AS item_number
      `, [continent])
      const renameEvent = Number((await postgres.client.query<{ id: number }>(`
        INSERT INTO events (kind, actor, detail, at)
        VALUES ('place_renamed', 'maintainer', jsonb_build_object(
          'place_id', $1::integer, 'name', 'Search Index Archive',
          'former_name', 'rareformerplaceproof'
        ), '2026-02-08T00:00:00Z')
        RETURNING id
      `, [place])).rows[0]!.id)
      await postgres.client.query(`
        INSERT INTO place_name_history (place_id, name, started_at, event_id)
        VALUES ($1, 'rareformerplaceproof', '2026-02-08T00:00:00Z', $2)
      `, [place, renameEvent])
      await postgres.client.query('ANALYZE place_name_history')
      const formerPlace = await runSearch(
        postgres.client,
        searchQuery('rareformerplaceproof', 'phrase', 'place'),
      )
      assertUsesIndexWithoutSourceWalk(
        await explain(postgres.client, formerPlace),
        'place_name_history',
        INDEX_NAMES.placeName,
      )

      const literal = (await runSearch(
        postgres.client,
        searchQuery('literal 100%_archive phrase', 'phrase', 'all'),
      )).result
      assert.equal(literal.totalItems, 2, 'percent and underscore must stay literal')
      assert.equal(literal.items.length, 2)
    })

    await t.test('exact totals, chronological pages, moderation, and automatic updates stay true', async () => {
      const first = (await runSearch(
        postgres.client,
        searchQuery('rareindexproof', 'words', 'all', 2),
      )).result
      const expectedBodies = [
        'rareindexproof oldest note',
        'rareindexproof newest note',
        'rareindexproof restored note',
        'visible thing body',
      ]
      assert.equal(first.totalItems, 4)
      assert.equal(
        first.totalBodyBytes,
        expectedBodies.reduce((total, body) => total + Buffer.byteLength(body), 0),
      )
      assert.equal(first.items.length, 2)
      assert.equal(first.hasMore, true)
      assert.ok(first.nextBefore)

      const second = (await runSearch(
        postgres.client,
        searchQuery('rareindexproof', 'words', 'all', 2, first.nextBefore),
      )).result
      assert.equal(second.totalItems, first.totalItems)
      assert.equal(second.totalBodyBytes, first.totalBodyBytes)
      assert.equal(second.items.length, 2)
      assert.equal(second.hasMore, false)
      assert.deepEqual(
        [...first.items, ...second.items].map(item => `${item.type}:${item.id}`),
        [
          `note:${noteId('rareindexproof newest note')}`,
          `note:${noteId('rareindexproof restored note')}`,
          `thing:${thingId('Rareindexproof Lantern')}`,
          `note:${noteId('rareindexproof oldest note')}`,
        ],
      )

      const inserted = await postgres.client.query<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
        VALUES ($1, 'Autoupdateproof Beacon', 'new indexed body', 2, 2, '2026-02-05T00:00:00Z')
        RETURNING id
      `, [place])
      const active = (await runSearch(
        postgres.client,
        searchQuery('autoupdateproof', 'words', 'thing'),
      )).result
      assert.equal(active.totalItems, 1, 'a new thing must enter the search index automatically')
      await postgres.client.query(
        `UPDATE things SET withdrawn_at = '2026-02-06T00:00:00Z' WHERE id = $1`,
        [inserted.rows[0]!.id],
      )
      const withdrawn = (await runSearch(
        postgres.client,
        searchQuery('autoupdateproof', 'words', 'thing'),
      )).result
      assert.equal(withdrawn.totalItems, 0, 'a withdrawn thing must leave the active index automatically')
    })

    await t.test('maker narrows exact totals to active things by permanent maker', async () => {
      const archivist = (await runSearch(
        postgres.client,
        searchQuery('makerfilterproof', 'words', 'all', 10, null, 'archivist'),
      )).result
      assert.equal(archivist.totalItems, 1)
      assert.equal(archivist.totalBodyBytes, Buffer.byteLength('archivist body'))
      assert.deepEqual(archivist.items.map(item => [item.type, item.made_by]), [
        ['thing', 'archivist'],
      ])

      const other = (await runSearch(
        postgres.client,
        searchQuery('makerfilterproof', 'words', 'thing', 10, null, 'other-maker'),
      )).result
      assert.equal(other.totalItems, 1)
      assert.deepEqual(other.items.map(item => [item.type, item.made_by]), [
        ['thing', 'other-maker'],
      ])
    })
  } finally {
    await postgres.client.end().catch(() => undefined)
    runDocker(['stop', '--time', '0', postgres.containerName])
  }
})
