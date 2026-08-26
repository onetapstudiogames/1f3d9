import { createHash } from 'node:crypto'

const WALLET_RE = /^0x[0-9a-f]{40}$/u
const HASH_RE = /^0x[0-9a-f]{64}$/u
const SHA256_RE = /^[0-9a-f]{64}$/u
const TOKEN_RE = /^0x[0-9a-f]{40}$/u
const PUBLIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]+$/u
const PAYMENT_RESPONSE_HEADER_RE = /^[A-Za-z0-9+/]+={0,2}$/u
const MAX_FACILITATOR_RESPONSE_BYTES = 65_536
const MAX_PAYMENT_RESPONSE_HEADER_LENGTH = 4 * Math.ceil(MAX_FACILITATOR_RESPONSE_BYTES / 3)
const MAX_PAYMENT_RESPONSE_BODY_BYTES = 200_000
const DURABLE_X402_RESPONSE_KEY = '__1f3d9_x402_response_v1'
export const PAYMENT_RECOVERY_WINDOW_MILLISECONDS = 2 * 60 * 60 * 1_000
export const MAX_RECOVERABLE_PAYMENT_ATTEMPTS = 100

const PAYMENT_ATTEMPT_OPERATIONS = [
  'frontier', 'kind_invention', 'kind_revision', 'direct_sale', 'world_sale', 'legacy',
] as const
const PAYMENT_ATTEMPT_ASSET_TYPES = ['place', 'thing', 'kind'] as const
const PAYMENT_ATTEMPT_METHODS = ['x402', 'credit', 'claim', 'legacy'] as const
const PAYMENT_ATTEMPT_STATUSES = [
  'settling', 'payment_pending', 'completed', 'invalid', 'expired', 'needs_review',
  'founder_review', 'legacy_completed', 'credit_returned',
] as const

export type PaymentAttemptStatus =
  | 'settling'
  | 'payment_pending'
  | 'completed'
  | 'invalid'
  | 'expired'
  | 'needs_review'
  | 'founder_review'
  | 'legacy_completed'
  | 'credit_returned'

export interface PaymentAttemptRecord {
  publicId: string
  actorId: number
  counterpartyId: number | null
  operation: 'frontier' | 'kind_invention' | 'kind_revision' | 'direct_sale' | 'world_sale' | 'legacy'
  targetKey: string | null
  offerId: number | null
  assetType: 'place' | 'thing' | 'kind' | null
  assetId: number | null
  request: Record<string, unknown> | null
  requestHash: string | null
  method: 'x402' | 'credit' | 'claim' | 'legacy' | null
  network: 'base' | null
  token: string | null
  payerWallet: string | null
  payeeWallet: string | null
  amountUnits: bigint | null
  x402Nonce: string | null
  x402PayloadDigest: string | null
  x402ValidAfter: bigint | null
  x402ValidBefore: bigint | null
  startBlock: bigint | null
  startTime: string | null
  endTime: string | null
  status: PaymentAttemptStatus
  leaseOwner: string | null
  leaseExpiresAt: string | null
  recoveryStartedAt: string | null
  recoveryDeadlineAt: string | null
  txHash: string | null
  finalizedBlockNumber: bigint | null
  finalizedBlockHash: string | null
  finalizedBlockTime: string | null
  finalizedAt: string | null
  invalidReason: string | null
  result: Record<string, unknown> | null
  responseStatus: number | null
  response: Record<string, unknown> | null
  responseBody?: string | null
  paymentResponseHeader?: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface PrivatePaymentAttempt {
  id: string
  state: PaymentAttemptStatus
  operation: PaymentAttemptRecord['operation']
  method: PaymentAttemptRecord['method']
  target: string | null
  request: Record<string, unknown> | null
  result: Record<string, unknown> | null
  recovery_started_at: string | null
  recovery_deadline_at: string | null
  do_not_pay_again: boolean
  next_action: 'wait_or_recheck' | 'recheck_for_late_finality' | 'await_founder_review'
    | 'complete' | 'credit_returned' | 'closed'
  transaction?: string
  network?: 'base'
  token?: string
  recipient?: string
  amount_units?: string
}

type PaymentAttemptQueryRow = Record<string, unknown> | PaymentAttemptRecord

export interface PaymentAttemptQueryable {
  query(text: string, params?: readonly unknown[] | any[]): Promise<readonly PaymentAttemptQueryRow[]>
}

export type PaymentAttemptQuery = (
  text: string,
  params?: readonly unknown[] | any[],
) => Promise<readonly PaymentAttemptQueryRow[]>

export type PaymentAttemptDatabase = PaymentAttemptQueryable | PaymentAttemptQuery

export interface PaymentAttemptInput {
  actorId: number
  counterpartyId?: number | null
  operation: PaymentAttemptRecord['operation']
  targetKey?: string | null
  offerId?: number | null
  assetType?: PaymentAttemptRecord['assetType']
  assetId?: number | null
  request: unknown
  method: Exclude<PaymentAttemptRecord['method'], 'legacy'> | null
  network: PaymentAttemptRecord['network']
  token: string | null
  payerWallet: string | null
  payeeWallet: string | null
  amountUnits: bigint | null
  x402Nonce?: string | null
  x402PayloadDigest?: string | null
  x402ValidAfter?: bigint | null
  x402ValidBefore?: bigint | null
  startBlock?: bigint | null
  startTime?: string | null
  endTime?: string | null
}

export class PaymentAttemptConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentAttemptConflictError'
  }
}

export class PaymentAttemptEvidenceConflictError extends PaymentAttemptConflictError {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentAttemptEvidenceConflictError'
  }
}

type CanonicalJson = null | boolean | string | number | CanonicalJson[] | { [key: string]: CanonicalJson }

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeJson(value: unknown, seen: Set<object>): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('canonical JSON requires safe integers only')
    return value
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError('canonical JSON rejects sparse arrays')
    return value.map(item => normalizeJson(item, seen))
  }
  if (typeof value !== 'object') throw new TypeError('canonical JSON supports only JSON values')
  if (seen.has(value)) throw new TypeError('canonical JSON rejects cyclic values')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('canonical JSON requires plain objects')
  }
  seen.add(value)
  try {
    const output: Record<string, CanonicalJson> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child === undefined) throw new TypeError('canonical JSON rejects undefined values')
      output[key] = normalizeJson(child, seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

export function canonicalPaymentRequest(value: unknown): { json: string; hash: string } {
  const json = JSON.stringify(normalizeJson(value, new Set()))
  return { json, hash: sha256Hex(json) }
}

export function x402NonceKey(input: {
  network: 'base'
  token: string
  payerWallet: string
  nonce: string
}): string {
  const token = input.token.toLowerCase()
  const payerWallet = input.payerWallet.toLowerCase()
  const nonce = input.nonce.toLowerCase()
  if (input.network !== 'base') throw new TypeError('x402 nonce key requires Base')
  if (!TOKEN_RE.test(token)) throw new TypeError('x402 nonce key requires a token address')
  if (!WALLET_RE.test(payerWallet)) throw new TypeError('x402 nonce key requires a payer wallet')
  if (!HASH_RE.test(nonce)) throw new TypeError('x402 nonce key requires a 32-byte nonce')
  return `base:${token}:${payerWallet}:${nonce}`
}

function rowValue(row: Record<string, unknown>, camel: string, snake = camel): unknown {
  return camel in row ? row[camel] : row[snake]
}

async function runQuery(
  database: PaymentAttemptDatabase,
  text: string,
  params: readonly unknown[],
): Promise<readonly PaymentAttemptQueryRow[]> {
  return typeof database === 'function'
    ? await database(text, params)
    : await database.query(text, params)
}

export async function paymentResponseReplayReady(
  database: PaymentAttemptDatabase,
): Promise<boolean> {
  try {
    const row = (await runQuery(database, `
      /* payment-attempts:response-replay-ready */
      SELECT (
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute attribute
          JOIN pg_catalog.pg_class relation
            ON relation.oid = attribute.attrelid
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = 'payment_attempts'
            AND attribute.attname = 'response_body_bytes'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
        AND to_regprocedure(
          'public.complete_payment_attempt(text,text,jsonb,smallint,jsonb,bytea)'
        ) IS NOT NULL
      ) AS ready
    `, []))[0] as Record<string, unknown> | undefined
    return row?.ready === true || row?.ready === 't'
  } catch {
    return false
  }
}

function isoString(value: unknown): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new TypeError('invalid timestamp row')
  return date.toISOString()
}

function integer(value: unknown): number | null {
  if (value == null) return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new TypeError('invalid integer row')
  return parsed
}

function bigintValue(value: unknown): bigint | null {
  if (value == null) return null
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value)
  throw new TypeError('invalid bigint row')
}

function hashValue(value: unknown): string | null {
  if (value == null) return null
  const hash = String(value).toLowerCase()
  if (!HASH_RE.test(hash)) throw new TypeError('invalid hash row')
  return hash
}

function walletValue(value: unknown): string | null {
  if (value == null) return null
  const wallet = String(value).toLowerCase()
  if (!WALLET_RE.test(wallet)) throw new TypeError('invalid wallet row')
  return wallet
}

function shaValue(value: unknown): string | null {
  if (value == null) return null
  const digest = String(value).toLowerCase()
  if (!SHA256_RE.test(digest)) throw new TypeError('invalid digest row')
  return digest
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid JSON object row')
  return value as Record<string, unknown>
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]))
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && jsonValuesEqual(leftRecord[key], rightRecord[key]))
}

function rawResponseBodyBytes(value: unknown): Buffer | null {
  if (value == null) return null
  if (typeof value === 'string') {
    if (/^\\x[0-9a-f]*$/iu.test(value)) return Buffer.from(value.slice(2), 'hex')
    return Buffer.from(value, 'utf8')
  }
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new TypeError('invalid payment response body row')
}

function paymentResponseBodyValue(
  value: unknown,
  expectedResponse: Record<string, unknown> | null,
): string | null {
  const bytes = rawResponseBodyBytes(value)
  if (bytes == null) return null
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_PAYMENT_RESPONSE_BODY_BYTES) {
    throw new TypeError('invalid payment response body row')
  }
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new TypeError('invalid payment response body row')
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    throw new TypeError('invalid payment response body row')
  }
  if (
    !decoded || typeof decoded !== 'object' || Array.isArray(decoded)
    || expectedResponse == null
    || !jsonValuesEqual(decoded, expectedResponse)
  ) throw new TypeError('invalid payment response body row')
  return text
}

function encodeValidatedResponseBody(
  responseBody: string,
  expectedResponse: Record<string, unknown>,
): string {
  const bytes = Buffer.from(responseBody, 'utf8')
  if (
    responseBody.length === 0
    || bytes.byteLength < 2
    || bytes.byteLength > MAX_PAYMENT_RESPONSE_BODY_BYTES
  ) throw new TypeError('invalid payment response body')
  let decoded: unknown
  try {
    decoded = JSON.parse(responseBody)
  } catch {
    throw new TypeError('invalid payment response body')
  }
  if (
    !decoded || typeof decoded !== 'object' || Array.isArray(decoded)
    || !jsonValuesEqual(decoded, expectedResponse)
  ) throw new TypeError('invalid payment response body')
  return bytes.toString('base64')
}

function paymentResponseHeaderValue(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PAYMENT_RESPONSE_HEADER_LENGTH
    || !PAYMENT_RESPONSE_HEADER_RE.test(value)
  ) return null
  try {
    const decoded = Buffer.from(value, 'base64')
    if (
      decoded.byteLength === 0
      || decoded.byteLength > MAX_FACILITATOR_RESPONSE_BYTES
      || decoded.toString('base64') !== value
    ) return null
    const parsed = JSON.parse(decoded.toString('utf8')) as unknown
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? value : null
  } catch {
    return null
  }
}

function durablePaymentResponse(value: Record<string, unknown> | null): {
  header: string
  body: Record<string, unknown> | null
} | null {
  if (!value || Object.keys(value).length !== 1) return null
  const envelopeValue = value[DURABLE_X402_RESPONSE_KEY]
  if (!envelopeValue || typeof envelopeValue !== 'object' || Array.isArray(envelopeValue)) return null
  const envelope = envelopeValue as Record<string, unknown>
  if (Object.keys(envelope).some(key => key !== 'header' && key !== 'body')) return null
  const header = paymentResponseHeaderValue(envelope.header)
  if (!header) return null
  if (!Object.hasOwn(envelope, 'body')) return { header, body: null }
  const body = envelope.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  return { header, body: body as Record<string, unknown> }
}

function textValue(value: unknown): string | null {
  return value == null ? null : String(value)
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
  nullable = false,
): T[number] | null {
  if (value == null && nullable) return null
  const text = String(value ?? '')
  if (!(allowed as readonly string[]).includes(text)) throw new TypeError(`invalid ${label} row`)
  return text as T[number]
}

function tokenValue(value: unknown): string | null {
  if (value == null) return null
  const token = String(value).toLowerCase()
  if (!TOKEN_RE.test(token)) throw new TypeError('invalid token row')
  return token
}

function requiredTimestamp(row: Record<string, unknown>, camel: string, snake: string): string {
  const value = isoString(rowValue(row, camel, snake))
  if (value == null) throw new TypeError(`invalid ${snake} row`)
  return value
}

function recoveryWindow(row: Record<string, unknown>): {
  recoveryStartedAt: string | null
  recoveryDeadlineAt: string | null
} {
  const recoveryStartedAt = isoString(rowValue(row, 'recoveryStartedAt', 'recovery_started_at'))
  const recoveryDeadlineAt = isoString(rowValue(row, 'recoveryDeadlineAt', 'recovery_deadline_at'))
  if ((recoveryStartedAt == null) !== (recoveryDeadlineAt == null)) {
    throw new TypeError('invalid recovery window row')
  }
  if (
    recoveryStartedAt != null
    && recoveryDeadlineAt != null
    && new Date(recoveryDeadlineAt).getTime() - new Date(recoveryStartedAt).getTime()
      !== PAYMENT_RECOVERY_WINDOW_MILLISECONDS
  ) throw new TypeError('invalid recovery window row')
  return { recoveryStartedAt, recoveryDeadlineAt }
}

function requestValue(
  row: Record<string, unknown>,
  requestHash: string | null,
): Record<string, unknown> | null {
  const request = objectValue(rowValue(row, 'request', 'request_json'))
  if ((request == null) !== (requestHash == null)) throw new TypeError('invalid payment request row')
  if (request != null && canonicalPaymentRequest(request).hash !== requestHash) {
    throw new TypeError('payment request row does not match its immutable hash')
  }
  return request
}

function paymentAttemptFromRow(row: Record<string, unknown> | undefined): PaymentAttemptRecord | null {
  if (!row) return null
  const publicId = String(rowValue(row, 'publicId', 'public_id') ?? '')
  const operation = enumValue(rowValue(row, 'operation'), PAYMENT_ATTEMPT_OPERATIONS, 'operation')
  const status = enumValue(rowValue(row, 'status'), PAYMENT_ATTEMPT_STATUSES, 'status')
  const actorId = integer(rowValue(row, 'actorId', 'actor_id'))
  if (!PUBLIC_ID_RE.test(publicId)) throw new TypeError('invalid public id row')
  if (actorId == null) throw new TypeError('invalid actor row')
  const requestHash = shaValue(rowValue(row, 'requestHash', 'request_hash'))
  const request = requestValue(row, requestHash)
  const recovery = recoveryWindow(row)
  const storedResponse = objectValue(rowValue(row, 'response', 'response_json'))
  const durableResponse = durablePaymentResponse(storedResponse)
  const directPaymentResponseHeader = paymentResponseHeaderValue(
    rowValue(row, 'paymentResponseHeader', 'payment_response_header'),
  )
  const paymentResponseHeader = durableResponse?.header ?? directPaymentResponseHeader
  const response = durableResponse ? durableResponse.body : storedResponse
  const responseBody = paymentResponseBodyValue(
    rowValue(row, 'responseBody', 'response_body_bytes'),
    response,
  )
  return {
    publicId,
    actorId,
    counterpartyId: integer(rowValue(row, 'counterpartyId', 'counterparty_id')),
    operation: operation!,
    targetKey: textValue(rowValue(row, 'targetKey', 'target_key')),
    offerId: integer(rowValue(row, 'offerId', 'offer_id')),
    assetType: enumValue(
      rowValue(row, 'assetType', 'asset_type'),
      PAYMENT_ATTEMPT_ASSET_TYPES,
      'asset type',
      true,
    ),
    assetId: integer(rowValue(row, 'assetId', 'asset_id')),
    request,
    requestHash,
    method: enumValue(rowValue(row, 'method'), PAYMENT_ATTEMPT_METHODS, 'payment method', true),
    network: enumValue(rowValue(row, 'network'), ['base'] as const, 'network', true),
    token: tokenValue(rowValue(row, 'token')),
    payerWallet: walletValue(rowValue(row, 'payerWallet', 'payer_wallet')),
    payeeWallet: walletValue(rowValue(row, 'payeeWallet', 'payee_wallet')),
    amountUnits: bigintValue(rowValue(row, 'amountUnits', 'amount_units')),
    x402Nonce: hashValue(rowValue(row, 'x402Nonce', 'x402_nonce')),
    x402PayloadDigest: shaValue(rowValue(row, 'x402PayloadDigest', 'x402_payload_digest')),
    x402ValidAfter: bigintValue(rowValue(row, 'x402ValidAfter', 'x402_valid_after')),
    x402ValidBefore: bigintValue(rowValue(row, 'x402ValidBefore', 'x402_valid_before')),
    startBlock: bigintValue(rowValue(row, 'startBlock', 'start_block')),
    startTime: isoString(rowValue(row, 'startTime', 'start_time')),
    endTime: isoString(rowValue(row, 'endTime', 'end_time')),
    status: status!,
    leaseOwner: textValue(rowValue(row, 'leaseOwner', 'lease_owner')),
    leaseExpiresAt: isoString(rowValue(row, 'leaseExpiresAt', 'lease_expires_at')),
    ...recovery,
    txHash: hashValue(rowValue(row, 'txHash', 'tx_hash')),
    finalizedBlockNumber: bigintValue(rowValue(row, 'finalizedBlockNumber', 'finalized_block_number')),
    finalizedBlockHash: hashValue(rowValue(row, 'finalizedBlockHash', 'finalized_block_hash')),
    finalizedBlockTime: isoString(rowValue(row, 'finalizedBlockTime', 'finalized_block_time')),
    finalizedAt: isoString(rowValue(row, 'finalizedAt', 'finalized_at')),
    invalidReason: textValue(rowValue(row, 'invalidReason', 'invalid_reason')),
    result: objectValue(rowValue(row, 'result', 'result_json')),
    responseStatus: integer(rowValue(row, 'responseStatus', 'response_status')),
    response,
    responseBody,
    ...(paymentResponseHeader ? { paymentResponseHeader } : {}),
    createdAt: requiredTimestamp(row, 'createdAt', 'created_at'),
    updatedAt: requiredTimestamp(row, 'updatedAt', 'updated_at'),
    completedAt: isoString(rowValue(row, 'completedAt', 'completed_at')),
  }
}

function sameImmutableTerms(
  attempt: PaymentAttemptRecord,
  input: PaymentAttemptInput,
  requestHash: string,
  allowCompletedTargetChange = false,
): boolean {
  return attempt.actorId === input.actorId
    && attempt.counterpartyId === (input.counterpartyId ?? null)
    && attempt.operation === input.operation
    && (allowCompletedTargetChange || attempt.targetKey === (input.targetKey ?? null))
    && attempt.offerId === (input.offerId ?? null)
    && attempt.assetType === (input.assetType ?? null)
    && attempt.assetId === (input.assetId ?? null)
    && attempt.requestHash === requestHash
    && attempt.method === input.method
    && attempt.network === input.network
    && attempt.token === (input.token?.toLowerCase() ?? null)
    && attempt.payerWallet === (input.payerWallet?.toLowerCase() ?? null)
    && attempt.payeeWallet === (input.payeeWallet?.toLowerCase() ?? null)
    && attempt.amountUnits === (input.amountUnits ?? null)
    && attempt.x402Nonce === (input.x402Nonce?.toLowerCase() ?? null)
    && attempt.x402PayloadDigest === (input.x402PayloadDigest?.toLowerCase() ?? null)
    && attempt.x402ValidAfter === (input.x402ValidAfter ?? null)
    && attempt.x402ValidBefore === (input.x402ValidBefore ?? null)
    && attempt.startBlock === (input.startBlock ?? null)
    && attempt.startTime === (input.startTime ?? null)
    && attempt.endTime === (input.endTime ?? null)
}

function canReplayExistingAttempt(
  attempt: PaymentAttemptRecord,
  input: PaymentAttemptInput,
  requestHash: string,
): boolean {
  return sameImmutableTerms(attempt, input, requestHash)
    || (
      attempt.status === 'completed'
      && sameImmutableTerms(attempt, input, requestHash, true)
    )
}

function conflict(message = 'payment attempt is already bound to different immutable terms'): never {
  throw new PaymentAttemptConflictError(message)
}

function evidenceConflict(message: string): never {
  throw new PaymentAttemptEvidenceConflictError(message)
}

function requiredHash(value: string, label: string): string {
  const hash = hashValue(value)
  if (!hash) throw new TypeError(`${label} requires a 32-byte hash`)
  return hash
}

function reasonValue(value: string): string {
  if (Buffer.byteLength(value, 'utf8') < 1 || Buffer.byteLength(value, 'utf8') > 240) {
    throw new TypeError('payment attempt reason is outside its byte limit')
  }
  return value
}

function finalityValue(finality: {
  blockNumber: bigint
  blockHash: string
  blockTime: string
  finalizedAt: string
}): {
  blockNumber: bigint
  blockHash: string
  blockTime: string
  finalizedAt: string
} {
  if (finality.blockNumber < 0n) throw new TypeError('invalid finalized block number')
  const blockHash = requiredHash(finality.blockHash, 'finality')
  const blockTime = isoString(finality.blockTime)
  const finalizedAt = isoString(finality.finalizedAt)
  if (!blockTime || !finalizedAt) throw new TypeError('invalid finality timestamp')
  return { blockNumber: finality.blockNumber, blockHash, blockTime, finalizedAt }
}

function readByTargetOrNonce(input: PaymentAttemptInput): { text: string; params: readonly unknown[] } {
  return {
    text: `
      /* payment-attempts:find */
      WITH closed_due_target AS (
        UPDATE payment_attempts
        SET status = 'expired',
          invalid_reason = coalesce(invalid_reason, 'automatic recovery deadline reached'),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
        WHERE $1::text IS NOT NULL
          AND operation = $2
          AND operation IN ('frontier', 'kind_invention', 'kind_revision')
          AND target_key = $1
          AND method = 'x402'
          AND status IN ('settling', 'payment_pending', 'needs_review')
          AND recovery_deadline_at IS NOT NULL
          AND recovery_deadline_at <= clock_timestamp()
        RETURNING public_id
      )
      SELECT attempt.*
      FROM payment_attempts attempt
      WHERE (
        ($1::text IS NOT NULL AND attempt.operation = $2 AND attempt.target_key = $1)
        OR (
          $3::text IS NOT NULL
          AND attempt.network = $4
          AND attempt.token = lower($5)
          AND attempt.payer_wallet = lower($6)
          AND attempt.x402_nonce = lower($3)
        )
      )
        AND attempt.status IN ('settling', 'payment_pending', 'needs_review', 'completed')
        AND attempt.public_id NOT IN (SELECT public_id FROM closed_due_target)
      ORDER BY attempt.created_at DESC
      LIMIT 1
    `,
    params: [
      input.targetKey ?? null,
      input.operation,
      input.x402Nonce ?? null,
      input.network,
      input.token ?? null,
      input.payerWallet ?? null,
    ],
  }
}

function sameReplayableTargetTerms(
  attempt: PaymentAttemptRecord,
  input: {
    actorId: number
    counterpartyId?: number | null
    operation: Exclude<PaymentAttemptRecord['operation'], 'legacy'>
    targetKey: string
    offerId?: number | null
    assetType?: PaymentAttemptRecord['assetType']
    assetId?: number | null
  },
  requestHash: string,
): boolean {
  return attempt.actorId === input.actorId
    && attempt.counterpartyId === (input.counterpartyId ?? null)
    && attempt.operation === input.operation
    && attempt.targetKey === input.targetKey
    && attempt.offerId === (input.offerId ?? null)
    && attempt.assetType === (input.assetType ?? null)
    && attempt.assetId === (input.assetId ?? null)
    && attempt.requestHash === requestHash
    && attempt.method === 'x402'
}

export async function findReplayableTargetPaymentAttempt(
  database: PaymentAttemptDatabase,
  input: {
    actorId: number
    counterpartyId?: number | null
    operation: Exclude<PaymentAttemptRecord['operation'], 'legacy'>
    targetKey: string
    offerId?: number | null
    assetType?: PaymentAttemptRecord['assetType']
    assetId?: number | null
    request: unknown
  },
): Promise<PaymentAttemptRecord | null> {
  const request = canonicalPaymentRequest(input.request)
  const existing = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:find-replayable-target */
    WITH closed_due_target AS (
      UPDATE payment_attempts
      SET status = 'expired',
        invalid_reason = coalesce(invalid_reason, 'automatic recovery deadline reached'),
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = clock_timestamp()
      WHERE operation = $2
        AND operation IN ('frontier', 'kind_invention', 'kind_revision')
        AND target_key = $3
        AND method = 'x402'
        AND status IN ('settling', 'payment_pending', 'needs_review')
        AND recovery_deadline_at IS NOT NULL
        AND recovery_deadline_at <= clock_timestamp()
      RETURNING public_id
    )
    SELECT attempt.*
    FROM payment_attempts attempt
    WHERE attempt.actor_id = $1
      AND attempt.operation = $2
      AND attempt.target_key = $3
      AND attempt.status IN ('settling', 'payment_pending', 'needs_review', 'completed')
      AND attempt.public_id NOT IN (SELECT public_id FROM closed_due_target)
    ORDER BY attempt.created_at DESC, attempt.public_id DESC
    LIMIT 1
  `, [
    input.actorId,
    input.operation,
    input.targetKey,
  ]))[0] as Record<string, unknown> | undefined)
  if (!existing) return null
  if (!sameReplayableTargetTerms(existing, input, request.hash)) {
    conflict()
  }
  return existing
}

export async function createOrReadPaymentAttempt(
  database: PaymentAttemptDatabase,
  input: PaymentAttemptInput,
  nextPublicId: () => string,
): Promise<{ disposition: 'existing' | 'created'; attempt: PaymentAttemptRecord }> {
  const request = canonicalPaymentRequest(input.request)
  const lookup = readByTargetOrNonce(input)
  const existing = paymentAttemptFromRow((await runQuery(database, lookup.text, lookup.params))[0] as Record<string, unknown> | undefined)
  if (existing) {
    if (!canReplayExistingAttempt(existing, input, request.hash)) conflict()
    return { disposition: 'existing', attempt: existing }
  }

  const created = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:create */
    INSERT INTO payment_attempts (
      public_id, actor_id, counterparty_id, operation, target_key, offer_id,
      asset_type, asset_id, request_hash, request_json, method, network, token,
      payer_wallet, payee_wallet, amount_units, x402_nonce, x402_payload_digest,
      x402_valid_after, x402_valid_before, start_block, start_time, end_time, status
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10::jsonb, $11, $12, lower($13),
      lower($14), lower($15), $16, lower($17), lower($18),
      $19, $20, $21, $22::timestamptz, $23::timestamptz, 'settling'
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [
    nextPublicId(),
    input.actorId,
    input.counterpartyId ?? null,
    input.operation,
    input.targetKey ?? null,
    input.offerId ?? null,
    input.assetType ?? null,
    input.assetId ?? null,
    request.hash,
    request.json,
    input.method,
    input.network,
    input.token ?? null,
    input.payerWallet ?? null,
    input.payeeWallet ?? null,
    input.amountUnits?.toString() ?? null,
    input.x402Nonce ?? null,
    input.x402PayloadDigest ?? null,
    input.x402ValidAfter?.toString() ?? null,
    input.x402ValidBefore?.toString() ?? null,
    input.startBlock?.toString() ?? null,
    input.startTime ?? null,
    input.endTime ?? null,
  ]))[0] as Record<string, unknown> | undefined)
  if (created) return { disposition: 'created', attempt: created }

  const raced = paymentAttemptFromRow((await runQuery(database, lookup.text, lookup.params))[0] as Record<string, unknown> | undefined)
  if (!raced || !canReplayExistingAttempt(raced, input, request.hash)) conflict()
  return { disposition: 'existing', attempt: raced }
}

export async function acquireSettlementLease(
  database: PaymentAttemptDatabase,
  input: { publicId: string; actorId: number; leaseMilliseconds: number },
  nextLeaseOwner: () => string,
): Promise<
  | { acquired: true; attempt: PaymentAttemptRecord; leaseOwner: string }
  | { acquired: false; attempt: PaymentAttemptRecord | null }
> {
  const leaseOwner = nextLeaseOwner()
  const leased = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:lease */
    UPDATE payment_attempts
    SET lease_owner = $3,
      lease_expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
      updated_at = clock_timestamp()
    WHERE public_id = $1
      AND actor_id = $2
      AND status IN ('settling', 'payment_pending', 'needs_review')
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    RETURNING *
  `, [input.publicId, input.actorId, leaseOwner, input.leaseMilliseconds]))[0] as Record<string, unknown> | undefined)
  if (leased) return { acquired: true, attempt: leased, leaseOwner }
  const current = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:lease-read */
    SELECT *
    FROM payment_attempts
    WHERE public_id = $1 AND actor_id = $2
    LIMIT 1
  `, [input.publicId, input.actorId]))[0] as Record<string, unknown> | undefined)
  return { acquired: false, attempt: current }
}

/** Acquire the short processing lease only once the immutable recovery deadline is due. */
export async function acquireDueSettlementLease(
  database: PaymentAttemptDatabase,
  input: { publicId: string; actorId: number; leaseMilliseconds: number },
  nextLeaseOwner: () => string,
): Promise<
  | { acquired: true; attempt: PaymentAttemptRecord; leaseOwner: string }
  | { acquired: false; attempt: PaymentAttemptRecord | null }
> {
  if (!PUBLIC_ID_RE.test(input.publicId) || !Number.isSafeInteger(input.actorId) || input.actorId < 1) {
    throw new TypeError('due payment lease identity is invalid')
  }
  if (
    !Number.isSafeInteger(input.leaseMilliseconds)
    || input.leaseMilliseconds < 1
    || input.leaseMilliseconds > 30_000
  ) throw new TypeError('due payment lease must be between 1 and 30000 milliseconds')
  const leaseOwner = nextLeaseOwner()
  if (typeof leaseOwner !== 'string' || Buffer.byteLength(leaseOwner, 'utf8') < 1
    || Buffer.byteLength(leaseOwner, 'utf8') > 128) {
    throw new TypeError('due payment lease owner is invalid')
  }
  const leased = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:lease-due */
    UPDATE payment_attempts
    SET lease_owner = $3,
      lease_expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
      updated_at = greatest(updated_at, clock_timestamp())
    WHERE public_id = $1
      AND actor_id = $2
      AND status IN ('settling', 'payment_pending', 'needs_review')
      AND recovery_deadline_at IS NOT NULL
      AND recovery_deadline_at <= clock_timestamp()
      AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
    RETURNING *
  `, [input.publicId, input.actorId, leaseOwner, input.leaseMilliseconds]))[0] as Record<string, unknown> | undefined)
  if (leased) return { acquired: true, attempt: leased, leaseOwner }
  const current = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:lease-due-read */
    SELECT *
    FROM payment_attempts
    WHERE public_id = $1 AND actor_id = $2
    LIMIT 1
  `, [input.publicId, input.actorId]))[0] as Record<string, unknown> | undefined)
  return { acquired: false, attempt: current }
}

export async function bindPaymentEvidence(
  database: PaymentAttemptDatabase,
  input: {
    publicId: string
    leaseOwner: string
    txHash: string
    finality: null | {
      blockNumber: bigint
      blockHash: string
      blockTime: string
      finalizedAt: string
    }
    paymentResponseHeader?: string | null
  },
): Promise<PaymentAttemptRecord> {
  const txHash = requiredHash(input.txHash, 'payment evidence')
  const finality = input.finality == null ? null : finalityValue(input.finality)
  const responseHeader = input.paymentResponseHeader == null
    ? null
    : paymentResponseHeaderValue(input.paymentResponseHeader)
  if (input.paymentResponseHeader != null && !responseHeader) {
    throw new TypeError('invalid payment response header')
  }
  const updated = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:bind-evidence */
    UPDATE payment_attempts
    SET tx_hash = coalesce(tx_hash, lower($3)),
      status = 'payment_pending',
      finalized_block_number = coalesce(finalized_block_number, $4),
      finalized_block_hash = coalesce(finalized_block_hash, lower($5)),
      finalized_block_time = coalesce(finalized_block_time, $6::timestamptz),
      finalized_at = coalesce(finalized_at, $7::timestamptz),
      recovery_started_at = coalesce(recovery_started_at, statement_timestamp()),
      recovery_deadline_at = coalesce(
        recovery_deadline_at,
        recovery_started_at + interval '2 hours',
        statement_timestamp() + interval '2 hours'
      ),
      response_json = CASE
        WHEN $8::text IS NULL THEN response_json
        WHEN response_json IS NULL THEN jsonb_build_object(
          '${DURABLE_X402_RESPONSE_KEY}', jsonb_build_object('header', $8::text)
        )
        ELSE response_json
      END,
      updated_at = clock_timestamp()
    WHERE public_id = $1
      AND lease_owner = $2
      AND status IN ('settling', 'payment_pending', 'needs_review')
      AND (tx_hash IS NULL OR tx_hash = $3)
      AND ($5::text IS NULL OR finalized_block_hash IS NULL OR finalized_block_hash = $5)
      AND (recovery_deadline_at IS NULL OR recovery_deadline_at > clock_timestamp())
      AND (
        $8::text IS NULL
        OR response_json IS NULL
        OR response_json #>> '{${DURABLE_X402_RESPONSE_KEY},header}' = $8::text
      )
    RETURNING *
  `, [
    input.publicId,
    input.leaseOwner,
    txHash,
    finality?.blockNumber.toString() ?? null,
    finality?.blockHash ?? null,
    finality?.blockTime ?? null,
    finality?.finalizedAt ?? null,
    responseHeader,
  ]))[0] as Record<string, unknown> | undefined)
  if (updated) return updated
  const currentRow = (await runQuery(database, `
    /* payment-attempts:evidence-read */
    SELECT payment_attempts.*,
      recovery_deadline_at IS NOT NULL
        AND recovery_deadline_at <= clock_timestamp() AS recovery_due
    FROM payment_attempts
    WHERE public_id = $1
    LIMIT 1
  `, [input.publicId]))[0] as Record<string, unknown> | undefined
  const current = paymentAttemptFromRow(currentRow)
  if (!current || (current.txHash != null && current.txHash !== txHash)) {
    conflict('payment evidence conflicts with an existing transaction')
  }
  if (currentRow?.recovery_due === true || currentRow?.recovery_due === 't') {
    conflict('payment recovery deadline has passed')
  }
  if (responseHeader != null && current.paymentResponseHeader !== responseHeader) {
    conflict('payment evidence conflicts with an existing facilitator response')
  }
  return current
}

export async function releaseSettlementLease(
  database: PaymentAttemptDatabase,
  input: { publicId: string; leaseOwner: string },
): Promise<PaymentAttemptRecord> {
  const released = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:release-lease */
    UPDATE payment_attempts
    SET lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE public_id = $1
      AND lease_owner = $2
      AND status IN ('settling', 'payment_pending', 'needs_review')
    RETURNING *
  `, [input.publicId, input.leaseOwner]))[0] as Record<string, unknown> | undefined)
  if (released) return released
  const current = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:release-lease-read */
    SELECT * FROM payment_attempts WHERE public_id = $1 LIMIT 1
  `, [input.publicId]))[0] as Record<string, unknown> | undefined)
  if (!current) conflict('payment attempt is unavailable')
  return current
}

export async function completePaymentAttempt(
  database: PaymentAttemptDatabase,
  input: {
    publicId: string
    leaseOwner: string
    result: Record<string, unknown>
    responseStatus: number
    response: Record<string, unknown>
    responseBody: string
  },
): Promise<PaymentAttemptRecord> {
  const encodedResponseBody = encodeValidatedResponseBody(input.responseBody, input.response)
  const completed = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:complete */
    UPDATE payment_attempts
    SET status = 'completed',
      result_json = $3::jsonb,
      response_status = $4,
      response_json = CASE
        WHEN response_json #>> '{${DURABLE_X402_RESPONSE_KEY},header}' IS NULL THEN $5::jsonb
        ELSE jsonb_build_object(
          '${DURABLE_X402_RESPONSE_KEY}',
          jsonb_build_object(
            'header', response_json #>> '{${DURABLE_X402_RESPONSE_KEY},header}',
            'body', $5::jsonb
          )
        )
      END,
      response_body_bytes = decode($6, 'base64'),
      completed_at = coalesce(completed_at, clock_timestamp()),
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE public_id = $1
      AND lease_owner = $2
      AND status = 'payment_pending'
      AND tx_hash IS NOT NULL
      AND finalized_block_number IS NOT NULL
      AND finalized_block_hash IS NOT NULL
      AND finalized_block_time IS NOT NULL
      AND finalized_at IS NOT NULL
      AND recovery_deadline_at IS NOT NULL
      AND recovery_deadline_at > clock_timestamp()
    RETURNING *
  `, [
    input.publicId,
    input.leaseOwner,
    JSON.stringify(input.result),
    input.responseStatus,
    JSON.stringify(input.response),
    encodedResponseBody,
  ]))[0] as Record<string, unknown> | undefined)
  if (completed) return completed
  const current = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:complete-read */
    SELECT *
    FROM payment_attempts
    WHERE public_id = $1
    LIMIT 1
  `, [input.publicId]))[0] as Record<string, unknown> | undefined)
  if (!current || current.status !== 'completed') conflict('payment attempt cannot complete from its current state')
  return current
}

export async function invalidatePaymentAttempt(
  database: PaymentAttemptDatabase,
  input: { publicId: string; leaseOwner: string; reason: string },
): Promise<PaymentAttemptRecord> {
  const invalid = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:invalidate */
    UPDATE payment_attempts
    SET status = 'invalid',
      invalid_reason = $3,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE public_id = $1
      AND lease_owner = $2
      AND status IN ('settling', 'payment_pending', 'needs_review')
    RETURNING *
  `, [input.publicId, input.leaseOwner, input.reason]))[0] as Record<string, unknown> | undefined)
  if (invalid) return invalid
  const current = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:invalidate-read */
    SELECT *
    FROM payment_attempts
    WHERE public_id = $1
    LIMIT 1
  `, [input.publicId]))[0] as Record<string, unknown> | undefined)
  if (!current || current.status !== 'invalid') conflict('payment attempt cannot be invalidated from its current state')
  return current
}

export async function expirePaymentAttempt(
  database: PaymentAttemptDatabase,
  input: { publicId: string; leaseOwner: string; reason: string },
): Promise<PaymentAttemptRecord> {
  const reason = reasonValue(input.reason)
  const expired = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:expire */
    UPDATE payment_attempts
    SET status = 'expired',
      invalid_reason = $3,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE public_id = $1
      AND lease_owner = $2
      AND method IS DISTINCT FROM 'credit'
      AND status IN ('settling', 'payment_pending', 'needs_review')
      AND recovery_deadline_at IS NOT NULL
      AND recovery_deadline_at <= clock_timestamp()
    RETURNING *
  `, [input.publicId, input.leaseOwner, reason]))[0] as Record<string, unknown> | undefined)
  if (expired) return expired
  const current = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:expire-read */
    SELECT *
    FROM payment_attempts
    WHERE public_id = $1
    LIMIT 1
  `, [input.publicId]))[0] as Record<string, unknown> | undefined)
  if (!current || current.status !== 'expired') conflict('payment attempt cannot expire from its current state')
  return current
}

export async function markPaymentAttemptNeedsReview(
  database: PaymentAttemptDatabase,
  input: { publicId: string; leaseOwner: string; reason: string },
): Promise<PaymentAttemptRecord> {
  const reason = reasonValue(input.reason)
  const review = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:needs-review */
    UPDATE payment_attempts
    SET status = 'needs_review',
      invalid_reason = $3,
      recovery_started_at = coalesce(recovery_started_at, statement_timestamp()),
      recovery_deadline_at = coalesce(
        recovery_deadline_at,
        recovery_started_at + interval '2 hours',
        statement_timestamp() + interval '2 hours'
      ),
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE public_id = $1
      AND lease_owner = $2
      AND status IN ('settling', 'payment_pending', 'needs_review')
      AND (recovery_deadline_at IS NULL OR recovery_deadline_at > clock_timestamp())
    RETURNING *
  `, [input.publicId, input.leaseOwner, reason]))[0] as Record<string, unknown> | undefined)
  if (review) return review
  const current = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:needs-review-read */
    SELECT * FROM payment_attempts WHERE public_id = $1 LIMIT 1
  `, [input.publicId]))[0] as Record<string, unknown> | undefined)
  if (!current || current.status !== 'needs_review') {
    conflict('payment attempt cannot enter review from its current state')
  }
  return current
}

export async function listRecoverablePaymentAttempts(
  database: PaymentAttemptDatabase,
  input: { limit: number },
): Promise<readonly PaymentAttemptRecord[]> {
  if (
    !Number.isInteger(input.limit)
    || input.limit < 1
    || input.limit > MAX_RECOVERABLE_PAYMENT_ATTEMPTS
  ) throw new TypeError(`payment recovery limit must be between 1 and ${MAX_RECOVERABLE_PAYMENT_ATTEMPTS}`)
  const rows = await runQuery(database, `
    /* payment-attempts:list-recoverable */
    SELECT *
    FROM payment_attempts
    WHERE status IN ('settling', 'payment_pending', 'needs_review')
      AND recovery_started_at IS NOT NULL
      AND recovery_deadline_at IS NOT NULL
      AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
    ORDER BY recovery_deadline_at ASC, updated_at ASC, public_id ASC
    LIMIT $1
  `, [input.limit])
  return rows.map(row => {
    const attempt = paymentAttemptFromRow(row as Record<string, unknown>)
    if (!attempt) throw new TypeError('payment attempt row is unavailable')
    return attempt
  })
}

export async function markPaymentAttemptFounderReview(
  database: PaymentAttemptDatabase,
  input: { publicId: string; leaseOwner: string; reason: string },
): Promise<PaymentAttemptRecord> {
  const reason = reasonValue(input.reason)
  const review = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:founder-review */
    UPDATE payment_attempts
    SET status = 'founder_review',
      invalid_reason = coalesce(invalid_reason, $3),
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE public_id = $1
      AND lease_owner = $2
      AND status IN ('settling', 'payment_pending', 'needs_review')
    RETURNING *
  `, [input.publicId, input.leaseOwner, reason]))[0] as Record<string, unknown> | undefined)
  if (review) return review
  const current = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:founder-review-read */
    SELECT * FROM payment_attempts WHERE public_id = $1 LIMIT 1
  `, [input.publicId]))[0] as Record<string, unknown> | undefined)
  if (!current || current.status !== 'founder_review') {
    conflict('payment attempt cannot enter founder review from its current state')
  }
  return current
}

export async function appendLateFinalityEvidence(
  database: PaymentAttemptDatabase,
  input: {
    publicId: string
    txHash: string
    finality: {
      blockNumber: bigint
      blockHash: string
      blockTime: string
      finalizedAt: string
    }
    reason: string
  },
): Promise<PaymentAttemptRecord> {
  const txHash = requiredHash(input.txHash, 'late payment evidence')
  const finality = finalityValue(input.finality)
  reasonValue(input.reason)
  const review = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:append-late-finality */
    UPDATE payment_attempts
    SET status = 'founder_review',
      tx_hash = coalesce(tx_hash, lower($2)),
      finalized_block_number = coalesce(finalized_block_number, $3),
      finalized_block_hash = coalesce(finalized_block_hash, lower($4)),
      finalized_block_time = coalesce(finalized_block_time, $5::timestamptz),
      finalized_at = coalesce(finalized_at, $6::timestamptz),
      invalid_reason = coalesce(invalid_reason, $7),
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE public_id = $1
      AND (tx_hash IS NULL OR tx_hash = lower($2))
      AND method = 'x402'
      AND status = 'expired'
      AND recovery_deadline_at IS NOT NULL
      AND recovery_deadline_at <= clock_timestamp()
      AND (
        (
          finalized_block_number IS NULL
          AND finalized_block_hash IS NULL
          AND finalized_block_time IS NULL
          AND finalized_at IS NULL
        )
        OR (
          finalized_block_number = $3
          AND finalized_block_hash = lower($4)
          AND finalized_block_time = $5::timestamptz
          AND finalized_at IS NOT NULL
        )
      )
    RETURNING *
  `, [
    input.publicId,
    txHash,
    finality.blockNumber.toString(),
    finality.blockHash,
    finality.blockTime,
    finality.finalizedAt,
    input.reason,
  ]))[0] as Record<string, unknown> | undefined)
  if (review) return review
  const current = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:append-late-finality-read */
    SELECT * FROM payment_attempts WHERE public_id = $1 LIMIT 1
  `, [input.publicId]))[0] as Record<string, unknown> | undefined)
  if (
    !current
    || current.status !== 'founder_review'
    || current.txHash !== txHash
    || current.finalizedBlockNumber !== finality.blockNumber
    || current.finalizedBlockHash !== finality.blockHash
    || current.finalizedBlockTime !== finality.blockTime
    || current.finalizedAt == null
  ) evidenceConflict('late payment evidence conflicts with the preserved payment attempt')
  return current
}

const SAFE_REQUEST_KEYS: Readonly<Record<PaymentAttemptRecord['operation'], readonly string[]>> = {
  frontier: [
    'parent_id', 'name', 'description', 'open_to_building', 'open_to_things', 'open_to_notes',
  ],
  kind_invention: ['name', 'description', 'traits', 'recipe'],
  kind_revision: ['kind_id', 'description', 'traits', 'recipe'],
  direct_sale: [
    'offer_id', 'buyer_wallet', 'seller_wallet', 'price_usdc', 'asset_type', 'asset_id',
  ],
  world_sale: [
    'offer_id', 'market_checkout_id', 'market_listing_id', 'market_draft_id',
    'market_buyer', 'buyer_wallet', 'seller_wallet', 'price_usdc', 'asset_id',
  ],
  legacy: [],
}

function allowlistedJsonObject(
  value: Record<string, unknown> | null,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (value == null) return null
  const safe: Record<string, unknown> = {}
  for (const key of keys) {
    if (Object.hasOwn(value, key)) safe[key] = normalizeJson(value[key], new Set())
  }
  return safe
}

function safePaymentResult(value: Record<string, unknown> | null): Record<string, unknown> | null {
  return allowlistedJsonObject(value, ['kind', 'id', 'revision'])
}

export function paymentAttemptCanRecheckLateFinality(
  attempt: Pick<PaymentAttemptRecord, 'status' | 'method' | 'recoveryStartedAt'>,
): boolean {
  return attempt.status === 'expired'
    && attempt.method === 'x402'
    && attempt.recoveryStartedAt != null
}

function paymentAttemptNextAction(attempt: PaymentAttemptRecord): PrivatePaymentAttempt['next_action'] {
  if (['settling', 'payment_pending', 'needs_review'].includes(attempt.status)) {
    return 'wait_or_recheck'
  }
  if (paymentAttemptCanRecheckLateFinality(attempt)) return 'recheck_for_late_finality'
  if (attempt.status === 'founder_review') return 'await_founder_review'
  if (attempt.status === 'completed' || attempt.status === 'legacy_completed') return 'complete'
  if (attempt.status === 'credit_returned') return 'credit_returned'
  return 'closed'
}

function paymentAttemptDoNotPayAgain(attempt: PaymentAttemptRecord): boolean {
  if (attempt.status === 'expired') return attempt.recoveryStartedAt != null
  return [
    'payment_pending', 'needs_review', 'founder_review', 'completed', 'invalid',
    'legacy_completed', 'credit_returned',
  ].includes(attempt.status)
}

export function toPrivatePaymentAttempt(
  row: Record<string, unknown> | PaymentAttemptRecord,
): PrivatePaymentAttempt {
  const attempt = paymentAttemptFromRow(row as Record<string, unknown>)
  if (!attempt) throw new TypeError('payment attempt row is unavailable')
  return {
    id: attempt.publicId,
    state: attempt.status,
    operation: attempt.operation,
    method: attempt.method,
    target: attempt.targetKey,
    request: allowlistedJsonObject(attempt.request, SAFE_REQUEST_KEYS[attempt.operation]),
    result: safePaymentResult(attempt.result),
    ...(attempt.txHash ? { transaction: attempt.txHash } : {}),
    recovery_started_at: attempt.recoveryStartedAt,
    recovery_deadline_at: attempt.recoveryDeadlineAt,
    do_not_pay_again: paymentAttemptDoNotPayAgain(attempt),
    ...(attempt.network ? { network: attempt.network } : {}),
    ...(attempt.token ? { token: attempt.token } : {}),
    ...(attempt.payeeWallet ? { recipient: attempt.payeeWallet } : {}),
    ...(attempt.amountUnits != null ? { amount_units: attempt.amountUnits.toString() } : {}),
    next_action: paymentAttemptNextAction(attempt),
  }
}

export function toPublicPaymentAttempt(row: Record<string, unknown> | PaymentAttemptRecord): Record<string, unknown> {
  const attempt = paymentAttemptFromRow(row as Record<string, unknown>)
  if (!attempt) throw new TypeError('payment attempt row is unavailable')
  return {
    id: attempt.publicId,
    state: attempt.status,
    do_not_pay_again: paymentAttemptDoNotPayAgain(attempt),
    ...(attempt.txHash ? { transaction: attempt.txHash } : {}),
    ...(attempt.responseStatus != null ? { response_status: attempt.responseStatus } : {}),
    ...(attempt.response ? { response: attempt.response } : {}),
  }
}

export async function getPaymentAttempt(
  database: PaymentAttemptDatabase,
  input: { publicId: string; actorId: number },
): Promise<PrivatePaymentAttempt | null> {
  const attempt = await getPaymentAttemptRecord(database, input)
  return attempt ? toPrivatePaymentAttempt(attempt) : null
}

export async function getPaymentAttemptRecord(
  database: PaymentAttemptDatabase,
  input: { publicId: string; actorId: number },
): Promise<PaymentAttemptRecord | null> {
  return paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:get */
    SELECT *
    FROM payment_attempts
    WHERE public_id = $1 AND actor_id = $2
    LIMIT 1
  `, [input.publicId, input.actorId]))[0] as Record<string, unknown> | undefined)
}

export async function findPaymentAttempt(
  database: PaymentAttemptDatabase,
  input: {
    actorId: number
    operation: Exclude<PaymentAttemptRecord['operation'], 'legacy'>
    offerId: number
  },
): Promise<PaymentAttemptRecord | null> {
  return paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:find-operation */
    SELECT *
    FROM payment_attempts
    WHERE actor_id = $1
      AND operation = $2
      AND offer_id = $3
    ORDER BY created_at DESC
    LIMIT 1
  `, [input.actorId, input.operation, input.offerId]))[0] as Record<string, unknown> | undefined)
}
