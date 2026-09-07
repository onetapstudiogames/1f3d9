import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requirements } from '../../src/pay.ts'
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
  runClient,
  savePurchaseState,
} from '../helpers/world-buy-client-fixtures/purchase-client.ts'

export function registerPaymentResumeTests(): void {
  test('world-buy resumes payment_pending without another signature and stops sync on terminal state', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-test-'))
    const signedHeaders: string[] = []
    const claimBodies: Record<string, unknown>[] = []
    const recoveryRequests: string[] = []
    let cityOrigin = ''
    let syncCalls = 0

    const city = await listen((request, response, body) => {
      if (request.url !== '/api/thing/2723' && request.url !== '/api/world/offer/31') {
        assert.equal(request.headers.authorization, `Bearer ${TEST_CITY_KEY}`)
      }
      if (request.method === 'GET' && request.url === '/api/me') {
        sendJson(response, 200, { handle: 'test-buyer' })
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/offer/31/claim') {
        claimBodies.push(body)
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
        sendJson(response, 202, {
          payment: 'payment_pending',
          transaction: TEST_TX_HASH,
          do_not_pay_again: true,
          error: 'Base finality is pending; reconcile this offer and do not pay again',
          offer: { phase: 'payment_pending', asset_id: 2723 },
        })
        return
      }
      if (request.method === 'GET' && request.url === '/api/world/offer/31') {
        sendJson(response, 200, { offer: { phase: 'payment_pending', asset_id: 2723 } })
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/offer/31/reconcile') {
        recoveryRequests.push('reconcile')
        assert.deepEqual(body, {})
        assert.equal(request.headers['x-payment'], undefined)
        sendJson(response, 200, { offer: { phase: 'claimed', asset_id: 2723 } })
        return
      }
      if (request.method === 'GET' && request.url === '/api/thing/2723') {
        sendJson(response, 200, { thing: { id: 2723, current_owner: 'test-buyer' } })
        return
      }
      sendJson(response, 404, { error: `unexpected city route ${request.method} ${request.url}` })
    })
    cityOrigin = city.origin

    const market = await listen((request, response, body) => {
      if (request.method === 'POST') {
        assert.equal(request.headers.authorization, `Bearer ${TEST_MARKET_KEY}`)
      }
      if (request.method === 'POST' && request.url === '/api/world/checkout/23') {
        assert.deepEqual(body, { city_handle: 'test-buyer' })
        sendJson(response, 201, { checkout: { id: 77 } })
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/sync/23') {
        assert.deepEqual(body, {})
        syncCalls += 1
        if (syncCalls === 1) {
          sendJson(response, 202, {
            world_state: 'finality_pending',
            error: 'Base finality is pending; retry this sync and do not pay again',
          })
        } else {
          sendJson(response, 200, { listing: { id: 23, world_state: 'needs_review' } })
        }
        return
      }
      if (request.method === 'GET' && request.url === '/api/listing/23') {
        assert.equal(request.headers.authorization, undefined)
        sendJson(response, 200, { listing: { id: 23, world_state: 'needs_review' } })
        return
      }
      sendJson(response, 404, { error: `unexpected market route ${request.method} ${request.url}` })
    })

    try {
      const origins = { city: city.origin, market: market.origin }
      const first = await runClient(origins, stateDirectory)
      assert.equal(first.status, 2, first.stderr)
      assert.match(first.stderr, /Step 4.*pending.*same command again/isu)
      assert.equal(signedHeaders.length, 1)
      assert.deepEqual(claimBodies, [
        { market_checkout_id: 77, buyer_wallet: TEST_ACCOUNT.address },
        { market_checkout_id: 77, buyer_wallet: TEST_ACCOUNT.address },
      ])

      const second = await runClient(origins, stateDirectory)
      assert.equal(second.status, 2, second.stderr)
      assert.equal(signedHeaders.length, 1)
      assert.deepEqual(recoveryRequests, ['reconcile'])
      assert.equal(syncCalls, 2)
      assert.match(second.stdout, /Thing 2723 is currently owned by test-buyer\./u)
      assert.match(second.stdout, /Listing 23 world state is needs_review\./u)

      const stateFiles = await readdir(stateDirectory)
      assert.equal(stateFiles.length, 1)
      const state = await readFile(join(stateDirectory, stateFiles[0]!), 'utf8')
      const saved = JSON.parse(state) as Record<string, unknown>
      assert.equal(saved.checkout_id, 77)
      assert.match(String(saved.nonce), /^0x[0-9a-f]{64}$/u)
      assert.equal(saved.tx_hash, TEST_TX_HASH)
      const allOutput = `${first.stdout}\n${first.stderr}\n${second.stdout}\n${second.stderr}\n${state}`
      for (const secret of [TEST_CITY_KEY, TEST_MARKET_KEY, TEST_PRIVATE_KEY, signedHeaders[0]!]) {
        assert.equal(allOutput.includes(secret), false)
      }
    } finally {
      await Promise.all([close(city.server), close(market.server)])
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test('world-buy resumes a saved nonce with a bare claim, then reuses that nonce after 402', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-saved-nonce-'))
    await savePurchaseState(stateDirectory, { nonce: TEST_NONCE })
    const claimHeaders: Array<string | undefined> = []
    let offerReadCalls = 0
    let cityOrigin = ''

    const city = await listen((request, response) => {
      if (request.method === 'GET' && request.url === '/api/world/offer/31') {
        offerReadCalls += 1
        if (offerReadCalls === 1) {
          response.destroy()
          return
        }
        sendJson(response, 200, { offer: { phase: 'reserved', asset_id: 2723 } })
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/offer/31/claim') {
        const paymentHeader = request.headers['x-payment']
        claimHeaders.push(typeof paymentHeader === 'string' ? paymentHeader : undefined)
        if (paymentHeader == null) {
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
        sendJson(response, 200, { offer: { phase: 'claimed', asset_id: 2723 } })
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

    try {
      const result = await runClient({ city: city.origin, market: market.origin }, stateDirectory)
      assert.equal(result.status, 0)
      assert.equal(offerReadCalls, 2)
      assert.equal(claimHeaders.length, 2)
      assert.equal(claimHeaders[0], undefined)
      assert.equal(typeof claimHeaders[1], 'string')
      const paid = JSON.parse(Buffer.from(claimHeaders[1]!, 'base64').toString('utf8')) as {
        payload: { authorization: { nonce: string } }
      }
      assert.equal(paid.payload.authorization.nonce, TEST_NONCE)
    } finally {
      await Promise.all([close(city.server), close(market.server)])
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
}
