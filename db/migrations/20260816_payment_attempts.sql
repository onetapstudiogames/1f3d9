-- Additive payment-attempt custody. Refuse to reinterpret the short-lived
-- pre-release table: it retained signed payment payloads and used incompatible
-- lifecycle rules. An operator must quarantine that table before continuing.
DO $$
BEGIN
  IF to_regclass('public.payment_attempts') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'payment_attempts'
        AND column_name = 'public_id'
    ) THEN
    RAISE EXCEPTION 'legacy payment_attempts schema requires quarantine before custody migration'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE transfer_offers
  ADD COLUMN IF NOT EXISTS pending_payment_attempt_id TEXT;

CREATE TABLE IF NOT EXISTS payment_attempts (
  public_id                TEXT PRIMARY KEY
                           CHECK (octet_length(public_id) BETWEEN 16 AND 128
                             AND public_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]+$'),
  actor_id                 INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT
                           CHECK (actor_id > 0),
  counterparty_id          INTEGER REFERENCES residents(id) ON DELETE RESTRICT
                           CHECK (counterparty_id IS NULL OR counterparty_id > 0),
  operation                TEXT NOT NULL CHECK (operation IN (
                             'frontier', 'kind_invention', 'kind_revision',
                             'direct_sale', 'world_sale', 'legacy'
                           )),
  target_key               TEXT CHECK (
                             target_key IS NULL OR octet_length(target_key) BETWEEN 1 AND 240
                           ),
  offer_id                 INTEGER CHECK (offer_id IS NULL OR offer_id > 0),
  asset_type               TEXT CHECK (
                             asset_type IS NULL OR asset_type IN ('place', 'thing', 'kind')
                           ),
  asset_id                 INTEGER CHECK (asset_id IS NULL OR asset_id > 0),
  request_hash             TEXT CHECK (
                             request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'
                           ),
  request_json             JSONB CHECK (
                             request_json IS NULL OR jsonb_typeof(request_json) = 'object'
                           ),
  method                   TEXT CHECK (method IS NULL OR method IN ('x402', 'claim', 'legacy')),
  network                  TEXT CHECK (network IS NULL OR network = 'base'),
  token                    TEXT CHECK (
                             token IS NULL
                             OR token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
                           ),
  payer_wallet             TEXT CHECK (
                             payer_wallet IS NULL OR payer_wallet ~ '^0x[0-9a-f]{40}$'
                           ),
  payee_wallet             TEXT CHECK (
                             payee_wallet IS NULL OR payee_wallet ~ '^0x[0-9a-f]{40}$'
                           ),
  amount_units             BIGINT CHECK (
                             amount_units IS NULL OR amount_units BETWEEN 1 AND 10000000000
                           ),
  x402_nonce               TEXT CHECK (
                             x402_nonce IS NULL OR x402_nonce ~ '^0x[0-9a-f]{64}$'
                           ),
  x402_payload_digest      TEXT CHECK (
                             x402_payload_digest IS NULL
                             OR x402_payload_digest ~ '^[0-9a-f]{64}$'
                           ),
  x402_valid_after         BIGINT CHECK (
                             x402_valid_after IS NULL OR x402_valid_after >= 0
                           ),
  x402_valid_before        BIGINT CHECK (
                             x402_valid_before IS NULL OR x402_valid_before >= 0
                           ),
  start_block              BIGINT CHECK (start_block IS NULL OR start_block >= 0),
  start_time               TIMESTAMPTZ,
  end_time                 TIMESTAMPTZ,
  status                   TEXT NOT NULL CHECK (status IN (
                             'settling', 'payment_pending', 'completed',
                             'invalid', 'expired', 'needs_review', 'legacy_completed'
                           )),
  lease_owner              TEXT CHECK (
                             lease_owner IS NULL OR octet_length(lease_owner) BETWEEN 1 AND 128
                           ),
  lease_expires_at         TIMESTAMPTZ,
  tx_hash                  TEXT UNIQUE CHECK (
                             tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'
                           ),
  finalized_block_number   BIGINT CHECK (
                             finalized_block_number IS NULL OR finalized_block_number >= 0
                           ),
  finalized_block_hash     TEXT CHECK (
                             finalized_block_hash IS NULL
                             OR finalized_block_hash ~ '^0x[0-9a-f]{64}$'
                           ),
  finalized_block_time     TIMESTAMPTZ,
  finalized_at             TIMESTAMPTZ,
  invalid_reason           TEXT CHECK (
                             invalid_reason IS NULL OR octet_length(invalid_reason) BETWEEN 1 AND 240
                           ),
  result_json              JSONB CHECK (
                             result_json IS NULL OR jsonb_typeof(result_json) = 'object'
                           ),
  response_status          SMALLINT CHECK (
                             response_status IS NULL OR response_status BETWEEN 100 AND 599
                           ),
  response_json            JSONB CHECK (
                             response_json IS NULL OR jsonb_typeof(response_json) = 'object'
                           ),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ,
  CHECK ((asset_type IS NULL) = (asset_id IS NULL)),
  CHECK (status NOT IN ('settling', 'payment_pending', 'needs_review') OR target_key IS NOT NULL),
  CHECK (end_time IS NULL OR start_time IS NULL OR end_time > start_time),
  CHECK (
    x402_valid_before IS NULL OR x402_valid_after IS NULL
    OR x402_valid_before > x402_valid_after
  ),
  CHECK (
    x402_nonce IS NULL
    OR (method = 'x402' AND network = 'base' AND token IS NOT NULL AND payer_wallet IS NOT NULL)
  ),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (updated_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (
    finalized_block_number IS NULL OR start_block IS NULL
    OR finalized_block_number >= start_block
  ),
  CONSTRAINT payment_attempts_finality_complete CHECK (
    (finalized_block_number IS NULL AND finalized_block_hash IS NULL
      AND finalized_block_time IS NULL AND finalized_at IS NULL)
    OR
    (finalized_block_number IS NOT NULL AND finalized_block_hash IS NOT NULL
      AND finalized_block_time IS NOT NULL AND finalized_at IS NOT NULL)
  ),
  CONSTRAINT payment_attempts_completed_facts CHECK (
    status <> 'completed' OR (
      tx_hash IS NOT NULL
      AND finalized_block_number IS NOT NULL
      AND finalized_block_hash IS NOT NULL
      AND finalized_block_time IS NOT NULL
      AND finalized_at IS NOT NULL
      AND result_json IS NOT NULL
      AND response_status IS NOT NULL
      AND response_json IS NOT NULL
      AND completed_at IS NOT NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  )
);

-- These repairs make a rerun converge if an earlier preview saw the expanded
-- table before the finality timestamp and review state were added.
ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS finalized_block_time TIMESTAMPTZ;
ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_status_check CHECK (status IN (
    'settling', 'payment_pending', 'completed', 'invalid', 'expired',
    'needs_review', 'founder_review', 'legacy_completed', 'credit_returned'
  ));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_attempts'::regclass
      AND conname = 'payment_attempts_finality_complete'
  ) THEN
    ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_finality_complete CHECK (
      (finalized_block_number IS NULL AND finalized_block_hash IS NULL
        AND finalized_block_time IS NULL AND finalized_at IS NULL)
      OR
      (finalized_block_number IS NOT NULL AND finalized_block_hash IS NOT NULL
        AND finalized_block_time IS NOT NULL AND finalized_at IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_attempts'::regclass
      AND conname = 'payment_attempts_completed_facts'
  ) THEN
    ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_completed_facts CHECK (
      status <> 'completed' OR (
        tx_hash IS NOT NULL
        AND finalized_block_number IS NOT NULL
        AND finalized_block_hash IS NOT NULL
        AND finalized_block_time IS NOT NULL
        AND finalized_at IS NOT NULL
        AND result_json IS NOT NULL
        AND response_status IS NOT NULL
        AND response_json IS NOT NULL
        AND completed_at IS NOT NULL
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL
      )
    );
  END IF;
END
$$;

COMMENT ON COLUMN payment_attempts.actor_id IS
  'Authenticated resident initiating and receiving the paid operation result';
COMMENT ON COLUMN payment_attempts.counterparty_id IS
  'Immutable other resident in a sale; NULL for treasury fees';

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_x402_nonce
  ON payment_attempts (network, token, payer_wallet, x402_nonce)
  WHERE x402_nonce IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_live_target
  ON payment_attempts (operation, target_key)
  WHERE target_key IS NOT NULL AND status IN ('settling', 'payment_pending', 'needs_review');
CREATE INDEX IF NOT EXISTS payment_attempts_actor
  ON payment_attempts (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_reconcile
  ON payment_attempts (updated_at, public_id)
  WHERE status IN ('settling', 'payment_pending', 'needs_review');

-- Existing completed receipts become terminal legacy attempts. Only facts
-- present in the old ledgers are copied; no nonce, request, block, or canonical
-- response is fabricated. Sale rows contribute the seller identity and facts
-- they already recorded. A deterministic public id makes rerunning harmless.
INSERT INTO payment_attempts (
  public_id, actor_id, counterparty_id, operation, target_key,
  offer_id, asset_type, asset_id, method, network, token,
  payer_wallet, payee_wallet, amount_units, start_time, end_time,
  status, tx_hash, created_at, updated_at, completed_at
)
SELECT
  'legacy_use_' || substr(payment_uses.tx_hash, 3),
  payment_uses.actor_id,
  transfer_offers.seller_id,
  CASE
    WHEN payment_uses.purpose = 'frontier' THEN 'frontier'
    WHEN payment_uses.purpose = 'kind_invention' THEN 'kind_invention'
    WHEN payment_uses.purpose = 'kind_revision' THEN 'kind_revision'
    WHEN payment_uses.purpose = 'sale' AND transfer_offers.channel = 'direct'
      THEN 'direct_sale'
    WHEN payment_uses.purpose = 'sale' AND transfer_offers.channel = 'world'
      THEN 'world_sale'
    ELSE 'legacy'
  END,
  CASE WHEN sale_payments.offer_id IS NOT NULL
    THEN 'offer:' || sale_payments.offer_id::text ELSE NULL END,
  sale_payments.offer_id,
  transfer_offers.asset_type,
  transfer_offers.asset_id,
  sale_payments.verified_via,
  'base',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  lower(payment_uses.payer_wallet),
  lower(payment_uses.payee_wallet),
  CASE WHEN payment_uses.amount_usdc IS NULL THEN NULL
    ELSE (payment_uses.amount_usdc * 1000000)::bigint END,
  transfer_offers.reserved_at,
  transfer_offers.reserved_until,
  'legacy_completed',
  payment_uses.tx_hash,
  payment_uses.created_at,
  payment_uses.created_at,
  payment_uses.created_at
FROM payment_uses
LEFT JOIN sale_payments ON sale_payments.tx_hash = payment_uses.tx_hash
LEFT JOIN transfer_offers ON transfer_offers.id = sale_payments.offer_id
WHERE NOT EXISTS (
  SELECT 1 FROM payment_attempts AS existing
  WHERE existing.public_id = 'legacy_use_' || substr(payment_uses.tx_hash, 3)
)
AND NOT EXISTS (
  SELECT 1 FROM payment_attempts AS existing
  WHERE existing.tx_hash = payment_uses.tx_hash
    AND existing.status IN ('completed', 'legacy_completed')
    AND existing.actor_id = payment_uses.actor_id
    AND existing.operation = CASE
      WHEN payment_uses.purpose = 'frontier' THEN 'frontier'
      WHEN payment_uses.purpose = 'kind_invention' THEN 'kind_invention'
      WHEN payment_uses.purpose = 'kind_revision' THEN 'kind_revision'
      WHEN payment_uses.purpose = 'sale' AND transfer_offers.channel = 'direct'
        THEN 'direct_sale'
      WHEN payment_uses.purpose = 'sale' AND transfer_offers.channel = 'world'
        THEN 'world_sale'
      ELSE 'legacy'
    END
    AND existing.counterparty_id IS NOT DISTINCT FROM transfer_offers.seller_id
    AND existing.offer_id IS NOT DISTINCT FROM sale_payments.offer_id
    AND existing.asset_type IS NOT DISTINCT FROM transfer_offers.asset_type
    AND existing.asset_id IS NOT DISTINCT FROM transfer_offers.asset_id
    AND existing.method IS NOT DISTINCT FROM sale_payments.verified_via
    AND existing.network = 'base'
    AND existing.token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    AND existing.payer_wallet IS NOT DISTINCT FROM lower(payment_uses.payer_wallet)
    AND existing.payee_wallet IS NOT DISTINCT FROM lower(payment_uses.payee_wallet)
    AND existing.amount_units IS NOT DISTINCT FROM CASE
      WHEN payment_uses.amount_usdc IS NULL THEN NULL
      ELSE (payment_uses.amount_usdc * 1000000)::bigint
    END
);

-- Open world checkouts with captured x402 evidence did not reach payment_uses.
-- Import them separately. Deliberately do not ignore tx_hash conflicts: if the
-- receipt was consumed elsewhere, the unique constraint aborts this migration
-- so an operator must reconcile the contradictory custody records.
INSERT INTO payment_attempts (
  public_id, actor_id, counterparty_id, operation, target_key,
  offer_id, asset_type, asset_id, method, network, token,
  payer_wallet, payee_wallet, amount_units, start_time, end_time,
  status, tx_hash, invalid_reason, created_at, updated_at, completed_at
)
SELECT
  'legacy_world_' || substr(transfer_offers.pending_x402_tx_hash, 3),
  transfer_offers.buyer_id,
  transfer_offers.seller_id,
  'world_sale',
  'offer:' || transfer_offers.id::text,
  transfer_offers.id,
  transfer_offers.asset_type,
  transfer_offers.asset_id,
  'x402',
  'base',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  lower(transfer_offers.pending_x402_payer),
  lower(transfer_offers.seller_wallet),
  (transfer_offers.price_usdc * 1000000)::bigint,
  transfer_offers.reserved_at,
  transfer_offers.reserved_until,
  CASE WHEN transfer_offers.x402_evidence_state = 'invalid'
    THEN 'invalid' ELSE 'payment_pending' END,
  transfer_offers.pending_x402_tx_hash,
  transfer_offers.x402_invalid_reason,
  transfer_offers.pending_x402_at,
  COALESCE(transfer_offers.x402_invalid_at, transfer_offers.pending_x402_at),
  transfer_offers.x402_invalid_at
FROM transfer_offers
WHERE transfer_offers.status = 'open'
  AND transfer_offers.channel = 'world'
  AND transfer_offers.pending_x402_tx_hash IS NOT NULL
  AND transfer_offers.x402_evidence_state IN ('pending', 'invalid')
  AND NOT EXISTS (
    SELECT 1 FROM payment_attempts AS existing
    WHERE existing.public_id =
      'legacy_world_' || substr(transfer_offers.pending_x402_tx_hash, 3)
  );

UPDATE transfer_offers
SET pending_payment_attempt_id =
  'legacy_world_' || substr(pending_x402_tx_hash, 3)
WHERE pending_x402_tx_hash IS NOT NULL
  AND pending_payment_attempt_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS transfer_offers_pending_payment_attempt
  ON transfer_offers (pending_payment_attempt_id)
  WHERE pending_payment_attempt_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_pending_attempt_owner'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_pending_attempt_owner
      FOREIGN KEY (pending_payment_attempt_id)
      REFERENCES payment_attempts (public_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_pending_attempt_state'
  ) THEN
    ALTER TABLE transfer_offers ADD CONSTRAINT transfer_offers_pending_attempt_state CHECK (
      (pending_x402_tx_hash IS NULL AND pending_payment_attempt_id IS NULL)
      OR (pending_x402_tx_hash IS NOT NULL AND pending_payment_attempt_id IS NOT NULL)
    );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION protect_pending_payment_attempt_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.pending_payment_attempt_id IS NOT NULL
    AND NEW.pending_payment_attempt_id IS DISTINCT FROM OLD.pending_payment_attempt_id THEN
    RAISE EXCEPTION 'pending payment attempt ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS transfer_offers_keep_pending_attempt ON transfer_offers;
CREATE TRIGGER transfer_offers_keep_pending_attempt
  BEFORE UPDATE ON transfer_offers
  FOR EACH ROW EXECUTE FUNCTION protect_pending_payment_attempt_link();

-- Move every receipt into the same ownership domain. The temporary trigger
-- removal is transaction-scoped: the gate keeps paid writers off while this
-- migration backfills, constrains, and restores append-only history.
DROP TRIGGER IF EXISTS payment_uses_append_only ON payment_uses;
ALTER TABLE payment_uses ADD COLUMN IF NOT EXISTS payment_attempt_id TEXT;
UPDATE payment_uses AS payment_use
SET payment_attempt_id = attempt.public_id
FROM payment_attempts AS attempt
WHERE payment_use.payment_attempt_id IS NULL
  AND attempt.tx_hash = payment_use.tx_hash;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_uses WHERE payment_attempt_id IS NULL) THEN
    RAISE EXCEPTION 'every payment use must resolve to one payment attempt'
      USING ERRCODE = '23514';
  END IF;
END
$$;

ALTER TABLE payment_uses ALTER COLUMN payment_attempt_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_public_tx
  ON payment_attempts (public_id, tx_hash);
CREATE UNIQUE INDEX IF NOT EXISTS payment_uses_one_attempt
  ON payment_uses (payment_attempt_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_exact_attempt'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_exact_attempt
      FOREIGN KEY (payment_attempt_id, tx_hash)
      REFERENCES payment_attempts (public_id, tx_hash)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION protect_payment_attempt_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment attempt history cannot be deleted' USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.public_id, NEW.actor_id, NEW.counterparty_id, NEW.operation,
    NEW.target_key, NEW.offer_id, NEW.asset_type, NEW.asset_id,
    NEW.request_hash, NEW.request_json, NEW.method, NEW.network, NEW.token,
    NEW.payer_wallet, NEW.payee_wallet, NEW.amount_units, NEW.x402_nonce,
    NEW.x402_payload_digest, NEW.x402_valid_after, NEW.x402_valid_before,
    NEW.start_block, NEW.start_time, NEW.end_time, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.public_id, OLD.actor_id, OLD.counterparty_id, OLD.operation,
    OLD.target_key, OLD.offer_id, OLD.asset_type, OLD.asset_id,
    OLD.request_hash, OLD.request_json, OLD.method, OLD.network, OLD.token,
    OLD.payer_wallet, OLD.payee_wallet, OLD.amount_units, OLD.x402_nonce,
    OLD.x402_payload_digest, OLD.x402_valid_after, OLD.x402_valid_before,
    OLD.start_block, OLD.start_time, OLD.end_time, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'payment attempt terms are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.recovery_started_at IS NOT NULL AND ROW(
    NEW.recovery_started_at, NEW.recovery_deadline_at
  ) IS DISTINCT FROM ROW(
    OLD.recovery_started_at, OLD.recovery_deadline_at
  ) THEN
    RAISE EXCEPTION 'payment recovery window is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.recovery_started_at IS NOT NULL
    AND NEW.recovery_deadline_at IS DISTINCT FROM
      NEW.recovery_started_at + interval '2 hours' THEN
    RAISE EXCEPTION 'payment recovery deadline is invalid' USING ERRCODE = '55000';
  END IF;

  IF OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash THEN
    RAISE EXCEPTION 'payment attempt transaction is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.finalized_block_number IS NOT NULL AND ROW(
    NEW.finalized_block_number, NEW.finalized_block_hash,
    NEW.finalized_block_time, NEW.finalized_at
  ) IS DISTINCT FROM ROW(
    OLD.finalized_block_number, OLD.finalized_block_hash,
    OLD.finalized_block_time, OLD.finalized_at
  ) THEN
    RAISE EXCEPTION 'payment attempt finality is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.response_json #>> '{__1f3d9_x402_response_v1,header}' IS NOT NULL
    AND NEW.response_json #>> '{__1f3d9_x402_response_v1,header}' IS DISTINCT FROM
      OLD.response_json #>> '{__1f3d9_x402_response_v1,header}' THEN
    RAISE EXCEPTION 'payment facilitator response is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN (
    'completed', 'invalid', 'founder_review', 'legacy_completed', 'credit_returned'
  ) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal payment attempt is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'expired' THEN
    IF NOT (
      NEW.status = 'founder_review'
      AND OLD.method = 'x402'
      AND NEW.tx_hash IS NOT NULL
      AND (OLD.tx_hash IS NULL OR NEW.tx_hash = OLD.tx_hash)
      AND NEW.finalized_block_number IS NOT NULL
      AND NEW.finalized_block_hash IS NOT NULL
      AND NEW.finalized_block_time IS NOT NULL
      AND NEW.finalized_at IS NOT NULL
      AND (
        (
          OLD.finalized_block_number IS NULL
          AND OLD.finalized_block_hash IS NULL
          AND OLD.finalized_block_time IS NULL
          AND OLD.finalized_at IS NULL
        )
        OR ROW(
          NEW.finalized_block_number, NEW.finalized_block_hash,
          NEW.finalized_block_time, NEW.finalized_at
        ) IS NOT DISTINCT FROM ROW(
          OLD.finalized_block_number, OLD.finalized_block_hash,
          OLD.finalized_block_time, OLD.finalized_at
        )
      )
      AND (
        (OLD.invalid_reason IS NOT NULL AND NEW.invalid_reason = OLD.invalid_reason)
        OR (OLD.invalid_reason IS NULL AND NEW.invalid_reason IS NOT NULL)
      )
      AND NEW.lease_owner IS NULL
      AND NEW.lease_expires_at IS NULL
      AND (
        to_jsonb(NEW) - ARRAY[
          'status', 'tx_hash', 'finalized_block_number', 'finalized_block_hash',
          'finalized_block_time', 'finalized_at', 'invalid_reason', 'updated_at'
        ]
      ) IS NOT DISTINCT FROM (
        to_jsonb(OLD) - ARRAY[
          'status', 'tx_hash', 'finalized_block_number', 'finalized_block_hash',
          'finalized_block_time', 'finalized_at', 'invalid_reason', 'updated_at'
        ]
      )
    ) THEN
      RAISE EXCEPTION 'expired payment attempt history is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'payment attempt update time cannot move backward'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'settling' AND NEW.status IN (
      'settling', 'payment_pending', 'invalid', 'expired', 'needs_review', 'founder_review'
    ))
    OR (OLD.status = 'payment_pending' AND NEW.status IN (
      'payment_pending', 'completed', 'invalid', 'expired', 'needs_review', 'founder_review'
    ))
    OR (OLD.status = 'needs_review' AND NEW.status IN (
      'needs_review', 'payment_pending', 'completed', 'invalid', 'expired', 'founder_review'
    ))
    OR (
      OLD.method = 'credit'
      AND OLD.status IN ('settling', 'payment_pending')
      AND NEW.status IN ('completed', 'credit_returned')
    )
    OR (OLD.status = NEW.status)
  ) THEN
    RAISE EXCEPTION 'invalid payment attempt transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'payment attempt update time cannot move backward' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS payment_attempts_keep_history ON payment_attempts;
CREATE TRIGGER payment_attempts_keep_history BEFORE UPDATE OR DELETE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION protect_payment_attempt_history();

CREATE OR REPLACE FUNCTION protect_transfer_offer_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reservation_changed BOOLEAN;
  reservation_started_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transfer offers are retained as history' USING ERRCODE = '55000';
  END IF;

  IF OLD.channel IS DISTINCT FROM NEW.channel
    OR OLD.asset_type IS DISTINCT FROM NEW.asset_type
    OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
    OR OLD.seller_id IS DISTINCT FROM NEW.seller_id
    OR OLD.price_usdc IS DISTINCT FROM NEW.price_usdc
    OR OLD.seller_wallet IS DISTINCT FROM NEW.seller_wallet
    OR OLD.market_origin IS DISTINCT FROM NEW.market_origin
    OR OLD.market_draft_id IS DISTINCT FROM NEW.market_draft_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'transfer offer terms are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.channel = 'direct' AND (
    OLD.buyer_id IS DISTINCT FROM NEW.buyer_id
    OR OLD.market_listing_id IS DISTINCT FROM NEW.market_listing_id
    OR OLD.market_checkout_id IS DISTINCT FROM NEW.market_checkout_id
  ) THEN
    RAISE EXCEPTION 'direct transfer buyer and market state are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'open' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a closed transfer offer is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.pending_x402_tx_hash IS NOT NULL AND (
    OLD.pending_x402_tx_hash IS DISTINCT FROM NEW.pending_x402_tx_hash
    OR OLD.pending_x402_payer IS DISTINCT FROM NEW.pending_x402_payer
    OR OLD.pending_x402_at IS DISTINCT FROM NEW.pending_x402_at
  ) THEN
    RAISE EXCEPTION 'pending x402 settlement evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.x402_evidence_state = 'pending' AND NEW.x402_evidence_state = 'invalid' THEN
    IF NEW.x402_invalid_reason NOT IN ('failed_transaction', 'confirmed_mismatch') THEN
      RAISE EXCEPTION 'invalid x402 evidence needs a conclusive public-chain reason'
        USING ERRCODE = '23514';
    END IF;
    NEW.x402_invalid_at := COALESCE(NEW.x402_invalid_at, clock_timestamp());
  ELSIF OLD.x402_evidence_state IS DISTINCT FROM NEW.x402_evidence_state
    OR OLD.x402_invalid_reason IS DISTINCT FROM NEW.x402_invalid_reason
    OR OLD.x402_invalid_at IS DISTINCT FROM NEW.x402_invalid_at THEN
    RAISE EXCEPTION 'x402 evidence state is immutable except pending to invalid'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.pending_x402_tx_hash IS NULL AND NEW.pending_x402_tx_hash IS NOT NULL THEN
    IF OLD.channel <> 'world' OR OLD.status <> 'open'
      OR OLD.reserved_by IS DISTINCT FROM OLD.buyer_id
      OR OLD.buyer_wallet IS NULL OR NEW.pending_x402_payer IS DISTINCT FROM OLD.buyer_wallet
      OR OLD.reserved_at IS NULL OR OLD.reserved_until IS NULL
      OR NEW.pending_payment_attempt_id IS NULL THEN
      RAISE EXCEPTION 'pending x402 evidence requires the buyer-bound world reservation'
        USING ERRCODE = '55000';
    END IF;
    PERFORM 1
    FROM payment_attempts AS attempt
    WHERE attempt.public_id = NEW.pending_payment_attempt_id
      AND attempt.actor_id = OLD.buyer_id
      AND attempt.counterparty_id = OLD.seller_id
      AND attempt.operation = 'world_sale'
      AND attempt.offer_id = OLD.id
      AND attempt.asset_type = OLD.asset_type
      AND attempt.asset_id = OLD.asset_id
      AND attempt.status = 'payment_pending'
      AND attempt.tx_hash = NEW.pending_x402_tx_hash
      AND attempt.payer_wallet = NEW.pending_x402_payer
      AND attempt.payee_wallet = OLD.seller_wallet
      AND attempt.amount_units = (OLD.price_usdc * 1000000)::bigint
      AND attempt.start_time >= (
        date_trunc('second', OLD.reserved_at)
        + CASE WHEN OLD.reserved_at > date_trunc('second', OLD.reserved_at)
          THEN interval '1 second' ELSE interval '0 seconds' END
      )
      AND attempt.end_time <= date_trunc('second', OLD.reserved_until)
      AND (
        attempt.finalized_block_time IS NULL
        OR (
          attempt.finalized_block_time >= attempt.start_time
          AND attempt.finalized_block_time < attempt.end_time
        )
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pending x402 evidence does not match its durable payment attempt'
        USING ERRCODE = '55000';
    END IF;
    NEW.x402_evidence_state := 'pending';
    NEW.pending_x402_at := COALESCE(NEW.pending_x402_at, clock_timestamp());
  END IF;

  reservation_changed :=
    NEW.reserved_by IS DISTINCT FROM OLD.reserved_by
    OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
    OR NEW.reserved_until IS DISTINCT FROM OLD.reserved_until
    OR NEW.buyer_wallet IS DISTINCT FROM OLD.buyer_wallet
    OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
    OR NEW.market_listing_id IS DISTINCT FROM OLD.market_listing_id
    OR NEW.market_checkout_id IS DISTINCT FROM OLD.market_checkout_id
    OR NEW.market_buyer IS DISTINCT FROM OLD.market_buyer;

  IF OLD.pending_x402_tx_hash IS NOT NULL AND reservation_changed THEN
    RAISE EXCEPTION 'pending x402 reservation is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'open' AND reservation_changed THEN
    IF EXISTS (
      SELECT 1 FROM payment_attempts AS attempt
      WHERE attempt.offer_id = OLD.id
        AND attempt.operation IN ('direct_sale', 'world_sale')
        AND attempt.status IN ('settling', 'payment_pending', 'needs_review')
    ) THEN
      RAISE EXCEPTION 'a live payment attempt keeps its transfer reservation'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.reserved_until IS NOT NULL AND OLD.reserved_until > clock_timestamp() THEN
      RAISE EXCEPTION 'an active transfer reservation is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.buyer_wallet IS NULL OR NEW.buyer_id IS NULL THEN
      RAISE EXCEPTION 'a transfer reservation requires a buyer and wallet' USING ERRCODE = '23514';
    END IF;
    IF NEW.channel = 'world'
      AND (NEW.market_listing_id IS NULL OR NEW.market_checkout_id IS NULL) THEN
      RAISE EXCEPTION 'a world reservation requires market listing and checkout ids'
        USING ERRCODE = '23514';
    END IF;

    reservation_started_at := clock_timestamp();
    NEW.reserved_by := NEW.buyer_id;
    NEW.reserved_at := reservation_started_at;
    NEW.reserved_until := reservation_started_at + interval '5 minutes';
  ELSIF OLD.status = 'open' AND NEW.status <> 'open' AND reservation_changed THEN
    RAISE EXCEPTION 'transfer reservation history is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'claimed' AND OLD.status = 'open' THEN
    IF OLD.buyer_id IS NULL OR OLD.reserved_by IS DISTINCT FROM OLD.buyer_id
      OR OLD.buyer_wallet IS NULL OR OLD.reserved_at IS NULL OR OLD.reserved_until IS NULL
      OR OLD.reserved_at > clock_timestamp()
      OR (OLD.reserved_until <= clock_timestamp() AND OLD.x402_evidence_state <> 'pending') THEN
      RAISE EXCEPTION 'a claim requires an active buyer-bound reservation'
        USING ERRCODE = '55000';
    END IF;
    NEW.claimed_at := COALESCE(NEW.claimed_at, clock_timestamp());
    NEW.canceled_at := NULL;
  ELSIF NEW.status = 'canceled' AND OLD.status = 'open' THEN
    IF OLD.x402_evidence_state <> 'invalid' AND (
      OLD.x402_evidence_state = 'pending'
      OR (OLD.reserved_until IS NOT NULL AND OLD.reserved_until > clock_timestamp())
      OR EXISTS (
        SELECT 1 FROM payment_attempts AS attempt
        WHERE attempt.offer_id = OLD.id
          AND attempt.operation IN ('direct_sale', 'world_sale')
          AND attempt.status IN ('settling', 'payment_pending', 'needs_review')
      )
    ) THEN
      RAISE EXCEPTION 'an active reservation or pending x402 settlement cannot be canceled'
        USING ERRCODE = '55000';
    END IF;
    NEW.canceled_at := COALESCE(NEW.canceled_at, clock_timestamp());
    NEW.claimed_at := NULL;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'invalid transfer offer transition' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS transfer_offers_keep_history ON transfer_offers;
CREATE TRIGGER transfer_offers_keep_history BEFORE UPDATE OR DELETE ON transfer_offers
  FOR EACH ROW EXECUTE FUNCTION protect_transfer_offer_history();

CREATE OR REPLACE FUNCTION complete_payment_attempt(
  attempt_id TEXT,
  expected_lease_owner TEXT,
  completion_result JSONB,
  completion_response_status SMALLINT,
  completion_response JSONB
) RETURNS payment_attempts LANGUAGE plpgsql AS $$
DECLARE
  completed payment_attempts%ROWTYPE;
BEGIN
  UPDATE payment_attempts
  SET status = 'completed',
    result_json = completion_result,
    response_status = completion_response_status,
    response_json = completion_response,
    completed_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
  WHERE public_id = attempt_id
    AND lease_owner = expected_lease_owner
    AND status = 'payment_pending'
    AND tx_hash IS NOT NULL
    AND finalized_block_number IS NOT NULL
    AND finalized_block_hash IS NOT NULL
    AND finalized_block_time IS NOT NULL
    AND finalized_at IS NOT NULL
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalized payment attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;

CREATE OR REPLACE FUNCTION validate_payment_use_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  expected_amount BIGINT;
  expected_purpose TEXT;
BEGIN
  expected_amount := CASE WHEN NEW.amount_usdc IS NULL THEN NULL
    ELSE (NEW.amount_usdc * 1000000)::bigint END;
  SELECT * INTO attempt
  FROM payment_attempts
  WHERE public_id = NEW.payment_attempt_id AND tx_hash = NEW.tx_hash;

  IF NOT FOUND
    OR attempt.status NOT IN ('completed', 'legacy_completed')
    OR attempt.actor_id <> NEW.actor_id
    OR attempt.payer_wallet IS DISTINCT FROM lower(NEW.payer_wallet)
    OR attempt.payee_wallet IS DISTINCT FROM lower(NEW.payee_wallet)
    OR attempt.amount_units IS DISTINCT FROM expected_amount THEN
    RAISE EXCEPTION 'payment use does not match its finalized attempt'
      USING ERRCODE = '23514';
  END IF;
  expected_purpose := CASE
    WHEN attempt.operation IN ('direct_sale', 'world_sale') THEN 'sale'
    ELSE attempt.operation
  END;
  IF attempt.operation <> 'legacy' AND NEW.purpose <> expected_purpose THEN
    RAISE EXCEPTION 'payment use does not match its finalized attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS payment_uses_match_attempt ON payment_uses;
CREATE CONSTRAINT TRIGGER payment_uses_match_attempt AFTER INSERT ON payment_uses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_payment_use_attempt();

CREATE OR REPLACE FUNCTION validate_fee_payment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
BEGIN
  SELECT payment_attempts.* INTO attempt
  FROM payment_uses
  JOIN payment_attempts
    ON payment_attempts.public_id = payment_uses.payment_attempt_id
    AND payment_attempts.tx_hash = payment_uses.tx_hash
  WHERE payment_uses.tx_hash = NEW.tx_hash;

  IF NOT FOUND OR (
    attempt.status <> 'legacy_completed'
    AND (
      attempt.status <> 'completed'
      OR attempt.method <> 'x402'
      OR attempt.actor_id <> NEW.resident_id
      OR attempt.counterparty_id IS NOT NULL
      OR attempt.operation <> NEW.purpose
      OR attempt.offer_id IS NOT NULL
      OR attempt.amount_units <> (NEW.amount_usdc * 1000000)::bigint
    )
  ) THEN
    RAISE EXCEPTION 'fee does not match its finalized payment attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS fees_match_payment_attempt ON fees;
CREATE CONSTRAINT TRIGGER fees_match_payment_attempt AFTER INSERT ON fees
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_fee_payment_attempt();

CREATE OR REPLACE FUNCTION validate_sale_payment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  sale_offer transfer_offers%ROWTYPE;
  expected_operation TEXT;
BEGIN
  SELECT payment_attempts.* INTO attempt
  FROM payment_uses
  JOIN payment_attempts
    ON payment_attempts.public_id = payment_uses.payment_attempt_id
    AND payment_attempts.tx_hash = payment_uses.tx_hash
  WHERE payment_uses.tx_hash = NEW.tx_hash;
  SELECT * INTO sale_offer FROM transfer_offers WHERE id = NEW.offer_id;
  expected_operation := CASE sale_offer.channel
    WHEN 'direct' THEN 'direct_sale' ELSE 'world_sale' END;

  IF attempt.public_id IS NULL OR sale_offer.id IS NULL
    OR attempt.status <> 'completed'
    OR attempt.method <> 'x402'
    OR NEW.verified_via <> 'x402'
    OR sale_offer.status <> 'claimed'
    OR attempt.operation <> expected_operation
    OR attempt.offer_id <> sale_offer.id
    OR attempt.asset_type <> sale_offer.asset_type
    OR attempt.asset_id <> sale_offer.asset_id
    OR attempt.actor_id <> NEW.buyer_id
    OR attempt.counterparty_id <> sale_offer.seller_id
    OR attempt.payer_wallet <> lower(NEW.payer_wallet)
    OR attempt.payee_wallet <> lower(NEW.payee_wallet)
    OR attempt.amount_units <> (NEW.amount_usdc * 1000000)::bigint
    OR attempt.finalized_block_time IS DISTINCT FROM NEW.block_time THEN
    RAISE EXCEPTION 'sale does not match its finalized payment attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS sale_payments_match_attempt ON sale_payments;
CREATE CONSTRAINT TRIGGER sale_payments_match_attempt AFTER INSERT ON sale_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_sale_payment_attempt();

CREATE TRIGGER payment_uses_append_only BEFORE UPDATE OR DELETE ON payment_uses
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

-- Base reports block timestamps at whole-second precision. Normalize the
-- fractional database reservation inward before applying the half-open window,
-- so neither boundary admits a chain second outside the real reservation.
CREATE OR REPLACE FUNCTION validate_world_sale_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  world_offer transfer_offers%ROWTYPE;
BEGIN
  SELECT * INTO world_offer FROM transfer_offers WHERE id = NEW.offer_id;
  IF NOT FOUND OR world_offer.channel <> 'world' THEN
    RETURN NEW;
  END IF;

  IF world_offer.status <> 'claimed'
    OR world_offer.buyer_id IS NULL OR world_offer.buyer_id <> NEW.buyer_id
    OR world_offer.reserved_by IS DISTINCT FROM world_offer.buyer_id
    OR world_offer.buyer_wallet IS NULL
    OR lower(NEW.payer_wallet) IS DISTINCT FROM lower(world_offer.buyer_wallet)
    OR lower(NEW.payee_wallet) IS DISTINCT FROM lower(world_offer.seller_wallet)
    OR NEW.amount_usdc IS DISTINCT FROM world_offer.price_usdc
    OR NEW.block_time IS NULL
    OR NEW.block_time < (
      date_trunc('second', world_offer.reserved_at)
      + CASE
        WHEN world_offer.reserved_at > date_trunc('second', world_offer.reserved_at)
          THEN interval '1 second'
        ELSE interval '0 seconds'
      END
    )
    OR NEW.block_time >= date_trunc('second', world_offer.reserved_until)
    OR (
      NEW.verified_via = 'x402'
      AND (
        world_offer.x402_evidence_state <> 'pending'
        OR
        world_offer.pending_x402_tx_hash IS DISTINCT FROM NEW.tx_hash
        OR lower(world_offer.pending_x402_payer) IS DISTINCT FROM lower(NEW.payer_wallet)
      )
    )
    OR (NEW.verified_via = 'claim' AND world_offer.pending_x402_tx_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'world sale payment does not match its buyer reservation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS sale_payments_match_world_offer ON sale_payments;
CREATE TRIGGER sale_payments_match_world_offer BEFORE INSERT ON sale_payments
  FOR EACH ROW EXECUTE FUNCTION validate_world_sale_payment();
