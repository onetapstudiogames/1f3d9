import {
  canonicalPaymentRequest,
  type PaymentAttemptInput,
  type PaymentAttemptQueryable,
  type PaymentAttemptRecord,
} from '../../../src/payment-attempts.ts'

export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const PAYER = '0x1111111111111111111111111111111111111111'
export const PAYEE = '0x2222222222222222222222222222222222222222'
export const NONCE = `0x${'33'.repeat(32)}`
export const TX = `0x${'44'.repeat(32)}`
export const BLOCK_HASH = `0x${'55'.repeat(32)}`
export const FACILITATOR_RESPONSE_HEADER = Buffer.from(JSON.stringify({
  success: true,
  transaction: TX,
  payer: PAYER,
  network: 'base',
  facilitator: 'https://facilitator.example.test',
})).toString('base64')
export const EXACT_RESPONSE_BODY = '{\n  "thing": { "id": 42 },\n  "ok": true\n}'

export class QueuedDatabase implements PaymentAttemptQueryable {
  readonly calls: { text: string; params: readonly unknown[] }[] = []
  readonly #rows: PaymentAttemptRecord[][]

  constructor(...rows: PaymentAttemptRecord[][]) {
    this.#rows = [...rows]
  }

  async query(text: string, params: readonly unknown[] = []): Promise<PaymentAttemptRecord[]> {
    this.calls.push({ text, params: [...params] })
    return this.#rows.shift() ?? []
  }
}

export function input(overrides: Partial<PaymentAttemptInput> = {}): PaymentAttemptInput {
  return {
    actorId: 7,
    counterpartyId: 8,
    operation: 'direct_sale',
    targetKey: 'direct_sale:offer:91:v3',
    offerId: 91,
    assetType: 'thing',
    assetId: 42,
    request: { offer_id: 91, nested: { b: 2, a: 1 } },
    method: 'x402',
    network: 'base',
    token: USDC,
    payerWallet: PAYER,
    payeeWallet: PAYEE,
    amountUnits: 2_000_000n,
    x402Nonce: NONCE,
    x402PayloadDigest: '66'.repeat(32),
    x402ValidAfter: 1_800_000_000n,
    x402ValidBefore: 1_800_000_900n,
    startBlock: 22_000_000n,
    startTime: '2026-08-16T12:00:00.000Z',
    endTime: '2026-08-16T12:15:00.000Z',
    ...overrides,
  }
}

export function row(overrides: Partial<PaymentAttemptRecord> = {}): PaymentAttemptRecord {
  const canonical = canonicalPaymentRequest({ offer_id: 91, nested: { b: 2, a: 1 } })
  return {
    publicId: 'pay_existing_0001',
    actorId: 7,
    counterpartyId: 8,
    operation: 'direct_sale',
    targetKey: 'direct_sale:offer:91:v3',
    offerId: 91,
    assetType: 'thing',
    assetId: 42,
    request: { offer_id: 91, nested: { a: 1, b: 2 } },
    requestHash: canonical.hash,
    method: 'x402',
    network: 'base',
    token: USDC,
    payerWallet: PAYER,
    payeeWallet: PAYEE,
    amountUnits: 2_000_000n,
    x402Nonce: NONCE,
    x402PayloadDigest: '66'.repeat(32),
    x402ValidAfter: 1_800_000_000n,
    x402ValidBefore: 1_800_000_900n,
    startBlock: 22_000_000n,
    startTime: '2026-08-16T12:00:00.000Z',
    endTime: '2026-08-16T12:15:00.000Z',
    status: 'settling',
    leaseOwner: null,
    leaseExpiresAt: null,
    recoveryStartedAt: null,
    recoveryDeadlineAt: null,
    txHash: null,
    finalizedBlockNumber: null,
    finalizedBlockHash: null,
    finalizedBlockTime: null,
    finalizedAt: null,
    invalidReason: null,
    result: null,
    responseStatus: null,
    response: null,
    responseBody: null,
    createdAt: '2026-08-16T12:00:01.000Z',
    updatedAt: '2026-08-16T12:00:01.000Z',
    completedAt: null,
    ...overrides,
  }
}
