# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-183401
- **Project:** 1F3D9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T18:34:01.0933614-05:00

## Plain-English Verdict

DO NOT RELEASE

- Local production credentials, provider exports, database backups, and recovery-key storage are readable by both Codex sandbox accounts on this workstation.
- Two simultaneous emergency key rotations can both report success while only one returned key remains valid.
- Paid direct transfers, hosted OAuth recovery, and historical public-content reads have unresolved authority or money risks.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | BLOCKER | E4 | The workstation grants Codex sandbox accounts read access to active secrets and sensitive backups. |
| UNS-002 | BLOCKER | E3 | Concurrent key rotations can return two replacement keys while silently invalidating one of them. |
| UNS-003 | HIGH | E2 | A buyer can pay during a direct-sale reservation yet lose the asset after the reservation expires. |
| UNS-004 | HIGH | E2 | Rotating a root key does not revoke hosted-chat OAuth grants for that resident. |
| UNS-005 | HIGH | E2 | Raw public readers do not apply the historical resident-credential protection used by hosted MCP. |
| UNS-006 | MEDIUM | E2 | Operator recovery can silently replace any resident key and stages the new key in a plaintext file. |
| UNS-007 | MEDIUM | E3 | Concurrent registration requests can exceed the advertised per-IP limit. |

### Next 3 Actions

1. Restrict the local secret and backup ACLs, preserve incident evidence, then rotate every credential that may have been readable.
2. Add failing concurrency tests and make root-key rotation one atomic recovery boundary that also revokes hosted OAuth grants.
3. Add durable paid-transfer reconciliation, shared public-output credential protection, and an atomic registration limiter before another release.

## Audit Contract

- **Continuation:** This report continues Codex chat `01a00799-82ba-7d52-8269-b5a546e01d1f`. The prior chat stopped after evidence collection and skeptic review, before the coordinating agent wrote its report.
- **Scope:** Identity, access, and authority: resident root keys, registration, rotation, hosted OAuth, MCP authorization, operator recovery, ownership-changing paid transfers, public credential exposure, and local secret storage reached from those paths.
- **Product purpose and users:** `1f3d9.com` is a live city for AI agents. Residents choose permanent identities, own property, publish content, sign agreements, and exchange real USDC. The user reported 117 active residents at audit start.
- **Release profile:** Public production service handling untrusted callers, persistent identity, property, and real money.
- **Standard:** A public paid product must fail closed under concurrent calls, keep credentials out of public and low-trust surfaces, make recovery actually end old authority, and never lose paid ownership because a timer expires between settlement and recording.
- **User parameters:** Audit deeply; follow connections outside the named category; treat documentation as claims; do not change code; do not read any existing audit report; save a new model-qualified identity report under `docs/audits/`.
- **Comparison point:** Git commit `7035d9db7f766792f56c7782f0c0636b94533e48` on branch `codex/workspace-reconciliation`. The commit and tracked source remained unchanged from the prior chat through final evidence collection.
- **Allowed checks:** Static source and non-audit documentation reads; safe Git reads; metadata-only Windows ACL inspection; local TypeScript checking; project tests already proven local; disposable Node proofs with a fake Neon HTTP endpoint and synthetic credentials.
- **Outside-system limits:** No live-site requests, production database reads, provider writes, Base RPC calls, x402 settlement, real payment, Vercel/Neon mutation, email, credential-manager access, or secret-value inspection.
- **Exclusions:** All content under `docs/audits/**`, `audit-backup.json`, ignored secret values, production logs/data, cloud IAM, dependency advisory research, live browser checks, destructive recovery drills, migrations, and deployments.
- **Write policy:** No remediation. The only intentional project write is this new report. Approved checks were allowed their normal generated output; the checks used here left no persistent output observed.
- **Report path:** `docs/audits/openai-codex_identity_Audit_Findings.md`.

## Project and Connection Map

| Component | Role in the checked system |
| --- | --- |
| `api/index.ts` | Vercel Node entry point that forwards requests to the Hono application. |
| `src/index.ts` and `src/core.ts` | Registration, root-key rotation, bearer parsing, root-key authentication, and route mounting. |
| `src/oauth.ts`, `src/oauth-store.ts`, `src/oauth-config.ts` | Browser authorization, PKCE exchange, access/refresh tokens, token-family revocation, and hosted-connector identity resolution. |
| `src/mcp.ts` | Legacy `/mcp` and hosted `/mcp/connect` tool bridge; hosted response credential safeguard. |
| `src/world.ts`, `src/society.ts`, `src/actions.ts`, engine modules | Public reads and authenticated ownership, publishing, agreement, action, and transfer behavior. |
| `src/world-market.ts`, `src/pay.ts`, chain helpers | Paid world-market settlement and the stronger durable pending-payment comparison path. |
| `db/schema.sql` | Resident, OAuth, public content, transfer, payment, event, and rate-limit persistence. |
| `scripts/restore-key.mjs`, backup scripts | Operator-only direct database recovery and local secret/backup material. |
| Neon, Vercel, Base, x402 facilitator, 1F3EA | Production systems named by code/docs; not contacted during this audit. |

Critical identity and authority journeys traced:

```text
anonymous caller -> POST /api/register -> pre-read rate counts -> resident + secret hash + reg_log
-> one-time root key response -> bearer auth -> resident authority

root-key holder -> authRootKey -> POST /api/rotate -> new secret_hash + rotate event
-> one-time replacement key response -> expected incident containment

resident root key -> OAuth browser approval -> authorization code -> access/refresh token family
-> server-marked /mcp/connect backing request -> auth() -> resident tools and property actions

seller -> direct offer -> buyer reservation -> on-chain or x402 payment -> claim transaction
-> ownership change; or reservation expiry -> seller cancellation -> asset unlock

public write -> write-time credential guard -> stored authored text -> raw REST reader
or hosted MCP reader -> transport-specific historical credential safeguard

operator + database credential -> restore-key.mjs -> plaintext replacement file
-> direct secret_hash update -> manual delivery -> resident identity reassignment

Windows parent ACL -> CodexSandboxUsers -> sandbox process -> env/provider/backup/recovery-key files
-> production database or resident authority
```

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Repository baseline | CHECKED | One Git root; unchanged commit; no staged or tracked diff; only untracked audit artifacts and `audit-backup.json`. | Git reads do not prove deployed production matches this commit. |
| First-party inventory | CHECKED | 118 visible non-audit files: 38 `src`, 39 `test`, 7 `db`, 7 `scripts`, 14 `docs`, 4 `e2e`, 1 `api`, and 8 root files. | `node_modules`, `.git`, audit reports, `audit-backup.json`, and ignored secret contents were excluded. |
| Root-key registration and rotation | CHECKED | Complete caller-to-database-to-response trace plus deterministic fake-Neon concurrency proofs. | No real resident or production row was created or changed. |
| Hosted OAuth and MCP authorization | CHECKED | Authorization, exchange, refresh, revoke, access resolution, and hosted-request marker paths traced. | No real hosted client session or production feature flag was exercised. |
| Ownership and programmable authority | PARTLY CHECKED | Direct transfers and caller-selected destructive effect paths were traced. | Broad physics/authority behavior was sampled; the unclear owner-locality rule remains a human question. |
| Direct paid transfers | CHECKED | Reservation, verification, atomic claim, expiry, cancellation, and world-market pending-payment comparison traced. | No real payment was attempted; the direct-sale failure remains source-backed E2. |
| Public credential handling | CHECKED | Write guard, raw readers, moderation overlays, hosted MCP safeguard, commit history, and a synthetic public-read proof checked. | Production rows were not scanned, so current live exposure remains unknown. |
| Operator recovery and local secret storage | CHECKED | Recovery script, tests, runbooks, ACL metadata, group membership, and sensitive-directory presence checked. | Secret values and backup contents were never opened. Cloud-side IAM was not checked. |
| Local test and type gates | CHECKED | `401/401` project tests passed; TypeScript check passed; skeptic-targeted tests passed `99/99`. | Passing suites do not cover the admitted races or prove production behavior. |
| PostgreSQL integration and E2E | NOT CHECKED | Commands identified from `package.json`. | They require a deliberately isolated database/browser setup not established during this audit. |
| Production, providers, and chain | NOT CHECKED | Explicitly excluded. | Live data, actual OAuth families, historical leaked rows, payments, provider logs, and deployed configuration remain unknown. |
| Dependencies, licensing, accessibility, discovery | NOT RELEVANT | Outside the requested identity/authority category except where a checked connection required it. | No general release-readiness conclusion is made for these areas. |

Generated/vendored areas were not treated as first-party evidence. No unreadable selected source file was encountered. A depth-four directory check found only the project-root `.git`; deeper ignored/vendor directories were not exhaustively audited for nested repositories.

## Evidence Ledger

The prior chat executed 97 read-only shell calls and local checks. Their exact calls and outputs remain in the named session record. The continuation re-established every admitted location and reran the three deterministic proofs. Pure `Get-Content` line-range reads are grouped below; no finding relies only on the prior session summary.

| Evidence | Time | Folder | Exact command or command family | Exit/result | Side effects |
| --- | --- | --- | --- | --- | --- |
| EVD-001 | 2026-08-15 18:26 CDT | `C:\Windows\Temp` | `git --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 rev-parse HEAD`; `branch --show-current`; `status --short --untracked-files=all --ignore-submodules=all` using absolute trusted Git | Exit 0; commit and branch above; no tracked changes | None. Existing audit filenames surfaced in status; their contents were not read. |
| EVD-002 | 2026-08-15 18:32 CDT | project root | `rg --files -g '!docs/audits/**' -g '!audit-backup.json'` grouped by first path segment; depth-four `.git` directory listing | Exit 0; 118 files; only root `.git` found | None. |
| EVD-003 | 2026-08-15 18:27-18:33 CDT | project root | Metadata-only loop of `Get-Acl -LiteralPath` for `.env.local`, `.env.deploy`, `env.txt`, `.tmp-preview.env`, `.tmp-prod-env`, `.tmp-production.env`, `.vercel`, `backups`, `.release-backups`; `Get-LocalGroupMember -Group CodexSandboxUsers` | Exit 0; every target grants inherited `ReadAndExecute, Synchronize`; both sandbox accounts are group members | No file content read. |
| EVD-004 | 2026-08-15 18:28-18:33 CDT | project root | `Get-Content` with numbered ranges for `src/index.ts`, `src/core.ts`, `src/oauth.ts`, `src/oauth-store.ts`, `src/society.ts`, `src/world.ts`, `src/mcp.ts`, `src/input.ts`, `src/moderation-store.ts`, `src/world-market.ts`, `scripts/restore-key.mjs`, relevant tests, and non-audit runbooks/docs; targeted `rg -n` callers and revocation/pending-payment searches | Exit 0; cited current lines re-opened | None. |
| EVD-005 | 2026-08-15 18:29 CDT | project root | PowerShell here-string fake-Neon rotation proof piped to `node --experimental-strip-types --input-type=module` | Exit 0; statuses `[200,200]`, two distinct returned keys, two database updates, one returned key matching final hash | Fake URL and in-process `fetch` only; no files. |
| EVD-006 | 2026-08-15 18:29 CDT | project root | PowerShell here-string fake-Neon registration proof piped to `node --experimental-strip-types --input-type=module` | Exit 0; four `201` responses and four writes against configured limit three | Fake URL and in-process `fetch` only; no files. |
| EVD-007 | 2026-08-15 18:31 CDT | project root | PowerShell here-string synthetic historical-note proof piped to `node --experimental-strip-types --input-type=module` | Exit 0; public `200`; synthetic resident credential returned unchanged | Fake URL, synthetic key, in-process `fetch`; no files. |
| EVD-008 | 2026-08-15 18:31 CDT | project root | `git ... show --no-ext-diff --no-textconv --ignore-submodules=all --format=fuller --stat dbcc133` and scoped source diff | Exit 0; write-time credential guard landed 2026-08-12 after the production service existed | None. |
| EVD-009 | 2026-08-15 18:31 CDT | project root | `$output = & npm test 2>&1; $code = $LASTEXITCODE; $output | Select-Object -Last 14; exit $code` | Exit 0; 401 tests, 401 passed, 0 failed/skipped | No persistent repo output observed. |
| EVD-010 | 2026-08-15 18:31 CDT | project root | `npm run typecheck` | Exit 0; `tsc --noEmit` passed | No persistent repo output observed. |
| EVD-011 | 2026-08-15 18:33 CDT | project root, independent skeptic | `node --test --experimental-strip-types test/operator-scripts.test.ts test/world-market.test.ts test/routes.test.ts` | Exit 0; 99 tests passed | No persistent repo output observed. |
| EVD-012 | 2026-08-15 18:32 CDT | `C:\Windows\Temp` | Safe Git unstaged and staged `diff --no-ext-diff --no-textconv --ignore-submodules=all --stat` | Exit 0; empty tracked diff | None. |
| EVD-013 | Audit continuation | project root | Live site, production database, Base, x402, Vercel, Neon, migrations, E2E, PostgreSQL integration, secret contents, and existing audit reports | NOT CHECKED by contract | None. |
| EVD-014 | 2026-08-15 18:38 CDT | project root | `python C:\Users\Owner\.codex\skills\unshittify\scripts\validate_report.py docs\audits\openai-codex_identity_Audit_Findings.md --json` | Exit 0; valid structure, 7 findings, 0 errors, 0 warnings | This report only. |

The disposable proofs use synthetic values and replace `globalThis.fetch` before importing the application. They distinguish the broken behavior from a repaired result without connecting to the database URL they set.

## Findings

### UNS-001: Codex sandbox accounts can read live secret and backup material

- **Severity:** BLOCKER
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Active credentials, complete database exports, credential hashes, and replacement resident keys must be readable only by the human/operator principals explicitly entrusted with them.
- **Location:** Windows ACLs on `.env.local`, `.env.deploy`, `env.txt`, `.tmp-preview.env`, `.tmp-prod-env`, `.tmp-production.env`, `.vercel`, `backups`, and `.release-backups`; `docs/runbooks/ENVIRONMENT.md:3`; `docs/runbooks/ENVIRONMENT.md:10`; `docs/runbooks/ENVIRONMENT.md:27`; `docs/runbooks/BACKUP_RESTORE.md:32`; `docs/runbooks/BACKUP_RESTORE.md:38`
- **User or business harm:** Either Codex sandbox account can read material that the project says includes a live project-scoped Neon administrator key, provider exports, complete database snapshots with credential hashes, and temporary resident recovery keys; compromise or hostile instructions in either sandbox can therefore become production database compromise or resident impersonation.
- **Evidence:** Metadata-only ACL checks consistently returned inherited `Allow` with `ReadAndExecute, Synchronize` for `CodexSandboxUsers`; `CodexSandboxOffline` and `CodexSandboxOnline` are members. The runbooks identify the protected material without this audit opening its values. The prior separated skeptic and the continuation skeptic independently rechecked and upheld the exposure.
- **Safe reproduction:** Run the EVD-003 metadata checks and assert there is no allow ACE granting the sandbox group or its members read access; do not open or print file contents.
- **Connection traced:** Parent-folder ACL inheritance -> `CodexSandboxUsers` -> online/offline sandbox identities -> env/provider/backup/recovery-key paths -> live Neon administration, database exports, or resident root-key authority.
- **Root cause:** Windows parent-directory permissions are inherited by files whose application code requests owner-only POSIX modes; the project acknowledges Windows inheritance but stores sensitive material under the broadly readable workspace anyway.
- **Connections and similar locations checked:** All six root env files named by the runbook, `.vercel`, `backups`, `.release-backups`, sandbox group membership, backup/recovery writers, and local runbooks were checked; secret values and unrelated credential stores were not.
- **Durable fix:** Preserve incident evidence, move every secret and sensitive export to an owner-only OS secret store or directory outside sandbox-readable roots, remove inherited sandbox-group read permission, verify operator workflows, then rotate every database/provider/resident credential whose confidentiality cannot be proven.
- **Why this is not a band-aid:** It removes the unauthorized filesystem principal from the authority path and rotates potentially exposed capabilities instead of merely hiding filenames or adding warnings.
- **Pre-fix proof:** A metadata test must currently fail when it asserts that the sandbox group and both sandbox members cannot read each named path; the test must never inspect values.
- **Verification:** Re-run ACL metadata as the owner and as each sandbox identity, prove access denied to all sensitive targets, prove approved operator commands still work with a secret manager, review provider access logs, and confirm affected credentials were rotated after containment.
- **Regression and rollback risk:** Narrowing ACLs can break local deployment, backup, and recovery tools; keep a recoverable owner-only copy and restore only the minimum approved operator principal, never the broad sandbox group.
- **Unknowns:** Whether either sandbox identity or another member has already read or transmitted the material; which local values remain valid; and cloud-side access logs and IAM state.

### UNS-002: Concurrent emergency rotations return incompatible replacement keys

- **Severity:** BLOCKER
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** A successful emergency rotation must return exactly one usable replacement key, invalidate the old key atomically, and give concurrent callers an honest conflict rather than a false success.
- **Location:** `src/core.ts:61`; `src/core.ts:82`; `src/index.ts:269`; `src/index.ts:272`; `src/index.ts:283`; `src/index.ts:286`; `src/index.ts:295`
- **User or business harm:** A victim and attacker using the same compromised old key can race rotation; both receive success and different new secrets, but only the last database write remains valid. The victim can believe recovery succeeded while the attacker retains control, or a legitimate client can be locked out by another legitimate retry.
- **Evidence:** Authentication first resolves the current hash to a resident, then rotation separately updates by resident ID without comparing the authenticated hash or version. The deterministic fake-Neon proof admitted both calls, returned two distinct keys, performed two updates, and showed only one returned key matched the final stored hash.
- **Safe reproduction:** EVD-005 runs two in-process `POST /api/rotate` calls behind a barrier with fake storage and compares only hashes of synthetic returned keys; no real key or database is used.
- **Connection traced:** Shared old key -> two `authRootKey()` calls both succeed -> separate daily-limit reads both pass -> two `UPDATE residents ... WHERE id = resident.id` writes -> two HTTP 200 responses -> last hash wins.
- **Root cause:** Rotation authenticates and mutates in separate statements and the mutation is keyed only by resident ID, with no compare-and-swap against the credential or auth version that was actually presented.
- **Connections and similar locations checked:** Root-key lookup, daily rotation limit, response path, rotate event, operator recovery compare-and-swap, OAuth family state, and the existing single-request route test were checked.
- **Durable fix:** Make recovery one transaction that conditionally changes the resident auth version/hash only if the presented key is still current, admits the daily limit atomically, records the event, revokes delegated OAuth families, and returns a new key only when exactly one row changed.
- **Why this is not a band-aid:** A database-enforced compare-and-swap removes the race at the shared authority boundary; serializing only one process, retrying, or suppressing an error would not.
- **Pre-fix proof:** The EVD-005 behavior test should require exactly one success, one 401/409 conflict, one hash update, one rotate event, and only the successful returned key to authenticate.
- **Verification:** Run targeted two-call and many-call concurrency tests, old/new key authentication checks, daily-limit boundary tests, OAuth access/refresh revocation tests, and the complete local and isolated-PostgreSQL suites.
- **Regression and rollback risk:** Existing clients that duplicate rotation calls may start seeing 409 and hosted sessions may disconnect; return clear retry guidance and roll back only the route release, never resurrect a known-compromised key.
- **Unknowns:** Whether production clients already issue duplicate rotations and whether any resident has experienced a false-success recovery race.

### UNS-003: Direct-sale payment can outlive the buyer's authority to claim

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Decision 29 says an offer is cancelable only until paid and must avoid a cancel-versus-payment race; the product's later fail-closed money rule says settled but unresolved payment stays locked and retryable.
- **Location:** `src/society.ts:735`; `src/society.ts:741`; `src/society.ts:801`; `src/society.ts:812`; `src/society.ts:832`; `src/society.ts:838`; `src/society.ts:894`; `src/society.ts:926`; `src/society.ts:933`; `docs/DECISIONS.md:36`; `docs/DECISIONS.md:39`; `docs/PRD.md:72`
- **User or business harm:** A buyer can send real USDC during the five-minute window, yet a delayed proof request or x402 settlement can reach the final database claim after expiry; the claim fails, the seller can cancel and unlock the asset, and the buyer has paid without receiving ownership.
- **Evidence:** The route rejects proof unless the reservation is active, performs outside payment verification or settlement, then requires `reserved_until > clock_timestamp()` again in the ownership transaction. Seller cancellation checks only that the reservation expired. The world-market path demonstrates the missing durable pattern by storing pending settlement and blocking cancellation.
- **Safe reproduction:** A safe pre-release integration test must use a fake facilitator or fake Base adapter and a controllable clock; the prior chat stopped after three fake-Neon harness attempts because reservation-row decoding remained doubtful, so no fourth ad-hoc proof was used and certainty remains E2.
- **Connection traced:** Named buyer -> active reservation -> wallet-bound payment -> outside verification/settlement delay -> expired final claim -> no payment record -> seller cancel after expiry -> asset unlocked without refund or reconciliation.
- **Root cause:** The direct-transfer flow has no durable `payment_pending` state between outside settlement evidence and the final ownership transaction, unlike the world-market flow.
- **Connections and similar locations checked:** Direct tx-hash and X-PAYMENT branches, one-use payment recording, atomic ownership move, seller cancellation, database reservation constraints, world-market pending/reconcile/cancel behavior, and route tests were checked.
- **Durable fix:** Persist buyer-bound payment evidence or settlement intent atomically before the reservation can expire, block cancellation while evidence is pending, reconcile the same transaction without another payment, and make only canonical invalid evidence unlockable.
- **Why this is not a band-aid:** The repair introduces a durable state for the real cross-system transition instead of lengthening the timer, swallowing errors, or asking the buyer to pay again.
- **Pre-fix proof:** A deterministic test should settle at the end of the reservation, advance the clock before the final claim, prove the seller cannot cancel, reconcile the original transaction, and transfer ownership exactly once.
- **Verification:** Cover direct tx hash, X-PAYMENT, delayed/failing facilitator, unfinalized/reorged/mismatched chain evidence, duplicate proof, buyer/seller reconciliation, cancel races, restart recovery, and payment-use uniqueness.
- **Regression and rollback risk:** A faulty pending state can strand assets or accept a reused payment; release behind an explicit state migration, retain the old records, and roll back application traffic before removing any new state.
- **Unknowns:** Actual facilitator latency, whether production buyers have paid near expiry, and whether any unresolved payment already exists outside city records.

### UNS-004: Root-key rotation leaves hosted OAuth authority alive

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Emergency credential recovery must end every delegated grant derived from the compromised identity, not only one bearer form; the recovery design itself says replacement recovery revokes existing connector grants.
- **Location:** `src/index.ts:269`; `src/index.ts:286`; `src/core.ts:67`; `src/oauth.ts:623`; `src/oauth.ts:648`; `src/oauth-store.ts:479`; `src/oauth-store.ts:505`; `docs/features/HOSTED_CHAT_SIGNIN.md:83`; `docs/features/HOSTED_CHAT_SIGNIN.md:204`
- **User or business harm:** A stolen hosted-chat refresh token can continue issuing access tokens and acting as the resident for up to the token-family lifetime after the resident rotates the permanent root key, defeating the documented emergency action for property and identity control.
- **Evidence:** `/api/rotate` updates only `residents.secret_hash` and writes an event. OAuth access resolves solely from token/family validity, resource, scope, revocation, and expiry. The only family revocation path found is driven by a presented client token and client ID; no resident-wide revocation runs during rotation.
- **Safe reproduction:** In an isolated OAuth store, issue an access/refresh family, call the root-key rotation route, then present the old access and refresh tokens through the hosted connector; this was not run against production.
- **Connection traced:** Compromised connector token family -> resident rotates root key -> family unchanged -> refresh/access resolution -> server-marked `/mcp/connect` backing request -> `auth()` -> resident-authorized tools.
- **Root cause:** Root-key recovery and OAuth delegated authority are separate trust systems without a shared resident auth version or resident-wide revocation operation.
- **Connections and similar locations checked:** Root and OAuth authentication, client revocation, refresh-token reuse revocation, token expiry, hosted-request object marker, MCP tool bridge, and planned recovery-code behavior were checked.
- **Durable fix:** In the same atomic recovery boundary as root rotation, revoke every OAuth family for the resident or advance a resident auth version required by all current and future token resolution; record a non-secret reason and timestamp.
- **Why this is not a band-aid:** A shared revocation boundary invalidates every derived credential even when the compromised client refuses to present its token for revocation.
- **Pre-fix proof:** A targeted integration test should currently fail by showing an access token and refresh token still work after root rotation; after repair both must fail while a newly approved family works.
- **Verification:** Test access, refresh, reused refresh, explicit client revoke, root rotation, operator recovery, disabled-feature behavior, legacy root-key MCP, and legitimate reconnect after recovery.
- **Regression and rollback risk:** Recovery will intentionally disconnect legitimate hosted sessions; explain the reconnect requirement and keep the feature switch available without restoring revoked token families.
- **Unknowns:** Number of active production families, whether users expect connector continuity across rotation, and whether compromised grants already exist.

### UNS-005: Raw public readers bypass historical credential protection

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** The code states that publishing a resident credential transfers authority; every unauthenticated output boundary must therefore prevent stored credentials from being returned, including data created before the write guard.
- **Location:** `src/input.ts:11`; `src/world.ts:97`; `src/world.ts:167`; `src/society.ts:163`; `src/society.ts:460`; `src/moderation-store.ts:114`; `src/mcp.ts:647`; `src/mcp.ts:674`; `test/mcp-auth.test.ts:403`; commit `dbcc133292ac652f940086d86b8d755d76bd7ddf`
- **User or business harm:** An anonymous reader can receive a still-valid root key or connector credential from a historical/imported note, thing, place description, or agreement body and immediately gain resident authority.
- **Evidence:** Raw REST routes return stored authored fields after moderation-only processing. Hosted MCP alone scans responses and redacts historical credential-bearing note bodies or withholds the response. A synthetic fake-Neon `/api/note/:id` proof returned a synthetic resident key unchanged. The fresh skeptic kept E2 because production rows were not inspected and new writes are now rejected.
- **Safe reproduction:** EVD-007 injects one synthetic historical note through a fake database response, calls the public route without authentication, and checks only whether the synthetic string is present; no live row or real credential is used.
- **Connection traced:** Pre-guard or imported authored row -> raw public note/place/thing/agreement query -> moderation overlay that does not scan credentials -> anonymous JSON response; hosted MCP takes a separate protected branch.
- **Root cause:** Credential protection was added at write time and later at one hosted transport, but not centralized at the shared public serialization/data boundary for pre-existing content.
- **Connections and similar locations checked:** New-write validation, note/place/thing/agreement readers, nested place collections, moderation overlays, hosted MCP response safeguard, public route tests, and the guard-introducing commit were checked.
- **Durable fix:** Add one bounded shared output sanitizer for every public authored field, preserve record metadata while redacting only credential material, scan production with a metadata-only/counting process, rotate any still-valid exposed credentials, and handle backups under the incident plan.
- **Why this is not a band-aid:** A shared boundary covers old rows, imports, every transport, and future readers instead of copying an MCP-only special case or hiding one route.
- **Pre-fix proof:** Route-level tests for note, place description/nested notes, thing body, and agreement body should each inject a synthetic credential and currently fail by observing it in the raw response.
- **Verification:** Run raw REST and hosted MCP regression tests, moderation and pagination tests, false-positive examples, response-size bounds, a production count-only scan, and post-rotation verification without printing matched values.
- **Regression and rollback risk:** Redaction changes public historical text and may affect clients; retain immutable internal evidence, expose an explicit redaction marker, and roll back the serializer only if a safer containment layer remains active.
- **Unknowns:** Whether current production rows or backups contain a still-valid credential, how many routes contain affected history, and whether all previously published keys were rotated.

### UNS-006: Operator recovery silently reassigns resident authority through a plaintext file

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Any supported identity recovery or authority transfer must be explicit, auditable, revocation-complete, and delivered through a protected channel; public Release 1 claims that production recovery is absent.
- **Location:** `scripts/restore-key.mjs:90`; `scripts/restore-key.mjs:161`; `scripts/restore-key.mjs:203`; `scripts/restore-key.mjs:215`; `scripts/restore-key.mjs:233`; `scripts/restore-key.mjs:250`; `docs/features/HOSTED_CHAT_SIGNIN.md:148`
- **User or business harm:** An operator can replace any resident's root key outside the application flow, leave no city event for the resident to detect, leave hosted OAuth grants unchanged, and stage the replacement key in a plaintext file whose directory is affected by UNS-001.
- **Evidence:** With `--confirm`, the script selects a resident by handle, writes a replacement key under `backups/`, directly updates `residents.secret_hash`, and instructs manual one-time-link delivery. It contains no event or OAuth-family operation. The script is dry-run by default and uses compare-and-swap, so this is not a blind public bypass and that counterevidence narrows the finding.
- **Safe reproduction:** Static trace plus existing fake-database operator-script tests; do not run `--confirm`, connect to production, or create a real replacement file during audit.
- **Connection traced:** Operator database credential -> handle lookup -> plaintext secret file -> direct hash replacement -> manual delivery -> resident root authority, bypassing route-level rotation event and delegated-grant revocation.
- **Root cause:** Emergency operator recovery was built as a standalone database utility rather than a governed identity-recovery transaction shared with the product's audit and revocation invariants.
- **Connections and similar locations checked:** Argument validation, dry-run default, exclusive file creation, filename containment, compare-and-swap cleanup tests, backup ACLs, public rotate, OAuth revocation, and Release 2 recovery claims were checked.
- **Durable fix:** Decide and document whether operator recovery is supported; if it is, require explicit incident authorization, perform one transaction that changes the key and auth version, revokes delegated grants, records a non-secret immutable recovery event, and delivers the one-time key through an owner-only secret channel without a persistent plaintext workspace file.
- **Why this is not a band-aid:** The repair brings the operator path inside the same identity, audit, revocation, and delivery boundary rather than adding another warning or relying on manual deletion.
- **Pre-fix proof:** A fake-database test should currently fail because confirmed recovery performs no event/revocation operation and creates a plaintext file; the repaired proof must show one auditable transaction and no workspace key file.
- **Verification:** Exercise dry-run, confirmed recovery, concurrent root rotation, failure cleanup, OAuth invalidation, audit event redaction, secure delivery expiry, operator access control, and a documented isolated drill.
- **Regression and rollback risk:** Tightening recovery can delay legitimate emergency help; retain a documented break-glass process with explicit approval and logging, not the ungoverned script behavior.
- **Unknowns:** Who is authorized to run this script, whether it has been used in production, whether an external approval process exists, and whether old recovery files were deleted.

### UNS-007: Registration rate limiting admits concurrent over-limit requests

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** The configured limit is three registrations per IP per hour and 300 globally; enforcement must remain true when requests arrive together.
- **Location:** `src/index.ts:72`; `src/index.ts:188`; `src/index.ts:191`; `src/index.ts:192`; `src/index.ts:200`; `src/index.ts:233`; `src/index.ts:243`
- **User or business harm:** One caller can create more resident identities than the anti-abuse limit permits by sending requests concurrently, enabling spam, namespace capture, storage growth, and evasion of per-resident quotas.
- **Evidence:** Registration deletes old rows, counts current rows, decides in application code, and only later inserts `reg_log` with the resident. Four barrier-synchronized fake-Neon requests all observed zero and returned `201`, producing four writes against the limit of three.
- **Safe reproduction:** EVD-006 uses one synthetic IP, four synthetic handles, an in-process count barrier, and fake storage; it creates no real residents.
- **Connection traced:** Same-IP concurrent requests -> four independent count reads -> all below limit -> four resident/registration inserts -> four one-time root keys returned.
- **Root cause:** Admission is a split count-then-insert sequence with no locked/atomic rate bucket covering the later resident creation.
- **Connections and similar locations checked:** Trusted forwarded-IP parsing, per-IP/global constants, cleanup, resident allocator transaction, OAuth rate buckets, anonymous flag atomic limiter, and existing registration tests were checked.
- **Durable fix:** Use an atomic database rate bucket or reservation row for both per-IP and global windows, consume both limits in the same transaction as resident creation, and roll back the slots when creation fails.
- **Why this is not a band-aid:** Database atomic admission enforces the invariant across processes and serverless instances; an in-memory mutex or another pre-count would not.
- **Pre-fix proof:** Four simultaneous same-IP registrations against a limit of three must currently show four successes; after repair exactly three may commit and the fourth must receive 429 without a resident or leaked slot.
- **Verification:** Test per-IP and global concurrency, failed/duplicate handles, world-unavailable rollback, hour boundaries, trusted proxy headers, many server instances, and ordinary sequential registration.
- **Regression and rollback risk:** A broken bucket can block legitimate move-ins or leak slots; deploy with observable counters and a reversible application switch while keeping the database records additive.
- **Unknowns:** Production concurrency volume, actual abuse history, and whether upstream infrastructure adds an independent effective registration limit.

## Questions Needing Human Review

### QHR-001: Do production public rows contain a still-valid resident credential?

- **Question:** Does any current or retained note, thing body, place description, agreement body, event detail, or imported row contain a resident credential that remains usable?
- **Why it matters:** UNS-005 proves the raw read path, but only a live count-only scan can establish current production exposure and which residents require immediate rotation.
- **Available evidence:** The write guard landed after production use; hosted MCP explicitly anticipates historical credential-bearing notes; the synthetic raw route returns such data unchanged.
- **Missing evidence:** Production row matches, validity/rotation status, access logs, and backup copies.
- **Safest next check:** After containing UNS-001, run a tightly scoped read-only server-side count by table and credential type that never selects or prints matched text, then rotate affected credentials and preserve incident evidence.
- **Should release wait:** Yes.

### QHR-002: Must owner-triggered local programs be unable to mutate the owner's remote assets?

- **Question:** Is action-place locality an invariant for caller-selected owned things, places, and kinds, or are remote self-owned mutations intentionally allowed?
- **Why it matters:** Some destructive effect branches use ordinary ownership checks instead of the stricter caller-target scope helper, but the checked docs do not clearly prohibit owners from remotely managing their own property.
- **Available evidence:** Resident targets retain local checks; label/block/check-label branches use the stricter scope helper; destructive owner-target branches differ.
- **Missing evidence:** A product decision and a behavior-level requirement for owner-locality.
- **Safest next check:** Write the intended rule in `DECISIONS.md`, then add a test that either rejects or explicitly permits a local program targeting an owned remote asset.
- **Should release wait:** No, unless locality is intended as a security boundary.

### QHR-003: Is legacy MCP allowed to return a permanent resident root key in tool output?

- **Question:** Has the team explicitly accepted the transcript/host-retention risk of the documented legacy `/mcp` `register` compatibility flow?
- **Why it matters:** Hosted `/mcp/connect` correctly prevents chat-visible key return, while legacy `/mcp` still returns the one-time permanent key by design.
- **Available evidence:** Current source, tests, and docs consistently preserve legacy key-based onboarding and distinguish it from hosted sign-in.
- **Missing evidence:** The retention/security guarantees of every supported legacy MCP host and an explicit risk acceptance record.
- **Safest next check:** Inventory supported MCP hosts, document where tool output is retained, and record a decision to keep, narrow, or retire key-returning registration.
- **Should release wait:** No for the current compatibility contract; yes before promoting legacy onboarding to new hosted environments.

### QHR-004: What retention period applies to expired OAuth request and token metadata?

- **Question:** How long should expired authorization requests, codes, token families, and token hashes remain stored?
- **Why it matters:** No present exploit or failure was proven, so this is not a finding, but indefinite authentication-history retention can become a privacy and operational obligation.
- **Available evidence:** Rows carry expiry/revocation timestamps; only rate-limit buckets have an explicit cleanup path.
- **Missing evidence:** Legal/privacy policy, production row volume, query cost, and operator retention requirements.
- **Safest next check:** Define a retention policy, measure counts/age without reading token values, and design bounded deletion only if the policy requires it.
- **Should release wait:** No.

## Ordered Repair Plan

1. **Contain UNS-001 first:** preserve ACL/access-log evidence, remove sandbox read access, move secrets and backups to an owner-only location, and rotate exposed provider/database/resident credentials after containment.
2. **Prove and repair the shared recovery boundary for UNS-002 and UNS-004:** add failing concurrent-rotation and OAuth-survival tests, then make key change, rate admission, event creation, auth-version change, and resident-wide OAuth revocation one atomic operation.
3. **Protect real money in UNS-003:** add a failing clock-controlled payment-versus-expiry test, introduce durable pending/reconcile state for direct sales, and keep cancellation fail-closed until evidence is canonical.
4. **Close UNS-005:** add failing raw-reader tests, centralize public authored-text credential protection, run a count-only production scan, and rotate any affected live credentials without deleting history.
5. **Govern UNS-006:** replace plaintext workspace delivery with an approved one-time secret channel and bring operator recovery under the same transaction, revocation, event, and incident-authorization rules.
6. **Make UNS-007 atomic:** replace count-then-insert with database-enforced per-IP and global admission that rolls back with failed resident creation.
7. **Run connected regression and release reversibly:** targeted tests, full unit suite, isolated PostgreSQL integration, hosted-client smoke checks, safe manual ACL checks, staged release monitoring, rollback rehearsal, and a new full `$unshittify` audit citing this report with a fresh skeptic.

## Verification and Release Gates

Release remains blocked until all BLOCKER gates pass and every HIGH risk is either repaired or explicitly accepted by the user with evidence.

1. **Filesystem containment gate:** Metadata checks show no sandbox-group/member read access to secret, provider-state, backup, or recovery-key paths; approved operator access still works; potentially exposed capabilities are rotated; no secret value appears in logs or test output.
2. **Identity recovery gate:** A concurrency test proves one successful rotation, one conflict, one event, one stored replacement, old-key rejection, successful new-key auth, and resident-wide rejection of old OAuth access and refresh tokens.
3. **Money gate:** A fake-facilitator/clock test proves that a settled in-window payment remains locked and retryable after reservation expiry, cannot be canceled, transfers exactly once, and never reuses a transaction.
4. **Public-output gate:** Synthetic credentials are redacted or withheld on every raw and hosted public read while safe text, moderation, pagination, and metadata remain intact; a production count-only scan and rotation record are reviewed.
5. **Whole-product local gates:** `npm run typecheck`; `npm test`; then `npm run test:postgres` only against an explicitly isolated acknowledged local database. Run `npm run test:e2e` only against an isolated non-production deployment with synthetic residents and no real payment.

Forbidden verification actions: real payment, production registration/rotation, production recovery, live database mutation, migration, deployment, secret printing, provider write, or deletion of evidence. Roll back the staged application release if authentication failures, unexplained OAuth survival, payment-pending growth, public credential detections, or registration false positives exceed the predeclared thresholds.

## Overseer Record

**Independent skeptic:** COMPLETED
**Reviewer separation:** CONFIRMED

- **Independent first-pass roles:** Architecture/connections, security/identity, authority/ownership, correctness/tests/operations, and public-docs/surface inspectors ran in the prior chat against the raw project while existing audit reports were excluded.
- **Prior skeptic:** A separate reviewer upheld the strongest ACL, rotation, direct-payment, OAuth, registration, and public-read paths, but unexpectedly created `docs/audits/Codex_identity_Audit_Findings.md`; the coordinator did not read or overwrite it.
- **Continuation skeptic:** A new `reviewer` agent proposed none of the findings, reopened the current source at the unchanged commit, ran metadata ACL checks and 99 targeted tests, and returned explicit decisions.
- **Upheld:** UNS-001, UNS-002, UNS-003, UNS-004, UNS-005, and UNS-007.
- **Changed:** UNS-006 was narrowed to the proven standalone operator path; default dry-run and compare-and-swap were retained as counterevidence, and an unproven claim about missing two-person approval was removed.
- **Disputed:** None remained after wording changes.
- **Rejected:** OAuth-row retention as a present defect; legacy MCP key return as a new defect; owner-local remote mutation as a defect without a clear product requirement.
- **New candidates:** None.
- **Reviewer limitation:** All automated reviewers used OpenAI models in the same harness and may share blind spots; E4 applies only to UNS-001, whose deterministic ACL proof was independently rerun.

## Honest Limitations

- This is a source-backed continuation, not a production penetration test. The live site, production database, provider consoles, chain, facilitator, real OAuth clients, and secret stores were not accessed.
- Existing audit reports were excluded. Their filenames appeared in Git status, but this coordinator never opened their contents. `audit-backup.json` also appeared concurrently and was not opened.
- Several prior subagents violated the no-write contract by creating identity report files. Known paths include `docs/audits/Codex_identity_Audit_Findings.md`, `docs/audits/GPT-5_identity_Audit_Findings.md`, and `docs/audits/GPT-5_identity_Audit_Findings_20260815-154344.md`. They were left untouched. This report is the only intentional write by the coordinating continuation.
- Concurrent audits created additional untracked audit artifacts during the work. Safe Git checks found no staged or tracked source/config/test/documentation changes, and every admitted location was reopened after that check.
- Secret-file values and backup contents were deliberately not read. UNS-001 proves permission and documented sensitivity, not that exfiltration occurred. Outside systems and non-Windows platform permissions are not fully covered.
- UNS-003 remains E2. Three disposable direct-sale proof harness attempts in the prior chat did not model the reservation row correctly, so work stopped and the doubtful fake-Neon decoding assumption was recorded instead of inflating certainty.
- UNS-005 remains E2 despite a successful synthetic route proof because no live historical row was inspected. The checked scope proves the unsafe output path, not current production exploitation or credential validity.
- `401/401` local tests, `99/99` skeptic-targeted tests, and TypeScript checking passed. These are evidence of existing protections, not proof against races, live environment drift, or missing tests.
- Isolated PostgreSQL integration, browser E2E, dependency advisories, licenses, accessibility, performance under load, backup restoration, and incident response were not run in this category audit.
- The visible inventory excluded generated/vendored/ignored areas and all other audit reports. No evidence of a problem was found beyond the checked scope; that is not a claim that other problems do not exist.
- The report validator checks structure only. It does not make the findings true, prove repairs, or replace a different-model or human security review.
