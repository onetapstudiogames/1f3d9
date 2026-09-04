// Issue #71: a reader batching room reads (many notes in one response) could be
// ambushed by an aggregate of large or binary-looking bodies with no way to know,
// from the documented contract, that the default page carries no byte ceiling and
// no documented escape hatch. These tests prove the exact shape that was left
// unprotected, prove the documented mitigation actually removes it at the same
// item limit, and prove the mitigation is stated on every public-facing surface.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FRONTDOOR, LLMS } from '../src/door.ts'
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

test('ten default-page binary-looking note bodies reach ~40KB with zero automatic aggregate ceiling', () => {
  const bodies = Array.from({ length: PUBLIC_PAGE_DEFAULT }, binaryLookingNoteBody)
  const aggregateBytes = bodies.reduce((total, body) => total + Buffer.byteLength(body, 'utf8'), 0)

  // Each body is ordinary safe text (digits, spaces) — nothing a write-time
  // validator would reject — yet the ten together are tens of kilobytes.
  assert.ok(aggregateBytes >= 35_000, `expected a large aggregate, got ${aggregateBytes} bytes`)

  // This is the exact shape the issue reports: a caller reading a busy room at
  // the default note_limit (10, i.e. PUBLIC_PAGE_DEFAULT) with no explicit
  // note_text_limit_bytes gets no server-side aggregate cap at all — the safety
  // ceiling only auto-engages once the item limit exceeds the default.
  assert.equal(effectivePublicPlaceTextLimit(null, PUBLIC_PAGE_DEFAULT), null)
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

test('the aggregate-safety caution and its mitigation are stated on every public surface', () => {
  for (const [name, text] of publicSurfaces) {
    const compact = text.replace(/\s+/gu, ' ')
    assert.match(
      compact,
      /full bodies delivered together[^.]{0,160}binary-looking or otherwise encoded text[^.]{0,160}unsafe to a reading host/iu,
      `${name}: aggregate-safety caution`,
    )
    assert.match(
      compact,
      /default 10-item full read[^.]{0,80}no aggregate byte ceiling/iu,
      `${name}: unprotected-default disclosure`,
    )
    assert.match(
      compact,
      /view=outline[^.]{0,80}(?:omits bodies entirely|bodies omitted)[^.]{0,160}note_text_limit_bytes[^.]{0,80}thing_text_limit_bytes[^.]{0,120}(?:at or near 0|near 0)[^.]{0,160}any item limit[^.]{0,80}(?:including the default|default)/iu,
      `${name}: documented mitigation`,
    )
  }
})
