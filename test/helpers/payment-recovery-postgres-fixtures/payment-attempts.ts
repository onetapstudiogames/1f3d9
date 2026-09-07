import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { canonicalPaymentRequest } from '../../../src/payment-attempts.ts'

export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const PAYER = `0x${'1'.repeat(40)}`
export const PAYEE = `0x${'2'.repeat(40)}`
export const TX = `0x${'3'.repeat(64)}`
export const BLOCK_HASH = `0x${'4'.repeat(64)}`
export const RESPONSE = { ok: true, place: { id: 91 } }
export const RESPONSE_BODY = JSON.stringify(RESPONSE)

export function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null
}

type AttemptOptions = Readonly<{
  publicId: string
  targetKey: string
  operation?: 'frontier' | 'direct_sale' | 'world_sale'
  status?: 'settling' | 'payment_pending' | 'needs_review' | 'expired'
  leaseOwner?: string | null
  txHash?: string | null
  finalized?: boolean
  recovery?: 'future' | 'due' | 'none'
  invalidReason?: string | null
}>

export async function insertAttempt(database: Pool, options: AttemptOptions): Promise<void> {
  const request = { name: options.targetKey.split(':').at(-1), parent_id: null }
  const canonical = canonicalPaymentRequest(request)
  const finalized = options.finalized === true
  await database.query(`
    INSERT INTO payment_attempts (
      public_id, actor_id, operation, target_key, request_hash, request_json,
      method, network, token, payer_wallet, payee_wallet, amount_units,
      x402_nonce, x402_payload_digest, start_block, start_time, end_time,
      status, lease_owner, lease_expires_at, tx_hash,
      finalized_block_number, finalized_block_hash, finalized_block_time, finalized_at,
      recovery_started_at, recovery_deadline_at, invalid_reason
    ) VALUES (
      $1, 2, $16, $2, $3, $4::jsonb,
      'x402', 'base', $5, $6, $7, 1000000,
      $8, repeat('6', 64), 50000000,
      clock_timestamp() - interval '15 minutes', clock_timestamp() + interval '15 minutes',
      $9, $10, CASE WHEN $10::text IS NULL THEN NULL ELSE clock_timestamp() + interval '30 seconds' END,
      $11,
      CASE WHEN $12 THEN 50000001 ELSE NULL END,
      CASE WHEN $12 THEN $13 ELSE NULL END,
      CASE WHEN $12 THEN clock_timestamp() - interval '1 minute' ELSE NULL END,
      CASE WHEN $12 THEN clock_timestamp() ELSE NULL END,
      CASE $14
        WHEN 'future' THEN date_trunc('milliseconds', statement_timestamp()) - interval '1 hour'
        WHEN 'due' THEN date_trunc('milliseconds', statement_timestamp()) - interval '2 hours'
        ELSE NULL
      END,
      CASE $14
        WHEN 'future' THEN date_trunc('milliseconds', statement_timestamp()) + interval '1 hour'
        WHEN 'due' THEN date_trunc('milliseconds', statement_timestamp())
        ELSE NULL
      END,
      $15
    )
  `, [
    options.publicId,
    options.targetKey,
    canonical.hash,
    canonical.json,
    USDC,
    PAYER,
    PAYEE,
    `0x${randomBytes(32).toString('hex')}`,
    options.status ?? 'payment_pending',
    options.leaseOwner ?? null,
    options.txHash === undefined ? `0x${randomBytes(32).toString('hex')}` : options.txHash,
    finalized,
    BLOCK_HASH,
    options.recovery ?? 'future',
    options.invalidReason === undefined
      ? options.status === 'expired' ? 'automatic recovery deadline reached' : null
      : options.invalidReason,
    options.operation ?? 'frontier',
  ])
}
