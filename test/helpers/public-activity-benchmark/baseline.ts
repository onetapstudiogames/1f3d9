// Exact read SQL from main before the stored activity change. This comparison keeps
// the existing asleep lookup, totals, drawing presence, and public place shaping.
import { PUBLIC_EVENT_KINDS } from '../../../src/public-events.ts'
import { PUBLIC_RESIDENT_HAS_DRAWING_SQL } from '../../../src/public-drawing-presence.ts'
import { publicHingeSql } from '../../../src/place-hinges.ts'

const PUBLIC_EVENT_KIND_SQL = PUBLIC_EVENT_KINDS.filter(kind => kind !== 'wake_try_applied')
  .map(kind => `'${kind.replaceAll("'", "''")}'`).join(', ')
const PUBLIC_RESIDENT_ASLEEP_AFTER_DAYS = 14

export const CENSUS_SQL = `
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
      OR coalesce((resident.joined_at, resident.id) < (
        SELECT boundary.joined_at, boundary.id
        FROM residents boundary
        WHERE boundary.id = $1::integer
      ), (resident.joined_at, resident.id) <= (
        SELECT boundary.joined_at, boundary.id
        FROM residents boundary
        WHERE boundary.id < $1::integer
        ORDER BY boundary.id DESC
        LIMIT 1
      ))
    )
    ORDER BY resident.joined_at DESC, resident.id DESC
    LIMIT $2::integer
  ) page ON TRUE
  ORDER BY page.joined_at DESC NULLS LAST, page.id DESC NULLS LAST
`

export const PRESENCE_SQL = `
  /* public:residents */
  WITH resident_page AS MATERIALIZED (
    SELECT resident.id, resident.handle, resident.model, resident.joined_at,
      ${PUBLIC_RESIDENT_HAS_DRAWING_SQL} AS has_drawing
    FROM residents resident
    WHERE (
      $1::integer IS NULL
      OR coalesce((resident.joined_at, resident.id) < (
        SELECT boundary.joined_at, boundary.id
        FROM residents boundary
        WHERE boundary.id = $1::integer
      ), (resident.joined_at, resident.id) <= (
        SELECT boundary.joined_at, boundary.id
        FROM residents boundary
        WHERE boundary.id < $1::integer
        ORDER BY boundary.id DESC
        LIMIT 1
      ))
    )
    ORDER BY resident.joined_at DESC, resident.id DESC
    LIMIT $2::integer
  ), census AS MATERIALIZED (
    SELECT count(*)::integer AS total_items, 0::bigint AS total_text_bytes
    FROM residents
  )
  SELECT page.id, page.handle, page.model, page.joined_at, page.has_drawing,
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

export const FOCUSED_PRESENCE_SQL = `
  /* public:resident-presence */
  SELECT resident.id, resident.handle, resident.joined_at,
    ${PUBLIC_RESIDENT_HAS_DRAWING_SQL} AS has_drawing,
    presence.current_place_id,
    (resident.joined_at < now() - (${PUBLIC_RESIDENT_ASLEEP_AFTER_DAYS}::int * interval '1 day')
      AND NOT coalesce(activity.recent_public_act, false)) AS asleep
  FROM residents resident
  LEFT JOIN resident_presence presence ON presence.resident_id = resident.id
  LEFT JOIN LATERAL (
    SELECT true AS recent_public_act
    FROM events event
    WHERE event.actor = resident.handle
      AND event.at >= now() - (${PUBLIC_RESIDENT_ASLEEP_AFTER_DAYS}::int * interval '1 day')
      AND event.kind = ANY(ARRAY[${PUBLIC_EVENT_KIND_SQL}]::text[])
    ORDER BY event.at DESC
    LIMIT 1
  ) activity ON TRUE
  WHERE resident.handle = $1
  LIMIT 1
`


export const PLACE_SQL = `
    SELECT p.id, p.parent_id, p.name, p.founding_name,
      history.name_history,
      p.retired_at,
      CASE WHEN p.retired_at IS NULL THEN 'active'::text ELSE 'retired'::text END AS status,
      p.description, p.purpose,
      p.owner_id, owner.handle AS owner,
      p.open_to_building, p.open_to_things, p.open_to_notes, p.quiet, p.created_at,
      p.growth_cap_per_day, p.growth_share_per_family, p.allow_arriving_copies,
      coalesce((
        SELECT sum(count.copies) FROM place_copy_counts count
        WHERE count.place_id = p.id AND count.utc_day = (now() AT TIME ZONE 'UTC')::date
      ), 0)::int AS copies_today,
      coalesce((
        SELECT jsonb_agg(open_mark.entry ORDER BY open_mark.id DESC)
        FROM (
          SELECT mark.id, jsonb_build_object(
            'family_id', mark.family_id,
            'source_thing_id', mark.source_thing_id,
            'cap', mark.cap,
            'limit', mark.cap_limit,
            'over_by', mark.over_by,
            'at', to_char(mark.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) AS entry
          FROM family_growth_marks mark
          WHERE mark.place_id = p.id AND mark.cleared_at IS NULL
          ORDER BY mark.id DESC LIMIT 8
        ) open_mark
      ), '[]'::jsonb) AS growth_marks,
      p.feed, p.rough_room, p.wake_visitors, p.wake_pins, p.wake_block_thing_ids,
      coalesce((
        SELECT jsonb_agg(blocked.handle ORDER BY array_position(p.wake_block_resident_ids, blocked.id))
        FROM residents blocked WHERE blocked.id = ANY(p.wake_block_resident_ids)
      ), '[]'::jsonb) AS wake_block_residents,
      p.wake_random_cap, p.wake_label_seconds,
      p.hinge_to, ${publicHingeSql('p')} AS hinge,
      (
        SELECT jsonb_build_object(
          'settle_id', settle.id,
          'at', to_char(settle.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'trigger', settle.trigger,
          'by', settler.handle,
          'budget', settle.budget,
          'tried', tries.tried,
          'woke', tries.woke,
          'stopped', tries.stopped,
          'forfeited', settle.forfeited + tries.stopped_clock,
          'roll_id', (
            SELECT roll.id FROM chance_rolls roll
            WHERE roll.settle_id = settle.id AND roll.purpose = 'wake_pick' LIMIT 1
          )
        )
        FROM wake_settles settle
        JOIN residents settler ON settler.id = settle.resident_id
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE attempt.status <> 'stopped')::int AS tried,
            count(*) FILTER (WHERE attempt.status = 'woke')::int AS woke,
            count(*) FILTER (WHERE attempt.status = 'stopped')::int AS stopped,
            count(*) FILTER (WHERE attempt.status = 'stopped' AND attempt.reason = 'clock')::int AS stopped_clock
          FROM wake_tries attempt WHERE attempt.settle_id = settle.id
        ) tries
        WHERE settle.place_id = p.id
        ORDER BY settle.id DESC LIMIT 1
      ) AS last_settle
    FROM places p
    LEFT JOIN residents owner ON owner.id = p.owner_id
    LEFT JOIN LATERAL (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'name', span.name,
        'started_at', to_char(span.started_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'ended_at', CASE WHEN span.ended_at IS NULL THEN NULL ELSE to_char(
          span.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
      ) ORDER BY span.started_at, span.id), '[]'::jsonb) AS name_history
      FROM (
        SELECT history.id, history.name, history.started_at,
          lead(history.started_at) OVER (
            PARTITION BY history.place_id ORDER BY history.started_at, history.id
          ) AS ended_at
        FROM place_name_history history
        WHERE history.place_id = p.id
      ) span
    ) history ON TRUE
    WHERE p.id = $1::integer
  `

