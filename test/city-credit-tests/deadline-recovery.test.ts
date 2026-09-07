import assert from 'node:assert/strict'
import test from 'node:test'
import { beginCityCreditSpend, returnCityCreditSpend, returnExpiredCityCreditSpend } from '../../src/city-credit.ts'
import { MarkerDatabase, type QueryRow } from '../helpers/city-credit-fixtures/ledger-database.ts'
import { ATTEMPT_ID, LEASE_OWNER, spendRow, spendInput } from '../helpers/city-credit-fixtures/spend-attempts.ts'

export function registerDeadlineRecoveryTests(): void {
  function expiredClaimRow(overrides: QueryRow = {}): QueryRow {
    return {
      state: 'ready',
      attempt_id: ATTEMPT_ID,
      actor_id: 7,
      status: 'payment_pending',
      lease_owner: '__bound_lease__',
      recovery_deadline_at: '2026-08-22T14:00:00.000Z',
      ...overrides,
    }
  }

  test('deadline recovery uses the database clock and returns only the exact spent credit', async () => {
    const returned = spendRow({
      state: 'returned',
      status: 'credit_returned',
      lease_acquired: false,
      return_entry_id: '202',
      response_status: 409,
      response_json: {
        error: 'automatic recovery deadline reached; city fee credit returned; use a new request id to try the action again',
        city_fee_credit: 'credit_returned',
        returned_usdc: '1.000000',
      },
    })
    const database = new MarkerDatabase({
      'claim-expired-spend': [[expiredClaimRow()]],
      'return-spend': [[returned]],
      'return-result': [[returned]],
    })

    const result = await returnExpiredCityCreditSpend(database, {
      actorId: 7,
      attemptId: ATTEMPT_ID,
    })

    assert.deepEqual(result, {
      disposition: 'created',
      state: 'credit_returned',
      attempt_id: ATTEMPT_ID,
      spend_entry_id: '201',
      return_entry_id: '202',
      amount: '1.000000',
      amount_units: '1000000',
      response_status: 409,
      response: {
        error: 'automatic recovery deadline reached; city fee credit returned; use a new request id to try the action again',
        city_fee_credit: 'credit_returned',
        returned_usdc: '1.000000',
      },
    })
    const claim = database.calls[0]!
    assert.equal(claim.marker, 'claim-expired-spend')
    assert.match(claim.text, /recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu)
    assert.match(claim.text, /method\s*=\s*'credit'/iu)
    assert.match(claim.text, /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*\)/iu)
    assert.ok(claim.params.includes(7))
    assert.ok(claim.params.includes(ATTEMPT_ID))
    assert.equal(database.calls.filter(call => call.marker === 'return-spend').length, 1)
    assert.doesNotMatch(
      database.calls.map(call => call.text).join('\n'),
      /founder_issue|admin_credit|city-credit:issue/iu,
    )
  })

  test('deadline recovery duplicate replays the one append-only return without issuing credit', async () => {
    const response = {
      error: 'automatic recovery deadline reached; city fee credit returned; use a new request id to try the action again',
      city_fee_credit: 'credit_returned',
      returned_usdc: '1.000000',
    }
    const returned = spendRow({
      state: 'returned',
      status: 'credit_returned',
      lease_acquired: false,
      return_entry_id: '202',
      response_status: 409,
      response_json: response,
    })
    const database = new MarkerDatabase({
      'claim-expired-spend': [
        [expiredClaimRow()],
        [expiredClaimRow({ state: 'credit_returned', status: 'credit_returned', lease_owner: null })],
      ],
      'return-spend': [[returned]],
      'return-result': [[returned]],
      'expired-return-result': [[returned]],
    })

    const first = await returnExpiredCityCreditSpend(database, {
      actorId: 7,
      attemptId: ATTEMPT_ID,
    })
    assert.equal(first.state, 'credit_returned')
    if (first.state !== 'credit_returned') throw new Error('deadline credit return was not created')
    assert.equal(first.disposition, 'created')
    const replay = await returnExpiredCityCreditSpend(database, {
      actorId: 7,
      attemptId: ATTEMPT_ID,
    })

    assert.equal(replay.state, 'credit_returned')
    assert.equal(replay.disposition, 'existing')
    assert.equal(replay.return_entry_id, '202')
    assert.equal(database.calls.filter(call => call.marker === 'return-spend').length, 1)
    assert.equal(database.calls.filter(call => call.marker === 'expired-return-result').length, 1)
  })

  test('deadline recovery fails closed before the boundary, while another lease is active, or when absent', async () => {
    const database = new MarkerDatabase({
      'claim-expired-spend': [
        [expiredClaimRow({ state: 'not_due' })],
        [expiredClaimRow({ state: 'busy', lease_owner: null })],
        [],
      ],
    })

    assert.deepEqual(await returnExpiredCityCreditSpend(database, {
      actorId: 7,
      attemptId: ATTEMPT_ID,
    }), { state: 'not_due', attempt_id: ATTEMPT_ID })
    assert.deepEqual(await returnExpiredCityCreditSpend(database, {
      actorId: 7,
      attemptId: ATTEMPT_ID,
    }), { state: 'busy', attempt_id: ATTEMPT_ID })
    assert.deepEqual(await returnExpiredCityCreditSpend(database, {
      actorId: 7,
      attemptId: ATTEMPT_ID,
    }), { state: 'unavailable', attempt_id: ATTEMPT_ID })
    assert.equal(database.calls.filter(call => call.marker === 'return-spend').length, 0)
  })

  test('a later identical target starts only after its due credit spend is returned', async () => {
    const laterRequestId = 'frontier-request-0002'
    const laterAttemptId = 'credit_attempt_0002'
    const laterLeaseOwner = 'credit_lease_0002'
    const deadlineResponse = {
      error: 'automatic recovery deadline reached; city fee credit returned; use a new request id to try the action again',
      city_fee_credit: 'credit_returned',
      returned_usdc: '1.000000',
    }
    const returned = spendRow({
      state: 'returned',
      status: 'credit_returned',
      lease_acquired: false,
      return_entry_id: '202',
      response_status: 409,
      response_json: deadlineResponse,
    })
    const database = new MarkerDatabase({
      'begin-spend': [
        [spendRow({ state: 'busy', lease_acquired: false, lease_owner: null, recovery_due: true })],
        [spendRow({
          attempt_id: laterAttemptId,
          request_id: laterRequestId,
          lease_owner: laterLeaseOwner,
        })],
      ],
      'claim-expired-spend': [[expiredClaimRow()]],
      'return-spend': [[returned]],
      'return-result': [[returned]],
    })

    const result = await beginCityCreditSpend(database, spendInput({ requestId: laterRequestId }))

    assert.deepEqual(result, {
      state: 'ready',
      attempt_id: laterAttemptId,
      spend_entry_id: '201',
      lease_owner: laterLeaseOwner,
      amount: '1.000000',
      amount_units: '1000000',
    })
    assert.deepEqual(database.calls.map(call => call.marker), [
      'begin-spend',
      'claim-expired-spend',
      'return-spend',
      'return-result',
      'begin-spend',
    ])
  })

  test('a later identical target waits when another worker owns the due credit return', async () => {
    const database = new MarkerDatabase({
      'begin-spend': [[
        spendRow({ state: 'busy', lease_acquired: false, lease_owner: null, recovery_due: true }),
      ]],
      'claim-expired-spend': [[expiredClaimRow({ state: 'busy', lease_owner: null })]],
    })

    await assert.rejects(
      beginCityCreditSpend(database, spendInput({ requestId: 'frontier-request-0002' })),
      /deadline return|retry/iu,
    )
    assert.deepEqual(database.calls.map(call => call.marker), [
      'begin-spend',
      'claim-expired-spend',
    ])
  })

  test('deadline recovery rejects malformed identity and lease inputs before storage', async () => {
    const database = new MarkerDatabase({})
    for (const actorId of [0, 1.5, 2_147_483_648, '7']) {
      await assert.rejects(
        returnExpiredCityCreditSpend(database, {
          actorId: actorId as number,
          attemptId: ATTEMPT_ID,
        }),
        /actor id|positive integer/iu,
      )
    }
    for (const attemptId of [
      'short',
      'credit attempt spaces',
      `credit_attempt_${'a'.repeat(150)}`,
      `1f3d9_sk_${'ab'.repeat(24)}`,
    ]) {
      await assert.rejects(
        returnExpiredCityCreditSpend(database, { actorId: 7, attemptId }),
        /attempt id|identifier/iu,
      )
    }
    for (const leaseOwner of ['short', 'credit lease spaces', `credit_lease_${'a'.repeat(150)}`]) {
      await assert.rejects(
        returnExpiredCityCreditSpend(database, {
          actorId: 7,
          attemptId: ATTEMPT_ID,
          leaseOwner,
        }),
        /lease owner|identifier/iu,
      )
    }
    assert.equal(database.calls.length, 0)
  })

  test('credit returns reject unsafe terms and malformed durable deadline results', async () => {
    const noDatabase = new MarkerDatabase({})
    for (const reason of [
      '',
      ' padded ',
      'line\nbreak',
      'a'.repeat(241),
      `1f3d9_sk_${'ab'.repeat(24)}`,
    ]) {
      await assert.rejects(
        returnCityCreditSpend(noDatabase, {
          actorId: 7,
          attemptId: ATTEMPT_ID,
          leaseOwner: LEASE_OWNER,
          reason,
          responseStatus: 409,
          response: { error: 'credit returned' },
        }),
        /reason|safe|secret/iu,
      )
    }
    for (const responseStatus of [399, 400.5, 600]) {
      await assert.rejects(
        returnCityCreditSpend(noDatabase, {
          actorId: 7,
          attemptId: ATTEMPT_ID,
          leaseOwner: LEASE_OWNER,
          reason: 'automatic recovery deadline reached',
          responseStatus,
          response: { error: 'credit returned' },
        }),
        /response status|error status/iu,
      )
    }

    const missingReturn = new MarkerDatabase({
      'claim-expired-spend': [[expiredClaimRow({
        state: 'credit_returned', status: 'credit_returned', lease_owner: null,
      })]],
      'expired-return-result': [[]],
    })
    await assert.rejects(
      returnExpiredCityCreditSpend(missingReturn, { actorId: 7, attemptId: ATTEMPT_ID }),
      /exact|return|unavailable/iu,
    )

    const falseLease = new MarkerDatabase({
      'claim-expired-spend': [[expiredClaimRow({ lease_owner: 'different-lease-owner' })]],
    })
    await assert.rejects(
      returnExpiredCityCreditSpend(falseLease, { actorId: 7, attemptId: ATTEMPT_ID }),
      /safely leased/iu,
    )
  })
}
