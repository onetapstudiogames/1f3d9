import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PAYPAL_UNAVAILABLE_MESSAGE,
  capturePayPalCreditOrder,
  createPayPalCreditOrder,
  createWeeklyAllowanceProduct,
  createWeeklyAllowancePlan,
  createWeeklyAllowanceSubscription,
  parsePayPalRenewal,
  paypalHostedApprovalUrl,
  paypalReadiness,
  requestPayPalAccessToken,
  verifyPayPalWebhook,
} from '../src/paypal-credit.ts'

const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com'
const LIVE_BASE_URL = 'https://api-m.paypal.com'
const ACCESS_TOKEN = 'sandbox-access-token'
const PURCHASE_ID = 'city-credit-purchase-0193'
const ORDER_ID = '5O190127TN364715T'
const CAPTURE_ID = '3C679366HH908993F'
const PLAN_ID = 'P-5ML4271244454362WXNWU5NQ'
const SUBSCRIPTION_ID = 'I-BW452GLLEP1G'
const REQUEST_ID = 'city-paypal-0193-create'

const PAYPAL_ENVIRONMENT = Object.freeze({
  PAYPAL_CLIENT_ID: 'sandbox-client-id',
  PAYPAL_CLIENT_SECRET: 'sandbox-client-secret',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_WEBHOOK_ID: '7JM96362M8497332W',
})

type RecordedCall = Readonly<{
  url: string
  init: RequestInit | undefined
}>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function requestHeaders(call: RecordedCall): Headers {
  return new Headers(call.init?.headers)
}

function requestBody(call: RecordedCall): string {
  return String(call.init?.body ?? '')
}

function paypalFetcher(
  answerApi: (call: RecordedCall) => Response | Promise<Response>,
): Readonly<{ calls: RecordedCall[]; fetcher: typeof fetch }> {
  const calls: RecordedCall[] = []
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const call = { url: String(input), init }
    calls.push(call)
    if (call.url === `${SANDBOX_BASE_URL}/v1/oauth2/token`) {
      return jsonResponse({
        scope: 'https://uri.paypal.com/services/payments/payment',
        access_token: ACCESS_TOKEN,
        token_type: 'Bearer',
        app_id: 'APP-80W284485P519543T',
        expires_in: 32_400,
      })
    }
    return await answerApi(call)
  }) as typeof fetch
  return { calls, fetcher }
}

function completedOrderCapture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    status: 'COMPLETED',
    purchase_units: [{
      reference_id: PURCHASE_ID,
      payments: {
        captures: [{
          id: CAPTURE_ID,
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '3.00' },
          final_capture: true,
          seller_receivable_breakdown: {
            gross_amount: { currency_code: 'USD', value: '3.00' },
            paypal_fee: { currency_code: 'USD', value: '0.49' },
            net_amount: { currency_code: 'USD', value: '2.51' },
          },
          ...overrides,
        }],
      },
    }],
  }
}

test('PayPal readiness requires exactly the four documented environment values', () => {
  assert.equal(
    PAYPAL_UNAVAILABLE_MESSAGE,
    'PayPal credit purchases are unavailable because the owner has not configured PayPal yet',
  )

  for (const name of [
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_ENV',
    'PAYPAL_WEBHOOK_ID',
  ] as const) {
    const environment: Record<string, string | undefined> = { ...PAYPAL_ENVIRONMENT }
    delete environment[name]
    const readiness = paypalReadiness(environment)
    assert.deepEqual(readiness, {
      ready: false,
      status: 503,
      error: PAYPAL_UNAVAILABLE_MESSAGE,
    }, `${name} must be required`)
  }

  for (const environment of [
    { ...PAYPAL_ENVIRONMENT, PAYPAL_CLIENT_ID: '   ' },
    { ...PAYPAL_ENVIRONMENT, PAYPAL_CLIENT_SECRET: '' },
    { ...PAYPAL_ENVIRONMENT, PAYPAL_WEBHOOK_ID: '\t' },
    { ...PAYPAL_ENVIRONMENT, PAYPAL_ENV: 'production' },
    { ...PAYPAL_ENVIRONMENT, PAYPAL_ENV: 'SANDBOX' },
  ]) {
    assert.deepEqual(paypalReadiness(environment), {
      ready: false,
      status: 503,
      error: PAYPAL_UNAVAILABLE_MESSAGE,
    })
  }

  const sandbox = paypalReadiness(PAYPAL_ENVIRONMENT)
  assert.equal(sandbox.ready, true)
  if (!sandbox.ready) return
  assert.equal(sandbox.environment, 'sandbox')
  assert.equal(sandbox.baseUrl, SANDBOX_BASE_URL)
  assert.doesNotMatch(JSON.stringify(sandbox), /sandbox-client-secret/u)

  const live = paypalReadiness({ ...PAYPAL_ENVIRONMENT, PAYPAL_ENV: 'live' })
  assert.equal(live.ready, true)
  if (!live.ready) return
  assert.equal(live.environment, 'live')
  assert.equal(live.baseUrl, LIVE_BASE_URL)
})

test('bound PayPal ids reconstruct only the environment allowlisted hosted approval URL', () => {
  assert.equal(
    paypalHostedApprovalUrl('sandbox', 'order', ORDER_ID),
    `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`,
  )
  assert.equal(
    paypalHostedApprovalUrl('live', 'subscription', SUBSCRIPTION_ID),
    `https://www.paypal.com/webapps/billing/subscriptions?ba_token=${SUBSCRIPTION_ID}`,
  )
  assert.throws(
    () => paypalHostedApprovalUrl('sandbox', 'order', 'https://attacker.example'),
    /PayPal remote id is invalid/u,
  )
  assert.throws(
    () => paypalHostedApprovalUrl('production' as never, 'order', ORDER_ID),
    /PayPal environment is invalid/u,
  )
  assert.throws(
    () => paypalHostedApprovalUrl('sandbox', 'gift' as never, ORDER_ID),
    /PayPal approval kind is invalid/u,
  )
})

test('OAuth uses client credentials only on the token request', async () => {
  let tokenCall: RecordedCall | undefined
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    tokenCall = { url: String(input), init }
    return jsonResponse({
      access_token: ACCESS_TOKEN,
      token_type: 'Bearer',
      expires_in: 32_400,
    })
  }) as typeof fetch

  const token = await requestPayPalAccessToken(PAYPAL_ENVIRONMENT, fetcher)

  assert.deepEqual(token, {
    accessToken: ACCESS_TOKEN,
    expiresInSeconds: 32_400,
  })
  assert.ok(tokenCall)
  assert.equal(tokenCall.url, `${SANDBOX_BASE_URL}/v1/oauth2/token`)
  assert.equal(tokenCall.init?.method, 'POST')
  assert.equal(
    requestHeaders(tokenCall).get('authorization'),
    `Basic ${Buffer.from('sandbox-client-id:sandbox-client-secret').toString('base64')}`,
  )
  assert.equal(
    requestHeaders(tokenCall).get('content-type'),
    'application/x-www-form-urlencoded',
  )
  assert.equal(requestBody(tokenCall), 'grant_type=client_credentials')
})

test('weekly allowance product creation is idempotent and contains no buyer data', async () => {
  const productRequestId = 'city-paypal-weekly-product-v1'
  const productId = 'PROD-6XB24663H4094933M'
  const { calls, fetcher } = paypalFetcher(call => {
    assert.equal(call.url, `${SANDBOX_BASE_URL}/v1/catalogs/products`)
    return jsonResponse({
      id: productId,
      name: '1F3D9 weekly city-credit allowance',
      type: 'SERVICE',
      category: 'SOFTWARE',
    }, 201)
  })

  const result = await createWeeklyAllowanceProduct(PAYPAL_ENVIRONMENT, {
    requestId: productRequestId,
  }, fetcher)

  assert.deepEqual(result, { productId })
  const productCall = calls.at(-1)
  assert.ok(productCall)
  assert.equal(requestHeaders(productCall).get('paypal-request-id'), productRequestId)
  assert.deepEqual(JSON.parse(requestBody(productCall)), {
    name: '1F3D9 weekly city-credit allowance',
    description: 'Prepaid fee credit delivered after each completed weekly PayPal payment.',
    type: 'SERVICE',
    category: 'SOFTWARE',
  })
  assert.doesNotMatch(requestBody(productCall), /resident|handle|claim.?token|payer|email/iu)
})

test('Orders create sends an exact whole-dollar gross purchase and a persisted request id', async () => {
  const { calls, fetcher } = paypalFetcher(call => {
    assert.equal(call.url, `${SANDBOX_BASE_URL}/v2/checkout/orders`)
    return jsonResponse({
      id: ORDER_ID,
      status: 'CREATED',
      links: [{
        href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`,
        rel: 'payer-action',
        method: 'GET',
      }],
    }, 201)
  })

  const result = await createPayPalCreditOrder(PAYPAL_ENVIRONMENT, {
    purchaseId: PURCHASE_ID,
    wholeDollars: 3n,
    requestId: REQUEST_ID,
    returnUrl: 'https://1f3d9.com/buy/return',
    cancelUrl: 'https://1f3d9.com/buy/cancel',
  }, fetcher)

  assert.equal(result.orderId, ORDER_ID)
  assert.equal(
    result.approvalUrl,
    `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`,
  )
  const orderCall = calls.at(-1)
  assert.ok(orderCall)
  assert.equal(orderCall.init?.method, 'POST')
  assert.equal(requestHeaders(orderCall).get('authorization'), `Bearer ${ACCESS_TOKEN}`)
  assert.equal(requestHeaders(orderCall).get('paypal-request-id'), REQUEST_ID)
  assert.equal(requestHeaders(orderCall).get('prefer'), 'return=representation')

  const body = JSON.parse(requestBody(orderCall)) as Record<string, unknown>
  assert.deepEqual(body, {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: PURCHASE_ID,
      custom_id: PURCHASE_ID,
      description: '1F3D9 city credit',
      amount: { currency_code: 'USD', value: '3.00' },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: 'https://1f3d9.com/buy/return',
          cancel_url: 'https://1f3d9.com/buy/cancel',
        },
      },
    },
  })
  assert.doesNotMatch(requestBody(orderCall), /resident|handle|claim.?token|payer/iu)
  assert.equal('application_context' in body, false)
})

test('Orders capture validates the completed final gross capture, not PayPal net proceeds', async () => {
  const captureRequestId = 'city-paypal-0193-capture'
  const { calls, fetcher } = paypalFetcher(call => {
    assert.equal(
      call.url,
      `${SANDBOX_BASE_URL}/v2/checkout/orders/${ORDER_ID}/capture`,
    )
    return jsonResponse(completedOrderCapture(), 201)
  })

  const result = await capturePayPalCreditOrder(PAYPAL_ENVIRONMENT, {
    orderId: ORDER_ID,
    purchaseId: PURCHASE_ID,
    wholeDollars: 3n,
    requestId: captureRequestId,
  }, fetcher)

  assert.equal(result.orderId, ORDER_ID)
  assert.equal(result.captureId, CAPTURE_ID)
  assert.equal(result.sourceKey, `paypal:capture:${CAPTURE_ID}`)
  assert.equal(result.creditUnits, '3000000')
  const captureCall = calls.at(-1)
  assert.ok(captureCall)
  assert.equal(captureCall.init?.method, 'POST')
  assert.equal(requestHeaders(captureCall).get('paypal-request-id'), captureRequestId)
  assert.equal(requestHeaders(captureCall).get('prefer'), 'return=representation')
  assert.equal(requestBody(captureCall), '{}')
})

test('Orders capture accepts PayPal resource ids through the official 255-character limit', async () => {
  const captureId = `CAP-${'A'.repeat(251)}`
  const { fetcher } = paypalFetcher(() => jsonResponse(completedOrderCapture({ id: captureId }), 201))

  const result = await capturePayPalCreditOrder(PAYPAL_ENVIRONMENT, {
    orderId: ORDER_ID,
    purchaseId: PURCHASE_ID,
    wholeDollars: 3n,
    requestId: 'city-paypal-resource-boundary',
  }, fetcher)

  assert.equal(result.captureId, captureId)
  assert.equal(result.sourceKey, `paypal:capture:${captureId}`)
})

test('Orders capture rejects a misleading completed order with changed capture terms', async () => {
  const changedCaptures = [
    {
      value: completedOrderCapture({ status: 'DECLINED' }),
      message: /capture.*completed/iu,
    },
    {
      value: completedOrderCapture({
        amount: { currency_code: 'USD', value: '2.00' },
      }),
      message: /amount|gross|terms/iu,
    },
    {
      value: completedOrderCapture({
        amount: { currency_code: 'EUR', value: '3.00' },
      }),
      message: /currency|amount|terms/iu,
    },
    {
      value: completedOrderCapture({ final_capture: false }),
      message: /final/iu,
    },
  ]

  for (const changed of changedCaptures) {
    const { fetcher } = paypalFetcher(() => jsonResponse(changed.value, 201))
    await assert.rejects(
      capturePayPalCreditOrder(PAYPAL_ENVIRONMENT, {
        orderId: ORDER_ID,
        purchaseId: PURCHASE_ID,
        wholeDollars: 3n,
        requestId: 'city-paypal-0193-capture',
      }, fetcher),
      changed.message,
    )
  }
})

test('a duplicate capture response keeps one permanent capture source identity', async () => {
  const captureCalls: RecordedCall[] = []
  let responseStatus = 201
  const { fetcher } = paypalFetcher(call => {
    captureCalls.push(call)
    const response = jsonResponse(completedOrderCapture(), responseStatus)
    responseStatus = 200
    return response
  })
  const input = {
    orderId: ORDER_ID,
    purchaseId: PURCHASE_ID,
    wholeDollars: 3n,
    requestId: 'city-paypal-0193-capture',
  }

  const first = await capturePayPalCreditOrder(PAYPAL_ENVIRONMENT, input, fetcher)
  const replay = await capturePayPalCreditOrder(PAYPAL_ENVIRONMENT, input, fetcher)

  assert.equal(first.sourceKey, `paypal:capture:${CAPTURE_ID}`)
  assert.equal(replay.sourceKey, first.sourceKey)
  assert.equal(replay.captureId, first.captureId)
  assert.equal(captureCalls.length, 2)
  assert.deepEqual(
    captureCalls.map(call => requestHeaders(call).get('paypal-request-id')),
    [input.requestId, input.requestId],
  )
})

test('webhook postback verification embeds the exact raw event bytes', async () => {
  const rawBody = Buffer.from(`{
  "resource": { "id": "${CAPTURE_ID}", "status": "COMPLETED" },
  "event_type" : "PAYMENT.CAPTURE.COMPLETED",
  "id": "WH-7W7265122A4531234-0"
}`, 'utf8')
  let verifyCall: RecordedCall | undefined
  const { fetcher } = paypalFetcher(call => {
    verifyCall = call
    return jsonResponse({ verification_status: 'SUCCESS' })
  })

  const verified = await verifyPayPalWebhook(PAYPAL_ENVIRONMENT, {
    rawBody,
    headers: new Headers({
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
      'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
      'paypal-transmission-sig': 'lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A=',
      'paypal-transmission-time': '2026-08-26T20:00:00Z',
    }),
  }, fetcher)

  assert.equal(verified, true)
  assert.ok(verifyCall)
  assert.equal(
    verifyCall.url,
    `${SANDBOX_BASE_URL}/v1/notifications/verify-webhook-signature`,
  )
  assert.equal(verifyCall.init?.method, 'POST')
  const verificationBody = requestBody(verifyCall)
  assert.ok(
    verificationBody.includes(rawBody.toString('utf8')),
    'the webhook event must not be parsed and JSON-reserialized before verification',
  )
  assert.deepEqual(JSON.parse(verificationBody), {
    auth_algo: 'SHA256withRSA',
    cert_url: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
    transmission_id: '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
    transmission_sig: 'lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A=',
    transmission_time: '2026-08-26T20:00:00Z',
    webhook_id: PAYPAL_ENVIRONMENT.PAYPAL_WEBHOOK_ID,
    webhook_event: JSON.parse(rawBody.toString('utf8')),
  })
})

test('webhook verification rejects certificate URLs outside the configured PayPal environment', async () => {
  const rawBody = Buffer.from(JSON.stringify({
    id: 'WH-7W7265122A4531234-0',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: CAPTURE_ID },
  }))
  const { calls, fetcher } = paypalFetcher(() => {
    throw new Error('certificate validation must happen before PayPal network work')
  })
  const invalidUrls = [
    'https://api.paypal.com/v1/notifications/certs/CERT-live-in-sandbox',
    'https://example.com/v1/notifications/certs/CERT-external',
    'https://api.sandbox.paypal.com:444/v1/notifications/certs/CERT-port',
    'https://user@api.sandbox.paypal.com/v1/notifications/certs/CERT-user',
    'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-query?next=1',
    'https://api.sandbox.paypal.com/v1/notifications/certs/../secrets',
  ]

  for (const certUrl of invalidUrls) {
    await assert.rejects(
      verifyPayPalWebhook(PAYPAL_ENVIRONMENT, {
        rawBody,
        headers: new Headers({
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url': certUrl,
          'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
          'paypal-transmission-sig': 'valid-signature',
          'paypal-transmission-time': '2026-08-26T20:00:00Z',
        }),
      }, fetcher),
      /PayPal certificate URL is invalid/u,
    )
  }
  assert.equal(calls.length, 0)
})

test('the weekly allowance plan is infinite, quantity-based, and one dollar per unit', async () => {
  const planRequestId = 'city-paypal-weekly-plan-v1'
  const { calls, fetcher } = paypalFetcher(call => {
    assert.equal(call.url, `${SANDBOX_BASE_URL}/v1/billing/plans`)
    return jsonResponse({ id: PLAN_ID, status: 'ACTIVE' }, 201)
  })

  const result = await createWeeklyAllowancePlan(PAYPAL_ENVIRONMENT, {
    productId: 'PROD-6XB24663H4094933M',
    requestId: planRequestId,
  }, fetcher)

  assert.equal(result.planId, PLAN_ID)
  const planCall = calls.at(-1)
  assert.ok(planCall)
  assert.equal(requestHeaders(planCall).get('paypal-request-id'), planRequestId)
  const body = JSON.parse(requestBody(planCall)) as Record<string, unknown>
  assert.deepEqual(body, {
    product_id: 'PROD-6XB24663H4094933M',
    name: '1F3D9 weekly city-credit allowance',
    status: 'ACTIVE',
    quantity_supported: true,
    billing_cycles: [{
      frequency: { interval_unit: 'WEEK', interval_count: 1 },
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0,
      pricing_scheme: {
        fixed_price: { currency_code: 'USD', value: '1.00' },
      },
    }],
    payment_preferences: {
      auto_bill_outstanding: true,
      payment_failure_threshold: 0,
    },
  })
  assert.equal('merchant_preferences' in body, false)
  assert.equal('application_context' in body, false)
})

test('a weekly subscription uses whole-dollar quantity and PayPal hosted approval', async () => {
  const subscriptionRequestId = 'city-paypal-subscription-0193'
  const { calls, fetcher } = paypalFetcher(call => {
    assert.equal(call.url, `${SANDBOX_BASE_URL}/v1/billing/subscriptions`)
    return jsonResponse({
      id: SUBSCRIPTION_ID,
      status: 'APPROVAL_PENDING',
      links: [{
        href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=${SUBSCRIPTION_ID}`,
        rel: 'approve',
        method: 'GET',
      }],
    }, 201)
  })

  const result = await createWeeklyAllowanceSubscription(PAYPAL_ENVIRONMENT, {
    planId: PLAN_ID,
    allowanceId: 'city-allowance-0193',
    wholeDollars: 3n,
    requestId: subscriptionRequestId,
    returnUrl: 'https://1f3d9.com/buy?paypal=allowance-return&purchase_id=city_paypal_0193',
    cancelUrl: 'https://1f3d9.com/buy?paypal=allowance-cancel&purchase_id=city_paypal_0193',
  }, fetcher)

  assert.equal(result.subscriptionId, SUBSCRIPTION_ID)
  assert.equal(
    result.approvalUrl,
    `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=${SUBSCRIPTION_ID}`,
  )
  const subscriptionCall = calls.at(-1)
  assert.ok(subscriptionCall)
  assert.equal(
    requestHeaders(subscriptionCall).get('paypal-request-id'),
    subscriptionRequestId,
  )
  assert.deepEqual(JSON.parse(requestBody(subscriptionCall)), {
    plan_id: PLAN_ID,
    quantity: '3',
    custom_id: 'city-allowance-0193',
    application_context: {
      user_action: 'SUBSCRIBE_NOW',
      shipping_preference: 'NO_SHIPPING',
      return_url: 'https://1f3d9.com/buy?paypal=allowance-return&purchase_id=city_paypal_0193',
      cancel_url: 'https://1f3d9.com/buy?paypal=allowance-cancel&purchase_id=city_paypal_0193',
    },
  })
  assert.doesNotMatch(requestBody(subscriptionCall), /resident|handle|payer|email|claim/iu)
})

test('PAYMENT.SALE.COMPLETED renewal parsing is exact, replay-safe, and payer-free', () => {
  const event = {
    id: 'WH-4U497778DK455983B-1',
    event_type: 'PAYMENT.SALE.COMPLETED',
    resource: {
      id: '8MC585209K746392H',
      state: 'completed',
      amount: { total: '3.00', currency: 'USD' },
      billing_agreement_id: SUBSCRIPTION_ID,
      payer: {
        payment_method: 'paypal',
        status: 'VERIFIED',
        payer_info: {
          email: 'private-buyer@example.test',
          first_name: 'Private',
          last_name: 'Buyer',
          payer_id: 'QYR5Z8XDVJNXQ',
          shipping_address: { line1: '123 Private Street' },
        },
      },
    },
  }

  const parsed = parsePayPalRenewal(event)
  assert.deepEqual(parsed, {
    eventId: event.id,
    saleId: event.resource.id,
    subscriptionId: SUBSCRIPTION_ID,
    sourceKey: `paypal:sale:${event.resource.id}`,
    currencyCode: 'USD',
    amountValue: '3.00',
    creditUnits: '3000000',
  })
  assert.doesNotMatch(
    JSON.stringify(parsed),
    /private-buyer|private street|first_name|last_name|payer|email/iu,
  )

  const replay = parsePayPalRenewal({ ...event, id: 'WH-REPLAYED-DELIVERY-2' })
  assert.ok(replay)
  assert.equal(replay.sourceKey, parsed?.sourceKey)
  assert.equal(replay.saleId, parsed?.saleId)

  assert.equal(parsePayPalRenewal({
    ...event,
    event_type: 'BILLING.SUBSCRIPTION.PAYMENT.SUCCEEDED',
  }), null)
  assert.throws(() => parsePayPalRenewal({
    ...event,
    resource: {
      ...event.resource,
      amount: { total: '3.50', currency: 'USD' },
    },
  }), /whole|amount|exact/iu)
})
