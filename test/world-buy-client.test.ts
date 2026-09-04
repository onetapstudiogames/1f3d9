import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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
    stdout: (message: string) => { stdout += message },
    stderr: (message: string) => { stderr += message },
  })
  return { status, stdout, stderr }
}

test('world-buy resumes payment_pending without another signature and stops sync on terminal state', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-test-'))
  const signedHeaders: string[] = []
  const claimBodies: Record<string, unknown>[] = []
  let cityOrigin = ''
  let syncCalls = 0

  const city = await listen((request, response, body) => {
    if (request.url !== '/api/thing/2723') {
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
    if (request.method === 'POST' && request.url === '/api/world/offer/31/reconcile') {
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
    if (request.method === 'GET' && request.url === '/api/thing/2723') {
      sendJson(response, 200, { thing: { id: 2723, current_owner: 'test-buyer' } })
      return
    }
    sendJson(response, 404, { error: `unexpected city route ${request.method} ${request.url}` })
  })
  cityOrigin = city.origin

  const market = await listen((request, response) => {
    if (request.method === 'POST' && request.url === '/api/world/checkout/23') {
      sendJson(response, 201, { checkout: { id: 78 } })
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
    assert.ok(stderr.includes('did not answer in time'))
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
