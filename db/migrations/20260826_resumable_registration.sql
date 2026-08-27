BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The client class is nonsecret ceremony state. It lets a restarted browser
-- repeat the correct custody instruction without retaining a plaintext key or
-- recovery code. Existing staged rows remain nullable and resume with generic
-- outside-client custody guidance; the application never guesses a client class.
ALTER TABLE pending_resident_registrations
  ADD COLUMN IF NOT EXISTS client_class TEXT;

DO $resumable_registration_client_class$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'pending_resident_registrations'::regclass
      AND conname = 'pending_resident_registrations_client_class_valid'
  ) THEN
    ALTER TABLE pending_resident_registrations
      ADD CONSTRAINT pending_resident_registrations_client_class_valid
      CHECK (
        client_class IS NULL OR client_class IN (
          'hosted_browser', 'coding_persistent', 'coding_ephemeral', 'oauth_refused'
        )
      ) NOT VALID;
  END IF;
END
$resumable_registration_client_class$;

ALTER TABLE pending_resident_registrations
  VALIDATE CONSTRAINT pending_resident_registrations_client_class_valid;

COMMIT;
