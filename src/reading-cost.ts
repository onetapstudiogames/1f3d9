import { sql } from './db.ts'
import { PUBLIC_PAGE_DEFAULT } from './public-pagination.ts'

const READING_COST_TIMEOUT_MS = 1_500
const READING_COST_TIMEOUT_GRACE_MS = 100
const READING_COST_QUERY = `
  /* public:reading_cost */
  WITH first_read AS (
    SELECT
      coalesce((SELECT sum(octet_length(description) + octet_length(purpose)) FROM (
        SELECT description, purpose FROM places WHERE parent_id = $1::integer
        ORDER BY id DESC LIMIT ${PUBLIC_PAGE_DEFAULT}
      ) page), 0)::bigint AS subplace_bytes,
      coalesce((SELECT sum(octet_length(body)) FROM (
        SELECT body FROM things WHERE place_id = $1::integer AND withdrawn_at IS NULL
        ORDER BY id DESC LIMIT ${PUBLIC_PAGE_DEFAULT}
      ) page), 0)::bigint AS thing_bytes,
      coalesce((SELECT sum(octet_length(body)) FROM (
        SELECT body FROM notes WHERE place_id = $1::integer
        ORDER BY id DESC LIMIT ${PUBLIC_PAGE_DEFAULT}
      ) page), 0)::bigint AS note_bytes
  )
  SELECT
    octet_length(place.description) + octet_length(place.purpose)
      + totals.subplace_text_bytes + totals.thing_text_bytes + totals.note_text_bytes
      AS stored_text_bytes,
    octet_length(place.description) + octet_length(place.purpose)
      + first_read.subplace_bytes + first_read.thing_bytes + first_read.note_bytes
      AS first_read_text_bytes
  FROM places place
  JOIN place_reading_totals totals ON totals.place_id = place.id
  CROSS JOIN first_read
  WHERE place.id = $1::integer
`

export interface ReadingCostMeter {
  readonly available: true
  readonly size_unit: 'utf8_bytes'
  readonly counted_text: 'place descriptions and purposes, active thing bodies, and note bodies'
  readonly new_item_text_bytes: number
  readonly room_stored_text_bytes: number
  readonly current_first_read_text_bytes: number
}

export interface UnavailableReadingCostMeter {
  readonly available: false
  readonly reason: 'measurement_timeout' | 'measurement_failed'
  readonly measurement_timeout_ms: number
  readonly size_unit: 'utf8_bytes'
  readonly counted_text: 'place descriptions and purposes, active thing bodies, and note bodies'
  readonly new_item_text_bytes: number
  readonly room_stored_text_bytes: null
  readonly current_first_read_text_bytes: null
  readonly note:
    | 'the write succeeded; the reading-cost measurement timed out and its database query has a bounded deadline; do not retry'
    | 'the write succeeded; only this informational meter is unavailable; do not retry'
}

export interface ReadingCostQueryControls {
  readonly signal: AbortSignal
  readonly statementTimeoutMs: number
}

export interface ReadingCostMeterOptions {
  readonly timeoutMs?: number
  readonly load?: (
    placeId: number,
    newItemText: string,
    controls: ReadingCostQueryControls,
  ) => Promise<ReadingCostMeter>
}

function safeByteCount(value: unknown, field: string): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${field} is invalid`)
  return count
}

function validTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 2 || value > 60_000) {
    throw new Error('reading-cost timeout must be an integer from 2 to 60000 milliseconds')
  }
  return value
}

function validStatementTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new Error('reading-cost database timeout must be an integer from 1 to 60000 milliseconds')
  }
  return value
}

function databaseTimeout(responseTimeoutMs: number): number {
  const grace = Math.min(
    READING_COST_TIMEOUT_GRACE_MS,
    Math.max(1, Math.floor(responseTimeoutMs / 4)),
  )
  return responseTimeoutMs - grace
}

function postgresErrorCode(error: unknown, depth = 0): string | null {
  if (depth > 4 || error == null || typeof error !== 'object') return null
  const candidate = error as { readonly code?: unknown; readonly sourceError?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return postgresErrorCode(candidate.sourceError, depth + 1)
}

export async function readingCostMeter(
  placeId: number,
  newItemText: string,
  controls?: ReadingCostQueryControls,
): Promise<ReadingCostMeter> {
  const statementTimeoutMs = validStatementTimeout(
    controls?.statementTimeoutMs ?? databaseTimeout(READING_COST_TIMEOUT_MS),
  )
  const transactionOptions = controls
    ? { readOnly: true, fetchOptions: { signal: controls.signal } }
    : { readOnly: true }
  const resultSets = await sql.transaction(transaction => [
    transaction.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`),
    transaction.query(READING_COST_QUERY, [placeId]),
  ], transactionOptions)
  const rows = (resultSets[1] ?? []) as Array<{
    stored_text_bytes: unknown
    first_read_text_bytes: unknown
  }>
  const row = rows[0]
  if (!row) throw new Error('reading cost place is unavailable')
  return Object.freeze({
    available: true,
    size_unit: 'utf8_bytes',
    counted_text: 'place descriptions and purposes, active thing bodies, and note bodies',
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
  const timeoutMs = validTimeout(options.timeoutMs ?? READING_COST_TIMEOUT_MS)
  const controller = new AbortController()
  const controls = Object.freeze({
    signal: controller.signal,
    statementTimeoutMs: databaseTimeout(timeoutMs),
  })
  const load = options.load ?? readingCostMeter
  let responseTimedOut = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      load(placeId, newItemText, controls),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          responseTimedOut = true
          const error = new Error(`reading cost exceeded ${timeoutMs}ms`)
          controller.abort(error)
          reject(error)
        }, timeoutMs)
      }),
    ])
  } catch (error) {
    const timedOut = responseTimedOut || postgresErrorCode(error) === '57014'
    if (!controller.signal.aborted) controller.abort(error)
    if (!timedOut) console.error('reading cost unavailable after successful write', error)
    return Object.freeze({
      available: false,
      reason: timedOut ? 'measurement_timeout' : 'measurement_failed',
      measurement_timeout_ms: timeoutMs,
      size_unit: 'utf8_bytes',
      counted_text: 'place descriptions and purposes, active thing bodies, and note bodies',
      new_item_text_bytes: Buffer.byteLength(newItemText, 'utf8'),
      room_stored_text_bytes: null,
      current_first_read_text_bytes: null,
      note: timedOut
        ? 'the write succeeded; the reading-cost measurement timed out and its database query has a bounded deadline; do not retry'
        : 'the write succeeded; only this informational meter is unavailable; do not retry',
    })
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
