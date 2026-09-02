BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE places, events, payment_attempts, city_credit_entries, place_reading_totals
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE places
  ADD COLUMN IF NOT EXISTS founding_name TEXT,
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

ALTER TABLE places DISABLE TRIGGER places_protect_topology_write;
UPDATE places SET founding_name = name WHERE founding_name IS NULL;
ALTER TABLE places ENABLE TRIGGER places_protect_topology_write;

DO $place_lifecycle_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_founding_name_valid'
  ) THEN
    ALTER TABLE places ADD CONSTRAINT places_founding_name_valid
      CHECK (char_length(founding_name) BETWEEN 1 AND 120) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_retired_after_creation'
  ) THEN
    ALTER TABLE places ADD CONSTRAINT places_retired_after_creation
      CHECK (retired_at IS NULL OR retired_at >= created_at) NOT VALID;
  END IF;
END
$place_lifecycle_constraints$;

ALTER TABLE places VALIDATE CONSTRAINT places_founding_name_valid;
ALTER TABLE places VALIDATE CONSTRAINT places_retired_after_creation;
ALTER TABLE places ALTER COLUMN founding_name SET NOT NULL;

DROP INDEX IF EXISTS places_sibling_name;
CREATE UNIQUE INDEX places_sibling_name
  ON places (parent_id, lower(name))
  WHERE parent_id IS NOT NULL AND retired_at IS NULL;

-- Directory totals count only active child places. This one migration scan
-- aligns existing counters; normal writes remain delta-only through the trigger.
WITH active_subplaces AS (
  SELECT parent_id AS place_id,
    count(*)::integer AS items,
    coalesce(sum(octet_length(description) + octet_length(purpose)), 0)::bigint AS text_bytes
  FROM places
  WHERE parent_id IS NOT NULL AND retired_at IS NULL
  GROUP BY parent_id
)
UPDATE place_reading_totals totals SET
  subplace_items = coalesce(active.items, 0),
  subplace_text_bytes = coalesce(active.text_bytes, 0)
FROM places parent
LEFT JOIN active_subplaces active ON active.place_id = parent.id
WHERE totals.place_id = parent.id;

CREATE OR REPLACE FUNCTION maintain_place_reading_totals_from_place()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO place_reading_totals (place_id) VALUES (NEW.id)
    ON CONFLICT (place_id) DO NOTHING;
    IF NEW.parent_id IS NOT NULL AND NEW.retired_at IS NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items + 1,
        subplace_text_bytes = subplace_text_bytes
          + octet_length(NEW.description) + octet_length(NEW.purpose)
      WHERE place_id = NEW.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', NEW.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.parent_id IS NOT NULL AND OLD.retired_at IS NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items - 1,
        subplace_text_bytes = subplace_text_bytes
          - (octet_length(OLD.description) + octet_length(OLD.purpose))
      WHERE place_id = OLD.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', OLD.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    IF OLD.parent_id IS NOT NULL AND OLD.retired_at IS NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items - 1,
        subplace_text_bytes = subplace_text_bytes
          - (octet_length(OLD.description) + octet_length(OLD.purpose))
      WHERE place_id = OLD.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', OLD.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF NEW.parent_id IS NOT NULL AND NEW.retired_at IS NULL THEN
      UPDATE place_reading_totals SET
        subplace_items = subplace_items + 1,
        subplace_text_bytes = subplace_text_bytes
          + octet_length(NEW.description) + octet_length(NEW.purpose)
      WHERE place_id = NEW.parent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'reading totals missing for parent place %', NEW.parent_id
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS places_update_reading_totals ON places;
CREATE TRIGGER places_update_reading_totals
AFTER INSERT OR DELETE OR UPDATE OF parent_id, description, purpose, retired_at ON places
FOR EACH ROW EXECUTE FUNCTION maintain_place_reading_totals_from_place();

CREATE OR REPLACE FUNCTION protect_place_founding_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.founding_name IS NULL THEN
      NEW.founding_name := NEW.name;
    ELSIF NEW.founding_name IS DISTINCT FROM NEW.name THEN
      RAISE EXCEPTION 'founding name must match the first display name'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.founding_name IS DISTINCT FROM OLD.founding_name THEN
    RAISE EXCEPTION 'founding name is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS places_protect_founding_name ON places;
CREATE TRIGGER places_protect_founding_name
  BEFORE INSERT OR UPDATE OF founding_name ON places
  FOR EACH ROW EXECUTE FUNCTION protect_place_founding_name();

CREATE TABLE IF NOT EXISTS place_name_history (
  id         BIGSERIAL PRIMARY KEY,
  place_id   INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  started_at TIMESTAMPTZ NOT NULL,
  event_id   BIGINT UNIQUE REFERENCES events(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS place_name_history_one_founding_name
  ON place_name_history (place_id) WHERE event_id IS NULL;
CREATE INDEX IF NOT EXISTS place_name_history_place_span
  ON place_name_history (place_id, started_at, id);
CREATE INDEX IF NOT EXISTS place_name_history_name_search
  ON place_name_history USING gin (lower(name) gin_trgm_ops);

INSERT INTO place_name_history (place_id, name, started_at, event_id)
SELECT place.id, place.name, place.created_at, NULL
FROM places AS place
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION record_place_founding_name_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO place_name_history (place_id, name, started_at, event_id)
  VALUES (NEW.id, NEW.founding_name, NEW.created_at, NULL);
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS places_record_founding_name_history ON places;
CREATE TRIGGER places_record_founding_name_history
  AFTER INSERT ON places
  FOR EACH ROW EXECUTE FUNCTION record_place_founding_name_history();

CREATE OR REPLACE FUNCTION deny_place_name_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'place name history is append-only' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS place_name_history_append_only ON place_name_history;
CREATE TRIGGER place_name_history_append_only
  BEFORE UPDATE OR DELETE ON place_name_history
  FOR EACH ROW EXECUTE FUNCTION deny_place_name_history_mutation();
DROP TRIGGER IF EXISTS place_name_history_no_truncate ON place_name_history;
CREATE TRIGGER place_name_history_no_truncate
  BEFORE TRUNCATE ON place_name_history
  FOR EACH STATEMENT EXECUTE FUNCTION deny_place_name_history_mutation();

CREATE OR REPLACE VIEW place_name_spans AS
SELECT id, place_id, name, started_at,
  lead(started_at) OVER (PARTITION BY place_id ORDER BY started_at, id) AS ended_at,
  event_id
FROM place_name_history;

-- Wrap the deployed snapshot view so tombstones remain in the stable numeric
-- place sequence while current and former names are exported honestly.
DO $place_lifecycle_snapshot_base$
BEGIN
  IF to_regclass('city_snapshot.public_records_without_place_lifecycle') IS NULL THEN
    ALTER VIEW city_snapshot.public_records
      RENAME TO public_records_without_place_lifecycle;
  END IF;
END
$place_lifecycle_snapshot_base$;
REVOKE ALL ON city_snapshot.public_records_without_place_lifecycle FROM PUBLIC;
REVOKE ALL ON city_snapshot.public_records_without_place_lifecycle FROM city_snapshot_export;

CREATE OR REPLACE VIEW city_snapshot.public_records
WITH (security_barrier = true)
AS
SELECT base.class_name, base.record_id, base.sort_key,
  CASE
    WHEN base.class_name <> 'places' OR place.id IS NULL
      OR base.payload->>'status' <> 'exported' THEN base.payload
    ELSE base.payload || jsonb_build_object(
      'name', CASE WHEN place_hidden.action = 'remove'
        THEN '[removed by maintainer]' ELSE place.name END,
      'founding_name', CASE WHEN place_hidden.action = 'remove'
        THEN '[removed by maintainer]' ELSE place.founding_name END,
      'retired_at', place.retired_at,
      'status', CASE WHEN place.retired_at IS NULL THEN 'active' ELSE 'retired' END,
      'name_history', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'name', CASE WHEN place_hidden.action = 'remove'
            THEN '[removed by maintainer]' ELSE span.name END,
          'started_at', span.started_at,
          'ended_at', span.ended_at
        ) ORDER BY span.started_at, span.id)
        FROM place_name_spans span WHERE span.place_id = place.id
      ), '[]'::jsonb)
    )
  END AS payload
FROM city_snapshot.public_records_without_place_lifecycle base
LEFT JOIN places place
  ON base.class_name = 'places' AND place.id::text = base.record_id
LEFT JOIN LATERAL (
  SELECT action.action
  FROM moderation_actions action
  WHERE action.target_type = 'place' AND action.target_id = place.id
  ORDER BY action.created_at DESC, action.id DESC
  LIMIT 1
) place_hidden ON place.id IS NOT NULL;

REVOKE ALL ON city_snapshot.public_records FROM PUBLIC;
GRANT USAGE ON SCHEMA city_snapshot TO city_snapshot_export;
GRANT SELECT ON city_snapshot.public_records TO city_snapshot_export;

DO $place_lifecycle_snapshot_v2_base$
BEGIN
  IF to_regclass('city_snapshot.public_records_v2_without_place_lifecycle') IS NULL THEN
    ALTER VIEW city_snapshot.public_records_v2
      RENAME TO public_records_v2_without_place_lifecycle;
  END IF;
END
$place_lifecycle_snapshot_v2_base$;
REVOKE ALL ON city_snapshot.public_records_v2_without_place_lifecycle FROM PUBLIC;
REVOKE ALL ON city_snapshot.public_records_v2_without_place_lifecycle FROM city_snapshot_export;

CREATE OR REPLACE VIEW city_snapshot.public_records_v2
WITH (security_barrier = true)
AS
SELECT base.class_name, base.record_id, base.sort_key,
  CASE
    WHEN base.class_name = 'places' AND place.id IS NOT NULL
      AND base.payload->>'status' = 'exported' THEN base.payload || jsonb_build_object(
        'name', CASE WHEN place_hidden.action = 'remove'
          THEN '[removed by maintainer]' ELSE place.name END,
        'founding_name', CASE WHEN place_hidden.action = 'remove'
          THEN '[removed by maintainer]' ELSE place.founding_name END,
        'retired_at', place.retired_at,
        'status', CASE WHEN place.retired_at IS NULL THEN 'active' ELSE 'retired' END,
        'name_history', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'name', CASE WHEN place_hidden.action = 'remove'
              THEN '[removed by maintainer]' ELSE span.name END,
            'started_at', span.started_at,
            'ended_at', span.ended_at
          ) ORDER BY span.started_at, span.id)
          FROM place_name_spans span WHERE span.place_id = place.id
        ), '[]'::jsonb)
      )
    WHEN base.class_name = 'events'
      AND event.kind IN ('place_renamed', 'place_retired', 'place_restored')
      THEN jsonb_build_object(
        'id', event.id, 'status', 'exported', 'kind', event.kind,
        'at', event.at, 'actor', event.actor,
        'detail', jsonb_strip_nulls(jsonb_build_object(
          'place_id', event.detail->'place_id',
          'name', CASE WHEN event_place_hidden.action = 'remove'
            THEN to_jsonb('[removed by maintainer]'::text) ELSE event.detail->'name' END,
          'former_name', CASE WHEN event_place_hidden.action = 'remove'
            THEN to_jsonb('[removed by maintainer]'::text) ELSE event.detail->'former_name' END
        ))
      )
    ELSE base.payload
  END AS payload
FROM city_snapshot.public_records_v2_without_place_lifecycle base
LEFT JOIN places place
  ON base.class_name = 'places' AND place.id::text = base.record_id
LEFT JOIN events event
  ON base.class_name = 'events' AND event.id::text = base.record_id
LEFT JOIN LATERAL (
  SELECT action.action
  FROM moderation_actions action
  WHERE action.target_type = 'place' AND action.target_id = place.id
  ORDER BY action.created_at DESC, action.id DESC
  LIMIT 1
) place_hidden ON place.id IS NOT NULL
LEFT JOIN LATERAL (
  SELECT action.action
  FROM moderation_actions action
  WHERE action.target_type = 'place'
    AND action.target_id::text = event.detail->>'place_id'
  ORDER BY action.created_at DESC, action.id DESC
  LIMIT 1
) event_place_hidden ON event.id IS NOT NULL;

REVOKE ALL ON city_snapshot.public_records_v2 FROM PUBLIC;
REVOKE SELECT ON city_snapshot.public_records FROM city_snapshot_export;
GRANT SELECT ON city_snapshot.public_records_v2 TO city_snapshot_export;

-- Taking a SHARE row lock on the target place makes these checks serialize with
-- the lifecycle UPDATE's NO KEY UPDATE lock. A place cannot be repopulated in the
-- gap between the retirement emptiness check and its commit.
CREATE OR REPLACE FUNCTION reject_retired_place_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_place_id INTEGER;
  target_retired_at TIMESTAMPTZ;
BEGIN
  IF TG_TABLE_NAME = 'places' THEN
    target_place_id := NEW.parent_id;
  ELSIF TG_TABLE_NAME = 'things' THEN
    IF NEW.withdrawn_at IS NOT NULL THEN RETURN NEW; END IF;
    target_place_id := NEW.place_id;
  ELSIF TG_TABLE_NAME = 'notes' THEN
    target_place_id := NEW.place_id;
  ELSE
    IF NEW.current_place_id IS NOT NULL THEN
      SELECT retired_at INTO target_retired_at
      FROM places WHERE id = NEW.current_place_id FOR SHARE;
      IF target_retired_at IS NOT NULL THEN
        RAISE EXCEPTION 'retired place cannot receive resident presence'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    target_place_id := NEW.home_place_id;
  END IF;

  IF target_place_id IS NOT NULL THEN
    SELECT retired_at INTO target_retired_at
    FROM places WHERE id = target_place_id FOR SHARE;
    IF target_retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'retired place cannot receive %', CASE TG_TABLE_NAME
        WHEN 'places' THEN 'subplaces'
        WHEN 'things' THEN 'things'
        WHEN 'notes' THEN 'notes'
        ELSE 'resident homes'
      END USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS places_reject_retired_parent ON places;
CREATE TRIGGER places_reject_retired_parent
  BEFORE INSERT OR UPDATE OF parent_id ON places
  FOR EACH ROW EXECUTE FUNCTION reject_retired_place_target();
DROP TRIGGER IF EXISTS things_reject_retired_place ON things;
CREATE TRIGGER things_reject_retired_place
  BEFORE INSERT OR UPDATE OF place_id, withdrawn_at ON things
  FOR EACH ROW EXECUTE FUNCTION reject_retired_place_target();
DROP TRIGGER IF EXISTS notes_reject_retired_place ON notes;
CREATE TRIGGER notes_reject_retired_place
  BEFORE INSERT OR UPDATE OF place_id ON notes
  FOR EACH ROW EXECUTE FUNCTION reject_retired_place_target();
DROP TRIGGER IF EXISTS resident_presence_reject_retired_place ON resident_presence;
CREATE TRIGGER resident_presence_reject_retired_place
  BEFORE INSERT OR UPDATE OF current_place_id, home_place_id ON resident_presence
  FOR EACH ROW EXECUTE FUNCTION reject_retired_place_target();

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_operation_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_operation_check CHECK (operation IN (
    'frontier', 'kind_invention', 'kind_revision',
    'place_rename', 'place_retire', 'place_restore',
    'direct_sale', 'world_sale', 'credit_purchase', 'legacy'
  ));

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_credit_facts;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_credit_facts CHECK (
    method IS DISTINCT FROM 'credit' OR (
      operation IN (
        'frontier', 'kind_invention', 'kind_revision',
        'place_rename', 'place_retire', 'place_restore'
      )
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
          operation IN ('place_rename', 'place_retire', 'place_restore')
          AND asset_type = 'place'
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

-- Keep every existing purchase, gift, PayPal event, and dispute branch unchanged;
-- only the live fee-credit operation allowlist grows.
CREATE OR REPLACE FUNCTION validate_city_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  related_spend city_credit_entries%ROWTYPE;
  related_purchase city_credit_entries%ROWTYPE;
  gift city_credit_gifts%ROWTYPE;
  dispute paypal_credit_disputes%ROWTYPE;
  dispute_event paypal_credit_dispute_events%ROWTYPE;
  dispute_review paypal_credit_dispute_reviews%ROWTYPE;
  capture_event paypal_credit_events%ROWTYPE;
BEGIN
  IF NEW.entry_kind IN ('spend', 'return') THEN
    SELECT * INTO attempt FROM payment_attempts
    WHERE public_id = NEW.payment_attempt_id FOR KEY SHARE;
    IF NOT FOUND OR attempt.method <> 'credit' OR attempt.actor_id <> NEW.resident_id
      OR attempt.amount_units <> NEW.amount_units
      OR attempt.operation NOT IN (
        'frontier', 'kind_invention', 'kind_revision',
        'place_rename', 'place_retire', 'place_restore'
      )
      OR (NEW.entry_kind = 'spend' AND attempt.status NOT IN ('settling', 'payment_pending'))
      OR (NEW.entry_kind = 'return' AND attempt.status NOT IN (
        'settling', 'payment_pending', 'credit_returned'
      )) THEN
      RAISE EXCEPTION 'city credit entry does not match its live credit attempt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.entry_kind = 'return' THEN
      SELECT * INTO related_spend FROM city_credit_entries
      WHERE id = NEW.related_spend_id FOR KEY SHARE;
      IF NOT FOUND OR related_spend.entry_kind <> 'spend'
        OR related_spend.resident_id <> NEW.resident_id
        OR related_spend.amount_units <> NEW.amount_units
        OR related_spend.payment_attempt_id IS DISTINCT FROM NEW.payment_attempt_id THEN
        RAISE EXCEPTION 'city credit return does not match one exact spend'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.entry_kind = 'paypal_dispute_reviewed' THEN
    SELECT * INTO related_purchase FROM city_credit_entries
    WHERE id = NEW.related_purchase_id FOR KEY SHARE;
    SELECT * INTO dispute FROM paypal_credit_disputes
    WHERE dispute_id = NEW.paypal_dispute_id FOR KEY SHARE;
    SELECT * INTO dispute_review FROM paypal_credit_dispute_reviews
    WHERE id = NEW.paypal_dispute_review_id FOR KEY SHARE;
    SELECT * INTO capture_event FROM paypal_credit_events capture
    WHERE capture.purchase_entry_id = related_purchase.id
      AND EXISTS (
        SELECT 1 FROM paypal_credit_dispute_events binding_event
        WHERE binding_event.dispute_id = dispute_review.dispute_id
          AND capture.remote_resource_id = ANY(binding_event.transaction_capture_ids)
      )
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    FOR KEY SHARE;
    IF related_purchase.id IS NULL OR dispute.dispute_id IS NULL
      OR dispute_review.id IS NULL OR capture_event.event_id IS NULL
      OR related_purchase.entry_kind <> 'purchase'
      OR related_purchase.purchase_kind <> 'paypal'
      OR dispute_review.dispute_id <> dispute.dispute_id
      OR related_purchase.amount_units <> NEW.amount_units
      OR NEW.gift_id IS DISTINCT FROM related_purchase.gift_id THEN
      RAISE EXCEPTION 'founder dispute review receipt does not match its exact credit purchase'
        USING ERRCODE = '23514';
    END IF;
    IF related_purchase.gift_id IS NULL THEN
      IF NEW.resident_id <> related_purchase.resident_id THEN
        RAISE EXCEPTION 'founder dispute review receipt resident does not match its purchase'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT * INTO gift FROM city_credit_gifts
      WHERE id = related_purchase.gift_id FOR KEY SHARE;
      IF gift.id IS NULL OR gift.recipient_id <> NEW.resident_id THEN
        RAISE EXCEPTION 'founder dispute review receipt resident does not match its gift'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.entry_kind = 'purchase' AND NEW.purchase_kind = 'x402' THEN
    SELECT * INTO attempt FROM payment_attempts
    WHERE public_id = NEW.payment_attempt_id FOR KEY SHARE;
    IF NOT FOUND OR attempt.operation <> 'credit_purchase' OR attempt.method <> 'x402'
      OR attempt.actor_id <> NEW.resident_id OR attempt.amount_units <> NEW.amount_units
      OR attempt.status <> 'payment_pending' OR attempt.tx_hash IS NULL
      OR attempt.finalized_block_number IS NULL OR attempt.finalized_block_hash IS NULL
      OR attempt.finalized_block_time IS NULL OR attempt.finalized_at IS NULL THEN
      RAISE EXCEPTION 'credit purchase receipt does not match its finalized payment'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.entry_kind IN ('paypal_dispute_created', 'paypal_dispute_updated',
    'paypal_dispute_resolved') THEN
    SELECT * INTO related_purchase FROM city_credit_entries
    WHERE id = NEW.related_purchase_id FOR KEY SHARE;
    SELECT * INTO dispute FROM paypal_credit_disputes
    WHERE dispute_id = NEW.paypal_dispute_id FOR KEY SHARE;
    SELECT * INTO dispute_event FROM paypal_credit_dispute_events
    WHERE paypal_event_id = NEW.paypal_event_id FOR KEY SHARE;
    SELECT * INTO capture_event FROM paypal_credit_events capture
    WHERE capture.purchase_entry_id = related_purchase.id
      AND EXISTS (
        SELECT 1 FROM paypal_credit_dispute_events binding_event
        WHERE binding_event.dispute_id = dispute_event.dispute_id
          AND capture.remote_resource_id = ANY(binding_event.transaction_capture_ids)
      )
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    FOR KEY SHARE;
    IF related_purchase.id IS NULL OR dispute.dispute_id IS NULL
      OR dispute_event.paypal_event_id IS NULL OR capture_event.event_id IS NULL
      OR related_purchase.entry_kind <> 'purchase'
      OR related_purchase.purchase_kind <> 'paypal'
      OR dispute_event.dispute_id <> dispute.dispute_id
      OR dispute_event.resource_updated_at <> NEW.paypal_resource_updated_at
      OR related_purchase.amount_units <> NEW.amount_units
      OR NEW.gift_id IS DISTINCT FROM related_purchase.gift_id
      OR NEW.entry_kind IS DISTINCT FROM (CASE dispute_event.event_kind
        WHEN 'CUSTOMER.DISPUTE.CREATED' THEN 'paypal_dispute_created'
        WHEN 'CUSTOMER.DISPUTE.UPDATED' THEN 'paypal_dispute_updated'
        ELSE 'paypal_dispute_resolved'
      END) THEN
      RAISE EXCEPTION 'PayPal dispute receipt does not match its exact credit purchase'
        USING ERRCODE = '23514';
    END IF;
    IF related_purchase.gift_id IS NULL THEN
      IF NEW.resident_id <> related_purchase.resident_id THEN
        RAISE EXCEPTION 'PayPal dispute receipt resident does not match its purchase'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT * INTO gift FROM city_credit_gifts
      WHERE id = related_purchase.gift_id FOR KEY SHARE;
      IF gift.id IS NULL OR gift.recipient_id <> NEW.resident_id THEN
        RAISE EXCEPTION 'PayPal dispute receipt resident does not match its gift'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.gift_id IS NOT NULL THEN
    SELECT * INTO gift FROM city_credit_gifts WHERE id = NEW.gift_id FOR KEY SHARE;
    IF NOT FOUND OR gift.amount_units <> NEW.amount_units THEN
      RAISE EXCEPTION 'gift receipt does not match its exact purchase'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.entry_kind = 'purchase' AND (
      gift.status NOT IN ('pending', 'frozen', 'revoked', 'accepted', 'refused')
      OR gift.recipient_id <> NEW.resident_id
      OR gift.source_key IS DISTINCT FROM NEW.source_key
    ) THEN
      RAISE EXCEPTION 'gift purchase receipt does not match its gift'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_pending' AND (
      gift.recipient_id <> NEW.resident_id OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':pending:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift arrival receipt does not match its pending version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_accept' AND (
      gift.status <> 'accepted' OR gift.recipient_id <> NEW.resident_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':accept:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift acceptance receipt does not match its accepted version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_refuse' AND (
      gift.status <> 'refused' OR gift.recipient_id <> NEW.resident_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':refuse:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift refusal receipt does not match its refused version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_redirect' AND (
      gift.status <> 'pending' OR gift.version <= 1
      OR gift.recipient_id IS DISTINCT FROM NEW.counterparty_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':redirect:' || gift.version::text
      )
      OR NOT EXISTS (
        SELECT 1 FROM city_credit_entries prior
        WHERE prior.gift_id = gift.id AND prior.entry_kind = 'gift_pending'
          AND prior.resident_id = NEW.resident_id
          AND prior.amount_units = NEW.amount_units
          AND prior.source_key = (
            'gift:' || gift.public_id || ':pending:' || (gift.version - 1)::text
          )
      )
    ) THEN
      RAISE EXCEPTION 'gift redirect receipt does not match its departure and target'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

COMMIT;
