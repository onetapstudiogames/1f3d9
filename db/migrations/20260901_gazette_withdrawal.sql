BEGIN;

-- Install this ledger and its guards while the old application is still live.
-- The room contract and activation event are deliberately unchanged here, so
-- exact withdrawal commands refuse atomically until the matching app is live.
SELECT pg_advisory_xact_lock(524128261, 454);

DO $$
BEGIN
  IF to_regclass('public.gazette_issues') IS NULL
    OR to_regclass('public.gazette_issue_entries') IS NULL
    OR to_regprocedure('public.gazette_cycle_start(timestamp with time zone)') IS NULL
  THEN
    RAISE EXCEPTION 'Gazette withdrawal requires the Gazette archive migration first';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS gazette_withdrawals (
  target_note_id  INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE RESTRICT,
  command_note_id INTEGER NOT NULL UNIQUE REFERENCES notes(id) ON DELETE RESTRICT,
  withdrawn_at    TIMESTAMPTZ NOT NULL,
  CHECK (target_note_id <> command_note_id)
);

CREATE OR REPLACE FUNCTION gazette_withdrawal_target(value TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  digits TEXT;
  numeric_target NUMERIC;
BEGIN
  IF value COLLATE "C" !~ '^WITHDRAW #[1-9][0-9]*$' THEN
    RETURN NULL;
  END IF;
  digits := substring(value FROM 11);
  IF char_length(digits) > 10 THEN RETURN NULL; END IF;
  numeric_target := digits::NUMERIC;
  IF numeric_target > 2147483647 THEN RETURN NULL; END IF;
  RETURN numeric_target::INTEGER;
END
$$;

CREATE OR REPLACE FUNCTION gazette_withdrawal_command_reserved(value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT value COLLATE "C" ~ '^WITHDRAW([[:space:]]|#|$)'
$$;

CREATE OR REPLACE FUNCTION gazette_submission_room_state(candidate places)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN candidate.id = 454
      AND candidate.parent_id = 2
      AND candidate.place_kind = 'place'
      AND candidate.owner_id = 1
      AND candidate.name = 'the gazette submission room'
      AND cardinality(candidate.front_matter_thing_ids) = 0
      AND candidate.active_offer_id IS NULL
      AND candidate.open_to_building = FALSE
      AND candidate.open_to_things = FALSE
      AND candidate.open_to_notes = FALSE
      AND candidate.description = 'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.'
      AND candidate.purpose = ''
    THEN 'closed'
    WHEN candidate.id = 454
      AND candidate.parent_id = 2
      AND candidate.place_kind = 'place'
      AND candidate.owner_id = 1
      AND candidate.name = 'the gazette submission room'
      AND cardinality(candidate.front_matter_thing_ids) = 0
      AND candidate.active_offer_id IS NULL
      AND candidate.open_to_building = FALSE
      AND candidate.open_to_things = FALSE
      AND candidate.open_to_notes = TRUE
      AND candidate.description = 'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted note made before the cutoff to the next issue, verbatim with its author, note ID, and time. Printing never deletes, edits, moves, or copies the source note.'
      AND candidate.purpose = 'Residents may submit up to three notes per Gazette week (Monday 16:00 UTC to Monday 16:00 UTC); each submission also uses the ordinary daily note quota.'
    THEN 'open'
    WHEN candidate.id = 454
      AND candidate.parent_id = 2
      AND candidate.place_kind = 'place'
      AND candidate.owner_id = 1
      AND candidate.name = 'the gazette submission room'
      AND cardinality(candidate.front_matter_thing_ids) = 0
      AND candidate.active_offer_id IS NULL
      AND candidate.open_to_building = FALSE
      AND candidate.open_to_things = FALSE
      AND candidate.open_to_notes = TRUE
      AND candidate.description = 'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted submission made before the cutoff to the next issue, oldest first with its author, note ID, and time. An author may withdraw their own submission strictly before that same print tick by leaving exactly WITHDRAW #<their-note-id>; the issue keeps that entry''s place as a one-line withdrawal notice. The founder and other residents have no override. Printing and withdrawal never delete, edit, move, or copy the source note.'
      AND candidate.purpose = 'Residents may submit up to three notes per Gazette week (Monday 16:00 UTC to Monday 16:00 UTC); each submission and withdrawal command uses the ordinary daily note quota. A withdrawal command uses no weekly slot, never prints, and never restores the target''s spent slot.'
    THEN 'withdrawals_open'
    ELSE 'invalid'
  END
$$;

CREATE OR REPLACE FUNCTION gazette_withdrawal_guards_ready()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT to_regclass('public.gazette_withdrawals') IS NOT NULL
    AND NOT EXISTS (
      SELECT expected.table_name, expected.trigger_name
      FROM (VALUES
        ('notes', 'gazette_note_submission_limit'),
        ('notes', 'gazette_note_record_withdrawal'),
        ('gazette_withdrawals', 'gazette_withdrawals_validate'),
        ('gazette_withdrawals', 'gazette_withdrawals_append_only'),
        ('gazette_withdrawals', 'gazette_withdrawals_no_truncate'),
        ('gazette_issue_entries', 'gazette_issue_entry_source'),
        ('gazette_issues', 'gazette_issue_membership_complete'),
        ('gazette_issue_entries', 'gazette_issue_entries_membership_complete'),
        ('gazette_issues', 'gazette_issues_append_only'),
        ('gazette_issue_entries', 'gazette_issue_entries_append_only'),
        ('gazette_issues', 'gazette_issues_no_truncate'),
        ('gazette_issue_entries', 'gazette_issue_entries_no_truncate')
      ) AS expected(table_name, trigger_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger
        WHERE trigger.tgrelid = expected.table_name::regclass
          AND trigger.tgname = expected.trigger_name
          AND trigger.tgenabled IN ('O', 'A')
          AND NOT trigger.tgisinternal
      )
    )
$$;

CREATE OR REPLACE FUNCTION gazette_submission_room_guards_ready()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT gazette_withdrawal_guards_ready()
    AND NOT EXISTS (
      SELECT expected.table_name, expected.trigger_name
      FROM (VALUES
        ('places', 'gazette_submission_room_lifecycle'),
        ('places', 'gazette_submission_room_reject_child_places'),
        ('place_law_changes', 'gazette_submission_room_reject_laws'),
        ('things', 'gazette_submission_room_reject_things')
      ) AS expected(table_name, trigger_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger
        WHERE trigger.tgrelid = expected.table_name::regclass
          AND trigger.tgname = expected.trigger_name
          AND trigger.tgenabled IN ('O', 'A')
          AND NOT trigger.tgisinternal
      )
    )
$$;

CREATE OR REPLACE FUNCTION gazette_submission_room_is_open()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM places place
    WHERE gazette_submission_room_state(place) IN ('open', 'withdrawals_open')
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
        gazette_submission_room_state(place) = 'open'
        OR (
          gazette_submission_room_state(place) = 'withdrawals_open'
          AND (
            SELECT count(*)
            FROM events event
            WHERE event.kind = 'place_edited'
              AND event.actor = 'the city'
              AND event.detail = '{"place_id":454,"gazette_withdrawals_opened":true}'::jsonb
          ) = 1
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION gazette_withdrawals_are_open()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM places place
    WHERE gazette_submission_room_state(place) = 'withdrawals_open'
      AND gazette_submission_room_is_open()
      AND gazette_withdrawal_guards_ready()
      AND (
        SELECT count(*)
        FROM events event
        WHERE event.kind = 'place_edited'
          AND event.actor = 'the city'
          AND event.detail = '{"place_id":454,"gazette_withdrawals_opened":true}'::jsonb
      ) = 1
  )
$$;

CREATE OR REPLACE FUNCTION validate_gazette_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  command_place_id INTEGER;
  command_author_id INTEGER;
  command_body TEXT;
  command_created_at TIMESTAMPTZ;
  parsed_target_id INTEGER;
  target_place_id INTEGER;
  target_author_id INTEGER;
  target_body TEXT;
  target_created_at TIMESTAMPTZ;
  printed_issue INTEGER;
  print_tick TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(524128261, 454);

  IF NOT gazette_withdrawals_are_open() THEN
    RAISE EXCEPTION 'Gazette withdrawals are not open; read GET /api/gazette and send WITHDRAW only when submission_room.withdrawals_open is true'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawals_closed';
  END IF;

  SELECT note.place_id, note.author_id, note.body, note.created_at
  INTO command_place_id, command_author_id, command_body, command_created_at
  FROM notes note
  WHERE note.id = NEW.command_note_id;
  parsed_target_id := gazette_withdrawal_target(command_body);
  IF command_place_id IS DISTINCT FROM 454
    OR parsed_target_id IS NULL
    OR parsed_target_id IS DISTINCT FROM NEW.target_note_id
    OR NEW.withdrawn_at IS DISTINCT FROM command_created_at
  THEN
    RAISE EXCEPTION 'Gazette withdrawal must be exactly WITHDRAW #<your-note-id>'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_command_invalid';
  END IF;

  SELECT note.place_id, note.author_id, note.body, note.created_at
  INTO target_place_id, target_author_id, target_body, target_created_at
  FROM notes note
  WHERE note.id = NEW.target_note_id;
  IF target_place_id IS DISTINCT FROM 454
    OR gazette_withdrawal_target(target_body) IS NOT NULL
  THEN
    RAISE EXCEPTION 'Gazette submission note #% was not found in room #454', NEW.target_note_id
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_no_such_submission';
  END IF;

  IF target_author_id <> command_author_id THEN
    RAISE EXCEPTION 'only the author may withdraw Gazette submission note #%; you are not its author', NEW.target_note_id
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_author_mismatch';
  END IF;

  SELECT entry.issue_number
  INTO printed_issue
  FROM gazette_issue_entries entry
  WHERE entry.note_id = NEW.target_note_id;
  IF printed_issue IS NOT NULL THEN
    RAISE EXCEPTION 'Gazette submission note #% already printed in issue #% and cannot be withdrawn', NEW.target_note_id, printed_issue
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_already_printed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM gazette_withdrawals withdrawal
    WHERE withdrawal.target_note_id = NEW.target_note_id
  ) THEN
    RAISE EXCEPTION 'Gazette submission note #% was already withdrawn by its author', NEW.target_note_id
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_already_withdrawn';
  END IF;

  print_tick := gazette_cycle_start(target_created_at) + interval '7 days';
  IF command_created_at >= print_tick THEN
    RAISE EXCEPTION 'Gazette submission note #% can be withdrawn only strictly before %; that print tick has passed',
      NEW.target_note_id,
      to_char(print_tick AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_tick_passed';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION record_gazette_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_note_id INTEGER;
BEGIN
  IF NEW.place_id <> 454 THEN RETURN NEW; END IF;
  target_note_id := gazette_withdrawal_target(NEW.body);
  IF target_note_id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO gazette_withdrawals (target_note_id, command_note_id, withdrawn_at)
  VALUES (target_note_id, NEW.id, NEW.created_at);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS gazette_withdrawals_validate ON gazette_withdrawals;
CREATE TRIGGER gazette_withdrawals_validate
BEFORE INSERT ON gazette_withdrawals
FOR EACH ROW EXECUTE FUNCTION validate_gazette_withdrawal();

DROP TRIGGER IF EXISTS gazette_withdrawals_append_only ON gazette_withdrawals;
CREATE TRIGGER gazette_withdrawals_append_only
BEFORE UPDATE OR DELETE ON gazette_withdrawals
FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS gazette_withdrawals_no_truncate ON gazette_withdrawals;
CREATE TRIGGER gazette_withdrawals_no_truncate
BEFORE TRUNCATE ON gazette_withdrawals
FOR EACH STATEMENT EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS gazette_issues_no_truncate ON gazette_issues;
CREATE TRIGGER gazette_issues_no_truncate
BEFORE TRUNCATE ON gazette_issues
FOR EACH STATEMENT EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS gazette_issue_entries_no_truncate ON gazette_issue_entries;
CREATE TRIGGER gazette_issue_entries_no_truncate
BEFORE TRUNCATE ON gazette_issue_entries
FOR EACH STATEMENT EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS gazette_note_record_withdrawal ON notes;
CREATE TRIGGER gazette_note_record_withdrawal
AFTER INSERT ON notes
FOR EACH ROW EXECUTE FUNCTION record_gazette_withdrawal();

CREATE OR REPLACE FUNCTION enforce_gazette_submission_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cycle_start TIMESTAMPTZ;
  submissions INTEGER;
  withdrawal_target INTEGER;
BEGIN
  IF NEW.place_id <> 454 THEN RETURN NEW; END IF;

  PERFORM pg_advisory_xact_lock(524128260, NEW.author_id);
  PERFORM pg_advisory_xact_lock(524128261, 454);

  IF NOT gazette_submission_room_is_open() THEN
    RAISE EXCEPTION 'Gazette submission room #454 is not open; read GET /api/gazette and submit only when submission_room.submissions_open is true'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_closed';
  END IF;

  NEW.created_at := clock_timestamp();
  IF gazette_withdrawal_command_reserved(NEW.body) THEN
    withdrawal_target := gazette_withdrawal_target(NEW.body);
    IF withdrawal_target IS NULL THEN
      RAISE EXCEPTION 'Gazette withdrawal must be exactly WITHDRAW #<your-note-id>'
        USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_command_invalid';
    END IF;
    IF NOT gazette_withdrawals_are_open() THEN
      RAISE EXCEPTION 'Gazette withdrawals are not open; read GET /api/gazette and send WITHDRAW only when submission_room.withdrawals_open is true'
        USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawals_closed';
    END IF;
    RETURN NEW;
  END IF;

  cycle_start := gazette_cycle_start(NEW.created_at);
  SELECT count(*)::integer
  INTO submissions
  FROM notes existing
  WHERE existing.place_id = 454
    AND existing.author_id = NEW.author_id
    AND existing.created_at >= cycle_start
    AND existing.created_at < cycle_start + interval '7 days'
    AND NOT EXISTS (
      SELECT 1 FROM gazette_withdrawals withdrawal
      WHERE withdrawal.command_note_id = existing.id
    );

  IF submissions >= 3 THEN
    RAISE EXCEPTION '3 Gazette submissions per resident are allowed from Monday 16:00 UTC inclusive to the next Monday 16:00 UTC exclusive; this Gazette week''s 3 submissions are used; retry at %',
      to_char((cycle_start + interval '7 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_weekly_limit';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS gazette_note_submission_limit ON notes;
CREATE TRIGGER gazette_note_submission_limit
BEFORE INSERT ON notes
FOR EACH ROW EXECUTE FUNCTION enforce_gazette_submission_limit();

CREATE OR REPLACE FUNCTION validate_gazette_issue_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_place_id INTEGER;
  source_created_at TIMESTAMPTZ;
  issue_cutoff TIMESTAMPTZ;
BEGIN
  SELECT note.place_id, note.created_at
  INTO source_place_id, source_created_at
  FROM notes note
  WHERE note.id = NEW.note_id;

  SELECT issue.scheduled_for
  INTO issue_cutoff
  FROM gazette_issues issue
  WHERE issue.issue_number = NEW.issue_number;

  IF source_place_id IS DISTINCT FROM 454 OR source_created_at >= issue_cutoff THEN
    RAISE EXCEPTION 'Gazette entries must reference a pre-cutoff note from place 454'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_issue_entry_source';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gazette_withdrawals withdrawal
    WHERE withdrawal.command_note_id = NEW.note_id
  ) THEN
    RAISE EXCEPTION 'Gazette withdrawal commands cannot enter an issue'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_issue_entry_withdrawal_command';
  END IF;
  RETURN NEW;
END
$$;

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
  IF OLD.id <> 454 AND NEW.id <> 454 THEN RETURN NEW; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'Gazette room #454 is a protected city service; its identity cannot change'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;

  IF gazette_submission_room_state(OLD) = 'closed'
    AND gazette_submission_room_state(NEW) = 'open'
    AND to_regclass('public.gazette_issues') IS NOT NULL
    AND to_regclass('public.gazette_issue_entries') IS NOT NULL
    AND to_regclass('city_snapshot.public_records_v2') IS NOT NULL
    AND gazette_submission_room_has_no_forbidden_contents()
    AND gazette_submission_room_guards_ready()
    AND NOT EXISTS (SELECT 1 FROM notes WHERE place_id = 454)
    AND (
      SELECT count(*) FROM events event
      WHERE event.kind = 'place_edited' AND event.actor = 'the city'
        AND event.detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
    ) = 1
  THEN RETURN NEW; END IF;

  IF gazette_submission_room_state(OLD) = 'open'
    AND gazette_submission_room_state(NEW) = 'withdrawals_open'
    AND gazette_withdrawal_guards_ready()
    AND (
      SELECT count(*) FROM events event
      WHERE event.kind = 'place_edited' AND event.actor = 'the city'
        AND event.detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
    ) = 1
    AND (
      SELECT count(*) FROM events event
      WHERE event.kind = 'place_edited' AND event.actor = 'the city'
        AND event.detail = '{"place_id":454,"gazette_withdrawals_opened":true}'::jsonb
    ) = 1
  THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'Gazette room #454 is a protected city service; it must remain one exact contract state and change only through guarded activation'
    USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
END
$$;

DROP TRIGGER IF EXISTS gazette_submission_room_lifecycle ON places;
CREATE TRIGGER gazette_submission_room_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON places
FOR EACH ROW EXECUTE FUNCTION protect_gazette_submission_room();

CREATE OR REPLACE VIEW city_snapshot.public_records_v2
WITH (security_barrier = true)
AS
WITH public_event_kinds_v2(kind) AS (
  VALUES
    ('register'), ('rotate'), ('resident_edited'), ('home_set'),
    ('place_created'), ('place_edited'), ('kind_invented'), ('kind_revised'),
    ('trait_coined'), ('thing_created'), ('thing_crafted'), ('thing_edited'),
    ('thing_moved'), ('thing_upgraded'), ('thing_withdrawn'), ('laws_changed'),
    ('action'), ('effect_scheduled'), ('effect_resolved'), ('note'),
    ('gazette_printed'), ('agreement'), ('agreement_accession'), ('agreement_sign'),
    ('transfer'), ('transfer_offer'), ('sale'), ('transfer_cancel'),
    ('world_listed'), ('world_sale'), ('world_cancel'), ('payment_repair'),
    ('flag'), ('moderation')
)
SELECT base_record.class_name, base_record.record_id, base_record.sort_key,
  CASE
    WHEN base_record.class_name = 'events'
      AND NOT EXISTS (
        SELECT 1 FROM public_event_kinds_v2 public_kind
        WHERE public_kind.kind = base_record.payload->>'kind'
      )
    THEN jsonb_build_object('id', base_record.payload->'id', 'status', 'not_public_or_sequence_gap')
    WHEN base_record.class_name = 'events'
      AND base_record.payload->>'kind' = 'gazette_printed'
      AND gazette_issue.event_id IS NOT NULL
    THEN jsonb_set(
      base_record.payload #- '{detail,error}',
      '{detail}',
      (coalesce(base_record.payload->'detail', '{}'::jsonb) - 'error') || jsonb_build_object(
        'issue_number', gazette_issue.issue_number,
        'entry_count', gazette_issue.entry_count
      ),
      TRUE
    )
    WHEN base_record.class_name = 'events' THEN base_record.payload #- '{detail,error}'
    ELSE base_record.payload
  END AS payload
FROM city_snapshot.public_records base_record
LEFT JOIN public.gazette_issues gazette_issue
  ON base_record.class_name = 'events'
    AND base_record.record_id = gazette_issue.event_id::TEXT

UNION ALL

SELECT 'gazette_issues'::TEXT, issue.issue_number::TEXT, issue.issue_number::BIGINT,
  jsonb_build_object(
    'id', issue.issue_number, 'status', 'exported',
    'issue_number', issue.issue_number, 'scheduled_for', issue.scheduled_for,
    'printed_at', issue.printed_at, 'header', issue.header,
    'entry_count', issue.entry_count, 'event_id', issue.event_id
  )
FROM public.gazette_issues issue

UNION ALL

SELECT 'gazette_issue_entries'::TEXT, entry.note_id::TEXT, entry.note_id::BIGINT,
  jsonb_build_object(
    'id', entry.note_id, 'status', 'exported',
    'issue_number', entry.issue_number, 'ordinal', entry.ordinal,
    'note_id', entry.note_id, 'author_id', note.author_id,
    'author', author.handle, 'created_at', note.created_at
  ) || CASE WHEN withdrawal.target_note_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
    'withdrawn', TRUE,
    'withdrawal_note_id', withdrawal.command_note_id,
    'withdrawn_at', withdrawal.withdrawn_at
  ) END
FROM public.gazette_issue_entries entry
JOIN public.notes note ON note.id = entry.note_id
JOIN public.residents author ON author.id = note.author_id
LEFT JOIN public.gazette_withdrawals withdrawal ON withdrawal.target_note_id = entry.note_id

UNION ALL

SELECT 'gazette_withdrawals'::TEXT AS class_name,
  withdrawal.target_note_id::TEXT AS record_id,
  withdrawal.target_note_id::BIGINT AS sort_key,
  jsonb_build_object(
    'id', withdrawal.target_note_id, 'status', 'exported',
    'target_note_id', withdrawal.target_note_id,
    'withdrawal_note_id', withdrawal.command_note_id,
    'author_id', target_note.author_id, 'author', author.handle,
    'withdrawn_at', withdrawal.withdrawn_at
  ) AS payload
FROM public.gazette_withdrawals withdrawal
JOIN public.notes target_note ON target_note.id = withdrawal.target_note_id
JOIN public.residents author ON author.id = target_note.author_id;

REVOKE ALL ON city_snapshot.public_records_v2 FROM PUBLIC;
GRANT SELECT ON city_snapshot.public_records_v2 TO city_snapshot_export;

DO $$
DECLARE
  room_state TEXT;
  opening_events INTEGER;
  withdrawal_events INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM notes note
    WHERE note.place_id = 454
      AND gazette_withdrawal_command_reserved(note.body)
      AND NOT EXISTS (
        SELECT 1 FROM gazette_issue_entries entry WHERE entry.note_id = note.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM gazette_withdrawals withdrawal
        WHERE withdrawal.command_note_id = note.id
      )
  ) THEN
    RAISE EXCEPTION 'Gazette withdrawal migration found an unprinted note beginning WITHDRAW; print or investigate it before retrying';
  END IF;

  SELECT gazette_submission_room_state(place) INTO room_state
  FROM places place WHERE place.id = 454;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*)::integer INTO opening_events FROM events
  WHERE kind = 'place_edited' AND actor = 'the city'
    AND detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb;
  SELECT count(*)::integer INTO withdrawal_events FROM events
  WHERE kind = 'place_edited' AND actor = 'the city'
    AND detail = '{"place_id":454,"gazette_withdrawals_opened":true}'::jsonb;

  IF gazette_submission_room_has_no_forbidden_contents()
    AND gazette_submission_room_guards_ready()
    AND ((room_state = 'closed' AND opening_events = 0 AND withdrawal_events = 0)
      OR (room_state = 'open' AND opening_events = 1 AND withdrawal_events = 0)
      OR (room_state = 'withdrawals_open' AND opening_events = 1 AND withdrawal_events = 1))
  THEN RETURN; END IF;
  RAISE EXCEPTION 'Gazette room #454 does not match a guarded withdrawal rollout state'
    USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
END
$$;

COMMIT;
