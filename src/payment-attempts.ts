import { createHash } from 'node:crypto'
import type { PaymentRequirements, SettledError } from './pay.ts'

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/
const TX_HASH_RE = /^0x[0-9a-f]{64}$/

type Query = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>

export interface PaymentAttemptRecord {
  paymentKey: string
  paymentKind: 'x402'
  status: 'initiated' | 'settled' | 'completed' | 'failed'
  actorId: number
  purpose: string
  payerWallet: string
  payeeWallet: string
  amountUsdc: number
  transactionHash: string | null
  completionTxHash: string | null
  completionKind: 'place' | 'kind_revision' | 'transfer_offer' | 'world_offer' | null
  completionId: number | null
  completionRevision: number | null
}

interface StoredRow extends Record<string, unknown> {
  payment_key: string
  payment_kind: string
  status: string
  actor_id: number
  purpose: string
  payer_wallet: string
  payee_wallet: string
  amount_usdc: number
  transaction_hash: string | null
  completion_tx_hash: string | null
  completion_kind: string | null
  completion_id: number | null
  completion_revision: number | null
}

export interface X402AttemptDraft {
  actorId: number
  purpose: string
  payeeWallet: string
  amountUsdc: number
  paymentHeader: string
  accepted: PaymentRequirements
}

export interface X402AttemptStart {
  attempt: PaymentAttemptRecord
  paymentPayload: unknown
  payerWallet: string
  paymentIdentifier: string
}

export const PAYMENT_ATTEMPT_CONFLICT = 'payment_attempt_conflict'

function paymentIdentifierFromPayload(payload: unknown): string | null {
  const extension = (payload as {
    extensions?: { 'payment-identifier'?: { id?: unknown } | string }
  })?.extensions?.['payment-identifier']
  if (typeof extension === 'string') return extension.trim() || null
  const id = extension && typeof extension === 'object' && !Array.isArray(extension)
    ? extension.id
    : null
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

function rowAttempt(row: StoredRow | undefined): PaymentAttemptRecord | null {
  if (!row) return null
  const paymentKey = String(row.payment_key ?? '')
  const paymentKind = String(row.payment_kind ?? '')
  const status = String(row.status ?? '')
  const payerWallet = String(row.payer_wallet ?? '').toLowerCase()
  const payeeWallet = String(row.payee_wallet ?? '').toLowerCase()
  const transactionHash = row.transaction_hash == null ? null : String(row.transaction_hash).toLowerCase()
  const completionTxHash = row.completion_tx_hash == null ? null : String(row.completion_tx_hash).toLowerCase()
  const completionKind = row.completion_kind == null ? null : String(row.completion_kind)
  const completionId = row.completion_id == null ? null : Number(row.completion_id)
  const completionRevision = row.completion_revision == null ? null : Number(row.completion_revision)
  if (
    !paymentKey || paymentKind !== 'x402' ||
    !['initiated', 'settled', 'completed', 'failed'].includes(status) ||
    !WALLET_RE.test(payerWallet) || !WALLET_RE.test(payeeWallet) ||
    typeof row.actor_id !== 'number' || typeof row.purpose !== 'string' ||
    typeof row.amount_usdc !== 'number' ||
    (transactionHash != null && !TX_HASH_RE.test(transactionHash)) ||
    (completionTxHash != null && !TX_HASH_RE.test(completionTxHash))
  ) return null
  return {
    paymentKey,
    paymentKind: 'x402',
    status: status as PaymentAttemptRecord['status'],
    actorId: row.actor_id,
    purpose: row.purpose,
    payerWallet,
    payeeWallet,
    amountUsdc: row.amount_usdc,
    transactionHash,
    completionTxHash,
    completionKind: completionKind as PaymentAttemptRecord['completionKind'],
    completionId,
    completionRevision,
  }
}

export function decodeX402PaymentHeader(paymentHeader: string): unknown | null {
  try {
    return JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')) as unknown
  } catch {
    return null
  }
}

export function x402PayerFromPayload(payload: unknown): string | null {
  const payer = (payload as { payload?: { authorization?: { from?: unknown } } })?.payload?.authorization?.from
  return typeof payer === 'string' && WALLET_RE.test(payer) ? payer.toLowerCase() : null
}

function paymentKey(paymentIdentifier: string): string {
  return createHash('sha256')
    .update(paymentIdentifier)
    .digest('hex')
}

function sameAttemptScope(
  attempt: PaymentAttemptRecord,
  draft: X402AttemptDraft,
  payerWallet: string,
): boolean {
  return attempt.actorId === draft.actorId
    && attempt.purpose === draft.purpose
    && attempt.payerWallet === payerWallet
    && attempt.payeeWallet === draft.payeeWallet.toLowerCase()
    && attempt.amountUsdc === draft.amountUsdc
}

export async function startX402PaymentAttempt(
  query: Query,
  draft: X402AttemptDraft,
): Promise<X402AttemptStart | SettledError> {
  const paymentPayload = decodeX402PaymentHeader(draft.paymentHeader)
  if (paymentPayload == null) return { error: 'X-PAYMENT header is not base64 JSON' }
  const paymentIdentifier = paymentIdentifierFromPayload(paymentPayload)
  if (!paymentIdentifier) return { error: 'X-PAYMENT must include a payment-identifier for safe retries' }
  const payerWallet = x402PayerFromPayload(paymentPayload)
  if (!payerWallet) return { error: 'X-PAYMENT must contain a valid payer address' }
  const key = paymentKey(paymentIdentifier)
  await query(`
    /* payment-attempts:initiate */
    INSERT INTO payment_attempts (
      payment_key, payment_kind, status, actor_id, purpose,
      payer_wallet, payee_wallet, amount_usdc, payment_payload
    )
    VALUES ($1, 'x402', 'initiated', $2, $3, lower($4), lower($5), $6, $7::jsonb)
    ON CONFLICT (payment_key) DO NOTHING
  `, [
    key,
    draft.actorId,
    draft.purpose,
    payerWallet,
    draft.payeeWallet,
    draft.amountUsdc,
    JSON.stringify(paymentPayload),
  ])
  const rows = await query(`
    /* payment-attempts:read */
    SELECT payment_key, payment_kind, status, actor_id, purpose,
      lower(payer_wallet) AS payer_wallet, lower(payee_wallet) AS payee_wallet,
      amount_usdc::float8 AS amount_usdc,
      transaction_hash, completion_tx_hash, completion_kind, completion_id, completion_revision
    FROM payment_attempts
    WHERE payment_key = $1
  `, [key])
  const attempt = rowAttempt(rows[0] as StoredRow | undefined)
  if (!attempt) return { error: 'payment attempt record is unavailable' }
  if (!sameAttemptScope(attempt, draft, payerWallet)) {
    return {
      error: 'X-PAYMENT payment-identifier is already bound to a different payer, actor, purpose, payee, or amount',
      code: PAYMENT_ATTEMPT_CONFLICT,
    }
  }
  return {
    attempt,
    paymentPayload,
    payerWallet,
    paymentIdentifier,
  }
}

export async function markX402PaymentSettled(
  query: Query,
  paymentKeyValue: string,
  transactionHash: string,
): Promise<PaymentAttemptRecord | null> {
  const rows = await query(`
    /* payment-attempts:settled */
    UPDATE payment_attempts
    SET status = CASE WHEN status = 'completed' THEN status ELSE 'settled' END,
      transaction_hash = coalesce(transaction_hash, $2),
      settled_at = coalesce(settled_at, clock_timestamp())
    WHERE payment_key = $1
      AND (transaction_hash IS NULL OR transaction_hash = $2)
    RETURNING payment_key, payment_kind, status, actor_id, purpose,
      lower(payer_wallet) AS payer_wallet, lower(payee_wallet) AS payee_wallet,
      amount_usdc::float8 AS amount_usdc,
      transaction_hash, completion_tx_hash, completion_kind, completion_id, completion_revision
  `, [paymentKeyValue, transactionHash])
  return rowAttempt(rows[0] as StoredRow | undefined)
}

export async function markX402PaymentCompleted(
  query: Query,
  paymentKeyValue: string,
  completion: {
    completionTxHash: string
    completionKind: NonNullable<PaymentAttemptRecord['completionKind']>
    completionId: number
    completionRevision?: number | null
  },
): Promise<PaymentAttemptRecord | null> {
  const rows = await query(`
    /* payment-attempts:completed */
    UPDATE payment_attempts
    SET status = 'completed',
      transaction_hash = coalesce(transaction_hash, $2),
      completion_tx_hash = $2,
      completion_kind = $3,
      completion_id = $4,
      completion_revision = $5,
      completed_at = clock_timestamp()
    WHERE payment_key = $1
    RETURNING payment_key, payment_kind, status, actor_id, purpose,
      lower(payer_wallet) AS payer_wallet, lower(payee_wallet) AS payee_wallet,
      amount_usdc::float8 AS amount_usdc,
      transaction_hash, completion_tx_hash, completion_kind, completion_id, completion_revision
  `, [
    paymentKeyValue,
    completion.completionTxHash,
    completion.completionKind,
    completion.completionId,
    completion.completionRevision ?? null,
  ])
  return rowAttempt(rows[0] as StoredRow | undefined)
}
