export const PUBLIC_PAGE_DEFAULT = 10
export const PUBLIC_PAGE_MAX = 200
const POSTGRES_INTEGER_MAX = 2_147_483_647

type QueryValues = Record<string, readonly string[] | undefined>

export function allowedPublicQuery(
  query: QueryValues,
  allowedNames: readonly string[],
): { ok: true } | PublicPageError {
  const allowed = new Set(allowedNames)
  const unsupported = Object.keys(query).filter(name => !allowed.has(name)).sort()
  if (unsupported.length === 0) return { ok: true }
  const shown = unsupported.slice(0, 3).map(name => (
    name.length <= 64 ? name : `${name.slice(0, 64)}…`
  )).join(', ')
  return {
    ok: false,
    error: `unsupported query option${unsupported.length === 1 ? '' : 's'}: ${shown}`,
  }
}

export function utf8TextBytes(
  rows: readonly object[],
  field: string,
): number {
  return rows.reduce((total, row) => {
    const value = (row as Record<string, unknown>)[field]
    return total + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0)
  }, 0)
}

export function eventDetailTextBytes(rows: readonly object[]): number {
  return rows.reduce((total, row) => {
    const detail = (row as { readonly detail?: unknown }).detail
    if (detail == null || typeof detail !== 'object' || Array.isArray(detail)) return total
    return total + ['body', 'description', 'reason'].reduce((subtotal, field) => {
      const value = (detail as Record<string, unknown>)[field]
      return subtotal + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0)
    }, 0)
  }, 0)
}

export interface PublicPage {
  readonly ok: true
  readonly cursor: number | null
  readonly limit: number
  readonly fetchLimit: number
}

interface PublicPageError {
  readonly ok: false
  readonly error: string
}

export function singlePublicQueryValue(
  query: QueryValues,
  name: string,
): { ok: true; value: string | null } | PublicPageError {
  const values = query[name]
  if (!values || values.length === 0) return { ok: true, value: null }
  if (values.length !== 1) return { ok: false, error: `${name} must appear at most once` }
  return { ok: true, value: values[0] ?? null }
}

function positiveInteger(value: string | null, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (value == null || !/^[0-9]+$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null
}

export function parsePublicPage(
  query: QueryValues,
  cursorName: string,
  limitName: string,
  commonLimitName?: string,
  defaultLimit = PUBLIC_PAGE_DEFAULT,
): PublicPage | PublicPageError {
  const cursorValue = singlePublicQueryValue(query, cursorName)
  if (!cursorValue.ok) return cursorValue
  const limitValue = singlePublicQueryValue(query, limitName)
  if (!limitValue.ok) return limitValue
  const commonLimitValue = commonLimitName == null
    ? { ok: true as const, value: null }
    : singlePublicQueryValue(query, commonLimitName)
  if (!commonLimitValue.ok) return commonLimitValue
  const commonLimit = commonLimitValue.value == null
    ? null
    : positiveInteger(commonLimitValue.value)
  if (commonLimitValue.value != null && (commonLimit == null || commonLimit > PUBLIC_PAGE_MAX)) {
    return {
      ok: false,
      error: `${commonLimitName ?? limitName} must be between 1 and ${PUBLIC_PAGE_MAX}`,
    }
  }

  const cursor = cursorValue.value == null
    ? null
    : positiveInteger(cursorValue.value, POSTGRES_INTEGER_MAX)
  if (cursorValue.value != null && cursor == null) {
    return { ok: false, error: `${cursorName} must be a positive integer` }
  }

  const limit = limitValue.value == null
    ? commonLimit ?? defaultLimit
    : positiveInteger(limitValue.value)
  if (limit == null || !Number.isSafeInteger(limit) || limit <= 0 || limit > PUBLIC_PAGE_MAX) {
    return { ok: false, error: `${limitName} must be between 1 and ${PUBLIC_PAGE_MAX}` }
  }

  return {
    ok: true,
    cursor,
    limit,
    fetchLimit: limit + 1,
  }
}

export function queryValues(searchParams: URLSearchParams): Record<string, string[]> {
  return Object.fromEntries(
    [...new Set(searchParams.keys())].map(name => [name, searchParams.getAll(name)]),
  )
}

export function finalizePublicPage<T extends { readonly id: number }>(
  rows: readonly T[],
  limit: number,
): Readonly<{
  items: readonly T[]
  hasMore: boolean
  nextCursor: number | null
}> {
  const hasMore = rows.length > limit
  const items = Object.freeze((hasMore ? rows.slice(0, limit) : [...rows]) as T[])
  return Object.freeze({
    items,
    hasMore,
    nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
  })
}

export type PublicQueryExecutor = (
  text: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>

export interface PublicEventFilters {
  readonly kind: string | null
  readonly actor: string | null
  readonly placeId: number | null
}

const PUBLIC_EVENT_FILTER = `
  ($1::text IS NULL OR event.kind = $1::text)
  AND ($2::text IS NULL OR event.actor = $2::text)
  AND ($3::integer IS NULL
    OR event.detail->>'place_id' = ($3::integer)::text
    OR (event.detail->>'thing_id' ~ '^[0-9]{1,9}$' AND EXISTS (
      SELECT 1 FROM things thing
      WHERE thing.id = (event.detail->>'thing_id')::integer
        AND thing.place_id = $3::integer AND thing.withdrawn_at IS NULL))
    OR (event.detail->>'note_id' ~ '^[0-9]{1,9}$' AND EXISTS (
      SELECT 1 FROM notes note
      WHERE note.id = (event.detail->>'note_id')::integer
        AND note.place_id = $3::integer))
    OR (event.detail->>'asset_type' = 'place' AND event.detail->>'asset_id' = ($3::integer)::text)
    OR (event.detail->>'asset_type' = 'thing'
      AND event.detail->>'asset_id' ~ '^[0-9]{1,9}$' AND EXISTS (
      SELECT 1 FROM things thing
      WHERE thing.id = (event.detail->>'asset_id')::integer
        AND thing.place_id = $3::integer AND thing.withdrawn_at IS NULL))
    OR (event.detail->>'type' = 'place' AND event.detail->>'id' = ($3::integer)::text)
    OR (event.detail->>'type' = 'thing'
      AND event.detail->>'id' ~ '^[0-9]{1,9}$' AND EXISTS (
      SELECT 1 FROM things thing
      WHERE thing.id = (event.detail->>'id')::integer
        AND thing.place_id = $3::integer AND thing.withdrawn_at IS NULL))
    OR (event.detail->>'offer_id' ~ '^[0-9]{1,9}$' AND EXISTS (
      SELECT 1 FROM transfer_offers offer
      WHERE offer.id = (event.detail->>'offer_id')::integer
        AND ((offer.asset_type = 'place' AND offer.asset_id = $3::integer)
          OR (offer.asset_type = 'thing' AND EXISTS (
            SELECT 1 FROM things thing
            WHERE thing.id = offer.asset_id
              AND thing.place_id = $3::integer
              AND thing.withdrawn_at IS NULL))))))`

export interface PublicCollectionRows {
  readonly rows: readonly Record<string, unknown>[]
  readonly total: PublicCollectionTotal
}

export function extractPublicCollectionRows(
  rows: readonly Record<string, unknown>[],
): Readonly<PublicCollectionRows> {
  const first = rows[0]
  if (!first) throw new Error('public collection metadata is unavailable')
  const total = collectionTotal({ items: first.total_items, text_bytes: first.total_text_bytes })
  const items = rows.flatMap(row => {
    if (row.id == null) return []
    const { total_items: _items, total_text_bytes: _bytes, ...item } = row
    return [Object.freeze(item)]
  })
  return Object.freeze({ rows: Object.freeze(items), total })
}

export async function loadPublicEventCollectionRows(
  query: PublicQueryExecutor,
  filters: PublicEventFilters,
  page: PublicPage,
): Promise<Readonly<PublicCollectionRows>> {
  const rows = await query(
    `/* public:events */
     WITH totals AS (
       SELECT count(*)::integer AS total_items,
         coalesce(sum(
           octet_length(coalesce(event.detail->>'body', ''))
           + octet_length(coalesce(event.detail->>'description', ''))
           + octet_length(coalesce(event.detail->>'reason', ''))
         ), 0)::bigint AS total_text_bytes
       FROM events event
       WHERE ${PUBLIC_EVENT_FILTER}
     )
     SELECT page.id, page.at, page.kind, page.actor, page.detail,
       totals.total_items, totals.total_text_bytes
     FROM totals
     LEFT JOIN LATERAL (
       SELECT event.id, event.at, event.kind, event.actor, event.detail
       FROM events event
       WHERE ${PUBLIC_EVENT_FILTER}
         AND ($4::integer IS NULL OR event.id < $4::integer)
       ORDER BY event.id DESC
       LIMIT $5::integer
     ) page ON TRUE
     ORDER BY page.id DESC NULLS LAST`,
    [filters.kind, filters.actor, filters.placeId, page.cursor, page.fetchLimit],
  )
  return extractPublicCollectionRows(rows)
}

export async function loadPublicEventRows(
  query: PublicQueryExecutor,
  filters: PublicEventFilters,
  page: PublicPage,
): Promise<readonly Record<string, unknown>[]> {
  // The place filter matches an event to a place through every detail shape the
  // city writes: the place named directly; a thing or note there now; a traded
  // asset there now (sales and gifts name asset_type/asset_id, effect-driven
  // transfers name type/id, offer events may name only offer_id). Withdrawn
  // things are no longer "there" on any public surface, so they never match.
  // Detail ids are regex-guarded before casting because detail is
  // caller-shaped JSONB.
  return (await loadPublicEventCollectionRows(query, filters, page)).rows
}

export interface PublicPlacePageRequests {
  readonly subplaces: PublicPage
  readonly things: PublicPage
  readonly notes: PublicPage
}

export interface PublicPlaceCollectionRows {
  readonly subplaces: readonly Record<string, unknown>[]
  readonly things: readonly Record<string, unknown>[]
  readonly notes: readonly Record<string, unknown>[]
  readonly totals: Readonly<{
    subplaces: PublicCollectionTotal
    things: PublicCollectionTotal
    notes: PublicCollectionTotal
  }>
}

export interface PublicCollectionTotal {
  readonly items: number
  readonly textBytes: number
}

export function collectionTotal(row: Record<string, unknown> | undefined): PublicCollectionTotal {
  const items = Number(row?.items ?? 0)
  const textBytes = Number(row?.text_bytes ?? 0)
  if (!Number.isSafeInteger(items) || items < 0 || !Number.isSafeInteger(textBytes) || textBytes < 0) {
    throw new Error('public collection totals are invalid')
  }
  return Object.freeze({ items, textBytes })
}

function recordArray(value: unknown, field: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(item => item == null || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error(`${field} public page is invalid`)
  }
  return Object.freeze(value.map(item => {
    const record = { ...(item as Record<string, unknown>) }
    if (typeof record.created_at === 'string') {
      const timestamp = Date.parse(record.created_at)
      if (!Number.isFinite(timestamp)) throw new Error(`${field} public timestamp is invalid`)
      record.created_at = new Date(timestamp).toISOString()
    }
    return Object.freeze(record)
  }))
}

export async function loadPublicPlaceCollectionRows(
  query: PublicQueryExecutor,
  placeId: number,
  pages: PublicPlacePageRequests,
): Promise<Readonly<PublicPlaceCollectionRows>> {
  const rows = await query(
    `/* public:place-collections */
     WITH subplace_page AS MATERIALIZED (
       SELECT p.id, p.parent_id, p.name, p.description, p.owner_id, owner.handle AS owner,
         p.open_to_building, p.open_to_things, p.open_to_notes, p.created_at
       FROM places p
       LEFT JOIN residents owner ON owner.id = p.owner_id
       WHERE p.parent_id = $1::integer
         AND ($2::integer IS NULL OR p.id < $2::integer)
       ORDER BY p.id DESC
       LIMIT $3::integer
     ), thing_page AS MATERIALIZED (
       SELECT t.id, t.place_id, t.name, t.body, t.owner_id, owner.handle AS owner,
         t.open_to_use, t.kind_id, k.name AS kind, t.birth_revision,
         t.current_revision, t.created_at
       FROM things t
       JOIN residents owner ON owner.id = t.owner_id
       LEFT JOIN kinds k ON k.id = t.kind_id
       WHERE t.place_id = $1::integer AND t.withdrawn_at IS NULL
         AND ($4::integer IS NULL OR t.id < $4::integer)
       ORDER BY t.id DESC
       LIMIT $5::integer
     ), note_page AS MATERIALIZED (
       SELECT n.id, n.place_id, author.handle AS author, n.body, n.created_at
       FROM notes n
       JOIN residents author ON author.id = n.author_id
       WHERE n.place_id = $1::integer
         AND ($6::integer IS NULL OR n.id < $6::integer)
       ORDER BY n.id DESC
       LIMIT $7::integer
     )
     SELECT
       (SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.id DESC), '[]'::jsonb)
        FROM subplace_page page) AS subplaces,
       (SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.id DESC), '[]'::jsonb)
        FROM thing_page page) AS things,
       (SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.id DESC), '[]'::jsonb)
        FROM note_page page) AS notes,
       totals.subplace_items, totals.subplace_text_bytes,
       totals.thing_items, totals.thing_text_bytes,
       totals.note_items, totals.note_text_bytes
     FROM place_reading_totals totals
     WHERE totals.place_id = $1::integer`,
    [
      placeId,
      pages.subplaces.cursor,
      pages.subplaces.fetchLimit,
      pages.things.cursor,
      pages.things.fetchLimit,
      pages.notes.cursor,
      pages.notes.fetchLimit,
    ],
  )
  const totals = rows[0]
  if (!totals) throw new Error('public place reading totals are unavailable')
  return Object.freeze({
    subplaces: recordArray(totals.subplaces, 'subplaces'),
    things: recordArray(totals.things, 'things'),
    notes: recordArray(totals.notes, 'notes'),
    totals: Object.freeze({
      subplaces: collectionTotal({ items: totals.subplace_items, text_bytes: totals.subplace_text_bytes }),
      things: collectionTotal({ items: totals.thing_items, text_bytes: totals.thing_text_bytes }),
      notes: collectionTotal({ items: totals.note_items, text_bytes: totals.note_text_bytes }),
    }),
  })
}
