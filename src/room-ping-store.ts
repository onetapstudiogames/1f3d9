import { createHash } from 'node:crypto'
import { HANDLE_RE } from './core-primitives.ts'
import { engineSql, withEngineTransaction, type TaggedSql } from './engine.ts'
import { isoTimestamp } from './timestamp.ts'
import {
  pairHistoryStart,
  pingAdmission,
  pingStatus,
  type PairPing,
} from './room-ping-rules.ts'
import {
  isPingAnswer,
  isTalkRequestId,
  PING_ANSWER_REFUSAL,
  PING_ENDED_REFUSAL,
  PING_ID_REFUSAL,
  PING_NOT_HERE_REFUSAL,
  PING_NOT_YOURS_REFUSAL,
  PING_SELF_REFUSAL,
  PING_OFFER_MINUTES,
  pingNotFoundRefusal,
  receiptStillOpenRefusal,
  requestReuseRefusal,
  TALK_REQUEST_ID_REFUSAL,
  TALK_REQUEST_LOCK_NAMESPACE,
  type PingAnswer,
  type PingResult,
  type PublicPing,
  type ReceiptDismissal,
  type TalkOutcome,
  type TalkRefusal,
  type TalkRequestOperation,
} from './room-talk-contract.ts'

type PingDbRow = Readonly<{
  id: number | string
  place_id: number | string
  sender_id: number | string
  sender: string
  target_id: number | string
  target: string
  sent_at: Date | string
  expires_at: Date | string
  answer: PingAnswer | null
  answered_at: Date | string | null
}>

type PairHistoryRow = Readonly<{
  id: number | string
  sender_id: number | string
  target_id: number | string
  sent_at: Date | string
  expires_at: Date | string
  answer: PingAnswer | null
  answered_at: Date | string | null
  still_together: boolean
}>

type PresenceRow = Readonly<{
  resident_id: number | string
  current_place_id: number | string | null
  active: boolean | null
}>

type StoredOperation = Readonly<{
  operation: string
  ping_id: number | string | null
  payload_fingerprint: string
  response_status: number
  response_json: unknown
}>

type ReceiptRow = Readonly<{
  ping_id: number | string
  recipient_id: number | string
  dismissed_at: Date | string | null
}>

type SampledNow = Readonly<{ date: Date; exact: string }>

async function queryRows<T>(result: Promise<unknown>): Promise<T[]> {
  return await result as T[]
}

function refusal<T>(value: TalkRefusal): TalkOutcome<T> {
  return { ok: false, refusal: value }
}

function isPingId(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= 2_147_483_647
}

function dateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? '', 'utf8')
    .digest('hex')
}

function pingAnswer(row: PingDbRow, now: Date, stillTogether: boolean, replayed: boolean): PingResult {
  const pairPing: PairPing = {
    id: Number(row.id),
    senderId: Number(row.sender_id),
    targetId: Number(row.target_id),
    sentAt: dateValue(row.sent_at),
    expiresAt: dateValue(row.expires_at),
    answer: row.answer,
    answeredAt: row.answered_at === null ? null : dateValue(row.answered_at),
    stillTogether,
  }
  const ping: PublicPing = {
    id: Number(row.id),
    status: pingStatus(pairPing, now),
    place_id: Number(row.place_id),
    sender_id: Number(row.sender_id),
    sender: row.sender,
    target_id: Number(row.target_id),
    target: row.target,
    sent_at: isoTimestamp(row.sent_at) ?? '',
    expires_at: isoTimestamp(row.expires_at) ?? '',
    answer: row.answer,
    answered_at: isoTimestamp(row.answered_at) ?? null,
  }
  return { ping, replayed }
}

async function sampledNow(transaction: TaggedSql): Promise<SampledNow> {
  const rows = await queryRows<Readonly<{ now: Date; exact: string }>>(transaction`
    SELECT stamp.now,
      to_char(stamp.now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact
    FROM (SELECT clock_timestamp() AS now) stamp
  `)
  return { date: new Date(rows[0]!.exact), exact: rows[0]!.exact }
}

async function lockRequester(transaction: TaggedSql, residentId: number): Promise<void> {
  await transaction`
    SELECT pg_advisory_xact_lock(${TALK_REQUEST_LOCK_NAMESPACE}::int, ${residentId}::int)
  `
}

async function priorOutcome<T extends PingResult | ReceiptDismissal>(
  transaction: TaggedSql,
  residentId: number,
  requestId: string,
  operation: TalkRequestOperation,
  payloadFingerprint: string,
): Promise<TalkOutcome<T> | null> {
  const operations = await queryRows<StoredOperation>(transaction`
    SELECT operation, ping_id, payload_fingerprint, response_status, response_json
    FROM ping_operations
    WHERE resident_id = ${residentId}
      AND request_id = ${requestId}::uuid
  `)
  const lines = await queryRows<Readonly<{ request_id: string }>>(transaction`
    SELECT request_id
    FROM room_lines
    WHERE resident_id = ${residentId}
      AND request_id = ${requestId}::uuid
  `)
  const stored = operations[0]
  if (stored !== undefined) {
    if (lines.length > 0) return refusal(requestReuseRefusal('line'))
    if (stored.operation !== operation || stored.payload_fingerprint !== payloadFingerprint) {
      return refusal(requestReuseRefusal(stored.operation as TalkRequestOperation))
    }
    if (stored.response_status >= 400) {
      return refusal(stored.response_json as TalkRefusal)
    }
    return {
      ok: true,
      status: 200,
      answer: { ...(stored.response_json as T), replayed: true },
    }
  }
  if (lines.length > 0) return refusal(requestReuseRefusal('line'))
  return null
}

async function recordOutcome<T extends PingResult | ReceiptDismissal>(
  transaction: TaggedSql,
  input: Readonly<{
    residentId: number
    requestId: string
    operation: 'invite' | 'answer' | 'dismiss'
    pingId: number | null
    payloadFingerprint: string
    now: SampledNow
  }>,
  outcome: TalkOutcome<T>,
): Promise<TalkOutcome<T>> {
  const payload = outcome.ok ? outcome.answer : outcome.refusal
  const status = outcome.ok ? outcome.status : outcome.refusal.status
  await transaction`
    INSERT INTO ping_operations (
      resident_id, request_id, operation, ping_id, payload_fingerprint,
      response_status, response_json, created_at
    )
    VALUES (
      ${input.residentId}, ${input.requestId}::uuid, ${input.operation},
      ${input.pingId}, ${input.payloadFingerprint}, ${status},
      ${JSON.stringify(payload)}::jsonb, ${input.now.exact}::timestamptz
    )
  `
  return outcome
}

async function lockPresenceRows(
  transaction: TaggedSql,
  firstResidentId: number,
  secondResidentId: number,
): Promise<PresenceRow[]> {
  const lockedPresence = await queryRows<Readonly<{
    resident_id: number | string
    current_place_id: number | string | null
  }>>(transaction`
    SELECT presence.resident_id, presence.current_place_id
    FROM resident_presence presence
    WHERE presence.resident_id IN (${firstResidentId}, ${secondResidentId})
    ORDER BY presence.resident_id
    FOR UPDATE OF presence
  `)
  const placeActivity = await queryRows<Readonly<{ resident_id: number | string; active: boolean }>>(transaction`
    SELECT presence.resident_id, coalesce(place.retired_at IS NULL, false) AS active
    FROM resident_presence presence
    LEFT JOIN places place ON place.id = presence.current_place_id
    WHERE presence.resident_id IN (${firstResidentId}, ${secondResidentId})
    ORDER BY presence.resident_id
  `)
  return lockedPresence.map(presence => ({
    ...presence,
    active: placeActivity.find(row => Number(row.resident_id) === Number(presence.resident_id))?.active ?? false,
  }))
}

async function loadPingForUpdate(
  transaction: TaggedSql,
  pingId: number,
): Promise<PingDbRow | null> {
  const rows = await queryRows<PingDbRow>(transaction`
    SELECT ping.id, ping.place_id, ping.sender_id, sender.handle AS sender,
      ping.target_id, target.handle AS target, ping.sent_at, ping.expires_at,
      ping.answer, ping.answered_at
    FROM pings ping
    JOIN residents sender ON sender.id = ping.sender_id
    JOIN residents target ON target.id = ping.target_id
    WHERE ping.id = ${pingId}
    FOR UPDATE OF ping
  `)
  return rows[0] ?? null
}

async function stillTogether(transaction: TaggedSql, pingId: number): Promise<boolean> {
  const rows = await queryRows<Readonly<{ still_together: boolean }>>(transaction`
    SELECT coalesce(
      sender_presence.current_place_id = ping.place_id
        AND sender_presence.arrived_at = ping.sender_arrived_at
        AND target_presence.current_place_id = ping.place_id
        AND target_presence.arrived_at = ping.target_arrived_at,
      false
    ) AS still_together
    FROM pings ping
    LEFT JOIN resident_presence sender_presence ON sender_presence.resident_id = ping.sender_id
    LEFT JOIN resident_presence target_presence ON target_presence.resident_id = ping.target_id
    WHERE ping.id = ${pingId}
  `)
  return rows[0]?.still_together === true
}

export async function invitePing(
  input: Readonly<{ residentId: number; residentHandle: string; toHandle: unknown; requestId: unknown }>,
  database: TaggedSql = engineSql,
): Promise<TalkOutcome<PingResult>> {
  if (!isTalkRequestId(input.requestId)) return refusal(TALK_REQUEST_ID_REFUSAL)
  const requestId = input.requestId
  const residentId = input.residentId
  const payloadFingerprint = fingerprint({ operation: 'invite', to_handle: input.toHandle })

  return withEngineTransaction(database, async transaction => {
    await lockRequester(transaction, residentId)
    const prior = await priorOutcome<PingResult>(
      transaction, residentId, requestId, 'invite', payloadFingerprint,
    )
    if (prior !== null) return prior

    const saveRefusal = async (value: TalkRefusal): Promise<TalkOutcome<PingResult>> => {
      const now = await sampledNow(transaction)
      return recordOutcome(transaction, {
        residentId, requestId, operation: 'invite', pingId: null, payloadFingerprint, now,
      }, refusal(value))
    }

    if (typeof input.toHandle !== 'string' || !HANDLE_RE.test(input.toHandle)) {
      return saveRefusal(PING_NOT_HERE_REFUSAL)
    }
    const targetRows = await queryRows<Readonly<{ id: number | string }>>(transaction`
      SELECT id FROM residents WHERE handle = ${input.toHandle}
    `)
    const target = targetRows[0]
    if (target === undefined) return saveRefusal(PING_NOT_HERE_REFUSAL)
    const targetId = Number(target.id)
    if (targetId === residentId) return saveRefusal(PING_SELF_REFUSAL)

    const presences = await lockPresenceRows(transaction, residentId, targetId)
    const now = await sampledNow(transaction)
    const senderPresence = presences.find(row => Number(row.resident_id) === residentId)
    const targetPresence = presences.find(row => Number(row.resident_id) === targetId)
    const placeId = senderPresence?.current_place_id == null
      ? null
      : Number(senderPresence.current_place_id)
    if (senderPresence === undefined
      || targetPresence === undefined
      || placeId === null
      || Number(targetPresence.current_place_id) !== placeId
      || senderPresence.active !== true
      || targetPresence.active !== true) {
      return recordOutcome(transaction, {
        residentId, requestId, operation: 'invite', pingId: null, payloadFingerprint, now,
      }, refusal(PING_NOT_HERE_REFUSAL))
    }

    const historyRows = await queryRows<PairHistoryRow>(transaction`
      SELECT ping.id, ping.sender_id, ping.target_id, ping.sent_at, ping.expires_at,
        ping.answer, ping.answered_at,
        coalesce(
          sender_presence.current_place_id = ping.place_id
            AND sender_presence.arrived_at = ping.sender_arrived_at
            AND target_presence.current_place_id = ping.place_id
            AND target_presence.arrived_at = ping.target_arrived_at,
          false
        ) AS still_together
      FROM pings ping
      LEFT JOIN resident_presence sender_presence ON sender_presence.resident_id = ping.sender_id
      LEFT JOIN resident_presence target_presence ON target_presence.resident_id = ping.target_id
      WHERE ((ping.sender_id = ${residentId} AND ping.target_id = ${targetId})
        OR (ping.sender_id = ${targetId} AND ping.target_id = ${residentId}))
        AND ping.sent_at >= ${pairHistoryStart(now.date)}::timestamptz
      ORDER BY ping.sent_at DESC, ping.id DESC
    `)
    const admission = pingAdmission({
      senderId: residentId,
      targetId,
      now: now.date,
      history: historyRows.map(row => ({
        id: Number(row.id),
        senderId: Number(row.sender_id),
        targetId: Number(row.target_id),
        sentAt: dateValue(row.sent_at),
        expiresAt: dateValue(row.expires_at),
        answer: row.answer,
        answeredAt: row.answered_at === null ? null : dateValue(row.answered_at),
        stillTogether: row.still_together,
      })),
    })
    if (!admission.ok) {
      return recordOutcome(transaction, {
        residentId, requestId, operation: 'invite', pingId: null, payloadFingerprint, now,
      }, refusal(admission.refusal))
    }

    const inserted = await queryRows<PingDbRow & Readonly<{ still_together: boolean }>>(transaction`
      WITH
      new_ping AS (
        INSERT INTO pings (
          place_id, sender_id, target_id, sent_at, expires_at,
          sender_arrived_at, target_arrived_at
        )
        SELECT ${placeId}, sender.resident_id, target.resident_id,
          ${now.exact}::timestamptz,
          ${now.exact}::timestamptz + make_interval(mins => ${PING_OFFER_MINUTES}),
          sender.arrived_at, target.arrived_at
        FROM resident_presence sender, resident_presence target
        WHERE sender.resident_id = ${residentId}
          AND target.resident_id = ${targetId}
        RETURNING id, place_id, sender_id, target_id, sent_at, expires_at,
          sender_arrived_at, target_arrived_at, answer, answered_at
      ),
      receipt AS (
        INSERT INTO ping_receipts (ping_id, recipient_id)
        SELECT id, target_id FROM new_ping
        RETURNING ping_id
      ),
      ping_event AS (
        INSERT INTO events (at, kind, actor, detail)
        SELECT new_ping.sent_at, 'ping_sent', ${input.residentHandle},
          jsonb_build_object('ping_id', new_ping.id, 'place_id', new_ping.place_id,
            'target_type', 'resident', 'target_id', new_ping.target_id)
        FROM new_ping
        JOIN receipt ON receipt.ping_id = new_ping.id
        RETURNING id
      )
      SELECT new_ping.id, new_ping.place_id, new_ping.sender_id,
        sender.handle AS sender, new_ping.target_id, target.handle AS target,
        new_ping.sent_at, new_ping.expires_at, new_ping.answer, new_ping.answered_at,
        coalesce(
          sender_presence.current_place_id = new_ping.place_id
            AND sender_presence.arrived_at = new_ping.sender_arrived_at
            AND target_presence.current_place_id = new_ping.place_id
            AND target_presence.arrived_at = new_ping.target_arrived_at,
          false
        ) AS still_together
      FROM new_ping
      JOIN residents sender ON sender.id = new_ping.sender_id
      JOIN residents target ON target.id = new_ping.target_id
      JOIN resident_presence sender_presence ON sender_presence.resident_id = new_ping.sender_id
      JOIN resident_presence target_presence ON target_presence.resident_id = new_ping.target_id
      CROSS JOIN receipt
      CROSS JOIN ping_event
    `)
    const row = inserted[0]!
    const outcome: TalkOutcome<PingResult> = {
      ok: true,
      status: 201,
      answer: pingAnswer(row, now.date, row.still_together, false),
    }
    return recordOutcome(transaction, {
      residentId, requestId, operation: 'invite', pingId: Number(row.id), payloadFingerprint, now,
    }, outcome)
  })
}

export async function answerPing(
  input: Readonly<{ residentId: number; residentHandle: string; pingId: unknown; answer: unknown; requestId: unknown }>,
  database: TaggedSql = engineSql,
): Promise<TalkOutcome<PingResult>> {
  if (!isTalkRequestId(input.requestId)) return refusal(TALK_REQUEST_ID_REFUSAL)
  if (!isPingId(input.pingId)) return refusal(PING_ID_REFUSAL)
  if (!isPingAnswer(input.answer)) return refusal(PING_ANSWER_REFUSAL)
  const requestId = input.requestId
  const residentId = input.residentId
  const pingId = input.pingId
  const answer = input.answer
  const payloadFingerprint = fingerprint({ operation: 'answer', ping_id: pingId, answer })

  return withEngineTransaction(database, async transaction => {
    await lockRequester(transaction, residentId)
    const prior = await priorOutcome<PingResult>(
      transaction, residentId, requestId, 'answer', payloadFingerprint,
    )
    if (prior !== null) return prior

    const ping = await loadPingForUpdate(transaction, pingId)
    if (ping === null) {
      const now = await sampledNow(transaction)
      return recordOutcome(transaction, {
        residentId, requestId, operation: 'answer', pingId: null, payloadFingerprint, now,
      }, refusal(pingNotFoundRefusal(pingId)))
    }
    if (Number(ping.target_id) !== residentId) {
      const now = await sampledNow(transaction)
      return recordOutcome(transaction, {
        residentId, requestId, operation: 'answer', pingId, payloadFingerprint, now,
      }, refusal(PING_NOT_YOURS_REFUSAL))
    }

    await lockPresenceRows(transaction, Number(ping.sender_id), Number(ping.target_id))
    const now = await sampledNow(transaction)
    const together = await stillTogether(transaction, pingId)
    const currentPing: PairPing = {
      id: pingId,
      senderId: Number(ping.sender_id),
      targetId: Number(ping.target_id),
      sentAt: dateValue(ping.sent_at),
      expiresAt: dateValue(ping.expires_at),
      answer: ping.answer,
      answeredAt: ping.answered_at === null ? null : dateValue(ping.answered_at),
      stillTogether: together,
    }
    if (pingStatus(currentPing, now.date) !== 'offered') {
      return recordOutcome(transaction, {
        residentId, requestId, operation: 'answer', pingId, payloadFingerprint, now,
      }, refusal(PING_ENDED_REFUSAL))
    }

    const changed = await queryRows<PingDbRow & Readonly<{ still_together: boolean }>>(transaction`
      WITH changed AS (
        UPDATE pings ping
        SET answer = ${answer}, answered_at = ${now.exact}::timestamptz
        WHERE ping.id = ${pingId}
        RETURNING ping.id, ping.place_id, ping.sender_id, ping.target_id,
          ping.sent_at, ping.expires_at, ping.answer, ping.answered_at
      ),
      ping_event AS (
        INSERT INTO events (at, kind, actor, detail)
        SELECT changed.answered_at, 'ping_answered', ${input.residentHandle},
          jsonb_build_object('ping_id', changed.id, 'place_id', changed.place_id,
            'answer', changed.answer, 'target_type', 'resident', 'target_id', changed.sender_id)
        FROM changed
        RETURNING id
      )
      SELECT changed.id, changed.place_id, changed.sender_id,
        sender.handle AS sender, changed.target_id, target.handle AS target,
        changed.sent_at, changed.expires_at, changed.answer, changed.answered_at,
        ${together}::boolean AS still_together
      FROM changed
      JOIN residents sender ON sender.id = changed.sender_id
      JOIN residents target ON target.id = changed.target_id
      CROSS JOIN ping_event
    `)
    const outcome: TalkOutcome<PingResult> = {
      ok: true,
      status: 200,
      answer: pingAnswer(changed[0]!, now.date, together, false),
    }
    return recordOutcome(transaction, {
      residentId, requestId, operation: 'answer', pingId, payloadFingerprint, now,
    }, outcome)
  })
}

export async function dismissPing(
  input: Readonly<{ residentId: number; pingId: unknown; requestId: unknown }>,
  database: TaggedSql = engineSql,
): Promise<TalkOutcome<ReceiptDismissal>> {
  if (!isTalkRequestId(input.requestId)) return refusal(TALK_REQUEST_ID_REFUSAL)
  if (!isPingId(input.pingId)) return refusal(PING_ID_REFUSAL)
  const requestId = input.requestId
  const residentId = input.residentId
  const pingId = input.pingId
  const payloadFingerprint = fingerprint({ operation: 'dismiss', ping_id: pingId })

  return withEngineTransaction(database, async transaction => {
    await lockRequester(transaction, residentId)
    const prior = await priorOutcome<ReceiptDismissal>(
      transaction, residentId, requestId, 'dismiss', payloadFingerprint,
    )
    if (prior !== null) return prior

    const ping = await loadPingForUpdate(transaction, pingId)
    if (ping === null) {
      const now = await sampledNow(transaction)
      return recordOutcome(transaction, {
        residentId, requestId, operation: 'dismiss', pingId: null, payloadFingerprint, now,
      }, refusal(pingNotFoundRefusal(pingId)))
    }
    const receipts = await queryRows<ReceiptRow>(transaction`
      SELECT receipt.ping_id, receipt.recipient_id, receipt.dismissed_at
      FROM ping_receipts receipt
      JOIN pings ping ON ping.id = receipt.ping_id
      WHERE receipt.ping_id = ${pingId}
      FOR UPDATE OF receipt
    `)
    const receipt = receipts[0]!
    if (Number(receipt.recipient_id) !== residentId) {
      const now = await sampledNow(transaction)
      return recordOutcome(transaction, {
        residentId, requestId, operation: 'dismiss', pingId, payloadFingerprint, now,
      }, refusal(PING_NOT_YOURS_REFUSAL))
    }

    await lockPresenceRows(transaction, Number(ping.sender_id), Number(ping.target_id))
    const now = await sampledNow(transaction)
    const together = await stillTogether(transaction, pingId)
    const currentPing: PairPing = {
      id: pingId,
      senderId: Number(ping.sender_id),
      targetId: Number(ping.target_id),
      sentAt: dateValue(ping.sent_at),
      expiresAt: dateValue(ping.expires_at),
      answer: ping.answer,
      answeredAt: ping.answered_at === null ? null : dateValue(ping.answered_at),
      stillTogether: together,
    }
    if (pingStatus(currentPing, now.date) === 'offered') {
      return recordOutcome(transaction, {
        residentId, requestId, operation: 'dismiss', pingId, payloadFingerprint, now,
      }, refusal(receiptStillOpenRefusal(isoTimestamp(ping.expires_at) ?? '')))
    }

    let dismissedAt: Date | string
    if (receipt.dismissed_at === null) {
      const updated = await queryRows<Readonly<{ dismissed_at: Date | string }>>(transaction`
        UPDATE ping_receipts
        SET dismissed_at = ${now.exact}::timestamptz
        WHERE ping_id = ${pingId} AND dismissed_at IS NULL
        RETURNING dismissed_at
      `)
      dismissedAt = updated[0]!.dismissed_at
    } else {
      dismissedAt = receipt.dismissed_at
    }
    const outcome: TalkOutcome<ReceiptDismissal> = {
      ok: true,
      status: 200,
      answer: {
        receipt: {
          ping_id: Number(receipt.ping_id),
          dismissed_at: isoTimestamp(dismissedAt) ?? '',
        },
        replayed: false,
      },
    }
    return recordOutcome(transaction, {
      residentId, requestId, operation: 'dismiss', pingId, payloadFingerprint, now,
    }, outcome)
  })
}
