import { isDeepStrictEqual } from 'node:util'
import { issueCityFeeCredit } from '../src/city-credit.ts'
import {
  BOB_COFFEE_REVIEW_REASON,
  BOB_REPAIR_CREDIT_REASON,
  BOB_REPAIR_CREDIT_SOURCE_KEY,
  BOB_REPAIR_EXPECTATIONS,
  BOB_RESIDENT_ID,
  EXPECTED_PAYER,
  EXPECTED_RECIPIENT,
  EXPECTED_TOKEN,
  FOUNDER_RESIDENT_ID,
  ONE_USDC_UNITS,
  abort,
  type BobPaymentRepairApplyOperations,
  type BobRepairQueryClient,
  type CloseCoffeeProbeAction,
  type CompleteTheBlueAIAction,
  type GuardedBobPaymentFacts,
  type IssueFounderCreditAction,
} from './bob-payment-repair-model.ts'

function requireOneRow(
  rows: readonly Readonly<Record<string, unknown>>[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (rows.length !== 1) abort(`${label} changed or conflicted`)
  return rows[0]!
}

function assertGuard(
  guard: GuardedBobPaymentFacts,
  expected: typeof BOB_REPAIR_EXPECTATIONS.coffee | typeof BOB_REPAIR_EXPECTATIONS.theBlueAI,
): void {
  const observedUpdateAt = Date.parse(guard.expected_updated_at)
  const originalUpdateAt = Date.parse(expected.updatedAt)
  if (
    guard.attempt_id !== expected.attemptId
    || guard.transaction !== expected.txHash
    || guard.actor_id !== BOB_RESIDENT_ID
    || guard.operation !== 'frontier'
    || guard.target_key !== expected.targetKey
    || guard.request_hash !== expected.requestHash
    || !isDeepStrictEqual(guard.request, expected.request)
    || !Number.isFinite(observedUpdateAt)
    || new Date(observedUpdateAt).toISOString() !== guard.expected_updated_at
    || observedUpdateAt < originalUpdateAt
    || guard.recovery_started_at !== expected.recoveryStartedAt
    || guard.recovery_deadline_at !== expected.recoveryDeadlineAt
    || guard.network !== 'base'
    || guard.token !== EXPECTED_TOKEN
    || guard.payer !== EXPECTED_PAYER
    || guard.recipient !== EXPECTED_RECIPIENT
    || guard.amount_units !== ONE_USDC_UNITS.toString()
    || guard.canonical_block_number !== expected.blockNumber
    || guard.canonical_block_hash !== expected.blockHash
    || guard.canonical_block_time !== expected.blockTime
  ) abort(`${expected.attemptId} approved repair guard changed`)
}

function guardValues(guard: GuardedBobPaymentFacts): readonly unknown[] {
  return [
    guard.attempt_id,
    guard.actor_id,
    guard.transaction,
    guard.target_key,
    guard.request_hash,
    JSON.stringify(guard.request),
    guard.expected_updated_at,
    guard.recovery_started_at,
    guard.recovery_deadline_at,
    guard.network,
    guard.token,
    guard.payer,
    guard.recipient,
    guard.amount_units,
  ]
}

const EXACT_PENDING_GUARD_SQL = `
    attempt.public_id = $1::text
    AND attempt.actor_id = $2::integer
    AND attempt.operation = 'frontier'
    AND attempt.tx_hash = lower($3::text)
    AND attempt.target_key = $4::text
    AND attempt.request_hash = $5::text
    AND attempt.request_json = $6::jsonb
    AND attempt.updated_at = $7::timestamptz
    AND attempt.recovery_started_at = $8::timestamptz
    AND attempt.recovery_deadline_at = $9::timestamptz
    AND attempt.method = 'x402'
    AND attempt.network = $10::text
    AND attempt.token = lower($11::text)
    AND attempt.payer_wallet = lower($12::text)
    AND attempt.payee_wallet = lower($13::text)
    AND attempt.amount_units = $14::bigint
    AND attempt.counterparty_id IS NULL
    AND attempt.offer_id IS NULL
    AND attempt.asset_type IS NULL
    AND attempt.asset_id IS NULL
    AND attempt.status = 'payment_pending'
    AND (
      (attempt.lease_owner IS NULL AND attempt.lease_expires_at IS NULL)
      OR (
        attempt.lease_owner IS NOT NULL
        AND attempt.lease_expires_at IS NOT NULL
        AND attempt.lease_expires_at <= clock_timestamp()
      )
    )
    AND attempt.finalized_block_number IS NULL
    AND attempt.finalized_block_hash IS NULL
    AND attempt.finalized_block_time IS NULL
    AND attempt.finalized_at IS NULL
    AND attempt.invalid_reason IS NULL
    AND attempt.completed_at IS NULL
  `

async function completeTheBlueAI(
  database: BobRepairQueryClient,
  action: CompleteTheBlueAIAction,
): Promise<void> {
  assertGuard(action.guard, BOB_REPAIR_EXPECTATIONS.theBlueAI)
  if (
    action.attempt_id !== action.guard.attempt_id
    || action.transaction !== action.guard.transaction
    || action.resident_id !== BOB_RESIDENT_ID
    || action.name !== 'TheBlueAI'
    || action.place.name !== 'TheBlueAI'
    || !isDeepStrictEqual(action.place, {
      name: 'TheBlueAI',
      description: '',
      open_to_building: false,
      open_to_things: false,
      open_to_notes: false,
    })
  ) abort('TheBlueAI approved completion action changed')

  const placeRows = (await database.query(`
    /* bob-payment-repair-apply:create-place */
    INSERT INTO places (
      parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT root.id, 'continent', $15::text, $16::text, attempt.actor_id,
      $17::boolean, $18::boolean, $19::boolean
    FROM payment_attempts attempt
    JOIN places root ON root.id = $20::integer
      AND root.parent_id IS NULL
      AND root.owner_id IS NULL
      AND root.place_kind = 'world'
      AND root.name = 'the world'
    WHERE ${EXACT_PENDING_GUARD_SQL}
      AND NOT EXISTS (
        SELECT 1 FROM places occupied WHERE lower(occupied.name) = lower($15::text)
      )
    RETURNING id
  `, [
    ...guardValues(action.guard),
    action.place.name,
    action.place.description,
    action.place.open_to_building,
    action.place.open_to_things,
    action.place.open_to_notes,
    action.world_root_id,
  ])).rows
  const placeId = Number(requireOneRow(placeRows, 'TheBlueAI place creation').id)
  if (!Number.isSafeInteger(placeId) || placeId < 1) abort('TheBlueAI place id is invalid')

  await database.query(`
    /* bob-payment-repair-apply:presence */
    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    SELECT $1::integer, $2::integer, $2::integer
    WHERE EXISTS (
      SELECT 1 FROM places
      WHERE id = $2::integer AND owner_id = $1::integer AND name = 'TheBlueAI'
    )
    ON CONFLICT (resident_id) DO NOTHING
  `, [action.resident_id, placeId])

  const useRows = (await database.query(`
    /* bob-payment-repair-apply:payment-use */
    INSERT INTO payment_uses (
      tx_hash, payment_attempt_id, purpose, actor_id,
      payer_wallet, payee_wallet, amount_usdc
    )
    SELECT lower($3::text), $1::text, 'frontier', $2::integer,
      lower($12::text), lower($13::text), $14::numeric / 1000000::numeric
    FROM payment_attempts attempt
    WHERE ${EXACT_PENDING_GUARD_SQL}
    RETURNING tx_hash
  `, guardValues(action.guard))).rows
  requireOneRow(useRows, 'TheBlueAI payment use')

  const feeRows = (await database.query(`
    /* bob-payment-repair-apply:fee */
    INSERT INTO fees (resident_id, purpose, amount_usdc, tx_hash)
    SELECT $2::integer, 'frontier', $14::numeric / 1000000::numeric, lower($3::text)
    FROM payment_attempts attempt
    JOIN payment_uses payment_use
      ON payment_use.payment_attempt_id = attempt.public_id
      AND payment_use.tx_hash = attempt.tx_hash
    WHERE ${EXACT_PENDING_GUARD_SQL}
    RETURNING id
  `, guardValues(action.guard))).rows
  requireOneRow(feeRows, 'TheBlueAI fee history')

  const completedRows = (await database.query(`
    /* bob-payment-repair-apply:complete-attempt */
    WITH response AS MATERIALIZED (
      SELECT jsonb_build_object(
        'place', (to_jsonb(place) - 'front_matter_thing_ids')
          || jsonb_build_object('owner', resident.handle),
        'fee_tx', lower($3::text)
      ) AS body
      FROM places place
      JOIN residents resident ON resident.id = $2::integer AND resident.handle = 'bob'
      WHERE place.id = $15::integer
        AND place.parent_id = $16::integer
        AND place.place_kind = 'continent'
        AND place.name = 'TheBlueAI'
        AND place.owner_id = $2::integer
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'place_created', 'bob', jsonb_build_object(
        'place_id', $15::integer, 'parent_id', $16::integer,
        'name', 'TheBlueAI', 'frontier', true, 'fee_tx_hash', lower($3::text)
      )
      FROM response
      RETURNING id
    )
    UPDATE payment_attempts attempt
    SET status = 'completed',
      finalized_block_number = $17::bigint,
      finalized_block_hash = lower($18::text),
      finalized_block_time = $19::timestamptz,
      finalized_at = clock_timestamp(),
      result_json = jsonb_build_object('kind', 'place', 'id', $15::integer),
      response_status = 201,
      response_json = CASE
        WHEN attempt.response_json #>> '{__1f3d9_x402_response_v1,header}' IS NULL
          THEN response.body
        ELSE jsonb_build_object(
          '__1f3d9_x402_response_v1',
          jsonb_build_object(
            'header', attempt.response_json #>> '{__1f3d9_x402_response_v1,header}',
            'body', response.body
          )
        )
      END,
      response_body_bytes = convert_to(response.body::text, 'UTF8'),
      completed_at = clock_timestamp(),
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    FROM response, new_event
    WHERE ${EXACT_PENDING_GUARD_SQL}
      AND char_length(
        attempt.response_json #>> '{__1f3d9_x402_response_v1,header}'
      ) BETWEEN 1 AND 87384
      AND (
        attempt.response_json #>> '{__1f3d9_x402_response_v1,header}'
      ) ~ '^[A-Za-z0-9+/]+={0,2}$'
    RETURNING attempt.public_id
  `, [
    ...guardValues(action.guard),
    placeId,
    action.world_root_id,
    action.guard.canonical_block_number,
    action.guard.canonical_block_hash,
    action.guard.canonical_block_time,
  ])).rows
  const completed = requireOneRow(completedRows, 'TheBlueAI attempt completion')
  if (completed.public_id !== action.attempt_id) abort('TheBlueAI completed attempt changed')
}

async function closeCoffeeProbe(
  database: BobRepairQueryClient,
  action: CloseCoffeeProbeAction,
): Promise<void> {
  assertGuard(action.guard, BOB_REPAIR_EXPECTATIONS.coffee)
  if (
    action.attempt_id !== action.guard.attempt_id
    || action.transaction !== action.guard.transaction
    || action.resident_id !== BOB_RESIDENT_ID
    || action.terminal_state !== 'founder_review'
    || action.reason !== BOB_COFFEE_REVIEW_REASON
  ) abort('coffee-shop approved closure action changed')

  const rows = (await database.query(`
    /* bob-payment-repair-apply:close-coffee */
    UPDATE payment_attempts attempt
    SET status = 'founder_review',
      finalized_block_number = $15::bigint,
      finalized_block_hash = lower($16::text),
      finalized_block_time = $17::timestamptz,
      finalized_at = clock_timestamp(),
      invalid_reason = $18::text,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE ${EXACT_PENDING_GUARD_SQL}
    RETURNING attempt.public_id
  `, [
    ...guardValues(action.guard),
    action.guard.canonical_block_number,
    action.guard.canonical_block_hash,
    action.guard.canonical_block_time,
    action.reason,
  ])).rows
  const closed = requireOneRow(rows, 'coffee-shop founder review')
  if (closed.public_id !== action.attempt_id) abort('coffee-shop closed attempt changed')
}

async function issueFounderCredit(
  database: BobRepairQueryClient,
  action: IssueFounderCreditAction,
): Promise<void> {
  if (
    action.attempt_id !== BOB_REPAIR_EXPECTATIONS.coffee.attemptId
    || action.transaction !== BOB_REPAIR_EXPECTATIONS.coffee.txHash
    || action.founder_id !== FOUNDER_RESIDENT_ID
    || action.resident_id !== BOB_RESIDENT_ID
    || action.amount_units !== ONE_USDC_UNITS.toString()
    || action.source_key !== BOB_REPAIR_CREDIT_SOURCE_KEY
    || action.reason !== BOB_REPAIR_CREDIT_REASON
  ) abort('approved Bob founder credit action changed')

  const issued = await issueCityFeeCredit({
    query: async (text, values = []) => (await database.query(text, values)).rows,
  }, {
    founderId: action.founder_id,
    residentId: action.resident_id,
    sourceKey: action.source_key,
    reason: action.reason,
  })
  if (
    issued.resident_id !== action.resident_id
    || issued.amount_units !== action.amount_units
  ) abort('Bob founder credit result changed')
}

export const bobPaymentRepairApplyOperations: BobPaymentRepairApplyOperations = Object.freeze({
  completeTheBlueAI,
  closeCoffeeProbe,
  issueFounderCredit,
})
