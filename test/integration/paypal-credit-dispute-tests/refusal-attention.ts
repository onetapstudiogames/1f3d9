import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type { PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'
import { applyPayPalCreditDispute } from '../../../src/paypal-credit-dispute.ts'
import {
  cityCreditAttentionLines,
  readCityCreditAttention,
  readCityCreditPreflight,
} from '../../../src/city-credit.ts'
import {
  deliveredGift,
  giftState,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts'
import { dispute } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'
import {
  readPendingCreditGifts,
} from '../../../src/prepaid-credit.ts'

export async function registerRefusalAttentionTests(
  pool: Pool,
  db: PayPalCreditStoreDatabase,
): Promise<void> {
  await readCityCreditAttention(db, 2)
  const delivered = await deliveredGift(db, 2, 'CAPTURE-AWARENESS-FROZEN-0001')
  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-AWARENESS-FROZEN-CREATED',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: 'PP-D-AWARENESS-FROZEN-0001',
    captureId: delivered.captureId,
    updateTime: '2026-09-01T18:00:00.000Z',
  }))

  assert.equal((await giftState(pool, delivered.giftId)).status, 'frozen')
  const gifts = await readPendingCreditGifts(db, 2, { beforeId: null, limit: 50 })
  assert.deepEqual(gifts.items.map(gift => ({
    gift_id: gift.gift_id,
    status: gift.status,
    next_actions: gift.next_actions,
  })), [{
    gift_id: delivered.giftId,
    status: 'frozen',
    next_actions: {
      refuse: `POST /api/city-credit/gifts/${delivered.giftId}/refuse`,
    },
  }])
  assert.equal((await readCityCreditPreflight(db, 2)).pending_gifts_count, 1)
  assert.deepEqual(cityCreditAttentionLines(await readCityCreditAttention(db, 2)), [
    'You have 1 dispute-frozen 1F3D9 fee-credit gift awaiting refuse; see city_fee_credit.pending_gifts.',
  ])

}
