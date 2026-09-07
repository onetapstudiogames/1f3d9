import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock, type TestContext } from 'node:test'
import { Pool } from 'pg'
import type { PublicQueryExecutor } from '../../../src/public-pagination.ts'
import { POSTGRES_DATABASE, POSTGRES_IMAGE, seedCity, type SeededCity } from './seed-city.ts'

let database: Pool | null = null
export let statementCount = 0

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

export const sql = Object.assign(sqlTag, {
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

mock.module(new URL('../../../src/db.ts', import.meta.url).href, {
  namedExports: {
    sql,
    runtimeDatabaseUrl: () => 'postgresql://integration-test.invalid/public-pagination',
  },
})

export interface PostgresInstance {
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

export const executePublicQuery: PublicQueryExecutor = async (text, values) => {
  statementCount += 1
  return (await connectedDatabase().query(text, [...values])).rows as Record<string, unknown>[]
}

type RegisterPublicPaginationConcerns = (
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
) => Promise<void>

export function registerPublicPaginationTests(
  registerConcerns: RegisterPublicPaginationConcerns,
): void {
  test('public listing pages use bounded keyset reads against PostgreSQL', async t => {
    const postgres = await startPostgres()
    database = postgres.client

    try {
      const city = await seedCity(postgres.client)
      await registerConcerns(t, postgres, city)
    } finally {
      database = null
      await postgres.client.end().catch(() => undefined)
      spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
    }
  })
}
