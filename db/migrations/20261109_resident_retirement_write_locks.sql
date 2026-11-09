BEGIN;
-- Resident retirement locks leave ordinary active writes concurrent.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- PostgreSQL 17 treats columns in a nonpartial unique index as key columns.
-- Changing retirement_state therefore takes FOR UPDATE before row triggers run.
-- Writers hold KEY SHARE through commit: compatible with ordinary resident
-- updates, but a retirement must wait and later writers must see its new state.
CREATE UNIQUE INDEX IF NOT EXISTS residents_retirement_write_key
  ON residents(id, retirement_state);

CREATE OR REPLACE FUNCTION require_active_resident_for_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resident_id INTEGER; resident_state TEXT; row_value JSONB;
BEGIN
  row_value := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  -- Expired staged credentials are cleared by unrelated callers' maintenance.
  IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('resident_recovery_codes','resident_key_rotations')
    AND row_value->>'replacement_secret_hash' IS NULL
    AND (to_jsonb(OLD)->>'replacement_secret_hash' IS NOT NULL
      OR row_value->>'invalidated_at' IS NOT NULL OR row_value->>'canceled_at' IS NOT NULL) THEN RETURN NEW; END IF;
  -- Activity counters describe visitors, not a change to the owner's land.
  IF TG_TABLE_NAME='places' AND TG_OP='UPDATE'
    AND (to_jsonb(NEW)-'last_public_action_at')=(to_jsonb(OLD)-'last_public_action_at') THEN RETURN NEW; END IF;
  FOR resident_id IN
    SELECT DISTINCT value::integer FROM jsonb_each_text(row_value) WHERE key=ANY(TG_ARGV)
      AND value IS NOT NULL
    UNION SELECT DISTINCT value::integer FROM jsonb_each_text(CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END)
      WHERE key=ANY(TG_ARGV) AND value IS NOT NULL
  LOOP
    SELECT retirement_state INTO resident_state FROM residents WHERE id=resident_id FOR KEY SHARE;
    IF resident_state IN ('retiring','retired') THEN
      RAISE EXCEPTION 'This resident is % and cannot act or change owned property. See /delete.', resident_state USING ERRCODE='R0001';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_retirement_token_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state TEXT;
BEGIN
  SELECT resident.retirement_state INTO state FROM residents resident
    JOIN oauth_token_families family ON family.resident_id=resident.id
    WHERE family.id=NEW.family_id FOR KEY SHARE OF resident;
  IF state IN ('retiring','retired') THEN
    RAISE EXCEPTION 'This resident is % and cannot sign in.',state USING ERRCODE='R0001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_retired_property_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_number INTEGER; state TEXT; kind TEXT; number INTEGER;
BEGIN
  kind := CASE WHEN TG_TABLE_NAME='place_law_changes' THEN 'place' ELSE to_jsonb(NEW)->>'target_type' END;
  number := (CASE WHEN TG_TABLE_NAME='place_law_changes' THEN to_jsonb(NEW)->>'place_id' ELSE to_jsonb(NEW)->>'target_id' END)::INTEGER;
  IF kind='resident' THEN owner_number:=number;
  ELSIF kind='place' THEN SELECT owner_id INTO owner_number FROM places WHERE id=number FOR SHARE;
  ELSIF kind='thing' THEN SELECT owner_id INTO owner_number FROM things WHERE id=number FOR SHARE;
  ELSIF kind='kind' THEN SELECT owner_id INTO owner_number FROM kinds WHERE id=number FOR SHARE;
  END IF;
  SELECT retirement_state INTO state FROM residents WHERE id=owner_number FOR KEY SHARE;
  IF state IN ('retiring','retired') THEN
    RAISE EXCEPTION 'This resident is % and its property is frozen.',state USING ERRCODE='R0001';
  END IF;
  RETURN NEW;
END $$;

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
      WHERE residents.id=stored_intent.recipient_id FOR KEY SHARE;
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
