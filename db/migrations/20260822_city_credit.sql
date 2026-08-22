BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- City fee credit is private, fixed-value city accounting. This migration
-- installs no balance and issues no credit.
LOCK TABLE residents, payment_attempts IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_method_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_method_check CHECK (
    method IS NULL OR method IN ('x402', 'claim', 'legacy', 'credit')
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_status_check CHECK (status IN (
    'settling', 'payment_pending', 'completed', 'invalid', 'expired',
    'needs_review', 'legacy_completed', 'credit_returned'
  ));

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_completed_facts;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_completed_facts CHECK (
    status <> 'completed' OR (
      result_json IS NOT NULL
      AND response_status IS NOT NULL
      AND response_json IS NOT NULL
      AND completed_at IS NOT NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND (
        (
          method = 'credit'
          AND tx_hash IS NULL
          AND finalized_block_number IS NULL
          AND finalized_block_hash IS NULL
          AND finalized_block_time IS NULL
          AND finalized_at IS NULL
        )
        OR
        (
          method IS DISTINCT FROM 'credit'
          AND tx_hash IS NOT NULL
          AND finalized_block_number IS NOT NULL
          AND finalized_block_hash IS NOT NULL
          AND finalized_block_time IS NOT NULL
          AND finalized_at IS NOT NULL
        )
      )
    )
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_credit_facts;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_credit_facts CHECK (
    method IS DISTINCT FROM 'credit' OR (
      operation IN ('frontier', 'kind_invention', 'kind_revision')
      AND target_key IS NOT NULL
      AND request_hash IS NOT NULL
      AND request_json IS NOT NULL
      AND amount_units = 1000000
      AND counterparty_id IS NULL
      AND offer_id IS NULL
      AND (
        (
          operation = 'kind_revision'
          AND asset_type = 'kind'
          AND asset_id IS NOT NULL
        )
        OR (
          operation IN ('frontier', 'kind_invention')
          AND asset_type IS NULL
          AND asset_id IS NULL
        )
      )
      AND network IS NULL
      AND token IS NULL
      AND payer_wallet IS NULL
      AND payee_wallet IS NULL
      AND x402_nonce IS NULL
      AND x402_payload_digest IS NULL
      AND x402_valid_after IS NULL
      AND x402_valid_before IS NULL
      AND start_block IS NULL
      AND start_time IS NULL
      AND end_time IS NULL
      AND tx_hash IS NULL
      AND finalized_block_number IS NULL
      AND finalized_block_hash IS NULL
      AND finalized_block_time IS NULL
      AND finalized_at IS NULL
      AND (status <> 'completed' OR response_body_bytes IS NOT NULL)
      AND status IN ('settling', 'payment_pending', 'completed', 'credit_returned')
    )
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_credit_returned_facts;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_credit_returned_facts CHECK (
    status <> 'credit_returned' OR (
      method = 'credit'
      AND invalid_reason IS NOT NULL
      AND result_json IS NOT NULL
      AND response_status IS NOT NULL
      AND response_json IS NOT NULL
      AND response_body_bytes IS NOT NULL
      AND completed_at IS NOT NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  );

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_response_body_bytes_valid;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_response_body_bytes_valid CHECK (
    response_body_bytes IS NULL OR (
      status IN ('completed', 'credit_returned')
      AND response_status IS NOT NULL
      AND response_json IS NOT NULL
      AND octet_length(response_body_bytes) BETWEEN 2 AND 200000
    )
  );

CREATE TABLE IF NOT EXISTS city_credit_accounts (
  resident_id   INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE RESTRICT,
  balance_units BIGINT NOT NULL DEFAULT 0 CHECK (balance_units >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS city_credit_entries (
  id                 BIGSERIAL PRIMARY KEY,
  resident_id        INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  entry_kind         TEXT NOT NULL CHECK (entry_kind IN (
                       'founder_issue', 'spend', 'return', 'admin_credit', 'admin_debit'
                     )),
  amount_units       BIGINT NOT NULL CHECK (amount_units = 1000000),
  founder_id         INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  payment_attempt_id TEXT REFERENCES payment_attempts(public_id) ON DELETE RESTRICT,
  related_spend_id   BIGINT REFERENCES city_credit_entries(id) ON DELETE RESTRICT,
  request_id         TEXT CHECK (
                       request_id IS NULL OR (
                         octet_length(request_id) BETWEEN 8 AND 128
                         AND request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
                       )
                     ),
  source_key         TEXT CHECK (
                       source_key IS NULL OR (
                         octet_length(source_key) BETWEEN 8 AND 160
                         AND source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
                       )
                     ),
  reason             TEXT CHECK (
                       reason IS NULL OR octet_length(reason) BETWEEN 1 AND 240
                     ),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (
      entry_kind IN ('founder_issue', 'admin_credit', 'admin_debit')
      AND founder_id = 1
      AND source_key IS NOT NULL
      AND request_id IS NULL
      AND payment_attempt_id IS NULL
      AND related_spend_id IS NULL
      AND reason IS NOT NULL
    )
    OR
    (
      entry_kind = 'spend'
      AND founder_id IS NULL
      AND source_key IS NULL
      AND request_id IS NOT NULL
      AND payment_attempt_id IS NOT NULL
      AND related_spend_id IS NULL
      AND reason IS NULL
    )
    OR
    (
      entry_kind = 'return'
      AND founder_id IS NULL
      AND source_key IS NULL
      AND request_id IS NULL
      AND payment_attempt_id IS NOT NULL
      AND related_spend_id IS NOT NULL
      AND reason IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_source_key
  ON city_credit_entries (source_key)
  WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_spend_request
  ON city_credit_entries (resident_id, request_id)
  WHERE entry_kind = 'spend';
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_one_spend_per_attempt
  ON city_credit_entries (payment_attempt_id)
  WHERE entry_kind = 'spend';
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_one_return_per_spend
  ON city_credit_entries (related_spend_id)
  WHERE entry_kind = 'return';
CREATE INDEX IF NOT EXISTS city_credit_entries_resident_history
  ON city_credit_entries (resident_id, id DESC);

CREATE OR REPLACE FUNCTION validate_city_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  related_spend city_credit_entries%ROWTYPE;
BEGIN
  IF NEW.entry_kind NOT IN ('spend', 'return') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO attempt
  FROM payment_attempts
  WHERE public_id = NEW.payment_attempt_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR attempt.method <> 'credit'
    OR attempt.method IS NULL
    OR attempt.actor_id <> NEW.resident_id
    OR attempt.amount_units <> NEW.amount_units
    OR attempt.operation NOT IN ('frontier', 'kind_invention', 'kind_revision')
    OR (
      NEW.entry_kind = 'spend'
      AND attempt.status NOT IN ('settling', 'payment_pending')
    )
    OR (
      NEW.entry_kind = 'return'
      AND attempt.status NOT IN ('settling', 'payment_pending', 'credit_returned')
    ) THEN
    RAISE EXCEPTION 'city credit entry does not match its live credit attempt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.entry_kind = 'return' THEN
    SELECT * INTO related_spend
    FROM city_credit_entries
    WHERE id = NEW.related_spend_id
    FOR KEY SHARE;
    IF NOT FOUND
      OR related_spend.entry_kind <> 'spend'
      OR related_spend.resident_id <> NEW.resident_id
      OR related_spend.amount_units <> NEW.amount_units
      OR related_spend.payment_attempt_id IS DISTINCT FROM NEW.payment_attempt_id THEN
      RAISE EXCEPTION 'city credit return does not match one exact spend'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS city_credit_entries_validate ON city_credit_entries;
CREATE TRIGGER city_credit_entries_validate
  BEFORE INSERT ON city_credit_entries
  FOR EACH ROW EXECUTE FUNCTION validate_city_credit_entry();

CREATE OR REPLACE FUNCTION protect_city_credit_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'city credit account is a ledger projection'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS city_credit_accounts_projection_only ON city_credit_accounts;
CREATE TRIGGER city_credit_accounts_projection_only
  BEFORE INSERT OR UPDATE OR DELETE ON city_credit_accounts
  FOR EACH ROW EXECUTE FUNCTION protect_city_credit_account();

CREATE OR REPLACE FUNCTION apply_city_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta_units BIGINT;
BEGIN
  delta_units := CASE
    WHEN NEW.entry_kind IN ('founder_issue', 'return', 'admin_credit')
      THEN NEW.amount_units
    ELSE -NEW.amount_units
  END;

  INSERT INTO city_credit_accounts (resident_id, balance_units)
  VALUES (NEW.resident_id, 0)
  ON CONFLICT (resident_id) DO NOTHING;

  UPDATE city_credit_accounts
  SET balance_units = balance_units + delta_units,
    updated_at = clock_timestamp()
  WHERE resident_id = NEW.resident_id
    AND balance_units + delta_units >= 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient city fee credit'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS city_credit_entries_apply_balance ON city_credit_entries;
CREATE TRIGGER city_credit_entries_apply_balance
  AFTER INSERT ON city_credit_entries
  FOR EACH ROW EXECUTE FUNCTION apply_city_credit_entry();

DROP TRIGGER IF EXISTS city_credit_entries_append_only ON city_credit_entries;
CREATE TRIGGER city_credit_entries_append_only
  BEFORE UPDATE OR DELETE ON city_credit_entries
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

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

  IF OLD.status IN ('completed', 'invalid', 'expired', 'legacy_completed', 'credit_returned')
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

CREATE OR REPLACE FUNCTION return_city_credit_spend(
  attempt_id TEXT,
  expected_lease_owner TEXT,
  return_reason TEXT,
  return_response_status SMALLINT,
  return_response JSONB,
  return_response_body BYTEA
) RETURNS payment_attempts LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  spend city_credit_entries%ROWTYPE;
  decoded_response JSONB;
BEGIN
  IF return_reason IS NULL OR octet_length(return_reason) NOT BETWEEN 1 AND 240 THEN
    RAISE EXCEPTION 'city credit return reason is outside its byte limit'
      USING ERRCODE = '23514';
  END IF;
  IF return_response_body IS NULL
    OR octet_length(return_response_body) NOT BETWEEN 2 AND 200000 THEN
    RAISE EXCEPTION 'city credit return body is outside its byte limit'
      USING ERRCODE = '23514';
  END IF;
  BEGIN
    decoded_response := convert_from(return_response_body, 'UTF8')::jsonb;
  EXCEPTION
    WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
      RAISE EXCEPTION 'city credit return body is not valid UTF-8 JSON'
        USING ERRCODE = '23514';
  END;
  IF jsonb_typeof(return_response) <> 'object'
    OR decoded_response IS DISTINCT FROM return_response THEN
    RAISE EXCEPTION 'city credit return body does not match its canonical response'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO attempt
  FROM payment_attempts
  WHERE public_id = attempt_id
  FOR UPDATE;
  IF NOT FOUND OR attempt.method <> 'credit' OR attempt.method IS NULL THEN
    RAISE EXCEPTION 'city credit attempt does not exist'
      USING ERRCODE = '55000';
  END IF;

  IF attempt.status = 'credit_returned' THEN
    IF attempt.invalid_reason IS DISTINCT FROM return_reason
      OR attempt.response_status IS DISTINCT FROM return_response_status
      OR attempt.response_json IS DISTINCT FROM return_response
      OR attempt.response_body_bytes IS DISTINCT FROM return_response_body THEN
      RAISE EXCEPTION 'city credit return retry changed its terms'
        USING ERRCODE = '55000';
    END IF;
    RETURN attempt;
  END IF;

  IF attempt.status NOT IN ('settling', 'payment_pending')
    OR attempt.lease_owner IS DISTINCT FROM expected_lease_owner THEN
    RAISE EXCEPTION 'credit attempt is not owned by this return'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO spend
  FROM city_credit_entries
  WHERE payment_attempt_id = attempt_id
    AND entry_kind = 'spend'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'city credit return has no exact spend'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO city_credit_entries (
    resident_id, entry_kind, amount_units, payment_attempt_id,
    related_spend_id, reason
  ) VALUES (
    spend.resident_id, 'return', spend.amount_units, attempt_id,
    spend.id, return_reason
  );

  UPDATE payment_attempts
  SET status = 'credit_returned',
    invalid_reason = return_reason,
    result_json = jsonb_build_object('returned', true),
    response_status = return_response_status,
    response_json = return_response,
    response_body_bytes = return_response_body,
    completed_at = clock_timestamp(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
  WHERE public_id = attempt_id
    AND lease_owner = expected_lease_owner
    AND status IN ('settling', 'payment_pending')
    AND method = 'credit'
  RETURNING * INTO attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit attempt is not owned by this return'
      USING ERRCODE = '55000';
  END IF;
  RETURN attempt;
END
$$;

COMMIT;
