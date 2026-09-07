import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPTURE_ID,
  WEBHOOK_HEADERS,
  completedCaptureWebhook,
  configuredApp,
  disputeWebhook,
  postJson,
  postRaw,
} from '../helpers/paypal-credit-route-fixtures/route-harness.ts'
import {
  createCapturedGift,
} from '../helpers/paypal-credit-delivery-fixtures/delivery.ts'

export function registerDisputeOutcomeTests(): void {
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

}
