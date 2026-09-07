import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type { PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'
import {
  acceptCreditGift,
  refuseCreditGift,
} from '../../../src/prepaid-credit.ts'
import {
  applyPayPalCreditDispute,
  readFounderPayPalCreditDisputes,
  resolveFounderPayPalCreditDispute,
} from '../../../src/paypal-credit-dispute.ts'
import {
  deliveredGift,
  giftState,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts'
import { dispute } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'
import {
  readCityCreditAccount,
} from '../../../src/city-credit.ts'

export async function registerFounderReviewTests(
  pool: Pool,
  db: PayPalCreditStoreDatabase,
): Promise<void> {
  const sellerGift = await deliveredGift(db, 2)
  const sellerDisputeId = 'PP-D-FOUNDER-REVIEW-SELLER'
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-FOUNDER-REVIEW-SELLER',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: sellerDisputeId,
    captureId: sellerGift.captureId,
    updateTime: '2026-08-28T01:00:00.000Z',
    outcomeCode: 'RESOLVED_WITH_PAYOUT',
  }))
  assert.equal((await giftState(pool, sellerGift.giftId)).status, 'frozen')

  const sellerDecision = await resolveFounderPayPalCreditDispute(db, {
    founderId: 1,
    disputeId: sellerDisputeId,
    decision: 'seller_favour',
  })
  assert.deepEqual(sellerDecision, {
    disputeId: sellerDisputeId,
    decision: 'seller_favour',
    state: 'resolved_seller',
    applicationOutcome: 'founder_review_seller_favour_applied',
    disposition: 'created',
    localPurchaseCount: 1,
    receiptsCreated: 1,
  })
  const sellerGiftAfter = await giftState(pool, sellerGift.giftId)
  assert.equal(sellerGiftAfter.status, 'pending')
  assert.equal(sellerGiftAfter.frozen_at, null)

  const sellerReplay = await resolveFounderPayPalCreditDispute(db, {
    founderId: 1,
    disputeId: sellerDisputeId,
    decision: 'seller_favour',
  })
  assert.deepEqual(sellerReplay, {
    ...sellerDecision,
    disposition: 'existing',
    receiptsCreated: 0,
  })
  await assert.rejects(resolveFounderPayPalCreditDispute(db, {
    founderId: 1,
    disputeId: sellerDisputeId,
    decision: 'buyer_favour',
  }), /already has.*founder decision|opposite founder decision/iu)

  const sellerReviews = await pool.query<{
    founder_id: number
    decision: string
  }>(`
      SELECT founder_id, decision FROM paypal_credit_dispute_reviews
      WHERE dispute_id = $1
    `, [sellerDisputeId])
  assert.deepEqual(sellerReviews.rows, [{ founder_id: 1, decision: 'seller_favour' }])
  const sellerReceipts = await pool.query<{
    resident_id: number
    entry_kind: string
    reason: string
  }>(`
      SELECT resident_id, entry_kind, reason FROM city_credit_entries
      WHERE paypal_dispute_id = $1 AND entry_kind = 'paypal_dispute_reviewed'
    `, [sellerDisputeId])
  assert.equal(sellerReceipts.rows.length, 1)
  assert.equal(sellerReceipts.rows[0]?.resident_id, 2)
  assert.equal(sellerReceipts.rows[0]?.entry_kind, 'paypal_dispute_reviewed')
  assert.match(sellerReceipts.rows[0]?.reason ?? '', /founder.*seller favour|seller favour.*founder/iu)
  const sellerAccount = await readCityCreditAccount(db, 2, { limit: 50 })
  const sellerPrivateReceipt = sellerAccount.history.find(entry =>
    entry.kind === 'paypal_dispute_reviewed')
  assert.ok(sellerPrivateReceipt)
  assert.equal(sellerPrivateReceipt.amount_units, '0')
  assert.equal(sellerPrivateReceipt.credit_amount_units, sellerGift.amountUnits.toString())
  assert.equal(sellerPrivateReceipt.source_key, null)
  assert.equal(sellerPrivateReceipt.request_id, null)
  assert.match(sellerPrivateReceipt.reason ?? '', /seller favour/iu)
  const sellerInspection = (await readFounderPayPalCreditDisputes(db, 2))
    .find(item => item.dispute_id === sellerDisputeId)
  assert.ok(sellerInspection)
  assert.equal(sellerInspection.state, 'resolved_seller')
  assert.equal(sellerInspection.outcome_code, 'RESOLVED_WITH_PAYOUT')
  assert.equal(sellerInspection.founder_decision, 'seller_favour')
  assert.ok(sellerInspection.founder_reviewed_at)
  const sellerPublicEvents = await pool.query<{
    actor: string
    detail: Record<string, unknown>
  }>(`
      SELECT actor, detail FROM events WHERE kind = 'payment_repair'
      ORDER BY id
    `)
  assert.deepEqual(sellerPublicEvents.rows, [{
    actor: 'founder',
    detail: { action: 'credit_dispute_seller_favour' },
  }])

  const refusedGift = await deliveredGift(db, 3)
  assert.equal((await refuseCreditGift(db, {
    residentId: 3, giftId: refusedGift.giftId,
  })).status, 'refused')
  const buyerDisputeId = 'PP-D-FOUNDER-REVIEW-BUYER'
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-FOUNDER-REVIEW-BUYER',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: buyerDisputeId,
    captureId: refusedGift.captureId,
    updateTime: '2026-08-28T02:00:00.000Z',
    outcomeCode: 'NONE',
  }))
  const refusedDuringReview = await giftState(pool, refusedGift.giftId)
  assert.equal(refusedDuringReview.status, 'refused')
  assert.ok(refusedDuringReview.frozen_at)

  const buyerDecision = await resolveFounderPayPalCreditDispute(db, {
    founderId: 1,
    disputeId: buyerDisputeId,
    decision: 'buyer_favour',
  })
  assert.deepEqual(buyerDecision, {
    disputeId: buyerDisputeId,
    decision: 'buyer_favour',
    state: 'resolved_against_seller',
    applicationOutcome: 'founder_review_buyer_favour_applied',
    disposition: 'created',
    localPurchaseCount: 1,
    receiptsCreated: 1,
  })
  assert.equal((await giftState(pool, refusedGift.giftId)).status, 'revoked')
  const buyerReplay = await resolveFounderPayPalCreditDispute(db, {
    founderId: 1,
    disputeId: buyerDisputeId,
    decision: 'buyer_favour',
  })
  assert.deepEqual(buyerReplay, {
    ...buyerDecision,
    disposition: 'existing',
    receiptsCreated: 0,
  })
  await assert.rejects(resolveFounderPayPalCreditDispute(db, {
    founderId: 1,
    disputeId: buyerDisputeId,
    decision: 'seller_favour',
  }), /already has.*founder decision|opposite founder decision/iu)
  const buyerAccount = await readCityCreditAccount(db, 3, { limit: 50 })
  const buyerPrivateReceipt = buyerAccount.history.find(entry =>
    entry.kind === 'paypal_dispute_reviewed')
  assert.ok(buyerPrivateReceipt)
  assert.equal(buyerPrivateReceipt.amount_units, '0')
  assert.equal(buyerPrivateReceipt.credit_amount_units, refusedGift.amountUnits.toString())
  assert.equal(buyerPrivateReceipt.source_key, null)
  assert.equal(buyerPrivateReceipt.request_id, null)
  assert.match(buyerPrivateReceipt.reason ?? '', /buyer favour/iu)
  const buyerInspection = (await readFounderPayPalCreditDisputes(db, 3))
    .find(item => item.dispute_id === buyerDisputeId)
  assert.ok(buyerInspection)
  assert.equal(buyerInspection.state, 'resolved_against_seller')
  assert.equal(buyerInspection.outcome_code, 'NONE')
  assert.equal(buyerInspection.founder_decision, 'buyer_favour')
  assert.ok(buyerInspection.founder_reviewed_at)

  const acceptedGift = await deliveredGift(db, 2)
  assert.equal((await acceptCreditGift(db, {
    residentId: 2, giftId: acceptedGift.giftId,
  })).status, 'accepted')
  const balanceBeforeReview = await pool.query<{ balance_units: string }>(`
      SELECT balance_units::text AS balance_units
      FROM city_credit_accounts WHERE resident_id = 2
    `)
  const acceptedDisputeId = 'PP-D-FOUNDER-REVIEW-DELIVERED'
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-FOUNDER-REVIEW-DELIVERED',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: acceptedDisputeId,
    captureId: acceptedGift.captureId,
    updateTime: '2026-08-28T03:00:00.000Z',
    outcomeCode: 'RESOLVED_WITH_PAYOUT',
  }))
  assert.equal((await resolveFounderPayPalCreditDispute(db, {
    founderId: 1,
    disputeId: acceptedDisputeId,
    decision: 'buyer_favour',
  })).applicationOutcome, 'founder_review_buyer_favour_applied')
  assert.equal((await giftState(pool, acceptedGift.giftId)).status, 'accepted')
  const balanceAfterReview = await pool.query<{ balance_units: string }>(`
      SELECT balance_units::text AS balance_units
      FROM city_credit_accounts WHERE resident_id = 2
    `)
  assert.equal(balanceAfterReview.rows[0]?.balance_units,
    balanceBeforeReview.rows[0]?.balance_units)

  const wrongStateDisputes = [
    dispute({
      eventId: 'WH-FOUNDER-REVIEW-WRONG-OPEN',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-FOUNDER-REVIEW-WRONG-OPEN',
      captureIds: ['CAPTURE-FOUNDER-REVIEW-WRONG-OPEN'],
      updateTime: '2026-08-28T04:00:00.000Z',
    }),
    dispute({
      eventId: 'WH-FOUNDER-REVIEW-WRONG-SELLER',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: 'PP-D-FOUNDER-REVIEW-WRONG-SELLER',
      captureIds: ['CAPTURE-FOUNDER-REVIEW-WRONG-SELLER'],
      updateTime: '2026-08-28T05:00:00.000Z',
      outcomeCode: 'DENIED',
    }),
    dispute({
      eventId: 'WH-FOUNDER-REVIEW-WRONG-BUYER',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: 'PP-D-FOUNDER-REVIEW-WRONG-BUYER',
      captureIds: ['CAPTURE-FOUNDER-REVIEW-WRONG-BUYER'],
      updateTime: '2026-08-28T06:00:00.000Z',
      outcomeCode: 'ACCEPTED',
    }),
  ]
  for (const wrongState of wrongStateDisputes) {
    await applyPayPalCreditDispute(db, wrongState)
    await assert.rejects(resolveFounderPayPalCreditDispute(db, {
      founderId: 1,
      disputeId: wrongState.disputeId,
      decision: 'seller_favour',
    }), /not awaiting founder review/iu)
  }
  await assert.rejects(resolveFounderPayPalCreditDispute(db, {
    founderId: 1,
    disputeId: 'PP-D-FOUNDER-REVIEW-MISSING',
    decision: 'seller_favour',
  }), /not found/iu)

  const durableEvidence = await pool.query<{
    reviews: string
    receipts: string
    seller_public_events: string
    buyer_public_events: string
  }>(`
      SELECT
        (SELECT count(*) FROM paypal_credit_dispute_reviews
          WHERE dispute_id = ANY($1::text[]))::text AS reviews,
        (SELECT count(*) FROM city_credit_entries
          WHERE entry_kind = 'paypal_dispute_reviewed'
            AND paypal_dispute_id = ANY($1::text[]))::text AS receipts,
        (SELECT count(*) FROM events WHERE kind = 'payment_repair'
          AND detail = '{"action":"credit_dispute_seller_favour"}'::jsonb)::text
          AS seller_public_events,
        (SELECT count(*) FROM events WHERE kind = 'payment_repair'
          AND detail = '{"action":"credit_dispute_buyer_favour"}'::jsonb)::text
          AS buyer_public_events
    `, [[sellerDisputeId, buyerDisputeId, acceptedDisputeId]])
  assert.deepEqual(durableEvidence.rows[0], {
    reviews: '3', receipts: '3',
    seller_public_events: '1', buyer_public_events: '2',
  })
  const publicDetails = await pool.query<{ detail: Record<string, unknown> }>(`
      SELECT detail FROM events WHERE kind = 'payment_repair' ORDER BY id
    `)
  assert.deepEqual(publicDetails.rows.map(row => row.detail), [
    { action: 'credit_dispute_seller_favour' },
    { action: 'credit_dispute_buyer_favour' },
    { action: 'credit_dispute_buyer_favour' },
  ])

}
