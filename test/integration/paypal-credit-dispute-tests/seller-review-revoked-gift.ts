import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type { PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'
import {
  applyPayPalCreditDispute,
  resolveFounderPayPalCreditDispute,
} from '../../../src/paypal-credit-dispute.ts'
import {
  deliveredGift,
  giftState,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts'
import { dispute } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'
import { readCityCreditAccount } from '../../../src/city-credit.ts'

export async function registerSellerReviewRevokedGiftTests(
  pool: Pool,
  db: PayPalCreditStoreDatabase,
): Promise<void> {
  const gift = await deliveredGift(db, 2)
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-MULTI-DISPUTE-ADVERSE',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: 'PP-D-MULTI-DISPUTE-ADVERSE',
    captureId: gift.captureId,
    updateTime: '2026-08-28T07:00:00.000Z',
    outcomeCode: 'RESOLVED_BUYER_FAVOUR',
  }))
  assert.equal((await giftState(pool, gift.giftId)).status, 'revoked')

  const reviewDisputeId = 'PP-D-MULTI-DISPUTE-REVIEW'
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-MULTI-DISPUTE-REVIEW',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: reviewDisputeId,
    captureId: gift.captureId,
    updateTime: '2026-08-28T08:00:00.000Z',
    outcomeCode: 'RESOLVED_WITH_PAYOUT',
  }))
  const resolution = await resolveFounderPayPalCreditDispute(db, {
    founderId: 1,
    disputeId: reviewDisputeId,
    decision: 'seller_favour',
  })
  assert.equal(resolution.applicationOutcome,
    'founder_review_seller_favour_applied')
  assert.equal((await giftState(pool, gift.giftId)).status, 'revoked')

  const receipts = await pool.query<{
    application_outcome: string
    reason: string
  }>(`
      SELECT application_outcome, reason FROM city_credit_entries
      WHERE paypal_dispute_id = $1 AND entry_kind = 'paypal_dispute_reviewed'
    `, [reviewDisputeId])
  assert.deepEqual(receipts.rows, [{
    application_outcome: 'founder_review_gift_still_revoked',
    reason: 'Founder resident #1 chose seller favour for the ambiguous PayPal outcome. Another dispute already permanently revoked this gift.',
  }])
  const account = await readCityCreditAccount(db, 2, { limit: 50 })
  const receipt = account.history.find(entry =>
    entry.kind === 'paypal_dispute_reviewed'
    && entry.reason?.includes('Another dispute already permanently revoked'))
  assert.ok(receipt)
  assert.equal(receipt.amount_units, '0')

}
