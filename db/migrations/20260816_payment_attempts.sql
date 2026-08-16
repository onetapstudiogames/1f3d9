CREATE TABLE IF NOT EXISTS payment_attempts (
  id                  SERIAL PRIMARY KEY,
  payment_key         TEXT NOT NULL UNIQUE CHECK (payment_key ~ '^[0-9a-f]{64}$'),
  payment_kind        TEXT NOT NULL CHECK (payment_kind IN ('x402')),
  status              TEXT NOT NULL CHECK (status IN ('initiated', 'settled', 'completed', 'failed')),
  actor_id            INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  purpose             TEXT NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{0,31}$'),
  payer_wallet        TEXT NOT NULL CHECK (payer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  payee_wallet        TEXT NOT NULL CHECK (payee_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  amount_usdc         NUMERIC(12,6) NOT NULL CHECK (amount_usdc > 0 AND amount_usdc <= 10000),
  payment_payload     JSONB NOT NULL,
  transaction_hash    TEXT CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
  completion_tx_hash  TEXT CHECK (completion_tx_hash IS NULL OR completion_tx_hash ~ '^0x[0-9a-f]{64}$'),
  completion_kind     TEXT CHECK (completion_kind IS NULL OR completion_kind IN (
    'place', 'kind_revision', 'transfer_offer', 'world_offer'
  )),
  completion_id       INTEGER CHECK (completion_id IS NULL OR completion_id > 0),
  completion_revision INTEGER CHECK (completion_revision IS NULL OR completion_revision > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  CHECK ((status = 'settled') = (transaction_hash IS NOT NULL AND settled_at IS NOT NULL)),
  CHECK ((status = 'completed') = (
    transaction_hash IS NOT NULL AND completion_tx_hash IS NOT NULL
    AND completion_kind IS NOT NULL AND completion_id IS NOT NULL AND completed_at IS NOT NULL
  )),
  CHECK ((status = 'failed') = (failed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS payment_attempts_actor_created
  ON payment_attempts (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_attempts_completion
  ON payment_attempts (completion_kind, completion_id) WHERE status = 'completed';
