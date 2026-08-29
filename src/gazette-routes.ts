import type { Context, Hono } from 'hono'

import { err } from './core.ts'
import { cronBearerAuthorization } from './cron-auth.ts'
import { GAZETTE_FIRST_PRINT_AT } from './gazette.ts'
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
}

export interface GazetteRouteDependencies<Database = unknown> {
  readSubmissionRoomState(): Promise<Readonly<{ submissionsOpen: boolean }>>
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
    body: entry.body,
    created_at: entry.created_at,
  }
}

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
      },
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
