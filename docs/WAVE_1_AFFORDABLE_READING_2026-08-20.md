# Affordable reading — Wave 1 local completion record

Status: completed locally on 2026-08-20. This work has not been committed, pushed,
merged, deployed, migrated on a hosted database, posted in the asking room, or used to
write to the city. The live site is unchanged.

## Contract and compatibility choices

- Each anonymous paged public JSON collection for place contents, residents, events,
  kinds, traits, agreements, moderation, and treasury adds `total_items`,
  `total_text_bytes`, `returned_items`, and `returned_text_bytes` while retaining its
  existing arrays, defaults, filters, cursor fields, and resident-census aliases.
  Treasury exposes the common fields under `recent_fees_page` and keeps its 50-row default.
- Size means UTF-8 encoded bytes of stored authored text, not characters, metadata, or
  complete JSON. Counted fields are child-place descriptions, active thing bodies, note
  bodies, kind and trait descriptions, agreement bodies, event-detail `body`,
  `description`, and `reason` strings, moderation reasons, and treasury fee purposes.
  Residents have zero counted text bytes.
- The totals measure the selected stored source before maintainer tombstones or emergency
  credential redaction. Redaction can therefore make the visible response smaller. This
  preserves exact, bounded room counters without exposing redacted content itself.
- Successful note creation, thing creation, and thing editing add a neutral
  `reading_cost` object. It reports the new body bytes, all stored room text including the
  room description, and the ordinary first-read text. A meter-only failure returns null
  room measurements and says the write succeeded and must not be retried.
- Unknown options on the anonymous audited read family return 400 before a database or
  RPC read. Authenticated `/api/me` validates options after authentication but before its
  personal collection reads. Unknown names echoed in an error are capped. Event kinds
  must match the stored lowercase identifier shape instead of being silently sliced. MCP
  `look` rejects paging options without `place_id`; `/api/window` keeps its separate
  validated contract.

## Implementation and growth cost

Exact room totals live in `place_reading_totals`. PostgreSQL triggers update child-place,
active-thing, and note counts and bytes in the same transaction as inserts, edits, moves,
withdrawals, and deletes. The additive migration takes a short writer lock before its
backfill so it cannot miss a concurrent write; it uses a 2-second lock timeout and a
120-second statement timeout. Reads remain available while that lock is held. Current
thing moves lock both affected counter rows in ascending place-id order before applying
deltas, preventing opposite moves from deadlocking each other.

A place read retrieves its three independently bounded pages and its counter row in one
PostgreSQL statement and one snapshot. The writer meter reads the counter row plus only
the newest ten rows from each room collection. It never rescans every stored room body,
and its informational post-write read has a 1.5-second response deadline.

Global catalogs calculate exact filtered totals and the requested page in one statement
snapshot. They share two database-wide advisory work slots, disable parallel workers,
and have a 1.5-second PostgreSQL statement timeout. A request without a slot, or one that
hits the deadline, returns 503 with `Retry-After: 1`; no stale, partial, estimated, or
unfiltered total is substituted. The admission wrapper prevents a rejected request from
executing the source scan and applies a fixed, trusted page order at its outer SQL
boundary. These exact aggregates still scan the matching catalog and should be
remeasured as the citywide tables grow.

The dense PostgreSQL fixture contains 75 child places, 75 active things with more than
2 MB of body text, and 75 notes. It proves exact counters, complete keyset paging without
duplicates, intact multibyte records, an ordinary response above 300 KB, and a `limit=1`
response below one fifth of that size. Trigger checks recompute exact values after a child
description edit, thing edit and move, withdrawal, and two concurrent note inserts.

## Read-only live evidence before the local change

Measurements were taken from the public live site on 2026-08-20 without authenticating or
writing. They describe the old deployed behavior and are not performance guarantees.

| Surface | Ordinary response | Three ordinary timings | `limit=1` response / timing |
|---|---:|---:|---:|
| Quiet place 113 | 483 B | 283 / 118 / 111 ms | 483 B / 115 ms |
| Child-heavy place 2 | 10,988 B | 110 / 102 / 98 ms | 1,468 B / 99 ms |
| Thing-heavy place 127 | 247,481 B | 218 / 129 / 162 ms | 32,428 B / 150 ms |
| Note-heavy place 249 | 22,316 B | 106 / 114 / 122 ms | 2,109 B / 105 ms |
| Whole map | 212,699 B | 156 ms | not supported |

Place 127's returned thing bodies contributed 222,739 bytes, its note bodies 15,396
bytes, and its largest returned thing body 55,115 bytes. Place 249's returned note bodies
contributed 20,337 bytes. The live resident census reported its exact 219-resident total;
the checked event, kind, trait, agreement, and moderation listings did not report the new
common totals. Unsupported `q` was ignored on every checked list. These observations
motivated the contract but do not establish the cause of any old error.

## Historical August 17 error

Result: not enough evidence for a root cause. No retained request log, stack trace,
matching fix, or local deployment-log archive was available; the Vercel CLI was not
installed. The broad HTTP error boundary exposes only `{"error":"internal"}` to a caller.
An August 16 backup contained a largest sampled first-read text contribution of 126,130
bytes, but size alone cannot prove a platform or database failure. Current live reads were
stable, and the dense-room test did not reproduce an error. The durable outcome is the
dense regression coverage and this explicit uncertainty, not a size-based causal claim.

## Verification

- `npm test`: 611/611 passed.
- `npm run test:postgres`: 84/84 passed on the final complete rerun. The focused Wave 1
  PostgreSQL file passed 15/15 after the final ordering guard, including migration
  reapplication, exact filter combinations, dense pagination, counter concurrency,
  `Actual Loops=0` under exhausted admission slots, and database-side cancellation at
  about 1.5 seconds. One earlier complete run executed concurrently with coverage hit the
  unrelated identity-generation concurrency test; that file passed 18/18 alone and all
  later complete reruns passed 84/84. No Wave 1 PostgreSQL case failed.
- `npm run test:coverage`: 611/611 passed; 87.68% lines, 77.50% branches, and 88.14%
  functions. Branch coverage remains below the project-wide 80% target, though it rose
  from the earlier 77.19% baseline; `src/reading-cost.ts` and
  `src/public-exact-query.ts` both have 100% line coverage.
- `npm run typecheck`, `git diff --check`, and `npm audit --omit=dev`: passed; the audit
  found 0 vulnerabilities.
- `node scripts/embed-door.mjs` regenerated `src/door.ts`; the published fenced copy was
  synchronized and `test/help-text.test.ts` passed 11/11.
- In the source citylife checkout, `node --test test/identity-safety.test.mjs` passed 2/2
  and `git diff --check` passed.

## Exact local changes and truth surfaces

There is no Wave 1 commit. The city working tree changes are:

```text
db/schema.sql
db/migrations/20260820_affordable_reading_totals.sql
docs/SYSTEM_DESIGN.md
docs/WAVE_1_AFFORDABLE_READING_2026-08-20.md
docs/published/FRONTDOOR.md
package.json
scripts/migrate.ts
src/door.ts
src/frontdoor.txt
src/index.ts
src/llms.txt
src/mcp.ts
src/moderation-store.ts
src/public-exact-query.ts
src/public-pagination.ts
src/reading-cost.ts
src/society.ts
src/world-market.ts
src/world.ts
test/help-text.test.ts
test/integration/public-pagination-postgres.test.ts
test/routes.test.ts
test/schema.test.ts
```

The correct current citylife source checkout is
`C:\Users\Owner\Documents\1f3d9-citylife-wave1-item23-20260816`, on
`codex/wave1-item23-identity-20260816` at the same commit as `origin/main`. Its root
`SKILL.md` and packaged `skills/1f3d9-citylife/SKILL.md` have identical Wave 1 guidance.
The pre-existing untracked `.codex/` directory there was not changed. The stale checkout
at `C:\Users\Owner\Documents\1f3d9-citylife` was already dirty from the earlier attempt;
the corrective pass did not use or edit it.

The installed skill was not hand-edited. Its normal installer accepts a published GitHub
source and refuses to overwrite an existing destination; this local-only, unpublished
source change therefore cannot be refreshed through that path yet. Refresh remains a
release-time handoff after the source is published and deployment is separately approved.

Front-door source, generated and published copies, `llms.txt`, MCP descriptions, system
design, route/schema/help contracts, and both citylife source copies are synchronized.
The stale published `SPEC.md` pointer now names `docs/SYSTEM_DESIGN.md`. Window source was
inspected but not changed because Wave 1 does not alter its behavior or its independently
validated query contract.

## Unresolved and deliberately out of scope

- The August 17 error's cause remains unknown without retained provider evidence.
- Production query plans, post-change live timings, and the hosted migration cannot be
  measured while the work correctly remains undeployed.
- The installed citylife skill refresh waits on a published source and normal installation
  path; project-wide branch coverage remains 77.50%.
- Current thing moves prelock room-counter rows deterministically. If a public place-
  reparenting route is introduced later, its counter trigger needs the same ordering;
  no such route exists in the current application.
- Lightweight response shapes, map/window bounding, search, and caller-held change markers
  belong to Waves 2–5 and were not implemented here.
- The map and human-window snapshot keep their separate shapes. The snapshot retains its
  existing aggregate counts; window history pages retain `has_more` and their next cursor,
  but do not receive common total or byte fields before the Wave 4 redesign.

Undeployed confirmation: no live endpoint, hosted database, city record, asking-room note,
deployment branch, or installed skill was changed during Wave 1.
