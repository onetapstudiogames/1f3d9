import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalPaymentRequest } from '../../src/payment-attempts.ts'
import { beginCityCreditSpend } from '../../src/city-credit.ts'
import {
  CREDIT_REQUEST_ID_RECORDED_CONFLICT_COMPLETED,
  CREDIT_REQUEST_ID_RECORDED_CONFLICT_PENDING,
  CREDIT_REQUEST_ID_RECORDED_CONFLICT_REVIEW,
  CREDIT_REQUEST_ID_RECORDED_CONFLICT_UNREAD,
} from '../../src/city-fee-facts.ts'
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

  test('a recorded number-shaped id says only what its own attempt status allows', async () => {
    // The reported case: the action was minted under `1.000000`, so its attempt is
    // completed and no credit ever comes back. Each status answers for itself.
    const recorded = [
      ['payment_pending', CREDIT_REQUEST_ID_RECORDED_CONFLICT_PENDING],
      ['settling', CREDIT_REQUEST_ID_RECORDED_CONFLICT_PENDING],
      ['completed', CREDIT_REQUEST_ID_RECORDED_CONFLICT_COMPLETED],
      ['needs_review', CREDIT_REQUEST_ID_RECORDED_CONFLICT_REVIEW],
    ] as const

    for (const [attemptStatus, expected] of recorded) {
      const database = new MarkerDatabase({
        'begin-spend': [[spendRow({
          attempt_status: attemptStatus,
          request_id: '1.000000',
          lease_acquired: false,
          ...(attemptStatus === 'completed'
            ? { state: 'completed', response_status: 201, response_json: { ok: true } }
            : { state: 'busy' }),
        })]],
      })
      await assert.rejects(
        beginCityCreditSpend(database, spendInput({ requestId: 'fee-a-fresh-id-0001' })),
        (error: unknown) => {
          assert.equal(error instanceof Error ? error.message : '', expected, attemptStatus)
          return true
        },
      )
    }

    assert.match(CREDIT_REQUEST_ID_RECORDED_CONFLICT_COMPLETED, /already spent/iu)
    assert.doesNotMatch(CREDIT_REQUEST_ID_RECORDED_CONFLICT_COMPLETED, /returns on its own/iu)
    assert.match(CREDIT_REQUEST_ID_RECORDED_CONFLICT_REVIEW, /founder review/iu)
    assert.doesNotMatch(CREDIT_REQUEST_ID_RECORDED_CONFLICT_REVIEW, /returns on its own/iu)
    assert.match(CREDIT_REQUEST_ID_RECORDED_CONFLICT_PENDING, /returns on its own at the attempt deadline/iu)
  })

  test('a recorded status the city cannot read promises no return instead of guessing', async () => {
    // Only a live attempt returns credit at its deadline. A status the city does
    // not know is not evidence that this one is live, so it says so rather than
    // handing the caller the one wording that promises a refund.
    for (const attemptStatus of [undefined, null, '', 'credit_returned', 'a_status_from_a_later_city']) {
      const database = new MarkerDatabase({
        'begin-spend': [[spendRow({
          attempt_status: attemptStatus,
          state: 'busy',
          request_id: '1.000000',
          lease_acquired: false,
        })]],
      })
      await assert.rejects(
        beginCityCreditSpend(database, spendInput({ requestId: 'fee-a-fresh-id-0002' })),
        (error: unknown) => {
          assert.equal(
            error instanceof Error ? error.message : '',
            CREDIT_REQUEST_ID_RECORDED_CONFLICT_UNREAD,
            String(attemptStatus),
          )
          return true
        },
      )
    }

    assert.doesNotMatch(CREDIT_REQUEST_ID_RECORDED_CONFLICT_UNREAD, /returns on its own/iu)
    assert.notEqual(CREDIT_REQUEST_ID_RECORDED_CONFLICT_UNREAD, CREDIT_REQUEST_ID_RECORDED_CONFLICT_PENDING)
  })

  test('replaying one request id returns the earlier recorded result and reserves nothing new', async () => {
    const earlierResult = Object.freeze({ ok: true, kind: Object.freeze({ id: 44 }) })
    const database = new MarkerDatabase({
      'begin-spend': [
        [spendRow()],
        [spendRow({
          state: 'completed',
          lease_acquired: false,
          response_status: 201,
          response_json: earlierResult,
        })],
      ],
    })

    const first = await beginCityCreditSpend(database, spendInput())
    assert.equal(first.state, 'ready')

    const replay = await beginCityCreditSpend(database, spendInput())
    assert.deepEqual(replay, {
      state: 'completed',
      attempt_id: ATTEMPT_ID,
      response_status: 201,
      response: earlierResult,
    })
    assert.equal('spend_entry_id' in replay, false)
    assert.equal('lease_owner' in replay, false)
    assert.equal(database.calls.length, 2)
    assert.ok(database.calls.every(call => call.params.includes(REQUEST_ID)))
  })
}
