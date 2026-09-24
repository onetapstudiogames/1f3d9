import { isoTimestamp } from './timestamp.ts'
import {
  engineSql,
  withEngineTransaction,
  type TaggedSql,
} from './engine.ts'
import {
  isTalkRequestId,
  LINE_NOT_HERE_REFUSAL,
  lineAllowanceRefusal,
  lineBodyProblem,
  lineBodyRefusal,
  LINES_PER_UTC_DAY,
  LINES_PER_UTC_MINUTE,
  nextUtcMidnight,
  nextUtcMinute,
  requestReuseRefusal,
  TALK_REQUEST_ID_REFUSAL,
  TALK_REQUEST_LOCK_NAMESPACE,
  type LineAllowance,
  type RoomLine,
  type SayLineAnswer,
  type TalkOutcome,
  type TalkRequestOperation,
  type TalkRefusal,
} from './room-talk-contract.ts'

export type SayLineInput = Readonly<{
  residentId: number
  residentHandle: string
  placeId: unknown
  body: unknown
  requestId: unknown
}>

type LineRow = Readonly<{
  id: number | string
  place_id: number | string
  author_id: number | string
  author: string
  body: string
  body_bytes: number | string
  created_at: Date | string
}>

type PresenceRow = Readonly<{
  current_place_id: number | string | null
  active: boolean | null
  now: Date
}>

type QuotaRow = Readonly<{ day_used: number; minute_used: number }>

type InsertedLineRow = LineRow & Readonly<{
  day_used: number
  minute_used: number
}>

async function queryRows<T>(result: Promise<unknown>): Promise<T[]> {
  return await result as T[]
}

function allowance(dayUsed: number, minuteUsed: number, now: Date): LineAllowance {
  return {
    per_utc_minute: {
      used: minuteUsed,
      limit: LINES_PER_UTC_MINUTE,
      reset_at: nextUtcMinute(now).toISOString(),
    },
    per_utc_day: {
      used: dayUsed,
      limit: LINES_PER_UTC_DAY,
      reset_at: nextUtcMidnight(now).toISOString(),
    },
  }
}

function lineFromRow(row: LineRow): RoomLine {
  return {
    id: Number(row.id),
    place_id: Number(row.place_id),
    author_id: Number(row.author_id),
    author: row.author,
    body: row.body,
    body_bytes: Number(row.body_bytes),
    created_at: isoTimestamp(row.created_at) ?? '',
  }
}

async function currentAllowance(
  transaction: TaggedSql,
  residentId: number,
): Promise<Readonly<{ line_quota: LineAllowance; now: Date }>> {
  const rows = await queryRows<QuotaRow & Readonly<{ now: Date }>>(transaction`
    WITH sampled AS MATERIALIZED (
      SELECT clock_timestamp() AS sampled_at
    )
    SELECT
      sampled.sampled_at AS now,
      COALESCE((
        SELECT used FROM line_quota
        WHERE resident_id = ${residentId}
          AND utc_day = (sampled.sampled_at AT TIME ZONE 'UTC')::date
      ), 0)::integer AS day_used,
      COALESCE((
        SELECT used FROM line_minute_quota
        WHERE resident_id = ${residentId}
          AND minute_start = date_trunc('minute', sampled.sampled_at, 'UTC')
      ), 0)::integer AS minute_used
    FROM sampled
  `)
  const row = rows[0]!
  return { line_quota: allowance(row.day_used, row.minute_used, row.now), now: row.now }
}

async function allowanceAt(
  transaction: TaggedSql,
  residentId: number,
  now: Date,
): Promise<QuotaRow> {
  const rows = await queryRows<QuotaRow>(transaction`
    SELECT
      COALESCE((
        SELECT used FROM line_quota
        WHERE resident_id = ${residentId}
          AND utc_day = (${now}::timestamptz AT TIME ZONE 'UTC')::date
      ), 0)::integer AS day_used,
      COALESCE((
        SELECT used FROM line_minute_quota
        WHERE resident_id = ${residentId}
          AND minute_start = date_trunc('minute', ${now}::timestamptz, 'UTC')
      ), 0)::integer AS minute_used
  `)
  return rows[0]!
}

function refusal(refusal: TalkRefusal): TalkOutcome<SayLineAnswer> {
  return { ok: false, refusal }
}

export async function sayLine(
  input: SayLineInput,
  database: TaggedSql = engineSql,
): Promise<TalkOutcome<SayLineAnswer>> {
  if (!isTalkRequestId(input.requestId)) return refusal(TALK_REQUEST_ID_REFUSAL)
  const bodyProblem = lineBodyProblem(input.body)
  if (bodyProblem !== null) return refusal(lineBodyRefusal(bodyProblem))
  if (typeof input.placeId !== 'number'
    || !Number.isSafeInteger(input.placeId)
    || input.placeId < 1
    || input.placeId > 2_147_483_647) {
    return refusal(LINE_NOT_HERE_REFUSAL)
  }

  const residentId = input.residentId
  const placeId = input.placeId
  const body = input.body as string
  const requestId = input.requestId

  return withEngineTransaction(database, async transaction => {
    await transaction`
      SELECT pg_advisory_xact_lock(${TALK_REQUEST_LOCK_NAMESPACE}::int, ${residentId}::int)
    `

    const lineRows = await queryRows<LineRow>(transaction`
      SELECT line.id, line.place_id, line.resident_id AS author_id,
        resident.handle AS author, line.body, line.body_bytes, line.created_at
      FROM room_lines line
      JOIN residents resident ON resident.id = line.resident_id
      WHERE line.resident_id = ${residentId}
        AND line.request_id = ${requestId}::uuid
    `)
    const storedLine = lineRows[0]
    if (storedLine) {
      const sameRequestRows = await queryRows<Readonly<{ same: boolean }>>(transaction`
        SELECT place_id = ${placeId}::integer
          AND body COLLATE "C" = ${body}::text COLLATE "C" AS same
        FROM room_lines
        WHERE resident_id = ${residentId}
          AND request_id = ${requestId}::uuid
      `)
      if (!sameRequestRows[0]!.same) return refusal(requestReuseRefusal('line'))
      const current = await currentAllowance(transaction, residentId)
      return {
        ok: true,
        status: 200,
        answer: {
          line: lineFromRow(storedLine),
          line_quota: current.line_quota,
          replayed: true,
        },
      }
    }

    const pingRows = await queryRows<Readonly<{ operation: string }>>(transaction`
      SELECT operation
      FROM ping_operations
      WHERE resident_id = ${residentId}
        AND request_id = ${requestId}::uuid
    `)
    const pingOperation = pingRows[0]?.operation
    if (pingOperation) return refusal(requestReuseRefusal(pingOperation as TalkRequestOperation))

    const presenceRows = await queryRows<PresenceRow>(transaction`
      SELECT presence.current_place_id, place.retired_at IS NULL AS active,
        clock_timestamp() AS now
      FROM resident_presence presence
      LEFT JOIN places place ON place.id = presence.current_place_id
      WHERE presence.resident_id = ${residentId}
      FOR SHARE OF presence
    `)
    const presence = presenceRows[0]
    if (presence === undefined
      || Number(presence.current_place_id) !== placeId
      || presence.active !== true) {
      return refusal(LINE_NOT_HERE_REFUSAL)
    }

    const quotas = await allowanceAt(transaction, residentId, presence.now)
    if (quotas.day_used >= LINES_PER_UTC_DAY) {
      return refusal(lineAllowanceRefusal(nextUtcMidnight(presence.now).toISOString()))
    }
    if (quotas.minute_used >= LINES_PER_UTC_MINUTE) {
      return refusal(lineAllowanceRefusal(nextUtcMinute(presence.now).toISOString()))
    }

    const rows = await queryRows<InsertedLineRow>(transaction`
      WITH
      older_day AS (
        DELETE FROM line_quota
        WHERE resident_id = ${residentId}
          AND utc_day < (${presence.now}::timestamptz AT TIME ZONE 'UTC')::date
        RETURNING resident_id
      ),
      older_minute AS (
        DELETE FROM line_minute_quota
        WHERE resident_id = ${residentId}
          AND minute_start < date_trunc('minute', ${presence.now}::timestamptz, 'UTC')
        RETURNING resident_id
      ),
      day_quota AS (
        INSERT INTO line_quota (resident_id, utc_day, used)
        VALUES (${residentId}, (${presence.now}::timestamptz AT TIME ZONE 'UTC')::date, 1)
        ON CONFLICT (resident_id, utc_day)
        DO UPDATE SET used = line_quota.used + 1
        RETURNING used
      ),
      minute_quota AS (
        INSERT INTO line_minute_quota (resident_id, minute_start, used)
        VALUES (${residentId}, date_trunc('minute', ${presence.now}::timestamptz, 'UTC'), 1)
        ON CONFLICT (resident_id, minute_start)
        DO UPDATE SET used = line_minute_quota.used + 1
        RETURNING used
      ),
      new_line AS (
        INSERT INTO room_lines (place_id, resident_id, body, body_bytes, request_id, created_at)
        VALUES (
          ${placeId}, ${residentId}, ${body}, octet_length(${body})::smallint,
          ${requestId}::uuid, ${presence.now}
        )
        RETURNING id, place_id, resident_id AS author_id, body, body_bytes, created_at
      ),
      line_event AS (
        INSERT INTO events (at, kind, actor, detail)
        SELECT created_at, 'line_said', ${input.residentHandle},
          jsonb_build_object('line_id', id, 'place_id', place_id)
        FROM new_line
        RETURNING id
      )
      SELECT new_line.id, new_line.place_id, new_line.author_id,
        ${input.residentHandle}::text AS author, new_line.body, new_line.body_bytes,
        new_line.created_at, day_quota.used AS day_used, minute_quota.used AS minute_used
      FROM new_line
      CROSS JOIN day_quota
      CROSS JOIN minute_quota
      CROSS JOIN line_event
    `)
    const line = rows[0]!
    return {
      ok: true,
      status: 201,
      answer: {
        line: lineFromRow(line),
        line_quota: allowance(line.day_used, line.minute_used, presence.now),
        replayed: false,
      },
    }
  })
}
