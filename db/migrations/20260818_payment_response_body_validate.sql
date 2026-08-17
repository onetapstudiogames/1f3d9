-- Run separately after response-body storage is deployed and healthy.
-- The migration runner commits this scan independently from the Phase A ADD lock.
ALTER TABLE payment_attempts
  VALIDATE CONSTRAINT payment_attempts_response_body_bytes_valid;
