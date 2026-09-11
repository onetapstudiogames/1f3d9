import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MemoryPayPalDatabase,
  WEBHOOK_HEADERS,
  completedCaptureWebhook,
  configuredApp,
  disputeWebhook,
  postJson,
  postRaw,
} from '../helpers/paypal-credit-route-fixtures/route-harness.ts'

async function assertUnverifiedWebhookFailure(response: Response): Promise<void> {
  const requestId = response.headers.get('x-request-id')
  assert.match(requestId ?? '', /^[0-9a-f-]{36}$/iu)
  assert.deepEqual(await response.json(), {
    error: 'PayPal webhook signature was not verified; PayPal should retry with its current signed transmission headers.',
    request_id: requestId,
    error_class: 'auth_required',
    http_status: 401,
    front_door_tool: 'front_door',
    front_door: 'https://1f3d9.com/',
  })
}

export function registerWebhookVerificationTests(): void {
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

  test('an unsigned dispute webhook is rejected as unverified before network or city writes', async () => {
    const database = new MemoryPayPalDatabase()
    const { app, paypal } = configuredApp(database)
    const response = await app.request('/api/city-credit/paypal/webhook', postRaw(
      disputeWebhook({
        eventId: 'WH-UNSIGNED-DISPUTE-1',
        eventKind: 'CUSTOMER.DISPUTE.CREATED',
        disputeId: 'PP-D-UNSIGNED-1',
      }),
      { 'content-type': 'application/json' },
    ))

    assert.equal(response.status, 401, await response.clone().text())
    await assertUnverifiedWebhookFailure(response)
    assert.equal(paypal.calls.length, 0, 'unsigned evidence must not reach PayPal')
    assert.equal(database.purchases.size, 0)
    assert.equal(database.events.size, 0)
    assert.equal(database.disputes.size, 0)
    assert.equal(database.disputeEvents.size, 0)
    assert.equal(database.disputeReceipts.size, 0)
    assert.equal(database.founderNotes.size, 0)
  })

  test('malformed PayPal signature headers are rejected before network or city writes', async t => {
    const cases = [
      ['auth algorithm', 'paypal-auth-algo', 'SHA256 with RSA'],
      ['transmission id', 'paypal-transmission-id', '123456'],
      ['transmission signature', 'paypal-transmission-sig', '123456'],
      ['transmission time', 'paypal-transmission-time', 'not-a-date'],
      ['impossible transmission date', 'paypal-transmission-time', '2026-02-30T12:00:00Z'],
      ['impossible transmission offset', 'paypal-transmission-time', '2026-08-28T12:00:00+99:99'],
      ['certificate URL', 'paypal-cert-url', 'https://example.com/cert.pem'],
    ] as const

    for (const [name, header, value] of cases) {
      await t.test(name, async () => {
        const database = new MemoryPayPalDatabase()
        const { app, paypal } = configuredApp(database)
        const response = await app.request('/api/city-credit/paypal/webhook', postRaw(
          disputeWebhook({
            eventId: `WH-MALFORMED-${header}`,
            eventKind: 'CUSTOMER.DISPUTE.CREATED',
            disputeId: `PP-D-MALFORMED-${header}`,
          }),
          { ...WEBHOOK_HEADERS, [header]: value },
        ))

        assert.equal(response.status, 401, await response.clone().text())
        await assertUnverifiedWebhookFailure(response)
        assert.equal(paypal.calls.length, 0, 'malformed evidence must not reach PayPal')
        assert.equal(database.purchases.size, 0)
        assert.equal(database.events.size, 0)
        assert.equal(database.disputes.size, 0)
        assert.equal(database.disputeEvents.size, 0)
        assert.equal(database.disputeReceipts.size, 0)
        assert.equal(database.founderNotes.size, 0)
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

}
