BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Thing endings, the stores only. An owner may give a thing an end its kind permits; the
-- first condition met ends it, and it stays at its id as a remnant. This adds the empty
-- columns on things, the inventor on kinds, the permission on kind revisions, two
-- append-only tables, the due functions, two partial indexes, and the end reason in the
-- wake vocabularies. Every new column is empty or at its default, so no thing, revision,
-- event or label row changes; only kinds gain an inventor, and only from exactly one
-- provable kind_invented event. The whole migration holds the things lock until it commits;
-- NOT VALID then VALIDATE does not shorten it in one transaction. It is safe to run again,
-- and running it again fills the inventor of kinds invented since the last run.
DO $thing_endings_guard$
BEGIN
  IF to_regclass('public.things') IS NULL OR to_regclass('public.kinds') IS NULL
    OR to_regclass('public.kind_revisions') IS NULL OR to_regclass('public.residents') IS NULL
    OR to_regclass('public.events') IS NULL OR to_regclass('public.active_labels') IS NULL
    OR to_regclass('public.agreements') IS NULL OR to_regclass('public.wake_tries') IS NULL
    OR to_regclass('public.thing_state_changes') IS NULL THEN
    RAISE EXCEPTION 'thing endings migration needs the things, kinds, kind_revisions, residents, events, active_labels, agreements, wake_tries and thing_state_changes tables';
  END IF;
  IF to_regprocedure('public.deny_history_mutation()') IS NULL THEN
    RAISE EXCEPTION 'thing endings migration needs the deny_history_mutation function';
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

-- Things with an end set and not yet ended or withdrawn, and remnants whose end try waits.
CREATE INDEX IF NOT EXISTS things_ending_open ON things (place_id, id)
  WHERE ending_rule IS NOT NULL AND ended_at IS NULL AND withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS things_end_try_pending ON things (place_id, id)
  WHERE end_program_state = 'pending';

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
-- so a thing never flips back from due. Callers pass transaction_timestamp().
CREATE OR REPLACE FUNCTION thing_end_due_at(thing_id integer) RETURNS timestamptz
LANGUAGE sql STABLE AS $thing_end_due_at$
  SELECT CASE WHEN thing.ending_rule IS NULL THEN NULL ELSE LEAST(
    thing.ending_deadline,
    thing.ending_idle_anchor + make_interval(secs => thing.ending_idle_seconds),
    thing.ending_uses_spent_at,
    (
      SELECT min(label.created_at)
      FROM active_labels AS label
      WHERE label.target_type = 'thing'
        AND label.target_id = thing.id
        AND label.label = thing.ending_label
        AND label.created_at > thing.ending_set_at
    )
  ) END
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
    ('thing_ending_changes', 'id', 'bigint', TRUE, 'nextval(''thing_ending_changes_id_seq''::regclass)'),
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
END
$thing_endings_shape$;

COMMIT;
