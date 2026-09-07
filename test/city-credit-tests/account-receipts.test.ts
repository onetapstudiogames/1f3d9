import assert from 'node:assert/strict'
import test from 'node:test'
import { readCityCreditAccount } from '../../src/city-credit.ts'
import { MarkerDatabase } from '../helpers/city-credit-fixtures/ledger-database.ts'
import { SOURCE_KEY, CREATED_AT, REQUEST_ID } from '../helpers/city-credit-fixtures/ledger-entries.ts'

export function registerAccountReceiptsTests(): void {
  test('account reads expose exact decimal and integer strings, including signed history', async () => {
    const hugeBalance = '9007199254740993000000'
    const database = new MarkerDatabase({
      'read-account': [[{
        resident_id: 7,
        balance_units: hugeBalance,
        history: [
          {
            id: '9223372036854775805', entry_kind: 'founder_issue',
            amount_units: '1000000', source_key: SOURCE_KEY,
            request_id: null, operation: null, target_key: null,
            related_spend_id: null, reason: 'extra finalized city payment',
            created_at: new Date('2026-08-22T12:00:00.106Z'),
          },
          {
            id: '9223372036854775806', entry_kind: 'spend',
            amount_units: '1000000', source_key: null,
            request_id: REQUEST_ID, operation: 'frontier', target_key: 'frontier:TheBlueAI',
            related_spend_id: null, reason: null,
            created_at: '2026-08-22T12:01:00.000Z',
          },
          {
            id: '9223372036854775807', entry_kind: 'return',
            amount_units: '1000000', source_key: null,
            request_id: REQUEST_ID, operation: 'frontier', target_key: 'frontier:TheBlueAI',
            related_spend_id: '9223372036854775806', reason: 'target became unavailable',
            created_at: '2026-08-22T12:02:00.000Z',
          },
        ],
      }]],
    })

    const account = await readCityCreditAccount(database, 7)

    assert.equal(account.balance, '9007199254740993.000000')
    assert.equal(account.balance_units, hugeBalance)
    assert.deepEqual(account.history.map(entry => ({
      id: entry.id,
      kind: entry.kind,
      amount: entry.amount,
      amount_units: entry.amount_units,
    })), [
      { id: '9223372036854775805', kind: 'founder_issue', amount: '1.000000', amount_units: '1000000' },
      { id: '9223372036854775806', kind: 'spend', amount: '-1.000000', amount_units: '-1000000' },
      { id: '9223372036854775807', kind: 'return', amount: '1.000000', amount_units: '1000000' },
    ])
    assert.equal(typeof account.balance, 'string')
    assert.equal(account.history[0]?.created_at, '2026-08-22T12:00:00.106Z')
    assert.ok(account.history.every(entry => (
      typeof entry.id === 'string'
        && typeof entry.amount === 'string'
        && typeof entry.amount_units === 'string'
    )))
    assert.doesNotThrow(() => JSON.stringify(account))
    assert.equal(database.calls[0]?.marker, 'read-account')
    assert.deepEqual(database.calls[0]?.params, [7])
  })

  test('account receipts show exact purchase and gift events without exposing payment source keys', async () => {
    const giftId = `city_gift_${'ab'.repeat(16)}`
    const rows = [
      { id: '201', entry_kind: 'purchase', amount_units: '3000000', source_key: 'paypal:capture:private-001', purchase_kind: 'paypal', gift_public_id: null, operation: null },
      { id: '202', entry_kind: 'purchase', amount_units: '2000000', source_key: 'paypal:capture:private-002', purchase_kind: 'paypal', gift_public_id: giftId, operation: null },
      { id: '203', entry_kind: 'gift_pending', amount_units: '2000000', source_key: 'gift:private:pending', purchase_kind: null, gift_public_id: giftId, operation: null },
      { id: '204', entry_kind: 'gift_accept', amount_units: '2000000', source_key: 'gift:private:accept', purchase_kind: null, gift_public_id: giftId, operation: null },
      { id: '205', entry_kind: 'gift_refuse', amount_units: '2000000', source_key: 'gift:private:refuse', purchase_kind: null, gift_public_id: giftId, operation: null },
      { id: '206', entry_kind: 'gift_redirect', amount_units: '2000000', source_key: 'gift:private:redirect', purchase_kind: null, gift_public_id: giftId, operation: null },
      { id: '207', entry_kind: 'purchase', amount_units: '7000000', source_key: 'x402:credit:private-transaction', purchase_kind: 'x402', gift_public_id: null, operation: 'credit_purchase' },
    ].map(row => ({
      ...row,
      request_id: row.entry_kind === 'gift_redirect' ? 'private-buyer-alias-0001' : null,
      target_key: null,
      related_spend_id: null,
      reason: null,
      created_at: CREATED_AT,
    }))
    const database = new MarkerDatabase({
      'read-account': [[{ resident_id: 7, balance_units: '12000000', history: rows }]],
    })

    const account = await readCityCreditAccount(database, 7)

    assert.deepEqual(account.history.map(receipt => ({
      kind: receipt.kind,
      amount_units: receipt.amount_units,
      credit_amount_units: receipt.credit_amount_units,
      source_key: receipt.source_key,
      purchase_kind: receipt.purchase_kind,
      gift_id: receipt.gift_id,
      operation: receipt.operation,
    })), [
      { kind: 'purchase', amount_units: '3000000', credit_amount_units: '3000000', source_key: null, purchase_kind: 'paypal', gift_id: null, operation: null },
      { kind: 'purchase', amount_units: '0', credit_amount_units: '2000000', source_key: null, purchase_kind: 'paypal', gift_id: giftId, operation: null },
      { kind: 'gift_pending', amount_units: '0', credit_amount_units: '2000000', source_key: null, purchase_kind: null, gift_id: giftId, operation: null },
      { kind: 'gift_accept', amount_units: '2000000', credit_amount_units: '2000000', source_key: null, purchase_kind: null, gift_id: giftId, operation: null },
      { kind: 'gift_refuse', amount_units: '0', credit_amount_units: '2000000', source_key: null, purchase_kind: null, gift_id: giftId, operation: null },
      { kind: 'gift_redirect', amount_units: '0', credit_amount_units: '2000000', source_key: null, purchase_kind: null, gift_id: giftId, operation: null },
      { kind: 'purchase', amount_units: '7000000', credit_amount_units: '7000000', source_key: null, purchase_kind: 'x402', gift_id: null, operation: 'credit_purchase' },
    ])
    assert.ok(account.history.every(receipt => receipt.request_id === null))
    assert.doesNotMatch(JSON.stringify(account), /private-buyer-alias/iu)
  })
}
