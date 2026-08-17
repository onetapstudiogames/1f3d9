# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-154344
- **Project:** 1F3D9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T15:43:44.1215559-05:00

## Plain-English Verdict

DO NOT RELEASE

- Secret-bearing operator files and backup exports live inside the repo tree with Windows ACLs that let sandbox accounts read them.
- Root-key rotation can race and hand back two different replacement keys from one old key, breaking the "old key dies, identity stays" guarantee.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | BLOCKER | E3 | Secret-bearing operator files and backup/export paths inherit read access for sandbox accounts. |
| UNS-002 | BLOCKER | E3 | Two concurrent `/api/rotate` calls can each return a new root key even though only one survives. |
| UNS-003 | HIGH | E2 | Rotating the root key does not revoke existing hosted-chat OAuth grants. |
| UNS-004 | HIGH | E2 | `scripts/restore-key.mjs` can silently seize any resident identity and writes raw replacement keys under `backups/`. |
| UNS-005 | MEDIUM | E2 | Legacy `/api/register` throttling is nonatomic and can be exceeded by concurrent requests. |

### Next 3 Actions

1. Remove repo-local secret storage and tighten Windows ACLs on any remaining backup or operator-only paths, then rotate anything that lived there.
2. Change `/api/rotate` to a single compare-and-swap transaction and add a concurrent rotation test that proves only one replacement key can be issued.
3. Decide whether root-key rotation is true compromise recovery; if yes, revoke all hosted-chat grants on rotate and remove or redesign `scripts/restore-key.mjs` to fit the public identity contract.

## Audit Contract

- Scope: identity, access, and authority for local source at `C:\Users\Owner\Documents\1f3d9`, following connected money and ownership paths when they affect who may act.
- Product purpose: live production city where AI agents register identities, own property, sign agreements, and pay each other in real USDC.
- Release profile: public paid product handling untrusted users and irreversible actions.
- User parameters: deep audit; docs are claims, not truth; do not change code; do not read any report in `docs/audits`; save findings under `docs/audits`.
- Exclusions: no production access, no live API/provider/payment/database calls, no secret-store reads, no `.env` value reads, no destructive actions, no remediation.
- Allowed checks: static source and docs review, metadata-only filesystem/ACL inspection, safe Git reads, local `npm test`, and local `npm run typecheck`.
- Outside-system limits: no authenticated web calls, no cloud writes, no live chain/payment checks.
- Write policy: audit-only; the only intentional write was this new report file.
- Normal generated output allowed by contract: project-native test/typecheck output if created. None was observed from the commands run here.

## Project and Connection Map

- Entry points:
  - `api/index.ts` -> `src/index.ts` via Vercel/Hono.
  - Public bearer-key API: `/api/register`, `/api/rotate`, authenticated `/api/*`.
  - MCP: legacy `/mcp` and hosted `/mcp/connect`.
  - Hosted sign-in: `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`.
- Identity stores:
  - Root identity: `residents.secret_hash` in `db/schema.sql`.
  - Hosted-chat grants: `oauth_authorization_*`, `oauth_token_families`, `oauth_tokens`.
  - Legacy registration throttle: `reg_log`.
- Operator authority surfaces:
  - Repo-local environment files used by scripts.
  - `scripts/backup.mjs` full-database export into `backups/`.
  - `scripts/restore-key.mjs` resident key override.
- Critical journeys checked:
  - New resident: unauthenticated `/api/register` -> `residents.secret_hash` -> returned bearer secret.
  - Key rotation: bearer auth -> `/api/rotate` -> secret replacement -> follow-on authorization state.
  - Hosted connector: browser approval with resident key -> authorization code -> token family -> `/mcp/connect`.
  - Operator recovery/export: local env fallback -> database access -> backup or resident-key override.
- Connection flows:
  - Resident key auth: caller -> `Authorization: Bearer 1f3d9_sk_...` -> `authRootKey`/`residentBySecret` -> resident-scoped action.
  - Hosted auth: browser approval -> `oauth_authorization_requests` -> code -> token family -> `residentByOAuthAccessToken` -> `/mcp/connect`.
  - Recovery gap: `/api/rotate` updates only `residents.secret_hash`; hosted token families continue independently.

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Root registration and rotation | CHECKED | `src/index.ts`, `src/core.ts`, `test/routes.test.ts`, `docs/SYSTEM_DESIGN.md`, `docs/DECISIONS.md` | Static plus local tests only; no live concurrent requests sent. |
| Hosted-chat OAuth identity | CHECKED | `src/oauth.ts`, `src/oauth-store.ts`, `src/mcp.ts`, `docs/features/HOSTED_CHAT_SIGNIN.md`, `test/oauth-flow.test.ts`, `test/oauth-register-limits.test.ts`, `test/mcp-auth.test.ts` | No real client or browser-host integration against live systems. |
| Operator scripts, backups, and secret handling | CHECKED | `scripts/backup.mjs`, `scripts/restore-key.mjs`, runbooks, `.gitignore`, ACL metadata, `test/operator-scripts.test.ts` | Secret values were not read; provider-local hidden file contents were not opened. |
| Public/MCP credential leakage backstops | PARTLY CHECKED | `src/input.ts`, `src/mcp.ts`, `test/mcp-auth.test.ts` | Public raw-route historical data was not scanned from a database snapshot. |
| Transfer/payment authority touched by identity | PARTLY CHECKED | `src/society.ts`, `docs/PRD.md`, `test/world-market.test.ts` | No live chain or market calls; only connected authority flows were sampled. |
| Live production environment and provider state | NOT CHECKED | Static-only contract | No live Vercel, Neon, Base, or 1F3EA access permitted. |
| Existing audit reports | NOT CHECKED | User exclusion honored | `docs/audits` reports were intentionally not read. |
| Vendored/generated areas | NOT RELEVANT | `node_modules/` excluded; 106 first-party files inventoried out of 118 listed paths | Inventory was scoped to first-party source, tests, scripts, schema, and docs. |

## Evidence Ledger

| ID | Time | Folder | Exact command | Exit | Redacted result | Side effects |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | 2026-08-15 15:34 CDT | `C:\Users\Owner\Documents\1f3d9` | `Get-Content -Raw 'C:\Users\Owner\.codex\skills\unshittify\SKILL.md'` | 0 | Loaded audit skill instructions. | None. |
| EVD-002 | 2026-08-15 15:35 CDT | `C:\Users\Owner\Documents\1f3d9` | `Get-Content -Raw` on `audit-checklist.md`, `report-contract.md`, and `agent-prompts.md` | 0 | Loaded required audit references. | None. |
| EVD-003 | 2026-08-15 15:36 CDT | `C:\Windows\Temp` | `<absolute git> --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --branch --ignore-submodules=all` | 0 | Branch `codex/workspace-reconciliation`; pre-existing untracked `docs/audits/GPT-5_identity_Audit_Findings.md`. | None. |
| EVD-004 | 2026-08-15 15:36 CDT | `C:\Users\Owner\Documents\1f3d9` | `rg --files -g '!docs/audits/**' -g '!node_modules/**' -g '!*dist*' -g '!*coverage*'` | 0 | Inventoried first-party files without opening audit reports. | None. |
| EVD-005 | 2026-08-15 15:37-15:42 CDT | `C:\Users\Owner\Documents\1f3d9` | `Get-Content`/`rg -n` on `src/index.ts`, `src/core.ts`, `src/input.ts`, `src/oauth.ts`, `src/oauth-store.ts`, `src/mcp.ts`, `scripts/backup.mjs`, `scripts/restore-key.mjs`, `db/schema.sql`, and connected docs/tests | 0 | Re-opened exact source, test, and runbook lines for candidate findings. | None. |
| EVD-006 | 2026-08-15 15:39 CDT | `C:\Users\Owner\Documents\1f3d9` | `Get-Acl` on root env files, `.vercel`, and `backups`; `Get-LocalGroupMember -Group 'CodexSandboxUsers'` | 0 | Confirmed inherited `ReadAndExecute` for `DESKTOP-GDDDN71\CodexSandboxUsers`; group contains `CodexSandboxOffline` and `CodexSandboxOnline`. | None. Metadata only; no secret-file contents read. |
| EVD-007 | 2026-08-15 15:40-15:41 CDT | `C:\Users\Owner\Documents\1f3d9` | `npm test` | 0 | 401 tests passed; route, OAuth, MCP, operator-script, and market harnesses all ran locally. | No generated files observed. |
| EVD-008 | 2026-08-15 15:41 CDT | `C:\Users\Owner\Documents\1f3d9` | `npm run typecheck` | 0 | TypeScript typecheck passed locally. | No generated files observed. |
| EVD-009 | 2026-08-15 15:42-15:43 CDT | `C:\Users\Owner\Documents\1f3d9` | `rg -n` and `Get-Content` on targeted tests/docs for rotate, revoke, hosted redaction, rate limits, and official claims | 0 | Confirmed missing concurrency coverage on legacy rotate/register and confirmed hosted-only note-body redaction test. | None. |
| EVD-010 | 2026-08-15 15:43 CDT | `C:\Users\Owner\Documents\1f3d9` | `(rg --files ... | Measure-Object -Line).Lines` | 0 | Counted 106 first-party files in checked scope, 118 listed paths overall. | None. |

## Findings

### UNS-001: Secret-bearing operator files and backup/export paths inherit read access for sandbox accounts

- **Severity:** BLOCKER
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Public paid product handling identity and money; secret-bearing operator material must not be left readable to untrusted local principals.
- **Location:** `docs/runbooks/ENVIRONMENT.md:3`, `scripts/backup.mjs:85`, `docs/runbooks/BACKUP_RESTORE.md:32`, `.gitignore:5`, Windows ACL metadata on `.env.local`, `.env.deploy`, `env.txt`, `.tmp-preview.env`, `.tmp-prod-env`, `.tmp-production.env`, `.vercel`, and `backups/`
- **User or business harm:** Any process running under the sandbox identities named on this workstation can read operator env files and local exports that are meant to stay private. That can expose database access, provider access, credential hashes, and private operational records.
- **Evidence:** The environment runbook says the repo is public and that `.env.local` contains active local database settings and a project-scoped Neon key, while `.env.deploy` is an active fallback and the temp env files are provider export artifacts. `scripts/backup.mjs` actively reads `DATABASE_URL` from `.env.local`, `.env.deploy`, or `env.txt` when the process does not already provide one. The backup runbook says local exports contain the complete database, including credential hashes and private operational records, and that Windows inherits the parent folder ACL. The metadata-only ACL check showed inherited `ReadAndExecute` for `DESKTOP-GDDDN71\CodexSandboxUsers` on all six root env files, `.vercel`, and `backups/`. `Get-LocalGroupMember` showed that group contains `CodexSandboxOffline` and `CodexSandboxOnline`.
- **Safe reproduction:** Metadata only: `Get-Acl` on the secret-bearing paths and `Get-LocalGroupMember -Group 'CodexSandboxUsers'`. No file contents were read.
- **Connection traced:** Repo-local secret-bearing file -> inherited sandbox-reader principal -> local script/provider/database authority or full-database export.
- **Root cause:** The project uses ignored repo-local files and folders as operator secret storage and export destinations, but it does not apply Windows-specific ACL hardening to keep those paths out of reach of local sandbox users.
- **Connections and similar locations checked:** `.gitignore`, `scripts/backup.mjs`, `docs/runbooks/ENVIRONMENT.md`, `docs/runbooks/BACKUP_RESTORE.md`, root env files, `.vercel`, and `backups/`
- **Durable fix:** Move operator secrets out of the repo tree into an approved OS/provider secret store, make scripts require those sources instead of repo-local fallbacks for production-sensitive operations, harden ACLs on any remaining backup/export directory, and rotate every secret that lived in the exposed paths.
- **Why this is not a band-aid:** It removes the shared-workspace secret-storage pattern instead of renaming files or relying on ignore rules that do not enforce access.
- **Pre-fix proof:** Repeat the metadata-only ACL check and prove no repo-local env or backup path readable by sandbox accounts remains; prove the scripts still function when secrets come only from the intended secret store.
- **Verification:** Re-run the ACL inspection, run local operator-script smoke tests with secrets supplied outside the repo, and verify backups are written only to a private location outside the workspace.
- **Regression and rollback risk:** Operator tooling will break until secret sourcing is updated; rollback must not restore old readable copies of secrets into the repo tree.
- **Unknowns:** Secret values were intentionally not read, and the sandbox identities were not impersonated during this audit.

### UNS-002: Concurrent root-key rotation can issue two replacement keys from one old key

- **Severity:** BLOCKER
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** `docs/SYSTEM_DESIGN.md:24` and public leak-response copy say `/api/rotate` kills the old key while preserving the resident's identity and property.
- **Location:** `src/core.ts:61`, `src/index.ts:269`, `docs/SYSTEM_DESIGN.md:24`, `test/routes.test.ts:1253`
- **User or business harm:** Two callers who know the same current root key can each receive a 200 response with a different replacement key, but only the last stored hash survives. A resident can save the wrong returned key and lock themselves out of their identity despite following the documented recovery path.
- **Evidence:** `authRootKey` verifies the presented secret in a standalone database statement. `/api/rotate` then does a separate event-count query and an unconditional `UPDATE residents SET secret_hash = ... WHERE id = resident.id`, returning the fresh secret regardless of whether another request already rotated the resident between authentication and update. There is no transaction spanning authentication and update, and unlike `scripts/restore-key.mjs`, there is no compare-and-swap against the old hash. The existing route test covers only the single-request happy path.
- **Safe reproduction:** Deterministic interleaving proof from the source: request A authenticates with the old key, request B authenticates with the same old key before A updates `secret_hash`, both pass the daily-count query, A stores new hash A, B stores new hash B, and both return 200. Key A is dead as soon as B commits.
- **Connection traced:** Caller with current root key -> `authRootKey`/`residentBySecret` -> daily rotate count -> unconditional `UPDATE residents ... WHERE id = resident.id` -> returned replacement key.
- **Root cause:** Rotation verifies possession and mutates the stored key in separate autocommit statements without row versioning or compare-and-swap on the presented secret.
- **Connections and similar locations checked:** `scripts/restore-key.mjs` uses `secret_hash IS NOT DISTINCT FROM $3` to protect against stale updates; OAuth refresh rotation and authorization-code exchange also use single-use database operations rather than this split pattern.
- **Durable fix:** Make rotation a single statement or explicit transaction keyed by the currently presented hash or a rotation version, return success only when exactly one row was changed, and add a concurrency test proving that at most one replacement key can be issued from one starting key.
- **Why this is not a band-aid:** It fixes the stale-auth race at the state transition itself instead of adding retries or hiding duplicate 200 responses.
- **Pre-fix proof:** Add a failing concurrent-rotation test that sends two simultaneous `/api/rotate` requests with the same starting key and proves that the current implementation can return two different replacement keys while only one remains valid.
- **Verification:** Re-run the new concurrency test, re-run normal single-rotation tests, and verify the old key is dead while exactly one returned replacement key authenticates.
- **Regression and rollback risk:** Clients that retry rotation may now see 409/401 instead of a second 200; rollback must not restore the split-statement flow.
- **Unknowns:** No live concurrent database requests were sent during this audit.

### UNS-003: Rotating the root key does not revoke existing hosted-chat grants

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** `docs/features/HOSTED_CHAT_SIGNIN.md:19` says the root key remains the root of resident identity; the public leak-response guidance says to rotate immediately if the key is leaked.
- **Location:** `src/index.ts:269`, `src/oauth-store.ts:359`, `src/oauth-store.ts:505`, `docs/features/HOSTED_CHAT_SIGNIN.md:19`
- **User or business harm:** After a resident rotates the permanent key, any already-issued hosted-chat connector grant can continue acting as that resident until the token family expires or the client voluntarily revokes it. A user who rotates because of compromise has no resident-driven way to cut off those delegated sessions.
- **Evidence:** `/api/rotate` only changes `residents.secret_hash` and inserts a rotate event. OAuth code exchange creates 30-day token families in `oauth_token_families`, and access resolution checks only token-family status, resource, scope, expiry, and resident id. There is no root-key version check in `resolveOAuthAccessToken`, and the only revoke route is `/oauth/revoke`, which requires a token plus client id. The Release 2 spec explicitly says future recovery will revoke the lost root key and existing connector grants, which confirms Release 1 does not.
- **Safe reproduction:** Static trace only; no live token issuance or live revocation was exercised beyond local tests that show explicit `/oauth/revoke` works.
- **Connection traced:** Resident approves hosted client with current root key -> token family issued -> resident later calls `/api/rotate` -> hosted client still resolves through `residentByOAuthAccessToken`.
- **Root cause:** Hosted connector grants are not bound to root-key lifecycle, and rotate does not revoke the resident's token families.
- **Connections and similar locations checked:** `src/oauth.ts`, `src/oauth-store.ts`, `docs/features/HOSTED_CHAT_SIGNIN.md`, `test/oauth-flow.test.ts`; refresh-token reuse revokes a family, but rotate does not.
- **Durable fix:** Track a resident key version or rotation epoch on token families and reject families from older versions, or revoke all resident token families inside rotate/recovery. Add a resident-visible revoke-all path if delegated sessions are intended to be manageable without knowing each client token.
- **Why this is not a band-aid:** It ties delegated authority to the root identity lifecycle instead of asking users to hunt down each hosted client token.
- **Pre-fix proof:** Add an integration test that issues a hosted grant, rotates the root key, and proves the old grant still works today.
- **Verification:** Re-run OAuth browser-flow tests, explicit revocation tests, and a new rotate-revokes-grants test; confirm legacy bearer-key flows still work.
- **Regression and rollback risk:** Existing hosted sessions may be intentionally terminated after rotation; rollout must communicate that behavior and monitor connector re-auth failures.
- **Unknowns:** The code may intentionally preserve hosted sessions across rotation, but that conflicts with the public leak-response story and leaves a compromise-recovery gap.

### UNS-004: `scripts/restore-key.mjs` can silently seize any resident identity and writes raw replacement keys under `backups/`

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Support/admin powers should be narrow and logged; `src/index.ts:261` says there is no recovery and whoever holds the key is the resident, while `src/index.ts:511` says every use of maintainer power is public.
- **Location:** `scripts/restore-key.mjs:161`, `docs/runbooks/BACKUP_RESTORE.md:38`, `src/index.ts:256`, `src/index.ts:489`, `docs/features/HOSTED_CHAT_SIGNIN.md:11`
- **User or business harm:** Any operator with database credentials can replace a resident's root key outside the public recovery contract, create a raw replacement secret inside the repo's backup area, and leave no public audit event tying that identity takeover to a support or incident action.
- **Evidence:** The script looks up any resident by handle, generates a new raw `1f3d9_sk_...` secret, writes it to `backups/`, compare-and-swap updates `residents.secret_hash`, and tells the operator to deliver it and tell the resident to call `/api/rotate`. The script does not write an event, moderation record, or official audit trail. The public registration response says there is no recovery, Release 1 sign-in docs say recovery does not ship yet, and `/api/official` says every maintainer power use is public via moderation events.
- **Safe reproduction:** Static source review and operator-script tests only. No database mutation or secret-file creation was performed by this audit.
- **Connection traced:** Operator DB credential -> restore script -> repo-local raw replacement secret -> resident `secret_hash` override -> resident identity changes without public trace.
- **Root cause:** A private operator recovery path shipped outside the public identity contract and outside append-only public audit history.
- **Connections and similar locations checked:** `test/operator-scripts.test.ts` verifies safe file creation/cleanup but does not require audit logging or a recovery policy check; `docs/runbooks/BACKUP_RESTORE.md` explicitly discusses one-time recovery-key files.
- **Durable fix:** Remove this path until the reviewed recovery feature ships, or redesign it as an explicit incident-only recovery flow that stores the replacement secret outside the repo, revokes connector grants, and records both private operator audit evidence and the promised public identity-power trail.
- **Why this is not a band-aid:** It aligns actual operator authority with the stated product contract instead of hiding a stronger backdoor behind a helper script.
- **Pre-fix proof:** Add a failing test that any resident-key override must emit an audit record and must not write a raw key into repo-local `backups/`.
- **Verification:** Re-run operator-script tests, new audit-trail tests, and recovery-flow tests that prove grant revocation and secret handling match the contract.
- **Regression and rollback risk:** Removing the script reduces emergency recovery options until a reviewed replacement exists; rollback must not silently restore undocumented identity-seizure tooling.
- **Unknowns:** This audit could not see any out-of-band incident logging or manual operator runbook outside the repository.

### UNS-005: Legacy `/api/register` throttling is nonatomic and can be exceeded by concurrent requests

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Identity creation rate limits should fail closed under burst traffic, not only under serial traffic.
- **Location:** `src/index.ts:188`, `src/oauth.ts:495`, `src/oauth-store.ts:541`
- **User or business harm:** A burst of concurrent unauthenticated registration calls can create more residents than the intended 3-per-IP and 300-global hourly limits, increasing spam and abuse against the public identity door.
- **Evidence:** Legacy `/api/register` deletes old rows, reads hourly counts from `reg_log`, and only later inserts into `reg_log` as part of resident creation. Concurrent requests can all observe the same below-limit counts and all proceed. The hosted-chat registration path uses `consumeOAuthRateLimit`, which atomically reserves capacity with `INSERT ... ON CONFLICT ... WHERE used < maximum`, showing the project already has a safer pattern for the same problem.
- **Safe reproduction:** Static comparison only; the local tests prove spoofed-IP handling but do not cover concurrent overrun.
- **Connection traced:** Anonymous caller -> `/api/register` count snapshot from `reg_log` -> resident insert -> `reg_log` insert after admission decision.
- **Root cause:** The legacy registration limiter is built from separate read and write statements instead of an atomic reservation.
- **Connections and similar locations checked:** `test/routes.test.ts` checks trusted client IP hashing; `test/oauth-register-limits.test.ts` checks the hosted path's atomic bucket usage.
- **Durable fix:** Reuse the OAuth atomic rate-limit table or otherwise reserve quota in one statement before resident creation begins.
- **Why this is not a band-aid:** It removes the race from the limiter rather than adding more counters around it.
- **Pre-fix proof:** Add a concurrent registration test that sends more than three same-IP requests in one burst and proves the current legacy door can admit too many.
- **Verification:** Re-run the new concurrency test, existing spoofed-IP tests, and both registration doors' happy paths.
- **Regression and rollback risk:** A stricter limiter may reject some currently succeeding bursts; rollback must not reintroduce the split count/insert logic.
- **Unknowns:** No burst traffic was sent during this audit.

## Questions Needing Human Review

- **Question:** Do any historical public note rows still contain live or formerly live credentials, and if so do raw public HTTP/window routes redact them the way hosted MCP does?
  - **Why it matters:** `src/mcp.ts:646` explicitly says historical notes can predate the public-write credential guard and only hosted MCP note bodies get selective redaction. If historical rows exist, unauthenticated public reads may still leak old credentials or recovery artifacts.
  - **Available evidence:** `src/input.ts:11` blocks new public writes that look like credentials. `test/mcp-auth.test.ts:403` proves hosted `look` redacts credential-bearing note bodies. I did not find matching evidence for unauthenticated raw `/api/*` or `/window` reads.
  - **Missing evidence:** A safe offline scan of note bodies in a disposable database copy and a paired public-read check against those rows.
  - **Safest next check:** Restore a disposable local copy from a safe snapshot, scan note bodies with the credential regex, and if any match, test raw public read routes against that copy without touching production.
  - **Should release wait:** Yes if any historical credential-bearing rows are found; not enough evidence today to admit it as a shipped defect from source alone.

## Ordered Repair Plan

1. Contain `UNS-001` first: move secrets and exports out of the repo tree, harden ACLs, and rotate anything that lived in readable workspace paths without deleting evidence first.
2. Add failing behavior-level proofs for `UNS-002`, `UNS-003`, and `UNS-005`: concurrent rotate, rotate-does-not-revoke-grants, and concurrent legacy-register tests.
3. Repair the shared root causes: make rotate atomic (`UNS-002`), bind hosted grants to root-key lifecycle (`UNS-003`), and atomically reserve register capacity (`UNS-005`).
4. Decide the operator authority contract for `UNS-004`, then either remove `scripts/restore-key.mjs` or replace it with an auditable, reviewed recovery flow that uses private storage outside the repo and revokes hosted grants.
5. Handle existing stored data and environment differences safely: revoke or rotate any credential that lived in repo-local secret paths, review any existing backup exports, and reconcile any live hosted token families created before the revoke-on-rotate fix.
6. Run targeted regressions plus whole-product checks: `npm test`, `npm run typecheck`, new concurrency tests, hosted OAuth browser-flow tests, and operator-script tests.
7. Release only in reversible stages, monitor rotate failures, unexpected re-authentication drops, and secret-path access failures, then run a new full `$unshittify` audit citing this report.

## Verification and Release Gates

- Success conditions:
  - No repo-local env or backup/export path carrying production-sensitive material is readable by sandbox accounts.
  - Concurrent `/api/rotate` admits at most one successful replacement from one starting key.
  - Root-key rotation invalidates old hosted token families for that resident.
  - Any resident-key override path is explicitly authorized, audited, and does not drop raw secrets into the repo tree.
  - Legacy `/api/register` cannot exceed its documented hourly caps under concurrent load.
- Safe commands:
  - `npm test`
  - `npm run typecheck`
  - Metadata-only ACL checks (`Get-Acl` and `Get-LocalGroupMember`) on the intended private secret/export locations
- Manual checks:
  - Review secret sourcing for local operator scripts without printing values.
  - On a disposable non-production database, run the new concurrent rotate/register tests and a rotate-revokes-grants check.
  - If historical-note scanning is added, run it only on a disposable restored copy.
- Forbidden live actions:
  - No production DB writes, no live payments, no live provider secret reads, no live credential rotation through unaudited scripts during verification.
- Rollback conditions:
  - More than one rotate response still succeeds from one starting key.
  - Hosted connectors continue acting after rotate.
  - Secret-dependent operator flows start recreating repo-local readable env files.
  - Any recovery or override path still produces an unlogged resident key change.
- Evidence required before release:
  - Failing pre-fix tests captured for each repaired defect.
  - Passing post-fix targeted tests and full local suite.
  - Fresh metadata proof that secret-bearing paths are private.
  - A new full audit with a fresh skeptic if the harness supports one.

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

- Fresh skeptic status: unavailable in this harness at audit time; no collaborator tool was callable for a separate overseer pass.
- Inspector roles completed: single-agent inspection across architecture/connections, correctness/operations, and security/identity surfaces.
- Upheld items: none by an independent skeptic.
- Changed items: none by an independent skeptic.
- Disputed items: none by an independent skeptic.
- Rejected items: none by an independent skeptic.
- New candidates: none by an independent skeptic.
- Same-model limitation: this is a single-agent audit - independently unverified. Evidence levels were capped at E3 or below, and no "no blocker found" verdict was used.

## Honest Limitations

- Static review cannot prove the contents or current validity of secret files because those values were intentionally not read.
- Live Vercel, Neon, Base, and 1F3EA systems were not touched.
- No production or preview browser sign-in was exercised; all OAuth evidence came from source and local tests.
- Existing `docs/audits` reports were intentionally not read. A pre-existing untracked `docs/audits/GPT-5_identity_Audit_Findings.md` was treated as concurrent work and excluded from evidence.
- No collaborator tool was available for the required fresh-skeptic pass, so this report is single-agent and independently unverified.
- `npm test` and `npm run typecheck` produced console output only; no generated files were observed.
- The ACL findings prove readable paths and the code/runbook connections around them, but they do not prove which exact secret values are still live today.
- Historical public-content leakage remains an E1 question because no offline database snapshot was inspected.
- Outside systems and full platform-specific file-permission behavior were not exhaustively covered beyond the local Windows ACL metadata checks documented here.
