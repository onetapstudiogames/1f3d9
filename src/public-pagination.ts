export const PUBLIC_PAGE_DEFAULT = 10
export const PUBLIC_PAGE_MAX = 200
import { PUBLIC_EVENT_THING_DRAWING_JOIN_SQL } from './public-drawing-presence.ts'

export const PUBLIC_EVENT_WITHIN_MAX_SECONDS = 1_800
const PUBLIC_PLACE_RECORD_TEXT_MAX_BYTES = 65_536
// Coupled to GAZETTE_ENTRY_PAGE_LIMIT; guarded in test/gazette-window-client-budget-shape.test.ts.
export const PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES =
  PUBLIC_PAGE_DEFAULT * PUBLIC_PLACE_RECORD_TEXT_MAX_BYTES
const POSTGRES_INTEGER_MAX = 2_147_483_647

type QueryValues = Record<string, readonly string[] | undefined>

export function allowedPublicQuery(
  query: QueryValues,
  allowedNames: readonly string[],
): { ok: true } | PublicPageError {
  const allowed = new Set(allowedNames)
  const unsupported = Object.keys(query).filter(name => !allowed.has(name)).sort()
  if (unsupported.length === 0) return { ok: true }
  const listed = unsupported.slice(0, 3).map(name => (
    name.length <= 64 ? name : `${name.slice(0, 64)}…`
  )).join(', ')
  const shown = listed.length <= 40 ? listed : `${listed.slice(0, 40)}…`
  return {
    ok: false,
    error: `unsupported query option${unsupported.length === 1 ? '' : 's'}: ${shown}; remove the shown option${unsupported.length === 1 ? '' : 's'} and retry`,
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

export function parsePublicTextLimit(
  query: QueryValues,
  name: string,
): { ok: true; value: number | null } | PublicPageError {
  const raw = singlePublicQueryValue(query, name)
  if (!raw.ok) return raw
  if (raw.value == null) return { ok: true, value: null }
  if (!/^[0-9]+$/u.test(raw.value)) {
    return {
      ok: false,
      error: `${name} must be between 0 and ${PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES}`,
    }
  }
  const value = Number(raw.value)
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES
  ) {
    return {
      ok: false,
      error: `${name} must be between 0 and ${PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES}`,
    }
  }
  return { ok: true, value }
}

export function effectivePublicPlaceTextLimit(
  requestedTextLimit: number | null,
  itemLimit: number,
): number | null {
  if (requestedTextLimit != null) return requestedTextLimit
  return itemLimit > PUBLIC_PAGE_DEFAULT ? PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES : null
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
  readonly includeDescendants?: boolean
  readonly withinSeconds?: number | null
}

function publicEventFilter(includeDescendants: boolean): string {
  const numericPlace = (field: string): string => includeDescendants
    ? `${field} IN (SELECT id FROM selected_places)`
    : `${field} = $3::integer`
  const textPlace = (field: string): string => includeDescendants
    ? `${field} IN (SELECT id::text FROM selected_places)`
    : `${field} = ($3::integer)::text`
  return `
  ($1::text IS NULL OR event.kind = $1::text)
  AND ($2::text IS NULL OR event.actor = $2::text)
  AND ($6::integer IS NULL OR event.at >= transaction_timestamp()
    - ($6::integer * INTERVAL '1 second'))
  AND ($3::integer IS NULL
    OR ${textPlace("event.detail->>'place_id'")}
    OR ${textPlace("event.detail->>'from_place_id'")}
    OR ${textPlace("event.detail->>'to_place_id'")}
    OR (event.detail->>'thing_id' ~ '^[0-9]{1,9}$' AND EXISTS (
      SELECT 1 FROM things thing
      WHERE thing.id = (event.detail->>'thing_id')::integer
        AND ${numericPlace('thing.place_id')} AND thing.withdrawn_at IS NULL))
    OR (event.detail->>'note_id' ~ '^[0-9]{1,9}$' AND EXISTS (
      SELECT 1 FROM notes note
      WHERE note.id = (event.detail->>'note_id')::integer
        AND ${numericPlace('note.place_id')}))
    OR (event.detail->>'asset_type' = 'place' AND ${textPlace("event.detail->>'asset_id'")})
    OR (event.detail->>'asset_type' = 'thing'
      AND event.detail->>'asset_id' ~ '^[0-9]{1,9}$' AND EXISTS (
      SELECT 1 FROM things thing
      WHERE thing.id = (event.detail->>'asset_id')::integer
        AND ${numericPlace('thing.place_id')} AND thing.withdrawn_at IS NULL))
    OR (event.detail->>'type' = 'place' AND ${textPlace("event.detail->>'id'")})
    OR (event.detail->>'type' = 'thing'
      AND event.detail->>'id' ~ '^[0-9]{1,9}$' AND EXISTS (
      SELECT 1 FROM things thing
      WHERE thing.id = (event.detail->>'id')::integer
        AND ${numericPlace('thing.place_id')} AND thing.withdrawn_at IS NULL))
    OR (event.detail->>'offer_id' ~ '^[0-9]{1,9}$' AND EXISTS (
      SELECT 1 FROM transfer_offers offer
      WHERE offer.id = (event.detail->>'offer_id')::integer
        AND ((offer.asset_type = 'place' AND ${numericPlace('offer.asset_id')})
          OR (offer.asset_type = 'thing' AND EXISTS (
            SELECT 1 FROM things thing
            WHERE thing.id = offer.asset_id
              AND ${numericPlace('thing.place_id')}
              AND thing.withdrawn_at IS NULL))))))`
}

const PUBLIC_EVENT_FILTER = publicEventFilter(false)

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
  const includeDescendants = filters.includeDescendants === true
  const eventFilter = includeDescendants ? publicEventFilter(true) : PUBLIC_EVENT_FILTER
  const withClause = includeDescendants
    ? `WITH RECURSIVE selected_places AS (
       SELECT place.id FROM places place WHERE place.id = $3::integer
       UNION
       SELECT child.id FROM places child
       JOIN selected_places selected ON child.parent_id = selected.id
     ), totals AS (`
    : 'WITH totals AS ('
  const rows = await query(
    `/* public:events */
     ${withClause}
       SELECT count(*)::integer AS total_items,
         coalesce(sum(
           octet_length(coalesce(event.detail->>'body', ''))
           + octet_length(coalesce(event.detail->>'description', ''))
           + octet_length(coalesce(event.detail->>'reason', ''))
         ), 0)::bigint AS total_text_bytes
       FROM events event
       WHERE ${eventFilter}
     )
     SELECT page.id, page.change_id, page.at, page.kind, page.actor, page.detail,
       page.thing_has_drawing,
       totals.total_items, totals.total_text_bytes
     FROM totals
     LEFT JOIN LATERAL (
       SELECT event.id, change.change_id::text AS change_id,
         event.at, event.kind, event.actor, event.detail,
         event_thing.has_drawing AS thing_has_drawing
       FROM events event
       ${PUBLIC_EVENT_THING_DRAWING_JOIN_SQL}
       JOIN public_change_log change ON change.event_id = event.id
       WHERE ${eventFilter}
         AND ($4::integer IS NULL OR event.id < $4::integer)
       ORDER BY event.id DESC
       LIMIT $5::integer
     ) page ON TRUE
     ORDER BY page.id DESC NULLS LAST`,
    [
      filters.kind, filters.actor, filters.placeId, page.cursor, page.fetchLimit,
      filters.withinSeconds ?? null,
    ],
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

export interface PublicPlaceTextLimits {
  readonly subplaces: number | null
  readonly things: number | null
  readonly notes: number | null
}

export interface PublicPlacePageState {
  readonly returnedTextBytes: number
  readonly hasMore: boolean
  readonly nextCursor: number | null
  readonly stoppedForTextLimit: boolean
  readonly nextItemId: number | null
  readonly nextItemTextBytes: number | null
}

export interface PublicPlacePageStates {
  readonly subplaces: PublicPlacePageState
  readonly things: PublicPlacePageState
  readonly notes: PublicPlacePageState
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
  readonly pages: PublicPlacePageStates | null
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

function nullableSafeInteger(value: unknown, field: string): number | null {
  if (value == null) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} was rejected because it must be a non-negative safe integer; retry with zero or a positive whole number`)
  }
  return parsed
}

function budgetedPageState(
  row: Record<string, unknown>,
  prefix: 'subplace' | 'thing' | 'note',
): PublicPlacePageState {
  const returnedTextBytes = nullableSafeInteger(row[`${prefix}_returned_text_bytes`], `${prefix} returned text bytes`)
  const nextCursor = nullableSafeInteger(row[`${prefix}_next_cursor`], `${prefix} next cursor`)
  const nextItemId = nullableSafeInteger(row[`${prefix}_next_item_id`], `${prefix} next item id`)
  const nextItemTextBytes = nullableSafeInteger(
    row[`${prefix}_next_item_text_bytes`],
    `${prefix} next item text bytes`,
  )
  if (returnedTextBytes == null) throw new Error(`${prefix} returned text bytes are unavailable`)
  if (typeof row[`${prefix}_has_more`] !== 'boolean') throw new Error(`${prefix} has_more is invalid`)
  if (typeof row[`${prefix}_stopped_for_text_limit`] !== 'boolean') {
    throw new Error(`${prefix} text-limit state is invalid`)
  }
  return Object.freeze({
    returnedTextBytes,
    hasMore: row[`${prefix}_has_more`] as boolean,
    nextCursor,
    stoppedForTextLimit: row[`${prefix}_stopped_for_text_limit`] as boolean,
    nextItemId,
    nextItemTextBytes,
  })
}

async function loadBudgetedPublicPlaceCollectionRows(
  query: PublicQueryExecutor,
  placeId: number,
  pages: PublicPlacePageRequests,
  textLimits: PublicPlaceTextLimits,
): Promise<Readonly<PublicPlaceCollectionRows>> {
  const rows = await query(
    `/* public:place-collections-budgeted */
     WITH subplace_source AS MATERIALIZED (
       SELECT p.id, p.parent_id, p.name, p.description, p.purpose,
         p.owner_id, owner.handle AS owner,
         p.open_to_building, p.open_to_things, p.open_to_notes, p.quiet, p.created_at,
         (octet_length(p.description) + octet_length(p.purpose))::integer AS __text_bytes
       FROM places p
       LEFT JOIN residents owner ON owner.id = p.owner_id
       WHERE p.parent_id = $1::integer
         AND p.retired_at IS NULL
         AND ($2::integer IS NULL OR p.id < $2::integer)
       ORDER BY p.id DESC
       LIMIT $3::integer
     ), subplace_candidates AS MATERIALIZED (
       SELECT source.*,
         (row_number() OVER (ORDER BY source.id DESC))::integer AS __ordinal,
         (sum(source.__text_bytes) OVER (
           ORDER BY source.id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ))::bigint AS __cumulative_text_bytes
       FROM subplace_source source
     ), subplace_page AS MATERIALIZED (
       SELECT * FROM subplace_candidates
       WHERE __ordinal < $3::integer
         AND ($8::bigint IS NULL OR __cumulative_text_bytes <= $8::bigint)
     ), thing_source AS MATERIALIZED (
       SELECT t.id, t.place_id, t.name, t.body,
         t.maker_id, maker.handle AS made_by,
         t.owner_id AS current_owner_id, owner.handle AS current_owner,
         t.owner_id, owner.handle AS owner,
         t.open_to_use, t.kind_id, k.name AS kind, t.birth_revision,
         t.current_revision, t.created_at,
         octet_length(t.body)::integer AS __text_bytes
       FROM things t
       JOIN residents maker ON maker.id = t.maker_id
       JOIN residents owner ON owner.id = t.owner_id
       LEFT JOIN kinds k ON k.id = t.kind_id
       WHERE t.place_id = $1::integer AND t.withdrawn_at IS NULL
         AND ($4::integer IS NULL OR t.id < $4::integer)
       ORDER BY t.id DESC
       LIMIT $5::integer
     ), thing_candidates AS MATERIALIZED (
       SELECT source.*,
         (row_number() OVER (ORDER BY source.id DESC))::integer AS __ordinal,
         (sum(source.__text_bytes) OVER (
           ORDER BY source.id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ))::bigint AS __cumulative_text_bytes
       FROM thing_source source
     ), thing_page AS MATERIALIZED (
       SELECT * FROM thing_candidates
       WHERE __ordinal < $5::integer
         AND ($9::bigint IS NULL OR __cumulative_text_bytes <= $9::bigint)
     ), note_source AS MATERIALIZED (
       SELECT n.id, n.place_id, author.handle AS author, n.body, n.created_at,
         octet_length(n.body)::integer AS __text_bytes
       FROM notes n
       JOIN residents author ON author.id = n.author_id
       WHERE n.place_id = $1::integer
         AND ($6::integer IS NULL OR n.id < $6::integer)
       ORDER BY n.id DESC
       LIMIT $7::integer
     ), note_candidates AS MATERIALIZED (
       SELECT source.*,
         (row_number() OVER (ORDER BY source.id DESC))::integer AS __ordinal,
         (sum(source.__text_bytes) OVER (
           ORDER BY source.id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ))::bigint AS __cumulative_text_bytes
       FROM note_source source
     ), note_page AS MATERIALIZED (
       SELECT * FROM note_candidates
       WHERE __ordinal < $7::integer
         AND ($10::bigint IS NULL OR __cumulative_text_bytes <= $10::bigint)
     )
     SELECT
       (SELECT coalesce(jsonb_agg(
          to_jsonb(page) - '__text_bytes' - '__ordinal' - '__cumulative_text_bytes'
          ORDER BY page.id DESC
        ), '[]'::jsonb) FROM subplace_page page) AS subplaces,
       (SELECT coalesce(jsonb_agg(
          to_jsonb(page) - '__text_bytes' - '__ordinal' - '__cumulative_text_bytes'
          ORDER BY page.id DESC
        ), '[]'::jsonb) FROM thing_page page) AS things,
       (SELECT coalesce(jsonb_agg(
          to_jsonb(page) - '__text_bytes' - '__ordinal' - '__cumulative_text_bytes'
          ORDER BY page.id DESC
        ), '[]'::jsonb) FROM note_page page) AS notes,
       totals.subplace_items, totals.subplace_text_bytes,
       totals.thing_items, totals.thing_text_bytes,
       totals.note_items, totals.note_text_bytes,
       (SELECT coalesce(sum(__text_bytes), 0)::bigint FROM subplace_page) AS subplace_returned_text_bytes,
       (SELECT count(*) FROM subplace_candidates) > (SELECT count(*) FROM subplace_page) AS subplace_has_more,
       CASE WHEN (SELECT count(*) FROM subplace_candidates) > (SELECT count(*) FROM subplace_page)
         THEN (SELECT id FROM subplace_page ORDER BY __ordinal DESC LIMIT 1) END AS subplace_next_cursor,
       EXISTS (
         SELECT 1 FROM subplace_candidates
         WHERE __ordinal < $3::integer AND $8::bigint IS NOT NULL
           AND __cumulative_text_bytes > $8::bigint
       ) AS subplace_stopped_for_text_limit,
       (SELECT id FROM subplace_candidates
        WHERE __ordinal < $3::integer AND $8::bigint IS NOT NULL
          AND __cumulative_text_bytes > $8::bigint
        ORDER BY __ordinal LIMIT 1) AS subplace_next_item_id,
       (SELECT __text_bytes FROM subplace_candidates
        WHERE __ordinal < $3::integer AND $8::bigint IS NOT NULL
          AND __cumulative_text_bytes > $8::bigint
        ORDER BY __ordinal LIMIT 1) AS subplace_next_item_text_bytes,
       (SELECT coalesce(sum(__text_bytes), 0)::bigint FROM thing_page) AS thing_returned_text_bytes,
       (SELECT count(*) FROM thing_candidates) > (SELECT count(*) FROM thing_page) AS thing_has_more,
       CASE WHEN (SELECT count(*) FROM thing_candidates) > (SELECT count(*) FROM thing_page)
         THEN (SELECT id FROM thing_page ORDER BY __ordinal DESC LIMIT 1) END AS thing_next_cursor,
       EXISTS (
         SELECT 1 FROM thing_candidates
         WHERE __ordinal < $5::integer AND $9::bigint IS NOT NULL
           AND __cumulative_text_bytes > $9::bigint
       ) AS thing_stopped_for_text_limit,
       (SELECT id FROM thing_candidates
        WHERE __ordinal < $5::integer AND $9::bigint IS NOT NULL
          AND __cumulative_text_bytes > $9::bigint
        ORDER BY __ordinal LIMIT 1) AS thing_next_item_id,
       (SELECT __text_bytes FROM thing_candidates
        WHERE __ordinal < $5::integer AND $9::bigint IS NOT NULL
          AND __cumulative_text_bytes > $9::bigint
        ORDER BY __ordinal LIMIT 1) AS thing_next_item_text_bytes,
       (SELECT coalesce(sum(__text_bytes), 0)::bigint FROM note_page) AS note_returned_text_bytes,
       (SELECT count(*) FROM note_candidates) > (SELECT count(*) FROM note_page) AS note_has_more,
       CASE WHEN (SELECT count(*) FROM note_candidates) > (SELECT count(*) FROM note_page)
         THEN (SELECT id FROM note_page ORDER BY __ordinal DESC LIMIT 1) END AS note_next_cursor,
       EXISTS (
         SELECT 1 FROM note_candidates
         WHERE __ordinal < $7::integer AND $10::bigint IS NOT NULL
           AND __cumulative_text_bytes > $10::bigint
       ) AS note_stopped_for_text_limit,
       (SELECT id FROM note_candidates
        WHERE __ordinal < $7::integer AND $10::bigint IS NOT NULL
          AND __cumulative_text_bytes > $10::bigint
        ORDER BY __ordinal LIMIT 1) AS note_next_item_id,
       (SELECT __text_bytes FROM note_candidates
        WHERE __ordinal < $7::integer AND $10::bigint IS NOT NULL
          AND __cumulative_text_bytes > $10::bigint
        ORDER BY __ordinal LIMIT 1) AS note_next_item_text_bytes
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
      textLimits.subplaces,
      textLimits.things,
      textLimits.notes,
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
    pages: Object.freeze({
      subplaces: budgetedPageState(totals, 'subplace'),
      things: budgetedPageState(totals, 'thing'),
      notes: budgetedPageState(totals, 'note'),
    }),
  })
}

export async function loadPublicPlaceCollectionRows(
  query: PublicQueryExecutor,
  placeId: number,
  pages: PublicPlacePageRequests,
  includeCollectionText = true,
  textLimits: PublicPlaceTextLimits = Object.freeze({
    subplaces: null,
    things: null,
    notes: null,
  }),
): Promise<Readonly<PublicPlaceCollectionRows>> {
  const hasTextLimit = Object.values(textLimits).some(value => value != null)
  if (!includeCollectionText && hasTextLimit) {
    throw new Error('text limits require full place collection text')
  }
  if (hasTextLimit) {
    return loadBudgetedPublicPlaceCollectionRows(query, placeId, pages, textLimits)
  }
  const subplaceTextProjection = includeCollectionText
    ? 'p.description,'
    : 'octet_length(p.description)::integer AS description_text_bytes,'
  const thingTextProjection = includeCollectionText
    ? 't.body,'
    : 'octet_length(t.body)::integer AS body_text_bytes,'
  const noteTextProjection = includeCollectionText
    ? 'n.body,'
    : 'octet_length(n.body)::integer AS body_text_bytes,'
  const rows = await query(
    `/* public:place-collections */
     WITH subplace_page AS MATERIALIZED (
       SELECT p.id, p.parent_id, p.name, ${subplaceTextProjection} p.purpose,
         p.owner_id, owner.handle AS owner,
         p.open_to_building, p.open_to_things, p.open_to_notes, p.quiet, p.created_at
       FROM places p
       LEFT JOIN residents owner ON owner.id = p.owner_id
       WHERE p.parent_id = $1::integer
         AND p.retired_at IS NULL
         AND ($2::integer IS NULL OR p.id < $2::integer)
       ORDER BY p.id DESC
       LIMIT $3::integer
     ), thing_page AS MATERIALIZED (
       SELECT t.id, t.place_id, t.name, ${thingTextProjection}
         t.maker_id, maker.handle AS made_by,
         t.owner_id AS current_owner_id, owner.handle AS current_owner,
         t.owner_id, owner.handle AS owner,
         t.open_to_use, t.kind_id, k.name AS kind, t.birth_revision,
         t.current_revision, t.created_at
       FROM things t
       JOIN residents maker ON maker.id = t.maker_id
       JOIN residents owner ON owner.id = t.owner_id
       LEFT JOIN kinds k ON k.id = t.kind_id
       WHERE t.place_id = $1::integer AND t.withdrawn_at IS NULL
         AND ($4::integer IS NULL OR t.id < $4::integer)
       ORDER BY t.id DESC
       LIMIT $5::integer
     ), note_page AS MATERIALIZED (
       SELECT n.id, n.place_id, author.handle AS author, ${noteTextProjection} n.created_at
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
    pages: null,
  })
}
