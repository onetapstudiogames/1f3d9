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
-- It is PL/pgSQL with no queries inside, so each event insert pays a few microseconds for
-- it; a SQL function with subqueries is planned again for every insert statement, which
-- measured about ten times the cost per insert.
-- The index stores this function's results, so the function is never edited in place: a
-- different key rule ships under a new function name with a new index.
CREATE OR REPLACE FUNCTION public.event_room_keys(detail jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $event_room_keys$
DECLARE
  keys text[] := '{}'::text[];
  outcomes jsonb := detail->'applied_public_activity';
  named text;
  key text;
  entry integer;
BEGIN
  FOREACH named IN ARRAY ARRAY[
    detail->>'place_id', detail->>'from_place_id', detail->>'to_place_id', detail->>'hinge_to',
    CASE WHEN detail->>'asset_type' = 'place' THEN detail->>'asset_id' END,
    CASE WHEN detail->>'type' = 'place' THEN detail->>'id' END
  ]::text[] LOOP
    IF named ~ '^[1-9][0-9]{0,9}$' THEN
      key := 'p'::text || named;
      IF NOT key = ANY(keys) THEN keys := keys || key; END IF;
    END IF;
  END LOOP;
  IF jsonb_typeof(outcomes) = 'array' THEN
    FOR entry IN 0 .. jsonb_array_length(outcomes) - 1 LOOP
      named := outcomes->entry->>'place_id';
      IF named ~ '^[1-9][0-9]{0,9}$' THEN
        key := 'p'::text || named;
        IF NOT key = ANY(keys) THEN keys := keys || key; END IF;
      END IF;
    END LOOP;
  END IF;
  FOREACH named IN ARRAY ARRAY[
    't' || (detail->>'thing_id'),
    't' || CASE WHEN detail->>'asset_type' = 'thing' THEN detail->>'asset_id' END,
    't' || CASE WHEN detail->>'type' = 'thing' THEN detail->>'id' END,
    'n' || (detail->>'note_id'),
    'o' || (detail->>'offer_id')
  ]::text[] LOOP
    IF named ~ '^[tno][0-9]{1,9}$' THEN
      key := left(named, 1) || ((substr(named, 2))::integer)::text;
      IF NOT key = ANY(keys) THEN keys := keys || key; END IF;
    END IF;
  END LOOP;
  RETURN keys;
END
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
