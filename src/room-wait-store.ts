import { randomUUID } from 'node:crypto'
import { isoTimestamp } from './timestamp.ts'
import { engineSql, withEngineTransaction, type TaggedSql } from './engine.ts'
import {
  WAIT_NO_PLACE_REFUSAL,
  waitAlreadyOpenRefusal,
  type ListeningResident,
  type TalkOutcome,
  type WaitLease,
  type WaitSeconds,
} from './room-talk-contract.ts'

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
      WHERE wait_leases.expires_at <= EXCLUDED.started_at
        OR wait_leases.place_id <> EXCLUDED.place_id
        OR wait_leases.arrived_at <> EXCLUDED.arrived_at
      RETURNING lease_id, place_id, started_at, expires_at
    `)
    const row = inserted[0]
    if (row === undefined) {
      const existing = await queryRows<Readonly<{ expires_at: Date | string }>>(transaction`
        /* private:room-wait-already-open-expiry */
        SELECT expires_at FROM wait_leases WHERE resident_id = ${input.residentId}
      `)
      return {
        ok: false,
        refusal: waitAlreadyOpenRefusal(isoTimestamp(existing[0]?.expires_at) ?? ''),
      }
    }
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
  const rows = await queryRows<ListeningResidentRow>(database`
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
