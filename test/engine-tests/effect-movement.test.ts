import test from 'node:test'
import assert from 'node:assert/strict'

import { runAction } from '../../src/engine.ts'
import { fakeSql } from './context.ts'

export function registerEffectMovementTests(): void {
test('a move brick respects closed destination ownership', async t => {
  async function moveToClosedDestination(destinationOwnerId: number) {
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
        {
          id: 3,
          parent_id: 2,
          owner_id: destinationOwnerId,
          open_to_things: false,
          place_permits_things: destinationOwnerId === 7,
        },
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
    return { calls, result }
  }

  await t.test('refuses a closed foreign destination without moving the thing', async () => {
    const { calls, result } = await moveToClosedDestination(8)

    assert.equal(result.httpStatus, 403)
    assert.equal(
      result.error,
      'destination does not allow visitor things; its owner can enable open_to_things, or choose another open place',
    )
    assert.equal(calls.some(call => /UPDATE things moving SET place_id/.test(call.text)), false)
  })

  await t.test('allows the owner to move a thing into their closed destination', async () => {
    const { calls, result } = await moveToClosedDestination(7)

    assert.equal(result.status, 'applied')
    const guardedMove = calls.find(call => /UPDATE things moving SET place_id/.test(call.text))
    assert.match(guardedMove?.text ?? '', /moving\.place_id = \$/)
    assert.deepEqual(guardedMove?.values.slice(0, 3), [41, 7, 2])
  })
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

}
