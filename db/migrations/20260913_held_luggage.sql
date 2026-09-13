-- One held thing may follow its owner through rooms closed to visitor things.
ALTER TABLE things ADD COLUMN IF NOT EXISTS held_by INTEGER REFERENCES residents(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS things_one_held_per_resident
  ON things (held_by) WHERE held_by IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'things_held_owner_active') THEN
    ALTER TABLE things ADD CONSTRAINT things_held_owner_active CHECK (
      held_by IS NULL OR (held_by = owner_id AND withdrawn_at IS NULL AND active_offer_id IS NULL)
    );
  END IF;
END $$;

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
    SELECT 1 FROM places
    WHERE id = candidate_place_id AND place_kind = 'world'
  ) THEN
    IF TG_TABLE_NAME = 'things' THEN
      IF NEW.held_by IS NOT NULL THEN
        IF NEW.held_by = NEW.owner_id AND NEW.withdrawn_at IS NULL AND EXISTS (
          SELECT 1 FROM resident_presence presence
          WHERE presence.resident_id = NEW.held_by
            AND presence.current_place_id = candidate_place_id
        ) THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;
    RAISE EXCEPTION 'the world is transit only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION release_held_luggage_on_place_access() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE things SET held_by = NULL
  WHERE place_id = NEW.id AND held_by IS NOT NULL
    AND (NEW.open_to_things OR NEW.owner_id = held_by);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS places_release_held_luggage ON places;
CREATE TRIGGER places_release_held_luggage
  AFTER UPDATE OF owner_id, open_to_things ON places
  FOR EACH ROW
  WHEN (OLD.owner_id IS DISTINCT FROM NEW.owner_id
    OR OLD.open_to_things IS DISTINCT FROM NEW.open_to_things)
  EXECUTE FUNCTION release_held_luggage_on_place_access();

-- The protected Gazette remains closed to ordinary things while a resident
-- passes through with their one held thing.
CREATE OR REPLACE FUNCTION gazette_submission_room_has_no_forbidden_contents()
RETURNS BOOLEAN
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM place_law_changes WHERE place_id = 454
  ) AND NOT EXISTS (
    SELECT 1 FROM places WHERE parent_id = 454
  ) AND NOT EXISTS (
    SELECT 1 FROM things thing WHERE thing.place_id = 454
      AND (thing.held_by IS NULL OR NOT EXISTS (
        SELECT 1 FROM resident_presence presence
        WHERE presence.resident_id = thing.held_by
          AND presence.current_place_id = 454
      ))
  )
$$;

CREATE OR REPLACE FUNCTION protect_gazette_submission_room_dependents()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row JSONB;
  new_row JSONB;
  target_column TEXT;
  touches_room BOOLEAN;
BEGIN
  old_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  new_row := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  target_column := CASE WHEN TG_TABLE_NAME = 'places' THEN 'parent_id' ELSE 'place_id' END;
  touches_room := coalesce((old_row ->> target_column)::integer = 454, FALSE)
    OR coalesce((new_row ->> target_column)::integer = 454, FALSE);

  IF touches_room AND TG_TABLE_NAME = 'place_law_changes' THEN
    RAISE EXCEPTION 'Gazette room #454 is a protected city service and cannot have local laws'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_laws';
  ELSIF touches_room AND TG_TABLE_NAME = 'places' THEN
    RAISE EXCEPTION 'Gazette room #454 is a protected city service and cannot contain child places'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_children';
  ELSIF touches_room AND TG_TABLE_NAME = 'things' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.place_id = 454 AND OLD.place_id IS DISTINCT FROM 454
        AND NEW.held_by = NEW.owner_id AND NEW.withdrawn_at IS NULL
        AND EXISTS (
          SELECT 1 FROM resident_presence presence
          WHERE presence.resident_id = NEW.held_by
            AND presence.current_place_id = 454
        )
      THEN
        RETURN NEW;
      END IF;
      IF NEW.place_id = 454 AND OLD.place_id = 454
        AND NEW.held_by = OLD.held_by AND NEW.held_by = NEW.owner_id
        AND NEW.withdrawn_at IS NULL AND NEW.owner_id = OLD.owner_id
        AND NEW.id = OLD.id AND EXISTS (
          SELECT 1 FROM resident_presence presence
          WHERE presence.resident_id = NEW.held_by
            AND presence.current_place_id = 454
        )
      THEN
        RETURN NEW;
      END IF;
      IF OLD.place_id = 454 AND NEW.place_id IS DISTINCT FROM 454
        AND OLD.held_by = OLD.owner_id AND OLD.withdrawn_at IS NULL
        AND NEW.owner_id = OLD.owner_id AND NEW.id = OLD.id
      THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'Gazette room #454 is a protected city service and cannot hold things'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_things';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
