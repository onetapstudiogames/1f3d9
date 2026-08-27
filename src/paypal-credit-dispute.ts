import {
  PayPalCreditStoreConflictError,
  type PayPalCreditStoreDatabase,
} from './paypal-credit-store.ts'

const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const PAYPAL_RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u
const DISPUTE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,254}$/u
const PAYPAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):([0-5]\d|60)(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/u
const DISPUTE_EVENTS = Object.freeze([
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
] as const)
const PAYPAL_STATUSES = Object.freeze([
  'OPEN',
  'WAITING_FOR_BUYER_RESPONSE',
  'WAITING_FOR_SELLER_RESPONSE',
  'UNDER_REVIEW',
  'RESOLVED',
  'OTHER',
] as const)
const PAYPAL_OUTCOMES = Object.freeze([
  'RESOLVED_BUYER_FAVOUR',
  'RESOLVED_SELLER_FAVOUR',
  'RESOLVED_WITH_PAYOUT',
  'CANCELED_BY_BUYER',
  'ACCEPTED',
  'DENIED',
  'NONE',
] as const)

export type PayPalDisputeEventKind = typeof DISPUTE_EVENTS[number]
export type PayPalDisputeStatus = typeof PAYPAL_STATUSES[number]
export type PayPalDisputeOutcomeCode = typeof PAYPAL_OUTCOMES[number]
export type PayPalDisputeApplicationOutcome =
  | 'dispute_awaiting_capture_receipt'
  | 'dispute_partially_applied_awaiting_capture_receipt'
  | 'dispute_open_gift_frozen'
  | 'dispute_open_gifts_frozen'
  | 'dispute_open_refused_gift_blocked'
  | 'dispute_open_credit_retained'
  | 'dispute_open_targets_applied'
  | 'dispute_resolved_gift_pending'
  | 'dispute_resolved_refused_gift'
  | 'dispute_resolved_gift_still_frozen'
  | 'dispute_resolved_gift_revoked'
  | 'dispute_resolved_credit_retained'
  | 'dispute_resolved_targets_applied'
  | 'dispute_resolution_needs_operator_review'
  | 'dispute_stale_event_ignored'

type JsonRecord = Record<string, unknown>

export type ParsedPayPalDisputeEvent = Readonly<{
  eventId: string
  eventKind: PayPalDisputeEventKind
  disputeId: string
  captureIds: readonly string[]
  paypalStatus: PayPalDisputeStatus
  outcomeCode: PayPalDisputeOutcomeCode | null
  resourceUpdatedAt: string
}>

export type AppliedPayPalDispute = Readonly<{
  eventId: string
  disputeId: string
  state: 'open' | 'resolved_seller' | 'resolved_against_seller' | 'resolution_review'
  paypalStatus: PayPalDisputeStatus
  outcomeCode: PayPalDisputeOutcomeCode | null
  resourceUpdatedAt: string
  applicationOutcome: PayPalDisputeApplicationOutcome
  disposition: 'created' | 'existing'
  transactionCount: number
  localPurchaseCount: number
  receiptsCreated: number
}>

export class PayPalDisputeParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayPalDisputeParseError'
  }
}

function invalid(message: string): never {
  throw new PayPalDisputeParseError(message)
}

function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} is invalid.`)
  }
  return value as JsonRecord
}

function remoteId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !REMOTE_ID.test(value)) {
    invalid(`${label} is invalid.`)
  }
  return value
}

function disputeId(value: unknown): string {
  if (typeof value !== 'string' || !DISPUTE_ID.test(value)) {
    invalid('PayPal dispute id is invalid.')
  }
  return value
}

function captureId(value: unknown): string {
  if (typeof value !== 'string' || !PAYPAL_RESOURCE_ID.test(value)) {
    invalid('PayPal seller transaction id is invalid.')
  }
  return value
}

function paypalStatus(value: unknown): PayPalDisputeStatus {
  if (!PAYPAL_STATUSES.includes(value as PayPalDisputeStatus)) {
    invalid('PayPal dispute status is invalid.')
  }
  return value as PayPalDisputeStatus
}

function resourceUpdatedAt(value: unknown): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 64) {
    invalid('PayPal dispute update_time is invalid.')
  }
  const match = PAYPAL_TIME.exec(value)
  if (!match) invalid('PayPal dispute update_time is invalid.')
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    fraction = '', zone] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
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
  ) invalid('PayPal dispute update_time is invalid.')
  let offsetMinutes = 0
  if (zone!.toUpperCase() !== 'Z') {
    const offsetHour = Number(zone!.slice(1, 3))
    const offsetMinute = Number(zone!.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) {
      invalid('PayPal dispute update_time is invalid.')
    }
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (zone!.startsWith('+') ? 1 : -1)
  }
  const instant = new Date(
    wall.getTime() - offsetMinutes * 60_000 + (leapSecond ? 1_000 : 0),
  )
  if (!Number.isFinite(instant.getTime())) invalid('PayPal dispute update_time is invalid.')
  return `${instant.toISOString().slice(0, 19)}.${fraction || '000'}Z`
}

function storedResourceUpdatedAt(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  return resourceUpdatedAt(value)
}

function outcomeCode(value: unknown): PayPalDisputeOutcomeCode {
  if (!PAYPAL_OUTCOMES.includes(value as PayPalDisputeOutcomeCode)) {
    invalid('PayPal dispute outcome is invalid.')
  }
  return value as PayPalDisputeOutcomeCode
}

export function parsePayPalDisputeEvent(value: unknown): ParsedPayPalDisputeEvent | null {
  const event = object(value, 'PayPal webhook event')
  if (!DISPUTE_EVENTS.includes(event.event_type as PayPalDisputeEventKind)) return null
  const eventKind = event.event_type as PayPalDisputeEventKind
  const resource = object(event.resource, 'PayPal dispute event resource')
  if (!Array.isArray(resource.disputed_transactions)
    || resource.disputed_transactions.length < 1
    || resource.disputed_transactions.length > 1_000) {
    invalid('PayPal dispute event must identify from 1 to 1000 disputed transactions.')
  }
  const listedCaptureIds = resource.disputed_transactions.map((value, index) => (
    captureId(object(value, `PayPal disputed transaction ${index + 1}`).seller_transaction_id)
  ))
  if (new Set(listedCaptureIds).size !== listedCaptureIds.length) {
    invalid('PayPal dispute event repeats a seller transaction id.')
  }
  const captureIds = [...listedCaptureIds].sort()
  const status = paypalStatus(resource.status)
  let resolvedOutcome: PayPalDisputeOutcomeCode | null = null
  if (eventKind === 'CUSTOMER.DISPUTE.RESOLVED') {
    if (status !== 'RESOLVED') invalid('PayPal resolved dispute status is invalid.')
    resolvedOutcome = outcomeCode(
      object(resource.dispute_outcome, 'PayPal dispute outcome').outcome_code,
    )
  }
  return Object.freeze({
    eventId: remoteId(event.id, 'PayPal webhook event id'),
    eventKind,
    disputeId: disputeId(resource.dispute_id),
    captureIds: Object.freeze(captureIds),
    paypalStatus: status,
    outcomeCode: resolvedOutcome,
    resourceUpdatedAt: resourceUpdatedAt(resource.update_time),
  })
}

function bool(value: unknown): boolean {
  return value === true || value === 't'
}

function storedOutcome(value: unknown): PayPalDisputeApplicationOutcome {
  const outcomes: readonly PayPalDisputeApplicationOutcome[] = [
    'dispute_awaiting_capture_receipt',
    'dispute_partially_applied_awaiting_capture_receipt',
    'dispute_open_gift_frozen',
    'dispute_open_gifts_frozen',
    'dispute_open_refused_gift_blocked',
    'dispute_open_credit_retained',
    'dispute_open_targets_applied',
    'dispute_resolved_gift_pending',
    'dispute_resolved_refused_gift',
    'dispute_resolved_gift_still_frozen',
    'dispute_resolved_gift_revoked',
    'dispute_resolved_credit_retained',
    'dispute_resolved_targets_applied',
    'dispute_resolution_needs_operator_review',
    'dispute_stale_event_ignored',
  ]
  if (!outcomes.includes(value as PayPalDisputeApplicationOutcome)) {
    throw new TypeError('stored PayPal dispute outcome is invalid')
  }
  return value as PayPalDisputeApplicationOutcome
}

function storedState(value: unknown): AppliedPayPalDispute['state'] {
  if (!['open', 'resolved_seller', 'resolved_against_seller', 'resolution_review']
    .includes(String(value))) {
    throw new TypeError('stored PayPal dispute state is invalid')
  }
  return value as AppliedPayPalDispute['state']
}

function count(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(String(value))
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000) {
    throw new TypeError(`stored PayPal dispute ${label} is invalid`)
  }
  return parsed
}

function conflictFromDatabase(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : ''
  if (code === '23514' || code === '55000') {
    throw new PayPalCreditStoreConflictError(
      'PayPal dispute evidence conflicts with durable credit history.',
    )
  }
  throw error
}

export async function applyPayPalCreditDispute(
  database: PayPalCreditStoreDatabase,
  input: ParsedPayPalDisputeEvent,
): Promise<AppliedPayPalDispute> {
  let rows: readonly Record<string, unknown>[]
  try {
    rows = await database.query(`
      /* paypal-credit:apply-dispute */
      SELECT * FROM apply_paypal_credit_dispute(
        $1::text, $2::text, $3::text, $4::text[],
        $5::text, $6::text, $7::timestamptz
      )
    `, [
      input.eventId,
      input.eventKind,
      input.disputeId,
      input.captureIds,
      input.paypalStatus,
      input.outcomeCode,
      input.resourceUpdatedAt,
    ])
  } catch (error) {
    conflictFromDatabase(error)
  }
  if (rows.length !== 1) {
    throw new PayPalCreditStoreConflictError(
      'PayPal dispute evidence did not produce one durable aggregate result.',
    )
  }
  const row = rows[0]!
  const applied = Object.freeze({
    eventId: remoteId(row.event_id, 'stored PayPal webhook event id'),
    disputeId: disputeId(row.dispute_id),
    state: storedState(row.state),
    paypalStatus: paypalStatus(row.paypal_status),
    outcomeCode: row.outcome_code == null ? null : outcomeCode(row.outcome_code),
    resourceUpdatedAt: storedResourceUpdatedAt(row.resource_updated_at),
    applicationOutcome: storedOutcome(row.application_outcome),
    disposition: bool(row.created) ? 'created' as const : 'existing' as const,
    transactionCount: count(row.transaction_count, 'transaction count'),
    localPurchaseCount: count(row.local_purchase_count, 'local purchase count'),
    receiptsCreated: count(row.receipts_created, 'receipt count'),
  })
  if (
    applied.disputeId !== input.disputeId
    || applied.transactionCount !== input.captureIds.length
    || applied.localPurchaseCount > applied.transactionCount
    || applied.receiptsCreated > applied.localPurchaseCount
  ) {
    throw new PayPalCreditStoreConflictError(
      'PayPal dispute evidence is bound to changed terms.',
    )
  }
  return applied
}

export type FounderPayPalDisputeInspection = Readonly<{
  dispute_id: string
  capture_id: string
  state: AppliedPayPalDispute['state']
  paypal_status: PayPalDisputeStatus
  outcome_code: PayPalDisputeOutcomeCode | null
  gift_id: string | null
  amount_units: string | null
  internal_note: string
  opened_at: string
  resolved_at: string | null
  updated_at: string
}>

function giftPublicId(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string' || !/^city_gift_[0-9a-f]{32}$/u.test(value)) {
    throw new TypeError('stored PayPal dispute gift id is invalid')
  }
  return value
}

export async function readFounderPayPalCreditDisputes(
  database: PayPalCreditStoreDatabase,
  residentId: number,
): Promise<readonly FounderPayPalDisputeInspection[]> {
  if (!Number.isSafeInteger(residentId) || residentId < 1 || residentId > 2_147_483_647) {
    throw new TypeError('dispute inspection resident id is invalid')
  }
  const rows = await database.query(`
    /* paypal-credit:founder-dispute-inspection */
    WITH dispute_capture AS (
      SELECT DISTINCT
        dispute.dispute_id, transaction.capture_id, dispute.state,
        dispute.paypal_status, dispute.outcome_code,
        note.body AS internal_note, dispute.opened_at, dispute.resolved_at,
        dispute.updated_at
      FROM paypal_credit_disputes dispute
      JOIN paypal_credit_dispute_events dispute_event
        ON dispute_event.dispute_id = dispute.dispute_id
      CROSS JOIN LATERAL unnest(dispute_event.transaction_capture_ids)
        AS transaction(capture_id)
      JOIN founder_city_credit_notes note ON note.dispute_id = dispute.dispute_id
        AND note.founder_id = 1
    )
    SELECT dispute_capture.dispute_id, dispute_capture.capture_id,
      dispute_capture.state, dispute_capture.paypal_status,
      dispute_capture.outcome_code,
      gift.public_id AS gift_public_id, purchase.amount_units::text AS amount_units,
      dispute_capture.internal_note, dispute_capture.opened_at,
      dispute_capture.resolved_at, dispute_capture.updated_at
    FROM dispute_capture
    LEFT JOIN paypal_credit_events capture
      ON capture.remote_resource_id = dispute_capture.capture_id
      AND capture.event_kind = 'PAYMENT.CAPTURE.COMPLETED'
      AND capture.outcome = 'credited'
    LEFT JOIN city_credit_entries purchase ON purchase.id = capture.purchase_entry_id
      AND purchase.entry_kind = 'purchase' AND purchase.purchase_kind = 'paypal'
    LEFT JOIN city_credit_gifts gift ON gift.id = purchase.gift_id
    WHERE (
      purchase.id IS NOT NULL
      AND (purchase.resident_id = $1::integer OR gift.recipient_id = $1::integer)
    ) OR (purchase.id IS NULL AND $1::integer = 1)
    ORDER BY dispute_capture.updated_at DESC, dispute_capture.dispute_id,
      dispute_capture.capture_id
    LIMIT 100
  `, [residentId])
  return Object.freeze(rows.map(row => Object.freeze({
    dispute_id: disputeId(row.dispute_id),
    capture_id: captureId(row.capture_id),
    state: storedState(row.state),
    paypal_status: paypalStatus(row.paypal_status),
    outcome_code: row.outcome_code == null ? null : outcomeCode(row.outcome_code),
    gift_id: giftPublicId(row.gift_public_id),
    amount_units: row.amount_units == null ? null : String(row.amount_units),
    internal_note: String(row.internal_note),
    opened_at: String(row.opened_at),
    resolved_at: row.resolved_at == null ? null : String(row.resolved_at),
    updated_at: String(row.updated_at),
  })))
}
