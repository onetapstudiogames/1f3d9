import assert from 'node:assert/strict'
import test from 'node:test'

import { EngineError, type TaggedSql } from '../src/engine.ts'
import {
  executeEffectsWithOutcome,
  type EffectExecutionContext,
} from '../src/engine-effects.ts'

const baseContext: EffectExecutionContext = Object.freeze({
  actionId: 101,
  actorId: 7,
  actorHandle: 'tiny-lantern',
  placeId: 2,
  sourceThingId: 41,
  sharedSourceThingId: null,
  target: { type: 'thing' as const, id: 41 },
  destinationPlaceId: null,
  recipientId: null,
  sourceTraitId: 9,
  sourceTraitName: 'late-law',
  lawAuthority: { traitId: 9, sourcePlaceId: 3 },
  originThingId: null,
  originPlaceId: 3,
  parentEffectId: null,
  generation: 0,
  logicalAt: new Date('2026-09-19T00:00:00.000Z'),
  sameUseDestroySkip: true,
  destroyedThingIds: [41],
})

test('direct and aliased later effects skip only the thing destroyed in this use', async () => {
  let calls = 0
  const db = (async () => {
    calls += 1
    throw new Error('a same-use destroyed target must not reach the database')
  }) as TaggedSql

  for (const target of ['source', 'target'] as const) {
    const outcome = await executeEffectsWithOutcome(
      [{ effect: 'label', target, label: 'too-late' }],
      baseContext,
      db,
    )
    assert.equal(outcome.effectsApplied, 0)
    assert.deepEqual(outcome.skippedEffects, [{
      effect: 'label',
      target,
      sourceTrait: 'late-law',
      sourceTraitId: 9,
      sourcePlaceId: 3,
      reason: 'target thing was destroyed earlier in this use',
    }])
  }
  assert.equal(calls, 0)
})

test('a nested later effect keeps the destroyed-target state', async () => {
  let insertedLabel = false
  const db = (async (strings: TemplateStringsArray) => {
    const sql = strings.join('$').replace(/\s+/gu, ' ').trim()
    if (/SELECT EXISTS \(SELECT 1 FROM places/u.test(sql)) return [{ exists: true }]
    if (/WITH RECURSIVE ancestry/u.test(sql)) return []
    if (/FROM active_labels/u.test(sql)) return [{ present: true }]
    if (/INSERT INTO active_labels/u.test(sql)) {
      insertedLabel = true
      return [{ id: 1 }]
    }
    return []
  }) as TaggedSql

  const outcome = await executeEffectsWithOutcome([{
    effect: 'check_label',
    target: 'place',
    label: 'armed',
    then: [{ effect: 'label', target: 'source', label: 'too-late' }],
  }], baseContext, db)

  assert.equal(outcome.effectsApplied, 0)
  assert.equal(insertedLabel, false)
  assert.deepEqual((outcome.skippedEffects ?? []).map(effect => effect.effect), ['label'])
})

test('a different missing thing still refuses normally', async () => {
  const db = (async (strings: TemplateStringsArray) => {
    const sql = strings.join('$').replace(/\s+/gu, ' ').trim()
    if (/SELECT EXISTS \( SELECT 1 FROM things/u.test(sql)) return [{ exists: false }]
    return []
  }) as TaggedSql

  await assert.rejects(
    executeEffectsWithOutcome(
      [{ effect: 'label', target: 'target', label: 'missing' }],
      { ...baseContext, target: { type: 'thing', id: 42 } },
      db,
    ),
    (error: unknown) => (
      error instanceof EngineError
      && error.status === 404
      && error.message === 'thing target was not found; choose a current public target before retrying'
    ),
  )
})
