import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool, type PoolClient } from 'pg'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'small_reader_integration'
const RESPONSE_BUDGET_BYTES = 16 * 1024
const SEARCH_TOKEN = 'smallreaderarchive'
const READER_SECRET = `1f3d9_sk_${'r'.repeat(48)}`
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

interface QueryStatement {
  readonly text: string
  readonly values: readonly unknown[]
}

interface TestTaggedSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>
  query: (text: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>
  transaction: (
    build: (transaction: { query: (text: string, values?: readonly unknown[]) => QueryStatement }) => readonly QueryStatement[],
    options?: Readonly<{ readOnly?: boolean }>,
  ) => Promise<Record<string, unknown>[][]>
}

interface PostgresInstance {
  readonly client: Pool
  readonly containerName: string
}

interface SearchIdentity {
  readonly type: 'note' | 'thing'
  readonly id: number
}

let database: Pool | null = null

function connectedDatabase(): Pool {
  assert.ok(database, 'the controlled reader database must be connected')
  return database
}

function sqlText(strings: TemplateStringsArray, values: readonly unknown[]): string {
  return strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
}

function taggedFor(queryable: Pool | PoolClient) {
  const tagged = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Record<string, unknown>[]> => (
    await queryable.query(sqlText(strings, values), values)
  ).rows as Record<string, unknown>[]
  tagged.query = async (
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> => (
    await queryable.query(text, [...values])
  ).rows as Record<string, unknown>[]
  return tagged
}

const sql = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => (
    taggedFor(connectedDatabase())(strings, ...values)
  ),
  {
    query: async (text: string, values: readonly unknown[] = []) => (
      taggedFor(connectedDatabase()).query(text, values)
    ),
    transaction: async (
      build: (transaction: { query: (text: string, values?: readonly unknown[]) => QueryStatement }) => readonly QueryStatement[],
      options: Readonly<{ readOnly?: boolean }> = {},
    ) => {
      const transaction = {
        query: (text: string, values: readonly unknown[] = []): QueryStatement => ({ text, values }),
      }
      const statements = build(transaction)
      const client = await connectedDatabase().connect()
      try {
        await client.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
        const results: Record<string, unknown>[][] = []
        for (const statement of statements) {
          results.push((await client.query(
            statement.text,
            [...statement.values],
          )).rows as Record<string, unknown>[])
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
  },
) as TestTaggedSql

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: {
    sql,
    runtimeDatabaseUrl: () => 'postgresql://controlled-reader.invalid/local-only',
  },
})

const { setEngineTransactionRunnerForTests } = await import('../../src/engine.ts')
const { default: cityApp } = await import('../../src/index.ts')

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<PostgresInstance> {
  const containerName = `1f3d9-small-reader-test-${process.pid}-${randomBytes(4).toString('hex')}`
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

    const client = new Pool({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: POSTGRES_DATABASE,
      ssl: false,
      max: 8,
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
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
    throw error
  }
}

function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

async function readBudgetedJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text()
  const bytes = Buffer.byteLength(text, 'utf8')
  assert.ok(
    bytes <= RESPONSE_BUDGET_BYTES,
    `${label} used ${bytes} bytes, above the ${RESPONSE_BUDGET_BYTES}-byte reader limit`,
  )
  assert.ok(response.ok, `${label} returned ${response.status}: ${text}`)
  return JSON.parse(text) as T
}

async function seedHeavyRoom(client: Pool) {
  await client.query(schemaDdl)
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES
      (1, 'small-reader', 'controlled-local-test', $1),
      (2, 'fixture-writer', 'controlled-local-test', $2)
  `, [secretHash(READER_SECRET), '2'.repeat(64)])

  const world = (await client.query<{ id: number }>(
    `SELECT id FROM places WHERE place_kind = 'world'`,
  )).rows[0]!
  const continent = (await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'continent', 'Controlled Reader Continent', 'Local test fixture.', 1)
    RETURNING id
  `, [world.id])).rows[0]!
  const room = (await client.query<{ id: number }>(`
    INSERT INTO places (
      parent_id, place_kind, name, description, owner_id, open_to_notes
    ) VALUES (
      $1, 'place', 'Deliberately Heavy Reader Room',
      'A local room used only to prove that a small reader can participate.', 1, true
    ) RETURNING id
  `, [continent.id])).rows[0]!
  await client.query(`
    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    VALUES (1, $1, $1), (2, $1, NULL)
  `, [room.id])

  const chosenBody = 'Short, complete text for the deliberately buried relic. 🏙'
  const chosen = (await client.query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
    VALUES ($1, $2, $3, 2, 2, '2026-08-01T00:00:00Z')
    RETURNING id
  `, [room.id, `${SEARCH_TOKEN} chosen old relic`, chosenBody])).rows[0]!

  const chronologicalMatches: SearchIdentity[] = [{ type: 'thing', id: chosen.id }]
  let expectedSearchBodyBytes = Buffer.byteLength(chosenBody, 'utf8')
  for (let item = 1; item <= 3; item += 1) {
    const body = `${SEARCH_TOKEN} short matching note ${item}.`
    const note = (await client.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body, created_at)
      VALUES ($1, 2, $2, $3::timestamptz)
      RETURNING id
    `, [room.id, body, `2026-08-01T00:00:${10 + item}Z`])).rows[0]!
    chronologicalMatches.push({ type: 'note', id: note.id })
    expectedSearchBodyBytes += Buffer.byteLength(body, 'utf8')
  }
  for (let item = 1; item <= 3; item += 1) {
    const body = `Short matching thing body ${item}.`
    const thing = (await client.query<{ id: number }>(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
      VALUES ($1, $2, $3, 2, 2, $4::timestamptz)
      RETURNING id
    `, [room.id, `${SEARCH_TOKEN} matching thing ${item}`, body, `2026-08-01T00:00:${20 + item}Z`])).rows[0]!
    chronologicalMatches.push({ type: 'thing', id: thing.id })
    expectedSearchBodyBytes += Buffer.byteLength(body, 'utf8')
  }

  await client.query(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
    SELECT $1, 'heavy artifact ' || item,
      repeat('large artifact text ', 2500) || item || ' 🏙', 2, 2,
      '2026-08-02T00:00:00Z'::timestamptz + item * interval '1 second'
    FROM generate_series(1, 30) AS item
  `, [room.id])
  await client.query(`
    INSERT INTO notes (place_id, author_id, body, created_at)
    SELECT $1, 2, repeat('large conversation ', 180) || item || ' 🏙',
      '2026-08-02T00:01:00Z'::timestamptz + item * interval '1 second'
    FROM generate_series(1, 30) AS item
  `, [room.id])

  const totals = (await client.query<{
    thing_items: number
    thing_text_bytes: string
    note_items: number
    note_text_bytes: string
  }>(`
    SELECT
      count(*) FILTER (WHERE record_type = 'thing')::integer AS thing_items,
      coalesce(sum(body_bytes) FILTER (WHERE record_type = 'thing'), 0)::text AS thing_text_bytes,
      count(*) FILTER (WHERE record_type = 'note')::integer AS note_items,
      coalesce(sum(body_bytes) FILTER (WHERE record_type = 'note'), 0)::text AS note_text_bytes
    FROM (
      SELECT 'thing' AS record_type, octet_length(body)::bigint AS body_bytes
      FROM things WHERE place_id = $1 AND withdrawn_at IS NULL
      UNION ALL
      SELECT 'note', octet_length(body)::bigint
      FROM notes WHERE place_id = $1
    ) records
  `, [room.id])).rows[0]!

  return Object.freeze({
    roomId: room.id,
    chosenThingId: chosen.id,
    chosenBody,
    expectedMatches: Object.freeze([...chronologicalMatches].reverse()),
    expectedSearchBodyBytes,
    totals: Object.freeze({
      things: { items: totals.thing_items, textBytes: Number(totals.thing_text_bytes) },
      notes: { items: totals.note_items, textBytes: Number(totals.note_text_bytes) },
    }),
  })
}

test('a controlled 16 KiB reader can find, read, and answer in a heavy local room', async t => {
  const postgres = await startPostgres()
  database = postgres.client
  setEngineTransactionRunnerForTests(async (_db, work) => {
    const client = await connectedDatabase().connect()
    try {
      await client.query('BEGIN')
      const result = await work(taggedFor(client), true)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })

  try {
    const fixture = await seedHeavyRoom(postgres.client)
    const checkpoint = await readBudgetedJson<{ change_marker: string }>(
      await cityApp.request('http://city.test/api/changes'),
      'initial change checkpoint',
    )

    const directory = await readBudgetedJson<{
      view: string
      places: Array<{ id: number; parent_id: number | null; name: string }>
      residents: Array<{ id: number; handle: string }>
    }>(
      await cityApp.request('http://city.test/api/window?view=directory'),
      'complete names directory',
    )
    const cityCounts = (await postgres.client.query<{
      places: number
      residents: number
    }>(`
      SELECT (SELECT count(*)::integer FROM places) AS places,
        (SELECT count(*)::integer FROM residents) AS residents
    `)).rows[0]!
    assert.equal(directory.view, 'directory')
    assert.equal(directory.places.length, cityCounts.places)
    assert.equal(directory.residents.length, cityCounts.residents)
    assert.deepEqual(
      Object.keys(directory.places.find(place => place.id === fixture.roomId) ?? {}).sort(),
      ['id', 'name', 'parent_id'],
    )
    assert.deepEqual(
      Object.keys(directory.residents.find(resident => resident.handle === 'small-reader') ?? {}).sort(),
      ['handle', 'id'],
    )

    const focusedPresence = await readBudgetedJson<{
      resident: {
        id: number
        handle: string
        joined_at: string
        current_place_id: number | null
        asleep: boolean
      }
    }>(
      await cityApp.request('http://city.test/api/residents?view=presence&handle=small-reader'),
      'focused resident presence',
    )
    assert.equal(focusedPresence.resident.handle, 'small-reader')
    assert.equal(focusedPresence.resident.current_place_id, fixture.roomId)
    assert.deepEqual(Object.keys(focusedPresence.resident).sort(), [
      'asleep', 'current_place_id', 'handle', 'id', 'joined_at',
    ])

    const outline = await readBudgetedJson<{
      view: string
      things: Array<{ id: number; body_text_bytes: number; body?: string }>
      notes: Array<{ id: number; body_text_bytes: number; body?: string }>
      things_page: {
        total_items: number
        total_text_bytes: number
        returned_items: number
        returned_text_bytes: number
        has_more: boolean
      }
      notes_page: {
        total_items: number
        total_text_bytes: number
        returned_items: number
        returned_text_bytes: number
        has_more: boolean
      }
    }>(
      await cityApp.request(`http://city.test/api/place/${fixture.roomId}?view=outline`),
      'heavy-room outline',
    )
    assert.equal(outline.view, 'outline')
    assert.deepEqual(
      {
        things: {
          items: outline.things_page.total_items,
          textBytes: outline.things_page.total_text_bytes,
        },
        notes: {
          items: outline.notes_page.total_items,
          textBytes: outline.notes_page.total_text_bytes,
        },
      },
      fixture.totals,
    )
    for (const [name, rows, page] of [
      ['things', outline.things, outline.things_page],
      ['notes', outline.notes, outline.notes_page],
    ] as const) {
      assert.equal(rows.length, 10, `${name} returns the documented first page`)
      assert.equal(page.returned_items, rows.length, `${name} reports the visible headings`)
      assert.equal(page.returned_text_bytes, 0, `${name} reports that bodies were omitted`)
      assert.equal(page.has_more, true, `${name} says that older headings remain`)
      assert.equal(rows.every(row => !Object.hasOwn(row, 'body')), true, `${name} bodies stay omitted`)
      assert.equal(rows.every(row => row.body_text_bytes > 0), true, `${name} exposes every omitted size`)
    }
    assert.equal(
      outline.things.some(thing => thing.id === fixture.chosenThingId),
      false,
      'the chosen old thing must really be buried beyond the first room page',
    )

    const found: SearchIdentity[] = []
    let before: string | null = null
    let searchMarker: string | null = null
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const query = new URLSearchParams({
        q: SEARCH_TOKEN,
        mode: 'phrase',
        type: 'all',
        limit: '2',
      })
      if (before !== null) query.set('before', before)
      const page = await readBudgetedJson<{
        results: Array<SearchIdentity & { body_text_bytes: number; body?: string; snippet?: string; rank?: number }>
        total_items: number
        total_text_bytes: number
        returned_items: number
        returned_text_bytes: number
        has_more: boolean
        next_before: string | null
        change_marker: string
      }>(
        await cityApp.request(`http://city.test/api/search?${query}`),
        `search page ${pageNumber + 1}`,
      )
      searchMarker ??= page.change_marker
      assert.equal(page.change_marker, searchMarker, 'one search walk keeps one checkpoint')
      assert.equal(page.total_items, fixture.expectedMatches.length)
      assert.equal(page.total_text_bytes, fixture.expectedSearchBodyBytes)
      assert.equal(page.returned_items, page.results.length)
      assert.equal(page.returned_text_bytes, 0)
      for (const result of page.results) {
        assert.equal(Object.hasOwn(result, 'body'), false)
        assert.equal(Object.hasOwn(result, 'snippet'), false)
        assert.equal(Object.hasOwn(result, 'rank'), false)
        assert.ok(result.body_text_bytes > 0)
        assert.equal(
          found.some(previous => previous.type === result.type && previous.id === result.id),
          false,
          'search pages must not repeat a result',
        )
        found.push({ type: result.type, id: result.id })
      }
      if (!page.has_more) {
        assert.equal(page.next_before, null)
        break
      }
      assert.ok(page.next_before, 'a nonterminal search page must name its continuation')
      before = page.next_before
      if (pageNumber === 9) assert.fail('the bounded search walk did not terminate')
    }
    assert.deepEqual(found, fixture.expectedMatches, 'search pages must not skip or reorder a match')

    const chosen = await readBudgetedJson<{
      thing: { id: number; place_id: number; body: string }
    }>(
      await cityApp.request(`http://city.test/api/thing/${fixture.chosenThingId}`),
      'chosen full thing',
    )
    assert.deepEqual(
      { id: chosen.thing.id, place_id: chosen.thing.place_id, body: chosen.thing.body },
      { id: fixture.chosenThingId, place_id: fixture.roomId, body: fixture.chosenBody },
      'the direct read returns the complete chosen record',
    )

    const replyText = 'I found the buried relic and can answer without loading the heavy room.'
    const reply = await readBudgetedJson<{
      note: { id: number; place_id: number; author: string; body: string }
      reading_cost: { available: boolean; new_item_text_bytes: number }
    }>(
      await cityApp.request('http://city.test/api/note', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${READER_SECRET}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ place_id: fixture.roomId, body: replyText }),
      }),
      'reader reply',
    )
    assert.deepEqual(
      {
        place_id: reply.note.place_id,
        author: reply.note.author,
        body: reply.note.body,
      },
      { place_id: fixture.roomId, author: 'small-reader', body: replyText },
    )
    assert.equal(reply.reading_cost.available, true)
    assert.equal(reply.reading_cost.new_item_text_bytes, Buffer.byteLength(replyText, 'utf8'))
    const storedAction = (await postgres.client.query<{
      action_name: string
      status: string
    }>(`
      SELECT run.action_name, resolution.status
      FROM action_runs run
      JOIN action_resolutions resolution ON resolution.action_run_id = run.id
      WHERE run.actor_id = 1
      ORDER BY run.id DESC LIMIT 1
    `)).rows[0]
    assert.deepEqual(storedAction, { action_name: 'talk', status: 'applied' })

    const duplicateText = 'One concurrent thought must become one durable note. 🏙️'
    const countsBefore = (await postgres.client.query<{
      notes_today: number
      notes: number
      note_events: number
      action_events: number
      action_runs: number
    }>(`
      SELECT resident.notes_today,
        (SELECT count(*)::integer FROM notes) AS notes,
        (SELECT count(*)::integer FROM events WHERE kind = 'note') AS note_events,
        (SELECT count(*)::integer FROM events WHERE kind = 'action') AS action_events,
        (SELECT count(*)::integer FROM action_runs) AS action_runs
      FROM residents resident WHERE resident.id = 1
    `)).rows[0]!
    const postDuplicate = () => cityApp.request('http://city.test/api/note', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${READER_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ place_id: fixture.roomId, body: duplicateText }),
    })
    const duplicateResponses = await Promise.all([postDuplicate(), postDuplicate()])
    assert.deepEqual(
      duplicateResponses.map(response => response.status).sort(),
      [200, 201],
      'concurrent identical posts must have one create and one replay',
    )
    const duplicateBodies = await Promise.all(duplicateResponses.map(async response => (
      await response.json() as { note: { id: number; body: string } }
    )))
    assert.equal(duplicateBodies[0]!.note.id, duplicateBodies[1]!.note.id)
    assert.equal(duplicateBodies[0]!.note.body, duplicateText)
    assert.equal(duplicateBodies[1]!.note.body, duplicateText)

    const countsAfter = (await postgres.client.query<typeof countsBefore>(`
      SELECT resident.notes_today,
        (SELECT count(*)::integer FROM notes) AS notes,
        (SELECT count(*)::integer FROM events WHERE kind = 'note') AS note_events,
        (SELECT count(*)::integer FROM events WHERE kind = 'action') AS action_events,
        (SELECT count(*)::integer FROM action_runs) AS action_runs
      FROM residents resident WHERE resident.id = 1
    `)).rows[0]!
    assert.deepEqual(countsAfter, {
      notes_today: countsBefore.notes_today + 1,
      notes: countsBefore.notes + 1,
      note_events: countsBefore.note_events + 1,
      action_events: countsBefore.action_events,
      action_runs: countsBefore.action_runs + 1,
    })

    const expiredText = 'The same words outside the retry window are a new note.'
    const expiredOriginal = (await postgres.client.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body, created_at)
      VALUES ($1, 1, $2, now() - interval '301 seconds')
      RETURNING id
    `, [fixture.roomId, expiredText])).rows[0]!
    const expiredRetry = await cityApp.request('http://city.test/api/note', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${READER_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ place_id: fixture.roomId, body: expiredText }),
    })
    assert.equal(expiredRetry.status, 201)
    const expiredRetryBody = await expiredRetry.json() as { note: { id: number; body: string } }
    assert.notEqual(expiredRetryBody.note.id, expiredOriginal.id)
    assert.equal(expiredRetryBody.note.body, expiredText)

    const observedChanges: Array<{ change_id: string; kind: string; detail: Record<string, unknown> }> = []
    let since = checkpoint.change_marker
    let finalMarker: string | null = null
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const changes = await readBudgetedJson<{
        change_marker: string
        changes: Array<{ change_id: string; kind: string; detail: Record<string, unknown> }>
        returned_items: number
        unchanged: boolean
        has_more: boolean
        next_since: string
      }>(
        await cityApp.request(`http://city.test/api/changes?since=${since}&limit=2`),
        `change page ${pageNumber + 1}`,
      )
      finalMarker ??= changes.change_marker
      assert.equal(changes.change_marker, finalMarker, 'one change walk keeps one checkpoint')
      assert.equal(changes.returned_items, changes.changes.length)
      assert.equal(changes.unchanged, false)
      for (const change of changes.changes) {
        assert.equal(
          observedChanges.some(previous => previous.change_id === change.change_id),
          false,
          'change pages must not repeat a record',
        )
        observedChanges.push(change)
      }
      assert.ok(BigInt(changes.next_since) > BigInt(since), 'each nonempty change page advances')
      since = changes.next_since
      if (!changes.has_more) break
      if (pageNumber === 9) assert.fail('the bounded change walk did not terminate')
    }
    assert.ok(finalMarker)
    const expectedChangeIds = (await postgres.client.query<{ change_id: string }>(`
      SELECT change_id::text
      FROM public_change_log
      WHERE change_id > $1::bigint AND change_id <= $2::bigint
      ORDER BY change_id
    `, [checkpoint.change_marker, finalMarker])).rows.map(row => row.change_id)
    assert.deepEqual(
      observedChanges.map(change => change.change_id),
      expectedChangeIds,
      'change polling must neither skip nor duplicate a committed change',
    )
    assert.equal(
      observedChanges.filter(change => (
        change.kind === 'note' && Number(change.detail.note_id) === reply.note.id
      )).length,
      1,
      'the reader sees its public reply exactly once',
    )

    const unchanged = await readBudgetedJson<{
      change_marker: string
      changes: unknown[]
      returned_items: number
      unchanged: boolean
      has_more: boolean
      next_since: string
    }>(
      await cityApp.request(`http://city.test/api/changes?since=${finalMarker}&limit=2`),
      'unchanged poll',
    )
    assert.deepEqual(unchanged, {
      change_marker: finalMarker,
      changes: [],
      returned_items: 0,
      unchanged: true,
      has_more: false,
      next_since: finalMarker,
    })

    t.diagnostic(
      `controlled reader completed the journey with every response <= ${RESPONSE_BUDGET_BYTES} UTF-8 bytes`,
    )
  } finally {
    setEngineTransactionRunnerForTests(null)
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  }
})
