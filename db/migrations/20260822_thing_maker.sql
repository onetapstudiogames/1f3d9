BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Freeze every source and destination of maker identity until validation,
-- backfill, constraints, and triggers are all committed together.
LOCK TABLE residents, things, events IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE things ADD COLUMN IF NOT EXISTS maker_id INTEGER;

DO $thing_maker_column$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'things'::regclass
      AND attname = 'maker_id'
      AND atttypid = 'integer'::regtype
      AND attgenerated = ''
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'thing maker column conflicts with the reviewed definition'
      USING ERRCODE = '23514';
  END IF;
END
$thing_maker_column$;

DO $thing_maker_event_ids$
DECLARE
  invalid_event_ids TEXT;
BEGIN
  SELECT string_agg(creation_event.id::text, ', ' ORDER BY creation_event.id)
  INTO invalid_event_ids
  FROM events AS creation_event
  WHERE creation_event.kind IN ('thing_created', 'thing_crafted')
    AND CASE
      WHEN jsonb_typeof(creation_event.detail -> 'thing_id') = 'number'
        AND creation_event.detail ->> 'thing_id' ~ '^[1-9][0-9]*$'
      THEN EXISTS (
        SELECT 1
        FROM things AS referenced_thing
        WHERE referenced_thing.id::numeric = (creation_event.detail ->> 'thing_id')::numeric
      )
      ELSE false
    END IS NOT TRUE;

  IF invalid_event_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'thing maker history has malformed or orphan creation event ids: %',
      invalid_event_ids
      USING ERRCODE = '23514';
  END IF;
END
$thing_maker_event_ids$;

CREATE TEMP TABLE thing_maker_authenticated_history ON COMMIT DROP AS
SELECT
  thing.id AS thing_id,
  COUNT(creation_event.id) AS creation_event_count,
  COUNT(creation_event.id) <> 1 AS invalid_creation_event_count,
  COUNT(authenticated_actor.id) AS authenticated_event_count,
  COUNT(authenticated_actor.id) <> 1 AS invalid_authenticated_event_count,
  MIN(authenticated_actor.id) AS authenticated_maker_id,
  coalesce(bool_and(
    creation_event.id IS NOT NULL
    AND authenticated_actor.id IS NOT NULL
    AND creation_event.at = thing.created_at
    AND jsonb_typeof(creation_event.detail -> 'place_id') = 'number'
    AND creation_event.detail ->> 'place_id' ~ '^[1-9][0-9]*$'
    AND CASE creation_event.kind
      WHEN 'thing_created' THEN
        thing.kind_id IS NULL
        AND thing.birth_revision IS NULL
        AND creation_event.detail ? 'name'
        AND jsonb_typeof(creation_event.detail -> 'name') = 'string'
        AND char_length(creation_event.detail ->> 'name') BETWEEN 1 AND 120
        AND creation_event.detail ? 'kind_id'
        AND creation_event.detail -> 'kind_id' = 'null'::jsonb
        AND creation_event.detail ? 'birth_revision'
        AND creation_event.detail -> 'birth_revision' = 'null'::jsonb
      WHEN 'thing_crafted' THEN
        thing.kind_id IS NOT NULL
        AND thing.birth_revision IS NOT NULL
        AND CASE
          WHEN jsonb_typeof(creation_event.detail -> 'kind_id') = 'number'
            AND creation_event.detail ->> 'kind_id' ~ '^[1-9][0-9]*$'
          THEN (creation_event.detail ->> 'kind_id')::numeric
        END = thing.kind_id
        AND CASE
          WHEN jsonb_typeof(creation_event.detail -> 'birth_revision') = 'number'
            AND creation_event.detail ->> 'birth_revision' ~ '^[1-9][0-9]*$'
          THEN (creation_event.detail ->> 'birth_revision')::numeric
        END = thing.birth_revision
        AND jsonb_typeof(creation_event.detail -> 'ingredient_ids') = 'array'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(creation_event.detail -> 'ingredient_ids') = 'array'
              THEN creation_event.detail -> 'ingredient_ids'
              ELSE '[]'::jsonb
            END
          ) AS ingredient(value)
          WHERE jsonb_typeof(ingredient.value) <> 'number'
            OR ingredient.value #>> '{}' !~ '^[1-9][0-9]*$'
        )
      ELSE false
    END
  ), false) AS immutable_birth_detail_matches
FROM things AS thing
LEFT JOIN events AS creation_event
  ON creation_event.kind IN ('thing_created', 'thing_crafted')
  AND CASE
    WHEN jsonb_typeof(creation_event.detail -> 'thing_id') = 'number'
      AND creation_event.detail ->> 'thing_id' ~ '^[1-9][0-9]*$'
    THEN (creation_event.detail ->> 'thing_id')::numeric
  END = thing.id
LEFT JOIN residents AS authenticated_actor
  ON authenticated_actor.handle = creation_event.actor
  AND authenticated_actor.joined_at <= creation_event.at
GROUP BY thing.id;

DO $thing_maker_history$
DECLARE
  invalid_ids TEXT;
  forged_ids TEXT;
BEGIN
  SELECT string_agg(invalid.thing_id::text, ', ' ORDER BY invalid.thing_id)
  INTO invalid_ids
  FROM (
    SELECT thing_id
    FROM thing_maker_authenticated_history
    WHERE invalid_creation_event_count
      OR invalid_authenticated_event_count
      OR NOT immutable_birth_detail_matches
    ORDER BY thing_id
  ) AS invalid;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'thing maker history is missing, duplicate, unknown, or mismatched for thing ids: %',
      invalid_ids
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(forged.id::text, ', ' ORDER BY forged.id)
  INTO forged_ids
  FROM (
    SELECT thing.id
    FROM things AS thing
    JOIN thing_maker_authenticated_history AS history
      ON history.thing_id = thing.id
    WHERE thing.maker_id IS NOT NULL
      AND thing.maker_id IS DISTINCT FROM history.authenticated_maker_id
    ORDER BY thing.id
  ) AS forged;

  IF forged_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'thing maker history disagrees with an existing maker for thing ids: %',
      forged_ids
      USING ERRCODE = '23514';
  END IF;
END
$thing_maker_history$;

-- The old history trigger freezes every column of a withdrawn row. Remove it
-- only after validation and while the write locks above are still held.
DROP TRIGGER IF EXISTS things_keep_birth_history ON things;

UPDATE things AS thing
SET maker_id = history.authenticated_maker_id
FROM thing_maker_authenticated_history AS history
WHERE history.thing_id = thing.id
  AND thing.maker_id IS NULL;

DO $thing_maker_complete$
BEGIN
  IF EXISTS (SELECT 1 FROM things WHERE maker_id IS NULL) THEN
    RAISE EXCEPTION 'thing maker backfill left an unresolved row'
      USING ERRCODE = '23514';
  END IF;
END
$thing_maker_complete$;

DO $thing_maker_foreign_key$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'things'::regclass
      AND conname = 'things_maker_id_fkey'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    JOIN pg_attribute AS local_column
      ON local_column.attrelid = constraint_record.conrelid
      AND local_column.attnum = constraint_record.conkey[1]
    JOIN pg_attribute AS referenced_column
      ON referenced_column.attrelid = constraint_record.confrelid
      AND referenced_column.attnum = constraint_record.confkey[1]
    WHERE constraint_record.conrelid = 'things'::regclass
      AND constraint_record.conname = 'things_maker_id_fkey'
      AND constraint_record.contype = 'f'
      AND constraint_record.confrelid = 'residents'::regclass
      AND constraint_record.confdeltype = 'r'
      AND cardinality(constraint_record.conkey) = 1
      AND cardinality(constraint_record.confkey) = 1
      AND local_column.attname = 'maker_id'
      AND referenced_column.attname = 'id'
  ) THEN
    RAISE EXCEPTION 'thing maker foreign key conflicts with the reviewed definition'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'things'::regclass
      AND conname = 'things_maker_id_fkey'
  ) THEN
    ALTER TABLE things
      ADD CONSTRAINT things_maker_id_fkey
      FOREIGN KEY (maker_id) REFERENCES residents(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END
$thing_maker_foreign_key$;

ALTER TABLE things VALIDATE CONSTRAINT things_maker_id_fkey;
ALTER TABLE things ALTER COLUMN maker_id SET NOT NULL;

CREATE OR REPLACE FUNCTION set_thing_maker_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.maker_id IS NULL THEN
    NEW.maker_id := NEW.owner_id;
  ELSIF NEW.maker_id IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'a new thing maker must match its first owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS things_set_maker_on_insert ON things;
CREATE TRIGGER things_set_maker_on_insert BEFORE INSERT ON things
  FOR EACH ROW EXECUTE FUNCTION set_thing_maker_on_insert();

CREATE OR REPLACE FUNCTION protect_thing_history() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'things are retained as history; set withdrawn_at instead'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.maker_id IS DISTINCT FROM OLD.maker_id
    OR NEW.kind_id IS DISTINCT FROM OLD.kind_id
    OR NEW.birth_revision IS DISTINCT FROM OLD.birth_revision
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'thing birth history is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a withdrawn thing is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.withdrawn_at IS NOT NULL AND NEW.withdrawn_at < NEW.created_at THEN
    RAISE EXCEPTION 'withdrawn_at cannot predate creation' USING ERRCODE = '22007';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER things_keep_birth_history BEFORE UPDATE OR DELETE ON things
  FOR EACH ROW EXECUTE FUNCTION protect_thing_history();

DROP TABLE thing_maker_authenticated_history;

COMMIT;
