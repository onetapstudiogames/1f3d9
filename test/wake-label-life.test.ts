// A room owner's wake_label_seconds (decision #131): the parts that need no database.
import assert from 'node:assert/strict'
import test from 'node:test'
import { WAKE_LABEL_SECONDS_MIN } from '../src/engine-limits.ts'
import { RESIDENT_ABILITY_LABEL_SECONDS } from '../src/physics.ts'
import { PLACE_DIAL_FIELDS, parsePlaceDials } from '../src/place-abilities.ts'

test('wake_label_seconds is a place dial from 10 to 86400 seconds, and 24 hours stays the longest', () => {
  assert.equal(WAKE_LABEL_SECONDS_MIN, 10, 'the floor is 10 seconds, the same as the shortest wake clock')
  assert.equal(RESIDENT_ABILITY_LABEL_SECONDS, 86_400)
  assert.equal((PLACE_DIAL_FIELDS as readonly string[]).includes('wake_label_seconds'), true)
  for (const seconds of [10, 1_200, 86_400]) {
    assert.deepEqual(parsePlaceDials({ wake_label_seconds: seconds }), { ok: true, dials: { wakeLabelSeconds: seconds } })
  }
  for (const wrong of [9, 86_401, 0, -60, 1_200.5, '1200', null, true]) {
    assert.deepEqual(parsePlaceDials({ wake_label_seconds: wrong }), { ok: false, error: 'wake_label_seconds must be a whole number from 10 to 86400' })
  }
  assert.deepEqual(parsePlaceDials({ wake_random_cap: 4 }), { ok: true, dials: { wakeRandomCap: 4 } },
    'a body without the dial leaves it as it was')
})
