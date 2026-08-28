BEGIN;

-- The Gazette consumes a submission only by assigning its immutable note ID
-- to one permanent issue. The original resident note is never copied, edited,
-- deleted, or moved from place #454.
CREATE OR REPLACE FUNCTION gazette_cycle_start(value TIMESTAMPTZ)
RETURNS TIMESTAMPTZ
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT date_bin(
    interval '7 days',
    value,
    TIMESTAMPTZ '2026-08-31 16:00:00+00'
  )
$$;

CREATE TABLE IF NOT EXISTS gazette_issues (
  issue_number  INTEGER PRIMARY KEY CHECK (issue_number > 0),
  scheduled_for TIMESTAMPTZ NOT NULL UNIQUE,
  printed_at    TIMESTAMPTZ NOT NULL,
  header        TEXT NOT NULL CHECK (octet_length(header) BETWEEN 1 AND 4000),
  entry_count   INTEGER NOT NULL CHECK (entry_count >= 0),
  event_id      BIGINT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  CHECK (printed_at >= scheduled_for),
  CHECK (
    scheduled_for = TIMESTAMPTZ '2026-08-31 16:00:00+00'
      + ((issue_number - 1) * interval '7 days')
  )
);

CREATE TABLE IF NOT EXISTS gazette_issue_entries (
  issue_number  INTEGER NOT NULL REFERENCES gazette_issues(issue_number) ON DELETE RESTRICT,
  ordinal       INTEGER NOT NULL CHECK (ordinal > 0),
  note_id       INTEGER NOT NULL UNIQUE REFERENCES notes(id) ON DELETE RESTRICT,
  PRIMARY KEY (issue_number, ordinal)
);
CREATE INDEX IF NOT EXISTS gazette_issue_entries_note_order
  ON gazette_issue_entries (issue_number, ordinal, note_id);

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
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION verify_gazette_issue_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  declared_count INTEGER;
  stored_count INTEGER;
  misplaced_count INTEGER;
BEGIN
  SELECT issue.entry_count
  INTO declared_count
  FROM gazette_issues issue
  WHERE issue.issue_number = NEW.issue_number;

  SELECT count(*)::integer,
    count(*) FILTER (WHERE ordered.ordinal <> ordered.expected_ordinal)::integer
  INTO stored_count, misplaced_count
  FROM (
    SELECT entry.ordinal,
      row_number() OVER (ORDER BY note.created_at, note.id)::integer AS expected_ordinal
    FROM gazette_issue_entries entry
    JOIN notes note ON note.id = entry.note_id
    WHERE entry.issue_number = NEW.issue_number
  ) ordered;

  IF declared_count IS NULL OR stored_count <> declared_count OR misplaced_count <> 0 THEN
    RAISE EXCEPTION 'Gazette issue membership is incomplete or out of order'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_issue_membership_complete';
  END IF;
  RETURN NULL;
END
$$;

-- Room #454 is a city service, not an ordinary tradable or repurposable place.
-- One shared classifier keeps the dormant shell, activation guard, and public
-- submissions gate on the same two complete row shapes.
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
    ELSE 'invalid'
  END
$$;

CREATE OR REPLACE FUNCTION gazette_submission_room_has_no_forbidden_contents()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM place_law_changes WHERE place_id = 454
  ) AND NOT EXISTS (
    SELECT 1 FROM places WHERE parent_id = 454
  ) AND NOT EXISTS (
    SELECT 1 FROM things WHERE place_id = 454
  )
$$;

-- Refuse a dormant install over hidden room state before installing the guards,
-- so an operator can remove pre-feature drift and rerun the whole transaction.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM place_law_changes WHERE place_id = 454) THEN
    RAISE EXCEPTION 'Gazette room #454 cannot have local laws'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_laws';
  END IF;
  IF EXISTS (SELECT 1 FROM places WHERE parent_id = 454) THEN
    RAISE EXCEPTION 'Gazette room #454 cannot contain child places'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_children';
  END IF;
  IF EXISTS (SELECT 1 FROM things WHERE place_id = 454) THEN
    RAISE EXCEPTION 'Gazette room #454 cannot hold things'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_things';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION protect_gazette_submission_room_dependents()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_row JSONB;
  new_row JSONB;
  target_column TEXT;
  touches_room BOOLEAN;
BEGIN
  old_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  new_row := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  target_column := CASE WHEN TG_TABLE_NAME = 'places' THEN 'parent_id' ELSE 'place_id' END;
  touches_room := coalesce((old_row ->> target_column)::integer = 454, FALSE)
    OR coalesce((new_row ->> target_column)::integer = 454, FALSE);

  IF touches_room AND TG_TABLE_NAME = 'place_law_changes' THEN
    RAISE EXCEPTION 'Gazette room #454 is a protected city service and cannot have local laws'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_laws';
  ELSIF touches_room AND TG_TABLE_NAME = 'places' THEN
    RAISE EXCEPTION 'Gazette room #454 is a protected city service and cannot contain child places'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_children';
  ELSIF touches_room AND TG_TABLE_NAME = 'things' THEN
    RAISE EXCEPTION 'Gazette room #454 is a protected city service and cannot hold things'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_things';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS gazette_submission_room_reject_laws ON place_law_changes;
CREATE TRIGGER gazette_submission_room_reject_laws
BEFORE INSERT OR UPDATE OR DELETE ON place_law_changes
FOR EACH ROW EXECUTE FUNCTION protect_gazette_submission_room_dependents();
DROP TRIGGER IF EXISTS gazette_submission_room_reject_child_places ON places;
CREATE TRIGGER gazette_submission_room_reject_child_places
BEFORE INSERT OR UPDATE OR DELETE ON places
FOR EACH ROW EXECUTE FUNCTION protect_gazette_submission_room_dependents();
DROP TRIGGER IF EXISTS gazette_submission_room_reject_things ON things;
CREATE TRIGGER gazette_submission_room_reject_things
BEFORE INSERT OR UPDATE OR DELETE ON things
FOR EACH ROW EXECUTE FUNCTION protect_gazette_submission_room_dependents();

CREATE OR REPLACE FUNCTION gazette_submission_room_guards_ready()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NOT EXISTS (
    SELECT expected.table_name, expected.trigger_name
    FROM (VALUES
      ('notes', 'gazette_note_submission_limit'),
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

  RAISE EXCEPTION 'Gazette room #454 is a protected city service; it must remain the exact closed shell until guarded activation and the exact verified-open room afterward'
    USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
END
$$;

DROP TRIGGER IF EXISTS gazette_submission_room_lifecycle ON places;
CREATE TRIGGER gazette_submission_room_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON places
FOR EACH ROW EXECUTE FUNCTION protect_gazette_submission_room();

CREATE OR REPLACE FUNCTION gazette_submission_room_is_open()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM places place
    WHERE gazette_submission_room_state(place) = 'open'
      AND gazette_submission_room_has_no_forbidden_contents()
      AND gazette_submission_room_guards_ready()
      AND (
        SELECT count(*)
        FROM events event
        WHERE event.kind = 'place_edited'
          AND event.actor = 'the city'
          AND event.detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
      ) = 1
  )
$$;

CREATE OR REPLACE FUNCTION enforce_gazette_submission_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cycle_start TIMESTAMPTZ;
  submissions INTEGER;
BEGIN
  IF NEW.place_id <> 454 THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(524128260, NEW.author_id);
  PERFORM pg_advisory_xact_lock(524128261, 454);

  IF NOT gazette_submission_room_is_open() THEN
    RAISE EXCEPTION 'Gazette submission room #454 is not open; read GET /api/gazette and submit only when submission_room.submissions_open is true'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_closed';
  END IF;

  NEW.created_at := clock_timestamp();
  cycle_start := gazette_cycle_start(NEW.created_at);

  SELECT count(*)::integer
  INTO submissions
  FROM notes note
  WHERE note.place_id = 454
    AND note.author_id = NEW.author_id
    AND note.created_at >= cycle_start
    AND note.created_at < cycle_start + interval '7 days';

  IF submissions >= 3 THEN
    RAISE EXCEPTION '3 Gazette submissions per resident are allowed from Monday 16:00 UTC inclusive to the next Monday 16:00 UTC exclusive; this Gazette week''s 3 submissions are used; retry at %',
      to_char(
        (cycle_start + interval '7 days') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_weekly_limit';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS gazette_note_submission_limit ON notes;
CREATE TRIGGER gazette_note_submission_limit
BEFORE INSERT ON notes
FOR EACH ROW EXECUTE FUNCTION enforce_gazette_submission_limit();

-- An upgrade may see the founder shell or an already activated canonical room.
-- Refuse installation over drift only after every readiness guard exists, so a
-- valid pre-feature shell can install this migration once without weakening it.
DO $$
DECLARE
  room_state TEXT;
  activation_events INTEGER;
BEGIN
  SELECT gazette_submission_room_state(place)
  INTO room_state
  FROM places place
  WHERE place.id = 454;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer
  INTO activation_events
  FROM events event
  WHERE event.kind = 'place_edited'
    AND event.actor = 'the city'
    AND event.detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb;

  IF gazette_submission_room_has_no_forbidden_contents()
    AND gazette_submission_room_guards_ready()
    AND ((room_state = 'closed' AND activation_events = 0)
      OR (room_state = 'open' AND activation_events = 1))
  THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Gazette room #454 is not the verified closed shell or verified-open room; restore the public room contract before installing the Gazette'
    USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
END
$$;

DROP TRIGGER IF EXISTS gazette_issue_entry_source ON gazette_issue_entries;
CREATE TRIGGER gazette_issue_entry_source
BEFORE INSERT ON gazette_issue_entries
FOR EACH ROW EXECUTE FUNCTION validate_gazette_issue_entry();

DROP TRIGGER IF EXISTS gazette_issue_membership_complete ON gazette_issues;
CREATE CONSTRAINT TRIGGER gazette_issue_membership_complete
AFTER INSERT ON gazette_issues
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_gazette_issue_membership();

DROP TRIGGER IF EXISTS gazette_issue_entries_membership_complete ON gazette_issue_entries;
CREATE CONSTRAINT TRIGGER gazette_issue_entries_membership_complete
AFTER INSERT ON gazette_issue_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_gazette_issue_membership();

DROP TRIGGER IF EXISTS gazette_issues_append_only ON gazette_issues;
CREATE TRIGGER gazette_issues_append_only
BEFORE UPDATE OR DELETE ON gazette_issues
FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS gazette_issue_entries_append_only ON gazette_issue_entries;
CREATE TRIGGER gazette_issue_entries_append_only
BEFORE UPDATE OR DELETE ON gazette_issue_entries
FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

-- Snapshot format v1 is already public and immutable. Format v2 keeps that
-- projection as an internal input, adds the permanent Gazette ledgers, and
-- restores the Gazette print fields that v1 could not know about. This dormant
-- phase grants v2 but retains the safe v1 grant for the still-deployed exporter;
-- exact-commit room activation performs the final v1 revoke.
CREATE OR REPLACE VIEW city_snapshot.public_records_v2
WITH (security_barrier = true)
AS
WITH public_event_kinds_v2(kind) AS (
  VALUES
    ('register'),
    ('rotate'),
    ('home_set'),
    ('place_created'),
    ('place_edited'),
    ('kind_invented'),
    ('kind_revised'),
    ('trait_coined'),
    ('thing_created'),
    ('thing_crafted'),
    ('thing_edited'),
    ('thing_moved'),
    ('thing_upgraded'),
    ('thing_withdrawn'),
    ('laws_changed'),
    ('action'),
    ('effect_scheduled'),
    ('effect_resolved'),
    ('note'),
    ('gazette_printed'),
    ('agreement'),
    ('agreement_accession'),
    ('agreement_sign'),
    ('transfer'),
    ('transfer_offer'),
    ('sale'),
    ('transfer_cancel'),
    ('world_listed'),
    ('world_sale'),
    ('world_cancel'),
    ('payment_repair'),
    ('flag'),
    ('moderation')
)
SELECT base_record.class_name,
  base_record.record_id,
  base_record.sort_key,
  CASE
    WHEN base_record.class_name = 'events'
      AND NOT EXISTS (
        SELECT 1
        FROM public_event_kinds_v2 public_kind
        WHERE public_kind.kind = base_record.payload->>'kind'
      )
    THEN jsonb_build_object(
      'id', base_record.payload->'id',
      'status', 'not_public_or_sequence_gap'
    )
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
    WHEN base_record.class_name = 'events'
    THEN base_record.payload #- '{detail,error}'
    ELSE base_record.payload
  END AS payload
FROM city_snapshot.public_records base_record
LEFT JOIN public.gazette_issues gazette_issue
  ON base_record.class_name = 'events'
    AND base_record.record_id = gazette_issue.event_id::TEXT

UNION ALL

SELECT 'gazette_issues'::TEXT AS class_name,
  issue.issue_number::TEXT AS record_id,
  issue.issue_number::BIGINT AS sort_key,
  jsonb_build_object(
    'id', issue.issue_number,
    'status', 'exported',
    'issue_number', issue.issue_number,
    'scheduled_for', issue.scheduled_for,
    'printed_at', issue.printed_at,
    'header', issue.header,
    'entry_count', issue.entry_count,
    'event_id', issue.event_id
  ) AS payload
FROM public.gazette_issues issue

UNION ALL

SELECT 'gazette_issue_entries'::TEXT AS class_name,
  entry.note_id::TEXT AS record_id,
  entry.note_id::BIGINT AS sort_key,
  jsonb_build_object(
    'id', entry.note_id,
    'status', 'exported',
    'issue_number', entry.issue_number,
    'ordinal', entry.ordinal,
    'note_id', entry.note_id,
    'author_id', note.author_id,
    'author', author.handle,
    'created_at', note.created_at
  ) AS payload
FROM public.gazette_issue_entries entry
JOIN public.notes note ON note.id = entry.note_id
JOIN public.residents author ON author.id = note.author_id;

REVOKE ALL ON city_snapshot.public_records_v2 FROM PUBLIC;
GRANT SELECT ON city_snapshot.public_records_v2 TO city_snapshot_export;

COMMIT;
