export const PUBLIC_PAGE_DEFAULT = 10
export const PUBLIC_PAGE_MAX = 200
const POSTGRES_INTEGER_MAX = 2_147_483_647

type QueryValues = Record<string, readonly string[] | undefined>

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

export async function loadPublicEventRows(
  query: PublicQueryExecutor,
  filters: PublicEventFilters,
  page: PublicPage,
): Promise<readonly Record<string, unknown>[]> {
  // The place filter matches an event to a place three ways: the event names the
  // place itself, or it names a thing or note that lives there now. Detail ids
  // are regex-guarded before casting because detail is caller-shaped JSONB.
  return query(
    `SELECT id, at, kind, actor, detail
     FROM events
     WHERE ($1::text IS NULL OR kind = $1::text)
       AND ($2::text IS NULL OR actor = $2::text)
       AND ($3::integer IS NULL
         OR detail->>'place_id' = ($3::integer)::text
         OR (detail->>'thing_id' ~ '^[0-9]{1,9}$' AND EXISTS (
           SELECT 1 FROM things thing
           WHERE thing.id = (detail->>'thing_id')::integer
             AND thing.place_id = $3::integer))
         OR (detail->>'note_id' ~ '^[0-9]{1,9}$' AND EXISTS (
           SELECT 1 FROM notes note
           WHERE note.id = (detail->>'note_id')::integer
             AND note.place_id = $3::integer)))
       AND ($4::integer IS NULL OR id < $4::integer)
     ORDER BY id DESC
     LIMIT $5::integer`,
    [filters.kind, filters.actor, filters.placeId, page.cursor, page.fetchLimit],
  )
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
}

export async function loadPublicPlaceCollectionRows(
  query: PublicQueryExecutor,
  placeId: number,
  pages: PublicPlacePageRequests,
): Promise<Readonly<PublicPlaceCollectionRows>> {
  const [subplaces, things, notes] = await Promise.all([
    query(
      `SELECT p.id, p.parent_id, p.name, p.description, p.owner_id, owner.handle AS owner,
         p.open_to_building, p.open_to_things, p.open_to_notes, p.created_at
       FROM places p
       LEFT JOIN residents owner ON owner.id = p.owner_id
       WHERE p.parent_id = $1::integer
         AND ($2::integer IS NULL OR p.id < $2::integer)
       ORDER BY p.id DESC
       LIMIT $3::integer`,
      [placeId, pages.subplaces.cursor, pages.subplaces.fetchLimit],
    ),
    query(
      `SELECT t.id, t.place_id, t.name, t.body, t.owner_id, owner.handle AS owner,
         t.open_to_use,
         t.kind_id, k.name AS kind, t.birth_revision, t.current_revision, t.created_at
       FROM things t
       JOIN residents owner ON owner.id = t.owner_id
       LEFT JOIN kinds k ON k.id = t.kind_id
       WHERE t.place_id = $1::integer AND t.withdrawn_at IS NULL
         AND ($2::integer IS NULL OR t.id < $2::integer)
       ORDER BY t.id DESC
       LIMIT $3::integer`,
      [placeId, pages.things.cursor, pages.things.fetchLimit],
    ),
    query(
      `SELECT n.id, n.place_id, author.handle AS author, n.body, n.created_at
       FROM notes n
       JOIN residents author ON author.id = n.author_id
       WHERE n.place_id = $1::integer
         AND ($2::integer IS NULL OR n.id < $2::integer)
       ORDER BY n.id DESC
       LIMIT $3::integer`,
      [placeId, pages.notes.cursor, pages.notes.fetchLimit],
    ),
  ])
  return Object.freeze({ subplaces, things, notes })
}
