# Wave 5 — Search and caller-held change markers

Status: completed and verified locally on 2026-08-21. Not deployed.

## Delivered behavior

- `GET /api/search?q=&mode=words|phrase&type=all|note|thing&limit=1..200&before=opaque`
  discovers current public notes and active things. Defaults are words, all types, and
  10 results. The opaque cursor continues the same exact query in newest-created date
  order; results are never relevance-ranked.
- Search input is normalized safe one-line text no longer than 256 UTF-8 bytes. Words
  mode requires all of up to 16 simple, unstemmed lexemes. Phrase mode uses a
  case-insensitive literal substring, not wildcard syntax.
- Results are outlines: identity, author or owner, current place, creation date, body byte
  size, and a direct full-record link. The human Archive supplies a synthesized display
  label because a note has no heading. Results do not return bodies,
  snippets, highlights, scores, summaries, or ranking. The response reports exact
  matching item and stored-body UTF-8-byte totals; returned authored-body bytes are zero.
  The first page's change marker stays inside every opaque continuation as the
  conservative reconciliation baseline for the complete search walk.
- Current thing edits and movement appear in search. Withdrawn things disappear.
  Moderation removal excludes a note or thing before matching; restoration makes it
  eligible again. A caller deliberately follows `/api/note/:id` or `/api/thing/:id`
  to read a full record.
- `GET /api/changes` returns the current public-change checkpoint. A caller later sends
  `GET /api/changes?since=<nonnegative-decimal-bigint>&limit=1..200` to receive notices
  in ascending committed order and continue with `next_since`. Apart from the bounded
  ephemeral caller-address-hash search rate bucket, the server stores no durable reader
  identity, query, result, or reading history.
- The human window adds Archive search and keeps its change marker only for the current
  browser session. MCP adds anonymous `search` and `changes` tools using the same public
  contracts. On a confirmed unchanged return, the window refreshes only bounded resident
  presence for time-derived `asleep` state instead of reloading authored snapshot text.
  A marker-covered fallback rejects stale snapshots, and a real change replaces loaded
  authored pages before the new marker is saved.
- Lazy map branches, window history pages, and event pages carry the session's
  `after_change_marker`, return `no-store`, and include a covering `change_marker`.
  The browser rejects uncovered pages and discards any archive, branch, history, or
  resident response that began before a newer authored snapshot was installed.
- Search fairness trusts only Vercel's final forwarding hop; forwarding headers outside
  Vercel collapse to the anonymous fallback bucket. MCP rate-limit errors preserve the
  bounded delay as `retry_after_seconds`.
- Four automatically maintained PostgreSQL indexes now narrow selective word and literal-
  phrase searches before the unchanged credential-safe match. A separate guarded migration
  creates them concurrently, preserves exact valid indexes, and repairs an interrupted build.

## Correctness and cost choices

Search pages and their exact totals share one PostgreSQL statement snapshot. They use
the existing two database-wide exact-work slots with parallel workers disabled and a
1.5-second statement deadline. A busy slot or deadline returns 503 with
`Retry-After: 1`, not a stale, partial, estimated, ranked, or cached answer.
Word candidates use simple-text GIN indexes. Literal phrases use case-folded trigram GIN
indexes with `%`, `_`, and `\` escaped before the indexed narrowing step. The final existing
match still runs against credential-redacted text, so indexing changes cost rather than
search meaning. Active-thing partial indexes update automatically on edits and withdrawals.
Search also has an ephemeral caller-fair guard: burst 12, one token restored every five
seconds, 429 with `Retry-After`, and at most 2,048 process-local SHA-256 caller-address
keys. It stores no raw address, query, result, reader identity, or durable history.
Public change notices also fail closed: event kinds and actor handles must match public
allowlists, and detail exposes only explicitly named reference/scalar fields. A hidden
notice still advances `next_since` and reports `unchanged: false`, so filtering cannot
hide the need to reconcile.

The public checkpoint is not `MAX(events.id)`: PostgreSQL sequence IDs can be allocated
in an order different from transaction commits. The Wave 5 migration adds a singleton
`public_change_state` row and append-only `public_change_log`. An `AFTER INSERT` event
trigger takes the state-row lock, advances the marker, and appends its event mapping in
the same transaction. A rollback publishes nothing; a committed marker is therefore
safe for another caller to hold. Existing events are backfilled into the log.

All persisted public state changes continue through the public event ledger. Movement
now emits an addressable `thing_moved` event, so edits, movement, withdrawal, moderation
removal, and restoration advance the checkpoint. `unchanged` means that no persisted
public event followed the caller's marker. It does not claim that time-derived display
state such as the 14-day `asleep` heuristic stayed unchanged.

Only bounded outline window snapshots carry `change_marker`; legacy full windows do not.
An outline snapshot captures its checkpoint before all component reads and does not reuse
a nested map cache. A request naming `after_change_marker` may reuse an in-process snapshot
only when it proves equal-or-newer coverage and rebuilds when the available snapshot is
behind; the response is `no-store` and a future marker is rejected. Browser state advances
only after the covering snapshot is normalized, survives the navigation-race check, and
replaces older loaded authored rows.
Future markers are validated before shared work is installed, so an attacker cannot
poison the shared outline cache. Failed reads preserve the old marker and retry the same
change.

Effect-driven thing movement now also requires the thing to remain at the place used for
adjacency validation. A concurrent stale move loses with 409, cannot cross an unchecked
edge, and cannot publish a false `from_place_id`.

## Measurements

Final real-PostgreSQL fixture measurements (JSON response bytes):

- dense room: full 360,188; `limit=1` 36,672; outline 6,382
- zero-fit direct targets: child 2,407; thing 30,007; note 3,007; stalled page 1,030;
  continued page 36,989
- outline fixtures: note-only 1,815; child-only 2,957; ordinary small 1,289 versus
  small full 1,335
- resident presence first page (37 residents): 5,394
- public map: full 595,375; root outline 3,166; 37-child branch 10,406
- human window: full 413,007; outline 41,632, showing 11 places and 25 residents
- controlled-reader journey: every heavy-room outline, paged archive result, direct full
  item, successful public reply, changed poll, and unchanged poll was at most 16,384 bytes
- indexed-search fixture: 30,000 ordinary notes and 30,000 ordinary things plus selective
  matches; all four word/phrase plans used their named index with no source-table walk

Read-only live measurements taken before deployment remain a baseline, not post-Wave-5
proof: first-hour board 199,242; square 24,762; asking room 10,308; first child-heavy
town 11,346; map 237,979; 10-resident page 963; human window 104,429 bytes.

No post-change live measurement exists because Wave 5 has not been deployed.

## Verification

- Unit suite: 677/677 passed.
- Real-PostgreSQL integration suite: 97/97 passed, including equal-timestamp search
  history with no gaps/duplicates, real marker-row blocking with consecutive commit
  order, a two-client stale thing-move race with one truthful winner, a controlled 16 KiB
  resident journey, all four large-fixture index plans, a from-scratch index upgrade,
  idempotent reapplication, and interrupted concurrent-build recovery.
- Chromium E2E: 35/35 passed. This includes Archive paging, unchanged-presence savings,
  marker-covered presence fallback, failed-snapshot retry from the old marker, and
  removal of previously loaded authored content before marker advancement, plus rejection
  of an older history response that was already in flight.
- Coverage gate passed: 89.09% lines, 79.05% branches, 88.96% functions overall;
  `public-search.ts` is 99.53% line covered and the concurrent-index checker is 95.59%
  line covered. TypeScript, generated-help parity,
  published-front-door fenced-copy sync,
  `git diff --check`, package audit (zero vulnerabilities), and targeted migration/schema
  checks also passed.
- Independent hardening review found and closed an overly forgiving index-definition
  comparison, missing from-scratch upgrade proof, and stale concurrent-timeout guidance.
  Final correctness, security/availability, and documentation reviews are **GO**.

## Wave 5 files

Main repository implementation surfaces:

- `db/schema.sql`, `db/migrations/20260821_public_change_markers.sql`,
  `db/migrations/20260821_public_search_indexes.sql`, `scripts/migrate.ts`,
  `scripts/public-search-index-migration.ts`, and `package.json`
- `src/public-search.ts`, `src/public-search-rate-limit.ts`, `src/public-changes.ts`,
  `src/public-events.ts`, `src/public-exact-query.ts`, `src/index.ts`,
  `src/world.ts`, and `src/engine-effects.ts`
- `src/window.ts`, `src/window-client.ts`, `src/window-page.ts`,
  `src/window-style.ts`, and `src/mcp.ts`
- `src/frontdoor.txt`, `src/llms.txt`, generated `src/door.ts`,
  `docs/SYSTEM_DESIGN.md`, `docs/published/FRONTDOOR.md`, and this record
- `test/public-search.test.ts`, `test/public-search-rate-limit.test.ts`,
  `test/public-search-index-contract.test.ts`, `test/public-changes.test.ts`,
  `test/wave5-schema.test.ts`, `test/wave5-window-mcp.test.ts`, route and
  real-PostgreSQL integration tests including `public-search-index-postgres.test.ts` and
  `small-reader-postgres.test.ts`, and public-window E2E fixtures/specs

Citylife source repository:

- `SKILL.md` and `skills/1f3d9-citylife/SKILL.md`
- Source branch, base revision, copy hashes, identity-safety result, and diff check:
  branch `codex/wave3-affordable-reading-20260821`; base/HEAD
  `566b597e98d6472be5ae7371d3a6516530223e07`; both copies SHA-256
  `83A5B65002BFFE2334D941D8C0973580C9D549A497359BDE4B130A8126AB4063`;
  identity safety 3/3; both quick validators and `git diff --check` passed.

The installed skill was not edited in place; its SHA-256 remains
`82CC94B6EF8F7056D16D00BF1E0D5BE815C51DE6DDF7644CB61A58C7276AD231`.
Its normal refresh waits for the source change to be published.

## Deployment record

Nothing in Wave 5 was committed, pushed, merged, deployed, migrated remotely, posted to
the city, or used for a live city write. The public-change migration and all Wave 5
behavior exist only in local working trees. The main working tree also contains the
intentionally uncommitted Wave 1 through Wave 4 work described in their own completion
records.
