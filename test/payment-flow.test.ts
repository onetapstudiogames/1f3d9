import test from 'node:test'
import assert from 'node:assert/strict'
import { requirements, parseX402Payment } from '../src/pay.ts'
import {
  resumeDurableX402,
  runDurableX402,
  type PaymentFlowDependencies,
} from '../src/payment-flow.ts'
import { findPaymentAttempt, type PaymentAttemptRecord } from '../src/payment-attempts.ts'

const PAYER = '0x1111111111111111111111111111111111111111'
const PAYEE = '0x2222222222222222222222222222222222222222'
const TX = `0x${'33'.repeat(32)}`
const BLOCK_HASH = `0x${'44'.repeat(32)}`
const NONCE = `0x${'55'.repeat(32)}`
const FACILITATOR_RESPONSE = {
  success: true,
  transaction: TX,
  payer: PAYER,
  network: 'base',
  facilitator: 'https://facilitator.example.test',
}
const FACILITATOR_RESPONSE_HEADER = Buffer.from(JSON.stringify(FACILITATOR_RESPONSE)).toString('base64')
const EXACT_RESPONSE_BODY = '{\n  "thing": { "id": 42 },\n  "ok": true\n}'
const accepted = requirements(PAYEE, 2, '/api/transfer', 'test sale')
const paymentHeader = Buffer.from(JSON.stringify({
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: {
    signature: `0x${'66'.repeat(65)}`,
    authorization: {
      from: PAYER,
      to: PAYEE,
      value: '2000000',
      validAfter: '1799999999',
      validBefore: '1800000900',
      nonce: NONCE,
    },
  },
})).toString('base64')

function attempt(overrides: Partial<PaymentAttemptRecord> = {}): PaymentAttemptRecord {
  return {
    publicId: `pay_${'77'.repeat(32)}`,
    actorId: 7,
    counterpartyId: 8,
    operation: 'direct_sale',
    targetKey: 'direct-sale:91',
    offerId: 91,
    assetType: 'thing',
    assetId: 42,
    requestHash: '88'.repeat(32),
    method: 'x402',
    network: 'base',
    token: accepted.asset.toLowerCase(),
    payerWallet: PAYER,
    payeeWallet: PAYEE,
    amountUnits: 2_000_000n,
    x402Nonce: NONCE,
    x402PayloadDigest: '99'.repeat(32),
    x402ValidAfter: 1_799_999_999n,
    x402ValidBefore: 1_800_000_900n,
    startBlock: 100n,
    startTime: '2027-01-15T08:00:00.000Z',
    endTime: '2027-01-15T08:15:00.000Z',
    status: 'settling',
    leaseOwner: null,
    leaseExpiresAt: null,
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
    createdAt: '2027-01-15T08:00:00.000Z',
    updatedAt: '2027-01-15T08:00:00.000Z',
    completedAt: null,
    ...overrides,
  }
}

function dependencies(
  events: string[],
  overrides: Partial<PaymentFlowDependencies> = {},
): PaymentFlowDependencies {
  const parsed = parseX402Payment(paymentHeader, accepted)
  assert.ok(!('error' in parsed))
  return {
    custodyReady: async () => { events.push('schema'); return true },
    currentBlock: async () => { events.push('block'); return 100n },
    createOrRead: async () => {
      events.push('create')
      return { disposition: 'created', attempt: attempt() }
    },
    acquireLease: async () => {
      events.push('lease')
      return {
        acquired: true,
        leaseOwner: 'lease-owner',
        attempt: attempt({ leaseOwner: 'lease-owner', leaseExpiresAt: '2027-01-15T08:01:00Z' }),
      }
    },
    verify: async () => { events.push('verify'); return { ...parsed, state: 'verified', verificationPayer: PAYER } },
    settle: async () => {
      events.push('settle')
      return { state: 'settled', transaction: TX, payer: PAYER, response: FACILITATOR_RESPONSE }
    },
    bindEvidence: async (_database, input) => {
      events.push(input.finality ? 'bind-final' : 'bind-tx')
      return attempt({
        status: 'payment_pending',
        leaseOwner: 'lease-owner',
        leaseExpiresAt: '2027-01-15T08:01:00Z',
        txHash: TX,
        ...(input.finality ? {
          finalizedBlockNumber: 101n,
          finalizedBlockHash: BLOCK_HASH,
          finalizedBlockTime: '2027-01-15T08:05:00.000Z',
          finalizedAt: '2027-01-15T08:06:00.000Z',
        } : {}),
      })
    },
    classify: async () => {
      events.push('classify')
      return {
        state: 'matched', from: PAYER, to: PAYEE, amount: 2_000_000n,
        blockTime: new Date('2027-01-15T08:05:00.000Z'),
        blockNumber: 101n, blockHash: BLOCK_HASH,
        finalizedAt: new Date('2027-01-15T08:06:00.000Z'),
      }
    },
    recoverTransaction: async () => { events.push('recover'); return null },
    releaseLease: async (_database, input) => {
      events.push('release')
      return attempt({ status: 'payment_pending', txHash: TX, leaseOwner: null, leaseExpiresAt: null })
    },
    invalidate: async () => { events.push('invalidate'); return attempt({ status: 'invalid' }) },
    needsReview: async () => { events.push('review'); return attempt({ status: 'needs_review' }) },
    ...overrides,
  }
}

const input = {
  database: { query: async () => [] },
  paymentHeader,
  accepted,
  actorId: 7,
  counterpartyId: 8,
  operation: 'direct_sale' as const,
  targetKey: 'direct-sale:91',
  offerId: 91,
  assetType: 'thing' as const,
  assetId: 42,
  request: { action: 'claim', offer_id: 91 },
  notBefore: new Date('2027-01-15T08:00:00.000Z'),
  notAfter: new Date('2027-01-15T08:15:00.500Z'),
}

test('custody exists before settlement and final evidence becomes ready exactly once', async () => {
  const events: string[] = []
  const result = await runDurableX402(input, dependencies(events))

  assert.equal(result.state, 'ready')
  if (result.state === 'ready') {
    assert.equal(result.attemptId, attempt().publicId)
    assert.equal(result.leaseOwner, 'lease-owner')
    assert.equal(result.txHash, TX)
    assert.ok(result.paymentResponseHeader)
  }
  assert.deepEqual(events, [
    'block', 'create', 'schema', 'lease', 'verify', 'settle',
    'bind-tx', 'classify', 'bind-final',
  ])
})

test('a reservation wallet mismatch is rejected before custody or settlement', async () => {
  const events: string[] = []
  const result = await runDurableX402({
    ...input,
    expectedPayerWallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }, dependencies(events))

  assert.equal(result.state, 'rejected')
  assert.deepEqual(events, [])
})

test('new payment fails closed before verification or settlement when byte replay schema is absent', async () => {
  const events: string[] = []
  const result = await runDurableX402(input, dependencies(events, {
    custodyReady: async () => {
      events.push('schema')
      return false
    },
  }))

  assert.equal(result.state, 'unavailable')
  if (result.state === 'unavailable') {
    assert.equal(result.status, 503)
    assert.equal(result.body.do_not_pay_again, true)
    assert.match(result.body.error, /temporarily unavailable|upgraded/iu)
  }
  assert.deepEqual(events, ['block', 'create', 'schema'])
  assert.equal(events.includes('verify'), false)
  assert.equal(events.includes('settle'), false)
})

test('a persisted transaction skips verification and settlement on retry', async () => {
  const events: string[] = []
  const deps = dependencies(events, {
    createOrRead: async () => {
      events.push('create')
      return { disposition: 'existing', attempt: attempt({ status: 'payment_pending', txHash: TX }) }
    },
    acquireLease: async () => {
      events.push('lease')
      return {
        acquired: true,
        leaseOwner: 'lease-owner',
        attempt: attempt({ status: 'payment_pending', txHash: TX, leaseOwner: 'lease-owner' }),
      }
    },
  })

  assert.equal((await runDurableX402(input, deps)).state, 'ready')
  assert.deepEqual(events, ['block', 'create', 'schema', 'lease', 'classify', 'bind-final'])
})

test('an ambiguous settlement becomes durable review and never invites a new payment', async () => {
  const events: string[] = []
  const deps = dependencies(events, {
    settle: async () => {
      events.push('settle')
      return { state: 'ambiguous', transaction: null, payer: PAYER, error: 'timeout' }
    },
  })
  const result = await runDurableX402(input, deps)

  assert.equal(result.state, 'payment_pending')
  if (result.state === 'payment_pending') assert.equal(result.body.do_not_pay_again, true)
  assert.deepEqual(events, ['block', 'create', 'schema', 'lease', 'verify', 'settle', 'review'])
})

test('unfinalized evidence stays pending and releases the worker lease', async () => {
  const events: string[] = []
  const deps = dependencies(events, {
    classify: async () => { events.push('classify'); return { state: 'pending' } },
  })
  const result = await runDurableX402(input, deps)

  assert.equal(result.state, 'payment_pending')
  assert.deepEqual(events, [
    'block', 'create', 'schema', 'lease', 'verify', 'settle', 'bind-tx', 'classify', 'release',
  ])
})

test('a completed retry returns the stored canonical response without chain or facilitator calls', async () => {
  const events: string[] = []
  const stored = {
    ...attempt({
    status: 'completed', responseStatus: 201,
    txHash: TX,
    response: {
      __1f3d9_x402_response_v1: {
        header: FACILITATOR_RESPONSE_HEADER,
        body: { ok: true, thing: { id: 42 } },
      },
    },
    }),
    responseBody: EXACT_RESPONSE_BODY,
  } as PaymentAttemptRecord
  const persisted = await findPaymentAttempt({ query: async () => [stored] }, {
    actorId: stored.actorId,
    operation: 'direct_sale',
    offerId: stored.offerId!,
  })
  assert.ok(persisted)
  const deps = dependencies(events, {
    createOrRead: async () => {
      events.push('create')
      return {
        disposition: 'existing',
        attempt: persisted,
      }
    },
  })
  const result = await runDurableX402(input, deps)

  assert.equal(result.state, 'completed')
  if (result.state === 'completed') {
    assert.equal(result.status, 201)
    assert.deepEqual(result.body, { ok: true, thing: { id: 42 } })
    assert.equal(result.responseBody, EXACT_RESPONSE_BODY)
    assert.equal(result.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
    assert.deepEqual(JSON.parse(Buffer.from(result.paymentResponseHeader, 'base64').toString('utf8')), FACILITATOR_RESPONSE)
  }
  assert.deepEqual(events, ['block', 'create'])
})

test('a pre-upgrade completed row uses the compatibility receipt without another settlement', async () => {
  const events: string[] = []
  const deps = dependencies(events, {
    custodyReady: async () => {
      events.push('schema')
      return false
    },
    createOrRead: async () => {
      events.push('create')
      return {
        disposition: 'existing',
        attempt: attempt({
          status: 'completed',
          responseStatus: 201,
          txHash: TX,
          response: { ok: true, thing: { id: 42 } },
        }),
      }
    },
  })

  const result = await runDurableX402(input, deps)

  assert.equal(result.state, 'completed')
  if (result.state === 'completed') {
    assert.equal(result.responseBody, null)
    assert.deepEqual(
      JSON.parse(Buffer.from(result.paymentResponseHeader!, 'base64').toString('utf8')),
      { success: true, transaction: TX, payer: PAYER },
    )
  }
  assert.deepEqual(events, ['block', 'create'])
  assert.equal(events.includes('settle'), false)
})

test('schema capability is required before a custody lease or settlement', async () => {
  const events: string[] = []
  const result = await runDurableX402(input, dependencies(events, {
    custodyReady: async () => { events.push('schema'); return false },
  }))

  assert.equal(result.state, 'unavailable')
  assert.deepEqual(events, ['block', 'create', 'schema'])
})

test('pending payment resume fails closed before chain work when byte replay schema is absent', async () => {
  const events: string[] = []
  const stored = attempt({ status: 'payment_pending', txHash: TX })
  const result = await resumeDurableX402({
    database: input.database,
    attempt: stored,
    actorId: stored.actorId,
  }, dependencies(events, {
    custodyReady: async () => {
      events.push('schema')
      return false
    },
  }))

  assert.equal(result.state, 'unavailable')
  assert.deepEqual(events, ['schema'])
  assert.equal(events.includes('lease'), false)
  assert.equal(events.includes('classify'), false)
})

test('a finalized transfer outside the conservative window is terminally rejected', async () => {
  const events: string[] = []
  const deps = dependencies(events, {
    classify: async () => {
      events.push('classify')
      return {
        state: 'matched', from: PAYER, to: PAYEE, amount: 2_000_000n,
        blockTime: new Date('2027-01-15T08:15:00.000Z'),
        blockNumber: 101n, blockHash: BLOCK_HASH,
        finalizedAt: new Date('2027-01-15T08:16:00.000Z'),
      }
    },
  })
  const result = await runDurableX402(input, deps)

  assert.equal(result.state, 'rejected')
  assert.ok(events.includes('invalidate'))
  assert.ok(!events.includes('bind-final'))
})

test('a stored pending attempt can finish after wall-clock expiry when its block was inside the original window', async () => {
  const events: string[] = []
  const stored = attempt({
    status: 'payment_pending',
    txHash: TX,
    startTime: '2027-01-15T08:00:00.000Z',
    endTime: '2027-01-15T08:15:00.000Z',
  })
  const result = await resumeDurableX402({
    database: input.database,
    attempt: stored,
    actorId: 7,
  }, dependencies(events, {
    acquireLease: async () => {
      events.push('lease')
      return {
        acquired: true,
        leaseOwner: 'lease-owner',
        attempt: { ...stored, leaseOwner: 'lease-owner' },
      }
    },
  }))

  assert.equal(result.state, 'ready')
  assert.deepEqual(events, ['schema', 'lease', 'classify', 'bind-final'])
})

test('resume never settles an attempt whose transaction outcome is still unknown', async () => {
  const events: string[] = []
  const stored = attempt({ status: 'needs_review', txHash: null })
  const result = await resumeDurableX402({
    database: input.database,
    attempt: stored,
    actorId: 7,
  }, dependencies(events, {
    acquireLease: async () => {
      events.push('lease')
      return {
        acquired: true,
        leaseOwner: 'lease-owner',
        attempt: { ...stored, leaseOwner: 'lease-owner' },
      }
    },
  }))

  assert.equal(result.state, 'payment_pending')
  assert.deepEqual(events, ['schema', 'lease', 'recover', 'review'])
  assert.equal(events.includes('settle'), false)
})
