import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PING_AFTER_ANSWER_MINUTES,
  PING_AFTER_MISS_MINUTES,
  PING_AFTER_NO_HOURS,
  PING_OFFER_MINUTES,
  pingPairWaitRefusal,
  pingSaidNoRefusal,
  pingStillOpenRefusal,
  pingThreeMissesRefusal,
} from '../src/room-talk-contract.ts'
import {
  pairHistoryStart,
  pingAdmission,
  pingStatus,
  type PairPing,
} from '../src/room-ping-rules.ts'

const at = (value: string): Date => new Date(value)

function makePing(overrides: Partial<PairPing> = {}): PairPing {
  return {
    id: 1,
    senderId: 1,
    targetId: 2,
    sentAt: at('2026-09-24T11:00:00.000Z'),
    expiresAt: at('2026-09-24T11:10:00.000Z'),
    answer: null,
    answeredAt: null,
    stillTogether: true,
    ...overrides,
  }
}

test('a ping is offered only before its end and while its residents are still together', () => {
  const ping = makePing()

  assert.equal(pingStatus(ping, at('2026-09-24T11:09:59.999Z')), 'offered')
  assert.equal(pingStatus(ping, at('2026-09-24T11:10:00.000Z')), 'expired')
  assert.equal(pingStatus(makePing({ stillTogether: false }), at('2026-09-24T11:01:00.000Z')), 'expired')
})

test('an answered ping stays answered, an unanswered one past its end or apart is expired, and silence is never no', () => {
  assert.equal(pingStatus(makePing({ answer: 'yes', answeredAt: at('2026-09-24T11:05:00.000Z') }), at('2026-09-24T12:00:00.000Z')), 'answered')
  assert.equal(pingStatus(makePing(), at('2026-09-24T11:10:00.000Z')), 'expired')
  assert.equal(pingStatus(makePing({ stillTogether: false }), at('2026-09-24T11:01:00.000Z')), 'expired')
  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T11:01:00.000Z'), history: [makePing()] }),
    { ok: false, refusal: pingStillOpenRefusal('2026-09-24T11:10:00.000Z') },
  )
})

test('a first ping to a resident is admitted', () => {
  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T12:00:00.000Z'), history: [] }),
    { ok: true },
  )
})

test('a live ping to the same resident is refused as still open until its end', () => {
  const live = makePing({ sentAt: at('2026-09-24T11:55:00.000Z'), expiresAt: at('2026-09-24T12:05:00.000Z') })

  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T12:00:00.000Z'), history: [live] }),
    { ok: false, refusal: pingStillOpenRefusal('2026-09-24T12:05:00.000Z') },
  )
})

test('after an answered ping the pair waits 15 minutes from when it was sent', () => {
  const answered = makePing({ sentAt: at('2026-09-24T12:00:00.000Z'), answer: 'yes', answeredAt: at('2026-09-24T12:02:00.000Z') })

  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T12:14:59.000Z'), history: [answered] }),
    { ok: false, refusal: pingPairWaitRefusal('2026-09-24T12:15:00.000Z') },
  )
  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T12:15:00.000Z'), history: [answered] }),
    { ok: true },
  )
  assert.equal(PING_AFTER_ANSWER_MINUTES, 15)
})

test('after a missed ping the pair waits 30 minutes from its window close, even when a move ended it early', () => {
  const endedEarly = makePing({
    sentAt: at('2026-09-24T11:00:00.000Z'),
    expiresAt: at('2026-09-24T11:10:00.000Z'),
    stillTogether: false,
  })

  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T11:01:00.000Z'), history: [endedEarly] }),
    { ok: false, refusal: pingPairWaitRefusal('2026-09-24T11:40:00.000Z') },
  )
  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T11:40:00.000Z'), history: [endedEarly] }),
    { ok: true },
  )
  assert.equal(PING_AFTER_MISS_MINUTES, 30)
})

test('in_a_moment counts as answered, never as a miss or a no', () => {
  const history = [
    makePing({ id: 1, sentAt: at('2026-09-24T10:00:00.000Z'), expiresAt: at('2026-09-24T10:10:00.000Z'), answer: 'in_a_moment', answeredAt: at('2026-09-24T10:02:00.000Z') }),
    makePing({ id: 2, sentAt: at('2026-09-24T10:30:00.000Z'), expiresAt: at('2026-09-24T10:40:00.000Z'), answer: 'in_a_moment', answeredAt: at('2026-09-24T10:31:00.000Z') }),
    makePing({ id: 3, sentAt: at('2026-09-24T11:00:00.000Z'), expiresAt: at('2026-09-24T11:10:00.000Z'), answer: 'in_a_moment', answeredAt: at('2026-09-24T11:01:00.000Z') }),
  ]

  assert.equal(pingStatus(history[2]!, at('2026-09-24T12:00:00.000Z')), 'answered')
  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T12:00:00.000Z'), history }),
    { ok: true },
  )
})

test('three missed pings in one UTC day stop the pair until the next UTC midnight, and a new day starts clean', () => {
  const misses = [
    makePing({ id: 1, sentAt: at('2026-09-24T10:00:00.000Z'), expiresAt: at('2026-09-24T10:10:00.000Z') }),
    makePing({ id: 2, sentAt: at('2026-09-24T10:30:00.000Z'), expiresAt: at('2026-09-24T10:40:00.000Z') }),
    makePing({ id: 3, sentAt: at('2026-09-24T11:00:00.000Z'), expiresAt: at('2026-09-24T11:10:00.000Z') }),
  ]

  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T12:00:00.000Z'), history: misses }),
    { ok: false, refusal: pingThreeMissesRefusal('2026-09-25T00:00:00.000Z') },
  )
  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-25T00:01:00.000Z'), history: misses }),
    { ok: true },
  )
})

test('a no stops the sender for 24 hours from the answer, and a ping from the target after it lifts the stop', () => {
  const saidNo = makePing({
    sentAt: at('2026-09-24T11:00:00.000Z'),
    answer: 'no',
    answeredAt: at('2026-09-24T11:05:00.000Z'),
  })
  const targetPing = makePing({
    id: 2,
    senderId: 2,
    targetId: 1,
    sentAt: at('2026-09-24T11:06:00.000Z'),
  })

  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T12:00:00.000Z'), history: [saidNo] }),
    { ok: false, refusal: pingSaidNoRefusal('2026-09-25T11:05:00.000Z') },
  )
  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T12:00:00.000Z'), history: [saidNo, targetPing] }),
    { ok: true },
  )
  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-25T11:05:00.000Z'), history: [saidNo] }),
    { ok: true },
  )
  assert.equal(PING_AFTER_NO_HOURS, 24)
})

test('a no outranks every other rule, and three misses outrank the pair wait', () => {
  const misses = [
    makePing({ id: 1, sentAt: at('2026-09-24T10:00:00.000Z'), expiresAt: at('2026-09-24T10:10:00.000Z') }),
    makePing({ id: 2, sentAt: at('2026-09-24T10:30:00.000Z'), expiresAt: at('2026-09-24T10:40:00.000Z') }),
    makePing({ id: 3, sentAt: at('2026-09-24T11:00:00.000Z'), expiresAt: at('2026-09-24T11:10:00.000Z') }),
  ]
  const no = makePing({ id: 4, sentAt: at('2026-09-24T11:50:00.000Z'), answer: 'no', answeredAt: at('2026-09-24T11:55:00.000Z') })

  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T12:00:00.000Z'), history: [...misses, no] }),
    { ok: false, refusal: pingSaidNoRefusal('2026-09-25T11:55:00.000Z') },
  )
  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T12:00:00.000Z'), history: misses }),
    { ok: false, refusal: pingThreeMissesRefusal('2026-09-25T00:00:00.000Z') },
  )
})

test('only the sender-to-target direction counts toward that sender\'s limits', () => {
  const oppositeDirection = [
    makePing({ id: 1, senderId: 2, targetId: 1, sentAt: at('2026-09-24T10:00:00.000Z'), expiresAt: at('2026-09-24T10:10:00.000Z') }),
    makePing({ id: 2, senderId: 2, targetId: 1, sentAt: at('2026-09-24T10:30:00.000Z'), expiresAt: at('2026-09-24T10:40:00.000Z') }),
    makePing({ id: 3, senderId: 2, targetId: 1, sentAt: at('2026-09-24T11:00:00.000Z'), expiresAt: at('2026-09-24T11:10:00.000Z') }),
  ]

  assert.deepEqual(
    pingAdmission({ senderId: 1, targetId: 2, now: at('2026-09-24T12:00:00.000Z'), history: oppositeDirection }),
    { ok: true },
  )
})

test('the history window reaches back to the earlier of UTC midnight and 24 hours 10 minutes', () => {
  const now = at('2026-09-24T12:00:00.000Z')
  const earlier = at('2026-09-23T11:50:00.000Z')

  assert.equal(pairHistoryStart(now).toISOString(), earlier.toISOString())
  assert.equal(pairHistoryStart(now).getTime(), Math.min(
    at('2026-09-24T00:00:00.000Z').getTime(),
    now.getTime() - (PING_AFTER_NO_HOURS * 60 + PING_OFFER_MINUTES) * 60_000,
  ))
})
