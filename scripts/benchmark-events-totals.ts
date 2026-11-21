// Times the events list's totals both ways (decision #196, step 2) on a disposable local
// PostgreSQL from the suites' pinned image, never a hosted database: today's statement,
// which counts the whole list, beside the kept statement, which reads the kept count and
// counts only the events past its marker. Each shape runs through the route's own budgeted
// statement text, with parallel workers off as the route has them; "before" runs get a
// 10 s statement limit instead of 1.5 s so their full cost shows.
//   node --experimental-strip-types scripts/benchmark-events-totals.ts --disposable --events 450000,900000
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import type { PublicEventFilters, PublicPage } from '../src/public-pagination.ts'

type Options = Readonly<{ events: readonly number[]; runs: number; warmups: number; report: string }>

export function parseEventsBenchmarkArgs(args: readonly string[]): Options {
  if (!args.includes('--disposable') || args.includes('--target')) {
    throw new Error('this benchmark requires --disposable; it never runs against a hosted database')
  }
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!
    assert(['--disposable', '--events', '--report'].includes(key), `unknown benchmark argument ${key}`)
    if (key === '--disposable') continue
    const value = args[++index]
    assert(value && !value.startsWith('--'), `missing benchmark value for ${key}`)
    values.set(key, value)
  }
  const events = (values.get('--events') ?? '450000,900000').split(',').map(Number)
  assert(events.every(count => Number.isSafeInteger(count) && count >= 1_000 && count <= 2_000_000), '--events lists sizes from 1000 to 2000000')
  const report = resolve(values.get('--report') ?? 'test-results/events-totals-benchmark/results.json')
  assert(report.startsWith(resolve('test-results') + (process.platform === 'win32' ? '\\' : '/')),
    'the report must stay inside this clone under test-results')
  return Object.freeze({ events, runs: 5, warmups: 2, report })
}

const BASE: PublicEventFilters = Object.freeze({
  kind: null, actor: null, placeId: null, includeDescendants: false, withinSeconds: null, afterId: null,
})
const page = (cursor: number | null = null): PublicPage => Object.freeze({ ok: true, cursor, limit: 50, fetchLimit: 51 })
type Statement = Readonly<{ text: string; params: readonly unknown[] }>

async function captured(load: (query: (text: string, params: readonly unknown[]) => Promise<never[]>) => Promise<unknown>): Promise<Statement> {
  let statement: Statement | null = null
  await load(async (text, params) => { statement = { text, params }; return [] }).catch(() => undefined)
  assert(statement, 'the loader sent no statement')
  return statement
}

async function timedRuns(client: PoolClient, statement: Statement, options: Options, jitOff: boolean, timeout: string) {
  const { budgetedExactStatement } = await import('../src/public-exact-query.ts')
  const text = budgetedExactStatement(statement.text)
  const once = async (explain: boolean) => {
    await client.query('BEGIN READ ONLY')
    try {
      await client.query(`SET LOCAL statement_timeout = '${timeout}'`)
      await client.query('SET LOCAL max_parallel_workers_per_gather = 0')
      if (jitOff) await client.query('SET LOCAL jit = off')
      const started = performance.now()
      const result = await client.query(explain ? `EXPLAIN (ANALYZE, BUFFERS) ${text}` : text, [...statement.params])
      const ms = performance.now() - started
      return { ms, rows: result.rows }
    } finally {
      await client.query('ROLLBACK')
    }
  }
  for (let index = 0; index < options.warmups; index += 1) await once(false)
  const samples: number[] = []
  let first: Record<string, unknown> | undefined
  for (let index = 0; index < options.runs; index += 1) {
    const run = await once(false)
    samples.push(Math.round(run.ms * 10) / 10)
    first ??= run.rows[0]
  }
  const plan = (await once(true)).rows.map(row => String(row['QUERY PLAN']))
  const sorted = [...samples].sort((a, b) => a - b)
  return Object.freeze({
    samples, median: sorted[Math.floor(sorted.length / 2)]!, max: sorted.at(-1)!,
    executionMs: Number(plan.find(line => line.startsWith('Execution Time'))?.match(/[0-9.]+/u)?.[0]),
    jit: plan.some(line => line.trim().startsWith('JIT:')),
    plan,
    totals: { items: first?.total_items, textBytes: first?.total_text_bytes, leftOut: first?.left_out_feed_rooms, keptStateRows: first?.kept_state_rows },
  })
}

async function runSize(pool: Pool, events: number, options: Options) {
  const fixtures = await import('../test/helpers/note-suite-fixtures/postgres.ts')
  const { FOUNDER, GROWER, NEIGHBOUR } = await import('../test/helpers/abilities-fixtures.ts')
  const { tallyDatabase, insertEvents } = await import('../test/helpers/events-totals-fixtures.ts')
  const { seedEventsTotalsBenchmark } = await import('../test/helpers/events-totals-benchmark/seed.ts')
  const tally = await import('../src/events-totals-tally.ts')
  const check = await import('../src/events-totals-check.ts')
  const pagination = await import('../src/public-pagination.ts')
  const seeded = await fixtures.resetCity([FOUNDER, GROWER, NEIGHBOUR])
  const seedStarted = performance.now()
  await seedEventsTotalsBenchmark(pool, events, seeded.continentId)
  const seedMs = performance.now() - seedStarted
  const db = tallyDatabase(pool)
  const foldStarted = performance.now()
  const folded = await tally.foldSettledEvents(db, { chunkChanges: 50_000, maxChunks: 1_000, budgetMs: 3_600_000 })
  assert.equal(folded.caughtUp, true)
  const foldMs = performance.now() - foldStarted
  const checked = await check.runHourlyEventsTotalsCheck(db, new Date('2026-11-21T00:00:00Z'))
  assert(checked.state === 'recorded' && checked.trusted, 'the kept count must be trusted before timing')
  const facts = (await pool.query(`SELECT (SELECT count(*) FROM events)::integer AS events, (SELECT count(*) FROM things)::integer AS things,
    (SELECT count(*) FROM places WHERE feed)::integer AS feed_rooms, (SELECT count(*) FROM events_totals_tally)::integer AS tally_rows,
    (SELECT count(*) FROM events_totals_tally WHERE key_type = 'all')::integer AS kinds,
    (SELECT max(id) FROM events)::integer AS newest, pg_jit_available() AS jit_available,
    current_setting('server_version') AS server_version`)).rows[0]!
  const ids = (await pool.query<{ id: number }>('SELECT id FROM events ORDER BY id DESC LIMIT 1000')).rows.map(row => Number(row.id))
  const shapes: ReadonlyArray<readonly [string, PublicEventFilters, PublicPage]> = [
    ['unfiltered', BASE, page()],
    ['before_id', BASE, page(ids[49]!)],
    ['after_id', { ...BASE, afterId: ids[999]! }, page()],
    ['kind=action', { ...BASE, kind: 'action' }, page()],
    ['kind=note', { ...BASE, kind: 'note' }, page()],
    ['kind=transfer', { ...BASE, kind: 'transfer' }, page()],
  ]
  const today = (filters: PublicEventFilters, at: PublicPage) => captured(query => pagination.loadPublicEventCollectionRows(query, filters, at))
  const kept = (filters: PublicEventFilters, at: PublicPage) => captured(query => (
    pagination.loadPublicEventKeptCollectionRows(query, filters, at, tally.EVENTS_TALLY_READER_TOTALS_SQL)))
  const client = await pool.connect()
  try {
    const results: Record<string, unknown> = {}
    for (const [name, filters, at] of shapes) {
      results[name] = {
        before: await timedRuns(client, await today(filters, at), options, true, '10s'),
        after: await timedRuns(client, await kept(filters, at), options, true, '1500ms'),
        beforeJitDefault: name === 'unfiltered' ? await timedRuns(client, await today(filters, at), options, false, '10s') : undefined,
        afterJitDefault: await timedRuns(client, await kept(filters, at), options, false, '30s'),
      }
    }
    await insertEvents(pool, Array.from({ length: 15 }, (_, index) => ({ kind: 'note', detail: { body: `past the marker ${index}` } })))
    results['kept, 15 past the marker'] = await timedRuns(client, await kept(BASE, page()), options, true, '1500ms')
    for (let added = 15; added < 3_500; added += 500) {
      await insertEvents(pool, Array.from({ length: Math.min(500, 3_500 - added) }, (_, index) => ({
        kind: index % 2 ? 'note' : 'action',
        detail: index % 2 ? { body: `a day ${index}` } : { applied_public_activity: [{ target_type: 'thing', operation: 'move', place_id: seeded.westRoomId, actor: 'founder' }] },
      })))
    }
    results['kept, 3500 past the marker'] = await timedRuns(client, await kept(BASE, page()), options, true, '1500ms')
    await pool.query('UPDATE events_totals_state SET trusted = FALSE, kept_change_id = 0')
    results['kept, closed gate at kept_change_id 0'] = await timedRuns(client, await kept(BASE, page()), options, true, '1500ms')
    results['kept, closed gate at kept_change_id 0, jit default'] = await timedRuns(client, await kept(BASE, page()), options, false, '30s')
    return Object.freeze({ facts, seedMs: Math.round(seedMs), firstFoldMs: Math.round(foldMs), fullCheckMs: checked.observation.fullMs, results })
  } finally {
    client.release()
  }
}

async function main(): Promise<void> {
  const options = parseEventsBenchmarkArgs(process.argv.slice(2))
  if (!process.execArgv.includes('--experimental-test-module-mocks')) {
    const child = spawnSync(process.execPath, [
      '--experimental-strip-types', '--experimental-test-module-mocks', process.argv[1]!, ...process.argv.slice(2),
    ], { stdio: 'inherit', windowsHide: true })
    process.exitCode = child.status ?? 1
    return
  }
  const { startNoteSuiteDatabase } = await import('../test/helpers/note-suite-fixtures/postgres.ts')
  const database = await startNoteSuiteDatabase('events-totals-benchmark')
  try {
    const sizes: Record<string, unknown> = {}
    for (const events of options.events) {
      sizes[String(events)] = await runSize(database.client, events, options)
      console.info(JSON.stringify({ events, ...(sizes[String(events)] as object) }, null, 1))
    }
    await mkdir(dirname(options.report), { recursive: true })
    await writeFile(options.report, `${JSON.stringify({ options, sizes }, null, 2)}\n`)
  } finally {
    await database.stop()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : 'events totals benchmark failed')
    process.exitCode = 1
  })
}
