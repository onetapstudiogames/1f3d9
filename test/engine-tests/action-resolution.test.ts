import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EngineError,
  runAction,
  type ActionInput,
} from '../../src/engine.ts'
import { fakeSql } from './context.ts'

export function registerActionResolutionTests(): void {
  test('caller-handled primitives still record and run physics without duplicating the primitive', async () => {
    let primitiveCalls = 0
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 109 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/SELECT thing\.id/.test(text)) {
        return [{ id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null }]
      }
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 209 }]
      return []
    })
    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'give',
      placeId: 2,
      sourceThingId: 41,
      recipientId: 8,
      primitiveHandledByCaller: true,
      performPrimitive: async transaction => {
        primitiveCalls += 1
        await transaction`SELECT 'caller primitive completed'`
      },
    }, db)
    assert.equal(result.status, 'applied')
    assert.equal(primitiveCalls, 1)
    assert.equal(calls.some(call => /INSERT INTO transfers/.test(call.text)), false)
    assert.equal(calls.some(call => /INSERT INTO action_resolutions/.test(call.text)), true)
  })

  test('a caller quota failure preserves HTTP 429 and never records applied', async () => {
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 111 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 211 }]
      return []
    })
    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'talk',
      placeId: 2,
      primitiveHandledByCaller: true,
      performPrimitive: async () => {
        throw new EngineError(429, 'daily primitive quota reached')
      },
    }, db)
    assert.equal(result.status, 'failed')
    assert.equal(result.httpStatus, 429)
    const resolutions = calls.filter(call => /INSERT INTO action_resolutions/.test(call.text))
    assert.equal(resolutions.length, 1)
    assert.equal(resolutions[0]?.values[1], 'failed')
    assert.deepEqual(JSON.parse(String(resolutions[0]?.values.at(-2))), {
      action_id: 111,
      action: 'talk',
      status: 'failed',
      error: 'daily primitive quota reached',
    })
  })

  test('a caller primitive refusal rolls back law effects before recording failure', async () => {
    let labels = 0
    let labelsAtSavepoint: number | null = null
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 113 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/WITH RECURSIVE ancestry/.test(text)) {
        return [{
          trait_id: 31,
          name: 'talk-marker',
          recipe: { talk: [{ effect: 'label', target: 'actor', label: 'talked' }] },
          source_place_id: 2,
          position: 0,
        }]
      }
      if (/SELECT EXISTS/.test(text) && /FROM residents/.test(text)) return [{ exists: true }]
      if (/^SAVEPOINT caller_primitive_effects$/.test(text)) {
        labelsAtSavepoint = labels
        return []
      }
      if (/INSERT INTO active_labels/.test(text)) {
        labels += 1
        return [{ id: 313 }]
      }
      if (/^ROLLBACK TO SAVEPOINT caller_primitive_effects$/.test(text)) {
        assert.notEqual(labelsAtSavepoint, null)
        labels = labelsAtSavepoint!
        return []
      }
      if (/^RELEASE SAVEPOINT caller_primitive_effects$/.test(text)) return []
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 213 }]
      return []
    })

    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'talk',
      placeId: 2,
      primitiveHandledByCaller: true,
      performPrimitive: async transaction => {
        await transaction`SELECT 'caller primitive reached'`
        throw new EngineError(429, 'daily primitive quota reached')
      },
    }, db)

    assert.equal(result.status, 'failed')
    assert.equal(result.httpStatus, 429)
    assert.equal(labels, 0, 'the rejected primitive must leave no earlier law effect')
    const statements = calls.map(call => call.text)
    const savepoint = statements.indexOf('SAVEPOINT caller_primitive_effects')
    const lawEffect = statements.findIndex(statement => /INSERT INTO active_labels/.test(statement))
    const primitive = statements.indexOf("SELECT 'caller primitive reached'")
    const rollback = statements.indexOf('ROLLBACK TO SAVEPOINT caller_primitive_effects')
    const release = statements.indexOf('RELEASE SAVEPOINT caller_primitive_effects')
    const resolution = statements.findIndex(statement => /INSERT INTO action_resolutions/.test(statement))
    assert.ok(savepoint >= 0)
    assert.ok(savepoint < lawEffect && lawEffect < primitive)
    assert.ok(primitive < rollback && rollback < release && release < resolution)
  })

  test('a non-caller primitive keeps the existing action path without a savepoint', async () => {
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 114 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/WITH RECURSIVE ancestry/.test(text)) return []
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 214 }]
      return []
    })

    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'talk',
      placeId: 2,
    }, db)

    assert.equal(result.status, 'applied')
    assert.equal(calls.some(call => /SAVEPOINT caller_primitive_effects/.test(call.text)), false)
  })

  test('a recognized internal engine failure is generic in the public record', async t => {
    const logged: unknown[][] = []
    t.mock.method(console, 'error', (...values: unknown[]) => {
      logged.push(values)
    })
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 112 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 212 }]
      return []
    })

    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'make',
      placeId: 2,
      primitiveHandledByCaller: true,
      performPrimitive: async () => {
        throw new EngineError(500, 'database returned an invalid private result')
      },
    }, db)

    assert.equal(result.status, 'failed')
    assert.equal(result.httpStatus, 500)
    const expectedError = 'the city could not complete the action because of an internal failure; retry once, then contact the city operator if it keeps failing'
    assert.equal(result.error, expectedError)
    assert.equal(logged.length, 1)
    assert.deepEqual(logged[0]?.[1], {
      action_id: 112,
      error_name: 'EngineError',
      error_message: 'database returned an invalid private result',
    })
    const resolution = calls.find(call => /INSERT INTO action_resolutions/.test(call.text))
    assert.ok(resolution)
    assert.deepEqual(JSON.parse(String(resolution.values.at(-2))), {
      action_id: 112,
      action: 'make',
      status: 'failed',
      error: expectedError,
    })
  })

  test('an unknown action failure is generic in the public record but useful in server logs', async t => {
    const logged: unknown[][] = []
    t.mock.method(console, 'error', (...values: unknown[]) => {
      logged.push(values)
    })
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 112, home_place_id: 112, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 33530 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 43530 }]
      return []
    })
    const databaseError = Object.assign(
      new Error('column reference "id" is ambiguous'),
      {
        code: '42702',
        detail: 'private authored text must not be copied to logs',
        query: 'private SQL parameters must not be copied to logs',
      },
    )

    const result = await runAction({
      actorId: 7,
      actorHandle: 'strata',
      action: 'make',
      placeId: 112,
      primitiveHandledByCaller: true,
      performPrimitive: async () => {
        throw databaseError
      },
    }, db)

    assert.equal(result.status, 'failed')
    assert.equal(result.httpStatus, 500)
    const expectedError = 'the city could not complete the action because of an internal failure; retry once, then contact the city operator if it keeps failing'
    assert.equal(result.error, expectedError)
    assert.equal(logged.length, 1)
    assert.equal(logged[0]?.[0], 'unrecognized action execution failure')
    assert.deepEqual(logged[0]?.[1], {
      action_id: 33530,
      error_name: 'Error',
      error_message: 'column reference "id" is ambiguous',
      error_code: '42702',
    })
    assert.doesNotMatch(JSON.stringify(logged), /private authored text|private SQL parameters/u)
    const resolution = calls.find(call => /INSERT INTO action_resolutions/.test(call.text))
    assert.ok(resolution)
    assert.deepEqual(JSON.parse(String(resolution.values.at(-2))), {
      action_id: 33530,
      action: 'make',
      status: 'failed',
      error: expectedError,
    })
    assert.doesNotMatch(
      String(resolution.values.at(-2)),
      /private authored text|private SQL parameters|column reference/iu,
    )
  })

  test('an internal engine failure does not tell the caller to read action.error', async t => {
    const logged: unknown[][] = []
    t.mock.method(console, 'error', (...values: unknown[]) => {
      logged.push(values)
    })
    const { db } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 118 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 218 }]
      return []
    })

    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'make',
      placeId: 2,
      primitiveHandledByCaller: true,
      performPrimitive: async () => {
        throw new EngineError(500, 'database returned an invalid private result')
      },
    }, db)

    assert.equal(result.status, 'failed')
    assert.equal(result.httpStatus, 500)
    assert.ok(result.error)
    // The recorded action.error must not send the caller back to the very
    // field it is reading, and must not repeat the old circular sentence.
    assert.doesNotMatch(result.error ?? '', /action\.error/u)
    assert.notEqual(
      result.error,
      'the city could not complete this action because its primitive failed; correct the primitive refusal shown in action.error before retrying',
    )
  })

  test('extra caller JSON cannot inject a forged law program', async () => {
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 110 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/WITH RECURSIVE ancestry/.test(text)) {
        return [{ trait_id: 8, name: 'war-zone', recipe: {}, source_place_id: 2, position: 0 }]
      }
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 210 }]
      return []
    })
    const forged = {
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'use',
      placeId: 2,
      target: { type: 'thing', id: 42 },
      programs: [{
        sourceTraitId: 8,
        lawSourcePlaceId: 2,
        effects: [{ effect: 'destroy', target: 'target' }],
      }],
    } as unknown as ActionInput
    const result = await runAction(forged, db)
    assert.equal(result.status, 'noop')
    assert.equal(result.error, null)
    const resolution = calls.find(call => /INSERT INTO action_resolutions/.test(call.text))
    assert.ok(resolution)
    assert.equal(Object.hasOwn(JSON.parse(String(resolution.values.at(-2))), 'error'), false)
    assert.equal(calls.some(call => /UPDATE things SET withdrawn_at/.test(call.text)), false)
  })

}
