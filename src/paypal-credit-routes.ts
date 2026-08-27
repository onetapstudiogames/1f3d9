import { createHash, createHmac } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { declaredBodyLength } from './bounded-body.ts'
import { CITY_FEE_CREDIT_UNITS, parseCityCreditRequestId } from './city-credit.ts'
import { deliverPayPalCredit } from './paypal-credit-delivery.ts'
import {
  PayPalCreditStoreConflictError, attachPayPalOrder, attachPayPalSubscription,
  beginPayPalCreditIntent, findPayPalCreditRecipient, readPayPalCatalog,
  readPayPalCreditIntent, readDeliveredPayPalOrderCredit, storePayPalCatalogPlan,
  storePayPalCatalogProduct, takePayPalCreditRateLimit,
  type PayPalCreditStoreDatabase,
  type StoredPayPalIntent,
} from './paypal-credit-store.ts'
import {
  capturePayPalCreditOrder, createPayPalCreditOrder, createWeeklyAllowancePlan,
  createWeeklyAllowanceProduct, createWeeklyAllowanceSubscription,
  paypalHostedApprovalUrl, paypalReadiness,
  type PayPalEnvironment,
} from './paypal-credit.ts'
import { PayPalWebhookApplicationError, applyVerifiedPayPalWebhook } from './paypal-credit-webhook.ts'
import { PrepaidCreditConflictError, parseCreditDollars } from './prepaid-credit.ts'

export const PAYPAL_CREDIT_UNAVAILABLE_MESSAGE =
  'Credit purchases are unavailable because PayPal is not configured. No payment was started. Ask the city owner to connect PayPal.'

const MAX_JSON_BODY_BYTES = 2_048
const MAX_WEBHOOK_BODY_BYTES = 1_048_576
const MAX_RESIDENT_ID = 2_147_483_647
const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const PUBLIC_PURCHASE_ID = /^city_paypal_[0-9a-f]{32}$/u
const PAYPAL_ROUTE_PATH = '/api/city-credit/paypal'

function apiCaptureEventId(captureId: string): string {
  return `api-capture:${createHash('sha256').update(captureId, 'utf8').digest('hex')}`
}

type AuthenticatedResident = Readonly<{ id: number }>
type JsonRecord = Record<string, unknown>
type ReadyPayPal = Extract<ReturnType<typeof paypalReadiness>, { ready: true }>
type PayPalRouteOperation = 'lookup' | 'order' | 'capture' | 'allowance' | 'webhook'

export interface PayPalCreditRouteDependencies {
  database: PayPalCreditStoreDatabase
  environment?: PayPalEnvironment
  publicOrigin: string
  authenticate?(c: Context): Promise<AuthenticatedResident | null>
  fetcher?: typeof fetch
}

class RouteFailure extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503
  readonly details: Readonly<Record<string, unknown>>

  constructor(status: 400 | 401 | 403 | 404 | 409 | 429 | 503, message: string,
    details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'RouteFailure'
    this.status = status
    this.details = details
  }
}

function privateHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Vary', 'Authorization')
}

const CALLER_FAILURES = Object.freeze({
  lookup: Object.freeze({
    unavailable: 'Resident lookup is unavailable because PayPal is not configured. Ask the city owner to connect PayPal, then retry this lookup.',
    temporary: 'Resident lookup is temporarily unavailable. Retry this lookup with the same resident number.',
    details: Object.freeze({ retry_same_lookup: true }),
  }),
  order: Object.freeze({
    unavailable: 'PayPal order creation is unavailable because PayPal is not configured. Ask the city owner to connect PayPal, then retry the same request_id.',
    temporary: 'PayPal order creation is temporarily unavailable. Retry the same request_id; do not start another payment.',
    details: Object.freeze({ retry_same_request_id: true, do_not_start_another_payment: true }),
  }),
  allowance: Object.freeze({
    unavailable: 'PayPal allowance creation is unavailable because PayPal is not configured. Ask the city owner to connect PayPal, then retry the same request_id.',
    temporary: 'PayPal allowance creation is temporarily unavailable. Retry the same request_id; do not start another subscription.',
    details: Object.freeze({ retry_same_request_id: true, do_not_start_another_payment: true }),
  }),
  capture: Object.freeze({
    unavailable: 'PayPal capture is unavailable because PayPal is not configured. Ask the city owner to connect PayPal, then reload this return page with the same purchase_id and paypal_order_id; do not start another payment.',
    temporary: 'PayPal capture is temporarily unavailable. Reload this return page with the same purchase_id and paypal_order_id; do not start another payment.',
    details: Object.freeze({
      retry_same_purchase_id: true, retry_same_paypal_order_id: true,
      do_not_start_another_payment: true,
    }),
  }),
  webhook: Object.freeze({
    unavailable: 'PayPal webhook handling is unavailable because PayPal is not configured. Ask the city owner to connect PayPal; PayPal should retry this exact event.',
    temporary: 'PayPal webhook handling is temporarily unavailable. PayPal should retry this exact event.',
    details: Object.freeze({ paypal_should_retry_exact_event: true }),
  }),
})
function unavailable(c: Context, operation: PayPalRouteOperation): Response {
  const failure = CALLER_FAILURES[operation]
  return c.json({
    error: failure.unavailable, ...failure.details,
    ...(['lookup', 'order', 'allowance'].includes(operation)
      ? { payment_started: false } : {}),
  }, 503)
}
function routeReadiness(c: Context, dependencies: PayPalCreditRouteDependencies,
  operation: PayPalRouteOperation): ReadyPayPal | Response {
  privateHeaders(c)
  const readiness = paypalReadiness(dependencies.environment ?? process.env)
  return readiness.ready ? readiness : unavailable(c, operation)
}

function isResponse(value: ReadyPayPal | Response): value is Response {
  return value instanceof Response
}

function queryless(c: Context): void {
  if (Object.keys(c.req.queries()).length !== 0) {
    throw new RouteFailure(400, 'This PayPal credit route accepts no query options.')
  }
}

function assertDeclaredBodyFits(c: Context, maximumBytes: number): void {
  if (declaredBodyLength(c.req.header('content-length'), maximumBytes) === 'unusable') {
    throw new RouteFailure(400,
      `The PayPal request declared an unusable Content-Length. Declare one decimal byte count no larger than ${maximumBytes} bytes, or omit the header.`)
  }
}

async function readBoundedBody(c: Context, maximumBytes: number): Promise<Buffer> {
  assertDeclaredBodyFits(c, maximumBytes)
  // Vercel's Node bridge can stall when a handler drives the raw stream reader,
  // so the framework read is used and the actual bytes are checked afterward.
  const body = Buffer.from(await c.req.arrayBuffer())
  if (body.byteLength === 0) {
    throw new RouteFailure(400,
      'The PayPal request body is empty. Send one JSON body. No payment was started.')
  }
  if (body.byteLength > maximumBytes) {
    throw new RouteFailure(400,
      `The PayPal request body is larger than ${maximumBytes} bytes. No payment was started.`)
  }
  return body
}

async function readJsonBody(c: Context): Promise<JsonRecord> {
  const mediaType = (c.req.header('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw new RouteFailure(400, 'Send one application/json body. No payment was started.')
  }
  const raw = await readBoundedBody(c, MAX_JSON_BODY_BYTES)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown
  } catch {
    throw new RouteFailure(400, 'The PayPal request JSON is invalid. No payment was started.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RouteFailure(400, 'The PayPal request JSON must be one object. No payment was started.')
  }
  return parsed as JsonRecord
}

function hasOnly(record: JsonRecord, names: readonly string[]): boolean {
  const expected = new Set(names)
  return Object.keys(record).length === names.length
    && Object.keys(record).every(name => expected.has(name))
}

function requestId(value: unknown): string {
  let parsed: string | null
  try {
    parsed = parseCityCreditRequestId(value)
  } catch {
    throw new RouteFailure(400,
      'request_id must be one non-secret ASCII identifier of 8 to 128 characters. No payment was started.')
  }
  if (!parsed) {
    throw new RouteFailure(400,
      'request_id must be one non-secret ASCII identifier of 8 to 128 characters. No payment was started.')
  }
  return parsed
}

function residentNumber(value: unknown): number {
  const text = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : value
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(text)) {
    throw new RouteFailure(400, 'resident_number must be one positive city resident number. No payment was started.')
  }
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed > MAX_RESIDENT_ID) {
    throw new RouteFailure(400, 'resident_number must be one positive city resident number. No payment was started.')
  }
  return parsed
}

function residentHandle(value: unknown): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') < 1
    || Buffer.byteLength(value, 'utf8') > 64
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) throw new RouteFailure(400, 'resident_handle must be the handle just confirmed. No payment was started.')
  return value
}

function exactAmount(value: unknown): Readonly<{ amountUnits: bigint; wholeDollars: bigint }> {
  if (typeof value !== 'string') {
    throw new RouteFailure(400, 'amount_dollars must be a whole-dollar string from 1 to 10000. No payment was started.')
  }
  try {
    const amountUnits = parseCreditDollars(value)
    return Object.freeze({
      amountUnits,
      wholeDollars: amountUnits / CITY_FEE_CREDIT_UNITS,
    })
  } catch {
    throw new RouteFailure(400, 'amount_dollars must be a whole-dollar string from 1 to 10000. No payment was started.')
  }
}

function remoteIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !REMOTE_ID.test(value)) {
    throw new RouteFailure(400, `${label} is invalid. No new payment was started.`)
  }
  return value
}

function delivery(value: unknown): 'self' | 'gift' {
  if (value !== 'self' && value !== 'gift') {
    throw new RouteFailure(400, 'delivery must be self or gift. No payment was started.')
  }
  return value
}

async function confirmRecipient(
  dependencies: PayPalCreditRouteDependencies,
  number: number,
  expectedHandle: string,
) {
  const recipient = await findPayPalCreditRecipient(dependencies.database, number)
  if (!recipient) throw new RouteFailure(404, 'That resident number was not found. No payment was started.')
  if (recipient.residentHandle !== expectedHandle) {
    throw new RouteFailure(409,
      'That resident number now has a different handle. Confirm the shown handle before paying.', {
        resident_number: recipient.residentNumber,
        resident_handle: recipient.residentHandle,
        payment_started: false,
      })
  }
  return recipient
}

async function requireSelfOwner(
  c: Context,
  dependencies: PayPalCreditRouteDependencies,
  targetResidentId: number,
): Promise<AuthenticatedResident> {
  const resident = dependencies.authenticate ? await dependencies.authenticate(c) : null
  if (!resident) {
    throw new RouteFailure(401,
      'Self-funding needs the matching resident bearer key. No payment was started.')
  }
  if (resident.id !== targetResidentId) {
    throw new RouteFailure(403,
      'That resident key does not control the confirmed resident. Use gift delivery instead. No payment was started.')
  }
  return resident
}

function callerAddress(c: Context, environment: PayPalEnvironment): string {
  if (environment.VERCEL !== '1') return 'local-or-unattributed'
  const forwarded = c.req.header('x-vercel-forwarded-for')
  return forwarded?.split(',').map(part => part.trim()).filter(Boolean).at(-1)
    ?? 'unattributed'
}

function hashCaller(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex')
}

async function requireRateSlot(
  c: Context,
  dependencies: PayPalCreditRouteDependencies,
  residentId: number | null,
  scope: 'prepare' | 'capture' | 'webhook',
): Promise<void> {
  const environment = dependencies.environment ?? process.env
  const callerHashSecret = environment.PAYPAL_CLIENT_SECRET
  if (typeof callerHashSecret !== 'string') {
    throw new RouteFailure(503, PAYPAL_CREDIT_UNAVAILABLE_MESSAGE)
  }
  const key = residentId == null
    ? `paypal-credit:${scope}:anonymous:${callerAddress(c, environment)}`
    : `paypal-credit:${scope}:resident:${residentId}`
  const maximum = scope === 'webhook' ? 300 : 30
  if (!await takePayPalCreditRateLimit(
    dependencies.database,
    hashCaller(key, callerHashSecret),
    maximum,
  )) {
    c.header('Retry-After', '3600')
    throw new RouteFailure(429,
      `Too many PayPal ${scope} requests were received. Retry in one hour.`)
  }
}

function configuredOrigin(value: string): URL {
  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    throw new RouteFailure(503, 'PayPal callbacks are unavailable. No payment was started.')
  }
  if (
    origin.protocol !== 'https:'
    || origin.username
    || origin.password
    || origin.hash
    || origin.search
    || (origin.pathname !== '/' && origin.pathname !== '')
  ) throw new RouteFailure(503, 'PayPal callbacks are unavailable. No payment was started.')
  return origin
}

function callbackUrl(
  dependencies: PayPalCreditRouteDependencies,
  purchaseId: string,
  state: 'return' | 'cancel' | 'allowance-return' | 'allowance-cancel',
): string {
  if (!PUBLIC_PURCHASE_ID.test(purchaseId)) {
    throw new RouteFailure(400, 'PayPal purchase id is invalid. No payment was started.')
  }
  const origin = configuredOrigin(dependencies.publicOrigin)
  const callback = new URL('/buy', origin)
  callback.searchParams.set('paypal', state)
  callback.searchParams.set('purchase_id', purchaseId)
  if (callback.origin !== origin.origin) {
    throw new RouteFailure(503, 'PayPal callbacks are unavailable. No payment was started.')
  }
  return callback.href
}

function fetcher(dependencies: PayPalCreditRouteDependencies): typeof fetch {
  return dependencies.fetcher ?? fetch
}

async function ensureAllowancePlan(
  dependencies: PayPalCreditRouteDependencies,
  ready: ReadyPayPal,
): Promise<string> {
  let current = await readPayPalCatalog(dependencies.database, ready.environment)
  if (!current.productId) {
    const product = await createWeeklyAllowanceProduct(
      dependencies.environment ?? process.env,
      { requestId: `paypal-allowance-product:${ready.environment}:v1` },
      fetcher(dependencies),
    )
    current = await storePayPalCatalogProduct(dependencies.database, {
      paypalEnvironment: ready.environment,
      productId: product.productId,
    })
  }
  if (!current.planId) {
    const plan = await createWeeklyAllowancePlan(
      dependencies.environment ?? process.env,
      {
        productId: current.productId!,
        requestId: `paypal-allowance-plan:${ready.environment}:v1`,
      },
      fetcher(dependencies),
    )
    current = await storePayPalCatalogPlan(dependencies.database, {
      paypalEnvironment: ready.environment,
      planId: plan.planId,
    })
  }
  if (!current.planId) {
    throw new RouteFailure(503, 'PayPal allowance setup is temporarily unavailable. No payment was started.')
  }
  return current.planId
}

function captureSafeMessage(message: string): string {
  const falseClaim = /\s*No (?:new )?payment was started\./giu
  if (!falseClaim.test(message)) return message
  return `${message.replace(falseClaim, '')} Capture was not attempted. Reload the PayPal return page and use its purchase_id and paypal_order_id; do not create another payment.`
}
function responseFailure(
  c: Context,
  error: unknown,
  operation: PayPalRouteOperation,
): Response {
  if (error instanceof PayPalWebhookApplicationError) {
    const message = error.status === 503 && !/retry this exact event/iu.test(error.message)
      ? `${error.message} PayPal should retry this exact event.`
      : error.message
    return c.json({ error: message }, error.status)
  }
  if (error instanceof RouteFailure) {
    return c.json({
      error: operation === 'capture'
        ? captureSafeMessage(error.message)
        : error.message,
      ...error.details,
    }, error.status)
  }
  if (error instanceof PayPalCreditStoreConflictError || error instanceof PrepaidCreditConflictError) {
    if (operation === 'webhook') {
      return c.json({
        error: `${error.message} The city owner must resolve this durable PayPal evidence conflict; do not send a changed replacement event.`,
        owner_review_required: true,
        do_not_retry_with_changed_event: true,
      }, 409)
    }
    return c.json({
      error: operation === 'capture'
        ? `${error.message} Reload this return page with the same purchase_id and paypal_order_id; do not start another payment.`
        : error.message,
      do_not_start_another_payment: true,
    }, 409)
  }
  if (error instanceof TypeError) {
    if (operation === 'webhook') {
      return c.json({
        error: CALLER_FAILURES.webhook.temporary,
        ...CALLER_FAILURES.webhook.details,
      }, 503)
    }
    const message = operation === 'capture'
      ? 'The PayPal capture request is invalid. Capture was not attempted. Reload the PayPal return page and use its purchase_id and paypal_order_id; do not create another payment.'
      : 'The PayPal credit request is invalid. No payment was started.'
    return c.json({ error: message }, 400)
  }
  const failure = CALLER_FAILURES[operation]
  return c.json({
    error: failure.temporary,
    ...failure.details,
  }, 503)
}

function orderCreateBody(value: JsonRecord): Readonly<{
  requestId: string
  residentNumber: number
  residentHandle: string
  amountUnits: bigint
  wholeDollars: bigint
  delivery: 'self' | 'gift'
}> {
  if (!hasOnly(value, [
    'request_id', 'resident_number', 'resident_handle', 'amount_dollars', 'delivery',
  ])) {
    throw new RouteFailure(400,
      'Order creation needs only request_id, resident_number, resident_handle, amount_dollars, and delivery. No payment was started.')
  }
  const amount = exactAmount(value.amount_dollars)
  return Object.freeze({
    requestId: requestId(value.request_id),
    residentNumber: residentNumber(value.resident_number),
    residentHandle: residentHandle(value.resident_handle),
    amountUnits: amount.amountUnits,
    wholeDollars: amount.wholeDollars,
    delivery: delivery(value.delivery),
  })
}

function allowanceCreateBody(value: JsonRecord): Readonly<{
  requestId: string
  residentNumber: number
  residentHandle: string
  amountUnits: bigint
  wholeDollars: bigint
}> {
  if (!hasOnly(value, [
    'request_id', 'resident_number', 'resident_handle', 'amount_dollars',
  ])) {
    throw new RouteFailure(400,
      'Allowance creation needs only request_id, resident_number, resident_handle, and amount_dollars. No payment was started.')
  }
  const amount = exactAmount(value.amount_dollars)
  return Object.freeze({
    requestId: requestId(value.request_id),
    residentNumber: residentNumber(value.resident_number),
    residentHandle: residentHandle(value.resident_handle),
    amountUnits: amount.amountUnits,
    wholeDollars: amount.wholeDollars,
  })
}

async function createOrder(
  c: Context,
  dependencies: PayPalCreditRouteDependencies,
  ready: ReadyPayPal,
): Promise<Response> {
  queryless(c)
  const parsed = orderCreateBody(await readJsonBody(c))
  const actor = parsed.delivery === 'self'
    ? await requireSelfOwner(c, dependencies, parsed.residentNumber)
    : null
  await requireRateSlot(c, dependencies, actor?.id ?? null, 'prepare')
  const recipient = await confirmRecipient(
    dependencies,
    parsed.residentNumber,
    parsed.residentHandle,
  )
  const intent = await beginPayPalCreditIntent(dependencies.database, {
    requestId: parsed.requestId,
    intentKind: 'order',
    delivery: parsed.delivery,
    recipientId: recipient.residentNumber,
    amountUnits: parsed.amountUnits,
    paypalEnvironment: ready.environment,
  })
  if (intent.status === 'captured') {
    throw new RouteFailure(409,
      'This PayPal purchase is complete. Do not approve or pay again. Only the credited resident can read the private receipt through /api/me.', {
        purchase_id: intent.purchaseId,
        do_not_start_another_payment: true,
      })
  }
  if (intent.delivery === 'gift' && intent.disposition === 'existing' && !intent.claimToken) {
    throw new RouteFailure(409,
      'The one-time redirect key for this gift cannot be shown again. Do not approve the old PayPal order. Start a fresh request_id to receive a new key before paying.', {
        purchase_id: intent.purchaseId,
        do_not_approve_old_order: true,
      })
  }
  if (intent.status === 'approval_pending' && intent.remoteOrderId) {
    return c.json({
      purchase_id: intent.purchaseId,
      approval_url: paypalHostedApprovalUrl(ready.environment, 'order', intent.remoteOrderId),
      claim_token_shown: false,
      resident_number: recipient.residentNumber,
      resident_handle: recipient.residentHandle,
    })
  }
  try {
    const order = await createPayPalCreditOrder(
      dependencies.environment ?? process.env,
      {
        purchaseId: intent.purchaseId,
        wholeDollars: parsed.wholeDollars,
        requestId: `paypal-order-create:${intent.purchaseId}`,
        returnUrl: callbackUrl(dependencies, intent.purchaseId, 'return'),
        cancelUrl: callbackUrl(dependencies, intent.purchaseId, 'cancel'),
      },
      fetcher(dependencies),
    )
    await attachPayPalOrder(dependencies.database, {
      purchaseId: intent.purchaseId,
      orderId: order.orderId,
    })
    return c.json({
      purchase_id: intent.purchaseId,
      approval_url: order.approvalUrl,
      ...(intent.claimToken ? { claim_token: intent.claimToken } : {}),
      claim_token_shown: intent.claimToken !== null,
      resident_number: recipient.residentNumber,
      resident_handle: recipient.residentHandle,
    }, intent.disposition === 'created' ? 201 : 200)
  } catch (error) {
    if (intent.delivery === 'gift') {
      throw new RouteFailure(503,
        'PayPal gift order creation did not complete. No approval URL was returned, and the one-time redirect key cannot be shown again. Do not approve any old order. Start a fresh request_id to receive a new key before paying.', {
          purchase_id: intent.purchaseId,
          retry_same_request_id: false,
          start_fresh_request_id: true,
          do_not_approve_old_order: true,
        })
    }
    throw error
  }
}

async function createAllowance(
  c: Context,
  dependencies: PayPalCreditRouteDependencies,
  ready: ReadyPayPal,
): Promise<Response> {
  queryless(c)
  const parsed = allowanceCreateBody(await readJsonBody(c))
  const actor = await requireSelfOwner(c, dependencies, parsed.residentNumber)
  await requireRateSlot(c, dependencies, actor.id, 'prepare')
  const recipient = await confirmRecipient(
    dependencies,
    parsed.residentNumber,
    parsed.residentHandle,
  )
  const intent = await beginPayPalCreditIntent(dependencies.database, {
    requestId: parsed.requestId,
    intentKind: 'allowance',
    delivery: 'self',
    recipientId: recipient.residentNumber,
    amountUnits: parsed.amountUnits,
    paypalEnvironment: ready.environment,
  })
  if (intent.status === 'active') {
    throw new RouteFailure(409,
      'This weekly allowance is already active. Do not create another subscription.', {
        purchase_id: intent.purchaseId,
      })
  }
  if (intent.status === 'approval_pending' && intent.remoteSubscriptionId) {
    return c.json({
      purchase_id: intent.purchaseId,
      approval_url: paypalHostedApprovalUrl(
        ready.environment, 'subscription', intent.remoteSubscriptionId),
      resident_number: recipient.residentNumber,
      resident_handle: recipient.residentHandle,
    })
  }
  const planId = await ensureAllowancePlan(dependencies, ready)
  const subscription = await createWeeklyAllowanceSubscription(
    dependencies.environment ?? process.env,
    {
      planId,
      allowanceId: intent.purchaseId,
      wholeDollars: parsed.wholeDollars,
      requestId: `paypal-allowance-subscribe:${intent.purchaseId}`,
      returnUrl: callbackUrl(dependencies, intent.purchaseId, 'allowance-return'),
      cancelUrl: callbackUrl(dependencies, intent.purchaseId, 'allowance-cancel'),
    },
    fetcher(dependencies),
  )
  await attachPayPalSubscription(dependencies.database, {
    purchaseId: intent.purchaseId,
    subscriptionId: subscription.subscriptionId,
  })
  return c.json({
    purchase_id: intent.purchaseId,
    approval_url: subscription.approvalUrl,
    resident_number: recipient.residentNumber,
    resident_handle: recipient.residentHandle,
  }, intent.disposition === 'created' ? 201 : 200)
}

async function capturedOrderResponse(
  c: Context,
  dependencies: PayPalCreditRouteDependencies,
  intent: StoredPayPalIntent,
  credit: Readonly<Record<string, unknown>>,
): Promise<Response> {
  const recipient = await findPayPalCreditRecipient(dependencies.database, intent.recipientId)
  if (!recipient) {
    throw new RouteFailure(503,
      'The capture completed, but the credited resident confirmation is temporarily unavailable. Reload this return page with the same purchase_id and paypal_order_id; do not start another payment.')
  }
  const giftStatus = intent.delivery === 'gift' ? String(credit.status ?? '') : null
  const disputeBlocked = intent.delivery === 'gift' && credit.dispute_blocked === true
  if (giftStatus !== null
    && !['pending', 'accepted', 'refused', 'frozen', 'revoked'].includes(giftStatus)) {
    throw new RouteFailure(503,
      'The capture completed, but the gift state is temporarily unavailable. Reload this return page with the same purchase_id and paypal_order_id; do not start another payment.')
  }
  return c.json({
    purchase_id: intent.purchaseId,
    resident_handle: recipient.residentHandle,
    amount_dollars: (intent.amountUnits / CITY_FEE_CREDIT_UNITS).toString(),
    delivery: intent.delivery,
    status: giftStatus ?? 'credited',
    receipt_id: credit.receipt_id,
    ...(intent.delivery === 'gift' ? { gift_id: credit.gift_id } : {}),
    ...(giftStatus === 'frozen' ? {
      blocked_reason: 'A payment dispute is open on the purchase that funded this gift. It cannot be accepted or redirected while frozen.',
    } : {}),
    ...(giftStatus === 'revoked' ? {
      blocked_reason: 'The payment dispute was resolved against the city seller. This gift was permanently revoked and can never add credit.',
    } : {}),
    ...(giftStatus === 'refused' && disputeBlocked ? {
      blocked_reason: 'A payment dispute is open on the purchase that funded this refused gift. It cannot be redirected while the dispute remains open.',
    } : {}),
  })
}

async function captureOrder(
  c: Context,
  dependencies: PayPalCreditRouteDependencies,
  ready: ReadyPayPal,
): Promise<Response> {
  queryless(c)
  const purchaseId = c.req.param('purchaseId') ?? ''
  if (!PUBLIC_PURCHASE_ID.test(purchaseId)) {
    throw new RouteFailure(400, 'PayPal purchase id is invalid. No new payment was started.')
  }
  const body = await readJsonBody(c)
  if (!hasOnly(body, ['paypal_order_id'])) {
    throw new RouteFailure(400,
      'Capture needs only paypal_order_id. No new payment was started.')
  }
  const paypalOrderId = remoteIdentifier(body.paypal_order_id, 'paypal_order_id')
  await requireRateSlot(c, dependencies, null, 'capture')
  const intent = await readPayPalCreditIntent(dependencies.database, purchaseId)
  if (!intent || intent.intentKind !== 'order' || !intent.remoteOrderId) {
    throw new RouteFailure(404, 'That PayPal purchase was not found. Do not start another payment.')
  }
  if (intent.remoteOrderId !== paypalOrderId) {
    throw new RouteFailure(409,
      'The PayPal order does not match this purchase. Do not start another payment.')
  }
  if (intent.paypalEnvironment !== ready.environment) {
    throw new RouteFailure(409,
      `This purchase belongs to PayPal ${intent.paypalEnvironment}, but the city is using PayPal ${ready.environment}. Do not start another payment; ask the city owner to resolve this purchase.`)
  }
  if (intent.status === 'captured') {
    const credit = await readDeliveredPayPalOrderCredit(
      dependencies.database,
      intent.purchaseId,
    )
    if (!credit) {
      throw new RouteFailure(503,
        'The captured purchase receipt is temporarily unavailable. Reload this return page with the same purchase_id and paypal_order_id; do not start another payment.')
    }
    return await capturedOrderResponse(c, dependencies, intent, credit)
  }
  const capture = await capturePayPalCreditOrder(
    dependencies.environment ?? process.env,
    {
      orderId: intent.remoteOrderId,
      purchaseId: intent.purchaseId,
      wholeDollars: intent.amountUnits / CITY_FEE_CREDIT_UNITS,
      requestId: `paypal-order-capture:${intent.purchaseId}`,
    },
    fetcher(dependencies),
  )
  const delivered = await deliverPayPalCredit(dependencies.database, {
    intent,
    sourceKey: capture.sourceKey,
    purchaseKind: 'paypal',
    eventId: apiCaptureEventId(capture.captureId),
    eventKind: 'PAYMENT.CAPTURE.COMPLETED',
    remoteResourceId: capture.captureId,
  })
  const credit = intent.delivery === 'gift'
    ? await readDeliveredPayPalOrderCredit(dependencies.database, intent.purchaseId)
    : delivered
  if (!credit) {
    throw new RouteFailure(503,
      'The capture completed, but the gift receipt is temporarily unavailable. Reload this return page with the same purchase_id and paypal_order_id; do not start another payment.')
  }
  return await capturedOrderResponse(c, dependencies, intent, credit)
}

async function handleWebhook(
  c: Context,
  dependencies: PayPalCreditRouteDependencies,
  ready: ReadyPayPal,
): Promise<Response> {
  queryless(c)
  // Refuse an oversized declaration before spending a rate slot on it.
  assertDeclaredBodyFits(c, MAX_WEBHOOK_BODY_BYTES)
  await requireRateSlot(c, dependencies, null, 'webhook')
  const rawBody = await readBoundedBody(c, MAX_WEBHOOK_BODY_BYTES)
  const outcome = await applyVerifiedPayPalWebhook(rawBody, c.req.raw.headers, {
    database: dependencies.database,
    environment: dependencies.environment ?? process.env,
    paypalEnvironment: ready.environment,
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
  })
  return c.json({ received: true, outcome })
}

/** Mount dormant PayPal credit APIs; callers mount the human /buy page separately. */
export function mountPayPalCreditRoutes(
  app: Hono,
  dependencies: PayPalCreditRouteDependencies,
): void {
  app.get(`${PAYPAL_ROUTE_PATH}/residents/:number`, async c => {
    const ready = routeReadiness(c, dependencies, 'lookup')
    if (isResponse(ready)) return ready
    try {
      queryless(c)
      await requireRateSlot(c, dependencies, null, 'prepare')
      const number = residentNumber(c.req.param('number'))
      const recipient = await findPayPalCreditRecipient(dependencies.database, number)
      if (!recipient) throw new RouteFailure(404, 'That resident number was not found. No payment was started.')
      return c.json({
        resident_number: recipient.residentNumber,
        resident_handle: recipient.residentHandle,
      })
    } catch (error) {
      return responseFailure(c, error, 'lookup')
    }
  })

  app.post(`${PAYPAL_ROUTE_PATH}/orders`, async c => {
    const ready = routeReadiness(c, dependencies, 'order')
    if (isResponse(ready)) return ready
    try {
      return await createOrder(c, dependencies, ready)
    } catch (error) {
      return responseFailure(c, error, 'order')
    }
  })

  app.post(`${PAYPAL_ROUTE_PATH}/orders/:purchaseId/capture`, async c => {
    const ready = routeReadiness(c, dependencies, 'capture')
    if (isResponse(ready)) return ready
    try {
      return await captureOrder(c, dependencies, ready)
    } catch (error) {
      return responseFailure(c, error, 'capture')
    }
  })

  app.post(`${PAYPAL_ROUTE_PATH}/allowances`, async c => {
    const ready = routeReadiness(c, dependencies, 'allowance')
    if (isResponse(ready)) return ready
    try {
      return await createAllowance(c, dependencies, ready)
    } catch (error) {
      return responseFailure(c, error, 'allowance')
    }
  })

  app.post(`${PAYPAL_ROUTE_PATH}/webhook`, async c => {
    const ready = routeReadiness(c, dependencies, 'webhook')
    if (isResponse(ready)) return ready
    try {
      return await handleWebhook(c, dependencies, ready)
    } catch (error) {
      return responseFailure(c, error, 'webhook')
    }
  })
}
