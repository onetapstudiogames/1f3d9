import { randomUUID } from 'node:crypto'
import {
  CITY_FEE_CREDIT_UNITS,
  formatUsdcUnits,
  parseCityCreditRequestId,
  parseCityCreditSourceKey,
} from './city-credit.ts'
import {
  createGiftClaimToken,
  hashGiftClaimToken,
  parseGiftClaimToken,
} from './prepaid-credit.ts'

const MAX_RESIDENT_ID = 2_147_483_647
const MAX_CREDIT_UNITS = 10_000n * CITY_FEE_CREDIT_UNITS
const PUBLIC_ID = /^city_paypal_[0-9a-f]{32}$/u
const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const REMOTE_RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u
const HASH = /^[0-9a-f]{64}$/u
const SAFE_EVENT_KIND = /^[A-Z][A-Z0-9._-]{2,127}$/u
const GIFT_PUBLIC_ID = /^city_gift_[0-9a-f]{32}$/u
const MAX_BIGINT_ID = 9_223_372_036_854_775_807n

type QueryRow = Record<string, unknown>
export interface PayPalCreditStoreDatabase {
  query(text: string, params?: readonly unknown[]): Promise<readonly QueryRow[]>
}

export type PayPalIntentKind = 'order' | 'allowance'
export type PayPalDelivery = 'self' | 'gift'
export type StoredPayPalIntentStatus =
  | 'created'
  | 'approval_pending'
  | 'captured'
  | 'active'

export type StoredPayPalIntent = Readonly<{
  purchaseId: string
  requestId: string
  intentKind: PayPalIntentKind
  delivery: PayPalDelivery
  recipientId: number
  amountUnits: bigint
  claimTokenHash: string | null
  paypalEnvironment: 'sandbox' | 'live'
  remoteOrderId: string | null
  remoteSubscriptionId: string | null
  status: StoredPayPalIntentStatus
}>

export class PayPalCreditStoreConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayPalCreditStoreConflictError'
  }
}

function conflict(message: string): never {
  throw new PayPalCreditStoreConflictError(message)
}

function positiveResidentId(value: unknown): number {
  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)
    ? Number(value)
    : value
  if (
    typeof parsed !== 'number'
    || !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > MAX_RESIDENT_ID
  ) throw new TypeError('resident number must be a positive integer')
  return parsed
}

function safeHandle(value: unknown): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') < 1
    || Buffer.byteLength(value, 'utf8') > 64
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) throw new TypeError('resident handle is invalid')
  return value
}

function exactAmountUnits(value: unknown): bigint {
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '')
  if (!/^[1-9][0-9]*$/u.test(text)) throw new TypeError('credit amount is invalid')
  const amount = BigInt(text)
  if (
    amount < CITY_FEE_CREDIT_UNITS
    || amount > MAX_CREDIT_UNITS
    || amount % CITY_FEE_CREDIT_UNITS !== 0n
  ) throw new TypeError('credit amount must be exact whole dollars from 1 to 10000')
  return amount
}

function safeRequestId(value: unknown): string {
  let parsed: string | null
  try {
    parsed = parseCityCreditRequestId(value)
  } catch {
    throw new TypeError('PayPal purchase request_id must be a non-secret ASCII identifier of 8 to 128 characters')
  }
  if (!parsed) {
    throw new TypeError('PayPal purchase request_id must be a non-secret ASCII identifier of 8 to 128 characters')
  }
  return parsed
}

function publicId(value: unknown): string {
  const parsed = String(value ?? '')
  if (!PUBLIC_ID.test(parsed)) throw new TypeError('PayPal purchase id is invalid')
  return parsed
}

function remoteId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !REMOTE_ID.test(value)) {
    throw new TypeError(`${label} was rejected because it does not match the stored PayPal identifier format; retry with the exact identifier returned by PayPal`)
  }
  return value
}

function nullableRemoteId(value: unknown, label: string): string | null {
  return value == null ? null : remoteId(value, label)
}

function paypalResourceId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !REMOTE_RESOURCE_ID.test(value)) {
    throw new TypeError(`${label} was rejected because it does not match the stored PayPal identifier format; retry with the exact identifier returned by PayPal`)
  }
  return value
}

function environment(value: unknown): 'sandbox' | 'live' {
  if (value !== 'sandbox' && value !== 'live') throw new TypeError('PayPal environment is invalid')
  return value
}

function intentKind(value: unknown): PayPalIntentKind {
  if (value !== 'order' && value !== 'allowance') throw new TypeError('PayPal intent kind is invalid')
  return value
}

function delivery(value: unknown): PayPalDelivery {
  if (value !== 'self' && value !== 'gift') throw new TypeError('PayPal delivery is invalid')
  return value
}

function status(value: unknown): StoredPayPalIntentStatus {
  if (
    value !== 'created'
    && value !== 'approval_pending'
    && value !== 'captured'
    && value !== 'active'
  ) throw new TypeError('PayPal purchase status is invalid')
  return value
}

function nullableHash(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new TypeError('gift claim token hash is invalid')
  }
  return value
}

function bool(value: unknown): boolean {
  return value === true || value === 't'
}

function rowId(value: unknown, label: string): string {
  const text = String(value ?? '')
  if (!/^[1-9][0-9]{0,18}$/u.test(text) || BigInt(text) > MAX_BIGINT_ID) {
    throw new TypeError(`${label} was rejected because it must be a positive stored record id; retry with the id returned by the matching city record`)
  }
  return text
}

function giftPublicId(value: unknown): string {
  const text = String(value ?? '')
  if (!GIFT_PUBLIC_ID.test(text)) throw new TypeError('PayPal gift id is invalid')
  return text
}

function deliveredGiftStatus(
  value: unknown,
): 'pending' | 'accepted' | 'refused' | 'frozen' | 'revoked' {
  if (!['pending', 'accepted', 'refused', 'frozen', 'revoked'].includes(String(value))) {
    throw new TypeError('PayPal delivered gift status is invalid')
  }
  return value as ReturnType<typeof deliveredGiftStatus>
}

type PayPalCreditReceiptTerms = Readonly<{
  delivery: PayPalDelivery
  residentId: number
  amountUnits: bigint
  sourceKey: string
  purchaseKind: 'paypal' | 'allowance'
  claimTokenHash: string | null
}>

function deliveredCreditReceipt(
  row: QueryRow,
  terms: PayPalCreditReceiptTerms,
): Readonly<Record<string, unknown>> {
  const rawGiftRowId = row.gift_row_id ?? row.gift_id
  const giftRowId = rawGiftRowId == null ? null : rowId(rawGiftRowId, 'PayPal gift row id')
  if (
    positiveResidentId(Number(row.resident_id)) !== terms.residentId
    || exactAmountUnits(row.amount_units) !== terms.amountUnits
    || parseCityCreditSourceKey(row.source_key) !== terms.sourceKey
    || row.purchase_kind !== terms.purchaseKind
    || (terms.delivery === 'gift') !== (giftRowId !== null)
    || (terms.delivery === 'gift' && row.claim_token_hash !== terms.claimTokenHash)
  ) conflict('PayPal delivery receipt is bound to changed terms')

  const result: Record<string, unknown> = {
    disposition: bool(row.created) ? 'created' : 'existing',
    receipt_id: rowId(row.id, 'PayPal purchase receipt id'),
    resident_id: terms.residentId,
    amount: formatUsdcUnits(terms.amountUnits),
    amount_units: terms.amountUnits.toString(),
    purchase_kind: terms.purchaseKind,
  }
  if (terms.delivery === 'gift') {
    result.gift_id = giftPublicId(row.gift_public_id)
    result.status = deliveredGiftStatus(row.status)
    result.dispute_blocked = row.frozen_at != null
  }
  return Object.freeze(result)
}

function storedIntent(row: QueryRow): StoredPayPalIntent {
  const parsed = Object.freeze({
    purchaseId: publicId(row.public_id),
    requestId: safeRequestId(row.request_id),
    intentKind: intentKind(row.intent_kind),
    delivery: delivery(row.delivery),
    recipientId: positiveResidentId(Number(row.recipient_id)),
    amountUnits: exactAmountUnits(row.amount_units),
    claimTokenHash: nullableHash(row.claim_token_hash),
    paypalEnvironment: environment(row.paypal_environment),
    remoteOrderId: nullableRemoteId(row.remote_order_id, 'PayPal order id'),
    remoteSubscriptionId: nullableRemoteId(
      row.remote_subscription_id,
      'PayPal subscription id',
    ),
    status: status(row.status),
  })
  if ((parsed.delivery === 'gift') !== (parsed.claimTokenHash !== null)) {
    throw new TypeError('PayPal gift terms are invalid')
  }
  if (parsed.intentKind === 'allowance' && parsed.delivery !== 'self') {
    throw new TypeError('weekly allowance must be self-funded')
  }
  return parsed
}

function sameIntentTerms(
  intent: StoredPayPalIntent,
  input: Readonly<{
    requestId: string
    intentKind: PayPalIntentKind
    delivery: PayPalDelivery
    recipientId: number
    amountUnits: bigint
    paypalEnvironment: 'sandbox' | 'live'
  }>,
): boolean {
  return intent.requestId === input.requestId
    && intent.intentKind === input.intentKind
    && intent.delivery === input.delivery
    && intent.recipientId === input.recipientId
    && intent.amountUnits === input.amountUnits
    && intent.paypalEnvironment === input.paypalEnvironment
}

export async function findPayPalCreditRecipient(
  database: PayPalCreditStoreDatabase,
  residentNumberInput: unknown,
): Promise<Readonly<{ residentNumber: number; residentHandle: string }> | null> {
  const residentNumber = positiveResidentId(residentNumberInput)
  const rows = await database.query(`
    /* paypal-credit:recipient */
    SELECT id, handle FROM residents WHERE id = $1::integer LIMIT 1
  `, [residentNumber])
  const row = rows[0]
  if (!row) return null
  const storedNumber = positiveResidentId(Number(row.id))
  if (storedNumber !== residentNumber) throw new TypeError('resident confirmation changed')
  return Object.freeze({
    residentNumber: storedNumber,
    residentHandle: safeHandle(row.handle),
  })
}

export async function beginPayPalCreditIntent(
  database: PayPalCreditStoreDatabase,
  input: Readonly<{
    requestId: string
    intentKind: PayPalIntentKind
    delivery: PayPalDelivery
    recipientId: number
    amountUnits: bigint
    paypalEnvironment: 'sandbox' | 'live'
  }>,
): Promise<StoredPayPalIntent & Readonly<{
  disposition: 'created' | 'existing'
  claimToken: string | null
}>> {
  const terms = Object.freeze({
    requestId: safeRequestId(input.requestId),
    intentKind: intentKind(input.intentKind),
    delivery: delivery(input.delivery),
    recipientId: positiveResidentId(input.recipientId),
    amountUnits: exactAmountUnits(input.amountUnits),
    paypalEnvironment: environment(input.paypalEnvironment),
  })
  if (terms.intentKind === 'allowance' && terms.delivery !== 'self') {
    throw new TypeError('weekly allowance must be self-funded')
  }
  const generatedPublicId = `city_paypal_${randomUUID().replaceAll('-', '')}`
  const generatedClaimToken = terms.delivery === 'gift' ? createGiftClaimToken() : null
  const generatedClaimHash = generatedClaimToken
    ? hashGiftClaimToken(generatedClaimToken)
    : null
  const rows = await database.query(`
    /* paypal-credit:begin-intent */
    WITH inserted AS MATERIALIZED (
      INSERT INTO paypal_credit_intents (
        public_id, request_id, intent_kind, delivery, recipient_id,
        amount_units, claim_token_hash, paypal_environment, status
      )
      SELECT $1::text, $2::text, $3::text, $4::text, $5::integer,
        $6::bigint, $7::text, $8::text, 'created'
      WHERE EXISTS (SELECT 1 FROM residents WHERE id = $5::integer)
      ON CONFLICT (request_id) DO NOTHING
      RETURNING *, true AS created
    ), selected AS (
      SELECT * FROM inserted
      UNION ALL
      SELECT existing.*, false AS created
      FROM paypal_credit_intents existing
      WHERE existing.request_id = $2::text AND NOT EXISTS (SELECT 1 FROM inserted)
      LIMIT 1
    )
    SELECT * FROM selected
  `, [
    generatedPublicId,
    terms.requestId,
    terms.intentKind,
    terms.delivery,
    terms.recipientId,
    terms.amountUnits.toString(),
    generatedClaimHash,
    terms.paypalEnvironment,
  ])
  const row = rows[0]
  if (!row) conflict('resident was not found or PayPal request_id is unavailable')
  const stored = storedIntent(row)
  if (!sameIntentTerms(stored, terms)) {
    conflict('PayPal request_id is already bound to changed purchase terms')
  }
  const created = bool(row.created)
  if (created && stored.claimTokenHash !== generatedClaimHash) {
    conflict('PayPal gift claim binding changed during creation')
  }
  return Object.freeze({
    ...stored,
    disposition: created ? 'created' as const : 'existing' as const,
    claimToken: created && generatedClaimToken
      ? parseGiftClaimToken(generatedClaimToken)
      : null,
  })
}

export async function readPayPalCreditIntent(
  database: PayPalCreditStoreDatabase,
  purchaseIdInput: unknown,
): Promise<StoredPayPalIntent | null> {
  const purchaseId = publicId(purchaseIdInput)
  const rows = await database.query(`
    /* paypal-credit:read-intent */
    SELECT * FROM paypal_credit_intents WHERE public_id = $1::text LIMIT 1
  `, [purchaseId])
  return rows[0] ? storedIntent(rows[0]) : null
}

export async function readPayPalIntentByOrder(
  database: PayPalCreditStoreDatabase,
  orderIdInput: unknown,
): Promise<StoredPayPalIntent | null> {
  const orderId = remoteId(orderIdInput, 'PayPal order id')
  const rows = await database.query(`
    /* paypal-credit:read-order */
    SELECT * FROM paypal_credit_intents WHERE remote_order_id = $1::text LIMIT 1
  `, [orderId])
  return rows[0] ? storedIntent(rows[0]) : null
}

export async function readPayPalIntentBySubscription(
  database: PayPalCreditStoreDatabase,
  subscriptionIdInput: unknown,
): Promise<StoredPayPalIntent | null> {
  const subscriptionId = remoteId(subscriptionIdInput, 'PayPal subscription id')
  const rows = await database.query(`
    /* paypal-credit:read-subscription */
    SELECT * FROM paypal_credit_intents
    WHERE remote_subscription_id = $1::text LIMIT 1
  `, [subscriptionId])
  return rows[0] ? storedIntent(rows[0]) : null
}

async function attachRemote(
  database: PayPalCreditStoreDatabase,
  input: Readonly<{ purchaseId: string; remoteId: string }>,
  kind: 'order' | 'allowance',
): Promise<StoredPayPalIntent> {
  const purchaseId = publicId(input.purchaseId)
  const attachedRemoteId = remoteId(
    input.remoteId,
    kind === 'order' ? 'PayPal order id' : 'PayPal subscription id',
  )
  const remoteColumn = kind === 'order' ? 'remote_order_id' : 'remote_subscription_id'
  const rows = await database.query(`
    /* paypal-credit:attach-${kind} */
    WITH changed AS MATERIALIZED (
      UPDATE paypal_credit_intents intent
      SET ${remoteColumn} = $2::text, status = 'approval_pending',
        updated_at = clock_timestamp()
      WHERE intent.public_id = $1::text AND intent.intent_kind = $3::text
        AND (intent.${remoteColumn} IS NULL OR intent.${remoteColumn} = $2::text)
        AND intent.status IN ('created', 'approval_pending')
      RETURNING intent.*
    )
    SELECT * FROM changed
    UNION ALL
    SELECT * FROM paypal_credit_intents intent
    WHERE intent.public_id = $1::text AND NOT EXISTS (SELECT 1 FROM changed)
    LIMIT 1
  `, [purchaseId, attachedRemoteId, kind])
  const row = rows[0]
  if (!row) conflict('PayPal purchase was not found')
  const stored = storedIntent(row)
  const actualRemote = kind === 'order' ? stored.remoteOrderId : stored.remoteSubscriptionId
  if (
    stored.purchaseId !== purchaseId
    || stored.intentKind !== kind
    || actualRemote !== attachedRemoteId
    || stored.status !== 'approval_pending'
  ) conflict('PayPal remote purchase is already bound to changed terms')
  return stored
}

export async function attachPayPalOrder(
  database: PayPalCreditStoreDatabase,
  input: Readonly<{ purchaseId: string; orderId: string }>,
): Promise<Readonly<{
  purchaseId: string
  orderId: string
  status: 'approval_pending'
}>> {
  const stored = await attachRemote(database, {
    purchaseId: input.purchaseId,
    remoteId: input.orderId,
  }, 'order')
  return Object.freeze({
    purchaseId: stored.purchaseId,
    orderId: stored.remoteOrderId!,
    status: 'approval_pending' as const,
  })
}

export async function attachPayPalSubscription(
  database: PayPalCreditStoreDatabase,
  input: Readonly<{ purchaseId: string; subscriptionId: string }>,
): Promise<Readonly<{
  purchaseId: string
  subscriptionId: string
  status: 'approval_pending'
}>> {
  const stored = await attachRemote(database, {
    purchaseId: input.purchaseId,
    remoteId: input.subscriptionId,
  }, 'allowance')
  return Object.freeze({
    purchaseId: stored.purchaseId,
    subscriptionId: stored.remoteSubscriptionId!,
    status: 'approval_pending' as const,
  })
}

export async function deliverPayPalCreditAtomically(
  database: PayPalCreditStoreDatabase,
  input: Readonly<{
    intent: StoredPayPalIntent
    sourceKey: string
    purchaseKind: 'paypal' | 'allowance'
    eventId: string
    eventKind: 'PAYMENT.CAPTURE.COMPLETED' | 'PAYMENT.SALE.COMPLETED'
    remoteResourceId: string
  }>,
): Promise<Readonly<Record<string, unknown>>> {
  const purchaseId = publicId(input.intent.purchaseId)
  safeRequestId(input.intent.requestId)
  const kind = intentKind(input.intent.intentKind)
  const deliveryMethod = delivery(input.intent.delivery)
  const recipientId = positiveResidentId(input.intent.recipientId)
  const amountUnits = exactAmountUnits(input.intent.amountUnits)
  const claimTokenHash = nullableHash(input.intent.claimTokenHash)
  const paypalEnvironment = environment(input.intent.paypalEnvironment)
  const currentStatus = status(input.intent.status)
  const expectedKind = input.purchaseKind === 'paypal' ? 'order' : 'allowance'
  const expectedEventKind = input.purchaseKind === 'paypal'
    ? 'PAYMENT.CAPTURE.COMPLETED'
    : 'PAYMENT.SALE.COMPLETED'
  if (
    kind !== expectedKind
    || input.eventKind !== expectedEventKind
    || (kind === 'order' && !['approval_pending', 'captured'].includes(currentStatus))
    || (kind === 'allowance' && !['approval_pending', 'active'].includes(currentStatus))
    || (deliveryMethod === 'gift') !== (claimTokenHash !== null)
    || (kind === 'allowance' && deliveryMethod !== 'self')
  ) throw new TypeError('PayPal delivery does not match the stored purchase')

  const remoteParentId = kind === 'order'
    ? remoteId(input.intent.remoteOrderId, 'PayPal order id')
    : remoteId(input.intent.remoteSubscriptionId, 'PayPal subscription id')
  if (
    (kind === 'order' && input.intent.remoteSubscriptionId !== null)
    || (kind === 'allowance' && input.intent.remoteOrderId !== null)
  ) throw new TypeError('PayPal delivery has conflicting remote bindings')

  const sourceKey = parseCityCreditSourceKey(input.sourceKey)
  const eventId = remoteId(input.eventId, 'PayPal webhook event id')
  const remoteResourceId = paypalResourceId(input.remoteResourceId, 'PayPal webhook resource id')
  if (sourceKey !== (
    input.purchaseKind === 'paypal'
      ? `paypal:capture:${remoteResourceId}`
      : `paypal:sale:${remoteResourceId}`
  )) throw new TypeError('PayPal delivery source does not match its remote resource')

  const generatedGiftId = deliveryMethod === 'gift'
    ? `city_gift_${randomUUID().replaceAll('-', '')}`
    : null
  const rows = await database.query(`
    /* paypal-credit:deliver-atomic */
    SELECT * FROM deliver_paypal_credit(
      $1::text, $2::text, $3::integer, $4::bigint, $5::text,
      $6::text, $7::text, $8::text, $9::text, $10::text,
      $11::text, $12::text, $13::text
    )
  `, [
    purchaseId,
    deliveryMethod,
    recipientId,
    amountUnits.toString(),
    claimTokenHash,
    paypalEnvironment,
    remoteParentId,
    sourceKey,
    input.purchaseKind,
    eventId,
    input.eventKind,
    remoteResourceId,
    generatedGiftId,
  ])
  const row = rows[0]
  if (!row || rows.length !== 1) {
    conflict('PayPal purchase could not be bound to one exact delivery receipt')
  }
  return deliveredCreditReceipt(row, {
    delivery: deliveryMethod,
    residentId: recipientId,
    amountUnits,
    sourceKey,
    purchaseKind: input.purchaseKind,
    claimTokenHash,
  })
}

export async function readDeliveredPayPalOrderCredit(
  database: PayPalCreditStoreDatabase,
  purchaseIdInput: unknown,
): Promise<Readonly<Record<string, unknown>> | null> {
  const purchaseId = publicId(purchaseIdInput)
  const rows = await database.query(`
    /* paypal-credit:read-delivered-order */
    SELECT entry.*, gift.id AS gift_row_id, gift.public_id AS gift_public_id,
      gift.claim_token_hash, gift.status, gift.frozen_at, false AS created,
      intent.delivery AS intent_delivery,
      intent.recipient_id AS intent_recipient_id,
      intent.amount_units AS intent_amount_units
    FROM paypal_credit_intents intent
    JOIN paypal_credit_events event
      ON event.intent_public_id = intent.public_id
      AND event.outcome = 'credited'
      AND event.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
    JOIN city_credit_entries entry ON entry.id = event.purchase_entry_id
    LEFT JOIN city_credit_gifts gift ON gift.id = entry.gift_id
    WHERE intent.public_id = $1::text
      AND intent.intent_kind = 'order'
      AND intent.status = 'captured'
      AND entry.entry_kind = 'purchase'
      AND entry.purchase_kind = 'paypal'
      AND entry.source_key = event.source_key
    LIMIT 2
  `, [purchaseId])
  if (rows.length === 0) return null
  if (rows.length !== 1) conflict('PayPal order has ambiguous delivery receipts')
  const row = rows[0]!
  const deliveryMethod = delivery(row.intent_delivery)
  const claimTokenHash = deliveryMethod === 'gift'
    ? nullableHash(row.claim_token_hash)
    : null
  return deliveredCreditReceipt(row, {
    delivery: deliveryMethod,
    residentId: positiveResidentId(Number(row.intent_recipient_id)),
    amountUnits: exactAmountUnits(row.intent_amount_units),
    sourceKey: parseCityCreditSourceKey(row.source_key),
    purchaseKind: 'paypal',
    claimTokenHash,
  })
}

export type PayPalCatalog = Readonly<{
  paypalEnvironment: 'sandbox' | 'live'
  productId: string | null
  planId: string | null
}>

function catalog(row: QueryRow): PayPalCatalog {
  return Object.freeze({
    paypalEnvironment: environment(row.paypal_environment),
    productId: nullableRemoteId(row.product_id, 'PayPal product id'),
    planId: nullableRemoteId(row.plan_id, 'PayPal plan id'),
  })
}

export async function readPayPalCatalog(
  database: PayPalCreditStoreDatabase,
  paypalEnvironmentInput: unknown,
): Promise<PayPalCatalog> {
  const paypalEnvironment = environment(paypalEnvironmentInput)
  const rows = await database.query(`
    /* paypal-credit:read-catalog */
    SELECT paypal_environment, product_id, plan_id
    FROM paypal_credit_catalog WHERE paypal_environment = $1::text
  `, [paypalEnvironment])
  return rows[0]
    ? catalog(rows[0])
    : Object.freeze({ paypalEnvironment, productId: null, planId: null })
}

async function storeCatalogValue(
  database: PayPalCreditStoreDatabase,
  input: Readonly<{
    paypalEnvironment: 'sandbox' | 'live'
    value: string
    column: 'product_id' | 'plan_id'
  }>,
): Promise<PayPalCatalog> {
  const paypalEnvironment = environment(input.paypalEnvironment)
  const value = remoteId(input.value, input.column === 'product_id' ? 'PayPal product id' : 'PayPal plan id')
  const rows = await database.query(`
    /* paypal-credit:store-${input.column} */
    INSERT INTO paypal_credit_catalog (paypal_environment, ${input.column})
    VALUES ($1::text, $2::text)
    ON CONFLICT (paypal_environment) DO UPDATE
    SET ${input.column} = coalesce(paypal_credit_catalog.${input.column}, excluded.${input.column}),
      updated_at = clock_timestamp()
    WHERE paypal_credit_catalog.${input.column} IS NULL
      OR paypal_credit_catalog.${input.column} = excluded.${input.column}
    RETURNING paypal_environment, product_id, plan_id
  `, [paypalEnvironment, value])
  const row = rows[0]
  if (!row) conflict('PayPal catalog is already bound to a different remote id')
  const stored = catalog(row)
  const storedValue = input.column === 'product_id' ? stored.productId : stored.planId
  if (stored.paypalEnvironment !== paypalEnvironment || storedValue !== value) {
    conflict('PayPal catalog is already bound to a different remote id')
  }
  return stored
}

export async function storePayPalCatalogProduct(
  database: PayPalCreditStoreDatabase,
  input: Readonly<{ paypalEnvironment: 'sandbox' | 'live'; productId: string }>,
): Promise<PayPalCatalog> {
  return await storeCatalogValue(database, {
    paypalEnvironment: input.paypalEnvironment,
    value: input.productId,
    column: 'product_id',
  })
}

export async function storePayPalCatalogPlan(
  database: PayPalCreditStoreDatabase,
  input: Readonly<{ paypalEnvironment: 'sandbox' | 'live'; planId: string }>,
): Promise<PayPalCatalog> {
  return await storeCatalogValue(database, {
    paypalEnvironment: input.paypalEnvironment,
    value: input.planId,
    column: 'plan_id',
  })
}

export async function recordPayPalCreditEvent(
  database: PayPalCreditStoreDatabase,
  input: Readonly<{
    eventId: string
    eventKind: string
    remoteResourceId: string | null
    sourceKey: null
    outcome: 'ignored'
  }>,
): Promise<Readonly<{
  disposition: 'created' | 'existing'
  eventId: string
}>> {
  const eventId = remoteId(input.eventId, 'PayPal webhook event id')
  if (!SAFE_EVENT_KIND.test(input.eventKind)) throw new TypeError('PayPal webhook event kind is invalid')
  const remoteResourceId = input.remoteResourceId == null
    ? null
    : paypalResourceId(input.remoteResourceId, 'PayPal webhook resource id')
  if (input.sourceKey !== null || input.outcome !== 'ignored') {
    throw new TypeError('credited PayPal events require atomic delivery')
  }
  const sourceKey = null
  const rows = await database.query(`
    /* paypal-credit:record-event */
    WITH inserted AS MATERIALIZED (
      INSERT INTO paypal_credit_events (
        event_id, event_kind, remote_resource_id, source_key, outcome
      ) VALUES ($1::text, $2::text, $3::text, $4::text, $5::text)
      ON CONFLICT DO NOTHING
      RETURNING *, true AS created
    ), bindings AS MATERIALIZED (
      SELECT existing.*, false AS created FROM paypal_credit_events existing
      WHERE (existing.event_id = $1::text OR ($4::text IS NOT NULL AND existing.source_key = $4::text))
        AND NOT EXISTS (SELECT 1 FROM inserted)
    ), selected AS (
      SELECT * FROM inserted
      UNION ALL
      SELECT * FROM bindings
    )
    SELECT selected.*, count(*) OVER ()::text AS binding_count
    FROM selected
    ORDER BY created DESC, event_id
    LIMIT 2
  `, [eventId, input.eventKind, remoteResourceId, sourceKey, input.outcome])
  const row = rows[0]
  if (!row || rows.length !== 1 || String(row.binding_count) !== '1') {
    conflict('PayPal webhook identity is already bound to changed terms')
  }
  if (
    row.event_kind !== input.eventKind
    || (row.remote_resource_id ?? null) !== remoteResourceId
    || (row.source_key ?? null) !== sourceKey
    || row.outcome !== input.outcome
  ) conflict('PayPal webhook identity is already bound to changed terms')
  return Object.freeze({
    disposition: bool(row.created) ? 'created' as const : 'existing' as const,
    eventId: remoteId(row.event_id, 'PayPal webhook event id'),
  })
}

export async function takePayPalCreditRateLimit(
  database: PayPalCreditStoreDatabase,
  callerHashInput: unknown,
  maximum = 30,
): Promise<boolean> {
  if (typeof callerHashInput !== 'string' || !HASH.test(callerHashInput)) {
    throw new TypeError('PayPal caller hash is invalid')
  }
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 300) {
    throw new TypeError('PayPal rate limit is invalid')
  }
  const rows = await database.query(`
    /* paypal-credit:rate-limit */
    WITH current_bucket AS MATERIALIZED (
      SELECT date_trunc('hour', now(), 'UTC') AS hour
    ), expired AS (
      DELETE FROM credit_purchase_rate_limits old
      WHERE (old.caller_hash, old.hour) IN (
        SELECT stale.caller_hash, stale.hour
        FROM credit_purchase_rate_limits stale
        WHERE stale.hour < (SELECT hour FROM current_bucket) - interval '24 hours'
        ORDER BY stale.hour LIMIT 100
      )
    ), admitted AS (
      INSERT INTO credit_purchase_rate_limits (caller_hash, hour, used)
      SELECT $1::text, hour, 1 FROM current_bucket
      ON CONFLICT (caller_hash, hour) DO UPDATE
      SET used = credit_purchase_rate_limits.used + 1
      WHERE credit_purchase_rate_limits.used < $2::integer
      RETURNING used
    )
    SELECT used FROM admitted
  `, [callerHashInput, maximum])
  return rows.length === 1
}
