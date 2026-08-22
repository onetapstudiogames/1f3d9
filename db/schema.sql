-- 1F3D9 schema. One Neon database, deliberately boring.
-- The database stores public records of verified payments; it never holds money.

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
  recovery_generation       BIGINT NOT NULL DEFAULT 0 CHECK (recovery_generation >= 0)
);
ALTER TABLE residents ALTER COLUMN id DROP DEFAULT;
ALTER TABLE residents
  ADD COLUMN IF NOT EXISTS recovery_generation BIGINT NOT NULL DEFAULT 0;
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
ALTER TABLE residents DROP CONSTRAINT IF EXISTS residents_id_landmark;
ALTER TABLE residents ADD CONSTRAINT residents_id_landmark CHECK (id > 0 AND id <> 4);
CREATE INDEX IF NOT EXISTS residents_joined ON residents (joined_at, id);

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

CREATE TABLE IF NOT EXISTS anonymous_flag_limits (
  ip_hash   TEXT NOT NULL CHECK (char_length(ip_hash) BETWEEN 32 AND 128),
  hour      TIMESTAMPTZ NOT NULL CHECK (hour = date_trunc('hour', hour, 'UTC')),
  used      SMALLINT NOT NULL DEFAULT 1 CHECK (used >= 1),
  PRIMARY KEY (ip_hash, hour)
);

CREATE TABLE IF NOT EXISTS places (
  id                SERIAL PRIMARY KEY,
  parent_id         INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  place_kind        TEXT NOT NULL DEFAULT 'place',
  name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description       TEXT NOT NULL DEFAULT '' CHECK (octet_length(description) <= 65536),
  owner_id          INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  open_to_building  BOOLEAN NOT NULL DEFAULT FALSE,
  open_to_things    BOOLEAN NOT NULL DEFAULT FALSE,
  open_to_notes     BOOLEAN NOT NULL DEFAULT FALSE,
  active_offer_id   INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT places_place_kind_allowed
    CHECK (place_kind IN ('world', 'continent', 'place')),
  CONSTRAINT places_active_offer_positive
    CHECK (active_offer_id IS NULL OR active_offer_id > 0),
  CONSTRAINT places_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
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
ALTER TABLE places ALTER COLUMN owner_id DROP NOT NULL;

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
END
$schema_upgrade$;
ALTER TABLE places VALIDATE CONSTRAINT places_place_kind_allowed;
ALTER TABLE places VALIDATE CONSTRAINT places_active_offer_positive;

UPDATE places
SET place_kind = 'continent'
WHERE parent_id IS NULL
  AND owner_id IS NOT NULL
  AND place_kind <> 'world';

DROP INDEX IF EXISTS places_frontier_name;

INSERT INTO places (
  parent_id, place_kind, name, description, owner_id,
  open_to_building, open_to_things, open_to_notes, active_offer_id
)
SELECT
  NULL, 'world', 'the world',
  'the unowned space between continents; transit only',
  NULL, FALSE, FALSE, FALSE, NULL
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
    )
    OR
    (
      place_kind IN ('continent', 'place')
      AND parent_id IS NOT NULL
      AND owner_id IS NOT NULL
    )
  ) NOT VALID;
ALTER TABLE places VALIDATE CONSTRAINT places_world_shape;

CREATE UNIQUE INDEX IF NOT EXISTS places_sibling_name
  ON places (parent_id, lower(name)) WHERE parent_id IS NOT NULL;
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
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind_id, revision),
  CHECK (jsonb_typeof(recipe) IN ('array', 'object'))
);
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
  open_to_use       BOOLEAN NOT NULL DEFAULT FALSE,
  kind_id           INTEGER REFERENCES kinds(id) ON DELETE RESTRICT,
  birth_revision    INTEGER,
  current_revision  INTEGER,
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
    REFERENCES kind_revisions(kind_id, revision) MATCH FULL ON DELETE RESTRICT
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

ALTER TABLE things ADD COLUMN IF NOT EXISTS active_offer_id INTEGER
  CHECK (active_offer_id > 0);
ALTER TABLE things ADD COLUMN IF NOT EXISTS open_to_use BOOLEAN NOT NULL DEFAULT FALSE;

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
  target_type  TEXT NOT NULL CHECK (target_type IN ('place', 'thing', 'kind', 'trait', 'note', 'agreement')),
  target_id    INTEGER NOT NULL CHECK (target_id > 0),
  action       TEXT NOT NULL CHECK (action IN ('remove', 'restore')),
  actor_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT CHECK (actor_id = 1),
  reason       TEXT NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 4000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_actions_target
  ON moderation_actions (target_type, target_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS moderation_actions_time
  ON moderation_actions (created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION protect_thing_history() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'things are retained as history; set withdrawn_at instead' USING ERRCODE = '55000'; END IF; IF NEW.kind_id IS DISTINCT FROM OLD.kind_id OR NEW.birth_revision IS DISTINCT FROM OLD.birth_revision OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'a thing birth revision is immutable' USING ERRCODE = '55000'; END IF; IF OLD.withdrawn_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'a withdrawn thing is immutable' USING ERRCODE = '55000'; END IF; IF NEW.withdrawn_at IS NOT NULL AND NEW.withdrawn_at < NEW.created_at THEN RAISE EXCEPTION 'withdrawn_at cannot predate creation' USING ERRCODE = '22007'; END IF; RETURN NEW; END$$;
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
    coalesce(sum(octet_length(description)), 0)::bigint AS text_bytes
  FROM places
  WHERE parent_id IS NOT NULL
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
    IF NEW.parent_id IS NOT NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items + 1,
        subplace_text_bytes = subplace_text_bytes + octet_length(NEW.description)
      WHERE place_id = NEW.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', NEW.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.parent_id IS NOT NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items - 1,
        subplace_text_bytes = subplace_text_bytes - octet_length(OLD.description)
      WHERE place_id = OLD.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', OLD.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.description IS DISTINCT FROM OLD.description THEN
    IF OLD.parent_id IS NOT NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items - 1,
        subplace_text_bytes = subplace_text_bytes - octet_length(OLD.description)
      WHERE place_id = OLD.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', OLD.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF NEW.parent_id IS NOT NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items + 1,
        subplace_text_bytes = subplace_text_bytes + octet_length(NEW.description)
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
AFTER INSERT OR DELETE OR UPDATE OF parent_id, description ON places
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
