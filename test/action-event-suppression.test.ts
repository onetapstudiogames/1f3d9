import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { EngineError, runAction, type TaggedSql } from '../src/engine.ts'
import {
  executeEffects,
  executeEffectsWithOutcome,
  type EffectExecutionContext,
} from '../src/engine-effects.ts'
import { MAX_EFFECT_GENERATIONS } from '../src/physics.ts'

interface Call {
  readonly text: string
  readonly values: readonly unknown[]
}

type Responder = (call: Call) => unknown[] | Promise<unknown[]>

function fakeSql(responder: Responder): { db: TaggedSql; calls: Call[] } {
  const calls: Call[] = []
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = {
      text: strings.join('$').replace(/\s+/gu, ' ').trim(),
      values,
    }
    calls.push(call)
    return responder(call)
  }) as TaggedSql
  return { db, calls }
}

function effectContext(
  overrides: Partial<EffectExecutionContext> = {},
): EffectExecutionContext {
  return {
    actionId: 501,
    actorId: 7,
    actorHandle: 'tiny-lantern',
    placeId: 2,
    sourceThingId: 41,
    sharedSourceThingId: null,
    target: null,
    destinationPlaceId: 3,
    recipientId: 8,
    sourceTraitId: null,
    lawAuthority: null,
    parentEffectId: null,
    generation: 0,
    logicalAt: new Date('2026-08-23T12:00:00.000Z'),
    ...overrides,
  }
}

function availableThing(ownerId = 7, placeId = 2) {
  return {
    id: 41,
    owner_id: ownerId,
    place_id: placeId,
    withdrawn_at: null,
    active_offer_id: null,
    has_open_offer: false,
    open_to_use: false,
  }
}

function actionResolution(calls: readonly Call[]): Call {
  const call = calls.find(candidate => /INSERT INTO action_resolutions/u.test(candidate.text))
  assert.ok(call, 'the action resolution must still be inserted')
  return call
}

function baseResponder(call: Call): unknown[] {
  if (/FROM resident_presence/u.test(call.text)) {
    return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
  }
  if (/INSERT INTO action_runs/u.test(call.text)) return [{ id: 501 }]
  if (/FROM active_blocks/u.test(call.text)) return [{ blocked: false }]
  if (/WITH RECURSIVE ancestry/u.test(call.text)) return []
  if (/INSERT INTO action_resolutions/u.test(call.text)) return [{ id: 601 }]
  return []
}

test('a caller-guaranteed typed event suppresses only the successful bare action event', async () => {
  const successful = fakeSql(baseResponder)
  const applied = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'talk',
    placeId: 2,
    primitiveHandledByCaller: true,
    primitiveEmitsTypedEvent: true,
    performPrimitive: async transaction => {
      await transaction`INSERT INTO events (kind) VALUES ('note')`
    },
  }, successful.db)

  assert.equal(applied.status, 'applied')
  const successfulResolution = actionResolution(successful.calls)
  assert.equal(successfulResolution.values.at(-1), false)
  assert.match(successfulResolution.text, /SELECT resolution\.id FROM resolution/u)

  const failed = fakeSql(baseResponder)
  const rejected = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'talk',
    placeId: 2,
    primitiveHandledByCaller: true,
    primitiveEmitsTypedEvent: true,
    performPrimitive: async () => {
      throw new EngineError(429, 'daily primitive quota reached')
    },
  }, failed.db)

  assert.equal(rejected.status, 'failed')
  assert.equal(actionResolution(failed.calls).values.at(-1), true)
})

test('a caller-handled primitive without an event guarantee keeps its bare action event', async () => {
  const { db, calls } = fakeSql(baseResponder)
  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'talk',
    placeId: 2,
    primitiveHandledByCaller: true,
    performPrimitive: async () => {},
  }, db)

  assert.equal(result.status, 'applied')
  assert.equal(actionResolution(calls).values.at(-1), true)
})

test('consume relies on its guaranteed thing_withdrawn event instead of a bare action event', async () => {
  const { db, calls } = fakeSql(call => {
    if (/SELECT thing\.id/u.test(call.text)) {
      return [{
        id: 41,
        owner_id: 7,
        place_id: 2,
        withdrawn_at: null,
        active_offer_id: null,
        has_open_offer: false,
      }]
    }
    if (/FROM kind_revision_traits/u.test(call.text)) return []
    if (/UPDATE things SET withdrawn_at/u.test(call.text)) return [{ id: 41 }]
    return baseResponder(call)
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'consume',
    placeId: 2,
    sourceThingId: 41,
  }, db)

  assert.equal(result.status, 'applied')
  assert.ok(calls.some(call => /'thing_withdrawn'/u.test(call.text)))
  assert.equal(actionResolution(calls).values.at(-1), false)
})

test('a typed effect outcome suppresses the bare action event', async () => {
  const { db, calls } = fakeSql(call => {
    if (/SELECT thing\.id/u.test(call.text)) {
      return [{
        id: 41,
        owner_id: 7,
        place_id: 2,
        withdrawn_at: null,
        active_offer_id: null,
        has_open_offer: false,
      }]
    }
    if (/JOIN kind_revision_traits/u.test(call.text)) {
      return [{
        trait_id: 9,
        recipe: { use: [{ effect: 'destroy', target: 'source' }] },
      }]
    }
    if (/UPDATE things SET withdrawn_at/u.test(call.text)) return [{ id: 41 }]
    return baseResponder(call)
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
    sourceThingId: 41,
  }, db)

  assert.equal(result.status, 'applied')
  assert.ok(calls.some(call => /'thing_withdrawn'/u.test(call.text)))
  assert.equal(actionResolution(calls).values.at(-1), false)
})

for (const [recipientId, expectedPublicActionEvent] of [[8, false], [7, true]] as const) {
  test(`give to resident ${recipientId} ${expectedPublicActionEvent ? 'keeps' : 'suppresses'} the bare action event`, async () => {
    const { db, calls } = fakeSql(call => {
      if (/SELECT thing\.id/u.test(call.text)) {
        return [{
          id: 41,
          owner_id: 7,
          place_id: 2,
          withdrawn_at: null,
          active_offer_id: null,
          has_open_offer: false,
        }]
      }
      if (/FROM kind_revision_traits/u.test(call.text)) return []
      if (/SELECT EXISTS/u.test(call.text) && /FROM things/u.test(call.text)) {
        return [{ exists: true }]
      }
      if (/INSERT INTO transfers/u.test(call.text)) return [{ id: 701 }]
      return baseResponder(call)
    })

    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'give',
      placeId: 2,
      sourceThingId: 41,
      recipientId,
    }, db)

    assert.equal(result.status, 'applied')
    assert.equal(calls.some(call => /INSERT INTO transfers/u.test(call.text)), recipientId !== 7)
    assert.equal(actionResolution(calls).values.at(-1), expectedPublicActionEvent)
  })
}

for (const action of ['use', 'move', 'go_home'] as const) {
  test(`${action} keeps its bare action event`, async () => {
    const { db, calls } = fakeSql(call => {
      if (/SELECT id, parent_id FROM places/u.test(call.text)) {
        return [{ id: 2, parent_id: 1 }, { id: 4, parent_id: 2 }]
      }
      if (/UPDATE resident_presence SET current_place_id/u.test(call.text)) {
        return [{ resident_id: 7, current_place_id: 4, home_place_id: 3, updated_at: 'now' }]
      }
      if (/WITH first_owned/u.test(call.text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/UPDATE resident_presence presence/u.test(call.text)) {
        return [{ resident_id: 7, current_place_id: 3, home_place_id: 3, updated_at: 'now' }]
      }
      return baseResponder(call)
    })

    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action,
      placeId: action === 'go_home' ? null : 2,
      destinationPlaceId: action === 'move' ? 4 : null,
    }, db)

    assert.equal(result.status, action === 'use' ? 'noop' : 'applied')
    const resolution = actionResolution(calls)
    assert.equal(resolution.values.at(-1), true)
    const publicDetail = JSON.parse(String(resolution.values.at(-2))) as Record<string, unknown>
    assert.equal(publicDetail.action, action)
    if (action === 'move') {
      assert.deepEqual(publicDetail, {
        action_id: 501,
        action: 'move',
        status: 'applied',
        effects_applied: 0,
        from_place_id: 2,
        to_place_id: 4,
      })
    } else {
      assert.equal(Object.hasOwn(publicDetail, 'from_place_id'), false)
      assert.equal(Object.hasOwn(publicDetail, 'to_place_id'), false)
    }
  })
}

test('destroy reports the typed thing_withdrawn event it inserts', async () => {
  const { db } = fakeSql(call => {
    if (/SELECT thing\.id/u.test(call.text)) return [availableThing()]
    if (/UPDATE things SET withdrawn_at/u.test(call.text)) return [{ id: 41 }]
    return []
  })

  const outcome = await executeEffectsWithOutcome([
    { effect: 'destroy', target: 'source' },
  ], effectContext(), db)

  assert.deepEqual(outcome, {
    effectsApplied: 1,
    emittedTypedPublicEvent: true,
  })
  assert.equal(Object.isFrozen(outcome), true)
})

test('thing move reports an event only when the thing actually changes places', async () => {
  const moving = fakeSql(call => {
    if (/SELECT EXISTS/u.test(call.text) && /FROM things/u.test(call.text)) {
      return [{ exists: true }]
    }
    if (/SELECT thing\.id/u.test(call.text)) return [availableThing()]
    if (/WHERE place\.id = ANY/u.test(call.text)) {
      return [
        { id: 2, parent_id: 1, owner_id: 7, open_to_things: false, place_permits_things: true },
        { id: 3, parent_id: 2, owner_id: 7, open_to_things: false, place_permits_things: true },
      ]
    }
    if (/WITH moved AS/u.test(call.text)) return [{ id: 41 }]
    return []
  })
  const moved = await executeEffectsWithOutcome([
    { effect: 'move', target: 'source', to: 'destination' },
  ], effectContext(), moving.db)

  assert.deepEqual(moved, {
    effectsApplied: 1,
    emittedTypedPublicEvent: true,
  })
  assert.ok(moving.calls.some(call => /'thing_moved'/u.test(call.text)))

  const stationary = fakeSql(call => {
    if (/SELECT EXISTS/u.test(call.text) && /FROM things/u.test(call.text)) {
      return [{ exists: true }]
    }
    if (/SELECT thing\.id/u.test(call.text)) return [availableThing(7, 3)]
    return []
  })
  const unchanged = await executeEffectsWithOutcome([
    { effect: 'move', target: 'source', to: 'destination' },
  ], effectContext(), stationary.db)

  assert.deepEqual(unchanged, {
    effectsApplied: 1,
    emittedTypedPublicEvent: false,
  })
  assert.equal(stationary.calls.some(call => /'thing_moved'/u.test(call.text)), false)
})

test('resident move does not claim a typed public event', async () => {
  const { db } = fakeSql(call => {
    if (/SELECT EXISTS/u.test(call.text) && /FROM residents/u.test(call.text)) {
      return [{ exists: true }]
    }
    if (/FROM resident_presence/u.test(call.text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/SELECT id, parent_id FROM places/u.test(call.text)) {
      return [{ id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }]
    }
    if (/UPDATE resident_presence SET current_place_id/u.test(call.text)) {
      return [{ resident_id: 7, current_place_id: 3, home_place_id: 3, updated_at: 'now' }]
    }
    return []
  })

  const outcome = await executeEffectsWithOutcome([
    { effect: 'move', target: 'actor', to: 'destination' },
  ], effectContext(), db)

  assert.deepEqual(outcome, {
    effectsApplied: 1,
    emittedTypedPublicEvent: false,
  })
})

for (const [recipientId, expectedTypedEvent] of [[8, true], [7, false]] as const) {
  test(`effect transfer to resident ${recipientId} reports typed event ${expectedTypedEvent}`, async () => {
    const { db, calls } = fakeSql(call => {
      if (/SELECT EXISTS/u.test(call.text) && /FROM things/u.test(call.text)) {
        return [{ exists: true }]
      }
      if (/INSERT INTO transfers/u.test(call.text)) return [{ id: 701 }]
      return []
    })

    const outcome = await executeEffectsWithOutcome([
      { effect: 'transfer', target: 'source', to: 'recipient' },
    ], effectContext({ recipientId }), db)

    assert.deepEqual(outcome, {
      effectsApplied: 1,
      emittedTypedPublicEvent: expectedTypedEvent,
    })
    assert.equal(calls.some(call => /INSERT INTO transfers/u.test(call.text)), recipientId !== 7)
  })
}

test('transfer refusal addresses the caller instead of leaking actor vocabulary', async () => {
  const { db } = fakeSql(call => {
    if (/SELECT EXISTS/u.test(call.text) && /FROM things/u.test(call.text)) {
      return [{ exists: true }]
    }
    if (/INSERT INTO transfers/u.test(call.text)) return []
    if (/SELECT thing\.id/u.test(call.text)) return [availableThing(9)]
    return []
  })

  await assert.rejects(
    executeEffectsWithOutcome([
      { effect: 'transfer', target: 'source', to: 'recipient' },
    ], effectContext(), db),
    (error: unknown) => (
      error instanceof EngineError
      && error.status === 403
      && error.message === 'you cannot transfer this asset'
    ),
  )
})

test('wait reports effect_scheduled when it inserts a pending effect', async () => {
  const { db, calls } = fakeSql(call => {
    if (/AS place_pending/u.test(call.text)) {
      return [{ place_pending: 0, actor_pending: 0 }]
    }
    if (/INSERT INTO pending_effects/u.test(call.text)) return [{ id: 801 }]
    return []
  })

  const outcome = await executeEffectsWithOutcome([
    { effect: 'wait', seconds: 60, then: [] },
  ], effectContext(), db)

  assert.deepEqual(outcome, {
    effectsApplied: 1,
    emittedTypedPublicEvent: true,
  })
  assert.ok(calls.some(call => /'effect_scheduled'/u.test(call.text)))
})

test('wait does not report an event when the generation cap prevents scheduling', async () => {
  const { db, calls } = fakeSql(() => [])

  const outcome = await executeEffectsWithOutcome([
    { effect: 'wait', seconds: 60, then: [] },
  ], effectContext({
    parentEffectId: 801,
    generation: MAX_EFFECT_GENERATIONS,
  }), db)

  assert.deepEqual(outcome, {
    effectsApplied: 0,
    emittedTypedPublicEvent: false,
  })
  assert.equal(calls.length, 0)
})

test('check_label combines nested counts and typed-event outcomes', async () => {
  const { db } = fakeSql(call => {
    if (/SELECT EXISTS/u.test(call.text) && /FROM things/u.test(call.text)) {
      return [{ exists: true }]
    }
    if (/AS present/u.test(call.text)) return [{ present: true }]
    if (/INSERT INTO active_labels/u.test(call.text)) return [{ id: 901 }]
    if (/AS place_pending/u.test(call.text)) {
      return [{ place_pending: 0, actor_pending: 0 }]
    }
    if (/INSERT INTO pending_effects/u.test(call.text)) return [{ id: 902 }]
    return []
  })

  const outcome = await executeEffectsWithOutcome([{
    effect: 'check_label',
    target: 'source',
    label: 'ready',
    then: [
      { effect: 'label', target: 'source', label: 'checked' },
      { effect: 'wait', seconds: 60, then: [] },
    ],
  }], effectContext(), db)

  assert.deepEqual(outcome, {
    effectsApplied: 2,
    emittedTypedPublicEvent: true,
  })
})

test('check_label carries a typed-event outcome from its else branch', async () => {
  const { db } = fakeSql(call => {
    if (/SELECT EXISTS/u.test(call.text) && /FROM things/u.test(call.text)) {
      return [{ exists: true }]
    }
    if (/AS present/u.test(call.text)) return [{ present: false }]
    if (/AS place_pending/u.test(call.text)) {
      return [{ place_pending: 0, actor_pending: 0 }]
    }
    if (/INSERT INTO pending_effects/u.test(call.text)) return [{ id: 903 }]
    return []
  })

  const outcome = await executeEffectsWithOutcome([{
    effect: 'check_label',
    target: 'source',
    label: 'missing',
    then: [],
    else: [{ effect: 'wait', seconds: 60, then: [] }],
  }], effectContext(), db)

  assert.deepEqual(outcome, {
    effectsApplied: 1,
    emittedTypedPublicEvent: true,
  })
})

test('legacy executeEffects callers still receive only the applied count', async () => {
  const { db } = fakeSql(call => {
    if (/SELECT EXISTS/u.test(call.text) && /FROM things/u.test(call.text)) {
      return [{ exists: true }]
    }
    if (/INSERT INTO active_labels/u.test(call.text)) return [{ id: 904 }]
    return []
  })

  const applied = await executeEffects([
    { effect: 'label', target: 'source', label: 'legacy' },
  ], effectContext(), db)

  assert.equal(applied, 1)
  assert.equal(typeof applied, 'number')
})

test('all caller primitives that insert typed events declare the suppression guarantee', async () => {
  const [noteAction, thingMaking, society] = await Promise.all([
    readFile(new URL('../src/note-action.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/thing-making.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/society.ts', import.meta.url), 'utf8'),
  ])

  assert.equal(noteAction.match(/primitiveEmitsTypedEvent:\s*true/gu)?.length, 1)
  assert.equal(thingMaking.match(/primitiveEmitsTypedEvent:\s*true/gu)?.length, 2)
  assert.equal(society.match(/primitiveEmitsTypedEvent:\s*true/gu)?.length, 2)
})
