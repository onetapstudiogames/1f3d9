const RESPONSE_WRAPPER = '__1f3d9_x402_response_v1'

export const INVALIDATE_SALE_TARGET_SQL = `
  /* payment-sale-operations:invalidate-target */
  WITH invalid_attempt AS MATERIALIZED (
    UPDATE payment_attempts attempt SET
      status = 'invalid', invalid_reason = $3,
      lease_owner = NULL, lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE attempt.public_id = $1 AND attempt.lease_owner = $2
      AND attempt.operation IN ('direct_sale', 'world_sale')
      AND attempt.method = 'x402'
      AND attempt.status IN ('settling', 'payment_pending', 'needs_review')
    RETURNING attempt.*,
      CASE WHEN attempt.invalid_reason = 'failed_transaction'
        THEN 'failed_transaction' ELSE 'confirmed_mismatch' END AS offer_invalid_reason
  ), world_invalid_evidence AS (
    UPDATE transfer_offers offer SET
      x402_evidence_state = 'invalid',
      x402_invalid_reason = attempt.offer_invalid_reason,
      x402_invalid_at = clock_timestamp()
    FROM invalid_attempt attempt
    WHERE attempt.operation = 'world_sale'
      AND offer.id = attempt.offer_id AND offer.channel = 'world'
      AND offer.asset_type = 'thing' AND offer.asset_id = attempt.asset_id
      AND offer.seller_id = attempt.counterparty_id AND offer.buyer_id = attempt.actor_id
      AND offer.status = 'open' AND offer.x402_evidence_state = 'pending'
      AND offer.pending_payment_attempt_id = attempt.public_id
      AND offer.pending_x402_tx_hash = attempt.tx_hash
      AND lower(offer.pending_x402_payer) = attempt.payer_wallet
      AND lower(offer.buyer_wallet) = attempt.payer_wallet
      AND lower(offer.seller_wallet) = attempt.payee_wallet
      AND attempt.amount_units = (offer.price_usdc * 1000000)::bigint
      AND attempt.target_key = 'world-sale:' || offer.id::text
      AND attempt.request_json = jsonb_build_object(
        'offer_id', offer.id,
        'market_checkout_id', offer.market_checkout_id,
        'market_listing_id', offer.market_listing_id,
        'market_draft_id', offer.market_draft_id,
        'market_buyer', offer.market_buyer,
        'buyer_wallet', lower(offer.buyer_wallet),
        'seller_wallet', lower(offer.seller_wallet),
        'price_usdc', offer.price_usdc,
        'asset_id', offer.asset_id
      )
      AND EXISTS (
        SELECT 1 FROM things thing WHERE thing.id = offer.asset_id
          AND thing.owner_id = offer.seller_id AND thing.withdrawn_at IS NULL
          AND thing.active_offer_id = offer.id
      )
    RETURNING offer.id
  ), direct_canceled_offer AS (
    UPDATE transfer_offers offer SET
      status = 'canceled', canceled_at = clock_timestamp()
    FROM invalid_attempt attempt
    WHERE attempt.operation = 'direct_sale'
      AND offer.id = attempt.offer_id AND offer.channel = 'direct'
      AND offer.status = 'open' AND offer.buyer_id = attempt.actor_id
      AND offer.seller_id = attempt.counterparty_id
      AND offer.asset_type = attempt.asset_type AND offer.asset_id = attempt.asset_id
      AND lower(offer.buyer_wallet) = attempt.payer_wallet
      AND lower(offer.seller_wallet) = attempt.payee_wallet
      AND attempt.amount_units = (offer.price_usdc * 1000000)::bigint
      AND attempt.target_key = 'direct-sale:' || offer.id::text
      AND attempt.request_json = jsonb_build_object(
        'offer_id', offer.id,
        'buyer_wallet', lower(offer.buyer_wallet),
        'seller_wallet', lower(offer.seller_wallet),
        'price_usdc', offer.price_usdc,
        'asset_type', offer.asset_type,
        'asset_id', offer.asset_id
      )
      AND (
        (offer.asset_type = 'place' AND EXISTS (
          SELECT 1 FROM places asset WHERE asset.id = offer.asset_id
            AND asset.owner_id = offer.seller_id AND asset.active_offer_id = offer.id
        )) OR (offer.asset_type = 'thing' AND EXISTS (
          SELECT 1 FROM things asset WHERE asset.id = offer.asset_id
            AND asset.owner_id = offer.seller_id AND asset.active_offer_id = offer.id
            AND asset.withdrawn_at IS NULL
        )) OR (offer.asset_type = 'kind' AND EXISTS (
          SELECT 1 FROM kinds asset WHERE asset.id = offer.asset_id
            AND asset.owner_id = offer.seller_id AND asset.active_offer_id = offer.id
        ))
      )
    RETURNING offer.id, offer.asset_type, offer.asset_id
  ), released_place AS (
    UPDATE places SET active_offer_id = NULL
    FROM direct_canceled_offer offer
    WHERE offer.asset_type = 'place' AND places.id = offer.asset_id
      AND places.active_offer_id = offer.id
    RETURNING places.id
  ), released_thing AS (
    UPDATE things SET active_offer_id = NULL
    FROM direct_canceled_offer offer
    WHERE offer.asset_type = 'thing' AND things.id = offer.asset_id
      AND things.active_offer_id = offer.id
    RETURNING things.id
  ), released_kind AS (
    UPDATE kinds SET active_offer_id = NULL
    FROM direct_canceled_offer offer
    WHERE offer.asset_type = 'kind' AND kinds.id = offer.asset_id
      AND kinds.active_offer_id = offer.id
    RETURNING kinds.id
  ), safety_guard AS MATERIALIZED (
    SELECT 1 / CASE WHEN (
      attempt.operation = 'world_sale'
      AND EXISTS (
        SELECT 1 FROM transfer_offers offer
        WHERE offer.id = attempt.offer_id AND offer.x402_evidence_state = 'pending'
          AND offer.pending_payment_attempt_id = attempt.public_id
      )
      AND NOT EXISTS (SELECT 1 FROM world_invalid_evidence)
    ) OR (
      attempt.operation = 'direct_sale'
      AND EXISTS (SELECT 1 FROM direct_canceled_offer)
      AND (
        (SELECT count(*) FROM released_place) + (SELECT count(*) FROM released_thing)
          + (SELECT count(*) FROM released_kind)
      ) <> 1
    ) THEN 0 ELSE 1 END AS ok
    FROM invalid_attempt attempt
  )
  SELECT 'invalid'::text AS state, attempt.public_id AS attempt_id,
    attempt.actor_id, attempt.operation, attempt.method,
    CASE WHEN attempt.operation = 'direct_sale'
      THEN EXISTS (SELECT 1 FROM direct_canceled_offer) ELSE false END AS target_released,
    CASE WHEN attempt.operation = 'world_sale'
      THEN EXISTS (SELECT 1 FROM world_invalid_evidence) ELSE false END AS evidence_synchronized
  FROM invalid_attempt attempt
  JOIN safety_guard guard ON guard.ok = 1
`
export const CLOSE_INVALID_SALE_TARGET_SQL = `
  /* payment-sale-operations:close-invalid-target */
  WITH invalid_attempt AS MATERIALIZED (
    SELECT attempt.*,
      CASE WHEN attempt.invalid_reason = 'failed_transaction'
        THEN 'failed_transaction' ELSE 'confirmed_mismatch' END AS offer_invalid_reason
    FROM payment_attempts attempt
    WHERE attempt.public_id = $1
      AND attempt.operation IN ('direct_sale', 'world_sale')
      AND attempt.method = 'x402' AND attempt.status = 'invalid'
  ), world_invalid_evidence AS (
    UPDATE transfer_offers offer SET
      x402_evidence_state = 'invalid',
      x402_invalid_reason = attempt.offer_invalid_reason,
      x402_invalid_at = clock_timestamp()
    FROM invalid_attempt attempt
    WHERE attempt.operation = 'world_sale'
      AND offer.id = attempt.offer_id AND offer.channel = 'world'
      AND offer.asset_type = 'thing' AND offer.asset_id = attempt.asset_id
      AND offer.seller_id = attempt.counterparty_id AND offer.buyer_id = attempt.actor_id
      AND offer.status = 'open' AND offer.x402_evidence_state = 'pending'
      AND offer.pending_payment_attempt_id = attempt.public_id
      AND offer.pending_x402_tx_hash = attempt.tx_hash
      AND lower(offer.pending_x402_payer) = attempt.payer_wallet
      AND lower(offer.buyer_wallet) = attempt.payer_wallet
      AND lower(offer.seller_wallet) = attempt.payee_wallet
      AND attempt.amount_units = (offer.price_usdc * 1000000)::bigint
      AND attempt.target_key = 'world-sale:' || offer.id::text
      AND attempt.request_json = jsonb_build_object(
        'offer_id', offer.id,
        'market_checkout_id', offer.market_checkout_id,
        'market_listing_id', offer.market_listing_id,
        'market_draft_id', offer.market_draft_id,
        'market_buyer', offer.market_buyer,
        'buyer_wallet', lower(offer.buyer_wallet),
        'seller_wallet', lower(offer.seller_wallet),
        'price_usdc', offer.price_usdc,
        'asset_id', offer.asset_id
      )
    RETURNING offer.id
  ), direct_canceled_offer AS (
    UPDATE transfer_offers offer SET
      status = 'canceled', canceled_at = clock_timestamp()
    FROM invalid_attempt attempt
    WHERE attempt.operation = 'direct_sale'
      AND offer.id = attempt.offer_id AND offer.channel = 'direct'
      AND offer.status = 'open' AND offer.buyer_id = attempt.actor_id
      AND offer.seller_id = attempt.counterparty_id
      AND offer.asset_type = attempt.asset_type AND offer.asset_id = attempt.asset_id
      AND lower(offer.buyer_wallet) = attempt.payer_wallet
      AND lower(offer.seller_wallet) = attempt.payee_wallet
      AND attempt.amount_units = (offer.price_usdc * 1000000)::bigint
      AND attempt.target_key = 'direct-sale:' || offer.id::text
      AND attempt.request_json = jsonb_build_object(
        'offer_id', offer.id,
        'buyer_wallet', lower(offer.buyer_wallet),
        'seller_wallet', lower(offer.seller_wallet),
        'price_usdc', offer.price_usdc,
        'asset_type', offer.asset_type,
        'asset_id', offer.asset_id
      )
    RETURNING offer.id, offer.asset_type, offer.asset_id
  ), released_place AS (
    UPDATE places SET active_offer_id = NULL
    FROM direct_canceled_offer offer
    WHERE offer.asset_type = 'place' AND places.id = offer.asset_id
      AND places.active_offer_id = offer.id
    RETURNING places.id
  ), released_thing AS (
    UPDATE things SET active_offer_id = NULL
    FROM direct_canceled_offer offer
    WHERE offer.asset_type = 'thing' AND things.id = offer.asset_id
      AND things.active_offer_id = offer.id
    RETURNING things.id
  ), released_kind AS (
    UPDATE kinds SET active_offer_id = NULL
    FROM direct_canceled_offer offer
    WHERE offer.asset_type = 'kind' AND kinds.id = offer.asset_id
      AND kinds.active_offer_id = offer.id
    RETURNING kinds.id
  )
  SELECT 'invalid'::text AS state, attempt.public_id AS attempt_id,
    attempt.actor_id, attempt.operation, attempt.method,
    CASE WHEN attempt.operation = 'direct_sale' THEN (
      EXISTS (SELECT 1 FROM direct_canceled_offer)
      OR EXISTS (
        SELECT 1 FROM transfer_offers offer
        WHERE offer.id = attempt.offer_id AND offer.status = 'canceled'
      )
    ) ELSE false END AS target_released,
    CASE WHEN attempt.operation = 'world_sale' THEN (
      EXISTS (SELECT 1 FROM world_invalid_evidence)
      OR EXISTS (
        SELECT 1 FROM transfer_offers offer
        WHERE offer.id = attempt.offer_id AND offer.x402_evidence_state = 'invalid'
          AND offer.pending_payment_attempt_id = attempt.public_id
      )
    ) ELSE false END AS evidence_synchronized,
    (SELECT count(*) FROM released_place) + (SELECT count(*) FROM released_thing)
      + (SELECT count(*) FROM released_kind) AS released_asset_rows
  FROM invalid_attempt attempt
`

export const CLOSE_SALE_TARGET_SQL = `
  /* payment-sale-operations:close-target */
  WITH terminal_attempt AS MATERIALIZED (
    UPDATE payment_attempts attempt SET
      status = $3,
      invalid_reason = coalesce(attempt.invalid_reason, $4),
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE attempt.public_id = $1 AND attempt.lease_owner = $2
      AND attempt.operation IN ('direct_sale', 'world_sale')
      AND attempt.method = 'x402'
      AND attempt.status IN ('settling', 'payment_pending', 'needs_review')
      AND (
        $3 = 'founder_review'
        OR (
          $3 = 'expired'
          AND attempt.recovery_deadline_at IS NOT NULL
          AND attempt.recovery_deadline_at <= clock_timestamp()
        )
      )
    RETURNING attempt.*
  ), world_terminal_evidence AS (
    UPDATE transfer_offers offer SET
      pending_payment_attempt_id = coalesce(
        offer.pending_payment_attempt_id,
        attempt.public_id
      ),
      pending_x402_tx_hash = coalesce(offer.pending_x402_tx_hash, attempt.tx_hash),
      pending_x402_payer = coalesce(offer.pending_x402_payer, attempt.payer_wallet),
      pending_x402_at = coalesce(
        offer.pending_x402_at,
        attempt.recovery_started_at,
        clock_timestamp()
      ),
      x402_evidence_state = $3,
      x402_invalid_reason = NULL,
      x402_invalid_at = NULL
    FROM terminal_attempt attempt
    WHERE attempt.operation = 'world_sale'
      AND attempt.tx_hash IS NOT NULL
      AND attempt.payer_wallet IS NOT NULL
      AND offer.id = attempt.offer_id AND offer.channel = 'world'
      AND offer.asset_type = 'thing' AND offer.status = 'open'
      AND offer.buyer_id = attempt.actor_id AND offer.seller_id = attempt.counterparty_id
      AND offer.asset_id = attempt.asset_id
      AND offer.x402_evidence_state IN ('none', 'pending')
      AND (
        offer.pending_payment_attempt_id IS NULL
        OR offer.pending_payment_attempt_id = attempt.public_id
      )
      AND (offer.pending_x402_tx_hash IS NULL OR offer.pending_x402_tx_hash = attempt.tx_hash)
      AND (
        offer.pending_x402_payer IS NULL
        OR lower(offer.pending_x402_payer) = attempt.payer_wallet
      )
    RETURNING offer.id
  ), direct_canceled_offer AS (
    UPDATE transfer_offers offer SET
      status = 'canceled',
      canceled_at = clock_timestamp()
    FROM terminal_attempt attempt
    WHERE attempt.operation = 'direct_sale'
      AND offer.id = attempt.offer_id AND offer.channel = 'direct'
      AND offer.status = 'open' AND offer.buyer_id = attempt.actor_id
      AND offer.seller_id = attempt.counterparty_id
      AND offer.asset_type = attempt.asset_type AND offer.asset_id = attempt.asset_id
    RETURNING offer.id, offer.asset_type, offer.asset_id, offer.seller_id
  ), released_place AS (
    UPDATE places SET active_offer_id = NULL
    FROM direct_canceled_offer offer
    WHERE offer.asset_type = 'place' AND places.id = offer.asset_id
      AND places.active_offer_id = offer.id
    RETURNING places.id
  ), released_thing AS (
    UPDATE things SET active_offer_id = NULL
    FROM direct_canceled_offer offer
    WHERE offer.asset_type = 'thing' AND things.id = offer.asset_id
      AND things.active_offer_id = offer.id
    RETURNING things.id
  ), released_kind AS (
    UPDATE kinds SET active_offer_id = NULL
    FROM direct_canceled_offer offer
    WHERE offer.asset_type = 'kind' AND kinds.id = offer.asset_id
      AND kinds.active_offer_id = offer.id
    RETURNING kinds.id
  )
  SELECT $3::text AS state, attempt.public_id AS attempt_id,
    attempt.actor_id, attempt.operation, attempt.method,
    CASE WHEN attempt.operation = 'world_sale' THEN false
      ELSE EXISTS (SELECT 1 FROM direct_canceled_offer) END AS target_released,
    (SELECT count(*) FROM world_terminal_evidence) AS world_evidence_rows,
    (SELECT count(*) FROM released_place) + (SELECT count(*) FROM released_thing)
      + (SELECT count(*) FROM released_kind) AS released_asset_rows
  FROM terminal_attempt attempt
`

export const DIRECT_COMPLETION_SQL = `
  /* payment-sale-operations:complete-direct */
  WITH payment_attempt AS MATERIALIZED (
    SELECT attempt.*
    FROM payment_attempts attempt
    WHERE attempt.public_id = $1 AND attempt.lease_owner = $2
      AND attempt.operation = 'direct_sale' AND attempt.method = 'x402'
      AND attempt.status = 'payment_pending'
      AND attempt.recovery_deadline_at IS NOT NULL
      AND attempt.recovery_deadline_at > clock_timestamp()
      AND attempt.tx_hash IS NOT NULL
      AND attempt.finalized_block_number IS NOT NULL
      AND attempt.finalized_block_hash IS NOT NULL
      AND attempt.finalized_block_time IS NOT NULL
      AND attempt.finalized_at IS NOT NULL
    FOR UPDATE
  ), eligible_offer AS MATERIALIZED (
    SELECT offer.*, attempt.public_id AS attempt_id, attempt.tx_hash,
      attempt.actor_id, attempt.finalized_block_time
    FROM payment_attempt attempt
    JOIN transfer_offers offer ON offer.id = attempt.offer_id
    WHERE offer.channel = 'direct' AND offer.status = 'open'
      AND offer.buyer_id = attempt.actor_id
      AND offer.seller_id = attempt.counterparty_id
      AND offer.asset_type = attempt.asset_type AND offer.asset_id = attempt.asset_id
      AND offer.reserved_by = attempt.actor_id
      AND lower(offer.buyer_wallet) = attempt.payer_wallet
      AND lower(offer.seller_wallet) = attempt.payee_wallet
      AND attempt.amount_units = (offer.price_usdc * 1000000)::bigint
      AND attempt.target_key = 'direct-sale:' || offer.id::text
      AND attempt.request_json = jsonb_build_object(
        'offer_id', offer.id,
        'buyer_wallet', lower(offer.buyer_wallet),
        'seller_wallet', lower(offer.seller_wallet),
        'price_usdc', offer.price_usdc,
        'asset_type', offer.asset_type,
        'asset_id', offer.asset_id
      )
      AND attempt.finalized_block_time >= date_trunc('second', offer.reserved_at)
        + CASE WHEN offer.reserved_at > date_trunc('second', offer.reserved_at)
          THEN interval '1 second' ELSE interval '0 seconds' END
      AND attempt.finalized_block_time < date_trunc('second', offer.reserved_until)
  ), changed_place AS (
    UPDATE places SET owner_id = offer.actor_id, active_offer_id = NULL
    FROM eligible_offer offer
    WHERE offer.asset_type = 'place' AND places.id = offer.asset_id
      AND places.owner_id = offer.seller_id AND places.active_offer_id = offer.id
    RETURNING places.id, offer.id AS offer_id, offer.seller_id, offer.actor_id,
      offer.asset_type, offer.price_usdc, offer.tx_hash
  ), changed_thing AS (
    UPDATE things SET owner_id = offer.actor_id, active_offer_id = NULL
    FROM eligible_offer offer
    WHERE offer.asset_type = 'thing' AND things.id = offer.asset_id
      AND things.owner_id = offer.seller_id AND things.active_offer_id = offer.id
      AND things.withdrawn_at IS NULL
    RETURNING things.id, offer.id AS offer_id, offer.seller_id, offer.actor_id,
      offer.asset_type, offer.price_usdc, offer.tx_hash
  ), changed_kind AS (
    UPDATE kinds SET owner_id = offer.actor_id, active_offer_id = NULL
    FROM eligible_offer offer
    WHERE offer.asset_type = 'kind' AND kinds.id = offer.asset_id
      AND kinds.owner_id = offer.seller_id AND kinds.active_offer_id = offer.id
    RETURNING kinds.id, offer.id AS offer_id, offer.seller_id, offer.actor_id,
      offer.asset_type, offer.price_usdc, offer.tx_hash
  ), changed_asset AS MATERIALIZED (
    SELECT * FROM changed_place
    UNION ALL SELECT * FROM changed_thing
    UNION ALL SELECT * FROM changed_kind
  ), claimed_offer AS (
    UPDATE transfer_offers offer SET status = 'claimed', claimed_at = clock_timestamp()
    FROM changed_asset asset
    WHERE offer.id = asset.offer_id AND offer.status = 'open'
    RETURNING offer.*, asset.tx_hash
  ), used_payment AS (
    INSERT INTO payment_uses (
      tx_hash, payment_attempt_id, actor_id, purpose,
      payer_wallet, payee_wallet, amount_usdc
    )
    SELECT offer.tx_hash, $1, offer.buyer_id, 'sale', lower(offer.buyer_wallet),
      lower(offer.seller_wallet), offer.price_usdc
    FROM claimed_offer offer
    RETURNING tx_hash
  ), new_payment AS (
    INSERT INTO sale_payments (
      offer_id, buyer_id, payer_wallet, payee_wallet, amount_usdc,
      tx_hash, verified_via, block_time
    )
    SELECT offer.id, offer.buyer_id, lower(offer.buyer_wallet), lower(offer.seller_wallet),
      offer.price_usdc, payment.tx_hash, 'x402', attempt.finalized_block_time
    FROM claimed_offer offer
    JOIN used_payment payment ON true
    JOIN payment_attempt attempt ON true
    RETURNING offer_id
  ), new_transfer AS (
    INSERT INTO transfers (
      asset_type, asset_id, from_id, to_id, offer_id, price_usdc, tx_hash
    )
    SELECT asset.asset_type, asset.id, asset.seller_id, asset.actor_id,
      asset.offer_id, asset.price_usdc, asset.tx_hash
    FROM changed_asset asset
    JOIN new_payment payment ON payment.offer_id = asset.offer_id
    RETURNING id, asset_type, asset_id, from_id, to_id, offer_id,
      price_usdc, tx_hash, created_at
  ), new_event AS (
    INSERT INTO events (kind, actor, detail)
    SELECT 'sale', buyer.handle, jsonb_build_object(
      'transfer_id', transfer.id, 'offer_id', transfer.offer_id,
      'asset_type', transfer.asset_type, 'asset_id', transfer.asset_id,
      'from', seller.handle, 'to', buyer.handle,
      'price_usdc', transfer.price_usdc, 'tx_hash', transfer.tx_hash
    )
    FROM new_transfer transfer
    JOIN residents seller ON seller.id = transfer.from_id
    JOIN residents buyer ON buyer.id = transfer.to_id
  ), response_payload AS (
    SELECT jsonb_build_object(
      'offer', jsonb_build_object('id', transfer.offer_id, 'status', 'claimed'),
      'transfer', jsonb_build_object(
        'id', transfer.id, 'type', transfer.asset_type,
        'asset_id', transfer.asset_id, 'from', seller.handle, 'to', buyer.handle,
        'price_usdc', transfer.price_usdc, 'tx_hash', transfer.tx_hash,
        'created_at', transfer.created_at
      )
    ) AS body
    FROM new_transfer transfer
    JOIN residents seller ON seller.id = transfer.from_id
    JOIN residents buyer ON buyer.id = transfer.to_id
  ), completed_attempt AS (
    SELECT complete_payment_attempt(
      $1, $2,
      jsonb_build_object('kind', 'transfer_offer', 'id', offer.id),
      200::smallint, response.body, convert_to(response.body::text, 'UTF8')
    ) AS completed
    FROM claimed_offer offer
    JOIN used_payment payment ON true
    JOIN response_payload response ON true
  )
  SELECT 'completed'::text AS state, (completed).public_id AS attempt_id,
    (completed).actor_id, (completed).operation, (completed).method,
    (completed).response_status,
    CASE WHEN (completed).response_json ? '${RESPONSE_WRAPPER}'
      THEN (completed).response_json #> '{${RESPONSE_WRAPPER},body}'
      ELSE (completed).response_json END AS response,
    convert_from((completed).response_body_bytes, 'UTF8') AS response_body,
    (completed).response_json #>> '{${RESPONSE_WRAPPER},header}' AS payment_response_header
  FROM completed_attempt
`

export const WORLD_PARK_SQL = `
  /* payment-sale-operations:park-world */
  WITH payment_attempt AS MATERIALIZED (
    SELECT attempt.*
    FROM payment_attempts attempt
    WHERE attempt.public_id = $1 AND attempt.operation = 'world_sale'
      AND attempt.method = 'x402'
      AND attempt.status IN ('payment_pending', 'needs_review')
      AND attempt.recovery_deadline_at IS NOT NULL
      AND attempt.recovery_deadline_at > clock_timestamp()
      AND attempt.tx_hash IS NOT NULL
  ), parked AS (
    UPDATE transfer_offers offer SET
      pending_payment_attempt_id = attempt.public_id,
      pending_x402_tx_hash = attempt.tx_hash,
      pending_x402_payer = attempt.payer_wallet,
      pending_x402_at = clock_timestamp()
    FROM payment_attempt attempt
    WHERE offer.id = attempt.offer_id AND offer.channel = 'world'
      AND offer.asset_type = 'thing' AND offer.status = 'open'
      AND offer.buyer_id = attempt.actor_id AND offer.reserved_by = attempt.actor_id
      AND offer.seller_id = attempt.counterparty_id
      AND offer.asset_id = attempt.asset_id
      AND lower(offer.buyer_wallet) = attempt.payer_wallet
      AND lower(offer.seller_wallet) = attempt.payee_wallet
      AND attempt.amount_units = (offer.price_usdc * 1000000)::bigint
      AND attempt.target_key = 'world-sale:' || offer.id::text
      AND attempt.request_json = jsonb_build_object(
        'offer_id', offer.id,
        'market_checkout_id', offer.market_checkout_id,
        'market_listing_id', offer.market_listing_id,
        'market_draft_id', offer.market_draft_id,
        'market_buyer', offer.market_buyer,
        'buyer_wallet', lower(offer.buyer_wallet),
        'seller_wallet', lower(offer.seller_wallet),
        'price_usdc', offer.price_usdc,
        'asset_id', offer.asset_id
      )
      AND offer.pending_payment_attempt_id IS NULL
      AND offer.pending_x402_tx_hash IS NULL AND offer.x402_evidence_state = 'none'
      AND EXISTS (
        SELECT 1 FROM things thing WHERE thing.id = offer.asset_id
          AND thing.owner_id = offer.seller_id AND thing.withdrawn_at IS NULL
          AND thing.active_offer_id = offer.id
      )
    RETURNING offer.id
  )
  SELECT 'parked'::text AS state FROM parked
`

export const WORLD_COMPLETION_SQL = `
  /* payment-sale-operations:complete-world */
  WITH payment_attempt AS MATERIALIZED (
    SELECT attempt.*
    FROM payment_attempts attempt
    WHERE attempt.public_id = $1 AND attempt.lease_owner = $2
      AND attempt.operation = 'world_sale' AND attempt.method = 'x402'
      AND attempt.status = 'payment_pending'
      AND attempt.recovery_deadline_at IS NOT NULL
      AND attempt.recovery_deadline_at > clock_timestamp()
      AND attempt.tx_hash IS NOT NULL
      AND attempt.finalized_block_number IS NOT NULL
      AND attempt.finalized_block_hash IS NOT NULL
      AND attempt.finalized_block_time IS NOT NULL
      AND attempt.finalized_at IS NOT NULL
    FOR UPDATE
  ), eligible_offer AS MATERIALIZED (
    SELECT offer.*, attempt.public_id AS attempt_id, attempt.tx_hash,
      attempt.actor_id, attempt.finalized_block_time
    FROM payment_attempt attempt
    JOIN transfer_offers offer ON offer.id = attempt.offer_id
    WHERE offer.channel = 'world' AND offer.asset_type = 'thing' AND offer.status = 'open'
      AND offer.buyer_id = attempt.actor_id AND offer.reserved_by = attempt.actor_id
      AND offer.seller_id = attempt.counterparty_id AND offer.asset_id = attempt.asset_id
      AND lower(offer.buyer_wallet) = attempt.payer_wallet
      AND lower(offer.seller_wallet) = attempt.payee_wallet
      AND attempt.amount_units = (offer.price_usdc * 1000000)::bigint
      AND attempt.target_key = 'world-sale:' || offer.id::text
      AND attempt.request_json = jsonb_build_object(
        'offer_id', offer.id,
        'market_checkout_id', offer.market_checkout_id,
        'market_listing_id', offer.market_listing_id,
        'market_draft_id', offer.market_draft_id,
        'market_buyer', offer.market_buyer,
        'buyer_wallet', lower(offer.buyer_wallet),
        'seller_wallet', lower(offer.seller_wallet),
        'price_usdc', offer.price_usdc,
        'asset_id', offer.asset_id
      )
      AND attempt.finalized_block_time >= date_trunc('second', offer.reserved_at)
        + CASE WHEN offer.reserved_at > date_trunc('second', offer.reserved_at)
          THEN interval '1 second' ELSE interval '0 seconds' END
      AND attempt.finalized_block_time < date_trunc('second', offer.reserved_until)
      AND offer.x402_evidence_state = 'pending'
      AND offer.pending_payment_attempt_id = attempt.public_id
      AND offer.pending_x402_tx_hash = attempt.tx_hash
      AND lower(offer.pending_x402_payer) = attempt.payer_wallet
  ), changed_thing AS (
    UPDATE things SET owner_id = offer.buyer_id, active_offer_id = NULL
    FROM eligible_offer offer
    WHERE things.id = offer.asset_id AND things.owner_id = offer.seller_id
      AND things.withdrawn_at IS NULL AND things.active_offer_id = offer.id
    RETURNING things.id, things.maker_id, things.owner_id, offer.id AS offer_id,
      offer.seller_id, offer.buyer_id, offer.price_usdc, offer.tx_hash
  ), claimed_offer AS (
    UPDATE transfer_offers offer SET status = 'claimed', claimed_at = clock_timestamp()
    FROM changed_thing thing
    WHERE offer.id = thing.offer_id AND offer.status = 'open'
    RETURNING offer.*, thing.maker_id, thing.owner_id, thing.tx_hash
  ), used_payment AS (
    INSERT INTO payment_uses (
      tx_hash, payment_attempt_id, actor_id, purpose,
      payer_wallet, payee_wallet, amount_usdc
    )
    SELECT offer.tx_hash, $1, offer.buyer_id, 'sale', lower(offer.buyer_wallet),
      lower(offer.seller_wallet), offer.price_usdc
    FROM claimed_offer offer
    RETURNING tx_hash
  ), new_payment AS (
    INSERT INTO sale_payments (
      offer_id, buyer_id, payer_wallet, payee_wallet, amount_usdc,
      tx_hash, verified_via, block_time
    )
    SELECT offer.id, offer.buyer_id, lower(offer.buyer_wallet), lower(offer.seller_wallet),
      offer.price_usdc, payment.tx_hash, 'x402', attempt.finalized_block_time
    FROM claimed_offer offer
    JOIN used_payment payment ON true
    JOIN payment_attempt attempt ON true
    RETURNING offer_id
  ), new_transfer AS (
    INSERT INTO transfers (
      asset_type, asset_id, from_id, to_id, offer_id, price_usdc, tx_hash
    )
    SELECT 'thing', offer.asset_id, offer.seller_id, offer.buyer_id,
      offer.id, offer.price_usdc, offer.tx_hash
    FROM claimed_offer offer
    JOIN new_payment payment ON payment.offer_id = offer.id
    RETURNING id
  ), new_event AS (
    INSERT INTO events (kind, actor, detail)
    SELECT 'world_sale', buyer.handle, jsonb_build_object(
      'transfer_id', transfer.id, 'offer_id', offer.id, 'thing_id', offer.asset_id,
      'from', seller.handle, 'to', buyer.handle, 'price_usdc', offer.price_usdc,
      'tx_hash', offer.tx_hash, 'market_listing_id', offer.market_listing_id,
      'market_checkout_id', offer.market_checkout_id
    )
    FROM new_transfer transfer
    JOIN claimed_offer offer ON true
    JOIN residents seller ON seller.id = offer.seller_id
    JOIN residents buyer ON buyer.id = offer.buyer_id
  ), response_payload AS (
    SELECT jsonb_build_object('offer', jsonb_build_object(
      'id', offer.id, 'channel', 'world', 'phase', 'claimed',
      'asset_type', 'thing', 'asset_id', offer.asset_id,
      'asset_name', thing.name, 'maker_id', offer.maker_id,
      'made_by', maker.handle, 'current_owner_id', offer.owner_id,
      'current_owner', buyer.handle, 'locked', false,
      'seller', seller.handle, 'buyer', buyer.handle,
      'price_usdc', offer.price_usdc, 'seller_wallet', lower(offer.seller_wallet),
      'market_origin', offer.market_origin, 'market_draft_id', offer.market_draft_id,
      'market_listing_id', offer.market_listing_id,
      'market_checkout_id', offer.market_checkout_id, 'market_buyer', offer.market_buyer,
      'pending_x402_tx_hash', offer.pending_x402_tx_hash,
      'pending_x402_at', offer.pending_x402_at,
      'x402_invalid_reason', NULL, 'x402_invalid_at', NULL,
      'reserved_at', offer.reserved_at, 'reserved_until', offer.reserved_until,
      'created_at', offer.created_at, 'claimed_at', offer.claimed_at,
      'canceled_at', NULL, 'tx_hash', offer.tx_hash,
      'buyer_wallet', lower(offer.buyer_wallet), 'verified_via', 'x402',
      'block_time', attempt.finalized_block_time,
      'from', lower(offer.buyer_wallet), 'to', lower(offer.seller_wallet)
    )) AS body
    FROM claimed_offer offer
    JOIN things thing ON thing.id = offer.asset_id
    JOIN residents maker ON maker.id = offer.maker_id
    JOIN residents seller ON seller.id = offer.seller_id
    JOIN residents buyer ON buyer.id = offer.buyer_id
    JOIN payment_attempt attempt ON true
  ), completed_attempt AS (
    SELECT complete_payment_attempt(
      $1, $2, jsonb_build_object('kind', 'world_offer', 'id', offer.id),
      200::smallint, response.body, convert_to(response.body::text, 'UTF8')
    ) AS completed
    FROM claimed_offer offer
    JOIN used_payment payment ON true
    JOIN response_payload response ON true
  )
  SELECT 'completed'::text AS state, (completed).public_id AS attempt_id,
    (completed).actor_id, (completed).operation, (completed).method,
    (completed).response_status,
    CASE WHEN (completed).response_json ? '${RESPONSE_WRAPPER}'
      THEN (completed).response_json #> '{${RESPONSE_WRAPPER},body}'
      ELSE (completed).response_json END AS response,
    convert_from((completed).response_body_bytes, 'UTF8') AS response_body,
    (completed).response_json #>> '{${RESPONSE_WRAPPER},header}' AS payment_response_header
  FROM completed_attempt
`
