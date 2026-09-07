import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { registerSchemaAndLedgerTests } from './city-credit-tests/schema-and-ledger.ts'
import { registerReturnsAndCompletionTests } from './city-credit-tests/returns-and-completion.ts'
import { registerServiceLifecycleTests } from './city-credit-tests/service-lifecycle.ts'
import { registerRecoveryDeadlineTests } from './city-credit-tests/recovery-deadlines.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'city_credit_integration'
const MIGRATION_URL = new URL('../../db/migrations/20260822_city_credit.sql', import.meta.url)
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-city-credit-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

async function resetFresh(database: Pool): Promise<void> {
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'city-credit-test', repeat('1', 64)),
      (2, 'resident-two', 'city-credit-test', repeat('2', 64)),
      (3, 'resident-three', 'city-credit-test', repeat('3', 64))
  `)
}

test('city fee credit remains founder-issued, append-only, and race-safe in PostgreSQL', {
  timeout: 120_000,
}, async t => {
  assert.equal(
    existsSync(MIGRATION_URL),
    true,
    'add db/migrations/20260822_city_credit.sql before running the PostgreSQL gate',
  )
  const migrationDdl = await readFile(MIGRATION_URL, 'utf8')
  const postgres = await startPostgres()
  try {
    await registerSchemaAndLedgerTests(t, postgres, resetFresh, migrationDdl)
    await registerReturnsAndCompletionTests(t, postgres, resetFresh)
    await registerServiceLifecycleTests(t, postgres, resetFresh)
    await registerRecoveryDeadlineTests(t, postgres, resetFresh)
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
