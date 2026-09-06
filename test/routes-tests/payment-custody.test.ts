import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerPaymentCustodyTests(): void {
  const {
    BUYER_WALLET,
    SELLER_WALLET,
    TREASURY,
    TX1,
    TX_CASE_UPPER,
    X_PAYMENT,
    X_PAYMENT_NO_ID,
    app,
    authHeaders,
    fixtureState,
    networkCalled,
    reset,
    test,
  } = getRoutesTestContext()


  test('x402 paid creation uses the signed nonce without a payment-identifier extension', async () => {
    reset({
      scenario: 'paid claims',
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
    })
    const response = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT_NO_ID },
      body: JSON.stringify({ parent_id: null, name: 'Needs Id', description: 'frontier' }),
    })

    assert.equal(response.status, 201, await response.clone().text())
    assert.equal(networkCalled('/settle'), true)
  })

  test('hosted production paid routes fail closed before custody schema readiness', async () => {
    const previousVercel = process.env.VERCEL
    const previousVercelEnv = process.env.VERCEL_ENV
    const previousReady = process.env.PAYMENT_CUSTODY_READY
    process.env.VERCEL = '1'
    process.env.VERCEL_ENV = 'production'
    delete process.env.PAYMENT_CUSTODY_READY
    try {
      reset({
        scenario: 'paid claims',
        facilitatorVerify: true,
        facilitatorSettle: true,
        chainFrom: SELLER_WALLET,
        chainTo: TREASURY,
      })
      const frontier = await app.request('/api/place', {
        method: 'POST',
        headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
        body: JSON.stringify({ parent_id: null, name: 'Paused Continent', description: 'frontier' }),
      })
      const kind = await app.request('/api/kind', {
        method: 'POST',
        headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
        body: JSON.stringify({
          name: 'paused-lantern',
          description: 'payment custody is not ready',
          traits: [],
          recipe: [],
        }),
      })
      const kindRevision = await app.request('/api/kind/3/revise', {
        method: 'POST',
        headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
        body: JSON.stringify({
          description: 'still blocked',
          traits: ['glowing'],
          recipe: [],
        }),
      })
      const directSale = await app.request('/api/transfer/90/claim', {
        method: 'POST',
        headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
        body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
      })

      for (const response of [frontier, kind, kindRevision, directSale]) {
        assert.equal(response.status, 503, await response.clone().text())
        assert.match(await response.text(), /payments are temporarily unavailable/i)
      }
      assert.equal(networkCalled('/settle'), false)
      assert.equal(fixtureState.current.calls.some(call => /payment_attempts/i.test(call.query ?? '')), false)
    } finally {
      if (previousVercel == null) delete process.env.VERCEL
      else process.env.VERCEL = previousVercel
      if (previousVercelEnv == null) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = previousVercelEnv
      if (previousReady == null) delete process.env.PAYMENT_CUSTODY_READY
      else process.env.PAYMENT_CUSTODY_READY = previousReady
    }
  })

  test('paid routes never verify or settle when exact replay storage is absent', async () => {
    reset({
      scenario: 'paid claims',
      paymentReplaySchemaReady: false,
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
    })
    const response = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({ parent_id: null, name: 'Schema Guard', description: 'must not settle' }),
    })

    assert.equal(response.status, 503, await response.clone().text())
    assert.deepEqual(await response.json(), {
      error: 'payments are temporarily unavailable while durable payment custody is being upgraded; do not pay or retry yet',
      do_not_pay_again: true,
    })
    assert.equal(networkCalled('/verify'), false)
    assert.equal(networkCalled('/settle'), false)
    assert.ok(fixtureState.current.calls.some(call =>
      call.query?.includes('payment-attempts:response-replay-ready')))
  })

  test('the same signed x402 nonce cannot be rebound to a different paid purpose', async () => {
    reset({
      scenario: 'paid claims',
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
    })
    const frontier = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({ parent_id: null, name: 'Bound Continent', description: 'frontier' }),
    })
    assert.equal(frontier.status, 201, await frontier.clone().text())

    const rebound = await app.request('/api/kind', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({
        name: 'rebound-lantern',
        description: 'should fail',
        traits: [],
        recipe: [],
      }),
    })
    assert.equal(rebound.status, 409, await rebound.clone().text())
    assert.match(await rebound.text(), /payment attempt|immutable|different/i)
    assert.equal(fixtureState.current.calls.filter(call => call.url.includes('/settle')).length, 1)
  })

  test('frontier x402 records custody before settlement and raw transaction proofs stay disabled', async () => {
    reset({
      scenario: 'paid claims', facilitatorVerify: true, facilitatorSettle: true,
      chainFrom: SELLER_WALLET, chainTo: TREASURY,
    })
    const frontier = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({ parent_id: null, name: 'Second Continent', description: 'frontier' }),
    })
    assert.equal(frontier.status, 201, await frontier.clone().text())
    const verifyIndex = fixtureState.current.calls.findIndex(call => call.url.includes('/verify'))
    const settleIndex = fixtureState.current.calls.findIndex(call => call.url.includes('/settle'))
    const attemptIndex = fixtureState.current.calls.findIndex(call => /insert\s+into\s+payment_attempts/i.test(call.query ?? ''))
    const insertIndex = fixtureState.current.calls.findIndex(call => /insert\s+into\s+places/i.test(call.query ?? ''))
    assert.ok(verifyIndex >= 0 && attemptIndex >= 0 && settleIndex > attemptIndex && insertIndex > settleIndex)

    const first = await app.request('/api/kind', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        name: 'lantern', description: 'a light', traits: [], recipe: [],
        payer_wallet: SELLER_WALLET, fee_tx_hash: TX1,
      }),
    })
    assert.equal(first.status, 400)

    const replay = await app.request('/api/place', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        parent_id: null, name: 'Replay Continent', description: 'must fail',
        payer_wallet: SELLER_WALLET, fee_tx_hash: TX_CASE_UPPER,
      }),
    })
    assert.equal(replay.status, 400)
    assert.match(JSON.stringify(await replay.json()), /does not accept|x-payment/i)
  })
}
