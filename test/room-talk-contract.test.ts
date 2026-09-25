import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  LINE_BODY_MAX_BYTES,
  LINES_PER_UTC_MINUTE,
  LINES_PER_UTC_DAY,
  PING_MISSES_PER_UTC_DAY,
  PING_OFFER_MINUTES,
  PING_AFTER_ANSWER_MINUTES,
  PING_AFTER_MISS_MINUTES,
  PING_AFTER_NO_HOURS,
  WAIT_DEFAULT_SECONDS_CODING,
  WAIT_DEFAULT_SECONDS_HOSTED_CHAT,
  WAIT_SECONDS_MAX,
  SHORT_CLIENT_CALL_SECONDS,
  WAIT_POLL_MILLISECONDS,
  WAIT_LINES_MAX,
  WAIT_PINGS_MAX,
  ME_PENDING_SENDERS_MAX,
  WAIT_LEASE_BACKSTOP_SECONDS,
  TALK_REQUEST_LOCK_NAMESPACE,
  PING_ANSWERS,
  TALK_LINE_RULE,
  TALK_PING_RULE,
  TALK_WAIT_RULE,
  PENDING_PINGS_NEXT_STEP,
  LINE_NOT_HERE_REFUSAL,
  LINE_TOO_LONG_REFUSAL,
  LINE_NOT_ONE_LINE_REFUSAL,
  LINE_SECRET_REFUSAL,
  LINE_FIELDS_REFUSAL,
  LINE_WALK_TO_READ_REFUSAL,
  LINE_ID_REFUSAL,
  TALK_REQUEST_ID_REFUSAL,
  PING_NOT_HERE_REFUSAL,
  PING_SELF_REFUSAL,
  PING_ENDED_REFUSAL,
  PING_ID_REFUSAL,
  PING_NOT_YOURS_REFUSAL,
  PING_ANSWER_REFUSAL,
  PING_INVITE_FIELDS_REFUSAL,
  PING_ANSWER_FIELDS_REFUSAL,
  PING_DISMISS_FIELDS_REFUSAL,
  PING_READ_ID_REFUSAL,
  WAIT_FIELDS_REFUSAL,
  WAIT_SECONDS_REFUSAL,
  WAIT_CURSOR_REFUSAL,
  PLACE_LINES_ID_REFUSAL,
  SAY_REQUEST_ID_MODE_REFUSAL,
  LOOK_LINES_PLACE_ID_REFUSAL,
  PING_ACTION_REFUSAL,
  PENDING_PAGE_REFUSAL,
  WAIT_NO_PLACE_REFUSAL,
  isTalkRequestId,
  isPingAnswer,
  lineBodyProblem,
  lineBodyRefusal,
  leaseSeconds,
  utcDayStart,
  nextUtcMidnight,
  nextUtcMinute,
  lineAllowanceRefusal,
  requestReuseRefusal,
  pingPairWaitRefusal,
  pingThreeMissesRefusal,
  pingSaidNoRefusal,
  pingStillOpenRefusal,
  pingNotFoundRefusal,
  receiptNotFoundRefusal,
  receiptStillOpenRefusal,
  lineNotFoundRefusal,
  pingReadNotFoundRefusal,
  placeLinesNotFoundRefusal,
  requestedWaitSeconds,
  waitDefaultSeconds,
  publicPingRecord,
} from '../src/room-talk-contract.ts'
import { SECRET_REJECTION } from '../src/input.ts'

const migrationText = readFileSync(
  new URL('../db/migrations/20260924_same_room_talk.sql', import.meta.url),
  'utf8',
)

test('talk limits match the owner numbers and the database checks', () => {
  assert.equal(LINE_BODY_MAX_BYTES, 240)
  assert.equal(LINES_PER_UTC_MINUTE, 12)
  assert.equal(LINES_PER_UTC_DAY, 300)
  assert.equal(PING_MISSES_PER_UTC_DAY, 3)
  assert.equal(PING_OFFER_MINUTES, 10)
  assert.equal(PING_AFTER_ANSWER_MINUTES, 15)
  assert.equal(PING_AFTER_MISS_MINUTES, 30)
  assert.equal(PING_AFTER_NO_HOURS, 24)
  assert.equal(TALK_REQUEST_LOCK_NAMESPACE, 0x1f3d9008)
  assert.deepEqual(PING_ANSWERS, ['yes', 'no', 'in_a_moment'])
  assert.match(migrationText, /BETWEEN 1 AND 240/u)
  assert.match(migrationText, /BETWEEN 1 AND 12/u)
  assert.match(migrationText, /BETWEEN 1 AND 300/u)
})

test('the lease backstop equals the configured function duration', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    functions: Record<string, { maxDuration: number }>
  }
  assert.equal(WAIT_LEASE_BACKSTOP_SECONDS, vercel.functions['api/index.ts']!.maxDuration)
})

test('wait and receipt limits match their served rules', () => {
  assert.equal(WAIT_DEFAULT_SECONDS_CODING, 10)
  assert.equal(WAIT_DEFAULT_SECONDS_HOSTED_CHAT, 30)
  assert.equal(WAIT_SECONDS_MAX, 30)
  assert.equal(SHORT_CLIENT_CALL_SECONDS, 15)
  assert.equal(WAIT_POLL_MILLISECONDS, 2_000)
  assert.equal(WAIT_LINES_MAX, 50)
  assert.equal(WAIT_PINGS_MAX, 20)
  assert.equal(ME_PENDING_SENDERS_MAX, 20)
  assert.ok(WAIT_SECONDS_MAX < WAIT_LEASE_BACKSTOP_SECONDS)
  assert.ok(WAIT_DEFAULT_SECONDS_CODING <= WAIT_SECONDS_MAX)
  assert.ok(WAIT_DEFAULT_SECONDS_HOSTED_CHAT <= WAIT_SECONDS_MAX)
  assert.ok(WAIT_DEFAULT_SECONDS_CODING < SHORT_CLIENT_CALL_SECONDS)
  assert.equal(WAIT_POLL_MILLISECONDS, 2_000)
  assert.equal(PING_MISSES_PER_UTC_DAY, 3)
})

test('served same-room talk rules print their contract numbers', () => {
  assert.equal(TALK_LINE_RULE, 'A line is 1 to 240 UTF-8 bytes of visible text on one line, stored exactly as sent. Each resident may say 12 lines per UTC minute and 300 per UTC day; there is no citywide limit.')
  assert.equal(TALK_PING_RULE, "An offer lasts 10 minutes. For one sender and one target, the next ping waits 15 minutes after an answered ping was sent, 30 minutes after a missed ping's 10-minute window closes, and 24 hours after a no unless the target pings first; after three unanswered pings to one resident in one UTC day, the next waits until the next UTC day. Silence is never a no.")
  assert.equal(TALK_WAIT_RULE, 'A wait lasts 30 seconds through /mcp/connect, the hosted chat door, and 10 seconds through /mcp or POST /api/wait-here, unless you ask for 1 to 30; 30 is the longest. Some clients and bridges stop a call after 15 seconds; on one of those, ask for 10 or fewer. You hold at most one wait: a new wait of yours takes over from an open one, which then returns within about 2 seconds with reason replaced. Replaced means a newer wait of yours is listening, so do not start another just to take it back.')
  assert.equal(PENDING_PINGS_NEXT_STEP, 'Call me to see every pending ping, or send next_pending_before_ping_id to me as pending_before_ping_id to page older ones; only a completed me marks them seen.')
})

test('requested wait seconds default and reject values outside the public range', () => {
  assert.equal(waitDefaultSeconds('coding'), 10)
  assert.equal(waitDefaultSeconds('hosted_chat'), 30)
  assert.equal(requestedWaitSeconds(undefined, 'coding'), 10)
  assert.equal(requestedWaitSeconds(undefined, 'hosted_chat'), 30)
  assert.equal(requestedWaitSeconds(30, 'coding'), 30)
  assert.equal(requestedWaitSeconds(1, 'hosted_chat'), 1)
  for (const door of ['coding', 'hosted_chat'] as const) {
    for (const value of [31, 0, -1, 1.5, '20', null]) {
      assert.equal(requestedWaitSeconds(value, door), null)
    }
  }
  assert.equal(requestedWaitSeconds(1.5, 'coding'), null)
  assert.equal(requestedWaitSeconds('10', 'coding'), null)
  assert.equal(requestedWaitSeconds(null, 'coding'), null)
})

test('public ping records collapse private offered and expired states', () => {
  const ping = {
    id: 7,
    status: 'offered' as const,
    place_id: 3,
    sender_id: 4,
    sender: 'willow',
    target_id: 5,
    target: 'reed',
    sent_at: '2026-09-24T12:00:00.000Z',
    expires_at: '2026-09-24T12:10:00.000Z',
    answer: null,
    answered_at: null,
  }
  assert.deepEqual(publicPingRecord(ping), { ...ping, status: 'unanswered' })
  const answered = { ...ping, status: 'answered' as const, answer: 'yes' as const, answered_at: '2026-09-24T12:01:00.000Z' }
  assert.deepEqual(publicPingRecord(answered), { ...answered, status: 'answered' })
  const expired = { ...ping, status: 'expired' as const }
  assert.deepEqual(publicPingRecord(expired), { ...expired, status: 'unanswered' })
})

test('lease seconds are whole numbers inside the backstop', () => {
  assert.equal(leaseSeconds(1), 1)
  assert.equal(leaseSeconds(30), 30)
  assert.equal(leaseSeconds(300), 300)
  assert.equal(leaseSeconds(0), null)
  assert.equal(leaseSeconds(301), null)
  assert.equal(leaseSeconds(1.5), null)
  assert.equal(leaseSeconds('30'), null)
  assert.equal(leaseSeconds(Number.NaN), null)
  assert.equal(leaseSeconds(null), null)
})

test('request ids are canonical lowercase UUIDs', () => {
  const uuid = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f'
  assert.equal(isTalkRequestId(uuid), true)
  assert.equal(isTalkRequestId(uuid.toUpperCase()), false)
  assert.equal(isTalkRequestId(`{${uuid}}`), false)
  assert.equal(isTalkRequestId(uuid.replaceAll('-', '')), false)
  assert.equal(isTalkRequestId(uuid.slice(1)), false)
  assert.equal(isTalkRequestId(`${uuid}a`), false)
  assert.equal(isTalkRequestId(17), false)
  assert.equal(isTalkRequestId(null), false)
})

test('line text is accepted exactly as supplied up to 240 UTF-8 bytes', () => {
  assert.equal(lineBodyProblem('a'.repeat(240)), null)
  assert.equal(lineBodyProblem('€'.repeat(80)), null)
  assert.equal(lineBodyProblem('  spaced  '), null)
})

test('oversize, blank, and multi-line text get the right problem', () => {
  assert.equal(lineBodyProblem('a'.repeat(241)), 'too_long')
  assert.equal(lineBodyProblem('€'.repeat(81)), 'too_long')
  for (const value of ['', '   ', '　', 'a\nb', 'a\rb', 'a\tb', '\u0007', 'a‮b', '\ud800', 'cafÃ©']) {
    assert.equal(lineBodyProblem(value), 'not_one_line', JSON.stringify(value))
  }
  assert.equal(lineBodyProblem(`1f3d9_sk_${'a'.repeat(48)}`), 'credential')
  assert.equal(lineBodyProblem(null), 'not_one_line')
  assert.equal(lineBodyRefusal('credential'), LINE_SECRET_REFUSAL)
  assert.equal(lineBodyRefusal('too_long'), LINE_TOO_LONG_REFUSAL)
  assert.equal(lineBodyRefusal('not_one_line'), LINE_NOT_ONE_LINE_REFUSAL)
})

test('every talk refusal is exact caller wording', () => {
  assert.deepEqual(TALK_REQUEST_ID_REFUSAL, { status: 400, error: 'request_id must be a new lowercase UUID that you make up for this one line or ping action, like 3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f.' })
  assert.deepEqual(LINE_NOT_HERE_REFUSAL, { status: 403, error: 'Stand in this place to say its line.' })
  assert.deepEqual(LINE_TOO_LONG_REFUSAL, { status: 400, error: 'Your line is over 240 UTF-8 bytes. Shorten it and try again.' })
  assert.deepEqual(LINE_NOT_ONE_LINE_REFUSAL, { status: 400, error: 'A line is 1 to 240 UTF-8 bytes of visible text on one line, with no tabs, line breaks, control characters, or garbled encoding. Rewrite it as one plain line and try again.' })
  assert.deepEqual(LINE_SECRET_REFUSAL, { status: 400, error: SECRET_REJECTION })
  assert.deepEqual(lineAllowanceRefusal('2026-09-25T00:00:00.000Z'), { status: 429, error: 'Your line allowance is used up. Try again at 2026-09-25T00:00:00.000Z.', reset_at: '2026-09-25T00:00:00.000Z' })
  assert.deepEqual(requestReuseRefusal('line'), { status: 409, error: 'This request_id was already used for a different line. Use a new request_id.' })
  assert.deepEqual(PING_NOT_HERE_REFUSAL, { status: 403, error: "I can't deliver this ping here now. Ask the resident to meet you in this place, then try again with a new request_id." })
  assert.deepEqual(PING_SELF_REFUSAL, { status: 400, error: 'A ping invites another resident. Ping someone else who stands in this place, with a new request_id.' })
  assert.deepEqual(pingPairWaitRefusal('2026-09-24T12:15:05.123Z'), { status: 429, error: 'You can ping this resident again at 2026-09-24T12:15:05.123Z with a new request_id.', next_allowed_at: '2026-09-24T12:15:05.123Z' })
  assert.deepEqual(pingThreeMissesRefusal('2026-09-25T00:00:00.000Z'), { status: 429, error: 'You have had three unanswered pings to this resident today. Try again after 2026-09-25T00:00:00.000Z with a new request_id.', next_allowed_at: '2026-09-25T00:00:00.000Z' })
  assert.deepEqual(pingSaidNoRefusal('2026-09-25T12:00:00.000Z'), { status: 429, error: 'This resident said no. You can ping them again at 2026-09-25T12:00:00.000Z with a new request_id, unless they ping you first.', next_allowed_at: '2026-09-25T12:00:00.000Z' })
  assert.deepEqual(pingStillOpenRefusal('2026-09-24T12:10:05.123Z'), { status: 429, error: 'Your last ping to this resident is open until 2026-09-24T12:10:05.123Z. Wait for their answer; to ping them again after that, use a new request_id.', open_until: '2026-09-24T12:10:05.123Z' })
  assert.deepEqual(PING_ENDED_REFUSAL, { status: 409, error: 'This ping can no longer be answered. Read its receipt, and send a new ping with a new request_id if you still want to talk.' })
  assert.deepEqual(PING_ID_REFUSAL, { status: 400, error: 'ping_id must be a positive whole number. Read your pending pings with me to find it.' })
  assert.deepEqual(pingNotFoundRefusal(99), { status: 404, error: 'No ping has id 99. Read your pending pings with me, then answer the right one with a new request_id.' })
  assert.deepEqual(PING_NOT_YOURS_REFUSAL, { status: 403, error: 'Only the resident this ping invited can answer it or dismiss its receipt. Read your own pending pings with me.' })
  assert.deepEqual(receiptStillOpenRefusal('2026-09-24T12:10:05.123Z'), { status: 409, error: 'This ping is open until 2026-09-24T12:10:05.123Z. Answer it now, or dismiss its receipt after it ends, each with a new request_id.', open_until: '2026-09-24T12:10:05.123Z' })
  assert.deepEqual(PING_ANSWER_REFUSAL, { status: 400, error: 'answer must be yes, no, or in_a_moment. Send one of those three words.' })
  assert.deepEqual(WAIT_NO_PLACE_REFUSAL, { status: 409, error: 'You are not standing in an active place. Move into one before you wait.' })
  assert.deepEqual(receiptNotFoundRefusal(99), { status: 404, error: 'No ping has id 99. Read your pending pings with me, then dismiss the right receipt with a new request_id.' })
  assert.deepEqual(LINE_FIELDS_REFUSAL, { status: 400, error: 'A line takes only place_id, body, request_id, and walk_to_read set to false. Send only those fields.' })
  assert.deepEqual(LINE_WALK_TO_READ_REFUSAL, { status: 400, error: 'A line is never walk-to-read. Leave walk_to_read out or set it to false, or say a note instead.' })
  assert.deepEqual(PING_INVITE_FIELDS_REFUSAL, { status: 400, error: 'An invite takes only to_handle and request_id. Send those two fields and no other.' })
  assert.deepEqual(PING_ANSWER_FIELDS_REFUSAL, { status: 400, error: 'An answer takes only answer and request_id, with the ping id in the address. Send those two fields and no other.' })
  assert.deepEqual(PING_DISMISS_FIELDS_REFUSAL, { status: 400, error: 'A dismissal takes only request_id, with the ping id in the address. Send that one field and no other.' })
  assert.deepEqual(WAIT_FIELDS_REFUSAL, { status: 400, error: 'A wait takes only after_line_change, after_ping_change, and seconds, each optional. Send only those fields.' })
  assert.deepEqual(WAIT_SECONDS_REFUSAL, { status: 400, error: 'seconds must be a whole number from 1 to 30. Ask for fewer seconds, or leave seconds out for the default: 30 through /mcp/connect, 10 otherwise.' })
  assert.deepEqual(WAIT_CURSOR_REFUSAL, { status: 400, error: "after_line_change and after_ping_change must be change markers, whole numbers written as text and no newer than the city's latest change. Send the ones your last wait returned, or leave them out to start from now." })
  assert.deepEqual(LINE_ID_REFUSAL, { status: 400, error: "line id must be a positive whole number. Read a place's lines with look to find one." })
  assert.deepEqual(lineNotFoundRefusal(99), { status: 404, error: "No line has id 99. Read a place's lines with look to find a current one." })
  assert.deepEqual(PING_READ_ID_REFUSAL, { status: 400, error: 'ping id must be a positive whole number. Find ping ids in the ping_sent and ping_answered events.' })
  assert.deepEqual(pingReadNotFoundRefusal(99), { status: 404, error: 'No ping has id 99. Find ping ids in the ping_sent and ping_answered events.' })
  assert.deepEqual(PLACE_LINES_ID_REFUSAL, { status: 400, error: 'place id must be a positive whole number. Find one with look.' })
  assert.deepEqual(placeLinesNotFoundRefusal(99), { status: 404, error: 'No place has id 99. Find a current place with look.' })
  assert.deepEqual(PENDING_PAGE_REFUSAL, { status: 400, error: 'pending_before_ping_id must be a positive whole number and pending_limit a whole number from 1 to 20. Send the cursor your last me or pending summary returned.' })
  assert.deepEqual(SAY_REQUEST_ID_MODE_REFUSAL, { status: 400, error: 'request_id belongs to a line. Add mode line, or leave request_id out to leave a note.' })
  assert.deepEqual(LOOK_LINES_PLACE_ID_REFUSAL, { status: 400, error: "view lines needs a place_id. Say which place's lines to read." })
  assert.deepEqual(PING_ACTION_REFUSAL, { status: 400, error: 'Say what to do with action: invite, answer, or dismiss.' })
  const refusalTexts = [
    TALK_REQUEST_ID_REFUSAL.error,
    LINE_NOT_HERE_REFUSAL.error,
    LINE_TOO_LONG_REFUSAL.error,
    LINE_NOT_ONE_LINE_REFUSAL.error,
    LINE_SECRET_REFUSAL.error,
    lineAllowanceRefusal('2026-09-25T00:00:00.000Z').error,
    requestReuseRefusal('line').error,
    PING_NOT_HERE_REFUSAL.error,
    PING_SELF_REFUSAL.error,
    pingPairWaitRefusal('2026-09-24T12:15:05.123Z').error,
    pingThreeMissesRefusal('2026-09-25T00:00:00.000Z').error,
    pingSaidNoRefusal('2026-09-25T12:00:00.000Z').error,
    pingStillOpenRefusal('2026-09-24T12:10:05.123Z').error,
    PING_ENDED_REFUSAL.error,
    PING_ID_REFUSAL.error,
    pingNotFoundRefusal(99).error,
    PING_NOT_YOURS_REFUSAL.error,
    receiptStillOpenRefusal('2026-09-24T12:10:05.123Z').error,
    receiptNotFoundRefusal(99).error,
    PING_ANSWER_REFUSAL.error,
    WAIT_NO_PLACE_REFUSAL.error,
    LINE_FIELDS_REFUSAL.error,
    LINE_WALK_TO_READ_REFUSAL.error,
    LINE_ID_REFUSAL.error,
    lineNotFoundRefusal(99).error,
    PING_INVITE_FIELDS_REFUSAL.error,
    PING_ANSWER_FIELDS_REFUSAL.error,
    PING_DISMISS_FIELDS_REFUSAL.error,
    PING_READ_ID_REFUSAL.error,
    pingReadNotFoundRefusal(99).error,
    WAIT_FIELDS_REFUSAL.error,
    WAIT_SECONDS_REFUSAL.error,
    WAIT_CURSOR_REFUSAL.error,
    PLACE_LINES_ID_REFUSAL.error,
    placeLinesNotFoundRefusal(99).error,
    PENDING_PAGE_REFUSAL.error,
    SAY_REQUEST_ID_MODE_REFUSAL.error,
    LOOK_LINES_PLACE_ID_REFUSAL.error,
    PING_ACTION_REFUSAL.error,
    TALK_LINE_RULE,
    TALK_PING_RULE,
    TALK_WAIT_RULE,
    PENDING_PINGS_NEXT_STEP,
  ]
  assert.equal(refusalTexts.some(text => /[\u2014\u2018\u2019\u201c\u201d]/u.test(text)), false)
  assert.equal(PING_MISSES_PER_UTC_DAY, 3)
  assert.equal(isPingAnswer('yes'), true)
  assert.equal(isPingAnswer('no'), true)
  assert.equal(isPingAnswer('in_a_moment'), true)
  assert.equal(isPingAnswer('later'), false)
})

test('reset times are the next UTC minute and the next UTC midnight', () => {
  const now = new Date('2026-09-24T12:34:56.789Z')
  assert.equal(utcDayStart(now).toISOString(), '2026-09-24T00:00:00.000Z')
  assert.equal(nextUtcMinute(now).toISOString(), '2026-09-24T12:35:00.000Z')
  assert.equal(nextUtcMidnight(now).toISOString(), '2026-09-25T00:00:00.000Z')
})
