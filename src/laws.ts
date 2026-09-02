import type { Resident } from './core.ts'
import { sql } from './db.ts'
import { stringList } from './input.ts'
import { isWorldRootRow, WORLD_TRANSIT_ONLY_ERROR } from './world-root.ts'

export interface PublicLaw {
  readonly id: number
  readonly name: string
  readonly position: number
}

export type LawFailure = Readonly<{
  error: string
  status: 403 | 404 | 409
}>

export function lawNames(value: unknown): readonly string[] | null {
  const parsed = stringList(value, 32)
  if (!parsed || !Array.isArray(value) || parsed.length !== value.length) return null
  return Object.freeze(parsed)
}

/** Replace a local ordered law list by appending changes; prior law history is never erased. */
export async function replacePlaceLaws(
  actor: Resident,
  placeId: number,
  names: readonly string[],
): Promise<readonly PublicLaw[] | LawFailure> {
  const placeRows = await sql`
    SELECT id, parent_id, place_kind, owner_id, retired_at FROM places WHERE id = ${placeId}
  ` as Array<{
    id: number
    parent_id: number | null
    place_kind: string
    owner_id: number | null
    retired_at: string | null
  }>
  const place = placeRows[0]
  if (!place) return Object.freeze({ error: 'place not found', status: 404 })
  if (isWorldRootRow(place)) {
    return Object.freeze({ error: WORLD_TRANSIT_ONLY_ERROR, status: 403 })
  }
  if (place.owner_id !== actor.id) {
    return Object.freeze({ error: 'only the place owner may change its laws', status: 403 })
  }
  if (place.retired_at != null) {
    return Object.freeze({ error: 'place is retired; restore it before changing its laws', status: 409 })
  }

  const traits = names.length === 0 ? [] : await sql`
    SELECT id, name FROM traits WHERE name = ANY(${[...names]}::text[])
  ` as Array<{ id: number; name: string }>
  if (traits.length !== names.length) {
    const found = new Set(traits.map(trait => trait.name))
    const missing = names.filter(name => !found.has(name))
    return Object.freeze({ error: `unknown trait: ${missing.join(', ')}`, status: 404 })
  }

  const ordered = names.map((name, position) => {
    const trait = traits.find(candidate => candidate.name === name)!
    return Object.freeze({ id: trait.id, name, position })
  })
  const rows = await sql`
    WITH locked_place AS MATERIALIZED (
      SELECT id FROM places
      WHERE id = ${placeId} AND owner_id = ${actor.id}
        AND retired_at IS NULL
      FOR UPDATE
    ), requested AS MATERIALIZED (
      SELECT (entry->>'id')::integer AS trait_id,
        entry->>'name' AS name,
        (entry->>'position')::smallint AS position
      FROM jsonb_array_elements(${JSON.stringify(ordered)}::jsonb) AS entry
    ), latest AS (
      SELECT DISTINCT ON (change.trait_id)
        change.trait_id, change.change_type
      FROM place_law_changes change
      JOIN locked_place ON locked_place.id = change.place_id
      ORDER BY change.trait_id, change.id DESC
    ), changes AS (
      INSERT INTO place_law_changes (
        place_id, trait_id, actor_id, change_type, position
      )
      SELECT place_id, trait_id, actor_id, change_type, position
      FROM (
        SELECT locked_place.id AS place_id, latest.trait_id, ${actor.id}::integer AS actor_id,
          'remove'::text AS change_type, NULL::smallint AS position,
          0 AS phase, 0 AS requested_position
        FROM locked_place CROSS JOIN latest
        WHERE latest.change_type = 'add'
          AND NOT EXISTS (SELECT 1 FROM requested WHERE requested.trait_id = latest.trait_id)
        UNION ALL
        SELECT locked_place.id, requested.trait_id, ${actor.id}::integer, 'add', requested.position,
          1, requested.position
        FROM locked_place CROSS JOIN requested
      ) ordered_changes
      ORDER BY phase, requested_position, trait_id
      RETURNING id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'laws_changed', ${actor.handle}, jsonb_build_object(
        'place_id', locked_place.id,
        'traits', ${JSON.stringify(names)}::jsonb
      )
      FROM locked_place
    )
    SELECT locked_place.id,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', requested.trait_id,
          'name', requested.name,
          'position', requested.position
        ) ORDER BY requested.position)
        FROM requested
      ), '[]'::jsonb) AS laws
    FROM locked_place
  ` as Array<{ id: number; laws: PublicLaw[] }>
  if (!rows[0]) {
    return Object.freeze({ error: 'place ownership changed; re-read it', status: 409 })
  }
  const returned = rows[0].laws
  const laws = Array.isArray(returned) && returned.every(law => (
    law && typeof law === 'object' && typeof law.name === 'string'
  )) ? returned : ordered
  return Object.freeze([...laws])
}
