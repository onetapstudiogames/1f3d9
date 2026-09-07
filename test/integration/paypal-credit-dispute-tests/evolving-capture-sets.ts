import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type { PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'
import { applyPayPalCreditDispute } from '../../../src/paypal-credit-dispute.ts'
import {
  deliverPreparedGift,
  deliveredGift,
  giftState,
  prepareGift,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts'
import { dispute } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'

export async function registerEvolvingCaptureSetsTests(
  pool: Pool,
  db: PayPalCreditStoreDatabase,
): Promise<void> {
  const sellerFirst = await deliveredGift(db, 2)
  const sellerSecond = await deliveredGift(db, 3)
  const sellerDisputeId = 'PP-D-EVOLVING-SELLER'
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-EVOLVING-SELLER-CREATED',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: sellerDisputeId,
    captureId: sellerFirst.captureId,
    updateTime: '2026-08-27T18:00:00.000Z',
  }))
  assert.equal((await giftState(pool, sellerFirst.giftId)).status, 'frozen')
  assert.equal((await giftState(pool, sellerSecond.giftId)).status, 'pending')
  const sellerResolved = dispute({
    eventId: 'WH-EVOLVING-SELLER-RESOLVED',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: sellerDisputeId,
    captureId: sellerSecond.captureId,
    updateTime: '2026-08-27T19:00:00.000Z',
    outcomeCode: 'RESOLVED_SELLER_FAVOUR',
  })
  assert.equal((await applyPayPalCreditDispute(db, sellerResolved)).applicationOutcome,
    'dispute_resolved_gift_pending')
  assert.equal((await giftState(pool, sellerFirst.giftId)).status, 'pending')
  assert.equal((await giftState(pool, sellerSecond.giftId)).status, 'pending')

  const adverseFirst = await deliveredGift(db, 2)
  const adverseSecond = await deliveredGift(db, 3)
  const adverseDisputeId = 'PP-D-EVOLVING-ADVERSE'
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-EVOLVING-ADVERSE-CREATED',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: adverseDisputeId,
    captureId: adverseFirst.captureId,
    updateTime: '2026-08-27T20:00:00.000Z',
  }))
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-EVOLVING-ADVERSE-RESOLVED',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: adverseDisputeId,
    captureId: adverseSecond.captureId,
    updateTime: '2026-08-27T21:00:00.000Z',
    outcomeCode: 'RESOLVED_BUYER_FAVOUR',
  }))
  assert.equal((await giftState(pool, adverseFirst.giftId)).status, 'revoked')
  assert.equal((await giftState(pool, adverseSecond.giftId)).status, 'revoked')

  const latePrepared = await prepareGift(db, 2, 'CAPTURE-EVOLVING-LATE')
  const lateKnown = await deliveredGift(db, 3)
  const lateDisputeId = 'PP-D-EVOLVING-LATE'
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-EVOLVING-LATE-CREATED',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: lateDisputeId,
    captureId: latePrepared.captureId,
    updateTime: '2026-08-27T22:00:00.000Z',
  }))
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-EVOLVING-LATE-RESOLVED',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: lateDisputeId,
    captureId: lateKnown.captureId,
    updateTime: '2026-08-27T23:00:00.000Z',
    outcomeCode: 'ACCEPTED',
  }))
  assert.equal((await giftState(pool, lateKnown.giftId)).status, 'revoked')
  const deliveredLate = await deliverPreparedGift(db, latePrepared)
  assert.equal(deliveredLate.status, 'revoked')

  const receiptMatrices = await pool.query<{ dispute_id: string; receipts: string }>(`
      SELECT paypal_dispute_id AS dispute_id, count(*)::text AS receipts
      FROM city_credit_entries
      WHERE paypal_dispute_id = ANY($1::text[])
      GROUP BY paypal_dispute_id ORDER BY paypal_dispute_id
    `, [[adverseDisputeId, lateDisputeId, sellerDisputeId]])
  assert.deepEqual(receiptMatrices.rows, [
    { dispute_id: adverseDisputeId, receipts: '4' },
    { dispute_id: lateDisputeId, receipts: '4' },
    { dispute_id: sellerDisputeId, receipts: '4' },
  ])

}
