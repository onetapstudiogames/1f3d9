-- Additive signup storage for mandatory initial recovery-code hashes.
-- Existing pending tables and their constraints stay untouched so the migration
-- can be applied before the new application version is deployed.

CREATE TABLE IF NOT EXISTS pending_resident_registration_recovery_codes (
  registration_session_hash TEXT NOT NULL
                            REFERENCES pending_resident_registrations(session_hash)
                            ON DELETE CASCADE,
  ordinal                   SMALLINT NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  code_hash                 TEXT NOT NULL UNIQUE
                            CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (registration_session_hash, ordinal)
);

CREATE TABLE IF NOT EXISTS oauth_authorization_request_recovery_codes (
  request_id BIGINT NOT NULL
             REFERENCES oauth_authorization_requests(id) ON DELETE CASCADE,
  ordinal    SMALLINT NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  code_hash  TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (request_id, ordinal)
);
