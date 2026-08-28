BEGIN;

-- Run only after the exact application commit with the Gazette archive,
-- printer route, cron, and public contract is deployed to this target.
-- The schema migration is deliberately safe to install before that commit;
-- this separate activation is the only operation that opens room #454.
DO $$
DECLARE
  changed_rows INTEGER;
  activation_events INTEGER;
BEGIN
  IF to_regclass('public.gazette_issues') IS NULL
    OR to_regclass('public.gazette_issue_entries') IS NULL
    OR to_regclass('city_snapshot.public_records_v2') IS NULL
    OR to_regprocedure('public.gazette_submission_room_is_open()') IS NULL
    OR to_regprocedure('public.gazette_submission_room_state(places)') IS NULL
    OR to_regprocedure('public.gazette_submission_room_has_no_forbidden_contents()') IS NULL
    OR to_regprocedure('public.gazette_submission_room_guards_ready()') IS NULL
    OR NOT gazette_submission_room_guards_ready()
  THEN
    RAISE EXCEPTION 'Gazette archive, snapshot, submission limit, and protected-room lifecycle must be installed before room #454 can open';
  END IF;

  PERFORM 1
  FROM places
  WHERE id = 454
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Gazette room #454 does not exist; no room was opened';
  END IF;

  SELECT count(*)::integer
  INTO activation_events
  FROM events
  WHERE kind = 'place_edited'
    AND actor = 'the city'
    AND detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb;

  IF NOT gazette_submission_room_has_no_forbidden_contents() THEN
    RAISE EXCEPTION 'Gazette room #454 cannot open while it has local laws, child places, or things; no room was opened';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM places place
    WHERE place.id = 454
      AND gazette_submission_room_state(place) = 'open'
  ) AND activation_events = 1 THEN
    RETURN;
  END IF;

  IF activation_events <> 0 THEN
    RAISE EXCEPTION 'Gazette room #454 activation record is not the one verified open state; no room was opened';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM notes
    WHERE place_id = 454
  ) THEN
    RAISE EXCEPTION 'Gazette room #454 contains notes from before the verified submission rules; the room remains closed';
  END IF;

  -- The trigger recognizes this one immutable event as the authorization for
  -- the exact closed-to-open row transition. Any later failure rolls both back.
  INSERT INTO events (kind, actor, detail)
  VALUES (
    'place_edited',
    'the city',
    jsonb_build_object('place_id', 454, 'gazette_submission_room_opened', TRUE)
  );

  UPDATE places SET
    description = 'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted note made before the cutoff to the next issue, verbatim with its author, note ID, and time. Printing never deletes, edits, moves, or copies the source note.',
    purpose = 'Residents may submit up to three notes per Gazette week (Monday 16:00 UTC to Monday 16:00 UTC); each submission also uses the ordinary daily note quota.',
    open_to_notes = TRUE
  WHERE id = 454
    AND gazette_submission_room_state(places) = 'closed';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;

  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Gazette room #454 does not match the verified closed shell; no room was opened';
  END IF;
END
$$;

-- The dormant migration keeps format v1 readable so the still-deployed
-- exporter cannot fail before this exact-commit activation. Once the matching
-- Gazette application is live, this same transaction completes the v2 cutover.
REVOKE SELECT ON city_snapshot.public_records FROM city_snapshot_export;
GRANT SELECT ON city_snapshot.public_records_v2 TO city_snapshot_export;

COMMIT;
