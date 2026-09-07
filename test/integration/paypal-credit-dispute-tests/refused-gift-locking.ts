import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { setTimeout as delay } from 'node:timers/promises'
import type { PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'
import {
  acceptCreditGift,
  redirectCreditGift,
  refuseCreditGift,
} from '../../../src/prepaid-credit.ts'
import { applyPayPalCreditDispute } from '../../../src/paypal-credit-dispute.ts'
import {
  deliveredGift,
  giftState,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts'
import { dispute } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'
import { database } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-environment.ts'

export async function registerRefusedGiftLockingTests(
  pool: Pool,
  db: PayPalCreditStoreDatabase,
): Promise<void> {
  const refused = await deliveredGift(db, 2)
  await refuseCreditGift(db, { residentId: 2, giftId: refused.giftId })
  const beforeOpen = await giftState(pool, refused.giftId)
  const opened = dispute({
    eventId: 'WH-DISPUTE-REFUSED-OPEN',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: 'PP-D-REFUSED-0001',
    captureId: refused.captureId,
    updateTime: '2026-08-27T18:00:00.000Z',
  })
  assert.equal((await applyPayPalCreditDispute(db, opened)).applicationOutcome,
    'dispute_open_refused_gift_blocked')
  const blocked = await giftState(pool, refused.giftId)
  assert.equal(blocked.status, 'refused')
  assert.equal(blocked.version, beforeOpen.version)
  assert.equal(blocked.refused_at?.toISOString(), beforeOpen.refused_at?.toISOString())
  assert.ok(blocked.frozen_at)
  await assert.rejects(redirectCreditGift(db, {
    giftId: refused.giftId,
    claimToken: refused.claimToken,
    residentId: 3,
    requestId: 'postgres-refused-blocked-redirect',
  }), /payment dispute is open.*purchase that funded/iu)
  assert.equal((await refuseCreditGift(db, {
    residentId: 2, giftId: refused.giftId,
  })).status, 'refused')

  const sellerResolved = dispute({
    eventId: 'WH-DISPUTE-REFUSED-SELLER',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: opened.disputeId,
    captureIds: opened.captureIds,
    updateTime: '2026-08-27T19:00:00.000Z',
    outcomeCode: 'DENIED',
  })
  assert.equal((await applyPayPalCreditDispute(db, sellerResolved)).applicationOutcome,
    'dispute_resolved_refused_gift')
  const unblocked = await giftState(pool, refused.giftId)
  assert.equal(unblocked.status, 'refused')
  assert.equal(unblocked.frozen_at, null)
  assert.equal((await redirectCreditGift(db, {
    giftId: refused.giftId,
    claimToken: refused.claimToken,
    residentId: 3,
    requestId: 'postgres-refused-unblocked-redirect',
  })).status, 'pending')

  const adverse = await deliveredGift(db, 2)
  await refuseCreditGift(db, { residentId: 2, giftId: adverse.giftId })
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-DISPUTE-REFUSED-ADVERSE',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: 'PP-D-REFUSED-ADVERSE',
    captureId: adverse.captureId,
    updateTime: '2026-08-27T20:00:00.000Z',
    outcomeCode: 'ACCEPTED',
  }))
  assert.equal((await giftState(pool, adverse.giftId)).status, 'revoked')

  const frozenThenRefused = await deliveredGift(db, 2)
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-DISPUTE-FROZEN-REFUSAL',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: 'PP-D-FROZEN-REFUSAL',
    captureId: frozenThenRefused.captureId,
    updateTime: '2026-08-27T20:30:00.000Z',
  }))
  await assert.rejects(acceptCreditGift(db, {
    residentId: 2, giftId: frozenThenRefused.giftId,
  }), /payment dispute is open/iu)
  assert.equal((await refuseCreditGift(db, {
    residentId: 2, giftId: frozenThenRefused.giftId,
  })).status, 'refused')
  const refusedWhileOpen = await giftState(pool, frozenThenRefused.giftId)
  assert.equal(refusedWhileOpen.status, 'refused')
  assert.ok(refusedWhileOpen.frozen_at)

  const disputeWins = await deliveredGift(db, 2)
  await refuseCreditGift(db, { residentId: 2, giftId: disputeWins.giftId })
  const disputeConnection = await pool.connect()
  const redirectConnection = await pool.connect()
  try {
    await disputeConnection.query('BEGIN')
    await disputeConnection.query(
      'SELECT id FROM city_credit_gifts WHERE public_id = $1 FOR UPDATE',
      [disputeWins.giftId],
    )
    const redirectRejected = assert.rejects(redirectCreditGift(
      database(redirectConnection), {
        giftId: disputeWins.giftId,
        claimToken: disputeWins.claimToken,
        residentId: 3,
        requestId: 'postgres-refused-race-dispute-wins',
      }), /payment dispute is open.*purchase that funded/iu)
    await delay(100)
    await applyPayPalCreditDispute(database(disputeConnection), dispute({
      eventId: 'WH-DISPUTE-REFUSED-RACE-WINS',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-REFUSED-RACE-WINS',
      captureId: disputeWins.captureId,
      updateTime: '2026-08-27T21:00:00.000Z',
    }))
    await disputeConnection.query('COMMIT')
    await redirectRejected
  } finally {
    await disputeConnection.query('ROLLBACK').catch(() => undefined)
    disputeConnection.release()
    redirectConnection.release()
  }

  const redirectWins = await deliveredGift(db, 2)
  await refuseCreditGift(db, { residentId: 2, giftId: redirectWins.giftId })
  const redirectLock = await pool.connect()
  const waitingDispute = await pool.connect()
  try {
    await redirectLock.query('BEGIN')
    await redirectLock.query(
      'SELECT id FROM city_credit_gifts WHERE public_id = $1 FOR UPDATE',
      [redirectWins.giftId],
    )
    const disputePromise = applyPayPalCreditDispute(database(waitingDispute), dispute({
      eventId: 'WH-DISPUTE-REFUSED-RACE-REDIRECT',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-REFUSED-RACE-REDIRECT',
      captureId: redirectWins.captureId,
      updateTime: '2026-08-27T22:00:00.000Z',
    }))
    await delay(100)
    assert.equal((await redirectCreditGift(database(redirectLock), {
      giftId: redirectWins.giftId,
      claimToken: redirectWins.claimToken,
      residentId: 3,
      requestId: 'postgres-refused-race-redirect-wins',
    })).status, 'pending')
    await redirectLock.query('COMMIT')
    assert.equal((await disputePromise).applicationOutcome,
      'dispute_open_gift_frozen')
    const protectedTarget = await giftState(pool, redirectWins.giftId)
    assert.equal(protectedTarget.recipient_id, 3)
    assert.equal(protectedTarget.status, 'frozen')
  } finally {
    await redirectLock.query('ROLLBACK').catch(() => undefined)
    redirectLock.release()
    waitingDispute.release()
  }

}
