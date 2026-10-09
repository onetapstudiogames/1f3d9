import type { ErrorClass } from './error-class.ts'
import { postgresErrorCode } from './core-primitives.ts'

/**
 * The city's own private tool-call log (decision #141). One row per MCP
 * `tools/call` on either door, kept 30 days and read only by founder #1.
 * Only the closed fields below ever reach a row: never resident identity,
 * arguments, note or line text, credentials, headers, raw user agents or IP
 * addresses.
 */

export const MCP_CALL_LOG_WRITE_CAP_MS = 200
export const MCP_CALL_LOG_RETENTION_DAYS = 30
export const MCP_CALL_LOG_RETENTION_PAGE_LIMIT = 5_000
export const MCP_CALL_LOG_PAGE_DEFAULT = 100
export const MCP_CALL_LOG_PAGE_MAX = 500
export const MCP_CALL_LOG_WINDOW_MAX_DAYS = 31
const DAY_MS = 24 * 60 * 60 * 1_000
const LATENCY_MAX_MS = 600_000

export type McpCallDoor = 'mcp' | 'connect'
export type McpClientFamily = 'chatgpt' | 'codex' | 'claude_ai' | 'claude_code' | 'other'
export type McpCallOutcome = 'ok' | 'refused' | 'error'
export type McpCallRefusalClass = ErrorClass | 'rpc_error'

const DOORS: ReadonlySet<string> = new Set(['mcp', 'connect'])
const CLIENT_FAMILIES: ReadonlySet<string> = new Set([
  'chatgpt', 'codex', 'claude_ai', 'claude_code', 'other',
])
const OUTCOMES: ReadonlySet<string> = new Set(['ok', 'refused', 'error'])
export const MCP_CALL_REFUSAL_CLASSES: ReadonlySet<string> = new Set([
  'bad_input', 'not_found', 'auth_required', 'forbidden', 'payment_required',
  'conflict', 'rate_limited', 'city_fault', 'unreachable', 'rpc_error',
])
const TOOL_NAME = /^[a-z_]{1,64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export interface McpCallLogDatabase {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>
}

/** The closed fields one call writes. The database adds `id` and `at`. */
export type McpCallLogRow = Readonly<{
  door: McpCallDoor
  tool: string
  clientFamily: McpClientFamily
  requestId: string
  outcome: McpCallOutcome
  refusalClass: McpCallRefusalClass | null
  httpStatus: number | null
  latencyMs: number
}>

export type McpCallLogWriter = (row: McpCallLogRow) => Promise<void>

/**
 * Sort a user agent into a client family. The raw agent is never stored.
 * Strings confirmed against production Vercel request rows of 2026-10-07/08:
 * `openai-mcp/1.0.0 (Codex)` and `codex-mcp-client/<version>` are Codex,
 * bare `openai-mcp/<version>` is ChatGPT, `Claude-User` is claude.ai and
 * `claude-code/<version> (...)` is Claude Code. Codex is tested first
 * because its hosted agent also starts with `openai-mcp/`.
 */
export function classifyClient(userAgent: string | null | undefined): McpClientFamily {
  const agent = typeof userAgent === 'string' ? userAgent.slice(0, 512) : ''
  if (/\(Codex\)/u.test(agent) || /^codex-mcp-client\//iu.test(agent)) return 'codex'
  if (/^openai-mcp\//iu.test(agent)) return 'chatgpt'
  if (/^Claude-User\b/u.test(agent)) return 'claude_ai'
  if (/^claude-code\//iu.test(agent)) return 'claude_code'
  return 'other'
}

/** A city fault or an unreachable backing route is the city's error; every other class is a refusal. */
export function outcomeForRefusalClass(errorClass: McpCallRefusalClass): Exclude<McpCallOutcome, 'ok'> {
  return errorClass === 'city_fault' || errorClass === 'unreachable' ? 'error' : 'refused'
}

/** Read the class the city's own error envelope carries; anything else is not a known class. */
export function refusalClassFromEnvelope(text: string): McpCallRefusalClass | null {
  try {
    const parsed = JSON.parse(text) as { error_class?: unknown }
    const errorClass = parsed?.error_class
    return typeof errorClass === 'string' && MCP_CALL_REFUSAL_CLASSES.has(errorClass)
      ? errorClass as McpCallRefusalClass
      : null
  } catch {
    return null
  }
}

function validRow(row: McpCallLogRow): boolean {
  return DOORS.has(row.door)
    && TOOL_NAME.test(row.tool)
    && CLIENT_FAMILIES.has(row.clientFamily)
    && UUID.test(row.requestId)
    && OUTCOMES.has(row.outcome)
    && (row.refusalClass === null || MCP_CALL_REFUSAL_CLASSES.has(row.refusalClass))
    && !(row.outcome === 'ok' && row.refusalClass !== null)
    && (row.httpStatus === null
      || (Number.isInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599))
    && Number.isInteger(row.latencyMs) && row.latencyMs >= 0 && row.latencyMs <= LATENCY_MAX_MS
}

/** One parameterised insert of exactly the eight closed fields. */
export async function recordMcpCall(
  database: McpCallLogDatabase,
  row: McpCallLogRow,
): Promise<void> {
  if (!validRow(row)) throw new TypeError('mcp call log row is outside the reviewed shape')
  await database.query(`
    /* mcp-call-log:insert */
    INSERT INTO mcp_call_log (
      door, tool, client_family, request_id,
      outcome, refusal_class, http_status, latency_ms
    )
    VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8)
  `, [
    row.door,
    row.tool,
    row.clientFamily,
    row.requestId,
    row.outcome,
    row.refusalClass,
    row.httpStatus,
    row.latencyMs,
  ])
}

/** One fixed line: the error name and a PostgreSQL code only, never a message. */
export function reportMcpCallLogFailure(error: unknown): void {
  try {
    const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name)
      ? error.name
      : 'Error'
    const errorCode = postgresErrorCode(error)
    console.error('mcp_call_log_failure', JSON.stringify({
      event: 'mcp_call_log_failure',
      error_name: errorName,
      ...(errorCode && /^[0-9A-Z]{5}$/u.test(errorCode) ? { error_code: errorCode } : {}),
    }))
  } catch {
    // Reporting must never change a tool result.
  }
}

/** The hourly purge's own fixed failure line, separate from the runtime log purge. */
export function reportMcpCallLogRetentionFailure(error: unknown): void {
  try {
    const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name)
      ? error.name
      : 'Error'
    const errorCode = postgresErrorCode(error)
    console.error('mcp_call_log_retention_failure', JSON.stringify({
      event: 'mcp_call_log_retention_failure',
      error_name: errorName,
      ...(errorCode && /^[0-9A-Z]{5}$/u.test(errorCode) ? { error_code: errorCode } : {}),
    }))
  } catch {
    // Reporting must never stop the maintenance tick.
  }
}

class McpCallLogTimeout extends Error {
  override name = 'McpCallLogTimeout'
}

/**
 * Await one write for at most the cap. A failure or timeout never changes the
 * tool result; it prints one fixed line. Vercel gives this Node handler no
 * waitUntil, so the write must finish before the response is returned.
 */
export async function writeMcpCallBriefly(
  writer: McpCallLogWriter,
  row: McpCallLogRow,
  capMs = MCP_CALL_LOG_WRITE_CAP_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const write = Promise.resolve().then(() => writer(row))
    // A write that settles after the cap must not become an unhandled rejection.
    write.catch(() => undefined)
    await Promise.race([
      write,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpCallLogTimeout('mcp call log write exceeded its cap')), capMs)
        timer.unref?.()
      }),
    ])
  } catch (error) {
    reportMcpCallLogFailure(error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export type McpCallLogRetentionResult = Readonly<{ ran: boolean; deleted: number }>

/** Claim one UTC hour durably, then delete one page of rows older than 30 days. */
export async function runMcpCallLogRetention(
  database: McpCallLogDatabase,
  now = new Date(),
): Promise<McpCallLogRetentionResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError('mcp call log retention requires a valid current time')
  }
  if (now.getUTCMinutes() >= 5) return Object.freeze({ ran: false, deleted: 0 })

  const cutoff = new Date(now.getTime() - MCP_CALL_LOG_RETENTION_DAYS * DAY_MS)
  const rows = await database.query(`
    /* mcp-call-log:retention */
    WITH requested AS (
      SELECT (
        date_trunc('hour', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ) AS retention_hour
    ), claimed AS (
      INSERT INTO mcp_call_log_retention_state (singleton, last_hour)
      SELECT TRUE, requested.retention_hour
      FROM requested
      ON CONFLICT (singleton) DO UPDATE
      SET last_hour = EXCLUDED.last_hour
      WHERE mcp_call_log_retention_state.last_hour < EXCLUDED.last_hour
      RETURNING singleton
    ), expired AS MATERIALIZED (
      SELECT call.id
      FROM mcp_call_log AS call
      WHERE EXISTS (SELECT 1 FROM claimed)
        AND call.at < $2::timestamptz
      ORDER BY call.at, call.id
      LIMIT $3
      FOR UPDATE OF call SKIP LOCKED
    ), deleted AS (
      DELETE FROM mcp_call_log AS call
      USING expired
      WHERE call.id = expired.id
      RETURNING call.id
    )
    SELECT
      EXISTS (SELECT 1 FROM claimed) AS ran,
      count(deleted.id)::integer AS deleted
    FROM deleted
  `, [now.toISOString(), cutoff.toISOString(), MCP_CALL_LOG_RETENTION_PAGE_LIMIT])

  const ran = rows[0]?.ran
  const deleted = Number(rows[0]?.deleted ?? Number.NaN)
  if (
    typeof ran !== 'boolean'
    || !Number.isSafeInteger(deleted)
    || deleted < 0
    || deleted > MCP_CALL_LOG_RETENTION_PAGE_LIMIT
    || (!ran && deleted !== 0)
  ) {
    throw new Error('mcp call log hourly retention returned an invalid result')
  }
  return Object.freeze({ ran, deleted })
}

export type McpCallLogQuery = Readonly<{
  since: Date | null
  until: Date | null
  beforeId: number | null
  limit: number
}>

const QUERY_NAMES: readonly string[] = ['since', 'until', 'before_id', 'limit']
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/u

function wholeNumber(value: string, maximum: number): number | null {
  if (!/^[0-9]{1,16}$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null
}

function instant(value: string): Date | null {
  if (!ISO_INSTANT.test(value)) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

type QueryValues = Record<string, readonly string[] | undefined>

/** Parse the founder read's query; every refusal names the option and the fix. */
export function parseMcpCallLogQuery(
  query: QueryValues,
): { ok: true; value: McpCallLogQuery } | { ok: false; error: string } {
  const unsupported = Object.keys(query).filter(name => !QUERY_NAMES.includes(name)).sort()
  if (unsupported.length > 0) {
    const shown = unsupported.slice(0, 3).map(name => name.slice(0, 40)).join(', ')
    return {
      ok: false,
      error: `unsupported query option: ${shown}; use only since, until, before_id and limit`,
    }
  }
  const single: Record<string, string | null> = {}
  for (const name of QUERY_NAMES) {
    const values = query[name]
    if (values && values.length > 1) return { ok: false, error: `${name} must appear at most once` }
    single[name] = values?.[0] ?? null
  }

  const beforeId = single.before_id == null ? null : wholeNumber(single.before_id, Number.MAX_SAFE_INTEGER)
  if (single.before_id != null && beforeId === null) {
    return { ok: false, error: 'before_id must be a positive whole call id from next_before_id' }
  }
  const limit = single.limit == null
    ? MCP_CALL_LOG_PAGE_DEFAULT
    : wholeNumber(single.limit, MCP_CALL_LOG_PAGE_MAX)
  if (limit === null) {
    return { ok: false, error: `limit must be a whole number from 1 to ${MCP_CALL_LOG_PAGE_MAX}` }
  }
  const since = single.since == null ? null : instant(single.since)
  if (single.since != null && since === null) {
    return { ok: false, error: 'since must be an ISO 8601 time with a time zone, such as 2026-10-09T12:00:00Z' }
  }
  const until = single.until == null ? null : instant(single.until)
  if (single.until != null && until === null) {
    return { ok: false, error: 'until must be an ISO 8601 time with a time zone, such as 2026-10-09T13:00:00Z' }
  }
  if (since && until) {
    const span = until.getTime() - since.getTime()
    if (span <= 0 || span > MCP_CALL_LOG_WINDOW_MAX_DAYS * DAY_MS) {
      return {
        ok: false,
        error: `until must be later than since and at most ${MCP_CALL_LOG_WINDOW_MAX_DAYS} days after it`,
      }
    }
  }
  return { ok: true, value: Object.freeze({ since, until, beforeId, limit }) }
}

export type McpCallLogEntry = Readonly<{
  id: number
  at: string
  door: McpCallDoor
  tool: string
  client_family: McpClientFamily
  request_id: string
  outcome: McpCallOutcome
  refusal_class: McpCallRefusalClass | null
  http_status: number | null
  latency_ms: number
}>

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('mcp call log row is outside the reviewed shape')
  return parsed
}

function entryFromRow(row: Record<string, unknown>): McpCallLogEntry {
  const at = row.at instanceof Date ? row.at : new Date(String(row.at))
  const entry = {
    id: Number(row.id),
    at: Number.isFinite(at.getTime()) ? at.toISOString() : '',
    door: row.door,
    tool: row.tool,
    client_family: row.client_family,
    request_id: String(row.request_id ?? ''),
    outcome: row.outcome,
    refusal_class: row.refusal_class ?? null,
    http_status: nullableInteger(row.http_status),
    latency_ms: Number(row.latency_ms),
  } as McpCallLogEntry
  if (!Number.isSafeInteger(entry.id) || entry.id < 1 || entry.at === '' || !validRow({
    door: entry.door,
    tool: entry.tool,
    clientFamily: entry.client_family,
    requestId: entry.request_id,
    outcome: entry.outcome,
    refusalClass: entry.refusal_class,
    httpStatus: entry.http_status,
    latencyMs: entry.latency_ms,
  })) {
    throw new Error('mcp call log row is outside the reviewed shape')
  }
  return Object.freeze(entry)
}

/** One page, newest id first, with one extra row fetched to learn whether more exist. */
export async function readMcpCallLog(
  database: McpCallLogDatabase,
  query: McpCallLogQuery,
): Promise<Readonly<{ calls: readonly McpCallLogEntry[]; hasMore: boolean; nextBeforeId: number | null }>> {
  const conditions: string[] = []
  const params: unknown[] = []
  const add = (sql: string, value: unknown) => {
    params.push(value)
    conditions.push(sql.replace('?', `$${params.length}`))
  }
  if (query.beforeId !== null) add('id < ?::bigint', query.beforeId)
  if (query.since !== null) add('at >= ?::timestamptz', query.since.toISOString())
  if (query.until !== null) add('at < ?::timestamptz', query.until.toISOString())
  params.push(query.limit + 1)
  const rows = await database.query(`
    /* founder:mcp-call-log */
    SELECT id, at, door, tool, client_family, request_id,
      outcome, refusal_class, http_status, latency_ms
    FROM mcp_call_log
    ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY id DESC
    LIMIT $${params.length}
  `, params)
  const entries = rows.map(entryFromRow)
  const hasMore = entries.length > query.limit
  const calls = Object.freeze(hasMore ? entries.slice(0, query.limit) : entries)
  return Object.freeze({
    calls,
    hasMore,
    nextBeforeId: hasMore ? calls.at(-1)?.id ?? null : null,
  })
}
