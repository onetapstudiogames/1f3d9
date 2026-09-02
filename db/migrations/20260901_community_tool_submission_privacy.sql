BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'community_tool_submissions'::regclass
      AND conname = 'community_tool_submissions_pending_hash'
  ) AND (
    EXISTS (SELECT 1 FROM community_tool_submissions)
    OR EXISTS (SELECT 1 FROM community_tool_submission_limits)
  ) THEN
    RAISE EXCEPTION 'community tool privacy migration refuses legacy address hashes';
  END IF;
END
$$;

ALTER TABLE community_tool_submissions
  ALTER COLUMN submitter_ip_hash DROP NOT NULL;

UPDATE community_tool_submissions
SET submitter_ip_hash = NULL
WHERE reviewed_at IS NOT NULL AND submitter_ip_hash IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'community_tool_submissions'::regclass
      AND conname = 'community_tool_submissions_single_line'
  ) THEN
    ALTER TABLE community_tool_submissions
      ADD CONSTRAINT community_tool_submissions_single_line CHECK (
        title !~ E'[\t\r\n]'
        AND operator_name !~ E'[\t\r\n]'
        AND description !~ E'[\t\r\n]'
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'community_tool_submissions'::regclass
      AND conname = 'community_tool_submissions_pending_hash'
  ) THEN
    ALTER TABLE community_tool_submissions
      ADD CONSTRAINT community_tool_submissions_pending_hash CHECK (
        (reviewed_at IS NULL) = (submitter_ip_hash IS NOT NULL)
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE community_tool_submissions
  VALIDATE CONSTRAINT community_tool_submissions_single_line;
ALTER TABLE community_tool_submissions
  VALIDATE CONSTRAINT community_tool_submissions_pending_hash;

COMMIT;
