import {
  allowedPublicQuery,
  singlePublicQueryValue,
  type PublicQueryExecutor,
} from './public-pagination.ts'
import { HANDLE_RE } from './core.ts'
import {
  PUBLIC_EVENT_DETAIL_ID_FIELDS,
  PUBLIC_EVENT_DETAIL_SCALAR_FIELDS,
  PUBLIC_EVENT_KINDS,
} from './public-events.ts'

const PUBLIC_CHANGE_PAGE_DEFAULT = 10
export const PUBLIC_CHANGE_PAGE_MAX = 200
const MAX_BIGINT = 9_223_372_036_854_775_807n

export interface PublicChangeQuery {
  readonly ok: true
  readonly since: string | null
  readonly kind: string | null
  readonly limit: number
  readonly fetchLimit: number
}

export type PublicChangeQueryResult = PublicChangeQuery | Readonly<{
  ok: false
  error: string
}>

export class PublicChangeFutureError extends Error {
  constructor(since: string, checkpoint: string) {
    super(`since marker ${since} is ahead of checkpoint ${checkpoint}`)
    this.name = 'PublicChangeFutureError'
  }
}

export function parsePublicChangeMarker(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length > 19
    || !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) return null
  try {
    const parsed = BigInt(value)
    return parsed <= MAX_BIGINT ? parsed.toString() : null
  } catch {
    return null
  }
}

const PUBLIC_CHANGE_KIND_SET: ReadonlySet<string> = new Set(PUBLIC_EVENT_KINDS)

export function parsePublicChangeQuery(
  query: Readonly<Record<string, readonly string[]>>,
): PublicChangeQueryResult {
  const allowed = allowedPublicQuery(query, ['since', 'kind', 'limit'])
  if (!allowed.ok) return allowed

  const sinceValue = singlePublicQueryValue(query, 'since')
  if (!sinceValue.ok) return sinceValue
  const since = sinceValue.value === null ? null : parsePublicChangeMarker(sinceValue.value)
  if (sinceValue.value !== null && since === null) {
    return { ok: false, error: 'since must be a nonnegative decimal bigint' }
  }

  const kindValue = singlePublicQueryValue(query, 'kind')
  if (!kindValue.ok) return kindValue
  const kind = kindValue.value
  if (kind !== null && !PUBLIC_CHANGE_KIND_SET.has(kind)) {
    return { ok: false, error: 'kind must be one of the public event kinds' }
  }

  const limitValue = singlePublicQueryValue(query, 'limit')
  if (!limitValue.ok) return limitValue
  if (limitValue.value !== null && !/^[1-9][0-9]{0,2}$/u.test(limitValue.value)) {
    return { ok: false, error: `limit must be between 1 and ${PUBLIC_CHANGE_PAGE_MAX}` }
  }
  const limit = limitValue.value === null ? PUBLIC_CHANGE_PAGE_DEFAULT : Number(limitValue.value)
  if (limit > PUBLIC_CHANGE_PAGE_MAX) {
    return { ok: false, error: `limit must be between 1 and ${PUBLIC_CHANGE_PAGE_MAX}` }
  }

  return Object.freeze({ ok: true, since, kind, limit, fetchLimit: limit + 1 })
}

const CHECKPOINT_SQL = `
  /* public:changes-checkpoint */
  SELECT current_change_id::text AS checkpoint
  FROM public_change_state
  WHERE singleton = true
`

const PUBLIC_CHANGE_DETAIL_FIELDS = Object.freeze([
  ...PUBLIC_EVENT_DETAIL_ID_FIELDS,
  ...PUBLIC_EVENT_DETAIL_SCALAR_FIELDS,
])
const PUBLIC_CHANGE_DETAIL_FIELD_SQL = PUBLIC_CHANGE_DETAIL_FIELDS
  .map(field => `'${field}'`)
  .join(', ')
const CHANGES_SQL = `
  /* public:changes */
  WITH checkpoint AS MATERIALIZED (
    SELECT current_change_id, current_change_id::text AS checkpoint
    FROM public_change_state
    WHERE singleton = true
  )
  SELECT checkpoint.checkpoint,
    page.change_id, page.kind, page.actor, page.detail, page.created_at
  FROM checkpoint
  LEFT JOIN LATERAL (
    SELECT pcl.change_id::text AS change_id,
      e.kind, e.actor,
      coalesce((
        SELECT jsonb_object_agg(field.key, field.value)
        FROM jsonb_each(e.detail) field
        WHERE field.key = ANY(ARRAY[${PUBLIC_CHANGE_DETAIL_FIELD_SQL}]::text[])
          AND jsonb_typeof(field.value) IN ('null', 'string', 'number', 'boolean')
      ), '{}'::jsonb) AS detail,
      e.at AS created_at
    FROM public_change_log pcl
    JOIN events e ON e.id = pcl.event_id
    WHERE pcl.change_id > $1::bigint
      AND pcl.change_id <= checkpoint.current_change_id
      AND ($3::text IS NULL OR e.kind = $3::text)
    ORDER BY pcl.change_id ASC
    LIMIT $2::integer
  ) page ON true
  ORDER BY page.change_id::bigint ASC NULLS LAST
`

function checkpointFrom(rows: readonly Record<string, unknown>[]): string {
  const checkpoint = parsePublicChangeMarker(String(rows[0]?.checkpoint ?? ''))
  if (checkpoint === null) throw new Error('public change checkpoint is unavailable')
  return checkpoint
}

const CHANGE_REFERENCE_FIELDS: ReadonlySet<string> = new Set(PUBLIC_CHANGE_DETAIL_FIELDS)

function changeReferenceDetail(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({})
  }
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([key, nested]) => {
    return CHANGE_REFERENCE_FIELDS.has(key) && (
      nested === null || typeof nested === 'string' || typeof nested === 'number'
      || typeof nested === 'boolean'
    )
  })))
}

function publicChange(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null {
  const changeId = parsePublicChangeMarker(row.change_id == null ? null : String(row.change_id))
  if (changeId === null) return null
  if (typeof row.kind !== 'string' || !PUBLIC_CHANGE_KIND_SET.has(row.kind)) return null
  if (typeof row.actor !== 'string' || !HANDLE_RE.test(row.actor)) return null
  return Object.freeze({
    change_id: changeId,
    kind: row.kind,
    actor: row.actor,
    detail: changeReferenceDetail(row.detail),
    created_at: row.created_at,
  })
}

export async function loadPublicChanges(
  execute: PublicQueryExecutor,
  query: PublicChangeQuery,
): Promise<Readonly<Record<string, unknown>>> {
  if (query.since === null) {
    const rows = await execute(CHECKPOINT_SQL, [])
    return Object.freeze({ change_marker: checkpointFrom(rows) })
  }

  const rows = await execute(CHANGES_SQL, [query.since, query.fetchLimit, query.kind])
  const checkpoint = checkpointFrom(rows)
  if (BigInt(query.since) > BigInt(checkpoint)) {
    throw new PublicChangeFutureError(query.since, checkpoint)
  }

  const fetchedRows = rows.flatMap(row => {
    if (row.change_id == null) return []
    const changeId = parsePublicChangeMarker(String(row.change_id))
    if (changeId === null) throw new Error('public change id is invalid')
    return [Object.freeze({ row, changeId })]
  })
  const hasMore = fetchedRows.length > query.limit
  const pageRows = fetchedRows.slice(0, query.limit)
  const changes = Object.freeze(pageRows.flatMap(({ row }) => {
    const change = publicChange(row)
    return change === null ? [] : [change]
  }))
  const nextSince = hasMore ? pageRows.at(-1)?.changeId ?? query.since : checkpoint
  return Object.freeze({
    change_marker: checkpoint,
    changes,
    returned_items: changes.length,
    unchanged: BigInt(checkpoint) === BigInt(query.since),
    has_more: hasMore,
    next_since: nextSince,
  })
}

export async function loadPublicChangeCheckpoint(
  execute: PublicQueryExecutor,
): Promise<string> {
  const rows = await execute(CHECKPOINT_SQL, [])
  return checkpointFrom(rows)
}
