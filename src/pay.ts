import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import { NETWORK, USDC, toUnits } from './chain.ts'

export const TREASURY = (
  process.env.TREASURY_ADDRESS ?? '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
).toLowerCase()
export const CLAIM_FEE_USDC = 1
export const CLAIM_WINDOW_SECONDS = 300

const FACILITATOR = process.env.FACILITATOR_URL ?? 'https://facilitator.payai.network'
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/
const MAX_PAYMENT_HEADER_BYTES = 32_768
const MAX_FACILITATOR_RESPONSE_BYTES = 65_536
const FACILITATOR_TIMEOUT_MS = 8_000
export const PAYMENT_CUSTODY_UNAVAILABLE =
  'payments are temporarily unavailable while durable payment custody is being upgraded; do not pay or retry yet'

export function paymentCustodyReady(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const hosted = environment.NODE_ENV === 'production'
    || environment.VERCEL === '1'
    || environment.VERCEL_ENV != null
  return !hosted || environment.PAYMENT_CUSTODY_READY === '1'
}

export function paymentReadinessResponse(c: Context): Response | null {
  if (paymentCustodyReady()) return null
  return c.json({ error: PAYMENT_CUSTODY_UNAVAILABLE }, 503)
}

export function canonicalTxHash(value: unknown): string | null {
  return typeof value === 'string' && TX_HASH_RE.test(value) ? value.toLowerCase() : null
}

export interface PaymentRequirements {
  scheme: 'exact'
  network: typeof NETWORK
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: 'application/json'
  payTo: string
  maxTimeoutSeconds: number
  asset: string
  extra: { name: 'USD Coin'; version: '2' }
}

export function requirements(
  payTo: string,
  usdc: number,
  resource: string,
  description: string,
): PaymentRequirements {
  return {
    scheme: 'exact',
    network: NETWORK,
    maxAmountRequired: toUnits(usdc).toString(),
    resource,
    description,
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds: CLAIM_WINDOW_SECONDS,
    asset: USDC,
    extra: { name: 'USD Coin', version: '2' },
  }
}

function formatUsdcAmount(amountUnits: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(amountUnits)) {
    throw new TypeError('payment requirement amount must use integer USDC units')
  }
  const units = BigInt(amountUnits)
  const whole = units / 1_000_000n
  const fraction = (units % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${fraction}`
}

export function challenge402(c: Context, accepted: PaymentRequirements, note: string) {
  const amountUsdc = formatUsdcAmount(accepted.maxAmountRequired)
  const warning =
    'Never copy a recipient from wallet history; zero-value lookalike transfers can poison wallet history.'
  return c.json({
    x402Version: 1,
    error:
      `${note} Pay exactly ${amountUsdc} USDC on Base using contract ${accepted.asset} ` +
      `to ${accepted.payTo}. Verify with this current 402 response or /api/official. ${warning}`,
    payment_safety: {
      network: 'Base',
      usdc_contract: accepted.asset,
      recipient: accepted.payTo,
      amount_usdc: amountUsdc,
      amount_units: accepted.maxAmountRequired,
      verify_with: 'this current 402 response or /api/official',
      warning,
    },
    accepts: [accepted],
  }, 402)
}

export interface Settled {
  transaction: string
  payer: string
  raw: Record<string, unknown>
}

export interface SettledError {
  error: string
  code?: string
}

export interface X402Authorization {
  payer: string
  payee: string
  amountUnits: string
  nonce: string
  validAfter: number
  validBefore: number
  identity: string
  payloadDigest: string
}

export interface ParsedX402Payment {
  paymentPayload: Record<string, unknown>
  authorization: X402Authorization
  accepted: PaymentRequirements
}

export type ParsedX402Result = ParsedX402Payment | SettledError

export type VerifiedX402Payment = ParsedX402Payment & {
  state: 'verified'
  verificationPayer: string | null
}

export type X402VerificationResult = VerifiedX402Payment
  | { state: 'invalid'; error: string }
  | { state: 'unavailable'; error: string }

export type X402SettlementResult =
  | { state: 'settled'; transaction: string; payer: string; response: Record<string, unknown> }
  | { state: 'ambiguous'; transaction: string | null; payer: string; error: string }

function decimalInteger(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function safeTimestamp(value: unknown): number | null {
  const parsed = decimalInteger(value)
  return parsed != null && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function canonicalValue(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('value has no exact canonical JSON representation')
    return String(value)
  }
  if (typeof value !== 'object') throw new TypeError('value has no exact canonical JSON representation')
  if (seen.has(value)) throw new TypeError('value has no exact canonical JSON representation')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new TypeError('value has no exact canonical JSON representation')
      }
      return `[${value.map(item => canonicalValue(item, seen)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('value has no exact canonical JSON representation')
    }
    const recordValue = value as Record<string, unknown>
    return `{${Object.keys(recordValue).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalValue(recordValue[key], seen)}`,
    ).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function canonicalJson(value: unknown): string {
  return canonicalValue(value, new Set())
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function parseX402Payment(
  paymentHeader: string,
  accepted: PaymentRequirements,
): ParsedX402Result {
  if (
    typeof paymentHeader !== 'string' || paymentHeader.length === 0 ||
    paymentHeader.length > MAX_PAYMENT_HEADER_BYTES
  ) return { error: 'X-PAYMENT header is too large' }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(paymentHeader) || paymentHeader.length % 4 !== 0) {
    return { error: 'X-PAYMENT header is not base64 JSON' }
  }

  let paymentPayload: Record<string, unknown>
  try {
    const decoded = Buffer.from(paymentHeader, 'base64').toString('utf8')
    const parsed = JSON.parse(decoded)
    const parsedRecord = record(parsed)
    if (!parsedRecord) throw new Error('not an object')
    paymentPayload = parsedRecord
  } catch {
    return { error: 'X-PAYMENT header is not base64 JSON' }
  }

  const payload = record(paymentPayload.payload)
  const authorization = record(payload?.authorization)
  const payer = typeof authorization?.from === 'string' && WALLET_RE.test(authorization.from)
    ? authorization.from.toLowerCase()
    : null
  const payee = typeof authorization?.to === 'string' && WALLET_RE.test(authorization.to)
    ? authorization.to.toLowerCase()
    : null
  const amount = decimalInteger(authorization?.value)
  const validAfter = safeTimestamp(authorization?.validAfter)
  const validBefore = safeTimestamp(authorization?.validBefore)
  const nonce = typeof authorization?.nonce === 'string' && NONCE_RE.test(authorization.nonce)
    ? authorization.nonce.toLowerCase()
    : null

  if (
    paymentPayload.x402Version !== 1 || paymentPayload.scheme !== 'exact' ||
    paymentPayload.network !== NETWORK || !payload || typeof payload.signature !== 'string'
  ) return { error: 'X-PAYMENT does not use the required exact Base authorization' }
  if (!payer) return { error: 'X-PAYMENT contains an invalid payer' }
  if (!payee || payee !== accepted.payTo.toLowerCase()) {
    return { error: 'X-PAYMENT recipient does not match this request' }
  }
  if (amount == null || amount.toString() !== accepted.maxAmountRequired) {
    return { error: 'X-PAYMENT amount does not match this request' }
  }
  if (!nonce) return { error: 'X-PAYMENT contains an invalid nonce' }
  if (validAfter == null || validBefore == null || validBefore <= validAfter + 1) {
    return { error: 'X-PAYMENT contains an invalid authorization window' }
  }

  const identity = sha256Hex(`${NETWORK}:${accepted.asset.toLowerCase()}:${payer}:${nonce}`)
  const payloadDigest = sha256Hex(canonicalJson(paymentPayload))
  return {
    paymentPayload,
    accepted,
    authorization: {
      payer,
      payee,
      amountUnits: amount.toString(),
      nonce,
      validAfter,
      validBefore,
      identity,
      payloadDigest,
    },
  }
}

async function boundedJson(
  response: Response,
  label: string,
): Promise<{ value: Record<string, unknown> | null; error?: string }> {
  if (!response.body) return { value: null }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_FACILITATOR_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return { value: null, error: `${label} response was too large` }
      }
      chunks.push(next.value)
    }
  } catch {
    return { value: null, error: `${label} response could not be read` }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { value: record(JSON.parse(new TextDecoder().decode(bytes))) }
  } catch {
    return { value: null }
  }
}

function facilitatorRequest(parsed: ParsedX402Payment): RequestInit {
  return {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      x402Version: 1,
      paymentPayload: parsed.paymentPayload,
      paymentRequirements: parsed.accepted,
    }),
    signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
  }
}

export async function verifyX402Payment(
  paymentHeader: string,
  accepted: PaymentRequirements,
  fetcher: typeof fetch = fetch,
): Promise<X402VerificationResult> {
  const parsed = parseX402Payment(paymentHeader, accepted)
  if ('error' in parsed) return { state: 'invalid', error: parsed.error }
  try {
    const response = await fetcher(`${FACILITATOR}/verify`, facilitatorRequest(parsed))
    const decoded = await boundedJson(response, 'facilitator verification')
    if (decoded.error) return { state: 'unavailable', error: decoded.error }
    const payer = typeof decoded.value?.payer === 'string' && WALLET_RE.test(decoded.value.payer)
      ? decoded.value.payer.toLowerCase()
      : null
    if (
      !response.ok || decoded.value?.isValid !== true ||
      (decoded.value?.payer != null && payer !== parsed.authorization.payer)
    ) return { state: 'invalid', error: 'facilitator rejected the payment' }
    return { ...parsed, state: 'verified', verificationPayer: payer }
  } catch {
    return { state: 'unavailable', error: 'facilitator verification is unavailable' }
  }
}

export async function settleVerifiedX402(
  verified: VerifiedX402Payment,
  fetcher: typeof fetch = fetch,
): Promise<X402SettlementResult> {
  try {
    const response = await fetcher(`${FACILITATOR}/settle`, facilitatorRequest(verified))
    const decoded = await boundedJson(response, 'facilitator settlement')
    if (decoded.error) {
      return {
        state: 'ambiguous', transaction: null, payer: verified.authorization.payer,
        error: decoded.error,
      }
    }
    const transaction = canonicalTxHash(decoded.value?.transaction)
    const payer = typeof decoded.value?.payer === 'string' && WALLET_RE.test(decoded.value.payer)
      ? decoded.value.payer.toLowerCase()
      : verified.authorization.payer
    if (decoded.value?.success === true && response.ok && transaction && payer === verified.authorization.payer) {
      return { state: 'settled', transaction, payer, response: decoded.value! }
    }
    return {
      state: 'ambiguous',
      transaction,
      payer: verified.authorization.payer,
      error: typeof decoded.value?.errorReason === 'string'
        ? decoded.value.errorReason.slice(0, 240)
        : 'settlement outcome is unknown',
    }
  } catch {
    return {
      state: 'ambiguous', transaction: null, payer: verified.authorization.payer,
      error: 'settlement outcome is unknown',
    }
  }
}

export function paymentResponseHeader(settled: Settled): string {
  return Buffer.from(JSON.stringify(settled.raw)).toString('base64')
}
