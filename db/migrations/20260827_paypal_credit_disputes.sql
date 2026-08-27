BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE residents, city_credit_accounts, city_credit_entries,
  city_credit_gifts, paypal_credit_events, events IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE city_credit_gifts
  ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

ALTER TABLE city_credit_gifts
  DROP CONSTRAINT IF EXISTS city_credit_gifts_status_check,
  DROP CONSTRAINT IF EXISTS city_credit_gifts_check;
ALTER TABLE city_credit_gifts
  ADD CONSTRAINT city_credit_gifts_status_check CHECK (
    status IN ('pending', 'accepted', 'refused', 'frozen', 'revoked')
  ),
  ADD CONSTRAINT city_credit_gifts_check CHECK (
    (status = 'pending' AND accepted_at IS NULL AND refused_at IS NULL
      AND frozen_at IS NULL AND revoked_at IS NULL)
    OR (status = 'accepted' AND accepted_at IS NOT NULL AND refused_at IS NULL
      AND frozen_at IS NULL AND revoked_at IS NULL)
    OR (status = 'refused' AND accepted_at IS NULL AND refused_at IS NOT NULL
      AND revoked_at IS NULL)
    OR (status = 'frozen' AND accepted_at IS NULL AND refused_at IS NULL
      AND frozen_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND accepted_at IS NULL AND refused_at IS NULL
      AND frozen_at IS NOT NULL AND revoked_at IS NOT NULL)
  );

ALTER TABLE city_credit_entries
  DROP CONSTRAINT IF EXISTS city_credit_entries_source_key_check;
ALTER TABLE city_credit_entries
  ADD CONSTRAINT city_credit_entries_source_key_check CHECK (
    source_key IS NULL OR (
      octet_length(source_key) BETWEEN 8 AND 300
      AND source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
    )
  );
ALTER TABLE city_credit_gifts
  DROP CONSTRAINT IF EXISTS city_credit_gifts_source_key_check;
ALTER TABLE city_credit_gifts
  ADD CONSTRAINT city_credit_gifts_source_key_check CHECK (
    octet_length(source_key) BETWEEN 8 AND 300
    AND source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
  );

CREATE OR REPLACE FUNCTION paypal_credit_capture_ids_are_canonical(
  capture_ids TEXT[]
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(capture_ids) BETWEEN 1 AND 1000
    AND NOT EXISTS (
      SELECT 1 FROM unnest(capture_ids) capture_id
      WHERE capture_id IS NULL
        OR octet_length(capture_id) NOT BETWEEN 1 AND 255
        OR capture_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    )
    AND capture_ids = ARRAY(
      SELECT DISTINCT capture_id COLLATE "C"
      FROM unnest(capture_ids) capture_id
      ORDER BY capture_id COLLATE "C"
    );
$$;

CREATE SEQUENCE IF NOT EXISTS paypal_credit_dispute_event_sequence_seq;

CREATE TABLE IF NOT EXISTS paypal_credit_disputes (
  dispute_id           TEXT PRIMARY KEY CHECK (
                         octet_length(dispute_id) BETWEEN 1 AND 255
                         AND dispute_id ~ '^[A-Za-z0-9][A-Za-z0-9-]*$'
                       ),
  state                TEXT NOT NULL CHECK (
                         state IN ('open', 'resolved_seller',
                           'resolved_against_seller', 'resolution_review')
                       ),
  paypal_status        TEXT NOT NULL CHECK (
                         paypal_status IN ('OPEN', 'WAITING_FOR_BUYER_RESPONSE',
                           'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW',
                           'RESOLVED', 'OTHER')
                       ),
  outcome_code         TEXT,
  resource_updated_at  TIMESTAMPTZ NOT NULL,
  current_event_sequence BIGINT NOT NULL DEFAULT 0,
  review_decision      TEXT,
  reviewed_at          TIMESTAMPTZ,
  opened_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT paypal_credit_disputes_state_terms_check CHECK (
    (state = 'open' AND outcome_code IS NULL AND resolved_at IS NULL
      AND review_decision IS NULL AND reviewed_at IS NULL)
    OR (state = 'resolved_seller'
      AND resolved_at IS NOT NULL AND (
        (outcome_code IN ('RESOLVED_SELLER_FAVOUR',
          'CANCELED_BY_BUYER', 'DENIED')
          AND review_decision IS NULL AND reviewed_at IS NULL)
        OR (outcome_code IN ('RESOLVED_WITH_PAYOUT', 'NONE')
          AND review_decision = 'seller_favour' AND reviewed_at IS NOT NULL)
      ))
    OR (state = 'resolved_against_seller'
      AND resolved_at IS NOT NULL AND (
        (outcome_code IN ('RESOLVED_BUYER_FAVOUR', 'ACCEPTED')
          AND review_decision IS NULL AND reviewed_at IS NULL)
        OR (outcome_code IN ('RESOLVED_WITH_PAYOUT', 'NONE')
          AND review_decision = 'buyer_favour' AND reviewed_at IS NOT NULL)
      ))
    OR (state = 'resolution_review' AND outcome_code IN (
      'RESOLVED_WITH_PAYOUT', 'NONE'
    ) AND resolved_at IS NOT NULL
      AND review_decision IS NULL AND reviewed_at IS NULL)
  )
);

ALTER TABLE paypal_credit_disputes
  ADD COLUMN IF NOT EXISTS current_event_sequence BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_decision TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE paypal_credit_disputes
  DROP CONSTRAINT IF EXISTS paypal_credit_disputes_check,
  DROP CONSTRAINT IF EXISTS paypal_credit_disputes_current_event_sequence_check,
  DROP CONSTRAINT IF EXISTS paypal_credit_disputes_review_decision_check,
  DROP CONSTRAINT IF EXISTS paypal_credit_disputes_state_terms_check;
ALTER TABLE paypal_credit_disputes
  ADD CONSTRAINT paypal_credit_disputes_current_event_sequence_check CHECK (
    current_event_sequence >= 0
  ),
  ADD CONSTRAINT paypal_credit_disputes_review_decision_check CHECK (
    review_decision IS NULL
      OR review_decision IN ('seller_favour', 'buyer_favour')
  ),
  ADD CONSTRAINT paypal_credit_disputes_state_terms_check CHECK (
    (state = 'open' AND outcome_code IS NULL AND resolved_at IS NULL
      AND review_decision IS NULL AND reviewed_at IS NULL)
    OR (state = 'resolved_seller'
      AND resolved_at IS NOT NULL AND (
        (outcome_code IN ('RESOLVED_SELLER_FAVOUR',
          'CANCELED_BY_BUYER', 'DENIED')
          AND review_decision IS NULL AND reviewed_at IS NULL)
        OR (outcome_code IN ('RESOLVED_WITH_PAYOUT', 'NONE')
          AND review_decision = 'seller_favour' AND reviewed_at IS NOT NULL)
      ))
    OR (state = 'resolved_against_seller'
      AND resolved_at IS NOT NULL AND (
        (outcome_code IN ('RESOLVED_BUYER_FAVOUR', 'ACCEPTED')
          AND review_decision IS NULL AND reviewed_at IS NULL)
        OR (outcome_code IN ('RESOLVED_WITH_PAYOUT', 'NONE')
          AND review_decision = 'buyer_favour' AND reviewed_at IS NOT NULL)
      ))
    OR (state = 'resolution_review' AND outcome_code IN (
      'RESOLVED_WITH_PAYOUT', 'NONE'
    ) AND resolved_at IS NOT NULL
      AND review_decision IS NULL AND reviewed_at IS NULL)
  );

CREATE TABLE IF NOT EXISTS paypal_credit_dispute_events (
  paypal_event_id      TEXT PRIMARY KEY CHECK (
                         octet_length(paypal_event_id) BETWEEN 1 AND 128
                         AND paypal_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
                       ),
  dispute_id           TEXT NOT NULL REFERENCES paypal_credit_disputes(dispute_id)
                         ON DELETE RESTRICT,
  event_kind           TEXT NOT NULL CHECK (event_kind IN (
                         'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED',
                         'CUSTOMER.DISPUTE.RESOLVED'
                       )),
  paypal_status        TEXT NOT NULL CHECK (
                         paypal_status IN ('OPEN', 'WAITING_FOR_BUYER_RESPONSE',
                           'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW',
                           'RESOLVED', 'OTHER')
                       ),
  outcome_code         TEXT,
  resource_updated_at  TIMESTAMPTZ NOT NULL,
  transaction_capture_ids TEXT[] NOT NULL CHECK (
                         paypal_credit_capture_ids_are_canonical(
                           transaction_capture_ids
                         )
                       ),
  event_sequence       BIGINT NOT NULL DEFAULT nextval(
                         'paypal_credit_dispute_event_sequence_seq'
                       ),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_sequence),
  CHECK (
    (event_kind <> 'CUSTOMER.DISPUTE.RESOLVED'
      AND paypal_status <> 'RESOLVED' AND outcome_code IS NULL)
    OR (event_kind = 'CUSTOMER.DISPUTE.RESOLVED'
      AND paypal_status = 'RESOLVED' AND outcome_code IN (
        'RESOLVED_BUYER_FAVOUR', 'RESOLVED_SELLER_FAVOUR',
        'RESOLVED_WITH_PAYOUT', 'CANCELED_BY_BUYER', 'ACCEPTED', 'DENIED', 'NONE'
      ))
  )
);

ALTER TABLE paypal_credit_dispute_events
  ADD COLUMN IF NOT EXISTS event_sequence BIGINT;
ALTER SEQUENCE paypal_credit_dispute_event_sequence_seq
  OWNED BY paypal_credit_dispute_events.event_sequence;
ALTER TABLE paypal_credit_dispute_events
  ALTER COLUMN event_sequence SET DEFAULT nextval(
    'paypal_credit_dispute_event_sequence_seq'
  );
UPDATE paypal_credit_dispute_events
SET event_sequence = nextval('paypal_credit_dispute_event_sequence_seq')
WHERE event_sequence IS NULL;
ALTER TABLE paypal_credit_dispute_events
  ALTER COLUMN event_sequence SET NOT NULL;
DO $drop_equal_time_event_identity$
DECLARE
  stored_constraint TEXT;
BEGIN
  SELECT constraint_name.conname INTO stored_constraint
  FROM pg_constraint constraint_name
  WHERE constraint_name.conrelid = 'paypal_credit_dispute_events'::regclass
    AND constraint_name.contype = 'u'
    AND pg_get_constraintdef(constraint_name.oid) =
      'UNIQUE (dispute_id, event_kind, resource_updated_at)'
  LIMIT 1;
  IF stored_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE paypal_credit_dispute_events DROP CONSTRAINT %I',
      stored_constraint
    );
  END IF;
END
$drop_equal_time_event_identity$;
CREATE UNIQUE INDEX IF NOT EXISTS paypal_credit_dispute_events_sequence
  ON paypal_credit_dispute_events (event_sequence);

WITH latest AS (
  SELECT DISTINCT ON (event.dispute_id)
    event.dispute_id, event.event_sequence
  FROM paypal_credit_dispute_events event
  ORDER BY event.dispute_id, event.resource_updated_at DESC,
    CASE event.event_kind
      WHEN 'CUSTOMER.DISPUTE.CREATED' THEN 1
      WHEN 'CUSTOMER.DISPUTE.UPDATED' THEN 2
      ELSE 3
    END DESC,
    event.event_sequence DESC
)
UPDATE paypal_credit_disputes dispute
SET current_event_sequence = latest.event_sequence
FROM latest
WHERE dispute.dispute_id = latest.dispute_id
  AND dispute.current_event_sequence = 0;

CREATE TABLE IF NOT EXISTS paypal_credit_dispute_reviews (
  id              BIGSERIAL PRIMARY KEY,
  dispute_id      TEXT NOT NULL UNIQUE
                    REFERENCES paypal_credit_disputes(dispute_id)
                    ON DELETE RESTRICT,
  founder_id      INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT
                    CHECK (founder_id = 1),
  decision        TEXT NOT NULL CHECK (
                    decision IN ('seller_favour', 'buyer_favour')
                  ),
  public_event_id INTEGER NOT NULL UNIQUE REFERENCES events(id)
                    ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE city_credit_entries
  ADD COLUMN IF NOT EXISTS related_purchase_id BIGINT
    REFERENCES city_credit_entries(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS paypal_dispute_id TEXT
    REFERENCES paypal_credit_disputes(dispute_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS paypal_event_id TEXT
    REFERENCES paypal_credit_dispute_events(paypal_event_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS paypal_dispute_review_id BIGINT
    REFERENCES paypal_credit_dispute_reviews(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS paypal_resource_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS application_outcome TEXT;

CREATE TABLE IF NOT EXISTS founder_city_credit_notes (
  id          BIGSERIAL PRIMARY KEY,
  founder_id  INTEGER NOT NULL DEFAULT 1 REFERENCES residents(id) ON DELETE RESTRICT
                CHECK (founder_id = 1),
  dispute_id  TEXT NOT NULL UNIQUE REFERENCES paypal_credit_disputes(dispute_id)
                ON DELETE RESTRICT,
  body        TEXT NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 2000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paypal_credit_disputes_updated
  ON paypal_credit_disputes (updated_at DESC, dispute_id);
CREATE INDEX IF NOT EXISTS paypal_credit_dispute_events_capture_ids
  ON paypal_credit_dispute_events USING gin (transaction_capture_ids);
CREATE INDEX IF NOT EXISTS city_credit_gifts_recipient_frozen
  ON city_credit_gifts (recipient_id, id DESC) WHERE status = 'frozen';
DROP INDEX IF EXISTS city_credit_entries_paypal_dispute_event;
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_paypal_dispute_purchase
  ON city_credit_entries (paypal_event_id, related_purchase_id)
  WHERE paypal_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_paypal_review_purchase
  ON city_credit_entries (paypal_dispute_review_id, related_purchase_id)
  WHERE paypal_dispute_review_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paypal_credit_events_credited_capture
  ON paypal_credit_events (remote_resource_id)
  WHERE outcome = 'credited' AND event_kind = 'PAYMENT.CAPTURE.COMPLETED';

ALTER TABLE city_credit_entries
  DROP CONSTRAINT IF EXISTS city_credit_entries_entry_kind_check,
  DROP CONSTRAINT IF EXISTS city_credit_entries_check;
ALTER TABLE city_credit_entries
  ADD CONSTRAINT city_credit_entries_entry_kind_check CHECK (entry_kind IN (
    'founder_issue', 'purchase', 'gift_pending', 'gift_accept',
    'gift_refuse', 'gift_redirect', 'spend', 'return',
    'admin_credit', 'admin_debit', 'paypal_dispute_created',
    'paypal_dispute_updated', 'paypal_dispute_resolved',
    'paypal_dispute_reviewed'
  )),
  ADD CONSTRAINT city_credit_entries_check CHECK (
    (
      entry_kind IN ('founder_issue', 'admin_credit', 'admin_debit')
      AND amount_units = 1000000
      AND founder_id = 1 AND source_key IS NOT NULL AND reason IS NOT NULL
      AND request_id IS NULL AND payment_attempt_id IS NULL
      AND related_spend_id IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NULL
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
    )
    OR (
      entry_kind = 'purchase'
      AND founder_id IS NULL AND source_key IS NOT NULL AND reason IS NULL
      AND request_id IS NULL AND related_spend_id IS NULL
      AND purchase_kind IN ('paypal', 'allowance', 'x402')
      AND counterparty_id IS NULL
      AND (purchase_kind <> 'allowance' OR gift_id IS NULL)
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
      AND (
        (purchase_kind = 'x402' AND payment_attempt_id IS NOT NULL AND gift_id IS NULL)
        OR (purchase_kind IN ('paypal', 'allowance') AND payment_attempt_id IS NULL)
      )
    )
    OR (
      entry_kind = 'spend'
      AND amount_units = 1000000
      AND founder_id IS NULL AND source_key IS NULL AND request_id IS NOT NULL
      AND payment_attempt_id IS NOT NULL AND related_spend_id IS NULL
      AND reason IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NULL
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
    )
    OR (
      entry_kind = 'return'
      AND amount_units = 1000000
      AND founder_id IS NULL AND source_key IS NULL AND request_id IS NULL
      AND payment_attempt_id IS NOT NULL AND related_spend_id IS NOT NULL
      AND reason IS NOT NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NULL
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
    )
    OR (
      entry_kind IN ('gift_pending', 'gift_accept', 'gift_refuse')
      AND founder_id IS NULL AND source_key IS NOT NULL AND request_id IS NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NOT NULL
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
    )
    OR (
      entry_kind = 'gift_redirect'
      AND founder_id IS NULL AND source_key IS NOT NULL AND request_id IS NOT NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NOT NULL AND gift_id IS NOT NULL
      AND related_purchase_id IS NULL AND paypal_dispute_id IS NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND application_outcome IS NULL
    )
    OR (
      entry_kind IN ('paypal_dispute_created', 'paypal_dispute_updated',
        'paypal_dispute_resolved')
      AND founder_id IS NULL AND source_key IS NULL AND request_id IS NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NOT NULL AND purchase_kind IS NULL AND counterparty_id IS NULL
      AND related_purchase_id IS NOT NULL AND paypal_dispute_id IS NOT NULL
      AND paypal_event_id IS NOT NULL AND paypal_resource_updated_at IS NOT NULL
      AND application_outcome IN (
        'dispute_open_gift_frozen', 'dispute_open_refused_gift_blocked',
        'dispute_open_credit_retained', 'dispute_resolved_gift_pending',
        'dispute_resolved_refused_gift',
        'dispute_resolved_gift_still_frozen',
        'dispute_resolved_gift_revoked',
        'dispute_resolved_credit_retained',
        'dispute_resolution_needs_operator_review',
        'dispute_stale_event_ignored'
      )
    )
    OR (
      entry_kind = 'paypal_dispute_reviewed'
      AND founder_id IS NULL AND source_key IS NULL AND request_id IS NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NOT NULL AND purchase_kind IS NULL AND counterparty_id IS NULL
      AND related_purchase_id IS NOT NULL AND paypal_dispute_id IS NOT NULL
      AND paypal_event_id IS NULL AND paypal_resource_updated_at IS NULL
      AND paypal_dispute_review_id IS NOT NULL
      AND application_outcome IN (
        'founder_review_gift_pending',
        'founder_review_refused_gift_redirectable',
        'founder_review_gift_still_frozen',
        'founder_review_gift_still_revoked',
        'founder_review_gift_revoked',
        'founder_review_credit_retained'
      )
    )
  );

ALTER TABLE city_credit_entries
  DROP CONSTRAINT IF EXISTS city_credit_entries_paypal_review_source_check;
ALTER TABLE city_credit_entries
  ADD CONSTRAINT city_credit_entries_paypal_review_source_check CHECK (
    (entry_kind = 'paypal_dispute_reviewed')
      = (paypal_dispute_review_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION protect_paypal_credit_dispute()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PayPal credit dispute history cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.dispute_id, NEW.created_at, NEW.opened_at)
    IS DISTINCT FROM ROW(OLD.dispute_id, OLD.created_at, OLD.opened_at) THEN
    RAISE EXCEPTION 'PayPal dispute identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.resource_updated_at < OLD.resource_updated_at
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'PayPal dispute time cannot move backward'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.review_decision IS NOT NULL AND ROW(
    NEW.state, NEW.paypal_status, NEW.outcome_code,
    NEW.resource_updated_at, NEW.current_event_sequence,
    NEW.review_decision, NEW.reviewed_at, NEW.resolved_at
  ) IS DISTINCT FROM ROW(
    OLD.state, OLD.paypal_status, OLD.outcome_code,
    OLD.resource_updated_at, OLD.current_event_sequence,
    OLD.review_decision, OLD.reviewed_at, OLD.resolved_at
  ) THEN
    RAISE EXCEPTION 'founder PayPal dispute review is terminal'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'resolved_against_seller'
    AND NEW.state <> 'resolved_against_seller' THEN
    RAISE EXCEPTION 'adverse PayPal dispute custody is terminal'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_disputes_guard ON paypal_credit_disputes;
CREATE TRIGGER paypal_credit_disputes_guard
  BEFORE UPDATE OR DELETE ON paypal_credit_disputes
  FOR EACH ROW EXECUTE FUNCTION protect_paypal_credit_dispute();

DROP TRIGGER IF EXISTS paypal_credit_dispute_events_append_only
  ON paypal_credit_dispute_events;
CREATE TRIGGER paypal_credit_dispute_events_append_only
  BEFORE UPDATE OR DELETE ON paypal_credit_dispute_events
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS paypal_credit_dispute_reviews_append_only
  ON paypal_credit_dispute_reviews;
CREATE TRIGGER paypal_credit_dispute_reviews_append_only
  BEFORE UPDATE OR DELETE ON paypal_credit_dispute_reviews
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS founder_city_credit_notes_append_only
  ON founder_city_credit_notes;
CREATE TRIGGER founder_city_credit_notes_append_only
  BEFORE UPDATE OR DELETE ON founder_city_credit_notes
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

CREATE OR REPLACE FUNCTION protect_city_credit_gift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'city credit gift history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.id, NEW.public_id, NEW.amount_units, NEW.source_key,
    NEW.claim_token_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.public_id, OLD.amount_units, OLD.source_key,
    OLD.claim_token_hash, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'city credit gift purchase terms are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.source_entry_id IS NOT NULL
    AND NEW.source_entry_id IS DISTINCT FROM OLD.source_entry_id THEN
    RAISE EXCEPTION 'city credit gift purchase receipt is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('accepted', 'revoked') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'accepted or revoked city credit gift is terminal' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN (
    'pending', 'accepted', 'refused', 'frozen', 'revoked'
  ) THEN
    RAISE EXCEPTION 'invalid city credit gift transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'refused' AND NEW.status NOT IN ('refused', 'pending', 'revoked') THEN
    RAISE EXCEPTION 'invalid city credit gift transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'frozen'
    AND NEW.status NOT IN ('frozen', 'pending', 'refused', 'revoked') THEN
    RAISE EXCEPTION 'invalid frozen city credit gift transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'refused' AND NEW.status = 'pending'
    AND NEW.recipient_id IS NOT DISTINCT FROM OLD.recipient_id THEN
    RAISE EXCEPTION 'a refused city credit gift becomes pending only by redirect'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'refused'
    AND NEW.status = 'pending'
    AND (
      OLD.frozen_at IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM paypal_credit_disputes dispute
        JOIN paypal_credit_dispute_events event
          ON event.dispute_id = dispute.dispute_id
        JOIN paypal_credit_events capture
          ON capture.remote_resource_id = ANY(event.transaction_capture_ids)
          AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
          AND capture.outcome = 'credited'
        JOIN city_credit_entries purchase
          ON purchase.id = capture.purchase_entry_id
        WHERE dispute.state IN ('open', 'resolution_review')
          AND purchase.gift_id = OLD.id
      )
    ) THEN
    RAISE EXCEPTION 'gift cannot be redirected because a payment dispute is open on the purchase that funded it or its ambiguous outcome awaits founder review'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    AND NOT (OLD.status IN ('pending', 'refused') AND NEW.status = 'pending') THEN
    RAISE EXCEPTION 'only a pending or refused gift may be redirected'
      USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    AND NEW.version <> OLD.version + 1
  ) OR (
    NEW.recipient_id IS NOT DISTINCT FROM OLD.recipient_id
    AND NEW.version <> OLD.version
  ) THEN
    RAISE EXCEPTION 'city credit gift version must advance exactly once per redirect'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'city credit gift update time cannot move backward'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

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
      OR attempt.operation NOT IN ('frontier', 'kind_invention', 'kind_revision')
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

CREATE OR REPLACE FUNCTION apply_city_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta_units BIGINT;
BEGIN
  delta_units := CASE
    WHEN NEW.entry_kind IN ('founder_issue', 'return', 'admin_credit', 'gift_accept')
      THEN NEW.amount_units
    WHEN NEW.entry_kind = 'purchase' AND NEW.gift_id IS NULL THEN NEW.amount_units
    WHEN NEW.entry_kind IN ('spend', 'admin_debit') THEN -NEW.amount_units
    WHEN NEW.entry_kind IN (
      'gift_pending', 'gift_refuse', 'gift_redirect',
      'paypal_dispute_created', 'paypal_dispute_updated', 'paypal_dispute_resolved',
      'paypal_dispute_reviewed'
    ) OR (NEW.entry_kind = 'purchase' AND NEW.gift_id IS NOT NULL) THEN 0
    ELSE NULL
  END CASE;
  IF delta_units IS NULL THEN
    RAISE EXCEPTION 'unknown city credit balance effect' USING ERRCODE = '23514';
  END IF;
  INSERT INTO city_credit_accounts (resident_id, balance_units)
  VALUES (NEW.resident_id, 0) ON CONFLICT (resident_id) DO NOTHING;
  UPDATE city_credit_accounts
  SET balance_units = balance_units + delta_units, updated_at = clock_timestamp()
  WHERE resident_id = NEW.resident_id AND balance_units + delta_units >= 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient city fee credit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
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

CREATE OR REPLACE FUNCTION paypal_credit_dispute_event_lifecycle_rank(
  requested_event_kind TEXT
) RETURNS SMALLINT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE requested_event_kind
    WHEN 'CUSTOMER.DISPUTE.CREATED' THEN 1::SMALLINT
    WHEN 'CUSTOMER.DISPUTE.UPDATED' THEN 2::SMALLINT
    WHEN 'CUSTOMER.DISPUTE.RESOLVED' THEN 3::SMALLINT
    ELSE 0::SMALLINT
  END;
$$;

CREATE OR REPLACE FUNCTION require_paypal_credit_dispute_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_event paypal_credit_dispute_events%ROWTYPE;
BEGIN
  SELECT * INTO latest_event
  FROM paypal_credit_dispute_events event
  WHERE event.dispute_id = NEW.dispute_id
  ORDER BY event.resource_updated_at DESC,
    paypal_credit_dispute_event_lifecycle_rank(event.event_kind) DESC,
    event.event_sequence DESC
  LIMIT 1;
  IF latest_event.paypal_event_id IS NULL
    OR NEW.resource_updated_at <> latest_event.resource_updated_at
    OR NEW.current_event_sequence <> latest_event.event_sequence THEN
    RAISE EXCEPTION 'PayPal dispute projection is not at its latest durable lifecycle event'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.review_decision IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM paypal_credit_dispute_reviews review
      JOIN events public_event ON public_event.id = review.public_event_id
      JOIN residents founder ON founder.id = review.founder_id
      WHERE review.dispute_id = NEW.dispute_id
        AND review.founder_id = 1
        AND review.decision = NEW.review_decision
        AND public_event.kind = 'payment_repair'
        AND public_event.actor = founder.handle
        AND public_event.detail = jsonb_build_object(
          'action', 'credit_dispute_' || review.decision
        )
        AND (
          (NEW.state = 'resolved_seller'
            AND review.decision = 'seller_favour')
          OR (NEW.state = 'resolved_against_seller'
            AND review.decision = 'buyer_favour')
        )
    ) THEN
      RAISE EXCEPTION 'founder PayPal dispute projection lacks its append-only public review event'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state = 'resolved_against_seller' THEN
    IF latest_event.event_kind = 'CUSTOMER.DISPUTE.RESOLVED'
      AND latest_event.outcome_code IN ('RESOLVED_BUYER_FAVOUR', 'ACCEPTED') THEN
      IF NEW.paypal_status <> latest_event.paypal_status
        OR NEW.outcome_code IS DISTINCT FROM latest_event.outcome_code THEN
        RAISE EXCEPTION 'adverse PayPal dispute projection does not match its current adverse lifecycle evidence'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'adverse PayPal dispute projection lacks current adverse lifecycle evidence'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.state <> 'resolved_against_seller'
        OR NEW.paypal_status <> OLD.paypal_status
        OR NEW.outcome_code IS DISTINCT FROM OLD.outcome_code
        OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
        RAISE EXCEPTION 'adverse PayPal dispute projection lacks current adverse lifecycle evidence or immutable prior adverse custody'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF NEW.state <> 'resolved_against_seller' AND (
    latest_event.paypal_status <> NEW.paypal_status
    OR latest_event.outcome_code IS DISTINCT FROM NEW.outcome_code
    OR NOT (
      (NEW.state = 'open'
        AND latest_event.event_kind <> 'CUSTOMER.DISPUTE.RESOLVED')
      OR (NEW.state = 'resolved_seller'
        AND latest_event.event_kind = 'CUSTOMER.DISPUTE.RESOLVED'
        AND latest_event.outcome_code IN ('RESOLVED_SELLER_FAVOUR',
          'CANCELED_BY_BUYER', 'DENIED'))
      OR (NEW.state = 'resolution_review'
        AND latest_event.event_kind = 'CUSTOMER.DISPUTE.RESOLVED'
        AND latest_event.outcome_code IN ('RESOLVED_WITH_PAYOUT', 'NONE'))
    )
  ) THEN
    RAISE EXCEPTION 'PayPal dispute projection lacks its matching append-only event'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM founder_city_credit_notes note
    WHERE note.dispute_id = NEW.dispute_id
      AND note.founder_id = 1
      AND note.body = 'Verified PayPal dispute ' || NEW.dispute_id
        || ' was recorded. Inspect the private founder credit-dispute view for matched and unmatched purchases.'
  ) THEN
    RAISE EXCEPTION 'PayPal dispute projection lacks its one generic founder note'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_disputes_require_event
  ON paypal_credit_disputes;
CREATE CONSTRAINT TRIGGER paypal_credit_disputes_require_event
  AFTER INSERT OR UPDATE ON paypal_credit_disputes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_credit_dispute_projection();

CREATE OR REPLACE FUNCTION require_paypal_credit_dispute_event_receipts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH durable_capture AS (
      SELECT DISTINCT transaction.capture_id
      FROM paypal_credit_dispute_events source_event
      CROSS JOIN LATERAL unnest(source_event.transaction_capture_ids)
        AS transaction(capture_id)
      WHERE source_event.dispute_id = NEW.dispute_id
    )
    SELECT 1
    FROM paypal_credit_dispute_events event
    CROSS JOIN durable_capture transaction
    JOIN paypal_credit_events capture
      ON capture.remote_resource_id = transaction.capture_id
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
      AND purchase.entry_kind = 'purchase' AND purchase.purchase_kind = 'paypal'
    LEFT JOIN city_credit_entries receipt
      ON receipt.paypal_event_id = event.paypal_event_id
      AND receipt.related_purchase_id = purchase.id
    WHERE event.dispute_id = NEW.dispute_id AND receipt.id IS NULL
  ) THEN
    RAISE EXCEPTION 'PayPal dispute event matrix lacks a local purchase receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_dispute_events_require_receipts
  ON paypal_credit_dispute_events;
CREATE CONSTRAINT TRIGGER paypal_credit_dispute_events_require_receipts
  AFTER INSERT ON paypal_credit_dispute_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_credit_dispute_event_receipts();

CREATE OR REPLACE FUNCTION require_paypal_credit_dispute_review_receipts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM paypal_credit_disputes dispute
    WHERE dispute.dispute_id = NEW.dispute_id
      AND dispute.review_decision = NEW.decision
      AND (
        (NEW.decision = 'seller_favour' AND dispute.state = 'resolved_seller')
        OR (NEW.decision = 'buyer_favour'
          AND dispute.state = 'resolved_against_seller')
      )
  ) THEN
    RAISE EXCEPTION 'founder dispute review lacks its terminal projection'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH durable_capture AS (
      SELECT DISTINCT transaction.capture_id
      FROM paypal_credit_dispute_events source_event
      CROSS JOIN LATERAL unnest(source_event.transaction_capture_ids)
        AS transaction(capture_id)
      WHERE source_event.dispute_id = NEW.dispute_id
    )
    SELECT 1
    FROM durable_capture transaction
    JOIN paypal_credit_events capture
      ON capture.remote_resource_id = transaction.capture_id
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
      AND purchase.entry_kind = 'purchase' AND purchase.purchase_kind = 'paypal'
    LEFT JOIN city_credit_entries receipt
      ON receipt.paypal_dispute_review_id = NEW.id
      AND receipt.related_purchase_id = purchase.id
    WHERE receipt.id IS NULL
  ) THEN
    RAISE EXCEPTION 'founder dispute review lacks a local purchase receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_dispute_reviews_require_receipts
  ON paypal_credit_dispute_reviews;
CREATE CONSTRAINT TRIGGER paypal_credit_dispute_reviews_require_receipts
  AFTER INSERT ON paypal_credit_dispute_reviews
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_credit_dispute_review_receipts();

CREATE OR REPLACE FUNCTION require_paypal_capture_dispute_receipts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome = 'credited'
    AND NEW.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
    AND (EXISTS (
      SELECT 1 FROM paypal_credit_dispute_events dispute_event
      LEFT JOIN city_credit_entries receipt
        ON receipt.paypal_event_id = dispute_event.paypal_event_id
        AND receipt.related_purchase_id = NEW.purchase_entry_id
      WHERE dispute_event.dispute_id IN (
        SELECT source_event.dispute_id
        FROM paypal_credit_dispute_events source_event
        WHERE NEW.remote_resource_id = ANY(source_event.transaction_capture_ids)
      )
        AND receipt.id IS NULL
    ) OR EXISTS (
      SELECT 1 FROM paypal_credit_dispute_reviews review
      LEFT JOIN city_credit_entries receipt
        ON receipt.paypal_dispute_review_id = review.id
        AND receipt.related_purchase_id = NEW.purchase_entry_id
      WHERE review.dispute_id IN (
        SELECT source_event.dispute_id
        FROM paypal_credit_dispute_events source_event
        WHERE NEW.remote_resource_id = ANY(source_event.transaction_capture_ids)
      )
        AND receipt.id IS NULL
    )) THEN
    RAISE EXCEPTION 'credited PayPal capture lacks its staged dispute receipts'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_events_require_dispute_receipts
  ON paypal_credit_events;
CREATE CONSTRAINT TRIGGER paypal_credit_events_require_dispute_receipts
  AFTER INSERT ON paypal_credit_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_capture_dispute_receipts();

CREATE OR REPLACE FUNCTION reconcile_paypal_credit_dispute(
  requested_dispute_id TEXT
) RETURNS INTEGER LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  projection paypal_credit_disputes%ROWTYPE;
  current_event paypal_credit_dispute_events%ROWTYPE;
  binding RECORD;
  stored_gift city_credit_gifts%ROWTYPE;
  receipt_kind TEXT;
  receipt_outcome TEXT;
  receipt_reason TEXT;
  has_other_open BOOLEAN;
  inserted_count INTEGER := 0;
BEGIN
  SELECT * INTO projection FROM paypal_credit_disputes dispute
  WHERE dispute.dispute_id = requested_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PayPal dispute projection was not found'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO current_event FROM paypal_credit_dispute_events event
  WHERE event.event_sequence = projection.current_event_sequence;
  IF NOT FOUND OR current_event.dispute_id <> requested_dispute_id THEN
    RAISE EXCEPTION 'PayPal dispute projection has no current lifecycle event'
      USING ERRCODE = '55000';
  END IF;

  FOR binding IN
    WITH durable_capture AS (
      SELECT DISTINCT transaction.capture_id
      FROM paypal_credit_dispute_events source_event
      CROSS JOIN LATERAL unnest(source_event.transaction_capture_ids)
        AS transaction(capture_id)
      WHERE source_event.dispute_id = requested_dispute_id
    ), source_binding AS (
      SELECT event.paypal_event_id, NULL::BIGINT AS review_id,
        event.event_kind, event.resource_updated_at, event.event_sequence,
        false AS is_review
      FROM paypal_credit_dispute_events event
      WHERE event.dispute_id = requested_dispute_id
      UNION ALL
      SELECT NULL::TEXT, review.id, 'FOUNDER.DISPUTE.REVIEWED',
        NULL::TIMESTAMPTZ, NULL::BIGINT, true
      FROM paypal_credit_dispute_reviews review
      WHERE review.dispute_id = requested_dispute_id
    )
    SELECT source_binding.*, purchase.id AS purchase_id,
      purchase.resident_id, purchase.amount_units, purchase.gift_id
    FROM source_binding
    CROSS JOIN durable_capture transaction
    JOIN paypal_credit_events capture
      ON capture.remote_resource_id = transaction.capture_id
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    JOIN city_credit_entries purchase
      ON purchase.id = capture.purchase_entry_id
      AND purchase.entry_kind = 'purchase'
      AND purchase.purchase_kind = 'paypal'
    WHERE NOT EXISTS (
        SELECT 1 FROM city_credit_entries receipt
        WHERE receipt.related_purchase_id = purchase.id
          AND (
            (source_binding.paypal_event_id IS NOT NULL
              AND receipt.paypal_event_id = source_binding.paypal_event_id)
            OR (source_binding.review_id IS NOT NULL
              AND receipt.paypal_dispute_review_id = source_binding.review_id)
          )
      )
    ORDER BY source_binding.is_review,
      source_binding.resource_updated_at NULLS LAST,
      paypal_credit_dispute_event_lifecycle_rank(source_binding.event_kind),
      source_binding.event_sequence, purchase.id
  LOOP
    stored_gift := NULL;
    has_other_open := false;
    IF binding.gift_id IS NOT NULL THEN
      SELECT * INTO stored_gift FROM city_credit_gifts gift
      WHERE gift.id = binding.gift_id FOR UPDATE;
    END IF;

    IF NOT binding.is_review AND ROW(
      binding.resource_updated_at,
      paypal_credit_dispute_event_lifecycle_rank(binding.event_kind),
      binding.event_sequence
    ) < ROW(
      current_event.resource_updated_at,
      paypal_credit_dispute_event_lifecycle_rank(current_event.event_kind),
      current_event.event_sequence
    ) THEN
      receipt_outcome := 'dispute_stale_event_ignored';
    ELSIF projection.state = 'open' THEN
      IF stored_gift.id IS NOT NULL AND stored_gift.status = 'pending' THEN
        UPDATE city_credit_gifts gift
        SET status = 'frozen', frozen_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
        receipt_outcome := 'dispute_open_gift_frozen';
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'frozen' THEN
        receipt_outcome := 'dispute_open_gift_frozen';
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'refused' THEN
        UPDATE city_credit_gifts gift
        SET frozen_at = coalesce(gift.frozen_at, clock_timestamp()),
          updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
        receipt_outcome := 'dispute_open_refused_gift_blocked';
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'revoked' THEN
        receipt_outcome := 'dispute_resolved_gift_revoked';
      ELSE
        receipt_outcome := 'dispute_open_credit_retained';
      END IF;
    ELSIF projection.state = 'resolution_review' THEN
      IF stored_gift.id IS NOT NULL AND stored_gift.status = 'pending' THEN
        UPDATE city_credit_gifts gift
        SET status = 'frozen', frozen_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'refused' THEN
        UPDATE city_credit_gifts gift
        SET frozen_at = coalesce(gift.frozen_at, clock_timestamp()),
          updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
      END IF;
      receipt_outcome := 'dispute_resolution_needs_operator_review';
    ELSIF projection.state = 'resolved_seller' THEN
      IF stored_gift.id IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM paypal_credit_disputes other
          JOIN paypal_credit_dispute_events other_event
            ON other_event.dispute_id = other.dispute_id
          JOIN paypal_credit_events capture
            ON capture.remote_resource_id = ANY(other_event.transaction_capture_ids)
            AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
            AND capture.outcome = 'credited'
          JOIN city_credit_entries purchase
            ON purchase.id = capture.purchase_entry_id
          WHERE other.dispute_id <> requested_dispute_id
            AND other.state IN ('open', 'resolution_review')
            AND purchase.gift_id = stored_gift.id
        ) INTO has_other_open;
      END IF;
      IF stored_gift.id IS NOT NULL AND stored_gift.status = 'frozen' THEN
        IF has_other_open THEN
          receipt_outcome := 'dispute_resolved_gift_still_frozen';
        ELSE
          UPDATE city_credit_gifts gift
          SET status = 'pending', frozen_at = NULL, updated_at = clock_timestamp()
          WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
          receipt_outcome := 'dispute_resolved_gift_pending';
        END IF;
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'refused' THEN
        IF has_other_open THEN
          receipt_outcome := 'dispute_resolved_gift_still_frozen';
        ELSE
          UPDATE city_credit_gifts gift
          SET frozen_at = NULL, updated_at = clock_timestamp()
          WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
          receipt_outcome := 'dispute_resolved_refused_gift';
        END IF;
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'pending' THEN
        receipt_outcome := 'dispute_resolved_gift_pending';
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'revoked' THEN
        receipt_outcome := 'dispute_resolved_gift_revoked';
      ELSE
        receipt_outcome := 'dispute_resolved_credit_retained';
      END IF;
    ELSE
      IF stored_gift.id IS NOT NULL
        AND stored_gift.status IN ('pending', 'refused', 'frozen') THEN
        UPDATE city_credit_gifts gift
        SET status = 'revoked', accepted_at = NULL, refused_at = NULL,
          frozen_at = coalesce(gift.frozen_at, clock_timestamp()),
          revoked_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id RETURNING gift.* INTO stored_gift;
        receipt_outcome := 'dispute_resolved_gift_revoked';
      ELSIF stored_gift.id IS NOT NULL AND stored_gift.status = 'revoked' THEN
        receipt_outcome := 'dispute_resolved_gift_revoked';
      ELSE
        receipt_outcome := 'dispute_resolved_credit_retained';
      END IF;
    END IF;

    IF binding.is_review THEN
      receipt_kind := 'paypal_dispute_reviewed';
      receipt_outcome := CASE receipt_outcome
        WHEN 'dispute_resolved_gift_pending' THEN 'founder_review_gift_pending'
        WHEN 'dispute_resolved_refused_gift' THEN
          'founder_review_refused_gift_redirectable'
        WHEN 'dispute_resolved_gift_still_frozen' THEN
          'founder_review_gift_still_frozen'
        WHEN 'dispute_resolved_gift_revoked' THEN CASE
          WHEN projection.review_decision = 'seller_favour'
            THEN 'founder_review_gift_still_revoked'
          ELSE 'founder_review_gift_revoked'
        END
        ELSE 'founder_review_credit_retained'
      END;
      receipt_reason := CASE receipt_outcome
        WHEN 'founder_review_gift_pending' THEN
          'Founder resident #1 chose seller favour for the ambiguous PayPal outcome. This gift is pending again.'
        WHEN 'founder_review_refused_gift_redirectable' THEN
          'Founder resident #1 chose seller favour for the ambiguous PayPal outcome. This refused gift is redirectable again.'
        WHEN 'founder_review_gift_still_frozen' THEN
          'Founder resident #1 chose seller favour for this ambiguous PayPal outcome, but another payment dispute still blocks the gift.'
        WHEN 'founder_review_gift_still_revoked' THEN
          'Founder resident #1 chose seller favour for the ambiguous PayPal outcome. Another dispute already permanently revoked this gift.'
        WHEN 'founder_review_gift_revoked' THEN
          'Founder resident #1 chose buyer favour for the ambiguous PayPal outcome. This unaccepted gift is permanently revoked.'
        ELSE
          'Founder resident #1 chose an outcome after credit delivery. Delivered credit was not removed.'
      END;
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, reason, gift_id,
        related_purchase_id, paypal_dispute_id, paypal_dispute_review_id,
        application_outcome
      ) VALUES (
        coalesce(stored_gift.recipient_id, binding.resident_id),
        receipt_kind, binding.amount_units, receipt_reason, binding.gift_id,
        binding.purchase_id, requested_dispute_id, binding.review_id,
        receipt_outcome
      ) ON CONFLICT (paypal_dispute_review_id, related_purchase_id)
        WHERE paypal_dispute_review_id IS NOT NULL DO NOTHING;
    ELSE
      receipt_kind := CASE binding.event_kind
        WHEN 'CUSTOMER.DISPUTE.CREATED' THEN 'paypal_dispute_created'
        WHEN 'CUSTOMER.DISPUTE.UPDATED' THEN 'paypal_dispute_updated'
        ELSE 'paypal_dispute_resolved'
      END;
      receipt_reason := CASE receipt_outcome
        WHEN 'dispute_open_gift_frozen' THEN
          'A PayPal payment dispute is open on the purchase that funded this gift. The gift is frozen.'
        WHEN 'dispute_open_refused_gift_blocked' THEN
          'A PayPal payment dispute is open on the purchase that funded this refused gift. Redirect is blocked.'
        WHEN 'dispute_open_credit_retained' THEN
          'A PayPal payment dispute is open. Delivered credit was not removed.'
        WHEN 'dispute_resolved_gift_pending' THEN
          'The PayPal dispute was resolved for the city seller. This gift is pending again.'
        WHEN 'dispute_resolved_refused_gift' THEN
          'The PayPal dispute was resolved for the city seller. This gift remains refused and redirectable.'
        WHEN 'dispute_resolved_gift_still_frozen' THEN
          'This PayPal dispute was resolved for the city seller, but another dispute still blocks the gift.'
        WHEN 'dispute_resolved_gift_revoked' THEN
          'A PayPal dispute was resolved against the city seller. This unaccepted gift is permanently revoked.'
        WHEN 'dispute_resolved_credit_retained' THEN
          'A PayPal dispute was resolved after credit delivery. Delivered credit was not removed.'
        WHEN 'dispute_resolution_needs_operator_review' THEN
          'PayPal resolved this dispute ambiguously. Founder resident #1 must choose seller_favour or buyer_favour; unaccepted custody remains blocked.'
        ELSE
          'This older PayPal dispute event was recorded but did not change current credit custody.'
      END;
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, reason, gift_id,
        related_purchase_id, paypal_dispute_id, paypal_event_id,
        paypal_resource_updated_at, application_outcome
      ) VALUES (
        coalesce(stored_gift.recipient_id, binding.resident_id),
        receipt_kind, binding.amount_units, receipt_reason, binding.gift_id,
        binding.purchase_id, requested_dispute_id, binding.paypal_event_id,
        binding.resource_updated_at, receipt_outcome
      ) ON CONFLICT (paypal_event_id, related_purchase_id)
        WHERE paypal_event_id IS NOT NULL DO NOTHING;
    END IF;
    IF FOUND THEN inserted_count := inserted_count + 1; END IF;
  END LOOP;
  RETURN inserted_count;
END
$$;

CREATE OR REPLACE FUNCTION apply_paypal_credit_dispute(
  requested_event_id TEXT,
  requested_event_kind TEXT,
  requested_dispute_id TEXT,
  requested_capture_ids TEXT[],
  requested_paypal_status TEXT,
  requested_outcome_code TEXT,
  requested_resource_updated_at TIMESTAMPTZ
) RETURNS TABLE (
  event_id TEXT,
  dispute_id TEXT,
  state TEXT,
  paypal_status TEXT,
  outcome_code TEXT,
  resource_updated_at TIMESTAMPTZ,
  application_outcome TEXT,
  created BOOLEAN,
  transaction_count INTEGER,
  local_purchase_count INTEGER,
  receipts_created INTEGER
) LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  projection paypal_credit_disputes%ROWTYPE;
  stored_event paypal_credit_dispute_events%ROWTYPE;
  current_event paypal_credit_dispute_events%ROWTYPE;
  requested_capture_id TEXT;
  requested_event_sequence BIGINT;
  desired_state TEXT;
  receipt_outcome_min TEXT;
  receipt_outcome_max TEXT;
  all_frozen BOOLEAN;
  all_stale BOOLEAN;
  all_review BOOLEAN;
  receipts_before INTEGER;
  durable_capture_count INTEGER;
  was_created BOOLEAN := false;
BEGIN
  IF requested_event_id IS NULL
    OR octet_length(requested_event_id) NOT BETWEEN 1 AND 128
    OR requested_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    OR requested_event_kind NOT IN ('CUSTOMER.DISPUTE.CREATED',
      'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED')
    OR requested_dispute_id IS NULL
    OR octet_length(requested_dispute_id) NOT BETWEEN 1 AND 255
    OR requested_dispute_id !~ '^[A-Za-z0-9][A-Za-z0-9-]*$'
    OR requested_capture_ids IS NULL
    OR NOT paypal_credit_capture_ids_are_canonical(requested_capture_ids)
    OR requested_paypal_status NOT IN ('OPEN', 'WAITING_FOR_BUYER_RESPONSE',
      'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW', 'RESOLVED', 'OTHER')
    OR requested_resource_updated_at IS NULL
    OR (requested_event_kind = 'CUSTOMER.DISPUTE.RESOLVED' AND (
      requested_paypal_status <> 'RESOLVED'
      OR requested_outcome_code NOT IN ('RESOLVED_BUYER_FAVOUR',
        'RESOLVED_SELLER_FAVOUR', 'RESOLVED_WITH_PAYOUT',
        'CANCELED_BY_BUYER', 'ACCEPTED', 'DENIED', 'NONE')
    ))
    OR (requested_event_kind <> 'CUSTOMER.DISPUTE.RESOLVED' AND (
      requested_paypal_status = 'RESOLVED' OR requested_outcome_code IS NOT NULL
    )) THEN
    RAISE EXCEPTION 'PayPal dispute event input is invalid'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    '1f3d9/paypal-credit/dispute-reconciliation', 0
  ));
  SELECT count(DISTINCT transaction.capture_id)::INTEGER
  INTO durable_capture_count
  FROM (
    SELECT unnest(requested_capture_ids) AS capture_id
    UNION ALL
    SELECT unnest(event.transaction_capture_ids) AS capture_id
    FROM paypal_credit_dispute_events event
    WHERE event.dispute_id = requested_dispute_id
  ) transaction;
  IF durable_capture_count > 1000 THEN
    RAISE EXCEPTION 'PayPal dispute capture binding exceeds its durable limit'
      USING ERRCODE = '23514';
  END IF;

  FOR requested_capture_id IN
    SELECT DISTINCT transaction.capture_id COLLATE "C"
    FROM (
      SELECT unnest(requested_capture_ids) AS capture_id
      UNION ALL
      SELECT unnest(event.transaction_capture_ids) AS capture_id
      FROM paypal_credit_dispute_events event
      WHERE event.dispute_id = requested_dispute_id
    ) transaction
    ORDER BY transaction.capture_id COLLATE "C"
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      '1f3d9/paypal-credit/capture/' || requested_capture_id, 0
    ));
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    '1f3d9/paypal-credit/dispute-event/' || requested_event_id, 0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    '1f3d9/paypal-credit/dispute/' || requested_dispute_id, 0
  ));

  desired_state := CASE
    WHEN requested_event_kind <> 'CUSTOMER.DISPUTE.RESOLVED' THEN 'open'
    WHEN requested_outcome_code IN ('RESOLVED_SELLER_FAVOUR',
      'CANCELED_BY_BUYER', 'DENIED') THEN 'resolved_seller'
    WHEN requested_outcome_code IN ('RESOLVED_BUYER_FAVOUR', 'ACCEPTED')
      THEN 'resolved_against_seller'
    ELSE 'resolution_review'
  END;

  SELECT * INTO stored_event FROM paypal_credit_dispute_events event
  WHERE event.paypal_event_id = requested_event_id
  LIMIT 1;
  IF stored_event.paypal_event_id IS NOT NULL AND (
    stored_event.dispute_id <> requested_dispute_id
    OR stored_event.event_kind <> requested_event_kind
    OR stored_event.paypal_status <> requested_paypal_status
    OR stored_event.outcome_code IS DISTINCT FROM requested_outcome_code
    OR stored_event.resource_updated_at <> requested_resource_updated_at
    OR stored_event.transaction_capture_ids <> requested_capture_ids
  ) THEN
    RAISE EXCEPTION 'PayPal dispute event identity is bound to changed terms'
      USING ERRCODE = '23514';
  END IF;
  IF stored_event.paypal_event_id IS NULL THEN
    requested_event_sequence := nextval(
      'paypal_credit_dispute_event_sequence_seq'
    );
  END IF;

  SELECT * INTO projection FROM paypal_credit_disputes dispute
  WHERE dispute.dispute_id = requested_dispute_id FOR UPDATE;
  IF projection.dispute_id IS NULL THEN
    INSERT INTO paypal_credit_disputes (
      dispute_id, state, paypal_status, outcome_code,
      resource_updated_at, current_event_sequence, resolved_at
    ) VALUES (
      requested_dispute_id, desired_state, requested_paypal_status,
      requested_outcome_code, requested_resource_updated_at,
      requested_event_sequence,
      CASE WHEN desired_state = 'open' THEN NULL ELSE clock_timestamp() END
    ) RETURNING * INTO projection;
  END IF;

  IF stored_event.paypal_event_id IS NULL THEN
    IF projection.review_decision IS NOT NULL THEN
      RAISE EXCEPTION 'founder PayPal dispute review is terminal'
        USING ERRCODE = '55000';
    END IF;
    IF requested_event_kind = 'CUSTOMER.DISPUTE.RESOLVED' AND EXISTS (
      SELECT 1 FROM paypal_credit_dispute_events event
      WHERE event.dispute_id = requested_dispute_id
        AND event.event_kind = 'CUSTOMER.DISPUTE.RESOLVED'
        AND event.resource_updated_at = requested_resource_updated_at
        AND event.outcome_code IS DISTINCT FROM requested_outcome_code
    ) THEN
      RAISE EXCEPTION 'same-time PayPal dispute resolution has conflicting terms'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO paypal_credit_dispute_events (
      paypal_event_id, dispute_id, event_kind, paypal_status,
      outcome_code, resource_updated_at, transaction_capture_ids,
      event_sequence
    ) VALUES (
      requested_event_id, requested_dispute_id, requested_event_kind,
      requested_paypal_status, requested_outcome_code,
      requested_resource_updated_at, requested_capture_ids,
      requested_event_sequence
    ) RETURNING * INTO stored_event;
    was_created := true;

    SELECT * INTO current_event FROM paypal_credit_dispute_events event
    WHERE event.event_sequence = projection.current_event_sequence;
    IF current_event.paypal_event_id IS NULL OR ROW(
      stored_event.resource_updated_at,
      paypal_credit_dispute_event_lifecycle_rank(stored_event.event_kind),
      stored_event.event_sequence
    ) > ROW(
      current_event.resource_updated_at,
      paypal_credit_dispute_event_lifecycle_rank(current_event.event_kind),
      current_event.event_sequence
    ) THEN
      IF projection.state = 'resolved_against_seller' THEN
        UPDATE paypal_credit_disputes dispute
        SET resource_updated_at = stored_event.resource_updated_at,
          current_event_sequence = stored_event.event_sequence,
          updated_at = clock_timestamp()
        WHERE dispute.dispute_id = requested_dispute_id
        RETURNING dispute.* INTO projection;
      ELSE
        UPDATE paypal_credit_disputes dispute
        SET state = desired_state, paypal_status = requested_paypal_status,
          outcome_code = requested_outcome_code,
          resource_updated_at = requested_resource_updated_at,
          current_event_sequence = stored_event.event_sequence,
          resolved_at = CASE WHEN desired_state = 'open' THEN NULL
            ELSE clock_timestamp() END,
          updated_at = clock_timestamp()
        WHERE dispute.dispute_id = requested_dispute_id
        RETURNING dispute.* INTO projection;
      END IF;
    END IF;
  END IF;

  INSERT INTO founder_city_credit_notes (founder_id, dispute_id, body)
  VALUES (
    1, requested_dispute_id,
    'Verified PayPal dispute ' || requested_dispute_id
      || ' was recorded. Inspect the private founder credit-dispute view for matched and unmatched purchases.'
  ) ON CONFLICT (dispute_id) DO NOTHING;

  SELECT count(*)::INTEGER INTO receipts_before
  FROM city_credit_entries receipt
  WHERE receipt.paypal_event_id = stored_event.paypal_event_id
    AND EXISTS (
      SELECT 1
      FROM unnest(stored_event.transaction_capture_ids) transaction(capture_id)
      JOIN paypal_credit_events capture
        ON capture.remote_resource_id = transaction.capture_id
        AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
        AND capture.outcome = 'credited'
      WHERE capture.purchase_entry_id = receipt.related_purchase_id
    );
  PERFORM reconcile_paypal_credit_dispute(requested_dispute_id);
  SELECT count(*)::INTEGER - receipts_before INTO receipts_created
  FROM city_credit_entries receipt
  WHERE receipt.paypal_event_id = stored_event.paypal_event_id
    AND EXISTS (
      SELECT 1
      FROM unnest(stored_event.transaction_capture_ids) transaction(capture_id)
      JOIN paypal_credit_events capture
        ON capture.remote_resource_id = transaction.capture_id
        AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
        AND capture.outcome = 'credited'
      WHERE capture.purchase_entry_id = receipt.related_purchase_id
    );
  transaction_count := cardinality(stored_event.transaction_capture_ids);
  SELECT count(DISTINCT purchase.id)::INTEGER
  INTO local_purchase_count
  FROM unnest(stored_event.transaction_capture_ids) capture_id
  JOIN paypal_credit_events capture
    ON capture.remote_resource_id = capture_id
    AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
    AND capture.outcome = 'credited'
  JOIN city_credit_entries purchase
    ON purchase.id = capture.purchase_entry_id
    AND purchase.entry_kind = 'purchase' AND purchase.purchase_kind = 'paypal';

  IF local_purchase_count = 0 THEN
    application_outcome := 'dispute_awaiting_capture_receipt';
  ELSIF local_purchase_count < transaction_count THEN
    application_outcome := 'dispute_partially_applied_awaiting_capture_receipt';
  ELSE
    SELECT min(receipt.application_outcome), max(receipt.application_outcome),
      bool_and(receipt.application_outcome = 'dispute_open_gift_frozen'),
      bool_and(receipt.application_outcome = 'dispute_stale_event_ignored'),
      bool_and(receipt.application_outcome =
        'dispute_resolution_needs_operator_review')
    INTO receipt_outcome_min, receipt_outcome_max,
      all_frozen, all_stale, all_review
    FROM city_credit_entries receipt
    WHERE receipt.paypal_event_id = stored_event.paypal_event_id
      AND EXISTS (
        SELECT 1
        FROM unnest(stored_event.transaction_capture_ids) transaction(capture_id)
        JOIN paypal_credit_events capture
          ON capture.remote_resource_id = transaction.capture_id
          AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
          AND capture.outcome = 'credited'
        WHERE capture.purchase_entry_id = receipt.related_purchase_id
      );
    application_outcome := CASE
      WHEN all_stale THEN 'dispute_stale_event_ignored'
      WHEN all_review THEN 'dispute_resolution_needs_operator_review'
      WHEN local_purchase_count = 1 THEN receipt_outcome_min
      WHEN all_frozen THEN 'dispute_open_gifts_frozen'
      WHEN receipt_outcome_min = receipt_outcome_max THEN receipt_outcome_min
      WHEN projection.state IN ('open', 'resolution_review')
        THEN 'dispute_open_targets_applied'
      ELSE 'dispute_resolved_targets_applied'
    END;
  END IF;

  RETURN QUERY SELECT stored_event.paypal_event_id, projection.dispute_id,
    projection.state, projection.paypal_status, projection.outcome_code,
    projection.resource_updated_at, application_outcome, was_created,
    transaction_count, local_purchase_count, receipts_created;
END
$$;

CREATE OR REPLACE FUNCTION resolve_paypal_credit_dispute_review(
  requested_founder_id INTEGER,
  requested_dispute_id TEXT,
  requested_decision TEXT
) RETURNS TABLE (
  status TEXT,
  dispute_id TEXT,
  state TEXT,
  decision TEXT,
  application_outcome TEXT,
  created BOOLEAN,
  local_purchase_count INTEGER,
  receipts_created INTEGER
) LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  projection paypal_credit_disputes%ROWTYPE;
  stored_review paypal_credit_dispute_reviews%ROWTYPE;
  public_event_id INTEGER;
  receipts_before INTEGER;
  resolved_state TEXT;
BEGIN
  IF requested_founder_id <> 1
    OR requested_dispute_id IS NULL
    OR octet_length(requested_dispute_id) NOT BETWEEN 1 AND 255
    OR requested_dispute_id !~ '^[A-Za-z0-9][A-Za-z0-9-]*$'
    OR requested_decision NOT IN ('seller_favour', 'buyer_favour') THEN
    RAISE EXCEPTION 'founder PayPal dispute review input is invalid'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    '1f3d9/paypal-credit/dispute-reconciliation', 0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    '1f3d9/paypal-credit/dispute/' || requested_dispute_id, 0
  ));
  SELECT * INTO projection FROM paypal_credit_disputes dispute
  WHERE dispute.dispute_id = requested_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, requested_dispute_id,
      NULL::TEXT, NULL::TEXT, 'dispute_not_found'::TEXT,
      false, 0::INTEGER, 0::INTEGER;
    RETURN;
  END IF;

  SELECT * INTO stored_review FROM paypal_credit_dispute_reviews review
  WHERE review.dispute_id = requested_dispute_id FOR KEY SHARE;
  IF stored_review.id IS NOT NULL THEN
    IF stored_review.decision <> requested_decision THEN
      RETURN QUERY SELECT 'decision_conflict'::TEXT, projection.dispute_id,
        projection.state, stored_review.decision,
        'founder_dispute_resolution_conflict'::TEXT,
        false, 0::INTEGER, 0::INTEGER;
      RETURN;
    END IF;
    IF projection.review_decision <> stored_review.decision OR NOT (
      (stored_review.decision = 'seller_favour'
        AND projection.state = 'resolved_seller')
      OR (stored_review.decision = 'buyer_favour'
        AND projection.state = 'resolved_against_seller')
    ) THEN
      RAISE EXCEPTION 'founder PayPal dispute review projection is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    SELECT count(DISTINCT purchase.id)::INTEGER
    INTO local_purchase_count
    FROM paypal_credit_dispute_events event
    CROSS JOIN LATERAL unnest(event.transaction_capture_ids)
      AS transaction(capture_id)
    JOIN paypal_credit_events capture
      ON capture.remote_resource_id = transaction.capture_id
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
      AND purchase.entry_kind = 'purchase' AND purchase.purchase_kind = 'paypal'
    WHERE event.dispute_id = requested_dispute_id;
    application_outcome := CASE stored_review.decision
      WHEN 'seller_favour' THEN 'founder_review_seller_favour_applied'
      ELSE 'founder_review_buyer_favour_applied'
    END;
    RETURN QUERY SELECT 'resolved'::TEXT, projection.dispute_id,
      projection.state, stored_review.decision, application_outcome,
      false, local_purchase_count, 0::INTEGER;
    RETURN;
  END IF;

  IF projection.state <> 'resolution_review'
    OR projection.review_decision IS NOT NULL THEN
    RETURN QUERY SELECT 'not_reviewable'::TEXT, projection.dispute_id,
      projection.state, projection.review_decision,
      'dispute_not_in_resolution_review'::TEXT,
      false, 0::INTEGER, 0::INTEGER;
    RETURN;
  END IF;

  INSERT INTO events (kind, actor, detail)
  SELECT 'payment_repair', founder.handle, jsonb_build_object(
    'action', 'credit_dispute_' || requested_decision
  )
  FROM residents founder
  WHERE founder.id = requested_founder_id
  RETURNING id INTO public_event_id;
  IF public_event_id IS NULL THEN
    RAISE EXCEPTION 'founder resident #1 was not found'
      USING ERRCODE = '23503';
  END IF;
  INSERT INTO paypal_credit_dispute_reviews (
    dispute_id, founder_id, decision, public_event_id
  ) VALUES (
    requested_dispute_id, requested_founder_id,
    requested_decision, public_event_id
  ) RETURNING * INTO stored_review;

  resolved_state := CASE requested_decision
    WHEN 'seller_favour' THEN 'resolved_seller'
    ELSE 'resolved_against_seller'
  END;
  UPDATE paypal_credit_disputes dispute
  SET state = resolved_state,
    review_decision = requested_decision,
    reviewed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  WHERE dispute.dispute_id = requested_dispute_id
    AND dispute.state = 'resolution_review'
    AND dispute.review_decision IS NULL
  RETURNING dispute.* INTO projection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PayPal dispute is no longer awaiting founder review'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::INTEGER INTO receipts_before
  FROM city_credit_entries receipt
  WHERE receipt.paypal_dispute_review_id = stored_review.id;
  PERFORM reconcile_paypal_credit_dispute(requested_dispute_id);
  SELECT count(*)::INTEGER - receipts_before INTO receipts_created
  FROM city_credit_entries receipt
  WHERE receipt.paypal_dispute_review_id = stored_review.id;
  SELECT count(DISTINCT purchase.id)::INTEGER
  INTO local_purchase_count
  FROM paypal_credit_dispute_events event
  CROSS JOIN LATERAL unnest(event.transaction_capture_ids)
    AS transaction(capture_id)
  JOIN paypal_credit_events capture
    ON capture.remote_resource_id = transaction.capture_id
    AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
    AND capture.outcome = 'credited'
  JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
    AND purchase.entry_kind = 'purchase' AND purchase.purchase_kind = 'paypal'
  WHERE event.dispute_id = requested_dispute_id;
  application_outcome := CASE requested_decision
    WHEN 'seller_favour' THEN 'founder_review_seller_favour_applied'
    ELSE 'founder_review_buyer_favour_applied'
  END;
  RETURN QUERY SELECT 'resolved'::TEXT, projection.dispute_id,
    projection.state, stored_review.decision, application_outcome,
    true, local_purchase_count, receipts_created;
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
    OR stored_event.outcome <> 'credited'
  ) THEN
    RAISE EXCEPTION 'PayPal event identity is already bound to changed terms'
      USING ERRCODE = '23514';
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
