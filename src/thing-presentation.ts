/**
 * The presentation a thing shows, as a drawing_revisions snapshot, read from the
 * kind it is now (its conversion overlay, or else its birth kind). A conversion
 * and a converted thing's upgrade change that presentation without an owner's
 * drawing edit, so they append a revision here to keep the public drawing
 * history's newest snapshot equal to what the thing shows.
 */
import type { TaggedSql } from './engine.ts'

export interface ThingPresentation {
  readonly state: string
  readonly description: string | null
  readonly drawing: string | null
  readonly source: string
  readonly kindId: number | null
  readonly kindRevision: number | null
  readonly variantName: string | null
}

export type PresentationAuthorRelation = 'owner' | 'kind_owner'

function nullableText(value: unknown): string | null {
  return value == null ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value)
}

/** The same snapshot rules thing_edit records, read from the kind the thing is now. */
export async function readThingPresentation(thingId: number, db: TaggedSql): Promise<ThingPresentation | null> {
  const rows = await db`
    WITH shown AS (
      SELECT thing.drawing_state, thing.drawing_description, thing.drawing, thing.drawing_variant_name,
        coalesce(thing.as_kind_id, thing.kind_id) AS kind_id,
        coalesce(thing.as_revision, thing.current_revision) AS revision,
        pinned.drawing_state AS kind_state, pinned.drawing_description AS kind_description,
        pinned.drawing AS kind_drawing, selected.value AS variant
      FROM things thing
      LEFT JOIN kind_revisions pinned
        ON pinned.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
        AND pinned.revision = coalesce(thing.as_revision, thing.current_revision)
      LEFT JOIN LATERAL (
        SELECT candidate.value
        FROM jsonb_array_elements(coalesce(pinned.drawing_variants, '[]'::jsonb)) candidate(value)
        WHERE candidate.value->>'name' = thing.drawing_variant_name
        LIMIT 1
      ) selected ON TRUE
      WHERE thing.id = ${thingId}
    )
    SELECT
      CASE WHEN kind_id IS NULL OR drawing_state = 'refused' THEN drawing_state
        WHEN drawing_variant_name IS NOT NULL THEN variant->>'state'
        ELSE kind_state END AS state,
      CASE WHEN kind_id IS NULL OR drawing_state = 'refused' THEN drawing_description
        WHEN drawing_variant_name IS NOT NULL THEN variant->>'description'
        ELSE kind_description END AS description,
      (CASE WHEN kind_id IS NULL OR drawing_state = 'refused' THEN drawing
        WHEN drawing_variant_name IS NOT NULL THEN variant->'drawing'
        ELSE kind_drawing END)::text AS drawing,
      CASE WHEN kind_id IS NULL THEN CASE WHEN drawing_state = 'undrawn' THEN 'none' ELSE 'thing' END
        WHEN drawing_state = 'refused' THEN 'thing'
        WHEN drawing_variant_name IS NOT NULL THEN 'kind_variant'
        WHEN kind_state = 'undrawn' THEN 'none'
        ELSE 'kind_base' END AS source,
      CASE WHEN kind_id IS NOT NULL AND (drawing_state = 'refused'
          OR drawing_variant_name IS NOT NULL OR kind_state <> 'undrawn')
        THEN kind_id END AS kind_id,
      CASE WHEN kind_id IS NOT NULL AND (drawing_state = 'refused'
          OR drawing_variant_name IS NOT NULL OR kind_state <> 'undrawn')
        THEN revision END AS kind_revision,
      CASE WHEN kind_id IS NOT NULL AND drawing_state <> 'refused'
        THEN drawing_variant_name END AS variant_name
    FROM shown
  ` as Array<Record<string, unknown>>
  const row = rows[0]
  if (!row) return null
  return Object.freeze({
    state: String(row.state),
    description: nullableText(row.description),
    drawing: nullableText(row.drawing),
    source: String(row.source),
    kindId: nullableNumber(row.kind_id),
    kindRevision: nullableNumber(row.kind_revision),
    variantName: nullableText(row.variant_name),
  })
}

function samePresentation(left: ThingPresentation, right: ThingPresentation): boolean {
  return left.state === right.state && left.description === right.description
    && left.drawing === right.drawing && left.source === right.source
    && left.kindId === right.kindId && left.kindRevision === right.kindRevision
    && left.variantName === right.variantName
}

/**
 * Append one thing drawing revision from `prior` to what the thing shows now,
 * only when the two differ. Returns whether a revision was appended.
 */
export async function appendThingPresentationRevision(
  thingId: number,
  prior: ThingPresentation,
  author: Readonly<{ id: number; relation: PresentationAuthorRelation }>,
  db: TaggedSql,
): Promise<boolean> {
  const current = await readThingPresentation(thingId, db)
  if (!current || samePresentation(prior, current)) return false
  await db`
    INSERT INTO drawing_revisions (
      target_type, target_id, slot_variant_name,
      prior_state, prior_description, prior_drawing, prior_source,
      prior_kind_id, prior_kind_revision, prior_variant_name,
      current_state, current_description, current_drawing, current_source,
      current_kind_id, current_kind_revision, current_variant_name,
      author_id, author_relation
    ) VALUES (
      'thing', ${thingId}, NULL,
      ${prior.state}, ${prior.description}, ${prior.drawing}::jsonb, ${prior.source},
      ${prior.kindId}::integer, ${prior.kindRevision}::integer, ${prior.variantName},
      ${current.state}, ${current.description}, ${current.drawing}::jsonb, ${current.source},
      ${current.kindId}::integer, ${current.kindRevision}::integer, ${current.variantName},
      ${author.id}, ${author.relation}
    )
  `
  return true
}
