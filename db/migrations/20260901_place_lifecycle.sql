BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE places, events, payment_attempts, city_credit_entries, place_reading_totals
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE places
  ADD COLUMN IF NOT EXISTS founding_name TEXT,
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

ALTER TABLE places DISABLE TRIGGER places_protect_topology_write;
DO $place_lifecycle_backfill$
DECLARE
  gazette_guard_mode TEXT;
  room_state TEXT;
  opening_events INTEGER;
  withdrawal_events INTEGER;
BEGIN
  SELECT trigger.tgenabled::text
  INTO gazette_guard_mode
  FROM pg_trigger trigger
  WHERE trigger.tgrelid = 'places'::regclass
    AND trigger.tgname = 'gazette_submission_room_lifecycle'
    AND NOT trigger.tgisinternal;

  IF gazette_guard_mode IS NOT NULL
    AND gazette_guard_mode NOT IN ('O', 'A')
  THEN
    RAISE EXCEPTION 'Gazette room #454 lifecycle guard must be active before the place lifecycle backfill'
      USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
  END IF;

  IF gazette_guard_mode IS NOT NULL THEN
    ALTER TABLE places DISABLE TRIGGER gazette_submission_room_lifecycle;
  END IF;

  UPDATE places SET founding_name = name WHERE founding_name IS NULL;

  IF gazette_guard_mode = 'A' THEN
    ALTER TABLE places ENABLE ALWAYS TRIGGER gazette_submission_room_lifecycle;
  ELSIF gazette_guard_mode = 'O' THEN
    ALTER TABLE places ENABLE TRIGGER gazette_submission_room_lifecycle;
  ELSE
    RETURN;
  END IF;

  SELECT gazette_submission_room_state(place) INTO room_state
  FROM places place WHERE place.id = 454;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT count(*)::integer INTO opening_events FROM events
  WHERE kind = 'place_edited' AND actor = 'the city'
    AND detail = '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb;
  SELECT count(*)::integer INTO withdrawal_events FROM events
  WHERE kind = 'place_edited' AND actor = 'the city'
    AND detail = '{"place_id":454,"gazette_withdrawals_opened":true}'::jsonb;

  IF gazette_submission_room_has_no_forbidden_contents()
    AND gazette_submission_room_guards_ready()
    AND ((room_state = 'closed' AND opening_events = 0 AND withdrawal_events = 0)
      OR (room_state = 'open' AND opening_events = 1 AND withdrawal_events = 0)
      OR (room_state = 'withdrawals_open' AND opening_events = 1 AND withdrawal_events = 1))
  THEN RETURN; END IF;

  RAISE EXCEPTION 'Gazette room #454 does not match a guarded withdrawal rollout state after the place lifecycle backfill'
    USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_lifecycle';
END
$place_lifecycle_backfill$;
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
  place_id   INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  started_at TIMESTAMPTZ NOT NULL,
  event_id   BIGINT UNIQUE REFERENCES events(id) ON DELETE RESTRICT
);

DO $place_name_history_place_fk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'place_name_history'::regclass
      AND conname = 'place_name_history_place_id_fkey'
      AND confdeltype <> 'c'
  ) THEN
    ALTER TABLE place_name_history DROP CONSTRAINT place_name_history_place_id_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'place_name_history'::regclass
      AND conname = 'place_name_history_place_id_fkey'
  ) THEN
    ALTER TABLE place_name_history ADD CONSTRAINT place_name_history_place_id_fkey
      FOREIGN KEY (place_id) REFERENCES places(id) ON DELETE CASCADE;
  END IF;
END
$place_name_history_place_fk$;

CREATE UNIQUE INDEX IF NOT EXISTS place_name_history_one_founding_name
  ON place_name_history (place_id) WHERE event_id IS NULL;
CREATE INDEX IF NOT EXISTS place_name_history_place_span
  ON place_name_history (place_id, started_at, id);
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
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM places place WHERE place.id = OLD.place_id
  ) THEN
    RETURN OLD;
  END IF;
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

-- Patch the deepest deployed snapshot view before rebuilding its wrappers.
CREATE OR REPLACE VIEW city_snapshot.public_records_without_drawing_contract
WITH (security_barrier = true)
AS
WITH RECURSIVE
latest_moderation AS (
  SELECT ranked.target_type, ranked.target_id, ranked.action
  FROM (
    SELECT moderation.target_type, moderation.target_id, moderation.action,
      row_number() OVER (
        PARTITION BY moderation.target_type, moderation.target_id
        ORDER BY moderation.created_at DESC, moderation.id DESC
      ) AS position
    FROM public.moderation_actions moderation
  ) ranked
  WHERE ranked.position = 1
),
public_event_kinds(kind) AS (
  VALUES
    ('register'),
    ('rotate'),
    ('resident_edited'),
    ('home_set'),
    ('place_created'),
    ('place_edited'),
    ('place_renamed'),
    ('place_retired'),
    ('place_restored'),
    ('kind_invented'),
    ('kind_revised'),
    ('trait_coined'),
    ('thing_created'),
    ('thing_crafted'),
    ('thing_edited'),
    ('thing_moved'),
    ('thing_upgraded'),
    ('thing_withdrawn'),
    ('laws_changed'),
    ('action'),
    ('effect_scheduled'),
    ('effect_resolved'),
    ('note'),
    ('agreement'),
    ('agreement_accession'),
    ('agreement_sign'),
    ('transfer'),
    ('transfer_offer'),
    ('sale'),
    ('transfer_cancel'),
    ('world_listed'),
    ('world_sale'),
    ('world_cancel'),
    ('payment_repair'),
    ('flag'),
    ('moderation')
),
place_ancestry(origin_id, id, parent_id, owner_id, sovereign_owner, depth) AS (
  SELECT place.id, place.id, place.parent_id, place.owner_id, place.owner_id, 0
  FROM public.places place
  UNION ALL
  SELECT ancestry.origin_id, parent.id, parent.parent_id, parent.owner_id,
    ancestry.sovereign_owner, ancestry.depth + 1
  FROM place_ancestry ancestry
  JOIN public.places parent ON parent.id = ancestry.parent_id
  WHERE parent.owner_id = ancestry.sovereign_owner
    AND parent.place_kind <> 'world'
    AND ancestry.depth < 64
),
ranked_law_changes AS (
  SELECT ancestry.origin_id, ancestry.depth, change.place_id, change.trait_id,
    change.change_type, change.position,
    row_number() OVER (
      PARTITION BY ancestry.origin_id, change.place_id, change.trait_id
      ORDER BY change.id DESC
    ) AS latest_position
  FROM place_ancestry ancestry
  JOIN public.place_law_changes change ON change.place_id = ancestry.id
),
effective_law_candidates AS (
  SELECT ranked.origin_id, ranked.depth, ranked.place_id, ranked.trait_id,
    ranked.position,
    row_number() OVER (
      PARTITION BY ranked.origin_id, ranked.trait_id
      ORDER BY ranked.depth, ranked.position, ranked.trait_id
    ) AS sovereign_position
  FROM ranked_law_changes ranked
  WHERE ranked.latest_position = 1 AND ranked.change_type = 'add'
),
effective_laws AS (
  SELECT candidate.origin_id,
    jsonb_agg(jsonb_build_object(
      'trait_id', trait.id,
      'name', trait.name,
      'recipe', trait.recipe,
      'source_place_id', candidate.place_id,
      'position', candidate.position
    ) ORDER BY candidate.depth, candidate.position, trait.id) AS laws
  FROM effective_law_candidates candidate
  JOIN public.traits trait ON trait.id = candidate.trait_id
  LEFT JOIN latest_moderation hidden
    ON hidden.target_type = 'trait' AND hidden.target_id = trait.id
  WHERE candidate.sovereign_position = 1
    AND coalesce(hidden.action, 'restore') <> 'remove'
  GROUP BY candidate.origin_id
),
resident_slots AS (
  SELECT generate_series(
    1,
    greatest(
      coalesce((SELECT allocator.last_id FROM public.resident_id_allocator allocator WHERE allocator.singleton), 0),
      coalesce((SELECT max(resident.id) FROM public.residents resident), 0),
      4
    )
  )::BIGINT AS id
),
place_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(place.id) FROM public.places place), 0))::BIGINT AS id
),
thing_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(thing.id) FROM public.things thing), 0))::BIGINT AS id
),
note_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(note.id) FROM public.notes note), 0))::BIGINT AS id
),
trait_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(trait.id) FROM public.traits trait), 0))::BIGINT AS id
),
kind_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(kind.id) FROM public.kinds kind), 0))::BIGINT AS id
),
agreement_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(agreement.id) FROM public.agreements agreement), 0))::BIGINT AS id
),
event_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(event.id) FROM public.events event), 0))::BIGINT AS id
),
moderation_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(moderation.id) FROM public.moderation_actions moderation), 0))::BIGINT AS id
),
fee_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(fee.id) FROM public.fees fee), 0))::BIGINT AS id
),
world_offer_slots AS (
  SELECT generate_series(
    1,
    coalesce((SELECT max(offer.id) FROM public.transfer_offers offer WHERE offer.channel = 'world'), 0)
  )::BIGINT AS id
)
SELECT 'residents'::TEXT AS class_name, slot.id::TEXT AS record_id, slot.id AS sort_key,
  CASE
    WHEN resident.id IS NULL AND slot.id = 4 THEN jsonb_build_object(
      'id', slot.id, 'status', 'reserved', 'reason', 'permanent_resident_landmark'
    )
    WHEN resident.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public resident record'
    )
    ELSE jsonb_build_object(
      'id', resident.id,
      'status', 'exported',
      'handle', resident.handle,
      'model', resident.model,
      'joined_at', resident.joined_at,
      'drawing', CASE WHEN resident_hidden.action = 'remove' THEN NULL
        ELSE resident.drawing END
    )
  END AS payload
FROM resident_slots slot
LEFT JOIN public.residents resident ON resident.id = slot.id
LEFT JOIN latest_moderation resident_hidden
  ON resident_hidden.target_type = 'resident' AND resident_hidden.target_id = resident.id

UNION ALL

SELECT 'public_presence', resident.id::TEXT, resident.id::BIGINT,
  jsonb_build_object(
    'id', resident.id,
    'status', 'exported',
    'resident_id', resident.id,
    'handle', resident.handle,
    'joined_at', resident.joined_at,
    'current_place_id', presence.current_place_id,
    'asleep', resident.joined_at < transaction_timestamp() - interval '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM public.events event
        WHERE event.actor = resident.handle
          AND event.at >= transaction_timestamp() - interval '14 days'
          AND event.kind IN (SELECT public_kind.kind FROM public_event_kinds public_kind)
      )
  )
FROM public.residents resident
LEFT JOIN public.resident_presence presence ON presence.resident_id = resident.id

UNION ALL

SELECT 'places', slot.id::TEXT, slot.id,
  CASE
    WHEN place.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public place record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', place.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', place.id,
      'status', 'exported',
      'parent_id', place.parent_id,
      'place_kind', place.place_kind,
      'name', place.name,
      'description', place.description,
      'purpose', place.purpose,
      'owner_id', place.owner_id,
      'owner', owner.handle,
      'open_to_building', place.open_to_building,
      'open_to_things', place.open_to_things,
      'open_to_notes', place.open_to_notes,
      'drawing', place.drawing,
      'front_matter', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', thing.id,
          'type', 'thing',
          'name', thing.name,
          'body_text_bytes', octet_length(thing.body),
          'maker_id', thing.maker_id,
          'made_by', maker.handle,
          'current_owner_id', thing.owner_id,
          'current_owner', current_owner.handle
        ) ORDER BY selected.ordinality)
        FROM unnest(place.front_matter_thing_ids) WITH ORDINALITY selected(thing_id, ordinality)
        JOIN public.things thing ON thing.id = selected.thing_id
        JOIN public.residents maker ON maker.id = thing.maker_id
        JOIN public.residents current_owner ON current_owner.id = thing.owner_id
        LEFT JOIN latest_moderation thing_hidden
          ON thing_hidden.target_type = 'thing' AND thing_hidden.target_id = thing.id
        WHERE thing.place_id = place.id
          AND thing.withdrawn_at IS NULL
          AND coalesce(thing_hidden.action, 'restore') <> 'remove'
      ), '[]'::JSONB),
      'labels', coalesce((
        SELECT jsonb_agg(label.label ORDER BY label.label)
        FROM (
          SELECT DISTINCT active.label
          FROM public.active_labels active
          WHERE active.target_type = 'place' AND active.target_id = place.id
            AND (active.expires_at IS NULL OR active.expires_at > transaction_timestamp())
        ) label
      ), '[]'::JSONB),
      'laws', coalesce(law.laws, '[]'::JSONB),
      'created_at', place.created_at
    )
  END
FROM place_slots slot
LEFT JOIN public.places place ON place.id = slot.id
LEFT JOIN public.residents owner ON owner.id = place.owner_id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'place' AND hidden.target_id = place.id
LEFT JOIN effective_laws law ON law.origin_id = place.id

UNION ALL

SELECT 'things', slot.id::TEXT, slot.id,
  CASE
    WHEN thing.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public thing record'
    )
    WHEN thing.withdrawn_at IS NOT NULL THEN jsonb_build_object(
      'id', thing.id, 'status', 'withdrawn', 'withdrawn_at', thing.withdrawn_at
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', thing.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', thing.id,
      'status', 'exported',
      'place_id', thing.place_id,
      'name', thing.name,
      'body', thing.body,
      'maker_id', thing.maker_id,
      'made_by', maker.handle,
      'current_owner_id', thing.owner_id,
      'current_owner', current_owner.handle,
      'owner_id', thing.owner_id,
      'owner', current_owner.handle,
      'open_to_use', thing.open_to_use,
      'kind_id', thing.kind_id,
      'kind', CASE WHEN kind_hidden.action = 'remove' THEN '[removed by maintainer]'
        ELSE kind.name END,
      'kind_moderated', kind_hidden.action = 'remove',
      'birth_revision', thing.birth_revision,
      'current_revision', thing.current_revision,
      'drawing', CASE
        WHEN thing.drawing IS NOT NULL THEN thing.drawing
        WHEN coalesce(kind_hidden.action, 'restore') <> 'remove' THEN revision.drawing
        ELSE NULL
      END,
      'drawing_source', CASE
        WHEN thing.drawing IS NOT NULL THEN jsonb_build_object('type', 'thing')
        WHEN coalesce(kind_hidden.action, 'restore') <> 'remove'
          AND revision.drawing IS NOT NULL THEN jsonb_build_object(
            'type', 'kind_revision',
            'kind_id', thing.kind_id,
            'revision', thing.current_revision
          )
        ELSE NULL
      END,
      'created_at', thing.created_at
    )
  END
FROM thing_slots slot
LEFT JOIN public.things thing ON thing.id = slot.id
LEFT JOIN public.residents maker ON maker.id = thing.maker_id
LEFT JOIN public.residents current_owner ON current_owner.id = thing.owner_id
LEFT JOIN public.kinds kind ON kind.id = thing.kind_id
LEFT JOIN public.kind_revisions revision
  ON revision.kind_id = thing.kind_id AND revision.revision = thing.current_revision
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'thing' AND hidden.target_id = thing.id
LEFT JOIN latest_moderation kind_hidden
  ON kind_hidden.target_type = 'kind' AND kind_hidden.target_id = thing.kind_id

UNION ALL

SELECT 'notes', slot.id::TEXT, slot.id,
  CASE
    WHEN note.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public note record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', note.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', note.id,
      'status', 'exported',
      'place_id', note.place_id,
      'author_id', note.author_id,
      'author', author.handle,
      'body', note.body,
      'created_at', note.created_at
    )
  END
FROM note_slots slot
LEFT JOIN public.notes note ON note.id = slot.id
LEFT JOIN public.residents author ON author.id = note.author_id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'note' AND hidden.target_id = note.id

UNION ALL

SELECT 'traits', slot.id::TEXT, slot.id,
  CASE
    WHEN trait.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public trait record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', trait.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', trait.id,
      'status', 'exported',
      'name', trait.name,
      'description', trait.description,
      'recipe', trait.recipe,
      'mechanical', trait.mechanical,
      'coiner_id', trait.coiner_id,
      'coiner', coiner.handle,
      'created_at', trait.created_at
    )
  END
FROM trait_slots slot
LEFT JOIN public.traits trait ON trait.id = slot.id
LEFT JOIN public.residents coiner ON coiner.id = trait.coiner_id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'trait' AND hidden.target_id = trait.id

UNION ALL

SELECT 'kinds', slot.id::TEXT, slot.id,
  CASE
    WHEN kind.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public kind record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', kind.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', kind.id,
      'status', 'exported',
      'name', kind.name,
      'owner_id', kind.owner_id,
      'owner', owner.handle,
      'revision', revision.revision,
      'description', revision.description,
      'drawing', revision.drawing,
      'traits', coalesce((
        SELECT jsonb_agg(
          CASE WHEN trait_hidden.action = 'remove'
            THEN to_jsonb('[removed by maintainer]'::TEXT)
            ELSE to_jsonb(trait_name.name)
          END ORDER BY trait_name.position
        )
        FROM unnest(revision.traits) WITH ORDINALITY trait_name(name, position)
        LEFT JOIN public.traits named_trait ON named_trait.name = trait_name.name
        LEFT JOIN latest_moderation trait_hidden
          ON trait_hidden.target_type = 'trait' AND trait_hidden.target_id = named_trait.id
      ), '[]'::JSONB),
      'recipe', CASE
        WHEN jsonb_typeof(revision.recipe) = 'array' THEN coalesce((
          SELECT jsonb_agg(
            CASE WHEN ingredient_hidden.action = 'remove'
              THEN ingredient.value || jsonb_build_object('kind', '[removed by maintainer]')
              ELSE ingredient.value
            END ORDER BY ingredient.position
          )
          FROM jsonb_array_elements(revision.recipe)
            WITH ORDINALITY ingredient(value, position)
          LEFT JOIN public.kinds ingredient_kind
            ON ingredient_kind.name = ingredient.value->>'kind'
          LEFT JOIN latest_moderation ingredient_hidden
            ON ingredient_hidden.target_type = 'kind'
            AND ingredient_hidden.target_id = ingredient_kind.id
        ), '[]'::JSONB)
        ELSE revision.recipe
      END,
      'created_at', kind.created_at,
      'revision_created_at', revision.created_at
    )
  END
FROM kind_slots slot
LEFT JOIN public.kinds kind ON kind.id = slot.id
LEFT JOIN public.kind_revisions revision
  ON revision.kind_id = kind.id AND revision.revision = kind.current_revision
LEFT JOIN public.residents owner ON owner.id = kind.owner_id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'kind' AND hidden.target_id = kind.id

UNION ALL

SELECT 'agreements', slot.id::TEXT, slot.id,
  CASE
    WHEN agreement.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public agreement record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', agreement.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', agreement.id,
      'status', 'exported',
      'body', agreement.body,
      'created_by_id', agreement.created_by_id,
      'created_by', creator.handle,
      'parties', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'resident_id', party.resident_id,
          'handle', resident.handle,
          'named', party.named
        ) ORDER BY party.named DESC, party.resident_id)
        FROM public.agreement_parties party
        JOIN public.residents resident ON resident.id = party.resident_id
        WHERE party.agreement_id = agreement.id
      ), '[]'::JSONB),
      'signatures', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'resident_id', signature.resident_id,
          'handle', resident.handle,
          'signed_at', signature.signed_at
        ) ORDER BY signature.signed_at, signature.resident_id)
        FROM public.agreement_signatures signature
        JOIN public.residents resident ON resident.id = signature.resident_id
        WHERE signature.agreement_id = agreement.id
      ), '[]'::JSONB),
      'accession_open', EXISTS (
        SELECT 1 FROM public.agreement_accession_openings opening
        WHERE opening.agreement_id = agreement.id
      ),
      'open', EXISTS (
        SELECT 1
        FROM public.agreement_parties party
        LEFT JOIN public.agreement_signatures signature
          ON signature.agreement_id = party.agreement_id
          AND signature.resident_id = party.resident_id
        WHERE party.agreement_id = agreement.id AND signature.resident_id IS NULL
      ),
      'created_at', agreement.created_at
    )
  END
FROM agreement_slots slot
LEFT JOIN public.agreements agreement ON agreement.id = slot.id
LEFT JOIN public.residents creator ON creator.id = agreement.created_by_id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'agreement' AND hidden.target_id = agreement.id

UNION ALL

SELECT 'events', slot.id::TEXT, slot.id,
  CASE
    WHEN event.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public event record'
    )
    ELSE jsonb_build_object(
      'id', event.id,
      'status', 'exported',
      'at', event.at,
      'kind', event.kind,
      'actor', event.actor,
      'detail', jsonb_strip_nulls(jsonb_build_object(
        'resident_id', event.detail->'resident_id',
        'place_id', event.detail->'place_id',
        'from_place_id', event.detail->'from_place_id',
        'to_place_id', event.detail->'to_place_id',
        'thing_id', event.detail->'thing_id',
        'source_thing_id', event.detail->'source_thing_id',
        'kind_id', event.detail->'kind_id',
        'trait_id', event.detail->'trait_id',
        'agreement_id', event.detail->'agreement_id',
        'note_id', event.detail->'note_id',
        'transfer_id', event.detail->'transfer_id',
        'offer_id', event.detail->'offer_id',
        'flag_id', event.detail->'flag_id',
        'target_id', event.detail->'target_id',
        'asset_id', event.detail->'asset_id',
        'parent_id', event.detail->'parent_id',
        'action_id', event.detail->'action_id',
        'effect_id', event.detail->'effect_id',
        'pending_effect_id', event.detail->'pending_effect_id',
        'moderation_id', event.detail->'moderation_id',
        'id', event.detail->'id',
        'type', event.detail->'type',
        'target_type', event.detail->'target_type',
        'asset_type', event.detail->'asset_type',
        'action', event.detail->'action',
        'mode', event.detail->'mode',
        'status', event.detail->'status',
        'effects_applied', event.detail->'effects_applied',
        'due_at', event.detail->'due_at',
        'generation', event.detail->'generation',
        'name', CASE WHEN event_place_hidden.action = 'remove'
          THEN to_jsonb('[removed by maintainer]'::text) ELSE event.detail->'name' END,
        'former_name', CASE WHEN event_place_hidden.action = 'remove'
          THEN to_jsonb('[removed by maintainer]'::text) ELSE event.detail->'former_name' END,
        'error', event.detail->'error',
        'channel', event.detail->'channel'
      )),
      'detail_policy', 'safe references only; authored text is in its primary exported record'
    )
  END
FROM event_slots slot
LEFT JOIN public.events event ON event.id = slot.id
LEFT JOIN latest_moderation event_place_hidden
  ON event_place_hidden.target_type = 'place'
    AND event_place_hidden.target_id::text = event.detail->>'place_id'

UNION ALL

SELECT 'moderation', slot.id::TEXT, slot.id,
  CASE
    WHEN moderation.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public moderation record'
    )
    ELSE jsonb_build_object(
      'id', moderation.id,
      'status', 'exported',
      'target_type', moderation.target_type,
      'target_id', moderation.target_id,
      'action', moderation.action,
      'reason', moderation.reason,
      'actor_id', moderation.actor_id,
      'actor', actor.handle,
      'created_at', moderation.created_at
    )
  END
FROM moderation_slots slot
LEFT JOIN public.moderation_actions moderation ON moderation.id = slot.id
LEFT JOIN public.residents actor ON actor.id = moderation.actor_id

UNION ALL

SELECT 'treasury_fees', slot.id::TEXT, slot.id,
  CASE
    WHEN fee.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public treasury-fee record'
    )
    ELSE jsonb_build_object(
      'id', fee.id,
      'status', 'exported',
      'resident_id', fee.resident_id,
      'handle', resident.handle,
      'purpose', fee.purpose,
      'amount_usdc', to_char(fee.amount_usdc, 'FM9999999990.000000'),
      'tx_hash', fee.tx_hash,
      'created_at', fee.created_at
    )
  END
FROM fee_slots slot
LEFT JOIN public.fees fee ON fee.id = slot.id
LEFT JOIN public.residents resident ON resident.id = fee.resident_id

UNION ALL

SELECT 'world_market_offers', slot.id::TEXT, slot.id,
  CASE
    WHEN offer.id IS NULL THEN jsonb_build_object(
      'id', slot.id,
      'status', 'not_public_or_sequence_gap',
      'reason', 'this shared offer ID is not a public world-market record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', offer.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', offer.id,
      'status', 'exported',
      'channel', 'world',
      'phase', CASE
        WHEN offer.status = 'claimed' THEN 'claimed'
        WHEN offer.status = 'canceled' THEN 'canceled'
        WHEN offer.x402_evidence_state = 'invalid' THEN 'payment_invalid'
        WHEN offer.x402_evidence_state = 'founder_review' THEN 'founder_review'
        WHEN offer.x402_evidence_state = 'expired' THEN 'payment_expired'
        WHEN offer.pending_x402_tx_hash IS NOT NULL THEN 'payment_pending'
        WHEN offer.status = 'open' AND offer.buyer_id IS NOT NULL
          AND offer.reserved_by = offer.buyer_id
          AND offer.buyer_wallet IS NOT NULL
          AND offer.reserved_at <= transaction_timestamp()
          AND offer.reserved_until > transaction_timestamp()
          THEN 'reserved'
        ELSE 'listed'
      END,
      'asset_type', 'thing',
      'asset_id', offer.asset_id,
      'asset_name', thing.name,
      'maker_id', thing.maker_id,
      'made_by', maker.handle,
      'current_owner_id', thing.owner_id,
      'current_owner', current_owner.handle,
      'locked', offer.status = 'open'
        AND thing.owner_id = offer.seller_id
        AND thing.withdrawn_at IS NULL
        AND thing.active_offer_id = offer.id,
      'seller', seller.handle,
      'buyer', buyer.handle,
      'price_usdc', to_char(offer.price_usdc, 'FM9999999990.000000'),
      'seller_wallet', lower(offer.seller_wallet),
      'market_origin', offer.market_origin,
      'market_draft_id', offer.market_draft_id,
      'market_listing_id', offer.market_listing_id,
      'market_checkout_id', offer.market_checkout_id,
      'market_buyer', offer.market_buyer,
      'pending_x402_tx_hash', offer.pending_x402_tx_hash,
      'pending_x402_at', offer.pending_x402_at,
      'x402_invalid_reason', offer.x402_invalid_reason,
      'x402_invalid_at', offer.x402_invalid_at,
      'reserved_at', offer.reserved_at,
      'reserved_until', offer.reserved_until,
      'created_at', offer.created_at,
      'claimed_at', offer.claimed_at,
      'canceled_at', offer.canceled_at,
      'tx_hash', payment.tx_hash,
      'buyer_wallet', lower(offer.buyer_wallet),
      'verified_via', payment.verified_via,
      'block_time', payment.block_time,
      'from', lower(payment.payer_wallet),
      'to', lower(payment.payee_wallet)
    )
  END
FROM world_offer_slots slot
LEFT JOIN public.transfer_offers offer
  ON offer.id = slot.id AND offer.channel = 'world' AND offer.asset_type = 'thing'
LEFT JOIN public.things thing ON thing.id = offer.asset_id
LEFT JOIN public.residents maker ON maker.id = thing.maker_id
LEFT JOIN public.residents current_owner ON current_owner.id = thing.owner_id
LEFT JOIN public.residents seller ON seller.id = offer.seller_id
LEFT JOIN public.residents buyer ON buyer.id = offer.buyer_id
LEFT JOIN public.sale_payments payment ON payment.offer_id = offer.id
LEFT JOIN latest_moderation hidden
  ON hidden.target_type = 'thing' AND hidden.target_id = thing.id;


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
  BEFORE INSERT OR UPDATE OF parent_id, retired_at ON places
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
