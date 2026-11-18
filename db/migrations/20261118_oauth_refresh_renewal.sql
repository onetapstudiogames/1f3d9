BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '2s';
SET LOCAL intervalstyle = 'postgres';

-- Match each original check by its full catalog expression. The last column
-- is the replacement expression, or NULL when only the name changes.
DO $renew_signins$
DECLARE
  rule record;
  installed record;
BEGIN
  -- Serialize migration attempts while allowing ordinary reads and writes on a repeat.
  LOCK TABLE public.oauth_token_families, public.oauth_tokens IN SHARE UPDATE EXCLUSIVE MODE;
  FOR rule IN SELECT * FROM (VALUES
    ('public.oauth_token_families'::regclass, 'oauth_token_families_expiry_after_creation',
      $expr$((expires_at > created_at) AND (expires_at <= (created_at + '30 days'::interval)))$expr$,
      '(expires_at > created_at)'),
    ('public.oauth_token_families'::regclass, 'oauth_token_families_revocation_time',
      '((revoked_at IS NULL) OR (revoked_at >= created_at))', NULL),
    ('public.oauth_tokens'::regclass, 'oauth_tokens_lifetime',
      $expr$((expires_at > created_at) AND (expires_at <= (created_at + CASE token_type WHEN 'access'::text THEN '00:10:00'::interval ELSE '30 days'::interval END)))$expr$,
      $expr$((expires_at > created_at) AND ((token_type <> 'access'::text) OR (expires_at <= (created_at + '00:10:00'::interval))))$expr$),
    ('public.oauth_tokens'::regclass, 'oauth_tokens_use_time',
      '((used_at IS NULL) OR (used_at >= created_at))', NULL),
    ('public.oauth_tokens'::regclass, 'oauth_tokens_revocation_time',
      '((revoked_at IS NULL) OR (revoked_at >= created_at))', NULL),
    ('public.oauth_tokens'::regclass, 'oauth_tokens_rotation_type',
      $expr$((rotated_from_token_id IS NULL) OR (token_type = 'refresh'::text))$expr$, NULL)
  ) AS rules(relation, final_name, original, replacement)
  LOOP
    -- Require exactly one validated match. A missing or ambiguous check rolls back the migration.
    SELECT * INTO STRICT installed FROM (
      SELECT conname, regexp_replace(pg_get_expr(conbin, conrelid), '[[:space:]]+', ' ', 'g') AS expression
      FROM pg_constraint WHERE conrelid = rule.relation AND contype = 'c' AND convalidated
    ) AS checks
    WHERE expression = rule.original OR (conname = rule.final_name AND expression = rule.replacement);

    IF installed.expression = rule.original AND rule.replacement IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I CHECK %s',
        rule.relation, installed.conname, rule.final_name, rule.replacement);
    ELSIF installed.conname <> rule.final_name THEN
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
        rule.relation, installed.conname, rule.final_name);
    END IF;
  END LOOP;
EXCEPTION
  WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'Expected one validated check for % on %', rule.final_name, rule.relation;
END
$renew_signins$;

COMMIT;
