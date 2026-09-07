import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requirements } from '../../src/pay.ts'
import {
  TEST_ACCOUNT,
  TEST_CITY_KEY,
  TEST_MARKET_KEY,
  TEST_PRIVATE_KEY,
  close,
  listen,
  sendJson,
  runWorldBuy,
} from '../helpers/world-buy-client-fixtures/purchase-client.ts'

export function registerPaidClaimTimeoutTests(): void {
  test('world-buy recovers from a paid claim that answers too slowly by reconciling, without another signature', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-slow-'))
    const signedHeaders: string[] = []
    let reconcileCalls = 0
    let offerReadCalls = 0
    let cityOrigin = ''

    const city = await listen((request, response) => {
      if (request.method === 'GET' && request.url === '/api/me') {
        sendJson(response, 200, { handle: 'test-buyer' })
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/offer/31/claim') {
        const paymentHeader = request.headers['x-payment']
        if (typeof paymentHeader !== 'string') {
          sendJson(response, 402, {
            error: 'payment required',
            accepts: [requirements(
              '0x1111111111111111111111111111111111111111',
              1,
              `${cityOrigin}/api/world/offer/31/claim`,
              'test world offer',
            )],
          })
          return
        }
        signedHeaders.push(paymentHeader)
        // Answer only after the client has given up waiting.
        setTimeout(() => {
          try { sendJson(response, 200, { offer: { phase: 'claimed', asset_id: 2723 } }) } catch {}
        }, 600)
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/offer/31/reconcile') {
        reconcileCalls += 1
        if (reconcileCalls === 1) {
          sendJson(response, 409, { error: 'this world offer has no durable payment to reconcile' })
        } else {
          sendJson(response, 200, { offer: { phase: 'claimed', asset_id: 2723 } })
        }
        return
      }
      if (request.method === 'GET' && request.url === '/api/world/offer/31') {
        offerReadCalls += 1
        if (offerReadCalls === 1) {
          response.destroy()
          return
        }
        sendJson(response, 200, { offer: { phase: 'payment_pending', asset_id: 2723 } })
        return
      }
      if (request.method === 'GET' && request.url === '/api/thing/2723') {
        sendJson(response, 200, { thing: { id: 2723, current_owner: 'test-buyer' } })
        return
      }
      sendJson(response, 404, { error: `unexpected city route ${request.method} ${request.url}` })
    })
    cityOrigin = city.origin

    const market = await listen((request, response) => {
      if (request.method === 'POST' && request.url === '/api/world/checkout/23') {
        // The market's real answer carries checkout_id at the top level.
        sendJson(response, 201, { checkout_id: 78, url: 'https://market.test/api/world/checkout/78' })
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/sync/23') {
        sendJson(response, 200, { listing: { id: 23, world_state: 'sold' } })
        return
      }
      if (request.method === 'GET' && request.url === '/api/listing/23') {
        sendJson(response, 200, { listing: { id: 23, world_state: 'sold' } })
        return
      }
      sendJson(response, 404, { error: `unexpected market route ${request.method} ${request.url}` })
    })

    let stdout = ''
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
        syncDelayMs: 10,
        paidClaimTimeoutMs: 200,
        reconcileRetryDelayMs: 20,
        reconcileAttempts: 3,
        stdout: message => { stdout += message },
        stderr: message => { stderr += message },
      })
      assert.equal(status, 0)
      assert.equal(signedHeaders.length, 1)
      assert.equal(reconcileCalls, 2)
      assert.equal(offerReadCalls, 2)
      assert.ok(stderr.includes('did not answer in time'))
      assert.ok(stderr.includes('without paying again'))
      assert.ok(stderr.includes('has not recorded the payment yet'))
      assert.ok(stdout.includes('Thing 2723 is currently owned by test-buyer.'))
      assert.ok(stdout.includes('Listing 23 world state is sold.'))
      for (const secret of [TEST_CITY_KEY, TEST_MARKET_KEY, TEST_PRIVATE_KEY, signedHeaders[0]!]) {
        assert.equal(`${stdout}${stderr}`.includes(secret), false)
      }
    } finally {
      await Promise.all([close(city.server), close(market.server)])
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test('world-buy keeps the saved-nonce reassurance when offer reads fail after a paid-claim timeout', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-offer-read-failure-'))
    const signedHeaders: string[] = []
    let offerReadCalls = 0
    let cityOrigin = ''

    const city = await listen((request, response) => {
      if (request.method === 'GET' && request.url === '/api/me') {
        sendJson(response, 200, { handle: 'test-buyer' })
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/offer/31/claim') {
        const paymentHeader = request.headers['x-payment']
        if (typeof paymentHeader !== 'string') {
          sendJson(response, 402, {
            error: 'payment required',
            accepts: [requirements(
              '0x1111111111111111111111111111111111111111',
              1,
              `${cityOrigin}/api/world/offer/31/claim`,
              'test world offer',
            )],
          })
          return
        }
        signedHeaders.push(paymentHeader)
        setTimeout(() => {
          try { sendJson(response, 200, { offer: { phase: 'claimed', asset_id: 2723 } }) } catch {}
        }, 300)
        return
      }
      if (request.method === 'GET' && request.url === '/api/world/offer/31') {
        offerReadCalls += 1
        response.destroy()
        return
      }
      sendJson(response, 404, { error: `unexpected city route ${request.method} ${request.url}` })
    })
    cityOrigin = city.origin

    const market = await listen((request, response) => {
      if (request.method === 'POST' && request.url === '/api/world/checkout/23') {
        sendJson(response, 201, { checkout: { id: 77 } })
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
        paidClaimTimeoutMs: 50,
        reconcileRetryDelayMs: 1,
        reconcileAttempts: 2,
        stdout: () => {},
        stderr: message => { stderr += message },
      })
      assert.equal(status, 1)
      assert.equal(offerReadCalls, 2)
      assert.equal(signedHeaders.length, 1)
      assert.match(stderr, /run this same command again; it will resume with the saved nonce and will not make a new payment/iu)
    } finally {
      await Promise.all([close(city.server), close(market.server)])
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
}
