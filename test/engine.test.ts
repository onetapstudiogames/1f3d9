import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EngineError,
  MAX_PENDING_EFFECTS_PER_ACTOR,
  MAX_PENDING_EFFECTS_PER_PLACE,
  effectiveLaws,
  ensurePresence,
  isActionBlocked,
  moveResident,
  resolveDueEffects,
  resolveSymbolicTarget,
  runAction,
  setEngineTransactionRunnerForTests,
  setHome,
  type ActionInput,
  type TaggedSql,
} from '../src/engine.ts'

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
  const { db } = fakeSql(() => [{ blocked: true }])
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
    && error.message === 'home must be a place you own'
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
    && error.message === 'move must cross one parent-child edge'
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
    if (/FROM active_blocks/.test(text)) return [{ blocked: true }]
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
  assert.equal(calls.some(call => /INSERT INTO active_labels/.test(call.text)), false)
  assert.equal(calls.some(call => /INSERT INTO action_resolutions/.test(call.text)), true)
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
  assert.equal(result.error, 'thing changed before it could be destroyed')
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

test('go_home ignores supplied source traps and bypasses every block query', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/INSERT INTO action_runs/.test(text)) return [{ id: 105 }]
    if (/WITH first_owned/.test(text)) {
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

test('an action cannot claim laws from a place other than the actor current place', async () => {
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
    && error.message === 'action place must be the actor current place'
  ))
  assert.equal(calls.some(call => /INSERT INTO action_runs/.test(call.text)), false)
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
  assert.equal(result.error, 'pending effect limit reached for place')
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
  assert.equal(result.error, 'pending effect limit reached for actor')
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
    if (/SELECT id, parent_id, owner_id, open_to_things/.test(text)) return [
      { id: 2, parent_id: 1, owner_id: 7, open_to_things: false },
      { id: 3, parent_id: 2, owner_id: 7, open_to_things: false },
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
  assert.equal(calls.some(call => /UPDATE things moving SET place_id/.test(call.text)), true)
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
  assert.equal(result.error, 'resident target is not in the action place')
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
    if (/SELECT id, parent_id FROM places/.test(text)) return [
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
  assert.equal(result.error, 'move must cross one parent-child edge')
  assert.equal(calls.some(call => /UPDATE resident_presence/.test(call.text)), false)
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
