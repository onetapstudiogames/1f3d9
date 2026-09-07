import assert from 'node:assert/strict'
import test from 'node:test'
import { cityCreditAttentionLines, cityCreditSinceLastVisit, readCityCreditAttention, readCityCreditPreflight } from '../../src/city-credit.ts'
import { MarkerDatabase } from '../helpers/city-credit-fixtures/ledger-database.ts'

export function registerPreflightAndMeReadsTests(): void {
  test('preflight shows exact cost, pending-or-frozen gift count, and before/after balance without a debit', async () => {
    const database = new MarkerDatabase({
      preflight: [[{
        balance_units: '3000000',
        pending_gifts_count: '2',
        observed_at: '2026-08-26T23:30:00.000Z',
      }]],
    })
    const result = await readCityCreditPreflight(database, 7)
    assert.deepEqual(result, {
      resident_id: 7,
      fee_cost: '1.000000',
      fee_cost_units: '1000000',
      balance_before: '3.000000',
      balance_before_units: '3000000',
      balance_after: '2.000000',
      balance_after_units: '2000000',
      pending_gifts_count: 2,
      can_confirm: true,
      observed_at: '2026-08-26T23:30:00.000Z',
      applies_to: [
        'frontier', 'kind_invention', 'kind_revision',
        'place_rename', 'place_retire', 'place_restore',
      ],
      freshness: 'read_only_snapshot',
    })
    assert.equal(database.calls.length, 1)
    assert.match(database.calls[0]!.text, /gift\.status IN \('pending', 'frozen'\)/iu)
    assert.doesNotMatch(database.calls[0]!.text, /\b(?:INSERT|UPDATE|DELETE)\b/iu)
  })

  test('a me read advances one private marker and reports only balance-changing credit entries', async () => {
    const database = new MarkerDatabase({
      'read-attention': [[{
        had_previous_read: true,
        change_units: '2000000',
        changed_at: '2026-09-01T14:30:00.000Z',
        last_visit_at: '2026-09-01T12:00:00.000Z',
        accepted_gift_units: '3000000',
        settled_purchase_units: '4000000',
        pending_count: 1,
        frozen_count: 0,
      }]],
    })

    assert.deepEqual(await readCityCreditAttention(database, 7), {
      pending_gifts_count: 1,
      frozen_gifts_count: 0,
      last_visit_at: '2026-09-01T12:00:00.000Z',
      accepted_gifts_received_units: '3000000',
      settled_purchases_received_units: '4000000',
      credit_change: {
        amount: '2.000000',
        amount_units: '2000000',
        changed_at: '2026-09-01T14:30:00.000Z',
      },
    })
    assert.equal(database.calls.length, 1)
    assert.match(database.calls[0]!.text, /city_credit_last_me_reads/iu)
    assert.match(database.calls[0]!.text, /ON CONFLICT \(resident_id\) DO UPDATE/iu)
    assert.match(database.calls[0]!.text, /previous_credit_entry_id/iu)
    assert.match(database.calls[0]!.text, /gift_accept/iu)
    assert.match(database.calls[0]!.text, /entry_kind = 'purchase' AND entry\.gift_id IS NULL/iu)
    assert.match(database.calls[0]!.text, /gift\.status IN \('pending', 'frozen'\)/iu)
  })

  test('attention distinguishes ordinary gifts from dispute-frozen refusal-only gifts', () => {
    assert.deepEqual(cityCreditAttentionLines({
      pending_gifts_count: 3,
      frozen_gifts_count: 1,
      last_visit_at: null,
      accepted_gifts_received_units: '0',
      settled_purchases_received_units: '0',
      credit_change: null,
    }), [
      'You have 2 pending 1F3D9 fee-credit gifts awaiting accept or refuse; see city_fee_credit.pending_gifts.',
      'You have 1 dispute-frozen 1F3D9 fee-credit gift awaiting refuse; see city_fee_credit.pending_gifts.',
    ])
  })

  test('the first me read establishes a baseline without inventing an old credit change', async () => {
    const database = new MarkerDatabase({
      'read-attention': [[{
        had_previous_read: false,
        change_units: null,
        changed_at: null,
        last_visit_at: null,
        accepted_gift_units: '0',
        settled_purchase_units: '0',
        pending_count: 0,
        frozen_count: 0,
      }]],
    })

    assert.deepEqual(await readCityCreditAttention(database, 7), {
      pending_gifts_count: 0,
      frozen_gifts_count: 0,
      last_visit_at: null,
      accepted_gifts_received_units: '0',
      settled_purchases_received_units: '0',
      credit_change: null,
    })
  })

  test('since-last-visit credit separates received gifts, settled purchases, and gifts still awaiting acceptance', () => {
    assert.deepEqual(cityCreditSinceLastVisit({
      pending_gifts_count: 3,
      frozen_gifts_count: 1,
      last_visit_at: '2026-09-01T12:00:00.000Z',
      accepted_gifts_received_units: '3000000',
      settled_purchases_received_units: '2000000',
      credit_change: null,
    }), {
      accepted_gifts: {
        amount: '3.000000',
        amount_units: '3000000',
        record_link: 'city_fee_credit.receipts',
      },
      settled_purchases: {
        amount: '2.000000',
        amount_units: '2000000',
        record_link: 'city_fee_credit.receipts',
      },
      pending_gifts: {
        count: 2,
        record_link: 'city_fee_credit.pending_gifts',
      },
    })
  })

  test('the first visit keeps credit amounts empty while reporting current pending gifts', () => {
    assert.deepEqual(cityCreditSinceLastVisit({
      pending_gifts_count: 2,
      frozen_gifts_count: 0,
      last_visit_at: null,
      accepted_gifts_received_units: '0',
      settled_purchases_received_units: '0',
      credit_change: null,
    }), {
      accepted_gifts: {
        amount: '0.000000',
        amount_units: '0',
        record_link: 'city_fee_credit.receipts',
      },
      settled_purchases: {
        amount: '0.000000',
        amount_units: '0',
        record_link: 'city_fee_credit.receipts',
      },
      pending_gifts: {
        count: 2,
        record_link: 'city_fee_credit.pending_gifts',
      },
    })
  })
}
