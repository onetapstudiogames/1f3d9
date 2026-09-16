BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- The founder's one answer to one report. flags stays append-only, so the answer
-- lives in its own append-only row: at most one review per flag, naming either the
-- moderation act that answered it, a short no-action note, or both.
CREATE TABLE IF NOT EXISTS flag_reviews (
  id            SERIAL PRIMARY KEY,
  flag_id       INTEGER NOT NULL UNIQUE REFERENCES flags(id) ON DELETE RESTRICT,
  reviewer_id   INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  moderation_id BIGINT REFERENCES moderation_actions(id) ON DELETE RESTRICT,
  note          TEXT CHECK (
    note IS NULL OR (char_length(note) BETWEEN 1 AND 200 AND note !~ E'[\t\r\n]')
  ),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (moderation_id IS NOT NULL OR note IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS flag_reviews_reviewer
  ON flag_reviews (reviewer_id, created_at DESC);

DROP TRIGGER IF EXISTS flag_reviews_append_only ON flag_reviews;
CREATE TRIGGER flag_reviews_append_only BEFORE UPDATE OR DELETE ON flag_reviews
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

COMMIT;
