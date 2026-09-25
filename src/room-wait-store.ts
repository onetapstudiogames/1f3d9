import { randomUUID } from 'node:crypto'
import { isoTimestamp } from './timestamp.ts'
import { engineSql, withEngineTransaction, type TaggedSql } from './engine.ts'
import { readPublicPings } from './room-ping-store.ts'
import { TALK_EVENT_TARGETS } from './moderation.ts'
import {
  WAIT_NO_PLACE_REFUSAL,
  WAIT_LINES_MAX,
  WAIT_PINGS_MAX,
  type ListeningResident,
  type RoomLine,
  type TalkOutcome,
  type WaitLease,
  type WaitSeconds,
} from './room-talk-contract.ts'
import type { WaitCursors, WaitPingRead, WaitRead } from './room-wait-hold.ts'

const LINE_EVENT_KINDS = Object.entries(TALK_EVENT_TARGETS)
  .filter(([, [targetType]]) => targetType === 'line')
  .map(([kind]) => kind)
const PING_EVENT_KINDS = Object.entries(TALK_EVENT_TARGETS)
  .filter(([, [targetType]]) => targetType === 'ping')
  .map(([kind]) => kind)

type WaitLeaseRow = Readonly<{
  lease_id: string
  place_id: number | string
  started_at: Date | string
  expires_at: Date | string
}>

type ListeningResidentRow = Readonly<{
  resident_id: number | string
  handle: string
  listening_until: Date | string
  total: number | string
}>

type WaitLineRow = Readonly<{
  checkpoint: string
  change_id: string | null
  id: number | string
  place_id: number | string
  author_id: number | string
  author: string
  body: string
  body_bytes: number | string
  created_at: Date | string
}>

type WaitPingRow = Readonly<{
  checkpoint: string
  change_id: string | null
  kind: 'ping_sent' | 'ping_answered'
  ping_id: number | string
}>

type WaitLeaseStateRow = Readonly<{
  lease_id: string | null
  lease_place_id: number | string | null
  lease_arrived_at: Date | string | null
  current_place_id: number | string | null
  current_arrived_at: Date | string | null
}>

async function queryRows<T>(result: Promise<unknown>): Promise<T[]> {
  return await result as T[]
}

function leaseFromRow(row: WaitLeaseRow): WaitLease {
  return {
    lease_id: row.lease_id,
    place_id: Number(row.place_id),
    started_at: isoTimestamp(row.started_at) ?? '',
    expires_at: isoTimestamp(row.expires_at) ?? '',
  }
}

function residentFromRow(row: ListeningResidentRow): ListeningResident {
  return {
    resident_id: Number(row.resident_id),
    handle: row.handle,
    listening_until: isoTimestamp(row.listening_until) ?? '',
  }
}

export async function openWait(
  input: Readonly<{ residentId: number; seconds: WaitSeconds }>,
  database: TaggedSql = engineSql,
): Promise<TalkOutcome<Readonly<{ lease: WaitLease }>>> {
  return withEngineTransaction(database, async transaction => {
    const lockedPresence = await queryRows<Readonly<{ place_id: number | string | null }>>(transaction`
      SELECT presence.current_place_id AS place_id
      FROM resident_presence presence
      WHERE presence.resident_id = ${input.residentId}
      FOR SHARE OF presence
    `)
    const presence = lockedPresence[0]
    if (presence === undefined || presence.place_id === null) {
      return { ok: false, refusal: WAIT_NO_PLACE_REFUSAL }
    }
    const activePlaces = await queryRows<Readonly<{ active: boolean }>>(transaction`
      SELECT coalesce(place.retired_at IS NULL, false) AS active
      FROM places place
      WHERE place.id = ${presence.place_id}
    `)
    if (activePlaces[0]?.active !== true) return { ok: false, refusal: WAIT_NO_PLACE_REFUSAL }

    const leaseId = randomUUID()
    const inserted = await queryRows<WaitLeaseRow>(transaction`
      INSERT INTO wait_leases (resident_id, place_id, arrived_at, lease_id, started_at, expires_at)
      SELECT presence.resident_id, presence.current_place_id, presence.arrived_at, ${leaseId}::uuid,
        stamp.now, stamp.now + make_interval(secs => ${input.seconds})
      FROM resident_presence presence, (SELECT clock_timestamp() AS now) stamp
      WHERE presence.resident_id = ${input.residentId}
      ON CONFLICT (resident_id) DO UPDATE SET
        place_id = EXCLUDED.place_id, arrived_at = EXCLUDED.arrived_at, lease_id = EXCLUDED.lease_id,
        started_at = EXCLUDED.started_at, expires_at = EXCLUDED.expires_at
      RETURNING lease_id, place_id, started_at, expires_at
    `)
    const row = inserted[0]
    if (row === undefined) return { ok: false, refusal: WAIT_NO_PLACE_REFUSAL }
    return { ok: true, status: 201, answer: { lease: leaseFromRow(row) } }
  })
}

export async function releaseWait(
  input: Readonly<{ residentId: number; leaseId: string }>,
  database: TaggedSql = engineSql,
): Promise<Readonly<{ released: boolean }>> {
  const deleted = await queryRows<Readonly<{ resident_id: number | string }>>(database`
    DELETE FROM wait_leases
    WHERE resident_id = ${input.residentId} AND lease_id = ${input.leaseId}::uuid
    RETURNING resident_id
  `)
  return { released: deleted.length === 1 }
}

export async function readListening(
  input: Readonly<{ placeId: number; limit: number }>,
  database: TaggedSql = engineSql,
): Promise<Readonly<{ residents: readonly ListeningResident[]; total: number }>> {
  const rows = await queryRows<ListeningResidentRow>(database`/* public:place_listening */
    SELECT lease.resident_id, resident.handle, lease.expires_at AS listening_until,
      count(*) OVER () AS total
    FROM wait_leases lease
    JOIN resident_presence presence ON presence.resident_id = lease.resident_id
      AND presence.current_place_id = lease.place_id AND presence.arrived_at = lease.arrived_at
    JOIN residents resident ON resident.id = lease.resident_id
    WHERE lease.place_id = ${input.placeId} AND lease.expires_at > clock_timestamp()
    ORDER BY lease.resident_id
    LIMIT ${input.limit}
  `)
  return {
    residents: rows.map(residentFromRow),
    total: Number(rows[0]?.total ?? 0),
  }
}

export async function readWaitChanges(input: Readonly<{
  residentId: number
  leaseId: string
  placeId: number
  cursors: WaitCursors
}>, database: TaggedSql = engineSql): Promise<WaitRead> {
  const [lineRows, pingRows, leaseRows] = await Promise.all([
    queryRows<WaitLineRow>(database`/* private:wait_lines */
      WITH checkpoint AS MATERIALIZED (
        SELECT current_change_id, current_change_id::text AS checkpoint
        FROM public_change_state
        WHERE singleton = true
      )
      SELECT checkpoint.checkpoint,
        page.change_id, page.id, page.place_id, page.author_id, page.author,
        page.body, page.body_bytes, page.created_at
      FROM checkpoint
      LEFT JOIN LATERAL (
        SELECT pcl.change_id::text AS change_id,
          line.id, line.place_id, line.resident_id AS author_id,
          resident.handle AS author, line.body, line.body_bytes, line.created_at
        FROM public_change_log pcl
        JOIN events e ON e.id = pcl.event_id
        JOIN room_lines line ON line.id = CASE
          WHEN e.detail->>'line_id' ~ '^[1-9][0-9]{0,9}$'
            THEN (e.detail->>'line_id')::bigint
          ELSE NULL
        END
        JOIN residents resident ON resident.id = line.resident_id
        WHERE pcl.change_id > ${input.cursors.line}::bigint
          AND pcl.change_id <= checkpoint.current_change_id
          AND e.kind = ANY(${LINE_EVENT_KINDS}::text[])
          AND line.place_id = ${input.placeId}
        ORDER BY pcl.change_id ASC
        LIMIT ${WAIT_LINES_MAX + 1}
      ) page ON true
      ORDER BY page.change_id::bigint ASC NULLS LAST
    `),
    queryRows<WaitPingRow>(database`/* private:wait_pings */
      WITH checkpoint AS MATERIALIZED (
        SELECT current_change_id, current_change_id::text AS checkpoint
        FROM public_change_state
        WHERE singleton = true
      )
      SELECT checkpoint.checkpoint, page.change_id, page.kind, page.ping_id
      FROM checkpoint
      LEFT JOIN LATERAL (
        SELECT pcl.change_id::text AS change_id, e.kind, ping.id AS ping_id
        FROM public_change_log pcl
        JOIN events e ON e.id = pcl.event_id
        JOIN pings ping ON ping.id = CASE
          WHEN e.detail->>'ping_id' ~ '^[1-9][0-9]{0,9}$'
            THEN (e.detail->>'ping_id')::bigint
          ELSE NULL
        END
        WHERE pcl.change_id > ${input.cursors.ping}::bigint
          AND pcl.change_id <= checkpoint.current_change_id
          AND e.kind = ANY(${PING_EVENT_KINDS}::text[])
          AND e.detail->>'target_id' = ${input.residentId}::text
        ORDER BY pcl.change_id ASC
        LIMIT ${WAIT_PINGS_MAX + 1}
      ) page ON true
      ORDER BY page.change_id::bigint ASC NULLS LAST
    `),
    queryRows<WaitLeaseStateRow>(database`/* private:wait_lease_state */
      SELECT lease.lease_id::text AS lease_id, lease.place_id AS lease_place_id,
        lease.arrived_at AS lease_arrived_at,
        presence.current_place_id, presence.arrived_at AS current_arrived_at
      FROM resident_presence presence
      LEFT JOIN wait_leases lease ON lease.resident_id = presence.resident_id
      WHERE presence.resident_id = ${input.residentId}
    `),
  ])

  const lineChanges = lineRows.filter(row => row.change_id !== null)
  const linesHasMore = lineChanges.length > WAIT_LINES_MAX
  const lines = lineChanges.slice(0, WAIT_LINES_MAX).map((row): RoomLine => ({
    id: Number(row.id),
    place_id: Number(row.place_id),
    author_id: Number(row.author_id),
    author: row.author,
    body: row.body,
    body_bytes: Number(row.body_bytes),
    created_at: isoTimestamp(row.created_at) ?? '',
  }))
  const lineCheckpoint = lineRows[0]?.checkpoint ?? '0'
  const nextLine = linesHasMore
    ? lineChanges[WAIT_LINES_MAX - 1]!.change_id!
    : lineCheckpoint

  const pingChanges = pingRows.filter(row => row.change_id !== null)
  const pingsHasMore = pingChanges.length > WAIT_PINGS_MAX
  const pingCheckpoint = pingRows[0]?.checkpoint ?? '0'
  const nextPing = pingsHasMore
    ? pingChanges[WAIT_PINGS_MAX - 1]!.change_id!
    : pingCheckpoint
  const publicPings = await readPublicPings(
    pingChanges.slice(0, WAIT_PINGS_MAX).map(row => Number(row.ping_id)),
    database,
  )
  const pings: WaitPingRead[] = pingChanges.slice(0, WAIT_PINGS_MAX).flatMap(row => {
    const ping = publicPings.get(Number(row.ping_id))
    return ping === undefined ? [] : [{
      change_id: row.change_id!,
      kind: row.kind,
      ping,
    }]
  })

  const lease = leaseRows[0]
  const still: WaitRead['still'] = lease === undefined
    || lease.current_place_id === null
    || Number(lease.current_place_id) !== input.placeId
    ? 'moved'
    : lease.lease_id === null || lease.lease_id !== input.leaseId
      ? 'replaced'
      : lease.lease_place_id !== null
        && Number(lease.lease_place_id) === input.placeId
        && lease.lease_arrived_at !== null
        && lease.current_arrived_at !== null
        && isoTimestamp(lease.lease_arrived_at) === isoTimestamp(lease.current_arrived_at)
        ? 'here'
        : 'moved'

  return {
    lines,
    linesHasMore,
    pings,
    pingsHasMore,
    next: { line: nextLine, ping: nextPing },
    still,
  }
}
