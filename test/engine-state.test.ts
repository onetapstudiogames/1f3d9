import test from 'node:test'
import assert from 'node:assert/strict'
import { EngineError } from '../src/engine.ts'
import { applyStateWrite, stateBoxBytes } from '../src/engine-state.ts'

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof EngineError)
    assert.equal(error.status, 409)
    return error.message
  }
  assert.fail('expected a refusal')
}

test('write set, add, and append follow their types', () => {
  let box = applyStateWrite(7, {}, 'visits', 'add', 1).values
  box = applyStateWrite(7, box, 'visits', 'add', 5).values
  box = applyStateWrite(7, box, 'mood', 'set', 'bright').values
  box = applyStateWrite(7, box, 'guests', 'append', 'serein').values
  box = applyStateWrite(7, box, 'open', 'set', false).values
  assert.deepEqual(box, { visits: 6, mood: 'bright', guests: ['serein'], open: false })
  assert.equal(Object.isFrozen(box), true)
})

test('write add refuses a key that holds text, and append refuses a whole number', () => {
  assert.equal(
    refusal(() => applyStateWrite(7, { mood: 'bright' }, 'mood', 'add', 1)),
    'write add needs key mood to hold a whole number; it holds text; use set to replace it first',
  )
  assert.equal(
    refusal(() => applyStateWrite(7, { visits: 3 }, 'visits', 'append', 'x')),
    'write append needs key visits to hold a list of lines; it holds a whole number; use set to replace it first',
  )
  assert.equal(
    refusal(() => applyStateWrite(7, { visits: 999_999_999 }, 'visits', 'add', 2)),
    'write add would move key visits past 1000000000 or below -1000000000; add a smaller amount or set a new value',
  )
})

test('a box holds at most 16 keys and 4096 bytes', () => {
  const full = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`k${index}`, index]))
  assert.equal(
    refusal(() => applyStateWrite(9, full, 'one-more', 'set', 1)),
    'the state box of thing 9 already holds 16 keys; write to a key it has, or its owner can clear the box with thing_edit state_clear',
  )
  assert.doesNotThrow(() => applyStateWrite(9, full, 'k3', 'set', 30))
  // Two-byte characters: ten 200-character lines fit, an eleventh passes 4096 bytes.
  const heavy = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${index}`, 'é'.repeat(200)]))
  assert.ok(stateBoxBytes(heavy) <= 4096)
  assert.equal(
    refusal(() => applyStateWrite(9, heavy, 'last', 'set', 'é'.repeat(200))),
    'the state box of thing 9 would pass 4096 bytes; write a shorter value, or its owner can clear the box with thing_edit state_clear',
  )
})

test('append drops the oldest lines until the box fits and records trimmed', () => {
  const line = (index: number) => `${String(index).padStart(3, '0')}${'g'.repeat(197)}`
  let box: Readonly<Record<string, unknown>> = { note: 'kept beside the guestbook' }
  let trimmedTotal = 0
  for (let index = 0; index < 21; index += 1) {
    const written = applyStateWrite(3, box as never, 'guests', 'append', line(index))
    box = written.values
    trimmedTotal += written.trimmed
  }
  const guests = box.guests as string[]
  assert.equal(guests.at(-1), line(20), 'the newest line always lands')
  assert.ok(guests.length <= 20)
  assert.ok(stateBoxBytes(box as never) <= 4096)
  assert.equal(guests[0], line(21 - guests.length), 'only the oldest lines were dropped')
  assert.equal(trimmedTotal, 21 - guests.length)
  assert.equal(box.note, 'kept beside the guestbook')

  let short: Readonly<Record<string, unknown>> = {}
  for (let index = 0; index < 21; index += 1) {
    short = applyStateWrite(3, short as never, 'guests', 'append', `guest-${index}`).values
  }
  assert.deepEqual((short.guests as string[]).slice(0, 2), ['guest-1', 'guest-2'], 'a list keeps its newest 20')
})
