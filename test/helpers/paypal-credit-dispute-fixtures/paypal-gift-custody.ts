import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { deliverPayPalCredit } from '../../../src/paypal-credit-delivery.ts'
import { attachPayPalOrder, beginPayPalCreditIntent, type PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'

let sequence = 0

export async function prepareGift(
  db: PayPalCreditStoreDatabase,
  recipientId = 2,
  requestedCaptureId?: string,
) {
  sequence += 1
  const suffix = String(sequence).padStart(4, '0')
  const amountUnits = 3_000_000n
  const captureId = requestedCaptureId ?? `CAPTURE-DISPUTE-${suffix}`
  const intent = await beginPayPalCreditIntent(db, {
    requestId: `postgres-dispute-gift-${suffix}`,
    intentKind: 'order',
    delivery: 'gift',
    recipientId,
    amountUnits,
    paypalEnvironment: 'sandbox',
  })
  assert.ok(intent.claimToken)
  const attached = await attachPayPalOrder(db, {
    purchaseId: intent.purchaseId,
    orderId: `ORDER-DISPUTE-${suffix}`,
  })
  return Object.freeze({
    deliveryIntent: Object.freeze({
      ...intent, ...attached, remoteOrderId: attached.orderId,
    }),
    captureId,
    claimToken: intent.claimToken,
    amountUnits,
  })
}

type PreparedGift = Awaited<ReturnType<typeof prepareGift>>

export async function deliverPreparedGift(
  db: PayPalCreditStoreDatabase,
  prepared: PreparedGift,
) {
  const delivered = await deliverPayPalCredit(db, {
    intent: prepared.deliveryIntent,
    sourceKey: `paypal:capture:${prepared.captureId}`,
    purchaseKind: 'paypal',
    eventId: `api-capture:${prepared.deliveryIntent.purchaseId}`,
    eventKind: 'PAYMENT.CAPTURE.COMPLETED',
    remoteResourceId: prepared.captureId,
  })
  return Object.freeze({
    giftId: String(delivered.gift_id),
    claimToken: prepared.claimToken,
    captureId: prepared.captureId,
    amountUnits: prepared.amountUnits,
    status: String(delivered.status),
  })
}

export async function deliveredGift(
  db: PayPalCreditStoreDatabase,
  recipientId = 2,
  captureId?: string,
) {
  return await deliverPreparedGift(db, await prepareGift(db, recipientId, captureId))
}

export async function giftState(pool: Pool, giftId: string) {
  const result = await pool.query<{
    status: string
    recipient_id: number
    version: number
    refused_at: Date | null
    frozen_at: Date | null
    revoked_at: Date | null
  }>(`
    SELECT status, recipient_id, version, refused_at, frozen_at, revoked_at
    FROM city_credit_gifts WHERE public_id = $1
  `, [giftId])
  assert.equal(result.rows.length, 1)
  return result.rows[0]!
}

export async function legacyGiftAction(
  pool: Pool,
  input: Readonly<{
    giftId: string
    residentId: number
    action: 'accept' | 'refuse'
  }>,
): Promise<void> {
  const status = input.action === 'accept' ? 'accepted' : 'refused'
  const entryKind = input.action === 'accept' ? 'gift_accept' : 'gift_refuse'
  const timestampColumn = input.action === 'accept' ? 'accepted_at' : 'refused_at'
  const result = await pool.query(`
    WITH changed AS MATERIALIZED (
      UPDATE city_credit_gifts gift
      SET status = $3::text, ${timestampColumn} = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE gift.public_id = $1::text AND gift.recipient_id = $2::integer
        AND gift.status = 'pending'
      RETURNING gift.*
    ), receipt AS (
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, source_key, gift_id
      )
      SELECT changed.recipient_id, $4::text, changed.amount_units,
        'gift:' || changed.public_id || ':${input.action}:' || changed.version::text,
        changed.id
      FROM changed RETURNING id
    )
    SELECT count(*)::integer AS changed FROM changed
  `, [input.giftId, input.residentId, status, entryKind])
  assert.equal(result.rows[0]?.changed, 1)
}
