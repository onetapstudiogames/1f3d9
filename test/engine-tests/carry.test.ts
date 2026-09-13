import test from 'node:test'
import assert from 'node:assert/strict'

import { runAction } from '../../src/engine.ts'
import { fakeSql } from './context.ts'

export function registerCarryTests(): void {
  interface CarryThingFixture {
    readonly id?: number
    readonly owner_id?: number
    readonly place_id?: number
    readonly withdrawn_at?: string | null
    readonly active_offer_id?: number | null
    readonly has_open_offer?: boolean
    readonly marked_by_other?: boolean
    readonly moderation_action?: 'remove' | 'restore' | null
    readonly destination_owner_id?: number | null
    readonly destination_open_to_things?: boolean
    readonly destination_retired_at?: string | null
    readonly current_place_id?: number
    readonly home_place_id?: number
    readonly origin_parent_id?: number | null
    readonly destination_parent_id?: number | null
    readonly held_by?: number | null
    readonly update_succeeds?: boolean
    readonly law_emits_typed_event?: boolean
  }

  function carryActionDb(fixture: CarryThingFixture = {}, destinationPlaceId = 3) {
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
      current_place_id: 2,
      home_place_id: 2,
      origin_parent_id: 1,
      destination_parent_id: 2,
      held_by: null,
      update_succeeds: true,
      ...fixture,
    }
    return fakeSql(({ text }) => {
      if (/INSERT INTO resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: thing.current_place_id,
          home_place_id: thing.home_place_id, updated_at: 'now' }]
      }
      if (/WITH usable_home AS MATERIALIZED/.test(text)) {
        return [{ resident_id: 7, current_place_id: thing.home_place_id,
          home_place_id: thing.home_place_id, updated_at: 'now' }]
      }
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: thing.current_place_id,
          home_place_id: thing.home_place_id, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 301 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/AS marked_by_other/.test(text)) return [thing]
      if (/FROM things WHERE held_by/.test(text)) return thing.held_by === 7
        ? [{ id: thing.id, place_id: thing.place_id }] : []
      if (/FROM places destination/.test(text)) return [{
        id: destinationPlaceId,
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
      if (/SELECT id, parent_id, retired_at, owner_id, open_to_things FROM places/.test(text)) return [
        { id: thing.current_place_id, parent_id: thing.origin_parent_id,
          owner_id: 7, open_to_things: false, retired_at: null },
        { id: destinationPlaceId, parent_id: thing.destination_parent_id,
          owner_id: thing.destination_owner_id, open_to_things: thing.destination_open_to_things,
          retired_at: thing.destination_retired_at },
      ]
      if (/UPDATE resident_presence SET current_place_id/.test(text)) {
        return [{ resident_id: 7, current_place_id: destinationPlaceId,
          home_place_id: thing.home_place_id, updated_at: 'now' }]
      }
      if (/UPDATE things SET place_id/.test(text)) {
        return thing.update_succeeds ? [{ id: thing.id }] : []
      }
      if (/UPDATE things carrying SET place_id/.test(text)) {
        return thing.update_succeeds ? [{ id: 41 }] : []
      }
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 401 }]
      return []
    })
  }

  async function carryAction(fixture: CarryThingFixture = {}, destinationPlaceId = 3) {
    const database = carryActionDb(fixture, destinationPlaceId)
    const result = await runAction({
      actorId: 7,
      actorHandle: 'tiny-lantern',
      action: 'move',
      placeId: fixture.current_place_id ?? 2,
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

  test('a carry enters a closed foreign destination as held luggage', async () => {
    const { result, calls } = await carryAction({
      destination_owner_id: 8,
      destination_open_to_things: false,
    })

    assert.equal(result.status, 'applied')
    assert.equal(result.httpStatus, 200)
    assert.ok(calls.some(call => /UPDATE resident_presence SET current_place_id/.test(call.text)))
    const carry = calls.find(call => /UPDATE things carrying SET place_id/.test(call.text))
    assert.match(carry?.text ?? '', /held_by = \$/u)
    assert.equal(carry?.values[5], 7)
  })

  test('one owned thing can enter the closed ownerless world as held luggage', async () => {
    const { result, calls } = await carryAction({
      current_place_id: 1,
      place_id: 1,
      origin_parent_id: 195,
      destination_parent_id: null,
      destination_owner_id: null,
      destination_open_to_things: false,
    }, 195)

    assert.equal(result.status, 'applied')
    const carry = calls.find(call => /UPDATE things carrying SET place_id/.test(call.text))
    assert.deepEqual(carry?.values.slice(0, 4), [41, 7, 1, 195])
    assert.match(carry?.text ?? '', /held_by = \$/u)
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
    assert.match(permission?.text ?? '', /AS destination_permits_things/u)
    const carry = calls.find(call => /UPDATE things carrying SET place_id/.test(call.text))
    assert.match(carry?.text ?? '', /held_by = \$/u)
    assert.equal(carry?.values[5], null)
  })

  test('a carry may enter a foreign destination open to visitor things', async () => {
    const { result, calls } = await carryAction({
      destination_owner_id: 8,
      destination_open_to_things: true,
    })

    assert.equal(result.status, 'applied')
    const carry = calls.find(call => /UPDATE things carrying SET place_id/.test(call.text))
    assert.equal(carry?.values[5], null)
  })

  test('protected Gazette room #454 keeps luggage held even for its owner', async () => {
    const { result, calls } = await carryAction({
      destination_owner_id: 7,
      destination_open_to_things: true,
    }, 454)

    assert.equal(result.status, 'applied')
    const carry = calls.find(call => /UPDATE things carrying SET place_id/.test(call.text))
    assert.equal(carry?.values[5], 7)
  })

  test('a plain next move keeps luggage held in another closed room', async () => {
    const database = carryActionDb({
      current_place_id: 2, place_id: 2, held_by: 7,
      destination_owner_id: 8, destination_open_to_things: false,
    })
    const result = await runAction({
      actorId: 7, actorHandle: 'tiny-lantern', action: 'move',
      placeId: 2, destinationPlaceId: 3,
    }, database.db)

    assert.equal(result.status, 'applied')
    const move = database.calls.find(call => /UPDATE things SET place_id/.test(call.text))
    assert.ok(move)
    assert.equal(move.values[1], 7, 'closed destination retains held_by')
  })

  test('a plain next move takes held luggage and releases it in an open room', async () => {
    const database = carryActionDb({
      current_place_id: 2, place_id: 2, held_by: 7,
      destination_owner_id: 8, destination_open_to_things: true,
    })
    const result = await runAction({
      actorId: 7, actorHandle: 'tiny-lantern', action: 'move',
      placeId: 2, destinationPlaceId: 3,
    }, database.db)

    assert.equal(result.status, 'applied')
    const move = database.calls.find(call => /UPDATE things SET place_id/.test(call.text))
    assert.ok(move, 'held thing follows the resident without carry_thing_id')
    assert.equal(move.values[1], null, 'open destination clears held_by')
    const resolution = database.calls.find(call => /INSERT INTO action_resolutions/.test(call.text))
    assert.match(String(resolution?.values[2] ?? ''), /"thing_id":41/)
  })

  test('go_home takes held luggage to the owned home in the same action', async () => {
    const database = carryActionDb({
      current_place_id: 3, place_id: 3, held_by: 7,
      home_place_id: 2, origin_parent_id: 2,
    }, 2)
    const result = await runAction({
      actorId: 7, actorHandle: 'tiny-lantern', action: 'go_home',
    }, database.db)

    assert.equal(result.status, 'applied', result.error ?? undefined)
    assert.ok(database.calls.some(call => /WITH usable_home AS MATERIALIZED/.test(call.text)))
    const move = database.calls.find(call => /UPDATE things SET place_id/.test(call.text))
    assert.ok(move, 'held thing reaches home')
    assert.equal(move.values[1], null, 'owned home clears held_by')
  })

  test('a held thing cannot be exchanged for another carry on the next move', async () => {
    const { result, calls } = await carryAction({ held_by: 7, place_id: 2, id: 42 })

    assert.equal(result.httpStatus, 409)
    assert.equal(result.error, 'a held thing cannot be left in a closed place; carry it with your next move or go home')
    assert.equal(calls.some(call => /UPDATE resident_presence SET current_place_id/.test(call.text)), false)
    assert.equal(calls.some(call => /UPDATE things carrying SET place_id/.test(call.text)), false)
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

}
