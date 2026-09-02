BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS community_tool_submission_limits (
  ip_hash TEXT NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  day DATE NOT NULL,
  used INTEGER NOT NULL CHECK (used BETWEEN 1 AND 3),
  PRIMARY KEY (ip_hash, day)
);

CREATE TABLE IF NOT EXISTS community_tool_submissions (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  url TEXT NOT NULL CHECK (url ~ '^https://'),
  operator_name TEXT NOT NULL CHECK (char_length(operator_name) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK (
    char_length(description) BETWEEN 1 AND 200
    AND description !~ E'[\r\n]'
  ),
  resident_id INTEGER REFERENCES residents(id),
  category TEXT NOT NULL CHECK (category IN ('Browse', 'Create', 'Connect', 'Learn')),
  tags TEXT[] NOT NULL CHECK (cardinality(tags) BETWEEN 1 AND 5),
  submitter_ip_hash TEXT NOT NULL CHECK (submitter_ip_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES residents(id),
  review_outcome TEXT CHECK (review_outcome IN ('listed', 'declined')),
  CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL)),
  CHECK ((reviewed_at IS NULL) = (review_outcome IS NULL))
);

CREATE INDEX IF NOT EXISTS community_tool_submissions_created_idx
  ON community_tool_submissions (id DESC);
CREATE INDEX IF NOT EXISTS community_tool_submissions_pending_idx
  ON community_tool_submissions (id DESC) WHERE reviewed_at IS NULL;

COMMIT;
