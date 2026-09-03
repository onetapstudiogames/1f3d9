BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $public_snapshot_quiet_prerequisites$
BEGIN
  -- This migration only replaces public_records_without_drawing_contract
  -- (the base view place.quiet is read from); it does not assume anything
  -- about how public_records or public_records_v2 wrap it internally, since
  -- that wrapping has already changed across prior migrations.
  IF to_regclass('city_snapshot.public_records_without_drawing_contract') IS NULL THEN
    RAISE EXCEPTION
      'public snapshot quiet disclosure requires the drawing-aware v1 wrapper view'
      USING ERRCODE = '55000';
  END IF;
END
$public_snapshot_quiet_prerequisites$;

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
      'quiet', place.quiet,
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

REVOKE ALL ON city_snapshot.public_records_without_drawing_contract FROM PUBLIC;
REVOKE ALL ON city_snapshot.public_records_without_drawing_contract FROM city_snapshot_export;

COMMIT;
