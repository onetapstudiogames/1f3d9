BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Waiting transfers, the held gifts of decision #158. When a resident has muted a
-- giver and has not let that giver's gifts through, a give of a thing, kind or place to
-- it, or a transfer effect in the giver's use, writes one private row here instead of
-- the move: nothing moves, no event is written, and nothing is locked. The recipient
-- accepts or declines; the answer, its detail and its time are all null while it
-- waits and all set once it ends. Each mute row gains let_gifts_through, false by
-- default and true only on a mute of a resident, so a resident may let one muted
-- resident's gifts move at once. The table is new, so no existing row changes and no
-- existing table is locked beyond the brief share lock its foreign keys take on
-- residents. resident_mutes changes in one ALTER TABLE statement with a constant
-- default, so no row is rewritten; its check is added NOT VALID and validated in its
-- own statement. Both are private and never exported. It is safe to run again.
DO $waiting_transfers_guard$
BEGIN
  IF to_regclass('public.residents') IS NULL OR to_regclass('public.resident_mutes') IS NULL THEN
    RAISE EXCEPTION 'waiting transfers migration needs the residents and resident_mutes tables';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('public.waiting_transfers')
      AND attnum > 0 AND NOT attisdropped
      AND attname NOT IN ('id', 'giver_id', 'recipient_id', 'asset_type', 'asset_id', 'created_at',
        'answer', 'answer_detail', 'answered_at')
  ) THEN
    RAISE EXCEPTION 'waiting_transfers already exists with columns this migration does not know';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'resident_mutes'::regclass
      AND attname = 'let_gifts_through'
      AND NOT attisdropped
      AND (atttypid <> 'boolean'::regtype OR NOT attnotnull)
  ) THEN
    RAISE EXCEPTION 'resident_mutes.let_gifts_through already exists with a shape this migration does not know';
  END IF;
END
$waiting_transfers_guard$;

-- One private row per held transfer: who gave what to whom, and the recipient's answer.
CREATE TABLE IF NOT EXISTS waiting_transfers (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  giver_id       INTEGER NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  recipient_id   INTEGER NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  asset_type     TEXT NOT NULL,
  asset_id       INTEGER NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  answer         TEXT,
  answer_detail  TEXT,
  answered_at    TIMESTAMPTZ,
  CONSTRAINT waiting_transfers_asset_type_allowed CHECK (asset_type IN ('thing', 'kind', 'place')),
  CONSTRAINT waiting_transfers_asset_id_positive CHECK (asset_id > 0),
  CONSTRAINT waiting_transfers_not_self CHECK (giver_id <> recipient_id),
  CONSTRAINT waiting_transfers_answer_allowed
    CHECK (answer IS NULL OR answer IN ('accepted', 'declined', 'failed')),
  CONSTRAINT waiting_transfers_answer_complete CHECK (
    (answer IS NULL AND answer_detail IS NULL AND answered_at IS NULL)
    OR (answer IS NOT NULL AND answer_detail IS NOT NULL AND answered_at IS NOT NULL)
  ),
  CONSTRAINT waiting_transfers_answer_detail_size
    CHECK (answer_detail IS NULL OR octet_length(answer_detail) BETWEEN 1 AND 2000)
);
-- One open row per giver, recipient and asset, so giving the same thing again finds it.
CREATE UNIQUE INDEX IF NOT EXISTS waiting_transfers_one_open
  ON waiting_transfers (giver_id, recipient_id, asset_type, asset_id) WHERE answer IS NULL;
-- The recipient's open list, oldest first.
CREATE INDEX IF NOT EXISTS waiting_transfers_recipient_open
  ON waiting_transfers (recipient_id, id) WHERE answer IS NULL;

DO $waiting_transfers_mutes$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'resident_mutes'::regclass
    AND conname = 'resident_mutes_let_gifts_through_on_resident_mute') THEN
    ALTER TABLE resident_mutes
      ADD COLUMN IF NOT EXISTS let_gifts_through BOOLEAN NOT NULL DEFAULT FALSE,
      ADD CONSTRAINT resident_mutes_let_gifts_through_on_resident_mute
        CHECK (NOT let_gifts_through OR (choice = 'mute' AND target_type = 'resident')) NOT VALID;
  END IF;
END
$waiting_transfers_mutes$;

ALTER TABLE resident_mutes VALIDATE CONSTRAINT resident_mutes_let_gifts_through_on_resident_mute;

DO $waiting_transfers_shape$
DECLARE
  actual_columns TEXT[];
  actual_types TEXT[];
  actual_required BOOLEAN[];
  actual_identity TEXT[];
  actual_defaults TEXT[];
BEGIN
  SELECT
    array_agg(attribute.attname ORDER BY attribute.attnum),
    array_agg(format_type(attribute.atttypid, attribute.atttypmod) ORDER BY attribute.attnum),
    array_agg(attribute.attnotnull ORDER BY attribute.attnum),
    array_agg(attribute.attidentity::text ORDER BY attribute.attnum),
    array_agg(coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '') ORDER BY attribute.attnum)
  INTO actual_columns, actual_types, actual_required, actual_identity, actual_defaults
  FROM pg_attribute AS attribute
  LEFT JOIN pg_attrdef AS default_value
    ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
  WHERE attribute.attrelid = 'waiting_transfers'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_columns IS DISTINCT FROM ARRAY[
    'id', 'giver_id', 'recipient_id', 'asset_type', 'asset_id', 'created_at',
    'answer', 'answer_detail', 'answered_at'
  ]::TEXT[]
  OR actual_types IS DISTINCT FROM ARRAY[
    'bigint', 'integer', 'integer', 'text', 'integer', 'timestamp with time zone',
    'text', 'text', 'timestamp with time zone'
  ]::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE, FALSE]::BOOLEAN[]
  OR actual_identity IS DISTINCT FROM ARRAY['a', '', '', '', '', '', '', '', '']::TEXT[]
  OR actual_defaults IS DISTINCT FROM ARRAY['', '', '', '', '', 'now()', '', '', '']::TEXT[] THEN
    RAISE EXCEPTION 'waiting_transfers conflicts with the reviewed waiting transfer columns';
  END IF;

  IF (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'waiting_transfers'::regclass
      AND convalidated
      AND (conname, contype, pg_get_constraintdef(oid)) IN (
        ('waiting_transfers_pkey', 'p', 'PRIMARY KEY (id)'),
        ('waiting_transfers_giver_id_fkey', 'f',
          'FOREIGN KEY (giver_id) REFERENCES residents(id) ON DELETE CASCADE'),
        ('waiting_transfers_recipient_id_fkey', 'f',
          'FOREIGN KEY (recipient_id) REFERENCES residents(id) ON DELETE CASCADE'),
        ('waiting_transfers_asset_type_allowed', 'c',
          'CHECK ((asset_type = ANY (ARRAY[''thing''::text, ''kind''::text, ''place''::text])))'),
        ('waiting_transfers_asset_id_positive', 'c', 'CHECK ((asset_id > 0))'),
        ('waiting_transfers_not_self', 'c', 'CHECK ((giver_id <> recipient_id))'),
        ('waiting_transfers_answer_allowed', 'c',
          'CHECK (((answer IS NULL) OR (answer = ANY (ARRAY[''accepted''::text, ''declined''::text, ''failed''::text]))))'),
        ('waiting_transfers_answer_complete', 'c',
          'CHECK ((((answer IS NULL) AND (answer_detail IS NULL) AND (answered_at IS NULL)) OR ((answer IS NOT NULL) AND (answer_detail IS NOT NULL) AND (answered_at IS NOT NULL))))'),
        ('waiting_transfers_answer_detail_size', 'c',
          'CHECK (((answer_detail IS NULL) OR ((octet_length(answer_detail) >= 1) AND (octet_length(answer_detail) <= 2000))))')
      )
  ) <> 9 OR (
    SELECT count(*) FROM pg_constraint WHERE conrelid = 'waiting_transfers'::regclass
  ) <> 9 THEN
    RAISE EXCEPTION 'waiting_transfers is missing one of its reviewed checks or keys';
  END IF;

  IF (
    SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'waiting_transfers'
      AND (indexname, indexdef) IN (
        ('waiting_transfers_one_open',
          'CREATE UNIQUE INDEX waiting_transfers_one_open ON public.waiting_transfers USING btree (giver_id, recipient_id, asset_type, asset_id) WHERE (answer IS NULL)'),
        ('waiting_transfers_recipient_open',
          'CREATE INDEX waiting_transfers_recipient_open ON public.waiting_transfers USING btree (recipient_id, id) WHERE (answer IS NULL)')
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'waiting_transfers is missing one of its reviewed indexes';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute attribute
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'resident_mutes'::regclass
      AND attribute.attname = 'let_gifts_through'
      AND attribute.atttypid = 'boolean'::regtype
      AND attribute.attnotnull
      AND NOT attribute.attisdropped
      AND pg_get_expr(default_value.adbin, default_value.adrelid) = 'false'
  ) THEN
    RAISE EXCEPTION 'resident_mutes.let_gifts_through is not the reviewed not-null boolean with default false';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'resident_mutes'::regclass
      AND conname = 'resident_mutes_let_gifts_through_on_resident_mute'
      AND contype = 'c'
      AND convalidated
      AND pg_get_constraintdef(oid) = 'CHECK (((NOT let_gifts_through) OR ((choice = ''mute''::text) AND (target_type = ''resident''::text))))'
  ) THEN
    RAISE EXCEPTION 'resident_mutes_let_gifts_through_on_resident_mute is missing, not validated, or not the reviewed check';
  END IF;
END
$waiting_transfers_shape$;

COMMIT;
