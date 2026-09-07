import assert from 'node:assert/strict'
import test from 'node:test'
import { CITY_FEE_CREDIT_UNITS, issueCityFeeCredit } from '../../src/city-credit.ts'
import { MarkerDatabase, type QueryRow } from '../helpers/city-credit-fixtures/ledger-database.ts'
import { SOURCE_KEY, CREATED_AT } from '../helpers/city-credit-fixtures/ledger-entries.ts'

export function registerFounderIssuanceTests(): void {
  function issueRow(overrides: QueryRow = {}): QueryRow {
    return {
      created: true,
      entry_id: '101',
      entry_kind: 'founder_issue',
      resident_id: 7,
      founder_id: 1,
      amount_units: CITY_FEE_CREDIT_UNITS.toString(),
      source_key: SOURCE_KEY,
      reason: 'extra finalized city payment',
      created_at: CREATED_AT,
      balance_units: CITY_FEE_CREDIT_UNITS.toString(),
      ...overrides,
    }
  }

  test('only founder resident 1 can issue the fixed fee unit', async () => {
    for (const founderId of [0, 2, 7]) {
      const database = new MarkerDatabase({})
      await assert.rejects(
        issueCityFeeCredit(database, {
          founderId,
          residentId: 7,
          sourceKey: SOURCE_KEY,
          reason: 'extra finalized city payment',
        }),
        /founder/iu,
      )
      assert.equal(database.calls.length, 0)
    }

    const database = new MarkerDatabase({
      issue: [[issueRow({ created_at: new Date('2026-08-22T12:00:00.106Z') })]],
      'issue-balance': [[{ balance_units: CITY_FEE_CREDIT_UNITS.toString() }]],
    })
    const issued = await issueCityFeeCredit(database, {
      founderId: 1,
      residentId: 7,
      sourceKey: SOURCE_KEY,
      reason: 'extra finalized city payment',
    })

    assert.equal(issued.disposition, 'created')
    assert.equal(issued.amount, '1.000000')
    assert.equal(issued.amount_units, '1000000')
    assert.equal(issued.created_at, '2026-08-22T12:00:00.106Z')
    assert.equal(database.calls[0]?.marker, 'issue')
    assert.ok(database.calls[0]?.params.includes('1000000'))
    assert.ok(database.calls[0]?.params.includes(SOURCE_KEY))
    assert.doesNotMatch(JSON.stringify(issued), /token|crypto|redeem|cash/iu)
  })

  test('founder issuance replays one source key and conflicts on changed terms', async () => {
    const existing = issueRow({ created: false })
    const database = new MarkerDatabase({
      issue: [[issueRow()], [existing], [existing], [existing]],
      'issue-balance': [
        [{ balance_units: CITY_FEE_CREDIT_UNITS.toString() }],
        [{ balance_units: CITY_FEE_CREDIT_UNITS.toString() }],
      ],
    })
    const original = {
      founderId: 1,
      residentId: 7,
      sourceKey: SOURCE_KEY,
      reason: 'extra finalized city payment',
    }

    assert.equal((await issueCityFeeCredit(database, original)).disposition, 'created')
    assert.equal((await issueCityFeeCredit(database, original)).disposition, 'existing')
    const exactConflict = (error: unknown) => {
      assert.equal((error as Error).name, 'CityCreditConflictError')
      assert.equal(
        (error as Error).message,
        'city credit source key is already bound to different resident or reason terms; retry with the original terms or use a new source key',
      )
      return true
    }
    await assert.rejects(
      issueCityFeeCredit(database, { ...original, residentId: 8 }),
      exactConflict,
    )
    await assert.rejects(
      issueCityFeeCredit(database, { ...original, reason: 'different accounting reason' }),
      exactConflict,
    )
    assert.equal(database.calls.length, 6)
  })

  test('founder issuance reads a concurrent source winner from a fresh snapshot', async () => {
    const database = new MarkerDatabase({
      issue: [[]],
      'issue-replay': [[issueRow({ created: false })]],
      'issue-balance': [[{ balance_units: CITY_FEE_CREDIT_UNITS.toString() }]],
    })

    const issued = await issueCityFeeCredit(database, {
      founderId: 1,
      residentId: 7,
      sourceKey: SOURCE_KEY,
      reason: 'extra finalized city payment',
    })

    assert.equal(issued.disposition, 'existing')
    assert.deepEqual(database.calls.map(call => call.marker), [
      'issue',
      'issue-replay',
      'issue-balance',
    ])
  })
}
