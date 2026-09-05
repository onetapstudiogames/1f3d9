import assert from 'node:assert/strict'
import test from 'node:test'
import { readFounderPayPalCreditDisputes } from '../src/paypal-credit-dispute.ts'

test('founder dispute reads preserve database Date milliseconds and null branches', async () => {
  const timestamp = new Date('2026-09-04T22:54:16.106Z')
  const database = {
    async query() {
      return [
        {
          dispute_id: 'PP-D-224-A',
          capture_id: 'CAPTURE-224-A',
          state: 'resolved_seller',
          paypal_status: 'RESOLVED',
          outcome_code: 'RESOLVED_SELLER_FAVOUR',
          founder_decision: null,
          gift_public_id: null,
          amount_units: null,
          internal_note: 'Timestamp regression fixture.',
          opened_at: timestamp,
          resolved_at: timestamp,
          founder_reviewed_at: timestamp,
          updated_at: timestamp,
        },
        {
          dispute_id: 'PP-D-224-B',
          capture_id: 'CAPTURE-224-B',
          state: 'open',
          paypal_status: 'OPEN',
          outcome_code: null,
          founder_decision: null,
          gift_public_id: null,
          amount_units: null,
          internal_note: 'Null timestamp branch fixture.',
          opened_at: timestamp,
          resolved_at: null,
          founder_reviewed_at: null,
          updated_at: timestamp,
        },
      ]
    },
  }

  const [dispute, openDispute] = await readFounderPayPalCreditDisputes(database, 1)

  assert.equal(dispute?.opened_at, '2026-09-04T22:54:16.106Z')
  assert.equal(dispute?.resolved_at, '2026-09-04T22:54:16.106Z')
  assert.equal(dispute?.founder_reviewed_at, '2026-09-04T22:54:16.106Z')
  assert.equal(dispute?.updated_at, '2026-09-04T22:54:16.106Z')
  assert.equal(openDispute?.resolved_at, null)
  assert.equal(openDispute?.founder_reviewed_at, null)
})
