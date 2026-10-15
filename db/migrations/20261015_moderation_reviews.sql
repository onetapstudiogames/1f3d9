BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Review requests and the resident's one reply to a moderation record (decision
-- #152). A review request is an ordinary flag on target_type 'moderation' naming
-- the record's id, so the flag check is widened under its own name to add that one
-- type; the name and the word 'ping' in its list stay, so the same-room-talk block
-- that closes db/schema.sql neither drops it nor adds the narrower list back. A
-- reply is an ordinary note linked from the record by one row in the new
-- append-only table moderation_replies: one reply per record and resident, one
-- record per note. The widened check is added NOT VALID and validated in a separate
-- statement; no existing row changes. It is safe to run again.
DO $moderation_reviews_guard$
BEGIN
  IF to_regclass('public.flags') IS NULL
    OR to_regclass('public.moderation_actions') IS NULL
    OR to_regclass('public.notes') IS NULL
    OR to_regclass('public.residents') IS NULL THEN
    RAISE EXCEPTION 'moderation reviews migration needs the flags, moderation_actions, notes and residents tables';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND contype = 'c'
      AND conname <> 'flags_target_type_check'
      AND pg_get_constraintdef(oid) ~ '\mtarget_type\M'
  ) THEN
    RAISE EXCEPTION 'a check other than flags_target_type_check restricts flags.target_type; review it before widening';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND conname = 'flags_target_type_check'
      AND pg_get_constraintdef(oid) NOT IN (
        'CHECK ((target_type = ANY (ARRAY[''resident''::text, ''place''::text, ''thing''::text, ''kind''::text, ''trait''::text, ''note''::text, ''agreement''::text, ''line''::text, ''ping''::text])))',
        'CHECK ((target_type = ANY (ARRAY[''resident''::text, ''place''::text, ''thing''::text, ''kind''::text, ''trait''::text, ''note''::text, ''agreement''::text, ''line''::text, ''ping''::text, ''moderation''::text])))'
      )
  ) THEN
    RAISE EXCEPTION 'flags_target_type_check is not the reviewed list of flag targets';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('public.moderation_replies')
      AND attnum > 0 AND NOT attisdropped
      AND attname NOT IN ('moderation_id', 'resident_id', 'note_id', 'created_at')
  ) THEN
    RAISE EXCEPTION 'moderation_replies already exists with columns this migration does not know';
  END IF;
END
$moderation_reviews_guard$;

DO $moderation_reviews_flag_target$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'flags'::regclass
    AND conname = 'flags_target_type_check'
    AND pg_get_constraintdef(oid) LIKE '%''moderation''%') THEN
    ALTER TABLE flags
      DROP CONSTRAINT IF EXISTS flags_target_type_check,
      ADD CONSTRAINT flags_target_type_check
        CHECK (target_type IN (
          'resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement', 'line', 'ping',
          'moderation'
        )) NOT VALID;
  END IF;
END
$moderation_reviews_flag_target$;

ALTER TABLE flags VALIDATE CONSTRAINT flags_target_type_check;

-- A resident's one reply to a moderation record that names it: the note itself is
-- an ordinary public note; this row is the public link from the record to it.
CREATE TABLE IF NOT EXISTS moderation_replies (
  moderation_id BIGINT NOT NULL REFERENCES moderation_actions(id) ON DELETE RESTRICT,
  resident_id   INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  note_id       INTEGER NOT NULL REFERENCES notes(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT moderation_replies_one_per_record PRIMARY KEY (moderation_id, resident_id),
  CONSTRAINT moderation_replies_one_record_per_note UNIQUE (note_id)
);
DROP TRIGGER IF EXISTS moderation_replies_append_only ON moderation_replies;
CREATE TRIGGER moderation_replies_append_only BEFORE UPDATE OR DELETE ON moderation_replies
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DO $moderation_reviews_shape$
DECLARE
  actual_columns TEXT[];
  actual_types TEXT[];
  actual_required BOOLEAN[];
BEGIN
  IF (
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND conname = 'flags_target_type_check'
      AND convalidated
  ) IS DISTINCT FROM
    'CHECK ((target_type = ANY (ARRAY[''resident''::text, ''place''::text, ''thing''::text, ''kind''::text, ''trait''::text, ''note''::text, ''agreement''::text, ''line''::text, ''ping''::text, ''moderation''::text])))' THEN
    RAISE EXCEPTION 'flags_target_type_check is not the validated list of the nine public targets and moderation';
  END IF;

  SELECT
    array_agg(attribute.attname ORDER BY attribute.attnum),
    array_agg(format_type(attribute.atttypid, attribute.atttypmod) ORDER BY attribute.attnum),
    array_agg(attribute.attnotnull ORDER BY attribute.attnum)
  INTO actual_columns, actual_types, actual_required
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'moderation_replies'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_columns IS DISTINCT FROM
    ARRAY['moderation_id', 'resident_id', 'note_id', 'created_at']::TEXT[]
  OR actual_types IS DISTINCT FROM
    ARRAY['bigint', 'integer', 'integer', 'timestamp with time zone']::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[TRUE, TRUE, TRUE, TRUE]::BOOLEAN[] THEN
    RAISE EXCEPTION 'moderation_replies conflicts with the reviewed reply columns';
  END IF;

  IF (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'moderation_replies'::regclass
      AND convalidated
      AND (
        (conname = 'moderation_replies_one_per_record' AND contype = 'p'
          AND pg_get_constraintdef(oid) = 'PRIMARY KEY (moderation_id, resident_id)')
        OR (conname = 'moderation_replies_one_record_per_note' AND contype = 'u'
          AND pg_get_constraintdef(oid) = 'UNIQUE (note_id)')
        OR (contype = 'f' AND pg_get_constraintdef(oid) IN (
          'FOREIGN KEY (moderation_id) REFERENCES moderation_actions(id) ON DELETE RESTRICT',
          'FOREIGN KEY (resident_id) REFERENCES residents(id) ON DELETE RESTRICT',
          'FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE RESTRICT'
        ))
      )
  ) <> 5 OR (
    SELECT count(*) FROM pg_constraint WHERE conrelid = 'moderation_replies'::regclass
  ) <> 5 THEN
    RAISE EXCEPTION 'moderation_replies is missing a reviewed key, unique rule or foreign key';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'moderation_replies'::regclass
      AND tgname = 'moderation_replies_append_only'
      AND NOT tgisinternal
      AND tgfoid = 'deny_history_mutation()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'moderation_replies is missing its append-only trigger';
  END IF;
END
$moderation_reviews_shape$;

COMMIT;
