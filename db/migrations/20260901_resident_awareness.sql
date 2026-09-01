BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Private reader state only: NULL is represented by no row. The bigint marker
-- records the last resident credit entry covered by a completed GET /api/me.
-- The nullable prior value makes concurrent reads advance that marker exactly
-- once without exposing reader state outside this private table.
CREATE TABLE IF NOT EXISTS city_credit_last_me_reads (
  resident_id          INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE CASCADE,
  previous_credit_entry_id BIGINT CHECK (previous_credit_entry_id >= 0),
  last_credit_entry_id BIGINT NOT NULL CHECK (last_credit_entry_id >= 0),
  read_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'city_credit_last_me_reads'::regclass
      AND constraint_row.contype = 'p'
      AND array_length(constraint_row.conkey, 1) = 1
      AND (
        SELECT attribute.attname
        FROM pg_attribute attribute
        WHERE attribute.attrelid = constraint_row.conrelid
          AND attribute.attnum = constraint_row.conkey[1]
      ) = 'resident_id'
  ) THEN
    RAISE EXCEPTION 'city credit last-me reader state requires resident_id as its primary key';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'city_credit_last_me_reads'::regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'residents'::regclass
      AND constraint_row.confdeltype = 'c'
      AND array_length(constraint_row.conkey, 1) = 1
      AND array_length(constraint_row.confkey, 1) = 1
      AND (
        SELECT attribute.attname
        FROM pg_attribute attribute
        WHERE attribute.attrelid = constraint_row.conrelid
          AND attribute.attnum = constraint_row.conkey[1]
      ) = 'resident_id'
      AND (
        SELECT attribute.attname
        FROM pg_attribute attribute
        WHERE attribute.attrelid = constraint_row.confrelid
          AND attribute.attnum = constraint_row.confkey[1]
      ) = 'id'
  ) THEN
    RAISE EXCEPTION 'city credit last-me resident_id must cascade from residents.id';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'city_credit_last_me_reads'
      AND column_name = 'last_credit_entry_id'
      AND data_type = 'bigint'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'city credit last-me marker must be one required bigint';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'city_credit_last_me_reads'
      AND column_name = 'previous_credit_entry_id'
      AND data_type = 'bigint'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'city credit last-me prior marker must be one optional bigint';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'city_credit_last_me_reads'
      AND column_name = 'read_at'
      AND data_type = 'timestamp with time zone'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'city credit last-me read_at must be one required timestamp with time zone';
  END IF;
END
$migration$;

COMMIT;
