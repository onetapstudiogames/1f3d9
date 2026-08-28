-- One private row keyed by resident ID stores only the covered status, one composite
-- method/path/status/cause fingerprint, a bounded count, and its update time. This changes
-- response text only; it adds no deliberate wait or throttle and never blocks an action.
CREATE TABLE IF NOT EXISTS resident_refusal_state (
  resident_id       INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE CASCADE,
  http_status       SMALLINT NOT NULL
                    CHECK (http_status IN (400, 403, 404, 409, 429)),
  cause_hash        TEXT NOT NULL CHECK (cause_hash ~ '^[0-9a-f]{64}$'),
  repetition_count SMALLINT NOT NULL CHECK (repetition_count BETWEEN 1 AND 10),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
