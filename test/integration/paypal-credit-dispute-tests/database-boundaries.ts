import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type { PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'
import {
  deliverPreparedGift,
  prepareGift,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts'
import { rawApply } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'

export async function registerDatabaseBoundariesTests(
  pool: Pool,
  db: PayPalCreditStoreDatabase,
): Promise<void> {
  const invalidCases = [
    { eventId: 'WH-INVALID-EMPTY', disputeId: 'PP-D-INVALID-EMPTY', captureIds: [] },
    {
      eventId: 'WH-INVALID-DUPLICATE', disputeId: 'PP-D-INVALID-DUPLICATE',
      captureIds: ['CAPTURE-DUPLICATE', 'CAPTURE-DUPLICATE'],
    },
    {
      eventId: 'WH-INVALID-UNSORTED', disputeId: 'PP-D-INVALID-UNSORTED',
      captureIds: ['CAPTURE-Z', 'CAPTURE-A'],
    },
    {
      eventId: 'WH-INVALID-TOO-MANY', disputeId: 'PP-D-INVALID-TOO-MANY',
      captureIds: Array.from({ length: 1_001 }, (_, index) => (
        `CAPTURE-${String(index).padStart(4, '0')}`
      )),
    },
  ]
  for (const invalid of invalidCases) {
    await assert.rejects(rawApply(pool, invalid), /PayPal dispute event input is invalid/iu)
  }
  await assert.rejects(rawApply(pool, {
    eventId: `W${'H'.repeat(128)}`,
    disputeId: 'PP-D-INVALID-EVENT-LENGTH',
    captureIds: ['CAPTURE-VALID'],
  }), /PayPal dispute event input is invalid/iu)

  const maxCaptureId = `C${'X'.repeat(254)}`
  const maxDisputeId = `D${'Y'.repeat(254)}`
  const prepared = await prepareGift(db, 2, maxCaptureId)
  const staged = await rawApply(pool, {
    eventId: 'WH-MAXIMUM-ID-BOUNDARY',
    disputeId: maxDisputeId,
    captureIds: [maxCaptureId],
  })
  assert.equal(staged.rows[0]?.application_outcome,
    'dispute_awaiting_capture_receipt')
  const delivered = await deliverPreparedGift(db, prepared)
  assert.equal(delivered.status, 'frozen')
  const stored = await pool.query<{
    dispute_length: number
    capture_length: number
    source_length: number
    receipts: string
  }>(`
      SELECT octet_length(dispute.dispute_id) AS dispute_length,
        octet_length(event.transaction_capture_ids[1]) AS capture_length,
        octet_length(purchase.source_key) AS source_length,
        (SELECT count(*) FROM city_credit_entries receipt
          WHERE receipt.paypal_dispute_id = dispute.dispute_id)::text AS receipts
      FROM paypal_credit_disputes dispute
      JOIN paypal_credit_dispute_events event
        ON event.dispute_id = dispute.dispute_id
      JOIN paypal_credit_events capture
        ON capture.remote_resource_id = event.transaction_capture_ids[1]
      JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
      WHERE dispute.dispute_id = $1
    `, [maxDisputeId])
  assert.deepEqual(stored.rows[0], {
    dispute_length: 255,
    capture_length: 255,
    source_length: 270,
    receipts: '1',
  })

}
