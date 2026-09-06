import test from 'node:test'
import assert from 'node:assert/strict'

import { runAction } from '../../src/engine.ts'
import {
  executeEffects,
  type EffectExecutionContext,
} from '../../src/engine-effects.ts'
import { BLOCKABLE_ACTIONS } from '../../src/physics.ts'
import { fakeSql } from './context.ts'

export function registerLabelsBlockingTests(): void {
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

}
