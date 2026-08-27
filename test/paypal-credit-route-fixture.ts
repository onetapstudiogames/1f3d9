import { Hono } from 'hono'
import { mountPayPalCreditRoutes } from '../src/paypal-credit-routes.ts'
import type { PayPalCreditStoreDatabase } from '../src/paypal-credit-store.ts'

export const READY_ENV = Object.freeze({
  PAYPAL_CLIENT_ID: 'sandbox-client-id',
  PAYPAL_CLIENT_SECRET: 'sandbox-client-secret',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_WEBHOOK_ID: 'sandbox-webhook-id',
})
export const PURCHASE_ID_PATTERN = /^city_paypal_[0-9a-f]{32}$/u
export const ORDER_ID = '5O190127TN364715T'
export const CAPTURE_ID = '3C679366HH908993F'
export const SUBSCRIPTION_ID = 'I-BW452GLLEP1G'
export const WEBHOOK_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42',
  'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
  'paypal-transmission-sig': 'valid-signature',
  'paypal-transmission-time': '2026-08-26T20:00:00Z',
})

export function postJson(
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): RequestInit {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
      ...extraHeaders,
    },
    body,
  }
}

export function postRaw(
  body: string,
  headers: Readonly<Record<string, string>>,
): RequestInit {
  return {
    method: 'POST',
    headers: { ...headers, 'content-length': String(Buffer.byteLength(body, 'utf8')) },
    body,
  }
}

export function completedCaptureWebhook(
  eventId = 'WH-7W7265122A4531234-0',
): string {
  return `{
  "id":"${eventId}",
  "event_type":"PAYMENT.CAPTURE.COMPLETED",
  "resource":{
    "id":"${CAPTURE_ID}",
    "status":"COMPLETED",
    "final_capture":true,
    "amount":{"currency_code":"USD","value":"3.00"},
    "supplementary_data":{"related_ids":{"order_id":"${ORDER_ID}"}}
  }
}`
}

type StoredRow = Record<string, unknown>

export class MemoryPayPalDatabase implements PayPalCreditStoreDatabase {
  readonly calls: Array<Readonly<{ text: string; params: readonly unknown[] }>> = []
  readonly rateUses = new Map<string, number>()
  readonly intents = new Map<string, StoredRow>()
  readonly requests = new Map<string, string>()
  readonly purchases = new Map<string, StoredRow>()
  readonly events = new Map<string, StoredRow>()
  readonly catalog = new Map<string, StoredRow>()
  private receipt = 0

  async query(text: string, params: readonly unknown[] = []): Promise<readonly StoredRow[]> {
    this.calls.push({ text, params })
    if (text.includes('paypal-credit:rate-limit')) {
      const key = String(params[0])
      const maximum = Number(params[1])
      const used = this.rateUses.get(key) ?? 0
      if (used >= maximum) return []
      this.rateUses.set(key, used + 1)
      return [{ used: used + 1 }]
    }
    if (text.includes('paypal-credit:recipient')) {
      const id = Number(params[0])
      return id === 193 ? [{ id, handle: 'keeps-the-maybe' }] : []
    }
    if (text.includes('paypal-credit:begin-intent')) return this.beginIntent(params)
    if (text.includes('paypal-credit:attach-order')) {
      return this.attach(params, 'remote_order_id')
    }
    if (text.includes('paypal-credit:attach-allowance')) {
      return this.attach(params, 'remote_subscription_id')
    }
    if (text.includes('paypal-credit:read-intent')) {
      const row = this.intents.get(String(params[0]))
      return row ? [{ ...row }] : []
    }
    if (text.includes('paypal-credit:read-order')) {
      const row = [...this.intents.values()].find(candidate => (
        candidate.remote_order_id === params[0]
      ))
      return row ? [{ ...row }] : []
    }
    if (text.includes('paypal-credit:read-subscription')) {
      const row = [...this.intents.values()].find(candidate => (
        candidate.remote_subscription_id === params[0]
      ))
      return row ? [{ ...row }] : []
    }
    if (text.includes('paypal-credit:deliver-atomic')) return this.deliverAtomic(params)
    if (text.includes('paypal-credit:read-delivered-order')) {
      return this.readDeliveredOrder(params)
    }
    if (text.includes('paypal-credit:record-event')) return this.recordEvent(params)
    if (text.includes('paypal-credit:read-catalog')) {
      const row = this.catalog.get(String(params[0]))
      return row ? [{ ...row }] : []
    }
    if (text.includes('paypal-credit:store-product_id')) {
      return this.storeCatalog(params, 'product_id')
    }
    if (text.includes('paypal-credit:store-plan_id')) {
      return this.storeCatalog(params, 'plan_id')
    }
    throw new Error(`unexpected SQL in test: ${text.trim().slice(0, 120)}`)
  }

  private beginIntent(params: readonly unknown[]): readonly StoredRow[] {
    const requestId = String(params[1])
    const existingId = this.requests.get(requestId)
    if (existingId) return [{ ...this.intents.get(existingId)!, created: false }]
    const row = {
      public_id: params[0], request_id: params[1], intent_kind: params[2],
      delivery: params[3], recipient_id: params[4], amount_units: params[5],
      claim_token_hash: params[6], paypal_environment: params[7],
      remote_order_id: null, remote_subscription_id: null, status: 'created',
    }
    this.intents.set(String(params[0]), row)
    this.requests.set(requestId, String(params[0]))
    return [{ ...row, created: true }]
  }

  private attach(
    params: readonly unknown[],
    column: 'remote_order_id' | 'remote_subscription_id',
  ): readonly StoredRow[] {
    const id = String(params[0])
    const row = this.intents.get(id)
    if (!row) return []
    const updated = { ...row, [column]: params[1], status: 'approval_pending' }
    this.intents.set(id, updated)
    return [{ ...updated }]
  }

  private deliverAtomic(params: readonly unknown[]): readonly StoredRow[] {
    const purchaseId = String(params[0])
    const sourceKey = String(params[7])
    const existing = this.purchases.get(sourceKey)
    if (existing) return [{ ...existing, created: false }]
    const intent = this.intents.get(purchaseId)
    if (!intent) return []

    this.receipt += 1
    const isGift = params[1] === 'gift'
    const row = {
      id: String(this.receipt), resident_id: params[2], amount_units: params[3],
      source_key: sourceKey, purchase_kind: params[8],
      gift_row_id: isGift ? String(this.receipt + 100) : null,
      gift_public_id: isGift ? params[12] : null,
      claim_token_hash: params[4], status: isGift ? 'pending' : null,
      balance_units: isGift ? '0' : params[3], created: true,
    }
    this.purchases.set(sourceKey, row)
    this.events.set(String(params[9]), {
      event_id: params[9], event_kind: params[10], remote_resource_id: params[11],
      source_key: sourceKey, outcome: 'credited', intent_public_id: purchaseId,
      purchase_entry_id: row.id, created: true, binding_count: '1',
    })
    this.intents.set(purchaseId, {
      ...intent,
      status: intent.intent_kind === 'order' ? 'captured' : 'active',
    })
    return [{ ...row }]
  }

  private readDeliveredOrder(params: readonly unknown[]): readonly StoredRow[] {
    const purchaseId = String(params[0])
    const intent = this.intents.get(purchaseId)
    const event = [...this.events.values()].find(candidate => (
      candidate.intent_public_id === purchaseId
      && candidate.event_kind === 'PAYMENT.CAPTURE.COMPLETED'
      && candidate.outcome === 'credited'
    ))
    const receipt = event ? this.purchases.get(String(event.source_key)) : null
    if (!intent || !receipt) return []
    return [{
      ...receipt,
      created: false,
      intent_delivery: intent.delivery,
      intent_recipient_id: intent.recipient_id,
      intent_amount_units: intent.amount_units,
    }]
  }

  private recordEvent(params: readonly unknown[]): readonly StoredRow[] {
    const sourceKey = params[3] == null ? null : String(params[3])
    const existing = [...this.events.values()].find(candidate => (
      candidate.event_id === params[0]
      || (sourceKey !== null && candidate.source_key === sourceKey)
    ))
    if (existing) return [{ ...existing, created: false }]
    const row = {
      event_id: params[0], event_kind: params[1], remote_resource_id: params[2],
      source_key: params[3], outcome: params[4], created: true, binding_count: '1',
    }
    this.events.set(String(params[0]), row)
    return [{ ...row }]
  }

  private storeCatalog(
    params: readonly unknown[],
    column: 'product_id' | 'plan_id',
  ): readonly StoredRow[] {
    const key = String(params[0])
    const row = this.catalog.get(key) ?? {
      paypal_environment: key, product_id: null, plan_id: null,
    }
    const updated = { ...row, [column]: params[1] }
    this.catalog.set(key, updated)
    return [{ ...updated }]
  }
}

type PayPalFetcherOptions = Readonly<{
  verifyWebhook?: () => Response | Promise<Response>
}>

export function paypalFetcher(options: PayPalFetcherOptions = {}) {
  const calls: Array<Readonly<{ url: string; init: RequestInit | undefined }>> = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/v1/oauth2/token')) {
      return Response.json({
        access_token: 'sandbox-access-token', token_type: 'Bearer', expires_in: 3600,
      })
    }
    if (url.endsWith('/v2/checkout/orders')) {
      return Response.json({
        id: ORDER_ID, status: 'CREATED',
        links: [{
          rel: 'approve', method: 'GET',
          href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`,
        }],
      }, { status: 201 })
    }
    if (url.endsWith(`/v2/checkout/orders/${ORDER_ID}/capture`)) {
      const orderCreate = calls.find(call => call.url.endsWith('/v2/checkout/orders'))
      const orderBody = JSON.parse(String(orderCreate?.init?.body)) as {
        purchase_units: Array<{ reference_id: string }>
      }
      return Response.json({
        id: ORDER_ID, status: 'COMPLETED',
        purchase_units: [{
          reference_id: orderBody.purchase_units[0]!.reference_id,
          payments: { captures: [{
            id: CAPTURE_ID, status: 'COMPLETED', final_capture: true,
            amount: { currency_code: 'USD', value: '3.00' },
          }] },
        }],
      }, { status: 201 })
    }
    if (url.endsWith('/v1/notifications/verify-webhook-signature')) {
      return options.verifyWebhook
        ? await options.verifyWebhook()
        : Response.json({ verification_status: 'SUCCESS' })
    }
    if (url.endsWith('/v1/catalogs/products')) {
      return Response.json({ id: 'PROD-6XB24663H4094933M' }, { status: 201 })
    }
    if (url.endsWith('/v1/billing/plans')) {
      return Response.json({ id: 'P-5ML4271244454362WXNWU5NQ', status: 'ACTIVE' }, { status: 201 })
    }
    if (url.endsWith('/v1/billing/subscriptions')) {
      return Response.json({
        id: SUBSCRIPTION_ID, status: 'APPROVAL_PENDING',
        links: [{
          rel: 'approve', method: 'GET',
          href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=${SUBSCRIPTION_ID}`,
        }],
      }, { status: 201 })
    }
    throw new Error(`unexpected PayPal request: ${url}`)
  }) as typeof fetch
  return { fetcher, calls }
}

export function configuredApp(
  database = new MemoryPayPalDatabase(),
  options: PayPalFetcherOptions = {},
) {
  const paypal = paypalFetcher(options)
  const app = new Hono()
  mountPayPalCreditRoutes(app, {
    database,
    environment: READY_ENV,
    publicOrigin: 'https://1f3d9.com',
    fetcher: paypal.fetcher,
    authenticate: async c => c.req.header('authorization') === 'Bearer resident-193'
      ? { id: 193 }
      : null,
  })
  return { app, database, paypal }
}
