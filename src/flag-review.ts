import { positiveId, publicLabel } from './input.ts'
import type { PublicPage } from './public-pagination.ts'
import { PUBLIC_ACTION_LIMITS } from './public-action-limits.ts'

export const FLAG_REVIEW_NOTE_CHARACTERS = PUBLIC_ACTION_LIMITS.flagReviewNoteCharacters

export const FLAG_TARGET_TYPES = Object.freeze([
  'resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement', 'line', 'ping',
] as const)

const FLAG_TARGET_TYPE_SET: ReadonlySet<string> = new Set(FLAG_TARGET_TYPES)

export type FlagReviewQuery = (
  text: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>

export type FlagHandledMark = Readonly<{
  at: string
  moderation_id: number | null
  note: string | null
}>

export type FounderFlag = Readonly<{
  id: number
  reporter: Readonly<{ id: number; handle: string }> | null
  target_type: typeof FLAG_TARGET_TYPES[number]
  target_id: number
  reason: string
  created_at: string
  handled: FlagHandledMark | null
}>

export type FounderFlagQueue = Readonly<{
  unhandledCount: number
  flags: readonly FounderFlag[]
}>

export type FlagHandleDecision = Readonly<{
  moderationId: number | null
  note: string | null
}>

export type FlagHandleResult =
  | Readonly<{ outcome: 'handled' | 'already_handled' | 'differently_handled'; handled: FlagHandledMark }>
  | Readonly<{ outcome: 'not_found' }>

const UNHANDLED_COUNT_SQL = `
  /* founder:flag-unhandled-count */
  SELECT count(*)::integer AS count
  FROM flags flag
  WHERE NOT EXISTS (SELECT 1 FROM flag_reviews review WHERE review.flag_id = flag.id)
`

const QUEUE_SQL = `
  /* founder:flag-queue */
  SELECT flag.id, flag.reporter_id, reporter.handle AS reporter_handle,
    flag.target_type, flag.target_id, flag.reason, flag.created_at,
    review.created_at AS handled_at, review.moderation_id, review.note
  FROM flags flag
  LEFT JOIN residents reporter ON reporter.id = flag.reporter_id
  LEFT JOIN flag_reviews review ON review.flag_id = flag.id
  WHERE $1::integer IS NULL OR flag.id < $1::integer
  ORDER BY flag.id DESC
  LIMIT $2::integer
`

const HANDLE_SQL = `
  /* founder:flag-handle */
  WITH handled AS (
    INSERT INTO flag_reviews (flag_id, reviewer_id, moderation_id, note)
    SELECT $1::integer, $2::integer, $3::integer, $4::text
    WHERE EXISTS (SELECT 1 FROM flags WHERE id = $1::integer)
    ON CONFLICT (flag_id) DO NOTHING
    RETURNING created_at, moderation_id, note
  )
  SELECT 'handled'::text AS disposition, handled.created_at AS handled_at,
    handled.moderation_id, handled.note
  FROM handled
  UNION ALL
  SELECT 'already_handled'::text, review.created_at, review.moderation_id, review.note
  FROM flag_reviews review
  WHERE review.flag_id = $1::integer AND NOT EXISTS (SELECT 1 FROM handled)
  LIMIT 1
`

function reviewTimestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function handledMark(row: Readonly<Record<string, unknown>>): FlagHandledMark | null {
  const at = reviewTimestamp(row.handled_at)
  if (at === null) return null
  const moderationId = row.moderation_id == null ? null : positiveId(row.moderation_id)
  const note = row.note == null ? null : String(row.note)
  if (moderationId === null && note === null) throw new Error('flag review answer is unavailable')
  return Object.freeze({ at, moderation_id: moderationId, note })
}

function founderFlag(row: Readonly<Record<string, unknown>>): FounderFlag {
  const id = positiveId(row.id)
  const targetId = positiveId(row.target_id)
  const reporterId = row.reporter_id == null ? null : positiveId(row.reporter_id)
  const reporterHandle = row.reporter_handle == null ? null : String(row.reporter_handle)
  const createdAt = reviewTimestamp(row.created_at)
  if (
    id === null || targetId === null || createdAt === null
    || !FLAG_TARGET_TYPE_SET.has(String(row.target_type))
    || typeof row.reason !== 'string'
    || ((reporterId === null) !== (reporterHandle === null))
  ) throw new Error('flag queue row is unavailable')
  return Object.freeze({
    id,
    reporter: reporterId === null
      ? null
      : Object.freeze({ id: reporterId, handle: reporterHandle as string }),
    target_type: row.target_type as FounderFlag['target_type'],
    target_id: targetId,
    reason: row.reason,
    created_at: createdAt,
    handled: handledMark(row),
  })
}

export async function unhandledFlagCount(query: FlagReviewQuery): Promise<number> {
  const rows = await query(UNHANDLED_COUNT_SQL, [])
  const count = Number(rows[0]?.count)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('unhandled flag count is unavailable')
  }
  return count
}

/** One page of reports, newest first, beside the count of every unhandled report. */
export async function readFounderFlagQueue(
  query: FlagReviewQuery,
  page: PublicPage,
): Promise<FounderFlagQueue> {
  const [count, rows] = await Promise.all([
    unhandledFlagCount(query),
    query(QUEUE_SQL, [page.cursor, page.fetchLimit]),
  ])
  return Object.freeze({
    unhandledCount: count,
    flags: Object.freeze(rows.map(founderFlag)),
  })
}

export function flagHandleDecision(value: unknown): FlagHandleDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.length === 0 || keys.some(key => key !== 'moderation_id' && key !== 'note')) return null
  const hasModerationId = Object.hasOwn(input, 'moderation_id')
  const moderationId = hasModerationId ? positiveId(input.moderation_id) : null
  if (hasModerationId && moderationId === null) return null
  let note: string | null = null
  if (Object.hasOwn(input, 'note')) {
    // The same safe-text boundary every other public label crosses, plus the one-line
    // tab rule the flag_reviews check states, so nothing is silently rewritten on the
    // way to Postgres.
    const label = publicLabel(input.note, FLAG_REVIEW_NOTE_CHARACTERS)
    if (label === null || /\t/u.test(label)) return null
    note = label
  }
  if (moderationId === null && note === null) return null
  return Object.freeze({ moderationId, note })
}

export async function handleFlag(
  query: FlagReviewQuery,
  flagId: number,
  founderId: number,
  decision: FlagHandleDecision,
): Promise<FlagHandleResult> {
  const id = positiveId(flagId)
  const reviewer = positiveId(founderId)
  if (
    id === null || reviewer === null
    || (decision.moderationId === null && decision.note === null)
  ) {
    throw new TypeError('flag review input is invalid')
  }
  const rows = await query(HANDLE_SQL, [id, reviewer, decision.moderationId, decision.note])
  if (rows.length === 0) return Object.freeze({ outcome: 'not_found' })
  const row = rows[0] as Readonly<Record<string, unknown>>
  const handled = handledMark(row)
  if (!handled) throw new Error('flag review result is unavailable')
  if (row.disposition === 'handled') return Object.freeze({ outcome: 'handled', handled })
  if (row.disposition !== 'already_handled') throw new Error('flag review result is unavailable')
  const same = handled.moderation_id === decision.moderationId && handled.note === decision.note
  return Object.freeze({
    outcome: same ? 'already_handled' : 'differently_handled',
    handled,
  })
}
