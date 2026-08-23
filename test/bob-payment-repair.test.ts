import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOB_COFFEE_REVIEW_REASON,
  BOB_REPAIR_APPLY_ACKNOWLEDGEMENT,
  BOB_REPAIR_CREDIT_REASON,
  BOB_REPAIR_CREDIT_SOURCE_KEY,
  BOB_REPAIR_EXPECTATIONS,
  BobPaymentRepairAbortError,
  buildBobPaymentRepairPlan,
  parseBobPaymentRepairArgs,
  runBobPaymentRepair,
  safeBobPaymentRepairError,
  type BobPaymentRepairApplyOperations,
  type BobRepairSnapshot,
  type BobTransferEvidence,
} from '../scripts/repair-bob-payments.ts'

type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T

const EXPECTED_REQUESTS = Object.freeze({
  coffee: Object.freeze({
    parent_id: null,
    name: 'coffee-shop',
    description: '',
    open_to_building: false,
    open_to_things: false,
    open_to_notes: false,
  }),
  theBlueAI: Object.freeze({
    parent_id: null,
    name: 'TheBlueAI',
    description: '',
    open_to_building: false,
    open_to_things: false,
    open_to_notes: false,
  }),
})

function expectedAttempt(
  key: 'coffee' | 'theBlueAI',
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const expected = BOB_REPAIR_EXPECTATIONS[key]
  return {
    public_id: expected.attemptId,
    actor_id: 68,
    resident_handle: 'bob',
    counterparty_id: null,
    operation: 'frontier',
    target_key: expected.targetKey,
    offer_id: null,
    asset_type: null,
    asset_id: null,
    request_hash: expected.requestHash,
    request_json: expected.request,
    method: 'x402',
    network: 'base',
    token: BOB_REPAIR_EXPECTATIONS.token,
    payer_wallet: BOB_REPAIR_EXPECTATIONS.payer,
    payee_wallet: BOB_REPAIR_EXPECTATIONS.recipient,
    amount_units: '1000000',
    status: 'payment_pending',
    lease_owner: null,
    lease_expires_at: null,
    recovery_started_at: expected.recoveryStartedAt,
    recovery_deadline_at: expected.recoveryDeadlineAt,
    tx_hash: expected.txHash,
    finalized_block_number: null,
    finalized_block_hash: null,
    finalized_block_time: null,
    finalized_at: null,
    invalid_reason: null,
    completed_at: null,
    updated_at: expected.updatedAt,
    database_now: '2026-08-23T12:00:00.000Z',
    ...overrides,
  }
}

function matchedTransfer(
  key: 'coffee' | 'theBlueAI',
): Extract<BobTransferEvidence, { state: 'matched' }> {
  const expected = BOB_REPAIR_EXPECTATIONS[key]
  return Object.freeze({
    state: 'matched',
    from: BOB_REPAIR_EXPECTATIONS.payer,
    to: BOB_REPAIR_EXPECTATIONS.recipient,
    amount: 1_000_000n,
    blockNumber: BigInt(expected.blockNumber),
    blockHash: expected.blockHash,
    blockTime: new Date(expected.blockTime),
    finalizedAt: new Date('2026-08-22T12:00:00.000Z'),
  })
}

function transfers(): Readonly<Record<string, BobTransferEvidence>> {
  return Object.freeze({
    [BOB_REPAIR_EXPECTATIONS.coffee.txHash]: matchedTransfer('coffee'),
    [BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash]: matchedTransfer('theBlueAI'),
  })
}

function initialSnapshot(): BobRepairSnapshot {
  return {
    residents: [{ id: 68, handle: 'bob' }],
    attempts: [expectedAttempt('coffee'), expectedAttempt('theBlueAI')],
    paymentUses: [],
    fees: [],
    worldRoots: [{ id: 1, name: 'the world', place_kind: 'world', owner_id: null }],
    places: [],
    credits: [],
  }
}

function finalSnapshot(): BobRepairSnapshot {
  const initial = initialSnapshot()
  const blueRequest = BOB_REPAIR_EXPECTATIONS.theBlueAI.request
  return {
    ...initial,
    attempts: [
      expectedAttempt('coffee', {
        status: 'founder_review',
        finalized_block_number: BOB_REPAIR_EXPECTATIONS.coffee.blockNumber,
        finalized_block_hash: BOB_REPAIR_EXPECTATIONS.coffee.blockHash,
        finalized_block_time: BOB_REPAIR_EXPECTATIONS.coffee.blockTime,
        finalized_at: '2026-08-22T12:00:00.000Z',
        invalid_reason: BOB_COFFEE_REVIEW_REASON,
        updated_at: '2026-08-22T12:00:01.000Z',
      }),
      expectedAttempt('theBlueAI', {
        status: 'completed',
        finalized_block_number: BOB_REPAIR_EXPECTATIONS.theBlueAI.blockNumber,
        finalized_block_hash: BOB_REPAIR_EXPECTATIONS.theBlueAI.blockHash,
        finalized_block_time: BOB_REPAIR_EXPECTATIONS.theBlueAI.blockTime,
        finalized_at: '2026-08-22T12:00:00.000Z',
        completed_at: '2026-08-22T12:00:01.000Z',
        updated_at: '2026-08-22T12:00:01.000Z',
      }),
    ],
    paymentUses: [{
      tx_hash: BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash,
      payment_attempt_id: BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId,
      actor_id: 68,
      purpose: 'frontier',
      payer_wallet: BOB_REPAIR_EXPECTATIONS.payer,
      payee_wallet: BOB_REPAIR_EXPECTATIONS.recipient,
      amount_usdc: '1.000000',
    }],
    fees: [{
      resident_id: 68,
      purpose: 'frontier',
      amount_usdc: '1.000000',
      tx_hash: BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash,
    }],
    places: [{
      id: 901,
      parent_id: 1,
      place_kind: 'continent',
      name: 'TheBlueAI',
      description: blueRequest.description,
      owner_id: 68,
      open_to_building: blueRequest.open_to_building,
      open_to_things: blueRequest.open_to_things,
      open_to_notes: blueRequest.open_to_notes,
    }],
    credits: [{
      resident_id: 68,
      entry_kind: 'founder_issue',
      amount_units: '1000000',
      founder_id: 1,
      source_key: BOB_REPAIR_CREDIT_SOURCE_KEY,
      reason: BOB_REPAIR_CREDIT_REASON,
    }],
  }
}

function cloneSnapshot(snapshot: BobRepairSnapshot): Mutable<BobRepairSnapshot> {
  return structuredClone(snapshot) as Mutable<BobRepairSnapshot>
}

test('guarded Bob constants preserve the independently verified production facts', () => {
  assert.equal(BOB_REPAIR_APPLY_ACKNOWLEDGEMENT, 'APPLY_BOB_PAYMENT_REPAIR_WAVE_15')
  assert.deepEqual(BOB_REPAIR_EXPECTATIONS.coffee.request, EXPECTED_REQUESTS.coffee)
  assert.deepEqual(BOB_REPAIR_EXPECTATIONS.theBlueAI.request, EXPECTED_REQUESTS.theBlueAI)
  assert.equal(BOB_REPAIR_EXPECTATIONS.coffee.blockNumber, '50297998')
  assert.equal(BOB_REPAIR_EXPECTATIONS.theBlueAI.blockNumber, '50297465')
  assert.equal(BOB_REPAIR_EXPECTATIONS.coffee.recoveryDeadlineAt, '2026-08-22T09:56:08.722Z')
  assert.equal(BOB_REPAIR_EXPECTATIONS.theBlueAI.recoveryDeadlineAt, '2026-08-22T09:57:45.063Z')
  assert.equal(BOB_REPAIR_CREDIT_SOURCE_KEY, `bob-payment-repair:${BOB_REPAIR_EXPECTATIONS.coffee.attemptId}`)
})

test('pure planning proposes exactly one frontier, one no-effect close, and one credit', () => {
  const plan = buildBobPaymentRepairPlan(initialSnapshot(), transfers())

  assert.equal(plan.state, 'work_required')
  assert.deepEqual(plan.actions.map(action => action.kind), [
    'complete_theblueai',
    'close_coffee_probe',
    'issue_founder_credit',
  ])
  assert.deepEqual(plan.actions.map(action => action.attempt_id), [
    BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId,
    BOB_REPAIR_EXPECTATIONS.coffee.attemptId,
    BOB_REPAIR_EXPECTATIONS.coffee.attemptId,
  ])
  assert.equal(plan.actions.filter(action => action.kind === 'complete_theblueai').length, 1)
  assert.equal(plan.actions.filter(action => action.kind === 'issue_founder_credit').length, 1)
  const complete = plan.actions.find(action => action.kind === 'complete_theblueai')
  const close = plan.actions.find(action => action.kind === 'close_coffee_probe')
  assert.equal(complete?.world_root_id, 1)
  assert.deepEqual(complete?.place, {
    name: 'TheBlueAI',
    description: '',
    open_to_building: false,
    open_to_things: false,
    open_to_notes: false,
  })
  assert.equal(complete?.guard.canonical_block_hash, BOB_REPAIR_EXPECTATIONS.theBlueAI.blockHash)
  assert.equal(close?.guard.request_hash, BOB_REPAIR_EXPECTATIONS.coffee.requestHash)
  assert.equal(close?.guard.recovery_deadline_at, BOB_REPAIR_EXPECTATIONS.coffee.recoveryDeadlineAt)
})

test('an expired automatic lease is repairable and its observed update time becomes the exact guard', () => {
  const snapshot = cloneSnapshot(initialSnapshot())
  snapshot.attempts[0] = expectedAttempt('coffee', {
    lease_owner: 'expired-cron-lease',
    lease_expires_at: '2026-08-23T11:59:30.000Z',
    updated_at: '2026-08-23T11:59:00.000Z',
  })
  snapshot.attempts[1] = expectedAttempt('theBlueAI', {
    lease_owner: 'expired-cron-lease',
    lease_expires_at: '2026-08-23T11:59:31.000Z',
    updated_at: '2026-08-23T11:59:01.000Z',
  })

  const plan = buildBobPaymentRepairPlan(snapshot, transfers())
  assert.equal(plan.state, 'work_required')
  const complete = plan.actions.find(action => action.kind === 'complete_theblueai')
  const close = plan.actions.find(action => action.kind === 'close_coffee_probe')
  assert.equal(complete?.guard.expected_updated_at, '2026-08-23T11:59:01.000Z')
  assert.equal(close?.guard.expected_updated_at, '2026-08-23T11:59:00.000Z')
})

test('active, malformed, future-dated, or backward-moving lease state is never repairable', () => {
  const cases: readonly Readonly<{
    name: string
    overrides: Readonly<Record<string, unknown>>
  }>[] = [
    {
      name: 'active lease',
      overrides: {
        lease_owner: 'active-cron-lease',
        lease_expires_at: '2026-08-23T12:00:30.000Z',
        updated_at: '2026-08-23T11:59:00.000Z',
      },
    },
    { name: 'owner without expiry', overrides: { lease_owner: 'broken-lease' } },
    { name: 'expiry without owner', overrides: { lease_expires_at: '2026-08-23T11:59:30.000Z' } },
    {
      name: 'future update time',
      overrides: { updated_at: '2026-08-23T12:00:01.000Z' },
    },
    {
      name: 'backward update time',
      overrides: { updated_at: '2026-08-22T07:00:00.000Z' },
    },
  ]

  for (const candidate of cases) {
    const snapshot = cloneSnapshot(initialSnapshot())
    snapshot.attempts[0] = expectedAttempt('coffee', candidate.overrides)
    assert.throws(
      () => buildBobPaymentRepairPlan(snapshot, transfers()),
      BobPaymentRepairAbortError,
      candidate.name,
    )
  }
})

test('every guarded database fact aborts when changed or ambiguous', () => {
  const cases: readonly Readonly<{
    name: string
    change(snapshot: Mutable<BobRepairSnapshot>): void
  }>[] = [
    { name: 'resident missing', change: snapshot => { snapshot.residents = [] } },
    { name: 'resident handle', change: snapshot => { snapshot.residents[0]!.handle = 'not-bob' } },
    { name: 'attempt missing', change: snapshot => { snapshot.attempts = snapshot.attempts.slice(1) } },
    { name: 'attempt duplicated', change: snapshot => { snapshot.attempts.push({ ...snapshot.attempts[0]! }) } },
    { name: 'actor', change: snapshot => { snapshot.attempts[0]!.actor_id = 67 } },
    { name: 'request', change: snapshot => { snapshot.attempts[0]!.request_json = { ...EXPECTED_REQUESTS.coffee, description: 'changed' } } },
    { name: 'malformed request', change: snapshot => { snapshot.attempts[0]!.request_json = { name: undefined } } },
    { name: 'request hash', change: snapshot => { snapshot.attempts[0]!.request_hash = '0'.repeat(64) } },
    { name: 'status', change: snapshot => { snapshot.attempts[0]!.status = 'settling' } },
    { name: 'transaction hash', change: snapshot => { snapshot.attempts[0]!.tx_hash = `0x${'11'.repeat(32)}` } },
    { name: 'target', change: snapshot => { snapshot.attempts[0]!.target_key = 'frontier:root:changed' } },
    { name: 'operation', change: snapshot => { snapshot.attempts[0]!.operation = 'kind_invention' } },
    { name: 'method', change: snapshot => { snapshot.attempts[0]!.method = 'credit' } },
    { name: 'network', change: snapshot => { snapshot.attempts[0]!.network = 'ethereum' } },
    { name: 'token', change: snapshot => { snapshot.attempts[0]!.token = `0x${'11'.repeat(20)}` } },
    { name: 'payer', change: snapshot => { snapshot.attempts[0]!.payer_wallet = `0x${'22'.repeat(20)}` } },
    { name: 'recipient', change: snapshot => { snapshot.attempts[0]!.payee_wallet = `0x${'33'.repeat(20)}` } },
    { name: 'amount', change: snapshot => { snapshot.attempts[0]!.amount_units = '999999' } },
    { name: 'stored finality', change: snapshot => { snapshot.attempts[0]!.finalized_block_number = '1' } },
    { name: 'recovery deadline', change: snapshot => { snapshot.attempts[0]!.recovery_deadline_at = '2026-08-22T10:00:00.000Z' } },
    { name: 'database clock missing', change: snapshot => { snapshot.attempts[0]!.database_now = null } },
    { name: 'used hash', change: snapshot => { snapshot.paymentUses.push({ tx_hash: BOB_REPAIR_EXPECTATIONS.coffee.txHash }) } },
    { name: 'fee row', change: snapshot => { snapshot.fees.push({ tx_hash: BOB_REPAIR_EXPECTATIONS.coffee.txHash }) } },
    { name: 'name conflict', change: snapshot => { snapshot.places.push({ name: 'theblueai', owner_id: 99 }) } },
    { name: 'root missing', change: snapshot => { snapshot.worldRoots = [] } },
    { name: 'root ambiguous', change: snapshot => { snapshot.worldRoots.push({ ...snapshot.worldRoots[0]!, id: 2 }) } },
    { name: 'credit pre-exists', change: snapshot => { snapshot.credits.push({ source_key: BOB_REPAIR_CREDIT_SOURCE_KEY }) } },
  ]

  for (const candidate of cases) {
    const snapshot = cloneSnapshot(initialSnapshot())
    candidate.change(snapshot)
    assert.throws(
      () => buildBobPaymentRepairPlan(snapshot, transfers()),
      BobPaymentRepairAbortError,
      candidate.name,
    )
  }
})

test('every changed or uncertain Base classification aborts', () => {
  const cases: readonly Readonly<{
    name: string
    evidence: BobTransferEvidence
  }>[] = [
    { name: 'pending', evidence: { state: 'pending' } },
    { name: 'failed', evidence: { state: 'invalid_final', reason: 'failed_transaction' } },
    { name: 'mismatched', evidence: { state: 'invalid_final', reason: 'confirmed_mismatch' } },
    { name: 'payer', evidence: { ...matchedTransfer('coffee'), from: `0x${'11'.repeat(20)}` } },
    { name: 'recipient', evidence: { ...matchedTransfer('coffee'), to: `0x${'22'.repeat(20)}` } },
    { name: 'amount', evidence: { ...matchedTransfer('coffee'), amount: 999_999n } },
    { name: 'canonical block', evidence: { ...matchedTransfer('coffee'), blockNumber: 1n } },
    { name: 'canonical block hash', evidence: { ...matchedTransfer('coffee'), blockHash: `0x${'33'.repeat(32)}` } },
    { name: 'block time', evidence: { ...matchedTransfer('coffee'), blockTime: new Date('2026-08-22T07:55:44Z') } },
    { name: 'invalid finality time', evidence: { ...matchedTransfer('coffee'), finalizedAt: new Date('invalid') } },
  ]

  for (const candidate of cases) {
    const changed = { ...transfers(), [BOB_REPAIR_EXPECTATIONS.coffee.txHash]: candidate.evidence }
    assert.throws(
      () => buildBobPaymentRepairPlan(initialSnapshot(), changed),
      BobPaymentRepairAbortError,
      candidate.name,
    )
  }
})

test('the exact eventual result is a safe retry no-op', () => {
  const plan = buildBobPaymentRepairPlan(finalSnapshot(), transfers())

  assert.equal(plan.state, 'no_work')
  assert.deepEqual(plan.actions, [])
})

test('partial, duplicated, or changed completion never becomes a retry no-op', () => {
  const cases = [
    (snapshot: Mutable<BobRepairSnapshot>) => { snapshot.fees = [] },
    (snapshot: Mutable<BobRepairSnapshot>) => { snapshot.paymentUses.push({ ...snapshot.paymentUses[0]! }) },
    (snapshot: Mutable<BobRepairSnapshot>) => { snapshot.places[0]!.name = 'Theblueai' },
    (snapshot: Mutable<BobRepairSnapshot>) => { snapshot.credits[0]!.amount_units = '2000000' },
    (snapshot: Mutable<BobRepairSnapshot>) => { snapshot.attempts[0]!.invalid_reason = 'changed' },
  ]

  for (const change of cases) {
    const snapshot = cloneSnapshot(finalSnapshot())
    change(snapshot)
    assert.throws(
      () => buildBobPaymentRepairPlan(snapshot, transfers()),
      BobPaymentRepairAbortError,
    )
  }
})

test('apply mode requires the one exact Wave 15 acknowledgement', () => {
  assert.throws(
    () => parseBobPaymentRepairArgs(['--target', 'production', '--database', 'city', '--apply']),
    /acknowledgement/iu,
  )
  assert.throws(
    () => parseBobPaymentRepairArgs([
      '--target', 'production', '--database', 'city', '--apply', '--ack', 'close-enough',
    ]),
    /acknowledgement/iu,
  )
  assert.equal(parseBobPaymentRepairArgs([
    '--target', 'production', '--database', 'city', '--apply', '--ack',
    BOB_REPAIR_APPLY_ACKNOWLEDGEMENT,
  ]).mode, 'apply')
})

test('argument parsing rejects every ambiguous command shape', () => {
  const invalid = [
    [],
    ['--target', 'preview', '--database', 'city'],
    ['--target', 'production'],
    ['--database', 'city'],
    ['--target', 'production', '--database'],
    ['--target', 'production', '--database', 'city', '--ack', BOB_REPAIR_APPLY_ACKNOWLEDGEMENT],
    ['--target', 'production', '--target', 'production', '--database', 'city'],
    ['--target', 'production', '--database', 'city', '--unknown'],
  ] as const

  for (const args of invalid) assert.throws(() => parseBobPaymentRepairArgs(args))
  assert.equal(
    parseBobPaymentRepairArgs(['--target', 'production', '--database', 'city']).mode,
    'dry-run',
  )
})

test('operator errors redact database URLs and authorization material', () => {
  const sanitized = safeBobPaymentRepairError(new Error(
    'postgresql://operator@example.test/city authorization=Bearer.secret Bearer token-value',
  ))
  assert.doesNotMatch(sanitized, /operator@|Bearer\.secret|token-value/iu)
  assert.match(sanitized, /redacted/iu)
})

class FakeClient {
  readonly calls: readonly unknown[][] = []
  connected = false
  ended = false
  snapshot: BobRepairSnapshot
  readonly failureMarker: string | null
  readonly onSerializableBegin: (() => void) | null

  constructor(
    snapshot: BobRepairSnapshot,
    failureMarker: string | null = null,
    onSerializableBegin: (() => void) | null = null,
  ) {
    this.snapshot = snapshot
    this.failureMarker = failureMarker
    this.onSerializableBegin = onSerializableBegin
  }

  async connect() {
    this.connected = true
  }

  async end() {
    this.ended = true
  }

  async query(text: string, params: readonly unknown[] = []) {
    ;(this.calls as unknown[][]).push([text, [...params]])
    if (text.includes('ISOLATION LEVEL SERIALIZABLE')) this.onSerializableBegin?.()
    const marker = /\/\*\s*bob-payment-repair:([a-z-]+)\s*\*\//u.exec(text)?.[1]
    if (marker === this.failureMarker) throw new Error('injected read failure')
    if (text.includes('bob-payment-repair-apply:create-place')) return { rows: [{ id: 901 }] }
    if (text.includes('bob-payment-repair-apply:payment-use')) {
      return { rows: [{ tx_hash: BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash }] }
    }
    if (text.includes('bob-payment-repair-apply:fee')) return { rows: [{ id: 811 }] }
    if (text.includes('bob-payment-repair-apply:complete-attempt')) {
      return { rows: [{ public_id: BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId }] }
    }
    if (text.includes('bob-payment-repair-apply:close-coffee')) {
      return { rows: [{ public_id: BOB_REPAIR_EXPECTATIONS.coffee.attemptId }] }
    }
    if (text.includes('city-credit:issue-balance')) {
      this.snapshot = finalSnapshot()
      return { rows: [{ balance_units: '1000000' }] }
    }
    if (text.includes('city-credit:issue')) {
      return { rows: [{
        id: '71', entry_kind: 'founder_issue', resident_id: 68, founder_id: 1,
        amount_units: '1000000', source_key: BOB_REPAIR_CREDIT_SOURCE_KEY,
        reason: BOB_REPAIR_CREDIT_REASON, created: true,
        created_at: '2026-08-23T12:00:00.000Z',
      }] }
    }
    if (!marker) return { rows: [] }
    const rowsByMarker: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
      residents: this.snapshot.residents,
      attempts: this.snapshot.attempts,
      'payment-uses': this.snapshot.paymentUses,
      fees: this.snapshot.fees,
      'world-roots': this.snapshot.worldRoots,
      places: this.snapshot.places,
      credits: this.snapshot.credits,
    }
    return { rows: rowsByMarker[marker] ?? [] }
  }
}

const TEST_ENVIRONMENT = Object.freeze({
  PRODUCTION_DATABASE_URL_UNPOOLED: 'postgresql://operator@ep-city.example.test/city?sslmode=require',
  NEON_PROJECT_ID: 'project-city',
  NEON_PRODUCTION_BRANCH_ID: 'branch-production',
  NEON_API_KEY: 'x',
})

const VERIFY_FETCH: typeof fetch = async () => new Response(JSON.stringify({
  endpoints: [{
    id: 'endpoint-city',
    host: 'ep-city.example.test',
    project_id: 'project-city',
    branch_id: 'branch-production',
    type: 'read_write',
  }],
}), { status: 200, headers: { 'content-type': 'application/json' } })

function testClassify(txHash: string): Promise<BobTransferEvidence> {
  const evidence = transfers()[txHash]
  assert.ok(evidence)
  return Promise.resolve(evidence)
}

test('default command uses a repeatable-read read-only transaction and performs zero writes', async () => {
  const client = new FakeClient(initialSnapshot())
  const output: string[] = []
  const classifications: Array<Readonly<Record<string, unknown>>> = []

  const result = await runBobPaymentRepair({
    argv: ['--target', 'production', '--database', 'city'],
    environment: TEST_ENVIRONMENT,
    fetcher: VERIFY_FETCH,
    createClient: () => client,
    classify: async (txHash, to, minimum, options) => {
      classifications.push({ txHash, to, minimum, ...options })
      return testClassify(txHash)
    },
    log: line => output.push(line),
  })

  assert.equal(result.state, 'work_required')
  assert.equal(client.connected, true)
  assert.equal(client.ended, true)
  const statements = client.calls.map(call => String(call[0]))
  assert.ok(statements.includes('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'))
  assert.ok(statements.includes('COMMIT'))
  assert.doesNotMatch(
    statements.join('\n'),
    /\b(?:INSERT|UPDATE|DELETE|MERGE|CALL|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/iu,
  )
  assert.doesNotMatch(statements.join('\n'), /response_json|payment_response|response_body/iu)
  assert.equal(classifications.length, 2)
  for (const call of classifications) {
    assert.equal(call.to, BOB_REPAIR_EXPECTATIONS.recipient)
    assert.equal(call.minimum, 1_000_000n)
    assert.equal(call.expectedFrom, BOB_REPAIR_EXPECTATIONS.payer)
    assert.equal(call.exactAmount, true)
  }
  assert.equal(output.length, 1)
  assert.doesNotMatch(output[0]!, /postgres(?:ql)?:|NEON_API_KEY|authorization|x-payment/iu)
})

test('production target guards fail before any database connection', async () => {
  const environments = [
    { ...TEST_ENVIRONMENT, PRODUCTION_DATABASE_URL_UNPOOLED: 'postgresql://operator@ep-city.example.test/other?sslmode=require' },
    { ...TEST_ENVIRONMENT, PRODUCTION_DATABASE_URL_UNPOOLED: 'postgresql://operator@ep-city.example.test/city' },
    { ...TEST_ENVIRONMENT, PRODUCTION_DATABASE_URL_UNPOOLED: 'postgresql://operator@ep-city.example.test:6543/city?sslmode=require' },
    { ...TEST_ENVIRONMENT, NEON_API_KEY: '' },
  ]

  for (const environment of environments) {
    let clients = 0
    await assert.rejects(runBobPaymentRepair({
      argv: ['--target', 'production', '--database', 'city'],
      environment,
      fetcher: VERIFY_FETCH,
      createClient: () => {
        clients += 1
        return new FakeClient(initialSnapshot())
      },
      classify: testClassify,
      log: () => {},
    }))
    assert.equal(clients, 0)
  }
})

test('a dry-run read failure rolls back and closes the connection', async () => {
  const client = new FakeClient(initialSnapshot(), 'places')

  await assert.rejects(runBobPaymentRepair({
    argv: ['--target', 'production', '--database', 'city'],
    environment: TEST_ENVIRONMENT,
    fetcher: VERIFY_FETCH,
    createClient: () => client,
    classify: testClassify,
    log: () => {},
  }), /injected read failure/iu)

  const statements = client.calls.map(call => String(call[0]))
  assert.ok(statements.includes('ROLLBACK'))
  assert.equal(client.ended, true)
})

test('apply revalidates inside one serializable transaction and calls only the three narrow operations', async () => {
  const client = new FakeClient(initialSnapshot())
  const operationCalls: string[] = []
  const operations: BobPaymentRepairApplyOperations = {
    async completeTheBlueAI(_database, action) {
      operationCalls.push(`${action.kind}:${action.attempt_id}`)
    },
    async closeCoffeeProbe(_database, action) {
      operationCalls.push(`${action.kind}:${action.attempt_id}`)
    },
    async issueFounderCredit(_database, action) {
      operationCalls.push(`${action.kind}:${action.attempt_id}`)
      client.snapshot = finalSnapshot()
    },
  }

  const result = await runBobPaymentRepair({
    argv: [
      '--target', 'production', '--database', 'city', '--apply', '--ack',
      BOB_REPAIR_APPLY_ACKNOWLEDGEMENT,
    ],
    environment: TEST_ENVIRONMENT,
    fetcher: VERIFY_FETCH,
    createClient: () => client,
    classify: testClassify,
    applyOperations: operations,
    log: () => {},
  })

  assert.equal(result.state, 'no_work')
  assert.deepEqual(operationCalls, [
    `complete_theblueai:${BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId}`,
    `close_coffee_probe:${BOB_REPAIR_EXPECTATIONS.coffee.attemptId}`,
    `issue_founder_credit:${BOB_REPAIR_EXPECTATIONS.coffee.attemptId}`,
  ])
  const statements = client.calls.map(call => String(call[0]))
  assert.equal(statements.filter(statement => statement.includes('REPEATABLE READ READ ONLY')).length, 1)
  assert.equal(statements.filter(statement => statement.includes('ISOLATION LEVEL SERIALIZABLE')).length, 1)
  assert.equal(statements.filter(statement => statement === 'COMMIT').length, 2)
})

test('apply aborts and rolls back before hooks when a fact changes after the dry run', async () => {
  let client: FakeClient
  client = new FakeClient(initialSnapshot(), null, () => {
    const changed = cloneSnapshot(initialSnapshot())
    changed.attempts[0]!.updated_at = '2026-08-22T08:00:00.000Z'
    client.snapshot = changed
  })
  const calls: string[] = []
  const operations: BobPaymentRepairApplyOperations = {
    async completeTheBlueAI() { calls.push('complete') },
    async closeCoffeeProbe() { calls.push('close') },
    async issueFounderCredit() { calls.push('credit') },
  }

  await assert.rejects(runBobPaymentRepair({
    argv: [
      '--target', 'production', '--database', 'city', '--apply', '--ack',
      BOB_REPAIR_APPLY_ACKNOWLEDGEMENT,
    ],
    environment: TEST_ENVIRONMENT,
    fetcher: VERIFY_FETCH,
    createClient: () => client,
    classify: testClassify,
    applyOperations: operations,
    log: () => {},
  }), /aborted|changed/iu)

  assert.deepEqual(calls, [])
  assert.ok(client.calls.map(call => String(call[0])).includes('ROLLBACK'))
})

test('an apply operation failure rolls back and prevents later effects', async () => {
  const client = new FakeClient(initialSnapshot())
  const calls: string[] = []
  const operations: BobPaymentRepairApplyOperations = {
    async completeTheBlueAI() {
      calls.push('complete')
      throw new Error('injected operator failure')
    },
    async closeCoffeeProbe() { calls.push('close') },
    async issueFounderCredit() { calls.push('credit') },
  }

  await assert.rejects(runBobPaymentRepair({
    argv: [
      '--target', 'production', '--database', 'city', '--apply', '--ack',
      BOB_REPAIR_APPLY_ACKNOWLEDGEMENT,
    ],
    environment: TEST_ENVIRONMENT,
    fetcher: VERIFY_FETCH,
    createClient: () => client,
    classify: testClassify,
    applyOperations: operations,
    log: () => {},
  }), /injected operator failure/iu)

  assert.deepEqual(calls, ['complete'])
  assert.ok(client.calls.map(call => String(call[0])).includes('ROLLBACK'))
})

test('a partial apply result fails the exact post-check and rolls back', async () => {
  const client = new FakeClient(initialSnapshot())
  const operations: BobPaymentRepairApplyOperations = {
    async completeTheBlueAI() {},
    async closeCoffeeProbe() {},
    async issueFounderCredit() {},
  }

  await assert.rejects(runBobPaymentRepair({
    argv: [
      '--target', 'production', '--database', 'city', '--apply', '--ack',
      BOB_REPAIR_APPLY_ACKNOWLEDGEMENT,
    ],
    environment: TEST_ENVIRONMENT,
    fetcher: VERIFY_FETCH,
    createClient: () => client,
    classify: testClassify,
    applyOperations: operations,
    log: () => {},
  }), /did not produce|aborted/iu)

  assert.ok(client.calls.map(call => String(call[0])).includes('ROLLBACK'))
  assert.equal(client.calls.map(call => String(call[0])).filter(statement => statement === 'COMMIT').length, 1)
})

test('apply without an injected hookup uses the installed guarded operations', async () => {
  const client = new FakeClient(initialSnapshot())

  const result = await runBobPaymentRepair({
    argv: [
      '--target', 'production', '--database', 'city', '--apply', '--ack',
      BOB_REPAIR_APPLY_ACKNOWLEDGEMENT,
    ],
    environment: TEST_ENVIRONMENT,
    fetcher: VERIFY_FETCH,
    createClient: () => client,
    classify: testClassify,
    log: () => {},
  })

  assert.equal(result.state, 'no_work')
  const statements = client.calls.map(call => String(call[0]))
  assert.match(statements.join('\n'), /ISOLATION LEVEL SERIALIZABLE/iu)
  assert.match(statements.join('\n'), /bob-payment-repair-apply:complete-attempt/iu)
  assert.match(statements.join('\n'), /bob-payment-repair-apply:close-coffee/iu)
  assert.match(statements.join('\n'), /city-credit:issue/iu)
})

test('re-running apply after exact completion is a read-only no-op', async () => {
  const client = new FakeClient(finalSnapshot())
  const operations: BobPaymentRepairApplyOperations = {
    async completeTheBlueAI() { assert.fail('no-op retry must not complete a second place') },
    async closeCoffeeProbe() { assert.fail('no-op retry must not close the attempt twice') },
    async issueFounderCredit() { assert.fail('no-op retry must not issue a second credit') },
  }

  const result = await runBobPaymentRepair({
    argv: [
      '--target', 'production', '--database', 'city', '--apply', '--ack',
      BOB_REPAIR_APPLY_ACKNOWLEDGEMENT,
    ],
    environment: TEST_ENVIRONMENT,
    fetcher: VERIFY_FETCH,
    createClient: () => client,
    classify: testClassify,
    applyOperations: operations,
    log: () => {},
  })

  assert.equal(result.state, 'no_work')
  assert.doesNotMatch(
    client.calls.map(call => String(call[0])).join('\n'),
    /ISOLATION LEVEL SERIALIZABLE/iu,
  )
})
