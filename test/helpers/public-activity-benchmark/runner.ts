import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { cpus, freemem, loadavg, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import { summarizeSamples, verifyReadBudget, type BenchmarkOptions } from '../../../scripts/benchmark-public-activity.ts'
import { startNoteSuiteDatabase, withNoteSuiteQueryObserver, bearer, type NoteSuiteDatabase } from '../note-suite-fixtures/postgres.ts'
import { benchmarkCounts, BENCHMARK_RESIDENT, benchmarkSecret, preparedBaselineSchema, seedBenchmark } from './fixture.ts'

// Load baseline helpers only after the disposable database module installed its mock.
const { CENSUS_SQL, PRESENCE_SQL, FOCUSED_PRESENCE_SQL, PLACE_SQL } = await import('./baseline.ts')
const { formatRepeatedRefusal } = await import('../../../src/resident-refusal.ts')

type Mode = 'before' | 'after'
type CityApp = Readonly<{ request: (url: string, init?: RequestInit) => Response | Promise<Response> }>
type ReadCase = Readonly<{ name: string; path: string; allPages?: boolean; signedIn?: boolean }>
type Attempt = Readonly<{
  status: number; milliseconds: number; statements: number; roundTrips: number
  sqlMilliseconds: number; retryAfterSeconds: number | null
}>
type Sample = Readonly<{
  milliseconds: number; sqlMilliseconds: number; statements: number; roundTrips: number
  attemptedStatements: number; attemptedRoundTrips: number; requests: number; attempts: number; refusals: number
  attemptDetails: readonly Attempt[]
}>
type QueryEvidence = Readonly<{ mode: Mode; sqlHash: string; sql: string; params: readonly unknown[] }>
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const host = () => ({ at: new Date().toISOString(), load: loadavg(),
  loadAverageAvailable: process.platform !== 'win32', cpuTimes: cpus().map(cpu => cpu.times),
  freeBytes: freemem(), totalBytes: totalmem(), process: process.cpuUsage() })

const READS: readonly ReadCase[] = Object.freeze([
  { name: 'census', path: '/api/residents?limit=200' },
  { name: 'presence', path: '/api/residents?view=presence&limit=200' },
  { name: 'busy_place', path: '/api/place/3?view=outline' },
  { name: 'quiet_place', path: '/api/place/4?view=outline' },
  { name: 'inactive_resident', path: '/api/residents?view=presence&handle=benchmark-453' },
  { name: 'off_resident', path: '/api/residents?view=presence&handle=benchmark-452' },
  { name: 'full_place', path: '/api/place/3?view=full' },
  { name: 'all_census_pages', path: '/api/residents?limit=200', allPages: true },
  { name: 'whole_roster', path: '/api/residents?view=presence&limit=200', allPages: true },
  { name: 'settings', path: '/api/me/settings', signedIn: true },
])

function baselineStatement(text: string): string {
  if (text.includes('/* private:reader-settings */')) return `/* private:reader-settings */
    SELECT focus, encoded_text_filter, drawings_filter, code_like_text_filter, links_filter,
      emoji_filter, muted_words, updated_at FROM resident_settings WHERE resident_id = $1`
  if (text.includes('history.name_history') && text.includes('FROM places p')) return PLACE_SQL
  if (text.includes('/* public:resident-presence */')) return FOCUSED_PRESENCE_SQL
  const begin = text.indexOf('/* public:residents */')
  if (begin < 0) return text
  const baseline = text.includes('WITH resident_page') ? PRESENCE_SQL : CENSUS_SQL
  const end = text.indexOf(') __public_exact_source', begin)
  return end < 0 ? baseline : text.slice(0, begin) + baseline + text.slice(end)
}

function queryForEvidence(text: string): boolean {
  return text.includes('public:residents') || text.includes('public:resident-presence') ||
    text.includes('history.name_history') || text.includes('private:reader-settings')
}

function proveStoredQuery(text: string): void {
  if (!text.includes('last_public_action_at')) return
  assert(!/public_activity_(history|candidates|room)\s*\(/i.test(text), 'the marker called activity history from a public read')
  const before = baselineStatement(text)
  const references = (sql: string, relation: string) => [...sql.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+${relation}\\b`, 'gi'))].length
  if (!text.includes('private:reader-settings')) {
    assert.equal(references(text, 'events'), references(before, 'events'), 'the marker added an activity history scan')
    assert.equal(references(text, 'resident_settings'), references(before, 'resident_settings'), 'the public marker added a settings join')
  }
}

async function sampleRead(app: CityApp, read: ReadCase, mode: Mode, evidence: Map<string, QueryEvidence>): Promise<Sample> {
  let statements = 0, roundTrips = 0, requests = 0, attempts = 0, refusals = 0, sqlMilliseconds = 0
  let attemptedStatements = 0, attemptedRoundTrips = 0
  const attemptDetails: Attempt[] = []
  const start = performance.now()
  let cursor: number | null = null, residents = 0
  do {
    const path = read.path + (cursor === null ? '' : `&before_id=${cursor}`)
    let accepted = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      let currentStatements = 0, currentRoundTrips = 0
      let currentSqlMilliseconds = 0
      const attemptStart = performance.now()
      const response = await withNoteSuiteQueryObserver((text, params) => {
        const actual = mode === 'before' ? baselineStatement(text) : text
        proveStoredQuery(actual)
        currentRoundTrips += 1
        if (!/^(BEGIN|COMMIT|ROLLBACK)\b/.test(actual)) currentStatements += 1
        if (queryForEvidence(actual)) {
          const sqlHash = hash(actual)
          evidence.set(`${sqlHash}:${hash(JSON.stringify(params)).slice(0, 12)}`, { mode, sqlHash, sql: actual, params })
        }
        return actual
      }, async () => {
        const result = await app.request(`http://city.test${path}`, { headers: read.signedIn ? bearer(BENCHMARK_RESIDENT.secret) : {} })
        return { status: result.status, retryAfter: result.headers.get('retry-after'), body: await result.text() }
      }, elapsed => { sqlMilliseconds += elapsed; currentSqlMilliseconds += elapsed })
      attempts += 1
      attemptedStatements += currentStatements
      attemptedRoundTrips += currentRoundTrips
      attemptDetails.push({ status: response.status, milliseconds: performance.now() - attemptStart,
        statements: currentStatements, roundTrips: currentRoundTrips, sqlMilliseconds: currentSqlMilliseconds,
        retryAfterSeconds: response.retryAfter !== null && /^\d+$/.test(response.retryAfter) ? Number(response.retryAfter) : null })
      if (response.status === 503 && response.body.includes('exact public totals are temporarily busy')) {
        refusals += 1
        assert(response.retryAfter !== null && /^\d+$/.test(response.retryAfter), `${read.name}: admission response has no usable Retry-After`)
        await delay(Number(response.retryAfter) * 1000)
        continue
      }
      assert.equal(response.status, 200, `${read.name}: HTTP ${response.status}: ${response.body.slice(0, 200)}`)
      assert(currentStatements > 0, `${read.name}: a cached response cannot replace a fresh database read`)
      assert(!response.body.includes('"last_public_action_at"'), `${read.name}: raw stamp in response`)
      if (!read.signedIn) assert(!response.body.includes('"show_activity"'), `${read.name}: private choice in response`)
      const json = JSON.parse(response.body) as Record<string, unknown>
      statements += currentStatements
      roundTrips += currentRoundTrips
      requests += 1
      residents += Array.isArray(json.residents) ? json.residents.length : 0
      cursor = read.allPages && typeof json.next_before_id === 'number' ? json.next_before_id : null
      accepted = true
      break
    }
    if (!accepted) throw Object.assign(new Error(`${read.name}: the existing read admission refused 40 attempts; concurrency matrix incomplete`), {
      read: read.name, mode, attemptDetails, milliseconds: performance.now() - start,
    })
  } while (cursor !== null)
  if (read.allPages) { assert.equal(residents, 453); assert.equal(requests, 3) }
  return { milliseconds: performance.now() - start, sqlMilliseconds, statements, roundTrips,
    attemptedStatements, attemptedRoundTrips, requests, attempts, refusals, attemptDetails }
}

async function concurrent<T>(samples: number, concurrency: number, work: (index: number) => Promise<T>): Promise<T[]> {
  const groups = await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    const results: { index: number; value: T }[] = []
    for (let index = worker; index < samples; index += concurrency) {
      try { results.push({ index, value: await work(index) }) }
      catch (error) { return { results, error } }
    }
    return { results, error: null }
  }))
  const completed = groups.flatMap(group => group.results)
  const failures = groups.filter(group => group.error !== null)
  if (failures.length > 0) {
    const cause = failures[0]!.error
    const requestFailures = failures.map(({ error }) => ({
      ...(error && typeof error === 'object' ? error : {}), message: error instanceof Error ? error.message : 'request failed',
    }))
    throw Object.assign(cause instanceof Error ? cause : new Error('benchmark request failed'), {
      completedSamples: completed,
      requestFailures,
    })
  }
  return completed.sort((left, right) => left.index - right.index).map(row => row.value)
}

async function startDatabase(): Promise<NoteSuiteDatabase> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await startNoteSuiteDatabase('public-activity-benchmark') }
    catch { console.log(`Disposable PostgreSQL startup attempt ${attempt} failed`) }
  }
  throw new Error('Disposable PostgreSQL did not start after three attempts; the local runtime assumption is unproved')
}

async function validateMigration(db: Pool) {
  const { verifyPublicActivityClient } = await import('../../../scripts/verify-public-activity.ts')
  const client = await db.connect()
  try { await verifyPublicActivityClient(client) }
  finally { client.release() }
  const receipt = (await db.query('SELECT * FROM public_activity_schema_state')).rows
  assert.equal(receipt.length, 1, 'one backfill receipt is required')
  const samples = (await db.query(`WITH eligible AS (
    SELECT event.actor,event.at,CASE WHEN kind='action' THEN (detail->>'to_place_id')::int
      ELSE (detail->>'place_id')::int END place_id FROM events event
    WHERE kind IN ('note','line_said','ping_sent') OR (kind='action' AND detail->>'action'='move'
      AND detail->>'status'='applied' AND detail->>'place_id'<>detail->>'to_place_id')),
    resident_maxima AS (SELECT actor,max(at) acted_at FROM eligible GROUP BY actor),
    place_maxima AS (SELECT place_id,max(at) acted_at FROM eligible GROUP BY place_id)
    SELECT 'resident' type,resident.id,resident.last_public_action_at = expected.acted_at correct
    FROM residents resident JOIN resident_maxima expected ON expected.actor=resident.handle WHERE resident.id IN (51,103,199)
    UNION ALL SELECT 'place',place.id,place.last_public_action_at=expected.acted_at
    FROM places place JOIN place_maxima expected ON expected.place_id=place.id WHERE place.id IN (51,103,501)`)).rows
  assert.equal(samples.length, 6)
  assert(samples.every(row => row.correct), 'backfill differs from independently proved event maxima')
  return { receipt, exactVerifier: 'verifyPublicActivityClient', independentMaxima: samples }
}

async function explainQueries(db: Pool, queries: Map<string, QueryEvidence>) {
  const plans: Record<string, unknown> = {}
  for (const [key, query] of queries) {
    const result = await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query.sql, [...query.params])
    plans[key] = result.rows[0]?.['QUERY PLAN']
  }
  return plans
}

export async function mixedWriters(app: CityApp, db: Pool, evidence: Map<string, QueryEvidence>) {
  const start = new Date().toISOString()
  const before = (await db.query('SELECT count(*)::int count FROM events')).rows[0]!.count
  const outcomes = await concurrent(64, 8, async index => {
    const actor = index < 32 ? [2, 3, 5, 6, 7, 8, 9, 10][index % 8]! : 2
    const destination = Math.floor(index / 8) % 2 === 0 ? 2 : 3
    const begin = performance.now()
    const attempts: { status: number; milliseconds: number; response: unknown }[] = []
    const queryFailures: { message: string; code: string | null; sqlHash: string }[] = []
    let body: unknown = null
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const attemptStart = performance.now()
        const response = await withNoteSuiteQueryObserver(text => text, async () => app.request('http://city.test/api/action', {
          method: 'POST', headers: bearer(benchmarkSecret(actor)), body: JSON.stringify({ action: 'move', to_place_id: destination }),
        }), undefined, (error, statement) => {
          queryFailures.push({ message: error instanceof Error ? error.message : 'database request failed',
            code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null,
            sqlHash: hash(statement) })
        })
        const text = await response.text()
        body = JSON.parse(text)
        attempts.push({ status: response.status, milliseconds: performance.now() - attemptStart, response: body })
        assert.equal(queryFailures.length, 0,
          `mixed writer: an action or later observation failed: ${queryFailures[0]?.message ?? ''}`)
        // A competing move may change this actor's room before this request locks it.
        // Retry only this exact refusal, retaining its time and complete response.
        const error = body && typeof body === 'object' && 'error' in body ? body.error : null
        const cause = typeof error === 'string' ? error.split('\n\n')[0]! : ''
        if (response.status === 409 && /^your current place_id changed to (\d+); retry with place_id \1$/u.test(cause)
          && Array.from({ length: 10 }, (_, index) => formatRepeatedRefusal(cause, index + 1)).includes(error as string)) continue
        assert.equal(response.status, 200, `mixed writer: HTTP ${response.status}: ${text.slice(0, 180)}`)
        break
      }
      assert.equal(attempts.at(-1)?.status, 200, 'mixed writer: room changed on all 16 attempts')
      const milliseconds = performance.now() - begin
      const waits = (await db.query(`SELECT wait_event_type,wait_event,count(*)::int count FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' GROUP BY wait_event_type,wait_event`)).rows
      await sampleRead(app, READS[2]!, 'after', evidence)
      return { actor, milliseconds, waits, attempts }
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error('mixed writer failed'), {
        actor, destination, milliseconds: performance.now() - begin, attemptDetails: attempts,
        response: body, queryFailures,
      })
    }
  })
  const stamps = (await db.query(`WITH changed AS (SELECT event.at,activity.actor_handle,activity.place_id
    FROM events event CROSS JOIN LATERAL public_activity_candidates(event.id,event.kind,event.actor,event.detail) activity
    WHERE event.at >= $1::timestamptz AND activity.proved)
    SELECT 'resident' type,resident.id,resident.last_public_action_at >= max(changed.at) correct
    FROM changed JOIN residents resident ON resident.handle=changed.actor_handle GROUP BY resident.id
    UNION ALL SELECT 'place',place.id,place.last_public_action_at >= max(changed.at)
    FROM changed JOIN places place ON place.id=changed.place_id GROUP BY place.id`, [start])).rows
  assert(stamps.length > 0 && stamps.every(row => row.correct), 'a successful mixed writer is missing its stamp')
  const after = (await db.query('SELECT count(*)::int count FROM events')).rows[0]!.count
  return { ...summarizeSamples(outcomes.map(row => row.milliseconds)), outcomes, commits: outcomes.length,
    eventRows: after - before, retries: outcomes.reduce((sum, row) => sum + row.attempts.length - 1, 0), stamps }
}

export async function runBenchmark(options: BenchmarkOptions): Promise<void> {
  const directory = dirname(options.report)
  await mkdir(directory, { recursive: true })
  const previousEvidence = await access(`${directory}/queries.json`).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })
  assert(!previousEvidence, 'this report directory already has benchmark evidence; choose a new --report directory to preserve it')
  const migration = await readFile(new URL('../../../db/migrations/20261028_stored_public_activity.sql', import.meta.url), 'utf8')
  const schema = preparedBaselineSchema(await readFile(new URL('../../../db/schema.sql', import.meta.url), 'utf8'), migration)
  await writeFile(`${directory}/prepared-baseline.sql`, schema)
  const sourcePaths = ['src/public-activity.ts', 'src/public-residents.ts', 'src/public-records.ts',
    'src/index.ts', 'src/world.ts', 'src/resident-settings.ts', 'src/engine.ts', 'src/note-action.ts', 'scripts/verify-public-activity.ts',
    'test/helpers/public-activity-benchmark/runner.ts', 'test/helpers/note-suite-fixtures/postgres.ts']
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [
    path, hash(await readFile(new URL('../../../' + path, import.meta.url), 'utf8')),
  ])))
  const queries = new Map<string, QueryEvidence>()
  const report: Record<string, unknown> = {
    scope: 'Disposable PostgreSQL, actual Hono routes and serialization; no hosted measurement',
    options, migrationHash: hash(migration), baselineSchemaHash: hash(schema),
    sourceHashes,
    node: process.version, hostAtStart: host(), complete: false, matrices: [],
  }
  const save = async () => {
    await writeFile(options.report, JSON.stringify(report, null, 2))
    await writeFile(`${directory}/queries.json`, JSON.stringify(Object.fromEntries(queries), null, 2))
  }
  console.log(JSON.stringify({ migrationHash: report.migrationHash, baselineSchemaHash: report.baselineSchemaHash, sourceHashes }))
  await save()
  const service = await startDatabase().catch(async error => {
    report.failure = error instanceof Error ? error.message : 'database startup failed'
    await save()
    throw error
  })
  try {
    const db = service.client
    db.on('error', () => undefined)
    report.postgres = (await db.query('SHOW server_version')).rows[0]!.server_version
    const baseTime = String((await db.query(`SELECT to_char(date_trunc('hour',now())-interval '1 hour','YYYY-MM-DD"T"HH24:MI:SS"Z"') base`)).rows[0]!.base)
    const app = (await import('../../../src/index.ts')).default
    for (const events of options.events) {
      const counts = await seedBenchmark(db, schema, events, baseTime)
      const matrix: Record<string, unknown> = { events, counts, hostBefore: host(), oldSchema: [], comparisons: [] }
      ;(report.matrices as unknown[]).push(matrix)
      console.log(`Seeded ${counts.residents} residents, ${counts.places} places, ${counts.events} events`)
      const oldSummaries = new Map<string, ReturnType<typeof summarizeSamples>>()
      for (const concurrency of options.concurrency) for (let batch = 1; batch <= options.batches; batch += 1) for (const read of READS) {
        await concurrent(options.warmups, concurrency, () => sampleRead(app, read, 'before', queries))
        const samples = await concurrent(options.samples, concurrency, () => sampleRead(app, read, 'before', queries))
        const summary = summarizeSamples(samples.map(sample => sample.milliseconds))
        oldSummaries.set(`${concurrency}:${batch}:${read.name}`, summary)
        const samplesFile = `${events}-c${concurrency}-b${batch}-${read.name}-old.json`
        await writeFile(`${directory}/${samplesFile}`, JSON.stringify(samples))
        ;(matrix.oldSchema as unknown[]).push({ name: read.name, concurrency, batch, host: host(), ...summary, samplesFile,
          refusals: samples.reduce((sum, sample) => sum + sample.refusals, 0) })
        console.log(`Before ${events} ${read.name} concurrency ${concurrency} batch ${batch}: p95 ${summary.p95.toFixed(2)} ms`)
        await save()
      }
      const migrationStart = performance.now()
      await db.query(migration)
      matrix.migrationMilliseconds = performance.now() - migrationStart
      matrix.migrationVerification = await validateMigration(db)
      assert.deepEqual(await benchmarkCounts(db), counts, 'migration changed the deterministic public fixture')
      await db.query('UPDATE residents SET show_activity=false WHERE id=452')
      await db.query('ANALYZE')
      for (const concurrency of options.concurrency) for (let batch = 1; batch <= options.batches; batch += 1) for (const read of READS) {
        for (const mode of ['before', 'after'] as const) await concurrent(options.warmups, concurrency, () => sampleRead(app, read, mode, queries))
        const pairs = await concurrent(options.samples, concurrency, async index => {
          const first: Mode = (index + batch) % 2 === 0 ? 'before' : 'after'
          const second: Mode = first === 'before' ? 'after' : 'before'
          const one = await sampleRead(app, read, first, queries)
          try {
            const two = await sampleRead(app, read, second, queries)
            return first === 'before' ? { before: one, after: two } : { before: two, after: one }
          } catch (error) {
            throw Object.assign(error instanceof Error ? error : new Error('paired read failed'), {
              unfinishedPair: { index, first, sample: one },
            })
          }
        })
        const before = pairs.map(pair => pair.before), after = pairs.map(pair => pair.after)
        const measurement = (beforeSamples: Sample[]) => ({ name: read.name,
          before: beforeSamples.map(sample => sample.milliseconds), after: after.map(sample => sample.milliseconds),
          beforeStatements: beforeSamples.map(sample => sample.statements), afterStatements: after.map(sample => sample.statements),
          beforeRequests: beforeSamples.map(sample => sample.requests), afterRequests: after.map(sample => sample.requests),
        })
        const beforeSummary = summarizeSamples(before.map(sample => sample.milliseconds))
        const afterSummary = summarizeSamples(after.map(sample => sample.milliseconds))
        const baselineSummary = oldSummaries.get(`${concurrency}:${batch}:${read.name}`)!
        const samplesFile = `${events}-c${concurrency}-b${batch}-${read.name}-paired.json`
        await writeFile(`${directory}/${samplesFile}`, JSON.stringify(pairs))
        const comparison = { name: read.name, concurrency, batch, samplesFile, host: host(),
          before: beforeSummary, after: afterSummary, baseline: baselineSummary,
          addedP95: afterSummary.p95 - beforeSummary.p95,
          pairedAddedP95: summarizeSamples(pairs.map(pair => pair.after.milliseconds - pair.before.milliseconds)).p95,
          oldSchemaAddedP95: afterSummary.p95 - baselineSummary.p95,
          refusals: { before: before.reduce((sum, sample) => sum + sample.refusals, 0), after: after.reduce((sum, sample) => sum + sample.refusals, 0) },
        }
        ;(matrix.comparisons as unknown[]).push(comparison)
        await save()
        console.log(`MEASURED ${events} ${read.name} concurrency ${concurrency} batch ${batch}: old-schema ${comparison.baseline.p95.toFixed(2)}, paired-before ${comparison.before.p95.toFixed(2)}, after ${comparison.after.p95.toFixed(2)}, added ${comparison.addedP95.toFixed(2)}, paired-added ${comparison.pairedAddedP95.toFixed(2)} ms`)
        // Save every sample before the first failed assertion stops the run.
        verifyReadBudget(measurement(before))
        assert(after.every((sample, index) => sample.roundTrips === before[index]!.roundTrips), `${read.name}: marker added a database round trip`)
        const baseline = comparison.baseline.p95
        assert(comparison.after.p95 - baseline < 100, `${read.name}: old-schema added p95 must be below 100 ms`)
        assert(comparison.after.p95 - baseline <= 25, `${read.name}: old-schema added p95 exceeds the 25 ms local margin`)
      }
      matrix.plans = await explainQueries(db, queries)
      matrix.mixedWriters = await mixedWriters(app, db, queries)
      matrix.hostAfter = host()
      await save()
      console.log(`PASS ${events} event matrix and mixed writers`)
    }
    report.complete = true
    report.hostAtEnd = host()
    await save()
  } catch (error) {
    report.failure = error instanceof Error ? error.message : 'benchmark failed'
    if (error && typeof error === 'object' && 'completedSamples' in error) {
      report.incompleteSamplesFile = 'incomplete-samples.json'
      await writeFile(`${directory}/incomplete-samples.json`, JSON.stringify(error, null, 2))
    }
    await save()
    throw error
  } finally {
    await service.stop()
    console.log('Owned disposable PostgreSQL stopped')
  }
}
