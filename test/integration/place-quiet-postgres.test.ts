// Decision #75 (docs/DECISIONS.md row 75): an owner may set quiet:true on an
// owned place through place_edit / PATCH /api/place/:id, free. This exercises
// the real quiet column, the place_edit CTE's quiet branch, and the
// places_world_shape constraint against real PostgreSQL — the unit suite
// (test/quiet-rooms.test.ts) only proves the client and server source carry
// the field; it never opens a database connection.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'place_quiet_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const quietMigrationDdl = await readFile(
  new URL('../../db/migrations/20260902_place_quiet.sql', import.meta.url),
  'utf8',
)

let database: Pool | null = null

function connectedDatabase(): Pool {
  assert.ok(database, 'the PostgreSQL test client must be connected')
  return database
}

const sql = (async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  const text = strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
  return (await connectedDatabase().query(text, [...values])).rows as Record<string, unknown>[]
}) as unknown as {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<Record<string, unknown>[]>
  query: (text: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>
}
sql.query = async (text, values = []) => (
  (await connectedDatabase().query(text, [...values])).rows as Record<string, unknown>[]
)

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: {
    sql,
    runtimeDatabaseUrl: () => 'postgresql://integration-test.invalid/place-quiet',
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
  const containerName = `1f3d9-place-quiet-${process.pid}-${randomBytes(4).toString('hex')}`
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

const ownerSecret = `1f3d9_sk_${'5'.repeat(48)}`
const neighborSecret = `1f3d9_sk_${'6'.repeat(48)}`

function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
}

type SeededPlace = Readonly<{ continentId: number; roomId: number }>

async function resetDatabase(): Promise<SeededPlace> {
  const client = connectedDatabase()
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await client.query(schemaDdl)
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'quiet-owner', 'place-quiet-test', $1),
      (2, 'neighbor', 'place-quiet-test', $2)
  `, [secretHash(ownerSecret), secretHash(neighborSecret)])
  const worldId = Number((await client.query<{ id: number }>(
    `SELECT id FROM places WHERE place_kind = 'world'`,
  )).rows[0]!.id)
  const continentId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'continent', 'Quiet Continent', 'test continent', 1)
    RETURNING id
  `, [worldId])).rows[0]!.id)
  const roomId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'place', 'Reading Room', 'a room with a real door', 1)
    RETURNING id
  `, [continentId])).rows[0]!.id)
  return Object.freeze({ continentId, roomId })
}

async function storedQuiet(roomId: number): Promise<boolean> {
  const rows = await connectedDatabase().query<{ quiet: boolean }>(
    'SELECT quiet FROM places WHERE id = $1', [roomId],
  )
  assert.ok(rows.rows[0], `place ${roomId} must exist`)
  return rows.rows[0]!.quiet
}

async function mapQuiet(app: import('hono').Hono, continentId: number, roomId: number): Promise<boolean> {
  const response = await app.request(`/api/map?view=outline&parent_id=${continentId}`)
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.json() as { subplaces: Array<{ id: number; quiet: boolean }> }
  const row = body.subplaces.find(subplace => subplace.id === roomId)
  assert.ok(row, `map outline under continent ${continentId} must list room ${roomId}`)
  return row.quiet
}

async function placeRecordQuiet(app: import('hono').Hono, roomId: number): Promise<boolean> {
  const response = await app.request(`/api/place/${roomId}`)
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.json() as { place: { quiet: boolean } }
  return body.place.quiet
}

test('place quiet marks apply, refuse, and disclose correctly in PostgreSQL', {
  timeout: 120_000,
}, async t => {
  const postgres = await startPostgres()
  database = postgres.client
  try {
    const { Hono } = await import('hono')
    const { mountWorldRoutes } = await import('../../src/world.ts')
    const app = new Hono()
    mountWorldRoutes(app)

    await t.test('the additive quiet migration runs twice against the real schema and stays false by default', async () => {
      const seeded = await resetDatabase()
      await connectedDatabase().query(quietMigrationDdl)
      await connectedDatabase().query(quietMigrationDdl)
      assert.equal(await storedQuiet(seeded.roomId), false)
    })

    await t.test('the owner may set quiet true, disclosed on the public record and the map', async () => {
      const seeded = await resetDatabase()
      assert.equal(await placeRecordQuiet(app, seeded.roomId), false)
      assert.equal(await mapQuiet(app, seeded.continentId, seeded.roomId), false)

      const response = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret), body: JSON.stringify({ quiet: true }),
      })
      assert.equal(response.status, 200, await response.clone().text())
      const body = await response.json() as { place: { quiet: boolean } }
      assert.equal(body.place.quiet, true)
      assert.equal(await storedQuiet(seeded.roomId), true)
      assert.equal(await placeRecordQuiet(app, seeded.roomId), true)
      assert.equal(await mapQuiet(app, seeded.continentId, seeded.roomId), true)
    })

    await t.test('the owner may set quiet back to false, disclosed the same way', async () => {
      const seeded = await resetDatabase()
      const enable = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret), body: JSON.stringify({ quiet: true }),
      })
      assert.equal(enable.status, 200, await enable.clone().text())
      assert.equal(await storedQuiet(seeded.roomId), true)

      const disable = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret), body: JSON.stringify({ quiet: false }),
      })
      assert.equal(disable.status, 200, await disable.clone().text())
      const body = await disable.json() as { place: { quiet: boolean } }
      assert.equal(body.place.quiet, false)
      assert.equal(await storedQuiet(seeded.roomId), false)
      assert.equal(await placeRecordQuiet(app, seeded.roomId), false)
      assert.equal(await mapQuiet(app, seeded.continentId, seeded.roomId), false)
    })

    await t.test('a no-op quiet write (already the requested value) is not an error', async () => {
      const seeded = await resetDatabase()
      const response = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret), body: JSON.stringify({ quiet: false }),
      })
      assert.equal(response.status, 200, await response.clone().text())
      assert.equal(await storedQuiet(seeded.roomId), false)
    })

    await t.test('a non-owner is refused and the column stays unchanged', async () => {
      const seeded = await resetDatabase()
      const response = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(neighborSecret), body: JSON.stringify({ quiet: true }),
      })
      assert.equal(response.status, 403, await response.clone().text())
      assert.equal(await storedQuiet(seeded.roomId), false)
    })

    await t.test('a non-boolean quiet value is rejected with 400 and the column stays unchanged', async () => {
      const seeded = await resetDatabase()
      for (const malformed of ['yes', 1, 0, 'true', [], {}]) {
        const response = await app.request(`/api/place/${seeded.roomId}`, {
          method: 'PATCH', headers: bearer(ownerSecret), body: JSON.stringify({ quiet: malformed }),
        })
        assert.equal(
          response.status, 400,
          JSON.stringify({ malformed, body: await response.text() }),
        )
        assert.equal(await storedQuiet(seeded.roomId), false)
      }
    })

    await t.test('the protected world root can never be marked quiet', async () => {
      await resetDatabase()
      const worldId = Number((await connectedDatabase().query<{ id: number }>(
        `SELECT id FROM places WHERE place_kind = 'world'`,
      )).rows[0]!.id)
      // The world-immutability trigger fires first (backstop before any
      // content, permission, or label ever reaches it); the places_world_shape
      // CHECK constraint is the second, independent line of defense for any
      // write that reached the table directly. Prove the outcome — never
      // quiet — rather than pin which guard fired.
      await assert.rejects(
        connectedDatabase().query('UPDATE places SET quiet = TRUE WHERE id = $1', [worldId]),
      )
      const stillNotQuiet = await connectedDatabase().query<{ quiet: boolean }>(
        'SELECT quiet FROM places WHERE id = $1', [worldId],
      )
      assert.equal(stillNotQuiet.rows[0]!.quiet, false)
    })

    await t.test('the places_world_shape constraint independently rejects a quiet world root', async () => {
      await resetDatabase()
      const worldId = Number((await connectedDatabase().query<{ id: number }>(
        `SELECT id FROM places WHERE place_kind = 'world'`,
      )).rows[0]!.id)
      await assert.rejects(
        connectedDatabase().query(
          "UPDATE places SET quiet = TRUE WHERE id = $1 AND place_kind = 'world'::text",
        ),
      )
      // DISABLE TRIGGER is itself transactional DDL: rolling back the
      // transaction undoes it along with anything the disabled trigger let
      // through, so the immutability guard is never actually weakened.
      const client = await connectedDatabase().connect()
      try {
        await client.query('BEGIN')
        await client.query('ALTER TABLE places DISABLE TRIGGER USER')
        await assert.rejects(
          client.query('UPDATE places SET quiet = TRUE WHERE id = $1', [worldId]),
          { code: '23514' },
        )
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })
  } finally {
    await database?.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
