import type { Context, Hono } from 'hono'

import { err } from './core.ts'
import { cronBearerAuthorization } from './cron-auth.ts'
import {
  GAZETTE_FIRST_PRINT_AT,
  GAZETTE_WITHDRAWAL_COMMAND,
  GAZETTE_WITHDRAWALS_CLOSED_ERROR,
  gazetteWithdrawalNotice,
} from './gazette.ts'
import { allowedPublicQuery, parsePublicPage } from './public-pagination.ts'

export interface GazetteIssueSummary {
  readonly issue_number: number
  readonly scheduled_for: string
  readonly printed_at: string
  readonly entry_count: number
}

export interface GazetteIssue extends GazetteIssueSummary {
  readonly header: string
}

export interface GazetteIssueEntry {
  readonly ordinal: number
  readonly note_id: number
  readonly author: string
  readonly body: string
  readonly created_at: string
  readonly withdrawn: boolean
  readonly withdrawal_note_id: number | null
  readonly withdrawn_at: string | null
}

export interface GazetteRouteDependencies<Database = unknown> {
  readSubmissionRoomState(): Promise<Readonly<{
    submissionsOpen: boolean
    withdrawalsOpen: boolean
  }>>
  listIssues(input: Readonly<{
    beforeIssueNumber: number | null
    limit: number
  }>): Promise<Readonly<{
    issues: readonly GazetteIssueSummary[]
    hasMore: boolean
    nextBeforeIssueNumber: number | null
  }>>
  readIssue(input: Readonly<{
    issueNumber: number
    afterOrdinal: number | null
    limit: number
  }>): Promise<Readonly<{
    issue: GazetteIssue
    entries: readonly GazetteIssueEntry[]
    hasMore: boolean
    nextAfterOrdinal: number | null
  }> | null>
  readonly database: Database
  printGazetteIssuesDue(database: Database): Promise<unknown>
  readonly environment: Readonly<Record<string, string | undefined>>
}

function noStoreHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
}

function privateHeaders(c: Context): void {
  noStoreHeaders(c)
  c.header('Vary', 'Authorization')
}

function issueSummary(issue: GazetteIssueSummary): GazetteIssueSummary {
  return {
    issue_number: issue.issue_number,
    scheduled_for: issue.scheduled_for,
    printed_at: issue.printed_at,
    entry_count: issue.entry_count,
  }
}

function issueDetail(issue: GazetteIssue): GazetteIssue {
  return {
    issue_number: issue.issue_number,
    scheduled_for: issue.scheduled_for,
    printed_at: issue.printed_at,
    header: issue.header,
    entry_count: issue.entry_count,
  }
}

function issueEntry(entry: GazetteIssueEntry): GazetteIssueEntry {
  return {
    ordinal: entry.ordinal,
    note_id: entry.note_id,
    author: entry.author,
    body: entry.withdrawn ? gazetteWithdrawalNotice(entry.note_id) : entry.body,
    created_at: entry.created_at,
    withdrawn: entry.withdrawn,
    withdrawal_note_id: entry.withdrawal_note_id,
    withdrawn_at: entry.withdrawn_at,
  }
}

const GAZETTE_WITHDRAWAL_CONTRACT = Object.freeze({
  command: GAZETTE_WITHDRAWAL_COMMAND,
  author_only: true,
  founder_override: false,
  deadline: "strictly before that submission's Monday 16:00 UTC print tick",
  weekly_slot_restored: false,
  command_counts_toward_weekly_limit: false,
  command_counts_toward_daily_note_limit: true,
  command_visibility: 'stored as an ordinary public note in room #454',
  command_printed: false,
  printed_notice: 'note #<note-id>, withdrawn by its author before the tick',
  refusals: Object.freeze({
    malformed_command: Object.freeze({
      status: 400,
      error: `Gazette withdrawal must be exactly ${GAZETTE_WITHDRAWAL_COMMAND}`,
    }),
    withdrawals_inactive: Object.freeze({
      status: 409,
      error: GAZETTE_WITHDRAWALS_CLOSED_ERROR,
    }),
    no_such_submission: Object.freeze({
      status: 404,
      error: 'Gazette submission note #<note-id> was not found in room #454',
    }),
    author_mismatch: Object.freeze({
      status: 403,
      error: 'only the author may withdraw Gazette submission note #<note-id>; you are not its author',
    }),
    already_printed: Object.freeze({
      status: 409,
      error: 'Gazette submission note #<note-id> already printed in issue #<issue-number> and cannot be withdrawn',
    }),
    tick_passed: Object.freeze({
      status: 409,
      error: 'Gazette submission note #<note-id> can be withdrawn only strictly before <print-tick>; that print tick has passed',
    }),
    already_withdrawn: Object.freeze({
      status: 409,
      error: 'Gazette submission note #<note-id> was already withdrawn by its author',
    }),
  }),
})

function positivePostgresInteger(value: string): number | null {
  if (!/^[0-9]+$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647
    ? parsed
    : null
}

export function mountGazetteRoutes<Database>(
  app: Hono,
  dependencies: GazetteRouteDependencies<Database>,
): void {
  app.get('/api/gazette', async c => {
    noStoreHeaders(c)
    const queries = c.req.queries()
    const allowed = allowedPublicQuery(queries, ['before_issue_number', 'limit'])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const page = parsePublicPage(queries, 'before_issue_number', 'limit')
    if (!page.ok) return err(c, 400, page.error)

    const [result, roomState] = await Promise.all([
      dependencies.listIssues({
        beforeIssueNumber: page.cursor,
        limit: page.limit,
      }),
      dependencies.readSubmissionRoomState(),
    ])
    return c.json({
      first_print_at: GAZETTE_FIRST_PRINT_AT,
      submission_room: {
        place_id: 454,
        submissions_open: roomState.submissionsOpen,
        withdrawals_open: roomState.withdrawalsOpen,
      },
      withdrawal_contract: GAZETTE_WITHDRAWAL_CONTRACT,
      issues: result.issues.map(issueSummary),
      has_more: result.hasMore,
      next_before_issue_number: result.nextBeforeIssueNumber,
    })
  })

  app.get('/api/gazette/:issue_number', async c => {
    noStoreHeaders(c)
    const issueNumber = positivePostgresInteger(c.req.param('issue_number'))
    if (issueNumber === null) return err(c, 400, 'issue_number must be a positive integer')
    const queries = c.req.queries()
    const allowed = allowedPublicQuery(queries, ['after_ordinal', 'limit'])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const page = parsePublicPage(queries, 'after_ordinal', 'limit')
    if (!page.ok) return err(c, 400, page.error)

    const result = await dependencies.readIssue({
      issueNumber,
      afterOrdinal: page.cursor,
      limit: page.limit,
    })
    if (!result) return err(c, 404, 'Gazette issue not found')
    return c.json({
      issue: issueDetail(result.issue),
      entries: result.entries.map(issueEntry),
      has_more: result.hasMore,
      next_after_ordinal: result.nextAfterOrdinal,
    })
  })

  app.get('/api/internal/gazette-print', async c => {
    privateHeaders(c)
    if (Object.keys(c.req.queries()).length !== 0) {
      return err(c, 400, 'Gazette print accepts no query options')
    }
    const authorization = cronBearerAuthorization(
      dependencies.environment,
      c.req.header('authorization'),
    )
    if (authorization === 'unavailable') return err(c, 503, 'Gazette print is unavailable')
    if (authorization !== 'authorized') return err(c, 401, 'Gazette print authorization failed')

    await dependencies.printGazetteIssuesDue(dependencies.database)
    return c.json({ ok: true })
  })
}
