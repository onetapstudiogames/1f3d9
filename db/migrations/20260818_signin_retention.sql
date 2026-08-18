BEGIN;

-- Sign-in data retention (docs/runbooks/SIGNIN_RETENTION.md). Retention
-- pruning scans expired sign-in rows in every terminal state, which the
-- existing partial live-row expiry indexes cannot serve. These three additive
-- indexes keep each bounded retention batch an index scan. The tables are
-- small, so plain CREATE INDEX inside the timeout-guarded transaction is safe.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS oauth_authorization_requests_retention
  ON oauth_authorization_requests (expires_at, id);

CREATE INDEX IF NOT EXISTS oauth_authorization_codes_retention
  ON oauth_authorization_codes (expires_at, id);

CREATE INDEX IF NOT EXISTS oauth_token_families_retention
  ON oauth_token_families (expires_at, id);

COMMIT;
