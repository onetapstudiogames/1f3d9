import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPTURE_ID,
  ORDER_ID,
  WEBHOOK_HEADERS,
  completedCaptureWebhook,
  configuredApp,
  disputeWebhook,
  postJson,
  postRaw,
} from '../helpers/paypal-credit-route-fixtures/route-harness.ts'
import {
  completedCaptureWebhookFor,
  createCapturedGift,
} from '../helpers/paypal-credit-delivery-fixtures/delivery.ts'

export function registerDisputeCaptureReconciliationTests(): void {
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

}
