BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Decision row 74: coding clients get a script-shaped identity door. This
-- migration is purely additive: one nullable ceremony column on the existing
-- staged-registration table, one new table for short-lived pairing codes, and
-- one closed-enum extension so pairing-code minting can share the existing
-- OAuth rate-limit machinery. Nothing here alters an existing row, and it is
-- never run against any database by this change -- the PR only ships the file.

-- human_approved is nonsecret ceremony state, exactly like client_class added
-- in 20260826_resumable_registration.sql. The browser flow satisfies it
-- implicitly (a human is present at the browser) and leaves it NULL; the JSON
-- door requires the caller to declare {"human_approved":true} before staging
-- and the value is scrubbed to NULL on confirm/cancel/expiry, the same way
-- client_class already is.
ALTER TABLE pending_resident_registrations
  ADD COLUMN IF NOT EXISTS human_approved BOOLEAN;

-- A signed-in coding client mints a pairing code bound to its own resident.
-- The hosted OAuth sign-in page consumes it in place of a typed resident key.
-- Only a hash is ever stored; the raw code is shown once in the mint response.
CREATE TABLE IF NOT EXISTS pairing_codes (
  id           BIGSERIAL PRIMARY KEY,
  resident_id  INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  code_hash    TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK (used_at IS NULL OR (used_at >= created_at AND used_at <= expires_at))
);

CREATE INDEX IF NOT EXISTS pairing_codes_resident
  ON pairing_codes (resident_id, id);
CREATE INDEX IF NOT EXISTS pairing_codes_active_expiry
  ON pairing_codes (expires_at)
  WHERE used_at IS NULL;

-- Widen the closed oauth_rate_limits attempt_kind enum by exactly one value,
-- following the same drop-and-revalidate pattern 20260816_identity_rotation.sql
-- used for identity_rate_limits.
DO $pairing_code_attempt_kind$
DECLARE
  existing_constraint RECORD;
BEGIN
  FOR existing_constraint IN
    SELECT constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'oauth_rate_limits'::regclass
      AND constraint_row.contype = 'c'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%attempt_kind%'
  LOOP
    EXECUTE format(
      'ALTER TABLE oauth_rate_limits DROP CONSTRAINT %I',
      existing_constraint.conname
    );
  END LOOP;

  ALTER TABLE oauth_rate_limits
    ADD CONSTRAINT oauth_rate_limits_attempt_kind_allowed
    CHECK (
      attempt_kind IN (
        'authorize', 'resident_key', 'token', 'refresh', 'revoke', 'pair_mint'
      )
    ) NOT VALID;
END
$pairing_code_attempt_kind$;

ALTER TABLE oauth_rate_limits
  VALIDATE CONSTRAINT oauth_rate_limits_attempt_kind_allowed;

COMMIT;
