BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Thing endings: the stores and the guards. An owner may give a thing an end its kind
-- permits; the first condition met ends it, and it stays at its id as a remnant. This adds
-- the empty columns on things, the inventor on kinds, the permission on kind revisions, two
-- append-only tables, the due functions, two partial indexes, the end reason in the wake
-- vocabularies, the guards: things_aa_ending_owner_change, things_zz_ending_freeze and
-- four insert guards, which read the transaction-local writer setting city.ending_writer,
-- and public snapshot format 4, city_snapshot.public_records_v4, built on v3 for the export
-- role only; v1 to v3 and their base views are not replaced. Every new column is empty or
-- at its default, so no thing, revision, event or label row changes; only kinds gain an
-- inventor, and only from exactly one provable kind_invented event. The whole migration
-- holds the things lock until it commits; NOT VALID then VALIDATE does not shorten it in
-- one transaction. Creating the guards also locks active_labels, thing_later_holder_marks
-- and transfer_offers briefly while things is held. It is safe to run again, and running
-- it again fills the inventor of kinds invented since the last run.
DO $thing_endings_guard$
BEGIN
  IF to_regclass('public.things') IS NULL OR to_regclass('public.kinds') IS NULL
    OR to_regclass('public.kind_revisions') IS NULL OR to_regclass('public.residents') IS NULL
    OR to_regclass('public.events') IS NULL OR to_regclass('public.active_labels') IS NULL
    OR to_regclass('public.agreements') IS NULL OR to_regclass('public.wake_tries') IS NULL
    OR to_regclass('public.thing_state_changes') IS NULL
    OR to_regclass('public.transfer_offers') IS NULL
    OR to_regclass('public.thing_later_holder_marks') IS NULL THEN
    RAISE EXCEPTION 'thing endings migration needs the things, kinds, kind_revisions, residents, events, active_labels, agreements, wake_tries, thing_state_changes, transfer_offers and thing_later_holder_marks tables';
  END IF;
  IF to_regprocedure('public.deny_history_mutation()') IS NULL THEN
    RAISE EXCEPTION 'thing endings migration needs the deny_history_mutation function';
  END IF;
  IF to_regclass('city_snapshot.public_records_v3') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'city_snapshot_export') THEN
    RAISE EXCEPTION 'thing endings migration needs the city_snapshot.public_records_v3 view and the city_snapshot_export role';
  END IF;
  -- The owner-change guard must fire before the two triggers that turn a thing's switches
  -- off as it changes hands, and the freeze guard after them, so both must exist.
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'things'::regclass AND NOT tgisinternal
      AND tgname IN ('things_close_consent_on_owner_change', 'things_sleep_on_owner_change')) <> 2 THEN
    RAISE EXCEPTION 'thing endings migration needs the things_close_consent_on_owner_change and things_sleep_on_owner_change triggers';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'thing_state_changes'::regclass
      AND conname = 'thing_state_changes_trigger_known' AND contype = 'c') THEN
    RAISE EXCEPTION 'thing endings migration needs the named thing_state_changes_trigger_known check';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('public.thing_ending_changes')
      AND attnum > 0 AND NOT attisdropped
      AND attname NOT IN ('id', 'thing_id', 'change', 'actor_id', 'rule', 'grant', 'result',
        'action_id', 'settle_id', 'created_at')
  ) THEN
    RAISE EXCEPTION 'thing_ending_changes already exists with columns this migration does not know';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('public.agreement_thing_links')
      AND attnum > 0 AND NOT attisdropped
      AND attname NOT IN ('agreement_id', 'position', 'thing_id')
  ) THEN
    RAISE EXCEPTION 'agreement_thing_links already exists with columns this migration does not know';
  END IF;
END
$thing_endings_guard$;

-- A kind revision's ending permission: which of the five conditions an owner may set,
-- the label names a label_added end may watch (required exactly when label_added is
-- allowed), and optional limits that may only narrow the city limits.
CREATE OR REPLACE FUNCTION valid_ending_policy(policy jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $valid_ending_policy$
  SELECT CASE
    WHEN policy IS NULL OR jsonb_typeof(policy) <> 'object' THEN false
    WHEN EXISTS (
      SELECT 1 FROM jsonb_object_keys(policy) AS policy_key(name)
      WHERE policy_key.name NOT IN ('allowed', 'labels', 'max_seconds', 'max_uses')
    ) THEN false
    WHEN jsonb_typeof(policy -> 'allowed') IS DISTINCT FROM 'array' THEN false
    WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(policy -> 'allowed') AS allowed_mode(value)
      WHERE jsonb_typeof(allowed_mode.value) <> 'string'
        OR allowed_mode.value #>> '{}' NOT IN
          ('at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added')
    ) THEN false
    WHEN (SELECT count(DISTINCT allowed_mode.value) FROM jsonb_array_elements(policy -> 'allowed') AS allowed_mode(value))
      <> jsonb_array_length(policy -> 'allowed') THEN false
    WHEN ((policy -> 'allowed') ? 'label_added') <> (policy ? 'labels') THEN false
    WHEN policy ? 'labels' AND jsonb_typeof(policy -> 'labels') <> 'array' THEN false
    WHEN policy ? 'labels' AND jsonb_array_length(policy -> 'labels') NOT BETWEEN 1 AND 8 THEN false
    WHEN policy ? 'labels' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(policy -> 'labels') AS policy_label(value)
      WHERE jsonb_typeof(policy_label.value) <> 'string'
        OR policy_label.value #>> '{}' !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    ) THEN false
    WHEN policy ? 'labels'
      AND (SELECT count(DISTINCT policy_label.value) FROM jsonb_array_elements(policy -> 'labels') AS policy_label(value))
        <> jsonb_array_length(policy -> 'labels') THEN false
    WHEN policy ? 'max_seconds' AND NOT (
      jsonb_typeof(policy -> 'max_seconds') = 'number'
      AND policy ->> 'max_seconds' ~ '^[1-9][0-9]*$'
      AND policy -> 'max_seconds' >= '60'::jsonb
      AND policy -> 'max_seconds' <= '31622400'::jsonb
    ) THEN false
    WHEN policy ? 'max_uses' AND NOT (
      jsonb_typeof(policy -> 'max_uses') = 'number'
      AND policy ->> 'max_uses' ~ '^[1-9][0-9]*$'
      AND policy -> 'max_uses' >= '1'::jsonb
      AND policy -> 'max_uses' <= '10000'::jsonb
    ) THEN false
    ELSE true
  END
$valid_ending_policy$;

-- The permission is part of the revision, so the existing revision immutability covers it.
-- A constant default adds the column without rewriting or updating any revision row.
ALTER TABLE kind_revisions ADD COLUMN IF NOT EXISTS ending_policy JSONB NOT NULL
  DEFAULT '{"allowed": []}'::jsonb;
DO $thing_endings_policy_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kind_revisions'::regclass
      AND conname = 'kind_revisions_ending_policy_valid') THEN
    ALTER TABLE kind_revisions ADD CONSTRAINT kind_revisions_ending_policy_valid
      CHECK (valid_ending_policy(ending_policy)) NOT VALID;
  END IF;
END
$thing_endings_policy_check$;
ALTER TABLE kind_revisions VALIDATE CONSTRAINT kind_revisions_ending_policy_valid;

-- A kind's inventor, proven only by exactly one kind_invented event naming that kind,
-- whose actor handle belonged to a resident who had joined by the event's time (the
-- decision #38 join). No guessing from present ownership: anything else stays empty.
ALTER TABLE kinds ADD COLUMN IF NOT EXISTS invented_by INTEGER;
DO $thing_endings_inventor_key$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kinds'::regclass
      AND conname = 'kinds_invented_by_fkey') THEN
    ALTER TABLE kinds ADD CONSTRAINT kinds_invented_by_fkey
      FOREIGN KEY (invented_by) REFERENCES residents(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END
$thing_endings_inventor_key$;
ALTER TABLE kinds VALIDATE CONSTRAINT kinds_invented_by_fkey;

CREATE OR REPLACE FUNCTION kind_provable_inventor(target_kind_id integer) RETURNS integer
LANGUAGE sql STABLE AS $kind_provable_inventor$
  SELECT CASE WHEN count(invention.id) = 1 THEN min(inventor.id) END
  FROM events AS invention
  LEFT JOIN residents AS inventor
    ON inventor.handle = invention.actor
    AND inventor.joined_at <= invention.at
  WHERE invention.kind = 'kind_invented'
    AND CASE
      WHEN jsonb_typeof(invention.detail -> 'kind_id') = 'number'
        AND invention.detail ->> 'kind_id' ~ '^[1-9][0-9]*$'
      THEN (invention.detail ->> 'kind_id')::numeric = $1
      ELSE false
    END
$kind_provable_inventor$;

-- Once set, a kind's inventor never changes. An empty inventor may be filled only with
-- the one provable actor, which lets the backfill run again after the deploy.
CREATE OR REPLACE FUNCTION kinds_invented_by_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.invented_by IS NOT DISTINCT FROM NEW.invented_by THEN
    RETURN NEW;
  END IF;
  IF OLD.invented_by IS NULL AND NEW.invented_by = kind_provable_inventor(NEW.id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a kind''s inventor is fixed once proven and may be filled only from its one kind_invented event'
    USING ERRCODE = '23514', CONSTRAINT = 'kinds_invented_by_fixed';
END
$$;
DROP TRIGGER IF EXISTS kinds_invented_by_fixed ON kinds;
CREATE TRIGGER kinds_invented_by_fixed BEFORE UPDATE OF invented_by ON kinds
  FOR EACH ROW EXECUTE FUNCTION kinds_invented_by_guard();

UPDATE kinds AS kind SET invented_by = proof.inventor_id
FROM (
  SELECT candidate.id, kind_provable_inventor(candidate.id) AS inventor_id
  FROM kinds AS candidate
  WHERE candidate.invented_by IS NULL
) AS proof
WHERE kind.id = proof.id AND proof.inventor_id IS NOT NULL;

-- The owner's end on a thing, its grant, the end once recorded, and the end program's state.
ALTER TABLE things
  ADD COLUMN IF NOT EXISTS ending_rule JSONB,
  ADD COLUMN IF NOT EXISTS ending_grant JSONB,
  ADD COLUMN IF NOT EXISTS ending_set_by INTEGER,
  ADD COLUMN IF NOT EXISTS ending_set_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ending_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ending_idle_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS ending_idle_anchor TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ending_uses_left INTEGER,
  ADD COLUMN IF NOT EXISTS ending_uses_spent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ending_label TEXT,
  ADD COLUMN IF NOT EXISTS ending_copied_from INTEGER,
  ADD COLUMN IF NOT EXISTS ending_copied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_cause TEXT,
  ADD COLUMN IF NOT EXISTS ended_owner_id INTEGER,
  ADD COLUMN IF NOT EXISTS end_program_state TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS end_program_result JSONB;

DO $thing_endings_thing_checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
      AND conname = 'things_ending_set_by_fkey') THEN
    ALTER TABLE things ADD CONSTRAINT things_ending_set_by_fkey
      FOREIGN KEY (ending_set_by) REFERENCES residents(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
      AND conname = 'things_ended_owner_id_fkey') THEN
    ALTER TABLE things ADD CONSTRAINT things_ended_owner_id_fkey
      FOREIGN KEY (ended_owner_id) REFERENCES residents(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
      AND conname = 'things_ending_copied_from_fkey') THEN
    ALTER TABLE things ADD CONSTRAINT things_ending_copied_from_fkey
      FOREIGN KEY (ending_copied_from) REFERENCES things(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  -- A rule always travels with its grant, its setter and its time. The copy origin is
  -- not part of it: a copy keeps its origin after its end is cleared.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
      AND conname = 'things_ending_rule_shape') THEN
    ALTER TABLE things ADD CONSTRAINT things_ending_rule_shape CHECK (
      (
        (ending_rule IS NULL AND ending_grant IS NULL AND ending_set_by IS NULL AND ending_set_at IS NULL)
        OR (
          ending_rule IS NOT NULL AND ending_grant IS NOT NULL
          AND ending_set_by IS NOT NULL AND ending_set_at IS NOT NULL
          AND jsonb_typeof(ending_grant) = 'object'
          AND CASE
            WHEN jsonb_typeof(ending_rule) = 'object' AND jsonb_typeof(ending_rule -> 'any') = 'array'
            THEN jsonb_array_length(ending_rule -> 'any') BETWEEN 1 AND 4
            ELSE false
          END
        )
      )
      AND (ending_label IS NULL OR ending_label ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
    ) NOT VALID;
  END IF;
  -- Uses left run from 1 to 10,000 while counting, and the use that reaches 0 stamps the time.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
      AND conname = 'things_ending_uses_range') THEN
    ALTER TABLE things ADD CONSTRAINT things_ending_uses_range CHECK (
      (ending_uses_left IS NULL AND ending_uses_spent_at IS NULL)
      OR (ending_uses_left BETWEEN 1 AND 10000 AND ending_uses_spent_at IS NULL)
      OR (ending_uses_left = 0 AND ending_uses_spent_at IS NOT NULL)
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
      AND conname = 'things_ending_idle_range') THEN
    ALTER TABLE things ADD CONSTRAINT things_ending_idle_range CHECK (
      (ending_idle_seconds IS NULL AND ending_idle_anchor IS NULL)
      OR (ending_idle_seconds BETWEEN 60 AND 31622400 AND ending_idle_anchor IS NOT NULL)
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
      AND conname = 'things_ended_consistent') THEN
    ALTER TABLE things ADD CONSTRAINT things_ended_consistent CHECK (
      (ended_at IS NULL AND ended_cause IS NULL AND ended_owner_id IS NULL)
      OR (
        ended_at IS NOT NULL AND ended_owner_id IS NOT NULL AND ending_rule IS NOT NULL
        AND ended_cause IN ('at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added')
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
      AND conname = 'things_end_program_state_known') THEN
    ALTER TABLE things ADD CONSTRAINT things_end_program_state_known CHECK (
      end_program_state IN ('none', 'pending', 'ran', 'skipped')
      AND (end_program_state = 'none' OR ended_at IS NOT NULL)
      AND (end_program_result IS NULL OR jsonb_typeof(end_program_result) = 'object')
    ) NOT VALID;
  END IF;
END
$thing_endings_thing_checks$;
ALTER TABLE things VALIDATE CONSTRAINT things_ending_set_by_fkey;
ALTER TABLE things VALIDATE CONSTRAINT things_ended_owner_id_fkey;
ALTER TABLE things VALIDATE CONSTRAINT things_ending_copied_from_fkey;
ALTER TABLE things VALIDATE CONSTRAINT things_ending_rule_shape;
ALTER TABLE things VALIDATE CONSTRAINT things_ending_uses_range;
ALTER TABLE things VALIDATE CONSTRAINT things_ending_idle_range;
ALTER TABLE things VALIDATE CONSTRAINT things_ended_consistent;
ALTER TABLE things VALIDATE CONSTRAINT things_end_program_state_known;

-- Things with an end set and not yet ended or withdrawn, remnants whose end try waits,
-- and the recorded remnants a place read counts live.
CREATE INDEX IF NOT EXISTS things_ending_open ON things (place_id, id)
  WHERE ending_rule IS NOT NULL AND ended_at IS NULL AND withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS things_end_try_pending ON things (place_id, id)
  WHERE end_program_state = 'pending';
CREATE INDEX IF NOT EXISTS things_remnant ON things (place_id)
  WHERE ended_at IS NOT NULL AND withdrawn_at IS NULL;

-- Every set, renewal, clear, copy, end and end program result, append-only.
CREATE TABLE IF NOT EXISTS thing_ending_changes (
  id          BIGSERIAL PRIMARY KEY,
  thing_id    INTEGER NOT NULL REFERENCES things(id) ON DELETE RESTRICT,
  change      TEXT NOT NULL,
  actor_id    INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  rule        JSONB,
  "grant"     JSONB,
  result      JSONB,
  action_id   BIGINT,
  settle_id   BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT thing_ending_changes_change_known
    CHECK (change IN ('set', 'renew', 'clear', 'copy', 'end', 'program')),
  CONSTRAINT thing_ending_changes_json_shape CHECK (
    (rule IS NULL OR jsonb_typeof(rule) = 'object')
    AND ("grant" IS NULL OR jsonb_typeof("grant") = 'object')
    AND (result IS NULL OR jsonb_typeof(result) = 'object')
  )
);
CREATE INDEX IF NOT EXISTS thing_ending_changes_thing ON thing_ending_changes (thing_id, id DESC);
DROP TRIGGER IF EXISTS thing_ending_changes_append_only ON thing_ending_changes;
CREATE TRIGGER thing_ending_changes_append_only BEFORE UPDATE OR DELETE ON thing_ending_changes
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

-- The things an agreement names, stored with it and never changed.
CREATE TABLE IF NOT EXISTS agreement_thing_links (
  agreement_id  INTEGER NOT NULL REFERENCES agreements(id) ON DELETE RESTRICT,
  position      SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 15),
  thing_id      INTEGER NOT NULL REFERENCES things(id) ON DELETE RESTRICT,
  PRIMARY KEY (agreement_id, position),
  CONSTRAINT agreement_thing_links_one_per_thing UNIQUE (agreement_id, thing_id)
);
CREATE INDEX IF NOT EXISTS agreement_thing_links_thing ON agreement_thing_links (thing_id);
DROP TRIGGER IF EXISTS agreement_thing_links_append_only ON agreement_thing_links;
CREATE TRIGGER agreement_thing_links_append_only BEFORE UPDATE OR DELETE ON agreement_thing_links
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

-- When a thing's end falls due: the soonest of its fixed deadline, its unused deadline,
-- the moment its uses ran out, and the first label row with its watched label created
-- after the end was set. A label row counts even if it has since expired or been ended,
-- so a thing never flips back from due. Callers pass transaction_timestamp(). The rule is
-- written once, over values, so the guards judge a row as it was before a write, the id
-- form reads the stored row, and snapshot format 4 reads its own joins, all by one rule.
CREATE OR REPLACE FUNCTION thing_end_due_from(
  has_rule boolean, deadline timestamptz, idle_anchor timestamptz, idle_seconds integer,
  uses_spent_at timestamptz, first_label_at timestamptz
) RETURNS timestamptz
LANGUAGE sql STABLE AS $thing_end_due_from$
  SELECT CASE WHEN has_rule THEN LEAST(
    deadline,
    idle_anchor + make_interval(secs => idle_seconds),
    uses_spent_at,
    first_label_at
  ) END
$thing_end_due_from$;

CREATE OR REPLACE FUNCTION thing_end_due_at_row(thing things) RETURNS timestamptz
LANGUAGE sql STABLE AS $thing_end_due_at_row$
  SELECT thing_end_due_from(
    thing.ending_rule IS NOT NULL,
    thing.ending_deadline,
    thing.ending_idle_anchor,
    thing.ending_idle_seconds,
    thing.ending_uses_spent_at,
    CASE WHEN thing.ending_rule IS NOT NULL THEN (
      SELECT min(label.created_at)
      FROM active_labels AS label
      WHERE label.target_type = 'thing'
        AND label.target_id = thing.id
        AND label.label = thing.ending_label
        AND label.created_at > thing.ending_set_at
    ) END
  )
$thing_end_due_at_row$;

CREATE OR REPLACE FUNCTION thing_end_due_at(thing_id integer) RETURNS timestamptz
LANGUAGE sql STABLE AS $thing_end_due_at$
  SELECT thing_end_due_at_row(thing)
  FROM things AS thing
  WHERE thing.id = $1
$thing_end_due_at$;

-- False, never null, when no end applies, so "AND NOT thing_end_due(...)" keeps such rows.
CREATE OR REPLACE FUNCTION thing_end_due(thing_id integer, at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $thing_end_due$
  SELECT coalesce(thing_end_due_at($1) <= $2, false)
$thing_end_due$;

-- An end try is a wake try with reason end, and its state writes carry trigger wake_end.
DO $thing_endings_wake_reason$
DECLARE
  narrower RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'wake_tries'::regclass
      AND conname = 'wake_tries_reason_known') THEN
    ALTER TABLE wake_tries ADD CONSTRAINT wake_tries_reason_known
      CHECK (reason IN ('arrive', 'talk', 'clock', 'end')) NOT VALID;
  END IF;
  FOR narrower IN
    SELECT constraint_row.conname
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'wake_tries'::regclass
      AND constraint_row.contype = 'c'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%(reason = ANY%'
      AND constraint_row.conname <> 'wake_tries_reason_known'
  LOOP
    EXECUTE format('ALTER TABLE wake_tries DROP CONSTRAINT %I', narrower.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'thing_state_changes'::regclass
      AND conname = 'thing_state_changes_trigger_known'
      AND pg_get_constraintdef(oid) LIKE '%''wake_end''%') THEN
    ALTER TABLE thing_state_changes
      DROP CONSTRAINT thing_state_changes_trigger_known,
      ADD CONSTRAINT thing_state_changes_trigger_known
        CHECK (trigger IN ('use', 'consume', 'give', 'timer',
          'wake_arrive', 'wake_talk', 'wake_clock', 'wake_end', 'copy', 'owner')) NOT VALID;
  END IF;
END
$thing_endings_wake_reason$;
ALTER TABLE wake_tries VALIDATE CONSTRAINT wake_tries_reason_known;
ALTER TABLE thing_state_changes VALIDATE CONSTRAINT thing_state_changes_trigger_known;

-- The guards. Every one judges at transaction_timestamp() and refuses with SQLSTATE 23514
-- and the constraint name thing_ending_guard. A thing whose end has come (due, or recorded
-- as ended) keeps everything it had, except what its owner may still do: carry it, set it
-- down, give it, or withdraw it. Three writers may pass more, each only for the one thing
-- it names in the transaction-local setting city.ending_writer: record:<id> writes the
-- end, end_try:<id> runs the end program once, withdraw:<id> withdraws a remnant.

-- Whether the writer setting names this thing, and as which writer; '' for nothing.
CREATE OR REPLACE FUNCTION thing_ending_writer(target_thing_id integer) RETURNS text
LANGUAGE sql STABLE AS $thing_ending_writer$
  SELECT CASE coalesce(current_setting('city.ending_writer', true), '')
    WHEN 'record:' || $1 THEN 'record'
    WHEN 'end_try:' || $1 THEN 'end_try'
    WHEN 'withdraw:' || $1 THEN 'withdraw'
    ELSE ''
  END
$thing_ending_writer$;

-- Whether a thing's end has come: recorded, or due now. False for no such thing.
CREATE OR REPLACE FUNCTION thing_end_reached(target_thing_id integer) RETURNS boolean
LANGUAGE sql STABLE AS $thing_end_reached$
  SELECT coalesce(bool_or(
    thing.ended_at IS NOT NULL
    OR coalesce(thing_end_due_at_row(thing) <= transaction_timestamp(), false)
  ), false)
  FROM things AS thing
  WHERE thing.id = $1
$thing_end_reached$;

-- While an end is set and not yet recorded, a thing changes hands only by closing a sale
-- that was already open, the one write that clears active_offer_id with the owner. A
-- recorded remnant may change hands.
CREATE OR REPLACE FUNCTION guard_thing_ending_owner_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.ending_rule IS NOT NULL AND OLD.ended_at IS NULL)
      OR (NEW.ending_rule IS NOT NULL AND NEW.ended_at IS NULL)) THEN
    RETURN NEW;
  END IF;
  IF OLD.active_offer_id IS NOT NULL AND NEW.active_offer_id IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'thing % has an end set, so it changes hands only by closing a sale that was already open', OLD.id
    USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
END
$$;
DROP TRIGGER IF EXISTS things_aa_ending_owner_change ON things;
CREATE TRIGGER things_aa_ending_owner_change BEFORE UPDATE OF owner_id ON things
  FOR EACH ROW EXECUTE FUNCTION guard_thing_ending_owner_change();

-- The freeze. It sorts after every other BEFORE UPDATE trigger on things, so it sees the
-- switches the owner-change triggers turned off. Values are compared, never the SET list:
-- every column not allowed below must keep its value.
CREATE OR REPLACE FUNCTION guard_thing_ending_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  writer TEXT;
  due_at TIMESTAMPTZ;
  allowed TEXT[];
BEGIN
  -- A thing with no end that is not being ended in this write costs nothing more.
  IF OLD.ending_rule IS NULL AND (NEW.ending_rule IS NULL OR NEW.ended_at IS NULL) THEN
    RETURN NEW;
  END IF;
  writer := thing_ending_writer(OLD.id);
  due_at := thing_end_due_at_row(OLD);

  -- Only the recorder writes an end, once, at the moment it fell due.
  IF NEW.ended_at IS DISTINCT FROM OLD.ended_at
    OR NEW.ended_cause IS DISTINCT FROM OLD.ended_cause
    OR NEW.ended_owner_id IS DISTINCT FROM OLD.ended_owner_id THEN
    IF writer <> 'record' OR OLD.ended_at IS NOT NULL OR due_at IS NULL
      OR due_at > transaction_timestamp() OR NEW.ended_at IS DISTINCT FROM due_at THEN
      RAISE EXCEPTION 'thing % has no end to record now; only the recorder writes an end, once, at the moment it fell due', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
    END IF;
  END IF;

  IF OLD.ended_at IS NULL AND (due_at IS NULL OR due_at > transaction_timestamp()) THEN
    RETURN NEW;
  END IF;

  -- The end has come. The owner may still carry it, set it down, give it, and close or
  -- cancel a sale already open.
  allowed := ARRAY['place_id', 'held_by', 'owner_id', 'active_offer_id',
    'wake_enabled', 'open_to_reach', 'open_to_convert'];
  IF writer = 'record' AND OLD.ended_at IS NULL THEN
    allowed := allowed || ARRAY['ended_at', 'ended_cause', 'ended_owner_id', 'end_program_state'];
  ELSIF writer = 'end_try' AND OLD.ended_at IS NOT NULL AND OLD.end_program_state = 'pending' THEN
    allowed := allowed || ARRAY['state', 'state_version', 'copies_made',
      'end_program_state', 'end_program_result'];
  ELSIF writer = 'withdraw' AND OLD.ended_at IS NOT NULL THEN
    allowed := allowed || ARRAY['withdrawn_at', 'end_program_state', 'end_program_result'];
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'thing % has reached its end, so it keeps everything it had', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
  END IF;
  IF NEW.active_offer_id IS DISTINCT FROM OLD.active_offer_id AND NEW.active_offer_id IS NOT NULL THEN
    RAISE EXCEPTION 'thing % has reached its end, so no new sale can hold it', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
  END IF;
  IF (NEW.wake_enabled IS DISTINCT FROM OLD.wake_enabled
      OR NEW.open_to_reach IS DISTINCT FROM OLD.open_to_reach
      OR NEW.open_to_convert IS DISTINCT FROM OLD.open_to_convert)
    AND (NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id
      OR NEW.wake_enabled OR NEW.open_to_reach OR NEW.open_to_convert) THEN
    RAISE EXCEPTION 'thing % has reached its end, so its switches only turn off as it changes hands', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
  END IF;
  IF NEW.end_program_state IS DISTINCT FROM OLD.end_program_state AND NOT (
      (writer = 'record' AND OLD.end_program_state = 'none' AND NEW.end_program_state = 'pending')
      OR (writer = 'end_try' AND OLD.end_program_state = 'pending'
        AND NEW.end_program_state IN ('ran', 'skipped'))
      OR (writer = 'withdraw' AND OLD.end_program_state = 'pending'
        AND NEW.end_program_state = 'skipped')
    ) THEN
    RAISE EXCEPTION 'thing % end program cannot move from % to %', OLD.id, OLD.end_program_state, NEW.end_program_state
      USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
  END IF;
  -- A withdrawal writes a result only as it skips a pending program; a program that
  -- already ran or was skipped keeps its result.
  IF writer = 'withdraw' AND NEW.end_program_result IS DISTINCT FROM OLD.end_program_result
    AND NOT (OLD.end_program_state = 'pending' AND NEW.end_program_state = 'skipped') THEN
    RAISE EXCEPTION 'thing % keeps its end program result; a withdrawal writes one only as it skips a pending program', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS things_zz_ending_freeze ON things;
CREATE TRIGGER things_zz_ending_freeze BEFORE UPDATE ON things
  FOR EACH ROW EXECUTE FUNCTION guard_thing_ending_freeze();

-- A new thing starts with no recorded end, and a copy cannot be made of a thing whose end
-- has come, except by that thing's own end program while it is still pending.
CREATE OR REPLACE FUNCTION guard_thing_ending_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ended_at IS NOT NULL OR NEW.ended_cause IS NOT NULL OR NEW.ended_owner_id IS NOT NULL
    OR NEW.end_program_state <> 'none' OR NEW.end_program_result IS NOT NULL THEN
    RAISE EXCEPTION 'a new thing starts with no recorded end'
      USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
  END IF;
  IF NEW.parent_thing_id IS NOT NULL AND thing_end_reached(NEW.parent_thing_id)
    AND NOT (thing_ending_writer(NEW.parent_thing_id) = 'end_try' AND EXISTS (
      SELECT 1 FROM things AS parent
      WHERE parent.id = NEW.parent_thing_id
        AND parent.ended_at IS NOT NULL AND parent.end_program_state = 'pending'
    )) THEN
    RAISE EXCEPTION 'thing % has reached its end, so it cannot be copied', NEW.parent_thing_id
      USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS things_ending_parent_guard ON things;
CREATE TRIGGER things_ending_parent_guard BEFORE INSERT ON things
  FOR EACH ROW EXECUTE FUNCTION guard_thing_ending_insert();

-- No new label lands on a thing whose end has come. The target is what counts: a remnant's
-- own end program may still label other things.
CREATE OR REPLACE FUNCTION guard_thing_ending_label() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_type = 'thing' AND thing_end_reached(NEW.target_id) THEN
    RAISE EXCEPTION 'thing % has reached its end, so it takes no new label', NEW.target_id
      USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS active_labels_ending_guard ON active_labels;
CREATE TRIGGER active_labels_ending_guard BEFORE INSERT ON active_labels
  FOR EACH ROW EXECUTE FUNCTION guard_thing_ending_label();

CREATE OR REPLACE FUNCTION guard_thing_ending_mark() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF thing_end_reached(NEW.thing_id) THEN
    RAISE EXCEPTION 'thing % has reached its end, so it takes no later-holder mark', NEW.thing_id
      USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS thing_later_holder_marks_ending_guard ON thing_later_holder_marks;
CREATE TRIGGER thing_later_holder_marks_ending_guard BEFORE INSERT ON thing_later_holder_marks
  FOR EACH ROW EXECUTE FUNCTION guard_thing_ending_mark();

-- No new offer, world or direct, names a thing whose end has come. Reservations and claims
-- are updates of an open offer and are judged by the city's sale code, not here, so a
-- payment already holding evidence is never stranded by a refusal.
CREATE OR REPLACE FUNCTION guard_thing_ending_offer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.asset_type = 'thing' AND thing_end_reached(NEW.asset_id) THEN
    RAISE EXCEPTION 'thing % has reached its end, so no new offer can name it', NEW.asset_id
      USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS transfer_offers_ending_guard ON transfer_offers;
CREATE TRIGGER transfer_offers_ending_guard BEFORE INSERT ON transfer_offers
  FOR EACH ROW EXECUTE FUNCTION guard_thing_ending_offer();

-- The gates an end try must pass, written once over values and reading no table: waking
-- on for the thing, the room's wake dials letting it wake (its owner is the room's owner,
-- the room wakes visitors' things, or the thing is pinned, and neither the thing nor its
-- owner is on the room's block lists), not carried, not in a sale, and the room not
-- retired. It returns the closed gates in this fixed order, and an empty list when the
-- try would run. Snapshot format v4 and the settle step's end try call the same function.
CREATE OR REPLACE FUNCTION thing_end_try_blocked_by(
  wake_enabled boolean, carried boolean, in_sale boolean, room_retired boolean,
  thing_id integer, owner_id integer, room_owner_id integer, wake_visitors boolean,
  wake_pins integer[], blocked_thing_ids integer[], blocked_resident_ids integer[]
) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $thing_end_try_blocked_by$
  SELECT array_remove(ARRAY[
    CASE WHEN NOT coalesce(wake_enabled, false) THEN 'wake_off' END,
    CASE WHEN coalesce(thing_id = ANY (blocked_thing_ids), false)
      OR coalesce(owner_id = ANY (blocked_resident_ids), false)
      OR NOT (
        coalesce(owner_id = room_owner_id, false)
        OR coalesce(wake_visitors, false)
        OR coalesce(thing_id = ANY (wake_pins), false)
      ) THEN 'visitors_not_waking' END,
    CASE WHEN coalesce(carried, false) THEN 'carried' END,
    CASE WHEN coalesce(in_sale, false) THEN 'in_sale' END,
    CASE WHEN coalesce(room_retired, false) THEN 'room_retired' END
  ]::text[], NULL)
$thing_end_try_blocked_by$;

-- Public snapshot format v4 (decision #180): format v3 unchanged except that thing rows
-- carry each thing's ending and a thing whose end has come shows no current labels (its
-- label rows stay), kind rows carry their ending permission and inventor, agreement rows
-- carry their thing links, world-offer rows carry the asset state, the ending and the
-- thing_ended phase, and thing_ended events are exported with safe references. Every
-- field is computed here at the export's own transaction time. The export role may read
-- no table and a function runs with its caller's rights, so v4 reads tables only through
-- its own joins and calls only thing_end_due_from and thing_end_try_blocked_by, which
-- read none. The v2 and v3 grants stay so an exporter from an earlier commit still runs.
CREATE OR REPLACE VIEW city_snapshot.public_records_v4
WITH (security_barrier = true)
AS
WITH ending_events AS MATERIALIZED (
  SELECT event.id, event.at, event.kind, event.actor, event.detail
  FROM public.events event
  WHERE event.kind IN ('thing_ended')
),
thing_end_facts AS MATERIALIZED (
  SELECT thing.id AS thing_id,
    thing.withdrawn_at IS NOT NULL AS withdrawn,
    judged.reached,
    CASE
      WHEN thing.ended_at IS NOT NULL THEN jsonb_build_object('state', 'ended', 'at', thing.ended_at)
      WHEN judged.reached THEN jsonb_build_object('state', 'ended', 'at', judged.due_at)
      WHEN thing.ending_rule IS NOT NULL THEN jsonb_build_object('state', 'set', 'at', judged.due_at)
    END AS ends,
    jsonb_build_object(
      'status', stated.status,
      'permission_source', CASE
        WHEN thing.ending_rule IS NOT NULL THEN
          CASE WHEN thing.ending_grant ? 'kindless' THEN 'kindless_owner' ELSE 'kind' END
        WHEN stated.status = 'permitted_but_unset' THEN
          CASE WHEN coalesce(thing.as_kind_id, thing.kind_id) IS NULL THEN 'kindless_owner' ELSE 'kind' END
      END,
      'permitted_modes', CASE
        WHEN thing.parent_thing_id IS NOT NULL OR judged.reached THEN '[]'::jsonb
        ELSE (
          SELECT coalesce(jsonb_agg(to_jsonb(mode.name) ORDER BY mode.position), '[]'::jsonb)
          FROM unnest(ARRAY['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'])
            WITH ORDINALITY mode(name, position)
          WHERE permitted.allowed ? mode.name
        )
      END,
      'conditions', rule.conditions,
      'soonest_known_end', judged.due_at,
      'uses_left', thing.ending_uses_left,
      'unused_deadline', rule.unused_deadline,
      'label', CASE WHEN kind_hidden.removed AND thing.ending_label IS NOT NULL
        THEN '[removed by maintainer]' ELSE thing.ending_label END,
      'grant', CASE
        WHEN kind_hidden.removed AND jsonb_typeof(thing.ending_grant -> 'limits' -> 'labels') = 'array'
          THEN jsonb_set(thing.ending_grant, '{limits,labels}', '["[removed by maintainer]"]'::jsonb)
        ELSE thing.ending_grant
      END,
      'still_permitted', rule.still_permitted,
      'copy_origin', CASE WHEN thing.ending_copied_from IS NOT NULL THEN jsonb_build_object(
        'source_thing_id', thing.ending_copied_from,
        'copied_at', thing.ending_copied_at
      ) END,
      'set_by', CASE WHEN setter.id IS NOT NULL THEN jsonb_build_object(
        'id', setter.id, 'handle', setter.handle
      ) END,
      'set_at', thing.ending_set_at,
      'renewable_before_end', CASE WHEN thing.ending_rule IS NOT NULL
        THEN NOT judged.reached AND thing.parent_thing_id IS NULL END,
      'remains', 'remnant',
      'ended_at', thing.ended_at,
      'ended_cause', thing.ended_cause,
      'owner_at_end', CASE WHEN end_owner.id IS NOT NULL THEN jsonb_build_object(
        'id', end_owner.id, 'handle', end_owner.handle
      ) END,
      'program', jsonb_build_object(
        'state', thing.end_program_state,
        'result', thing.end_program_result,
        'has_end_trait', end_trait.present,
        'would_run', CASE WHEN gates.blocked_by IS NOT NULL THEN cardinality(gates.blocked_by) = 0 END,
        'blocked_by', to_jsonb(gates.blocked_by)
      ),
      'checked_at', transaction_timestamp()
    ) AS ending
  FROM public.things thing
  LEFT JOIN public.kind_revisions policy_revision
    ON policy_revision.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
    AND policy_revision.revision = coalesce(thing.as_revision, thing.current_revision)
  LEFT JOIN public.places room ON room.id = thing.place_id
  LEFT JOIN public.residents setter ON setter.id = thing.ending_set_by
  LEFT JOIN public.residents end_owner ON end_owner.id = thing.ended_owner_id
  -- A maintainer-hidden effective kind: its author's label words read the removal marker.
  CROSS JOIN LATERAL (
    SELECT coalesce((
      SELECT moderation.action
      FROM public.moderation_actions moderation
      WHERE moderation.target_type = 'kind'
        AND moderation.target_id = coalesce(thing.as_kind_id, thing.kind_id)
      ORDER BY moderation.created_at DESC, moderation.id DESC
      LIMIT 1
    ), 'restore') = 'remove' AS removed
  ) kind_hidden
  CROSS JOIN LATERAL (
    SELECT thing_end_due_from(
      thing.ending_rule IS NOT NULL, thing.ending_deadline, thing.ending_idle_anchor,
      thing.ending_idle_seconds, thing.ending_uses_spent_at,
      CASE WHEN thing.ending_rule IS NOT NULL THEN (
        SELECT min(label.created_at)
        FROM public.active_labels label
        WHERE label.target_type = 'thing'
          AND label.target_id = thing.id
          AND label.label = thing.ending_label
          AND label.created_at > thing.ending_set_at
      ) END
    ) AS due_at
  ) due
  CROSS JOIN LATERAL (
    SELECT due.due_at,
      thing.ended_at IS NOT NULL OR coalesce(due.due_at <= transaction_timestamp(), false) AS reached
  ) judged
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN coalesce(thing.as_kind_id, thing.kind_id) IS NULL THEN CASE
        WHEN thing.owner_id = thing.maker_id
          THEN '["at", "after_setting_seconds", "uses", "idle_seconds", "label_added"]'::jsonb
        ELSE '[]'::jsonb
      END
      WHEN jsonb_typeof(policy_revision.ending_policy -> 'allowed') = 'array'
        THEN policy_revision.ending_policy -> 'allowed'
      ELSE '[]'::jsonb
    END AS allowed
  ) permitted
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN thing.ended_at IS NOT NULL THEN 'ended'
      WHEN thing.ending_rule IS NOT NULL AND judged.reached THEN 'due_waiting_settle'
      WHEN thing.ending_rule IS NOT NULL THEN 'active'
      WHEN thing.parent_thing_id IS NOT NULL THEN 'not_permitted_by_kind'
      WHEN jsonb_array_length(permitted.allowed) > 0 THEN 'permitted_but_unset'
      ELSE 'not_permitted_by_kind'
    END AS status
  ) stated
  CROSS JOIN LATERAL (
    SELECT
      coalesce(jsonb_agg(item.value || item.computed || CASE
        WHEN kind_hidden.removed AND jsonb_typeof(item.value -> 'label_added') = 'string'
          THEN jsonb_build_object('label_added', '[removed by maintainer]')
        ELSE '{}'::jsonb
      END ORDER BY item.position), '[]'::jsonb) AS conditions,
      jsonb_object_agg(item.mode, permitted.allowed ? item.mode)
        FILTER (WHERE item.mode IS NOT NULL) AS still_permitted,
      (array_agg(item.computed -> 'unused_deadline' ORDER BY item.position)
        FILTER (WHERE item.computed ? 'unused_deadline'))[1] AS unused_deadline
    FROM (
      SELECT condition.value, condition.position,
        (
          SELECT mode.name
          FROM unnest(ARRAY['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'])
            WITH ORDINALITY mode(name, position)
          WHERE condition.value ? mode.name
          ORDER BY mode.position
          LIMIT 1
        ) AS mode,
        CASE
          WHEN condition.value ? 'after_setting_seconds' THEN jsonb_build_object('ends_at', CASE
            WHEN condition.value ? 'until' THEN to_jsonb(stored_until.at)
            WHEN thing.ending_copied_from IS NOT NULL THEN NULL
            WHEN jsonb_typeof(condition.value -> 'after_setting_seconds') = 'number'
              AND condition.value ->> 'after_setting_seconds' ~ '^[0-9]{1,9}$'
              THEN to_jsonb(thing.ending_set_at
                + make_interval(secs => (condition.value ->> 'after_setting_seconds')::integer))
          END)
          WHEN condition.value ? 'uses' THEN jsonb_build_object('uses_left', thing.ending_uses_left)
          WHEN condition.value ? 'idle_seconds' THEN jsonb_build_object('unused_deadline', CASE
            WHEN condition.value ? 'until' THEN to_jsonb(stored_until.at)
            WHEN thing.ending_copied_from IS NOT NULL THEN NULL
            ELSE to_jsonb(thing.ending_idle_anchor + make_interval(secs => thing.ending_idle_seconds))
          END)
          ELSE '{}'::jsonb
        END AS computed
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(thing.ending_rule -> 'any') = 'array' THEN thing.ending_rule -> 'any'
        ELSE '[]'::jsonb
      END) WITH ORDINALITY condition(value, position)
      -- A copy's until is read only in the shape copyRuleFrom writes (toISOString) and only
      -- when it names a real time; any other value reads as null, so one bad row never
      -- stops the export. CASE fixes the order: the day is checked before the cast.
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN jsonb_typeof(condition.value -> 'until') = 'string'
            AND condition.value ->> 'until' ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
          THEN CASE
            WHEN substring(condition.value ->> 'until' FROM 9 FOR 2)::integer <= extract(day FROM
              (substring(condition.value ->> 'until' FROM 1 FOR 7) || '-01')::date
                + interval '1 month' - interval '1 day')::integer
            THEN (condition.value ->> 'until')::timestamptz
          END
        END AS at
      ) stored_until
      WHERE jsonb_typeof(condition.value) = 'object'
    ) item
  ) rule
  CROSS JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1
      FROM public.kind_revision_traits link
      JOIN public.traits trait ON trait.id = link.trait_id
      WHERE link.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
        AND link.revision = coalesce(thing.as_revision, thing.current_revision)
        AND trait.recipe ? 'end'
    ) AS present
  ) end_trait
  CROSS JOIN LATERAL (
    SELECT CASE WHEN end_trait.present AND thing.end_program_state IN ('none', 'pending')
      THEN thing_end_try_blocked_by(
        thing.wake_enabled,
        thing.held_by IS NOT NULL,
        thing.active_offer_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM public.transfer_offers sale
          WHERE sale.asset_type = 'thing' AND sale.asset_id = thing.id AND sale.status = 'open'
        ),
        room.retired_at IS NOT NULL,
        thing.id,
        thing.owner_id,
        room.owner_id,
        room.wake_visitors,
        room.wake_pins,
        room.wake_block_thing_ids,
        room.wake_block_resident_ids
      )
    END AS blocked_by
  ) gates
)
SELECT v3.class_name, v3.record_id, v3.sort_key,
  CASE
    WHEN v3.payload->>'status' IS DISTINCT FROM 'exported' THEN v3.payload
    WHEN v3.class_name = 'things' AND own_end.thing_id IS NOT NULL THEN
      v3.payload || jsonb_build_object('ending', own_end.ending) || CASE
        WHEN own_end.reached THEN jsonb_build_object('labels', '[]'::jsonb, 'labels_total', 0)
        ELSE '{}'::jsonb
      END
    WHEN v3.class_name = 'world_market_offers' AND offer_end.thing_id IS NOT NULL THEN
      v3.payload || jsonb_build_object(
        'phase', CASE
          WHEN v3.payload->>'phase' IN ('reserved', 'listed') AND offer_end.reached THEN 'thing_ended'
          ELSE v3.payload->>'phase'
        END,
        'asset_state', CASE
          WHEN offer_end.withdrawn THEN 'withdrawn'
          WHEN offer_end.reached THEN 'remnant'
          ELSE 'active'
        END,
        'ending', CASE WHEN offer_end.withdrawn THEN NULL ELSE offer_end.ending END,
        'ending_checked_at', transaction_timestamp()
      )
    WHEN v3.class_name = 'kinds' AND kind.id IS NOT NULL THEN
      v3.payload || jsonb_build_object(
        'ending_policy', kind_definition.ending_policy,
        'invented_by', CASE WHEN inventor.id IS NOT NULL THEN jsonb_build_object(
          'id', inventor.id, 'handle', inventor.handle
        ) END
      )
    WHEN v3.class_name = 'agreements' AND agreement.id IS NOT NULL THEN
      v3.payload || jsonb_build_object('thing_links', coalesce((
        SELECT jsonb_agg(
          jsonb_build_object('position', link.position, 'thing_id', link.thing_id) || CASE
            WHEN linked.ends IS NULL OR linked.withdrawn OR linked_hidden.removed THEN '{}'::jsonb
            ELSE jsonb_build_object('ends', linked.ends)
          END ORDER BY link.position
        )
        FROM public.agreement_thing_links link
        LEFT JOIN thing_end_facts linked ON linked.thing_id = link.thing_id
        CROSS JOIN LATERAL (
          SELECT coalesce((
            SELECT moderation.action
            FROM public.moderation_actions moderation
            WHERE moderation.target_type = 'thing' AND moderation.target_id = link.thing_id
            ORDER BY moderation.created_at DESC, moderation.id DESC
            LIMIT 1
          ), 'restore') = 'remove' AS removed
        ) linked_hidden
        WHERE link.agreement_id = agreement.id
      ), '[]'::jsonb))
    ELSE v3.payload
  END AS payload
FROM city_snapshot.public_records_v3 v3
LEFT JOIN thing_end_facts own_end
  ON v3.class_name = 'things' AND own_end.thing_id::TEXT = v3.record_id
LEFT JOIN thing_end_facts offer_end
  ON v3.class_name = 'world_market_offers' AND offer_end.thing_id::TEXT = v3.payload->>'asset_id'
LEFT JOIN public.kinds kind
  ON v3.class_name = 'kinds' AND kind.id::TEXT = v3.record_id
LEFT JOIN public.kind_revisions kind_definition
  ON kind_definition.kind_id = kind.id AND kind_definition.revision = kind.current_revision
LEFT JOIN public.residents inventor ON inventor.id = kind.invented_by
LEFT JOIN public.agreements agreement
  ON v3.class_name = 'agreements' AND agreement.id::TEXT = v3.record_id
WHERE NOT (v3.class_name = 'events' AND v3.sort_key IN (SELECT ended.id FROM ending_events ended))

UNION ALL

SELECT 'events'::TEXT, ended.id::TEXT, ended.id::BIGINT,
  jsonb_build_object(
    'id', ended.id,
    'status', 'exported',
    'at', ended.at,
    'kind', ended.kind,
    'actor', ended.actor,
    'detail', jsonb_strip_nulls(jsonb_build_object(
      'thing_id', ended.detail->'thing_id',
      'place_id', ended.detail->'place_id',
      'cause', ended.detail->'cause',
      'ended_at', ended.detail->'ended_at',
      'owner_id', ended.detail->'owner_id',
      'owner', ended.detail->'owner',
      'program_state', ended.detail->'program_state'
    )),
    'detail_policy', 'safe references only; authored text is in its primary exported record'
  )
FROM ending_events ended;

REVOKE ALL ON city_snapshot.public_records_v4 FROM PUBLIC;
GRANT SELECT ON city_snapshot.public_records_v4 TO city_snapshot_export;

DO $thing_endings_shape$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(expected.table_name || '.' || expected.column_name, ', ')
  INTO missing
  FROM (VALUES
    ('things', 'ending_rule', 'jsonb', FALSE, NULL::text),
    ('things', 'ending_grant', 'jsonb', FALSE, NULL),
    ('things', 'ending_set_by', 'integer', FALSE, NULL),
    ('things', 'ending_set_at', 'timestamp with time zone', FALSE, NULL),
    ('things', 'ending_deadline', 'timestamp with time zone', FALSE, NULL),
    ('things', 'ending_idle_seconds', 'integer', FALSE, NULL),
    ('things', 'ending_idle_anchor', 'timestamp with time zone', FALSE, NULL),
    ('things', 'ending_uses_left', 'integer', FALSE, NULL),
    ('things', 'ending_uses_spent_at', 'timestamp with time zone', FALSE, NULL),
    ('things', 'ending_label', 'text', FALSE, NULL),
    ('things', 'ending_copied_from', 'integer', FALSE, NULL),
    ('things', 'ending_copied_at', 'timestamp with time zone', FALSE, NULL),
    ('things', 'ended_at', 'timestamp with time zone', FALSE, NULL),
    ('things', 'ended_cause', 'text', FALSE, NULL),
    ('things', 'ended_owner_id', 'integer', FALSE, NULL),
    ('things', 'end_program_state', 'text', TRUE, '''none''::text'),
    ('things', 'end_program_result', 'jsonb', FALSE, NULL),
    ('kinds', 'invented_by', 'integer', FALSE, NULL),
    ('kind_revisions', 'ending_policy', 'jsonb', TRUE, '''{"allowed": []}''::jsonb'),
    -- The id default names its sequence the way pg_get_expr prints it under the current
    -- search_path (qualified only when not visible), so the check holds on any search_path.
    ('thing_ending_changes', 'id', 'bigint', TRUE, 'nextval(' || quote_literal(coalesce(
      to_regclass('public.thing_ending_changes_id_seq')::text, 'public.thing_ending_changes_id_seq')) || '::regclass)'),
    ('thing_ending_changes', 'thing_id', 'integer', TRUE, NULL),
    ('thing_ending_changes', 'change', 'text', TRUE, NULL),
    ('thing_ending_changes', 'actor_id', 'integer', FALSE, NULL),
    ('thing_ending_changes', 'rule', 'jsonb', FALSE, NULL),
    ('thing_ending_changes', 'grant', 'jsonb', FALSE, NULL),
    ('thing_ending_changes', 'result', 'jsonb', FALSE, NULL),
    ('thing_ending_changes', 'action_id', 'bigint', FALSE, NULL),
    ('thing_ending_changes', 'settle_id', 'bigint', FALSE, NULL),
    ('thing_ending_changes', 'created_at', 'timestamp with time zone', TRUE, 'now()'),
    ('agreement_thing_links', 'agreement_id', 'integer', TRUE, NULL),
    ('agreement_thing_links', 'position', 'smallint', TRUE, NULL),
    ('agreement_thing_links', 'thing_id', 'integer', TRUE, NULL)
  ) AS expected(table_name, column_name, column_type, required, column_default)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_attribute AS attribute
    LEFT JOIN pg_attrdef AS attribute_default
      ON attribute_default.adrelid = attribute.attrelid AND attribute_default.adnum = attribute.attnum
    WHERE attribute.attrelid = to_regclass('public.' || expected.table_name)
      AND attribute.attname = expected.column_name
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND format_type(attribute.atttypid, attribute.atttypmod) = expected.column_type
      AND attribute.attnotnull = expected.required
      AND pg_get_expr(attribute_default.adbin, attribute_default.adrelid) IS NOT DISTINCT FROM expected.column_default
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'thing endings columns differ from the reviewed shape: %', missing;
  END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'thing_ending_changes'::regclass
      AND attnum > 0 AND NOT attisdropped) <> 10
    OR (SELECT count(*) FROM pg_attribute WHERE attrelid = 'agreement_thing_links'::regclass
      AND attnum > 0 AND NOT attisdropped) <> 3 THEN
    RAISE EXCEPTION 'thing endings tables carry columns this migration does not know';
  END IF;

  SELECT string_agg(expected.constraint_name, ', ')
  INTO missing
  FROM (VALUES
    ('kinds', 'kinds_invented_by_fkey'),
    ('kind_revisions', 'kind_revisions_ending_policy_valid'),
    ('things', 'things_ending_set_by_fkey'),
    ('things', 'things_ended_owner_id_fkey'),
    ('things', 'things_ending_copied_from_fkey'),
    ('things', 'things_ending_rule_shape'),
    ('things', 'things_ending_uses_range'),
    ('things', 'things_ending_idle_range'),
    ('things', 'things_ended_consistent'),
    ('things', 'things_end_program_state_known'),
    ('thing_ending_changes', 'thing_ending_changes_change_known'),
    ('thing_ending_changes', 'thing_ending_changes_json_shape'),
    ('agreement_thing_links', 'agreement_thing_links_one_per_thing'),
    ('wake_tries', 'wake_tries_reason_known'),
    ('thing_state_changes', 'thing_state_changes_trigger_known')
  ) AS expected(table_name, constraint_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = to_regclass('public.' || expected.table_name)
      AND constraint_row.conname = expected.constraint_name
      AND constraint_row.convalidated
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'thing endings checks or keys are missing or not validated: %', missing;
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'thing_ending_changes'::regclass
      AND contype IN ('p', 'f')) <> 3
    OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'agreement_thing_links'::regclass
      AND contype IN ('p', 'f')) <> 3 THEN
    RAISE EXCEPTION 'thing endings tables are missing one of their reviewed keys';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wake_tries_reason_known'
      AND conrelid = 'wake_tries'::regclass AND pg_get_constraintdef(oid) LIKE '%''end''%')
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'wake_tries'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%(reason = ANY%' AND conname <> 'wake_tries_reason_known')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thing_state_changes_trigger_known'
      AND conrelid = 'thing_state_changes'::regclass AND pg_get_constraintdef(oid) LIKE '%''wake_end''%') THEN
    RAISE EXCEPTION 'the wake vocabularies do not carry the end reason and the wake_end trigger';
  END IF;

  IF to_regclass('public.things_ending_open') IS NULL
    OR to_regclass('public.things_end_try_pending') IS NULL
    OR to_regclass('public.things_remnant') IS NULL
    OR to_regclass('public.thing_ending_changes_thing') IS NULL
    OR to_regclass('public.agreement_thing_links_thing') IS NULL THEN
    RAISE EXCEPTION 'thing endings indexes are missing';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.valid_ending_policy(jsonb)')) IS DISTINCT FROM 'i'
    OR (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.thing_end_due_at(integer)')) IS DISTINCT FROM 's'
    OR (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.thing_end_due(integer, timestamp with time zone)')) IS DISTINCT FROM 's'
    OR (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.kind_provable_inventor(integer)')) IS DISTINCT FROM 's'
    OR to_regprocedure('public.kinds_invented_by_guard()') IS NULL THEN
    RAISE EXCEPTION 'thing endings functions are missing or have the wrong volatility';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND (
      (tgrelid = 'kinds'::regclass AND tgname = 'kinds_invented_by_fixed')
      OR (tgrelid = 'thing_ending_changes'::regclass AND tgname = 'thing_ending_changes_append_only')
      OR (tgrelid = 'agreement_thing_links'::regclass AND tgname = 'agreement_thing_links_append_only')
    )) <> 3 THEN
    RAISE EXCEPTION 'thing endings triggers are missing';
  END IF;

  -- Each guard is present, enabled, a BEFORE row trigger on its events (tgtype bits: 1 row,
  -- 2 before, 4 insert, 16 update), and calls its own function.
  SELECT string_agg(expected.trigger_name, ', ')
  INTO missing
  FROM (VALUES
    ('things', 'things_aa_ending_owner_change', 'guard_thing_ending_owner_change', 19, ARRAY['owner_id']::text[]),
    ('things', 'things_zz_ending_freeze', 'guard_thing_ending_freeze', 19, ARRAY[]::text[]),
    ('things', 'things_ending_parent_guard', 'guard_thing_ending_insert', 7, ARRAY[]::text[]),
    ('active_labels', 'active_labels_ending_guard', 'guard_thing_ending_label', 7, ARRAY[]::text[]),
    ('thing_later_holder_marks', 'thing_later_holder_marks_ending_guard', 'guard_thing_ending_mark', 7, ARRAY[]::text[]),
    ('transfer_offers', 'transfer_offers_ending_guard', 'guard_thing_ending_offer', 7, ARRAY[]::text[])
  ) AS expected(table_name, trigger_name, function_name, trigger_type, columns)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = to_regclass('public.' || expected.table_name)
      AND trigger_row.tgname = expected.trigger_name
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = expected.trigger_type
      AND trigger_row.tgfoid = to_regprocedure('public.' || expected.function_name || '()')
      AND ARRAY(
        SELECT attribute.attname::text FROM unnest(trigger_row.tgattr::int2[]) AS column_number(attnum)
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = trigger_row.tgrelid AND attribute.attnum = column_number.attnum
        ORDER BY attribute.attname
      ) = expected.columns
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'thing endings guards are missing, disabled or of the wrong shape: %', missing;
  END IF;
  -- Row triggers fire in name order. The owner-change guard runs before the two triggers
  -- that turn a thing's switches off as it changes hands; the freeze runs last of all.
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'things'::regclass AND NOT tgisinternal
      AND tgtype & 3 = 3 AND tgtype & 16 = 16
      AND tgname::text COLLATE "C" > 'things_zz_ending_freeze'
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'things'::regclass AND NOT tgisinternal
      AND tgname IN ('things_close_consent_on_owner_change', 'things_sleep_on_owner_change')
      AND tgname::text COLLATE "C" < 'things_aa_ending_owner_change'
  ) THEN
    RAISE EXCEPTION 'thing endings guards are out of order among the things triggers';
  END IF;
  IF to_regprocedure('public.thing_end_due_at_row(public.things)') IS NULL
    OR (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.thing_end_due_at_row(public.things)')) IS DISTINCT FROM 's'
    OR (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.thing_end_reached(integer)')) IS DISTINCT FROM 's'
    OR (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.thing_ending_writer(integer)')) IS DISTINCT FROM 's' THEN
    RAISE EXCEPTION 'thing endings guard functions are missing or have the wrong volatility';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure(
      'public.thing_end_due_from(boolean, timestamptz, timestamptz, integer, timestamptz, timestamptz)')) IS DISTINCT FROM 's'
    OR (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure(
      'public.thing_end_try_blocked_by(boolean, boolean, boolean, boolean, integer, integer, integer, boolean, integer[], integer[], integer[])'))
      IS DISTINCT FROM 'i' THEN
    RAISE EXCEPTION 'thing endings value functions are missing or have the wrong volatility';
  END IF;
  -- Format 4 is a security barrier the export role alone may read, with the four columns
  -- the exporter attests, and the v2 and v3 grants stay for an exporter from an earlier commit.
  IF to_regclass('city_snapshot.public_records_v4') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('city_snapshot.public_records_v4')
      AND relkind = 'v' AND reloptions @> ARRAY['security_barrier=true'])
    OR NOT has_table_privilege('city_snapshot_export', 'city_snapshot.public_records_v4', 'SELECT')
    OR EXISTS (SELECT 1 FROM pg_class relation
      CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
      WHERE relation.oid = to_regclass('city_snapshot.public_records_v4')
        AND acl.grantee <> relation.relowner
        AND (acl.grantee <> 'city_snapshot_export'::regrole OR acl.privilege_type <> 'SELECT'))
    OR (SELECT array_agg(column_row.attname::text ORDER BY column_row.attnum) FROM pg_attribute AS column_row
      WHERE column_row.attrelid = to_regclass('city_snapshot.public_records_v4')
        AND column_row.attnum > 0 AND NOT column_row.attisdropped)
      IS DISTINCT FROM ARRAY['class_name', 'record_id', 'sort_key', 'payload']
    OR NOT has_table_privilege('city_snapshot_export', 'city_snapshot.public_records_v3', 'SELECT')
    OR NOT has_table_privilege('city_snapshot_export', 'city_snapshot.public_records_v2', 'SELECT') THEN
    RAISE EXCEPTION 'thing endings snapshot format 4 view is missing, or readable by more than the export role';
  END IF;
END
$thing_endings_shape$;

COMMIT;
