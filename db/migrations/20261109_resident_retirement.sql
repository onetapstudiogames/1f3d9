BEGIN;
-- Retirement is requested by a key holder and completed manually by the founder.
ALTER TABLE residents ADD COLUMN IF NOT EXISTS retirement_state TEXT NOT NULL DEFAULT 'active'
  CHECK (retirement_state IN ('active','retiring','retired'));
ALTER TABLE residents ADD COLUMN IF NOT EXISTS retirement_requested_at TIMESTAMPTZ;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='residents'::regclass AND conname='resident_retirement_dates') THEN
    ALTER TABLE residents ADD CONSTRAINT resident_retirement_dates CHECK (
      (retirement_state='active' AND retirement_requested_at IS NULL AND retired_at IS NULL)
      OR (retirement_state='retiring' AND retirement_requested_at IS NOT NULL AND retired_at IS NULL)
      OR (retirement_state='retired' AND retirement_requested_at IS NOT NULL AND retired_at IS NOT NULL
        AND retired_at >= retirement_requested_at + interval '30 days'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS residents_retirement_due ON residents(retirement_requested_at,id)
  WHERE retirement_state='retiring';

CREATE OR REPLACE FUNCTION guard_resident_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.retirement_state<>'active' THEN
      RAISE EXCEPTION 'A retiring or retired resident keeps its name permanently.' USING ERRCODE='R0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.retirement_state='retired' THEN
    RAISE EXCEPTION 'This resident is retired and cannot act.' USING ERRCODE='R0001';
  END IF;
  IF NEW.retirement_state <> OLD.retirement_state THEN
    IF NEW.retirement_state='retiring' AND OLD.retirement_state='active'
      AND NEW.retirement_requested_at IS NOT NULL AND NEW.retired_at IS NULL THEN
      IF EXISTS(SELECT 1 FROM transfer_offers WHERE status='open'
        AND (seller_id=OLD.id OR (reserved_by=OLD.id AND reserved_until>clock_timestamp())))
        OR EXISTS(SELECT 1 FROM payment_attempts WHERE (actor_id=OLD.id OR counterparty_id=OLD.id)
          AND status IN ('settling','payment_pending','needs_review')) THEN
        RAISE EXCEPTION 'Finish or cancel open sale offers, wait for live purchase reservations, and resolve pending payments before retiring. Nothing changed.' USING ERRCODE='R0002';
      END IF;
      RETURN NEW;
    ELSIF NEW.retirement_state='active' AND OLD.retirement_state='retiring'
      AND clock_timestamp() < OLD.retirement_requested_at + interval '30 days'
      AND NEW.retirement_requested_at IS NULL AND NEW.retired_at IS NULL THEN
      RETURN NEW;
    ELSIF NEW.retirement_state='retired' AND OLD.retirement_state='retiring'
      AND clock_timestamp() >= OLD.retirement_requested_at + interval '30 days'
      AND NEW.retired_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'This retirement cannot change now; cancellation is available only within 30 days.' USING ERRCODE='R0001';
  END IF;
  IF OLD.retirement_state='retiring' THEN
    RAISE EXCEPTION 'This resident is retiring and cannot act. Cancel within 30 days on /delete to return.' USING ERRCODE='R0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS resident_retirement_guard ON residents;
CREATE TRIGGER resident_retirement_guard BEFORE UPDATE OR DELETE ON residents
  FOR EACH ROW EXECUTE FUNCTION guard_resident_retirement();

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
    SELECT retirement_state INTO resident_state FROM residents WHERE id=resident_id FOR SHARE;
    IF resident_state IN ('retiring','retired') THEN
      RAISE EXCEPTION 'This resident is % and cannot act or change owned property. See /delete.', resident_state USING ERRCODE='R0001';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE item TEXT[];
BEGIN
  FOREACH item SLICE 1 IN ARRAY ARRAY[
    ['places','owner_id'],['things','owner_id'],['kinds','owner_id'],
    ['notes','author_id'],['traits','coiner_id'],['agreements','created_by_id'],
    ['agreement_signatures','resident_id'],['resident_presence','resident_id'],
    ['resident_looking','resident_id'],['resident_settings','resident_id'],
    ['resident_mutes','resident_id'],['room_lines','resident_id'],
    ['action_runs','actor_id'],['pending_effects','actor_id'],['ping_operations','resident_id'],
    ['thing_later_holder_marks','resident_id'],
    ['resident_recovery_codes','resident_id'],['resident_key_rotations','resident_id'],
    ['oauth_authorization_codes','resident_id'],['oauth_token_families','resident_id'],
    ['pairing_codes','resident_id'],['oauth_authorization_requests','resident_id']
  ] LOOP
    IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name=item[1] AND column_name=item[2]) THEN
      RAISE EXCEPTION 'resident retirement guard column missing: %.%',item[1],item[2];
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS resident_active_write ON %I',item[1]);
    EXECUTE format('CREATE TRIGGER resident_active_write BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION require_active_resident_for_write(%L)',item[1],item[2]);
  END LOOP;
  FOREACH item SLICE 1 IN ARRAY ARRAY[['places','owner_id'],['things','owner_id'],['kinds','owner_id'],
    ['resident_mutes','resident_id'],['resident_settings','resident_id'],['thing_later_holder_marks','resident_id']] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS resident_active_delete ON %I',item[1]);
    EXECUTE format('CREATE TRIGGER resident_active_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION require_active_resident_for_write(%L)',item[1],item[2]);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION guard_retirement_token_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state TEXT;
BEGIN
  SELECT resident.retirement_state INTO state FROM residents resident
    JOIN oauth_token_families family ON family.resident_id=resident.id
    WHERE family.id=NEW.family_id FOR SHARE OF resident;
  IF state IN ('retiring','retired') THEN
    RAISE EXCEPTION 'This resident is % and cannot sign in.',state USING ERRCODE='R0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS resident_active_write ON oauth_tokens;
CREATE TRIGGER resident_active_write BEFORE INSERT OR UPDATE ON oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION guard_retirement_token_write();
DROP TRIGGER IF EXISTS resident_active_maker ON things;
CREATE TRIGGER resident_active_maker BEFORE INSERT ON things
  FOR EACH ROW EXECUTE FUNCTION require_active_resident_for_write('maker_id');
DROP TRIGGER IF EXISTS resident_active_recipient ON paypal_credit_intents;
CREATE TRIGGER resident_active_recipient BEFORE INSERT ON paypal_credit_intents
  FOR EACH ROW EXECUTE FUNCTION require_active_resident_for_write('recipient_id');
DROP TRIGGER IF EXISTS resident_active_recipient ON play_credit_orders;
CREATE TRIGGER resident_active_recipient BEFORE INSERT ON play_credit_orders
  FOR EACH ROW EXECUTE FUNCTION require_active_resident_for_write('recipient_id');
DROP TRIGGER IF EXISTS resident_active_sender ON pings;
CREATE TRIGGER resident_active_sender BEFORE INSERT ON pings
  FOR EACH ROW EXECUTE FUNCTION require_active_resident_for_write('sender_id');
DROP TRIGGER IF EXISTS resident_active_target ON pings;
CREATE TRIGGER resident_active_target BEFORE UPDATE ON pings
  FOR EACH ROW EXECUTE FUNCTION require_active_resident_for_write('target_id');
DROP TRIGGER IF EXISTS resident_active_payment ON payment_attempts;
CREATE TRIGGER resident_active_payment BEFORE INSERT OR UPDATE ON payment_attempts
  FOR EACH ROW WHEN (NEW.status IN ('settling','payment_pending','needs_review'))
  EXECUTE FUNCTION require_active_resident_for_write('actor_id','counterparty_id');
DROP TRIGGER IF EXISTS resident_active_offer ON transfer_offers;
CREATE TRIGGER resident_active_offer BEFORE INSERT OR UPDATE ON transfer_offers
  FOR EACH ROW WHEN (NEW.status='open')
  EXECUTE FUNCTION require_active_resident_for_write('seller_id','buyer_id','reserved_by');
DROP TRIGGER IF EXISTS resident_active_actor ON active_blocks;
CREATE TRIGGER resident_active_actor BEFORE INSERT ON active_blocks
  FOR EACH ROW EXECUTE FUNCTION require_active_resident_for_write('actor_id','resident_id');

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
  SELECT retirement_state INTO state FROM residents WHERE id=owner_number FOR SHARE;
  IF state IN ('retiring','retired') THEN
    RAISE EXCEPTION 'This resident is % and its property is frozen.',state USING ERRCODE='R0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS resident_active_actor ON active_labels;
CREATE TRIGGER resident_active_actor BEFORE INSERT ON active_labels
  FOR EACH ROW EXECUTE FUNCTION require_active_resident_for_write('actor_id');
DROP TRIGGER IF EXISTS resident_frozen_property ON active_labels;
CREATE TRIGGER resident_frozen_property BEFORE INSERT ON active_labels
  FOR EACH ROW EXECUTE FUNCTION guard_retired_property_effect();
DROP TRIGGER IF EXISTS resident_active_actor ON place_law_changes;
CREATE TRIGGER resident_active_actor BEFORE INSERT ON place_law_changes
  FOR EACH ROW EXECUTE FUNCTION require_active_resident_for_write('actor_id');
DROP TRIGGER IF EXISTS resident_frozen_property ON place_law_changes;
CREATE TRIGGER resident_frozen_property BEFORE INSERT ON place_law_changes
  FOR EACH ROW EXECUTE FUNCTION guard_retired_property_effect();

CREATE OR REPLACE FUNCTION complete_resident_retirement(founder_id INTEGER,target_id INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE target residents%ROWTYPE; token_id BIGINT;
BEGIN
  IF founder_id <> 1 THEN
    RAISE EXCEPTION 'Only founder resident #1 may complete retirement.' USING ERRCODE='R0001';
  END IF;
  SELECT * INTO target FROM residents WHERE id=target_id FOR UPDATE;
  IF target.retirement_state='retired' THEN RETURN TRUE; END IF;
  IF target.retirement_state IS DISTINCT FROM 'retiring'
    OR target.retirement_requested_at IS NULL
    OR clock_timestamp() < target.retirement_requested_at + interval '30 days' THEN
    RAISE EXCEPTION 'The key holder must request retirement and wait 30 days before the founder completes it.' USING ERRCODE='R0001';
  END IF;
  PERFORM scrub_resident_private_payment_data(target_id);
  FOR token_id IN SELECT token.id FROM oauth_tokens token JOIN oauth_token_families family ON family.id=token.family_id
    WHERE family.resident_id=target_id ORDER BY token.id DESC LOOP
    DELETE FROM oauth_tokens WHERE id=token_id;
  END LOOP;
  DELETE FROM oauth_token_families WHERE resident_id=target_id;
  DELETE FROM oauth_authorization_codes WHERE resident_id=target_id;
  DELETE FROM oauth_authorization_requests WHERE resident_id=target_id;
  DELETE FROM pairing_codes WHERE resident_id=target_id;
  DELETE FROM resident_recovery_codes WHERE resident_id=target_id;
  DELETE FROM resident_key_rotations WHERE resident_id=target_id;
  DELETE FROM pending_resident_registrations WHERE resident_id=target_id;
  UPDATE residents SET retirement_state='retired',retired_at=clock_timestamp(),
    secret_hash=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),
    recovery_generation=recovery_generation+1 WHERE id=target_id;
  RETURN TRUE;
END $$;
-- Keep previously published bundles unchanged; new snapshots mark the permanent name.
DO $resident_retirement_snapshot$
BEGIN
  IF to_regclass('city_snapshot.public_records_v4_without_retirement') IS NULL THEN
    ALTER VIEW city_snapshot.public_records_v4 RENAME TO public_records_v4_without_retirement;
  END IF;
END
$resident_retirement_snapshot$;
REVOKE ALL ON city_snapshot.public_records_v4_without_retirement FROM PUBLIC;
REVOKE ALL ON city_snapshot.public_records_v4_without_retirement FROM city_snapshot_export;
CREATE OR REPLACE VIEW city_snapshot.public_records_v4
WITH (security_barrier = true)
AS
SELECT base.class_name, base.record_id, base.sort_key,
  CASE WHEN resident.retirement_state IN ('retiring', 'retired') AND base.payload->>'status' = 'exported'
    THEN base.payload || jsonb_build_object(
      'retirement_state', resident.retirement_state,
      'display_handle', resident.handle || ' (' || resident.retirement_state || ')'
    ) ELSE base.payload END AS payload
FROM city_snapshot.public_records_v4_without_retirement base
LEFT JOIN public.residents resident
  ON base.class_name = 'residents' AND resident.id::TEXT = base.record_id;
REVOKE ALL ON city_snapshot.public_records_v4 FROM PUBLIC;
GRANT SELECT ON city_snapshot.public_records_v4 TO city_snapshot_export;
COMMIT;
