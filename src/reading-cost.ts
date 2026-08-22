import { sql } from './db.ts'
import { PUBLIC_PAGE_DEFAULT } from './public-pagination.ts'

export interface ReadingCostMeter {
  readonly available: true
  readonly size_unit: 'utf8_bytes'
  readonly counted_text: 'place descriptions, active thing bodies, and note bodies'
  readonly new_item_text_bytes: number
  readonly room_stored_text_bytes: number
  readonly current_first_read_text_bytes: number
}

export interface UnavailableReadingCostMeter {
  readonly available: false
  readonly size_unit: 'utf8_bytes'
  readonly counted_text: 'place descriptions, active thing bodies, and note bodies'
  readonly new_item_text_bytes: number
  readonly room_stored_text_bytes: null
  readonly current_first_read_text_bytes: null
  readonly note: 'the write succeeded; only this informational meter is unavailable; do not retry'
}

export interface ReadingCostMeterOptions {
  readonly timeoutMs?: number
  readonly load?: (placeId: number, newItemText: string) => Promise<ReadingCostMeter>
}

const READING_COST_TIMEOUT_MS = 1_500

function safeByteCount(value: unknown, field: string): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${field} is invalid`)
  return count
}

export async function readingCostMeter(
  placeId: number,
  newItemText: string,
): Promise<ReadingCostMeter> {
  const rows = await sql`
    /* public:reading_cost */
    WITH first_read AS (
      SELECT
        coalesce((SELECT sum(octet_length(description)) FROM (
          SELECT description FROM places WHERE parent_id = ${placeId}
          ORDER BY id DESC LIMIT ${PUBLIC_PAGE_DEFAULT}
        ) page), 0)::bigint AS subplace_bytes,
        coalesce((SELECT sum(octet_length(body)) FROM (
          SELECT body FROM things WHERE place_id = ${placeId} AND withdrawn_at IS NULL
          ORDER BY id DESC LIMIT ${PUBLIC_PAGE_DEFAULT}
        ) page), 0)::bigint AS thing_bytes,
        coalesce((SELECT sum(octet_length(body)) FROM (
          SELECT body FROM notes WHERE place_id = ${placeId}
          ORDER BY id DESC LIMIT ${PUBLIC_PAGE_DEFAULT}
        ) page), 0)::bigint AS note_bytes
    )
    SELECT
      octet_length(place.description)
        + totals.subplace_text_bytes + totals.thing_text_bytes + totals.note_text_bytes
        AS stored_text_bytes,
      octet_length(place.description)
        + first_read.subplace_bytes + first_read.thing_bytes + first_read.note_bytes
        AS first_read_text_bytes
    FROM places place
    JOIN place_reading_totals totals ON totals.place_id = place.id
    CROSS JOIN first_read
    WHERE place.id = ${placeId}
  ` as Array<{ stored_text_bytes: unknown; first_read_text_bytes: unknown }>
  const row = rows[0]
  if (!row) throw new Error('reading cost place is unavailable')
  return Object.freeze({
    available: true,
    size_unit: 'utf8_bytes',
    counted_text: 'place descriptions, active thing bodies, and note bodies',
    new_item_text_bytes: Buffer.byteLength(newItemText, 'utf8'),
    room_stored_text_bytes: safeByteCount(row.stored_text_bytes, 'stored text bytes'),
    current_first_read_text_bytes: safeByteCount(row.first_read_text_bytes, 'first-read text bytes'),
  })
}

export async function safeReadingCostMeter(
  placeId: number,
  newItemText: string,
  options: ReadingCostMeterOptions = {},
): Promise<ReadingCostMeter | UnavailableReadingCostMeter> {
  const timeoutMs = options.timeoutMs ?? READING_COST_TIMEOUT_MS
  const load = options.load ?? readingCostMeter
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      load(placeId, newItemText),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`reading cost exceeded ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } catch (error) {
    console.error('reading cost unavailable after successful write', error)
    return Object.freeze({
      available: false,
      size_unit: 'utf8_bytes',
      counted_text: 'place descriptions, active thing bodies, and note bodies',
      new_item_text_bytes: Buffer.byteLength(newItemText, 'utf8'),
      room_stored_text_bytes: null,
      current_first_read_text_bytes: null,
      note: 'the write succeeded; only this informational meter is unavailable; do not retry',
    })
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
