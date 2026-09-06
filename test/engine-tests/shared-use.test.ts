import test from 'node:test'
import assert from 'node:assert/strict'

import { runAction } from '../../src/engine.ts'
import { fakeSql } from './context.ts'

export function registerSharedUseTests(): void {
  test('a visitor may use an active, co-located, unoffered open thing without owning it', async () => {
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 8, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 130 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/SELECT thing\.id/.test(text)) {
        return [{
          id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null,
          has_open_offer: false, open_to_use: true,
        }]
      }
      if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
        trait_id: 8,
        recipe: { use: [{ effect: 'label', target: 'actor', label: 'welcomed' }] },
      }]
      if (/SELECT EXISTS/.test(text) && /FROM residents/.test(text)) return [{ exists: true }]
      if (/INSERT INTO active_labels/.test(text)) return [{ id: 301 }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 230 }]
      return []
    })

    const result = await runAction({
      actorId: 8,
      actorHandle: 'neighbor',
      action: 'use',
      placeId: 2,
      sourceThingId: 41,
    }, db)

    assert.equal(result.status, 'applied')
    assert.equal(result.httpStatus, 200)
    assert.equal(calls.some(call => /INSERT INTO active_labels/.test(call.text)), true)
    const sourceRead = calls.find(call => /SELECT thing\.id/.test(call.text))
    assert.ok(sourceRead)
    assert.match(sourceRead.text, /FOR UPDATE OF thing/i)
  })

  for (const [condition, expectedStatus, expectedError] of [
    [
      { open_to_use: false, withdrawn_at: null, active_offer_id: null, has_open_offer: false, place_id: 2 },
      403,
      /thing_id is not yours/i,
    ],
    [
      { open_to_use: true, withdrawn_at: '2026-08-11T00:00:00.000Z', active_offer_id: null, has_open_offer: false, place_id: 2 },
      404,
      /thing_id was not found or is withdrawn/i,
    ],
    [
      { open_to_use: true, withdrawn_at: null, active_offer_id: 90, has_open_offer: true, place_id: 2 },
      409,
      /open sale offer/i,
    ],
    [
      { open_to_use: true, withdrawn_at: null, active_offer_id: null, has_open_offer: false, place_id: 3 },
      403,
      /thing_id 41 must be in place_id 2; its current place_id is 3/i,
    ],
  ] as const) {
    test(`shared use enforces source readiness (${expectedStatus}: ${expectedError.source})`, async () => {
      const { db } = fakeSql(({ text }) => {
        if (/FROM resident_presence/.test(text)) {
          return [{ resident_id: 8, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
        }
        if (/INSERT INTO action_runs/.test(text)) return [{ id: 131 }]
        if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
        if (/SELECT thing\.id/.test(text)) return [{ id: 41, owner_id: 7, ...condition }]
        if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 231 }]
        return []
      })

      const result = await runAction({
        actorId: 8,
        actorHandle: 'neighbor',
        action: 'use',
        placeId: 2,
        sourceThingId: 41,
      }, db)

      assert.equal(result.status, 'failed')
      assert.equal(result.httpStatus, expectedStatus)
      assert.match(result.error ?? '', expectedError)
    })
  }

  test('shared use requires the visitor to have a current place', async () => {
    const { db } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 8, current_place_id: null, home_place_id: null, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 132 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/SELECT thing\.id/.test(text)) {
        return [{
          id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null,
          has_open_offer: false, open_to_use: true,
        }]
      }
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 232 }]
      return []
    })

    const result = await runAction({
      actorId: 8,
      actorHandle: 'neighbor',
      action: 'use',
      sourceThingId: 41,
    }, db)

    assert.equal(result.status, 'failed')
    assert.equal(result.httpStatus, 403)
    assert.equal(result.error, 'thing_id 41 cannot be used because your current place_id is unset')
  })

  test('an open thing is not a shared consumable', async () => {
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 8, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 132 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/SELECT thing\.id/.test(text)) return [{
        id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null,
        has_open_offer: false, open_to_use: true,
      }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 232 }]
      return []
    })

    const result = await runAction({
      actorId: 8,
      actorHandle: 'neighbor',
      action: 'consume',
      placeId: 2,
      sourceThingId: 41,
    }, db)

    assert.equal(result.status, 'failed')
    assert.equal(result.httpStatus, 403)
    assert.match(result.error ?? '', /thing_id is not yours/i)
    assert.equal(calls.some(call => /UPDATE things SET withdrawn_at/.test(call.text)), false)
  })

  const sourceMutationEffects = [
    ['destroy', (target: 'source' | 'target') => ({ effect: 'destroy', target })],
    ['move', (target: 'source' | 'target') => ({ effect: 'move', target, to: 'destination' })],
    ['transfer', (target: 'source' | 'target') => ({ effect: 'transfer', target, to: 'actor' })],
  ] as const

  const mutationNesting = [
    ['direct', (effect: object) => [effect]],
    ['nested', (effect: object) => [{
      effect: 'check_label', target: 'actor', label: 'owner-only-escape', then: [effect],
    }]],
    ['delayed', (effect: object) => [{ effect: 'wait', seconds: 10, then: [effect] }]],
  ] as const

  for (const [referenceName, reference, target] of [
    ['source-symbol', 'source', null],
    ['target-alias', 'target', { type: 'thing' as const, id: 41 }],
  ] as const) {
    for (const [effectName, makeEffect] of sourceMutationEffects) {
      for (const [pathName, wrap] of mutationNesting) {
        const recipe = wrap(makeEffect(reference))
        test(`shared use refuses ${pathName} ${effectName} through the ${referenceName}`, async () => {
          const { db, calls } = fakeSql(({ text }) => {
            if (/FROM resident_presence/.test(text)) {
              return [{ resident_id: 8, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
            }
            if (/INSERT INTO action_runs/.test(text)) return [{ id: 131 }]
            if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
            if (/SELECT thing\.id/.test(text)) {
              return [{
                id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null,
                has_open_offer: false, open_to_use: true,
              }]
            }
            if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
              trait_id: 8,
              recipe: { use: recipe },
            }]
            if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 231 }]
            return []
          })

          const result = await runAction({
            actorId: 8,
            actorHandle: 'neighbor',
            action: 'use',
            placeId: 2,
            sourceThingId: 41,
            target,
            destinationPlaceId: 3,
            recipientId: 7,
          }, db)

          assert.equal(result.status, 'failed')
          assert.equal(result.httpStatus, 403)
          assert.match(result.error ?? '', /shared.*source.*owner|open.*thing.*change/i)
          assert.equal(calls.some(call => /INSERT INTO active_labels/.test(call.text)), false)
          assert.equal(calls.some(call => /UPDATE things SET withdrawn_at/.test(call.text)), false)
          assert.equal(calls.some(call => /UPDATE things moving SET place_id/.test(call.text)), false)
          assert.equal(calls.some(call => /UPDATE things SET owner_id/.test(call.text)), false)
          assert.equal(calls.some(call => /INSERT INTO pending_effects/.test(call.text)), false)
        })
      }
    }
  }

  test('an owner may still use a destructive source recipe', async () => {
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 133 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/SELECT thing\.id/.test(text)) return [{
        id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null,
        has_open_offer: false, open_to_use: true,
      }]
      if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
        trait_id: 8,
        recipe: { use: [{ effect: 'destroy', target: 'source' }] },
      }]
      if (/UPDATE things SET withdrawn_at/.test(text)) return [{ id: 41 }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 233 }]
      return []
    })

    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'use',
      placeId: 2,
      sourceThingId: 41,
    }, db)

    assert.equal(result.status, 'applied')
    assert.equal(result.httpStatus, 200)
    assert.equal(calls.some(call => /UPDATE things SET withdrawn_at/.test(call.text)), true)
  })

  test('a successful owned destroy returns the documented response shape', async () => {
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 134 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/SELECT thing\.id/.test(text)) return [{
        id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null,
        has_open_offer: false, open_to_use: false,
      }]
      if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
        trait_id: 8,
        recipe: { use: [{ effect: 'destroy', target: 'source' }] },
      }]
      if (/UPDATE things SET withdrawn_at/.test(text)) return [{ id: 41 }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 234 }]
      return []
    })

    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'use',
      placeId: 2,
      sourceThingId: 41,
    }, db)

    assert.deepEqual(
      { status: result.status, httpStatus: result.httpStatus, error: result.error, effectsApplied: result.effectsApplied },
      { status: 'applied', httpStatus: 200, error: null, effectsApplied: 1 },
    )
    // effects_applied travels in the bearer resolution detail; whether the
    // generic 'action' event is suppressed in favor of the typed
    // 'thing_withdrawn' one is a runtime WHERE-clause decision this fake
    // cannot observe, so that single-event guarantee is proven against real
    // PostgreSQL in test/integration/destroy-postgres.test.ts instead.
    const resolution = calls.find(call => /INSERT INTO action_resolutions/.test(call.text))
    assert.ok(resolution)
    assert.match(String(resolution.values[2]), /"effects_applied":1/)
    assert.equal(calls.some(call => /'thing_withdrawn'/.test(call.text)), true)
  })

}
