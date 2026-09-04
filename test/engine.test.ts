import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CommitOutcomeUnknownError,
  EngineError,
  MAX_PENDING_EFFECTS_PER_ACTOR,
  MAX_PENDING_EFFECTS_PER_PLACE,
  UNCONFIRMED_ACTION_ERROR,
  effectiveLaws,
  ensurePresence,
  isActionBlocked,
  moveResident,
  resolveDueEffects,
  resolveSymbolicTarget,
  runAction,
  setEngineTransactionRunnerForTests,
  setHome,
  withEngineTransaction,
  type ActionInput,
  type TaggedSql,
} from '../src/engine.ts'
import { COLLISION_CONFLICT_MESSAGE } from '../src/core.ts'
import {
  executeEffects,
  type EffectExecutionContext,
} from '../src/engine-effects.ts'
import { BLOCKABLE_ACTIONS } from '../src/physics.ts'

interface Call {
  text: string
  values: unknown[]
}

type Responder = (call: Call) => unknown[] | Promise<unknown[]>

function fakeSql(responder: Responder): { db: TaggedSql; calls: Call[] } {
  const calls: Call[] = []
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim()
    const call = { text, values }
    calls.push(call)
    return responder(call)
  }) as TaggedSql
  return { db, calls }
}

test('effective laws stop when ancestry crosses an ownership boundary', async () => {
  const { db, calls } = fakeSql(() => [{
    trait_id: 8,
    name: 'war-zone',
    recipe: { use: [] },
    source_place_id: 4,
    position: 0,
  }])

  assert.deepEqual(await effectiveLaws(9, db), [{
    traitId: 8,
    name: 'war-zone',
    recipe: { use: [] },
    sourcePlaceId: 4,
    position: 0,
  }])
  assert.match(calls[0]?.text ?? '', /WITH RECURSIVE ancestry/i)
  assert.match(calls[0]?.text ?? '', /parent\.owner_id = ancestry\.sovereign_owner/i)
})

test('the nearest adoption wins when one trait appears at multiple owned levels', async () => {
  const { db } = fakeSql(() => [
    { trait_id: 8, name: 'war-zone', recipe: {}, source_place_id: 9, position: 0 },
    { trait_id: 8, name: 'war-zone', recipe: {}, source_place_id: 4, position: 1 },
  ])
  assert.deepEqual((await effectiveLaws(9, db)).map(law => law.sourcePlaceId), [9])
})

test('go_home can never be blocked and does not touch the block table', async () => {
  const { db, calls } = fakeSql(() => {
    throw new Error('go_home must not query')
  })
  assert.equal(await isActionBlocked(7, 'go_home', db), false)
  assert.equal(calls.length, 0)
})

test('a live basic-action block is enforced', async () => {
  const { db } = fakeSql(() => [{
    blocked: true,
    source_trait_id: 12,
    trait_name: 'heavy-air',
    source_place_id: 2,
    source_thing_id: null,
  }])
  assert.equal(await isActionBlocked(7, 'move', db), true)
})

test('presence initializes current place and home from the resident first owned place', async () => {
  const { db, calls } = fakeSql(() => [{
    resident_id: 7,
    current_place_id: 2,
    home_place_id: 2,
    updated_at: '2026-08-11T00:00:00.000Z',
  }])

  assert.deepEqual(await ensurePresence(7, db), {
    residentId: 7,
    currentPlaceId: 2,
    homePlaceId: 2,
    updatedAt: '2026-08-11T00:00:00.000Z',
  })
  assert.match(calls[0]?.text ?? '', /ON CONFLICT \(resident_id\) DO UPDATE/i)
  assert.match(calls[0]?.text ?? '', /COALESCE/i)
})

test('home can only be set to land the resident owns', async () => {
  const denied = fakeSql(() => [])
  await assert.rejects(setHome(7, 12, denied.db), (error: unknown) => (
    error instanceof EngineError
    && error.status === 403
    && error.message === 'home must be the owned place where you are standing'
  ))

  const allowed = fakeSql(() => [{
    resident_id: 7,
    current_place_id: 2,
    home_place_id: 12,
    updated_at: '2026-08-11T00:00:00.000Z',
  }])
  assert.equal((await setHome(7, 12, allowed.db)).homePlaceId, 12)
})

test('ordinary resident movement only crosses one parent-child edge', async () => {
  const denied = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) return [{ current_place_id: 2, home_place_id: 3 }]
    if (/FROM places/.test(text)) return [{ id: 9, parent_id: 8 }]
    return []
  })
  await assert.rejects(moveResident(7, 9, denied.db), (error: unknown) => (
    error instanceof EngineError
    && error.status === 403
    && error.message === 'place_id 9 exists, but entry is closed from your current place_id 2; entry opens when you stand in its parent or one of its direct children, so use the public map outline to move one parent-child edge at a time'
  ))
  assert.equal(denied.calls.some(call => /UPDATE resident_presence/.test(call.text)), false)

  const allowed = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) return [{ current_place_id: 2, home_place_id: 3 }]
    if (/FROM places/.test(text)) {
      return [{ id: 9, parent_id: 2 }]
    }
    if (/UPDATE resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 9, home_place_id: 3, updated_at: 'now' }]
    }
    return []
  })
  assert.equal((await moveResident(7, 9, allowed.db)).currentPlaceId, 9)
  const destinationRead = allowed.calls.find(call => /FROM places/.test(call.text))
  assert.match(destinationRead?.text ?? '', /FOR SHARE/iu)
})

test('ordinary movement refuses a retired destination in caller words before moving', async () => {
  const retired = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) return [{ current_place_id: 2, home_place_id: 3 }]
    if (/FROM places/.test(text)) return [
      { id: 2, parent_id: 1, retired_at: null },
      { id: 9, parent_id: 2, retired_at: '2026-09-01T00:00:00Z' },
    ]
    return []
  })

  await assert.rejects(moveResident(7, 9, retired.db), (error: unknown) => (
    error instanceof EngineError
    && error.status === 409
    && error.message === 'destination place is retired; restore it before moving there'
  ))
  assert.equal(retired.calls.some(call => /UPDATE resident_presence/.test(call.text)), false)
})

test('a missing movement destination points back to the current public outline', async () => {
  const missing = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/FROM places/.test(text)) return [{ id: 2, parent_id: 1 }]
    return []
  })
  await assert.rejects(moveResident(7, 9, missing.db), (error: unknown) => (
    error instanceof EngineError
    && error.status === 404
    && error.message === 'destination place_id 9 was not found; use GET /api/map?view=outline&parent_id=2 to choose a public adjacent destination'
  ))
})

test('symbolic targets never accept recipe-authored database ids', () => {
  const context = {
    actorId: 7,
    placeId: 2,
    sourceThingId: 41,
    target: { type: 'thing' as const, id: 42 },
  }
  assert.deepEqual(resolveSymbolicTarget('actor', context), { type: 'resident', id: 7 })
  assert.deepEqual(resolveSymbolicTarget('source', context), { type: 'thing', id: 41 })
  assert.deepEqual(resolveSymbolicTarget('target', context), { type: 'thing', id: 42 })
  assert.deepEqual(resolveSymbolicTarget('place', context), { type: 'place', id: 2 })
})

test('a blocked action is durably recorded without running effects', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 101 }]
    if (/FROM active_blocks/.test(text)) return [{
      blocked: true,
      source_trait_id: 12,
      trait_name: 'heavy-air',
      source_place_id: null,
      source_thing_id: 41,
    }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 201 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
    sourceThingId: 41,
  }, db)

  assert.equal(result.status, 'blocked')
  assert.equal(result.httpStatus, 403)
  assert.equal(
    result.error,
    'use is temporarily blocked by thing trait "heavy-air" from thing_id 41',
  )
  assert.equal(calls.some(call => /INSERT INTO active_labels/.test(call.text)), false)
  assert.equal(calls.some(call => /INSERT INTO action_resolutions/.test(call.text)), true)
})

test('a removed blocking trait uses an unavailable-name fallback without leaking its name', async () => {
  const removedName = 'removed-law-name'
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 403 }]
    if (/FROM active_blocks/.test(text)) {
      assert.match(text, /FROM moderation_actions/u)
      return [{
        blocked: true,
        source_trait_id: 14,
        trait_name: null,
        source_place_id: 2,
        source_thing_id: null,
        law_source_matches_trait: true,
      }]
    }
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 503 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'talk',
    placeId: 2,
  }, db)

  assert.equal(result.status, 'blocked')
  assert.equal(
    result.error,
    'talk is temporarily blocked by law trait_id 14 from place_id 2; its name is unavailable',
  )
  const resolution = calls.find(call => /INSERT INTO action_resolutions/.test(call.text))
  assert.ok(resolution)
  assert.doesNotMatch(JSON.stringify(resolution.values), new RegExp(removedName, 'u'))
})

for (const action of BLOCKABLE_ACTIONS) {
  test(`${action} names the law and source place that block it`, async () => {
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 401 }]
      if (/FROM active_blocks/.test(text)) return [{
        blocked: true,
        source_trait_id: 13,
        trait_name: 'quiet-hours',
        source_place_id: 2,
        source_thing_id: null,
        law_source_matches_trait: true,
      }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 501 }]
      return []
    })

    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action,
      placeId: 2,
    }, db)

    assert.equal(result.status, 'blocked')
    assert.equal(result.httpStatus, 403)
    assert.equal(
      result.error,
      `${action} is temporarily blocked by law "quiet-hours" from place_id 2`,
    )
    const resolution = calls.find(call => /INSERT INTO action_resolutions/.test(call.text))
    assert.ok(resolution)
    assert.equal(
      String(resolution.values[2]),
      JSON.stringify({
        error: `${action} is temporarily blocked by law trait_id 13 from place_id 2`,
        trait_id: 13,
        trait: 'quiet-hours',
        source_place_id: 2,
      }),
    )
    assert.equal(
      String(resolution.values.at(-2)),
      JSON.stringify({
        action_id: 401,
        action,
        status: 'blocked',
        error: `${action} is temporarily blocked by law trait_id 13 from place_id 2`,
        trait_id: 13,
        trait: 'quiet-hours',
        source_place_id: 2,
      }),
    )
  })
}

test('go_home failure names the missing usable home', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 402 }]
    if (/WITH first_owned/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: null, updated_at: 'now' }]
    }
    if (/FROM resident_presence[\s\S]*FOR UPDATE/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: null, updated_at: 'now' }]
    }
    if (/UPDATE resident_presence presence/.test(text)) return []
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 502 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'go_home',
  }, db)

  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 409)
  const expectedError = 'home is unset or no longer owned; move normally or claim an owned home before using go_home'
  assert.equal(result.error, expectedError)
  const resolution = calls.find(call => /INSERT INTO action_resolutions/.test(call.text))
  assert.ok(resolution)
  assert.equal(
    (JSON.parse(String(resolution.values.at(-2))) as { error?: string }).error,
    expectedError,
  )
})

test('label and check_label bricks compose in order', async () => {
  const labels = new Set<string>()
  const { db, calls } = fakeSql(({ text, values }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 102 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) {
      return [{ id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null }]
    }
    if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
      trait_id: 8,
      recipe: { use: [
        { effect: 'label', target: 'actor', label: 'lit' },
        {
          effect: 'check_label', target: 'actor', label: 'lit',
          then: [{ effect: 'block', target: 'actor', action: 'talk', seconds: 30 }],
        },
      ] },
    }]
    if (/SELECT EXISTS/.test(text) && /FROM residents/.test(text)) return [{ exists: true }]
    if (/INSERT INTO active_labels/.test(text)) {
      labels.add(String(values[2]))
      return [{ id: 301 }]
    }
    if (/FROM active_labels/.test(text)) return [{ present: labels.has(String(values[2])) }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 202 }]
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
  assert.equal(calls.some(call => /INSERT INTO active_blocks/.test(call.text)), true)
})

test('check_label freezes a thing origin before adopting a matched law authority', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/WITH RECURSIVE ancestry/.test(text)) return [{
      trait_id: 22,
      name: 'gate-law',
      recipe: null,
      source_place_id: 2,
      position: 0,
    }]
    if (/SELECT EXISTS/.test(text) && /FROM (?:residents|places)/.test(text)) {
      return [{ exists: true }]
    }
    if (/INSERT INTO active_blocks/.test(text)) return [{ id: 900 }]
    return []
  })
  const context: EffectExecutionContext = {
    actionId: 600,
    actorId: 7,
    actorHandle: 'tiny-lantern',
    placeId: 2,
    sourceThingId: 41,
    sharedSourceThingId: null,
    target: null,
    destinationPlaceId: null,
    recipientId: null,
    sourceTraitId: 21,
    lawAuthority: null,
    parentEffectId: null,
    generation: 0,
    logicalAt: new Date('2026-08-11T00:00:00.000Z'),
  }

  assert.equal(await executeEffects([{
    effect: 'check_label',
    target: 'place',
    label: 'gate-law',
    then: [{ effect: 'block', target: 'actor', action: 'move', seconds: 60 }],
  }], context, db), 1)

  const inserted = calls.find(call => /INSERT INTO active_blocks/.test(call.text))
  assert.ok(inserted)
  assert.deepEqual(inserted.values.slice(3, 6), [21, null, 41])
})

test('a delayed check_label law branch preserves its frozen thing origin in the payload', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/WITH RECURSIVE ancestry/.test(text)) return [{
      trait_id: 22,
      name: 'gate-law',
      recipe: null,
      source_place_id: 2,
      position: 0,
    }]
    if (/SELECT EXISTS/.test(text) && /FROM places/.test(text)) return [{ exists: true }]
    if (/pg_advisory_xact_lock/.test(text)) return []
    if (/AS place_pending/.test(text)) return [{ place_pending: 0, actor_pending: 0 }]
    if (/INSERT INTO pending_effects/.test(text)) return [{ id: 901 }]
    return []
  })
  const context: EffectExecutionContext = {
    actionId: 601,
    actorId: 7,
    actorHandle: 'tiny-lantern',
    placeId: 2,
    sourceThingId: 41,
    sharedSourceThingId: null,
    target: null,
    destinationPlaceId: null,
    recipientId: null,
    sourceTraitId: 21,
    lawAuthority: null,
    parentEffectId: null,
    generation: 0,
    logicalAt: new Date('2026-08-11T00:00:00.000Z'),
  }

  assert.equal(await executeEffects([{
    effect: 'check_label',
    target: 'place',
    label: 'gate-law',
    then: [{
      effect: 'wait',
      seconds: 60,
      then: [{ effect: 'block', target: 'actor', action: 'move', seconds: 60 }],
    }],
  }], context, db), 1)

  const pending = calls.find(call => /INSERT INTO pending_effects/.test(call.text))
  assert.ok(pending)
  assert.deepEqual(
    JSON.parse(String(pending.values[10])).effect_origin,
    { source_thing_id: 41, source_place_id: null },
  )
})

test('a thing-trait block gated by a different law keeps only the thing provenance', async () => {
  let actionId = 600
  let block: Record<string, unknown> | null = null
  const { db, calls } = fakeSql(({ text, values }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: ++actionId }]
    if (/FROM active_blocks/.test(text)) return block === null ? [{ blocked: false }] : [{
      ...block,
      // Existing rows may carry the unrelated check_label law place.
      source_place_id: 2,
      law_source_matches_trait: false,
    }]
    if (/SELECT thing\.id/.test(text)) {
      return [{
        id: 41,
        owner_id: 7,
        place_id: 2,
        withdrawn_at: null,
        active_offer_id: null,
        has_open_offer: false,
        open_to_use: false,
      }]
    }
    if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
      trait_id: 21,
      recipe: {
        use: [{
          effect: 'check_label',
          target: 'place',
          label: 'gate-law',
          then: [{ effect: 'block', target: 'actor', action: 'move', seconds: 60 }],
        }],
      },
    }]
    if (/WITH RECURSIVE ancestry/.test(text)) return [{
      trait_id: 22,
      name: 'gate-law',
      recipe: null,
      source_place_id: 2,
      position: 0,
    }]
    if (/SELECT EXISTS/.test(text) && /FROM (?:residents|places)/.test(text)) {
      return [{ exists: true }]
    }
    if (/INSERT INTO active_blocks/.test(text)) {
      block = {
        blocked: true,
        source_trait_id: values[3],
        trait_name: 'origin-thing-trait',
        source_place_id: values[4],
        source_thing_id: values[5],
        law_source_matches_trait: false,
      }
      return [{ id: 901 }]
    }
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 902 }]
    return []
  })

  const created = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
    sourceThingId: 41,
  }, db)
  assert.equal(created.status, 'applied')

  const consumed = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'move',
    placeId: 2,
  }, db)
  assert.equal(consumed.status, 'blocked')
  assert.equal(
    consumed.error,
    'move is temporarily blocked by thing trait "origin-thing-trait" from thing_id 41',
  )
  assert.deepEqual(block, {
    blocked: true,
    source_trait_id: 21,
    trait_name: 'origin-thing-trait',
    source_place_id: null,
    source_thing_id: 41,
    law_source_matches_trait: false,
  })
  const inserted = calls.find(call => /INSERT INTO active_blocks/.test(call.text))
  assert.ok(inserted)
  assert.deepEqual(inserted.values.slice(3, 6), [21, null, 41])
})

test('a legacy mixed law block never names an unproven trait and place as one law', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 603 }]
    if (/FROM active_blocks/.test(text)) return [{
      blocked: true,
      source_trait_id: 31,
      trait_name: 'origin-law',
      source_place_id: 99,
      source_thing_id: null,
      law_source_matches_trait: false,
    }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 903 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'talk',
    placeId: 2,
  }, db)

  assert.equal(result.status, 'blocked')
  assert.equal(
    result.error,
    'talk is temporarily blocked by trait "origin-law"; its source is unavailable',
  )
  assert.match(
    calls.find(call => /FROM active_blocks/.test(call.text))?.text ?? '',
    /FROM place_law_changes/u,
  )
  const blockLookup = calls.find(call => /FROM active_blocks/.test(call.text))?.text ?? ''
  assert.match(blockLookup, /active\.created_at/u)
  assert.match(blockLookup, /provenance\.created_at <= block\.created_at/u)
  assert.match(blockLookup, /ORDER BY provenance\.created_at DESC, provenance\.id DESC/u)
  assert.match(blockLookup, /provenance\.change_type = 'add'/u)
  const resolution = calls.find(call => /INSERT INTO action_resolutions/.test(call.text))
  assert.ok(resolution)
  assert.equal(
    String(resolution.values[2]),
    JSON.stringify({
      error: 'talk is temporarily blocked by trait_id 31; its source is unavailable',
      trait_id: 31,
      trait: 'origin-law',
    }),
  )
})

test('foreign property damage fails closed without a currently effective local law', async () => {
  const { db, calls } = fakeSql(({ text, values }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 103 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) {
      return Number(values[0]) === 41
        ? [{ id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null }]
        : [{ id: 42, owner_id: 8, place_id: 2, withdrawn_at: null, active_offer_id: null }]
    }
    if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
      trait_id: 9,
      recipe: { use: [{ effect: 'destroy', target: 'target' }] },
    }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 203 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
    sourceThingId: 41,
    target: { type: 'thing', id: 42 },
  }, db)

  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 403)
  assert.equal(result.error, 'damage to another resident property requires an effective local law')
  assert.equal(calls.some(call => /UPDATE things SET withdrawn_at/.test(call.text)), false)
})

test('an owned destroy race is reported as conflict, not a false law denial', async () => {
  const { db } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 112 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) {
      return [{ id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null }]
    }
    if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
      trait_id: 9,
      recipe: { use: [{ effect: 'destroy', target: 'source' }] },
    }]
    if (/UPDATE things SET withdrawn_at/.test(text)) return []
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 212 }]
    return []
  })
  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
    sourceThingId: 41,
  }, db)
  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 409)
  assert.equal(result.error, 'thing changed before it could be destroyed; re-read the thing before retrying')
})

test('law-authorized damage is rechecked at execution time and stays local', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 104 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) {
      return [{ id: 42, owner_id: 8, place_id: 2, withdrawn_at: null, active_offer_id: null }]
    }
    if (/WITH RECURSIVE ancestry/.test(text)) {
      return [{
        trait_id: 8,
        name: 'war-zone',
        recipe: { use: [{ effect: 'destroy', target: 'target' }] },
        source_place_id: 2,
        position: 0,
      }]
    }
    if (/UPDATE things SET withdrawn_at/.test(text)) return [{ id: 42 }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 204 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
    target: { type: 'thing', id: 42 },
  }, db)

  assert.equal(result.status, 'applied')
  assert.equal(calls.some(call => /UPDATE things SET withdrawn_at/.test(call.text)), true)
  assert.equal(calls.some(call => (
    /WITH RECURSIVE ancestry/.test(call.text)
    && /UPDATE things SET withdrawn_at/.test(call.text)
  )), true)
  assert.equal(calls.some(call => /'thing_withdrawn'/.test(call.text)), true)
})

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

test('go_home ignores supplied source traps and bypasses every block query', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 105 }]
    if (/WITH first_owned/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/FROM resident_presence[\s\S]*FOR UPDATE/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/UPDATE resident_presence presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 3, home_place_id: 3, updated_at: 'now' }]
    }
    if (/SELECT thing\.id/.test(text)) {
      return [{ id: 41, owner_id: 8, place_id: 2, withdrawn_at: null, active_offer_id: 90 }]
    }
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 205 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'go_home',
    placeId: 99,
    sourceThingId: 41,
  }, db)

  assert.equal(result.status, 'applied')
  assert.equal(calls.some(call => /FROM active_blocks/.test(call.text)), false)
  assert.equal(calls.some(call => /SELECT thing\.id/.test(call.text)), false)
  assert.equal(calls.some(call => /WITH RECURSIVE ancestry/.test(call.text)), false)
})

test('a place_id mismatch tells the caller where they must be standing', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    return []
  })

  await assert.rejects(runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 99,
  }, db), (error: unknown) => (
    error instanceof EngineError
    && error.status === 403
    && error.message === 'you must be standing in place_id 99; your current place_id is 2'
  ))
  assert.equal(calls.some(call => /INSERT INTO action_runs/.test(call.text)), false)
})

test('a place_id mismatch explains when the caller current place_id is unset', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: null, home_place_id: null, updated_at: 'now' }]
    }
    return []
  })

  await assert.rejects(runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'talk',
    placeId: 99,
  }, db), (error: unknown) => (
    error instanceof EngineError
    && error.status === 403
    && error.message === 'you must be standing in place_id 99; your current place_id is unset'
  ))
  assert.equal(calls.some(call => /INSERT INTO action_runs/.test(call.text)), false)
})

test('a location race reports the new place_id in caller terms', async () => {
  let presenceReads = 0
  const { db } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      presenceReads += 1
      return [{
        resident_id: 7,
        current_place_id: presenceReads === 1 ? 2 : 3,
        home_place_id: 4,
        updated_at: 'now',
      }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 144 }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 244 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'talk',
    placeId: 2,
  }, db)

  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 409)
  assert.equal(result.error, 'your current place_id changed to 3; retry with place_id 3')
})

test('a location race explains when the current place_id becomes unset', async () => {
  let presenceReads = 0
  const { db } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      presenceReads += 1
      return [{
        resident_id: 7,
        current_place_id: presenceReads === 1 ? 2 : null,
        home_place_id: 4,
        updated_at: 'now',
      }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 145 }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 245 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'talk',
    placeId: 2,
  }, db)

  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 409)
  assert.equal(
    result.error,
    'your current place_id is now unset; check where you are standing before retrying',
  )
})

test('traitless consume still withdraws the owned source thing', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 106 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) {
      return [{ id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null }]
    }
    if (/FROM kind_revision_traits/.test(text) || /WITH RECURSIVE ancestry/.test(text)) return []
    if (/UPDATE things SET withdrawn_at/.test(text)) return [{ id: 41 }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 206 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'consume',
    placeId: 2,
    sourceThingId: 41,
  }, db)
  assert.equal(result.status, 'applied')
  assert.equal(calls.some(call => /UPDATE things SET withdrawn_at/.test(call.text)), true)
  assert.equal(calls.some(call => /'thing_withdrawn'/.test(call.text)), true)
})

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

test('wait stores a frozen root effect at generation zero', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 107 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) {
      return [{ id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null }]
    }
    if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
      trait_id: 10,
      recipe: { use: [{
        effect: 'wait', seconds: 10, repeat: 2,
        then: [{ effect: 'label', target: 'place', label: 'bell-rang' }],
      }] },
    }]
    if (/pg_advisory_xact_lock/.test(text)) return []
    if (/AS place_pending/.test(text)) return [{ place_pending: 0, actor_pending: 0 }]
    if (/INSERT INTO pending_effects/.test(text)) return [{ id: 507 }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 207 }]
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
  const pending = calls.find(call => /INSERT INTO pending_effects/.test(call.text))
  assert.ok(pending)
  assert.equal(pending.values[12], 0)
  assert.match(String(pending.values[10]), /"repeat_remaining":2/)
  assert.match(pending.text, /'effect_scheduled'/)
})

test('a safe shared-use timer stores its restricted source provenance', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 8, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 134 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) return [{
      id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null,
      has_open_offer: false, open_to_use: true,
    }]
    if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
      trait_id: 8,
      recipe: { use: [{
        effect: 'wait', seconds: 10,
        then: [{ effect: 'label', target: 'actor', label: 'welcomed-later' }],
      }] },
    }]
    if (/pg_advisory_xact_lock/.test(text)) return []
    if (/AS place_pending/.test(text)) return [{ place_pending: 0, actor_pending: 0 }]
    if (/INSERT INTO pending_effects/.test(text)) return [{ id: 508 }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 234 }]
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
  const pending = calls.find(call => /INSERT INTO pending_effects/.test(call.text))
  assert.ok(pending)
  assert.match(String(pending.values[10]), /"shared_source_thing_id":41/)
})

test('wait refuses a place queue already at its unresolved cap', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 120 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/WITH RECURSIVE ancestry/.test(text)) return [{
      trait_id: 14,
      name: 'slow-law',
      recipe: { use: [{ effect: 'wait', seconds: 10, then: [] }] },
      source_place_id: 2,
      position: 0,
    }]
    if (/pg_advisory_xact_lock/.test(text)) return []
    if (/AS place_pending/.test(text)) {
      return [{ place_pending: MAX_PENDING_EFFECTS_PER_PLACE, actor_pending: 0 }]
    }
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 220 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
  }, db)

  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 429)
  assert.equal(
    result.error,
    'pending effect limit reached for place; wait for a pending effect to finish or choose another place',
  )
  assert.equal(calls.some(call => /INSERT INTO pending_effects/.test(call.text)), false)
  const countIndex = calls.findIndex(call => /AS place_pending/.test(call.text))
  const lockIndexes = calls.flatMap((call, index) => (
    /pg_advisory_xact_lock/.test(call.text) ? [index] : []
  ))
  assert.equal(lockIndexes.length, 2)
  assert.equal(lockIndexes.every(index => index < countIndex), true)
  assert.match(calls[countIndex]?.text ?? '', /NOT EXISTS.*effect_resolutions/)
})

test('wait refuses an actor queue already at its unresolved cap', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 121 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/WITH RECURSIVE ancestry/.test(text)) return [{
      trait_id: 15,
      name: 'slow-law',
      recipe: { use: [{ effect: 'wait', seconds: 10, then: [] }] },
      source_place_id: 2,
      position: 0,
    }]
    if (/pg_advisory_xact_lock/.test(text)) return []
    if (/AS place_pending/.test(text)) {
      return [{ place_pending: 0, actor_pending: MAX_PENDING_EFFECTS_PER_ACTOR }]
    }
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 221 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
  }, db)

  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 429)
  assert.equal(
    result.error,
    'you have reached the pending effect limit; wait for a pending effect to finish before retrying',
  )
  assert.equal(calls.some(call => /INSERT INTO pending_effects/.test(call.text)), false)
})

test('give transfers only an owned, active, unoffered thing', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 108 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) {
      return [{ id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null }]
    }
    if (/SELECT EXISTS/.test(text) && /FROM things/.test(text)) return [{ exists: true }]
    if (/FROM kind_revision_traits/.test(text) || /WITH RECURSIVE ancestry/.test(text)) return []
    if (/INSERT INTO transfers/.test(text)) return [{ id: 801 }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 208 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'give',
    placeId: 2,
    sourceThingId: 41,
    recipientId: 8,
  }, db)
  assert.equal(result.status, 'applied')
  assert.equal(calls.some(call => /UPDATE things SET owner_id/.test(call.text)), true)
  assert.equal(calls.some(call => /INSERT INTO transfers/.test(call.text)), true)
  const transfer = calls.find(call => /INSERT INTO transfers/.test(call.text))
  assert.match(transfer?.text ?? '', /INSERT INTO events/)
  assert.match(transfer?.text ?? '', /'mode', 'effect'/)
  assert.doesNotMatch(transfer?.text ?? '', /SET\s+maker_id\s*=/)
})

test('give can transfer a kind target without inventing a source thing', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 113 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT EXISTS/.test(text) && /FROM kinds/.test(text)) return [{ exists: true }]
    if (/UPDATE kinds SET owner_id/.test(text)) return [{ id: 813 }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 213 }]
    return []
  })
  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'give',
    placeId: 2,
    target: { type: 'kind', id: 3 },
    recipientId: 8,
  }, db)
  assert.equal(result.status, 'applied', result.error ?? undefined)
  assert.equal(calls.some(call => /UPDATE kinds SET owner_id/.test(call.text)), true)
})

for (const assetType of ['place', 'kind'] as const) {
  test(`a live ${assetType} offer blocks give even when active_offer_id is stale`, async () => {
    const { db, calls } = fakeSql(({ text }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: assetType === 'place' ? 116 : 117 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/SELECT EXISTS/.test(text) && new RegExp(`FROM ${assetType}s`).test(text)) {
        return [{ exists: true }]
      }
      if (new RegExp(`UPDATE ${assetType}s SET owner_id`).test(text)) return []
      if (new RegExp(`FROM ${assetType}s asset`).test(text)) return [{
        owner_id: 7,
        active_offer_id: null,
        has_open_offer: true,
      }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: assetType === 'place' ? 216 : 217 }]
      return []
    })
    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'give',
      placeId: 2,
      target: { type: assetType, id: 3 },
      recipientId: 8,
    }, db)
    assert.equal(result.status, 'failed')
    assert.equal(result.httpStatus, 409)
    const guarded = calls.find(call => new RegExp(`UPDATE ${assetType}s SET owner_id`).test(call.text))
    assert.match(guarded?.text ?? '', /NOT EXISTS/)
    assert.match(guarded?.text ?? '', new RegExp(`offer\.asset_type = '${assetType}'`))
  })
}

test('the open-offer row blocks source use even if the asset mutex is stale', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 114 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) return [{
      id: 41,
      owner_id: 7,
      place_id: 2,
      withdrawn_at: null,
      active_offer_id: null,
      has_open_offer: true,
    }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 214 }]
    return []
  })
  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'consume',
    placeId: 2,
    sourceThingId: 41,
  }, db)
  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 409)
  assert.equal(calls.some(call => /UPDATE things SET withdrawn_at/.test(call.text)), false)
})

test('a move brick moves only an owned thing across one place edge', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 115 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) {
      return [{ id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null }]
    }
    if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
      trait_id: 11,
      recipe: { use: [{ effect: 'move', target: 'source', to: 'destination' }] },
    }]
    if (/SELECT EXISTS/.test(text) && /FROM things/.test(text)) return [{ exists: true }]
    if (/FROM places place WHERE place\.id = ANY/.test(text)) return [
      { id: 2, parent_id: 1, owner_id: 7, open_to_things: false, place_permits_things: true },
      { id: 3, parent_id: 2, owner_id: 7, open_to_things: false, place_permits_things: true },
    ]
    if (/UPDATE things moving SET place_id/.test(text)) return [{ id: 41 }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 215 }]
    return []
  })
  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
    sourceThingId: 41,
    destinationPlaceId: 3,
  }, db)
  assert.equal(result.status, 'applied')
  const guardedMove = calls.find(call => /UPDATE things moving SET place_id/.test(call.text))
  assert.match(guardedMove?.text ?? '', /moving\.place_id = \$/)
  assert.deepEqual(guardedMove?.values.slice(0, 3), [41, 7, 2])
})

test('a move brick refuses a retired destination in caller words', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 315 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) {
      return [{ id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null }]
    }
    if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
      trait_id: 11,
      recipe: { use: [{ effect: 'move', target: 'source', to: 'destination' }] },
    }]
    if (/SELECT EXISTS/.test(text) && /FROM things/.test(text)) return [{ exists: true }]
    if (/FROM places place WHERE place\.id = ANY/.test(text)) return [
      { id: 2, parent_id: 1, owner_id: 7, open_to_things: false, retired_at: null, place_permits_things: true },
      { id: 3, parent_id: 2, owner_id: 7, open_to_things: false, retired_at: '2026-09-01T00:00:00Z', place_permits_things: true },
    ]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 415 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
    sourceThingId: 41,
    destinationPlaceId: 3,
  }, db)

  assert.equal(result.httpStatus, 409)
  assert.equal(result.error, 'destination place is retired; restore it before moving a thing there')
  assert.equal(calls.some(call => /UPDATE things moving SET place_id/.test(call.text)), false)
})

test('a thing move that loses its original-place race returns the existing collision', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 116 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/SELECT thing\.id/.test(text)) {
      return [{ id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null }]
    }
    if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
      trait_id: 11,
      recipe: { use: [{ effect: 'move', target: 'source', to: 'destination' }] },
    }]
    if (/SELECT EXISTS/.test(text) && /FROM things/.test(text)) return [{ exists: true }]
    if (/FROM places place WHERE place\.id = ANY/.test(text)) return [
      { id: 2, parent_id: 1, owner_id: 7, open_to_things: false, place_permits_things: true },
      { id: 3, parent_id: 2, owner_id: 7, open_to_things: false, place_permits_things: true },
    ]
    if (/UPDATE things moving SET place_id/.test(text)) return []
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 216 }]
    return []
  })

  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
    sourceThingId: 41,
    destinationPlaceId: 3,
  }, db)

  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 409)
  assert.equal(result.error, 'thing or destination changed before the move; re-read both and retry')
  const racedMove = calls.find(call => /UPDATE things moving SET place_id/.test(call.text))
  assert.equal(racedMove?.values[2], 2)
  assert.equal(racedMove?.values[5], racedMove?.values[2])
})

test('a move effect cannot target a resident in another place, even to send them home', async () => {
  const { db, calls } = fakeSql(({ text, values }) => {
    if (/SELECT current_place_id FROM resident_presence/.test(text) && Number(values[0]) === 8) {
      return [{ current_place_id: 3 }]
    }
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 118 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/WITH RECURSIVE ancestry/.test(text)) return [{
      trait_id: 12,
      name: 'home-wind',
      recipe: { use: [{ effect: 'move', target: 'target', to: 'home' }] },
      source_place_id: 2,
      position: 0,
    }]
    if (/SELECT EXISTS/.test(text) && /FROM residents/.test(text)) return [{ exists: true }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 218 }]
    return []
  })
  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
    target: { type: 'resident', id: 8 },
  }, db)
  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 403)
  assert.equal(
    result.error,
    'target resident must be standing in place_id 2; target current place_id is 3',
  )
  assert.equal(calls.some(call => /UPDATE resident_presence presence/.test(call.text)), false)
})

test('a resident move effect cannot bypass the one-edge movement rule', async () => {
  const { db, calls } = fakeSql(({ text, values }) => {
    if (/SELECT current_place_id FROM resident_presence/.test(text) && Number(values[0]) === 8) {
      return [{ current_place_id: 2 }]
    }
    if (/FROM resident_presence/.test(text) && Number(values[0]) === 8) {
      return [{ resident_id: 8, current_place_id: 2, home_place_id: 4, updated_at: 'now' }]
    }
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 119 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/WITH RECURSIVE ancestry/.test(text)) return [{
      trait_id: 13,
      name: 'long-push',
      recipe: { use: [{ effect: 'move', target: 'target', to: 'destination' }] },
      source_place_id: 2,
      position: 0,
    }]
    if (/SELECT EXISTS/.test(text) && /FROM residents/.test(text)) return [{ exists: true }]
    if (/SELECT id, parent_id, retired_at FROM places/.test(text)) return [
      { id: 2, parent_id: 1 },
      { id: 9, parent_id: 8 },
    ]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 219 }]
    return []
  })
  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'use',
    placeId: 2,
    target: { type: 'resident', id: 8 },
    destinationPlaceId: 9,
  }, db)
  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 403)
  assert.equal(
    result.error,
    'place_id 9 exists, but entry is closed from your current place_id 2; entry opens when you stand in its parent or one of its direct children, so use the public map outline to move one parent-child edge at a time',
  )
  assert.equal(calls.some(call => /UPDATE resident_presence/.test(call.text)), false)
})

interface CarryThingFixture {
  readonly id?: number
  readonly owner_id?: number
  readonly place_id?: number
  readonly withdrawn_at?: string | null
  readonly active_offer_id?: number | null
  readonly has_open_offer?: boolean
  readonly marked_by_other?: boolean
  readonly moderation_action?: 'remove' | 'restore' | null
  readonly destination_owner_id?: number
  readonly destination_open_to_things?: boolean
  readonly destination_retired_at?: string | null
  readonly update_succeeds?: boolean
  readonly law_emits_typed_event?: boolean
}

function carryActionDb(fixture: CarryThingFixture = {}) {
  const thing = {
    id: 41,
    owner_id: 7,
    place_id: 2,
    withdrawn_at: null,
    active_offer_id: null,
    has_open_offer: false,
    marked_by_other: false,
    moderation_action: null,
    destination_owner_id: 7,
    destination_open_to_things: false,
    destination_retired_at: null,
    update_succeeds: true,
    ...fixture,
  }
  return fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 2, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 301 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/AS marked_by_other/.test(text)) return [thing]
    if (/FROM places destination/.test(text)) return [{
      id: 3,
      owner_id: thing.destination_owner_id,
      open_to_things: thing.destination_open_to_things,
      retired_at: thing.destination_retired_at,
      destination_permits_things:
        thing.destination_owner_id === 7 || thing.destination_open_to_things,
    }]
    if (/WITH RECURSIVE ancestry/.test(text)) {
      return fixture.law_emits_typed_event ? [{
        trait_id: 12,
        name: 'leave-a-later-mark',
        recipe: { move: [{
          effect: 'wait',
          seconds: 10,
          then: [{ effect: 'label', target: 'actor', label: 'arrived-later' }],
        }] },
        source_place_id: 2,
        position: 0,
      }] : []
    }
    if (/pg_advisory_xact_lock/.test(text)) return []
    if (/AS place_pending/.test(text)) return [{ place_pending: 0, actor_pending: 0 }]
    if (/INSERT INTO pending_effects/.test(text)) return [{ id: 501 }]
    if (/SELECT id, parent_id, retired_at FROM places/.test(text)) return [
      { id: 2, parent_id: 1 },
      { id: 3, parent_id: 2 },
    ]
    if (/UPDATE resident_presence SET current_place_id/.test(text)) {
      return [{ resident_id: 7, current_place_id: 3, home_place_id: 2, updated_at: 'now' }]
    }
    if (/UPDATE things carrying SET place_id/.test(text)) {
      return thing.update_succeeds ? [{ id: 41 }] : []
    }
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 401 }]
    return []
  })
}

async function carryAction(fixture: CarryThingFixture = {}, destinationPlaceId = 3) {
  const database = carryActionDb(fixture)
  const result = await runAction({
    actorId: 7,
    actorHandle: 'tiny-lantern',
    action: 'move',
    placeId: 2,
    destinationPlaceId,
    carryThingId: 41,
  }, database.db)
  return { ...database, result }
}

test('a move carries one owned colocated thing and records both movements', async () => {
  const { result, calls } = await carryAction()

  assert.equal(result.status, 'applied')
  assert.equal(result.httpStatus, 200)
  assert.equal(result.effectsApplied, 0)
  const carry = calls.find(call => /UPDATE things carrying SET place_id/.test(call.text))
  assert.deepEqual(carry?.values.slice(0, 4), [41, 7, 2, 3])
  assert.match(carry?.text ?? '', /'thing_moved'/)
  assert.match(carry?.text ?? '', /'action_id'/)
  assert.match(carry?.text ?? '', /'resident_id'/)
  const resolution = calls.find(call => /INSERT INTO action_resolutions/.test(call.text))
  assert.match(String(resolution?.values[2] ?? ''), /"thing_id":41/)
})

test('a carry refuses a closed foreign destination before either location changes', async () => {
  const { result, calls } = await carryAction({
    destination_owner_id: 8,
    destination_open_to_things: false,
  })

  assert.equal(result.httpStatus, 403)
  assert.equal(
    result.error,
    'destination place does not accept visitor things; drop the carry and walk, or go where things are welcome',
  )
  assert.equal(calls.some(call => /UPDATE resident_presence SET current_place_id/.test(call.text)), false)
  assert.equal(calls.some(call => /UPDATE things carrying SET place_id/.test(call.text)), false)
})

test('a carry refuses a retired destination before either location changes', async () => {
  const { result, calls } = await carryAction({
    destination_retired_at: '2026-09-01T00:00:00Z',
  })

  assert.equal(result.httpStatus, 409)
  assert.equal(result.error, 'destination place is retired; restore it before moving there')
  assert.equal(calls.some(call => /UPDATE resident_presence SET current_place_id/.test(call.text)), false)
  assert.equal(calls.some(call => /UPDATE things carrying SET place_id/.test(call.text)), false)
})

test('a carry may enter the mover\'s own closed destination', async () => {
  const { result, calls } = await carryAction({
    destination_owner_id: 7,
    destination_open_to_things: false,
  })

  assert.equal(result.status, 'applied')
  const permission = calls.find(call => /FROM places destination/.test(call.text))
  assert.match(permission?.text ?? '', /\(destination\.owner_id = \$ OR destination\.open_to_things\)/u)
  assert.equal(permission?.values[0], 7)
})

test('a carry may enter a foreign destination open to visitor things', async () => {
  const { result } = await carryAction({
    destination_owner_id: 8,
    destination_open_to_things: true,
  })

  assert.equal(result.status, 'applied')
})

test('a carried move keeps its resident movement record when an origin law emits an event', async () => {
  const { result, calls } = await carryAction({ law_emits_typed_event: true })

  assert.equal(result.status, 'applied')
  assert.ok(calls.some(call => /INSERT INTO pending_effects/.test(call.text)))
  const resolution = calls.find(call => /INSERT INTO action_resolutions/.test(call.text))
  assert.equal(resolution?.values.at(-1), true)
  assert.match(String(resolution?.values.at(-2) ?? ''), /"mode":"carry"/)
})

test('a carry refuses a destination that is the place already occupied', async () => {
  const { result, calls } = await carryAction({}, 2)

  assert.equal(result.httpStatus, 400)
  assert.equal(result.error, 'carry_thing_id requires a move to a different adjacent place')
  assert.equal(calls.some(call => /AS marked_by_other/.test(call.text)), false)
  assert.equal(calls.some(call => /UPDATE resident_presence SET current_place_id/.test(call.text)), false)
})

test('a move refuses to carry a thing the mover does not own', async () => {
  const { result, calls } = await carryAction({ owner_id: 8 })
  assert.equal(result.httpStatus, 403)
  assert.equal(result.error, 'you can carry only a thing you own')
  assert.equal(calls.some(call => /UPDATE resident_presence SET current_place_id/.test(call.text)), false)
})

test('a move refuses to carry an owned thing that is not in the place being left', async () => {
  const { result, calls } = await carryAction({ place_id: 9 })
  assert.equal(result.httpStatus, 403)
  assert.equal(
    result.error,
    'carry_thing_id must be in the place you are leaving (place_id 2); its current place_id is 9',
  )
  assert.equal(calls.some(call => /UPDATE resident_presence SET current_place_id/.test(call.text)), false)
})

test('a move refuses to carry a thing with an open sale offer or market lock', async t => {
  for (const fixture of [
    { active_offer_id: 91 },
    { has_open_offer: true },
  ] as const) {
    await t.test(JSON.stringify(fixture), async () => {
      const { result, calls } = await carryAction(fixture)
      assert.equal(result.httpStatus, 409)
      assert.equal(
        result.error,
        'carry_thing_id has an open sale offer or market lock; cancel the offer, wait for the lock to clear, or carry another owned thing',
      )
      assert.equal(calls.some(call => /UPDATE resident_presence SET current_place_id/.test(call.text)), false)
    })
  }
})

test('a move refuses to carry a thing marked for a later holder by another resident', async () => {
  const { result, calls } = await carryAction({ marked_by_other: true })
  assert.equal(result.httpStatus, 409)
  assert.equal(
    result.error,
    'carry_thing_id is marked for a later holder by another resident; wait for that mark to clear or carry another owned thing',
  )
  assert.equal(calls.some(call => /UPDATE resident_presence SET current_place_id/.test(call.text)), false)
})

test('a move refuses to carry a thing under a moderation hold', async () => {
  const { result, calls } = await carryAction({ moderation_action: 'remove' })
  assert.equal(result.httpStatus, 409)
  assert.equal(
    result.error,
    'carry_thing_id is under a moderation hold; wait for the hold to clear or carry another owned thing',
  )
  assert.equal(calls.some(call => /UPDATE resident_presence SET current_place_id/.test(call.text)), false)
})

test('a carry reports when its final guarded update loses the race', async () => {
  const { result, calls } = await carryAction({ update_succeeds: false })

  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 409)
  assert.equal(
    result.error,
    'carry_thing_id, ownership, place, sale/lock, later-holder mark, or moderation hold changed before the move; re-read it',
  )
  assert.equal(calls.some(call => /UPDATE things carrying SET place_id/.test(call.text)), true)
})

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
  const expectedError = 'the city hit an internal failure running this action; that failure is not something you did, so retry once, then contact the city operator if it keeps failing'
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
  const expectedError = 'the city hit an internal failure running this action; that failure is not something you did, so retry once, then contact the city operator if it keeps failing'
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
          logical_due_at: '2026-08-11T00:00:00.000Z',
        },
        due_at: '2026-08-11T05:00:00.000Z',
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
  assert.match(String(repeated.values[10]), /"logical_due_at":"2026-08-11T00:00:10.000Z"/)
  assert.equal(repeated.values[12], 1)
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

function uncertainCommitResponder(
  resolutionRows: () => Record<string, unknown>[],
): (call: Call) => unknown[] {
  return ({ text }) => {
    if (/SELECT status, detail FROM action_resolutions/.test(text)) return resolutionRows()
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 240 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 340 }]
    return []
  }
}

const UNCERTAIN_COMMIT_ACTION: ActionInput = {
  actorId: 7,
  actorHandle: 'tiny-lantern',
  action: 'use',
  placeId: 2,
}

function failedResolutionWrites(calls: Call[]): Call[] {
  return calls.filter(call =>
    /INSERT INTO action_resolutions/.test(call.text) && call.values[1] === 'failed')
}

test('an uncertain commit resolves to the recorded outcome instead of a failure', async () => {
  const { db, calls } = fakeSql(uncertainCommitResponder(
    () => [{ status: 'applied', detail: { effects_applied: 2 } }],
  ))
  setEngineTransactionRunnerForTests(async (database, work) => {
    await work(database, true)
    throw new CommitOutcomeUnknownError(new Error('connection closed before the commit reply'))
  })
  try {
    const result = await runAction(UNCERTAIN_COMMIT_ACTION, db)
    assert.equal(result.status, 'applied')
    assert.equal(result.httpStatus, 200)
    assert.equal(result.error, null)
    assert.equal(result.effectsApplied, 2)
  } finally {
    setEngineTransactionRunnerForTests(null)
  }
  assert.equal(failedResolutionWrites(calls).length, 0)
})

test('an uncertain commit whose failure record wins is a plain retryable conflict', async () => {
  const { db, calls } = fakeSql(uncertainCommitResponder(() => []))
  setEngineTransactionRunnerForTests(async (database, work) => {
    await work(database, true)
    throw new CommitOutcomeUnknownError(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    )
  })
  try {
    const result = await runAction(UNCERTAIN_COMMIT_ACTION, db)
    assert.equal(result.status, 'failed')
    assert.equal(result.httpStatus, 409)
    assert.equal(result.error, COLLISION_CONFLICT_MESSAGE)
  } finally {
    setEngineTransactionRunnerForTests(null)
  }
  assert.equal(failedResolutionWrites(calls).length, 1)
})

test('an uncertain commit that lands after the readback still answers with the committed outcome', async () => {
  let resolutionReads = 0
  const { db, calls } = fakeSql(({ text }) => {
    if (/SELECT status, detail FROM action_resolutions/.test(text)) {
      resolutionReads += 1
      // Invisible on the first read; the in-doubt commit lands while the
      // failure insert waits on the unique index and loses the conflict.
      return resolutionReads === 1 ? [] : [{ status: 'applied', detail: { effects_applied: 1 } }]
    }
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 240 }]
    if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
    if (/INSERT INTO action_resolutions/.test(text)) return []
    return []
  })
  setEngineTransactionRunnerForTests(async (database, work) => {
    await work(database, true)
    throw new CommitOutcomeUnknownError(new Error('connection closed before the commit reply'))
  })
  try {
    const result = await runAction(UNCERTAIN_COMMIT_ACTION, db)
    assert.equal(result.status, 'applied')
    assert.equal(result.httpStatus, 200)
    assert.equal(result.error, null)
    assert.equal(result.effectsApplied, 1)
  } finally {
    setEngineTransactionRunnerForTests(null)
  }
  assert.equal(resolutionReads, 2)
  assert.ok(calls.some(call =>
    /INSERT INTO action_resolutions/.test(call.text) && call.values[1] === 'failed'))
})

test('an unreadable outcome record never claims failure or invites a retry', async () => {
  const { db, calls } = fakeSql(uncertainCommitResponder(() => {
    throw Object.assign(new Error('the record read failed too'), { code: '57P01' })
  }))
  setEngineTransactionRunnerForTests(async (database, work) => {
    await work(database, true)
    throw new CommitOutcomeUnknownError(new Error('connection closed before the commit reply'))
  })
  try {
    const result = await runAction(UNCERTAIN_COMMIT_ACTION, db)
    assert.equal(result.status, 'unconfirmed')
    assert.equal(result.httpStatus, 500)
    assert.equal(result.error, UNCONFIRMED_ACTION_ERROR)
    assert.doesNotMatch(result.error ?? '', /retry/)
  } finally {
    setEngineTransactionRunnerForTests(null)
  }
  assert.equal(failedResolutionWrites(calls).length, 0)
})

test('a raw serialization collision inside an action answers as a retryable conflict', async () => {
  const { db } = fakeSql(({ text }) => {
    if (/FROM resident_presence/.test(text)) {
      return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
    }
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 243 }]
    if (/FROM active_blocks/.test(text)) {
      throw Object.assign(
        new Error('could not serialize access due to concurrent update'),
        { code: '40001' },
      )
    }
    if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 343 }]
    return []
  })
  const result = await runAction(UNCERTAIN_COMMIT_ACTION, db)
  assert.equal(result.status, 'failed')
  assert.equal(result.httpStatus, 409)
  assert.equal(result.error, COLLISION_CONFLICT_MESSAGE)
  assert.doesNotMatch(result.error ?? '', /serialize/)
})
