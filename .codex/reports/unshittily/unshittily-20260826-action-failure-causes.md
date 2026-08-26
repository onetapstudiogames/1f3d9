# Unshittily Work Receipt

- **Task ID:** UNSLY-20260826-ACTION-FAILURE-CAUSES-CITY
- **Project:** 1F3D9 at `C:\Users\Owner\Documents\1f3d9`
- **Created:** 2026-08-26T11:30:00Z

## Plain-English Outcome

**Outcome:** COMPLETE - CHECKED AND INDEPENDENTLY APPROVED

Every reachable failed city action now publishes a caller-facing cause. The cause is retained by the raw JSON action response, ordinary and hosted MCP results, public action records, delayed-effect notices, and the read-only human window. The two issue #101 shapes are pinned as regressions, and genuinely kindless owned use remains an honest `noop` without an invented error.

## Execution Contract

- **Requested task:** Diagnose the silent failed-use specimens, sweep every city action verb for the same class, preserve causes through every public door, update response contracts, verify the full suite, and prepare one unmerged pull request.
- **Non-goals:** Post in the city, mutate production records, spend money, merge or deploy the pull request, fix adjacent defects, or change successful/no-op semantics.
- **External effects authorized:** Read-only production inspection of public things and action history; later push one branch and open one unmerged pull request. No city write or payment was authorized or performed.

## Baseline and Protected Work

- **Pre-existing work:** The branch began from the repository's existing source and the newly merged human-window work. Baseline hashes and timestamps were recorded before edits; unrelated files and the pre-existing Playwright artifact were preserved exactly.
- **Declared files:** `docs/SYSTEM_DESIGN.md`, `docs/published/FRONTDOOR.md`, `e2e/public-window-interactions.spec.ts`, `src/actions.ts`, `src/door.ts`, `src/engine-effects.ts`, `src/engine.ts`, `src/frontdoor.txt`, `src/llms.txt`, `src/mcp.ts`, `src/window-client.ts`, `src/window.ts`, `test/engine.test.ts`, `test/integration/engine-timer-postgres.test.ts`, `test/mcp-auth.test.ts`, `test/routes.test.ts`, `test/window-viewer.test.ts`
- **Protected areas:** Database schema and migrations, authentication and wallet configuration, unrelated city behavior, production state, sibling-market source, and all paths outside the declared set.

## Impact and Connection Map

An action enters through JSON or MCP, is evaluated by the city engine, may produce immediate or stored effects, is recorded as an action/event/change, and can then be read through JSON, MCP, or the human window. The repaired contract follows that whole path. Rule refusals identify the unmet recipe condition, blocking law and source, ownership/access rule, or missing target. Unexpected engine failures are explicitly internal and remain distinct from caller-correctable refusals. Delayed effects retain the same cause and provenance when they later fail.

## Design and Root Cause

- **Root cause addressed:** YES
- **Why durable:** The evaluator and effect boundary now create one explicit failure cause at the point that knows it, and the shared action projection retains it instead of dropping the event error from the nested `action`. Stored effects carry both the cause and the correct law/thing provenance. Legacy law lookup accepts only the latest applicable `add` at or before block creation, so later adoption or earlier removal cannot be misattributed.
- **Similar paths checked:** `use`, movement, creation, transfer/give, consume, go-home, speech/note, agreement/signing, laws, founding/payment, immediate effects, delayed effects, collision/refusal paths, API projection, both MCP doors, public events/changes, and the human window.

## Acceptance Checks

### AC-001: The two reported failed uses name their actual cause

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-002

### AC-002: Every reachable failed city verb names a caller-facing cause

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-004

### AC-003: Causes survive JSON, MCP, stored effects, public records, and the human window

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-007

### AC-004: Honest non-failure statuses remain distinct

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-004

### AC-005: Published contracts and generated mirrors match runtime behavior

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-008

### AC-006: The final source is green and independently approved

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-009

## Changes Made

### CHG-001: Preserve evaluator causes and provenance

- **Paths:** `src/actions.ts`, `src/engine-effects.ts`, `src/engine.ts`
- **Requirement:** AC-001, AC-002, AC-004
- **Why:** These are the shared boundaries that know whether a recipe requirement, access rule, law, target, collision, stored effect, or internal operation caused failure.

### CHG-002: Carry and render the cause through every door

- **Paths:** `src/mcp.ts`, `src/window-client.ts`, `src/window.ts`
- **Requirement:** AC-003
- **Why:** A correct evaluator result is still silent if a public projection, MCP translation, or human renderer drops it.

### CHG-003: Publish the response contract on every maintained mirror

- **Paths:** `docs/SYSTEM_DESIGN.md`, `docs/published/FRONTDOOR.md`, `src/door.ts`, `src/frontdoor.txt`, `src/llms.txt`
- **Requirement:** AC-005
- **Why:** Callers must know before acting that a failed action includes its cause and how rule-based and internal failures differ.

### CHG-004: Pin the defect class and both live specimens

- **Paths:** `e2e/public-window-interactions.spec.ts`, `test/engine.test.ts`, `test/integration/engine-timer-postgres.test.ts`, `test/mcp-auth.test.ts`, `test/routes.test.ts`, `test/window-viewer.test.ts`
- **Requirement:** AC-001, AC-002, AC-003, AC-004, AC-006
- **Why:** Tests cover every exposed verb, immediate and delayed provenance, both reported use shapes, kindless no-op control behavior, every translation door, safe rendering, and real PostgreSQL timer behavior.

## Pre-Change Proof

- **Method:** FAILING TEST
- **Observed before implementation:** Public history for actions `45555` and `45429` already contained `error: "thing_id is not yours"`, while each raw nested action exposed only `status: "failed"` and `effects_applied: 0`. New regression tests failed because the nested action, MCP result, and human projection omitted the cause. Additional red tests exposed missing law/source and stored-effect provenance.
- **Observed after implementation:** Both reported shapes return failed actions whose nested `error` is `thing_id is not yours`; the owned kindless control remains `noop` with no error. The class sweep returns specific rule, law/source, target, or internal causes across all action verbs and doors.

## Anti-Band-Aid Gate

- **Tests weakened:** NO
- **Errors hidden:** NO
- **Silent fallback added:** NO
- **Hardcoded workaround added:** NO
- **Duplicate rule added:** NO
- **Permission or security loosened:** NO
- **Unnecessary dependency added:** NO
- **Suppression or skip added:** NO
- **Old implementation left active:** NO

## Verification Evidence

### EVD-001: Read-only production reproduction

- **Check:** Public GET inspection of things `1183`, `1485`, and control thing `1598`, plus action/event records `45555`/`57055` and `45429`/`56928` on `https://1f3d9.com`
- **Working folder:** `C:\Users\Owner\Documents\1f3d9`
- **Exit code:** 0
- **Result:** MANUAL
- **Important output:** Things 1183 and 1485 were kindless, closed to shared use, and owned by other residents; both failed action records already stored `thing_id is not yours`. Control thing 1598 was kindless and open to use. Only public reads were made.
- **Side effects:** NONE

### EVD-002: Focused failure-contract regressions

- **Check:** Focused Node tests for engine, route, MCP, timer provenance, and window failure cases
- **Working folder:** `C:\Users\Owner\Documents\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 154/154 focused engine/MCP/window tests, 159/159 route tests, and the isolated real-PostgreSQL timer/provenance case passed. The reported fixtures are colocated, kindless, closed-to-shared-use things and retain `thing_id is not yours`.
- **Side effects:** Local test database transactions only; no production writes.

### EVD-003: TypeScript typecheck

- **Check:** `npm run typecheck`
- **Working folder:** `C:\Users\Owner\Documents\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** TypeScript completed without diagnostics.
- **Side effects:** NONE

### EVD-004: Full local test suite

- **Check:** `npm test`
- **Working folder:** `C:\Users\Owner\Documents\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 1,086/1,086 tests passed.
- **Side effects:** Local test processes only.

### EVD-005: Coverage gate

- **Check:** `npm run test:coverage`
- **Working folder:** `C:\Users\Owner\Documents\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** All configured statement, branch, function, and line thresholds of at least 80% passed.
- **Side effects:** Temporary local coverage artifacts; none retained in the final guarded state.

### EVD-006: PostgreSQL integration suite

- **Check:** `npm run test:postgres`
- **Working folder:** `C:\Users\Owner\Documents\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** Final sequential run passed 162/162. An earlier run executed concurrently with browser tests and one unchanged deadline assertion failed at 2,815 ms; its immediate isolated retry passed 1/1 in 174 ms, then the full sequential suite passed.
- **Side effects:** Test-schema/database work only; no production records changed.

### EVD-007: Human-window browser suite

- **Check:** `npm run test:e2e`
- **Working folder:** `C:\Users\Owner\Documents\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 77/77 Playwright tests passed, including safe failure-cause rendering.
- **Side effects:** Generated Playwright state was restored to its exact pre-run baseline.

### EVD-008: Mirrors and diff integrity

- **Check:** `node scripts/embed-door.mjs`, generated-mirror assertions in `npm test`, and `git diff --check`
- **Working folder:** `C:\Users\Owner\Documents\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** Generated `src/door.ts` and published front-door content match their source contracts; the diff has no whitespace errors.
- **Side effects:** Only the declared generated mirror was refreshed.

### EVD-009: Independent final review

- **Check:** Fresh read-only overseer review of sealed source digest `5648a23a42391b357d057f8c1851002f1f8ac4d5f4571d00ec37655a7f4eb183`
- **Working folder:** `C:\Users\Owner\Documents\1f3d9`
- **Exit code:** NOT APPLICABLE
- **Result:** MANUAL
- **Important output:** APPROVED with 0 blockers, 0 Critical, 0 High, and 0 Medium findings; reviewer independently reran typecheck, focused tests, routes, PostgreSQL provenance, the full suite, diff checks, and guard digest.
- **Side effects:** NONE

## Reviewer Findings

- **Specialist review:** COMPLETED
- **Specialist reviewed state digest:** 5648a23a42391b357d057f8c1851002f1f8ac4d5f4571d00ec37655a7f4eb183
- **Blockers remaining:** 0
- **High issues remaining:** 0
- **Other issues:** NONE

## Overseer Decision

- **Fresh overseer:** COMPLETED
- **Reviewer separation:** CONFIRMED
- **Decision:** APPROVED
- **Overseen state digest:** 5648a23a42391b357d057f8c1851002f1f8ac4d5f4571d00ec37655a7f4eb183

## Change Guard Result

- **Result:** ONLY CLAIMED END-STATE CHANGES DETECTED
- **Final state digest:** 5648a23a42391b357d057f8c1851002f1f8ac4d5f4571d00ec37655a7f4eb183
- **Verification state digest:** 5648a23a42391b357d057f8c1851002f1f8ac4d5f4571d00ec37655a7f4eb183
- **Unexpected paths:** NONE
- **Changed after seal:** NONE

## Remaining Limits

The repaired response is not yet live because the pull request is intentionally unmerged. The clean pushed-branch release gate, GitHub checks, and passive preview verification happen after this receipt is committed; production verification must wait for an owner-approved merge. The only live work in this run was read-only diagnosis of the old behavior.

## Rollback and Handoff

Keep the pull request unmerged for review. Reverting its eventual single implementation commit removes this change without a data migration. After an owner merges it, verify a safe failed action on the deployed site through raw JSON and confirm its cause appears in MCP and the human window; do not replay either reporter's production action.
