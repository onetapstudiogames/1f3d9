import assert from 'node:assert/strict'
import test from 'node:test'
import { returnCityCreditSpend } from '../../src/city-credit.ts'
import { MarkerDatabase, type QueryReply } from '../helpers/city-credit-fixtures/ledger-database.ts'
import { ATTEMPT_ID, LEASE_OWNER, spendRow } from '../helpers/city-credit-fixtures/spend-attempts.ts'

export function registerSpendReturnsTests(): void {
  test('return uses the exact attempt debit once and identical retries replay it', async () => {
    const returned = spendRow({
      state: 'returned',
      status: 'credit_returned',
      lease_acquired: false,
      return_entry_id: '202',
      response_status: 409,
      response_json: { error: 'target became unavailable; credit returned' },
    })
    const database = new MarkerDatabase({
      'return-spend': [
        [{ ...returned, prior_status: 'payment_pending' }],
        [{ ...returned, prior_status: 'credit_returned' }],
      ],
      'return-result': [[returned], [returned]],
    })
    const input = {
      actorId: 7,
      attemptId: ATTEMPT_ID,
      leaseOwner: LEASE_OWNER,
      reason: 'target became unavailable',
      responseStatus: 409,
      response: { error: 'target became unavailable; credit returned' },
    }

    assert.deepEqual(await returnCityCreditSpend(database, input), {
      disposition: 'created',
      state: 'returned',
      attempt_id: ATTEMPT_ID,
      spend_entry_id: '201',
      return_entry_id: '202',
      amount: '1.000000',
      amount_units: '1000000',
      response_status: 409,
      response: { error: 'target became unavailable; credit returned' },
    })
    assert.equal((await returnCityCreditSpend(database, input)).disposition, 'existing')
    assert.equal(database.calls.length, 4)
    for (const call of database.calls.filter(({ marker }) => marker === 'return-spend')) {
      assert.ok(call.params.includes(7))
      assert.ok(call.params.includes(ATTEMPT_ID))
      assert.ok(call.params.includes(LEASE_OWNER))
      assert.ok(call.params.includes('1000000'))
      assert.match(call.text, /locked_attempt[\s\S]*FOR\s+UPDATE/iu)
    }
  })

  test('return rejects missing, cross-resident, changed, non-spend, and non-exact debits', async () => {
    const failures: readonly QueryReply[] = [
      Object.assign(new Error('matching city credit spend was not found'), { code: 'P0001' }),
      [spendRow({ status: 'credit_returned', actor_id: 8, return_entry_id: '202' })],
      [spendRow({ status: 'credit_returned', amount_units: '2000000', return_entry_id: '202' })],
      [spendRow({ status: 'completed', return_entry_id: null })],
    ]

    for (const reply of failures) {
      const database = new MarkerDatabase({ 'return-spend': [reply] })
      await assert.rejects(
        returnCityCreditSpend(database, {
          actorId: 7,
          attemptId: ATTEMPT_ID,
          leaseOwner: LEASE_OWNER,
          reason: 'target became unavailable',
          responseStatus: 409,
          response: { error: 'target became unavailable; credit returned' },
        }),
        /matching|conflict|changed|exact|return/iu,
      )
    }
  })
}
