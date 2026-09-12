# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-153304
- **Project:** 1f3d9 at `C:\Users\Owner\Documents\1f3d9`
- **Created:** 2026-08-15T15:33:04.2285100-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- Hosted-chat OAuth grants survive resident root-key rotation, so rotating the root key does not fully cut off prior connector access.
- The new OAuth identity tables have no retention or cleanup path beyond hourly rate-limit buckets, so sign-in state grows without bound.
- The hosted-chat sign-in docs promise request-scoped auth logging, but the checked code only emits a generic unstructured process error log.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | HIGH | E2 | Rotating a resident root key leaves existing hosted OAuth grants active. |
| UNS-002 | MEDIUM | E2 | OAuth authorization and token tables never age out old rows, so identity state grows forever. |
| UNS-003 | MEDIUM | E2 | The hosted-chat sign-in incident trail promised in docs is not implemented in the checked code. |

### Next 3 Actions

1. Make root-key rotation revoke all active OAuth token families for that resident, then prove old hosted grants stop working.
2. Add bounded retention for expired or used OAuth requests, codes, token families, and tokens, and verify index/cardinality behavior.
3. Add redacted structured auth lifecycle logging or an append-only auth event ledger with request IDs, then prove it stays secret-safe.

## Audit Contract

- Scope: identity, access, and authority for keys, sign-in, and who is allowed to do what.
- Product purpose: a live public website where AI agents live, own land and things, sign agreements, and pay each other in real USDC.
- Release profile used for judgment: production public service handling untrusted AI agents and irreversible ownership/payment consequences.
- User parameters:
  - Audit only. No code, config, schema, or docs changes except a new audit report.
  - Docs under `docs/` are claims to verify, not truth.
  - Do not read any existing audit report and do not use other audit outputs.
  - Save findings to `docs/audits/GPT-5_identity_Audit_Findings.md`.
- Exclusions:
  - No live production access, authenticated cloud access, wallet actions, payments, or external writes.
  - No direct reading of secret stores, real `.env` values, private keys, or credential-manager contents.
  - No use of `docs/audits/**`.
- Allowed dynamic checks:
  - Safe git reads.
  - Static source/test/doc inspection.
  - Local non-destructive test command proven in-memory or stubbed.
- Outside-system limits:
  - No networked production systems.
  - No Docker-backed integration tests were run because they may pull images and exceed the static/local-only contract.
- No-remediation write policy:
  - Only this new audit report was written.
  - The local test run reported no file side effects.

## Project and Connection Map

- Entry points:
  - `api/index.ts` -> `src/index.ts`
  - Legacy key-capable MCP door: `/mcp`
  - Hosted-chat OAuth MCP door: `/mcp/connect`
  - Browser OAuth flow: `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`
  - Root-key JSON API: `/api/register`, `/api/rotate`, resident/world/agreement routes mounted from `src/*.ts`
- Identity types:
  - Root bearer key `1f3d9_sk_...` from `src/core.ts`
  - Hosted OAuth authorization code/access/refresh tokens from `src/oauth.ts` + `src/oauth-store.ts`
- Authority boundaries:
  - `authRootKey()` accepts only root keys.
  - `auth()` accepts root keys everywhere, but accepts OAuth access tokens only when the request object was marked by the hosted MCP adapter.
  - Hosted OAuth scope is one resource (`/mcp/connect`) and one scope (`city:resident`).
- Persistence:
  - Root identity in `residents.secret_hash`
  - Hosted sign-in state in `oauth_authorization_requests`, `oauth_authorization_codes`, `oauth_token_families`, `oauth_tokens`, `oauth_rate_limits`
- Critical identity journeys checked:
  - New resident browser registration through one-time key display and confirmation
  - Existing resident browser approval with root key
  - Authorization-code exchange with PKCE
  - Refresh rotation and reuse revocation
  - Hosted MCP-only OAuth acceptance
  - Root-key rotation

Compact traced flows:

- Existing resident hosted sign-in:
  - browser GET `/oauth/authorize` -> validated client/resource/scope/PKCE -> hashed session row
  - browser POST `/oauth/authorize` with root key -> `approveExistingResidentAndIssueAuthorizationCode()` -> hashed code row
  - connector POST `/oauth/token` -> `exchangeAuthorizationCode()` -> token family + access + refresh rows
  - hosted MCP `/mcp/connect` -> `auth()` -> `oauthResidentResolver()` -> `resolveOAuthAccessToken()`

- Root-key rotation:
  - POST `/api/rotate` with root bearer key -> `authRootKey()` -> update `residents.secret_hash` + public rotate event
  - no connected call from this route into OAuth family/token revocation

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Root-key auth and rotation | CHECKED | `src/core.ts`, `src/index.ts`, local auth tests | Static review plus stubbed local tests only; no live token/grant data |
| Hosted OAuth browser flow | CHECKED | `src/oauth.ts`, `src/oauth-store.ts`, `db/schema.sql`, `test/oauth*.test.ts` | No real browser or production provider session |
| Hosted MCP auth boundary | CHECKED | `src/mcp.ts`, `src/core.ts`, `test/mcp-auth.test.ts` | In-memory Hono harness only |
| Database identity invariants | PARTLY CHECKED | `db/schema.sql`, `db/migrations/20260813_hosted_chat_signin.sql`, `test/oauth-storage.test.ts`, integration test source review | PostgreSQL integration tests were inspected but not executed |
| Deployment/environment auth gates | PARTLY CHECKED | `docs/runbooks/*.md`, `test/deploy-safety.test.ts`, `src/hosted-chat-discovery.ts` | No provider verification and no environment-value inspection |
| Logging/monitoring for identity incidents | CHECKED | `src/index.ts`, `docs/features/HOSTED_CHAT_SIGNIN.md`, targeted search | Could not inspect external platform logging if any exists outside repo |
| Existing audit reports | NOT CHECKED | Explicitly excluded | User instruction forbade reading them |
| Secret files and credential stores | NOT CHECKED | Exact locations intentionally not opened | Audit contract forbade reading values |

Honest scope measure:

- First-party files inventoried outside excluded areas: API entrypoint, `src/**`, `db/**`, `test/**`, `e2e/**`, `scripts/**`, selected `docs/**`, `package.json`, `vercel.json`.
- Generated/vendored/ignored areas not used as evidence: `node_modules/**`, `.git/**`, `.codex/**`, `docs/audits/**`.
- One early broad search touched `.codex/reports/unshittily/**`; those lines were discarded and all admitted findings were re-established from fresh targeted reads outside `.codex/**`.

## Evidence Ledger

### EVD-001

- **Time:** 2026-08-15T15:33:04.2285100-05:00
- **Folder:** `C:\Users\Owner`
- **Command:** trusted git read: `git --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --branch --ignore-submodules=all`
- **Exit code:** 0
- **Result:** branch `codex/workspace-reconciliation`; no dirty-path output was returned by the checked status invocation.
- **Side effects:** none

### EVD-002

- **Time:** 2026-08-15T15:33:04.2285100-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** `rg --files . -g '!docs/audits/**'`
- **Exit code:** 0
- **Result:** project inventory confirmed identity-relevant files under `src/`, `db/`, `test/`, `docs/features/`, and `docs/runbooks/`.
- **Side effects:** none

### EVD-003

- **Time:** 2026-08-15T15:33:04.2285100-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** targeted source reads of `src/oauth.ts`, `src/oauth-store.ts`, `src/oauth-config.ts`, `src/mcp.ts`, `src/core.ts`, `src/index.ts`, `db/schema.sql`, and `db/migrations/20260813_hosted_chat_signin.sql`
- **Exit code:** 0
- **Result:** traced the real authn/authz path for root keys, hosted OAuth browser flow, token exchange, revocation, and hosted MCP-only token acceptance.
- **Side effects:** none

### EVD-004

- **Time:** 2026-08-15T15:33:04.2285100-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** targeted source/doc search for identity lifecycle, logging, and retention with `rg -n`
- **Exit code:** 0
- **Result:** found deletion only for `oauth_rate_limits`; found no cleanup path for other OAuth tables; found docs claiming request-ID auth logs and code limited to generic `console.error`.
- **Side effects:** none

### EVD-005

- **Time:** 2026-08-15T15:33:04.2285100-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** `node --test --experimental-strip-types test\oauth.test.ts test\oauth-routes.test.ts test\oauth-flow.test.ts test\oauth-storage.test.ts test\mcp-auth.test.ts test\oauth-config-security.test.ts test\oauth-register-limits.test.ts test\oauth-disabled-routes.test.ts`
- **Exit code:** 0
- **Result:** 64 tests passed, 0 failed, duration about 373 ms. Covered PKCE, browser flow, replay, refresh rotation/reuse, hosted MCP boundary, sign-in off-switch, and config hardening.
- **Side effects:** none observed

### EVD-006

- **Time:** 2026-08-15T15:33:04.2285100-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** line-number re-open of `src/index.ts`, `src/core.ts`, `src/oauth-store.ts`, `src/oauth.ts`, `docs/features/HOSTED_CHAT_SIGNIN.md`
- **Exit code:** 0
- **Result:** refreshed exact citations for admitted findings immediately before drafting them.
- **Side effects:** none

### EVD-007

- **Time:** 2026-08-15T15:33:04.2285100-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** skipped `test/integration/oauth-postgres.test.ts` execution
- **Exit code:** NOT CHECKED
- **Result:** test source was reviewed, but execution was skipped because it uses Docker-backed PostgreSQL and may pull network images outside the chosen static/local-only audit boundary.
- **Side effects:** none

## Findings

### UNS-001: Root-key rotation leaves hosted OAuth grants alive

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Identity and authority boundary; rotating the root credential should fully cut off delegated hosted access or clearly provide an equivalent resident-controlled revocation path.
- **Location:** `src/index.ts:269`, `src/index.ts:286`, `src/core.ts:67`, `src/core.ts:72`, `src/oauth-store.ts:505`, `docs/features/HOSTED_CHAT_SIGNIN.md:84`, `docs/features/HOSTED_CHAT_SIGNIN.md:205`
- **User or business harm:** A resident can rotate the permanent root key and still leave previously issued hosted-chat refresh/access grants active. A stolen or unwanted connector grant can continue ordinary resident actions, including ownership changes and withdrawals, even after the resident believes they changed the master key.
- **Evidence:** The rotate route updates only `residents.secret_hash` and appends a public rotate event (`src/index.ts:283-294`). OAuth access resolution ignores `secret_hash` and authorizes from `oauth_tokens` + `oauth_token_families` by resident id alone (`src/oauth-store.ts:510-533`). `auth()` still accepts hosted access tokens on marked `/mcp/connect` backing requests (`src/core.ts:67-79`). The feature spec explicitly says revocation can end a connector grant “without changing the resident key” and separately promises Release 2 recovery will revoke existing connector grants, which implies Release 1 rotation does not (`docs/features/HOSTED_CHAT_SIGNIN.md:84`, `:205`).
- **Safe reproduction:** Deterministic code-path proof: re-open the rotate route and confirm it does not touch `oauth_token_families` or `oauth_tokens`; then re-open `resolveOAuthAccessToken()` and confirm it authorizes by token-family state only. No live credential exercise was allowed.
- **Connection traced:** `POST /api/rotate` -> `authRootKey()` -> `UPDATE residents SET secret_hash ...` -> return new root key; separately `/mcp/connect` -> `auth()` -> `oauthResidentResolver(token)` -> `resolveOAuthAccessToken()` -> resident actions still authorized.
- **Root cause:** Root-key lifecycle and hosted OAuth grant lifecycle are modeled as separate systems with no revocation linkage from resident rotation to connector grants.
- **Connections and similar locations checked:** Checked `/oauth/revoke`, refresh-token reuse revocation, OAuth off-switch behavior, and hosted MCP-only token acceptance. No route was found that lets a resident revoke all of its connector grants with only the root key.
- **Durable fix:** Make root-key rotation revoke every active OAuth token family for that resident in the same operation, or add a root-key-authenticated revoke-all-grants path and call it from rotation. Preserve resident-facing clarity by explicitly reporting that hosted grants were also ended.
- **Why this is not a band-aid:** It fixes the missing lifecycle connection between the root identity and its delegated hosted grants instead of relying on operator advice or shorter token TTLs.
- **Pre-fix proof:** Add a behavior-level test: issue a hosted grant, rotate the root key, then prove the old hosted access token and refresh token both fail while the new root key still works.
- **Verification:** Re-run the hosted OAuth flow tests, add a rotation-plus-revocation test, verify `/mcp/connect` rejects the old grant, verify `/api/rotate` still works with the new root key, and regression-test refresh reuse revocation.
- **Regression and rollback risk:** Revoking token families during rotation can surprise legitimate connectors and cut active sessions. Rollout needs a clear user-facing message and a reversible deployment path if grant invalidation accidentally over-matches families.
- **Unknowns:** Production enablement of hosted sign-in was not inspected directly, and no live grant data was available.

### UNS-002: OAuth sign-in state never ages out beyond hourly rate-limit buckets

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Identity operations must remain supportable under production traffic; auth state should have bounded retention or cleanup when it is explicitly short-lived.
- **Location:** `src/oauth-store.ts:78`, `src/oauth-store.ts:335`, `src/oauth-store.ts:372`, `src/oauth-store.ts:505`, `src/oauth-store.ts:545`, `db/schema.sql:109`, `db/schema.sql:134`, `db/schema.sql:152`
- **User or business harm:** Every authorization code, token family, token, and many request rows remain in the primary database forever. As hosted sign-in traffic grows, auth indexes and tables grow monotonically, increasing query cost, storage, backup size, and incident-recovery friction until sign-in or hosted MCP latency degrades.
- **Evidence:** The only explicit cleanup in `src/oauth-store.ts` is deletion of old `oauth_rate_limits` rows (`src/oauth-store.ts:547-552`). Request cleanup only clears expired pending registration fields while keeping the row (`src/oauth-store.ts:78-99`). The schema defines short expiries for authorization codes, access tokens, and refresh-token families but no cleanup trigger, job, or maintenance path for `oauth_authorization_codes`, `oauth_token_families`, or `oauth_tokens` (`db/schema.sql:109-177`).
- **Safe reproduction:** Deterministic check: search for deletes on OAuth tables and confirm only `oauth_rate_limits` is purged. Compare that with the schema’s 5-minute, 10-minute, and 30-day expiry fields.
- **Connection traced:** browser sign-in -> request row -> code row -> token family + token rows -> normal expiry leaves rows in place -> no purge path reduces cardinality -> every future auth query and backup carries historical growth.
- **Root cause:** Expiry was implemented as an authorization predicate but not as a data-lifecycle policy.
- **Connections and similar locations checked:** Reviewed schema, store methods, deploy/test files, and runbooks. No scheduled cleanup script, migration, trigger, or operator runbook step was found for these auth tables.
- **Durable fix:** Add explicit retention rules for used/expired OAuth requests, codes, families, and tokens, with bounded windows and an operator-safe execution path. Keep forensic needs by retaining only the minimum redacted metadata actually required.
- **Why this is not a band-aid:** It fixes the missing lifecycle policy for short-lived credentials instead of relying on bigger indexes or hoping traffic stays small.
- **Pre-fix proof:** Add a deterministic store or integration test that seeds expired OAuth rows, runs the cleanup path, and proves only out-of-retention rows are removed while active grants still resolve.
- **Verification:** Measure row counts before/after cleanup, re-run the OAuth route and storage suites, verify active and recently revoked grants still behave correctly, and check backup/runtime query impact.
- **Regression and rollback risk:** Over-aggressive cleanup could erase rows still needed for active refresh rotation or incident investigation. The cleanup window and order must be conservative, and rollback should be a no-op disable of the cleanup job.
- **Unknowns:** External managed retention outside the repo was not available to inspect.

### UNS-003: Hosted-chat sign-in logging promised in docs is absent from the checked code

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Production identity flows need a secret-safe incident trail that lets operators distinguish auth failures, abuse, and rollout mistakes.
- **Location:** `docs/features/HOSTED_CHAT_SIGNIN.md:111`, `src/index.ts:144`, `src/index.ts:145`
- **User or business harm:** During sign-in abuse, rollout mistakes, or incident response, operators have no request-scoped, auth-specific trail in the checked code. That makes it harder to prove whether failures came from a bad client config, CSRF/origin rejection, token reuse, or a broader outage.
- **Evidence:** The feature doc says “logs use request IDs and safe event names” for OAuth routes (`docs/features/HOSTED_CHAT_SIGNIN.md:111`). In the checked server code, the only general failure log is `console.error('request failed', error)` inside the app-wide error handler (`src/index.ts:144-145`). No request-id generation, auth event logger, or append-only OAuth audit table was found in the checked source.
- **Safe reproduction:** Deterministic source check: search for request-id generation and auth-specific logging symbols in `src/**`; re-open the only process-level error log in `src/index.ts`.
- **Connection traced:** OAuth/browser flow failures or hosted connector failures -> app error handler or handled generic response -> no request-scoped auth event trail in checked code -> harder operational diagnosis and abuse triage.
- **Root cause:** The sign-in design doc specifies an incident-observability contract that was not implemented in first-party server code.
- **Connections and similar locations checked:** Checked OAuth routes, MCP adapter, hosted-chat discovery, runbooks, and tests. I found many auth behavior tests but no tests asserting structured auth logging or request IDs.
- **Durable fix:** Add a redacted request ID at request entry, propagate it through auth routes and hosted MCP auth failures, and record safe auth lifecycle events without credential material. If a database-backed audit ledger is used, keep it append-only and secret-free.
- **Why this is not a band-aid:** It creates the missing operational evidence path instead of relying on ad hoc console output or human memory during incidents.
- **Pre-fix proof:** Add a test or deterministic harness check proving OAuth failures emit a request ID and safe event type while never echoing resident keys, access tokens, refresh tokens, codes, or full authorization URLs.
- **Verification:** Exercise handled and unhandled auth failures, confirm request IDs reach logs, confirm secrets stay redacted, and verify runbooks point to the same signals.
- **Regression and rollback risk:** New logging can leak credentials if implemented carelessly. Rollback must disable the new logger or field set without changing auth behavior.
- **Unknowns:** External platform logging, if any, was not visible from the repository and could not be credited as implemented evidence.

## Questions Needing Human Review

- **Question:** Is hosted-chat sign-in currently enabled in production, and do operators expect `/api/rotate` to evict prior hosted sessions?
  - **Why it matters:** If hosted OAuth is live, `UNS-001` is an active production authority gap rather than a latent release risk.
  - **Available evidence:** The repo contains the hosted-chat sign-in implementation, tests, and docs, but no inspected production environment values.
  - **Missing evidence:** Live `HOSTED_CHAT_SIGNIN_ENABLED` state and any operator-facing guidance shown during rotation.
  - **Safest next check:** Human operator verifies the production feature flag and attempts a controlled non-production grant/rotation drill.
  - **Should release wait:** No for code review alone, yes before claiming the current production rotation story is complete.

- **Question:** Does an external platform add request IDs or auth audit events outside this repository?
  - **Why it matters:** It affects the severity of `UNS-003`, but does not remove the missing first-party code contract if those signals are required at app level.
  - **Available evidence:** The checked repo does not implement request IDs or auth event logging.
  - **Missing evidence:** Vercel/edge/logging middleware configuration outside the repo.
  - **Safest next check:** Human operator inspects production logging configuration and demonstrates a redacted OAuth failure trace end to end.
  - **Should release wait:** No, but incident-readiness claims should wait.

## Ordered Repair Plan

1. Contain active exposure or data-loss risk without destroying evidence.
   - For `UNS-001`, design resident-controlled hosted-grant revocation tied to root-key rotation.
2. Add a failing behavior-level check.
   - Add tests for `UNS-001` rotation invalidation, `UNS-002` retention cleanup, and `UNS-003` request-ID/redaction behavior.
3. Repair the shared root cause and all proven connected paths.
   - Link root-key lifecycle to OAuth family revocation for `UNS-001`.
   - Add explicit retention/cleanup for `UNS-002`.
   - Add structured redacted auth logging for `UNS-003`.
4. Handle existing stored data or environment differences safely.
   - Define retention windows and cleanup order for already accumulated OAuth rows.
   - Confirm production logging sinks and auth feature flags before rollout.
5. Run targeted, connected, and whole-product regression checks.
   - Re-run the local OAuth/MCP suites and new tests; then run PostgreSQL integration coverage for auth lifecycle changes.
6. Release in reversible stages and monitor the specific failure signal.
   - Roll out grant revocation and cleanup behind explicit operator awareness; watch rejected hosted grant counts and auth error telemetry.
7. Run a new full `$unshittify` audit, cite this report, and use a fresh skeptic.
   - Re-audit identity after the fixes land.

## Verification and Release Gates

- Success conditions:
  - Old hosted access and refresh tokens stop working immediately after root-key rotation.
  - OAuth row counts stop growing without bound and cleanup preserves active grants.
  - Auth failures and grant lifecycle events produce request IDs or equivalent trace handles without leaking secrets.
- Safe commands:
  - `node --test --experimental-strip-types test\oauth.test.ts test\oauth-routes.test.ts test\oauth-flow.test.ts test\oauth-storage.test.ts test\mcp-auth.test.ts test\oauth-config-security.test.ts test\oauth-register-limits.test.ts test\oauth-disabled-routes.test.ts`
  - After repairs, add the relevant PostgreSQL integration auth test command from `npm run test:postgres`.
- Manual checks:
  - Controlled non-production hosted sign-in -> rotate root key -> verify old hosted grant fails.
  - Controlled auth failure -> verify request ID / safe log trail exists and contains no credentials.
  - Cleanup drill against isolated data -> verify active grants remain usable while expired rows are removed.
- Browsers/devices:
  - Browser OAuth flow should be checked on at least the supported desktop browser path used for connector setup.
- Test data needed:
  - One existing resident root key and one hosted OAuth grant in an isolated environment.
  - Expired/used OAuth rows for cleanup tests.
- Forbidden live actions:
  - No production credential rotation drill, no real payments, no production grant invalidation during verification.
- Rollback conditions:
  - Hosted sign-in starts rejecting fresh valid grants after rotation changes.
  - Cleanup deletes rows needed for valid active grants or refresh rotation.
  - Logging introduces secret reflection or materially changes auth responses.
- Evidence required before release:
  - Passing new failing tests for each finding.
  - Fresh targeted verification on isolated data.
  - Updated operator guidance for rotation/revocation and auth incident tracing.

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

single-agent audit - independently unverified

- No fresh skeptic was available through the callable tools in this session, so no separate reviewer re-checked the candidate set.
- Findings were personally re-opened and challenged before admission, but same-model single-agent review remains a real blind spot.
- Because independent skeptic review was not completed, no `E4` claims are made and the verdict is constrained accordingly.

## Honest Limitations

- This was a static-plus-local audit. It cannot prove live production flags, provider logging, real connector behavior, or real database cardinality.
- No production systems, Vercel settings, Neon settings, or secret files were inspected.
- Docker-backed PostgreSQL integration auth tests were reviewed in source but not executed.
- Outside systems and platform-specific file permissions are not fully covered.
- One early broad search traversed `.codex/reports/unshittily/**`; those lines were intentionally discarded and not used as evidence. All admitted findings were re-established from fresh targeted reads outside `.codex/**`.
- The local OAuth/MCP test command created no observed files, caches, screenshots, coverage outputs, or build artifacts.
- Because no independent skeptic reviewed this report, same-model blind spots remain and lower confidence should be assumed than a two-reviewer audit.
- A valid structure does not prove the findings are true; it only proves the report is complete enough for follow-up work.
