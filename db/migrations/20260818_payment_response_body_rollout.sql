-- Safe Phase A for targets that have not installed byte-exact response replay.
-- Legacy completed rows remain NULL because their original bytes cannot be recovered.
ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS response_body_bytes BYTEA;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_attempts'::regclass
      AND conname = 'payment_attempts_response_body_bytes_valid'
  ) THEN
    ALTER TABLE payment_attempts
      ADD CONSTRAINT payment_attempts_response_body_bytes_valid CHECK (
        response_body_bytes IS NULL OR (
          status = 'completed'
          AND response_status IS NOT NULL
          AND response_json IS NOT NULL
          AND octet_length(response_body_bytes) BETWEEN 2 AND 200000
        )
      ) NOT VALID;
  END IF;
END
$$;

COMMENT ON COLUMN payment_attempts.response_body_bytes IS
  'Literal UTF-8 JSON response bytes for byte-exact paid-operation replay; NULL means unavailable, never reconstructed';

CREATE OR REPLACE FUNCTION validate_payment_response_body() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  decoded_response JSONB;
  canonical_response JSONB;
BEGIN
  IF NEW.response_body_bytes IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    decoded_response := convert_from(NEW.response_body_bytes, 'UTF8')::jsonb;
  EXCEPTION
    WHEN character_not_in_repertoire OR untranslatable_character OR invalid_text_representation THEN
      RAISE EXCEPTION 'payment response body is not valid UTF-8 JSON'
        USING ERRCODE = '23514';
  END;

  canonical_response := CASE
    WHEN NEW.response_json #> '{__1f3d9_x402_response_v1,body}' IS NOT NULL
      THEN NEW.response_json #> '{__1f3d9_x402_response_v1,body}'
    ELSE NEW.response_json
  END;
  IF jsonb_typeof(decoded_response) <> 'object'
    OR decoded_response IS DISTINCT FROM canonical_response THEN
    RAISE EXCEPTION 'payment response body does not match its canonical response'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payment_attempts_validate_response_body ON payment_attempts;
CREATE TRIGGER payment_attempts_validate_response_body
  BEFORE INSERT OR UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION validate_payment_response_body();

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
    AND jsonb_typeof(completion_response) = 'object'
  RETURNING * INTO completed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalized payment attempt is not owned by this completion'
      USING ERRCODE = '55000';
  END IF;
  RETURN completed;
END
$$;
