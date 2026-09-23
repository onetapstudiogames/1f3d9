import test from 'node:test'
import assert from 'node:assert/strict'
import {
  lastRoll,
  newRollLog,
  parseRollId,
  rollCommitment,
  rollValue,
  wakePickKey,
  type DrawnRoll,
} from '../src/engine-chance.ts'

const SECRET = 'ab'.repeat(32)

test('roll values follow the published formula', () => {
  // Pinned vectors: first four HMAC-SHA256 bytes, unsigned big-endian, mod sides, plus one.
  assert.equal(rollValue(SECRET, {
    rollId: 1, purpose: 'chance', placeId: 7, sourceThingId: 9, sourceTraitId: 3, sides: 100,
  }), 88)
  assert.equal(rollValue(SECRET, {
    rollId: 42, purpose: 'chance', placeId: 1093, sourceThingId: null, sourceTraitId: null, sides: 100,
  }), 31)
  assert.equal(rollValue(SECRET, {
    rollId: 5, purpose: 'wake_pick', placeId: 7, sourceThingId: null, sourceTraitId: null, sides: 3,
  }), 3)
  assert.equal(
    wakePickKey(SECRET, 12, 34, 0),
    '95999ad3b1c401a80b9ca64bbd13145807b8faeacd0db96a86ba2d4145e24258',
  )
  assert.equal(rollCommitment(SECRET), '9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885')
})

test('every roll lands from 1 to its number of sides', () => {
  for (let rollId = 1; rollId <= 500; rollId += 1) {
    const roll = rollValue(SECRET, {
      rollId, purpose: 'chance', placeId: 3, sourceThingId: rollId, sourceTraitId: 1, sides: 100,
    })
    assert.ok(roll >= 1 && roll <= 100, String(roll))
  }
})

test('write from roll reads the latest roll drawn earlier in the same run', () => {
  const log = newRollLog()
  assert.equal(lastRoll(log), null)
  const drawn = (roll: number): DrawnRoll => ({
    rollId: roll, day: '2026-09-22', commitment: '0'.repeat(64), purpose: 'chance',
    placeId: 1, sourceThingId: null, sourceTraitId: null, authorityId: 1, actionId: null,
    settleId: null, percent: 50, sides: 100, roll, branch: 'then',
  })
  log.rolls.push(drawn(12), drawn(77))
  assert.equal(lastRoll(log), 77)
})

test('roll_id must be a positive whole number', () => {
  assert.equal(parseRollId('1'), 1)
  assert.equal(parseRollId('9007199254740991'), 9_007_199_254_740_991)
  for (const refused of ['0', '-1', '1.5', '01', 'one', '', '99999999999999999']) {
    assert.equal(parseRollId(refused), null, refused)
  }
})
