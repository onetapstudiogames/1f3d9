import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TEST_ACCOUNT,
  TEST_CITY_KEY,
  TEST_MARKET_KEY,
  TEST_PRIVATE_KEY,
  TEST_NONCE,
  TEST_TX_HASH,
  close,
  listen,
  sendJson,
  runWorldBuy,
  savePurchaseState,
} from '../helpers/world-buy-client-fixtures/purchase-client.ts'

export function registerCheckoutBindingTests(): void {
  test('world-buy retries checkout-binding 503 and 409 and accepts the matching top-level receipt', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-receipt-'))
    await savePurchaseState(stateDirectory, { nonce: TEST_NONCE })
    let syncCalls = 0

    const city = await listen((request, response) => {
      if (request.method === 'GET' && request.url === '/api/world/offer/31') {
        sendJson(response, 200, { offer: { phase: 'reserved', asset_id: 2723 } })
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/offer/31/claim') {
        assert.equal(request.headers['x-payment'], undefined)
        sendJson(response, 200, { offer: { phase: 'claimed', asset_id: 2723 } })
        return
      }
      if (request.method === 'GET' && request.url === '/api/thing/2723') {
        sendJson(response, 200, { thing: { id: 2723, current_owner: 'bridge-buyer' } })
        return
      }
      sendJson(response, 404, { error: `unexpected city route ${request.method} ${request.url}` })
    })

    const market = await listen((request, response) => {
      if (request.method === 'POST' && request.url === '/api/world/sync/23') {
        syncCalls += 1
        if (syncCalls <= 2) {
          sendJson(response, syncCalls === 1 ? 503 : 409, {
            error: 'the market could not confirm this paid checkout binding; retry this same sync request; do not make another payment',
          })
          return
        }
        sendJson(response, 200, {
          receipt: {
            purchase_id: 38,
            listing_id: 23,
            checkout_id: 77,
            delivery_kind: 'city_ownership',
            city_origin: 'https://1f3d9.com',
            city_offer_id: 31,
            city_asset_id: 2723,
            city_handle: 'bridge-buyer',
            amount_usdc: 1,
            tx_hash: TEST_TX_HASH,
            verified_via: 'world',
            city_verified_via: 'x402',
            city_receipt_url: 'https://1f3d9.com/api/world/offer/31',
            created_at: '2026-09-05T13:31:19.746Z',
          },
        })
        return
      }
      if (request.method === 'GET' && request.url === '/api/listing/23') {
        sendJson(response, 200, { listing: { id: 23, world_state: 'sold' } })
        return
      }
      sendJson(response, 404, { error: `unexpected market route ${request.method} ${request.url}` })
    })

    try {
      let stdout = ''
      const status = await runWorldBuy({
        listingId: 23,
        offerId: 31,
        wallet: TEST_ACCOUNT.address,
        cityKey: TEST_CITY_KEY,
        marketKey: TEST_MARKET_KEY,
        privateKey: TEST_PRIVATE_KEY,
        cityOrigin: city.origin,
        marketOrigin: market.origin,
        stateDirectory,
        syncDelayMs: 5,
        checkoutBindingRetryDelayMs: 5,
        stdout: message => { stdout += message },
        stderr: () => {},
      })
      assert.equal(status, 0)
      assert.equal(syncCalls, 3)
      assert.match(stdout, /Thing 2723 is currently owned by bridge-buyer\./u)
      assert.match(stdout, /Listing 23 world state is sold\./u)
    } finally {
      await Promise.all([close(city.server), close(market.server)])
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test('world-buy stops after the configured checkout-binding retry cap', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-retry-cap-'))
    await savePurchaseState(stateDirectory, { nonce: TEST_NONCE })
    let syncCalls = 0

    const city = await listen((request, response) => {
      if (request.method === 'GET' && request.url === '/api/world/offer/31') {
        sendJson(response, 200, { offer: { phase: 'reserved', asset_id: 2723 } })
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/offer/31/claim') {
        sendJson(response, 200, { offer: { phase: 'claimed', asset_id: 2723 } })
        return
      }
      sendJson(response, 404, { error: `unexpected city route ${request.method} ${request.url}` })
    })

    const refusal = 'the market could not confirm this paid checkout binding; retry this same sync request; do not make another payment'
    const market = await listen((request, response) => {
      if (request.method === 'POST' && request.url === '/api/world/sync/23') {
        syncCalls += 1
        sendJson(response, 503, { error: refusal })
        return
      }
      sendJson(response, 404, { error: `unexpected market route ${request.method} ${request.url}` })
    })

    let stderr = ''
    try {
      const status = await runWorldBuy({
        listingId: 23,
        offerId: 31,
        wallet: TEST_ACCOUNT.address,
        cityKey: TEST_CITY_KEY,
        marketKey: TEST_MARKET_KEY,
        privateKey: TEST_PRIVATE_KEY,
        cityOrigin: city.origin,
        marketOrigin: market.origin,
        stateDirectory,
        checkoutBindingRetryDelayMs: 1,
        checkoutBindingRetries: 2,
        stdout: () => {},
        stderr: message => { stderr += message },
      })
      assert.equal(status, 1)
      assert.equal(syncCalls, 3)
      assert.match(stderr, /could not confirm this paid checkout binding/iu)
    } finally {
      await Promise.all([close(city.server), close(market.server)])
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
}
