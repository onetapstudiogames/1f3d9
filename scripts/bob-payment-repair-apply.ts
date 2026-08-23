import { isDeepStrictEqual } from 'node:util'
import { issueCityFeeCredit } from '../src/city-credit.ts'
import {
  BOB_COFFEE_REPAIR_REASON,
  BOB_REPAIR_CREDIT_REASON,
  BOB_REPAIR_CREDIT_SOURCE_KEY,
  BOB_REPAIR_EXPIRY_REASON,
  BOB_REPAIR_EXPECTATIONS,
  BOB_RESIDENT_ID,
  BOB_THEBLUEAI_REPAIR_REASON,
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

const EXACT_EXPIRED_GUARD_SQL = `
    attempt.public_id = $1::text
    AND attempt.actor_id = $2::integer
    AND attempt.operation = 'frontier'
    AND attempt.tx_hash = lower($3::text)
    AND attempt.target_key = $4::text
    AND attempt.request_hash = $5::text
    AND attempt.request_json = $6::jsonb
    AND date_trunc('milliseconds', attempt.updated_at) = $7::timestamptz
    AND date_trunc('milliseconds', attempt.recovery_started_at) = $8::timestamptz
    AND date_trunc('milliseconds', attempt.recovery_deadline_at) = $9::timestamptz
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
    AND attempt.status = 'expired'
    AND attempt.lease_owner IS NULL
    AND attempt.lease_expires_at IS NULL
    AND attempt.finalized_block_number IS NULL
    AND attempt.finalized_block_hash IS NULL
    AND attempt.finalized_block_time IS NULL
    AND attempt.finalized_at IS NULL
    AND attempt.invalid_reason = 'automatic payment recovery deadline passed'
    AND attempt.completed_at IS NULL
  `

async function completeTheBlueAI(
  database: BobRepairQueryClient,
  action: CompleteTheBlueAIAction,
): Promise<void> {
  assertGuard(action.guard, BOB_REPAIR_EXPECTATIONS.theBlueAI)
  if (
    action.source_state !== 'expired'
    || action.attempt_id !== action.guard.attempt_id
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
    WHERE ${EXACT_EXPIRED_GUARD_SQL}
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

  const reviewedRows = (await database.query(`
    /* bob-payment-repair-apply:review-theblueai */
    WITH new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'payment_repair', 'host', jsonb_build_object(
        'repair_key', $20::text,
        'attempt_id', $1::text,
        'transaction', lower($3::text),
        'resident_id', $2::integer,
        'source_status', 'expired',
        'payment_status', 'founder_review',
        'place_id', $15::integer,
        'parent_id', $16::integer,
        'place_name', 'TheBlueAI',
        'outcome', $21::text
      )
      FROM payment_attempts attempt
      WHERE ${EXACT_EXPIRED_GUARD_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM events existing
          WHERE existing.kind = 'payment_repair'
            AND existing.detail->>'repair_key' = $20::text
        )
      RETURNING id
    )
    UPDATE payment_attempts attempt
    SET status = 'founder_review',
      finalized_block_number = $17::bigint,
      finalized_block_hash = lower($18::text),
      finalized_block_time = $19::timestamptz,
      finalized_at = clock_timestamp(),
      invalid_reason = $22::text,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    FROM new_event
    WHERE ${EXACT_EXPIRED_GUARD_SQL}
    RETURNING attempt.public_id
  `, [
    ...guardValues(action.guard),
    placeId,
    action.world_root_id,
    action.guard.canonical_block_number,
    action.guard.canonical_block_hash,
    action.guard.canonical_block_time,
    `bob-payment-repair:${action.attempt_id}`,
    BOB_THEBLUEAI_REPAIR_REASON,
    BOB_REPAIR_EXPIRY_REASON,
  ])).rows
  const reviewed = requireOneRow(reviewedRows, 'TheBlueAI founder review')
  if (reviewed.public_id !== action.attempt_id) abort('TheBlueAI reviewed attempt changed')
}

async function closeCoffeeProbe(
  database: BobRepairQueryClient,
  action: CloseCoffeeProbeAction,
): Promise<void> {
  assertGuard(action.guard, BOB_REPAIR_EXPECTATIONS.coffee)
  if (
    action.source_state !== 'expired'
    || action.attempt_id !== action.guard.attempt_id
    || action.transaction !== action.guard.transaction
    || action.resident_id !== BOB_RESIDENT_ID
    || action.terminal_state !== 'founder_review'
    || action.reason !== BOB_COFFEE_REPAIR_REASON
  ) abort('coffee-shop approved closure action changed')

  const rows = (await database.query(`
    /* bob-payment-repair-apply:close-coffee */
    WITH new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'payment_repair', 'host', jsonb_build_object(
        'repair_key', $18::text,
        'attempt_id', $1::text,
        'transaction', lower($3::text),
        'resident_id', $2::integer,
        'source_status', 'expired',
        'payment_status', 'founder_review',
        'outcome', $19::text
      )
      FROM payment_attempts attempt
      WHERE ${EXACT_EXPIRED_GUARD_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM events existing
          WHERE existing.kind = 'payment_repair'
            AND existing.detail->>'repair_key' = $18::text
        )
      RETURNING id
    )
    UPDATE payment_attempts attempt
    SET status = 'founder_review',
      finalized_block_number = $15::bigint,
      finalized_block_hash = lower($16::text),
      finalized_block_time = $17::timestamptz,
      finalized_at = clock_timestamp(),
      invalid_reason = $20::text,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    FROM new_event
    WHERE ${EXACT_EXPIRED_GUARD_SQL}
    RETURNING attempt.public_id
  `, [
    ...guardValues(action.guard),
    action.guard.canonical_block_number,
    action.guard.canonical_block_hash,
    action.guard.canonical_block_time,
    `bob-payment-repair:${action.attempt_id}`,
    action.reason,
    BOB_REPAIR_EXPIRY_REASON,
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
