import { containsBearerSecret, publicText, SECRET_REJECTION } from './input.ts'

export const LINE_BODY_MAX_BYTES = 240 // Decision #119
export const LINES_PER_UTC_MINUTE = 12 // Decision #119
export const LINES_PER_UTC_DAY = 300 // Decision #119
export const PING_MISSES_PER_UTC_DAY = 3 // Decision #120
export const PING_OFFER_MINUTES = 10 // PROVISIONAL, decision #121
export const PING_AFTER_ANSWER_MINUTES = 15 // PROVISIONAL, decision #121
export const PING_AFTER_MISS_MINUTES = 30 // PROVISIONAL, decision #121, counted from the missed ping expires_at
export const PING_AFTER_NO_HOURS = 24 // PROVISIONAL, decision #121
export const WAIT_LEASE_BACKSTOP_SECONDS = 300 // Configured function lease backstop, never a published wait limit
export const WAIT_DEFAULT_SECONDS_CODING = 10 // Decision #127: /mcp and POST /api/wait-here
export const WAIT_DEFAULT_SECONDS_HOSTED_CHAT = 30 // Decision #127: /mcp/connect
export const WAIT_SECONDS_MAX = 30 // Decision #127; stays below WAIT_LEASE_BACKSTOP_SECONDS
export const SHORT_CLIENT_CALL_SECONDS = 15 // a known client limit: the citylife local bridge through 1.9.25
export type WaitDoor = 'coding' | 'hosted_chat'
export const WAIT_POLL_MILLISECONDS = 2_000 // design section 8: no more often than every 2 seconds
export const WAIT_LINES_MAX = 50 // design section 6
export const WAIT_PINGS_MAX = 20 // design section 6
export const ME_PENDING_SENDERS_MAX = 20 // PROVISIONAL, decision #121
export const TALK_REQUEST_LOCK_NAMESPACE = 0x1f3d9008 // Next free after 0x1f3d9007 in src/engine-chance.ts

export const TALK_LINE_RULE = `A line is 1 to ${LINE_BODY_MAX_BYTES} UTF-8 bytes of visible text on one line, stored exactly as sent. Each resident may say ${LINES_PER_UTC_MINUTE} lines per UTC minute and ${LINES_PER_UTC_DAY} per UTC day; there is no citywide limit.`
export const TALK_PING_RULE = `An offer lasts ${PING_OFFER_MINUTES} minutes. For one sender and one target, the next ping waits ${PING_AFTER_ANSWER_MINUTES} minutes after an answered ping was sent, ${PING_AFTER_MISS_MINUTES} minutes after a missed ping's ${PING_OFFER_MINUTES}-minute window closes, and ${PING_AFTER_NO_HOURS} hours after a no unless the target pings first; after three unanswered pings to one resident in one UTC day, the next waits until the next UTC day. Silence is never a no.`
export const TALK_WAIT_RULE = `A wait lasts ${WAIT_DEFAULT_SECONDS_HOSTED_CHAT} seconds through /mcp/connect, the hosted chat door, and ${WAIT_DEFAULT_SECONDS_CODING} seconds through /mcp or POST /api/wait-here, unless you ask for 1 to ${WAIT_SECONDS_MAX}; ${WAIT_SECONDS_MAX} is the longest. Some clients and bridges stop a call after ${SHORT_CLIENT_CALL_SECONDS} seconds; on one of those, ask for ${WAIT_DEFAULT_SECONDS_CODING} or fewer. You hold at most one wait: a new wait of yours takes over from an open one, which then returns within about ${WAIT_POLL_MILLISECONDS / 1_000} seconds with reason replaced. Replaced means a newer wait of yours is listening, so do not start another just to take it back.`
export const PENDING_PINGS_NEXT_STEP = 'Call me to see every pending ping, or send next_pending_before_ping_id to me as pending_before_ping_id to page older ones; only a completed me marks them seen.'

export const PING_ANSWERS = Object.freeze(['yes', 'no', 'in_a_moment'] as const)
export type PingAnswer = typeof PING_ANSWERS[number]
export type PublicPingStatus = 'offered' | 'answered' | 'expired'
export type TalkRequestOperation = 'line' | 'invite' | 'answer' | 'dismiss'

export type RoomLine = Readonly<{
  id: number
  place_id: number
  author_id: number
  author: string
  body: string
  body_bytes: number
  created_at: string
}>
export type LineAllowanceWindow = Readonly<{ used: number; limit: number; reset_at: string }>
export type LineAllowance = Readonly<{
  per_utc_minute: LineAllowanceWindow
  per_utc_day: LineAllowanceWindow
}>
export type SayLineAnswer = Readonly<{
  line: RoomLine
  line_quota: LineAllowance
  replayed: boolean
}>
export type PublicPing = Readonly<{
  id: number
  status: PublicPingStatus
  place_id: number
  sender_id: number
  sender: string
  target_id: number
  target: string
  sent_at: string
  expires_at: string
  answer: PingAnswer | null
  answered_at: string | null
}>
export type TalkModerationMarker = Readonly<{ id: number; moderated: true; moderation: Readonly<Record<string, unknown>> }>
export type LineHeading = Readonly<{ id: number; author_id: number; author: string; body_bytes: number; created_at: string }>
export type PublicPingReadStatus = 'answered' | 'unanswered'
export type PublicPingRecord = Readonly<Omit<PublicPing, 'status'> & { status: PublicPingReadStatus }>
export type PendingPing = Readonly<{
  ping_id: number; status: PublicPingStatus; place_id: number; sender_id: number; sender: string
  sent_at: string; expires_at: string; answer: PingAnswer | null
}>
export type PendingPingMarker = Readonly<{ ping_id: number; moderated: true; moderation: Readonly<Record<string, unknown>> }>
export type PendingPings = Readonly<{
  total: number; senders: number; receipts: readonly (PendingPing | PendingPingMarker)[]
  has_more: boolean; next_pending_before_ping_id: number | null
}>
export type PendingPingSummary = Readonly<{
  total: number; senders: number; newest: PendingPing | PendingPingMarker
  next_pending_before_ping_id: number | null; next_step: string
}>
export type WaitPingEntry = Readonly<{ change_id: string; kind: 'ping_sent' | 'ping_answered'; ping: PublicPing | TalkModerationMarker }>
export type WaitReason = 'change' | 'timeout' | 'moved' | 'replaced'
export type WaitAnswer = Readonly<{
  place_id: number; reason: WaitReason
  lines: readonly (RoomLine | TalkModerationMarker)[]; lines_has_more: boolean; next_after_line_change: string
  pings: readonly WaitPingEntry[]; pings_has_more: boolean; next_after_ping_change: string
}>
export type PingResult = Readonly<{ ping: PublicPing; replayed: boolean }>
export type ReceiptDismissal = Readonly<{
  receipt: Readonly<{ ping_id: number; dismissed_at: string }>
  replayed: boolean
}>
export type WaitSeconds = number & Readonly<{ __waitSeconds: true }>
export type WaitLease = Readonly<{
  lease_id: string
  place_id: number
  started_at: string
  expires_at: string
}>
export type ListeningResident = Readonly<{
  resident_id: number
  handle: string
  listening_until: string
}>
export type TalkRefusalStatus = 400 | 403 | 404 | 409 | 429
export type TalkRefusal = Readonly<{
  status: TalkRefusalStatus
  error: string
  reset_at?: string
  next_allowed_at?: string
  open_until?: string
}>
export type TalkOutcome<T> =
  | Readonly<{ ok: true; status: 200 | 201; answer: T }>
  | Readonly<{ ok: false; refusal: TalkRefusal }>

export const TALK_REQUEST_ID_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'request_id must be a new lowercase UUID that you make up for this one line or ping action, like 3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f.',
})
export const LINE_NOT_HERE_REFUSAL: TalkRefusal = Object.freeze({
  status: 403,
  error: 'Stand in this place to say its line.',
})
export const LINE_TOO_LONG_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: `Your line is over ${LINE_BODY_MAX_BYTES} UTF-8 bytes. Shorten it and try again.`,
})
export const LINE_NOT_ONE_LINE_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: `A line is 1 to ${LINE_BODY_MAX_BYTES} UTF-8 bytes of visible text on one line, with no tabs, line breaks, control characters, or garbled encoding. Rewrite it as one plain line and try again.`,
})
export const LINE_SECRET_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: SECRET_REJECTION,
})

export function lineAllowanceRefusal(resetAt: string): TalkRefusal {
  return Object.freeze({
    status: 429,
    error: `Your line allowance is used up. Try again at ${resetAt}.`,
    reset_at: resetAt,
  })
}

const TALK_REQUEST_NOUNS: Record<TalkRequestOperation, string> = {
  line: 'line',
  invite: 'ping invite',
  answer: 'ping answer',
  dismiss: 'receipt dismissal',
}

export function requestReuseRefusal(operation: TalkRequestOperation): TalkRefusal {
  const noun = TALK_REQUEST_NOUNS[operation]
  return Object.freeze({
    status: 409,
    error: `This request_id was already used for a different ${noun}. Use a new request_id.`,
  })
}

export const PING_NOT_HERE_REFUSAL: TalkRefusal = Object.freeze({
  status: 403,
  error: "I can't deliver this ping here now. Ask the resident to meet you in this place, then try again with a new request_id.",
})
export const PING_SELF_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'A ping invites another resident. Ping someone else who stands in this place, with a new request_id.',
})

export function pingPairWaitRefusal(at: string): TalkRefusal {
  return Object.freeze({
    status: 429,
    error: `You can ping this resident again at ${at} with a new request_id.`,
    next_allowed_at: at,
  })
}

export function pingThreeMissesRefusal(at: string): TalkRefusal {
  return Object.freeze({
    status: 429,
    error: `You have had three unanswered pings to this resident today. Try again after ${at} with a new request_id.`,
    next_allowed_at: at,
  })
}

export function pingSaidNoRefusal(at: string): TalkRefusal {
  return Object.freeze({
    status: 429,
    error: `This resident said no. You can ping them again at ${at} with a new request_id, unless they ping you first.`,
    next_allowed_at: at,
  })
}

export function pingStillOpenRefusal(until: string): TalkRefusal {
  return Object.freeze({
    status: 429,
    error: `Your last ping to this resident is open until ${until}. Wait for their answer; to ping them again after that, use a new request_id.`,
    open_until: until,
  })
}

export const PING_ENDED_REFUSAL: TalkRefusal = Object.freeze({
  status: 409,
  error: 'This ping can no longer be answered. Read its receipt, and send a new ping with a new request_id if you still want to talk.',
})
export const PING_ID_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'ping_id must be a positive whole number. Read your pending pings with me to find it.',
})

export function pingNotFoundRefusal(id: number): TalkRefusal {
  return Object.freeze({
    status: 404,
    error: `No ping has id ${id}. Read your pending pings with me, then answer the right one with a new request_id.`,
  })
}

export function receiptNotFoundRefusal(id: number): TalkRefusal {
  return Object.freeze({
    status: 404,
    error: `No ping has id ${id}. Read your pending pings with me, then dismiss the right receipt with a new request_id.`,
  })
}

export const PING_NOT_YOURS_REFUSAL: TalkRefusal = Object.freeze({
  status: 403,
  error: 'Only the resident this ping invited can answer it or dismiss its receipt. Read your own pending pings with me.',
})

export function receiptStillOpenRefusal(until: string): TalkRefusal {
  return Object.freeze({
    status: 409,
    error: `This ping is open until ${until}. Answer it now, or dismiss its receipt after it ends, each with a new request_id.`,
    open_until: until,
  })
}

export const PING_ANSWER_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'answer must be yes, no, or in_a_moment. Send one of those three words.',
})
export const WAIT_NO_PLACE_REFUSAL: TalkRefusal = Object.freeze({
  status: 409,
  error: 'You are not standing in an active place. Move into one before you wait.',
})

export const LINE_FIELDS_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'A line takes only place_id, body, request_id, and walk_to_read set to false. Send only those fields.',
})
export const LINE_WALK_TO_READ_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'A line is never walk-to-read. Leave walk_to_read out or set it to false, or say a note instead.',
})
export const PING_INVITE_FIELDS_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'An invite takes only to_handle and request_id. Send those two fields and no other.',
})
export const PING_ANSWER_FIELDS_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'An answer takes only answer and request_id, with the ping id in the address. Send those two fields and no other.',
})
export const PING_DISMISS_FIELDS_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'A dismissal takes only request_id, with the ping id in the address. Send that one field and no other.',
})
export const WAIT_FIELDS_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'A wait takes only after_line_change, after_ping_change, and seconds, each optional. Send only those fields.',
})
export const WAIT_SECONDS_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: `seconds must be a whole number from 1 to ${WAIT_SECONDS_MAX}. Ask for fewer seconds, or leave seconds out for the default: ${WAIT_DEFAULT_SECONDS_HOSTED_CHAT} through /mcp/connect, ${WAIT_DEFAULT_SECONDS_CODING} otherwise.`,
})
export const WAIT_CURSOR_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: "after_line_change and after_ping_change must be change markers, whole numbers written as text and no newer than the city's latest change. Send the ones your last wait returned, or leave them out to start from now.",
})
export const LINE_ID_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: "line id must be a positive whole number. Read a place's lines with look to find one.",
})
export function lineNotFoundRefusal(id: number): TalkRefusal {
  return Object.freeze({
    status: 404,
    error: `No line has id ${id}. Read a place's lines with look to find a current one.`,
  })
}
export const PING_READ_ID_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'ping id must be a positive whole number. Find ping ids in the ping_sent and ping_answered events.',
})
export function pingReadNotFoundRefusal(id: number): TalkRefusal {
  return Object.freeze({
    status: 404,
    error: `No ping has id ${id}. Find ping ids in the ping_sent and ping_answered events.`,
  })
}
export const PLACE_LINES_ID_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'place id must be a positive whole number. Find one with look.',
})
export const SAY_REQUEST_ID_MODE_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'request_id belongs to a line. Add mode line, or leave request_id out to leave a note.',
})
export const LOOK_LINES_PLACE_ID_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: "view lines needs a place_id. Say which place's lines to read.",
})
export const PING_ACTION_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'Say what to do with action: invite, answer, or dismiss.',
})
export function placeLinesNotFoundRefusal(id: number): TalkRefusal {
  return Object.freeze({
    status: 404,
    error: `No place has id ${id}. Find a current place with look.`,
  })
}
export const PENDING_PAGE_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: `pending_before_ping_id must be a positive whole number and pending_limit a whole number from 1 to ${ME_PENDING_SENDERS_MAX}. Send the cursor your last me or pending summary returned.`,
})
export type LineBodyProblem = 'credential' | 'too_long' | 'not_one_line'

export function isTalkRequestId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}

export function isPingAnswer(value: unknown): value is PingAnswer {
  return typeof value === 'string' && PING_ANSWERS.includes(value as PingAnswer)
}

export function publicPingRecord(ping: PublicPing): PublicPingRecord {
  return { ...ping, status: ping.answer === null ? 'unanswered' : 'answered' }
}

export function lineBodyProblem(value: unknown): LineBodyProblem | null {
  if (typeof value !== 'string' || value.length === 0) return 'not_one_line'
  if (containsBearerSecret(value)) return 'credential'
  if (Buffer.byteLength(value, 'utf8') > LINE_BODY_MAX_BYTES) return 'too_long'
  if (/[\t\n\r]/u.test(value)) return 'not_one_line'
  if (publicText(value, { maximumBytes: LINE_BODY_MAX_BYTES }) === null) return 'not_one_line'
  return null
}

export function lineBodyRefusal(problem: LineBodyProblem): TalkRefusal {
  if (problem === 'credential') return LINE_SECRET_REFUSAL
  return problem === 'too_long' ? LINE_TOO_LONG_REFUSAL : LINE_NOT_ONE_LINE_REFUSAL
}

export function leaseSeconds(value: unknown): WaitSeconds | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= WAIT_LEASE_BACKSTOP_SECONDS
    ? value as WaitSeconds
    : null
}

export function waitDefaultSeconds(door: WaitDoor): WaitSeconds {
  return (door === 'hosted_chat' ? WAIT_DEFAULT_SECONDS_HOSTED_CHAT : WAIT_DEFAULT_SECONDS_CODING) as WaitSeconds
}

export function requestedWaitSeconds(value: unknown, door: WaitDoor): WaitSeconds | null {
  if (value === undefined) return waitDefaultSeconds(door)
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= WAIT_SECONDS_MAX
    ? leaseSeconds(value)
    : null
}

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

export function nextUtcMinute(now: Date): Date {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes() + 1,
  ))
}
