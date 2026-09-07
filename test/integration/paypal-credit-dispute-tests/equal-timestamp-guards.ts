import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type { PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'
import { applyPayPalCreditDispute } from '../../../src/paypal-credit-dispute.ts'
import {
  deliveredGift,
  giftState,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts'
import { dispute } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'

export async function registerEqualTimestampGuardsTests(
  pool: Pool,
  db: PayPalCreditStoreDatabase,
): Promise<void> {
  const sellerGift = await deliveredGift(db, 2)
  const sellerDisputeId = 'PP-D-EQUAL-TIME-SELLER'
  const sharedResolutionTime = '2026-08-27T20:00:00.000Z'
  const sellerCreated = dispute({
    eventId: 'WH-EQUAL-TIME-SELLER-CREATED',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: sellerDisputeId,
    captureId: sellerGift.captureId,
    updateTime: sharedResolutionTime,
  })
  assert.equal((await applyPayPalCreditDispute(db, sellerCreated)).state, 'open')
  assert.equal((await giftState(pool, sellerGift.giftId)).status, 'frozen')

  const sellerResolved = dispute({
    eventId: 'WH-EQUAL-TIME-SELLER-RESOLVED',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: sellerDisputeId,
    captureId: sellerGift.captureId,
    updateTime: sharedResolutionTime,
    outcomeCode: 'CANCELED_BY_BUYER',
  })
  const appliedResolution = await applyPayPalCreditDispute(db, sellerResolved)
  assert.equal(appliedResolution.state, 'resolved_seller')
  assert.equal(appliedResolution.applicationOutcome, 'dispute_resolved_gift_pending')
  assert.equal((await giftState(pool, sellerGift.giftId)).status, 'pending')

  const resolutionReplay = await applyPayPalCreditDispute(db, sellerResolved)
  assert.equal(resolutionReplay.disposition, 'existing')
  assert.equal(resolutionReplay.state, 'resolved_seller')
  const createdReplay = await applyPayPalCreditDispute(db, sellerCreated)
  assert.equal(createdReplay.disposition, 'existing')
  assert.equal(createdReplay.state, 'resolved_seller')
  assert.equal((await giftState(pool, sellerGift.giftId)).status, 'pending')

  const equalTimeLowerLifecycle = dispute({
    eventId: 'WH-EQUAL-TIME-SELLER-LATE-UPDATED',
    eventKind: 'CUSTOMER.DISPUTE.UPDATED',
    disputeId: sellerDisputeId,
    captureId: sellerGift.captureId,
    updateTime: sharedResolutionTime,
    paypalStatus: 'UNDER_REVIEW',
  })
  const lowerLifecycle = await applyPayPalCreditDispute(db, equalTimeLowerLifecycle)
  assert.equal(lowerLifecycle.state, 'resolved_seller')
  assert.equal(lowerLifecycle.applicationOutcome, 'dispute_stale_event_ignored')

  const olderUpdate = dispute({
    eventId: 'WH-EQUAL-TIME-SELLER-OLDER-UPDATED',
    eventKind: 'CUSTOMER.DISPUTE.UPDATED',
    disputeId: sellerDisputeId,
    captureId: sellerGift.captureId,
    updateTime: '2026-08-27T19:59:59.000Z',
    paypalStatus: 'WAITING_FOR_SELLER_RESPONSE',
  })
  const olderApplied = await applyPayPalCreditDispute(db, olderUpdate)
  assert.equal(olderApplied.state, 'resolved_seller')
  assert.equal(olderApplied.applicationOutcome, 'dispute_stale_event_ignored')
  assert.equal((await giftState(pool, sellerGift.giftId)).status, 'pending')

  const updatedGift = await deliveredGift(db, 3)
  const updatedDisputeId = 'PP-D-EQUAL-TIME-UPDATES'
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-EQUAL-TIME-UPDATES-CREATED',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: updatedDisputeId,
    captureId: updatedGift.captureId,
    updateTime: '2026-08-27T20:59:59.000Z',
  }))
  const firstUpdate = dispute({
    eventId: 'WH-EQUAL-TIME-UPDATES-FIRST',
    eventKind: 'CUSTOMER.DISPUTE.UPDATED',
    disputeId: updatedDisputeId,
    captureId: updatedGift.captureId,
    updateTime: '2026-08-27T21:00:00.000Z',
    paypalStatus: 'WAITING_FOR_SELLER_RESPONSE',
  })
  const secondUpdate = dispute({
    eventId: 'WH-EQUAL-TIME-UPDATES-SECOND',
    eventKind: 'CUSTOMER.DISPUTE.UPDATED',
    disputeId: updatedDisputeId,
    captureId: updatedGift.captureId,
    updateTime: '2026-08-27T21:00:00.000Z',
    paypalStatus: 'UNDER_REVIEW',
  })
  assert.equal((await applyPayPalCreditDispute(db, firstUpdate)).paypalStatus,
    'WAITING_FOR_SELLER_RESPONSE')
  assert.equal((await applyPayPalCreditDispute(db, secondUpdate)).paypalStatus,
    'UNDER_REVIEW')
  const earlierUpdateReplay = await applyPayPalCreditDispute(db, firstUpdate)
  assert.equal(earlierUpdateReplay.disposition, 'existing')
  assert.equal(earlierUpdateReplay.paypalStatus, 'UNDER_REVIEW')
  assert.equal((await giftState(pool, updatedGift.giftId)).status, 'frozen')

  const conflictingGift = await deliveredGift(db, 2)
  const conflictingDisputeId = 'PP-D-EQUAL-TIME-CONFLICT'
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-EQUAL-TIME-CONFLICT-CREATED',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: conflictingDisputeId,
    captureId: conflictingGift.captureId,
    updateTime: '2026-08-27T21:59:59.000Z',
  }))
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-EQUAL-TIME-CONFLICT-RESOLVED',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: conflictingDisputeId,
    captureId: conflictingGift.captureId,
    updateTime: '2026-08-27T22:00:00.000Z',
    outcomeCode: 'CANCELED_BY_BUYER',
  }))
  await assert.rejects(applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-EQUAL-TIME-CONFLICT-CHANGED',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: conflictingDisputeId,
    captureId: conflictingGift.captureId,
    updateTime: '2026-08-27T22:00:00.000Z',
    outcomeCode: 'RESOLVED_SELLER_FAVOUR',
  })), /conflicts with durable credit history/iu)

  const evidence = await pool.query<{
    seller_events: string
    seller_receipts: string
    update_events: string
    update_receipts: string
    conflict_events: string
    conflict_receipts: string
    conflict_outcome: string
  }>(`
      SELECT
        (SELECT count(*) FROM paypal_credit_dispute_events
          WHERE dispute_id = $1)::text AS seller_events,
        (SELECT count(*) FROM city_credit_entries
          WHERE paypal_dispute_id = $1)::text AS seller_receipts,
        (SELECT count(*) FROM paypal_credit_dispute_events
          WHERE dispute_id = $2)::text AS update_events,
        (SELECT count(*) FROM city_credit_entries
          WHERE paypal_dispute_id = $2)::text AS update_receipts,
        (SELECT count(*) FROM paypal_credit_dispute_events
          WHERE dispute_id = $3)::text AS conflict_events,
        (SELECT count(*) FROM city_credit_entries
          WHERE paypal_dispute_id = $3)::text AS conflict_receipts,
        (SELECT outcome_code FROM paypal_credit_disputes
          WHERE dispute_id = $3)::text AS conflict_outcome
    `, [sellerDisputeId, updatedDisputeId, conflictingDisputeId])
  assert.deepEqual(evidence.rows[0], {
    seller_events: '4', seller_receipts: '4',
    update_events: '3', update_receipts: '3',
    conflict_events: '2', conflict_receipts: '2',
    conflict_outcome: 'CANCELED_BY_BUYER',
  })

}
