import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPTURE_ID,
  MemoryPayPalDatabase,
  ORDER_ID,
  WEBHOOK_HEADERS,
  configuredApp,
  disputeWebhook,
  postJson,
  postRaw,
} from '../helpers/paypal-credit-route-fixtures/route-harness.ts'
import {
  createCapturedGift,
} from '../helpers/paypal-credit-delivery-fixtures/delivery.ts'

export function registerCaptureReplayTests(): void {
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

}
