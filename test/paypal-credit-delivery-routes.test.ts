import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MemoryPayPalDatabase,
  ORDER_ID,
  SUBSCRIPTION_ID,
  WEBHOOK_HEADERS,
  completedCaptureWebhook,
  configuredApp,
  postJson,
  postRaw,
} from './paypal-credit-route-fixture.ts'

test('unverified PayPal webhooks cannot create credit, ledger rows, or delivery evidence', async t => {
  const cases = [
    {
      name: 'verification_status FAILURE',
      verifier: () => Response.json({ verification_status: 'FAILURE' }),
      status: 401,
      error: /signature was not verified/iu,
      retryExactEvent: undefined,
    },
    {
      name: 'malformed verification response',
      verifier: () => new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      status: 503,
      error: /temporarily unavailable[\s\S]*retry this exact event/iu,
      retryExactEvent: true,
    },
    {
      name: 'verification endpoint outage',
      verifier: () => Response.json(
        { name: 'SERVICE_UNAVAILABLE' },
        { status: 503 },
      ),
      status: 503,
      error: /temporarily unavailable[\s\S]*retry this exact event/iu,
      retryExactEvent: true,
    },
  ] as const

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const database = new MemoryPayPalDatabase()
      const { app, paypal } = configuredApp(database, {
        verifyWebhook: testCase.verifier,
      })
      const order = await app.request('/api/city-credit/paypal/orders', postJson({
        request_id: `paypal-webhook-rejection-${testCase.status}-${database.calls.length}`,
        resident_number: 193,
        resident_handle: 'keeps-the-maybe',
        amount_dollars: '3',
        delivery: 'self',
      }, { authorization: 'Bearer resident-193' }))
      assert.equal(order.status, 201, await order.clone().text())

      const response = await app.request('/api/city-credit/paypal/webhook',
        postRaw(completedCaptureWebhook(`WH-REJECT-${testCase.status}-${database.calls.length}`),
          WEBHOOK_HEADERS))
      assert.equal(response.status, testCase.status, await response.clone().text())
      const body = await response.json() as Record<string, unknown>
      assert.match(String(body.error), testCase.error)
      assert.equal(body.paypal_should_retry_exact_event, testCase.retryExactEvent)

      assert.equal(database.purchases.size, 0, 'rejected evidence must create no credit ledger row')
      assert.equal(database.events.size, 0, 'rejected evidence must create no durable delivery')
      assert.equal(
        database.calls.filter(call => call.text.includes('paypal-credit:deliver-atomic')).length,
        0,
        'rejected evidence must never reach credit delivery',
      )
      assert.equal(
        [...database.intents.values()][0]?.status,
        'approval_pending',
        'the matching purchase must remain undelivered',
      )
      assert.equal(
        paypal.calls.filter(call => (
          call.url.endsWith('/v1/notifications/verify-webhook-signature')
        )).length,
        1,
      )
    })
  }
})

test('a raw verified capture webhook delivers the bound gift once on replay', async () => {
  const { app, database, paypal } = configuredApp()
  const order = await app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-webhook-gift-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))
  assert.equal(order.status, 201, await order.clone().text())

  const rawEvent = completedCaptureWebhook()
  for (let delivery = 0; delivery < 2; delivery += 1) {
    const response = await app.request('/api/city-credit/paypal/webhook',
      postRaw(rawEvent, WEBHOOK_HEADERS))
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), { received: true, outcome: 'credited' })
  }
  assert.equal(database.purchases.size, 1)
  assert.equal(database.events.size, 1)
  const verification = paypal.calls.filter(call => (
    call.url.endsWith('/v1/notifications/verify-webhook-signature')
  ))
  assert.equal(verification.length, 2)
  assert.ok(String(verification[0]?.init?.body).includes(rawEvent))
})

test('API capture and verified webhook are one delivery in either arrival order', async t => {
  for (const order of ['api-then-webhook', 'webhook-then-api'] as const) {
    await t.test(order, async () => {
      const { app, database } = configuredApp()
      const createdResponse = await app.request('/api/city-credit/paypal/orders', postJson({
        request_id: `paypal-cross-rail-${order}`,
        resident_number: 193,
        resident_handle: 'keeps-the-maybe',
        amount_dollars: '3',
        delivery: 'gift',
      }))
      assert.equal(createdResponse.status, 201, await createdResponse.clone().text())
      const created = await createdResponse.json() as { purchase_id: string }
      const capture = async () => await app.request(
        `/api/city-credit/paypal/orders/${created.purchase_id}/capture`,
        postJson({ paypal_order_id: ORDER_ID }),
      )
      const webhookBody = completedCaptureWebhook()
      const webhook = async () => await app.request('/api/city-credit/paypal/webhook',
        postRaw(webhookBody, WEBHOOK_HEADERS))

      const first = order === 'api-then-webhook' ? await capture() : await webhook()
      const second = order === 'api-then-webhook' ? await webhook() : await capture()

      assert.equal(first.status, 200, await first.clone().text())
      assert.equal(second.status, 200, await second.clone().text())
      assert.equal(database.purchases.size, 1)
      assert.equal(database.events.size, 1)
    })
  }
})

test('a verified allowance renewal credits exact stored terms once without retaining payer data', async () => {
  const { app, database, paypal } = configuredApp()
  const allowance = await app.request('/api/city-credit/paypal/allowances', postJson({
    request_id: 'paypal-allowance-request-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
  }, { authorization: 'Bearer resident-193' }))
  assert.equal(allowance.status, 201, await allowance.clone().text())
  const allowanceBody = await allowance.json() as Record<string, unknown>
  assert.equal(allowanceBody.approval_url,
    `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=${SUBSCRIPTION_ID}`)
  const subscriptionCall = paypal.calls.find(call => call.url.endsWith('/v1/billing/subscriptions'))
  const subscriptionTerms = JSON.parse(String(subscriptionCall?.init?.body)) as {
    application_context: Record<string, unknown>
  }
  assert.deepEqual(subscriptionTerms.application_context, {
    user_action: 'SUBSCRIBE_NOW',
    shipping_preference: 'NO_SHIPPING',
    return_url: `https://1f3d9.com/buy?paypal=allowance-return&purchase_id=${allowanceBody.purchase_id}`,
    cancel_url: `https://1f3d9.com/buy?paypal=allowance-cancel&purchase_id=${allowanceBody.purchase_id}`,
  })

  const event = {
    id: 'WH-4U497778DK455983B-1',
    event_type: 'PAYMENT.SALE.COMPLETED',
    resource: {
      id: '8MC585209K746392H', state: 'completed',
      amount: { total: '3.00', currency: 'USD' },
      billing_agreement_id: SUBSCRIPTION_ID,
      payer: { payer_info: { email: 'must-not-store@example.test' } },
    },
  }
  for (let delivery = 0; delivery < 2; delivery += 1) {
    const webhookBody = JSON.stringify(event)
    const response = await app.request('/api/city-credit/paypal/webhook',
      postRaw(webhookBody, WEBHOOK_HEADERS))
    assert.equal(response.status, 200, await response.clone().text())
  }
  assert.equal(database.purchases.size, 1)
  assert.equal(database.events.size, 1)
  assert.doesNotMatch(JSON.stringify([...database.intents.values()]), /must-not-store|payer|email/iu)
  const verificationCalls = paypal.calls.filter(call => (
    call.url.endsWith('/v1/notifications/verify-webhook-signature')
  ))
  assert.equal(verificationCalls.length, 2)
  assert.match(String(verificationCalls[0]?.init?.body), /must-not-store@example\.test/u)
})
