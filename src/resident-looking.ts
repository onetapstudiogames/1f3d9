import type { Resident } from './core.ts'
import { sql } from './db.ts'
import {
  RESIDENT_LOOKING_READ_LIMIT,
  RESIDENT_LOOKING_READ_TIMEOUT_MS,
  RESIDENT_LOOKING_REFRESH_SECONDS,
  RESIDENT_LOOKING_TTL_SECONDS,
} from './resident-looking-limits.ts'

export {
  RESIDENT_LOOKING_READ_LIMIT,
  RESIDENT_LOOKING_READ_TIMEOUT_MS,
  RESIDENT_LOOKING_REFRESH_SECONDS,
  RESIDENT_LOOKING_TTL_SECONDS,
}

export interface ResidentLooking {
  readonly place_id: number
  readonly started_at: string
  readonly expires_at: string
}

async function boundedOptionalRead<T>(operation: Promise<T>): Promise<T | null> {
  return Promise.race([
    operation.then(value => value, () => null),
    new Promise<null>(resolve => setTimeout(() => resolve(null), RESIDENT_LOOKING_READ_TIMEOUT_MS)),
  ])
}

/** Best-effort, logically ephemeral signal. The room is derived in PostgreSQL. */
export async function recordResidentLooking(
  resident: Pick<Resident, 'id'>,
  database: typeof sql = sql,
): Promise<void> {
  try {
    await database`
      WITH instant AS MATERIALIZED (
        SELECT clock_timestamp() AS at
      ), pruned AS (
        DELETE FROM resident_looking
        USING instant
        WHERE expires_at <= instant.at AND resident_id <> ${resident.id}
      ), presence AS (
        SELECT current_place_id AS place_id
        FROM resident_presence
        WHERE resident_id = ${resident.id} AND current_place_id IS NOT NULL
      )
      INSERT INTO resident_looking (resident_id, place_id, started_at, expires_at)
      SELECT ${resident.id}, presence.place_id, instant.at,
        instant.at + (${RESIDENT_LOOKING_TTL_SECONDS}::integer * interval '1 second')
      FROM presence CROSS JOIN instant
      ON CONFLICT (resident_id) DO UPDATE SET
        place_id = EXCLUDED.place_id,
        started_at = CASE
          WHEN resident_looking.place_id = EXCLUDED.place_id
            AND resident_looking.expires_at > EXCLUDED.started_at
          THEN resident_looking.started_at ELSE EXCLUDED.started_at END,
        expires_at = EXCLUDED.expires_at
      WHERE resident_looking.place_id <> EXCLUDED.place_id
         OR resident_looking.expires_at <= EXCLUDED.started_at
         OR resident_looking.expires_at <= EXCLUDED.started_at
              + (${RESIDENT_LOOKING_TTL_SECONDS - RESIDENT_LOOKING_REFRESH_SECONDS}::integer * interval '1 second')
    `
  } catch {
    // Attribution must never make an otherwise successful public read fail.
  }
}

export async function readResidentLooking(
  residentIds: readonly number[],
  database: typeof sql = sql,
): Promise<ReadonlyMap<number, ResidentLooking>> {
  if (residentIds.length === 0) return new Map()
  try {
    const rows = await boundedOptionalRead(database`
      SELECT looking.resident_id, looking.place_id, looking.started_at, looking.expires_at
      FROM resident_looking looking
      JOIN resident_presence presence ON presence.resident_id = looking.resident_id
      WHERE looking.resident_id = ANY(${residentIds}::integer[])
        AND looking.place_id = presence.current_place_id
        AND looking.expires_at > clock_timestamp()
    ` as unknown as Promise<Array<{ resident_id: number; place_id: number; started_at: string | Date; expires_at: string | Date }>>)
    if (!rows) return new Map()
    const entries: Array<readonly [number, ResidentLooking]> = []
    for (const row of rows) {
      const residentId = Number(row.resident_id)
      const placeId = Number(row.place_id)
      const started = new Date(row.started_at)
      const expires = new Date(row.expires_at)
      if (!Number.isSafeInteger(residentId) || residentId < 1 ||
          !Number.isSafeInteger(placeId) || placeId < 1 ||
          !Number.isFinite(started.getTime()) || !Number.isFinite(expires.getTime()) ||
          expires <= started) continue
      entries.push([residentId, Object.freeze({
        place_id: placeId, started_at: started.toISOString(), expires_at: expires.toISOString(),
      })])
    }
    return new Map(entries)
  } catch {
    return new Map()
  }
}

export async function readLookingResidentsAtPlace(placeId: number, limit = RESIDENT_LOOKING_READ_LIMIT, database: typeof sql = sql): Promise<Readonly<{
  residents: readonly Readonly<{ id: number; handle: string; looking: ResidentLooking }>[]
  total: number
  has_more: boolean
}>> {
  try {
    const rows = await boundedOptionalRead(database`
      SELECT resident.id, resident.handle, looking.place_id, looking.started_at,
        looking.expires_at, count(*) OVER ()::integer AS total
      FROM resident_looking looking
      JOIN resident_presence presence
        ON presence.resident_id = looking.resident_id
       AND presence.current_place_id = looking.place_id
      JOIN residents resident ON resident.id = looking.resident_id
      WHERE looking.place_id = ${placeId} AND looking.expires_at > clock_timestamp()
      ORDER BY looking.started_at, resident.id
      LIMIT ${limit}
    ` as Promise<Array<Record<string, unknown>>>)
    if (!rows) return Object.freeze({ residents: Object.freeze([]), total: 0, has_more: false })
    const total = Number(rows[0]?.total ?? 0)
    return Object.freeze({
      residents: rows.map(row => Object.freeze({
        id: Number(row.id),
        handle: String(row.handle),
        looking: Object.freeze({
          place_id: Number(row.place_id),
          started_at: new Date(row.started_at as string | Date).toISOString(),
          expires_at: new Date(row.expires_at as string | Date).toISOString(),
        }),
      })),
      total,
      has_more: total > rows.length,
    })
  } catch {
    return Object.freeze({ residents: Object.freeze([]), total: 0, has_more: false })
  }
}
