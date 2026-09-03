import { HANDLE_RE } from './core.ts'
import { sql } from './db.ts'
import { positiveId, publicLabel } from './input.ts'
import { MODERATED_TEXT } from './moderation.ts'
import { PUBLIC_RESIDENT_HAS_DRAWING_SQL } from './public-drawing-presence.ts'

const DIRECTORY_CACHE_MS = 30_000

const DIRECTORY_SQL = `
  /* public:window-directory */
  SELECT 'place'::text AS entry_type,
    place.id,
    place.parent_id,
    CASE WHEN latest_moderation.action = 'remove' THEN $1::text ELSE place.name END AS name,
    NULL::text AS handle,
    NULL::boolean AS has_drawing,
    place.quiet
  FROM places place
  LEFT JOIN LATERAL (
    SELECT moderation.action
    FROM moderation_actions moderation
    WHERE moderation.target_type = 'place'
      AND moderation.target_id = place.id
    ORDER BY moderation.created_at DESC, moderation.id DESC
    LIMIT 1
  ) latest_moderation ON TRUE
  WHERE place.retired_at IS NULL
  UNION ALL
  SELECT 'resident'::text AS entry_type,
    resident.id,
    NULL::integer AS parent_id,
    NULL::text AS name,
    resident.handle,
    ${PUBLIC_RESIDENT_HAS_DRAWING_SQL} AS has_drawing,
    NULL::boolean AS quiet
  FROM residents resident
  ORDER BY entry_type, id
`

export type PublicDirectoryQuery = (
  text: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>

export interface PublicDirectoryPlace {
  readonly type: 'place'
  readonly id: number
  readonly parent_id: number | null
  readonly name: string
  readonly quiet: boolean
}

export interface PublicDirectoryResident {
  readonly type: 'resident'
  readonly id: number
  readonly handle: string
  readonly has_drawing: boolean
}

export interface PublicDirectory {
  readonly places: readonly PublicDirectoryPlace[]
  readonly residents: readonly PublicDirectoryResident[]
}

const executeDirectoryQuery: PublicDirectoryQuery = async (text, params) =>
  await sql.query(text, [...params]) as readonly Record<string, unknown>[]

function publicDirectoryPlace(row: Readonly<Record<string, unknown>>): PublicDirectoryPlace {
  const id = positiveId(row.id)
  const parentId = row.parent_id == null ? null : positiveId(row.parent_id)
  const name = publicLabel(row.name)
  if (id === null || name === null || (row.parent_id != null && parentId === null)) {
    throw new Error('invalid public directory place row')
  }
  return Object.freeze({
    type: 'place' as const, id, parent_id: parentId, name, quiet: row.quiet === true,
  })
}

function publicDirectoryResident(row: Readonly<Record<string, unknown>>): PublicDirectoryResident {
  const id = positiveId(row.id)
  const handle = typeof row.handle === 'string' && HANDLE_RE.test(row.handle) ? row.handle : null
  if (id === null || handle === null) throw new Error('invalid public directory resident row')
  return Object.freeze({
    type: 'resident' as const,
    id,
    handle,
    has_drawing: row.has_drawing === true,
  })
}

export async function readPublicDirectory(
  query: PublicDirectoryQuery = executeDirectoryQuery,
): Promise<PublicDirectory> {
  const rows = await query(DIRECTORY_SQL, [MODERATED_TEXT])
  const places: PublicDirectoryPlace[] = []
  const residents: PublicDirectoryResident[] = []
  for (const row of rows) {
    if (row.entry_type === 'place') places.push(publicDirectoryPlace(row))
    else if (row.entry_type === 'resident') residents.push(publicDirectoryResident(row))
    else throw new Error('invalid public directory entry type')
  }
  return Object.freeze({
    places: Object.freeze(places),
    residents: Object.freeze(residents),
  })
}

let directoryCache: {
  readonly expiresAt: number
  readonly pending: Promise<PublicDirectory>
} | null = null

export async function cachedPublicDirectory(): Promise<PublicDirectory> {
  const now = Date.now()
  if (directoryCache && directoryCache.expiresAt > now) return directoryCache.pending
  const pending = readPublicDirectory()
  directoryCache = { expiresAt: now + DIRECTORY_CACHE_MS, pending }
  try {
    return await pending
  } catch (error) {
    if (directoryCache?.pending === pending) directoryCache = null
    throw error
  }
}
