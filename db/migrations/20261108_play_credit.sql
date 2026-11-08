BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS play_credit_orders (
  public_id TEXT PRIMARY KEY CHECK (public_id ~ '^city_play_[0-9a-f]{32}$'),
  request_id TEXT NOT NULL UNIQUE CHECK (octet_length(request_id) BETWEEN 8 AND 128),
  recipient_id INTEGER NOT NULL REFERENCES residents(id),
  product_id TEXT NOT NULL CHECK (product_id IN ('fee_credit_1_v1', 'fee_credit_5_v1', 'fee_credit_10_v1')),
  amount_units BIGINT NOT NULL,
  claim_token_hash TEXT NOT NULL CHECK (claim_token_hash ~ '^[0-9a-f]{64}$'),
  rc_app_user_id TEXT NOT NULL CHECK (octet_length(rc_app_user_id) BETWEEN 1 AND 6000),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  transaction_id TEXT UNIQUE CHECK (transaction_id ~ '^GPA\.[A-Za-z0-9.-]{1,124}$'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'delivered', 'revoked', 'ignored')),
  gift_id BIGINT UNIQUE REFERENCES city_credit_gifts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (amount_units = CASE product_id WHEN 'fee_credit_1_v1' THEN 1000000
    WHEN 'fee_credit_5_v1' THEN 5000000 WHEN 'fee_credit_10_v1' THEN 10000000 ELSE 0 END),
  CHECK ((status = 'open' AND transaction_id IS NULL AND gift_id IS NULL)
    OR (status IN ('delivered', 'revoked') AND transaction_id IS NOT NULL)
    OR status = 'ignored')
);
CREATE INDEX IF NOT EXISTS play_credit_orders_buyer_product ON play_credit_orders (rc_app_user_id, product_id, environment);

CREATE TABLE IF NOT EXISTS play_credit_events (
  event_id TEXT PRIMARY KEY CHECK (octet_length(event_id) BETWEEN 1 AND 255),
  event_type TEXT NOT NULL CHECK (event_type IN ('NON_RENEWING_PURCHASE', 'CANCELLATION')),
  transaction_id TEXT NOT NULL CHECK (transaction_id ~ '^GPA\.[A-Za-z0-9.-]{1,124}$'),
  product_id TEXT NOT NULL CHECK (product_id IN ('fee_credit_1_v1', 'fee_credit_5_v1', 'fee_credit_10_v1')),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  verified BOOLEAN NOT NULL,
  order_id TEXT REFERENCES play_credit_orders(public_id),
  purchase_entry_id BIGINT REFERENCES city_credit_entries(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'revoked', 'accepted_kept', 'refunded_before_delivery', 'unmatched', 'ignored', 'duplicate')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome = 'ignored' AND NOT verified) OR (outcome <> 'ignored' AND verified)),
  CHECK (outcome NOT IN ('delivered', 'revoked', 'accepted_kept') OR (order_id IS NOT NULL AND purchase_entry_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS play_credit_events_transaction ON play_credit_events (transaction_id, environment);

-- Preserve every pre-existing ledger shape; add only the gift-only Play purchase shape.
DO $$
DECLARE definition TEXT;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO definition FROM pg_constraint
  WHERE conrelid = 'city_credit_entries'::regclass AND conname = 'city_credit_entries_check';
  IF position('''play''' in definition) = 0 THEN
    EXECUTE 'ALTER TABLE city_credit_entries DROP CONSTRAINT city_credit_entries_check';
    EXECUTE 'ALTER TABLE city_credit_entries ADD CONSTRAINT city_credit_entries_check CHECK (('
      || definition || ') OR ('
      || 'entry_kind = ''purchase'' AND purchase_kind = ''play'' AND gift_id IS NOT NULL '
      || 'AND founder_id IS NULL AND source_key IS NOT NULL AND reason IS NULL '
      || 'AND request_id IS NULL AND related_spend_id IS NULL AND payment_attempt_id IS NULL '
      || 'AND counterparty_id IS NULL AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL '
      || 'AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL AND application_outcome IS NULL))';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION protect_play_credit_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Play order history cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF ROW(NEW.public_id, NEW.request_id, NEW.recipient_id, NEW.product_id, NEW.amount_units,
    NEW.claim_token_hash, NEW.rc_app_user_id, NEW.environment, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.public_id, OLD.request_id, OLD.recipient_id, OLD.product_id, OLD.amount_units,
    OLD.claim_token_hash, OLD.rc_app_user_id, OLD.environment, OLD.created_at)
    OR (OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id)
    OR (OLD.gift_id IS NOT NULL AND NEW.gift_id IS DISTINCT FROM OLD.gift_id)
    OR (OLD.status = 'revoked' AND NEW.status <> 'revoked') THEN
    RAISE EXCEPTION 'Play purchase terms are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS play_credit_orders_guard ON play_credit_orders;
CREATE TRIGGER play_credit_orders_guard BEFORE UPDATE OR DELETE ON play_credit_orders
FOR EACH ROW EXECUTE FUNCTION protect_play_credit_order();
DROP TRIGGER IF EXISTS play_credit_events_append_only ON play_credit_events;
CREATE TRIGGER play_credit_events_append_only BEFORE UPDATE OR DELETE ON play_credit_events
FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

CREATE OR REPLACE FUNCTION require_play_purchase_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entry_kind = 'purchase' AND NEW.purchase_kind = 'play' AND NOT EXISTS (
    SELECT 1 FROM play_credit_events e JOIN play_credit_orders o ON o.public_id = e.order_id
    JOIN city_credit_gifts g ON g.id = o.gift_id
    WHERE e.verified AND e.event_type = 'NON_RENEWING_PURCHASE' AND e.outcome = 'delivered'
      AND e.purchase_entry_id = NEW.id AND NEW.gift_id = o.gift_id
      AND NEW.resident_id = o.recipient_id AND NEW.amount_units = o.amount_units
      AND NEW.source_key = 'play:txn:' || e.transaction_id
      AND e.transaction_id = o.transaction_id AND e.product_id = o.product_id AND e.environment = o.environment
      AND g.claim_token_hash = o.claim_token_hash
  ) THEN RAISE EXCEPTION 'Play purchase requires its exact verified event' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS city_credit_entries_require_play_event ON city_credit_entries;
CREATE CONSTRAINT TRIGGER city_credit_entries_require_play_event AFTER INSERT ON city_credit_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_play_purchase_event();

CREATE OR REPLACE FUNCTION deliver_play_credit(
  requested_order_id TEXT, requested_event_id TEXT, requested_event_type TEXT,
  requested_transaction_id TEXT, verified_product_id TEXT, verified_environment TEXT,
  configured_environment TEXT, verified_purchased_at TIMESTAMPTZ, verified_app_user_ids TEXT[]
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  stored_order play_credit_orders%ROWTYPE;
  prior_event play_credit_events%ROWTYPE;
  gift city_credit_gifts%ROWTYPE;
  purchase RECORD;
  matching_ids TEXT[];
  result TEXT;
BEGIN
  IF verified_product_id NOT IN ('fee_credit_1_v1', 'fee_credit_5_v1', 'fee_credit_10_v1')
    OR requested_event_type NOT IN ('NON_RENEWING_PURCHASE', 'CANCELLATION')
    OR verified_environment NOT IN ('production', 'sandbox') OR configured_environment NOT IN ('production', 'sandbox')
    OR requested_transaction_id !~ '^GPA\.[A-Za-z0-9.-]{1,124}$' THEN
    RAISE EXCEPTION 'invalid Play purchase evidence' USING ERRCODE = '23514';
  END IF;
  -- Both delivery and refund take the same transaction lock before any order/gift lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('play:' || requested_transaction_id, 0));
  SELECT * INTO prior_event FROM play_credit_events WHERE event_id = requested_event_id;
  IF FOUND THEN
    IF prior_event.transaction_id <> requested_transaction_id OR prior_event.product_id <> verified_product_id
      OR prior_event.environment <> verified_environment OR prior_event.event_type <> requested_event_type THEN
      RAISE EXCEPTION 'Play event id was reused' USING ERRCODE = '23514';
    END IF;
    RETURN prior_event.outcome;
  END IF;
  IF verified_environment <> configured_environment THEN
    INSERT INTO play_credit_events(event_id,event_type,transaction_id,product_id,environment,verified,outcome)
    VALUES(requested_event_id,requested_event_type,requested_transaction_id,verified_product_id,verified_environment,false,'ignored');
    RETURN 'ignored';
  END IF;
  SELECT * INTO stored_order FROM play_credit_orders WHERE transaction_id = requested_transaction_id FOR UPDATE;
  IF FOUND AND (stored_order.product_id <> verified_product_id OR stored_order.environment <> verified_environment
    OR (requested_order_id IS NOT NULL AND stored_order.public_id <> requested_order_id)
    OR NOT stored_order.rc_app_user_id = ANY(verified_app_user_ids)) THEN
    RETURN 'unmatched';
  END IF;
  IF NOT FOUND THEN
    SELECT array_agg(public_id) INTO matching_ids FROM play_credit_orders
    WHERE status = 'open' AND rc_app_user_id = ANY(verified_app_user_ids)
      AND product_id = verified_product_id AND environment = verified_environment
      AND created_at <= verified_purchased_at
      AND (requested_order_id IS NULL OR public_id = requested_order_id);
    IF cardinality(matching_ids) = 1 THEN
      SELECT * INTO stored_order FROM play_credit_orders WHERE public_id = matching_ids[1] FOR UPDATE;
      IF stored_order.status <> 'open' THEN RETURN 'unmatched'; END IF;
    END IF;
  END IF;
  IF requested_event_type = 'CANCELLATION' THEN
    IF EXISTS (SELECT 1 FROM play_credit_events WHERE transaction_id = requested_transaction_id
      AND environment = verified_environment AND event_type = 'CANCELLATION' AND verified) THEN
      INSERT INTO play_credit_events(event_id,event_type,transaction_id,product_id,environment,verified,order_id,outcome)
      VALUES(requested_event_id,requested_event_type,requested_transaction_id,verified_product_id,verified_environment,true,stored_order.public_id,'duplicate');
      RETURN 'duplicate';
    END IF;
    IF stored_order.gift_id IS NOT NULL THEN
      SELECT * INTO gift FROM city_credit_gifts WHERE id = stored_order.gift_id FOR UPDATE;
      result := CASE WHEN gift.status = 'accepted' THEN 'accepted_kept' ELSE 'revoked' END;
      INSERT INTO play_credit_events(event_id,event_type,transaction_id,product_id,environment,verified,order_id,purchase_entry_id,outcome)
      VALUES(requested_event_id,requested_event_type,requested_transaction_id,verified_product_id,verified_environment,true,stored_order.public_id,gift.source_entry_id,result);
      IF gift.status IN ('pending', 'refused') THEN
        UPDATE city_credit_gifts SET status = 'revoked', refused_at = NULL,
          frozen_at = clock_timestamp(), revoked_at = clock_timestamp() WHERE id = gift.id;
        UPDATE play_credit_orders SET status = 'revoked', updated_at = clock_timestamp() WHERE public_id = stored_order.public_id;
      END IF;
      RETURN result;
    END IF;
    -- Keep refund evidence even when the order is absent or ambiguous. A later claim cannot mint it.
    INSERT INTO play_credit_events(event_id,event_type,transaction_id,product_id,environment,verified,order_id,outcome)
    VALUES(requested_event_id,requested_event_type,requested_transaction_id,verified_product_id,verified_environment,true,stored_order.public_id,'refunded_before_delivery');
    IF stored_order.public_id IS NOT NULL THEN
      UPDATE play_credit_orders SET status = 'revoked', transaction_id = requested_transaction_id,
        updated_at = clock_timestamp() WHERE public_id = stored_order.public_id;
    END IF;
    RETURN 'refunded_before_delivery';
  END IF;
  IF EXISTS (SELECT 1 FROM play_credit_events WHERE transaction_id = requested_transaction_id
    AND environment = verified_environment AND event_type = 'CANCELLATION' AND verified) THEN
    IF stored_order.public_id IS NOT NULL AND stored_order.status = 'open' THEN
      UPDATE play_credit_orders SET status = 'revoked', transaction_id = requested_transaction_id,
        updated_at = clock_timestamp() WHERE public_id = stored_order.public_id;
    END IF;
    INSERT INTO play_credit_events(event_id,event_type,transaction_id,product_id,environment,verified,order_id,outcome)
    VALUES(requested_event_id,requested_event_type,requested_transaction_id,verified_product_id,verified_environment,true,stored_order.public_id,'refunded_before_delivery');
    RETURN 'refunded_before_delivery';
  END IF;
  IF stored_order.public_id IS NULL THEN
    INSERT INTO play_credit_events(event_id,event_type,transaction_id,product_id,environment,verified,outcome)
    VALUES(requested_event_id,requested_event_type,requested_transaction_id,verified_product_id,verified_environment,true,'unmatched');
    RETURN 'unmatched';
  END IF;
  SELECT * INTO purchase FROM record_city_credit_purchase(stored_order.recipient_id, stored_order.amount_units,
    'play:txn:' || requested_transaction_id, 'play', stored_order.claim_token_hash,
    'city_gift_' || replace(gen_random_uuid()::text, '-', ''));
  UPDATE play_credit_orders SET status = 'delivered', transaction_id = requested_transaction_id,
    gift_id = purchase.gift_row_id, updated_at = clock_timestamp() WHERE public_id = stored_order.public_id;
  INSERT INTO play_credit_events(event_id,event_type,transaction_id,product_id,environment,verified,order_id,purchase_entry_id,outcome)
  VALUES(requested_event_id,requested_event_type,requested_transaction_id,verified_product_id,verified_environment,true,stored_order.public_id,purchase.id,'delivered');
  RETURN 'delivered';
END
$$;

CREATE OR REPLACE FUNCTION require_city_credit_gift_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_gift city_credit_gifts%ROWTYPE;
BEGIN
  SELECT * INTO current_gift FROM city_credit_gifts WHERE id = NEW.id;
  IF NOT FOUND OR current_gift.source_entry_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.id = current_gift.source_entry_id AND entry.entry_kind = 'purchase'
      AND entry.gift_id = current_gift.id AND entry.amount_units = current_gift.amount_units
      AND entry.source_key = current_gift.source_key
  ) THEN
    RAISE EXCEPTION 'city credit gift requires its exact purchase receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('pending', 'frozen') AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id AND entry.entry_kind = 'gift_pending'
      AND entry.resident_id = NEW.recipient_id AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':pending:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'pending city credit gift requires its exact arrival receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id AND entry.entry_kind = 'gift_accept'
      AND entry.resident_id = NEW.recipient_id AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':accept:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'accepted city credit gift requires its exact acceptance receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'refused' AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id AND entry.entry_kind = 'gift_refuse'
      AND entry.resident_id = NEW.recipient_id AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':refuse:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'refused city credit gift requires its exact refusal receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'frozen' AND NOT EXISTS (
    SELECT 1 FROM paypal_credit_disputes dispute
    JOIN paypal_credit_dispute_events event
      ON event.dispute_id = dispute.dispute_id
    JOIN city_credit_entries receipt
      ON receipt.paypal_dispute_id = dispute.dispute_id
      AND receipt.paypal_event_id = event.paypal_event_id
    JOIN city_credit_entries purchase ON purchase.id = receipt.related_purchase_id
    WHERE purchase.gift_id = NEW.id
      AND dispute.state IN ('open', 'resolution_review')
      AND receipt.gift_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'frozen city credit gift requires its open dispute receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'revoked' AND NOT EXISTS (
    SELECT 1 FROM play_credit_events event
    JOIN play_credit_orders play_order ON play_order.public_id = event.order_id
    WHERE play_order.gift_id = NEW.id AND event.purchase_entry_id = current_gift.source_entry_id
      AND event.transaction_id = play_order.transaction_id AND event.product_id = play_order.product_id
      AND event.environment = play_order.environment AND event.verified
      AND event.event_type = 'CANCELLATION' AND event.outcome = 'revoked'
  ) AND NOT EXISTS (
    SELECT 1 FROM paypal_credit_disputes dispute
    JOIN city_credit_entries receipt
      ON receipt.paypal_dispute_id = dispute.dispute_id
    JOIN city_credit_entries purchase ON purchase.id = receipt.related_purchase_id
    WHERE purchase.gift_id = NEW.id
      AND dispute.state = 'resolved_against_seller'
      AND receipt.gift_id = NEW.id
      AND receipt.application_outcome IN (
        'dispute_resolved_gift_revoked', 'founder_review_gift_revoked'
      )
  ) THEN
    RAISE EXCEPTION 'revoked city credit gift requires its adverse dispute receipt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'frozen' AND NEW.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM paypal_credit_disputes dispute
      JOIN city_credit_entries receipt
        ON receipt.paypal_dispute_id = dispute.dispute_id
      JOIN city_credit_entries purchase ON purchase.id = receipt.related_purchase_id
      WHERE purchase.gift_id = NEW.id AND dispute.state = 'resolved_seller'
        AND receipt.gift_id = NEW.id
        AND receipt.application_outcome IN (
          'dispute_resolved_gift_pending', 'founder_review_gift_pending'
        )
    ) THEN
    RAISE EXCEPTION 'unfrozen city credit gift requires its seller-favor receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'refused' AND NEW.frozen_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM paypal_credit_disputes dispute
    JOIN city_credit_entries receipt
      ON receipt.paypal_dispute_id = dispute.dispute_id
    JOIN city_credit_entries purchase ON purchase.id = receipt.related_purchase_id
    WHERE purchase.gift_id = NEW.id
      AND dispute.state IN ('open', 'resolution_review')
      AND receipt.gift_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'blocked refused city credit gift requires its open dispute receipt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'refused'
    AND OLD.frozen_at IS NOT NULL AND NEW.status = 'refused'
    AND NEW.frozen_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM paypal_credit_disputes dispute
      JOIN city_credit_entries receipt
        ON receipt.paypal_dispute_id = dispute.dispute_id
      JOIN city_credit_entries purchase ON purchase.id = receipt.related_purchase_id
      WHERE purchase.gift_id = NEW.id
        AND dispute.state = 'resolved_seller'
        AND receipt.gift_id = NEW.id
        AND receipt.application_outcome IN (
          'dispute_resolved_refused_gift',
          'founder_review_refused_gift_redirectable'
        )
    ) THEN
    RAISE EXCEPTION 'unblocked refused city credit gift requires its seller-favor receipt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'refused'
    AND OLD.frozen_at IS NOT NULL AND NEW.status = 'refused'
    AND NEW.frozen_at IS NULL AND EXISTS (
      SELECT 1 FROM paypal_credit_disputes dispute
      JOIN paypal_credit_dispute_events event
        ON event.dispute_id = dispute.dispute_id
      JOIN paypal_credit_events capture
        ON capture.remote_resource_id = ANY(event.transaction_capture_ids)
        AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
        AND capture.outcome = 'credited'
      JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
      WHERE purchase.gift_id = NEW.id
        AND dispute.state IN ('open', 'resolution_review')
    ) THEN
    RAISE EXCEPTION 'refused city credit gift remains blocked by an open payment dispute'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    AND NOT EXISTS (
      SELECT 1 FROM city_credit_entries entry
      WHERE entry.gift_id = NEW.id AND entry.entry_kind = 'gift_redirect'
        AND entry.resident_id = OLD.recipient_id
        AND entry.counterparty_id = NEW.recipient_id
        AND entry.amount_units = NEW.amount_units
        AND entry.source_key = 'gift:' || NEW.public_id || ':redirect:' || NEW.version::text
    ) THEN
    RAISE EXCEPTION 'redirected city credit gift requires its exact departure receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;


COMMIT;
