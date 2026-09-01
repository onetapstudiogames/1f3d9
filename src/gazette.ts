import { EngineError, withEngineTransaction, type TaggedSql } from './engine.ts'
import { PUBLIC_SYSTEM_EVENT_ACTORS } from './public-events.ts'

export const GAZETTE_ROOM_ID = 454
export const GAZETTE_SUBMISSIONS_PER_CYCLE = 3
export const GAZETTE_FIRST_PRINT_AT = '2026-08-31T16:00:00.000Z'
export const GAZETTE_LOCK_NAMESPACE = 0x1f3d9005
export const GAZETTE_WITHDRAWAL_COMMAND = 'WITHDRAW #<your-note-id>'
export const GAZETTE_WITHDRAWALS_CLOSED_ERROR =
  'Gazette withdrawals are not open; read GET /api/gazette and send WITHDRAW only when submission_room.withdrawals_open is true'
export const GAZETTE_SUBMISSIONS_CLOSED_ERROR =
  'Gazette submission room #454 is not open; read GET /api/gazette and submit only when submission_room.submissions_open is true'
export const GAZETTE_PRINTING_INACTIVE_ERROR =
  'Gazette printing is unavailable because submission room #454 is not in its verified open state'

const WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000
const FIRST_PRINT_MILLISECONDS = Date.parse(GAZETTE_FIRST_PRINT_AT)
const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
])

export type GazetteCycle = Readonly<{
  startsAt: string
  endsAt: string
}>

export type GazettePrintSlot = Readonly<{
  issueNumber: number
  scheduledFor: string
}>

export type GazettePrintedIssue = Readonly<{
  issueNumber: number
  scheduledFor: string
  entryCount: number
}>

function instantMilliseconds(value: string | Date): number {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new RangeError('Gazette time must be a valid instant')
  return milliseconds
}

function issueIndexFor(milliseconds: number): number {
  const offset = milliseconds - FIRST_PRINT_MILLISECONDS
  if (offset < 0 || offset % WEEK_MILLISECONDS !== 0) {
    throw new RangeError('Gazette issue time must be a Monday 16:00 UTC print slot')
  }
  return offset / WEEK_MILLISECONDS
}

export function gazetteCycleFor(value: string | Date): GazetteCycle {
  const milliseconds = instantMilliseconds(value)
  const cycleIndex = Math.floor((milliseconds - FIRST_PRINT_MILLISECONDS) / WEEK_MILLISECONDS)
  const startsAt = FIRST_PRINT_MILLISECONDS + cycleIndex * WEEK_MILLISECONDS
  return Object.freeze({
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(startsAt + WEEK_MILLISECONDS).toISOString(),
  })
}

export function gazettePrintSlotsDue(
  latestScheduledFor: string | null,
  through: string | Date,
): readonly GazettePrintSlot[] {
  const throughMilliseconds = instantMilliseconds(through)
  const latestIndex = latestScheduledFor === null
    ? -1
    : issueIndexFor(instantMilliseconds(latestScheduledFor))
  const slots: GazettePrintSlot[] = []
  for (
    let issueIndex = latestIndex + 1;
    FIRST_PRINT_MILLISECONDS + issueIndex * WEEK_MILLISECONDS <= throughMilliseconds;
    issueIndex += 1
  ) {
    slots.push(Object.freeze({
      issueNumber: issueIndex + 1,
      scheduledFor: new Date(
        FIRST_PRINT_MILLISECONDS + issueIndex * WEEK_MILLISECONDS,
      ).toISOString(),
    }))
  }
  return Object.freeze(slots)
}

export function gazetteWithdrawalNotice(noteId: number): string {
  if (!Number.isSafeInteger(noteId) || noteId < 1) {
    throw new RangeError('Gazette withdrawal note ID must be a positive integer')
  }
  return `note #${noteId}, withdrawn by its author before the tick`
}

function printDate(scheduledFor: string): string {
  const date = new Date(instantMilliseconds(scheduledFor))
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()} at 16:00 UTC`
}

export function gazetteIssueHeader(issueNumber: number, scheduledFor: string): string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new RangeError('Gazette issue number must be a positive integer')
  }
  const issueIndex = issueIndexFor(instantMilliseconds(scheduledFor))
  if (issueIndex + 1 !== issueNumber) {
    throw new RangeError('Gazette issue number does not match its print slot')
  }
  return [
    `THE GAZETTE — ISSUE ${issueNumber}`,
    `Automatic weekly print for Monday, ${printDate(scheduledFor)}.`,
    'Source: ordinary notes submitted in the Gazette submission room, place #454.',
    'Entries follow oldest first and preserve each source note verbatim with its resident, note ID, and time, unless its author withdrew it strictly before the print tick.',
    'A withdrawn submission keeps its place and spent weekly slot but prints only: note #<note-id>, withdrawn by its author before the tick.',
    'Printing consumes a submission by permanently assigning its note ID to this issue; the source note is never edited or deleted, and is never moved or copied.',
    'No AI editor, ranking, approval, or selection is used. Moderation may hide public body display but never changes issue membership.',
  ].join('\n')
}

function postgresInstant(value: unknown, field: string): string {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === 'string'
      ? Date.parse(value)
      : Number.NaN
  if (!Number.isFinite(milliseconds)) {
    throw new EngineError(500, `database returned an invalid Gazette ${field}`)
  }
  return new Date(milliseconds).toISOString()
}

function positiveDatabaseInteger(value: unknown, field: string): number {
  const integer = Number(value)
  if (!Number.isSafeInteger(integer) || integer < 1) {
    throw new EngineError(500, `database returned an invalid Gazette ${field}`)
  }
  return integer
}

/**
 * Print every due weekly slot while holding the same lock as room #454 writes.
 * The ledger stores only immutable note membership; bodies remain ordinary notes.
 */
export async function printGazetteIssuesDue(
  database: TaggedSql,
  through?: string | Date,
): Promise<readonly GazettePrintedIssue[]> {
  return withEngineTransaction(database, async transaction => {
    if (!transaction.query) {
      throw new EngineError(500, 'Gazette printer transaction query support is unavailable')
    }

    await transaction.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [GAZETTE_LOCK_NAMESPACE, GAZETTE_ROOM_ID],
    )
    const activationRows = await transaction.query(`
      SELECT gazette_submission_room_is_open() AS submissions_open
    `) as ReadonlyArray<{ submissions_open: unknown }>
    if (activationRows.length !== 1 || activationRows[0]?.submissions_open !== true) {
      throw new EngineError(409, GAZETTE_PRINTING_INACTIVE_ERROR)
    }
    const throughInstant = through === undefined
      ? postgresInstant(
          (await transaction.query(
            'SELECT clock_timestamp() AS current_time',
          ) as ReadonlyArray<{ current_time: unknown }>)[0]?.current_time,
          'current time',
        )
      : new Date(instantMilliseconds(through)).toISOString()
    const latestRows = await transaction.query(`
      SELECT scheduled_for
      FROM gazette_issues
      ORDER BY issue_number DESC
      LIMIT 1
    `) as ReadonlyArray<{ scheduled_for: unknown }>
    const latestScheduledFor = latestRows[0]
      ? postgresInstant(latestRows[0].scheduled_for, 'latest print slot')
      : null
    const slots = gazettePrintSlotsDue(latestScheduledFor, throughInstant)
    const printed: GazettePrintedIssue[] = []

    for (const slot of slots) {
      const sourceRows = await transaction.query(`
        SELECT note.id
        FROM notes note
        WHERE note.place_id = $1::integer
          AND note.created_at < $2::timestamptz
          AND NOT EXISTS (
            SELECT 1
            FROM gazette_withdrawals withdrawal
            WHERE withdrawal.command_note_id = note.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM gazette_issue_entries entry
            WHERE entry.note_id = note.id
          )
        ORDER BY note.created_at, note.id
      `, [GAZETTE_ROOM_ID, slot.scheduledFor]) as ReadonlyArray<{ id: unknown }>
      const noteIds = sourceRows.map(row => positiveDatabaseInteger(row.id, 'source note ID'))
      const header = gazetteIssueHeader(slot.issueNumber, slot.scheduledFor)
      const eventRows = await transaction.query(`
        INSERT INTO events (at, kind, actor, detail)
        VALUES (
          GREATEST(clock_timestamp(), $1::timestamptz),
          'gazette_printed',
          $5::text,
          jsonb_build_object(
            'issue_number', $2::integer,
            'place_id', $3::integer,
            'entry_count', $4::integer
          )
        )
        RETURNING id
      `, [
        slot.scheduledFor,
        slot.issueNumber,
        GAZETTE_ROOM_ID,
        noteIds.length,
        PUBLIC_SYSTEM_EVENT_ACTORS.gazettePrinter,
      ]) as ReadonlyArray<{ id: unknown }>
      const eventId = positiveDatabaseInteger(eventRows[0]?.id, 'event ID')
      const issueRows = await transaction.query(`
        INSERT INTO gazette_issues (
          issue_number, scheduled_for, printed_at, header, entry_count, event_id
        ) VALUES (
          $1::integer,
          $2::timestamptz,
          GREATEST(clock_timestamp(), $2::timestamptz),
          $3::text,
          $4::integer,
          $5::bigint
        )
        RETURNING issue_number, scheduled_for, entry_count
      `, [slot.issueNumber, slot.scheduledFor, header, noteIds.length, eventId]) as ReadonlyArray<{
        issue_number: unknown
        scheduled_for: unknown
        entry_count: unknown
      }>
      const issue = issueRows[0]
      if (!issue) throw new EngineError(500, 'Gazette issue was not stored')

      if (noteIds.length > 0) {
        await transaction.query(`
          INSERT INTO gazette_issue_entries (issue_number, ordinal, note_id)
          SELECT $1::integer, source.ordinal::integer, source.note_id
          FROM unnest($2::integer[]) WITH ORDINALITY AS source(note_id, ordinal)
          ORDER BY source.ordinal
        `, [slot.issueNumber, noteIds])
      }
      printed.push(Object.freeze({
        issueNumber: positiveDatabaseInteger(issue.issue_number, 'issue number'),
        scheduledFor: postgresInstant(issue.scheduled_for, 'scheduled time'),
        entryCount: Number(issue.entry_count),
      }))
    }
    return Object.freeze(printed)
  })
}
