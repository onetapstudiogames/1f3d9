import assert from 'node:assert/strict'
import test from 'node:test'
import { makeHarness, jsonHeaders } from '../helpers/world-market-fixtures/harness.ts'
import { BUYER_SECRET, SELLER_WALLET, BUYER_WALLET, OTHER_WALLET, TX, COMPLETED_RESPONSE, X_PAYMENT, X_PAYMENT_NO_ID, NOW, type FakeOffer, draft, checkout, openOffer, fakePaymentAttempt, worldSaleRequestHash } from '../helpers/world-market-fixtures/offers.ts'

export function registerPaymentTests(): void {
  test('payment closes ownership atomically and a retry returns the same public receipt', async () => {
    const reserved = openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_listing_id: 91,
      market_checkout_id: 81,
      reserved_at: NOW.toISOString(),
      reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
    })
    const harness = makeHarness({
      offer: reserved,
      thingLocked: true,
      marketFailure: true,
      draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'withdrawn' }),
    })
    const pay = () => harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT },
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })
    const first = await pay()
    assert.equal(first.status, 200, await first.clone().text())
    const firstText = await first.clone().text()
    const firstPaymentResponse = first.headers.get('X-PAYMENT-RESPONSE')
    const firstBody = await first.json() as { offer: FakeOffer & { phase: string } }
    assert.equal(firstBody.offer.phase, 'claimed')
    assert.equal(firstBody.offer.maker_id, 6)
    assert.equal(firstBody.offer.made_by, 'old-maker')
    assert.equal(firstBody.offer.current_owner_id, 8)
    assert.equal(firstBody.offer.current_owner, 'neighbor')
    assert.equal(firstBody.offer.buyer, 'neighbor')
    assert.equal(firstBody.offer.from, BUYER_WALLET)
    assert.equal(firstBody.offer.to, SELLER_WALLET)
    assert.equal(firstBody.offer.tx_hash, TX)
    assert.equal(harness.getState().thingOwner, 8)
    assert.ok(harness.getState().queries.some(call =>
      call.text.includes('payment-sale-operations:complete-world') && /payment_uses/i.test(call.text) &&
      /sale_payments/i.test(call.text) && /update\s+things/i.test(call.text) && /insert\s+into\s+transfers/i.test(call.text)))
    const guardedClaim = harness.getState().queries.find(call =>
      call.text.includes('payment-sale-operations:complete-world'))
    assert.match(guardedClaim?.text ?? '', /date_trunc\('second', offer\.reserved_at\)/i)
    assert.match(guardedClaim?.text ?? '', /complete_payment_attempt/i)
    assert.match(guardedClaim?.text ?? '', /'maker_id'/i)
    assert.match(guardedClaim?.text ?? '', /'made_by'/i)
    assert.match(guardedClaim?.text ?? '', /'current_owner_id'/i)
    assert.match(guardedClaim?.text ?? '', /'current_owner'/i)
    assert.match(
      guardedClaim?.text ?? '',
      /UPDATE\s+things\s+SET\s+owner_id\s*=\s*offer\.buyer_id\s*,\s*active_offer_id\s*=\s*NULL\s+FROM/i,
    )

    const changedWallet = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ buyer_wallet: OTHER_WALLET }),
    })
    assert.equal(changedWallet.status, 409)
    const changedCheckout = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 82 }),
    })
    assert.equal(changedCheckout.status, 409)

    const retry = await pay()
    assert.equal(retry.status, 200)
    assert.equal(await retry.clone().text(), firstText)
    assert.equal(retry.headers.get('X-PAYMENT-RESPONSE'), firstPaymentResponse)
    assert.deepEqual(await retry.json(), firstBody)
    assert.equal(harness.getState().directVerifications, 1)
  })

  test('a completed payment replay preserves its x402 response header', async () => {
    const now = NOW.toISOString()
    const settledOffer = openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_listing_id: 91,
      market_checkout_id: 81,
      reserved_at: now,
      reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
    })
    const paymentAttempt = {
      ...fakePaymentAttempt(now),
      status: 'completed' as const,
      requestHash: worldSaleRequestHash(settledOffer),
      responseStatus: 200,
      response: { offer: { id: 101, phase: 'claimed' } },
      completedAt: now,
    }
    const harness = makeHarness({
      offer: settledOffer,
      thingLocked: true,
      paymentAttempt,
    })

    const response = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT },
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })

    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('X-PAYMENT-RESPONSE'), COMPLETED_RESPONSE)
    assert.equal(harness.getState().facilitatorSettlements, 0)
  })

  test('a claimed world replay rejects a different checkout binding', async () => {
    const reserved = openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_listing_id: 91,
      market_checkout_id: 81,
      reserved_at: NOW.toISOString(),
      reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
    })
    const harness = makeHarness({
      offer: reserved,
      thingLocked: true,
      marketFailure: true,
      draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'withdrawn' }),
    })
    const first = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT },
      body: '{}',
    })
    assert.equal(first.status, 200, await first.clone().text())
    const verificationsBeforeReplay = harness.getState().directVerifications

    const replay = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 82 }),
    })
    assert.equal(replay.status, 409, await replay.clone().text())
    assert.match(await replay.text(), /market_checkout_id does not match the settled payment/i)
    assert.equal(harness.getState().directVerifications, verificationsBeforeReplay)

    const exactRetry = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: jsonHeaders(BUYER_SECRET),
      body: '{}',
    })
    assert.equal(exactRetry.status, 200, await exactRetry.clone().text())
    assert.equal(harness.getState().directVerifications, verificationsBeforeReplay)
  })

  test('world x402 claim uses the signed authorization nonce without a payment-identifier extension', async () => {
    const reserved = openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_listing_id: 91,
      market_checkout_id: 81,
      reserved_at: NOW.toISOString(),
      reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
    })
    const harness = makeHarness({ offer: reserved, thingLocked: true, marketFailure: true })
    const response = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT_NO_ID },
      body: '{}',
    })

    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(harness.getState().facilitatorSettlements, 1)
  })

  test('hosted world claims fail closed before custody schema readiness', async () => {
    const previousVercel = process.env.VERCEL
    const previousVercelEnv = process.env.VERCEL_ENV
    const previousReady = process.env.PAYMENT_CUSTODY_READY
    process.env.VERCEL = '1'
    process.env.VERCEL_ENV = 'production'
    delete process.env.PAYMENT_CUSTODY_READY
    try {
      const harness = makeHarness({
        thingLocked: true,
        offer: openOffer({
          buyer_id: 8,
          buyer: 'neighbor',
          reserved_by: 8,
          buyer_wallet: BUYER_WALLET,
          reserved_at: NOW.toISOString(),
          reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
        }),
      })
      const response = await harness.app.request('/api/world/offer/101/claim', {
        method: 'POST',
        headers: { ...jsonHeaders(BUYER_SECRET), 'X-PAYMENT': X_PAYMENT },
        body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
      })

      assert.equal(response.status, 503, await response.clone().text())
      assert.match(await response.text(), /payments are temporarily unavailable/i)
      assert.equal(harness.getState().facilitatorSettlements, 0)
      assert.equal(harness.getState().queries.length, 0)
    } finally {
      if (previousVercel == null) delete process.env.VERCEL
      else process.env.VERCEL = previousVercel
      if (previousVercelEnv == null) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = previousVercelEnv
      if (previousReady == null) delete process.env.PAYMENT_CUSTODY_READY
      else process.env.PAYMENT_CUSTODY_READY = previousReady
    }
  })

}
