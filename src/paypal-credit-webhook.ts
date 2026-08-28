import { CITY_FEE_CREDIT_UNITS } from './city-credit.ts'
import { deliverPayPalCredit } from './paypal-credit-delivery.ts'
import {
  PayPalDisputeParseError,
  applyPayPalCreditDispute,
  parsePayPalDisputeEvent,
  type PayPalDisputeApplicationOutcome,
} from './paypal-credit-dispute.ts'
import {
  readPayPalIntentByOrder,
  readPayPalIntentBySubscription,
  recordPayPalCreditEvent,
  type PayPalCreditStoreDatabase,
} from './paypal-credit-store.ts'
import {
  PayPalWebhookSignatureError,
  parsePayPalRenewal,
  verifyPayPalWebhook,
  type PayPalEnvironment,
} from './paypal-credit.ts'
import { parseCreditDollars } from './prepaid-credit.ts'

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u
const EVENT_KIND = /^[A-Z][A-Z0-9._-]{2,127}$/u

type JsonRecord = Record<string, unknown>
type PayPalEnvironmentName = 'sandbox' | 'live'

export class PayPalWebhookApplicationError extends Error {
  readonly status: 400 | 401 | 503

  constructor(status: 400 | 401 | 503, message: string) {
    super(message)
    this.name = 'PayPalWebhookApplicationError'
    this.status = status
  }
}

export interface PayPalWebhookApplicationDependencies {
  database: PayPalCreditStoreDatabase
  environment: PayPalEnvironment
  paypalEnvironment: PayPalEnvironmentName
  fetcher?: typeof fetch
}

type CaptureEvent = Readonly<{
  eventId: string
  captureId: string
  orderId: string
  sourceKey: string
  amountUnits: bigint
}>

function badEvent(message: string): never {
  throw new PayPalWebhookApplicationError(400, message)
}

function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    badEvent(`${label} is invalid.`)
  }
  return value as JsonRecord
}

function webhookEventIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !EVENT_ID.test(value)) {
    badEvent(`${label} is invalid.`)
  }
  return value
}

function webhookResourceIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) {
    badEvent(`${label} is invalid.`)
  }
  return value
}

function parseCaptureEvent(value: unknown): CaptureEvent | null {
  const event = object(value, 'PayPal webhook event')
  if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return null
  const resource = object(event.resource, 'PayPal capture event resource')
  if (resource.status !== 'COMPLETED' || resource.final_capture !== true) {
    badEvent('PayPal capture event is not a completed final capture.')
  }
  const amount = object(resource.amount, 'PayPal capture event amount')
  if (amount.currency_code !== 'USD' || typeof amount.value !== 'string') {
    badEvent('PayPal capture event currency is invalid.')
  }
  const match = /^([1-9][0-9]{0,4})\.00$/u.exec(amount.value)
  if (!match?.[1]) badEvent('PayPal capture event amount is not exact whole dollars.')
  const related = object(
    object(resource.supplementary_data, 'PayPal capture supplementary data').related_ids,
    'PayPal capture related ids',
  )
  const captureId = webhookResourceIdentifier(resource.id, 'PayPal capture id')
  return Object.freeze({
    eventId: webhookEventIdentifier(event.id, 'PayPal webhook event id'),
    captureId,
    orderId: webhookResourceIdentifier(related.order_id, 'PayPal capture order id'),
    sourceKey: `paypal:capture:${captureId}`,
    amountUnits: parseCreditDollars(match[1]),
  })
}

function parseRawEvent(rawBody: Buffer): unknown {
  const text = rawBody.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(rawBody)) {
    badEvent('PayPal webhook body is invalid UTF-8.')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    badEvent('PayPal webhook body is invalid JSON.')
  }
}

async function applyCaptureEvent(
  dependencies: PayPalWebhookApplicationDependencies,
  capture: CaptureEvent,
): Promise<void> {
  const intent = await readPayPalIntentByOrder(dependencies.database, capture.orderId)
  if (
    !intent
    || intent.intentKind !== 'order'
    || intent.paypalEnvironment !== dependencies.paypalEnvironment
    || intent.amountUnits !== capture.amountUnits
  ) {
    throw new PayPalWebhookApplicationError(
      503,
      'PayPal capture terms are not ready; PayPal should retry this event.',
    )
  }
  await deliverPayPalCredit(dependencies.database, {
    intent,
    sourceKey: capture.sourceKey,
    purchaseKind: 'paypal',
    eventId: capture.eventId,
    eventKind: 'PAYMENT.CAPTURE.COMPLETED',
    remoteResourceId: capture.captureId,
  })
}

async function applyRenewalEvent(
  dependencies: PayPalWebhookApplicationDependencies,
  renewal: NonNullable<ReturnType<typeof parsePayPalRenewal>>,
): Promise<void> {
  const intent = await readPayPalIntentBySubscription(
    dependencies.database,
    renewal.subscriptionId,
  )
  if (
    !intent
    || intent.intentKind !== 'allowance'
    || intent.delivery !== 'self'
    || intent.paypalEnvironment !== dependencies.paypalEnvironment
    || intent.amountUnits.toString() !== renewal.creditUnits
  ) {
    throw new PayPalWebhookApplicationError(
      503,
      'PayPal allowance terms are not ready; PayPal should retry this event.',
    )
  }
  if (intent.amountUnits % CITY_FEE_CREDIT_UNITS !== 0n) {
    badEvent('Stored PayPal allowance amount is invalid.')
  }
  await deliverPayPalCredit(dependencies.database, {
    intent,
    sourceKey: renewal.sourceKey,
    purchaseKind: 'allowance',
    eventId: renewal.eventId,
    eventKind: 'PAYMENT.SALE.COMPLETED',
    remoteResourceId: renewal.saleId,
  })
}

async function recordIgnoredEvent(
  dependencies: PayPalWebhookApplicationDependencies,
  value: unknown,
): Promise<void> {
  const event = object(value, 'PayPal webhook event')
  const eventId = webhookEventIdentifier(event.id, 'PayPal webhook event id')
  const eventKind = event.event_type
  if (typeof eventKind !== 'string' || !EVENT_KIND.test(eventKind)) {
    badEvent('PayPal webhook event kind is invalid.')
  }
  const resource = event.resource && typeof event.resource === 'object' && !Array.isArray(event.resource)
    ? event.resource as JsonRecord
    : null
  const resourceId = resource?.id == null
    ? null
    : webhookResourceIdentifier(resource.id, 'PayPal webhook resource id')
  await recordPayPalCreditEvent(dependencies.database, {
    eventId,
    eventKind,
    remoteResourceId: resourceId,
    sourceKey: null,
    outcome: 'ignored',
  })
}

export async function applyVerifiedPayPalWebhook(
  rawBody: Buffer,
  headers: Headers,
  dependencies: PayPalWebhookApplicationDependencies,
): Promise<'credited' | 'ignored' | PayPalDisputeApplicationOutcome> {
  let verified: boolean
  try {
    verified = await verifyPayPalWebhook(
      dependencies.environment,
      { rawBody, headers },
      dependencies.fetcher ?? fetch,
    )
  } catch (error) {
    if (error instanceof PayPalWebhookSignatureError) {
      throw new PayPalWebhookApplicationError(
        401,
        'PayPal webhook signature was not verified.',
      )
    }
    throw error
  }
  if (!verified) {
    throw new PayPalWebhookApplicationError(401, 'PayPal webhook signature was not verified.')
  }

  // Only now, after PayPal verifies the untouched bytes, is the event decoded.
  const event = parseRawEvent(rawBody)
  let dispute: ReturnType<typeof parsePayPalDisputeEvent>
  try {
    dispute = parsePayPalDisputeEvent(event)
  } catch (error) {
    if (error instanceof PayPalDisputeParseError) badEvent(error.message)
    throw error
  }
  if (dispute) {
    const applied = await applyPayPalCreditDispute(dependencies.database, dispute)
    return applied.applicationOutcome
  }
  const capture = parseCaptureEvent(event)
  if (capture) {
    await applyCaptureEvent(dependencies, capture)
    return 'credited'
  }
  let renewal: ReturnType<typeof parsePayPalRenewal>
  try {
    renewal = parsePayPalRenewal(event)
  } catch {
    badEvent('PayPal renewal event terms are invalid.')
  }
  if (renewal) {
    await applyRenewalEvent(dependencies, renewal)
    return 'credited'
  }
  await recordIgnoredEvent(dependencies, event)
  return 'ignored'
}
