BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Label endings, the founder's ending of a resident's label at that resident's own request
-- (decision #169). Label rows stay append-only (decisions #131 and #163): an ending is one
-- private row here per ended label row, naming the resident who wore it and the resident's
-- own note asking for it, and every reader of a resident's labels skips a row that has one.
-- The public record is a moderation event naming the resident and the request note, never
-- the label. The table is new, so no existing row changes and no existing table is locked
-- beyond the brief share locks its foreign keys take on active_labels, residents and notes.
-- It is private and never exported. It is safe to run again.
DO $label_endings_guard$
BEGIN
  IF to_regclass('public.active_labels') IS NULL OR to_regclass('public.residents') IS NULL
    OR to_regclass('public.notes') IS NULL THEN
    RAISE EXCEPTION 'label endings migration needs the active_labels, residents and notes tables';
  END IF;
  IF to_regprocedure('public.deny_history_mutation()') IS NULL THEN
    RAISE EXCEPTION 'label endings migration needs the deny_history_mutation function';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('public.label_endings')
      AND attnum > 0 AND NOT attisdropped
      AND attname NOT IN ('label_id', 'resident_id', 'request_note_id', 'founder_id', 'created_at')
  ) THEN
    RAISE EXCEPTION 'label_endings already exists with columns this migration does not know';
  END IF;
END
$label_endings_guard$;

-- One row per ended label row: which row, whose it was, the note that asked, and when.
CREATE TABLE IF NOT EXISTS label_endings (
  label_id         BIGINT PRIMARY KEY REFERENCES active_labels(id) ON DELETE RESTRICT,
  resident_id      INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  request_note_id  INTEGER NOT NULL REFERENCES notes(id) ON DELETE RESTRICT,
  founder_id       INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT label_endings_founder_only CHECK (founder_id = 1)
);
CREATE INDEX IF NOT EXISTS label_endings_resident ON label_endings (resident_id, created_at DESC);
REVOKE ALL ON label_endings FROM PUBLIC;

-- An ending names a label row on that same resident and that resident's own note.
CREATE OR REPLACE FUNCTION label_ending_matches_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM active_labels label
    WHERE label.id = NEW.label_id AND label.target_type = 'resident' AND label.target_id = NEW.resident_id
  ) OR NOT EXISTS (
    SELECT 1 FROM notes note WHERE note.id = NEW.request_note_id AND note.author_id = NEW.resident_id
  ) THEN
    RAISE EXCEPTION 'a label ending must name a label on that resident and that resident''s own note'
      USING ERRCODE = '23514', CONSTRAINT = 'label_endings_match_request';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS label_endings_match_request ON label_endings;
CREATE TRIGGER label_endings_match_request BEFORE INSERT ON label_endings
  FOR EACH ROW EXECUTE FUNCTION label_ending_matches_request();
DROP TRIGGER IF EXISTS label_endings_append_only ON label_endings;
CREATE TRIGGER label_endings_append_only BEFORE UPDATE OR DELETE ON label_endings
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DO $label_endings_shape$
DECLARE
  actual_columns TEXT[];
  actual_types TEXT[];
  actual_required BOOLEAN[];
BEGIN
  SELECT
    array_agg(attribute.attname ORDER BY attribute.attnum),
    array_agg(format_type(attribute.atttypid, attribute.atttypmod) ORDER BY attribute.attnum),
    array_agg(attribute.attnotnull ORDER BY attribute.attnum)
  INTO actual_columns, actual_types, actual_required
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'label_endings'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  IF actual_columns IS DISTINCT FROM ARRAY[
    'label_id', 'resident_id', 'request_note_id', 'founder_id', 'created_at'
  ]::TEXT[]
  OR actual_types IS DISTINCT FROM ARRAY[
    'bigint', 'integer', 'integer', 'integer', 'timestamp with time zone'
  ]::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[TRUE, TRUE, TRUE, TRUE, TRUE]::BOOLEAN[] THEN
    RAISE EXCEPTION 'label_endings conflicts with the reviewed label ending columns';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'label_endings'::regclass
      AND conname = 'label_endings_founder_only' AND contype = 'c')
    OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'label_endings'::regclass AND contype IN ('p', 'f')) <> 5
    OR to_regclass('public.label_endings_resident') IS NULL
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'label_endings'::regclass AND NOT tgisinternal
      AND tgname IN ('label_endings_match_request', 'label_endings_append_only')) <> 2 THEN
    RAISE EXCEPTION 'label_endings is missing one of its reviewed checks, keys, index or triggers';
  END IF;
END
$label_endings_shape$;

COMMIT;
