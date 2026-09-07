import assert from 'node:assert/strict'
import test from 'node:test'
import { publicMarketGet } from '../../src/world-market.ts'
import { makeHarness, jsonHeaders } from '../helpers/world-market-fixtures/harness.ts'
import { MARKET, SELLER_SECRET, BUYER_WALLET, TX, NOW, draft, listing, openOffer } from '../helpers/world-market-fixtures/offers.ts'

export function registerCancellationTests(): void {
  test('cancellation unlocks after every terminal listing or draft state', async () => {
    for (const state of ['canceled', 'withdrawn', 'expired', 'sold']) {
      const knownListing = makeHarness({
        offer: openOffer({ market_listing_id: 91 }),
        thingLocked: true,
        listing: listing({ state, world_state: state === 'sold' ? 'sold' : 'canceled' }),
      })
      const listingResponse = await knownListing.app.request('/api/world/offer/101/cancel', {
        method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
      })
      assert.equal(listingResponse.status, 200, `${state}: ${await listingResponse.clone().text()}`)
      assert.equal(knownListing.getState().thingLocked, false)
    }

    for (const [state, status] of [
      ['canceled', 'withdrawn'],
      ['withdrawn', 'active'],
      ['expired', 'active'],
      ['sold', 'active'],
    ]) {
      const draftOnly = makeHarness({
        offer: openOffer(),
        thingLocked: true,
        draft: draft({ status, listing_id: 91, listing_state: state }),
      })
      const draftResponse = await draftOnly.app.request('/api/world/offer/101/cancel', {
        method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
      })
      assert.equal(draftResponse.status, 200, `${state}: ${await draftResponse.clone().text()}`)
      assert.equal(draftOnly.getState().thingLocked, false)
    }
  })

  test('cancellation tells the seller how to end a live market listing', async () => {
    const harness = makeHarness({
      offer: openOffer({ market_listing_id: 91 }),
      thingLocked: true,
      listing: listing({ state: 'active', world_state: 'active' }),
    })
    const response = await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'the market listing is still live; withdraw it at 1F3EA, then retry cancellation here to unlock the thing',
    })
    assert.equal(harness.getState().thingLocked, true)
  })

  test('cancellation tells the seller when an ended listing world record is still catching up', async () => {
    const harness = makeHarness({
      offer: openOffer({ market_listing_id: 91 }),
      thingLocked: true,
      listing: listing({ state: 'withdrawn', world_state: 'active' }),
    })
    const response = await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'the market listing has ended, but its world record has not finished catching up; retry after 1F3EA finishes ending the listing',
    })
    assert.equal(harness.getState().thingLocked, true)
  })

  test('cancellation falls back to the durable draft only when a known listing is not found', async () => {
    const harness = makeHarness(
      {
        offer: openOffer({ market_listing_id: 91 }),
        thingLocked: true,
        draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'withdrawn' }),
      },
      path => publicMarketGet(MARKET, path, async () =>
        path === '/api/listing/91'
          ? Response.json({ error: 'no such listing' }, { status: 404 })
          : Response.json({ draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'withdrawn' }) })),
    )
    const response = await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(harness.getState().thingLocked, false)
  })

  test('cancellation keeps a strict 502 for a present listing inconsistent with the world offer', async () => {
    const harness = makeHarness({
      offer: openOffer({ market_listing_id: 91 }),
      thingLocked: true,
      listing: listing({ world_offer_id: 102 }),
      draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'withdrawn' }),
    })
    const response = await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), {
      error: 'the market returned an invalid public listing record; retry after 1F3EA returns the current listing',
    })
    assert.equal(harness.getState().thingLocked, true)
  })

  test('cancellation follows the market first, fails closed, and is idempotent', async () => {
    const claimedHarness = makeHarness({
      offer: openOffer({ status: 'claimed', claimed_at: NOW.toISOString(), locked: false }),
      thingLocked: false,
    })
    const claimedResponse = await claimedHarness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(claimedResponse.status, 409)
    assert.deepEqual(await claimedResponse.json(), {
      error: 'claimed world offer cannot be canceled; the completed sale is permanent, so list another owned thing instead',
    })

    for (const [patch, expected] of [
      [{ listing: listing({ state: 'active', world_state: 'active' }) }, 409],
      [{ listing: listing({ state: 'active', world_state: 'withdrawn' }) }, 409],
      [{ listing: listing({ state: 'withdrawn', world_state: 'active' }) }, 409],
      [{ marketFailure: true }, 503],
    ] as const) {
      const harness = makeHarness({ offer: openOffer({ market_listing_id: 91 }), thingLocked: true, ...patch })
      const response = await harness.app.request('/api/world/offer/101/cancel', {
        method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
      })
      assert.equal(response.status, expected)
      assert.equal(harness.getState().thingLocked, true)
    }

    const harness = makeHarness({
      offer: openOffer({ market_listing_id: 91 }),
      thingLocked: true,
      listing: listing({ state: 'withdrawn', world_state: 'canceled' }),
    })
    const cancel = () => harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    const first = await cancel()
    assert.equal(first.status, 200, await first.clone().text())
    assert.equal((await first.json() as { offer: { phase: string } }).offer.phase, 'canceled')
    assert.equal(harness.getState().thingLocked, false)

    harness.setState(current => ({ ...current, marketFailure: true }))
    const retry = await cancel()
    assert.equal(retry.status, 200)
  })

  test('an active reservation blocks world cancellation even after market withdrawal', async () => {
    const harness = makeHarness({
      offer: openOffer({
        buyer_id: 8,
        buyer: 'neighbor',
        reserved_by: 8,
        buyer_wallet: BUYER_WALLET,
        market_listing_id: 91,
        market_checkout_id: 81,
        reserved_at: NOW.toISOString(),
        reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
      }),
      thingLocked: true,
      draft: draft({ status: 'withdrawn', listing_id: 91, listing_state: 'withdrawn' }),
    })
    const response = await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(response.status, 409)
    assert.equal(harness.getState().thingLocked, true)
  })

  test('expired x402 evidence keeps the world thing locked until market-first cancellation', async () => {
    // The third market no-sale phase, payment_expired, drives the same stale listing shape.
    const expired = openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_listing_id: 91,
      market_checkout_id: 81,
      pending_x402_tx_hash: TX,
      pending_x402_payer: BUYER_WALLET,
      pending_x402_at: NOW.toISOString(),
      x402_evidence_state: 'expired',
      reserved_at: NOW.toISOString(),
      reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
    })
    const active = makeHarness({
      offer: expired,
      thingLocked: true,
      listing: listing({ state: 'active', world_state: 'active' }),
    })
    const blocked = await active.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(blocked.status, 409)
    assert.equal(active.getState().thingLocked, true)

    const ended = makeHarness({
      offer: expired,
      thingLocked: true,
      listing: listing({ state: 'stale', world_state: 'stale' }),
    })
    const canceled = await ended.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(canceled.status, 200, await canceled.clone().text())
    assert.equal(ended.getState().thingLocked, false)
  })

  test('founder-review evidence keeps the world thing locked until market-first cancellation', async () => {
    const reviewed = openOffer({
      buyer_id: 8,
      buyer: 'neighbor',
      reserved_by: 8,
      buyer_wallet: BUYER_WALLET,
      market_listing_id: 91,
      market_checkout_id: 81,
      pending_x402_tx_hash: TX,
      pending_x402_payer: BUYER_WALLET,
      pending_x402_at: NOW.toISOString(),
      x402_evidence_state: 'founder_review',
      reserved_at: NOW.toISOString(),
      reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
    })
    const active = makeHarness({
      offer: reviewed,
      thingLocked: true,
      listing: listing({ state: 'active', world_state: 'active' }),
    })
    const blocked = await active.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(blocked.status, 409)
    assert.equal(active.getState().thingLocked, true)

    const ended = makeHarness({
      offer: reviewed,
      thingLocked: true,
      listing: listing({ state: 'stale', world_state: 'stale' }),
    })
    const canceled = await ended.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(canceled.status, 200, await canceled.clone().text())
    assert.equal(ended.getState().thingLocked, false)
  })
}
