import assert from 'node:assert/strict'
import type { Client } from 'pg'
import { setTimeout as delay } from 'node:timers/promises'
import { NETWORK, USDC } from '../../../src/chain.ts'
import { bindPaymentEvidence, canonicalPaymentRequest } from '../../../src/payment-attempts.ts'
import { completeTreasuryPaymentOperation } from '../../../src/payment-treasury-operations.ts'
import { TREASURY } from '../../../src/pay.ts'

export async function registerLateFinalityTests(
  client: Client,
  database: { query: (text: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]> },
  drawing: (colour: string) => { palette: string[]; indices: (number | null)[] },
): Promise<void> {
  const lateFinalityDrawing = drawing('#6f4b7d')
  const lateFinalityRequest = {
    name: 'late-finality-drawn-kind',
    description: 'a drawing-bearing x402 invention finalized after its authorization window',
    traits: [],
    recipe: [],
    drawing: lateFinalityDrawing,
    drawing_state: 'complete',
    drawing_description: 'The late-finality kind drawing.',
  }
  const lateFinalityCanonical = canonicalPaymentRequest(lateFinalityRequest)
  const lateFinalityAttemptId = 'drawing-late-finality-attempt-0001'
  const lateFinalityLeaseOwner = 'drawing-late-finality-lease-0001'
  const lateFinalityTxHash = `0x${'7'.repeat(64)}`
  const lateFinalityPayer = `0x${'5'.repeat(40)}`
  const lateFinalityResponseHeader = Buffer.from(JSON.stringify({
    success: true,
    transaction: lateFinalityTxHash,
    payer: lateFinalityPayer,
    network: NETWORK,
  })).toString('base64')
  const lateBoundary = (await client.query<{
    start_time: Date
    end_time: Date
    block_time: Date
    valid_after: string
    valid_before: string
  }>(`
    WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT at AS start_time,
      at + interval '2 seconds' AS end_time,
      at + interval '1 second' AS block_time,
      extract(epoch FROM date_trunc('second', at))::bigint - 1 AS valid_after,
      extract(epoch FROM date_trunc('second', at))::bigint + 2 AS valid_before
    FROM observed
  `)).rows[0]!
  assert.ok(lateBoundary.block_time >= lateBoundary.start_time)
  assert.ok(lateBoundary.block_time < lateBoundary.end_time)
  await client.query(`
    INSERT INTO payment_attempts (
      public_id, actor_id, operation, target_key, request_hash, request_json,
      method, network, token, payer_wallet, payee_wallet, amount_units,
      x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
      start_block, start_time, end_time, status, lease_owner, lease_expires_at
    ) VALUES (
      $1, 2, 'kind_invention', $2, $3, $4::jsonb,
      'x402', $5, $6, $7, $8, 1000000,
      $9, repeat('a', 64), $10::bigint, $11::bigint,
      50000000, $12::timestamptz, $13::timestamptz,
      'settling', $14, clock_timestamp() + interval '30 seconds'
    )
  `, [
    lateFinalityAttemptId,
    `kind-invention:${lateFinalityRequest.name}`,
    lateFinalityCanonical.hash,
    lateFinalityCanonical.json,
    NETWORK,
    USDC.toLowerCase(),
    lateFinalityPayer,
    TREASURY,
    `0x${'6'.repeat(64)}`,
    lateBoundary.valid_after,
    lateBoundary.valid_before,
    lateBoundary.start_time.toISOString(),
    lateBoundary.end_time.toISOString(),
    lateFinalityLeaseOwner,
  ])

  const pendingLateFinality = await bindPaymentEvidence(database, {
    publicId: lateFinalityAttemptId,
    leaseOwner: lateFinalityLeaseOwner,
    txHash: lateFinalityTxHash,
    finality: null,
    paymentResponseHeader: lateFinalityResponseHeader,
  })
  assert.equal(pendingLateFinality.status, 'payment_pending')
  assert.ok(pendingLateFinality.recoveryDeadlineAt)

  const wallClockStartedAt = Date.now()
  let finalizedAt = ''
  for (;;) {
    const observed = (await client.query<{
      observed_at: Date
      operation_passed: boolean
      authorization_passed: boolean
    }>(`
      SELECT clock_timestamp() AS observed_at,
        clock_timestamp() > $1::timestamptz + interval '1 millisecond' AS operation_passed,
        clock_timestamp() > to_timestamp($2::bigint) + interval '1 millisecond'
          AS authorization_passed
    `, [lateBoundary.end_time.toISOString(), lateBoundary.valid_before])).rows[0]!
    if (observed.operation_passed && observed.authorization_passed) {
      finalizedAt = observed.observed_at.toISOString()
      break
    }
    await delay(25)
  }
  assert.ok(
    Date.now() - wallClockStartedAt >= 1_500,
    'the drawing test must cross a real PostgreSQL authorization window',
  )

  const finalizedLatePayment = await bindPaymentEvidence(database, {
    publicId: lateFinalityAttemptId,
    leaseOwner: lateFinalityLeaseOwner,
    txHash: lateFinalityTxHash,
    finality: {
      blockNumber: 50_000_001n,
      blockHash: `0x${'8'.repeat(64)}`,
      blockTime: lateBoundary.block_time.toISOString(),
      finalizedAt,
    },
    paymentResponseHeader: lateFinalityResponseHeader,
  })
  assert.equal(finalizedLatePayment.status, 'payment_pending')

  const lateTiming = (await client.query<{
    block_inside_authorization: boolean
    block_inside_operation: boolean
    observed_after_authorization: boolean
    observed_after_operation: boolean
    recovery_window_open: boolean
  }>(`
    SELECT finalized_block_time >= to_timestamp(x402_valid_after)
        AND finalized_block_time < to_timestamp(x402_valid_before)
        AS block_inside_authorization,
      finalized_block_time >= start_time AND finalized_block_time < end_time
        AS block_inside_operation,
      finalized_at > to_timestamp(x402_valid_before) AS observed_after_authorization,
      finalized_at > end_time AS observed_after_operation,
      recovery_deadline_at > clock_timestamp() AS recovery_window_open
    FROM payment_attempts WHERE public_id = $1
  `, [lateFinalityAttemptId])).rows[0]
  assert.deepEqual(lateTiming, {
    block_inside_authorization: true,
    block_inside_operation: true,
    observed_after_authorization: true,
    observed_after_operation: true,
    recovery_window_open: true,
  })

  const lateCompleted = await completeTreasuryPaymentOperation(database, {
    attemptId: lateFinalityAttemptId,
    leaseOwner: lateFinalityLeaseOwner,
  })
  assert.equal(lateCompleted.state, 'completed')
  if (lateCompleted.state !== 'completed') {
    assert.fail('expected the late-finalizing drawing invention to complete inside recovery')
  }
  assert.equal(lateCompleted.method, 'x402')
  assert.deepEqual(
    (lateCompleted.response.kind as { drawing: unknown }).drawing,
    lateFinalityDrawing,
  )
  const lateStored = (await client.query<{
    status: string
    payment_uses: number
    kind_drawing: unknown
  }>(`
    SELECT attempt.status,
      (SELECT count(*)::integer FROM payment_uses payment_use
        WHERE payment_use.payment_attempt_id = attempt.public_id) AS payment_uses,
      revision.drawing AS kind_drawing
    FROM payment_attempts attempt
    JOIN kinds kind ON kind.name = $2
    JOIN kind_revisions revision
      ON revision.kind_id = kind.id AND revision.revision = kind.current_revision
    WHERE attempt.public_id = $1
  `, [lateFinalityAttemptId, lateFinalityRequest.name])).rows[0]
  assert.deepEqual(lateStored, {
    status: 'completed',
    payment_uses: 1,
    kind_drawing: lateFinalityDrawing,
  })
}
