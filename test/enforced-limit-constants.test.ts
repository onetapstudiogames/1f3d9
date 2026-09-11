import assert from 'node:assert/strict'
import test from 'node:test'
import { IDENTITY_LIMITS, IDENTITY_STAGE_INTERVAL } from '../src/identity-limits.ts'
import { collectRecoveryCodeSet } from '../src/identity-browser.ts'
import {
  MAX_PAIR_JSON_BYTES,
  PAIRING_CODE_TTL_MINUTES,
  PAIR_MINTS_PER_RESIDENT_PER_HOUR,
} from '../src/pair.ts'
import { AGREEMENT_BYTES, MAX_PARTIES, NOTE_CHARACTERS } from '../src/society.ts'
import {
  RESIDENT_LOOKING_READ_LIMIT,
  RESIDENT_LOOKING_REFRESH_SECONDS,
  RESIDENT_LOOKING_TTL_SECONDS,
} from '../src/resident-looking.ts'

test('identity limits are one immutable public contract', () => {
  assert.equal(Object.isFrozen(IDENTITY_LIMITS), true)
  assert.equal(IDENTITY_LIMITS.bodyBytes, 8_192)
  assert.equal(IDENTITY_LIMITS.stageMinutes, 15)
  assert.equal(IDENTITY_STAGE_INTERVAL, '15 minutes')
  assert.equal(IDENTITY_LIMITS.recoveryCodeCount, 8)

  let index = 0
  const codes = collectRecoveryCodeSet(() => `code-${index += 1}`)
  assert.equal(codes.length, IDENTITY_LIMITS.recoveryCodeCount)
})

test('pairing, agreement, and looking limits are exported for published facts', () => {
  assert.equal(MAX_PAIR_JSON_BYTES, 4_096)
  assert.equal(PAIR_MINTS_PER_RESIDENT_PER_HOUR, 20)
  assert.equal(PAIRING_CODE_TTL_MINUTES, 10)
  assert.equal(NOTE_CHARACTERS, 4_000)
  assert.equal(AGREEMENT_BYTES, 65_536)
  assert.equal(MAX_PARTIES, 32)
  assert.equal(RESIDENT_LOOKING_TTL_SECONDS, 60)
  assert.equal(RESIDENT_LOOKING_REFRESH_SECONDS, 5)
  assert.equal(RESIDENT_LOOKING_READ_LIMIT, 200)
})
