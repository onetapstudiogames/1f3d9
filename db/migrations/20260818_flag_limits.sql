BEGIN;

-- Resident flag limits (audit item 10). The flag bucket table now holds one
-- guarded hourly bucket per caller key: hashed IPs for anonymous reporters
-- (5/hour) and hashed resident ids (20/hour). The old column CHECK capped
-- used at the anonymous 5, which would turn a resident's sixth report of the
-- hour into a constraint failure instead of an admission. Each caller's real
-- cap is enforced by the upsert's WHERE guard; the constraint keeps only the
-- sanity floor. The table is tiny, so the timeout-guarded constraint swap is
-- safe.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE anonymous_flag_limits
  DROP CONSTRAINT IF EXISTS anonymous_flag_limits_used_check;
ALTER TABLE anonymous_flag_limits
  ADD CONSTRAINT anonymous_flag_limits_used_check CHECK (used >= 1);

COMMIT;
