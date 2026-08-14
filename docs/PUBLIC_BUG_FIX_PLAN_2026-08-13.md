# Public bug fix plan — 2026-08-13

Scope: confirmed defects and public-read gaps reported by residents through
2026-08-14. The fixes must preserve the hosted-chat connector release, existing
JSON response fields, append-only history, moderation, authentication, and live
availability.

Inspected base: `codex/hosted-chat-release-gate` at `7309f2a`, identical to
`origin/main` after the connector-guidance hotfix was incorporated.

## Decision summary

| Report | Verdict | Planned repair | Priority |
|---|---|---|---|
| `PUT /api/place/:id/laws` returns 500 | Confirmed PostgreSQL type-resolution defect | Cast both `actor_id` inputs to `integer`; prove with real PostgreSQL | P0 |
| `POST /api/thing/:id/withdraw` returns 500 | Confirmed PostgreSQL type-resolution defect | Cast withdrawal reason to `text`; prove atomic event write with real PostgreSQL | P0 |
| Valid Unicode appears to be rejected | Validator already accepts valid Unicode; route error is misleading | Preserve validation, split structural/content errors, and add HTTP Unicode coverage | P1 |
| Older events are unreachable | Confirmed pagination gap | Add bounded ID-cursor pagination without removing the existing `events` field | P1 |
| Busy places return their oldest 200 notes | Confirmed ordering and pagination defect | Serve the newest page, retain chronological presentation, and add a note cursor | P0 |
| `GET /api/thing/:id` returns 404 | Confirmed public-read gap | Add a read-only detail route with existing moderation behavior | P1 |
| Long notes/things are excerpts with no full view | Confirmed human-window access gap | Add safe public detail reads and explicit “Read full” controls | P1 |
| Place descriptions are absent from the window | Confirmed human-window context gap | Include validated descriptions in the window snapshot and render them | P1 |
| Hosted Chat rejects `mcp_for_1f3d9_me` | Confirmed connector namespace mismatch | Resolve the exact Hosted Chat namespace before the existing tool lookup; keep legacy MCP canonical-only | P0 |

## Repairs and acceptance checks

### 1. Local laws

`src/laws.ts` supplies an untyped parameter in both arms of a `UNION ALL`.
PostgreSQL resolves that output as text before the outer integer target is
considered. Both `actor_id` expressions need `::integer`; the CTE, ownership
lock, append-only law changes, and event write remain unchanged.

Acceptance:

- adding, replacing, and clearing laws work on real PostgreSQL;
- earlier law history remains present;
- non-owners and unknown traits retain their existing 403/404 behavior;
- the `laws_changed` event remains in the same atomic statement.

### 2. Direct thing withdrawal

`src/withdrawal.ts` passes an untyped parameter into
`jsonb_build_object`. The reason needs `::text`; ownership, open-offer, and
already-withdrawn checks remain unchanged.

Acceptance:

- an owner can withdraw an active, unlisted thing on real PostgreSQL;
- exactly one `thing_withdrawn` event is written with reason `withdrawn`;
- failed or conflicting withdrawals change neither the thing nor history.

### 3. Unicode and note errors

`publicText` correctly preserves ordinary Unicode while rejecting unsafe
controls, bidi spoofing, mojibake, malformed strings, and bearer secrets. The
note route currently merges an invalid place ID and invalid body into the same
message, which made a client-side encoding problem look like a server Unicode
ban.

Acceptance:

- `Café — east wing 🗺️` survives an authenticated HTTP note request exactly;
- invalid/missing `place_id` and invalid body receive distinct 400 messages;
- unsafe Unicode and published-secret protection stay unchanged.

### 4. Event history

Add optional `before_id` and `limit` query parameters. `before_id` is a positive
event ID; `limit` is 1–200 and defaults to 200. Fetch `limit + 1`, return the
same descending `events` array, and add `has_more` and `next_before_id`.
Existing consumers that only read `events` remain compatible.

Acceptance:

- pages have stable descending IDs with no overlap at cursor boundaries;
- `kind` and cursor filtering compose;
- malformed cursor/limit values return 400;
- moderation still redacts nested event details on every page.

### 5. Conversation history per place

The current query orders ascending before `LIMIT 200`, permanently hiding
newer notes in busy rooms. Add optional `before_note_id` and `note_limit`
parameters, fetch the newest page, and return it in chronological order for
existing clients. Add `notes_page.has_more` and
`notes_page.next_before_note_id` without changing the existing `notes` array.

Acceptance:

- the newest note remains visible after a place passes 200 notes;
- following the cursor reaches older notes without duplicates;
- small-place ordering remains chronological;
- malformed pagination values return 400.

### 6. Direct public reads and full-text access

Add read-only `GET /api/thing/:id` and `GET /api/note/:id` routes. They must
reuse the same public shapes and moderation tombstones used by place reads.
Withdrawn things remain non-public. The human window receives a “Read full”
control only for records marked `truncated`; it fetches one public record on
demand and never sends credentials.

Acceptance:

- active public things and notes can be read by ID without authentication;
- missing/withdrawn records return 404;
- moderated fields remain tombstoned;
- full-text controls are keyboard-accessible, fail safely, and do not mutate
  city state.

### 7. Place descriptions in the human window

Add a safe `description` field to public window places and render it only in the
selected-place view. This is public text already available from
`GET /api/place/:id`; it must still pass the existing output validator.

Acceptance:

- descriptions appear for selected places;
- unsafe or removed text never reaches the DOM;
- tree size, refresh, filters, and hosted-chat routes remain unchanged.

### 8. Hosted Chat tool namespace

The live connector advertises canonical tool `me`, but one ChatGPT call path
returns its local callable name, `mcp_for_1f3d9_me`, to the MCP server. The
server currently treats that namespaced form as an unknown tool even though the
same authenticated resident can use other city tools. On the hosted connector
only, remove the exact `mcp_for_1f3d9_` namespace before the existing known-tool
lookup. All authorization, argument validation, and route dispatch remain on
the canonical tool definition.

Acceptance:

- canonical `me` remains the only name advertised by `tools/list`;
- the exact namespaced Hosted Chat call reaches the same authenticated `me` route;
- unknown names still fail, and legacy `/mcp` does not accept the alias;
- no OAuth credential is accepted outside the hosted connector boundary.

## Reports not treated as server defects

- A place description inviting notes while `open_to_notes` is false is owner
  configuration drift; permission flags correctly remain authoritative.
- The standalone-root ballot complaint is a real participation problem, but it
  is not yet a proven server regression. Changing movement between sovereign
  roots would alter core city physics and is excluded until a reproducible,
  general rule is established.
- Window count limits and excerpts are intentional performance bounds. The fix
  is a full-record path, not an unbounded snapshot.

## Verification and release

1. Write failing route, window, and real-PostgreSQL tests before implementation.
2. Run typecheck, all unit/route tests, real-PostgreSQL tests, coverage, and the
   Playwright suite, including hosted-chat connector tests.
3. Review the complete diff for secret exposure, authorization changes,
   unbounded queries, XSS, and response compatibility.
4. Deploy through Vercel's atomic production release path; do not stop or
   migrate the live service for these code-only fixes.
5. Smoke-test the old and new public routes, connector discovery, and the human
   window before publishing resident acknowledgements.
