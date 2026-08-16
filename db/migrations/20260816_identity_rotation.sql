-- Additive Wave 1 identity migration: staged browser-only root-key rotation.
-- Active intents contain SHA-256 hashes only. Every terminal intent is scrubbed.

CREATE TABLE IF NOT EXISTS resident_key_rotations (
  id                      BIGSERIAL PRIMARY KEY,
  resident_id             INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  recovery_generation     BIGINT NOT NULL CHECK (recovery_generation >= 0),
  session_hash            TEXT UNIQUE CHECK (
                            session_hash IS NULL OR session_hash ~ '^[0-9a-f]{64}$'
                          ),
  csrf_hash               TEXT UNIQUE CHECK (
                            csrf_hash IS NULL OR csrf_hash ~ '^[0-9a-f]{64}$'
                          ),
  resident_secret_hash    TEXT CHECK (
                            resident_secret_hash IS NULL OR resident_secret_hash ~ '^[0-9a-f]{64}$'
                          ),
  replacement_secret_hash TEXT CHECK (
                            replacement_secret_hash IS NULL OR replacement_secret_hash ~ '^[0-9a-f]{64}$'
                          ),
  expires_at              TIMESTAMPTZ NOT NULL,
  confirmed_at            TIMESTAMPTZ,
  canceled_at             TIMESTAMPTZ,
  invalidated_at          TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (resident_secret_hash IS NULL OR replacement_secret_hash <> resident_secret_hash),
  CHECK (num_nonnulls(confirmed_at, canceled_at, invalidated_at) <= 1),
  CHECK (
    (
      confirmed_at IS NULL AND canceled_at IS NULL AND invalidated_at IS NULL
      AND session_hash IS NOT NULL AND csrf_hash IS NOT NULL
      AND resident_secret_hash IS NOT NULL AND replacement_secret_hash IS NOT NULL
    )
    OR
    (
      num_nonnulls(confirmed_at, canceled_at, invalidated_at) = 1
      AND session_hash IS NULL AND csrf_hash IS NULL
      AND resident_secret_hash IS NULL AND replacement_secret_hash IS NULL
    )
  ),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK (confirmed_at IS NULL OR confirmed_at >= created_at),
  CHECK (canceled_at IS NULL OR canceled_at >= created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS resident_key_rotations_resident
  ON resident_key_rotations (resident_id, recovery_generation, id);
CREATE INDEX IF NOT EXISTS resident_key_rotations_active_expiry
  ON resident_key_rotations (expires_at, id)
  WHERE confirmed_at IS NULL AND canceled_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS resident_key_rotations_daily_success
  ON resident_key_rotations (resident_id, confirmed_at DESC)
  WHERE confirmed_at IS NOT NULL;

DO $identity_rotation_attempt_kinds$
DECLARE
  existing_constraint RECORD;
BEGIN
  FOR existing_constraint IN
    SELECT constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'identity_rate_limits'::regclass
      AND constraint_row.contype = 'c'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%attempt_kind%'
  LOOP
    EXECUTE format(
      'ALTER TABLE identity_rate_limits DROP CONSTRAINT %I',
      existing_constraint.conname
    );
  END LOOP;

  ALTER TABLE identity_rate_limits
    ADD CONSTRAINT identity_rate_limits_attempt_kind_allowed
    CHECK (
      attempt_kind IN (
        'join_stage', 'join_confirm', 'recovery_generate',
        'recovery_begin', 'recovery_confirm',
        'rotation_begin', 'rotation_confirm'
      )
    ) NOT VALID;
END
$identity_rotation_attempt_kinds$;

ALTER TABLE identity_rate_limits
  VALIDATE CONSTRAINT identity_rate_limits_attempt_kind_allowed;
