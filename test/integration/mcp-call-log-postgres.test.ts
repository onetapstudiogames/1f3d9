import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  MCP_CALL_LOG_RETENTION_PAGE_LIMIT,
  readMcpCallLog,
  recordMcpCall,
  runMcpCallLogRetention,
  type McpCallLogDatabase,
  type McpCallLogRow,
} from '../../src/mcp-call-log.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'mcp_call_log_integration'
const DAY_MS = 24 * 60 * 60 * 1_000
const SEEDED_ROWS = 300_000
const EXPIRED_ROWS = 12_000
const TIMED_INSERTS = 1_000
const INSERT_P95_BUDGET_MS = 5
const migrationDdl = await readFile(
  new URL('../../db/migrations/20261009_mcp_call_log.sql', import.meta.url),
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
  const containerName = `1f3d9-mcp-call-log-${process.pid}-${randomBytes(4).toString('hex')}`
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
      database: POSTGRES_DATABASE, ssl: false, max: 1,
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

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!
}

function row(overrides: Partial<McpCallLogRow> = {}): McpCallLogRow {
  return Object.freeze({
    door: 'connect',
    tool: 'look',
    residentId: 77,
    clientFamily: 'chatgpt',
    requestId: randomUUID(),
    outcome: 'ok',
    refusalClass: null,
    httpStatus: 200,
    latencyMs: 12,
    ...overrides,
  }) as McpCallLogRow
}

test('the call log migration is repeatable, refuses bad rows, purges hourly, and keeps inserts cheap', {
  timeout: 600_000,
}, async t => {
  const postgres = await startPostgres()
  t.after(async () => {
    await postgres.database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  })
  const pool = postgres.database
  const database: McpCallLogDatabase = {
    query: async (text, params = []) => (await pool.query(text, [...params])).rows as Record<string, unknown>[],
  }

  // The DDL applies twice and its shape guard refuses a drifted table.
  await pool.query(migrationDdl)
  await pool.query(migrationDdl)
  await pool.query('ALTER TABLE mcp_call_log DROP CONSTRAINT mcp_call_log_tool_shape')
  await assert.rejects(pool.query(migrationDdl), /mcp call log table conflicts with the reviewed constraints/u)
  await pool.query("ALTER TABLE mcp_call_log ADD CONSTRAINT mcp_call_log_tool_shape CHECK (tool ~ '^[a-z_]{1,64}$')")
  await pool.query('ALTER TABLE mcp_call_log ADD COLUMN arguments TEXT')
  await assert.rejects(pool.query(migrationDdl), /mcp call log table conflicts with the reviewed columns/u)
  await pool.query('ALTER TABLE mcp_call_log DROP COLUMN arguments')
  await pool.query(migrationDdl)

  // The check constraints refuse rows outside the reviewed shape.
  const insert = `INSERT INTO mcp_call_log
    (door, tool, resident_id, client_family, request_id, outcome, refusal_class, http_status, latency_ms)
    VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, $8, $9)`
  const good = ['mcp', 'me', 1, 'codex', randomUUID(), 'refused', 'conflict', 409, 5]
  await pool.query(insert, good)
  for (const [index, value] of [
    [0, 'web'], [1, 'Me'], [1, 'x'.repeat(65)], [2, 0], [3, 'browser'], [5, 'maybe'],
    [6, 'teapot'], [7, 99], [7, 600], [8, -1], [8, 600_001],
  ] as const) {
    const params = [...good]
    params[index] = value
    params[4] = randomUUID()
    await assert.rejects(pool.query(insert, params), /check constraint/u, `column ${index} = ${value}`)
  }
  await assert.rejects(pool.query(insert, ['mcp', 'me', 1, 'codex', randomUUID(), 'ok', 'conflict', 200, 5]),
    /mcp_call_log_ok_has_no_refusal_class/u)
  await assert.rejects(pool.query('INSERT INTO mcp_call_log (id, door, tool, client_family, request_id, outcome, latency_ms) VALUES (1, \'mcp\', \'me\', \'other\', gen_random_uuid(), \'ok\', 1)'),
    /cannot insert a non-DEFAULT value into column "id"/u)
  await pool.query('TRUNCATE mcp_call_log')

  // Seed 30 days at 10,000 calls a day, plus rows older than 30 days for the purge.
  const now = new Date()
  await pool.query(`
    INSERT INTO mcp_call_log
      (at, door, tool, resident_id, client_family, request_id, outcome, refusal_class, http_status, latency_ms)
    SELECT
      $1::timestamptz - (series * interval '8600 milliseconds'),
      CASE WHEN series % 3 = 0 THEN 'mcp' ELSE 'connect' END,
      (ARRAY['look', 'me', 'say', 'browse', 'act'])[1 + series % 5],
      CASE WHEN series % 5 = 0 THEN NULL ELSE 1 + series % 5000 END,
      (ARRAY['chatgpt', 'codex', 'claude_ai', 'claude_code', 'other'])[1 + series % 5],
      gen_random_uuid(),
      CASE WHEN series % 10 = 0 THEN 'refused' ELSE 'ok' END,
      CASE WHEN series % 10 = 0 THEN 'not_found' ELSE NULL END,
      CASE WHEN series % 10 = 0 THEN 404 ELSE 200 END,
      series % 900
    FROM generate_series(1, $2::integer) AS series
  `, [now.toISOString(), SEEDED_ROWS - 1])
  await pool.query(`
    INSERT INTO mcp_call_log (at, door, tool, resident_id, client_family, request_id, outcome, latency_ms)
    SELECT $1::timestamptz - interval '31 days' - (series * interval '1 second'),
      'mcp', 'look', 77, 'other', gen_random_uuid(), 'ok', 3
    FROM generate_series(1, $2::integer) AS series
  `, [now.toISOString(), EXPIRED_ROWS])
  await pool.query('ANALYZE mcp_call_log')

  // Timing: 1,000 single parameterised inserts, exactly the city's write.
  const samples: number[] = []
  for (let index = 0; index < 20; index += 1) await recordMcpCall(database, row())
  for (let index = 0; index < TIMED_INSERTS; index += 1) {
    const started = performance.now()
    await recordMcpCall(database, row({ residentId: index % 7 === 0 ? null : 77 }))
    samples.push(performance.now() - started)
  }
  const baseline: number[] = []
  for (let index = 0; index < TIMED_INSERTS; index += 1) {
    const started = performance.now()
    await pool.query('SELECT 1')
    baseline.push(performance.now() - started)
  }
  const insertP50 = percentile(samples, 0.5)
  const insertP95 = percentile(samples, 0.95)
  t.diagnostic(`insert p50 ${insertP50.toFixed(3)} ms, p95 ${insertP95.toFixed(3)} ms, max ${Math.max(...samples).toFixed(3)} ms over ${TIMED_INSERTS} inserts into ${SEEDED_ROWS + EXPIRED_ROWS} rows`)
  t.diagnostic(`SELECT 1 round trip p50 ${percentile(baseline, 0.5).toFixed(3)} ms, p95 ${percentile(baseline, 0.95).toFixed(3)} ms`)
  assert.ok(insertP95 < INSERT_P95_BUDGET_MS, `insert p95 ${insertP95} ms is over ${INSERT_P95_BUDGET_MS} ms`)

  // The founder query with a resident filter, newest first.
  const queryStarted = performance.now()
  const page = await readMcpCallLog(database, {
    residentId: 77, since: null, until: null, beforeId: null, limit: 100,
  })
  const queryMs = performance.now() - queryStarted
  t.diagnostic(`founder query (resident filter, limit 100) ${queryMs.toFixed(3)} ms`)
  assert.equal(page.calls.length, 100)
  assert.equal(page.hasMore, true)
  assert.ok(page.calls.every(call => call.resident_id === 77))
  assert.ok(page.calls.every((call, index) => index === 0 || call.id < page.calls[index - 1]!.id))
  const next = await readMcpCallLog(database, {
    residentId: 77, since: null, until: null, beforeId: page.nextBeforeId, limit: 100,
  })
  assert.ok(next.calls[0]!.id < page.calls.at(-1)!.id)
  const windowed = await readMcpCallLog(database, {
    residentId: null,
    since: new Date(now.getTime() - 60_000),
    until: new Date(now.getTime() - 30_000),
    beforeId: null,
    limit: 500,
  })
  assert.ok(windowed.calls.length > 0)
  assert.ok(windowed.calls.every(call => {
    const at = Date.parse(call.at)
    return at >= now.getTime() - 60_000 && at < now.getTime() - 30_000
  }))
  // A typical resident (about 60 calls in 30 days) is read through the resident index.
  const rareStarted = performance.now()
  const rare = await readMcpCallLog(database, {
    residentId: 4322, since: null, until: null, beforeId: null, limit: 100,
  })
  t.diagnostic(`founder query (typical resident, ${rare.calls.length} rows) ${(performance.now() - rareStarted).toFixed(3)} ms`)
  assert.ok(rare.calls.length > 0 && rare.calls.every(call => call.resident_id === 4322))
  const plan = (await pool.query(`EXPLAIN (FORMAT JSON) SELECT id FROM mcp_call_log
    WHERE resident_id = 4322 ORDER BY id DESC LIMIT 101`)).rows[0]!['QUERY PLAN'] as unknown
  assert.match(JSON.stringify(plan), /mcp_call_log_resident/u)

  // The purge deletes only rows older than 30 days, once per hour, one page at a time.
  const hour = new Date(now)
  hour.setUTCMinutes(1, 0, 0)
  const countOld = async () => Number((await pool.query(
    'SELECT count(*)::int AS old FROM mcp_call_log WHERE at < $1::timestamptz',
    [new Date(hour.getTime() - 30 * DAY_MS).toISOString()],
  )).rows[0]!.old)
  const total = async () => Number((await pool.query('SELECT count(*)::int AS rows FROM mcp_call_log')).rows[0]!.rows)
  const before = await total()
  assert.equal(await countOld(), EXPIRED_ROWS)

  const purgeStarted = performance.now()
  assert.deepEqual(await runMcpCallLogRetention(database, hour),
    { ran: true, deleted: MCP_CALL_LOG_RETENTION_PAGE_LIMIT })
  t.diagnostic(`one ${MCP_CALL_LOG_RETENTION_PAGE_LIMIT}-row purge page ${(performance.now() - purgeStarted).toFixed(3)} ms`)
  assert.deepEqual(await runMcpCallLogRetention(database, new Date(hour.getTime() + 60_000)),
    { ran: false, deleted: 0 }, 'a second tick in the same hour does nothing')
  assert.deepEqual(await runMcpCallLogRetention(database, new Date(hour.getTime() + 5 * 60_000)),
    { ran: false, deleted: 0 }, 'minute 5 and later never purge')
  assert.deepEqual(await runMcpCallLogRetention(database, new Date(hour.getTime() + 3_600_000)),
    { ran: true, deleted: MCP_CALL_LOG_RETENTION_PAGE_LIMIT })
  assert.deepEqual(await runMcpCallLogRetention(database, new Date(hour.getTime() + 2 * 3_600_000)),
    { ran: true, deleted: EXPIRED_ROWS - 2 * MCP_CALL_LOG_RETENTION_PAGE_LIMIT })
  assert.deepEqual(await runMcpCallLogRetention(database, new Date(hour.getTime() + 3 * 3_600_000)),
    { ran: true, deleted: 0 })
  assert.deepEqual(await runMcpCallLogRetention(database, new Date(hour.getTime() - 3_600_000)),
    { ran: false, deleted: 0 }, 'an older hour never reclaims the marker')
  assert.equal(await countOld(), 0)
  assert.equal(await total(), before - EXPIRED_ROWS)
  assert.equal(Number((await pool.query('SELECT count(*)::int AS states FROM mcp_call_log_retention_state')).rows[0]!.states), 1)
})
