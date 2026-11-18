BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '2s';
SET LOCAL intervalstyle = 'postgres';

-- The original family check has a database-assigned name. Identify it by its
-- entire expression so another check on these columns is never dropped.
DO $renew_family$
DECLARE
  old_check name;
BEGIN
  -- Serialize concurrent migration attempts. Only the ALTER needs to stop readers and writers.
  LOCK TABLE public.oauth_token_families IN SHARE UPDATE EXCLUSIVE MODE;
  old_check := (
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.oauth_token_families'::regclass AND contype = 'c'
      AND pg_get_expr(conbin, conrelid) =
        '((expires_at > created_at) AND (expires_at <= (created_at + ''30 days''::interval)))'
  );
  IF old_check IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.oauth_token_families DROP CONSTRAINT %I,
       ADD CONSTRAINT oauth_token_families_expiry_after_creation CHECK (expires_at > created_at)',
      old_check
    );
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.oauth_token_families'::regclass AND contype = 'c'
      AND conname = 'oauth_token_families_expiry_after_creation' AND convalidated
      AND pg_get_expr(conbin, conrelid) = '(expires_at > created_at)'
  ) THEN
    RAISE EXCEPTION 'Missing the expected sign-in family expiry check';
  END IF;
END
$renew_family$;

COMMIT;
