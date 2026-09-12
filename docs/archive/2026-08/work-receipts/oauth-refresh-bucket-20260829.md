# Unshittily Work Receipt

- **Task ID:** UNSLY-20260829-OAUTH-BUCKET
- **Project:** 1F3D9 at `C:\Users\Owner\.codex\worktrees\oauth-refresh-bucket-20260829\1f3d9`
- **Created:** 2026-08-29T13:27:01.6673158-05:00

## Plain-English Outcome

**Outcome:** COMPLETE - CHECKED AND INDEPENDENTLY APPROVED

The isolated branch implementation is complete and ready for its release steps. Each live
connector connection now has its own refresh allowance, junk requests cannot spend that
allowance, and throttling says to wait and retry. The separate duplicate-renewal change was
not included. Commit, release-gate, preview, merge, and Production checks follow this local
guarded receipt and are not claimed here as already complete.

## Execution Contract

- **Requested task:** Ship the resident-unblocking OAuth refresh bucket fix alone: one allowance per connector connection, separate junk capacity, and an honest wait-and-retry throttle response.
- **Non-goals:** Redesign duplicate renewal, refresh replay, or family revocation; change authorization-code limits, token lifetimes, credentials, unrelated rate limits, or database schema.
- **External effects authorized:** Commit and push `codex/fix-oauth-refresh-bucket`; open, verify, and merge its own GitHub pull request; allow the linked Vercel Preview and Production deployments; perform bounded release and live verification. No database migration or manual folder deployment.

## Baseline and Protected Work

- **Pre-existing work:** The branch and isolated worktree started from current `origin/main` commit `29d8a4b0779397ca7033a2b3ff9cf1a6783a3a56`. The shared checkout and the other Codex's completed work were not edited.
- **Declared files:** `CLAUDE.md`, `docs/DECISIONS.md`, `docs/SYSTEM_DESIGN.md`, `docs/features/HOSTED_CHAT_SIGNIN.md`, `docs/published/FRONTDOOR.md`, `src/door.ts`, `src/frontdoor.txt`, `src/llms.txt`, `src/oauth-store.ts`, `src/oauth.ts`, `test/help-text.test.ts`, `test/integration/oauth-postgres.test.ts`, `test/oauth-flow.test.ts`, `test/oauth-register-limits.test.ts`
- **Protected areas:** Every other project path, the shared checkout, resident credentials, provider settings, Production data, payment behavior, and the later duplicate-renewal change.

## Impact and Connection Map

`POST /oauth/token` now classifies a refresh request before choosing its allowance. A live
token family uses a private connection bucket. Malformed, unknown, expired, revoked, and
post-revocation requests use a separate network junk bucket and stop before rotation work.
The first replay of a used token still reaches the existing atomic family-revocation path
once. PostgreSQL remains the clock and counter authority. Caller-facing OAuth and city help
mirrors now describe the same `429`, `Retry-After`, and wait-and-retry contract. No schema,
payment path, resident key, or token lifetime changes.

## Design and Root Cause

- **Root cause addressed:** YES
- **Why durable:** Refresh capacity is selected only after the server knows whether the request belongs to a live connection. The private family identifier scopes real capacity, junk has separate capacity, and the same database statement returns both the admission decision and truthful seconds remaining in the UTC-hour window.
- **Similar paths checked:** Malformed tokens, token-shaped unknown tokens, wrong client/resource, expired or revoked families, two live families behind one shared client, first replay, post-revocation replay, authorization-code exchange, retention cleanup, source/generated/published front-door text, compact machine text, system design, and hosted sign-in design.

## Acceptance Checks

### AC-001: Two resident connections do not consume one shared refresh allowance

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-002

### AC-002: Junk requests cannot consume a live connection's allowance or repeatedly reach rotation work

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-002

### AC-003: A full allowance returns an honest wait-and-retry response with matching database timing

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-002

### AC-004: Existing first-replay family revocation stays unchanged for the later duplicate-renewal change

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-002

### AC-005: Every current caller-facing contract mirror describes the same behavior

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-008

### AC-006: The contained change is type-safe, broadly tested, secure, hygienic, and independently approved

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-011

## Changes Made

### CHG-001: Route refresh attempts to connection or junk capacity and return truthful retry timing

- **Paths:** `src/oauth-store.ts`, `src/oauth.ts`
- **Requirement:** AC-001, AC-002, AC-003, AC-004
- **Why:** The old route charged a shared client/network counter before it knew which resident connection, if any, owned the request, and mapped exhaustion to an invalid login.

### CHG-002: Prove the bucket split, retry response, replay boundary, and real PostgreSQL behavior

- **Paths:** `test/help-text.test.ts`, `test/integration/oauth-postgres.test.ts`, `test/oauth-flow.test.ts`, `test/oauth-register-limits.test.ts`
- **Requirement:** AC-001, AC-002, AC-003, AC-004, AC-005, AC-006
- **Why:** The regression needs route-level, store-level, retention, generated-text, and fake-store proof without weakening existing replay tests.

### CHG-003: Publish the resident-visible refresh contract everywhere it is read

- **Paths:** `CLAUDE.md`, `docs/DECISIONS.md`, `docs/SYSTEM_DESIGN.md`, `docs/features/HOSTED_CHAT_SIGNIN.md`, `docs/published/FRONTDOOR.md`, `src/door.ts`, `src/frontdoor.txt`, `src/llms.txt`
- **Requirement:** AC-003, AC-005
- **Why:** Residents and agents must know before failure that refresh capacity is per connection, junk is separate, and throttling means wait rather than re-linking an invalid login.

## Pre-Change Proof

- **Method:** FAILING TEST
- **Observed before implementation:** The new route regressions failed against the original source: a second live family behind the same client received `400` instead of `200`; a valid refresh after junk traffic received `400` instead of `200`; and exhausted capacity returned `400 invalid_grant` instead of `429` with retry guidance.
- **Observed after implementation:** The focused route regressions passed, followed by the full unit suite and real PostgreSQL OAuth integration file.

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

### EVD-001: Red-to-green route proof

- **Check:** Run the new focused `test/oauth-flow.test.ts` refresh-bucket cases against the original source, then against the implemented source.
- **Working folder:** `C:\Users\Owner\AppData\Local\Temp\1f3d9-oauth-bucket-test-harness-29d8a4b\project`
- **Exit code:** NOT APPLICABLE
- **Result:** MANUAL
- **Important output:** Before: three expected behavior mismatches (`400` versus `200`, `400` versus `200`, and `400` versus `429`). After: all four focused final refresh-bucket/replay cases passed.
- **Side effects:** Disposable test-harness files outside the repository.

### EVD-002: Final OAuth route and documentation tests

- **Check:** `npm test`
- **Working folder:** `C:\Users\Owner\AppData\Local\Temp\1f3d9-oauth-bucket-test-harness-29d8a4b\project`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 1,572 passed; 0 failed, skipped, or todo, including the connection split, junk isolation, `429` response, replay boundary, retention statement, and contract-mirror assertions.
- **Side effects:** Isolated temporary test files cleaned by the project runner.

### EVD-003: Final full unit suite

- **Check:** `$env:NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'; npm test`
- **Working folder:** `C:\Users\Owner\AppData\Local\Temp\1f3d9-oauth-bucket-test-harness-29d8a4b\project`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 1,572 passed; 0 failed, skipped, or todo.
- **Side effects:** Isolated temporary test files cleaned by the project runner.

### EVD-004: Final typecheck

- **Check:** `$env:NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'; npm run typecheck`
- **Working folder:** `C:\Users\Owner\AppData\Local\Temp\1f3d9-oauth-bucket-test-harness-29d8a4b\project`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** `tsc --noEmit` completed without diagnostics on the sealed source state.
- **Side effects:** NONE

### EVD-005: Real PostgreSQL OAuth integration

- **Check:** `$env:NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'; node --test --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks test/integration/oauth-postgres.test.ts`
- **Working folder:** `C:\Users\Owner\AppData\Local\Temp\1f3d9-oauth-bucket-test-harness-29d8a4b\project`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 29/29 passed against disposable real PostgreSQL, including classification, stable private family key, admission boundary, retry timing, reuse revocation, and retention.
- **Side effects:** Disposable Docker-backed PostgreSQL created and cleaned by the test harness.

### EVD-006: Coverage gate

- **Check:** Direct `c8` equivalent of `npm run test:coverage` with project includes and 80% line, branch, function, and statement thresholds.
- **Working folder:** `C:\Users\Owner\AppData\Local\Temp\1f3d9-oauth-bucket-test-harness-29d8a4b\project`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** Overall 92.04% statements/lines, 81.59% branches, and 92.39% functions; `src/oauth.ts` 91.50% statements, 83.55% branches, and 96.29% functions.
- **Side effects:** Coverage output written only to `C:\Users\Owner\AppData\Local\Temp\1f3d9-oauth-bucket-coverage-29d8a4b`.

### EVD-007: Dependency audit

- **Check:** `npm audit`
- **Working folder:** `C:\Users\Owner\AppData\Local\Temp\1f3d9-oauth-bucket-test-harness-29d8a4b\project`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 0 vulnerabilities.
- **Side effects:** Read-only registry request.

### EVD-008: Generated mirrors and diff hygiene

- **Check:** `node scripts/embed-door.mjs`; `git diff --check`; help-text assertions within `npm test`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-refresh-bucket-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** Generated `src/door.ts` and `docs/published/FRONTDOOR.md` match their sources; all seven help mirrors passed; no whitespace errors; no stale retry helper remained.
- **Side effects:** Generator rewrote only the two declared generated mirrors with identical final content.

### EVD-009: Independent correctness, security, and final oversight

- **Check:** Read-only review of sealed digest `5758b6e786cdb632ed6c667e90fcf8f732fa5d80655c093a917472cd405b9449` by separate correctness and security specialists plus a fresh final overseer.
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-refresh-bucket-20260829\1f3d9`
- **Exit code:** NOT APPLICABLE
- **Result:** MANUAL
- **Important output:** Correctness PASS; security PASS; fresh overseer APPROVE; 0 blocker, high, or medium findings. The prior two-statement UTC-hour race was confirmed resolved, and the change was judged contained enough for its own PR today.
- **Side effects:** NONE; all reviewers were read-only.

### EVD-010: Change guard reconciliation

- **Check:** `change_guard.py finish` using the recorded baseline manifest, claims ledger, and this receipt path.
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-refresh-bucket-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** Only all 14 declared product files and this receipt changed; no unexpected, unsealed, post-seal, Git-head, branch, or index changes; final digest `5758b6e786cdb632ed6c667e90fcf8f732fa5d80655c093a917472cd405b9449`.
- **Side effects:** NONE

### EVD-011: Complete local verification bundle

- **Check:** Review EVD-003 through EVD-010 together on the same sealed digest.
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-refresh-bucket-20260829\1f3d9`
- **Exit code:** NOT APPLICABLE
- **Result:** MANUAL
- **Important output:** Typecheck, 1,572-unit-test suite, 29-test real PostgreSQL OAuth file, 80% coverage gate, dependency audit, generated-mirror check, diff hygiene, specialist reviews, fresh oversight, and change guard all passed on digest `5758b6e786cdb632ed6c667e90fcf8f732fa5d80655c093a917472cd405b9449`.
- **Side effects:** NONE beyond the individually recorded evidence.

## Reviewer Findings

- **Specialist review:** COMPLETED
- **Specialist reviewed state digest:** 5758b6e786cdb632ed6c667e90fcf8f732fa5d80655c093a917472cd405b9449
- **Blockers remaining:** 0
- **High issues remaining:** 0
- **Other issues:** Earlier review found token-shaped junk reaching rotation and a fixed retry time; both were corrected. A later review found a two-statement UTC-hour timing race; admission and retry timing now come from one statement, and the sealed state passed re-review.

## Overseer Decision

- **Fresh overseer:** COMPLETED
- **Reviewer separation:** CONFIRMED
- **Decision:** APPROVED
- **Overseen state digest:** 5758b6e786cdb632ed6c667e90fcf8f732fa5d80655c093a917472cd405b9449

## Change Guard Result

- **Result:** ONLY CLAIMED END-STATE CHANGES DETECTED
- **Final state digest:** 5758b6e786cdb632ed6c667e90fcf8f732fa5d80655c093a917472cd405b9449
- **Verification state digest:** 5758b6e786cdb632ed6c667e90fcf8f732fa5d80655c093a917472cd405b9449
- **Unexpected paths:** NONE
- **Changed after seal:** NONE

## Remaining Limits

The normal coverage wrapper could not locate `c8` through the clean-worktree dependency
junction, so its exact direct `c8` equivalent ran and passed instead. The final overseer
relied on recorded execution evidence rather than rerunning the suites. This receipt covers
the guarded local implementation; the clean pushed-branch release gate, exact-commit Vercel
Preview check, bounded live OAuth probe, merge, and Production verification still follow.
A real ChatGPT client refresh is only possible if an existing test connector is available;
that limitation must be stated rather than replaced with a fake-backed claim.

## Rollback and Handoff

Before merge, close the PR and delete only this isolated branch. After merge, use a reviewed
Git revert PR and verify its Preview before merging the rollback; do not manually deploy a
folder or change OAuth data. After this bucket release is verified in Production, start the
duplicate-renewal security work from the then-current `main` on a new branch and PR.
