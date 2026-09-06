import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { canonicalJson } from '../../src/public-snapshot-format.ts'
import { isoTimestamp } from '../../src/timestamp.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'public_replay_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

let database: Pool | null = null

function connectedDatabase(): Pool {
  assert.ok(database, 'the PostgreSQL test client must be connected before a replay read runs')
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
  return (await connectedDatabase().query(text, [...values])).rows as Record<string, unknown>[]
}

const sql = Object.assign(sqlTag, {
  query: async (
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> => (
    (await connectedDatabase().query(text, [...values])).rows as Record<string, unknown>[]
  ),
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
    runtimeDatabaseUrl: () => 'postgresql://integration-test.invalid/public-replay',
  },
})

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-public-replay-${process.pid}-${randomBytes(4).toString('hex')}`
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
    assert.ok(Number.isSafeInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const client = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false, max: 10,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        await client.query('SELECT 1')
        return { client, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await client.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

interface SeededReplay {
  readonly originPlaceId: number
  readonly quietPlaceId: number
  readonly moveEventId: number
  readonly registerEventId: number
  readonly quietNoteEventId: number
  readonly sameAtEventIds: readonly number[]
  readonly allEventIds: readonly number[]
}

async function seedReplay(client: Pool): Promise<SeededReplay> {
  const observed = (await client.query<{ observed_at: Date }>(
    'SELECT clock_timestamp() AS observed_at',
  )).rows[0]!.observed_at
  const observedIso = isoTimestamp(observed)
  assert.ok(observedIso, 'clock_timestamp() must map through the shared ISO helper')
  const at = (millisecondsBefore: number): string => {
    const value = isoTimestamp(new Date(Date.parse(observedIso) - millisecondsBefore))
    assert.ok(value)
    return value
  }

  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash, joined_at) VALUES
      (1, 'replay-mover', 'public-replay-test', $1, $4),
      (2, 'replay-newcomer', 'public-replay-test', $2, $5),
      (3, 'replay-owner', 'public-replay-test', $3, $4)
  `, ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), at(2 * 60 * 60_000), at(20 * 60_000)])
  const worldId = Number((await client.query<{ id: number }>(
    `SELECT id FROM places WHERE place_kind = 'world'`,
  )).rows[0]!.id)
  const continentId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, owner_id)
    VALUES ($1, 'continent', 'Replay Continent', 3)
    RETURNING id
  `, [worldId])).rows[0]!.id)
  const originPlaceId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, owner_id)
    VALUES ($1, 'place', 'Replay Origin', 3)
    RETURNING id
  `, [continentId])).rows[0]!.id)
  const quietPlaceId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, owner_id, quiet)
    VALUES ($1, 'place', 'Quiet Replay Room', 3, TRUE)
    RETURNING id
  `, [continentId])).rows[0]!.id)
  await client.query(`
    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id) VALUES
      (1, $1, $2), (2, $1, $1), (3, $2, $2)
  `, [quietPlaceId, originPlaceId])
  const thingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id)
    VALUES ($1, 'quiet replay lantern', 'fixture body never belongs in replay', 3, 3)
    RETURNING id
  `, [quietPlaceId])).rows[0]!.id)
  const noteId = Number((await client.query<{ id: number }>(`
    INSERT INTO notes (place_id, author_id, body, created_at)
    VALUES ($1, 2, 'quiet first line\nfull note body stays behind its single-note door', $2)
    RETURNING id
  `, [quietPlaceId, at(5 * 60_000)])).rows[0]!.id)

  const insertEvent = async (
    kind: string,
    actor: string,
    detail: Readonly<Record<string, unknown>>,
    eventAt: string,
  ): Promise<number> => Number((await client.query<{ id: number }>(`
    INSERT INTO events (kind, actor, detail, at)
    VALUES ($1, $2, $3::jsonb, $4::timestamptz)
    RETURNING id
  `, [kind, actor, JSON.stringify(detail), eventAt])).rows[0]!.id)

  const registerEventId = await insertEvent(
    'register', 'replay-newcomer',
    { resident_id: 2, place_id: quietPlaceId }, at(20 * 60_000),
  )
  const moveEventId = await insertEvent(
    'action', 'replay-mover',
    {
      resident_id: 1, action: 'move', status: 'applied',
      from_place_id: originPlaceId, to_place_id: quietPlaceId,
    }, at(10 * 60_000),
  )
  const thingEventId = await insertEvent(
    'thing_created', 'replay-owner',
    { thing_id: thingId, place_id: quietPlaceId }, at(8 * 60_000),
  )
  const quietNoteEventId = await insertEvent(
    'note', 'replay-newcomer',
    { note_id: noteId, place_id: quietPlaceId }, at(5 * 60_000),
  )

  await client.query('BEGIN')
  let sameAtEventIds: readonly number[]
  try {
    const rows = await client.query<{ id: number; at: Date }>(`
      INSERT INTO events (kind, actor, detail) VALUES
        ('action', 'replay-mover', '{"action_id":71,"status":"applied"}'::jsonb),
        ('action', 'replay-mover', '{"action_id":72,"status":"applied"}'::jsonb)
      RETURNING id, at
    `)
    assert.equal(rows.rows.length, 2)
    const firstAt = isoTimestamp(rows.rows[0]!.at)
    const secondAt = isoTimestamp(rows.rows[1]!.at)
    assert.ok(firstAt && secondAt)
    assert.equal(firstAt, secondAt, 'the fixture must contain batched events with one transaction timestamp')
    sameAtEventIds = Object.freeze(rows.rows.map(row => Number(row.id)))
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }

  return Object.freeze({
    originPlaceId,
    quietPlaceId,
    moveEventId,
    registerEventId,
    quietNoteEventId,
    sameAtEventIds,
    allEventIds: Object.freeze([
      registerEventId, moveEventId, thingEventId, quietNoteEventId, ...sameAtEventIds,
    ]),
  })
}

type ReplayBody = Readonly<{
  span: string
  checkpoint: string
  window_start: string
  window_end: string
  row_ceiling: number
  complete: boolean
  rest_at?: string
  before_id?: number
  map: { places: Array<{ id: number; quiet: boolean; has_drawing: boolean }> }
  start: Record<string, { place_id: number | null; origin?: string; origin_event_id?: number }>
  timeline: Array<{
    change_id: string
    event_id: number
    at: string
    kind: string
    line?: string
    line_cut?: boolean
    body?: unknown
  }>
  counts: Record<string, { residents: number; things: number }>
}>

test('the public replay route is pinned and truthful against PostgreSQL', {
  timeout: 120_000,
}, async () => {
  const postgres = await startPostgres()
  database = postgres.client
  try {
    await postgres.client.query(schemaDdl)
    const { default: app } = await import('../../src/index.ts')
    const { buildPublicReplay, parsePublicReplayQuery } = await import('../../src/public-replay.ts')
    const unavailableResponse = await app.request('http://city.test/api/replay?span=1h')
    assert.equal(unavailableResponse.status, 503)
    assert.equal(unavailableResponse.headers.get('retry-after'), '1')
    assert.deepEqual(await unavailableResponse.json(), {
      error: 'the city has no public record yet, so there is nothing to replay; retry after the first public change',
    })

    const seeded = await seedReplay(postgres.client)
    const parsed = parsePublicReplayQuery({ span: ['1h'] })
    assert.equal(parsed.ok, true)
    assert.ok(parsed.ok)
    const execute = async (text: string, params: readonly unknown[]) =>
      (await postgres.client.query(text, [...params])).rows as Record<string, unknown>[]
    const firstBuild = await buildPublicReplay(execute, parsed)
    const secondBuild = await buildPublicReplay(execute, parsed)
    assert.equal(
      canonicalJson(secondBuild),
      canonicalJson(firstBuild),
      'independent builds at one PostgreSQL checkpoint must be byte-identical',
    )

    const firstResponse = await app.request('http://city.test/api/replay?span=1h')
    const firstText = await firstResponse.text()
    assert.equal(firstResponse.status, 200, firstText)
    const first = JSON.parse(firstText) as ReplayBody
    assert.equal(firstText, canonicalJson(first))
    assert.equal(first.span, '1h')
    assert.match(first.checkpoint, /^[1-9][0-9]*$/u)
    assert.match(first.window_start, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u)
    assert.match(first.window_end, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u)
    assert.equal(first.window_end, first.timeline.at(-1)?.at)
    assert.equal(first.row_ceiling, 800)
    assert.equal(first.complete, true)
    assert.equal(Object.hasOwn(first, 'rest_at'), false)
    assert.equal(Object.hasOwn(first, 'before_id'), false)

    const repeatedResponse = await app.request('http://city.test/api/replay?span=1h')
    const repeatedText = await repeatedResponse.text()
    assert.equal(repeatedResponse.status, 200, repeatedText)
    assert.equal(repeatedText, firstText, 'the same span and checkpoint must be byte-identical')
    assert.equal(repeatedResponse.headers.get('etag'), firstResponse.headers.get('etag'))
    assert.match(firstResponse.headers.get('cache-control') ?? '', /max-age=15/u)

    const notModifiedResponse = await app.request('http://city.test/api/replay?span=1h', {
      headers: { 'If-None-Match': firstResponse.headers.get('etag')! },
    })
    assert.equal(notModifiedResponse.status, 304)
    assert.equal(await notModifiedResponse.text(), '')

    const sameAtRows = first.timeline.filter(row => seeded.sameAtEventIds.includes(row.event_id))
    assert.equal(sameAtRows.length, 2)
    assert.equal(sameAtRows[0]!.at, sameAtRows[1]!.at)
    assert.deepEqual(
      sameAtRows.map(row => row.change_id),
      [...sameAtRows.map(row => row.change_id)].sort((left, right) => (
        BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
      )),
    )

    assert.deepEqual(first.start['resident:1'], {
      place_id: seeded.originPlaceId,
      origin_event_id: seeded.moveEventId,
    })
    assert.deepEqual(first.start['resident:2'], {
      place_id: null,
      origin: 'register',
    })
    assert.deepEqual(first.counts[String(seeded.quietPlaceId)], { residents: 2, things: 1 })
    assert.equal(
      first.map.places.find(place => place.id === seeded.quietPlaceId)?.quiet,
      true,
    )
    const noteRow = first.timeline.find(row => row.event_id === seeded.quietNoteEventId)
    assert.equal(noteRow?.line, 'quiet first line')
    assert.equal(noteRow?.line_cut, true)
    assert.equal(Object.hasOwn(noteRow ?? {}, 'body'), false)
    assert.doesNotMatch(firstText, /full note body stays behind|fixture body never belongs/u)

    const eventsResponse = await app.request('http://city.test/api/events?limit=200')
    const eventsText = await eventsResponse.text()
    assert.equal(eventsResponse.status, 200, eventsText)
    const eventsBody = JSON.parse(eventsText) as { events: Array<{ id: number }> }
    const publicEventIds = new Set(eventsBody.events.map(event => event.id))
    for (const id of seeded.allEventIds) {
      assert.equal(publicEventIds.has(id), true, `event ${id} must keep /api/events parity`)
    }

    await postgres.client.query('BEGIN')
    try {
      await postgres.client.query(
        'UPDATE resident_presence SET current_place_id = $1, updated_at = clock_timestamp() WHERE resident_id = 1',
        [seeded.originPlaceId],
      )
      await postgres.client.query(`
        INSERT INTO events (kind, actor, detail, at)
        VALUES (
          'action', 'replay-mover',
          jsonb_build_object(
            'resident_id', 1, 'action', 'move', 'status', 'applied',
            'from_place_id', $1::integer, 'to_place_id', $2::integer
          ),
          clock_timestamp()
        )
      `, [seeded.quietPlaceId, seeded.originPlaceId])
      await postgres.client.query('COMMIT')
    } catch (error) {
      await postgres.client.query('ROLLBACK')
      throw error
    }

    const changedResponse = await app.request('http://city.test/api/replay?span=1h')
    const changedText = await changedResponse.text()
    assert.equal(changedResponse.status, 200, changedText)
    const changed = JSON.parse(changedText) as ReplayBody
    assert.notEqual(changed.checkpoint, first.checkpoint)
    assert.notEqual(changedText, firstText)

    await postgres.client.query(`
      INSERT INTO events (kind, actor, detail, at)
      SELECT 'action', 'replay-mover', jsonb_build_object(
        'action_id', 1000 + ordinal, 'status', 'applied'
      ), transaction_timestamp() - interval '1 second' + ordinal * interval '1 microsecond'
      FROM generate_series(1, 801) ordinal
    `)
    const truncatedResponse = await app.request('http://city.test/api/replay?span=1h')
    const truncatedText = await truncatedResponse.text()
    assert.equal(truncatedResponse.status, 200, truncatedText)
    const truncated = JSON.parse(truncatedText) as ReplayBody
    assert.equal(truncated.complete, false)
    assert.equal(truncated.timeline.length, 800)
    assert.equal(truncated.window_start, truncated.timeline[0]!.at)
    assert.equal(truncated.rest_at, '/api/events')
    assert.equal(truncated.before_id, truncated.timeline[0]!.event_id)

    const olderResponse = await app.request(
      `http://city.test/api/events?before_id=${truncated.before_id}&limit=1`,
    )
    const olderText = await olderResponse.text()
    assert.equal(olderResponse.status, 200, olderText)
    const older = JSON.parse(olderText) as { events: Array<{ id: number }> }
    assert.equal(older.events.length, 1)
    assert.ok(older.events[0]!.id < truncated.before_id!)
  } finally {
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
