import assert from 'node:assert/strict'
import test from 'node:test'
import { publicMarketGet } from '../../src/world-market.ts'
import { makeHarness, jsonHeaders } from '../helpers/world-market-fixtures/harness.ts'
import { MARKET, SELLER_SECRET, BUYER_SECRET, BUYER_WALLET, TX, NOW, type FakeOffer, draft, checkout, openOffer } from '../helpers/world-market-fixtures/offers.ts'

export function registerListingAndPublicRecordTests(): void {
  test('seller locks an owned active thing from a valid pending market draft', async () => {
    const harness = makeHarness()
    const response = await harness.app.request('/api/world/listing', {
      method: 'POST',
      headers: jsonHeaders(SELLER_SECRET),
      body: JSON.stringify({ thing_id: 41, market_draft_id: 71 }),
    })

    assert.equal(response.status, 201, await response.clone().text())
    const payload = await response.json() as { offer: FakeOffer & { phase: string } }
    assert.equal(payload.offer.channel, 'world')
    assert.equal(payload.offer.phase, 'listed')
    assert.equal(payload.offer.locked, true)
    assert.equal(payload.offer.market_origin, MARKET)
    assert.equal(harness.getState().thingLocked, true)
    assert.ok(harness.getState().queries.some(call =>
      call.text.includes('world-market:create') && /update\s+things/i.test(call.text) && /insert\s+into\s+transfer_offers/i.test(call.text)))
  })

  test('listing distinguishes a missing market draft from market failure and invalid records', async () => {
    const cases: ReadonlyArray<{
      name: string
      fetcher: typeof fetch
      status: number
      error: string
    }> = [
      {
        name: 'missing draft',
        fetcher: async () => Response.json({ error: 'no such world draft' }, { status: 404 }),
        status: 404,
        error: 'no such market draft 71',
      },
      {
        name: 'transport failure',
        fetcher: async () => { throw new TypeError('fetch failed') },
        status: 503,
        error: 'the market public record is unavailable; nothing changed',
      },
      {
        name: 'invalid public record',
        fetcher: async () => Response.json({ nope: true }),
        status: 502,
        error: 'the market returned an invalid public draft; retry after 1F3EA returns the current draft',
      },
    ]

    for (const entry of cases) {
      const harness = makeHarness(
        {},
        path => publicMarketGet(MARKET, path, entry.fetcher),
      )
      const response = await harness.app.request('/api/world/listing', {
        method: 'POST',
        headers: jsonHeaders(SELLER_SECRET),
        body: JSON.stringify({ thing_id: 41, market_draft_id: 71 }),
      })

      assert.equal(response.status, entry.status, entry.name)
      assert.deepEqual(await response.json(), { error: entry.error }, entry.name)
      assert.equal(harness.getState().thingLocked, false, entry.name)
    }
  })

  test('listing and claim refusals name the state change that lets the caller continue', async () => {
    const locked = makeHarness({ offer: openOffer(), thingLocked: true })
    const lockedResponse = await locked.app.request('/api/world/listing', {
      method: 'POST',
      headers: jsonHeaders(SELLER_SECRET),
      body: JSON.stringify({ thing_id: 41, market_draft_id: 71 }),
    })
    assert.equal(lockedResponse.status, 409)
    assert.deepEqual(await lockedResponse.json(), {
      error: 'this thing is already locked by an offer; close its current offer before listing it again',
    })

    const claimed = makeHarness({
      offer: openOffer({
        status: 'claimed',
        buyer_id: 9,
        buyer: 'someone-else',
        claimed_at: NOW.toISOString(),
        locked: false,
      }),
      thingLocked: false,
    })
    const claimedResponse = await claimed.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: jsonHeaders(BUYER_SECRET),
      body: '{}',
    })
    assert.equal(claimedResponse.status, 403)
    assert.deepEqual(await claimedResponse.json(), {
      error: 'this world offer was claimed by another resident; choose another active offer because this claim cannot change buyers',
    })

    const pendingOffer = openOffer({
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
    })
    const pending = makeHarness({ offer: pendingOffer, thingLocked: true })
    pending.setState(current => ({ ...current, paymentAttempt: null }))
    const pendingResponse = await pending.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(pendingResponse.status, 503)
    assert.deepEqual(await pendingResponse.json(), {
      error: 'the pending payment custody record is unavailable; retry this same offer later and do not pay again',
    })
  })

  test('claim and cancel name missing market records without reporting an outage', async () => {
    const missingCheckout = makeHarness(
      { offer: openOffer(), thingLocked: true },
      path => publicMarketGet(MARKET, path, async () =>
        Response.json({ error: 'no such world checkout' }, { status: 404 })),
    )
    const checkoutResponse = await missingCheckout.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(checkoutResponse.status, 404)
    assert.deepEqual(await checkoutResponse.json(), { error: 'no such market checkout 81' })

    const missingListing = makeHarness(
      { offer: openOffer(), thingLocked: true },
      path => publicMarketGet(MARKET, path, async () =>
        path.endsWith('/checkout/81')
          ? Response.json({ checkout: checkout() })
          : Response.json({ error: 'no such world draft' }, { status: 404 })),
    )
    const listingResponse = await missingListing.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(listingResponse.status, 404)
    assert.deepEqual(await listingResponse.json(), { error: 'no such market draft 71' })

    const missingCancellation = makeHarness(
      { offer: openOffer(), thingLocked: true },
      path => publicMarketGet(MARKET, path, async () =>
        Response.json({ error: 'no such world draft' }, { status: 404 })),
    )
    const cancellationResponse = await missingCancellation.app.request('/api/world/offer/101/cancel', {
      method: 'POST',
      headers: jsonHeaders(SELLER_SECRET),
      body: JSON.stringify({}),
    })
    assert.equal(cancellationResponse.status, 404)
    assert.deepEqual(await cancellationResponse.json(), { error: 'no such market draft 71' })
  })

  test('listing rejects nonowners, mismatched drafts, unknown fields, and unavailable records', async () => {
    for (const [patch, body, expected] of [
      [{ thingOwner: 9 }, { thing_id: 41, market_draft_id: 71 }, 403],
      [{ draft: draft({ world_asset: { type: 'thing', id: 42 } }) }, { thing_id: 41, market_draft_id: 71 }, 409],
      [{}, { thing_id: 41, market_draft_id: 71, market_origin: 'https://evil.example' }, 400],
      [{ marketFailure: true }, { thing_id: 41, market_draft_id: 71 }, 503],
      [{ marketInvalid: true }, { thing_id: 41, market_draft_id: 71 }, 502],
    ] as const) {
      const harness = makeHarness(patch)
      const response = await harness.app.request('/api/world/listing', {
        method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: JSON.stringify(body),
      })
      assert.equal(response.status, expected, await response.clone().text())
      assert.equal(harness.getState().thingLocked, false)
    }
  })

  test('public resident and offer records expose no bearer material', async () => {
    const harness = makeHarness({ offer: openOffer(), thingLocked: true })
    const resident = await harness.app.request('/api/world/resident/neighbor')
    assert.equal(resident.status, 200)
    assert.deepEqual(await resident.json(), { resident: { handle: 'neighbor' } })
    assert.equal((await harness.app.request('/api/world/resident/not-here')).status, 404)

    const response = await harness.app.request('/api/world/offer/101')
    assert.equal(response.status, 200)
    const text = await response.text()
    const offer = (JSON.parse(text) as { offer: Record<string, unknown> }).offer
    assert.equal(offer.phase, 'listed')
    assert.equal(offer.asset_name, 'porch lantern')
    assert.equal(offer.maker_id, 6)
    assert.equal(offer.made_by, 'old-maker')
    assert.equal(offer.current_owner_id, 7)
    assert.equal(offer.current_owner, 'tiny-lantern')
    assert.equal(offer.buyer, null)
    assert.equal(text.includes('secret'), false)

    harness.setState(current => ({ ...current, thingModerated: true }))
    const hidden = await harness.app.request('/api/world/offer/101')
    assert.equal(hidden.status, 200)
    assert.deepEqual(await hidden.json(), {
      offer: { id: 101, status: 'maintainer_hidden' },
    })
  })

}
