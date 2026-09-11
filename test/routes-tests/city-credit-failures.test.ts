import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'

import {
  CITY_CREDIT_ROUTE_CASES,
  assertCityCreditNoStore,
  cityCreditDomainWriteCount,
} from '../helpers/routes-fixtures/city-credit.ts'

export function registerCityCreditFailuresTests(): void {
  const {
    SELLER_WALLET,
    TREASURY,
    X_PAYMENT,
    app,
    authHeaders,
    fixtureState,
    networkCalled,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('every city-credit fee action fails validation before debit', async () => {
    for (const creditCase of CITY_CREDIT_ROUTE_CASES) {
      reset({
        scenario: 'paid claims',
        cityCreditBalances: new Map([[7, 1_000_000n]]),
      })
      const response = await app.request(creditCase.path, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'X-1F3D9-FEE-CREDIT': `${creditCase.requestId}-before`,
        },
        body: JSON.stringify(creditCase.invalidBody),
      })
      assert.equal(response.status, 400, `${creditCase.label}: ${await response.clone().text()}`)
      assertCityCreditNoStore(response, `${creditCase.label} pre-debit failure`)
      assert.equal(fixtureState.current.cityCreditBalances.get(7), 1_000_000n, creditCase.label)
      assert.equal(fixtureState.current.cityCreditEntries.length, 0, creditCase.label)
      assert.equal(fixtureState.current.paymentAttempts.size, 0, creditCase.label)
      assert.equal(cityCreditDomainWriteCount(), 0, creditCase.label)
      assert.equal(networkCalled('/verify'), false, creditCase.label)
      assert.equal(networkCalled('/settle'), false, creditCase.label)
    }
  })

  test('every post-debit city-credit fee failure appends one exact return and replays it', async () => {
    for (const creditCase of CITY_CREDIT_ROUTE_CASES) {
      reset({
        scenario: 'paid claims',
        cityCreditBalances: new Map([[7, 1_000_000n]]),
        failPaidWriteOnce: true,
      })
      const requestBody = JSON.stringify(creditCase.body)
      const headers = {
        ...authHeaders(),
        'X-1F3D9-FEE-CREDIT': `${creditCase.requestId}-return`,
      }
      const first = await app.request(creditCase.path, {
        method: 'POST', headers, body: requestBody,
      })
      assert.equal(first.status, 409, `${creditCase.label}: ${await first.clone().text()}`)
      assertCityCreditNoStore(first, `${creditCase.label} returned error`)
      const firstText = await first.text()
      const requestId = first.headers.get('x-request-id')
      assert.match(requestId ?? '', /^[0-9a-f-]{36}$/iu, creditCase.label)
      assert.deepEqual(JSON.parse(firstText), {
        error: `${creditCase.failureReason}; city fee credit returned`,
        city_fee_credit: 'credit_returned',
        returned_usdc: '1.000000',
        request_id: requestId,
        error_class: 'conflict',
        http_status: 409,
        front_door_tool: 'front_door',
        front_door: 'https://1f3d9.com/',
      }, creditCase.label)
      assert.equal(fixtureState.current.cityCreditBalances.get(7), 1_000_000n, creditCase.label)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1, creditCase.label)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'return').length, 1, creditCase.label)
      assert.equal(cityCreditDomainWriteCount(), 1, creditCase.label)

      const replay = await app.request(creditCase.path, {
        method: 'POST', headers, body: requestBody,
      })
      assert.equal(replay.status, 409, `${creditCase.label}: ${await replay.clone().text()}`)
      assertCityCreditNoStore(replay, `${creditCase.label} returned replay`)
      const replayBody = JSON.parse(await replay.text()) as Record<string, unknown>
      const replayRequestId = replay.headers.get('x-request-id')
      assert.match(replayRequestId ?? '', /^[0-9a-f-]{36}$/iu, creditCase.label)
      assert.notEqual(replayRequestId, requestId, creditCase.label)
      assert.deepEqual(replayBody, {
        error: `${creditCase.failureReason}; city fee credit returned`,
        city_fee_credit: 'credit_returned',
        returned_usdc: '1.000000',
        request_id: replayRequestId,
        error_class: 'conflict',
        http_status: 409,
        front_door_tool: 'front_door',
        front_door: 'https://1f3d9.com/',
      }, creditCase.label)
      assert.equal(
        sqlCalls().filter(call => /insert\s+into\s+resident_refusal_state/iu.test(call.query ?? '')).length,
        0,
        `${creditCase.label}: byte-exact payment replay must stay outside anti-loop state`,
      )
      assert.equal(fixtureState.current.cityCreditBalances.get(7), 1_000_000n, creditCase.label)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1, creditCase.label)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'return').length, 1, creditCase.label)
      assert.equal(cityCreditDomainWriteCount(), 1, `${creditCase.label}: replay repeated the failed domain write`)
      assert.equal(networkCalled('/settle'), false, creditCase.label)
    }
  })

  test('every post-debit paid database failure is logged before its honest temporary refusal', async () => {
    for (const creditCase of CITY_CREDIT_ROUTE_CASES) {
      reset({
        scenario: 'paid claims',
        cityCreditBalances: new Map([[7, 1_000_000n]]),
        paidCompletionFailure: {
          code: '42883',
          constraint: 'payment_attempts_completion_body_check',
          message: 'operator does not exist at postgresql://resident-secret@fake-host.example/city with Bearer private-token and 1f3d9_sk_private-key',
        },
      })
      const logged: unknown[][] = []
      const originalConsoleError = console.error
      console.error = (...values: unknown[]) => logged.push(values)
      try {
        const response = await app.request(creditCase.path, {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'X-1F3D9-FEE-CREDIT': `${creditCase.requestId}-database-failure`,
          },
          body: JSON.stringify(creditCase.body),
        })
        assert.equal(response.status, 503, `${creditCase.label}: ${await response.clone().text()}`)
        assertCityCreditNoStore(response, `${creditCase.label} database failure`)
        assert.deepEqual(await response.json(), {
          error: `${creditCase.temporaryFailure}; city fee credit returned`,
          city_fee_credit: 'credit_returned',
          returned_usdc: '1.000000',
        }, creditCase.label)
        assert.equal(fixtureState.current.cityCreditBalances.get(7), 1_000_000n, creditCase.label)
        assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1, creditCase.label)
        assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'return').length, 1, creditCase.label)
        assert.equal(logged.length, 1, creditCase.label)
        assert.equal(logged[0]?.[0], 'treasury_completion_failure', creditCase.label)
        const diagnostic = JSON.parse(String(logged[0]?.[1] ?? '{}')) as Record<string, unknown>
        assert.equal(diagnostic.operation, creditCase.operation, creditCase.label)
        assert.equal(diagnostic.rail, 'credit', creditCase.label)
        assert.equal(diagnostic.error_code, '42883', creditCase.label)
        assert.equal(diagnostic.constraint, 'payment_attempts_completion_body_check', creditCase.label)
        assert.equal(diagnostic.status, 503, creditCase.label)
        assert.match(typeof diagnostic.attempt_id === 'string' ? diagnostic.attempt_id : '', /^credit_attempt_[0-9a-f]+$/, creditCase.label)
        assert.doesNotMatch(JSON.stringify(diagnostic), /fake-host\.example|private-token|1f3d9_sk_/iu, creditCase.label)
      } finally {
        console.error = originalConsoleError
      }
    }
  })

  test('a paid kind check violation stays a temporary city fault instead of blaming the caller', async () => {
    reset({
      scenario: 'paid claims',
      cityCreditBalances: new Map([[7, 1_000_000n]]),
      paidCompletionFailure: {
        code: '23514',
        constraint: 'payment_attempts_completion_body_check',
        message: 'stored completion response violates an internal payment invariant',
      },
    })
    const logged: unknown[][] = []
    const originalConsoleError = console.error
    console.error = (...values: unknown[]) => logged.push(values)
    try {
      const response = await app.request('/api/kind', {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'X-1F3D9-FEE-CREDIT': 'wave4-kind-check-violation',
        },
        body: JSON.stringify({
          name: 'check-violation-kind',
          description: 'the database invariant belongs to the city',
          traits: [],
          recipe: [],
        }),
      })
      assert.equal(response.status, 503, await response.clone().text())
      assert.deepEqual(await response.json(), {
        error: 'kind invention failed before completion; city fee credit returned',
        city_fee_credit: 'credit_returned',
        returned_usdc: '1.000000',
      })
      assert.equal(fixtureState.current.cityCreditBalances.get(7), 1_000_000n)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'return').length, 1)
      assert.equal(logged.length, 1)
      const diagnostic = JSON.parse(String(logged[0]?.[1] ?? '{}')) as Record<string, unknown>
      assert.equal(diagnostic.error_code, '23514')
      assert.equal(diagnostic.constraint, 'payment_attempts_completion_body_check')
      assert.equal(diagnostic.status, 503)
    } finally {
      console.error = originalConsoleError
    }
  })

  test('an ambiguous credit return logs the client-visible 202 rather than the intended refusal', async () => {
    reset({
      scenario: 'paid claims',
      cityCreditBalances: new Map([[7, 1_000_000n]]),
      failCreditReturnOnce: true,
      paidCompletionFailure: {
        code: '42883',
        message: 'operator does not exist after the paid kind debit',
      },
    })
    const logged: unknown[][] = []
    const originalConsoleError = console.error
    console.error = (...values: unknown[]) => logged.push(values)
    try {
      const response = await app.request('/api/kind', {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'X-1F3D9-FEE-CREDIT': 'wave4-kind-return-ambiguous',
        },
        body: JSON.stringify({
          name: 'ambiguous-return-kind',
          description: 'the return response is interrupted',
          traits: [],
          recipe: [],
        }),
      })
      assert.equal(response.status, 202, await response.clone().text())
      assertCityCreditNoStore(response, 'ambiguous credit return')
      const body = await response.json() as Record<string, unknown>
      assert.equal(body.city_fee_credit, 'payment_pending')
      assert.match(String(body.credit_attempt_id ?? ''), /^credit_attempt_[0-9a-f]+$/u)
      assert.equal(fixtureState.current.cityCreditBalances.get(7), 0n)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'return').length, 0)
      assert.equal(logged.length, 1)
      const diagnostic = JSON.parse(String(logged[0]?.[1] ?? '{}')) as Record<string, unknown>
      assert.equal(diagnostic.event, 'treasury_completion_failure')
      assert.equal(diagnostic.error_code, '42883')
      assert.equal(diagnostic.status, 202)
    } finally {
      console.error = originalConsoleError
    }
  })

  test('an unexpected x402 completion failure is logged once by the global request boundary', async () => {
    reset({
      scenario: 'paid claims',
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
      interruptTreasuryCompletionOnce: true,
    })
    const logged: unknown[][] = []
    const originalConsoleError = console.error
    console.error = (...values: unknown[]) => logged.push(values)
    try {
      const response = await app.request('/api/place', {
        method: 'POST',
        headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
        body: JSON.stringify({
          parent_id: null,
          name: 'Single Log Continent',
          description: 'one unexpected failure, one diagnostic',
        }),
      })
      assert.equal(response.status, 500, await response.clone().text())
      assert.equal(logged.filter(values => values[0] === 'treasury_completion_failure').length, 0)
      const requestFailures = logged.filter(values => values[0] === 'request_failure')
      assert.equal(requestFailures.length, 1)
      const diagnostic = JSON.parse(String(requestFailures[0]?.[1] ?? '{}')) as Record<string, unknown>
      assert.equal(diagnostic.error_code, '57P01')
      assert.equal(diagnostic.status, 500)
    } finally {
      console.error = originalConsoleError
    }
  })

  test('an x402 conflict is not logged as 409 before founder review is durably recorded', async () => {
    reset({
      scenario: 'paid claims',
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
      failFounderReviewOnce: true,
      paidCompletionFailure: {
        code: '23505',
        constraint: 'places_parent_id_lower_name_key',
        message: 'duplicate place name after settlement',
      },
    })
    const logged: unknown[][] = []
    const originalConsoleError = console.error
    console.error = (...values: unknown[]) => logged.push(values)
    try {
      const response = await app.request('/api/place', {
        method: 'POST',
        headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
        body: JSON.stringify({
          parent_id: null,
          name: 'Founder Review Interrupted',
          description: 'the conflict cannot be reported until review is durable',
        }),
      })
      assert.equal(response.status, 500, await response.clone().text())
      assert.equal(logged.filter(values => values[0] === 'treasury_completion_failure').length, 0)
      const requestFailures = logged.filter(values => values[0] === 'request_failure')
      assert.equal(requestFailures.length, 1)
      const diagnostic = JSON.parse(String(requestFailures[0]?.[1] ?? '{}')) as Record<string, unknown>
      assert.equal(diagnostic.error_code, '57P01')
      assert.equal(diagnostic.status, 500)
    } finally {
      console.error = originalConsoleError
    }
  })

  test('every x402 conflict is logged once after founder review is durably recorded', async () => {
    for (const paidCase of CITY_CREDIT_ROUTE_CASES) {
      reset({
        scenario: 'paid claims',
        facilitatorVerify: true,
        facilitatorSettle: true,
        chainFrom: SELLER_WALLET,
        chainTo: TREASURY,
        paidCompletionFailure: {
          code: '23505',
          constraint: 'paid_completion_unique_key',
          message: 'paid completion conflict after settlement',
        },
      })
      const logged: unknown[][] = []
      const originalConsoleError = console.error
      console.error = (...values: unknown[]) => logged.push(values)
      try {
        const response = await app.request(paidCase.path, {
          method: 'POST',
          headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
          body: JSON.stringify(paidCase.body),
        })
        assert.equal(response.status, 409, `${paidCase.label}: ${await response.clone().text()}`)
        const body = await response.json() as Record<string, unknown>
        assert.equal(body.payment, 'founder_review', paidCase.label)
        const attempt = fixtureState.current.paymentAttempts.get(String(body.payment_attempt_id ?? ''))
        assert.equal(attempt?.status, 'founder_review', paidCase.label)
        assert.equal(logged.filter(values => values[0] === 'request_failure').length, 0, paidCase.label)
        const completionFailures = logged.filter(values => values[0] === 'treasury_completion_failure')
        assert.equal(completionFailures.length, 1, paidCase.label)
        const diagnostic = JSON.parse(String(completionFailures[0]?.[1] ?? '{}')) as Record<string, unknown>
        assert.equal(diagnostic.operation, paidCase.operation, paidCase.label)
        assert.equal(diagnostic.rail, 'x402', paidCase.label)
        assert.equal(diagnostic.error_code, '23505', paidCase.label)
        assert.equal(diagnostic.status, 409, paidCase.label)
      } finally {
        console.error = originalConsoleError
      }
    }
  })

  test('concurrent duplicate city-credit fee calls make one debit and one domain effect for every action', async () => {
    for (const creditCase of CITY_CREDIT_ROUTE_CASES) {
      reset({
        scenario: 'paid claims',
        cityCreditBalances: new Map([[7, 1_000_000n]]),
      })
      const requestBody = JSON.stringify(creditCase.body)
      const headers = {
        ...authHeaders(),
        'X-1F3D9-FEE-CREDIT': `${creditCase.requestId}-race`,
      }
      const responses = await Promise.all([
        app.request(creditCase.path, { method: 'POST', headers, body: requestBody }),
        app.request(creditCase.path, { method: 'POST', headers, body: requestBody }),
      ])
      const success = responses.find(response => response.status === creditCase.status)
      assert.ok(success, `${creditCase.label}: concurrent calls did not complete one domain effect`)
      for (const response of responses) {
        assertCityCreditNoStore(response, `${creditCase.label} concurrent response`)
        assert.ok(
          response.status === creditCase.status || response.status === 202,
          `${creditCase.label}: unexpected concurrent status ${response.status}: ${await response.clone().text()}`,
        )
      }
      const successText = await success.text()
      const exactReplay = await app.request(creditCase.path, {
        method: 'POST', headers, body: requestBody,
      })
      assert.equal(exactReplay.status, creditCase.status, `${creditCase.label}: ${await exactReplay.clone().text()}`)
      assertCityCreditNoStore(exactReplay, `${creditCase.label} concurrent replay`)
      assert.equal(await exactReplay.text(), successText, creditCase.label)
      assert.equal(fixtureState.current.cityCreditBalances.get(7), 0n, creditCase.label)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1, creditCase.label)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'return').length, 0, creditCase.label)
      assert.equal(fixtureState.current.paymentAttempts.size, 1, creditCase.label)
      assert.equal(cityCreditDomainWriteCount(), 1, creditCase.label)
      assert.equal(networkCalled('/verify'), false, creditCase.label)
      assert.equal(networkCalled('/settle'), false, creditCase.label)
    }
  })
}
