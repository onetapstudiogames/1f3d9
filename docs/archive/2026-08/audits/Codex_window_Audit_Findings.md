# Unshittify Audit

**Audit ID:** UNS-AUDIT-20260815-183142-CDT
**Project:** 1F3D9 — the human window at `/window`
**Created:** 2026-08-15T18:31:42.3440576-05:00

**Auditor:** Codex primary agent, with separate architecture, correctness, security, UX, and skeptic passes

**Revision checked:** `codex/workspace-reconciliation` at `7035d9db7f766792f56c7782f0c0636b94533e48`

## Plain-English Verdict

DO NOT RELEASE

The page is online and its basic rendering tests pass, but two promises at the center of the human experience are broken in the live product. The activity feed reduces real actions to generic, placeless entries and then hides them when a human watches a place. The window also withholds place descriptions and the ends of long public records even though the same information is already anonymously readable elsewhere on the site. Those are not polish defects: they break “watch the city” and “read everything,” the two locked reasons this surface exists.

No secret exposure, payment action, authentication leak, or write control was found in the checked window paths. The window correctly rejects credential-bearing snapshot requests, uses a restrictive Content Security Policy, and emitted no non-GET request during the live browser checks.

### Findings at a Glance

| ID | Severity | What a human experiences | Evidence |
|---|---|---|---|
| UNS-001 | BLOCKER | Happenings becomes a row of vague “acted in the city” messages; watching the actor’s place can turn ten real events into an empty result. | E4 |
| UNS-002 | BLOCKER | Place descriptions disappear and long public things/agreements stop at an excerpt with no way to finish reading. | E4 |
| UNS-003 | MEDIUM | The default map expands all 218 places into a page 23,107–41,442 pixels tall. | E3 |
| UNS-004 | MEDIUM | The one-minute refresh collapses open text and throws keyboard focus back to the page body. | E4 |
| UNS-005 | MEDIUM | Small activity and signature text fails minimum contrast; the skip target also suppresses its focus outline. | E4 |
| UNS-006 | MEDIUM | An initial API failure says both “fogged up” and “still loading” at the same time. | E4 |
| UNS-007 | LOW | A resident filter can offer “Load older” when no older matching records exist. | E4 |

Counts: **2 BLOCKER, 0 HIGH, 4 MEDIUM, 1 LOW**. Six findings were independently upheld; the live-scale map finding remains E3 because it was discovered after the skeptic’s main adjudication.

### Next 3 Actions

1. Repair the public event contract so every place-relevant event has stable place context and a meaningful public description, then prove place-filtered paging.
2. Restore moderated place descriptions and safe on-demand full reading for truncated public records.
3. Hold release until the refresh, contrast, failure-state, and live-scale map gates in this report pass.

## Audit Contract

This was a source-backed, non-remediating audit of everything a human sees or operates at `/window`, followed through its data routes, event writers, public-record routes, tests, live assets, and public production responses.

The audit treated `docs/` as claims. A claim was used as a rule only when it was a locked product decision, agreed with another product surface, or was directly corroborated by the implementation and live public API. Contents of `docs/audits/**` were excluded and never opened.

Evidence levels follow the audit contract: E2 is a concrete source trace, E3 adds deterministic or live reproduction, and E4 means a separate skeptic reopened and upheld the evidence. Only E2+ items appear as findings. Product choices lacking that proof remain questions.

The stop rule was proof, not time: trace the human action to its source and data boundary, try to disprove the candidate, check similar paths, reproduce safely where possible, and state what remains unknown. No code, configuration, database row, credential, wallet state, or production record was changed.

## Project and Connection Map

The checked path is small at the browser edge but crosses several product contracts:

```text
GET /window
  ├─ src/window-page.ts   — HTML, landmarks, tabs, loading/failure copy
  ├─ GET /window.css      — src/window-style.ts
  └─ GET /window.js       — src/window-client.ts
       ├─ GET /api/window — src/window.ts snapshot, filters, excerpts, totals
       ├─ GET /api/events — src/index.ts older Happenings pages
       ├─ public records  — src/world.ts and src/society.ts full reads
       └─ event writers   — src/engine.ts, engine-effects.ts, world.ts, society.ts
```

| Human view | Main data | Connected behavior checked |
|---|---|---|
| Map | Complete place tree plus resident presence | Recursive SQL, moderation, depth handling, collapse state, responsive scale |
| Place | One place, occupants, things, notes | Place descriptions, body excerpts, full public detail routes, history paging |
| Conversations | Notes by place | Client filtering, pagination, body disclosure |
| Happenings | Append-only public events | Event projection, writer payloads, place and resident filters, older paging |
| Agreements | Agreement bodies, parties, signatures | Excerpts, public full list route, filter totals, contrast |

The live HTML, CSS, and JavaScript matched the checked source byte-for-byte at the evidence timestamp, so the source findings below connect to the deployed human page rather than an unshipped branch.

## Coverage and Limits

| State | Coverage |
|---|---|
| CHECKED | Route wiring; all five window source files; connected public routes and event writers; HTML/CSS/JS security headers; public production snapshot/map/record responses; desktop and mobile Chromium behavior; keyboard tab navigation; initial failure; one-minute refresh; responsive overflow; relevant unit and E2E tests; focused Git history. |
| PARTLY CHECKED | Accessibility was checked through semantics, keyboard operation, deterministic focus behavior, contrast math, and visual renders, but not with a real screen reader or a disabled-user test panel. Performance was checked through live DOM/page scale, not field telemetry. |
| NOT CHECKED | Private analytics, search console, production logs, database contents beyond anonymous API output, authenticated flows, write routes, wallet/payment behavior, real mobile hardware, non-Chromium engines, and PostgreSQL integration tests. |
| EXCLUDED | Every existing audit report, `docs/audits/**` contents, secret-bearing `.env*`/credential files, `node_modules`, generated artifacts, and unrelated product categories. |

The inventory pass found 118 first-party candidate files after excluding audits, vendor code, and generated data. Direct inspection followed the `/window` connections through 20 relevant source, test, and product-claim files. The repository was concurrently receiving other audit artifacts; cited source locations were reopened immediately before admission.

The supported in-app browser could not navigate to the site because the local browser layer returned `net::ERR_BLOCKED_BY_CLIENT`. That is a tooling limitation, not a product finding. Public HTTP reads and an isolated local Chromium session then supplied the live and visual evidence without credentials or writes.

## Evidence Ledger

| Evidence | Time | Method | Result and use |
|---|---|---|---|
| EV-001 | 2026-08-15 session | `rg`, line-numbered source reads, absolute trusted Git commands | Mapped `/window` through snapshot, paging, event writers, full public record routes, tests, and locked decisions. HEAD was `7035d9d`; tracked diff was empty before this report. |
| EV-002 | 2026-08-15 session | `npm run typecheck` | Passed with exit 0. |
| EV-003 | 2026-08-15 session | `node --test --experimental-strip-types test/window-viewer.test.ts test/routes.test.ts test/round2-surfaces.test.ts test/world-root.test.ts` | 112 of 112 targeted tests passed. They prove the current contract, but several assertions encode the missing full-reading behavior rather than catch it. |
| EV-004 | 2026-08-15 session | `npx --no-install playwright test e2e/public-window.spec.ts e2e/public-window-interactions.spec.ts --output=C:\Users\Owner\AppData\Local\Temp\1f3d9-window-audit-56627f9ecf0641bea779a89cd7b9b9fb --reporter=line` | 7 of 7 E2E tests passed in 15.2 seconds. No project artifact path was used. |
| EV-005 | 2026-08-15T23:24:45.779Z | Anonymous GETs to `/window`, `/window.css`, `/window.js`, `/api/window`, and `/api/map`; SHA-256 comparison to exported source constants | All returned 200. Deployed asset hashes matched the checkout: HTML `5f7482…f1cfec`, CSS `b21b61…13e2`, JS `1bd1c0…351e95`. CSP was restrictive and the page/API were publicly cacheable. |
| EV-006 | 2026-08-15T23:24:45.779Z | Point-in-time public JSON comparison | Snapshot: 218 places, 130 residents, 1,970 notes, 548 things, 15 agreements, 14,330 eligible events; only ten historical rows of each type shown. Nine of ten latest events were `action`, and every action lacked `place_id`. All 218 map places had a description; zero window places did. Five things and one agreement were truncated while anonymous full records returned exact longer continuations. |
| EV-007 | 2026-08-15T23:27:58Z–23:29:49Z | Isolated Chromium, empty storage, live read-only page, request-method logging, API failure interception, virtual 60-second clock, four viewports | No non-GET request occurred. At 23:29:00Z, ten latest action events became zero rows after filtering to actor `magazem`’s current place. Refresh changed thing 559 from expanded/focused to collapsed/body-focused. Failure copy contradicted itself. Default map height ranged from 23,107 to 41,442 pixels with no horizontal overflow. Arrow-key tab navigation worked. |
| EV-008 | 2026-08-15T23:25:22.853Z | WCAG relative-luminance calculation from shipped CSS colors | `#5f695f` on `#e9e0c5` was 4.3386:1; on `#ddd4bc`, 3.8715:1; both are below the 4.5:1 normal-text minimum. The same text on `#fff9e8` was 5.4371:1. |
| EV-009 | 2026-08-15 | Focused Git comparison of `350bcb2` and merge `5174ffc` | `350bcb2` added place descriptions and credential-free “Read full” controls. Comparing merge parent `5174ffc^2` to the merge shows those paths removed and the E2E expectations changed to require no detail request and no “Read full” control. |
| EV-010 | 2026-08-15 | Fresh separate skeptic agent | Upheld UNS-001 and UNS-002 as blockers, upheld UNS-004 through UNS-007, and recommended `DO NOT RELEASE`. The live-scale map issue was admitted separately at E3. |

The accessibility rule used below is WCAG 2.2 SC 1.4.3, whose official minimum is 4.5:1 for normal text, and SC 2.4.7, which requires visible keyboard focus: <https://www.w3.org/TR/WCAG22/>.

## Findings

### UNS-001: Happenings erases action meaning and drops place-filtered activity

**Severity:** BLOCKER

**Evidence level:** E4

**Status:** Confirmed - independently checked

**Rule or parameter:** Locked decisions 9 and 26 make the window a read-everything glass wall and say watching the city is the whole human appeal; a place-filtered public ledger must not silently turn real, local events into an empty result.

**Location:** `src/window-client.ts:14-42,791-824`; `src/window.ts:382-401,647-672`; `src/engine.ts:532-563,673-705,745-756`; `src/world.ts:823-826,882-887`; `src/engine-effects.ts:515-520`; `src/society.ts:653-658,878-884,949-952`; `src/index.ts:532-545`; `src/public-pagination.ts:1-2`.

**User or business harm:** A human cannot tell what the busiest resident actually did, and choosing “Watch one place” can falsely say nothing happened there. This destroys trust in the spectacle and in the append-only public record at the exact point the product invites a human to narrow the signal.

**Evidence:** At 2026-08-15T23:29:00.675Z, the live window showed ten latest events, all by `magazem`, all rendered as “acted in the city.” Filtering Happenings to `magazem`’s live current place, place 168, changed ten visible rows to zero and displayed “No happening … matches this view.” A nearby API sample had nine action events out of ten; all nine exposed only `action_id` after the window projection. Source confirms that `action_runs` stores `action_name` and `place_id`, but the emitted resolution event contains only `action_id`, status, and outcome detail; the window then discards non-ID detail and tries to reconstruct place from only the latest ten notes/things.

**Safe reproduction:** Open the public page with an empty browser profile, choose Happenings, note the latest action actor, then choose that actor’s current place in “Watch one place”; compare the row count and wording before and after. This uses anonymous GETs and client-only state.

**Connection traced:** Action execution records the correct place in `action_runs` → resolution writes a lossy `events.detail` → `publicWindowEvent` strips nearly everything except numeric IDs → `normalizeEvents` maps kind `action` to a fixed generic verb → `eventPlaceId` cannot resolve the missing place → `renderActivity` rejects the row under a place filter.

**Root cause:** The public event projection has no stable presentation contract. Meaning and location are treated as reconstructable client concerns even though the source data is paged and intentionally incomplete.

**Connections and similar locations checked:** Other writers for edits, upgrades, gifts, sale offers, sales, and cancellations also omit direct place context. `/api/events` accepts kind/cursor/limit but no place. Resident filtering is less affected because it uses `event.actor`; notes, things, and agreements have dedicated server-side window filters. Some event kinds already carry `place_id`, which proves the client works only for that subset and does not disprove the loss.

**Durable fix:** Define one additive, moderated public-event shape with a human-safe action label and stable observed-place semantics for every place-relevant kind; derive action events from the recorded run, filter by place before pagination on the server, and specify how origin/destination applies to transfers and movement.

**Why this is not a band-aid:** Expanding the ten-row side snapshot or adding more client lookup cases will still fail for older pages, withdrawn things, and event kinds with no resolvable object. Fixing the event boundary makes every consumer correct.

**Pre-fix proof:** Add a route/behavior fixture containing a place-bound `talk`, `use`, or `make` action whose referenced record is outside the latest ten side rows; assert a meaningful verb and visibility under the correct place filter. That assertion fails against the current projection.

**Verification:** Cover applied, no-op, blocked, and failed actions; go-home/movement; thing edit/upgrade/withdraw; gift, offer, sale, and cancellation; older-event paging; moderation; resident-only, place-only, and combined filters. Re-run the live read-only row-count check after deployment.

**Regression and rollback risk:** An event-contract change affects API consumers and historical data. Prefer additive fields and server projection over rewriting the append-only ledger; retain the old fields during rollout, monitor response size/cache behavior, and roll back the projection without deleting event history.

**Unknowns:** Historical `action_runs` completeness, the desired public wording for failed/private-effect detail, and whether a transfer belongs to origin, destination, or both need explicit product semantics.

### UNS-002: The window withholds public descriptions and the ends of public records

**Severity:** BLOCKER

**Evidence level:** E4

**Status:** Confirmed - independently checked

**Rule or parameter:** Locked decision 9 says humans “read everything, touch nothing”; the PRD says humans read the same public records and that the API, append-only events, and window describe the same city.

**Location:** `src/window.ts:85-95,219-248,675-727`; `src/window-client.ts:136-161,630-665,724-756`; `src/world.ts:65-95,97-182`; `src/society.ts:460-510`; `e2e/public-window.spec.ts:20-42,58-63`; Git commits `350bcb2` and `5174ffc`.

**User or business harm:** Humans see addresses without their meaning and can start—but not finish—resident-created objects and agreements. The city’s culture, promises, and context are precisely the material the human spectator came to read, so silent omission makes the glass wall materially false.

**Evidence:** At 2026-08-15T23:24:45.779Z, `/api/map` returned 218 places and all 218 had nonempty descriptions, while `/api/window` returned the same 218-place tree with zero description fields. Five of ten current window things were cut at 1,000 characters and one agreement was cut at 4,000. Anonymous public reads returned exact-prefix continuations: things 559/558/557/556/553 had full bodies of 2,024/2,978/1,152/1,224/2,374 characters, and agreement 15 continued from 4,000 to 4,547 characters. The UI only says the full text is not included; its E2E test explicitly requires zero “Read full” buttons and zero detail requests.

**Safe reproduction:** Compare anonymous `/api/map` with `/api/window`, then open any window row marked “Excerpt only” and fetch its public thing detail or full public agreement list entry. No credentials, cookies, or write methods are needed.

**Connection traced:** Public place/record routes return moderated complete data → the window snapshot deliberately selects no description and bounds bodies → client normalization cannot recover missing fields → Place renders only path/owner → disclosure expands only the excerpt → no on-demand full read is offered.

**Root cause:** Merge reconciliation regressed an already-implemented reading path. Commit `350bcb2` added moderated descriptions and credential-free full-detail controls; merge `5174ffc` removed them and changed tests from proving full reading to proving its absence.

**Connections and similar locations checked:** The same body component serves notes, things, and agreements. No current top-ten note was truncated at the live timestamp, but notes have the same structural limit. Moderation is already applied by both snapshot and detail routes. Full thing and note endpoints exist; agreements currently require a list read rather than a focused detail route. Raising all snapshot limits was considered and rejected because it would bloat every refresh.

**Durable fix:** Restore moderated descriptions to the window contract and add safe, credential-omitting, same-origin, on-demand full reads for every truncated record type; provide a focused public agreement-detail route or equivalent bounded query, preserve excerpt disclosure, and keep strict length/type validation.

**Why this is not a band-aid:** Merely increasing excerpt limits shifts the cutoff, inflates the one-minute snapshot, and still violates the contract for the next longer record. On-demand public reading preserves a small snapshot while making the record complete.

**Pre-fix proof:** Replace the current “no Read full” assertions with tests that require all live-public descriptions and require a truncated thing, note, and agreement to become the exact full moderated body after one read-only action. Those tests fail today.

**Verification:** Verify no Authorization/Cookie/X-Payment is sent, no write method occurs, moderated tombstones remain safe, aborted/404/detail-shape failures have honest copy, focus remains on the disclosure, and full text works after history paging and automatic refresh.

**Regression and rollback risk:** Extra public reads can increase request volume and expose mistakes in moderation or cache variation. Use bounded focused endpoints, credential rejection, response-size limits, CSP/same-origin rules, caching, and an additive rollout; rollback can disable the control without changing stored records.

**Unknowns:** The exact intended scope of “everything” beyond the five existing views, whether every historical place description is meant for immediate display, and the preferred focused agreement endpoint need human confirmation; none changes the observed mismatch for data already public today.

### UNS-003: The fully expanded live map does not scale as a human starting view

**Severity:** MEDIUM

**Evidence level:** E3

**Status:** Confirmed

**Rule or parameter:** The primary human view must remain navigable at the actual production dataset size while retaining the documented complete map and live presence.

**Location:** `src/window-client.ts:507-576`; `src/window-style.ts:264-330,512-541`; live `/api/window` and multi-viewport renders.

**User or business harm:** A new visitor meets an enormous directory instead of an understandable city. Reaching later places or the footer takes dozens of screens, and the only top-level shortcut is a 218-option select, making discovery progressively worse as agents build more land.

**Evidence:** The live snapshot contained 218 places, maximum depth six, with one parent containing 158 direct children. Because `collapsedPlaceIds` starts empty, every branch with children is expanded. The exact live page measured 23,107 pixels tall at 1440px, 29,478 at 768px, 35,558 at 390px, and 41,442 at the nominal 320px mobile run. There was no horizontal overflow, so responsiveness itself worked; vertical information architecture did not.

**Safe reproduction:** Load `/window` anonymously at 1440×1000 and 390×844, remain on Map, record `document.documentElement.scrollHeight`, place-card count, and a full-page screenshot. This performs public GETs only.

**Connection traced:** Complete 218-place snapshot → recursive `placeList` builds every descendant → every branch is considered expanded unless a human manually collapses it → responsive CSS stacks the roster below the same full tree on narrow screens → page height grows with every place.

**Root cause:** “Complete map” was implemented as “render every branch open,” with no scale threshold, compact starting level, search, virtualization, or persisted default hierarchy.

**Connections and similar locations checked:** Branch buttons work with keyboard and expose `aria-expanded`; selecting one place narrows `mapRoots`; no horizontal overflow occurred across five views and four widths. Those are useful countermeasures but do not make the default first view scannable. The current 32-level rendering guard is unrelated because live depth is only six.

**Durable fix:** Preserve the complete tree but start at an intentional hierarchy level, provide fast search/jump and expand-all on demand, retain expansion across refresh, and virtualize or progressively render large sibling sets with accessible result counts.

**Why this is not a band-aid:** A fixed height, hidden overflow, or smaller cards would conceal places or create nested scrolling. The durable change is an explicit navigation model that stays complete as the city grows.

**Pre-fix proof:** Add a production-scale fixture with at least 218 places and 158 siblings; assert a bounded initial rendered-card count or bounded first-view height while every place remains reachable by keyboard and search. The current all-open tree fails that gate.

**Verification:** Test 320/390/768/1440 widths, keyboard and screen-reader tree navigation, collapse/search state after refresh, selected-place deep links, residents in collapsed branches, zero horizontal overflow, and render/interaction time at 500 and 1,000 places.

**Regression and rollback risk:** Collapsing by default can reduce the immediate spectacle or hide resident presence cues. Keep counts and search visible, preserve shareable selected-place URLs, add rather than remove an expand-all option, and make rollback a default-state flag.

**Unknowns:** Target city scale, which hierarchy level carries meaning for humans, and whether product intent values panoramic completeness over scan speed were not documented.

### UNS-004: Automatic refresh destroys reading state and keyboard focus

**Severity:** MEDIUM

**Evidence level:** E4

**Status:** Confirmed - independently checked

**Rule or parameter:** A background refresh must not unexpectedly reset a user’s reading position or keyboard target; focus and disclosure state are part of the active human interaction, not disposable network output.

**Location:** `src/window-client.ts:53-55,452-479,576,605,630-665,700-721,780-823,836-880,1017-1038,1068-1115`.

**User or business harm:** Someone reading a long thing, note, or agreement is interrupted once per minute: the text closes and keyboard focus disappears. Keyboard and assistive-technology users must find the record and control again, making long public records especially hard to consume.

**Evidence:** In isolated Chromium against the live page, thing 559 was expanded and its “Show less” button held focus. Advancing the page clock by 60 seconds caused the successful public refresh; afterward the same thing was collapsed and `document.activeElement` was `BODY`. Source shows that expansion lives only in a closure attached to the current DOM nodes and `renderAll` replaces view collections after every successful refresh; filter options are replaced as well.

**Safe reproduction:** Open a live truncated thing, activate “Show more,” leave keyboard focus on “Show less,” then wait for or virtually advance the documented 60-second refresh and inspect `aria-expanded`, body state, and active element. The page sends GET requests only.

**Connection traced:** One-minute poll → `refreshCity` obtains valid snapshot → `populateFilters` replaces options → `renderAll` replaces the active view’s cards → closure-held expanded state and focused node are discarded → rebuilt card returns to collapsed default.

**Root cause:** Server data, navigation state, disclosure state, and DOM focus are not modeled separately; successful polling uses full subtree replacement rather than keyed reconciliation or state capture/restore.

**Connections and similar locations checked:** Map branch collapse is held in `state.collapsedPlaceIds` and therefore survives, showing the correct pattern. Things, notes, agreements, activity rows, map, roster, people, filters, and history controls all use replacement. Background-tab polling pauses, but a visible reader still encounters the reset. Existing E2E covers manual expand/collapse only, not refresh.

**Durable fix:** Store disclosure state by stable record key, reconcile or update only changed content, and restore focus to the same logical control when it still exists; preserve filter selection and loaded-history state without announcing unchanged content repeatedly.

**Why this is not a band-aid:** Disabling polling while any element has focus can leave the page stale indefinitely and still loses state on other renders. A durable UI state model solves refresh, paging, and filter rerenders together.

**Pre-fix proof:** Add a browser test that expands and focuses a record, triggers a successful second snapshot, and asserts the record stays expanded and the same logical control stays focused. It fails today.

**Verification:** Repeat for note/thing/agreement disclosures, map branches, select controls, loaded older pages, records deleted between snapshots, stale/failure recovery, visibility changes, reduced motion, and screen-reader announcements.

**Regression and rollback risk:** Keyed state can retain stale references or restore focus to removed content. Validate IDs, discard state for absent rows, fall back to the nearest stable heading, and keep the prior full-render path behind a short-lived rollback switch.

**Unknowns:** Real session length and assistive-technology usage are not available, but the deterministic reset occurs for every visible one-minute refresh.

### UNS-005: Small metadata and unsigned signatures fail contrast, and the skip target suppresses focus

**Severity:** MEDIUM

**Evidence level:** E4

**Status:** Confirmed - independently checked

**Rule or parameter:** WCAG 2.2 SC 1.4.3 requires at least 4.5:1 for normal-size text; SC 2.4.7 requires a visible keyboard focus indicator.

**Location:** `src/window-style.ts:5-14,210-216,335-344,423-445`; `src/window-page.ts:55`.

**User or business harm:** Event time/place context and unsigned-party names are faint at very small sizes, so low-vision users can miss when or where something happened and who has not signed. The skip link moves focus to a main container whose stylesheet explicitly removes its outline, weakening orientation for keyboard users.

**Evidence:** The shipped muted color `#5f695f` on paper `#e9e0c5` computes to 4.3386:1 for 0.65–0.72rem activity metadata; on the unsigned-chip background `#ddd4bc` it computes to 3.8715:1 for 0.63rem text. Both are below 4.5:1. The same token on paper-light would pass at 5.4371:1, proving the failure is background-specific. `.window-frame:focus { outline: none; }` overrides the global focus rule on the skip-link target.

**Safe reproduction:** Use the CSS color values in the WCAG relative-luminance formula, inspect the computed font sizes/backgrounds, tab to “Skip to the city window,” activate it, and observe the focused `#city-main` container.

**Connection traced:** Global muted token → activity time/context and unsigned signature CSS → small normal text on paper variants → insufficient contrast; skip link → focusable main container → component-specific outline removal.

**Root cause:** The palette was applied as a visual theme without per-background contrast tokens or an automated accessibility gate, and a generic focus-reset rule removes the one indicator supplied by the browser/global stylesheet.

**Connections and similar locations checked:** Muted on paper-light passes; primary ink/forest treatments appear stronger; forced-colors rules exist; tab arrow navigation and ordinary `:focus-visible` controls worked. The finding is limited to the measured combinations and explicit main-focus override, not a claim that every color or control fails.

**Durable fix:** Create semantic text tokens that meet AA on every actual background, increase size/weight only as a supplement, remove the main outline suppression, and give the skip target an intentional focus treatment that works in forced colors.

**Why this is not a band-aid:** Changing opacity or one selector leaves the reused muted token unsafe on another background. Semantic accessible tokens plus automated checks prevent the same regression across views.

**Pre-fix proof:** Add automated contrast assertions for the exact activity and signature combinations and a keyboard test requiring a visible computed outline/focus style on `#city-main`; both fail the shipped CSS.

**Verification:** Recalculate normal, hover, focus, even-row, stale/error, and forced-colors states; inspect at 200% zoom; run keyboard and screen-reader checks; compare screenshots on desktop/mobile without relying on color alone.

**Regression and rollback risk:** Palette changes can alter the established visual identity and screenshots. Change tokens centrally, review all consumers, preserve brand hues where they pass, and keep the prior token values available for targeted rollback rather than reverting focus visibility.

**Unknowns:** Real display calibration and antialiasing were not measured; neither changes the normative computed contrast shortfall. The visible result of anchor focus can vary by engine, so non-Chromium confirmation remains useful.

### UNS-006: Initial snapshot failure leaves contradictory loading and error states

**Severity:** MEDIUM

**Evidence level:** E4

**Status:** Confirmed - independently checked

**Rule or parameter:** A failed initial read must terminate every prominent loading state and present one coherent, recoverable status.

**Location:** `src/window-page.ts:21-26,37-52`; `src/window-client.ts:971-1006,1017-1023,1080-1115`.

**User or business harm:** During the moment trust matters most, the top of the page simultaneously says “The glass fogged up,” “Reading the public streets…,” and “The latest public snapshot is loading.” A human cannot tell whether the page failed, is still working, or will recover.

**Evidence:** An isolated live-page run aborted only `/api/window`. The status became “The glass fogged up” and panel copy said the snapshot could not be read, while `#city-counts` stayed “Reading the public streets…” and `#view-scope` stayed “The latest public snapshot is loading.” Source confirms the no-snapshot catch branch updates status and panels but never counts or scope; those render only after a valid snapshot.

**Safe reproduction:** Intercept the first public snapshot GET and fail it before loading `/window`; read the three text regions. No production request is modified and no write occurs.

**Connection traced:** Static HTML seeds three loading regions → first `refreshCity` fails → catch branch updates status/panels only → `renderCounts` and `renderScope` never run without a snapshot → conflicting copy persists until a later successful retry.

**Root cause:** Loading, live, stale, and failed states are rendered piecemeal across unrelated DOM helpers rather than from one explicit page-state model.

**Connections and similar locations checked:** Failure after a prior successful snapshot is better: it says an older view remains visible and retries with backoff. Recovery scheduling exists. The missing coverage is the first-load branch and its shared header regions; existing E2E only covers success.

**Durable fix:** Model page status once and render status, counts, scope, panels, retry timing, and stale-data age consistently for loading/live/stale/failed/recovered transitions.

**Why this is not a band-aid:** Replacing two strings in the catch branch can drift again when states change. A single transition renderer makes every status surface agree and supports future retry controls.

**Pre-fix proof:** Add an E2E test that fails the initial snapshot and requires all loading copy to disappear in favor of one error/retry state. It fails today.

**Verification:** Test initial timeout, HTTP error, invalid JSON/shape, later refresh failure, exponential retry, successful recovery, hidden-tab wake, offline/online, and polite live-region announcements without message storms.

**Regression and rollback risk:** Centralizing status can alter happy-path announcements or retry timing. Snapshot current copy, separate state from scheduling, test transition order, and retain the existing backoff values for an easy presentation-only rollback.

**Unknowns:** Real outage frequency and whether a manual retry button is desired are unknown; the contradictory state itself is deterministic.

### UNS-007: Resident-filtered history can advertise an older page that does not exist

**Severity:** LOW

**Evidence level:** E4

**Status:** Confirmed - independently checked

**Rule or parameter:** “Load older” must mean that more records matching the active human filter are known to exist, not merely that unrelated city-wide records exist.

**Location:** `src/window-client.ts:340-378,884-968`; `src/window.ts:475-586,607-644`.

**User or business harm:** A human following one resident can click an offered history control, wait for a request, receive no new matching row, and watch the button disappear. The cost is small but it makes the filter and pagination feel unreliable.

**Evidence:** `historyEntry` filters the ten snapshot rows by resident, then derives `hasMore` from `historyTotal`. That total uses whole-city or place counts and never incorporates the resident filter. The first click finally sends a server-filtered request, whose real `has_more` corrects the state. Therefore any resident with fewer matching rows than the unrelated global total can receive one false-positive control even when all their matches are already loaded.

**Safe reproduction:** In a fixture, set global agreement/thing/note total above one, include the followed resident’s only matching row in the snapshot, and make the filtered history endpoint return no additional rows with `has_more:false`; the initial button still renders.

**Connection traced:** Active resident → client filters snapshot rows → global/place total is compared to filtered row count → false `hasMore:true` → click sends proper resident query → empty truthful response → control disappears.

**Root cause:** The initial pagination state combines a filtered collection with an unfiltered aggregate because the snapshot carries no filtered count or authoritative filtered page state.

**Connections and similar locations checked:** Notes, things, and agreements all use the helper and can be affected; place-only counts are more accurate for notes/things. Happenings intentionally pages a global event stream and then client-filters it, which is a wider concern already dominated by UNS-001. Once a filtered request initializes the entry, server `has_more` is used correctly.

**Durable fix:** Make filtered paging authoritative before showing the control: return matching counts/page metadata with the snapshot, or lazily initialize the exact filtered collection and use only its `has_more` value.

**Why this is not a band-aid:** Hiding the button whenever a resident is selected would remove legitimate older history. Matching metadata fixes both false positives and false negatives.

**Pre-fix proof:** Add a unit/browser case with a high global total and exactly one resident match already in the snapshot; assert no button before any click. It fails under the current total comparison.

**Verification:** Exercise zero/one/many matches for resident-only, place-only, and combined filters across notes, things, agreements, and event paging; verify cursor transitions, retries, merge de-duplication, and counts after refresh.

**Regression and rollback risk:** Additional filtered metadata can increase query work or cache-key variation. Prefer the existing indexed filtered statements, cap page sizes, measure query plans, and make the initial-state improvement additive.

**Unknowns:** Live frequency was not measured, and the current production sample was not manipulated to force the exact edge case; the source path and independent review establish reachability.

## Questions Needing Human Review

1. Should the human window be searchable? Both the HTML and response header say `noindex, nofollow, noarchive`, while `/robots.txt` allows `/` and locked decisions call the window the whole human appeal. No search/discovery intent was found, so this remains E1 rather than a defect.
2. Does “read everything” require dedicated views for public kinds, traits, laws, transfers/offers, moderation history, and other API-visible civic records, or only completeness inside the five current views? The present product contract is not precise enough to admit the broader omission.
3. Is the window’s 32-level place-tree ceiling an intentional safety rule? Place creation and `/api/map` do not share it, so a depth-33 place would disappear from the window, but the live maximum is six and no declared limit was found.
4. Should tab/filter changes create browser-history entries? The current `replaceState` behavior makes Back return to the prior page rather than the prior window tab. That is normal for many tab interfaces and was not admitted without an explicit navigation expectation.

## Ordered Repair Plan

1. **Repair the event boundary first.** Specify public action/place semantics, emit or project stable context, support server-side place filtering before pagination, and add failing action/transfer/edit cases before implementation.
2. **Restore complete public reading.** Add moderated place descriptions and focused, credential-free full reads for truncated things, notes, and agreements; replace tests that currently require the regression.
3. **Stabilize the reader.** Persist disclosure/focus across refresh, fix contrast/focus tokens, and centralize loading/live/stale/error transitions.
4. **Make the full map scale.** Choose a compact default hierarchy, search/jump behavior, and progressive rendering while keeping every place and resident keyboard-reachable.
5. **Close pagination and release gaps.** Make filtered `has_more` authoritative, run the full verification matrix, inspect the final diff for security/credentials, then deploy with additive contracts and rollback flags.

No repair was implemented as part of this audit.

## Verification and Release Gates

1. **Event truth gate:** Place-filtered current and older Happenings must retain every applicable action and show a specific safe meaning; no client reconstruction may depend on the latest ten side records.
2. **Read-everything gate:** Every live place description and every truncated public note/thing/agreement must be completely readable through a bounded anonymous GET, with moderation and zero credential/write transmission verified.
3. **Accessibility/state gate:** WCAG AA contrast checks pass; skip/focused controls remain visible; an automatic refresh preserves expanded state and logical focus; failure/recovery copy is internally consistent.
4. **Scale gate:** At 320, 390, 768, and 1440 widths, the full map remains complete but has a bounded useful starting view, no horizontal overflow, and acceptable keyboard/search/render behavior at 218, 500, and 1,000 places.
5. **Regression/release gate:** Typecheck, unit/integration/E2E suites and at least 80% relevant coverage pass; public credential rejection, CSP, cache behavior, moderation, and read-only request logging remain intact; rollback is tested without rewriting append-only data.

The release verdict may change only after both BLOCKER gates pass. Medium and low items may be separately accepted only with named ownership, an explicit date, and preserved pre-fix tests.

## Overseer Record

**Independent skeptic:** COMPLETED

**Reviewer separation:** CONFIRMED

The skeptic ran in a fresh reviewer role after the architecture, correctness, security, and UX inspectors had returned candidates. It did not originate the admitted candidate set. It independently reopened the relevant source/live paths, upheld UNS-001 and UNS-002 as blockers, upheld the contrast, refresh-state, initial-failure, and filtered-pagination findings, and recommended `DO NOT RELEASE`.

| Candidate | Overseer disposition | Final treatment |
|---|---|---|
| Placeless/generic Happenings | Upheld as blocker | UNS-001, E4 |
| Missing descriptions/full public bodies | Upheld as blocker | UNS-002, E4 |
| Contrast and suppressed main focus outline | Upheld as medium | UNS-005, E4 |
| Refresh destroys disclosure/focus | Upheld as medium | UNS-004, E4 |
| First-load contradictory copy | Upheld as medium | UNS-006, E4 |
| False filtered “Load older” | Upheld as low | UNS-007, E4 |
| Default map at current live scale | Not part of completed main adjudication | UNS-003, E3 only |
| Browser Back between tabs | Not admitted; plausible normal tab semantics | Human question |
| Depth-32 window ceiling | Not admitted without current impact or declared intent | Human question |
| `noindex` | Not admitted without discovery intent | Human question |

The skeptic agent unexpectedly produced its own audit artifact despite a chat-only instruction. The primary auditor did not open or use that file; only the skeptic’s in-chat disposition was used here. No other audit report was read. Reviewer independence is process separation within the same model/runtime family, not external organizational independence.

## Honest Limitations

1. The in-app browser was locally blocked before navigation. Visual and behavioral evidence came from isolated Playwright Chromium and anonymous HTTP, not a real signed-in browser, Safari/Firefox, or physical device.
2. No screen reader, low-vision user panel, private telemetry, search console, production log, or database console was available. Accessibility and impact estimates therefore combine standards, deterministic browser behavior, source, and live public output.
3. Production was active during the audit: totals/events changed between samples. Every live number is timestamped, and exact deployed-asset parity ties the source trace to that point in time.
4. No authenticated route, mutation, wallet/payment action, database migration, PostgreSQL integration suite, secret file, or credential store was touched. This protects production but leaves those connected systems outside this category audit.
5. Concurrent auditors created untracked audit artifacts under `docs/audits` and one root `audit-backup.json`; their contents were not opened or altered. Temporary screenshots and Playwright output remain under the user temp directory. The primary changed no application code or configuration and intentionally added only this report.
