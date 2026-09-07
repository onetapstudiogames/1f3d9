import assert from 'node:assert/strict'
import { closeSalePaymentTarget, completeDirectSalePayment, completeWorldSalePayment, invalidateSalePaymentTarget, parkWorldSalePayment, type PaymentSaleDatabase } from '../../../src/payment-sale-operations.ts'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { FACILITATOR_RESPONSE_HEADER } from '../../helpers/payment-postgres-fixtures/attempts.ts'
import { saleDatabase, seedRecoverableSale } from '../../helpers/payment-postgres-fixtures/sales.ts'

export async function registerSaleRecoveryTests(
  t: TestContext,
  postgres: { client: Pool },
  resetFresh: (database: Pool) => Promise<void>,
): Promise<void> {
  await t.test('duplicate direct-sale workers complete once after fifteen minutes and replay exact bytes', async () => {
    await resetFresh(postgres.client)
    const seed = await seedRecoverableSale(postgres.client, 'direct_sale', '5')
    const database = saleDatabase(postgres.client)

    const results = await Promise.all([
      completeDirectSalePayment(database, {
        attemptId: seed.attemptId,
        leaseOwner: seed.leaseOwner,
      }),
      completeDirectSalePayment(database, {
        attemptId: seed.attemptId,
        leaseOwner: seed.leaseOwner,
      }),
    ])

    assert.ok(results.every(result => result.state === 'completed'))
    const completed = results.filter(result => result.state === 'completed')
    assert.equal(completed[0]!.responseBody, completed[1]!.responseBody)
    assert.equal(completed[0]!.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
    const facts = await postgres.client.query(`
        SELECT attempt.status, offer.status AS offer_status, thing.owner_id,
          thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM sale_payments WHERE offer_id = $2) AS payments,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers,
          (SELECT count(*)::int FROM events WHERE kind = 'sale'
            AND detail->>'offer_id' = $2::text) AS events
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
    assert.deepEqual(facts.rows, [{
      status: 'completed',
      offer_status: 'claimed',
      owner_id: 2,
      active_offer_id: null,
      uses: 1,
      payments: 1,
      transfers: 1,
      events: 1,
    }])
  })

  await t.test('founder review atomically closes an active direct reservation and releases its asset', async () => {
    await resetFresh(postgres.client)
    const seed = await seedRecoverableSale(
      postgres.client,
      'direct_sale',
      '4',
      { activeReservation: true },
    )

    const closed = await closeSalePaymentTarget(saleDatabase(postgres.client), {
      attemptId: seed.attemptId,
      leaseOwner: seed.leaseOwner,
      reason: 'automatic completion found changed direct sale facts',
      state: 'founder_review',
    })

    assert.deepEqual(closed, {
      state: 'founder_review',
      attemptId: seed.attemptId,
      actorId: 2,
      operation: 'direct_sale',
      method: 'x402',
      targetReleased: true,
    })
    const facts = await postgres.client.query(`
        SELECT attempt.status, attempt.invalid_reason, attempt.lease_owner,
          offer.status AS offer_status, offer.canceled_at IS NOT NULL AS canceled,
          thing.owner_id, thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM sale_payments WHERE offer_id = $2) AS payments,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
    assert.deepEqual(facts.rows, [{
      status: 'founder_review',
      invalid_reason: 'automatic completion found changed direct sale facts',
      lease_owner: null,
      offer_status: 'canceled',
      canceled: true,
      owner_id: 1,
      active_offer_id: null,
      uses: 0,
      payments: 0,
      transfers: 0,
    }])
  })

  await t.test('world-sale recovery attaches stored evidence and completes once with maker and owner output', async () => {
    await resetFresh(postgres.client)
    const seed = await seedRecoverableSale(postgres.client, 'world_sale', '6')
    const database = saleDatabase(postgres.client)

    const completed = await completeWorldSalePayment(database, {
      attemptId: seed.attemptId,
      leaseOwner: seed.leaseOwner,
    })

    assert.equal(completed.state, 'completed')
    if (completed.state !== 'completed') return
    const response = completed.response as {
      offer?: { maker_id?: number; made_by?: string; current_owner_id?: number; current_owner?: string }
    }
    assert.deepEqual(response.offer && {
      maker_id: response.offer.maker_id,
      made_by: response.offer.made_by,
      current_owner_id: response.offer.current_owner_id,
      current_owner: response.offer.current_owner,
    }, {
      maker_id: 1,
      made_by: 'seller',
      current_owner_id: 2,
      current_owner: 'buyer',
    })
    assert.equal(completed.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
    const facts = await postgres.client.query(`
        SELECT attempt.status, offer.status AS offer_status,
          offer.pending_payment_attempt_id, offer.pending_x402_tx_hash,
          offer.x402_evidence_state, thing.owner_id, thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
    assert.deepEqual(facts.rows, [{
      status: 'completed',
      offer_status: 'claimed',
      pending_payment_attempt_id: seed.attemptId,
      pending_x402_tx_hash: seed.txHash,
      x402_evidence_state: 'pending',
      owner_id: 2,
      active_offer_id: null,
      uses: 1,
      transfers: 1,
    }])
  })

  await t.test('interruption after atomic invalidation cannot strand a pending world receipt', async () => {
    await resetFresh(postgres.client)
    const seed = await seedRecoverableSale(postgres.client, 'world_sale', '9')
    const database = saleDatabase(postgres.client)
    const parked = await parkWorldSalePayment(database, { attemptId: seed.attemptId })
    assert.equal(parked.state, 'parked')
    const interrupted: PaymentSaleDatabase = {
      query: async (text, params = []) => {
        const rows = (await postgres.client.query(text, [...params])).rows
        if (text.includes('payment-sale-operations:invalidate-target')) {
          throw new Error('connection lost after atomic invalidation committed')
        }
        return rows
      },
    }

    await assert.rejects(
      invalidateSalePaymentTarget(interrupted, {
        attemptId: seed.attemptId,
        leaseOwner: seed.leaseOwner,
        reason: 'confirmed_mismatch',
      }),
      /connection lost after atomic invalidation committed/,
    )

    const facts = await postgres.client.query(`
        SELECT attempt.status, attempt.invalid_reason, attempt.lease_owner,
          offer.status AS offer_status, offer.x402_evidence_state,
          offer.x402_invalid_reason, offer.pending_payment_attempt_id,
          thing.owner_id, thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
    assert.deepEqual(facts.rows, [{
      status: 'invalid',
      invalid_reason: 'confirmed_mismatch',
      lease_owner: null,
      offer_status: 'open',
      x402_evidence_state: 'invalid',
      x402_invalid_reason: 'confirmed_mismatch',
      pending_payment_attempt_id: seed.attemptId,
      owner_id: 1,
      active_offer_id: seed.offerId,
      uses: 0,
      transfers: 0,
    }])
  })

  await t.test('founder review creates no sale and keeps a world target locked against late reuse', async () => {
    await resetFresh(postgres.client)
    const seed = await seedRecoverableSale(postgres.client, 'world_sale', '7')
    const database = saleDatabase(postgres.client)

    const closed = await closeSalePaymentTarget(database, {
      attemptId: seed.attemptId,
      leaseOwner: seed.leaseOwner,
      reason: 'automatic completion found changed world sale facts',
      state: 'founder_review',
    })
    const late = await completeWorldSalePayment(database, {
      attemptId: seed.attemptId,
      leaseOwner: seed.leaseOwner,
    })

    assert.deepEqual(closed, {
      state: 'founder_review',
      attemptId: seed.attemptId,
      actorId: 2,
      operation: 'world_sale',
      method: 'x402',
      targetReleased: false,
    })
    assert.equal(late.state, 'target_changed')
    const facts = await postgres.client.query(`
        SELECT attempt.status, attempt.lease_owner,
          offer.status AS offer_status, offer.x402_evidence_state,
          offer.pending_payment_attempt_id, thing.owner_id, thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM sale_payments WHERE offer_id = $2) AS payments,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
    assert.deepEqual(facts.rows, [{
      status: 'founder_review',
      lease_owner: null,
      offer_status: 'open',
      x402_evidence_state: 'founder_review',
      pending_payment_attempt_id: seed.attemptId,
      owner_id: 1,
      active_offer_id: seed.offerId,
      uses: 0,
      payments: 0,
      transfers: 0,
    }])
  })

  await t.test('deadline closes an ambiguous no-hash world attempt without inventing offer evidence', async () => {
    await resetFresh(postgres.client)
    const seed = await seedRecoverableSale(
      postgres.client,
      'world_sale',
      '8',
      { ambiguousNoTx: true },
    )

    const closed = await closeSalePaymentTarget(saleDatabase(postgres.client), {
      attemptId: seed.attemptId,
      leaseOwner: seed.leaseOwner,
      reason: 'automatic recovery deadline passed without transaction evidence',
      state: 'expired',
    })

    assert.equal(closed.state, 'expired')
    assert.equal(closed.targetReleased, false)
    const facts = await postgres.client.query(`
        SELECT attempt.status, attempt.tx_hash, attempt.lease_owner,
          offer.status AS offer_status, offer.x402_evidence_state,
          offer.pending_payment_attempt_id, offer.pending_x402_tx_hash,
          offer.pending_x402_payer, offer.pending_x402_at,
          thing.owner_id, thing.active_offer_id,
          (SELECT count(*)::int FROM payment_uses WHERE payment_attempt_id = $1) AS uses,
          (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers
        FROM payment_attempts attempt
        JOIN transfer_offers offer ON offer.id = attempt.offer_id
        JOIN things thing ON thing.id = attempt.asset_id
        WHERE attempt.public_id = $1
      `, [seed.attemptId, seed.offerId])
    assert.deepEqual(facts.rows, [{
      status: 'expired',
      tx_hash: null,
      lease_owner: null,
      offer_status: 'open',
      x402_evidence_state: 'none',
      pending_payment_attempt_id: null,
      pending_x402_tx_hash: null,
      pending_x402_payer: null,
      pending_x402_at: null,
      owner_id: 1,
      active_offer_id: seed.offerId,
      uses: 0,
      transfers: 0,
    }])
  })
}
