// A room owner's wake_label_seconds (decision #131): the parts that need no database.
import assert from 'node:assert/strict'
import test from 'node:test'
import { REFERENCE, REFERENCE_SECTIONS } from '../src/door.ts'
import { WAKE_LABEL_SECONDS_MIN } from '../src/engine-limits.ts'
import { RESIDENT_ABILITY_LABEL_SECONDS } from '../src/physics.ts'
import { PLACE_DIAL_FIELDS, parsePlaceDials } from '../src/place-abilities.ts'
import { PUBLIC_SNAPSHOT_CLASS_REGISTRY } from '../src/public-snapshot-format.ts'

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

test('the dated public snapshots name wake_label_seconds among the ability columns they do not carry yet', () => {
  const abilityRuntime = PUBLIC_SNAPSHOT_CLASS_REGISTRY.find(entry => entry.class_name === 'ability_runtime')
  assert.equal(abilityRuntime?.disposition, 'not_exported')
  assert.equal(abilityRuntime?.database_sources.includes('places.wake_label_seconds'), true)
})

test('the served reference says how long a wake sticker lasts and lists wake_label_seconds with the room dials', () => {
  const abilities = (REFERENCE_SECTIONS.abilities ?? '').replace(/\s+/gu, ' ')
  const placeEditPage = (REFERENCE_SECTIONS.mcp ?? '').replace(/\s+/gu, ' ')
  const full = REFERENCE.replace(/\s+/gu, ' ')
  for (const sentence of [
    "Going home is never blocked anywhere, and a sticker a waking thing puts on you expires after the room's wake_label_seconds, 24 hours unless its owner set it shorter.",
    "A reach over residents may only sticker, check, roll, and write, and its stickers on residents expire after 24 hours, or after the room's wake_label_seconds when a waking thing reaches.",
    'wake_random_cap, 0 to 32, default 8; wake_label_seconds, 10 to 86400, default 86400 (24 hours), how long a sticker a thing waking here puts on a resident lasts; and rough_room, default false.',
    'Changing wake_label_seconds changes only stickers put on afterward, never one already on a resident.',
  ]) {
    assert.ok(abilities.includes(sentence), `abilities page: ${sentence}`)
    assert.ok(full.includes(sentence), `full reference: ${sentence}`)
  }
  const placeEdit = 'wake_block_residents, wake_random_cap, wake_label_seconds, and rough_room, with ranges under WHAT THINGS CAN DO.'
  assert.ok(placeEditPage.includes(placeEdit), 'the place edit section lists the new dial')
  assert.ok(full.includes(placeEdit), 'the full reference lists the new dial')
  assert.equal(full.includes('a sticker a waking thing puts on you expires after 24 hours.'), false,
    'the old fixed-life sentence is gone')
})
