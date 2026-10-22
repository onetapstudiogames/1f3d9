import test from 'node:test'
import assert from 'node:assert/strict'

import { EngineError, runAction } from '../../src/engine.ts'
import { executeEffects, type EffectExecutionContext } from '../../src/engine-effects.ts'
import { fakeSql } from './context.ts'

export function registerLawAuthorityTests(): void {
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

  test('an unauthorised damage attempt is refused before any sale state is named', async () => {
    const { db, calls } = fakeSql(({ text, values }) => {
      if (/FROM resident_presence/.test(text)) {
        return [{ resident_id: 7, current_place_id: 2, home_place_id: 3, updated_at: 'now' }]
      }
      if (/INSERT INTO action_runs/.test(text)) return [{ id: 104 }]
      if (/FROM active_blocks/.test(text)) return [{ blocked: false }]
      if (/SELECT thing\.id/.test(text)) {
        return Number(values[0]) === 41
          ? [{ id: 41, owner_id: 7, place_id: 2, withdrawn_at: null, active_offer_id: null }]
          : [{
              id: 42, owner_id: 8, place_id: 2, withdrawn_at: null,
              active_offer_id: 55, has_open_offer: true,
            }]
      }
      if (/FROM things thing JOIN kind_revision_traits/.test(text)) return [{
        trait_id: 9,
        recipe: { use: [{ effect: 'destroy', target: 'target' }] },
      }]
      if (/INSERT INTO action_resolutions/.test(text)) return [{ id: 204 }]
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

  test('law_place rejects kind, wake and borrowed authority origins without a write', async () => {
    const base: EffectExecutionContext = {
      actionId: null, actorId: 7, actorHandle: 'visitor', placeId: 3,
      sourceThingId: 41, sharedSourceThingId: null, target: null,
      destinationPlaceId: null, recipientId: null, sourceTraitId: 21,
      lawAuthority: null, parentEffectId: null, generation: 0, logicalAt: new Date(),
    }
    for (const context of [
      base,
      { ...base, fromWake: true },
      { ...base, lawAuthority: { traitId: 22, sourcePlaceId: 2 } },
      { ...base, originThingId: 41, originPlaceId: 2,
        lawAuthority: { traitId: 21, sourcePlaceId: 2 } },
      { ...base, sourceThingId: null, sourceTraitId: null, originPlaceId: 2 },
      { ...base, placeId: null, originThingId: null, originPlaceId: 2 },
    ]) {
      for (const effect of [
        { effect: 'label', target: 'law_place', label: 'rain', seconds: 1 },
        { effect: 'check_label', target: 'law_place', label: 'rain', then: [] },
      ] as const) {
        const { db, calls } = fakeSql(() => [{ exists: true }])
        await assert.rejects(executeEffects([effect], context, db), (error: unknown) => (
          error instanceof EngineError && error.status === 403
          && error.message === 'law_place is available only to a place law; put this trait on a place you own as a law'
        ))
        assert.equal(calls.some(call => /INSERT INTO active_labels/.test(call.text)), false)
      }
    }
  })

  test('a thing check that borrows a named law still cannot write law_place', async () => {
    const { db, calls } = fakeSql(({ text }) => {
      if (/WITH RECURSIVE ancestry/.test(text)) return [{
        trait_id: 22, name: 'gate-law', recipe: null, source_place_id: 2, position: 0,
      }]
      if (/SELECT EXISTS/.test(text)) return [{ exists: true }]
      return []
    })
    await assert.rejects(executeEffects([{
      effect: 'check_label', target: 'place', label: 'gate-law', then: [
        { effect: 'label', target: 'law_place', label: 'borrowed', seconds: 1 },
      ],
    }], {
      actionId: null, actorId: 7, actorHandle: 'visitor', placeId: 2,
      sourceThingId: 41, sharedSourceThingId: null, target: null,
      destinationPlaceId: null, recipientId: null, sourceTraitId: 21,
      lawAuthority: null, parentEffectId: null, generation: 0, logicalAt: new Date(),
    }, db), (error: unknown) => error instanceof EngineError && error.status === 403
      && error.message === 'law_place is available only to a place law; put this trait on a place you own as a law')
    assert.equal(calls.some(call => /INSERT INTO active_labels/.test(call.text)), false)
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

}
