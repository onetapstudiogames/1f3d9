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
import { dispute } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'

export async function registerMultiCaptureReceiptsTests(
  pool: Pool,
  db: PayPalCreditStoreDatabase,
): Promise<void> {
  const first = await deliveredGift(db, 2)
  const second = await deliveredGift(db, 3)
  const late = await prepareGift(db, 2, 'CAPTURE-DISPUTE-LATE-MATRIX')
  const captureIds = [first.captureId, second.captureId, late.captureId].sort()
  const created = dispute({
    eventId: 'WH-DISPUTE-MATRIX-CREATED',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: 'PP-D-MATRIX-0001',
    captureIds,
    updateTime: '2026-08-27T18:00:00.000Z',
  })
  const firstApply = await applyPayPalCreditDispute(db, created)
  assert.equal(firstApply.applicationOutcome,
    'dispute_partially_applied_awaiting_capture_receipt')
  assert.equal(firstApply.transactionCount, 3)
  assert.equal(firstApply.localPurchaseCount, 2)
  assert.equal(firstApply.receiptsCreated, 2)
  assert.equal((await giftState(pool, first.giftId)).status, 'frozen')
  assert.equal((await giftState(pool, second.giftId)).status, 'frozen')
  assert.equal((await applyPayPalCreditDispute(db, created)).disposition, 'existing')

  const lateDelivery = await deliverPreparedGift(db, late)
  assert.equal(lateDelivery.status, 'frozen')
  const reconciledReplay = await applyPayPalCreditDispute(db, created)
  assert.equal(reconciledReplay.applicationOutcome, 'dispute_open_gifts_frozen')
  assert.equal(reconciledReplay.localPurchaseCount, 3)
  assert.equal(reconciledReplay.receiptsCreated, 0)

  const updated = dispute({
    eventId: 'WH-DISPUTE-MATRIX-UPDATED',
    eventKind: 'CUSTOMER.DISPUTE.UPDATED',
    disputeId: created.disputeId,
    captureIds,
    updateTime: '2026-08-27T19:00:00.000Z',
  })
  const updateApply = await applyPayPalCreditDispute(db, updated)
  assert.equal(updateApply.applicationOutcome, 'dispute_open_gifts_frozen')
  assert.equal(updateApply.receiptsCreated, 3)

  const evidence = await pool.query<{
    disputes: string
    events: string
    receipts: string
    notes: string
    capture_ids: string[]
  }>(`
      SELECT
        (SELECT count(*) FROM paypal_credit_disputes)::text AS disputes,
        (SELECT count(*) FROM paypal_credit_dispute_events)::text AS events,
        (SELECT count(*) FROM city_credit_entries
          WHERE paypal_dispute_id = $1)::text AS receipts,
        (SELECT count(*) FROM founder_city_credit_notes
          WHERE dispute_id = $1)::text AS notes,
        (SELECT transaction_capture_ids FROM paypal_credit_dispute_events
          WHERE paypal_event_id = $2) AS capture_ids
    `, [created.disputeId, created.eventId])
  assert.deepEqual(evidence.rows[0], {
    disputes: '1', events: '2', receipts: '6', notes: '1', capture_ids: captureIds,
  })
  const note = await pool.query<{ body: string }>(`
      SELECT body FROM founder_city_credit_notes WHERE dispute_id = $1
    `, [created.disputeId])
  assert.match(note.rows[0]?.body ?? '', /Verified PayPal dispute PP-D-MATRIX-0001/iu)
  assert.doesNotMatch(note.rows[0]?.body ?? '', /capture|resident|buyer|payer|amount/iu)
  const inspection = await readFounderPayPalCreditDisputes(db, 2)
  assert.equal(inspection.filter(item => item.dispute_id === created.disputeId).length, 2)
  assert.ok(inspection.every(item => item.internal_note === note.rows[0]?.body))

}
