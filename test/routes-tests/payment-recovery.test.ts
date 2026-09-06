import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerPaymentRecoveryTests(): void {
  const {
    SELLER_WALLET,
    TREASURY,
    TX_CASE_UPPER,
    X_PAYMENT,
    app,
    authHeaders,
    fixtureState,
    reset,
    setActor,
    test,
  } = getRoutesTestContext()


  test('frontier x402 retry after an interrupted completion uses the same authorization and does not settle twice', async () => {
    reset({
      scenario: 'paid claims',
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
      interruptTreasuryCompletionOnce: true,
    })
    const requestBody = JSON.stringify({
      parent_id: null,
      name: 'Retry Continent',
      description: 'same logical purchase',
    })

    const first = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: requestBody,
    })
    assert.equal(first.status, 500, await first.clone().text())
    assert.equal(fixtureState.current.calls.filter(call => call.url.includes('/settle')).length, 1)

    const retry = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: requestBody,
    })
    assert.equal(retry.status, 201)
    assert.ok(retry.headers.get('X-PAYMENT-RESPONSE'))
    assert.equal(fixtureState.current.calls.filter(call => call.url.includes('/settle')).length, 1)
    assert.equal(fixtureState.current.paymentHashes.size, 1)
  })

  test('frontier x402 retry can resume an interrupted payment without replaying X-PAYMENT', async () => {
    reset({
      scenario: 'paid claims',
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
      interruptTreasuryCompletionOnce: true,
    })
    const requestBody = JSON.stringify({
      parent_id: null,
      name: 'Headerless Retry Continent',
      description: 'same logical purchase',
    })

    const first = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: requestBody,
    })
    assert.equal(first.status, 500, await first.clone().text())
    assert.equal(fixtureState.current.calls.filter(call => call.url.includes('/settle')).length, 1)

    const retry = await app.request('/api/place', {
      method: 'POST',
      headers: authHeaders(),
      body: requestBody,
    })
    assert.equal(retry.status, 201, await retry.clone().text())
    assert.ok(retry.headers.get('X-PAYMENT-RESPONSE'))
    assert.equal(fixtureState.current.calls.filter(call => call.url.includes('/settle')).length, 1)
    assert.equal(fixtureState.current.paymentHashes.size, 1)
  })

  test('frontier x402 headerless retry fails closed when the request body changed', async () => {
    reset({
      scenario: 'paid claims',
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
      interruptTreasuryCompletionOnce: true,
    })
    const first = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({
        parent_id: null,
        name: 'Frozen Continent',
        description: 'original body',
      }),
    })
    assert.equal(first.status, 500, await first.clone().text())

    const retry = await app.request('/api/place', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        parent_id: null,
        name: 'Frozen Continent',
        description: 'mutated body',
      }),
    })
    assert.equal(retry.status, 409, await retry.clone().text())
    assert.match(await retry.text(), /payment attempt|immutable|different/i)
    assert.equal(fixtureState.current.calls.filter(call => call.url.includes('/settle')).length, 1)
  })

  test('frontier x402 completion at the recovery deadline has no domain effect and enters founder review', async () => {
    reset({
      scenario: 'treasury deadline passed',
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
    })

    const response = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({
        parent_id: null,
        name: 'Too Late Continent',
        description: 'must remain uncreated',
      }),
    })

    assert.equal(response.status, 409, await response.clone().text())
    const attempt = [...fixtureState.current.paymentAttempts.values()][0]
    assert.deepEqual(await response.json(), {
      payment: 'founder_review',
      payment_attempt_id: [...fixtureState.current.paymentAttempts.keys()][0],
      fee_tx: attempt?.tx_hash,
      do_not_pay_again: true,
      reason: 'frontier recovery deadline passed before completion',
    })
    assert.equal(attempt?.status, 'founder_review')
    assert.equal(attempt?.lease_owner, null)
    assert.equal(fixtureState.current.paymentHashes.size, 0)
    assert.equal(fixtureState.current.calls.filter(call =>
      /payment-treasury-operations:complete/iu.test(call.query ?? '')).length, 1)
  })

  test('kind invention can replay its completed canonical response without replaying X-PAYMENT', async () => {
    reset({
      scenario: 'paid claims',
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
    })
    const requestBody = JSON.stringify({
      name: 'replayable-kind',
      description: 'paid once',
      traits: [],
      recipe: [],
    })

    const first = await app.request('/api/kind', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: requestBody,
    })
    assert.equal(first.status, 201, await first.clone().text())
    const firstPaymentResponse = first.headers.get('X-PAYMENT-RESPONSE')
    const firstText = await first.clone().text()
    assert.ok(firstPaymentResponse)

    const replay = await app.request('/api/kind', {
      method: 'POST',
      headers: authHeaders(),
      body: requestBody,
    })
    assert.equal(replay.status, 201, await replay.clone().text())
    assert.equal(replay.headers.get('X-PAYMENT-RESPONSE'), firstPaymentResponse)
    assert.equal(await replay.text(), firstText)
    assert.equal(fixtureState.current.calls.filter(call => call.url.includes('/settle')).length, 1)
  })

  test('treasury completion returns the canonical stored x402 response header', async () => {
    const canonicalHeader = Buffer.from(JSON.stringify({
      success: true,
      transaction: TX_CASE_UPPER,
      recovered: true,
    })).toString('base64')
    reset({
      scenario: 'paid claims',
      facilitatorVerify: true,
      facilitatorSettle: true,
      chainFrom: SELLER_WALLET,
      chainTo: TREASURY,
      treasuryCompletionHeader: canonicalHeader,
    })

    const response = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-PAYMENT': X_PAYMENT },
      body: JSON.stringify({
        parent_id: null,
        name: 'Canonical Header Continent',
        description: 'uses the durable header reloaded by completion',
      }),
    })

    assert.equal(response.status, 201, await response.clone().text())
    assert.equal(response.headers.get('X-PAYMENT-RESPONSE'), canonicalHeader)
  })

  test('only founder resident one issues one private city fee credit and exact retries do not issue twice', async () => {
    reset()
    const issuanceBody = JSON.stringify({
      resident_handle: 'tiny-lantern',
      source_key: 'wave4-grant-0001',
      reason: 'Wave 4 route test grant',
    })

    const nonFounder = await app.request('/api/founder/city-credit', {
      method: 'POST', headers: authHeaders(), body: issuanceBody,
    })
    assert.equal(nonFounder.status, 403)
    assert.equal(fixtureState.current.cityCreditEntries.length, 0)

    const nonFounderRead = await app.request('/api/founder/city-credit/tiny-lantern', {
      headers: authHeaders(),
    })
    assert.equal(nonFounderRead.status, 403)

    setActor(1, 'founder')
    const issued = await app.request('/api/founder/city-credit', {
      method: 'POST', headers: authHeaders(), body: issuanceBody,
    })
    assert.equal(issued.status, 201, await issued.clone().text())
    const issuedBody = await issued.json() as {
      resident_handle: string
      city_fee_credit: Record<string, unknown>
    }
    assert.equal(issuedBody.resident_handle, 'tiny-lantern')
    assert.deepEqual(issuedBody.city_fee_credit, {
      disposition: 'created',
      entry_id: '1',
      resident_id: 7,
      amount: '1.000000',
      amount_units: '1000000',
      balance: '1.000000',
      balance_usdc: '1.000000',
      balance_units: '1000000',
      reason: 'Wave 4 route test grant',
      created_at: '2026-08-11T00:00:00.000Z',
    })
    assert.equal(issued.headers.get('cache-control'), 'no-store')

    const retried = await app.request('/api/founder/city-credit', {
      method: 'POST', headers: authHeaders(), body: issuanceBody,
    })
    assert.equal(retried.status, 200, await retried.clone().text())
    assert.equal((await retried.json() as {
      city_fee_credit: { disposition: string }
    }).city_fee_credit.disposition, 'existing')
    assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'founder_issue').length, 1)
    assert.equal(fixtureState.current.cityCreditBalances.get(7), 1_000_000n)

    const changed = await app.request('/api/founder/city-credit', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        resident_handle: 'tiny-lantern',
        source_key: 'wave4-grant-0001',
        reason: 'changed reason must conflict',
      }),
    })
    assert.equal(changed.status, 409, await changed.clone().text())
    assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'founder_issue').length, 1)

    const founderRead = await app.request('/api/founder/city-credit/tiny-lantern', {
      headers: authHeaders(),
    })
    assert.equal(founderRead.status, 200)
    assert.equal(founderRead.headers.get('cache-control'), 'no-store')
    assert.deepEqual((await founderRead.json() as { paypal_disputes: unknown[] }).paypal_disputes, [])

    setActor(7, 'tiny-lantern')
    const me = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(me.status, 200, await me.clone().text())
    const meBody = await me.json() as {
      city_fee_credit: { balance_usdc: string; history: Array<{ kind: string }> }
    }
    assert.equal(meBody.city_fee_credit.balance_usdc, '1.000000')
    assert.deepEqual(meBody.city_fee_credit.history.map(entry => entry.kind), ['founder_issue'])
    assert.equal(me.headers.get('cache-control'), 'no-store')

    const officialText = await (await app.request('/api/official')).text()
    const treasuryText = await (await app.request('/treasury')).text()
    assert.doesNotMatch(officialText + treasuryText, /wave4-grant-0001|1000000/u)
  })
}
