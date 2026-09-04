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
    budgetCut: Readonly<{ nextItemNoteId: number | null, nextItemTextBytes: number | null }> | null
  }>

  assert.equal(page.entries.length, 0)
  // With no cursor to continue from, the window has nothing more it can
  // request for this page; it must not claim more entries are pending.
  assert.equal(page.hasMore, false)
  assert.equal(page.nextAfterOrdinal, null)
  // Round 4 review finding 2: the render layer needs to tell this shape
  // apart from a genuinely empty issue. The normalizer must surface which
  // entry the size limit could not fit, straight from the server's own
  // next_item_note_id / next_item_text_bytes fields.
  assert.deepEqual(page.budgetCut, { nextItemNoteId: 9000, nextItemTextBytes: 700000 })
})

test('the window Gazette detail normalizer reports no budget cut on a genuinely admitted page', () => {
  // Regression guard: an ordinary successful page (entries admitted, cursor
  // present) must not carry a budgetCut, or every "Load more" page would
  // wrongly look like a cut-short one.
  const normalize = buildNormalizeGazetteDetailPayload()
  const payload = {
    ...budgetExhaustedPayload(),
    issue: {
      issue_number: 11,
      scheduled_for: '2026-11-16T16:00:00.000Z',
      printed_at: '2026-11-16T16:00:02.000Z',
      entry_count: 1,
      header: 'THE GAZETTE ISSUE 11',
    },
    entries: [{
      ordinal: 1,
      note_id: 9001,
      author: 'tiny-lantern',
      body: 'hello',
      created_at: '2026-11-16T00:00:00.000Z',
    }],
    has_more: false,
    next_after_ordinal: null,
    stopped_for_text_limit: false,
    next_item_ordinal: null,
    next_item_note_id: null,
    next_item_text_bytes: null,
  }

  const page = normalize(payload, 11, null, null) as Readonly<{ budgetCut: unknown }>

  assert.equal(page.budgetCut, null)
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

// Round 4 review finding 2 (issue #71), the gap this fix closes: the
// budget-exhausted exemption above stopped the hard error, but the render
// layer could not tell "genuinely empty issue" apart from "size limit cut
// this page before the first entry fit", and printed the same "no
// submissions" sentence for both while the issue card next to it kept
// showing the true entry count. The tests below extract the shipped render
// functions and prove the detail pane now says what actually happened, and
// still agrees with the count the card shows.
type FakeNode = {
  tagName: string
  className: string
  textContent: string
  children: FakeNode[]
  dataset: Record<string, string>
  hidden: boolean
  attributes: Record<string, string>
  href: string
  setAttribute(name: string, value: string): void
  append(...kids: FakeNode[]): void
  replaceChildren(...kids: FakeNode[]): void
  addEventListener(): void
}

function fakeElement(tagName: string): FakeNode {
  const node = {
    tagName,
    className: '',
    textContent: '',
    children: [],
    dataset: {},
    hidden: false,
    attributes: {},
    href: '',
    addEventListener() {},
  } as unknown as FakeNode
  node.setAttribute = (name, value) => { node.attributes[name] = value }
  node.append = (...kids) => { node.children.push(...kids) }
  node.replaceChildren = (...kids) => { node.children = kids }
  return node
}

function fakeDocument(): { createElement(tagName: string): FakeNode } {
  return { createElement: (tagName: string) => fakeElement(tagName) }
}

function buildGazetteRenderFunctions(): (
  document: unknown,
  nodes: Readonly<Record<string, FakeNode>>,
  state: Readonly<Record<string, unknown>>,
) => Readonly<{
  renderGazetteIssue: (gazette: Record<string, unknown>) => void
  gazetteIssueLink: (issue: Record<string, unknown>) => FakeNode
  gazetteBudgetCutMessage: (issue: Record<string, unknown>, budgetCut: Record<string, unknown>) => string
}> {
  const parts = [
    extract(/function element\(tagName, className, text\) \{[\s\S]*?\n  \}/u, 'element'),
    extract(
      /function gazetteDateLabel\(date, includeWeekday = false\) \{[\s\S]*?\n  \}/u,
      'gazetteDateLabel',
    ),
    extract(/function gazetteIssueLink\(issue\) \{[\s\S]*?\n  \}/u, 'gazetteIssueLink'),
    extract(
      /function renderGazetteEntriesPage\(gazette\) \{[\s\S]*?\n  \}/u,
      'renderGazetteEntriesPage',
    ),
    extract(
      /function gazetteBudgetCutMessage\(issue, budgetCut\) \{[\s\S]*?\n  \}/u,
      'gazetteBudgetCutMessage',
    ),
    extract(/function renderGazetteIssue\(gazette\) \{[\s\S]*?\n  \}/u, 'renderGazetteIssue'),
    'return { renderGazetteIssue, gazetteIssueLink, gazetteBudgetCutMessage }',
  ]
  return new Function('document', 'nodes', 'state', parts.join('\n\n')) as (
    document: unknown,
    nodes: Readonly<Record<string, FakeNode>>,
    state: Readonly<Record<string, unknown>>,
  ) => Readonly<{
    renderGazetteIssue: (gazette: Record<string, unknown>) => void
    gazetteIssueLink: (issue: Record<string, unknown>) => FakeNode
    gazetteBudgetCutMessage: (issue: Record<string, unknown>, budgetCut: Record<string, unknown>) => string
  }>
}

function loadedGazetteIssue(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    issueNumber: 11,
    scheduledFor: new Date('2026-11-16T16:00:00.000Z'),
    printedAt: new Date('2026-11-16T16:00:02.000Z'),
    entryCount: 25,
    header: 'THE GAZETTE ISSUE 11',
  })
}

test('gazetteBudgetCutMessage names the size cut in plain words, not a false empty state', () => {
  const build = buildGazetteRenderFunctions()
  const { gazetteBudgetCutMessage } = build(fakeDocument(), {}, { gazetteIssueId: null })

  const message = gazetteBudgetCutMessage(loadedGazetteIssue(), {
    nextItemNoteId: 9000,
    nextItemTextBytes: 700000,
  })

  assert.match(message, /25 submissions/u)
  assert.match(message, /size limit/iu)
  assert.match(message, /note #9000/u)
  assert.doesNotMatch(message, /printed with no submissions/iu)
})

test('gazetteBudgetCutMessage still reads plainly when the server names no specific entry', () => {
  const build = buildGazetteRenderFunctions()
  const { gazetteBudgetCutMessage } = build(fakeDocument(), {}, { gazetteIssueId: null })

  const message = gazetteBudgetCutMessage(loadedGazetteIssue(), {
    nextItemNoteId: null,
    nextItemTextBytes: null,
  })

  assert.match(message, /25 submissions/u)
  assert.match(message, /size limit/iu)
  assert.doesNotMatch(message, /note #/u)
})

test('the Gazette detail pane says the page was cut for size, and matches the count the card shows', () => {
  const document = fakeDocument()
  const nodes = { gazetteIssue: fakeElement('div'), gazetteEntriesPage: fakeElement('div') }
  const state = { gazetteIssueId: 11 }
  const build = buildGazetteRenderFunctions()
  const { renderGazetteIssue, gazetteIssueLink } = build(document, nodes, state)
  const issue = loadedGazetteIssue()

  // What the issue card in the list shows for this same issue.
  const card = gazetteIssueLink(issue)
  const cardMeta = card.children.at(1)?.textContent ?? ''

  // What the detail pane shows when the size ceiling cut the page before
  // admitting a single entry (round 4's exempted shape).
  renderGazetteIssue({
    detailLoading: false,
    detailError: null,
    issue,
    entries: [],
    detailBudgetCut: { nextItemNoteId: 9000, nextItemTextBytes: 700000 },
    hasMoreEntries: false,
    nextAfterOrdinal: null,
  })
  const detailMessage = nodes.gazetteIssue.children.at(-1)?.textContent ?? ''

  assert.match(cardMeta, /25 submissions/u)
  assert.match(detailMessage, /25 submissions/u)
  assert.doesNotMatch(detailMessage, /printed with no submissions/iu)
})

test('a genuinely empty issue still gets the honest empty-issue sentence, unchanged', () => {
  // Regression guard: this fix must not turn every empty detail page into a
  // budget-cut message. Without detailBudgetCut, the pre-existing sentence
  // for an issue that really printed with nothing must still appear.
  const document = fakeDocument()
  const nodes = { gazetteIssue: fakeElement('div'), gazetteEntriesPage: fakeElement('div') }
  const state = { gazetteIssueId: 12 }
  const build = buildGazetteRenderFunctions()
  const { renderGazetteIssue } = build(document, nodes, state)

  renderGazetteIssue({
    detailLoading: false,
    detailError: null,
    issue: { ...loadedGazetteIssue(), issueNumber: 12, entryCount: 0 },
    entries: [],
    detailBudgetCut: null,
    hasMoreEntries: false,
    nextAfterOrdinal: null,
  })
  const detailMessage = nodes.gazetteIssue.children.at(-1)?.textContent ?? ''

  assert.match(detailMessage, /printed with no submissions/iu)
})
