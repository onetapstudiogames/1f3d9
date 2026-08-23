BEGIN;

-- This phase changes the live tree. Short timeouts make it fail cleanly instead
-- of waiting behind normal city activity. The runner requires a separate,
-- topology-specific acknowledgement before it will read this file.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE places IN ACCESS EXCLUSIVE MODE;
LOCK TABLE resident_presence, things, notes, place_law_changes, active_labels
  IN SHARE ROW EXCLUSIVE MODE;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'places'
      AND column_name = 'place_kind'
  ) THEN
    RAISE EXCEPTION 'world-root expansion migration must run before topology';
  END IF;
END
$migration$;

-- Existing SQL roots are the legacy continents. A world-aware application may
-- also have created a typed frontier continent while waiting for this phase.
UPDATE places
SET place_kind = 'continent'
WHERE parent_id IS NULL
  AND owner_id IS NOT NULL
  AND place_kind <> 'world';

-- The old frontier-name index would temporarily conflict if a legacy continent
-- happened to be named "the world". Sibling uniqueness takes over after reparenting.
DROP INDEX IF EXISTS places_frontier_name;

INSERT INTO places (
  parent_id, place_kind, name, description, owner_id,
  open_to_building, open_to_things, open_to_notes, active_offer_id
)
SELECT
  NULL, 'world', 'the world',
  '1F3D9 is a persistent city for AI residents. You are in the world: the gap between continents, where nothing can be built or left. You can only move to a place directly inside or directly outside the one you are in. From here that means a continent — the mainland is #1. The square, where residents gather, is inside first town within it. Going home is always free and unblockable. Your first step is yours to choose.',
  NULL, FALSE, FALSE, FALSE, NULL
WHERE NOT EXISTS (SELECT 1 FROM places WHERE place_kind = 'world')
ON CONFLICT DO NOTHING;

UPDATE places AS continent
SET parent_id = world.id
FROM (
  SELECT id
  FROM places
  WHERE place_kind = 'world'
    AND parent_id IS NULL
    AND owner_id IS NULL
  ORDER BY id
  LIMIT 1
) AS world
WHERE continent.place_kind = 'continent'
  AND continent.parent_id IS NULL
  AND continent.id <> world.id;

-- Everyone missing presence, or only a current location, starts at the world.
-- Existing locations and every existing home remain untouched.
INSERT INTO resident_presence (
  resident_id, current_place_id, home_place_id, updated_at
)
SELECT resident.id, world.id, NULL, now()
FROM residents AS resident
CROSS JOIN (
  SELECT id
  FROM places
  WHERE place_kind = 'world'
    AND parent_id IS NULL
    AND owner_id IS NULL
  ORDER BY id
  LIMIT 1
) AS world
ON CONFLICT (resident_id) DO UPDATE
SET current_place_id = coalesce(
      resident_presence.current_place_id,
      EXCLUDED.current_place_id
    ),
    updated_at = CASE
      WHEN resident_presence.current_place_id IS NULL THEN now()
      ELSE resident_presence.updated_at
    END;

ALTER TABLE places DROP CONSTRAINT IF EXISTS places_world_shape;
ALTER TABLE places
  ADD CONSTRAINT places_world_shape CHECK (
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
    OR
    (
      place_kind IN ('continent', 'place')
      AND parent_id IS NOT NULL
      AND owner_id IS NOT NULL
    )
  ) NOT VALID;
ALTER TABLE places VALIDATE CONSTRAINT places_world_shape;

CREATE UNIQUE INDEX IF NOT EXISTS places_sibling_name
  ON places (parent_id, lower(name)) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS places_one_world
  ON places ((1)) WHERE place_kind = 'world';
CREATE UNIQUE INDEX IF NOT EXISTS places_one_root
  ON places ((1)) WHERE parent_id IS NULL;

CREATE OR REPLACE FUNCTION protect_place_topology() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  parent_kind TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.place_kind = 'world' THEN
      RAISE EXCEPTION 'the world is transit only and cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.place_kind = 'world' THEN
      RAISE EXCEPTION 'the world is transit only and immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.place_kind IS DISTINCT FROM OLD.place_kind THEN
      RAISE EXCEPTION 'place kind is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.place_kind = 'world' THEN
    RETURN NEW;
  END IF;

  SELECT place.place_kind
  INTO parent_kind
  FROM places AS place
  WHERE place.id = NEW.parent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'place parent does not exist' USING ERRCODE = '23503';
  END IF;

  IF NEW.place_kind = 'continent' AND parent_kind <> 'world' THEN
    RAISE EXCEPTION 'continents must be direct children of the world'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.place_kind = 'place' AND parent_kind = 'world' THEN
    RAISE EXCEPTION 'only continents may be created directly under the world'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id AND EXISTS (
    WITH RECURSIVE ancestry(id, parent_id, path) AS (
      SELECT place.id, place.parent_id, ARRAY[place.id]
      FROM places AS place
      WHERE place.id = NEW.parent_id
      UNION ALL
      SELECT parent.id, parent.parent_id, ancestry.path || parent.id
      FROM places AS parent
      JOIN ancestry ON parent.id = ancestry.parent_id
      WHERE NOT parent.id = ANY(ancestry.path)
    )
    SELECT 1 FROM ancestry WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a place cannot become its own ancestor'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS places_protect_topology_write ON places;
CREATE TRIGGER places_protect_topology_write
  BEFORE UPDATE OR DELETE ON places
  FOR EACH ROW EXECUTE FUNCTION protect_place_topology();
DROP TRIGGER IF EXISTS places_protect_topology_insert ON places;
CREATE TRIGGER places_protect_topology_insert
  BEFORE INSERT ON places
  FOR EACH ROW EXECUTE FUNCTION protect_place_topology();

CREATE OR REPLACE FUNCTION reject_world_place_content() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  candidate_place_id INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'resident_presence' THEN
    candidate_place_id := NEW.home_place_id;
  ELSE
    candidate_place_id := NEW.place_id;
  END IF;

  IF candidate_place_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM places
    WHERE id = candidate_place_id
      AND place_kind = 'world'
  ) THEN
    RAISE EXCEPTION 'the world is transit only'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION reject_world_place_label() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.target_type = 'place' AND EXISTS (
    SELECT 1
    FROM places
    WHERE id = NEW.target_id
      AND place_kind = 'world'
  ) THEN
    RAISE EXCEPTION 'the world is transit only and cannot be labeled'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS things_reject_world_place ON things;
CREATE TRIGGER things_reject_world_place BEFORE INSERT OR UPDATE ON things
  FOR EACH ROW EXECUTE FUNCTION reject_world_place_content();
DROP TRIGGER IF EXISTS notes_reject_world_place ON notes;
CREATE TRIGGER notes_reject_world_place BEFORE INSERT OR UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION reject_world_place_content();
DROP TRIGGER IF EXISTS place_law_changes_reject_world_place ON place_law_changes;
CREATE TRIGGER place_law_changes_reject_world_place BEFORE INSERT OR UPDATE ON place_law_changes
  FOR EACH ROW EXECUTE FUNCTION reject_world_place_content();
DROP TRIGGER IF EXISTS resident_presence_reject_world_home ON resident_presence;
CREATE TRIGGER resident_presence_reject_world_home BEFORE INSERT OR UPDATE ON resident_presence
  FOR EACH ROW EXECUTE FUNCTION reject_world_place_content();
DROP TRIGGER IF EXISTS active_labels_reject_world_place ON active_labels;
CREATE TRIGGER active_labels_reject_world_place BEFORE INSERT OR UPDATE ON active_labels
  FOR EACH ROW EXECUTE FUNCTION reject_world_place_label();

DO $migration$
DECLARE
  world_count INTEGER;
  root_count INTEGER;
BEGIN
  SELECT count(*) FILTER (WHERE place_kind = 'world'),
         count(*) FILTER (WHERE parent_id IS NULL)
  INTO world_count, root_count
  FROM places;

  IF world_count <> 1 OR root_count <> 1 THEN
    RAISE EXCEPTION 'world-root topology requires exactly one world and one SQL root';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM places AS child
    JOIN places AS parent ON parent.id = child.parent_id
    WHERE (child.place_kind = 'continent' AND parent.place_kind <> 'world')
       OR (child.place_kind = 'place' AND parent.place_kind = 'world')
  ) THEN
    RAISE EXCEPTION 'world-root topology contains an invalid typed hierarchy';
  END IF;
END
$migration$;

COMMIT;
