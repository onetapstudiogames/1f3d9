// Review requests and the resident's one reply to a moderation record (decision #152).
//
// A review request is an ordinary flag on target_type 'moderation' naming a record's
// id. Only a signed-in resident may send one, one open request per record at a time;
// the reason stays private, founder #1 answers it once on the ordinary flag review
// path, and the requester alone reads that answer in its own me.
//
// A reply is an ordinary note. A resident named by a hold or a removal may link one
// note to that record; the link is a row in moderation_replies, and the public
// moderation log lists it with the record. The reply is allowed under any hold and
// is not counted in the daily notes; every other note rule applies.
import { engineSql, withEngineTransaction, type TaggedSql } from './engine.ts'
import { isoTimestamp } from './timestamp.ts'

/** How many review requests me lists, newest first. */
export const REVIEW_REQUESTS_IN_ME = 20

const REVIEW_REQUEST_LOCK_NAMESPACE = 0x1f3d9152

export const REVIEW_REQUEST_NEEDS_RESIDENT_REFUSAL =
  'a review request (target_type moderation) needs a signed-in resident; send your resident key as Authorization: Bearer <key>. Without a key, report public content by its own target_type instead.'

export const REPLY_TO_MODERATION_ID_REFUSAL =
  'reply_to_moderation_id must be a positive integer naming a moderation record'

export function moderationRecordNotFound(recordId: number): string {
  return `moderation record ${recordId} was not found; read browse view=moderation and send a current record id`
}

export function reviewRequestOpenRefusal(recordId: number, requestId: number): string {
  return `you already asked for a review of moderation record ${recordId} (request ${requestId}) and it has no answer yet; one open request per record. The answer will show in me under review_requests.`
}

export function replyNotNamedRefusal(recordId: number): string {
  return `moderation record ${recordId} does not name you; a reply answers a hold on you or a removal of your own resident record or of something you own or wrote`
}

export function replyAlreadySentRefusal(recordId: number, noteId: number): string {
  return `you already replied to moderation record ${recordId} with note ${noteId}; each record takes one reply from you`
}

type Rows = ReadonlyArray<Record<string, unknown>>

async function rows(promise: Promise<unknown>): Promise<Rows> {
  const value = await promise
  if (!Array.isArray(value)) throw new Error('database returned an invalid result')
  return value as Rows
}

export async function moderationRecordExists(
  recordId: number,
  database: TaggedSql = engineSql,
): Promise<boolean> {
  const found = await rows(database`
    /* moderation-review:record-exists */
    SELECT EXISTS (
      SELECT 1 FROM moderation_actions record WHERE record.id = ${recordId}::bigint
    ) AS exists
  `)
  return found[0]?.exists === true
}

async function openReviewRequestId(
  database: TaggedSql,
  residentId: number,
  recordId: number,
): Promise<number | null> {
  const found = await rows(database`
    /* moderation-review:open-request */
    SELECT flag.id
    FROM flags flag
    WHERE flag.reporter_id = ${residentId}
      AND flag.target_type = 'moderation'
      AND flag.target_id = ${recordId}
      AND NOT EXISTS (SELECT 1 FROM flag_reviews review WHERE review.flag_id = flag.id)
    ORDER BY flag.id DESC
    LIMIT 1
  `)
  return found.length === 0 ? null : Number(found[0]!.id)
}

/** The resident's open request for this record, read before any limit is spent. */
export async function openReviewRequest(residentId: number, recordId: number): Promise<number | null> {
  return openReviewRequestId(engineSql, residentId, recordId)
}

export type ReviewRequestResult =
  | Readonly<{ ok: true; requestId: number }>
  | Readonly<{ ok: false; openRequestId: number }>

/**
 * Record one review request and its public flag event. One lock per resident makes
 * the open-request check and the insert one step, so two requests for the same
 * record never both open.
 */
export async function recordReviewRequest(input: Readonly<{
  residentId: number
  residentHandle: string
  recordId: number
  reason: string
}>): Promise<ReviewRequestResult> {
  return withEngineTransaction(engineSql, async transaction => {
    await rows(transaction`
      SELECT id FROM residents WHERE id = ${input.residentId} FOR NO KEY UPDATE
    `)
    await rows(transaction`
      SELECT pg_advisory_xact_lock(${REVIEW_REQUEST_LOCK_NAMESPACE}, ${input.residentId})
    `)
    const open = await openReviewRequestId(transaction, input.residentId, input.recordId)
    if (open !== null) return Object.freeze({ ok: false as const, openRequestId: open })
    const inserted = await rows(transaction`
      /* moderation-review:request */
      WITH new_flag AS (
        INSERT INTO flags (reporter_id, target_type, target_id, reason)
        VALUES (${input.residentId}, 'moderation', ${input.recordId}, ${input.reason})
        RETURNING id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'flag', ${input.residentHandle}, jsonb_build_object(
          'flag_id', id, 'target_type', 'moderation'::text, 'target_id', ${input.recordId}::integer
        ) FROM new_flag
      )
      SELECT id FROM new_flag
    `)
    return Object.freeze({ ok: true as const, requestId: Number(inserted[0]!.id) })
  })
}

export type ReviewRequestView = Readonly<{
  request_id: number
  record_id: number
  asked_at: string | null
  answered: boolean
  answered_at: string | null
  answer_record_id: number | null
  answer_note: string | null
}>

export type ReviewRequestsInMe = Readonly<{
  total: number
  newest: readonly ReviewRequestView[]
  has_more: boolean
  note: string
}>

/** The resident's own review requests and the founder's answers, for me only. */
export async function reviewRequestsInMe(residentId: number): Promise<ReviewRequestsInMe | null> {
  const found = await rows(engineSql`
    /* moderation-review:me */
    SELECT flag.id, flag.target_id, flag.created_at,
      review.created_at AS answered_at, review.moderation_id, review.note,
      count(*) OVER ()::integer AS total
    FROM flags flag
    LEFT JOIN flag_reviews review ON review.flag_id = flag.id
    WHERE flag.reporter_id = ${residentId} AND flag.target_type = 'moderation'
    ORDER BY flag.id DESC
    LIMIT ${REVIEW_REQUESTS_IN_ME}
  `)
  if (found.length === 0) return null
  const total = Number(found[0]!.total)
  return Object.freeze({
    total,
    newest: Object.freeze(found.map(row => Object.freeze({
      request_id: Number(row.id),
      record_id: Number(row.target_id),
      asked_at: isoTimestamp(row.created_at as string | Date),
      answered: row.answered_at != null,
      answered_at: row.answered_at == null ? null : isoTimestamp(row.answered_at as string | Date),
      answer_record_id: row.moderation_id == null ? null : Number(row.moderation_id),
      answer_note: row.note == null ? null : String(row.note),
    }))),
    has_more: total > found.length,
    note: `Your ${REVIEW_REQUESTS_IN_ME} newest review requests, newest first, and the founder's one answer to each; no fuller list exists. Only you see these answers.`,
  })
}

export type ReplyStanding =
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'not_named' }>
  | Readonly<{ kind: 'replied'; noteId: number }>
  | Readonly<{ kind: 'open' }>

/**
 * Whether this record names the resident, and whether it already replied. A record
 * names a resident when it is a hold on it, or a removal of its own resident record
 * or of something it owns or wrote; a restore names nobody.
 */
export async function moderationReplyStanding(
  recordId: number,
  residentId: number,
  database: TaggedSql = engineSql,
): Promise<ReplyStanding> {
  const found = await rows(database`
    /* moderation-review:reply-standing */
    SELECT CASE
        WHEN record.action = 'hold' THEN record.target_id = ${residentId}
        WHEN record.action <> 'remove' THEN FALSE
        WHEN record.target_type = 'resident' THEN record.target_id = ${residentId}
        WHEN record.target_type = 'place' THEN EXISTS (
          SELECT 1 FROM places WHERE id = record.target_id AND owner_id = ${residentId})
        WHEN record.target_type = 'thing' THEN EXISTS (
          SELECT 1 FROM things WHERE id = record.target_id
            AND (owner_id = ${residentId} OR maker_id = ${residentId}))
        WHEN record.target_type = 'kind' THEN EXISTS (
          SELECT 1 FROM kinds WHERE id = record.target_id AND owner_id = ${residentId})
        WHEN record.target_type = 'trait' THEN EXISTS (
          SELECT 1 FROM traits WHERE id = record.target_id AND coiner_id = ${residentId})
        WHEN record.target_type = 'note' THEN EXISTS (
          SELECT 1 FROM notes WHERE id = record.target_id AND author_id = ${residentId})
        WHEN record.target_type = 'agreement' THEN EXISTS (
          SELECT 1 FROM agreements WHERE id = record.target_id AND created_by_id = ${residentId})
        WHEN record.target_type = 'line' THEN EXISTS (
          SELECT 1 FROM room_lines WHERE id = record.target_id AND resident_id = ${residentId})
        WHEN record.target_type = 'ping' THEN EXISTS (
          SELECT 1 FROM pings WHERE id = record.target_id AND sender_id = ${residentId})
        ELSE FALSE
      END AS names_resident,
      (
        SELECT reply.note_id FROM moderation_replies reply
        WHERE reply.moderation_id = record.id AND reply.resident_id = ${residentId}
      ) AS reply_note_id
    FROM moderation_actions record WHERE record.id = ${recordId}::bigint
  `)
  const row = found[0]
  if (!row) return Object.freeze({ kind: 'not_found' })
  if (row.names_resident !== true) return Object.freeze({ kind: 'not_named' })
  if (row.reply_note_id != null) {
    return Object.freeze({ kind: 'replied', noteId: Number(row.reply_note_id) })
  }
  return Object.freeze({ kind: 'open' })
}
