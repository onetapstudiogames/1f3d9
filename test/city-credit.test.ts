import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalPaymentRequest } from '../src/payment-attempts.ts'
import {
  CITY_FEE_CREDIT_UNITS,
  beginCityCreditSpend,
  formatUsdcUnits,
  issueCityFeeCredit,
  parseCityCreditRequestId,
  readCityCreditAccount,
  returnCityCreditSpend,
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
    return reply
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
    'return-spend': [[returned], [{ ...returned, prior_return_id: '202' }]],
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
