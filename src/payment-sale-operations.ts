import { USDC } from './chain.ts'
import { canonicalPaymentRequest } from './payment-attempts.ts'
import {
  CLOSE_INVALID_SALE_TARGET_SQL,
  CLOSE_SALE_TARGET_SQL,
  DIRECT_COMPLETION_SQL,
  INVALIDATE_SALE_TARGET_SQL,
  WORLD_COMPLETION_SQL,
  WORLD_PARK_SQL,
} from './payment-sale-operation-sql.ts'

const PUBLIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u
const LEASE_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,255}$/u
const WALLET_RE = /^0x[0-9a-f]{40}$/u
const HASH_RE = /^0x[0-9a-f]{64}$/u
const RESPONSE_HEADER_RE = /^[A-Za-z0-9+/]+={0,2}$/u
const RESPONSE_WRAPPER = '__1f3d9_x402_response_v1'

type QueryRow = Record<string, unknown>
type SaleOperation = 'direct_sale' | 'world_sale'

export interface PaymentSaleDatabase {
  query(text: string, params?: readonly unknown[] | any[]): Promise<readonly QueryRow[]>
}

interface CompleteSaleInput {
  attemptId: string
  leaseOwner: string
}

interface SaleIdentity {
  attemptId: string
  actorId: number
  operation: SaleOperation
  method: 'x402'
}

export type CompleteSalePaymentResult =
  | (SaleIdentity & {
      state: 'completed'
      status: number
      response: Record<string, unknown>
      responseBody: string
      paymentResponseHeader: string | null
    })
  | (SaleIdentity & { state: 'target_changed'; reason: string })
  | (SaleIdentity & { state: 'deadline_passed' })

export type ParkWorldSalePaymentResult =
  | (SaleIdentity & { state: 'parked' })
  | (SaleIdentity & { state: 'target_changed'; reason: string })
  | (SaleIdentity & { state: 'deadline_passed' })

export type CloseSalePaymentTargetResult = SaleIdentity & {
  state: 'expired' | 'founder_review'
  targetReleased: boolean
}

export type CloseInvalidSalePaymentTargetResult = SaleIdentity & {
  state: 'invalid'
  targetReleased: boolean
  evidenceSynchronized: boolean
}

interface ValidatedSaleAttempt extends SaleIdentity {
  status: 'payment_pending' | 'needs_review' | 'completed'
  recoveryOpen: boolean
  row: QueryRow
}

export class PaymentSaleConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentSaleConflictError'
  }
}

function inputId(value: string, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function integer(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function boolean(value: unknown): boolean | null {
  if (value === true || value === 't') return true
  if (value === false || value === 'f') return false
  return null
}

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizedWallet(value: unknown): string | null {
  const candidate = text(value)?.toLowerCase()
  return candidate && WALLET_RE.test(candidate) ? candidate : null
}

function normalizedHash(value: unknown): string | null {
  const candidate = text(value)?.toLowerCase()
  return candidate && HASH_RE.test(candidate) ? candidate : null
}

function exactPrice(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 10_000
    && Math.round(parsed * 1_000_000) / 1_000_000 === parsed
    ? parsed
    : null
}

function timestamp(value: unknown): number | null {
  if (value == null) return null
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalPaymentRequest(left).json === canonicalPaymentRequest(right).json
  } catch {
    return false
  }
}

function identity(row: QueryRow, expected: SaleOperation): SaleIdentity | null {
  const attemptId = text(row.attempt_id)
  const actorId = integer(row.actor_id)
  if (
    !attemptId || !PUBLIC_ID_RE.test(attemptId) || !actorId || actorId < 1
    || row.operation !== expected || row.method !== 'x402'
  ) return null
  return { attemptId, actorId, operation: expected, method: 'x402' }
}

function directExpectedRequest(row: QueryRow): Record<string, unknown> | null {
  const offerId = integer(row.offer_id)
  const assetId = integer(row.asset_id)
  const price = exactPrice(row.price_usdc)
  const buyerWallet = normalizedWallet(row.buyer_wallet)
  const sellerWallet = normalizedWallet(row.seller_wallet)
  const assetType = ['place', 'thing', 'kind'].includes(String(row.asset_type))
    ? String(row.asset_type)
    : null
  if (!offerId || !assetId || price == null || !buyerWallet || !sellerWallet || !assetType) return null
  return {
    offer_id: offerId,
    buyer_wallet: buyerWallet,
    seller_wallet: sellerWallet,
    price_usdc: price,
    asset_type: assetType,
    asset_id: assetId,
  }
}

function worldExpectedRequest(row: QueryRow): Record<string, unknown> | null {
  const offerId = integer(row.offer_id)
  const assetId = integer(row.asset_id)
  const checkoutId = integer(row.market_checkout_id)
  const listingId = integer(row.market_listing_id)
  const draftId = integer(row.market_draft_id)
  const price = exactPrice(row.price_usdc)
  const buyerWallet = normalizedWallet(row.buyer_wallet)
  const sellerWallet = normalizedWallet(row.seller_wallet)
  const marketBuyer = text(row.market_buyer)
  if (
    !offerId || !assetId || !checkoutId || !listingId || !draftId || price == null
    || !buyerWallet || !sellerWallet || !marketBuyer
  ) return null
  return {
    offer_id: offerId,
    market_checkout_id: checkoutId,
    market_listing_id: listingId,
    market_draft_id: draftId,
    market_buyer: marketBuyer,
    buyer_wallet: buyerWallet,
    seller_wallet: sellerWallet,
    price_usdc: price,
    asset_id: assetId,
  }
}

function immutableTermsMatch(
  row: QueryRow,
  operation: SaleOperation,
  options: Readonly<{
    requireFinality?: boolean
    requireTransaction?: boolean
  }> = {},
): boolean {
  const requireFinality = options.requireFinality !== false
  const requireTransaction = options.requireTransaction !== false
  const request = object(row.request_json)
  const expectedRequest = operation === 'direct_sale'
    ? directExpectedRequest(row)
    : worldExpectedRequest(row)
  if (!request || !expectedRequest) return false
  let canonical
  try {
    canonical = canonicalPaymentRequest(request)
  } catch {
    return false
  }
  const offerId = integer(row.offer_id)
  const assetId = integer(row.asset_id)
  const actorId = integer(row.actor_id)
  const counterpartyId = integer(row.counterparty_id)
  const buyerId = integer(row.buyer_id)
  const sellerId = integer(row.seller_id)
  const price = exactPrice(row.price_usdc)
  const amountUnits = text(row.amount_units)
  const finalizedBlockTime = timestamp(row.finalized_block_time)
  const startTime = timestamp(row.start_time)
  const endTime = timestamp(row.end_time)
  const reservedAt = timestamp(row.reserved_at)
  const reservedUntil = timestamp(row.reserved_until)
  const reservationLowerBound = reservedAt == null ? null : Math.ceil(reservedAt / 1_000) * 1_000
  const reservationUpperBound = reservedUntil == null ? null : Math.floor(reservedUntil / 1_000) * 1_000
  return row.request_hash === canonical.hash
    && sameCanonicalJson(request, expectedRequest)
    && row.target_key === `${operation === 'direct_sale' ? 'direct-sale' : 'world-sale'}:${offerId}`
    && integer(row.attempt_offer_id) === offerId
    && row.attempt_asset_type === row.asset_type
    && integer(row.attempt_asset_id) === assetId
    && actorId === buyerId && counterpartyId === sellerId
    && row.network === 'base' && normalizedWallet(row.token) === USDC.toLowerCase()
    && normalizedWallet(row.payer_wallet) === normalizedWallet(row.buyer_wallet)
    && normalizedWallet(row.payee_wallet) === normalizedWallet(row.seller_wallet)
    && price != null && amountUnits === String(Math.round(price * 1_000_000))
    && (!requireTransaction || normalizedHash(row.tx_hash) != null)
    && (!requireFinality || (
      integer(row.finalized_block_number) != null
      && normalizedHash(row.finalized_block_hash) != null
      && timestamp(row.finalized_at) != null
      && finalizedBlockTime != null && startTime != null && endTime != null
      && finalizedBlockTime >= startTime && finalizedBlockTime < endTime
      && reservationLowerBound != null && reservationUpperBound != null
      && finalizedBlockTime >= reservationLowerBound && finalizedBlockTime < reservationUpperBound
    ))
    && row.channel === (operation === 'direct_sale' ? 'direct' : 'world')
}

function pendingTargetMatches(row: QueryRow, operation: SaleOperation): boolean {
  if (
    row.offer_status !== 'open'
    || integer(row.current_owner_id) !== integer(row.seller_id)
    || integer(row.active_offer_id) !== integer(row.offer_id)
    || (row.asset_type === 'thing' && row.withdrawn_at != null)
    || integer(row.reserved_by) !== integer(row.buyer_id)
    || normalizedWallet(row.buyer_wallet) == null
  ) return false
  if (operation === 'direct_sale') {
    return ['place', 'thing', 'kind'].includes(String(row.asset_type))
      && row.x402_evidence_state === 'none'
      && row.pending_payment_attempt_id == null
  }
  if (row.asset_type !== 'thing') return false
  const hasNoParking = row.x402_evidence_state === 'none'
    && row.pending_payment_attempt_id == null
    && row.pending_x402_tx_hash == null
    && row.pending_x402_payer == null
    && row.pending_x402_at == null
  const hasExactParking = row.x402_evidence_state === 'pending'
    && row.pending_payment_attempt_id === row.attempt_id
    && normalizedHash(row.pending_x402_tx_hash) === normalizedHash(row.tx_hash)
    && normalizedWallet(row.pending_x402_payer) === normalizedWallet(row.payer_wallet)
    && row.pending_x402_at != null
  return hasNoParking || hasExactParking
}

function responseFromRow(row: QueryRow, sale: SaleIdentity): CompleteSalePaymentResult | null {
  const status = integer(row.response_status)
  const response = object(row.response)
  const responseBody = text(row.response_body)
  const header = row.payment_response_header == null ? null : text(row.payment_response_header)
  if (
    row.state !== 'completed' || status == null || status < 100 || status > 599
    || !response || responseBody == null || (header != null && !RESPONSE_HEADER_RE.test(header))
  ) return null
  try {
    if (!sameCanonicalJson(JSON.parse(responseBody) as unknown, response)) return null
  } catch {
    return null
  }
  return {
    state: 'completed',
    ...sale,
    status,
    response,
    responseBody,
    paymentResponseHeader: header,
  }
}

function noEffect(
  sale: SaleIdentity,
  state: 'target_changed' | 'deadline_passed',
  reason = 'current sale target or immutable terms changed',
): CompleteSalePaymentResult {
  const identity = {
    attemptId: sale.attemptId,
    actorId: sale.actorId,
    operation: sale.operation,
    method: sale.method,
  }
  return state === 'target_changed'
    ? { state, ...identity, reason }
    : { state, ...identity }
}

async function readSaleAttempt(
  database: PaymentSaleDatabase,
  attemptId: string,
): Promise<QueryRow | null> {
  const rows = await database.query(`
    /* payment-sale-operations:read-attempt */
    SELECT attempt.public_id AS attempt_id, attempt.actor_id, attempt.counterparty_id,
      attempt.operation, attempt.target_key, attempt.offer_id AS attempt_offer_id,
      attempt.asset_type AS attempt_asset_type, attempt.asset_id AS attempt_asset_id,
      attempt.request_hash, attempt.request_json, attempt.method, attempt.network,
      lower(attempt.token) AS token, lower(attempt.payer_wallet) AS payer_wallet,
      lower(attempt.payee_wallet) AS payee_wallet, attempt.amount_units::text AS amount_units,
      attempt.start_time, attempt.end_time, attempt.status, attempt.lease_owner,
      attempt.tx_hash, attempt.finalized_block_number, attempt.finalized_block_hash,
      attempt.finalized_block_time, attempt.finalized_at,
      attempt.recovery_started_at, attempt.recovery_deadline_at,
      (
        attempt.recovery_deadline_at IS NOT NULL
        AND attempt.recovery_deadline_at > clock_timestamp()
      ) AS recovery_open,
      offer.id AS offer_id, offer.channel, offer.asset_type, offer.asset_id,
      offer.seller_id, seller.handle AS seller, offer.buyer_id, buyer.handle AS buyer,
      offer.price_usdc::text AS price_usdc, lower(offer.seller_wallet) AS seller_wallet,
      lower(offer.buyer_wallet) AS buyer_wallet, offer.status AS offer_status,
      offer.reserved_by, offer.reserved_at, offer.reserved_until,
      offer.market_origin, offer.market_draft_id, offer.market_listing_id,
      offer.market_checkout_id, offer.market_buyer, offer.pending_payment_attempt_id,
      offer.pending_x402_tx_hash, lower(offer.pending_x402_payer) AS pending_x402_payer,
      offer.pending_x402_at, offer.x402_evidence_state,
      CASE attempt.asset_type
        WHEN 'place' THEN place.owner_id
        WHEN 'thing' THEN thing.owner_id
        WHEN 'kind' THEN kind.owner_id
        ELSE NULL
      END AS current_owner_id,
      CASE attempt.asset_type
        WHEN 'place' THEN place.active_offer_id
        WHEN 'thing' THEN thing.active_offer_id
        WHEN 'kind' THEN kind.active_offer_id
        ELSE NULL
      END AS active_offer_id,
      thing.withdrawn_at, thing.name AS asset_name, thing.maker_id, maker.handle AS made_by,
      attempt.response_status,
      CASE
        WHEN attempt.response_json ? '${RESPONSE_WRAPPER}'
          THEN attempt.response_json #> '{${RESPONSE_WRAPPER},body}'
        ELSE attempt.response_json
      END AS response,
      CASE WHEN attempt.response_body_bytes IS NULL THEN NULL
        ELSE convert_from(attempt.response_body_bytes, 'UTF8') END AS response_body,
      attempt.response_json #>> '{${RESPONSE_WRAPPER},header}' AS payment_response_header
    FROM payment_attempts attempt
    LEFT JOIN transfer_offers offer ON offer.id = attempt.offer_id
    LEFT JOIN residents seller ON seller.id = offer.seller_id
    LEFT JOIN residents buyer ON buyer.id = offer.buyer_id
    LEFT JOIN places place
      ON attempt.asset_type = 'place' AND place.id = attempt.asset_id
    LEFT JOIN things thing
      ON attempt.asset_type = 'thing' AND thing.id = attempt.asset_id
    LEFT JOIN kinds kind
      ON attempt.asset_type = 'kind' AND kind.id = attempt.asset_id
    LEFT JOIN residents maker ON maker.id = thing.maker_id
    WHERE attempt.public_id = $1
    LIMIT 1
  `, [attemptId])
  return rows[0] ?? null
}

async function validateSaleAttempt(
  database: PaymentSaleDatabase,
  input: CompleteSaleInput,
  operation: SaleOperation,
): Promise<ValidatedSaleAttempt> {
  const attemptId = inputId(input.attemptId, PUBLIC_ID_RE, 'payment attempt id')
  inputId(input.leaseOwner, LEASE_OWNER_RE, 'payment lease owner')
  const row = await readSaleAttempt(database, attemptId)
  if (!row) throw new PaymentSaleConflictError('payment sale attempt is unavailable')
  const sale = identity(row, operation)
  if (!sale) throw new PaymentSaleConflictError('payment sale attempt has the wrong operation')
  const status = ['payment_pending', 'needs_review', 'completed'].includes(String(row.status))
    ? row.status as ValidatedSaleAttempt['status']
    : null
  if (!status || !immutableTermsMatch(row, operation)) {
    return { ...sale, status: status ?? 'payment_pending', recoveryOpen: false, row: { ...row, invalid: true } }
  }
  return { ...sale, status, recoveryOpen: row.recovery_open === true, row }
}

function completedReplay(attempt: ValidatedSaleAttempt): CompleteSalePaymentResult | null {
  if (attempt.status !== 'completed') return null
  return responseFromRow({ ...attempt.row, state: 'completed' }, attempt)
}

async function completionResult(
  database: PaymentSaleDatabase,
  row: QueryRow | undefined,
  attempt: ValidatedSaleAttempt,
): Promise<CompleteSalePaymentResult> {
  const completed = row ? responseFromRow(row, attempt) : null
  if (completed) return completed
  if (row?.state === 'deadline_passed') return noEffect(attempt, 'deadline_passed')

  const current = await readSaleAttempt(database, attempt.attemptId)
  if (current) {
    const currentSale = identity(current, attempt.operation)
    if (currentSale && immutableTermsMatch(current, attempt.operation)) {
      const replay = responseFromRow({ ...current, state: 'completed' }, currentSale)
      if (replay) return replay
      if (current.status === 'payment_pending' && current.recovery_open !== true) {
        return noEffect(currentSale, 'deadline_passed')
      }
    }
  }
  return noEffect(attempt, 'target_changed', 'sale completion lost its current target')
}

export async function completeDirectSalePayment(
  database: PaymentSaleDatabase,
  input: CompleteSaleInput,
): Promise<CompleteSalePaymentResult> {
  const attempt = await validateSaleAttempt(database, input, 'direct_sale')
  const replay = completedReplay(attempt)
  if (replay) return replay
  if (attempt.row.invalid === true || !pendingTargetMatches(attempt.row, 'direct_sale')) {
    return noEffect(attempt, 'target_changed', attempt.row.invalid === true
      ? 'stored payment terms no longer match the canonical direct sale'
      : 'direct sale offer or ownership changed')
  }
  if (!attempt.recoveryOpen) return noEffect(attempt, 'deadline_passed')

  const rows = await database.query(DIRECT_COMPLETION_SQL, [input.attemptId, input.leaseOwner])
  return completionResult(database, rows[0], attempt)
}

export async function parkWorldSalePayment(
  database: PaymentSaleDatabase,
  input: { attemptId: string },
): Promise<ParkWorldSalePaymentResult> {
  const attemptId = inputId(input.attemptId, PUBLIC_ID_RE, 'payment attempt id')
  const row = await readSaleAttempt(database, attemptId)
  if (!row) throw new PaymentSaleConflictError('world sale payment attempt is unavailable')
  const sale = identity(row, 'world_sale')
  if (!sale) throw new PaymentSaleConflictError('payment sale attempt has the wrong operation')
  if (
    !immutableTermsMatch(row, 'world_sale', { requireFinality: false })
    || !pendingTargetMatches(row, 'world_sale')
  ) {
    return {
      state: 'target_changed',
      ...sale,
      reason: 'world sale offer, ownership, or stored payment terms changed',
    }
  }
  if (row.recovery_open !== true) return { state: 'deadline_passed', ...sale }
  if (row.pending_payment_attempt_id === attemptId) return { state: 'parked', ...sale }
  const parked = (await database.query(WORLD_PARK_SQL, [attemptId]))[0]
  if (parked?.state === 'parked') return { state: 'parked', ...sale }
  if (parked?.state === 'deadline_passed') return { state: 'deadline_passed', ...sale }
  const current = await readSaleAttempt(database, attemptId)
  if (current) {
    const currentSale = identity(current, 'world_sale')
    if (
      currentSale && immutableTermsMatch(current, 'world_sale', { requireFinality: false })
      && pendingTargetMatches(current, 'world_sale')
      && current.pending_payment_attempt_id === attemptId
    ) return { state: 'parked', ...currentSale }
    if (currentSale && current.recovery_open !== true) {
      return { state: 'deadline_passed', ...currentSale }
    }
  }
  return {
    state: 'target_changed',
    ...sale,
    reason: 'world sale could not attach its stored payment evidence',
  }
}

export async function completeWorldSalePayment(
  database: PaymentSaleDatabase,
  input: CompleteSaleInput,
): Promise<CompleteSalePaymentResult> {
  let attempt = await validateSaleAttempt(database, input, 'world_sale')
  const replay = completedReplay(attempt)
  if (replay) return replay
  if (attempt.row.invalid === true || !pendingTargetMatches(attempt.row, 'world_sale')) {
    return noEffect(attempt, 'target_changed', attempt.row.invalid === true
      ? 'stored payment terms no longer match the canonical world sale'
      : 'world sale offer or ownership changed')
  }
  if (!attempt.recoveryOpen) return noEffect(attempt, 'deadline_passed')

  if (attempt.row.pending_payment_attempt_id == null) {
    const parked = await parkWorldSalePayment(database, { attemptId: input.attemptId })
    if (parked.state !== 'parked') {
      return parked.state === 'deadline_passed'
        ? noEffect(attempt, 'deadline_passed')
        : noEffect(attempt, 'target_changed', parked.reason)
    }
    attempt = await validateSaleAttempt(database, input, 'world_sale')
    if (!pendingTargetMatches(attempt.row, 'world_sale')) {
      return noEffect(attempt, 'target_changed', 'world sale payment evidence changed after parking')
    }
    if (!attempt.recoveryOpen) return noEffect(attempt, 'deadline_passed')
  }

  const rows = await database.query(WORLD_COMPLETION_SQL, [input.attemptId, input.leaseOwner])
  return completionResult(database, rows[0], attempt)
}

export async function closeSalePaymentTarget(
  database: PaymentSaleDatabase,
  input: CompleteSaleInput & {
    reason: string
    state: 'expired' | 'founder_review'
  },
): Promise<CloseSalePaymentTargetResult> {
  const attemptId = inputId(input.attemptId, PUBLIC_ID_RE, 'payment attempt id')
  const leaseOwner = inputId(input.leaseOwner, LEASE_OWNER_RE, 'payment lease owner')
  const reason = input.reason.trim()
  if (reason.length < 1 || Buffer.byteLength(reason, 'utf8') > 500) {
    throw new TypeError('sale payment terminal reason must be 1 to 500 bytes')
  }
  const rows = await database.query(CLOSE_SALE_TARGET_SQL, [
    attemptId,
    leaseOwner,
    input.state,
    reason,
  ])
  const row = rows[0]
  const sale = row ? identity(row, String(row.operation) === 'world_sale' ? 'world_sale' : 'direct_sale') : null
  const released = row ? boolean(row.target_released) : null
  if (row && sale && row.state === input.state && released != null) {
    return { state: input.state, ...sale, targetReleased: released }
  }

  const current = await readSaleAttempt(database, attemptId)
  const operation = current?.operation === 'world_sale' ? 'world_sale' : 'direct_sale'
  const currentSale = current ? identity(current, operation) : null
  if (!currentSale || current?.status !== input.state) {
    throw new PaymentSaleConflictError('sale payment target could not enter its terminal state')
  }
  return {
    state: input.state,
    ...currentSale,
    targetReleased: operation === 'world_sale'
      ? false
      : current.offer_status === 'canceled'
        && integer(current.active_offer_id) !== integer(current.offer_id),
  }
}

/**
 * Synchronize a sale target after payment custody has already made the attempt
 * terminally invalid. The stored attempt is the only source of operation facts.
 */
export async function closeInvalidSalePaymentTarget(
  database: PaymentSaleDatabase,
  input: { attemptId: string },
): Promise<CloseInvalidSalePaymentTargetResult> {
  const attemptId = inputId(input.attemptId, PUBLIC_ID_RE, 'payment attempt id')
  const current = await readSaleAttempt(database, attemptId)
  const operation = current?.operation === 'world_sale' ? 'world_sale' : 'direct_sale'
  const sale = current ? identity(current, operation) : null
  if (!sale || current?.status !== 'invalid') {
    throw new PaymentSaleConflictError('invalid sale payment attempt is unavailable')
  }
  if (!immutableTermsMatch(current, operation, {
    requireFinality: false,
    requireTransaction: false,
  })) {
    throw new PaymentSaleConflictError('invalid sale payment terms do not match their target')
  }

  const row = (await database.query(CLOSE_INVALID_SALE_TARGET_SQL, [attemptId]))[0]
  const closed = row ? identity(row, operation) : null
  const targetReleased = row ? boolean(row.target_released) : null
  const evidenceSynchronized = row ? boolean(row.evidence_synchronized) : null
  if (!closed || row?.state !== 'invalid' || targetReleased == null || evidenceSynchronized == null) {
    throw new PaymentSaleConflictError('invalid sale target could not be synchronized')
  }
  return {
    state: 'invalid',
    ...closed,
    targetReleased,
    evidenceSynchronized,
  }
}

/**
 * Atomically invalidate live sale custody and synchronize its exact sale target.
 * Payment-flow must inject this in place of generic invalidation for sale attempts.
 */
export async function invalidateSalePaymentTarget(
  database: PaymentSaleDatabase,
  input: CompleteSaleInput & { reason: string },
): Promise<CloseInvalidSalePaymentTargetResult> {
  const attemptId = inputId(input.attemptId, PUBLIC_ID_RE, 'payment attempt id')
  const leaseOwner = inputId(input.leaseOwner, LEASE_OWNER_RE, 'payment lease owner')
  const reason = input.reason.trim()
  if (reason.length < 1 || Buffer.byteLength(reason, 'utf8') > 240) {
    throw new TypeError('sale payment invalid reason must be 1 to 240 bytes')
  }
  const row = (await database.query(INVALIDATE_SALE_TARGET_SQL, [
    attemptId,
    leaseOwner,
    reason,
  ]))[0]
  const operation = row?.operation === 'world_sale' ? 'world_sale' : 'direct_sale'
  const invalid = row ? identity(row, operation) : null
  const targetReleased = row ? boolean(row.target_released) : null
  const evidenceSynchronized = row ? boolean(row.evidence_synchronized) : null
  if (!invalid || row?.state !== 'invalid' || targetReleased == null || evidenceSynchronized == null) {
    throw new PaymentSaleConflictError('sale payment could not be atomically invalidated')
  }
  return {
    state: 'invalid',
    ...invalid,
    targetReleased,
    evidenceSynchronized,
  }
}
