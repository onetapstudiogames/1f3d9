BEGIN;

-- The ownerless world is ordinarily immutable. Take the same exclusive lock as
-- its topology releases, verify the exact protected root, and open that guard
-- only for this founder-authored presentation write.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE places IN ACCESS EXCLUSIVE MODE;

DO $migration$
DECLARE
  founder_drawing CONSTANT JSONB :=
    '{"palette":["#0b1714","#123026","#1c4434"],"indices":[0,0,0,0,0,0,0,0,null,0,1,0,0,0,0,0,null,0,0,0,0,0,1,0,0,null,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,null,0,1,0,0,0,0,0,null,0,0,0,0,1,0,0,0,0,0,1,0,0]}'::jsonb;
  drawing_is_valid BOOLEAN;
  world_count INTEGER;
  valid_world_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'places'
      AND column_name = 'drawing'
      AND data_type = 'jsonb'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'drawings migration must run before world-root drawing';
  END IF;

  IF to_regprocedure('valid_city_drawing(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'drawing validator must exist before world-root drawing';
  END IF;
  EXECUTE 'SELECT valid_city_drawing($1)'
  INTO drawing_is_valid
  USING founder_drawing;
  IF drawing_is_valid IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'founder world drawing failed its stored drawing contract';
  END IF;

  SELECT count(*),
         count(*) FILTER (
           WHERE parent_id IS NULL
             AND owner_id IS NULL
             AND name = 'the world'
             AND active_offer_id IS NULL
             AND NOT open_to_building
             AND NOT open_to_things
             AND NOT open_to_notes
             AND (drawing IS NULL OR drawing = founder_drawing)
         )
  INTO world_count, valid_world_count
  FROM places
  WHERE place_kind = 'world';

  IF world_count <> 1 OR valid_world_count <> 1 THEN
    RAISE EXCEPTION 'world-root topology must be exact before its drawing is installed';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_trigger
    WHERE tgrelid = 'places'::regclass
      AND tgname = 'places_protect_topology_write'
      AND NOT tgisinternal
      AND tgenabled = 'O'
  ) <> 1 THEN
    RAISE EXCEPTION 'enabled world-root topology protection trigger is required';
  END IF;
END
$migration$;

ALTER TABLE places DROP CONSTRAINT IF EXISTS places_world_shape;
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_world_drawing_exact;
ALTER TABLE places DISABLE TRIGGER places_protect_topology_write;

DO $drawing_contract_compatible_write$
DECLARE
  founder_drawing CONSTANT JSONB :=
    '{"palette":["#0b1714","#123026","#1c4434"],"indices":[0,0,0,0,0,0,0,0,null,0,1,0,0,0,0,0,null,0,0,0,0,0,1,0,0,null,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,null,0,1,0,0,0,0,0,null,0,0,0,0,1,0,0,0,0,0,1,0,0]}'::jsonb;
  drawing_contract_column_count INTEGER;
BEGIN
  SELECT count(*) INTO drawing_contract_column_count
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'places'
    AND column_name IN ('drawing_state', 'drawing_description');

  IF drawing_contract_column_count = 2 THEN
    EXECUTE $sql$
      UPDATE places
      SET drawing = $1,
          drawing_state = 'complete',
          drawing_description = coalesce(drawing_description, '')
      WHERE place_kind = 'world'
        AND (
          drawing IS DISTINCT FROM $1
          OR drawing_state IS DISTINCT FROM 'complete'
          OR drawing_description IS NULL
        )
    $sql$ USING founder_drawing;
  ELSIF drawing_contract_column_count = 0 THEN
    UPDATE places
    SET drawing = founder_drawing
    WHERE place_kind = 'world'
      AND drawing IS DISTINCT FROM founder_drawing;
  ELSE
    RAISE EXCEPTION 'world-root drawing found a partial drawing contract';
  END IF;
END
$drawing_contract_compatible_write$;

ALTER TABLE places ENABLE TRIGGER places_protect_topology_write;

ALTER TABLE places ADD CONSTRAINT places_world_shape CHECK (
  (
    place_kind = 'world'
    AND parent_id IS NULL
    AND name = 'the world'
    AND owner_id IS NULL
    AND active_offer_id IS NULL
    AND NOT open_to_building
    AND NOT open_to_things
    AND NOT open_to_notes
  )
  OR (
    place_kind IN ('continent', 'place')
    AND parent_id IS NOT NULL
    AND owner_id IS NOT NULL
  )
) NOT VALID;
ALTER TABLE places VALIDATE CONSTRAINT places_world_shape;
ALTER TABLE places ADD CONSTRAINT places_world_drawing_exact CHECK (
  place_kind <> 'world'
  OR drawing IS NOT DISTINCT FROM
    '{"palette":["#0b1714","#123026","#1c4434"],"indices":[0,0,0,0,0,0,0,0,null,0,1,0,0,0,0,0,null,0,0,0,0,0,1,0,0,null,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,null,0,1,0,0,0,0,0,null,0,0,0,0,1,0,0,0,0,0,1,0,0]}'::jsonb
) NOT VALID;
ALTER TABLE places VALIDATE CONSTRAINT places_world_drawing_exact;

DO $migration$
DECLARE
  founder_drawing CONSTANT JSONB :=
    '{"palette":["#0b1714","#123026","#1c4434"],"indices":[0,0,0,0,0,0,0,0,null,0,1,0,0,0,0,0,null,0,0,0,0,0,1,0,0,null,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,null,0,1,0,0,0,0,0,null,0,0,0,0,1,0,0,0,0,0,1,0,0]}'::jsonb;
BEGIN
  IF (
    SELECT count(*)
    FROM places
    WHERE place_kind = 'world'
      AND drawing = founder_drawing
  ) <> 1 THEN
    RAISE EXCEPTION 'founder world drawing was not installed exactly once';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'places'::regclass
      AND tgname = 'places_protect_topology_write'
      AND NOT tgisinternal
      AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'world-root topology protection trigger was not restored';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_world_shape'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'world-root shape constraint was not validated';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_world_drawing_exact'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'world-root drawing constraint was not validated';
  END IF;
END
$migration$;

COMMIT;
