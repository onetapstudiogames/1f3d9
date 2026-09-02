BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Decision row 74: coding clients get a script-shaped identity door. This
-- migration is purely additive: one new table for short-lived pairing codes
-- and one closed-enum extension so pairing-code minting can share the
-- existing OAuth rate-limit machinery. Nothing here alters an existing row,
-- and it is never run against any database by this change -- the doors it
-- unblocks stay behind CODING_IDENTITY_DOORS_ENABLED (default off, see
-- index.ts) until an operator runs this migration, verifies it, and flips
-- that flag.
--
-- human_approved is enforced entirely in-process at identity-api.ts before a
-- registration is ever staged; it needs no column here. The declaration is
-- captured for audit in the confirmed registration's `register` event detail
-- (client_class, which is coding_persistent or coding_ephemeral only when the
-- JSON door required and received {"human_approved":true}) instead of a
-- schema change, so this shared live path never needs a pre-deploy migration
-- just to keep working.

-- A signed-in coding client mints a pairing code bound to its own resident,
-- at the secret hash the resident held at that moment. The hosted OAuth
-- sign-in page consumes it in place of a typed resident key. Only a hash is
-- ever stored; the raw code is shown once in the mint response.
--
-- Two independent defenses close the same hole -- a pairing code minted under
-- a since-replaced key must never resolve:
--   1. confirmRootRotation and confirmRootRecovery (identity-store.ts)
--      invalidate every unused pairing code for that resident in the same
--      transaction as the key change (invalidated_at), exactly like they
--      already do for sibling rotations and recovery codes.
--   2. Redemption also re-checks secret_hash_at_mint against the resident's
--      CURRENT secret_hash and rejects a mismatch. This is deliberately
--      redundant with (1): it still fails closed even if some future code
--      path changes a resident's key without going through those two
--      transactions.
CREATE TABLE IF NOT EXISTS pairing_codes (
  id                  BIGSERIAL PRIMARY KEY,
  resident_id         INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  code_hash           TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  secret_hash_at_mint TEXT NOT NULL CHECK (secret_hash_at_mint ~ '^[0-9a-f]{64}$'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,
  invalidated_at      TIMESTAMPTZ,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK (used_at IS NULL OR (used_at >= created_at AND used_at <= expires_at)),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at)
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
