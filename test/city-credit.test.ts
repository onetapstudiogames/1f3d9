import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalPaymentRequest } from '../src/payment-attempts.ts'
import {
  CITY_FEE_CREDIT_UNITS,
  beginCityCreditSpend,
  cityCreditAttentionLines,
  formatUsdcUnits,
  issueCityFeeCredit,
  parseCityCreditRequestId,
  readCityCreditAccount,
  readCityCreditAttention,
  readCityCreditPreflight,
  returnCityCreditSpend,
  returnExpiredCityCreditSpend,
} from '../src/city-credit.ts'

type QueryRow = Readonly<Record<string, unknown>>
type QueryReply = readonly QueryRow[] | Error

type QueryCall = Readonly<{
  marker: string
  text: string
  params: readonly unknown[]
}>

/**
 * Keeps these service tests independent of SQL layout while still requiring
 * every private credit statement to identify its purpose for audit/debugging.
 */
class MarkerDatabase {
  readonly calls: QueryCall[] = []
  readonly #replies: Map<string, QueryReply[]>

  constructor(replies: Readonly<Record<string, readonly QueryReply[]>>) {
    this.#replies = new Map(Object.entries(replies).map(([marker, values]) => [
      marker,
      [...values],
    ]))
  }

  async query(text: string, params: readonly unknown[] = []): Promise<readonly QueryRow[]> {
    const marker = /\/\*\s*city-credit:([a-z-]+)\s*\*\//u.exec(text)?.[1]
    assert.ok(marker, 'city-credit SQL must carry a city-credit:* comment marker')
    this.calls.push({ marker, text, params: [...params] })

    const reply = this.#replies.get(marker)?.shift()
    assert.ok(reply, `unexpected or unanswered city-credit:${marker} query`)
    if (reply instanceof Error) throw reply
    return reply.map(row => row.lease_owner === '__bound_lease__'
      ? { ...row, lease_owner: params[2] }
      : row)
  }
}

const REQUEST_ID = 'frontier-request-0001'
const SOURCE_KEY = 'founder-extra-payment-0001'
const ATTEMPT_ID = 'credit_attempt_0001'
const LEASE_OWNER = 'credit_lease_0001'
const CREATED_AT = '2026-08-22T12:00:00.000Z'
const REQUEST = Object.freeze({
  name: 'TheBlueAI',
  kind: 'continent',
  nested: Object.freeze({ b: 2, a: 1 }),
})
const CANONICAL_REQUEST = canonicalPaymentRequest(REQUEST)

test('preflight shows exact cost, pending-or-frozen gift count, and before/after balance without a debit', async () => {
  const database = new MarkerDatabase({
    preflight: [[{
      balance_units: '3000000',
      pending_gifts_count: '2',
      observed_at: '2026-08-26T23:30:00.000Z',
    }]],
  })
  const result = await readCityCreditPreflight(database, 7)
  assert.deepEqual(result, {
    resident_id: 7,
    fee_cost: '1.000000',
    fee_cost_units: '1000000',
    balance_before: '3.000000',
    balance_before_units: '3000000',
    balance_after: '2.000000',
    balance_after_units: '2000000',
    pending_gifts_count: 2,
    can_confirm: true,
    observed_at: '2026-08-26T23:30:00.000Z',
    applies_to: [
      'frontier', 'kind_invention', 'kind_revision',
      'place_rename', 'place_retire', 'place_restore',
    ],
    freshness: 'read_only_snapshot',
  })
  assert.equal(database.calls.length, 1)
  assert.match(database.calls[0]!.text, /gift\.status IN \('pending', 'frozen'\)/iu)
  assert.doesNotMatch(database.calls[0]!.text, /\b(?:INSERT|UPDATE|DELETE)\b/iu)
})

test('a me read advances one private marker and reports only balance-changing credit entries', async () => {
  const database = new MarkerDatabase({
    'read-attention': [[{
      had_previous_read: true,
      change_units: '2000000',
      changed_at: '2026-09-01T14:30:00.000Z',
      pending_count: 1,
      frozen_count: 0,
    }]],
  })

  assert.deepEqual(await readCityCreditAttention(database, 7), {
    pending_gifts_count: 1,
    frozen_gifts_count: 0,
    credit_change: {
      amount: '2.000000',
      amount_units: '2000000',
      changed_at: '2026-09-01T14:30:00.000Z',
    },
  })
  assert.equal(database.calls.length, 1)
  assert.match(database.calls[0]!.text, /city_credit_last_me_reads/iu)
  assert.match(database.calls[0]!.text, /ON CONFLICT \(resident_id\) DO UPDATE/iu)
  assert.match(database.calls[0]!.text, /previous_credit_entry_id/iu)
  assert.match(database.calls[0]!.text, /gift_accept/iu)
  assert.match(database.calls[0]!.text, /gift\.status IN \('pending', 'frozen'\)/iu)
})

test('attention distinguishes ordinary gifts from dispute-frozen refusal-only gifts', () => {
  assert.deepEqual(cityCreditAttentionLines({
    pending_gifts_count: 3,
    frozen_gifts_count: 1,
    credit_change: null,
  }), [
    'You have 2 pending 1F3D9 fee-credit gifts awaiting accept or refuse; see city_fee_credit.pending_gifts.',
    'You have 1 dispute-frozen 1F3D9 fee-credit gift awaiting refuse; see city_fee_credit.pending_gifts.',
  ])
})

test('the first me read establishes a baseline without inventing an old credit change', async () => {
  const database = new MarkerDatabase({
    'read-attention': [[{
      had_previous_read: false,
      change_units: null,
      changed_at: null,
      pending_count: 0,
      frozen_count: 0,
    }]],
  })

  assert.deepEqual(await readCityCreditAttention(database, 7), {
    pending_gifts_count: 0,
    frozen_gifts_count: 0,
    credit_change: null,
  })
})

function issueRow(overrides: QueryRow = {}): QueryRow {
  return {
    created: true,
    entry_id: '101',
    entry_kind: 'founder_issue',
    resident_id: 7,
    founder_id: 1,
    amount_units: CITY_FEE_CREDIT_UNITS.toString(),
    source_key: SOURCE_KEY,
    reason: 'extra finalized city payment',
    created_at: CREATED_AT,
    balance_units: CITY_FEE_CREDIT_UNITS.toString(),
    ...overrides,
  }
}

function spendRow(overrides: QueryRow = {}): QueryRow {
  return {
    state: 'ready',
    attempt_id: ATTEMPT_ID,
    actor_id: 7,
    operation: 'frontier',
    target_key: 'frontier:TheBlueAI',
    request_id: REQUEST_ID,
    request_hash: CANONICAL_REQUEST.hash,
    request_json: CANONICAL_REQUEST.json,
    amount_units: CITY_FEE_CREDIT_UNITS.toString(),
    spend_entry_id: '201',
    return_entry_id: null,
    response_status: null,
    response_json: null,
    lease_acquired: true,
    lease_owner: LEASE_OWNER,
    ...overrides,
  }
}

function spendInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    actorId: 7,
    operation: 'frontier' as const,
    targetKey: 'frontier:TheBlueAI',
    request: REQUEST,
    requestId: REQUEST_ID,
    ...overrides,
  }
}

function expiredClaimRow(overrides: QueryRow = {}): QueryRow {
  return {
    state: 'ready',
    attempt_id: ATTEMPT_ID,
    actor_id: 7,
    status: 'payment_pending',
    lease_owner: '__bound_lease__',
    recovery_deadline_at: '2026-08-22T14:00:00.000Z',
    ...overrides,
  }
}

test('one city fee is exactly one million integer USDC units', () => {
  assert.equal(CITY_FEE_CREDIT_UNITS, 1_000_000n)
})

test('USDC formatting is exact at six decimals without Number conversion', () => {
  assert.equal(formatUsdcUnits(0n), '0.000000')
  assert.equal(formatUsdcUnits(1n), '0.000001')
  assert.equal(formatUsdcUnits(999_999n), '0.999999')
  assert.equal(formatUsdcUnits(1_000_000n), '1.000000')
  assert.equal(formatUsdcUnits(-1n), '-0.000001')
  assert.equal(
    formatUsdcUnits(123_456_789_012_345_678_901_234n),
    '123456789012345678.901234',
  )
  assert.throws(
    () => formatUsdcUnits(Number.MAX_SAFE_INTEGER as unknown as bigint),
    /bigint|integer units/iu,
  )
})

test('credit request IDs allow omission or one bounded non-secret ASCII identifier', () => {
  assert.equal(parseCityCreditRequestId(null), null)
  assert.equal(parseCityCreditRequestId(undefined), null)
  assert.equal(parseCityCreditRequestId('credit-1'), 'credit-1')
  assert.equal(parseCityCreditRequestId('fee_frontier:request.20260822'), 'fee_frontier:request.20260822')
  assert.equal(parseCityCreditRequestId('a'.repeat(128)), 'a'.repeat(128))

  for (const value of [
    '',
    '1234567',
    'a'.repeat(129),
    ' leading-space',
    'trailing-space ',
    'line\nbreak',
    'unicode-é',
    'emoji-🔑',
    `request-1f3d9_sk_${'ab'.repeat(24)}`,
    `request-1f3d9_at_${'cd'.repeat(32)}`,
    12345678,
    {},
  ]) {
    assert.throws(
      () => parseCityCreditRequestId(value),
      /credit request id/iu,
      JSON.stringify(value),
    )
  }
})

test('only founder resident 1 can issue the fixed fee unit', async () => {
  for (const founderId of [0, 2, 7]) {
    const database = new MarkerDatabase({})
    await assert.rejects(
      issueCityFeeCredit(database, {
        founderId,
        residentId: 7,
        sourceKey: SOURCE_KEY,
        reason: 'extra finalized city payment',
      }),
      /founder/iu,
    )
    assert.equal(database.calls.length, 0)
  }

  const database = new MarkerDatabase({
    issue: [[issueRow()]],
    'issue-balance': [[{ balance_units: CITY_FEE_CREDIT_UNITS.toString() }]],
  })
  const issued = await issueCityFeeCredit(database, {
    founderId: 1,
    residentId: 7,
    sourceKey: SOURCE_KEY,
    reason: 'extra finalized city payment',
  })

  assert.equal(issued.disposition, 'created')
  assert.equal(issued.amount, '1.000000')
  assert.equal(issued.amount_units, '1000000')
  assert.equal(database.calls[0]?.marker, 'issue')
  assert.ok(database.calls[0]?.params.includes('1000000'))
  assert.ok(database.calls[0]?.params.includes(SOURCE_KEY))
  assert.doesNotMatch(JSON.stringify(issued), /token|crypto|redeem|cash/iu)
})

test('founder issuance replays one source key and conflicts on changed terms', async () => {
  const existing = issueRow({ created: false })
  const database = new MarkerDatabase({
    issue: [[issueRow()], [existing], [existing], [existing]],
    'issue-balance': [
      [{ balance_units: CITY_FEE_CREDIT_UNITS.toString() }],
      [{ balance_units: CITY_FEE_CREDIT_UNITS.toString() }],
    ],
  })
  const original = {
    founderId: 1,
    residentId: 7,
    sourceKey: SOURCE_KEY,
    reason: 'extra finalized city payment',
  }

  assert.equal((await issueCityFeeCredit(database, original)).disposition, 'created')
  assert.equal((await issueCityFeeCredit(database, original)).disposition, 'existing')
  await assert.rejects(
    issueCityFeeCredit(database, { ...original, residentId: 8 }),
    /conflict|changed/iu,
  )
  await assert.rejects(
    issueCityFeeCredit(database, { ...original, reason: 'different accounting reason' }),
    /conflict|changed/iu,
  )
  assert.equal(database.calls.length, 6)
})

test('founder issuance reads a concurrent source winner from a fresh snapshot', async () => {
  const database = new MarkerDatabase({
    issue: [[]],
    'issue-replay': [[issueRow({ created: false })]],
    'issue-balance': [[{ balance_units: CITY_FEE_CREDIT_UNITS.toString() }]],
  })

  const issued = await issueCityFeeCredit(database, {
    founderId: 1,
    residentId: 7,
    sourceKey: SOURCE_KEY,
    reason: 'extra finalized city payment',
  })

  assert.equal(issued.disposition, 'existing')
  assert.deepEqual(database.calls.map(call => call.marker), [
    'issue',
    'issue-replay',
    'issue-balance',
  ])
})

test('begin spend binds actor, eligible operation, target, canonical request, request ID, and fixed amount', async () => {
  const database = new MarkerDatabase({ 'begin-spend': [[spendRow()]] })
  const result = await beginCityCreditSpend(database, spendInput())

  assert.deepEqual(result, {
    state: 'ready',
    attempt_id: ATTEMPT_ID,
    spend_entry_id: '201',
    lease_owner: LEASE_OWNER,
    amount: '1.000000',
    amount_units: '1000000',
  })
  const call = database.calls[0]
  assert.equal(call?.marker, 'begin-spend')
  assert.match(
    call?.text ?? '',
    /recovery_clock\s+AS\s+MATERIALIZED\s*\([\s\S]*clock_timestamp\(\)\s+AS\s+checked_at/iu,
  )
  assert.match(
    call?.text ?? '',
    /recovery_deadline_at\s*>\s*\(SELECT\s+checked_at\s+FROM\s+recovery_clock\)/iu,
  )
  assert.match(
    call?.text ?? '',
    /recovery_deadline_at\s*<=\s*\(SELECT\s+checked_at\s+FROM\s+recovery_clock\)/iu,
  )
  for (const boundValue of [
    7,
    'frontier',
    'frontier:TheBlueAI',
    REQUEST_ID,
    CANONICAL_REQUEST.hash,
    CANONICAL_REQUEST.json,
    '1000000',
  ]) {
    assert.ok(call?.params.includes(boundValue), `missing bound value ${String(boundValue)}`)
  }
})

test('kind revision credit binds the immutable kind asset to its spend attempt', async () => {
  const revisionRequest = { kind_id: 3, description: 'revised with credit' }
  const canonicalRevision = canonicalPaymentRequest(revisionRequest)
  const database = new MarkerDatabase({
    'begin-spend': [[spendRow({
      operation: 'kind_revision',
      target_key: 'kind-revision:3:2',
      request_id: 'kind-revision-request-0001',
      request_hash: canonicalRevision.hash,
      request_json: canonicalRevision.json,
      asset_type: 'kind',
      asset_id: 3,
    })]],
  })

  await beginCityCreditSpend(database, spendInput({
    operation: 'kind_revision',
    targetKey: 'kind-revision:3:2',
    request: revisionRequest,
    requestId: 'kind-revision-request-0001',
    assetType: 'kind',
    assetId: 3,
  }))

  const call = database.calls[0]
  assert.match(call?.text ?? '', /asset_type[\s\S]*asset_id/iu)
  assert.ok(call?.params.includes('kind'))
  assert.ok(call?.params.includes(3))

  const changedAsset = new MarkerDatabase({
    'begin-spend': [[spendRow({
      operation: 'kind_revision',
      target_key: 'kind-revision:3:2',
      request_id: 'kind-revision-request-0001',
      request_hash: canonicalRevision.hash,
      request_json: canonicalRevision.json,
      asset_type: 'kind',
      asset_id: 4,
    })]],
  })
  await assert.rejects(
    beginCityCreditSpend(changedAsset, spendInput({
      operation: 'kind_revision',
      targetKey: 'kind-revision:3:2',
      request: revisionRequest,
      requestId: 'kind-revision-request-0001',
      assetType: 'kind',
      assetId: 3,
    })),
    /conflict|changed|credit terms/iu,
  )
})

test('begin spend fails closed when durable terms do not match the caller request', async () => {
  const mismatches: readonly QueryRow[] = [
    { actor_id: 8 },
    { operation: 'kind_invention' },
    { target_key: 'frontier:DifferentName' },
    { request_id: 'different-request-0001' },
    { request_hash: 'f'.repeat(64) },
    { request_json: '{"name":"DifferentName"}' },
    { amount_units: '2000000' },
  ]

  for (const mismatch of mismatches) {
    const database = new MarkerDatabase({
      'begin-spend': [[spendRow(mismatch)]],
    })
    await assert.rejects(
      beginCityCreditSpend(database, spendInput()),
      /conflict|changed|credit terms/iu,
      JSON.stringify(mismatch),
    )
  }
})

test('spend rejects unsupported operations, malformed request IDs, and insufficient balance without fallback', async () => {
  const noDatabase = new MarkerDatabase({})
  await assert.rejects(
    beginCityCreditSpend(noDatabase, spendInput({ operation: 'direct_sale' })),
    /eligible|operation|city fee/iu,
  )
  await assert.rejects(
    beginCityCreditSpend(noDatabase, spendInput({ requestId: 'short' })),
    /credit request id/iu,
  )
  await assert.rejects(
    beginCityCreditSpend(noDatabase, spendInput({
      operation: 'kind_revision',
      targetKey: 'kind-revision:3:2',
      assetType: null,
      assetId: null,
    })),
    /kind asset id/iu,
  )
  await assert.rejects(
    beginCityCreditSpend(noDatabase, spendInput({ assetType: 'kind', assetId: 3 })),
    /cannot bind an asset/iu,
  )
  assert.equal(noDatabase.calls.length, 0)

  const insufficient = Object.assign(new Error('insufficient city fee credit'), { code: 'P0001' })
  const database = new MarkerDatabase({ 'begin-spend': [insufficient] })
  await assert.rejects(
    beginCityCreditSpend(database, spendInput()),
    /insufficient city fee credit/iu,
  )
  assert.equal(database.calls.length, 1)
})

test('completed, busy, and returned spend retries surface exact safe states', async () => {
  const completedResponse = Object.freeze({ ok: true, place: Object.freeze({ id: 91 }) })
  const database = new MarkerDatabase({
    'begin-spend': [
      [spendRow({
        state: 'completed',
        lease_acquired: false,
        response_status: 201,
        response_json: completedResponse,
      })],
      [spendRow({ state: 'busy', lease_acquired: false })],
      [spendRow({
        state: 'returned',
        lease_acquired: false,
        return_entry_id: '202',
        response_status: 409,
        response_json: { error: 'target became unavailable; credit returned' },
      })],
    ],
  })

  assert.deepEqual(await beginCityCreditSpend(database, spendInput()), {
    state: 'completed',
    attempt_id: ATTEMPT_ID,
    response_status: 201,
    response: completedResponse,
  })
  assert.deepEqual(await beginCityCreditSpend(database, spendInput()), {
    state: 'busy',
    attempt_id: ATTEMPT_ID,
  })
  assert.deepEqual(await beginCityCreditSpend(database, spendInput()), {
    state: 'returned',
    attempt_id: ATTEMPT_ID,
    return_entry_id: '202',
    response_status: 409,
    response: { error: 'target became unavailable; credit returned' },
  })
})

test('return uses the exact attempt debit once and identical retries replay it', async () => {
  const returned = spendRow({
    state: 'returned',
    status: 'credit_returned',
    lease_acquired: false,
    return_entry_id: '202',
    response_status: 409,
    response_json: { error: 'target became unavailable; credit returned' },
  })
  const database = new MarkerDatabase({
    'return-spend': [
      [{ ...returned, prior_status: 'payment_pending' }],
      [{ ...returned, prior_status: 'credit_returned' }],
    ],
    'return-result': [[returned], [returned]],
  })
  const input = {
    actorId: 7,
    attemptId: ATTEMPT_ID,
    leaseOwner: LEASE_OWNER,
    reason: 'target became unavailable',
    responseStatus: 409,
    response: { error: 'target became unavailable; credit returned' },
  }

  assert.deepEqual(await returnCityCreditSpend(database, input), {
    disposition: 'created',
    state: 'returned',
    attempt_id: ATTEMPT_ID,
    spend_entry_id: '201',
    return_entry_id: '202',
    amount: '1.000000',
    amount_units: '1000000',
    response_status: 409,
    response: { error: 'target became unavailable; credit returned' },
  })
  assert.equal((await returnCityCreditSpend(database, input)).disposition, 'existing')
  assert.equal(database.calls.length, 4)
  for (const call of database.calls.filter(({ marker }) => marker === 'return-spend')) {
    assert.ok(call.params.includes(7))
    assert.ok(call.params.includes(ATTEMPT_ID))
    assert.ok(call.params.includes(LEASE_OWNER))
    assert.ok(call.params.includes('1000000'))
    assert.match(call.text, /locked_attempt[\s\S]*FOR\s+UPDATE/iu)
  }
})

test('return rejects missing, cross-resident, changed, non-spend, and non-exact debits', async () => {
  const failures: readonly QueryReply[] = [
    Object.assign(new Error('matching city credit spend was not found'), { code: 'P0001' }),
    [spendRow({ status: 'credit_returned', actor_id: 8, return_entry_id: '202' })],
    [spendRow({ status: 'credit_returned', amount_units: '2000000', return_entry_id: '202' })],
    [spendRow({ status: 'completed', return_entry_id: null })],
  ]

  for (const reply of failures) {
    const database = new MarkerDatabase({ 'return-spend': [reply] })
    await assert.rejects(
      returnCityCreditSpend(database, {
        actorId: 7,
        attemptId: ATTEMPT_ID,
        leaseOwner: LEASE_OWNER,
        reason: 'target became unavailable',
        responseStatus: 409,
        response: { error: 'target became unavailable; credit returned' },
      }),
      /matching|conflict|changed|exact|return/iu,
    )
  }
})

test('deadline recovery uses the database clock and returns only the exact spent credit', async () => {
  const returned = spendRow({
    state: 'returned',
    status: 'credit_returned',
    lease_acquired: false,
    return_entry_id: '202',
    response_status: 409,
    response_json: {
      error: 'automatic recovery deadline reached; city fee credit returned',
      city_fee_credit: 'credit_returned',
      returned_usdc: '1.000000',
    },
  })
  const database = new MarkerDatabase({
    'claim-expired-spend': [[expiredClaimRow()]],
    'return-spend': [[returned]],
    'return-result': [[returned]],
  })

  const result = await returnExpiredCityCreditSpend(database, {
    actorId: 7,
    attemptId: ATTEMPT_ID,
  })

  assert.deepEqual(result, {
    disposition: 'created',
    state: 'credit_returned',
    attempt_id: ATTEMPT_ID,
    spend_entry_id: '201',
    return_entry_id: '202',
    amount: '1.000000',
    amount_units: '1000000',
    response_status: 409,
    response: {
      error: 'automatic recovery deadline reached; city fee credit returned',
      city_fee_credit: 'credit_returned',
      returned_usdc: '1.000000',
    },
  })
  const claim = database.calls[0]!
  assert.equal(claim.marker, 'claim-expired-spend')
  assert.match(claim.text, /recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu)
  assert.match(claim.text, /method\s*=\s*'credit'/iu)
  assert.match(claim.text, /status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*\)/iu)
  assert.ok(claim.params.includes(7))
  assert.ok(claim.params.includes(ATTEMPT_ID))
  assert.equal(database.calls.filter(call => call.marker === 'return-spend').length, 1)
  assert.doesNotMatch(
    database.calls.map(call => call.text).join('\n'),
    /founder_issue|admin_credit|city-credit:issue/iu,
  )
})

test('deadline recovery duplicate replays the one append-only return without issuing credit', async () => {
  const response = {
    error: 'automatic recovery deadline reached; city fee credit returned',
    city_fee_credit: 'credit_returned',
    returned_usdc: '1.000000',
  }
  const returned = spendRow({
    state: 'returned',
    status: 'credit_returned',
    lease_acquired: false,
    return_entry_id: '202',
    response_status: 409,
    response_json: response,
  })
  const database = new MarkerDatabase({
    'claim-expired-spend': [
      [expiredClaimRow()],
      [expiredClaimRow({ state: 'credit_returned', status: 'credit_returned', lease_owner: null })],
    ],
    'return-spend': [[returned]],
    'return-result': [[returned]],
    'expired-return-result': [[returned]],
  })

  const first = await returnExpiredCityCreditSpend(database, {
    actorId: 7,
    attemptId: ATTEMPT_ID,
  })
  assert.equal(first.state, 'credit_returned')
  if (first.state !== 'credit_returned') throw new Error('deadline credit return was not created')
  assert.equal(first.disposition, 'created')
  const replay = await returnExpiredCityCreditSpend(database, {
    actorId: 7,
    attemptId: ATTEMPT_ID,
  })

  assert.equal(replay.state, 'credit_returned')
  assert.equal(replay.disposition, 'existing')
  assert.equal(replay.return_entry_id, '202')
  assert.equal(database.calls.filter(call => call.marker === 'return-spend').length, 1)
  assert.equal(database.calls.filter(call => call.marker === 'expired-return-result').length, 1)
})

test('deadline recovery fails closed before the boundary, while another lease is active, or when absent', async () => {
  const database = new MarkerDatabase({
    'claim-expired-spend': [
      [expiredClaimRow({ state: 'not_due' })],
      [expiredClaimRow({ state: 'busy', lease_owner: null })],
      [],
    ],
  })

  assert.deepEqual(await returnExpiredCityCreditSpend(database, {
    actorId: 7,
    attemptId: ATTEMPT_ID,
  }), { state: 'not_due', attempt_id: ATTEMPT_ID })
  assert.deepEqual(await returnExpiredCityCreditSpend(database, {
    actorId: 7,
    attemptId: ATTEMPT_ID,
  }), { state: 'busy', attempt_id: ATTEMPT_ID })
  assert.deepEqual(await returnExpiredCityCreditSpend(database, {
    actorId: 7,
    attemptId: ATTEMPT_ID,
  }), { state: 'unavailable', attempt_id: ATTEMPT_ID })
  assert.equal(database.calls.filter(call => call.marker === 'return-spend').length, 0)
})

test('a later identical target starts only after its due credit spend is returned', async () => {
  const laterRequestId = 'frontier-request-0002'
  const laterAttemptId = 'credit_attempt_0002'
  const laterLeaseOwner = 'credit_lease_0002'
  const deadlineResponse = {
    error: 'automatic recovery deadline reached; city fee credit returned',
    city_fee_credit: 'credit_returned',
    returned_usdc: '1.000000',
  }
  const returned = spendRow({
    state: 'returned',
    status: 'credit_returned',
    lease_acquired: false,
    return_entry_id: '202',
    response_status: 409,
    response_json: deadlineResponse,
  })
  const database = new MarkerDatabase({
    'begin-spend': [
      [spendRow({ state: 'busy', lease_acquired: false, lease_owner: null, recovery_due: true })],
      [spendRow({
        attempt_id: laterAttemptId,
        request_id: laterRequestId,
        lease_owner: laterLeaseOwner,
      })],
    ],
    'claim-expired-spend': [[expiredClaimRow()]],
    'return-spend': [[returned]],
    'return-result': [[returned]],
  })

  const result = await beginCityCreditSpend(database, spendInput({ requestId: laterRequestId }))

  assert.deepEqual(result, {
    state: 'ready',
    attempt_id: laterAttemptId,
    spend_entry_id: '201',
    lease_owner: laterLeaseOwner,
    amount: '1.000000',
    amount_units: '1000000',
  })
  assert.deepEqual(database.calls.map(call => call.marker), [
    'begin-spend',
    'claim-expired-spend',
    'return-spend',
    'return-result',
    'begin-spend',
  ])
})

test('a later identical target waits when another worker owns the due credit return', async () => {
  const database = new MarkerDatabase({
    'begin-spend': [[
      spendRow({ state: 'busy', lease_acquired: false, lease_owner: null, recovery_due: true }),
    ]],
    'claim-expired-spend': [[expiredClaimRow({ state: 'busy', lease_owner: null })]],
  })

  await assert.rejects(
    beginCityCreditSpend(database, spendInput({ requestId: 'frontier-request-0002' })),
    /deadline return|retry/iu,
  )
  assert.deepEqual(database.calls.map(call => call.marker), [
    'begin-spend',
    'claim-expired-spend',
  ])
})

test('deadline recovery rejects malformed identity and lease inputs before storage', async () => {
  const database = new MarkerDatabase({})
  for (const actorId of [0, 1.5, 2_147_483_648, '7']) {
    await assert.rejects(
      returnExpiredCityCreditSpend(database, {
        actorId: actorId as number,
        attemptId: ATTEMPT_ID,
      }),
      /actor id|positive integer/iu,
    )
  }
  for (const attemptId of [
    'short',
    'credit attempt spaces',
    `credit_attempt_${'a'.repeat(150)}`,
    `1f3d9_sk_${'ab'.repeat(24)}`,
  ]) {
    await assert.rejects(
      returnExpiredCityCreditSpend(database, { actorId: 7, attemptId }),
      /attempt id|identifier/iu,
    )
  }
  for (const leaseOwner of ['short', 'credit lease spaces', `credit_lease_${'a'.repeat(150)}`]) {
    await assert.rejects(
      returnExpiredCityCreditSpend(database, {
        actorId: 7,
        attemptId: ATTEMPT_ID,
        leaseOwner,
      }),
      /lease owner|identifier/iu,
    )
  }
  assert.equal(database.calls.length, 0)
})

test('credit returns reject unsafe terms and malformed durable deadline results', async () => {
  const noDatabase = new MarkerDatabase({})
  for (const reason of [
    '',
    ' padded ',
    'line\nbreak',
    'a'.repeat(241),
    `1f3d9_sk_${'ab'.repeat(24)}`,
  ]) {
    await assert.rejects(
      returnCityCreditSpend(noDatabase, {
        actorId: 7,
        attemptId: ATTEMPT_ID,
        leaseOwner: LEASE_OWNER,
        reason,
        responseStatus: 409,
        response: { error: 'credit returned' },
      }),
      /reason|safe|secret/iu,
    )
  }
  for (const responseStatus of [399, 400.5, 600]) {
    await assert.rejects(
      returnCityCreditSpend(noDatabase, {
        actorId: 7,
        attemptId: ATTEMPT_ID,
        leaseOwner: LEASE_OWNER,
        reason: 'automatic recovery deadline reached',
        responseStatus,
        response: { error: 'credit returned' },
      }),
      /response status|error status/iu,
    )
  }

  const missingReturn = new MarkerDatabase({
    'claim-expired-spend': [[expiredClaimRow({
      state: 'credit_returned', status: 'credit_returned', lease_owner: null,
    })]],
    'expired-return-result': [[]],
  })
  await assert.rejects(
    returnExpiredCityCreditSpend(missingReturn, { actorId: 7, attemptId: ATTEMPT_ID }),
    /exact|return|unavailable/iu,
  )

  const falseLease = new MarkerDatabase({
    'claim-expired-spend': [[expiredClaimRow({ lease_owner: 'different-lease-owner' })]],
  })
  await assert.rejects(
    returnExpiredCityCreditSpend(falseLease, { actorId: 7, attemptId: ATTEMPT_ID }),
    /safely leased/iu,
  )
})

test('account reads expose exact decimal and integer strings, including signed history', async () => {
  const hugeBalance = '9007199254740993000000'
  const database = new MarkerDatabase({
    'read-account': [[{
      resident_id: 7,
      balance_units: hugeBalance,
      history: [
        {
          id: '9223372036854775805', entry_kind: 'founder_issue',
          amount_units: '1000000', source_key: SOURCE_KEY,
          request_id: null, operation: null, target_key: null,
          related_spend_id: null, reason: 'extra finalized city payment',
          created_at: CREATED_AT,
        },
        {
          id: '9223372036854775806', entry_kind: 'spend',
          amount_units: '1000000', source_key: null,
          request_id: REQUEST_ID, operation: 'frontier', target_key: 'frontier:TheBlueAI',
          related_spend_id: null, reason: null,
          created_at: '2026-08-22T12:01:00.000Z',
        },
        {
          id: '9223372036854775807', entry_kind: 'return',
          amount_units: '1000000', source_key: null,
          request_id: REQUEST_ID, operation: 'frontier', target_key: 'frontier:TheBlueAI',
          related_spend_id: '9223372036854775806', reason: 'target became unavailable',
          created_at: '2026-08-22T12:02:00.000Z',
        },
      ],
    }]],
  })

  const account = await readCityCreditAccount(database, 7)

  assert.equal(account.balance, '9007199254740993.000000')
  assert.equal(account.balance_units, hugeBalance)
  assert.deepEqual(account.history.map(entry => ({
    id: entry.id,
    kind: entry.kind,
    amount: entry.amount,
    amount_units: entry.amount_units,
  })), [
    { id: '9223372036854775805', kind: 'founder_issue', amount: '1.000000', amount_units: '1000000' },
    { id: '9223372036854775806', kind: 'spend', amount: '-1.000000', amount_units: '-1000000' },
    { id: '9223372036854775807', kind: 'return', amount: '1.000000', amount_units: '1000000' },
  ])
  assert.equal(typeof account.balance, 'string')
  assert.ok(account.history.every(entry => (
    typeof entry.id === 'string'
      && typeof entry.amount === 'string'
      && typeof entry.amount_units === 'string'
  )))
  assert.doesNotThrow(() => JSON.stringify(account))
  assert.equal(database.calls[0]?.marker, 'read-account')
  assert.deepEqual(database.calls[0]?.params, [7])
})

test('account receipts show exact purchase and gift events without exposing payment source keys', async () => {
  const giftId = `city_gift_${'ab'.repeat(16)}`
  const rows = [
    { id: '201', entry_kind: 'purchase', amount_units: '3000000', source_key: 'paypal:capture:private-001', purchase_kind: 'paypal', gift_public_id: null, operation: null },
    { id: '202', entry_kind: 'purchase', amount_units: '2000000', source_key: 'paypal:capture:private-002', purchase_kind: 'paypal', gift_public_id: giftId, operation: null },
    { id: '203', entry_kind: 'gift_pending', amount_units: '2000000', source_key: 'gift:private:pending', purchase_kind: null, gift_public_id: giftId, operation: null },
    { id: '204', entry_kind: 'gift_accept', amount_units: '2000000', source_key: 'gift:private:accept', purchase_kind: null, gift_public_id: giftId, operation: null },
    { id: '205', entry_kind: 'gift_refuse', amount_units: '2000000', source_key: 'gift:private:refuse', purchase_kind: null, gift_public_id: giftId, operation: null },
    { id: '206', entry_kind: 'gift_redirect', amount_units: '2000000', source_key: 'gift:private:redirect', purchase_kind: null, gift_public_id: giftId, operation: null },
    { id: '207', entry_kind: 'purchase', amount_units: '7000000', source_key: 'x402:credit:private-transaction', purchase_kind: 'x402', gift_public_id: null, operation: 'credit_purchase' },
  ].map(row => ({
    ...row,
    request_id: row.entry_kind === 'gift_redirect' ? 'private-buyer-alias-0001' : null,
    target_key: null,
    related_spend_id: null,
    reason: null,
    created_at: CREATED_AT,
  }))
  const database = new MarkerDatabase({
    'read-account': [[{ resident_id: 7, balance_units: '12000000', history: rows }]],
  })

  const account = await readCityCreditAccount(database, 7)

  assert.deepEqual(account.history.map(receipt => ({
    kind: receipt.kind,
    amount_units: receipt.amount_units,
    credit_amount_units: receipt.credit_amount_units,
    source_key: receipt.source_key,
    purchase_kind: receipt.purchase_kind,
    gift_id: receipt.gift_id,
    operation: receipt.operation,
  })), [
    { kind: 'purchase', amount_units: '3000000', credit_amount_units: '3000000', source_key: null, purchase_kind: 'paypal', gift_id: null, operation: null },
    { kind: 'purchase', amount_units: '0', credit_amount_units: '2000000', source_key: null, purchase_kind: 'paypal', gift_id: giftId, operation: null },
    { kind: 'gift_pending', amount_units: '0', credit_amount_units: '2000000', source_key: null, purchase_kind: null, gift_id: giftId, operation: null },
    { kind: 'gift_accept', amount_units: '2000000', credit_amount_units: '2000000', source_key: null, purchase_kind: null, gift_id: giftId, operation: null },
    { kind: 'gift_refuse', amount_units: '0', credit_amount_units: '2000000', source_key: null, purchase_kind: null, gift_id: giftId, operation: null },
    { kind: 'gift_redirect', amount_units: '0', credit_amount_units: '2000000', source_key: null, purchase_kind: null, gift_id: giftId, operation: null },
    { kind: 'purchase', amount_units: '7000000', credit_amount_units: '7000000', source_key: null, purchase_kind: 'x402', gift_id: null, operation: 'credit_purchase' },
  ])
  assert.ok(account.history.every(receipt => receipt.request_id === null))
  assert.doesNotMatch(JSON.stringify(account), /private-buyer-alias/iu)
})
