import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EngineError,
  effectiveLaws,
  ensurePresence,
  isActionBlocked,
  moveResident,
  resolveSymbolicTarget,
  setHome,
} from '../../src/engine.ts'
import { fakeSql } from './context.ts'

export function registerLawsPresenceMovementTests(): void {
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
      updated_at: new Date('2026-08-11T00:00:00.106Z'),
    }])

    assert.deepEqual(await ensurePresence(7, db), {
      residentId: 7,
      currentPlaceId: 2,
      homePlaceId: 2,
      updatedAt: '2026-08-11T00:00:00.106Z',
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
      && error.message === 'destination place_id 9 was not found; call look with place_id 2 and view outline, or use GET /api/map?view=outline&parent_id=2 if your client can open URLs, to choose a public adjacent destination'
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

}
