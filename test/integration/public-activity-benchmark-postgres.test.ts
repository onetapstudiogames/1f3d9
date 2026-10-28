import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Pool } from 'pg'

test('the benchmark observer records a caught engine COMMIT failure', { timeout: 180_000 }, async () => {
  const { startNoteSuiteDatabase, withNoteSuiteQueryObserver } = await import('../helpers/note-suite-fixtures/postgres.ts')
  const { engineSql, withEngineTransaction } = await import('../../src/engine.ts')
  const service = await startNoteSuiteDatabase('activity-benchmark-commit-observation')
  try {
    await service.client.query(`
      CREATE TABLE deferred_commit_fixture (
        value integer UNIQUE DEFERRABLE INITIALLY DEFERRED
      )
    `)
    const statements: string[] = []
    const failures: { statement: string; code: unknown }[] = []
    let insertCompleted = false
    await withNoteSuiteQueryObserver(statement => {
      statements.push(statement.trim())
      return statement
    }, async () => {
      await assert.rejects(withEngineTransaction(engineSql, async transaction => {
        await transaction`INSERT INTO deferred_commit_fixture (value) VALUES (1), (1)`
        insertCompleted = true
      }), error => error instanceof Error && 'code' in error && error.code === '23505')
    }, undefined, (error, statement) => {
      failures.push({ statement, code: error && typeof error === 'object' && 'code' in error ? error.code : null })
    })
    assert.equal(insertCompleted, true, 'the duplicate must fail at COMMIT after the write completed')
    assert.deepEqual(failures, [{ statement: 'COMMIT', code: '23505' }],
      'a caught engine COMMIT failure must reach the benchmark observer')
    assert.deepEqual(statements.filter(statement => /^(BEGIN|COMMIT|ROLLBACK)$/u.test(statement)),
      ['BEGIN', 'COMMIT', 'ROLLBACK'])
    assert.equal((await service.client.query('SELECT count(*)::int AS count FROM deferred_commit_fixture')).rows[0].count, 0)
  } finally {
    await service.stop()
  }
})

test('the seeded activity benchmark applies all eight mixed writers through reachable rooms', { timeout: 180_000 }, async () => {
  const { startNoteSuiteDatabase } = await import('../helpers/note-suite-fixtures/postgres.ts')
  const { preparedBaselineSchema, seedBenchmark } = await import('../helpers/public-activity-benchmark/fixture.ts')
  const { mixedWriters } = await import('../helpers/public-activity-benchmark/runner.ts')
  const service = await startNoteSuiteDatabase('activity-benchmark-writers')
  try {
    const migration = await readFile(new URL('../../db/migrations/20261028_stored_public_activity.sql', import.meta.url), 'utf8')
    const schema = preparedBaselineSchema(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'), migration)
    const baseTime = String((await service.client.query("SELECT date_trunc('hour', now()) - interval '1 hour' AS base")).rows[0]!.base.toISOString())
    await seedBenchmark(service.client, schema, 50_000, baseTime)
    await service.client.query(migration)
    const { default: app } = await import('../../src/index.ts')
    const result = await mixedWriters(app, service.client, new Map())
    assert.equal(result.commits, 64)
    assert.equal(result.retries, result.outcomes.reduce((sum, row) => sum + row.attempts.length - 1, 0))
    for (const outcome of result.outcomes) {
      assert.equal(outcome.attempts.at(-1)?.status, 200)
      assert(outcome.attempts.slice(0, -1).every(attempt => attempt.status === 409))
    }
    assert(result.eventRows > 0)
    assert(result.stamps.every(row => row.correct))
  } finally {
    await service.stop()
  }
})

test('the mixed writer gate rejects a committed move whose later observation fails', { timeout: 180_000 }, async () => {
  const { startNoteSuiteDatabase, withNoteSuiteQueryObserver } = await import('../helpers/note-suite-fixtures/postgres.ts')
  const { preparedBaselineSchema, seedBenchmark } = await import('../helpers/public-activity-benchmark/fixture.ts')
  const { mixedWriters } = await import('../helpers/public-activity-benchmark/runner.ts')
  const service = await startNoteSuiteDatabase('activity-benchmark-observation')
  try {
    const migration = await readFile(new URL('../../db/migrations/20261028_stored_public_activity.sql', import.meta.url), 'utf8')
    const schema = preparedBaselineSchema(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'), migration)
    const baseTime = String((await service.client.query("SELECT date_trunc('hour', now()) - interval '1 hour' AS base")).rows[0]!.base.toISOString())
    await seedBenchmark(service.client, schema, 50_000, baseTime)
    await service.client.query(migration)
    const { default: app } = await import('../../src/index.ts')
    const committedResponses: unknown[] = []
    const failingObservation = {
      request: async (url: string, init?: RequestInit) => {
        if (!url.endsWith('/api/action')) return app.request(url, init)
        let presenceReads = 0
        const response = await withNoteSuiteQueryObserver(statement => {
          const readsPresence = statement.includes('AS world_exists') || statement.includes('WITH first_owned AS')
          if (!readsPresence || ++presenceReads !== 2) return statement
          return statement.replace(/SELECT (presence\.)?resident_id,/u,
            'SELECT 1 / 0 AS failed_observation, $1resident_id,')
        }, async () => app.request(url, init))
        const body = await response.text()
        if (response.status === 200) committedResponses.push(JSON.parse(body))
        return new Response(body, { status: response.status, headers: response.headers })
      },
    }
    await assert.rejects(mixedWriters(failingObservation, service.client, new Map()), error => {
      assert(error instanceof Error)
      assert.match(error.message, /mixed writer.*observation.*division by zero/)
      const saved = JSON.parse(JSON.stringify(error)) as {
        requestFailures: { actor: number; response: { action: { status: string } };
          attemptDetails: { status: number }[]; queryFailures: { message: string; code: string; sqlHash: string }[] }[]
      }
      assert(saved.requestFailures.length > 0)
      for (const failure of saved.requestFailures) {
        assert(failure.actor > 0)
        assert.equal(failure.response.action.status, 'applied')
        assert.equal(failure.attemptDetails.at(-1)?.status, 200)
        assert(failure.queryFailures.some(query => query.code === '22012' && query.message === 'division by zero'))
        assert(failure.queryFailures.every(query => /^[a-f0-9]{64}$/.test(query.sqlHash)))
      }
      return true
    })
    assert(committedResponses.length > 0, 'the action route still returns its committed result')
    assert((await service.client.query("SELECT count(*)::int AS count FROM events WHERE kind='action'")).rows[0]!.count > 0)
  } finally {
    await service.stop()
  }
})

test('mixed writers retain terminal attempts and retry only exact changed-room refusals', async t => {
  const { mixedWriters } = await import('../helpers/public-activity-benchmark/runner.ts')
  const { formatRepeatedRefusal } = await import('../../src/resident-refusal.ts')
  const cause = 'your current place_id changed to 2; retry with place_id 2'
  const cases = [
    ...Array.from({ length: 10 }, (_, index) => ({ error: formatRepeatedRefusal(cause, index + 1), attempts: 16 })),
    { error: 'your current place_id changed to 2; retry with place_id 3', attempts: 1 },
    { error: cause + '; something else failed', attempts: 1 },
    { error: cause + '\n\nAn unknown extra refusal.', attempts: 1 },
    { error: formatRepeatedRefusal(cause, 2) + '\n\nAnother extra refusal.', attempts: 1 },
  ]
  for (const [index, example] of cases.entries()) await t.test(`refusal ${index + 1}`, async () => {
    const app = { request: async () => Response.json({ error: example.error }, { status: 409 }) }
    const db = { query: async () => ({ rows: [{ count: 0 }] }) } as unknown as Pool
    await assert.rejects(mixedWriters(app, db, new Map()), error => {
      assert(error instanceof Error)
      const saved = JSON.parse(JSON.stringify(error)) as {
        requestFailures: { actor: number; destination: number; milliseconds: number;
          attemptDetails: { status: number; response: { error: string } }[] }[]
      }
      assert.equal(saved.requestFailures.length, 8)
      for (const failure of saved.requestFailures) {
        assert(failure.actor > 0)
        assert.equal(failure.destination, 2)
        assert(failure.milliseconds >= 0)
        assert.equal(failure.attemptDetails.length, example.attempts)
        assert(failure.attemptDetails.every(attempt => attempt.status === 409 && attempt.response.error === example.error))
      }
      return true
    })
  })
})
