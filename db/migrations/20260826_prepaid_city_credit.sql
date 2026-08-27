BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE residents, payment_attempts, city_credit_entries, city_credit_accounts
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_operation_check;
ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_operation_check CHECK (operation IN (
    'frontier', 'kind_invention', 'kind_revision',
    'direct_sale', 'world_sale', 'credit_purchase', 'legacy'
  ));

ALTER TABLE city_credit_entries
  ADD COLUMN IF NOT EXISTS purchase_kind TEXT,
  ADD COLUMN IF NOT EXISTS counterparty_id INTEGER REFERENCES residents(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS city_credit_gifts (
  id                 BIGSERIAL PRIMARY KEY,
  public_id          TEXT NOT NULL UNIQUE CHECK (
                       public_id ~ '^city_gift_[0-9a-f]{32}$'
                     ),
  recipient_id       INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  amount_units       BIGINT NOT NULL CHECK (
                       amount_units > 0 AND amount_units <= 10000000000
                       AND amount_units % 1000000 = 0
                     ),
  source_key         TEXT NOT NULL UNIQUE CHECK (
                       octet_length(source_key) BETWEEN 8 AND 160
                       AND source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
                     ),
  source_entry_id    BIGINT UNIQUE REFERENCES city_credit_entries(id) ON DELETE RESTRICT,
  claim_token_hash   TEXT NOT NULL UNIQUE CHECK (claim_token_hash ~ '^[0-9a-f]{64}$'),
  status             TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'refused')),
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  accepted_at        TIMESTAMPTZ,
  refused_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'pending' AND accepted_at IS NULL AND refused_at IS NULL)
    OR (status = 'accepted' AND accepted_at IS NOT NULL AND refused_at IS NULL)
    OR (status = 'refused' AND accepted_at IS NULL AND refused_at IS NOT NULL)
  )
);

ALTER TABLE city_credit_entries
  ADD COLUMN IF NOT EXISTS gift_id BIGINT REFERENCES city_credit_gifts(id) ON DELETE RESTRICT;

ALTER TABLE city_credit_entries
  DROP CONSTRAINT IF EXISTS city_credit_entries_entry_kind_check,
  DROP CONSTRAINT IF EXISTS city_credit_entries_amount_units_check,
  DROP CONSTRAINT IF EXISTS city_credit_entries_check;
ALTER TABLE city_credit_entries
  ADD CONSTRAINT city_credit_entries_entry_kind_check CHECK (entry_kind IN (
    'founder_issue', 'purchase', 'gift_pending', 'gift_accept',
    'gift_refuse', 'gift_redirect', 'spend', 'return',
    'admin_credit', 'admin_debit'
  )),
  ADD CONSTRAINT city_credit_entries_amount_units_check CHECK (
    amount_units > 0 AND amount_units <= 10000000000
    AND amount_units % 1000000 = 0
  ),
  ADD CONSTRAINT city_credit_entries_check CHECK (
    (
      entry_kind IN ('founder_issue', 'admin_credit', 'admin_debit')
      AND amount_units = 1000000
      AND founder_id = 1 AND source_key IS NOT NULL AND reason IS NOT NULL
      AND request_id IS NULL AND payment_attempt_id IS NULL
      AND related_spend_id IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NULL
    )
    OR (
      entry_kind = 'purchase'
      AND founder_id IS NULL AND source_key IS NOT NULL AND reason IS NULL
      AND request_id IS NULL AND related_spend_id IS NULL
      AND purchase_kind IN ('paypal', 'allowance', 'x402')
      AND counterparty_id IS NULL
      AND (purchase_kind <> 'allowance' OR gift_id IS NULL)
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
    )
    OR (
      entry_kind = 'return'
      AND amount_units = 1000000
      AND founder_id IS NULL AND source_key IS NULL AND request_id IS NULL
      AND payment_attempt_id IS NOT NULL AND related_spend_id IS NOT NULL
      AND reason IS NOT NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NULL
    )
    OR (
      entry_kind IN ('gift_pending', 'gift_accept', 'gift_refuse')
      AND founder_id IS NULL AND source_key IS NOT NULL AND request_id IS NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NULL AND gift_id IS NOT NULL
    )
    OR (
      entry_kind = 'gift_redirect'
      AND founder_id IS NULL AND source_key IS NOT NULL AND request_id IS NOT NULL
      AND payment_attempt_id IS NULL AND related_spend_id IS NULL
      AND reason IS NULL AND purchase_kind IS NULL
      AND counterparty_id IS NOT NULL AND gift_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_one_purchase_per_attempt
  ON city_credit_entries (payment_attempt_id)
  WHERE entry_kind = 'purchase';
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_one_purchase_per_gift
  ON city_credit_entries (gift_id)
  WHERE entry_kind = 'purchase';
CREATE UNIQUE INDEX IF NOT EXISTS city_credit_entries_gift_redirect_request
  ON city_credit_entries (gift_id, request_id)
  WHERE entry_kind = 'gift_redirect';
CREATE INDEX IF NOT EXISTS city_credit_gifts_recipient_pending
  ON city_credit_gifts (recipient_id, id DESC) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION validate_city_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
  related_spend city_credit_entries%ROWTYPE;
  gift city_credit_gifts%ROWTYPE;
BEGIN
  IF NEW.entry_kind IN ('spend', 'return') THEN
    SELECT * INTO attempt
    FROM payment_attempts
    WHERE public_id = NEW.payment_attempt_id
    FOR KEY SHARE;
    IF NOT FOUND
      OR attempt.method <> 'credit'
      OR attempt.actor_id <> NEW.resident_id
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
  END IF;

  IF NEW.entry_kind = 'purchase' AND NEW.purchase_kind = 'x402' THEN
    SELECT * INTO attempt
    FROM payment_attempts
    WHERE public_id = NEW.payment_attempt_id
    FOR KEY SHARE;
    IF NOT FOUND
      OR attempt.operation <> 'credit_purchase'
      OR attempt.method <> 'x402'
      OR attempt.actor_id <> NEW.resident_id
      OR attempt.amount_units <> NEW.amount_units
      OR attempt.status <> 'payment_pending'
      OR attempt.tx_hash IS NULL
      OR attempt.finalized_block_number IS NULL
      OR attempt.finalized_block_hash IS NULL
      OR attempt.finalized_block_time IS NULL
      OR attempt.finalized_at IS NULL THEN
      RAISE EXCEPTION 'credit purchase receipt does not match its finalized payment'
        USING ERRCODE = '23514';
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
      gift.status <> 'pending'
      OR gift.recipient_id <> NEW.resident_id
      OR gift.source_key IS DISTINCT FROM NEW.source_key
    ) THEN
      RAISE EXCEPTION 'gift purchase receipt does not match its pending gift'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_pending' AND (
      gift.status <> 'pending'
      OR gift.recipient_id <> NEW.resident_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':pending:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift arrival receipt does not match its pending version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_accept' AND (
      gift.status <> 'accepted'
      OR gift.recipient_id <> NEW.resident_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':accept:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift acceptance receipt does not match its accepted version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_refuse' AND (
      gift.status <> 'refused'
      OR gift.recipient_id <> NEW.resident_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':refuse:' || gift.version::text
      )
    ) THEN
      RAISE EXCEPTION 'gift refusal receipt does not match its refused version'
        USING ERRCODE = '23514';
    ELSIF NEW.entry_kind = 'gift_redirect' AND (
      gift.status <> 'pending'
      OR gift.version <= 1
      OR gift.recipient_id IS DISTINCT FROM NEW.counterparty_id
      OR NEW.source_key IS DISTINCT FROM (
        'gift:' || gift.public_id || ':redirect:' || gift.version::text
      )
      OR NOT EXISTS (
        SELECT 1 FROM city_credit_entries prior
        WHERE prior.gift_id = gift.id
          AND prior.entry_kind = 'gift_pending'
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
    WHEN NEW.entry_kind = 'purchase' AND NEW.gift_id IS NULL
      THEN NEW.amount_units
    WHEN NEW.entry_kind IN ('spend', 'admin_debit')
      THEN -NEW.amount_units
    WHEN NEW.entry_kind IN ('gift_pending', 'gift_refuse', 'gift_redirect')
      OR (NEW.entry_kind = 'purchase' AND NEW.gift_id IS NOT NULL)
      THEN 0
    ELSE NULL
  END CASE;

  IF delta_units IS NULL THEN
    RAISE EXCEPTION 'unknown city credit balance effect' USING ERRCODE = '23514';
  END IF;

  INSERT INTO city_credit_accounts (resident_id, balance_units)
  VALUES (NEW.resident_id, 0)
  ON CONFLICT (resident_id) DO NOTHING;

  UPDATE city_credit_accounts
  SET balance_units = balance_units + delta_units,
    updated_at = clock_timestamp()
  WHERE resident_id = NEW.resident_id
    AND balance_units + delta_units >= 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient city fee credit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

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
  IF OLD.source_entry_id IS NOT NULL AND NEW.source_entry_id IS DISTINCT FROM OLD.source_entry_id THEN
    RAISE EXCEPTION 'city credit gift purchase receipt is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'accepted' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'accepted city credit gift is terminal' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'accepted', 'refused') THEN
    RAISE EXCEPTION 'invalid city credit gift transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'refused' AND NEW.status NOT IN ('refused', 'pending') THEN
    RAISE EXCEPTION 'invalid city credit gift transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'refused' AND NEW.status = 'pending'
    AND NEW.recipient_id IS NOT DISTINCT FROM OLD.recipient_id THEN
    RAISE EXCEPTION 'a refused city credit gift becomes pending only by redirect'
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

DROP TRIGGER IF EXISTS city_credit_gifts_keep_history ON city_credit_gifts;
CREATE TRIGGER city_credit_gifts_keep_history
  BEFORE UPDATE OR DELETE ON city_credit_gifts
  FOR EACH ROW EXECUTE FUNCTION protect_city_credit_gift();

CREATE OR REPLACE FUNCTION require_city_credit_gift_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_gift city_credit_gifts%ROWTYPE;
BEGIN
  SELECT * INTO current_gift FROM city_credit_gifts WHERE id = NEW.id;
  IF NOT FOUND OR current_gift.source_entry_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.id = current_gift.source_entry_id
      AND entry.entry_kind = 'purchase'
      AND entry.gift_id = current_gift.id
      AND entry.amount_units = current_gift.amount_units
      AND entry.source_key = current_gift.source_key
  ) THEN
    RAISE EXCEPTION 'city credit gift requires its exact purchase receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'pending' AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id
      AND entry.entry_kind = 'gift_pending'
      AND entry.resident_id = NEW.recipient_id
      AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':pending:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'pending city credit gift requires its exact arrival receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id
      AND entry.entry_kind = 'gift_accept'
      AND entry.resident_id = NEW.recipient_id
      AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':accept:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'accepted city credit gift requires its exact acceptance receipt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'refused' AND NOT EXISTS (
    SELECT 1 FROM city_credit_entries entry
    WHERE entry.gift_id = NEW.id
      AND entry.entry_kind = 'gift_refuse'
      AND entry.resident_id = NEW.recipient_id
      AND entry.amount_units = NEW.amount_units
      AND entry.source_key = 'gift:' || NEW.public_id || ':refuse:' || NEW.version::text
  ) THEN
    RAISE EXCEPTION 'refused city credit gift requires its exact refusal receipt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    AND NOT EXISTS (
      SELECT 1 FROM city_credit_entries entry
      WHERE entry.gift_id = NEW.id
        AND entry.entry_kind = 'gift_redirect'
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

DROP TRIGGER IF EXISTS city_credit_gifts_require_purchase ON city_credit_gifts;
CREATE CONSTRAINT TRIGGER city_credit_gifts_require_purchase
  AFTER INSERT OR UPDATE ON city_credit_gifts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_city_credit_gift_purchase();

CREATE TABLE IF NOT EXISTS paypal_credit_intents (
  public_id               TEXT PRIMARY KEY CHECK (
                            octet_length(public_id) BETWEEN 16 AND 128
                            AND public_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]+$'
                          ),
  request_id              TEXT NOT NULL UNIQUE CHECK (
                            octet_length(request_id) BETWEEN 8 AND 128
                            AND request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
                          ),
  intent_kind             TEXT NOT NULL CHECK (intent_kind IN ('order', 'allowance')),
  delivery                TEXT NOT NULL CHECK (delivery IN ('self', 'gift')),
  recipient_id            INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  amount_units            BIGINT NOT NULL CHECK (
                            amount_units > 0 AND amount_units <= 10000000000
                            AND amount_units % 1000000 = 0
                          ),
  claim_token_hash        TEXT UNIQUE CHECK (
                            claim_token_hash IS NULL OR claim_token_hash ~ '^[0-9a-f]{64}$'
                          ),
  paypal_environment      TEXT NOT NULL CHECK (paypal_environment IN ('sandbox', 'live')),
  remote_order_id         TEXT UNIQUE,
  remote_subscription_id  TEXT UNIQUE,
  status                  TEXT NOT NULL CHECK (status IN (
                            'created', 'approval_pending', 'captured', 'active'
                          )),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((delivery = 'gift') = (claim_token_hash IS NOT NULL)),
  CHECK (
    (intent_kind = 'order' AND remote_subscription_id IS NULL)
    OR (
      intent_kind = 'allowance'
      AND (
        (status = 'created' AND remote_subscription_id IS NULL)
        OR (
          status IN ('approval_pending', 'active')
          AND remote_subscription_id IS NOT NULL
        )
      )
    )
  )
);

ALTER TABLE paypal_credit_intents
  DROP CONSTRAINT IF EXISTS paypal_credit_intents_status_check;
ALTER TABLE paypal_credit_intents
  ADD CONSTRAINT paypal_credit_intents_status_check CHECK (
    status IN ('created', 'approval_pending', 'captured', 'active')
  );

ALTER TABLE paypal_credit_intents
  DROP CONSTRAINT IF EXISTS paypal_credit_intents_allowance_self_check;
ALTER TABLE paypal_credit_intents
  ADD CONSTRAINT paypal_credit_intents_allowance_self_check CHECK (
    intent_kind <> 'allowance' OR delivery = 'self'
  );

ALTER TABLE paypal_credit_intents
  DROP CONSTRAINT IF EXISTS paypal_credit_intents_kind_state_check;
ALTER TABLE paypal_credit_intents
  ADD CONSTRAINT paypal_credit_intents_kind_state_check CHECK (
    (
      intent_kind = 'order'
      AND remote_subscription_id IS NULL
      AND (
        (status = 'created' AND remote_order_id IS NULL)
        OR (status IN ('approval_pending', 'captured') AND remote_order_id IS NOT NULL)
      )
    )
    OR (
      intent_kind = 'allowance'
      AND remote_order_id IS NULL
      AND (
        (status = 'created' AND remote_subscription_id IS NULL)
        OR (status IN ('approval_pending', 'active') AND remote_subscription_id IS NOT NULL)
      )
    )
  );

CREATE OR REPLACE FUNCTION protect_paypal_credit_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PayPal credit intent history cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'created'
      OR NEW.remote_order_id IS NOT NULL
      OR NEW.remote_subscription_id IS NOT NULL THEN
      RAISE EXCEPTION 'PayPal credit intent must begin in created state without a remote binding'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.public_id, NEW.request_id, NEW.intent_kind, NEW.delivery,
    NEW.recipient_id, NEW.amount_units, NEW.claim_token_hash,
    NEW.paypal_environment, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.public_id, OLD.request_id, OLD.intent_kind, OLD.delivery,
    OLD.recipient_id, OLD.amount_units, OLD.claim_token_hash,
    OLD.paypal_environment, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'PayPal credit intent purchase terms are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.remote_order_id IS NOT NULL
    AND NEW.remote_order_id IS DISTINCT FROM OLD.remote_order_id THEN
    RAISE EXCEPTION 'PayPal order binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.remote_subscription_id IS NOT NULL
    AND NEW.remote_subscription_id IS DISTINCT FROM OLD.remote_subscription_id THEN
    RAISE EXCEPTION 'PayPal subscription binding is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.intent_kind = 'order' AND NOT (
    (OLD.status = 'created' AND NEW.status = 'approval_pending')
    OR (OLD.status = 'approval_pending' AND NEW.status IN ('approval_pending', 'captured'))
    OR (OLD.status = 'captured' AND NEW.status = 'captured')
  ) THEN
    RAISE EXCEPTION 'invalid PayPal order credit transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.intent_kind = 'allowance' AND NOT (
    (OLD.status = 'created' AND NEW.status = 'approval_pending')
    OR (OLD.status = 'approval_pending' AND NEW.status IN ('approval_pending', 'active'))
    OR (OLD.status = 'active' AND NEW.status = 'active')
  ) THEN
    RAISE EXCEPTION 'invalid PayPal allowance credit transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS paypal_credit_intents_guard ON paypal_credit_intents;
CREATE TRIGGER paypal_credit_intents_guard
  BEFORE INSERT OR UPDATE OR DELETE ON paypal_credit_intents
  FOR EACH ROW EXECUTE FUNCTION protect_paypal_credit_intent();

CREATE TABLE IF NOT EXISTS paypal_credit_catalog (
  paypal_environment TEXT PRIMARY KEY CHECK (paypal_environment IN ('sandbox', 'live')),
  product_id          TEXT,
  plan_id             TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paypal_credit_events (
  event_id           TEXT PRIMARY KEY,
  intent_public_id   TEXT REFERENCES paypal_credit_intents(public_id) ON DELETE RESTRICT,
  event_kind         TEXT NOT NULL,
  remote_resource_id TEXT,
  source_key         TEXT UNIQUE,
  purchase_entry_id  BIGINT REFERENCES city_credit_entries(id) ON DELETE RESTRICT,
  outcome            TEXT NOT NULL CHECK (outcome IN ('credited', 'ignored')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE paypal_credit_events
  ADD COLUMN IF NOT EXISTS intent_public_id TEXT
    REFERENCES paypal_credit_intents(public_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS purchase_entry_id BIGINT
    REFERENCES city_credit_entries(id) ON DELETE RESTRICT;
ALTER TABLE paypal_credit_events
  DROP CONSTRAINT IF EXISTS paypal_credit_events_outcome_check,
  DROP CONSTRAINT IF EXISTS paypal_credit_events_binding_check;
ALTER TABLE paypal_credit_events
  ADD CONSTRAINT paypal_credit_events_outcome_check CHECK (
    outcome IN ('credited', 'ignored')
  ),
  ADD CONSTRAINT paypal_credit_events_binding_check CHECK (
    (
      outcome = 'ignored'
      AND intent_public_id IS NULL
      AND source_key IS NULL
      AND purchase_entry_id IS NULL
    )
    OR (
      outcome = 'credited'
      AND intent_public_id IS NOT NULL
      AND source_key IS NOT NULL
      AND purchase_entry_id IS NOT NULL
      AND remote_resource_id IS NOT NULL
      AND event_kind IN ('PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.SALE.COMPLETED')
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS paypal_credit_events_purchase_entry
  ON paypal_credit_events (purchase_entry_id)
  WHERE purchase_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paypal_credit_events_one_order_capture
  ON paypal_credit_events (intent_public_id)
  WHERE outcome = 'credited' AND event_kind = 'PAYMENT.CAPTURE.COMPLETED';

DROP TRIGGER IF EXISTS paypal_credit_events_append_only ON paypal_credit_events;
CREATE TRIGGER paypal_credit_events_append_only
  BEFORE UPDATE OR DELETE ON paypal_credit_events
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

CREATE TABLE IF NOT EXISTS credit_purchase_rate_limits (
  caller_hash TEXT NOT NULL CHECK (caller_hash ~ '^[0-9a-f]{64}$'),
  hour        TIMESTAMPTZ NOT NULL,
  used        INTEGER NOT NULL CHECK (used > 0 AND used <= 300),
  PRIMARY KEY (caller_hash, hour)
);

ALTER TABLE credit_purchase_rate_limits
  DROP CONSTRAINT IF EXISTS credit_purchase_rate_limits_used_check;
ALTER TABLE credit_purchase_rate_limits
  ADD CONSTRAINT credit_purchase_rate_limits_used_check CHECK (used > 0 AND used <= 300);

CREATE OR REPLACE FUNCTION record_city_credit_purchase(
  target_resident_id INTEGER,
  purchased_amount_units BIGINT,
  purchase_source_key TEXT,
  requested_purchase_kind TEXT,
  requested_claim_token_hash TEXT,
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
  stored_entry city_credit_entries%ROWTYPE;
  stored_gift city_credit_gifts%ROWTYPE;
  was_created BOOLEAN := false;
  stored_balance BIGINT;
BEGIN
  IF requested_claim_token_hash IS NULL THEN
    INSERT INTO city_credit_entries (
      resident_id, entry_kind, amount_units, source_key, purchase_kind
    )
    SELECT target_resident_id, 'purchase', purchased_amount_units,
      purchase_source_key, requested_purchase_kind
    WHERE EXISTS (SELECT 1 FROM residents WHERE residents.id = target_resident_id)
    ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING
    RETURNING city_credit_entries.* INTO stored_entry;
    IF FOUND THEN
      was_created := true;
    ELSE
      SELECT entry.* INTO stored_entry
      FROM city_credit_entries entry
      WHERE entry.source_key = purchase_source_key;
    END IF;
  ELSE
    SELECT gift.* INTO stored_gift
    FROM city_credit_gifts gift
    WHERE gift.source_key = purchase_source_key;
    IF NOT FOUND THEN
      INSERT INTO city_credit_gifts (
        public_id, recipient_id, amount_units, source_key, claim_token_hash, status
      )
      SELECT requested_gift_public_id, target_resident_id, purchased_amount_units,
        purchase_source_key, requested_claim_token_hash, 'pending'
      WHERE EXISTS (SELECT 1 FROM residents WHERE residents.id = target_resident_id)
      ON CONFLICT (source_key) DO NOTHING
      RETURNING city_credit_gifts.* INTO stored_gift;
      IF FOUND THEN
        was_created := true;
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, source_key, purchase_kind, gift_id
        ) VALUES (
          stored_gift.recipient_id, 'purchase', stored_gift.amount_units,
          stored_gift.source_key, requested_purchase_kind, stored_gift.id
        )
        RETURNING city_credit_entries.* INTO stored_entry;
        UPDATE city_credit_gifts gift
        SET source_entry_id = stored_entry.id, updated_at = clock_timestamp()
        WHERE gift.id = stored_gift.id
        RETURNING gift.* INTO stored_gift;
        INSERT INTO city_credit_entries (
          resident_id, entry_kind, amount_units, source_key, gift_id
        ) VALUES (
          stored_gift.recipient_id, 'gift_pending', stored_gift.amount_units,
          'gift:' || stored_gift.public_id || ':pending:1', stored_gift.id
        );
      ELSE
        SELECT gift.* INTO stored_gift
        FROM city_credit_gifts gift
        WHERE gift.source_key = purchase_source_key;
      END IF;
    END IF;
    IF stored_entry.id IS NULL AND stored_gift.source_entry_id IS NOT NULL THEN
      SELECT entry.* INTO stored_entry
      FROM city_credit_entries entry
      WHERE entry.id = stored_gift.source_entry_id;
    END IF;
  END IF;

  IF stored_entry.id IS NULL THEN
    RETURN;
  END IF;
  SELECT account.balance_units INTO stored_balance
  FROM city_credit_accounts account
  WHERE account.resident_id = stored_entry.resident_id;
  RETURN QUERY SELECT
    stored_entry.id,
    stored_entry.resident_id,
    stored_entry.amount_units,
    stored_entry.source_key,
    stored_entry.purchase_kind,
    stored_gift.id,
    stored_gift.public_id,
    stored_gift.claim_token_hash,
    stored_gift.status,
    was_created,
    coalesce(stored_balance, 0);
END
$$;

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

DROP TRIGGER IF EXISTS paypal_credit_events_require_receipt ON paypal_credit_events;
CREATE CONSTRAINT TRIGGER paypal_credit_events_require_receipt
  AFTER INSERT ON paypal_credit_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_credit_event_receipt();

CREATE OR REPLACE FUNCTION require_paypal_purchase_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entry_kind = 'purchase'
    AND NEW.purchase_kind IN ('paypal', 'allowance')
    AND NOT EXISTS (
      SELECT 1 FROM paypal_credit_events event
      WHERE event.purchase_entry_id = NEW.id
        AND event.source_key = NEW.source_key
        AND event.outcome = 'credited'
    ) THEN
    RAISE EXCEPTION 'PayPal credit purchase requires its exact verified event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS city_credit_entries_require_paypal_event ON city_credit_entries;
CREATE CONSTRAINT TRIGGER city_credit_entries_require_paypal_event
  AFTER INSERT ON city_credit_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_paypal_purchase_event();

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
    OR octet_length(requested_remote_resource_id) NOT BETWEEN 1 AND 128
    OR requested_remote_resource_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    OR requested_source_key IS NULL
    OR octet_length(requested_source_key) NOT BETWEEN 8 AND 160
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

  RETURN QUERY SELECT
    purchase_record.id::BIGINT,
    purchase_record.resident_id::INTEGER,
    purchase_record.amount_units::BIGINT,
    purchase_record.source_key::TEXT,
    purchase_record.purchase_kind::TEXT,
    purchase_record.gift_row_id::BIGINT,
    purchase_record.gift_public_id::TEXT,
    purchase_record.claim_token_hash::TEXT,
    purchase_record.status::TEXT,
    purchase_record.created::BOOLEAN,
    purchase_record.balance_units::BIGINT;
END
$$;

CREATE OR REPLACE FUNCTION complete_city_credit_purchase(
  requested_attempt_id TEXT,
  expected_lease_owner TEXT
) RETURNS TABLE (
  state TEXT,
  attempt_id TEXT,
  reason TEXT,
  actor_id INTEGER,
  amount_units TEXT,
  entry_id TEXT,
  response_status SMALLINT,
  response_json JSONB,
  response_body TEXT,
  payment_response_header TEXT
) LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  attempt payment_attempts%ROWTYPE;
  purchase city_credit_entries%ROWTYPE;
  balance BIGINT;
  amount_text TEXT;
  balance_text TEXT;
  body_json JSONB;
  body_text TEXT;
BEGIN
  SELECT * INTO attempt
  FROM payment_attempts stored
  WHERE stored.public_id = requested_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit purchase payment attempt was not found' USING ERRCODE = '55000';
  END IF;

  attempt_id := attempt.public_id;

  IF attempt.status = 'completed' THEN
    SELECT * INTO purchase FROM city_credit_entries entry
    WHERE entry.payment_attempt_id = attempt.public_id AND entry.entry_kind = 'purchase';
    IF NOT FOUND OR attempt.response_body_bytes IS NULL THEN
      RAISE EXCEPTION 'completed credit purchase receipt is unavailable' USING ERRCODE = '55000';
    END IF;
    state := 'completed';
    reason := NULL;
    actor_id := attempt.actor_id;
    amount_units := attempt.amount_units::text;
    entry_id := purchase.id::text;
    response_status := attempt.response_status;
    response_body := convert_from(attempt.response_body_bytes, 'UTF8');
    response_json := response_body::jsonb;
    payment_response_header := attempt.response_json #>> '{__1f3d9_x402_response_v1,header}';
    RETURN NEXT;
    RETURN;
  END IF;

  IF attempt.recovery_deadline_at IS NOT NULL
    AND attempt.recovery_deadline_at <= clock_timestamp() THEN
    state := 'deadline_passed';
    reason := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  IF attempt.status <> 'payment_pending'
    OR attempt.operation <> 'credit_purchase'
    OR attempt.method <> 'x402'
    OR attempt.lease_owner IS DISTINCT FROM expected_lease_owner
    OR attempt.counterparty_id IS NOT NULL OR attempt.offer_id IS NOT NULL
    OR attempt.asset_type IS NOT NULL OR attempt.asset_id IS NOT NULL
    OR attempt.network <> 'base'
    OR attempt.token <> '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    OR attempt.payer_wallet IS NULL OR attempt.payee_wallet IS NULL
    OR attempt.amount_units <= 0 OR attempt.amount_units > 10000000000
    OR attempt.amount_units % 1000000 <> 0
    OR attempt.tx_hash IS NULL OR attempt.finalized_block_number IS NULL
    OR attempt.finalized_block_hash IS NULL OR attempt.finalized_block_time IS NULL
    OR attempt.finalized_at IS NULL
    OR attempt.recovery_deadline_at IS NULL
    OR jsonb_typeof(attempt.request_json) <> 'object'
    OR attempt.request_json ?& ARRAY['request_id', 'amount_dollars'] IS NOT TRUE
    OR attempt.request_json->>'amount_dollars' <> (attempt.amount_units / 1000000)::text
    OR attempt.target_key <> 'city-credit-purchase:' || attempt.actor_id::text || ':' ||
      (attempt.request_json->>'request_id') THEN
    state := 'target_changed';
    reason := 'stored credit purchase terms changed';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO payment_uses (
    tx_hash, payment_attempt_id, actor_id, purpose,
    payer_wallet, payee_wallet, amount_usdc
  ) VALUES (
    attempt.tx_hash, attempt.public_id, attempt.actor_id, 'credit_purchase',
    attempt.payer_wallet, attempt.payee_wallet,
    attempt.amount_units::numeric / 1000000
  );

  INSERT INTO city_credit_entries (
    resident_id, entry_kind, amount_units, payment_attempt_id,
    source_key, purchase_kind
  ) VALUES (
    attempt.actor_id, 'purchase', attempt.amount_units, attempt.public_id,
    'x402:credit:' || attempt.tx_hash, 'x402'
  ) RETURNING * INTO purchase;

  SELECT account.balance_units INTO balance
  FROM city_credit_accounts account
  WHERE account.resident_id = attempt.actor_id;
  amount_text := (attempt.amount_units / 1000000)::text || '.000000';
  balance_text := (balance / 1000000)::text || '.' ||
    lpad((balance % 1000000)::text, 6, '0');
  body_json := jsonb_build_object('city_fee_credit', jsonb_build_object(
    'purchased', amount_text,
    'purchased_units', attempt.amount_units::text,
    'balance_usdc', balance_text,
    'balance_units', balance::text,
    'receipt_id', purchase.id::text
  ));
  body_text := replace(replace(body_json::text, ': ', ':'), ', ', ',');

  PERFORM complete_payment_attempt(
    attempt.public_id,
    expected_lease_owner,
    jsonb_build_object('kind', 'city_credit_purchase', 'id', purchase.id),
    201::smallint,
    body_json,
    convert_to(body_text, 'UTF8')
  );

  state := 'completed';
  reason := NULL;
  actor_id := attempt.actor_id;
  amount_units := attempt.amount_units::text;
  entry_id := purchase.id::text;
  response_status := 201;
  response_json := body_json;
  response_body := body_text;
  payment_response_header := attempt.response_json #>> '{__1f3d9_x402_response_v1,header}';
  RETURN NEXT;
END
$$;

COMMIT;
