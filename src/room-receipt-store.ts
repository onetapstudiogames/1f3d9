import { engineSql, type TaggedSql } from './engine.ts'
import type { PendingPing, PublicPing } from './room-talk-contract.ts'
import { readPublicPings } from './room-ping-store.ts'

type PendingCountRow = Readonly<{
  total: number | string
  senders: number | string
  ping_id: number | string | null
}>

type FirstPageRow = PendingCountRow & Readonly<{
  next_before_ping_id: number | string | null
}>

async function queryRows<T>(result: Promise<unknown>): Promise<T[]> {
  return await result as T[]
}

function pendingPing(pingId: number, pings: ReadonlyMap<number, PublicPing>): PendingPing {
  const ping = pings.get(pingId)!
  return {
    ping_id: ping.id,
    status: ping.status,
    place_id: ping.place_id,
    sender_id: ping.sender_id,
    sender: ping.sender,
    sent_at: ping.sent_at,
    expires_at: ping.expires_at,
    answer: ping.answer,
  }
}

export async function readPendingPings(
  input: Readonly<{ residentId: number; beforePingId: number | null; limit: number }>,
  database: TaggedSql = engineSql,
): Promise<Readonly<{
  total: number
  senders: number
  receipts: readonly PendingPing[]
  hasMore: boolean
  nextBeforePingId: number | null
}>> {
  if (input.beforePingId === null) {
    const rows = await queryRows<FirstPageRow>(database`/* private:pending_pings_first */
      WITH pending AS MATERIALIZED (
        SELECT receipt.ping_id, ping.sender_id
        FROM ping_receipts receipt
        JOIN pings ping ON ping.id = receipt.ping_id
        WHERE receipt.recipient_id = ${input.residentId}
          AND receipt.seen_at IS NULL
          AND receipt.dismissed_at IS NULL
      ),
      counts AS (
        SELECT count(*)::int AS total, count(DISTINCT sender_id)::int AS senders
        FROM pending
      ),
      newest_by_sender AS (
        SELECT DISTINCT ON (sender_id) ping_id, sender_id
        FROM pending
        ORDER BY sender_id, ping_id DESC
      ),
      page AS (
        SELECT ping_id
        FROM newest_by_sender
        ORDER BY ping_id DESC
        LIMIT ${input.limit}
      ),
      cursor AS (
        SELECT max(pending.ping_id)::bigint + 1 AS next_before_ping_id
        FROM pending
        WHERE NOT EXISTS (
          SELECT 1 FROM page shown WHERE shown.ping_id = pending.ping_id
        )
      )
      SELECT counts.total, counts.senders, page.ping_id, cursor.next_before_ping_id
      FROM counts
      CROSS JOIN cursor
      LEFT JOIN page ON TRUE
      ORDER BY page.ping_id DESC NULLS LAST
    `)
    const firstRow = rows[0]!
    const pingIds = rows.flatMap(row => row.ping_id === null ? [] : [Number(row.ping_id)])
    const publicPings = await readPublicPings(pingIds, database)
    const receipts = pingIds.map(pingId => pendingPing(pingId, publicPings))
    const total = Number(firstRow.total)
    return {
      total,
      senders: Number(firstRow.senders),
      receipts,
      hasMore: total > receipts.length,
      nextBeforePingId: firstRow.next_before_ping_id === null
        ? null
        : Number(firstRow.next_before_ping_id),
    }
  }

  const rows = await queryRows<PendingCountRow>(database`/* private:pending_pings_page */
    WITH pending AS MATERIALIZED (
      SELECT receipt.ping_id, ping.sender_id
      FROM ping_receipts receipt
      JOIN pings ping ON ping.id = receipt.ping_id
      WHERE receipt.recipient_id = ${input.residentId}
        AND receipt.seen_at IS NULL
        AND receipt.dismissed_at IS NULL
        AND receipt.ping_id < ${input.beforePingId}::bigint
    ),
    counts AS (
      SELECT count(*)::int AS total, count(DISTINCT sender_id)::int AS senders
      FROM pending
    ),
    page AS (
      SELECT ping_id
      FROM pending
      ORDER BY ping_id DESC
      LIMIT ${input.limit + 1}
    )
    SELECT counts.total, counts.senders, page.ping_id
    FROM counts
    LEFT JOIN page ON TRUE
    ORDER BY page.ping_id DESC NULLS LAST
  `)
  const ids = rows.flatMap(row => row.ping_id === null ? [] : [Number(row.ping_id)])
  const hasMore = ids.length > input.limit
  const pingIds = ids.slice(0, input.limit)
  const publicPings = await readPublicPings(pingIds, database)
  const receipts = pingIds.map(pingId => pendingPing(pingId, publicPings))
  const firstRow = rows[0]!
  return {
    total: Number(firstRow.total),
    senders: Number(firstRow.senders),
    receipts,
    hasMore,
    nextBeforePingId: hasMore ? receipts.at(-1)!.ping_id : null,
  }
}

export async function readPendingSummary(
  residentId: number,
  database: TaggedSql = engineSql,
): Promise<Readonly<{
  total: number
  senders: number
  newest: PendingPing | null
  nextBeforePingId: number | null
}>> {
  const rows = await queryRows<PendingCountRow>(database`/* private:pending_ping_summary */
    WITH pending AS MATERIALIZED (
      SELECT receipt.ping_id, ping.sender_id
      FROM ping_receipts receipt
      JOIN pings ping ON ping.id = receipt.ping_id
      WHERE receipt.recipient_id = ${residentId}
        AND receipt.seen_at IS NULL
        AND receipt.dismissed_at IS NULL
    ),
    counts AS (
      SELECT count(*)::int AS total, count(DISTINCT sender_id)::int AS senders
      FROM pending
    ),
    newest AS (
      SELECT ping_id
      FROM pending
      ORDER BY ping_id DESC
      LIMIT 1
    )
    SELECT counts.total, counts.senders, newest.ping_id
    FROM counts
    LEFT JOIN newest ON TRUE
  `)
  const row = rows[0]!
  const total = Number(row.total)
  if (row.ping_id === null) {
    return { total, senders: Number(row.senders), newest: null, nextBeforePingId: null }
  }
  const pingId = Number(row.ping_id)
  const publicPings = await readPublicPings([pingId], database)
  return {
    total,
    senders: Number(row.senders),
    newest: pendingPing(pingId, publicPings),
    nextBeforePingId: total > 1 ? pingId : null,
  }
}

export async function markReceiptsSeen(
  input: Readonly<{ residentId: number; pingIds: readonly number[] }>,
  database: TaggedSql = engineSql,
): Promise<Readonly<{ marked: number }>> {
  if (input.pingIds.length === 0) return { marked: 0 }
  const rows = await queryRows<Readonly<{ ping_id: number | string }>>(database`/* private:mark_receipts_seen */
    UPDATE ping_receipts
    SET seen_at = clock_timestamp()
    WHERE recipient_id = ${input.residentId}
      AND ping_id = ANY(${input.pingIds}::int[])
      AND seen_at IS NULL
      AND dismissed_at IS NULL
    RETURNING ping_id
  `)
  return { marked: rows.length }
}
