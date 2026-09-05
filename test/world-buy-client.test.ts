import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { parseX402Payment, requirements } from '../src/pay.ts'

// Public test fixture only. It must never hold funds.
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_CITY_KEY = 'city-secret-for-world-buy-test'
const TEST_MARKET_KEY = 'market-secret-for-world-buy-test'
const TEST_NONCE = `0x${'12'.repeat(32)}` as `0x${string}`
const TEST_TX_HASH = `0x${'34'.repeat(32)}`
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY)

// The declaration is added with the reference client.
const { buildX402PaymentHeader, freshWallet, runWorldBuy } = await import('../scripts/world-buy.mjs')

test('world-buy builds the exact signed X-PAYMENT shape accepted by the city', async () => {
  const accepted = requirements(
    '0x1111111111111111111111111111111111111111',
    1,
    'https://city.test/api/world/offer/31/claim',
    'test world offer',
  )
  const header = await buildX402PaymentHeader({
    accepted,
    privateKey: TEST_PRIVATE_KEY,
    wallet: TEST_ACCOUNT.address,
    nonce: TEST_NONCE,
    nowSeconds: 1_786_900_000,
  })

  const parsed = parseX402Payment(header, accepted)
  assert.equal('error' in parsed, false)
  if ('error' in parsed) return
  assert.equal(parsed.authorization.payer, TEST_ACCOUNT.address.toLowerCase())

  const payment = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
    payload: {
      signature: `0x${string}`
      authorization: {
        from: `0x${string}`
        to: `0x${string}`
        value: string
        validAfter: string
        validBefore: string
        nonce: `0x${string}`
      }
    }
  }
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: accepted.extra.name,
      version: accepted.extra.version,
      chainId: 8453,
      verifyingContract: accepted.asset as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: payment.payload.authorization.from,
      to: payment.payload.authorization.to,
      value: BigInt(payment.payload.authorization.value),
      validAfter: BigInt(payment.payload.authorization.validAfter),
      validBefore: BigInt(payment.payload.authorization.validBefore),
      nonce: payment.payload.authorization.nonce,
    },
    signature: payment.payload.signature,
  })
  assert.equal(recovered.toLowerCase(), TEST_ACCOUNT.address.toLowerCase())
})

type JsonHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
) => void | Promise<void>

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function listen(handler: JsonHandler): Promise<{ origin: string; server: Server }> {
  const server = createServer(async (request, response) => {
    try {
      await handler(request, response, await readJsonBody(request))
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error('stub server failed'))
    }
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { origin: `http://127.0.0.1:${address.port}`, server }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose())
  })
}

async function runClient(origins: { city: string; market: string }, stateDirectory: string) {
  let stdout = ''
  let stderr = ''
  const status = await runWorldBuy({
    listingId: 23,
    offerId: 31,
    wallet: TEST_ACCOUNT.address,
    cityKey: TEST_CITY_KEY,
    marketKey: TEST_MARKET_KEY,
    privateKey: TEST_PRIVATE_KEY,
    cityOrigin: origins.city,
    marketOrigin: origins.market,
    stateDirectory,
    syncDelayMs: 5,
    reconcileRetryDelayMs: 5,
    reconcileAttempts: 3,
    stdout: (message: string) => { stdout += message },
    stderr: (message: string) => { stderr += message },
  })
  return { status, stdout, stderr }
}

async function savePurchaseState(stateDirectory: string, values: Record<string, unknown>): Promise<void> {
  await writeFile(join(stateDirectory, '1f3d9-world-buy-23-31.json'), `${JSON.stringify({
    version: 1,
    listing_id: 23,
    offer_id: 31,
    checkout_id: 77,
    ...values,
  })}\n`)
}

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
    assert.equal(first.status, 2)
    assert.match(first.stderr, /Step 4.*pending.*same command again/isu)
    assert.equal(signedHeaders.length, 1)
    assert.deepEqual(claimBodies, [
      { market_checkout_id: 77, buyer_wallet: TEST_ACCOUNT.address },
      { market_checkout_id: 77, buyer_wallet: TEST_ACCOUNT.address },
    ])

    const second = await runClient(origins, stateDirectory)
    assert.equal(second.status, 2)
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

test('world-buy prints the request id from a paid claim 500', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-request-id-'))
  let cityOrigin = ''

  const city = await listen((request, response) => {
    if (request.method === 'GET' && request.url === '/api/me') {
      sendJson(response, 200, { handle: 'test-buyer' })
      return
    }
    if (request.method === 'POST' && request.url === '/api/world/offer/31/claim') {
      if (request.headers['x-payment'] == null) {
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
      sendJson(response, 500, { error: 'internal city failure', request_id: 'req-sale-1' })
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

  try {
    const result = await runClient({ city: city.origin, market: market.origin }, stateDirectory)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /internal city failure.*req-sale-1/isu)
  } finally {
    await Promise.all([close(city.server), close(market.server)])
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

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

test('new-wallet makes a key whose address matches it and never reuses a key', () => {
  const first = freshWallet()
  const second = freshWallet()
  assert.match(first.privateKey, /^0x[0-9a-f]{64}$/u)
  assert.equal(privateKeyToAccount(first.privateKey).address, first.address)
  assert.notEqual(first.privateKey, second.privateKey)
  const fixed = freshWallet(() => TEST_PRIVATE_KEY)
  assert.equal(fixed.address, TEST_ACCOUNT.address)
})

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
