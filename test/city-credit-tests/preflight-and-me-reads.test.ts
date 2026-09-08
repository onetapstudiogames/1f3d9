import assert from 'node:assert/strict'
import test from 'node:test'
import { cityCreditAttentionLines, cityCreditSinceLastVisit, readCityCreditAttention, readCityCreditPreflight } from '../../src/city-credit.ts'
import { MarkerDatabase } from '../helpers/city-credit-fixtures/ledger-database.ts'
import { mapAroundYou } from '../../src/me-around-you.ts'
import { AROUND_YOU_ADMISSION_CHANGE_THRESHOLD, AROUND_YOU_CHANGE_LIMIT } from '../../src/me-around-you-limit.ts'

const EMPTY_AROUND_YOU = {
  after_change_id: null, through_change_id: '0',
  notes_in_owned_places: { count: 0, records: [] },
  new_things_in_owned_places: { count: 0, records: [] },
  new_agreement_signers: { count: 0, records: [] },
  mentions: { count: 0, records: [] },
} as const

const SUMMARY_BUDGET_REPLIES = {
  'me-summary-window': [[{ after_change_id: '5', through_change_id: String(5 + AROUND_YOU_ADMISSION_CHANGE_THRESHOLD) }]],
  'save-me-summary': [[]],
  'admit-me-summary': [[{ slot: 0 }]],
  'me-summary-timeout': [[]],
  'me-summary-parallel': [[]],
  'release-me-summary': [[]],
} as const

function attentionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    had_previous_read: true, change_units: '0', changed_at: '2026-09-01T15:00:00.000Z',
    last_visit_at: '2026-09-01T12:00:00.000Z', accepted_gift_units: '0',
    settled_purchase_units: '0', founder_issue_units: '1000000', founder_issue_count: 1,
    founder_issues: [{
      id: '22', amount_units: '1000000', reason: 'Showing room prize',
      created_at: '2026-09-01T14:30:00.000Z',
    }],
    founder_issues_have_more: false,
    pending_gifts: [{
      row_id: '31', gift_id: 'city_gift_0123456789abcdef0123456789abcdef',
      amount_units: '3000000',
    }],
    pending_gifts_have_more: false, pending_count: 1, frozen_count: 0,
    around_you: EMPTY_AROUND_YOU, ...overrides,
  }
}

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
        founder_issue_units: '1000000',
        founder_issue_count: 1,
        founder_issues: [
          { id: '22', amount_units: '1000000', reason: 'Showing room prize', created_at: '2026-09-01T14:30:00.000Z' },
        ],
        founder_issues_have_more: false,
        pending_gifts: [{
          row_id: '31', gift_id: 'city_gift_0123456789abcdef0123456789abcdef',
          amount_units: '3000000',
        }],
        pending_gifts_have_more: false,
        around_you: EMPTY_AROUND_YOU,
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
      founder_issues_received_units: '1000000',
      founder_issues: [{
        id: '22', amount: '1.000000', amount_units: '1000000',
        reason: 'Showing room prize', created_at: '2026-09-01T14:30:00.000Z',
      }],
      founder_issues_have_more: false,
      pending_gifts: [{
        row_id: '31', gift_id: 'city_gift_0123456789abcdef0123456789abcdef',
        amount: '3.000000', amount_units: '3000000',
      }],
      pending_gifts_have_more: false,
      around_you: mapAroundYou(EMPTY_AROUND_YOU),
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
    assert.match(database.calls[0]!.text, /entry_kind = 'founder_issue'/iu)
    assert.match(database.calls[0]!.text, /LIMIT 11/iu)
    assert.match(database.calls[0]!.text, /gift\.status IN \('pending', 'frozen'\)/iu)
  })

  test('attention distinguishes ordinary gifts from dispute-frozen refusal-only gifts', () => {
    assert.deepEqual(cityCreditAttentionLines({
      pending_gifts_count: 3,
      frozen_gifts_count: 1,
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
        founder_issue_units: '0', founder_issue_count: 0, founder_issues: [], founder_issues_have_more: false,
        pending_gifts: [], pending_gifts_have_more: false,
        around_you: EMPTY_AROUND_YOU,
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
      founder_issues_received_units: '0', founder_issues: [], founder_issues_have_more: false,
      pending_gifts: [], pending_gifts_have_more: false,
      around_you: mapAroundYou(EMPTY_AROUND_YOU),
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
      founder_issues_received_units: '1000000',
      founder_issues: [{
        id: '22', amount: '1.000000', amount_units: '1000000',
        reason: 'Showing room prize', created_at: '2026-09-01T14:30:00.000Z',
      }],
      founder_issues_have_more: false,
      pending_gifts: [{
        row_id: '31', gift_id: 'city_gift_0123456789abcdef0123456789abcdef',
        amount: '3.000000', amount_units: '3000000',
      }],
      pending_gifts_have_more: false,
      around_you: mapAroundYou(EMPTY_AROUND_YOU),
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
      founder_issues: {
        amount: '1.000000', amount_units: '1000000',
        sentence: 'The founder gave you 1.000000 fee credit since your last visit for the reasons listed in these receipts.',
        receipts: [{
          id: '22', amount: '1.000000', amount_units: '1000000',
          reason: 'Showing room prize', created_at: '2026-09-01T14:30:00.000Z',
        }],
        record_link: 'city_fee_credit.receipts',
        page: { has_more: false, next_before_credit_id: null },
      },
      pending_gifts: {
        count: 2,
        record_link: 'city_fee_credit.pending_gifts',
        items: [{
          gift_id: 'city_gift_0123456789abcdef0123456789abcdef',
          amount: '3.000000', amount_units: '3000000',
          sentence: 'A human bought you 3.000000 fee credit. Accept it with POST /api/city-credit/gifts/city_gift_0123456789abcdef0123456789abcdef/accept or refuse it with POST /api/city-credit/gifts/city_gift_0123456789abcdef0123456789abcdef/refuse. Send an empty request body.',
          accept: 'POST /api/city-credit/gifts/city_gift_0123456789abcdef0123456789abcdef/accept',
          refuse: 'POST /api/city-credit/gifts/city_gift_0123456789abcdef0123456789abcdef/refuse',
        }],
        page: { has_more: false, next_before_gift_id: null },
      },
    })
  })

  test('same-snapshot founder and pending pages keep exact totals while bounding items at ten', async () => {
    const founderIssues = Array.from({ length: 10 }, (_, index) => ({
      id: String(30 - index), amount_units: '1000000', reason: `Prize ${index + 1}`,
      created_at: `2026-09-01T14:${String(50 - index).padStart(2, '0')}:00.000Z`,
    }))
    const pendingGifts = Array.from({ length: 10 }, (_, index) => ({
      row_id: String(50 - index),
      gift_id: `city_gift_${String(index + 1).padStart(32, '0')}`,
      amount_units: '1000000',
    }))
    const database = new MarkerDatabase({
      'read-attention': [[attentionRow({
        founder_issue_units: '11000000', founder_issue_count: 11,
        founder_issues: founderIssues, founder_issues_have_more: true,
        pending_count: 12, frozen_count: 1,
        pending_gifts: pendingGifts, pending_gifts_have_more: true,
      })]],
    })

    const state = await readCityCreditAttention(database, 7)
    const report = cityCreditSinceLastVisit(state)
    assert.equal(report.founder_issues.amount_units, '11000000')
    assert.equal(report.founder_issues.receipts.length, 10)
    assert.deepEqual(report.founder_issues.page, { has_more: true, next_before_credit_id: '21' })
    assert.equal(report.pending_gifts.count, 11)
    assert.equal(report.pending_gifts.items.length, 10)
    assert.deepEqual(report.pending_gifts.page, { has_more: true, next_before_gift_id: '41' })
    assert.equal(report.pending_gifts.items.some(item => item.accept.includes(':gift_id')), false)
  })

  test('an unsafe or dishonest bounded credit snapshot fails as a whole', async t => {
    const malformed: readonly [string, Record<string, unknown>][] = [
      ['founder amount', { founder_issue_units: '2000000', founder_issues: [{ id: '22', amount_units: '2000000', reason: 'Prize', created_at: '2026-09-01T14:30:00.000Z' }] }],
      ['founder reason', { founder_issues: [{ id: '22', amount_units: '1000000', reason: 'bad\u0000reason', created_at: '2026-09-01T14:30:00.000Z' }] }],
      ['founder time', { founder_issues: [{ id: '22', amount_units: '1000000', reason: 'Prize', created_at: 'not-a-time' }] }],
      ['gift id', { pending_gifts: [{ row_id: '31', gift_id: 'not-a-gift', amount_units: '3000000' }] }],
      ['gift amount', { pending_gifts: [{ row_id: '31', gift_id: 'city_gift_0123456789abcdef0123456789abcdef', amount_units: '0' }] }],
      ['missing founder rows', { founder_issues: undefined }],
      ['missing gift rows', { pending_gifts: undefined }],
      ['founder page metadata', { founder_issue_units: '2000000', founder_issue_count: 2 }],
      ['gift page metadata', { pending_count: 2 }],
      ['negative pending count', { pending_count: -1 }],
      ['negative frozen count', { frozen_count: -1 }],
      ['frozen count exceeds all gifts', { frozen_count: 2 }],
      ['negative founder receipt count', { founder_issue_count: -1 }],
      ['false founder continuation', { founder_issues_have_more: true }],
      ['false gift continuation', { pending_gifts_have_more: true }],
      ['missing founder date', { founder_issues: [{ id: '22', amount_units: '1000000', reason: 'Prize', created_at: null }] }],
      ['missing gift identifier', { pending_gifts: [{ row_id: '31', amount_units: '1000000' }] }],
    ]
    for (const [name, overrides] of malformed) {
      await t.test(name, async () => {
        const database = new MarkerDatabase({ 'read-attention': [[attentionRow(overrides)]] })
        await assert.rejects(readCityCreditAttention(database, 7), TypeError)
      })
    }
  })

  test('a malformed snapshot rolls back the serialized me transaction', async () => {
    class TransactionDatabase extends MarkerDatabase {
      committed = false
      rolledBack = false
      async transaction<T>(work: (database: TransactionDatabase) => Promise<T>): Promise<T> {
        try {
          const result = await work(this)
          this.committed = true
          return result
        } catch (error) {
          this.rolledBack = true
          throw error
        }
      }
    }
    const database = new TransactionDatabase({
      ...SUMMARY_BUDGET_REPLIES,
      'lock-me-read': [[{ id: 7 }]],
      'read-attention': [[attentionRow({ founder_issues: undefined })]],
    })
    await assert.rejects(readCityCreditAttention(database, 7), TypeError)
    assert.equal(database.rolledBack, true)
    assert.equal(database.committed, false)
    const missingResident = new TransactionDatabase({ 'lock-me-read': [[]] })
    await assert.rejects(readCityCreditAttention(missingResident, 7), TypeError)
    assert.equal(missingResident.rolledBack, true)
    assert.equal(missingResident.committed, false)
    assert.equal(missingResident.calls.length, 1)
    const missingSnapshot = new TransactionDatabase({
      ...SUMMARY_BUDGET_REPLIES,
      'lock-me-read': [[{ id: 7 }]], 'read-attention': [[]],
    })
    await assert.rejects(readCityCreditAttention(missingSnapshot, 7), TypeError)
    assert.equal(missingSnapshot.rolledBack, true)
    assert.equal(missingSnapshot.committed, false)
  })

  test('an unread around-you interval completes the me transaction and preserves credit information', async () => {
    const database = new MarkerDatabase({
      ...SUMMARY_BUDGET_REPLIES,
      'lock-me-read': [[{ id: 7 }]],
      'me-summary-window': [[{ after_change_id: '1', through_change_id: String(AROUND_YOU_CHANGE_LIMIT + 2) }]],
      'read-attention': [[attentionRow({ around_you: {
        after_change_id: '1', through_change_id: String(AROUND_YOU_CHANGE_LIMIT + 2),
        notes_in_owned_places: null, new_things_in_owned_places: null,
        new_agreement_signers: null, mentions: null,
      } })]],
    })
    let committed = false
    const state = await readCityCreditAttention({
      query: database.query.bind(database),
      transaction: async work => {
        const result = await work(database)
        committed = true
        return result
      },
    }, 7)
    assert.equal(committed, true)
    assert.equal(state.around_you.available, false)
    assert.equal(state.around_you.through_change_id, String(AROUND_YOU_CHANGE_LIMIT + 2))
    assert.equal(state.around_you.notes_in_owned_places, null)
    assert.equal(database.calls.some(call => call.marker === 'admit-me-summary'), false)
    const credit = cityCreditSinceLastVisit(state)
    assert.equal(credit.founder_issues.receipts[0]?.reason, 'Showing room prize')
    assert.equal(credit.pending_gifts.count, 1)
    assert.match(credit.pending_gifts.items[0]?.sentence ?? '', /A human bought you/u)
  })

  test('exactly the admission threshold needs a slot and a busy result preserves its pinned cutoff', async () => {
    const database = new MarkerDatabase({
      ...SUMMARY_BUDGET_REPLIES,
      'lock-me-read': [[{ id: 7 }]],
      'admit-me-summary': [[{ slot: null }]],
      'rollback-me-summary': [[]],
      'read-attention': [[attentionRow({ around_you: {
        after_change_id: '5', through_change_id: String(5 + AROUND_YOU_ADMISSION_CHANGE_THRESHOLD), unavailable_reason: 'busy',
        notes_in_owned_places: null, new_things_in_owned_places: null,
        new_agreement_signers: null, mentions: null,
      } })]],
    })
    const result = await readCityCreditAttention({
      query: database.query.bind(database), transaction: work => work(database),
    }, 7)
    assert.equal(result.around_you.available, false)
    assert.deepEqual(database.calls.map(call => call.marker), [
      'lock-me-read', 'me-summary-window', 'save-me-summary', 'admit-me-summary',
      'rollback-me-summary', 'release-me-summary', 'read-attention',
    ])
    assert.deepEqual(database.calls.at(-1)?.params, [7, 'busy', String(5 + AROUND_YOU_ADMISSION_CHANGE_THRESHOLD)])
  })

  test('a small me statement still has a budget and a timeout retry retains the pinned cutoff', async () => {
    const cancelled = Object.assign(new Error('query cancelled'), { code: '57014' })
    const database = new MarkerDatabase({
      ...SUMMARY_BUDGET_REPLIES,
      'lock-me-read': [[{ id: 7 }]],
      'me-summary-window': [[{ after_change_id: '5', through_change_id: '8' }]],
      'rollback-me-summary': [[]],
      'read-attention': [Object.assign(new Error('wrapped'), { sourceError: cancelled }), [attentionRow({
        last_visit_at: '2026-09-01T10:00:00Z',
        around_you: {
          after_change_id: '5', through_change_id: '8', unavailable_reason: 'timeout',
          notes_in_owned_places: null, new_things_in_owned_places: null,
          new_agreement_signers: null, mentions: null,
        },
      })]],
    })
    const result = await readCityCreditAttention({
      query: database.query.bind(database), transaction: work => work(database),
    }, 7)
    assert.equal(result.around_you.available, false)
    assert.equal(result.around_you.through_change_id, '8')
    assert.equal(result.last_visit_at, '2026-09-01T10:00:00.000Z')
    assert.equal(result.founder_issues[0]?.reason, 'Showing room prize')
    assert.deepEqual(database.calls.map(call => call.marker), [
      'lock-me-read', 'me-summary-window', 'save-me-summary',
      'me-summary-timeout', 'me-summary-parallel', 'read-attention',
      'rollback-me-summary', 'release-me-summary', 'read-attention',
    ])
    assert.deepEqual(database.calls.filter(call => call.marker === 'read-attention').map(call => call.params), [[7, null, '8'], [7, 'timeout', '8']])
  })

  test('a small interval bypasses admission and pins its cutoff against changes arriving after the precheck', async () => {
    const through = String(5 + AROUND_YOU_ADMISSION_CHANGE_THRESHOLD - 1)
    const database = new MarkerDatabase({
      ...SUMMARY_BUDGET_REPLIES,
      'lock-me-read': [[{ id: 7 }]],
      'me-summary-window': [[{ after_change_id: '5', through_change_id: through }]],
      // Returning a blocked slot would degrade the summary if admission ran.
      'admit-me-summary': [[{ slot: null }]],
      'read-attention': [[attentionRow({ around_you: {
        ...EMPTY_AROUND_YOU, after_change_id: '5', through_change_id: through,
        mentions: { count: 1, records: [{ id: 9, change_id: '6' }] },
      } })]],
    })
    const result = await readCityCreditAttention({
      query: database.query.bind(database), transaction: work => work(database),
    }, 7)
    assert.ok(result.around_you.available)
    assert.equal(result.around_you.mentions.count, 1)
    assert.deepEqual(database.calls.map(call => call.marker), [
      'lock-me-read', 'me-summary-window', 'save-me-summary',
      'me-summary-timeout', 'me-summary-parallel', 'read-attention', 'release-me-summary',
    ])
    const snapshot = database.calls.find(call => call.marker === 'read-attention')!
    assert.deepEqual(snapshot.params, [7, null, through])
    // $3 wins over a newly advanced public counter in the final snapshot.
    assert.match(snapshot.text, /coalesce\(\$3::bigint, \(SELECT current_change_id/u)
  })

  test('a baseline does not compete for an admission slot regardless of the current public counter', async () => {
    const through = String(AROUND_YOU_CHANGE_LIMIT + 1)
    const database = new MarkerDatabase({
      ...SUMMARY_BUDGET_REPLIES,
      'lock-me-read': [[{ id: 7 }]],
      'me-summary-window': [[{ after_change_id: null, through_change_id: through }]],
      'admit-me-summary': [[{ slot: null }]],
      'read-attention': [[attentionRow({ around_you: { ...EMPTY_AROUND_YOU, through_change_id: through } })]],
    })
    const result = await readCityCreditAttention({
      query: database.query.bind(database), transaction: work => work(database),
    }, 7)
    assert.ok(result.around_you.available)
    assert.equal(result.around_you.baseline, true)
    assert.equal(database.calls.some(call => call.marker === 'admit-me-summary'), false)
  })

  test('exactly the upper change limit still takes a slot and returns an available summary', async () => {
    const through = String(5 + AROUND_YOU_CHANGE_LIMIT)
    const database = new MarkerDatabase({
      ...SUMMARY_BUDGET_REPLIES,
      'lock-me-read': [[{ id: 7 }]],
      'me-summary-window': [[{ after_change_id: '5', through_change_id: through }]],
      'read-attention': [[attentionRow({ around_you: {
        ...EMPTY_AROUND_YOU, after_change_id: '5', through_change_id: through,
      } })]],
    })
    const result = await readCityCreditAttention({
      query: database.query.bind(database), transaction: work => work(database),
    }, 7)
    assert.ok(result.around_you.available)
    assert.equal(database.calls.filter(call => call.marker === 'admit-me-summary').length, 1)
    assert.deepEqual(database.calls.find(call => call.marker === 'read-attention')?.params, [7, null, through])
  })

  test('missing, invalid or reversed precheck markers fail before the marker can advance', async () => {
    for (const row of [undefined,
      { after_change_id: '9', through_change_id: '8' },
      { after_change_id: '-1', through_change_id: '8' },
      { after_change_id: null, through_change_id: null },
      { through_change_id: '8' },
    ]) {
      const database = new MarkerDatabase({
        'lock-me-read': [[{ id: 7 }]], 'me-summary-window': [row ? [row] : []],
      })
      await assert.rejects(readCityCreditAttention({
        query: database.query.bind(database), transaction: work => work(database),
      }, 7), TypeError)
      assert.deepEqual(database.calls.map(call => call.marker), ['lock-me-read', 'me-summary-window'])
    }
  })

  test('a non-budget database error is not retried or hidden by an unavailable summary', async () => {
    const failure = Object.assign(new Error('database failed'), { code: 'XX000' })
    const database = new MarkerDatabase({
      ...SUMMARY_BUDGET_REPLIES,
      'lock-me-read': [[{ id: 7 }]], 'read-attention': [failure],
    })
    await assert.rejects(readCityCreditAttention({
      query: database.query.bind(database), transaction: work => work(database),
    }, 7), error => error === failure)
    assert.equal(database.calls.filter(call => call.marker === 'read-attention').length, 1)
    assert.equal(database.calls.some(call => call.marker === 'rollback-me-summary'), false)
  })

  test('the first visit keeps credit amounts empty while reporting current pending gifts', () => {
    assert.deepEqual(cityCreditSinceLastVisit({
      pending_gifts_count: 1,
      frozen_gifts_count: 0,
      last_visit_at: null,
      accepted_gifts_received_units: '0',
      settled_purchases_received_units: '0',
      founder_issues_received_units: '0', founder_issues: [], founder_issues_have_more: false,
      pending_gifts: [{
        row_id: '31', gift_id: 'city_gift_0123456789abcdef0123456789abcdef',
        amount: '3.000000', amount_units: '3000000',
      }], pending_gifts_have_more: false,
      around_you: mapAroundYou(EMPTY_AROUND_YOU),
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
      founder_issues: {
        amount: '0.000000', amount_units: '0', sentence: null, receipts: [],
        record_link: 'city_fee_credit.receipts',
        page: { has_more: false, next_before_credit_id: null },
      },
      pending_gifts: {
        count: 1,
        record_link: 'city_fee_credit.pending_gifts',
        items: [{
          gift_id: 'city_gift_0123456789abcdef0123456789abcdef',
          amount: '3.000000', amount_units: '3000000',
          sentence: 'A human bought you 3.000000 fee credit. Accept it with POST /api/city-credit/gifts/city_gift_0123456789abcdef0123456789abcdef/accept or refuse it with POST /api/city-credit/gifts/city_gift_0123456789abcdef0123456789abcdef/refuse. Send an empty request body.',
          accept: 'POST /api/city-credit/gifts/city_gift_0123456789abcdef0123456789abcdef/accept',
          refuse: 'POST /api/city-credit/gifts/city_gift_0123456789abcdef0123456789abcdef/refuse',
        }],
        page: { has_more: false, next_before_gift_id: null },
      },
    })
  })
}
