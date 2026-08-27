import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPTURE_ID,
  MemoryPayPalDatabase,
  ORDER_ID,
  SUBSCRIPTION_ID,
  WEBHOOK_HEADERS,
  completedCaptureWebhook,
  configuredApp,
  disputeWebhook,
  postJson,
  postRaw,
} from './paypal-credit-route-fixture.ts'

type ConfiguredPayPalFixture = ReturnType<typeof configuredApp>

function completedCaptureWebhookFor(input: Readonly<{
  eventId: string
  captureId: string
  orderId: string
}>): string {
  const event = JSON.parse(completedCaptureWebhook(input.eventId)) as {
    resource: {
      id: string
      supplementary_data: { related_ids: { order_id: string } }
    }
  }
  event.resource.id = input.captureId
  event.resource.supplementary_data.related_ids.order_id = input.orderId
  return JSON.stringify(event)
}

function disputeWebhookForCaptures(input: Readonly<{
  eventId: string
  disputeId: string
  captureIds: readonly string[]
  updateTime?: string
}>): string {
  const event = JSON.parse(disputeWebhook({
    eventId: input.eventId,
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: input.disputeId,
    captureId: input.captureIds[0]!,
    ...(input.updateTime === undefined ? {} : { updateTime: input.updateTime }),
  })) as {
    resource: { disputed_transactions: Array<{ seller_transaction_id: string }> }
  }
  event.resource.disputed_transactions = input.captureIds.map(captureId => ({
    seller_transaction_id: captureId,
  }))
  return JSON.stringify(event)
}

async function createCapturedGift(
  fixture: ConfiguredPayPalFixture,
  input: Readonly<{
    requestId: string
    eventId: string
    captureId: string
    orderId: string
  }>,
): Promise<void> {
  const createdResponse = await fixture.app.request('/api/city-credit/paypal/orders', postJson({
    request_id: input.requestId,
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text())
  const created = await createdResponse.json() as { purchase_id: string }
  const intent = fixture.database.intents.get(created.purchase_id)
  assert.ok(intent)
  fixture.database.intents.set(created.purchase_id, {
    ...intent,
    remote_order_id: input.orderId,
  })
  const captureResponse = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
    completedCaptureWebhookFor(input),
    WEBHOOK_HEADERS,
  ))
  assert.equal(captureResponse.status, 200, await captureResponse.clone().text())
  assert.deepEqual(await captureResponse.json(), { received: true, outcome: 'credited' })
}

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

test('unverified dispute webhooks cannot freeze or record a delivered gift', async t => {
  const cases = [
    {
      name: 'verification_status FAILURE',
      verifier: () => Response.json({ verification_status: 'FAILURE' }),
      status: 401,
    },
    {
      name: 'malformed verification response',
      verifier: () => new Response('{', { status: 200 }),
      status: 503,
    },
    {
      name: 'verification endpoint outage',
      verifier: () => Response.json({ name: 'SERVICE_UNAVAILABLE' }, { status: 503 }),
      status: 503,
    },
  ] as const
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const database = new MemoryPayPalDatabase()
      const seeded = configuredApp(database)
      const order = await seeded.app.request('/api/city-credit/paypal/orders', postJson({
        request_id: `paypal-dispute-signature-${testCase.status}-${testCase.name.length}`,
        resident_number: 193,
        resident_handle: 'keeps-the-maybe',
        amount_dollars: '3',
        delivery: 'gift',
      }))
      assert.equal(order.status, 201, await order.clone().text())
      assert.equal((await seeded.app.request('/api/city-credit/paypal/webhook',
        postRaw(completedCaptureWebhook(
          `WH-DISPUTE-SIGNATURE-CAPTURE-${testCase.status}`,
        ), WEBHOOK_HEADERS))).status, 200)
      const rejected = configuredApp(database, { verifyWebhook: testCase.verifier })
      const response = await rejected.app.request('/api/city-credit/paypal/webhook',
        postRaw(disputeWebhook({
          eventId: `WH-DISPUTE-SIGNATURE-${testCase.status}`,
          eventKind: 'CUSTOMER.DISPUTE.CREATED',
          disputeId: `PP-D-SIGNATURE-${testCase.status}`,
        }), WEBHOOK_HEADERS))
      assert.equal(response.status, testCase.status, await response.clone().text())
      assert.equal(database.disputes.size, 0)
      assert.equal(database.disputeEvents.size, 0)
      assert.equal(database.disputeReceipts.size, 0)
      assert.equal(database.founderNotes.size, 0)
      assert.equal([...database.purchases.values()][0]?.status, 'pending')
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

test('one verified multi-capture dispute freezes every locally credited pending gift once', async () => {
  const fixture = configuredApp()
  const captures = [
    { requestId: 'paypal-dispute-multi-gift-a', eventId: 'WH-CAPTURE-MULTI-A', captureId: 'CAPTURE-MULTI-A', orderId: 'ORDER-MULTI-A' },
    { requestId: 'paypal-dispute-multi-gift-b', eventId: 'WH-CAPTURE-MULTI-B', captureId: 'CAPTURE-MULTI-B', orderId: 'ORDER-MULTI-B' },
  ] as const
  for (const capture of captures) await createCapturedGift(fixture, capture)

  const dispute = disputeWebhookForCaptures({
    eventId: 'WH-DISPUTE-MULTI-CREATED',
    disputeId: 'PP-D-MULTI-CAPTURE-0001',
    captureIds: [captures[1].captureId, captures[0].captureId],
  })
  for (let delivery = 0; delivery < 2; delivery += 1) {
    const response = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
      dispute,
      WEBHOOK_HEADERS,
    ))
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), {
      received: true,
      outcome: 'dispute_open_gifts_frozen',
    })
    assert.deepEqual(
      [...fixture.database.purchases.values()].map(purchase => purchase.status),
      ['frozen', 'frozen'],
    )
    assert.equal(fixture.database.disputeReceipts.size, 2)
    assert.equal(fixture.database.founderNotes.size, 1)
  }
  assert.equal(fixture.database.disputes.size, 1)
  assert.equal(fixture.database.disputeEvents.size, 2)
  const applyCall = fixture.database.calls.find(call => (
    call.text.includes('paypal-credit:apply-dispute')
  ))
  assert.deepEqual(applyCall?.params[3], ['CAPTURE-MULTI-A', 'CAPTURE-MULTI-B'])
})

test('verified lifecycle events reconcile the durable union when capture sets evolve', async () => {
  const fixture = configuredApp()
  const captures = [
    { requestId: 'paypal-dispute-union-gift-a', eventId: 'WH-CAPTURE-UNION-A', captureId: 'CAPTURE-UNION-A', orderId: 'ORDER-UNION-A' },
    { requestId: 'paypal-dispute-union-gift-b', eventId: 'WH-CAPTURE-UNION-B', captureId: 'CAPTURE-UNION-B', orderId: 'ORDER-UNION-B' },
  ] as const
  for (const capture of captures) await createCapturedGift(fixture, capture)

  const disputeId = 'PP-D-EVOLVING-ROUTE-0001'
  const opened = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
    disputeWebhook({
      eventId: 'WH-DISPUTE-UNION-CREATED',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId,
      captureId: captures[0].captureId,
      updateTime: '2026-08-27T18:00:00.000Z',
    }),
    WEBHOOK_HEADERS,
  ))
  assert.equal(opened.status, 200, await opened.clone().text())
  assert.equal([...fixture.database.purchases.values()][0]?.status, 'frozen')
  assert.equal([...fixture.database.purchases.values()][1]?.status, 'pending')

  const resolved = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
    disputeWebhook({
      eventId: 'WH-DISPUTE-UNION-RESOLVED',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId,
      captureId: captures[1].captureId,
      updateTime: '2026-08-27T19:00:00.000Z',
      outcomeCode: 'RESOLVED_SELLER_FAVOUR',
    }),
    WEBHOOK_HEADERS,
  ))
  assert.equal(resolved.status, 200, await resolved.clone().text())
  assert.deepEqual(await resolved.json(), {
    received: true, outcome: 'dispute_resolved_gift_pending',
  })
  assert.deepEqual(
    [...fixture.database.purchases.values()].map(purchase => purchase.status),
    ['pending', 'pending'],
  )
  assert.equal(fixture.database.disputeReceipts.size, 4)
  assert.equal(fixture.database.disputeEvents.size, 4)
})

test('a partially local dispute stages the missing capture and completes when it arrives', async () => {
  const fixture = configuredApp()
  await createCapturedGift(fixture, {
    requestId: 'paypal-dispute-partial-gift-a',
    eventId: 'WH-CAPTURE-PARTIAL-A',
    captureId: 'CAPTURE-PARTIAL-A',
    orderId: 'ORDER-PARTIAL-A',
  })
  const body = disputeWebhookForCaptures({
    eventId: 'WH-DISPUTE-PARTIAL-CREATED',
    disputeId: 'PP-D-PARTIAL-CAPTURE-0001',
    captureIds: ['CAPTURE-PARTIAL-B', 'CAPTURE-PARTIAL-A'],
  })
  const partial = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
    body,
    WEBHOOK_HEADERS,
  ))
  assert.deepEqual(await partial.json(), {
    received: true,
    outcome: 'dispute_partially_applied_awaiting_capture_receipt',
  })
  assert.equal(fixture.database.disputeReceipts.size, 1)

  await createCapturedGift(fixture, {
    requestId: 'paypal-dispute-partial-gift-b',
    eventId: 'WH-CAPTURE-PARTIAL-B',
    captureId: 'CAPTURE-PARTIAL-B',
    orderId: 'ORDER-PARTIAL-B',
  })
  const replay = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
    body,
    WEBHOOK_HEADERS,
  ))
  assert.deepEqual(await replay.json(), {
    received: true,
    outcome: 'dispute_open_gifts_frozen',
  })
  assert.equal(fixture.database.disputeReceipts.size, 2)
  assert.equal(fixture.database.disputeEvents.size, 2)
  assert.equal(fixture.database.founderNotes.size, 1)
})

test('an open dispute received before its capture freezes the gift as capture is delivered', async () => {
  const fixture = configuredApp()
  const createdResponse = await fixture.app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-dispute-before-capture-gift',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text())
  const created = await createdResponse.json() as { purchase_id: string }
  const intent = fixture.database.intents.get(created.purchase_id)
  assert.ok(intent)
  fixture.database.intents.set(created.purchase_id, {
    ...intent,
    remote_order_id: 'ORDER-DISPUTED-BEFORE-CAPTURE',
  })

  const earlyResponse = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
    disputeWebhook({
      eventId: 'WH-DISPUTE-BEFORE-CAPTURE-CREATED',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-BEFORE-CAPTURE-0001',
      captureId: 'CAPTURE-DISPUTED-BEFORE-DELIVERY',
      updateTime: '2026-08-27T18:00:00.000z',
    }),
    WEBHOOK_HEADERS,
  ))
  const earlyBody = await earlyResponse.json()
  assert.equal(fixture.database.founderNotes.size, 1,
    'the founder note is durable before any matching local capture exists')

  const captureResponse = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
    completedCaptureWebhookFor({
      eventId: 'WH-CAPTURE-AFTER-DISPUTE',
      captureId: 'CAPTURE-DISPUTED-BEFORE-DELIVERY',
      orderId: 'ORDER-DISPUTED-BEFORE-CAPTURE',
    }),
    WEBHOOK_HEADERS,
  ))
  const deliveredGift = [...fixture.database.purchases.values()][0]
  assert.deepEqual({
    earlyStatus: earlyResponse.status,
    earlyBody,
    captureStatus: captureResponse.status,
    giftStatusWhenCaptureReturned: deliveredGift?.status,
    canonicalUpdateTime: fixture.database.disputes
      .get('PP-D-BEFORE-CAPTURE-0001')?.resource_updated_at,
    receiptCount: fixture.database.disputeReceipts.size,
    founderNoteCount: fixture.database.founderNotes.size,
  }, {
    earlyStatus: 200,
    earlyBody: { received: true, outcome: 'dispute_awaiting_capture_receipt' },
    captureStatus: 200,
    giftStatusWhenCaptureReturned: 'frozen',
    canonicalUpdateTime: '2026-08-27T18:00:00.000Z',
    receiptCount: 1,
    founderNoteCount: 1,
  })
})

test('an API capture returns the frozen gift state when it reconciles an earlier dispute', async () => {
  const fixture = configuredApp()
  const createdResponse = await fixture.app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-dispute-before-api-capture-gift',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text())
  const created = await createdResponse.json() as { purchase_id: string }
  const staged = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
    disputeWebhook({
      eventId: 'WH-DISPUTE-BEFORE-API-CAPTURE',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-BEFORE-API-CAPTURE-0001',
      captureId: CAPTURE_ID,
    }),
    WEBHOOK_HEADERS,
  ))
  assert.deepEqual(await staged.json(), {
    received: true,
    outcome: 'dispute_awaiting_capture_receipt',
  })

  const captured = await fixture.app.request(
    `/api/city-credit/paypal/orders/${created.purchase_id}/capture`,
    postJson({ paypal_order_id: ORDER_ID }),
  )
  assert.equal(captured.status, 200, await captured.clone().text())
  assert.deepEqual(
    await captured.json() as { status: unknown; blocked_reason?: unknown },
    {
      purchase_id: created.purchase_id,
      resident_handle: 'keeps-the-maybe',
      amount_dollars: '3',
      delivery: 'gift',
      status: 'frozen',
      receipt_id: '1',
      gift_id: [...fixture.database.purchases.values()][0]?.gift_public_id,
      blocked_reason: 'A payment dispute is open on the purchase that funded this gift, or PayPal resolved it ambiguously and founder review is pending. It cannot be accepted or redirected while frozen.',
    },
  )
})

test('an API capture binds an official 255-character capture id to one bounded event id', async () => {
  const captureId = `CAP-${'A'.repeat(251)}`
  const fixture = configuredApp(new MemoryPayPalDatabase(), { captureId })
  const createdResponse = await fixture.app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-api-capture-resource-boundary',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))
  const created = await createdResponse.json() as { purchase_id: string }

  const captured = await fixture.app.request(
    `/api/city-credit/paypal/orders/${created.purchase_id}/capture`,
    postJson({ paypal_order_id: ORDER_ID }),
  )

  assert.equal(captured.status, 200, await captured.clone().text())
  assert.equal([...fixture.database.purchases.values()][0]?.source_key,
    `paypal:capture:${captureId}`)
})

test('an API capture replay says when a refused gift remains dispute-blocked', async () => {
  const fixture = configuredApp()
  const createdResponse = await fixture.app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-api-capture-refused-dispute-block',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))
  const created = await createdResponse.json() as { purchase_id: string }
  assert.equal((await fixture.app.request(
    `/api/city-credit/paypal/orders/${created.purchase_id}/capture`,
    postJson({ paypal_order_id: ORDER_ID }),
  )).status, 200)
  const [sourceKey, purchase] = [...fixture.database.purchases.entries()][0]!
  fixture.database.purchases.set(sourceKey, {
    ...purchase,
    status: 'refused',
    dispute_blocked: true,
  })

  const replay = await fixture.app.request(
    `/api/city-credit/paypal/orders/${created.purchase_id}/capture`,
    postJson({ paypal_order_id: ORDER_ID }),
  )
  const payload = await replay.json() as { status?: unknown; blocked_reason?: unknown }

  assert.equal(replay.status, 200)
  assert.equal(payload.status, 'refused')
  assert.match(String(payload.blocked_reason), /payment dispute is open[\s\S]*cannot be redirected/iu)
})

test('an API capture replay gives either truthful cause for a review-revoked gift', async () => {
  const fixture = configuredApp()
  const createdResponse = await fixture.app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-api-capture-founder-review-revoked',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))
  const created = await createdResponse.json() as { purchase_id: string }
  assert.equal((await fixture.app.request(
    `/api/city-credit/paypal/orders/${created.purchase_id}/capture`,
    postJson({ paypal_order_id: ORDER_ID }),
  )).status, 200)
  // Revoked custody can result from provider-adverse evidence or the founder's
  // buyer-favour decision after an ambiguous provider outcome. The purchase row
  // deliberately carries custody, not private dispute provenance.
  const [sourceKey, purchase] = [...fixture.database.purchases.entries()][0]!
  fixture.database.purchases.set(sourceKey, { ...purchase, status: 'revoked' })

  const replay = await fixture.app.request(
    `/api/city-credit/paypal/orders/${created.purchase_id}/capture`,
    postJson({ paypal_order_id: ORDER_ID }),
  )
  const payload = await replay.json() as { status?: unknown; blocked_reason?: unknown }
  const reason = String(payload.blocked_reason)
  assert.equal(replay.status, 200)
  assert.equal(payload.status, 'revoked')
  assert.match(reason,
    /either PayPal resolved.*against.*or founder resident #1 chose buyer favour.*ambiguous/iu)
  assert.match(reason, /permanently revoked.*never add credit/iu)
})

test('official maximum dispute identifiers and offset update_time are accepted canonically', async () => {
  const fixture = configuredApp()
  const disputeId = `PP-D-${'D'.repeat(250)}`
  const captureId = `CAP-${'C'.repeat(251)}`
  assert.equal(disputeId.length, 255)
  assert.equal(captureId.length, 255)
  await createCapturedGift(fixture, {
    requestId: 'paypal-dispute-official-boundaries',
    eventId: 'WH-CAPTURE-OFFICIAL-BOUNDARIES',
    captureId,
    orderId: 'ORDER-OFFICIAL-BOUNDARIES',
  })

  const response = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
    disputeWebhook({
      eventId: 'WH-DISPUTE-OFFICIAL-BOUNDARIES',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId,
      captureId,
      updateTime: '2026-08-27T18:30:00.123456789-05:00',
    }),
    WEBHOOK_HEADERS,
  ))
  const stored = fixture.database.disputes.get(disputeId)
  assert.deepEqual({
    status: response.status,
    body: await response.json(),
    storedDisputeId: stored?.dispute_id,
    storedCaptureIds: stored?.capture_ids,
    storedUpdateTime: stored?.resource_updated_at,
    giftStatus: [...fixture.database.purchases.values()][0]?.status,
  }, {
    status: 200,
    body: { received: true, outcome: 'dispute_open_gift_frozen' },
    storedDisputeId: disputeId,
    storedCaptureIds: [captureId],
    storedUpdateTime: '2026-08-27T23:30:00.123456789Z',
    giftStatus: 'frozen',
  })
})

test('PayPal RFC3339 lowercase, leap-second, and long fractions remain valid webhook times', async () => {
  const fixture = configuredApp()
  await createCapturedGift(fixture, {
    requestId: 'paypal-dispute-rfc3339-full-contract',
    eventId: 'WH-CAPTURE-RFC3339-FULL-CONTRACT',
    captureId: CAPTURE_ID,
    orderId: 'ORDER-RFC3339-FULL-CONTRACT',
  })
  const fraction = '1234567890123456789012345678901234567890123'
  const updateTime = `2016-12-31t23:59:60.${fraction}z`
  assert.equal(updateTime.length, 64)

  const response = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
    disputeWebhook({
      eventId: 'WH-DISPUTE-RFC3339-FULL-CONTRACT',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-RFC3339-FULL-CONTRACT',
      captureId: CAPTURE_ID,
      updateTime,
    }),
    WEBHOOK_HEADERS,
  ))

  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(
    fixture.database.disputes.get('PP-D-RFC3339-FULL-CONTRACT')?.resource_updated_at,
    `2017-01-01T00:00:00.${fraction}Z`,
  )
})

test('verified dispute lifecycle webhooks freeze, update, unfreeze, and replay one pending gift', async () => {
  const { app, database } = configuredApp()
  const order = await app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-dispute-seller-win-gift-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))
  assert.equal(order.status, 201, await order.clone().text())
  assert.equal((await app.request('/api/city-credit/paypal/webhook',
    postRaw(completedCaptureWebhook(), WEBHOOK_HEADERS))).status, 200)

  const lifecycle = [
    {
      body: disputeWebhook({
        eventId: 'WH-DISPUTE-CREATED-0001',
        eventKind: 'CUSTOMER.DISPUTE.CREATED',
        updateTime: '2026-08-27T18:00:00.000Z',
      }),
      outcome: 'dispute_open_gift_frozen',
      giftStatus: 'frozen',
    },
    {
      body: disputeWebhook({
        eventId: 'WH-DISPUTE-UPDATED-0001',
        eventKind: 'CUSTOMER.DISPUTE.UPDATED',
        status: 'UNDER_REVIEW',
        updateTime: '2026-08-27T19:00:00.000Z',
      }),
      outcome: 'dispute_open_gift_frozen',
      giftStatus: 'frozen',
    },
    {
      body: disputeWebhook({
        eventId: 'WH-DISPUTE-RESOLVED-SELLER-0001',
        eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
        outcomeCode: 'RESOLVED_SELLER_FAVOUR',
        updateTime: '2026-08-27T20:00:00.000Z',
      }),
      outcome: 'dispute_resolved_gift_pending',
      giftStatus: 'pending',
    },
  ] as const

  for (const step of lifecycle) {
    for (let replay = 0; replay < 2; replay += 1) {
      const response = await app.request('/api/city-credit/paypal/webhook',
        postRaw(step.body, WEBHOOK_HEADERS))
      assert.equal(response.status, 200, await response.clone().text())
      assert.deepEqual(await response.json(), { received: true, outcome: step.outcome })
    }
    assert.equal([...database.purchases.values()][0]?.status, step.giftStatus)
  }
  assert.equal(database.disputes.size, 1)
  assert.equal(database.disputeEvents.size, 3)
  assert.equal(database.disputeReceipts.size, 3)
  assert.equal(database.founderNotes.size, 1)
})

test('a verified adverse dispute resolution revokes a frozen gift permanently on replay', async () => {
  const { app, database } = configuredApp()
  const order = await app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-dispute-buyer-win-gift-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))
  assert.equal(order.status, 201, await order.clone().text())
  assert.equal((await app.request('/api/city-credit/paypal/webhook',
    postRaw(completedCaptureWebhook('WH-DISPUTE-CAPTURE-0002'), WEBHOOK_HEADERS))).status, 200)

  const opened = disputeWebhook({
    eventId: 'WH-DISPUTE-CREATED-0002',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: 'PP-D-POSTGRES-0002',
    updateTime: '2026-08-27T18:00:00.000Z',
  })
  const resolved = disputeWebhook({
    eventId: 'WH-DISPUTE-RESOLVED-BUYER-0002',
    eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
    disputeId: 'PP-D-POSTGRES-0002',
    outcomeCode: 'RESOLVED_BUYER_FAVOUR',
    updateTime: '2026-08-27T20:00:00.000Z',
  })
  assert.deepEqual(await (await app.request('/api/city-credit/paypal/webhook',
    postRaw(opened, WEBHOOK_HEADERS))).json(), {
    received: true, outcome: 'dispute_open_gift_frozen',
  })
  for (let replay = 0; replay < 2; replay += 1) {
    const response = await app.request('/api/city-credit/paypal/webhook',
      postRaw(resolved, WEBHOOK_HEADERS))
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), {
      received: true, outcome: 'dispute_resolved_gift_revoked',
    })
  }
  assert.equal([...database.purchases.values()][0]?.status, 'revoked')
  assert.equal(database.disputeEvents.size, 2)
  assert.equal(database.disputeReceipts.size, 2)
  assert.equal(database.founderNotes.size, 1)
})

test('an ambiguous official resolution stays frozen for typed founder review', async () => {
  const { app, database } = configuredApp()
  const order = await app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-dispute-review-gift-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))
  assert.equal(order.status, 201, await order.clone().text())
  assert.equal((await app.request('/api/city-credit/paypal/webhook',
    postRaw(completedCaptureWebhook('WH-DISPUTE-REVIEW-CAPTURE'), WEBHOOK_HEADERS))).status, 200)
  const response = await app.request('/api/city-credit/paypal/webhook', postRaw(
    disputeWebhook({
      eventId: 'WH-DISPUTE-REVIEW-RESOLVED',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: 'PP-D-REVIEW-0001',
      outcomeCode: 'RESOLVED_WITH_PAYOUT',
    }),
    WEBHOOK_HEADERS,
  ))
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual(await response.json(), {
    received: true,
    outcome: 'dispute_resolution_needs_operator_review',
  })
  assert.equal([...database.purchases.values()][0]?.status, 'frozen')
})

test('every official PayPal resolution code follows its documented custody class', async t => {
  const cases = [
    ['RESOLVED_SELLER_FAVOUR', 'dispute_resolved_gift_pending', 'pending'],
    ['CANCELED_BY_BUYER', 'dispute_resolved_gift_pending', 'pending'],
    ['DENIED', 'dispute_resolved_gift_pending', 'pending'],
    ['RESOLVED_BUYER_FAVOUR', 'dispute_resolved_gift_revoked', 'revoked'],
    ['ACCEPTED', 'dispute_resolved_gift_revoked', 'revoked'],
    ['RESOLVED_WITH_PAYOUT', 'dispute_resolution_needs_operator_review', 'frozen'],
    ['NONE', 'dispute_resolution_needs_operator_review', 'frozen'],
  ] as const
  for (const [outcomeCode, expectedOutcome, expectedStatus] of cases) {
    await t.test(outcomeCode, async () => {
      const fixture = configuredApp()
      await createCapturedGift(fixture, {
        requestId: `paypal-dispute-outcome-${outcomeCode.toLowerCase()}`,
        eventId: `WH-CAPTURE-OUTCOME-${outcomeCode}`,
        captureId: CAPTURE_ID,
        orderId: `ORDER-OUTCOME-${outcomeCode}`,
      })
      const disputeId = `PP-D-OUTCOME-${outcomeCode.replaceAll('_', '-')}`
      const opened = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
        disputeWebhook({
          eventId: `WH-DISPUTE-OUTCOME-OPEN-${outcomeCode}`,
          eventKind: 'CUSTOMER.DISPUTE.CREATED',
          disputeId,
          captureId: CAPTURE_ID,
        }),
        WEBHOOK_HEADERS,
      ))
      assert.equal(opened.status, 200, await opened.clone().text())
      const resolved = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
        disputeWebhook({
          eventId: `WH-DISPUTE-OUTCOME-RESOLVED-${outcomeCode}`,
          eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
          disputeId,
          captureId: CAPTURE_ID,
          outcomeCode,
          updateTime: '2026-08-27T20:00:00.000Z',
        }),
        WEBHOOK_HEADERS,
      ))
      assert.equal(resolved.status, 200, await resolved.clone().text())
      assert.deepEqual(await resolved.json(), {
        received: true,
        outcome: expectedOutcome,
      })
      assert.equal(
        [...fixture.database.purchases.values()][0]?.status,
        expectedStatus,
      )
    })
  }
})

test('an open dispute preserves a refused gift and seller resolution removes its block', async () => {
  const fixture = configuredApp()
  await createCapturedGift(fixture, {
    requestId: 'paypal-dispute-refused-gift',
    eventId: 'WH-CAPTURE-REFUSED-GIFT',
    captureId: CAPTURE_ID,
    orderId: 'ORDER-REFUSED-GIFT',
  })
  const [sourceKey, purchase] = [...fixture.database.purchases.entries()][0]!
  fixture.database.purchases.set(sourceKey, { ...purchase, status: 'refused' })

  for (const [event, outcome] of [
    [disputeWebhook({
      eventId: 'WH-DISPUTE-REFUSED-CREATED',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-REFUSED-GIFT-0001',
      captureId: CAPTURE_ID,
    }), 'dispute_open_refused_gift_blocked'],
    [disputeWebhook({
      eventId: 'WH-DISPUTE-REFUSED-RESOLVED',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: 'PP-D-REFUSED-GIFT-0001',
      captureId: CAPTURE_ID,
      outcomeCode: 'RESOLVED_SELLER_FAVOUR',
      updateTime: '2026-08-27T20:00:00.000Z',
    }), 'dispute_resolved_refused_gift'],
  ] as const) {
    const response = await fixture.app.request('/api/city-credit/paypal/webhook', postRaw(
      event,
      WEBHOOK_HEADERS,
    ))
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), { received: true, outcome })
  }
  assert.deepEqual(fixture.database.purchases.get(sourceKey), {
    ...purchase,
    status: 'refused',
    dispute_blocked: false,
  })
})

test('malformed dispute contracts create no dispute state or receipt', async () => {
  const { app, database } = configuredApp()
  const malformed = [
    {
      id: 'WH-DISPUTE-MALFORMED-0001',
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      resource: {
        dispute_id: 'PP-D-MALFORMED-0001', status: 'OPEN',
        disputed_transactions: [{ seller_transaction_id: CAPTURE_ID }],
      },
    },
    {
      id: 'WH-DISPUTE-MALFORMED-0002',
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      resource: {
        dispute_id: 'PP-D-MALFORMED-0002', status: 'OPEN',
        update_time: '2026-08-27T18:00:00.000Z',
        disputed_transactions: [],
      },
    },
    {
      id: 'WH-DISPUTE-MALFORMED-0003',
      event_type: 'CUSTOMER.DISPUTE.RESOLVED',
      resource: {
        dispute_id: 'PP-D-MALFORMED-0003', status: 'RESOLVED',
        update_time: '2026-08-27T18:00:00.000Z',
        disputed_transactions: [{ seller_transaction_id: CAPTURE_ID }],
      },
    },
    {
      id: 'WH-DISPUTE-MALFORMED-0004',
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      resource: {
        dispute_id: 'PP-D-MALFORMED-0004', status: 'OPEN',
        update_time: '2026-08-27T18:00:00.000Z',
        disputed_transactions: Array.from({ length: 1_001 }, (_, index) => ({
          seller_transaction_id: `CAPTURE-TOO-MANY-${index}`,
        })),
      },
    },
    {
      id: 'WH-DISPUTE-MALFORMED-0005',
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      resource: {
        dispute_id: 'PP-D-MALFORMED-0005', status: 'OPEN',
        update_time: '2026-08-27T18:00:00.000Z',
        disputed_transactions: [
          { seller_transaction_id: CAPTURE_ID },
          { seller_transaction_id: CAPTURE_ID },
        ],
      },
    },
  ]
  for (const event of malformed) {
    const response = await app.request('/api/city-credit/paypal/webhook',
      postRaw(JSON.stringify(event), WEBHOOK_HEADERS))
    assert.equal(response.status, 400, await response.clone().text())
  }
  assert.equal(database.disputes.size, 0)
  assert.equal(database.disputeEvents.size, 0)
  assert.equal(database.disputeReceipts.size, 0)
  assert.equal(database.founderNotes.size, 0)
})

test('a verified dispute records retained delivered credit without clawback', async () => {
  const { app, database } = configuredApp()
  const order = await app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-dispute-retained-self-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'self',
  }, { authorization: 'Bearer resident-193' }))
  assert.equal(order.status, 201, await order.clone().text())
  assert.equal((await app.request('/api/city-credit/paypal/webhook',
    postRaw(completedCaptureWebhook('WH-DISPUTE-CAPTURE-0003'), WEBHOOK_HEADERS))).status, 200)
  const balanceBefore = [...database.purchases.values()][0]?.balance_units

  for (const event of [
    disputeWebhook({
      eventId: 'WH-DISPUTE-CREATED-0003',
      eventKind: 'CUSTOMER.DISPUTE.CREATED',
      disputeId: 'PP-D-POSTGRES-0003',
    }),
    disputeWebhook({
      eventId: 'WH-DISPUTE-RESOLVED-BUYER-0003',
      eventKind: 'CUSTOMER.DISPUTE.RESOLVED',
      disputeId: 'PP-D-POSTGRES-0003',
      outcomeCode: 'RESOLVED_BUYER_FAVOUR',
      updateTime: '2026-08-27T20:00:00.000Z',
    }),
  ]) {
    const response = await app.request('/api/city-credit/paypal/webhook',
      postRaw(event, WEBHOOK_HEADERS))
    assert.equal(response.status, 200, await response.clone().text())
    const outcome = String((await response.json() as { outcome: unknown }).outcome)
    assert.match(outcome, /credit_retained$/u)
    assert.equal([...database.purchases.values()][0]?.balance_units, balanceBefore)
  }
  assert.equal(database.founderNotes.size, 1)
})

test('a headerless verified dispute still reaches the bounded body reader', async () => {
  const { app } = configuredApp()
  const order = await app.request('/api/city-credit/paypal/orders', postJson({
    request_id: 'paypal-dispute-headerless-0193',
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
  }))
  assert.equal(order.status, 201, await order.clone().text())
  assert.equal((await app.request('/api/city-credit/paypal/webhook',
    postRaw(completedCaptureWebhook('WH-DISPUTE-CAPTURE-0004'), WEBHOOK_HEADERS))).status, 200)
  const body = disputeWebhook({
    eventId: 'WH-DISPUTE-CREATED-HEADERLESS-0004',
    eventKind: 'CUSTOMER.DISPUTE.CREATED',
    disputeId: 'PP-D-POSTGRES-0004',
  })
  const response = await app.request('/api/city-credit/paypal/webhook', {
    method: 'POST',
    headers: WEBHOOK_HEADERS,
    body,
  })
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual(await response.json(), {
    received: true, outcome: 'dispute_open_gift_frozen',
  })
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
