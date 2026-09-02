import { sql } from './db.ts'
import { moderatePublicRows } from './moderation-store.ts'
import { PUBLIC_PAGE_DEFAULT, finalizePublicPage } from './public-pagination.ts'
import { loadPublicPlaceFrontMatter, type PublicFrontMatterHeading } from './room-orientation.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'

export interface PublicMapOutlinePlace extends Readonly<Record<string, unknown>> {
  readonly id: number
  readonly parent_id: number | null
  readonly name: string
  readonly founding_name: string
  readonly name_history: readonly Readonly<{
    name: string
    started_at: string
    ended_at: string | null
  }>[]
  readonly retired_at: string | null
  readonly status: 'active' | 'retired'
  readonly purpose: string
  readonly description_text_bytes: number
  readonly front_matter: readonly PublicFrontMatterHeading[]
  readonly owner_id: number | null
  readonly owner: string | null
  readonly open_to_building: boolean
  readonly open_to_things: boolean
  readonly open_to_notes: boolean
  readonly created_at: string
  readonly places: number
  readonly things: number
  readonly notes: number
  readonly children: readonly never[]
}

export interface PublicMapOutline {
  readonly place: PublicMapOutlinePlace
  readonly subplaces: readonly PublicMapOutlinePlace[]
  readonly subplaces_page: Readonly<{
    total_items: number
    total_text_bytes: number
    returned_items: number
    returned_text_bytes: number
    has_more: boolean
    next_before_subplace_id: number | null
  }>
  readonly map_complete: false
}

interface PublicMapOutlineCache {
  readonly expiresAt: number
  readonly pending: Promise<PublicMapOutline | null>
}

const MAP_OUTLINE_CACHE_MS = 30_000
let outlineCache: PublicMapOutlineCache | null = null

function safeCount(value: unknown, field: string): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`public map ${field} is invalid`)
  }
  return count
}

function nullablePositiveId(value: unknown, field: string): number | null {
  if (value == null) return null
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) {
    throw new Error(`public map ${field} is invalid`)
  }
  return id
}

function publicTimestamp(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString()
  }
  throw new Error('public map created_at is invalid')
}

function nullablePublicTimestamp(value: unknown, field: string): string | null {
  if (value == null) return null
  try {
    return publicTimestamp(value)
  } catch {
    throw new Error(`public map ${field} is invalid`)
  }
}

function nameHistory(value: unknown): PublicMapOutlinePlace['name_history'] {
  if (!Array.isArray(value)) throw new Error('public map name history is invalid')
  return Object.freeze(value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('public map name history is invalid')
    }
    const span = item as Record<string, unknown>
    if (typeof span.name !== 'string') throw new Error('public map name history is invalid')
    return Object.freeze({
      name: span.name,
      started_at: publicTimestamp(span.started_at),
      ended_at: nullablePublicTimestamp(span.ended_at, 'name history ended_at'),
    })
  }))
}

function outlinePlace(row: Readonly<Record<string, unknown>>): PublicMapOutlinePlace {
  const id = nullablePositiveId(row.id, 'place id')
  const foundingName = typeof row.founding_name === 'string' ? row.founding_name : row.name
  const retiredAt = nullablePublicTimestamp(row.retired_at, 'retired_at')
  const status = row.status ?? (retiredAt === null ? 'active' : 'retired')
  if (
    id == null || typeof row.name !== 'string' || typeof foundingName !== 'string'
    || typeof row.purpose !== 'string'
    || (status !== 'active' && status !== 'retired')
  ) {
    throw new Error('public map place is invalid')
  }
  const parentId = nullablePositiveId(row.parent_id, 'parent id')
  const ownerId = nullablePositiveId(row.owner_id, 'owner id')
  const descriptionTextBytes = Object.hasOwn(row, 'description_text_bytes')
    ? safeCount(row.description_text_bytes, 'description text bytes')
    : Buffer.byteLength(typeof row.description === 'string' ? row.description : '', 'utf8')
  const owner = row.owner == null ? null : String(row.owner)
  if (
    typeof row.open_to_building !== 'boolean' ||
    typeof row.open_to_things !== 'boolean' ||
    typeof row.open_to_notes !== 'boolean'
  ) {
    throw new Error('public map place permissions are invalid')
  }
  return Object.freeze({
    id,
    parent_id: parentId,
    name: row.name,
    founding_name: foundingName,
    name_history: nameHistory(row.name_history ?? [{
      name: row.name,
      started_at: row.created_at,
      ended_at: null,
    }]),
    retired_at: retiredAt,
    status,
    purpose: row.purpose,
    description_text_bytes: descriptionTextBytes,
    front_matter: Object.freeze([]),
    owner_id: ownerId,
    owner,
    open_to_building: row.open_to_building,
    open_to_things: row.open_to_things,
    open_to_notes: row.open_to_notes,
    created_at: publicTimestamp(row.created_at),
    places: safeCount(row.places, 'subplace count'),
    things: safeCount(row.things, 'thing count'),
    notes: safeCount(row.notes, 'note count'),
    children: Object.freeze([]) as readonly never[],
  })
}

export async function readPublicMapOutline(
  parentId: number | null,
  cursor: number | null,
  limit: number,
): Promise<PublicMapOutline | null> {
  const rawRows = await sql.query(
    `/* public:map-outline */
     WITH outline_parent AS MATERIALIZED (
       SELECT p.id, p.parent_id, p.name, p.founding_name,
         history.name_history, p.retired_at,
         CASE WHEN p.retired_at IS NULL THEN 'active'::text ELSE 'retired'::text END AS status,
         p.purpose,
         octet_length(p.description)::integer AS description_text_bytes,
         p.owner_id, owner.handle AS owner,
         p.open_to_building, p.open_to_things, p.open_to_notes, p.created_at,
         totals.subplace_items AS places,
         totals.thing_items AS things,
         totals.note_items AS notes,
         totals.subplace_text_bytes
       FROM places p
       JOIN place_reading_totals totals ON totals.place_id = p.id
       LEFT JOIN residents owner ON owner.id = p.owner_id
       LEFT JOIN LATERAL (
         SELECT coalesce(jsonb_agg(jsonb_build_object(
           'name', span.name,
           'started_at', to_char(span.started_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'ended_at', CASE WHEN span.ended_at IS NULL THEN NULL ELSE to_char(
             span.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
         ) ORDER BY span.started_at, span.id), '[]'::jsonb) AS name_history
         FROM (
           SELECT history.id, history.name, history.started_at,
             lead(history.started_at) OVER (
               PARTITION BY history.place_id ORDER BY history.started_at, history.id
             ) AS ended_at
           FROM place_name_history history
           WHERE history.place_id = p.id
         ) span
       ) history ON TRUE
       WHERE ($1::integer IS NOT NULL AND p.id = $1::integer)
         OR ($1::integer IS NULL
           AND p.retired_at IS NULL
           AND p.parent_id IS NULL
           AND p.owner_id IS NULL
           AND p.place_kind = 'world'
           AND p.name = $2::text)
       ORDER BY p.id
       LIMIT 1
     ), subplace_page AS MATERIALIZED (
       SELECT p.id, p.parent_id, p.name, p.founding_name,
         history.name_history, p.retired_at, 'active'::text AS status, p.purpose,
         octet_length(p.description)::integer AS description_text_bytes,
         p.owner_id, owner.handle AS owner,
         p.open_to_building, p.open_to_things, p.open_to_notes, p.created_at,
         child_totals.subplace_items AS places,
         child_totals.thing_items AS things,
         child_totals.note_items AS notes
       FROM outline_parent parent
       JOIN places p ON p.parent_id = parent.id
       JOIN place_reading_totals child_totals ON child_totals.place_id = p.id
       LEFT JOIN residents owner ON owner.id = p.owner_id
       LEFT JOIN LATERAL (
         SELECT coalesce(jsonb_agg(jsonb_build_object(
           'name', span.name,
           'started_at', to_char(span.started_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'ended_at', CASE WHEN span.ended_at IS NULL THEN NULL ELSE to_char(
             span.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
         ) ORDER BY span.started_at, span.id), '[]'::jsonb) AS name_history
         FROM (
           SELECT history.id, history.name, history.started_at,
             lead(history.started_at) OVER (
               PARTITION BY history.place_id ORDER BY history.started_at, history.id
             ) AS ended_at
           FROM place_name_history history
           WHERE history.place_id = p.id
         ) span
       ) history ON TRUE
       WHERE ($3::integer IS NULL OR p.id < $3::integer)
         AND p.retired_at IS NULL
       ORDER BY p.id DESC
       LIMIT $4::integer
     )
     SELECT to_jsonb(parent) - 'subplace_text_bytes' AS outline_parent,
       page.*, parent.places AS total_items,
       parent.subplace_text_bytes AS total_text_bytes
     FROM outline_parent parent
     LEFT JOIN subplace_page page ON true
     ORDER BY page.id DESC`,
    [parentId, WORLD_ROOT_NAME, cursor, limit + 1],
  ) as Record<string, unknown>[]
  const rawParent = rawRows[0]?.outline_parent
  if (!rawParent) return null
  if (typeof rawParent !== 'object' || Array.isArray(rawParent)) {
    throw new Error('public map parent is invalid')
  }
  const parent = outlinePlace(rawParent as Record<string, unknown>)
  const totals = rawRows[0]
  if (!totals) throw new Error('public map reading totals are unavailable')
  const totalItems = safeCount(totals.total_items, 'total item count')
  const totalTextBytes = safeCount(totals.total_text_bytes, 'total text bytes')
  const page = finalizePublicPage(
    rawRows.filter(row => row.id != null).map(outlinePlace),
    limit,
  )
  const moderated = await moderatePublicRows('place', [parent, ...page.items])
  const frontMatter = await loadPublicPlaceFrontMatter(
    async (text, params) => await sql.query(text, [...params]) as Record<string, unknown>[],
    [parent.id, ...page.items.map(place => place.id)],
  )
  const publicParent = Object.freeze({
    ...moderated[0] as PublicMapOutlinePlace,
    front_matter: (moderated[0] as Record<string, unknown>).moderated === true
      ? Object.freeze([])
      : frontMatter.get(parent.id) ?? Object.freeze([]),
    children: Object.freeze([]) as readonly never[],
  })
  const publicSubplaces = Object.freeze(page.items.map((row, index) => Object.freeze({
    ...moderated[index + 1] as PublicMapOutlinePlace,
    front_matter: (moderated[index + 1] as Record<string, unknown>).moderated === true
      ? Object.freeze([])
      : frontMatter.get(row.id) ?? Object.freeze([]),
    children: Object.freeze([]) as readonly never[],
  })))
  return Object.freeze({
    place: publicParent,
    subplaces: publicSubplaces,
    subplaces_page: Object.freeze({
      total_items: totalItems,
      total_text_bytes: totalTextBytes,
      returned_items: publicSubplaces.length,
      returned_text_bytes: page.items.reduce(
        (total, place) => total + Buffer.byteLength(place.purpose, 'utf8'),
        0,
      ),
      has_more: page.hasMore,
      next_before_subplace_id: page.nextCursor,
    }),
    map_complete: false as const,
  })
}

/**
 * Share the one hot initial root outline for 30 seconds. Caller-selected
 * branches and cursors rely on the public CDN's URL cache, so they cannot
 * evict the root entry or grow process memory.
 */
export async function cachedPublicMapOutline(
  parentId: number | null,
  cursor: number | null,
  limit: number,
): Promise<PublicMapOutline | null> {
  if (parentId != null || cursor != null || limit !== PUBLIC_PAGE_DEFAULT) {
    return readPublicMapOutline(parentId, cursor, limit)
  }
  const now = Date.now()
  if (outlineCache && outlineCache.expiresAt > now) return outlineCache.pending
  const pending = readPublicMapOutline(parentId, cursor, limit)
  outlineCache = Object.freeze({ expiresAt: now + MAP_OUTLINE_CACHE_MS, pending })
  try {
    return await pending
  } catch (error) {
    if (outlineCache?.pending === pending) outlineCache = null
    throw error
  }
}
