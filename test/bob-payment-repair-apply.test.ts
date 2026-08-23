import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOB_REPAIR_EXPECTATIONS,
  BOB_REPAIR_CREDIT_REASON,
  BOB_REPAIR_CREDIT_SOURCE_KEY,
  BOB_REPAIR_EXPIRY_REASON,
  buildBobPaymentRepairPlan,
  type BobRepairSnapshot,
  type BobTransferEvidence,
} from '../scripts/repair-bob-payments.ts'
import { bobPaymentRepairApplyOperations } from '../scripts/bob-payment-repair-apply.ts'

const REQUESTS = Object.freeze({
  coffee: BOB_REPAIR_EXPECTATIONS.coffee.request,
  theBlueAI: BOB_REPAIR_EXPECTATIONS.theBlueAI.request,
})

function attempt(key: 'coffee' | 'theBlueAI') {
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
    request_json: REQUESTS[key],
    method: 'x402',
    network: 'base',
    token: BOB_REPAIR_EXPECTATIONS.token,
    payer_wallet: BOB_REPAIR_EXPECTATIONS.payer,
    payee_wallet: BOB_REPAIR_EXPECTATIONS.recipient,
    amount_units: '1000000',
    status: 'expired',
    lease_owner: null,
    lease_expires_at: null,
    recovery_started_at: expected.recoveryStartedAt,
    recovery_deadline_at: expected.recoveryDeadlineAt,
    tx_hash: expected.txHash,
    finalized_block_number: null,
    finalized_block_hash: null,
    finalized_block_time: null,
    finalized_at: null,
    invalid_reason: BOB_REPAIR_EXPIRY_REASON,
    completed_at: null,
    updated_at: expected.updatedAt,
    database_now: '2026-08-23T12:00:00.000Z',
  }
}

function snapshot(): BobRepairSnapshot {
  return {
    residents: [{ id: 68, handle: 'bob' }],
    attempts: [attempt('coffee'), attempt('theBlueAI')],
    paymentUses: [],
    fees: [],
    worldRoots: [{ id: 1, name: 'the world', place_kind: 'world', owner_id: null }],
    places: [],
    credits: [],
    events: [],
  }
}

function evidence(key: 'coffee' | 'theBlueAI'): BobTransferEvidence {
  const expected = BOB_REPAIR_EXPECTATIONS[key]
  return {
    state: 'matched',
    from: BOB_REPAIR_EXPECTATIONS.payer,
    to: BOB_REPAIR_EXPECTATIONS.recipient,
    amount: 1_000_000n,
    blockNumber: BigInt(expected.blockNumber),
    blockHash: expected.blockHash,
    blockTime: new Date(expected.blockTime),
    finalizedAt: new Date('2026-08-23T12:00:00.000Z'),
  }
}

function actions() {
  const plan = buildBobPaymentRepairPlan(snapshot(), {
    [BOB_REPAIR_EXPECTATIONS.coffee.txHash]: evidence('coffee'),
    [BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash]: evidence('theBlueAI'),
  })
  assert.equal(plan.state, 'work_required')
  return {
    complete: plan.actions.find(action => action.kind === 'complete_theblueai')!,
    close: plan.actions.find(action => action.kind === 'close_coffee_probe')!,
    credit: plan.actions.find(action => action.kind === 'issue_founder_credit')!,
  }
}

class RecordingDatabase {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = []

  async query(text: string, values: readonly unknown[] = []) {
    this.calls.push({ text, values })
    if (text.includes('bob-payment-repair-apply:create-place')) return { rows: [{ id: 901 }] }
    if (text.includes('bob-payment-repair-apply:review-theblueai')) {
      return { rows: [{ public_id: BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId }] }
    }
    if (text.includes('bob-payment-repair-apply:close-coffee')) {
      return { rows: [{ public_id: BOB_REPAIR_EXPECTATIONS.coffee.attemptId }] }
    }
    if (text.includes('city-credit:issue-balance')) return { rows: [{ balance_units: '1000000' }] }
    if (text.includes('city-credit:issue')) {
      return { rows: [{
        id: '71', entry_kind: 'founder_issue', resident_id: 68, founder_id: 1,
        amount_units: '1000000', source_key: BOB_REPAIR_CREDIT_SOURCE_KEY,
        reason: BOB_REPAIR_CREDIT_REASON, created: true,
        created_at: '2026-08-23T12:00:00.000Z',
      }] }
    }
    return { rows: [] }
  }
}

test('approved Bob apply operations use only the supplied transaction and exact guarded facts', async () => {
  const database = new RecordingDatabase()
  const action = actions()

  await bobPaymentRepairApplyOperations.completeTheBlueAI(database, action.complete)
  await bobPaymentRepairApplyOperations.closeCoffeeProbe(database, action.close)
  await bobPaymentRepairApplyOperations.issueFounderCredit(database, action.credit)

  const text = database.calls.map(call => call.text).join('\n')
  assert.match(text, /bob-payment-repair-apply:create-place/iu)
  assert.match(text, /bob-payment-repair-apply:review-theblueai/iu)
  assert.match(text, /bob-payment-repair-apply:close-coffee/iu)
  assert.match(text, /city-credit:issue/iu)
  assert.match(text, /request_hash/iu)
  assert.match(text, /recovery_started_at/iu)
  assert.match(text, /recovery_deadline_at/iu)
  assert.match(text, /finalized_block_number/iu)
  assert.match(text, /INSERT INTO events/iu)
  assert.doesNotMatch(text, /INSERT INTO payment_uses|INSERT INTO fees/iu)
  assert.match(text, /status\s*=\s*'founder_review'/iu)
  assert.doesNotMatch(text, /CREATE\s+(?:ROLE|USER)|ALTER\s+ROLE|session_replication_role/iu)

  const values = database.calls.flatMap(call => [...call.values]).map(String)
  for (const expected of [
    BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId,
    BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash,
    BOB_REPAIR_EXPECTATIONS.theBlueAI.requestHash,
    BOB_REPAIR_EXPECTATIONS.theBlueAI.blockHash,
    BOB_REPAIR_EXPECTATIONS.coffee.attemptId,
    BOB_REPAIR_EXPECTATIONS.coffee.txHash,
    BOB_REPAIR_CREDIT_SOURCE_KEY,
  ]) assert.ok(values.includes(expected), `missing guarded value ${expected}`)
})

test('an operation that cannot affect exactly one approved row aborts', async () => {
  const database = new RecordingDatabase()
  database.query = async (text: string, values: readonly unknown[] = []) => {
    database.calls.push({ text, values })
    return { rows: [] }
  }
  const action = actions()

  await assert.rejects(
    bobPaymentRepairApplyOperations.completeTheBlueAI(database, action.complete),
    /aborted|changed|conflict/iu,
  )
})

test('apply guards require the exact expired row with no lease', async () => {
  const base = snapshot()
  const expired: BobRepairSnapshot = {
    ...base,
    attempts: base.attempts.map((row, index) => ({
      ...row,
      updated_at: `2026-08-23T11:59:0${index}.000Z`,
    })),
  }
  const plan = buildBobPaymentRepairPlan(expired, {
    [BOB_REPAIR_EXPECTATIONS.coffee.txHash]: evidence('coffee'),
    [BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash]: evidence('theBlueAI'),
  })
  assert.equal(plan.state, 'work_required')
  const complete = plan.actions.find(action => action.kind === 'complete_theblueai')!
  assert.equal(complete.kind, 'complete_theblueai')

  const database = new RecordingDatabase()
  await bobPaymentRepairApplyOperations.completeTheBlueAI(database, complete)

  const guarded = database.calls.find(call => call.text.includes('bob-payment-repair-apply:create-place'))
  assert.ok(guarded)
  assert.match(
    guarded.text,
    /status\s*=\s*'expired'[\s\S]*lease_owner\s+IS\s+NULL[\s\S]*lease_expires_at\s+IS\s+NULL[\s\S]*invalid_reason\s*=\s*'automatic payment recovery deadline passed'/iu,
  )
  assert.doesNotMatch(guarded.text, /lease_owner\s+IS\s+NOT\s+NULL/iu)
  assert.ok(guarded.values.map(String).includes('2026-08-23T11:59:01.000Z'))
})
