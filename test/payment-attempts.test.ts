import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PaymentAttemptConflictError,
  acquireDueSettlementLease,
  acquireSettlementLease,
  appendLateFinalityEvidence,
  bindPaymentEvidence,
  canonicalPaymentRequest,
  completePaymentAttempt,
  createOrReadPaymentAttempt,
  expirePaymentAttempt,
  findPaymentAttempt,
  findReplayableTargetPaymentAttempt,
  getPaymentAttempt,
  getPaymentAttemptRecord,
  invalidatePaymentAttempt,
  listRecoverablePaymentAttempts,
  markPaymentAttemptFounderReview,
  markPaymentAttemptNeedsReview,
  releaseSettlementLease,
  toPrivatePaymentAttempt,
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
const FACILITATOR_RESPONSE_HEADER = Buffer.from(JSON.stringify({
  success: true,
  transaction: TX,
  payer: PAYER,
  network: 'base',
  facilitator: 'https://facilitator.example.test',
})).toString('base64')
const EXACT_RESPONSE_BODY = '{\n  "thing": { "id": 42 },\n  "ok": true\n}'

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

test('headerless recovery is actor-, target-, and immutable-request-bound', async () => {
  const existing = row({ status: 'completed' })
  const database = new QueuedDatabase([existing], [existing])
  const recovery = {
    actorId: 7,
    counterpartyId: 8,
    operation: 'direct_sale' as const,
    targetKey: 'direct_sale:offer:91:v3',
    offerId: 91,
    assetType: 'thing' as const,
    assetId: 42,
    request: { offer_id: 91, nested: { a: 1, b: 2 } },
  }

  assert.equal(
    (await findReplayableTargetPaymentAttempt(database, recovery))?.publicId,
    existing.publicId,
  )
  assert.deepEqual(database.calls[0]?.params, [7, 'direct_sale', 'direct_sale:offer:91:v3'])
  assert.match(database.calls[0]?.text ?? '', /WITH\s+closed_due_target\s+AS/iu)
  assert.match(
    database.calls[0]?.text ?? '',
    /operation\s+IN\s*\(\s*'frontier'\s*,\s*'kind_invention'\s*,\s*'kind_revision'\s*\)/iu,
  )
  await assert.rejects(
    findReplayableTargetPaymentAttempt(database, {
      ...recovery,
      request: { offer_id: 91, nested: { a: 1, b: 3 } },
    }),
    (error: unknown) => error instanceof PaymentAttemptConflictError,
  )
})

test('create-or-read returns an exact live attempt without another insert', async () => {
  const existing = row()
  const database = new QueuedDatabase([existing])

  const result = await createOrReadPaymentAttempt(database, input(), () => 'pay_new_0000000001')

  assert.equal(result.disposition, 'existing')
  assert.equal(result.attempt.publicId, existing.publicId)
  assert.equal(database.calls.length, 1)
  assert.match(database.calls[0]?.text ?? '', /WITH\s+closed_due_target\s+AS/iu)
  assert.match(database.calls[0]?.text ?? '', /recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu)
  assert.match(
    database.calls[0]?.text ?? '',
    /operation\s+IN\s*\(\s*'frontier'\s*,\s*'kind_invention'\s*,\s*'kind_revision'\s*\)/iu,
  )
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

test('a completed nonce replays across a server-derived target change but not a changed request', async () => {
  const completed = row({
    status: 'completed',
    responseStatus: 200,
    response: { ok: true },
    responseBody: '{"ok":true}',
  })
  const replay = await createOrReadPaymentAttempt(
    new QueuedDatabase([completed]),
    input({ targetKey: 'direct-sale:91:state-after-completion' }),
    () => 'pay_new_0000000001',
  )

  assert.equal(replay.disposition, 'existing')
  assert.equal(replay.attempt.publicId, completed.publicId)

  await assert.rejects(
    createOrReadPaymentAttempt(
      new QueuedDatabase([completed]),
      input({
        targetKey: 'direct-sale:91:state-after-completion',
        request: { offer_id: 91, nested: { a: 1, b: 999 } },
      }),
      () => 'pay_new_0000000001',
    ),
    (error: unknown) => error instanceof PaymentAttemptConflictError,
  )
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

test('due-only settlement leases use the database deadline and read current state on a miss', async () => {
  const due = row({
    status: 'payment_pending',
    txHash: TX,
    recoveryStartedAt: '2026-08-16T12:00:00.000Z',
    recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
    leaseOwner: 'due_worker',
    leaseExpiresAt: '2026-08-16T14:00:30.000Z',
  })
  const winnerDatabase = new QueuedDatabase([due])

  const winner = await acquireDueSettlementLease(
    winnerDatabase,
    { publicId: due.publicId, actorId: due.actorId, leaseMilliseconds: 30_000 },
    () => 'due_worker',
  )

  assert.equal(winner.acquired, true)
  assert.match(winnerDatabase.calls[0]?.text ?? '', /payment-attempts:lease-due/iu)
  assert.match(
    winnerDatabase.calls[0]?.text ?? '',
    /recovery_deadline_at\s+IS\s+NOT\s+NULL[\s\S]*recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu,
  )
  assert.match(
    winnerDatabase.calls[0]?.text ?? '',
    /lease_expires_at\s+IS\s+NULL\s+OR\s+lease_expires_at\s*<=\s*clock_timestamp\(\)/iu,
  )

  const beforeDeadline = row({
    status: 'payment_pending',
    txHash: TX,
    recoveryStartedAt: '2026-08-16T12:00:00.001Z',
    recoveryDeadlineAt: '2026-08-16T14:00:00.001Z',
  })
  const loserDatabase = new QueuedDatabase([], [beforeDeadline])
  const loser = await acquireDueSettlementLease(
    loserDatabase,
    { publicId: beforeDeadline.publicId, actorId: beforeDeadline.actorId, leaseMilliseconds: 30_000 },
    () => 'losing_worker',
  )
  assert.equal(loser.acquired, false)
  assert.equal(loser.attempt?.recoveryDeadlineAt, '2026-08-16T14:00:00.001Z')
  assert.match(loserDatabase.calls[1]?.text ?? '', /payment-attempts:lease-due-read/iu)
})

test('a pending or pre-settlement retry releases only its own lease', async () => {
  const pending = row({ status: 'payment_pending', leaseOwner: null, leaseExpiresAt: null })
  const database = new QueuedDatabase([pending])

  const result = await releaseSettlementLease(database, {
    publicId: pending.publicId,
    leaseOwner: 'lease_winner',
  })

  assert.equal(result.status, 'payment_pending')
  assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*NULL/iu)
  assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*\$2/iu)
  assert.match(database.calls[0]?.text ?? '', /status\s+IN\s*\(/iu)
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
  assert.match(database.calls[0]?.text ?? '', /recovery_started_at\s*=\s*coalesce\s*\(\s*recovery_started_at/iu)
  assert.match(database.calls[0]?.text ?? '', /interval\s+'2 hours'/iu)
})

test('facilitator response bytes survive evidence binding and durable row reload', async () => {
  const pending = {
    ...row({
      status: 'payment_pending',
      leaseOwner: 'lease_winner',
      txHash: TX,
      response: {
        __1f3d9_x402_response_v1: { header: FACILITATOR_RESPONSE_HEADER },
      },
    }),
  }
  const database = new QueuedDatabase([pending])

  const rebound = await bindPaymentEvidence(database, {
    publicId: pending.publicId,
    leaseOwner: 'lease_winner',
    txHash: TX,
    finality: null,
    paymentResponseHeader: FACILITATOR_RESPONSE_HEADER,
  })

  assert.equal(database.calls[0]?.params[7], FACILITATOR_RESPONSE_HEADER)
  assert.equal(rebound.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
  assert.equal(rebound.response, null)

  const completed = {
    ...pending,
    status: 'completed' as const,
    responseStatus: 201,
    response: {
      __1f3d9_x402_response_v1: {
        header: FACILITATOR_RESPONSE_HEADER,
        body: { ok: true, thing: { id: 42 } },
      },
    },
    responseBody: EXACT_RESPONSE_BODY,
  } as PaymentAttemptRecord
  const reloaded = await findPaymentAttempt(new QueuedDatabase([completed]), {
    actorId: completed.actorId,
    operation: 'direct_sale',
    offerId: completed.offerId!,
  })

  assert.equal(reloaded?.paymentResponseHeader, FACILITATOR_RESPONSE_HEADER)
  assert.deepEqual(reloaded?.response, { ok: true, thing: { id: 42 } })
  assert.equal(reloaded?.responseBody, EXACT_RESPONSE_BODY)
})

test('durable response bodies reject malformed, mismatched, and oversized database bytes', async () => {
  const response = {
    __1f3d9_x402_response_v1: {
      header: FACILITATOR_RESPONSE_HEADER,
      body: { ok: true, thing: { id: 42 } },
    },
  }
  for (const responseBody of [
    Buffer.from('not json', 'utf8'),
    Buffer.from('{"ok":false,"thing":{"id":42}}', 'utf8'),
    Buffer.alloc(200_001, 0x20),
  ]) {
    await assert.rejects(
      findPaymentAttempt(new QueuedDatabase([{
        ...row({ status: 'completed', responseStatus: 201, response }),
        responseBody: responseBody as unknown as string,
      } as PaymentAttemptRecord]), {
        actorId: 7,
        operation: 'direct_sale',
        offerId: 91,
      }),
      (error: unknown) => error instanceof TypeError,
    )
  }
})

test('legacy completed rows fall back without claiming byte-exact response storage', async () => {
  const legacy = await findPaymentAttempt(new QueuedDatabase([row({
    status: 'completed',
    responseStatus: 200,
    response: { ok: true },
  })]), {
    actorId: 7,
    operation: 'direct_sale',
    offerId: 91,
  })

  assert.deepEqual(legacy?.response, { ok: true })
  assert.equal(legacy?.responseBody, null)
})

test('facilitator response persistence rejects malformed or oversized headers before SQL', async () => {
  for (const paymentResponseHeader of ['not base64', 'A'.repeat(87_385)]) {
    const database = new QueuedDatabase()
    await assert.rejects(
      bindPaymentEvidence(database, {
        publicId: row().publicId,
        leaseOwner: 'lease_winner',
        txHash: TX,
        finality: null,
        paymentResponseHeader,
      }),
      (error: unknown) => error instanceof TypeError,
    )
    assert.equal(database.calls.length, 0)
  }
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
    responseBody: EXACT_RESPONSE_BODY,
  })

  assert.equal(result.status, 'completed')
  assert.match(database.calls[0]?.text ?? '', /status\s*=\s*'payment_pending'/iu)
  assert.match(database.calls[0]?.text ?? '', /finalized_block_number\s+IS\s+NOT\s+NULL/iu)
  assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*NULL/iu)
  assert.match(database.calls[0]?.text ?? '', /response_body_bytes\s*=\s*decode\s*\(/iu)
  assert.equal(
    Buffer.from(String(database.calls[0]?.params[5]), 'base64').toString('utf8'),
    EXACT_RESPONSE_BODY,
  )
})

test('completion rejects non-object, mismatched, or oversized exact response bodies before SQL', async () => {
  for (const responseBody of [
    '[]',
    '{"ok":false}',
    `{"padding":"${'x'.repeat(200_000)}"}`,
  ]) {
    const database = new QueuedDatabase()
    await assert.rejects(
      completePaymentAttempt(database, {
        publicId: 'pay_existing_0001',
        leaseOwner: 'lease_winner',
        result: { thing_id: 42 },
        responseStatus: 200,
        response: { ok: true },
        responseBody,
      }),
      (error: unknown) => error instanceof TypeError,
    )
    assert.equal(database.calls.length, 0)
  }
})

test('invalid and deadline expiry are forward-only terminal transitions', async () => {
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
  assert.match(expiredDb.calls[0]?.text ?? '', /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*\)/iu)
  assert.match(expiredDb.calls[0]?.text ?? '', /recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu)

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
  assert.match(database.calls[0]?.text ?? '', /recovery_started_at\s*=\s*coalesce\s*\(\s*recovery_started_at/iu)
})

test('bounded recovery scans are ordered, lease-aware, and reject unbounded limits', async () => {
  const due = row({
    status: 'payment_pending',
    txHash: TX,
    recoveryStartedAt: '2026-08-16T12:00:00.000Z',
    recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
  })
  const database = new QueuedDatabase([due])

  const attempts = await listRecoverablePaymentAttempts(database, { limit: 25 })

  assert.equal(attempts[0]?.publicId, due.publicId)
  assert.deepEqual(database.calls[0]?.params, [25])
  assert.match(database.calls[0]?.text ?? '', /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*\)/iu)
  assert.match(database.calls[0]?.text ?? '', /lease_expires_at\s+IS\s+NULL\s+OR\s+lease_expires_at\s*<=\s*clock_timestamp\(\)/iu)
  assert.match(database.calls[0]?.text ?? '', /ORDER\s+BY\s+recovery_deadline_at[\s\S]*updated_at[\s\S]*public_id/iu)
  await assert.rejects(
    listRecoverablePaymentAttempts(new QueuedDatabase(), { limit: 101 }),
    /limit/iu,
  )
})

test('a leased live attempt can become terminal founder review without a domain effect', async () => {
  const review = row({
    status: 'founder_review',
    txHash: TX,
    recoveryStartedAt: '2026-08-16T12:00:00.000Z',
    recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
    invalidReason: 'final payment disposition needs founder review',
  })
  const database = new QueuedDatabase([review])

  const result = await markPaymentAttemptFounderReview(database, {
    publicId: review.publicId,
    leaseOwner: 'lease_winner',
    reason: 'final payment disposition needs founder review',
  })

  assert.equal(result.status, 'founder_review')
  assert.match(database.calls[0]?.text ?? '', /status\s*=\s*'founder_review'/iu)
  assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*NULL/iu)
  assert.match(database.calls[0]?.text ?? '', /lease_owner\s*=\s*\$2/iu)
})

test('late finalized evidence is atomically appended only from expired into founder review', async () => {
  const late = row({
    status: 'founder_review',
    txHash: TX,
    finalizedBlockNumber: 22_000_010n,
    finalizedBlockHash: BLOCK_HASH,
    finalizedBlockTime: '2026-08-16T14:00:01.000Z',
    finalizedAt: '2026-08-16T14:01:00.000Z',
    recoveryStartedAt: '2026-08-16T12:00:00.000Z',
    recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
    invalidReason: 'automatic recovery deadline reached',
  })
  const database = new QueuedDatabase([late])

  const result = await appendLateFinalityEvidence(database, {
    publicId: late.publicId,
    txHash: TX,
    finality: {
      blockNumber: 22_000_010n,
      blockHash: BLOCK_HASH,
      blockTime: '2026-08-16T14:00:01.000Z',
      finalizedAt: '2026-08-16T14:01:00.000Z',
    },
    reason: 'matching payment finalized after automatic recovery ended',
  })

  assert.equal(result.status, 'founder_review')
  assert.match(database.calls[0]?.text ?? '', /status\s*=\s*'founder_review'/iu)
  assert.match(database.calls[0]?.text ?? '', /status\s*=\s*'expired'/iu)
  assert.match(database.calls[0]?.text ?? '', /tx_hash\s*=\s*coalesce\s*\(\s*tx_hash\s*,\s*lower/iu)
  assert.match(database.calls[0]?.text ?? '', /invalid_reason\s*=\s*coalesce\s*\(\s*invalid_reason\s*,\s*\$7\s*\)/iu)
  assert.equal(database.calls[0]?.params[6], 'matching payment finalized after automatic recovery ended')
  assert.match(database.calls[0]?.text ?? '', /tx_hash\s*=\s*lower\s*\(\s*\$2\s*\)/iu)
  assert.match(database.calls[0]?.text ?? '', /finalized_block_number\s+IS\s+NULL/iu)
  assert.match(database.calls[0]?.text ?? '', /recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu)
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
    paymentResponseHeader: FACILITATOR_RESPONSE_HEADER,
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
  assert.equal(encoded.includes(FACILITATOR_RESPONSE_HEADER), false)

  assert.equal(toPublicPaymentAttempt(row({ status: 'payment_pending' })).do_not_pay_again, true)
  assert.equal(toPublicPaymentAttempt(row({ status: 'expired' })).do_not_pay_again, false)
  assert.equal(toPublicPaymentAttempt(row({
    status: 'expired',
    recoveryStartedAt: '2026-08-16T12:00:00.000Z',
    recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
  })).do_not_pay_again, true)
})

test('expired recovered x402 custody says not to repay and remains explicitly recheckable without a hash', () => {
  const recovered = toPrivatePaymentAttempt(row({
    status: 'expired',
    txHash: null,
    recoveryStartedAt: '2026-08-16T12:00:00.000Z',
    recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
  }))
  assert.equal(recovered.do_not_pay_again, true)
  assert.equal(recovered.next_action, 'recheck_for_late_finality')

  const legacyUnused = toPrivatePaymentAttempt(row({
    status: 'expired',
    method: 'x402',
    txHash: null,
    recoveryStartedAt: null,
    recoveryDeadlineAt: null,
  }))
  assert.equal(legacyUnused.do_not_pay_again, false)
  assert.equal(legacyUnused.next_action, 'closed')
})

test('every stored payment state advertises one exact next action', () => {
  const recovery = {
    recoveryStartedAt: '2026-08-16T12:00:00.000Z',
    recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
  }
  const cases: Array<{
    name: string
    attempt: PaymentAttemptRecord
    nextAction: ReturnType<typeof toPrivatePaymentAttempt>['next_action']
  }> = [
    { name: 'settling', attempt: row({ status: 'settling' }), nextAction: 'wait_or_recheck' },
    { name: 'payment pending', attempt: row({ status: 'payment_pending' }), nextAction: 'wait_or_recheck' },
    { name: 'needs review', attempt: row({ status: 'needs_review' }), nextAction: 'wait_or_recheck' },
    {
      name: 'expired recoverable x402',
      attempt: row({ status: 'expired', ...recovery }),
      nextAction: 'recheck_for_late_finality',
    },
    { name: 'founder review', attempt: row({ status: 'founder_review' }), nextAction: 'await_founder_review' },
    { name: 'completed', attempt: row({ status: 'completed' }), nextAction: 'complete' },
    { name: 'legacy completed', attempt: row({ status: 'legacy_completed' }), nextAction: 'complete' },
    {
      name: 'credit returned',
      attempt: row({ status: 'credit_returned', method: 'credit', network: null }),
      nextAction: 'credit_returned',
    },
    { name: 'invalid', attempt: row({ status: 'invalid' }), nextAction: 'closed' },
    { name: 'expired x402 without recovery', attempt: row({ status: 'expired' }), nextAction: 'closed' },
    {
      name: 'expired credit',
      attempt: row({ status: 'expired', method: 'credit', network: null, ...recovery }),
      nextAction: 'closed',
    },
    {
      name: 'expired legacy claim',
      attempt: row({ status: 'expired', method: 'claim', network: null }),
      nextAction: 'closed',
    },
  ]

  for (const current of cases) {
    assert.equal(toPrivatePaymentAttempt(current.attempt).next_action, current.nextAction, current.name)
  }
})

test('private attempt serialization exposes only allowlisted recovery and bound-request facts', () => {
  const storedRequest = {
    offer_id: 91,
    buyer_wallet: PAYER,
    seller_wallet: PAYEE,
    price_usdc: 2,
    asset_type: 'thing',
    asset_id: 42,
    authorization: { signature: 'secret' },
  }
  const secretRow = {
    ...row({
      status: 'payment_pending',
      request: storedRequest,
      requestHash: canonicalPaymentRequest(storedRequest).hash,
      txHash: TX,
      recoveryStartedAt: '2026-08-16T12:00:00.000Z',
      recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
    }),
    request_json: { authorization: { signature: 'secret' } },
    paymentResponseHeader: FACILITATOR_RESPONSE_HEADER,
    x402_payload_digest: '66'.repeat(32),
    lease_owner: 'resident-data-that-must-not-leak',
  }

  const privateView = toPrivatePaymentAttempt(secretRow)
  assert.deepEqual(privateView, {
    id: 'pay_existing_0001',
    state: 'payment_pending',
    operation: 'direct_sale',
    method: 'x402',
    target: 'direct_sale:offer:91:v3',
    request: {
      offer_id: 91,
      buyer_wallet: PAYER,
      seller_wallet: PAYEE,
      price_usdc: 2,
      asset_type: 'thing',
      asset_id: 42,
    },
    result: null,
    transaction: TX,
    recovery_started_at: '2026-08-16T12:00:00.000Z',
    recovery_deadline_at: '2026-08-16T14:00:00.000Z',
    do_not_pay_again: true,
    network: 'base',
    token: USDC,
    recipient: PAYEE,
    amount_units: '2000000',
    next_action: 'wait_or_recheck',
  })
  assert.doesNotMatch(
    JSON.stringify(privateView),
    /authorization|signature|payload_digest|nonce|facilitator|lease_owner|resident-data/iu,
  )
})

test('result retrieval is actor-bound and returns the durable public representation', async () => {
  const completed = row({
    status: 'completed',
    responseStatus: 201,
    response: { ok: true },
    recoveryStartedAt: '2026-08-16T12:00:00.000Z',
    recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
  })
  const database = new QueuedDatabase([completed])

  const result = await getPaymentAttempt(database, {
    publicId: completed.publicId,
    actorId: completed.actorId,
  })

  assert.equal(result?.id, completed.publicId)
  assert.equal(result?.state, 'completed')
  assert.equal(result?.next_action, 'complete')
  assert.match(database.calls[0]?.text ?? '', /public_id\s*=\s*\$1[\s\S]*actor_id\s*=\s*\$2/iu)
  assert.deepEqual(database.calls[0]?.params, [completed.publicId, completed.actorId])
})

test('owner-bound record lookup returns strict stored request and timing facts', async () => {
  const pending = row({
    status: 'payment_pending',
    txHash: TX,
    recoveryStartedAt: '2026-08-16T12:00:00.000Z',
    recoveryDeadlineAt: '2026-08-16T14:00:00.000Z',
  })
  const database = new QueuedDatabase([pending])

  const result = await getPaymentAttemptRecord(database, {
    publicId: pending.publicId,
    actorId: pending.actorId,
  })

  assert.deepEqual(result?.request, { offer_id: 91, nested: { a: 1, b: 2 } })
  assert.equal(result?.recoveryStartedAt, '2026-08-16T12:00:00.000Z')
  assert.equal(result?.recoveryDeadlineAt, '2026-08-16T14:00:00.000Z')
  assert.match(database.calls[0]?.text ?? '', /public_id\s*=\s*\$1[\s\S]*actor_id\s*=\s*\$2/iu)

  await assert.rejects(
    getPaymentAttemptRecord(new QueuedDatabase([{
      ...pending,
      recoveryDeadlineAt: '2026-08-16T14:00:00.001Z',
    }]), {
      publicId: pending.publicId,
      actorId: pending.actorId,
    }),
    /recovery window/iu,
  )
})

test('operation recovery finds only the actor-bound attempt for one offer', async () => {
  const pending = row({ status: 'payment_pending', txHash: TX })
  const database = new QueuedDatabase([pending])

  const result = await findPaymentAttempt(database, {
    actorId: 7,
    operation: 'direct_sale',
    offerId: 91,
  })

  assert.equal(result?.publicId, pending.publicId)
  assert.match(database.calls[0]?.text ?? '', /actor_id\s*=\s*\$1/iu)
  assert.match(database.calls[0]?.text ?? '', /operation\s*=\s*\$2/iu)
  assert.match(database.calls[0]?.text ?? '', /offer_id\s*=\s*\$3/iu)
  assert.deepEqual(database.calls[0]?.params, [7, 'direct_sale', 91])
})
