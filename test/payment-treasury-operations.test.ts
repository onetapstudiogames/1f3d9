import assert from 'node:assert/strict'
import test from 'node:test'
import {
  completeTreasuryPaymentOperation,
  TreasuryPaymentOperationConflictError,
} from '../src/payment-treasury-operations.ts'

type QueryRow = Readonly<Record<string, unknown>>

class RecordingDatabase {
  readonly calls: Array<{ text: string; params: readonly unknown[] }> = []
  readonly #rows: readonly QueryRow[]

  constructor(rows: readonly QueryRow[]) {
    this.#rows = rows
  }

  async query(text: string, params: readonly unknown[] = []): Promise<readonly QueryRow[]> {
    this.calls.push({ text, params: [...params] })
    return this.#rows
  }
}

const ATTEMPT_ID = 'pay_frontier_1234567890abcdef'
const LEASE_OWNER = 'payment-lease-1234567890abcdef'
const TX_HASH = `0x${'ab'.repeat(32)}`
const RESPONSE_HEADER = Buffer.from(JSON.stringify({ success: true, transaction: TX_HASH }))
  .toString('base64')

function completedRow(overrides: QueryRow = {}): QueryRow {
  const response = {
    place: { id: 41, name: 'TheBlueAI', owner: 'tiny-lantern' },
    fee_tx: TX_HASH,
  }
  return {
    state: 'completed',
    attempt_id: ATTEMPT_ID,
    actor_id: 7,
    operation: 'frontier',
    method: 'x402',
    response_status: 201,
    response_json: response,
    response_body: JSON.stringify(response),
    payment_response_header: RESPONSE_HEADER,
    ...overrides,
  }
}

test('treasury completion trusts one stored attempt and performs every paid write in one statement', async () => {
  const database = new RecordingDatabase([completedRow()])

  const result = await completeTreasuryPaymentOperation(database, {
    attemptId: ATTEMPT_ID,
    leaseOwner: LEASE_OWNER,
  })

  assert.equal(result.state, 'completed')
  if (result.state !== 'completed') return
  assert.equal(result.attemptId, ATTEMPT_ID)
  assert.equal(result.actorId, 7)
  assert.equal(result.operation, 'frontier')
  assert.equal(result.method, 'x402')
  assert.equal(result.status, 201)
  assert.equal(result.responseBody, JSON.stringify(result.response))
  assert.equal(result.paymentResponseHeader, RESPONSE_HEADER)

  assert.equal(database.calls.length, 1)
  const call = database.calls[0]!
  assert.deepEqual(call.params.slice(0, 2), [ATTEMPT_ID, LEASE_OWNER])
  assert.equal(call.params.some(value => value === 7 || value === TX_HASH), false)
  assert.match(call.text, /\/\*\s*payment-treasury-operations:complete\s*\*\//iu)
  assert.match(call.text, /FROM\s+payment_attempts/iu)
  assert.match(call.text, /request_json/iu)
  assert.match(call.text, /JOIN\s+residents/iu)
  assert.match(call.text, /lease_owner\s*=\s*\$2/iu)
  assert.match(
    call.text,
    /recovery_deadline_at\s+IS\s+NOT\s+NULL\s+AND\s+[^\n]*recovery_deadline_at\s*>\s*clock_timestamp\(\)/iu,
  )
  assert.match(call.text, /INSERT\s+INTO\s+payment_uses/iu)
  assert.match(call.text, /INSERT\s+INTO\s+fees/iu)
  assert.match(call.text, /INSERT\s+INTO\s+places/iu)
  assert.match(call.text, /INSERT\s+INTO\s+kinds/iu)
  assert.match(call.text, /INSERT\s+INTO\s+kind_revisions/iu)
  assert.match(call.text, /UPDATE\s+kinds/iu)
  assert.match(call.text, /complete_payment_attempt/iu)
  assert.match(call.text, /complete_city_credit_attempt/iu)
})

test('treasury completion validates exact stored request shapes for all three operations', async () => {
  const database = new RecordingDatabase([{
    state: 'target_changed',
    attempt_id: ATTEMPT_ID,
    reason: 'stored treasury request is invalid or its target changed',
  }])

  assert.deepEqual(
    await completeTreasuryPaymentOperation(database, {
      attemptId: ATTEMPT_ID,
      leaseOwner: LEASE_OWNER,
    }),
    {
      state: 'target_changed',
      attemptId: ATTEMPT_ID,
      reason: 'stored treasury request is invalid or its target changed',
    },
  )

  const query = database.calls[0]!.text
  for (const operation of ['frontier', 'kind_invention', 'kind_revision']) {
    assert.match(query, new RegExp(`operation\\s*=\\s*'${operation}'`, 'iu'))
  }
  for (const field of [
    'parent_id', 'name', 'description', 'open_to_building', 'open_to_things',
    'open_to_notes', 'traits', 'recipe', 'kind_id',
  ]) {
    assert.match(query, new RegExp(`['"]${field}['"]`, 'iu'))
  }
  assert.match(query, /jsonb_object_keys/iu)
  assert.match(query, /jsonb_array_elements/iu)
  assert.match(
    query,
    /target_changed_result\s+AS\s*\([\s\S]*?FROM\s+owned_attempt\s+attempt[\s\S]*?NOT\s+EXISTS\s*\(SELECT\s+1\s+FROM\s+operation_result\)/iu,
  )
})

test('treasury completion returns a typed no-effect result at the database deadline', async () => {
  const database = new RecordingDatabase([{ state: 'deadline_passed', attempt_id: ATTEMPT_ID }])

  const result = await completeTreasuryPaymentOperation(database, {
    attemptId: ATTEMPT_ID,
    leaseOwner: LEASE_OWNER,
  })

  assert.deepEqual(result, { state: 'deadline_passed', attemptId: ATTEMPT_ID })
  assert.equal(database.calls.length, 1)
  assert.match(database.calls[0]!.text, /recovery_deadline_at\s*<=\s*clock_timestamp\(\)/iu)
})

test('treasury completion rejects a lost lease without exposing stored attempt facts', async () => {
  const database = new RecordingDatabase([])

  await assert.rejects(
    completeTreasuryPaymentOperation(database, {
      attemptId: ATTEMPT_ID,
      leaseOwner: 'wrong-lease-owner',
    }),
    (error: unknown) => {
      assert.ok(error instanceof TreasuryPaymentOperationConflictError)
      assert.match(error.message, /lease|complete/iu)
      return true
    },
  )
})

test('treasury completion rejects malformed identifiers before querying', async () => {
  const database = new RecordingDatabase([])

  for (const input of [
    { attemptId: '', leaseOwner: LEASE_OWNER },
    { attemptId: 'short', leaseOwner: LEASE_OWNER },
    { attemptId: "attempt' OR true --", leaseOwner: LEASE_OWNER },
    { attemptId: ATTEMPT_ID, leaseOwner: '' },
    { attemptId: ATTEMPT_ID, leaseOwner: 'x'.repeat(129) },
  ]) {
    await assert.rejects(
      completeTreasuryPaymentOperation(database, input),
      /attempt id|lease owner/iu,
    )
  }
  assert.equal(database.calls.length, 0)
})

test('treasury completion fails closed on a malformed completed database result', async () => {
  const malformedRows = [
    completedRow({ actor_id: 0 }),
    completedRow({ operation: 'direct_sale' }),
    completedRow({ response_status: 299 }),
    completedRow({ response_status: 200 }),
    completedRow({ response_json: [] }),
    completedRow({ response_body: '{not-json' }),
  ]

  for (const row of malformedRows) {
    const database = new RecordingDatabase([row])
    await assert.rejects(
      completeTreasuryPaymentOperation(database, {
        attemptId: ATTEMPT_ID,
        leaseOwner: LEASE_OWNER,
      }),
      /completion result/iu,
    )
  }
})
