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

export function disputeWebhook(input: Readonly<{
  eventId: string
  eventKind: 'CUSTOMER.DISPUTE.CREATED' | 'CUSTOMER.DISPUTE.UPDATED' | 'CUSTOMER.DISPUTE.RESOLVED'
  disputeId?: string
  captureId?: string
  status?: 'OPEN' | 'WAITING_FOR_SELLER_RESPONSE' | 'UNDER_REVIEW' | 'RESOLVED'
  outcomeCode?:
    | 'RESOLVED_SELLER_FAVOUR'
    | 'RESOLVED_BUYER_FAVOUR'
    | 'RESOLVED_WITH_PAYOUT'
    | 'CANCELED_BY_BUYER'
    | 'ACCEPTED'
    | 'DENIED'
    | 'NONE'
  updateTime?: string
}>): string {
  const resource: Record<string, unknown> = {
    dispute_id: input.disputeId ?? 'PP-D-POSTGRES-0001',
    status: input.status ?? (input.eventKind === 'CUSTOMER.DISPUTE.RESOLVED' ? 'RESOLVED' : 'OPEN'),
    update_time: input.updateTime ?? '2026-08-27T18:00:00.000Z',
    disputed_transactions: [{
      seller_transaction_id: input.captureId ?? CAPTURE_ID,
    }],
  }
  if (input.outcomeCode) {
    resource.dispute_outcome = { outcome_code: input.outcomeCode }
  }
  return JSON.stringify({
    id: input.eventId,
    event_type: input.eventKind,
    resource,
  })
}

type StoredRow = Record<string, unknown>

type StagedDisputeEvent = Readonly<{
  event_id: string
  event_kind: string
  dispute_id: string
  capture_ids: readonly string[]
  paypal_status: string
  outcome_code: string | null
  resource_updated_at: string
}>

export class MemoryPayPalDatabase implements PayPalCreditStoreDatabase {
  readonly calls: Array<Readonly<{ text: string; params: readonly unknown[] }>> = []
  readonly rateUses = new Map<string, number>()
  readonly intents = new Map<string, StoredRow>()
  readonly requests = new Map<string, string>()
  readonly purchases = new Map<string, StoredRow>()
  readonly events = new Map<string, StoredRow>()
  readonly disputes = new Map<string, StoredRow>()
  readonly disputeEvents = new Map<string, StoredRow>()
  readonly founderNotes = new Map<string, StoredRow>()
  readonly disputeReceipts = new Map<string, StoredRow>()
  readonly catalog = new Map<string, StoredRow>()
  private readonly stagedDisputeEvents = new Map<string, StagedDisputeEvent>()
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
    if (text.includes('paypal-credit:apply-dispute')) return this.applyDispute(params)
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
    this.reconcileDisputesForCapture(String(params[11]))
    return [{ ...this.purchases.get(sourceKey)! }]
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
      frozen_at: receipt.dispute_blocked === true ? '2026-08-27T18:00:00.000Z' : null,
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

  private applyDispute(params: readonly unknown[]): readonly StoredRow[] {
    const [eventIdValue, eventKindValue, disputeIdValue, captureIdValue, statusValue,
      outcomeCodeValue, resourceUpdatedAtValue] = params
    const eventId = String(eventIdValue)
    const eventKind = String(eventKindValue)
    const disputeId = String(disputeIdValue)
    const captureIds = Object.freeze((captureIdValue as readonly unknown[]).map(String))
    const paypalStatus = String(statusValue)
    const outcomeCode = outcomeCodeValue == null ? null : String(outcomeCodeValue)
    const resourceUpdatedAt = String(resourceUpdatedAtValue)
    const logicalReplay = [...this.stagedDisputeEvents.values()].find(candidate => (
      candidate.event_id === eventId
      || (candidate.dispute_id === disputeId
        && candidate.event_kind === eventKind
        && candidate.resource_updated_at === resourceUpdatedAt)
    ))
    if (logicalReplay) {
      if (
        logicalReplay.dispute_id !== disputeId
        || logicalReplay.event_kind !== eventKind
        || logicalReplay.paypal_status !== paypalStatus
        || logicalReplay.outcome_code !== outcomeCode
        || JSON.stringify(logicalReplay.capture_ids) !== JSON.stringify(captureIds)
      ) return []
      return [this.applyStagedDispute(logicalReplay, false)]
    }
    const staged = Object.freeze({
      event_id: eventId,
      event_kind: eventKind,
      dispute_id: disputeId,
      capture_ids: captureIds,
      paypal_status: paypalStatus,
      outcome_code: outcomeCode,
      resource_updated_at: resourceUpdatedAt,
    })
    this.stagedDisputeEvents.set(eventId, staged)
    return [this.applyStagedDispute(staged, true)]
  }

  private applyStagedDispute(
    staged: StagedDisputeEvent,
    created: boolean,
  ): StoredRow {
    const {
      event_id: eventId,
      event_kind: eventKind,
      dispute_id: disputeId,
      capture_ids: captureIds,
      paypal_status: paypalStatus,
      outcome_code: outcomeCode,
      resource_updated_at: resourceUpdatedAt,
    } = staged
    const existingDispute = this.disputes.get(disputeId)
    const sellerFavourOutcomes = new Set([
      'RESOLVED_SELLER_FAVOUR',
      'CANCELED_BY_BUYER',
      'DENIED',
    ])
    const againstSellerOutcomes = new Set([
      'RESOLVED_BUYER_FAVOUR',
      'ACCEPTED',
    ])
    const desiredState = eventKind !== 'CUSTOMER.DISPUTE.RESOLVED'
      ? 'open'
      : outcomeCode !== null && sellerFavourOutcomes.has(outcomeCode)
        ? 'resolved_seller'
        : outcomeCode !== null && againstSellerOutcomes.has(outcomeCode)
          ? 'resolved_against_seller'
          : 'resolution_review'
    const disputeEvents = [...this.stagedDisputeEvents.values()]
      .filter(event => event.dispute_id === disputeId)
      .sort((left, right) => (
        Date.parse(left.resource_updated_at) - Date.parse(right.resource_updated_at)
        || left.event_id.localeCompare(right.event_id)
      ))
    const durableCaptureIds = [...new Set(
      disputeEvents.flatMap(event => event.capture_ids),
    )].sort()
    if (durableCaptureIds.length > 1_000) {
      throw Object.assign(new Error('dispute capture binding exceeds its limit'), {
        code: '23514',
      })
    }
    const existingTime = existingDispute == null
      ? Number.NEGATIVE_INFINITY
      : Date.parse(String(existingDispute.resource_updated_at))
    const eventTime = Date.parse(resourceUpdatedAt)
    const projected: StoredRow = existingDispute == null
      ? {
          dispute_id: disputeId,
          state: desiredState,
          paypal_status: paypalStatus,
          outcome_code: outcomeCode,
          resource_updated_at: resourceUpdatedAt,
        }
      : existingDispute.state === 'resolved_against_seller'
        ? {
            ...existingDispute,
            resource_updated_at: eventTime > existingTime
              ? resourceUpdatedAt
              : existingDispute.resource_updated_at,
          }
        : desiredState === 'resolved_against_seller'
          ? {
              dispute_id: disputeId,
              state: desiredState,
              paypal_status: paypalStatus,
              outcome_code: outcomeCode,
              resource_updated_at: eventTime > existingTime
                ? resourceUpdatedAt
                : existingDispute.resource_updated_at,
            }
          : eventTime > existingTime
            ? {
                dispute_id: disputeId,
                state: desiredState,
                paypal_status: paypalStatus,
                outcome_code: outcomeCode,
                resource_updated_at: resourceUpdatedAt,
              }
            : existingDispute
    const current: StoredRow = {
      ...projected,
      capture_ids: Object.freeze(durableCaptureIds),
    }
    this.disputes.set(disputeId, { ...current })

    const localCaptures = durableCaptureIds.flatMap(captureId => {
      const captureEvent = [...this.events.values()].find(candidate => (
        candidate.event_kind === 'PAYMENT.CAPTURE.COMPLETED'
        && candidate.remote_resource_id === captureId
        && candidate.outcome === 'credited'
      ))
      if (!captureEvent) return []
      const purchase = this.purchases.get(String(captureEvent.source_key))
      return purchase ? [{ captureId, purchase }] : []
    })
    const requestedLocalCaptures = localCaptures.filter(({ captureId }) => (
      captureIds.includes(captureId)
    ))
    let receiptsCreated = 0
    for (const durableEvent of disputeEvents) {
      const staleEvent = current.state !== 'resolved_against_seller'
        && Date.parse(durableEvent.resource_updated_at)
          < Date.parse(String(current.resource_updated_at))
      for (const { captureId, purchase } of localCaptures) {
        const receiptKey = `${durableEvent.event_id}:${captureId}`
        if (this.disputeReceipts.has(receiptKey)) continue
        const targetOutcome = this.applyDisputeToPurchase(
          String(purchase.source_key),
          String(current.state),
          staleEvent,
        )
        const receipt = {
          dispute_id: disputeId,
          capture_id: captureId,
          event_id: durableEvent.event_id,
          application_outcome: targetOutcome,
        }
        this.disputeReceipts.set(receiptKey, receipt)
        this.disputeEvents.set(receiptKey, {
          ...current,
          ...receipt,
          event_kind: durableEvent.event_kind,
        })
        if (durableEvent.event_id === eventId && captureIds.includes(captureId)) {
          receiptsCreated += 1
        }
      }
    }
    const localOutcomes = requestedLocalCaptures.map(({ captureId }) => String(
      this.disputeReceipts.get(`${eventId}:${captureId}`)?.application_outcome,
    ))
    if (!this.founderNotes.has(disputeId)) {
      this.founderNotes.set(disputeId, {
        dispute_id: disputeId,
        body: `Verified PayPal dispute ${disputeId} was recorded.`,
      })
    }
    const applicationOutcome = this.aggregateDisputeOutcome(
      eventKind,
      captureIds.length,
      requestedLocalCaptures.length,
      localOutcomes,
    )
    const result = {
      ...current,
      event_id: eventId,
      application_outcome: applicationOutcome,
      created,
      transaction_count: String(captureIds.length),
      local_purchase_count: String(requestedLocalCaptures.length),
      receipts_created: String(receiptsCreated),
    }
    this.disputes.set(disputeId, { ...current, application_outcome: applicationOutcome })
    return result
  }

  private applyDisputeToPurchase(
    sourceKey: string,
    desiredState: string,
    stale: boolean,
  ): string {
    const purchase = this.purchases.get(sourceKey)!
    if (stale) return 'dispute_stale_event_ignored'
    if (desiredState === 'open') {
      if (purchase.gift_row_id == null || purchase.status === 'accepted') {
        return 'dispute_open_credit_retained'
      }
      if (purchase.status === 'refused') {
        this.purchases.set(sourceKey, { ...purchase, dispute_blocked: true })
        return 'dispute_open_refused_gift_blocked'
      }
      const updated = { ...purchase, status: 'frozen', dispute_blocked: true }
      this.purchases.set(sourceKey, updated)
      return 'dispute_open_gift_frozen'
    }
    if (desiredState === 'resolution_review') {
      if (purchase.gift_row_id != null && purchase.status !== 'accepted') {
        const updated = purchase.status === 'refused'
          ? { ...purchase, dispute_blocked: true }
          : { ...purchase, status: 'frozen', dispute_blocked: true }
        this.purchases.set(sourceKey, updated)
      }
      return 'dispute_resolution_needs_operator_review'
    }
    if (desiredState === 'resolved_against_seller') {
      if (purchase.gift_row_id != null && purchase.status !== 'accepted') {
        this.purchases.set(sourceKey, {
          ...purchase,
          status: 'revoked',
          dispute_blocked: false,
        })
        return 'dispute_resolved_gift_revoked'
      }
      return 'dispute_resolved_credit_retained'
    }
    if (purchase.gift_row_id != null && purchase.status === 'frozen') {
      this.purchases.set(sourceKey, {
        ...purchase,
        status: 'pending',
        dispute_blocked: false,
      })
      return 'dispute_resolved_gift_pending'
    }
    if (purchase.gift_row_id != null && purchase.status === 'refused') {
      this.purchases.set(sourceKey, { ...purchase, dispute_blocked: false })
      return 'dispute_resolved_refused_gift'
    }
    if (purchase.gift_row_id != null && purchase.status === 'pending') {
      return 'dispute_resolved_gift_pending'
    }
    if (purchase.gift_row_id != null && purchase.status === 'revoked') {
      return 'dispute_resolved_gift_revoked'
    }
    return 'dispute_resolved_credit_retained'
  }

  private aggregateDisputeOutcome(
    eventKind: string,
    transactionCount: number,
    localPurchaseCount: number,
    localOutcomes: readonly string[],
  ): string {
    if (localPurchaseCount === 0) return 'dispute_awaiting_capture_receipt'
    if (localPurchaseCount < transactionCount) {
      return 'dispute_partially_applied_awaiting_capture_receipt'
    }
    if (localOutcomes.every(outcome => outcome === 'dispute_stale_event_ignored')) {
      return 'dispute_stale_event_ignored'
    }
    if (localOutcomes.every(outcome => outcome === 'dispute_resolution_needs_operator_review')) {
      return 'dispute_resolution_needs_operator_review'
    }
    if (localOutcomes.length === 1) return localOutcomes[0]!
    if (localOutcomes.every(outcome => outcome === 'dispute_open_gift_frozen')) {
      return 'dispute_open_gifts_frozen'
    }
    return eventKind === 'CUSTOMER.DISPUTE.RESOLVED'
      ? 'dispute_resolved_targets_applied'
      : 'dispute_open_targets_applied'
  }

  private reconcileDisputesForCapture(captureId: string): void {
    const staged = [...this.stagedDisputeEvents.values()]
      .filter(event => event.capture_ids.includes(captureId))
      .sort((left, right) => (
        Date.parse(left.resource_updated_at) - Date.parse(right.resource_updated_at)
      ))
    for (const event of staged) this.applyStagedDispute(event, false)
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
  captureId?: string
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
            id: options.captureId ?? CAPTURE_ID, status: 'COMPLETED', final_capture: true,
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
