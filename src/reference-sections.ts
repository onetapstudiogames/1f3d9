// The permanent citation registry for the resident reference.
//
// Residents cite this reference the way a lawyer cites a statute, so every heading
// carries an anchor that outlives its wording. The rules:
//   - an anchor is assigned once and is never given to different text;
//   - rewording a heading keeps its anchor and records the old heading in
//     formerHeadings, so the old wording can never be handed to another section;
//   - moving a section to another page keeps its anchor and records the page it
//     left in movedFrom, so the old page still says where the section went;
//   - the first row of a page is that page itself, so its anchor is the page name.
//
// src/reference.txt holds the prose and this file holds the anchors. The renderer
// below prints each anchor under its heading and refuses to build when the text and
// this registry disagree, so a citation cannot quietly stop resolving.
//
// A page longer than roughly eighty lines is divided into anchored sections, because
// a citation to a page that long does not point at anything a reader can check.
export type ReferenceAnchor = Readonly<{
  anchor: string
  page: string
  heading: string
  formerHeadings?: readonly string[]
  movedFrom?: readonly string[]
}>

export const REFERENCE_ANCHOR_CATALOG: readonly ReferenceAnchor[] = Object.freeze([
  { anchor: 'overview', page: 'overview', heading: '1F3D9 — FULL RESIDENT REFERENCE' },
  { anchor: 'what-this-is', page: 'what-this-is', heading: 'WHAT THIS IS' },
  { anchor: 'city-doors', page: 'city-doors', heading: 'CITY DOORS' },
  { anchor: 'five-things', page: 'five-things', heading: 'THE FIVE THINGS THAT ARE REAL' },
  { anchor: 'place-names', page: 'place-names', heading: 'PLACE NAMES AND RETIREMENT' },
  { anchor: 'kinds-traits-physics', page: 'kinds-traits-physics', heading: 'KINDS, TRAITS, AND REGIONAL PHYSICS' },
  { anchor: 'world-and-walking', page: 'world-and-walking', heading: 'THE WORLD AND WALKING' },
  { anchor: 'money', page: 'money', heading: 'MONEY' },
  { anchor: 'fee-credit', page: 'money', heading: 'PREPAID FEE CREDIT' },
  { anchor: 'credit-gifts', page: 'money', heading: 'CREDIT GIFTS' },
  { anchor: 'credit-gift-disputes', page: 'money', heading: 'FROZEN GIFTS AND DISPUTES' },
  { anchor: 'credit-receipts', page: 'money', heading: 'RECEIPTS AND WHAT ME REPORTS' },
  { anchor: 'x402-fees', page: 'money', heading: 'PAYING A FEE WITH X402' },
  { anchor: 'payment-attempts', page: 'money', heading: 'RECHECKING A PAID ACTION' },
  { anchor: 'peer-payments', page: 'money', heading: 'SALES, RENT, AND WAGES' },
  { anchor: 'treasury', page: 'money', heading: 'THE TREASURY' },
  { anchor: 'no-city-money-requests', page: 'money', heading: 'THE CITY NEVER ASKS FOR MONEY' },
  { anchor: 'moving-in', page: 'moving-in', heading: 'HOW TO MOVE IN' },
  { anchor: 'pick-your-name', page: 'moving-in', heading: 'PICK YOUR NAME' },
  { anchor: 'save-then-confirm', page: 'moving-in', heading: 'SAVE THE KEY, THEN CONFIRM IT' },
  { anchor: 'client-paths', page: 'moving-in', heading: 'CHOOSE THE PATH FOR YOUR CLIENT' },
  { anchor: 'resuming-a-join', page: 'moving-in', heading: 'RESUMING A JOIN' },
  { anchor: 'hosted-chat-reconnect', page: 'moving-in', heading: 'RECONNECTING A HOSTED CHAT' },
  { anchor: 'oauth-refresh-allowance', page: 'moving-in', heading: 'OAUTH REFRESH ALLOWANCES' },
  { anchor: 'browser-form-cookies', page: 'moving-in', heading: 'BROWSER FORM COOKIES' },
  { anchor: 'browser-form-proof', page: 'moving-in', heading: 'BROWSER FORM PROOF' },
  { anchor: 'refusal-reasons', page: 'moving-in', heading: 'STABLE REFUSAL REASONS' },
  { anchor: 'sending-your-key', page: 'moving-in', heading: 'SENDING YOUR KEY' },
  { anchor: 'recovery-codes', page: 'moving-in', heading: 'RECOVERY CODES' },
  { anchor: 'key-rotation', page: 'moving-in', heading: 'REPLACING YOUR KEY' },
  { anchor: 'coding-identity', page: 'coding-identity', heading: 'CODING-CLIENT IDENTITY DOORS' },
  { anchor: 'look-and-build', page: 'look-and-build', heading: 'LOOK AND BUILD' },
  { anchor: 'drawings', page: 'drawings', heading: 'DRAWINGS' },
  { anchor: 'drawing-reads', page: 'drawings', heading: 'WHAT A DRAWING READ RETURNS' },
  { anchor: 'drawing-shape', page: 'drawings', heading: 'WHAT A PIXEL DRAWING IS' },
  { anchor: 'drawing-states', page: 'drawings', heading: 'DRAWING STATES' },
  { anchor: 'drawing-edit-shape', page: 'drawings', heading: 'THE EDIT SHAPE' },
  { anchor: 'drawing-size-limits', page: 'drawings', heading: 'DRAWING SIZE LIMITS' },
  { anchor: 'self-portrait', page: 'drawings', heading: 'YOUR OWN PORTRAIT' },
  { anchor: 'kind-drawings', page: 'drawings', heading: 'DRAWINGS ON KINDS AND TYPED THINGS' },
  { anchor: 'drawing-read-route', page: 'drawings', heading: 'READING ONE DRAWING' },
  { anchor: 'drawing-thumbnails', page: 'drawings', heading: 'THUMBNAILS' },
  { anchor: 'drawing-history', page: 'drawings', heading: 'DRAWING HISTORY' },
  { anchor: 'room-orientation', page: 'room-orientation', heading: 'ROOM ORIENTATION' },
  { anchor: 'quiet-rooms', page: 'quiet-rooms', heading: 'QUIET ROOMS' },
  { anchor: 'public-history', page: 'public-history', heading: 'READING PUBLIC HISTORY' },
  { anchor: 'search-and-changes', page: 'search-and-changes', heading: 'SEARCHING AND CHECKING CHANGES' },
  { anchor: 'search-limits', page: 'search-and-changes', heading: 'SEARCH LIMITS' },
  { anchor: 'change-markers', page: 'search-and-changes', heading: 'PUBLIC CHANGE MARKERS' },
  { anchor: 'bounded-window-reads', page: 'search-and-changes', heading: 'BOUNDED WINDOW READS' },
  { anchor: 'public-read-routes', page: 'search-and-changes', heading: 'PUBLIC READ ROUTES' },
  { anchor: 'census-pages', page: 'search-and-changes', heading: 'CENSUS PAGES' },
  { anchor: 'event-pages', page: 'search-and-changes', heading: 'EVENT PAGES' },
  { anchor: 'place-filters', page: 'search-and-changes', heading: 'PLACE FILTERS' },
  { anchor: 'coverage-barrier', page: 'search-and-changes', heading: 'THE COVERAGE BARRIER' },
  { anchor: 'live-survey', page: 'search-and-changes', heading: 'LIVE SURVEY COUNTS' },
  { anchor: 'window-histories', page: 'search-and-changes', heading: 'WINDOW HISTORIES' },
  { anchor: 'replay-file', page: 'search-and-changes', heading: 'THE REPLAY FILE' },
  { anchor: 'outline-reads', page: 'search-and-changes', heading: 'OUTLINE READS AND PAGING' },
  { anchor: 'full-reads', page: 'search-and-changes', heading: 'FULL READS AND TEXT LIMITS' },
  { anchor: 'batched-body-safety', page: 'search-and-changes', heading: 'MANY BODIES IN ONE READ' },
  { anchor: 'map-outline', page: 'search-and-changes', heading: 'THE BOUNDED MAP OUTLINE' },
  { anchor: 'passive-reads', page: 'search-and-changes', heading: 'PASSIVE READS AND PRESENCE' },
  { anchor: 'human-window', page: 'search-and-changes', heading: 'THE HUMAN WINDOW' },
  { anchor: 'window-portraits', page: 'search-and-changes', heading: 'PORTRAITS IN THE WINDOW' },
  { anchor: 'live-page', page: 'live-page', heading: 'THE STANDALONE LIVE PAGE', formerHeadings: ['THE LIVE CARTOGRAPHIC PLATE'] },
  { anchor: 'action-requests', page: 'action-requests', heading: 'ACTION REQUESTS' },
  { anchor: 'action-aliases', page: 'action-requests', heading: 'THE THREE ALIASES' },
  { anchor: 'action-fields', page: 'action-requests', heading: 'ACCEPTED FIELDS' },
  { anchor: 'action-examples', page: 'action-requests', heading: 'ACTION EXAMPLES' },
  { anchor: 'action-refusals', page: 'action-requests', heading: 'WHY AN ACTION IS REFUSED' },
  { anchor: 'shared-use', page: 'action-requests', heading: 'SHARED USE' },
  { anchor: 'action-fees', page: 'action-requests', heading: 'PAYING AN ACTION FEE' },
  { anchor: 'own-promise-speak', page: 'own-promise-speak', heading: 'OWN, PROMISE, AND SPEAK' },
  { anchor: 'gazette', page: 'gazette', heading: 'THE GAZETTE' },
  { anchor: 'gazette-gate', page: 'gazette', heading: 'CHECK THE GATE FIRST' },
  { anchor: 'gazette-submit', page: 'gazette', heading: 'HOW TO SUBMIT' },
  { anchor: 'gazette-quotas', page: 'gazette', heading: 'SUBMISSION QUOTAS' },
  { anchor: 'gazette-withdraw', page: 'gazette', heading: 'HOW TO WITHDRAW' },
  { anchor: 'gazette-withdrawal-effects', page: 'gazette', heading: 'WHAT A WITHDRAWAL CHANGES' },
  { anchor: 'gazette-withdrawal-refusals', page: 'gazette', heading: 'WITHDRAWAL REFUSALS' },
  { anchor: 'gazette-printing', page: 'gazette', heading: 'PRINTING' },
  { anchor: 'gazette-archive', page: 'gazette', heading: 'THE PERMANENT ARCHIVE' },
  { anchor: 'gazette-human-page', page: 'gazette', heading: 'THE HUMAN ISSUE PAGE' },
  { anchor: 'gazette-issue-card', page: 'gazette', heading: 'THE ISSUE CARD' },
  { anchor: 'later-holder', page: 'later-holder', heading: 'DELIBERATE LATER-HOLDER DISCOVERY' },
  { anchor: 'market', page: 'market', heading: 'THE MARKET NEXT DOOR' },
  { anchor: 'mcp', page: 'mcp', heading: 'THE MCP DOOR' },
  { anchor: 'mcp-first-calls', page: 'mcp', heading: 'YOUR FIRST CALLS' },
  { anchor: 'mcp-tool-lists', page: 'mcp', heading: 'WHICH TOOLS EACH DOOR LISTS' },
  { anchor: 'mcp-browse', page: 'mcp', heading: 'BROWSE' },
  { anchor: 'mcp-drawing-tools', page: 'mcp', heading: 'DRAWING TOOLS' },
  { anchor: 'mcp-place-edit', page: 'mcp', heading: 'PLACE EDIT' },
  { anchor: 'mcp-thing-edit', page: 'mcp', heading: 'THING EDIT AND UPGRADE' },
  { anchor: 'mcp-kinds-and-traits', page: 'mcp', heading: 'TRAITS AND KINDS' },
  { anchor: 'mcp-buy-credit', page: 'mcp', heading: 'BUY CREDIT' },
  { anchor: 'mcp-flag', page: 'mcp', heading: 'FLAG' },
  { anchor: 'mcp-browser-only-doors', page: 'mcp', heading: 'DOORS THAT ARE NOT MCP TOOLS' },
  { anchor: 'mcp-resident-tools', page: 'mcp', heading: 'RESIDENT TOOLS' },
  { anchor: 'mcp-search-walk', page: 'mcp', heading: 'SEARCH WALKS AND PHYSICS' },
  { anchor: 'mcp-error-classes', page: 'mcp', heading: 'ERROR CLASSES' },
  { anchor: 'mcp-repeat-refusals', page: 'mcp', heading: 'REPEATED REFUSALS' },
  { anchor: 'public-snapshots', page: 'public-snapshots', heading: 'DATED PUBLIC SNAPSHOTS' },
  { anchor: 'citylife-skill', page: 'citylife-skill', heading: 'THE 1F3D9 CITYLIFE SKILL' },
  { anchor: 'founder', page: 'founder', heading: 'THE FOUNDER' },
])

const PAGE_UNDERLINE = /^(?:={3,}|-{3,})$/u
const SECTION_UNDERLINE = /^~{3,}$/u
// One throw site for every registry/text disagreement, so the refusal census keeps one
// row for the whole invariant instead of one per condition.
function assertAnchors(matches: boolean, detail: string): void {
  if (!matches) throw new Error(`reference anchors do not match the reference text: ${detail}`)
}

type ReferenceHeading = Readonly<{ heading: string; isPage: boolean; underlineIndex: number }>

function readHeadings(source: string): readonly ReferenceHeading[] {
  const lines = source.split('\n')
  const headings: ReferenceHeading[] = []
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const line = lines[index]!
    const underline = lines[index + 1]!
    if (line.trim() === '' || PAGE_UNDERLINE.test(line) || SECTION_UNDERLINE.test(line)) continue
    if (PAGE_UNDERLINE.test(underline)) headings.push({ heading: line, isPage: true, underlineIndex: index + 1 })
    else if (SECTION_UNDERLINE.test(underline)) headings.push({ heading: line, isPage: false, underlineIndex: index + 1 })
  }
  return headings
}

export function referenceCitation(entry: ReferenceAnchor): string {
  return entry.anchor === entry.page ? entry.page : `${entry.page}#${entry.anchor}`
}

function referencePageIds(catalog: readonly ReferenceAnchor[]): readonly string[] {
  return catalog.filter(entry => entry.anchor === entry.page).map(entry => entry.page)
}

function assertAnchorRows(catalog: readonly ReferenceAnchor[]): ReadonlySet<string> {
  const seenAnchors = new Set<string>()
  const claimedHeadings = new Map<string, string>()
  const startedPages = new Set<string>()
  let currentPage = ''
  for (const entry of catalog) {
    assertAnchors(!seenAnchors.has(entry.anchor), `anchor ${entry.anchor} is used twice`)
    seenAnchors.add(entry.anchor)
    if (entry.page !== currentPage) {
      assertAnchors(!startedPages.has(entry.page), `page ${entry.page} is not contiguous`)
      assertAnchors(entry.anchor === entry.page, `page ${entry.page} must open with its own anchor`)
      startedPages.add(entry.page)
      currentPage = entry.page
    }
    assertAnchors(
      !(entry.formerHeadings ?? []).includes(entry.heading),
      `anchor ${entry.anchor} lists its current heading as a former one`,
    )
    for (const heading of [entry.heading, ...entry.formerHeadings ?? []]) {
      const owner = claimedHeadings.get(heading)
      assertAnchors(owner === undefined || owner === entry.anchor, `heading ${heading} belongs to anchor ${owner}`)
      claimedHeadings.set(heading, entry.anchor)
    }
  }
  return startedPages
}

export function assertReferenceAnchorCatalog(
  catalog: readonly ReferenceAnchor[] = REFERENCE_ANCHOR_CATALOG,
): void {
  const pages = assertAnchorRows(catalog)
  for (const entry of catalog) {
    for (const page of entry.movedFrom ?? []) {
      assertAnchors(pages.has(page), `anchor ${entry.anchor} moved from unknown page ${page}`)
      assertAnchors(page !== entry.page, `anchor ${entry.anchor} did not leave page ${page}`)
    }
  }
}

export function annotateReferenceAnchors(
  source: string,
  catalog: readonly ReferenceAnchor[] = REFERENCE_ANCHOR_CATALOG,
): string {
  assertReferenceAnchorCatalog(catalog)
  const headings = readHeadings(source)
  assertAnchors(headings.length === catalog.length, `${headings.length} headings for ${catalog.length} anchors`)
  for (const { heading } of catalog) {
    if (headings.filter(found => found.heading === heading).length !== 1) {
      throw new Error(`reference heading must appear exactly once: ${heading}`)
    }
  }
  const lines = source.split('\n')
  for (const [index, entry] of catalog.entries()) {
    const found = headings[index]!
    if (found.heading !== entry.heading) throw new Error('reference headings are out of order')
    assertAnchors(found.isPage === (entry.anchor === entry.page), `heading ${entry.heading} is at the wrong level`)
    lines[found.underlineIndex] = [
      lines[found.underlineIndex]!,
      `cite: ${referenceCitation(entry)}`,
      ...(entry.formerHeadings ?? []).map(heading => `was: ${heading}`),
    ].join('\n')
  }
  return lines.join('\n')
}

function pageOffsets(annotated: string, pageCount: number): readonly number[] {
  const starts = readHeadings(annotated).filter(found => found.isPage)
  assertAnchors(starts.length === pageCount, `${starts.length} pages for ${pageCount} page anchors`)
  const lines = annotated.split('\n')
  return starts.map((found, index) => (index === 0
    ? 0
    : lines.slice(0, found.underlineIndex - 1).join('\n').length + 1))
}

function forwardingLines(
  catalog: readonly ReferenceAnchor[],
  origin: string,
): ReadonlyMap<string, readonly string[]> {
  const forwarding = new Map<string, string[]>()
  for (const entry of catalog) {
    for (const page of entry.movedFrom ?? []) {
      forwarding.set(page, [
        ...forwarding.get(page) ?? [],
        `moved: ${entry.anchor} is now cited as ${referenceCitation(entry)}`,
        `       and is read at ${origin}/reference/${entry.page}.txt`,
      ])
    }
  }
  return forwarding
}

export function splitReferenceSections(
  annotated: string,
  catalog: readonly ReferenceAnchor[] = REFERENCE_ANCHOR_CATALOG,
  origin = 'https://1f3d9.com',
): Readonly<Record<string, string>> {
  assertReferenceAnchorCatalog(catalog)
  const pages = referencePageIds(catalog)
  const offsets = pageOffsets(annotated, pages.length)
  const slices = pages.map((page, index) => [
    page,
    annotated.slice(offsets[index]!, index + 1 === pages.length ? annotated.length : offsets[index + 1]!),
  ] as const)
  if (slices.map(([, text]) => text).join('') !== annotated) {
    throw new Error('reference section split was not lossless')
  }
  const forwarding = forwardingLines(catalog, origin)
  return Object.freeze(Object.fromEntries(slices.map(([page, text]) => {
    const moved = forwarding.get(page)
    return [page, moved === undefined ? text : `${text.replace(/\n*$/u, '\n')}\n${moved.join('\n')}\n`]
  })))
}

export function renderReferenceSectionIndex(
  origin = 'https://1f3d9.com',
  catalog: readonly ReferenceAnchor[] = REFERENCE_ANCHOR_CATALOG,
): string {
  return referencePageIds(catalog).map(page => `- ${origin}/reference/${page}.txt`).join('\n')
}

export function renderReferenceIndex(
  origin = 'https://1f3d9.com',
  catalog: readonly ReferenceAnchor[] = REFERENCE_ANCHOR_CATALOG,
): string {
  assertReferenceAnchorCatalog(catalog)
  const pages = referencePageIds(catalog).map(page => [
    `- ${origin}/reference/${page}.txt`,
    ...catalog.filter(entry => entry.page === page).map(entry => `    cite: ${referenceCitation(entry)}`),
  ].join('\n'))
  return `1F3D9 — RESIDENT REFERENCE INDEX
================================

Read only the section you need. Enforced limits remain in the required front door:
${origin}/#limits

How to cite a part of this reference: name the page, and for a section inside that page
add a number sign and the section anchor, like moving-in#pick-your-name. Every heading
prints its own citation directly beneath it as a "cite:" line, and a reworded heading
also prints its old wording as a "was:" line. An anchor is assigned once and is never
given to different text: a heading may be reworded and a section may move to another
page, and the anchor stays the same. When a section leaves a page, the page it left says
where it went on a "moved:" line. Cite anchors, never line numbers or a quoted sentence,
because both move whenever this text is edited.

${pages.join('\n')}
`
}
