import assert from 'node:assert/strict'
import test from 'node:test'
import { makeHarness, jsonHeaders } from '../helpers/world-market-fixtures/harness.ts'
import { BUYER_SECRET, OTHER_SECRET, BUYER_WALLET, OTHER_WALLET, TX, X_PAYMENT_NO_ID, NOW, type FakeOffer, draft, listing, checkout, openOffer } from '../helpers/world-market-fixtures/offers.ts'

export function registerReservationTests(): void {
  test('PostgreSQL Date offer timestamps stay ISO UTC with milliseconds through public read and payment', async () => {
    const reservedAt = '2026-08-12T12:00:00.106Z'
    const reservedUntil = '2026-08-12T12:05:00.106Z'
    const harness = makeHarness({
      databaseReturnsTimestampDates: true,
      now: '2026-08-12T12:00:01.000Z',
      directBlockTime: '2026-08-12T12:00:02.000Z',
      thingLocked: true,
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
    })

    const publicResponse = await harness.app.request('/api/world/offer/101')
    assert.equal(publicResponse.status, 200)
    const publicOffer = (await publicResponse.json() as { offer: FakeOffer }).offer
    assert.equal(publicOffer.reserved_at, reservedAt)
    assert.equal(publicOffer.reserved_until, reservedUntil)

    const paidClaim = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: { ...jsonHeaders(BUYER_SECRET), 'x-payment': X_PAYMENT_NO_ID },
      body: '{}',
    })
    assert.equal(paidClaim.status, 200, await paidClaim.clone().text())
    const paymentInput = harness.getRunPaymentInputs()[0]
    assert.equal(paymentInput?.notBefore?.toISOString(), reservedAt)
    assert.equal(paymentInput?.notAfter?.toISOString(), reservedUntil)
  })

  test('a buyer must already be a resident and cannot pay before reserving', async () => {
    const harness = makeHarness({ offer: openOffer(), thingLocked: true })
    const anonymous = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(anonymous.status, 401)

    const payFirst = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST', headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET, tx_hash: TX }),
    })
    assert.equal(payFirst.status, 400)
    assert.equal(harness.getState().facilitatorSettlements, 0)
  })

  test('checkout city handle is bound to the authenticated resident', async () => {
    const harness = makeHarness({
      offer: openOffer(),
      thingLocked: true,
      checkout: checkout({ city_handle: 'someone-else' }),
      draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
    })
    const response = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST', headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(response.status, 403)
    assert.equal(harness.getState().offer?.buyer_id, null)
  })

  test('the pre-existing first-reservation behavior records market_listing_id and opens exactly five minutes', async () => {
    const harness = makeHarness({
      offer: openOffer(),
      thingLocked: true,
      draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
    })
    const reserve = () => harness.app.request('/api/world/offer/101/claim', {
      method: 'POST', headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })
    const first = await reserve()
    assert.equal(first.status, 402, await first.clone().text())
    assert.equal(harness.getState().offer?.market_listing_id, 91)
    assert.equal(
      Date.parse(harness.getState().offer!.reserved_until!) - Date.parse(harness.getState().offer!.reserved_at!),
      300_000,
    )
    const second = await reserve()
    assert.equal(second.status, 402)
    assert.equal(harness.getState().queries.filter(call => call.text.includes('world-market:reserve')).length, 1)

    const race = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST', headers: jsonHeaders(OTHER_SECRET),
      body: JSON.stringify({ market_checkout_id: 82, buyer_wallet: OTHER_WALLET }),
    })
    assert.equal(race.status, 409)
  })

  for (const [name, marketDraft] of [
    ['pending draft with no listing', draft()],
    ['withdrawn draft with an active listing', draft({ status: 'withdrawn', listing_id: 91, listing_state: 'active' })],
    ['active draft with a canceled listing', draft({ status: 'active', listing_id: 91, listing_state: 'canceled' })],
    ['active draft whose listing differs from checkout', draft({ status: 'active', listing_id: 92, listing_state: 'active' })],
    ['active draft whose price differs from the offer', draft({ status: 'active', listing_id: 91, listing_state: 'active', price_usdc: 3 })],
  ] as const) {
    test(`claim rejects ${name}`, async () => {
      const harness = makeHarness({
        offer: openOffer(),
        thingLocked: true,
        draft: marketDraft,
      })
      const response = await harness.app.request('/api/world/offer/101/claim', {
        method: 'POST', headers: jsonHeaders(BUYER_SECRET),
        body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
      })
      assert.equal(response.status, 409)
      assert.deepEqual(await response.json(), {
        error: 'market listing is not active or does not match this world offer; re-read 1F3EA and use its current active listing',
      })
      assert.equal(harness.getState().offer?.market_listing_id, null)
      assert.equal(harness.getState().facilitatorSettlements, 0)
    })
  }

  test('claim accepts a live listing after its activated draft expiry', async () => {
    const harness = makeHarness({
      offer: openOffer(),
      thingLocked: true,
      draft: draft({
        status: 'active',
        listing_id: 91,
        listing_state: 'active',
        expires_at: new Date(NOW.getTime() - 60_000).toISOString(),
      }),
    })
    const response = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST', headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(response.status, 402, await response.clone().text())
    assert.equal(harness.getState().offer?.market_listing_id, 91)
  })

  test('an expired world reservation can bind a different resident with a fresh checkout', async () => {
    const harness = makeHarness({
      offer: openOffer({
        buyer_id: 8,
        buyer: 'neighbor',
        reserved_by: 8,
        buyer_wallet: BUYER_WALLET,
        market_listing_id: 91,
        market_checkout_id: 80,
        reserved_at: '2026-08-12T11:40:00.000Z',
        reserved_until: '2026-08-12T11:45:00.000Z',
      }),
      thingLocked: true,
      checkout: checkout({ id: 82, city_handle: 'someone-else' }),
      draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
    })
    const response = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST', headers: jsonHeaders(OTHER_SECRET),
      body: JSON.stringify({ market_checkout_id: 82, buyer_wallet: OTHER_WALLET }),
    })
    assert.equal(response.status, 402, await response.clone().text())
    assert.equal(harness.getState().offer?.buyer, 'someone-else')
    assert.equal(harness.getState().offer?.market_checkout_id, 82)
    assert.equal(harness.getState().offer?.market_buyer, 'market-buyer')
  })

  test('market buyer identity is retained as an immutable public checkout binding', async () => {
    const harness = makeHarness({
      offer: openOffer(),
      thingLocked: true,
      draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
    })
    const response = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST', headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(response.status, 402, await response.clone().text())
    assert.equal(harness.getState().offer?.market_buyer, 'market-buyer')
    const publicRecord = await harness.app.request('/api/world/offer/101')
    assert.equal((await publicRecord.json() as { offer: FakeOffer }).offer.market_buyer, 'market-buyer')
    const reserveSql = harness.getState().queries.find(call => call.text.includes('world-market:reserve'))?.text ?? ''
    assert.match(reserveSql, /market_buyer\s*=\s*\$\d+/i)
  })

}
