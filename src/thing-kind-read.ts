/**
 * Every read of a thing shows the kind it is now (kind, kind_id, current_revision)
 * and the kind and revision it was born as (born_as), and its generation
 * (decisions #114 and #115). List rows add these columns beside their effective
 * kind columns; the one-thing read in src/public-records.ts builds the same shape,
 * and the thing_edit and thing_upgrade answers are that one-thing read.
 *
 * `alias` is always a table alias written in the calling query, never caller input.
 */
export function thingBornAsColumnsSql(alias: string): string {
  return `(
      SELECT CASE WHEN birth.kind_id IS NULL THEN NULL ELSE jsonb_build_object(
        'kind', birth.kind, 'kind_id', birth.kind_id, 'revision', birth.revision
      ) END
      FROM (
        SELECT ${alias}.kind_id, ${alias}.birth_revision AS revision,
          (SELECT born.name FROM kinds born WHERE born.id = ${alias}.kind_id) AS kind
      ) birth
    ) AS born_as, ${alias}.generation`
}
