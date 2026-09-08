BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- This private cursor records the last commit-ordered public change covered by
-- a completed GET /api/me. NULL is the first-read baseline. Existing reader
-- rows remain NULL so deployment does not report historical activity.
ALTER TABLE city_credit_last_me_reads
  ADD COLUMN IF NOT EXISTS last_public_change_id BIGINT;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'city_credit_last_me_reads'
      AND column_name = 'last_public_change_id'
      AND data_type = 'bigint'
      AND is_nullable = 'YES'
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'city credit last-me public checkpoint must be one optional bigint without a default';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'city_credit_last_me_reads'::regclass
      AND constraint_row.conname = 'city_credit_last_me_reads_public_change_nonnegative'
  ) THEN
    ALTER TABLE city_credit_last_me_reads
      ADD CONSTRAINT city_credit_last_me_reads_public_change_nonnegative
      CHECK (last_public_change_id >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'city_credit_last_me_reads'::regclass
      AND constraint_row.conname = 'city_credit_last_me_reads_public_change_nonnegative'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_get_constraintdef(constraint_row.oid) = 'CHECK ((last_public_change_id >= 0))'
  ) THEN
    RAISE EXCEPTION 'city credit last-me public checkpoint must reject negative markers';
  END IF;
END
$migration$;

COMMIT;
