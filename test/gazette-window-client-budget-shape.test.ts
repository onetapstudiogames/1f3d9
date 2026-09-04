// Round 3 review finding (PR #195, issue #71): the Gazette issue route's new
// automatic aggregate byte ceiling (src/gazette-routes.ts, src/gazette-store.ts
// readGazetteIssue) can, in principle, stop before even the first entry fits
// under the budget. The server then reports has_more true with no
// next_after_ordinal cursor (nothing was admitted to page after), which is
// exactly what readGazetteIssue returns when stoppedForTextLimit trips on the
// very first row: hasMore true, entries [], nextAfterOrdinal null.
//
// The human window's own Gazette detail read (src/window-client/program/
// 09-gazette.ts, GAZETTE_ENTRY_PAGE_LIMIT = 25 > PUBLIC_PAGE_DEFAULT = 10)
// reaches the same automatic ceiling as any other view=full read above the
// default item limit. normalizeGazetteDetailPayload's own continuation check
// (hasMore !== Boolean(nextAfterOrdinal)) treated that shape as a protocol
// violation and threw 'invalid Gazette entry continuation', turning a
// defensible budget-exhausted page into a hard client error. Today this
// cannot actually fire (25 entries at the 4,000-character note cap stay
// under the 655,360-byte ceiling), which is exactly why the review called it
// "unreachable today only by an arithmetic accident" rather than safe by
// design. This test reproduces the exact shape directly against the shipped
// normalizer, independent of that arithmetic coincidence.
import assert from 'node:assert/strict'
import test from 'node:test'
import { WINDOW_JS } from '../src/window-client.ts'

function extract(pattern: RegExp, label: string): string {
  const match = pattern.exec(WINDOW_JS)
  assert.ok(match, `${label} must be present in the client`)
  return match[0]
}

// normalizeGazetteDetailPayload calls normalizeGazetteIssueSummary and
// safeGazetteStoredText for every payload, but only reaches
// normalizeGazetteEntry or sameGazetteIssue when payload.entries or
// acceptedIssue are non-empty (Array.prototype.map never invokes its
// callback on an empty array, and `acceptedIssue && ...` short-circuits on a
// falsy acceptedIssue). This test always passes entries: [] and
// acceptedIssue: null, so only the dependencies actually reached at runtime
// are assembled here, straight from the shipped source, in dependency order.
function buildNormalizeGazetteDetailPayload(): (
  payload: unknown,
  expectedIssueNumber: number,
  requestedAfterOrdinal: number | null,
  acceptedIssue: unknown,
) => unknown {
  const parts = [
    'const GAZETTE_ENTRY_PAGE_LIMIT = 25',
    extract(/const SAFE_HANDLE = \/[^\n]*\//u, 'SAFE_HANDLE'),
    extract(/function safeId\(value\) \{[\s\S]*?\n  \}/u, 'safeId'),
    extract(/function safeDate\(value\) \{[\s\S]*?\n  \}/u, 'safeDate'),
    extract(/function safeHandle\(value\) \{[\s\S]*?\n  \}/u, 'safeHandle'),
    extract(/function hasUnsafeText\(value\) \{[\s\S]*?\n  \}/u, 'hasUnsafeText'),
    extract(
      /const containsMalformedPublicText = function containsMalformedPublicText\([\s\S]*?\n\}/u,
      'containsMalformedPublicText',
    ),
    extract(/function safeGazetteCount\(value\) \{[\s\S]*?\n  \}/u, 'safeGazetteCount'),
    extract(
      /function normalizeGazetteIssueSummary\(rawIssue\) \{[\s\S]*?\n  \}/u,
      'normalizeGazetteIssueSummary',
    ),
    extract(
      /function safeGazetteStoredText\([\s\S]*?\{[\s\S]*?\n  \}/u,
      'safeGazetteStoredText',
    ),
    extract(
      /function normalizeGazetteEntry\(rawEntry, scheduledFor\) \{[\s\S]*?\n  \}/u,
      'normalizeGazetteEntry',
    ),
    extract(
      /function normalizeGazetteDetailPayload\([\s\S]*?\{[\s\S]*?\n  \}/u,
      'normalizeGazetteDetailPayload',
    ),
    'return normalizeGazetteDetailPayload',
  ]
  return new Function(parts.join('\n\n'))() as (
    payload: unknown,
    expectedIssueNumber: number,
    requestedAfterOrdinal: number | null,
    acceptedIssue: unknown,
  ) => unknown
}

function budgetExhaustedPayload(): Readonly<Record<string, unknown>> {
  // The exact response shape src/gazette-routes.ts sends when
  // effectiveTextLimit is auto-applied (limit above PUBLIC_PAGE_DEFAULT, no
  // explicit entry_text_limit_bytes) and readGazetteIssue's stoppedForTextLimit
  // trips before admitting any entry: entries [], has_more true (from
  // itemLimitHasMore || stoppedForTextLimit), next_after_ordinal null (only
  // set when entries.length > 0), plus the budget fields including the
  // oversized item's own pointer.
  return Object.freeze({
    issue: {
      issue_number: 11,
      scheduled_for: '2026-11-16T16:00:00.000Z',
      printed_at: '2026-11-16T16:00:02.000Z',
      entry_count: 25,
      header: 'THE GAZETTE ISSUE 11',
    },
    entries: [],
    has_more: true,
    next_after_ordinal: null,
    returned_text_bytes: 0,
    text_limit_bytes: 655360,
    stopped_for_text_limit: true,
    next_item_ordinal: 1,
    next_item_note_id: 9000,
    next_item_text_bytes: 700000,
    server_text_limit_applied: true,
  })
}

test('the window Gazette detail normalizer does not hard-error on a budget-exhausted empty page', () => {
  const normalize = buildNormalizeGazetteDetailPayload()
  const payload = budgetExhaustedPayload()

  const page = normalize(payload, 11, null, null) as Readonly<{
    entries: readonly unknown[]
    hasMore: boolean
    nextAfterOrdinal: number | null
  }>

  assert.equal(page.entries.length, 0)
  // With no cursor to continue from, the window has nothing more it can
  // request for this page; it must not claim more entries are pending.
  assert.equal(page.hasMore, false)
  assert.equal(page.nextAfterOrdinal, null)
})

test('the window Gazette detail normalizer still rejects a genuinely inconsistent continuation', () => {
  // Guards against the fix over-widening the exemption: hasMore true with a
  // missing cursor is only tolerated when nothing was admitted. hasMore true,
  // no cursor, but entries present is still a protocol violation.
  const normalize = buildNormalizeGazetteDetailPayload()
  const payload = {
    ...budgetExhaustedPayload(),
    entries: [{
      ordinal: 1,
      note_id: 9001,
      author: 'tiny-lantern',
      body: 'hello',
      created_at: '2026-11-16T00:00:00.000Z',
    }],
  }

  assert.throws(
    () => normalize(payload, 11, null, null),
    /invalid Gazette entry continuation/u,
  )
})
