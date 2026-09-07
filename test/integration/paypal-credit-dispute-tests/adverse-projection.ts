import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type { PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'
import { applyPayPalCreditDispute } from '../../../src/paypal-credit-dispute.ts'
import {
  deliveredGift,
  giftState,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts'
import { dispute } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'

export async function registerAdverseProjectionTests(
  pool: Pool,
  db: PayPalCreditStoreDatabase,
): Promise<void> {
  const guardedGift = await deliveredGift(db, 2)
  const guardedDisputeId = 'PP-D-ADVERSE-PROJECTION-GUARD'
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-ADVERSE-PROJECTION-REVIEW',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: guardedDisputeId,
    captureId: guardedGift.captureId,
    updateTime: '2026-08-28T10:00:00.000Z',
    outcomeCode: 'NONE',
  }))
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-ADVERSE-PROJECTION-STALE',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: guardedDisputeId,
    captureId: guardedGift.captureId,
    updateTime: '2026-08-28T09:00:00.000Z',
    outcomeCode: 'ACCEPTED',
  }))
  const attacker = await pool.connect()
  try {
    await attacker.query('BEGIN')
    await attacker.query(`
        UPDATE paypal_credit_disputes
        SET state = 'resolved_against_seller', paypal_status = 'RESOLVED',
          outcome_code = 'ACCEPTED', resolved_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE dispute_id = $1
      `, [guardedDisputeId])
    await assert.rejects(attacker.query('COMMIT'),
      /current adverse lifecycle evidence|matching append-only event/iu)
  } finally {
    await attacker.query('ROLLBACK').catch(() => undefined)
    attacker.release()
  }
  const guardedProjection = await pool.query<{
    state: string
    outcome_code: string
  }>(`
      SELECT state, outcome_code FROM paypal_credit_disputes
      WHERE dispute_id = $1
    `, [guardedDisputeId])
  assert.deepEqual(guardedProjection.rows, [{
    state: 'resolution_review', outcome_code: 'NONE',
  }])
  assert.equal((await giftState(pool, guardedGift.giftId)).status, 'frozen')

  const retainedGift = await deliveredGift(db, 3)
  const retainedDisputeId = 'PP-D-ADVERSE-PROJECTION-RETAINED'
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-ADVERSE-PROJECTION-CURRENT',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: retainedDisputeId,
    captureId: retainedGift.captureId,
    updateTime: '2026-08-28T11:00:00.000Z',
    outcomeCode: 'RESOLVED_BUYER_FAVOUR',
  }))
  const laterProviderUpdate = await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-ADVERSE-PROJECTION-LATER-UPDATE',
    eventKind: 'CUSTOMER.DISPUTE.UPDATED',
    disputeId: retainedDisputeId,
    captureId: retainedGift.captureId,
    updateTime: '2026-08-28T12:00:00.000Z',
    paypalStatus: 'UNDER_REVIEW',
  }))
  assert.equal(laterProviderUpdate.state, 'resolved_against_seller')
  assert.equal((await giftState(pool, retainedGift.giftId)).status, 'revoked')

}
