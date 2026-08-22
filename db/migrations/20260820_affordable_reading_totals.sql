BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';

-- Persist exact room-reading totals so reads remain bounded as rooms grow.
CREATE TABLE IF NOT EXISTS place_reading_totals (
  place_id             INTEGER PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  subplace_items       INTEGER NOT NULL DEFAULT 0 CHECK (subplace_items >= 0),
  subplace_text_bytes  BIGINT NOT NULL DEFAULT 0 CHECK (subplace_text_bytes >= 0),
  thing_items          INTEGER NOT NULL DEFAULT 0 CHECK (thing_items >= 0),
  thing_text_bytes     BIGINT NOT NULL DEFAULT 0 CHECK (thing_text_bytes >= 0),
  note_items           INTEGER NOT NULL DEFAULT 0 CHECK (note_items >= 0),
  note_text_bytes      BIGINT NOT NULL DEFAULT 0 CHECK (note_text_bytes >= 0)
);

-- A failed short lock is safer than installing counters with a write missed
-- between backfill and trigger creation. Reads remain available during this lock.
LOCK TABLE places, things, notes IN SHARE ROW EXCLUSIVE MODE;

WITH subplaces AS (
  SELECT parent_id AS place_id,
    count(*)::integer AS items,
    coalesce(sum(octet_length(description)), 0)::bigint AS text_bytes
  FROM places
  WHERE parent_id IS NOT NULL
  GROUP BY parent_id
), active_things AS (
  SELECT place_id,
    count(*)::integer AS items,
    coalesce(sum(octet_length(body)), 0)::bigint AS text_bytes
  FROM things
  WHERE withdrawn_at IS NULL
  GROUP BY place_id
), room_notes AS (
  SELECT place_id,
    count(*)::integer AS items,
    coalesce(sum(octet_length(body)), 0)::bigint AS text_bytes
  FROM notes
  GROUP BY place_id
)
INSERT INTO place_reading_totals (
  place_id,
  subplace_items,
  subplace_text_bytes,
  thing_items,
  thing_text_bytes,
  note_items,
  note_text_bytes
)
SELECT p.id,
  coalesce(subplaces.items, 0),
  coalesce(subplaces.text_bytes, 0),
  coalesce(active_things.items, 0),
  coalesce(active_things.text_bytes, 0),
  coalesce(room_notes.items, 0),
  coalesce(room_notes.text_bytes, 0)
FROM places p
LEFT JOIN subplaces ON subplaces.place_id = p.id
LEFT JOIN active_things ON active_things.place_id = p.id
LEFT JOIN room_notes ON room_notes.place_id = p.id
ON CONFLICT (place_id) DO UPDATE SET
  subplace_items = EXCLUDED.subplace_items,
  subplace_text_bytes = EXCLUDED.subplace_text_bytes,
  thing_items = EXCLUDED.thing_items,
  thing_text_bytes = EXCLUDED.thing_text_bytes,
  note_items = EXCLUDED.note_items,
  note_text_bytes = EXCLUDED.note_text_bytes;

CREATE OR REPLACE FUNCTION maintain_place_reading_totals_from_place()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO place_reading_totals (place_id) VALUES (NEW.id)
    ON CONFLICT (place_id) DO NOTHING;
    IF NEW.parent_id IS NOT NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items + 1,
        subplace_text_bytes = subplace_text_bytes + octet_length(NEW.description)
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
        subplace_text_bytes = subplace_text_bytes - octet_length(OLD.description)
      WHERE place_id = OLD.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', OLD.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.description IS DISTINCT FROM OLD.description THEN
    IF OLD.parent_id IS NOT NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items - 1,
        subplace_text_bytes = subplace_text_bytes - octet_length(OLD.description)
      WHERE place_id = OLD.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', OLD.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF NEW.parent_id IS NOT NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items + 1,
        subplace_text_bytes = subplace_text_bytes + octet_length(NEW.description)
      WHERE place_id = NEW.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', NEW.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS places_update_reading_totals ON places;
CREATE TRIGGER places_update_reading_totals
AFTER INSERT OR DELETE OR UPDATE OF parent_id, description ON places
FOR EACH ROW EXECUTE FUNCTION maintain_place_reading_totals_from_place();

CREATE OR REPLACE FUNCTION maintain_place_reading_totals_from_thing()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_place_ids INTEGER[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    affected_place_ids := CASE WHEN NEW.withdrawn_at IS NULL
      THEN ARRAY[NEW.place_id] ELSE ARRAY[]::INTEGER[] END;
  ELSIF TG_OP = 'DELETE' THEN
    affected_place_ids := CASE WHEN OLD.withdrawn_at IS NULL
      THEN ARRAY[OLD.place_id] ELSE ARRAY[]::INTEGER[] END;
  ELSE
    affected_place_ids := array_remove(ARRAY[
      CASE WHEN OLD.withdrawn_at IS NULL THEN OLD.place_id END,
      CASE WHEN NEW.withdrawn_at IS NULL THEN NEW.place_id END
    ], NULL);
  END IF;

  -- A move touches two counter rows. Lock both in one global order before
  -- applying either delta so simultaneous A→B and B→A moves cannot deadlock.
  PERFORM totals.place_id
  FROM place_reading_totals totals
  WHERE totals.place_id = ANY(affected_place_ids)
  ORDER BY totals.place_id
  FOR NO KEY UPDATE;

  IF TG_OP <> 'INSERT' AND OLD.withdrawn_at IS NULL THEN
    UPDATE place_reading_totals SET
      thing_items = thing_items - 1,
      thing_text_bytes = thing_text_bytes - octet_length(OLD.body)
    WHERE place_id = OLD.place_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reading totals missing for place %', OLD.place_id
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' AND NEW.withdrawn_at IS NULL THEN
    UPDATE place_reading_totals SET
      thing_items = thing_items + 1,
      thing_text_bytes = thing_text_bytes + octet_length(NEW.body)
    WHERE place_id = NEW.place_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reading totals missing for place %', NEW.place_id
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS things_update_reading_totals ON things;
CREATE TRIGGER things_update_reading_totals
AFTER INSERT OR DELETE OR UPDATE OF place_id, body, withdrawn_at ON things
FOR EACH ROW EXECUTE FUNCTION maintain_place_reading_totals_from_thing();

CREATE OR REPLACE FUNCTION maintain_place_reading_totals_from_note()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE place_reading_totals SET
    note_items = note_items + 1,
    note_text_bytes = note_text_bytes + octet_length(NEW.body)
  WHERE place_id = NEW.place_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reading totals missing for place %', NEW.place_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS notes_update_reading_totals ON notes;
CREATE TRIGGER notes_update_reading_totals
AFTER INSERT ON notes
FOR EACH ROW EXECUTE FUNCTION maintain_place_reading_totals_from_note();

COMMIT;
