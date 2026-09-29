import { GAZETTE_FIRST_PRINT_AT, GAZETTE_WEEK_MILLISECONDS } from './gazette-schedule.ts'

// Names decision #133. This module must stay off src/engine.ts, src/core.ts and src/db.ts:
// src/city-credit.ts imports it, and the world PostgreSQL tests load src/city-credit.ts before
// their database mock is installed.
const MAX_CHANGE_ID = 9_223_372_036_854_775_807n

export const GAZETTE_ME_POINTER_SQL = `(
  SELECT jsonb_build_object(
    'issue_number', issue.issue_number,
    'scheduled_for', issue.scheduled_for,
    'printed_at', issue.printed_at,
    'entry_count', issue.entry_count,
    'change_id', change.change_id::text,
    'also_printed', coalesce((
      SELECT jsonb_agg(earlier.issue_number ORDER BY earlier.issue_number ASC)
      FROM gazette_issues earlier
      JOIN public_change_log earlier_change ON earlier_change.event_id = earlier.event_id
      WHERE earlier.issue_number < issue.issue_number
        AND marker.last_public_change_id IS NOT NULL
        AND earlier_change.change_id > marker.last_public_change_id
        AND earlier_change.change_id <= state.current_change_id
    ), '[]'::jsonb)
  )
  FROM gazette_issues issue
  JOIN public_change_log change ON change.event_id = issue.event_id
  WHERE change.change_id <= state.current_change_id
  ORDER BY issue.issue_number DESC
  LIMIT 1
)`

export type GazetteMePointer = Readonly<{
  issueNumber: number
  scheduledFor: string
  printedAt: string
  entryCount: number
  newIssue: boolean
  alsoPrinted: readonly number[]
}>

export function recordValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

export function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
}

function changeId(value: unknown, allowZero: boolean): string | null {
  if (typeof value !== 'string' || value.length > 19 || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return null
  }
  const parsed = BigInt(value)
  if (parsed > MAX_CHANGE_ID || (!allowZero && parsed === 0n)) return null
  return parsed.toString()
}

export function gazetteMePointer(value: unknown, afterChangeId: string | null): GazetteMePointer | null {
  const row = recordValue(value)
  if (!row) return null
  const issueNumber = positiveInteger(row.issue_number)
  const scheduledFor = timestamp(row.scheduled_for)
  const printedAt = timestamp(row.printed_at)
  const entryCount = nonnegativeInteger(row.entry_count)
  const currentChangeId = changeId(row.change_id, false)
  const after = afterChangeId === null ? null : changeId(afterChangeId, true)
  const alsoPrintedValue = row.also_printed
  if (
    issueNumber === null
    || scheduledFor === null
    || printedAt === null
    || entryCount === null
    || currentChangeId === null
    || (afterChangeId !== null && after === null)
    || !Array.isArray(alsoPrintedValue)
  ) return null

  const firstSlotMilliseconds = Date.parse(GAZETTE_FIRST_PRINT_AT)
  const scheduledMilliseconds = Date.parse(scheduledFor)
  const slotOffset = scheduledMilliseconds - firstSlotMilliseconds
  if (
    slotOffset < 0
    || slotOffset % GAZETTE_WEEK_MILLISECONDS !== 0
    || slotOffset / GAZETTE_WEEK_MILLISECONDS + 1 !== issueNumber
  ) return null

  const alsoPrinted: number[] = []
  for (const rawIssueNumber of alsoPrintedValue) {
    const earlierIssueNumber = positiveInteger(rawIssueNumber)
    if (
      earlierIssueNumber === null
      || earlierIssueNumber >= issueNumber
      || (alsoPrinted.length > 0 && earlierIssueNumber <= alsoPrinted[alsoPrinted.length - 1]!)
    ) return null
    alsoPrinted.push(earlierIssueNumber)
  }

  return Object.freeze({
    issueNumber,
    scheduledFor,
    printedAt,
    entryCount,
    newIssue: after === null || BigInt(currentChangeId) > BigInt(after),
    alsoPrinted: Object.freeze(alsoPrinted),
  })
}
