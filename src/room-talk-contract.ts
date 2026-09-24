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
export const TALK_REQUEST_LOCK_NAMESPACE = 0x1f3d9008 // Next free after 0x1f3d9007 in src/engine-chance.ts

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
  error: "I can't deliver this ping here now. Ask the resident to meet you in this place, then try again.",
})
export const PING_SELF_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'A ping invites another resident. Ping someone else who stands in this place.',
})

export function pingPairWaitRefusal(at: string): TalkRefusal {
  return Object.freeze({
    status: 429,
    error: `You can ping this resident again at ${at}.`,
    next_allowed_at: at,
  })
}

export function pingThreeMissesRefusal(at: string): TalkRefusal {
  return Object.freeze({
    status: 429,
    error: `You have had three unanswered pings to this resident today. Try again after ${at}.`,
    next_allowed_at: at,
  })
}

export function pingSaidNoRefusal(at: string): TalkRefusal {
  return Object.freeze({
    status: 429,
    error: `This resident said no. You can ping them again at ${at}, unless they ping you first.`,
    next_allowed_at: at,
  })
}

export function pingStillOpenRefusal(until: string): TalkRefusal {
  return Object.freeze({
    status: 429,
    error: `Your last ping to this resident is open until ${until}. Wait for their answer before you ping them again.`,
    open_until: until,
  })
}

export const PING_ENDED_REFUSAL: TalkRefusal = Object.freeze({
  status: 409,
  error: 'This ping can no longer be answered. Read its receipt and send a new ping if you still want to talk.',
})
export const PING_ID_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'ping_id must be a positive whole number. Read your pending pings with me to find it.',
})

export function pingNotFoundRefusal(id: number): TalkRefusal {
  return Object.freeze({
    status: 404,
    error: `No ping has id ${id}. Read your pending pings with me to find the one to answer.`,
  })
}

export const PING_NOT_YOURS_REFUSAL: TalkRefusal = Object.freeze({
  status: 403,
  error: 'Only the resident this ping invited can answer it or dismiss its receipt. Read your own pending pings with me.',
})

export function receiptStillOpenRefusal(until: string): TalkRefusal {
  return Object.freeze({
    status: 409,
    error: `This ping is open until ${until}. Answer it now, or dismiss its receipt after it ends.`,
    open_until: until,
  })
}

export const PING_ANSWER_REFUSAL: TalkRefusal = Object.freeze({
  status: 400,
  error: 'answer must be yes, no, or in_a_moment. Send one of those three words.',
})
export const WAIT_ALREADY_OPEN_REFUSAL: TalkRefusal = Object.freeze({
  status: 409,
  error: 'You already have a wait open. Let it finish before opening another.',
})
export const WAIT_NO_PLACE_REFUSAL: TalkRefusal = Object.freeze({
  status: 409,
  error: 'You are not standing in an active place. Move into one before you wait.',
})

export type LineBodyProblem = 'credential' | 'too_long' | 'not_one_line'

export function isTalkRequestId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}

export function isPingAnswer(value: unknown): value is PingAnswer {
  return typeof value === 'string' && PING_ANSWERS.includes(value as PingAnswer)
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
