-- Once captured, the facilitator response cannot be replaced or removed.
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

  IF OLD.status IN ('completed', 'invalid', 'expired', 'legacy_completed')
    AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal payment attempt is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.status = 'settling' AND NEW.status IN (
      'settling', 'payment_pending', 'invalid', 'expired', 'needs_review'
    ))
    OR (OLD.status = 'payment_pending' AND NEW.status IN (
      'payment_pending', 'completed', 'invalid', 'needs_review'
    ))
    OR (OLD.status = 'needs_review' AND NEW.status IN (
      'needs_review', 'payment_pending', 'completed', 'invalid'
    ))
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

-- Preserve the exact X-PAYMENT-RESPONSE bytes already held in response_json
-- when an existing durable payment attempt becomes complete.
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
    AND jsonb_typeof(completion_response) = 'object'
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalized payment attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;
