BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- One room's events history (GET /api/events with place_id or within_place_id) finds its
-- candidate events through the GIN index events_room_keys, built in the next migration
-- over this function. The function reads only an event's own detail, which never changes
-- (events are append-only), and lists the keys that detail names:
--   p<id>  a room named by place_id, from_place_id, to_place_id, hinge_to, asset_id when
--          asset_type is place, id when type is place, or the place_id of any entry of
--          applied_public_activity; kept as the raw text, only when it reads as a positive
--          room number, since the read compares that text to a room id's text;
--   t<id>  a thing named by thing_id, asset_id when asset_type is thing, or id when type is
--          thing; n<id> a note named by note_id; o<id> an offer named by offer_id; each only
--          when the text is 1 to 9 digits, cast as the read casts it.
-- Everything that can change (where a thing or note is now, withdrawals, offers, the room
-- tree, feed rooms, moderation) is still checked by the read itself, so the index only
-- narrows the events it looks at and never changes the answer.
-- The index stores this function's results, so the function is never edited in place: a
-- different key rule ships under a new function name with a new index.
CREATE OR REPLACE FUNCTION public.event_room_keys(detail jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $event_room_keys$
  SELECT coalesce(array_agg(DISTINCT key.value), '{}'::text[])
  FROM (
    SELECT CASE WHEN named.value ~ '^[1-9][0-9]{0,9}$' THEN 'p'::text || named.value END
    FROM (VALUES
      (detail->>'place_id'),
      (detail->>'from_place_id'),
      (detail->>'to_place_id'),
      (detail->>'hinge_to'),
      (CASE WHEN detail->>'asset_type' = 'place' THEN detail->>'asset_id' END),
      (CASE WHEN detail->>'type' = 'place' THEN detail->>'id' END)
    ) named(value)
    UNION ALL
    SELECT CASE WHEN outcome->>'place_id' ~ '^[1-9][0-9]{0,9}$'
      THEN 'p'::text || (outcome->>'place_id') END
    FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(detail->'applied_public_activity') = 'array'
      THEN detail->'applied_public_activity' ELSE '[]'::jsonb END) outcome
    UNION ALL
    SELECT CASE WHEN named.value ~ '^[0-9]{1,9}$'
      THEN named.prefix || ((named.value)::integer)::text END
    FROM (VALUES
      ('t'::text, detail->>'thing_id'),
      ('t'::text, CASE WHEN detail->>'asset_type' = 'thing' THEN detail->>'asset_id' END),
      ('t'::text, CASE WHEN detail->>'type' = 'thing' THEN detail->>'id' END),
      ('n'::text, detail->>'note_id'),
      ('o'::text, detail->>'offer_id')
    ) named(prefix, value)
  ) key(value)
  WHERE key.value IS NOT NULL
$event_room_keys$;

DO $event_room_keys_check$
DECLARE
  installed record;
BEGIN
  SELECT provolatile, proparallel, proisstrict INTO STRICT installed
  FROM pg_proc WHERE oid = 'public.event_room_keys(jsonb)'::regprocedure;
  IF installed.provolatile <> 'i' OR installed.proparallel <> 's' OR NOT installed.proisstrict THEN
    RAISE EXCEPTION 'public.event_room_keys(jsonb) must be immutable, parallel safe and strict';
  END IF;
  -- A rerun may never swap the body under a built index: any index over the function means
  -- the key rule is fixed, and a different rule needs a new function name.
  IF EXISTS (
    SELECT 1 FROM pg_depend
    WHERE classid = 'pg_class'::regclass
      AND refclassid = 'pg_proc'::regclass
      AND refobjid = 'public.event_room_keys(jsonb)'::regprocedure
  ) THEN
    RAISE EXCEPTION 'an index already depends on public.event_room_keys(jsonb); never edit the key function in place';
  END IF;
END
$event_room_keys_check$;

COMMIT;
