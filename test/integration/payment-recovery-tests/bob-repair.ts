import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { bobPaymentRepairApplyOperations } from '../../../scripts/bob-payment-repair-apply.ts'
import {
  BOB_REPAIR_EXPECTATIONS,
  buildBobPaymentRepairPlan,
  readBobRepairSnapshot,
  type BobTransferEvidence,
} from '../../../scripts/repair-bob-payments.ts'

export async function registerBobRepairTests(
  t: TestContext,
  database: Pool,
  reset: (database: Pool) => Promise<void>,
): Promise<void> {
  await t.test('the approved Bob repair creates one exact continent, closes the probe, records repair events, and issues one credit', async () => {
    await reset(database)
    await database.query(`
      INSERT INTO residents (id, handle, model, secret_hash)
      VALUES (68, 'bob', 'integration-test', repeat('6', 64))
    `)

    for (const expected of [
      BOB_REPAIR_EXPECTATIONS.coffee,
      BOB_REPAIR_EXPECTATIONS.theBlueAI,
    ]) {
      await database.query(`
        INSERT INTO payment_attempts (
          public_id, actor_id, operation, target_key, request_hash, request_json,
          method, network, token, payer_wallet, payee_wallet, amount_units,
          x402_nonce, x402_payload_digest, start_block, start_time, end_time,
          status, tx_hash, response_json, recovery_started_at, recovery_deadline_at,
          created_at, updated_at, invalid_reason
        ) VALUES (
          $1, 68, 'frontier', $2, $3, $4::jsonb,
          'x402', 'base', $5, $6, $7, 1000000,
          $8, repeat('7', 64), 49000000,
          '2026-08-22T07:00:00Z', '2026-08-22T08:30:00Z',
          'expired', $9,
          jsonb_build_object(
            '__1f3d9_x402_response_v1', jsonb_build_object('header', 'dGVzdA==')
          ),
          $10::timestamptz, $11::timestamptz,
          '2026-08-22T07:00:00Z', $12::timestamptz,
          'automatic payment recovery deadline passed'
        )
      `, [
        expected.attemptId,
        expected.targetKey,
        expected.requestHash,
        JSON.stringify(expected.request),
        BOB_REPAIR_EXPECTATIONS.token,
        BOB_REPAIR_EXPECTATIONS.payer,
        BOB_REPAIR_EXPECTATIONS.recipient,
        `0x${randomBytes(32).toString('hex')}`,
        expected.txHash,
        expected.recoveryStartedAt,
        expected.recoveryDeadlineAt,
        expected.updatedAt,
      ])
    }

    const transferEvidence = Object.freeze(Object.fromEntries(([
      ['coffee', BOB_REPAIR_EXPECTATIONS.coffee],
      ['theBlueAI', BOB_REPAIR_EXPECTATIONS.theBlueAI],
    ] as const).map(([, expected]) => [expected.txHash, {
      state: 'matched',
      from: BOB_REPAIR_EXPECTATIONS.payer,
      to: BOB_REPAIR_EXPECTATIONS.recipient,
      amount: 1_000_000n,
      blockNumber: BigInt(expected.blockNumber),
      blockHash: expected.blockHash,
      blockTime: new Date(expected.blockTime),
      finalizedAt: new Date('2026-08-23T12:00:00Z'),
    } satisfies BobTransferEvidence])))

    const rollbackClient = await database.connect()
    try {
      await rollbackClient.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE')
      const rollbackPlan = buildBobPaymentRepairPlan(
        await readBobRepairSnapshot(rollbackClient, true),
        transferEvidence,
      )
      const firstOperation = rollbackPlan.actions.find(
        action => action.kind === 'complete_theblueai',
      )
      assert.ok(firstOperation)
      await bobPaymentRepairApplyOperations.completeTheBlueAI(rollbackClient, firstOperation)
      const inside = await rollbackClient.query<{ places: number; uses: number; fees: number; founder_review: number; repair_events: number }>(`
        SELECT
          (SELECT count(*)::integer FROM places WHERE name = 'TheBlueAI') AS places,
          (SELECT count(*)::integer FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::integer FROM fees WHERE tx_hash = $2) AS fees,
          (SELECT count(*)::integer FROM payment_attempts
            WHERE public_id = $1 AND status = 'founder_review') AS founder_review,
          (SELECT count(*)::integer FROM events WHERE kind = 'payment_repair') AS repair_events
      `, [
        BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId,
        BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash,
      ])
      assert.deepEqual(inside.rows, [{ places: 1, uses: 0, fees: 0, founder_review: 1, repair_events: 1 }])
      await rollbackClient.query('ROLLBACK')
    } finally {
      rollbackClient.release()
    }
    const afterRollback = await database.query<{
      places: number
      uses: number
      fees: number
      founder_review: number
    }>(`
      SELECT
        (SELECT count(*)::integer FROM places WHERE name = 'TheBlueAI') AS places,
        (SELECT count(*)::integer FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
        (SELECT count(*)::integer FROM fees WHERE tx_hash = $2) AS fees,
        (SELECT count(*)::integer FROM payment_attempts
          WHERE public_id = $1 AND status = 'expired'
            AND finalized_block_number IS NULL) AS founder_review
    `, [
      BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId,
      BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash,
    ])
    assert.deepEqual(afterRollback.rows, [{ places: 0, uses: 0, fees: 0, founder_review: 1 }])

    const client = await database.connect()
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE')
      const initial = buildBobPaymentRepairPlan(
        await readBobRepairSnapshot(client, true),
        transferEvidence,
      )
      assert.equal(initial.state, 'work_required')
      const complete = initial.actions.find(action => action.kind === 'complete_theblueai')
      const close = initial.actions.find(action => action.kind === 'close_coffee_probe')
      const credit = initial.actions.find(action => action.kind === 'issue_founder_credit')
      assert.ok(complete && close && credit)

      await bobPaymentRepairApplyOperations.completeTheBlueAI(client, complete)
      await bobPaymentRepairApplyOperations.closeCoffeeProbe(client, close)
      await bobPaymentRepairApplyOperations.issueFounderCredit(client, credit)

      const completed = buildBobPaymentRepairPlan(
        await readBobRepairSnapshot(client, true),
        transferEvidence,
      )
      assert.equal(completed.state, 'no_work')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    const exactCounts = await database.query<{
      blue_places: number
      coffee_places: number
      blue_uses: number
      coffee_uses: number
      blue_fees: number
      coffee_fees: number
      credits: number
      repair_events: number
      blue_status: string
      coffee_status: string
      blue_reason: string | null
      coffee_reason: string | null
    }>(`
      SELECT
        (SELECT count(*)::integer FROM places WHERE name = 'TheBlueAI') AS blue_places,
        (SELECT count(*)::integer FROM places WHERE lower(name) = 'coffee-shop') AS coffee_places,
        (SELECT count(*)::integer FROM payment_uses WHERE payment_attempt_id = $1) AS blue_uses,
        (SELECT count(*)::integer FROM payment_uses WHERE payment_attempt_id = $2) AS coffee_uses,
        (SELECT count(*)::integer FROM fees WHERE tx_hash = $3) AS blue_fees,
        (SELECT count(*)::integer FROM fees WHERE tx_hash = $4) AS coffee_fees,
        (SELECT count(*)::integer FROM city_credit_entries
          WHERE source_key = $5) AS credits,
        (SELECT count(*)::integer FROM events WHERE kind = 'payment_repair') AS repair_events,
        (SELECT status FROM payment_attempts WHERE public_id = $1) AS blue_status,
        (SELECT status FROM payment_attempts WHERE public_id = $2) AS coffee_status,
        (SELECT invalid_reason FROM payment_attempts WHERE public_id = $1) AS blue_reason,
        (SELECT invalid_reason FROM payment_attempts WHERE public_id = $2) AS coffee_reason
    `, [
      BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId,
      BOB_REPAIR_EXPECTATIONS.coffee.attemptId,
      BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash,
      BOB_REPAIR_EXPECTATIONS.coffee.txHash,
      `bob-payment-repair:${BOB_REPAIR_EXPECTATIONS.coffee.attemptId}`,
    ])
    assert.deepEqual(exactCounts.rows, [{
      blue_places: 1,
      coffee_places: 0,
      blue_uses: 0,
      coffee_uses: 0,
      blue_fees: 0,
      coffee_fees: 0,
      credits: 1,
      repair_events: 2,
      blue_status: 'founder_review',
      coffee_status: 'founder_review',
      blue_reason: 'automatic payment recovery deadline passed',
      coffee_reason: 'automatic payment recovery deadline passed',
    }])

    const retryPlan = buildBobPaymentRepairPlan(
      await readBobRepairSnapshot(database),
      transferEvidence,
    )
    assert.equal(retryPlan.state, 'no_work')
  })
}
