import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  insertRuntimeLogs,
  runRuntimeLogRetention,
  type RuntimeLogDatabase,
  type RuntimeLogRecord,
} from '../../src/runtime-logs.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'runtime_logs_integration'
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260826_runtime_logs.sql', import.meta.url),
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
  const containerName = `1f3d9-runtime-logs-${process.pid}-${randomBytes(4).toString('hex')}`
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

function record(id: string, project: string): RuntimeLogRecord {
  return Object.freeze({
    id,
    timestamp: '2026-03-17T00:00:00.123Z',
    project,
    source: 'lambda',
    level: 'error',
    requestPath: '/api/market/shelves',
    requestMethod: 'GET',
    statusCode: 500,
    durationMs: null,
    userAgent: 'VercelDrain integration test',
    message: 'shelves request failed',
    deploymentId: `dpl_${id}`,
  })
}

test('runtime logs insert idempotently and purge only a bounded older-than-30-day page', {
  timeout: 120_000,
}, async t => {
  const postgres = await startPostgres()
  t.after(async () => {
    await postgres.database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  })

  await postgres.database.query(migrationDdl)
  await postgres.database.query(migrationDdl)
  const runtimeDatabase: RuntimeLogDatabase = {
    query: async (text, params = []) =>
      (await postgres.database.query(text, [...params])).rows as Record<string, unknown>[],
  }

  const supportTables = (await postgres.database.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('runtime_logs', 'runtime_log_retention_state')
    ORDER BY table_name
  `)).rows.map(row => row.table_name)
  assert.deepEqual(supportTables, ['runtime_log_retention_state', 'runtime_logs'])

  await postgres.database.query(
    'ALTER TABLE runtime_log_retention_state ALTER COLUMN last_hour DROP NOT NULL',
  )
  await assert.rejects(
    postgres.database.query(migrationDdl),
    /runtime log retention state conflicts with the reviewed columns/iu,
  )
  await postgres.database.query(
    'ALTER TABLE runtime_log_retention_state ALTER COLUMN last_hour SET NOT NULL',
  )

  await postgres.database.query(
    'ALTER TABLE runtime_log_retention_state ALTER COLUMN singleton SET DEFAULT FALSE',
  )
  await assert.rejects(
    postgres.database.query(migrationDdl),
    /runtime log retention state conflicts with the reviewed singleton default/iu,
  )
  await postgres.database.query(
    'ALTER TABLE runtime_log_retention_state ALTER COLUMN singleton SET DEFAULT TRUE',
  )

  await postgres.database.query(`
    ALTER TABLE runtime_log_retention_state
      DROP CONSTRAINT runtime_log_retention_state_last_hour_aligned;
    ALTER TABLE runtime_log_retention_state
      ADD CONSTRAINT runtime_log_retention_state_last_hour_aligned
      CHECK (last_hour IS NOT NULL);
  `)
  await assert.rejects(
    postgres.database.query(migrationDdl),
    /runtime log retention state conflicts with the reviewed constraints/iu,
  )
  await postgres.database.query(`
    ALTER TABLE runtime_log_retention_state
      DROP CONSTRAINT runtime_log_retention_state_last_hour_aligned;
    ALTER TABLE runtime_log_retention_state
      ADD CONSTRAINT runtime_log_retention_state_last_hour_aligned
      CHECK (
        last_hour = (
          date_trunc('hour', last_hour AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        )
      );
  `)

  await postgres.database.query(
    'ALTER TABLE runtime_logs ALTER COLUMN received_at SET DEFAULT statement_timestamp()',
  )
  await assert.rejects(
    postgres.database.query(migrationDdl),
    /runtime log table conflicts with the reviewed received_at default/iu,
  )
  await postgres.database.query(
    'ALTER TABLE runtime_logs ALTER COLUMN received_at SET DEFAULT clock_timestamp()',
  )

  await postgres.database.query(`
    ALTER TABLE runtime_logs DROP CONSTRAINT runtime_logs_message_bounded;
    ALTER TABLE runtime_logs ADD CONSTRAINT runtime_logs_message_bounded
      CHECK (message IS NULL OR octet_length(message) <= 8192);
  `)
  await assert.rejects(
    postgres.database.query(migrationDdl),
    /runtime log table conflicts with the reviewed constraints/iu,
  )
  await postgres.database.query(`
    ALTER TABLE runtime_logs DROP CONSTRAINT runtime_logs_message_bounded;
    ALTER TABLE runtime_logs ADD CONSTRAINT runtime_logs_message_bounded
      CHECK (message IS NULL OR octet_length(message) <= 4096);
  `)

  await postgres.database.query('DROP INDEX runtime_logs_retention')
  await postgres.database.query(
    'CREATE INDEX runtime_logs_retention ON runtime_logs (project)',
  )
  await assert.rejects(
    postgres.database.query(migrationDdl),
    /runtime log table conflicts with the reviewed retention index/iu,
  )
  await postgres.database.query('DROP INDEX runtime_logs_retention')
  await postgres.database.query(
    'CREATE INDEX runtime_logs_retention ON runtime_logs (received_at, id)',
  )

  await postgres.database.query('DROP INDEX runtime_logs_project_timestamp')
  await postgres.database.query(
    'CREATE INDEX runtime_logs_project_timestamp ON runtime_logs (project, timestamp)',
  )
  await assert.rejects(
    postgres.database.query(migrationDdl),
    /runtime log table conflicts with the reviewed project timestamp index/iu,
  )
  await postgres.database.query('DROP INDEX runtime_logs_project_timestamp')
  await postgres.database.query(
    'CREATE INDEX runtime_logs_project_timestamp ON runtime_logs (project, timestamp DESC, id DESC)',
  )
  await postgres.database.query(migrationDdl)

  const columns = (await postgres.database.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'runtime_logs'
    ORDER BY ordinal_position
  `)).rows.map(row => row.column_name)
  assert.deepEqual(columns, [
    'id', 'received_at', 'project', 'timestamp', 'source', 'level',
    'request_path', 'request_method', 'status_code', 'duration_ms',
    'user_agent', 'message', 'deployment_id',
  ])

  const records = [
    record('log_oldest', '1f3d9'),
    record('log_old', '1f3ea'),
    record('log_boundary', '1f3d9'),
    record('log_recent', '1f3ea'),
  ]
  assert.equal(await insertRuntimeLogs(runtimeDatabase, records), 4)
  assert.equal(await insertRuntimeLogs(runtimeDatabase, records), 0)

  await postgres.database.query(`
    UPDATE runtime_logs
    SET received_at = CASE id
      WHEN 'log_oldest' THEN '2026-01-01T00:00:00Z'::timestamptz
      WHEN 'log_old' THEN '2026-02-14T23:59:59.999Z'::timestamptz
      WHEN 'log_boundary' THEN '2026-02-15T00:00:00Z'::timestamptz
      ELSE '2026-02-16T00:00:00Z'::timestamptz
    END
  `)
  assert.deepEqual(
    await runRuntimeLogRetention(runtimeDatabase, new Date('2026-03-17T00:00:00.000Z')),
    { ran: true, deleted: 2 },
  )
  assert.deepEqual(
    (await postgres.database.query<{ id: string }>(
      'SELECT id FROM runtime_logs ORDER BY received_at, id',
    )).rows.map(row => row.id),
    ['log_boundary', 'log_recent'],
  )

  await postgres.database.query('DELETE FROM runtime_logs')
  assert.equal(
    await insertRuntimeLogs(runtimeDatabase, [record('log_hourly_retention', '1f3d9')]),
    1,
  )
  await postgres.database.query(`
    UPDATE runtime_logs
    SET received_at = '2026-01-01T00:00:00Z'::timestamptz
    WHERE id = 'log_hourly_retention'
  `)
  await postgres.database.query("SET TIME ZONE 'Asia/Kathmandu'")
  assert.deepEqual(
    await runRuntimeLogRetention(runtimeDatabase, new Date('2026-03-17T12:04:59.999Z')),
    { ran: true, deleted: 1 },
  )
  assert.deepEqual(
    await runRuntimeLogRetention(runtimeDatabase, new Date('2026-03-17T12:04:59.999Z')),
    { ran: false, deleted: 0 },
  )

  const indexes = (await postgres.database.query<{ indexname: string }>(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'runtime_logs'
    ORDER BY indexname
  `)).rows.map(row => row.indexname)
  assert.ok(indexes.includes('runtime_logs_project_timestamp'))
  assert.ok(indexes.includes('runtime_logs_retention'))

  const indexDefinitions = (await postgres.database.query<{ indexdef: string }>(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN ('runtime_logs_project_timestamp', 'runtime_logs_retention')
    ORDER BY indexname
  `)).rows.map(row => row.indexdef)
  assert.deepEqual(indexDefinitions, [
    'CREATE INDEX runtime_logs_project_timestamp ON public.runtime_logs USING btree (project, "timestamp" DESC, id DESC)',
    'CREATE INDEX runtime_logs_retention ON public.runtime_logs USING btree (received_at, id)',
  ])
})
