import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'
import { mountPayPalCreditRoutes } from '../src/paypal-credit-routes.ts'
import { PayPalCreditStoreConflictError } from '../src/paypal-credit-store.ts'
import {
  MemoryPayPalDatabase,
  ORDER_ID,
  PURCHASE_ID_PATTERN,
  READY_ENV,
  WEBHOOK_HEADERS,
  completedCaptureWebhook,
  configuredApp,
  paypalFetcher,
  postJson,
  postRaw,
} from './paypal-credit-route-fixture.ts'

test('every dormant PayPal route returns a caller-specific config-first 503 without auth, body, DB, or network work', async () => {
  let databaseCalls = 0
  let authCalls = 0
  let fetchCalls = 0
  const app = new Hono()
  mountPayPalCreditRoutes(app, {
    database: { async query() { databaseCalls += 1; throw new Error('must not query') } },
    environment: {},
    publicOrigin: 'not even parsed while dormant',
    authenticate: async () => { authCalls += 1; throw new Error('must not authenticate') },
    fetcher: (async () => { fetchCalls += 1; throw new Error('must not fetch') }) as typeof fetch,
  })
  const responses = await Promise.all([
    app.request('/api/city-credit/paypal/residents/not-a-number'),
    app.request('/api/city-credit/paypal/orders', { method: 'POST', body: '{broken' }),
    app.request('/api/city-credit/paypal/orders/not-an-id/capture', { method: 'POST' }),
    app.request('/api/city-credit/paypal/allowances', { method: 'POST' }),
    app.request('/api/city-credit/paypal/webhook', { method: 'POST' }),
  ])

  const lookupFailure = await responses[0]!.json() as Record<string, unknown>
  assert.equal(responses[0]!.status, 503)
  assert.match(String(lookupFailure.error), /not configured[\s\S]*retry this lookup/iu)
  assert.equal(lookupFailure.payment_started, false)

  const orderFailure = await responses[1]!.json() as Record<string, unknown>
  assert.equal(responses[1]!.status, 503)
  assert.match(String(orderFailure.error), /not configured[\s\S]*same request_id/iu)
  assert.equal(orderFailure.payment_started, false)

  const allowanceFailure = await responses[3]!.json() as Record<string, unknown>
  assert.equal(responses[3]!.status, 503)
  assert.match(String(allowanceFailure.error), /not configured[\s\S]*same request_id/iu)
  assert.equal(allowanceFailure.payment_started, false)
  const capture = responses[2]!
  assert.equal(capture.status, 503)
  const captureFailure = await capture.json() as Record<string, unknown>
  assert.match(String(captureFailure.error),
    /not configured[\s\S]*same purchase_id[\s\S]*paypal_order_id/iu)
  assert.doesNotMatch(String(captureFailure.error), /no (?:new )?payment was started/iu)
  assert.equal(captureFailure.payment_started, undefined)

  const webhook = responses[4]!
  assert.equal(webhook.status, 503)
  assert.match(
    String((await webhook.json() as { error: unknown }).error),
    /not configured[\s\S]*PayPal should retry this exact event/iu,
  )
  assert.deepEqual({ databaseCalls, authCalls, fetchCalls }, {
    databaseCalls: 0, authCalls: 0, fetchCalls: 0,
  })
})

test('unusable declared lengths reject before DB or network work', async () => {
  // The production edge may drop or fold the Content-Length header, so only a
  // declaration that is present and unusable is refused up front; the enforced
  // bound is the actual byte count after the read.
  const { app, database, paypal } = configuredApp()
  const body = JSON.stringify({ request_id: 'bounded-body-proof-0001' })
  const badDeclarations = ['abc', '2049', '10, 20']
  const requests = badDeclarations.flatMap(declared => [
    app.request('/api/city-credit/paypal/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': declared },
      body,
    }),
    app.request(`/api/city-credit/paypal/orders/city_paypal_${'ab'.repeat(16)}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': declared },
      body,
    }),
    app.request('/api/city-credit/paypal/allowances', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': declared },
      body,
    }),
  ])

  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 400)
    assert.match(String((await response.json() as { error: string }).error), /Content-Length/iu)
  }
  assert.equal(database.calls.length, 0)
  assert.equal(paypal.calls.length, 0)

  const webhookOversized = await app.request('/api/city-credit/paypal/webhook', {
    method: 'POST',
    headers: { ...WEBHOOK_HEADERS, 'content-length': String(1_048_577) },
    body,
  })
  assert.equal(webhookOversized.status, 400)
  assert.match(
    String((await webhookOversized.json() as { error: string }).error),
    /Content-Length/iu,
  )
})

test('an absent or edge-folded Content-Length reaches the body read instead of failing the guard', async () => {
  const { app } = configuredApp()
  const body = JSON.stringify({ request_id: 'bounded-body-proof-0002' })
  const declaredLength = String(Buffer.byteLength(body, 'utf8'))
  const headerVariants: Array<Record<string, string>> = [
    { 'content-type': 'application/json' },
    {
      'content-type': 'application/json',
      'content-length': `${declaredLength}, ${declaredLength}`,
    },
  ]
  for (const headers of headerVariants) {
    const response = await app.request('/api/city-credit/paypal/orders', {
      method: 'POST', headers, body,
    })
    const error = String((await response.json() as { error: string }).error)
    assert.doesNotMatch(error, /Content-Length/iu)
    assert.notEqual(response.status, 500)
  }
})

test('capture and webhook rate limits stop PayPal calls in separate buckets', async () => {
  const rateHashes: string[] = []
  let fetchCalls = 0
  const app = new Hono()
  mountPayPalCreditRoutes(app, {
    database: {
      async query(text, params = []) {
        if (!text.includes('paypal-credit:rate-limit')) {
          throw new Error('rate rejection must happen before other database work')
        }
        rateHashes.push(String(params[0]))
        return []
      },
    },
    environment: READY_ENV,
    publicOrigin: 'https://1f3d9.com',
    fetcher: (async () => {
      fetchCalls += 1
      throw new Error('rate rejection must happen before PayPal work')
    }) as typeof fetch,
  })

  const purchaseId = `city_paypal_${'ab'.repeat(16)}`
  const capture = await app.request(
    `/api/city-credit/paypal/orders/${purchaseId}/capture`,
    postJson({
      paypal_order_id: ORDER_ID,
    }),
  )
  const webhookBody = completedCaptureWebhook()
  const webhookRequest = new Request(
    'http://localhost/api/city-credit/paypal/webhook',
    postRaw(webhookBody, WEBHOOK_HEADERS),
  )
  const originalArrayBuffer = webhookRequest.arrayBuffer.bind(webhookRequest)
  let webhookBodyReads = 0
  Object.defineProperty(webhookRequest, 'arrayBuffer', {
    value: async () => {
      webhookBodyReads += 1
      return await originalArrayBuffer()
    },
  })
  const webhook = await app.fetch(webhookRequest)

  assert.equal(capture.status, 429)
  assert.match(String((await capture.json() as { error: string }).error), /capture/iu)
  assert.equal(webhook.status, 429)
  assert.match(String((await webhook.json() as { error: string }).error), /webhook/iu)
  assert.equal(webhookBodyReads, 0, 'rate rejection must happen before the 1 MiB body read')
  assert.equal(fetchCalls, 0)
  assert.equal(rateHashes.length, 2)
  assert.notEqual(rateHashes[0], rateHashes[1], 'capture and webhook must not starve each other')
  assert.notEqual(
    rateHashes[0],
    createHash('sha256')
      .update('paypal-credit:capture:anonymous:local-or-unattributed', 'utf8')
      .digest('hex'),
    'stored caller buckets must be keyed, not reversible unsalted IP hashes',
  )
})

test('webhook admission allows 31 distinct deliveries but remains bounded', async () => {
  const { app, database, paypal } = configuredApp()
  for (let sequence = 1; sequence <= 31; sequence += 1) {
    const body = JSON.stringify({
      id: `WH-RATE-${String(sequence).padStart(8, '0')}`,
      event_type: 'CHECKOUT.ORDER.APPROVED',
      resource: { id: `ORDER-RATE-${String(sequence).padStart(8, '0')}` },
    })
    const response = await app.request(
      '/api/city-credit/paypal/webhook',
      postRaw(body, WEBHOOK_HEADERS),
    )
    assert.equal(response.status, 200, `delivery ${sequence}: ${await response.clone().text()}`)
    assert.deepEqual(await response.json(), { received: true, outcome: 'ignored' })
  }

  const rateCalls = database.calls.filter(call => call.text.includes('paypal-credit:rate-limit'))
  assert.equal(rateCalls.length, 31)
  assert.ok(rateCalls.every(call => call.params[1] === 300))
  const bucketHash = String(rateCalls.at(-1)?.params[0])
  database.rateUses.set(bucketHash, 300)
  const blockedBody = JSON.stringify({
    id: 'WH-RATE-BOUNDED-0001',
    event_type: 'CHECKOUT.ORDER.APPROVED',
    resource: { id: 'ORDER-RATE-BOUNDED-0001' },
  })
  const blocked = await app.request(
    '/api/city-credit/paypal/webhook',
    postRaw(blockedBody, WEBHOOK_HEADERS),
  )
  assert.equal(blocked.status, 429)
  assert.equal(
    paypal.calls.filter(call => call.url.endsWith('/v1/notifications/verify-webhook-signature')).length,
    31,
  )
})

test('credential-shaped request ids are rejected before DB or PayPal work', async () => {
  const { app, database, paypal } = configuredApp()
  const response = await app.request('/api/city-credit/paypal/orders', postJson({
    request_id: `1f3d9_sk_${'a'.repeat(48)}`,
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))

  assert.equal(response.status, 400)
  assert.match(String((await response.json() as { error: string }).error), /non-secret/iu)
  assert.equal(database.calls.length, 0)
  assert.equal(paypal.calls.length, 0)
})

test('lookup echoes the handle, while self purchases require that resident bearer', async () => {
  const { app, paypal } = configuredApp()
  const lookup = await app.request('/api/city-credit/paypal/residents/193')
  assert.equal(lookup.status, 200)
  assert.deepEqual(await lookup.json(), {
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
  })

  const selfBody = JSON.stringify({
    request_id: 'paypal-self-request-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'self',
  })
  const unauthenticated = await app.request('/api/city-credit/paypal/orders', {
    ...postJson(selfBody),
  })
  assert.equal(unauthenticated.status, 401)
  assert.equal(paypal.calls.length, 0)

  const authenticated = await app.request('/api/city-credit/paypal/orders',
    postJson(selfBody, { authorization: 'Bearer resident-193' }))
  assert.equal(authenticated.status, 201, await authenticated.clone().text())
  const result = await authenticated.json() as Record<string, unknown>
  assert.match(String(result.purchase_id), PURCHASE_ID_PATTERN)
  assert.equal(result.resident_handle, 'keeps-the-maybe')
  assert.equal(result.claim_token, undefined)
  assert.equal(result.approval_url, `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`)
  const orderCall = paypal.calls.find(call => call.url.endsWith('/v2/checkout/orders'))
  const orderTerms = JSON.parse(String(orderCall?.init?.body)) as {
    payment_source: { paypal: { experience_context: Record<string, unknown> } }
  }
  assert.deepEqual(orderTerms.payment_source.paypal.experience_context, {
    payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
    shipping_preference: 'NO_SHIPPING',
    user_action: 'PAY_NOW',
    return_url: `https://1f3d9.com/buy?paypal=return&purchase_id=${result.purchase_id}`,
    cancel_url: `https://1f3d9.com/buy?paypal=cancel&purchase_id=${result.purchase_id}`,
  })
})

test('bound self order and allowance replays return local approval links without PayPal calls', async () => {
  const { app, paypal } = configuredApp()
  const selfOrder = {
    request_id: 'paypal-local-order-replay-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'self',
  }
  const firstOrder = await app.request('/api/city-credit/paypal/orders',
    postJson(selfOrder, { authorization: 'Bearer resident-193' }))
  assert.equal(firstOrder.status, 201, await firstOrder.clone().text())
  const firstOrderBody = await firstOrder.json() as Record<string, unknown>
  const callsAfterFirstOrder = paypal.calls.length

  const repeatedOrder = await app.request('/api/city-credit/paypal/orders',
    postJson(selfOrder, { authorization: 'Bearer resident-193' }))
  assert.equal(repeatedOrder.status, 200, await repeatedOrder.clone().text())
  const repeatedOrderBody = await repeatedOrder.json() as Record<string, unknown>
  assert.equal(repeatedOrderBody.purchase_id, firstOrderBody.purchase_id)
  assert.equal(repeatedOrderBody.approval_url, firstOrderBody.approval_url)
  assert.equal(paypal.calls.length, callsAfterFirstOrder,
    'a bound order replay must not ask PayPal to create the order again')

  const allowance = {
    request_id: 'paypal-local-allowance-replay-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
  }
  const firstAllowance = await app.request('/api/city-credit/paypal/allowances',
    postJson(allowance, { authorization: 'Bearer resident-193' }))
  assert.equal(firstAllowance.status, 201, await firstAllowance.clone().text())
  const firstAllowanceBody = await firstAllowance.json() as Record<string, unknown>
  const callsAfterFirstAllowance = paypal.calls.length

  const repeatedAllowance = await app.request('/api/city-credit/paypal/allowances',
    postJson(allowance, { authorization: 'Bearer resident-193' }))
  assert.equal(repeatedAllowance.status, 200, await repeatedAllowance.clone().text())
  const repeatedAllowanceBody = await repeatedAllowance.json() as Record<string, unknown>
  assert.equal(repeatedAllowanceBody.purchase_id, firstAllowanceBody.purchase_id)
  assert.equal(repeatedAllowanceBody.approval_url, firstAllowanceBody.approval_url)
  assert.equal(paypal.calls.length, callsAfterFirstAllowance,
    'a bound allowance replay must not ask PayPal to create the subscription again')
})

test('gift create shows the redirect secret once and a replay cannot continue without it', async () => {
  const { app, database, paypal } = configuredApp()
  const body = JSON.stringify({
    request_id: 'paypal-gift-request-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  })
  const first = await app.request('/api/city-credit/paypal/orders', postJson(body))
  assert.equal(first.status, 201, await first.clone().text())
  const created = await first.json() as Record<string, unknown>
  assert.match(String(created.claim_token), /^gift_claim_[0-9a-f]{64}$/u)
  assert.equal(created.claim_token_shown, true)

  const callsBeforeReplay = paypal.calls.length
  const replay = await app.request('/api/city-credit/paypal/orders', postJson(body))
  assert.equal(replay.status, 409, await replay.clone().text())
  const repeated = await replay.json() as Record<string, unknown>
  assert.equal(repeated.purchase_id, created.purchase_id)
  assert.equal(repeated.claim_token, undefined)
  assert.equal(repeated.approval_url, undefined)
  assert.equal(repeated.do_not_approve_old_order, true)
  assert.match(String(repeated.error), /one-time redirect key[\s\S]*fresh request_id/iu)
  assert.equal(paypal.calls.length, callsBeforeReplay, 'replay must stop before a PayPal call')

  const captureBody = JSON.stringify({ paypal_order_id: ORDER_ID })
  const capturePath = `/api/city-credit/paypal/orders/${created.purchase_id}/capture`
  const captured = await app.request(capturePath, postJson(captureBody))
  assert.equal(captured.status, 200, await captured.clone().text())
  const receipt = await captured.json() as Record<string, unknown>
  assert.equal(receipt.delivery, 'gift')
  assert.equal(receipt.status, 'pending')
  assert.match(String(receipt.gift_id), /^city_gift_[0-9a-f]{32}$/u)

  const captureReplay = await app.request(capturePath, postJson(captureBody))
  assert.equal(captureReplay.status, 200, await captureReplay.clone().text())
  assert.deepEqual(await captureReplay.json(), receipt,
    'a captured intent must replay its immutable local receipt')
  assert.equal(database.purchases.size, 1)
  const captureCalls = paypal.calls.filter(call => call.url.endsWith(`/${ORDER_ID}/capture`))
  assert.equal(captureCalls.length, 1,
    'a captured intent replay must not call the PayPal capture endpoint again')
  assert.equal(
    new Headers(captureCalls[0]?.init?.headers).get('paypal-request-id'),
    `paypal-order-capture:${created.purchase_id}`,
  )

  const completedCreateReplay = await app.request(
    '/api/city-credit/paypal/orders',
    postJson(body),
  )
  assert.equal(completedCreateReplay.status, 409)
  const completedMessage = String(
    (await completedCreateReplay.json() as { error: unknown }).error,
  )
  assert.match(completedMessage, /purchase is complete[\s\S]*do not (?:approve|pay)/iu)
  assert.match(completedMessage, /only the credited resident[\s\S]*private receipt/iu)
  assert.doesNotMatch(completedMessage, /^Read the resident receipt|\. Read the resident receipt/iu)
})

test('a failed gift order advertises a fresh request id because its one-time key was not delivered', async () => {
  const database = new MemoryPayPalDatabase()
  const app = new Hono()
  let fetchCalls = 0
  mountPayPalCreditRoutes(app, {
    database,
    environment: READY_ENV,
    publicOrigin: 'https://1f3d9.com',
    fetcher: (async () => {
      fetchCalls += 1
      throw new Error('simulated provider outage')
    }) as typeof fetch,
  })
  const body = {
    request_id: 'paypal-failed-gift-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }

  const failed = await app.request('/api/city-credit/paypal/orders', postJson(body))
  assert.equal(failed.status, 503, await failed.clone().text())
  const failedBody = await failed.json() as Record<string, unknown>
  assert.match(String(failedBody.error), /no approval URL[\s\S]*fresh request_id/iu)
  assert.equal(failedBody.start_fresh_request_id, true)
  assert.equal(failedBody.retry_same_request_id, false)
  assert.equal(failedBody.do_not_approve_old_order, true)

  const replay = await app.request('/api/city-credit/paypal/orders', postJson(body))
  assert.equal(replay.status, 409, await replay.clone().text())
  const replayBody = await replay.json() as Record<string, unknown>
  assert.match(String(replayBody.error), /start a fresh request_id/iu)
  assert.doesNotMatch(String(replayBody.error), /retry the same request_id/iu)
  assert.equal(fetchCalls, 1)
})

test('unexpected failures tell each caller exactly which operation to retry', async t => {
  const errorBody = async (response: Response): Promise<string> => {
    assert.equal(response.status, 503, await response.clone().text())
    return String((await response.json() as { error: unknown }).error)
  }
  const failingFetcher = (async () => {
    throw new Error('simulated PayPal outage')
  }) as typeof fetch

  await t.test('resident lookup', async () => {
    const app = new Hono()
    mountPayPalCreditRoutes(app, {
      database: {
        async query(text) {
          if (text.includes('paypal-credit:rate-limit')) return [{ used: 1 }]
          throw new Error('simulated resident lookup outage')
        },
      },
      environment: READY_ENV,
      publicOrigin: 'https://1f3d9.com',
      fetcher: failingFetcher,
    })
    assert.match(await errorBody(
      await app.request('/api/city-credit/paypal/residents/193')),
    /resident lookup[\s\S]*retry (?:this|the same) lookup/iu)
  })

  for (const operation of ['order', 'allowance'] as const) {
    await t.test(`${operation} creation`, async () => {
      const database = new MemoryPayPalDatabase()
      const app = new Hono()
      mountPayPalCreditRoutes(app, {
        database,
        environment: READY_ENV,
        publicOrigin: 'https://1f3d9.com',
        fetcher: failingFetcher,
        authenticate: async () => ({ id: 193 }),
      })
      const body = operation === 'order'
        ? {
            request_id: 'paypal-failed-order-0193',
            resident_number: 193,
            resident_handle: 'keeps-the-maybe',
            amount_dollars: '3',
            delivery: 'self',
          }
        : {
            request_id: 'paypal-failed-allowance-0193',
            resident_number: 193,
            resident_handle: 'keeps-the-maybe',
            amount_dollars: '3',
          }
      const path = operation === 'order'
        ? '/api/city-credit/paypal/orders'
        : '/api/city-credit/paypal/allowances'
      const message = await errorBody(await app.request(path, postJson(body)))
      assert.match(message, new RegExp(`${operation}[\\s\\S]*same request_id`, 'iu'))
    })
  }

  await t.test('capture', async () => {
    const seeded = configuredApp()
    const createdResponse = await seeded.app.request('/api/city-credit/paypal/orders',
      postJson({
        request_id: 'paypal-failed-capture-seed-0193',
        resident_number: 193,
        resident_handle: 'keeps-the-maybe',
        amount_dollars: '3',
        delivery: 'self',
      }, { authorization: 'Bearer resident-193' }))
    const created = await createdResponse.json() as { purchase_id: string }
    const app = new Hono()
    mountPayPalCreditRoutes(app, {
      database: seeded.database,
      environment: READY_ENV,
      publicOrigin: 'https://1f3d9.com',
      fetcher: failingFetcher,
    })
    const response = await app.request(
      `/api/city-credit/paypal/orders/${created.purchase_id}/capture`,
      postJson({ paypal_order_id: ORDER_ID }),
    )
    const message = await errorBody(response)
    assert.match(message, /reload[\s\S]*same purchase_id[\s\S]*paypal_order_id/iu)
    assert.doesNotMatch(message, /no (?:new )?payment was started/iu)
  })

  await t.test('webhook', async () => {
    const app = new Hono()
    mountPayPalCreditRoutes(app, {
      database: new MemoryPayPalDatabase(),
      environment: READY_ENV,
      publicOrigin: 'https://1f3d9.com',
      fetcher: failingFetcher,
    })
    const response = await app.request('/api/city-credit/paypal/webhook',
      postRaw(completedCaptureWebhook(), WEBHOOK_HEADERS))
    assert.match(await errorBody(response), /PayPal should retry this exact event/iu)
  })
})

test('capture request errors never falsely claim that no payment started', async () => {
  const { app } = configuredApp()
  const validPurchaseId = `city_paypal_${'ab'.repeat(16)}`
  const requests = [
    app.request('/api/city-credit/paypal/orders/not-a-purchase/capture',
      postJson({ paypal_order_id: ORDER_ID })),
    app.request(`/api/city-credit/paypal/orders/${validPurchaseId}/capture`, postJson({})),
    app.request(`/api/city-credit/paypal/orders/${validPurchaseId}/capture`,
      postJson({ paypal_order_id: 'not allowed spaces' })),
  ]

  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 400, await response.clone().text())
    const message = String((await response.json() as { error: unknown }).error)
    assert.doesNotMatch(message, /no (?:new )?payment was started/iu)
  }
})

test('webhook internal validation asks for the exact event instead of payment-browser action', async () => {
  class MalformedIntentDatabase extends MemoryPayPalDatabase {
    override async query(text: string, params: readonly unknown[] = []) {
      if (text.includes('paypal-credit:read-order')) return [{}]
      return await super.query(text, params)
    }
  }
  const { app } = configuredApp(new MalformedIntentDatabase())

  const response = await app.request('/api/city-credit/paypal/webhook',
    postRaw(completedCaptureWebhook('WH-MALFORMED-STORED-0001'), WEBHOOK_HEADERS))
  assert.equal(response.status, 503, await response.clone().text())
  const body = await response.json() as Record<string, unknown>
  assert.match(String(body.error), /PayPal should retry this exact event/iu)
  assert.equal(body.paypal_should_retry_exact_event, true)
  assert.doesNotMatch(String(body.error), /No payment was started|start another payment/iu)
})

test('a webhook evidence conflict asks for owner resolution without browser-payment wording', async () => {
  class ConflictDatabase extends MemoryPayPalDatabase {
    override async query(text: string, params: readonly unknown[] = []) {
      if (text.includes('paypal-credit:deliver-atomic')) {
        throw new PayPalCreditStoreConflictError('Durable PayPal evidence conflicts.')
      }
      return await super.query(text, params)
    }
  }
  const database = new ConflictDatabase()
  const { app } = configuredApp(database)
  const order = await app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-webhook-conflict-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'self',
  }, { authorization: 'Bearer resident-193' }))
  assert.equal(order.status, 201, await order.clone().text())

  const response = await app.request('/api/city-credit/paypal/webhook',
    postRaw(completedCaptureWebhook('WH-CONFLICT-0001'), WEBHOOK_HEADERS))
  assert.equal(response.status, 409, await response.clone().text())
  const body = await response.json() as Record<string, unknown>
  assert.match(String(body.error), /city owner must resolve/iu)
  assert.match(String(body.error), /do not send a changed replacement event/iu)
  assert.equal(body.owner_review_required, true)
  assert.equal(body.do_not_retry_with_changed_event, true)
  assert.equal(body.do_not_start_another_payment, undefined)
})

test('a post-capture resident lookup outage gives a working same-purchase retry', async () => {
  class OneLookupOutage extends MemoryPayPalDatabase {
    private recipientLookups = 0

    override async query(text: string, params: readonly unknown[] = []) {
      if (text.includes('paypal-credit:recipient')) {
        this.recipientLookups += 1
        if (this.recipientLookups === 2) return []
      }
      return await super.query(text, params)
    }
  }

  const { app, paypal } = configuredApp(new OneLookupOutage())
  const createdResponse = await app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-capture-receipt-retry-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'self',
  }, { authorization: 'Bearer resident-193' }))
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text())
  const created = await createdResponse.json() as { purchase_id: string }
  const path = `/api/city-credit/paypal/orders/${created.purchase_id}/capture`
  const body = postJson({ paypal_order_id: ORDER_ID })

  const unavailable = await app.request(path, body)
  assert.equal(unavailable.status, 503)
  const message = String((await unavailable.json() as { error: unknown }).error)
  assert.match(message, /capture completed[\s\S]*same purchase_id[\s\S]*paypal_order_id/iu)
  assert.doesNotMatch(message, /no (?:new )?payment was started/iu)

  const replay = await app.request(path, body)
  assert.equal(replay.status, 200, await replay.clone().text())
  assert.equal(
    paypal.calls.filter(call => call.url.endsWith(`/${ORDER_ID}/capture`)).length,
    1,
    'the advertised reload must use the local captured receipt',
  )
})

test('capture rejects a purchase from another PayPal environment before network or delivery', async () => {
  const seeded = configuredApp()
  const order = await seeded.app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-environment-order-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'self',
  }, { authorization: 'Bearer resident-193' }))
  assert.equal(order.status, 201, await order.clone().text())
  const created = await order.json() as { purchase_id: string }

  const livePayPal = paypalFetcher()
  const liveApp = new Hono()
  mountPayPalCreditRoutes(liveApp, {
    database: seeded.database,
    environment: { ...READY_ENV, PAYPAL_ENV: 'live' },
    publicOrigin: 'https://1f3d9.com',
    fetcher: livePayPal.fetcher,
  })
  const capture = await liveApp.request(
    `/api/city-credit/paypal/orders/${created.purchase_id}/capture`,
    postJson({ paypal_order_id: ORDER_ID }),
  )
  assert.equal(capture.status, 409, await capture.clone().text())
  assert.match(
    String((await capture.json() as { error: string }).error),
    /belongs to PayPal sandbox[\s\S]*using PayPal live[\s\S]*Do not start another payment/iu,
  )
  assert.equal(livePayPal.calls.length, 0)
  assert.equal(seeded.database.purchases.size, 0)
})
