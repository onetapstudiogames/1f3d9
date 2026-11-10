BEGIN;
-- Private customer/contact cleanup runs only inside founder completion.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION protect_play_credit_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Play order history cannot be deleted' USING ERRCODE = '55000'; END IF;
  -- Only remove the private customer link, never change the purchase receipt.
  IF NEW.rc_app_user_id = 'retired:' || OLD.public_id
    AND (to_jsonb(NEW) - 'rc_app_user_id') = (to_jsonb(OLD) - 'rc_app_user_id')
    AND EXISTS (SELECT 1 FROM residents WHERE id=OLD.recipient_id
      AND retirement_state='retiring'
      AND retirement_requested_at <= clock_timestamp()-interval '30 days') THEN
    RETURN NEW;
  END IF;
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

CREATE OR REPLACE FUNCTION scrub_resident_private_payment_data(target_id INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM residents WHERE id=target_id AND retirement_state='retiring'
    AND retirement_requested_at <= clock_timestamp()-interval '30 days' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Personal data is removed only when the founder completes retirement after 30 days.'
      USING ERRCODE='R0001';
  END IF;
  UPDATE play_credit_orders SET rc_app_user_id='retired:' || public_id WHERE recipient_id=target_id;
  DELETE FROM community_tool_submissions WHERE resident_id=target_id;
  -- Retain financial receipts: provider order/subscription/capture/transaction ids,
  -- ledger links, public-chain proof and exact request/response replay evidence.
  -- Gift claim hashes belong to the buyer, not the retiring recipient.
END
$$;

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
  private_link_removed BOOLEAN := false;
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
  IF FOUND THEN
    private_link_removed := stored_order.rc_app_user_id = 'retired:' || stored_order.public_id
      AND EXISTS (SELECT 1 FROM residents WHERE id=stored_order.recipient_id AND retirement_state='retired');
    -- A verified refund still follows its existing transaction receipt after the
    -- private customer id is removed. No new delivery uses this exception.
    IF private_link_removed AND requested_event_type <> 'CANCELLATION' THEN RETURN 'unmatched'; END IF;
  END IF;
  IF stored_order.public_id IS NOT NULL AND (stored_order.product_id <> verified_product_id OR stored_order.environment <> verified_environment
    OR (requested_order_id IS NOT NULL AND stored_order.public_id <> requested_order_id)
    OR (NOT private_link_removed AND NOT stored_order.rc_app_user_id = ANY(verified_app_user_ids))) THEN
    RETURN 'unmatched';
  END IF;
  IF stored_order.public_id IS NULL THEN
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

-- Resident acceptance and spending stop. Previously approved payments may still
-- settle into immutable purchase/gift_pending receipts, and refunds/returns remain
-- possible. Refusing those receipts would lose a payment made before retirement.
DROP TRIGGER IF EXISTS resident_active_credit_entry ON city_credit_entries;
CREATE TRIGGER resident_active_credit_entry BEFORE INSERT ON city_credit_entries
FOR EACH ROW WHEN (NEW.entry_kind IN ('gift_accept','founder_issue','spend'))
EXECUTE FUNCTION require_active_resident_for_write('resident_id');
-- A buyer may move a pending gift away from a retired recipient. Only the new
-- recipient must be active; the departure receipt still names the old resident.
DROP TRIGGER IF EXISTS resident_active_credit_redirect ON city_credit_entries;
CREATE TRIGGER resident_active_credit_redirect BEFORE INSERT ON city_credit_entries
FOR EACH ROW WHEN (NEW.entry_kind='gift_redirect')
EXECUTE FUNCTION require_active_resident_for_write('counterparty_id');
COMMIT;
