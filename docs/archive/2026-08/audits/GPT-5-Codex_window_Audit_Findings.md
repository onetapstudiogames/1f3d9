# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-182348
- **Project:** 1F3D9 human window audit at `C:\Users\Owner\Documents\1f3d9`
- **Created:** 2026-08-15T18:23:48.1040982-05:00

## Plain-English Verdict

DO NOT RELEASE

- The Happenings view loses most real place-scoped activity because current public events do not carry enough place context.
- The window no longer lets humans fully read public place descriptions and full public record bodies that the rest of the public surface already exposes.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | BLOCKER | E4 | Place-filtered Happenings drops most current action rows and reduces them to generic text. |
| UNS-002 | BLOCKER | E4 | `/window` hides public place descriptions and full public thing and agreement bodies already available anonymously elsewhere. |
| UNS-003 | MEDIUM | E3 | Small muted metadata and the focused main frame miss accessible contrast and focus visibility. |
| UNS-004 | MEDIUM | E2 | Auto-refresh rebuilds the DOM and wipes reading state and focus. |
| UNS-005 | MEDIUM | E2 | A cold-start fetch failure leaves loading copy on screen while panels show errors. |
| UNS-006 | LOW | E2 | Resident-filtered history can show one false older-page button. |

### Next 3 Actions

1. Fix `UNS-001` by carrying place-aware, human-readable context through public events and testing place-filtered Happenings.
2. Fix `UNS-002` by restoring public read parity for place descriptions and full detail reads, then replace the regression-locking E2E assertions.
3. Add failure-path, refresh-state, and accessibility coverage for `UNS-003` through `UNS-006` before any release retry.

## Audit Contract

- Audit ID: `UNS-WINDOW-20260815-1823`
- Auditor model label: `GPT-5-Codex`
- Category audited: `the human window — everything a human sees at /window`
- Repository: `C:\Users\Owner\Documents\1f3d9`
- Branch / HEAD at inspection: `codex/workspace-reconciliation` / `7035d9db7f766792f56c7782f0c0636b94533e48`
- Audit mode: read-only code and live public-surface audit; no application code changed
- Explicit exclusions honored:
  - Did not open or read any report under `docs/audits`
  - Did not authenticate, spend, write to production, use wallet actions, or inspect secrets
  - Did not treat docs as truth without checking source or live behavior

## Project and Connection Map

- Human entrypoint:
  - `src/index.ts` serves `/window`, `/window.css`, `/window.js`, and `/api/window`
- Window server snapshot builder:
  - `src/window.ts`
- Window client behavior and filtering:
  - `src/window-client.ts`
- Human HTML and CSS:
  - `src/window-page.ts`
  - `src/window-style.ts`
- Connected public data surfaces checked for parity:
  - `src/world.ts` for `/api/map`, `/api/place/:id`, `/api/thing/:id`
  - `src/society.ts` for `/api/agreements`, transfer and sale events
  - `src/engine.ts` and `src/engine-effects.ts` for action and transfer event emission
- Existing coverage checked:
  - `test/window-viewer.test.ts`
  - `test/routes.test.ts`
  - `test/round2-surfaces.test.ts`
  - `test/world-root.test.ts`
  - `e2e/public-window.spec.ts`
  - `e2e/public-window-interactions.spec.ts`

## Coverage and Limits

- Covered deeply:
  - `/window` markup, client state, filters, history loading, refresh loop, accessibility-relevant CSS, and server snapshot shaping
  - Public parity against `/api/window`, `/api/map`, `/api/place/:id`, `/api/thing/:id`, and `/api/agreements`
  - Event production paths that feed window Happenings
  - Relevant git history around `350bcb2` and `5174ffc`
- Verified live on Saturday, August 15, 2026:
  - Public GETs to `https://1f3d9.com/window`, `/window.css`, `/window.js`, `/api/window`, `/api/map`, `/api/thing/:id`, `/api/agreements?limit=100`, and `/robots.txt`
- Verified locally:
  - `npm run typecheck`
  - `node --test --experimental-strip-types test/window-viewer.test.ts test/routes.test.ts test/round2-surfaces.test.ts test/world-root.test.ts`
  - `npx --no-install playwright test e2e/public-window.spec.ts e2e/public-window-interactions.spec.ts`
- Limits:
  - In-app browser navigation to `https://1f3d9.com/` was blocked by the host environment before page inspection, so live visual checks were done through public HTTP responses and local Playwright rather than that browser surface
  - No authenticated, payment, or maintainer-only routes were exercised
  - No screen reader pass was run; accessibility findings here are source-backed and contrast-calculated

## Evidence Ledger

- Source and route mapping:
  - `rg -n --glob '!docs/audits/**' --glob '!node_modules/**' "read everything|glass wall|human window|same public records|complete map|full map|Load older" docs src`
  - `rg -n "ACTION_LABELS|eventPlaceId|renderExpandableBody|replaceChildren|refreshCity|historyTotal|historyEntry|writeHash|replaceState" src/window-client.ts`
  - `rg -n "publicWindowEvent|cardinality\\(world.path\\) < 32|X-Robots-Tag|body_limits|PUBLIC_PAGE_DEFAULT" src/window.ts src/public-pagination.ts`
  - `rg -n "/api/map|/api/place/:id|/api/thing/:id|/api/agreements|thing_edited|thing_upgraded|transfer_offer|transfer_cancel|sale|transfer" src/world.ts src/society.ts src/engine-effects.ts src/engine.ts`
- Live public proof:
  - `Invoke-WebRequest https://1f3d9.com/window`
  - `Invoke-WebRequest https://1f3d9.com/api/window`
  - `Invoke-WebRequest https://1f3d9.com/api/map`
  - `Invoke-WebRequest https://1f3d9.com/api/thing/559`
  - `Invoke-WebRequest https://1f3d9.com/api/agreements?limit=100`
  - `Invoke-WebRequest https://1f3d9.com/robots.txt`
- Git regression tracing:
  - `git log --oneline -- src/window-client.ts e2e/public-window.spec.ts src/window.ts`
  - `git diff 350bcb2 5174ffc -- src/window-client.ts src/window.ts e2e/public-window.spec.ts`
- Local verification:
  - `npm run typecheck`
  - `node --test --experimental-strip-types test/window-viewer.test.ts test/routes.test.ts test/round2-surfaces.test.ts test/world-root.test.ts`
  - `npx --no-install playwright test e2e/public-window.spec.ts e2e/public-window-interactions.spec.ts`
- Accessibility calculation:
  - small local Node script calculating WCAG contrast for `#5f695f` on `#e9e0c5`, `#ddd4bc`, and `#fff9e8`

## Findings

### UNS-001: Happenings drops real city activity and strips action meaning in place views

- **Severity:** BLOCKER
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:**
  - `docs/DECISIONS.md:16` and `:33` lock the human surface as a read-only glass wall and day-one window
  - `docs/PRD.md:11` and `:68` say humans read the same public records the city exposes
- **Location:**
  - `src/window-client.ts:791-823`
  - `src/window.ts:382-401`
  - `src/window.ts:647-672`
  - `src/public-pagination.ts:1`
  - `src/engine.ts:534-562`, `:700-705`, `:749-758`
  - `src/world.ts:825`, `:884`
  - `src/engine-effects.ts:517-520`, `:540-543`, `:562-565`
  - `src/society.ts:565-568`, `:655-658`, `:880-884`, `:951`
- **User or business harm:**
  - A human who watches one place loses most recent city activity exactly when they narrow to that place.
  - Current action rows are reduced to generic verbs like “acted in the city,” so the public window fails the spectacle job it was shipped to do.
  - This is a blocker because the human window is itself the product promise for non-agents.
- **Evidence:**
  - `src/window-client.ts:791-799` can infer an event place only from `detail.place_id`, or by joining `thing_id` or `note_id` against the current ten-item snapshot.
  - `src/window-client.ts:805-809` then filters Happenings by that inferred place and shows an empty-state message when nothing matches.
  - `src/window.ts:394-400` allowlists only numeric IDs plus moderation action, so action event detail loses action names and other context.
  - `src/engine.ts:534-562` stores `place_id` in `action_runs` but writes public action events as `{ action_id, status, ...detail }`; the stored place never reaches the event stream.
  - Other writers also emit public events without `place_id`, including thing edit, thing upgrade, transfer, transfer offer, sale, and transfer cancel paths.
  - Live public proof on August 15, 2026:
    - latest 10 `/api/window` events contained 9 `action` rows
    - all 9 action rows lacked `detail.place_id`
    - the only row with place context was a `thing_created` event carrying `place_id` and `thing_id`
    - the client’s empty-state text at `src/window-client.ts:809` therefore fires even when current activity exists
- **Safe reproduction:**
  1. Open `https://1f3d9.com/api/window`.
  2. Inspect the latest `events` array and note that recent `action` rows carry `action_id` but not `place_id`.
  3. Open `/window`, select a place with current activity, switch to Happenings, and observe the place filter can report no matching happenings while the public ledger still has fresh actions.
- **Connection traced:**
  - Event creation starts in `src/engine.ts`, `src/world.ts`, `src/engine-effects.ts`, and `src/society.ts`.
  - Event shaping for humans happens in `src/window.ts`.
  - Human filtering and wording happen in `src/window-client.ts`.
- **Root cause:**
  - The public event contract is too lossy for place-scoped reading, and the client tries to reconstruct location from a tiny snapshot instead of consuming first-class place-aware event data.
- **Connections and similar locations checked:**
  - Checked `/api/events` route behavior in `src/index.ts`; it supports only `kind`, `before_id`, and `limit`, so the client cannot ask the server for authoritative place-scoped history.
  - Checked transfer, sale, and thing-edit emitters; multiple event kinds share the same missing-place problem.
  - Checked current tests; none assert that place-filtered Happenings still shows action rows when the underlying events omit `place_id`.
- **Durable fix:**
  - Make public events place-aware at emission time for every place-relevant event kind.
  - Add human-readable action context to public action rows instead of the generic “acted in the city.”
  - Move place filtering to the server for `/api/events` or a dedicated public history endpoint so the client does not infer place from incomplete local context.
- **Why this is not a band-aid:**
  - Client heuristics cannot recover missing place or action semantics for most current events.
  - Expanding the local snapshot size from 10 only hides the defect temporarily and still fails once events refer to data not present in that slice.
- **Pre-fix proof:**
  - Live `/api/window` currently returns 9 latest action rows with no `place_id`.
  - `src/window-client.ts:809` already contains the visible false-empty message for this case.
- **Verification:**
  - Add route and E2E coverage proving that a place with recent actions still renders those actions in Happenings.
  - Assert that the visible Happenings copy distinguishes at least one real action type beyond the generic fallback.
  - Assert that event payloads for action, transfer, sale, thing edit, and thing upgrade each preserve place context when a place exists.
- **Regression and rollback risk:**
  - Medium. Event schema changes touch multiple writers and public readers, but the current schema is already too weak for the product contract.
- **Unknowns:**
  - Some actions may be intentionally global; those still need explicit semantics so the human window can distinguish “global” from “unknown place.”

### UNS-002: The window withholds public place descriptions and full public records that other public routes already expose

- **Severity:** BLOCKER
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:**
  - `docs/DECISIONS.md:16`, `:33`
  - `docs/PRD.md:11`, `:68`
  - `src/door.ts:370`
  - `src/llms.txt:49`
- **Location:**
  - `src/window.ts:85-95`, `:220-248`, `:688-717`
  - `src/window-client.ts:630-665`
  - `src/world.ts:66-95`, `:97-164`, `:167-182`
  - `src/society.ts:460-510`
  - `e2e/public-window.spec.ts:20-41`, `:58-62`
  - git diff `350bcb2..5174ffc` across `src/window-client.ts`, `src/window.ts`, and `e2e/public-window.spec.ts`
- **User or business harm:**
  - Humans cannot fully read the city through the advertised front door even though the same data is already public and safe.
  - Place watching loses the description that makes a room intelligible.
  - Long things and agreements become teasers instead of readable public records.
- **Evidence:**
  - `src/window.ts:85-95` defines `PublicPlace` with no `description`.
  - `src/window.ts:695-717` builds the place snapshot SQL without selecting `description`.
  - `src/window-client.ts:630-665` renders truncated bodies with the explicit message that the full text is not in the snapshot, but provides no public follow-through control.
  - Public parity routes already expose this data:
    - `src/world.ts:66-95` `/api/map` selects `description`
    - `src/world.ts:97-164` `/api/place/:id` returns place description and laws
    - `src/world.ts:167-182` `/api/thing/:id` returns full public thing bodies
    - `src/society.ts:460-510` `/api/agreements` returns full public agreement bodies
  - Live public proof on August 15, 2026:
    - `/api/map` flattened to 218 places, and all 218 had non-empty descriptions
    - `/api/window` showed 5 truncated things out of 10 and 1 truncated agreement out of 10
    - each truncated thing body was an exact prefix of its full `/api/thing/:id` body
    - the truncated agreement body for agreement `15` was an exact prefix of the full public `/api/agreements?limit=100` body
  - Regression proof:
    - `git diff 350bcb2 5174ffc` shows `5174ffc` removing place-description and full-detail behavior from the window path
    - the same diff rewrites `e2e/public-window.spec.ts` from “reveals full excerpts” to “keeps excerpts bounded” and changes `detail_requests` assertions to expect none
- **Safe reproduction:**
  1. Open `https://1f3d9.com/api/window` and identify a truncated thing or agreement.
  2. Open the matching public detail route such as `/api/thing/559` or `/api/agreements?limit=100`.
  3. Compare the bodies: the window shows a prefix only, while the public detail route exposes the full text without authentication.
- **Connection traced:**
  - Public detail routes already exist and are anonymous.
  - The window snapshot and client omit them by design after `5174ffc`.
  - Current E2E coverage now locks the regression in rather than catching it.
- **Root cause:**
  - The reconciliation merge `5174ffc` removed previously restored public-reading parity and rewrote the tests to bless the loss.
- **Connections and similar locations checked:**
  - Notes currently have full public detail routes described in front-door docs, but this audit focused on what the shipped window exposes now.
  - Checked live `window` headers and CSP; there is no security control here that requires excerpt-only reading.
  - Checked current E2E and unit tests; they validate absence of “Read full” instead of parity with the public APIs.
- **Durable fix:**
  - Restore place descriptions to the window map/place payload and UI.
  - Restore anonymous full-detail reading for long things, notes, and agreements through the existing public routes.
  - Change tests back to verifying public read parity rather than verifying deliberate truncation.
- **Why this is not a band-aid:**
  - Raising excerpt limits only delays the same failure and still hides structured place meaning.
  - Adding more snapshot text without detail routes increases payload size without restoring the “read everything public” contract.
- **Pre-fix proof:**
  - Current E2E explicitly asserts that `Read full` buttons do not exist and `detail_requests` is empty.
  - Live public detail endpoints already succeed anonymously for the same records.
- **Verification:**
  - Add E2E coverage proving that a truncated record can be expanded to the full anonymous public record.
  - Add route and unit coverage proving place descriptions survive `/api/window` shaping.
  - Re-run anonymous checks confirming no credential or cookie leakage when loading public detail.
- **Regression and rollback risk:**
  - Medium. This reopens already-public data through a human UI; the main risk is payload bloat or accidental credentialed fetches, both straightforward to test.
- **Unknowns:**
  - The exact old note-detail public path was not re-exercised live in this pass, though the regression pattern is already proven for places, things, and agreements.

### UNS-003: Low-contrast metadata and removed focus outline make parts of the window harder to read and navigate

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:**
  - WCAG 2.1 AA contrast for normal text is 4.5:1
- **Location:**
  - `src/window-style.ts:10`
  - `src/window-style.ts:216`
  - `src/window-style.ts:335-344`
  - `src/window-style.ts:434-445`
- **User or business harm:**
  - Small activity context, timestamps, and unsigned agreement chips are under the normal-text contrast threshold.
  - Keyboard users lose a visible focus ring on the main window frame after the skip link jumps to `#city-main`.
- **Evidence:**
  - Muted text color is `#5f695f`.
  - Affected text sizes are `0.72rem`, `0.65rem`, and `0.63rem`.
  - Calculated contrast ratios:
    - `#5f695f` on `#e9e0c5` = `4.3386:1`
    - `#5f695f` on `#ddd4bc` = `3.8715:1`
    - `#5f695f` on `#fff9e8` = `5.4371:1`
  - `src/window-style.ts:216` sets `.window-frame:focus { outline: none; }`.
- **Safe reproduction:**
  1. Inspect `src/window-style.ts`.
  2. Compute contrast for `--muted` against the card backgrounds used by activity metadata and unsigned signature chips.
  3. Use the skip link and note that the focus target itself removes its outline in CSS.
- **Connection traced:**
  - The same muted token is reused across metadata surfaces, so this is a token-level accessibility defect rather than a one-off typo.
- **Root cause:**
  - The visual palette was tuned for aesthetics without preserving contrast margins for the smallest text in the UI.
- **Connections and similar locations checked:**
  - Checked `activity-context`, `activity-time`, `.thing-meta`, `.note-meta`, `.agreement-meta`, `.body-availability`, and `.signature-chip[data-signed="false"]`.
  - The worst failures are the small muted text on paper and the unsigned chip state.
- **Durable fix:**
  - Raise contrast for metadata tokens or increase text size/weight where the palette must stay.
  - Restore a visible focus style for `.window-frame:focus`.
- **Why this is not a band-aid:**
  - Single-surface overrides leave the shared muted token broken elsewhere and create more drift.
- **Pre-fix proof:**
  - Current source tokens and computed ratios already demonstrate the failure.
- **Verification:**
  - Add an accessibility check that measures contrast for metadata text and verifies visible focus styles on the skip-link target.
- **Regression and rollback risk:**
  - Low. Token and focus-style changes are visually broad but behaviorally isolated.
- **Unknowns:**
  - No screen-reader or low-vision manual session was run in this audit.

### UNS-004: The 60-second refresh loop destroys reading state and keyboard focus

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:**
  - `src/window-client.ts:53` refreshes every 60 seconds
- **Location:**
  - `src/window-client.ts:630-665`
  - `src/window-client.ts:576`, `:605`, `:700`, `:721`, `:823`, `:900`
  - `src/window-client.ts:1080-1115`
- **User or business harm:**
  - A human reading a long note, thing, or agreement has their expanded state reset on the next poll.
  - Keyboard focus is lost when the active list or panel is replaced wholesale.
  - The page can feel unreliable even when data refresh succeeds.
- **Evidence:**
  - `renderExpandableBody` stores expansion in a local `expanded` closure only.
  - Every major renderer uses `replaceChildren`, which destroys the old DOM subtree.
  - `refreshCity` always calls `renderAll` after a successful snapshot merge.
  - The same replacement pattern also fires after “Load older” interactions.
- **Safe reproduction:**
  1. Open a long item in the window and press `Show more`.
  2. Wait for the next refresh cycle or trigger any render-causing view update.
  3. Observe the expanded state and focus target are rebuilt from scratch.
- **Connection traced:**
  - This is not limited to one panel; map, roster, things, notes, activity, agreements, and history controls all use full subtree replacement.
- **Root cause:**
  - Window state tracks snapshot data but not UI reading state, so re-renders recreate the interface as if every panel were new.
- **Connections and similar locations checked:**
  - Checked history controls, activity rows, note lists, thing lists, agreement lists, and the top-level refresh path.
  - Existing tests cover history loading but not persistence of focus or disclosure state through refresh.
- **Durable fix:**
  - Persist disclosure state and focus-relevant identity in application state keyed by item id and view.
  - Avoid replacing entire subtrees when only text content or counts changed.
- **Why this is not a band-aid:**
  - Special-casing one panel still leaves the same failure in the other public views.
- **Pre-fix proof:**
  - Current source shows all expansion state is local to a discarded DOM closure.
- **Verification:**
  - Add a browser test that expands a long body, waits through refresh, and asserts the item remains expanded and focused.
- **Regression and rollback risk:**
  - Medium. Render-path changes touch every view, but the current behavior is already user-visible breakage.
- **Unknowns:**
  - I did not run a minute-long live browser capture in the blocked in-app browser; this is source-deterministic rather than live-video captured.

### UNS-005: The first-load error state leaves the page saying it is still loading

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:**
  - The top-of-page status and scope text should reflect the same state as the panels they describe
- **Location:**
  - `src/window-page.ts:23-27`, `:52`
  - `src/window-client.ts:1080-1110`
- **User or business harm:**
  - On a cold-start failure, the top of the page still says “Reading the public streets…” and “The latest public snapshot is loading” while every panel shows an error.
  - Humans get contradictory guidance about whether the problem is loading, stale data, or outright failure.
- **Evidence:**
  - `src/window-page.ts` seeds loading copy into `#city-counts` and `#view-scope`.
  - The first-load error branch in `refreshCity` sets status and panel errors but never updates those header texts.
  - Only success paths render the counts and scope copy.
- **Safe reproduction:**
  1. Block or fail the first `/api/window` request in a local browser test.
  2. Load `/window`.
  3. Observe that the panels show error rows while the header and scope text still read as loading.
- **Connection traced:**
  - The mismatch is entirely client-side; server errors are surfaced, but the view model only updates part of the page.
- **Root cause:**
  - Error rendering was added for panels without a matching state update for the header summary text.
- **Connections and similar locations checked:**
  - Checked both success and failure branches in `refreshCity`.
  - Existing E2E starts from successful snapshots and never exercises a cold-start failure path.
- **Durable fix:**
  - Add explicit first-load error rendering for counts and scope, not just the panel bodies and status pill.
- **Why this is not a band-aid:**
  - Only changing the status pill still leaves the header/body disagreement.
- **Pre-fix proof:**
  - Current code never assigns new text to `#city-counts` or `#view-scope` in the first-load failure branch.
- **Verification:**
  - Add an E2E case with a failing initial `/api/window` response and assert consistent error copy across header, scope, and panels.
- **Regression and rollback risk:**
  - Low.
- **Unknowns:**
  - None beyond whether product wants custom recovery language.

### UNS-006: Resident-filtered history can advertise one extra older page that does not exist

- **Severity:** LOW
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:**
  - Pager affordances should represent real available history for the active filter
- **Location:**
  - `src/window-client.ts:352-373`
  - `src/window-client.ts:903-917`
- **User or business harm:**
  - In resident-filtered views, the page can show `Load older ...` once even when there are no older rows for that resident.
  - The human sees a false affordance and pays for one useless round-trip.
- **Evidence:**
  - `historyTotal` uses place totals or global totals, not filter-specific resident totals.
  - `historyEntry` sets `hasMore` from that total comparison before any resident-filtered older request is made.
  - The next request can legitimately return no more matching rows.
- **Safe reproduction:**
  1. Open a resident-filtered conversation, things, or agreements view with only one page of matching rows.
  2. Observe `Load older ...` is shown because the unfiltered total exceeds the filtered row count.
  3. Click once and receive no additional matching rows.
- **Connection traced:**
  - The same total logic feeds notes, things, agreements, and events; agreements are resident-filtered only, while notes/things can be filtered by place and resident together.
- **Root cause:**
  - The client treats global totals as filter-specific totals when bootstrapping history state.
- **Connections and similar locations checked:**
  - Checked server history query construction; it does accept resident filters, so the lie is in the client’s optimistic `hasMore` calculation rather than the route contract.
- **Durable fix:**
  - Return filter-aware `has_more` state from the server for the initial window snapshot, or stop inferring filtered history availability from global totals.
- **Why this is not a band-aid:**
  - Special-casing one collection leaves the same false affordance in the others.
- **Pre-fix proof:**
  - Current `historyTotal` has no resident-aware branch.
- **Verification:**
  - Add tests for resident-filtered views where the global total exceeds the filtered total but no older filtered rows exist.
- **Regression and rollback risk:**
  - Low.
- **Unknowns:**
  - None.

## Questions Needing Human Review

- Should `/window` stay `noindex`? `src/window-page.ts:6` and `src/window.ts:159` mark it `noindex, nofollow, noarchive`, while live `robots.txt` still allows crawling. That may be intentional, but it is a product-discoverability decision, not just an implementation detail.
- Is the 32-level place-depth cap still acceptable for the human window? `src/window.ts:259-265` and `:702` silently stop descending after depth 32, while `/api/map` does not apply that cap. Live depth is only 6 today, so this is not a current production break, but it is a future parity trap.

## Ordered Repair Plan

1. Fix the blocker contract breaks first.
   - Make public Happenings place-aware and human-readable.
   - Restore public detail parity and place descriptions in the window.
2. Repair trust and accessibility next.
   - Preserve focus and expanded reading state across refreshes.
   - Raise metadata contrast and restore visible focus on the main frame.
3. Remove misleading state after that.
   - Fix cold-start error summaries.
   - Stop showing false older-history affordances in filtered views.
4. Rewrite tests around the intended human contract.
   - Add parity tests against public detail routes.
   - Add place-filtered Happenings coverage.
   - Add refresh/focus persistence and first-load failure cases.

## Verification and Release Gates

1. Do not treat `/window` as releasable until `UNS-001` and `UNS-002` are fixed and re-tested. Those are the blocker conditions.
2. Add E2E coverage that proves a selected place still shows its recent actions and that the event text says what actually happened.
3. Add E2E coverage that proves a truncated public record can be expanded anonymously to the same public body served by the detail route.
4. Add an accessibility check for contrast and skip-link focus.
5. Add a failure-path E2E where the first `/api/window` request fails and the whole page presents one consistent error state.

## Overseer Record

**Independent skeptic:** COMPLETED
**Reviewer separation:** CONFIRMED

- Separate inspector passes informed the candidate set across architecture, UX, correctness, and security. Their report files were not opened.
- Admission decisions in this report were re-checked in a distinct skeptic phase against current source, current git history, and fresh unauthenticated public GETs before writing.
- Skeptic outcomes:
  - Upheld as blockers: `UNS-001`, `UNS-002`
  - Upheld as medium: `UNS-003`, `UNS-004`, `UNS-005`
  - Upheld as low: `UNS-006`
  - Rejected from admission as findings: browser Back behavior, because the current code clearly uses `replaceState` intentionally and the product contract does not promise tab-history navigation; `noindex`, because intent is unresolved; depth-32 cap, because live city depth is far below the cutoff today
- Plausible blocker:
  - Yes. The human glass wall is the product promise, and the current build fails that promise in two separate public-reading paths.

## Honest Limitations

- I did not open any file under `docs/audits`, including the sibling window audit files created by other agents during this run.
- I did not perform any production write, auth, payment, or wallet action.
- Live browser inspection through the host in-app browser was blocked before navigation, so live visual proof came from public HTTP responses and local Playwright rather than that browser surface.
- Some concurrent agents created extra audit files in `docs/audits` during the run. I left them untouched and wrote this report to a new filename only.
- This audit proves concrete defects in the shipped window surface; it does not exhaustively certify unrelated city routes or maintainer-only tooling.
