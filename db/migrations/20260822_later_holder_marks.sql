BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- No existing thing is inferred or backfilled. The lock only prevents a
-- lifecycle change from crossing trigger installation.
LOCK TABLE residents, things, moderation_actions IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS thing_later_holder_marks (
  id           BIGSERIAL PRIMARY KEY,
  resident_id  INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  thing_id     INTEGER NOT NULL UNIQUE REFERENCES things(id) ON DELETE RESTRICT,
  marked_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DO $later_holder_table$
DECLARE
  actual_columns TEXT[];
BEGIN
  SELECT array_agg(attribute.attname::text ORDER BY attribute.attnum)
  INTO actual_columns
  FROM pg_attribute attribute
  WHERE attribute.attrelid = 'thing_later_holder_marks'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_columns IS DISTINCT FROM ARRAY['id', 'resident_id', 'thing_id', 'marked_at']::text[] THEN
    RAISE EXCEPTION 'later-holder mark table conflicts with the reviewed columns'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thing_later_holder_marks'::regclass
      AND conname = 'thing_later_holder_marks_pkey' AND contype = 'p'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thing_later_holder_marks'::regclass
      AND conname = 'thing_later_holder_marks_thing_id_key' AND contype = 'u'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thing_later_holder_marks'::regclass
      AND conname = 'thing_later_holder_marks_resident_id_fkey'
      AND contype = 'f' AND confdeltype = 'r'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thing_later_holder_marks'::regclass
      AND conname = 'thing_later_holder_marks_thing_id_fkey'
      AND contype = 'f' AND confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION 'later-holder mark table conflicts with the reviewed constraints'
      USING ERRCODE = '23514';
  END IF;
END
$later_holder_table$;

CREATE INDEX IF NOT EXISTS thing_later_holder_marks_resident_order
  ON thing_later_holder_marks (resident_id, id DESC);

CREATE OR REPLACE FUNCTION validate_thing_later_holder_mark() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  thing things%ROWTYPE;
  moderation_action TEXT;
BEGIN
  SELECT candidate.* INTO thing
  FROM things candidate
  WHERE candidate.id = NEW.thing_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'later-holder mark names no thing' USING ERRCODE = '23503';
  END IF;
  IF thing.maker_id IS DISTINCT FROM NEW.resident_id
    OR thing.owner_id IS DISTINCT FROM NEW.resident_id
    OR thing.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'later-holder mark requires its active maker-owner'
      USING ERRCODE = '23514';
  END IF;
  SELECT action INTO moderation_action
  FROM moderation_actions
  WHERE target_type = 'thing' AND target_id = NEW.thing_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  IF moderation_action = 'remove' THEN
    RAISE EXCEPTION 'a hidden thing cannot receive a later-holder mark'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS thing_later_holder_marks_check_eligibility
  ON thing_later_holder_marks;
CREATE TRIGGER thing_later_holder_marks_check_eligibility
  BEFORE INSERT ON thing_later_holder_marks
  FOR EACH ROW EXECUTE FUNCTION validate_thing_later_holder_mark();

CREATE OR REPLACE FUNCTION protect_thing_later_holder_mark() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'later-holder marks cannot be edited; unmark and mark again'
    USING ERRCODE = '55000';
END
$function$;

DROP TRIGGER IF EXISTS thing_later_holder_marks_keep_order
  ON thing_later_holder_marks;
CREATE TRIGGER thing_later_holder_marks_keep_order
  BEFORE UPDATE ON thing_later_holder_marks
  FOR EACH ROW EXECUTE FUNCTION protect_thing_later_holder_mark();

CREATE OR REPLACE FUNCTION end_thing_later_holder_mark() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR (OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL) THEN
    DELETE FROM thing_later_holder_marks WHERE thing_id = NEW.id;
  END IF;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS things_end_later_holder_mark ON things;
CREATE TRIGGER things_end_later_holder_mark
  AFTER UPDATE OF owner_id, withdrawn_at ON things
  FOR EACH ROW EXECUTE FUNCTION end_thing_later_holder_mark();

COMMIT;
