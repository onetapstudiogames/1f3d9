import { createHash } from 'node:crypto'

const WALLET_RE = /^0x[0-9a-f]{40}$/u
const HASH_RE = /^0x[0-9a-f]{64}$/u
const SHA256_RE = /^[0-9a-f]{64}$/u
const TOKEN_RE = /^0x[0-9a-f]{40}$/u
const PUBLIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]+$/u
const PAYMENT_RESPONSE_HEADER_RE = /^[A-Za-z0-9+/]+={0,2}$/u
const MAX_FACILITATOR_RESPONSE_BYTES = 65_536
const MAX_PAYMENT_RESPONSE_HEADER_LENGTH = 4 * Math.ceil(MAX_FACILITATOR_RESPONSE_BYTES / 3)
const DURABLE_X402_RESPONSE_KEY = '__1f3d9_x402_response_v1'

export type PaymentAttemptStatus =
  | 'settling'
  | 'payment_pending'
  | 'completed'
  | 'invalid'
  | 'expired'
  | 'needs_review'
  | 'legacy_completed'

export interface PaymentAttemptRecord {
  publicId: string
  actorId: number
  counterpartyId: number | null
  operation: 'frontier' | 'kind_invention' | 'kind_revision' | 'direct_sale' | 'world_sale' | 'legacy'
  targetKey: string | null
  offerId: number | null
  assetType: 'place' | 'thing' | 'kind' | null
  assetId: number | null
  requestHash: string | null
  method: 'x402' | 'claim' | 'legacy' | null
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
  txHash: string | null
  finalizedBlockNumber: bigint | null
  finalizedBlockHash: string | null
  finalizedBlockTime: string | null
  finalizedAt: string | null
  invalidReason: string | null
  result: Record<string, unknown> | null
  responseStatus: number | null
  response: Record<string, unknown> | null
  paymentResponseHeader?: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
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

function paymentAttemptFromRow(row: Record<string, unknown> | undefined): PaymentAttemptRecord | null {
  if (!row) return null
  const publicId = String(rowValue(row, 'publicId', 'public_id') ?? '')
  const operation = String(rowValue(row, 'operation') ?? '')
  const status = String(rowValue(row, 'status') ?? '')
  const actorId = integer(rowValue(row, 'actorId', 'actor_id'))
  if (!PUBLIC_ID_RE.test(publicId)) throw new TypeError('invalid public id row')
  if (actorId == null) throw new TypeError('invalid actor row')
  if (!['frontier', 'kind_invention', 'kind_revision', 'direct_sale', 'world_sale', 'legacy'].includes(operation)) {
    throw new TypeError('invalid operation row')
  }
  if (!['settling', 'payment_pending', 'completed', 'invalid', 'expired', 'needs_review', 'legacy_completed'].includes(status)) {
    throw new TypeError('invalid status row')
  }
  const storedResponse = objectValue(rowValue(row, 'response', 'response_json'))
  const durableResponse = durablePaymentResponse(storedResponse)
  const directPaymentResponseHeader = paymentResponseHeaderValue(
    rowValue(row, 'paymentResponseHeader', 'payment_response_header'),
  )
  const paymentResponseHeader = durableResponse?.header ?? directPaymentResponseHeader
  return {
    publicId,
    actorId,
    counterpartyId: integer(rowValue(row, 'counterpartyId', 'counterparty_id')),
    operation: operation as PaymentAttemptRecord['operation'],
    targetKey: textValue(rowValue(row, 'targetKey', 'target_key')),
    offerId: integer(rowValue(row, 'offerId', 'offer_id')),
    assetType: textValue(rowValue(row, 'assetType', 'asset_type')) as PaymentAttemptRecord['assetType'],
    assetId: integer(rowValue(row, 'assetId', 'asset_id')),
    requestHash: shaValue(rowValue(row, 'requestHash', 'request_hash')),
    method: textValue(rowValue(row, 'method')) as PaymentAttemptRecord['method'],
    network: textValue(rowValue(row, 'network')) as PaymentAttemptRecord['network'],
    token: textValue(rowValue(row, 'token'))?.toLowerCase() ?? null,
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
    status: status as PaymentAttemptStatus,
    leaseOwner: textValue(rowValue(row, 'leaseOwner', 'lease_owner')),
    leaseExpiresAt: isoString(rowValue(row, 'leaseExpiresAt', 'lease_expires_at')),
    txHash: hashValue(rowValue(row, 'txHash', 'tx_hash')),
    finalizedBlockNumber: bigintValue(rowValue(row, 'finalizedBlockNumber', 'finalized_block_number')),
    finalizedBlockHash: hashValue(rowValue(row, 'finalizedBlockHash', 'finalized_block_hash')),
    finalizedBlockTime: isoString(rowValue(row, 'finalizedBlockTime', 'finalized_block_time')),
    finalizedAt: isoString(rowValue(row, 'finalizedAt', 'finalized_at')),
    invalidReason: textValue(rowValue(row, 'invalidReason', 'invalid_reason')),
    result: objectValue(rowValue(row, 'result', 'result_json')),
    responseStatus: integer(rowValue(row, 'responseStatus', 'response_status')),
    response: durableResponse ? durableResponse.body : storedResponse,
    ...(paymentResponseHeader ? { paymentResponseHeader } : {}),
    createdAt: isoString(rowValue(row, 'createdAt', 'created_at')) ?? new Date(0).toISOString(),
    updatedAt: isoString(rowValue(row, 'updatedAt', 'updated_at')) ?? new Date(0).toISOString(),
    completedAt: isoString(rowValue(row, 'completedAt', 'completed_at')),
  }
}

function sameImmutableTerms(attempt: PaymentAttemptRecord, input: PaymentAttemptInput, requestHash: string): boolean {
  return attempt.actorId === input.actorId
    && attempt.counterpartyId === (input.counterpartyId ?? null)
    && attempt.operation === input.operation
    && attempt.targetKey === (input.targetKey ?? null)
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
    && attempt.startTime === (input.startTime ?? null)
    && attempt.endTime === (input.endTime ?? null)
}

function conflict(message = 'payment attempt is already bound to different immutable terms'): never {
  throw new PaymentAttemptConflictError(message)
}

function readByTargetOrNonce(input: PaymentAttemptInput): { text: string; params: readonly unknown[] } {
  return {
    text: `
      /* payment-attempts:find */
      SELECT *
      FROM payment_attempts
      WHERE (
        ($1::text IS NOT NULL AND operation = $2 AND target_key = $1)
        OR (
          $3::text IS NOT NULL
          AND network = $4
          AND token = lower($5)
          AND payer_wallet = lower($6)
          AND x402_nonce = lower($3)
        )
      )
        AND status IN ('settling', 'payment_pending', 'needs_review', 'completed')
      ORDER BY created_at DESC
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

export async function createOrReadPaymentAttempt(
  database: PaymentAttemptDatabase,
  input: PaymentAttemptInput,
  nextPublicId: () => string,
): Promise<{ disposition: 'existing' | 'created'; attempt: PaymentAttemptRecord }> {
  const request = canonicalPaymentRequest(input.request)
  const lookup = readByTargetOrNonce(input)
  const existing = paymentAttemptFromRow((await runQuery(database, lookup.text, lookup.params))[0] as Record<string, unknown> | undefined)
  if (existing) {
    if (!sameImmutableTerms(existing, input, request.hash)) conflict()
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
  if (!raced || !sameImmutableTerms(raced, input, request.hash)) conflict()
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
      AND (
        $8::text IS NULL
        OR response_json IS NULL
        OR response_json #>> '{${DURABLE_X402_RESPONSE_KEY},header}' = $8::text
      )
    RETURNING *
  `, [
    input.publicId,
    input.leaseOwner,
    input.txHash,
    input.finality?.blockNumber.toString() ?? null,
    input.finality?.blockHash ?? null,
    input.finality?.blockTime ?? null,
    input.finality?.finalizedAt ?? null,
    responseHeader,
  ]))[0] as Record<string, unknown> | undefined)
  if (updated) return updated
  const current = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:evidence-read */
    SELECT *
    FROM payment_attempts
    WHERE public_id = $1
    LIMIT 1
  `, [input.publicId]))[0] as Record<string, unknown> | undefined)
  if (!current || (current.txHash != null && current.txHash !== input.txHash.toLowerCase())) {
    conflict('payment evidence conflicts with an existing transaction')
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
  },
): Promise<PaymentAttemptRecord> {
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
    RETURNING *
  `, [
    input.publicId,
    input.leaseOwner,
    JSON.stringify(input.result),
    input.responseStatus,
    JSON.stringify(input.response),
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
      AND status = 'settling'
    RETURNING *
  `, [input.publicId, input.leaseOwner, input.reason]))[0] as Record<string, unknown> | undefined)
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
  const review = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:needs-review */
    UPDATE payment_attempts
    SET status = 'needs_review',
      invalid_reason = $3,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE public_id = $1
      AND lease_owner = $2
      AND status IN ('settling', 'payment_pending', 'needs_review')
    RETURNING *
  `, [input.publicId, input.leaseOwner, input.reason]))[0] as Record<string, unknown> | undefined)
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

export function toPublicPaymentAttempt(row: Record<string, unknown> | PaymentAttemptRecord): Record<string, unknown> {
  const attempt = paymentAttemptFromRow(row as Record<string, unknown>)
  if (!attempt) throw new TypeError('payment attempt row is unavailable')
  return {
    id: attempt.publicId,
    state: attempt.status,
    do_not_pay_again: ['payment_pending', 'needs_review', 'completed', 'invalid', 'legacy_completed'].includes(attempt.status),
    ...(attempt.txHash ? { transaction: attempt.txHash } : {}),
    ...(attempt.responseStatus != null ? { response_status: attempt.responseStatus } : {}),
    ...(attempt.response ? { response: attempt.response } : {}),
  }
}

export async function getPaymentAttempt(
  database: PaymentAttemptDatabase,
  input: { publicId: string; actorId: number },
): Promise<Record<string, unknown> | null> {
  const attempt = paymentAttemptFromRow((await runQuery(database, `
    /* payment-attempts:get */
    SELECT *
    FROM payment_attempts
    WHERE public_id = $1 AND actor_id = $2
    LIMIT 1
  `, [input.publicId, input.actorId]))[0] as Record<string, unknown> | undefined)
  return attempt ? toPublicPaymentAttempt(attempt) : null
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
