import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalPaymentRequest } from '../../src/payment-attempts.ts'
import { beginCityCreditSpend } from '../../src/city-credit.ts'
import { MarkerDatabase, type QueryRow } from '../helpers/city-credit-fixtures/ledger-database.ts'
import { REQUEST_ID } from '../helpers/city-credit-fixtures/ledger-entries.ts'
import { ATTEMPT_ID, LEASE_OWNER, CANONICAL_REQUEST, spendRow, spendInput } from '../helpers/city-credit-fixtures/spend-attempts.ts'

export function registerSpendAttemptsTests(): void {
  test('begin spend binds actor, eligible operation, target, canonical request, request ID, and fixed amount', async () => {
    const database = new MarkerDatabase({ 'begin-spend': [[spendRow()]] })
    const result = await beginCityCreditSpend(database, spendInput())

    assert.deepEqual(result, {
      state: 'ready',
      attempt_id: ATTEMPT_ID,
      spend_entry_id: '201',
      lease_owner: LEASE_OWNER,
      amount: '1.000000',
      amount_units: '1000000',
    })
    const call = database.calls[0]
    assert.equal(call?.marker, 'begin-spend')
    assert.match(
      call?.text ?? '',
      /recovery_clock\s+AS\s+MATERIALIZED\s*\([\s\S]*clock_timestamp\(\)\s+AS\s+checked_at/iu,
    )
    assert.match(
      call?.text ?? '',
      /recovery_deadline_at\s*>\s*\(SELECT\s+checked_at\s+FROM\s+recovery_clock\)/iu,
    )
    assert.match(
      call?.text ?? '',
      /recovery_deadline_at\s*<=\s*\(SELECT\s+checked_at\s+FROM\s+recovery_clock\)/iu,
    )
    for (const boundValue of [
      7,
      'frontier',
      'frontier:TheBlueAI',
      REQUEST_ID,
      CANONICAL_REQUEST.hash,
      CANONICAL_REQUEST.json,
      '1000000',
    ]) {
      assert.ok(call?.params.includes(boundValue), `missing bound value ${String(boundValue)}`)
    }
  })

  test('kind revision credit binds the immutable kind asset to its spend attempt', async () => {
    const revisionRequest = { kind_id: 3, description: 'revised with credit' }
    const canonicalRevision = canonicalPaymentRequest(revisionRequest)
    const database = new MarkerDatabase({
      'begin-spend': [[spendRow({
        operation: 'kind_revision',
        target_key: 'kind-revision:3:2',
        request_id: 'kind-revision-request-0001',
        request_hash: canonicalRevision.hash,
        request_json: canonicalRevision.json,
        asset_type: 'kind',
        asset_id: 3,
      })]],
    })

    await beginCityCreditSpend(database, spendInput({
      operation: 'kind_revision',
      targetKey: 'kind-revision:3:2',
      request: revisionRequest,
      requestId: 'kind-revision-request-0001',
      assetType: 'kind',
      assetId: 3,
    }))

    const call = database.calls[0]
    assert.match(call?.text ?? '', /asset_type[\s\S]*asset_id/iu)
    assert.ok(call?.params.includes('kind'))
    assert.ok(call?.params.includes(3))

    const changedAsset = new MarkerDatabase({
      'begin-spend': [[spendRow({
        operation: 'kind_revision',
        target_key: 'kind-revision:3:2',
        request_id: 'kind-revision-request-0001',
        request_hash: canonicalRevision.hash,
        request_json: canonicalRevision.json,
        asset_type: 'kind',
        asset_id: 4,
      })]],
    })
    await assert.rejects(
      beginCityCreditSpend(changedAsset, spendInput({
        operation: 'kind_revision',
        targetKey: 'kind-revision:3:2',
        request: revisionRequest,
        requestId: 'kind-revision-request-0001',
        assetType: 'kind',
        assetId: 3,
      })),
      /conflict|changed|credit terms/iu,
    )
  })

  test('begin spend fails closed when durable terms do not match the caller request', async () => {
    const mismatches: readonly QueryRow[] = [
      { actor_id: 8 },
      { operation: 'kind_invention' },
      { target_key: 'frontier:DifferentName' },
      { request_id: 'different-request-0001' },
      { request_hash: 'f'.repeat(64) },
      { request_json: '{"name":"DifferentName"}' },
      { amount_units: '2000000' },
    ]

    for (const mismatch of mismatches) {
      const database = new MarkerDatabase({
        'begin-spend': [[spendRow(mismatch)]],
      })
      await assert.rejects(
        beginCityCreditSpend(database, spendInput()),
        /conflict|changed|credit terms/iu,
        JSON.stringify(mismatch),
      )
    }
  })

  test('spend rejects unsupported operations, malformed request IDs, and insufficient balance without fallback', async () => {
    const noDatabase = new MarkerDatabase({})
    await assert.rejects(
      beginCityCreditSpend(noDatabase, spendInput({ operation: 'direct_sale' })),
      /eligible|operation|city fee/iu,
    )
    await assert.rejects(
      beginCityCreditSpend(noDatabase, spendInput({ requestId: 'short' })),
      /credit request id/iu,
    )
    await assert.rejects(
      beginCityCreditSpend(noDatabase, spendInput({
        operation: 'kind_revision',
        targetKey: 'kind-revision:3:2',
        assetType: null,
        assetId: null,
      })),
      /kind asset id/iu,
    )
    await assert.rejects(
      beginCityCreditSpend(noDatabase, spendInput({ assetType: 'kind', assetId: 3 })),
      /cannot bind an asset/iu,
    )
    assert.equal(noDatabase.calls.length, 0)

    const insufficient = Object.assign(new Error('insufficient city fee credit'), { code: 'P0001' })
    const database = new MarkerDatabase({ 'begin-spend': [insufficient] })
    await assert.rejects(
      beginCityCreditSpend(database, spendInput()),
      /insufficient city fee credit/iu,
    )
    assert.equal(database.calls.length, 1)
  })

  test('completed, busy, and returned spend retries surface exact safe states', async () => {
    const completedResponse = Object.freeze({ ok: true, place: Object.freeze({ id: 91 }) })
    const database = new MarkerDatabase({
      'begin-spend': [
        [spendRow({
          state: 'completed',
          lease_acquired: false,
          response_status: 201,
          response_json: completedResponse,
        })],
        [spendRow({ state: 'busy', lease_acquired: false })],
        [spendRow({
          state: 'returned',
          lease_acquired: false,
          return_entry_id: '202',
          response_status: 409,
          response_json: { error: 'target became unavailable; credit returned' },
        })],
      ],
    })

    assert.deepEqual(await beginCityCreditSpend(database, spendInput()), {
      state: 'completed',
      attempt_id: ATTEMPT_ID,
      response_status: 201,
      response: completedResponse,
    })
    assert.deepEqual(await beginCityCreditSpend(database, spendInput()), {
      state: 'busy',
      attempt_id: ATTEMPT_ID,
    })
    assert.deepEqual(await beginCityCreditSpend(database, spendInput()), {
      state: 'returned',
      attempt_id: ATTEMPT_ID,
      return_entry_id: '202',
      response_status: 409,
      response: { error: 'target became unavailable; credit returned' },
    })
  })
}
