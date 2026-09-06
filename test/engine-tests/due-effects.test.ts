import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveDueEffects } from '../../src/engine.ts'
import { fakeSql } from './context.ts'

export function registerDueEffectsTests(): void {
test('due effects resolve append-only and are never deleted', async () => {
  let dueRead = 0
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM pending_effects pending/.test(text)) {
      dueRead += 1
      return dueRead === 1 ? [{
        id: 501,
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
      }] : []
    }
    if (/SELECT EXISTS/.test(text) && /FROM residents/.test(text)) return [{ exists: true }]
    if (/INSERT INTO active_labels/.test(text)) return [{ id: 601 }]
    if (/INSERT INTO effect_resolutions/.test(text)) return [{ id: 701 }]
    return []
  })

  const result = await resolveDueEffects(2, db)
  assert.deepEqual(result, { resolved: 1, failed: 0, capped: false })
  assert.equal(calls.some(call => /DELETE\s+FROM pending_effects/i.test(call.text)), false)
  assert.equal(calls.some(call => /INSERT INTO effect_resolutions/.test(call.text)), true)
  assert.equal(calls.some(call => /'effect_resolved'/.test(call.text)), true)
})

test('stored shared-use provenance blocks a destructive source timer at execution', async () => {
  let dueRead = 0
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM pending_effects pending/.test(text)) {
      dueRead += 1
      return dueRead === 1 ? [{
        id: 502,
        action_id: 130,
        parent_effect_id: null,
        place_id: 2,
        actor_id: 8,
        source_trait_id: 8,
        source_thing_id: 41,
        target_type: null,
        target_id: null,
        destination_place_id: null,
        recipient_id: null,
        payload: {
          effects: [{ effect: 'destroy', target: 'source' }],
          repeat_remaining: 0,
          shared_source_thing_id: 41,
        },
        due_at: '2026-08-11T00:00:00.000Z',
        generation: 0,
      }] : []
    }
    if (/INSERT INTO effect_resolutions/.test(text)) return [{ id: 702 }]
    return []
  })

  const result = await resolveDueEffects(2, db)

  assert.deepEqual(result, { resolved: 0, failed: 1, capped: false })
  assert.equal(calls.some(call => /UPDATE things SET withdrawn_at/.test(call.text)), false)
  const resolution = calls.find(call => /INSERT INTO effect_resolutions/.test(call.text))
  assert.ok(resolution)
  assert.match(String(resolution.values[2]), /shared.*source.*owner/i)
  const storedFailure = JSON.parse(String(resolution.values[2])) as { error: string }
  assert.equal(
    String(resolution.values.at(-1)),
    JSON.stringify({
      effect_id: 502,
      status: 'failed',
      error: storedFailure.error,
    }),
  )
})

test('invalid stored shared-use provenance is skipped closed', async () => {
  let dueRead = 0
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM pending_effects pending/.test(text)) {
      dueRead += 1
      return dueRead === 1 ? [{
        id: 503,
        action_id: 130,
        parent_effect_id: null,
        place_id: 2,
        actor_id: 8,
        source_trait_id: 8,
        source_thing_id: 41,
        target_type: null,
        target_id: null,
        destination_place_id: null,
        recipient_id: null,
        payload: {
          effects: [{ effect: 'destroy', target: 'source' }],
          repeat_remaining: 0,
          shared_source_thing_id: 'invalid',
        },
        due_at: '2026-08-11T00:00:00.000Z',
        generation: 0,
      }] : []
    }
    if (/INSERT INTO effect_resolutions/.test(text)) return [{ id: 703 }]
    return []
  })

  const result = await resolveDueEffects(2, db)

  assert.deepEqual(result, { resolved: 0, failed: 1, capped: false })
  assert.equal(calls.some(call => /UPDATE things SET withdrawn_at/.test(call.text)), false)
  const resolution = calls.find(call => /INSERT INTO effect_resolutions/.test(call.text))
  assert.ok(resolution)
  assert.match(String(resolution.values[2]), /invalid stored effect payload/i)
  assert.equal(
    String(resolution.values.at(-1)),
    JSON.stringify({
      effect_id: 503,
      status: 'skipped',
      error: 'invalid stored effect payload',
    }),
  )
})

test('an unknown stored-effect failure publishes a safe cause and keeps safe operator diagnostics', async t => {
  let dueRead = 0
  const privateMessage = 'private database detail must not reach a resident'
  const logged: unknown[][] = []
  t.mock.method(console, 'error', (...values: unknown[]) => {
    logged.push(values)
  })
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM pending_effects pending/.test(text)) {
      dueRead += 1
      return dueRead === 1 ? [{
        id: 504,
        action_id: 130,
        parent_effect_id: null,
        place_id: 2,
        actor_id: 8,
        source_trait_id: 8,
        source_thing_id: 41,
        target_type: 'resident',
        target_id: 8,
        destination_place_id: null,
        recipient_id: null,
        payload: {
          effects: [{ effect: 'label', target: 'actor', label: 'late-label' }],
          repeat_remaining: 0,
        },
        due_at: '2026-08-11T00:00:00.000Z',
        generation: 0,
      }] : []
    }
    if (/SELECT EXISTS/.test(text) && /FROM residents/.test(text)) {
      throw Object.assign(new Error(privateMessage), {
        code: '57P01',
        detail: 'private authored text must not be copied to logs',
        query: 'private SQL parameters must not be copied to logs',
      })
    }
    if (/INSERT INTO effect_resolutions/.test(text)) return [{ id: 704 }]
    return []
  })

  const result = await resolveDueEffects(2, db)

  assert.deepEqual(result, { resolved: 0, failed: 1, capped: false })
  const resolution = calls.find(call => /INSERT INTO effect_resolutions/.test(call.text))
  assert.ok(resolution)
  assert.equal(
    String(resolution.values[2]),
    JSON.stringify({ error: 'the city could not complete this stored effect' }),
  )
  assert.equal(
    String(resolution.values.at(-1)),
    JSON.stringify({
      effect_id: 504,
      status: 'failed',
      error: 'the city could not complete this stored effect',
    }),
  )
  assert.doesNotMatch(JSON.stringify(calls), /private database detail/u)
  assert.deepEqual(logged, [[
    'unrecognized stored effect execution failure',
    {
      effect_id: 504,
      error_name: 'Error',
      error_message: privateMessage,
      error_code: '57P01',
    },
  ]])
  assert.doesNotMatch(JSON.stringify(logged), /private authored text|private SQL parameters/u)
})

}
