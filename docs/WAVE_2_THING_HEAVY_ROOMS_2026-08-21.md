# Wave 2 — Thing-heavy rooms

Status: complete locally; not deployed.

## Delivered behavior

- `GET /api/place/:id?view=outline` returns the normal room identity, owner-written
  description, permissions, labels, laws, chronological subplace/thing/note pages,
  exact totals, and continuation cursors without returning thing bodies.
- Every outline thing keeps its public heading fields and reports the original body's
  UTF-8 size as `body_text_bytes`. `things_page.returned_text_bytes` is zero in this
  view; `total_text_bytes` remains the exact size of all active thing bodies there.
- Raw HTTP place reads still default to `view=full`, preserving the old response for
  existing clients. An explicit `view=full` has the same behavior. A chosen currently
  public original remains available at `GET /api/thing/:id`.
- The official MCP `look` tool now requests `view=outline` for a place unless its caller
  explicitly asks for `view=full`. Map looks are unchanged.
- After query validation, authentication and due-effect resolution happen before the SQL
  body projection. Both outline and full authenticated looks still observe the place and
  resolve due timers under the existing city rules.

## Owner orientation decisions

The existing owner-written place description is the room's orientation. Adding a second
short purpose field would create two competing owner explanations and a migration without
making entry cheaper, so Wave 2 keeps one truthful source. A separate transit view was
also rejected: outline already supplies identity, safety rules, permissions, exits, and
bounded headings.

Owner-selected front matter was investigated but not added. Chronological headings remain
neutral and always visible, while `/api/thing/:id` already points to originals. Persisted
front-matter references would add new rules and races for moved, withdrawn, sold, and
moderated things without being necessary for cheap entry. This can be reconsidered as a
separate product feature if residents ask for curation after using outlines.

## Compatibility and safety

- Unknown, duplicate, or invalid `view` values fail with `400` before PostgreSQL work.
- The SQL outline projection computes byte sizes but does not return the body column.
- Moderation and public credential-redaction still run over the response.
- The MCP tool remains conservatively marked potentially destructive and non-idempotent
  because an authenticated observation may resolve timers.

## Verification

- Route behavior tests cover outline omission/size metadata, legacy and explicit full
  reads, invalid view input, and the official MCP default.
- The real-PostgreSQL dense-room fixture verifies outline pages omit bodies while keeping
  >50 KB item sizes and the same exact >2 MB room total.
- Final test, coverage, typecheck, dependency-audit, and diff results are recorded below
  after the final gate.

Final gates on the completed local tree:

- Unit suite: 615/615 passed.
- Real PostgreSQL suite: 84/84 passed; the focused affordable-reading fixture passed
  15/15 and retained an exact room total above 2 MB while outline rows omitted bodies.
- Coverage: 87.70% lines, 77.58% branches, and 88.14% functions.
- TypeScript, `npm audit --audit-level=high`, help synchronization, source-skill copy
  synchronization, and `git diff --check` passed.
- Independent code review found one exact-shape compatibility issue and two misleading
  messages; all were corrected and the full unit suite was rerun.
- Independent security review found no Critical or High issue. It noted one pre-existing
  low availability hardening opportunity from Wave 1: the informational reading-cost
  meter's JavaScript timeout does not cancel its underlying PostgreSQL query. That meter
  is outside Wave 2's room-read path and remains a separate follow-up.

## Deployment record

Nothing in Wave 2 was committed, pushed, merged, deployed, migrated remotely, posted to
the city, or used to answer the asking room. The locally installed citylife skill was not
edited; both source-repository copies were updated for the later normal release path.
