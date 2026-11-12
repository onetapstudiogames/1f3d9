import {
  FEED_ROOM_ACTIVITY_KIND_SQL,
  FEED_ROOM_DETAIL_ID_PATTERN,
  FEED_ROOM_EVENT_KIND_SQL,
  feedRoomEventLateralSql,
  feedRoomIdsSql,
  feedRoomOutcomeContentSql,
  feedRoomOutcomePlaceSql,
} from './feed-rooms.ts'
import { PUBLIC_EVENT_TEXT_BYTES_SQL, PUBLIC_EVENT_TOTALS_COLUMNS_SQL } from './public-pagination.ts'

// The events list's kept tally (decision #196). Settled events, up to the change
// marker kept in events_totals_state, are counted once into events_totals_tally,
// grouped by what decides whether a feed room keeps them out today. The five-minute
// maintenance cron folds newly settled events in (this file) and checks the tally
// each hour against a full recount (src/events-totals-check.ts). Nothing answers a
// caller from it yet: GET /api/events still counts the whole list itself.

/**
 * Bump on any change to the grouping below or to the feed rule it mirrors
 * (src/feed-rooms.ts). A tally built under another version is discarded and
 * rebuilt; test/events-totals-guards.test.ts fails until the bump is made and the
 * pinned rule text there is updated.
 */
export const EVENTS_TOTALS_RULE_VERSION = 1

/** Change ids folded in one transaction. */
const EVENTS_TOTALS_FOLD_CHUNK_CHANGES = 10_000
/** Chunks one maintenance run may fold, so a first fill spreads across runs. */
const EVENTS_TOTALS_FOLD_MAX_CHUNKS = 10
/** No new chunk starts after this much of one run has passed. */
const EVENTS_TOTALS_FOLD_BUDGET_MS = 60_000
const FOLD_STATEMENT_TIMEOUT = '30s'
const STATE_LOCK_TIMEOUT = '2s'
const MISMATCH_HOLD_WINDOW = "INTERVAL '24 hours'"

export interface EventsTotalsQuery {
  query(text: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>
}

export interface EventsTotalsDatabase extends EventsTotalsQuery {
  transaction<T>(work: (transaction: EventsTotalsQuery) => Promise<T>): Promise<T>
}

export type FoldLimits = Readonly<{ chunkChanges: number; maxChunks: number; budgetMs: number }>

const EVENTS_TOTALS_FOLD_LIMITS: FoldLimits = Object.freeze({
  chunkChanges: EVENTS_TOTALS_FOLD_CHUNK_CHANGES,
  maxChunks: EVENTS_TOTALS_FOLD_MAX_CHUNKS,
  budgetMs: EVENTS_TOTALS_FOLD_BUDGET_MS,
})

/**
 * A lateral join adding the tally rows one event counts in: always (kind, all), and,
 * when a feed room could keep it out, also the room it names, the thing it names, or
 * the set of rooms its applied outcomes name. Built from the same pieces as
 * feedRoomEventLateralSql, in the same order: the activity branch first, then a
 * named place before a named thing.
 */
export function eventTallyKeysSql(eventAlias: string, alias = 'tally_key'): string {
  const applied = `${eventAlias}.detail->'applied_public_activity'`
  const isFeedKind = `${eventAlias}.kind IN (${FEED_ROOM_EVENT_KIND_SQL})`
  const namesPlace = `${eventAlias}.detail->>'place_id' ~ '${FEED_ROOM_DETAIL_ID_PATTERN}'`
  return `CROSS JOIN LATERAL (
    SELECT 'all'::text AS key_type, 0 AS key_id, '{}'::integer[] AS room_set
    UNION ALL
    SELECT 'rooms', activity_rooms.ids[1], activity_rooms.ids
    FROM (
      SELECT (
        SELECT CASE WHEN bool_and(affected.content AND affected.place_id IS NOT NULL)
          THEN array_agg(DISTINCT affected.place_id ORDER BY affected.place_id) END
        FROM (
          SELECT ${feedRoomOutcomeContentSql('outcome')} AS content,
            ${feedRoomOutcomePlaceSql('outcome')} AS place_id
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${applied}) = 'array'
            THEN ${applied} ELSE '[]'::jsonb END) outcome
        ) affected
      ) AS ids
    ) activity_rooms
    WHERE ${eventAlias}.kind IN (${FEED_ROOM_ACTIVITY_KIND_SQL})
      AND jsonb_typeof(${applied}) = 'array'
      AND activity_rooms.ids IS NOT NULL
    UNION ALL
    SELECT 'place', (${eventAlias}.detail->>'place_id')::integer, '{}'::integer[]
    WHERE ${isFeedKind} AND ${namesPlace}
    UNION ALL
    SELECT 'thing', (${eventAlias}.detail->>'thing_id')::integer, '{}'::integer[]
    WHERE ${isFeedKind} AND NOT coalesce(${namesPlace}, false)
      AND ${eventAlias}.detail->>'thing_id' ~ '${FEED_ROOM_DETAIL_ID_PATTERN}'
  ) ${alias}`
}

// One chunk: read the settled marker and fold the change ids just above the kept one,
// in one statement, and move the kept marker with the rows in the same commit.
const FOLD_CHUNK_SQL = `/* events-totals:fold */
  WITH marker AS (
    SELECT current_change_id AS high_mark FROM public_change_state WHERE singleton
  ), bounds AS (
    SELECT $1::bigint AS low,
      GREATEST($1::bigint, LEAST(marker.high_mark, $1::bigint + $2::bigint)) AS high,
      marker.high_mark
    FROM marker
  ), grouped AS (
    SELECT event.kind, tally_key.key_type, tally_key.key_id, tally_key.room_set,
      count(*)::bigint AS items,
      coalesce(sum(${PUBLIC_EVENT_TEXT_BYTES_SQL}), 0)::bigint AS text_bytes
    FROM bounds
    JOIN public_change_log change
      ON change.change_id > bounds.low AND change.change_id <= bounds.high
    JOIN events event ON event.id = change.event_id
    ${eventTallyKeysSql('event')}
    GROUP BY event.kind, tally_key.key_type, tally_key.key_id, tally_key.room_set
  ), added AS (
    INSERT INTO events_totals_tally AS tally (kind, key_type, key_id, room_set, items, text_bytes)
    SELECT kind, key_type, key_id, room_set, items, text_bytes FROM grouped
    ON CONFLICT (kind, key_type, key_id, room_set) DO UPDATE
    SET items = tally.items + EXCLUDED.items,
      text_bytes = tally.text_bytes + EXCLUDED.text_bytes
    RETURNING 1
  ), moved AS (
    UPDATE events_totals_state state
    SET kept_change_id = bounds.high,
      caught_up_at = CASE WHEN state.caught_up_at IS NULL AND bounds.high >= bounds.high_mark
        THEN clock_timestamp() ELSE state.caught_up_at END
    FROM bounds
    WHERE state.singleton AND state.kept_change_id = bounds.low AND state.generation = $3::bigint
    RETURNING state.kept_change_id
  )
  SELECT bounds.high::text AS high, bounds.high_mark::text AS high_mark,
    (SELECT coalesce(sum(items) FILTER (WHERE key_type = 'all'), 0) FROM grouped)::bigint AS events,
    (SELECT count(*) FROM added)::integer AS rows,
    (SELECT count(*) FROM moved)::integer AS moved
  FROM bounds`

const LOCK_STATE_SQL = `/* events-totals:lock */
  SELECT rule_version, generation::text AS generation, kept_change_id::text AS kept_change_id, paused
  FROM events_totals_state WHERE singleton FOR UPDATE SKIP LOCKED`

/** Discard the tally and start a new generation at change 0, never trusted. */
const RESET_SQL = `/* events-totals:reset */
  WITH emptied AS (DELETE FROM events_totals_tally RETURNING 1)
  UPDATE events_totals_state
  SET rule_version = $1::integer, generation = generation + 1, kept_change_id = 0,
    caught_up_at = NULL, trusted = FALSE,
    last_check_ok = CASE WHEN $2::boolean THEN FALSE ELSE last_check_ok END,
    held_off = held_off OR ($2::boolean AND last_mismatch_at IS NOT NULL
      AND last_mismatch_at > $3::timestamptz - ${MISMATCH_HOLD_WINDOW}),
    last_mismatch_at = CASE WHEN $2::boolean THEN $3::timestamptz ELSE last_mismatch_at END
  WHERE singleton
  RETURNING generation::text AS generation, held_off, (SELECT count(*) FROM emptied)::integer AS emptied`

type LockedState = Readonly<{ ruleVersion: number; generation: bigint; keptChangeId: bigint; paused: boolean }>

function bigintField(value: unknown, name: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/u.test(value)) return BigInt(value)
  throw new Error(`events totals ${name} is invalid`)
}

function countField(value: unknown, name: string): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`events totals ${name} is invalid`)
  return count
}

// The planner cannot see how few change ids lie past the kept marker, so its estimate
// would switch on JIT compilation, which costs far more than these small statements.
async function prepareStateTransaction(transaction: EventsTotalsQuery): Promise<void> {
  await transaction.query(`SET LOCAL statement_timeout = '${FOLD_STATEMENT_TIMEOUT}'`)
  await transaction.query(`SET LOCAL lock_timeout = '${STATE_LOCK_TIMEOUT}'`)
  await transaction.query('SET LOCAL jit = off')
}

/** Lock the state row, or null while another maintenance run holds it. */
async function lockEventsTotalsState(transaction: EventsTotalsQuery): Promise<LockedState | null> {
  const rows = await transaction.query(LOCK_STATE_SQL)
  const row = rows[0]
  if (!row) {
    const present = await transaction.query('SELECT 1 FROM events_totals_state WHERE singleton')
    if (present.length === 0) throw new Error('events totals state row is missing')
    return null
  }
  const ruleVersion = Number(row.rule_version)
  if (!Number.isSafeInteger(ruleVersion) || typeof row.paused !== 'boolean') {
    throw new Error('events totals state row is invalid')
  }
  return Object.freeze({
    ruleVersion,
    generation: bigintField(row.generation, 'generation'),
    keptChangeId: bigintField(row.kept_change_id, 'kept change id'),
    paused: row.paused,
  })
}

export type ResetReason = 'rule_version' | 'mismatch'

/** Discard the tally inside the caller's transaction, which already holds the state row. */
export async function resetEventsTally(
  transaction: EventsTotalsQuery,
  reason: ResetReason,
  now: Date,
): Promise<Readonly<{ generation: bigint; heldOff: boolean }>> {
  const rows = await transaction.query(RESET_SQL, [
    EVENTS_TOTALS_RULE_VERSION, reason === 'mismatch', now.toISOString(),
  ])
  const row = rows[0]
  if (!row || typeof row.held_off !== 'boolean') throw new Error('events totals reset did not apply')
  return Object.freeze({ generation: bigintField(row.generation, 'generation'), heldOff: row.held_off })
}

export type FoldChunkResult =
  | Readonly<{ state: 'busy' | 'paused' | 'reset' }>
  | Readonly<{ state: 'folded'; events: number; keptChangeId: bigint; caughtUp: boolean }>

/** Fold one bounded chunk in the caller's transaction. Exported for the lock evidence test. */
export async function foldOneChunk(
  transaction: EventsTotalsQuery,
  chunkChanges: number,
  now: Date,
): Promise<FoldChunkResult> {
  await prepareStateTransaction(transaction)
  const state = await lockEventsTotalsState(transaction)
  if (state === null) return Object.freeze({ state: 'busy' })
  if (state.paused) return Object.freeze({ state: 'paused' })
  if (state.ruleVersion !== EVENTS_TOTALS_RULE_VERSION) {
    await resetEventsTally(transaction, 'rule_version', now)
    return Object.freeze({ state: 'reset' })
  }
  const rows = await transaction.query(FOLD_CHUNK_SQL, [
    state.keptChangeId.toString(), chunkChanges, state.generation.toString(),
  ])
  const row = rows[0]
  if (!row) throw new Error('events totals fold found no change state')
  if (countField(row.moved, 'fold result') !== 1) throw new Error('events totals fold did not move the kept marker')
  const high = bigintField(row.high, 'fold bound')
  return Object.freeze({
    state: 'folded',
    events: countField(row.events, 'folded events'),
    keptChangeId: high,
    caughtUp: high >= bigintField(row.high_mark, 'change marker'),
  })
}

export type FoldResult = Readonly<{
  state: 'busy' | 'paused' | 'folded'
  chunks: number
  events: number
  keptChangeId: bigint | null
  caughtUp: boolean
}>

function validLimits(limits: FoldLimits): boolean {
  return Number.isSafeInteger(limits.chunkChanges) && limits.chunkChanges > 0
    && Number.isSafeInteger(limits.maxChunks) && limits.maxChunks > 0
    && Number.isFinite(limits.budgetMs) && limits.budgetMs > 0
}

/**
 * Fold newly settled events into the tally, one bounded chunk per transaction, until it
 * reaches the marker, the chunk count runs out or the time budget passes. A skipped or
 * failed run leaves the tally exactly at its last commit; the next run carries on.
 */
export async function foldSettledEvents(
  database: EventsTotalsDatabase,
  limits: FoldLimits = EVENTS_TOTALS_FOLD_LIMITS,
  now: () => Date = () => new Date(),
): Promise<FoldResult> {
  if (!validLimits(limits)) throw new TypeError('events totals fold limits are invalid')
  const started = Date.now()
  let chunks = 0
  let events = 0
  let keptChangeId: bigint | null = null
  let caughtUp = false
  while (chunks < limits.maxChunks && Date.now() - started < limits.budgetMs) {
    const result = await database.transaction(async transaction => (
      await foldOneChunk(transaction, limits.chunkChanges, now())
    ))
    chunks += 1
    if (result.state === 'busy' || result.state === 'paused') {
      return Object.freeze({ state: result.state, chunks, events, keptChangeId, caughtUp })
    }
    if (result.state === 'folded') {
      events += result.events
      keptChangeId = result.keptChangeId
      caughtUp = result.caughtUp
      if (caughtUp) break
    }
  }
  return Object.freeze({ state: 'folded', chunks, events, keptChangeId, caughtUp })
}

export type CheapCheckResult =
  | Readonly<{ state: 'busy' | 'paused' }>
  | Readonly<{ state: 'ok'; keptChangeId: bigint; items: number }>
  | Readonly<{ state: 'mismatch'; keptChangeId: bigint; keptItems: number; loggedChanges: number; heldOff: boolean }>

const CHEAP_CHECK_SQL = `/* events-totals:cheap-check */
  SELECT
    (SELECT coalesce(sum(tally.items), 0) FROM events_totals_tally tally
      WHERE tally.key_type = 'all')::bigint AS kept_items,
    (SELECT count(*) FROM public_change_log change
      WHERE change.change_id <= $1::bigint)::bigint AS logged_changes`

/**
 * Every run: the (kind, all) rows must add up to exactly the change rows at or below
 * the kept marker. A difference discards the tally and starts a rebuild.
 */
export async function checkKeptCountCheaply(
  database: EventsTotalsDatabase,
  now: () => Date = () => new Date(),
): Promise<CheapCheckResult> {
  return await database.transaction(async transaction => {
    await prepareStateTransaction(transaction)
    const state = await lockEventsTotalsState(transaction)
    if (state === null) return Object.freeze({ state: 'busy' })
    if (state.paused) return Object.freeze({ state: 'paused' })
    const rows = await transaction.query(CHEAP_CHECK_SQL, [state.keptChangeId.toString()])
    const keptItems = countField(rows[0]?.kept_items, 'kept items')
    const loggedChanges = countField(rows[0]?.logged_changes, 'logged changes')
    if (keptItems === loggedChanges) {
      return Object.freeze({ state: 'ok', keptChangeId: state.keptChangeId, items: keptItems })
    }
    const reset = await resetEventsTally(transaction, 'mismatch', now())
    return Object.freeze({
      state: 'mismatch', keptChangeId: state.keptChangeId, keptItems, loggedChanges, heldOff: reset.heldOff,
    })
  })
}

const KEPT_KIND_FILTER = '($1::text IS NULL OR tally.kind = $1::text)'
const TALLY_FEED_IDS = feedRoomIdsSql()

/**
 * The events list's totals for no filter or one kind ($1), worked out from the tally
 * plus a full count of only the events above its kept marker, in one statement. The
 * columns match the list's own totals: total_items, total_text_bytes,
 * left_out_feed_rooms and every left-out room id (not cut to 10). The hourly check
 * compares this with the full count; no caller is answered from it yet.
 */
export const EVENTS_TALLY_TOTALS_SQL = `/* events-totals:kept */
  WITH tally_state AS MATERIALIZED (
    SELECT kept_change_id FROM events_totals_state WHERE singleton
  ), tally_feed AS MATERIALIZED (
    SELECT ${TALLY_FEED_IDS} AS ids
  ), kept_all AS (
    SELECT coalesce(sum(tally.items), 0)::bigint AS items,
      coalesce(sum(tally.text_bytes), 0)::bigint AS text_bytes
    FROM events_totals_tally tally
    WHERE tally.key_type = 'all' AND ${KEPT_KIND_FILTER}
  ), kept_left_out AS (
    SELECT tally.items, tally.text_bytes, tally.key_id AS room_id
    FROM tally_feed
    JOIN events_totals_tally tally ON tally.key_type = 'place' AND tally.key_id = ANY(tally_feed.ids)
    WHERE ${KEPT_KIND_FILTER}
    UNION ALL
    SELECT tally.items, tally.text_bytes, feed_thing.place_id AS room_id
    FROM tally_feed
    JOIN things feed_thing ON feed_thing.place_id = ANY(tally_feed.ids)
    JOIN events_totals_tally tally ON tally.key_type = 'thing' AND tally.key_id = feed_thing.id
    WHERE ${KEPT_KIND_FILTER}
    UNION ALL
    SELECT tally.items, tally.text_bytes, tally.key_id AS room_id
    FROM tally_feed
    JOIN events_totals_tally tally ON tally.key_type = 'rooms' AND tally.key_id = ANY(tally_feed.ids)
      AND tally.room_set <@ tally_feed.ids
    WHERE ${KEPT_KIND_FILTER}
  ), fresh AS (
    SELECT ${PUBLIC_EVENT_TOTALS_COLUMNS_SQL}
    FROM tally_state
    JOIN public_change_log change ON change.change_id > tally_state.kept_change_id
    JOIN events event ON event.id = change.event_id
    ${feedRoomEventLateralSql('event', TALLY_FEED_IDS)}
    WHERE ($1::text IS NULL OR event.kind = $1::text)
  ), left_out AS (
    SELECT coalesce(sum(items), 0)::bigint AS items, coalesce(sum(text_bytes), 0)::bigint AS text_bytes
    FROM kept_left_out
  )
  SELECT
    (kept_all.items - left_out.items + fresh.total_items)::bigint AS total_items,
    (kept_all.text_bytes - left_out.text_bytes + fresh.total_text_bytes)::bigint AS total_text_bytes,
    (left_out.items + fresh.left_out_feed_rooms)::bigint AS left_out_feed_rooms,
    (SELECT array_agg(DISTINCT room.id ORDER BY room.id) FROM (
      SELECT room_id AS id FROM kept_left_out
      UNION SELECT unnest(fresh.left_out_feed_room_ids)
    ) room) AS left_out_feed_room_ids,
    (SELECT count(*) FROM tally_state)::integer AS state_rows
  FROM kept_all CROSS JOIN left_out CROSS JOIN fresh`
