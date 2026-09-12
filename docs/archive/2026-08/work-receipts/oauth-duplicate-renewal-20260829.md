# Unshittily Work Receipt

- **Task ID:** UNSLY-20260829-204214
- **Project:** 1F3D9 — `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Created:** 2026-08-29T20:42:14.545520+00:00

## Plain-English Outcome

**Outcome:** IMPLEMENTED - REVIEW OR VERIFICATION INCOMPLETE

The small duplicate-renewal fix is implemented, tested, and independently approved. One database
renewal wins, the request overlapping that exact database operation receives no credentials and
cannot disconnect the winner, and any later use of the old renewal credential still disconnects the
whole connector connection. The strongest receipt label is withheld because the owner deliberately
accepted the narrow same-operation security tradeoff and the clean pushed-branch release gate can run
only after this guarded state is committed and pushed.

## Execution Contract

- **Requested task:** Deliver the duplicate-renewal repair separately from the already shipped allowance fix: preserve one usable winner during an exact database overlap, keep later replay revocation, document the behavior, and ship through its own review path.
- **Non-goals:** Do not change the per-connection or junk allowances; do not add a timed replay window; do not add ChatGPT-only behavior; do not change payments, resident keys, explicit revocation, token lifetimes, or unrelated browser behavior.
- **External effects authorized:** Local disposable-database and browser tests; then commit, push, GitHub pull request, Preview checks, merge, and read-only Production verification. No database migration, live-data write, payment, credential rotation, or manual provider deployment is authorized.

## Baseline and Protected Work

- **Pre-existing work:** A clean dedicated branch and worktree started at the exact already-shipped bucket-fix commit `f1b62e8ae948025a9b159441caebae24c90459b5`; a fresh fetch confirmed `origin/main` remained that commit. The guard recorded 400 baseline files before implementation. The other Codex checkout and all unrelated project files were left untouched.
- **Declared files:** `CLAUDE.md`, `docs/DECISIONS.md`, `docs/SYSTEM_DESIGN.md`, `docs/features/HOSTED_CHAT_SIGNIN.md`, `docs/published/FRONTDOOR.md`, `src/door.ts`, `src/frontdoor.txt`, `src/llms.txt`, `src/oauth-store.ts`, `src/oauth.ts`, `test/help-text.test.ts`, `test/integration/oauth-postgres.test.ts`, `test/oauth-flow.test.ts`
- **Protected areas:** Database schema and migrations, payment code and data, resident keys and recovery, refresh allowances, explicit revocation, OAuth client registration, unrelated tests and docs, the user's main checkout, and Production data.

## Impact and Connection Map

The affected journey is `POST /oauth/token` with `grant_type=refresh_token`. The route checks the
connection-specific allowance, generates candidate credentials in memory, and asks the OAuth store
to rotate the stored hashed renewal credential. The shared PostgreSQL rotation boundary now takes a
transaction-only lock derived from the presented credential hash. One request can update the old row
and insert one new access/renewal pair. A contender that reaches that same still-running operation
cannot take the lock, writes nothing, receives `invalid_grant`, and does not trigger family
revocation. After the winner commits, the lock is gone; another old-credential use takes the lock,
detects ordinary reuse, and revokes the family. Public first-read instructions, compact machine
instructions, system design, hosted-sign-in design, and the locked decision record state the same
narrow rule. No schema, outside service contract, or raw credential storage changed.

## Design and Root Cause

- **Root cause addressed:** YES
- **Why durable:** Reuse detection previously treated a request that lost the database rotation race exactly like a later replay, so the loser revoked credentials the winner had just created. The repair lives at the single PostgreSQL rotation boundary and distinguishes only an unavailable still-held transaction lock; it adds no clock window, response cache, raw-token replay, or route/vendor special case.
- **Similar paths checked:** Route-level refresh handling, PostgreSQL rotation and family revocation, passive access-token resolution, rate-limit subject routing, explicit client revocation, root rotation/recovery OAuth revocation, public/front-door mirrors, compact machine instructions, and existing sequential reuse tests.

## Acceptance Checks

### AC-001: Exact overlap creates one winner and one credential-free loser

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-003

### AC-002: The winning connection remains usable, while later old-credential replay revokes it

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-003

### AC-003: Client/resource binding remains and no raw credential response is stored or replayed

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-013

### AC-004: Every caller-facing instruction mirror states the narrow overlap and later-replay rule

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-004

### AC-005: Connected unit, coverage, type, browser, database, and dependency checks do not show a change-caused regression

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-007

### AC-006: Independent code, security, and final reviews approve the sealed state

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-014

## Changes Made

### CHG-001: Serialize only the same credential's live database rotation

- **Paths:** `src/oauth-store.ts`, `src/oauth.ts`
- **Requirement:** AC-001, AC-002, AC-003
- **Why:** A transaction-scoped PostgreSQL lock lets the store identify only a request overlapping the still-running winner, return no credentials to the loser, and preserve ordinary post-commit reuse revocation.

### CHG-002: Prove overlap, single issuance, winner use, and later revocation

- **Paths:** `test/oauth-flow.test.ts`, `test/integration/oauth-postgres.test.ts`
- **Requirement:** AC-001, AC-002, AC-003, AC-005
- **Why:** Route and real-PostgreSQL tests reproduce the old family-killing race and prove the new behavior at both the HTTP and storage boundaries.

### CHG-003: Publish and lock the accepted behavior on every instruction surface

- **Paths:** `CLAUDE.md`, `docs/DECISIONS.md`, `docs/SYSTEM_DESIGN.md`, `docs/features/HOSTED_CHAT_SIGNIN.md`, `docs/published/FRONTDOOR.md`, `src/door.ts`, `src/frontdoor.txt`, `src/llms.txt`, `test/help-text.test.ts`
- **Requirement:** AC-004, AC-005
- **Why:** Decision 45 requires caller-visible contracts before enforcement; generated and source mirrors must not continue saying reuse behavior is unchanged.

## Pre-Change Proof

- **Method:** FAILING TEST
- **Observed before implementation:** The new HTTP overlap test lost the winner because the second request revoked the family. The new real-PostgreSQL test returned `rotated` plus `reused`, rather than `rotated` plus a non-revoking overlap result.
- **Observed after implementation:** The HTTP test produces exactly one `200` winner and one `400 invalid_grant` loser, the winner can renew again, the database contains only the initial pair plus one winner pair, and a later old-token replay returns `reused` and revokes the winner.

## Anti-Band-Aid Gate

- **Tests weakened:** NO
- **Errors hidden:** NO
- **Silent fallback added:** NO
- **Hardcoded workaround added:** NO
- **Duplicate rule added:** NO
- **Permission or security loosened:** YES
- **Unnecessary dependency added:** NO
- **Suppression or skip added:** NO
- **Old implementation left active:** NO

The `YES` is the explicit owner-approved tradeoff recorded in Decision 64: a thief who races during
the exact same live database operation may win or preserve the connection because the server has no
stronger client proof to distinguish that request. The exception has no time window after commit,
creates no second credential pair, and was separately approved by security review.

## Verification Evidence

### EVD-001: Correct current branch and base

- **Check:** `git fetch origin main`; `git rev-parse HEAD`; `git rev-parse origin/main`; `git merge-base HEAD origin/main`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** HEAD, `origin/main`, and merge base all equaled `f1b62e8ae948025a9b159441caebae24c90459b5` before commit.
- **Side effects:** Refreshed the local read-only `origin/main` remote reference.

### EVD-002: HTTP OAuth flow tests

- **Check:** `node --test --experimental-strip-types --experimental-test-module-mocks test/oauth-flow.test.ts`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 43 tests passed, 0 failed, including one overlap winner, token-free loser, winner survival, and later renewal.
- **Side effects:** In-memory test state and safe diagnostic output only.

### EVD-003: Real-PostgreSQL OAuth tests

- **Check:** `node --test --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks test/integration/oauth-postgres.test.ts`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 30 tests passed, 0 failed. The overlap test proved four total token rows, one unused winner renewal, no family revocation during overlap, and later whole-family revocation.
- **Side effects:** Reset and used the disposable local integration database; temporary test trigger/function were removed in `finally`.

### EVD-004: Public instruction mirror tests

- **Check:** `node --test --experimental-strip-types test/help-text.test.ts`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 43 tests passed, 0 failed; every front-door, generated, compact, system-design, and hosted-sign-in mirror states one overlap winner, no post-commit grace, and later family revocation.
- **Side effects:** NONE

### EVD-005: Full ordinary test suite

- **Check:** `npm test`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 1,573 tests passed, 0 failed, 0 skipped.
- **Side effects:** Used and removed the suite-owned operating-system temporary directory.

### EVD-006: Type check and diff hygiene

- **Check:** `npm run typecheck`; `git diff --check`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** TypeScript reported no errors; Git reported no whitespace errors.
- **Side effects:** NONE

### EVD-007: Coverage gate

- **Check:** `npm run test:coverage`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 1,573 tests passed. Project coverage was 91.99% statements, 81.59% branches, 92.33% functions, and 91.99% lines; every 80% gate passed.
- **Side effects:** Coverage artifacts were created and removed inside the suite-owned operating-system temporary directory.

### EVD-008: Default browser-test port conflict

- **Check:** `npm run test:e2e -- --output=C:\Users\Owner\AppData\Local\Temp\1f3d9-oauth-e2e-8f6cc2cf`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** 1
- **Result:** FAILED
- **Important output:** The default local test URL on port 41739 was already in use by other project work. No test ran and that process was not stopped.
- **Side effects:** NONE in the project; a disposable output path outside the project was selected but no browser test ran.

### EVD-009: Browser tests on an isolated port

- **Check:** `$env:E2E_PORT=41839; npm run test:e2e -- --output=C:\Users\Owner\AppData\Local\Temp\1f3d9-oauth-e2e-67d8a53b`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 172 Playwright tests passed, 0 failed.
- **Side effects:** Started and stopped the local HTTPS test server and wrote disposable output outside the project.

### EVD-010: Full real-PostgreSQL suite and isolated timing rerun

- **Check:** `npm run test:postgres` twice; then `node --test --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks test/integration/city-credit-purchase-postgres.test.ts`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** NOT APPLICABLE
- **Result:** MANUAL
- **Important output:** Both 227-test full runs passed the complete OAuth section and failed one different unrelated real-time assertion outside OAuth. The final isolated affected payment timing file passed 4 tests, 0 failed. No payment source or test was changed.
- **Side effects:** Reset and used disposable local integration databases only.

### EVD-011: Dependency vulnerability check

- **Check:** `npm audit --audit-level=high`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** `found 0 vulnerabilities`.
- **Side effects:** Read the package registry and local dependency metadata; no package or lockfile changed.

### EVD-012: Independent code review

- **Check:** Read-only review of the final diff plus independent `change_guard.py digest` recomputation.
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** NOT APPLICABLE
- **Result:** MANUAL
- **Important output:** APPROVED digest `fdc43a4fc721e0ffd76ad27f4d206ef27a8c136e275cee85074f1204642c3662`; 0 blocker, high, medium, or low findings. An earlier stale-public-mirror finding was fixed, retested, and re-reviewed before approval.
- **Side effects:** NONE; reviewer was read-only.

### EVD-013: Independent security review

- **Check:** Read-only OAuth security review plus independent `change_guard.py digest` recomputation.
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** NOT APPLICABLE
- **Result:** MANUAL
- **Important output:** APPROVED digest `fdc43a4fc721e0ffd76ad27f4d206ef27a8c136e275cee85074f1204642c3662`; no security findings. Review confirmed transaction-only scope, one token pair, client/resource binding, later revocation, and no raw credential storage or log.
- **Side effects:** NONE; reviewer was read-only.

### EVD-014: Fresh final overseer

- **Check:** Independent read-only final inspection and guard-digest recomputation by an overseer uninvolved in this change.
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** NOT APPLICABLE
- **Result:** MANUAL
- **Important output:** APPROVED digest `fdc43a4fc721e0ffd76ad27f4d206ef27a8c136e275cee85074f1204642c3662`; 0 blocker, high, medium, or low findings and no unresolved disagreement.
- **Side effects:** NONE; overseer was read-only.

### EVD-015: Declared-file guard

- **Check:** `python C:\Users\Owner\.codex\skills\unshittily\scripts\change_guard.py finish --root <project> --manifest <manifest> --claims <claims> --receipt <receipt>`
- **Working folder:** `C:\Users\Owner\.codex\worktrees\oauth-duplicate-renewal-20260829\1f3d9`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** `only_claimed_changes`; 13 changed product files plus this receipt; no unexpected, unsealed, post-seal, or Git-state change; final source digest `fdc43a4fc721e0ffd76ad27f4d206ef27a8c136e275cee85074f1204642c3662`.
- **Side effects:** Read-only project inventory and temporary guard-ledger reads.

## Reviewer Findings

- **Specialist review:** COMPLETED
- **Specialist reviewed state digest:** fdc43a4fc721e0ffd76ad27f4d206ef27a8c136e275cee85074f1204642c3662
- **Blockers remaining:** 0
- **High issues remaining:** 0
- **Other issues:** NONE. The initial medium stale-public-mirror finding was fixed and the exact sealed result was re-reviewed and approved.

## Overseer Decision

- **Fresh overseer:** COMPLETED
- **Reviewer separation:** CONFIRMED
- **Decision:** APPROVED
- **Overseen state digest:** fdc43a4fc721e0ffd76ad27f4d206ef27a8c136e275cee85074f1204642c3662

## Change Guard Result

- **Result:** ONLY CLAIMED END-STATE CHANGES DETECTED
- **Final state digest:** fdc43a4fc721e0ffd76ad27f4d206ef27a8c136e275cee85074f1204642c3662
- **Verification state digest:** fdc43a4fc721e0ffd76ad27f4d206ef27a8c136e275cee85074f1204642c3662
- **Unexpected paths:** NONE
- **Changed after seal:** NONE

## Remaining Limits

The owner-approved exact-overlap exception cannot distinguish a legitimate connector request from a
thief using the same credential during that same database operation. Stronger signed client proof is
a separate, larger future design. The full PostgreSQL aggregate runner showed unrelated wall-clock
test flakiness even though the affected OAuth suite and the final isolated timing file passed. The
clean pushed-branch release gate, GitHub/Preview checks, merge, and read-only Production probe occur
after this receipt because the project gate refuses an uncommitted or unpushed worktree. Reviewers
and overseer are same-family AI agents and the file guard proves declared end states, not absence of
all defects.

## Rollback and Handoff

No migration or live-data repair is required. If the released behavior is wrong, revert the dedicated
pull-request commit through the ordinary GitHub path; that restores the prior rule where a losing
duplicate can revoke the family. Before merge, require the explicit `GATE_EXIT=0` line from
`bash scripts/deploy.sh --prepare`, green GitHub checks, an exact-commit Preview probe, and after merge
verify the exact Production commit plus safe invalid-renewal and public-instruction responses. Do not
test Production by creating or replaying a real resident credential.
