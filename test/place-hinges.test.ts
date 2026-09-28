import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  HINGE_TO_GAZETTE_REFUSAL,
  HINGE_TO_WORLD_REFUSAL,
  hingeTargetMissingRefusal,
  hingeTargetNestedRefusal,
  hingeTargetRetiredRefusal,
  parseHingeTo,
  publicHinge,
} from '../src/place-hinges.ts'
import { PLACE_DIAL_FIELDS } from '../src/place-abilities.ts'
import { PUBLIC_SNAPSHOT_CLASS_REGISTRY } from '../src/public-snapshot-format.ts'

const worldSource = await readFile(new URL('../src/world.ts', import.meta.url), 'utf8')

test('parseHingeTo distinguishes omission, clearing, valid ids, and exact refusals', () => {
  assert.deepEqual(parseHingeTo(undefined, 4), { ok: true, supplied: false, value: null })
  assert.deepEqual(parseHingeTo(null, 4), { ok: true, supplied: true, value: null })
  assert.deepEqual(parseHingeTo(7, 4), { ok: true, supplied: true, value: 7 })
  for (const value of [0, -1, 1.5, '7', 2_147_483_648, []]) {
    assert.deepEqual(parseHingeTo(value, 4), {
      ok: false,
      error: 'hinge_to must be one positive place id, or null to close your side of the hinge',
    }, JSON.stringify(value))
  }
  assert.deepEqual(parseHingeTo(4, 4), {
    ok: false,
    error: 'hinge_to cannot name this same place; name another place, or send null to close your side',
  })
})

test('hinge target refusals use caller-facing place facts', () => {
  assert.equal(HINGE_TO_GAZETTE_REFUSAL, 'hinge_to cannot name protected Gazette room #454; name another place')
  assert.equal(HINGE_TO_WORLD_REFUSAL, 'hinge_to cannot name the world: it has no owner who could agree; name an owned place')
  assert.equal(hingeTargetMissingRefusal(12), 'hinge_to place_id 12 was not found; name a current place id from the public map')
  assert.equal(hingeTargetRetiredRefusal(12), 'hinge_to place_id 12 is retired; its owner must restore it first, or name another place')
  assert.equal(hingeTargetNestedRefusal(12), 'hinge_to place_id 12 is inside this place or contains it, and walking already joins them; a hinge joins two places where neither holds the other')
})

test('publicHinge accepts only the public far-side shape', () => {
  assert.deepEqual(publicHinge({ place_id: 12, name: 'West Room', parent_id: 3, rough_room: false }), {
    place_id: 12, name: 'West Room', parent_id: 3, rough_room: false,
  })
  for (const value of [
    null,
    [],
    { place_id: 0, name: 'West Room', parent_id: 3, rough_room: false },
    { place_id: 2_147_483_648, name: 'West Room', parent_id: 3, rough_room: false },
    { place_id: 12, name: 'West Room', parent_id: '3', rough_room: false },
    { place_id: 12, name: 'West Room', parent_id: 2_147_483_648, rough_room: false },
    { place_id: 12, name: 'West Room', parent_id: 3, rough_room: 'false' },
  ]) {
    assert.equal(publicHinge(value), null)
  }
})

test('place hinges are recorded as not exported in the snapshot registry', () => {
  assert.deepEqual(
    PUBLIC_SNAPSHOT_CLASS_REGISTRY.find(entry => entry.class_name === 'place_hinges'),
    {
      class_name: 'place_hinges',
      disposition: 'not_exported',
      reason: 'each place hinge_to is a live public place setting not carried by format v3 yet (decision #132); a hinge step is exported as an ordinary move event',
      database_sources: ['places.hinge_to'],
    },
  )
})

test('hinge_to is an accepted place_edit field and is not an ability dial', () => {
  const fields = worldSource.match(/app\.patch\('\/api\/place\/:id',[\s\S]*?const fields = \[([\s\S]*?)\] as const/u)?.[1]
  assert.ok(fields, 'place_edit accepted field list exists')
  assert.match(fields, /'hinge_to'/u)
  assert.equal(PLACE_DIAL_FIELDS.includes('hinge_to' as never), false)
})
