import assert from 'node:assert/strict'
import test from 'node:test'
import { makeHarness, jsonHeaders } from '../helpers/world-market-fixtures/harness.ts'
import { SELLER_SECRET, BUYER_SECRET, OTHER_SECRET, SELLER_WALLET, BUYER_WALLET, OTHER_WALLET, TX, SETTLED_RESPONSE, X_PAYMENT, NOW, type FakeOffer, draft, listing, openOffer } from '../helpers/world-market-fixtures/offers.ts'

export function registerReconciliationTests(): void {
  test('x402 claims re-read the confirmed transfer and publish its in-window block time', async () => {
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
      headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT },
      body: '{}',
    })

    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('x-payment-response'), SETTLED_RESPONSE)
    const offer = (await response.json() as { offer: FakeOffer }).offer
    assert.equal(offer.verified_via, 'x402')
    assert.equal(offer.block_time, NOW.toISOString())
    assert.equal(offer.from, BUYER_WALLET)
    assert.equal(offer.to, SELLER_WALLET)
    assert.equal(harness.getState().directVerifications, 1)
  })

  test('a settled x402 payment stays locked while Base indexing catches up and finalizes once', async () => {
    const reservedAt = NOW.toISOString()
    const reservedUntil = new Date(NOW.getTime() + 300_000).toISOString()
    const harness = makeHarness({
      offer: openOffer({
        buyer_id: 8,
        buyer: 'neighbor',
        reserved_by: 8,
        buyer_wallet: BUYER_WALLET,
        market_listing_id: 91,
        market_checkout_id: 81,
        reserved_at: reservedAt,
        reserved_until: reservedUntil,
      }),
      thingLocked: true,
      directVerificationAvailable: false,
      directBlockTime: new Date(NOW.getTime() + 60_000).toISOString(),
    })

    const settle = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT },
      body: '{}',
    })
    assert.equal(settle.status, 202, await settle.clone().text())
    const pending = (await settle.json() as { offer: FakeOffer & { phase: string } }).offer
    assert.equal(pending.phase, 'payment_pending')
    assert.equal(pending.pending_x402_tx_hash, TX)
    assert.equal(harness.getState().facilitatorSettlements, 1)
    assert.equal(harness.getState().thingLocked, true)
    const attemptIndex = harness.getState().queries.findIndex(call =>
      /insert\s+into\s+payment_attempts/i.test(call.text))
    const pendingIndex = harness.getState().queries.findIndex(call =>
      call.text.includes('payment-sale-operations:park-world'))
    assert.ok(attemptIndex >= 0 && pendingIndex > attemptIndex)

    harness.setState(current => ({
      ...current,
      now: new Date(NOW.getTime() + 360_000).toISOString(),
      draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'withdrawn' }),
    }))
    const otherBuyer = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: jsonHeaders(OTHER_SECRET),
      body: JSON.stringify({ market_checkout_id: 82, buyer_wallet: OTHER_WALLET }),
    })
    assert.equal(otherBuyer.status, 409)
    const cancel = await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(cancel.status, 409)
    assert.equal(harness.getState().thingLocked, true)

    harness.setState(current => ({ ...current, directVerificationAvailable: true }))
    const finish = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST', headers: jsonHeaders(BUYER_SECRET), body: '{}',
    })
    assert.equal(finish.status, 200, await finish.clone().text())
    const claimed = (await finish.json() as { offer: FakeOffer & { phase: string } }).offer
    assert.equal(claimed.phase, 'claimed')
    assert.equal(claimed.tx_hash, TX)
    assert.equal(claimed.block_time, new Date(NOW.getTime() + 60_000).toISOString())
    assert.equal(harness.getState().facilitatorSettlements, 1)
    assert.equal(harness.getState().thingOwner, 8)
  })

  test('buyer or seller can reconcile pending payment, but ambiguous chain state stays locked', async () => {
    const pending = openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_buyer: 'market-buyer',
      market_listing_id: 91,
      market_checkout_id: 81,
      pending_x402_tx_hash: TX,
      pending_x402_payer: BUYER_WALLET,
      pending_x402_at: NOW.toISOString(),
      x402_evidence_state: 'pending',
      reserved_at: NOW.toISOString(),
      reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
    })
    for (const authorization of [BUYER_SECRET, SELLER_SECRET]) {
      const harness = makeHarness({
        offer: pending,
        thingLocked: true,
        directVerificationAvailable: false,
      })
      const response = await harness.app.request('/api/world/offer/101/reconcile', {
        method: 'POST', headers: jsonHeaders(authorization), body: '{}',
      })
      assert.equal(response.status, 202, await response.clone().text())
      assert.equal((await response.json() as { offer: { phase: string } }).offer.phase, 'payment_pending')
      assert.equal(harness.getState().thingLocked, true)
    }

    const sellerFinalizes = makeHarness({ offer: pending, thingLocked: true })
    const finalized = await sellerFinalizes.app.request('/api/world/offer/101/reconcile', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(finalized.status, 200, await finalized.clone().text())
    assert.equal((await finalized.json() as { offer: { phase: string } }).offer.phase, 'claimed')
    assert.equal(sellerFinalizes.getState().thingOwner, 8)
  })

  test('a finalized payment whose world target changed enters founder review with no ownership effect', async () => {
    const harness = makeHarness({
      scenario: 'target changes after world finality',
      offer: openOffer({
        buyer_id: 8,
        buyer: 'neighbor',
        reserved_by: 8,
        buyer_wallet: BUYER_WALLET,
        market_buyer: 'market-buyer',
        market_listing_id: 91,
        market_checkout_id: 81,
        pending_x402_tx_hash: TX,
        pending_x402_payer: BUYER_WALLET,
        pending_x402_at: NOW.toISOString(),
        x402_evidence_state: 'pending',
        reserved_at: NOW.toISOString(),
        reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
      }),
      thingLocked: true,
    })

    const response = await harness.app.request('/api/world/offer/101/reconcile', {
      method: 'POST', headers: jsonHeaders(BUYER_SECRET), body: '{}',
    })

    assert.equal(response.status, 409, await response.clone().text())
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.payment, 'founder_review')
    assert.equal(body.do_not_pay_again, true)
    assert.equal('retry' in body, false)
    assert.equal(harness.getState().paymentAttempt?.status, 'founder_review')
    assert.equal(harness.getState().offer?.x402_evidence_state, 'founder_review')
    assert.equal(harness.getState().thingOwner, 9)
    assert.equal(harness.getState().thingLocked, true)
    assert.equal(harness.getState().queries.some(call =>
      call.text.includes('payment-sale-operations:complete-world')), false)
    assert.equal(harness.getState().queries.some(call =>
      call.text.includes('payment-sale-operations:close-target')), true)
  })

  test('reconcile_world MCP dispatches through HTTP bearer auth without a secret argument', async () => {
    const harness = makeHarness({
      offer: openOffer({
        buyer_id: 8,
        buyer: 'neighbor',
        reserved_by: 8,
        buyer_wallet: BUYER_WALLET,
        market_listing_id: 91,
        market_checkout_id: 81,
        pending_x402_tx_hash: TX,
        pending_x402_payer: BUYER_WALLET,
        pending_x402_at: NOW.toISOString(),
        x402_evidence_state: 'pending',
        reserved_at: NOW.toISOString(),
        reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
      }),
      thingLocked: true,
      directVerificationAvailable: false,
    })
    const response = await harness.app.request('/mcp', {
      method: 'POST',
      headers: jsonHeaders(SELLER_SECRET),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'reconcile_world', arguments: { offer_id: 101 } },
      }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
    assert.equal(body.result.isError, false)
    assert.equal((JSON.parse(body.result.content[0]!.text) as { offer: { phase: string } }).offer.phase, 'payment_pending')
  })

  test('conclusive invalid x402 receipt becomes durable payment_invalid and still needs market-first cancel', async () => {
    const harness = makeHarness({
      offer: openOffer({
        buyer_id: 8,
        buyer: 'neighbor',
        reserved_by: 8,
        buyer_wallet: BUYER_WALLET,
        market_buyer: 'market-buyer',
        market_listing_id: 91,
        market_checkout_id: 81,
        pending_x402_tx_hash: TX,
        pending_x402_payer: BUYER_WALLET,
        pending_x402_at: NOW.toISOString(),
        x402_evidence_state: 'pending',
        reserved_at: NOW.toISOString(),
        reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
      }),
      thingLocked: true,
      directVerificationInvalid: true,
      draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
    })
    const reconcile = await harness.app.request('/api/world/offer/101/reconcile', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(reconcile.status, 200, await reconcile.clone().text())
    const invalid = (await reconcile.json() as { offer: FakeOffer & { phase: string } }).offer
    assert.equal(invalid.phase, 'payment_invalid')
    assert.equal(invalid.pending_x402_tx_hash, TX)
    assert.equal(harness.getState().thingLocked, true)

    const tooEarly = await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(tooEarly.status, 409)
    harness.setState(current => ({
      ...current,
      listing: listing({ state: 'stale', world_state: 'stale' }),
    }))
    const cancel = await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(cancel.status, 200, await cancel.clone().text())
    assert.equal(harness.getState().thingLocked, false)
  })

}
