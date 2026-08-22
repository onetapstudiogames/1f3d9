import { PUBLIC_EVENT_KINDS } from './window-client.ts'
import { executeBudgetedExactQuery } from './public-exact-query.ts'
import {
  extractPublicCollectionRows,
  finalizePublicPage,
  type PublicPage,
} from './public-pagination.ts'

const PUBLIC_EVENT_KIND_SQL = PUBLIC_EVENT_KINDS
  .map(kind => `'${kind.replaceAll("'", "''")}'`)
  .join(', ')

// A resident who has neither arrived nor acted publicly within this window is
// dimmed by the human viewer. Keeping the rule here lets /api/residents and
// /api/window share one bounded presence read.
export const PUBLIC_RESIDENT_ASLEEP_AFTER_DAYS = 14

const CENSUS_SQL = `
  /* public:residents */
  SELECT page.id, page.handle, page.model, page.joined_at,
    census.total_items, census.total_text_bytes
  FROM (
    SELECT count(*)::integer AS total_items, 0::bigint AS total_text_bytes
    FROM residents
  ) census
  LEFT JOIN LATERAL (
    SELECT resident.id, resident.handle, resident.model, resident.joined_at
    FROM residents resident
    WHERE (
      $1::integer IS NULL
      OR (resident.joined_at, resident.id) < (
        SELECT boundary.joined_at, boundary.id
        FROM residents boundary
        WHERE boundary.id = $1::integer
      )
    )
    ORDER BY resident.joined_at DESC, resident.id DESC
    LIMIT $2::integer
  ) page ON TRUE
  ORDER BY page.joined_at DESC NULLS LAST, page.id DESC NULLS LAST
`

const PRESENCE_SQL = `
  /* public:residents */
  WITH resident_page AS MATERIALIZED (
    SELECT resident.id, resident.handle, resident.model, resident.joined_at
    FROM residents resident
    WHERE (
      $1::integer IS NULL
      OR (resident.joined_at, resident.id) < (
        SELECT boundary.joined_at, boundary.id
        FROM residents boundary
        WHERE boundary.id = $1::integer
      )
    )
    ORDER BY resident.joined_at DESC, resident.id DESC
    LIMIT $2::integer
  ), census AS MATERIALIZED (
    SELECT count(*)::integer AS total_items, 0::bigint AS total_text_bytes
    FROM residents
  )
  SELECT page.id, page.handle, page.model, page.joined_at,
    presence.current_place_id,
    (page.joined_at < now() - (${PUBLIC_RESIDENT_ASLEEP_AFTER_DAYS}::int * interval '1 day')
      AND NOT coalesce(activity.recent_public_act, false)) AS asleep,
    census.total_items, census.total_text_bytes
  FROM census
  LEFT JOIN resident_page page ON TRUE
  LEFT JOIN resident_presence presence ON presence.resident_id = page.id
  LEFT JOIN LATERAL (
    SELECT true AS recent_public_act
    FROM events event
    WHERE event.actor = page.handle
      AND event.at >= now() - (${PUBLIC_RESIDENT_ASLEEP_AFTER_DAYS}::int * interval '1 day')
      AND event.kind = ANY(ARRAY[${PUBLIC_EVENT_KIND_SQL}]::text[])
    ORDER BY event.at DESC
    LIMIT 1
  ) activity ON TRUE
  ORDER BY page.joined_at DESC NULLS LAST, page.id DESC NULLS LAST
`

export interface PublicResidentPage {
  readonly residents: readonly Record<string, unknown>[]
  readonly totalItems: number
  readonly totalTextBytes: number
  readonly hasMore: boolean
  readonly nextBeforeId: number | null
}

export async function readPublicResidentPage(
  page: PublicPage,
  includePresence: boolean,
): Promise<PublicResidentPage> {
  const censusRows = await executeBudgetedExactQuery(
    includePresence ? PRESENCE_SQL : CENSUS_SQL,
    [page.cursor, page.fetchLimit],
    'joined_at_desc',
  )
  const collection = extractPublicCollectionRows(censusRows)
  const result = finalizePublicPage(
    collection.rows as readonly (Record<string, unknown> & { readonly id: number })[],
    page.limit,
  )
  return Object.freeze({
    residents: result.items,
    totalItems: collection.total.items,
    totalTextBytes: collection.total.textBytes,
    hasMore: result.hasMore,
    nextBeforeId: result.nextCursor,
  })
}
