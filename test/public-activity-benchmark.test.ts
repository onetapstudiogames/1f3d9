import assert from 'node:assert/strict'
import test from 'node:test'

test('the activity benchmark names the full seeded local matrix', async () => {
  const { parseBenchmarkArgs } = await import('../scripts/benchmark-public-activity.ts')
  assert.deepEqual(parseBenchmarkArgs([
    '--disposable', '--residents', '453', '--places', '1400',
    '--events', '50000,250000', '--samples', '1000', '--concurrency', '1,8',
  ]), {
    residents: 453, places: 1400, events: [50000, 250000], samples: 1000,
    concurrency: [1, 8], batches: 3, warmups: 100,
    report: 'test-results/public-activity-benchmark/results.json',
  })
})

test('the activity benchmark refuses hosted targets before connecting', async () => {
  const { parseBenchmarkArgs } = await import('../scripts/benchmark-public-activity.ts')
  for (const args of [[], ['--target', 'production'], ['--target', 'preview'],
    ['--disposable', '--target', 'preview']]) {
    assert.throws(() => parseBenchmarkArgs(args), /disposable|hosted|target/i)
  }
})

test('the activity speed gate uses p95 and keeps every slow sample', async () => {
  const { summarizeSamples } = await import('../scripts/benchmark-public-activity.ts')
  assert.deepEqual(summarizeSamples([100, 1, 2, 3, 4, 5, 6, 7, 8, 9]), {
    median: 5, p95: 100,
  })
})

test('the activity speed gate rejects 100 ms extra p95 and lower local margin failures', async () => {
  const { verifyReadBudget } = await import('../scripts/benchmark-public-activity.ts')
  const measurement = {
    name: 'quiet_place', before: Array(1000).fill(10), after: Array(1000).fill(20),
    beforeStatements: Array(1000).fill(10), afterStatements: Array(1000).fill(10),
    beforeRequests: Array(1000).fill(1), afterRequests: Array(1000).fill(1),
  }
  assert.doesNotThrow(() => verifyReadBudget(measurement))
  assert.throws(() => verifyReadBudget({ ...measurement, after: Array(1000).fill(110) }), /100 ms/)
  assert.throws(() => verifyReadBudget({ ...measurement, after: Array(1000).fill(36) }), /25 ms/)
})

test('the activity speed gate checks paired delay even when p95 totals match', async () => {
  const { verifyReadBudget } = await import('../scripts/benchmark-public-activity.ts')
  const before = Array.from({ length: 1000 }, (_, index) => index % 2 ? 100 : 10)
  const after = Array.from({ length: 1000 }, (_, index) => index % 2 ? 10 : 100)
  assert.throws(() => verifyReadBudget({
    name: 'presence', before, after,
    beforeStatements: Array(1000).fill(4), afterStatements: Array(1000).fill(4),
    beforeRequests: Array(1000).fill(1), afterRequests: Array(1000).fill(1),
  }), /paired.*25 ms/)
})

test('the activity speed gate rejects added statements and extra client requests', async () => {
  const { verifyReadBudget } = await import('../scripts/benchmark-public-activity.ts')
  const measurement = {
    name: 'whole_roster', before: [10, 10], after: [10, 10],
    beforeStatements: [12, 12], afterStatements: [12, 12],
    beforeRequests: [3, 3], afterRequests: [3, 3],
  }
  assert.doesNotThrow(() => verifyReadBudget(measurement))
  assert.throws(() => verifyReadBudget({ ...measurement, afterStatements: [12, 13] }), /statement/)
  assert.throws(() => verifyReadBudget({ ...measurement, afterRequests: [3, 4] }), /request/)
})

test('the activity speed gate rejects missing samples and nonfinite times', async () => {
  const { verifyReadBudget } = await import('../scripts/benchmark-public-activity.ts')
  const measurement = {
    name: 'census', before: [10, 10], after: [10, 10],
    beforeStatements: [3, 3], afterStatements: [3, 3],
    beforeRequests: [1, 1], afterRequests: [1, 1],
  }
  assert.throws(() => verifyReadBudget({ ...measurement, after: [10] }), /sample/)
  assert.throws(() => verifyReadBudget({ ...measurement, after: [10, NaN] }), /finite/)
})

