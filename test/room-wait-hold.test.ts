import assert from 'node:assert/strict'
import test from 'node:test'
import { WAIT_POLL_MILLISECONDS, leaseSeconds } from '../src/room-talk-contract.ts'
import { holdWait, type WaitCursors, type WaitRead } from '../src/room-wait-hold.ts'

const START: WaitCursors = Object.freeze({ line: '10', ping: '20' })
const LINE = Object.freeze({
  id: 4,
  place_id: 2,
  author_id: 1,
  author: 'founder',
  body: 'hello',
  body_bytes: 5,
  created_at: '2026-09-24T12:00:00.000Z',
})

function emptyRead(next: WaitCursors = START): WaitRead {
  return Object.freeze({
    lines: Object.freeze([]),
    linesHasMore: false,
    pings: Object.freeze([]),
    pingsHasMore: false,
    next,
    still: 'here',
  })
}

function fakeClock() {
  let time = 0
  const sleeps: number[] = []
  return {
    now: () => time,
    sleeps,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds)
      time += milliseconds
    },
  }
}

test('an arrival on the first read returns at once', async () => {
  const clock = fakeClock()
  const arriving = Object.freeze({ ...emptyRead(), lines: Object.freeze([LINE]) })
  const result = await holdWait({
    seconds: leaseSeconds(10)!,
    start: START,
    read: async cursors => {
      assert.equal(cursors, START)
      return arriving
    },
    closed: () => false,
    sleep: clock.sleep,
    now: clock.now,
  })

  assert.equal(result.reason, 'change')
  assert.deepEqual(result.read.lines, [LINE])
  assert.deepEqual(clock.sleeps, [])
})

test('a line arriving after three polls returns change within one poll', async () => {
  const clock = fakeClock()
  const readTimes: number[] = []
  let reads = 0
  const result = await holdWait({
    seconds: leaseSeconds(10)!,
    start: START,
    read: async () => {
      readTimes.push(clock.now())
      reads += 1
      return reads === 4
        ? Object.freeze({ ...emptyRead(), lines: Object.freeze([LINE]) })
        : emptyRead()
    },
    closed: () => false,
    sleep: clock.sleep,
    now: clock.now,
  })

  assert.equal(result.reason, 'change')
  assert.deepEqual(readTimes, [0, 2_000, 4_000, 6_000])
  assert.deepEqual(clock.sleeps, [WAIT_POLL_MILLISECONDS, WAIT_POLL_MILLISECONDS, WAIT_POLL_MILLISECONDS])
})

test('each poll after an empty read sends the cursors that read returned', async () => {
  const clock = fakeClock()
  const firstNext = Object.freeze({ line: '11', ping: '21' })
  const secondNext = Object.freeze({ line: '12', ping: '22' })
  const seen: WaitCursors[] = []
  const result = await holdWait({
    seconds: leaseSeconds(10)!,
    start: START,
    read: async cursors => {
      seen.push(cursors)
      if (seen.length === 1) return emptyRead(firstNext)
      if (seen.length === 2) return emptyRead(secondNext)
      return Object.freeze({ ...emptyRead(), lines: Object.freeze([LINE]) })
    },
    closed: () => false,
    sleep: clock.sleep,
    now: clock.now,
  })

  assert.equal(result.reason, 'change')
  assert.deepEqual(seen, [START, firstNext, secondNext])
})

test('a move returns moved even when a line also arrived', async () => {
  const result = await holdWait({
    seconds: leaseSeconds(10)!,
    start: START,
    read: async () => Object.freeze({ ...emptyRead(), lines: Object.freeze([LINE]), still: 'moved' }),
    closed: () => false,
    sleep: async () => assert.fail('a moved resident must not sleep'),
    now: () => 0,
  })

  assert.equal(result.reason, 'moved')
  assert.deepEqual(result.read.lines, [LINE])
})

test('a replaced read returns replaced even when a line also arrived, without sleeping', async () => {
  const result = await holdWait({
    seconds: leaseSeconds(10)!,
    start: START,
    read: async () => Object.freeze({ ...emptyRead(), lines: Object.freeze([LINE]), still: 'replaced' }),
    closed: () => false,
    sleep: async () => assert.fail('a replaced wait must not sleep'),
    now: () => 0,
  })

  assert.equal(result.reason, 'replaced')
  assert.deepEqual(result.read.lines, [LINE])
})

test('nothing arriving returns timeout after the asked seconds with polls no closer than two seconds', async () => {
  const clock = fakeClock()
  const readTimes: number[] = []
  const result = await holdWait({
    seconds: leaseSeconds(4)!,
    start: START,
    read: async () => {
      readTimes.push(clock.now())
      return emptyRead()
    },
    closed: () => false,
    sleep: clock.sleep,
    now: clock.now,
  })

  assert.equal(result.reason, 'timeout')
  assert.equal(clock.now(), 4_000)
  assert.deepEqual(readTimes, [0, 2_000, 4_000])
  assert.deepEqual(clock.sleeps, [2_000, 2_000])
})

test('a closed connection ends the loop at the next check', async () => {
  const clock = fakeClock()
  let isClosed = false
  let reads = 0
  const result = await holdWait({
    seconds: leaseSeconds(10)!,
    start: START,
    read: async () => {
      reads += 1
      return emptyRead()
    },
    closed: () => isClosed,
    sleep: async milliseconds => {
      await clock.sleep(milliseconds)
      isClosed = true
    },
    now: clock.now,
  })

  assert.equal(result.reason, 'closed')
  assert.equal(reads, 2)
  assert.equal(clock.now(), WAIT_POLL_MILLISECONDS)
})

test('the last poll happens at the deadline', async () => {
  const clock = fakeClock()
  const readTimes: number[] = []
  let reads = 0
  const result = await holdWait({
    seconds: leaseSeconds(3)!,
    start: START,
    read: async () => {
      readTimes.push(clock.now())
      reads += 1
      return reads === 3
        ? Object.freeze({ ...emptyRead(), lines: Object.freeze([LINE]) })
        : emptyRead()
    },
    closed: () => false,
    sleep: clock.sleep,
    now: clock.now,
  })

  assert.equal(result.reason, 'change')
  assert.deepEqual(readTimes, [0, 2_000, 3_000])
  assert.equal(clock.now(), 3_000)
})
