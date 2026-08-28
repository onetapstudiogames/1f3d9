import assert from 'node:assert/strict'
import test from 'node:test'
import {
  insertRuntimeLogs,
  runRuntimeLogRetention,
  type RuntimeLogDatabase,
  type RuntimeLogRecord,
} from '../src/runtime-logs.ts'

function storedRecord(overrides: Partial<RuntimeLogRecord> = {}): RuntimeLogRecord {
  return Object.freeze({
    id: 'log_0001',
    timestamp: '2026-03-17T00:00:00.123Z',
    project: '1f3d9',
    source: 'lambda',
    level: 'error',
    requestPath: '/api/action',
    requestMethod: 'POST',
    statusCode: 500,
    durationMs: null,
    userAgent: 'VercelDrain test',
    message: 'request failed safely',
    deploymentId: 'dpl_city123',
    ...overrides,
  })
}

test('runtime log inserts are parameterized, idempotent, and empty-batch safe', async () => {
  const calls: Array<{ text: string; params: readonly unknown[] }> = []
  const database: RuntimeLogDatabase = {
    query: async (text, params = []) => {
      calls.push({ text, params })
      return [{ id: 'log_0001' }]
    },
  }
  assert.equal(await insertRuntimeLogs(database, []), 0)
  assert.equal(calls.length, 0)

  const records = [storedRecord(), storedRecord({ id: 'log_0002', project: '1f3ea' })]
  assert.equal(await insertRuntimeLogs(database, records), 1)
  assert.equal(calls.length, 1)
  assert.match(calls[0]!.text, /INSERT\s+INTO\s+runtime_logs/iu)
  assert.match(calls[0]!.text, /ON\s+CONFLICT\s*\(id\)\s+DO\s+NOTHING/iu)
  assert.match(calls[0]!.text, /RETURNING\s+id/iu)
  assert.doesNotMatch(calls[0]!.text, /request failed safely|1f3ea/iu)
  assert.ok(calls[0]!.params.includes('request failed safely'))
  assert.ok(calls[0]!.params.includes('1f3ea'))
})

test('the five-minute cron wrapper opens one small UTC retention slot per hour', async () => {
  const calls: Array<{ text: string; params: readonly unknown[] }> = []
  let claimed = false
  const database: RuntimeLogDatabase = {
    query: async (text, params = []) => {
      calls.push({ text, params })
      if (claimed) return [{ ran: false, deleted: 0 }]
      claimed = true
      return [{ ran: true, deleted: 3 }]
    },
  }

  assert.deepEqual(
    await runRuntimeLogRetention(database, new Date('2026-03-17T12:05:00.000Z')),
    { ran: false, deleted: 0 },
  )
  assert.equal(calls.length, 0)

  assert.deepEqual(
    await runRuntimeLogRetention(database, new Date('2026-03-17T12:04:59.999Z')),
    { ran: true, deleted: 3 },
  )
  assert.match(calls[0]!.text, /set_config\(\s*'statement_timeout'\s*,\s*'15000'\s*,\s*true\s*\)/iu)
  assert.match(calls[0]!.text, /INSERT\s+INTO\s+runtime_log_retention_state/iu)
  assert.match(calls[0]!.text, /ON\s+CONFLICT\s*\(singleton\)\s+DO\s+UPDATE/iu)
  assert.match(calls[0]!.text, /received_at\s*<\s*\$2/iu)
  assert.match(calls[0]!.text, /ORDER\s+BY\s+log\.received_at\s*,\s*log\.id/iu)
  assert.match(calls[0]!.text, /LIMIT\s+\$3/iu)
  assert.match(calls[0]!.text, /FOR\s+UPDATE\s+OF\s+log\s+SKIP\s+LOCKED/iu)
  assert.deepEqual(calls[0]!.params, [
    '2026-03-17T12:04:59.999Z',
    '2026-02-15T12:04:59.999Z',
    1_000,
  ])

  assert.deepEqual(
    await runRuntimeLogRetention(database, new Date('2026-03-17T12:04:59.999Z')),
    { ran: false, deleted: 0 },
  )
  assert.equal(calls.length, 2)

  await assert.rejects(
    runRuntimeLogRetention(database, new Date('invalid')),
    /valid current time/iu,
  )
})
