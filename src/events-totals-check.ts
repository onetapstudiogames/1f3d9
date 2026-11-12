import { feedRoomEventLateralSql, feedRoomIdsSql } from './feed-rooms.ts'
import { PUBLIC_EVENT_TOTALS_COLUMNS_SQL } from './public-pagination.ts'
import {
  EVENTS_TALLY_TOTALS_SQL,
  resetEventsTally,
  type EventsTotalsDatabase,
  type EventsTotalsQuery,
} from './events-totals-tally.ts'

// The hourly full check of the kept events tally (decision #196). In one read-only
// snapshot it works out the totals the tally gives, for the whole list and every
// kind, and the totals the list's own SQL gives by counting every event, and compares
// every field. It runs on the maintenance cron, never on a caller, with its own time
// limit. A mismatch discards the tally, which then rebuilds; a second one within 24
// hours keeps it untrusted until the operator clears held_off. A check that fails
// after claiming its hour marks the tally untrusted until the next check matches.

const CHECK_STATEMENT_TIMEOUT = '30s'
const RECORD_LOCK_TIMEOUT = '5s'

/** The list's own totals for every kind, by counting every event (today's SQL). */
const FULL_TOTALS_BY_KIND_SQL = `/* events-totals:full */
  SELECT event.kind, ${PUBLIC_EVENT_TOTALS_COLUMNS_SQL}
  FROM events event
  ${feedRoomEventLateralSql('event', feedRoomIdsSql())}
  GROUP BY event.kind
  ORDER BY event.kind`

const SNAPSHOT_FACTS_SQL = `/* events-totals:facts */
  SELECT state.generation::text AS generation, state.kept_change_id::text AS kept_change_id,
    state.rule_version, state.caught_up_at IS NOT NULL AS caught_up,
    state.last_check_change_id::text AS last_check_change_id,
    state.last_check_feed_room_ids,
    ${feedRoomIdsSql()} AS feed_room_ids,
    (SELECT count(*) FROM events event WHERE NOT EXISTS (
      SELECT 1 FROM public_change_log change WHERE change.event_id = event.id))::bigint AS unlogged_events,
    ARRAY(SELECT DISTINCT tally.kind FROM events_totals_tally tally ORDER BY tally.kind) AS tally_kinds
  FROM events_totals_state state WHERE state.singleton`

// Coverage for the record: what is left out now, by the kind of tally row, and how
// many things moved in the folded range since the last check.
const COVERAGE_SQL = `/* events-totals:coverage */
  SELECT
    (SELECT coalesce(sum(tally.items), 0) FROM events_totals_tally tally
      WHERE tally.key_type = 'place' AND tally.key_id = ANY(${feedRoomIdsSql()}))::bigint AS place_rows,
    (SELECT coalesce(sum(tally.items), 0) FROM events_totals_tally tally
      JOIN things feed_thing ON feed_thing.id = tally.key_id
      WHERE tally.key_type = 'thing' AND feed_thing.place_id = ANY(${feedRoomIdsSql()}))::bigint AS thing_rows,
    (SELECT coalesce(sum(tally.items), 0) FROM events_totals_tally tally
      WHERE tally.key_type = 'rooms' AND tally.room_set <@ ${feedRoomIdsSql()})::bigint AS room_set_rows,
    (SELECT count(*) FROM public_change_log change JOIN events event ON event.id = change.event_id
      WHERE event.kind = 'thing_moved' AND change.change_id > $1::bigint
        AND change.change_id <= $2::bigint)::bigint AS things_moved`

export type EventsTotals = Readonly<{
  items: string
  textBytes: string
  leftOut: string
  leftOutRoomIds: readonly number[]
}>

export type EventsTotalsMismatch = Readonly<{
  kind: string | null
  kept: EventsTotals
  full: EventsTotals
}>

export type EventsTotalsObservation = Readonly<{
  ok: boolean
  generation: string
  keptChangeId: string
  caughtUp: boolean
  ruleVersion: number
  kinds: number
  unloggedEvents: number
  mismatches: readonly EventsTotalsMismatch[]
  feedRoomIds: readonly number[]
  feedRoomsChanged: boolean
  leftOutByKey: Readonly<{ place: number; thing: number; roomSet: number }>
  thingsMovedSinceLastCheck: number
  fullMs: number
  keptMs: Readonly<Record<string, number>>
}>

function roomIds(value: unknown): readonly number[] {
  if (value == null) return Object.freeze([])
  if (!Array.isArray(value)) throw new Error('events totals room ids are invalid')
  const ids = value.map(Number)
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('events totals room ids are invalid')
  return Object.freeze([...new Set(ids)].sort((a, b) => a - b))
}

// A full count is never below zero. The kept side is the tally's "all" row minus its
// left-out rows plus what came after the marker, so a wrong tally row can drive it below
// zero: that is a wrong count to record as a mismatch, not a reason for the check to stop.
const NATURAL_COUNT = /^(0|[1-9][0-9]*)$/u
const SIGNED_COUNT = /^(0|-?[1-9][0-9]*)$/u

type CountShape = 'natural' | 'signed'

function totalsFrom(row: Readonly<Record<string, unknown>> | undefined, shape: CountShape = 'natural'): EventsTotals {
  const pattern = shape === 'signed' ? SIGNED_COUNT : NATURAL_COUNT
  const text = (value: unknown): string => {
    const shown = String(value ?? '0')
    if (!pattern.test(shown)) throw new Error('events totals count is invalid')
    return shown
  }
  return Object.freeze({
    items: text(row?.total_items),
    textBytes: text(row?.total_text_bytes),
    leftOut: text(row?.left_out_feed_rooms),
    leftOutRoomIds: roomIds(row?.left_out_feed_room_ids),
  })
}

function sameTotals(left: EventsTotals, right: EventsTotals): boolean {
  return left.items === right.items && left.textBytes === right.textBytes
    && left.leftOut === right.leftOut
    && left.leftOutRoomIds.join(',') === right.leftOutRoomIds.join(',')
}

function addTotals(rows: readonly EventsTotals[]): EventsTotals {
  const sum = (pick: (row: EventsTotals) => string) => rows.reduce((total, row) => total + BigInt(pick(row)), 0n).toString()
  return Object.freeze({
    items: sum(row => row.items),
    textBytes: sum(row => row.textBytes),
    leftOut: sum(row => row.leftOut),
    leftOutRoomIds: roomIds(rows.flatMap(row => row.leftOutRoomIds)),
  })
}

function count(value: unknown, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`events totals ${name} is invalid`)
  return parsed
}

async function timed<T>(work: () => Promise<T>): Promise<Readonly<{ value: T; ms: number }>> {
  const started = performance.now()
  const value = await work()
  return Object.freeze({ value, ms: Math.round(performance.now() - started) })
}

async function enterSnapshot(transaction: EventsTotalsQuery): Promise<void> {
  await transaction.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
  const isolation = await transaction.query('SHOW transaction_isolation')
  if (isolation[0]?.transaction_isolation !== 'repeatable read') {
    throw new Error('events totals check needs one repeatable read snapshot')
  }
  await transaction.query(`SET LOCAL statement_timeout = '${CHECK_STATEMENT_TIMEOUT}'`)
  await transaction.query('SET LOCAL max_parallel_workers_per_gather = 0')
  // Without this the planner's guess for the part above the kept marker switches on JIT
  // compilation, about a second per statement at real size for a few milliseconds of work.
  await transaction.query('SET LOCAL jit = off')
}

async function keptTotalsByKind(
  transaction: EventsTotalsQuery,
  kinds: readonly (string | null)[],
): Promise<Readonly<{ totals: ReadonlyMap<string | null, EventsTotals>; ms: Record<string, number> }>> {
  const totals = new Map<string | null, EventsTotals>()
  const ms: Record<string, number> = {}
  for (const kind of kinds) {
    const read = await timed(async () => await transaction.query(EVENTS_TALLY_TOTALS_SQL, [kind]))
    if (count(read.value[0]?.state_rows, 'state rows') !== 1) throw new Error('events totals state row is missing')
    totals.set(kind, totalsFrom(read.value[0], 'signed'))
    ms[kind ?? '(all)'] = read.ms
  }
  return Object.freeze({ totals, ms })
}

function mismatchesOf(
  full: ReadonlyMap<string, EventsTotals>,
  kept: ReadonlyMap<string | null, EventsTotals>,
): readonly EventsTotalsMismatch[] {
  const zero = totalsFrom(undefined)
  const wholeList = addTotals([...full.values()])
  const found: EventsTotalsMismatch[] = []
  for (const [kind, keptTotals] of kept) {
    const fullTotals = kind === null ? wholeList : full.get(kind) ?? zero
    if (!sameTotals(keptTotals, fullTotals)) found.push(Object.freeze({ kind, kept: keptTotals, full: fullTotals }))
  }
  return Object.freeze(found)
}

/**
 * Compare the tally with a full count in one read-only snapshot, without writing
 * anything. Every event must also have its change row; any without one is a mismatch.
 */
export async function observeEventsTotals(database: EventsTotalsDatabase): Promise<EventsTotalsObservation> {
  return await database.transaction(async transaction => {
    await enterSnapshot(transaction)
    const facts = (await transaction.query(SNAPSHOT_FACTS_SQL))[0]
    if (!facts) throw new Error('events totals state row is missing')
    const fullRead = await timed(async () => await transaction.query(FULL_TOTALS_BY_KIND_SQL))
    const full = new Map(fullRead.value.map(row => [String(row.kind), totalsFrom(row)] as const))
    const tallyKinds = Array.isArray(facts.tally_kinds) ? facts.tally_kinds.map(String) : []
    const kinds = [null, ...[...new Set([...full.keys(), ...tallyKinds])].sort()]
    const kept = await keptTotalsByKind(transaction, kinds)
    const keptChangeId = String(facts.kept_change_id)
    const lastCheck = facts.last_check_change_id == null ? '0' : String(facts.last_check_change_id)
    const coverage = (await transaction.query(COVERAGE_SQL, [lastCheck, keptChangeId]))[0]
    const feedRoomIds = roomIds(facts.feed_room_ids)
    const unloggedEvents = count(facts.unlogged_events, 'unlogged events')
    const mismatches = mismatchesOf(full, kept.totals)
    return Object.freeze({
      ok: mismatches.length === 0 && unloggedEvents === 0,
      generation: String(facts.generation),
      keptChangeId,
      caughtUp: facts.caught_up === true,
      ruleVersion: count(facts.rule_version, 'rule version'),
      kinds: kinds.length - 1,
      unloggedEvents,
      mismatches,
      feedRoomIds,
      feedRoomsChanged: facts.last_check_feed_room_ids != null
        && roomIds(facts.last_check_feed_room_ids).join(',') !== feedRoomIds.join(','),
      leftOutByKey: Object.freeze({
        place: count(coverage?.place_rows, 'coverage'),
        thing: count(coverage?.thing_rows, 'coverage'),
        roomSet: count(coverage?.room_set_rows, 'coverage'),
      }),
      thingsMovedSinceLastCheck: count(coverage?.things_moved, 'coverage'),
      fullMs: fullRead.ms,
      keptMs: Object.freeze(kept.ms),
    })
  })
}

export type HourlyCheckResult =
  | Readonly<{ state: 'not_due' }>
  | Readonly<{ state: 'stale'; observation: EventsTotalsObservation }>
  | Readonly<{ state: 'recorded'; observation: EventsTotalsObservation; trusted: boolean; heldOff: boolean }>

// The check waits until the first fill has caught up: before that, the part above the
// kept marker is most of history, and counting it once per kind would cost a full
// count per kind for an answer that could not be trusted yet anyway.
const CLAIM_HOUR_SQL = `/* events-totals:claim-check */
  UPDATE events_totals_state
  SET last_check_hour = date_trunc('hour', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  WHERE singleton AND NOT paused AND caught_up_at IS NOT NULL
    AND (last_check_hour IS NULL
      OR last_check_hour < date_trunc('hour', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  RETURNING 1`

const RECORD_MATCH_SQL = `/* events-totals:record-check */
  UPDATE events_totals_state
  SET last_check_at = $1::timestamptz, last_check_ok = TRUE,
    last_check_change_id = $2::bigint, last_check_feed_room_ids = $3::integer[],
    trusted = $4::boolean AND caught_up_at IS NOT NULL AND NOT held_off
  WHERE singleton
  RETURNING trusted, held_off`

const RECORD_MISMATCH_SQL = `/* events-totals:record-mismatch */
  UPDATE events_totals_state
  SET last_check_at = $1::timestamptz, last_check_change_id = NULL, last_check_feed_room_ids = $2::integer[]
  WHERE singleton`

async function recordObservation(
  database: EventsTotalsDatabase,
  observation: EventsTotalsObservation,
  now: Date,
): Promise<HourlyCheckResult> {
  return await database.transaction(async transaction => {
    await transaction.query(`SET LOCAL lock_timeout = '${RECORD_LOCK_TIMEOUT}'`)
    const rows = await transaction.query(
      'SELECT generation::text AS generation FROM events_totals_state WHERE singleton FOR UPDATE',
    )
    if (!rows[0]) throw new Error('events totals state row is missing')
    if (String(rows[0].generation) !== observation.generation) return Object.freeze({ state: 'stale', observation })
    if (!observation.ok) {
      const reset = await resetEventsTally(transaction, 'mismatch', now)
      await transaction.query(RECORD_MISMATCH_SQL, [now.toISOString(), observation.feedRoomIds])
      return Object.freeze({ state: 'recorded', observation, trusted: false, heldOff: reset.heldOff })
    }
    const recorded = await transaction.query(RECORD_MATCH_SQL, [
      now.toISOString(), observation.keptChangeId, observation.feedRoomIds, observation.caughtUp,
    ])
    const row = recorded[0]
    if (!row || typeof row.trusted !== 'boolean' || typeof row.held_off !== 'boolean') {
      throw new Error('events totals check did not record')
    }
    return Object.freeze({ state: 'recorded', observation, trusted: row.trusted, heldOff: row.held_off })
  })
}

/**
 * Once per UTC hour, on the first maintenance run of that hour once the first fill has
 * caught up: claim the hour, observe and record. On a match the tally is trusted once it has caught up and is not held
 * off; on a mismatch it is discarded and rebuilds.
 */
export async function runHourlyEventsTotalsCheck(
  database: EventsTotalsDatabase,
  now = new Date(),
): Promise<HourlyCheckResult> {
  if (!Number.isFinite(now.getTime())) throw new TypeError('events totals check requires a valid current time')
  const claimed = await database.transaction(async transaction => {
    await transaction.query(`SET LOCAL lock_timeout = '${RECORD_LOCK_TIMEOUT}'`)
    return await transaction.query(CLAIM_HOUR_SQL, [now.toISOString()])
  })
  if (claimed.length === 0) return Object.freeze({ state: 'not_due' })
  let observation: EventsTotalsObservation
  try {
    observation = await observeEventsTotals(database)
  } catch (error) {
    await markCheckFailed(database, now, error)
    throw error
  }
  return await recordObservation(database, observation, now)
}

const RECORD_FAILED_SQL = `/* events-totals:record-failed */
  UPDATE events_totals_state
  SET last_check_at = $1::timestamptz, last_check_ok = FALSE, trusted = FALSE
  WHERE singleton`

// The hour is already claimed, so a check that fails would otherwise leave an older
// "trusted" standing until the next hour. It is marked not to be trusted, without
// discarding anything: a failed check is not a mismatch, and the next check that
// matches trusts the tally again. The cron reports the check's own error.
async function markCheckFailed(database: EventsTotalsDatabase, now: Date, cause: unknown): Promise<void> {
  try {
    await database.transaction(async transaction => {
      await transaction.query(`SET LOCAL lock_timeout = '${RECORD_LOCK_TIMEOUT}'`)
      await transaction.query(RECORD_FAILED_SQL, [now.toISOString()])
    })
  } catch (markError) {
    throw new AggregateError([cause, markError], 'events totals check failed and could not be marked')
  }
}
