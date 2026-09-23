-- Things gain wake on arrival, chance, and write (decisions #104 to #110).
-- Every statement is additive and safe to repeat. No row is backfilled: every
-- existing thing starts asleep with an empty state box, and every place starts
-- with the default wake dials and is not marked rough.

-- Things: the owner's wake switch and the state box.
ALTER TABLE things ADD COLUMN IF NOT EXISTS wake_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE things ADD COLUMN IF NOT EXISTS state JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 8192);
ALTER TABLE things ADD COLUMN IF NOT EXISTS state_version INTEGER NOT NULL DEFAULT 0
  CHECK (state_version >= 0);

-- A thing changing hands sleeps until its new owner wakes it.
CREATE OR REPLACE FUNCTION sleep_thing_on_owner_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    NEW.wake_enabled := FALSE;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS things_sleep_on_owner_change ON things;
CREATE TRIGGER things_sleep_on_owner_change BEFORE UPDATE OF owner_id ON things
  FOR EACH ROW EXECUTE FUNCTION sleep_thing_on_owner_change();

-- Wake anchors live beside the thing, not on it, so a settle never waits on action row locks.
CREATE TABLE IF NOT EXISTS thing_wake_state (
  thing_id     INTEGER PRIMARY KEY REFERENCES things(id) ON DELETE RESTRICT,
  last_try_at  TIMESTAMPTZ,
  clock_at     TIMESTAMPTZ
);

-- Places: the owner's wake dials and the rough-room mark.
ALTER TABLE places ADD COLUMN IF NOT EXISTS wake_visitors BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE places ADD COLUMN IF NOT EXISTS wake_pins INTEGER[] NOT NULL DEFAULT '{}'::INTEGER[]
  CHECK (cardinality(wake_pins) <= 4);
ALTER TABLE places ADD COLUMN IF NOT EXISTS wake_block_thing_ids INTEGER[] NOT NULL DEFAULT '{}'::INTEGER[]
  CHECK (cardinality(wake_block_thing_ids) <= 64);
ALTER TABLE places ADD COLUMN IF NOT EXISTS wake_block_resident_ids INTEGER[] NOT NULL DEFAULT '{}'::INTEGER[]
  CHECK (cardinality(wake_block_resident_ids) <= 64);
ALTER TABLE places ADD COLUMN IF NOT EXISTS wake_random_cap SMALLINT NOT NULL DEFAULT 8
  CHECK (wake_random_cap BETWEEN 0 AND 32);
ALTER TABLE places ADD COLUMN IF NOT EXISTS rough_room BOOLEAN NOT NULL DEFAULT FALSE;

-- A rough room may hold only a visitor who came in after it was marked rough:
-- rough_since is when the owner last switched rough_room on (null while off), and
-- arrived_at is when a resident last came into their current place.
ALTER TABLE places ADD COLUMN IF NOT EXISTS rough_since TIMESTAMPTZ;
ALTER TABLE resident_presence ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE OR REPLACE FUNCTION mark_rough_since() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.rough_room THEN
    NEW.rough_since := NULL;
  ELSIF TG_OP = 'INSERT' OR NOT OLD.rough_room THEN
    NEW.rough_since := clock_timestamp();
  ELSE
    NEW.rough_since := OLD.rough_since;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS places_mark_rough_since ON places;
CREATE TRIGGER places_mark_rough_since BEFORE INSERT OR UPDATE OF rough_room, rough_since ON places
  FOR EACH ROW EXECUTE FUNCTION mark_rough_since();
CREATE OR REPLACE FUNCTION mark_resident_arrival() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_place_id IS DISTINCT FROM OLD.current_place_id THEN
    NEW.arrived_at := now();
  ELSE
    NEW.arrived_at := OLD.arrived_at;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS resident_presence_mark_arrival ON resident_presence;
CREATE TRIGGER resident_presence_mark_arrival BEFORE UPDATE OF current_place_id, arrived_at ON resident_presence
  FOR EACH ROW EXECUTE FUNCTION mark_resident_arrival();

-- Settles first, because tries, rolls, and state changes cite them.
CREATE TABLE IF NOT EXISTS wake_settles (
  id           BIGSERIAL PRIMARY KEY,
  place_id     INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  trigger      TEXT NOT NULL CHECK (trigger IN ('arrive', 'talk', 'act', 'me')),
  resident_id  INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  budget       SMALLINT NOT NULL CHECK (budget BETWEEN 0 AND 32),
  units        JSONB NOT NULL CHECK (jsonb_typeof(units) = 'array'),
  picked       JSONB NOT NULL CHECK (jsonb_typeof(picked) = 'array'),
  forfeited    INTEGER NOT NULL DEFAULT 0 CHECK (forfeited >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wake_settles_place ON wake_settles (place_id, id DESC);

CREATE TABLE IF NOT EXISTS wake_tries (
  id               BIGSERIAL PRIMARY KEY,
  settle_id        BIGINT NOT NULL REFERENCES wake_settles(id) ON DELETE RESTRICT,
  thing_id         INTEGER NOT NULL REFERENCES things(id) ON DELETE RESTRICT,
  reason           TEXT NOT NULL CHECK (reason IN ('arrive', 'talk', 'clock')),
  unit_index       SMALLINT NOT NULL CHECK (unit_index >= 0),
  status           TEXT NOT NULL CHECK (status IN ('woke', 'quiet', 'failed', 'stopped')),
  effects_applied  INTEGER NOT NULL DEFAULT 0 CHECK (effects_applied >= 0),
  skipped_effects  JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skipped_effects) = 'array'),
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (settle_id, thing_id, unit_index)
);
CREATE INDEX IF NOT EXISTS wake_tries_thing ON wake_tries (thing_id, id DESC);

-- The public roll. The secret is private until its UTC day ends; rows are made a day ahead.
CREATE TABLE IF NOT EXISTS chance_days (
  day         DATE PRIMARY KEY,
  secret      BYTEA NOT NULL CHECK (octet_length(secret) = 32),
  commitment  TEXT NOT NULL CHECK (commitment ~ '^[0-9a-f]{64}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS chance_rolls_id_seq;
CREATE TABLE IF NOT EXISTS chance_rolls (
  id               BIGINT PRIMARY KEY,
  day              DATE NOT NULL REFERENCES chance_days(day) ON DELETE RESTRICT,
  purpose          TEXT NOT NULL CHECK (purpose IN ('chance', 'wake_pick')),
  outcome          TEXT NOT NULL DEFAULT 'counted'
                     CHECK (outcome IN ('counted', 'action_failed')),
  place_id         INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  source_thing_id  INTEGER REFERENCES things(id) ON DELETE RESTRICT,
  source_trait_id  INTEGER REFERENCES traits(id) ON DELETE RESTRICT,
  authority_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  action_id        BIGINT REFERENCES action_runs(id) ON DELETE RESTRICT,
  settle_id        BIGINT REFERENCES wake_settles(id) ON DELETE RESTRICT,
  percent          SMALLINT CHECK (percent IS NULL OR percent BETWEEN 1 AND 99),
  sides            INTEGER CHECK (sides IS NULL OR sides >= 1),
  roll             INTEGER CHECK (roll IS NULL OR roll >= 1),
  branch           TEXT CHECK (branch IS NULL OR branch IN ('then', 'else')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (purpose <> 'chance' OR (percent IS NOT NULL AND sides = 100 AND roll BETWEEN 1 AND 100 AND branch IS NOT NULL)),
  CHECK (purpose <> 'wake_pick' OR (settle_id IS NOT NULL AND sides IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS chance_rolls_thing ON chance_rolls (source_thing_id, id DESC)
  WHERE source_thing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chance_rolls_settle ON chance_rolls (settle_id)
  WHERE settle_id IS NOT NULL;

-- The state box history.
CREATE TABLE IF NOT EXISTS thing_state_changes (
  id               BIGSERIAL PRIMARY KEY,
  thing_id         INTEGER NOT NULL REFERENCES things(id) ON DELETE RESTRICT,
  version          INTEGER NOT NULL CHECK (version > 0),
  key              TEXT CHECK (key IS NULL OR key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  op               TEXT NOT NULL CHECK (op IN ('set', 'add', 'append', 'clear')),
  value            JSONB,
  trimmed          SMALLINT NOT NULL DEFAULT 0 CHECK (trimmed BETWEEN 0 AND 20),
  source_trait_id  INTEGER REFERENCES traits(id) ON DELETE RESTRICT,
  trigger          TEXT NOT NULL CHECK (trigger IN ('use', 'consume', 'give', 'timer',
                     'wake_arrive', 'wake_talk', 'wake_clock', 'owner')),
  resident_id      INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  authority_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  action_id        BIGINT REFERENCES action_runs(id) ON DELETE RESTRICT,
  settle_id        BIGINT REFERENCES wake_settles(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thing_id, version)
);

-- History tables are append-only, like the rest of the public record.
DROP TRIGGER IF EXISTS wake_settles_append_only ON wake_settles;
CREATE TRIGGER wake_settles_append_only BEFORE UPDATE OR DELETE ON wake_settles
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS wake_tries_append_only ON wake_tries;
CREATE TRIGGER wake_tries_append_only BEFORE UPDATE OR DELETE ON wake_tries
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS chance_days_append_only ON chance_days;
CREATE TRIGGER chance_days_append_only BEFORE UPDATE OR DELETE ON chance_days
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS chance_rolls_append_only ON chance_rolls;
CREATE TRIGGER chance_rolls_append_only BEFORE UPDATE OR DELETE ON chance_rolls
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS thing_state_changes_append_only ON thing_state_changes;
CREATE TRIGGER thing_state_changes_append_only BEFORE UPDATE OR DELETE ON thing_state_changes
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
