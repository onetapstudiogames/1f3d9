import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type { PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'
import {
  applyPayPalCreditDispute,
  readFounderPayPalCreditDisputes,
} from '../../../src/paypal-credit-dispute.ts'
import {
  deliverPreparedGift,
  deliveredGift,
  giftState,
  prepareGift,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts'
import {
  dispute,
  rawApply,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'

export async function registerOutcomeClassificationTests(
  pool: Pool,
  db: PayPalCreditStoreDatabase,
): Promise<void> {
  const late = await prepareGift(db, 2, 'CAPTURE-DISPUTE-BEFORE-DELIVERY')
  const opened = dispute({
    eventId: 'WH-DISPUTE-EARLY-CREATED',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: 'PP-D-EARLY-0001',
    captureId: late.captureId,
    updateTime: '2026-08-27T20:00:00.000Z',
  })
  const staged = await applyPayPalCreditDispute(db, opened)
  assert.equal(staged.applicationOutcome, 'dispute_awaiting_capture_receipt')
  assert.equal(staged.localPurchaseCount, 0)
  assert.equal(staged.receiptsCreated, 0)
  assert.equal(await pool.query(`SELECT count(*)::text AS count
      FROM founder_city_credit_notes WHERE dispute_id = $1`, [opened.disputeId])
    .then(result => result.rows[0]?.count), '1')
  const unmatchedInspection = await readFounderPayPalCreditDisputes(db, 1)
  assert.equal(unmatchedInspection.length, 1)
  assert.equal(unmatchedInspection[0]?.dispute_id, opened.disputeId)
  assert.equal(unmatchedInspection[0]?.capture_id, late.captureId)
  assert.equal(unmatchedInspection[0]?.gift_id, null)
  assert.equal(unmatchedInspection[0]?.amount_units, null)
  assert.match(unmatchedInspection[0]?.internal_note ?? '', /Verified PayPal dispute/iu)
  assert.deepEqual(await readFounderPayPalCreditDisputes(db, 2), [])

  const delivered = await deliverPreparedGift(db, late)
  assert.equal(delivered.status, 'frozen')
  assert.equal((await applyPayPalCreditDispute(db, opened)).applicationOutcome,
    'dispute_open_gift_frozen')

  const sellerResolved = dispute({
    eventId: 'WH-DISPUTE-EARLY-SELLER',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: opened.disputeId,
    captureIds: opened.captureIds,
    updateTime: '2026-08-27T23:00:00.000Z',
    outcomeCode: 'RESOLVED_SELLER_FAVOUR',
  })
  assert.equal((await applyPayPalCreditDispute(db, sellerResolved)).applicationOutcome,
    'dispute_resolved_gift_pending')
  assert.equal((await giftState(pool, delivered.giftId)).status, 'pending')

  const stale = dispute({
    eventId: 'WH-DISPUTE-EARLY-STALE',
    eventKind: 'CUSTOMER.DISPUTE.UPDATED',
    disputeId: opened.disputeId,
    captureIds: opened.captureIds,
    updateTime: '2026-08-27T22:00:00.000Z',
  })
  const staleApplied = await applyPayPalCreditDispute(db, stale)
  assert.equal(staleApplied.state, 'resolved_seller')
  assert.equal(staleApplied.applicationOutcome, 'dispute_stale_event_ignored')
  assert.equal((await giftState(pool, delivered.giftId)).status, 'pending')

  const newerOpen = dispute({
    eventId: 'WH-DISPUTE-EARLY-NEWER-OPEN',
    eventKind: 'CUSTOMER.DISPUTE.UPDATED',
    disputeId: opened.disputeId,
    captureIds: opened.captureIds,
    updateTime: '2026-08-28T01:00:00.000Z',
  })
  assert.equal((await applyPayPalCreditDispute(db, newerOpen)).state, 'open')
  assert.equal((await giftState(pool, delivered.giftId)).status, 'frozen')

  const resolvedFirstGift = await deliveredGift(db, 3)
  const resolvedFirst = dispute({
    eventId: 'WH-DISPUTE-RESOLVED-BEFORE-CREATED',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: 'PP-D-RESOLVED-BEFORE-CREATED',
    captureId: resolvedFirstGift.captureId,
    updateTime: '2026-08-28T03:00:00.000Z',
    outcomeCode: 'CANCELED_BY_BUYER',
  })
  assert.equal((await applyPayPalCreditDispute(db, resolvedFirst)).state,
    'resolved_seller')
  const olderCreated = dispute({
    eventId: 'WH-DISPUTE-CREATED-AFTER-RESOLVED',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: resolvedFirst.disputeId,
    captureIds: resolvedFirst.captureIds,
    updateTime: '2026-08-28T02:00:00.000Z',
  })
  assert.equal((await applyPayPalCreditDispute(db, olderCreated)).applicationOutcome,
    'dispute_stale_event_ignored')
  assert.equal((await giftState(pool, resolvedFirstGift.giftId)).status, 'pending')

  const classifications = [
    ['RESOLVED_SELLER_FAVOUR', 'resolved_seller'],
    ['CANCELED_BY_BUYER', 'resolved_seller'],
    ['DENIED', 'resolved_seller'],
    ['RESOLVED_BUYER_FAVOUR', 'resolved_against_seller'],
    ['ACCEPTED', 'resolved_against_seller'],
    ['RESOLVED_WITH_PAYOUT', 'resolution_review'],
    ['NONE', 'resolution_review'],
  ] as const
  for (const [outcomeCode, expectedState] of classifications) {
    const suffix = outcomeCode.replaceAll('_', '-')
    const result = await rawApply(pool, {
      eventId: `WH-OUTCOME-${suffix}`,
      disputeId: `PP-D-OUTCOME-${suffix}`,
      captureIds: [`CAPTURE-OUTCOME-${suffix}`],
      outcomeCode,
    })
    assert.equal(result.rows[0]?.state, expectedState)
    assert.equal(result.rows[0]?.application_outcome,
      'dispute_awaiting_capture_receipt')
  }

}
