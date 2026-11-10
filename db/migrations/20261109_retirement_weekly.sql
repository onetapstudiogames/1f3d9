BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION guard_weekly_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.retirement_state IN ('retiring','retired') AND NEW.retirement_state <> OLD.retirement_state
    AND EXISTS (
      SELECT 1 FROM paypal_credit_intents intent
      WHERE intent.recipient_id=OLD.id AND intent.intent_kind='allowance'
        AND intent.remote_subscription_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM paypal_credit_events event
          WHERE event.event_kind='BILLING.SUBSCRIPTION.CANCELLED'
            AND event.remote_resource_id=intent.remote_subscription_id AND event.outcome='ignored')
    ) THEN
    RAISE EXCEPTION 'Cancel the weekly payment in PayPal first, then come back. Retirement does not stop billing. Help: /setup#weekly-payment. If you already canceled, wait for confirmation or email adam@twamd.com. Nothing changed.' USING ERRCODE='R0003';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS resident_weekly_retirement_guard ON residents;
CREATE TRIGGER resident_weekly_retirement_guard BEFORE UPDATE ON residents
  FOR EACH ROW EXECUTE FUNCTION guard_weekly_retirement();

-- Attachment must finish before a caller receives a PayPal approval link.
-- Harmless receipt replays can still touch an already active intent.
DROP TRIGGER IF EXISTS resident_active_weekly_attachment ON paypal_credit_intents;
CREATE TRIGGER resident_active_weekly_attachment BEFORE UPDATE ON paypal_credit_intents
  FOR EACH ROW WHEN (NEW.intent_kind='allowance' AND
    (NEW.remote_subscription_id IS DISTINCT FROM OLD.remote_subscription_id OR NEW.status IS DISTINCT FROM OLD.status))
  EXECUTE FUNCTION require_active_resident_for_write('recipient_id');
-- AFTER INSERT leaves ON CONFLICT receipt replay alone, but rolls back new credit.
DROP TRIGGER IF EXISTS resident_active_weekly_purchase ON city_credit_entries;
CREATE TRIGGER resident_active_weekly_purchase AFTER INSERT ON city_credit_entries
  FOR EACH ROW WHEN (NEW.entry_kind='purchase' AND NEW.purchase_kind='allowance')
  EXECUTE FUNCTION require_active_resident_for_write('resident_id');

-- Keep verified late weekly evidence without crediting a frozen resident.
ALTER TABLE paypal_credit_events DROP CONSTRAINT IF EXISTS paypal_credit_events_outcome_check;
ALTER TABLE paypal_credit_events ADD CONSTRAINT paypal_credit_events_outcome_check
  CHECK (outcome IN ('credited','ignored','withheld'));
ALTER TABLE paypal_credit_events DROP CONSTRAINT IF EXISTS paypal_credit_events_binding_check;
ALTER TABLE paypal_credit_events ADD CONSTRAINT paypal_credit_events_binding_check CHECK (
  (outcome='ignored' AND intent_public_id IS NULL AND source_key IS NULL AND purchase_entry_id IS NULL)
  OR (outcome='credited' AND intent_public_id IS NOT NULL AND source_key IS NOT NULL
    AND purchase_entry_id IS NOT NULL AND remote_resource_id IS NOT NULL
    AND event_kind IN ('PAYMENT.CAPTURE.COMPLETED','PAYMENT.SALE.COMPLETED'))
  OR (outcome='withheld' AND intent_public_id IS NOT NULL AND source_key IS NOT NULL
    AND purchase_entry_id IS NULL AND remote_resource_id IS NOT NULL
    AND event_kind='PAYMENT.SALE.COMPLETED' AND source_key='paypal:sale:'||remote_resource_id)
);

CREATE OR REPLACE FUNCTION require_paypal_credit_event_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stored_intent paypal_credit_intents%ROWTYPE;
  stored_entry city_credit_entries%ROWTYPE;
  stored_gift city_credit_gifts%ROWTYPE;
BEGIN
  IF NEW.outcome = 'ignored' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO stored_intent
  FROM paypal_credit_intents intent
  WHERE intent.public_id = NEW.intent_public_id;
  IF NEW.outcome = 'withheld' THEN
    IF stored_intent.intent_kind IS DISTINCT FROM 'allowance'
      OR stored_intent.remote_subscription_id IS NULL OR stored_intent.delivery <> 'self' THEN
      RAISE EXCEPTION 'Withheld weekly payment must match its original allowance' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO stored_entry
  FROM city_credit_entries entry
  WHERE entry.id = NEW.purchase_entry_id;

  IF stored_intent.public_id IS NULL
    OR stored_entry.id IS NULL
    OR stored_entry.entry_kind <> 'purchase'
    OR stored_entry.resident_id <> stored_intent.recipient_id
    OR stored_entry.amount_units <> stored_intent.amount_units
    OR stored_entry.source_key IS DISTINCT FROM NEW.source_key
    OR (stored_intent.delivery = 'gift') <> (stored_entry.gift_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PayPal event does not match one exact credit purchase'
      USING ERRCODE = '23514';
  END IF;

  IF stored_intent.intent_kind = 'order' THEN
    IF stored_intent.status <> 'captured'
      OR stored_intent.remote_order_id IS NULL
      OR stored_entry.purchase_kind <> 'paypal'
      OR NEW.event_kind <> 'PAYMENT.CAPTURE.COMPLETED'
      OR NEW.source_key IS DISTINCT FROM (
        'paypal:capture:' || NEW.remote_resource_id
      ) THEN
      RAISE EXCEPTION 'PayPal capture event does not match its captured order'
        USING ERRCODE = '23514';
    END IF;
  ELSIF stored_intent.intent_kind = 'allowance' THEN
    IF stored_intent.status <> 'active'
      OR stored_intent.remote_subscription_id IS NULL
      OR stored_intent.delivery <> 'self'
      OR stored_entry.purchase_kind <> 'allowance'
      OR NEW.event_kind <> 'PAYMENT.SALE.COMPLETED'
      OR NEW.source_key IS DISTINCT FROM (
        'paypal:sale:' || NEW.remote_resource_id
      ) THEN
      RAISE EXCEPTION 'PayPal renewal event does not match its active allowance'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'PayPal event has an unknown intent kind'
      USING ERRCODE = '23514';
  END IF;

  IF stored_entry.gift_id IS NULL THEN
    IF stored_intent.claim_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'self PayPal credit cannot retain gift terms'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO stored_gift
    FROM city_credit_gifts gift
    WHERE gift.id = stored_entry.gift_id;
    IF stored_gift.id IS NULL
      OR stored_gift.source_entry_id <> stored_entry.id
      OR stored_gift.recipient_id <> stored_intent.recipient_id
      OR stored_gift.amount_units <> stored_intent.amount_units
      OR stored_gift.source_key IS DISTINCT FROM NEW.source_key
      OR stored_gift.claim_token_hash IS DISTINCT FROM stored_intent.claim_token_hash THEN
      RAISE EXCEPTION 'PayPal gift event does not match its pending gift'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION deliver_paypal_credit(
  requested_purchase_id TEXT,
  expected_delivery TEXT,
  expected_recipient_id INTEGER,
  expected_amount_units BIGINT,
  expected_claim_token_hash TEXT,
  expected_paypal_environment TEXT,
  expected_remote_parent_id TEXT,
  requested_source_key TEXT,
  requested_purchase_kind TEXT,
  requested_event_id TEXT,
  requested_event_kind TEXT,
  requested_remote_resource_id TEXT,
  requested_gift_public_id TEXT
) RETURNS TABLE (
  id BIGINT,
  resident_id INTEGER,
  amount_units BIGINT,
  source_key TEXT,
  purchase_kind TEXT,
  gift_row_id BIGINT,
  gift_public_id TEXT,
  claim_token_hash TEXT,
  status TEXT,
  created BOOLEAN,
  balance_units BIGINT
) LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  stored_intent paypal_credit_intents%ROWTYPE;
  stored_event paypal_credit_events%ROWTYPE;
  purchase_record RECORD;
  event_binding_count INTEGER;
  required_intent_kind TEXT;
  delivered_status TEXT;
  reconciled_gift_status TEXT;
  staged_dispute_id TEXT;
  recipient_state TEXT;
BEGIN
  required_intent_kind := CASE requested_purchase_kind
    WHEN 'paypal' THEN 'order'
    WHEN 'allowance' THEN 'allowance'
    ELSE NULL
  END;
  delivered_status := CASE requested_purchase_kind
    WHEN 'paypal' THEN 'captured'
    WHEN 'allowance' THEN 'active'
    ELSE NULL
  END;
  IF required_intent_kind IS NULL
    OR expected_delivery IS NULL
    OR expected_delivery NOT IN ('self', 'gift')
    OR expected_recipient_id IS NULL
    OR expected_amount_units IS NULL
    OR expected_paypal_environment IS NULL
    OR expected_paypal_environment NOT IN ('sandbox', 'live')
    OR requested_event_id IS NULL
    OR octet_length(requested_event_id) NOT BETWEEN 1 AND 128
    OR requested_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    OR requested_event_kind IS NULL
    OR requested_remote_resource_id IS NULL
    OR octet_length(requested_remote_resource_id) NOT BETWEEN 1 AND 255
    OR requested_remote_resource_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    OR requested_source_key IS NULL
    OR octet_length(requested_source_key) NOT BETWEEN 8 AND 300
    OR requested_source_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$' THEN
    RAISE EXCEPTION 'PayPal credit delivery input is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF (requested_purchase_kind = 'paypal' AND (
      requested_event_kind <> 'PAYMENT.CAPTURE.COMPLETED'
      OR requested_source_key <> 'paypal:capture:' || requested_remote_resource_id
    )) OR (requested_purchase_kind = 'allowance' AND (
      requested_event_kind <> 'PAYMENT.SALE.COMPLETED'
      OR requested_source_key <> 'paypal:sale:' || requested_remote_resource_id
    )) THEN
    RAISE EXCEPTION 'PayPal event identity does not match the delivery rail'
      USING ERRCODE = '23514';
  END IF;

  IF requested_purchase_kind = 'paypal' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      '1f3d9/paypal-credit/dispute-reconciliation', 0
    ));
    PERFORM pg_advisory_xact_lock(hashtextextended(
      '1f3d9/paypal-credit/capture/' || requested_remote_resource_id, 0
    ));
  END IF;

  SELECT * INTO stored_intent
  FROM paypal_credit_intents intent
  WHERE intent.public_id = requested_purchase_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PayPal credit intent was not found' USING ERRCODE = '55000';
  END IF;

  IF stored_intent.intent_kind <> required_intent_kind
    OR stored_intent.delivery <> expected_delivery
    OR stored_intent.recipient_id <> expected_recipient_id
    OR stored_intent.amount_units <> expected_amount_units
    OR stored_intent.claim_token_hash IS DISTINCT FROM expected_claim_token_hash
    OR stored_intent.paypal_environment <> expected_paypal_environment
    OR (
      required_intent_kind = 'order'
      AND stored_intent.remote_order_id IS DISTINCT FROM expected_remote_parent_id
    )
    OR (
      required_intent_kind = 'allowance'
      AND stored_intent.remote_subscription_id IS DISTINCT FROM expected_remote_parent_id
    )
    OR (
      required_intent_kind = 'order'
      AND stored_intent.status NOT IN ('approval_pending', 'captured')
    )
    OR (
      required_intent_kind = 'allowance'
      AND stored_intent.status NOT IN ('approval_pending', 'active')
    )
    OR (expected_delivery = 'gift' AND (
      requested_purchase_kind <> 'paypal'
      OR requested_gift_public_id IS NULL
      OR requested_gift_public_id !~ '^city_gift_[0-9a-f]{32}$'
    ))
    OR (expected_delivery = 'self' AND requested_gift_public_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PayPal delivery does not match the immutable intent terms'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO event_binding_count
  FROM paypal_credit_events event
  WHERE event.event_id = requested_event_id
    OR event.source_key = requested_source_key;
  IF event_binding_count > 1 THEN
    RAISE EXCEPTION 'PayPal event identity has conflicting durable bindings'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO stored_event
  FROM paypal_credit_events event
  WHERE event.event_id = requested_event_id
    OR event.source_key = requested_source_key
  LIMIT 1;
  IF stored_event.event_id IS NOT NULL AND (
    stored_event.intent_public_id <> stored_intent.public_id
    OR stored_event.event_kind <> requested_event_kind
    OR stored_event.remote_resource_id <> requested_remote_resource_id
    OR stored_event.source_key <> requested_source_key
    OR stored_event.outcome NOT IN ('credited','withheld')
  ) THEN
    RAISE EXCEPTION 'PayPal event identity is already bound to changed terms'
      USING ERRCODE = '23514';
  END IF;

  IF requested_purchase_kind = 'allowance' THEN
    SELECT retirement_state INTO recipient_state FROM residents
      WHERE residents.id=stored_intent.recipient_id FOR SHARE;
    IF stored_event.outcome = 'withheld'
      OR (stored_event.event_id IS NULL AND recipient_state IN ('retiring','retired')) THEN
      IF stored_event.event_id IS NULL THEN
        INSERT INTO paypal_credit_events(event_id,intent_public_id,event_kind,remote_resource_id,source_key,outcome)
        VALUES(requested_event_id,stored_intent.public_id,requested_event_kind,requested_remote_resource_id,requested_source_key,'withheld');
      END IF;
      RETURN QUERY SELECT NULL::BIGINT, stored_intent.recipient_id, stored_intent.amount_units,
        requested_source_key, requested_purchase_kind, NULL::BIGINT, NULL::TEXT, NULL::TEXT,
        'withheld'::TEXT, false, NULL::BIGINT;
      RETURN;
    END IF;
  END IF;

  SELECT * INTO purchase_record
  FROM record_city_credit_purchase(
    stored_intent.recipient_id,
    stored_intent.amount_units,
    requested_source_key,
    requested_purchase_kind,
    stored_intent.claim_token_hash,
    requested_gift_public_id
  );
  IF purchase_record.id IS NULL
    OR purchase_record.resident_id <> stored_intent.recipient_id
    OR purchase_record.amount_units <> stored_intent.amount_units
    OR purchase_record.source_key <> requested_source_key
    OR purchase_record.purchase_kind <> requested_purchase_kind
    OR (stored_intent.delivery = 'gift') <> (purchase_record.gift_row_id IS NOT NULL)
    OR (
      stored_intent.delivery = 'gift'
      AND purchase_record.claim_token_hash IS DISTINCT FROM stored_intent.claim_token_hash
    ) THEN
    RAISE EXCEPTION 'PayPal purchase source is already bound to changed terms'
      USING ERRCODE = '23514';
  END IF;

  IF stored_event.event_id IS NULL THEN
    INSERT INTO paypal_credit_events (
      event_id, intent_public_id, event_kind, remote_resource_id,
      source_key, purchase_entry_id, outcome
    ) VALUES (
      requested_event_id, stored_intent.public_id, requested_event_kind,
      requested_remote_resource_id, requested_source_key,
      purchase_record.id, 'credited'
    ) RETURNING * INTO stored_event;
  ELSIF stored_event.purchase_entry_id <> purchase_record.id THEN
    RAISE EXCEPTION 'PayPal event is already bound to another credit receipt'
      USING ERRCODE = '23514';
  END IF;

  UPDATE paypal_credit_intents intent
  SET status = delivered_status, updated_at = clock_timestamp()
  WHERE intent.public_id = stored_intent.public_id
  RETURNING intent.* INTO stored_intent;

  IF requested_purchase_kind = 'paypal' THEN
    FOR staged_dispute_id IN
      SELECT DISTINCT event.dispute_id COLLATE "C" AS dispute_id
      FROM paypal_credit_dispute_events event
      WHERE requested_remote_resource_id = ANY(event.transaction_capture_ids)
      ORDER BY dispute_id
    LOOP
      PERFORM reconcile_paypal_credit_dispute(staged_dispute_id);
    END LOOP;
  END IF;

  reconciled_gift_status := purchase_record.status;
  IF purchase_record.gift_row_id IS NOT NULL THEN
    SELECT gift.status INTO reconciled_gift_status
    FROM city_credit_gifts gift WHERE gift.id = purchase_record.gift_row_id;
  END IF;

  RETURN QUERY SELECT
    purchase_record.id::BIGINT,
    purchase_record.resident_id::INTEGER,
    purchase_record.amount_units::BIGINT,
    purchase_record.source_key::TEXT,
    purchase_record.purchase_kind::TEXT,
    purchase_record.gift_row_id::BIGINT,
    purchase_record.gift_public_id::TEXT,
    purchase_record.claim_token_hash::TEXT,
    reconciled_gift_status::TEXT,
    purchase_record.created::BOOLEAN,
    purchase_record.balance_units::BIGINT;
END
$$;
COMMIT;
