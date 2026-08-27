export type PaymentRecoveryStatus =
  | 'settling'
  | 'payment_pending'
  | 'needs_review'
  | 'completed'
  | 'invalid'
  | 'expired'
  | 'founder_review'
  | 'legacy_completed'
  | 'credit_returned'

export type RecoverablePaymentMethod = 'x402' | 'credit'
export type PaymentRecoveryMode = 'automatic' | 'explicit'

export interface PaymentRecoveryAttempt {
  readonly publicId: string
  readonly actorId: number
  readonly operation:
    | 'frontier'
    | 'kind_invention'
    | 'kind_revision'
    | 'credit_purchase'
    | 'direct_sale'
    | 'world_sale'
  readonly method: RecoverablePaymentMethod
  readonly status: PaymentRecoveryStatus
  readonly recoveryDeadlineAt: string | null
}

export type PaymentRecoveryOutcome = Readonly<{
  state:
    | 'completed'
    | 'payment_pending'
    | 'busy'
    | 'invalid'
    | 'expired'
    | 'founder_review'
    | 'legacy_completed'
    | 'credit_returned'
    | 'unavailable'
  attemptId: string
}>

type ReadyRecovery = Readonly<{
  state: 'ready'
  attemptId: string
  leaseOwner: string
  paymentResponseHeader?: string | null
}>

export type PaymentResumeResult =
  | ReadyRecovery
  | PaymentRecoveryOutcome

export type PaymentOperationResult =
  | Readonly<{ state: 'completed'; attemptId: string }>
  | Readonly<{ state: 'deadline_passed'; attemptId: string }>
  | Readonly<{ state: 'target_changed'; attemptId: string; reason: string }>

export type LateX402Inspection =
  | Readonly<{ state: 'missing' | 'ambiguous' }>
  | Readonly<{ state: 'invalid'; reason: string }>
  | Readonly<{
      state: 'matched'
      txHash: string
      blockNumber: bigint
      blockHash: string
      blockTime: string
      finalizedAt: string
    }>

export interface PaymentRecoveryDependencies {
  now(): Date
  listRecoverable(input: { limit: number }): Promise<readonly PaymentRecoveryAttempt[]>
  resumeX402(attempt: PaymentRecoveryAttempt): Promise<PaymentResumeResult>
  acquireCredit(attempt: PaymentRecoveryAttempt): Promise<PaymentResumeResult>
  completeOperation(input: Readonly<{
    attempt: PaymentRecoveryAttempt
    leaseOwner: string
    paymentResponseHeader?: string | null
  }>): Promise<PaymentOperationResult>
  closeExpiredX402(attempt: PaymentRecoveryAttempt): Promise<PaymentRecoveryOutcome>
  returnExpiredCredit(
    attempt: PaymentRecoveryAttempt,
    input?: Readonly<{
      leaseOwner?: string
      reason: 'deadline_passed' | 'target_changed'
    }>,
  ): Promise<PaymentRecoveryOutcome>
  markFounderReview(
    attempt: PaymentRecoveryAttempt,
    input: Readonly<{ leaseOwner: string; reason: string }>,
  ): Promise<PaymentRecoveryOutcome>
  inspectLateX402(attempt: PaymentRecoveryAttempt): Promise<LateX402Inspection>
  appendLateFinality(
    attempt: PaymentRecoveryAttempt,
    evidence: Extract<LateX402Inspection, { state: 'matched' }>,
  ): Promise<PaymentRecoveryOutcome>
  reportFailure?(attempt: PaymentRecoveryAttempt, error: unknown): void
}

export type PaymentRecoveryBatchResult = Readonly<{
  scanned: number
  completed: number
  pending: number
  busy: number
  terminalized: number
  failed: number
}>

export function paymentRecoveryErrorFields(error: unknown): Readonly<{
  errorCode: string | null
  error: string
}> {
  const rawDetail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error)
  const detail = rawDetail
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, '[redacted database URL]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/1f3d9_sk_[A-Za-z0-9_-]+/giu, '[redacted resident key]')
    .slice(0, 400)
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '').slice(0, 32)
    : ''
  return Object.freeze({ errorCode: code || null, error: detail })
}

export function reportPaymentRecoveryRecheckFailure(
  input: Readonly<{ publicId: string; actorId: number | null }>,
  error: unknown,
): void {
  console.error('payment recovery recheck failed', {
    attemptId: input.publicId,
    actorId: input.actorId,
    ...paymentRecoveryErrorFields(error),
  })
}

function outcome(
  state: PaymentRecoveryOutcome['state'],
  attemptId: string,
): PaymentRecoveryOutcome {
  return Object.freeze({ state, attemptId })
}

function terminalOutcome(attempt: PaymentRecoveryAttempt): PaymentRecoveryOutcome | null {
  if (
    attempt.status === 'settling'
    || attempt.status === 'payment_pending'
    || attempt.status === 'needs_review'
  ) return null
  return outcome(attempt.status, attempt.publicId)
}

function atOrAfterDeadline(attempt: PaymentRecoveryAttempt, now: Date): boolean | null {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('payment recovery needs a valid current time')
  }
  if (!attempt.recoveryDeadlineAt) return null
  const deadline = Date.parse(attempt.recoveryDeadlineAt)
  if (!Number.isFinite(deadline)) throw new TypeError('payment recovery deadline is invalid')
  return now.getTime() >= deadline
}

async function closeAtDeadline(
  attempt: PaymentRecoveryAttempt,
  deps: PaymentRecoveryDependencies,
): Promise<PaymentRecoveryOutcome> {
  return attempt.method === 'credit'
    ? await deps.returnExpiredCredit(attempt)
    : await deps.closeExpiredX402(attempt)
}

async function resolveOperation(
  attempt: PaymentRecoveryAttempt,
  ready: ReadyRecovery,
  deps: PaymentRecoveryDependencies,
): Promise<PaymentRecoveryOutcome> {
  const completed = await deps.completeOperation({
    attempt,
    leaseOwner: ready.leaseOwner,
    ...(ready.paymentResponseHeader === undefined
      ? {}
      : { paymentResponseHeader: ready.paymentResponseHeader }),
  })
  if (completed.state === 'completed') return outcome('completed', attempt.publicId)
  if (attempt.method === 'credit') {
    return await deps.returnExpiredCredit(attempt, {
      leaseOwner: ready.leaseOwner,
      reason: completed.state,
    })
  }
  return await deps.markFounderReview(attempt, {
    leaseOwner: ready.leaseOwner,
    reason: completed.state === 'deadline_passed'
      ? 'matching payment finalized after automatic recovery closed'
      : completed.reason,
  })
}

async function inspectExpiredAttempt(
  attempt: PaymentRecoveryAttempt,
  mode: PaymentRecoveryMode,
  deps: PaymentRecoveryDependencies,
): Promise<PaymentRecoveryOutcome> {
  if (mode !== 'explicit' || attempt.method !== 'x402') {
    return outcome('expired', attempt.publicId)
  }
  const inspection = await deps.inspectLateX402(attempt)
  if (inspection.state !== 'matched') return outcome('expired', attempt.publicId)
  return await deps.appendLateFinality(attempt, inspection)
}

/**
 * Reconcile one stored attempt. Caller request bodies never participate in the
 * decision: every operation is reconstructed from immutable stored terms.
 * Database implementations must repeat the deadline and lease checks with the
 * database clock before applying a business effect.
 */
export async function recoverPaymentAttempt(
  attempt: PaymentRecoveryAttempt,
  mode: PaymentRecoveryMode,
  deps: PaymentRecoveryDependencies,
): Promise<PaymentRecoveryOutcome> {
  if (attempt.status === 'expired') return inspectExpiredAttempt(attempt, mode, deps)
  const terminal = terminalOutcome(attempt)
  if (terminal) return terminal

  const deadlineReached = atOrAfterDeadline(attempt, deps.now())
  if (deadlineReached === null) return outcome('unavailable', attempt.publicId)
  if (deadlineReached) return closeAtDeadline(attempt, deps)

  const resumed = attempt.method === 'credit'
    ? await deps.acquireCredit(attempt)
    : await deps.resumeX402(attempt)
  if (resumed.state !== 'ready') return resumed
  return resolveOperation(attempt, resumed, deps)
}

/** Process a bounded page and keep one transient failure from blocking peers. */
export async function runPaymentRecoveryBatch(
  limit: number,
  deps: PaymentRecoveryDependencies,
): Promise<PaymentRecoveryBatchResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('payment recovery batch limit must be an integer from 1 to 100')
  }
  const attempts = await deps.listRecoverable({ limit })
  const counts = {
    scanned: attempts.length,
    completed: 0,
    pending: 0,
    busy: 0,
    terminalized: 0,
    failed: 0,
  }
  for (const attempt of attempts) {
    try {
      const result = await recoverPaymentAttempt(attempt, 'automatic', deps)
      if (result.state === 'completed') counts.completed += 1
      else if (result.state === 'payment_pending' || result.state === 'unavailable') counts.pending += 1
      else if (result.state === 'busy') counts.busy += 1
      else counts.terminalized += 1
    } catch (error) {
      counts.failed += 1
      deps.reportFailure?.(attempt, error)
    }
  }
  return Object.freeze({ ...counts })
}
