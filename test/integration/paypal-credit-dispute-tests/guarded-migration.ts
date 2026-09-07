import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { applyPayPalCreditDispute } from '../../../src/paypal-credit-dispute.ts'
import {
  deliveredGift,
  giftState,
  legacyGiftAction,
} from '../../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts'
import { dispute } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-events.ts'
import { database } from '../../helpers/paypal-credit-dispute-fixtures/paypal-dispute-environment.ts'

export async function registerGuardedMigrationTests(
  postgres: Readonly<{ pool: Pool; containerName: string }>,
  preDisputeSchemaDdl: string,
  disputeMigrationDdl: string,
): Promise<void> {
  await postgres.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await postgres.pool.query(preDisputeSchemaDdl)
  await postgres.pool.query(`
      INSERT INTO residents (id, handle, model, secret_hash) VALUES
        (1, 'founder', 'paypal-dispute-upgrade', repeat('1', 64)),
        (2, 'recipient-two', 'paypal-dispute-upgrade', repeat('2', 64)),
        (3, 'recipient-three', 'paypal-dispute-upgrade', repeat('3', 64))
    `)
  const db = database(postgres.pool)
  const pending = await deliveredGift(db, 2)
  const accepted = await deliveredGift(db, 2)
  const refused = await deliveredGift(db, 3)
  await legacyGiftAction(postgres.pool, {
    residentId: 2, giftId: accepted.giftId, action: 'accept',
  })
  await legacyGiftAction(postgres.pool, {
    residentId: 3, giftId: refused.giftId, action: 'refuse',
  })

  await postgres.pool.query(disputeMigrationDdl)
  await postgres.pool.query(disputeMigrationDdl)
  const upgraded = await postgres.pool.query<{
    public_id: string
    status: string
    frozen_at: Date | null
    revoked_at: Date | null
  }>(`
      SELECT public_id, status, frozen_at, revoked_at
      FROM city_credit_gifts WHERE public_id = ANY($1::text[])
    `, [[pending.giftId, accepted.giftId, refused.giftId]])
  const stateByGift = new Map(upgraded.rows.map(row => [row.public_id, row]))
  assert.deepEqual(
    [pending.giftId, accepted.giftId, refused.giftId]
      .map(giftId => stateByGift.get(giftId)?.status),
    ['pending', 'accepted', 'refused'],
  )
  assert.ok(upgraded.rows.every(row => row.frozen_at === null && row.revoked_at === null))

  await applyPayPalCreditDispute(db, dispute({
    eventId: 'WH-DISPUTE-UPGRADE-CREATED',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: 'PP-D-UPGRADE-0001',
    captureId: pending.captureId,
    updateTime: '2026-08-27T17:00:00.000Z',
  }))
  assert.equal((await giftState(postgres.pool, pending.giftId)).status, 'frozen')
  assert.equal((await giftState(postgres.pool, accepted.giftId)).status, 'accepted')
  assert.equal((await giftState(postgres.pool, refused.giftId)).status, 'refused')

}
