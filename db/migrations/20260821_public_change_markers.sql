BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';

-- SERIAL event ids are allocated before commit, so their numeric order cannot
-- truthfully act as a public "nothing changed" checkpoint. This singleton row
-- serializes the short marker assignment at the end of every event insert.
CREATE TABLE IF NOT EXISTS public_change_state (
  singleton          BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  current_change_id  BIGINT NOT NULL DEFAULT 0 CHECK (current_change_id >= 0)
);
INSERT INTO public_change_state (singleton, current_change_id)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public_change_log (
  change_id  BIGINT PRIMARY KEY CHECK (change_id > 0),
  event_id   INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION record_public_change() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  next_change_id BIGINT;
BEGIN
  UPDATE public_change_state
  SET current_change_id = current_change_id + 1
  WHERE singleton = true
  RETURNING current_change_id INTO next_change_id;
  IF next_change_id IS NULL THEN
    RAISE EXCEPTION 'public change state is unavailable' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public_change_log (change_id, event_id) VALUES (next_change_id, NEW.id);
  RETURN NEW;
END
$function$;

-- Keep reads available while excluding event writers during the one-time
-- committed-history backfill and trigger installation.
LOCK TABLE events IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER IF EXISTS events_record_public_change ON events;
DO $block$
DECLARE
  historical_event RECORD;
  next_change_id BIGINT;
BEGIN
  FOR historical_event IN
    SELECT event.id
    FROM events event
    LEFT JOIN public_change_log change ON change.event_id = event.id
    WHERE change.event_id IS NULL
    ORDER BY event.at ASC, event.id ASC
  LOOP
    UPDATE public_change_state
    SET current_change_id = current_change_id + 1
    WHERE singleton = true
    RETURNING current_change_id INTO next_change_id;
    INSERT INTO public_change_log (change_id, event_id)
    VALUES (next_change_id, historical_event.id);
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public_change_log change
    CROSS JOIN public_change_state state
    WHERE state.singleton = true
      AND change.change_id > state.current_change_id
  ) THEN
    RAISE EXCEPTION 'public change state trails its immutable log' USING ERRCODE = '55000';
  END IF;
END
$block$;
CREATE TRIGGER events_record_public_change
AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION record_public_change();

CREATE OR REPLACE FUNCTION deny_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$$;
DROP TRIGGER IF EXISTS public_change_log_append_only ON public_change_log;
CREATE TRIGGER public_change_log_append_only BEFORE UPDATE OR DELETE ON public_change_log
FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

COMMIT;
