import test from 'node:test'
import assert from 'node:assert/strict'
import {
  completeDirectSalePayment,
  completeWorldSalePayment,
  closeInvalidSalePaymentTarget,
  closeSalePaymentTarget,
  invalidateSalePaymentTarget,
  parkWorldSalePayment,
  type PaymentSaleDatabase,
} from '../src/payment-sale-operations.ts'
import { canonicalPaymentRequest } from '../src/payment-attempts.ts'

const ATTEMPT_ID = 'pay_sale_1234567890abcdef'
const LEASE_OWNER = 'lease-sale-1234567890abcdef'
const TX_HASH = `0x${'ab'.repeat(32)}`
const BUYER_WALLET = '0x2222222222222222222222222222222222222222'
const SELLER_WALLET = '0x1111111111111111111111111111111111111111'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const HEADER = Buffer.from(JSON.stringify({ transaction: TX_HASH })).toString('base64')

type QueryCall = { text: string; params: readonly unknown[] }

function directRequest(overrides: Record<string, unknown> = {}) {
  return {
    offer_id: 91,
    buyer_wallet: BUYER_WALLET,
    seller_wallet: SELLER_WALLET,
    price_usdc: 3,
    asset_type: 'thing',
    asset_id: 41,
    ...overrides,
  }
}

function worldRequest(overrides: Record<string, unknown> = {}) {
  return {
    offer_id: 101,
    market_checkout_id: 81,
    market_listing_id: 91,
    market_draft_id: 71,
    market_buyer: 'market-buyer',
    buyer_wallet: BUYER_WALLET,
    seller_wallet: SELLER_WALLET,
    price_usdc: 2,
    asset_id: 41,
    ...overrides,
  }
}

function attemptRow(
  operation: 'direct_sale' | 'world_sale',
  overrides: Record<string, unknown> = {},
) {
  const request = operation === 'direct_sale' ? directRequest() : worldRequest()
  const canonical = canonicalPaymentRequest(request)
  return {
    attempt_id: ATTEMPT_ID,
    actor_id: 8,
    counterparty_id: 7,
    operation,
    target_key: operation === 'direct_sale' ? 'direct-sale:91' : 'world-sale:101',
    attempt_offer_id: operation === 'direct_sale' ? 91 : 101,
    attempt_asset_type: 'thing',
    attempt_asset_id: 41,
    request_hash: canonical.hash,
    request_json: request,
    method: 'x402',
    network: 'base',
    token: USDC,
    payer_wallet: BUYER_WALLET,
    payee_wallet: SELLER_WALLET,
    amount_units: operation === 'direct_sale' ? '3000000' : '2000000',
    start_time: '2026-08-22T12:00:00.000Z',
    end_time: '2026-08-22T12:05:00.000Z',
    status: 'payment_pending',
    lease_owner: LEASE_OWNER,
    tx_hash: TX_HASH,
    finalized_block_number: '123',
    finalized_block_hash: `0x${'cd'.repeat(32)}`,
    finalized_block_time: '2026-08-22T12:01:00.000Z',
    finalized_at: '2026-08-22T12:15:00.000Z',
    recovery_started_at: '2026-08-22T12:01:00.000Z',
    recovery_deadline_at: '2026-08-22T14:01:00.000Z',
    recovery_open: true,
    offer_id: operation === 'direct_sale' ? 91 : 101,
    channel: operation === 'direct_sale' ? 'direct' : 'world',
    asset_type: 'thing',
    asset_id: 41,
    seller_id: 7,
    seller: 'seller',
    buyer_id: 8,
    buyer: 'buyer',
    price_usdc: operation === 'direct_sale' ? '3.000000' : '2.000000',
    seller_wallet: SELLER_WALLET,
    buyer_wallet: BUYER_WALLET,
    offer_status: 'open',
    reserved_by: 8,
    reserved_at: '2026-08-22T12:00:00.000Z',
    reserved_until: '2026-08-22T12:05:00.000Z',
    current_owner_id: 7,
    active_offer_id: operation === 'direct_sale' ? 91 : 101,
    withdrawn_at: null,
    market_origin: 'https://1f3ea.com',
    market_draft_id: operation === 'world_sale' ? 71 : null,
    market_listing_id: operation === 'world_sale' ? 91 : null,
    market_checkout_id: operation === 'world_sale' ? 81 : null,
    market_buyer: operation === 'world_sale' ? 'market-buyer' : null,
    pending_payment_attempt_id: operation === 'world_sale' ? ATTEMPT_ID : null,
    pending_x402_tx_hash: operation === 'world_sale' ? TX_HASH : null,
    pending_x402_payer: operation === 'world_sale' ? BUYER_WALLET : null,
    pending_x402_at: operation === 'world_sale' ? '2026-08-22T12:01:01.000Z' : null,
    x402_evidence_state: operation === 'world_sale' ? 'pending' : 'none',
    asset_name: 'porch lantern',
    maker_id: 6,
    made_by: 'old-maker',
    ...overrides,
  }
}

function completionRow(operation: 'direct_sale' | 'world_sale') {
  const response = operation === 'direct_sale'
    ? {
        offer: { id: 91, status: 'claimed' },
        transfer: {
          id: 501,
          type: 'thing',
          asset_id: 41,
          from: 'seller',
          to: 'buyer',
          price_usdc: 3,
          tx_hash: TX_HASH,
          created_at: '2026-08-22T12:15:00.000Z',
        },
      }
    : { offer: { id: 101, channel: 'world', phase: 'claimed' } }
  return {
    state: 'completed',
    attempt_id: ATTEMPT_ID,
    actor_id: 8,
    operation,
    method: 'x402',
    response_status: 200,
    response,
    response_body: JSON.stringify(response),
    payment_response_header: HEADER,
  }
}

function databaseFor(
  read: Record<string, unknown>,
  final: Record<string, unknown> = completionRow(read.operation as 'direct_sale' | 'world_sale'),
) {
  const calls: QueryCall[] = []
  let storedRead = { ...read }
  const database: PaymentSaleDatabase = {
    query: async (text, params = []) => {
      calls.push({ text, params })
      if (text.includes('payment-sale-operations:read-attempt')) return [storedRead]
      if (text.includes('payment-sale-operations:complete-direct')) return [final]
      if (text.includes('payment-sale-operations:complete-world')) return [final]
      if (text.includes('payment-sale-operations:park-world')) {
        storedRead = {
          ...storedRead,
          pending_payment_attempt_id: storedRead.attempt_id,
          pending_x402_tx_hash: storedRead.tx_hash,
          pending_x402_payer: storedRead.payer_wallet,
          pending_x402_at: '2026-08-22T12:15:00.000Z',
          x402_evidence_state: 'pending',
        }
        return [{ state: 'parked' }]
      }
      if (text.includes('payment-sale-operations:close-invalid-target')) return [final]
      if (text.includes('payment-sale-operations:invalidate-target')) return [final]
      if (text.includes('payment-sale-operations:close-target')) return [final]
      throw new Error(`unexpected query: ${text}`)
    },
  }
  return { database, calls }
}

test('direct completion after ordinary 15-minute finality uses only stored canonical facts', async () => {
  const { database, calls } = databaseFor(attemptRow('direct_sale'))

  const result = await completeDirectSalePayment(database, {
    attemptId: ATTEMPT_ID,
    leaseOwner: LEASE_OWNER,
  })

  assert.equal(result.state, 'completed')
  if (result.state !== 'completed') return
  assert.equal(result.responseBody, JSON.stringify(result.response))
  assert.equal(result.paymentResponseHeader, HEADER)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]!.params, [ATTEMPT_ID, LEASE_OWNER])
  assert.match(calls[1]!.text, /recovery_deadline_at\s*>\s*clock_timestamp\(\)/i)
  assert.match(calls[1]!.text, /insert\s+into\s+payment_uses/i)
  assert.match(calls[1]!.text, /insert\s+into\s+sale_payments/i)
  assert.match(calls[1]!.text, /complete_payment_attempt/i)
  assert.doesNotMatch(calls[1]!.text, /\$\{.*table/i)
})

test('deadline equality or elapsed time returns a typed no-effect without running sale SQL', async () => {
  for (const deadline of ['2026-08-22T14:01:00.000Z', '2026-08-22T14:00:59.999Z']) {
    const { database, calls } = databaseFor(attemptRow('direct_sale', {
      recovery_deadline_at: deadline,
      recovery_open: false,
    }))
    const result = await completeDirectSalePayment(database, {
      attemptId: ATTEMPT_ID,
      leaseOwner: LEASE_OWNER,
    })
    assert.deepEqual(result, {
      state: 'deadline_passed',
      attemptId: ATTEMPT_ID,
      actorId: 8,
      operation: 'direct_sale',
      method: 'x402',
    })
    assert.equal(calls.length, 1)
  }
})

test('changed stored request or current ownership returns target_changed and creates no effect', async () => {
  for (const row of [
    attemptRow('direct_sale', { request_json: directRequest({ price_usdc: 4 }) }),
    attemptRow('direct_sale', { current_owner_id: 9 }),
  ]) {
    const { database, calls } = databaseFor(row)
    const result = await completeDirectSalePayment(database, {
      attemptId: ATTEMPT_ID,
      leaseOwner: LEASE_OWNER,
    })
    assert.equal(result.state, 'target_changed')
    if (result.state !== 'target_changed') continue
    assert.equal(result.attemptId, ATTEMPT_ID)
    assert.equal(result.actorId, 8)
    assert.equal(result.operation, 'direct_sale')
    assert.match(result.reason, /stored payment terms|ownership changed/i)
    assert.equal(calls.length, 1)
  }
})

test('duplicate worker retry replays the exact stored response without a second sale statement', async () => {
  const response = { offer: { id: 91, status: 'claimed' }, exact: 'same bytes' }
  const exactResponseBody = '{\n  "offer":{"id":91,"status":"claimed"},\n  "exact":"same bytes"\n}'
  const row = attemptRow('direct_sale', {
    status: 'completed',
    lease_owner: null,
    recovery_open: false,
    offer_status: 'claimed',
    current_owner_id: 8,
    active_offer_id: null,
    response_status: 200,
    response,
    response_body: exactResponseBody,
    payment_response_header: HEADER,
  })
  const { database, calls } = databaseFor(row)

  const result = await completeDirectSalePayment(database, {
    attemptId: ATTEMPT_ID,
    leaseOwner: 'stale-worker-lease',
  })

  assert.equal(result.state, 'completed')
  if (result.state !== 'completed') return
  assert.equal(result.responseBody, exactResponseBody)
  assert.deepEqual(result.response, response)
  assert.equal(result.paymentResponseHeader, HEADER)
  assert.equal(calls.length, 1)
})

test('a worker that loses the atomic completion race rereads and replays the winner response', async () => {
  const pending = attemptRow('direct_sale')
  const completed = {
    ...pending,
    status: 'completed',
    lease_owner: null,
    recovery_open: false,
    offer_status: 'claimed',
    current_owner_id: 8,
    active_offer_id: null,
    response_status: 200,
    response: completionRow('direct_sale').response,
    response_body: completionRow('direct_sale').response_body,
    payment_response_header: HEADER,
  }
  let reads = 0
  const calls: QueryCall[] = []
  const database: PaymentSaleDatabase = {
    query: async (text, params = []) => {
      calls.push({ text, params })
      if (text.includes('payment-sale-operations:read-attempt')) {
        reads += 1
        return [reads === 1 ? pending : completed]
      }
      if (text.includes('payment-sale-operations:complete-direct')) return []
      throw new Error(`unexpected query: ${text}`)
    },
  }

  const result = await completeDirectSalePayment(database, {
    attemptId: ATTEMPT_ID,
    leaseOwner: LEASE_OWNER,
  })

  assert.equal(result.state, 'completed')
  if (result.state !== 'completed') return
  assert.equal(result.responseBody, completed.response_body)
  assert.equal(result.paymentResponseHeader, HEADER)
  assert.equal(reads, 2)
  assert.equal(calls.filter(call => call.text.includes('complete-direct')).length, 1)
})

test('world parking attaches only the stored attempt and hash and is safe to repeat', async () => {
  const row = attemptRow('world_sale', {
    pending_payment_attempt_id: null,
    pending_x402_tx_hash: null,
    pending_x402_payer: null,
    pending_x402_at: null,
    x402_evidence_state: 'none',
  })
  const { database, calls } = databaseFor(row, {
    state: 'parked',
    attempt_id: ATTEMPT_ID,
    actor_id: 8,
    operation: 'world_sale',
    method: 'x402',
  })

  const result = await parkWorldSalePayment(database, { attemptId: ATTEMPT_ID })

  assert.equal(result.state, 'parked')
  assert.deepEqual(calls.at(-1)!.params, [ATTEMPT_ID])
  assert.match(calls.at(-1)!.text, /pending_payment_attempt_id/i)
  assert.match(calls.at(-1)!.text, /request_json/i)
  assert.match(calls.at(-1)!.text, /recovery_deadline_at\s*>\s*clock_timestamp\(\)/i)
})

test('world completion safely parks stored evidence before the atomic finalization', async () => {
  const row = attemptRow('world_sale', {
    pending_payment_attempt_id: null,
    pending_x402_tx_hash: null,
    pending_x402_payer: null,
    pending_x402_at: null,
    x402_evidence_state: 'none',
  })
  const { database, calls } = databaseFor(row)

  const result = await completeWorldSalePayment(database, {
    attemptId: ATTEMPT_ID,
    leaseOwner: LEASE_OWNER,
  })

  assert.equal(result.state, 'completed')
  const parked = calls.find(call => call.text.includes('payment-sale-operations:park-world'))!
  assert.deepEqual(parked.params, [ATTEMPT_ID])
  assert.match(parked.text, /pending_payment_attempt_id/i)
  assert.match(parked.text, /pending_x402_tx_hash/i)
  const completed = calls.at(-1)!
  assert.deepEqual(completed.params, [ATTEMPT_ID, LEASE_OWNER])
  assert.match(completed.text, /update\s+things\s+set\s+owner_id/i)
  assert.match(completed.text, /insert\s+into\s+events/i)
  assert.match(completed.text, /complete_payment_attempt/i)
})

test('terminal close releases direct targets but preserves the world lock for market-first cancel', async () => {
  for (const [operation, terminalState, released] of [
    ['direct_sale', 'expired', true],
    ['world_sale', 'founder_review', false],
  ] as const) {
    const row = attemptRow(operation)
    const { database, calls } = databaseFor(row, {
      state: terminalState,
      attempt_id: ATTEMPT_ID,
      actor_id: 8,
      operation,
      method: 'x402',
      target_released: released,
    })

    const result = await closeSalePaymentTarget(database, {
      attemptId: ATTEMPT_ID,
      leaseOwner: LEASE_OWNER,
      reason: terminalState === 'expired'
        ? 'automatic recovery deadline passed'
        : 'matching payment needs founder review',
      state: terminalState,
    })

    assert.equal(result.state, terminalState)
    assert.equal(result.targetReleased, released)
    const statement = calls.at(-1)!
    assert.match(statement.text, /update\s+payment_attempts/i)
    assert.match(statement.text, /x402_evidence_state/i)
    assert.doesNotMatch(statement.text, /insert\s+into\s+(payment_uses|sale_payments|transfers|events)/i)
    if (operation === 'direct_sale') {
      assert.match(statement.text, /status\s*=\s*'canceled'/i)
      assert.match(statement.text, /update\s+things\s+set\s+active_offer_id\s*=\s*null/i)
    } else {
      assert.match(statement.text, /world_terminal_evidence[\s\S]*x402_evidence_state\s*=\s*\$3/i)
      assert.match(statement.text, /direct_canceled_offer[\s\S]*attempt\.operation\s*=\s*'direct_sale'/i)
    }
  }
})

test('deadline close with ambiguous world evidence terminalizes only the attempt when no hash exists', async () => {
  const row = attemptRow('world_sale', {
    status: 'needs_review',
    tx_hash: null,
    finalized_block_number: null,
    finalized_block_hash: null,
    finalized_block_time: null,
    finalized_at: null,
    recovery_open: false,
    pending_payment_attempt_id: null,
    pending_x402_tx_hash: null,
    pending_x402_payer: null,
    pending_x402_at: null,
    x402_evidence_state: 'none',
  })
  const { database, calls } = databaseFor(row, {
    state: 'expired',
    attempt_id: ATTEMPT_ID,
    actor_id: 8,
    operation: 'world_sale',
    method: 'x402',
    target_released: false,
  })

  const result = await closeSalePaymentTarget(database, {
    attemptId: ATTEMPT_ID,
    leaseOwner: LEASE_OWNER,
    reason: 'automatic recovery deadline passed without transaction evidence',
    state: 'expired',
  })

  assert.equal(result.state, 'expired')
  assert.equal(result.targetReleased, false)
  const statement = calls.at(-1)!.text
  assert.match(statement, /world_terminal_evidence[\s\S]*attempt\.tx_hash\s+is\s+not\s+null/i)
  assert.match(statement, /world_terminal_evidence[\s\S]*attempt\.payer_wallet\s+is\s+not\s+null/i)
  assert.doesNotMatch(statement, /insert\s+into\s+(payment_uses|sale_payments|transfers|events)/i)
})

test('invalid sale synchronization uses only stored terminal facts and never creates an effect', async () => {
  for (const [operation, released, synchronized] of [
    ['direct_sale', true, false],
    ['world_sale', false, true],
  ] as const) {
    const row = attemptRow(operation, {
      status: 'invalid',
      lease_owner: null,
      invalid_reason: 'confirmed payment falls outside its immutable terms or time window',
    })
    const { database, calls } = databaseFor(row, {
      state: 'invalid',
      attempt_id: ATTEMPT_ID,
      actor_id: 8,
      operation,
      method: 'x402',
      target_released: released,
      evidence_synchronized: synchronized,
    })

    const result = await closeInvalidSalePaymentTarget(database, { attemptId: ATTEMPT_ID })

    assert.deepEqual(result, {
      state: 'invalid',
      attemptId: ATTEMPT_ID,
      actorId: 8,
      operation,
      method: 'x402',
      targetReleased: released,
      evidenceSynchronized: synchronized,
    })
    const statement = calls.at(-1)!
    assert.deepEqual(statement.params, [ATTEMPT_ID])
    assert.match(statement.text, /attempt\.status\s*=\s*'invalid'/i)
    assert.match(statement.text, /confirmed_mismatch/i)
    assert.doesNotMatch(statement.text, /insert\s+into\s+(payment_uses|sale_payments|transfers|events)/i)
  }
})

test('sale invalidation atomically terminalizes custody and synchronizes its exact target', async () => {
  for (const [operation, released, synchronized] of [
    ['direct_sale', true, false],
    ['world_sale', false, true],
  ] as const) {
    const { database, calls } = databaseFor(attemptRow(operation), {
      state: 'invalid',
      attempt_id: ATTEMPT_ID,
      actor_id: 8,
      operation,
      method: 'x402',
      target_released: released,
      evidence_synchronized: synchronized,
    })

    const result = await invalidateSalePaymentTarget(database, {
      attemptId: ATTEMPT_ID,
      leaseOwner: LEASE_OWNER,
      reason: 'confirmed_mismatch',
    })

    assert.equal(result.state, 'invalid')
    assert.equal(result.targetReleased, released)
    assert.equal(result.evidenceSynchronized, synchronized)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]!.params, [ATTEMPT_ID, LEASE_OWNER, 'confirmed_mismatch'])
    assert.match(calls[0]!.text, /update\s+payment_attempts[\s\S]*status\s*=\s*'invalid'/i)
    assert.match(calls[0]!.text, /world_invalid_evidence/i)
    assert.match(calls[0]!.text, /direct_canceled_offer/i)
    assert.match(calls[0]!.text, /safety_guard/i)
    assert.doesNotMatch(calls[0]!.text, /insert\s+into\s+(payment_uses|sale_payments|transfers|events)/i)
  }
})
