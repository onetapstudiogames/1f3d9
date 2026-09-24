import {
  PING_AFTER_ANSWER_MINUTES,
  PING_AFTER_MISS_MINUTES,
  PING_AFTER_NO_HOURS,
  PING_MISSES_PER_UTC_DAY,
  PING_OFFER_MINUTES,
  nextUtcMidnight,
  pingPairWaitRefusal,
  pingSaidNoRefusal,
  pingStillOpenRefusal,
  pingThreeMissesRefusal,
  utcDayStart,
  type PingAnswer,
  type PublicPingStatus,
  type TalkRefusal,
} from './room-talk-contract.ts'

export type PairPing = Readonly<{
  id: number
  senderId: number
  targetId: number
  sentAt: Date
  expiresAt: Date
  answer: PingAnswer | null
  answeredAt: Date | null
  stillTogether: boolean
}>

export type PingAdmission = Readonly<{ ok: true }> | Readonly<{ ok: false; refusal: TalkRefusal }>

const MINUTE_MS = 60_000

export function pingStatus(ping: PairPing, now: Date): PublicPingStatus {
  if (ping.answer !== null) return 'answered'
  if (!ping.stillTogether || now.getTime() >= ping.expiresAt.getTime()) return 'expired'
  return 'offered'
}

export function pairHistoryStart(now: Date): Date {
  const noWindowStart = now.getTime() - (PING_AFTER_NO_HOURS * 60 + PING_OFFER_MINUTES) * MINUTE_MS
  return new Date(Math.min(utcDayStart(now).getTime(), noWindowStart))
}

export function pingAdmission(input: Readonly<{
  senderId: number
  targetId: number
  now: Date
  history: readonly PairPing[]
}>): PingAdmission {
  const { senderId, targetId, now, history } = input
  const toTarget = history.filter(ping => ping.senderId === senderId && ping.targetId === targetId)
  const latestToTarget = toTarget.reduce<PairPing | null>((latest, ping) => {
    if (latest === null) return ping
    const sentAtOrder = ping.sentAt.getTime() - latest.sentAt.getTime()
    return sentAtOrder > 0 || (sentAtOrder === 0 && ping.id > latest.id) ? ping : latest
  }, null)

  const noAnsweredAt = latestToTarget?.answer === 'no' ? latestToTarget.answeredAt : null
  if (noAnsweredAt !== null && noAnsweredAt !== undefined) {
    const noUntil = noAnsweredAt.getTime() + PING_AFTER_NO_HOURS * 60 * MINUTE_MS
    const targetPingAfterNo = history.some(ping =>
      ping.senderId === targetId
      && ping.targetId === senderId
      && ping.sentAt.getTime() > noAnsweredAt.getTime(),
    )
    if (noUntil > now.getTime() && !targetPingAfterNo) {
      return { ok: false, refusal: pingSaidNoRefusal(new Date(noUntil).toISOString()) }
    }
  }

  if (latestToTarget !== null && pingStatus(latestToTarget, now) === 'offered') {
    return { ok: false, refusal: pingStillOpenRefusal(latestToTarget.expiresAt.toISOString()) }
  }

  const dayStart = utcDayStart(now).getTime()
  const missedToday = toTarget.filter(ping =>
    ping.sentAt.getTime() >= dayStart
    && ping.answer === null
    && pingStatus(ping, now) === 'expired',
  ).length
  if (missedToday >= PING_MISSES_PER_UTC_DAY) {
    return { ok: false, refusal: pingThreeMissesRefusal(nextUtcMidnight(now).toISOString()) }
  }

  if (latestToTarget !== null) {
    const nextAllowedAt = latestToTarget.answer === null
      ? latestToTarget.expiresAt.getTime() + PING_AFTER_MISS_MINUTES * MINUTE_MS
      : latestToTarget.sentAt.getTime() + PING_AFTER_ANSWER_MINUTES * MINUTE_MS
    if (now.getTime() < nextAllowedAt) {
      return { ok: false, refusal: pingPairWaitRefusal(new Date(nextAllowedAt).toISOString()) }
    }
  }

  return { ok: true }
}
