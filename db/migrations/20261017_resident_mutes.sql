BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Mutes and allows (decision #156). Each resident may mute a resident, a place,
-- a note, a thing or a kind, and allow one note, thing or place through a wider
-- mute. One private row per choice, saved in the resident's settings store
-- (#154); unmuting or unallowing deletes the row. The founder, resident #1,
-- cannot be muted, a resident cannot mute itself, and a whole resident or kind
-- cannot be allowed. Whether a target exists is checked by the city before a
-- row is written. The table is new, so no existing row changes and no existing
-- table is locked beyond the brief share lock its foreign key takes on
-- residents. It is never public and never exported. It is safe to run again.
DO $resident_mutes_guard$
BEGIN
  IF to_regclass('public.residents') IS NULL THEN
    RAISE EXCEPTION 'resident mutes migration needs the residents table';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('public.resident_mutes')
      AND attnum > 0 AND NOT attisdropped
      AND attname NOT IN ('id', 'resident_id', 'target_type', 'target_id', 'choice', 'created_at')
  ) THEN
    RAISE EXCEPTION 'resident_mutes already exists with columns this migration does not know';
  END IF;
END
$resident_mutes_guard$;

-- One private row per resident, target type and target id: a mute or an allow.
CREATE TABLE IF NOT EXISTS resident_mutes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resident_id  INTEGER NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL,
  target_id    INTEGER NOT NULL,
  choice       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT resident_mutes_target_type_allowed
    CHECK (target_type IN ('resident', 'place', 'note', 'thing', 'kind')),
  CONSTRAINT resident_mutes_target_id_positive CHECK (target_id > 0),
  CONSTRAINT resident_mutes_choice_allowed CHECK (choice IN ('mute', 'allow')),
  CONSTRAINT resident_mutes_allow_targets
    CHECK (choice = 'mute' OR target_type IN ('place', 'note', 'thing')),
  CONSTRAINT resident_mutes_not_founder CHECK (target_type <> 'resident' OR target_id <> 1),
  CONSTRAINT resident_mutes_not_self CHECK (target_type <> 'resident' OR target_id <> resident_id),
  CONSTRAINT resident_mutes_one_choice UNIQUE (resident_id, target_type, target_id)
);

DO $resident_mutes_shape$
DECLARE
  actual_columns TEXT[];
  actual_types TEXT[];
  actual_required BOOLEAN[];
  actual_identity TEXT[];
  actual_defaults TEXT[];
BEGIN
  SELECT
    array_agg(attribute.attname ORDER BY attribute.attnum),
    array_agg(format_type(attribute.atttypid, attribute.atttypmod) ORDER BY attribute.attnum),
    array_agg(attribute.attnotnull ORDER BY attribute.attnum),
    array_agg(attribute.attidentity::text ORDER BY attribute.attnum),
    array_agg(coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '') ORDER BY attribute.attnum)
  INTO actual_columns, actual_types, actual_required, actual_identity, actual_defaults
  FROM pg_attribute AS attribute
  LEFT JOIN pg_attrdef AS default_value
    ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
  WHERE attribute.attrelid = 'resident_mutes'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_columns IS DISTINCT FROM
    ARRAY['id', 'resident_id', 'target_type', 'target_id', 'choice', 'created_at']::TEXT[]
  OR actual_types IS DISTINCT FROM
    ARRAY['bigint', 'integer', 'text', 'integer', 'text', 'timestamp with time zone']::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[TRUE, TRUE, TRUE, TRUE, TRUE, TRUE]::BOOLEAN[]
  OR actual_identity IS DISTINCT FROM ARRAY['a', '', '', '', '', '']::TEXT[]
  OR actual_defaults IS DISTINCT FROM ARRAY['', '', '', '', '', 'now()']::TEXT[] THEN
    RAISE EXCEPTION 'resident_mutes conflicts with the reviewed mute columns';
  END IF;

  IF (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'resident_mutes'::regclass
      AND convalidated
      AND (conname, contype, pg_get_constraintdef(oid)) IN (
        ('resident_mutes_pkey', 'p', 'PRIMARY KEY (id)'),
        ('resident_mutes_resident_id_fkey', 'f',
          'FOREIGN KEY (resident_id) REFERENCES residents(id) ON DELETE CASCADE'),
        ('resident_mutes_target_type_allowed', 'c',
          'CHECK ((target_type = ANY (ARRAY[''resident''::text, ''place''::text, ''note''::text, ''thing''::text, ''kind''::text])))'),
        ('resident_mutes_target_id_positive', 'c', 'CHECK ((target_id > 0))'),
        ('resident_mutes_choice_allowed', 'c',
          'CHECK ((choice = ANY (ARRAY[''mute''::text, ''allow''::text])))'),
        ('resident_mutes_allow_targets', 'c',
          'CHECK (((choice = ''mute''::text) OR (target_type = ANY (ARRAY[''place''::text, ''note''::text, ''thing''::text]))))'),
        ('resident_mutes_not_founder', 'c',
          'CHECK (((target_type <> ''resident''::text) OR (target_id <> 1)))'),
        ('resident_mutes_not_self', 'c',
          'CHECK (((target_type <> ''resident''::text) OR (target_id <> resident_id)))'),
        ('resident_mutes_one_choice', 'u', 'UNIQUE (resident_id, target_type, target_id)')
      )
  ) <> 9 OR (
    SELECT count(*) FROM pg_constraint WHERE conrelid = 'resident_mutes'::regclass
  ) <> 9 THEN
    RAISE EXCEPTION 'resident_mutes is missing one of its reviewed checks, keys or its unique choice';
  END IF;
END
$resident_mutes_shape$;

COMMIT;
