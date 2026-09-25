import { engineSql, type TaggedSql } from './engine.ts'
import { isoTimestamp } from './timestamp.ts'
import {
  publicPingRecord,
  type LineHeading,
  type PublicPingRecord,
  type RoomLine,
} from './room-talk-contract.ts'
import { readPublicPings } from './room-ping-store.ts'

type LineDbRow = Readonly<{
  id: number | string
  place_id: number | string
  author_id: number | string
  author: string
  body: string
  body_bytes: number | string
  created_at: Date | string
}>

type LineHeadingDbRow = Readonly<Omit<LineDbRow, 'place_id' | 'body'>>

type PlaceTotalsRow = Readonly<{
  place_exists: boolean
  total_items: number | string
  total_text_bytes: number | string
}>

async function queryRows<T>(result: Promise<unknown>): Promise<T[]> {
  return await result as T[]
}

function lineFromRow(row: LineDbRow): RoomLine {
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

function headingFromRow(row: LineHeadingDbRow): LineHeading {
  return {
    id: Number(row.id),
    author_id: Number(row.author_id),
    author: row.author,
    body_bytes: Number(row.body_bytes),
    created_at: isoTimestamp(row.created_at) ?? '',
  }
}

export async function readLine(id: number, database: TaggedSql = engineSql): Promise<RoomLine | null> {
  const rows = await queryRows<LineDbRow>(database`/* public:talk_line */
    SELECT line.id, line.place_id, line.resident_id AS author_id,
      resident.handle AS author, line.body, line.body_bytes, line.created_at
    FROM room_lines line
    JOIN residents resident ON resident.id = line.resident_id
    WHERE line.id = ${id}
  `)
  return rows[0] ? lineFromRow(rows[0]) : null
}

export async function readPing(id: number, database: TaggedSql = engineSql): Promise<PublicPingRecord | null> {
  const ping = (await readPublicPings([id], database)).get(id)
  return ping ? publicPingRecord(ping) : null
}

export async function readPlaceLines(
  input: Readonly<{ placeId: number; beforeLineId: number | null; afterLineId: number | null; limit: number }>,
  database: TaggedSql = engineSql,
): Promise<Readonly<{
  placeExists: boolean
  lines: readonly RoomLine[]
  totalItems: number
  totalTextBytes: number
  hasMore: boolean
}>> {
  const totalsRows = await queryRows<PlaceTotalsRow>(database`/* public:place_lines */
    SELECT EXISTS (SELECT 1 FROM places WHERE id = ${input.placeId}) AS place_exists,
      (SELECT count(*) FROM room_lines WHERE place_id = ${input.placeId}) AS total_items,
      coalesce((
        SELECT sum(body_bytes) FROM room_lines WHERE place_id = ${input.placeId}
      ), 0) AS total_text_bytes
  `)
  const rows = await queryRows<LineDbRow>(database`/* public:place_lines */
    SELECT line.id, line.place_id, line.resident_id AS author_id,
      resident.handle AS author, line.body, line.body_bytes, line.created_at
    FROM room_lines line
    JOIN residents resident ON resident.id = line.resident_id
    WHERE line.place_id = ${input.placeId}
      AND (${input.beforeLineId}::int IS NULL OR line.id < ${input.beforeLineId}::int)
      AND (${input.afterLineId}::int IS NULL OR line.id > ${input.afterLineId}::int)
    ORDER BY line.id DESC
    LIMIT ${input.limit + 1}
  `)
  const totals = totalsRows[0]
  const hasMore = rows.length > input.limit
  return {
    placeExists: totals?.place_exists === true,
    lines: rows.slice(0, input.limit).map(lineFromRow),
    totalItems: Number(totals?.total_items ?? 0),
    totalTextBytes: Number(totals?.total_text_bytes ?? 0),
    hasMore,
  }
}

export async function readLineHeadings(
  input: Readonly<{ placeId: number; limit: number }>,
  database: TaggedSql = engineSql,
): Promise<Readonly<{ headings: readonly LineHeading[]; total: number }>> {
  const totalsRows = await queryRows<Readonly<{ total: number | string }>>(database`/* public:place_line_headings */
    SELECT count(*) AS total
    FROM room_lines
    WHERE place_id = ${input.placeId}
  `)
  const rows = await queryRows<LineHeadingDbRow>(database`/* public:place_line_headings */
    SELECT line.id, line.resident_id AS author_id, resident.handle AS author,
      line.body_bytes, line.created_at
    FROM room_lines line
    JOIN residents resident ON resident.id = line.resident_id
    WHERE line.place_id = ${input.placeId}
    ORDER BY line.id DESC
    LIMIT ${input.limit}
  `)
  return {
    headings: rows.map(headingFromRow),
    total: Number(totalsRows[0]?.total ?? 0),
  }
}
