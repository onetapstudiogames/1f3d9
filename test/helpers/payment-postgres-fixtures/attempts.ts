import assert from 'node:assert/strict'
import type { Pool } from 'pg'

export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

export const SELLER_WALLET = `0x${'1'.repeat(40)}`

export const BUYER_WALLET = `0x${'2'.repeat(40)}`

export const OTHER_WALLET = `0x${'3'.repeat(40)}`

export const FACILITATOR_RESPONSE_HEADER = Buffer.from(JSON.stringify({
  success: true,
  transaction: hash('4'),
  payer: BUYER_WALLET,
  network: 'base',
  facilitator: 'https://facilitator.example.test',
})).toString('base64')

export function hash(digit: string): string {
  return `0x${digit.repeat(64)}`
}

export function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null
}

export async function rejectsWithCode(promise: Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(promise, error => postgresCode(error) === expected)
}

interface AttemptInput {
  publicId: string
  actorId?: number
  counterpartyId?: number | null
  operation: 'frontier' | 'kind_invention' | 'kind_revision' | 'direct_sale' | 'world_sale'
  targetKey?: string | null
  status?: 'settling' | 'payment_pending' | 'completed' | 'invalid' | 'expired'
  payerWallet?: string | null
  nonce?: string | null
  txHash?: string | null
  requestHash?: string | null
  request?: Record<string, unknown> | null
  createdAt?: string | null
}

export async function insertAttempt(database: Pool, input: AttemptInput): Promise<void> {
  const x402 = input.nonce != null
  const completedAt = input.status === 'completed'
    ? new Date(Date.now() + 60_000).toISOString()
    : null
  await database.query(`
    INSERT INTO payment_attempts (
      public_id, actor_id, counterparty_id, operation, target_key,
      request_hash, request_json, method, network, token, payer_wallet, payee_wallet, amount_units,
      x402_nonce, status, tx_hash,
      finalized_block_number, finalized_block_hash, finalized_block_time,
      finalized_at, result_json, response_status, response_json, completed_at,
      created_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $25::jsonb, $7, $8, $9, $10, $11, $12,
      $13, $14, $15,
      $16, $17, $18, $19, $20::jsonb, $21, $22::jsonb, $23,
      COALESCE($24::timestamptz, now())
    )
  `, [
    input.publicId,
    input.actorId ?? 1,
    input.counterpartyId ?? null,
    input.operation,
    input.targetKey ?? null,
    input.requestHash ?? null,
    x402 ? 'x402' : null,
    x402 ? 'base' : null,
    x402 ? BASE_USDC : null,
    input.payerWallet ?? null,
    x402 ? SELLER_WALLET : null,
    x402 ? 1_000_000 : null,
    input.nonce ?? null,
    input.status ?? 'settling',
    input.txHash ?? null,
    input.status === 'completed' ? 22_000_010 : null,
    input.status === 'completed' ? hash('8') : null,
    input.status === 'completed' ? '2026-08-16T12:00:30Z' : null,
    completedAt,
    input.status === 'completed' ? JSON.stringify({ test: true }) : null,
    input.status === 'completed' ? 200 : null,
    input.status === 'completed' ? JSON.stringify({ ok: true }) : null,
    completedAt,
    input.createdAt ?? null,
    input.request == null ? null : JSON.stringify(input.request),
  ])
}
