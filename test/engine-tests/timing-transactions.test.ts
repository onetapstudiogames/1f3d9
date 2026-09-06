import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveDueEffects,
  setEngineTransactionRunnerForTests,
  withEngineTransaction,
} from '../../src/engine.ts'
import { fakeSql } from './context.ts'

export function registerTimingTransactionTests(): void {
test('production-style timer resolution locks before re-reading unresolved work', async () => {
  let resolved = false
  const row = {
    id: 511,
    action_id: 104,
    parent_effect_id: null,
    place_id: 2,
    actor_id: 7,
    source_trait_id: null,
    source_thing_id: null,
    target_type: 'resident',
    target_id: 7,
    destination_place_id: null,
    recipient_id: null,
    payload: { effects: [{ effect: 'label', target: 'actor', label: 'awake' }], repeat_remaining: 0 },
    due_at: '2026-08-11T00:00:00.000Z',
    generation: 0,
  }
  const { db, calls } = fakeSql(({ text }) => {
    if (/pg_advisory_xact_lock/.test(text)) return []
    if (/FROM pending_effects pending/.test(text)) return resolved ? [] : [row]
    if (/SELECT EXISTS/.test(text) && /FROM residents/.test(text)) return [{ exists: true }]
    if (/INSERT INTO active_labels/.test(text)) return [{ id: 611 }]
    if (/INSERT INTO effect_resolutions/.test(text)) {
      resolved = true
      return [{ id: 711 }]
    }
    return []
  })
  setEngineTransactionRunnerForTests((database, work) => work(database, true))
  try {
    assert.deepEqual(await resolveDueEffects(2, db), { resolved: 1, failed: 0, capped: false })
  } finally {
    setEngineTransactionRunnerForTests(null)
  }
  assert.equal(calls.some(call => /pg_advisory_xact_lock/.test(call.text)), true)
  assert.equal(calls.some(call => /FOR UPDATE OF pending/.test(call.text)), true)
})

test('nested engine work reuses the transaction opened by the test runner', async () => {
  const { db } = fakeSql(() => [])
  let transactionStarts = 0
  let active = false
  setEngineTransactionRunnerForTests(async (database, work) => {
    transactionStarts += 1
    assert.equal(active, false, 'the runner must not open a nested transaction')
    active = true
    try {
      return await work(database, true)
    } finally {
      active = false
    }
  })
  try {
    await withEngineTransaction(db, async transaction => {
      await withEngineTransaction(transaction, async (nested, atomic) => {
        assert.equal(nested, transaction)
        assert.equal(atomic, false)
      })
    })
  } finally {
    setEngineTransactionRunnerForTests(null)
  }
  assert.equal(transactionStarts, 1)
})

test('overdue repeats preserve the original logical clock while catching up', async () => {
  let dueRead = 0
  const { db, calls } = fakeSql(({ text }) => {
    if (/pg_advisory_xact_lock/.test(text)) return []
    if (/AS place_pending/.test(text)) return [{ place_pending: 0, actor_pending: 0 }]
    if (/FROM pending_effects pending/.test(text)) {
      dueRead += 1
      return dueRead === 1 ? [{
        id: 512,
        action_id: 104,
        parent_effect_id: null,
        place_id: 2,
        actor_id: 7,
        source_trait_id: null,
        source_thing_id: null,
        target_type: null,
        target_id: null,
        destination_place_id: null,
        recipient_id: null,
        payload: {
          effects: [],
          repeat_remaining: 1,
          repeat_seconds: 10,
          logical_due_at: '2026-08-11T00:00:00.106Z',
        },
        due_at: new Date('2026-08-11T05:00:00.106Z'),
        generation: 0,
      }] : []
    }
    if (/INSERT INTO pending_effects/.test(text)) return [{ id: 513 }]
    if (/INSERT INTO effect_resolutions/.test(text)) return [{ id: 713 }]
    return []
  })
  assert.deepEqual(await resolveDueEffects(2, db), { resolved: 1, failed: 0, capped: false })
  const repeated = calls.find(call => /INSERT INTO pending_effects/.test(call.text))
  assert.ok(repeated)
  assert.match(String(repeated.values[10]), /"logical_due_at":"2026-08-11T00:00:10.106Z"/)
  assert.equal(repeated.values[12], 1)
})

test('missing or malformed stored effect timestamps are skipped closed', async () => {
  let dueRead = 0
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM pending_effects pending/.test(text)) {
      dueRead += 1
      return dueRead === 1 ? [
        {
          id: 514,
          action_id: 105,
          parent_effect_id: null,
          place_id: 2,
          actor_id: 7,
          source_trait_id: null,
          source_thing_id: null,
          target_type: null,
          target_id: null,
          destination_place_id: null,
          recipient_id: null,
          payload: { effects: [], repeat_remaining: 0 },
          due_at: null,
          generation: 0,
        },
        {
          id: 515,
          action_id: 106,
          parent_effect_id: null,
          place_id: 2,
          actor_id: 7,
          source_trait_id: null,
          source_thing_id: null,
          target_type: null,
          target_id: null,
          destination_place_id: null,
          recipient_id: null,
          payload: { effects: [], repeat_remaining: 0, logical_due_at: 'banana' },
          due_at: '2026-08-11T05:00:00.106Z',
          generation: 0,
        },
      ] : []
    }
    if (/INSERT INTO effect_resolutions/.test(text)) return [{ id: 716 }]
    return []
  })

  assert.deepEqual(await resolveDueEffects(2, db), { resolved: 0, failed: 2, capped: false })
  const resolutions = calls.filter(call => /INSERT INTO effect_resolutions/.test(call.text))
  assert.equal(resolutions.length, 2)
  for (const resolution of resolutions) {
    assert.match(String(resolution.values[2]), /invalid stored effect payload/i)
  }
})

test('generation eight resolves but cannot schedule another repeat', async () => {
  let dueRead = 0
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM pending_effects pending/.test(text)) {
      dueRead += 1
      return dueRead === 1 ? [{
        id: 514,
        action_id: 104,
        parent_effect_id: 513,
        place_id: 2,
        actor_id: 7,
        source_trait_id: null,
        source_thing_id: null,
        target_type: null,
        target_id: null,
        destination_place_id: null,
        recipient_id: null,
        payload: { effects: [], repeat_remaining: 1, repeat_seconds: 10 },
        due_at: '2026-08-11T00:00:00.000Z',
        generation: 8,
      }] : []
    }
    if (/INSERT INTO effect_resolutions/.test(text)) return [{ id: 714 }]
    return []
  })
  assert.deepEqual(await resolveDueEffects(2, db), { resolved: 1, failed: 0, capped: false })
  assert.equal(calls.some(call => /INSERT INTO pending_effects/.test(call.text)), false)
})

}
