BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '180s';

CREATE OR REPLACE FUNCTION protect_place_topology() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  parent_kind TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.place_kind = 'world' THEN
      RAISE EXCEPTION 'the world is transit only and cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.place_kind = 'world' THEN
      -- The system-owned activity summary is not a public place edit.
      IF to_jsonb(NEW) ? 'last_public_action_at'
        AND to_jsonb(OLD) ? 'last_public_action_at'
        AND to_jsonb(NEW)->'last_public_action_at' IS DISTINCT FROM to_jsonb(OLD)->'last_public_action_at'
        AND to_jsonb(NEW) - 'last_public_action_at' = to_jsonb(OLD) - 'last_public_action_at' THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'the world is transit only and immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.place_kind IS DISTINCT FROM OLD.place_kind THEN
      RAISE EXCEPTION 'place kind is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.place_kind = 'world' THEN
    RETURN NEW;
  END IF;

  SELECT place.place_kind
  INTO parent_kind
  FROM places AS place
  WHERE place.id = NEW.parent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'place parent does not exist' USING ERRCODE = '23503';
  END IF;

  IF NEW.place_kind = 'continent' AND parent_kind <> 'world' THEN
    RAISE EXCEPTION 'continents must be direct children of the world'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.place_kind = 'place' AND parent_kind = 'world' THEN
    RAISE EXCEPTION 'only continents may be created directly under the world'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id AND EXISTS (
    WITH RECURSIVE ancestry(id, parent_id, path) AS (
      SELECT place.id, place.parent_id, ARRAY[place.id]
      FROM places AS place
      WHERE place.id = NEW.parent_id
      UNION ALL
      SELECT parent.id, parent.parent_id, ancestry.path || parent.id
      FROM places AS parent
      JOIN ancestry ON parent.id = ancestry.parent_id
      WHERE NOT parent.id = ANY(ancestry.path)
    )
    SELECT 1 FROM ancestry WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a place cannot become its own ancestor'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION protect_gazette_submission_room()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.id = 454 THEN
      RAISE EXCEPTION 'Gazette room #454 is a protected city service; it cannot be deleted, traded, transferred, or repurposed'
        USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.id = 454 AND gazette_submission_room_state(NEW) <> 'closed' THEN
      RAISE EXCEPTION 'Gazette room #454 must begin as the exact closed submission shell described by the city contract'
        USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.id <> 454 AND NEW.id <> 454 THEN
    RETURN NEW;
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'Gazette room #454 is a protected city service; its identity cannot change'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  -- The system-owned activity summary preserves the exact protected room state.
  IF to_jsonb(NEW) ? 'last_public_action_at'
    AND to_jsonb(OLD) ? 'last_public_action_at'
    AND to_jsonb(NEW)->'last_public_action_at' IS DISTINCT FROM to_jsonb(OLD)->'last_public_action_at'
    AND to_jsonb(NEW) - 'last_public_action_at' = to_jsonb(OLD) - 'last_public_action_at'
    AND gazette_submission_room_state(NEW) IN ('closed', 'open', 'withdrawals_open')
    AND gazette_submission_room_state(NEW) = gazette_submission_room_state(OLD)
    AND gazette_submission_room_has_no_forbidden_contents()
    AND gazette_submission_room_guards_ready() THEN
    RETURN NEW;
  END IF;

  IF gazette_submission_room_state(OLD) = 'closed'
    AND gazette_submission_room_state(NEW) = 'open'
    AND to_regclass('public.gazette_issues') IS NOT NULL
    AND to_regclass('public.gazette_issue_entries') IS NOT NULL
    AND to_regclass('city_snapshot.public_records_v2') IS NOT NULL
    AND gazette_submission_room_has_no_forbidden_contents()
    AND gazette_submission_room_guards_ready()
    AND NOT EXISTS (SELECT 1 FROM notes WHERE place_id = 454)
    AND (
      SELECT count(*)
      FROM events event
      WHERE event.kind = 'place_edited'
        AND event.actor = 'the city'
        AND event.detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
    ) = 1
  THEN
    RETURN NEW;
  END IF;

  IF gazette_submission_room_state(OLD) = 'open'
    AND gazette_submission_room_state(NEW) = 'withdrawals_open'
    AND gazette_submission_room_has_no_forbidden_contents()
    AND gazette_submission_room_guards_ready()
    AND (
      SELECT count(*)
      FROM events event
      WHERE event.kind = 'place_edited'
        AND event.actor = 'the city'
        AND event.detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
    ) = 1
    AND (
      SELECT count(*)
      FROM events event
      WHERE event.kind = 'place_edited'
        AND event.actor = 'the city'
        AND event.detail = '{"place_id":454,"gazette_withdrawals_opened":true}'::jsonb
    ) = 1
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Gazette room #454 is a protected city service; it must remain one exact contract state and change only through guarded activation'
    USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
END
$$;

CREATE OR REPLACE FUNCTION reject_retired_place_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_place_id INTEGER;
  target_retired_at TIMESTAMPTZ;
BEGIN
  IF TG_TABLE_NAME = 'places' THEN
    target_place_id := NEW.parent_id;
  ELSIF TG_TABLE_NAME = 'things' THEN
    IF NEW.withdrawn_at IS NOT NULL THEN RETURN NEW; END IF;
    target_place_id := NEW.place_id;
  ELSIF TG_TABLE_NAME = 'notes' THEN
    target_place_id := NEW.place_id;
  ELSE
    -- Initializers lock their candidate rooms before presence. Retained targets
    -- need no new room lock after an UPDATE has already taken the presence row.
    IF NEW.current_place_id IS NOT NULL
      AND (TG_OP = 'INSERT' OR NEW.current_place_id IS DISTINCT FROM OLD.current_place_id) THEN
      SELECT retired_at INTO target_retired_at
      FROM places WHERE id = NEW.current_place_id FOR SHARE;
      IF target_retired_at IS NOT NULL THEN
        RAISE EXCEPTION 'retired place cannot receive resident presence'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    target_place_id := CASE
      WHEN TG_OP = 'INSERT' OR NEW.home_place_id IS DISTINCT FROM OLD.home_place_id
      THEN NEW.home_place_id ELSE NULL END;
  END IF;
  IF target_place_id IS NOT NULL THEN
    SELECT retired_at INTO target_retired_at
    FROM places WHERE id = target_place_id FOR SHARE;
    IF target_retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'retired place cannot receive %', CASE TG_TABLE_NAME
        WHEN 'places' THEN 'subplaces'
        WHEN 'things' THEN 'things'
        WHEN 'notes' THEN 'notes'
        ELSE 'resident homes'
      END USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Stored public activity summaries, decision #166.
-- This is the existing event-write exclusion used by schema backfills.
LOCK TABLE events IN SHARE ROW EXCLUSIVE MODE;

DO $shape$
DECLARE present integer;
BEGIN
  SELECT count(*) INTO present FROM pg_attribute
  WHERE (attrelid = 'residents'::regclass AND attname IN ('show_activity','last_public_action_at')
    OR attrelid = 'places'::regclass AND attname = 'last_public_action_at') AND NOT attisdropped;
  IF present NOT IN (0,3) THEN RAISE EXCEPTION 'partial stored activity shape'; END IF;
  IF present = 3 AND to_regclass('public.public_activity_schema_state') IS NULL THEN
    RAISE EXCEPTION 'stored activity columns have no reviewed receipt';
  END IF;
END $shape$;

ALTER TABLE residents ADD COLUMN IF NOT EXISTS last_public_action_at timestamptz;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS show_activity boolean NOT NULL DEFAULT true;
ALTER TABLE places ADD COLUMN IF NOT EXISTS last_public_action_at timestamptz;

DO $types$
BEGIN
  IF (SELECT count(*) FROM pg_attribute a LEFT JOIN pg_attrdef d ON
      d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE NOT a.attisdropped AND (
    a.attrelid IN ('residents'::regclass,'places'::regclass)
      AND a.attname='last_public_action_at' AND a.atttypid='timestamptz'::regtype
      AND NOT a.attnotnull AND d.oid IS NULL
    OR a.attrelid='residents'::regclass AND a.attname='show_activity'
      AND a.atttypid='boolean'::regtype AND a.attnotnull
      AND pg_get_expr(d.adbin,d.adrelid)='true')) <> 3 THEN
    RAISE EXCEPTION 'stored activity column type/default mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='resident_settings'::regclass
    AND attname='show_activity' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'duplicate stored activity choice';
  END IF;
END $types$;

CREATE TABLE IF NOT EXISTS public_activity_schema_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  migration_identity text NOT NULL CHECK (migration_identity='stored-public-activity'),
  schema_version integer NOT NULL CHECK (schema_version=1),
  cut_change_id bigint NOT NULL,
  backfilled_at timestamptz NOT NULL,
  event_count bigint NOT NULL,
  known_residents bigint NOT NULL,
  known_places bigint NOT NULL,
  no_history_residents bigint NOT NULL,
  no_history_places bigint NOT NULL,
  unproved_residents bigint NOT NULL,
  unproved_places bigint NOT NULL,
  unproved_candidates bigint NOT NULL,
  unproved_reasons jsonb NOT NULL
);
REVOKE ALL ON public_activity_schema_state FROM PUBLIC;

CREATE OR REPLACE FUNCTION public_activity_id(value text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN value ~ '^[1-9][0-9]{0,9}$' THEN
    CASE WHEN value::numeric <= 2147483647 THEN value::integer END END
$f$;

-- Historical room reconstruction uses immutable links and creation/move chains.
-- It deliberately never consults the present location of a thing or resident.
CREATE OR REPLACE FUNCTION public_activity_room(event_id bigint, event_kind text, event_actor text, event_detail jsonb)
RETURNS integer LANGUAGE plpgsql STABLE AS $f$
DECLARE room integer; thing integer; asset_kind text; asset integer;
BEGIN
  IF event_kind = 'action' AND event_detail->>'action' IN ('move','go_home') THEN
    room := public_activity_id(event_detail->>'to_place_id');
  ELSE room := public_activity_id(event_detail->>'place_id'); END IF;
  IF room IS NOT NULL THEN RETURN room; END IF;
  IF event_kind = 'note' THEN
    SELECT place_id INTO room FROM notes WHERE id=public_activity_id(event_detail->>'note_id');
  ELSIF event_kind = 'line_said' THEN
    SELECT place_id INTO room FROM room_lines WHERE id=public_activity_id(event_detail->>'line_id');
  ELSIF event_kind IN ('ping_sent','ping_answered') THEN
    SELECT place_id INTO room FROM pings WHERE id=public_activity_id(event_detail->>'ping_id');
  ELSIF event_kind = 'action' THEN
    SELECT CASE WHEN action.action_name IN ('move','go_home') THEN action.destination_place_id ELSE action.place_id END
      INTO room FROM action_runs action JOIN residents actor ON actor.id=action.actor_id AND actor.handle=event_actor
      JOIN action_resolutions resolution ON resolution.action_run_id=action.id AND resolution.status='applied'
      WHERE action.id::text=event_detail->>'action_id' AND action.action_name=event_detail->>'action';
  ELSIF event_kind = 'effect_scheduled' THEN
    SELECT pending.place_id INTO room FROM pending_effects pending
      JOIN residents actor ON actor.id=pending.actor_id AND actor.handle=event_actor
      WHERE pending.id::text=coalesce(event_detail->>'effect_id',event_detail->>'pending_effect_id');
  END IF;
  IF room IS NOT NULL THEN RETURN room; END IF;
  SELECT coalesce(event_detail->>'asset_type',event_detail->>'type',offer.asset_type),
    coalesce(public_activity_id(event_detail->>'asset_id'),public_activity_id(event_detail->>'id'),offer.asset_id)
    INTO asset_kind,asset FROM (VALUES (true)) singleton(value)
    LEFT JOIN transfer_offers offer ON offer.id=public_activity_id(event_detail->>'offer_id');
  IF event_detail->>'target_type'='place' THEN RETURN public_activity_id(event_detail->>'target_id'); END IF;
  IF asset_kind='place' THEN RETURN asset; END IF;
  thing := coalesce(public_activity_id(event_detail->>'thing_id'),CASE WHEN asset_kind='thing' THEN asset END,
    CASE WHEN event_detail->>'target_type'='thing' THEN public_activity_id(event_detail->>'target_id') END);
  IF thing IS NULL THEN RETURN NULL; END IF;
  WITH chain AS (
    SELECT history.kind, public_activity_id(history.detail->>'place_id') AS destination,
      public_activity_id(history.detail->>'from_place_id') AS origin,
      row_number() OVER (ORDER BY change.change_id) AS position,
      lag(public_activity_id(history.detail->>'place_id')) OVER (ORDER BY change.change_id) AS previous_destination,
      change.change_id
    FROM events history JOIN public_change_log change ON change.event_id=history.id
    JOIN public_change_log current_change ON current_change.event_id=public_activity_room.event_id
    WHERE history.kind IN ('thing_created','thing_crafted','thing_moved')
      AND history.detail->>'thing_id'=thing::text AND change.change_id<=current_change.change_id
  ) SELECT (array_agg(destination ORDER BY change_id DESC))[1] INTO room FROM chain
    HAVING count(*) FILTER (WHERE kind IN ('thing_created','thing_crafted'))=1
      AND bool_and(destination IS NOT NULL AND CASE WHEN position=1
        THEN kind IN ('thing_created','thing_crafted')
        ELSE kind='thing_moved' AND origin IS NOT NULL AND origin=previous_destination END);
  RETURN room;
END $f$;

CREATE OR REPLACE FUNCTION public_activity_visible(event_kind text, detail jsonb, room integer)
RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT event_kind IN ('flag','moderation','payment_repair') OR NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('resident',public_activity_id(detail->>'resident_id')),('place',room),
      ('thing',public_activity_id(detail->>'thing_id')),('kind',public_activity_id(detail->>'kind_id')),
      ('trait',public_activity_id(detail->>'trait_id')),('note',public_activity_id(detail->>'note_id')),
      ('agreement',public_activity_id(detail->>'agreement_id')),('line',public_activity_id(detail->>'line_id')),
      ('ping',public_activity_id(detail->>'ping_id')),
      (detail->>'target_type',public_activity_id(detail->>'target_id'))
    ) target(type,id) JOIN LATERAL (
      SELECT action FROM moderation_actions moderation
      WHERE moderation.target_type=target.type AND moderation.target_id=target.id
      ORDER BY moderation.created_at DESC,moderation.id DESC LIMIT 1
    ) latest ON latest.action='remove' WHERE target.id IS NOT NULL
  )
$f$;

CREATE OR REPLACE FUNCTION public_activity_feed_room(room integer)
RETURNS boolean LANGUAGE sql STABLE AS $f$
  WITH RECURSIVE ancestry AS (
    SELECT id,parent_id,feed FROM places WHERE id=room
    UNION ALL SELECT parent.id,parent.parent_id,parent.feed FROM places parent JOIN ancestry ON parent.id=ancestry.parent_id
  ) SELECT coalesce(bool_or(feed),false) FROM ancestry
$f$;

CREATE OR REPLACE FUNCTION public_activity_potential_kind(event_kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$
  SELECT event_kind IN ('register','rotate','resident_edited','home_set','place_created','place_edited','place_renamed',
    'place_retired','place_restored','kind_invented','kind_revised','trait_coined','thing_created','thing_crafted',
    'thing_edited','thing_moved','thing_upgraded','thing_withdrawn','laws_changed','action','effect_scheduled',
    'effect_resolved','room_reached','wake_try_applied','note','line_said','ping_sent','ping_answered',
    'gazette_printed','agreement','agreement_accession','agreement_sign','transfer','transfer_offer','sale',
    'transfer_cancel','world_listed','world_sale','world_cancel','payment_repair','flag','moderation')
$f$;

-- An explicit empty array proves a no-op. Absent historical evidence is unknown.
CREATE OR REPLACE FUNCTION public_activity_candidates(event_id bigint, event_kind text, event_actor text, event_detail jsonb)
RETURNS TABLE(actor_handle text, place_id integer, proved boolean)
LANGUAGE plpgsql STABLE AS $f$
DECLARE room integer; entry jsonb; changed boolean; previous jsonb; feed_content boolean; global_event boolean;
BEGIN
  IF event_kind IN ('chance_rolled','copy_skipped','room_settled') THEN RETURN; END IF;
  IF NOT public_activity_potential_kind(event_kind) THEN RETURN; END IF;
  IF event_detail ? 'applied_public_activity' THEN
    IF jsonb_typeof(event_detail->'applied_public_activity') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'invalid explicit applied public activity';
    END IF;
    FOR entry IN SELECT DISTINCT value FROM jsonb_array_elements(event_detail->'applied_public_activity') LOOP
      IF jsonb_typeof(entry) <> 'object' OR coalesce(entry->>'actor','')=''
        OR coalesce(entry->>'operation','')='' OR NOT entry ? 'place_id'
        OR (entry->'place_id'<>'null'::jsonb AND public_activity_id(entry->>'place_id') IS NULL) THEN
        RAISE EXCEPTION 'invalid explicit applied public activity';
      END IF;
      room := public_activity_id(entry->>'place_id');
      IF public_activity_visible(event_kind,event_detail || entry,room) THEN
        actor_handle := CASE WHEN (event_kind IN ('note','line_said','ping_sent','ping_answered','thing_created',
          'thing_crafted','thing_edited','thing_moved','thing_upgraded','thing_withdrawn')
          OR entry->>'target_type'='thing' AND entry->>'operation' IN ('label','destroy','move','write','copy','convert'))
          AND public_activity_feed_room(room) THEN NULL ELSE entry->>'actor' END;
        place_id := room; proved := true; RETURN NEXT;
      END IF;
    END LOOP;
    RETURN;
  END IF;
  IF event_kind IN ('action','effect_resolved') AND event_detail->>'status' IS DISTINCT FROM 'applied' THEN RETURN; END IF;
  room := public_activity_room(event_id,event_kind,event_actor,event_detail);
  IF NOT public_activity_visible(event_kind,event_detail,room) THEN RETURN; END IF;
  global_event := event_kind IN ('register','rotate','resident_edited','kind_invented','kind_revised','trait_coined',
    'agreement','agreement_accession','agreement_sign','flag','moderation','payment_repair')
    OR (event_kind IN ('transfer','transfer_offer','sale','transfer_cancel') AND coalesce(event_detail->>'asset_type',event_detail->>'type')='kind');
  changed := true;
  IF event_kind IN ('action','effect_resolved','room_reached','wake_try_applied') THEN
    changed := NULL;
    IF event_kind='action' AND event_detail->>'action' IN ('move','go_home') THEN
      SELECT CASE WHEN action.destination_place_id IS NOT NULL
        THEN action.place_id IS DISTINCT FROM action.destination_place_id END INTO changed
      FROM action_runs action JOIN residents actor ON actor.id=action.actor_id AND actor.handle=event_actor
      JOIN action_resolutions resolution ON resolution.action_run_id=action.id AND resolution.status='applied'
      WHERE action.id::text=event_detail->>'action_id' AND action.action_name=event_detail->>'action';
    ELSIF event_detail->>'effects_applied'='0' THEN RETURN;
    END IF;
  ELSIF event_kind IN ('home_set','laws_changed') THEN
    SELECT history.detail INTO previous FROM events history
      JOIN public_change_log change ON change.event_id=history.id
      JOIN public_change_log current_change ON current_change.event_id=public_activity_candidates.event_id
      WHERE history.kind=event_kind AND change.change_id<current_change.change_id
        AND CASE WHEN event_kind='home_set' THEN history.actor=event_actor
          ELSE history.detail->>'place_id'=event_detail->>'place_id' END
      ORDER BY change.change_id DESC LIMIT 1;
    IF event_kind='home_set' THEN changed := CASE WHEN public_activity_id(previous->>'place_id') IS NOT NULL
      THEN room IS NOT NULL AND room IS DISTINCT FROM public_activity_id(previous->>'place_id') END;
    ELSE changed := CASE WHEN jsonb_typeof(event_detail->'traits')='array'
      THEN event_detail->'traits' IS DISTINCT FROM coalesce(previous->'traits','[]'::jsonb) ELSE NULL END; END IF;
  END IF;
  IF changed IS FALSE THEN RETURN; END IF;
  feed_content := event_kind IN ('note','line_said','ping_sent','ping_answered','thing_created','thing_crafted',
    'thing_edited','thing_moved','thing_upgraded','thing_withdrawn');
  actor_handle := CASE WHEN feed_content AND public_activity_feed_room(room) THEN NULL ELSE event_actor END;
  place_id := CASE WHEN global_event THEN NULL ELSE room END; proved := changed IS TRUE; RETURN NEXT;
  IF NOT global_event AND room IS NULL AND changed IS TRUE THEN
    actor_handle := NULL; place_id := NULL; proved := false; RETURN NEXT;
  END IF;
END $f$;

CREATE OR REPLACE FUNCTION public_activity_history()
RETURNS TABLE(event_at timestamptz, actor_handle text, place_id integer, proved boolean)
LANGUAGE sql STABLE AS $f$
  SELECT event.at,activity.actor_handle,activity.place_id,activity.proved FROM events event
  CROSS JOIN LATERAL public_activity_candidates(event.id,event.kind,event.actor,event.detail) activity
$f$;

CREATE OR REPLACE FUNCTION public_activity_summaries()
RETURNS TABLE(resident_id integer, place_id integer, last_at timestamptz, uncertain boolean, unproved_count bigint)
LANGUAGE sql STABLE AS $f$
  WITH history AS MATERIALIZED (SELECT * FROM public_activity_history()),
  actor_history AS (
    SELECT actor_handle,max(event_at) FILTER (WHERE proved) AS known_at,
      max(event_at) FILTER (WHERE NOT proved) AS unknown_at FROM history GROUP BY actor_handle
  ), room_history AS (
    SELECT place_id,max(event_at) FILTER (WHERE proved) AS known_at,
      max(event_at) FILTER (WHERE NOT proved) AS unknown_at FROM history GROUP BY place_id
  ), possible_rooms AS (
    SELECT max(event_at) AS unknown_at FROM history WHERE NOT proved AND place_id IS NULL
  ), resident_summary AS (
    SELECT resident.id,known_at,unknown_at FROM residents resident
      LEFT JOIN actor_history ON actor_history.actor_handle=resident.handle
  ), room_summary AS (
    SELECT room.id,known_at,greatest(room_history.unknown_at,possible_rooms.unknown_at) AS unknown_at
      FROM places room LEFT JOIN room_history ON room_history.place_id=room.id CROSS JOIN possible_rooms
  )
  SELECT id,NULL::integer,CASE WHEN unknown_at IS NULL OR known_at>=unknown_at THEN known_at END,
    unknown_at IS NOT NULL AND (known_at IS NULL OR known_at<unknown_at),0::bigint FROM resident_summary
  UNION ALL
  SELECT NULL::integer,id,CASE WHEN unknown_at IS NULL OR known_at>=unknown_at THEN known_at END,
    unknown_at IS NOT NULL AND (known_at IS NULL OR known_at<unknown_at),0::bigint FROM room_summary
  UNION ALL
  SELECT NULL::integer,NULL::integer,NULL::timestamptz,false,count(*) FROM history WHERE NOT proved
$f$;

CREATE OR REPLACE FUNCTION public_activity_invalidation_scope(input_actor_id integer, input_type text, input_id integer)
RETURNS TABLE(resident_id integer, place_id integer) LANGUAGE sql STABLE AS $f$
  WITH activity_target AS MATERIALIZED (
    SELECT input_actor_id AS actor_id,input_type AS type,input_id AS id
  ), activity_scope AS MATERIALIZED (
    WITH RECURSIVE descendants AS (
      SELECT place.id FROM places place CROSS JOIN activity_target target WHERE target.type='place' AND place.id=target.id
      UNION ALL SELECT place.id FROM places place JOIN descendants ON place.parent_id=descendants.id
    ) SELECT id FROM descendants
  ), activity_thing_footprints AS MATERIALIZED (
    SELECT DISTINCT history.detail->>'thing_id' AS thing_id FROM events history
    WHERE history.kind IN ('thing_created','thing_crafted','thing_moved')
      AND EXISTS (SELECT 1 FROM activity_scope scope WHERE scope.id::text IN
        (history.detail->>'place_id',history.detail->>'from_place_id'))
  ), activity_event_rows AS MATERIALIZED (
    SELECT event.*,CASE WHEN event.kind='action' AND event.detail->>'action' IN ('move','go_home')
      THEN coalesce(public_activity_id(event.detail->>'to_place_id'),action.destination_place_id)
      ELSE coalesce(public_activity_id(event.detail->>'place_id'),note.place_id,line.place_id,ping.place_id,pending.place_id,
        action.place_id,CASE WHEN event.detail->>'target_type'='place' THEN public_activity_id(event.detail->>'target_id') END,
        CASE WHEN coalesce(event.detail->>'asset_type',event.detail->>'type',offer.asset_type)='place'
          THEN coalesce(public_activity_id(event.detail->>'asset_id'),public_activity_id(event.detail->>'id'),offer.asset_id) END) END AS recorded_place,
      action.source_thing_id,action.target_type AS action_target_type,action.target_id AS action_target_id,
      coalesce(event.detail->>'asset_type',event.detail->>'type',offer.asset_type) AS activity_asset_type,
      coalesce(public_activity_id(event.detail->>'asset_id'),public_activity_id(event.detail->>'id'),offer.asset_id) AS activity_asset_id
    FROM events event
    LEFT JOIN notes note ON event.kind='note' AND note.id=public_activity_id(event.detail->>'note_id')
    LEFT JOIN room_lines line ON event.kind='line_said' AND line.id=public_activity_id(event.detail->>'line_id')
    LEFT JOIN pings ping ON event.kind IN ('ping_sent','ping_answered') AND ping.id=public_activity_id(event.detail->>'ping_id')
    LEFT JOIN pending_effects pending ON event.kind='effect_scheduled'
      AND pending.id=coalesce(public_activity_id(event.detail->>'effect_id'),public_activity_id(event.detail->>'pending_effect_id'))
    LEFT JOIN action_runs action ON event.kind='action' AND action.id=public_activity_id(event.detail->>'action_id')
    LEFT JOIN transfer_offers offer ON offer.id=public_activity_id(event.detail->>'offer_id')
  ), activity_sources AS MATERIALIZED (
    SELECT event.* FROM activity_event_rows event CROSS JOIN activity_target target
    WHERE event.detail->>(target.type || '_id')=target.id::text
      OR event.detail->>'target_type'=target.type AND event.detail->>'target_id'=target.id::text
      OR event.detail->>'asset_type'=target.type AND event.detail->>'asset_id'=target.id::text
      OR event.detail->>'type'=target.type AND event.detail->>'id'=target.id::text
      OR event.activity_asset_type=target.type AND event.activity_asset_id=target.id
      OR event.action_target_type=target.type AND event.action_target_id=target.id
      OR target.type='thing' AND event.source_thing_id=target.id
      OR target.type='resident' AND event.actor=(SELECT handle FROM residents WHERE id=target.id)
      OR target.type='place' AND (EXISTS (SELECT 1 FROM activity_scope scope WHERE scope.id=event.recorded_place)
        OR EXISTS (SELECT 1 FROM activity_thing_footprints footprint WHERE footprint.thing_id=coalesce(event.detail->>'thing_id',
          CASE WHEN event.activity_asset_type='thing' THEN event.activity_asset_id::text END)))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(event.detail->'applied_public_activity')='array' THEN event.detail->'applied_public_activity' ELSE '[]'::jsonb END) outcome WHERE
        outcome->>'target_type'=target.type AND outcome->>'target_id'=target.id::text
        OR target.type='place' AND EXISTS (SELECT 1 FROM activity_scope scope WHERE scope.id::text=outcome->>'place_id'))
  ), activity_handles AS MATERIALIZED (
    SELECT actor AS handle FROM activity_sources
    UNION SELECT outcome->>'actor' FROM activity_sources event CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(event.detail->'applied_public_activity')='array' THEN event.detail->'applied_public_activity' ELSE '[]'::jsonb END) outcome
    UNION SELECT resident.handle FROM residents resident CROSS JOIN activity_target target WHERE resident.id=target.actor_id
  ), activity_selected_residents AS MATERIALIZED (
    SELECT resident.id FROM residents resident JOIN activity_handles ON activity_handles.handle=resident.handle
  ), activity_place_ids AS MATERIALIZED (
    SELECT id FROM activity_scope
    UNION SELECT recorded_place FROM activity_sources WHERE recorded_place IS NOT NULL
    UNION SELECT public_activity_id(outcome->>'place_id') FROM activity_sources event
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(event.detail->'applied_public_activity')='array' THEN event.detail->'applied_public_activity' ELSE '[]'::jsonb END) outcome
    UNION SELECT place.id FROM places place WHERE EXISTS (SELECT 1 FROM activity_sources event
      WHERE event.recorded_place IS NULL AND jsonb_typeof(event.detail->'applied_public_activity') IS DISTINCT FROM 'array'
        AND (event.activity_asset_type IS DISTINCT FROM 'kind' OR event.kind NOT IN ('transfer','transfer_offer','sale','transfer_cancel'))
        AND event.kind IN ('home_set','place_created','place_edited','place_renamed','place_retired','place_restored',
          'thing_created','thing_crafted','thing_edited','thing_moved','thing_upgraded','thing_withdrawn','laws_changed',
          'action','effect_scheduled','effect_resolved','room_reached','wake_try_applied','note','line_said','ping_sent',
          'ping_answered','gazette_printed','transfer','transfer_offer','sale','transfer_cancel','world_listed','world_sale','world_cancel'))
  )
  SELECT id,NULL::integer FROM activity_selected_residents
  UNION SELECT NULL::integer,id FROM activity_place_ids WHERE id IS NOT NULL
  UNION SELECT id,NULL::integer FROM residents WHERE input_type IS NULL
  UNION SELECT NULL::integer,id FROM places WHERE input_type IS NULL
$f$;

-- Invalidation runs only on public writes. One history pass also supplies the cut receipt.
CREATE OR REPLACE FUNCTION recompute_public_activity(input_actor_id integer, input_type text, input_id integer) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE candidate record; counts jsonb := '{"known_residents":0,"known_places":0,"no_history_residents":0,"no_history_places":0,"unproved_residents":0,"unproved_places":0,"unproved_candidates":0}'; counter text;
BEGIN
  FOR candidate IN WITH RECURSIVE wanted AS MATERIALIZED (
      SELECT * FROM public_activity_invalidation_scope(input_actor_id,input_type,input_id) WHERE input_type IS NOT NULL
    ), depth AS (
      SELECT id,0 AS value FROM places WHERE parent_id IS NULL
      UNION ALL SELECT place.id,depth.value+1 FROM places place JOIN depth ON place.parent_id=depth.id
    ) SELECT summary.*,
      CASE WHEN summary.resident_id IS NOT NULL THEN resident.last_public_action_at ELSE place.last_public_action_at END AS stored_at
    FROM public_activity_summaries() summary
    LEFT JOIN residents resident ON resident.id=summary.resident_id
    LEFT JOIN places place ON place.id=summary.place_id
    LEFT JOIN depth ON depth.id=summary.place_id
    WHERE input_type IS NULL OR summary.resident_id IS NULL AND summary.place_id IS NULL OR EXISTS (
      SELECT 1 FROM wanted scope
      WHERE scope.resident_id=summary.resident_id OR scope.place_id=summary.place_id)
    ORDER BY summary.resident_id NULLS LAST,depth.value NULLS LAST,summary.place_id NULLS LAST LOOP
    IF candidate.resident_id IS NOT NULL THEN
      UPDATE residents SET last_public_action_at=candidate.last_at
        WHERE id=candidate.resident_id AND candidate.stored_at IS DISTINCT FROM candidate.last_at
          AND last_public_action_at IS NOT DISTINCT FROM candidate.stored_at;
      counter := CASE WHEN candidate.last_at IS NOT NULL THEN 'known_residents'
        WHEN candidate.uncertain THEN 'unproved_residents' ELSE 'no_history_residents' END;
    ELSIF candidate.place_id IS NOT NULL THEN
      UPDATE places SET last_public_action_at=candidate.last_at
        WHERE id=candidate.place_id AND candidate.stored_at IS DISTINCT FROM candidate.last_at
          AND last_public_action_at IS NOT DISTINCT FROM candidate.stored_at;
      counter := CASE WHEN candidate.last_at IS NOT NULL THEN 'known_places'
        WHEN candidate.uncertain THEN 'unproved_places' ELSE 'no_history_places' END;
    ELSE
      counts := jsonb_set(counts,'{unproved_candidates}',to_jsonb(candidate.unproved_count));
      CONTINUE;
    END IF;
    counts := jsonb_set(counts,ARRAY[counter],to_jsonb((counts->>counter)::bigint+1));
  END LOOP;
  RETURN counts;
END $f$;

CREATE OR REPLACE FUNCTION guard_public_activity_time() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  -- Allow small clock retreats; readers omit a stamp until their database time reaches it.
  IF (NOT isfinite(NEW.at) OR NEW.at > clock_timestamp() + interval '5 seconds') AND public_activity_potential_kind(NEW.kind) THEN RAISE EXCEPTION 'public activity event time is future or non-finite'; END IF;
  RETURN NEW;
END $f$;

CREATE OR REPLACE FUNCTION stamp_public_activity() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE candidate record;
BEGIN
  FOR candidate IN SELECT resident.id,bool_and(activity.proved) AS proved
    FROM public_activity_candidates(NEW.id,NEW.kind,NEW.actor,NEW.detail) activity
    JOIN residents resident ON resident.handle=activity.actor_handle
    GROUP BY resident.id ORDER BY resident.id LOOP
    UPDATE residents SET last_public_action_at=CASE WHEN candidate.proved
      THEN greatest(last_public_action_at,NEW.at) ELSE NULL END
    WHERE id=candidate.id AND (candidate.proved AND (last_public_action_at IS NULL OR last_public_action_at<NEW.at)
      OR NOT candidate.proved AND last_public_action_at<=NEW.at);
  END LOOP;
  FOR candidate IN WITH RECURSIVE changed AS MATERIALIZED (
      SELECT room.id,bool_and(activity.proved) AS proved
      FROM public_activity_candidates(NEW.id,NEW.kind,NEW.actor,NEW.detail) activity
      JOIN places room ON room.id=activity.place_id OR (NOT activity.proved AND activity.place_id IS NULL)
      GROUP BY room.id
    ), tree AS (
      SELECT room.id AS origin,room.id,room.parent_id,0 AS up FROM places room JOIN changed ON changed.id=room.id
      UNION ALL SELECT tree.origin,parent.id,parent.parent_id,tree.up+1 FROM tree JOIN places parent ON parent.id=tree.parent_id
    ), depth AS (SELECT origin,max(up) AS value FROM tree GROUP BY origin)
    SELECT changed.* FROM changed JOIN depth ON depth.origin=changed.id ORDER BY depth.value,changed.id LOOP
    UPDATE places SET last_public_action_at=CASE WHEN candidate.proved
      THEN greatest(last_public_action_at,NEW.at) ELSE NULL END
    WHERE id=candidate.id AND (candidate.proved AND (last_public_action_at IS NULL OR last_public_action_at<NEW.at)
      OR NOT candidate.proved AND last_public_action_at<=NEW.at);
  END LOOP;
  RETURN NEW;
END $f$;

CREATE OR REPLACE FUNCTION invalidate_public_activity() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF TG_TABLE_NAME='moderation_actions' THEN
    PERFORM recompute_public_activity(NEW.actor_id,NEW.target_type,NEW.target_id);
  ELSE
    PERFORM recompute_public_activity(NULL,'place',NEW.id);
  END IF;
  RETURN NEW;
END $f$;

DROP TRIGGER IF EXISTS events_guard_public_activity_time ON events;
CREATE TRIGGER events_guard_public_activity_time BEFORE INSERT ON events
FOR EACH ROW EXECUTE FUNCTION guard_public_activity_time();
DROP TRIGGER IF EXISTS events_stamp_public_activity ON events;
CREATE CONSTRAINT TRIGGER events_stamp_public_activity AFTER INSERT ON events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stamp_public_activity();
DROP TRIGGER IF EXISTS moderation_invalidate_public_activity ON moderation_actions;
CREATE TRIGGER moderation_invalidate_public_activity AFTER INSERT ON moderation_actions
FOR EACH ROW EXECUTE FUNCTION invalidate_public_activity();
DROP TRIGGER IF EXISTS places_invalidate_public_activity ON places;
CREATE TRIGGER places_invalidate_public_activity AFTER UPDATE OF feed ON places
FOR EACH ROW WHEN (OLD.feed IS DISTINCT FROM NEW.feed) EXECUTE FUNCTION invalidate_public_activity();

DO $backfill$
DECLARE counts jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public_activity_schema_state) THEN
    IF (SELECT count(*) FROM public_activity_schema_state WHERE singleton AND schema_version=1
      AND migration_identity='stored-public-activity')<>1 THEN RAISE EXCEPTION 'stored activity receipt mismatch'; END IF;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM events WHERE public_activity_potential_kind(kind)
    AND (NOT isfinite(at) OR at>clock_timestamp() + interval '5 seconds')) THEN
    RAISE EXCEPTION 'public activity backfill has future or non-finite history';
  END IF;
  counts := recompute_public_activity(NULL,NULL,NULL);
  INSERT INTO public_activity_schema_state
  SELECT true,'stored-public-activity',1,(SELECT current_change_id FROM public_change_state WHERE singleton),
    statement_timestamp(),(SELECT count(*) FROM events),
    (counts->>'known_residents')::bigint,(counts->>'known_places')::bigint,
    (counts->>'no_history_residents')::bigint,(counts->>'no_history_places')::bigint,
    (counts->>'unproved_residents')::bigint,(counts->>'unproved_places')::bigint,
    (counts->>'unproved_candidates')::bigint,
    jsonb_build_object('missing_changed_or_room_evidence',(counts->>'unproved_candidates')::bigint);
END $backfill$;

REVOKE ALL ON FUNCTION public_activity_potential_kind(text),public_activity_id(text),public_activity_room(bigint,text,text,jsonb),
  public_activity_visible(text,jsonb,integer),public_activity_feed_room(integer),
  public_activity_candidates(bigint,text,text,jsonb),public_activity_history(),public_activity_summaries(),public_activity_invalidation_scope(integer,text,integer),recompute_public_activity(integer,text,integer),
  guard_public_activity_time(),stamp_public_activity(),invalidate_public_activity() FROM PUBLIC;

COMMIT;
