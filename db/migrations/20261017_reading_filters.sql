BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Reading filters (decision #157). Each resident's private settings store gains one
-- column per kind of content (encoded text, drawings, code-like text, links, emoji),
-- each show, describe or hide and show by default, and its own muted-words list, empty
-- by default and at most 200 entries (the per-word rules are kept in code). Each mute
-- row gains show_anyway, false by default and true only on an allow, so one allowed
-- item may skip the filters too. Every column has a constant default, so adding it
-- rewrites no row; each table changes in one ALTER TABLE statement (one brief
-- exclusive lock), its checks NOT VALID, and each check is validated in its own
-- statement. No existing row changes meaning: every resident keeps reading as before.
-- Both tables are private and never exported. It is safe to run again.
DO $reading_filters_guard$
DECLARE
  settings_checks INTEGER;
BEGIN
  IF to_regclass('public.resident_settings') IS NULL OR to_regclass('public.resident_mutes') IS NULL THEN
    RAISE EXCEPTION 'reading filters migration needs the resident_settings and resident_mutes tables';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'resident_settings'::regclass
      AND attnum > 0 AND NOT attisdropped
      AND (
        (attname IN ('encoded_text_filter', 'drawings_filter', 'code_like_text_filter', 'links_filter', 'emoji_filter')
          AND (atttypid <> 'text'::regtype OR NOT attnotnull))
        OR (attname = 'muted_words' AND (atttypid <> 'text[]'::regtype OR NOT attnotnull))
      )
  ) OR EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'resident_mutes'::regclass
      AND attname = 'show_anyway'
      AND NOT attisdropped
      AND (atttypid <> 'boolean'::regtype OR NOT attnotnull)
  ) THEN
    RAISE EXCEPTION 'a reading filters column already exists with a shape this migration does not know';
  END IF;
  SELECT count(*) INTO settings_checks
  FROM pg_constraint
  WHERE conrelid = 'resident_settings'::regclass
    AND conname IN (
      'resident_settings_encoded_text_filter_known', 'resident_settings_drawings_filter_known',
      'resident_settings_code_like_text_filter_known', 'resident_settings_links_filter_known',
      'resident_settings_emoji_filter_known', 'resident_settings_muted_words_count'
    );
  IF settings_checks NOT IN (0, 6) THEN
    RAISE EXCEPTION 'resident_settings holds only some of the reading filters checks';
  END IF;
END
$reading_filters_guard$;

DO $reading_filters_columns$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'resident_settings'::regclass
    AND conname = 'resident_settings_muted_words_count') THEN
    ALTER TABLE resident_settings
      ADD COLUMN IF NOT EXISTS encoded_text_filter TEXT NOT NULL DEFAULT 'show',
      ADD COLUMN IF NOT EXISTS drawings_filter TEXT NOT NULL DEFAULT 'show',
      ADD COLUMN IF NOT EXISTS code_like_text_filter TEXT NOT NULL DEFAULT 'show',
      ADD COLUMN IF NOT EXISTS links_filter TEXT NOT NULL DEFAULT 'show',
      ADD COLUMN IF NOT EXISTS emoji_filter TEXT NOT NULL DEFAULT 'show',
      ADD COLUMN IF NOT EXISTS muted_words TEXT[] NOT NULL DEFAULT '{}',
      ADD CONSTRAINT resident_settings_encoded_text_filter_known
        CHECK (encoded_text_filter IN ('show', 'describe', 'hide')) NOT VALID,
      ADD CONSTRAINT resident_settings_drawings_filter_known
        CHECK (drawings_filter IN ('show', 'describe', 'hide')) NOT VALID,
      ADD CONSTRAINT resident_settings_code_like_text_filter_known
        CHECK (code_like_text_filter IN ('show', 'describe', 'hide')) NOT VALID,
      ADD CONSTRAINT resident_settings_links_filter_known
        CHECK (links_filter IN ('show', 'describe', 'hide')) NOT VALID,
      ADD CONSTRAINT resident_settings_emoji_filter_known
        CHECK (emoji_filter IN ('show', 'describe', 'hide')) NOT VALID,
      ADD CONSTRAINT resident_settings_muted_words_count
        CHECK (cardinality(muted_words) <= 200) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'resident_mutes'::regclass
    AND conname = 'resident_mutes_show_anyway_on_allow') THEN
    ALTER TABLE resident_mutes
      ADD COLUMN IF NOT EXISTS show_anyway BOOLEAN NOT NULL DEFAULT FALSE,
      ADD CONSTRAINT resident_mutes_show_anyway_on_allow
        CHECK (NOT show_anyway OR choice = 'allow') NOT VALID;
  END IF;
END
$reading_filters_columns$;

ALTER TABLE resident_settings VALIDATE CONSTRAINT resident_settings_encoded_text_filter_known;
ALTER TABLE resident_settings VALIDATE CONSTRAINT resident_settings_drawings_filter_known;
ALTER TABLE resident_settings VALIDATE CONSTRAINT resident_settings_code_like_text_filter_known;
ALTER TABLE resident_settings VALIDATE CONSTRAINT resident_settings_links_filter_known;
ALTER TABLE resident_settings VALIDATE CONSTRAINT resident_settings_emoji_filter_known;
ALTER TABLE resident_settings VALIDATE CONSTRAINT resident_settings_muted_words_count;
ALTER TABLE resident_mutes VALIDATE CONSTRAINT resident_mutes_show_anyway_on_allow;

DO $reading_filters_shape$
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
    AND NOT attribute.attisdropped
    AND attribute.attname IN (
      'encoded_text_filter', 'drawings_filter', 'code_like_text_filter', 'links_filter', 'emoji_filter', 'muted_words'
    );

  IF actual_columns IS DISTINCT FROM ARRAY[
    'encoded_text_filter', 'drawings_filter', 'code_like_text_filter', 'links_filter', 'emoji_filter', 'muted_words'
  ]::TEXT[]
  OR actual_types IS DISTINCT FROM ARRAY['text', 'text', 'text', 'text', 'text', 'text[]']::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[TRUE, TRUE, TRUE, TRUE, TRUE, TRUE]::BOOLEAN[]
  OR actual_defaults IS DISTINCT FROM ARRAY[
    '''show''::text', '''show''::text', '''show''::text', '''show''::text', '''show''::text', '''{}''::text[]'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'resident_settings conflicts with the reviewed reading filters columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute attribute
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'resident_mutes'::regclass
      AND attribute.attname = 'show_anyway'
      AND attribute.atttypid = 'boolean'::regtype
      AND attribute.attnotnull
      AND NOT attribute.attisdropped
      AND pg_get_expr(default_value.adbin, default_value.adrelid) = 'false'
  ) THEN
    RAISE EXCEPTION 'resident_mutes.show_anyway is not the reviewed not-null boolean with default false';
  END IF;

  IF (
    SELECT count(*) FROM pg_constraint
    WHERE contype = 'c'
      AND convalidated
      AND (
        (conrelid = 'resident_settings'::regclass AND (conname, pg_get_constraintdef(oid)) IN (
          ('resident_settings_encoded_text_filter_known',
            'CHECK ((encoded_text_filter = ANY (ARRAY[''show''::text, ''describe''::text, ''hide''::text])))'),
          ('resident_settings_drawings_filter_known',
            'CHECK ((drawings_filter = ANY (ARRAY[''show''::text, ''describe''::text, ''hide''::text])))'),
          ('resident_settings_code_like_text_filter_known',
            'CHECK ((code_like_text_filter = ANY (ARRAY[''show''::text, ''describe''::text, ''hide''::text])))'),
          ('resident_settings_links_filter_known',
            'CHECK ((links_filter = ANY (ARRAY[''show''::text, ''describe''::text, ''hide''::text])))'),
          ('resident_settings_emoji_filter_known',
            'CHECK ((emoji_filter = ANY (ARRAY[''show''::text, ''describe''::text, ''hide''::text])))'),
          ('resident_settings_muted_words_count', 'CHECK ((cardinality(muted_words) <= 200))')
        ))
        OR (conrelid = 'resident_mutes'::regclass AND conname = 'resident_mutes_show_anyway_on_allow'
          AND pg_get_constraintdef(oid) = 'CHECK (((NOT show_anyway) OR (choice = ''allow''::text)))')
      )
  ) <> 7 THEN
    RAISE EXCEPTION 'a reading filters check is missing, not validated, or not the reviewed check';
  END IF;
END
$reading_filters_shape$;

COMMIT;
