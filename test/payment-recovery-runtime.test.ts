import assert from 'node:assert/strict'
import test from 'node:test'
import type { TransferCheck } from '../src/chain.ts'
import {
  canonicalPaymentRequest,
  type PaymentAttemptRecord,
} from '../src/payment-attempts.ts'
import {
  createPaymentRecoveryRuntime,
  type PaymentRecoveryRuntimeServices,
} from '../src/payment-recovery-runtime.ts'
import type {
  CompleteSalePaymentResult,
  PaymentSaleDatabase,
} from '../src/payment-sale-operations.ts'

const ATTEMPT_ID = `pay_${'ab'.repeat(32)}`
const TX_HASH = `0x${'11'.repeat(32)}`
const BLOCK_HASH = `0x${'22'.repeat(32)}`
const LEASE_OWNER = `lease_${'cd'.repeat(16)}`
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bdA02913'
const PAYER = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'

function attempt(overrides: Partial<PaymentAttemptRecord> = {}): PaymentAttemptRecord {
  const request = overrides.request ?? {
    parent_id: null, name: 'TheBlueAI', description: '',
    open_to_building: false, open_to_things: false, open_to_notes: false,
  }
  return {
    publicId: ATTEMPT_ID,
    actorId: 68,
    counterpartyId: null,
    operation: 'frontier',
    targetKey: 'frontier:root:theblueai',
    offerId: null,
    assetType: 'place',
    assetId: null,
    request,
    requestHash: canonicalPaymentRequest(request).hash,
    method: 'x402',
    network: 'base',
    token: USDC,
    payerWallet: PAYER,
    payeeWallet: RECIPIENT,
    amountUnits: 1_000_000n,
    x402Nonce: `0x${'33'.repeat(32)}`,
    x402PayloadDigest: '4'.repeat(64),
    x402ValidAfter: 1n,
    x402ValidBefore: 9_999_999_999n,
    startBlock: 100n,
    startTime: '2026-08-22T00:00:00.000Z',
    endTime: '2026-08-22T03:00:00.000Z',
    status: 'payment_pending',
    leaseOwner: null,
    leaseExpiresAt: null,
    recoveryStartedAt: '2026-08-22T00:00:00.000Z',
    recoveryDeadlineAt: '2026-08-22T02:00:00.000Z',
    txHash: TX_HASH,
    finalizedBlockNumber: null,
    finalizedBlockHash: null,
    finalizedBlockTime: null,
    finalizedAt: null,
    invalidReason: null,
    result: null,
    responseStatus: null,
    response: null,
    responseBody: null,
    paymentResponseHeader: null,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  }
}

const database = {
  query: async (): Promise<readonly Record<string, unknown>[]> => {
    throw new Error('unexpected database query')
  },
}

function serviceDefaults(
  overrides: Partial<PaymentRecoveryRuntimeServices> = {},
): PaymentRecoveryRuntimeServices {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected recovery service call')
  }
  return {
    randomLeaseOwner: () => LEASE_OWNER,
    getAttempt: unexpected,
    listAttempts: unexpected,
    resumeX402: unexpected,
    acquireLease: unexpected,
    acquireDueLease: unexpected,
    completeTreasury: unexpected,
    completeDirectSale: unexpected,
    completeWorldSale: unexpected,
    closeSaleTarget: unexpected,
    closeInvalidSaleTarget: unexpected,
    invalidateSaleTarget: unexpected,
    expireAttempt: unexpected,
    markFounderReview: unexpected,
    returnCredit: unexpected,
    returnDueCredit: unexpected,
    recoverTransaction: unexpected,
    classifyTransfer: unexpected,
    appendLateFinality: unexpected,
    ...overrides,
  } as PaymentRecoveryRuntimeServices
}

test('runtime resumes stored x402 evidence and dispatches its one treasury operation', async () => {
  const stored = attempt()
  const calls: string[] = []
  const runtime = createPaymentRecoveryRuntime(database, serviceDefaults({
    getAttempt: async () => stored,
    resumeX402: async input => {
      calls.push(`resume:${input.attempt.publicId}`)
      return {
        state: 'ready', attemptId: ATTEMPT_ID, leaseOwner: LEASE_OWNER,
        txHash: TX_HASH, payerWallet: PAYER, blockNumber: 101n,
        blockHash: BLOCK_HASH, blockTime: '2026-08-22T00:12:00.000Z',
        finalizedAt: '2026-08-22T00:15:00.000Z', paymentResponseHeader: 'receipt',
      }
    },
    completeTreasury: async (_database, input) => {
      calls.push(`complete:${input.attemptId}:${input.leaseOwner}`)
      return {
        state: 'completed', attemptId: ATTEMPT_ID, actorId: 68,
        operation: 'frontier', method: 'x402', status: 201,
        response: { place: { id: 99 } }, responseBody: '{"place":{"id":99}}',
        paymentResponseHeader: 'receipt',
      }
    },
  }), { now: () => new Date('2026-08-22T00:15:00.000Z') })

  const result = await runtime.recheck(stored)

  assert.deepEqual(result, { state: 'completed', attemptId: ATTEMPT_ID })
  assert.deepEqual(calls, [
    `resume:${ATTEMPT_ID}`,
    `complete:${ATTEMPT_ID}:${LEASE_OWNER}`,
  ])
})

test('runtime uses DB-guarded sale closure at the exact two-hour boundary', async () => {
  const stored = attempt({
    operation: 'direct_sale',
    targetKey: 'direct-sale:90',
    counterpartyId: 7,
    offerId: 90,
    assetType: 'thing',
    assetId: 41,
  })
  let closed = 0
  const runtime = createPaymentRecoveryRuntime(database, serviceDefaults({
    acquireDueLease: async () => ({ acquired: true, attempt: stored, leaseOwner: LEASE_OWNER }),
    closeSaleTarget: async (_database, input) => {
      closed += 1
      assert.deepEqual(input, {
        attemptId: ATTEMPT_ID,
        leaseOwner: LEASE_OWNER,
        state: 'expired',
        reason: 'automatic payment recovery deadline passed',
      })
      return {
        state: 'expired', attemptId: ATTEMPT_ID, actorId: 68,
        operation: 'direct_sale', method: 'x402', targetReleased: true,
      }
    },
  }), { now: () => new Date('2026-08-22T02:00:00.000Z') })

  assert.deepEqual(await runtime.recheck(stored), { state: 'expired', attemptId: ATTEMPT_ID })
  assert.equal(closed, 1)
})

test('runtime dispatches both direct and world sale completions from stored terms', async () => {
  for (const operation of ['direct_sale', 'world_sale'] as const) {
    const stored = attempt({
      operation,
      targetKey: `${operation === 'direct_sale' ? 'direct-sale' : 'world-sale'}:90`,
      counterpartyId: 7,
      offerId: 90,
      assetType: 'thing',
      assetId: 41,
    })
    const calls: string[] = []
    const completeSale = async (_database: PaymentSaleDatabase, input: {
      attemptId: string
      leaseOwner: string
    }): Promise<CompleteSalePaymentResult> => {
      calls.push(`${operation}:${input.attemptId}`)
      return {
        state: 'completed' as const,
        attemptId: ATTEMPT_ID,
        actorId: 68,
        operation,
        method: 'x402' as const,
        status: 200,
        response: { offer: { id: 90, status: 'claimed' } },
        responseBody: '{"offer":{"id":90,"status":"claimed"}}',
        paymentResponseHeader: 'receipt',
      }
    }
    const runtime = createPaymentRecoveryRuntime(database, serviceDefaults({
      getAttempt: async () => stored,
      resumeX402: async () => ({
        state: 'ready', attemptId: ATTEMPT_ID, leaseOwner: LEASE_OWNER,
        txHash: TX_HASH, payerWallet: PAYER, blockNumber: 101n,
        blockHash: BLOCK_HASH, blockTime: '2026-08-22T00:12:00.000Z',
        finalizedAt: '2026-08-22T00:15:00.000Z', paymentResponseHeader: 'receipt',
      }),
      ...(operation === 'direct_sale'
        ? { completeDirectSale: completeSale }
        : { completeWorldSale: completeSale }),
    }), { now: () => new Date('2026-08-22T00:15:00.000Z') })

    assert.deepEqual(await runtime.recheck(stored), {
      state: 'completed', attemptId: ATTEMPT_ID,
    })
    assert.deepEqual(calls, [`${operation}:${ATTEMPT_ID}`])
  }
})

test('runtime synchronizes a terminally invalid world sale without applying its effect', async () => {
  const pending = attempt({
    operation: 'world_sale', targetKey: 'world-sale:90', counterpartyId: 7,
    offerId: 90, assetType: 'thing', assetId: 41,
  })
  const invalid = attempt({ ...pending, status: 'invalid', invalidReason: 'confirmed_mismatch' })
  let reads = 0
  let invalidated = 0
  let synchronized = 0
  const runtime = createPaymentRecoveryRuntime(database, serviceDefaults({
    getAttempt: async () => (++reads === 1 ? pending : invalid),
    resumeX402: async (_input, dependencies) => {
      assert.ok(dependencies?.invalidate)
      await dependencies.invalidate(database, {
        publicId: ATTEMPT_ID,
        leaseOwner: LEASE_OWNER,
        reason: 'confirmed_mismatch',
      })
      return {
        state: 'rejected', status: 400,
        body: { error: 'payment transaction does not match this operation', do_not_pay_again: true },
      }
    },
    invalidateSaleTarget: async (_database, input) => {
      invalidated += 1
      assert.deepEqual(input, {
        attemptId: ATTEMPT_ID,
        leaseOwner: LEASE_OWNER,
        reason: 'confirmed_mismatch',
      })
      return {
        state: 'invalid', attemptId: ATTEMPT_ID, actorId: 68,
        operation: 'world_sale', method: 'x402',
        targetReleased: false, evidenceSynchronized: true,
      }
    },
    closeInvalidSaleTarget: async (_database, input) => {
      synchronized += 1
      assert.equal(input.attemptId, ATTEMPT_ID)
      return {
        state: 'invalid', attemptId: ATTEMPT_ID, actorId: 68,
        operation: 'world_sale', method: 'x402',
        targetReleased: false, evidenceSynchronized: true,
      }
    },
  }), { now: () => new Date('2026-08-22T00:15:00.000Z') })

  assert.deepEqual(await runtime.recheck(pending), {
    state: 'invalid', attemptId: ATTEMPT_ID,
  })
  assert.equal(invalidated, 1)
  assert.equal(synchronized, 1)
})

test('runtime returns only the exact prior credit spend at its deadline', async () => {
  const stored = attempt({ method: 'credit', network: null, token: null, payerWallet: null })
  let returned = 0
  const runtime = createPaymentRecoveryRuntime(database, serviceDefaults({
    returnDueCredit: async (_database, input) => {
      returned += 1
      assert.equal(input.attemptId, ATTEMPT_ID)
      assert.equal(input.actorId, 68)
      assert.equal(input.responseStatus, 409)
      assert.match(input.reason, /deadline/iu)
      return { state: 'returned', attempt_id: ATTEMPT_ID }
    },
  }), { now: () => new Date('2026-08-22T02:00:00.000Z') })

  assert.deepEqual(await runtime.recheck(stored), {
    state: 'credit_returned', attemptId: ATTEMPT_ID,
  })
  assert.equal(returned, 1)
})

test('automatic recovery logs the real server error without logging credentials', () => {
  const runtime = createPaymentRecoveryRuntime(database, serviceDefaults())
  const logged: unknown[][] = []
  const original = console.error
  console.error = (...values: unknown[]) => { logged.push(values) }
  try {
    const failure = Object.assign(new Error(
      'invalid payment attempt transition at postgresql://operator:secret@example.test/city Bearer private-token 1f3d9_sk_private',
    ), { code: '55000' })
    runtime.dependencies.reportFailure?.({
      publicId: ATTEMPT_ID,
      actorId: 68,
      operation: 'frontier',
      method: 'x402',
      status: 'payment_pending',
      recoveryDeadlineAt: '2026-08-22T02:00:00.000Z',
    }, failure)
  } finally {
    console.error = original
  }

  const serialized = JSON.stringify(logged)
  assert.match(serialized, /invalid payment attempt transition/iu)
  assert.match(serialized, /55000/u)
  assert.doesNotMatch(serialized, /operator:secret|private-token|1f3d9_sk_private/iu)
})

test('late finalized x402 evidence is preserved for review without completing an operation', async () => {
  const expired = attempt({ status: 'expired' })
  let appended = 0
  const matched: TransferCheck = {
    state: 'matched', from: PAYER, to: RECIPIENT, amount: 1_000_000n,
    blockNumber: 101n, blockHash: BLOCK_HASH,
    blockTime: new Date('2026-08-22T00:12:00.000Z'),
    finalizedAt: new Date('2026-08-22T02:05:00.000Z'),
  }
  const runtime = createPaymentRecoveryRuntime(database, serviceDefaults({
    getAttempt: async () => expired,
    classifyTransfer: async () => matched,
    appendLateFinality: async (_database, input) => {
      appended += 1
      assert.equal(input.txHash, TX_HASH)
      assert.match(input.reason, /after.*deadline/iu)
      return attempt({
        status: 'founder_review',
        finalizedBlockNumber: 101n,
        finalizedBlockHash: BLOCK_HASH,
        finalizedBlockTime: '2026-08-22T00:12:00.000Z',
        finalizedAt: '2026-08-22T02:05:00.000Z',
      })
    },
  }), { now: () => new Date('2026-08-22T02:05:00.000Z') })

  assert.deepEqual(await runtime.recheck(expired), {
    state: 'founder_review', attemptId: ATTEMPT_ID,
  })
  assert.equal(appended, 1)
})

test('private runtime view is allowlisted and owner lookup never crosses residents', async () => {
  const stored = attempt({
    request: { name: 'TheBlueAI', secret: 'must-not-leak' },
    paymentResponseHeader: 'must-not-leak',
  })
  const runtime = createPaymentRecoveryRuntime(database, serviceDefaults({
    getAttempt: async (_database, input) => input.actorId === 68 ? stored : null,
  }))

  assert.equal(await runtime.getOwnedAttempt(ATTEMPT_ID, 69), null)
  const owned = await runtime.getOwnedAttempt(ATTEMPT_ID, 68)
  assert.ok(owned)
  const view = runtime.privateView(owned)
  assert.equal(view.id, ATTEMPT_ID)
  assert.equal(view.do_not_pay_again, true)
  assert.doesNotMatch(JSON.stringify(view), /secret|must-not-leak|request_hash|lease_owner/iu)
})
