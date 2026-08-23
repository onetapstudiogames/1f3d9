import assert from 'node:assert/strict'
import test from 'node:test'
import {
  recoverPaymentAttempt,
  runPaymentRecoveryBatch,
  type PaymentRecoveryAttempt,
  type PaymentRecoveryDependencies,
} from '../src/payment-recovery.ts'

const BEFORE_DEADLINE = new Date('2026-08-22T02:14:59.999Z')
const AT_DEADLINE = new Date('2026-08-22T02:15:00.000Z')

function attempt(
  overrides: Partial<PaymentRecoveryAttempt> = {},
): PaymentRecoveryAttempt {
  return Object.freeze({
    publicId: 'pay_recovery_test',
    actorId: 68,
    operation: 'frontier',
    method: 'x402',
    status: 'payment_pending',
    recoveryDeadlineAt: AT_DEADLINE.toISOString(),
    ...overrides,
  }) as PaymentRecoveryAttempt
}

function dependencies(
  overrides: Partial<PaymentRecoveryDependencies> = {},
): PaymentRecoveryDependencies {
  return {
    now: () => BEFORE_DEADLINE,
    listRecoverable: async () => [],
    resumeX402: async current => ({
      state: 'payment_pending',
      attemptId: current.publicId,
    }),
    acquireCredit: async current => ({
      state: 'ready',
      attemptId: current.publicId,
      leaseOwner: 'lease-credit',
    }),
    completeOperation: async ({ attempt: current }) => ({
      state: 'completed',
      attemptId: current.publicId,
    }),
    closeExpiredX402: async current => ({
      state: 'expired',
      attemptId: current.publicId,
    }),
    returnExpiredCredit: async current => ({
      state: 'credit_returned',
      attemptId: current.publicId,
    }),
    markFounderReview: async current => ({
      state: 'founder_review',
      attemptId: current.publicId,
    }),
    inspectLateX402: async () => ({ state: 'missing' }),
    appendLateFinality: async current => ({
      state: 'founder_review',
      attemptId: current.publicId,
    }),
    reportFailure: () => {},
    ...overrides,
  }
}

test('automatic rechecks stay pending at 12 minutes and complete at 15 minutes without another payment', async () => {
  const current = attempt()
  let checks = 0
  let completions = 0
  const deps = dependencies({
    now: () => new Date('2026-08-22T00:30:00.000Z'),
    resumeX402: async () => {
      checks += 1
      return checks === 1
        ? { state: 'payment_pending', attemptId: current.publicId }
        : {
            state: 'ready', attemptId: current.publicId, leaseOwner: 'lease-x402',
            paymentResponseHeader: 'receipt',
          }
    },
    completeOperation: async input => {
      completions += 1
      assert.equal(input.leaseOwner, 'lease-x402')
      assert.equal(input.paymentResponseHeader, 'receipt')
      return { state: 'completed', attemptId: input.attempt.publicId }
    },
  })

  assert.deepEqual(await recoverPaymentAttempt(current, 'automatic', deps), {
    state: 'payment_pending', attemptId: current.publicId,
  })
  assert.deepEqual(await recoverPaymentAttempt(current, 'automatic', deps), {
    state: 'completed', attemptId: current.publicId,
  })
  assert.equal(checks, 2)
  assert.equal(completions, 1)
})

test('a matching payment may complete one millisecond before the deadline', async () => {
  let closed = 0
  const current = attempt()
  const result = await recoverPaymentAttempt(current, 'automatic', dependencies({
    now: () => BEFORE_DEADLINE,
    resumeX402: async () => ({
      state: 'ready', attemptId: current.publicId, leaseOwner: 'lease-x402',
      paymentResponseHeader: 'receipt',
    }),
    closeExpiredX402: async value => {
      closed += 1
      return { state: 'expired', attemptId: value.publicId }
    },
  }))

  assert.deepEqual(result, { state: 'completed', attemptId: current.publicId })
  assert.equal(closed, 0)
})

test('the exact deadline closes x402 recovery without another chain read or business effect', async () => {
  let resumed = 0
  let completed = 0
  const current = attempt()
  const result = await recoverPaymentAttempt(current, 'automatic', dependencies({
    now: () => AT_DEADLINE,
    resumeX402: async () => {
      resumed += 1
      return { state: 'payment_pending', attemptId: current.publicId }
    },
    completeOperation: async () => {
      completed += 1
      return { state: 'completed', attemptId: current.publicId }
    },
  }))

  assert.deepEqual(result, { state: 'expired', attemptId: current.publicId })
  assert.equal(resumed, 0)
  assert.equal(completed, 0)
})

test('the exact deadline returns the same spent credit and never invokes x402 or issuance', async () => {
  let acquired = 0
  let returned = 0
  const current = attempt({ method: 'credit' })
  const result = await recoverPaymentAttempt(current, 'automatic', dependencies({
    now: () => AT_DEADLINE,
    acquireCredit: async value => {
      acquired += 1
      return { state: 'ready', attemptId: value.publicId, leaseOwner: 'lease-credit' }
    },
    returnExpiredCredit: async value => {
      returned += 1
      return { state: 'credit_returned', attemptId: value.publicId }
    },
  }))

  assert.deepEqual(result, { state: 'credit_returned', attemptId: current.publicId })
  assert.equal(acquired, 0)
  assert.equal(returned, 1)
})

test('a matching receipt discovered by an explicit late recheck is append-only founder review', async () => {
  let completed = 0
  const current = attempt({ status: 'expired' })
  const result = await recoverPaymentAttempt(current, 'explicit', dependencies({
    now: () => new Date('2026-08-22T04:00:00.000Z'),
    inspectLateX402: async () => ({
      state: 'matched',
      txHash: `0x${'ab'.repeat(32)}`,
      blockNumber: 123n,
      blockHash: `0x${'cd'.repeat(32)}`,
      blockTime: '2026-08-22T00:20:00.000Z',
      finalizedAt: '2026-08-22T04:00:00.000Z',
    }),
    completeOperation: async () => {
      completed += 1
      return { state: 'completed', attemptId: current.publicId }
    },
  }))

  assert.deepEqual(result, { state: 'founder_review', attemptId: current.publicId })
  assert.equal(completed, 0)
})

test('missing, ambiguous, or invalid late evidence leaves an expired attempt terminal', async () => {
  for (const state of ['missing', 'ambiguous', 'invalid'] as const) {
    const current = attempt({ publicId: `pay_${state}`, status: 'expired' })
    const result = await recoverPaymentAttempt(current, 'explicit', dependencies({
      inspectLateX402: async () => state === 'invalid'
        ? { state, reason: 'wrong recipient' }
        : { state },
    }))
    assert.deepEqual(result, { state: 'expired', attemptId: current.publicId })
  }
})

test('duplicate workers do not apply a business effect twice', async () => {
  const current = attempt()
  let completionCalls = 0
  let first = true
  const deps = dependencies({
    resumeX402: async () => {
      if (first) {
        first = false
        return {
          state: 'ready', attemptId: current.publicId, leaseOwner: 'winner',
          paymentResponseHeader: 'receipt',
        }
      }
      return { state: 'busy', attemptId: current.publicId }
    },
    completeOperation: async () => {
      completionCalls += 1
      return { state: 'completed', attemptId: current.publicId }
    },
  })

  const [one, two] = await Promise.all([
    recoverPaymentAttempt(current, 'automatic', deps),
    recoverPaymentAttempt(current, 'automatic', deps),
  ])
  assert.deepEqual(new Set([one.state, two.state]), new Set(['completed', 'busy']))
  assert.equal(completionCalls, 1)
})

test('an interrupted worker is retryable and a replayed atomic completion remains once-only', async () => {
  const current = attempt()
  let calls = 0
  const deps = dependencies({
    resumeX402: async () => ({
      state: 'ready', attemptId: current.publicId, leaseOwner: `lease-${calls}`,
      paymentResponseHeader: 'receipt',
    }),
    completeOperation: async () => {
      calls += 1
      if (calls === 1) throw new Error('process stopped before the atomic operation')
      return { state: 'completed', attemptId: current.publicId }
    },
  })

  await assert.rejects(
    recoverPaymentAttempt(current, 'explicit', deps),
    /process stopped/,
  )
  assert.deepEqual(await recoverPaymentAttempt(current, 'explicit', deps), {
    state: 'completed', attemptId: current.publicId,
  })
})

test('changed stored terms never auto-apply a paid operation', async () => {
  const current = attempt()
  let reviews = 0
  const result = await recoverPaymentAttempt(current, 'automatic', dependencies({
    resumeX402: async () => ({
      state: 'ready', attemptId: current.publicId, leaseOwner: 'lease-x402',
      paymentResponseHeader: 'receipt',
    }),
    completeOperation: async () => ({
      state: 'target_changed', attemptId: current.publicId, reason: 'frontier name now exists',
    }),
    markFounderReview: async value => {
      reviews += 1
      return { state: 'founder_review', attemptId: value.publicId }
    },
  }))

  assert.deepEqual(result, { state: 'founder_review', attemptId: current.publicId })
  assert.equal(reviews, 1)
})

test('changed credit terms return the exact spend instead of issuing replacement credit', async () => {
  const current = attempt({ method: 'credit' })
  let returns = 0
  const result = await recoverPaymentAttempt(current, 'automatic', dependencies({
    completeOperation: async () => ({
      state: 'target_changed', attemptId: current.publicId, reason: 'frontier name now exists',
    }),
    returnExpiredCredit: async value => {
      returns += 1
      return { state: 'credit_returned', attemptId: value.publicId }
    },
  }))

  assert.deepEqual(result, { state: 'credit_returned', attemptId: current.publicId })
  assert.equal(returns, 1)
})

test('batch recovery isolates one failed attempt and keeps processing bounded work', async () => {
  const attempts = [
    attempt({ publicId: 'pay_one' }),
    attempt({ publicId: 'pay_two' }),
    attempt({ publicId: 'pay_three' }),
  ]
  const failures: Array<{ attemptId: string; message: string }> = []
  const failure = new Error('temporary RPC failure')
  const result = await runPaymentRecoveryBatch(2, dependencies({
    listRecoverable: async input => {
      assert.equal(input.limit, 2)
      return attempts.slice(0, input.limit)
    },
    resumeX402: async current => {
      if (current.publicId === 'pay_one') throw failure
      return { state: 'payment_pending', attemptId: current.publicId }
    },
    reportFailure: (current, error) => failures.push({
      attemptId: current.publicId,
      message: error instanceof Error ? error.message : String(error),
    }),
  }))

  assert.deepEqual(result, {
    scanned: 2,
    completed: 0,
    pending: 1,
    busy: 0,
    terminalized: 0,
    failed: 1,
  })
  assert.deepEqual(failures, [{
    attemptId: 'pay_one',
    message: failure.message,
  }])
})

test('batch recovery reports the failed attempt before moving to the next one', async () => {
  const attempts = [
    attempt({ publicId: 'pay_one' }),
    attempt({ publicId: 'pay_two' }),
  ]
  const reported: Array<{ attemptId: string; message: string }> = []
  const result = await runPaymentRecoveryBatch(2, dependencies({
    listRecoverable: async () => attempts,
    resumeX402: async current => {
      if (current.publicId === 'pay_one') throw new Error('deadline transition rejected')
      return { state: 'payment_pending', attemptId: current.publicId }
    },
    reportFailure: (current, error) => {
      reported.push({
        attemptId: current.publicId,
        message: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  assert.deepEqual(reported, [{
    attemptId: 'pay_one',
    message: 'deadline transition rejected',
  }])
  assert.deepEqual(result, {
    scanned: 2,
    completed: 0,
    pending: 1,
    busy: 0,
    terminalized: 0,
    failed: 1,
  })
})
