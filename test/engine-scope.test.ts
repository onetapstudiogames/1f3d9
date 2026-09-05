import test from 'node:test'
import assert from 'node:assert/strict'

import { EngineError, runAction, type RuntimeTarget, type TaggedSql } from '../src/engine.ts'
import { requireResidentAtActionPlace } from '../src/engine-target-scope.ts'
import type { Effect } from '../src/physics.ts'

interface Call {
  readonly text: string
  readonly values: readonly unknown[]
}

function scopedTargetDb(effect: Effect, target: RuntimeTarget) {
  const calls: Call[] = []
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$').replace(/\s+/gu, ' ').trim()
    calls.push({ text, values })
    if (/SELECT current_place_id FROM resident_presence/u.test(text)) {
      return [{ current_place_id: 3 }]
    }
    if (/FROM resident_presence/u.test(text)) {
      return [{
        resident_id: 7,
        current_place_id: 2,
        home_place_id: 2,
        updated_at: new Date('2026-08-11T00:00:00.000Z'),
      }]
    }
    if (/INSERT INTO action_runs/u.test(text)) return [{ id: 120 }]
    if (/FROM active_blocks/u.test(text)) return [{ blocked: false }]
    if (/WITH RECURSIVE ancestry/u.test(text)) return [{
      trait_id: 14,
      name: 'local-only',
      recipe: { use: [effect] },
      source_place_id: 2,
      position: 0,
    }]
    if (/SELECT EXISTS/u.test(text)) return [{ exists: true }]
    if (/SELECT place_id, withdrawn_at FROM things/u.test(text)) {
      return [{ place_id: 3, withdrawn_at: null }]
    }
    if (/SELECT owner_id FROM kinds/u.test(text)) return [{ owner_id: 8 }]
    if (/INSERT INTO active_labels|INSERT INTO active_blocks/u.test(text)) return [{ id: 301 }]
    if (/FROM active_labels/u.test(text)) return [{ present: false }]
    if (/INSERT INTO action_resolutions/u.test(text)) return [{ id: 220 }]
    return []
  }) as TaggedSql
  return { db, calls }
}

const cases: readonly Readonly<{
  name: string
  target: RuntimeTarget
  effect: Effect
}>[] = [
  {
    name: 'block a remote resident',
    target: { type: 'resident', id: 8 },
    effect: { effect: 'block', target: 'target', action: 'talk', seconds: 30 },
  },
  {
    name: 'label a remote thing',
    target: { type: 'thing', id: 42 },
    effect: { effect: 'label', target: 'target', label: 'marked' },
  },
  {
    name: 'label another resident kind',
    target: { type: 'kind', id: 9 },
    effect: { effect: 'label', target: 'target', label: 'marked' },
  },
  {
    name: 'check a remote place label',
    target: { type: 'place', id: 9 },
    effect: { effect: 'check_label', target: 'target', label: 'open', then: [] },
  },
]

for (const entry of cases) {
  test(`caller target cannot ${entry.name}`, async () => {
    const { db, calls } = scopedTargetDb(entry.effect, entry.target)
    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'use',
      placeId: 2,
      target: entry.target,
    }, db)

    assert.equal(result.status, 'failed')
    assert.equal(result.httpStatus, 403)
    assert.equal(calls.some(call => /INSERT INTO active_labels|INSERT INTO active_blocks/u.test(call.text)), false)
  })
}

test('a resident with no current place is out of scope rather than a database failure', async () => {
  const db = (async () => [{ current_place_id: null }]) as TaggedSql
  await assert.rejects(requireResidentAtActionPlace(8, 2, db), (error: unknown) => (
    error instanceof EngineError
    && error.status === 403
    && error.message ===
      'target resident must be standing in place_id 2; target current place_id is unset'
  ))
})
