export const PAYPAL_UNAVAILABLE_MESSAGE =
  'PayPal credit purchases are unavailable because the owner has not configured PayPal yet'

const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com'
const LIVE_BASE_URL = 'https://api-m.paypal.com'
const MAX_PAYPAL_RESPONSE_BYTES = 1_048_576
const MAX_PAYPAL_WEBHOOK_BYTES = 1_048_576
const PAYPAL_TIMEOUT_MS = 8_000
const CREDIT_UNITS_PER_DOLLAR = 1_000_000n
const MAX_WHOLE_DOLLARS = BigInt('99999999999999999999999999999')
const CONFIGURED_VALUE = /^[\x21-\x7e]{1,4096}$/u
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u
const RESOURCE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,255}$/u
const REQUEST_IDENTIFIER = /^[A-Za-z0-9._:-]{8,108}$/u
const PAYPAL_CERTIFICATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const PAYPAL_WEBHOOK_ALGORITHM = /^[A-Za-z0-9]+$/u
const PAYPAL_WEBHOOK_TRANSMISSION = /^(?!\d+$)\w+\S+$/u
const PAYPAL_WEBHOOK_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):([0-5]\d|60)(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/u

export class PayPalWebhookSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayPalWebhookSignatureError'
  }
}

export type PayPalEnvironment = Readonly<Record<string, string | undefined>>

export type PayPalReadiness =
  | Readonly<{
      ready: false
      status: 503
      error: typeof PAYPAL_UNAVAILABLE_MESSAGE
    }>
  | Readonly<{
      ready: true
      environment: 'sandbox' | 'live'
      baseUrl: typeof SANDBOX_BASE_URL | typeof LIVE_BASE_URL
    }>

type PayPalConfiguration = Readonly<{
  environment: 'sandbox' | 'live'
  baseUrl: typeof SANDBOX_BASE_URL | typeof LIVE_BASE_URL
  clientId: string
  clientSecret: string
  webhookId: string
}>

export type PayPalAccessToken = Readonly<{
  accessToken: string
  expiresInSeconds: number
}>

export type PayPalOrderInput = Readonly<{
  purchaseId: string
  wholeDollars: bigint
  requestId: string
  returnUrl: string
  cancelUrl: string
}>

export type PayPalCaptureInput = Readonly<{
  orderId: string
  purchaseId: string
  wholeDollars: bigint
  requestId: string
}>

export type PayPalWebhookInput = Readonly<{
  rawBody: Buffer
  headers: Headers
}>

export type WeeklyAllowancePlanInput = Readonly<{
  productId: string
  requestId: string
}>

export type WeeklyAllowanceProductInput = Readonly<{
  requestId: string
}>

export type WeeklyAllowanceSubscriptionInput = Readonly<{
  planId: string
  allowanceId: string
  wholeDollars: bigint
  requestId: string
  returnUrl: string
  cancelUrl: string
}>

export type PayPalRenewal = Readonly<{
  eventId: string
  saleId: string
  subscriptionId: string
  sourceKey: string
  currencyCode: 'USD'
  amountValue: string
  creditUnits: string
}>

function configuredValue(value: string | undefined): value is string {
  return value !== undefined && CONFIGURED_VALUE.test(value)
}

function readConfiguration(environment: PayPalEnvironment): PayPalConfiguration | null {
  const clientId = environment.PAYPAL_CLIENT_ID
  const clientSecret = environment.PAYPAL_CLIENT_SECRET
  const webhookId = environment.PAYPAL_WEBHOOK_ID
  const paypalEnvironment = environment.PAYPAL_ENV
  if (
    !configuredValue(clientId)
    || !configuredValue(clientSecret)
    || !configuredValue(webhookId)
    || (paypalEnvironment !== 'sandbox' && paypalEnvironment !== 'live')
  ) return null

  return Object.freeze({
    environment: paypalEnvironment,
    baseUrl: paypalEnvironment === 'sandbox' ? SANDBOX_BASE_URL : LIVE_BASE_URL,
    clientId,
    clientSecret,
    webhookId,
  })
}

export function paypalReadiness(
  environment: PayPalEnvironment = process.env,
): PayPalReadiness {
  const configuration = readConfiguration(environment)
  if (!configuration) {
    return Object.freeze({
      ready: false,
      status: 503,
      error: PAYPAL_UNAVAILABLE_MESSAGE,
    })
  }
  return Object.freeze({
    ready: true,
    environment: configuration.environment,
    baseUrl: configuration.baseUrl,
  })
}

function requiredConfiguration(environment: PayPalEnvironment): PayPalConfiguration {
  const configuration = readConfiguration(environment)
  if (!configuration) throw new Error(PAYPAL_UNAVAILABLE_MESSAGE)
  return configuration
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} was rejected because it does not match the required PayPal value; retry with the exact value returned by PayPal`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} was rejected because it must be a JSON array; retry with the array returned by PayPal`)
  }
  return value
}

function text(value: unknown, label: string, maximum = 4_096): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(`${label} was rejected because it must be non-empty safe text within ${maximum} UTF-8 bytes; retry with the exact text returned by PayPal`)
  return value
}

function identifier(value: unknown, label: string): string {
  const parsed = text(value, label, 128)
  if (!IDENTIFIER.test(parsed)) {
    throw new Error(`${label} was rejected because it does not match the required PayPal value; retry with the exact value returned by PayPal`)
  }
  return parsed
}

function resourceIdentifier(value: unknown, label: string): string {
  const parsed = text(value, label, 255)
  if (!RESOURCE_IDENTIFIER.test(parsed)) {
    throw new Error(`${label} was rejected because it does not match the required PayPal value; retry with the exact value returned by PayPal`)
  }
  return parsed
}

/** Rebuild a bound PayPal approval link without another provider request. */
export function paypalHostedApprovalUrl(
  environment: 'sandbox' | 'live',
  kind: 'order' | 'subscription',
  remoteIdInput: unknown,
): string {
  if (environment !== 'sandbox' && environment !== 'live') {
    throw new Error('PayPal environment is invalid')
  }
  if (kind !== 'order' && kind !== 'subscription') {
    throw new Error('PayPal approval kind is invalid')
  }
  const remoteId = identifier(remoteIdInput, 'PayPal remote id')
  const origin = environment === 'sandbox'
    ? 'https://www.sandbox.paypal.com'
    : 'https://www.paypal.com'
  const url = new URL(
    kind === 'order' ? '/checkoutnow' : '/webapps/billing/subscriptions',
    origin,
  )
  url.searchParams.set(kind === 'order' ? 'token' : 'ba_token', remoteId)
  return url.href
}

function requestIdentifier(value: unknown): string {
  const parsed = text(value, 'PayPal request id', 108)
  if (!REQUEST_IDENTIFIER.test(parsed)) throw new Error('PayPal request id is invalid')
  return parsed
}

function exactHttpsUrl(value: unknown, label: string): string {
  const parsedText = text(value, label, 4_096)
  let parsed: URL
  try {
    parsed = new URL(parsedText)
  } catch {
    throw new Error(`${label} was rejected because it must be an absolute HTTPS URL; retry with the exact HTTPS URL returned by PayPal`)
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hash
  ) throw new Error(`${label} was rejected because it must be an absolute HTTPS URL without credentials or a fragment; retry with the exact HTTPS URL returned by PayPal`)
  return parsed.href
}

function paypalCertificateUrl(
  value: unknown,
  paypalEnvironment: 'sandbox' | 'live',
): string {
  const label = 'PayPal certificate URL'
  let parsedText: string
  try {
    parsedText = text(value, label, 500)
  } catch {
    throw new PayPalWebhookSignatureError(`${label} was rejected because it is not PayPal's signed certificate URL; retry with the exact header value sent by PayPal`)
  }
  let parsed: URL
  try {
    parsed = new URL(parsedText)
  } catch {
    throw new PayPalWebhookSignatureError(`${label} was rejected because it is not PayPal's signed certificate URL; retry with the exact header value sent by PayPal`)
  }
  const expectedHost = paypalEnvironment === 'sandbox'
    ? 'api.sandbox.paypal.com'
    : 'api.paypal.com'
  const pathPrefix = '/v1/notifications/certs/'
  const certificateId = parsed.pathname.startsWith(pathPrefix)
    ? parsed.pathname.slice(pathPrefix.length)
    : ''
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== expectedHost
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !PAYPAL_CERTIFICATE_ID.test(certificateId)
  ) throw new PayPalWebhookSignatureError(`${label} was rejected because it is not PayPal's signed certificate URL; retry with the exact header value sent by PayPal`)
  return parsed.href
}

function wholeDollarTerms(value: bigint): Readonly<{
  wholeDollars: string
  amountValue: string
  creditUnits: string
}> {
  if (typeof value !== 'bigint' || value <= 0n || value > MAX_WHOLE_DOLLARS) {
    throw new Error('PayPal amount must be positive whole dollars')
  }
  const wholeDollars = value.toString()
  return Object.freeze({
    wholeDollars,
    amountValue: `${wholeDollars}.00`,
    creditUnits: (value * CREDIT_UNITS_PER_DOLLAR).toString(),
  })
}

function exactWholeDollarAmount(value: unknown, label: string): Readonly<{
  amountValue: string
  creditUnits: string
}> {
  const amountValue = text(value, label, 32)
  const match = /^(0|[1-9]\d*)\.00$/u.exec(amountValue)
  if (!match?.[1]) throw new Error(`${label} must be exact whole dollars`)
  const amount = BigInt(match[1])
  if (amount <= 0n || amount > MAX_WHOLE_DOLLARS) {
    throw new Error(`${label} must be exact whole dollars`)
  }
  return Object.freeze({
    amountValue,
    creditUnits: (amount * CREDIT_UNITS_PER_DOLLAR).toString(),
  })
}

async function send(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(PAYPAL_TIMEOUT_MS),
    })
  } catch {
    throw new Error(`${label} is unavailable; retry this same PayPal request later and do not approve or pay again`)
  }
}

async function readJsonObject(response: Response, label: string): Promise<Record<string, unknown>> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && (!/^\d+$/u.test(declaredLength)
    || Number(declaredLength) > MAX_PAYPAL_RESPONSE_BYTES)) {
    throw new Error(`${label} response is invalid`)
  }
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > MAX_PAYPAL_RESPONSE_BYTES) {
    throw new Error(`${label} response is invalid`)
  }
  if (!response.ok) throw new Error(`${label} failed with status ${response.status}`)
  let decoded: unknown
  try {
    decoded = JSON.parse(body)
  } catch {
    throw new Error(`${label} response is invalid`)
  }
  return object(decoded, `${label} response`)
}

async function accessToken(
  configuration: PayPalConfiguration,
  fetcher: typeof fetch,
): Promise<PayPalAccessToken> {
  const authorization = Buffer.from(
    `${configuration.clientId}:${configuration.clientSecret}`,
    'utf8',
  ).toString('base64')
  const response = await send(fetcher, `${configuration.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${authorization}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  }, 'PayPal authentication')
  const decoded = await readJsonObject(response, 'PayPal authentication')
  if (decoded.token_type !== 'Bearer') {
    throw new Error('PayPal authentication response is invalid')
  }
  const accessTokenValue = text(decoded.access_token, 'PayPal access token', 8_192)
  const expiresIn = decoded.expires_in
  if (!Number.isInteger(expiresIn) || Number(expiresIn) <= 0) {
    throw new Error('PayPal authentication response is invalid')
  }
  return Object.freeze({
    accessToken: accessTokenValue,
    expiresInSeconds: Number(expiresIn),
  })
}

export async function requestPayPalAccessToken(
  environment: PayPalEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<PayPalAccessToken> {
  return await accessToken(requiredConfiguration(environment), fetcher)
}

async function authenticatedRequest(
  configuration: PayPalConfiguration,
  requestId: string,
  path: string,
  body: unknown,
  label: string,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const token = await accessToken(configuration, fetcher)
  const response = await send(fetcher, `${configuration.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token.accessToken}`,
      'content-type': 'application/json',
      'paypal-request-id': requestIdentifier(requestId),
      prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  }, label)
  return await readJsonObject(response, label)
}

function approvalUrl(
  response: Record<string, unknown>,
  environment: PayPalConfiguration['environment'],
): string {
  const links = array(response.links, 'PayPal approval links')
  for (const candidate of links) {
    const link = object(candidate, 'PayPal approval link')
    if (link.rel === 'payer-action' || link.rel === 'approve') {
      if (link.method !== undefined && link.method !== 'GET') {
        throw new Error('PayPal approval URL is invalid')
      }
      const href = exactHttpsUrl(link.href, 'PayPal approval URL')
      const expectedHost = environment === 'sandbox'
        ? 'www.sandbox.paypal.com'
        : 'www.paypal.com'
      if (new URL(href).hostname !== expectedHost) {
        throw new Error('PayPal approval URL is invalid')
      }
      return href
    }
  }
  throw new Error('PayPal approval URL is unavailable')
}

export async function createPayPalCreditOrder(
  environment: PayPalEnvironment,
  input: PayPalOrderInput,
  fetcher: typeof fetch = fetch,
): Promise<Readonly<{ orderId: string; approvalUrl: string }>> {
  const configuration = requiredConfiguration(environment)
  const purchaseId = identifier(input.purchaseId, 'PayPal purchase id')
  const terms = wholeDollarTerms(input.wholeDollars)
  const decoded = await authenticatedRequest(configuration, input.requestId,
    '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: purchaseId,
        custom_id: purchaseId,
        description: '1F3D9 city credit',
        amount: { currency_code: 'USD', value: terms.amountValue },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: exactHttpsUrl(input.returnUrl, 'PayPal return URL'),
            cancel_url: exactHttpsUrl(input.cancelUrl, 'PayPal cancel URL'),
          },
        },
      },
    }, 'PayPal order creation', fetcher)
  if (decoded.status !== 'CREATED' && decoded.status !== 'PAYER_ACTION_REQUIRED') {
    throw new Error('PayPal order was not created')
  }
  return Object.freeze({
    orderId: identifier(decoded.id, 'PayPal order id'),
    approvalUrl: approvalUrl(decoded, configuration.environment),
  })
}

function matchingCapture(
  response: Record<string, unknown>,
  expectedOrderId: string,
  expectedPurchaseId: string,
): Record<string, unknown> {
  if (identifier(response.id, 'PayPal order id') !== expectedOrderId) {
    throw new Error('PayPal capture order changed')
  }
  if (response.status !== 'COMPLETED') throw new Error('PayPal order capture is not completed')
  const purchaseUnits = array(response.purchase_units, 'PayPal purchase units')
  const units = purchaseUnits
    .map(candidate => object(candidate, 'PayPal purchase unit'))
  if (units.length !== 1 || units[0]?.reference_id !== expectedPurchaseId) {
    throw new Error('PayPal capture purchase changed')
  }
  const unit = units[0]
  const payments = object(unit.payments, 'PayPal capture payments')
  const captures = array(payments.captures, 'PayPal captures')
    .map(candidate => object(candidate, 'PayPal capture'))
  if (captures.length !== 1) throw new Error('PayPal final capture is unavailable')
  return captures[0]!
}

export async function capturePayPalCreditOrder(
  environment: PayPalEnvironment,
  input: PayPalCaptureInput,
  fetcher: typeof fetch = fetch,
): Promise<Readonly<{
  orderId: string
  captureId: string
  sourceKey: string
  creditUnits: string
}>> {
  const configuration = requiredConfiguration(environment)
  const orderId = identifier(input.orderId, 'PayPal order id')
  const purchaseId = identifier(input.purchaseId, 'PayPal purchase id')
  const terms = wholeDollarTerms(input.wholeDollars)
  const decoded = await authenticatedRequest(configuration, input.requestId,
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {},
    'PayPal order capture', fetcher)
  const capture = matchingCapture(decoded, orderId, purchaseId)
  if (capture.status !== 'COMPLETED') throw new Error('PayPal capture is not completed')
  if (capture.final_capture !== true) throw new Error('PayPal capture is not final')
  const amount = object(capture.amount, 'PayPal capture amount')
  if (amount.currency_code !== 'USD' || amount.value !== terms.amountValue) {
    throw new Error('PayPal capture amount changed from the accepted gross terms')
  }
  const captureId = resourceIdentifier(capture.id, 'PayPal capture id')
  return Object.freeze({
    orderId,
    captureId,
    sourceKey: `paypal:capture:${captureId}`,
    creditUnits: terms.creditUnits,
  })
}

function invalidWebhookSignatureField(label: string): never {
  throw new PayPalWebhookSignatureError(`${label} was rejected because it does not match a required PayPal signature header; retry with the exact header value sent by PayPal`)
}

function webhookHeader(
  headers: Headers,
  name: string,
  maximum: number,
  pattern?: RegExp,
): string {
  const label = `PayPal ${name} header`
  let parsed: string
  try {
    parsed = text(headers.get(name), label, maximum)
  } catch {
    invalidWebhookSignatureField(label)
  }
  if (pattern && !pattern.test(parsed)) invalidWebhookSignatureField(label)
  return parsed
}

function webhookTransmissionTime(headers: Headers): string {
  const name = 'paypal-transmission-time'
  const label = `PayPal ${name} header`
  const parsed = webhookHeader(headers, name, 100, PAYPAL_WEBHOOK_TIME)
  const match = PAYPAL_WEBHOOK_TIME.exec(parsed)
  if (!match) invalidWebhookSignatureField(label)
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (zone!.toUpperCase() !== 'Z') {
    const offsetHour = Number(zone!.slice(1, 3))
    const offsetMinute = Number(zone!.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) invalidWebhookSignatureField(label)
  }
  const leapSecond = second === 60
  const wall = new Date(0)
  wall.setUTCFullYear(year, month - 1, day)
  wall.setUTCHours(hour, minute, leapSecond ? 59 : second, 0)
  if (
    wall.getUTCFullYear() !== year
    || wall.getUTCMonth() !== month - 1
    || wall.getUTCDate() !== day
    || wall.getUTCHours() !== hour
    || wall.getUTCMinutes() !== minute
    || wall.getUTCSeconds() !== (leapSecond ? 59 : second)
  ) invalidWebhookSignatureField(label)
  return parsed
}

function rawWebhookJson(rawBody: Buffer): string {
  if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_PAYPAL_WEBHOOK_BYTES) {
    throw new Error('PayPal webhook body is invalid')
  }
  const rawText = rawBody.toString('utf8')
  if (!Buffer.from(rawText, 'utf8').equals(rawBody)) {
    throw new Error('PayPal webhook body is invalid')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(rawText)
  } catch {
    throw new Error('PayPal webhook body is invalid')
  }
  object(decoded, 'PayPal webhook body')
  return rawText
}

export async function verifyPayPalWebhook(
  environment: PayPalEnvironment,
  input: PayPalWebhookInput,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const configuration = requiredConfiguration(environment)
  const rawEvent = rawWebhookJson(input.rawBody)
  const fields = {
    auth_algo: webhookHeader(
      input.headers,
      'paypal-auth-algo',
      100,
      PAYPAL_WEBHOOK_ALGORITHM,
    ),
    cert_url: paypalCertificateUrl(
      webhookHeader(input.headers, 'paypal-cert-url', 500),
      configuration.environment,
    ),
    transmission_id: webhookHeader(
      input.headers,
      'paypal-transmission-id',
      50,
      PAYPAL_WEBHOOK_TRANSMISSION,
    ),
    transmission_sig: webhookHeader(
      input.headers,
      'paypal-transmission-sig',
      500,
      PAYPAL_WEBHOOK_TRANSMISSION,
    ),
    transmission_time: webhookTransmissionTime(input.headers),
    webhook_id: configuration.webhookId,
  }
  const serializedFields = JSON.stringify(fields)
  const verificationBody = `${serializedFields.slice(0, -1)},"webhook_event":${rawEvent}}`
  const token = await accessToken(configuration, fetcher)
  const response = await send(fetcher,
    `${configuration.baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        'content-type': 'application/json',
      },
      body: verificationBody,
    }, 'PayPal webhook verification')
  const decoded = await readJsonObject(response, 'PayPal webhook verification')
  if (decoded.verification_status === 'SUCCESS') return true
  if (decoded.verification_status === 'FAILURE') return false
  throw new Error('PayPal webhook verification response is invalid')
}

export async function createWeeklyAllowancePlan(
  environment: PayPalEnvironment,
  input: WeeklyAllowancePlanInput,
  fetcher: typeof fetch = fetch,
): Promise<Readonly<{ planId: string }>> {
  const configuration = requiredConfiguration(environment)
  const productId = identifier(input.productId, 'PayPal product id')
  const decoded = await authenticatedRequest(configuration, input.requestId,
    '/v1/billing/plans', {
      product_id: productId,
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
    }, 'PayPal allowance plan creation', fetcher)
  if (decoded.status !== 'ACTIVE') throw new Error('PayPal allowance plan is not active')
  return Object.freeze({ planId: identifier(decoded.id, 'PayPal plan id') })
}

export async function createWeeklyAllowanceProduct(
  environment: PayPalEnvironment,
  input: WeeklyAllowanceProductInput,
  fetcher: typeof fetch = fetch,
): Promise<Readonly<{ productId: string }>> {
  const configuration = requiredConfiguration(environment)
  const decoded = await authenticatedRequest(configuration, input.requestId,
    '/v1/catalogs/products', {
      name: '1F3D9 weekly city-credit allowance',
      description: 'Prepaid fee credit delivered after each completed weekly PayPal payment.',
      type: 'SERVICE',
      category: 'SOFTWARE',
    }, 'PayPal allowance product creation', fetcher)
  return Object.freeze({ productId: identifier(decoded.id, 'PayPal product id') })
}

export async function createWeeklyAllowanceSubscription(
  environment: PayPalEnvironment,
  input: WeeklyAllowanceSubscriptionInput,
  fetcher: typeof fetch = fetch,
): Promise<Readonly<{ subscriptionId: string; approvalUrl: string }>> {
  const configuration = requiredConfiguration(environment)
  const terms = wholeDollarTerms(input.wholeDollars)
  const decoded = await authenticatedRequest(configuration, input.requestId,
    '/v1/billing/subscriptions', {
      plan_id: identifier(input.planId, 'PayPal plan id'),
      quantity: terms.wholeDollars,
      custom_id: identifier(input.allowanceId, 'PayPal allowance id'),
      application_context: {
        user_action: 'SUBSCRIBE_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: exactHttpsUrl(input.returnUrl, 'PayPal subscription return URL'),
        cancel_url: exactHttpsUrl(input.cancelUrl, 'PayPal subscription cancel URL'),
      },
    }, 'PayPal allowance subscription creation', fetcher)
  if (decoded.status !== 'APPROVAL_PENDING') {
    throw new Error('PayPal allowance subscription is not awaiting approval')
  }
  return Object.freeze({
    subscriptionId: identifier(decoded.id, 'PayPal subscription id'),
    approvalUrl: approvalUrl(decoded, configuration.environment),
  })
}

function renewalAmount(resource: Record<string, unknown>): Readonly<{
  currencyCode: unknown
  amountValue: unknown
}> {
  if (resource.amount !== undefined) {
    const amount = object(resource.amount, 'PayPal renewal amount')
    return Object.freeze({ currencyCode: amount.currency, amountValue: amount.total })
  }
  const breakdown = object(resource.amount_with_breakdown, 'PayPal renewal amount')
  const gross = object(breakdown.gross_amount, 'PayPal renewal gross amount')
  return Object.freeze({ currencyCode: gross.currency_code, amountValue: gross.value })
}

export function parsePayPalRenewal(value: unknown): PayPalRenewal | null {
  const event = object(value, 'PayPal webhook event')
  if (event.event_type !== 'PAYMENT.SALE.COMPLETED') return null
  const resource = object(event.resource, 'PayPal renewal resource')
  const state = text(resource.state ?? resource.status, 'PayPal renewal status', 32)
  if (state.toLowerCase() !== 'completed') throw new Error('PayPal renewal is not completed')
  const amount = renewalAmount(resource)
  if (amount.currencyCode !== 'USD') throw new Error('PayPal renewal currency is invalid')
  const exactAmount = exactWholeDollarAmount(amount.amountValue, 'PayPal renewal amount')
  const eventId = identifier(event.id, 'PayPal webhook event id')
  const saleId = resourceIdentifier(resource.id, 'PayPal sale id')
  const subscriptionId = identifier(
    resource.billing_agreement_id,
    'PayPal subscription id',
  )
  return Object.freeze({
    eventId,
    saleId,
    subscriptionId,
    sourceKey: `paypal:sale:${saleId}`,
    currencyCode: 'USD',
    amountValue: exactAmount.amountValue,
    creditUnits: exactAmount.creditUnits,
  })
}
