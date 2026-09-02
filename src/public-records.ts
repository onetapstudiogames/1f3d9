import { sql } from './db.ts'
import { moderatePlaceDetails, moderatePublicRows } from './moderation-store.ts'
import type { PlaceRow, ThingRow } from './world-support.ts'

export type PublicPlaceRecord = Readonly<PlaceRow & Record<string, unknown>>
export type PublicThingRecord = Readonly<ThingRow & Record<string, unknown>>
export type PublicNoteRecord = Readonly<{
  id: number
  place_id: number
  author: string
  body: string
  created_at: string
} & Record<string, unknown>>

/**
 * Read one current place by an already-validated ID from 1 through 2,147,483,647.
 * Returns its moderated public record, or null when that place does not exist.
 */
export async function loadPublicPlaceRecord(id: number): Promise<PublicPlaceRecord | null> {
  const rows = (await sql`
    SELECT p.id, p.parent_id, p.name, p.description, p.purpose,
      p.owner_id, owner.handle AS owner,
      p.open_to_building, p.open_to_things, p.open_to_notes, p.created_at
    FROM places p
    LEFT JOIN residents owner ON owner.id = p.owner_id
    WHERE p.id = ${id}
  `) as PublicPlaceRecord[]
  const publicRows = await moderatePublicRows('place', rows)
  return publicRows[0] ?? null
}

/**
 * Read one current active thing by an already-validated ID from 1 through 2,147,483,647.
 * Returns its fully moderated public record, or null when it is absent or withdrawn.
 */
export async function loadPublicThingRecord(id: number): Promise<PublicThingRecord | null> {
  const rows = (await sql`
    SELECT thing.id, thing.place_id, thing.name, thing.body,
      thing.maker_id, maker.handle AS made_by,
      thing.owner_id AS current_owner_id, owner.handle AS current_owner,
      thing.owner_id, owner.handle AS owner, thing.open_to_use,
      thing.kind_id, kind.name AS kind,
      thing.birth_revision, thing.current_revision,
      CASE
        WHEN coalesce((
          SELECT moderation.action FROM moderation_actions moderation
          WHERE moderation.target_type = 'thing' AND moderation.target_id = thing.id
          ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
        ), 'restore') = 'remove' THEN false
        WHEN thing.kind_id IS NULL THEN thing.drawing IS NOT NULL
        WHEN thing.drawing_state = 'refused' THEN false
        WHEN coalesce((
          SELECT moderation.action FROM moderation_actions moderation
          WHERE moderation.target_type = 'kind' AND moderation.target_id = thing.kind_id
          ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
        ), 'restore') = 'remove' THEN false
        ELSE coalesce((
          SELECT variant.value -> 'drawing' IS NOT NULL
          FROM kind_revisions drawing_revision
          CROSS JOIN LATERAL jsonb_array_elements(
            coalesce(drawing_revision.drawing_variants, '[]'::jsonb)
          ) variant(value)
          WHERE drawing_revision.kind_id = thing.kind_id
            AND drawing_revision.revision = thing.current_revision
            AND variant.value ->> 'name' = thing.drawing_variant_name
          LIMIT 1
        ), (
          SELECT drawing_revision.drawing IS NOT NULL
          FROM kind_revisions drawing_revision
          WHERE drawing_revision.kind_id = thing.kind_id
            AND drawing_revision.revision = thing.current_revision
        ), false)
      END AS has_drawing,
      thing.created_at
    FROM things thing
    JOIN residents maker ON maker.id = thing.maker_id
    JOIN residents owner ON owner.id = thing.owner_id
    LEFT JOIN kinds kind ON kind.id = thing.kind_id
    WHERE thing.id = ${id} AND thing.withdrawn_at IS NULL
  `) as PublicThingRecord[]
  const publicDetails = await moderatePlaceDetails(rows, [])
  return publicDetails.things[0] ?? null
}

/**
 * Read one current note by an already-validated ID from 1 through 2,147,483,647.
 * Returns its moderated public record, or null when that note does not exist.
 */
export async function loadPublicNoteRecord(id: number): Promise<PublicNoteRecord | null> {
  const rows = (await sql`
    SELECT note.id, note.place_id, author.handle AS author, note.body, note.created_at
    FROM notes note
    JOIN residents author ON author.id = note.author_id
    WHERE note.id = ${id}
  `) as PublicNoteRecord[]
  const publicRows = await moderatePublicRows('note', rows)
  return publicRows[0] ?? null
}
