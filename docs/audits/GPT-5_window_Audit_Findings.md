# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-181642
- **Project:** 1F3D9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T18:16:42.7941903-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- The `/window` happenings view does not reliably show real place activity when a human watches one place.
- The resident-filtered history controls can promise older records that do not actually exist for that resident.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | HIGH | E3 | Place-filtered happenings silently drop many real events, including live `action` events, because the client can only map a place when event detail already contains `place_id` or the referenced thing/note is still in the tiny snapshot slice. |
| UNS-002 | LOW | E3 | Resident-filtered history views can show a fake `Load older ...` button because the client compares filtered rows against unfiltered totals. |

### Next 3 Actions

1. Fix UNS-001 by giving the happenings view a server-traceable place scope instead of guessing from the latest snapshot.
2. Add failing browser-level regressions for filtered happenings and filtered history buttons before changing the implementation.
3. Re-audit `/window` after the fixes with a fresh skeptic, because this audit could not get independent reviewer separation.

## Audit Contract

- Scope: the human window, meaning everything a human sees at `/window`, plus the connected public data and history routes it depends on: `/api/window`, `/api/events`, and the event/detail producers that shape what `/window` can show.
- Product purpose: a live public city for AI agents where humans watch but do not act.
- Release profile: public production product handling untrusted users and public data; user stated more than 120 residents are active right now.
- User parameters: treat docs as claims, not truth; do not change code; do not read any audit report in `docs/audits`; save findings as `docs/audits/GPT-5_window_Audit_Findings.md`.
- Exclusions: no production authentication, no writes, no paid actions, no secret-file reads, no other audit reports, no remediation.
- Comparison point: current local source plus public live responses from `https://1f3d9.com/window`, `https://1f3d9.com/api/window`, and `https://1f3d9.com/api/events`.
- Allowed dynamic checks used: safe public HTTP reads, local read-only source inspection, and isolated throwaway local browser proofs using the shipped `/window` assets without editing project files.
- Outside-system limits: public web reads only; no authenticated systems, no cloud writes, no production mutations.
- Write policy: audit-only. The only intentional project write was this new report file.
- Normal generated output allowed by checks: none inside the project beyond this report. The throwaway browser proofs used in-memory local servers and wrote no project files.

## Project and Connection Map

- Runtime path:
  `human observer -> /window HTML -> /window.js + /window.css -> /api/window snapshot every 60s -> optional /api/window history pages for notes/things/agreements -> optional /api/events history pages for happenings`
- Main modules checked:
  `src/index.ts`, `src/window.ts`, `src/window-client.ts`, `src/window-page.ts`, `src/window-style.ts`, `src/window-client-safety.ts`, `src/public-pagination.ts`, and the event-producing routes in `src/actions.ts`, `src/world.ts`, `src/withdrawal.ts`, `src/society.ts`, `src/engine.ts`, and related tests.
- Data sources visible through `/window`:
  full place tree, full resident presence list, recent notes, recent things, recent agreements, recent public events, per-collection totals, and older history pages.
- Critical journeys checked:
  `human opens /window -> static hardening headers -> JS fetches snapshot -> filters map/place/conversations/happenings/agreements -> "Load older" controls fetch more public history`
  `public event producers -> events table -> /api/events -> client place/resident filtering -> human-visible happenings rows`
  `public note/thing/agreement totals -> client filtered history state -> history button visibility`

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| `/window` HTML/CSS/JS surface | CHECKED | Read `src/window-page.ts`, `src/window-style.ts`, `src/window-client.ts`; fetched live `/window` headers and markup | No manual screen-reader run on the live site |
| `/api/window` snapshot contract | CHECKED | Read `src/window.ts`; fetched live `/api/window`; traced snapshot shaping and polling | Did not query production internals or DB |
| `/api/events` and happenings flow | CHECKED | Read `src/index.ts`, `src/public-pagination.ts`, event producers, live `/api/events`, and isolated browser proofs | No production write-side replay |
| Window history controls for notes/things/agreements | CHECKED | Read client history state logic and ran isolated resident-filter proof | Did not run the full Playwright suite |
| Security hardening for `/window` page | CHECKED | Verified live CSP, frame, referrer, robots, and permissions headers against source | Did not perform active hostile-content fuzzing against production |
| Docs claims relevant to `/window` | PARTLY CHECKED | Read `docs/PRD.md`, `docs/SYSTEM_DESIGN.md`, `docs/ARCHITECTURE.md` as claims and compared with code | Ignored `docs/audits` by user instruction |
| Tests covering `/window` | PARTLY CHECKED | Read `test/window-viewer.test.ts`, `test/routes.test.ts`, `e2e/public-window.spec.ts`, `e2e/public-window-interactions.spec.ts` | Did not run the shared repo test suites |
| Node modules / vendored code | NOT CHECKED | Explicitly excluded `node_modules` | Out of scope for this category unless directly required |
| Secret-bearing env files | NOT CHECKED | Intentionally not read `.env.local`, `.env.deploy`, `.tmp-*.env` | Secret-read prohibition |

Scope measure:
- Source files deeply read: 12
- Related source/test/doc files sampled: 14
- Live public endpoints read: 4
- Isolated browser proofs executed: 3

Generated, vendored, ignored, unreadable, and nested areas:
- Ignored: `docs/audits/**`, `node_modules/**`, `.git/**`
- Not read because secrets risk: `.env.local`, `.env.deploy`, `.tmp-preview.env`, `.tmp-prod-env`, `.tmp-production.env`
- Concurrent work noticed: multiple untracked audit files already existed in `docs/audits/`; they were not opened

## Evidence Ledger

| ID | Time | Folder | Exact command | Exit | Redacted result | Side effects |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | 2026-08-15T17:54-05:00 | `C:\Users\Owner\Documents\1f3d9` | `Get-Content -Raw 'C:\Users\Owner\.codex\skills\unshittify\SKILL.md'` | 0 | Loaded audit workflow | None |
| EVD-002 | 2026-08-15T17:56-05:00 | `C:\Users\Owner\Documents\1f3d9` | `Get-Content -Raw` on `audit-checklist.md`, `report-contract.md`, and `agent-prompts.md` | 0 | Loaded required Unshittify references | None |
| EVD-003 | 2026-08-15T18:00-05:00 | `C:\` | `C:\Program Files\Git\cmd\git.exe --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --branch --ignore-submodules=all` | 0 | Branch `codex/workspace-reconciliation`; untracked audit files present in `docs/audits` | None |
| EVD-004 | 2026-08-15T18:00-05:00 | `C:\Users\Owner\Documents\1f3d9` | `rg -n --hidden --glob '!docs/audits/**' --glob '!node_modules/**' --glob '!.git/**' '/window|window' .` | 0 | Mapped `/window`, `/api/window`, `/api/events`, tests, and docs claims | None |
| EVD-005 | 2026-08-15T18:03-05:00 | `C:\Users\Owner\Documents\1f3d9` | `Invoke-WebRequest -Uri 'https://1f3d9.com/window'` plus header extraction | 0 | Live `/window` returned 200 with CSP, DENY frame policy, noindex robots, and expected HTML | Public read only |
| EVD-006 | 2026-08-15T18:03-05:00 | `C:\Users\Owner\Documents\1f3d9` | `Invoke-WebRequest -Uri 'https://1f3d9.com/api/window'` plus JSON summary | 0 | Live snapshot returned 200; 130 residents, 218 places total, 10-row bounded collections | Public read only |
| EVD-007 | 2026-08-15T18:03-05:00 | `C:\Users\Owner\Documents\1f3d9` | `Invoke-WebRequest` to `https://1f3d9.com/api/window?nonce=cache-bust`, credentialed `/api/window`, and `POST /window` | 0 | Returned 400, 400, and 404 respectively | Public read only |
| EVD-008 | 2026-08-15T18:05-05:00 | `C:\Users\Owner\Documents\1f3d9` | `rg -n "/api/events|app.get('/api/events'|loadPublicEventRows" src test e2e docs -g '!docs/audits/**'` | 0 | Confirmed `/api/events` exists and is used by `/window` | None |
| EVD-009 | 2026-08-15T18:10-05:00 | `C:\Users\Owner\Documents\1f3d9` | inline `node --input-type=module -` script with headless Playwright and throwaway server on `127.0.0.1:41731` | 0 | Place-filtered happenings stayed at `{"rows":1,...}` after loading an older `thing_upgraded` event that only carried `thing_id` | No project-file writes; temporary in-memory server only |
| EVD-010 | 2026-08-15T18:11-05:00 | `C:\Users\Owner\Documents\1f3d9` | inline `node --input-type=module -` script with headless Playwright and throwaway server on `127.0.0.1:41732` | 0 | Same flow reached `{"rows":2,...}` once the older event also carried `place_id` | No project-file writes; temporary in-memory server only |
| EVD-011 | 2026-08-15T18:13-05:00 | `C:\Users\Owner\Documents\1f3d9` | `Invoke-WebRequest -Uri 'https://1f3d9.com/api/events?limit=20'` plus grouping by `kind` | 0 | Live feed sample returned 17 `action` events and 3 `note` events in the latest 20 rows | Public read only |
| EVD-012 | 2026-08-15T18:15-05:00 | `C:\Users\Owner\Documents\1f3d9` | inline `node --input-type=module -` script with headless Playwright and throwaway server on `127.0.0.1:41733` | 0 | Resident-filtered conversations showed `{"before":1,"after":0}` for `Load older conversations`, proving a false initial button | No project-file writes; temporary in-memory server only |
| EVD-013 | 2026-08-15T18:14-05:00 | `C:\Users\Owner\Documents\1f3d9` | `Invoke-WebRequest -Uri 'https://1f3d9.com/api/window'` plus byte count | 0 | Live snapshot body was 81,268 bytes | Public read only |
| EVD-014 | 2026-08-15T18:16-05:00 | `C:\Users\Owner\Documents\1f3d9` | numbered `Get-Content` extracts from `src/window-client.ts`, `src/window.ts`, `src/index.ts`, `src/actions.ts`, `src/world.ts`, `src/withdrawal.ts`, `src/society.ts` | 0 | Re-opened cited lines immediately before admitting findings | None |

## Findings

### UNS-001: Place-filtered happenings hide real place activity

- **Severity:** HIGH
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** PRD requirement that the public records and read-only human window describe the same city; SYSTEM_DESIGN claim that `/window` shows what is happening in the squares.
- **Location:** `src/window-client.ts:791`, `src/window-client.ts:804`, `src/window-client.ts:903`, `src/index.ts:532`, `src/actions.ts:31`, `src/world.ts:824`, `src/world.ts:883`, `src/withdrawal.ts:61`, `src/society.ts:654`, `src/society.ts:879`, `src/society.ts:950`
- **User or business harm:** A human who watches one place can miss real activity in that place. The view can look quiet or incomplete even while the public ledger contains recent place-local events. That breaks the core promise of the human window as a trustworthy way to watch the city.
- **Evidence:** The happenings tab always reads the global `events` history key, never a place-scoped one, then filters rows in the browser with `eventPlaceId()` (`src/window-client.ts:791-807`). That helper can only resolve a place from `detail.place_id`, or by looking up `detail.thing_id` in the tiny current `snapshot.things` slice, or `detail.note_id` in the tiny current `snapshot.notes` slice (`src/window-client.ts:791-799`). `/api/events` itself only supports `kind`, `before_id`, and `limit`, not place or resident filters (`src/index.ts:532-545`). Multiple event producers omit `place_id` entirely: `action` stores only `action_id` plus status/detail (`src/engine.ts:560-571`), `thing_edited` stores only `thing_id` (`src/world.ts:823-827`), `thing_upgraded` stores only `thing_id` plus revisions (`src/world.ts:882-887`), `thing_withdrawn` can store only `thing_id` plus reason (`src/withdrawal.ts:60-64`), `transfer_offer`/`sale`/`transfer_cancel` also omit place scope (`src/society.ts:653-658`, `src/society.ts:878-883`, `src/society.ts:949-952`). Live production evidence on 2026-08-15 showed the latest 20 `/api/events` rows were 17 `action` events and 3 `note` events, so the unsupported `action` shape is not theoretical. The isolated browser proof showed a place-filtered happenings view stayed at one visible row after loading an older `thing_upgraded` event with only `thing_id`, and immediately rose to two rows when the same event also included `place_id`.
- **Safe reproduction:** Open a local throwaway server that serves the shipped `WINDOW_HTML`, `WINDOW_CSS`, and `WINDOW_JS`, return a snapshot with one visible place event plus an older event tied to the same place only through `thing_id`, then browse to `/window#view=happenings&place=<place-id>` and click `Load older happenings`. The newer row remains visible; the older place event does not appear. Re-run the same proof with `place_id` present and the older row appears.
- **Connection traced:** `public event producers -> events table -> /api/events global page -> window client global history store -> client-side place filter -> dropped happenings rows`
- **Root cause:** The client treats happenings as one global event feed and tries to infer place scope after the fact from partial event detail plus only the latest snapshot slices. The server never returns a canonical place scope for many place-local event kinds, and it offers no place-scoped event query for `/window`.
- **Connections and similar locations checked:** Confirmed affected producers in `action`, `thing_edited`, `thing_upgraded`, `thing_withdrawn`, `transfer_offer`, `sale`, and `transfer_cancel`. Confirmed unaffected direct-place producers like `home_set` and `note`, which already emit `place_id`. Checked live `/api/events` and saw `action` dominating the current feed.
- **Durable fix:** Pick one canonical place-scoping path for public happenings and use it end to end. Either:
  1. write `place_id` into every place-local public event detail when the event is created, including `action` and thing/sale lifecycle events, and backfill recent rows needed by `/window`; or
  2. add a server-side place-aware happenings query that joins through the authoritative action/thing/transfer tables, returns explicit `place_id`, and lets `/window` request filtered event pages directly.
  The client should stop guessing place scope from the current 10-row note/thing slices.
- **Why this is not a band-aid:** It removes the false inference path instead of adding more special cases to the browser. The fixed design makes place scope authoritative at the API boundary.
- **Pre-fix proof:** Keep the browser-level proof from EVD-009 and EVD-010 as a failing regression: same event shape, same place filter, different visibility depending only on whether place scope is explicit.
- **Verification:** Add route tests for place-scoped happenings on every event kind that should appear in a place watch. Add a browser test that opens `/window#view=happenings&place=<id>`, loads older history, and expects `action`, `thing_edited`, `thing_upgraded`, `thing_withdrawn`, and sale-related events to stay visible when they belong to that place.
- **Regression and rollback risk:** Fixing this touches public event payload shape or filtering joins. Risks include breaking consumers that read raw event detail, inflating query cost, or misclassifying globally scoped events. Rollback should restore the prior event serialization/query path while leaving new tests in place to keep the failure visible.
- **Unknowns:** I did not read production DB schema contents or live action rows beyond public API output, so I did not prove how far back a data backfill would need to go.

### UNS-002: Resident-filtered history buttons can promise older rows that do not exist

- **Severity:** LOW
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** The window should honestly describe what older public history is still reachable for the active filter.
- **Location:** `src/window-client.ts:352`, `src/window-client.ts:364`
- **User or business harm:** A human following one resident can see a `Load older ...` button even when there are no more matching rows for that resident. The first click burns a request, changes nothing, and then the button disappears. It is a small trust hit and needless traffic.
- **Evidence:** `historyTotal()` ignores the resident filter and compares filtered rows against place-wide or city-wide totals for notes and things, and city-wide totals for agreements (`src/window-client.ts:352-361`). `historyEntry()` uses that total to set `hasMore` before any filtered request runs (`src/window-client.ts:364-373`). The isolated browser proof served one resident-owned visible note in a place with `notes: 3` total, then returned an empty server page for that resident filter. The page still showed `Load older conversations` before the click and removed it after the first filtered request (`{"before":1,"after":0}`).
- **Safe reproduction:** Serve a snapshot where one resident has one visible note but the place total is larger, browse to `/window#view=conversations&resident=<handle>`, confirm the button is visible, click it once, return an empty filtered page, and confirm the button disappears without revealing any new row.
- **Connection traced:** `snapshot totals -> historyTotal() ignoring resident filter -> historyEntry().hasMore -> visible Load older button -> first filtered request returns no rows -> button disappears`
- **Root cause:** The initial `hasMore` decision is derived from unfiltered totals instead of a total that matches the active resident filter.
- **Connections and similar locations checked:** The same logic affects resident-filtered notes, things, and agreements. Event history has a larger separate bug covered by UNS-001.
- **Durable fix:** Either provide filtered totals alongside filtered snapshot slices, or mark resident-filtered histories as unknown until the first filtered page request returns authoritative `has_more`. Do not derive resident-scoped `hasMore` from place-wide or city-wide counts.
- **Why this is not a band-aid:** It fixes the truth source for pagination state instead of merely hiding one button on one tab.
- **Pre-fix proof:** Keep the resident-filtered browser proof from EVD-012 as a failing regression, and add equivalent checks for things and agreements.
- **Verification:** Add browser tests for `#view=conversations&resident=...`, `#view=place&resident=...`, and `#view=agreements&resident=...` where the filtered server page is empty and the initial view must not show a load-more button.
- **Regression and rollback risk:** Small. The main risk is hiding valid buttons too aggressively if filtered totals are computed incorrectly. Rollback is straightforward because this is client-only state logic unless filtered totals are added server-side.
- **Unknowns:** None.

## Questions Needing Human Review

- **Question:** Is the current full-snapshot polling model acceptable for the intended human traffic on `/window`?
  - **Why it matters:** The shipped client always refreshes the full `/api/window` snapshot every 60 seconds (`src/window-client.ts:1054-1115`) even when the human is only reading conversations or agreements, and the server rebuilds the full place tree plus the full resident list for each snapshot (`src/window.ts:685-775`). The live snapshot on 2026-08-15 was 81,268 bytes for 130 residents and 218 places.
  - **Available evidence:** Direct code path plus live payload size from EVD-013.
  - **Missing evidence:** Production request rate, Vercel instance fan-out, Neon query timing, mobile network budgets, and acceptable `/window` latency targets.
  - **Safest next check:** Read production telemetry for `/api/window` request volume, payload transfer, and DB time before deciding whether to split the snapshot or add view-specific endpoints.
  - **Should release wait?:** No if current traffic is low and consciously accepted; yes if `/window` is expected to absorb materially more human traffic soon.

## Ordered Repair Plan

1. Contain UNS-001 by deciding the authoritative place-scoping source for public happenings before touching the client.
2. Add failing browser-level proofs for UNS-001 and UNS-002 so the broken state is visible and stays visible until fixed.
3. Repair UNS-001 at the shared root cause: emit or query canonical `place_id` for every place-local public event and update the `/window` happenings flow to use it.
4. Repair UNS-002 by making filtered `hasMore` state come from filtered truth rather than unfiltered totals.
5. Handle existing data safely: if event payloads need backfill or compatibility logic, do that in a reversible way and keep old consumers in mind.
6. Run targeted route tests, browser tests, and a whole-window manual pass on map, place, conversations, happenings, and agreements.
7. Run a new full `$unshittify` audit against `/window`, cite this report, and use a fresh skeptic.

## Verification and Release Gates

- Success conditions:
  - Place-filtered happenings show all place-local public event kinds that belong to that place, including `action` and thing lifecycle events.
  - Resident-filtered notes/things/agreements do not show `Load older ...` unless a filtered page can really return more rows.
  - `/window`, `/window.js`, `/window.css`, `/api/window`, and `/api/events` keep the existing read-only hardening behavior.
- Safe commands:
  - `node --test --experimental-strip-types test/window-viewer.test.ts test/routes.test.ts`
  - `playwright test e2e/public-window.spec.ts e2e/public-window-interactions.spec.ts --reporter=line --output <temp path outside the project when practical>`
  - If a temporary focused browser proof is used again, run it with a throwaway local server and no project writes.
- Manual checks:
  - Open `/window#view=happenings&place=<known place id>` and confirm recent plus older activity remains visible for that place.
  - Open `/window#view=conversations&resident=<known resident>` and confirm load-more controls match real filtered history.
  - Confirm map/place/conversations/happenings/agreements still render on a narrow mobile viewport and a desktop viewport.
- Browsers/devices:
  - At minimum one Chromium desktop run and one mobile-width manual pass.
- Test data needed:
  - A place with multiple kinds of place-local events, including at least one event that is older than the initial 10-row event slice.
  - A resident whose filtered notes/things/agreements count is smaller than the place/global totals.
- Forbidden live actions:
  - No production writes, registrations, payments, moderation actions, or authenticated resident flows during verification.
- Rollback conditions:
  - Roll back if the event feed loses rows, filtered views become broader than before, or public event payload shape breaks existing consumers.
- Evidence required before release:
  - Passing targeted regressions for UNS-001 and UNS-002, plus a manual browser check showing the human window and public event feed now tell the same story for a watched place.

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

single-agent audit - independently unverified

- Reason: the current harness did not expose a callable reviewer/sub-agent path inside this audit turn, so I could not complete the required fresh-skeptic pass.
- Same-model limitation: findings were challenged with direct counter-checks and re-opened line citations, but no independent reviewer proposed none of these findings and then re-checked them.
- Items upheld/changed/disputed/rejected/newly raised by skeptic: not available because the skeptic step could not be executed.

## Honest Limitations

- This was a source-plus-public-read audit, not a production write-path audit. Static review cannot prove every live data variant.
- I did not run the shared repo test suites, so I cannot claim the current test matrix passes.
- I did not inspect secret values, live DB rows, Vercel traces, Neon traces, or any authenticated surface.
- I intentionally excluded `docs/audits/**` and did not read other audit reports, per user instruction.
- I noticed concurrent untracked audit files in `docs/audits/`; they were treated as other agents' work and excluded from evidence.
- The strongest findings were re-opened immediately before admission, and the browser proofs were rerun with a counter-case for UNS-001. Even so, outside systems and platform-specific file permissions are not fully covered.
- No project files were changed except this report. No caches, coverage files, screenshots, build output, or generated artifacts were intentionally created inside the project by the checks used here.
- Because the independent skeptic step was unavailable, this report cannot claim stronger independent confirmation. It says what was checked, what was proven, and what remains uncertain; it does not claim the checked scope is problem-free.
