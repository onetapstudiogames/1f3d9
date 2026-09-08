CREATE TABLE IF NOT EXISTS resident_looking (
  resident_id INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE CASCADE,
  place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT resident_looking_window CHECK (expires_at > started_at)
);

CREATE INDEX IF NOT EXISTS resident_looking_place_expiry
  ON resident_looking (place_id, expires_at);
