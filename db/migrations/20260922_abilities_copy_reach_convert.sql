-- Things gain copy, reach, and convert (decisions #111 to #115).
-- Every statement is additive and safe to repeat. No row is backfilled: every
-- existing thing is generation 0 and its own family, has made no copies, and is
-- closed to a harder reach and to conversion; every place keeps the default
-- growth dials and takes no arriving copies.

-- Things: lineage, the two consent switches, and the conversion overlay.
ALTER TABLE things ADD COLUMN IF NOT EXISTS generation SMALLINT NOT NULL DEFAULT 0
  CHECK (generation BETWEEN 0 AND 8);
ALTER TABLE things ADD COLUMN IF NOT EXISTS parent_thing_id INTEGER
  REFERENCES things(id) ON DELETE RESTRICT;
ALTER TABLE things ADD COLUMN IF NOT EXISTS family_id INTEGER
  REFERENCES things(id) ON DELETE RESTRICT;
ALTER TABLE things ADD COLUMN IF NOT EXISTS copies_made INTEGER NOT NULL DEFAULT 0
  CHECK (copies_made >= 0);
ALTER TABLE things ADD COLUMN IF NOT EXISTS open_to_reach BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE things ADD COLUMN IF NOT EXISTS open_to_convert BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE things ADD COLUMN IF NOT EXISTS as_kind_id INTEGER
  REFERENCES kinds(id) ON DELETE RESTRICT;
ALTER TABLE things ADD COLUMN IF NOT EXISTS as_revision INTEGER;

-- A conversion never touches the birth columns: it writes this overlay, which
-- always names a real kind revision and keeps the new kind's base drawing.
DO $abilities_thing_overlay$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
    AND conname = 'things_as_kind_revision_fkey') THEN
    ALTER TABLE things ADD CONSTRAINT things_as_kind_revision_fkey
      FOREIGN KEY (as_kind_id, as_revision)
      REFERENCES kind_revisions(kind_id, revision) MATCH FULL ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
    AND conname = 'things_as_kind_contract') THEN
    ALTER TABLE things ADD CONSTRAINT things_as_kind_contract CHECK (
      (as_kind_id IS NULL AND as_revision IS NULL)
      OR (as_kind_id IS NOT NULL AND as_revision > 0 AND kind_id IS NOT NULL
          AND drawing_variant_name IS NULL)
    );
  END IF;
END
$abilities_thing_overlay$;
CREATE INDEX IF NOT EXISTS things_parent ON things (parent_thing_id)
  WHERE parent_thing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS things_family ON things (family_id)
  WHERE family_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS things_as_kind ON things (as_kind_id, as_revision)
  WHERE as_kind_id IS NOT NULL AND withdrawn_at IS NULL;

-- A thing changing hands arrives closed to a harder reach and to conversion, as
-- it arrives asleep: only its new owner may open either switch again.
CREATE OR REPLACE FUNCTION close_thing_consent_on_owner_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    NEW.open_to_reach := FALSE;
    NEW.open_to_convert := FALSE;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS things_close_consent_on_owner_change ON things;
CREATE TRIGGER things_close_consent_on_owner_change BEFORE UPDATE OF owner_id ON things
  FOR EACH ROW EXECUTE FUNCTION close_thing_consent_on_owner_change();

-- Places: the owner's growth dials.
ALTER TABLE places ADD COLUMN IF NOT EXISTS growth_cap_per_day SMALLINT NOT NULL DEFAULT 10
  CHECK (growth_cap_per_day BETWEEN 0 AND 100);
ALTER TABLE places ADD COLUMN IF NOT EXISTS growth_share_per_family SMALLINT NOT NULL DEFAULT 5
  CHECK (growth_share_per_family BETWEEN 1 AND 100);
ALTER TABLE places ADD COLUMN IF NOT EXISTS allow_arriving_copies BOOLEAN NOT NULL DEFAULT FALSE;

-- The memory of what a converted thing was. Birth history stays on things.
CREATE TABLE IF NOT EXISTS thing_conversions (
  id                  BIGSERIAL PRIMARY KEY,
  thing_id            INTEGER NOT NULL REFERENCES things(id) ON DELETE RESTRICT,
  from_kind_id        INTEGER NOT NULL REFERENCES kinds(id) ON DELETE RESTRICT,
  from_revision       INTEGER NOT NULL CHECK (from_revision > 0),
  from_variant_name   TEXT,
  from_family_id      INTEGER REFERENCES things(id) ON DELETE RESTRICT,
  from_generation     SMALLINT NOT NULL CHECK (from_generation BETWEEN 0 AND 8),
  from_wake_enabled   BOOLEAN NOT NULL,
  to_kind_id          INTEGER NOT NULL REFERENCES kinds(id) ON DELETE RESTRICT,
  to_revision         INTEGER NOT NULL CHECK (to_revision > 0),
  to_generation       SMALLINT NOT NULL CHECK (to_generation BETWEEN 1 AND 8),
  by_thing_id         INTEGER REFERENCES things(id) ON DELETE RESTRICT,
  by_law_trait_id     INTEGER REFERENCES traits(id) ON DELETE RESTRICT,
  by_place_id         INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  authority_id        INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  resident_id         INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  action_id           BIGINT REFERENCES action_runs(id) ON DELETE RESTRICT,
  settle_id           BIGINT REFERENCES wake_settles(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((by_thing_id IS NOT NULL AND by_law_trait_id IS NULL AND by_place_id IS NULL)
      OR (by_thing_id IS NULL AND by_law_trait_id IS NOT NULL AND by_place_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS thing_conversions_thing ON thing_conversions (thing_id, id DESC);

-- Growth counting and marks: mutable operational rows, never public history.
CREATE TABLE IF NOT EXISTS place_copy_counts (
  place_id   INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  utc_day    DATE NOT NULL,
  family_id  INTEGER NOT NULL REFERENCES things(id) ON DELETE RESTRICT,
  copies     INTEGER NOT NULL CHECK (copies >= 0),
  PRIMARY KEY (place_id, utc_day, family_id)
);
CREATE TABLE IF NOT EXISTS family_growth_marks (
  id               BIGSERIAL PRIMARY KEY,
  family_id        INTEGER NOT NULL REFERENCES things(id) ON DELETE RESTRICT,
  place_id         INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  source_thing_id  INTEGER NOT NULL REFERENCES things(id) ON DELETE RESTRICT,
  cap              TEXT NOT NULL CHECK (cap IN ('place_daily', 'family_share',
                     'generations', 'copies', 'no_arrivals')),
  cap_limit        INTEGER NOT NULL CHECK (cap_limit >= 0),
  over_by          INTEGER NOT NULL CHECK (over_by >= 1),
  action_id        BIGINT REFERENCES action_runs(id) ON DELETE RESTRICT,
  settle_id        BIGINT REFERENCES wake_settles(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at       TIMESTAMPTZ,
  cleared_reason   TEXT CHECK (cleared_reason IS NULL OR cleared_reason IN
                     ('place_dials_changed', 'kind_revision_changed', 'copy_succeeded')),
  CHECK ((cleared_at IS NULL) = (cleared_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS family_growth_marks_one_open
  ON family_growth_marks (place_id, family_id) WHERE cleared_at IS NULL;

-- The conversion memory is append-only, like the rest of the public record.
DROP TRIGGER IF EXISTS thing_conversions_append_only ON thing_conversions;
CREATE TRIGGER thing_conversions_append_only BEFORE UPDATE OR DELETE ON thing_conversions
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

-- Widen the roll and state-box vocabularies for the new abilities: a roll may pick
-- an adjacent copy's place or be drawn by a reach member that refused, and a copy
-- may inherit its parent's state box. Each wider check is added before the narrower
-- one it replaces is dropped, so no row is ever unchecked.
DO $abilities_widen_vocabularies$
DECLARE
  narrower RECORD;
BEGIN
  FOR narrower IN
    SELECT constraint_row.conrelid::regclass::text AS table_name, constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.contype = 'c'
      AND (
        (constraint_row.conrelid = 'chance_rolls'::regclass
          AND (pg_get_constraintdef(constraint_row.oid) LIKE '%(purpose = ANY%'
            OR pg_get_constraintdef(constraint_row.oid) LIKE '%(outcome = ANY%'))
        OR (constraint_row.conrelid = 'thing_state_changes'::regclass
          AND (pg_get_constraintdef(constraint_row.oid) LIKE '%(op = ANY%'
            OR pg_get_constraintdef(constraint_row.oid) LIKE '%(trigger = ANY%'))
      )
      AND constraint_row.conname NOT IN (
        'chance_rolls_purpose_known', 'chance_rolls_outcome_known',
        'thing_state_changes_op_known', 'thing_state_changes_trigger_known'
      )
  LOOP
    IF narrower.table_name = 'chance_rolls' AND NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid = 'chance_rolls'::regclass
        AND conname = 'chance_rolls_purpose_known'
    ) THEN
      ALTER TABLE chance_rolls ADD CONSTRAINT chance_rolls_purpose_known
        CHECK (purpose IN ('chance', 'wake_pick', 'copy_place'));
      ALTER TABLE chance_rolls ADD CONSTRAINT chance_rolls_outcome_known
        CHECK (outcome IN ('counted', 'action_failed', 'member_refused'));
    END IF;
    IF narrower.table_name = 'thing_state_changes' AND NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid = 'thing_state_changes'::regclass
        AND conname = 'thing_state_changes_op_known'
    ) THEN
      ALTER TABLE thing_state_changes ADD CONSTRAINT thing_state_changes_op_known
        CHECK (op IN ('set', 'add', 'append', 'clear', 'inherit'));
      ALTER TABLE thing_state_changes ADD CONSTRAINT thing_state_changes_trigger_known
        CHECK (trigger IN ('use', 'consume', 'give', 'timer',
          'wake_arrive', 'wake_talk', 'wake_clock', 'copy', 'owner'));
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', narrower.table_name, narrower.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'chance_rolls'::regclass
    AND conname = 'chance_rolls_copy_place_contract') THEN
    ALTER TABLE chance_rolls ADD CONSTRAINT chance_rolls_copy_place_contract
      CHECK (purpose <> 'copy_place' OR (sides IS NOT NULL AND roll BETWEEN 1 AND sides));
  END IF;
END
$abilities_widen_vocabularies$;
