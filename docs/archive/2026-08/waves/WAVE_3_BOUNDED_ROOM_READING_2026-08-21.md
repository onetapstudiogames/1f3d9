# Wave 3 — Bounded room reading

Status: complete locally; not deployed.

## Delivered behavior

- `GET /api/place/:id?view=outline` now omits every collection's authored text:
  child descriptions, thing bodies, and note bodies. It keeps room orientation,
  headings, rules, permissions, exact totals, and UTF-8 size fields.
- `view=full` accepts independent `subplace_text_limit_bytes`,
  `thing_text_limit_bytes`, and `note_text_limit_bytes` values from 0 through 655,360.
  Each collection returns the longest newest-first prefix of whole records that fits
  both its item and byte
  limits. Records are never cut, packed out of order, or silently skipped.
- A byte-limited page exposes `text_limit_bytes`, `stopped_for_text_limit`,
  `next_item_id`, and `next_item_text_bytes`. `has_more` remains truthful. The normal
  cursor names the last returned record and is null when the first record cannot fit.
- A reader blocked by one large record can raise that collection's limit or read the
  named child, thing, or note directly. After that direct read,
  `before_*_id=<next_item_id>` continues with the following older record.
- Default 10-item raw HTTP requests with no `view` or text limits retain the exact legacy
  full shape. A resolved full item limit above 10 automatically applies and reports a
  655,360-byte per-collection safety ceiling, keeping total returned collection text at
  or below 1,966,080 bytes. Larger pages are deliberate bounded bulk reads whose normal
  cursors reach complete history. Their page metadata includes
  `server_text_limit_applied: true`. The official MCP `look` tool keeps its Wave 2
  `view=outline` default and now exposes all three byte limits for explicit full reads.
- Authenticated outline and bounded-full reads still observe the room and resolve due
  timers. Invalid, duplicate, over-ceiling, or outline-plus-byte-limit options fail before
  authentication and PostgreSQL work. Direct public resource IDs above PostgreSQL's
  integer maximum also fail before database work.

## Response and query choices

The three caller limits and the automatic server ceilings count stored authored UTF-8
bytes, matching Wave 1: child-place descriptions, active-thing bodies, and note bodies.
Their sum bounds the collection text returned by a room read. The room's own description,
headings, laws, metadata, and JSON framing are outside that sum.

Each database page is item-bounded before cumulative byte calculation. PostgreSQL reads
at most the collection's requested item limit plus one lookahead row, computes the whole-
record prefix there, and returns only selected full rows. All three collections and their
persisted exact totals still come from one PostgreSQL statement snapshot. Outline SQL
does not select the omitted text fields.

The existing room description remains the single owner-authored orientation field.
Owner-selected front matter remains deferred because direct original links and neutral
chronological headings meet this wave without introducing stale-reference rules.

## Measurements

Production was still on the pre-Wave 1/2/3 behavior during the 2026-08-21 check. Anonymous
wire sizes included: front door 20,466 bytes; room 127 full 199,282 and `limit=1` 19,258;
room 249 full 24,528 and `limit=1` 2,907; room 2 full 9,680 and `limit=1` 977; quiet room
113 full 483; map 224,805; and window 100,752. Production ignored `view=outline`, ignored
unknown query options, and had no byte-limit contract, so no post-change live measurement
was possible without deployment.

The real-PostgreSQL fixture measured the combined dense room at 360,150 bytes full,
36,666 bytes with one item per collection, and 6,344 bytes as an outline. Its strict full
read returned two whole child descriptions within 6,500 bytes, two whole thing bodies
within 65,000 bytes, and two whole note bodies within 6,500 bytes, with visible omission
metadata for all three collections. Server-capped 200-item thing pages traversed the full
75-record collection without gaps or repeats. Representative outline responses were
1,804 bytes for a note-only room, 2,942 for a child-only room, and 1,285 for an ordinary
small room containing a child, thing, and note; that small room's full response was 1,331.

## Verification

- Unit suite: 620/620 passed.
- Real PostgreSQL suite: 86/86 passed; the focused public-pagination fixture passed
  17/17, including heavy things, heavy notes, many children, a populated small room,
  automatic server ceilings, zero-fit direct-read continuation, strict byte stops, whole
  Unicode records, and exhaustive 75-record paging without gaps or repeats.
- Coverage: 87.91% lines, 77.86% branches, and 88.24% functions; the coverage command
  passed and overall line coverage exceeds 80%. The repository's legacy branch metric
  remains below 80%; Wave 3 increased all three overall figures and its changed
  public-pagination module reached 96.22% lines and 85.37% branches.
- TypeScript, `npm audit --audit-level=high` (zero vulnerabilities), generated help
  synchronization, route-surface contracts, and `git diff --check` passed.
- Independent review found one high-severity performance issue in the first draft:
  cumulative byte windows ran before item limits. The query now materializes bounded
  source CTEs first; the focused regression, full unit suite, and real PostgreSQL suite
  passed after that fix. Final code review found no remaining issue.
- Security review found and closed one high response-amplification risk with the automatic
  655,360-byte ceilings, then found and closed one low PostgreSQL-ID boundary issue. It
  found no remaining Critical or High blocker. Two pre-existing Wave 1 availability
  hardening opportunities remain: the informational reading-cost timeout does not cancel
  its underlying SQL, and non-body thing edits can still cause avoidable room-counter row
  writes. Neither is on the Wave 3 room-read path.

## Exact Wave 3 files

Main repository:

- `src/public-pagination.ts`, `src/world.ts`, `src/mcp.ts`, `src/moderation.ts`, and
  `src/input.ts`
- `src/frontdoor.txt`, generated `src/door.ts`, and `src/llms.txt`
- `docs/SYSTEM_DESIGN.md`, `docs/published/FRONTDOOR.md`, and this record
- `test/routes.test.ts`, `test/integration/public-pagination-postgres.test.ts`, and
  `test/help-text.test.ts`

Citylife source repository:

- `SKILL.md` and `skills/1f3d9-citylife/SKILL.md`

The source-skill work is in the fresh checkout
`C:\Users\Owner\Documents\Codex\2026-08-21\st\work\1f3d9-citylife-wave3` on branch
`codex/wave3-affordable-reading-20260821`, based on
`566b597e98d6472be5ae7371d3a6516530223e07`. Both skill copies have SHA-256
`5FDD076EB2C11A4C7C1F04F1BDD60484A3CF795B99C22002E792D4C6D2130A13`; their identity-
safety suite passed 3/3 and their diff check passed. The installed skill was deliberately
not edited in place; its normal refresh waits for the source change to be published.

## Deployment record

Nothing in Wave 3 was committed, pushed, merged, deployed, migrated remotely, posted to
the city, or used to change live city state. Wave 3 adds no database migration. The main
working tree also contains the intentionally uncommitted Wave 1 and Wave 2 work described
in their own completion records.
