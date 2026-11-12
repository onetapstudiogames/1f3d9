// Helpers for the kept events tally suites (decision #196) against real PostgreSQL:
// a database handle with real interactive transactions, event and thing writers, and
// the comparison of the tally's totals with the events list's own totals in one
// snapshot, for the whole list and every kind.
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type { EventsTotalsDatabase, EventsTotalsQuery } from '../../src/events-totals-tally.ts'
import { EVENTS_TALLY_TOTALS_SQL } from '../../src/events-totals-tally.ts'
import { loadPublicEventCollectionRows } from '../../src/public-pagination.ts'

type Rows = readonly Record<string, unknown>[]

export function tallyDatabase(pool: Pool): EventsTotalsDatabase {
  return Object.freeze({
    query: async (text: string, params: readonly unknown[] = []): Promise<Rows> => (
      await pool.query(text, [...params])
    ).rows,
    transaction: async <T>(work: (transaction: EventsTotalsQuery) => Promise<T>): Promise<T> => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work({
          query: async (text, params = []) => (await client.query(text, [...params])).rows,
        })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  })
}

export type EventSeed = Readonly<{ kind: string; actor?: string; detail?: Record<string, unknown> }>

export async function insertEvents(pool: Pool, events: readonly EventSeed[]): Promise<readonly number[]> {
  if (events.length === 0) return []
  const rows = await pool.query<{ id: number }>(
    `INSERT INTO events (kind, actor, detail)
     SELECT seed.kind, seed.actor, seed.detail
     FROM jsonb_to_recordset($1::jsonb) AS seed(kind text, actor text, detail jsonb)
     RETURNING id`,
    [JSON.stringify(events.map(event => ({
      kind: event.kind, actor: event.actor ?? 'founder', detail: event.detail ?? {},
    })))],
  )
  return rows.rows.map(row => Number(row.id))
}

export async function insertThing(pool: Pool, placeId: number, name = 'a kept thing'): Promise<number> {
  const rows = await pool.query<{ id: number }>(
    `INSERT INTO things (place_id, name, body, owner_id, maker_id)
     VALUES ($1, $2, 'thing body', 1, 1) RETURNING id`,
    [placeId, name],
  )
  return Number(rows.rows[0]!.id)
}

export async function setFeed(pool: Pool, placeId: number, feed: boolean): Promise<void> {
  await pool.query(
    feed
      ? 'UPDATE places SET quiet = TRUE, feed = TRUE WHERE id = $1'
      : 'UPDATE places SET feed = FALSE WHERE id = $1',
    [placeId],
  )
}

export async function setQuiet(pool: Pool, placeId: number, quiet: boolean): Promise<void> {
  await pool.query('UPDATE places SET quiet = $2 WHERE id = $1 AND NOT feed', [placeId, quiet])
}

export async function moveThing(pool: Pool, thingId: number, placeId: number): Promise<void> {
  await pool.query('UPDATE things SET place_id = $2 WHERE id = $1', [thingId, placeId])
}

type RawTotals = Readonly<{ items: string; textBytes: string; leftOut: string; ids: string }>

function rawTotals(row: Readonly<Record<string, unknown>> | undefined): RawTotals {
  const ids = row?.left_out_feed_room_ids == null
    ? ''
    : [...new Set((row.left_out_feed_room_ids as unknown[]).map(Number))].sort((a, b) => a - b).join(',')
  return Object.freeze({
    items: String(row?.total_items ?? 'missing'),
    textBytes: String(row?.total_text_bytes ?? 'missing'),
    leftOut: String(row?.left_out_feed_rooms ?? 'missing'),
    ids,
  })
}

/**
 * The events list's own totals, through the list's own loader (the statement the
 * route sends), beside the tally's totals, both in one repeatable read snapshot, for
 * the whole list and every kind present. Every field must be equal.
 */
export async function assertKeptMatchesList(pool: Pool, label: string): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const kinds = (await client.query<{ kind: string }>(
      `SELECT kind FROM events UNION SELECT kind FROM events_totals_tally ORDER BY kind`,
    )).rows.map(row => row.kind)
    for (const kind of [null, ...kinds]) {
      let listRow: Record<string, unknown> | undefined
      await loadPublicEventCollectionRows(async (text, params) => {
        const rows = (await client.query(text, [...params])).rows as Record<string, unknown>[]
        listRow = rows[0]
        return rows
      }, { kind, actor: null, placeId: null }, { ok: true, cursor: null, limit: 1, fetchLimit: 2 })
      const kept = (await client.query(EVENTS_TALLY_TOTALS_SQL, [kind])).rows[0]
      assert.deepEqual(rawTotals(kept), rawTotals(listRow), `${label}: kind ${kind ?? '(all)'}`)
    }
    await client.query('COMMIT')
    return kinds.length
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
}

export async function tallyState(pool: Pool): Promise<Readonly<Record<string, unknown>>> {
  const rows = await pool.query('SELECT * FROM events_totals_state WHERE singleton')
  assert.equal(rows.rows.length, 1)
  return Object.freeze(rows.rows[0] as Record<string, unknown>)
}

export async function changeMarker(pool: Pool): Promise<string> {
  const rows = await pool.query('SELECT current_change_id::text AS marker FROM public_change_state')
  return String(rows.rows[0]!.marker)
}
