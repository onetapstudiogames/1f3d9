import { positiveId, publicText } from './input.ts'
import type { PublicQueryExecutor } from './public-pagination.ts'

export const PLACE_PURPOSE_MAX_CHARACTERS = 280

export interface PublicFrontMatterHeading {
  readonly id: number
  readonly type: 'thing'
  readonly name: string
  readonly body_text_bytes: number
  readonly maker_id: number
  readonly made_by: string
  readonly current_owner_id: number
  readonly current_owner: string
  readonly owner_id: number
  readonly owner: string
}

export function parsePlacePurpose(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  const purpose = publicText(value, { allowEmpty: true })
  if (purpose === null) return null
  const normalized = purpose.trim()
  if (/[\r\n\u2028\u2029]/u.test(normalized)) return null
  return [...normalized].length <= PLACE_PURPOSE_MAX_CHARACTERS ? normalized : null
}

export function parsePlaceFrontMatter(value: unknown): readonly number[] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  if (value.length === 0) return Object.freeze([])
  if (value.length !== 2 && value.length !== 3) return null
  if (value.some(id => typeof id !== 'number')) return null
  const ids = value.map(positiveId)
  if (ids.some(id => id === null)) return null
  const selected = ids as number[]
  return new Set(selected).size === selected.length ? Object.freeze([...selected]) : null
}

function publicHeading(row: Readonly<Record<string, unknown>>): PublicFrontMatterHeading | null {
  const id = positiveId(row.id)
  const name = typeof row.name === 'string' ? row.name : null
  const bodyTextBytes = Number(row.body_text_bytes)
  const madeBy = typeof row.made_by === 'string' ? row.made_by : null
  const currentOwner = typeof row.current_owner === 'string' ? row.current_owner : null
  const makerId = positiveId(row.maker_id)
  const currentOwnerId = positiveId(row.current_owner_id)
  const ownerId = positiveId(row.owner_id)
  const owner = typeof row.owner === 'string' ? row.owner : null
  if (!id || !name || !Number.isSafeInteger(bodyTextBytes) || bodyTextBytes < 0
      || row.type !== 'thing' || !makerId || !madeBy || !currentOwnerId || !currentOwner
      || !ownerId || !owner || ownerId !== currentOwnerId || owner !== currentOwner) return null
  return Object.freeze({
    id,
    type: 'thing' as const,
    name,
    body_text_bytes: bodyTextBytes,
    maker_id: makerId,
    made_by: madeBy,
    current_owner_id: currentOwnerId,
    current_owner: currentOwner,
    owner_id: ownerId,
    owner,
  })
}

/** Load only owner-selected, currently public headings. Thing bodies never leave SQL. */
export async function loadPublicPlaceFrontMatter(
  query: PublicQueryExecutor,
  placeIds: readonly number[],
): Promise<ReadonlyMap<number, readonly PublicFrontMatterHeading[]>> {
  const ids = [...new Set(placeIds.map(positiveId).filter((id): id is number => id !== null))]
  if (ids.length === 0) return new Map()
  const rows = await query(`
    SELECT place.id AS place_id, selected.position - 1 AS position,
      thing.id, 'thing'::text AS type, thing.name,
      octet_length(thing.body)::integer AS body_text_bytes,
      thing.maker_id, maker.handle AS made_by,
      thing.owner_id AS current_owner_id, current_owner.handle AS current_owner,
      thing.owner_id, current_owner.handle AS owner
    FROM places place
    CROSS JOIN LATERAL unnest(place.front_matter_thing_ids)
      WITH ORDINALITY AS selected(thing_id, position)
    JOIN things thing ON thing.id = selected.thing_id
      AND thing.place_id = place.id
      AND thing.withdrawn_at IS NULL
    JOIN residents maker ON maker.id = thing.maker_id
    JOIN residents current_owner ON current_owner.id = thing.owner_id
    LEFT JOIN LATERAL (
      SELECT moderation.action
      FROM moderation_actions moderation
      WHERE moderation.target_type = 'thing'
        AND moderation.target_id = thing.id
      ORDER BY moderation.created_at DESC, moderation.id DESC
      LIMIT 1
    ) latest_moderation ON TRUE
    WHERE place.id = ANY($1::integer[])
      AND coalesce(latest_moderation.action, 'restore') <> 'remove'
    ORDER BY place.id, selected.position
  `, [ids])

  const grouped = new Map<number, PublicFrontMatterHeading[]>()
  for (const row of rows) {
    const placeId = positiveId(row.place_id)
    const heading = publicHeading(row)
    if (!placeId || !heading) continue
    grouped.set(placeId, [...(grouped.get(placeId) ?? []), heading])
  }
  return new Map([...grouped].map(([placeId, headings]) => [placeId, Object.freeze(headings)]))
}
