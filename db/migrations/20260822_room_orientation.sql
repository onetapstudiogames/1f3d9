BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE places ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT '';
ALTER TABLE places
  ADD COLUMN IF NOT EXISTS front_matter_thing_ids INTEGER[] NOT NULL DEFAULT '{}'::INTEGER[];

DO $room_orientation_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_purpose_safe_line'
  ) THEN
    ALTER TABLE places ADD CONSTRAINT places_purpose_safe_line
      CHECK (char_length(purpose) <= 280
        AND purpose = btrim(purpose)
        AND purpose !~ E'(^\\s|\\s$)'
        AND purpose !~ E'[\\r\\n]'
        AND position(chr(8232) in purpose) = 0
        AND position(chr(8233) in purpose) = 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_front_matter_bounded'
  ) THEN
    ALTER TABLE places ADD CONSTRAINT places_front_matter_bounded
      CHECK (cardinality(front_matter_thing_ids) BETWEEN 0 AND 3) NOT VALID;
  END IF;
END
$room_orientation_constraints$;
ALTER TABLE places VALIDATE CONSTRAINT places_purpose_safe_line;
ALTER TABLE places VALIDATE CONSTRAINT places_front_matter_bounded;

CREATE OR REPLACE FUNCTION validate_place_front_matter() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_front_matter INTEGER[] := '{}'::INTEGER[];
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.front_matter_thing_ids IS NOT DISTINCT FROM OLD.front_matter_thing_ids THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    previous_front_matter := OLD.front_matter_thing_ids;
  END IF;
  IF coalesce(array_ndims(NEW.front_matter_thing_ids), 1) <> 1
    OR array_position(NEW.front_matter_thing_ids, NULL) IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM unnest(NEW.front_matter_thing_ids) selected(thing_id)
      WHERE selected.thing_id <= 0
    )
    OR cardinality(NEW.front_matter_thing_ids) <> (
      SELECT count(DISTINCT selected.thing_id)
      FROM unnest(NEW.front_matter_thing_ids) selected(thing_id)
    ) THEN
    RAISE EXCEPTION 'front matter must contain distinct positive thing ids'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.front_matter_thing_ids) selected(thing_id)
    LEFT JOIN things thing ON thing.id = selected.thing_id
    WHERE thing.id IS NULL
  ) THEN
    RAISE EXCEPTION 'front matter names a missing thing' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.front_matter_thing_ids) selected(thing_id)
    JOIN things thing ON thing.id = selected.thing_id
    LEFT JOIN LATERAL (
      SELECT moderation.action
      FROM moderation_actions moderation
      WHERE moderation.target_type = 'thing'
        AND moderation.target_id = thing.id
      ORDER BY moderation.created_at DESC, moderation.id DESC
      LIMIT 1
    ) latest_moderation ON TRUE
    WHERE (pg_trigger_depth() <= 1
        OR NOT (selected.thing_id = ANY(previous_front_matter)))
      AND (thing.place_id IS DISTINCT FROM NEW.id
        OR thing.withdrawn_at IS NOT NULL
        OR coalesce(latest_moderation.action, 'restore') = 'remove')
  ) THEN
    RAISE EXCEPTION 'front matter must use active public things in this place'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS places_validate_front_matter ON places;
CREATE TRIGGER places_validate_front_matter
  BEFORE INSERT OR UPDATE OF front_matter_thing_ids ON places
  FOR EACH ROW EXECUTE FUNCTION validate_place_front_matter();

CREATE OR REPLACE FUNCTION remove_unavailable_place_front_matter() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.place_id IS DISTINCT FROM OLD.place_id
    OR (OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL) THEN
    UPDATE places
    SET front_matter_thing_ids = array_remove(front_matter_thing_ids, OLD.id)
    WHERE id = OLD.place_id AND OLD.id = ANY(front_matter_thing_ids);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS things_remove_unavailable_place_front_matter ON things;
CREATE TRIGGER things_remove_unavailable_place_front_matter
  AFTER DELETE OR UPDATE OF place_id, withdrawn_at ON things
  FOR EACH ROW EXECUTE FUNCTION remove_unavailable_place_front_matter();

UPDATE place_reading_totals totals
SET subplace_text_bytes = coalesce((
  SELECT sum(octet_length(description) + octet_length(purpose))::bigint
  FROM places child
  WHERE child.parent_id = totals.place_id
), 0);

CREATE OR REPLACE FUNCTION maintain_place_reading_totals_from_place()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO place_reading_totals (place_id) VALUES (NEW.id)
    ON CONFLICT (place_id) DO NOTHING;
    IF NEW.parent_id IS NOT NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items + 1,
        subplace_text_bytes = subplace_text_bytes
          + octet_length(NEW.description) + octet_length(NEW.purpose)
      WHERE place_id = NEW.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', NEW.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.parent_id IS NOT NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items - 1,
        subplace_text_bytes = subplace_text_bytes
          - (octet_length(OLD.description) + octet_length(OLD.purpose))
      WHERE place_id = OLD.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', OLD.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    IF OLD.parent_id IS NOT NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items - 1,
        subplace_text_bytes = subplace_text_bytes
          - (octet_length(OLD.description) + octet_length(OLD.purpose))
      WHERE place_id = OLD.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', OLD.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF NEW.parent_id IS NOT NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items + 1,
        subplace_text_bytes = subplace_text_bytes
          + octet_length(NEW.description) + octet_length(NEW.purpose)
      WHERE place_id = NEW.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', NEW.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS places_update_reading_totals ON places;
CREATE TRIGGER places_update_reading_totals
AFTER INSERT OR DELETE OR UPDATE OF parent_id, description, purpose ON places
FOR EACH ROW EXECUTE FUNCTION maintain_place_reading_totals_from_place();

COMMIT;
