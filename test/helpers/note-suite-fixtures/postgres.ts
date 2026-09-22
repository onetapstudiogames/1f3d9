// A disposable PostgreSQL 17 city for the note suites: the real schema, the real
// routes through src/index.ts, and one interactive transaction per engine action.
// src/db.ts is mocked to this container before the app loads, the same seam the
// small-reader suite uses, so every read and write below is real SQL.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { mock } from 'node:test'
import { Pool, type PoolClient } from 'pg'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const schemaDdl = await readFile(new URL('../../../db/schema.sql', import.meta.url), 'utf8')

let database: Pool | null = null

export function connectedDatabase(): Pool {
  assert.ok(database, 'the note suite database must be connected')
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

type QueryStatement = Readonly<{ text: string; values: readonly unknown[] }>

// The app's exact reads and reading-cost meter send one batch of statements
// inside a single transaction, the way the Neon client does.
async function batchedTransaction(
  build: (transaction: { query: (text: string, values?: readonly unknown[]) => QueryStatement }) => readonly QueryStatement[],
  options: Readonly<{ readOnly?: boolean }> = {},
): Promise<Record<string, unknown>[][]> {
  const statements = build({ query: (text, values = []) => ({ text, values }) })
  const client = await connectedDatabase().connect()
  try {
    await client.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
    const results: Record<string, unknown>[][] = []
    for (const statement of statements) {
      results.push((await client.query(statement.text, [...statement.values])).rows as Record<string, unknown>[])
    }
    await client.query('COMMIT')
    return results
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

const sql = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => (
    taggedFor(connectedDatabase())(strings, ...values)
  ),
  {
    query: async (text: string, values: readonly unknown[] = []) => (
      taggedFor(connectedDatabase()).query(text, values)
    ),
    transaction: batchedTransaction,
  },
)

mock.module(new URL('../../../src/db.ts', import.meta.url).href, {
  namedExports: {
    sql,
    runtimeDatabaseUrl: () => 'postgresql://note-suite.invalid/local-only',
  },
})

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

export type NoteSuiteDatabase = Readonly<{ client: Pool; stop: () => Promise<void> }>

async function useEngineTransactions(client: Pool): Promise<void> {
  const { setEngineTransactionRunnerForTests } = await import('../../../src/engine.ts')
  setEngineTransactionRunnerForTests(async (_db, work) => {
    const connection = await client.connect()
    try {
      await connection.query('BEGIN')
      const result = await work(taggedFor(connection), true)
      await connection.query('COMMIT')
      return result
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      connection.release()
    }
  })
}

export async function startNoteSuiteDatabase(name: string): Promise<NoteSuiteDatabase> {
  const containerName = `1f3d9-${name}-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  const databaseName = name.replaceAll('-', '_')
  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${databaseName}`,
    POSTGRES_IMAGE,
  ])
  const stopContainer = () => {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8', windowsHide: true })
  }
  try {
    const portOutput = runDocker(['port', containerName, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(Number.isSafeInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const client = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: databaseName, ssl: false, max: 8,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        await client.query('SELECT 1')
        database = client
        await useEngineTransactions(client)
        return Object.freeze({
          client,
          stop: async () => {
            const { setEngineTransactionRunnerForTests } = await import('../../../src/engine.ts')
            setEngineTransactionRunnerForTests(null)
            database = null
            await client.end().catch(() => undefined)
            stopContainer()
          },
        })
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await client.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    stopContainer()
    throw error
  }
}

function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export type SuiteResident = Readonly<{ id: number; handle: string; secret: string }>
export type SeededRooms = Readonly<{ continentId: number; eastRoomId: number; westRoomId: number }>

/** Reset to the real schema with the given residents and two open rooms on one continent. */
export async function resetCity(residents: readonly SuiteResident[]): Promise<SeededRooms> {
  const client = connectedDatabase()
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await client.query(schemaDdl)
  for (const resident of residents) {
    await client.query(
      `INSERT INTO residents (id, handle, model, secret_hash) VALUES ($1, $2, 'note-suite', $3)`,
      [resident.id, resident.handle, secretHash(resident.secret)],
    )
  }
  await client.query(
    'UPDATE resident_id_allocator SET last_id = $1 WHERE singleton',
    [Math.max(...residents.map(resident => resident.id))],
  )
  const worldId = Number((await client.query<{ id: number }>(
    `SELECT id FROM places WHERE place_kind = 'world'`,
  )).rows[0]!.id)
  const continentId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'continent', 'Walking Continent', 'note suite land', 1)
    RETURNING id
  `, [worldId])).rows[0]!.id)
  const eastRoomId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_notes)
    VALUES ($1, 'place', 'East Room', 'the east room', 1, TRUE)
    RETURNING id
  `, [continentId])).rows[0]!.id)
  const westRoomId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_notes)
    VALUES ($1, 'place', 'West Room', 'the west room', 1, TRUE)
    RETURNING id
  `, [continentId])).rows[0]!.id)
  return Object.freeze({ continentId, eastRoomId, westRoomId })
}

/** Stand a resident in one room, exactly as a finished move leaves it. */
export async function standIn(residentId: number, placeId: number): Promise<void> {
  await connectedDatabase().query(`
    INSERT INTO resident_presence (resident_id, current_place_id)
    VALUES ($1, $2)
    ON CONFLICT (resident_id) DO UPDATE SET current_place_id = EXCLUDED.current_place_id
  `, [residentId, placeId])
}

export function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
}
