import test from 'node:test'
import assert from 'node:assert/strict'

import { EngineError, runAction } from '../../src/engine.ts'
import { thingState } from '../../src/engine-effects.ts'
import { fakeSql } from './context.ts'

export function registerActionLocationTests(): void {
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

  test('thing state preserves database Date milliseconds', async () => {
    const { db } = fakeSql(() => [{
      id: 41,
      owner_id: 7,
      place_id: 2,
      withdrawn_at: new Date('2026-08-11T00:00:00.106Z'),
      active_offer_id: null,
      has_open_offer: false,
      open_to_use: false,
    }])

    assert.equal((await thingState(41, db))?.withdrawnAt, '2026-08-11T00:00:00.106Z')
  })

}
