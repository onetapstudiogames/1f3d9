BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Reading settings (decisions #154 and #155). Each resident has one private
-- settings store: one row per resident, created the first time it changes a
-- setting, and a missing row means every default. Focus mode is its first
-- setting, off by default. The table is new, so no existing row changes and no
-- existing table is locked beyond the brief share lock its foreign key takes on
-- residents. It is never public and never exported. It is safe to run again.
DO $resident_settings_guard$
BEGIN
  IF to_regclass('public.residents') IS NULL THEN
    RAISE EXCEPTION 'resident settings migration needs the residents table';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('public.resident_settings')
      AND attnum > 0 AND NOT attisdropped
      AND attname NOT IN ('resident_id', 'focus', 'updated_at')
  ) THEN
    RAISE EXCEPTION 'resident_settings already exists with columns this migration does not know';
  END IF;
END
$resident_settings_guard$;

-- One private row per resident; a missing row means every default.
CREATE TABLE IF NOT EXISTS resident_settings (
  resident_id INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE CASCADE,
  focus       BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $resident_settings_shape$
DECLARE
  actual_columns TEXT[];
  actual_types TEXT[];
  actual_required BOOLEAN[];
  actual_defaults TEXT[];
BEGIN
  SELECT
    array_agg(attribute.attname ORDER BY attribute.attnum),
    array_agg(format_type(attribute.atttypid, attribute.atttypmod) ORDER BY attribute.attnum),
    array_agg(attribute.attnotnull ORDER BY attribute.attnum),
    array_agg(coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '') ORDER BY attribute.attnum)
  INTO actual_columns, actual_types, actual_required, actual_defaults
  FROM pg_attribute AS attribute
  LEFT JOIN pg_attrdef AS default_value
    ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
  WHERE attribute.attrelid = 'resident_settings'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_columns IS DISTINCT FROM ARRAY['resident_id', 'focus', 'updated_at']::TEXT[]
  OR actual_types IS DISTINCT FROM
    ARRAY['integer', 'boolean', 'timestamp with time zone']::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[TRUE, TRUE, TRUE]::BOOLEAN[]
  OR actual_defaults IS DISTINCT FROM ARRAY['', 'false', 'now()']::TEXT[] THEN
    RAISE EXCEPTION 'resident_settings conflicts with the reviewed settings columns';
  END IF;

  IF (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'resident_settings'::regclass
      AND convalidated
      AND (
        (contype = 'p' AND pg_get_constraintdef(oid) = 'PRIMARY KEY (resident_id)')
        OR (contype = 'f' AND pg_get_constraintdef(oid)
          = 'FOREIGN KEY (resident_id) REFERENCES residents(id) ON DELETE CASCADE')
      )
  ) <> 2 OR (
    SELECT count(*) FROM pg_constraint WHERE conrelid = 'resident_settings'::regclass
  ) <> 2 THEN
    RAISE EXCEPTION 'resident_settings is missing its reviewed key or foreign key';
  END IF;
END
$resident_settings_shape$;

COMMIT;
