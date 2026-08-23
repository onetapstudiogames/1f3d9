import { isDeepStrictEqual } from 'node:util'
import { NETWORK, USDC } from './chain.ts'
import { CLAIM_FEE_USDC, TREASURY } from './pay.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'

const PUBLIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]+$/u
const LEASE_OWNER_RE = /^[\u0021-\u007E]+$/u
const TREASURY_OPERATIONS = Object.freeze([
  'frontier',
  'kind_invention',
  'kind_revision',
] as const)
const TREASURY_METHODS = Object.freeze(['x402', 'credit'] as const)
const FEE_UNITS = BigInt(Math.round(CLAIM_FEE_USDC * 1_000_000))

export type TreasuryPaymentOperation = typeof TREASURY_OPERATIONS[number]
export type TreasuryPaymentMethod = typeof TREASURY_METHODS[number]

export interface TreasuryPaymentOperationDatabase {
  query(
    text: string,
    params?: readonly unknown[] | unknown[],
  ): Promise<readonly Record<string, unknown>[]>
}

export type TreasuryPaymentOperationResult =
  | Readonly<{
      state: 'completed'
      attemptId: string
      actorId: number
      operation: TreasuryPaymentOperation
      method: TreasuryPaymentMethod
      status: 200 | 201
      response: Record<string, unknown>
      responseBody: string
      paymentResponseHeader: string | null
    }>
  | Readonly<{
      state: 'deadline_passed'
      attemptId: string
    }>
  | Readonly<{
      state: 'target_changed'
      attemptId: string
      reason: string
    }>

export class TreasuryPaymentOperationConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TreasuryPaymentOperationConflictError'
  }
}

const COMPLETE_TREASURY_PAYMENT_SQL = `
  /* payment-treasury-operations:complete */
  WITH owned_attempt AS MATERIALIZED (
    SELECT attempt.*, resident.handle AS actor_handle
    FROM payment_attempts attempt
    JOIN residents resident ON resident.id = attempt.actor_id
    WHERE attempt.public_id = $1::text
      AND attempt.lease_owner = $2::text
      AND attempt.status = 'payment_pending'
      AND attempt.operation IN ('frontier', 'kind_invention', 'kind_revision')
    FOR UPDATE OF attempt
  ), eligible_attempt AS MATERIALIZED (
    SELECT attempt.*
    FROM owned_attempt attempt
    WHERE attempt.recovery_deadline_at IS NOT NULL AND attempt.recovery_deadline_at > clock_timestamp()
      AND attempt.counterparty_id IS NULL
      AND attempt.offer_id IS NULL
      AND attempt.request_hash ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(attempt.request_json) = 'object'
      AND attempt.amount_units = $6::bigint
      AND (
        (
          attempt.method = 'x402'
          AND attempt.network = $3::text
          AND attempt.token = lower($4::text)
          AND attempt.payer_wallet IS NOT NULL
          AND attempt.payee_wallet = lower($5::text)
          AND attempt.tx_hash IS NOT NULL
          AND attempt.finalized_block_number IS NOT NULL
          AND attempt.finalized_block_hash IS NOT NULL
          AND attempt.finalized_block_time IS NOT NULL
          AND attempt.finalized_at IS NOT NULL
          AND char_length(
            attempt.response_json #>> '{__1f3d9_x402_response_v1,header}'
          ) BETWEEN 1 AND 87384
          AND (
            attempt.response_json #>> '{__1f3d9_x402_response_v1,header}'
          ) ~ '^[A-Za-z0-9+/]+={0,2}$'
          AND NOT EXISTS (
            SELECT 1 FROM payment_uses used WHERE used.tx_hash = attempt.tx_hash
          )
        )
        OR (
          attempt.method = 'credit'
          AND attempt.network IS NULL
          AND attempt.token IS NULL
          AND attempt.payer_wallet IS NULL
          AND attempt.payee_wallet IS NULL
          AND attempt.tx_hash IS NULL
          AND attempt.finalized_block_number IS NULL
          AND attempt.finalized_block_hash IS NULL
          AND attempt.finalized_block_time IS NULL
          AND attempt.finalized_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM city_credit_entries spend
            WHERE spend.payment_attempt_id = attempt.public_id
              AND spend.entry_kind = 'spend'
          )
        )
      )
  ), frontier_shaped AS MATERIALIZED (
    SELECT attempt.*
    FROM eligible_attempt attempt
    WHERE attempt.operation = 'frontier'
      AND attempt.asset_type IS NULL AND attempt.asset_id IS NULL
      AND attempt.target_key IS NOT NULL
      AND attempt.request_json ?& ARRAY[
        'parent_id', 'name', 'description', 'open_to_building', 'open_to_things', 'open_to_notes'
      ]
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_object_keys(attempt.request_json) key
        WHERE key <> ALL(ARRAY[
          'parent_id', 'name', 'description', 'open_to_building', 'open_to_things', 'open_to_notes'
        ]::text[])
      )
      AND CASE jsonb_typeof(attempt.request_json->'parent_id')
        WHEN 'null' THEN true
        WHEN 'number' THEN
          (attempt.request_json->>'parent_id') ~ '^[1-9][0-9]*$'
          AND (attempt.request_json->>'parent_id')::numeric <= 2147483647
        ELSE false
      END
      AND jsonb_typeof(attempt.request_json->'name') = 'string'
      AND char_length(attempt.request_json->>'name') BETWEEN 1 AND 120
      AND btrim(attempt.request_json->>'name') = attempt.request_json->>'name'
      AND (attempt.request_json->>'name') !~ '[\r\n]'
      AND jsonb_typeof(attempt.request_json->'description') = 'string'
      AND char_length(attempt.request_json->>'description') <= 4000
      AND octet_length(attempt.request_json->>'description') <= 65536
      AND jsonb_typeof(attempt.request_json->'open_to_building') = 'boolean'
      AND jsonb_typeof(attempt.request_json->'open_to_things') = 'boolean'
      AND jsonb_typeof(attempt.request_json->'open_to_notes') = 'boolean'
  ), frontier_request AS MATERIALIZED (
    SELECT attempt.*,
      CASE WHEN jsonb_typeof(attempt.request_json->'parent_id') = 'null'
        THEN NULL::integer
        ELSE (attempt.request_json->>'parent_id')::integer
      END AS requested_parent_id,
      attempt.request_json->>'name' AS requested_name,
      attempt.request_json->>'description' AS requested_description,
      (attempt.request_json->>'open_to_building')::boolean AS requested_open_to_building,
      (attempt.request_json->>'open_to_things')::boolean AS requested_open_to_things,
      (attempt.request_json->>'open_to_notes')::boolean AS requested_open_to_notes
    FROM frontier_shaped attempt
    WHERE attempt.target_key = 'frontier:' ||
      CASE WHEN jsonb_typeof(attempt.request_json->'parent_id') = 'null'
        THEN 'root' ELSE attempt.request_json->>'parent_id' END ||
      ':' || attempt.request_json->>'name'
  ), frontier_parent AS MATERIALIZED (
    SELECT request.public_id AS attempt_id, root.id AS parent_id
    FROM frontier_request request
    JOIN places root ON root.parent_id IS NULL
      AND root.owner_id IS NULL
      AND root.place_kind = 'world'
      AND root.name = $7::text
      AND (request.requested_parent_id IS NULL OR root.id = request.requested_parent_id)
    ORDER BY root.id
    LIMIT 1
    FOR SHARE OF root
  ), new_frontier_place AS (
    INSERT INTO places (
      parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT parent.parent_id, 'continent', request.requested_name,
      request.requested_description, request.actor_id,
      request.requested_open_to_building, request.requested_open_to_things,
      request.requested_open_to_notes
    FROM frontier_request request
    JOIN frontier_parent parent ON parent.attempt_id = request.public_id
    ON CONFLICT DO NOTHING
    RETURNING *
  ), new_frontier_presence AS (
    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    SELECT request.actor_id, place.id, place.id
    FROM new_frontier_place place
    JOIN frontier_request request ON true
    ON CONFLICT (resident_id) DO NOTHING
    RETURNING resident_id
  ), frontier_result AS MATERIALIZED (
    SELECT request.public_id AS attempt_id, request.actor_id, request.actor_handle,
      request.operation, request.method, request.tx_hash, request.payer_wallet,
      request.payee_wallet, request.amount_units,
      'place_created'::text AS event_kind,
      jsonb_build_object(
        'place_id', place.id, 'parent_id', place.parent_id,
        'name', place.name, 'frontier', true
      ) || CASE WHEN request.method = 'x402'
        THEN jsonb_build_object('fee_tx_hash', request.tx_hash)
        ELSE '{}'::jsonb END AS event_detail,
      jsonb_build_object('kind', 'place', 'id', place.id) AS result_json,
      201::smallint AS response_status,
      jsonb_build_object(
        'place', (to_jsonb(place) - 'front_matter_thing_ids')
          || jsonb_build_object('owner', request.actor_handle)
      ) || CASE WHEN request.method = 'x402'
        THEN jsonb_build_object('fee_tx', request.tx_hash)
        ELSE jsonb_build_object('city_fee_credit', jsonb_build_object(
          'spent_usdc', '1.000000',
          'balance_usdc', (
            SELECT (balance_units / 1000000)::text || '.' ||
              lpad((balance_units % 1000000)::text, 6, '0')
            FROM city_credit_accounts WHERE resident_id = request.actor_id
          )
        )) END AS response_json
    FROM new_frontier_place place
    JOIN frontier_request request ON true
  ), kind_invention_shaped AS MATERIALIZED (
    SELECT attempt.*
    FROM eligible_attempt attempt
    WHERE attempt.operation = 'kind_invention'
      AND attempt.asset_type IS NULL AND attempt.asset_id IS NULL
      AND attempt.target_key IS NOT NULL
      AND attempt.request_json ?& ARRAY['name', 'description', 'traits', 'recipe']
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_object_keys(attempt.request_json) key
        WHERE key <> ALL(ARRAY['name', 'description', 'traits', 'recipe']::text[])
      )
      AND jsonb_typeof(attempt.request_json->'name') = 'string'
      AND (attempt.request_json->>'name') ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
      AND jsonb_typeof(attempt.request_json->'description') = 'string'
      AND char_length(attempt.request_json->>'description') <= 4000
      AND octet_length(attempt.request_json->>'description') <= 65536
      AND CASE WHEN jsonb_typeof(attempt.request_json->'traits') = 'array' THEN
        jsonb_array_length(attempt.request_json->'traits') <= 32
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(attempt.request_json->'traits') trait(value)
          WHERE jsonb_typeof(trait.value) <> 'string'
            OR (trait.value #>> '{}') !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
        )
        AND jsonb_array_length(attempt.request_json->'traits') = (
          SELECT count(DISTINCT trait.value #>> '{}')
          FROM jsonb_array_elements(attempt.request_json->'traits') trait(value)
        )
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(attempt.request_json->'traits') trait(value)
          LEFT JOIN traits known ON known.name = trait.value #>> '{}'
          WHERE known.id IS NULL
        )
      ELSE false END
      AND CASE WHEN jsonb_typeof(attempt.request_json->'recipe') = 'array' THEN
        jsonb_array_length(attempt.request_json->'recipe') <= 64
        AND octet_length((attempt.request_json->'recipe')::text) <= 65536
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(attempt.request_json->'recipe') ingredient(value)
          WHERE NOT CASE WHEN jsonb_typeof(ingredient.value) = 'object' THEN
            ingredient.value ?& ARRAY['kind', 'quantity']
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_object_keys(ingredient.value) key
              WHERE key <> ALL(ARRAY['kind', 'quantity']::text[])
            )
            AND jsonb_typeof(ingredient.value->'kind') = 'string'
            AND (ingredient.value->>'kind') ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
            AND jsonb_typeof(ingredient.value->'quantity') = 'number'
            AND (ingredient.value->>'quantity') ~ '^[1-9][0-9]*$'
            AND (ingredient.value->>'quantity')::numeric <= 1024
          ELSE false END
        )
        AND jsonb_array_length(attempt.request_json->'recipe') = (
          SELECT count(DISTINCT ingredient.value->>'kind')
          FROM jsonb_array_elements(attempt.request_json->'recipe') ingredient(value)
        )
        AND (
          SELECT coalesce(sum(CASE
            WHEN jsonb_typeof(ingredient.value->'quantity') = 'number'
              AND (ingredient.value->>'quantity') ~ '^[1-9][0-9]*$'
            THEN (ingredient.value->>'quantity')::numeric ELSE 1025 END), 0)
          FROM jsonb_array_elements(attempt.request_json->'recipe') ingredient(value)
        ) <= 1024
      ELSE false END
      AND attempt.target_key = 'kind-invention:' || attempt.request_json->>'name'
  ), new_kind AS (
    INSERT INTO kinds (name, owner_id, current_revision)
    SELECT request.request_json->>'name', request.actor_id, 1
    FROM kind_invention_shaped request
    ON CONFLICT DO NOTHING
    RETURNING *
  ), new_kind_revision AS (
    INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
    SELECT kind.id, 1, request.request_json->>'description',
      ARRAY(
        SELECT trait.value #>> '{}'
        FROM jsonb_array_elements(request.request_json->'traits')
          WITH ORDINALITY trait(value, position)
        ORDER BY trait.position
      )::text[],
      request.request_json->'recipe'
    FROM new_kind kind
    JOIN kind_invention_shaped request ON true
    RETURNING kind_id, revision, description, traits, recipe
  ), kind_invention_result AS MATERIALIZED (
    SELECT request.public_id AS attempt_id, request.actor_id, request.actor_handle,
      request.operation, request.method, request.tx_hash, request.payer_wallet,
      request.payee_wallet, request.amount_units,
      'kind_invented'::text AS event_kind,
      jsonb_build_object(
        'kind_id', kind.id, 'name', kind.name, 'revision', revision.revision
      ) || CASE WHEN request.method = 'x402'
        THEN jsonb_build_object('fee_tx_hash', request.tx_hash)
        ELSE '{}'::jsonb END AS event_detail,
      jsonb_build_object(
        'kind', 'kind_revision', 'id', kind.id, 'revision', revision.revision
      ) AS result_json,
      201::smallint AS response_status,
      jsonb_build_object('kind', jsonb_build_object(
        'id', kind.id, 'name', kind.name, 'owner_id', kind.owner_id,
        'owner', request.actor_handle, 'revision', revision.revision,
        'description', revision.description, 'traits', revision.traits,
        'recipe', revision.recipe, 'created_at', kind.created_at
      )) || CASE WHEN request.method = 'x402'
        THEN jsonb_build_object('fee_tx', request.tx_hash)
        ELSE jsonb_build_object('city_fee_credit', jsonb_build_object(
          'spent_usdc', '1.000000',
          'balance_usdc', (
            SELECT (balance_units / 1000000)::text || '.' ||
              lpad((balance_units % 1000000)::text, 6, '0')
            FROM city_credit_accounts WHERE resident_id = request.actor_id
          )
        )) END AS response_json
    FROM new_kind kind
    JOIN new_kind_revision revision ON revision.kind_id = kind.id
    JOIN kind_invention_shaped request ON true
  ), kind_revision_shaped AS MATERIALIZED (
    SELECT attempt.*
    FROM eligible_attempt attempt
    WHERE attempt.operation = 'kind_revision'
      AND attempt.asset_type = 'kind' AND attempt.asset_id IS NOT NULL
      AND attempt.target_key IS NOT NULL
      AND attempt.request_json ?& ARRAY['kind_id', 'description', 'traits', 'recipe']
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_object_keys(attempt.request_json) key
        WHERE key <> ALL(ARRAY['kind_id', 'description', 'traits', 'recipe']::text[])
      )
      AND jsonb_typeof(attempt.request_json->'kind_id') = 'number'
      AND (attempt.request_json->>'kind_id') ~ '^[1-9][0-9]*$'
      AND (attempt.request_json->>'kind_id')::numeric <= 2147483647
      AND attempt.asset_id = (attempt.request_json->>'kind_id')::integer
      AND jsonb_typeof(attempt.request_json->'description') = 'string'
      AND char_length(attempt.request_json->>'description') <= 4000
      AND octet_length(attempt.request_json->>'description') <= 65536
      AND CASE WHEN jsonb_typeof(attempt.request_json->'traits') = 'array' THEN
        jsonb_array_length(attempt.request_json->'traits') <= 32
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(attempt.request_json->'traits') trait(value)
          WHERE jsonb_typeof(trait.value) <> 'string'
            OR (trait.value #>> '{}') !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
        )
        AND jsonb_array_length(attempt.request_json->'traits') = (
          SELECT count(DISTINCT trait.value #>> '{}')
          FROM jsonb_array_elements(attempt.request_json->'traits') trait(value)
        )
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(attempt.request_json->'traits') trait(value)
          LEFT JOIN traits known ON known.name = trait.value #>> '{}'
          WHERE known.id IS NULL
        )
      ELSE false END
      AND CASE WHEN jsonb_typeof(attempt.request_json->'recipe') = 'array' THEN
        jsonb_array_length(attempt.request_json->'recipe') <= 64
        AND octet_length((attempt.request_json->'recipe')::text) <= 65536
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(attempt.request_json->'recipe') ingredient(value)
          WHERE NOT CASE WHEN jsonb_typeof(ingredient.value) = 'object' THEN
            ingredient.value ?& ARRAY['kind', 'quantity']
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_object_keys(ingredient.value) key
              WHERE key <> ALL(ARRAY['kind', 'quantity']::text[])
            )
            AND jsonb_typeof(ingredient.value->'kind') = 'string'
            AND (ingredient.value->>'kind') ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
            AND jsonb_typeof(ingredient.value->'quantity') = 'number'
            AND (ingredient.value->>'quantity') ~ '^[1-9][0-9]*$'
            AND (ingredient.value->>'quantity')::numeric <= 1024
          ELSE false END
        )
        AND jsonb_array_length(attempt.request_json->'recipe') = (
          SELECT count(DISTINCT ingredient.value->>'kind')
          FROM jsonb_array_elements(attempt.request_json->'recipe') ingredient(value)
        )
        AND (
          SELECT coalesce(sum(CASE
            WHEN jsonb_typeof(ingredient.value->'quantity') = 'number'
              AND (ingredient.value->>'quantity') ~ '^[1-9][0-9]*$'
            THEN (ingredient.value->>'quantity')::numeric ELSE 1025 END), 0)
          FROM jsonb_array_elements(attempt.request_json->'recipe') ingredient(value)
        ) <= 1024
      ELSE false END
  ), locked_kind AS MATERIALIZED (
    SELECT kind.id, kind.name, kind.owner_id, kind.current_revision, kind.created_at,
      request.public_id AS attempt_id
    FROM kind_revision_shaped request
    JOIN kinds kind ON kind.id = request.asset_id AND kind.owner_id = request.actor_id
    LEFT JOIN transfer_offers offer ON offer.asset_type = 'kind'
      AND offer.asset_id = kind.id AND offer.status = 'open'
    WHERE kind.active_offer_id IS NULL AND offer.id IS NULL
      AND request.target_key = 'kind-revision:' || kind.id::text || ':' ||
        (kind.current_revision + 1)::text
    FOR UPDATE OF kind
  ), revised_kind_revision AS (
    INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
    SELECT kind.id, kind.current_revision + 1,
      request.request_json->>'description',
      ARRAY(
        SELECT trait.value #>> '{}'
        FROM jsonb_array_elements(request.request_json->'traits')
          WITH ORDINALITY trait(value, position)
        ORDER BY trait.position
      )::text[],
      request.request_json->'recipe'
    FROM locked_kind kind
    JOIN kind_revision_shaped request ON request.public_id = kind.attempt_id
    ON CONFLICT DO NOTHING
    RETURNING kind_id, revision, description, traits, recipe
  ), changed_kind AS (
    UPDATE kinds kind SET current_revision = revision.revision
    FROM revised_kind_revision revision
    WHERE kind.id = revision.kind_id
    RETURNING kind.*
  ), kind_revision_result AS MATERIALIZED (
    SELECT request.public_id AS attempt_id, request.actor_id, request.actor_handle,
      request.operation, request.method, request.tx_hash, request.payer_wallet,
      request.payee_wallet, request.amount_units,
      'kind_revised'::text AS event_kind,
      jsonb_build_object(
        'kind_id', kind.id, 'name', kind.name, 'revision', revision.revision
      ) || CASE WHEN request.method = 'x402'
        THEN jsonb_build_object('fee_tx_hash', request.tx_hash)
        ELSE '{}'::jsonb END AS event_detail,
      jsonb_build_object(
        'kind', 'kind_revision', 'id', kind.id, 'revision', revision.revision
      ) AS result_json,
      200::smallint AS response_status,
      jsonb_build_object('kind', jsonb_build_object(
        'id', kind.id, 'name', kind.name, 'owner_id', kind.owner_id,
        'owner', request.actor_handle, 'revision', revision.revision,
        'description', revision.description, 'traits', revision.traits,
        'recipe', revision.recipe, 'created_at', kind.created_at
      )) || CASE WHEN request.method = 'x402'
        THEN jsonb_build_object('fee_tx', request.tx_hash)
        ELSE jsonb_build_object('city_fee_credit', jsonb_build_object(
          'spent_usdc', '1.000000',
          'balance_usdc', (
            SELECT (balance_units / 1000000)::text || '.' ||
              lpad((balance_units % 1000000)::text, 6, '0')
            FROM city_credit_accounts WHERE resident_id = request.actor_id
          )
        )) END AS response_json
    FROM changed_kind kind
    JOIN revised_kind_revision revision ON revision.kind_id = kind.id
    JOIN kind_revision_shaped request ON request.asset_id = kind.id
  ), operation_result AS MATERIALIZED (
    SELECT * FROM frontier_result
    UNION ALL SELECT * FROM kind_invention_result
    UNION ALL SELECT * FROM kind_revision_result
  ), payment_use AS (
    INSERT INTO payment_uses (
      tx_hash, payment_attempt_id, purpose, actor_id,
      payer_wallet, payee_wallet, amount_usdc
    )
    SELECT result.tx_hash, result.attempt_id, result.operation, result.actor_id,
      result.payer_wallet, result.payee_wallet,
      result.amount_units::numeric / 1000000::numeric
    FROM operation_result result
    WHERE result.method = 'x402'
    RETURNING tx_hash, payment_attempt_id
  ), new_fee AS (
    INSERT INTO fees (resident_id, purpose, amount_usdc, tx_hash)
    SELECT result.actor_id, result.operation,
      result.amount_units::numeric / 1000000::numeric, payment_use.tx_hash
    FROM payment_use
    JOIN operation_result result ON result.attempt_id = payment_use.payment_attempt_id
    RETURNING id
  ), new_event AS (
    INSERT INTO events (kind, actor, detail)
    SELECT result.event_kind, result.actor_handle, result.event_detail
    FROM operation_result result
    RETURNING id
  ), completed_x402_attempt AS (
    SELECT complete_payment_attempt(
      result.attempt_id, $2::text, result.result_json, result.response_status,
      result.response_json, convert_to(result.response_json::text, 'UTF8')
    ) AS attempt
    FROM operation_result result
    CROSS JOIN payment_use
    CROSS JOIN new_fee
    CROSS JOIN new_event
    WHERE result.method = 'x402'
  ), completed_credit_attempt AS (
    SELECT complete_city_credit_attempt(
      result.attempt_id, $2::text, result.result_json, result.response_status,
      result.response_json, convert_to(result.response_json::text, 'UTF8')
    ) AS attempt
    FROM operation_result result
    CROSS JOIN new_event
    WHERE result.method = 'credit'
  ), completed_attempt AS MATERIALIZED (
    SELECT attempt FROM completed_x402_attempt
    UNION ALL SELECT attempt FROM completed_credit_attempt
  ), completed_result AS (
    SELECT 1 AS priority, 'completed'::text AS state,
      result.attempt_id, result.actor_id, result.operation, result.method,
      (completed.attempt).response_status, result.response_json,
      convert_from((completed.attempt).response_body_bytes, 'UTF8') AS response_body,
      CASE WHEN result.method = 'x402' THEN
        (completed.attempt).response_json #>> '{__1f3d9_x402_response_v1,header}'
      ELSE NULL::text END AS payment_response_header,
      NULL::text AS reason
    FROM operation_result result
    CROSS JOIN completed_attempt completed
  ), deadline_result AS (
    SELECT 2 AS priority, 'deadline_passed'::text AS state,
      attempt.public_id AS attempt_id, NULL::integer AS actor_id,
      NULL::text AS operation, NULL::text AS method,
      NULL::smallint AS response_status, NULL::jsonb AS response_json,
      NULL::text AS response_body, NULL::text AS payment_response_header,
      NULL::text AS reason
    FROM owned_attempt attempt
    WHERE attempt.recovery_deadline_at IS NOT NULL
      AND attempt.recovery_deadline_at <= clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM completed_result)
  ), target_changed_result AS (
    SELECT 3 AS priority, 'target_changed'::text AS state,
      attempt.public_id AS attempt_id, NULL::integer AS actor_id,
      NULL::text AS operation, NULL::text AS method,
      NULL::smallint AS response_status, NULL::jsonb AS response_json,
      NULL::text AS response_body, NULL::text AS payment_response_header,
      'stored treasury request is invalid or its target changed'::text AS reason
    FROM owned_attempt attempt
    WHERE attempt.operation IN ('frontier', 'kind_invention', 'kind_revision')
      AND NOT EXISTS (SELECT 1 FROM operation_result)
      AND NOT EXISTS (SELECT 1 FROM completed_result)
  ), outcome AS (
    SELECT * FROM completed_result
    UNION ALL SELECT * FROM deadline_result
    UNION ALL SELECT * FROM target_changed_result
  )
  SELECT state, attempt_id, actor_id, operation, method, response_status,
    response_json, response_body, payment_response_header, reason
  FROM outcome
  ORDER BY priority
  LIMIT 1
`

function validateInput(input: { attemptId: string; leaseOwner: string }): void {
  if (
    typeof input.attemptId !== 'string'
    || input.attemptId.length < 16
    || input.attemptId.length > 128
    || !PUBLIC_ID_RE.test(input.attemptId)
  ) throw new TypeError('treasury payment attempt id is invalid')
  if (
    typeof input.leaseOwner !== 'string'
    || input.leaseOwner.length > 128
    || !LEASE_OWNER_RE.test(input.leaseOwner)
  ) throw new TypeError('treasury payment lease owner is invalid')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function completedResult(
  row: Record<string, unknown>,
  attemptId: string,
): TreasuryPaymentOperationResult {
  const actorId = Number(row.actor_id)
  const operation = String(row.operation)
  const method = String(row.method)
  const status = Number(row.response_status)
  const response = row.response_json
  const responseBody = row.response_body
  const paymentResponseHeader = row.payment_response_header
  let decodedBody: unknown
  const expectedStatus = operation === 'kind_revision' ? 200 : 201
  try {
    decodedBody = typeof responseBody === 'string' ? JSON.parse(responseBody) : null
  } catch {
    decodedBody = null
  }
  if (
    row.attempt_id !== attemptId
    || !Number.isSafeInteger(actorId) || actorId < 1
    || !TREASURY_OPERATIONS.includes(operation as TreasuryPaymentOperation)
    || !TREASURY_METHODS.includes(method as TreasuryPaymentMethod)
    || status !== expectedStatus
    || !isRecord(response)
    || typeof responseBody !== 'string'
    || !isRecord(decodedBody)
    || !isDeepStrictEqual(decodedBody, response)
    || (method === 'x402' && (
      typeof paymentResponseHeader !== 'string' || paymentResponseHeader.length === 0
    ))
    || (method === 'credit' && paymentResponseHeader != null)
  ) throw new TreasuryPaymentOperationConflictError('treasury payment completion result is invalid')

  return {
    state: 'completed',
    attemptId,
    actorId,
    operation: operation as TreasuryPaymentOperation,
    method: method as TreasuryPaymentMethod,
    status: status as 200 | 201,
    response,
    responseBody,
    paymentResponseHeader: paymentResponseHeader as string | null,
  }
}

export async function completeTreasuryPaymentOperation(
  database: TreasuryPaymentOperationDatabase,
  input: Readonly<{ attemptId: string; leaseOwner: string }>,
): Promise<TreasuryPaymentOperationResult> {
  validateInput(input)
  const rows = await database.query(COMPLETE_TREASURY_PAYMENT_SQL, [
    input.attemptId,
    input.leaseOwner,
    NETWORK,
    USDC.toLowerCase(),
    TREASURY,
    FEE_UNITS.toString(),
    WORLD_ROOT_NAME,
  ])
  const row = rows[0]
  if (!row) {
    throw new TreasuryPaymentOperationConflictError(
      'treasury payment completion no longer owns this attempt lease',
    )
  }
  if (row.state === 'deadline_passed' && row.attempt_id === input.attemptId) {
    return { state: 'deadline_passed', attemptId: input.attemptId }
  }
  if (
    row.state === 'target_changed'
    && row.attempt_id === input.attemptId
    && typeof row.reason === 'string'
    && row.reason.length > 0
  ) {
    return {
      state: 'target_changed',
      attemptId: input.attemptId,
      reason: row.reason,
    }
  }
  if (row.state === 'completed') return completedResult(row, input.attemptId)
  throw new TreasuryPaymentOperationConflictError('treasury payment completion result is invalid')
}
