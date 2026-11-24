// Read-only checks for the room keys migrations (db/migrations/20261124_*): run by the
// operator against a database before and after the index build, never as part of a
// deploy. Every statement runs inside BEGIN READ ONLY with a 30 s statement limit and
// parallel workers off, so it can change nothing. The connection string comes from
// ROOM_KEYS_CHECK_DATABASE_URL and is never printed.
//   --phase function  after the function migration, before the index: the function is
//                     the reviewed one, and computing it over every stored event refuses
//                     nothing (so building the index and later inserts cannot fail).
//   --phase index     after the index migration: the index is the reviewed one, valid and
//                     ready, and for each room the new one-room statement answers exactly
//                     as today's (frozen from main in test/helpers/room-events-oracle), with
//                     the new statement's time and whether it looked up each room key (a
//                     read with a kind, an actor or a window on a big room reads the events
//                     those allow instead). --kinds adds a read with each of those kinds,
//                     --actors one with each of those residents, and --within-seconds one
//                     with that window, to each room's reads, with and without rooms below;
//                     with none of them each room is read without a filter only.
//   node --experimental-strip-types scripts/check-room-events-keys.ts --phase index --rooms 3,1093 --kinds note --actors founder --within-seconds 1800
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import {
  assertReviewedEventRoomKeysFunction,
  EVENT_ROOM_KEYS_FUNCTION_STATE_QUERY,
  EVENTS_ROOM_KEYS_INDEX_STATE_QUERY,
  eventsRoomKeysIndexRecoveryStatements,
  EVENTS_ROOM_KEYS_INDEX_STATEMENT,
  reviewedEventRoomKeysBody,
} from './migrate.ts'
import type { PublicEventFilters, PublicPage } from '../src/public-pagination.ts'

type Phase = 'function' | 'index'
type Options = Readonly<{
  phase: Phase; rooms: readonly number[]; kinds: readonly string[]; actors: readonly string[]; withinSeconds: number | null
}>

export function parseRoomKeysCheckArgs(args: readonly string[]): Options {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`)
    return index < 0 ? undefined : args[index + 1]
  }
  const phase = value('phase')
  assert(phase === 'function' || phase === 'index', '--phase is function or index')
  const rooms = (value('rooms') ?? '3').split(',').map(Number)
  assert(rooms.length > 0 && rooms.length <= 20 && rooms.every(id => Number.isSafeInteger(id) && id >= 1 && id <= 2_147_483_647),
    '--rooms lists 1 to 20 room ids')
  const kindsArg = value('kinds')
  const kinds = kindsArg === undefined ? [] : kindsArg.split(',')
  assert(kindsArg === undefined || (kinds.length >= 1 && kinds.length <= 5 && kinds.every(kind => /^[a-z][a-z0-9_]{0,63}$/u.test(kind))),
    '--kinds lists 1 to 5 event kinds')
  const actorsArg = value('actors')
  const actors = actorsArg === undefined ? [] : actorsArg.split(',')
  assert(actorsArg === undefined || (actors.length >= 1 && actors.length <= 5 && actors.every(actor => /^[a-z0-9][a-z0-9-]{2,31}$/u.test(actor))),
    '--actors lists 1 to 5 resident handles')
  const withinArg = value('within-seconds')
  const withinSeconds = withinArg === undefined ? null : Number(withinArg)
  assert(withinSeconds === null || (/^[0-9]{1,4}$/u.test(withinArg!) && withinSeconds >= 1 && withinSeconds <= 1800),
    '--within-seconds is from 1 to 1800')
  return Object.freeze({ phase, rooms, kinds, actors, withinSeconds })
}

async function readOnly<T>(client: Client, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN READ ONLY')
  try {
    await client.query("SET LOCAL statement_timeout = '30000ms'")
    await client.query('SET LOCAL max_parallel_workers_per_gather = 0')
    return await work()
  } finally {
    await client.query('ROLLBACK')
  }
}

const digest = (rows: readonly Record<string, unknown>[]): string =>
  createHash('sha256').update(JSON.stringify(rows)).digest('hex')

async function checkFunction(client: Client): Promise<Record<string, unknown>> {
  const body = reviewedEventRoomKeysBody(await readFile(new URL('../db/migrations/20261124_event_room_keys_function.sql', import.meta.url), 'utf8'))
  return await readOnly(client, async () => {
    assertReviewedEventRoomKeysFunction((await client.query(EVENT_ROOM_KEYS_FUNCTION_STATE_QUERY)).rows, body)
    const started = performance.now()
    const totals = (await client.query(`SELECT count(*)::bigint AS events, coalesce(max(cardinality(keyed.keys)), 0) AS most_keys,
        coalesce(sum(cardinality(keyed.keys)), 0)::bigint AS total_keys,
        (SELECT max(id) FROM events) AS newest_event_id
      FROM events event CROSS JOIN LATERAL (SELECT public.event_room_keys(event.detail) AS keys) keyed`)).rows[0]!
    return { function: 'reviewed', ...totals, ms: Math.round(performance.now() - started) }
  })
}

async function checkIndex(client: Client, options: Options): Promise<Record<string, unknown>> {
  const pagination = await import('../src/public-pagination.ts')
  const { budgetedExactStatement } = await import('../src/public-exact-query.ts')
  const oracle = (JSON.parse(await readFile(new URL('../test/helpers/room-events-oracle/main-af009f2.json', import.meta.url), 'utf8')) as
    { statements: Record<string, string> }).statements
  const index = await readOnly(client, async () => {
    const rows = (await client.query(EVENTS_ROOM_KEYS_INDEX_STATE_QUERY)).rows
    if (eventsRoomKeysIndexRecoveryStatements(rows, EVENTS_ROOM_KEYS_INDEX_STATEMENT).length !== 0) {
      throw new Error('events_room_keys is missing or not valid and ready; run the events-room-keys-index migration first')
    }
    // Times below include JIT compiling on a server that has JIT; the live server has none.
    return (await client.query(`SELECT pg_relation_size('public.events_room_keys')::bigint AS index_bytes,
      pg_jit_available() AS jit_available`)).rows[0]!
  })
  const page: PublicPage = Object.freeze({ ok: true, cursor: null, limit: 20, fetchLimit: 21 })
  const results: Record<string, unknown>[] = []
  // Each room is read with no filter, then with each kind, each actor and the window alone.
  const narrowings: ReadonlyArray<Readonly<{ kind: string | null; actor: string | null; withinSeconds: number | null }>> = [
    { kind: null, actor: null, withinSeconds: null },
    ...options.kinds.map(kind => ({ kind, actor: null, withinSeconds: null })),
    ...options.actors.map(actor => ({ kind: null, actor, withinSeconds: null })),
    ...(options.withinSeconds === null ? [] : [{ kind: null, actor: null, withinSeconds: options.withinSeconds }]),
  ]
  for (const placeId of options.rooms) {
    for (const [includeDescendants, narrowing] of [false, true].flatMap(within => narrowings.map(narrowing => [within, narrowing] as const))) {
      const filters: PublicEventFilters = { ...narrowing, placeId, includeDescendants, afterId: null }
      let sent: Readonly<{ text: string; params: readonly unknown[] }> | null = null
      await pagination.loadPublicEventCollectionRows(async (text, params) => { sent = { text, params }; return [] }, filters, page)
        .catch(() => undefined)
      assert.ok(sent, 'the room read sent a statement')
      const { text, params } = sent as Readonly<{ text: string; params: readonly unknown[] }>
      const today = oracle[includeDescendants ? 'withinCounted' : 'exactCounted']!
      const result = await readOnly(client, async () => {
        const started = performance.now()
        const now = (await client.query(text, [...params])).rows
        const ms = Math.round(performance.now() - started)
        const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${budgetedExactStatement(text)}`, [...params])).rows
          .map(row => String(row['QUERY PLAN']))
        const before = (await client.query(today, [...params])).rows
        return {
          room: placeId, mode: includeDescendants ? 'within_place_id' : 'place_id', ...narrowing,
          same_answer: digest(now) === digest(before), total_items: now[0]?.total_items, returned: now.filter(row => row.id != null).length,
          ms, execution_ms: Number(plan.find(line => line.startsWith('Execution Time'))?.match(/[0-9.]+/u)?.[0]),
          // The way the read did not take shows in the plan as never executed.
          each_key: plan.some(line => line.includes('events_room_keys') && !line.includes('never executed')),
        }
      })
      results.push(result)
    }
  }
  return { index: 'reviewed, valid and ready', ...index, rooms: results, all_same: results.every(row => row.same_answer === true) }
}

async function main(): Promise<void> {
  const options = parseRoomKeysCheckArgs(process.argv.slice(2))
  const url = process.env.ROOM_KEYS_CHECK_DATABASE_URL
  if (!url) throw new Error('set ROOM_KEYS_CHECK_DATABASE_URL in this process only; it is never printed')
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const result = options.phase === 'function' ? await checkFunction(client) : await checkIndex(client, options)
    console.info(JSON.stringify({ phase: options.phase, at: new Date().toISOString(), ...result }, null, 1))
  } finally {
    await client.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'room keys check failed')
    process.exitCode = 1
  })
}
