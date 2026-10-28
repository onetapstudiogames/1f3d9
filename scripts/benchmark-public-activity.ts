import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type BenchmarkOptions = Readonly<{
  residents: number; places: number; events: readonly number[]; samples: number
  concurrency: readonly number[]; batches: number; warmups: number; report: string
}>

export function parseBenchmarkArgs(args: readonly string[]): BenchmarkOptions {
  if (!args.includes('--disposable') || args.includes('--target')) {
    throw new Error('this benchmark requires --disposable; hosted targets belong to the migration ceremony')
  }
  const allowed = new Set(['--disposable', '--residents', '--places', '--events', '--samples', '--concurrency', '--report'])
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!
    assert(allowed.has(key), `unknown benchmark argument ${key}`)
    assert(!values.has(key), `repeated benchmark argument ${key}`)
    const value = key === '--disposable' ? 'true' : args[++index]
    assert(value && !value.startsWith('--'), `missing benchmark value for ${key}`)
    values.set(key, value)
  }
  const integer = (name: string, fallback: number): number => {
    const raw = values.get(name) ?? String(fallback)
    assert(/^\d+$/.test(raw), `${name} must be a positive integer`)
    const value = Number(raw)
    assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`)
    return value
  }
  const list = (name: string, fallback: string): readonly number[] => {
    const raw = (values.get(name) ?? fallback).split(',')
    assert(raw.every(value => /^\d+$/.test(value) && Number(value) > 0), `${name} must list positive integers`)
    const result = raw.map(Number)
    assert.equal(new Set(result).size, result.length, `${name} repeats a value`)
    return result
  }
  const options = Object.freeze({
    residents: integer('--residents', 453), places: integer('--places', 1400),
    events: list('--events', '50000,250000'), samples: integer('--samples', 1000),
    concurrency: list('--concurrency', '1,8'), batches: 3, warmups: 100,
    report: values.get('--report') ?? 'test-results/public-activity-benchmark/results.json',
  })
  assert.equal(options.residents, 453, 'the acceptance fixture has 453 residents')
  assert.equal(options.places, 1400, 'the acceptance fixture has 1400 places')
  assert(options.events.every(count => count === 50000 || count === 250000), 'event sizes are 50000 and 250000')
  assert(options.concurrency.every(count => count === 1 || count === 8), 'concurrency is 1 or 8')
  assert(options.samples >= 1000, 'acceptance requires at least 1000 samples')
  const report = resolve(options.report)
  assert(report.startsWith(resolve('test-results') + (process.platform === 'win32' ? '\\' : '/')),
    'the report must stay inside this clone under test-results')
  return options
}

export function summarizeSamples(samples: readonly number[]): Readonly<{ median: number; p95: number }> {
  assert(samples.length > 0, 'at least one sample is required')
  assert(samples.every(Number.isFinite), 'sample times must be finite')
  const ordered = [...samples].sort((left, right) => left - right)
  return Object.freeze({ median: ordered[Math.ceil(ordered.length * 0.5) - 1]!, p95: ordered[Math.ceil(ordered.length * 0.95) - 1]! })
}

export type ReadMeasurement = Readonly<{
  name: string; before: readonly number[]; after: readonly number[]
  beforeStatements: readonly number[]; afterStatements: readonly number[]
  beforeRequests: readonly number[]; afterRequests: readonly number[]
}>

export function verifyReadBudget(measurement: ReadMeasurement) {
  const count = measurement.before.length
  assert(count > 0 && Object.entries(measurement).every(([key, value]) =>
    key === 'name' || (Array.isArray(value) && value.length === count)), `${measurement.name}: missing samples`)
  const before = summarizeSamples(measurement.before)
  const after = summarizeSamples(measurement.after)
  assert([...measurement.before, ...measurement.after].every(value => value >= 0), `${measurement.name}: elapsed samples must not be negative`)
  const addedP95 = after.p95 - before.p95
  const pairedAddedP95 = summarizeSamples(measurement.after.map((value, index) => value - measurement.before[index]!)).p95
  assert(addedP95 < 100 && pairedAddedP95 < 100, `${measurement.name}: extra p95 must be below 100 ms`)
  assert(addedP95 <= 25, `${measurement.name}: added p95 exceeds the 25 ms local margin`)
  assert(pairedAddedP95 <= 25, `${measurement.name}: paired added p95 exceeds the 25 ms local margin`)
  assert(measurement.afterStatements.every((value, index) => value === measurement.beforeStatements[index]),
    `${measurement.name}: marker added a database statement`)
  assert(measurement.afterRequests.every((value, index) => value === measurement.beforeRequests[index]),
    `${measurement.name}: marker added a client request`)
  return Object.freeze({ before, after, addedP95, pairedAddedP95 })
}

async function main(): Promise<void> {
  const options = parseBenchmarkArgs(process.argv.slice(2))
  if (!process.execArgv.includes('--experimental-test-module-mocks')) {
    const child = spawnSync(process.execPath, [
      '--experimental-strip-types', '--experimental-test-module-mocks', process.argv[1]!, ...process.argv.slice(2),
    ], { stdio: 'inherit', windowsHide: true })
    process.exitCode = child.status ?? 1
    return
  }
  const { runBenchmark } = await import('../test/helpers/public-activity-benchmark/runner.ts')
  await runBenchmark(options)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'activity benchmark failed')
    process.exitCode = 1
  })
}
