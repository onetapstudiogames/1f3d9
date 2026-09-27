// The shared place-hinge contract and its public far-side query (decision #132).
import { GAZETTE_ROOM_ID } from './gazette.ts'
import { MODERATED_TEXT } from './moderation.ts'
import type { PublicQueryExecutor } from './public-pagination.ts'

type ParsedHingeTo = Readonly<
  | { ok: true; supplied: boolean; value: number | null }
  | { ok: false; error: string }
>

const MAX_PLACE_ID = 2_147_483_647

function isPlaceId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_PLACE_ID
}

export function parseHingeTo(value: unknown, placeId: number): ParsedHingeTo {
  if (value === undefined) return Object.freeze({ ok: true, supplied: false, value: null })
  if (value === null) return Object.freeze({ ok: true, supplied: true, value: null })
  if (!isPlaceId(value)) {
    return Object.freeze({
      ok: false,
      error: 'hinge_to must be one positive place id, or null to close your side of the hinge',
    })
  }
  if (value === placeId) {
    return Object.freeze({
      ok: false,
      error: 'hinge_to cannot name this same place; name another place, or send null to close your side',
    })
  }
  return Object.freeze({ ok: true, supplied: true, value: value as number })
}

export const HINGE_TO_GAZETTE_REFUSAL =
  `hinge_to cannot name protected Gazette room #${GAZETTE_ROOM_ID}; name another place`
export const HINGE_TO_WORLD_REFUSAL =
  'hinge_to cannot name the world: it has no owner who could agree; name an owned place'

export function hingeTargetMissingRefusal(id: number): string {
  return `hinge_to place_id ${id} was not found; name a current place id from the public map`
}

export function hingeTargetRetiredRefusal(id: number): string {
  return `hinge_to place_id ${id} is retired; its owner must restore it first, or name another place`
}

export function hingeTargetNestedRefusal(id: number): string {
  return `hinge_to place_id ${id} is inside this place or contains it, and walking already joins them; a hinge joins two places where neither holds the other`
}

export type PublicHinge = Readonly<{
  place_id: number
  name: string
  parent_id: number | null
  rough_room: boolean
}>

export function publicHinge(value: unknown): PublicHinge | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const row = value as Record<string, unknown>
    if (!isPlaceId(row.place_id)
        || typeof row.name !== 'string'
        || !(row.parent_id === null || isPlaceId(row.parent_id))
        || typeof row.rough_room !== 'boolean') return null
    return Object.freeze({
      place_id: row.place_id as number,
      name: row.name,
      parent_id: row.parent_id as number | null,
      rough_room: row.rough_room,
    })
  } catch {
    return null
  }
}

export function publicHingeSql(alias: string): string {
  const moderatedText = `'${MODERATED_TEXT.replaceAll("'", "''")}'::text`
  return `(
    SELECT jsonb_build_object(
      'place_id', far.id,
      'name', CASE WHEN latest_moderation.action = 'remove' THEN ${moderatedText} ELSE far.name END,
      'parent_id', far.parent_id,
      'rough_room', far.rough_room
    )
    FROM places far
    LEFT JOIN LATERAL (
      SELECT moderation.action
      FROM moderation_actions moderation
      WHERE moderation.target_type = 'place' AND moderation.target_id = far.id
      ORDER BY moderation.created_at DESC, moderation.id DESC
      LIMIT 1
    ) latest_moderation ON TRUE
    WHERE far.id = ${alias}.hinge_to
      AND far.hinge_to = ${alias}.id
      AND far.retired_at IS NULL
      AND ${alias}.retired_at IS NULL
  )`
}

export async function loadPublicPlaceHinges(
  query: PublicQueryExecutor,
  placeIds: readonly number[],
): Promise<ReadonlyMap<number, PublicHinge | null>> {
  const rows = await query(
    `/* public:place-hinges */
     SELECT p.id, ${publicHingeSql('p')} AS hinge
     FROM places p
     WHERE p.id = ANY($1::int[])`,
    [placeIds],
  )
  return new Map(rows.map(row => [Number(row.id), publicHinge(row.hinge)]))
}
