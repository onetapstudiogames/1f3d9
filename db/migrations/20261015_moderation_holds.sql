BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The founder's hold and every moderation record's own fields (decisions #149,
-- #150 and #151). A hold is a moderation_actions row with action 'hold' on
-- target_type 'hold', target_id the resident; a restore on target_type 'hold'
-- ends it early. Holds never use target_type 'resident', so no reader of a
-- resident's removal can read a hold or its restore as one. The inline action
-- check is replaced by a named one and the named target-type check is replaced
-- under its own name; both only add 'hold' to what is allowed. Every new
-- column is nullable and old rows are untouched; new checks and the foreign key
-- are added NOT VALID and validated in separate statements. It is safe to run
-- again.
DO $moderation_holds_guard$
BEGIN
  IF to_regclass('public.moderation_actions') IS NULL THEN
    RAISE EXCEPTION 'moderation holds migration needs the moderation_actions table';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'moderation_actions'::regclass
      AND contype = 'c'
      AND conname NOT IN (
        'moderation_actions_action_check', 'moderation_actions_action_allowed',
        'moderation_actions_target_type_allowed', 'moderation_actions_hold_fields'
      )
      AND pg_get_constraintdef(oid) ~ '\maction\M'
  ) THEN
    RAISE EXCEPTION 'a check other than moderation_actions_action_check restricts moderation_actions.action; review it before widening';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'moderation_actions'::regclass
      AND conname = 'moderation_actions_action_check'
      AND pg_get_constraintdef(oid) IS DISTINCT FROM
        'CHECK ((action = ANY (ARRAY[''remove''::text, ''restore''::text])))'
  ) THEN
    RAISE EXCEPTION 'moderation_actions_action_check is not the reviewed remove or restore check';
  END IF;
END
$moderation_holds_guard$;

ALTER TABLE moderation_actions
  ADD COLUMN IF NOT EXISTS rule_word TEXT,
  ADD COLUMN IF NOT EXISTS at_once_for TEXT,
  ADD COLUMN IF NOT EXISTS smaller_step TEXT,
  ADD COLUMN IF NOT EXISTS smaller_step_record_id BIGINT,
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hold_notes SMALLINT,
  ADD COLUMN IF NOT EXISTS hold_lines SMALLINT,
  ADD COLUMN IF NOT EXISTS hold_things SMALLINT,
  ADD COLUMN IF NOT EXISTS hold_agreements SMALLINT,
  ADD COLUMN IF NOT EXISTS hold_stops_pings BOOLEAN,
  ADD COLUMN IF NOT EXISTS hold_stops_building BOOLEAN,
  DROP CONSTRAINT IF EXISTS moderation_actions_action_check;

DO $moderation_holds_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation_actions'::regclass
    AND conname = 'moderation_actions_action_allowed') THEN
    ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_allowed
      CHECK (action IN ('remove', 'restore', 'hold')) NOT VALID;
  END IF;
  -- The target-type check keeps its name and also carries the hold's shape: a hold
  -- row is always on target_type 'hold', and target_type 'hold' takes only a hold or
  -- a restore. Keeping the name, and the word 'ping' in its list, means the
  -- same-room-talk block that closes db/schema.sql neither drops it nor adds the
  -- narrower list back.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation_actions'::regclass
    AND conname = 'moderation_actions_target_type_allowed'
    AND pg_get_constraintdef(oid) LIKE '%''hold''%') THEN
    ALTER TABLE moderation_actions
      DROP CONSTRAINT IF EXISTS moderation_actions_target_type_allowed,
      ADD CONSTRAINT moderation_actions_target_type_allowed
        CHECK (CASE WHEN target_type = 'hold' THEN action IN ('hold', 'restore')
          ELSE action <> 'hold' AND target_type IN (
            'resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement', 'line', 'ping'
          )
        END) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation_actions'::regclass
    AND conname = 'moderation_actions_rule_word_allowed') THEN
    ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_rule_word_allowed
      CHECK (rule_word IS NULL OR rule_word IN ('disruptive', 'harmful', 'detrimental')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation_actions'::regclass
    AND conname = 'moderation_actions_at_once_for_allowed') THEN
    ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_at_once_for_allowed
      CHECK (at_once_for IS NULL OR at_once_for IN ('illegal', 'doxxing', 'fraud', 'flooding')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation_actions'::regclass
    AND conname = 'moderation_actions_smaller_step_bytes') THEN
    ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_smaller_step_bytes
      CHECK (smaller_step IS NULL OR octet_length(smaller_step) BETWEEN 1 AND 500) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation_actions'::regclass
    AND conname = 'moderation_actions_hold_numbers') THEN
    ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_hold_numbers
      CHECK (
        (hold_notes IS NULL OR hold_notes BETWEEN 0 AND 50)
        AND (hold_lines IS NULL OR hold_lines BETWEEN 0 AND 300)
        AND (hold_things IS NULL OR hold_things BETWEEN 0 AND 20)
        AND (hold_agreements IS NULL OR hold_agreements BETWEEN 0 AND 5)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation_actions'::regclass
    AND conname = 'moderation_actions_hold_fields') THEN
    ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_hold_fields
      CHECK (CASE WHEN action = 'hold' THEN
        ends_at IS NOT NULL
        AND ends_at > created_at
        AND ends_at - created_at <= interval '90 days'
        AND hold_stops_pings IS NOT NULL
        AND hold_stops_building IS NOT NULL
        AND (
          coalesce(hold_notes < 50, false)
          OR coalesce(hold_lines < 300, false)
          OR coalesce(hold_things < 20, false)
          OR coalesce(hold_agreements < 5, false)
          OR hold_stops_pings
          OR hold_stops_building
        )
      ELSE
        ends_at IS NULL
        AND hold_notes IS NULL
        AND hold_lines IS NULL
        AND hold_things IS NULL
        AND hold_agreements IS NULL
        AND hold_stops_pings IS NULL
        AND hold_stops_building IS NULL
      END) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation_actions'::regclass
    AND conname = 'moderation_actions_smaller_step_record_fk') THEN
    ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_smaller_step_record_fk
      FOREIGN KEY (smaller_step_record_id) REFERENCES moderation_actions(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
END
$moderation_holds_constraints$;

ALTER TABLE moderation_actions VALIDATE CONSTRAINT moderation_actions_action_allowed;
ALTER TABLE moderation_actions VALIDATE CONSTRAINT moderation_actions_target_type_allowed;
ALTER TABLE moderation_actions VALIDATE CONSTRAINT moderation_actions_rule_word_allowed;
ALTER TABLE moderation_actions VALIDATE CONSTRAINT moderation_actions_at_once_for_allowed;
ALTER TABLE moderation_actions VALIDATE CONSTRAINT moderation_actions_smaller_step_bytes;
ALTER TABLE moderation_actions VALIDATE CONSTRAINT moderation_actions_hold_numbers;
ALTER TABLE moderation_actions VALIDATE CONSTRAINT moderation_actions_hold_fields;
ALTER TABLE moderation_actions VALIDATE CONSTRAINT moderation_actions_smaller_step_record_fk;

DO $moderation_holds_shape$
DECLARE
  actual_columns TEXT[];
  actual_types TEXT[];
  actual_required BOOLEAN[];
  target_definition TEXT;
BEGIN
  SELECT
    array_agg(attribute.attname ORDER BY attribute.attnum),
    array_agg(format_type(attribute.atttypid, attribute.atttypmod) ORDER BY attribute.attnum),
    array_agg(attribute.attnotnull ORDER BY attribute.attnum)
  INTO actual_columns, actual_types, actual_required
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'moderation_actions'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_columns IS DISTINCT FROM ARRAY[
    'id', 'target_type', 'target_id', 'action', 'actor_id', 'reason', 'created_at',
    'rule_word', 'at_once_for', 'smaller_step', 'smaller_step_record_id', 'ends_at',
    'hold_notes', 'hold_lines', 'hold_things', 'hold_agreements',
    'hold_stops_pings', 'hold_stops_building'
  ]::TEXT[]
  OR actual_types IS DISTINCT FROM ARRAY[
    'bigint', 'text', 'integer', 'text', 'integer', 'text', 'timestamp with time zone',
    'text', 'text', 'text', 'bigint', 'timestamp with time zone',
    'smallint', 'smallint', 'smallint', 'smallint',
    'boolean', 'boolean'
  ]::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[
    TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE,
    FALSE, FALSE, FALSE, FALSE, FALSE,
    FALSE, FALSE, FALSE, FALSE,
    FALSE, FALSE
  ]::BOOLEAN[] THEN
    RAISE EXCEPTION 'moderation_actions conflicts with the reviewed hold columns';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'moderation_actions'::regclass
      AND conname = 'moderation_actions_action_check'
  ) THEN
    RAISE EXCEPTION 'moderation_actions still carries the remove or restore check the hold migration replaces';
  END IF;

  IF (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'moderation_actions'::regclass
      AND convalidated
      AND conname IN (
        'moderation_actions_action_allowed', 'moderation_actions_target_type_allowed',
        'moderation_actions_rule_word_allowed', 'moderation_actions_at_once_for_allowed',
        'moderation_actions_smaller_step_bytes', 'moderation_actions_hold_numbers',
        'moderation_actions_hold_fields', 'moderation_actions_smaller_step_record_fk'
      )
  ) <> 8 THEN
    RAISE EXCEPTION 'moderation_actions is missing a validated hold constraint';
  END IF;

  IF (
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'moderation_actions'::regclass
      AND conname = 'moderation_actions_action_allowed'
  ) IS DISTINCT FROM
    'CHECK ((action = ANY (ARRAY[''remove''::text, ''restore''::text, ''hold''::text])))' THEN
    RAISE EXCEPTION 'moderation_actions_action_allowed does not name exactly remove, restore and hold';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO target_definition
  FROM pg_constraint
  WHERE conrelid = 'moderation_actions'::regclass
    AND conname = 'moderation_actions_target_type_allowed';
  IF target_definition NOT LIKE
      '%WHEN (target_type = ''hold''::text) THEN (action = ANY (ARRAY[''hold''::text, ''restore''::text]))%'
    OR target_definition NOT LIKE '%(action <> ''hold''::text)%'
    OR target_definition NOT LIKE
      '%ARRAY[''resident''::text, ''place''::text, ''thing''::text, ''kind''::text, ''trait''::text, ''note''::text, ''agreement''::text, ''line''::text, ''ping''::text]%' THEN
    RAISE EXCEPTION 'moderation_actions_target_type_allowed does not keep holds on target_type hold beside the nine public targets';
  END IF;
END
$moderation_holds_shape$;

COMMIT;
