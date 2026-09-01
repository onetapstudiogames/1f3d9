BEGIN;

-- Run only after the exact application commit that reports withdrawals_open,
-- excludes command notes from printing, and renders permanent notices is live.
SELECT pg_advisory_xact_lock(524128261, 454);

DO $$
DECLARE
  changed_rows INTEGER;
  activation_events INTEGER;
BEGIN
  IF to_regclass('public.gazette_withdrawals') IS NULL
    OR to_regprocedure('public.gazette_withdrawals_are_open()') IS NULL
    OR to_regprocedure('public.gazette_withdrawal_guards_ready()') IS NULL
    OR NOT gazette_withdrawal_guards_ready()
  THEN
    RAISE EXCEPTION 'Gazette withdrawal ledger and guards must be installed before withdrawals can open';
  END IF;

  PERFORM 1 FROM places WHERE id = 454 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Gazette room #454 does not exist; withdrawals remain closed';
  END IF;

  SELECT count(*)::integer INTO activation_events
  FROM events
  WHERE kind = 'place_edited'
    AND actor = 'the city'
    AND detail = '{"place_id":454,"gazette_withdrawals_opened":true}'::jsonb;

  IF gazette_withdrawals_are_open() AND activation_events = 1 THEN RETURN; END IF;
  IF activation_events <> 0 THEN
    RAISE EXCEPTION 'Gazette withdrawal activation record is not the one verified state; withdrawals remain closed';
  END IF;
  IF NOT gazette_submission_room_is_open()
    OR NOT gazette_submission_room_has_no_forbidden_contents()
  THEN
    RAISE EXCEPTION 'Gazette room #454 must be the verified open submission room before withdrawals can open';
  END IF;
  IF EXISTS (SELECT 1 FROM gazette_withdrawals) THEN
    RAISE EXCEPTION 'Gazette withdrawal ledger must be empty before first activation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM notes note
    WHERE note.place_id = 454
      AND gazette_withdrawal_command_reserved(note.body)
      AND NOT EXISTS (
        SELECT 1 FROM gazette_issue_entries entry WHERE entry.note_id = note.id
      )
  ) THEN
    RAISE EXCEPTION 'Gazette room #454 has an unprinted note beginning WITHDRAW; withdrawals remain closed';
  END IF;

  INSERT INTO events (kind, actor, detail)
  VALUES (
    'place_edited',
    'the city',
    jsonb_build_object('place_id', 454, 'gazette_withdrawals_opened', TRUE)
  );

  UPDATE places SET
    description = 'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted submission made before the cutoff to the next issue, oldest first with its author, note ID, and time. An author may withdraw their own submission strictly before that same print tick by leaving exactly WITHDRAW #<their-note-id>; the issue keeps that entry''s place as a one-line withdrawal notice. The founder and other residents have no override. Printing and withdrawal never delete, edit, move, or copy the source note.',
    purpose = 'Residents may submit up to three notes per Gazette week (Monday 16:00 UTC to Monday 16:00 UTC); each submission and withdrawal command uses the ordinary daily note quota. A withdrawal command uses no weekly slot, never prints, and never restores the target''s spent slot.'
  WHERE id = 454
    AND gazette_submission_room_state(places) = 'open';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;

  IF changed_rows <> 1 OR NOT gazette_withdrawals_are_open() THEN
    RAISE EXCEPTION 'Gazette room #454 does not match the verified pre-withdrawal contract; withdrawals remain closed';
  END IF;
END
$$;

COMMIT;
