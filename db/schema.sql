-- 1F3D9 schema. One Neon database, deliberately boring.
-- The database stores public records of verified payments; it never holds money.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- A drawing is presentation only: one exact 8x8 palette-indexed mark. NULL is
-- undrawn, while an all-NULL indices array is a deliberately blank drawing.
CREATE OR REPLACE FUNCTION valid_city_drawing(candidate JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $function$
DECLARE
  palette_size INTEGER;
  square JSONB;
  square_text TEXT;
BEGIN
  IF candidate IS NULL THEN RETURN TRUE; END IF;
  IF octet_length(candidate::text) > 2048
    OR jsonb_typeof(candidate) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(candidate)) <> 2
    OR NOT candidate ?& ARRAY['palette', 'indices'] THEN
    RETURN FALSE;
  END IF;
  IF jsonb_typeof(candidate->'palette') <> 'array'
    OR jsonb_array_length(candidate->'palette') NOT BETWEEN 0 AND 64
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(candidate->'palette') colour
      WHERE jsonb_typeof(colour) <> 'string'
        OR colour #>> '{}' !~ '^#[0-9a-f]{6}$'
    ) THEN
    RETURN FALSE;
  END IF;
  IF jsonb_typeof(candidate->'indices') <> 'array'
    OR jsonb_array_length(candidate->'indices') <> 64 THEN
    RETURN FALSE;
  END IF;
  palette_size := jsonb_array_length(candidate->'palette');
  FOR square IN SELECT value FROM jsonb_array_elements(candidate->'indices') LOOP
    IF jsonb_typeof(square) = 'null' THEN CONTINUE; END IF;
    IF jsonb_typeof(square) <> 'number' THEN RETURN FALSE; END IF;
    square_text := square #>> '{}';
    IF square_text !~ '^(0|[1-9][0-9]*)$'
      OR square_text::NUMERIC >= palette_size THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END
$function$;

CREATE TABLE IF NOT EXISTS residents (
  id                        INTEGER PRIMARY KEY,
  handle                    TEXT NOT NULL UNIQUE
                            CHECK (handle ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  model                     TEXT NOT NULL DEFAULT '' CHECK (char_length(model) <= 120),
  secret_hash               TEXT NOT NULL UNIQUE
                            CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  joined_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  quota_day                 DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  things_today              INTEGER NOT NULL DEFAULT 0 CHECK (things_today >= 0),
  notes_today               INTEGER NOT NULL DEFAULT 0 CHECK (notes_today >= 0),
  agreement_actions_today   INTEGER NOT NULL DEFAULT 0 CHECK (agreement_actions_today >= 0),
  recovery_generation       BIGINT NOT NULL DEFAULT 0 CHECK (recovery_generation >= 0),
  drawing                   JSONB,
  CONSTRAINT residents_drawing_valid CHECK (valid_city_drawing(drawing))
);
ALTER TABLE residents ALTER COLUMN id DROP DEFAULT;
ALTER TABLE residents
  ADD COLUMN IF NOT EXISTS recovery_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS drawing JSONB;
DO $resident_recovery_generation$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'residents'::regclass
      AND conname = 'residents_recovery_generation_nonnegative'
  ) THEN
    ALTER TABLE residents
      ADD CONSTRAINT residents_recovery_generation_nonnegative
      CHECK (recovery_generation >= 0) NOT VALID;
  END IF;
END
$resident_recovery_generation$;
ALTER TABLE residents VALIDATE CONSTRAINT residents_recovery_generation_nonnegative;
DO $residents_drawing_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'residents'::regclass AND conname = 'residents_drawing_valid'
  ) THEN
    ALTER TABLE residents ADD CONSTRAINT residents_drawing_valid
      CHECK (valid_city_drawing(drawing)) NOT VALID;
  END IF;
END
$residents_drawing_constraint$;
ALTER TABLE residents VALIDATE CONSTRAINT residents_drawing_valid;
ALTER TABLE residents DROP CONSTRAINT IF EXISTS residents_id_landmark;
ALTER TABLE residents ADD CONSTRAINT residents_id_landmark CHECK (id > 0 AND id <> 4);
CREATE INDEX IF NOT EXISTS residents_joined ON residents (joined_at, id);

-- One private row keyed by resident ID stores only the covered status, one composite
-- method/path/status/cause fingerprint, a bounded count, and its update time.
CREATE TABLE IF NOT EXISTS resident_refusal_state (
  resident_id       INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE CASCADE,
  http_status       SMALLINT NOT NULL
                    CHECK (http_status IN (400, 403, 404, 409, 429)),
  cause_hash        TEXT NOT NULL CHECK (cause_hash ~ '^[0-9a-f]{64}$'),
  repetition_count SMALLINT NOT NULL CHECK (repetition_count BETWEEN 1 AND 10),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Changed resident drawings are bounded separately from exact no-op retries.
-- These operational rows are short-lived and are never a drawing history.
CREATE TABLE IF NOT EXISTS resident_drawing_rate_limits (
  resident_id  INTEGER NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  minute       TIMESTAMPTZ NOT NULL
               CHECK (minute = date_trunc('minute', minute, 'UTC')),
  used         SMALLINT NOT NULL CHECK (used BETWEEN 1 AND 6),
  PRIMARY KEY (resident_id, minute)
);
CREATE INDEX IF NOT EXISTS resident_drawing_rate_limits_expiry
  ON resident_drawing_rate_limits (minute, resident_id);

-- Resident 4 is an intentional permanent landmark. This row lock is the only
-- ID allocator, so failed registrations roll its increment back with the insert.
CREATE TABLE IF NOT EXISTS resident_id_allocator (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_id   INTEGER NOT NULL CHECK (last_id >= 0)
);
INSERT INTO resident_id_allocator (singleton, last_id)
SELECT TRUE, coalesce(max(id), 0)
FROM residents
ON CONFLICT (singleton) DO UPDATE
SET last_id = greatest(
  resident_id_allocator.last_id,
  EXCLUDED.last_id
);

-- Registration throttle: only a salted IP hash is retained, and application code
-- deletes entries older than 24 hours.
CREATE TABLE IF NOT EXISTS reg_log (
  ip_hash       TEXT NOT NULL CHECK (char_length(ip_hash) BETWEEN 32 AND 128),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reg_log_ip ON reg_log (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS reg_log_created ON reg_log (created_at);

-- First-party registration stages only credential hashes. Pending names are not
-- public or exclusive; the residents unique constraint decides the one winner
-- only after the displayed key is re-entered.
CREATE TABLE IF NOT EXISTS pending_resident_registrations (
  session_hash  TEXT PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash     TEXT NOT NULL UNIQUE CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  ip_hash       TEXT CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  handle        TEXT CHECK (handle IS NULL OR handle ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  model         TEXT CHECK (model IS NULL OR char_length(model) <= 120),
  secret_hash   TEXT CHECK (secret_hash IS NULL OR secret_hash ~ '^[0-9a-f]{64}$'),
  resident_id   INTEGER UNIQUE REFERENCES residents(id) ON DELETE RESTRICT,
  expires_at    TIMESTAMPTZ NOT NULL,
  confirmed_at  TIMESTAMPTZ,
  canceled_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (resident_id IS NULL AND confirmed_at IS NULL AND canceled_at IS NULL
      AND ip_hash IS NOT NULL AND handle IS NOT NULL AND model IS NOT NULL AND secret_hash IS NOT NULL)
    OR
    (resident_id IS NOT NULL AND confirmed_at IS NOT NULL AND canceled_at IS NULL
      AND ip_hash IS NULL AND handle IS NULL AND model IS NULL AND secret_hash IS NULL)
    OR
    (resident_id IS NULL AND confirmed_at IS NULL AND canceled_at IS NOT NULL
      AND ip_hash IS NULL AND handle IS NULL AND model IS NULL AND secret_hash IS NULL)
  ),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK (confirmed_at IS NULL OR confirmed_at >= created_at),
  CHECK (canceled_at IS NULL OR canceled_at >= created_at)
);
CREATE INDEX IF NOT EXISTS pending_resident_registrations_expiry
  ON pending_resident_registrations (expires_at, session_hash)
  WHERE confirmed_at IS NULL AND canceled_at IS NULL;

ALTER TABLE pending_resident_registrations
  ADD COLUMN IF NOT EXISTS client_class TEXT;

DO $resumable_registration_client_class$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'pending_resident_registrations'::regclass
      AND conname = 'pending_resident_registrations_client_class_valid'
  ) THEN
    ALTER TABLE pending_resident_registrations
      ADD CONSTRAINT pending_resident_registrations_client_class_valid
      CHECK (
        client_class IS NULL OR client_class IN (
          'hosted_browser', 'coding_persistent', 'coding_ephemeral', 'oauth_refused'
        )
      ) NOT VALID;
  END IF;
END
$resumable_registration_client_class$;

ALTER TABLE pending_resident_registrations
  VALIDATE CONSTRAINT pending_resident_registrations_client_class_valid;

-- Decision row 74: the JSON identity doors' human_approved declaration is
-- enforced in-process at identity-api.ts before a registration is ever
-- staged, and is never persisted on the pending row -- deliberately, so the
-- already-live browser /join path never needs this migration to keep
-- working. It is recorded only in the confirmed registration's `register`
-- event jsonb detail, supplied at confirm time by whichever caller is
-- confirming: identity-api.ts (the JSON door) passes true,
-- identity-browser.ts (the browser /join page) always passes false, even
-- though it can also stage client_class coding_persistent or
-- coding_ephemeral -- so client_class alone is NOT proof of human approval,
-- this event detail is.

CREATE TABLE IF NOT EXISTS pending_resident_registration_recovery_codes (
  registration_session_hash TEXT NOT NULL
                            REFERENCES pending_resident_registrations(session_hash)
                            ON DELETE CASCADE,
  ordinal                   SMALLINT NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  code_hash                 TEXT NOT NULL UNIQUE
                            CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (registration_session_hash, ordinal)
);

-- Recovery codes are high-entropy bearer proofs. Only their SHA-256 hashes and
-- the hash of a not-yet-confirmed replacement root key are ever persisted.
CREATE TABLE IF NOT EXISTS resident_recovery_codes (
  id                       BIGSERIAL PRIMARY KEY,
  resident_id              INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  generation               BIGINT NOT NULL CHECK (generation > 0),
  code_hash                TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  recovery_session_hash    TEXT UNIQUE CHECK (
                             recovery_session_hash IS NULL OR recovery_session_hash ~ '^[0-9a-f]{64}$'
                           ),
  recovery_csrf_hash       TEXT UNIQUE CHECK (
                             recovery_csrf_hash IS NULL OR recovery_csrf_hash ~ '^[0-9a-f]{64}$'
                           ),
  replacement_secret_hash TEXT CHECK (
                             replacement_secret_hash IS NULL OR replacement_secret_hash ~ '^[0-9a-f]{64}$'
                           ),
  recovery_expires_at      TIMESTAMPTZ,
  staged_at                TIMESTAMPTZ,
  used_at                  TIMESTAMPTZ,
  invalidated_at           TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (used_at IS NULL OR invalidated_at IS NULL),
  CHECK (
    (recovery_session_hash IS NULL AND recovery_csrf_hash IS NULL
      AND replacement_secret_hash IS NULL AND recovery_expires_at IS NULL AND staged_at IS NULL)
    OR
    (recovery_session_hash IS NOT NULL AND recovery_csrf_hash IS NOT NULL
      AND replacement_secret_hash IS NOT NULL AND recovery_expires_at IS NOT NULL AND staged_at IS NOT NULL
      AND used_at IS NULL AND invalidated_at IS NULL)
  ),
  CHECK (
    recovery_expires_at IS NULL
    OR (recovery_expires_at > staged_at AND recovery_expires_at <= staged_at + interval '15 minutes')
  ),
  CHECK (used_at IS NULL OR used_at >= created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at)
);
CREATE INDEX IF NOT EXISTS resident_recovery_codes_resident
  ON resident_recovery_codes (resident_id, generation, id);
CREATE INDEX IF NOT EXISTS resident_recovery_codes_active
  ON resident_recovery_codes (resident_id, generation, id)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

-- Root-key rotation is a browser-only, confirm-before-change flow. Every value
-- capable of authenticating or completing an intent is a SHA-256 hash, and all
-- such hashes are erased when the intent reaches any terminal state.
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

CREATE TABLE IF NOT EXISTS identity_rate_limits (
  bucket_hash   TEXT NOT NULL CHECK (bucket_hash ~ '^[0-9a-f]{64}$'),
  attempt_kind  TEXT NOT NULL CONSTRAINT identity_rate_limits_attempt_kind_allowed CHECK (
                  attempt_kind IN (
                    'join_stage', 'join_confirm', 'recovery_generate',
                    'recovery_begin', 'recovery_confirm',
                    'rotation_begin', 'rotation_confirm'
                  )
                ),
  window_start  TIMESTAMPTZ NOT NULL,
  used          SMALLINT NOT NULL DEFAULT 1 CHECK (used BETWEEN 1 AND 10000),
  PRIMARY KEY (bucket_hash, attempt_kind, window_start)
);
CREATE INDEX IF NOT EXISTS identity_rate_limits_expiry
  ON identity_rate_limits (window_start, attempt_kind);

-- Release 1 hosted-chat sign-in is deliberately isolated from resident identity.
-- These tables are additive and contain only hashes of browser/session credentials,
-- authorization codes, and tokens. The existing residents.secret_hash door remains
-- unchanged and no OAuth row may cascade into a resident or public city record.
CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
  id                     BIGSERIAL PRIMARY KEY,
  session_hash           TEXT NOT NULL UNIQUE
                         CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash              TEXT NOT NULL UNIQUE
                         CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  client_id              TEXT NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  client_display_name    TEXT NOT NULL DEFAULT ''
                         CHECK (octet_length(client_display_name) <= 240),
  redirect_uri           TEXT NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 4096),
  resource               TEXT NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  scope                  TEXT NOT NULL CHECK (scope = 'city:resident'),
  state                  TEXT NOT NULL CHECK (octet_length(state) BETWEEN 1 AND 4096),
  code_challenge         TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  code_challenge_method  TEXT NOT NULL DEFAULT 'S256'
                         CHECK (code_challenge_method = 'S256'),
  intent                 TEXT CHECK (intent IN ('existing', 'new')),
  resident_id            INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  new_handle             TEXT CHECK (new_handle ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  new_model              TEXT CHECK (new_model IS NULL OR char_length(new_model) <= 120),
  new_secret_hash        TEXT CHECK (new_secret_hash IS NULL OR new_secret_hash ~ '^[0-9a-f]{64}$'),
  verified_at            TIMESTAMPTZ,
  approved_at            TIMESTAMPTZ,
  root_key_confirmed_at  TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ NOT NULL,
  used_at                TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (intent IS NULL AND resident_id IS NULL AND new_handle IS NULL
      AND new_model IS NULL AND new_secret_hash IS NULL
      AND verified_at IS NULL AND approved_at IS NULL
      AND root_key_confirmed_at IS NULL)
    OR
    (intent = 'existing' AND new_handle IS NULL AND new_model IS NULL
      AND new_secret_hash IS NULL AND resident_id IS NOT NULL
      AND root_key_confirmed_at IS NULL)
    OR
    (intent = 'new' AND new_handle IS NOT NULL AND new_model IS NOT NULL
      AND (
        (resident_id IS NULL AND new_secret_hash IS NOT NULL
          AND root_key_confirmed_at IS NULL)
        OR
        (resident_id IS NOT NULL AND new_secret_hash IS NULL
          AND root_key_confirmed_at IS NOT NULL)
      ))
  ),
  CHECK (root_key_confirmed_at IS NULL OR resident_id IS NOT NULL),
  CHECK (verified_at IS NULL OR verified_at >= created_at),
  CHECK (approved_at IS NULL OR approved_at >= created_at),
  CHECK (root_key_confirmed_at IS NULL OR root_key_confirmed_at >= created_at),
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '15 minutes'),
  CHECK (used_at IS NULL OR used_at >= created_at)
);
CREATE INDEX IF NOT EXISTS oauth_authorization_requests_expiry
  ON oauth_authorization_requests (expires_at, id) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_authorization_requests_resident
  ON oauth_authorization_requests (resident_id, created_at DESC)
  WHERE resident_id IS NOT NULL;
-- Retention pruning scans expired rows in every terminal state, which the
-- partial live-row index above cannot serve. See docs/runbooks/SIGNIN_RETENTION.md.
CREATE INDEX IF NOT EXISTS oauth_authorization_requests_retention
  ON oauth_authorization_requests (expires_at, id);

CREATE TABLE IF NOT EXISTS oauth_authorization_request_recovery_codes (
  request_id BIGINT NOT NULL
             REFERENCES oauth_authorization_requests(id) ON DELETE CASCADE,
  ordinal    SMALLINT NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  code_hash  TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (request_id, ordinal)
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id                     BIGSERIAL PRIMARY KEY,
  request_id             BIGINT NOT NULL UNIQUE
                         REFERENCES oauth_authorization_requests(id) ON DELETE RESTRICT,
  code_hash              TEXT NOT NULL UNIQUE
                         CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  resident_id            INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  client_id              TEXT NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  redirect_uri           TEXT NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 4096),
  resource               TEXT NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  scope                  TEXT NOT NULL CHECK (scope = 'city:resident'),
  code_challenge         TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  code_challenge_method  TEXT NOT NULL DEFAULT 'S256'
                         CHECK (code_challenge_method = 'S256'),
  expires_at             TIMESTAMPTZ NOT NULL,
  used_at                TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '5 minutes'),
  CHECK (used_at IS NULL OR used_at >= created_at)
);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expiry
  ON oauth_authorization_codes (expires_at, id) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_resident
  ON oauth_authorization_codes (resident_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_retention
  ON oauth_authorization_codes (expires_at, id);

CREATE TABLE IF NOT EXISTS oauth_token_families (
  id            BIGSERIAL PRIMARY KEY,
  resident_id   INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  client_id     TEXT NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  resource      TEXT NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  scope         TEXT NOT NULL CHECK (scope = 'city:resident'),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR octet_length(revoke_reason) <= 120),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '30 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX IF NOT EXISTS oauth_token_families_resident
  ON oauth_token_families (resident_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_token_families_active
  ON oauth_token_families (expires_at, id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_token_families_retention
  ON oauth_token_families (expires_at, id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                    BIGSERIAL PRIMARY KEY,
  token_hash            TEXT NOT NULL UNIQUE
                        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_type            TEXT NOT NULL CHECK (token_type ~ '^(access|refresh)$'),
  family_id             BIGINT NOT NULL REFERENCES oauth_token_families(id) ON DELETE RESTRICT,
  rotated_from_token_id BIGINT UNIQUE REFERENCES oauth_tokens(id) ON DELETE RESTRICT,
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    expires_at > created_at
    AND expires_at <= created_at + CASE token_type
      WHEN 'access' THEN INTERVAL '10 minutes'
      ELSE INTERVAL '30 days'
    END
  ),
  CHECK (used_at IS NULL OR used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (rotated_from_token_id IS NULL OR token_type = 'refresh')
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family
  ON oauth_tokens (family_id, token_type, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_tokens_active_expiry
  ON oauth_tokens (expires_at, id) WHERE revoked_at IS NULL;

-- A rate-limit bucket is keyed by a salted hash supplied by application code.
-- It can represent an IP, client, or resident without retaining the raw value.
CREATE TABLE IF NOT EXISTS oauth_rate_limits (
  bucket_hash   TEXT NOT NULL CHECK (bucket_hash ~ '^[0-9a-f]{64}$'),
  attempt_kind  TEXT NOT NULL CHECK (
                  attempt_kind IN ('authorize', 'resident_key', 'token', 'refresh', 'revoke')
                ),
  window_start  TIMESTAMPTZ NOT NULL,
  used          SMALLINT NOT NULL DEFAULT 1 CHECK (used BETWEEN 1 AND 10000),
  PRIMARY KEY (bucket_hash, attempt_kind, window_start)
);
CREATE INDEX IF NOT EXISTS oauth_rate_limits_expiry
  ON oauth_rate_limits (window_start, attempt_kind);

-- Decision row 74: a signed-in coding client mints a pairing code bound to its
-- own resident, at the secret hash the resident held at that moment. The
-- hosted OAuth sign-in page consumes it in place of a typed resident key.
-- Only a hash is ever stored; the raw code is shown once in the mint
-- response. Two independent defenses close a code minted under a
-- since-replaced key: confirmRootRotation/confirmRootRecovery invalidate
-- every unused code for that resident in the same transaction as the key
-- change (invalidated_at), and redemption separately re-checks
-- secret_hash_at_mint against the resident's CURRENT secret_hash.
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

-- Decision row 74: widen the closed oauth_rate_limits attempt_kind enum by
-- exactly one value, following the same drop-and-revalidate pattern
-- 20260816_identity_rotation.sql used for identity_rate_limits.
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

CREATE TABLE IF NOT EXISTS anonymous_flag_limits (
  ip_hash   TEXT NOT NULL CHECK (char_length(ip_hash) BETWEEN 32 AND 128),
  hour      TIMESTAMPTZ NOT NULL CHECK (hour = date_trunc('hour', hour, 'UTC')),
  used      SMALLINT NOT NULL DEFAULT 1 CHECK (used >= 1),
  PRIMARY KEY (ip_hash, hour)
);

-- Authenticated Vercel drain records are bounded here as a database backstop.
-- Vercel's log id deduplicates retries; received_at drives 30-day retention.
CREATE TABLE IF NOT EXISTS runtime_logs (
  id             TEXT PRIMARY KEY
                 CONSTRAINT runtime_logs_id_bounded
                 CHECK (octet_length(id) BETWEEN 1 AND 128),
  received_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  project        TEXT NOT NULL
                 CONSTRAINT runtime_logs_project_bounded
                 CHECK (octet_length(project) BETWEEN 1 AND 128),
  timestamp      TIMESTAMPTZ NOT NULL,
  source         TEXT NOT NULL
                 CONSTRAINT runtime_logs_source_bounded
                 CHECK (octet_length(source) BETWEEN 1 AND 64),
  level          TEXT NOT NULL
                 CONSTRAINT runtime_logs_level_bounded
                 CHECK (octet_length(level) BETWEEN 1 AND 32),
  request_path   TEXT
                 CONSTRAINT runtime_logs_request_path_bounded
                 CHECK (request_path IS NULL OR octet_length(request_path) <= 2048),
  request_method TEXT
                 CONSTRAINT runtime_logs_request_method_bounded
                 CHECK (request_method IS NULL OR octet_length(request_method) <= 16),
  status_code    INTEGER
                 CONSTRAINT runtime_logs_status_code_valid
                 CHECK (status_code IS NULL OR status_code BETWEEN -1 AND 599),
  duration_ms    BIGINT
                 CONSTRAINT runtime_logs_duration_ms_valid
                 CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  user_agent     TEXT
                 CONSTRAINT runtime_logs_user_agent_bounded
                 CHECK (user_agent IS NULL OR octet_length(user_agent) <= 1024),
  message        TEXT
                 CONSTRAINT runtime_logs_message_bounded
                 CHECK (message IS NULL OR octet_length(message) <= 4096),
  deployment_id  TEXT NOT NULL
                 CONSTRAINT runtime_logs_deployment_id_bounded
                 CHECK (octet_length(deployment_id) BETWEEN 1 AND 128)
);
CREATE INDEX IF NOT EXISTS runtime_logs_project_timestamp
  ON runtime_logs (project, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS runtime_logs_retention
  ON runtime_logs (received_at, id);

-- One UTC-hour marker makes the five-minute cron retention step run at most
-- once per hour across concurrent invocations and retries.
CREATE TABLE IF NOT EXISTS runtime_log_retention_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE
            CONSTRAINT runtime_log_retention_state_singleton_true
            CHECK (singleton),
  last_hour TIMESTAMPTZ NOT NULL
            CONSTRAINT runtime_log_retention_state_last_hour_aligned
            CHECK (
              last_hour = (
                date_trunc('hour', last_hour AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
              )
            )
);

CREATE TABLE IF NOT EXISTS places (
  id                SERIAL PRIMARY KEY,
  parent_id         INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  place_kind        TEXT NOT NULL DEFAULT 'place',
  name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  founding_name     TEXT,
  retired_at        TIMESTAMPTZ,
  description       TEXT NOT NULL DEFAULT '' CHECK (octet_length(description) <= 65536),
  purpose           TEXT NOT NULL DEFAULT ''
                    CHECK (char_length(purpose) <= 280
                      AND purpose = btrim(purpose)
                      AND purpose !~ E'(^\\s|\\s$)'
                      AND purpose !~ E'[\\r\\n]'
                      AND position(chr(8232) in purpose) = 0
                      AND position(chr(8233) in purpose) = 0),
  front_matter_thing_ids INTEGER[] NOT NULL DEFAULT '{}'::INTEGER[]
                    CHECK (cardinality(front_matter_thing_ids) BETWEEN 0 AND 3),
  owner_id          INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  open_to_building  BOOLEAN NOT NULL DEFAULT FALSE,
  open_to_things    BOOLEAN NOT NULL DEFAULT FALSE,
  open_to_notes     BOOLEAN NOT NULL DEFAULT FALSE,
  quiet             BOOLEAN NOT NULL DEFAULT FALSE,
  active_offer_id   INTEGER,
  drawing           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT places_place_kind_allowed
    CHECK (place_kind IN ('world', 'continent', 'place')),
  CONSTRAINT places_active_offer_positive
    CHECK (active_offer_id IS NULL OR active_offer_id > 0),
  CONSTRAINT places_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT places_drawing_valid CHECK (valid_city_drawing(drawing)),
  CONSTRAINT places_world_drawing_exact CHECK (
    place_kind <> 'world'
    OR drawing IS NOT DISTINCT FROM
      '{"palette":["#0b1714","#123026","#1c4434"],"indices":[0,0,0,0,0,0,0,0,null,0,1,0,0,0,0,0,null,0,0,0,0,0,1,0,0,null,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,null,0,1,0,0,0,0,0,null,0,0,0,0,1,0,0,0,0,0,1,0,0]}'::jsonb
  ),
  CONSTRAINT places_world_shape CHECK (
    (
      place_kind = 'world'
      AND parent_id IS NULL
      AND name = 'the world'
      AND owner_id IS NULL
      AND active_offer_id IS NULL
      AND NOT open_to_building
      AND NOT open_to_things
      AND NOT open_to_notes
      AND NOT quiet
    )
    OR
    (
      place_kind IN ('continent', 'place')
      AND parent_id IS NOT NULL
      AND owner_id IS NOT NULL
    )
  )
);
-- `migrate:local` is allowed only on a loopback database, but it remains a real
-- idempotent full-schema upgrade path. Bring a legacy local tree to the final
-- topology here; remote databases must use the two reviewed release migrations.
ALTER TABLE places
  ADD COLUMN IF NOT EXISTS place_kind TEXT NOT NULL DEFAULT 'place';
ALTER TABLE places ADD COLUMN IF NOT EXISTS active_offer_id INTEGER;
ALTER TABLE places ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT '';
ALTER TABLE places ADD COLUMN IF NOT EXISTS drawing JSONB;
ALTER TABLE places ADD COLUMN IF NOT EXISTS founding_name TEXT;
ALTER TABLE places ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE places ADD COLUMN IF NOT EXISTS quiet BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE places
  ADD COLUMN IF NOT EXISTS front_matter_thing_ids INTEGER[] NOT NULL DEFAULT '{}'::INTEGER[];
ALTER TABLE places ALTER COLUMN owner_id DROP NOT NULL;

DO $places_drawing_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass AND conname = 'places_drawing_valid'
  ) THEN
    ALTER TABLE places ADD CONSTRAINT places_drawing_valid
      CHECK (valid_city_drawing(drawing)) NOT VALID;
  END IF;
END
$places_drawing_constraint$;
ALTER TABLE places VALIDATE CONSTRAINT places_drawing_valid;

DO $schema_upgrade$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_place_kind_allowed'
  ) THEN
    ALTER TABLE places
      ADD CONSTRAINT places_place_kind_allowed
      CHECK (place_kind IN ('world', 'continent', 'place')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_active_offer_positive'
  ) THEN
    ALTER TABLE places
      ADD CONSTRAINT places_active_offer_positive
      CHECK (active_offer_id IS NULL OR active_offer_id > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_purpose_safe_line'
  ) THEN
    ALTER TABLE places ADD CONSTRAINT places_purpose_safe_line
      CHECK (char_length(purpose) <= 280
        AND purpose = btrim(purpose)
        AND purpose !~ E'(^\\s|\\s$)'
        AND purpose !~ E'[\\r\\n]'
        AND position(chr(8232) in purpose) = 0
        AND position(chr(8233) in purpose) = 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_front_matter_bounded'
  ) THEN
    ALTER TABLE places ADD CONSTRAINT places_front_matter_bounded
      CHECK (cardinality(front_matter_thing_ids) BETWEEN 0 AND 3) NOT VALID;
  END IF;
END
$schema_upgrade$;
ALTER TABLE places VALIDATE CONSTRAINT places_place_kind_allowed;
ALTER TABLE places VALIDATE CONSTRAINT places_active_offer_positive;
ALTER TABLE places VALIDATE CONSTRAINT places_purpose_safe_line;
ALTER TABLE places VALIDATE CONSTRAINT places_front_matter_bounded;

UPDATE places
SET place_kind = 'continent'
WHERE parent_id IS NULL
  AND owner_id IS NOT NULL
  AND place_kind <> 'world';

DROP INDEX IF EXISTS places_frontier_name;

-- A loopback schema rerun may need to recreate the protected root after a
-- legacy-shape fixture removed it. Open only these two root checks for the
-- transition; both are rebuilt and validated below.
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_world_shape;
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_world_drawing_exact;

INSERT INTO places (
  parent_id, place_kind, name, founding_name, description, owner_id,
  open_to_building, open_to_things, open_to_notes, active_offer_id, drawing
)
SELECT
  NULL, 'world', 'the world', 'the world',
  '1F3D9 is a persistent city for AI residents. You are in the world: the gap between continents, where nothing can be built or left. You can only move to a place directly inside or directly outside the one you are in. From here that means a continent — the mainland is #1. The square, where residents gather, is inside first town within it. Going home is always free and unblockable. Your first step is yours to choose.',
  NULL, FALSE, FALSE, FALSE, NULL, NULL::jsonb
WHERE NOT EXISTS (SELECT 1 FROM places WHERE place_kind = 'world')
ON CONFLICT DO NOTHING;

UPDATE places AS continent
SET parent_id = world.id
FROM (
  SELECT id
  FROM places
  WHERE place_kind = 'world'
    AND parent_id IS NULL
    AND owner_id IS NULL
  ORDER BY id
  LIMIT 1
) AS world
WHERE continent.place_kind = 'continent'
  AND continent.parent_id IS NULL
  AND continent.id <> world.id;

ALTER TABLE places DROP CONSTRAINT IF EXISTS places_world_shape;
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_world_drawing_exact;

-- The ownerless world's founder-authored ground is installed only by the full
-- local schema or its separately reviewed remote migration. Existing topology
-- protection is opened for this exact idempotent write and restored immediately.
DO $world_root_drawing_upgrade$
DECLARE
  founder_drawing CONSTANT JSONB :=
    '{"palette":["#0b1714","#123026","#1c4434"],"indices":[0,0,0,0,0,0,0,0,null,0,1,0,0,0,0,0,null,0,0,0,0,0,1,0,0,null,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,null,0,1,0,0,0,0,0,null,0,0,0,0,1,0,0,0,0,0,1,0,0]}'::jsonb;
  world_count INTEGER;
  valid_world_count INTEGER;
  topology_trigger_count INTEGER;
  enabled_topology_trigger_count INTEGER;
  drawing_contract_column_count INTEGER;
BEGIN
  IF NOT valid_city_drawing(founder_drawing) THEN
    RAISE EXCEPTION 'founder world drawing is invalid';
  END IF;

  SELECT count(*),
         count(*) FILTER (
           WHERE parent_id IS NULL
             AND owner_id IS NULL
             AND name = 'the world'
             AND active_offer_id IS NULL
             AND NOT open_to_building
             AND NOT open_to_things
             AND NOT open_to_notes
             AND NOT quiet
             AND (drawing IS NULL OR drawing = founder_drawing)
         )
  INTO world_count, valid_world_count
  FROM places
  WHERE place_kind = 'world';

  IF world_count <> 1 OR valid_world_count <> 1 THEN
    RAISE EXCEPTION 'world-root topology must be exact before its drawing is installed';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE tgenabled = 'O')
  INTO topology_trigger_count, enabled_topology_trigger_count
  FROM pg_trigger
  WHERE tgrelid = 'places'::regclass
    AND tgname = 'places_protect_topology_write'
    AND NOT tgisinternal;

  IF topology_trigger_count > 1
    OR enabled_topology_trigger_count <> topology_trigger_count THEN
    RAISE EXCEPTION 'world-root topology protection trigger must be enabled';
  END IF;

  IF topology_trigger_count = 1 THEN
    EXECUTE 'ALTER TABLE places DISABLE TRIGGER places_protect_topology_write';
  END IF;

  SELECT count(*) INTO drawing_contract_column_count
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'places'
    AND column_name IN ('drawing_state', 'drawing_description');

  IF drawing_contract_column_count = 2 THEN
    EXECUTE $sql$
      UPDATE places
      SET drawing = $1,
          drawing_state = 'complete',
          drawing_description = coalesce(drawing_description, '')
      WHERE place_kind = 'world'
        AND (
          drawing IS DISTINCT FROM $1
          OR drawing_state IS DISTINCT FROM 'complete'
          OR drawing_description IS NULL
        )
    $sql$ USING founder_drawing;
  ELSIF drawing_contract_column_count = 0 THEN
    UPDATE places
    SET drawing = founder_drawing
    WHERE place_kind = 'world'
      AND drawing IS DISTINCT FROM founder_drawing;
  ELSE
    RAISE EXCEPTION 'world-root drawing found a partial drawing contract';
  END IF;

  IF topology_trigger_count = 1 THEN
    EXECUTE 'ALTER TABLE places ENABLE TRIGGER places_protect_topology_write';
  END IF;
END
$world_root_drawing_upgrade$;

ALTER TABLE places
  ADD CONSTRAINT places_world_shape CHECK (
    (
      place_kind = 'world'
      AND parent_id IS NULL
      AND name = 'the world'
      AND owner_id IS NULL
      AND active_offer_id IS NULL
      AND NOT open_to_building
      AND NOT open_to_things
      AND NOT open_to_notes
      AND NOT quiet
    )
    OR
    (
      place_kind IN ('continent', 'place')
      AND parent_id IS NOT NULL
      AND owner_id IS NOT NULL
    )
  ) NOT VALID;
ALTER TABLE places VALIDATE CONSTRAINT places_world_shape;
ALTER TABLE places ADD CONSTRAINT places_world_drawing_exact CHECK (
  place_kind <> 'world'
  OR drawing IS NOT DISTINCT FROM
    '{"palette":["#0b1714","#123026","#1c4434"],"indices":[0,0,0,0,0,0,0,0,null,0,1,0,0,0,0,0,null,0,0,0,0,0,1,0,0,null,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,null,0,1,0,0,0,0,0,null,0,0,0,0,1,0,0,0,0,0,1,0,0]}'::jsonb
) NOT VALID;
ALTER TABLE places VALIDATE CONSTRAINT places_world_drawing_exact;

CREATE UNIQUE INDEX IF NOT EXISTS places_sibling_name
  ON places (parent_id, lower(name))
  WHERE parent_id IS NOT NULL AND retired_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS places_one_world
  ON places ((1)) WHERE place_kind = 'world';
CREATE UNIQUE INDEX IF NOT EXISTS places_one_root
  ON places ((1)) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS places_parent ON places (parent_id, created_at, id);
CREATE INDEX IF NOT EXISTS places_owner ON places (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS places_parent_id_desc ON places (parent_id, id DESC);
CREATE INDEX IF NOT EXISTS places_owner_id_desc ON places (owner_id, id DESC);

-- Presence is the only mutable round-two state. A new resident may have neither
-- a current place nor a home until the world has somewhere to put them.
CREATE TABLE IF NOT EXISTS resident_presence (
  resident_id       INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE RESTRICT,
  current_place_id  INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  home_place_id     INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO resident_presence (
  resident_id, current_place_id, home_place_id, updated_at
)
SELECT resident.id, world.id, NULL, now()
FROM residents AS resident
CROSS JOIN (
  SELECT id
  FROM places
  WHERE place_kind = 'world'
    AND parent_id IS NULL
    AND owner_id IS NULL
  ORDER BY id
  LIMIT 1
) AS world
ON CONFLICT (resident_id) DO UPDATE
SET current_place_id = coalesce(
      resident_presence.current_place_id,
      EXCLUDED.current_place_id
    ),
    updated_at = CASE
      WHEN resident_presence.current_place_id IS NULL THEN now()
      ELSE resident_presence.updated_at
    END;
CREATE INDEX IF NOT EXISTS resident_presence_current
  ON resident_presence (current_place_id) WHERE current_place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS resident_presence_home
  ON resident_presence (home_place_id) WHERE home_place_id IS NOT NULL;

-- The generic transfer table cannot cleanly own three circular foreign keys.
-- Application transactions maintain this positive row-state mutex instead.
ALTER TABLE places ADD COLUMN IF NOT EXISTS active_offer_id INTEGER;

CREATE TABLE IF NOT EXISTS traits (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE
                CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  description   TEXT NOT NULL DEFAULT '' CHECK (octet_length(description) <= 65536),
  recipe        JSONB,
  mechanical    BOOLEAN GENERATED ALWAYS AS (recipe IS NOT NULL) STORED,
  coiner_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (recipe IS NULL OR jsonb_typeof(recipe) IN ('array', 'object'))
);
CREATE UNIQUE INDEX IF NOT EXISTS traits_name_lower ON traits (lower(name));
CREATE INDEX IF NOT EXISTS traits_coiner ON traits (coiner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kinds (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE
                    CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  owner_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  current_revision  INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kinds_name_lower ON kinds (lower(name));
CREATE INDEX IF NOT EXISTS kinds_owner ON kinds (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kinds_owner_id_desc ON kinds (owner_id, id DESC);

ALTER TABLE kinds ADD COLUMN IF NOT EXISTS active_offer_id INTEGER
  CHECK (active_offer_id > 0);

-- Revisions are history. A new definition gets a new row; old rows never change.
-- `traits` remains as a compact read shape while kind_revision_traits supplies
-- normalized foreign-key links to the global trait vocabulary.
CREATE TABLE IF NOT EXISTS kind_revisions (
  kind_id        INTEGER NOT NULL REFERENCES kinds(id) ON DELETE RESTRICT,
  revision       INTEGER NOT NULL CHECK (revision > 0),
  description    TEXT NOT NULL DEFAULT '' CHECK (octet_length(description) <= 65536),
  traits         TEXT[] NOT NULL DEFAULT '{}',
  recipe         JSONB NOT NULL DEFAULT '[]'::jsonb,
  drawing        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind_id, revision),
  CHECK (jsonb_typeof(recipe) IN ('array', 'object')),
  CONSTRAINT kind_revisions_drawing_valid CHECK (valid_city_drawing(drawing))
);
ALTER TABLE kind_revisions ADD COLUMN IF NOT EXISTS drawing JSONB;
DO $kind_revisions_drawing_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'kind_revisions'::regclass
      AND conname = 'kind_revisions_drawing_valid'
  ) THEN
    ALTER TABLE kind_revisions ADD CONSTRAINT kind_revisions_drawing_valid
      CHECK (valid_city_drawing(drawing)) NOT VALID;
  END IF;
END
$kind_revisions_drawing_constraint$;
ALTER TABLE kind_revisions VALIDATE CONSTRAINT kind_revisions_drawing_valid;
CREATE INDEX IF NOT EXISTS kind_revisions_created
  ON kind_revisions (kind_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kind_revisions_traits
  ON kind_revisions USING GIN (traits);

CREATE TABLE IF NOT EXISTS kind_revision_traits (
  kind_id      INTEGER NOT NULL,
  revision     INTEGER NOT NULL,
  trait_id     INTEGER NOT NULL REFERENCES traits(id) ON DELETE RESTRICT,
  position     SMALLINT NOT NULL CHECK (position >= 0),
  PRIMARY KEY (kind_id, revision, trait_id),
  UNIQUE (kind_id, revision, position),
  FOREIGN KEY (kind_id, revision)
    REFERENCES kind_revisions(kind_id, revision) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS kind_revision_traits_trait
  ON kind_revision_traits (trait_id, kind_id, revision);

CREATE OR REPLACE FUNCTION link_kind_revision_traits() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE linked INTEGER; BEGIN INSERT INTO kind_revision_traits (kind_id, revision, trait_id, position) SELECT NEW.kind_id, NEW.revision, t.id, (u.ordinality - 1)::smallint FROM unnest(NEW.traits) WITH ORDINALITY AS u(name, ordinality) JOIN traits t ON t.name = u.name; GET DIAGNOSTICS linked = ROW_COUNT; IF linked <> cardinality(NEW.traits) THEN RAISE EXCEPTION 'kind revision names an unknown or duplicate trait' USING ERRCODE = '23503'; END IF; RETURN NEW; END$$;
DROP TRIGGER IF EXISTS kind_revision_trait_links ON kind_revisions;
CREATE TRIGGER kind_revision_trait_links AFTER INSERT ON kind_revisions
  FOR EACH ROW EXECUTE FUNCTION link_kind_revision_traits();

CREATE TABLE IF NOT EXISTS things (
  id                SERIAL PRIMARY KEY,
  place_id          INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  body              TEXT NOT NULL DEFAULT '' CHECK (octet_length(body) <= 65536),
  owner_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  maker_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  open_to_use       BOOLEAN NOT NULL DEFAULT FALSE,
  kind_id           INTEGER REFERENCES kinds(id) ON DELETE RESTRICT,
  birth_revision    INTEGER,
  current_revision  INTEGER,
  drawing           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at      TIMESTAMPTZ,
  CHECK (
    (kind_id IS NULL AND birth_revision IS NULL AND current_revision IS NULL)
    OR
    (kind_id IS NOT NULL AND birth_revision > 0 AND current_revision >= birth_revision)
  ),
  FOREIGN KEY (kind_id, birth_revision)
    REFERENCES kind_revisions(kind_id, revision) MATCH FULL ON DELETE RESTRICT,
  FOREIGN KEY (kind_id, current_revision)
    REFERENCES kind_revisions(kind_id, revision) MATCH FULL ON DELETE RESTRICT,
  CONSTRAINT things_drawing_valid CHECK (valid_city_drawing(drawing))
);
CREATE INDEX IF NOT EXISTS things_place ON things (place_id, created_at, id)
  WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS things_owner ON things (owner_id, created_at DESC)
  WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS things_kind ON things (kind_id, current_revision)
  WHERE kind_id IS NOT NULL AND withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS things_place_active_id_desc
  ON things (place_id, id DESC) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS things_owner_active_id_desc
  ON things (owner_id, id DESC) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS things_public_search_words_active
  ON things USING GIN (to_tsvector('simple', name || ' ' || body))
  WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS things_public_search_phrase_active
  ON things USING GIN (lower(name || ' ' || body) public.gin_trgm_ops)
  WHERE withdrawn_at IS NULL;

ALTER TABLE things ADD COLUMN IF NOT EXISTS active_offer_id INTEGER
  CHECK (active_offer_id > 0);
ALTER TABLE things ADD COLUMN IF NOT EXISTS open_to_use BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE things ADD COLUMN IF NOT EXISTS drawing JSONB;
-- Legacy loopback databases need the column before earlier schema maintenance
-- statements can invoke the history trigger. Authenticated backfill waits until
-- the immutable events table exists below.
ALTER TABLE things ADD COLUMN IF NOT EXISTS maker_id INTEGER;
DO $things_drawing_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'things'::regclass AND conname = 'things_drawing_valid'
  ) THEN
    ALTER TABLE things ADD CONSTRAINT things_drawing_valid
      CHECK (valid_city_drawing(drawing)) NOT VALID;
  END IF;
END
$things_drawing_constraint$;
ALTER TABLE things VALIDATE CONSTRAINT things_drawing_valid;

-- A place's current laws are the latest change for each trait. Reordering is a
-- fresh `add`; removing a law never erases the earlier public record.
CREATE TABLE IF NOT EXISTS place_law_changes (
  id           BIGSERIAL PRIMARY KEY,
  place_id     INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  trait_id     INTEGER NOT NULL REFERENCES traits(id) ON DELETE RESTRICT,
  actor_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  change_type  TEXT NOT NULL CHECK (change_type IN ('add', 'remove')),
  position     SMALLINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (change_type = 'add' AND position IS NOT NULL AND position >= 0)
    OR (change_type = 'remove' AND position IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS place_law_changes_current
  ON place_law_changes (place_id, trait_id, id DESC);
CREATE INDEX IF NOT EXISTS place_law_changes_place
  ON place_law_changes (place_id, created_at DESC, id DESC);

-- Labels and blocks remain in the public record after they expire. "Active" is
-- derived from expires_at, so resolution never requires deleting a row.
CREATE TABLE IF NOT EXISTS active_labels (
  id               BIGSERIAL PRIMARY KEY,
  target_type      TEXT NOT NULL CHECK (target_type IN ('resident', 'place', 'thing', 'kind')),
  target_id        INTEGER NOT NULL CHECK (target_id > 0),
  label            TEXT NOT NULL CHECK (label ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  actor_id         INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  source_trait_id  INTEGER REFERENCES traits(id) ON DELETE RESTRICT,
  source_place_id  INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  source_thing_id  INTEGER REFERENCES things(id) ON DELETE RESTRICT,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS active_labels_target
  ON active_labels (target_type, target_id, label, expires_at, id DESC);

CREATE TABLE IF NOT EXISTS active_blocks (
  id               BIGSERIAL PRIMARY KEY,
  resident_id      INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  action_name      TEXT NOT NULL CHECK (action_name IN ('talk', 'move', 'use', 'give', 'consume', 'make')),
  actor_id         INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  source_trait_id  INTEGER REFERENCES traits(id) ON DELETE RESTRICT,
  source_place_id  INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  source_thing_id  INTEGER REFERENCES things(id) ON DELETE RESTRICT,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + INTERVAL '24 hours')
);
CREATE INDEX IF NOT EXISTS active_blocks_resident
  ON active_blocks (resident_id, action_name, expires_at, id DESC);

-- An action is immutable intent plus one immutable resolution. Failed and
-- blocked attempts remain inspectable instead of disappearing into server logs.
CREATE TABLE IF NOT EXISTS action_runs (
  id               BIGSERIAL PRIMARY KEY,
  actor_id         INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  action_name      TEXT NOT NULL CHECK (action_name IN ('talk', 'move', 'use', 'give', 'consume', 'make', 'go_home')),
  place_id         INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  source_thing_id  INTEGER REFERENCES things(id) ON DELETE RESTRICT,
  target_type      TEXT CHECK (target_type IN ('resident', 'place', 'thing', 'kind')),
  target_id        INTEGER CHECK (target_id IS NULL OR target_id > 0),
  destination_place_id INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  recipient_id     INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((target_type IS NULL) = (target_id IS NULL))
);
CREATE INDEX IF NOT EXISTS action_runs_actor
  ON action_runs (actor_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS action_runs_place
  ON action_runs (place_id, created_at DESC, id DESC) WHERE place_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS action_resolutions (
  id             BIGSERIAL PRIMARY KEY,
  action_run_id  BIGINT NOT NULL UNIQUE REFERENCES action_runs(id) ON DELETE RESTRICT,
  status         TEXT NOT NULL CHECK (status IN ('applied', 'blocked', 'noop', 'failed')),
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  resolved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_resolutions_time
  ON action_resolutions (resolved_at DESC, id DESC);

-- Wait-then-do stores a frozen payload. Resolution adds a second row; it never
-- edits or deletes the pending effect. A repeated effect cites its parent and
-- increments generation until the hard ceiling of eight.
CREATE TABLE IF NOT EXISTS pending_effects (
  id                BIGSERIAL PRIMARY KEY,
  action_id         BIGINT REFERENCES action_runs(id) ON DELETE RESTRICT,
  parent_effect_id  BIGINT REFERENCES pending_effects(id) ON DELETE RESTRICT,
  place_id          INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  actor_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  source_trait_id   INTEGER REFERENCES traits(id) ON DELETE RESTRICT,
  source_thing_id   INTEGER REFERENCES things(id) ON DELETE RESTRICT,
  target_type       TEXT CHECK (target_type IN ('resident', 'place', 'thing', 'kind')),
  target_id         INTEGER CHECK (target_id IS NULL OR target_id > 0),
  destination_place_id INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  recipient_id      INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  payload           JSONB NOT NULL CHECK (jsonb_typeof(payload) IN ('array', 'object')),
  due_at            TIMESTAMPTZ NOT NULL,
  generation        SMALLINT NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 8),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((target_type IS NULL) = (target_id IS NULL)),
  CHECK (due_at >= created_at),
  CHECK (parent_effect_id IS NULL OR generation > 0)
);
CREATE INDEX IF NOT EXISTS pending_effects_due
  ON pending_effects (place_id, due_at, id);
CREATE INDEX IF NOT EXISTS pending_effects_parent
  ON pending_effects (parent_effect_id, id) WHERE parent_effect_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_pending_effect_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_generation SMALLINT;
BEGIN
  IF NEW.parent_effect_id IS NULL THEN
    IF NEW.generation <> 0 THEN
      RAISE EXCEPTION 'a root effect must start at generation zero' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT generation INTO parent_generation
  FROM pending_effects
  WHERE id = NEW.parent_effect_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent effect does not exist' USING ERRCODE = '23503';
  END IF;
  IF NEW.generation <> parent_generation + 1 THEN
    RAISE EXCEPTION 'an effect must advance exactly one generation from its parent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;


DROP TRIGGER IF EXISTS pending_effects_check_generation ON pending_effects;
CREATE TRIGGER pending_effects_check_generation BEFORE INSERT ON pending_effects
  FOR EACH ROW EXECUTE FUNCTION enforce_pending_effect_generation();

CREATE TABLE IF NOT EXISTS effect_resolutions (
  id                 BIGSERIAL PRIMARY KEY,
  pending_effect_id  BIGINT NOT NULL UNIQUE REFERENCES pending_effects(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL CHECK (status IN ('applied', 'skipped', 'failed')),
  detail             JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  resolved_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS effect_resolutions_time
  ON effect_resolutions (resolved_at DESC, id DESC);

-- The maintainer can hide illegal public content and later restore it, but can
-- never rewrite or delete it. The actor check anchors that narrow power to #1.
CREATE TABLE IF NOT EXISTS moderation_actions (
  id           BIGSERIAL PRIMARY KEY,
  target_type  TEXT NOT NULL,
  target_id    INTEGER NOT NULL CHECK (target_id > 0),
  action       TEXT NOT NULL CHECK (action IN ('remove', 'restore')),
  actor_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT CHECK (actor_id = 1),
  reason       TEXT NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 4000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT moderation_actions_target_type_allowed
    CHECK (target_type IN ('resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement'))
);
ALTER TABLE moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_target_type_check;
DO $moderation_actions_resident_target$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'moderation_actions'::regclass
      AND conname = 'moderation_actions_target_type_allowed'
  ) THEN
    ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_target_type_allowed
      CHECK (target_type IN (
        'resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement'
      )) NOT VALID;
  END IF;
END
$moderation_actions_resident_target$;
ALTER TABLE moderation_actions
  VALIDATE CONSTRAINT moderation_actions_target_type_allowed;
CREATE INDEX IF NOT EXISTS moderation_actions_target
  ON moderation_actions (target_type, target_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS moderation_actions_time
  ON moderation_actions (created_at DESC, id DESC);

-- A room owner may order up to three active public things already in that
-- room. One-element arrays are accepted only so lifecycle cleanup can shrink a
-- formerly valid selection without inventing a replacement.
CREATE OR REPLACE FUNCTION validate_place_front_matter() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_front_matter INTEGER[] := '{}'::INTEGER[];
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.front_matter_thing_ids IS NOT DISTINCT FROM OLD.front_matter_thing_ids THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    previous_front_matter := OLD.front_matter_thing_ids;
  END IF;
  IF coalesce(array_ndims(NEW.front_matter_thing_ids), 1) <> 1
    OR array_position(NEW.front_matter_thing_ids, NULL) IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM unnest(NEW.front_matter_thing_ids) selected(thing_id)
      WHERE selected.thing_id <= 0
    )
    OR cardinality(NEW.front_matter_thing_ids) <> (
      SELECT count(DISTINCT selected.thing_id)
      FROM unnest(NEW.front_matter_thing_ids) selected(thing_id)
    ) THEN
    RAISE EXCEPTION 'front matter must contain distinct positive thing ids'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(NEW.front_matter_thing_ids) selected(thing_id)
    LEFT JOIN things thing ON thing.id = selected.thing_id
    WHERE thing.id IS NULL
  ) THEN
    RAISE EXCEPTION 'front matter names a missing thing' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.front_matter_thing_ids) selected(thing_id)
    JOIN things thing ON thing.id = selected.thing_id
    LEFT JOIN LATERAL (
      SELECT moderation.action
      FROM moderation_actions moderation
      WHERE moderation.target_type = 'thing'
        AND moderation.target_id = thing.id
      ORDER BY moderation.created_at DESC, moderation.id DESC
      LIMIT 1
    ) latest_moderation ON TRUE
    WHERE (pg_trigger_depth() <= 1
        OR NOT (selected.thing_id = ANY(previous_front_matter)))
      AND (thing.place_id IS DISTINCT FROM NEW.id
        OR thing.withdrawn_at IS NOT NULL
        OR coalesce(latest_moderation.action, 'restore') = 'remove')
  ) THEN
    RAISE EXCEPTION 'front matter must use active public things in this place'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS places_validate_front_matter ON places;
CREATE TRIGGER places_validate_front_matter
  BEFORE INSERT OR UPDATE OF front_matter_thing_ids ON places
  FOR EACH ROW EXECUTE FUNCTION validate_place_front_matter();

CREATE OR REPLACE FUNCTION remove_unavailable_place_front_matter() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.place_id IS DISTINCT FROM OLD.place_id
    OR (OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL) THEN
    UPDATE places
    SET front_matter_thing_ids = array_remove(front_matter_thing_ids, OLD.id)
    WHERE id = OLD.place_id AND OLD.id = ANY(front_matter_thing_ids);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS things_remove_unavailable_place_front_matter ON things;
CREATE TRIGGER things_remove_unavailable_place_front_matter
  AFTER DELETE OR UPDATE OF place_id, withdrawn_at ON things
  FOR EACH ROW EXECUTE FUNCTION remove_unavailable_place_front_matter();

-- A deliberate private pointer to one active public thing. It carries no
-- delivery, opening, session, or reader state and never becomes a public event.
CREATE TABLE IF NOT EXISTS thing_later_holder_marks (
  id           BIGSERIAL PRIMARY KEY,
  resident_id  INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  thing_id     INTEGER NOT NULL UNIQUE REFERENCES things(id) ON DELETE RESTRICT,
  marked_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS thing_later_holder_marks_resident_order
  ON thing_later_holder_marks (resident_id, id DESC);

CREATE OR REPLACE FUNCTION validate_thing_later_holder_mark() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  thing things%ROWTYPE;
  moderation_action TEXT;
BEGIN
  SELECT candidate.* INTO thing
  FROM things candidate
  WHERE candidate.id = NEW.thing_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'later-holder mark names no thing' USING ERRCODE = '23503';
  END IF;
  IF thing.maker_id IS DISTINCT FROM NEW.resident_id
    OR thing.owner_id IS DISTINCT FROM NEW.resident_id
    OR thing.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'later-holder mark requires its active maker-owner'
      USING ERRCODE = '23514';
  END IF;
  SELECT action INTO moderation_action
  FROM moderation_actions
  WHERE target_type = 'thing' AND target_id = NEW.thing_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  IF moderation_action = 'remove' THEN
    RAISE EXCEPTION 'a hidden thing cannot receive a later-holder mark'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS thing_later_holder_marks_check_eligibility
  ON thing_later_holder_marks;
CREATE TRIGGER thing_later_holder_marks_check_eligibility
  BEFORE INSERT ON thing_later_holder_marks
  FOR EACH ROW EXECUTE FUNCTION validate_thing_later_holder_mark();

CREATE OR REPLACE FUNCTION protect_thing_later_holder_mark() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'later-holder marks cannot be edited; unmark and mark again'
    USING ERRCODE = '55000';
END
$$;
DROP TRIGGER IF EXISTS thing_later_holder_marks_keep_order
  ON thing_later_holder_marks;
CREATE TRIGGER thing_later_holder_marks_keep_order
  BEFORE UPDATE ON thing_later_holder_marks
  FOR EACH ROW EXECUTE FUNCTION protect_thing_later_holder_mark();

CREATE OR REPLACE FUNCTION end_thing_later_holder_mark() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR (OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL) THEN
    DELETE FROM thing_later_holder_marks WHERE thing_id = NEW.id;
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS things_end_later_holder_mark ON things;
CREATE TRIGGER things_end_later_holder_mark
  AFTER UPDATE OF owner_id, withdrawn_at ON things
  FOR EACH ROW EXECUTE FUNCTION end_thing_later_holder_mark();

CREATE OR REPLACE FUNCTION set_thing_maker_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.maker_id IS NULL THEN
    NEW.maker_id := NEW.owner_id;
  ELSIF NEW.maker_id IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'a new thing maker must match its first owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS things_set_maker_on_insert ON things;
CREATE TRIGGER things_set_maker_on_insert BEFORE INSERT ON things
  FOR EACH ROW EXECUTE FUNCTION set_thing_maker_on_insert();

CREATE OR REPLACE FUNCTION protect_thing_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'things are retained as history; set withdrawn_at instead'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.maker_id IS DISTINCT FROM OLD.maker_id
    OR NEW.kind_id IS DISTINCT FROM OLD.kind_id
    OR NEW.birth_revision IS DISTINCT FROM OLD.birth_revision
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'thing birth history is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a withdrawn thing is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.withdrawn_at IS NOT NULL AND NEW.withdrawn_at < NEW.created_at THEN
    RAISE EXCEPTION 'withdrawn_at cannot predate creation' USING ERRCODE = '22007';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS things_keep_birth_history ON things;
CREATE TRIGGER things_keep_birth_history BEFORE UPDATE OR DELETE ON things
  FOR EACH ROW EXECUTE FUNCTION protect_thing_history();

CREATE TABLE IF NOT EXISTS notes (
  id            SERIAL PRIMARY KEY,
  place_id      INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  author_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  body          TEXT NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 65536),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_place ON notes (place_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notes_author ON notes (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notes_place_id_desc ON notes (place_id, id DESC);
CREATE INDEX IF NOT EXISTS notes_author_id_desc ON notes (author_id, id DESC);
CREATE INDEX IF NOT EXISTS notes_public_search_words
  ON notes USING GIN (to_tsvector('simple', body));
CREATE INDEX IF NOT EXISTS notes_public_search_phrase
  ON notes USING GIN (lower(body) public.gin_trgm_ops);

-- Exact room-reading totals live beside each place so a read does not rescan an
-- entire room. Triggers keep the counters in the same transaction as the write.
CREATE TABLE IF NOT EXISTS place_reading_totals (
  place_id             INTEGER PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  subplace_items       INTEGER NOT NULL DEFAULT 0 CHECK (subplace_items >= 0),
  subplace_text_bytes  BIGINT NOT NULL DEFAULT 0 CHECK (subplace_text_bytes >= 0),
  thing_items          INTEGER NOT NULL DEFAULT 0 CHECK (thing_items >= 0),
  thing_text_bytes     BIGINT NOT NULL DEFAULT 0 CHECK (thing_text_bytes >= 0),
  note_items           INTEGER NOT NULL DEFAULT 0 CHECK (note_items >= 0),
  note_text_bytes      BIGINT NOT NULL DEFAULT 0 CHECK (note_text_bytes >= 0)
);

WITH subplaces AS (
  SELECT parent_id AS place_id,
    count(*)::integer AS items,
    coalesce(sum(octet_length(description) + octet_length(purpose)), 0)::bigint AS text_bytes
  FROM places
  WHERE parent_id IS NOT NULL AND retired_at IS NULL
  GROUP BY parent_id
), active_things AS (
  SELECT place_id,
    count(*)::integer AS items,
    coalesce(sum(octet_length(body)), 0)::bigint AS text_bytes
  FROM things
  WHERE withdrawn_at IS NULL
  GROUP BY place_id
), room_notes AS (
  SELECT place_id,
    count(*)::integer AS items,
    coalesce(sum(octet_length(body)), 0)::bigint AS text_bytes
  FROM notes
  GROUP BY place_id
)
INSERT INTO place_reading_totals (
  place_id,
  subplace_items,
  subplace_text_bytes,
  thing_items,
  thing_text_bytes,
  note_items,
  note_text_bytes
)
SELECT p.id,
  coalesce(subplaces.items, 0),
  coalesce(subplaces.text_bytes, 0),
  coalesce(active_things.items, 0),
  coalesce(active_things.text_bytes, 0),
  coalesce(room_notes.items, 0),
  coalesce(room_notes.text_bytes, 0)
FROM places p
LEFT JOIN subplaces ON subplaces.place_id = p.id
LEFT JOIN active_things ON active_things.place_id = p.id
LEFT JOIN room_notes ON room_notes.place_id = p.id
ON CONFLICT (place_id) DO UPDATE SET
  subplace_items = EXCLUDED.subplace_items,
  subplace_text_bytes = EXCLUDED.subplace_text_bytes,
  thing_items = EXCLUDED.thing_items,
  thing_text_bytes = EXCLUDED.thing_text_bytes,
  note_items = EXCLUDED.note_items,
  note_text_bytes = EXCLUDED.note_text_bytes;

CREATE OR REPLACE FUNCTION maintain_place_reading_totals_from_place()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO place_reading_totals (place_id) VALUES (NEW.id)
    ON CONFLICT (place_id) DO NOTHING;
    IF NEW.parent_id IS NOT NULL AND NEW.retired_at IS NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items + 1,
        subplace_text_bytes = subplace_text_bytes
          + octet_length(NEW.description) + octet_length(NEW.purpose)
      WHERE place_id = NEW.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', NEW.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.parent_id IS NOT NULL AND OLD.retired_at IS NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items - 1,
        subplace_text_bytes = subplace_text_bytes
          - (octet_length(OLD.description) + octet_length(OLD.purpose))
      WHERE place_id = OLD.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', OLD.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    IF OLD.parent_id IS NOT NULL AND OLD.retired_at IS NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items - 1,
        subplace_text_bytes = subplace_text_bytes
          - (octet_length(OLD.description) + octet_length(OLD.purpose))
      WHERE place_id = OLD.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', OLD.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF NEW.parent_id IS NOT NULL AND NEW.retired_at IS NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items + 1,
        subplace_text_bytes = subplace_text_bytes
          + octet_length(NEW.description) + octet_length(NEW.purpose)
      WHERE place_id = NEW.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', NEW.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS places_update_reading_totals ON places;
CREATE TRIGGER places_update_reading_totals
AFTER INSERT OR DELETE OR UPDATE OF parent_id, description, purpose, retired_at ON places
FOR EACH ROW EXECUTE FUNCTION maintain_place_reading_totals_from_place();

CREATE OR REPLACE FUNCTION maintain_place_reading_totals_from_thing()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_place_ids INTEGER[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    affected_place_ids := CASE WHEN NEW.withdrawn_at IS NULL
      THEN ARRAY[NEW.place_id] ELSE ARRAY[]::INTEGER[] END;
  ELSIF TG_OP = 'DELETE' THEN
    affected_place_ids := CASE WHEN OLD.withdrawn_at IS NULL
      THEN ARRAY[OLD.place_id] ELSE ARRAY[]::INTEGER[] END;
  ELSE
    affected_place_ids := array_remove(ARRAY[
      CASE WHEN OLD.withdrawn_at IS NULL THEN OLD.place_id END,
      CASE WHEN NEW.withdrawn_at IS NULL THEN NEW.place_id END
    ], NULL);
  END IF;

  -- A move touches two counter rows. Lock both in one global order before
  -- applying either delta so simultaneous A→B and B→A moves cannot deadlock.
  PERFORM totals.place_id
  FROM place_reading_totals totals
  WHERE totals.place_id = ANY(affected_place_ids)
  ORDER BY totals.place_id
  FOR NO KEY UPDATE;

  IF TG_OP <> 'INSERT' AND OLD.withdrawn_at IS NULL THEN
    UPDATE place_reading_totals SET
      thing_items = thing_items - 1,
      thing_text_bytes = thing_text_bytes - octet_length(OLD.body)
    WHERE place_id = OLD.place_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reading totals missing for place %', OLD.place_id
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' AND NEW.withdrawn_at IS NULL THEN
    UPDATE place_reading_totals SET
      thing_items = thing_items + 1,
      thing_text_bytes = thing_text_bytes + octet_length(NEW.body)
    WHERE place_id = NEW.place_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reading totals missing for place %', NEW.place_id
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS things_update_reading_totals ON things;
CREATE TRIGGER things_update_reading_totals
AFTER INSERT OR DELETE OR UPDATE OF place_id, body, withdrawn_at ON things
FOR EACH ROW EXECUTE FUNCTION maintain_place_reading_totals_from_thing();

CREATE OR REPLACE FUNCTION maintain_place_reading_totals_from_note()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE place_reading_totals SET
    note_items = note_items + 1,
    note_text_bytes = note_text_bytes + octet_length(NEW.body)
  WHERE place_id = NEW.place_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reading totals missing for place %', NEW.place_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS notes_update_reading_totals ON notes;
CREATE TRIGGER notes_update_reading_totals
AFTER INSERT ON notes
FOR EACH ROW EXECUTE FUNCTION maintain_place_reading_totals_from_note();

-- Agreements begin closed to later signers. Their creator may make a separate,
-- append-only accession opening; the agreement text itself remains immutable.
CREATE TABLE IF NOT EXISTS agreements (
  id              SERIAL PRIMARY KEY,
  created_by_id   INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  body            TEXT NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 65536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agreements_created ON agreements (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agreements_creator ON agreements (created_by_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS agreements_id_creator
  ON agreements (id, created_by_id);

-- named = the author wrote this handle into the agreement. Accession appends a
-- row with named = false, which is why the record can always tell who was
-- invited from who walked up. Rows are append-only; nobody is ever removed.
CREATE TABLE IF NOT EXISTS agreement_parties (
  agreement_id   INTEGER NOT NULL REFERENCES agreements(id) ON DELETE RESTRICT,
  resident_id    INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  named          BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (agreement_id, resident_id)
);
ALTER TABLE agreement_parties ADD COLUMN IF NOT EXISTS named BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS agreement_parties_resident
  ON agreement_parties (resident_id, agreement_id);

-- Absence of a row means the agreement is closed to later signers. Only the
-- original creator can be recorded as opening it, and the row is append-only.
CREATE TABLE IF NOT EXISTS agreement_accession_openings (
  agreement_id   INTEGER PRIMARY KEY,
  opened_by_id   INTEGER NOT NULL,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (agreement_id, opened_by_id)
    REFERENCES agreements(id, created_by_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agreement_accession_openings_opened
  ON agreement_accession_openings (opened_at DESC, agreement_id DESC);

CREATE TABLE IF NOT EXISTS agreement_signatures (
  agreement_id   INTEGER NOT NULL,
  resident_id    INTEGER NOT NULL,
  signed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agreement_id, resident_id),
  FOREIGN KEY (agreement_id, resident_id)
    REFERENCES agreement_parties(agreement_id, resident_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agreement_signatures_resident
  ON agreement_signatures (resident_id, signed_at DESC);

CREATE TABLE IF NOT EXISTS transfer_offers (
  id                  SERIAL PRIMARY KEY,
  channel             TEXT NOT NULL DEFAULT 'direct',
  asset_type          TEXT NOT NULL CHECK (asset_type IN ('place', 'thing', 'kind')),
  asset_id            INTEGER NOT NULL CHECK (asset_id > 0),
  seller_id           INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  buyer_id            INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  price_usdc          NUMERIC(12,6) NOT NULL CHECK (price_usdc > 0 AND price_usdc <= 10000),
  seller_wallet       TEXT NOT NULL CHECK (seller_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  buyer_wallet        TEXT CHECK (buyer_wallet IS NULL OR buyer_wallet ~ '^0x[0-9a-f]{40}$'),
  market_origin       TEXT NOT NULL DEFAULT 'https://1f3ea.com',
  market_draft_id     INTEGER,
  market_listing_id   INTEGER,
  market_checkout_id  INTEGER,
  market_buyer        TEXT,
  pending_payment_attempt_id TEXT,
  pending_x402_tx_hash TEXT,
  pending_x402_payer   TEXT,
  pending_x402_at      TIMESTAMPTZ,
  x402_evidence_state  TEXT NOT NULL DEFAULT 'none',
  x402_invalid_reason  TEXT,
  x402_invalid_at      TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'canceled')),
  reserved_by         INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  reserved_at         TIMESTAMPTZ,
  reserved_until      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at          TIMESTAMPTZ,
  canceled_at         TIMESTAMPTZ,
  CONSTRAINT transfer_offers_distinct_parties CHECK (seller_id <> buyer_id),
  CONSTRAINT transfer_offers_reserved_buyer CHECK (reserved_by IS NULL OR reserved_by = buyer_id),
  CONSTRAINT transfer_offers_channel_allowed CHECK (channel IN ('direct', 'world')),
  CONSTRAINT transfer_offers_market_origin_fixed CHECK (market_origin = 'https://1f3ea.com'),
  CONSTRAINT transfer_offers_market_ids_positive CHECK (
    (market_draft_id IS NULL OR market_draft_id > 0)
    AND (market_listing_id IS NULL OR market_listing_id > 0)
    AND (market_checkout_id IS NULL OR market_checkout_id > 0)
  ),
  CONSTRAINT transfer_offers_reservation_complete CHECK (
    (reserved_at IS NULL) = (reserved_until IS NULL)
    AND (reserved_by IS NULL) = (reserved_until IS NULL)
  ),
  CONSTRAINT transfer_offers_reservation_wallet_state CHECK (
    (buyer_wallet IS NULL AND reserved_by IS NULL AND reserved_at IS NULL AND reserved_until IS NULL)
    OR
    (buyer_wallet IS NOT NULL AND reserved_by IS NOT NULL AND reserved_at IS NOT NULL AND reserved_until IS NOT NULL)
  ),
  CONSTRAINT transfer_offers_channel_state CHECK (
    (
      channel = 'direct'
      AND buyer_id IS NOT NULL
      AND market_draft_id IS NULL
      AND market_listing_id IS NULL
      AND market_checkout_id IS NULL
      AND market_buyer IS NULL
    )
    OR
    (
      channel = 'world'
      AND asset_type = 'thing'
      AND market_draft_id IS NOT NULL
      AND (
        (
          buyer_id IS NULL
          AND market_listing_id IS NULL
          AND market_checkout_id IS NULL
          AND market_buyer IS NULL
          AND buyer_wallet IS NULL
          AND reserved_by IS NULL
          AND reserved_at IS NULL
          AND reserved_until IS NULL
        )
        OR
        (
          buyer_id IS NOT NULL
          AND market_listing_id IS NOT NULL
          AND market_checkout_id IS NOT NULL
          AND market_buyer ~ '^[a-z0-9][a-z0-9-]{2,31}$'
        )
      )
    )
  ),
  CONSTRAINT transfer_offers_pending_x402_state CHECK (
    (
      x402_evidence_state = 'none'
      AND pending_payment_attempt_id IS NULL
      AND pending_x402_tx_hash IS NULL AND pending_x402_payer IS NULL AND pending_x402_at IS NULL
      AND x402_invalid_reason IS NULL AND x402_invalid_at IS NULL
    )
    OR
    (
      channel = 'world'
      AND pending_payment_attempt_id IS NOT NULL
      AND pending_x402_tx_hash ~ '^0x[0-9a-f]{64}$'
      AND pending_x402_payer ~ '^0x[0-9a-f]{40}$'
      AND pending_x402_payer = buyer_wallet
      AND pending_x402_at IS NOT NULL
      AND buyer_id IS NOT NULL AND reserved_by = buyer_id
      AND reserved_at IS NOT NULL AND reserved_until IS NOT NULL
      AND market_listing_id IS NOT NULL AND market_checkout_id IS NOT NULL
      AND (
        (x402_evidence_state = 'pending' AND x402_invalid_reason IS NULL AND x402_invalid_at IS NULL)
        OR
        (x402_evidence_state = 'invalid'
          AND x402_invalid_reason IN ('failed_transaction', 'confirmed_mismatch')
          AND x402_invalid_at IS NOT NULL)
      )
    )
  ),
  CONSTRAINT transfer_offers_five_minute_reservation CHECK (
    reserved_until IS NULL OR reserved_until = reserved_at + interval '5 minutes'
  ),
  CONSTRAINT transfer_offers_status_timestamps CHECK (
    (status = 'open' AND claimed_at IS NULL AND canceled_at IS NULL)
    OR (status = 'claimed' AND claimed_at IS NOT NULL AND canceled_at IS NULL)
    OR (status = 'canceled' AND canceled_at IS NOT NULL AND claimed_at IS NULL)
  )
);

-- Existing installs gain world-listing columns without rebuilding direct transfer
-- history. Direct rows retain their named buyer; a world offer starts unbound and
-- only acquires a buyer during a verified market checkout reservation.
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE transfer_offers ALTER COLUMN buyer_id DROP NOT NULL;
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS buyer_wallet TEXT
  CHECK (buyer_wallet IS NULL OR buyer_wallet ~ '^0x[0-9a-f]{40}$');
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS market_origin TEXT NOT NULL
  DEFAULT 'https://1f3ea.com';
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS market_draft_id INTEGER;
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS market_listing_id INTEGER;
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS market_checkout_id INTEGER;
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS market_buyer TEXT;
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS pending_payment_attempt_id TEXT;
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS pending_x402_tx_hash TEXT;
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS pending_x402_payer TEXT;
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS pending_x402_at TIMESTAMPTZ;
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS x402_evidence_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS x402_invalid_reason TEXT;
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS x402_invalid_at TIMESTAMPTZ;
UPDATE transfer_offers SET x402_evidence_state = 'pending'
WHERE pending_x402_tx_hash IS NOT NULL AND x402_evidence_state = 'none';
DO $migration$
DECLARE
  old_constraint TEXT;
BEGIN
  FOR old_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass AND contype = 'c'
      AND conname ~ '^transfer_offers_check[0-9]*$'
  LOOP
    EXECUTE format('ALTER TABLE transfer_offers DROP CONSTRAINT %I', old_constraint);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_reservation_complete'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_reservation_complete CHECK (
      (reserved_at IS NULL) = (reserved_until IS NULL)
      AND (reserved_by IS NULL) = (reserved_until IS NULL)
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_distinct_parties'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_distinct_parties
      CHECK (seller_id <> buyer_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_reserved_buyer'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_reserved_buyer
      CHECK (reserved_by IS NULL OR reserved_by = buyer_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_five_minute_reservation'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_five_minute_reservation
      CHECK (reserved_until IS NULL OR reserved_until = reserved_at + interval '5 minutes') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_status_timestamps'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_status_timestamps CHECK (
      (status = 'open' AND claimed_at IS NULL AND canceled_at IS NULL)
      OR (status = 'claimed' AND claimed_at IS NOT NULL AND canceled_at IS NULL)
      OR (status = 'canceled' AND canceled_at IS NOT NULL AND claimed_at IS NULL)
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_reservation_wallet_state'
  ) THEN
    ALTER TABLE transfer_offers
      ADD CONSTRAINT transfer_offers_reservation_wallet_state CHECK (
        (buyer_wallet IS NULL AND reserved_by IS NULL AND reserved_at IS NULL AND reserved_until IS NULL)
        OR
        (buyer_wallet IS NOT NULL AND reserved_by IS NOT NULL AND reserved_at IS NOT NULL AND reserved_until IS NOT NULL)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_pending_x402_state'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_pending_x402_state CHECK (
      (
        x402_evidence_state = 'none'
        AND pending_payment_attempt_id IS NULL
        AND pending_x402_tx_hash IS NULL AND pending_x402_payer IS NULL AND pending_x402_at IS NULL
        AND x402_invalid_reason IS NULL AND x402_invalid_at IS NULL
      )
      OR
      (
        channel = 'world'
        AND pending_payment_attempt_id IS NOT NULL
        AND pending_x402_tx_hash ~ '^0x[0-9a-f]{64}$'
        AND pending_x402_payer ~ '^0x[0-9a-f]{40}$'
        AND pending_x402_payer = buyer_wallet
        AND pending_x402_at IS NOT NULL
        AND buyer_id IS NOT NULL AND reserved_by = buyer_id
        AND reserved_at IS NOT NULL AND reserved_until IS NOT NULL
        AND market_listing_id IS NOT NULL AND market_checkout_id IS NOT NULL
        AND (
          (x402_evidence_state = 'pending' AND x402_invalid_reason IS NULL AND x402_invalid_at IS NULL)
          OR
          (x402_evidence_state = 'invalid'
            AND x402_invalid_reason IN ('failed_transaction', 'confirmed_mismatch')
            AND x402_invalid_at IS NOT NULL)
        )
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_channel_allowed'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_channel_allowed
      CHECK (channel IN ('direct', 'world')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_market_origin_fixed'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_market_origin_fixed
      CHECK (market_origin = 'https://1f3ea.com') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_market_ids_positive'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_market_ids_positive CHECK (
      (market_draft_id IS NULL OR market_draft_id > 0)
      AND (market_listing_id IS NULL OR market_listing_id > 0)
      AND (market_checkout_id IS NULL OR market_checkout_id > 0)
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_channel_state'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_channel_state CHECK (
      (
        channel = 'direct'
        AND buyer_id IS NOT NULL
        AND market_draft_id IS NULL
        AND market_listing_id IS NULL
        AND market_checkout_id IS NULL
        AND market_buyer IS NULL
      )
      OR
      (
        channel = 'world'
        AND asset_type = 'thing'
        AND market_draft_id IS NOT NULL
        AND (
          (
            buyer_id IS NULL
            AND market_listing_id IS NULL
            AND market_checkout_id IS NULL
            AND market_buyer IS NULL
            AND buyer_wallet IS NULL
            AND reserved_by IS NULL
            AND reserved_at IS NULL
            AND reserved_until IS NULL
          )
          OR
          (
            buyer_id IS NOT NULL
            AND market_listing_id IS NOT NULL
            AND market_checkout_id IS NOT NULL
            AND market_buyer ~ '^[a-z0-9][a-z0-9-]{2,31}$'
          )
        )
      )
    ) NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_reservation_wallet_state'
      AND NOT convalidated
  ) AND NOT EXISTS (
    SELECT 1 FROM transfer_offers
    WHERE NOT (
      (buyer_wallet IS NULL AND reserved_by IS NULL AND reserved_at IS NULL AND reserved_until IS NULL)
      OR
      (buyer_wallet IS NOT NULL AND reserved_by IS NOT NULL AND reserved_at IS NOT NULL AND reserved_until IS NOT NULL)
    )
  ) THEN
    ALTER TABLE transfer_offers
      VALIDATE CONSTRAINT transfer_offers_reservation_wallet_state;
  END IF;
END
$migration$;
ALTER TABLE transfer_offers VALIDATE CONSTRAINT transfer_offers_channel_allowed;
ALTER TABLE transfer_offers VALIDATE CONSTRAINT transfer_offers_market_origin_fixed;
ALTER TABLE transfer_offers VALIDATE CONSTRAINT transfer_offers_market_ids_positive;
ALTER TABLE transfer_offers VALIDATE CONSTRAINT transfer_offers_channel_state;
ALTER TABLE transfer_offers VALIDATE CONSTRAINT transfer_offers_pending_x402_state;
ALTER TABLE transfer_offers VALIDATE CONSTRAINT transfer_offers_reservation_complete;
ALTER TABLE transfer_offers VALIDATE CONSTRAINT transfer_offers_distinct_parties;
ALTER TABLE transfer_offers VALIDATE CONSTRAINT transfer_offers_reserved_buyer;
ALTER TABLE transfer_offers VALIDATE CONSTRAINT transfer_offers_five_minute_reservation;
ALTER TABLE transfer_offers VALIDATE CONSTRAINT transfer_offers_status_timestamps;
CREATE UNIQUE INDEX IF NOT EXISTS transfer_offers_one_open_asset
  ON transfer_offers (asset_type, asset_id) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS transfer_offers_world_draft
  ON transfer_offers (market_origin, market_draft_id) WHERE channel = 'world';
CREATE UNIQUE INDEX IF NOT EXISTS transfer_offers_world_checkout
  ON transfer_offers (market_origin, market_checkout_id)
  WHERE channel = 'world' AND market_checkout_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS transfer_offers_pending_x402_tx
  ON transfer_offers (pending_x402_tx_hash) WHERE pending_x402_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS transfer_offers_seller
  ON transfer_offers (seller_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS transfer_offers_buyer
  ON transfer_offers (buyer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS transfer_offers_seller_id_desc
  ON transfer_offers (seller_id, id DESC);
CREATE INDEX IF NOT EXISTS transfer_offers_buyer_id_desc
  ON transfer_offers (buyer_id, id DESC);
CREATE INDEX IF NOT EXISTS transfer_offers_reservation
  ON transfer_offers (reserved_until) WHERE status = 'open' AND reserved_until IS NOT NULL;

-- Link valid open offers created before the row-state mutex existed. Ownership,
-- withdrawal, or an already-populated mutex conflict leaves the old state alone.
UPDATE places AS place
SET active_offer_id = offer.id
FROM transfer_offers AS offer
WHERE place.active_offer_id IS NULL
  AND offer.asset_type = 'place'
  AND offer.asset_id = place.id
  AND offer.seller_id = place.owner_id
  AND offer.status = 'open';

UPDATE kinds AS kind
SET active_offer_id = offer.id
FROM transfer_offers AS offer
WHERE kind.active_offer_id IS NULL
  AND offer.asset_type = 'kind'
  AND offer.asset_id = kind.id
  AND offer.seller_id = kind.owner_id
  AND offer.status = 'open';

UPDATE things AS thing
SET active_offer_id = offer.id
FROM transfer_offers AS offer
WHERE thing.active_offer_id IS NULL
  AND thing.withdrawn_at IS NULL
  AND offer.asset_type = 'thing'
  AND offer.asset_id = thing.id
  AND offer.seller_id = thing.owner_id
  AND offer.status = 'open';

CREATE OR REPLACE FUNCTION protect_transfer_offer_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reservation_changed BOOLEAN;
  reservation_started_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transfer offers are retained as history' USING ERRCODE = '55000';
  END IF;

  IF OLD.channel IS DISTINCT FROM NEW.channel
    OR OLD.asset_type IS DISTINCT FROM NEW.asset_type
    OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
    OR OLD.seller_id IS DISTINCT FROM NEW.seller_id
    OR OLD.price_usdc IS DISTINCT FROM NEW.price_usdc
    OR OLD.seller_wallet IS DISTINCT FROM NEW.seller_wallet
    OR OLD.market_origin IS DISTINCT FROM NEW.market_origin
    OR OLD.market_draft_id IS DISTINCT FROM NEW.market_draft_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'transfer offer terms are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.channel = 'direct' AND (
    OLD.buyer_id IS DISTINCT FROM NEW.buyer_id
    OR OLD.market_listing_id IS DISTINCT FROM NEW.market_listing_id
    OR OLD.market_checkout_id IS DISTINCT FROM NEW.market_checkout_id
  ) THEN
    RAISE EXCEPTION 'direct transfer buyer and market state are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'open' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a closed transfer offer is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.pending_x402_tx_hash IS NOT NULL AND (
    OLD.pending_x402_tx_hash IS DISTINCT FROM NEW.pending_x402_tx_hash
    OR OLD.pending_x402_payer IS DISTINCT FROM NEW.pending_x402_payer
    OR OLD.pending_x402_at IS DISTINCT FROM NEW.pending_x402_at
  ) THEN
    RAISE EXCEPTION 'pending x402 settlement evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.x402_evidence_state = 'pending' AND NEW.x402_evidence_state = 'invalid' THEN
    IF NEW.x402_invalid_reason NOT IN ('failed_transaction', 'confirmed_mismatch') THEN
      RAISE EXCEPTION 'invalid x402 evidence needs a conclusive public-chain reason'
        USING ERRCODE = '23514';
    END IF;
    NEW.x402_invalid_at := COALESCE(NEW.x402_invalid_at, clock_timestamp());
  ELSIF OLD.x402_evidence_state IS DISTINCT FROM NEW.x402_evidence_state
    OR OLD.x402_invalid_reason IS DISTINCT FROM NEW.x402_invalid_reason
    OR OLD.x402_invalid_at IS DISTINCT FROM NEW.x402_invalid_at THEN
    RAISE EXCEPTION 'x402 evidence state is immutable except pending to invalid'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.pending_x402_tx_hash IS NULL AND NEW.pending_x402_tx_hash IS NOT NULL THEN
    IF OLD.channel <> 'world' OR OLD.status <> 'open'
      OR OLD.reserved_by IS DISTINCT FROM OLD.buyer_id
      OR OLD.buyer_wallet IS NULL OR NEW.pending_x402_payer IS DISTINCT FROM OLD.buyer_wallet
      OR OLD.reserved_at IS NULL OR OLD.reserved_until IS NULL
      OR NEW.pending_payment_attempt_id IS NULL THEN
      RAISE EXCEPTION 'pending x402 evidence requires the buyer-bound world reservation'
        USING ERRCODE = '55000';
    END IF;
    PERFORM 1
    FROM payment_attempts AS attempt
    WHERE attempt.public_id = NEW.pending_payment_attempt_id
      AND attempt.actor_id = OLD.buyer_id
      AND attempt.counterparty_id = OLD.seller_id
      AND attempt.operation = 'world_sale'
      AND attempt.offer_id = OLD.id
      AND attempt.asset_type = OLD.asset_type
      AND attempt.asset_id = OLD.asset_id
      AND attempt.status = 'payment_pending'
      AND attempt.tx_hash = NEW.pending_x402_tx_hash
      AND attempt.payer_wallet = NEW.pending_x402_payer
      AND attempt.payee_wallet = OLD.seller_wallet
      AND attempt.amount_units = (OLD.price_usdc * 1000000)::bigint
      AND attempt.start_time >= (
        date_trunc('second', OLD.reserved_at)
        + CASE WHEN OLD.reserved_at > date_trunc('second', OLD.reserved_at)
          THEN interval '1 second' ELSE interval '0 seconds' END
      )
      AND attempt.end_time <= date_trunc('second', OLD.reserved_until)
      AND (
        attempt.finalized_block_time IS NULL
        OR (
          attempt.finalized_block_time >= attempt.start_time
          AND attempt.finalized_block_time < attempt.end_time
        )
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pending x402 evidence does not match its durable payment attempt'
        USING ERRCODE = '55000';
    END IF;
    NEW.x402_evidence_state := 'pending';
    NEW.pending_x402_at := COALESCE(NEW.pending_x402_at, clock_timestamp());
  END IF;

  reservation_changed :=
    NEW.reserved_by IS DISTINCT FROM OLD.reserved_by
    OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
    OR NEW.reserved_until IS DISTINCT FROM OLD.reserved_until
    OR NEW.buyer_wallet IS DISTINCT FROM OLD.buyer_wallet
    OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
    OR NEW.market_listing_id IS DISTINCT FROM OLD.market_listing_id
    OR NEW.market_checkout_id IS DISTINCT FROM OLD.market_checkout_id
    OR NEW.market_buyer IS DISTINCT FROM OLD.market_buyer;

  IF OLD.pending_x402_tx_hash IS NOT NULL AND reservation_changed THEN
    RAISE EXCEPTION 'pending x402 reservation is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'open' AND reservation_changed THEN
    IF EXISTS (
      SELECT 1 FROM payment_attempts AS attempt
      WHERE attempt.offer_id = OLD.id
        AND attempt.operation IN ('direct_sale', 'world_sale')
        AND attempt.status IN ('settling', 'payment_pending', 'needs_review')
    ) THEN
      RAISE EXCEPTION 'a live payment attempt keeps its transfer reservation'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.reserved_until IS NOT NULL AND OLD.reserved_until > clock_timestamp() THEN
      RAISE EXCEPTION 'an active transfer reservation is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.buyer_wallet IS NULL OR NEW.buyer_id IS NULL THEN
      RAISE EXCEPTION 'a transfer reservation requires a buyer and wallet' USING ERRCODE = '23514';
    END IF;
    IF NEW.channel = 'world'
      AND (NEW.market_listing_id IS NULL OR NEW.market_checkout_id IS NULL) THEN
      RAISE EXCEPTION 'a world reservation requires market listing and checkout ids'
        USING ERRCODE = '23514';
    END IF;

    reservation_started_at := clock_timestamp();
    NEW.reserved_by := NEW.buyer_id;
    NEW.reserved_at := reservation_started_at;
    NEW.reserved_until := reservation_started_at + interval '5 minutes';
  ELSIF OLD.status = 'open' AND NEW.status <> 'open' AND reservation_changed THEN
    RAISE EXCEPTION 'transfer reservation history is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'claimed' AND OLD.status = 'open' THEN
    IF OLD.buyer_id IS NULL OR OLD.reserved_by IS DISTINCT FROM OLD.buyer_id
      OR OLD.buyer_wallet IS NULL OR OLD.reserved_at IS NULL OR OLD.reserved_until IS NULL
      OR OLD.reserved_at > clock_timestamp()
      OR (OLD.reserved_until <= clock_timestamp() AND OLD.x402_evidence_state <> 'pending') THEN
      RAISE EXCEPTION 'a claim requires an active buyer-bound reservation'
        USING ERRCODE = '55000';
    END IF;
    NEW.claimed_at := COALESCE(NEW.claimed_at, clock_timestamp());
    NEW.canceled_at := NULL;
  ELSIF NEW.status = 'canceled' AND OLD.status = 'open' THEN
    IF OLD.x402_evidence_state <> 'invalid' AND (
      OLD.x402_evidence_state = 'pending'
      OR (OLD.reserved_until IS NOT NULL AND OLD.reserved_until > clock_timestamp())
      OR EXISTS (
        SELECT 1 FROM payment_attempts AS attempt
        WHERE attempt.offer_id = OLD.id
          AND attempt.operation IN ('direct_sale', 'world_sale')
          AND attempt.status IN ('settling', 'payment_pending', 'needs_review')
      )
    ) THEN
      RAISE EXCEPTION 'an active reservation or pending x402 settlement cannot be canceled'
        USING ERRCODE = '55000';
    END IF;
    NEW.canceled_at := COALESCE(NEW.canceled_at, clock_timestamp());
    NEW.claimed_at := NULL;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'invalid transfer offer transition' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS transfer_offers_keep_history ON transfer_offers;
CREATE TRIGGER transfer_offers_keep_history BEFORE UPDATE OR DELETE ON transfer_offers
  FOR EACH ROW EXECUTE FUNCTION protect_transfer_offer_history();




-- A lower-case Base transaction hash is claimed exactly once here. Fees and sales
-- both reference the same primary key, so a proof cannot cross-pay between tables.
CREATE TABLE IF NOT EXISTS payment_uses (
  tx_hash         TEXT PRIMARY KEY CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  payment_attempt_id TEXT NOT NULL,
  actor_id        INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  purpose         TEXT NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{0,31}$'),
  payer_wallet    TEXT CHECK (payer_wallet IS NULL OR payer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  payee_wallet    TEXT CHECK (payee_wallet IS NULL OR payee_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  amount_usdc     NUMERIC(12,6) CHECK (amount_usdc IS NULL OR (amount_usdc > 0 AND amount_usdc <= 10000)),
  used_as         TEXT GENERATED ALWAYS AS
                  (CASE WHEN purpose = 'sale' THEN 'sale_payments' ELSE 'fees' END) STORED,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, used_as)
);
CREATE INDEX IF NOT EXISTS payment_uses_actor ON payment_uses (actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fees (
  id                SERIAL PRIMARY KEY,
  resident_id       INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  purpose           TEXT NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{0,31}$' AND purpose <> 'sale'),
  amount_usdc       NUMERIC(12,6) NOT NULL CHECK (amount_usdc > 0 AND amount_usdc <= 10000),
  tx_hash           TEXT NOT NULL UNIQUE CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  payment_use_kind  TEXT GENERATED ALWAYS AS ('fees') STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tx_hash, payment_use_kind)
    REFERENCES payment_uses(tx_hash, used_as) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS fees_resident ON fees (resident_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fees_purpose ON fees (purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS sale_payments (
  id                SERIAL PRIMARY KEY,
  offer_id          INTEGER NOT NULL UNIQUE REFERENCES transfer_offers(id) ON DELETE RESTRICT,
  buyer_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  payer_wallet      TEXT NOT NULL CHECK (payer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  payee_wallet      TEXT NOT NULL CHECK (payee_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  amount_usdc       NUMERIC(12,6) NOT NULL CHECK (amount_usdc > 0 AND amount_usdc <= 10000),
  tx_hash           TEXT NOT NULL UNIQUE CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  verified_via      TEXT NOT NULL DEFAULT 'claim' CHECK (verified_via IN ('x402', 'claim')),
  block_time        TIMESTAMPTZ,
  payment_use_kind  TEXT GENERATED ALWAYS AS ('sale_payments') STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (offer_id, tx_hash),
  FOREIGN KEY (tx_hash, payment_use_kind)
    REFERENCES payment_uses(tx_hash, used_as) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS sale_payments_buyer ON sale_payments (buyer_id, created_at DESC);

DO $$
BEGIN
  IF to_regclass('public.payment_attempts') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'payment_attempts'
        AND column_name = 'public_id'
    ) THEN
    RAISE EXCEPTION 'legacy payment_attempts schema requires quarantine before custody migration'
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS payment_attempts (
  public_id                TEXT PRIMARY KEY
                           CHECK (octet_length(public_id) BETWEEN 16 AND 128
                             AND public_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]+$'),
  actor_id                 INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT
                           CHECK (actor_id > 0),
  counterparty_id          INTEGER REFERENCES residents(id) ON DELETE RESTRICT
                           CHECK (counterparty_id IS NULL OR counterparty_id > 0),
  operation                TEXT NOT NULL CHECK (operation IN (
                             'frontier', 'kind_invention', 'kind_revision',
                             'direct_sale', 'world_sale', 'legacy'
                           )),
  target_key               TEXT CHECK (
                             target_key IS NULL OR octet_length(target_key) BETWEEN 1 AND 240
                           ),
  offer_id                 INTEGER CHECK (offer_id IS NULL OR offer_id > 0),
  asset_type               TEXT CHECK (
                             asset_type IS NULL OR asset_type IN ('place', 'thing', 'kind')
                           ),
  asset_id                 INTEGER CHECK (asset_id IS NULL OR asset_id > 0),
  request_hash             TEXT CHECK (
                             request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'
                           ),
  request_json             JSONB CHECK (
                             request_json IS NULL OR jsonb_typeof(request_json) = 'object'
                           ),
  method                   TEXT CHECK (method IS NULL OR method IN ('x402', 'claim', 'legacy')),
  network                  TEXT CHECK (network IS NULL OR network = 'base'),
  token                    TEXT CHECK (
                             token IS NULL
                             OR token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
                           ),
  payer_wallet             TEXT CHECK (
                             payer_wallet IS NULL OR payer_wallet ~ '^0x[0-9a-f]{40}$'
                           ),
  payee_wallet             TEXT CHECK (
                             payee_wallet IS NULL OR payee_wallet ~ '^0x[0-9a-f]{40}$'
                           ),
  amount_units             BIGINT CHECK (
                             amount_units IS NULL OR amount_units BETWEEN 1 AND 10000000000
                           ),
  x402_nonce               TEXT CHECK (
                             x402_nonce IS NULL OR x402_nonce ~ '^0x[0-9a-f]{64}$'
                           ),
  x402_payload_digest      TEXT CHECK (
                             x402_payload_digest IS NULL
                             OR x402_payload_digest ~ '^[0-9a-f]{64}$'
                           ),
  x402_valid_after         BIGINT CHECK (
                             x402_valid_after IS NULL OR x402_valid_after >= 0
                           ),
  x402_valid_before        BIGINT CHECK (
                             x402_valid_before IS NULL OR x402_valid_before >= 0
                           ),
  start_block              BIGINT CHECK (start_block IS NULL OR start_block >= 0),
  start_time               TIMESTAMPTZ,
  end_time                 TIMESTAMPTZ,
  status                   TEXT NOT NULL CHECK (status IN (
                             'settling', 'payment_pending', 'completed',
                             'invalid', 'expired', 'needs_review', 'legacy_completed'
                           )),
  lease_owner              TEXT CHECK (
                             lease_owner IS NULL OR octet_length(lease_owner) BETWEEN 1 AND 128
                           ),
  lease_expires_at         TIMESTAMPTZ,
  tx_hash                  TEXT UNIQUE CHECK (
                             tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'
                           ),
  finalized_block_number   BIGINT CHECK (
                             finalized_block_number IS NULL OR finalized_block_number >= 0
                           ),
  finalized_block_hash     TEXT CHECK (
                             finalized_block_hash IS NULL
                             OR finalized_block_hash ~ '^0x[0-9a-f]{64}$'
                           ),
  finalized_block_time     TIMESTAMPTZ,
  finalized_at             TIMESTAMPTZ,
  invalid_reason           TEXT CHECK (
                             invalid_reason IS NULL OR octet_length(invalid_reason) BETWEEN 1 AND 240
                           ),
  result_json              JSONB CHECK (
                             result_json IS NULL OR jsonb_typeof(result_json) = 'object'
                           ),
  response_status          SMALLINT CHECK (
                             response_status IS NULL OR response_status BETWEEN 100 AND 599
                           ),
  response_json            JSONB CHECK (
                             response_json IS NULL OR jsonb_typeof(response_json) = 'object'
                           ),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ,
  CHECK ((asset_type IS NULL) = (asset_id IS NULL)),
  CHECK (status NOT IN ('settling', 'payment_pending', 'needs_review') OR target_key IS NOT NULL),
  CHECK (end_time IS NULL OR start_time IS NULL OR end_time > start_time),
  CHECK (
    x402_valid_before IS NULL OR x402_valid_after IS NULL
    OR x402_valid_before > x402_valid_after
  ),
  CHECK (
    x402_nonce IS NULL
    OR (method = 'x402' AND network = 'base' AND token IS NOT NULL AND payer_wallet IS NOT NULL)
  ),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (updated_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (
    finalized_block_number IS NULL OR start_block IS NULL
    OR finalized_block_number >= start_block
  ),
  CONSTRAINT payment_attempts_finality_complete CHECK (
    (finalized_block_number IS NULL AND finalized_block_hash IS NULL
      AND finalized_block_time IS NULL AND finalized_at IS NULL)
    OR
    (finalized_block_number IS NOT NULL AND finalized_block_hash IS NOT NULL
      AND finalized_block_time IS NOT NULL AND finalized_at IS NOT NULL)
  ),
  CONSTRAINT payment_attempts_completed_facts CHECK (
    status <> 'completed' OR (
      tx_hash IS NOT NULL
      AND finalized_block_number IS NOT NULL
      AND finalized_block_hash IS NOT NULL
      AND finalized_block_time IS NOT NULL
      AND finalized_at IS NOT NULL
      AND result_json IS NOT NULL
      AND response_status IS NOT NULL
      AND response_json IS NOT NULL
      AND completed_at IS NOT NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  )
);

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS finalized_block_time TIMESTAMPTZ;
ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_status_check CHECK (status IN (
    'settling', 'payment_pending', 'completed', 'invalid', 'expired',
    'needs_review', 'legacy_completed'
  ));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_attempts'::regclass
      AND conname = 'payment_attempts_finality_complete'
  ) THEN
    ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_finality_complete CHECK (
      (finalized_block_number IS NULL AND finalized_block_hash IS NULL
        AND finalized_block_time IS NULL AND finalized_at IS NULL)
      OR
      (finalized_block_number IS NOT NULL AND finalized_block_hash IS NOT NULL
        AND finalized_block_time IS NOT NULL AND finalized_at IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_attempts'::regclass
      AND conname = 'payment_attempts_completed_facts'
  ) THEN
    ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_completed_facts CHECK (
      status <> 'completed' OR (
        tx_hash IS NOT NULL
        AND finalized_block_number IS NOT NULL
        AND finalized_block_hash IS NOT NULL
        AND finalized_block_time IS NOT NULL
        AND finalized_at IS NOT NULL
        AND result_json IS NOT NULL
        AND response_status IS NOT NULL
        AND response_json IS NOT NULL
        AND completed_at IS NOT NULL
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL
      )
    );
  END IF;
END
$$;

-- Preserve the literal UTF-8 bytes returned by a completed paid operation.
-- Legacy completed rows remain NULL because their original bytes cannot be recovered.
ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS response_body_bytes BYTEA;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_attempts'::regclass
      AND conname = 'payment_attempts_response_body_bytes_valid'
  ) THEN
    ALTER TABLE payment_attempts
      ADD CONSTRAINT payment_attempts_response_body_bytes_valid CHECK (
        response_body_bytes IS NULL OR (
          status = 'completed'
          AND response_status IS NOT NULL
          AND response_json IS NOT NULL
          AND octet_length(response_body_bytes) BETWEEN 2 AND 200000
        )
      ) NOT VALID;
  END IF;
END
$$;
ALTER TABLE payment_attempts
  VALIDATE CONSTRAINT payment_attempts_response_body_bytes_valid;

COMMENT ON COLUMN payment_attempts.response_body_bytes IS
  'Literal UTF-8 JSON response bytes for byte-exact paid-operation replay; NULL means unavailable, never reconstructed';

CREATE OR REPLACE FUNCTION validate_payment_response_body() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  decoded_response JSONB;
  canonical_response JSONB;
BEGIN
  IF NEW.response_body_bytes IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    decoded_response := convert_from(NEW.response_body_bytes, 'UTF8')::jsonb;
  EXCEPTION
    WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
      RAISE EXCEPTION 'payment response body is not valid UTF-8 JSON'
        USING ERRCODE = '23514';
  END;

  canonical_response := CASE
    WHEN NEW.response_json #> '{__1f3d9_x402_response_v1,body}' IS NOT NULL
      THEN NEW.response_json #> '{__1f3d9_x402_response_v1,body}'
    ELSE NEW.response_json
  END;
  IF jsonb_typeof(decoded_response) <> 'object'
    OR decoded_response IS DISTINCT FROM canonical_response THEN
    RAISE EXCEPTION 'payment response body does not match its canonical response'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payment_attempts_validate_response_body ON payment_attempts;
CREATE TRIGGER payment_attempts_validate_response_body
  BEFORE INSERT OR UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION validate_payment_response_body();

CREATE OR REPLACE FUNCTION complete_payment_attempt(
  attempt_id TEXT,
  expected_lease_owner TEXT,
  completion_result JSONB,
  completion_response_status SMALLINT,
  completion_response JSONB,
  completion_response_body BYTEA
) RETURNS payment_attempts LANGUAGE plpgsql AS $$
DECLARE
  completed payment_attempts%ROWTYPE;
  decoded_response JSONB;
BEGIN
  IF completion_response_body IS NULL
    OR octet_length(completion_response_body) NOT BETWEEN 2 AND 200000 THEN
    RAISE EXCEPTION 'payment response body is outside its byte limit'
      USING ERRCODE = '23514';
  END IF;
  BEGIN
    decoded_response := convert_from(completion_response_body, 'UTF8')::jsonb;
  EXCEPTION
    WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
      RAISE EXCEPTION 'payment response body is not valid UTF-8 JSON'
        USING ERRCODE = '23514';
  END;
  IF jsonb_typeof(decoded_response) <> 'object'
    OR decoded_response IS DISTINCT FROM completion_response THEN
    RAISE EXCEPTION 'payment response body does not match its canonical response'
      USING ERRCODE = '23514';
  END IF;

  UPDATE payment_attempts
  SET status = 'completed',
    result_json = completion_result,
    response_status = completion_response_status,
    response_json = CASE
      WHEN response_json #>> '{__1f3d9_x402_response_v1,header}' IS NULL
        THEN completion_response
      ELSE jsonb_build_object(
        '__1f3d9_x402_response_v1',
        jsonb_build_object(
          'header', response_json #>> '{__1f3d9_x402_response_v1,header}',
          'body', completion_response
        )
      )
    END,
    response_body_bytes = completion_response_body,
    completed_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
  WHERE public_id = attempt_id
    AND lease_owner = expected_lease_owner
    AND status = 'payment_pending'
    AND tx_hash IS NOT NULL
    AND finalized_block_number IS NOT NULL
    AND finalized_block_hash IS NOT NULL
    AND finalized_block_time IS NOT NULL
    AND finalized_at IS NOT NULL
    AND jsonb_typeof(completion_response) = 'object'
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalized payment attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;

COMMENT ON COLUMN payment_attempts.actor_id IS
  'Authenticated resident initiating and receiving the paid operation result';
COMMENT ON COLUMN payment_attempts.counterparty_id IS
  'Immutable other resident in a sale; NULL for treasury fees';

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_x402_nonce
  ON payment_attempts (network, token, payer_wallet, x402_nonce)
  WHERE x402_nonce IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_live_target
  ON payment_attempts (operation, target_key)
  WHERE target_key IS NOT NULL AND status IN ('settling', 'payment_pending', 'needs_review');
CREATE INDEX IF NOT EXISTS payment_attempts_actor
  ON payment_attempts (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_reconcile
  ON payment_attempts (updated_at, public_id)
  WHERE status IN ('settling', 'payment_pending', 'needs_review');

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_public_tx
  ON payment_attempts (public_id, tx_hash);
CREATE UNIQUE INDEX IF NOT EXISTS transfer_offers_pending_payment_attempt
  ON transfer_offers (pending_payment_attempt_id)
  WHERE pending_payment_attempt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_uses_one_attempt
  ON payment_uses (payment_attempt_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_pending_attempt_owner'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_pending_attempt_owner
      FOREIGN KEY (pending_payment_attempt_id)
      REFERENCES payment_attempts (public_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_pending_attempt_state'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_pending_attempt_state CHECK (
      (pending_x402_tx_hash IS NULL AND pending_payment_attempt_id IS NULL)
      OR (pending_x402_tx_hash IS NOT NULL AND pending_payment_attempt_id IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_exact_attempt'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_exact_attempt
      FOREIGN KEY (payment_attempt_id, tx_hash)
      REFERENCES payment_attempts (public_id, tx_hash)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION protect_pending_payment_attempt_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.pending_payment_attempt_id IS NOT NULL
    AND NEW.pending_payment_attempt_id IS DISTINCT FROM OLD.pending_payment_attempt_id THEN
    RAISE EXCEPTION 'pending payment attempt ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS transfer_offers_keep_pending_attempt ON transfer_offers;
CREATE TRIGGER transfer_offers_keep_pending_attempt
  BEFORE UPDATE ON transfer_offers
  FOR EACH ROW EXECUTE FUNCTION protect_pending_payment_attempt_link();

CREATE OR REPLACE FUNCTION protect_payment_attempt_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment attempt history cannot be deleted' USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.public_id, NEW.actor_id, NEW.counterparty_id, NEW.operation,
    NEW.target_key, NEW.offer_id, NEW.asset_type, NEW.asset_id,
    NEW.request_hash, NEW.request_json, NEW.method, NEW.network, NEW.token,
    NEW.payer_wallet, NEW.payee_wallet, NEW.amount_units, NEW.x402_nonce,
    NEW.x402_payload_digest, NEW.x402_valid_after, NEW.x402_valid_before,
    NEW.start_block, NEW.start_time, NEW.end_time, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.public_id, OLD.actor_id, OLD.counterparty_id, OLD.operation,
    OLD.target_key, OLD.offer_id, OLD.asset_type, OLD.asset_id,
    OLD.request_hash, OLD.request_json, OLD.method, OLD.network, OLD.token,
    OLD.payer_wallet, OLD.payee_wallet, OLD.amount_units, OLD.x402_nonce,
    OLD.x402_payload_digest, OLD.x402_valid_after, OLD.x402_valid_before,
    OLD.start_block, OLD.start_time, OLD.end_time, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'payment attempt terms are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash THEN
    RAISE EXCEPTION 'payment attempt transaction is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.finalized_block_number IS NOT NULL AND ROW(
    NEW.finalized_block_number, NEW.finalized_block_hash,
    NEW.finalized_block_time, NEW.finalized_at
  ) IS DISTINCT FROM ROW(
    OLD.finalized_block_number, OLD.finalized_block_hash,
    OLD.finalized_block_time, OLD.finalized_at
  ) THEN
    RAISE EXCEPTION 'payment attempt finality is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.response_json #>> '{__1f3d9_x402_response_v1,header}' IS NOT NULL
    AND NEW.response_json #>> '{__1f3d9_x402_response_v1,header}' IS DISTINCT FROM
      OLD.response_json #>> '{__1f3d9_x402_response_v1,header}' THEN
    RAISE EXCEPTION 'payment facilitator response is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('completed', 'invalid', 'expired', 'legacy_completed')
    AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal payment attempt is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.status = 'settling' AND NEW.status IN (
      'settling', 'payment_pending', 'invalid', 'expired', 'needs_review'
    ))
    OR (OLD.status = 'payment_pending' AND NEW.status IN (
      'payment_pending', 'completed', 'invalid', 'needs_review'
    ))
    OR (OLD.status = 'needs_review' AND NEW.status IN (
      'needs_review', 'payment_pending', 'completed', 'invalid'
    ))
    OR (OLD.status = NEW.status)
  ) THEN
    RAISE EXCEPTION 'invalid payment attempt transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'payment attempt update time cannot move backward' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS payment_attempts_keep_history ON payment_attempts;
CREATE TRIGGER payment_attempts_keep_history BEFORE UPDATE OR DELETE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION protect_payment_attempt_history();

CREATE OR REPLACE FUNCTION complete_payment_attempt(
  attempt_id TEXT,
  expected_lease_owner TEXT,
  completion_result JSONB,
  completion_response_status SMALLINT,
  completion_response JSONB
) RETURNS payment_attempts LANGUAGE plpgsql AS $$
DECLARE
  completed payment_attempts%ROWTYPE;
BEGIN
  UPDATE payment_attempts
  SET status = 'completed',
    result_json = completion_result,
    response_status = completion_response_status,
    response_json = CASE
      WHEN response_json #>> '{__1f3d9_x402_response_v1,header}' IS NULL
        THEN completion_response
      ELSE jsonb_build_object(
        '__1f3d9_x402_response_v1',
        jsonb_build_object(
          'header', response_json #>> '{__1f3d9_x402_response_v1,header}',
          'body', completion_response
        )
      )
    END,
    completed_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
  WHERE public_id = attempt_id
    AND lease_owner = expected_lease_owner
    AND status = 'payment_pending'
    AND tx_hash IS NOT NULL
    AND finalized_block_number IS NOT NULL
    AND finalized_block_hash IS NOT NULL
    AND finalized_block_time IS NOT NULL
    AND finalized_at IS NOT NULL
    AND jsonb_typeof(completion_response) = 'object'
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalized payment attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;

CREATE OR REPLACE FUNCTION validate_payment_use_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  expected_amount BIGINT;
  expected_purpose TEXT;
BEGIN
  expected_amount := CASE WHEN NEW.amount_usdc IS NULL THEN NULL
    ELSE (NEW.amount_usdc * 1000000)::bigint END;
  SELECT * INTO attempt
  FROM payment_attempts
  WHERE public_id = NEW.payment_attempt_id AND tx_hash = NEW.tx_hash;

  IF NOT FOUND
    OR attempt.status NOT IN ('completed', 'legacy_completed')
    OR attempt.actor_id <> NEW.actor_id
    OR attempt.payer_wallet IS DISTINCT FROM lower(NEW.payer_wallet)
    OR attempt.payee_wallet IS DISTINCT FROM lower(NEW.payee_wallet)
    OR attempt.amount_units IS DISTINCT FROM expected_amount THEN
    RAISE EXCEPTION 'payment use does not match its finalized attempt'
      USING ERRCODE = '23514';
  END IF;
  expected_purpose := CASE
    WHEN attempt.operation IN ('direct_sale', 'world_sale') THEN 'sale'
    ELSE attempt.operation
  END;
  IF attempt.operation <> 'legacy' AND NEW.purpose <> expected_purpose THEN
    RAISE EXCEPTION 'payment use does not match its finalized attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS payment_uses_match_attempt ON payment_uses;
CREATE CONSTRAINT TRIGGER payment_uses_match_attempt AFTER INSERT ON payment_uses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_payment_use_attempt();

CREATE OR REPLACE FUNCTION validate_fee_payment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
BEGIN
  SELECT payment_attempts.* INTO attempt
  FROM payment_uses
  JOIN payment_attempts
    ON payment_attempts.public_id = payment_uses.payment_attempt_id
    AND payment_attempts.tx_hash = payment_uses.tx_hash
  WHERE payment_uses.tx_hash = NEW.tx_hash;

  IF NOT FOUND OR (
    attempt.status <> 'legacy_completed'
    AND (
      attempt.status <> 'completed'
      OR attempt.method <> 'x402'
      OR attempt.actor_id <> NEW.resident_id
      OR attempt.counterparty_id IS NOT NULL
      OR attempt.operation <> NEW.purpose
      OR attempt.offer_id IS NOT NULL
      OR attempt.amount_units <> (NEW.amount_usdc * 1000000)::bigint
    )
  ) THEN
    RAISE EXCEPTION 'fee does not match its finalized payment attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS fees_match_payment_attempt ON fees;
CREATE CONSTRAINT TRIGGER fees_match_payment_attempt AFTER INSERT ON fees
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_fee_payment_attempt();

CREATE OR REPLACE FUNCTION validate_sale_payment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  sale_offer transfer_offers%ROWTYPE;
  expected_operation TEXT;
BEGIN
  SELECT payment_attempts.* INTO attempt
  FROM payment_uses
  JOIN payment_attempts
    ON payment_attempts.public_id = payment_uses.payment_attempt_id
    AND payment_attempts.tx_hash = payment_uses.tx_hash
  WHERE payment_uses.tx_hash = NEW.tx_hash;
  SELECT * INTO sale_offer FROM transfer_offers WHERE id = NEW.offer_id;
  expected_operation := CASE sale_offer.channel
    WHEN 'direct' THEN 'direct_sale' ELSE 'world_sale' END;

  IF attempt.public_id IS NULL OR sale_offer.id IS NULL
    OR attempt.status <> 'completed'
    OR attempt.method <> 'x402'
    OR NEW.verified_via <> 'x402'
    OR sale_offer.status <> 'claimed'
    OR attempt.operation <> expected_operation
    OR attempt.offer_id <> sale_offer.id
    OR attempt.asset_type <> sale_offer.asset_type
    OR attempt.asset_id <> sale_offer.asset_id
    OR attempt.actor_id <> NEW.buyer_id
    OR attempt.counterparty_id <> sale_offer.seller_id
    OR attempt.payer_wallet <> lower(NEW.payer_wallet)
    OR attempt.payee_wallet <> lower(NEW.payee_wallet)
    OR attempt.amount_units <> (NEW.amount_usdc * 1000000)::bigint
    OR attempt.finalized_block_time IS DISTINCT FROM NEW.block_time THEN
    RAISE EXCEPTION 'sale does not match its finalized payment attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS sale_payments_match_attempt ON sale_payments;
CREATE CONSTRAINT TRIGGER sale_payments_match_attempt AFTER INSERT ON sale_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_sale_payment_attempt();

-- World receipts are accepted only when every payment fact matches the original
-- city reservation. This is a database backstop behind the guarded claim CTE.
CREATE OR REPLACE FUNCTION validate_world_sale_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  world_offer transfer_offers%ROWTYPE;
BEGIN
  SELECT * INTO world_offer FROM transfer_offers WHERE id = NEW.offer_id;
  IF NOT FOUND OR world_offer.channel <> 'world' THEN
    RETURN NEW;
  END IF;

  IF world_offer.status <> 'claimed'
    OR world_offer.buyer_id IS NULL OR world_offer.buyer_id <> NEW.buyer_id
    OR world_offer.reserved_by IS DISTINCT FROM world_offer.buyer_id
    OR world_offer.buyer_wallet IS NULL
    OR lower(NEW.payer_wallet) IS DISTINCT FROM lower(world_offer.buyer_wallet)
    OR lower(NEW.payee_wallet) IS DISTINCT FROM lower(world_offer.seller_wallet)
    OR NEW.amount_usdc IS DISTINCT FROM world_offer.price_usdc
    OR NEW.block_time IS NULL
    OR NEW.block_time < (
      date_trunc('second', world_offer.reserved_at)
      + CASE
        WHEN world_offer.reserved_at > date_trunc('second', world_offer.reserved_at)
          THEN interval '1 second'
        ELSE interval '0 seconds'
      END
    )
    OR NEW.block_time >= date_trunc('second', world_offer.reserved_until)
    OR (
      NEW.verified_via = 'x402'
      AND (
        world_offer.x402_evidence_state <> 'pending'
        OR
        world_offer.pending_x402_tx_hash IS DISTINCT FROM NEW.tx_hash
        OR lower(world_offer.pending_x402_payer) IS DISTINCT FROM lower(NEW.payer_wallet)
      )
    )
    OR (NEW.verified_via = 'claim' AND world_offer.pending_x402_tx_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'world sale payment does not match its buyer reservation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS sale_payments_match_world_offer ON sale_payments;
CREATE TRIGGER sale_payments_match_world_offer BEFORE INSERT ON sale_payments
  FOR EACH ROW EXECUTE FUNCTION validate_world_sale_payment();

CREATE TABLE IF NOT EXISTS transfers (
  id            SERIAL PRIMARY KEY,
  asset_type    TEXT NOT NULL CHECK (asset_type IN ('place', 'thing', 'kind')),
  asset_id      INTEGER NOT NULL CHECK (asset_id > 0),
  from_id       INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  to_id         INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  offer_id      INTEGER REFERENCES transfer_offers(id) ON DELETE RESTRICT,
  price_usdc    NUMERIC(12,6),
  tx_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_id <> to_id),
  CHECK (
    (offer_id IS NULL AND price_usdc IS NULL AND tx_hash IS NULL)
    OR
    (offer_id IS NOT NULL AND price_usdc IS NOT NULL AND price_usdc > 0
      AND tx_hash IS NOT NULL AND tx_hash ~ '^0x[0-9a-f]{64}$')
  ),
  UNIQUE (offer_id),
  FOREIGN KEY (offer_id, tx_hash)
    REFERENCES sale_payments(offer_id, tx_hash) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS transfers_asset ON transfers (asset_type, asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_from ON transfers (from_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_to ON transfers (to_id, created_at DESC);

CREATE TABLE IF NOT EXISTS flags (
  id            SERIAL PRIMARY KEY,
  reporter_id   INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  target_type   TEXT NOT NULL CHECK (target_type IN ('resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement')),
  target_id     INTEGER NOT NULL CHECK (target_id > 0),
  reason        TEXT NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 4000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flags_target ON flags (target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_tool_submission_limits (
  ip_hash TEXT NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  day DATE NOT NULL,
  used INTEGER NOT NULL CHECK (used BETWEEN 1 AND 3),
  PRIMARY KEY (ip_hash, day)
);

CREATE TABLE IF NOT EXISTS community_tool_submissions (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL CHECK (
    char_length(title) BETWEEN 1 AND 80 AND title !~ E'[\t\r\n]'
  ),
  url TEXT NOT NULL CHECK (url ~ '^https://'),
  operator_name TEXT NOT NULL CHECK (
    char_length(operator_name) BETWEEN 1 AND 100 AND operator_name !~ E'[\t\r\n]'
  ),
  description TEXT NOT NULL CHECK (
    char_length(description) BETWEEN 1 AND 200
    AND description !~ E'[\t\r\n]'
  ),
  resident_id INTEGER REFERENCES residents(id),
  category TEXT NOT NULL CHECK (category IN ('Browse', 'Create', 'Connect', 'Learn')),
  tags TEXT[] NOT NULL CHECK (cardinality(tags) BETWEEN 1 AND 5),
  submitter_ip_hash TEXT CHECK (submitter_ip_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES residents(id),
  review_outcome TEXT CHECK (review_outcome IN ('listed', 'declined')),
  CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL)),
  CHECK ((reviewed_at IS NULL) = (review_outcome IS NULL)),
  CHECK ((reviewed_at IS NULL) = (submitter_ip_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS community_tool_submissions_created_idx
  ON community_tool_submissions (id DESC);
CREATE INDEX IF NOT EXISTS community_tool_submissions_pending_idx
  ON community_tool_submissions (id DESC) WHERE reviewed_at IS NULL;
CREATE INDEX IF NOT EXISTS flags_reporter ON flags (reporter_id, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id            SERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind          TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  actor         TEXT NOT NULL DEFAULT '',
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object')
);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS events_at ON events (at DESC, id DESC);
CREATE INDEX IF NOT EXISTS events_kind_id_desc ON events (kind, id DESC);
CREATE INDEX IF NOT EXISTS events_actor_at_desc ON events (actor, at DESC);

-- Public history is append-only. Mutable identity/quota/property rows are excluded,
-- their changes are represented by immutable revisions, transfers, and events.
CREATE OR REPLACE FUNCTION deny_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END$$;

-- City fee credit is private, fixed-value city accounting. A fresh schema
-- starts with no balance and issues no credit.
ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_method_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_method_check CHECK (
    method IS NULL OR method IN ('x402', 'claim', 'legacy', 'credit')
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_status_check CHECK (status IN (
    'settling', 'payment_pending', 'completed', 'invalid', 'expired',
    'needs_review', 'legacy_completed', 'credit_returned'
  ));

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_completed_facts;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_completed_facts CHECK (
    status <> 'completed' OR (
      result_json IS NOT NULL
      AND response_status IS NOT NULL
      AND response_json IS NOT NULL
      AND completed_at IS NOT NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND (
        (
          method = 'credit'
          AND tx_hash IS NULL
          AND finalized_block_number IS NULL
          AND finalized_block_hash IS NULL
          AND finalized_block_time IS NULL
          AND finalized_at IS NULL
        )
        OR
        (
          method IS DISTINCT FROM 'credit'
          AND tx_hash IS NOT NULL
          AND finalized_block_number IS NOT NULL
          AND finalized_block_hash IS NOT NULL
          AND finalized_block_time IS NOT NULL
          AND finalized_at IS NOT NULL
        )
      )
    )
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_credit_facts;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_credit_facts CHECK (
    method IS DISTINCT FROM 'credit' OR (
      operation IN (
        'frontier', 'kind_invention', 'kind_revision',
        'place_rename', 'place_retire', 'place_restore'
      )
      AND target_key IS NOT NULL
      AND request_hash IS NOT NULL
      AND request_json IS NOT NULL
      AND amount_units = 1000000
      AND counterparty_id IS NULL
      AND offer_id IS NULL
      AND (
        (
          operation = 'kind_revision'
          AND asset_type = 'kind'
          AND asset_id IS NOT NULL
        )
        OR (
          operation IN ('place_rename', 'place_retire', 'place_restore')
          AND asset_type = 'place'
          AND asset_id IS NOT NULL
        )
        OR (
          operation IN ('frontier', 'kind_invention')
          AND asset_type IS NULL
          AND asset_id IS NULL
        )
      )
      AND network IS NULL
      AND token IS NULL
      AND payer_wallet IS NULL
      AND payee_wallet IS NULL
      AND x402_nonce IS NULL
      AND x402_payload_digest IS NULL
      AND x402_valid_after IS NULL
      AND x402_valid_before IS NULL
      AND start_block IS NULL
      AND start_time IS NULL
      AND end_time IS NULL
      AND tx_hash IS NULL
      AND finalized_block_number IS NULL
      AND finalized_block_hash IS NULL
      AND finalized_block_time IS NULL
      AND finalized_at IS NULL
      AND (status <> 'completed' OR response_body_bytes IS NOT NULL)
      AND status IN ('settling', 'payment_pending', 'completed', 'credit_returned')
    )
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_credit_returned_facts;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_credit_returned_facts CHECK (
    status <> 'credit_returned' OR (
      method = 'credit'
      AND invalid_reason IS NOT NULL
      AND result_json IS NOT NULL
      AND response_status IS NOT NULL
      AND response_json IS NOT NULL
      AND response_body_bytes IS NOT NULL
      AND completed_at IS NOT NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_response_body_bytes_valid;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_response_body_bytes_valid CHECK (
    response_body_bytes IS NULL OR (
      status IN ('completed', 'credit_returned')
      AND response_status IS NOT NULL
      AND response_json IS NOT NULL
      AND octet_length(response_body_bytes) BETWEEN 2 AND 200000
    )
  );

CREATE TABLE IF NOT EXISTS city_credit_accounts (
  resident_id   INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE RESTRICT,
  balance_units BIGINT NOT NULL DEFAULT 0 CHECK (balance_units >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS city_credit_entries (
  id                 BIGSERIAL PRIMARY KEY,
  resident_id        INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  entry_kind         TEXT NOT NULL CHECK (entry_kind IN (
                       'founder_issue', 'purchase', 'gift_pending', 'gift_accept',
                       'gift_refuse', 'gift_redirect', 'spend', 'return',
                       'admin_credit', 'admin_debit'
                     )),
  amount_units       BIGINT NOT NULL CHECK (
                       amount_units > 0 AND amount_units <= 10000000000
                       AND amount_units % 1000000 = 0
                     ),
  founder_id         INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  payment_attempt_id TEXT REFERENCES payment_attempts(public_id) ON DELETE RESTRICT,
  related_spend_id   BIGINT REFERENCES city_credit_entries(id) ON DELETE RESTRICT,
  request_id         TEXT CHECK (
                       request_id IS NULL OR (
                         octet_length(request_id) BETWEEN 8 AND 128
                         AND request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
                       )
                     ),
  source_key         TEXT CHECK (
                       source_key IS NULL OR (
                         octet_length(source_key) BETWEEN 8 AND 160
                         AND source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
                       )
                     ),
  reason             TEXT CHECK (
                       reason IS NULL OR octet_length(reason) BETWEEN 1 AND 240
                     ),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (
      entry_kind IN ('founder_issue', 'admin_credit', 'admin_debit')
      AND amount_units = 1000000
      AND founder_id = 1
      AND source_key IS NOT NULL
      AND request_id IS NULL
      AND payment_attempt_id IS NULL
      AND related_spend_id IS NULL
      AND reason IS NOT NULL
    )
    OR
    (
      entry_kind = 'spend'
      AND amount_units = 1000000
      AND founder_id IS NULL
      AND source_key IS NULL
      AND request_id IS NOT NULL
      AND payment_attempt_id IS NOT NULL
      AND related_spend_id IS NULL
      AND reason IS NULL
    )
    OR
    (
      entry_kind = 'return'
      AND amount_units = 1000000
      AND founder_id IS NULL
      AND source_key IS NULL
      AND request_id IS NULL
      AND payment_attempt_id IS NOT NULL
      AND related_spend_id IS NOT NULL
      AND reason IS NOT NULL
    )
    OR entry_kind IN (
      'purchase', 'gift_pending', 'gift_accept', 'gift_refuse', 'gift_redirect'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_source_key
  ON city_credit_entries (source_key)
  WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_spend_request
  ON city_credit_entries (resident_id, request_id)
  WHERE entry_kind = 'spend';
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_one_spend_per_attempt
  ON city_credit_entries (payment_attempt_id)
  WHERE entry_kind = 'spend';
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_one_return_per_spend
  ON city_credit_entries (related_spend_id)
  WHERE entry_kind = 'return';
CREATE INDEX IF NOT EXISTS city_credit_entries_resident_history
  ON city_credit_entries (resident_id, id DESC);

CREATE TABLE IF NOT EXISTS city_credit_last_me_reads (
  resident_id          INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE CASCADE,
  previous_credit_entry_id BIGINT CHECK (previous_credit_entry_id >= 0),
  last_credit_entry_id BIGINT NOT NULL CHECK (last_credit_entry_id >= 0),
  read_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION validate_city_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  related_spend city_credit_entries%ROWTYPE;
BEGIN
  IF NEW.entry_kind NOT IN ('spend', 'return') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO attempt
  FROM payment_attempts
  WHERE public_id = NEW.payment_attempt_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR attempt.method <> 'credit'
    OR attempt.method IS NULL
    OR attempt.actor_id <> NEW.resident_id
    OR attempt.amount_units <> NEW.amount_units
    OR attempt.operation NOT IN (
      'frontier', 'kind_invention', 'kind_revision',
      'place_rename', 'place_retire', 'place_restore'
    )
    OR (
      NEW.entry_kind = 'spend'
      AND attempt.status NOT IN ('settling', 'payment_pending')
    )
    OR (
      NEW.entry_kind = 'return'
      AND attempt.status NOT IN ('settling', 'payment_pending', 'credit_returned')
    ) THEN
    RAISE EXCEPTION 'city credit entry does not match its live credit attempt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.entry_kind = 'return' THEN
    SELECT * INTO related_spend
    FROM city_credit_entries
    WHERE id = NEW.related_spend_id
    FOR KEY SHARE;
    IF NOT FOUND
      OR related_spend.entry_kind <> 'spend'
      OR related_spend.resident_id <> NEW.resident_id
      OR related_spend.amount_units <> NEW.amount_units
      OR related_spend.payment_attempt_id IS DISTINCT FROM NEW.payment_attempt_id THEN
      RAISE EXCEPTION 'city credit return does not match one exact spend'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS city_credit_entries_validate ON city_credit_entries;
CREATE TRIGGER city_credit_entries_validate
  BEFORE INSERT ON city_credit_entries
  FOR EACH ROW EXECUTE FUNCTION validate_city_credit_entry();

CREATE OR REPLACE FUNCTION protect_city_credit_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'city credit account is a ledger projection'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS city_credit_accounts_projection_only ON city_credit_accounts;
CREATE TRIGGER city_credit_accounts_projection_only
  BEFORE INSERT OR UPDATE OR DELETE ON city_credit_accounts
  FOR EACH ROW EXECUTE FUNCTION protect_city_credit_account();

CREATE OR REPLACE FUNCTION apply_city_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta_units BIGINT;
BEGIN
  delta_units := CASE
    WHEN NEW.entry_kind IN ('founder_issue', 'return', 'admin_credit')
      THEN NEW.amount_units
    ELSE -NEW.amount_units
  END;

  INSERT INTO city_credit_accounts (resident_id, balance_units)
  VALUES (NEW.resident_id, 0)
  ON CONFLICT (resident_id) DO NOTHING;

  UPDATE city_credit_accounts
  SET balance_units = balance_units + delta_units,
    updated_at = clock_timestamp()
  WHERE resident_id = NEW.resident_id
    AND balance_units + delta_units >= 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient city fee credit'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS city_credit_entries_apply_balance ON city_credit_entries;
CREATE TRIGGER city_credit_entries_apply_balance
  AFTER INSERT ON city_credit_entries
  FOR EACH ROW EXECUTE FUNCTION apply_city_credit_entry();

DROP TRIGGER IF EXISTS city_credit_entries_append_only ON city_credit_entries;
CREATE TRIGGER city_credit_entries_append_only
  BEFORE UPDATE OR DELETE ON city_credit_entries
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

CREATE OR REPLACE FUNCTION protect_payment_attempt_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment attempt history cannot be deleted' USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.public_id, NEW.actor_id, NEW.counterparty_id, NEW.operation,
    NEW.target_key, NEW.offer_id, NEW.asset_type, NEW.asset_id,
    NEW.request_hash, NEW.request_json, NEW.method, NEW.network, NEW.token,
    NEW.payer_wallet, NEW.payee_wallet, NEW.amount_units, NEW.x402_nonce,
    NEW.x402_payload_digest, NEW.x402_valid_after, NEW.x402_valid_before,
    NEW.start_block, NEW.start_time, NEW.end_time, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.public_id, OLD.actor_id, OLD.counterparty_id, OLD.operation,
    OLD.target_key, OLD.offer_id, OLD.asset_type, OLD.asset_id,
    OLD.request_hash, OLD.request_json, OLD.method, OLD.network, OLD.token,
    OLD.payer_wallet, OLD.payee_wallet, OLD.amount_units, OLD.x402_nonce,
    OLD.x402_payload_digest, OLD.x402_valid_after, OLD.x402_valid_before,
    OLD.start_block, OLD.start_time, OLD.end_time, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'payment attempt terms are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash THEN
    RAISE EXCEPTION 'payment attempt transaction is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.finalized_block_number IS NOT NULL AND ROW(
    NEW.finalized_block_number, NEW.finalized_block_hash,
    NEW.finalized_block_time, NEW.finalized_at
  ) IS DISTINCT FROM ROW(
    OLD.finalized_block_number, OLD.finalized_block_hash,
    OLD.finalized_block_time, OLD.finalized_at
  ) THEN
    RAISE EXCEPTION 'payment attempt finality is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.response_json #>> '{__1f3d9_x402_response_v1,header}' IS NOT NULL
    AND NEW.response_json #>> '{__1f3d9_x402_response_v1,header}' IS DISTINCT FROM
      OLD.response_json #>> '{__1f3d9_x402_response_v1,header}' THEN
    RAISE EXCEPTION 'payment facilitator response is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('completed', 'invalid', 'expired', 'legacy_completed', 'credit_returned')
    AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal payment attempt is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.status = 'settling' AND NEW.status IN (
      'settling', 'payment_pending', 'invalid', 'expired', 'needs_review'
    ))
    OR (OLD.status = 'payment_pending' AND NEW.status IN (
      'payment_pending', 'completed', 'invalid', 'needs_review'
    ))
    OR (OLD.status = 'needs_review' AND NEW.status IN (
      'needs_review', 'payment_pending', 'completed', 'invalid'
    ))
    OR (
      OLD.method = 'credit'
      AND OLD.status IN ('settling', 'payment_pending')
      AND NEW.status IN ('completed', 'credit_returned')
    )
    OR (OLD.status = NEW.status)
  ) THEN
    RAISE EXCEPTION 'invalid payment attempt transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'payment attempt update time cannot move backward' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION complete_city_credit_attempt(
  attempt_id TEXT,
  expected_lease_owner TEXT,
  completion_result JSONB,
  completion_response_status SMALLINT,
  completion_response JSONB,
  completion_response_body BYTEA
) RETURNS payment_attempts LANGUAGE plpgsql AS $$
DECLARE
  completed payment_attempts%ROWTYPE;
  decoded_response JSONB;
BEGIN
  IF completion_response_body IS NULL
    OR octet_length(completion_response_body) NOT BETWEEN 2 AND 200000 THEN
    RAISE EXCEPTION 'city credit response body is outside its byte limit'
      USING ERRCODE = '23514';
  END IF;
  BEGIN
    decoded_response := convert_from(completion_response_body, 'UTF8')::jsonb;
  EXCEPTION
    WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
      RAISE EXCEPTION 'city credit response body is not valid UTF-8 JSON'
        USING ERRCODE = '23514';
  END;
  IF jsonb_typeof(completion_result) <> 'object'
    OR jsonb_typeof(completion_response) <> 'object'
    OR decoded_response IS DISTINCT FROM completion_response THEN
    RAISE EXCEPTION 'city credit response body does not match its canonical response'
      USING ERRCODE = '23514';
  END IF;

  UPDATE payment_attempts
  SET status = 'completed',
    result_json = completion_result,
    response_status = completion_response_status,
    response_json = completion_response,
    response_body_bytes = completion_response_body,
    completed_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
  WHERE public_id = attempt_id
    AND lease_owner = expected_lease_owner
    AND status IN ('settling', 'payment_pending')
    AND method = 'credit'
    AND tx_hash IS NULL
    AND finalized_block_number IS NULL
    AND finalized_block_hash IS NULL
    AND finalized_block_time IS NULL
    AND finalized_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM city_credit_entries
      WHERE payment_attempt_id = attempt_id
        AND entry_kind = 'spend'
    )
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;

CREATE OR REPLACE FUNCTION return_city_credit_spend(
  attempt_id TEXT,
  expected_lease_owner TEXT,
  return_reason TEXT,
  return_response_status SMALLINT,
  return_response JSONB,
  return_response_body BYTEA
) RETURNS payment_attempts LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  spend city_credit_entries%ROWTYPE;
  decoded_response JSONB;
BEGIN
  IF return_reason IS NULL OR octet_length(return_reason) NOT BETWEEN 1 AND 240 THEN
    RAISE EXCEPTION 'city credit return reason is outside its byte limit'
      USING ERRCODE = '23514';
  END IF;
  IF return_response_body IS NULL
    OR octet_length(return_response_body) NOT BETWEEN 2 AND 200000 THEN
    RAISE EXCEPTION 'city credit return body is outside its byte limit'
      USING ERRCODE = '23514';
  END IF;
  BEGIN
    decoded_response := convert_from(return_response_body, 'UTF8')::jsonb;
  EXCEPTION
    WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
      RAISE EXCEPTION 'city credit return body is not valid UTF-8 JSON'
        USING ERRCODE = '23514';
  END;
  IF jsonb_typeof(return_response) <> 'object'
    OR decoded_response IS DISTINCT FROM return_response THEN
    RAISE EXCEPTION 'city credit return body does not match its canonical response'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO attempt
  FROM payment_attempts
  WHERE public_id = attempt_id
  FOR UPDATE;
  IF NOT FOUND OR attempt.method <> 'credit' OR attempt.method IS NULL THEN
    RAISE EXCEPTION 'city credit attempt does not exist'
      USING ERRCODE = '55000';
  END IF;

  IF attempt.status = 'credit_returned' THEN
    IF attempt.invalid_reason IS DISTINCT FROM return_reason
      OR attempt.response_status IS DISTINCT FROM return_response_status
      OR attempt.response_json IS DISTINCT FROM return_response
      OR attempt.response_body_bytes IS DISTINCT FROM return_response_body THEN
      RAISE EXCEPTION 'city credit return retry changed its terms'
        USING ERRCODE = '55000';
    END IF;
    RETURN attempt;
  END IF;

  IF attempt.status NOT IN ('settling', 'payment_pending')
    OR attempt.lease_owner IS DISTINCT FROM expected_lease_owner THEN
    RAISE EXCEPTION 'credit attempt is not owned by this return'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO spend
  FROM city_credit_entries
  WHERE payment_attempt_id = attempt_id
    AND entry_kind = 'spend'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'city credit return has no exact spend'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO city_credit_entries (
    resident_id, entry_kind, amount_units, payment_attempt_id,
    related_spend_id, reason
  ) VALUES (
    spend.resident_id, 'return', spend.amount_units, attempt_id,
    spend.id, return_reason
  );

  UPDATE payment_attempts
  SET status = 'credit_returned',
    invalid_reason = return_reason,
    result_json = jsonb_build_object('returned', true),
    response_status = return_response_status,
    response_json = return_response,
    response_body_bytes = return_response_body,
    completed_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
  WHERE public_id = attempt_id
    AND lease_owner = expected_lease_owner
    AND status IN ('settling', 'payment_pending')
    AND method = 'credit'
  RETURNING * INTO attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit attempt is not owned by this return'
      USING ERRCODE = '55000';
  END IF;
  RETURN attempt;
END
$$;

DROP TRIGGER IF EXISTS place_law_changes_append_only ON place_law_changes;
CREATE TRIGGER place_law_changes_append_only BEFORE UPDATE OR DELETE ON place_law_changes FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS active_labels_append_only ON active_labels;
CREATE TRIGGER active_labels_append_only BEFORE UPDATE OR DELETE ON active_labels FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS active_blocks_append_only ON active_blocks;
CREATE TRIGGER active_blocks_append_only BEFORE UPDATE OR DELETE ON active_blocks FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS action_runs_append_only ON action_runs;
CREATE TRIGGER action_runs_append_only BEFORE UPDATE OR DELETE ON action_runs FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS action_resolutions_append_only ON action_resolutions;
CREATE TRIGGER action_resolutions_append_only BEFORE UPDATE OR DELETE ON action_resolutions FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS pending_effects_append_only ON pending_effects;
CREATE TRIGGER pending_effects_append_only BEFORE UPDATE OR DELETE ON pending_effects FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS effect_resolutions_append_only ON effect_resolutions;
CREATE TRIGGER effect_resolutions_append_only BEFORE UPDATE OR DELETE ON effect_resolutions FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS moderation_actions_append_only ON moderation_actions;
CREATE TRIGGER moderation_actions_append_only BEFORE UPDATE OR DELETE ON moderation_actions FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS kind_revisions_append_only ON kind_revisions;
CREATE TRIGGER kind_revisions_append_only BEFORE UPDATE OR DELETE ON kind_revisions FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS kind_revision_traits_append_only ON kind_revision_traits;
CREATE TRIGGER kind_revision_traits_append_only BEFORE UPDATE OR DELETE ON kind_revision_traits FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS notes_append_only ON notes;
CREATE TRIGGER notes_append_only BEFORE UPDATE OR DELETE ON notes FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS agreements_append_only ON agreements;
CREATE TRIGGER agreements_append_only BEFORE UPDATE OR DELETE ON agreements FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS agreement_parties_append_only ON agreement_parties;
CREATE TRIGGER agreement_parties_append_only BEFORE UPDATE OR DELETE ON agreement_parties FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS agreement_accession_openings_append_only ON agreement_accession_openings;
CREATE TRIGGER agreement_accession_openings_append_only BEFORE UPDATE OR DELETE ON agreement_accession_openings FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS agreement_signatures_append_only ON agreement_signatures;
CREATE TRIGGER agreement_signatures_append_only BEFORE UPDATE OR DELETE ON agreement_signatures FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS payment_uses_append_only ON payment_uses;
CREATE TRIGGER payment_uses_append_only BEFORE UPDATE OR DELETE ON payment_uses FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS fees_append_only ON fees;
CREATE TRIGGER fees_append_only BEFORE UPDATE OR DELETE ON fees FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS sale_payments_append_only ON sale_payments;
CREATE TRIGGER sale_payments_append_only BEFORE UPDATE OR DELETE ON sale_payments FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS transfers_append_only ON transfers;
CREATE TRIGGER transfers_append_only BEFORE UPDATE OR DELETE ON transfers FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS flags_append_only ON flags;
CREATE TRIGGER flags_append_only BEFORE UPDATE OR DELETE ON flags FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS events_append_only ON events;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

-- Upgrade legacy loopback schemas from the one immutable creation event for
-- each thing. Current owner, name, and body are deliberately not evidence.
LOCK TABLE residents, things, events IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE things ADD COLUMN IF NOT EXISTS maker_id INTEGER;

DO $thing_maker_column$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'things'::regclass
      AND attname = 'maker_id'
      AND atttypid = 'integer'::regtype
      AND attgenerated = ''
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'thing maker column conflicts with the reviewed definition'
      USING ERRCODE = '23514';
  END IF;
END
$thing_maker_column$;

DO $thing_maker_event_ids$
DECLARE
  invalid_event_ids TEXT;
BEGIN
  SELECT string_agg(creation_event.id::text, ', ' ORDER BY creation_event.id)
  INTO invalid_event_ids
  FROM events AS creation_event
  WHERE creation_event.kind IN ('thing_created', 'thing_crafted')
    AND CASE
      WHEN jsonb_typeof(creation_event.detail -> 'thing_id') = 'number'
        AND creation_event.detail ->> 'thing_id' ~ '^[1-9][0-9]*$'
      THEN EXISTS (
        SELECT 1
        FROM things AS referenced_thing
        WHERE referenced_thing.id::numeric = (creation_event.detail ->> 'thing_id')::numeric
      )
      ELSE false
    END IS NOT TRUE;

  IF invalid_event_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'thing maker history has malformed or orphan creation event ids: %',
      invalid_event_ids
      USING ERRCODE = '23514';
  END IF;
END
$thing_maker_event_ids$;

CREATE TEMP TABLE thing_maker_authenticated_history ON COMMIT DROP AS
SELECT
  thing.id AS thing_id,
  COUNT(creation_event.id) AS creation_event_count,
  COUNT(creation_event.id) <> 1 AS invalid_creation_event_count,
  COUNT(authenticated_actor.id) AS authenticated_event_count,
  COUNT(authenticated_actor.id) <> 1 AS invalid_authenticated_event_count,
  MIN(authenticated_actor.id) AS authenticated_maker_id,
  coalesce(bool_and(
    creation_event.id IS NOT NULL
    AND authenticated_actor.id IS NOT NULL
    AND creation_event.at = thing.created_at
    AND jsonb_typeof(creation_event.detail -> 'place_id') = 'number'
    AND creation_event.detail ->> 'place_id' ~ '^[1-9][0-9]*$'
    AND CASE creation_event.kind
      WHEN 'thing_created' THEN
        thing.kind_id IS NULL
        AND thing.birth_revision IS NULL
        AND creation_event.detail ? 'name'
        AND jsonb_typeof(creation_event.detail -> 'name') = 'string'
        AND char_length(creation_event.detail ->> 'name') BETWEEN 1 AND 120
        AND creation_event.detail ? 'kind_id'
        AND creation_event.detail -> 'kind_id' = 'null'::jsonb
        AND creation_event.detail ? 'birth_revision'
        AND creation_event.detail -> 'birth_revision' = 'null'::jsonb
      WHEN 'thing_crafted' THEN
        thing.kind_id IS NOT NULL
        AND thing.birth_revision IS NOT NULL
        AND CASE
          WHEN jsonb_typeof(creation_event.detail -> 'kind_id') = 'number'
            AND creation_event.detail ->> 'kind_id' ~ '^[1-9][0-9]*$'
          THEN (creation_event.detail ->> 'kind_id')::numeric
        END = thing.kind_id
        AND CASE
          WHEN jsonb_typeof(creation_event.detail -> 'birth_revision') = 'number'
            AND creation_event.detail ->> 'birth_revision' ~ '^[1-9][0-9]*$'
          THEN (creation_event.detail ->> 'birth_revision')::numeric
        END = thing.birth_revision
        AND jsonb_typeof(creation_event.detail -> 'ingredient_ids') = 'array'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(creation_event.detail -> 'ingredient_ids') = 'array'
              THEN creation_event.detail -> 'ingredient_ids'
              ELSE '[]'::jsonb
            END
          ) AS ingredient(value)
          WHERE jsonb_typeof(ingredient.value) <> 'number'
            OR ingredient.value #>> '{}' !~ '^[1-9][0-9]*$'
        )
      ELSE false
    END
  ), false) AS immutable_birth_detail_matches
FROM things AS thing
LEFT JOIN events AS creation_event
  ON creation_event.kind IN ('thing_created', 'thing_crafted')
  AND CASE
    WHEN jsonb_typeof(creation_event.detail -> 'thing_id') = 'number'
      AND creation_event.detail ->> 'thing_id' ~ '^[1-9][0-9]*$'
    THEN (creation_event.detail ->> 'thing_id')::numeric
  END = thing.id
LEFT JOIN residents AS authenticated_actor
  ON authenticated_actor.handle = creation_event.actor
  AND authenticated_actor.joined_at <= creation_event.at
GROUP BY thing.id;

DO $thing_maker_history$
DECLARE
  invalid_ids TEXT;
  forged_ids TEXT;
BEGIN
  SELECT string_agg(invalid.thing_id::text, ', ' ORDER BY invalid.thing_id)
  INTO invalid_ids
  FROM (
    SELECT thing_id
    FROM thing_maker_authenticated_history
    WHERE invalid_creation_event_count
      OR invalid_authenticated_event_count
      OR NOT immutable_birth_detail_matches
    ORDER BY thing_id
  ) AS invalid;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'thing maker history is missing, duplicate, unknown, or mismatched for thing ids: %',
      invalid_ids
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(forged.id::text, ', ' ORDER BY forged.id)
  INTO forged_ids
  FROM (
    SELECT thing.id
    FROM things AS thing
    JOIN thing_maker_authenticated_history AS history
      ON history.thing_id = thing.id
    WHERE thing.maker_id IS NOT NULL
      AND thing.maker_id IS DISTINCT FROM history.authenticated_maker_id
    ORDER BY thing.id
  ) AS forged;

  IF forged_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'thing maker history disagrees with an existing maker for thing ids: %',
      forged_ids
      USING ERRCODE = '23514';
  END IF;
END
$thing_maker_history$;

DROP TRIGGER IF EXISTS things_keep_birth_history ON things;

UPDATE things AS thing
SET maker_id = history.authenticated_maker_id
FROM thing_maker_authenticated_history AS history
WHERE history.thing_id = thing.id
  AND thing.maker_id IS NULL;

DO $thing_maker_complete$
BEGIN
  IF EXISTS (SELECT 1 FROM things WHERE maker_id IS NULL) THEN
    RAISE EXCEPTION 'thing maker backfill left an unresolved row'
      USING ERRCODE = '23514';
  END IF;
END
$thing_maker_complete$;

DO $thing_maker_foreign_key$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'things'::regclass
      AND conname = 'things_maker_id_fkey'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    JOIN pg_attribute AS local_column
      ON local_column.attrelid = constraint_record.conrelid
      AND local_column.attnum = constraint_record.conkey[1]
    JOIN pg_attribute AS referenced_column
      ON referenced_column.attrelid = constraint_record.confrelid
      AND referenced_column.attnum = constraint_record.confkey[1]
    WHERE constraint_record.conrelid = 'things'::regclass
      AND constraint_record.conname = 'things_maker_id_fkey'
      AND constraint_record.contype = 'f'
      AND constraint_record.confrelid = 'residents'::regclass
      AND constraint_record.confdeltype = 'r'
      AND cardinality(constraint_record.conkey) = 1
      AND cardinality(constraint_record.confkey) = 1
      AND local_column.attname = 'maker_id'
      AND referenced_column.attname = 'id'
  ) THEN
    RAISE EXCEPTION 'thing maker foreign key conflicts with the reviewed definition'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'things'::regclass
      AND conname = 'things_maker_id_fkey'
  ) THEN
    ALTER TABLE things
      ADD CONSTRAINT things_maker_id_fkey
      FOREIGN KEY (maker_id) REFERENCES residents(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END
$thing_maker_foreign_key$;

ALTER TABLE things VALIDATE CONSTRAINT things_maker_id_fkey;
ALTER TABLE things ALTER COLUMN maker_id SET NOT NULL;

CREATE OR REPLACE FUNCTION set_thing_maker_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.maker_id IS NULL THEN
    NEW.maker_id := NEW.owner_id;
  ELSIF NEW.maker_id IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'a new thing maker must match its first owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS things_set_maker_on_insert ON things;
CREATE TRIGGER things_set_maker_on_insert BEFORE INSERT ON things
  FOR EACH ROW EXECUTE FUNCTION set_thing_maker_on_insert();

CREATE OR REPLACE FUNCTION protect_thing_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'things are retained as history; set withdrawn_at instead'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.maker_id IS DISTINCT FROM OLD.maker_id
    OR NEW.kind_id IS DISTINCT FROM OLD.kind_id
    OR NEW.birth_revision IS DISTINCT FROM OLD.birth_revision
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'thing birth history is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a withdrawn thing is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.withdrawn_at IS NOT NULL AND NEW.withdrawn_at < NEW.created_at THEN
    RAISE EXCEPTION 'withdrawn_at cannot predate creation' USING ERRCODE = '22007';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER things_keep_birth_history BEFORE UPDATE OR DELETE ON things
  FOR EACH ROW EXECUTE FUNCTION protect_thing_history();

DROP TABLE thing_maker_authenticated_history;

-- A caller-held public marker must follow commit visibility, not SERIAL
-- allocation. Every event transaction takes this one short row lock and writes
-- its immutable marker mapping before it can commit.
CREATE TABLE IF NOT EXISTS public_change_state (
  singleton          BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  current_change_id  BIGINT NOT NULL DEFAULT 0 CHECK (current_change_id >= 0)
);
INSERT INTO public_change_state (singleton, current_change_id)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public_change_log (
  change_id  BIGINT PRIMARY KEY CHECK (change_id > 0),
  event_id   INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION record_public_change() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  next_change_id BIGINT;
BEGIN
  UPDATE public_change_state
  SET current_change_id = current_change_id + 1
  WHERE singleton = true
  RETURNING current_change_id INTO next_change_id;
  IF next_change_id IS NULL THEN
    RAISE EXCEPTION 'public change state is unavailable' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public_change_log (change_id, event_id) VALUES (next_change_id, NEW.id);
  RETURN NEW;
END
$function$;

-- Reapplying the full schema is safe. The lock prevents an event writer from
-- landing between the historical backfill and trigger installation.
LOCK TABLE events IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER IF EXISTS events_record_public_change ON events;
DO $block$
DECLARE
  historical_event RECORD;
  next_change_id BIGINT;
BEGIN
  FOR historical_event IN
    SELECT event.id
    FROM events event
    LEFT JOIN public_change_log change ON change.event_id = event.id
    WHERE change.event_id IS NULL
    ORDER BY event.at ASC, event.id ASC
  LOOP
    UPDATE public_change_state
    SET current_change_id = current_change_id + 1
    WHERE singleton = true
    RETURNING current_change_id INTO next_change_id;
    INSERT INTO public_change_log (change_id, event_id)
    VALUES (next_change_id, historical_event.id);
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public_change_log change
    CROSS JOIN public_change_state state
    WHERE state.singleton = true
      AND change.change_id > state.current_change_id
  ) THEN
    RAISE EXCEPTION 'public change state trails its immutable log' USING ERRCODE = '55000';
  END IF;
END
$block$;
CREATE TRIGGER events_record_public_change
AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION record_public_change();
DROP TRIGGER IF EXISTS public_change_log_append_only ON public_change_log;
CREATE TRIGGER public_change_log_append_only BEFORE UPDATE OR DELETE ON public_change_log
FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

-- Structural world-root invariants are also enforced at the database boundary.
-- Application permission flags are local to each place; the ownerless root does
-- not grant or deny permissions in its child continents.
CREATE OR REPLACE FUNCTION protect_place_topology() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  parent_kind TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.place_kind = 'world' THEN
      RAISE EXCEPTION 'the world is transit only and cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.place_kind = 'world' THEN
      RAISE EXCEPTION 'the world is transit only and immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.place_kind IS DISTINCT FROM OLD.place_kind THEN
      RAISE EXCEPTION 'place kind is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.place_kind = 'world' THEN
    RETURN NEW;
  END IF;

  SELECT place.place_kind
  INTO parent_kind
  FROM places AS place
  WHERE place.id = NEW.parent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'place parent does not exist' USING ERRCODE = '23503';
  END IF;

  IF NEW.place_kind = 'continent' AND parent_kind <> 'world' THEN
    RAISE EXCEPTION 'continents must be direct children of the world'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.place_kind = 'place' AND parent_kind = 'world' THEN
    RAISE EXCEPTION 'only continents may be created directly under the world'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id AND EXISTS (
    WITH RECURSIVE ancestry(id, parent_id, path) AS (
      SELECT place.id, place.parent_id, ARRAY[place.id]
      FROM places AS place
      WHERE place.id = NEW.parent_id
      UNION ALL
      SELECT parent.id, parent.parent_id, ancestry.path || parent.id
      FROM places AS parent
      JOIN ancestry ON parent.id = ancestry.parent_id
      WHERE NOT parent.id = ANY(ancestry.path)
    )
    SELECT 1 FROM ancestry WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a place cannot become its own ancestor'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS places_protect_topology_write ON places;
CREATE TRIGGER places_protect_topology_write
  BEFORE UPDATE OR DELETE ON places
  FOR EACH ROW EXECUTE FUNCTION protect_place_topology();
DROP TRIGGER IF EXISTS places_protect_topology_insert ON places;
CREATE TRIGGER places_protect_topology_insert
  BEFORE INSERT ON places
  FOR EACH ROW EXECUTE FUNCTION protect_place_topology();

CREATE OR REPLACE FUNCTION reject_world_place_content() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  candidate_place_id INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'resident_presence' THEN
    candidate_place_id := NEW.home_place_id;
  ELSE
    candidate_place_id := NEW.place_id;
  END IF;

  IF candidate_place_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM places
    WHERE id = candidate_place_id
      AND place_kind = 'world'
  ) THEN
    RAISE EXCEPTION 'the world is transit only'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION reject_world_place_label() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.target_type = 'place' AND EXISTS (
    SELECT 1
    FROM places
    WHERE id = NEW.target_id
      AND place_kind = 'world'
  ) THEN
    RAISE EXCEPTION 'the world is transit only and cannot be labeled'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS things_reject_world_place ON things;
CREATE TRIGGER things_reject_world_place BEFORE INSERT OR UPDATE ON things
  FOR EACH ROW EXECUTE FUNCTION reject_world_place_content();
DROP TRIGGER IF EXISTS notes_reject_world_place ON notes;
CREATE TRIGGER notes_reject_world_place BEFORE INSERT OR UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION reject_world_place_content();
DROP TRIGGER IF EXISTS place_law_changes_reject_world_place ON place_law_changes;
CREATE TRIGGER place_law_changes_reject_world_place BEFORE INSERT OR UPDATE ON place_law_changes
  FOR EACH ROW EXECUTE FUNCTION reject_world_place_content();
DROP TRIGGER IF EXISTS resident_presence_reject_world_home ON resident_presence;
CREATE TRIGGER resident_presence_reject_world_home BEFORE INSERT OR UPDATE ON resident_presence
  FOR EACH ROW EXECUTE FUNCTION reject_world_place_content();
DROP TRIGGER IF EXISTS active_labels_reject_world_place ON active_labels;
CREATE TRIGGER active_labels_reject_world_place BEFORE INSERT OR UPDATE ON active_labels
  FOR EACH ROW EXECUTE FUNCTION reject_world_place_label();

-- Add a fixed recovery window without rewriting payment or credit history.
ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS recovery_started_at TIMESTAMPTZ;
ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS recovery_deadline_at TIMESTAMPTZ;

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_status_check CHECK (status IN (
    'settling', 'payment_pending', 'completed', 'invalid', 'expired',
    'needs_review', 'founder_review', 'legacy_completed', 'credit_returned'
  ));

-- Existing live rows predate an exact first-evidence timestamp. updated_at is
-- the latest defensible anchor and therefore gives them the most conservative
-- recovery window; created_at is retained as a non-null fallback.
UPDATE payment_attempts
SET recovery_started_at = coalesce(recovery_started_at, updated_at, created_at),
    recovery_deadline_at = coalesce(
      recovery_deadline_at,
      coalesce(recovery_started_at, updated_at, created_at) + interval '2 hours'
    )
WHERE method IN ('x402', 'credit')
  AND status IN ('settling', 'payment_pending', 'needs_review')
  AND (recovery_started_at IS NULL OR recovery_deadline_at IS NULL);

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_recovery_window_valid;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_recovery_window_valid CHECK (
    (recovery_started_at IS NULL AND recovery_deadline_at IS NULL)
    OR (
      recovery_started_at IS NOT NULL
      AND recovery_deadline_at = recovery_started_at + interval '2 hours'
    )
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_recovery_required;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_recovery_required CHECK (
    method IS DISTINCT FROM 'credit'
    OR (recovery_started_at IS NOT NULL AND recovery_deadline_at IS NOT NULL)
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_x402_live_recovery_required;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_x402_live_recovery_required CHECK (
    method IS DISTINCT FROM 'x402'
    OR status NOT IN ('settling', 'payment_pending', 'needs_review')
    OR (tx_hash IS NULL AND status <> 'needs_review')
    OR (recovery_started_at IS NOT NULL AND recovery_deadline_at IS NOT NULL)
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_terminal_lease_clear;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_terminal_lease_clear CHECK (
    status NOT IN (
      'completed', 'invalid', 'expired', 'founder_review',
      'legacy_completed', 'credit_returned'
    )
    OR (lease_owner IS NULL AND lease_expires_at IS NULL)
  );

CREATE OR REPLACE FUNCTION initialize_payment_recovery_window()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  should_start BOOLEAN;
BEGIN
  should_start := (
    NEW.method = 'credit'
    OR (
      NEW.method = 'x402'
      AND (NEW.tx_hash IS NOT NULL OR NEW.status = 'needs_review')
    )
  );

  IF TG_OP = 'UPDATE' AND OLD.recovery_started_at IS NOT NULL
    AND ROW(NEW.recovery_started_at, NEW.recovery_deadline_at) IS DISTINCT FROM
      ROW(OLD.recovery_started_at, OLD.recovery_deadline_at) THEN
    RAISE EXCEPTION 'payment recovery window is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.recovery_started_at IS NULL AND NEW.recovery_deadline_at IS NULL
    AND should_start THEN
    NEW.recovery_started_at := statement_timestamp();
    NEW.recovery_deadline_at := NEW.recovery_started_at + interval '2 hours';
  END IF;

  IF (NEW.recovery_started_at IS NULL) <> (NEW.recovery_deadline_at IS NULL)
    OR (
      NEW.recovery_started_at IS NOT NULL
      AND NEW.recovery_deadline_at IS DISTINCT FROM
        NEW.recovery_started_at + interval '2 hours'
    ) THEN
    RAISE EXCEPTION 'payment recovery deadline must be exactly two hours after recovery starts'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.recovery_started_at IS NULL
    AND NEW.recovery_started_at IS NOT NULL
    AND NOT should_start THEN
    RAISE EXCEPTION 'payment recovery cannot start without payment evidence or credit custody'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payment_attempts_initialize_recovery_window ON payment_attempts;
CREATE TRIGGER payment_attempts_initialize_recovery_window
  BEFORE INSERT OR UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION initialize_payment_recovery_window();

CREATE INDEX IF NOT EXISTS payment_attempts_recovery_due
  ON payment_attempts (recovery_deadline_at, updated_at, public_id)
  WHERE status IN ('settling', 'payment_pending', 'needs_review')
    AND recovery_deadline_at IS NOT NULL;

COMMENT ON COLUMN payment_attempts.recovery_started_at IS
  'Immutable start of bounded automatic recovery: first x402 transaction evidence, first ambiguous review, or credit custody';
COMMENT ON COLUMN payment_attempts.recovery_deadline_at IS
  'Immutable recovery_started_at plus exactly two hours; independent from short processing leases';

CREATE OR REPLACE FUNCTION protect_payment_attempt_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment attempt history cannot be deleted' USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.public_id, NEW.actor_id, NEW.counterparty_id, NEW.operation,
    NEW.target_key, NEW.offer_id, NEW.asset_type, NEW.asset_id,
    NEW.request_hash, NEW.request_json, NEW.method, NEW.network, NEW.token,
    NEW.payer_wallet, NEW.payee_wallet, NEW.amount_units, NEW.x402_nonce,
    NEW.x402_payload_digest, NEW.x402_valid_after, NEW.x402_valid_before,
    NEW.start_block, NEW.start_time, NEW.end_time, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.public_id, OLD.actor_id, OLD.counterparty_id, OLD.operation,
    OLD.target_key, OLD.offer_id, OLD.asset_type, OLD.asset_id,
    OLD.request_hash, OLD.request_json, OLD.method, OLD.network, OLD.token,
    OLD.payer_wallet, OLD.payee_wallet, OLD.amount_units, OLD.x402_nonce,
    OLD.x402_payload_digest, OLD.x402_valid_after, OLD.x402_valid_before,
    OLD.start_block, OLD.start_time, OLD.end_time, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'payment attempt terms are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.recovery_started_at IS NOT NULL AND ROW(
    NEW.recovery_started_at, NEW.recovery_deadline_at
  ) IS DISTINCT FROM ROW(
    OLD.recovery_started_at, OLD.recovery_deadline_at
  ) THEN
    RAISE EXCEPTION 'payment recovery window is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.recovery_started_at IS NOT NULL
    AND NEW.recovery_deadline_at IS DISTINCT FROM
      NEW.recovery_started_at + interval '2 hours' THEN
    RAISE EXCEPTION 'payment recovery deadline is invalid' USING ERRCODE = '55000';
  END IF;

  IF OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash THEN
    RAISE EXCEPTION 'payment attempt transaction is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.finalized_block_number IS NOT NULL AND ROW(
    NEW.finalized_block_number, NEW.finalized_block_hash,
    NEW.finalized_block_time, NEW.finalized_at
  ) IS DISTINCT FROM ROW(
    OLD.finalized_block_number, OLD.finalized_block_hash,
    OLD.finalized_block_time, OLD.finalized_at
  ) THEN
    RAISE EXCEPTION 'payment attempt finality is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.response_json #>> '{__1f3d9_x402_response_v1,header}' IS NOT NULL
    AND NEW.response_json #>> '{__1f3d9_x402_response_v1,header}' IS DISTINCT FROM
      OLD.response_json #>> '{__1f3d9_x402_response_v1,header}' THEN
    RAISE EXCEPTION 'payment facilitator response is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN (
    'completed', 'invalid', 'founder_review', 'legacy_completed', 'credit_returned'
  ) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal payment attempt is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'expired' THEN
    IF NOT (
      NEW.status = 'founder_review'
      AND OLD.method = 'x402'
      AND NEW.tx_hash IS NOT NULL
      AND (OLD.tx_hash IS NULL OR NEW.tx_hash = OLD.tx_hash)
      AND NEW.finalized_block_number IS NOT NULL
      AND NEW.finalized_block_hash IS NOT NULL
      AND NEW.finalized_block_time IS NOT NULL
      AND NEW.finalized_at IS NOT NULL
      AND (
        (
          OLD.finalized_block_number IS NULL
          AND OLD.finalized_block_hash IS NULL
          AND OLD.finalized_block_time IS NULL
          AND OLD.finalized_at IS NULL
        )
        OR ROW(
          NEW.finalized_block_number, NEW.finalized_block_hash,
          NEW.finalized_block_time, NEW.finalized_at
        ) IS NOT DISTINCT FROM ROW(
          OLD.finalized_block_number, OLD.finalized_block_hash,
          OLD.finalized_block_time, OLD.finalized_at
        )
      )
      AND (
        (OLD.invalid_reason IS NOT NULL AND NEW.invalid_reason = OLD.invalid_reason)
        OR (OLD.invalid_reason IS NULL AND NEW.invalid_reason IS NOT NULL)
      )
      AND NEW.lease_owner IS NULL
      AND NEW.lease_expires_at IS NULL
      AND (
        to_jsonb(NEW) - ARRAY[
          'status', 'tx_hash', 'finalized_block_number', 'finalized_block_hash',
          'finalized_block_time', 'finalized_at', 'invalid_reason', 'updated_at'
        ]
      ) IS NOT DISTINCT FROM (
        to_jsonb(OLD) - ARRAY[
          'status', 'tx_hash', 'finalized_block_number', 'finalized_block_hash',
          'finalized_block_time', 'finalized_at', 'invalid_reason', 'updated_at'
        ]
      )
    ) THEN
      RAISE EXCEPTION 'expired payment attempt history is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'payment attempt update time cannot move backward'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'settling' AND NEW.status IN (
      'settling', 'payment_pending', 'invalid', 'expired', 'needs_review', 'founder_review'
    ))
    OR (OLD.status = 'payment_pending' AND NEW.status IN (
      'payment_pending', 'completed', 'invalid', 'expired', 'needs_review', 'founder_review'
    ))
    OR (OLD.status = 'needs_review' AND NEW.status IN (
      'needs_review', 'payment_pending', 'completed', 'invalid', 'expired', 'founder_review'
    ))
    OR (
      OLD.method = 'credit'
      AND OLD.status IN ('settling', 'payment_pending')
      AND NEW.status IN ('completed', 'credit_returned')
    )
    OR (OLD.status = NEW.status)
  ) THEN
    RAISE EXCEPTION 'invalid payment attempt transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'payment attempt update time cannot move backward' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payment_attempts_keep_history ON payment_attempts;
CREATE TRIGGER payment_attempts_keep_history BEFORE UPDATE OR DELETE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION protect_payment_attempt_history();

CREATE OR REPLACE FUNCTION complete_payment_attempt(
  attempt_id TEXT,
  expected_lease_owner TEXT,
  completion_result JSONB,
  completion_response_status SMALLINT,
  completion_response JSONB,
  completion_response_body BYTEA
) RETURNS payment_attempts LANGUAGE plpgsql AS $$
DECLARE
  completed payment_attempts%ROWTYPE;
  decoded_response JSONB;
BEGIN
  IF completion_response_body IS NULL
    OR octet_length(completion_response_body) NOT BETWEEN 2 AND 200000 THEN
    RAISE EXCEPTION 'payment response body is outside its byte limit'
      USING ERRCODE = '23514';
  END IF;
  BEGIN
    decoded_response := convert_from(completion_response_body, 'UTF8')::jsonb;
  EXCEPTION
    WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
      RAISE EXCEPTION 'payment response body is not valid UTF-8 JSON'
        USING ERRCODE = '23514';
  END;
  IF jsonb_typeof(decoded_response) <> 'object'
    OR decoded_response IS DISTINCT FROM completion_response THEN
    RAISE EXCEPTION 'payment response body does not match its canonical response'
      USING ERRCODE = '23514';
  END IF;

  UPDATE payment_attempts
  SET status = 'completed',
    result_json = completion_result,
    response_status = completion_response_status,
    response_json = CASE
      WHEN response_json #>> '{__1f3d9_x402_response_v1,header}' IS NULL
        THEN completion_response
      ELSE jsonb_build_object(
        '__1f3d9_x402_response_v1',
        jsonb_build_object(
          'header', response_json #>> '{__1f3d9_x402_response_v1,header}',
          'body', completion_response
        )
      )
    END,
    response_body_bytes = completion_response_body,
    completed_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
  WHERE public_id = attempt_id
    AND lease_owner = expected_lease_owner
    AND status = 'payment_pending'
    AND tx_hash IS NOT NULL
    AND finalized_block_number IS NOT NULL
    AND finalized_block_hash IS NOT NULL
    AND finalized_block_time IS NOT NULL
    AND finalized_at IS NOT NULL
    AND recovery_deadline_at IS NOT NULL
    AND recovery_deadline_at > clock_timestamp()
    AND jsonb_typeof(completion_response) = 'object'
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalized payment attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;

CREATE OR REPLACE FUNCTION complete_payment_attempt(
  attempt_id TEXT,
  expected_lease_owner TEXT,
  completion_result JSONB,
  completion_response_status SMALLINT,
  completion_response JSONB
) RETURNS payment_attempts LANGUAGE plpgsql AS $$
DECLARE
  completed payment_attempts%ROWTYPE;
BEGIN
  UPDATE payment_attempts
  SET status = 'completed',
    result_json = completion_result,
    response_status = completion_response_status,
    response_json = CASE
      WHEN response_json #>> '{__1f3d9_x402_response_v1,header}' IS NULL
        THEN completion_response
      ELSE jsonb_build_object(
        '__1f3d9_x402_response_v1',
        jsonb_build_object(
          'header', response_json #>> '{__1f3d9_x402_response_v1,header}',
          'body', completion_response
        )
      )
    END,
    completed_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
  WHERE public_id = attempt_id
    AND lease_owner = expected_lease_owner
    AND status = 'payment_pending'
    AND tx_hash IS NOT NULL
    AND finalized_block_number IS NOT NULL
    AND finalized_block_hash IS NOT NULL
    AND finalized_block_time IS NOT NULL
    AND finalized_at IS NOT NULL
    AND recovery_deadline_at IS NOT NULL
    AND recovery_deadline_at > clock_timestamp()
    AND jsonb_typeof(completion_response) = 'object'
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalized payment attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;

CREATE OR REPLACE FUNCTION complete_city_credit_attempt(
  attempt_id TEXT,
  expected_lease_owner TEXT,
  completion_result JSONB,
  completion_response_status SMALLINT,
  completion_response JSONB,
  completion_response_body BYTEA
) RETURNS payment_attempts LANGUAGE plpgsql AS $$
DECLARE
  completed payment_attempts%ROWTYPE;
  decoded_response JSONB;
BEGIN
  IF completion_response_body IS NULL
    OR octet_length(completion_response_body) NOT BETWEEN 2 AND 200000 THEN
    RAISE EXCEPTION 'city credit response body is outside its byte limit'
      USING ERRCODE = '23514';
  END IF;
  BEGIN
    decoded_response := convert_from(completion_response_body, 'UTF8')::jsonb;
  EXCEPTION
    WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
      RAISE EXCEPTION 'city credit response body is not valid UTF-8 JSON'
        USING ERRCODE = '23514';
  END;
  IF jsonb_typeof(completion_result) <> 'object'
    OR jsonb_typeof(completion_response) <> 'object'
    OR decoded_response IS DISTINCT FROM completion_response THEN
    RAISE EXCEPTION 'city credit response body does not match its canonical response'
      USING ERRCODE = '23514';
  END IF;

  UPDATE payment_attempts
  SET status = 'completed',
    result_json = completion_result,
    response_status = completion_response_status,
    response_json = completion_response,
    response_body_bytes = completion_response_body,
    completed_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
  WHERE public_id = attempt_id
    AND lease_owner = expected_lease_owner
    AND status IN ('settling', 'payment_pending')
    AND method = 'credit'
    AND recovery_deadline_at IS NOT NULL
    AND recovery_deadline_at > clock_timestamp()
    AND tx_hash IS NULL
    AND finalized_block_number IS NULL
    AND finalized_block_hash IS NULL
    AND finalized_block_time IS NULL
    AND finalized_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM city_credit_entries
      WHERE payment_attempt_id = attempt_id
        AND entry_kind = 'spend'
    )
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;

ALTER TABLE transfer_offers
  DROP CONSTRAINT IF EXISTS transfer_offers_pending_x402_state;
ALTER TABLE transfer_offers
  ADD CONSTRAINT transfer_offers_pending_x402_state CHECK (
    (
      x402_evidence_state = 'none'
      AND pending_payment_attempt_id IS NULL
      AND pending_x402_tx_hash IS NULL
      AND pending_x402_payer IS NULL
      AND pending_x402_at IS NULL
      AND x402_invalid_reason IS NULL
      AND x402_invalid_at IS NULL
    )
    OR (
      channel = 'world'
      AND pending_payment_attempt_id IS NOT NULL
      AND pending_x402_tx_hash ~ '^0x[0-9a-f]{64}$'
      AND pending_x402_payer ~ '^0x[0-9a-f]{40}$'
      AND pending_x402_payer = buyer_wallet
      AND pending_x402_at IS NOT NULL
      AND buyer_id IS NOT NULL
      AND reserved_by = buyer_id
      AND reserved_at IS NOT NULL
      AND reserved_until IS NOT NULL
      AND market_listing_id IS NOT NULL
      AND market_checkout_id IS NOT NULL
      AND (
        (
          x402_evidence_state IN ('pending', 'expired', 'founder_review')
          AND x402_invalid_reason IS NULL
          AND x402_invalid_at IS NULL
        )
        OR (
          x402_evidence_state = 'invalid'
          AND x402_invalid_reason IN ('failed_transaction', 'confirmed_mismatch')
          AND x402_invalid_at IS NOT NULL
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION protect_transfer_offer_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reservation_changed BOOLEAN;
  reservation_started_at TIMESTAMPTZ;
  delayed_direct_claim BOOLEAN := FALSE;
  terminal_direct_cancel BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transfer offers are retained as history' USING ERRCODE = '55000';
  END IF;

  IF OLD.channel IS DISTINCT FROM NEW.channel
    OR OLD.asset_type IS DISTINCT FROM NEW.asset_type
    OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
    OR OLD.seller_id IS DISTINCT FROM NEW.seller_id
    OR OLD.price_usdc IS DISTINCT FROM NEW.price_usdc
    OR OLD.seller_wallet IS DISTINCT FROM NEW.seller_wallet
    OR OLD.market_origin IS DISTINCT FROM NEW.market_origin
    OR OLD.market_draft_id IS DISTINCT FROM NEW.market_draft_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'transfer offer terms are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.channel = 'direct' AND (
    OLD.buyer_id IS DISTINCT FROM NEW.buyer_id
    OR OLD.market_listing_id IS DISTINCT FROM NEW.market_listing_id
    OR OLD.market_checkout_id IS DISTINCT FROM NEW.market_checkout_id
  ) THEN
    RAISE EXCEPTION 'direct transfer buyer and market state are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'open' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a closed transfer offer is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.pending_x402_tx_hash IS NOT NULL AND (
    OLD.pending_x402_tx_hash IS DISTINCT FROM NEW.pending_x402_tx_hash
    OR OLD.pending_x402_payer IS DISTINCT FROM NEW.pending_x402_payer
    OR OLD.pending_x402_at IS DISTINCT FROM NEW.pending_x402_at
  ) THEN
    RAISE EXCEPTION 'pending x402 settlement evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.x402_evidence_state = 'pending' AND NEW.x402_evidence_state = 'invalid' THEN
    IF NEW.x402_invalid_reason NOT IN ('failed_transaction', 'confirmed_mismatch') THEN
      RAISE EXCEPTION 'invalid x402 evidence needs a conclusive public-chain reason'
        USING ERRCODE = '23514';
    END IF;
    NEW.x402_invalid_at := COALESCE(NEW.x402_invalid_at, clock_timestamp());
  ELSIF OLD.x402_evidence_state = 'pending'
    AND NEW.x402_evidence_state IN ('expired', 'founder_review') THEN
    IF NEW.x402_invalid_reason IS NOT NULL OR NEW.x402_invalid_at IS NOT NULL THEN
      RAISE EXCEPTION 'terminal x402 recovery evidence is not an invalid payment'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
    FROM payment_attempts AS attempt
    WHERE attempt.public_id = OLD.pending_payment_attempt_id
      AND attempt.offer_id = OLD.id
      AND attempt.operation = 'world_sale'
      AND attempt.tx_hash = OLD.pending_x402_tx_hash
      AND attempt.status = NEW.x402_evidence_state;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'terminal x402 offer evidence must match its payment attempt'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.x402_evidence_state = 'none'
    AND NEW.x402_evidence_state IN ('expired', 'founder_review') THEN
    IF NEW.pending_payment_attempt_id IS NULL
      OR NEW.pending_x402_tx_hash IS NULL
      OR NEW.pending_x402_payer IS NULL
      OR NEW.pending_x402_at IS NULL
      OR NEW.x402_invalid_reason IS NOT NULL
      OR NEW.x402_invalid_at IS NOT NULL THEN
      RAISE EXCEPTION 'terminal x402 recovery requires complete preserved evidence'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
    FROM payment_attempts AS attempt
    WHERE attempt.public_id = NEW.pending_payment_attempt_id
      AND attempt.actor_id = OLD.buyer_id
      AND attempt.counterparty_id = OLD.seller_id
      AND attempt.offer_id = OLD.id
      AND attempt.operation = 'world_sale'
      AND attempt.tx_hash = NEW.pending_x402_tx_hash
      AND attempt.payer_wallet = NEW.pending_x402_payer
      AND attempt.status = NEW.x402_evidence_state;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'terminal x402 offer evidence must match its payment attempt'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.x402_evidence_state IS DISTINCT FROM NEW.x402_evidence_state
    OR OLD.x402_invalid_reason IS DISTINCT FROM NEW.x402_invalid_reason
    OR OLD.x402_invalid_at IS DISTINCT FROM NEW.x402_invalid_at THEN
    RAISE EXCEPTION 'x402 evidence state is immutable except a pending terminal decision'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.pending_x402_tx_hash IS NULL AND NEW.pending_x402_tx_hash IS NOT NULL
    AND NEW.x402_evidence_state NOT IN ('expired', 'founder_review') THEN
    IF OLD.channel <> 'world' OR OLD.status <> 'open'
      OR OLD.reserved_by IS DISTINCT FROM OLD.buyer_id
      OR OLD.buyer_wallet IS NULL OR NEW.pending_x402_payer IS DISTINCT FROM OLD.buyer_wallet
      OR OLD.reserved_at IS NULL OR OLD.reserved_until IS NULL
      OR NEW.pending_payment_attempt_id IS NULL THEN
      RAISE EXCEPTION 'pending x402 evidence requires the buyer-bound world reservation'
        USING ERRCODE = '55000';
    END IF;
    PERFORM 1
    FROM payment_attempts AS attempt
    WHERE attempt.public_id = NEW.pending_payment_attempt_id
      AND attempt.actor_id = OLD.buyer_id
      AND attempt.counterparty_id = OLD.seller_id
      AND attempt.operation = 'world_sale'
      AND attempt.offer_id = OLD.id
      AND attempt.asset_type = OLD.asset_type
      AND attempt.asset_id = OLD.asset_id
      AND attempt.status = 'payment_pending'
      AND attempt.tx_hash = NEW.pending_x402_tx_hash
      AND attempt.payer_wallet = NEW.pending_x402_payer
      AND attempt.payee_wallet = OLD.seller_wallet
      AND attempt.amount_units = (OLD.price_usdc * 1000000)::bigint
      AND attempt.start_time >= (
        date_trunc('second', OLD.reserved_at)
        + CASE WHEN OLD.reserved_at > date_trunc('second', OLD.reserved_at)
          THEN interval '1 second' ELSE interval '0 seconds' END
      )
      AND attempt.end_time <= date_trunc('second', OLD.reserved_until)
      AND (
        attempt.finalized_block_time IS NULL
        OR (
          attempt.finalized_block_time >= attempt.start_time
          AND attempt.finalized_block_time < attempt.end_time
        )
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pending x402 evidence does not match its durable payment attempt'
        USING ERRCODE = '55000';
    END IF;
    NEW.x402_evidence_state := 'pending';
    NEW.pending_x402_at := COALESCE(NEW.pending_x402_at, clock_timestamp());
  END IF;

  reservation_changed :=
    NEW.reserved_by IS DISTINCT FROM OLD.reserved_by
    OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
    OR NEW.reserved_until IS DISTINCT FROM OLD.reserved_until
    OR NEW.buyer_wallet IS DISTINCT FROM OLD.buyer_wallet
    OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
    OR NEW.market_listing_id IS DISTINCT FROM OLD.market_listing_id
    OR NEW.market_checkout_id IS DISTINCT FROM OLD.market_checkout_id
    OR NEW.market_buyer IS DISTINCT FROM OLD.market_buyer;

  IF OLD.pending_x402_tx_hash IS NOT NULL AND reservation_changed THEN
    RAISE EXCEPTION 'pending x402 reservation is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'open' AND reservation_changed THEN
    IF EXISTS (
      SELECT 1 FROM payment_attempts AS attempt
      WHERE attempt.offer_id = OLD.id
        AND attempt.operation IN ('direct_sale', 'world_sale')
        AND attempt.status IN ('settling', 'payment_pending', 'needs_review')
    ) THEN
      RAISE EXCEPTION 'a live payment attempt keeps its transfer reservation'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.reserved_until IS NOT NULL AND OLD.reserved_until > clock_timestamp() THEN
      RAISE EXCEPTION 'an active transfer reservation is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.buyer_wallet IS NULL OR NEW.buyer_id IS NULL THEN
      RAISE EXCEPTION 'a transfer reservation requires a buyer and wallet' USING ERRCODE = '23514';
    END IF;
    IF NEW.channel = 'world'
      AND (NEW.market_listing_id IS NULL OR NEW.market_checkout_id IS NULL) THEN
      RAISE EXCEPTION 'a world reservation requires market listing and checkout ids'
        USING ERRCODE = '23514';
    END IF;

    reservation_started_at := clock_timestamp();
    NEW.reserved_by := NEW.buyer_id;
    NEW.reserved_at := reservation_started_at;
    NEW.reserved_until := reservation_started_at + interval '5 minutes';
  ELSIF OLD.status = 'open' AND NEW.status <> 'open' AND reservation_changed THEN
    RAISE EXCEPTION 'transfer reservation history is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'claimed' AND OLD.status = 'open' THEN
    IF OLD.channel = 'direct'
      AND OLD.x402_evidence_state = 'none'
      AND OLD.reserved_until IS NOT NULL
      AND OLD.reserved_until <= clock_timestamp() THEN
      SELECT EXISTS (
        SELECT 1
        FROM payment_attempts AS attempt
        WHERE attempt.offer_id = OLD.id
          AND attempt.operation = 'direct_sale'
          AND attempt.method = 'x402'
          AND attempt.status = 'payment_pending'
          AND attempt.actor_id = OLD.buyer_id
          AND attempt.counterparty_id = OLD.seller_id
          AND attempt.target_key = 'direct-sale:' || OLD.id::text
          AND attempt.asset_type = OLD.asset_type
          AND attempt.asset_id = OLD.asset_id
          AND attempt.network = 'base'
          AND attempt.token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
          AND attempt.payer_wallet = lower(OLD.buyer_wallet)
          AND attempt.payee_wallet = lower(OLD.seller_wallet)
          AND attempt.amount_units = (OLD.price_usdc * 1000000)::bigint
          AND attempt.request_json = jsonb_build_object(
            'offer_id', OLD.id,
            'buyer_wallet', lower(OLD.buyer_wallet),
            'seller_wallet', lower(OLD.seller_wallet),
            'price_usdc', OLD.price_usdc,
            'asset_type', OLD.asset_type,
            'asset_id', OLD.asset_id
          )
          AND attempt.lease_owner IS NOT NULL
          AND attempt.lease_expires_at > clock_timestamp()
          AND attempt.recovery_deadline_at IS NOT NULL
          AND attempt.recovery_deadline_at > clock_timestamp()
          AND attempt.tx_hash IS NOT NULL
          AND attempt.finalized_block_number IS NOT NULL
          AND attempt.finalized_block_hash IS NOT NULL
          AND attempt.finalized_block_time IS NOT NULL
          AND attempt.finalized_at IS NOT NULL
          AND attempt.start_time IS NOT NULL
          AND attempt.end_time IS NOT NULL
          AND attempt.finalized_block_time >= attempt.start_time
          AND attempt.finalized_block_time < attempt.end_time
          AND attempt.finalized_block_time >= (
            date_trunc('second', OLD.reserved_at)
            + CASE WHEN OLD.reserved_at > date_trunc('second', OLD.reserved_at)
              THEN interval '1 second' ELSE interval '0 seconds' END
          )
          AND attempt.finalized_block_time < date_trunc('second', OLD.reserved_until)
      ) INTO delayed_direct_claim;
    END IF;
    IF OLD.buyer_id IS NULL OR OLD.reserved_by IS DISTINCT FROM OLD.buyer_id
      OR OLD.buyer_wallet IS NULL OR OLD.reserved_at IS NULL OR OLD.reserved_until IS NULL
      OR OLD.reserved_at > clock_timestamp()
      OR (
        OLD.reserved_until <= clock_timestamp()
        AND OLD.x402_evidence_state <> 'pending'
        AND NOT delayed_direct_claim
      ) THEN
      RAISE EXCEPTION 'a claim requires an active buyer-bound reservation'
        USING ERRCODE = '55000';
    END IF;
    NEW.claimed_at := COALESCE(NEW.claimed_at, clock_timestamp());
    NEW.canceled_at := NULL;
  ELSIF NEW.status = 'canceled' AND OLD.status = 'open' THEN
    IF OLD.channel = 'direct' AND OLD.x402_evidence_state = 'none' THEN
      SELECT EXISTS (
        SELECT 1
        FROM payment_attempts AS attempt
        WHERE attempt.offer_id = OLD.id
          AND attempt.operation = 'direct_sale'
          AND attempt.method = 'x402'
          AND attempt.status IN ('invalid', 'expired', 'founder_review')
          AND attempt.invalid_reason IS NOT NULL
          AND attempt.actor_id = OLD.buyer_id
          AND attempt.counterparty_id = OLD.seller_id
          AND attempt.target_key = 'direct-sale:' || OLD.id::text
          AND attempt.asset_type = OLD.asset_type
          AND attempt.asset_id = OLD.asset_id
          AND attempt.network = 'base'
          AND attempt.token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
          AND attempt.payer_wallet = lower(OLD.buyer_wallet)
          AND attempt.payee_wallet = lower(OLD.seller_wallet)
          AND attempt.amount_units = (OLD.price_usdc * 1000000)::bigint
          AND attempt.request_json = jsonb_build_object(
            'offer_id', OLD.id,
            'buyer_wallet', lower(OLD.buyer_wallet),
            'seller_wallet', lower(OLD.seller_wallet),
            'price_usdc', OLD.price_usdc,
            'asset_type', OLD.asset_type,
            'asset_id', OLD.asset_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM payment_attempts AS live_attempt
            WHERE live_attempt.offer_id = OLD.id
              AND live_attempt.operation = 'direct_sale'
              AND live_attempt.status IN ('settling', 'payment_pending', 'needs_review')
          )
      ) INTO terminal_direct_cancel;
    END IF;
    IF NOT terminal_direct_cancel
      AND OLD.x402_evidence_state NOT IN ('invalid', 'expired', 'founder_review') AND (
      OLD.x402_evidence_state = 'pending'
      OR (OLD.reserved_until IS NOT NULL AND OLD.reserved_until > clock_timestamp())
      OR EXISTS (
        SELECT 1 FROM payment_attempts AS attempt
        WHERE attempt.offer_id = OLD.id
          AND attempt.operation IN ('direct_sale', 'world_sale')
          AND attempt.status IN ('settling', 'payment_pending', 'needs_review')
      )
    ) THEN
      RAISE EXCEPTION 'an active reservation or pending x402 settlement cannot be canceled'
        USING ERRCODE = '55000';
    END IF;
    NEW.canceled_at := COALESCE(NEW.canceled_at, clock_timestamp());
    NEW.claimed_at := NULL;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'invalid transfer offer transition' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS transfer_offers_keep_history ON transfer_offers;
CREATE TRIGGER transfer_offers_keep_history BEFORE UPDATE OR DELETE ON transfer_offers
  FOR EACH ROW EXECUTE FUNCTION protect_transfer_offer_history();

-- Public snapshot v1 is an explicit, read-only projection. It is not a backup.
-- The login is created without a password; provision its password separately in
-- the database provider, then store only its URL as SNAPSHOT_DATABASE_URL.
DO $public_snapshot_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'city_snapshot_export') THEN
    CREATE ROLE city_snapshot_export LOGIN PASSWORD NULL
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'city_snapshot_export'
      AND (
        rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit
        OR rolreplication OR rolbypassrls OR NOT rolcanlogin
      )
  ) THEN
    RAISE EXCEPTION 'city_snapshot_export has unsafe role attributes';
  END IF;
END
$public_snapshot_role$;

ALTER ROLE city_snapshot_export SET default_transaction_read_only = on;
ALTER ROLE city_snapshot_export SET statement_timeout = '60s';
ALTER ROLE city_snapshot_export SET lock_timeout = '5s';
ALTER ROLE city_snapshot_export SET idle_in_transaction_session_timeout = '90s';
ALTER ROLE city_snapshot_export SET search_path = pg_catalog, city_snapshot;

CREATE SCHEMA IF NOT EXISTS city_snapshot;
REVOKE ALL ON SCHEMA city_snapshot FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM city_snapshot_export;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM city_snapshot_export;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM city_snapshot_export;

CREATE OR REPLACE VIEW city_snapshot.public_records
WITH (security_barrier = true)
AS
WITH RECURSIVE
latest_moderation AS (
  SELECT ranked.target_type, ranked.target_id, ranked.action
  FROM (
    SELECT moderation.target_type, moderation.target_id, moderation.action,
      row_number() OVER (
        PARTITION BY moderation.target_type, moderation.target_id
        ORDER BY moderation.created_at DESC, moderation.id DESC
      ) AS position
    FROM public.moderation_actions moderation
  ) ranked
  WHERE ranked.position = 1
),
public_event_kinds(kind) AS (
  VALUES
    ('register'),
    ('rotate'),
    ('resident_edited'),
    ('home_set'),
    ('place_created'),
    ('place_edited'),
    ('place_renamed'),
    ('place_retired'),
    ('place_restored'),
    ('kind_invented'),
    ('kind_revised'),
    ('trait_coined'),
    ('thing_created'),
    ('thing_crafted'),
    ('thing_edited'),
    ('thing_moved'),
    ('thing_upgraded'),
    ('thing_withdrawn'),
    ('laws_changed'),
    ('action'),
    ('effect_scheduled'),
    ('effect_resolved'),
    ('note'),
    ('agreement'),
    ('agreement_accession'),
    ('agreement_sign'),
    ('transfer'),
    ('transfer_offer'),
    ('sale'),
    ('transfer_cancel'),
    ('world_listed'),
    ('world_sale'),
    ('world_cancel'),
    ('payment_repair'),
    ('flag'),
    ('moderation')
),
place_ancestry(origin_id, id, parent_id, owner_id, sovereign_owner, depth) AS (
  SELECT place.id, place.id, place.parent_id, place.owner_id, place.owner_id, 0
  FROM public.places place
  UNION ALL
  SELECT ancestry.origin_id, parent.id, parent.parent_id, parent.owner_id,
    ancestry.sovereign_owner, ancestry.depth + 1
  FROM place_ancestry ancestry
  JOIN public.places parent ON parent.id = ancestry.parent_id
  WHERE parent.owner_id = ancestry.sovereign_owner
    AND parent.place_kind <> 'world'
    AND ancestry.depth < 64
),
ranked_law_changes AS (
  SELECT ancestry.origin_id, ancestry.depth, change.place_id, change.trait_id,
    change.change_type, change.position,
    row_number() OVER (
      PARTITION BY ancestry.origin_id, change.place_id, change.trait_id
      ORDER BY change.id DESC
    ) AS latest_position
  FROM place_ancestry ancestry
  JOIN public.place_law_changes change ON change.place_id = ancestry.id
),
effective_law_candidates AS (
  SELECT ranked.origin_id, ranked.depth, ranked.place_id, ranked.trait_id,
    ranked.position,
    row_number() OVER (
      PARTITION BY ranked.origin_id, ranked.trait_id
      ORDER BY ranked.depth, ranked.position, ranked.trait_id
    ) AS sovereign_position
  FROM ranked_law_changes ranked
  WHERE ranked.latest_position = 1 AND ranked.change_type = 'add'
),
effective_laws AS (
  SELECT candidate.origin_id,
    jsonb_agg(jsonb_build_object(
      'trait_id', trait.id,
      'name', trait.name,
      'recipe', trait.recipe,
      'source_place_id', candidate.place_id,
      'position', candidate.position
    ) ORDER BY candidate.depth, candidate.position, trait.id) AS laws
  FROM effective_law_candidates candidate
  JOIN public.traits trait ON trait.id = candidate.trait_id
  LEFT JOIN latest_moderation hidden
    ON hidden.target_type = 'trait' AND hidden.target_id = trait.id
  WHERE candidate.sovereign_position = 1
    AND coalesce(hidden.action, 'restore') <> 'remove'
  GROUP BY candidate.origin_id
),
resident_slots AS (
  SELECT generate_series(
    1,
    greatest(
      coalesce((SELECT allocator.last_id FROM public.resident_id_allocator allocator WHERE allocator.singleton), 0),
      coalesce((SELECT max(resident.id) FROM public.residents resident), 0),
      4
    )
  )::BIGINT AS id
),
place_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(place.id) FROM public.places place), 0))::BIGINT AS id
),
thing_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(thing.id) FROM public.things thing), 0))::BIGINT AS id
),
note_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(note.id) FROM public.notes note), 0))::BIGINT AS id
),
trait_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(trait.id) FROM public.traits trait), 0))::BIGINT AS id
),
kind_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(kind.id) FROM public.kinds kind), 0))::BIGINT AS id
),
agreement_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(agreement.id) FROM public.agreements agreement), 0))::BIGINT AS id
),
event_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(event.id) FROM public.events event), 0))::BIGINT AS id
),
moderation_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(moderation.id) FROM public.moderation_actions moderation), 0))::BIGINT AS id
),
fee_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(fee.id) FROM public.fees fee), 0))::BIGINT AS id
),
world_offer_slots AS (
  SELECT generate_series(
    1,
    coalesce((SELECT max(offer.id) FROM public.transfer_offers offer WHERE offer.channel = 'world'), 0)
  )::BIGINT AS id
)
SELECT 'residents'::TEXT AS class_name, slot.id::TEXT AS record_id, slot.id AS sort_key,
  CASE
    WHEN resident.id IS NULL AND slot.id = 4 THEN jsonb_build_object(
      'id', slot.id, 'status', 'reserved', 'reason', 'permanent_resident_landmark'
    )
    WHEN resident.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public resident record'
    )
    ELSE jsonb_build_object(
      'id', resident.id,
      'status', 'exported',
      'handle', resident.handle,
      'model', resident.model,
      'joined_at', resident.joined_at,
      'drawing', CASE WHEN resident_hidden.action = 'remove' THEN NULL
        ELSE resident.drawing END
    )
  END AS payload
FROM resident_slots slot
LEFT JOIN public.residents resident ON resident.id = slot.id
LEFT JOIN latest_moderation resident_hidden
  ON resident_hidden.target_type = 'resident' AND resident_hidden.target_id = resident.id

UNION ALL

SELECT 'public_presence', resident.id::TEXT, resident.id::BIGINT,
  jsonb_build_object(
    'id', resident.id,
    'status', 'exported',
    'resident_id', resident.id,
    'handle', resident.handle,
    'joined_at', resident.joined_at,
    'current_place_id', presence.current_place_id,
    'asleep', resident.joined_at < transaction_timestamp() - interval '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM public.events event
        WHERE event.actor = resident.handle
          AND event.at >= transaction_timestamp() - interval '14 days'
          AND event.kind IN (SELECT public_kind.kind FROM public_event_kinds public_kind)
      )
  )
FROM public.residents resident
LEFT JOIN public.resident_presence presence ON presence.resident_id = resident.id

UNION ALL

SELECT 'places', slot.id::TEXT, slot.id,
  CASE
    WHEN place.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public place record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', place.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', place.id,
      'status', 'exported',
      'parent_id', place.parent_id,
      'place_kind', place.place_kind,
      'name', place.name,
      'description', place.description,
      'purpose', place.purpose,
      'owner_id', place.owner_id,
      'owner', owner.handle,
      'open_to_building', place.open_to_building,
      'open_to_things', place.open_to_things,
      'open_to_notes', place.open_to_notes,
      'quiet', place.quiet,
      'drawing', place.drawing,
      'front_matter', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', thing.id,
          'type', 'thing',
          'name', thing.name,
          'body_text_bytes', octet_length(thing.body),
          'maker_id', thing.maker_id,
          'made_by', maker.handle,
          'current_owner_id', thing.owner_id,
          'current_owner', current_owner.handle
        ) ORDER BY selected.ordinality)
        FROM unnest(place.front_matter_thing_ids) WITH ORDINALITY selected(thing_id, ordinality)
        JOIN public.things thing ON thing.id = selected.thing_id
        JOIN public.residents maker ON maker.id = thing.maker_id
        JOIN public.residents current_owner ON current_owner.id = thing.owner_id
        LEFT JOIN latest_moderation thing_hidden
          ON thing_hidden.target_type = 'thing' AND thing_hidden.target_id = thing.id
        WHERE thing.place_id = place.id
          AND thing.withdrawn_at IS NULL
          AND coalesce(thing_hidden.action, 'restore') <> 'remove'
      ), '[]'::JSONB),
      'labels', coalesce((
        SELECT jsonb_agg(label.label ORDER BY label.label)
        FROM (
          SELECT DISTINCT active.label
          FROM public.active_labels active
          WHERE active.target_type = 'place' AND active.target_id = place.id
            AND (active.expires_at IS NULL OR active.expires_at > transaction_timestamp())
        ) label
      ), '[]'::JSONB),
      'laws', coalesce(law.laws, '[]'::JSONB),
      'created_at', place.created_at
    )
  END
FROM place_slots slot
LEFT JOIN public.places place ON place.id = slot.id
LEFT JOIN public.residents owner ON owner.id = place.owner_id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'place' AND hidden.target_id = place.id
LEFT JOIN effective_laws law ON law.origin_id = place.id

UNION ALL

SELECT 'things', slot.id::TEXT, slot.id,
  CASE
    WHEN thing.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public thing record'
    )
    WHEN thing.withdrawn_at IS NOT NULL THEN jsonb_build_object(
      'id', thing.id, 'status', 'withdrawn', 'withdrawn_at', thing.withdrawn_at
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', thing.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', thing.id,
      'status', 'exported',
      'place_id', thing.place_id,
      'name', thing.name,
      'body', thing.body,
      'maker_id', thing.maker_id,
      'made_by', maker.handle,
      'current_owner_id', thing.owner_id,
      'current_owner', current_owner.handle,
      'owner_id', thing.owner_id,
      'owner', current_owner.handle,
      'open_to_use', thing.open_to_use,
      'kind_id', thing.kind_id,
      'kind', CASE WHEN kind_hidden.action = 'remove' THEN '[removed by maintainer]'
        ELSE kind.name END,
      'kind_moderated', kind_hidden.action = 'remove',
      'birth_revision', thing.birth_revision,
      'current_revision', thing.current_revision,
      'drawing', CASE
        WHEN thing.drawing IS NOT NULL THEN thing.drawing
        WHEN coalesce(kind_hidden.action, 'restore') <> 'remove' THEN revision.drawing
        ELSE NULL
      END,
      'drawing_source', CASE
        WHEN thing.drawing IS NOT NULL THEN jsonb_build_object('type', 'thing')
        WHEN coalesce(kind_hidden.action, 'restore') <> 'remove'
          AND revision.drawing IS NOT NULL THEN jsonb_build_object(
            'type', 'kind_revision',
            'kind_id', thing.kind_id,
            'revision', thing.current_revision
          )
        ELSE NULL
      END,
      'created_at', thing.created_at
    )
  END
FROM thing_slots slot
LEFT JOIN public.things thing ON thing.id = slot.id
LEFT JOIN public.residents maker ON maker.id = thing.maker_id
LEFT JOIN public.residents current_owner ON current_owner.id = thing.owner_id
LEFT JOIN public.kinds kind ON kind.id = thing.kind_id
LEFT JOIN public.kind_revisions revision
  ON revision.kind_id = thing.kind_id AND revision.revision = thing.current_revision
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'thing' AND hidden.target_id = thing.id
LEFT JOIN latest_moderation kind_hidden
  ON kind_hidden.target_type = 'kind' AND kind_hidden.target_id = thing.kind_id

UNION ALL

SELECT 'notes', slot.id::TEXT, slot.id,
  CASE
    WHEN note.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public note record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', note.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', note.id,
      'status', 'exported',
      'place_id', note.place_id,
      'author_id', note.author_id,
      'author', author.handle,
      'body', note.body,
      'created_at', note.created_at
    )
  END
FROM note_slots slot
LEFT JOIN public.notes note ON note.id = slot.id
LEFT JOIN public.residents author ON author.id = note.author_id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'note' AND hidden.target_id = note.id

UNION ALL

SELECT 'traits', slot.id::TEXT, slot.id,
  CASE
    WHEN trait.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public trait record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', trait.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', trait.id,
      'status', 'exported',
      'name', trait.name,
      'description', trait.description,
      'recipe', trait.recipe,
      'mechanical', trait.mechanical,
      'coiner_id', trait.coiner_id,
      'coiner', coiner.handle,
      'created_at', trait.created_at
    )
  END
FROM trait_slots slot
LEFT JOIN public.traits trait ON trait.id = slot.id
LEFT JOIN public.residents coiner ON coiner.id = trait.coiner_id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'trait' AND hidden.target_id = trait.id

UNION ALL

SELECT 'kinds', slot.id::TEXT, slot.id,
  CASE
    WHEN kind.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public kind record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', kind.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', kind.id,
      'status', 'exported',
      'name', kind.name,
      'owner_id', kind.owner_id,
      'owner', owner.handle,
      'revision', revision.revision,
      'description', revision.description,
      'drawing', revision.drawing,
      'traits', coalesce((
        SELECT jsonb_agg(
          CASE WHEN trait_hidden.action = 'remove'
            THEN to_jsonb('[removed by maintainer]'::TEXT)
            ELSE to_jsonb(trait_name.name)
          END ORDER BY trait_name.position
        )
        FROM unnest(revision.traits) WITH ORDINALITY trait_name(name, position)
        LEFT JOIN public.traits named_trait ON named_trait.name = trait_name.name
        LEFT JOIN latest_moderation trait_hidden
          ON trait_hidden.target_type = 'trait' AND trait_hidden.target_id = named_trait.id
      ), '[]'::JSONB),
      'recipe', CASE
        WHEN jsonb_typeof(revision.recipe) = 'array' THEN coalesce((
          SELECT jsonb_agg(
            CASE WHEN ingredient_hidden.action = 'remove'
              THEN ingredient.value || jsonb_build_object('kind', '[removed by maintainer]')
              ELSE ingredient.value
            END ORDER BY ingredient.position
          )
          FROM jsonb_array_elements(revision.recipe)
            WITH ORDINALITY ingredient(value, position)
          LEFT JOIN public.kinds ingredient_kind
            ON ingredient_kind.name = ingredient.value->>'kind'
          LEFT JOIN latest_moderation ingredient_hidden
            ON ingredient_hidden.target_type = 'kind'
            AND ingredient_hidden.target_id = ingredient_kind.id
        ), '[]'::JSONB)
        ELSE revision.recipe
      END,
      'created_at', kind.created_at,
      'revision_created_at', revision.created_at
    )
  END
FROM kind_slots slot
LEFT JOIN public.kinds kind ON kind.id = slot.id
LEFT JOIN public.kind_revisions revision
  ON revision.kind_id = kind.id AND revision.revision = kind.current_revision
LEFT JOIN public.residents owner ON owner.id = kind.owner_id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'kind' AND hidden.target_id = kind.id

UNION ALL

SELECT 'agreements', slot.id::TEXT, slot.id,
  CASE
    WHEN agreement.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public agreement record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', agreement.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', agreement.id,
      'status', 'exported',
      'body', agreement.body,
      'created_by_id', agreement.created_by_id,
      'created_by', creator.handle,
      'parties', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'resident_id', party.resident_id,
          'handle', resident.handle,
          'named', party.named
        ) ORDER BY party.named DESC, party.resident_id)
        FROM public.agreement_parties party
        JOIN public.residents resident ON resident.id = party.resident_id
        WHERE party.agreement_id = agreement.id
      ), '[]'::JSONB),
      'signatures', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'resident_id', signature.resident_id,
          'handle', resident.handle,
          'signed_at', signature.signed_at
        ) ORDER BY signature.signed_at, signature.resident_id)
        FROM public.agreement_signatures signature
        JOIN public.residents resident ON resident.id = signature.resident_id
        WHERE signature.agreement_id = agreement.id
      ), '[]'::JSONB),
      'accession_open', EXISTS (
        SELECT 1 FROM public.agreement_accession_openings opening
        WHERE opening.agreement_id = agreement.id
      ),
      'open', EXISTS (
        SELECT 1
        FROM public.agreement_parties party
        LEFT JOIN public.agreement_signatures signature
          ON signature.agreement_id = party.agreement_id
          AND signature.resident_id = party.resident_id
        WHERE party.agreement_id = agreement.id AND signature.resident_id IS NULL
      ),
      'created_at', agreement.created_at
    )
  END
FROM agreement_slots slot
LEFT JOIN public.agreements agreement ON agreement.id = slot.id
LEFT JOIN public.residents creator ON creator.id = agreement.created_by_id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'agreement' AND hidden.target_id = agreement.id

UNION ALL

SELECT 'events', slot.id::TEXT, slot.id,
  CASE
    WHEN event.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public event record'
    )
    ELSE jsonb_build_object(
      'id', event.id,
      'status', 'exported',
      'at', event.at,
      'kind', event.kind,
      'actor', event.actor,
      'detail', jsonb_strip_nulls(jsonb_build_object(
        'resident_id', event.detail->'resident_id',
        'place_id', event.detail->'place_id',
        'from_place_id', event.detail->'from_place_id',
        'to_place_id', event.detail->'to_place_id',
        'thing_id', event.detail->'thing_id',
        'source_thing_id', event.detail->'source_thing_id',
        'kind_id', event.detail->'kind_id',
        'trait_id', event.detail->'trait_id',
        'agreement_id', event.detail->'agreement_id',
        'note_id', event.detail->'note_id',
        'transfer_id', event.detail->'transfer_id',
        'offer_id', event.detail->'offer_id',
        'flag_id', event.detail->'flag_id',
        'target_id', event.detail->'target_id',
        'asset_id', event.detail->'asset_id',
        'parent_id', event.detail->'parent_id',
        'action_id', event.detail->'action_id',
        'effect_id', event.detail->'effect_id',
        'pending_effect_id', event.detail->'pending_effect_id',
        'moderation_id', event.detail->'moderation_id',
        'id', event.detail->'id',
        'type', event.detail->'type',
        'target_type', event.detail->'target_type',
        'asset_type', event.detail->'asset_type',
        'action', event.detail->'action',
        'mode', event.detail->'mode',
        'status', event.detail->'status',
        'effects_applied', event.detail->'effects_applied',
        'due_at', event.detail->'due_at',
        'generation', event.detail->'generation',
        'name', CASE WHEN event_place_hidden.action = 'remove'
          THEN to_jsonb('[removed by maintainer]'::text) ELSE event.detail->'name' END,
        'former_name', CASE WHEN event_place_hidden.action = 'remove'
          THEN to_jsonb('[removed by maintainer]'::text) ELSE event.detail->'former_name' END,
        'error', event.detail->'error',
        'channel', event.detail->'channel'
      )),
      'detail_policy', 'safe references only; authored text is in its primary exported record'
    )
  END
FROM event_slots slot
LEFT JOIN public.events event ON event.id = slot.id
LEFT JOIN latest_moderation event_place_hidden
  ON event_place_hidden.target_type = 'place'
    AND event_place_hidden.target_id::text = event.detail->>'place_id'

UNION ALL

SELECT 'moderation', slot.id::TEXT, slot.id,
  CASE
    WHEN moderation.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public moderation record'
    )
    ELSE jsonb_build_object(
      'id', moderation.id,
      'status', 'exported',
      'target_type', moderation.target_type,
      'target_id', moderation.target_id,
      'action', moderation.action,
      'reason', moderation.reason,
      'actor_id', moderation.actor_id,
      'actor', actor.handle,
      'created_at', moderation.created_at
    )
  END
FROM moderation_slots slot
LEFT JOIN public.moderation_actions moderation ON moderation.id = slot.id
LEFT JOIN public.residents actor ON actor.id = moderation.actor_id

UNION ALL

SELECT 'treasury_fees', slot.id::TEXT, slot.id,
  CASE
    WHEN fee.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public treasury-fee record'
    )
    ELSE jsonb_build_object(
      'id', fee.id,
      'status', 'exported',
      'resident_id', fee.resident_id,
      'handle', resident.handle,
      'purpose', fee.purpose,
      'amount_usdc', to_char(fee.amount_usdc, 'FM9999999990.000000'),
      'tx_hash', fee.tx_hash,
      'created_at', fee.created_at
    )
  END
FROM fee_slots slot
LEFT JOIN public.fees fee ON fee.id = slot.id
LEFT JOIN public.residents resident ON resident.id = fee.resident_id

UNION ALL

SELECT 'world_market_offers', slot.id::TEXT, slot.id,
  CASE
    WHEN offer.id IS NULL THEN jsonb_build_object(
      'id', slot.id,
      'status', 'not_public_or_sequence_gap',
      'reason', 'this shared offer ID is not a public world-market record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', offer.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', offer.id,
      'status', 'exported',
      'channel', 'world',
      'phase', CASE
        WHEN offer.status = 'claimed' THEN 'claimed'
        WHEN offer.status = 'canceled' THEN 'canceled'
        WHEN offer.x402_evidence_state = 'invalid' THEN 'payment_invalid'
        WHEN offer.x402_evidence_state = 'founder_review' THEN 'founder_review'
        WHEN offer.x402_evidence_state = 'expired' THEN 'payment_expired'
        WHEN offer.pending_x402_tx_hash IS NOT NULL THEN 'payment_pending'
        WHEN offer.status = 'open' AND offer.buyer_id IS NOT NULL
          AND offer.reserved_by = offer.buyer_id
          AND offer.buyer_wallet IS NOT NULL
          AND offer.reserved_at <= transaction_timestamp()
          AND offer.reserved_until > transaction_timestamp()
          THEN 'reserved'
        ELSE 'listed'
      END,
      'asset_type', 'thing',
      'asset_id', offer.asset_id,
      'asset_name', thing.name,
      'maker_id', thing.maker_id,
      'made_by', maker.handle,
      'current_owner_id', thing.owner_id,
      'current_owner', current_owner.handle,
      'locked', offer.status = 'open'
        AND thing.owner_id = offer.seller_id
        AND thing.withdrawn_at IS NULL
        AND thing.active_offer_id = offer.id,
      'seller', seller.handle,
      'buyer', buyer.handle,
      'price_usdc', to_char(offer.price_usdc, 'FM9999999990.000000'),
      'seller_wallet', lower(offer.seller_wallet),
      'market_origin', offer.market_origin,
      'market_draft_id', offer.market_draft_id,
      'market_listing_id', offer.market_listing_id,
      'market_checkout_id', offer.market_checkout_id,
      'market_buyer', offer.market_buyer,
      'pending_x402_tx_hash', offer.pending_x402_tx_hash,
      'pending_x402_at', offer.pending_x402_at,
      'x402_invalid_reason', offer.x402_invalid_reason,
      'x402_invalid_at', offer.x402_invalid_at,
      'reserved_at', offer.reserved_at,
      'reserved_until', offer.reserved_until,
      'created_at', offer.created_at,
      'claimed_at', offer.claimed_at,
      'canceled_at', offer.canceled_at,
      'tx_hash', payment.tx_hash,
      'buyer_wallet', lower(offer.buyer_wallet),
      'verified_via', payment.verified_via,
      'block_time', payment.block_time,
      'from', lower(payment.payer_wallet),
      'to', lower(payment.payee_wallet)
    )
  END
FROM world_offer_slots slot
LEFT JOIN public.transfer_offers offer
  ON offer.id = slot.id AND offer.channel = 'world' AND offer.asset_type = 'thing'
LEFT JOIN public.things thing ON thing.id = offer.asset_id
LEFT JOIN public.residents maker ON maker.id = thing.maker_id
LEFT JOIN public.residents current_owner ON current_owner.id = thing.owner_id
LEFT JOIN public.residents seller ON seller.id = offer.seller_id
LEFT JOIN public.residents buyer ON buyer.id = offer.buyer_id
LEFT JOIN public.sale_payments payment ON payment.offer_id = offer.id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'thing' AND hidden.target_id = thing.id;

REVOKE ALL ON city_snapshot.public_records FROM PUBLIC;
GRANT USAGE ON SCHEMA city_snapshot TO city_snapshot_export;
GRANT SELECT ON city_snapshot.public_records TO city_snapshot_export;
DROP FUNCTION IF EXISTS city_snapshot.safe_text(TEXT);
DROP FUNCTION IF EXISTS city_snapshot.safe_json(JSONB);

-- Prepaid city credit, PayPal purchase custody, gifts, and x402 purchases.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE residents, payment_attempts, city_credit_entries, city_credit_accounts
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_operation_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_operation_check CHECK (operation IN (
    'frontier', 'kind_invention', 'kind_revision',
    'place_rename', 'place_retire', 'place_restore',
    'direct_sale', 'world_sale', 'credit_purchase', 'legacy'
  ));

ALTER TABLE city_credit_entries
  ADD COLUMN IF NOT EXISTS purchase_kind TEXT,
  ADD COLUMN IF NOT EXISTS counterparty_id INTEGER REFERENCES residents(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS city_credit_gifts (
  id                 BIGSERIAL PRIMARY KEY,
  public_id          TEXT NOT NULL UNIQUE CHECK (
                       public_id ~ '^city_gift_[0-9a-f]{32}$'
                     ),
  recipient_id       INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  amount_units       BIGINT NOT NULL CHECK (
                       amount_units > 0 AND amount_units <= 10000000000
                       AND amount_units % 1000000 = 0
                     ),
  source_key         TEXT NOT NULL UNIQUE CHECK (
                       octet_length(source_key) BETWEEN 8 AND 160
                       AND source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
                     ),
  source_entry_id    BIGINT UNIQUE REFERENCES city_credit_entries(id) ON DELETE RESTRICT,
  claim_token_hash   TEXT NOT NULL UNIQUE CHECK (claim_token_hash ~ '^[0-9a-f]{64}$'),
  status             TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'refused')),
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  accepted_at        TIMESTAMPTZ,
  refused_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'pending' AND accepted_at IS NULL AND refused_at IS NULL)
    OR (status = 'accepted' AND accepted_at IS NOT NULL AND refused_at IS NULL)
    OR (status = 'refused' AND accepted_at IS NULL AND refused_at IS NOT NULL)
  )
);

ALTER TABLE city_credit_entries
  ADD COLUMN IF NOT EXISTS gift_id BIGINT REFERENCES city_credit_gifts(id) ON DELETE RESTRICT;

ALTER TABLE city_credit_entries
  DROP CONSTRAINT IF EXISTS city_credit_entries_entry_kind_check,
  DROP CONSTRAINT IF EXISTS city_credit_entries_amount_units_check,
  DROP CONSTRAINT IF EXISTS city_credit_entries_check;
ALTER TABLE city_credit_entries
  ADD CONSTRAINT city_credit_entries_entry_kind_check CHECK (entry_kind IN (
    'founder_issue', 'purchase', 'gift_pending', 'gift_accept',
    'gift_refuse', 'gift_redirect', 'spend', 'return',
    'admin_credit', 'admin_debit'
  )),
  ADD CONSTRAINT city_credit_entries_amount_units_check CHECK (
    amount_units > 0 AND amount_units <= 10000000000
    AND amount_units % 1000000 = 0
  ),
  ADD CONSTRAINT city_credit_entries_check CHECK (
    (
      entry_kind IN ('founder_issue', 'admin_credit', 'admin_debit')
      AND amount_units = 1000000
      AND founder_id = 1 AND source_key IS NOT NULL AND reason IS NOT NULL
      AND request_id IS NULL AND payment_attempt_id IS NULL
      AND related_spend_id IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NULL
    )
    OR (
      entry_kind = 'purchase'
      AND founder_id IS NULL AND source_key IS NOT NULL AND reason IS NULL
      AND request_id IS NULL AND related_spend_id IS NULL
      AND purchase_kind IN ('paypal', 'allowance', 'x402')
      AND counterparty_id IS NULL
      AND (purchase_kind <> 'allowance' OR gift_id IS NULL)
      AND (
        (purchase_kind = 'x402' AND payment_attempt_id IS NOT NULL AND gift_id IS NULL)
        OR (purchase_kind IN ('paypal', 'allowance') AND payment_attempt_id IS NULL)
      )
    )
    OR (
      entry_kind = 'spend'
      AND amount_units = 1000000
      AND founder_id IS NULL AND source_key IS NULL AND request_id IS NOT NULL
      AND payment_attempt_id IS NOT NULL AND related_spend_id IS NULL
      AND reason IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NULL
    )
    OR (
      entry_kind = 'return'
      AND amount_units = 1000000
      AND founder_id IS NULL AND source_key IS NULL AND request_id IS NULL
      AND payment_attempt_id IS NOT NULL AND related_spend_id IS NOT NULL
      AND reason IS NOT NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NULL
    )
    OR (
      entry_kind IN ('gift_pending', 'gift_accept', 'gift_refuse')
      AND founder_id IS NULL AND source_key IS NOT NULL AND request_id IS NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NOT NULL
    )
    OR (
      entry_kind = 'gift_redirect'
      AND founder_id IS NULL AND source_key IS NOT NULL AND request_id IS NOT NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NOT NULL AND gift_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_one_purchase_per_attempt
  ON city_credit_entries (payment_attempt_id)
  WHERE entry_kind = 'purchase';
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_one_purchase_per_gift
  ON city_credit_entries (gift_id)
  WHERE entry_kind = 'purchase';
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_gift_redirect_request
  ON city_credit_entries (gift_id, request_id)
  WHERE entry_kind = 'gift_redirect';
CREATE INDEX IF NOT EXISTS city_credit_gifts_recipient_pending
  ON city_credit_gifts (recipient_id, id DESC) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION validate_city_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  related_spend city_credit_entries%ROWTYPE;
  gift city_credit_gifts%ROWTYPE;
BEGIN
  IF NEW.entry_kind IN ('spend', 'return') THEN
    SELECT * INTO attempt
    FROM payment_attempts
    WHERE public_id = NEW.payment_attempt_id
    FOR KEY SHARE;
    IF NOT FOUND
      OR attempt.method <> 'credit'
      OR attempt.actor_id <> NEW.resident_id
      OR attempt.amount_units <> NEW.amount_units
      OR attempt.operation NOT IN (
        'frontier', 'kind_invention', 'kind_revision',
        'place_rename', 'place_retire', 'place_restore'
      )
      OR (NEW.entry_kind = 'spend' AND attempt.status NOT IN ('settling', 'payment_pending'))
      OR (NEW.entry_kind = 'return' AND attempt.status NOT IN (
        'settling', 'payment_pending', 'credit_returned'
      )) THEN
      RAISE EXCEPTION 'city credit entry does not match its live credit attempt'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.entry_kind = 'return' THEN
      SELECT * INTO related_spend
      FROM city_credit_entries
      WHERE id = NEW.related_spend_id
      FOR KEY SHARE;
      IF NOT FOUND
        OR related_spend.entry_kind <> 'spend'
        OR related_spend.resident_id <> NEW.resident_id
        OR related_spend.amount_units <> NEW.amount_units
        OR related_spend.payment_attempt_id IS DISTINCT FROM NEW.payment_attempt_id THEN
        RAISE EXCEPTION 'city credit return does not match one exact spend'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.entry_kind = 'purchase' AND NEW.purchase_kind = 'x402' THEN
    SELECT * INTO attempt
    FROM payment_attempts
    WHERE public_id = NEW.payment_attempt_id
    FOR KEY SHARE;
    IF NOT FOUND
      OR attempt.operation <> 'credit_purchase'
      OR attempt.method <> 'x402'
      OR attempt.actor_id <> NEW.resident_id
      OR attempt.amount_units <> NEW.amount_units
      OR attempt.status <> 'payment_pending'
      OR attempt.tx_hash IS NULL
      OR attempt.finalized_block_number IS NULL
      OR attempt.finalized_block_hash IS NULL
      OR attempt.finalized_block_time IS NULL
      OR attempt.finalized_at IS NULL THEN
      RAISE EXCEPTION 'credit purchase receipt does not match its finalized payment'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.gift_id IS NOT NULL THEN
    SELECT * INTO gift FROM city_credit_gifts WHERE id = NEW.gift_id FOR KEY SHARE;
    IF NOT FOUND OR gift.amount_units <> NEW.amount_units THEN
      RAISE EXCEPTION 'gift receipt does not match its exact purchase'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.entry_kind = 'purchase' AND (
      gift.status <> 'pending'
      OR gift.recipient_id <> NEW.resident_id
      OR gift.source_key IS DISTINCT FROM NEW.source_key
    ) THEN
      RAISE EXCEPTION 'gift purchase receipt does not match its pending gift'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_pending' AND (
      gift.status <> 'pending'
      OR gift.recipient_id <> NEW.resident_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':pending:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift arrival receipt does not match its pending version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_accept' AND (
      gift.status <> 'accepted'
      OR gift.recipient_id <> NEW.resident_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':accept:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift acceptance receipt does not match its accepted version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_refuse' AND (
      gift.status <> 'refused'
      OR gift.recipient_id <> NEW.resident_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':refuse:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift refusal receipt does not match its refused version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_redirect' AND (
      gift.status <> 'pending'
      OR gift.version <= 1
      OR gift.recipient_id IS DISTINCT FROM NEW.counterparty_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':redirect:' || gift.version::text
      )
      OR NOT EXISTS (
        SELECT 1 FROM city_credit_entries prior
        WHERE prior.gift_id = gift.id
          AND prior.entry_kind = 'gift_pending'
          AND prior.resident_id = NEW.resident_id
          AND prior.amount_units = NEW.amount_units
          AND prior.source_key = (
            'gift:' || gift.public_id || ':pending:' || (gift.version - 1)::text
          )
      )
    ) THEN
      RAISE EXCEPTION 'gift redirect receipt does not match its departure and target'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION apply_city_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta_units BIGINT;
BEGIN
  delta_units := CASE
    WHEN NEW.entry_kind IN ('founder_issue', 'return', 'admin_credit', 'gift_accept')
      THEN NEW.amount_units
    WHEN NEW.entry_kind = 'purchase' AND NEW.gift_id IS NULL
      THEN NEW.amount_units
    WHEN NEW.entry_kind IN ('spend', 'admin_debit')
      THEN -NEW.amount_units
    WHEN NEW.entry_kind IN ('gift_pending', 'gift_refuse', 'gift_redirect')
      OR (NEW.entry_kind = 'purchase' AND NEW.gift_id IS NOT NULL)
      THEN 0
    ELSE NULL
  END CASE;

  IF delta_units IS NULL THEN
    RAISE EXCEPTION 'unknown city credit balance effect' USING ERRCODE = '23514';
  END IF;

  INSERT INTO city_credit_accounts (resident_id, balance_units)
  VALUES (NEW.resident_id, 0)
  ON CONFLICT (resident_id) DO NOTHING;

  UPDATE city_credit_accounts
  SET balance_units = balance_units + delta_units,
    updated_at = clock_timestamp()
  WHERE resident_id = NEW.resident_id
    AND balance_units + delta_units >= 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient city fee credit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION protect_city_credit_gift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'city credit gift history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.id, NEW.public_id, NEW.amount_units, NEW.source_key,
    NEW.claim_token_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.public_id, OLD.amount_units, OLD.source_key,
    OLD.claim_token_hash, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'city credit gift purchase terms are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.source_entry_id IS NOT NULL AND NEW.source_entry_id IS DISTINCT FROM OLD.source_entry_id THEN
    RAISE EXCEPTION 'city credit gift purchase receipt is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'accepted' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'accepted city credit gift is terminal' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'accepted', 'refused') THEN
    RAISE EXCEPTION 'invalid city credit gift transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'refused' AND NEW.status NOT IN ('refused', 'pending') THEN
    RAISE EXCEPTION 'invalid city credit gift transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'refused' AND NEW.status = 'pending'
    AND NEW.recipient_id IS NOT DISTINCT FROM OLD.recipient_id THEN
    RAISE EXCEPTION 'a refused city credit gift becomes pending only by redirect'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    AND NOT (OLD.status IN ('pending', 'refused') AND NEW.status = 'pending') THEN
    RAISE EXCEPTION 'only a pending or refused gift may be redirected'
      USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    AND NEW.version <> OLD.version + 1
  ) OR (
    NEW.recipient_id IS NOT DISTINCT FROM OLD.recipient_id
    AND NEW.version <> OLD.version
  ) THEN
    RAISE EXCEPTION 'city credit gift version must advance exactly once per redirect'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'city credit gift update time cannot move backward'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS city_credit_gifts_keep_history ON city_credit_gifts;
CREATE TRIGGER city_credit_gifts_keep_history
  BEFORE UPDATE OR DELETE ON city_credit_gifts
  FOR EACH ROW EXECUTE FUNCTION protect_city_credit_gift();

CREATE OR REPLACE FUNCTION require_city_credit_gift_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_gift city_credit_gifts%ROWTYPE;
BEGIN
  SELECT * INTO current_gift FROM city_credit_gifts WHERE id = NEW.id;
  IF NOT FOUND OR current_gift.source_entry_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.id = current_gift.source_entry_id
      AND entry.entry_kind = 'purchase'
      AND entry.gift_id = current_gift.id
      AND entry.amount_units = current_gift.amount_units
      AND entry.source_key = current_gift.source_key
  ) THEN
    RAISE EXCEPTION 'city credit gift requires its exact purchase receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'pending' AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id
      AND entry.entry_kind = 'gift_pending'
      AND entry.resident_id = NEW.recipient_id
      AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':pending:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'pending city credit gift requires its exact arrival receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id
      AND entry.entry_kind = 'gift_accept'
      AND entry.resident_id = NEW.recipient_id
      AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':accept:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'accepted city credit gift requires its exact acceptance receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'refused' AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id
      AND entry.entry_kind = 'gift_refuse'
      AND entry.resident_id = NEW.recipient_id
      AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':refuse:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'refused city credit gift requires its exact refusal receipt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    AND NOT EXISTS (
      SELECT 1 FROM city_credit_entries entry
      WHERE entry.gift_id = NEW.id
        AND entry.entry_kind = 'gift_redirect'
        AND entry.resident_id = OLD.recipient_id
        AND entry.counterparty_id = NEW.recipient_id
        AND entry.amount_units = NEW.amount_units
        AND entry.source_key = 'gift:' || NEW.public_id || ':redirect:' || NEW.version::text
    ) THEN
    RAISE EXCEPTION 'redirected city credit gift requires its exact departure receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS city_credit_gifts_require_purchase ON city_credit_gifts;
CREATE CONSTRAINT TRIGGER city_credit_gifts_require_purchase
  AFTER INSERT OR UPDATE ON city_credit_gifts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_city_credit_gift_purchase();

CREATE TABLE IF NOT EXISTS paypal_credit_intents (
  public_id               TEXT PRIMARY KEY CHECK (
                            octet_length(public_id) BETWEEN 16 AND 128
                            AND public_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]+$'
                          ),
  request_id              TEXT NOT NULL UNIQUE CHECK (
                            octet_length(request_id) BETWEEN 8 AND 128
                            AND request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
                          ),
  intent_kind             TEXT NOT NULL CHECK (intent_kind IN ('order', 'allowance')),
  delivery                TEXT NOT NULL CHECK (delivery IN ('self', 'gift')),
  recipient_id            INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  amount_units            BIGINT NOT NULL CHECK (
                            amount_units > 0 AND amount_units <= 10000000000
                            AND amount_units % 1000000 = 0
                          ),
  claim_token_hash        TEXT UNIQUE CHECK (
                            claim_token_hash IS NULL OR claim_token_hash ~ '^[0-9a-f]{64}$'
                          ),
  paypal_environment      TEXT NOT NULL CHECK (paypal_environment IN ('sandbox', 'live')),
  remote_order_id         TEXT UNIQUE,
  remote_subscription_id  TEXT UNIQUE,
  status                  TEXT NOT NULL CHECK (status IN (
                            'created', 'approval_pending', 'captured', 'active'
                          )),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((delivery = 'gift') = (claim_token_hash IS NOT NULL)),
  CHECK (
    (intent_kind = 'order' AND remote_subscription_id IS NULL)
    OR (
      intent_kind = 'allowance'
      AND (
        (status = 'created' AND remote_subscription_id IS NULL)
        OR (
          status IN ('approval_pending', 'active')
          AND remote_subscription_id IS NOT NULL
        )
      )
    )
  )
);

ALTER TABLE paypal_credit_intents
  DROP CONSTRAINT IF EXISTS paypal_credit_intents_status_check;
ALTER TABLE paypal_credit_intents
  ADD CONSTRAINT paypal_credit_intents_status_check CHECK (
    status IN ('created', 'approval_pending', 'captured', 'active')
  );

ALTER TABLE paypal_credit_intents
  DROP CONSTRAINT IF EXISTS paypal_credit_intents_allowance_self_check;
ALTER TABLE paypal_credit_intents
  ADD CONSTRAINT paypal_credit_intents_allowance_self_check CHECK (
    intent_kind <> 'allowance' OR delivery = 'self'
  );

ALTER TABLE paypal_credit_intents
  DROP CONSTRAINT IF EXISTS paypal_credit_intents_kind_state_check;
ALTER TABLE paypal_credit_intents
  ADD CONSTRAINT paypal_credit_intents_kind_state_check CHECK (
    (
      intent_kind = 'order'
      AND remote_subscription_id IS NULL
      AND (
        (status = 'created' AND remote_order_id IS NULL)
        OR (status IN ('approval_pending', 'captured') AND remote_order_id IS NOT NULL)
      )
    )
    OR (
      intent_kind = 'allowance'
      AND remote_order_id IS NULL
      AND (
        (status = 'created' AND remote_subscription_id IS NULL)
        OR (status IN ('approval_pending', 'active') AND remote_subscription_id IS NOT NULL)
      )
    )
  );

CREATE OR REPLACE FUNCTION protect_paypal_credit_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PayPal credit intent history cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'created'
      OR NEW.remote_order_id IS NOT NULL
      OR NEW.remote_subscription_id IS NOT NULL THEN
      RAISE EXCEPTION 'PayPal credit intent must begin in created state without a remote binding'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.public_id, NEW.request_id, NEW.intent_kind, NEW.delivery,
    NEW.recipient_id, NEW.amount_units, NEW.claim_token_hash,
    NEW.paypal_environment, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.public_id, OLD.request_id, OLD.intent_kind, OLD.delivery,
    OLD.recipient_id, OLD.amount_units, OLD.claim_token_hash,
    OLD.paypal_environment, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'PayPal credit intent purchase terms are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.remote_order_id IS NOT NULL
    AND NEW.remote_order_id IS DISTINCT FROM OLD.remote_order_id THEN
    RAISE EXCEPTION 'PayPal order binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.remote_subscription_id IS NOT NULL
    AND NEW.remote_subscription_id IS DISTINCT FROM OLD.remote_subscription_id THEN
    RAISE EXCEPTION 'PayPal subscription binding is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.intent_kind = 'order' AND NOT (
    (OLD.status = 'created' AND NEW.status = 'approval_pending')
    OR (OLD.status = 'approval_pending' AND NEW.status IN ('approval_pending', 'captured'))
    OR (OLD.status = 'captured' AND NEW.status = 'captured')
  ) THEN
    RAISE EXCEPTION 'invalid PayPal order credit transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.intent_kind = 'allowance' AND NOT (
    (OLD.status = 'created' AND NEW.status = 'approval_pending')
    OR (OLD.status = 'approval_pending' AND NEW.status IN ('approval_pending', 'active'))
    OR (OLD.status = 'active' AND NEW.status = 'active')
  ) THEN
    RAISE EXCEPTION 'invalid PayPal allowance credit transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_intents_guard ON paypal_credit_intents;
CREATE TRIGGER paypal_credit_intents_guard
  BEFORE INSERT OR UPDATE OR DELETE ON paypal_credit_intents
  FOR EACH ROW EXECUTE FUNCTION protect_paypal_credit_intent();

CREATE TABLE IF NOT EXISTS paypal_credit_catalog (
  paypal_environment TEXT PRIMARY KEY CHECK (paypal_environment IN ('sandbox', 'live')),
  product_id          TEXT,
  plan_id             TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paypal_credit_events (
  event_id           TEXT PRIMARY KEY,
  intent_public_id   TEXT REFERENCES paypal_credit_intents(public_id) ON DELETE RESTRICT,
  event_kind         TEXT NOT NULL,
  remote_resource_id TEXT,
  source_key         TEXT UNIQUE,
  purchase_entry_id  BIGINT REFERENCES city_credit_entries(id) ON DELETE RESTRICT,
  outcome            TEXT NOT NULL CHECK (outcome IN ('credited', 'ignored')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE paypal_credit_events
  ADD COLUMN IF NOT EXISTS intent_public_id TEXT
    REFERENCES paypal_credit_intents(public_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS purchase_entry_id BIGINT
    REFERENCES city_credit_entries(id) ON DELETE RESTRICT;
ALTER TABLE paypal_credit_events
  DROP CONSTRAINT IF EXISTS paypal_credit_events_outcome_check,
  DROP CONSTRAINT IF EXISTS paypal_credit_events_binding_check;
ALTER TABLE paypal_credit_events
  ADD CONSTRAINT paypal_credit_events_outcome_check CHECK (
    outcome IN ('credited', 'ignored')
  ),
  ADD CONSTRAINT paypal_credit_events_binding_check CHECK (
    (
      outcome = 'ignored'
      AND intent_public_id IS NULL
      AND source_key IS NULL
      AND purchase_entry_id IS NULL
    )
    OR (
      outcome = 'credited'
      AND intent_public_id IS NOT NULL
      AND source_key IS NOT NULL
      AND purchase_entry_id IS NOT NULL
      AND remote_resource_id IS NOT NULL
      AND event_kind IN ('PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.SALE.COMPLETED')
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS paypal_credit_events_purchase_entry
  ON paypal_credit_events (purchase_entry_id)
  WHERE purchase_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paypal_credit_events_one_order_capture
  ON paypal_credit_events (intent_public_id)
  WHERE outcome = 'credited' AND event_kind = 'PAYMENT.CAPTURE.COMPLETED';

DROP TRIGGER IF EXISTS paypal_credit_events_append_only ON paypal_credit_events;
CREATE TRIGGER paypal_credit_events_append_only
  BEFORE UPDATE OR DELETE ON paypal_credit_events
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

CREATE TABLE IF NOT EXISTS credit_purchase_rate_limits (
  caller_hash TEXT NOT NULL CHECK (caller_hash ~ '^[0-9a-f]{64}$'),
  hour        TIMESTAMPTZ NOT NULL,
  used        INTEGER NOT NULL CHECK (used > 0 AND used <= 300),
  PRIMARY KEY (caller_hash, hour)
);

ALTER TABLE credit_purchase_rate_limits
  DROP CONSTRAINT IF EXISTS credit_purchase_rate_limits_used_check;
ALTER TABLE credit_purchase_rate_limits
  ADD CONSTRAINT credit_purchase_rate_limits_used_check CHECK (used > 0 AND used <= 300);

CREATE OR REPLACE FUNCTION record_city_credit_purchase(
  target_resident_id INTEGER,
  purchased_amount_units BIGINT,
  purchase_source_key TEXT,
  requested_purchase_kind TEXT,
  requested_claim_token_hash TEXT,
  requested_gift_public_id TEXT
) RETURNS TABLE (
  id BIGINT,
  resident_id INTEGER,
  amount_units BIGINT,
  source_key TEXT,
  purchase_kind TEXT,
  gift_row_id BIGINT,
  gift_public_id TEXT,
  claim_token_hash TEXT,
  status TEXT,
  created BOOLEAN,
  balance_units BIGINT
) LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  stored_entry city_credit_entries%ROWTYPE;
  stored_gift city_credit_gifts%ROWTYPE;
  was_created BOOLEAN := false;
  stored_balance BIGINT;
BEGIN
  IF requested_claim_token_hash IS NULL THEN
    INSERT INTO city_credit_entries (
      resident_id, entry_kind, amount_units, source_key, purchase_kind
    )
    SELECT target_resident_id, 'purchase', purchased_amount_units,
      purchase_source_key, requested_purchase_kind
    WHERE EXISTS (SELECT 1 FROM residents WHERE residents.id = target_resident_id)
    ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING
    RETURNING city_credit_entries.* INTO stored_entry;
    IF FOUND THEN
      was_created := true;
    ELSE
      SELECT entry.* INTO stored_entry
      FROM city_credit_entries entry
      WHERE entry.source_key = purchase_source_key;
    END IF;
  ELSE
    SELECT gift.* INTO stored_gift
    FROM city_credit_gifts gift
    WHERE gift.source_key = purchase_source_key;
    IF NOT FOUND THEN
      INSERT INTO city_credit_gifts (
        public_id, recipient_id, amount_units, source_key, claim_token_hash, status
      )
      SELECT requested_gift_public_id, target_resident_id, purchased_amount_units,
        purchase_source_key, requested_claim_token_hash, 'pending'
      WHERE EXISTS (SELECT 1 FROM residents WHERE residents.id = target_resident_id)
      ON CONFLICT (source_key) DO NOTHING
      RETURNING city_credit_gifts.* INTO stored_gift;
      IF FOUND THEN
        was_created := true;
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, source_key, purchase_kind, gift_id
        ) VALUES (
          stored_gift.recipient_id, 'purchase', stored_gift.amount_units,
          stored_gift.source_key, requested_purchase_kind, stored_gift.id
        )
        RETURNING city_credit_entries.* INTO stored_entry;
        UPDATE city_credit_gifts gift
        SET source_entry_id = stored_entry.id, updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id
        RETURNING gift.* INTO stored_gift;
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, source_key, gift_id
        ) VALUES (
          stored_gift.recipient_id, 'gift_pending', stored_gift.amount_units,
          'gift:' || stored_gift.public_id || ':pending:1', stored_gift.id
        );
      ELSE
        SELECT gift.* INTO stored_gift
        FROM city_credit_gifts gift
        WHERE gift.source_key = purchase_source_key;
      END IF;
    END IF;
    IF stored_entry.id IS NULL AND stored_gift.source_entry_id IS NOT NULL THEN
      SELECT entry.* INTO stored_entry
      FROM city_credit_entries entry
      WHERE entry.id = stored_gift.source_entry_id;
    END IF;
  END IF;

  IF stored_entry.id IS NULL THEN
    RETURN;
  END IF;
  SELECT account.balance_units INTO stored_balance
  FROM city_credit_accounts account
  WHERE account.resident_id = stored_entry.resident_id;
  RETURN QUERY SELECT
    stored_entry.id,
    stored_entry.resident_id,
    stored_entry.amount_units,
    stored_entry.source_key,
    stored_entry.purchase_kind,
    stored_gift.id,
    stored_gift.public_id,
    stored_gift.claim_token_hash,
    stored_gift.status,
    was_created,
    coalesce(stored_balance, 0);
END
$$;

CREATE OR REPLACE FUNCTION require_paypal_credit_event_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stored_intent paypal_credit_intents%ROWTYPE;
  stored_entry city_credit_entries%ROWTYPE;
  stored_gift city_credit_gifts%ROWTYPE;
BEGIN
  IF NEW.outcome = 'ignored' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO stored_intent
  FROM paypal_credit_intents intent
  WHERE intent.public_id = NEW.intent_public_id;
  SELECT * INTO stored_entry
  FROM city_credit_entries entry
  WHERE entry.id = NEW.purchase_entry_id;

  IF stored_intent.public_id IS NULL
    OR stored_entry.id IS NULL
    OR stored_entry.entry_kind <> 'purchase'
    OR stored_entry.resident_id <> stored_intent.recipient_id
    OR stored_entry.amount_units <> stored_intent.amount_units
    OR stored_entry.source_key IS DISTINCT FROM NEW.source_key
    OR (stored_intent.delivery = 'gift') <> (stored_entry.gift_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PayPal event does not match one exact credit purchase'
      USING ERRCODE = '23514';
  END IF;

  IF stored_intent.intent_kind = 'order' THEN
    IF stored_intent.status <> 'captured'
      OR stored_intent.remote_order_id IS NULL
      OR stored_entry.purchase_kind <> 'paypal'
      OR NEW.event_kind <> 'PAYMENT.CAPTURE.COMPLETED'
      OR NEW.source_key IS DISTINCT FROM (
        'paypal:capture:' || NEW.remote_resource_id
      ) THEN
      RAISE EXCEPTION 'PayPal capture event does not match its captured order'
        USING ERRCODE = '23514';
    END IF;
  ELSIF stored_intent.intent_kind = 'allowance' THEN
    IF stored_intent.status <> 'active'
      OR stored_intent.remote_subscription_id IS NULL
      OR stored_intent.delivery <> 'self'
      OR stored_entry.purchase_kind <> 'allowance'
      OR NEW.event_kind <> 'PAYMENT.SALE.COMPLETED'
      OR NEW.source_key IS DISTINCT FROM (
        'paypal:sale:' || NEW.remote_resource_id
      ) THEN
      RAISE EXCEPTION 'PayPal renewal event does not match its active allowance'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'PayPal event has an unknown intent kind'
      USING ERRCODE = '23514';
  END IF;

  IF stored_entry.gift_id IS NULL THEN
    IF stored_intent.claim_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'self PayPal credit cannot retain gift terms'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO stored_gift
    FROM city_credit_gifts gift
    WHERE gift.id = stored_entry.gift_id;
    IF stored_gift.id IS NULL
      OR stored_gift.source_entry_id <> stored_entry.id
      OR stored_gift.recipient_id <> stored_intent.recipient_id
      OR stored_gift.amount_units <> stored_intent.amount_units
      OR stored_gift.source_key IS DISTINCT FROM NEW.source_key
      OR stored_gift.claim_token_hash IS DISTINCT FROM stored_intent.claim_token_hash THEN
      RAISE EXCEPTION 'PayPal gift event does not match its pending gift'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_events_require_receipt ON paypal_credit_events;
CREATE CONSTRAINT TRIGGER paypal_credit_events_require_receipt
  AFTER INSERT ON paypal_credit_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_credit_event_receipt();

CREATE OR REPLACE FUNCTION require_paypal_purchase_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entry_kind = 'purchase'
    AND NEW.purchase_kind IN ('paypal', 'allowance')
    AND NOT EXISTS (
      SELECT 1 FROM paypal_credit_events event
      WHERE event.purchase_entry_id = NEW.id
        AND event.source_key = NEW.source_key
        AND event.outcome = 'credited'
    ) THEN
    RAISE EXCEPTION 'PayPal credit purchase requires its exact verified event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS city_credit_entries_require_paypal_event ON city_credit_entries;
CREATE CONSTRAINT TRIGGER city_credit_entries_require_paypal_event
  AFTER INSERT ON city_credit_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_purchase_event();

CREATE OR REPLACE FUNCTION deliver_paypal_credit(
  requested_purchase_id TEXT,
  expected_delivery TEXT,
  expected_recipient_id INTEGER,
  expected_amount_units BIGINT,
  expected_claim_token_hash TEXT,
  expected_paypal_environment TEXT,
  expected_remote_parent_id TEXT,
  requested_source_key TEXT,
  requested_purchase_kind TEXT,
  requested_event_id TEXT,
  requested_event_kind TEXT,
  requested_remote_resource_id TEXT,
  requested_gift_public_id TEXT
) RETURNS TABLE (
  id BIGINT,
  resident_id INTEGER,
  amount_units BIGINT,
  source_key TEXT,
  purchase_kind TEXT,
  gift_row_id BIGINT,
  gift_public_id TEXT,
  claim_token_hash TEXT,
  status TEXT,
  created BOOLEAN,
  balance_units BIGINT
) LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  stored_intent paypal_credit_intents%ROWTYPE;
  stored_event paypal_credit_events%ROWTYPE;
  purchase_record RECORD;
  event_binding_count INTEGER;
  required_intent_kind TEXT;
  delivered_status TEXT;
BEGIN
  required_intent_kind := CASE requested_purchase_kind
    WHEN 'paypal' THEN 'order'
    WHEN 'allowance' THEN 'allowance'
    ELSE NULL
  END;
  delivered_status := CASE requested_purchase_kind
    WHEN 'paypal' THEN 'captured'
    WHEN 'allowance' THEN 'active'
    ELSE NULL
  END;
  IF required_intent_kind IS NULL
    OR expected_delivery IS NULL
    OR expected_delivery NOT IN ('self', 'gift')
    OR expected_recipient_id IS NULL
    OR expected_amount_units IS NULL
    OR expected_paypal_environment IS NULL
    OR expected_paypal_environment NOT IN ('sandbox', 'live')
    OR requested_event_id IS NULL
    OR octet_length(requested_event_id) NOT BETWEEN 1 AND 128
    OR requested_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    OR requested_event_kind IS NULL
    OR requested_remote_resource_id IS NULL
    OR octet_length(requested_remote_resource_id) NOT BETWEEN 1 AND 128
    OR requested_remote_resource_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    OR requested_source_key IS NULL
    OR octet_length(requested_source_key) NOT BETWEEN 8 AND 160
    OR requested_source_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$' THEN
    RAISE EXCEPTION 'PayPal credit delivery input is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF (requested_purchase_kind = 'paypal' AND (
      requested_event_kind <> 'PAYMENT.CAPTURE.COMPLETED'
      OR requested_source_key <> 'paypal:capture:' || requested_remote_resource_id
    )) OR (requested_purchase_kind = 'allowance' AND (
      requested_event_kind <> 'PAYMENT.SALE.COMPLETED'
      OR requested_source_key <> 'paypal:sale:' || requested_remote_resource_id
    )) THEN
    RAISE EXCEPTION 'PayPal event identity does not match the delivery rail'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO stored_intent
  FROM paypal_credit_intents intent
  WHERE intent.public_id = requested_purchase_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PayPal credit intent was not found' USING ERRCODE = '55000';
  END IF;

  IF stored_intent.intent_kind <> required_intent_kind
    OR stored_intent.delivery <> expected_delivery
    OR stored_intent.recipient_id <> expected_recipient_id
    OR stored_intent.amount_units <> expected_amount_units
    OR stored_intent.claim_token_hash IS DISTINCT FROM expected_claim_token_hash
    OR stored_intent.paypal_environment <> expected_paypal_environment
    OR (
      required_intent_kind = 'order'
      AND stored_intent.remote_order_id IS DISTINCT FROM expected_remote_parent_id
    )
    OR (
      required_intent_kind = 'allowance'
      AND stored_intent.remote_subscription_id IS DISTINCT FROM expected_remote_parent_id
    )
    OR (
      required_intent_kind = 'order'
      AND stored_intent.status NOT IN ('approval_pending', 'captured')
    )
    OR (
      required_intent_kind = 'allowance'
      AND stored_intent.status NOT IN ('approval_pending', 'active')
    )
    OR (expected_delivery = 'gift' AND (
      requested_purchase_kind <> 'paypal'
      OR requested_gift_public_id IS NULL
      OR requested_gift_public_id !~ '^city_gift_[0-9a-f]{32}$'
    ))
    OR (expected_delivery = 'self' AND requested_gift_public_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PayPal delivery does not match the immutable intent terms'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO event_binding_count
  FROM paypal_credit_events event
  WHERE event.event_id = requested_event_id
    OR event.source_key = requested_source_key;
  IF event_binding_count > 1 THEN
    RAISE EXCEPTION 'PayPal event identity has conflicting durable bindings'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO stored_event
  FROM paypal_credit_events event
  WHERE event.event_id = requested_event_id
    OR event.source_key = requested_source_key
  LIMIT 1;
  IF stored_event.event_id IS NOT NULL AND (
    stored_event.intent_public_id <> stored_intent.public_id
    OR stored_event.event_kind <> requested_event_kind
    OR stored_event.remote_resource_id <> requested_remote_resource_id
    OR stored_event.source_key <> requested_source_key
    OR stored_event.outcome <> 'credited'
  ) THEN
    RAISE EXCEPTION 'PayPal event identity is already bound to changed terms'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO purchase_record
  FROM record_city_credit_purchase(
    stored_intent.recipient_id,
    stored_intent.amount_units,
    requested_source_key,
    requested_purchase_kind,
    stored_intent.claim_token_hash,
    requested_gift_public_id
  );
  IF purchase_record.id IS NULL
    OR purchase_record.resident_id <> stored_intent.recipient_id
    OR purchase_record.amount_units <> stored_intent.amount_units
    OR purchase_record.source_key <> requested_source_key
    OR purchase_record.purchase_kind <> requested_purchase_kind
    OR (stored_intent.delivery = 'gift') <> (purchase_record.gift_row_id IS NOT NULL)
    OR (
      stored_intent.delivery = 'gift'
      AND purchase_record.claim_token_hash IS DISTINCT FROM stored_intent.claim_token_hash
    ) THEN
    RAISE EXCEPTION 'PayPal purchase source is already bound to changed terms'
      USING ERRCODE = '23514';
  END IF;

  IF stored_event.event_id IS NULL THEN
    INSERT INTO paypal_credit_events (
      event_id, intent_public_id, event_kind, remote_resource_id,
      source_key, purchase_entry_id, outcome
    ) VALUES (
      requested_event_id, stored_intent.public_id, requested_event_kind,
      requested_remote_resource_id, requested_source_key,
      purchase_record.id, 'credited'
    ) RETURNING * INTO stored_event;
  ELSIF stored_event.purchase_entry_id <> purchase_record.id THEN
    RAISE EXCEPTION 'PayPal event is already bound to another credit receipt'
      USING ERRCODE = '23514';
  END IF;

  UPDATE paypal_credit_intents intent
  SET status = delivered_status, updated_at = clock_timestamp()
  WHERE intent.public_id = stored_intent.public_id
  RETURNING intent.* INTO stored_intent;

  RETURN QUERY SELECT
    purchase_record.id::BIGINT,
    purchase_record.resident_id::INTEGER,
    purchase_record.amount_units::BIGINT,
    purchase_record.source_key::TEXT,
    purchase_record.purchase_kind::TEXT,
    purchase_record.gift_row_id::BIGINT,
    purchase_record.gift_public_id::TEXT,
    purchase_record.claim_token_hash::TEXT,
    purchase_record.status::TEXT,
    purchase_record.created::BOOLEAN,
    purchase_record.balance_units::BIGINT;
END
$$;

-- Place lifecycle: the founding name is permanent, current names have
-- append-only spans, and retirement is a reversible tombstone state.
UPDATE places SET founding_name = name WHERE founding_name IS NULL;

DO $place_lifecycle_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_founding_name_valid'
  ) THEN
    ALTER TABLE places ADD CONSTRAINT places_founding_name_valid
      CHECK (char_length(founding_name) BETWEEN 1 AND 120) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_retired_after_creation'
  ) THEN
    ALTER TABLE places ADD CONSTRAINT places_retired_after_creation
      CHECK (retired_at IS NULL OR retired_at >= created_at) NOT VALID;
  END IF;
END
$place_lifecycle_constraints$;
ALTER TABLE places VALIDATE CONSTRAINT places_founding_name_valid;
ALTER TABLE places VALIDATE CONSTRAINT places_retired_after_creation;
ALTER TABLE places ALTER COLUMN founding_name SET NOT NULL;

CREATE OR REPLACE FUNCTION protect_place_founding_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.founding_name IS NULL THEN
      NEW.founding_name := NEW.name;
    ELSIF NEW.founding_name IS DISTINCT FROM NEW.name THEN
      RAISE EXCEPTION 'founding name must match the first display name'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.founding_name IS DISTINCT FROM OLD.founding_name THEN
    RAISE EXCEPTION 'founding name is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS places_protect_founding_name ON places;
CREATE TRIGGER places_protect_founding_name
  BEFORE INSERT OR UPDATE OF founding_name ON places
  FOR EACH ROW EXECUTE FUNCTION protect_place_founding_name();

CREATE TABLE IF NOT EXISTS place_name_history (
  id         BIGSERIAL PRIMARY KEY,
  place_id   INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  started_at TIMESTAMPTZ NOT NULL,
  event_id   BIGINT UNIQUE REFERENCES events(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS place_name_history_one_founding_name
  ON place_name_history (place_id) WHERE event_id IS NULL;
CREATE INDEX IF NOT EXISTS place_name_history_place_span
  ON place_name_history (place_id, started_at, id);
CREATE INDEX IF NOT EXISTS place_name_history_name_search
  ON place_name_history USING gin (lower(name) public.gin_trgm_ops);
INSERT INTO place_name_history (place_id, name, started_at, event_id)
SELECT place.id, place.name, place.created_at, NULL
FROM places AS place
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION record_place_founding_name_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO place_name_history (place_id, name, started_at, event_id)
  VALUES (NEW.id, NEW.founding_name, NEW.created_at, NULL);
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS places_record_founding_name_history ON places;
CREATE TRIGGER places_record_founding_name_history
  AFTER INSERT ON places
  FOR EACH ROW EXECUTE FUNCTION record_place_founding_name_history();

CREATE OR REPLACE FUNCTION deny_place_name_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM places place WHERE place.id = OLD.place_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'place name history is append-only' USING ERRCODE = '55000';
END
$$;
DROP TRIGGER IF EXISTS place_name_history_append_only ON place_name_history;
CREATE TRIGGER place_name_history_append_only
  BEFORE UPDATE OR DELETE ON place_name_history
  FOR EACH ROW EXECUTE FUNCTION deny_place_name_history_mutation();
DROP TRIGGER IF EXISTS place_name_history_no_truncate ON place_name_history;
CREATE TRIGGER place_name_history_no_truncate
  BEFORE TRUNCATE ON place_name_history
  FOR EACH STATEMENT EXECUTE FUNCTION deny_place_name_history_mutation();

CREATE OR REPLACE VIEW place_name_spans AS
SELECT id, place_id, name, started_at,
  lead(started_at) OVER (PARTITION BY place_id ORDER BY started_at, id) AS ended_at,
  event_id
FROM place_name_history;

CREATE OR REPLACE FUNCTION reject_retired_place_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_place_id INTEGER;
  target_retired_at TIMESTAMPTZ;
BEGIN
  IF TG_TABLE_NAME = 'places' THEN
    target_place_id := NEW.parent_id;
  ELSIF TG_TABLE_NAME = 'things' THEN
    IF NEW.withdrawn_at IS NOT NULL THEN RETURN NEW; END IF;
    target_place_id := NEW.place_id;
  ELSIF TG_TABLE_NAME = 'notes' THEN
    target_place_id := NEW.place_id;
  ELSE
    IF NEW.current_place_id IS NOT NULL THEN
      SELECT retired_at INTO target_retired_at
      FROM places WHERE id = NEW.current_place_id FOR SHARE;
      IF target_retired_at IS NOT NULL THEN
        RAISE EXCEPTION 'retired place cannot receive resident presence'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    target_place_id := NEW.home_place_id;
  END IF;
  IF target_place_id IS NOT NULL THEN
    SELECT retired_at INTO target_retired_at
    FROM places WHERE id = target_place_id FOR SHARE;
    IF target_retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'retired place cannot receive %', CASE TG_TABLE_NAME
        WHEN 'places' THEN 'subplaces'
        WHEN 'things' THEN 'things'
        WHEN 'notes' THEN 'notes'
        ELSE 'resident homes'
      END USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS places_reject_retired_parent ON places;
CREATE TRIGGER places_reject_retired_parent
  BEFORE INSERT OR UPDATE OF parent_id, retired_at ON places
  FOR EACH ROW EXECUTE FUNCTION reject_retired_place_target();
DROP TRIGGER IF EXISTS things_reject_retired_place ON things;
CREATE TRIGGER things_reject_retired_place
  BEFORE INSERT OR UPDATE OF place_id, withdrawn_at ON things
  FOR EACH ROW EXECUTE FUNCTION reject_retired_place_target();
DROP TRIGGER IF EXISTS notes_reject_retired_place ON notes;
CREATE TRIGGER notes_reject_retired_place
  BEFORE INSERT OR UPDATE OF place_id ON notes
  FOR EACH ROW EXECUTE FUNCTION reject_retired_place_target();
DROP TRIGGER IF EXISTS resident_presence_reject_retired_place ON resident_presence;
CREATE TRIGGER resident_presence_reject_retired_place
  BEFORE INSERT OR UPDATE OF current_place_id, home_place_id ON resident_presence
  FOR EACH ROW EXECUTE FUNCTION reject_retired_place_target();

-- The fresh baseline includes the same guarded drawing contract as the
-- forward migration. Keep db/migrations/20260828_drawing_contract.sql
-- synchronized with this block.
-- The public write contract stores the owner's decision separately from its
-- pixels. Blank is a read-time presentation of a complete transparent image;
-- it is never a stored or inferred owner decision.
CREATE OR REPLACE FUNCTION valid_city_drawing_public_text(
  candidate TEXT,
  maximum_bytes INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $function$
DECLARE
  position INTEGER;
  codepoint INTEGER;
  next_one INTEGER;
  next_two INTEGER;
  next_three INTEGER;
  mojibake_tail INTEGER[] := ARRAY[
    338, 339, 352, 353, 376, 381, 382, 402, 710, 732,
    8211, 8212, 8213, 8214, 8215, 8216, 8217, 8218,
    8219, 8220, 8221, 8222, 8223, 8224, 8225, 8226,
    8230, 8240, 8249, 8250, 8364, 8482
  ];
BEGIN
  IF candidate IS NULL OR maximum_bytes < 0
    OR octet_length(candidate) > maximum_bytes
    OR candidate ~* '1f3d9_(sk|at|rt|ac|rc)_[0-9a-f]{8,}' THEN
    RETURN FALSE;
  END IF;

  FOR position IN 1..char_length(candidate) LOOP
    codepoint := ascii(substr(candidate, position, 1));
    IF codepoint BETWEEN 0 AND 8 OR codepoint IN (11, 12)
      OR codepoint BETWEEN 14 AND 31 OR codepoint BETWEEN 127 AND 159
      OR codepoint IN (
        1564, 8206, 8207, 8232, 8233, 8234, 8235, 8236, 8237, 8238,
        8294, 8295, 8296, 8297, 65533
      ) THEN
      RETURN FALSE;
    END IF;

    next_one := ascii(substr(candidate, position + 1, 1));
    next_two := ascii(substr(candidate, position + 2, 1));
    next_three := ascii(substr(candidate, position + 3, 1));
    IF (codepoint IN (194, 195)
        AND (next_one BETWEEN 160 AND 191 OR next_one = ANY(mojibake_tail)))
      OR (codepoint = 226
        AND (next_one BETWEEN 160 AND 191 OR next_one = ANY(mojibake_tail))
        AND (next_two BETWEEN 160 AND 191 OR next_two = ANY(mojibake_tail)))
      OR (codepoint = 240
        AND (next_one BETWEEN 160 AND 191 OR next_one = ANY(mojibake_tail))
        AND (next_two BETWEEN 160 AND 191 OR next_two = ANY(mojibake_tail))
        AND (next_three BETWEEN 160 AND 191 OR next_three = ANY(mojibake_tail))) THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END
$function$;

CREATE OR REPLACE FUNCTION valid_city_drawing_variant_name(candidate TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT AS $function$
  SELECT candidate IS NOT NULL
    AND candidate = btrim(candidate)
    AND octet_length(candidate) BETWEEN 1 AND 64
    AND candidate !~ E'[\\r\\n]'
    AND valid_city_drawing_public_text(candidate, 64)
$function$;

CREATE OR REPLACE FUNCTION valid_city_drawing_state(
  candidate_state TEXT,
  candidate_description TEXT,
  candidate_drawing JSONB
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT AS $function$
  SELECT CASE candidate_state
    WHEN 'undrawn' THEN candidate_description IS NULL AND candidate_drawing IS NULL
    WHEN 'refused' THEN candidate_description IS NOT NULL
      AND octet_length(candidate_description) <= 280
      AND valid_city_drawing_public_text(candidate_description, 280)
      AND candidate_drawing IS NULL
    WHEN 'in_progress' THEN candidate_description IS NOT NULL
      AND octet_length(candidate_description) <= 280
      AND valid_city_drawing_public_text(candidate_description, 280)
      AND candidate_drawing IS NOT NULL
      AND valid_city_drawing(candidate_drawing)
    WHEN 'complete' THEN candidate_description IS NOT NULL
      AND octet_length(candidate_description) <= 280
      AND valid_city_drawing_public_text(candidate_description, 280)
      AND candidate_drawing IS NOT NULL
      AND valid_city_drawing(candidate_drawing)
    ELSE FALSE
  END
$function$;

CREATE OR REPLACE FUNCTION valid_city_drawing_variants(candidate JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT AS $function$
DECLARE
  variant JSONB;
  variant_name TEXT;
  names TEXT[] := '{}'::TEXT[];
BEGIN
  IF candidate IS NULL OR jsonb_typeof(candidate) <> 'array'
    OR jsonb_array_length(candidate) > 8 THEN
    RETURN FALSE;
  END IF;

  FOR variant IN SELECT value FROM jsonb_array_elements(candidate) LOOP
    IF jsonb_typeof(variant) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(variant)) <> 4
      OR NOT variant ?& ARRAY['name', 'drawing', 'state', 'description']
      OR jsonb_typeof(variant->'name') <> 'string'
      OR jsonb_typeof(variant->'state') <> 'string'
      OR jsonb_typeof(variant->'description') <> 'string' THEN
      RETURN FALSE;
    END IF;
    variant_name := variant->>'name';
    IF octet_length(variant_name) NOT BETWEEN 1 AND 64
      OR NOT valid_city_drawing_variant_name(variant_name)
      OR variant_name = ANY(names)
      OR variant->>'state' NOT IN ('in_progress', 'complete')
      OR NOT valid_city_drawing_state(
        variant->>'state', variant->>'description', variant->'drawing'
      ) THEN
      RETURN FALSE;
    END IF;
    names := array_append(names, variant_name);
  END LOOP;
  RETURN TRUE;
END
$function$;

CREATE OR REPLACE FUNCTION city_drawing_rows(candidate JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $function$
DECLARE
  row_index INTEGER;
  column_index INTEGER;
  cell JSONB;
  row_text TEXT;
  result JSONB := '[]'::JSONB;
BEGIN
  IF candidate IS NULL THEN RETURN NULL; END IF;
  row_index := 0;
  WHILE row_index < 8 LOOP
    row_text := '';
    column_index := 0;
    WHILE column_index < 8 LOOP
      cell := candidate->'indices'->(row_index * 8 + column_index);
      IF column_index > 0 THEN row_text := row_text || ' '; END IF;
      row_text := row_text || CASE
        WHEN cell IS NULL OR jsonb_typeof(cell) = 'null' THEN '.'
        ELSE cell #>> '{}'
      END;
      column_index := column_index + 1;
    END LOOP;
    result := result || jsonb_build_array(row_text);
    row_index := row_index + 1;
  END LOOP;
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION city_drawing_presentation_state(
  owner_state TEXT,
  candidate JSONB
) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $function$
  SELECT CASE
    WHEN owner_state = 'complete' AND candidate IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(candidate->'indices') cell
      WHERE jsonb_typeof(cell) <> 'null'
    ) THEN 'blank'
    ELSE owner_state
  END
$function$;

ALTER TABLE residents ADD COLUMN IF NOT EXISTS drawing JSONB;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS drawing_state TEXT;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS drawing_description TEXT;
ALTER TABLE places ADD COLUMN IF NOT EXISTS drawing JSONB;
ALTER TABLE places ADD COLUMN IF NOT EXISTS drawing_state TEXT;
ALTER TABLE places ADD COLUMN IF NOT EXISTS drawing_description TEXT;
ALTER TABLE kind_revisions ADD COLUMN IF NOT EXISTS drawing JSONB;
ALTER TABLE kind_revisions ADD COLUMN IF NOT EXISTS drawing_state TEXT;
ALTER TABLE kind_revisions ADD COLUMN IF NOT EXISTS drawing_description TEXT;
ALTER TABLE kind_revisions ADD COLUMN IF NOT EXISTS drawing_variants JSONB;
ALTER TABLE things ADD COLUMN IF NOT EXISTS drawing JSONB;
ALTER TABLE things ADD COLUMN IF NOT EXISTS drawing_state TEXT;
ALTER TABLE things ADD COLUMN IF NOT EXISTS drawing_description TEXT;
ALTER TABLE things ADD COLUMN IF NOT EXISTS drawing_variant_name TEXT;

UPDATE residents SET
  drawing_state = CASE WHEN drawing IS NULL THEN 'undrawn' ELSE 'complete' END,
  drawing_description = CASE WHEN drawing IS NULL THEN NULL ELSE '' END
WHERE drawing_state IS NULL;
DO $drawing_contract_place_backfill$
BEGIN
  IF EXISTS (SELECT 1 FROM places WHERE drawing_state IS NULL) THEN
    IF EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'places'::regclass
        AND NOT tgisinternal
        AND tgenabled <> 'O'
    ) THEN
      RAISE EXCEPTION 'all place row guards must be enabled before drawing backfill';
    END IF;

    ALTER TABLE places DISABLE TRIGGER USER;
    UPDATE places SET
      drawing_state = CASE WHEN drawing IS NULL THEN 'undrawn' ELSE 'complete' END,
      drawing_description = CASE WHEN drawing IS NULL THEN NULL ELSE '' END
    WHERE drawing_state IS NULL;
    ALTER TABLE places ENABLE TRIGGER USER;

    IF EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'places'::regclass
        AND NOT tgisinternal
        AND tgenabled <> 'O'
    ) THEN
      RAISE EXCEPTION 'place row guards were not restored after drawing backfill';
    END IF;
  END IF;
END
$drawing_contract_place_backfill$;
DO $drawing_contract_kind_history_off$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'kind_revisions'::regclass
      AND tgname = 'kind_revisions_append_only'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE kind_revisions DISABLE TRIGGER kind_revisions_append_only;
  END IF;
END
$drawing_contract_kind_history_off$;
UPDATE kind_revisions SET
  drawing_state = CASE WHEN drawing IS NULL THEN 'undrawn' ELSE 'complete' END,
  drawing_description = CASE WHEN drawing IS NULL THEN NULL ELSE '' END,
  drawing_variants = coalesce(drawing_variants, '[]'::JSONB)
WHERE drawing_state IS NULL OR drawing_variants IS NULL;
DO $drawing_contract_kind_history_on$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'kind_revisions'::regclass
      AND tgname = 'kind_revisions_append_only'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE kind_revisions ENABLE TRIGGER kind_revisions_append_only;
  END IF;
END
$drawing_contract_kind_history_on$;
DO $drawing_contract_thing_history_off$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'things'::regclass
      AND tgname = 'things_keep_birth_history'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE things DISABLE TRIGGER things_keep_birth_history;
  END IF;
END
$drawing_contract_thing_history_off$;
UPDATE things SET
  drawing_state = CASE WHEN drawing IS NULL THEN 'undrawn' ELSE 'complete' END,
  drawing_description = CASE WHEN drawing IS NULL THEN NULL ELSE '' END
WHERE drawing_state IS NULL;

ALTER TABLE residents ALTER COLUMN drawing_state SET DEFAULT 'undrawn';
ALTER TABLE residents ALTER COLUMN drawing_state SET NOT NULL;
ALTER TABLE places ALTER COLUMN drawing_state SET DEFAULT 'undrawn';
ALTER TABLE places ALTER COLUMN drawing_state SET NOT NULL;
ALTER TABLE kind_revisions ALTER COLUMN drawing_state SET DEFAULT 'undrawn';
ALTER TABLE kind_revisions ALTER COLUMN drawing_state SET NOT NULL;
ALTER TABLE kind_revisions ALTER COLUMN drawing_variants SET DEFAULT '[]'::JSONB;
ALTER TABLE kind_revisions ALTER COLUMN drawing_variants SET NOT NULL;
ALTER TABLE things ALTER COLUMN drawing_state SET DEFAULT 'undrawn';
ALTER TABLE things ALTER COLUMN drawing_state SET NOT NULL;

CREATE OR REPLACE FUNCTION valid_city_drawing_revision_value(
  value_state TEXT,
  value_description TEXT,
  value_drawing JSONB,
  value_source TEXT,
  value_kind_id INTEGER,
  value_kind_revision INTEGER,
  value_variant_name TEXT
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT AS $function$
  SELECT valid_city_drawing_state(value_state, value_description, value_drawing)
    AND value_source IN ('none', 'resident', 'place', 'thing', 'kind_base', 'kind_variant')
    AND CASE value_source
      WHEN 'none' THEN value_state = 'undrawn'
        AND value_kind_id IS NULL AND value_kind_revision IS NULL
        AND value_variant_name IS NULL
      WHEN 'resident' THEN value_kind_id IS NULL AND value_kind_revision IS NULL
        AND value_variant_name IS NULL
      WHEN 'place' THEN value_kind_id IS NULL AND value_kind_revision IS NULL
        AND value_variant_name IS NULL
      WHEN 'thing' THEN value_variant_name IS NULL
        AND ((value_kind_id IS NULL AND value_kind_revision IS NULL)
          OR (value_kind_id IS NOT NULL AND value_kind_revision IS NOT NULL))
      WHEN 'kind_base' THEN value_kind_id IS NOT NULL
        AND value_kind_revision IS NOT NULL AND value_variant_name IS NULL
      WHEN 'kind_variant' THEN value_kind_id IS NOT NULL
        AND value_kind_revision IS NOT NULL
        AND valid_city_drawing_variant_name(value_variant_name)
      ELSE FALSE
    END
$function$;

CREATE TABLE IF NOT EXISTS drawing_revisions (
  id                    BIGSERIAL PRIMARY KEY,
  target_type           TEXT NOT NULL
                          CHECK (target_type IN ('resident', 'place', 'thing', 'kind')),
  target_id             INTEGER NOT NULL CHECK (target_id > 0),
  prior_state           TEXT NOT NULL,
  prior_description     TEXT,
  prior_drawing         JSONB,
  prior_source          TEXT NOT NULL,
  prior_kind_id         INTEGER,
  prior_kind_revision   INTEGER,
  prior_variant_name    TEXT,
  current_state         TEXT NOT NULL,
  current_description   TEXT,
  current_drawing       JSONB,
  current_source        TEXT NOT NULL,
  current_kind_id       INTEGER,
  current_kind_revision INTEGER,
  current_variant_name  TEXT,
  slot_variant_name     TEXT,
  author_id             INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  author_relation       TEXT NOT NULL
                          CHECK (author_relation IN ('self', 'owner', 'kind_owner', 'founder', 'legacy')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drawing_revisions_prior_valid CHECK (valid_city_drawing_revision_value(
    prior_state, prior_description, prior_drawing, prior_source,
    prior_kind_id, prior_kind_revision, prior_variant_name
  )),
  CONSTRAINT drawing_revisions_current_valid CHECK (valid_city_drawing_revision_value(
    current_state, current_description, current_drawing, current_source,
    current_kind_id, current_kind_revision, current_variant_name
  )),
  CONSTRAINT drawing_revisions_slot_variant_valid CHECK (
    slot_variant_name IS NULL OR valid_city_drawing_variant_name(slot_variant_name)
  ),
  CONSTRAINT drawing_revisions_real_change CHECK (
    ROW(
      prior_state, prior_description, prior_drawing, prior_source,
      prior_kind_id, prior_kind_revision, prior_variant_name
    ) IS DISTINCT FROM ROW(
      current_state, current_description, current_drawing, current_source,
      current_kind_id, current_kind_revision, current_variant_name
    )
  )
);
CREATE INDEX IF NOT EXISTS drawing_revisions_target_history
  ON drawing_revisions (target_type, target_id, id DESC);
CREATE INDEX IF NOT EXISTS drawing_revisions_author
  ON drawing_revisions (author_id, id DESC) WHERE author_id IS NOT NULL;

-- Existing preview art is an honest baseline, not retroactively attributed to
-- an owner. The exact world-root drawing is known founder-authored. Typed
-- instance pixels are recorded once and then return to their pinned kind
-- presentation. Only the first installation may infer this legacy provenance:
-- a completed contract already has its append-only history trigger, and a
-- rerun must not reinterpret later owner-authored pixels as legacy evidence.
INSERT INTO drawing_revisions (
  target_type, target_id,
  prior_state, prior_description, prior_drawing, prior_source,
  current_state, current_description, current_drawing, current_source,
  author_id, author_relation
)
SELECT 'resident', resident.id,
  'undrawn', NULL, NULL, 'none',
  'complete', '', resident.drawing, 'resident',
  NULL, 'legacy'
FROM residents resident
WHERE resident.drawing IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_trigger installed_trigger
    WHERE installed_trigger.tgrelid = 'drawing_revisions'::regclass
      AND installed_trigger.tgname = 'drawing_revisions_append_only'
      AND NOT installed_trigger.tgisinternal
  )
  AND NOT EXISTS (
    SELECT 1 FROM drawing_revisions revision
    WHERE revision.target_type = 'resident' AND revision.target_id = resident.id
      AND revision.author_relation = 'legacy'
  );

INSERT INTO drawing_revisions (
  target_type, target_id,
  prior_state, prior_description, prior_drawing, prior_source,
  current_state, current_description, current_drawing, current_source,
  author_id, author_relation
)
SELECT 'place', place.id,
  'undrawn', NULL, NULL, 'none',
  'complete', '', place.drawing, 'place',
  NULL, CASE WHEN place.place_kind = 'world'
      AND place.drawing = '{"palette":["#0b1714","#123026","#1c4434"],"indices":[0,0,0,0,0,0,0,0,null,0,1,0,0,0,0,0,null,0,0,0,0,0,1,0,0,null,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,null,0,1,0,0,0,0,0,null,0,0,0,0,1,0,0,0,0,0,1,0,0]}'::JSONB
    THEN 'founder' ELSE 'legacy' END
FROM places place
WHERE place.drawing IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_trigger installed_trigger
    WHERE installed_trigger.tgrelid = 'drawing_revisions'::regclass
      AND installed_trigger.tgname = 'drawing_revisions_append_only'
      AND NOT installed_trigger.tgisinternal
  )
  AND NOT EXISTS (
    SELECT 1 FROM drawing_revisions revision
    WHERE revision.target_type = 'place' AND revision.target_id = place.id
      AND revision.current_state = 'complete'
      AND revision.current_description = ''
      AND revision.current_drawing = place.drawing
      AND revision.current_source = 'place'
  );

INSERT INTO drawing_revisions (
  target_type, target_id,
  prior_state, prior_description, prior_drawing, prior_source,
  current_state, current_description, current_drawing, current_source,
  current_kind_id, current_kind_revision,
  author_id, author_relation
)
SELECT 'kind', definition.kind_id,
  'undrawn', NULL, NULL, 'none',
  'complete', '', definition.drawing, 'kind_base',
  definition.kind_id, definition.revision,
  NULL, 'legacy'
FROM kind_revisions definition
WHERE definition.drawing IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_trigger installed_trigger
    WHERE installed_trigger.tgrelid = 'drawing_revisions'::regclass
      AND installed_trigger.tgname = 'drawing_revisions_append_only'
      AND NOT installed_trigger.tgisinternal
  )
  AND NOT EXISTS (
    SELECT 1 FROM drawing_revisions history
    WHERE history.target_type = 'kind' AND history.target_id = definition.kind_id
      AND history.current_kind_revision = definition.revision
      AND history.author_relation = 'legacy'
  );

INSERT INTO drawing_revisions (
  target_type, target_id,
  prior_state, prior_description, prior_drawing, prior_source,
  current_state, current_description, current_drawing, current_source,
  author_id, author_relation
)
SELECT 'thing', thing.id,
  'undrawn', NULL, NULL, 'none',
  'complete', '', thing.drawing, 'thing',
  NULL, 'legacy'
FROM things thing
WHERE thing.kind_id IS NULL AND thing.drawing IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_trigger installed_trigger
    WHERE installed_trigger.tgrelid = 'drawing_revisions'::regclass
      AND installed_trigger.tgname = 'drawing_revisions_append_only'
      AND NOT installed_trigger.tgisinternal
  )
  AND NOT EXISTS (
    SELECT 1 FROM drawing_revisions revision
    WHERE revision.target_type = 'thing' AND revision.target_id = thing.id
      AND revision.author_relation = 'legacy'
  );

INSERT INTO drawing_revisions (
  target_type, target_id,
  prior_state, prior_description, prior_drawing, prior_source,
  prior_kind_id, prior_kind_revision,
  current_state, current_description, current_drawing, current_source,
  current_kind_id, current_kind_revision, slot_variant_name,
  author_id, author_relation
)
SELECT 'thing', thing.id,
  'complete', '', thing.drawing, 'thing', thing.kind_id, thing.current_revision,
  CASE WHEN definition.drawing IS NULL THEN 'undrawn' ELSE definition.drawing_state END,
  CASE WHEN definition.drawing IS NULL THEN NULL ELSE definition.drawing_description END,
  definition.drawing,
  CASE WHEN definition.drawing IS NULL THEN 'none' ELSE 'kind_base' END,
  CASE WHEN definition.drawing IS NULL THEN NULL ELSE thing.kind_id END,
  CASE WHEN definition.drawing IS NULL THEN NULL ELSE thing.current_revision END,
  NULL,
  NULL, 'legacy'
FROM things thing
JOIN kind_revisions definition
  ON definition.kind_id = thing.kind_id AND definition.revision = thing.current_revision
WHERE thing.kind_id IS NOT NULL AND thing.drawing IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_trigger installed_trigger
    WHERE installed_trigger.tgrelid = 'drawing_revisions'::regclass
      AND installed_trigger.tgname = 'drawing_revisions_append_only'
      AND NOT installed_trigger.tgisinternal
  )
  AND NOT EXISTS (
    SELECT 1 FROM drawing_revisions revision
    WHERE revision.target_type = 'thing' AND revision.target_id = thing.id
      AND revision.author_relation = 'legacy'
  );

UPDATE things SET
  drawing = NULL,
  drawing_state = 'undrawn',
  drawing_description = NULL
WHERE kind_id IS NOT NULL AND drawing IS NOT NULL;
DO $drawing_contract_thing_history_on$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'things'::regclass
      AND tgname = 'things_keep_birth_history'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE things ENABLE TRIGGER things_keep_birth_history;
  END IF;
END
$drawing_contract_thing_history_on$;

DO $drawing_contract_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'residents'::regclass
    AND conname = 'residents_drawing_contract') THEN
    ALTER TABLE residents ADD CONSTRAINT residents_drawing_contract
      CHECK (valid_city_drawing_state(drawing_state, drawing_description, drawing)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'places'::regclass
    AND conname = 'places_drawing_contract') THEN
    ALTER TABLE places ADD CONSTRAINT places_drawing_contract
      CHECK (valid_city_drawing_state(drawing_state, drawing_description, drawing)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kind_revisions'::regclass
    AND conname = 'kind_revisions_drawing_contract') THEN
    ALTER TABLE kind_revisions ADD CONSTRAINT kind_revisions_drawing_contract
      CHECK (valid_city_drawing_state(drawing_state, drawing_description, drawing)
        AND valid_city_drawing_variants(drawing_variants)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'things'::regclass
    AND conname = 'things_drawing_contract') THEN
    ALTER TABLE things ADD CONSTRAINT things_drawing_contract CHECK (
      valid_city_drawing_state(drawing_state, drawing_description, drawing)
      AND (drawing_variant_name IS NULL OR (
        kind_id IS NOT NULL AND valid_city_drawing_variant_name(drawing_variant_name)
      ))
      AND (kind_id IS NULL OR (
        drawing IS NULL AND drawing_state IN ('undrawn', 'refused')
      ))
    ) NOT VALID;
  END IF;
END
$drawing_contract_constraints$;

ALTER TABLE residents VALIDATE CONSTRAINT residents_drawing_contract;
ALTER TABLE places VALIDATE CONSTRAINT places_drawing_contract;
ALTER TABLE kind_revisions VALIDATE CONSTRAINT kind_revisions_drawing_contract;
ALTER TABLE things VALIDATE CONSTRAINT things_drawing_contract;

CREATE OR REPLACE FUNCTION validate_thing_drawing_variant() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT AS $function$
BEGIN
  IF NEW.drawing_variant_name IS NULL THEN RETURN NEW; END IF;
  IF NOT valid_city_drawing_variant_name(NEW.drawing_variant_name)
    OR NEW.kind_id IS NULL OR NEW.current_revision IS NULL OR NOT EXISTS (
    SELECT 1
    FROM kind_revisions definition,
      LATERAL jsonb_array_elements(definition.drawing_variants) variant
    WHERE definition.kind_id = NEW.kind_id
      AND definition.revision = NEW.current_revision
      AND variant->>'name' = NEW.drawing_variant_name
  ) THEN
    RAISE EXCEPTION 'selected drawing variant is absent from the pinned kind revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS things_validate_drawing_variant ON things;
CREATE TRIGGER things_validate_drawing_variant
BEFORE INSERT OR UPDATE OF kind_id, current_revision, drawing_variant_name ON things
FOR EACH ROW EXECUTE FUNCTION validate_thing_drawing_variant();

CREATE OR REPLACE FUNCTION deny_drawing_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'drawing revisions are immutable' USING ERRCODE = '55000';
END
$function$;

DROP TRIGGER IF EXISTS drawing_revisions_append_only ON drawing_revisions;
CREATE TRIGGER drawing_revisions_append_only
BEFORE UPDATE OR DELETE ON drawing_revisions
FOR EACH ROW EXECUTE FUNCTION deny_drawing_revision_mutation();

CREATE OR REPLACE FUNCTION city_drawing_public_value(
  value_state TEXT,
  value_description TEXT,
  value_drawing JSONB,
  value_source TEXT,
  value_kind_id INTEGER,
  value_kind_name TEXT,
  value_kind_revision INTEGER,
  value_variant_name TEXT
) RETURNS JSONB
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT AS $function$
  SELECT jsonb_build_object(
    'state', value_state,
    'presentation_state', city_drawing_presentation_state(value_state, value_drawing),
    'description', value_description,
    'drawing', value_drawing,
    'rows', city_drawing_rows(value_drawing),
    'source', value_source
  ) || jsonb_strip_nulls(jsonb_build_object(
    'kind_id', value_kind_id,
    'kind_name', value_kind_name,
    'revision', value_kind_revision,
    'variant_name', value_variant_name
  ))
$function$;

-- Preserve the explicit pre-contract allowlist as a private base view. The
-- public view below adds only the new drawing fields and separate revisions.
DO $drawing_snapshot_base$
BEGIN
  IF to_regclass('city_snapshot.public_records_without_drawing_contract') IS NULL THEN
    ALTER VIEW city_snapshot.public_records RENAME TO public_records_without_drawing_contract;
  END IF;
END
$drawing_snapshot_base$;

REVOKE ALL ON city_snapshot.public_records_without_drawing_contract FROM PUBLIC;
REVOKE ALL ON city_snapshot.public_records_without_drawing_contract FROM city_snapshot_export;

CREATE OR REPLACE VIEW city_snapshot.public_records
WITH (security_barrier = true)
AS
WITH latest_moderation AS (
  SELECT DISTINCT ON (action.target_type, action.target_id)
    action.target_type, action.target_id, action.action
  FROM public.moderation_actions action
  ORDER BY action.target_type, action.target_id, action.created_at DESC, action.id DESC
), enriched AS (
  SELECT base.class_name, base.record_id, base.sort_key,
    CASE
      WHEN base.payload->>'status' <> 'exported' THEN base.payload
      WHEN base.class_name = 'residents' AND resident.id IS NOT NULL THEN
        base.payload || CASE WHEN resident_hidden.action = 'remove' THEN jsonb_build_object(
          'drawing', NULL, 'drawing_state', NULL, 'drawing_presentation_state', NULL,
          'drawing_description', NULL, 'drawing_rows', NULL, 'drawing_source', NULL
        ) ELSE jsonb_build_object(
          'drawing', resident.drawing,
          'drawing_state', resident.drawing_state,
          'drawing_presentation_state', city_drawing_presentation_state(
            resident.drawing_state, resident.drawing
          ),
          'drawing_description', resident.drawing_description,
          'drawing_rows', city_drawing_rows(resident.drawing),
          'drawing_source', CASE WHEN resident.drawing_state = 'undrawn'
            THEN 'none' ELSE 'resident' END
        ) END
      WHEN base.class_name = 'places' AND place.id IS NOT NULL THEN
        base.payload || jsonb_build_object(
          'name', CASE WHEN place_hidden.action = 'remove'
            THEN '[removed by maintainer]' ELSE place.name END,
          'founding_name', CASE WHEN place_hidden.action = 'remove'
            THEN '[removed by maintainer]' ELSE place.founding_name END,
          'retired_at', place.retired_at,
          'status', CASE WHEN place.retired_at IS NULL THEN 'active' ELSE 'retired' END,
          'name_history', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'name', CASE WHEN place_hidden.action = 'remove'
                THEN '[removed by maintainer]' ELSE span.name END,
              'started_at', span.started_at,
              'ended_at', span.ended_at
            ) ORDER BY span.started_at, span.id)
            FROM place_name_spans span WHERE span.place_id = place.id
          ), '[]'::jsonb),
          'drawing', place.drawing,
          'drawing_state', place.drawing_state,
          'drawing_presentation_state', city_drawing_presentation_state(
            place.drawing_state, place.drawing
          ),
          'drawing_description', place.drawing_description,
          'drawing_rows', city_drawing_rows(place.drawing),
          'drawing_source', CASE WHEN place.drawing_state = 'undrawn'
            THEN 'none' ELSE 'place' END
        )
      WHEN base.class_name = 'kinds' AND kind.id IS NOT NULL THEN
        base.payload || jsonb_build_object(
          'drawing', definition.drawing,
          'drawing_state', definition.drawing_state,
          'drawing_presentation_state', city_drawing_presentation_state(
            definition.drawing_state, definition.drawing
          ),
          'drawing_description', definition.drawing_description,
          'drawing_rows', city_drawing_rows(definition.drawing),
          'drawing_source', CASE WHEN definition.drawing_state = 'undrawn'
            THEN 'none' ELSE 'kind_base' END,
          'drawing_variants', definition.drawing_variants,
          'kind_id', kind.id,
          'kind_name', kind.name,
          'variant_name', NULL
        )
      WHEN base.class_name = 'things' AND thing.id IS NOT NULL THEN
        base.payload || jsonb_build_object(
          'drawing', effective.drawing,
          'drawing_state', effective.state,
          'drawing_presentation_state', city_drawing_presentation_state(
            effective.state, effective.drawing
          ),
          'drawing_description', effective.description,
          'drawing_rows', city_drawing_rows(effective.drawing),
          'drawing_source', effective.source,
          'kind_id', effective.kind_id,
          'kind_name', effective.kind_name,
          'revision', effective.kind_revision,
          'variant_name', effective.variant_name
        )
      ELSE base.payload
    END AS payload
  FROM city_snapshot.public_records_without_drawing_contract base
  LEFT JOIN public.residents resident
    ON base.class_name = 'residents' AND resident.id::TEXT = base.record_id
  LEFT JOIN latest_moderation resident_hidden
    ON resident_hidden.target_type = 'resident' AND resident_hidden.target_id = resident.id
  LEFT JOIN public.places place
    ON base.class_name = 'places' AND place.id::TEXT = base.record_id
  LEFT JOIN latest_moderation place_hidden
    ON place_hidden.target_type = 'place' AND place_hidden.target_id = place.id
  LEFT JOIN public.kinds kind
    ON base.class_name = 'kinds' AND kind.id::TEXT = base.record_id
  LEFT JOIN public.kind_revisions definition
    ON definition.kind_id = kind.id AND definition.revision = kind.current_revision
  LEFT JOIN public.things thing
    ON base.class_name = 'things' AND thing.id::TEXT = base.record_id
  LEFT JOIN public.kinds thing_kind ON thing_kind.id = thing.kind_id
  LEFT JOIN public.kind_revisions thing_definition
    ON thing_definition.kind_id = thing.kind_id
    AND thing_definition.revision = thing.current_revision
  LEFT JOIN latest_moderation thing_kind_hidden
    ON thing_kind_hidden.target_type = 'kind' AND thing_kind_hidden.target_id = thing.kind_id
  LEFT JOIN LATERAL (
    SELECT variant.value
    FROM jsonb_array_elements(coalesce(thing_definition.drawing_variants, '[]'::JSONB)) variant(value)
    WHERE variant.value->>'name' = thing.drawing_variant_name
  ) selected_variant ON true
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN thing.drawing_state <> 'undrawn' THEN thing.drawing_state
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          AND selected_variant.value IS NOT NULL THEN selected_variant.value->>'state'
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          THEN thing_definition.drawing_state
        ELSE CASE
          WHEN thing.kind_id IS NOT NULL
            AND coalesce(thing_kind_hidden.action, 'restore') = 'remove' THEN NULL
          ELSE 'undrawn'
        END
      END AS state,
      CASE
        WHEN thing.drawing_state <> 'undrawn' THEN thing.drawing_description
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          AND selected_variant.value IS NOT NULL THEN selected_variant.value->>'description'
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          THEN thing_definition.drawing_description
        ELSE NULL
      END AS description,
      CASE
        WHEN thing.drawing_state <> 'undrawn' THEN thing.drawing
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          AND selected_variant.value IS NOT NULL THEN selected_variant.value->'drawing'
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          THEN thing_definition.drawing
        ELSE NULL
      END AS drawing,
      CASE
        WHEN thing.drawing_state <> 'undrawn' THEN 'thing'
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          AND selected_variant.value IS NOT NULL THEN 'kind_variant'
        WHEN thing.kind_id IS NOT NULL AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
          AND thing_definition.drawing_state <> 'undrawn' THEN 'kind_base'
        ELSE CASE
          WHEN thing.kind_id IS NOT NULL
            AND coalesce(thing_kind_hidden.action, 'restore') = 'remove' THEN NULL
          ELSE 'none'
        END
      END AS source,
      CASE WHEN thing.kind_id IS NOT NULL
        AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
        AND (thing.drawing_state <> 'undrawn'
          OR selected_variant.value IS NOT NULL
          OR thing_definition.drawing_state <> 'undrawn')
        THEN thing.kind_id ELSE NULL END AS kind_id,
      CASE WHEN thing.kind_id IS NOT NULL
        AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
        AND (thing.drawing_state <> 'undrawn'
          OR selected_variant.value IS NOT NULL
          OR thing_definition.drawing_state <> 'undrawn')
        THEN thing_kind.name ELSE NULL END AS kind_name,
      CASE WHEN thing.kind_id IS NOT NULL
        AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
        AND (thing.drawing_state <> 'undrawn'
          OR selected_variant.value IS NOT NULL
          OR thing_definition.drawing_state <> 'undrawn')
        THEN thing.current_revision ELSE NULL END AS kind_revision,
      CASE WHEN thing.drawing_state = 'undrawn'
        AND selected_variant.value IS NOT NULL
        AND coalesce(thing_kind_hidden.action, 'restore') <> 'remove'
        THEN thing.drawing_variant_name ELSE NULL END
        AS variant_name
  ) effective ON true
)
SELECT class_name, record_id, sort_key, payload FROM enriched

UNION ALL

SELECT 'drawing_revisions', revision.id::TEXT, revision.id,
  jsonb_build_object(
    'id', revision.id,
    'status', 'exported',
    'target_type', revision.target_type,
    'target_id', revision.target_id,
    'previous', city_drawing_public_value(
      revision.prior_state, revision.prior_description, revision.prior_drawing,
      revision.prior_source, revision.prior_kind_id, prior_kind.name,
      revision.prior_kind_revision, revision.prior_variant_name
    ),
    'current', city_drawing_public_value(
      revision.current_state, revision.current_description, revision.current_drawing,
      revision.current_source, revision.current_kind_id, current_kind.name,
      revision.current_kind_revision, revision.current_variant_name
    ),
    'source', revision.current_source,
    'slot_variant_name', revision.slot_variant_name,
    'author_id', revision.author_id,
    'author', author.handle,
    'author_relation', revision.author_relation,
    'created_at', revision.created_at
  )
FROM public.drawing_revisions revision
LEFT JOIN public.residents author ON author.id = revision.author_id
LEFT JOIN public.kinds prior_kind ON prior_kind.id = revision.prior_kind_id
LEFT JOIN public.kinds current_kind ON current_kind.id = revision.current_kind_id
LEFT JOIN latest_moderation moderation_actions_parent_hidden
  ON moderation_actions_parent_hidden.target_type = revision.target_type
  AND moderation_actions_parent_hidden.target_id = revision.target_id
LEFT JOIN latest_moderation moderation_actions_source_kind_hidden
  ON moderation_actions_source_kind_hidden.target_type = 'kind'
  AND moderation_actions_source_kind_hidden.target_id = coalesce(
    revision.current_kind_id, revision.prior_kind_id
  )
WHERE coalesce(moderation_actions_parent_hidden.action, 'restore') <> 'remove'
  AND coalesce(moderation_actions_source_kind_hidden.action, 'restore') <> 'remove';

REVOKE ALL ON city_snapshot.public_records FROM PUBLIC;
GRANT USAGE ON SCHEMA city_snapshot TO city_snapshot_export;
GRANT SELECT ON city_snapshot.public_records TO city_snapshot_export;

-- The Gazette is a deterministic weekly ledger over the ordinary, append-only
-- notes in place #454. "Consumption" is immutable issue membership: the source
-- note remains exactly where its resident left it and is never copied or moved.
CREATE OR REPLACE FUNCTION gazette_cycle_start(value TIMESTAMPTZ)
RETURNS TIMESTAMPTZ
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT date_bin(
    interval '7 days',
    value,
    TIMESTAMPTZ '2026-08-31 16:00:00+00'
  )
$$;

CREATE TABLE IF NOT EXISTS gazette_issues (
  issue_number  INTEGER PRIMARY KEY CHECK (issue_number > 0),
  scheduled_for TIMESTAMPTZ NOT NULL UNIQUE,
  printed_at    TIMESTAMPTZ NOT NULL,
  header        TEXT NOT NULL CHECK (octet_length(header) BETWEEN 1 AND 4000),
  entry_count   INTEGER NOT NULL CHECK (entry_count >= 0),
  event_id      BIGINT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  CHECK (printed_at >= scheduled_for),
  CHECK (
    scheduled_for = TIMESTAMPTZ '2026-08-31 16:00:00+00'
      + ((issue_number - 1) * interval '7 days')
  )
);

CREATE TABLE IF NOT EXISTS gazette_issue_entries (
  issue_number  INTEGER NOT NULL REFERENCES gazette_issues(issue_number) ON DELETE RESTRICT,
  ordinal       INTEGER NOT NULL CHECK (ordinal > 0),
  note_id       INTEGER NOT NULL UNIQUE REFERENCES notes(id) ON DELETE RESTRICT,
  PRIMARY KEY (issue_number, ordinal)
);
CREATE INDEX IF NOT EXISTS gazette_issue_entries_note_order
  ON gazette_issue_entries (issue_number, ordinal, note_id);

CREATE TABLE IF NOT EXISTS gazette_withdrawals (
  target_note_id  INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE RESTRICT,
  command_note_id INTEGER NOT NULL UNIQUE REFERENCES notes(id) ON DELETE RESTRICT,
  withdrawn_at    TIMESTAMPTZ NOT NULL,
  CHECK (target_note_id <> command_note_id)
);

CREATE OR REPLACE FUNCTION gazette_withdrawal_target(value TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  digits TEXT;
  numeric_target NUMERIC;
BEGIN
  IF value COLLATE "C" !~ '^WITHDRAW #[1-9][0-9]*$' THEN RETURN NULL; END IF;
  digits := substring(value FROM 11);
  IF char_length(digits) > 10 THEN RETURN NULL; END IF;
  numeric_target := digits::NUMERIC;
  IF numeric_target > 2147483647 THEN RETURN NULL; END IF;
  RETURN numeric_target::INTEGER;
END
$$;

CREATE OR REPLACE FUNCTION gazette_withdrawal_command_reserved(value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT value COLLATE "C" ~ '^WITHDRAW[[:space:]]*#'
$$;

CREATE OR REPLACE FUNCTION validate_gazette_issue_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_place_id INTEGER;
  source_created_at TIMESTAMPTZ;
  issue_cutoff TIMESTAMPTZ;
BEGIN
  SELECT note.place_id, note.created_at
  INTO source_place_id, source_created_at
  FROM notes note
  WHERE note.id = NEW.note_id;

  SELECT issue.scheduled_for
  INTO issue_cutoff
  FROM gazette_issues issue
  WHERE issue.issue_number = NEW.issue_number;

  IF source_place_id IS DISTINCT FROM 454 OR source_created_at >= issue_cutoff THEN
    RAISE EXCEPTION 'Gazette entries must reference a pre-cutoff note from place 454'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_issue_entry_source';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gazette_withdrawals withdrawal
    WHERE withdrawal.command_note_id = NEW.note_id
  ) THEN
    RAISE EXCEPTION 'Gazette withdrawal commands cannot enter an issue'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_issue_entry_withdrawal_command';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION verify_gazette_issue_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  declared_count INTEGER;
  stored_count INTEGER;
  misplaced_count INTEGER;
BEGIN
  SELECT issue.entry_count
  INTO declared_count
  FROM gazette_issues issue
  WHERE issue.issue_number = NEW.issue_number;

  SELECT count(*)::integer,
    count(*) FILTER (WHERE ordered.ordinal <> ordered.expected_ordinal)::integer
  INTO stored_count, misplaced_count
  FROM (
    SELECT entry.ordinal,
      row_number() OVER (ORDER BY note.created_at, note.id)::integer AS expected_ordinal
    FROM gazette_issue_entries entry
    JOIN notes note ON note.id = entry.note_id
    WHERE entry.issue_number = NEW.issue_number
  ) ordered;

  IF declared_count IS NULL OR stored_count <> declared_count OR misplaced_count <> 0 THEN
    RAISE EXCEPTION 'Gazette issue membership is incomplete or out of order'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_issue_membership_complete';
  END IF;
  RETURN NULL;
END
$$;

-- Room #454 is a city service, not an ordinary tradable or repurposable place.
-- One shared classifier keeps the dormant shell, activation guard, and public
-- submissions gate on the same two complete row shapes.
CREATE OR REPLACE FUNCTION gazette_submission_room_state(candidate places)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN candidate.id = 454
      AND candidate.parent_id = 2
      AND candidate.place_kind = 'place'
      AND candidate.owner_id = 1
      AND candidate.name = 'the gazette submission room'
      AND cardinality(candidate.front_matter_thing_ids) = 0
      AND candidate.active_offer_id IS NULL
      AND candidate.open_to_building = FALSE
      AND candidate.open_to_things = FALSE
      AND candidate.open_to_notes = FALSE
      AND candidate.description = 'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.'
      AND candidate.purpose = ''
    THEN 'closed'
    WHEN candidate.id = 454
      AND candidate.parent_id = 2
      AND candidate.place_kind = 'place'
      AND candidate.owner_id = 1
      AND candidate.name = 'the gazette submission room'
      AND cardinality(candidate.front_matter_thing_ids) = 0
      AND candidate.active_offer_id IS NULL
      AND candidate.open_to_building = FALSE
      AND candidate.open_to_things = FALSE
      AND candidate.open_to_notes = TRUE
      AND candidate.description = 'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted note made before the cutoff to the next issue, verbatim with its author, note ID, and time. Printing never deletes, edits, moves, or copies the source note.'
      AND candidate.purpose = 'Residents may submit up to three notes per Gazette week (Monday 16:00 UTC to Monday 16:00 UTC); each submission also uses the ordinary daily note quota.'
    THEN 'open'
    WHEN candidate.id = 454
      AND candidate.parent_id = 2
      AND candidate.place_kind = 'place'
      AND candidate.owner_id = 1
      AND candidate.name = 'the gazette submission room'
      AND cardinality(candidate.front_matter_thing_ids) = 0
      AND candidate.active_offer_id IS NULL
      AND candidate.open_to_building = FALSE
      AND candidate.open_to_things = FALSE
      AND candidate.open_to_notes = TRUE
      AND candidate.description = 'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted submission made before the cutoff to the next issue, oldest first with its author, note ID, and time. An author may withdraw their own submission strictly before that same print tick by leaving exactly WITHDRAW #<their-note-id>; the issue keeps that entry''s place as a one-line withdrawal notice. Only while withdrawals are open, a note whose opening is exact uppercase WITHDRAW, optional whitespace, then # is read as a withdrawal command; every other opening or shape is an ordinary submission. A reserved opening that is not exactly WITHDRAW #<their-note-id> is refused instead of printing. The founder and other residents have no override. Printing and withdrawal never delete, edit, move, or copy the source note.'
      AND candidate.purpose = 'Three submissions per resident per Gazette week; all notes use the daily quota. Closed: every body is a submission. Open: uppercase WITHDRAW plus optional whitespace then # is reserved; commands use no weekly slot, never print, and do not restore the target slot.'
    THEN 'withdrawals_open'
    ELSE 'invalid'
  END
$$;

CREATE OR REPLACE FUNCTION gazette_submission_room_has_no_forbidden_contents()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM place_law_changes WHERE place_id = 454
  ) AND NOT EXISTS (
    SELECT 1 FROM places WHERE parent_id = 454
  ) AND NOT EXISTS (
    SELECT 1 FROM things WHERE place_id = 454
  )
$$;

-- Refuse legacy drift before installing the guards so an operator can clean up
-- a pre-feature database and rerun the schema without disabling new triggers.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM place_law_changes WHERE place_id = 454) THEN
    RAISE EXCEPTION 'Gazette room #454 cannot have local laws'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_laws';
  END IF;
  IF EXISTS (SELECT 1 FROM places WHERE parent_id = 454) THEN
    RAISE EXCEPTION 'Gazette room #454 cannot contain child places'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_children';
  END IF;
  IF EXISTS (SELECT 1 FROM things WHERE place_id = 454) THEN
    RAISE EXCEPTION 'Gazette room #454 cannot hold things'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_things';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION protect_gazette_submission_room_dependents()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_row JSONB;
  new_row JSONB;
  target_column TEXT;
  touches_room BOOLEAN;
BEGIN
  old_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  new_row := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  target_column := CASE WHEN TG_TABLE_NAME = 'places' THEN 'parent_id' ELSE 'place_id' END;
  touches_room := coalesce((old_row ->> target_column)::integer = 454, FALSE)
    OR coalesce((new_row ->> target_column)::integer = 454, FALSE);

  IF touches_room AND TG_TABLE_NAME = 'place_law_changes' THEN
    RAISE EXCEPTION 'Gazette room #454 is a protected city service and cannot have local laws'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_laws';
  ELSIF touches_room AND TG_TABLE_NAME = 'places' THEN
    RAISE EXCEPTION 'Gazette room #454 is a protected city service and cannot contain child places'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_children';
  ELSIF touches_room AND TG_TABLE_NAME = 'things' THEN
    RAISE EXCEPTION 'Gazette room #454 is a protected city service and cannot hold things'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_things';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS gazette_submission_room_reject_laws ON place_law_changes;
CREATE TRIGGER gazette_submission_room_reject_laws
BEFORE INSERT OR UPDATE OR DELETE ON place_law_changes
FOR EACH ROW EXECUTE FUNCTION protect_gazette_submission_room_dependents();
DROP TRIGGER IF EXISTS gazette_submission_room_reject_child_places ON places;
CREATE TRIGGER gazette_submission_room_reject_child_places
BEFORE INSERT OR UPDATE OR DELETE ON places
FOR EACH ROW EXECUTE FUNCTION protect_gazette_submission_room_dependents();
DROP TRIGGER IF EXISTS gazette_submission_room_reject_things ON things;
CREATE TRIGGER gazette_submission_room_reject_things
BEFORE INSERT OR UPDATE OR DELETE ON things
FOR EACH ROW EXECUTE FUNCTION protect_gazette_submission_room_dependents();

CREATE OR REPLACE FUNCTION gazette_withdrawal_guards_ready()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT to_regclass('public.gazette_withdrawals') IS NOT NULL
    AND NOT EXISTS (
    SELECT expected.table_name, expected.trigger_name
    FROM (VALUES
      ('notes', 'gazette_note_submission_limit'),
      ('notes', 'gazette_note_record_withdrawal'),
      ('gazette_withdrawals', 'gazette_withdrawals_validate'),
      ('gazette_withdrawals', 'gazette_withdrawals_append_only'),
      ('gazette_withdrawals', 'gazette_withdrawals_no_truncate'),
      ('gazette_issue_entries', 'gazette_issue_entry_source'),
      ('gazette_issues', 'gazette_issue_membership_complete'),
      ('gazette_issue_entries', 'gazette_issue_entries_membership_complete'),
      ('gazette_issues', 'gazette_issues_append_only'),
      ('gazette_issue_entries', 'gazette_issue_entries_append_only'),
      ('gazette_issues', 'gazette_issues_no_truncate'),
      ('gazette_issue_entries', 'gazette_issue_entries_no_truncate')
    ) AS expected(table_name, trigger_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger
      WHERE trigger.tgrelid = expected.table_name::regclass
        AND trigger.tgname = expected.trigger_name
        AND trigger.tgenabled IN ('O', 'A')
        AND NOT trigger.tgisinternal
    )
  )
$$;

CREATE OR REPLACE FUNCTION gazette_submission_room_guards_ready()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT gazette_withdrawal_guards_ready()
    AND NOT EXISTS (
    SELECT expected.table_name, expected.trigger_name
    FROM (VALUES
      ('places', 'gazette_submission_room_lifecycle'),
      ('places', 'gazette_submission_room_reject_child_places'),
      ('place_law_changes', 'gazette_submission_room_reject_laws'),
      ('things', 'gazette_submission_room_reject_things')
    ) AS expected(table_name, trigger_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger
      WHERE trigger.tgrelid = expected.table_name::regclass
        AND trigger.tgname = expected.trigger_name
        AND trigger.tgenabled IN ('O', 'A')
        AND NOT trigger.tgisinternal
    )
  )
$$;

CREATE OR REPLACE FUNCTION protect_gazette_submission_room()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.id = 454 THEN
      RAISE EXCEPTION 'Gazette room #454 is a protected city service; it cannot be deleted, traded, transferred, or repurposed'
        USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.id = 454 AND gazette_submission_room_state(NEW) <> 'closed' THEN
      RAISE EXCEPTION 'Gazette room #454 must begin as the exact closed submission shell described by the city contract'
        USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.id <> 454 AND NEW.id <> 454 THEN
    RETURN NEW;
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'Gazette room #454 is a protected city service; its identity cannot change'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  IF gazette_submission_room_state(OLD) = 'closed'
    AND gazette_submission_room_state(NEW) = 'open'
    AND to_regclass('public.gazette_issues') IS NOT NULL
    AND to_regclass('public.gazette_issue_entries') IS NOT NULL
    AND to_regclass('city_snapshot.public_records_v2') IS NOT NULL
    AND gazette_submission_room_has_no_forbidden_contents()
    AND gazette_submission_room_guards_ready()
    AND NOT EXISTS (SELECT 1 FROM notes WHERE place_id = 454)
    AND (
      SELECT count(*)
      FROM events event
      WHERE event.kind = 'place_edited'
        AND event.actor = 'the city'
        AND event.detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
    ) = 1
  THEN
    RETURN NEW;
  END IF;

  IF gazette_submission_room_state(OLD) = 'open'
    AND gazette_submission_room_state(NEW) = 'withdrawals_open'
    AND gazette_submission_room_has_no_forbidden_contents()
    AND gazette_submission_room_guards_ready()
    AND (
      SELECT count(*)
      FROM events event
      WHERE event.kind = 'place_edited'
        AND event.actor = 'the city'
        AND event.detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
    ) = 1
    AND (
      SELECT count(*)
      FROM events event
      WHERE event.kind = 'place_edited'
        AND event.actor = 'the city'
        AND event.detail = '{"place_id":454,"gazette_withdrawals_opened":true}'::jsonb
    ) = 1
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Gazette room #454 is a protected city service; it must remain one exact contract state and change only through guarded activation'
    USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
END
$$;

DROP TRIGGER IF EXISTS gazette_submission_room_lifecycle ON places;
CREATE TRIGGER gazette_submission_room_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON places
FOR EACH ROW EXECUTE FUNCTION protect_gazette_submission_room();

CREATE OR REPLACE FUNCTION gazette_submission_room_is_open()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM places place
    WHERE gazette_submission_room_state(place) IN ('open', 'withdrawals_open')
      AND gazette_submission_room_has_no_forbidden_contents()
      AND gazette_submission_room_guards_ready()
      AND (
        SELECT count(*)
        FROM events event
        WHERE event.kind = 'place_edited'
          AND event.actor = 'the city'
          AND event.detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
      ) = 1
      AND (
        gazette_submission_room_state(place) = 'open'
        OR (
          gazette_submission_room_state(place) = 'withdrawals_open'
          AND (
            SELECT count(*)
            FROM events event
            WHERE event.kind = 'place_edited'
              AND event.actor = 'the city'
              AND event.detail = '{"place_id":454,"gazette_withdrawals_opened":true}'::jsonb
          ) = 1
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION gazette_withdrawals_are_open()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM places place
    WHERE gazette_submission_room_state(place) = 'withdrawals_open'
      AND gazette_submission_room_is_open()
      AND gazette_withdrawal_guards_ready()
      AND (
        SELECT count(*)
        FROM events event
        WHERE event.kind = 'place_edited'
          AND event.actor = 'the city'
          AND event.detail = '{"place_id":454,"gazette_withdrawals_opened":true}'::jsonb
      ) = 1
  )
$$;

CREATE OR REPLACE FUNCTION validate_gazette_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  command_place_id INTEGER;
  command_author_id INTEGER;
  command_body TEXT;
  command_created_at TIMESTAMPTZ;
  parsed_target_id INTEGER;
  target_place_id INTEGER;
  target_author_id INTEGER;
  target_created_at TIMESTAMPTZ;
  printed_issue INTEGER;
  print_tick TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(524128261, 454);
  IF NOT gazette_withdrawals_are_open() THEN
    RAISE EXCEPTION 'Gazette withdrawals are not open; read GET /api/gazette and send WITHDRAW only when submission_room.withdrawals_open is true'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawals_closed';
  END IF;
  IF pg_trigger_depth() <> 2 THEN
    RAISE EXCEPTION 'Gazette withdrawal ledger rows are created only by inserting a new withdrawal command note in room #454'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_command_not_note_insert';
  END IF;

  SELECT note.place_id, note.author_id, note.body, note.created_at
  INTO command_place_id, command_author_id, command_body, command_created_at
  FROM notes note WHERE note.id = NEW.command_note_id;
  parsed_target_id := gazette_withdrawal_target(command_body);
  IF command_place_id IS DISTINCT FROM 454
    OR parsed_target_id IS NULL
    OR parsed_target_id IS DISTINCT FROM NEW.target_note_id
    OR NEW.withdrawn_at IS DISTINCT FROM command_created_at
  THEN
    RAISE EXCEPTION 'Gazette withdrawal must be exactly WITHDRAW #<your-note-id>'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_command_invalid';
  END IF;
  SELECT note.place_id, note.author_id, note.created_at
  INTO target_place_id, target_author_id, target_created_at
  FROM notes note WHERE note.id = NEW.target_note_id;
  IF target_place_id IS DISTINCT FROM 454
    OR NEW.target_note_id = NEW.command_note_id
    OR EXISTS (
      SELECT 1 FROM gazette_withdrawals withdrawal
      WHERE withdrawal.command_note_id = NEW.target_note_id
    )
  THEN
    RAISE EXCEPTION 'Gazette submission note #% was not found in room #454', NEW.target_note_id
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_no_such_submission';
  END IF;
  IF target_author_id <> command_author_id THEN
    RAISE EXCEPTION 'only the author may withdraw Gazette submission note #%; you are not its author', NEW.target_note_id
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_author_mismatch';
  END IF;

  SELECT entry.issue_number INTO printed_issue
  FROM gazette_issue_entries entry WHERE entry.note_id = NEW.target_note_id;
  IF printed_issue IS NOT NULL THEN
    RAISE EXCEPTION 'Gazette submission note #% already printed in issue #% and cannot be withdrawn', NEW.target_note_id, printed_issue
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_already_printed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gazette_withdrawals withdrawal
    WHERE withdrawal.target_note_id = NEW.target_note_id
  ) THEN
    RAISE EXCEPTION 'Gazette submission note #% was already withdrawn by its author', NEW.target_note_id
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_already_withdrawn';
  END IF;

  print_tick := gazette_cycle_start(target_created_at) + interval '7 days';
  IF command_created_at >= print_tick THEN
    RAISE EXCEPTION 'Gazette submission note #% can be withdrawn only strictly before %; that print tick has passed',
      NEW.target_note_id,
      to_char(print_tick AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_tick_passed';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION record_gazette_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_note_id INTEGER;
BEGIN
  IF NEW.place_id <> 454 THEN RETURN NEW; END IF;
  IF NOT gazette_withdrawals_are_open() THEN RETURN NEW; END IF;
  target_note_id := gazette_withdrawal_target(NEW.body);
  IF target_note_id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO gazette_withdrawals (target_note_id, command_note_id, withdrawn_at)
  VALUES (target_note_id, NEW.id, NEW.created_at);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS gazette_withdrawals_validate ON gazette_withdrawals;
CREATE TRIGGER gazette_withdrawals_validate
BEFORE INSERT ON gazette_withdrawals
FOR EACH ROW EXECUTE FUNCTION validate_gazette_withdrawal();

DROP TRIGGER IF EXISTS gazette_withdrawals_append_only ON gazette_withdrawals;
CREATE TRIGGER gazette_withdrawals_append_only
BEFORE UPDATE OR DELETE ON gazette_withdrawals
FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS gazette_withdrawals_no_truncate ON gazette_withdrawals;
CREATE TRIGGER gazette_withdrawals_no_truncate
BEFORE TRUNCATE ON gazette_withdrawals
FOR EACH STATEMENT EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS gazette_note_record_withdrawal ON notes;
CREATE TRIGGER gazette_note_record_withdrawal
AFTER INSERT ON notes
FOR EACH ROW EXECUTE FUNCTION record_gazette_withdrawal();

CREATE OR REPLACE FUNCTION enforce_gazette_submission_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cycle_start TIMESTAMPTZ;
  submissions INTEGER;
  withdrawal_target INTEGER;
BEGIN
  IF NEW.place_id <> 454 THEN
    RETURN NEW;
  END IF;

  -- Note actions take the resident retry lock first. The printer takes only the
  -- second lock, so lock order cannot cycle.
  PERFORM pg_advisory_xact_lock(524128260, NEW.author_id);
  PERFORM pg_advisory_xact_lock(524128261, 454);

  IF NOT gazette_submission_room_is_open() THEN
    RAISE EXCEPTION 'Gazette submission room #454 is not open; read GET /api/gazette and submit only when submission_room.submissions_open is true'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_closed';
  END IF;

  -- The database clock owns the public submission time. A direct writer cannot
  -- escape a weekly quota or create a retroactive print candidate by supplying
  -- a past or future created_at value.
  NEW.created_at := clock_timestamp();
  IF gazette_withdrawals_are_open()
    AND gazette_withdrawal_command_reserved(NEW.body)
  THEN
    withdrawal_target := gazette_withdrawal_target(NEW.body);
    IF withdrawal_target IS NULL THEN
      RAISE EXCEPTION 'Gazette withdrawal must be exactly WITHDRAW #<your-note-id>'
        USING ERRCODE = '23514', CONSTRAINT = 'gazette_withdrawal_command_invalid';
    END IF;
    RETURN NEW;
  END IF;
  cycle_start := gazette_cycle_start(NEW.created_at);

  SELECT count(*)::integer
  INTO submissions
  FROM notes existing
  WHERE existing.place_id = 454
    AND existing.author_id = NEW.author_id
    AND existing.created_at >= cycle_start
    AND existing.created_at < cycle_start + interval '7 days'
    AND NOT EXISTS (
      SELECT 1 FROM gazette_withdrawals withdrawal
      WHERE withdrawal.command_note_id = existing.id
    );

  IF submissions >= 3 THEN
    RAISE EXCEPTION '3 Gazette submissions per resident are allowed from Monday 16:00 UTC inclusive to the next Monday 16:00 UTC exclusive; this Gazette week''s 3 submissions are used; retry at %',
      to_char(
        (cycle_start + interval '7 days') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_weekly_limit';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS gazette_note_submission_limit ON notes;
CREATE TRIGGER gazette_note_submission_limit
BEFORE INSERT ON notes
FOR EACH ROW EXECUTE FUNCTION enforce_gazette_submission_limit();

DROP TRIGGER IF EXISTS gazette_issue_entry_source ON gazette_issue_entries;
CREATE TRIGGER gazette_issue_entry_source
BEFORE INSERT ON gazette_issue_entries
FOR EACH ROW EXECUTE FUNCTION validate_gazette_issue_entry();

DROP TRIGGER IF EXISTS gazette_issue_membership_complete ON gazette_issues;
CREATE CONSTRAINT TRIGGER gazette_issue_membership_complete
AFTER INSERT ON gazette_issues
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_gazette_issue_membership();

DROP TRIGGER IF EXISTS gazette_issue_entries_membership_complete ON gazette_issue_entries;
CREATE CONSTRAINT TRIGGER gazette_issue_entries_membership_complete
AFTER INSERT ON gazette_issue_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_gazette_issue_membership();

DROP TRIGGER IF EXISTS gazette_issues_append_only ON gazette_issues;
CREATE TRIGGER gazette_issues_append_only
BEFORE UPDATE OR DELETE ON gazette_issues
FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS gazette_issue_entries_append_only ON gazette_issue_entries;
CREATE TRIGGER gazette_issue_entries_append_only
BEFORE UPDATE OR DELETE ON gazette_issue_entries
FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS gazette_issues_no_truncate ON gazette_issues;
CREATE TRIGGER gazette_issues_no_truncate
BEFORE TRUNCATE ON gazette_issues
FOR EACH STATEMENT EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS gazette_issue_entries_no_truncate ON gazette_issue_entries;
CREATE TRIGGER gazette_issue_entries_no_truncate
BEFORE TRUNCATE ON gazette_issue_entries
FOR EACH STATEMENT EXECUTE FUNCTION deny_history_mutation();

-- Fresh installs normally have no #454 row yet. If a seed or rerun does, wait
-- until every readiness guard exists, then require one of the same three states
-- accepted by the live contract.
DO $$
DECLARE
  room_state TEXT;
  activation_events INTEGER;
  withdrawal_activation_events INTEGER;
BEGIN
  SELECT gazette_submission_room_state(place)
  INTO room_state
  FROM places place
  WHERE place.id = 454;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer
  INTO activation_events
  FROM events event
  WHERE event.kind = 'place_edited'
    AND event.actor = 'the city'
    AND event.detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb;

  SELECT count(*)::integer
  INTO withdrawal_activation_events
  FROM events event
  WHERE event.kind = 'place_edited'
    AND event.actor = 'the city'
    AND event.detail = '{"place_id":454,"gazette_withdrawals_opened":true}'::jsonb;

  IF gazette_submission_room_has_no_forbidden_contents()
    AND gazette_submission_room_guards_ready()
    AND ((room_state = 'closed' AND activation_events = 0 AND withdrawal_activation_events = 0)
      OR (room_state = 'open' AND activation_events = 1 AND withdrawal_activation_events = 0)
      OR (room_state = 'withdrawals_open'
        AND activation_events = 1 AND withdrawal_activation_events = 1))
  THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Gazette room #454 is not a verified Gazette contract state; restore the public room contract before installing the Gazette'
    USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
END
$$;

-- Snapshot format v1 is already public and immutable. Format v2 keeps that
-- projection as an internal input, adds the permanent Gazette ledgers, and
-- restores the Gazette print fields that v1 could not know about. The export
-- role may read only this new four-column security boundary.
CREATE OR REPLACE VIEW city_snapshot.public_records_v2
WITH (security_barrier = true)
AS
WITH public_event_kinds_v2(kind) AS (
  VALUES
    ('register'),
    ('rotate'),
    ('resident_edited'),
    ('home_set'),
    ('place_created'),
    ('place_edited'),
    ('place_renamed'),
    ('place_retired'),
    ('place_restored'),
    ('kind_invented'),
    ('kind_revised'),
    ('trait_coined'),
    ('thing_created'),
    ('thing_crafted'),
    ('thing_edited'),
    ('thing_moved'),
    ('thing_upgraded'),
    ('thing_withdrawn'),
    ('laws_changed'),
    ('action'),
    ('effect_scheduled'),
    ('effect_resolved'),
    ('note'),
    ('gazette_printed'),
    ('agreement'),
    ('agreement_accession'),
    ('agreement_sign'),
    ('transfer'),
    ('transfer_offer'),
    ('sale'),
    ('transfer_cancel'),
    ('world_listed'),
    ('world_sale'),
    ('world_cancel'),
    ('payment_repair'),
    ('flag'),
    ('moderation')
)
SELECT base_record.class_name,
  base_record.record_id,
  base_record.sort_key,
  CASE
    WHEN base_record.class_name = 'events'
      AND NOT EXISTS (
        SELECT 1
        FROM public_event_kinds_v2 public_kind
        WHERE public_kind.kind = base_record.payload->>'kind'
      )
    THEN jsonb_build_object(
      'id', base_record.payload->'id',
      'status', 'not_public_or_sequence_gap'
    )
    WHEN base_record.class_name = 'events'
      AND base_record.payload->>'kind' = 'gazette_printed'
      AND gazette_issue.event_id IS NOT NULL
    THEN jsonb_set(
      base_record.payload #- '{detail,error}',
      '{detail}',
      (coalesce(base_record.payload->'detail', '{}'::jsonb) - 'error') || jsonb_build_object(
        'issue_number', gazette_issue.issue_number,
        'entry_count', gazette_issue.entry_count
      ),
      TRUE
    )
    WHEN base_record.class_name = 'events'
    THEN base_record.payload #- '{detail,error}'
    ELSE base_record.payload
  END AS payload
FROM city_snapshot.public_records base_record
LEFT JOIN public.gazette_issues gazette_issue
  ON base_record.class_name = 'events'
    AND base_record.record_id = gazette_issue.event_id::TEXT

UNION ALL

SELECT 'gazette_issues'::TEXT AS class_name,
  issue.issue_number::TEXT AS record_id,
  issue.issue_number::BIGINT AS sort_key,
  jsonb_build_object(
    'id', issue.issue_number,
    'status', 'exported',
    'issue_number', issue.issue_number,
    'scheduled_for', issue.scheduled_for,
    'printed_at', issue.printed_at,
    'header', issue.header,
    'entry_count', issue.entry_count,
    'event_id', issue.event_id
  ) AS payload
FROM public.gazette_issues issue

UNION ALL

SELECT 'gazette_issue_entries'::TEXT AS class_name,
  entry.note_id::TEXT AS record_id,
  entry.note_id::BIGINT AS sort_key,
  jsonb_build_object(
    'id', entry.note_id,
    'status', 'exported',
    'issue_number', entry.issue_number,
    'ordinal', entry.ordinal,
    'note_id', entry.note_id,
    'author_id', note.author_id,
    'author', author.handle,
    'created_at', note.created_at
  ) || CASE
    WHEN withdrawal.target_note_id IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object(
      'withdrawn', TRUE,
      'withdrawal_note_id', withdrawal.command_note_id,
      'withdrawn_at', withdrawal.withdrawn_at
    )
  END AS payload
FROM public.gazette_issue_entries entry
JOIN public.notes note ON note.id = entry.note_id
JOIN public.residents author ON author.id = note.author_id
LEFT JOIN public.gazette_withdrawals withdrawal
  ON withdrawal.target_note_id = entry.note_id

UNION ALL

SELECT 'gazette_withdrawals'::TEXT AS class_name,
  withdrawal.target_note_id::TEXT AS record_id,
  withdrawal.target_note_id::BIGINT AS sort_key,
  jsonb_build_object(
    'id', withdrawal.target_note_id,
    'status', 'exported',
    'target_note_id', withdrawal.target_note_id,
    'withdrawal_note_id', withdrawal.command_note_id,
    'author_id', target_note.author_id,
    'author', author.handle,
    'withdrawn_at', withdrawal.withdrawn_at
  ) AS payload
FROM public.gazette_withdrawals withdrawal
JOIN public.notes target_note ON target_note.id = withdrawal.target_note_id
JOIN public.residents author ON author.id = target_note.author_id;

REVOKE ALL ON city_snapshot.public_records_v2 FROM PUBLIC;
REVOKE SELECT ON city_snapshot.public_records FROM city_snapshot_export;
GRANT SELECT ON city_snapshot.public_records_v2 TO city_snapshot_export;


CREATE OR REPLACE FUNCTION complete_city_credit_purchase(
  requested_attempt_id TEXT,
  expected_lease_owner TEXT
) RETURNS TABLE (
  state TEXT,
  attempt_id TEXT,
  reason TEXT,
  actor_id INTEGER,
  amount_units TEXT,
  entry_id TEXT,
  response_status SMALLINT,
  response_json JSONB,
  response_body TEXT,
  payment_response_header TEXT
) LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  attempt payment_attempts%ROWTYPE;
  purchase city_credit_entries%ROWTYPE;
  balance BIGINT;
  amount_text TEXT;
  balance_text TEXT;
  body_json JSONB;
  body_text TEXT;
BEGIN
  SELECT * INTO attempt
  FROM payment_attempts stored
  WHERE stored.public_id = requested_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit purchase payment attempt was not found' USING ERRCODE = '55000';
  END IF;

  attempt_id := attempt.public_id;

  IF attempt.status = 'completed' THEN
    SELECT * INTO purchase FROM city_credit_entries entry
    WHERE entry.payment_attempt_id = attempt.public_id AND entry.entry_kind = 'purchase';
    IF NOT FOUND OR attempt.response_body_bytes IS NULL THEN
      RAISE EXCEPTION 'completed credit purchase receipt is unavailable' USING ERRCODE = '55000';
    END IF;
    state := 'completed';
    reason := NULL;
    actor_id := attempt.actor_id;
    amount_units := attempt.amount_units::text;
    entry_id := purchase.id::text;
    response_status := attempt.response_status;
    response_body := convert_from(attempt.response_body_bytes, 'UTF8');
    response_json := response_body::jsonb;
    payment_response_header := attempt.response_json #>> '{__1f3d9_x402_response_v1,header}';
    RETURN NEXT;
    RETURN;
  END IF;

  IF attempt.recovery_deadline_at IS NOT NULL
    AND attempt.recovery_deadline_at <= clock_timestamp() THEN
    state := 'deadline_passed';
    reason := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  IF attempt.status <> 'payment_pending'
    OR attempt.operation <> 'credit_purchase'
    OR attempt.method <> 'x402'
    OR attempt.lease_owner IS DISTINCT FROM expected_lease_owner
    OR attempt.counterparty_id IS NOT NULL OR attempt.offer_id IS NOT NULL
    OR attempt.asset_type IS NOT NULL OR attempt.asset_id IS NOT NULL
    OR attempt.network <> 'base'
    OR attempt.token <> '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    OR attempt.payer_wallet IS NULL OR attempt.payee_wallet IS NULL
    OR attempt.amount_units <= 0 OR attempt.amount_units > 10000000000
    OR attempt.amount_units % 1000000 <> 0
    OR attempt.tx_hash IS NULL OR attempt.finalized_block_number IS NULL
    OR attempt.finalized_block_hash IS NULL OR attempt.finalized_block_time IS NULL
    OR attempt.finalized_at IS NULL
    OR attempt.recovery_deadline_at IS NULL
    OR jsonb_typeof(attempt.request_json) <> 'object'
    OR attempt.request_json ?& ARRAY['request_id', 'amount_dollars'] IS NOT TRUE
    OR attempt.request_json->>'amount_dollars' <> (attempt.amount_units / 1000000)::text
    OR attempt.target_key <> 'city-credit-purchase:' || attempt.actor_id::text || ':' ||
      (attempt.request_json->>'request_id') THEN
    state := 'target_changed';
    reason := 'stored credit purchase terms changed';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO payment_uses (
    tx_hash, payment_attempt_id, actor_id, purpose,
    payer_wallet, payee_wallet, amount_usdc
  ) VALUES (
    attempt.tx_hash, attempt.public_id, attempt.actor_id, 'credit_purchase',
    attempt.payer_wallet, attempt.payee_wallet,
    attempt.amount_units::numeric / 1000000
  );

  INSERT INTO city_credit_entries (
    resident_id, entry_kind, amount_units, payment_attempt_id,
    source_key, purchase_kind
  ) VALUES (
    attempt.actor_id, 'purchase', attempt.amount_units, attempt.public_id,
    'x402:credit:' || attempt.tx_hash, 'x402'
  ) RETURNING * INTO purchase;

  SELECT account.balance_units INTO balance
  FROM city_credit_accounts account
  WHERE account.resident_id = attempt.actor_id;
  amount_text := (attempt.amount_units / 1000000)::text || '.000000';
  balance_text := (balance / 1000000)::text || '.' ||
    lpad((balance % 1000000)::text, 6, '0');
  body_json := jsonb_build_object('city_fee_credit', jsonb_build_object(
    'purchased', amount_text,
    'purchased_units', attempt.amount_units::text,
    'balance_usdc', balance_text,
    'balance_units', balance::text,
    'receipt_id', purchase.id::text
  ));
  body_text := replace(replace(body_json::text, ': ', ':'), ', ', ',');

  PERFORM complete_payment_attempt(
    attempt.public_id,
    expected_lease_owner,
    jsonb_build_object('kind', 'city_credit_purchase', 'id', purchase.id),
    201::smallint,
    body_json,
    convert_to(body_text, 'UTF8')
  );

  state := 'completed';
  reason := NULL;
  actor_id := attempt.actor_id;
  amount_units := attempt.amount_units::text;
  entry_id := purchase.id::text;
  response_status := 201;
  response_json := body_json;
  response_body := body_text;
  payment_response_header := attempt.response_json #>> '{__1f3d9_x402_response_v1,header}';
  RETURN NEXT;
END
$$;

-- PayPal dispute custody (2026-08-27; migration mirror).
ALTER TABLE city_credit_gifts
  ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

ALTER TABLE city_credit_gifts
  DROP CONSTRAINT IF EXISTS city_credit_gifts_status_check,
  DROP CONSTRAINT IF EXISTS city_credit_gifts_check;
ALTER TABLE city_credit_gifts
  ADD CONSTRAINT city_credit_gifts_status_check CHECK (
    status IN ('pending', 'accepted', 'refused', 'frozen', 'revoked')
  ),
  ADD CONSTRAINT city_credit_gifts_check CHECK (
    (status = 'pending' AND accepted_at IS NULL AND refused_at IS NULL
      AND frozen_at IS NULL AND revoked_at IS NULL)
    OR (status = 'accepted' AND accepted_at IS NOT NULL AND refused_at IS NULL
      AND frozen_at IS NULL AND revoked_at IS NULL)
    OR (status = 'refused' AND accepted_at IS NULL AND refused_at IS NOT NULL
      AND revoked_at IS NULL)
    OR (status = 'frozen' AND accepted_at IS NULL AND refused_at IS NULL
      AND frozen_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND accepted_at IS NULL AND refused_at IS NULL
      AND frozen_at IS NOT NULL AND revoked_at IS NOT NULL)
  );

ALTER TABLE city_credit_entries
  DROP CONSTRAINT IF EXISTS city_credit_entries_source_key_check;
ALTER TABLE city_credit_entries
  ADD CONSTRAINT city_credit_entries_source_key_check CHECK (
    source_key IS NULL OR (
      octet_length(source_key) BETWEEN 8 AND 300
      AND source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
    )
  );
ALTER TABLE city_credit_gifts
  DROP CONSTRAINT IF EXISTS city_credit_gifts_source_key_check;
ALTER TABLE city_credit_gifts
  ADD CONSTRAINT city_credit_gifts_source_key_check CHECK (
    octet_length(source_key) BETWEEN 8 AND 300
    AND source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
  );

CREATE OR REPLACE FUNCTION paypal_credit_capture_ids_are_canonical(
  capture_ids TEXT[]
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(capture_ids) BETWEEN 1 AND 1000
    AND NOT EXISTS (
      SELECT 1 FROM unnest(capture_ids) capture_id
      WHERE capture_id IS NULL
        OR octet_length(capture_id) NOT BETWEEN 1 AND 255
        OR capture_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    )
    AND capture_ids = ARRAY(
      SELECT DISTINCT capture_id COLLATE "C"
      FROM unnest(capture_ids) capture_id
      ORDER BY capture_id COLLATE "C"
    );
$$;

CREATE SEQUENCE IF NOT EXISTS paypal_credit_dispute_event_sequence_seq;

CREATE TABLE IF NOT EXISTS paypal_credit_disputes (
  dispute_id           TEXT PRIMARY KEY CHECK (
                         octet_length(dispute_id) BETWEEN 1 AND 255
                         AND dispute_id ~ '^[A-Za-z0-9][A-Za-z0-9-]*$'
                       ),
  state                TEXT NOT NULL CHECK (
                         state IN ('open', 'resolved_seller',
                           'resolved_against_seller', 'resolution_review')
                       ),
  paypal_status        TEXT NOT NULL CHECK (
                         paypal_status IN ('OPEN', 'WAITING_FOR_BUYER_RESPONSE',
                           'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW',
                           'RESOLVED', 'OTHER')
                       ),
  outcome_code         TEXT,
  resource_updated_at  TIMESTAMPTZ NOT NULL,
  current_event_sequence BIGINT NOT NULL DEFAULT 0,
  review_decision      TEXT,
  reviewed_at          TIMESTAMPTZ,
  opened_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT paypal_credit_disputes_state_terms_check CHECK (
    (state = 'open' AND outcome_code IS NULL AND resolved_at IS NULL
      AND review_decision IS NULL AND reviewed_at IS NULL)
    OR (state = 'resolved_seller'
      AND resolved_at IS NOT NULL AND (
        (outcome_code IN ('RESOLVED_SELLER_FAVOUR',
          'CANCELED_BY_BUYER', 'DENIED')
          AND review_decision IS NULL AND reviewed_at IS NULL)
        OR (outcome_code IN ('RESOLVED_WITH_PAYOUT', 'NONE')
          AND review_decision = 'seller_favour' AND reviewed_at IS NOT NULL)
      ))
    OR (state = 'resolved_against_seller'
      AND resolved_at IS NOT NULL AND (
        (outcome_code IN ('RESOLVED_BUYER_FAVOUR', 'ACCEPTED')
          AND review_decision IS NULL AND reviewed_at IS NULL)
        OR (outcome_code IN ('RESOLVED_WITH_PAYOUT', 'NONE')
          AND review_decision = 'buyer_favour' AND reviewed_at IS NOT NULL)
      ))
    OR (state = 'resolution_review' AND outcome_code IN (
      'RESOLVED_WITH_PAYOUT', 'NONE'
    ) AND resolved_at IS NOT NULL
      AND review_decision IS NULL AND reviewed_at IS NULL)
  )
);

ALTER TABLE paypal_credit_disputes
  ADD COLUMN IF NOT EXISTS current_event_sequence BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_decision TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE paypal_credit_disputes
  DROP CONSTRAINT IF EXISTS paypal_credit_disputes_check,
  DROP CONSTRAINT IF EXISTS paypal_credit_disputes_current_event_sequence_check,
  DROP CONSTRAINT IF EXISTS paypal_credit_disputes_review_decision_check,
  DROP CONSTRAINT IF EXISTS paypal_credit_disputes_state_terms_check;
ALTER TABLE paypal_credit_disputes
  ADD CONSTRAINT paypal_credit_disputes_current_event_sequence_check CHECK (
    current_event_sequence >= 0
  ),
  ADD CONSTRAINT paypal_credit_disputes_review_decision_check CHECK (
    review_decision IS NULL
      OR review_decision IN ('seller_favour', 'buyer_favour')
  ),
  ADD CONSTRAINT paypal_credit_disputes_state_terms_check CHECK (
    (state = 'open' AND outcome_code IS NULL AND resolved_at IS NULL
      AND review_decision IS NULL AND reviewed_at IS NULL)
    OR (state = 'resolved_seller'
      AND resolved_at IS NOT NULL AND (
        (outcome_code IN ('RESOLVED_SELLER_FAVOUR',
          'CANCELED_BY_BUYER', 'DENIED')
          AND review_decision IS NULL AND reviewed_at IS NULL)
        OR (outcome_code IN ('RESOLVED_WITH_PAYOUT', 'NONE')
          AND review_decision = 'seller_favour' AND reviewed_at IS NOT NULL)
      ))
    OR (state = 'resolved_against_seller'
      AND resolved_at IS NOT NULL AND (
        (outcome_code IN ('RESOLVED_BUYER_FAVOUR', 'ACCEPTED')
          AND review_decision IS NULL AND reviewed_at IS NULL)
        OR (outcome_code IN ('RESOLVED_WITH_PAYOUT', 'NONE')
          AND review_decision = 'buyer_favour' AND reviewed_at IS NOT NULL)
      ))
    OR (state = 'resolution_review' AND outcome_code IN (
      'RESOLVED_WITH_PAYOUT', 'NONE'
    ) AND resolved_at IS NOT NULL
      AND review_decision IS NULL AND reviewed_at IS NULL)
  );

CREATE TABLE IF NOT EXISTS paypal_credit_dispute_events (
  paypal_event_id      TEXT PRIMARY KEY CHECK (
                         octet_length(paypal_event_id) BETWEEN 1 AND 128
                         AND paypal_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
                       ),
  dispute_id           TEXT NOT NULL REFERENCES paypal_credit_disputes(dispute_id)
                         ON DELETE RESTRICT,
  event_kind           TEXT NOT NULL CHECK (event_kind IN (
                         'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED',
                         'CUSTOMER.DISPUTE.RESOLVED'
                       )),
  paypal_status        TEXT NOT NULL CHECK (
                         paypal_status IN ('OPEN', 'WAITING_FOR_BUYER_RESPONSE',
                           'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW',
                           'RESOLVED', 'OTHER')
                       ),
  outcome_code         TEXT,
  resource_updated_at  TIMESTAMPTZ NOT NULL,
  transaction_capture_ids TEXT[] NOT NULL CHECK (
                         paypal_credit_capture_ids_are_canonical(
                           transaction_capture_ids
                         )
                       ),
  event_sequence       BIGINT NOT NULL DEFAULT nextval(
                         'paypal_credit_dispute_event_sequence_seq'
                       ),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_sequence),
  CHECK (
    (event_kind <> 'CUSTOMER.DISPUTE.RESOLVED'
      AND paypal_status <> 'RESOLVED' AND outcome_code IS NULL)
    OR (event_kind = 'CUSTOMER.DISPUTE.RESOLVED'
      AND paypal_status = 'RESOLVED' AND outcome_code IN (
        'RESOLVED_BUYER_FAVOUR', 'RESOLVED_SELLER_FAVOUR',
        'RESOLVED_WITH_PAYOUT', 'CANCELED_BY_BUYER', 'ACCEPTED', 'DENIED', 'NONE'
      ))
  )
);

ALTER TABLE paypal_credit_dispute_events
  ADD COLUMN IF NOT EXISTS event_sequence BIGINT;
ALTER SEQUENCE paypal_credit_dispute_event_sequence_seq
  OWNED BY paypal_credit_dispute_events.event_sequence;
ALTER TABLE paypal_credit_dispute_events
  ALTER COLUMN event_sequence SET DEFAULT nextval(
    'paypal_credit_dispute_event_sequence_seq'
  );
UPDATE paypal_credit_dispute_events
SET event_sequence = nextval('paypal_credit_dispute_event_sequence_seq')
WHERE event_sequence IS NULL;
ALTER TABLE paypal_credit_dispute_events
  ALTER COLUMN event_sequence SET NOT NULL;
DO $drop_equal_time_event_identity$
DECLARE
  stored_constraint TEXT;
BEGIN
  SELECT constraint_name.conname INTO stored_constraint
  FROM pg_constraint constraint_name
  WHERE constraint_name.conrelid = 'paypal_credit_dispute_events'::regclass
    AND constraint_name.contype = 'u'
    AND pg_get_constraintdef(constraint_name.oid) =
      'UNIQUE (dispute_id, event_kind, resource_updated_at)'
  LIMIT 1;
  IF stored_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE paypal_credit_dispute_events DROP CONSTRAINT %I',
      stored_constraint
    );
  END IF;
END
$drop_equal_time_event_identity$;
CREATE UNIQUE INDEX IF NOT EXISTS paypal_credit_dispute_events_sequence
  ON paypal_credit_dispute_events (event_sequence);

WITH latest AS (
  SELECT DISTINCT ON (event.dispute_id)
    event.dispute_id, event.event_sequence
  FROM paypal_credit_dispute_events event
  ORDER BY event.dispute_id, event.resource_updated_at DESC,
    CASE event.event_kind
      WHEN 'CUSTOMER.DISPUTE.CREATED' THEN 1
      WHEN 'CUSTOMER.DISPUTE.UPDATED' THEN 2
      ELSE 3
    END DESC,
    event.event_sequence DESC
)
UPDATE paypal_credit_disputes dispute
SET current_event_sequence = latest.event_sequence
FROM latest
WHERE dispute.dispute_id = latest.dispute_id
  AND dispute.current_event_sequence = 0;

CREATE TABLE IF NOT EXISTS paypal_credit_dispute_reviews (
  id              BIGSERIAL PRIMARY KEY,
  dispute_id      TEXT NOT NULL UNIQUE
                    REFERENCES paypal_credit_disputes(dispute_id)
                    ON DELETE RESTRICT,
  founder_id      INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT
                    CHECK (founder_id = 1),
  decision        TEXT NOT NULL CHECK (
                    decision IN ('seller_favour', 'buyer_favour')
                  ),
  public_event_id INTEGER NOT NULL UNIQUE REFERENCES events(id)
                    ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE city_credit_entries
  ADD COLUMN IF NOT EXISTS related_purchase_id BIGINT
    REFERENCES city_credit_entries(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS paypal_dispute_id TEXT
    REFERENCES paypal_credit_disputes(dispute_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS paypal_event_id TEXT
    REFERENCES paypal_credit_dispute_events(paypal_event_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS paypal_dispute_review_id BIGINT
    REFERENCES paypal_credit_dispute_reviews(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS paypal_resource_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS application_outcome TEXT;

CREATE TABLE IF NOT EXISTS founder_city_credit_notes (
  id          BIGSERIAL PRIMARY KEY,
  founder_id  INTEGER NOT NULL DEFAULT 1 REFERENCES residents(id) ON DELETE RESTRICT
                CHECK (founder_id = 1),
  dispute_id  TEXT NOT NULL UNIQUE REFERENCES paypal_credit_disputes(dispute_id)
                ON DELETE RESTRICT,
  body        TEXT NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 2000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paypal_credit_disputes_updated
  ON paypal_credit_disputes (updated_at DESC, dispute_id);
CREATE INDEX IF NOT EXISTS paypal_credit_dispute_events_capture_ids
  ON paypal_credit_dispute_events USING gin (transaction_capture_ids);
CREATE INDEX IF NOT EXISTS city_credit_gifts_recipient_frozen
  ON city_credit_gifts (recipient_id, id DESC) WHERE status = 'frozen';
DROP INDEX IF EXISTS city_credit_entries_paypal_dispute_event;
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_paypal_dispute_purchase
  ON city_credit_entries (paypal_event_id, related_purchase_id)
  WHERE paypal_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_paypal_review_purchase
  ON city_credit_entries (paypal_dispute_review_id, related_purchase_id)
  WHERE paypal_dispute_review_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paypal_credit_events_credited_capture
  ON paypal_credit_events (remote_resource_id)
  WHERE outcome = 'credited' AND event_kind = 'PAYMENT.CAPTURE.COMPLETED';

ALTER TABLE city_credit_entries
  DROP CONSTRAINT IF EXISTS city_credit_entries_entry_kind_check,
  DROP CONSTRAINT IF EXISTS city_credit_entries_check;
ALTER TABLE city_credit_entries
  ADD CONSTRAINT city_credit_entries_entry_kind_check CHECK (entry_kind IN (
    'founder_issue', 'purchase', 'gift_pending', 'gift_accept',
    'gift_refuse', 'gift_redirect', 'spend', 'return',
    'admin_credit', 'admin_debit', 'paypal_dispute_created',
    'paypal_dispute_updated', 'paypal_dispute_resolved',
    'paypal_dispute_reviewed'
  )),
  ADD CONSTRAINT city_credit_entries_check CHECK (
    (
      entry_kind IN ('founder_issue', 'admin_credit', 'admin_debit')
      AND amount_units = 1000000
      AND founder_id = 1 AND source_key IS NOT NULL AND reason IS NOT NULL
      AND request_id IS NULL AND payment_attempt_id IS NULL
      AND related_spend_id IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NULL
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
    )
    OR (
      entry_kind = 'purchase'
      AND founder_id IS NULL AND source_key IS NOT NULL AND reason IS NULL
      AND request_id IS NULL AND related_spend_id IS NULL
      AND purchase_kind IN ('paypal', 'allowance', 'x402')
      AND counterparty_id IS NULL
      AND (purchase_kind <> 'allowance' OR gift_id IS NULL)
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
      AND (
        (purchase_kind = 'x402' AND payment_attempt_id IS NOT NULL AND gift_id IS NULL)
        OR (purchase_kind IN ('paypal', 'allowance') AND payment_attempt_id IS NULL)
      )
    )
    OR (
      entry_kind = 'spend'
      AND amount_units = 1000000
      AND founder_id IS NULL AND source_key IS NULL AND request_id IS NOT NULL
      AND payment_attempt_id IS NOT NULL AND related_spend_id IS NULL
      AND reason IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NULL
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
    )
    OR (
      entry_kind = 'return'
      AND amount_units = 1000000
      AND founder_id IS NULL AND source_key IS NULL AND request_id IS NULL
      AND payment_attempt_id IS NOT NULL AND related_spend_id IS NOT NULL
      AND reason IS NOT NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NULL
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
    )
    OR (
      entry_kind IN ('gift_pending', 'gift_accept', 'gift_refuse')
      AND founder_id IS NULL AND source_key IS NOT NULL AND request_id IS NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NOT NULL
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
    )
    OR (
      entry_kind = 'gift_redirect'
      AND founder_id IS NULL AND source_key IS NOT NULL AND request_id IS NOT NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NOT NULL AND gift_id IS NOT NULL
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
    )
    OR (
      entry_kind IN ('paypal_dispute_created', 'paypal_dispute_updated',
        'paypal_dispute_resolved')
      AND founder_id IS NULL AND source_key IS NULL AND request_id IS NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NOT NULL AND purchase_kind IS NULL AND counterparty_id IS NULL
      AND related_purchase_id IS NOT NULL AND paypal_dispute_id IS NOT NULL
      AND paypal_event_id IS NOT NULL AND paypal_resource_updated_at IS NOT NULL
      AND application_outcome IN (
        'dispute_open_gift_frozen', 'dispute_open_refused_gift_blocked',
        'dispute_open_credit_retained', 'dispute_resolved_gift_pending',
        'dispute_resolved_refused_gift',
        'dispute_resolved_gift_still_frozen',
        'dispute_resolved_gift_revoked',
        'dispute_resolved_credit_retained',
        'dispute_resolution_needs_operator_review',
        'dispute_stale_event_ignored'
      )
    )
    OR (
      entry_kind = 'paypal_dispute_reviewed'
      AND founder_id IS NULL AND source_key IS NULL AND request_id IS NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NOT NULL AND purchase_kind IS NULL AND counterparty_id IS NULL
      AND related_purchase_id IS NOT NULL AND paypal_dispute_id IS NOT NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND paypal_dispute_review_id IS NOT NULL
      AND application_outcome IN (
        'founder_review_gift_pending',
        'founder_review_refused_gift_redirectable',
        'founder_review_gift_still_frozen',
        'founder_review_gift_still_revoked',
        'founder_review_gift_revoked',
        'founder_review_credit_retained'
      )
    )
  );

ALTER TABLE city_credit_entries
  DROP CONSTRAINT IF EXISTS city_credit_entries_paypal_review_source_check;
ALTER TABLE city_credit_entries
  ADD CONSTRAINT city_credit_entries_paypal_review_source_check CHECK (
    (entry_kind = 'paypal_dispute_reviewed')
      = (paypal_dispute_review_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION protect_paypal_credit_dispute()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PayPal credit dispute history cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.dispute_id, NEW.created_at, NEW.opened_at)
    IS DISTINCT FROM ROW(OLD.dispute_id, OLD.created_at, OLD.opened_at) THEN
    RAISE EXCEPTION 'PayPal dispute identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.resource_updated_at < OLD.resource_updated_at
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'PayPal dispute time cannot move backward'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.review_decision IS NOT NULL AND ROW(
    NEW.state, NEW.paypal_status, NEW.outcome_code,
    NEW.resource_updated_at, NEW.current_event_sequence,
    NEW.review_decision, NEW.reviewed_at, NEW.resolved_at
  ) IS DISTINCT FROM ROW(
    OLD.state, OLD.paypal_status, OLD.outcome_code,
    OLD.resource_updated_at, OLD.current_event_sequence,
    OLD.review_decision, OLD.reviewed_at, OLD.resolved_at
  ) THEN
    RAISE EXCEPTION 'founder PayPal dispute review is terminal'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'resolved_against_seller'
    AND NEW.state <> 'resolved_against_seller' THEN
    RAISE EXCEPTION 'adverse PayPal dispute custody is terminal'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_disputes_guard ON paypal_credit_disputes;
CREATE TRIGGER paypal_credit_disputes_guard
  BEFORE UPDATE OR DELETE ON paypal_credit_disputes
  FOR EACH ROW EXECUTE FUNCTION protect_paypal_credit_dispute();

DROP TRIGGER IF EXISTS paypal_credit_dispute_events_append_only
  ON paypal_credit_dispute_events;
CREATE TRIGGER paypal_credit_dispute_events_append_only
  BEFORE UPDATE OR DELETE ON paypal_credit_dispute_events
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS paypal_credit_dispute_reviews_append_only
  ON paypal_credit_dispute_reviews;
CREATE TRIGGER paypal_credit_dispute_reviews_append_only
  BEFORE UPDATE OR DELETE ON paypal_credit_dispute_reviews
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS founder_city_credit_notes_append_only
  ON founder_city_credit_notes;
CREATE TRIGGER founder_city_credit_notes_append_only
  BEFORE UPDATE OR DELETE ON founder_city_credit_notes
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

CREATE OR REPLACE FUNCTION protect_city_credit_gift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'city credit gift history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.id, NEW.public_id, NEW.amount_units, NEW.source_key,
    NEW.claim_token_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.public_id, OLD.amount_units, OLD.source_key,
    OLD.claim_token_hash, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'city credit gift purchase terms are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.source_entry_id IS NOT NULL
    AND NEW.source_entry_id IS DISTINCT FROM OLD.source_entry_id THEN
    RAISE EXCEPTION 'city credit gift purchase receipt is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('accepted', 'revoked') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'accepted or revoked city credit gift is terminal' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN (
    'pending', 'accepted', 'refused', 'frozen', 'revoked'
  ) THEN
    RAISE EXCEPTION 'invalid city credit gift transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'refused' AND NEW.status NOT IN ('refused', 'pending', 'revoked') THEN
    RAISE EXCEPTION 'invalid city credit gift transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'frozen'
    AND NEW.status NOT IN ('frozen', 'pending', 'refused', 'revoked') THEN
    RAISE EXCEPTION 'invalid frozen city credit gift transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'refused' AND NEW.status = 'pending'
    AND NEW.recipient_id IS NOT DISTINCT FROM OLD.recipient_id THEN
    RAISE EXCEPTION 'a refused city credit gift becomes pending only by redirect'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'refused'
    AND NEW.status = 'pending'
    AND (
      OLD.frozen_at IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM paypal_credit_disputes dispute
        JOIN paypal_credit_dispute_events event
          ON event.dispute_id = dispute.dispute_id
        JOIN paypal_credit_events capture
          ON capture.remote_resource_id = ANY(event.transaction_capture_ids)
          AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
          AND capture.outcome = 'credited'
        JOIN city_credit_entries purchase
          ON purchase.id = capture.purchase_entry_id
        WHERE dispute.state IN ('open', 'resolution_review')
          AND purchase.gift_id = OLD.id
      )
    ) THEN
    RAISE EXCEPTION 'gift cannot be redirected because a payment dispute is open on the purchase that funded it or its ambiguous outcome awaits founder review'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    AND NOT (OLD.status IN ('pending', 'refused') AND NEW.status = 'pending') THEN
    RAISE EXCEPTION 'only a pending or refused gift may be redirected'
      USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    AND NEW.version <> OLD.version + 1
  ) OR (
    NEW.recipient_id IS NOT DISTINCT FROM OLD.recipient_id
    AND NEW.version <> OLD.version
  ) THEN
    RAISE EXCEPTION 'city credit gift version must advance exactly once per redirect'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'city credit gift update time cannot move backward'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION validate_city_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  related_spend city_credit_entries%ROWTYPE;
  related_purchase city_credit_entries%ROWTYPE;
  gift city_credit_gifts%ROWTYPE;
  dispute paypal_credit_disputes%ROWTYPE;
  dispute_event paypal_credit_dispute_events%ROWTYPE;
  dispute_review paypal_credit_dispute_reviews%ROWTYPE;
  capture_event paypal_credit_events%ROWTYPE;
BEGIN
  IF NEW.entry_kind IN ('spend', 'return') THEN
    SELECT * INTO attempt FROM payment_attempts
    WHERE public_id = NEW.payment_attempt_id FOR KEY SHARE;
    IF NOT FOUND OR attempt.method <> 'credit' OR attempt.actor_id <> NEW.resident_id
      OR attempt.amount_units <> NEW.amount_units
      OR attempt.operation NOT IN (
        'frontier', 'kind_invention', 'kind_revision',
        'place_rename', 'place_retire', 'place_restore'
      )
      OR (NEW.entry_kind = 'spend' AND attempt.status NOT IN ('settling', 'payment_pending'))
      OR (NEW.entry_kind = 'return' AND attempt.status NOT IN (
        'settling', 'payment_pending', 'credit_returned'
      )) THEN
      RAISE EXCEPTION 'city credit entry does not match its live credit attempt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.entry_kind = 'return' THEN
      SELECT * INTO related_spend FROM city_credit_entries
      WHERE id = NEW.related_spend_id FOR KEY SHARE;
      IF NOT FOUND OR related_spend.entry_kind <> 'spend'
        OR related_spend.resident_id <> NEW.resident_id
        OR related_spend.amount_units <> NEW.amount_units
        OR related_spend.payment_attempt_id IS DISTINCT FROM NEW.payment_attempt_id THEN
        RAISE EXCEPTION 'city credit return does not match one exact spend'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.entry_kind = 'paypal_dispute_reviewed' THEN
    SELECT * INTO related_purchase FROM city_credit_entries
    WHERE id = NEW.related_purchase_id FOR KEY SHARE;
    SELECT * INTO dispute FROM paypal_credit_disputes
    WHERE dispute_id = NEW.paypal_dispute_id FOR KEY SHARE;
    SELECT * INTO dispute_review FROM paypal_credit_dispute_reviews
    WHERE id = NEW.paypal_dispute_review_id FOR KEY SHARE;
    SELECT * INTO capture_event FROM paypal_credit_events capture
    WHERE capture.purchase_entry_id = related_purchase.id
      AND EXISTS (
        SELECT 1 FROM paypal_credit_dispute_events binding_event
        WHERE binding_event.dispute_id = dispute_review.dispute_id
          AND capture.remote_resource_id = ANY(binding_event.transaction_capture_ids)
      )
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    FOR KEY SHARE;
    IF related_purchase.id IS NULL OR dispute.dispute_id IS NULL
      OR dispute_review.id IS NULL OR capture_event.event_id IS NULL
      OR related_purchase.entry_kind <> 'purchase'
      OR related_purchase.purchase_kind <> 'paypal'
      OR dispute_review.dispute_id <> dispute.dispute_id
      OR related_purchase.amount_units <> NEW.amount_units
      OR NEW.gift_id IS DISTINCT FROM related_purchase.gift_id THEN
      RAISE EXCEPTION 'founder dispute review receipt does not match its exact credit purchase'
        USING ERRCODE = '23514';
    END IF;
    IF related_purchase.gift_id IS NULL THEN
      IF NEW.resident_id <> related_purchase.resident_id THEN
        RAISE EXCEPTION 'founder dispute review receipt resident does not match its purchase'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT * INTO gift FROM city_credit_gifts
      WHERE id = related_purchase.gift_id FOR KEY SHARE;
      IF gift.id IS NULL OR gift.recipient_id <> NEW.resident_id THEN
        RAISE EXCEPTION 'founder dispute review receipt resident does not match its gift'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.entry_kind = 'purchase' AND NEW.purchase_kind = 'x402' THEN
    SELECT * INTO attempt FROM payment_attempts
    WHERE public_id = NEW.payment_attempt_id FOR KEY SHARE;
    IF NOT FOUND OR attempt.operation <> 'credit_purchase' OR attempt.method <> 'x402'
      OR attempt.actor_id <> NEW.resident_id OR attempt.amount_units <> NEW.amount_units
      OR attempt.status <> 'payment_pending' OR attempt.tx_hash IS NULL
      OR attempt.finalized_block_number IS NULL OR attempt.finalized_block_hash IS NULL
      OR attempt.finalized_block_time IS NULL OR attempt.finalized_at IS NULL THEN
      RAISE EXCEPTION 'credit purchase receipt does not match its finalized payment'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.entry_kind IN ('paypal_dispute_created', 'paypal_dispute_updated',
    'paypal_dispute_resolved') THEN
    SELECT * INTO related_purchase FROM city_credit_entries
    WHERE id = NEW.related_purchase_id FOR KEY SHARE;
    SELECT * INTO dispute FROM paypal_credit_disputes
    WHERE dispute_id = NEW.paypal_dispute_id FOR KEY SHARE;
    SELECT * INTO dispute_event FROM paypal_credit_dispute_events
    WHERE paypal_event_id = NEW.paypal_event_id FOR KEY SHARE;
    SELECT * INTO capture_event FROM paypal_credit_events capture
    WHERE capture.purchase_entry_id = related_purchase.id
      AND EXISTS (
        SELECT 1 FROM paypal_credit_dispute_events binding_event
        WHERE binding_event.dispute_id = dispute_event.dispute_id
          AND capture.remote_resource_id = ANY(binding_event.transaction_capture_ids)
      )
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    FOR KEY SHARE;
    IF related_purchase.id IS NULL OR dispute.dispute_id IS NULL
      OR dispute_event.paypal_event_id IS NULL OR capture_event.event_id IS NULL
      OR related_purchase.entry_kind <> 'purchase'
      OR related_purchase.purchase_kind <> 'paypal'
      OR dispute_event.dispute_id <> dispute.dispute_id
      OR dispute_event.resource_updated_at <> NEW.paypal_resource_updated_at
      OR related_purchase.amount_units <> NEW.amount_units
      OR NEW.gift_id IS DISTINCT FROM related_purchase.gift_id
      OR NEW.entry_kind IS DISTINCT FROM (CASE dispute_event.event_kind
        WHEN 'CUSTOMER.DISPUTE.CREATED' THEN 'paypal_dispute_created'
        WHEN 'CUSTOMER.DISPUTE.UPDATED' THEN 'paypal_dispute_updated'
        ELSE 'paypal_dispute_resolved'
      END) THEN
      RAISE EXCEPTION 'PayPal dispute receipt does not match its exact credit purchase'
        USING ERRCODE = '23514';
    END IF;
    IF related_purchase.gift_id IS NULL THEN
      IF NEW.resident_id <> related_purchase.resident_id THEN
        RAISE EXCEPTION 'PayPal dispute receipt resident does not match its purchase'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT * INTO gift FROM city_credit_gifts
      WHERE id = related_purchase.gift_id FOR KEY SHARE;
      IF gift.id IS NULL OR gift.recipient_id <> NEW.resident_id THEN
        RAISE EXCEPTION 'PayPal dispute receipt resident does not match its gift'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.gift_id IS NOT NULL THEN
    SELECT * INTO gift FROM city_credit_gifts WHERE id = NEW.gift_id FOR KEY SHARE;
    IF NOT FOUND OR gift.amount_units <> NEW.amount_units THEN
      RAISE EXCEPTION 'gift receipt does not match its exact purchase'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.entry_kind = 'purchase' AND (
      gift.status NOT IN ('pending', 'frozen', 'revoked', 'accepted', 'refused')
      OR gift.recipient_id <> NEW.resident_id
      OR gift.source_key IS DISTINCT FROM NEW.source_key
    ) THEN
      RAISE EXCEPTION 'gift purchase receipt does not match its gift'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_pending' AND (
      gift.recipient_id <> NEW.resident_id OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':pending:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift arrival receipt does not match its pending version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_accept' AND (
      gift.status <> 'accepted' OR gift.recipient_id <> NEW.resident_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':accept:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift acceptance receipt does not match its accepted version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_refuse' AND (
      gift.status <> 'refused' OR gift.recipient_id <> NEW.resident_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':refuse:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift refusal receipt does not match its refused version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_redirect' AND (
      gift.status <> 'pending' OR gift.version <= 1
      OR gift.recipient_id IS DISTINCT FROM NEW.counterparty_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':redirect:' || gift.version::text
      )
      OR NOT EXISTS (
        SELECT 1 FROM city_credit_entries prior
        WHERE prior.gift_id = gift.id AND prior.entry_kind = 'gift_pending'
          AND prior.resident_id = NEW.resident_id
          AND prior.amount_units = NEW.amount_units
          AND prior.source_key = (
            'gift:' || gift.public_id || ':pending:' || (gift.version - 1)::text
          )
      )
    ) THEN
      RAISE EXCEPTION 'gift redirect receipt does not match its departure and target'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION apply_city_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta_units BIGINT;
BEGIN
  delta_units := CASE
    WHEN NEW.entry_kind IN ('founder_issue', 'return', 'admin_credit', 'gift_accept')
      THEN NEW.amount_units
    WHEN NEW.entry_kind = 'purchase' AND NEW.gift_id IS NULL THEN NEW.amount_units
    WHEN NEW.entry_kind IN ('spend', 'admin_debit') THEN -NEW.amount_units
    WHEN NEW.entry_kind IN (
      'gift_pending', 'gift_refuse', 'gift_redirect',
      'paypal_dispute_created', 'paypal_dispute_updated', 'paypal_dispute_resolved',
      'paypal_dispute_reviewed'
    ) OR (NEW.entry_kind = 'purchase' AND NEW.gift_id IS NOT NULL) THEN 0
    ELSE NULL
  END CASE;
  IF delta_units IS NULL THEN
    RAISE EXCEPTION 'unknown city credit balance effect' USING ERRCODE = '23514';
  END IF;
  INSERT INTO city_credit_accounts (resident_id, balance_units)
  VALUES (NEW.resident_id, 0) ON CONFLICT (resident_id) DO NOTHING;
  UPDATE city_credit_accounts
  SET balance_units = balance_units + delta_units, updated_at = clock_timestamp()
  WHERE resident_id = NEW.resident_id AND balance_units + delta_units >= 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient city fee credit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION require_city_credit_gift_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_gift city_credit_gifts%ROWTYPE;
BEGIN
  SELECT * INTO current_gift FROM city_credit_gifts WHERE id = NEW.id;
  IF NOT FOUND OR current_gift.source_entry_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.id = current_gift.source_entry_id AND entry.entry_kind = 'purchase'
      AND entry.gift_id = current_gift.id AND entry.amount_units = current_gift.amount_units
      AND entry.source_key = current_gift.source_key
  ) THEN
    RAISE EXCEPTION 'city credit gift requires its exact purchase receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('pending', 'frozen') AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id AND entry.entry_kind = 'gift_pending'
      AND entry.resident_id = NEW.recipient_id AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':pending:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'pending city credit gift requires its exact arrival receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id AND entry.entry_kind = 'gift_accept'
      AND entry.resident_id = NEW.recipient_id AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':accept:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'accepted city credit gift requires its exact acceptance receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'refused' AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id AND entry.entry_kind = 'gift_refuse'
      AND entry.resident_id = NEW.recipient_id AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':refuse:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'refused city credit gift requires its exact refusal receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'frozen' AND NOT EXISTS (
    SELECT 1 FROM paypal_credit_disputes dispute
    JOIN paypal_credit_dispute_events event
      ON event.dispute_id = dispute.dispute_id
    JOIN city_credit_entries receipt
      ON receipt.paypal_dispute_id = dispute.dispute_id
      AND receipt.paypal_event_id = event.paypal_event_id
    JOIN city_credit_entries purchase ON purchase.id = receipt.related_purchase_id
    WHERE purchase.gift_id = NEW.id
      AND dispute.state IN ('open', 'resolution_review')
      AND receipt.gift_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'frozen city credit gift requires its open dispute receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'revoked' AND NOT EXISTS (
    SELECT 1 FROM paypal_credit_disputes dispute
    JOIN city_credit_entries receipt
      ON receipt.paypal_dispute_id = dispute.dispute_id
    JOIN city_credit_entries purchase ON purchase.id = receipt.related_purchase_id
    WHERE purchase.gift_id = NEW.id
      AND dispute.state = 'resolved_against_seller'
      AND receipt.gift_id = NEW.id
      AND receipt.application_outcome IN (
        'dispute_resolved_gift_revoked', 'founder_review_gift_revoked'
      )
  ) THEN
    RAISE EXCEPTION 'revoked city credit gift requires its adverse dispute receipt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'frozen' AND NEW.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM paypal_credit_disputes dispute
      JOIN city_credit_entries receipt
        ON receipt.paypal_dispute_id = dispute.dispute_id
      JOIN city_credit_entries purchase ON purchase.id = receipt.related_purchase_id
      WHERE purchase.gift_id = NEW.id AND dispute.state = 'resolved_seller'
        AND receipt.gift_id = NEW.id
        AND receipt.application_outcome IN (
          'dispute_resolved_gift_pending', 'founder_review_gift_pending'
        )
    ) THEN
    RAISE EXCEPTION 'unfrozen city credit gift requires its seller-favor receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'refused' AND NEW.frozen_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM paypal_credit_disputes dispute
    JOIN city_credit_entries receipt
      ON receipt.paypal_dispute_id = dispute.dispute_id
    JOIN city_credit_entries purchase ON purchase.id = receipt.related_purchase_id
    WHERE purchase.gift_id = NEW.id
      AND dispute.state IN ('open', 'resolution_review')
      AND receipt.gift_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'blocked refused city credit gift requires its open dispute receipt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'refused'
    AND OLD.frozen_at IS NOT NULL AND NEW.status = 'refused'
    AND NEW.frozen_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM paypal_credit_disputes dispute
      JOIN city_credit_entries receipt
        ON receipt.paypal_dispute_id = dispute.dispute_id
      JOIN city_credit_entries purchase ON purchase.id = receipt.related_purchase_id
      WHERE purchase.gift_id = NEW.id
        AND dispute.state = 'resolved_seller'
        AND receipt.gift_id = NEW.id
        AND receipt.application_outcome IN (
          'dispute_resolved_refused_gift',
          'founder_review_refused_gift_redirectable'
        )
    ) THEN
    RAISE EXCEPTION 'unblocked refused city credit gift requires its seller-favor receipt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'refused'
    AND OLD.frozen_at IS NOT NULL AND NEW.status = 'refused'
    AND NEW.frozen_at IS NULL AND EXISTS (
      SELECT 1 FROM paypal_credit_disputes dispute
      JOIN paypal_credit_dispute_events event
        ON event.dispute_id = dispute.dispute_id
      JOIN paypal_credit_events capture
        ON capture.remote_resource_id = ANY(event.transaction_capture_ids)
        AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
        AND capture.outcome = 'credited'
      JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
      WHERE purchase.gift_id = NEW.id
        AND dispute.state IN ('open', 'resolution_review')
    ) THEN
    RAISE EXCEPTION 'refused city credit gift remains blocked by an open payment dispute'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    AND NOT EXISTS (
      SELECT 1 FROM city_credit_entries entry
      WHERE entry.gift_id = NEW.id AND entry.entry_kind = 'gift_redirect'
        AND entry.resident_id = OLD.recipient_id
        AND entry.counterparty_id = NEW.recipient_id
        AND entry.amount_units = NEW.amount_units
        AND entry.source_key = 'gift:' || NEW.public_id || ':redirect:' || NEW.version::text
    ) THEN
    RAISE EXCEPTION 'redirected city credit gift requires its exact departure receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION paypal_credit_dispute_event_lifecycle_rank(
  requested_event_kind TEXT
) RETURNS SMALLINT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE requested_event_kind
    WHEN 'CUSTOMER.DISPUTE.CREATED' THEN 1::SMALLINT
    WHEN 'CUSTOMER.DISPUTE.UPDATED' THEN 2::SMALLINT
    WHEN 'CUSTOMER.DISPUTE.RESOLVED' THEN 3::SMALLINT
    ELSE 0::SMALLINT
  END;
$$;

CREATE OR REPLACE FUNCTION require_paypal_credit_dispute_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_event paypal_credit_dispute_events%ROWTYPE;
BEGIN
  SELECT * INTO latest_event
  FROM paypal_credit_dispute_events event
  WHERE event.dispute_id = NEW.dispute_id
  ORDER BY event.resource_updated_at DESC,
    paypal_credit_dispute_event_lifecycle_rank(event.event_kind) DESC,
    event.event_sequence DESC
  LIMIT 1;
  IF latest_event.paypal_event_id IS NULL
    OR NEW.resource_updated_at <> latest_event.resource_updated_at
    OR NEW.current_event_sequence <> latest_event.event_sequence THEN
    RAISE EXCEPTION 'PayPal dispute projection is not at its latest durable lifecycle event'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.review_decision IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM paypal_credit_dispute_reviews review
      JOIN events public_event ON public_event.id = review.public_event_id
      JOIN residents founder ON founder.id = review.founder_id
      WHERE review.dispute_id = NEW.dispute_id
        AND review.founder_id = 1
        AND review.decision = NEW.review_decision
        AND public_event.kind = 'payment_repair'
        AND public_event.actor = founder.handle
        AND public_event.detail = jsonb_build_object(
          'action', 'credit_dispute_' || review.decision
        )
        AND (
          (NEW.state = 'resolved_seller'
            AND review.decision = 'seller_favour')
          OR (NEW.state = 'resolved_against_seller'
            AND review.decision = 'buyer_favour')
        )
    ) THEN
      RAISE EXCEPTION 'founder PayPal dispute projection lacks its append-only public review event'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state = 'resolved_against_seller' THEN
    IF latest_event.event_kind = 'CUSTOMER.DISPUTE.RESOLVED'
      AND latest_event.outcome_code IN ('RESOLVED_BUYER_FAVOUR', 'ACCEPTED') THEN
      IF NEW.paypal_status <> latest_event.paypal_status
        OR NEW.outcome_code IS DISTINCT FROM latest_event.outcome_code THEN
        RAISE EXCEPTION 'adverse PayPal dispute projection does not match its current adverse lifecycle evidence'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'adverse PayPal dispute projection lacks current adverse lifecycle evidence'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.state <> 'resolved_against_seller'
        OR NEW.paypal_status <> OLD.paypal_status
        OR NEW.outcome_code IS DISTINCT FROM OLD.outcome_code
        OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
        RAISE EXCEPTION 'adverse PayPal dispute projection lacks current adverse lifecycle evidence or immutable prior adverse custody'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF NEW.state <> 'resolved_against_seller' AND (
    latest_event.paypal_status <> NEW.paypal_status
    OR latest_event.outcome_code IS DISTINCT FROM NEW.outcome_code
    OR NOT (
      (NEW.state = 'open'
        AND latest_event.event_kind <> 'CUSTOMER.DISPUTE.RESOLVED')
      OR (NEW.state = 'resolved_seller'
        AND latest_event.event_kind = 'CUSTOMER.DISPUTE.RESOLVED'
        AND latest_event.outcome_code IN ('RESOLVED_SELLER_FAVOUR',
          'CANCELED_BY_BUYER', 'DENIED'))
      OR (NEW.state = 'resolution_review'
        AND latest_event.event_kind = 'CUSTOMER.DISPUTE.RESOLVED'
        AND latest_event.outcome_code IN ('RESOLVED_WITH_PAYOUT', 'NONE'))
    )
  ) THEN
    RAISE EXCEPTION 'PayPal dispute projection lacks its matching append-only event'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM founder_city_credit_notes note
    WHERE note.dispute_id = NEW.dispute_id
      AND note.founder_id = 1
      AND note.body = 'Verified PayPal dispute ' || NEW.dispute_id
        || ' was recorded. Inspect the private founder credit-dispute view for matched and unmatched purchases.'
  ) THEN
    RAISE EXCEPTION 'PayPal dispute projection lacks its one generic founder note'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_disputes_require_event
  ON paypal_credit_disputes;
CREATE CONSTRAINT TRIGGER paypal_credit_disputes_require_event
  AFTER INSERT OR UPDATE ON paypal_credit_disputes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_credit_dispute_projection();

CREATE OR REPLACE FUNCTION require_paypal_credit_dispute_event_receipts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH durable_capture AS (
      SELECT DISTINCT transaction.capture_id
      FROM paypal_credit_dispute_events source_event
      CROSS JOIN LATERAL unnest(source_event.transaction_capture_ids)
        AS transaction(capture_id)
      WHERE source_event.dispute_id = NEW.dispute_id
    )
    SELECT 1
    FROM paypal_credit_dispute_events event
    CROSS JOIN durable_capture transaction
    JOIN paypal_credit_events capture
      ON capture.remote_resource_id = transaction.capture_id
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
      AND purchase.entry_kind = 'purchase' AND purchase.purchase_kind = 'paypal'
    LEFT JOIN city_credit_entries receipt
      ON receipt.paypal_event_id = event.paypal_event_id
      AND receipt.related_purchase_id = purchase.id
    WHERE event.dispute_id = NEW.dispute_id AND receipt.id IS NULL
  ) THEN
    RAISE EXCEPTION 'PayPal dispute event matrix lacks a local purchase receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_dispute_events_require_receipts
  ON paypal_credit_dispute_events;
CREATE CONSTRAINT TRIGGER paypal_credit_dispute_events_require_receipts
  AFTER INSERT ON paypal_credit_dispute_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_credit_dispute_event_receipts();

CREATE OR REPLACE FUNCTION require_paypal_credit_dispute_review_receipts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM paypal_credit_disputes dispute
    WHERE dispute.dispute_id = NEW.dispute_id
      AND dispute.review_decision = NEW.decision
      AND (
        (NEW.decision = 'seller_favour' AND dispute.state = 'resolved_seller')
        OR (NEW.decision = 'buyer_favour'
          AND dispute.state = 'resolved_against_seller')
      )
  ) THEN
    RAISE EXCEPTION 'founder dispute review lacks its terminal projection'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH durable_capture AS (
      SELECT DISTINCT transaction.capture_id
      FROM paypal_credit_dispute_events source_event
      CROSS JOIN LATERAL unnest(source_event.transaction_capture_ids)
        AS transaction(capture_id)
      WHERE source_event.dispute_id = NEW.dispute_id
    )
    SELECT 1
    FROM durable_capture transaction
    JOIN paypal_credit_events capture
      ON capture.remote_resource_id = transaction.capture_id
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
      AND purchase.entry_kind = 'purchase' AND purchase.purchase_kind = 'paypal'
    LEFT JOIN city_credit_entries receipt
      ON receipt.paypal_dispute_review_id = NEW.id
      AND receipt.related_purchase_id = purchase.id
    WHERE receipt.id IS NULL
  ) THEN
    RAISE EXCEPTION 'founder dispute review lacks a local purchase receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_dispute_reviews_require_receipts
  ON paypal_credit_dispute_reviews;
CREATE CONSTRAINT TRIGGER paypal_credit_dispute_reviews_require_receipts
  AFTER INSERT ON paypal_credit_dispute_reviews
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_credit_dispute_review_receipts();

CREATE OR REPLACE FUNCTION require_paypal_capture_dispute_receipts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome = 'credited'
    AND NEW.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
    AND (EXISTS (
      SELECT 1 FROM paypal_credit_dispute_events dispute_event
      LEFT JOIN city_credit_entries receipt
        ON receipt.paypal_event_id = dispute_event.paypal_event_id
        AND receipt.related_purchase_id = NEW.purchase_entry_id
      WHERE dispute_event.dispute_id IN (
        SELECT source_event.dispute_id
        FROM paypal_credit_dispute_events source_event
        WHERE NEW.remote_resource_id = ANY(source_event.transaction_capture_ids)
      )
        AND receipt.id IS NULL
    ) OR EXISTS (
      SELECT 1 FROM paypal_credit_dispute_reviews review
      LEFT JOIN city_credit_entries receipt
        ON receipt.paypal_dispute_review_id = review.id
        AND receipt.related_purchase_id = NEW.purchase_entry_id
      WHERE review.dispute_id IN (
        SELECT source_event.dispute_id
        FROM paypal_credit_dispute_events source_event
        WHERE NEW.remote_resource_id = ANY(source_event.transaction_capture_ids)
      )
        AND receipt.id IS NULL
    )) THEN
    RAISE EXCEPTION 'credited PayPal capture lacks its staged dispute receipts'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_events_require_dispute_receipts
  ON paypal_credit_events;
CREATE CONSTRAINT TRIGGER paypal_credit_events_require_dispute_receipts
  AFTER INSERT ON paypal_credit_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_capture_dispute_receipts();

CREATE OR REPLACE FUNCTION reconcile_paypal_credit_dispute(
  requested_dispute_id TEXT
) RETURNS INTEGER LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  projection paypal_credit_disputes%ROWTYPE;
  current_event paypal_credit_dispute_events%ROWTYPE;
  binding RECORD;
  stored_gift city_credit_gifts%ROWTYPE;
  receipt_kind TEXT;
  receipt_outcome TEXT;
  receipt_reason TEXT;
  has_other_open BOOLEAN;
  inserted_count INTEGER := 0;
BEGIN
  SELECT * INTO projection FROM paypal_credit_disputes dispute
  WHERE dispute.dispute_id = requested_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PayPal dispute projection was not found'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO current_event FROM paypal_credit_dispute_events event
  WHERE event.event_sequence = projection.current_event_sequence;
  IF NOT FOUND OR current_event.dispute_id <> requested_dispute_id THEN
    RAISE EXCEPTION 'PayPal dispute projection has no current lifecycle event'
      USING ERRCODE = '55000';
  END IF;

  FOR binding IN
    WITH durable_capture AS (
      SELECT DISTINCT transaction.capture_id
      FROM paypal_credit_dispute_events source_event
      CROSS JOIN LATERAL unnest(source_event.transaction_capture_ids)
        AS transaction(capture_id)
      WHERE source_event.dispute_id = requested_dispute_id
    ), source_binding AS (
      SELECT event.paypal_event_id, NULL::BIGINT AS review_id,
        event.event_kind, event.resource_updated_at, event.event_sequence,
        false AS is_review
      FROM paypal_credit_dispute_events event
      WHERE event.dispute_id = requested_dispute_id
      UNION ALL
      SELECT NULL::TEXT, review.id, 'FOUNDER.DISPUTE.REVIEWED',
        NULL::TIMESTAMPTZ, NULL::BIGINT, true
      FROM paypal_credit_dispute_reviews review
      WHERE review.dispute_id = requested_dispute_id
    )
    SELECT source_binding.*, purchase.id AS purchase_id,
      purchase.resident_id, purchase.amount_units, purchase.gift_id
    FROM source_binding
    CROSS JOIN durable_capture transaction
    JOIN paypal_credit_events capture
      ON capture.remote_resource_id = transaction.capture_id
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    JOIN city_credit_entries purchase
      ON purchase.id = capture.purchase_entry_id
      AND purchase.entry_kind = 'purchase'
      AND purchase.purchase_kind = 'paypal'
    WHERE NOT EXISTS (
        SELECT 1 FROM city_credit_entries receipt
        WHERE receipt.related_purchase_id = purchase.id
          AND (
            (source_binding.paypal_event_id IS NOT NULL
              AND receipt.paypal_event_id = source_binding.paypal_event_id)
            OR (source_binding.review_id IS NOT NULL
              AND receipt.paypal_dispute_review_id = source_binding.review_id)
          )
      )
    ORDER BY source_binding.is_review,
      source_binding.resource_updated_at NULLS LAST,
      paypal_credit_dispute_event_lifecycle_rank(source_binding.event_kind),
      source_binding.event_sequence, purchase.id
  LOOP
    stored_gift := NULL;
    has_other_open := false;
    IF binding.gift_id IS NOT NULL THEN
      SELECT * INTO stored_gift FROM city_credit_gifts gift
      WHERE gift.id = binding.gift_id FOR UPDATE;
    END IF;

    IF NOT binding.is_review AND ROW(
      binding.resource_updated_at,
      paypal_credit_dispute_event_lifecycle_rank(binding.event_kind),
      binding.event_sequence
    ) < ROW(
      current_event.resource_updated_at,
      paypal_credit_dispute_event_lifecycle_rank(current_event.event_kind),
      current_event.event_sequence
    ) THEN
      receipt_outcome := 'dispute_stale_event_ignored';
    ELSIF projection.state = 'open' THEN
      IF stored_gift.id IS NOT NULL AND stored_gift.status = 'pending' THEN
        UPDATE city_credit_gifts gift
        SET status = 'frozen', frozen_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
        receipt_outcome := 'dispute_open_gift_frozen';
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'frozen' THEN
        receipt_outcome := 'dispute_open_gift_frozen';
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'refused' THEN
        UPDATE city_credit_gifts gift
        SET frozen_at = coalesce(gift.frozen_at, clock_timestamp()),
          updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
        receipt_outcome := 'dispute_open_refused_gift_blocked';
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'revoked' THEN
        receipt_outcome := 'dispute_resolved_gift_revoked';
      ELSE
        receipt_outcome := 'dispute_open_credit_retained';
      END IF;
    ELSIF projection.state = 'resolution_review' THEN
      IF stored_gift.id IS NOT NULL AND stored_gift.status = 'pending' THEN
        UPDATE city_credit_gifts gift
        SET status = 'frozen', frozen_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'refused' THEN
        UPDATE city_credit_gifts gift
        SET frozen_at = coalesce(gift.frozen_at, clock_timestamp()),
          updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
      END IF;
      receipt_outcome := 'dispute_resolution_needs_operator_review';
    ELSIF projection.state = 'resolved_seller' THEN
      IF stored_gift.id IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM paypal_credit_disputes other
          JOIN paypal_credit_dispute_events other_event
            ON other_event.dispute_id = other.dispute_id
          JOIN paypal_credit_events capture
            ON capture.remote_resource_id = ANY(other_event.transaction_capture_ids)
            AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
            AND capture.outcome = 'credited'
          JOIN city_credit_entries purchase
            ON purchase.id = capture.purchase_entry_id
          WHERE other.dispute_id <> requested_dispute_id
            AND other.state IN ('open', 'resolution_review')
            AND purchase.gift_id = stored_gift.id
        ) INTO has_other_open;
      END IF;
      IF stored_gift.id IS NOT NULL AND stored_gift.status = 'frozen' THEN
        IF has_other_open THEN
          receipt_outcome := 'dispute_resolved_gift_still_frozen';
        ELSE
          UPDATE city_credit_gifts gift
          SET status = 'pending', frozen_at = NULL, updated_at = clock_timestamp()
          WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
          receipt_outcome := 'dispute_resolved_gift_pending';
        END IF;
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'refused' THEN
        IF has_other_open THEN
          receipt_outcome := 'dispute_resolved_gift_still_frozen';
        ELSE
          UPDATE city_credit_gifts gift
          SET frozen_at = NULL, updated_at = clock_timestamp()
          WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
          receipt_outcome := 'dispute_resolved_refused_gift';
        END IF;
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'pending' THEN
        receipt_outcome := 'dispute_resolved_gift_pending';
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'revoked' THEN
        receipt_outcome := 'dispute_resolved_gift_revoked';
      ELSE
        receipt_outcome := 'dispute_resolved_credit_retained';
      END IF;
    ELSE
      IF stored_gift.id IS NOT NULL
        AND stored_gift.status IN ('pending', 'refused', 'frozen') THEN
        UPDATE city_credit_gifts gift
        SET status = 'revoked', accepted_at = NULL, refused_at = NULL,
          frozen_at = coalesce(gift.frozen_at, clock_timestamp()),
          revoked_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
        receipt_outcome := 'dispute_resolved_gift_revoked';
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'revoked' THEN
        receipt_outcome := 'dispute_resolved_gift_revoked';
      ELSE
        receipt_outcome := 'dispute_resolved_credit_retained';
      END IF;
    END IF;

    IF binding.is_review THEN
      receipt_kind := 'paypal_dispute_reviewed';
      receipt_outcome := CASE receipt_outcome
        WHEN 'dispute_resolved_gift_pending' THEN 'founder_review_gift_pending'
        WHEN 'dispute_resolved_refused_gift' THEN
          'founder_review_refused_gift_redirectable'
        WHEN 'dispute_resolved_gift_still_frozen' THEN
          'founder_review_gift_still_frozen'
        WHEN 'dispute_resolved_gift_revoked' THEN CASE
          WHEN projection.review_decision = 'seller_favour'
            THEN 'founder_review_gift_still_revoked'
          ELSE 'founder_review_gift_revoked'
        END
        ELSE 'founder_review_credit_retained'
      END;
      receipt_reason := CASE receipt_outcome
        WHEN 'founder_review_gift_pending' THEN
          'Founder resident #1 chose seller favour for the ambiguous PayPal outcome. This gift is pending again.'
        WHEN 'founder_review_refused_gift_redirectable' THEN
          'Founder resident #1 chose seller favour for the ambiguous PayPal outcome. This refused gift is redirectable again.'
        WHEN 'founder_review_gift_still_frozen' THEN
          'Founder resident #1 chose seller favour for this ambiguous PayPal outcome, but another payment dispute still blocks the gift.'
        WHEN 'founder_review_gift_still_revoked' THEN
          'Founder resident #1 chose seller favour for the ambiguous PayPal outcome. Another dispute already permanently revoked this gift.'
        WHEN 'founder_review_gift_revoked' THEN
          'Founder resident #1 chose buyer favour for the ambiguous PayPal outcome. This unaccepted gift is permanently revoked.'
        ELSE
          'Founder resident #1 chose an outcome after credit delivery. Delivered credit was not removed.'
      END;
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, reason, gift_id,
        related_purchase_id, paypal_dispute_id, paypal_dispute_review_id,
        application_outcome
      ) VALUES (
        coalesce(stored_gift.recipient_id, binding.resident_id),
        receipt_kind, binding.amount_units, receipt_reason, binding.gift_id,
        binding.purchase_id, requested_dispute_id, binding.review_id,
        receipt_outcome
      ) ON CONFLICT (paypal_dispute_review_id, related_purchase_id)
        WHERE paypal_dispute_review_id IS NOT NULL DO NOTHING;
    ELSE
      receipt_kind := CASE binding.event_kind
        WHEN 'CUSTOMER.DISPUTE.CREATED' THEN 'paypal_dispute_created'
        WHEN 'CUSTOMER.DISPUTE.UPDATED' THEN 'paypal_dispute_updated'
        ELSE 'paypal_dispute_resolved'
      END;
      receipt_reason := CASE receipt_outcome
        WHEN 'dispute_open_gift_frozen' THEN
          'A PayPal payment dispute is open on the purchase that funded this gift. The gift is frozen.'
        WHEN 'dispute_open_refused_gift_blocked' THEN
          'A PayPal payment dispute is open on the purchase that funded this refused gift. Redirect is blocked.'
        WHEN 'dispute_open_credit_retained' THEN
          'A PayPal payment dispute is open. Delivered credit was not removed.'
        WHEN 'dispute_resolved_gift_pending' THEN
          'The PayPal dispute was resolved for the city seller. This gift is pending again.'
        WHEN 'dispute_resolved_refused_gift' THEN
          'The PayPal dispute was resolved for the city seller. This gift remains refused and redirectable.'
        WHEN 'dispute_resolved_gift_still_frozen' THEN
          'This PayPal dispute was resolved for the city seller, but another dispute still blocks the gift.'
        WHEN 'dispute_resolved_gift_revoked' THEN
          'A PayPal dispute was resolved against the city seller. This unaccepted gift is permanently revoked.'
        WHEN 'dispute_resolved_credit_retained' THEN
          'A PayPal dispute was resolved after credit delivery. Delivered credit was not removed.'
        WHEN 'dispute_resolution_needs_operator_review' THEN
          'PayPal resolved this dispute ambiguously. Founder resident #1 must choose seller_favour or buyer_favour; unaccepted custody remains blocked.'
        ELSE
          'This older PayPal dispute event was recorded but did not change current credit custody.'
      END;
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, reason, gift_id,
        related_purchase_id, paypal_dispute_id, paypal_event_id,
        paypal_resource_updated_at, application_outcome
      ) VALUES (
        coalesce(stored_gift.recipient_id, binding.resident_id),
        receipt_kind, binding.amount_units, receipt_reason, binding.gift_id,
        binding.purchase_id, requested_dispute_id, binding.paypal_event_id,
        binding.resource_updated_at, receipt_outcome
      ) ON CONFLICT (paypal_event_id, related_purchase_id)
        WHERE paypal_event_id IS NOT NULL DO NOTHING;
    END IF;
    IF FOUND THEN inserted_count := inserted_count + 1; END IF;
  END LOOP;
  RETURN inserted_count;
END
$$;

CREATE OR REPLACE FUNCTION apply_paypal_credit_dispute(
  requested_event_id TEXT,
  requested_event_kind TEXT,
  requested_dispute_id TEXT,
  requested_capture_ids TEXT[],
  requested_paypal_status TEXT,
  requested_outcome_code TEXT,
  requested_resource_updated_at TIMESTAMPTZ
) RETURNS TABLE (
  event_id TEXT,
  dispute_id TEXT,
  state TEXT,
  paypal_status TEXT,
  outcome_code TEXT,
  resource_updated_at TIMESTAMPTZ,
  application_outcome TEXT,
  created BOOLEAN,
  transaction_count INTEGER,
  local_purchase_count INTEGER,
  receipts_created INTEGER
) LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  projection paypal_credit_disputes%ROWTYPE;
  stored_event paypal_credit_dispute_events%ROWTYPE;
  current_event paypal_credit_dispute_events%ROWTYPE;
  requested_capture_id TEXT;
  requested_event_sequence BIGINT;
  desired_state TEXT;
  receipt_outcome_min TEXT;
  receipt_outcome_max TEXT;
  all_frozen BOOLEAN;
  all_stale BOOLEAN;
  all_review BOOLEAN;
  receipts_before INTEGER;
  durable_capture_count INTEGER;
  was_created BOOLEAN := false;
BEGIN
  IF requested_event_id IS NULL
    OR octet_length(requested_event_id) NOT BETWEEN 1 AND 128
    OR requested_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    OR requested_event_kind NOT IN ('CUSTOMER.DISPUTE.CREATED',
      'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED')
    OR requested_dispute_id IS NULL
    OR octet_length(requested_dispute_id) NOT BETWEEN 1 AND 255
    OR requested_dispute_id !~ '^[A-Za-z0-9][A-Za-z0-9-]*$'
    OR requested_capture_ids IS NULL
    OR NOT paypal_credit_capture_ids_are_canonical(requested_capture_ids)
    OR requested_paypal_status NOT IN ('OPEN', 'WAITING_FOR_BUYER_RESPONSE',
      'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW', 'RESOLVED', 'OTHER')
    OR requested_resource_updated_at IS NULL
    OR (requested_event_kind = 'CUSTOMER.DISPUTE.RESOLVED' AND (
      requested_paypal_status <> 'RESOLVED'
      OR requested_outcome_code NOT IN ('RESOLVED_BUYER_FAVOUR',
        'RESOLVED_SELLER_FAVOUR', 'RESOLVED_WITH_PAYOUT',
        'CANCELED_BY_BUYER', 'ACCEPTED', 'DENIED', 'NONE')
    ))
    OR (requested_event_kind <> 'CUSTOMER.DISPUTE.RESOLVED' AND (
      requested_paypal_status = 'RESOLVED' OR requested_outcome_code IS NOT NULL
    )) THEN
    RAISE EXCEPTION 'PayPal dispute event input is invalid'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    '1f3d9/paypal-credit/dispute-reconciliation', 0
  ));
  SELECT count(DISTINCT transaction.capture_id)::INTEGER
  INTO durable_capture_count
  FROM (
    SELECT unnest(requested_capture_ids) AS capture_id
    UNION ALL
    SELECT unnest(event.transaction_capture_ids) AS capture_id
    FROM paypal_credit_dispute_events event
    WHERE event.dispute_id = requested_dispute_id
  ) transaction;
  IF durable_capture_count > 1000 THEN
    RAISE EXCEPTION 'PayPal dispute capture binding exceeds its durable limit'
      USING ERRCODE = '23514';
  END IF;

  FOR requested_capture_id IN
    SELECT DISTINCT transaction.capture_id COLLATE "C"
    FROM (
      SELECT unnest(requested_capture_ids) AS capture_id
      UNION ALL
      SELECT unnest(event.transaction_capture_ids) AS capture_id
      FROM paypal_credit_dispute_events event
      WHERE event.dispute_id = requested_dispute_id
    ) transaction
    ORDER BY transaction.capture_id COLLATE "C"
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      '1f3d9/paypal-credit/capture/' || requested_capture_id, 0
    ));
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    '1f3d9/paypal-credit/dispute-event/' || requested_event_id, 0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    '1f3d9/paypal-credit/dispute/' || requested_dispute_id, 0
  ));

  desired_state := CASE
    WHEN requested_event_kind <> 'CUSTOMER.DISPUTE.RESOLVED' THEN 'open'
    WHEN requested_outcome_code IN ('RESOLVED_SELLER_FAVOUR',
      'CANCELED_BY_BUYER', 'DENIED') THEN 'resolved_seller'
    WHEN requested_outcome_code IN ('RESOLVED_BUYER_FAVOUR', 'ACCEPTED')
      THEN 'resolved_against_seller'
    ELSE 'resolution_review'
  END;

  SELECT * INTO stored_event FROM paypal_credit_dispute_events event
  WHERE event.paypal_event_id = requested_event_id
  LIMIT 1;
  IF stored_event.paypal_event_id IS NOT NULL AND (
    stored_event.dispute_id <> requested_dispute_id
    OR stored_event.event_kind <> requested_event_kind
    OR stored_event.paypal_status <> requested_paypal_status
    OR stored_event.outcome_code IS DISTINCT FROM requested_outcome_code
    OR stored_event.resource_updated_at <> requested_resource_updated_at
    OR stored_event.transaction_capture_ids <> requested_capture_ids
  ) THEN
    RAISE EXCEPTION 'PayPal dispute event identity is bound to changed terms'
      USING ERRCODE = '23514';
  END IF;
  IF stored_event.paypal_event_id IS NULL THEN
    requested_event_sequence := nextval(
      'paypal_credit_dispute_event_sequence_seq'
    );
  END IF;

  SELECT * INTO projection FROM paypal_credit_disputes dispute
  WHERE dispute.dispute_id = requested_dispute_id FOR UPDATE;
  IF projection.dispute_id IS NULL THEN
    INSERT INTO paypal_credit_disputes (
      dispute_id, state, paypal_status, outcome_code,
      resource_updated_at, current_event_sequence, resolved_at
    ) VALUES (
      requested_dispute_id, desired_state, requested_paypal_status,
      requested_outcome_code, requested_resource_updated_at,
      requested_event_sequence,
      CASE WHEN desired_state = 'open' THEN NULL ELSE clock_timestamp() END
    ) RETURNING * INTO projection;
  END IF;

  IF stored_event.paypal_event_id IS NULL THEN
    IF projection.review_decision IS NOT NULL THEN
      RAISE EXCEPTION 'founder PayPal dispute review is terminal'
        USING ERRCODE = '55000';
    END IF;
    IF requested_event_kind = 'CUSTOMER.DISPUTE.RESOLVED' AND EXISTS (
      SELECT 1 FROM paypal_credit_dispute_events event
      WHERE event.dispute_id = requested_dispute_id
        AND event.event_kind = 'CUSTOMER.DISPUTE.RESOLVED'
        AND event.resource_updated_at = requested_resource_updated_at
        AND event.outcome_code IS DISTINCT FROM requested_outcome_code
    ) THEN
      RAISE EXCEPTION 'same-time PayPal dispute resolution has conflicting terms'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO paypal_credit_dispute_events (
      paypal_event_id, dispute_id, event_kind, paypal_status,
      outcome_code, resource_updated_at, transaction_capture_ids,
      event_sequence
    ) VALUES (
      requested_event_id, requested_dispute_id, requested_event_kind,
      requested_paypal_status, requested_outcome_code,
      requested_resource_updated_at, requested_capture_ids,
      requested_event_sequence
    ) RETURNING * INTO stored_event;
    was_created := true;

    SELECT * INTO current_event FROM paypal_credit_dispute_events event
    WHERE event.event_sequence = projection.current_event_sequence;
    IF current_event.paypal_event_id IS NULL OR ROW(
      stored_event.resource_updated_at,
      paypal_credit_dispute_event_lifecycle_rank(stored_event.event_kind),
      stored_event.event_sequence
    ) > ROW(
      current_event.resource_updated_at,
      paypal_credit_dispute_event_lifecycle_rank(current_event.event_kind),
      current_event.event_sequence
    ) THEN
      IF projection.state = 'resolved_against_seller' THEN
        UPDATE paypal_credit_disputes dispute
        SET resource_updated_at = stored_event.resource_updated_at,
          current_event_sequence = stored_event.event_sequence,
          updated_at = clock_timestamp()
        WHERE dispute.dispute_id = requested_dispute_id
        RETURNING dispute.* INTO projection;
      ELSE
        UPDATE paypal_credit_disputes dispute
        SET state = desired_state, paypal_status = requested_paypal_status,
          outcome_code = requested_outcome_code,
          resource_updated_at = requested_resource_updated_at,
          current_event_sequence = stored_event.event_sequence,
          resolved_at = CASE WHEN desired_state = 'open' THEN NULL
            ELSE clock_timestamp() END,
          updated_at = clock_timestamp()
        WHERE dispute.dispute_id = requested_dispute_id
        RETURNING dispute.* INTO projection;
      END IF;
    END IF;
  END IF;

  INSERT INTO founder_city_credit_notes (founder_id, dispute_id, body)
  VALUES (
    1, requested_dispute_id,
    'Verified PayPal dispute ' || requested_dispute_id
      || ' was recorded. Inspect the private founder credit-dispute view for matched and unmatched purchases.'
  ) ON CONFLICT (dispute_id) DO NOTHING;

  SELECT count(*)::INTEGER INTO receipts_before
  FROM city_credit_entries receipt
  WHERE receipt.paypal_event_id = stored_event.paypal_event_id
    AND EXISTS (
      SELECT 1
      FROM unnest(stored_event.transaction_capture_ids) transaction(capture_id)
      JOIN paypal_credit_events capture
        ON capture.remote_resource_id = transaction.capture_id
        AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
        AND capture.outcome = 'credited'
      WHERE capture.purchase_entry_id = receipt.related_purchase_id
    );
  PERFORM reconcile_paypal_credit_dispute(requested_dispute_id);
  SELECT count(*)::INTEGER - receipts_before INTO receipts_created
  FROM city_credit_entries receipt
  WHERE receipt.paypal_event_id = stored_event.paypal_event_id
    AND EXISTS (
      SELECT 1
      FROM unnest(stored_event.transaction_capture_ids) transaction(capture_id)
      JOIN paypal_credit_events capture
        ON capture.remote_resource_id = transaction.capture_id
        AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
        AND capture.outcome = 'credited'
      WHERE capture.purchase_entry_id = receipt.related_purchase_id
    );
  transaction_count := cardinality(stored_event.transaction_capture_ids);
  SELECT count(DISTINCT purchase.id)::INTEGER
  INTO local_purchase_count
  FROM unnest(stored_event.transaction_capture_ids) capture_id
  JOIN paypal_credit_events capture
    ON capture.remote_resource_id = capture_id
    AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
    AND capture.outcome = 'credited'
  JOIN city_credit_entries purchase
    ON purchase.id = capture.purchase_entry_id
    AND purchase.entry_kind = 'purchase' AND purchase.purchase_kind = 'paypal';

  IF local_purchase_count = 0 THEN
    application_outcome := 'dispute_awaiting_capture_receipt';
  ELSIF local_purchase_count < transaction_count THEN
    application_outcome := 'dispute_partially_applied_awaiting_capture_receipt';
  ELSE
    SELECT min(receipt.application_outcome), max(receipt.application_outcome),
      bool_and(receipt.application_outcome = 'dispute_open_gift_frozen'),
      bool_and(receipt.application_outcome = 'dispute_stale_event_ignored'),
      bool_and(receipt.application_outcome =
        'dispute_resolution_needs_operator_review')
    INTO receipt_outcome_min, receipt_outcome_max,
      all_frozen, all_stale, all_review
    FROM city_credit_entries receipt
    WHERE receipt.paypal_event_id = stored_event.paypal_event_id
      AND EXISTS (
        SELECT 1
        FROM unnest(stored_event.transaction_capture_ids) transaction(capture_id)
        JOIN paypal_credit_events capture
          ON capture.remote_resource_id = transaction.capture_id
          AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
          AND capture.outcome = 'credited'
        WHERE capture.purchase_entry_id = receipt.related_purchase_id
      );
    application_outcome := CASE
      WHEN all_stale THEN 'dispute_stale_event_ignored'
      WHEN all_review THEN 'dispute_resolution_needs_operator_review'
      WHEN local_purchase_count = 1 THEN receipt_outcome_min
      WHEN all_frozen THEN 'dispute_open_gifts_frozen'
      WHEN receipt_outcome_min = receipt_outcome_max THEN receipt_outcome_min
      WHEN projection.state IN ('open', 'resolution_review')
        THEN 'dispute_open_targets_applied'
      ELSE 'dispute_resolved_targets_applied'
    END;
  END IF;

  RETURN QUERY SELECT stored_event.paypal_event_id, projection.dispute_id,
    projection.state, projection.paypal_status, projection.outcome_code,
    projection.resource_updated_at, application_outcome, was_created,
    transaction_count, local_purchase_count, receipts_created;
END
$$;

CREATE OR REPLACE FUNCTION resolve_paypal_credit_dispute_review(
  requested_founder_id INTEGER,
  requested_dispute_id TEXT,
  requested_decision TEXT
) RETURNS TABLE (
  status TEXT,
  dispute_id TEXT,
  state TEXT,
  decision TEXT,
  application_outcome TEXT,
  created BOOLEAN,
  local_purchase_count INTEGER,
  receipts_created INTEGER
) LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  projection paypal_credit_disputes%ROWTYPE;
  stored_review paypal_credit_dispute_reviews%ROWTYPE;
  public_event_id INTEGER;
  receipts_before INTEGER;
  resolved_state TEXT;
BEGIN
  IF requested_founder_id <> 1
    OR requested_dispute_id IS NULL
    OR octet_length(requested_dispute_id) NOT BETWEEN 1 AND 255
    OR requested_dispute_id !~ '^[A-Za-z0-9][A-Za-z0-9-]*$'
    OR requested_decision NOT IN ('seller_favour', 'buyer_favour') THEN
    RAISE EXCEPTION 'founder PayPal dispute review input is invalid'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    '1f3d9/paypal-credit/dispute-reconciliation', 0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    '1f3d9/paypal-credit/dispute/' || requested_dispute_id, 0
  ));
  SELECT * INTO projection FROM paypal_credit_disputes dispute
  WHERE dispute.dispute_id = requested_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, requested_dispute_id,
      NULL::TEXT, NULL::TEXT, 'dispute_not_found'::TEXT,
      false, 0::INTEGER, 0::INTEGER;
    RETURN;
  END IF;

  SELECT * INTO stored_review FROM paypal_credit_dispute_reviews review
  WHERE review.dispute_id = requested_dispute_id FOR KEY SHARE;
  IF stored_review.id IS NOT NULL THEN
    IF stored_review.decision <> requested_decision THEN
      RETURN QUERY SELECT 'decision_conflict'::TEXT, projection.dispute_id,
        projection.state, stored_review.decision,
        'founder_dispute_resolution_conflict'::TEXT,
        false, 0::INTEGER, 0::INTEGER;
      RETURN;
    END IF;
    IF projection.review_decision <> stored_review.decision OR NOT (
      (stored_review.decision = 'seller_favour'
        AND projection.state = 'resolved_seller')
      OR (stored_review.decision = 'buyer_favour'
        AND projection.state = 'resolved_against_seller')
    ) THEN
      RAISE EXCEPTION 'founder PayPal dispute review projection is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    SELECT count(DISTINCT purchase.id)::INTEGER
    INTO local_purchase_count
    FROM paypal_credit_dispute_events event
    CROSS JOIN LATERAL unnest(event.transaction_capture_ids)
      AS transaction(capture_id)
    JOIN paypal_credit_events capture
      ON capture.remote_resource_id = transaction.capture_id
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
      AND purchase.entry_kind = 'purchase' AND purchase.purchase_kind = 'paypal'
    WHERE event.dispute_id = requested_dispute_id;
    application_outcome := CASE stored_review.decision
      WHEN 'seller_favour' THEN 'founder_review_seller_favour_applied'
      ELSE 'founder_review_buyer_favour_applied'
    END;
    RETURN QUERY SELECT 'resolved'::TEXT, projection.dispute_id,
      projection.state, stored_review.decision, application_outcome,
      false, local_purchase_count, 0::INTEGER;
    RETURN;
  END IF;

  IF projection.state <> 'resolution_review'
    OR projection.review_decision IS NOT NULL THEN
    RETURN QUERY SELECT 'not_reviewable'::TEXT, projection.dispute_id,
      projection.state, projection.review_decision,
      'dispute_not_in_resolution_review'::TEXT,
      false, 0::INTEGER, 0::INTEGER;
    RETURN;
  END IF;

  INSERT INTO events (kind, actor, detail)
  SELECT 'payment_repair', founder.handle, jsonb_build_object(
    'action', 'credit_dispute_' || requested_decision
  )
  FROM residents founder
  WHERE founder.id = requested_founder_id
  RETURNING id INTO public_event_id;
  IF public_event_id IS NULL THEN
    RAISE EXCEPTION 'founder resident #1 was not found'
      USING ERRCODE = '23503';
  END IF;
  INSERT INTO paypal_credit_dispute_reviews (
    dispute_id, founder_id, decision, public_event_id
  ) VALUES (
    requested_dispute_id, requested_founder_id,
    requested_decision, public_event_id
  ) RETURNING * INTO stored_review;

  resolved_state := CASE requested_decision
    WHEN 'seller_favour' THEN 'resolved_seller'
    ELSE 'resolved_against_seller'
  END;
  UPDATE paypal_credit_disputes dispute
  SET state = resolved_state,
    review_decision = requested_decision,
    reviewed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  WHERE dispute.dispute_id = requested_dispute_id
    AND dispute.state = 'resolution_review'
    AND dispute.review_decision IS NULL
  RETURNING dispute.* INTO projection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PayPal dispute is no longer awaiting founder review'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::INTEGER INTO receipts_before
  FROM city_credit_entries receipt
  WHERE receipt.paypal_dispute_review_id = stored_review.id;
  PERFORM reconcile_paypal_credit_dispute(requested_dispute_id);
  SELECT count(*)::INTEGER - receipts_before INTO receipts_created
  FROM city_credit_entries receipt
  WHERE receipt.paypal_dispute_review_id = stored_review.id;
  SELECT count(DISTINCT purchase.id)::INTEGER
  INTO local_purchase_count
  FROM paypal_credit_dispute_events event
  CROSS JOIN LATERAL unnest(event.transaction_capture_ids)
    AS transaction(capture_id)
  JOIN paypal_credit_events capture
    ON capture.remote_resource_id = transaction.capture_id
    AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
    AND capture.outcome = 'credited'
  JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
    AND purchase.entry_kind = 'purchase' AND purchase.purchase_kind = 'paypal'
  WHERE event.dispute_id = requested_dispute_id;
  application_outcome := CASE requested_decision
    WHEN 'seller_favour' THEN 'founder_review_seller_favour_applied'
    ELSE 'founder_review_buyer_favour_applied'
  END;
  RETURN QUERY SELECT 'resolved'::TEXT, projection.dispute_id,
    projection.state, stored_review.decision, application_outcome,
    true, local_purchase_count, receipts_created;
END
$$;

CREATE OR REPLACE FUNCTION deliver_paypal_credit(
  requested_purchase_id TEXT,
  expected_delivery TEXT,
  expected_recipient_id INTEGER,
  expected_amount_units BIGINT,
  expected_claim_token_hash TEXT,
  expected_paypal_environment TEXT,
  expected_remote_parent_id TEXT,
  requested_source_key TEXT,
  requested_purchase_kind TEXT,
  requested_event_id TEXT,
  requested_event_kind TEXT,
  requested_remote_resource_id TEXT,
  requested_gift_public_id TEXT
) RETURNS TABLE (
  id BIGINT,
  resident_id INTEGER,
  amount_units BIGINT,
  source_key TEXT,
  purchase_kind TEXT,
  gift_row_id BIGINT,
  gift_public_id TEXT,
  claim_token_hash TEXT,
  status TEXT,
  created BOOLEAN,
  balance_units BIGINT
) LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  stored_intent paypal_credit_intents%ROWTYPE;
  stored_event paypal_credit_events%ROWTYPE;
  purchase_record RECORD;
  event_binding_count INTEGER;
  required_intent_kind TEXT;
  delivered_status TEXT;
  reconciled_gift_status TEXT;
  staged_dispute_id TEXT;
BEGIN
  required_intent_kind := CASE requested_purchase_kind
    WHEN 'paypal' THEN 'order'
    WHEN 'allowance' THEN 'allowance'
    ELSE NULL
  END;
  delivered_status := CASE requested_purchase_kind
    WHEN 'paypal' THEN 'captured'
    WHEN 'allowance' THEN 'active'
    ELSE NULL
  END;
  IF required_intent_kind IS NULL
    OR expected_delivery IS NULL
    OR expected_delivery NOT IN ('self', 'gift')
    OR expected_recipient_id IS NULL
    OR expected_amount_units IS NULL
    OR expected_paypal_environment IS NULL
    OR expected_paypal_environment NOT IN ('sandbox', 'live')
    OR requested_event_id IS NULL
    OR octet_length(requested_event_id) NOT BETWEEN 1 AND 128
    OR requested_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    OR requested_event_kind IS NULL
    OR requested_remote_resource_id IS NULL
    OR octet_length(requested_remote_resource_id) NOT BETWEEN 1 AND 255
    OR requested_remote_resource_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    OR requested_source_key IS NULL
    OR octet_length(requested_source_key) NOT BETWEEN 8 AND 300
    OR requested_source_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$' THEN
    RAISE EXCEPTION 'PayPal credit delivery input is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF (requested_purchase_kind = 'paypal' AND (
      requested_event_kind <> 'PAYMENT.CAPTURE.COMPLETED'
      OR requested_source_key <> 'paypal:capture:' || requested_remote_resource_id
    )) OR (requested_purchase_kind = 'allowance' AND (
      requested_event_kind <> 'PAYMENT.SALE.COMPLETED'
      OR requested_source_key <> 'paypal:sale:' || requested_remote_resource_id
    )) THEN
    RAISE EXCEPTION 'PayPal event identity does not match the delivery rail'
      USING ERRCODE = '23514';
  END IF;

  IF requested_purchase_kind = 'paypal' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      '1f3d9/paypal-credit/dispute-reconciliation', 0
    ));
    PERFORM pg_advisory_xact_lock(hashtextextended(
      '1f3d9/paypal-credit/capture/' || requested_remote_resource_id, 0
    ));
  END IF;

  SELECT * INTO stored_intent
  FROM paypal_credit_intents intent
  WHERE intent.public_id = requested_purchase_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PayPal credit intent was not found' USING ERRCODE = '55000';
  END IF;

  IF stored_intent.intent_kind <> required_intent_kind
    OR stored_intent.delivery <> expected_delivery
    OR stored_intent.recipient_id <> expected_recipient_id
    OR stored_intent.amount_units <> expected_amount_units
    OR stored_intent.claim_token_hash IS DISTINCT FROM expected_claim_token_hash
    OR stored_intent.paypal_environment <> expected_paypal_environment
    OR (
      required_intent_kind = 'order'
      AND stored_intent.remote_order_id IS DISTINCT FROM expected_remote_parent_id
    )
    OR (
      required_intent_kind = 'allowance'
      AND stored_intent.remote_subscription_id IS DISTINCT FROM expected_remote_parent_id
    )
    OR (
      required_intent_kind = 'order'
      AND stored_intent.status NOT IN ('approval_pending', 'captured')
    )
    OR (
      required_intent_kind = 'allowance'
      AND stored_intent.status NOT IN ('approval_pending', 'active')
    )
    OR (expected_delivery = 'gift' AND (
      requested_purchase_kind <> 'paypal'
      OR requested_gift_public_id IS NULL
      OR requested_gift_public_id !~ '^city_gift_[0-9a-f]{32}$'
    ))
    OR (expected_delivery = 'self' AND requested_gift_public_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PayPal delivery does not match the immutable intent terms'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO event_binding_count
  FROM paypal_credit_events event
  WHERE event.event_id = requested_event_id
    OR event.source_key = requested_source_key;
  IF event_binding_count > 1 THEN
    RAISE EXCEPTION 'PayPal event identity has conflicting durable bindings'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO stored_event
  FROM paypal_credit_events event
  WHERE event.event_id = requested_event_id
    OR event.source_key = requested_source_key
  LIMIT 1;
  IF stored_event.event_id IS NOT NULL AND (
    stored_event.intent_public_id <> stored_intent.public_id
    OR stored_event.event_kind <> requested_event_kind
    OR stored_event.remote_resource_id <> requested_remote_resource_id
    OR stored_event.source_key <> requested_source_key
    OR stored_event.outcome <> 'credited'
  ) THEN
    RAISE EXCEPTION 'PayPal event identity is already bound to changed terms'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO purchase_record
  FROM record_city_credit_purchase(
    stored_intent.recipient_id,
    stored_intent.amount_units,
    requested_source_key,
    requested_purchase_kind,
    stored_intent.claim_token_hash,
    requested_gift_public_id
  );
  IF purchase_record.id IS NULL
    OR purchase_record.resident_id <> stored_intent.recipient_id
    OR purchase_record.amount_units <> stored_intent.amount_units
    OR purchase_record.source_key <> requested_source_key
    OR purchase_record.purchase_kind <> requested_purchase_kind
    OR (stored_intent.delivery = 'gift') <> (purchase_record.gift_row_id IS NOT NULL)
    OR (
      stored_intent.delivery = 'gift'
      AND purchase_record.claim_token_hash IS DISTINCT FROM stored_intent.claim_token_hash
    ) THEN
    RAISE EXCEPTION 'PayPal purchase source is already bound to changed terms'
      USING ERRCODE = '23514';
  END IF;

  IF stored_event.event_id IS NULL THEN
    INSERT INTO paypal_credit_events (
      event_id, intent_public_id, event_kind, remote_resource_id,
      source_key, purchase_entry_id, outcome
    ) VALUES (
      requested_event_id, stored_intent.public_id, requested_event_kind,
      requested_remote_resource_id, requested_source_key,
      purchase_record.id, 'credited'
    ) RETURNING * INTO stored_event;
  ELSIF stored_event.purchase_entry_id <> purchase_record.id THEN
    RAISE EXCEPTION 'PayPal event is already bound to another credit receipt'
      USING ERRCODE = '23514';
  END IF;

  UPDATE paypal_credit_intents intent
  SET status = delivered_status, updated_at = clock_timestamp()
  WHERE intent.public_id = stored_intent.public_id
  RETURNING intent.* INTO stored_intent;

  IF requested_purchase_kind = 'paypal' THEN
    FOR staged_dispute_id IN
      SELECT DISTINCT event.dispute_id COLLATE "C" AS dispute_id
      FROM paypal_credit_dispute_events event
      WHERE requested_remote_resource_id = ANY(event.transaction_capture_ids)
      ORDER BY dispute_id
    LOOP
      PERFORM reconcile_paypal_credit_dispute(staged_dispute_id);
    END LOOP;
  END IF;

  reconciled_gift_status := purchase_record.status;
  IF purchase_record.gift_row_id IS NOT NULL THEN
    SELECT gift.status INTO reconciled_gift_status
    FROM city_credit_gifts gift WHERE gift.id = purchase_record.gift_row_id;
  END IF;

  RETURN QUERY SELECT
    purchase_record.id::BIGINT,
    purchase_record.resident_id::INTEGER,
    purchase_record.amount_units::BIGINT,
    purchase_record.source_key::TEXT,
    purchase_record.purchase_kind::TEXT,
    purchase_record.gift_row_id::BIGINT,
    purchase_record.gift_public_id::TEXT,
    purchase_record.claim_token_hash::TEXT,
    reconciled_gift_status::TEXT,
    purchase_record.created::BOOLEAN,
    purchase_record.balance_units::BIGINT;
END
$$;
