import { MODERATED_TEXT } from './moderation.ts'

export interface GazetteQueryDatabase {
  query(text: string, params?: readonly unknown[]): Promise<unknown>
}

export type GazetteIssueSummary = Readonly<{
  issue_number: number
  scheduled_for: string
  printed_at: string
  entry_count: number
}>

export type GazetteIssueDetail = GazetteIssueSummary & Readonly<{
  header: string
}>

export type GazetteIssueEntry = Readonly<{
  ordinal: number
  note_id: number
  author: string
  body: string
  created_at: string
}>

type Row = Readonly<Record<string, unknown>>

async function rows(
  database: GazetteQueryDatabase,
  text: string,
  params: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await database.query(text, params)
  if (!Array.isArray(result)) throw new Error('database returned an invalid Gazette result')
  return result as readonly Row[]
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`database returned an invalid Gazette ${field}`)
  }
  return parsed
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`database returned an invalid Gazette ${field}`)
  }
  return parsed
}

function instant(value: unknown, field: string): string {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === 'string'
      ? Date.parse(value)
      : Number.NaN
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`database returned an invalid Gazette ${field}`)
  }
  return new Date(milliseconds).toISOString()
}

function issueSummary(row: Row): GazetteIssueSummary {
  return Object.freeze({
    issue_number: positiveInteger(row.issue_number, 'issue number'),
    scheduled_for: instant(row.scheduled_for, 'scheduled time'),
    printed_at: instant(row.printed_at, 'print time'),
    entry_count: nonnegativeInteger(row.entry_count, 'entry count'),
  })
}

export async function readGazetteSubmissionRoomState(
  database: GazetteQueryDatabase,
): Promise<Readonly<{ submissionsOpen: boolean }>> {
  const found = await rows(database, `
    /* gazette:submission-room-state */
    SELECT gazette_submission_room_is_open() AS submissions_open
  `, [])
  if (found.length !== 1 || typeof found[0]?.submissions_open !== 'boolean') {
    throw new Error('database returned an invalid Gazette submission-room state')
  }
  return Object.freeze({ submissionsOpen: found[0].submissions_open })
}

export async function listGazetteIssues(
  database: GazetteQueryDatabase,
  input: Readonly<{ beforeIssueNumber: number | null; limit: number }>,
): Promise<Readonly<{
  issues: readonly GazetteIssueSummary[]
  hasMore: boolean
  nextBeforeIssueNumber: number | null
}>> {
  const found = await rows(database, `
    /* gazette:list-issues */
    SELECT issue_number, scheduled_for, printed_at, entry_count
    FROM gazette_issues
    WHERE ($1::integer IS NULL OR issue_number < $1::integer)
    ORDER BY issue_number DESC
    LIMIT $2::integer
  `, [input.beforeIssueNumber, input.limit + 1])
  const hasMore = found.length > input.limit
  const issues = Object.freeze(found.slice(0, input.limit).map(issueSummary))
  return Object.freeze({
    issues,
    hasMore,
    nextBeforeIssueNumber: hasMore
      ? issues[issues.length - 1]?.issue_number ?? null
      : null,
  })
}

export async function readGazetteIssue(
  database: GazetteQueryDatabase,
  input: Readonly<{
    issueNumber: number
    afterOrdinal: number | null
    limit: number
  }>,
): Promise<Readonly<{
  issue: GazetteIssueDetail
  entries: readonly GazetteIssueEntry[]
  hasMore: boolean
  nextAfterOrdinal: number | null
}> | null> {
  const issueRows = await rows(database, `
    /* gazette:read-issue */
    SELECT issue_number, scheduled_for, printed_at, header, entry_count
    FROM gazette_issues
    WHERE issue_number = $1::integer
  `, [input.issueNumber])
  const storedIssue = issueRows[0]
  if (!storedIssue) return null

  const found = await rows(database, `
    /* gazette:read-entries */
    SELECT entry.ordinal, entry.note_id, author.handle AS author,
      CASE WHEN moderation.action = 'remove' THEN $4::text ELSE note.body END AS body,
      note.created_at
    FROM gazette_issue_entries entry
    JOIN notes note ON note.id = entry.note_id
    JOIN residents author ON author.id = note.author_id
    LEFT JOIN LATERAL (
      SELECT action.action
      FROM moderation_actions action
      WHERE action.target_type = 'note'
        AND action.target_id = note.id
      ORDER BY action.created_at DESC, action.id DESC
      LIMIT 1
    ) moderation ON TRUE
    WHERE entry.issue_number = $1::integer
      AND ($2::integer IS NULL OR entry.ordinal > $2::integer)
    ORDER BY entry.ordinal
    LIMIT $3::integer
  `, [input.issueNumber, input.afterOrdinal, input.limit + 1, MODERATED_TEXT])
  const hasMore = found.length > input.limit
  const entries = Object.freeze(found.slice(0, input.limit).map(row => Object.freeze({
    ordinal: positiveInteger(row.ordinal, 'entry ordinal'),
    note_id: positiveInteger(row.note_id, 'entry note ID'),
    author: String(row.author ?? ''),
    body: String(row.body ?? ''),
    created_at: instant(row.created_at, 'entry time'),
  })))
  const summary = issueSummary(storedIssue)
  return Object.freeze({
    issue: Object.freeze({
      ...summary,
      header: String(storedIssue.header ?? ''),
    }),
    entries,
    hasMore,
    nextAfterOrdinal: hasMore
      ? entries[entries.length - 1]?.ordinal ?? null
      : null,
  })
}
