// Times one room's events history both ways on a disposable local PostgreSQL from the
// suites' pinned image, never a hosted database: today's statement (frozen from main before
// the room keys, test/helpers/room-events-oracle) beside the statement this clone's builder
// sends, which finds its candidates through events_room_keys. Each shape runs through the
// route's own budgeted statement text with parallel workers off, as the route has them;
// "before" runs get a 30 s statement limit instead of 1.5 s so their full cost shows. JIT is
// off in every run: the live server has no JIT library (pg_jit_available() is false), so a
// local JIT compile would time a cost the city never pays. Both
// answers are compared row for row. It also times the index build and the cost one event
// insert pays for the index, with fastupdate off and on.
//   node --experimental-strip-types scripts/benchmark-room-events.ts --disposable --events 450000,900000
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import type { PublicEventFilters, PublicPage } from '../src/public-pagination.ts'

type Options = Readonly<{ events: readonly number[]; runs: number; warmups: number; inserts: number; report: string }>

export function parseRoomEventsBenchmarkArgs(args: readonly string[]): Options {
  if (!args.includes('--disposable') || args.includes('--target')) {
    throw new Error('this benchmark requires --disposable; it never runs against a hosted database')
  }
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!
    assert(['--disposable', '--events', '--inserts', '--report'].includes(key), `unknown benchmark argument ${key}`)
    if (key === '--disposable') continue
    const value = args[++index]
    assert(value && !value.startsWith('--'), `missing benchmark value for ${key}`)
    values.set(key, value)
  }
  const events = (values.get('--events') ?? '450000,900000').split(',').map(Number)
  assert(events.every(count => Number.isSafeInteger(count) && count >= 1_000 && count <= 2_000_000), '--events lists sizes from 1000 to 2000000')
  const inserts = Number(values.get('--inserts') ?? '10000')
  assert(Number.isSafeInteger(inserts) && inserts >= 100 && inserts <= 100_000, '--inserts is from 100 to 100000')
  const report = resolve(values.get('--report') ?? 'test-results/room-events-benchmark/results.json')
  assert(report.startsWith(resolve('test-results') + (process.platform === 'win32' ? '\\' : '/')),
    'the report must stay inside this clone under test-results')
  return Object.freeze({ events, runs: 5, warmups: 2, inserts, report })
}

const BASE: PublicEventFilters = Object.freeze({
  kind: null, actor: null, placeId: null, includeDescendants: false, withinSeconds: null, afterId: null,
})
const page = (cursor: number | null = null, limit = 20): PublicPage => Object.freeze({ ok: true, cursor, limit, fetchLimit: limit + 1 })
type Statement = Readonly<{ text: string; params: readonly unknown[] }>

async function captured(load: (query: (text: string, params: readonly unknown[]) => Promise<never[]>) => Promise<unknown>): Promise<Statement> {
  let statement: Statement | null = null
  await load(async (text, params) => { statement = { text, params }; return [] }).catch(() => undefined)
  assert(statement, 'the loader sent no statement')
  return statement
}

const sorted = (samples: readonly number[]) => [...samples].sort((a, b) => a - b)
const quantile = (samples: readonly number[], q: number) => sorted(samples)[Math.min(samples.length - 1, Math.floor(samples.length * q))]!

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
      return { ms: performance.now() - started, rows: result.rows }
    } finally {
      await client.query('ROLLBACK')
    }
  }
  for (let index = 0; index < options.warmups; index += 1) await once(false)
  const samples: number[] = []
  let rows: Record<string, unknown>[] = []
  for (let index = 0; index < options.runs; index += 1) {
    const run = await once(false)
    samples.push(Math.round(run.ms * 10) / 10)
    rows = run.rows
  }
  const plan = (await once(true)).rows.map(row => String(row['QUERY PLAN']))
  return Object.freeze({
    samples, median: quantile(samples, 0.5), max: sorted(samples).at(-1)!,
    executionMs: Number(plan.find(line => line.startsWith('Execution Time'))?.match(/[0-9.]+/u)?.[0]),
    usesRoomKeysIndex: plan.some(line => line.includes('events_room_keys')),
    plan,
    answer: JSON.stringify(rows.map(({ __exact_read_slot: _slot, ...row }) => row)),
    totals: { items: rows[0]?.total_items, textBytes: rows[0]?.total_text_bytes, leftOut: rows[0]?.left_out_feed_rooms, returned: rows.filter(row => row.id != null).length },
  })
}

async function insertCost(pool: Pool, samples: readonly Readonly<{ kind: string; actor: string; detail: unknown }>[]) {
  const client = await pool.connect()
  try {
    const times: number[] = []
    for (const event of samples) {
      const started = performance.now()
      await client.query('INSERT INTO events (kind, actor, detail) VALUES ($1, $2, $3::jsonb)', [event.kind, event.actor, JSON.stringify(event.detail)])
      times.push((performance.now() - started) * 1000)
    }
    const round = (value: number) => Math.round(value)
    return Object.freeze({ inserts: times.length, medianMicros: round(quantile(times, 0.5)), p99Micros: round(quantile(times, 0.99)), maxMicros: round(sorted(times).at(-1)!) })
  } finally {
    client.release()
  }
}

async function indexFacts(pool: Pool) {
  return (await pool.query(`SELECT pg_relation_size('public.events_room_keys')::bigint AS index_bytes,
    pg_relation_size('public.events')::bigint AS events_bytes, index.indisvalid AS valid, index.indisready AS ready
    FROM pg_index index WHERE index.indexrelid = 'public.events_room_keys'::regclass`)).rows[0]
}

async function buildIndex(pool: Pool, fastupdate: 'on' | 'off'): Promise<number> {
  await pool.query('DROP INDEX IF EXISTS public.events_room_keys')
  const started = performance.now()
  await pool.query(`CREATE INDEX CONCURRENTLY events_room_keys ON public.events USING gin (public.event_room_keys(detail)) WITH (fastupdate = ${fastupdate})`)
  return Math.round(performance.now() - started)
}

async function runSize(pool: Pool, events: number, options: Options) {
  const fixtures = await import('../test/helpers/note-suite-fixtures/postgres.ts')
  const { FOUNDER, GROWER, NEIGHBOUR } = await import('../test/helpers/abilities-fixtures.ts')
  const { seedRoomEventsBenchmark } = await import('../test/helpers/room-events-benchmark/seed.ts')
  const pagination = await import('../src/public-pagination.ts')
  const oracle = JSON.parse(await readFile(new URL('../test/helpers/room-events-oracle/main-af009f2.json', import.meta.url), 'utf8')) as
    { statements: Record<string, string> }
  const seeded = await fixtures.resetCity([FOUNDER, GROWER, NEIGHBOUR])
  // The seed lands without the index, as production's events did; the build is timed after.
  await pool.query('DROP INDEX public.events_room_keys')
  const seedStarted = performance.now()
  const rooms = await seedRoomEventsBenchmark(pool, events, seeded.continentId)
  const seedMs = Math.round(performance.now() - seedStarted)
  const buildMs = await buildIndex(pool, 'off')
  await pool.query('ANALYZE events')
  const index = await indexFacts(pool)
  const facts = (await pool.query(`SELECT (SELECT count(*) FROM events)::integer AS events, (SELECT max(id) FROM events)::integer AS newest,
    (SELECT count(*) FROM things WHERE place_id = $1)::integer AS square_things, (SELECT count(*) FROM notes WHERE place_id = $1)::integer AS square_notes,
    (SELECT count(*) FROM places WHERE parent_id = $1 OR parent_id IN (SELECT id FROM places WHERE parent_id = $1))::integer AS rooms_below_square,
    current_setting('server_version') AS server_version`, [rooms.squareId])).rows[0]!
  const squareIds = (await pool.query<{ id: number }>(`SELECT id FROM events WHERE public.event_room_keys(detail) && ARRAY['p' || $1::text]
    ORDER BY id DESC LIMIT 400`, [rooms.squareId])).rows.map(row => Number(row.id))
  const square = { ...BASE, placeId: rooms.squareId }
  const within = { ...square, includeDescendants: true }
  const small = { ...BASE, placeId: rooms.smallRoomId }
  const shapes: ReadonlyArray<readonly [string, PublicEventFilters, PublicPage]> = [
    ['square place_id', square, page()],
    ['square within_place_id', within, page()],
    ['square within_place_id kind=note', { ...within, kind: 'note' }, page()],
    ['square place_id kind=action', { ...square, kind: 'action' }, page()],
    ['square within_place_id before_id', within, page(squareIds[199]!)],
    ['square within_place_id after_id', { ...within, afterId: squareIds[399]! }, page()],
    ['square within_place_id within_seconds=3600', { ...within, withinSeconds: 3600 }, page()],
    ['square within_place_id limit=200', within, page(null, 200)],
    ['small place_id', small, page()],
    ['small within_place_id', { ...small, includeDescendants: true }, page()],
    ['small place_id kind=note', { ...small, kind: 'note' }, page()],
  ]
  const oracleText = (filters: PublicEventFilters) => oracle.statements[filters.includeDescendants ? 'withinCounted' : 'exactCounted']!
  const client = await pool.connect()
  const results: Record<string, unknown> = {}
  try {
    for (const [name, filters, at] of shapes) {
      const after = await captured(query => pagination.loadPublicEventCollectionRows(query, filters, at))
      const before = { text: oracleText(filters), params: after.params }
      const beforeRuns = await timedRuns(client, before, options, true, '30s')
      const afterRuns = await timedRuns(client, after, options, true, '1500ms')
      assert.equal(afterRuns.answer, beforeRuns.answer, `${name}: the room read must answer exactly as today`)
      const brief = ({ plan: _plan, answer: _answer, ...rest }: typeof beforeRuns) => rest
      results[name] = {
        sameAnswer: true, before: brief(beforeRuns), after: brief(afterRuns),
        afterPlan: afterRuns.plan,
      }
      console.info(JSON.stringify({ events, shape: name, before: beforeRuns.median, after: afterRuns.median, index: afterRuns.usesRoomKeysIndex }))
    }
  } finally {
    client.release()
  }
  const sample = (await pool.query<{ kind: string; actor: string; detail: unknown }>(
    `SELECT kind, actor, detail FROM events ORDER BY hashtext(id::text) LIMIT $1`, [options.inserts])).rows
  await pool.query('DROP INDEX public.events_room_keys')
  const noIndex = await insertCost(pool, sample)
  await buildIndex(pool, 'off')
  const fastupdateOff = await insertCost(pool, sample)
  const fastupdateOnBuildMs = await buildIndex(pool, 'on')
  const fastupdateOn = await insertCost(pool, sample)
  await buildIndex(pool, 'off')
  return Object.freeze({
    facts, rooms, seedMs, index: { buildMs, fastupdateOnBuildMs, ...index },
    writeCost: { noIndex, fastupdateOff, fastupdateOn }, results,
  })
}

async function main(): Promise<void> {
  const options = parseRoomEventsBenchmarkArgs(process.argv.slice(2))
  if (!process.execArgv.includes('--experimental-test-module-mocks')) {
    const child = spawnSync(process.execPath, [
      '--experimental-strip-types', '--experimental-test-module-mocks', process.argv[1]!, ...process.argv.slice(2),
    ], { stdio: 'inherit', windowsHide: true })
    process.exitCode = child.status ?? 1
    return
  }
  const { startNoteSuiteDatabase } = await import('../test/helpers/note-suite-fixtures/postgres.ts')
  const database = await startNoteSuiteDatabase('room-events-benchmark')
  try {
    const sizes: Record<string, unknown> = {}
    for (const events of options.events) {
      sizes[String(events)] = await runSize(database.client, events, options)
      const { results: _results, ...summary } = sizes[String(events)] as Record<string, unknown>
      console.info(JSON.stringify({ events, ...summary }, null, 1))
    }
    await mkdir(dirname(options.report), { recursive: true })
    await writeFile(options.report, `${JSON.stringify({ options, sizes }, null, 2)}\n`)
  } finally {
    await database.stop()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : 'room events benchmark failed')
    process.exitCode = 1
  })
}
