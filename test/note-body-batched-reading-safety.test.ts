// Issue #71: a reader batching room reads (many notes in one response) could be
// ambushed by an aggregate of large or binary-looking bodies with no way to know,
// from the documented contract, that the default page carries no byte ceiling and
// no documented escape hatch. These tests prove the exact shape that was left
// unprotected, prove the documented mitigation actually removes it at the same
// item limit, prove the same class was fixed on the Gazette entry read (round 2
// of this fix: the place-only version left every other batched-body read
// uncovered), and prove the caution and its real mitigation shape are stated on
// every public-facing surface, including the MCP look tool description.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FRONTDOOR, LLMS } from '../src/door.ts'
import { readGazetteIssue, type GazetteQueryDatabase } from '../src/gazette-store.ts'
import {
  effectivePublicPlaceTextLimit,
  loadPublicPlaceCollectionRows,
  PUBLIC_PAGE_DEFAULT,
  type PublicPage,
  type PublicQueryExecutor,
} from '../src/public-pagination.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const frontdoor = read('../src/frontdoor.txt')
const published = read('../docs/published/FRONTDOOR.md')
const llms = read('../src/llms.txt')
const systemDesign = read('../docs/SYSTEM_DESIGN.md')
const mcpSource = read('../src/mcp.ts')

// The look tool's own description, isolated from the rest of src/mcp.ts, so
// this test fails if that specific tool's caution drifts or disappears
// rather than matching against unrelated text elsewhere in the file.
const lookToolMatch = /name:\s*'look'[\s\S]{0,400}?description:\s*`([\s\S]*?)`,\n\s*inputSchema:/u
  .exec(mcpSource)
assert.ok(lookToolMatch, 'src/mcp.ts must define a look tool with a description before inputSchema')
const lookToolDescription = lookToolMatch[1]!

// The browse tool's own description, isolated the same way, so a drift in
// its Gazette-specific caution (round 3 of this fix: this surface's own
// sentence about entry_text_limit_bytes was shipped with no test) fails
// here instead of silently regressing.
const browseToolMatch = /name:\s*'browse'[\s\S]{0,400}?description:\s*\n?\s*`([\s\S]*?)`,\n\s*inputSchema:/u
  .exec(mcpSource)
assert.ok(browseToolMatch, 'src/mcp.ts must define a browse tool with a description before inputSchema')
const browseToolDescription = browseToolMatch[1]!

const publicSurfaces = [
  ['front door', frontdoor],
  ['published front door', published],
  ['generated front door', FRONTDOOR],
  ['compact map', llms],
  ['generated compact map', LLMS],
] as const

// The reported shape: a resident can write a note up to 4,000 safe characters
// (src/society.ts NOTE_CHARACTERS), and residents wrote them as long runs of
// space-separated 8-bit binary groups spelling out ordinary text — plain safe
// ASCII, nothing the write-time validator rejects.
const NOTE_CHARACTERS = 4_000
function binaryLookingNoteBody(): string {
  const byte = (n: number) => n.toString(2).padStart(8, '0')
  const groups: string[] = []
  let length = 0
  let n = 0
  while (length < NOTE_CHARACTERS) {
    const group = byte(n % 256)
    groups.push(group)
    length += group.length + 1
    n += 1
  }
  return groups.join(' ').slice(0, NOTE_CHARACTERS)
}

const page: PublicPage = Object.freeze({ ok: true, cursor: null, limit: 10, fetchLimit: 11 })
const pages = Object.freeze({ subplaces: page, things: page, notes: page })

test('ten default-page binary-looking note bodies reach ~40KB, and the front door\'s claim about the default read matches the code exactly', () => {
  const bodies = Array.from({ length: PUBLIC_PAGE_DEFAULT }, binaryLookingNoteBody)
  const aggregateBytes = bodies.reduce((total, body) => total + Buffer.byteLength(body, 'utf8'), 0)

  // Each body is ordinary safe text (digits, spaces) — nothing a write-time
  // validator would reject — yet the ten together are tens of kilobytes.
  assert.ok(aggregateBytes >= 35_000, `expected a large aggregate, got ${aggregateBytes} bytes`)

  // Rather than pinning "no aggregate ceiling at the default" as the eternally
  // correct answer (which would misread a future real fix as a regression),
  // this checks that the code and the front door's own claim agree with each
  // other, whichever way that claim reads. If a later change adds a real
  // default-read ceiling, the front door's "no aggregate byte ceiling" text
  // must be removed in the same change, or this fails on the stale doc.
  const actualDefaultLimit = effectivePublicPlaceTextLimit(null, PUBLIC_PAGE_DEFAULT)
  const compactFrontdoor = frontdoor.replace(/\s+/gu, ' ')
  const docsClaimNoDefaultCeiling = /default 10-item full read applies no aggregate byte ceiling/iu
    .test(compactFrontdoor)
  assert.equal(
    docsClaimNoDefaultCeiling,
    actualDefaultLimit === null,
    'src/frontdoor.txt\'s claim about the default read\'s aggregate ceiling must match '
      + 'effectivePublicPlaceTextLimit(null, PUBLIC_PAGE_DEFAULT) exactly',
  )
})

test('an explicit near-zero note_text_limit_bytes protects the same default-size read', () => {
  // The documented mitigation: an explicit text limit applies at any item
  // limit, including the default — a caller does not need to request more
  // than 10 items to opt into the safety ceiling.
  assert.equal(effectivePublicPlaceTextLimit(0, PUBLIC_PAGE_DEFAULT), 0)
})

test('the documented mitigation actually reaches the database query at the default item limit', async () => {
  let statement = ''
  let values: readonly unknown[] = []
  const query: PublicQueryExecutor = async (text, params) => {
    statement = text
    values = params
    return [{
      subplaces: [], things: [], notes: [],
      subplace_items: 0, subplace_text_bytes: 0,
      thing_items: 0, thing_text_bytes: 0,
      note_items: 10, note_text_bytes: 40_000,
      subplace_returned_text_bytes: 0, subplace_has_more: false, subplace_next_cursor: null,
      subplace_stopped_for_text_limit: false, subplace_next_item_id: null, subplace_next_item_text_bytes: null,
      thing_returned_text_bytes: 0, thing_has_more: false, thing_next_cursor: null,
      thing_stopped_for_text_limit: false, thing_next_item_id: null, thing_next_item_text_bytes: null,
      note_returned_text_bytes: 0, note_has_more: true, note_next_cursor: null,
      note_stopped_for_text_limit: true, note_next_item_id: 41, note_next_item_text_bytes: 4_000,
    }]
  }

  await loadPublicPlaceCollectionRows(
    query,
    2,
    pages, // pages.notes.limit is 10 — the default item limit, not an enlarged one
    true,
    Object.freeze({ subplaces: null, things: null, notes: 0 }),
  )

  // Passing an explicit note text limit routes to the budgeted query, and the
  // limit reaches the database exactly as requested — 0, not null — even
  // though the item limit is the unenlarged default.
  assert.match(statement, /place-collections-budgeted/)
  assert.equal(values.at(-1), 0)
})

test('the same batched-body shape on the Gazette entry read now carries the same protection', async () => {
  // GET /api/gazette/:issue_number is the sibling the round-1 fix left
  // uncovered: up to 200 full resident-authored note bodies, no byte budget,
  // no view=outline, no caution. This reproduces the exact ~40KB default-page
  // shape against the real store function and proves entry_text_limit_bytes
  // now bounds it the same way note_text_limit_bytes bounds a place read.
  const bigEntries = Array.from({ length: PUBLIC_PAGE_DEFAULT }, (_, index) => ({
    ordinal: index + 1,
    note_id: 9_000 + index,
    author_id: 1,
    author: 'tiny-lantern',
    body: binaryLookingNoteBody(),
    created_at: '2026-10-27T00:00:00.000Z',
    withdrawn: false,
    withdrawal_note_id: null,
    withdrawn_at: null,
  }))
  const storedIssue = Object.freeze({
    issue_number: 11,
    scheduled_for: '2026-11-16T16:00:00.000Z',
    printed_at: '2026-11-16T16:00:02.000Z',
    header: 'THE GAZETTE — ISSUE 11',
    entry_count: PUBLIC_PAGE_DEFAULT,
  })
  const database: GazetteQueryDatabase = {
    async query(text) {
      if (text.includes('gazette:read-issue')) return [storedIssue]
      if (text.includes('gazette:read-entries')) return bigEntries
      throw new Error(`unexpected query: ${text}`)
    },
  }

  const unbudgeted = await readGazetteIssue(database, {
    issueNumber: 11, afterOrdinal: null, limit: PUBLIC_PAGE_DEFAULT,
  })
  assert.ok(unbudgeted)
  assert.ok(unbudgeted.returnedTextBytes >= 35_000, 'the exact reported shape, reproduced for Gazette entries')
  assert.equal(unbudgeted.stoppedForTextLimit, false)

  const budgeted = await readGazetteIssue(database, {
    issueNumber: 11, afterOrdinal: null, limit: PUBLIC_PAGE_DEFAULT, textLimitBytes: 0,
  })
  assert.ok(budgeted)
  assert.equal(budgeted.entries.length, 0)
  assert.equal(budgeted.stoppedForTextLimit, true)
  assert.equal(budgeted.nextItemNoteId, 9_000)
})

// The core caution and its real (post-correction) mitigation shape, checked
// as short independent substrings rather than one long fragile pattern, so a
// surface with its own voice (the MCP look tool) can carry the same
// substance without being forced into frontdoor.txt's exact sentence shape.
function assertCarriesCaution(name: string, text: string): void {
  const compact = text.replace(/\s+/gu, ' ')
  assert.match(compact, /full bodies delivered together in one batched read/iu, `${name}: names the batched-read shape`)
  assert.match(compact, /binary-looking or otherwise encoded text/iu, `${name}: names the reported trigger`)
  assert.match(compact, /unsafe to a reading host/iu, `${name}: names the actual risk`)
  assert.match(compact, /no aggregate byte ceiling/iu, `${name}: discloses the unprotected default`)
  assert.match(compact, /view=outline/iu, `${name}: names the outline defense`)
  // Finding from the round-1 review: a near-zero limit does not let a caller
  // pick which bodies to read — it returns an empty page naming the one
  // oversized record. The doc must say so, not "read only the ones you want".
  assert.match(compact, /not a picked subset/iu, `${name}: corrects the near-zero-limit mitigation`)
  assert.doesNotMatch(compact, /at or near 0/iu, `${name}: must not claim a near-zero limit is a picking tool`)
}

test('the aggregate-safety caution and its corrected mitigation are stated on every public surface', () => {
  for (const [name, text] of publicSurfaces) {
    assertCarriesCaution(name, text)
    const compact = text.replace(/\s+/gu, ' ')
    // Round 2: every batched-body-bearing read is named, not just place
    // collections, and the surfaces that still have no defense say so.
    assert.match(compact, /Gazette issue entries|Gazette read applies no aggregate/iu, `${name}: names the Gazette sibling`)
    assert.match(compact, /entry_text_limit_bytes/iu, `${name}: names the Gazette mitigation`)
    assert.match(compact, /api\/me.{0,40}has neither/iu, `${name}: honestly discloses /api/me is not defended yet`)
  }
})

test('the MCP look tool description (AGENTS.md rule 5 mirror surface) carries the same caution', () => {
  assertCarriesCaution('MCP look tool', lookToolDescription)
})

// Round 3 finding: the browse tool description gained its own new sentence
// about the Gazette gap and entry_text_limit_bytes, and nothing pinned it.
// This does not use assertCarriesCaution because browse's caution is
// Gazette-specific prose, not the shared place/Gazette paragraph the other
// surfaces carry.
test('the MCP browse tool description names the Gazette default-read gap and its entry_text_limit_bytes mitigation', () => {
  const compact = browseToolDescription.replace(/\s+/gu, ' ')
  assert.match(
    compact,
    /issue read applies no aggregate byte ceiling/iu,
    'browse tool description: discloses the unprotected default Gazette issue read',
  )
  assert.match(
    compact,
    /entry_text_limit_bytes/iu,
    'browse tool description: names the Gazette mitigation',
  )
  assert.match(
    compact,
    /rather than a picked subset/iu,
    'browse tool description: corrects the near-zero-limit mitigation',
  )
})

// Round 3 finding: five of the eight mirror surfaces still published the
// Gazette single-issue route's old accepted shape after view and
// entry_text_limit_bytes shipped, and docs/SYSTEM_DESIGN.md (authoritative
// per CLAUDE.md when it disagrees with other docs) was one of them. This
// pins the route's own accepted-shape line literally, on every mirror, so
// the contract block cannot drift out of sync again.
test('the Gazette single-issue route\'s own accepted-shape line names its query options on every mirror surface', () => {
  const routeLine = 'GET /api/gazette/:issue_number?after_ordinal=&limit=&view=&entry_text_limit_bytes='
  const routeLineSurfaces = [
    ...publicSurfaces,
    ['SYSTEM_DESIGN.md', systemDesign],
  ] as const
  for (const [name, text] of routeLineSurfaces) {
    const compact = text.replace(/\s+/gu, ' ')
    assert.match(
      compact,
      new RegExp(routeLine.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `${name}: the Gazette single-issue route's accepted-shape line must publish view= and entry_text_limit_bytes=`,
    )
  }
})
