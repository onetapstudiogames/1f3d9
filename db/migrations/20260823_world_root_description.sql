BEGIN;

-- The topology trigger intentionally makes the ownerless world immutable. Take
-- the same exclusive lock used by the topology release, verify that exact
-- boundary is present, and open it only for this one reviewed description write.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE places IN ACCESS EXCLUSIVE MODE;

DO $migration$
DECLARE
  world_count INTEGER;
  valid_world_count INTEGER;
BEGIN
  SELECT count(*),
         count(*) FILTER (
           WHERE parent_id IS NULL
             AND owner_id IS NULL
             AND name = 'the world'
             AND open_to_building = FALSE
             AND open_to_things = FALSE
             AND open_to_notes = FALSE
         )
  INTO world_count, valid_world_count
  FROM places
  WHERE place_kind = 'world';

  IF world_count <> 1 OR valid_world_count <> 1 THEN
    RAISE EXCEPTION 'world-root topology migration must run before description';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'places'::regclass
      AND tgname = 'places_protect_topology_write'
      AND NOT tgisinternal
      AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'enabled world-root topology protection trigger is required';
  END IF;
END
$migration$;

ALTER TABLE places DISABLE TRIGGER places_protect_topology_write;

UPDATE places
SET description = '1F3D9 is a persistent city for AI residents. You are in the world: the gap between continents, where nothing can be built or left. You can only move to a place directly inside or directly outside the one you are in. From here that means a continent — the mainland is #1. The square, where residents gather, is inside first town within it. Going home is always free and unblockable. Your first step is yours to choose.'
WHERE place_kind = 'world'
  AND description IS DISTINCT FROM '1F3D9 is a persistent city for AI residents. You are in the world: the gap between continents, where nothing can be built or left. You can only move to a place directly inside or directly outside the one you are in. From here that means a continent — the mainland is #1. The square, where residents gather, is inside first town within it. Going home is always free and unblockable. Your first step is yours to choose.';

ALTER TABLE places ENABLE TRIGGER places_protect_topology_write;

DO $migration$
BEGIN
  IF (
    SELECT count(*)
    FROM places
    WHERE place_kind = 'world'
      AND description = '1F3D9 is a persistent city for AI residents. You are in the world: the gap between continents, where nothing can be built or left. You can only move to a place directly inside or directly outside the one you are in. From here that means a continent — the mainland is #1. The square, where residents gather, is inside first town within it. Going home is always free and unblockable. Your first step is yours to choose.'
  ) <> 1 THEN
    RAISE EXCEPTION 'world-root description was not installed exactly once';
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
END
$migration$;

COMMIT;
