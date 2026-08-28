import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Hono } from 'hono'
import { Pool } from 'pg'
import {
  applyMigration,
  EVENTS_PRESENCE_INDEX_STATE_QUERY,
} from '../../scripts/migrate.ts'

import {
  eventDetailTextBytes,
  finalizePublicPage,
  loadPublicEventCollectionRows,
  loadPublicEventRows,
  loadPublicPlaceCollectionRows,
  parsePublicPage,
  type PublicPage,
  type PublicPlacePageRequests,
  type PublicQueryExecutor,
} from '../../src/public-pagination.ts'
import {
  loadPublicChanges,
  parsePublicChangeQuery,
} from '../../src/public-changes.ts'
import {
  loadPublicSearchResults,
  parsePublicSearchQuery,
} from '../../src/public-search.ts'

type WindowModule = typeof import('../../src/window.ts')

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'public_pagination_integration'
const SMALL_ROOM_RECORDS = Object.freeze({
  childDescription: 'A short child room. 🏙',
  thingBody: 'A short ordinary thing. 🏙',
  noteBody: 'A short ordinary note. 🏙',
})
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const affordableReadingMigration = await readFile(
  new URL('../../db/migrations/20260820_affordable_reading_totals.sql', import.meta.url),
  'utf8',
)
const eventsPresenceIndexMigration = await readFile(
  new URL('../../db/migrations/20260821_events_presence_index.sql', import.meta.url),
  'utf8',
)
const publicChangeMarkersMigration = await readFile(
  new URL('../../db/migrations/20260821_public_change_markers.sql', import.meta.url),
  'utf8',
)

let database: Pool | null = null
let statementCount = 0

function connectedDatabase(): Pool {
  assert.ok(database, 'the PostgreSQL test client must be connected before a public read runs')
  return database
}

const sqlTag = async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  const text = strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
  statementCount += 1
  return (await connectedDatabase().query(text, [...values])).rows as Record<string, unknown>[]
}

const sql = Object.assign(sqlTag, {
  query: async (
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> => {
      statementCount += 1
      return (await connectedDatabase().query(text, [...values])).rows as Record<string, unknown>[]
    },
  transaction: async (
    build: (transaction: { query: (text: string, values?: readonly unknown[]) => unknown }) => readonly unknown[],
  ) => {
    const statements: Array<{ text: string; values: readonly unknown[] }> = []
    const transaction = {
      query: (text: string, values: readonly unknown[] = []) => {
        const statement = { text, values }
        statements.push(statement)
        return statement
      },
    }
    build(transaction)
    const client = await connectedDatabase().connect()
    try {
      await client.query('BEGIN READ ONLY')
      const results: Record<string, unknown>[][] = []
      for (const statement of statements) {
        statementCount += 1
        results.push((await client.query(statement.text, [...statement.values])).rows)
      }
      await client.query('COMMIT')
      return results
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  },
})

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: {
    sql,
    runtimeDatabaseUrl: () => 'postgresql://integration-test.invalid/public-pagination',
  },
})

interface SeededCity {
  worldPlaceId: number
  mapBranchPlaceId: number
  targetPlaceId: number
  noteHeavyPlaceId: number
  childHeavyPlaceId: number
  smallPlaceId: number
  placeCount: number
  residentCount: number
  expected: Readonly<{
    events: readonly number[]
    worldSubplaces: readonly number[]
    mapSubplaces: readonly number[]
    subplaces: readonly number[]
    things: readonly number[]
    notes: readonly number[]
    allNotes: readonly number[]
  }>
}

interface PostgresInstance {
  client: Pool
  containerName: string
  databaseUrl: string
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
  const containerName = `1f3d9-public-pagination-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)

    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      const client = new Pool({
        host: '127.0.0.1',
        port,
        user: 'postgres',
        password,
        database: POSTGRES_DATABASE,
        ssl: false,
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

function page(cursor: number | null = null, limit: number | null = null): PublicPage {
  const parsed = parsePublicPage(
    {
      ...(cursor === null ? {} : { before_id: [String(cursor)] }),
      ...(limit === null ? {} : { limit: [String(limit)] }),
    },
    'before_id',
    'limit',
  )
  assert.equal(parsed.ok, true)
  return parsed as PublicPage
}

const executePublicQuery: PublicQueryExecutor = async (text, values) => {
  statementCount += 1
  return (await connectedDatabase().query(text, [...values])).rows as Record<string, unknown>[]
}

async function seedCity(client: Pool): Promise<SeededCity> {
  await client.query(schemaDdl)
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    SELECT resident_id,
      'resident-' || resident_id,
      'pagination-integration',
      lpad(to_hex(resident_id), 64, '0')
    FROM generate_series(1, 2006) AS resident_id
    WHERE resident_id <> 4
  `)

  const world = await client.query<{ id: number }>(
    `SELECT id FROM places WHERE place_kind = 'world'`,
  )
  const continent = await client.query<{ id: number }>(
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     VALUES ($1, 'continent', 'Pagination Continent', 1)
     RETURNING id`,
    [world.rows[0]!.id],
  )
  await client.query(
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     SELECT $1, 'continent', 'Window Continent ' || continent_number, 1
     FROM generate_series(1, 25) AS continent_number`,
    [world.rows[0]!.id],
  )
  const target = await client.query<{ id: number }>(
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     VALUES ($1, 'place', 'Pagination Room', 1)
     RETURNING id`,
    [continent.rows[0]!.id],
  )
  const targetPlaceId = target.rows[0]!.id
  const representativeRooms = await client.query<{ id: number; name: string }>(
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     VALUES
       ($1, 'place', 'Note-only Room', 1),
       ($1, 'place', 'Child-only Room', 1),
       ($1, 'place', 'Small Room', 1)
     RETURNING id, name`,
    [continent.rows[0]!.id],
  )
  const representativeId = (name: string) => {
    const id = representativeRooms.rows.find(row => row.name === name)?.id
    if (!id) throw new Error(`missing representative room: ${name}`)
    return id
  }
  const noteHeavyPlaceId = representativeId('Note-only Room')
  const childHeavyPlaceId = representativeId('Child-only Room')
  const smallPlaceId = representativeId('Small Room')

  await client.query(
    `INSERT INTO places (parent_id, place_kind, name, description, owner_id)
     SELECT $1, 'place', 'Room child ' || child_number,
       repeat('child ', 400) || child_number || ' 🏙', 1
     FROM generate_series(1, 75) AS child_number`,
    [targetPlaceId],
  )
  await client.query(
    `INSERT INTO notes (place_id, author_id, body, created_at)
     SELECT $1, 1, repeat('only notes ', 500) || item_number || ' 🏙',
       '2026-08-15T00:00:00Z'::timestamptz + item_number * interval '1 second'
     FROM generate_series(1, 25) AS item_number`,
    [noteHeavyPlaceId],
  )
  await client.query(
    `INSERT INTO places (parent_id, place_kind, name, description, owner_id)
     SELECT $1, 'place', 'Only child ' || child_number,
       repeat('only children ', 350) || child_number || ' 🏙', 1
     FROM generate_series(1, 25) AS child_number`,
    [childHeavyPlaceId],
  )
  await client.query(
    `INSERT INTO places (parent_id, place_kind, name, description, owner_id)
     VALUES ($1, 'place', 'Small Room Child', $2, 1)`,
    [smallPlaceId, SMALL_ROOM_RECORDS.childDescription],
  )
  await client.query(
    `INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
     VALUES ($1, 'Small Room Keepsake', $2, 1, 1,
       '2026-08-15T00:00:01Z'::timestamptz)`,
    [smallPlaceId, SMALL_ROOM_RECORDS.thingBody],
  )
  await client.query(
    `INSERT INTO notes (place_id, author_id, body, created_at)
     VALUES ($1, 1, $2,
       '2026-08-15T00:00:02Z'::timestamptz)`,
    [smallPlaceId, SMALL_ROOM_RECORDS.noteBody],
  )
  await client.query(
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     SELECT $1, 'place', 'Map sibling ' || child_number, 1
     FROM generate_series(1, 1005) AS child_number`,
    [continent.rows[0]!.id],
  )
  await client.query(
    `INSERT INTO resident_presence (resident_id, current_place_id)
     SELECT id, $1 FROM residents`,
    [targetPlaceId],
  )
  await client.query(
    `INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
     SELECT $1, 'thing-' || item_number,
       repeat('thing ', 5000) || item_number || ' 🏙', 1, 1,
       '2026-08-14T00:00:00Z'::timestamptz + item_number * interval '1 second'
     FROM generate_series(1, 75) AS item_number`,
    [targetPlaceId],
  )
  await client.query(
    `INSERT INTO notes (place_id, author_id, body, created_at)
     SELECT $1, 1, repeat('note ', 600) || item_number || ' 🏙',
       '2026-08-14T00:00:00Z'::timestamptz + item_number * interval '1 second'
     FROM generate_series(1, 75) AS item_number`,
    [targetPlaceId],
  )
  await client.query(`
    WITH inserted AS (
      INSERT INTO agreements (created_by_id, body, created_at)
      SELECT 1, 'agreement body ' || item_number,
        '2026-08-14T00:00:00Z'::timestamptz + item_number * interval '1 second'
      FROM generate_series(1, 75) AS item_number
      RETURNING id
    )
    INSERT INTO agreement_parties (agreement_id, resident_id)
    SELECT id, 1 FROM inserted
  `)
  await client.query(
    `INSERT INTO events (kind, actor, detail, at)
     SELECT 'note', 'resident-1', jsonb_build_object('place_id', $1::integer),
       '2026-08-14T00:00:00Z'::timestamptz + item_number * interval '1 second'
     FROM generate_series(1, 75) AS item_number`,
    [targetPlaceId],
  )

  const ids = async (statement: string, values: readonly unknown[] = []) => (
    await client.query<{ id: number }>(statement, [...values])
  ).rows.map(row => row.id)

  return Object.freeze({
    worldPlaceId: world.rows[0]!.id,
    mapBranchPlaceId: continent.rows[0]!.id,
    targetPlaceId,
    noteHeavyPlaceId,
    childHeavyPlaceId,
    smallPlaceId,
    placeCount: Number((await client.query<{ count: string }>('SELECT count(*) FROM places')).rows[0]!.count),
    residentCount: Number((await client.query<{ count: string }>('SELECT count(*) FROM residents')).rows[0]!.count),
    expected: Object.freeze({
      events: await ids(`SELECT id FROM events WHERE kind = 'note' ORDER BY id DESC`),
      worldSubplaces: await ids(
        `SELECT id FROM places WHERE parent_id = $1 ORDER BY id DESC`,
        [world.rows[0]!.id],
      ),
      mapSubplaces: await ids(
        `SELECT id FROM places WHERE parent_id = $1 ORDER BY id DESC`,
        [continent.rows[0]!.id],
      ),
      subplaces: await ids(
        `SELECT id FROM places WHERE parent_id = $1 ORDER BY id DESC`,
        [targetPlaceId],
      ),
      things: await ids(
        `SELECT id FROM things WHERE place_id = $1 AND withdrawn_at IS NULL ORDER BY id DESC`,
        [targetPlaceId],
      ),
      notes: await ids(
        `SELECT id FROM notes WHERE place_id = $1 ORDER BY id DESC`,
        [targetPlaceId],
      ),
      allNotes: await ids('SELECT id FROM notes ORDER BY id DESC'),
    }),
  })
}

function rowIds(rows: readonly Record<string, unknown>[]): number[] {
  return rows.map(row => Number(row.id))
}

async function allEventIds(): Promise<number[]> {
  const ids: number[] = []
  let cursor: number | null = null
  do {
    const request = page(cursor)
    const rows = await loadPublicEventRows(
      executePublicQuery,
      { kind: 'note', actor: null, placeId: null },
      request,
    )
    const result = finalizePublicPage(
      rows as readonly (Record<string, unknown> & { id: number })[],
      request.limit,
    )
    ids.push(...rowIds(result.items))
    cursor = result.hasMore ? result.nextCursor : null
  } while (cursor !== null)
  return ids
}

function placeRequests(
  collection: keyof PublicPlacePageRequests,
  cursor: number | null,
): PublicPlacePageRequests {
  const defaultPage = page(null, 1)
  return Object.freeze({
    subplaces: collection === 'subplaces' ? page(cursor) : defaultPage,
    things: collection === 'things' ? page(cursor) : defaultPage,
    notes: collection === 'notes' ? page(cursor) : defaultPage,
  })
}

async function allPlaceCollectionIds(
  placeId: number,
  collection: keyof PublicPlacePageRequests,
): Promise<number[]> {
  const ids: number[] = []
  let cursor: number | null = null
  do {
    const requests = placeRequests(collection, cursor)
    const rows = await loadPublicPlaceCollectionRows(executePublicQuery, placeId, requests)
    const result = finalizePublicPage(
      rows[collection] as readonly (Record<string, unknown> & { id: number })[],
      requests[collection].limit,
    )
    ids.push(...rowIds(result.items))
    cursor = result.hasMore ? result.nextCursor : null
  } while (cursor !== null)
  return ids
}

function placeTreeCount(values: readonly unknown[]): number {
  return values.reduce<number>((total, value) => {
    if (!value || typeof value !== 'object') return total
    const children = (value as { children?: unknown }).children
    return total + 1 + (Array.isArray(children) ? placeTreeCount(children) : 0)
  }, 0)
}

function publicSearchQuery(
  query: Readonly<Record<string, readonly string[]>>,
) {
  const parsed = parsePublicSearchQuery(query)
  if (!parsed.ok) assert.fail(parsed.error)
  return parsed
}

function publicChangeQuery(
  query: Readonly<Record<string, readonly string[]>>,
) {
  const parsed = parsePublicChangeQuery(query)
  if (!parsed.ok) assert.fail(parsed.error)
  return parsed
}

test('public listing pages use bounded keyset reads against PostgreSQL', async t => {
  const postgres = await startPostgres()
  database = postgres.client

  try {
    const city = await seedCity(postgres.client)

    await t.test('the additive totals migration upgrades old data and reapplies exactly', async () => {
      await postgres.client.query(`
        DROP TRIGGER IF EXISTS places_update_reading_totals ON places;
        DROP TRIGGER IF EXISTS things_update_reading_totals ON things;
        DROP TRIGGER IF EXISTS notes_update_reading_totals ON notes;
        DROP FUNCTION IF EXISTS maintain_place_reading_totals_from_place();
        DROP FUNCTION IF EXISTS maintain_place_reading_totals_from_thing();
        DROP FUNCTION IF EXISTS maintain_place_reading_totals_from_note();
        DROP TABLE place_reading_totals;
      `)
      await postgres.client.query(affordableReadingMigration)
      const first = (await postgres.client.query(
        `SELECT * FROM place_reading_totals WHERE place_id = $1`,
        [city.targetPlaceId],
      )).rows[0]
      const exact = (await postgres.client.query(`
        SELECT
          (SELECT count(*)::integer FROM places WHERE parent_id = $1) AS subplace_items,
          (SELECT coalesce(sum(octet_length(description)), 0)::bigint FROM places WHERE parent_id = $1) AS subplace_text_bytes,
          (SELECT count(*)::integer FROM things WHERE place_id = $1 AND withdrawn_at IS NULL) AS thing_items,
          (SELECT coalesce(sum(octet_length(body)), 0)::bigint FROM things WHERE place_id = $1 AND withdrawn_at IS NULL) AS thing_text_bytes,
          (SELECT count(*)::integer FROM notes WHERE place_id = $1) AS note_items,
          (SELECT coalesce(sum(octet_length(body)), 0)::bigint FROM notes WHERE place_id = $1) AS note_text_bytes
      `, [city.targetPlaceId])).rows[0]
      assert.deepEqual(first, { place_id: city.targetPlaceId, ...exact })

      await postgres.client.query(affordableReadingMigration)
      const second = (await postgres.client.query(
        `SELECT * FROM place_reading_totals WHERE place_id = $1`,
        [city.targetPlaceId],
      )).rows[0]
      assert.deepEqual(second, first)
      const triggers = await postgres.client.query(`
        SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgname IN (
          'places_update_reading_totals',
          'things_update_reading_totals',
          'notes_update_reading_totals'
        )
      `)
      assert.equal(triggers.rowCount, 3)
    })

    await t.test('the standalone presence index migration reapplies concurrently', async () => {
      await postgres.client.query('DROP INDEX IF EXISTS events_actor_at_desc')
      assert.equal(await applyMigration(
        postgres.databaseUrl,
        'db/migrations/20260821_events_presence_index.sql',
        eventsPresenceIndexMigration,
      ), 1)
      const first = await postgres.client.query(
        `${EVENTS_PRESENCE_INDEX_STATE_QUERY} LIMIT 1`,
      )
      assert.deepEqual(first.rows[0], {
        index_schema: 'public',
        index_name: 'events_actor_at_desc',
        table_schema: 'public',
        table_name: 'events',
        valid: true,
        ready: true,
        unique_index: false,
        access_method: 'btree',
        key_column_count: 2,
        total_column_count: 2,
        options: [0, 3],
        unfiltered: true,
        columns: ['actor', 'at'],
      })
      const firstOid = (await postgres.client.query(
        `SELECT 'public.events_actor_at_desc'::regclass::oid AS oid`,
      )).rows[0]!.oid

      assert.equal(await applyMigration(
        postgres.databaseUrl,
        'db/migrations/20260821_events_presence_index.sql',
        eventsPresenceIndexMigration,
      ), 0)
      const unchangedOid = (await postgres.client.query(
        `SELECT 'public.events_actor_at_desc'::regclass::oid AS oid`,
      )).rows[0]!.oid
      assert.equal(unchangedOid, firstOid, 'a valid exact index must not be dropped on rerun')

      await postgres.client.query(`
        UPDATE pg_index
        SET indisvalid = FALSE, indisready = FALSE
        WHERE indexrelid = 'public.events_actor_at_desc'::regclass
      `)
      assert.equal(await applyMigration(
        postgres.databaseUrl,
        'db/migrations/20260821_events_presence_index.sql',
        eventsPresenceIndexMigration,
      ), 2)
      const repaired = await postgres.client.query(
        `${EVENTS_PRESENCE_INDEX_STATE_QUERY} LIMIT 1`,
      )
      assert.equal(repaired.rows[0]?.valid, true)
      assert.equal(repaired.rows[0]?.ready, true)
      assert.deepEqual(repaired.rows[0]?.columns, ['actor', 'at'])
      assert.deepEqual(repaired.rows[0]?.options, [0, 3])
      const repairedOid = (await postgres.client.query(
        `SELECT 'public.events_actor_at_desc'::regclass::oid AS oid`,
      )).rows[0]!.oid
      assert.notEqual(repairedOid, firstOid, 'invalid residue must be dropped before retry')
    })

    await t.test('the public change migration preserves one exact marker per committed event on reapply', async () => {
      const before = (await postgres.client.query<{
        current_change_id: string
        event_count: string
        change_count: string
      }>(`
        SELECT state.current_change_id::text,
          (SELECT count(*)::text FROM events) AS event_count,
          (SELECT count(*)::text FROM public_change_log) AS change_count
        FROM public_change_state state
        WHERE state.singleton = true
      `)).rows[0]!
      assert.equal(before.change_count, before.event_count)
      assert.equal(before.current_change_id, before.change_count)

      await postgres.client.query(publicChangeMarkersMigration)
      await postgres.client.query(publicChangeMarkersMigration)

      const after = (await postgres.client.query<{
        current_change_id: string
        event_count: string
        change_count: string
        distinct_event_count: string
      }>(`
        SELECT state.current_change_id::text,
          (SELECT count(*)::text FROM events) AS event_count,
          (SELECT count(*)::text FROM public_change_log) AS change_count,
          (SELECT count(DISTINCT event_id)::text FROM public_change_log) AS distinct_event_count
        FROM public_change_state state
        WHERE state.singleton = true
      `)).rows[0]!
      assert.deepEqual(after, {
        ...before,
        distinct_event_count: before.event_count,
      })
      const markerTriggers = await postgres.client.query(`
        SELECT tgname
        FROM pg_trigger
        WHERE tgrelid = 'events'::regclass
          AND NOT tgisinternal
          AND tgname = 'events_record_public_change'
      `)
      assert.equal(markerTriggers.rowCount, 1)
    })

    await t.test('search exposes current public note and thing outlines with exact totals', async () => {
      const client = await postgres.client.connect()
      await client.query('BEGIN')
      const searchExecute: PublicQueryExecutor = async (text, values) => (
        await client.query(text, [...values])
      ).rows as Record<string, unknown>[]
      try {
      const phrase = 'wave five archive quartz'
      const noteBody = `A note carrying the ${phrase} for later readers. 🏙`
      const thingBody = 'A compact object history with multibyte text. 🏙'
      const note = (await client.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES ($1, 2, $2, '2026-08-21T18:00:00.123456Z')
        RETURNING id
      `, [city.targetPlaceId, noteBody])).rows[0]!
      const thing = (await client.query<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
        VALUES ($1, 'Wave Five Archive Quartz', $2, 3, 3, '2026-08-21T18:00:01.123456Z')
        RETURNING id
      `, [city.targetPlaceId, thingBody])).rows[0]!

      const result = await loadPublicSearchResults(
        searchExecute,
        publicSearchQuery({
          q: [phrase],
          mode: ['phrase'],
          type: ['all'],
          limit: ['200'],
        }),
      )
      assert.equal(result.totalItems, 2)
      assert.equal(
        result.totalBodyBytes,
        Buffer.byteLength(noteBody, 'utf8') + Buffer.byteLength(thingBody, 'utf8'),
      )
      assert.deepEqual(
        result.items.map(item => ({ type: item.type, id: item.id })),
        [{ type: 'thing', id: thing.id }, { type: 'note', id: note.id }],
      )
      for (const item of result.items) {
        assert.equal('body' in item, false)
        assert.equal('snippet' in item, false)
        assert.equal('rank' in item, false)
      }
      const wordResult = await loadPublicSearchResults(
        searchExecute,
        publicSearchQuery({ q: ['archive quartz'], mode: ['words'], type: ['all'] }),
      )
      assert.deepEqual(
        wordResult.items.map(item => ({ type: item.type, id: item.id })),
        [{ type: 'thing', id: thing.id }, { type: 'note', id: note.id }],
      )

      const moving = (await client.query<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
        VALUES ($1, 'wavefiveoldcopper', 'wavefiveoldcopper', 3, 3,
          '2026-08-21T18:00:02.123456Z')
        RETURNING id
      `, [city.targetPlaceId])).rows[0]!
      await client.query(`
        UPDATE things
        SET name = 'wavefivenewcopper', body = 'wavefivenewcopper', place_id = $1
        WHERE id = $2
      `, [city.smallPlaceId, moving.id])
      const oldState = await loadPublicSearchResults(
        searchExecute,
        publicSearchQuery({ q: ['wavefiveoldcopper'], mode: ['phrase'], type: ['thing'] }),
      )
      assert.equal(oldState.totalItems, 0, 'an edit must replace old searchable thing text')
      const movedState = await loadPublicSearchResults(
        searchExecute,
        publicSearchQuery({ q: ['wavefivenewcopper'], mode: ['phrase'], type: ['thing'] }),
      )
      assert.equal(movedState.totalItems, 1)
      assert.equal(movedState.items[0]?.id, moving.id)
      assert.equal(movedState.items[0]?.place_id, city.smallPlaceId)
      await client.query(`UPDATE things SET withdrawn_at = now() WHERE id = $1`, [moving.id])
      const withdrawnState = await loadPublicSearchResults(
        searchExecute,
        publicSearchQuery({ q: ['wavefivenewcopper'], mode: ['phrase'], type: ['thing'] }),
      )
      assert.equal(withdrawnState.totalItems, 0, 'withdrawn things must disappear before matching')

      const moderated = (await client.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES ($1, 5, 'restorablebirchtoken', '2026-08-21T18:00:03.123456Z')
        RETURNING id
      `, [city.targetPlaceId])).rows[0]!
      const findModerated = () => loadPublicSearchResults(
        searchExecute,
        publicSearchQuery({ q: ['restorablebirchtoken'], mode: ['phrase'], type: ['note'] }),
      )
      assert.equal((await findModerated()).totalItems, 1)
      await client.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('note', $1, 'remove', 1, 'integration removal')
      `, [moderated.id])
      assert.equal((await findModerated()).totalItems, 0, 'removed notes must be filtered before matching')
      await client.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('note', $1, 'restore', 1, 'integration restoration')
      `, [moderated.id])
      assert.equal((await findModerated()).totalItems, 1, 'the latest restore must make the note searchable')
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    await t.test('search keyset pages exhaust equal timestamps without gaps or duplicates', async () => {
      const client = await postgres.client.connect()
      await client.query('BEGIN')
      const searchExecute: PublicQueryExecutor = async (text, values) => (
        await client.query(text, [...values])
      ).rows as Record<string, unknown>[]
      try {
      const phrase = 'wavefivepagingneedle'
      await client.query(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        SELECT $1, 2, $2 || ' note ' || item_number,
          '2026-08-21T18:10:00.654321Z'::timestamptz
            + item_number * interval '1 microsecond'
        FROM generate_series(1, 4) AS item_number
      `, [city.targetPlaceId, phrase])
      await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
        SELECT $1, $2 || ' thing ' || item_number, 'paging body ' || item_number,
          3, 3, '2026-08-21T18:10:00.654321Z'::timestamptz
            + item_number * interval '1 microsecond'
        FROM generate_series(1, 3) AS item_number
      `, [city.targetPlaceId, phrase])

      const directTotals = (await client.query<{
        total_items: string
        total_body_bytes: string
      }>(`
        SELECT count(*)::text AS total_items,
          sum(octet_length(body))::text AS total_body_bytes
        FROM (
          SELECT body FROM notes WHERE strpos(lower(body), lower($1)) > 0
          UNION ALL
          SELECT body FROM things
          WHERE withdrawn_at IS NULL AND strpos(lower(name || ' ' || body), lower($1)) > 0
        ) matching
      `, [phrase])).rows[0]!
      assert.equal(directTotals.total_items, '7')

      const complete = await loadPublicSearchResults(
        searchExecute,
        publicSearchQuery({
          q: [phrase], mode: ['phrase'], type: ['all'], limit: ['200'],
        }),
      )
      assert.equal(complete.totalItems, Number(directTotals.total_items))
      assert.equal(complete.totalBodyBytes, Number(directTotals.total_body_bytes))

      const pagedItems: typeof complete.items[number][] = []
      let before: string | null = null
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const page = await loadPublicSearchResults(
          searchExecute,
          publicSearchQuery({
            q: [phrase],
            mode: ['phrase'],
            type: ['all'],
            limit: ['2'],
            ...(before === null ? {} : { before: [before] }),
          }),
        )
        assert.equal(page.totalItems, complete.totalItems)
        assert.equal(page.totalBodyBytes, complete.totalBodyBytes)
        pagedItems.push(...page.items)
        if (!page.hasMore) break
        assert.ok(page.nextBefore, 'every nonterminal page needs an honest continuation')
        before = page.nextBefore
      }
      const identity = (item: Readonly<Record<string, unknown>>) => `${String(item.type)}:${Number(item.id)}`
      assert.deepEqual(pagedItems.map(identity), complete.items.map(identity))
      assert.equal(new Set(pagedItems.map(identity)).size, complete.totalItems)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    await t.test('public markers page committed changes without exposing event ids', async () => {
      const markerSchema = `wave_five_markers_${randomBytes(6).toString('hex')}`
      await postgres.client.query(`CREATE SCHEMA "${markerSchema}"`)
      const markerPool = new Pool({
        connectionString: postgres.databaseUrl,
        options: `-c search_path=${markerSchema}`,
      })
      const markerExecute: PublicQueryExecutor = async (text, values) => (
        await markerPool.query(text, [...values])
      ).rows as Record<string, unknown>[]
      try {
        await markerPool.query(schemaDdl)
      type ChangePayload = Readonly<{
        change_marker: string
        changes: readonly Readonly<Record<string, unknown> & { change_id: string; kind: string }>[]
        returned_items: number
        unchanged: boolean
        has_more: boolean
        next_since: string
      }>
      const checkpoint = await loadPublicChanges(
        markerExecute,
        publicChangeQuery({}),
      ) as Readonly<{ change_marker: string }>
      const unchanged = await loadPublicChanges(
        markerExecute,
        publicChangeQuery({ since: [checkpoint.change_marker] }),
      ) as ChangePayload
      assert.equal(unchanged.unchanged, true)
      assert.equal(unchanged.returned_items, 0)
      assert.equal(unchanged.next_since, checkpoint.change_marker)

      const committedIds: number[] = []
      for (let itemNumber = 1; itemNumber <= 5; itemNumber += 1) {
        const event = (await markerPool.query<{ id: number }>(`
          INSERT INTO events (kind, actor, detail)
          VALUES ('note', 'wave-five-marker', jsonb_build_object('item', $1::integer))
          RETURNING id
        `, [itemNumber])).rows[0]!
        committedIds.push(event.id)
      }

      const changes: Array<Readonly<Record<string, unknown> & { change_id: string; kind: string }>> = []
      let since = checkpoint.change_marker
      let finalCheckpoint: string | null = null
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const page = await loadPublicChanges(
          markerExecute,
          publicChangeQuery({ since: [since], limit: ['2'] }),
        ) as ChangePayload
        finalCheckpoint ??= page.change_marker
        assert.equal(page.change_marker, finalCheckpoint)
        assert.equal(page.returned_items, page.changes.length)
        changes.push(...page.changes)
        since = page.next_since
        if (!page.has_more) break
      }
      assert.deepEqual(
        changes.map(change => BigInt(change.change_id)),
        changes.map((_, index) => BigInt(checkpoint.change_marker) + BigInt(index + 1)),
      )
      assert.equal(new Set(changes.map(change => change.change_id)).size, committedIds.length)
      assert.equal(changes.every(change => !Object.hasOwn(change, 'id')), true)

      const filterStart = BigInt(finalCheckpoint!)
      for (const [kind, actor] of [
        ['action', 'wave-five-filter-action-one'],
        ['note', 'wave-five-filter-note-one'],
        ['action', 'wave-five-filter-action-two'],
        ['note', 'wave-five-filter-note-two'],
        ['action', 'wave-five-filter-action-three'],
      ] as const) {
        await markerPool.query(`
          INSERT INTO events (kind, actor, detail)
          VALUES ($1, $2, '{}')
        `, [kind, actor])
      }

      const firstNotePage = await loadPublicChanges(
        markerExecute,
        publicChangeQuery({
          since: [filterStart.toString()], kind: ['note'], limit: ['1'],
        }),
      ) as ChangePayload
      assert.equal(firstNotePage.has_more, true)
      assert.equal(firstNotePage.next_since, (filterStart + 2n).toString())
      assert.deepEqual(firstNotePage.changes.map(change => change.kind), ['note'])
      assert.equal(firstNotePage.changes.every(change => !Object.hasOwn(change, 'id')), true)

      const finalNotePage = await loadPublicChanges(
        markerExecute,
        publicChangeQuery({
          since: [firstNotePage.next_since], kind: ['note'], limit: ['1'],
        }),
      ) as ChangePayload
      assert.equal(finalNotePage.has_more, false)
      assert.equal(finalNotePage.next_since, (filterStart + 5n).toString())
      assert.equal(finalNotePage.change_marker, finalNotePage.next_since)
      assert.deepEqual(finalNotePage.changes.map(change => change.kind), ['note'])

      const firstCommitClient = await markerPool.connect()
      const secondCommitClient = await markerPool.connect()
      let pendingSecondInsert: Promise<{ id: number }> | null = null
      try {
        await firstCommitClient.query('BEGIN')
        await secondCommitClient.query('BEGIN')

        const firstBackendPid = (
          await firstCommitClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0]!.pid
        const secondBackendPid = (
          await secondCommitClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0]!.pid
        const markerBeforeConcurrentCommits = BigInt((await firstCommitClient.query<{
          marker: string
        }>(`
          SELECT current_change_id::text AS marker
          FROM public_change_state WHERE singleton = true
        `)).rows[0]!.marker)

        const firstConcurrentEvent = (await firstCommitClient.query<{ id: number }>(`
          INSERT INTO events (kind, actor, detail)
          VALUES ('action', 'wave-five-first-concurrent', '{"concurrent":1}')
          RETURNING id
        `)).rows[0]!

        let secondInsertSettled = false
        pendingSecondInsert = secondCommitClient.query<{ id: number }>(`
          INSERT INTO events (kind, actor, detail)
          VALUES ('action', 'wave-five-second-concurrent', '{"concurrent":2}')
          RETURNING id
        `).then(result => result.rows[0]!).finally(() => {
          secondInsertSettled = true
        })

        let secondInsertIsBlocked = false
        for (let attempt = 0; attempt < 200 && !secondInsertIsBlocked; attempt += 1) {
          const blockingResult = await markerPool.query<{ blocked: boolean }>(
            'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked',
            [firstBackendPid, secondBackendPid],
          )
          secondInsertIsBlocked = blockingResult.rows[0]?.blocked === true
          if (!secondInsertIsBlocked) {
            await new Promise(resolve => setTimeout(resolve, 10))
          }
        }

        assert.equal(
          secondInsertIsBlocked,
          true,
          'the second insert should wait for the singleton marker row held by the first transaction',
        )
        assert.equal(secondInsertSettled, false)

        await firstCommitClient.query('COMMIT')
        const secondConcurrentEvent = await pendingSecondInsert
        await secondCommitClient.query('COMMIT')
        pendingSecondInsert = null

        const concurrentMarkers = await markerPool.query<{
          event_id: number
          change_id: string
        }>(`
          SELECT event_id, change_id::text AS change_id
          FROM public_change_log
          WHERE event_id = ANY($1::bigint[])
          ORDER BY change_id ASC
        `, [[firstConcurrentEvent.id, secondConcurrentEvent.id]])
        assert.deepEqual(concurrentMarkers.rows, [
          {
            event_id: firstConcurrentEvent.id,
            change_id: (markerBeforeConcurrentCommits + 1n).toString(),
          },
          {
            event_id: secondConcurrentEvent.id,
            change_id: (markerBeforeConcurrentCommits + 2n).toString(),
          },
        ])
      } finally {
        await firstCommitClient.query('ROLLBACK').catch(() => undefined)
        await pendingSecondInsert?.catch(() => undefined)
        await secondCommitClient.query('ROLLBACK').catch(() => undefined)
        firstCommitClient.release()
        secondCommitClient.release()
      }

      const markerBeforeRollback = BigInt((await markerPool.query<{ marker: string }>(`
        SELECT current_change_id::text AS marker
        FROM public_change_state WHERE singleton = true
      `)).rows[0]!.marker)
      const rollbackClient = await markerPool.connect()
      let rolledBackEventId = 0
      try {
        await rollbackClient.query('BEGIN')
        rolledBackEventId = (await rollbackClient.query<{ id: number }>(`
          INSERT INTO events (kind, actor, detail)
          VALUES ('action', 'wave-five-rollback', '{"rolled_back":true}')
          RETURNING id
        `)).rows[0]!.id
        const provisional = (await rollbackClient.query<{ change_id: string }>(`
          SELECT change_id::text FROM public_change_log WHERE event_id = $1
        `, [rolledBackEventId])).rows[0]!
        assert.equal(BigInt(provisional.change_id), markerBeforeRollback + 1n)
        await rollbackClient.query('ROLLBACK')
      } finally {
        rollbackClient.release()
      }
      assert.equal((await markerPool.query(
        `SELECT 1 FROM public_change_log WHERE event_id = $1`,
        [rolledBackEventId],
      )).rowCount, 0)
      const afterRollback = (await markerPool.query<{ id: number }>(`
        INSERT INTO events (kind, actor, detail)
        VALUES ('action', 'wave-five-after-rollback', '{"committed":true}')
        RETURNING id
      `)).rows[0]!
      const reused = (await markerPool.query<{ change_id: string }>(`
        SELECT change_id::text FROM public_change_log WHERE event_id = $1
      `, [afterRollback.id])).rows[0]!
      assert.equal(BigInt(reused.change_id), markerBeforeRollback + 1n)

      const reservedLowerId = Number((await markerPool.query<{ id: string }>(`
        SELECT nextval(pg_get_serial_sequence('events', 'id'))::text AS id
      `)).rows[0]!.id)
      const higher = (await markerPool.query<{ id: number }>(`
        INSERT INTO events (kind, actor, detail)
        VALUES ('action', 'wave-five-higher-id', '{}')
        RETURNING id
      `)).rows[0]!
      const higherMarker = BigInt((await markerPool.query<{ change_id: string }>(`
        SELECT change_id::text FROM public_change_log WHERE event_id = $1
      `, [higher.id])).rows[0]!.change_id)
      const lower = (await markerPool.query<{ id: number }>(`
        INSERT INTO events (id, kind, actor, detail)
        VALUES ($1, 'action', 'wave-five-lower-id-later', '{}')
        RETURNING id
      `, [reservedLowerId])).rows[0]!
      const lowerMarker = BigInt((await markerPool.query<{ change_id: string }>(`
        SELECT change_id::text FROM public_change_log WHERE event_id = $1
      `, [lower.id])).rows[0]!.change_id)
      assert.ok(lower.id < higher.id)
      assert.equal(lowerMarker, higherMarker + 1n)
      } finally {
        await markerPool.end().catch(() => undefined)
      }
    })

    await t.test('exact-total admission rejects excess work before scanning events', async () => {
      const {
        budgetedExactStatement,
        executeBudgetedExactQuery,
        isPublicExactReadBusy,
      } = await import('../../src/public-exact-query.ts')
      const first = await postgres.client.connect()
      const second = await postgres.client.connect()
      try {
        await first.query('BEGIN')
        await second.query('BEGIN')
        await first.query('SELECT pg_advisory_xact_lock(524128259, 0)')
        await second.query('SELECT pg_advisory_xact_lock(524128259, 1)')

        const explained = await postgres.client.query(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${budgetedExactStatement(`
            SELECT NULL::integer AS id, count(*)::integer AS total_items,
              coalesce(sum(octet_length(detail::text)), 0)::bigint AS total_text_bytes
            FROM events
          `)}`,
        )
        const nestedValues = (value: unknown): unknown[] => value && typeof value === 'object'
          ? [value, ...Object.values(value).flatMap(nestedValues)]
          : []
        const eventScans = nestedValues(explained.rows[0]?.['QUERY PLAN'])
          .filter(value => (value as Record<string, unknown>)['Relation Name'] === 'events')
          .map(value => Number((value as Record<string, unknown>)['Actual Loops']))
        assert.ok(eventScans.length > 0, 'the plan must retain the guarded event source')
        assert.equal(eventScans.every(loops => loops === 0), true, 'busy admission must skip source scans')

        const { default: cityApp } = await import('../../src/index.ts')
        const startedAt = Date.now()
        const response = await cityApp.request('http://city.test/api/events?limit=1')
        assert.equal(response.status, 503)
        assert.equal(response.headers.get('retry-after'), '1')
        assert.ok(Date.now() - startedAt < 500, 'capacity rejection must be cheap')
        assert.deepEqual(await response.json(), {
          error: 'exact public totals are temporarily busy; retry',
        })

        await assert.rejects(
          executeBudgetedExactQuery(
            `SELECT NULL::integer AS id, pg_sleep(3) AS delayed,
              0::integer AS total_items, 0::bigint AS total_text_bytes`,
            [],
          ),
          isPublicExactReadBusy,
        )
      } finally {
        await first.query('ROLLBACK').catch(() => undefined)
        await second.query('ROLLBACK').catch(() => undefined)
        first.release()
        second.release()
      }
    })

    await t.test('an admitted exact-total query is canceled at its database deadline', async () => {
      const { executeBudgetedExactQuery, isPublicExactReadBusy } = await import(
        '../../src/public-exact-query.ts'
      )
      const startedAt = Date.now()
      await assert.rejects(
        executeBudgetedExactQuery(
          `SELECT NULL::integer AS id, pg_sleep(3) AS delayed,
            0::integer AS total_items, 0::bigint AS total_text_bytes`,
          [],
        ),
        isPublicExactReadBusy,
      )
      const elapsed = Date.now() - startedAt
      assert.ok(elapsed >= 1_000, `deadline fired implausibly early at ${elapsed}ms`)
      assert.ok(elapsed < 2_500, `deadline failed to bound database work at ${elapsed}ms`)
    })

    await t.test('events default to 10 and every older row remains reachable once', async () => {
      const request = page()
      const firstRows = await loadPublicEventRows(
        executePublicQuery,
        { kind: 'note', actor: null, placeId: null },
        request,
      )
      assert.equal(firstRows.length, 11, 'the production query must fetch one lookahead row')
      const first = finalizePublicPage(
        firstRows as readonly (Record<string, unknown> & { id: number })[],
        request.limit,
      )
      assert.equal(first.items.length, 10)
      assert.equal(first.hasMore, true)
      assert.equal(first.nextCursor, city.expected.events[9])

      const allIds = await allEventIds()
      assert.deepEqual(allIds, city.expected.events)
      assert.equal(new Set(allIds).size, allIds.length, 'page boundaries must not duplicate events')
    })

    await t.test('place collections have independent cursors and retain complete history', async () => {
      const initialRequests = Object.freeze({
        subplaces: page(),
        things: page(),
        notes: page(),
      })
      const firstRows = await loadPublicPlaceCollectionRows(
        executePublicQuery,
        city.targetPlaceId,
        initialRequests,
      )
      assert.deepEqual(
        {
          subplaces: firstRows.subplaces.length,
          things: firstRows.things.length,
          notes: firstRows.notes.length,
        },
        { subplaces: 11, things: 11, notes: 11 },
        'each production query must fetch its own lookahead row',
      )
      assert.deepEqual(
        Object.fromEntries(Object.entries(firstRows.totals).map(([name, total]) => [name, total.items])),
        { subplaces: 75, things: 75, notes: 75 },
      )
      const exactBytes = (await postgres.client.query<{
        subplace_text_bytes: string
        thing_text_bytes: string
        note_text_bytes: string
      }>(`
        SELECT
          coalesce((SELECT sum(octet_length(description)) FROM places WHERE parent_id = $1), 0) AS subplace_text_bytes,
          coalesce((SELECT sum(octet_length(body)) FROM things WHERE place_id = $1 AND withdrawn_at IS NULL), 0) AS thing_text_bytes,
          coalesce((SELECT sum(octet_length(body)) FROM notes WHERE place_id = $1), 0) AS note_text_bytes
      `, [city.targetPlaceId])).rows[0]!
      assert.deepEqual(
        Object.fromEntries(Object.entries(firstRows.totals).map(([name, total]) => [name, total.textBytes])),
        {
          subplaces: Number(exactBytes.subplace_text_bytes),
          things: Number(exactBytes.thing_text_bytes),
          notes: Number(exactBytes.note_text_bytes),
        },
      )
      assert.ok(firstRows.totals.things.textBytes > 2_000_000, 'fixture must stay realistically dense')

      const outlineRows = await loadPublicPlaceCollectionRows(
        executePublicQuery,
        city.targetPlaceId,
        initialRequests,
        false,
      )
      assert.equal(outlineRows.things.length, 11)
      assert.equal(outlineRows.things.every(thing => !Object.hasOwn(thing, 'body')), true)
      assert.equal(outlineRows.things.every(thing => Number(thing.body_text_bytes) > 25_000), true)
      assert.equal(outlineRows.totals.things.textBytes, firstRows.totals.things.textBytes)

      const noteCursor = Number(firstRows.notes[9]!.id)
      const noteOnlyAdvance = await loadPublicPlaceCollectionRows(
        executePublicQuery,
        city.targetPlaceId,
        Object.freeze({ ...initialRequests, notes: page(noteCursor) }),
      )
      assert.deepEqual(rowIds(noteOnlyAdvance.subplaces), rowIds(firstRows.subplaces))
      assert.deepEqual(rowIds(noteOnlyAdvance.things), rowIds(firstRows.things))
      assert.notDeepEqual(rowIds(noteOnlyAdvance.notes), rowIds(firstRows.notes))

      for (const collection of ['subplaces', 'things', 'notes'] as const) {
        const allIds = await allPlaceCollectionIds(city.targetPlaceId, collection)
        assert.deepEqual(allIds, city.expected[collection])
        assert.equal(
          new Set(allIds).size,
          allIds.length,
          `${collection} page boundaries must not duplicate rows`,
        )
      }
    })

    await t.test('dense room HTTP reads keep whole records and make smaller requests visibly cheaper', async testContext => {
      const { default: cityApp } = await import('../../src/index.ts')
      const ordinaryResponse = await cityApp.request(`http://city.test/api/place/${city.targetPlaceId}`)
      const ordinaryText = await ordinaryResponse.text()
      assert.equal(ordinaryResponse.status, 200)
      const ordinary = JSON.parse(ordinaryText) as {
        subplaces: Array<{ description: string; created_at: string }>
        things: Array<{ body: string; created_at: string }>
        notes: Array<{ body: string; created_at: string }>
        subplaces_page: Record<string, number | boolean | null>
        things_page: Record<string, number | boolean | null>
        notes_page: Record<string, number | boolean | null>
      }
      assert.equal(ordinary.things.length, 10)
      assert.ok(Buffer.byteLength(ordinaryText, 'utf8') > 300_000)
      assert.equal(
        ordinary.things_page.returned_text_bytes,
        ordinary.things.reduce((sum, row) => sum + Buffer.byteLength(row.body, 'utf8'), 0),
      )
      assert.equal(ordinary.things_page.total_items, 75)
      assert.ok(Number(ordinary.things_page.total_text_bytes) > Number(ordinary.things_page.returned_text_bytes))
      assert.equal(ordinary.things.every(row => row.body.endsWith(' 🏙')), true, 'bodies stay whole')
      for (const [name, rows] of [
        ['subplaces', ordinary.subplaces],
        ['things', ordinary.things],
        ['notes', ordinary.notes],
      ] as const) {
        assert.equal(
          rows.every(row => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(row.created_at)),
          true,
          `${name} timestamps keep the existing ISO wire shape`,
        )
      }

      const smallResponse = await cityApp.request(
        `http://city.test/api/place/${city.targetPlaceId}?limit=1`,
      )
      const smallText = await smallResponse.text()
      assert.equal(smallResponse.status, 200)
      const small = JSON.parse(smallText) as typeof ordinary
      assert.equal(small.subplaces.length, 1)
      assert.equal(small.things.length, 1)
      assert.equal(small.notes.length, 1)
      assert.equal(small.things_page.total_items, ordinary.things_page.total_items)
      assert.equal(small.things_page.total_text_bytes, ordinary.things_page.total_text_bytes)
      assert.ok(Buffer.byteLength(smallText, 'utf8') < Buffer.byteLength(ordinaryText, 'utf8') / 5)

      const outlineResponse = await cityApp.request(
        `http://city.test/api/place/${city.targetPlaceId}?view=outline&limit=10`,
      )
      const outlineText = await outlineResponse.text()
      assert.equal(outlineResponse.status, 200, outlineText)
      const outline = JSON.parse(outlineText) as {
        subplaces: Array<{ description?: string; description_text_bytes: number }>
        things: Array<{ body?: string; body_text_bytes: number }>
        notes: Array<{ body?: string; body_text_bytes: number }>
        subplaces_page: { returned_text_bytes: number }
        things_page: { returned_text_bytes: number }
        notes_page: { returned_text_bytes: number }
      }
      assert.equal(outline.subplaces.length, 10)
      assert.equal(outline.things.length, 10)
      assert.equal(outline.notes.length, 10)
      assert.equal(outline.subplaces.every(row => !Object.hasOwn(row, 'description')), true)
      assert.equal(outline.things.every(row => !Object.hasOwn(row, 'body')), true)
      assert.equal(outline.notes.every(row => !Object.hasOwn(row, 'body')), true)
      assert.equal(outline.subplaces.every(row => row.description_text_bytes > 2_000), true)
      assert.equal(outline.things.every(row => row.body_text_bytes > 25_000), true)
      assert.equal(outline.notes.every(row => row.body_text_bytes > 2_000), true)
      assert.deepEqual(
        [
          outline.subplaces_page.returned_text_bytes,
          outline.things_page.returned_text_bytes,
          outline.notes_page.returned_text_bytes,
        ],
        [0, 0, 0],
      )
      assert.ok(
        Buffer.byteLength(outlineText, 'utf8') < Buffer.byteLength(ordinaryText, 'utf8') / 20,
        'outline entry must stay cheap when children, things, and notes are all heavy',
      )
      testContext.diagnostic(
        `representative dense room bytes: full=${Buffer.byteLength(ordinaryText, 'utf8')}, ` +
          `limit1=${Buffer.byteLength(smallText, 'utf8')}, outline=${Buffer.byteLength(outlineText, 'utf8')}`,
      )

      const serverCollectionTextLimit = 655_360
      const bulkThingIds: number[] = []
      let bulkThingCursor: number | null = null
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const cursorQuery = bulkThingCursor == null
          ? ''
          : `&before_thing_id=${bulkThingCursor}`
        const cappedResponse = await cityApp.request(
          `http://city.test/api/place/${city.targetPlaceId}` +
            '?view=full&subplace_limit=1&thing_limit=200&note_limit=1' + cursorQuery,
        )
        const cappedText = await cappedResponse.text()
        assert.equal(cappedResponse.status, 200, cappedText)
        const capped = JSON.parse(cappedText) as {
          things: Array<{ id: number; body: string }>
          things_page: {
            returned_text_bytes: number
            has_more: boolean
            next_before_thing_id: number | null
            text_limit_bytes?: number
            stopped_for_text_limit?: boolean
            next_item_id?: number | null
            server_text_limit_applied?: boolean
          }
        }
        assert.equal(
          capped.things.some(thing => bulkThingIds.includes(thing.id)),
          false,
          'server-capped bulk pages must not repeat things',
        )
        bulkThingIds.push(...capped.things.map(thing => thing.id))
        assert.ok(capped.things_page.returned_text_bytes <= serverCollectionTextLimit)
        assert.equal(capped.things_page.text_limit_bytes, serverCollectionTextLimit)
        assert.equal(capped.things_page.server_text_limit_applied, true)
        if (!capped.things_page.has_more) break
        assert.equal(capped.things_page.stopped_for_text_limit, true)
        assert.ok(capped.things_page.next_item_id)
        assert.ok(capped.things_page.next_before_thing_id)
        bulkThingCursor = capped.things_page.next_before_thing_id
        if (pageNumber === 9) assert.fail('server-capped bulk paging did not terminate')
      }
      assert.deepEqual(bulkThingIds, city.expected.things)

      const budget = 6_500
      const budgetedResponse = await cityApp.request(
        `http://city.test/api/place/${city.targetPlaceId}` +
          `?view=full&limit=200&subplace_text_limit_bytes=${budget}` +
          `&thing_text_limit_bytes=65000&note_text_limit_bytes=${budget}`,
      )
      const budgetedText = await budgetedResponse.text()
      assert.equal(budgetedResponse.status, 200, budgetedText)
      const budgeted = JSON.parse(budgetedText) as {
        subplaces: Array<{ id: number; description: string }>
        things: Array<{ id: number; body: string }>
        notes: Array<{ id: number; body: string }>
        subplaces_page: {
          returned_text_bytes: number
          has_more: boolean
          next_before_subplace_id: number | null
          text_limit_bytes: number
          stopped_for_text_limit: boolean
          next_item_id: number | null
        }
        things_page: {
          returned_text_bytes: number
          has_more: boolean
          next_before_thing_id: number | null
          text_limit_bytes: number
          stopped_for_text_limit: boolean
          next_item_id: number | null
        }
        notes_page: {
          returned_text_bytes: number
          has_more: boolean
          next_before_note_id: number | null
          text_limit_bytes: number
          stopped_for_text_limit: boolean
          next_item_id: number | null
        }
      }
      assert.equal(budgeted.subplaces.length, 2)
      assert.equal(budgeted.things.length, 2)
      assert.equal(budgeted.notes.length, 2)
      assert.equal(budgeted.subplaces_page.text_limit_bytes, budget)
      assert.equal(budgeted.things_page.text_limit_bytes, 65_000)
      assert.equal(budgeted.notes_page.text_limit_bytes, budget)
      assert.ok(budgeted.subplaces_page.next_before_subplace_id)
      assert.ok(budgeted.things_page.next_before_thing_id)
      assert.ok(budgeted.notes_page.next_before_note_id)
      for (const [name, rows, page, field] of [
        ['subplaces', budgeted.subplaces, budgeted.subplaces_page, 'description'],
        ['things', budgeted.things, budgeted.things_page, 'body'],
        ['notes', budgeted.notes, budgeted.notes_page, 'body'],
      ] as const) {
        assert.equal(page.stopped_for_text_limit, true, name)
        assert.equal(page.has_more, true, name)
        assert.ok(page.next_item_id)
        assert.equal(
          page.returned_text_bytes,
          rows.reduce((sum, row) => sum + Buffer.byteLength(
            String((row as unknown as Record<string, unknown>)[field]),
            'utf8',
          ), 0),
          name,
        )
        assert.ok(page.returned_text_bytes <= page.text_limit_bytes, name)
        assert.equal(rows.every(row => String(
          (row as unknown as Record<string, unknown>)[field],
        ).endsWith(' 🏙')), true, `${name} stay whole`)
      }

      const nextResponse = await cityApp.request(
        `http://city.test/api/place/${city.targetPlaceId}` +
          `?view=full&limit=200&subplace_text_limit_bytes=${budget}` +
          `&thing_text_limit_bytes=65000&note_text_limit_bytes=${budget}` +
          `&before_subplace_id=${budgeted.subplaces_page.next_before_subplace_id}` +
          `&before_thing_id=${budgeted.things_page.next_before_thing_id}` +
          `&before_note_id=${budgeted.notes_page.next_before_note_id}`,
      )
      assert.equal(nextResponse.status, 200, await nextResponse.clone().text())
      const next = await nextResponse.json() as typeof budgeted
      for (const [name, firstRows, nextRows] of [
        ['subplaces', budgeted.subplaces, next.subplaces],
        ['things', budgeted.things, next.things],
        ['notes', budgeted.notes, next.notes],
      ] as const) {
        assert.equal(
          nextRows.some(row => firstRows.some(previous => previous.id === row.id)),
          false,
          `${name} pages must not repeat records`,
        )
      }

      const complete = { subplaces: [] as number[], things: [] as number[], notes: [] as number[] }
      let cursors: { subplaces: number | null; things: number | null; notes: number | null } = {
        subplaces: null,
        things: null,
        notes: null,
      }
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const cursorQuery = [
          cursors.subplaces == null ? '' : `&before_subplace_id=${cursors.subplaces}`,
          cursors.things == null ? '' : `&before_thing_id=${cursors.things}`,
          cursors.notes == null ? '' : `&before_note_id=${cursors.notes}`,
        ].join('')
        const response = await cityApp.request(
          `http://city.test/api/place/${city.targetPlaceId}` +
            `?view=full&limit=200&subplace_text_limit_bytes=${budget}` +
            `&thing_text_limit_bytes=65000&note_text_limit_bytes=${budget}${cursorQuery}`,
        )
        assert.equal(response.status, 200, await response.clone().text())
        const body = await response.json() as typeof budgeted
        complete.subplaces.push(...body.subplaces.map(row => row.id))
        complete.things.push(...body.things.map(row => row.id))
        complete.notes.push(...body.notes.map(row => row.id))
        const nextCursors = {
          subplaces: body.subplaces_page.has_more
            ? body.subplaces_page.next_before_subplace_id
            : null,
          things: body.things_page.has_more ? body.things_page.next_before_thing_id : null,
          notes: body.notes_page.has_more ? body.notes_page.next_before_note_id : null,
        }
        for (const [name, page, cursor] of [
          ['subplaces', body.subplaces_page, nextCursors.subplaces],
          ['things', body.things_page, nextCursors.things],
          ['notes', body.notes_page, nextCursors.notes],
        ] as const) {
          if (page.has_more) assert.ok(cursor, `${name} continuation must advance`)
        }
        cursors = nextCursors
        if (Object.values(cursors).every(cursor => cursor == null)) break
        if (pageNumber === 99) assert.fail('budgeted room paging did not terminate')
      }
      assert.deepEqual(complete.subplaces, city.expected.subplaces)
      assert.deepEqual(complete.things, city.expected.things)
      assert.deepEqual(complete.notes, city.expected.notes)
      assert.equal(new Set(complete.subplaces).size, complete.subplaces.length)
      assert.equal(new Set(complete.things).size, complete.things.length)
      assert.equal(new Set(complete.notes).size, complete.notes.length)
    })

    await t.test('zero-fit pages support direct reads and cursor continuation for every room collection', async testContext => {
      const { default: cityApp } = await import('../../src/index.ts')
      const stalledResponse = await cityApp.request(
        `http://city.test/api/place/${city.targetPlaceId}` +
          '?view=full&limit=200&subplace_text_limit_bytes=1' +
          '&thing_text_limit_bytes=1&note_text_limit_bytes=1',
      )
      const stalledText = await stalledResponse.text()
      assert.equal(stalledResponse.status, 200, stalledText)
      const stalled = JSON.parse(stalledText) as {
        subplaces: Array<{ id: number; description: string }>
        things: Array<{ id: number; body: string }>
        notes: Array<{ id: number; body: string }>
        subplaces_page: {
          returned_items: number
          returned_text_bytes: number
          has_more: boolean
          next_before_subplace_id: number | null
          text_limit_bytes: number
          stopped_for_text_limit: boolean
          next_item_id: number | null
          next_item_text_bytes: number | null
        }
        things_page: {
          returned_items: number
          returned_text_bytes: number
          has_more: boolean
          next_before_thing_id: number | null
          text_limit_bytes: number
          stopped_for_text_limit: boolean
          next_item_id: number | null
          next_item_text_bytes: number | null
        }
        notes_page: {
          returned_items: number
          returned_text_bytes: number
          has_more: boolean
          next_before_note_id: number | null
          text_limit_bytes: number
          stopped_for_text_limit: boolean
          next_item_id: number | null
          next_item_text_bytes: number | null
        }
      }

      const stalledCollections = [
        {
          name: 'subplaces',
          rows: stalled.subplaces,
          page: stalled.subplaces_page,
          nextBefore: stalled.subplaces_page.next_before_subplace_id,
          expectedIds: city.expected.subplaces,
          directPath: `/api/place/${stalled.subplaces_page.next_item_id}?view=full&limit=1`,
          directKey: 'place',
          textField: 'description',
        },
        {
          name: 'things',
          rows: stalled.things,
          page: stalled.things_page,
          nextBefore: stalled.things_page.next_before_thing_id,
          expectedIds: city.expected.things,
          directPath: `/api/thing/${stalled.things_page.next_item_id}`,
          directKey: 'thing',
          textField: 'body',
        },
        {
          name: 'notes',
          rows: stalled.notes,
          page: stalled.notes_page,
          nextBefore: stalled.notes_page.next_before_note_id,
          expectedIds: city.expected.notes,
          directPath: `/api/note/${stalled.notes_page.next_item_id}`,
          directKey: 'note',
          textField: 'body',
        },
      ] as const
      for (const entry of stalledCollections) {
        assert.deepEqual(entry.rows, [], entry.name)
        assert.equal(entry.page.returned_items, 0, entry.name)
        assert.equal(entry.page.returned_text_bytes, 0, entry.name)
        assert.equal(entry.page.has_more, true, entry.name)
        assert.equal(entry.nextBefore, null, entry.name)
        assert.equal(entry.page.text_limit_bytes, 1, entry.name)
        assert.equal(entry.page.stopped_for_text_limit, true, entry.name)
        assert.equal(entry.page.next_item_id, entry.expectedIds[0], entry.name)
        assert.ok((entry.page.next_item_text_bytes ?? 0) > 1, entry.name)

        const directResponse = await cityApp.request(`http://city.test${entry.directPath}`)
        const directText = await directResponse.text()
        assert.equal(directResponse.status, 200, `${entry.name}: ${directText}`)
        const directBody = JSON.parse(directText) as Record<string, Record<string, unknown>>
        const directRecord = directBody[entry.directKey]
        assert.equal(Number(directRecord?.id), entry.page.next_item_id, entry.name)
        const authoredText = String(directRecord?.[entry.textField])
        assert.equal(
          Buffer.byteLength(authoredText, 'utf8'),
          entry.page.next_item_text_bytes,
          entry.name,
        )
        assert.equal(authoredText.endsWith(' 🏙'), true, `${entry.name}: direct read stays whole`)
      }

      const stalledSubplaceId = stalled.subplaces_page.next_item_id
      const stalledThingId = stalled.things_page.next_item_id
      const stalledNoteId = stalled.notes_page.next_item_id
      const subplaceBudget = stalled.subplaces_page.next_item_text_bytes
      const thingBudget = stalled.things_page.next_item_text_bytes
      const noteBudget = stalled.notes_page.next_item_text_bytes
      assert.ok(stalledSubplaceId && stalledThingId && stalledNoteId)
      assert.ok(subplaceBudget && thingBudget && noteBudget)
      const continuationQuery = new URLSearchParams({
        view: 'full',
        limit: '200',
        subplace_text_limit_bytes: String(subplaceBudget),
        thing_text_limit_bytes: String(thingBudget),
        note_text_limit_bytes: String(noteBudget),
        before_subplace_id: String(stalledSubplaceId),
        before_thing_id: String(stalledThingId),
        before_note_id: String(stalledNoteId),
      })
      const continuedResponse = await cityApp.request(
        `http://city.test/api/place/${city.targetPlaceId}?${continuationQuery}`,
      )
      const continuedText = await continuedResponse.text()
      assert.equal(continuedResponse.status, 200, continuedText)
      const continued = JSON.parse(continuedText) as typeof stalled
      for (const entry of [
        {
          name: 'subplaces',
          rows: continued.subplaces,
          page: continued.subplaces_page,
          nextBefore: continued.subplaces_page.next_before_subplace_id,
          expectedIds: city.expected.subplaces,
        },
        {
          name: 'things',
          rows: continued.things,
          page: continued.things_page,
          nextBefore: continued.things_page.next_before_thing_id,
          expectedIds: city.expected.things,
        },
        {
          name: 'notes',
          rows: continued.notes,
          page: continued.notes_page,
          nextBefore: continued.notes_page.next_before_note_id,
          expectedIds: city.expected.notes,
        },
      ] as const) {
        assert.deepEqual(entry.rows.map(row => row.id), [entry.expectedIds[1]], entry.name)
        assert.equal(entry.nextBefore, entry.expectedIds[1], entry.name)
        assert.equal(entry.page.returned_items, 1, entry.name)
        assert.equal(entry.page.returned_text_bytes, entry.page.text_limit_bytes, entry.name)
        assert.equal(entry.page.stopped_for_text_limit, true, entry.name)
        assert.equal(entry.page.next_item_id, entry.expectedIds[2], entry.name)
      }
      testContext.diagnostic(
        `zero-fit next bytes: child=${subplaceBudget}, thing=${thingBudget}, note=${noteBudget}; ` +
          `stalled response=${Buffer.byteLength(stalledText, 'utf8')}, ` +
          `continued response=${Buffer.byteLength(continuedText, 'utf8')}`,
      )
    })

    await t.test('outline stays small for note-only, child-only, and ordinary small rooms', async testContext => {
      const { default: cityApp } = await import('../../src/index.ts')
      const readOutline = async (placeId: number) => {
        const response = await cityApp.request(`http://city.test/api/place/${placeId}?view=outline`)
        const text = await response.text()
        assert.equal(response.status, 200, text)
        return { text, body: JSON.parse(text) as {
          subplaces: Array<{ description?: string; description_text_bytes: number }>
          things: Array<{ body?: string; body_text_bytes: number }>
          notes: Array<{ body?: string; body_text_bytes: number }>
          subplaces_page: { returned_text_bytes: number; has_more: boolean }
          things_page: { returned_text_bytes: number; has_more: boolean }
          notes_page: { returned_text_bytes: number; has_more: boolean }
        } }
      }

      const noteHeavy = await readOutline(city.noteHeavyPlaceId)
      assert.deepEqual([noteHeavy.body.subplaces.length, noteHeavy.body.things.length], [0, 0])
      assert.equal(noteHeavy.body.notes.length, 10)
      assert.equal(noteHeavy.body.notes.every(note => !Object.hasOwn(note, 'body')), true)
      assert.equal(noteHeavy.body.notes.every(note => note.body_text_bytes > 5_000), true)
      assert.equal(noteHeavy.body.notes_page.returned_text_bytes, 0)
      assert.equal(noteHeavy.body.notes_page.has_more, true)
      assert.ok(Buffer.byteLength(noteHeavy.text, 'utf8') < 5_000)

      const childHeavy = await readOutline(city.childHeavyPlaceId)
      assert.deepEqual([childHeavy.body.things.length, childHeavy.body.notes.length], [0, 0])
      assert.equal(childHeavy.body.subplaces.length, 10)
      assert.equal(childHeavy.body.subplaces.every(place => !Object.hasOwn(place, 'description')), true)
      assert.equal(childHeavy.body.subplaces.every(place => place.description_text_bytes > 4_000), true)
      assert.equal(childHeavy.body.subplaces_page.returned_text_bytes, 0)
      assert.equal(childHeavy.body.subplaces_page.has_more, true)
      assert.ok(Buffer.byteLength(childHeavy.text, 'utf8') < 8_000)

      const small = await readOutline(city.smallPlaceId)
      assert.deepEqual(
        [small.body.subplaces.length, small.body.things.length, small.body.notes.length],
        [1, 1, 1],
      )
      assert.equal(small.body.subplaces.every(place => !Object.hasOwn(place, 'description')), true)
      assert.equal(small.body.things.every(thing => !Object.hasOwn(thing, 'body')), true)
      assert.equal(small.body.notes.every(note => !Object.hasOwn(note, 'body')), true)
      const smallRecordBytes = Object.freeze([
        Buffer.byteLength(SMALL_ROOM_RECORDS.childDescription, 'utf8'),
        Buffer.byteLength(SMALL_ROOM_RECORDS.thingBody, 'utf8'),
        Buffer.byteLength(SMALL_ROOM_RECORDS.noteBody, 'utf8'),
      ])
      assert.deepEqual(
        [
          small.body.subplaces[0]!.description_text_bytes,
          small.body.things[0]!.body_text_bytes,
          small.body.notes[0]!.body_text_bytes,
        ],
        smallRecordBytes,
      )
      assert.equal(smallRecordBytes.every(bytes => bytes < 100), true)
      assert.deepEqual(
        [
          small.body.subplaces_page.has_more,
          small.body.things_page.has_more,
          small.body.notes_page.has_more,
        ],
        [false, false, false],
      )
      assert.deepEqual(
        [
          small.body.subplaces_page.returned_text_bytes,
          small.body.things_page.returned_text_bytes,
          small.body.notes_page.returned_text_bytes,
        ],
        [0, 0, 0],
      )

      const smallFullResponse = await cityApp.request(
        `http://city.test/api/place/${city.smallPlaceId}?view=full`,
      )
      const smallFullText = await smallFullResponse.text()
      assert.equal(smallFullResponse.status, 200, smallFullText)
      const smallFull = JSON.parse(smallFullText) as {
        subplaces: Array<{ description: string }>
        things: Array<{ body: string }>
        notes: Array<{ body: string }>
        subplaces_page: { returned_text_bytes: number; has_more: boolean }
        things_page: { returned_text_bytes: number; has_more: boolean }
        notes_page: { returned_text_bytes: number; has_more: boolean }
      }
      assert.deepEqual(
        smallFull.subplaces.map(place => place.description),
        [SMALL_ROOM_RECORDS.childDescription],
      )
      assert.deepEqual(smallFull.things.map(thing => thing.body), [SMALL_ROOM_RECORDS.thingBody])
      assert.deepEqual(smallFull.notes.map(note => note.body), [SMALL_ROOM_RECORDS.noteBody])
      assert.deepEqual(
        [
          smallFull.subplaces_page.returned_text_bytes,
          smallFull.things_page.returned_text_bytes,
          smallFull.notes_page.returned_text_bytes,
        ],
        smallRecordBytes,
      )
      assert.deepEqual(
        [
          smallFull.subplaces_page.has_more,
          smallFull.things_page.has_more,
          smallFull.notes_page.has_more,
        ],
        [false, false, false],
      )
      testContext.diagnostic(
        `representative outline bytes: note-only=${Buffer.byteLength(noteHeavy.text, 'utf8')}, ` +
          `child-only=${Buffer.byteLength(childHeavy.text, 'utf8')}, ` +
          `small=${Buffer.byteLength(small.text, 'utf8')}; ` +
          `small full=${Buffer.byteLength(smallFullText, 'utf8')}`,
      )
    })

    await t.test('the writer meter matches stored and ordinary first-read room bytes', async () => {
      const { readingCostMeter } = await import('../../src/reading-cost.ts')
      const meter = await readingCostMeter(city.targetPlaceId, 'new body 🏙')
      const expected = (await postgres.client.query<{
        stored_text_bytes: string
        first_read_text_bytes: string
      }>(`
        SELECT
          octet_length(place.description)
            + (SELECT coalesce(sum(octet_length(description)), 0) FROM places WHERE parent_id = place.id)
            + (SELECT coalesce(sum(octet_length(body)), 0) FROM things WHERE place_id = place.id AND withdrawn_at IS NULL)
            + (SELECT coalesce(sum(octet_length(body)), 0) FROM notes WHERE place_id = place.id)
            AS stored_text_bytes,
          octet_length(place.description)
            + (SELECT coalesce(sum(octet_length(description)), 0) FROM (
                SELECT description FROM places WHERE parent_id = place.id ORDER BY id DESC LIMIT 10
              ) subplace_page)
            + (SELECT coalesce(sum(octet_length(body)), 0) FROM (
                SELECT body FROM things WHERE place_id = place.id AND withdrawn_at IS NULL ORDER BY id DESC LIMIT 10
              ) thing_page)
            + (SELECT coalesce(sum(octet_length(body)), 0) FROM (
                SELECT body FROM notes WHERE place_id = place.id ORDER BY id DESC LIMIT 10
              ) note_page)
            AS first_read_text_bytes
        FROM places place WHERE place.id = $1
      `, [city.targetPlaceId])).rows[0]!
      assert.equal(meter.new_item_text_bytes, Buffer.byteLength('new body 🏙', 'utf8'))
      assert.equal(meter.room_stored_text_bytes, Number(expected.stored_text_bytes))
      assert.equal(meter.current_first_read_text_bytes, Number(expected.first_read_text_bytes))
    })

    await t.test('a timed-out writer meter leaves no PostgreSQL work running', async () => {
      const { safeReadingCostMeter } = await import('../../src/reading-cost.ts')
      const blocker = await postgres.client.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('LOCK TABLE place_reading_totals IN ACCESS EXCLUSIVE MODE')
        const startedAt = Date.now()

        const meter = await safeReadingCostMeter(city.targetPlaceId, 'already committed', {
          timeoutMs: 250,
        })

        assert.equal(meter.available, false)
        assert.ok(Date.now() - startedAt < 1_000, 'the informational meter must stay bounded')
        const active = await postgres.client.query<{ count: string }>(`
          SELECT count(*)::text AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND state = 'active'
            AND query LIKE '%public:reading_cost%'
        `)
        assert.equal(active.rows[0]?.count, '0', 'the timed-out meter query must be canceled')
        assert.equal(meter.reason, 'measurement_timeout')
        assert.equal(meter.measurement_timeout_ms, 250)
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined)
        blocker.release()
      }
    })

    await t.test('resident census follows arrival time across every tie-safe page', async (t) => {
      await postgres.client.query(`
        UPDATE residents
        SET joined_at = '2026-08-01T00:00:00Z'::timestamptz
          + (2007 - id) * interval '1 second'
      `)
      await postgres.client.query(`
        UPDATE residents
        SET joined_at = '2026-09-01T00:00:00Z'::timestamptz
        WHERE id IN (2, 3)
      `)
      const expected = (
        await postgres.client.query<{ id: number }>(
          'SELECT id FROM residents ORDER BY joined_at DESC, id DESC',
        )
      ).rows.map(row => row.id)

      const { default: cityApp } = await import('../../src/index.ts')
      const statementsBeforeDefaultCensus = statementCount
      const defaultResponse = await cityApp.request('http://city.test/api/residents')
      assert.equal(defaultResponse.status, 200)
      assert.equal(
        statementCount - statementsBeforeDefaultCensus,
        3,
        'two local safety settings and one exact census statement share one transaction',
      )
      const defaultBody = await defaultResponse.json() as {
        residents: Array<{ id: number }>
        count: number
        total: number
        returned: number
        page_size: number
        has_more: boolean
        next_before_id: number | null
      }
      assert.equal(defaultBody.residents.length, 200)
      assert.equal(defaultBody.count, expected.length)
      assert.equal(defaultBody.total, expected.length)
      assert.equal(defaultBody.returned, 200)
      assert.equal(defaultBody.page_size, 200)
      assert.equal(defaultBody.has_more, true)
      assert.equal(defaultBody.next_before_id, expected[199])
      assert.equal(Object.hasOwn(defaultBody, 'view'), false)
      assert.deepEqual(
        Object.keys(defaultBody.residents[0] ?? {}).sort(),
        ['handle', 'id', 'joined_at', 'model'],
        'the no-query census must retain its exact legacy resident fields',
      )

      const actual: number[] = []
      let cursor: number | null = null
      do {
        const query = new URLSearchParams({ limit: '37' })
        if (cursor !== null) query.set('before_id', String(cursor))
        const response = await cityApp.request(`http://city.test/api/residents?${query}`)
        assert.equal(response.status, 200)
        const body = await response.json() as {
          residents: Array<{ id: number }>
          count: number
          total: number
          returned: number
          page_size: number
          has_more: boolean
          next_before_id: number | null
        }
        assert.equal(body.count, expected.length)
        assert.equal(body.total, expected.length)
        assert.equal(body.returned, body.residents.length)
        assert.equal(body.page_size, 37)
        actual.push(...body.residents.map(row => row.id))
        cursor = body.has_more ? body.next_before_id : null
      } while (cursor !== null)

      assert.deepEqual(actual, expected)
      assert.deepEqual(actual.slice(0, 3), [3, 2, 1], 'joined_at wins; id only breaks ties')
      assert.equal(new Set(actual).size, actual.length, 'page boundaries must not repeat residents')

      const exhaustedResponse = await cityApp.request(
        `http://city.test/api/residents?limit=37&before_id=${expected.at(-1)}`,
      )
      assert.equal(exhaustedResponse.status, 200)
      const exhausted = await exhaustedResponse.json() as typeof defaultBody
      assert.deepEqual(exhausted.residents, [])
      assert.equal(exhausted.count, expected.length)
      assert.equal(exhausted.total, expected.length)
      assert.equal(exhausted.returned, 0)
      assert.equal(exhausted.page_size, 37)
      assert.equal(exhausted.has_more, false)
      assert.equal(exhausted.next_before_id, null)

      const presenceIds: number[] = []
      let presenceCursor: number | null = null
      let firstPresenceBytes: number | null = null
      do {
        const query = new URLSearchParams({ view: 'presence', limit: '37' })
        if (presenceCursor !== null) query.set('before_id', String(presenceCursor))
        const response = await cityApp.request(`http://city.test/api/residents?${query}`)
        assert.equal(response.status, 200)
        const body = await response.json() as {
          residents: Array<{
            id: number
            handle: string
            model: string
            joined_at: string
            current_place_id: number | null
            asleep: boolean
          }>
          count: number
          total: number
          returned: number
          page_size: number
          total_items: number
          has_more: boolean
          next_before_id: number | null
        }
        firstPresenceBytes ??= Buffer.byteLength(JSON.stringify(body), 'utf8')
        assert.equal(body.count, expected.length)
        assert.equal(body.total, expected.length)
        assert.equal(body.total_items, expected.length)
        assert.equal(body.returned, body.residents.length)
        assert.equal(body.page_size, 37)
        assert.equal(
          body.residents.every(resident => (
            resident.current_place_id === city.targetPlaceId && typeof resident.asleep === 'boolean'
          )),
          true,
          'presence pages add location and sleep state without dropping census fields',
        )
        presenceIds.push(...body.residents.map(resident => resident.id))
        presenceCursor = body.has_more ? body.next_before_id : null
      } while (presenceCursor !== null)

      assert.deepEqual(presenceIds, expected)
      assert.equal(
        new Set(presenceIds).size,
        presenceIds.length,
        'presence cursor pages must neither repeat nor skip residents',
      )
      t.diagnostic(`Wave 4 presence first-page bytes (37 residents): ${firstPresenceBytes}`)
    })

    await t.test('the public map keeps full compatibility and outlines every branch child once', async (t) => {
      const { default: cityApp } = await import('../../src/index.ts')

      const legacyResponse = await cityApp.request('http://city.test/api/map')
      assert.equal(legacyResponse.status, 200)
      const legacy = await legacyResponse.json() as { places: unknown[] }
      assert.deepEqual(Object.keys(legacy), ['places'])
      assert.equal(placeTreeCount(legacy.places), city.placeCount)

      const explicitFullResponse = await cityApp.request('http://city.test/api/map?view=full')
      assert.equal(explicitFullResponse.status, 200)
      const explicitFull = await explicitFullResponse.json() as {
        view: string
        places: unknown[]
      }
      assert.equal(explicitFull.view, 'full')
      assert.deepEqual(explicitFull.places, legacy.places)

      type OutlinePlace = {
        id: number
        parent_id: number | null
        places: number
        things: number
        notes: number
        children: unknown[]
      }
      type OutlineBody = {
        view: string
        place: OutlinePlace
        subplaces: OutlinePlace[]
        subplaces_page: {
          total_items: number
          total_text_bytes: number
          returned_items: number
          returned_text_bytes: number
          has_more: boolean
          next_before_subplace_id: number | null
        }
        map_complete: boolean
      }

      const worldResponse = await cityApp.request(
        'http://city.test/api/map?view=outline&subplace_limit=10',
      )
      assert.equal(worldResponse.status, 200)
      const world = await worldResponse.json() as OutlineBody
      assert.equal(world.view, 'outline')
      assert.equal(world.place.id, city.worldPlaceId)
      assert.equal(world.place.parent_id, null)
      assert.deepEqual(world.place.children, [])
      assert.deepEqual(
        world.subplaces.map(place => place.id),
        city.expected.worldSubplaces.slice(0, 10),
      )
      assert.equal(
        world.subplaces.every(place => (
          place.parent_id === city.worldPlaceId &&
          Array.isArray(place.children) &&
          place.children.length === 0
        )),
        true,
        'outline rows stay flat even when their child counts are nonzero',
      )
      assert.equal(world.subplaces_page.total_items, city.expected.worldSubplaces.length)
      assert.equal(world.subplaces_page.returned_items, 10)
      assert.equal(world.subplaces_page.returned_text_bytes, 0)
      assert.equal(world.subplaces_page.has_more, true)
      assert.equal(
        world.subplaces_page.next_before_subplace_id,
        city.expected.worldSubplaces[9],
      )
      assert.ok(Number.isSafeInteger(world.subplaces_page.total_text_bytes))
      assert.equal(world.map_complete, false)

      const actual: number[] = []
      let cursor: number | null = null
      let firstBranchBytes: number | null = null
      do {
        const query = new URLSearchParams({
          view: 'outline',
          parent_id: String(city.mapBranchPlaceId),
          subplace_limit: '37',
        })
        if (cursor !== null) query.set('before_subplace_id', String(cursor))
        const response = await cityApp.request(`http://city.test/api/map?${query}`)
        assert.equal(response.status, 200)
        const body = await response.json() as OutlineBody
        firstBranchBytes ??= Buffer.byteLength(JSON.stringify(body), 'utf8')
        assert.equal(body.place.id, city.mapBranchPlaceId)
        assert.deepEqual(body.place.children, [])
        assert.equal(body.subplaces_page.total_items, city.expected.mapSubplaces.length)
        assert.equal(body.subplaces_page.returned_items, body.subplaces.length)
        assert.equal(body.subplaces_page.returned_text_bytes, 0)
        assert.equal(body.subplaces.length <= 37, true)
        assert.equal(
          body.subplaces.every(place => (
            place.parent_id === city.mapBranchPlaceId &&
            Array.isArray(place.children) &&
            place.children.length === 0
          )),
          true,
        )
        actual.push(...body.subplaces.map(place => place.id))
        if (body.subplaces_page.has_more) {
          assert.ok(body.subplaces_page.next_before_subplace_id)
          cursor = body.subplaces_page.next_before_subplace_id
        } else {
          assert.equal(body.subplaces_page.next_before_subplace_id, null)
          cursor = null
        }
      } while (cursor !== null)

      assert.deepEqual(actual, city.expected.mapSubplaces)
      assert.equal(
        new Set(actual).size,
        actual.length,
        'outline cursor pages must neither repeat nor skip direct children',
      )
      t.diagnostic(
        `Wave 4 map bytes: legacy=${Buffer.byteLength(JSON.stringify(legacy), 'utf8')}, ` +
        `root-outline=${Buffer.byteLength(JSON.stringify(world), 'utf8')}, ` +
        `branch-page-37=${firstBranchBytes}`,
      )
    })

    await t.test('the window preserves full snapshots and bounds its explicit outline', async (t) => {
      const windowModule: WindowModule = await import('../../src/window.ts')
      const app = new Hono()
      app.get('/api/window', windowModule.windowSnapshot)

      type WindowPlace = {
        id: number
        parent_id: number | null
        children: WindowPlace[]
      }
      type WindowResident = {
        id: number
        current_place_id: number | null
        asleep: boolean
      }
      type WindowSnapshotBody = {
        view?: string
        places: WindowPlace[]
        residents: WindowResident[]
        notes: Array<{ id: number }>
        things: Array<{ id: number }>
        agreements: Array<{ id: number }>
        events: Array<{ id: number }>
        live_survey?: Array<{ id: number; parent_id: number | null; things: number }>
        pages: {
          places?: { has_more: boolean; next_before_subplace_id: number | null }
          residents?: { has_more: boolean; next_before_id: number | null }
          notes: { has_more: boolean; next_before_id: number | null }
          things: { has_more: boolean; next_before_id: number | null }
          agreements: { has_more: boolean; next_before_id: number | null }
          events: { has_more: boolean; next_before_id: number | null }
        }
        shown: Record<string, number>
        totals: Record<string, number>
        limits: Record<string, number | null>
      }

      const legacyResponse = await app.request('http://city.test/api/window')
      assert.equal(legacyResponse.status, 200)
      const legacy = await legacyResponse.json() as WindowSnapshotBody
      assert.equal(Object.hasOwn(legacy, 'view'), false)
      assert.equal(Object.hasOwn(legacy, 'live_survey'), false)
      assert.equal(placeTreeCount(legacy.places), city.placeCount)
      assert.equal(legacy.residents.length, city.residentCount)

      const explicitFullResponse = await app.request('http://city.test/api/window?view=full')
      assert.equal(explicitFullResponse.status, 200)
      const explicitFull = await explicitFullResponse.json() as WindowSnapshotBody
      assert.equal(explicitFull.view, 'full')
      assert.equal(Object.hasOwn(explicitFull, 'live_survey'), false)
      for (const collection of [
        'places', 'residents', 'notes', 'things', 'agreements', 'events',
      ] as const) {
        assert.deepEqual(explicitFull[collection], legacy[collection], collection)
      }

      const outlineResponse = await app.request('http://city.test/api/window?view=outline')
      assert.equal(outlineResponse.status, 200)
      const snapshot = await outlineResponse.json() as WindowSnapshotBody
      assert.equal(snapshot.view, 'outline')
      const expectedLiveSurvey = (
        await postgres.client.query<{ id: number; parent_id: number | null; things: number }>(`
          SELECT place.id, place.parent_id, totals.thing_items AS things
          FROM places place
          JOIN place_reading_totals totals ON totals.place_id = place.id
          ORDER BY place.id
        `)
      ).rows
      assert.deepEqual(snapshot.live_survey, expectedLiveSurvey)
      assert.equal(snapshot.live_survey?.every(place =>
        Object.keys(place).sort().join(',') === 'id,parent_id,things'), true)
      assert.equal(snapshot.places.length, 1)
      assert.equal(snapshot.places[0]?.id, city.worldPlaceId)
      assert.deepEqual(
        snapshot.places[0]?.children.map(place => place.id),
        city.expected.worldSubplaces.slice(0, 10),
      )
      assert.equal(placeTreeCount(snapshot.places), 11, 'the root plus ten children are shown')
      assert.equal(snapshot.residents.length, 25)
      const expectedResidentIds = (
        await postgres.client.query<{ id: number }>(
          'SELECT id FROM residents ORDER BY joined_at DESC, id DESC LIMIT 25',
        )
      ).rows.map(row => row.id)
      assert.deepEqual(snapshot.residents.map(resident => resident.id), expectedResidentIds)
      assert.equal(
        snapshot.residents.every(resident => (
          resident.current_place_id === city.targetPlaceId && typeof resident.asleep === 'boolean'
        )),
        true,
      )
      assert.deepEqual(
        {
          notes: snapshot.notes.length,
          things: snapshot.things.length,
          agreements: snapshot.agreements.length,
          events: snapshot.events.length,
        },
        { notes: 10, things: 10, agreements: 10, events: 10 },
      )
      for (const collection of ['notes', 'things', 'agreements', 'events'] as const) {
        assert.deepEqual(snapshot[collection], legacy[collection], `${collection} stays unchanged`)
      }
      for (const collection of ['notes', 'things', 'agreements', 'events'] as const) {
        assert.equal(snapshot.pages[collection].has_more, true, collection)
      }
      assert.equal(snapshot.pages.places?.has_more, true)
      assert.equal(
        snapshot.pages.places?.next_before_subplace_id,
        city.expected.worldSubplaces[9],
      )
      assert.equal(snapshot.pages.residents?.has_more, true)
      assert.equal(
        snapshot.pages.residents?.next_before_id,
        snapshot.residents.at(-1)?.id,
      )
      assert.equal(snapshot.shown.places, 11)
      assert.equal(snapshot.shown.residents, 25)
      assert.equal(snapshot.shown.conversations, 10)
      assert.equal(snapshot.shown.things, 10)
      assert.equal(snapshot.shown.agreements, 10)
      assert.equal(snapshot.shown.events, 10)
      assert.equal(snapshot.totals.places, city.placeCount)
      assert.equal(snapshot.totals.residents, city.residentCount)
      assert.equal(snapshot.limits.places, 10)
      assert.equal(snapshot.limits.residents, 25)
      assert.equal(snapshot.limits.conversations, 10)
      assert.equal(snapshot.limits.things, 10)
      assert.equal(snapshot.limits.agreements, 10)
      assert.equal(snapshot.limits.events, 10)
      t.diagnostic(
        `Wave 4 window bytes: legacy=${Buffer.byteLength(JSON.stringify(legacy), 'utf8')}, ` +
        `outline=${Buffer.byteLength(JSON.stringify(snapshot), 'utf8')}; ` +
        `shown places=${snapshot.shown.places}, residents=${snapshot.shown.residents}; ` +
        `place_cursor=${snapshot.pages.places?.next_before_subplace_id}, ` +
        `resident_cursor=${snapshot.pages.residents?.next_before_id}`,
      )

      const notesPage = snapshot.pages.notes
      assert.ok(notesPage)
      const olderNotesResponse = await app.request(
        `http://city.test/api/window?collection=notes&before_id=${notesPage.next_before_id}&limit=50`,
      )
      assert.equal(olderNotesResponse.status, 200)
      const olderNotes = await olderNotesResponse.json() as {
        notes: Array<{ id: number }>
        has_more: boolean
        next_before_id: number | null
      }
      assert.equal(olderNotes.notes.length, 50)
      assert.equal(olderNotes.has_more, true)

      const oldestNotesResponse = await app.request(
        `http://city.test/api/window?collection=notes&before_id=${olderNotes.next_before_id}&limit=50`,
      )
      assert.equal(oldestNotesResponse.status, 200)
      const oldestNotes = await oldestNotesResponse.json() as {
        notes: Array<{ id: number }>
        has_more: boolean
        next_before_id: number | null
      }
      assert.equal(oldestNotes.notes.length, city.expected.allNotes.length - 60)
      assert.equal(oldestNotes.has_more, false)
      assert.deepEqual(
        [
          ...snapshot.notes.map(row => row.id),
          ...olderNotes.notes.map(row => row.id),
          ...oldestNotes.notes.map(row => row.id),
        ],
        city.expected.allNotes,
      )

      const statementsBeforeInvalidRequest = statementCount
      const invalidResponse = await app.request(
        'http://city.test/api/window?collection=notes&limit=0',
      )
      assert.equal(invalidResponse.status, 400)
      assert.equal(
        statementCount,
        statementsBeforeInvalidRequest,
        'an invalid public page must be rejected before PostgreSQL is queried',
      )
    })

    await t.test('counter triggers stay exact across edits, moves, withdrawals, and concurrent notes', async () => {
      const childId = city.expected.subplaces[0]!
      const thingId = city.expected.things[0]!
      await postgres.client.query(
        `UPDATE places SET description = description || ' edited 🏙' WHERE id = $1`,
        [childId],
      )
      await postgres.client.query(
        `UPDATE things SET body = body || ' edited 🏙' WHERE id = $1`,
        [thingId],
      )
      await Promise.all([
        postgres.client.query(
          `INSERT INTO notes (place_id, author_id, body) VALUES ($1, 1, 'parallel one 🏙')`,
          [childId],
        ),
        postgres.client.query(
          `INSERT INTO notes (place_id, author_id, body) VALUES ($1, 1, 'parallel two 🏙')`,
          [childId],
        ),
      ])
      const movingThings = (await postgres.client.query<{ id: number; place_id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'opposite move a', 'move a 🏙', 1, 1),
          ($2, 'opposite move b', 'move b 🏙', 1, 1)
        RETURNING id, place_id
      `, [city.targetPlaceId, childId])).rows
      await postgres.client.query(`
        CREATE OR REPLACE FUNCTION wave_one_pause_counter_update()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(0.1);
          RETURN NEW;
        END$$;
        CREATE TRIGGER wave_one_pause_counter_update
        AFTER UPDATE OF thing_items ON place_reading_totals
        FOR EACH ROW
        WHEN (OLD.thing_items IS DISTINCT FROM NEW.thing_items)
        EXECUTE FUNCTION wave_one_pause_counter_update();
      `)
      let oppositeMoves: PromiseSettledResult<unknown>[]
      try {
        oppositeMoves = await Promise.allSettled([
          postgres.client.query(
            `UPDATE things SET place_id = $1 WHERE id = $2`,
            [childId, movingThings.find(row => row.place_id === city.targetPlaceId)?.id],
          ),
          postgres.client.query(
            `UPDATE things SET place_id = $1 WHERE id = $2`,
            [city.targetPlaceId, movingThings.find(row => row.place_id === childId)?.id],
          ),
        ])
      } finally {
        await postgres.client.query(`
          DROP TRIGGER wave_one_pause_counter_update ON place_reading_totals;
          DROP FUNCTION wave_one_pause_counter_update();
        `)
      }
      assert.deepEqual(
        oppositeMoves.map(result => result.status),
        ['fulfilled', 'fulfilled'],
        'opposite room moves must not deadlock their counter rows',
      )
      await postgres.client.query(`UPDATE things SET place_id = $1 WHERE id = $2`, [childId, thingId])
      await postgres.client.query(`UPDATE things SET withdrawn_at = now() WHERE id = $1`, [thingId])

      for (const placeId of [city.targetPlaceId, childId]) {
        const totals = (await postgres.client.query<Record<string, string>>(
          `SELECT * FROM place_reading_totals WHERE place_id = $1`,
          [placeId],
        )).rows[0]!
        const recomputed = (await postgres.client.query<Record<string, string>>(`
          SELECT
            (SELECT count(*) FROM places WHERE parent_id = $1) AS subplace_items,
            (SELECT coalesce(sum(octet_length(description)), 0) FROM places WHERE parent_id = $1) AS subplace_text_bytes,
            (SELECT count(*) FROM things WHERE place_id = $1 AND withdrawn_at IS NULL) AS thing_items,
            (SELECT coalesce(sum(octet_length(body)), 0) FROM things WHERE place_id = $1 AND withdrawn_at IS NULL) AS thing_text_bytes,
            (SELECT count(*) FROM notes WHERE place_id = $1) AS note_items,
            (SELECT coalesce(sum(octet_length(body)), 0) FROM notes WHERE place_id = $1) AS note_text_bytes
        `, [placeId])).rows[0]!
        for (const field of [
          'subplace_items', 'subplace_text_bytes', 'thing_items',
          'thing_text_bytes', 'note_items', 'note_text_bytes',
        ]) {
          assert.equal(Number(totals[field]), Number(recomputed[field]), `${placeId}:${field}`)
        }
      }
    })

    await t.test('catalog pages report exact authored-text totals from real PostgreSQL', async () => {
      await postgres.client.query(`
        INSERT INTO traits (name, description, coiner_id)
        VALUES ('wave_one_trait', 'trait text 🏙', 1)
      `)
      await postgres.client.query(`
        WITH kind AS (
          INSERT INTO kinds (name, owner_id)
          VALUES ('wave_one_kind', 1)
          RETURNING id
        )
        INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
        SELECT id, 1, 'kind text 🏙', ARRAY['wave_one_trait'], '[]'::jsonb
        FROM kind
      `)
      await postgres.client.query(
        `INSERT INTO moderation_actions (
           target_type, target_id, action, actor_id, reason
         ) VALUES ('note', $1, 'remove', 1, 'reason text 🏙')`,
        [city.expected.notes[0]],
      )

      const { default: cityApp } = await import('../../src/index.ts')
      const cases = [
        { path: '/api/events?limit=1', key: 'events', table: 'events', expression: "coalesce(detail->>'body', '') || coalesce(detail->>'description', '') || coalesce(detail->>'reason', '')" },
        { path: '/api/kinds?limit=1', key: 'kinds', table: 'kinds JOIN kind_revisions revision ON revision.kind_id = kinds.id AND revision.revision = kinds.current_revision', expression: 'revision.description' },
        { path: '/api/traits?limit=1', key: 'traits', table: 'traits', expression: 'description' },
        { path: '/api/agreements?limit=1', key: 'agreements', table: 'agreements', expression: 'body' },
        { path: '/api/moderation?limit=1', key: 'moderation', table: 'moderation_actions', expression: 'reason' },
      ] as const

      for (const entry of cases) {
        const expected = (await postgres.client.query<{ items: string; text_bytes: string }>(
          `SELECT count(*) AS items,
             coalesce(sum(octet_length(${entry.expression})), 0) AS text_bytes
           FROM ${entry.table}`,
        )).rows[0]!
        const response = await cityApp.request(`http://city.test${entry.path}`)
        assert.equal(response.status, 200, entry.path)
        const body = await response.json() as Record<string, unknown>
        const rows = body[entry.key] as Array<Record<string, unknown>>
        assert.equal(body.total_items, Number(expected.items), `${entry.key}:items`)
        assert.equal(body.total_text_bytes, Number(expected.text_bytes), `${entry.key}:bytes`)
        assert.equal(body.returned_items, rows.length, `${entry.key}:returned`)
        assert.equal(body.has_more, Number(expected.items) > rows.length, `${entry.key}:has_more`)
      }
    })

    await t.test('event filters narrow by actor and by observed place', async () => {
      const client = postgres.client
      const otherPlace = (await client.query<{ id: number }>(
        `SELECT id FROM places WHERE name = 'Map sibling 1'`,
      )).rows[0]!.id
      const watchedThing = (await client.query<{ id: number }>(
        `SELECT id FROM things WHERE place_id = $1 ORDER BY id LIMIT 1`,
        [city.targetPlaceId],
      )).rows[0]!.id
      const watchedNote = (await client.query<{ id: number }>(
        `SELECT id FROM notes WHERE place_id = $1 ORDER BY id LIMIT 1`,
        [city.targetPlaceId],
      )).rows[0]!.id

      const withdrawnThing = (await client.query<{ id: number }>(
        `INSERT INTO things (place_id, name, body, owner_id, maker_id, withdrawn_at)
         VALUES ($1, 'withdrawn-lantern', 'no longer here', 1, 1, now())
         RETURNING id`,
        [city.targetPlaceId],
      )).rows[0]!.id
      const offerId = (await client.query<{ id: number }>(
        `INSERT INTO transfer_offers (
           channel, asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet
         ) VALUES ('direct', 'thing', $1, 1, 2, 1, '0x' || repeat('a', 40))
         RETURNING id`,
        [watchedThing],
      )).rows[0]!.id

      const seed = async (kind: string, actor: string, detail: object) => (
        await client.query<{ id: number }>(
          `INSERT INTO events (kind, actor, detail) VALUES ($1, $2, $3::jsonb) RETURNING id`,
          [kind, actor, JSON.stringify(detail)],
        )
      ).rows[0]!.id
      const lawHere = await seed('laws_changed', 'resident-2', { place_id: city.targetPlaceId })
      const lawElsewhere = await seed('laws_changed', 'resident-2', { place_id: otherPlace })
      const thingEdit = await seed('thing_edited', 'resident-3', { thing_id: watchedThing })
      const noteEcho = await seed('note', 'resident-2', { note_id: watchedNote })
      const malformed = await seed('thing_edited', 'resident-3', { thing_id: 'not-a-number' })
      const giftHere = await seed('transfer', 'resident-3', {
        asset_type: 'thing', asset_id: watchedThing, transfer_id: 90, mode: 'gift',
      })
      const placeSale = await seed('sale', 'resident-3', {
        asset_type: 'place', asset_id: city.targetPlaceId, transfer_id: 91,
      })
      const effectMove = await seed('transfer', 'resident-3', {
        type: 'thing', id: watchedThing, mode: 'effect',
      })
      const offerCancel = await seed('transfer_cancel', 'resident-3', { offer_id: offerId })
      const withdrawnEdit = await seed('thing_edited', 'resident-3', { thing_id: withdrawnThing })
      const marketSale = await seed('world_sale', 'resident-3', {
        thing_id: watchedThing, offer_id: offerId, transfer_id: 1,
      })

      const firstPage = (cursor: number | null = null): PublicPage => {
        const parsed = parsePublicPage(
          cursor == null ? {} : { before_id: [String(cursor)] }, 'before_id', 'limit',
        )
        assert.ok(parsed.ok)
        return parsed
      }
      const executePublicQuery: PublicQueryExecutor = async (text, params) =>
        sql.query(text, params)

      const byActor = await loadPublicEventRows(
        executePublicQuery,
        { kind: null, actor: 'resident-2', placeId: null },
        firstPage(),
      )
      assert.deepEqual(rowIds(byActor), [noteEcho, lawElsewhere, lawHere])

      // The place filter must see every shape of place evidence — the place
      // named directly, a thing standing there, a note written there, a
      // traded asset there (sale/gift asset_type+asset_id, effect transfer
      // type+id, offer events by offer_id) — and must skip the same actor's
      // act at a different place, a permanently withdrawn thing, and a
      // malformed string id (ignored, never a cast error).
      const byPlace = await loadPublicEventRows(
        executePublicQuery,
        { kind: null, actor: null, placeId: city.targetPlaceId },
        firstPage(),
      )
      const byPlaceIds = rowIds(byPlace)
      assert.deepEqual(
        byPlaceIds.slice(0, 8),
        [marketSale, offerCancel, effectMove, placeSale, giftHere, noteEcho, thingEdit, lawHere],
      )
      assert.ok(!byPlaceIds.includes(lawElsewhere))
      assert.ok(!byPlaceIds.includes(malformed))
      assert.ok(!byPlaceIds.includes(withdrawnEdit))

      const combined = await loadPublicEventRows(
        executePublicQuery,
        { kind: 'laws_changed', actor: 'resident-2', placeId: city.targetPlaceId },
        firstPage(),
      )
      assert.deepEqual(rowIds(combined), [lawHere])

      const completePage = Object.freeze({
        ok: true as const,
        cursor: null,
        limit: 200,
        fetchLimit: 201,
      })
      for (const kind of [null, 'laws_changed']) {
        for (const actor of [null, 'resident-2']) {
          for (const placeId of [null, city.targetPlaceId]) {
            const collection = await loadPublicEventCollectionRows(
              executePublicQuery,
              { kind, actor, placeId },
              completePage,
            )
            const label = JSON.stringify({ kind, actor, placeId })
            assert.equal(collection.total.items, collection.rows.length, `${label}:items`)
            assert.equal(
              collection.total.textBytes,
              eventDetailTextBytes(collection.rows),
              `${label}:bytes`,
            )
          }
        }
      }

      const expiredNote = await client.query<{ id: number }>(
        `INSERT INTO events (kind, actor, detail, at)
         VALUES ('note', 'resident-2', '{}'::jsonb, now() - interval '31 minutes')
         RETURNING id`,
      )
      const recentEvents = await loadPublicEventCollectionRows(
        executePublicQuery,
        { kind: 'note', actor: 'resident-2', placeId: null, withinSeconds: 1_800 },
        completePage,
      )
      assert.ok(recentEvents.rows.some(row => row.id === noteEcho))
      assert.ok(!recentEvents.rows.some(row => row.id === expiredNote.rows[0]!.id))
      assert.ok(recentEvents.rows.every(row => typeof row.change_id === 'string'))

      // Market-bridge kinds are public window life: the snapshot must carry
      // them once its 30-second module cache expires.
      const windowModule: WindowModule = await import('../../src/window.ts')
      const app = new Hono()
      app.get('/api/window', windowModule.windowSnapshot)
      const realDateNow = Date.now
      Date.now = () => realDateNow() + 31_000
      try {
        const response = await app.request('http://city.test/api/window')
        assert.equal(response.status, 200)
        const snapshot = await response.json() as {
          events: Array<{ id: number; kind: string; actor: string }>
        }
        const sale = snapshot.events.find(event => event.id === marketSale)
        assert.ok(sale, 'a world market sale must appear in the public window')
        assert.equal(sale.kind, 'world_sale')
        assert.equal(sale.actor, 'resident-3')
      } finally {
        Date.now = realDateNow
      }
    })

    await t.test('inside-place history includes the selected place and nested rooms while exact history stays exact', async () => {
      const client = await postgres.client.connect()
      try {
        await client.query('BEGIN')
        const nestedPlaceId = (await client.query<{ id: number }>(
          `INSERT INTO places (parent_id, place_kind, name, owner_id)
           VALUES ($1, 'place', 'Inside-history child', 1)
           RETURNING id`,
          [city.targetPlaceId],
        )).rows[0]!.id

        const rootNoteId = (await client.query<{ id: number }>(
          `INSERT INTO notes (place_id, author_id, body)
           VALUES ($1, 1, 'inside-history root note') RETURNING id`,
          [city.targetPlaceId],
        )).rows[0]!.id
        const nestedNoteId = (await client.query<{ id: number }>(
          `INSERT INTO notes (place_id, author_id, body)
           VALUES ($1, 1, 'inside-history nested note') RETURNING id`,
          [nestedPlaceId],
        )).rows[0]!.id
        const outsideNoteId = (await client.query<{ id: number }>(
          `INSERT INTO notes (place_id, author_id, body)
           VALUES ($1, 1, 'inside-history outside note') RETURNING id`,
          [city.smallPlaceId],
        )).rows[0]!.id

        const rootThingId = (await client.query<{ id: number }>(
          `INSERT INTO things (place_id, name, body, owner_id, maker_id)
           VALUES ($1, 'inside-history-root-thing', 'root thing', 1, 1) RETURNING id`,
          [city.targetPlaceId],
        )).rows[0]!.id
        const nestedThingId = (await client.query<{ id: number }>(
          `INSERT INTO things (place_id, name, body, owner_id, maker_id)
           VALUES ($1, 'inside-history-nested-thing', 'nested thing', 1, 1) RETURNING id`,
          [nestedPlaceId],
        )).rows[0]!.id
        const outsideThingId = (await client.query<{ id: number }>(
          `INSERT INTO things (place_id, name, body, owner_id, maker_id)
           VALUES ($1, 'inside-history-outside-thing', 'outside thing', 1, 1) RETURNING id`,
          [city.smallPlaceId],
        )).rows[0]!.id

        const rootEventId = (await client.query<{ id: number }>(
          `INSERT INTO events (kind, actor, detail)
           VALUES ('laws_changed', 'resident-1', jsonb_build_object('place_id', $1::integer))
           RETURNING id`,
          [city.targetPlaceId],
        )).rows[0]!.id
        const nestedEventId = (await client.query<{ id: number }>(
          `INSERT INTO events (kind, actor, detail)
           VALUES ('laws_changed', 'resident-1', jsonb_build_object('place_id', $1::integer))
           RETURNING id`,
          [nestedPlaceId],
        )).rows[0]!.id
        const outsideEventId = (await client.query<{ id: number }>(
          `INSERT INTO events (kind, actor, detail)
           VALUES ('laws_changed', 'resident-1', jsonb_build_object('place_id', $1::integer))
           RETURNING id`,
          [city.smallPlaceId],
        )).rows[0]!.id

        const transactionQuery: PublicQueryExecutor = async (text, values) => (
          await client.query(text, [...values])
        ).rows as Record<string, unknown>[]
        const windowModule: WindowModule = await import('../../src/window.ts')
        const historyQuery = (
          collection: 'notes' | 'things',
          includeDescendants: boolean,
        ) => Object.freeze({
          collection,
          beforeId: null,
          limit: 200,
          placeId: city.targetPlaceId,
          includeDescendants,
          resident: null,
          context: false,
        })

        const exactNotes = await windowModule.readWindowCollectionPage(
          historyQuery('notes', false), transactionQuery,
        )
        const insideNotes = await windowModule.readWindowCollectionPage(
          historyQuery('notes', true), transactionQuery,
        )
        const exactThings = await windowModule.readWindowCollectionPage(
          historyQuery('things', false), transactionQuery,
        )
        const insideThings = await windowModule.readWindowCollectionPage(
          historyQuery('things', true), transactionQuery,
        )

        const assertExactAndInside = (
          exactIds: readonly number[],
          insideIds: readonly number[],
          rootId: number,
          nestedId: number,
          outsideId: number,
        ) => {
          assert.ok(exactIds.includes(rootId))
          assert.ok(!exactIds.includes(nestedId))
          assert.ok(!exactIds.includes(outsideId))
          assert.ok(insideIds.includes(rootId))
          assert.ok(insideIds.includes(nestedId))
          assert.ok(!insideIds.includes(outsideId))
        }
        assertExactAndInside(
          exactNotes.items.map(item => item.id), insideNotes.items.map(item => item.id),
          rootNoteId, nestedNoteId, outsideNoteId,
        )
        assertExactAndInside(
          exactThings.items.map(item => item.id), insideThings.items.map(item => item.id),
          rootThingId, nestedThingId, outsideThingId,
        )

        const exactEvents = await loadPublicEventRows(
          transactionQuery,
          { kind: 'laws_changed', actor: 'resident-1', placeId: city.targetPlaceId },
          page(null, 200),
        )
        const insideEvents = await loadPublicEventRows(
          transactionQuery,
          {
            kind: 'laws_changed', actor: 'resident-1', placeId: city.targetPlaceId,
            includeDescendants: true,
          },
          page(null, 200),
        )
        assertExactAndInside(
          rowIds(exactEvents), rowIds(insideEvents),
          rootEventId, nestedEventId, outsideEventId,
        )
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    await t.test('agreement party and open filters keep exact totals in every combination', async () => {
      const { default: cityApp } = await import('../../src/index.ts')
      for (const party of [null, 'resident-1']) {
        for (const open of [true, false]) {
          const query = new URLSearchParams({ limit: '200', open: String(open) })
          if (party !== null) query.set('party', party)
          const response = await cityApp.request(`http://city.test/api/agreements?${query}`)
          assert.equal(response.status, 200)
          const body = await response.json() as {
            agreements: Array<{ body: string }>
            total_items: number
            total_text_bytes: number
            returned_items: number
            returned_text_bytes: number
          }
          const returnedBytes = body.agreements.reduce(
            (total, agreement) => total + Buffer.byteLength(agreement.body, 'utf8'),
            0,
          )
          const label = JSON.stringify({ party, open })
          assert.equal(body.total_items, body.agreements.length, `${label}:items`)
          assert.equal(body.returned_items, body.agreements.length, `${label}:returned items`)
          assert.equal(body.total_text_bytes, returnedBytes, `${label}:bytes`)
          assert.equal(body.returned_text_bytes, returnedBytes, `${label}:returned bytes`)
        }
      }
    })

    await t.test('a followed resident view carries same-place context', async () => {
      const client = postgres.client
      const room = (await client.query<{ id: number }>(
        `INSERT INTO places (parent_id, place_kind, name, owner_id)
         SELECT id, 'place', 'Context Room', 1
         FROM places WHERE name = 'Pagination Continent'
         RETURNING id`,
      )).rows[0]!.id
      const quietRoom = (await client.query<{ id: number }>(
        `INSERT INTO places (parent_id, place_kind, name, owner_id)
         SELECT id, 'place', 'Quiet Room', 1
         FROM places WHERE name = 'Pagination Continent'
         RETURNING id`,
      )).rows[0]!.id
      const say = async (placeId: number, residentId: number, body: string) => (
        await client.query<{ id: number }>(
          `INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
          [placeId, residentId, body],
        )
      ).rows[0]!.id
      // resident-5 speaks twice in the room and once in a second room; others
      // answer around them; an unrelated room stays out of the slice.
      const before = await say(room, 6, 'the question before')
      const own1 = await say(room, 5, 'first own note')
      const reply1 = await say(room, 7, 'an answer right after')
      const drift = await say(room, 7, 'the room drifts on')
      const own2 = await say(room, 5, 'second own note')
      const reply2 = await say(room, 6, 'a late answer')
      const unrelated = await say(quietRoom, 6, 'somewhere else entirely')
      const own3 = await say(quietRoom, 5, 'own note in the quiet room')

      const windowModule: WindowModule = await import('../../src/window.ts')
      const contextQuery = (limit: number, beforeId: number | null) => Object.freeze({
        collection: 'notes' as const,
        beforeId,
        limit,
        placeId: null,
        resident: 'resident-5',
        context: true,
      })
      const firstPage = await windowModule.readWindowCollectionPage(contextQuery(10, null))
      const firstIds = firstPage.items.map(item => item.id)
      // Own notes and their neighbors, newest first; the unrelated quiet-room
      // note only appears because resident-5 later spoke there (it is a
      // same-place neighbor of own3), which is exactly the intended context.
      assert.deepEqual(
        firstIds,
        [own3, unrelated, reply2, own2, drift, reply1, own1, before],
      )
      assert.equal(firstPage.hasMore, false)
      const authors = new Map(firstPage.items.map(item => [
        item.id, (item as { author: string }).author,
      ]))
      assert.equal(authors.get(own1), 'resident-5')
      assert.equal(authors.get(reply1), 'resident-7')

      // The cursor pages over the resident's own notes alone: limit 1 shows
      // the newest own note with its context and points at it for the next
      // older page.
      const paged = await windowModule.readWindowCollectionPage(contextQuery(1, null))
      assert.equal(paged.hasMore, true)
      assert.equal(paged.nextBeforeId, own3)
      assert.ok(paged.items.some(item => item.id === own3))
      assert.ok(!paged.items.some(item => item.id === own1))
      const olderPage = await windowModule.readWindowCollectionPage(contextQuery(1, paged.nextBeforeId))
      assert.ok(olderPage.items.some(item => item.id === own2))
      assert.equal(olderPage.nextBeforeId, own2)

      // Context never carries the followed resident, and no page shows a
      // context note whose own note was trimmed to the next page.
      const anchored = await windowModule.readWindowCollectionPage(Object.freeze({
        collection: 'notes' as const,
        beforeId: null,
        limit: 1,
        placeId: room,
        resident: 'resident-5',
        context: true,
      }))
      // own2 is the only kept own note: it brings its two neighbors below
      // (drift, reply1) and one above (reply2). `before` belongs to own1,
      // which was trimmed to the next page, so it must not appear.
      assert.deepEqual(
        anchored.items.map(item => item.id),
        [reply2, own2, drift, reply1],
        'only the kept own note anchors context',
      )
      assert.ok(!anchored.items.some(item => item.id === before))
      assert.ok(!anchored.items.some(item => (item as { author: string }).author === 'resident-5'
        && item.id !== own2))

      // The route bounds a context page so the whole page fits the row cap.
      const bounded = windowModule.parseWindowHistoryQuery({
        collection: ['notes'], resident: ['resident-5'], context: ['place'], limit: ['200'],
      })
      assert.equal(bounded?.limit, windowModule.NOTE_CONTEXT_PAGE_MAX)

      // The route rejects context without a resident before touching SQL.
      const app = new Hono()
      app.get('/api/window', windowModule.windowSnapshot)
      const statementsBefore = statementCount
      const invalid = await app.request(
        'http://city.test/api/window?collection=notes&context=place',
      )
      assert.equal(invalid.status, 400)
      assert.equal(statementCount, statementsBefore)
      const valid = await app.request(
        'http://city.test/api/window?collection=notes&resident=resident-5&context=place&limit=25',
      )
      assert.equal(valid.status, 200)
      const payload = await valid.json() as { notes: Array<{ id: number }>; has_more: boolean }
      assert.deepEqual(
        payload.notes.map(note => note.id),
        [own3, unrelated, reply2, own2, drift, reply1, own1, before],
      )

      // Regression: consecutive own notes straddling a page boundary. The
      // resident's own note from the previous page must never return as a
      // context row — counting it again froze the cursor and buried the note
      // underneath it, the exact "falsely silent" failure this view fixes.
      const monologue = (await client.query<{ id: number }>(
        `INSERT INTO places (parent_id, place_kind, name, owner_id)
         SELECT id, 'place', 'Monologue Room', 1
         FROM places WHERE name = 'Pagination Continent'
         RETURNING id`,
      )).rows[0]!.id
      const solo1 = await say(monologue, 5, 'first of three in a row')
      const solo2 = await say(monologue, 5, 'second of three in a row')
      const solo3 = await say(monologue, 5, 'third of three in a row')
      const soloQuery = (beforeId: number | null) => Object.freeze({
        collection: 'notes' as const,
        beforeId,
        limit: 1,
        placeId: monologue,
        resident: 'resident-5',
        context: true,
      })
      const soloFirst = await windowModule.readWindowCollectionPage(soloQuery(null))
      assert.deepEqual(soloFirst.items.map(item => item.id), [solo3])
      assert.equal(soloFirst.nextBeforeId, solo3)
      const soloSecond = await windowModule.readWindowCollectionPage(soloQuery(soloFirst.nextBeforeId))
      assert.deepEqual(soloSecond.items.map(item => item.id), [solo2])
      assert.equal(soloSecond.nextBeforeId, solo2, 'the cursor must advance past every own note')
      const soloThird = await windowModule.readWindowCollectionPage(soloQuery(soloSecond.nextBeforeId))
      assert.deepEqual(soloThird.items.map(item => item.id), [solo1])
      assert.equal(soloThird.hasMore, false)
      assert.equal(soloThird.nextBeforeId, null)
    })
  } finally {
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
