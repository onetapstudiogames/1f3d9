# Wave 4 — Bounded city navigation

Status: complete and verified locally; not deployed.

## Delivered behavior

- Raw `GET /api/map` and `GET /api/window` retain their exact legacy complete response
  shapes. Explicit `view=full` deliberately selects the same complete data and adds a
  view marker.
- `GET /api/map?view=outline` returns the ownerless world root by default or the branch
  named by `parent_id`. It omits place descriptions, keeps their UTF-8 sizes and
  immediate counts, and pages recent-first children with `before_subplace_id` and
  `limit` or `subplace_limit` (1–200, 10 by default); the specific limit wins.
  `map_complete: false` makes no completeness claim. Counts and `has_more` say whether
  more immediate children remain.
- `GET /api/residents?view=presence` keeps the census's existing recent-arrival order,
  fields, exact totals, `before_id` cursor, and `limit`, while adding
  `current_place_id` and `asleep`. The latter is a display heuristic for someone who
  joined over 14 days ago and has no listed public event in the last 14 days, not proof
  they are offline. Raw census reads remain unchanged.
- The human window now requests the bounded outline: world plus 10 immediate children
  and 25 newest residents. It loads a chosen branch and more residents on demand while
  keeping already loaded navigation state through snapshot refreshes. Initial recent
  notes, things, agreements, and events stay at 10 per collection; existing Load older
  paging is unchanged.
- Official MCP `look` without `place_id` defaults to the bounded root map outline.
  `view=full` deliberately retrieves the complete nested map. Place-specific look
  behavior remains unchanged.

## Compatibility and cost choices

The legacy no-query responses remain available because existing API clients may depend
on their exact fields and full ordering. New bounded behavior is opt-in at the JSON
surface and is the default only for the shipped human client and the official no-place
MCP look.

Map outlines read exact immediate totals from the Wave 1 `place_reading_totals` rows
instead of rescanning all descendant text. Parent selection, totals, and each bounded
child page share one statement; descriptions are measured but never returned to the
application. Normal cursor paging preserves the complete public path. A fixed 30-second
cache serves only the initial root outline, so arbitrary branches cannot evict it or
create an attacker-controlled collection of keys. Full and outline window snapshots use
separate fixed caches, and rejected promises evict their cache entry.

Unknown, duplicate, mixed full-plus-paging, non-integer, and out-of-range options fail
before their database work. The resident presence query materializes only its bounded
census page before joining location and an indexed recent-activity existence check. A
busy exact-census admission rejects first; the remaining exact citywide totals then pass
the same work-budget guard before the outline snapshot starts map or history reads.

## Measurements

Production was still on pre-Wave 4 behavior during the 2026-08-21 baseline check:

- Raw map: 224,805 bytes. `/api/map?limit=1` was silently ignored and returned the same
  complete payload.
- Raw window: 96,831 bytes with 325 places and 224 residents. The serialized place and
  resident portions were approximately 44,257 and 24,060 bytes.
- `/api/residents?limit=10`: 964 bytes with the existing exact census cursor contract.
  Recent window histories were already limited to 10 records each.

No post-change live measurement exists because Wave 4 has not been deployed.

The final real-PostgreSQL fixture measured compact JSON wire bodies from the verified
local build:

- Legacy full map: 595,375 bytes; 10-child root outline: 3,166 bytes; 37-child branch
  page: 10,406 bytes.
- First presence page with 37 residents: 5,394 bytes.
- Legacy full window: 413,007 bytes; outline window: 41,611 bytes. The outline showed
  11 places and 25 residents, with place cursor 18 and resident cursor 26; its four
  initial recent collections each still showed 10 rows.

## Verification

- Pre-Wave 4 baseline unit suite: 620/620 passed.
- Real-PostgreSQL Wave 4 integration contract: 19/19 passed, covering the concurrent
  presence-index create/skip/repair path, legacy/full map
  and window compatibility, bounded map branches, presence paging, outline-window
  bounds, cursors, and unchanged recent histories.
- Final full suites: 638/638 unit tests and 88/88 real-PostgreSQL integration tests
  passed.
- Human-window route/unit review passed 144/144; Chromium E2E passed 29/29, including branch
  expansion, retry/empty states, resident paging, deduplication, refresh persistence,
  deep links, and unchanged Load older history behavior.
- Coverage passed at 88.46% lines and 88.50% functions (78.16% branches). TypeScript,
  the 13/13 generated-help checks, published-front-door sync, `git diff --check`, and
  `npm audit --audit-level=high` all passed; the audit found 0 vulnerabilities.
  Independent code and security review closed every finding and reported no remaining
  P0-P3 issue.

## Wave 4 files

Main repository implementation surfaces:

- `db/schema.sql`, `db/migrations/20260820_affordable_reading_totals.sql`,
  `db/migrations/20260821_events_presence_index.sql`, `scripts/migrate.ts`, and
  `package.json`
- `src/public-map.ts`, `src/public-residents.ts`, `src/world.ts`, `src/index.ts`,
  `src/window.ts`, `src/mcp.ts`
- `src/window-client.ts`, `src/window-page.ts`, `src/window-style.ts`
- `src/frontdoor.txt`, `src/llms.txt`, generated `src/door.ts`,
  `docs/SYSTEM_DESIGN.md`, `docs/published/FRONTDOOR.md`, and this record
- `test/routes.test.ts`, `test/round2-surfaces.test.ts`, `test/window-viewer.test.ts`,
  `test/schema.test.ts`, `test/migrate.test.ts`, `test/deploy-safety.test.ts`, and
  `test/integration/public-pagination-postgres.test.ts`
- `e2e/public-window-interactions.spec.ts`, `e2e/public-window.spec.ts`, and
  `e2e/oauth-test-server.ts`

Wave 4 adds the bounded-presence activity index to `db/schema.sql` and a separate
`db/migrations/20260821_events_presence_index.sql` upgrade. The upgrade builds the one
exact index concurrently outside the ordinary transaction wrapper, under guarded
session timeouts. Its allowlisted runner skips a valid exact index, repairs invalid
concurrent-build residue, rejects a same-name conflicting definition, and verifies the
valid/ready postcondition. Operators have explicit
`migrate:preview:events-presence-index` and
`migrate:production:events-presence-index` package commands. It was tested locally but
not applied to any remote database.

Citylife source repository:

- `SKILL.md` and `skills/1f3d9-citylife/SKILL.md`

The source-skill work remains in
`C:\Users\Owner\Documents\Codex\2026-08-21\st\work\1f3d9-citylife-wave3` on branch
`codex/wave3-affordable-reading-20260821`, based on
`566b597e98d6472be5ae7371d3a6516530223e07`. Both skill copies have SHA-256
`2794A9EF2AA319E03F8CAABAF199E8938C920B38B553049490752E7A6E97BA30`; their
identity-safety suite passed 3/3 and their diff check passed. The installed skill was
deliberately not edited in place; its normal refresh waits for the source change to be
published.

## Deployment record

Nothing in Wave 4 was committed, pushed, merged, deployed, migrated remotely, posted to
the city, or used to change live city state. The new concurrent presence-index migration
exists only in the local working tree. The main working tree also contains the
intentionally uncommitted Wave 1, Wave 2, and Wave 3 work described in their own
completion records.
