import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  advanceResidentRefusal,
  type RefusalQueryExecutor,
} from '../../src/resident-refusal.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'resident_refusal_integration'
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260827_resident_refusal_state.sql', import.meta.url),
  'utf8',
)

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ database: Pool; containerName: string }> {
  const containerName = `1f3d9-resident-refusal-${process.pid}-${randomBytes(4).toString('hex')}`
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
    assert.ok(Number.isInteger(port) && port > 0)
    const database = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        await database.query('SELECT 1')
        return { database, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await database.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

test('resident refusal streaks serialize concurrent repeats and isolate causes', {
  timeout: 120_000,
}, async t => {
  const postgres = await startPostgres()
  t.after(async () => {
    await postgres.database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  })

  await postgres.database.query('CREATE TABLE residents (id INTEGER PRIMARY KEY)')
  await postgres.database.query('INSERT INTO residents (id) VALUES (7), (8)')
  await postgres.database.query(migrationDdl)
  await postgres.database.query(migrationDdl)

  const query: RefusalQueryExecutor = async (text, values) => (
    await postgres.database.query(text, [...values])
  ).rows as Record<string, unknown>[]
  const causeA = 'this place is not open to notes'
  const causeB = 'the daily note limit has been reached'

  const concurrentCounts = await Promise.all(
    Array.from({ length: 9 }, () => advanceResidentRefusal(7, 403, causeA, query)),
  )
  assert.deepEqual([...concurrentCounts].sort((left, right) => left - right), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(await advanceResidentRefusal(7, 403, causeA, query), 10)
  assert.equal(await advanceResidentRefusal(7, 403, causeA, query), 10)

  assert.equal(await advanceResidentRefusal(7, 403, causeB, query), 1)
  assert.equal(await advanceResidentRefusal(7, 403, causeA, query), 1)
  assert.equal(await advanceResidentRefusal(7, 409, causeA, query), 1)
  assert.equal(await advanceResidentRefusal(8, 403, causeA, query), 1)

  const rows = (await postgres.database.query<{
    resident_id: number
    http_status: number
    cause_hash: string
    repetition_count: number
  }>(`
    SELECT resident_id, http_status, cause_hash, repetition_count
    FROM resident_refusal_state
    ORDER BY resident_id
  `)).rows
  assert.deepEqual(rows.map(row => ({
    resident_id: row.resident_id,
    http_status: row.http_status,
    cause_hash_length: row.cause_hash.length,
    repetition_count: row.repetition_count,
  })), [
    { resident_id: 7, http_status: 409, cause_hash_length: 64, repetition_count: 1 },
    { resident_id: 8, http_status: 403, cause_hash_length: 64, repetition_count: 1 },
  ])

  const columns = (await postgres.database.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'resident_refusal_state'
    ORDER BY ordinal_position
  `)).rows.map(row => row.column_name)
  assert.deepEqual(columns, [
    'resident_id', 'http_status', 'cause_hash', 'repetition_count', 'updated_at',
  ])
})
