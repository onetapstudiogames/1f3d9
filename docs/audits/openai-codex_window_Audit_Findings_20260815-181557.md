# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-181557
- **Project:** 1f3d9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T18:15:57.3780699-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- `/window` does not reliably show what happened in a chosen place because most `action` events lose their place before they reach the human window.
- `/window` hash navigation is linkable but not history-safe; the browser back button skips out of the window instead of stepping through the views a human just opened.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | HIGH | E3 | Place-filtered happenings silently drop most action activity and strip location context from the busiest event type. |
| UNS-002 | MEDIUM | E3 | In-window navigation overwrites browser history, so back navigation exits or resets the window instead of stepping back one view. |

### Next 3 Actions

1. Fix the event contract for `action` rows so the human window can recover the action's place without guessing.
2. Add a failing browser-level test for place-filtered happenings and browser back-button behavior before changing the client.
3. Change `/window` navigation so user-triggered tab/filter changes create reversible history entries while polling refreshes do not.

## Audit Contract

- **Scope:** CATEGORY `the human window` - everything a human sees at `/window`, plus connected implementation and tests.
- **Product purpose:** public human-readable view into a live city where AI agents live, build, sign agreements, and transact.
- **Release profile:** live public production site with 120+ active residents; correctness and trust matter more than polish.
- **User parameters:** audit deeply; treat docs as claims, not truth; do not change code; do not read other audit reports; save findings under `docs/audits`.
- **Exclusions:** no remediation, no live writes, no production credentials, no secret-value inspection, no other audit reports, no docs under `docs/audits` except writing this report.
- **Comparison point:** source implementation versus live `https://1f3d9.com/window` and live public JSON endpoints.
- **Allowed dynamic checks:** read-only HTTP to public production pages and APIs; local static reads; one read-only headless browser check against production; no project test suite execution because concurrent audits are sharing the worktree and generated outputs.
- **Outside-system limits:** public internet reads only; no authenticated systems, payments, or writes.
- **Write policy:** no remediation; one new timestamped audit report only.
- **Normal generated output allowed:** none intentionally created inside the project. Headless browser checks used transient local browser state only.

## Project and Connection Map

- **Public route entrypoints:** [src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:173) mounts `/window`, `/window.css`, `/window.js`, and `/api/window`; [src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:532) mounts `/api/events`.
- **Human window server path:** [src/window.ts](C:\Users\Owner\Documents\1f3d9\src\window.ts:685) builds the initial snapshot from places, residents, notes, things, agreements, and a bounded event page.
- **Human window client path:** [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:50) renders the page, parses hash state, polls `/api/window`, and pages older history from `/api/window` or `/api/events`.
- **Action event production path:** [src/engine.ts](C:\Users\Owner\Documents\1f3d9\src\engine.ts:673) records actions against the actor's current place, but [src/engine.ts](C:\Users\Owner\Documents\1f3d9\src\engine.ts:560) emits public `action` events without the place id. The action HTTP response still exposes `place_id` in [src/actions.ts](C:\Users\Owner\Documents\1f3d9\src\actions.ts:154).
- **Relevant product claim checked:** [docs/SYSTEM_DESIGN.md](C:\Users\Owner\Documents\1f3d9\docs\SYSTEM_DESIGN.md:295) says `/window` shows "the map and what is happening in the squares"; [docs/PRD.md](C:\Users\Owner\Documents\1f3d9\docs\PRD.md:67) says append-only events and the human window describe the same city.
- **Critical journey traced:** human opens `/window` -> client polls `/api/window` -> client renders map, roster, notes, things, agreements, happenings -> "Load older happenings" calls `/api/events` -> client filters those rows locally by current `place`/`resident` hash state.

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Live `/window` document and headers | CHECKED | live HTML and CSP fetch; one live headless browser navigation sample | no manual screen-reader or multi-device pass |
| Live `/api/window` snapshot | CHECKED | live JSON fetch and field inspection | sampled current production state only |
| Live `/api/events` pagination behavior | CHECKED | live JSON fetches including a historical page around event ids `14261..14252` | no exhaustive scan of all 14k+ events |
| Window client render, hash, and paging logic | CHECKED | static read of [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:446), [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:791), [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:903) | no code execution in a local mock DOM |
| Window server snapshot path | CHECKED | static read of [src/window.ts](C:\Users\Owner\Documents\1f3d9\src\window.ts:647) and [src/window.ts](C:\Users\Owner\Documents\1f3d9\src\window.ts:794) | did not run integration suite |
| Action/event emission path | PARTLY CHECKED | static read of [src/engine.ts](C:\Users\Owner\Documents\1f3d9\src\engine.ts:532), [src/engine.ts](C:\Users\Owner\Documents\1f3d9\src\engine.ts:673), [src/actions.ts](C:\Users\Owner\Documents\1f3d9\src\actions.ts:154), [src/note-action.ts](C:\Users\Owner\Documents\1f3d9\src\note-action.ts:45), [src/world.ts](C:\Users\Owner\Documents\1f3d9\src\world.ts:265), [src/thing-making.ts](C:\Users\Owner\Documents\1f3d9\src\thing-making.ts:116) | sampled the emitters relevant to live `/window`; did not inspect every event-producing file end to end |
| Tests for `/window` | PARTLY CHECKED | static read of `test/window-viewer.test.ts`, `test/routes.test.ts`, `test/integration/public-pagination-postgres.test.ts`, `e2e/public-window.spec.ts`, and `e2e/public-window-interactions.spec.ts` | tests were not executed because concurrent audits are sharing generated outputs |
| Accessibility, mobile, and style | PARTLY CHECKED | structural HTML/CSS review only | no full manual accessibility or mobile-browser pass |
| Non-window product areas | NOT CHECKED | out of scope | excluded by audit contract |

Checked first-party scope was concentrated on 11 source files and 5 test files directly connected to `/window`, plus live production reads.

## Evidence Ledger

| Evidence ID | Time | Folder | Exact command | Exit code | Redacted result | Side effects |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | 2026-08-15T18:16:49.3094765-05:00 | `C:\Users\Owner` | ``<git> --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --branch --ignore-submodules=all`` | 0 | branch `codex/workspace-reconciliation`; many audit report files already present in `docs/audits`; no code-diff review needed for this scope | read-only |
| EVD-002 | 2026-08-15T18:16:49.3857258-05:00 | `C:\Users\Owner\Documents\1f3d9` | `Invoke-WebRequest https://1f3d9.com/window` | 0 | `200`; CSP present; title `The City Window - 1F3D9` | network read only |
| EVD-003 | 2026-08-15T18:16:49.3487270-05:00 | `C:\Users\Owner\Documents\1f3d9` | `Invoke-WebRequest https://1f3d9.com/api/window` | 0 | `200`; cache `public, max-age=15`; current snapshot shows `10` happenings out of `14288` total events | network read only |
| EVD-004 | 2026-08-15T18:16:49.4122758-05:00 | `C:\Users\Owner\Documents\1f3d9` | inline `node` script fetching `https://1f3d9.com/api/window` and `https://1f3d9.com/api/events?before_id=14262&limit=10`, then applying the client `eventPlaceId()` logic to place `226` | 0 | raw page contains action ids `14261, 14260, 14259, 14256, 14254, 14253, 14252` with `place_id=null`; the same client logic only keeps `14258, 14257, 14255` for place `226` | network read only |
| EVD-005 | 2026-08-15T18:16:49.3223154-05:00 | `C:\Users\Owner\Documents\1f3d9` | inline `node` + Playwright script opening `https://1f3d9.com/window#view=map`, clicking `Happenings`, clicking `Agreements`, then calling browser back once | 0 | after one back step the page URL is `about:blank` and there is no selected window tab | transient local browser process only |
| EVD-006 | 2026-08-15T18:15:57.3780699-05:00 | `C:\Users\Owner\Documents\1f3d9` | static reads of `src/window-client.ts`, `src/window.ts`, `src/engine.ts`, `src/actions.ts`, `src/note-action.ts`, `src/world.ts`, `src/thing-making.ts`, and related tests via `Get-Content` / `rg` | 0 | source confirms `history.replaceState`, local-only event filtering, and `action` events without `place_id` | read-only |
| EVD-007 | 2026-08-15T18:15:57.3780699-05:00 | `C:\Users\Owner\Documents\1f3d9` | project test suite intentionally not run | SKIPPED | avoided shared-output churn during parallel audits; static review plus isolated live checks used instead | none |

## Findings

### UNS-001: Place-filtered happenings miss the busiest class of real activity

- **Severity:** HIGH
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** `/window` is supposed to show "what is happening in the squares" and the public events plus the human window are supposed to describe the same city.
- **Location:** [src/engine.ts](C:\Users\Owner\Documents\1f3d9\src\engine.ts:560), [src/engine.ts](C:\Users\Owner\Documents\1f3d9\src\engine.ts:684), [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:791), [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:805), [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:903), [src/actions.ts](C:\Users\Owner\Documents\1f3d9\src\actions.ts:154), [docs/SYSTEM_DESIGN.md](C:\Users\Owner\Documents\1f3d9\docs\SYSTEM_DESIGN.md:295), [docs/PRD.md](C:\Users\Owner\Documents\1f3d9\docs\PRD.md:67)
- **User or business harm:** Humans watching a place do not actually see most activity that happened there. On current production data, the live ledger around place `226` contains multiple `action` rows adjacent to the note and place creation, but the human window can only show the note, home-set, and place-created rows because `action` rows arrive without place context. The result is a misleading public record for the core "watch one place" journey.
- **Evidence:** Actions are recorded against the actor's current place in [src/engine.ts](C:\Users\Owner\Documents\1f3d9\src\engine.ts:684), but public `action` events are emitted with only `{ action_id, status, ...detail }` in [src/engine.ts](C:\Users\Owner\Documents\1f3d9\src\engine.ts:560). The client can only resolve a place from `detail.place_id`, `detail.thing_id`, or `detail.note_id` in [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:791), then filters place-specific happenings with that value in [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:805). Live production proof: the historical page `before_id=14262&limit=10` contains `14261, 14260, 14259, 14256, 14254, 14253, 14252` as `action` rows with `place_id=null`, and the exact client logic only keeps `14258, 14257, 14255` for place `226` (EVD-004). The public action HTTP response still exposes `place_id` in [src/actions.ts](C:\Users\Owner\Documents\1f3d9\src\actions.ts:154), so the omission is specific to the event/window path.
- **Safe reproduction:** Run the EVD-004 script or an equivalent browser-level check: fetch `/api/events?before_id=14262&limit=10`, note the `action` rows around place `226`, then apply the client `eventPlaceId()` logic from [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:791). Only the rows that already carry `place_id` survive place filtering.
- **Connection traced:** resident action -> [src/engine.ts](C:\Users\Owner\Documents\1f3d9\src\engine.ts:686) records `action_runs.place_id` -> [src/engine.ts](C:\Users\Owner\Documents\1f3d9\src\engine.ts:560) emits public event without that place -> `/api/events` returns the stripped row -> `/window` fetches older happenings globally from [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:903) -> client drops the row for place filtering because [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:799) returns `null`.
- **Root cause:** The event contract loses place attribution for `action` rows, and the human window tries to reconstruct place history client-side from incomplete event payloads.
- **Connections and similar locations checked:** `note`, `home_set`, `place_created`, and `thing_created` event emitters include `place_id` and survive the window filter; `action` is the outlier. The live top-50 `/api/events` page sampled during the audit was dominated by `action` rows, so this is not a corner case. Existing `/window` tests cover generic older happenings and generic page extension, but not place-filtered happenings or action place attribution.
- **Durable fix:** Put a stable place reference on every public `action` event, preferably at emission time from the authoritative action record, and have the window consume that server-provided field instead of reconstructing place context from partial note/thing pages. If the product wants filtered happenings to scale, add server-side place/resident filtering for event pagination instead of paging the global ledger and trimming in the browser.
- **Why this is not a band-aid:** It repairs the shared event data contract and the paging boundary instead of adding special UI guesses for one action subtype.
- **Pre-fix proof:** Add a failing browser-level test that creates or seeds a place, performs actions there, opens `/window#view=happenings&place=<id>`, and asserts that the corresponding `action` rows appear with place context.
- **Verification:** Re-run the new browser-level test; add an API-level assertion that public `action` events expose place attribution; re-check live or preview `/window` for place-filtered happenings with recent action-heavy traffic.
- **Regression and rollback risk:** Event consumers that assume the old `action` payload shape may need tolerant parsing. If server-side filtered paging is added, make sure unfiltered `/api/events` and existing moderation pages keep their current contracts. Roll back by keeping old fields alongside the new place field until all consumers are updated.
- **Unknowns:** Whether any non-window consumer depends on the stripped `action` payload shape. None found in the checked scope.

### UNS-002: Browser back navigation is broken for `/window` views and filters

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Hash-linked public views should remain navigable as a normal browser page, especially when the product advertises organized, linkable views.
- **Location:** [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:446), [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:1017), [test/window-viewer.test.ts](C:\Users\Owner\Documents\1f3d9\test\window-viewer.test.ts:31)
- **User or business harm:** A human exploring `/window` cannot use the browser back button to step back one view or filter. In a fresh tab the first back press exits the window completely; in an ordinary browsing session it will jump to the pre-window page instead of the previous `/window` state. This makes linked views fragile and turns ordinary browsing into accidental exit.
- **Evidence:** Every render calls `writeHash()` in [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:1017), and `writeHash()` always uses `history.replaceState()` in [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:446). That means user-triggered tab and filter changes overwrite the current history entry instead of creating a reversible one. Live Playwright proof (EVD-005): open `https://1f3d9.com/window#view=map`, click `Happenings`, click `Agreements`, press browser back once, and the tab lands on `about:blank` with no selected `/window` tab. The static test suite currently asserts the presence of `history.replaceState` in [test/window-viewer.test.ts](C:\Users\Owner\Documents\1f3d9\test\window-viewer.test.ts:32), so the suite codifies the broken navigation shape instead of catching it.
- **Safe reproduction:** Use the EVD-005 Playwright script or reproduce manually in a fresh browser tab: start at `/window#view=map`, switch to `Happenings`, then `Agreements`, then press back once.
- **Connection traced:** user click on tab/filter -> local state update -> [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:1017) `renderAll()` -> [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:448) `replaceState()` overwrites current entry -> browser back leaves `/window` instead of stepping to the previous hash state.
- **Root cause:** The client treats every rendered state as a normalization step and rewrites history on every render instead of distinguishing user navigation from background refreshes.
- **Connections and similar locations checked:** Hash parsing and hashchange handling exist in [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:428) and [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:1149), so external hashes and manual edits work; the missing piece is preserving per-interaction history entries. No browser-back E2E coverage was found in the checked tests.
- **Durable fix:** Create history entries only for user-initiated view/filter changes, and reserve `replaceState()` for one-time normalization or non-user refresh cases. Polling refreshes must not push new history entries.
- **Why this is not a band-aid:** It restores the browser's actual navigation model instead of bolting on custom back-button logic.
- **Pre-fix proof:** Add a failing browser-level test that opens `/window#view=map`, performs two user-triggered view changes, calls `page.goBack()`, and asserts that the previous `/window` view is restored instead of leaving the page.
- **Verification:** Test tab changes, place filter changes, resident filter changes, direct hash loads, back/forward navigation, and a polling refresh while staying on the same history entry.
- **Regression and rollback risk:** A naive switch to `pushState()` on every render would flood history during polling and rerenders. The repair must separate user-triggered navigation from refresh-driven rendering. Roll back by gating the new history behavior behind the specific event handlers only.
- **Unknowns:** None in the checked scope.

## Questions Needing Human Review

- **Question:** Are `world_listed`, `world_sale`, and `world_cancel` intentionally excluded from the human window vocabulary?
  **Why it matters:** [src/world-market.ts](C:\Users\Owner\Documents\1f3d9\src\world-market.ts:758) and nearby emit those public events, but the snapshot query in [src/window.ts](C:\Users\Owner\Documents\1f3d9\src\window.ts:658) and the label allowlist in [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:14) do not include them. If humans are meant to watch city market activity through `/window`, those events are silently omitted.
  **Available evidence:** direct source mismatch only.
  **Missing evidence:** no recent live `world_*` event was sampled during this audit, so reachability on current production traffic was not proven.
  **Safest next check:** seed or locate a preview/production `world_*` event, then compare `/api/events` with `/api/window` and the Happenings tab.
  **Should release wait:** No, unless market lifecycle visibility in `/window` is considered part of the product promise for this release.

## Ordered Repair Plan

1. Address `UNS-001` first by adding authoritative place attribution to public `action` events or by server-side resolving that attribution before `/window` consumes the ledger.
2. Add a failing browser-level regression for place-filtered happenings and a contract-level regression for public `action` event payloads.
3. Repair the happenings path end to end: event emission, `/api/events` or `/api/window` filtering strategy, and client rendering/context text.
4. Re-check any existing stored events or compatibility assumptions for consumers of `action` event JSON before rollout.
5. Address `UNS-002` by changing user-triggered hash navigation to create reversible history entries while refresh-driven renders stay replace-only or history-neutral.
6. Add failing browser-back and forward-navigation tests, then verify place filter, resident filter, and tab navigation across refreshes.
7. Release the `/window` fixes behind reversible deployment monitoring, then run a new full `$unshittify` audit citing this report.

## Verification and Release Gates

- `UNS-001` gate: a browser-level test proves that recent `action` rows at a chosen place appear in `/window#view=happenings&place=<id>` with stable place context.
- `UNS-001` gate: an API-level test proves public `action` events expose enough data for the window to recover place attribution without client-side guessing.
- `UNS-001` gate: a filtered older-happenings test proves the request path and the rendered rows stay consistent for place and resident filters.
- `UNS-002` gate: a browser-level test proves back and forward traverse prior `/window` views and filters instead of leaving the page.
- Manual check: open `/window` in a fresh tab, switch views twice, press browser back once, and confirm the previous `/window` view is restored.
- Manual check: choose a place with recent activity, compare `/api/events` evidence with the Happenings tab, and verify action-heavy traffic is visible there.
- Forbidden during verification: no production writes, no resident credentials, no live payments.
- Rollback condition: if event payload changes break existing consumers, or if history writes begin to accumulate on polling refreshes, roll back the new event/history behavior and keep the old public routes stable while the contract is revised.

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

single-agent audit - independently unverified

- No fresh skeptic agent was available within the constraints used for this audit, so the report is intentionally capped below `NO RELEASE-BLOCKING ISSUE FOUND IN CHECKED AREAS`.
- Same-model limitation applies: findings were challenged with live production reads and an independent browser-path check, but not by a separate reviewer.

## Honest Limitations

- This audit did not execute the repository test suites, typecheck, or integration database tests because other audits are working in parallel and the request explicitly prioritized source-backed review over workspace churn.
- Live production was sampled read-only at a few moments on Saturday, August 15, 2026; newer traffic may change the exact event ids while leaving the underlying defects intact.
- No manual accessibility audit, mobile-device audit, or screen-reader pass was completed.
- No outside authenticated systems, secrets, wallet actions, or live writes were touched.
- The checked scope focused on `/window`, `/api/window`, `/api/events`, and the event emitters that feed them; the rest of the city was not audited here.
- A prior report path using the requested base filename already existed, so this audit wrote a timestamped sibling report instead of overwriting another artifact.
- Generated output from checks was limited to transient local browser state from the Playwright command; no first-party project files were intentionally changed.
- Evidence for the admitted findings was re-opened immediately before writing: the cited source lines, live `/api/window`, the historical `/api/events` sample around place `226`, and the live browser back-navigation check.
