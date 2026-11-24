import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  REG_LOG_RETENTION_MS,
  REG_LOG_RETENTION_PAGE_LIMIT,
  reportRegLogRetentionFailure,
  runRegLogRetention,
  type RegLogDatabase,
} from '../src/reg-log-retention.ts'

type Call = { text: string; params: readonly unknown[] }

function recordingDatabase(result: readonly Record<string, unknown>[]): { calls: Call[]; database: RegLogDatabase } {
  const calls: Call[] = []
  return {
    calls,
    database: {
      query: async (text, params = []) => {
        calls.push({ text, params })
        return result
      },
    },
  }
}

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('sign-up network records are kept for exactly 24 hours, a bounded page at a time', () => {
  assert.equal(REG_LOG_RETENTION_MS, 24 * 60 * 60 * 1_000)
  assert.ok(Number.isSafeInteger(REG_LOG_RETENTION_PAGE_LIMIT))
  assert.ok(REG_LOG_RETENTION_PAGE_LIMIT > 0 && REG_LOG_RETENTION_PAGE_LIMIT <= 5_000)
})

test('every maintenance tick deletes one page of sign-up records older than 24 hours', async () => {
  const { calls, database } = recordingDatabase([{ deleted: 3 }])
  // Minute 37 on purpose: unlike the hourly log purges, this one runs on every tick.
  const now = new Date('2026-11-24T17:37:12.345Z')
  assert.deepEqual(await runRegLogRetention(database, now), { deleted: 3 })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.params, ['2026-11-23T17:37:12.345Z', REG_LOG_RETENTION_PAGE_LIMIT])
  const sql = calls[0]!.text.replace(/\s+/gu, ' ')
  assert.match(sql, /DELETE FROM reg_log/u)
  assert.match(sql, /created_at < \$1::timestamptz/u)
  assert.match(sql, /ORDER BY log\.created_at LIMIT \$2/u)
  assert.doesNotMatch(sql, /created_at <= /u, 'a row exactly 24 hours old is kept')
})

test('the purge refuses a bad clock and a result outside the page', async () => {
  const { calls, database } = recordingDatabase([{ deleted: 0 }])
  await assert.rejects(runRegLogRetention(database, new Date(Number.NaN)), TypeError)
  assert.equal(calls.length, 0)
  for (const bad of [[], [{ deleted: -1 }], [{ deleted: 1.5 }], [{ deleted: 'x' }],
    [{ deleted: REG_LOG_RETENTION_PAGE_LIMIT + 1 }]]) {
    await assert.rejects(runRegLogRetention(recordingDatabase(bad).database, new Date()),
      /reg log retention returned an invalid result/u)
  }
})

test('a failed purge prints one fixed line with no record or message in it', t => {
  const lines: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args) })
  const failure = Object.assign(new Error('private-marker 203.0.113.9'), { code: '57014' })
  reportRegLogRetentionFailure(failure)
  reportRegLogRetentionFailure('not an error')
  assert.deepEqual(lines, [
    ['reg_log_retention_failure', JSON.stringify({ event: 'reg_log_retention_failure', error_name: 'Error', error_code: '57014' })],
    ['reg_log_retention_failure', JSON.stringify({ event: 'reg_log_retention_failure', error_name: 'Error' })],
  ])
})

test('the five-minute maintenance cron runs the sign-up record purge in its own try', () => {
  const index = read('src/index.ts')
  const maintenance = index.slice(index.indexOf('runMaintenance: async () => await runEachRetention(['))
  const steps = maintenance.slice(0, maintenance.indexOf(']),'))
  assert.match(steps,
    /\{ run: \(\) => runRegLogRetention\(runtimeDatabase\), report: reportRegLogRetentionFailure \},/u)
  const vercel = JSON.parse(read('vercel.json')) as { crons: { path: string; schedule: string }[] }
  assert.ok(vercel.crons.some(cron => cron.path === '/api/internal/payment-recovery' && cron.schedule === '*/5 * * * *'))
})

test('the only code that touches reg_log is the sign-up insert and this purge', () => {
  const insertSource = read('src/identity-store.ts')
  assert.equal(insertSource.match(/reg_log/gu)?.length, 1, 'one insert, no reader')
  assert.match(read('src/reg-log-retention.ts'), /DELETE FROM reg_log/u)
})

test('the schema comment says where the 24-hour deletion happens', () => {
  const schema = read('db/schema.sql')
  const comment = schema.slice(schema.lastIndexOf('\n\n', schema.indexOf('CREATE TABLE IF NOT EXISTS reg_log')),
    schema.indexOf('CREATE TABLE IF NOT EXISTS reg_log')).replace(/\s*--\s*/gu, ' ')
  assert.match(comment, /older than 24 hours/u)
  assert.match(comment, /src\/reg-log-retention\.ts/u)
  assert.match(comment, /five-minute maintenance cron/u)
})
