// The OAuth throttle statement exactly as main ran it at 3ad8d09, before the
// sign-in clean-up found retired families first. It is kept only as a test
// oracle: the equivalence test runs it and the current statement on identical
// data and compares every row left in every table the statement touches.
// Parameters: $1 retention window, $2 batch size, $3 bucket hash,
// $4 attempt kind, $5 maximum.
export const THROTTLE_STATEMENT_BEFORE = `
  WITH current_window AS MATERIALIZED (
    SELECT date_trunc('hour', now(), 'UTC') AS window_start,
      greatest(1, ceil(extract(epoch FROM (
        date_trunc('hour', now(), 'UTC') + interval '1 hour' - now()
      )))::integer) AS retry_after_seconds
  ), cleanup AS (
    DELETE FROM oauth_rate_limits
    WHERE window_start < (SELECT window_start FROM current_window) - interval '24 hours'
  ), retired_codes AS MATERIALIZED (
    SELECT id
    FROM oauth_authorization_codes
    WHERE expires_at <= now() - $1::interval
    ORDER BY expires_at, id
    LIMIT $2
  ), pruned_codes AS (
    DELETE FROM oauth_authorization_codes code
    USING retired_codes retired
    WHERE code.id = retired.id
    RETURNING code.id
  ), retired_requests AS MATERIALIZED (
    SELECT request.id
    FROM oauth_authorization_requests request
    WHERE request.expires_at <= now() - $1::interval
      AND NOT EXISTS (
        SELECT 1 FROM oauth_authorization_codes code
        WHERE code.request_id = request.id
          AND code.id NOT IN (SELECT id FROM retired_codes)
      )
    ORDER BY request.expires_at, request.id
    LIMIT $2
  ), pruned_requests AS (
    DELETE FROM oauth_authorization_requests request
    USING retired_requests retired
    WHERE request.id = retired.id
    RETURNING request.id
  ), retired_tokens AS MATERIALIZED (
    SELECT token.id
    FROM oauth_tokens token
    JOIN oauth_token_families family ON family.id = token.family_id
    WHERE family.expires_at <= now() - $1::interval
    ORDER BY token.id DESC
    LIMIT $2
  ), pruned_tokens AS (
    DELETE FROM oauth_tokens token
    USING retired_tokens retired
    WHERE token.id = retired.id
    RETURNING token.id
  ), retired_families AS MATERIALIZED (
    SELECT family.id
    FROM oauth_token_families family
    WHERE family.expires_at <= now() - $1::interval
      AND NOT EXISTS (
        SELECT 1 FROM oauth_tokens token
        WHERE token.family_id = family.id
          AND token.id NOT IN (SELECT id FROM retired_tokens)
      )
    ORDER BY family.expires_at, family.id
    LIMIT $2
  ), pruned_families AS (
    DELETE FROM oauth_token_families family
    USING retired_families retired
    WHERE family.id = retired.id
    RETURNING family.id
  ), admitted AS (
    INSERT INTO oauth_rate_limits (bucket_hash, attempt_kind, window_start, used)
    SELECT $3, $4, window_start, 1
    FROM current_window
    ON CONFLICT (bucket_hash, attempt_kind, window_start) DO UPDATE
    SET used = oauth_rate_limits.used + 1
    WHERE oauth_rate_limits.used < $5
    RETURNING used
  )
  SELECT EXISTS (SELECT 1 FROM admitted) AS admitted, retry_after_seconds
  FROM current_window
  
`
