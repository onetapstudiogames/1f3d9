import { randomUUID } from 'node:crypto'
import {
  classifyUsdcTransfer,
  currentBaseBlockNumber,
  findFinalizedAuthorizationTransaction,
  type TransferCheck,
} from './chain.ts'
import {
  acquireSettlementLease,
  bindPaymentEvidence,
  createOrReadPaymentAttempt,
  invalidatePaymentAttempt,
  markPaymentAttemptNeedsReview,
  PaymentAttemptConflictError,
  releaseSettlementLease,
  toPublicPaymentAttempt,
  type PaymentAttemptDatabase,
  type PaymentAttemptInput,
  type PaymentAttemptRecord,
} from './payment-attempts.ts'
import {
  parseX402Payment,
  paymentResponseHeader,
  settleVerifiedX402,
  verifyX402Payment,
  type PaymentRequirements,
  type Settled,
  type VerifiedX402Payment,
  type X402SettlementResult,
  type X402VerificationResult,
} from './pay.ts'

const LEASE_MILLISECONDS = 30_000

export interface DurableX402Input {
  database: PaymentAttemptDatabase
  paymentHeader: string
  accepted: PaymentRequirements
  actorId: number
  counterpartyId?: number | null
  operation: Exclude<PaymentAttemptRecord['operation'], 'legacy'>
  targetKey: string
  offerId?: number | null
  assetType?: PaymentAttemptRecord['assetType']
  assetId?: number | null
  request: unknown
  expectedPayerWallet?: string
  notBefore?: Date | null
  notAfter?: Date | null
}

export interface PaymentFlowDependencies {
  currentBlock(): Promise<bigint | null>
  createOrRead: typeof createOrReadPaymentAttempt
  acquireLease: typeof acquireSettlementLease
  verify(
    paymentHeader: string,
    accepted: PaymentRequirements,
  ): Promise<X402VerificationResult>
  settle(verified: VerifiedX402Payment): Promise<X402SettlementResult>
  bindEvidence: typeof bindPaymentEvidence
  classify(
    txHash: string,
    payeeWallet: string,
    amountUnits: bigint,
    options: { expectedFrom: string; exactAmount: true },
  ): Promise<TransferCheck>
  recoverTransaction(
    payerWallet: string,
    nonce: string,
    startBlock: bigint,
  ): Promise<string | null>
  releaseLease: typeof releaseSettlementLease
  invalidate: typeof invalidatePaymentAttempt
  needsReview: typeof markPaymentAttemptNeedsReview
}

export type DurableX402Result =
  | {
      state: 'ready'
      attemptId: string
      leaseOwner: string
      txHash: string
      payerWallet: string
      blockNumber: bigint
      blockHash: string
      blockTime: string
      finalizedAt: string
      paymentResponseHeader: string
    }
  | {
      state: 'completed'
      status: number
      body: Record<string, unknown>
      responseBody: string | null
      paymentResponseHeader: string | null
    }
  | {
      state: 'payment_pending'
      status: 202
      body: Record<string, unknown>
      attemptId: string
      payerWallet: string | null
      txHash: string | null
    }
  | { state: 'rejected'; status: 400 | 409; body: { error: string; do_not_pay_again?: boolean } }
  | { state: 'unavailable'; status: 503; body: { error: string; do_not_pay_again: boolean } }

const defaultDependencies: PaymentFlowDependencies = {
  currentBlock: currentBaseBlockNumber,
  createOrRead: createOrReadPaymentAttempt,
  acquireLease: acquireSettlementLease,
  verify: verifyX402Payment,
  settle: settleVerifiedX402,
  bindEvidence: bindPaymentEvidence,
  classify: classifyUsdcTransfer,
  recoverTransaction: findFinalizedAuthorizationTransaction,
  releaseLease: releaseSettlementLease,
  invalidate: invalidatePaymentAttempt,
  needsReview: markPaymentAttemptNeedsReview,
}

function validDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function conservativeWindow(
  validAfter: number,
  validBefore: number,
  notBefore: Date | null | undefined,
  notAfter: Date | null | undefined,
): { startTime: string; endTime: string } | null {
  const lowerBounds = [validAfter + 1]
  const upperBounds = [validBefore]
  if (notBefore != null) {
    if (!validDate(notBefore)) return null
    lowerBounds.push(Math.ceil(notBefore.getTime() / 1_000))
  }
  if (notAfter != null) {
    if (!validDate(notAfter)) return null
    upperBounds.push(Math.floor(notAfter.getTime() / 1_000))
  }
  const startSeconds = Math.max(...lowerBounds)
  const endSeconds = Math.min(...upperBounds)
  if (!Number.isSafeInteger(startSeconds) || !Number.isSafeInteger(endSeconds) || startSeconds >= endSeconds) {
    return null
  }
  return {
    startTime: new Date(startSeconds * 1_000).toISOString(),
    endTime: new Date(endSeconds * 1_000).toISOString(),
  }
}

function pending(attempt: PaymentAttemptRecord, error: string): DurableX402Result {
  return {
    state: 'payment_pending',
    status: 202,
    attemptId: attempt.publicId,
    payerWallet: attempt.payerWallet,
    txHash: attempt.txHash,
    body: {
      ...toPublicPaymentAttempt(attempt),
      error,
      do_not_pay_again: true,
    },
  }
}

function completed(attempt: PaymentAttemptRecord): DurableX402Result {
  if (attempt.responseStatus == null || attempt.response == null) {
    return pending(attempt, 'payment completed but its canonical response is still being reconciled')
  }
  return {
    state: 'completed',
    status: attempt.responseStatus,
    body: attempt.response,
    responseBody: attempt.responseBody ?? null,
    // Historical rows completed before receipt persistence cannot recover bytes that
    // were never stored. Keep their canonical compatibility receipt so paid work is
    // not stranded; new rows always take the durable header branch.
    paymentResponseHeader: attempt.paymentResponseHeader ?? (attempt.txHash && attempt.payerWallet
      ? settlementHeader(attempt.txHash, attempt.payerWallet)
      : null),
  }
}

export function completedPaymentResponse(
  payment: Extract<DurableX402Result, { state: 'completed' }>,
): Response {
  return paymentJsonResponse(
    payment.responseBody ?? JSON.stringify(payment.body),
    payment.status,
    payment.paymentResponseHeader,
  )
}

export function paymentJsonResponse(
  responseBody: string,
  status: number,
  paymentResponseHeader: string | null,
): Response {
  return new Response(responseBody, {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      ...(paymentResponseHeader
        ? { 'X-PAYMENT-RESPONSE': paymentResponseHeader }
        : {}),
    },
  })
}

function rejected(error: string, status: 400 | 409 = 400, doNotPayAgain = false): DurableX402Result {
  return {
    state: 'rejected',
    status,
    body: { error, ...(doNotPayAgain ? { do_not_pay_again: true } : {}) },
  }
}

function unavailable(error: string): DurableX402Result {
  return {
    state: 'unavailable',
    status: 503,
    body: { error, do_not_pay_again: true },
  }
}

function settlementHeader(txHash: string, payerWallet: string, raw?: Record<string, unknown>): string {
  const settled: Settled = {
    transaction: txHash,
    payer: payerWallet,
    raw: raw ?? { success: true, transaction: txHash, payer: payerWallet },
  }
  return paymentResponseHeader(settled)
}

async function safelyRelease(
  deps: PaymentFlowDependencies,
  database: PaymentAttemptDatabase,
  publicId: string,
  leaseOwner: string,
): Promise<PaymentAttemptRecord | null> {
  try {
    return await deps.releaseLease(database, { publicId, leaseOwner })
  } catch {
    return null
  }
}

export async function resumeDurableX402(
  input: {
    database: PaymentAttemptDatabase
    attempt: PaymentAttemptRecord
    actorId: number
  },
  deps: PaymentFlowDependencies = defaultDependencies,
): Promise<DurableX402Result> {
  if (input.attempt.actorId !== input.actorId) {
    return rejected('payment attempt belongs to another resident', 409, true)
  }
  if (input.attempt.status === 'completed') return completed(input.attempt)
  if (input.attempt.status === 'invalid' || input.attempt.status === 'expired') {
    return rejected(input.attempt.invalidReason ?? 'payment attempt is no longer valid', 409, true)
  }
  const leased = await deps.acquireLease(input.database, {
    publicId: input.attempt.publicId,
    actorId: input.actorId,
    leaseMilliseconds: LEASE_MILLISECONDS,
  }, randomUUID)
  if (!leased.acquired) {
    if (leased.attempt?.status === 'completed') return completed(leased.attempt)
    return leased.attempt
      ? pending(leased.attempt, 'payment processing is already in progress')
      : unavailable('payment custody is temporarily unavailable; do not pay or retry yet')
  }

  let attempt = leased.attempt
  const leaseOwner = leased.leaseOwner
  let txHash = attempt.txHash
  if (txHash == null && attempt.payerWallet && attempt.x402Nonce && attempt.startBlock != null) {
    txHash = await deps.recoverTransaction(
      attempt.payerWallet,
      attempt.x402Nonce,
      attempt.startBlock,
    )
    if (txHash != null) {
      attempt = await deps.bindEvidence(input.database, {
        publicId: attempt.publicId,
        leaseOwner,
        txHash,
        finality: null,
      })
    }
  }
  if (txHash == null) {
    const review = await deps.needsReview(input.database, {
      publicId: attempt.publicId,
      leaseOwner,
      reason: 'settlement outcome remains unknown',
    })
    return pending(review, 'payment outcome is being reconciled')
  }
  if (
    !attempt.payerWallet || !attempt.payeeWallet || attempt.amountUnits == null
    || !attempt.startTime || !attempt.endTime
  ) {
    await safelyRelease(deps, input.database, attempt.publicId, leaseOwner)
    return unavailable('payment evidence is incomplete and needs operator reconciliation')
  }

  const check = await deps.classify(
    txHash,
    attempt.payeeWallet,
    attempt.amountUnits,
    { expectedFrom: attempt.payerWallet, exactAmount: true },
  )
  if (check.state === 'pending') {
    const released = await deps.releaseLease(input.database, {
      publicId: attempt.publicId,
      leaseOwner,
    })
    return pending(released, 'payment is waiting for Base finality')
  }
  if (check.state === 'invalid_final') {
    await deps.invalidate(input.database, {
      publicId: attempt.publicId,
      leaseOwner,
      reason: check.reason,
    })
    return rejected('payment transaction does not match this operation', 400, true)
  }

  const blockTime = check.blockTime.toISOString()
  if (
    check.from.toLowerCase() !== attempt.payerWallet
    || check.to.toLowerCase() !== attempt.payeeWallet
    || check.amount !== attempt.amountUnits
    || blockTime < attempt.startTime
    || blockTime >= attempt.endTime
  ) {
    await deps.invalidate(input.database, {
      publicId: attempt.publicId,
      leaseOwner,
      reason: 'confirmed payment falls outside its immutable terms or time window',
    })
    return rejected('payment transaction does not match this operation', 400, true)
  }

  const finalizedAt = check.finalizedAt.toISOString()
  await deps.bindEvidence(input.database, {
    publicId: attempt.publicId,
    leaseOwner,
    txHash,
    finality: {
      blockNumber: check.blockNumber,
      blockHash: check.blockHash,
      blockTime,
      finalizedAt,
    },
  })
  return {
    state: 'ready',
    attemptId: attempt.publicId,
    leaseOwner,
    txHash,
    payerWallet: attempt.payerWallet,
    blockNumber: check.blockNumber,
    blockHash: check.blockHash,
    blockTime,
    finalizedAt,
    paymentResponseHeader: attempt.paymentResponseHeader
      ?? settlementHeader(txHash, attempt.payerWallet),
  }
}

export async function runDurableX402(
  input: DurableX402Input,
  deps: PaymentFlowDependencies = defaultDependencies,
): Promise<DurableX402Result> {
  const parsed = parseX402Payment(input.paymentHeader, input.accepted)
  if ('error' in parsed) return rejected(parsed.error)
  if (
    input.expectedPayerWallet != null
    && parsed.authorization.payer !== input.expectedPayerWallet.toLowerCase()
  ) return rejected('X-PAYMENT payer does not match the reserved wallet')
  const window = conservativeWindow(
    parsed.authorization.validAfter,
    parsed.authorization.validBefore,
    input.notBefore,
    input.notAfter,
  )
  if (!window) return rejected('payment authorization does not overlap the operation window')

  const startBlock = await deps.currentBlock()
  if (startBlock == null) return unavailable('Base finality is temporarily unavailable; do not pay or retry yet')

  const attemptInput: PaymentAttemptInput = {
    actorId: input.actorId,
    counterpartyId: input.counterpartyId ?? null,
    operation: input.operation,
    targetKey: input.targetKey,
    offerId: input.offerId ?? null,
    assetType: input.assetType ?? null,
    assetId: input.assetId ?? null,
    request: input.request,
    method: 'x402',
    network: 'base',
    token: input.accepted.asset.toLowerCase(),
    payerWallet: parsed.authorization.payer,
    payeeWallet: parsed.authorization.payee,
    amountUnits: BigInt(parsed.authorization.amountUnits),
    x402Nonce: parsed.authorization.nonce,
    x402PayloadDigest: parsed.authorization.payloadDigest,
    x402ValidAfter: BigInt(parsed.authorization.validAfter),
    x402ValidBefore: BigInt(parsed.authorization.validBefore),
    startBlock,
    startTime: window.startTime,
    endTime: window.endTime,
  }

  let created
  try {
    created = await deps.createOrRead(
      input.database,
      attemptInput,
      () => `pay_${parsed.authorization.identity}`,
    )
  } catch (error) {
    if (error instanceof PaymentAttemptConflictError) return rejected(error.message, 409, true)
    return unavailable('payment custody is temporarily unavailable; do not pay or retry yet')
  }

  if (created.attempt.status === 'completed') return completed(created.attempt)
  if (created.attempt.status === 'invalid' || created.attempt.status === 'expired') {
    return rejected(created.attempt.invalidReason ?? 'payment attempt is no longer valid', 409, true)
  }

  const leased = await deps.acquireLease(
    input.database,
    {
      publicId: created.attempt.publicId,
      actorId: input.actorId,
      leaseMilliseconds: LEASE_MILLISECONDS,
    },
    randomUUID,
  )
  if (!leased.acquired) {
    if (leased.attempt?.status === 'completed') return completed(leased.attempt)
    return leased.attempt
      ? pending(leased.attempt, 'payment processing is already in progress')
      : unavailable('payment custody is temporarily unavailable; do not pay or retry yet')
  }

  let attempt = leased.attempt
  const leaseOwner = leased.leaseOwner
  let txHash = attempt.txHash
  let settlementRaw: Record<string, unknown> | undefined
  let settledResponseHeader: string | undefined

  if (txHash == null && created.disposition === 'existing') {
    txHash = await deps.recoverTransaction(
      parsed.authorization.payer,
      parsed.authorization.nonce,
      attempt.startBlock ?? startBlock,
    )
    if (txHash != null) {
      attempt = await deps.bindEvidence(input.database, {
        publicId: attempt.publicId,
        leaseOwner,
        txHash,
        finality: null,
      })
    } else if (attempt.status === 'needs_review') {
      const review = await deps.needsReview(input.database, {
        publicId: attempt.publicId,
        leaseOwner,
        reason: 'settlement outcome remains unknown',
      })
      return pending(review, 'payment outcome is being reconciled')
    }
  }

  if (txHash == null) {
    const verified = await deps.verify(input.paymentHeader, input.accepted)
    if (verified.state === 'invalid') {
      await deps.invalidate(input.database, {
        publicId: attempt.publicId,
        leaseOwner,
        reason: verified.error,
      })
      return rejected(verified.error, 400, true)
    }
    if (verified.state === 'unavailable') {
      await safelyRelease(deps, input.database, attempt.publicId, leaseOwner)
      return unavailable(`${verified.error}; retry this same payment authorization`)
    }

    const settlement = await deps.settle(verified)
    txHash = settlement.transaction
    if (settlement.state === 'settled') {
      settlementRaw = settlement.response
      settledResponseHeader = settlementHeader(txHash!, parsed.authorization.payer, settlementRaw)
    }
    if (txHash == null) {
      const review = await deps.needsReview(input.database, {
        publicId: attempt.publicId,
        leaseOwner,
        reason: settlement.state === 'ambiguous'
          ? settlement.error
          : 'settlement outcome is unknown',
      })
      return pending(review, 'payment outcome is being reconciled')
    }
    attempt = await deps.bindEvidence(input.database, {
      publicId: attempt.publicId,
      leaseOwner,
      txHash,
      finality: null,
      ...(settledResponseHeader ? { paymentResponseHeader: settledResponseHeader } : {}),
    })
  }

  const check = await deps.classify(
    txHash,
    parsed.authorization.payee,
    BigInt(parsed.authorization.amountUnits),
    { expectedFrom: parsed.authorization.payer, exactAmount: true },
  )
  if (check.state === 'pending') {
    const released = await deps.releaseLease(input.database, {
      publicId: attempt.publicId,
      leaseOwner,
    })
    return pending(released, 'payment is waiting for Base finality')
  }
  if (check.state === 'invalid_final') {
    await deps.invalidate(input.database, {
      publicId: attempt.publicId,
      leaseOwner,
      reason: check.reason,
    })
    return rejected('payment transaction does not match this operation', 400, true)
  }

  const blockTime = check.blockTime.toISOString()
  const inWindow = check.from.toLowerCase() === parsed.authorization.payer
    && check.to.toLowerCase() === parsed.authorization.payee
    && check.amount === BigInt(parsed.authorization.amountUnits)
    && blockTime >= window.startTime
    && blockTime < window.endTime
  if (!inWindow) {
    await deps.invalidate(input.database, {
      publicId: attempt.publicId,
      leaseOwner,
      reason: 'confirmed payment falls outside its immutable terms or time window',
    })
    return rejected('payment transaction does not match this operation', 400, true)
  }

  const finalizedAt = check.finalizedAt.toISOString()
  await deps.bindEvidence(input.database, {
    publicId: attempt.publicId,
    leaseOwner,
    txHash,
    finality: {
      blockNumber: check.blockNumber,
      blockHash: check.blockHash,
      blockTime,
      finalizedAt,
    },
  })
  return {
    state: 'ready',
    attemptId: attempt.publicId,
    leaseOwner,
    txHash,
    payerWallet: parsed.authorization.payer,
    blockNumber: check.blockNumber,
    blockHash: check.blockHash,
    blockTime,
    finalizedAt,
    paymentResponseHeader: attempt.paymentResponseHeader
      ?? settledResponseHeader
      ?? settlementHeader(txHash, parsed.authorization.payer, settlementRaw),
  }
}
