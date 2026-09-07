import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { setTimeout as delay } from 'node:timers/promises'
import type { PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'
import { applyPayPalCreditDispute } from '../../../src/paypal-credit-dispute.ts'
import { captureLock } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-races.ts'
import {
  deliverPreparedGift,
  deliveredGift,
  giftState,
  prepareGift,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts'
import { dispute } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'
import { database } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-environment.ts'

export async function registerCaptureRacesTests(
  pool: Pool,
  db: PayPalCreditStoreDatabase,
): Promise<void> {
  const replayGift = await deliveredGift(db, 2)
  const replayed = dispute({
    eventId: 'WH-DISPUTE-CONCURRENT-REPLAY',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: 'PP-D-CONCURRENT-REPLAY',
    captureId: replayGift.captureId,
    updateTime: '2026-08-27T18:00:00.000Z',
  })
  const first = await pool.connect()
  const second = await pool.connect()
  try {
    const results = await Promise.all([
      applyPayPalCreditDispute(database(first), replayed),
      applyPayPalCreditDispute(database(second), replayed),
    ])
    assert.deepEqual(results.map(result => result.disposition).sort(),
      ['created', 'existing'])
    assert.ok(results.every(result =>
      result.applicationOutcome === 'dispute_open_gift_frozen'))
  } finally {
    first.release()
    second.release()
  }
  const replayEvidence = await pool.query<{
    events: string
    receipts: string
    notes: string
  }>(`
      SELECT
        (SELECT count(*) FROM paypal_credit_dispute_events
          WHERE dispute_id = $1)::text AS events,
        (SELECT count(*) FROM city_credit_entries
          WHERE paypal_dispute_id = $1)::text AS receipts,
        (SELECT count(*) FROM founder_city_credit_notes
          WHERE dispute_id = $1)::text AS notes
    `, [replayed.disputeId])
  assert.deepEqual(replayEvidence.rows[0], {
    events: '1', receipts: '1', notes: '1',
  })

  const disputeFirst = await prepareGift(db, 2, 'CAPTURE-RACE-DISPUTE-FIRST')
  const disputeLock = await pool.connect()
  const delayedDelivery = await pool.connect()
  try {
    await captureLock(disputeLock, disputeFirst.captureId)
    const deliveryPromise = deliverPreparedGift(database(delayedDelivery), disputeFirst)
    await delay(100)
    const staged = await applyPayPalCreditDispute(database(disputeLock), dispute({
      eventId: 'WH-DISPUTE-RACE-DISPUTE-FIRST',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-RACE-DISPUTE-FIRST',
      captureId: disputeFirst.captureId,
      updateTime: '2026-08-27T19:00:00.000Z',
    }))
    assert.equal(staged.applicationOutcome, 'dispute_awaiting_capture_receipt')
    await disputeLock.query('COMMIT')
    const delivered = await deliveryPromise
    assert.equal(delivered.status, 'frozen')
  } finally {
    await disputeLock.query('ROLLBACK').catch(() => undefined)
    disputeLock.release()
    delayedDelivery.release()
  }

  const captureFirst = await prepareGift(db, 3, 'CAPTURE-RACE-CAPTURE-FIRST')
  const captureFirstLock = await pool.connect()
  const delayedDispute = await pool.connect()
  try {
    await captureLock(captureFirstLock, captureFirst.captureId)
    const disputePromise = applyPayPalCreditDispute(database(delayedDispute), dispute({
      eventId: 'WH-DISPUTE-RACE-CAPTURE-FIRST',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-RACE-CAPTURE-FIRST',
      captureId: captureFirst.captureId,
      updateTime: '2026-08-27T20:00:00.000Z',
    }))
    await delay(100)
    const delivered = await deliverPreparedGift(database(captureFirstLock), captureFirst)
    assert.equal(delivered.status, 'pending')
    await captureFirstLock.query('COMMIT')
    assert.equal((await disputePromise).applicationOutcome,
      'dispute_open_gift_frozen')
    assert.equal((await giftState(pool, delivered.giftId)).status, 'frozen')
  } finally {
    await captureFirstLock.query('ROLLBACK').catch(() => undefined)
    captureFirstLock.release()
    delayedDispute.release()
  }

  const raceEvidence = await pool.query<{ bad: string }>(`
      SELECT count(*)::text AS bad FROM (
        SELECT event.dispute_id, count(receipt.id) AS receipts
        FROM paypal_credit_dispute_events event
        JOIN city_credit_entries receipt
          ON receipt.paypal_event_id = event.paypal_event_id
        WHERE event.dispute_id IN (
          'PP-D-RACE-DISPUTE-FIRST', 'PP-D-RACE-CAPTURE-FIRST'
        )
        GROUP BY event.dispute_id
        HAVING count(receipt.id) <> 1
      ) invalid
    `)
  assert.equal(raceEvidence.rows[0]?.bad, '0')

}
