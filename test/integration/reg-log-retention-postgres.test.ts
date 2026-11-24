import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  REG_LOG_RETENTION_PAGE_LIMIT,
  REG_LOG_RETENTION_SQL,
  runRegLogRetention,
  type RegLogDatabase,
} from '../../src/reg-log-retention.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'reg_log_retention_integration'
const HOUR_MS = 60 * 60 * 1_000
const YOUNG_ROWS = 100_000
const OLD_ROWS = REG_LOG_RETENTION_PAGE_LIMIT + 1_234

// The reg_log table and its two indexes exactly as db/schema.sql creates them.
const schema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const regLogDdl = schema.match(
  /CREATE TABLE IF NOT EXISTS reg_log \([\s\S]*?\);\nCREATE INDEX IF NOT EXISTS reg_log_ip [^\n]*\nCREATE INDEX IF NOT EXISTS reg_log_created [^\n]*\n/u,
)?.[0]
assert.ok(regLogDdl, 'db/schema.sql still creates reg_log and its two indexes')

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ database: Pool; containerName: string }> {
  const containerName = `1f3d9-reg-log-${process.pid}-${randomBytes(4).toString('hex')}`
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
      database: POSTGRES_DATABASE, ssl: false, max: 2,
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

const hash = (n: number) => `${n.toString(16).padStart(8, '0')}${'a'.repeat(56)}`

test('sign-up network records older than 24 hours are deleted in bounded pages and younger ones are kept', {
  timeout: 180_000,
}, async t => {
  const postgres = await startPostgres()
  t.after(async () => {
    await postgres.database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  })
  const pool = postgres.database
  await pool.query(regLogDdl)
  const database: RegLogDatabase = {
    query: async (text, params = []) => (await pool.query(text, [...params])).rows as Record<string, unknown>[],
  }

  const now = new Date('2026-11-24T17:37:00.000Z')
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString()
  // Young rows spread over the last 24 hours, plus the two edges that must stay.
  await pool.query(`
    INSERT INTO reg_log (ip_hash, created_at)
    SELECT lpad(to_hex(n), 8, '0') || repeat('b', 56), $1::timestamptz - (n % 86000) * interval '1 second'
    FROM generate_series(1, $2::int) AS n
  `, [now.toISOString(), YOUNG_ROWS])
  await pool.query('INSERT INTO reg_log (ip_hash, created_at) VALUES ($1, $2), ($3, $4), ($5, $6)', [
    hash(1), at(24 * HOUR_MS),          // exactly 24 hours old: kept
    hash(2), at(24 * HOUR_MS - 1),      // just under: kept
    hash(3), at(0),                     // this instant: kept
  ])
  // Old rows: just over 24 hours up to weeks old.
  await pool.query(`
    INSERT INTO reg_log (ip_hash, created_at)
    SELECT lpad(to_hex(n), 8, '0') || repeat('c', 56),
      $1::timestamptz - interval '24 hours' - interval '1 millisecond' - (n * interval '7 minutes')
    FROM generate_series(0, $2::int - 1) AS n
  `, [now.toISOString(), OLD_ROWS])
  await pool.query('ANALYZE reg_log')

  const young = YOUNG_ROWS + 3
  const counts = async () => (await pool.query<{ old: number; young: number }>(`
    SELECT count(*) FILTER (WHERE created_at < $1::timestamptz - interval '24 hours')::int AS old,
      count(*) FILTER (WHERE created_at >= $1::timestamptz - interval '24 hours')::int AS young
    FROM reg_log
  `, [now.toISOString()])).rows[0]!
  const youngSnapshot = async () => (await pool.query<{ digest: string }>(`
    SELECT md5(string_agg(ip_hash || '@' || created_at::text, ',' ORDER BY created_at, ip_hash)) AS digest
    FROM reg_log WHERE created_at >= $1::timestamptz - interval '24 hours'
  `, [now.toISOString()])).rows[0]!.digest
  assert.deepEqual(await counts(), { old: OLD_ROWS, young })
  const before = await youngSnapshot()

  // The delete finds old rows through the created_at index, never a scan of the whole table.
  const plan = (await pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${REG_LOG_RETENTION_SQL}`,
    [at(24 * HOUR_MS), REG_LOG_RETENTION_PAGE_LIMIT])).rows.map(row => row['QUERY PLAN']).join('\n')
  t.diagnostic(plan)
  assert.match(plan, /reg_log_created/u)
  assert.doesNotMatch(plan, /Seq Scan/u)

  const started = performance.now()
  assert.deepEqual(await runRegLogRetention(database, now), { deleted: REG_LOG_RETENTION_PAGE_LIMIT })
  t.diagnostic(`one ${REG_LOG_RETENTION_PAGE_LIMIT}-row page ${(performance.now() - started).toFixed(1)} ms`)
  assert.deepEqual(await counts(), { old: OLD_ROWS - REG_LOG_RETENTION_PAGE_LIMIT, young })
  // The oldest go first: what is left is the youngest of the old rows.
  const oldestLeft = (await pool.query<{ oldest: Date }>('SELECT min(created_at) AS oldest FROM reg_log')).rows[0]!.oldest
  assert.equal(oldestLeft.getTime(),
    now.getTime() - 24 * HOUR_MS - 1 - (OLD_ROWS - REG_LOG_RETENTION_PAGE_LIMIT - 1) * 7 * 60_000)

  assert.deepEqual(await runRegLogRetention(database, now),
    { deleted: OLD_ROWS - REG_LOG_RETENTION_PAGE_LIMIT })
  assert.deepEqual(await counts(), { old: 0, young })
  assert.deepEqual(await runRegLogRetention(database, now), { deleted: 0 }, 'a quiet tick deletes nothing')
  assert.equal(await youngSnapshot(), before, 'every row younger than 24 hours is untouched')

  // A day later with no sign-up in between, the same purge clears what aged out,
  // one bounded page per tick.
  const dayLater = new Date(now.getTime() + 24 * HOUR_MS + 1)
  const pages: number[] = []
  for (let deleted = -1; deleted !== 0;) {
    deleted = (await runRegLogRetention(database, dayLater)).deleted
    pages.push(deleted)
    assert.ok(pages.length <= Math.ceil(young / REG_LOG_RETENTION_PAGE_LIMIT) + 1)
  }
  assert.equal(pages.reduce((sum, deleted) => sum + deleted, 0), young)
  assert.ok(pages.every(deleted => deleted <= REG_LOG_RETENTION_PAGE_LIMIT))
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM reg_log')).rows[0]!.n), 0)

  // Two ticks at once never fail or delete a row twice.
  await pool.query(`
    INSERT INTO reg_log (ip_hash, created_at)
    SELECT lpad(to_hex(n), 8, '0') || repeat('d', 56), $1::timestamptz - interval '25 hours'
    FROM generate_series(1, 300) AS n
  `, [now.toISOString()])
  const [first, second] = await Promise.all([runRegLogRetention(database, now), runRegLogRetention(database, now)])
  assert.equal(first.deleted + second.deleted, 300)
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM reg_log')).rows[0]!.n), 0)
})
