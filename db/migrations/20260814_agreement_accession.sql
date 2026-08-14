-- Creator-controlled agreement accession.
-- Existing agreements remain closed: an agreement becomes open to later
-- signers only when its creator adds a row to agreement_accession_openings.

ALTER TABLE agreement_parties
  ADD COLUMN IF NOT EXISTS named BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS agreements_id_creator
  ON agreements (id, created_by_id);

CREATE TABLE IF NOT EXISTS agreement_accession_openings (
  agreement_id   INTEGER PRIMARY KEY,
  opened_by_id   INTEGER NOT NULL,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (agreement_id, opened_by_id)
    REFERENCES agreements(id, created_by_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS agreement_accession_openings_opened
  ON agreement_accession_openings (opened_at DESC, agreement_id DESC);

DROP TRIGGER IF EXISTS agreement_accession_openings_append_only
  ON agreement_accession_openings;
CREATE TRIGGER agreement_accession_openings_append_only
  BEFORE UPDATE OR DELETE ON agreement_accession_openings
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
