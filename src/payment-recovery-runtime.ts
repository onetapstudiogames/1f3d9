import { randomUUID } from 'node:crypto'
import {
  classifyUsdcTransfer,
  findFinalizedAuthorizationTransaction,
  USDC,
  type TransferCheck,
} from './chain.ts'
import {
  returnExpiredCityCreditSpend,
  returnCityCreditSpend,
  type CityCreditDatabase,
} from './city-credit.ts'
import {
  acquireDueSettlementLease,
  acquireSettlementLease,
  appendLateFinalityEvidence,
  expirePaymentAttempt,
  getPaymentAttemptRecord,
  listRecoverablePaymentAttempts,
  markPaymentAttemptFounderReview,
  toPrivatePaymentAttempt,
  type PaymentAttemptDatabase,
  type PaymentAttemptRecord,
} from './payment-attempts.ts'
import {
  closeInvalidSalePaymentTarget,
  completeDirectSalePayment,
  completeWorldSalePayment,
  closeSalePaymentTarget,
  invalidateSalePaymentTarget,
  type PaymentSaleDatabase,
} from './payment-sale-operations.ts'
import { resumeDurableX402 } from './payment-flow.ts'
import {
  recoverPaymentAttempt,
  runPaymentRecoveryBatch,
  type LateX402Inspection,
  type PaymentOperationResult,
  type PaymentRecoveryAttempt,
  type PaymentRecoveryDependencies,
  type PaymentRecoveryOutcome,
  type PaymentResumeResult,
} from './payment-recovery.ts'
import {
  completeTreasuryPaymentOperation,
  type TreasuryPaymentOperationDatabase,
} from './payment-treasury-operations.ts'

const RECOVERY_LEASE_MILLISECONDS = 30_000
const RECOVERY_OPERATIONS = new Set<PaymentRecoveryAttempt['operation']>([
  'frontier', 'kind_invention', 'kind_revision', 'direct_sale', 'world_sale',
])
const RETURN_REASON = 'automatic payment recovery deadline passed'
const LATE_REASON = 'matching finalized payment was discovered after the automatic recovery deadline; no city effect was applied'

export type PaymentRecoveryRuntimeDatabase = PaymentAttemptDatabase
  & CityCreditDatabase
  & PaymentSaleDatabase
  & TreasuryPaymentOperationDatabase

type LeaseResult = Awaited<ReturnType<typeof acquireSettlementLease>>

export type DueCreditResult =
  | Readonly<{ state: 'returned'; attempt_id: string }>
  | Readonly<{ state: 'busy' | 'not_due' | 'missing'; attempt_id: string }>

export interface PaymentRecoveryRuntimeServices {
  randomLeaseOwner(): string
  getAttempt: typeof getPaymentAttemptRecord
  listAttempts: typeof listRecoverablePaymentAttempts
  resumeX402: typeof resumeDurableX402
  acquireLease: typeof acquireSettlementLease
  acquireDueLease(
    database: PaymentAttemptDatabase,
    input: { publicId: string; actorId: number; leaseMilliseconds: number },
    nextLeaseOwner: () => string,
  ): Promise<LeaseResult>
  completeTreasury: typeof completeTreasuryPaymentOperation
  completeDirectSale: typeof completeDirectSalePayment
  completeWorldSale: typeof completeWorldSalePayment
  closeSaleTarget: typeof closeSalePaymentTarget
  closeInvalidSaleTarget: typeof closeInvalidSalePaymentTarget
  invalidateSaleTarget: typeof invalidateSalePaymentTarget
  expireAttempt: typeof expirePaymentAttempt
  markFounderReview: typeof markPaymentAttemptFounderReview
  returnCredit: typeof returnCityCreditSpend
  returnDueCredit(
    database: PaymentRecoveryRuntimeDatabase,
    input: {
      actorId: number
      attemptId: string
      reason: string
      responseStatus: number
      response: Record<string, unknown>
    },
  ): Promise<DueCreditResult>
  recoverTransaction: typeof findFinalizedAuthorizationTransaction
  classifyTransfer: typeof classifyUsdcTransfer
  appendLateFinality: typeof appendLateFinalityEvidence
}

function recoveryAttempt(record: PaymentAttemptRecord): PaymentRecoveryAttempt | null {
  if (
    !RECOVERY_OPERATIONS.has(record.operation as PaymentRecoveryAttempt['operation'])
    || (record.method !== 'x402' && record.method !== 'credit')
  ) return null
  return {
    publicId: record.publicId,
    actorId: record.actorId,
    operation: record.operation as PaymentRecoveryAttempt['operation'],
    method: record.method,
    status: record.status,
    recoveryDeadlineAt: record.recoveryDeadlineAt,
  }
}

function simpleOutcome(
  state: PaymentRecoveryOutcome['state'],
  attemptId: string,
): PaymentRecoveryOutcome {
  return Object.freeze({ state, attemptId })
}

function currentOutcome(
  record: PaymentAttemptRecord | null,
  fallbackAttemptId = 'unknown',
): PaymentRecoveryOutcome {
  if (!record) return simpleOutcome('unavailable', fallbackAttemptId)
  if (record.status === 'settling' || record.status === 'payment_pending' || record.status === 'needs_review') {
    return simpleOutcome('busy', record.publicId)
  }
  return simpleOutcome(record.status, record.publicId)
}

function operationResult(result: {
  state: 'completed' | 'deadline_passed' | 'target_changed'
  attemptId: string
  reason?: string
}): PaymentOperationResult {
  if (result.state === 'target_changed') {
    return {
      state: 'target_changed',
      attemptId: result.attemptId,
      reason: result.reason ?? 'the stored target changed',
    }
  }
  return { state: result.state, attemptId: result.attemptId }
}

function creditReturnResponse(reason: string): Record<string, unknown> {
  return {
    error: reason,
    do_not_pay_again: true,
    city_fee_credit: { returned_usdc: '1.000000' },
  }
}

function terminalFromResume(
  result: Awaited<ReturnType<typeof resumeDurableX402>>,
  attemptId: string,
): PaymentResumeResult | null {
  if (result.state === 'ready') {
    return {
      state: 'ready',
      attemptId,
      leaseOwner: result.leaseOwner,
      paymentResponseHeader: result.paymentResponseHeader,
    }
  }
  if (result.state === 'completed') return simpleOutcome('completed', attemptId)
  if (result.state === 'payment_pending') return simpleOutcome('payment_pending', attemptId)
  if (result.state === 'unavailable') return simpleOutcome('unavailable', attemptId)
  return null
}

function lower(value: string): string {
  return value.toLowerCase()
}

function validLateTerms(record: PaymentAttemptRecord): boolean {
  return record.network === 'base'
    && record.token?.toLowerCase() === USDC.toLowerCase()
    && record.payerWallet != null
    && record.payeeWallet != null
    && record.amountUnits != null
    && record.startTime != null
    && record.endTime != null
    && Number.isFinite(Date.parse(record.startTime))
    && Number.isFinite(Date.parse(record.endTime))
}

function lateInspection(
  record: PaymentAttemptRecord,
  txHash: string,
  checked: TransferCheck,
): LateX402Inspection {
  if (checked.state === 'pending') return { state: 'ambiguous' }
  if (checked.state === 'invalid_final') return { state: 'invalid', reason: checked.reason }
  if (!validLateTerms(record)) return { state: 'invalid', reason: 'stored payment terms are incomplete' }
  const blockTime = checked.blockTime.toISOString()
  if (
    lower(checked.from) !== record.payerWallet
    || lower(checked.to) !== record.payeeWallet
    || checked.amount !== record.amountUnits
    || blockTime < record.startTime!
    || blockTime >= record.endTime!
  ) return { state: 'invalid', reason: 'confirmed payment does not match its immutable terms' }
  return {
    state: 'matched',
    txHash: lower(txHash),
    blockNumber: checked.blockNumber,
    blockHash: lower(checked.blockHash),
    blockTime,
    finalizedAt: checked.finalizedAt.toISOString(),
  }
}

async function defaultReturnDueCredit(
  database: PaymentRecoveryRuntimeDatabase,
  input: Parameters<PaymentRecoveryRuntimeServices['returnDueCredit']>[1],
): Promise<DueCreditResult> {
  const returned = await returnExpiredCityCreditSpend(database, {
    actorId: input.actorId,
    attemptId: input.attemptId,
  })
  if (returned.state === 'credit_returned') {
    return { state: 'returned', attempt_id: input.attemptId }
  }
  if (returned.state === 'busy' || returned.state === 'not_due') {
    return { state: returned.state, attempt_id: input.attemptId }
  }
  return { state: 'missing', attempt_id: input.attemptId }
}

const baseServices: Omit<PaymentRecoveryRuntimeServices, 'returnDueCredit'> = {
  randomLeaseOwner: randomUUID,
  getAttempt: getPaymentAttemptRecord,
  listAttempts: listRecoverablePaymentAttempts,
  resumeX402: resumeDurableX402,
  acquireLease: acquireSettlementLease,
  acquireDueLease: acquireDueSettlementLease,
  completeTreasury: completeTreasuryPaymentOperation,
  completeDirectSale: completeDirectSalePayment,
  completeWorldSale: completeWorldSalePayment,
  closeSaleTarget: closeSalePaymentTarget,
  closeInvalidSaleTarget: closeInvalidSalePaymentTarget,
  invalidateSaleTarget: invalidateSalePaymentTarget,
  expireAttempt: expirePaymentAttempt,
  markFounderReview: markPaymentAttemptFounderReview,
  returnCredit: returnCityCreditSpend,
  recoverTransaction: findFinalizedAuthorizationTransaction,
  classifyTransfer: classifyUsdcTransfer,
  appendLateFinality: appendLateFinalityEvidence,
}

function mergedServices(
  overrides: Partial<PaymentRecoveryRuntimeServices>,
): PaymentRecoveryRuntimeServices {
  const provisional = { ...baseServices, ...overrides } as PaymentRecoveryRuntimeServices
  return {
    ...provisional,
    returnDueCredit: overrides.returnDueCredit ?? (async (database, input) => (
      defaultReturnDueCredit(database, input)
    )),
  }
}

function logRecoveryFailure(attempt: PaymentRecoveryAttempt, error: unknown): void {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error)
  console.error('payment recovery attempt failed', {
    attemptId: attempt.publicId,
    actorId: attempt.actorId,
    operation: attempt.operation,
    method: attempt.method,
    status: attempt.status,
    recoveryDeadlineAt: attempt.recoveryDeadlineAt,
    error: detail,
  })
}

export interface PaymentRecoveryRuntime {
  dependencies: PaymentRecoveryDependencies
  getOwnedAttempt(publicId: string, actorId: number): Promise<PaymentAttemptRecord | null>
  privateView(attempt: PaymentAttemptRecord): Record<string, unknown>
  recheck(attempt: PaymentAttemptRecord): Promise<PaymentRecoveryOutcome>
  runBatch(limit: number): ReturnType<typeof runPaymentRecoveryBatch>
}

/** Connect the pure recovery policy to durable state and the five operation adapters. */
export function createPaymentRecoveryRuntime(
  database: PaymentRecoveryRuntimeDatabase,
  serviceOverrides: Partial<PaymentRecoveryRuntimeServices> = {},
  configuration: Readonly<{ now?: () => Date }> = {},
): PaymentRecoveryRuntime {
  const services = mergedServices(serviceOverrides)
  const now = configuration.now ?? (() => new Date())
  let dependencies: PaymentRecoveryDependencies

  async function fullAttempt(value: PaymentRecoveryAttempt): Promise<PaymentAttemptRecord | null> {
    return services.getAttempt(database, { publicId: value.publicId, actorId: value.actorId })
  }

  dependencies = {
    now,
    listRecoverable: async input => {
      const records = await services.listAttempts(database, input)
      return records.flatMap(record => {
        const candidate = recoveryAttempt(record)
        return candidate ? [candidate] : []
      })
    },
    resumeX402: async value => {
      const record = await fullAttempt(value)
      if (!record) return simpleOutcome('unavailable', value.publicId)
      const result = await services.resumeX402(
        { database, attempt: record, actorId: value.actorId },
        value.operation === 'direct_sale' || value.operation === 'world_sale'
          ? {
              invalidate: async (_attemptDatabase, input) => services.invalidateSaleTarget(database, {
                attemptId: input.publicId,
                leaseOwner: input.leaseOwner,
                reason: input.reason,
              }),
            }
          : {},
      )
      const mapped = terminalFromResume(result, value.publicId)
      if (mapped) return mapped
      const current = await fullAttempt(value)
      if (
        current?.status === 'invalid'
        && (value.operation === 'direct_sale' || value.operation === 'world_sale')
      ) {
        await services.closeInvalidSaleTarget(database, { attemptId: value.publicId })
      }
      return currentOutcome(current, value.publicId)
    },
    acquireCredit: async value => {
      const leased = await services.acquireLease(database, {
        publicId: value.publicId,
        actorId: value.actorId,
        leaseMilliseconds: RECOVERY_LEASE_MILLISECONDS,
      }, services.randomLeaseOwner)
      return leased.acquired
        ? { state: 'ready', attemptId: value.publicId, leaseOwner: leased.leaseOwner }
        : currentOutcome(leased.attempt, value.publicId)
    },
    completeOperation: async input => {
      const operationInput = { attemptId: input.attempt.publicId, leaseOwner: input.leaseOwner }
      if (input.attempt.operation === 'direct_sale') {
        return operationResult(await services.completeDirectSale(database, operationInput))
      }
      if (input.attempt.operation === 'world_sale') {
        return operationResult(await services.completeWorldSale(database, operationInput))
      }
      return operationResult(await services.completeTreasury(database, operationInput))
    },
    closeExpiredX402: async value => {
      const leased = await services.acquireDueLease(database, {
        publicId: value.publicId,
        actorId: value.actorId,
        leaseMilliseconds: RECOVERY_LEASE_MILLISECONDS,
      }, services.randomLeaseOwner)
      if (!leased.acquired) return currentOutcome(leased.attempt, value.publicId)
      if (value.operation === 'direct_sale' || value.operation === 'world_sale') {
        await services.closeSaleTarget(database, {
          attemptId: value.publicId,
          leaseOwner: leased.leaseOwner,
          state: 'expired',
          reason: RETURN_REASON,
        })
      } else {
        await services.expireAttempt(database, {
          publicId: value.publicId,
          leaseOwner: leased.leaseOwner,
          reason: RETURN_REASON,
        })
      }
      return simpleOutcome('expired', value.publicId)
    },
    returnExpiredCredit: async (value, input) => {
      const reason = input?.reason === 'target_changed'
        ? 'stored operation terms or its current target changed'
        : RETURN_REASON
      const response = creditReturnResponse(reason)
      if (input?.leaseOwner) {
        await services.returnCredit(database, {
          actorId: value.actorId,
          attemptId: value.publicId,
          leaseOwner: input.leaseOwner,
          reason,
          responseStatus: 409,
          response,
        })
      } else {
        const returned = await services.returnDueCredit(database, {
          actorId: value.actorId,
          attemptId: value.publicId,
          reason,
          responseStatus: 409,
          response,
        })
        if (returned.state !== 'returned') {
          return simpleOutcome(
            returned.state === 'busy' || returned.state === 'not_due' ? 'busy' : 'unavailable',
            value.publicId,
          )
        }
      }
      return simpleOutcome('credit_returned', value.publicId)
    },
    markFounderReview: async (value, input) => {
      if (value.operation === 'direct_sale' || value.operation === 'world_sale') {
        await services.closeSaleTarget(database, {
          attemptId: value.publicId,
          leaseOwner: input.leaseOwner,
          state: 'founder_review',
          reason: input.reason,
        })
      } else {
        await services.markFounderReview(database, {
          publicId: value.publicId,
          leaseOwner: input.leaseOwner,
          reason: input.reason,
        })
      }
      return simpleOutcome('founder_review', value.publicId)
    },
    inspectLateX402: async value => {
      const record = await fullAttempt(value)
      if (!record || record.status !== 'expired' || record.method !== 'x402') {
        return { state: 'missing' }
      }
      let txHash = record.txHash
      if (!txHash) {
        if (!record.payerWallet || !record.x402Nonce || record.startBlock == null) {
          return { state: 'missing' }
        }
        txHash = await services.recoverTransaction(
          record.payerWallet,
          record.x402Nonce,
          record.startBlock,
        )
        if (!txHash) return { state: 'ambiguous' }
      }
      if (!validLateTerms(record)) return { state: 'invalid', reason: 'stored payment terms are incomplete' }
      const checked = await services.classifyTransfer(
        txHash,
        record.payeeWallet!,
        record.amountUnits!,
        { expectedFrom: record.payerWallet!, exactAmount: true },
      )
      return lateInspection(record, txHash, checked)
    },
    appendLateFinality: async (value, evidence) => {
      await services.appendLateFinality(database, {
        publicId: value.publicId,
        txHash: evidence.txHash,
        finality: {
          blockNumber: evidence.blockNumber,
          blockHash: evidence.blockHash,
          blockTime: evidence.blockTime,
          finalizedAt: evidence.finalizedAt,
        },
        reason: LATE_REASON,
      })
      return simpleOutcome('founder_review', value.publicId)
    },
    reportFailure: logRecoveryFailure,
  }

  return {
    dependencies,
    getOwnedAttempt: async (publicId, actorId) => (
      services.getAttempt(database, { publicId, actorId })
    ),
    privateView: attempt => ({ ...toPrivatePaymentAttempt(attempt) }),
    recheck: async attempt => {
      const candidate = recoveryAttempt(attempt)
      if (!candidate) return currentOutcome(attempt)
      return recoverPaymentAttempt(candidate, 'explicit', dependencies)
    },
    runBatch: async limit => runPaymentRecoveryBatch(limit, dependencies),
  }
}
