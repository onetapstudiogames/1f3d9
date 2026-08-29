BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION valid_city_drawing(candidate JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $function$
DECLARE
  palette_size INTEGER;
  square JSONB;
  square_text TEXT;
BEGIN
  IF candidate IS NULL THEN RETURN TRUE; END IF;
  IF octet_length(candidate::text) > 2048
    OR jsonb_typeof(candidate) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(candidate)) <> 2
    OR NOT candidate ?& ARRAY['palette', 'indices'] THEN
    RETURN FALSE;
  END IF;
  IF jsonb_typeof(candidate->'palette') <> 'array'
    OR jsonb_array_length(candidate->'palette') NOT BETWEEN 0 AND 64
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(candidate->'palette') colour
      WHERE jsonb_typeof(colour) <> 'string'
        OR colour #>> '{}' !~ '^#[0-9a-f]{6}$'
    ) THEN
    RETURN FALSE;
  END IF;
  IF jsonb_typeof(candidate->'indices') <> 'array'
    OR jsonb_array_length(candidate->'indices') <> 64 THEN
    RETURN FALSE;
  END IF;
  palette_size := jsonb_array_length(candidate->'palette');
  FOR square IN SELECT value FROM jsonb_array_elements(candidate->'indices') LOOP
    IF jsonb_typeof(square) = 'null' THEN CONTINUE; END IF;
    IF jsonb_typeof(square) <> 'number' THEN RETURN FALSE; END IF;
    square_text := square #>> '{}';
    IF square_text !~ '^(0|[1-9][0-9]*)$'
      OR square_text::NUMERIC >= palette_size THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END
$function$;

-- The public write contract stores the owner's decision separately from its
-- pixels. Blank is a read-time presentation of a complete transparent image;
-- it is never a stored or inferred owner decision.
CREATE OR REPLACE FUNCTION valid_city_drawing_public_text(
  candidate TEXT,
  maximum_bytes INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $function$
DECLARE
  position INTEGER;
  codepoint INTEGER;
  next_one INTEGER;
  next_two INTEGER;
  next_three INTEGER;
  mojibake_tail INTEGER[] := ARRAY[
    338, 339, 352, 353, 376, 381, 382, 402, 710, 732,
    8211, 8212, 8213, 8214, 8215, 8216, 8217, 8218,
    8219, 8220, 8221, 8222, 8223, 8224, 8225, 8226,
    8230, 8240, 8249, 8250, 8364, 8482
  ];
BEGIN
  IF candidate IS NULL OR maximum_bytes < 0
    OR octet_length(candidate) > maximum_bytes
    OR candidate ~* '1f3d9_(sk|at|rt|ac|rc)_[0-9a-f]{8,}' THEN
    RETURN FALSE;
  END IF;

  FOR position IN 1..char_length(candidate) LOOP
    codepoint := ascii(substr(candidate, position, 1));
    IF codepoint BETWEEN 0 AND 8 OR codepoint IN (11, 12)
      OR codepoint BETWEEN 14 AND 31 OR codepoint BETWEEN 127 AND 159
      OR codepoint IN (
        1564, 8206, 8207, 8232, 8233, 8234, 8235, 8236, 8237, 8238,
        8294, 8295, 8296, 8297, 65533
      ) THEN
      RETURN FALSE;
    END IF;

    next_one := ascii(substr(candidate, position + 1, 1));
    next_two := ascii(substr(candidate, position + 2, 1));
    next_three := ascii(substr(candidate, position + 3, 1));
    IF (codepoint IN (194, 195)
        AND (next_one BETWEEN 160 AND 191 OR next_one = ANY(mojibake_tail)))
      OR (codepoint = 226
        AND (next_one BETWEEN 160 AND 191 OR next_one = ANY(mojibake_tail))
        AND (next_two BETWEEN 160 AND 191 OR next_two = ANY(mojibake_tail)))
      OR (codepoint = 240
        AND (next_one BETWEEN 160 AND 191 OR next_one = ANY(mojibake_tail))
        AND (next_two BETWEEN 160 AND 191 OR next_two = ANY(mojibake_tail))
        AND (next_three BETWEEN 160 AND 191 OR next_three = ANY(mojibake_tail))) THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END
$function$;

CREATE OR REPLACE FUNCTION valid_city_drawing_variant_name(candidate TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT AS $function$
  SELECT candidate IS NOT NULL
    AND candidate = btrim(candidate)
    AND octet_length(candidate) BETWEEN 1 AND 64
    AND candidate !~ E'[\\r\\n]'
    AND valid_city_drawing_public_text(candidate, 64)
$function$;

CREATE OR REPLACE FUNCTION valid_city_drawing_state(
  candidate_state TEXT,
  candidate_description TEXT,
  candidate_drawing JSONB
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT AS $function$
  SELECT CASE candidate_state
    WHEN 'undrawn' THEN candidate_description IS NULL AND candidate_drawing IS NULL
    WHEN 'refused' THEN candidate_description IS NOT NULL
      AND octet_length(candidate_description) <= 280
      AND valid_city_drawing_public_text(candidate_description, 280)
      AND candidate_drawing IS NULL
    WHEN 'in_progress' THEN candidate_description IS NOT NULL
      AND octet_length(candidate_description) <= 280
      AND valid_city_drawing_public_text(candidate_description, 280)
      AND candidate_drawing IS NOT NULL
      AND valid_city_drawing(candidate_drawing)
    WHEN 'complete' THEN candidate_description IS NOT NULL
      AND octet_length(candidate_description) <= 280
      AND valid_city_drawing_public_text(candidate_description, 280)
      AND candidate_drawing IS NOT NULL
      AND valid_city_drawing(candidate_drawing)
    ELSE FALSE
  END
$function$;

CREATE OR REPLACE FUNCTION valid_city_drawing_variants(candidate JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT AS $function$
DECLARE
  variant JSONB;
  variant_name TEXT;
  names TEXT[] := '{}'::TEXT[];
BEGIN
  IF candidate IS NULL OR jsonb_typeof(candidate) <> 'array'
    OR jsonb_array_length(candidate) > 8 THEN
    RETURN FALSE;
  END IF;

  FOR variant IN SELECT value FROM jsonb_array_elements(candidate) LOOP
    IF jsonb_typeof(variant) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(variant)) <> 4
      OR NOT variant ?& ARRAY['name', 'drawing', 'state', 'description']
      OR jsonb_typeof(variant->'name') <> 'string'
      OR jsonb_typeof(variant->'state') <> 'string'
      OR jsonb_typeof(variant->'description') <> 'string' THEN
      RETURN FALSE;
    END IF;
    variant_name := variant->>'name';
    IF octet_length(variant_name) NOT BETWEEN 1 AND 64
      OR NOT valid_city_drawing_variant_name(variant_name)
      OR variant_name = ANY(names)
      OR variant->>'state' NOT IN ('in_progress', 'complete')
      OR NOT valid_city_drawing_state(
        variant->>'state', variant->>'description', variant->'drawing'
      ) THEN
      RETURN FALSE;
    END IF;
    names := array_append(names, variant_name);
  END LOOP;
  RETURN TRUE;
END
$function$;

CREATE OR REPLACE FUNCTION city_drawing_rows(candidate JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $function$
DECLARE
  row_index INTEGER;
  column_index INTEGER;
  cell JSONB;
  row_text TEXT;
  result JSONB := '[]'::JSONB;
BEGIN
  IF candidate IS NULL THEN RETURN NULL; END IF;
  row_index := 0;
  WHILE row_index < 8 LOOP
    row_text := '';
    column_index := 0;
    WHILE column_index < 8 LOOP
      cell := candidate->'indices'->(row_index * 8 + column_index);
      IF column_index > 0 THEN row_text := row_text || ' '; END IF;
      row_text := row_text || CASE
        WHEN cell IS NULL OR jsonb_typeof(cell) = 'null' THEN '.'
        ELSE cell #>> '{}'
      END;
      column_index := column_index + 1;
    END LOOP;
    result := result || jsonb_build_array(row_text);
    row_index := row_index + 1;
  END LOOP;
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION city_drawing_presentation_state(
  owner_state TEXT,
  candidate JSONB
) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $function$
  SELECT CASE
    WHEN owner_state = 'complete' AND candidate IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(candidate->'indices') cell
      WHERE jsonb_typeof(cell) <> 'null'
    ) THEN 'blank'
    ELSE owner_state
  END
$function$;

ALTER TABLE residents ADD COLUMN IF NOT EXISTS drawing JSONB;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS drawing_state TEXT;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS drawing_description TEXT;
ALTER TABLE places ADD COLUMN IF NOT EXISTS drawing JSONB;
ALTER TABLE places ADD COLUMN IF NOT EXISTS drawing_state TEXT;
ALTER TABLE places ADD COLUMN IF NOT EXISTS drawing_description TEXT;
ALTER TABLE kind_revisions ADD COLUMN IF NOT EXISTS drawing JSONB;
ALTER TABLE kind_revisions ADD COLUMN IF NOT EXISTS drawing_state TEXT;
ALTER TABLE kind_revisions ADD COLUMN IF NOT EXISTS drawing_description TEXT;
ALTER TABLE kind_revisions ADD COLUMN IF NOT EXISTS drawing_variants JSONB;
ALTER TABLE things ADD COLUMN IF NOT EXISTS drawing JSONB;
ALTER TABLE things ADD COLUMN IF NOT EXISTS drawing_state TEXT;
ALTER TABLE things ADD COLUMN IF NOT EXISTS drawing_description TEXT;
ALTER TABLE things ADD COLUMN IF NOT EXISTS drawing_variant_name TEXT;

CREATE TABLE IF NOT EXISTS resident_drawing_rate_limits (
  resident_id  INTEGER NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  minute       TIMESTAMPTZ NOT NULL
               CHECK (minute = date_trunc('minute', minute, 'UTC')),
  used         SMALLINT NOT NULL CHECK (used BETWEEN 1 AND 6),
  PRIMARY KEY (resident_id, minute)
);
CREATE INDEX IF NOT EXISTS resident_drawing_rate_limits_expiry
  ON resident_drawing_rate_limits (minute, resident_id);

ALTER TABLE moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_target_type_check;
DO $drawing_contract_moderation_target$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'moderation_actions'::regclass
      AND conname = 'moderation_actions_target_type_allowed'
  ) THEN
    ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_target_type_allowed
      CHECK (target_type IN (
        'resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement'
      )) NOT VALID;
  END IF;
END
$drawing_contract_moderation_target$;
ALTER TABLE moderation_actions
  VALIDATE CONSTRAINT moderation_actions_target_type_allowed;

UPDATE residents SET
  drawing_state = CASE WHEN drawing IS NULL THEN 'undrawn' ELSE 'complete' END,
  drawing_description = CASE WHEN drawing IS NULL THEN NULL ELSE '' END
WHERE drawing_state IS NULL;
DO $drawing_contract_place_backfill$
BEGIN
  IF EXISTS (SELECT 1 FROM places WHERE drawing_state IS NULL) THEN
    IF EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'places'::regclass
        AND NOT tgisinternal
        AND tgenabled <> 'O'
    ) THEN
      RAISE EXCEPTION 'all place row guards must be enabled before drawing backfill';
    END IF;

    ALTER TABLE places DISABLE TRIGGER USER;
    UPDATE places SET
      drawing_state = CASE WHEN drawing IS NULL THEN 'undrawn' ELSE 'complete' END,
      drawing_description = CASE WHEN drawing IS NULL THEN NULL ELSE '' END
    WHERE drawing_state IS NULL;
    ALTER TABLE places ENABLE TRIGGER USER;

    IF EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'places'::regclass
        AND NOT tgisinternal
        AND tgenabled <> 'O'
    ) THEN
      RAISE EXCEPTION 'place row guards were not restored after drawing backfill';
    END IF;
  END IF;
END
$drawing_contract_place_backfill$;
DO $drawing_contract_kind_history_off$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'kind_revisions'::regclass
      AND tgname = 'kind_revisions_append_only'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE kind_revisions DISABLE TRIGGER kind_revisions_append_only;
  END IF;
END
$drawing_contract_kind_history_off$;
UPDATE kind_revisions SET
  drawing_state = CASE WHEN drawing IS NULL THEN 'undrawn' ELSE 'complete' END,
  drawing_description = CASE WHEN drawing IS NULL THEN NULL ELSE '' END,
  drawing_variants = coalesce(drawing_variants, '[]'::JSONB)
WHERE drawing_state IS NULL OR drawing_variants IS NULL;
DO $drawing_contract_kind_history_on$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'kind_revisions'::regclass
      AND tgname = 'kind_revisions_append_only'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE kind_revisions ENABLE TRIGGER kind_revisions_append_only;
  END IF;
END
$drawing_contract_kind_history_on$;
DO $drawing_contract_thing_history_off$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'things'::regclass
      AND tgname = 'things_keep_birth_history'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE things DISABLE TRIGGER things_keep_birth_history;
  END IF;
END
$drawing_contract_thing_history_off$;
UPDATE things SET
  drawing_state = CASE WHEN drawing IS NULL THEN 'undrawn' ELSE 'complete' END,
  drawing_description = CASE WHEN drawing IS NULL THEN NULL ELSE '' END
WHERE drawing_state IS NULL;

ALTER TABLE residents ALTER COLUMN drawing_state SET DEFAULT 'undrawn';
ALTER TABLE residents ALTER COLUMN drawing_state SET NOT NULL;
ALTER TABLE places ALTER COLUMN drawing_state SET DEFAULT 'undrawn';
ALTER TABLE places ALTER COLUMN drawing_state SET NOT NULL;
ALTER TABLE kind_revisions ALTER COLUMN drawing_state SET DEFAULT 'undrawn';
ALTER TABLE kind_revisions ALTER COLUMN drawing_state SET NOT NULL;
ALTER TABLE kind_revisions ALTER COLUMN drawing_variants SET DEFAULT '[]'::JSONB;
ALTER TABLE kind_revisions ALTER COLUMN drawing_variants SET NOT NULL;
ALTER TABLE things ALTER COLUMN drawing_state SET DEFAULT 'undrawn';
ALTER TABLE things ALTER COLUMN drawing_state SET NOT NULL;

CREATE OR REPLACE FUNCTION valid_city_drawing_revision_value(
  value_state TEXT,
  value_description TEXT,
  value_drawing JSONB,
  value_source TEXT,
  value_kind_id INTEGER,
  value_kind_revision INTEGER,
  value_variant_name TEXT
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT AS $function$
  SELECT valid_city_drawing_state(value_state, value_description, value_drawing)
    AND value_source IN ('none', 'resident', 'place', 'thing', 'kind_base', 'kind_variant')
    AND CASE value_source
      WHEN 'none' THEN value_state = 'undrawn'
        AND value_kind_id IS NULL AND value_kind_revision IS NULL
        AND value_variant_name IS NULL
      WHEN 'resident' THEN value_kind_id IS NULL AND value_kind_revision IS NULL
        AND value_variant_name IS NULL
      WHEN 'place' THEN value_kind_id IS NULL AND value_kind_revision IS NULL
        AND value_variant_name IS NULL
      WHEN 'thing' THEN value_variant_name IS NULL
        AND ((value_kind_id IS NULL AND value_kind_revision IS NULL)
          OR (value_kind_id IS NOT NULL AND value_kind_revision IS NOT NULL))
      WHEN 'kind_base' THEN value_kind_id IS NOT NULL
        AND value_kind_revision IS NOT NULL AND value_variant_name IS NULL
      WHEN 'kind_variant' THEN value_kind_id IS NOT NULL
        AND value_kind_revision IS NOT NULL
        AND valid_city_drawing_variant_name(value_variant_name)
      ELSE FALSE
    END
$function$;

CREATE TABLE IF NOT EXISTS drawing_revisions (
  id                    BIGSERIAL PRIMARY KEY,
  target_type           TEXT NOT NULL
                          CHECK (target_type IN ('resident', 'place', 'thing', 'kind')),
  target_id             INTEGER NOT NULL CHECK (target_id > 0),
  prior_state           TEXT NOT NULL,
  prior_description     TEXT,
  prior_drawing         JSONB,
  prior_source          TEXT NOT NULL,
  prior_kind_id         INTEGER,
  prior_kind_revision   INTEGER,
  prior_variant_name    TEXT,
  current_state         TEXT NOT NULL,
  current_description   TEXT,
  current_drawing       JSONB,
  current_source        TEXT NOT NULL,
  current_kind_id       INTEGER,
  current_kind_revision INTEGER,
  current_variant_name  TEXT,
  slot_variant_name     TEXT,
  author_id             INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  author_relation       TEXT NOT NULL
                          CHECK (author_relation IN ('self', 'owner', 'kind_owner', 'founder', 'legacy')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drawing_revisions_prior_valid CHECK (valid_city_drawing_revision_value(
    prior_state, prior_description, prior_drawing, prior_source,
    prior_kind_id, prior_kind_revision, prior_variant_name
  )),
  CONSTRAINT drawing_revisions_current_valid CHECK (valid_city_drawing_revision_value(
    current_state, current_description, current_drawing, current_source,
    current_kind_id, current_kind_revision, current_variant_name
  )),
  CONSTRAINT drawing_revisions_slot_variant_valid CHECK (
    slot_variant_name IS NULL OR valid_city_drawing_variant_name(slot_variant_name)
  ),
  CONSTRAINT drawing_revisions_real_change CHECK (
    ROW(
      prior_state, prior_description, prior_drawing, prior_source,
      prior_kind_id, prior_kind_revision, prior_variant_name
    ) IS DISTINCT FROM ROW(
      current_state, current_description, current_drawing, current_source,
      current_kind_id, current_kind_revision, current_variant_name
    )
  )
);
CREATE INDEX IF NOT EXISTS drawing_revisions_target_history
  ON drawing_revisions (target_type, target_id, id DESC);
CREATE INDEX IF NOT EXISTS drawing_revisions_author
  ON drawing_revisions (author_id, id DESC) WHERE author_id IS NOT NULL;

-- Existing preview art is an honest baseline, not retroactively attributed to
-- an owner. Typed instance pixels are recorded once and then return to their
-- pinned kind presentation.
INSERT INTO drawing_revisions (
  target_type, target_id,
  prior_state, prior_description, prior_drawing, prior_source,
  current_state, current_description, current_drawing, current_source,
  author_id, author_relation
)
SELECT 'resident', resident.id,
  'undrawn', NULL, NULL, 'none',
  'complete', '', resident.drawing, 'resident',
  NULL, 'legacy'
FROM residents resident
WHERE resident.drawing IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM drawing_revisions revision
    WHERE revision.target_type = 'resident' AND revision.target_id = resident.id
      AND revision.author_relation = 'legacy'
  );

INSERT INTO drawing_revisions (
  target_type, target_id,
  prior_state, prior_description, prior_drawing, prior_source,
  current_state, current_description, current_drawing, current_source,
  author_id, author_relation
)
SELECT 'place', place.id,
  'undrawn', NULL, NULL, 'none',
  'complete', '', place.drawing, 'place',
  NULL, 'legacy'
FROM places place
WHERE place.drawing IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM drawing_revisions revision
    WHERE revision.target_type = 'place' AND revision.target_id = place.id
      AND revision.author_relation = 'legacy'
  );

INSERT INTO drawing_revisions (
  target_type, target_id,
  prior_state, prior_description, prior_drawing, prior_source,
  current_state, current_description, current_drawing, current_source,
  current_kind_id, current_kind_revision,
  author_id, author_relation
)
SELECT 'kind', definition.kind_id,
  'undrawn', NULL, NULL, 'none',
  'complete', '', definition.drawing, 'kind_base',
  definition.kind_id, definition.revision,
  NULL, 'legacy'
FROM kind_revisions definition
WHERE definition.drawing IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM drawing_revisions history
    WHERE history.target_type = 'kind' AND history.target_id = definition.kind_id
      AND history.current_kind_revision = definition.revision
      AND history.author_relation = 'legacy'
  );

INSERT INTO drawing_revisions (
  target_type, target_id,
  prior_state, prior_description, prior_drawing, prior_source,
  current_state, current_description, current_drawing, current_source,
  author_id, author_relation
)
SELECT 'thing', thing.id,
  'undrawn', NULL, NULL, 'none',
  'complete', '', thing.drawing, 'thing',
  NULL, 'legacy'
FROM things thing
WHERE thing.kind_id IS NULL AND thing.drawing IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM drawing_revisions revision
    WHERE revision.target_type = 'thing' AND revision.target_id = thing.id
      AND revision.author_relation = 'legacy'
  );

INSERT INTO drawing_revisions (
  target_type, target_id,
  prior_state, prior_description, prior_drawing, prior_source,
  prior_kind_id, prior_kind_revision,
  current_state, current_description, current_drawing, current_source,
  current_kind_id, current_kind_revision, slot_variant_name,
  author_id, author_relation
)
SELECT 'thing', thing.id,
  'complete', '', thing.drawing, 'thing', thing.kind_id, thing.current_revision,
  CASE WHEN definition.drawing IS NULL THEN 'undrawn' ELSE definition.drawing_state END,
  CASE WHEN definition.drawing IS NULL THEN NULL ELSE definition.drawing_description END,
  definition.drawing,
  CASE WHEN definition.drawing IS NULL THEN 'none' ELSE 'kind_base' END,
  CASE WHEN definition.drawing IS NULL THEN NULL ELSE thing.kind_id END,
  CASE WHEN definition.drawing IS NULL THEN NULL ELSE thing.current_revision END,
  NULL,
  NULL, 'legacy'
FROM things thing
JOIN kind_revisions definition
  ON definition.kind_id = thing.kind_id AND definition.revision = thing.current_revision
WHERE thing.kind_id IS NOT NULL AND thing.drawing IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM drawing_revisions revision
    WHERE revision.target_type = 'thing' AND revision.target_id = thing.id
      AND revision.author_relation = 'legacy'
  );

UPDATE things SET
  drawing = NULL,
  drawing_state = 'undrawn',
  drawing_description = NULL
WHERE kind_id IS NOT NULL AND drawing IS NOT NULL;
DO $drawing_contract_thing_history_on$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'things'::regclass
      AND tgname = 'things_keep_birth_history'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE things ENABLE TRIGGER things_keep_birth_history;
  END IF;
END
$drawing_contract_thing_history_on$;

DO $drawing_contract_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'residents'::regclass
    AND conname = 'residents_drawing_contract') THEN
    ALTER TABLE residents ADD CONSTRAINT residents_drawing_contract
      CHECK (valid_city_drawing_state(drawing_state, drawing_description, drawing)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'places'::regclass
    AND conname = 'places_drawing_contract') THEN
    ALTER TABLE places ADD CONSTRAINT places_drawing_contract
      CHECK (valid_city_drawing_state(drawing_state, drawing_description, drawing)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kind_revisions'::regclass
    AND conname = 'kind_revisions_drawing_contract') THEN
    ALTER TABLE kind_revisions ADD CONSTRAINT kind_revisions_drawing_contract
      CHECK (valid_city_drawing_state(drawing_state, drawing_description, drawing)
        AND valid_city_drawing_variants(drawing_variants)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
    AND conname = 'things_drawing_contract') THEN
    ALTER TABLE things ADD CONSTRAINT things_drawing_contract CHECK (
      valid_city_drawing_state(drawing_state, drawing_description, drawing)
      AND (drawing_variant_name IS NULL OR (
        kind_id IS NOT NULL AND valid_city_drawing_variant_name(drawing_variant_name)
      ))
      AND (kind_id IS NULL OR (
        drawing IS NULL AND drawing_state IN ('undrawn', 'refused')
      ))
    ) NOT VALID;
  END IF;
END
$drawing_contract_constraints$;

ALTER TABLE residents VALIDATE CONSTRAINT residents_drawing_contract;
ALTER TABLE places VALIDATE CONSTRAINT places_drawing_contract;
ALTER TABLE kind_revisions VALIDATE CONSTRAINT kind_revisions_drawing_contract;
ALTER TABLE things VALIDATE CONSTRAINT things_drawing_contract;

CREATE OR REPLACE FUNCTION validate_thing_drawing_variant() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT AS $function$
BEGIN
  IF NEW.drawing_variant_name IS NULL THEN RETURN NEW; END IF;
  IF NOT valid_city_drawing_variant_name(NEW.drawing_variant_name)
    OR NEW.kind_id IS NULL OR NEW.current_revision IS NULL OR NOT EXISTS (
    SELECT 1
    FROM kind_revisions definition,
      LATERAL jsonb_array_elements(definition.drawing_variants) variant
    WHERE definition.kind_id = NEW.kind_id
      AND definition.revision = NEW.current_revision
      AND variant->>'name' = NEW.drawing_variant_name
  ) THEN
    RAISE EXCEPTION 'selected drawing variant is absent from the pinned kind revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS things_validate_drawing_variant ON things;
CREATE TRIGGER things_validate_drawing_variant
BEFORE INSERT OR UPDATE OF kind_id, current_revision, drawing_variant_name ON things
FOR EACH ROW EXECUTE FUNCTION validate_thing_drawing_variant();

CREATE OR REPLACE FUNCTION deny_drawing_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'drawing revisions are immutable' USING ERRCODE = '55000';
END
$function$;

DROP TRIGGER IF EXISTS drawing_revisions_append_only ON drawing_revisions;
CREATE TRIGGER drawing_revisions_append_only
BEFORE UPDATE OR DELETE ON drawing_revisions
FOR EACH ROW EXECUTE FUNCTION deny_drawing_revision_mutation();

CREATE OR REPLACE FUNCTION city_drawing_public_value(
  value_state TEXT,
  value_description TEXT,
  value_drawing JSONB,
  value_source TEXT,
  value_kind_id INTEGER,
  value_kind_name TEXT,
  value_kind_revision INTEGER,
  value_variant_name TEXT
) RETURNS JSONB
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT AS $function$
  SELECT jsonb_build_object(
    'state', value_state,
    'presentation_state', city_drawing_presentation_state(value_state, value_drawing),
    'description', value_description,
    'drawing', value_drawing,
    'rows', city_drawing_rows(value_drawing),
    'source', value_source
  ) || jsonb_strip_nulls(jsonb_build_object(
    'kind_id', value_kind_id,
    'kind_name', value_kind_name,
    'revision', value_kind_revision,
    'variant_name', value_variant_name
  ))
$function$;

-- Preserve the explicit pre-contract allowlist as a private base view. The
-- public view below adds only the new drawing fields and separate revisions.
DO $drawing_snapshot_base$
BEGIN
  IF to_regclass('city_snapshot.public_records_without_drawing_contract') IS NULL THEN
    ALTER VIEW city_snapshot.public_records RENAME TO public_records_without_drawing_contract;
  END IF;
END
$drawing_snapshot_base$;

REVOKE ALL ON city_snapshot.public_records_without_drawing_contract FROM PUBLIC;
REVOKE ALL ON city_snapshot.public_records_without_drawing_contract FROM city_snapshot_export;

CREATE OR REPLACE VIEW city_snapshot.public_records
WITH (security_barrier = true)
AS
WITH latest_moderation AS (
  SELECT DISTINCT ON (action.target_type, action.target_id)
    action.target_type, action.target_id, action.action
  FROM public.moderation_actions action
  ORDER BY action.target_type, action.target_id, action.created_at DESC, action.id DESC
), enriched AS (
  SELECT base.class_name, base.record_id, base.sort_key,
    CASE
      WHEN base.payload->>'status' <> 'exported' THEN base.payload
      WHEN base.class_name = 'residents' AND resident.id IS NOT NULL THEN
        base.payload || CASE WHEN resident_hidden.action = 'remove' THEN jsonb_build_object(
          'drawing', NULL, 'drawing_state', NULL, 'drawing_presentation_state', NULL,
          'drawing_description', NULL, 'drawing_rows', NULL, 'drawing_source', NULL
        ) ELSE jsonb_build_object(
          'drawing', resident.drawing,
          'drawing_state', resident.drawing_state,
          'drawing_presentation_state', city_drawing_presentation_state(
            resident.drawing_state, resident.drawing
          ),
          'drawing_description', resident.drawing_description,
          'drawing_rows', city_drawing_rows(resident.drawing),
          'drawing_source', CASE WHEN resident.drawing_state = 'undrawn'
            THEN 'none' ELSE 'resident' END
        ) END
      WHEN base.class_name = 'places' AND place.id IS NOT NULL THEN
        base.payload || jsonb_build_object(
          'drawing', place.drawing,
          'drawing_state', place.drawing_state,
          'drawing_presentation_state', city_drawing_presentation_state(
            place.drawing_state, place.drawing
          ),
          'drawing_description', place.drawing_description,
          'drawing_rows', city_drawing_rows(place.drawing),
          'drawing_source', CASE WHEN place.drawing_state = 'undrawn'
            THEN 'none' ELSE 'place' END
        )
      WHEN base.class_name = 'kinds' AND kind.id IS NOT NULL THEN
        base.payload || jsonb_build_object(
          'drawing', definition.drawing,
          'drawing_state', definition.drawing_state,
          'drawing_presentation_state', city_drawing_presentation_state(
            definition.drawing_state, definition.drawing
          ),
          'drawing_description', definition.drawing_description,
          'drawing_rows', city_drawing_rows(definition.drawing),
          'drawing_source', CASE WHEN definition.drawing_state = 'undrawn'
            THEN 'none' ELSE 'kind_base' END,
          'drawing_variants', definition.drawing_variants,
          'kind_id', kind.id,
          'kind_name', kind.name,
          'variant_name', NULL
        )
      WHEN base.class_name = 'things' AND thing.id IS NOT NULL THEN
        base.payload || jsonb_build_object(
          'drawing', effective.drawing,
          'drawing_state', effective.state,
          'drawing_presentation_state', city_drawing_presentation_state(
            effective.state, effective.drawing
          ),
          'drawing_description', effective.description,
          'drawing_rows', city_drawing_rows(effective.drawing),
          'drawing_source', effective.source,
          'kind_id', effective.kind_id,
          'kind_name', effective.kind_name,
          'revision', effective.kind_revision,
          'variant_name', effective.variant_name
        )
      ELSE base.payload
    END AS payload
  FROM city_snapshot.public_records_without_drawing_contract base
  LEFT JOIN public.residents resident
    ON base.class_name = 'residents' AND resident.id::TEXT = base.record_id
  LEFT JOIN latest_moderation resident_hidden
    ON resident_hidden.target_type = 'resident' AND resident_hidden.target_id = resident.id
  LEFT JOIN public.places place
    ON base.class_name = 'places' AND place.id::TEXT = base.record_id
  LEFT JOIN public.kinds kind
    ON base.class_name = 'kinds' AND kind.id::TEXT = base.record_id
  LEFT JOIN public.kind_revisions definition
    ON definition.kind_id = kind.id AND definition.revision = kind.current_revision
  LEFT JOIN public.things thing
    ON base.class_name = 'things' AND thing.id::TEXT = base.record_id
  LEFT JOIN public.kinds thing_kind ON thing_kind.id = thing.kind_id
  LEFT JOIN public.kind_revisions thing_definition
    ON thing_definition.kind_id = thing.kind_id
    AND thing_definition.revision = thing.current_revision
  LEFT JOIN latest_moderation thing_kind_hidden
    ON thing_kind_hidden.target_type = 'kind' AND thing_kind_hidden.target_id = thing.kind_id
  LEFT JOIN LATERAL (
    SELECT variant.value
    FROM jsonb_array_elements(coalesce(thing_definition.drawing_variants, '[]'::JSONB)) variant(value)
    WHERE variant.value->>'name' = thing.drawing_variant_name
  ) selected_variant ON true
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN thing.drawing_state <> 'undrawn' THEN thing.drawing_state
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          AND selected_variant.value IS NOT NULL THEN selected_variant.value->>'state'
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          THEN thing_definition.drawing_state
        ELSE CASE
          WHEN thing.kind_id IS NOT NULL
            AND coalesce(thing_kind_hidden.action, 'restore') = 'remove' THEN NULL
          ELSE 'undrawn'
        END
      END AS state,
      CASE
        WHEN thing.drawing_state <> 'undrawn' THEN thing.drawing_description
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          AND selected_variant.value IS NOT NULL THEN selected_variant.value->>'description'
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          THEN thing_definition.drawing_description
        ELSE NULL
      END AS description,
      CASE
        WHEN thing.drawing_state <> 'undrawn' THEN thing.drawing
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          AND selected_variant.value IS NOT NULL THEN selected_variant.value->'drawing'
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          THEN thing_definition.drawing
        ELSE NULL
      END AS drawing,
      CASE
        WHEN thing.drawing_state <> 'undrawn' THEN 'thing'
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          AND selected_variant.value IS NOT NULL THEN 'kind_variant'
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          AND thing_definition.drawing_state <> 'undrawn' THEN 'kind_base'
        ELSE CASE
          WHEN thing.kind_id IS NOT NULL
            AND coalesce(thing_kind_hidden.action, 'restore') = 'remove' THEN NULL
          ELSE 'none'
        END
      END AS source,
      CASE WHEN thing.kind_id IS NOT NULL
        AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
        THEN thing.kind_id ELSE NULL END AS kind_id,
      CASE WHEN thing.kind_id IS NOT NULL
        AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
        THEN thing_kind.name ELSE NULL END AS kind_name,
      CASE WHEN thing.kind_id IS NOT NULL
        AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
        THEN thing.current_revision ELSE NULL END AS kind_revision,
      CASE WHEN thing.drawing_state = 'undrawn'
        AND selected_variant.value IS NOT NULL
        AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
        THEN thing.drawing_variant_name ELSE NULL END
        AS variant_name
  ) effective ON true
)
SELECT class_name, record_id, sort_key, payload FROM enriched

UNION ALL

SELECT 'drawing_revisions', revision.id::TEXT, revision.id,
  jsonb_build_object(
    'id', revision.id,
    'status', 'exported',
    'target_type', revision.target_type,
    'target_id', revision.target_id,
    'previous', city_drawing_public_value(
      revision.prior_state, revision.prior_description, revision.prior_drawing,
      revision.prior_source, revision.prior_kind_id, prior_kind.name,
      revision.prior_kind_revision, revision.prior_variant_name
    ),
    'current', city_drawing_public_value(
      revision.current_state, revision.current_description, revision.current_drawing,
      revision.current_source, revision.current_kind_id, current_kind.name,
      revision.current_kind_revision, revision.current_variant_name
    ),
    'source', revision.current_source,
    'slot_variant_name', revision.slot_variant_name,
    'author_id', revision.author_id,
    'author', author.handle,
    'author_relation', revision.author_relation,
    'created_at', revision.created_at
  )
FROM public.drawing_revisions revision
LEFT JOIN public.residents author ON author.id = revision.author_id
LEFT JOIN public.kinds prior_kind ON prior_kind.id = revision.prior_kind_id
LEFT JOIN public.kinds current_kind ON current_kind.id = revision.current_kind_id
LEFT JOIN latest_moderation moderation_actions_parent_hidden
  ON moderation_actions_parent_hidden.target_type = revision.target_type
  AND moderation_actions_parent_hidden.target_id = revision.target_id
LEFT JOIN latest_moderation moderation_actions_source_kind_hidden
  ON moderation_actions_source_kind_hidden.target_type = 'kind'
  AND moderation_actions_source_kind_hidden.target_id = coalesce(
    revision.current_kind_id, revision.prior_kind_id
  )
WHERE coalesce(moderation_actions_parent_hidden.action, 'restore') <> 'remove'
  AND coalesce(moderation_actions_source_kind_hidden.action, 'restore') <> 'remove';

REVOKE ALL ON city_snapshot.public_records FROM PUBLIC;
GRANT USAGE ON SCHEMA city_snapshot TO city_snapshot_export;
GRANT SELECT ON city_snapshot.public_records TO city_snapshot_export;

COMMIT;
