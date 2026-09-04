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
  author_id: number
  author: string
  body: string
  created_at: string
  withdrawn: boolean
  withdrawal_note_id: number | null
  withdrawn_at: string | null
}>

export type GazetteIssueFacts = GazetteIssueSummary & Readonly<{
  resident_count: number
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

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : positiveInteger(value, field)
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

function nullableInstant(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : instant(value, field)
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
): Promise<Readonly<{ submissionsOpen: boolean; withdrawalsOpen: boolean }>> {
  const found = await rows(database, `
    /* gazette:submission-room-state */
    SELECT gazette_submission_room_is_open() AS submissions_open,
      gazette_withdrawals_are_open() AS withdrawals_open
  `, [])
  if (
    found.length !== 1
    || typeof found[0]?.submissions_open !== 'boolean'
    || typeof found[0]?.withdrawals_open !== 'boolean'
  ) {
    throw new Error('database returned an invalid Gazette submission-room state')
  }
  return Object.freeze({
    submissionsOpen: found[0].submissions_open,
    withdrawalsOpen: found[0].withdrawals_open,
  })
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
    // A caller-chosen aggregate byte budget across this page's entry bodies,
    // mirroring note_text_limit_bytes on place reads (issue #71): the same
    // batched-body-ambush shape applies here (many resident-authored Gazette
    // entries in one response), so the same defense applies here. null (the
    // default) applies no budget, matching every existing caller.
    textLimitBytes?: number | null
  }>,
): Promise<Readonly<{
  issue: GazetteIssueDetail
  entries: readonly GazetteIssueEntry[]
  hasMore: boolean
  nextAfterOrdinal: number | null
  returnedTextBytes: number
  stoppedForTextLimit: boolean
  nextItemOrdinal: number | null
  nextItemNoteId: number | null
  nextItemTextBytes: number | null
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
    SELECT entry.ordinal, entry.note_id, author.id AS author_id, author.handle AS author,
      CASE
        WHEN withdrawal.target_note_id IS NOT NULL
          THEN 'note #' || note.id::text || ', withdrawn by its author before the tick'
        WHEN moderation.action = 'remove' THEN $4::text
        ELSE note.body
      END AS body,
      note.created_at,
      withdrawal.target_note_id IS NOT NULL AS withdrawn,
      withdrawal.command_note_id AS withdrawal_note_id,
      withdrawal.withdrawn_at
    FROM gazette_issue_entries entry
    JOIN notes note ON note.id = entry.note_id
    JOIN residents author ON author.id = note.author_id
    LEFT JOIN gazette_withdrawals withdrawal ON withdrawal.target_note_id = note.id
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
  const itemLimitHasMore = found.length > input.limit
  const pageRows = found.slice(0, input.limit).map(row => {
    if (typeof row.withdrawn !== 'boolean') {
      throw new Error('database returned an invalid Gazette withdrawal state')
    }
    const withdrawalNoteId = nullablePositiveInteger(
      row.withdrawal_note_id,
      'withdrawal note ID',
    )
    const withdrawnAt = nullableInstant(row.withdrawn_at, 'withdrawal time')
    if (row.withdrawn !== (withdrawalNoteId !== null && withdrawnAt !== null)) {
      throw new Error('database returned inconsistent Gazette withdrawal facts')
    }
    return Object.freeze({
      ordinal: positiveInteger(row.ordinal, 'entry ordinal'),
      note_id: positiveInteger(row.note_id, 'entry note ID'),
      author_id: positiveInteger(row.author_id, 'entry author ID'),
      author: String(row.author ?? ''),
      body: String(row.body ?? ''),
      created_at: instant(row.created_at, 'entry time'),
      withdrawn: row.withdrawn,
      withdrawal_note_id: withdrawalNoteId,
      withdrawn_at: withdrawnAt,
    })
  })

  // Same budgeted-page shape as effectivePublicPlaceTextLimit's SQL sibling
  // in public-pagination.ts: walk entries in their returned order, admit an
  // entry only while the running total stays at or under the budget, and
  // never cut or skip a record to squeeze in an older one. Entries are
  // already the exact bytes the caller receives (withdrawal notices and
  // moderated placeholders are substituted above, before this walk runs).
  const textLimitBytes = input.textLimitBytes ?? null
  let cutoffIndex = pageRows.length
  let stoppedForTextLimit = false
  if (textLimitBytes != null) {
    let cumulative = 0
    for (const [index, row] of pageRows.entries()) {
      const bytes = Buffer.byteLength(row.body, 'utf8')
      if (cumulative + bytes > textLimitBytes) {
        cutoffIndex = index
        stoppedForTextLimit = true
        break
      }
      cumulative += bytes
    }
  }
  const entries = Object.freeze(pageRows.slice(0, cutoffIndex))
  const nextItemRow = stoppedForTextLimit ? pageRows[cutoffIndex] ?? null : null
  const hasMore = itemLimitHasMore || stoppedForTextLimit
  const returnedTextBytes = entries.reduce(
    (total, entry) => total + Buffer.byteLength(entry.body, 'utf8'),
    0,
  )

  const summary = issueSummary(storedIssue)
  return Object.freeze({
    issue: Object.freeze({
      ...summary,
      header: String(storedIssue.header ?? ''),
    }),
    entries,
    hasMore,
    nextAfterOrdinal: hasMore && entries.length > 0
      ? entries[entries.length - 1]?.ordinal ?? null
      : null,
    returnedTextBytes,
    stoppedForTextLimit,
    nextItemOrdinal: nextItemRow?.ordinal ?? null,
    nextItemNoteId: nextItemRow?.note_id ?? null,
    nextItemTextBytes: nextItemRow == null ? null : Buffer.byteLength(nextItemRow.body, 'utf8'),
  })
}

export async function readCompleteGazetteIssue(
  database: GazetteQueryDatabase,
  issueNumber: number,
): Promise<Readonly<{
  issue: GazetteIssueDetail
  entries: readonly GazetteIssueEntry[]
}> | null> {
  const firstPage = await readGazetteIssue(database, {
    issueNumber,
    afterOrdinal: null,
    limit: 200,
  })
  if (!firstPage) return null

  let entries = firstPage.entries
  let hasMore = firstPage.hasMore
  let nextAfterOrdinal = firstPage.nextAfterOrdinal
  while (hasMore) {
    if (nextAfterOrdinal === null) {
      throw new Error('Gazette issue pagination ended before the issue was complete')
    }
    const previousOrdinal = nextAfterOrdinal
    const nextPage = await readGazetteIssue(database, {
      issueNumber,
      afterOrdinal: nextAfterOrdinal,
      limit: 200,
    })
    if (!nextPage) throw new Error('Gazette issue disappeared while reading the permanent page')
    entries = Object.freeze([...entries, ...nextPage.entries])
    hasMore = nextPage.hasMore
    nextAfterOrdinal = nextPage.nextAfterOrdinal
    if (hasMore && (nextAfterOrdinal === null || nextAfterOrdinal <= previousOrdinal)) {
      throw new Error('Gazette issue pagination did not advance')
    }
  }
  if (entries.length !== firstPage.issue.entry_count) {
    throw new Error('Gazette issue entry count changed while reading the permanent page')
  }

  return Object.freeze({
    issue: firstPage.issue,
    entries,
  })
}

export async function readGazetteIssueFacts(
  database: GazetteQueryDatabase,
  issueNumber: number,
): Promise<GazetteIssueFacts | null> {
  const found = await rows(database, `
    /* gazette:read-issue-facts */
    SELECT issue.issue_number, issue.scheduled_for, issue.printed_at, issue.entry_count,
      count(DISTINCT note.author_id)::integer AS resident_count
    FROM gazette_issues issue
    LEFT JOIN gazette_issue_entries entry ON entry.issue_number = issue.issue_number
    LEFT JOIN notes note ON note.id = entry.note_id
    WHERE issue.issue_number = $1::integer
    GROUP BY issue.issue_number, issue.scheduled_for, issue.printed_at, issue.entry_count
  `, [issueNumber])
  const storedIssue = found[0]
  if (!storedIssue) return null
  return Object.freeze({
    ...issueSummary(storedIssue),
    resident_count: nonnegativeInteger(storedIssue.resident_count, 'resident count'),
  })
}
