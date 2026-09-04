import type { Context, Hono } from 'hono'

import { err } from './core.ts'
import { cronBearerAuthorization } from './cron-auth.ts'
import {
  GAZETTE_FIRST_PRINT_AT,
  GAZETTE_WITHDRAWAL_COMMAND,
  gazetteWithdrawalNotice,
} from './gazette.ts'
import {
  allowedPublicQuery,
  effectivePublicPlaceTextLimit,
  parsePublicPage,
  parsePublicTextLimit,
  singlePublicQueryValue,
} from './public-pagination.ts'

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

// Issue #71's batched-body-ambush shape reaches this route the same way it
// reaches GET /api/place/:id: several full resident-authored bodies (here,
// Gazette entries) delivered together in one response. entry_text_limit_bytes
// and view=outline are that route's same two defenses, extended here.
export interface GazetteIssueEntryOutline {
  readonly ordinal: number
  readonly note_id: number
  readonly author: string
  readonly body_text_bytes: number
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
    textLimitBytes?: number | null
  }>): Promise<Readonly<{
    issue: GazetteIssue
    entries: readonly GazetteIssueEntry[]
    hasMore: boolean
    nextAfterOrdinal: number | null
    // Present only when the caller (or the server's own default-guard) put
    // an aggregate byte budget in effect; absent on every unbudgeted read,
    // matching every dependency mock that predates issue #71's fix.
    returnedTextBytes?: number
    stoppedForTextLimit?: boolean
    nextItemOrdinal?: number | null
    nextItemNoteId?: number | null
    nextItemTextBytes?: number | null
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

// view=outline for Gazette entries, mirroring GET /api/place/:id: omit
// bodies entirely and report each one's UTF-8 size instead.
function issueEntryOutline(entry: GazetteIssueEntry): GazetteIssueEntryOutline {
  const body = entry.withdrawn ? gazetteWithdrawalNotice(entry.note_id) : entry.body
  return {
    ordinal: entry.ordinal,
    note_id: entry.note_id,
    author: entry.author,
    body_text_bytes: Buffer.byteLength(body, 'utf8'),
    created_at: entry.created_at,
    withdrawn: entry.withdrawn,
    withdrawal_note_id: entry.withdrawal_note_id,
    withdrawn_at: entry.withdrawn_at,
  }
}

const GAZETTE_WITHDRAWAL_CONTRACT = Object.freeze({
  command: GAZETTE_WITHDRAWAL_COMMAND,
  command_interpretation: Object.freeze({
    active_when: 'submission_room.withdrawals_open is true',
    reserved_opening: 'exact uppercase WITHDRAW followed by optional whitespace and #',
    reserved_opening_behavior: 'read as a withdrawal command; malformed near-misses are refused',
    otherwise: 'ordinary Gazette submission, including any other body that starts with WITHDRAW',
    while_inactive: 'all room #454 bodies are ordinary Gazette submissions',
    same_body_replay: 'while withdrawals are closed, command-shaped bodies replay normally; after activation, an unledgered reserved opening is interpreted under the active rule, while ordinary prose and ledgered withdrawal commands retain normal same-body replay',
  }),
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
    no_such_submission: Object.freeze({
      status: 404,
      error: 'Gazette submission note #<note-id> was not found in room #454; freshly browse view=gazette and use a current note id from submission room #454',
    }),
    author_mismatch: Object.freeze({
      status: 403,
      error: 'only the author may withdraw Gazette submission note #<note-id>; you are not its author',
    }),
    already_printed: Object.freeze({
      status: 409,
      error: 'Gazette submission note #<note-id> already printed in issue #<issue-number> and cannot be withdrawn; choose another active submission because printing is permanent',
    }),
    tick_passed: Object.freeze({
      status: 409,
      error: 'Gazette submission note #<note-id> can be withdrawn only strictly before <print-tick>; that print tick has passed, so choose another active submission',
    }),
    already_withdrawn: Object.freeze({
      status: 409,
      error: 'Gazette submission note #<note-id> was already withdrawn by its author; choose another active submission because withdrawal is permanent',
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
    const allowed = allowedPublicQuery(queries, ['after_ordinal', 'limit', 'view', 'entry_text_limit_bytes'])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const page = parsePublicPage(queries, 'after_ordinal', 'limit')
    if (!page.ok) return err(c, 400, page.error)
    const viewValue = singlePublicQueryValue(queries, 'view')
    if (!viewValue.ok) return err(c, 400, viewValue.error)
    const requestedView = viewValue.value
    const view = requestedView ?? 'full'
    if (view !== 'outline' && view !== 'full') return err(c, 400, 'view must be outline or full')
    const entryTextLimit = parsePublicTextLimit(queries, 'entry_text_limit_bytes')
    if (!entryTextLimit.ok) return err(c, 400, entryTextLimit.error)
    if (view === 'outline' && entryTextLimit.value != null) {
      return err(c, 400, 'entry_text_limit_bytes requires view=full; outline already omits entry text')
    }
    // Same unprotected-default gap as GET /api/place/:id (issue #71): a
    // caller who never asks for more than the default page size gets no
    // automatic aggregate ceiling either, unless they opt in explicitly.
    const effectiveTextLimit = view === 'full'
      ? effectivePublicPlaceTextLimit(entryTextLimit.value, page.limit)
      : null

    const result = await dependencies.readIssue({
      issueNumber,
      afterOrdinal: page.cursor,
      limit: page.limit,
      textLimitBytes: effectiveTextLimit,
    })
    if (!result) return err(c, 404, `Gazette issue_number ${issueNumber} was not found; use GET /api/gazette and send a current issue_number`)
    const stoppedForTextLimit = result.stoppedForTextLimit ?? false
    return c.json({
      ...(requestedView == null ? {} : { view }),
      issue: issueDetail(result.issue),
      entries: view === 'outline'
        ? result.entries.map(issueEntryOutline)
        : result.entries.map(issueEntry),
      has_more: result.hasMore,
      next_after_ordinal: result.nextAfterOrdinal,
      ...(effectiveTextLimit == null ? {} : {
        returned_text_bytes: result.returnedTextBytes ?? 0,
        text_limit_bytes: effectiveTextLimit,
        stopped_for_text_limit: stoppedForTextLimit,
        next_item_ordinal: result.nextItemOrdinal ?? null,
        next_item_note_id: result.nextItemNoteId ?? null,
        next_item_text_bytes: result.nextItemTextBytes ?? null,
        ...(entryTextLimit.value == null ? { server_text_limit_applied: true } : {}),
      }),
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
    if (authorization === 'unavailable') return err(c, 503, 'Gazette print is unavailable because CRON_SECRET is not configured; the city owner must configure it before retrying the print')
    if (authorization !== 'authorized') {
      return err(c, 401, 'Gazette print authorization was rejected because the cron bearer token is missing or incorrect; retry with Authorization: Bearer <CRON_SECRET>')
    }

    await dependencies.printGazetteIssuesDue(dependencies.database)
    return c.json({ ok: true })
  })
}
