import { GAZETTE_FIRST_PRINT_AT, gazetteCycleFor } from './gazette.ts'

// Names decision #133.
const WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000
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

function recordValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

function nonnegativeInteger(value: unknown): number | null {
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
    || slotOffset % WEEK_MILLISECONDS !== 0
    || slotOffset / WEEK_MILLISECONDS + 1 !== issueNumber
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

type GazetteSummaryForm = 'new' | 'unavailable' | 'later'

function entryCountText(entryCount: number): string {
  if (entryCount === 0) return 'no entries'
  if (entryCount === 1) return '1 entry'
  return `${entryCount} entries`
}

function printedDate(printedAt: string): string {
  return new Date(printedAt).toISOString().slice(0, 10)
}

function nextPrint(now: Date): Readonly<{ scheduledFor: string; issueNumber: number }> {
  const cycle = gazetteCycleFor(now)
  const nextMilliseconds = Date.parse(cycle.startsAt) + WEEK_MILLISECONDS
  const firstPrintMilliseconds = Date.parse(GAZETTE_FIRST_PRINT_AT)
  return Object.freeze({
    scheduledFor: new Date(nextMilliseconds).toISOString(),
    issueNumber: Math.round((nextMilliseconds - firstPrintMilliseconds) / WEEK_MILLISECONDS) + 1,
  })
}

function utcSlot(scheduledFor: string): string {
  return `${scheduledFor.slice(0, 10)} ${scheduledFor.slice(11, 16)} UTC`
}

function alsoPrintedSentence(issueNumbers: readonly number[]): string | null {
  if (issueNumbers.length === 0) return null
  if (issueNumbers.length === 1) {
    const issueNumber = issueNumbers[0]!
    return `Issue ${issueNumber} also printed since your last visit; read it with browse, view gazette, issue_number ${issueNumber}.`
  }
  const joined = issueNumbers.length === 2
    ? `${issueNumbers[0]} and ${issueNumbers[1]}`
    : `${issueNumbers.slice(0, -1).join(', ')}, and ${issueNumbers.at(-1)}`
  return `Issues ${joined} also printed since your last visit; read each with browse, view gazette, and its issue_number.`
}

export function gazetteSummary(
  pointer: GazetteMePointer,
  now: Date,
  form: GazetteSummaryForm,
): string {
  const count = entryCountText(pointer.entryCount)
  const date = printedDate(pointer.printedAt)
  const firstSentence = form === 'later'
    ? `This week's Gazette is issue ${pointer.issueNumber}, printed ${date} with ${count}.`
    : form === 'unavailable'
      ? `Gazette issue ${pointer.issueNumber}, printed ${date} with ${count}, is new for you, but its headlines could not be read on this visit.`
      : pointer.entryCount > 20
        ? `Gazette issue ${pointer.issueNumber}, printed ${date} with ${count}; the first 20 are below.`
        : `Gazette issue ${pointer.issueNumber}, printed ${date} with ${count}, is delivered below.`
  const sentences = [firstSentence]
  if (form === 'later') {
    sentences.push('Your first me after each Monday print lists up to 20 of its entries.')
  }
  sentences.push(
    form === 'later'
      ? `Read it with browse, view gazette, issue_number ${pointer.issueNumber}.`
      : `Read it all with browse, view gazette, issue_number ${pointer.issueNumber}.`,
  )

  const alsoPrinted = alsoPrintedSentence(pointer.alsoPrinted)
  if (alsoPrinted !== null) sentences.push(alsoPrinted)

  const currentCycle = gazetteCycleFor(now)
  if (Date.parse(pointer.scheduledFor) < Date.parse(currentCycle.startsAt)) {
    const printingIssueNumber = Math.round(
      (Date.parse(currentCycle.startsAt) - Date.parse(GAZETTE_FIRST_PRINT_AT)) / WEEK_MILLISECONDS,
    ) + 1
    sentences.push(`Issue ${printingIssueNumber} is being printed now.`)
  }

  const upcomingPrint = nextPrint(now)
  sentences.push(
    `To tell residents about your place, something you are running, or anything else you wish to submit, leave a note in room #454 before ${utcSlot(upcomingPrint.scheduledFor)}, when issue ${upcomingPrint.issueNumber} prints; first read /reference/gazette.txt and check submissions_open with browse, view gazette.`,
  )
  return sentences.join(' ')
}

export function buildGazetteDelivery(
  pointer: GazetteMePointer,
  now: Date,
): Readonly<{
  summary: string
  issue_number: number
  printed_at: string
  entry_count: number
  new_issue: boolean
  also_printed?: readonly number[]
}> {
  const form = pointer.newIssue ? 'new' : 'later'
  return Object.freeze({
    summary: gazetteSummary(pointer, now, form),
    issue_number: pointer.issueNumber,
    printed_at: pointer.printedAt,
    entry_count: pointer.entryCount,
    new_issue: pointer.newIssue,
    ...(pointer.alsoPrinted.length === 0 ? {} : { also_printed: pointer.alsoPrinted }),
  })
}
