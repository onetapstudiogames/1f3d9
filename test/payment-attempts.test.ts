import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PaymentAttemptConflictError,
  acquireSettlementLease,
  bindPaymentEvidence,
  canonicalPaymentRequest,
  completePaymentAttempt,
  createOrReadPaymentAttempt,
  expirePaymentAttempt,
  getPaymentAttempt,
  invalidatePaymentAttempt,
  markPaymentAttemptNeedsReview,
  toPublicPaymentAttempt,
  x402NonceKey,
  type PaymentAttemptInput,
  type PaymentAttemptQueryable,
  type PaymentAttemptRecord,
} from '../src/payment-attempts.ts'

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const PAYER = '0x1111111111111111111111111111111111111111'
const PAYEE = '0x2222222222222222222222222222222222222222'
const NONCE = `0x${'33'.repeat(32)}`
const TX = `0x${'44'.repeat(32)}`
const BLOCK_HASH = `0x${'55'.repeat(32)}`

class QueuedDatabase implements PaymentAttemptQueryable {
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

function input(overrides: Partial<PaymentAttemptInput> = {}): PaymentAttemptInput {
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

function row(overrides: Partial<PaymentAttemptRecord> = {}): PaymentAttemptRecord {
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
    txHash: null,
    finalizedBlockNumber: null,
    finalizedBlockHash: null,
    finalizedBlockTime: null,
    finalizedAt: null,
    invalidReason: null,
    result: null,
    responseStatus: null,
    response: null,
    createdAt: '2026-08-16T12:00:01.000Z',
    updatedAt: '2026-08-16T12:00:01.000Z',
    completedAt: null,
    ...overrides,
  }
}

test('canonical payment requests recursively sort keys and have stable hashes', () => {
  const left = canonicalPaymentRequest({ z: [3, { y: true, x: null }], a: { d: 4, c: 'five' } })
  const right = canonicalPaymentRequest({ a: { c: 'five', d: 4 }, z: [3, { x: null, y: true }] })

  assert.equal(left.json, '{"a":{"c":"five","d":4},"z":[3,{"x":null,"y":true}]}')
  assert.equal(left.hash, right.hash)
  assert.match(left.hash, /^[0-9a-f]{64}$/u)
})

test('canonical payment requests reject values without an exact JSON representation', () => {
  const sparse = Array<unknown>(1)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic

  for (const candidate of [
    undefined,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    1n,
    Symbol('not-json'),
    () => undefined,
    { missing: undefined },
    sparse,
    new Date('2026-08-16T00:00:00.000Z'),
    cyclic,
  ]) {
    assert.throws(() => canonicalPaymentRequest(candidate), /canonical JSON/iu)
  }
})

test('the x402 nonce key binds network, exact token, payer, and nonce', () => {
  assert.equal(
    x402NonceKey({ network: 'base', token: USDC, payerWallet: PAYER, nonce: NONCE }),
    `base:${USDC}:${PAYER}:${NONCE}`,
  )
  assert.throws(
    () => x402NonceKey({ network: 'base', token: USDC, payerWallet: PAYEE, nonce: '33' }),
    /nonce/iu,
  )
})

test('create-or-read returns an exact live attempt without another insert', async () => {
  const existing = row()
  const database = new QueuedDatabase([existing])

  const result = await createOrReadPaymentAttempt(database, input(), () => 'pay_new_0000000001')

  assert.equal(result.disposition, 'existing')
  assert.equal(result.attempt.publicId, existing.publicId)
  assert.equal(database.calls.length, 1)
  assert.match(database.calls[0]?.text ?? '', /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*,\s*'completed'/iu)
})

test('create-or-read accepts the legacy bare query function shape used by paid routes', async () => {
  const existing = row()
  const calls: { text: string; params: readonly unknown[] }[] = []
  const query = async (text: string, params: readonly unknown[] = []) => {
    calls.push({ text, params: [...params] })
    return [existing]
  }

  const result = await createOrReadPaymentAttempt(query, input(), () => 'pay_new_0000000001')

  assert.equal(result.disposition, 'existing')
  assert.equal(result.attempt.publicId, existing.publicId)
  assert.equal(calls.length, 1)
  assert.match(calls[0]?.text ?? '', /payment_attempts/iu)
})

test('create-or-read inserts a new attempt with canonical request data and no signature', async () => {
  const created = row({ publicId: 'pay_new_0000000001' })
  const database = new QueuedDatabase([], [created])

  const result = await createOrReadPaymentAttempt(database, input(), () => 'pay_new_0000000001')

  assert.equal(result.disposition, 'created')
  assert.equal(result.attempt.publicId, 'pay_new_0000000001')
  assert.equal(database.calls.length, 2)
  assert.match(database.calls[1]?.text ?? '', /INSERT\s+INTO\s+payment_attempts/iu)
  assert.match(database.calls[1]?.text ?? '', /ON\s+CONFLICT\s+DO\s+NOTHING/iu)
  assert.ok(database.calls[1]?.params.includes('{"nested":{"a":1,"b":2},"offer_id":91}'))
  assert.ok(!database.calls[1]?.params.some(value => typeof value === 'string' && value.includes('signature')))
})

test('create-or-read rejects changed immutable terms for a live target', async () => {
  const changes: Partial<PaymentAttemptInput>[] = [
    { actorId: 9 },
    { operation: 'world_sale' },
    { assetId: 43 },
    { payeeWallet: PAYER },
    { amountUnits: 2_000_001n },
    { request: { offer_id: 91, nested: { a: 1, b: 3 } } },
  ]

  for (const change of changes) {
    const database = new QueuedDatabase([row()])
    await assert.rejects(
      createOrReadPaymentAttempt(database, input(change), () => 'pay_new_0000000001'),
      (error: unknown) => error instanceof PaymentAttemptConflictError,
    )
  }
})

test('a concurrent insert conflict is re-read by target or exact x402 nonce', async () => {
  const concurrent = row()
  const database = new QueuedDatabase([], [], [concurrent])

  const result = await createOrReadPaymentAttempt(database, input(), () => 'pay_new_0000000001')

  assert.equal(result.disposition, 'existing')
  assert.equal(database.calls.length, 3)
  assert.match(database.calls[2]?.text ?? '', /x402_nonce/iu)
  for (const value of ['base', USDC, PAYER, NONCE]) {
    assert.ok(database.calls[2]?.params.includes(value))
  }
})

test('settlement leases use an atomic compare-and-swap and do not expose a losing token', async () => {
  const leased = row({ leaseOwner: 'lease_winner', leaseExpiresAt: '2026-08-16T12:01:00.000Z' })
  const winnerDb = new QueuedDatabase([leased])
  const winner = await acquireSettlementLease(
    winnerDb,
    { publicId: leased.publicId, actorId: leased.actorId, leaseMilliseconds: 30_000 },
    () => 'lease_winner',
  )

  assert.equal(winner.acquired, true)
  if (winner.acquired) assert.equal(winner.leaseOwner, 'lease_winner')
  assert.match(winnerDb.calls[0]?.text ?? '', /UPDATE\s+payment_attempts/iu)
  assert.match(winnerDb.calls[0]?.text ?? '', /lease_expires_at\s*<=\s*now\(\)/iu)
  assert.match(winnerDb.calls[0]?.text ?? '', /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*\)/iu)

  const loserDb = new QueuedDatabase([], [row({ leaseOwner: 'lease_winner' })])
  const loser = await acquireSettlementLease(
    loserDb,
    { publicId: leased.publicId, actorId: leased.actorId, leaseMilliseconds: 30_000 },
    () => 'lease_loser',
  )
  assert.deepEqual(loser, { acquired: false, attempt: row({ leaseOwner: 'lease_winner' }) })
})

test('transaction and finality evidence bind once under the lease', async () => {
  const pending = row({
    status: 'payment_pending',
    leaseOwner: 'lease_winner',
    txHash: TX,
    finalizedBlockNumber: 22_000_010n,
    finalizedBlockHash: BLOCK_HASH,
    finalizedBlockTime: '2026-08-16T12:00:30.000Z',
    finalizedAt: '2026-08-16T12:01:00.000Z',
  })
  const database = new QueuedDatabase([pending])

  const result = await bindPaymentEvidence(database, {
    publicId: pending.publicId,
    leaseOwner: 'lease_winner',
    txHash: TX,
    finality: {
      blockNumber: 22_000_010n,
      blockHash: BLOCK_HASH,
      blockTime: '2026-08-16T12:00:30.000Z',
      finalizedAt: '2026-08-16T12:01:00.000Z',
    },
  })

  assert.equal(result.txHash, TX)
  assert.match(database.calls[0]?.text ?? '', /tx_hash\s+IS\s+NULL\s+OR\s+tx_hash\s*=\s*\$\d+/iu)
  assert.match(database.calls[0]?.text ?? '', /finalized_block_hash\s+IS\s+NULL\s+OR\s+finalized_block_hash\s*=\s*\$\d+/iu)
  assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*\$\d+/iu)
})

test('evidence cannot overwrite a different transaction', async () => {
  const different = row({ status: 'payment_pending', leaseOwner: 'lease_winner', txHash: `0x${'77'.repeat(32)}` })
  const database = new QueuedDatabase([], [different])

  await assert.rejects(
    bindPaymentEvidence(database, {
      publicId: different.publicId,
      leaseOwner: 'lease_winner',
      txHash: TX,
      finality: null,
    }),
    (error: unknown) => error instanceof PaymentAttemptConflictError,
  )
})

test('completion requires pending finalized evidence and preserves the canonical response', async () => {
  const completed = row({
    status: 'completed',
    leaseOwner: null,
    leaseExpiresAt: null,
    txHash: TX,
    finalizedBlockNumber: 22_000_010n,
    finalizedBlockHash: BLOCK_HASH,
    finalizedAt: '2026-08-16T12:01:00.000Z',
    result: { thing_id: 42 },
    responseStatus: 200,
    response: { ok: true, thing: { id: 42 } },
    completedAt: '2026-08-16T12:01:01.000Z',
  })
  const database = new QueuedDatabase([completed])

  const result = await completePaymentAttempt(database, {
    publicId: completed.publicId,
    leaseOwner: 'lease_winner',
    result: { thing_id: 42 },
    responseStatus: 200,
    response: { ok: true, thing: { id: 42 } },
  })

  assert.equal(result.status, 'completed')
  assert.match(database.calls[0]?.text ?? '', /status\s*=\s*'payment_pending'/iu)
  assert.match(database.calls[0]?.text ?? '', /finalized_block_number\s+IS\s+NOT\s+NULL/iu)
  assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*NULL/iu)
})

test('invalid and expired are forward-only terminal transitions', async () => {
  const invalid = row({ status: 'invalid', invalidReason: 'authorization did not settle' })
  const invalidDb = new QueuedDatabase([invalid])
  assert.equal((await invalidatePaymentAttempt(invalidDb, {
    publicId: invalid.publicId,
    leaseOwner: 'lease_winner',
    reason: 'authorization did not settle',
  })).status, 'invalid')
  assert.match(invalidDb.calls[0]?.text ?? '', /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*\)/iu)

  const expired = row({ status: 'expired', invalidReason: 'authorization expired unused' })
  const expiredDb = new QueuedDatabase([expired])
  assert.equal((await expirePaymentAttempt(expiredDb, {
    publicId: expired.publicId,
    leaseOwner: 'lease_winner',
    reason: 'authorization expired unused',
  })).status, 'expired')
  assert.match(expiredDb.calls[0]?.text ?? '', /status\s*=\s*'settling'/iu)

  const completed = row({ status: 'completed' })
  const blockedDb = new QueuedDatabase([], [completed])
  await assert.rejects(
    invalidatePaymentAttempt(blockedDb, {
      publicId: completed.publicId,
      leaseOwner: 'lease_winner',
      reason: 'late invalidation',
    }),
    (error: unknown) => error instanceof PaymentAttemptConflictError,
  )
})

test('ambiguous settlement becomes durable review and never asks for another payment', async () => {
  const review = row({
    status: 'needs_review',
    invalidReason: 'facilitator outcome is ambiguous',
  })
  const database = new QueuedDatabase([review])
  const result = await markPaymentAttemptNeedsReview(database, {
    publicId: review.publicId,
    leaseOwner: 'lease_winner',
    reason: 'facilitator outcome is ambiguous',
  })

  assert.equal(result.status, 'needs_review')
  assert.equal(toPublicPaymentAttempt(result).do_not_pay_again, true)
  assert.match(database.calls[0]?.text ?? '', /status\s*=\s*'needs_review'/iu)
  assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*NULL/iu)
})

test('public pending/completed views say not to pay again and omit payment secrets', () => {
  const secretRow = {
    ...row({
      status: 'completed',
      txHash: TX,
      result: { thing_id: 42 },
      responseStatus: 200,
      response: { ok: true },
    }),
    request_json: { authorization: { signature: 'secret' } },
    x402_payload_digest: '66'.repeat(32),
  }
  const publicView = toPublicPaymentAttempt(secretRow)
  const encoded = JSON.stringify(publicView)

  assert.deepEqual(publicView, {
    id: 'pay_existing_0001',
    state: 'completed',
    do_not_pay_again: true,
    transaction: TX,
    response_status: 200,
    response: { ok: true },
  })
  assert.doesNotMatch(encoded, /authorization|signature|payload_digest|nonce/iu)

  assert.equal(toPublicPaymentAttempt(row({ status: 'payment_pending' })).do_not_pay_again, true)
  assert.equal(toPublicPaymentAttempt(row({ status: 'expired' })).do_not_pay_again, false)
})

test('result retrieval is actor-bound and returns the durable public representation', async () => {
  const completed = row({ status: 'completed', responseStatus: 201, response: { ok: true } })
  const database = new QueuedDatabase([completed])

  const result = await getPaymentAttempt(database, {
    publicId: completed.publicId,
    actorId: completed.actorId,
  })

  assert.equal(result?.id, completed.publicId)
  assert.equal(result?.response_status, 201)
  assert.match(database.calls[0]?.text ?? '', /public_id\s*=\s*\$1[\s\S]*actor_id\s*=\s*\$2/iu)
  assert.deepEqual(database.calls[0]?.params, [completed.publicId, completed.actorId])
})
