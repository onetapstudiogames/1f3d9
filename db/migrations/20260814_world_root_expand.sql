BEGIN;

-- Compatibility phase only. This deliberately does not create or reparent the
-- world root, so either the legacy or world-aware application can run afterward.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE places
  ADD COLUMN IF NOT EXISTS place_kind TEXT NOT NULL DEFAULT 'place';

ALTER TABLE places
  ALTER COLUMN place_kind SET DEFAULT 'place';

ALTER TABLE places
  ALTER COLUMN place_kind SET NOT NULL;

ALTER TABLE places
  ALTER COLUMN owner_id DROP NOT NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_place_kind_allowed'
  ) THEN
    ALTER TABLE places
      ADD CONSTRAINT places_place_kind_allowed
      CHECK (place_kind IN ('world', 'continent', 'place')) NOT VALID;
  END IF;
END
$migration$;

ALTER TABLE places VALIDATE CONSTRAINT places_place_kind_allowed;

COMMIT;
