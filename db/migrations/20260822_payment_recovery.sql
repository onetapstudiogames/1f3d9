-- Add a fixed recovery window without rewriting payment or credit history.
ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS recovery_started_at TIMESTAMPTZ;
ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS recovery_deadline_at TIMESTAMPTZ;

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_status_check CHECK (status IN (
    'settling', 'payment_pending', 'completed', 'invalid', 'expired',
    'needs_review', 'founder_review', 'legacy_completed', 'credit_returned'
  ));

-- Existing live rows predate an exact first-evidence timestamp. updated_at is
-- the latest defensible anchor and therefore gives them the most conservative
-- recovery window; created_at is retained as a non-null fallback.
UPDATE payment_attempts
SET recovery_started_at = coalesce(recovery_started_at, updated_at, created_at),
    recovery_deadline_at = coalesce(
      recovery_deadline_at,
      coalesce(recovery_started_at, updated_at, created_at) + interval '2 hours'
    )
WHERE method IN ('x402', 'credit')
  AND status IN ('settling', 'payment_pending', 'needs_review')
  AND (recovery_started_at IS NULL OR recovery_deadline_at IS NULL);

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_recovery_window_valid;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_recovery_window_valid CHECK (
    (recovery_started_at IS NULL AND recovery_deadline_at IS NULL)
    OR (
      recovery_started_at IS NOT NULL
      AND recovery_deadline_at = recovery_started_at + interval '2 hours'
    )
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_recovery_required;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_recovery_required CHECK (
    method IS DISTINCT FROM 'credit'
    OR (recovery_started_at IS NOT NULL AND recovery_deadline_at IS NOT NULL)
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_x402_live_recovery_required;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_x402_live_recovery_required CHECK (
    method IS DISTINCT FROM 'x402'
    OR status NOT IN ('settling', 'payment_pending', 'needs_review')
    OR (tx_hash IS NULL AND status <> 'needs_review')
    OR (recovery_started_at IS NOT NULL AND recovery_deadline_at IS NOT NULL)
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_terminal_lease_clear;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_terminal_lease_clear CHECK (
    status NOT IN (
      'completed', 'invalid', 'expired', 'founder_review',
      'legacy_completed', 'credit_returned'
    )
    OR (lease_owner IS NULL AND lease_expires_at IS NULL)
  );

CREATE OR REPLACE FUNCTION initialize_payment_recovery_window()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  should_start BOOLEAN;
BEGIN
  should_start := (
    NEW.method = 'credit'
    OR (
      NEW.method = 'x402'
      AND (NEW.tx_hash IS NOT NULL OR NEW.status = 'needs_review')
    )
  );

  IF TG_OP = 'UPDATE' AND OLD.recovery_started_at IS NOT NULL
    AND ROW(NEW.recovery_started_at, NEW.recovery_deadline_at) IS DISTINCT FROM
      ROW(OLD.recovery_started_at, OLD.recovery_deadline_at) THEN
    RAISE EXCEPTION 'payment recovery window is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.recovery_started_at IS NULL AND NEW.recovery_deadline_at IS NULL
    AND should_start THEN
    NEW.recovery_started_at := statement_timestamp();
    NEW.recovery_deadline_at := NEW.recovery_started_at + interval '2 hours';
  END IF;

  IF (NEW.recovery_started_at IS NULL) <> (NEW.recovery_deadline_at IS NULL)
    OR (
      NEW.recovery_started_at IS NOT NULL
      AND NEW.recovery_deadline_at IS DISTINCT FROM
        NEW.recovery_started_at + interval '2 hours'
    ) THEN
    RAISE EXCEPTION 'payment recovery deadline must be exactly two hours after recovery starts'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.recovery_started_at IS NULL
    AND NEW.recovery_started_at IS NOT NULL
    AND NOT should_start THEN
    RAISE EXCEPTION 'payment recovery cannot start without payment evidence or credit custody'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payment_attempts_initialize_recovery_window ON payment_attempts;
CREATE TRIGGER payment_attempts_initialize_recovery_window
  BEFORE INSERT OR UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION initialize_payment_recovery_window();

CREATE INDEX IF NOT EXISTS payment_attempts_recovery_due
  ON payment_attempts (recovery_deadline_at, updated_at, public_id)
  WHERE status IN ('settling', 'payment_pending', 'needs_review')
    AND recovery_deadline_at IS NOT NULL;

COMMENT ON COLUMN payment_attempts.recovery_started_at IS
  'Immutable start of bounded automatic recovery: first x402 transaction evidence, first ambiguous review, or credit custody';
COMMENT ON COLUMN payment_attempts.recovery_deadline_at IS
  'Immutable recovery_started_at plus exactly two hours; independent from short processing leases';

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

ALTER TABLE transfer_offers
  DROP CONSTRAINT IF EXISTS transfer_offers_pending_x402_state;
ALTER TABLE transfer_offers
  ADD CONSTRAINT transfer_offers_pending_x402_state CHECK (
    (
      x402_evidence_state = 'none'
      AND pending_payment_attempt_id IS NULL
      AND pending_x402_tx_hash IS NULL
      AND pending_x402_payer IS NULL
      AND pending_x402_at IS NULL
      AND x402_invalid_reason IS NULL
      AND x402_invalid_at IS NULL
    )
    OR (
      channel = 'world'
      AND pending_payment_attempt_id IS NOT NULL
      AND pending_x402_tx_hash ~ '^0x[0-9a-f]{64}$'
      AND pending_x402_payer ~ '^0x[0-9a-f]{40}$'
      AND pending_x402_payer = buyer_wallet
      AND pending_x402_at IS NOT NULL
      AND buyer_id IS NOT NULL
      AND reserved_by = buyer_id
      AND reserved_at IS NOT NULL
      AND reserved_until IS NOT NULL
      AND market_listing_id IS NOT NULL
      AND market_checkout_id IS NOT NULL
      AND (
        (
          x402_evidence_state IN ('pending', 'expired', 'founder_review')
          AND x402_invalid_reason IS NULL
          AND x402_invalid_at IS NULL
        )
        OR (
          x402_evidence_state = 'invalid'
          AND x402_invalid_reason IN ('failed_transaction', 'confirmed_mismatch')
          AND x402_invalid_at IS NOT NULL
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION protect_transfer_offer_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reservation_changed BOOLEAN;
  reservation_started_at TIMESTAMPTZ;
  delayed_direct_claim BOOLEAN := FALSE;
  terminal_direct_cancel BOOLEAN := FALSE;
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
  ELSIF OLD.x402_evidence_state = 'pending'
    AND NEW.x402_evidence_state IN ('expired', 'founder_review') THEN
    IF NEW.x402_invalid_reason IS NOT NULL OR NEW.x402_invalid_at IS NOT NULL THEN
      RAISE EXCEPTION 'terminal x402 recovery evidence is not an invalid payment'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
    FROM payment_attempts AS attempt
    WHERE attempt.public_id = OLD.pending_payment_attempt_id
      AND attempt.offer_id = OLD.id
      AND attempt.operation = 'world_sale'
      AND attempt.tx_hash = OLD.pending_x402_tx_hash
      AND attempt.status = NEW.x402_evidence_state;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'terminal x402 offer evidence must match its payment attempt'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.x402_evidence_state = 'none'
    AND NEW.x402_evidence_state IN ('expired', 'founder_review') THEN
    IF NEW.pending_payment_attempt_id IS NULL
      OR NEW.pending_x402_tx_hash IS NULL
      OR NEW.pending_x402_payer IS NULL
      OR NEW.pending_x402_at IS NULL
      OR NEW.x402_invalid_reason IS NOT NULL
      OR NEW.x402_invalid_at IS NOT NULL THEN
      RAISE EXCEPTION 'terminal x402 recovery requires complete preserved evidence'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
    FROM payment_attempts AS attempt
    WHERE attempt.public_id = NEW.pending_payment_attempt_id
      AND attempt.actor_id = OLD.buyer_id
      AND attempt.counterparty_id = OLD.seller_id
      AND attempt.offer_id = OLD.id
      AND attempt.operation = 'world_sale'
      AND attempt.tx_hash = NEW.pending_x402_tx_hash
      AND attempt.payer_wallet = NEW.pending_x402_payer
      AND attempt.status = NEW.x402_evidence_state;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'terminal x402 offer evidence must match its payment attempt'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.x402_evidence_state IS DISTINCT FROM NEW.x402_evidence_state
    OR OLD.x402_invalid_reason IS DISTINCT FROM NEW.x402_invalid_reason
    OR OLD.x402_invalid_at IS DISTINCT FROM NEW.x402_invalid_at THEN
    RAISE EXCEPTION 'x402 evidence state is immutable except a pending terminal decision'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.pending_x402_tx_hash IS NULL AND NEW.pending_x402_tx_hash IS NOT NULL
    AND NEW.x402_evidence_state NOT IN ('expired', 'founder_review') THEN
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
    IF OLD.channel = 'direct'
      AND OLD.x402_evidence_state = 'none'
      AND OLD.reserved_until IS NOT NULL
      AND OLD.reserved_until <= clock_timestamp() THEN
      SELECT EXISTS (
        SELECT 1
        FROM payment_attempts AS attempt
        WHERE attempt.offer_id = OLD.id
          AND attempt.operation = 'direct_sale'
          AND attempt.method = 'x402'
          AND attempt.status = 'payment_pending'
          AND attempt.actor_id = OLD.buyer_id
          AND attempt.counterparty_id = OLD.seller_id
          AND attempt.target_key = 'direct-sale:' || OLD.id::text
          AND attempt.asset_type = OLD.asset_type
          AND attempt.asset_id = OLD.asset_id
          AND attempt.network = 'base'
          AND attempt.token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
          AND attempt.payer_wallet = lower(OLD.buyer_wallet)
          AND attempt.payee_wallet = lower(OLD.seller_wallet)
          AND attempt.amount_units = (OLD.price_usdc * 1000000)::bigint
          AND attempt.request_json = jsonb_build_object(
            'offer_id', OLD.id,
            'buyer_wallet', lower(OLD.buyer_wallet),
            'seller_wallet', lower(OLD.seller_wallet),
            'price_usdc', OLD.price_usdc,
            'asset_type', OLD.asset_type,
            'asset_id', OLD.asset_id
          )
          AND attempt.lease_owner IS NOT NULL
          AND attempt.lease_expires_at > clock_timestamp()
          AND attempt.recovery_deadline_at IS NOT NULL
          AND attempt.recovery_deadline_at > clock_timestamp()
          AND attempt.tx_hash IS NOT NULL
          AND attempt.finalized_block_number IS NOT NULL
          AND attempt.finalized_block_hash IS NOT NULL
          AND attempt.finalized_block_time IS NOT NULL
          AND attempt.finalized_at IS NOT NULL
          AND attempt.start_time IS NOT NULL
          AND attempt.end_time IS NOT NULL
          AND attempt.finalized_block_time >= attempt.start_time
          AND attempt.finalized_block_time < attempt.end_time
          AND attempt.finalized_block_time >= (
            date_trunc('second', OLD.reserved_at)
            + CASE WHEN OLD.reserved_at > date_trunc('second', OLD.reserved_at)
              THEN interval '1 second' ELSE interval '0 seconds' END
          )
          AND attempt.finalized_block_time < date_trunc('second', OLD.reserved_until)
      ) INTO delayed_direct_claim;
    END IF;
    IF OLD.buyer_id IS NULL OR OLD.reserved_by IS DISTINCT FROM OLD.buyer_id
      OR OLD.buyer_wallet IS NULL OR OLD.reserved_at IS NULL OR OLD.reserved_until IS NULL
      OR OLD.reserved_at > clock_timestamp()
      OR (
        OLD.reserved_until <= clock_timestamp()
        AND OLD.x402_evidence_state <> 'pending'
        AND NOT delayed_direct_claim
      ) THEN
      RAISE EXCEPTION 'a claim requires an active buyer-bound reservation'
        USING ERRCODE = '55000';
    END IF;
    NEW.claimed_at := COALESCE(NEW.claimed_at, clock_timestamp());
    NEW.canceled_at := NULL;
  ELSIF NEW.status = 'canceled' AND OLD.status = 'open' THEN
    IF OLD.channel = 'direct' AND OLD.x402_evidence_state = 'none' THEN
      SELECT EXISTS (
        SELECT 1
        FROM payment_attempts AS attempt
        WHERE attempt.offer_id = OLD.id
          AND attempt.operation = 'direct_sale'
          AND attempt.method = 'x402'
          AND attempt.status IN ('invalid', 'expired', 'founder_review')
          AND attempt.invalid_reason IS NOT NULL
          AND attempt.actor_id = OLD.buyer_id
          AND attempt.counterparty_id = OLD.seller_id
          AND attempt.target_key = 'direct-sale:' || OLD.id::text
          AND attempt.asset_type = OLD.asset_type
          AND attempt.asset_id = OLD.asset_id
          AND attempt.network = 'base'
          AND attempt.token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
          AND attempt.payer_wallet = lower(OLD.buyer_wallet)
          AND attempt.payee_wallet = lower(OLD.seller_wallet)
          AND attempt.amount_units = (OLD.price_usdc * 1000000)::bigint
          AND attempt.request_json = jsonb_build_object(
            'offer_id', OLD.id,
            'buyer_wallet', lower(OLD.buyer_wallet),
            'seller_wallet', lower(OLD.seller_wallet),
            'price_usdc', OLD.price_usdc,
            'asset_type', OLD.asset_type,
            'asset_id', OLD.asset_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM payment_attempts AS live_attempt
            WHERE live_attempt.offer_id = OLD.id
              AND live_attempt.operation = 'direct_sale'
              AND live_attempt.status IN ('settling', 'payment_pending', 'needs_review')
          )
      ) INTO terminal_direct_cancel;
    END IF;
    IF NOT terminal_direct_cancel
      AND OLD.x402_evidence_state NOT IN ('invalid', 'expired', 'founder_review') AND (
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
  completion_response JSONB,
  completion_response_body BYTEA
) RETURNS payment_attempts LANGUAGE plpgsql AS $$
DECLARE
  completed payment_attempts%ROWTYPE;
  decoded_response JSONB;
BEGIN
  IF completion_response_body IS NULL
    OR octet_length(completion_response_body) NOT BETWEEN 2 AND 200000 THEN
    RAISE EXCEPTION 'payment response body is outside its byte limit'
      USING ERRCODE = '23514';
  END IF;
  BEGIN
    decoded_response := convert_from(completion_response_body, 'UTF8')::jsonb;
  EXCEPTION
    WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
      RAISE EXCEPTION 'payment response body is not valid UTF-8 JSON'
        USING ERRCODE = '23514';
  END;
  IF jsonb_typeof(decoded_response) <> 'object'
    OR decoded_response IS DISTINCT FROM completion_response THEN
    RAISE EXCEPTION 'payment response body does not match its canonical response'
      USING ERRCODE = '23514';
  END IF;

  UPDATE payment_attempts
  SET status = 'completed',
    result_json = completion_result,
    response_status = completion_response_status,
    response_json = CASE
      WHEN response_json #>> '{__1f3d9_x402_response_v1,header}' IS NULL
        THEN completion_response
      ELSE jsonb_build_object(
        '__1f3d9_x402_response_v1',
        jsonb_build_object(
          'header', response_json #>> '{__1f3d9_x402_response_v1,header}',
          'body', completion_response
        )
      )
    END,
    response_body_bytes = completion_response_body,
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
    AND recovery_deadline_at IS NOT NULL
    AND recovery_deadline_at > clock_timestamp()
    AND jsonb_typeof(completion_response) = 'object'
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalized payment attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;

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
    response_json = CASE
      WHEN response_json #>> '{__1f3d9_x402_response_v1,header}' IS NULL
        THEN completion_response
      ELSE jsonb_build_object(
        '__1f3d9_x402_response_v1',
        jsonb_build_object(
          'header', response_json #>> '{__1f3d9_x402_response_v1,header}',
          'body', completion_response
        )
      )
    END,
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
    AND recovery_deadline_at IS NOT NULL
    AND recovery_deadline_at > clock_timestamp()
    AND jsonb_typeof(completion_response) = 'object'
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalized payment attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;

CREATE OR REPLACE FUNCTION complete_city_credit_attempt(
  attempt_id TEXT,
  expected_lease_owner TEXT,
  completion_result JSONB,
  completion_response_status SMALLINT,
  completion_response JSONB,
  completion_response_body BYTEA
) RETURNS payment_attempts LANGUAGE plpgsql AS $$
DECLARE
  completed payment_attempts%ROWTYPE;
  decoded_response JSONB;
BEGIN
  IF completion_response_body IS NULL
    OR octet_length(completion_response_body) NOT BETWEEN 2 AND 200000 THEN
    RAISE EXCEPTION 'city credit response body is outside its byte limit'
      USING ERRCODE = '23514';
  END IF;
  BEGIN
    decoded_response := convert_from(completion_response_body, 'UTF8')::jsonb;
  EXCEPTION
    WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
      RAISE EXCEPTION 'city credit response body is not valid UTF-8 JSON'
        USING ERRCODE = '23514';
  END;
  IF jsonb_typeof(completion_result) <> 'object'
    OR jsonb_typeof(completion_response) <> 'object'
    OR decoded_response IS DISTINCT FROM completion_response THEN
    RAISE EXCEPTION 'city credit response body does not match its canonical response'
      USING ERRCODE = '23514';
  END IF;

  UPDATE payment_attempts
  SET status = 'completed',
    result_json = completion_result,
    response_status = completion_response_status,
    response_json = completion_response,
    response_body_bytes = completion_response_body,
    completed_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
  WHERE public_id = attempt_id
    AND lease_owner = expected_lease_owner
    AND status IN ('settling', 'payment_pending')
    AND method = 'credit'
    AND recovery_deadline_at IS NOT NULL
    AND recovery_deadline_at > clock_timestamp()
    AND tx_hash IS NULL
    AND finalized_block_number IS NULL
    AND finalized_block_hash IS NULL
    AND finalized_block_time IS NULL
    AND finalized_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM city_credit_entries
      WHERE payment_attempt_id = attempt_id
        AND entry_kind = 'spend'
    )
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;
