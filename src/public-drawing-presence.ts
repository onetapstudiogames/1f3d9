/** Whether the public thing thumbnail route can return a drawing. */
export const PUBLIC_THING_HAS_DRAWING_SQL = `CASE
  WHEN coalesce((
    SELECT moderation.action
    FROM moderation_actions moderation
    WHERE moderation.target_type = 'thing' AND moderation.target_id = thing.id
    ORDER BY moderation.created_at DESC, moderation.id DESC
    LIMIT 1
  ), 'restore') = 'remove' THEN false
  WHEN thing.kind_id IS NULL THEN thing.drawing IS NOT NULL
  WHEN thing.drawing_state = 'refused' THEN false
  WHEN coalesce((
    SELECT moderation.action
    FROM moderation_actions moderation
    WHERE moderation.target_type = 'kind' AND moderation.target_id = thing.kind_id
    ORDER BY moderation.created_at DESC, moderation.id DESC
    LIMIT 1
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
END`

/** Whether the public resident thumbnail route can return a drawing. */
export const PUBLIC_RESIDENT_HAS_DRAWING_SQL = `resident.drawing IS NOT NULL AND coalesce((
  SELECT moderation.action
  FROM moderation_actions moderation
  WHERE moderation.target_type = 'resident' AND moderation.target_id = resident.id
  ORDER BY moderation.created_at DESC, moderation.id DESC
  LIMIT 1
), 'restore') <> 'remove'`

const PUBLIC_EVENT_THING_ID_SQL = `CASE
  WHEN event.detail->>'asset_type' = 'thing'
    AND event.detail->>'asset_id' ~ '^[1-9][0-9]{0,9}$'
    AND (event.detail->>'asset_id')::bigint <= 2147483647
    THEN (event.detail->>'asset_id')::bigint::integer
  WHEN event.detail->>'thing_id' ~ '^[1-9][0-9]{0,9}$'
    AND (event.detail->>'thing_id')::bigint <= 2147483647
    THEN (event.detail->>'thing_id')::bigint::integer
  WHEN event.detail->>'source_thing_id' ~ '^[1-9][0-9]{0,9}$'
    AND (event.detail->>'source_thing_id')::bigint <= 2147483647
    THEN (event.detail->>'source_thing_id')::bigint::integer
  ELSE NULL::integer
END`

/** One body-free drawing-presence lookup for a safely identified event thing. */
export const PUBLIC_EVENT_THING_DRAWING_JOIN_SQL = `LEFT JOIN LATERAL (
  SELECT ${PUBLIC_THING_HAS_DRAWING_SQL} AS has_drawing
  FROM things thing
  WHERE thing.id = (${PUBLIC_EVENT_THING_ID_SQL})
    AND thing.withdrawn_at IS NULL
  LIMIT 1
) event_thing ON TRUE`
