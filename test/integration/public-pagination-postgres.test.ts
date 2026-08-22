import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Hono } from 'hono'
import { Pool } from 'pg'

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

type WindowModule = typeof import('../../src/window.ts')

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'public_pagination_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const affordableReadingMigration = await readFile(
  new URL('../../db/migrations/20260820_affordable_reading_totals.sql', import.meta.url),
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
  targetPlaceId: number
  placeCount: number
  residentCount: number
  expected: Readonly<{
    events: readonly number[]
    subplaces: readonly number[]
    things: readonly number[]
    notes: readonly number[]
  }>
}

interface PostgresInstance {
  client: Pool
  containerName: string
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
        return { client, containerName }
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
  const target = await client.query<{ id: number }>(
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     VALUES ($1, 'place', 'Pagination Room', 1)
     RETURNING id`,
    [continent.rows[0]!.id],
  )
  const targetPlaceId = target.rows[0]!.id

  await client.query(
    `INSERT INTO places (parent_id, place_kind, name, description, owner_id)
     SELECT $1, 'place', 'Room child ' || child_number,
       repeat('child ', 400) || child_number || ' 🏙', 1
     FROM generate_series(1, 75) AS child_number`,
    [targetPlaceId],
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
    `INSERT INTO things (place_id, name, body, owner_id, created_at)
     SELECT $1, 'thing-' || item_number,
       repeat('thing ', 5000) || item_number || ' 🏙', 1,
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
    targetPlaceId,
    placeCount: Number((await client.query<{ count: string }>('SELECT count(*) FROM places')).rows[0]!.count),
    residentCount: Number((await client.query<{ count: string }>('SELECT count(*) FROM residents')).rows[0]!.count),
    expected: Object.freeze({
      events: await ids(`SELECT id FROM events WHERE kind = 'note' ORDER BY id DESC`),
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

    await t.test('dense room HTTP reads keep whole records and make smaller requests visibly cheaper', async () => {
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

    await t.test('resident census follows arrival time across every tie-safe page', async () => {
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
    })

    await t.test('the window bounds history but keeps the complete map and presence', async () => {
      const windowModule: WindowModule = await import('../../src/window.ts')
      const app = new Hono()
      app.get('/api/window', windowModule.windowSnapshot)

      const response = await app.request('http://city.test/api/window')
      assert.equal(response.status, 200)
      const snapshot = await response.json() as {
        places: unknown[]
        residents: unknown[]
        notes: Array<{ id: number }>
        things: Array<{ id: number }>
        agreements: Array<{ id: number }>
        events: Array<{ id: number }>
        pages: Record<string, { has_more: boolean; next_before_id: number | null }>
        shown: Record<string, number>
        totals: Record<string, number>
      }

      assert.equal(placeTreeCount(snapshot.places), city.placeCount)
      assert.equal(snapshot.residents.length, city.residentCount)
      assert.deepEqual(
        {
          notes: snapshot.notes.length,
          things: snapshot.things.length,
          agreements: snapshot.agreements.length,
          events: snapshot.events.length,
        },
        { notes: 10, things: 10, agreements: 10, events: 10 },
      )
      assert.deepEqual(
        Object.fromEntries(Object.entries(snapshot.pages).map(([name, value]) => [name, value.has_more])),
        { notes: true, things: true, agreements: true, events: true },
      )
      assert.equal(snapshot.shown.places, city.placeCount)
      assert.equal(snapshot.shown.residents, city.residentCount)
      assert.equal(snapshot.totals.places, city.placeCount)
      assert.equal(snapshot.totals.residents, city.residentCount)

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
      assert.equal(oldestNotes.notes.length, 15)
      assert.equal(oldestNotes.has_more, false)
      assert.deepEqual(
        [
          ...snapshot.notes.map(row => row.id),
          ...olderNotes.notes.map(row => row.id),
          ...oldestNotes.notes.map(row => row.id),
        ],
        city.expected.notes,
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
        INSERT INTO things (place_id, name, body, owner_id)
        VALUES ($1, 'opposite move a', 'move a 🏙', 1),
          ($2, 'opposite move b', 'move b 🏙', 1)
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
        `INSERT INTO things (place_id, name, body, owner_id, withdrawn_at)
         VALUES ($1, 'withdrawn-lantern', 'no longer here', 1, now())
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
