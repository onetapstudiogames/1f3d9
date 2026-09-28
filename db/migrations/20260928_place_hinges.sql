-- Hinges (decision #132). Additive and safe to repeat; nothing is backfilled.
-- No foreign key: places are never deleted (#68), and a key check would lock the
-- named place and deadlock two openings sent at once.
ALTER TABLE places ADD COLUMN IF NOT EXISTS hinge_to INTEGER;
DO $place_hinges$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'places'::regclass
    AND conname = 'places_hinge_to_shape') THEN
    ALTER TABLE places ADD CONSTRAINT places_hinge_to_shape
      CHECK (hinge_to IS NULL OR (hinge_to <> id AND place_kind <> 'world'));
  END IF;
END
$place_hinges$;

-- A place given, sold, or retired closes its own side of any hinge; the other
-- side stays as a request the new owner, or the restored place, may accept.
CREATE OR REPLACE FUNCTION close_place_hinge_on_owner_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL) THEN
    NEW.hinge_to := NULL;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS places_close_hinge_on_owner_change ON places;
CREATE TRIGGER places_close_hinge_on_owner_change
  BEFORE UPDATE OF owner_id, retired_at ON places
  FOR EACH ROW EXECUTE FUNCTION close_place_hinge_on_owner_change();
