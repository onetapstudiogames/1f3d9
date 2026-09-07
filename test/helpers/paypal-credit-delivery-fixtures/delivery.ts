import assert from 'node:assert/strict'
import {
  WEBHOOK_HEADERS,
  completedCaptureWebhook,
  configuredApp,
  postJson,
  postRaw,
} from '../paypal-credit-route-fixtures/route-harness.ts'

type ConfiguredPayPalFixture = ReturnType<typeof configuredApp>

export function completedCaptureWebhookFor(input: Readonly<{
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

export async function createCapturedGift(
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
