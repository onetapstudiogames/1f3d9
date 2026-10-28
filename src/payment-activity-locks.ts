// Paid completion uses its immutable attempt to lock the responsible resident
// and existing affected room before its offer, asset or event checkpoint.
export const PAYMENT_ACTIVITY_LOCK_CTES = `activity_actor AS MATERIALIZED (
  SELECT resident.id FROM residents resident
  JOIN payment_attempts attempt ON attempt.actor_id = resident.id
  WHERE attempt.public_id = $1::text FOR NO KEY UPDATE OF resident
), activity_room_plan AS MATERIALIZED (
  WITH RECURSIVE ancestry AS (
    SELECT place.id AS origin, place.id, place.parent_id, 0 AS height
    FROM places place JOIN payment_attempts attempt ON place.id = CASE
      WHEN attempt.asset_type = 'place' THEN attempt.asset_id
      WHEN attempt.asset_type = 'thing' THEN (
        SELECT thing.place_id FROM things thing WHERE thing.id = attempt.asset_id
      ) END OR (attempt.operation IN ('place_rename', 'place_retire', 'place_restore')
        AND place.id = (SELECT parent_id FROM places WHERE id = attempt.asset_id))
    WHERE attempt.public_id = $1::text
    UNION ALL SELECT ancestry.origin, parent.id, parent.parent_id, ancestry.height + 1
      FROM ancestry JOIN places parent ON parent.id = ancestry.parent_id
  ) SELECT origin AS id, max(height) AS depth FROM ancestry GROUP BY origin
), activity_room AS MATERIALIZED (
  SELECT place.id FROM places place JOIN activity_room_plan planned ON planned.id = place.id
  WHERE EXISTS (SELECT 1 FROM activity_actor)
  ORDER BY planned.depth, place.id FOR NO KEY UPDATE OF place
)`

export const PAYMENT_ACTIVITY_LOCK_CHECK = `CASE
  WHEN attempt.asset_type IN ('place', 'thing') AND attempt.asset_id IS NOT NULL
    THEN EXISTS (SELECT 1 FROM activity_room)
  ELSE EXISTS (SELECT 1 FROM activity_actor) END`
