import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Hono } from 'hono'
import { Pool } from 'pg'

import {
  finalizePublicPage,
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
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     SELECT $1, 'place', 'Room child ' || child_number, 1
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
     SELECT $1, 'thing-' || item_number, 'thing body ' || item_number, 1,
       '2026-08-14T00:00:00Z'::timestamptz + item_number * interval '1 second'
     FROM generate_series(1, 75) AS item_number`,
    [targetPlaceId],
  )
  await client.query(
    `INSERT INTO notes (place_id, author_id, body, created_at)
     SELECT $1, 1, 'note body ' || item_number,
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
    const rows = await loadPublicEventRows(executePublicQuery, 'note', request)
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

    await t.test('events default to 10 and every older row remains reachable once', async () => {
      const request = page()
      const firstRows = await loadPublicEventRows(executePublicQuery, 'note', request)
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
        Object.fromEntries(Object.entries(firstRows).map(([name, rows]) => [name, rows.length])),
        { subplaces: 11, things: 11, notes: 11 },
        'each production query must fetch its own lookahead row',
      )

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
      const defaultResponse = await cityApp.request('http://city.test/api/residents')
      assert.equal(defaultResponse.status, 200)
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
  } finally {
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
