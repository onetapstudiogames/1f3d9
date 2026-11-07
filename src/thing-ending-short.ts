// The short status, key ends, on every public list row that names a thing (section 0):
// left out when no end is set and the thing never ended; otherwise {"state": "set", "at":
// the soonest known end or null} or {"state": "ended", "at": ended_at, or the due time
// while the end has come but is not yet recorded}. A due thing reads ended, so every list
// shows the end at once. It is judged in SQL at the database's transaction time with
// thing_end_due_at_row, the same clock and expression as the full ending object and the
// snapshot, and a list read never records an end (#37).
//
// Leaf module: it imports only a type, so every list loader can use it without importing
// src/thing-endings.ts and the engine behind it.

import type { ShortEndingStatus } from './thing-endings.ts'

/** Milliseconds, UTC, the shape toISOString writes. */
const ISO_MILLISECONDS = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
const ISO_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

function isoSql(expression: string): string {
  return `to_char((${expression}) AT TIME ZONE 'UTC', '${ISO_MILLISECONDS}')`
}

/**
 * An SQL expression giving the short status of the things row under `alias` as jsonb, or
 * null when no end is set and the thing never ended. `alias` is fixed text from the
 * caller's own query, never a request value. The due function runs only for a thing with
 * an end set and not yet recorded.
 */
export function thingShortEndsSql(alias: string): string {
  return `CASE
        WHEN ${alias}.ended_at IS NOT NULL
          THEN jsonb_build_object('state', 'ended', 'at', ${isoSql(`${alias}.ended_at`)})
        WHEN ${alias}.ending_rule IS NULL THEN NULL::jsonb
        ELSE (
          SELECT jsonb_build_object(
            'state', CASE WHEN coalesce(short_end.due_at <= transaction_timestamp(), false)
              THEN 'ended' ELSE 'set' END,
            'at', ${isoSql('short_end.due_at')})
          FROM (SELECT thing_end_due_at_row(${alias}) AS due_at) short_end
        )
      END`
}

/**
 * An SQL expression counting the remnants standing in one place: things not withdrawn
 * whose end is recorded or due now. It is a live count, beside the item count from
 * place_reading_totals, which keeps counting remnants as items, and it is the one count
 * a place collection read makes itself. Its second half matches the things_ending_open
 * index exactly. `placeId` is fixed SQL text, such as a parameter placeholder.
 */
export function placeRemnantCountSql(placeId: string): string {
  return `((SELECT count(*)
        FROM things remnant
        WHERE remnant.place_id = ${placeId}
          AND remnant.withdrawn_at IS NULL
          AND remnant.ended_at IS NOT NULL)
      + (SELECT count(*)
        FROM things remnant
        WHERE remnant.place_id = ${placeId}
          AND remnant.ending_rule IS NOT NULL
          AND remnant.ended_at IS NULL
          AND remnant.withdrawn_at IS NULL
          AND coalesce(thing_end_due_at_row(remnant) <= transaction_timestamp(), false)))::integer`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The short status read from thingShortEndsSql's jsonb; null when absent or unreadable. */
export function publicShortEnds(value: unknown): ShortEndingStatus | null {
  if (!isRecord(value)) return null
  const state = value.state
  const at = value.at
  if (state !== 'set' && state !== 'ended') return null
  if (at !== null && (typeof at !== 'string' || !ISO_TEXT.test(at))) return null
  return Object.freeze({ state, at: at as string | null })
}

/**
 * The row with its short status as the list sends it: the ends key kept when it reads,
 * and left out when no end applies (or the stored value cannot be read).
 */
export function withShortEnds<T extends object>(row: T): T {
  const record = row as Record<string, unknown>
  if (!Object.hasOwn(record, 'ends')) return row
  const { ends: raw, ...rest } = record
  const ends = publicShortEnds(raw)
  return Object.freeze(ends === null ? rest : { ...rest, ends }) as unknown as T
}
