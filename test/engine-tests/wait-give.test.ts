import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_PENDING_EFFECTS_PER_ACTOR,
  MAX_PENDING_EFFECTS_PER_PLACE,
  runAction,
} from '../../src/engine.ts'
import { fakeSql } from './context.ts'

export function registerWaitGiveTests(): void {
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

}
