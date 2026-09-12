# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-175433
- **Project:** `1f3d9` at `C:\Users\Owner\Documents\1f3d9`
- **Created:** 2026-08-15T17:54:33-05:00

## Plain-English Verdict

DO NOT RELEASE

- Sandbox identities on this workstation can read local operator secret material and local full-database exports.
- Root-key lifecycle and direct-sale closure both fail in ways that can lock out residents or strand real-money transfers.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
|---|---|---|---|
| UNS-001 | BLOCKER | E4 | Local operator secrets and backup exports are readable by sandbox identities on this workstation |
| UNS-002 | BLOCKER | E3 | Concurrent root-key rotation can hand back two new secrets while only one survives |
| UNS-003 | HIGH | E2 | A buyer can pay during the direct-sale window, then lose the asset when proof arrives after expiry |
| UNS-004 | HIGH | E2 | Root-key rotation leaves hosted OAuth token families alive |
| UNS-005 | HIGH | E2 | Historical credential-bearing public text can still leak through raw public readers |
| UNS-006 | HIGH | E2 | The operator restore path can replace any resident key without a resident-controlled audit trail |
| UNS-007 | MEDIUM | E3 | Registration throttling is count-then-insert and can be overrun concurrently |

### Next 3 Actions

1. Lock down local ACLs now: remove `CodexSandboxUsers` read access from the six root env files, `.vercel`, `backups/`, and related recovery folders, then rotate any secrets that ever lived there.
2. Make key lifecycle atomic: compare-and-swap `POST /api/rotate`, revoke all resident OAuth token families on root rotation, and add tests for concurrent rotation.
3. Fail direct sales closed after payment: preserve a paid reservation as pending instead of expiring it, and block seller cancellation while payment evidence is unresolved.

## Audit Contract

| Field | Value |
|---|---|
| Requested category | `identity, access, and authority` |
| Audit mode | Read-only, non-remediating |
| Source of truth | Implementation first; docs treated as claims to verify |
| Comparison point | Current working tree against `docs/PRD.md`, `docs/DECISIONS.md`, runbooks, tests, and Git history |
| Forbidden work honored | No code changes, no live site writes, no live DB/provider inspection, no secret-file contents read |

## Project and Connection Map

| Surface | Role in identity/authority |
|---|---|
| `src/core.ts` | Accepts either resident root bearer secrets or hosted OAuth access tokens |
| `src/index.ts` | Registers residents, rotates root keys, mounts public and authenticated routes |
| `src/oauth.ts` + `src/oauth-store.ts` | Hosted sign-in, token issuance, refresh, and client-driven revocation |
| `src/mcp.ts` | Legacy MCP plus hosted connector behavior and credential safeguards |
| `src/society.ts` | Direct resident-to-resident sales, agreement signing, and note publication |
| `scripts/restore-key.mjs` | Local operator recovery path that can replace a resident secret outside the public API |
| `docs/runbooks/*.md` | Claims about environment files, backups, and recovery boundaries |

## Coverage and Limits

| Area | Status | Evidence | Limit |
|---|---|---|---|
| Root registration and rotation | CHECKED | `src/index.ts`, `src/core.ts`, `test/routes.test.ts` | No live concurrent production requests were sent |
| Hosted OAuth issuance and revocation | CHECKED | `src/oauth.ts`, `src/oauth-store.ts`, `db/schema.sql`, `test/oauth*.test.ts` | No live OAuth client or provider was used |
| Direct sale authority and payment closure | CHECKED | `src/society.ts`, `src/world-market.ts`, `docs/PRD.md`, `docs/DECISIONS.md` | No live Base payment or DB row was touched |
| Local operator secret storage and backups | CHECKED | `docs/runbooks/ENVIRONMENT.md`, `docs/runbooks/BACKUP_RESTORE.md`, metadata-only ACL checks | File contents were intentionally not opened |
| Historical credential publication | CHECKED | `src/input.ts`, `src/world.ts`, `src/society.ts`, `src/mcp.ts`, Git commit `dbcc133` | No production row scan was allowed |
| Other audits | EXCLUDED | `docs/audits/**` | One accidental grep spill returned matches under `docs/audits`; none of that output is used below |

## Evidence Ledger

| ID | Time | Location | Action | Exit | Result | Notes |
|---|---|---|---|---:|---|---|
| EVD-001 | 2026-08-15 15:xx CDT | repo root | Safe Git boundary checks (`status`, `branch`, `worktree list`, `rev-parse`) using absolute Git from outside the repo | 0 | Confirmed the target repo and avoided destructive Git operations | Read-only |
| EVD-002 | 2026-08-15 15:xx CDT | repo root | Inventory excluding `docs/audits/**` and secret contents | 0 | Mapped source, tests, docs, scripts, and ignored secret-bearing paths | Metadata only |
| EVD-003 | 2026-08-15 15:xx CDT | repo root | `npm run typecheck` | 0 | Passed | No mutations |
| EVD-004 | 2026-08-15 15:xx CDT | repo root | `npm test` | 0 | 401 tests passed | Confirmed baseline behavior; did not cover the admitted races |
| EVD-005 | 2026-08-15 15:xx CDT | repo root | Deterministic fake-Neon concurrent rotate proof | 0 | Two `200` responses, two distinct returned secrets, two DB writes, one final surviving hash | In-memory only; no real keys or DB |
| EVD-006 | 2026-08-15 15:xx CDT | repo root | Deterministic fake-Neon concurrent register proof | 0 | Four same-IP registrations all returned `201` despite per-IP limit `3` | In-memory only |
| EVD-007 | 2026-08-15 17:53 CDT | repo root | Metadata-only `Get-Acl` on secret-bearing paths plus `Get-LocalGroupMember -Group 'CodexSandboxUsers'` | 0 | Confirmed inherited `ReadAndExecute` for `CodexSandboxUsers`; group contains `CodexSandboxOffline` and `CodexSandboxOnline` | No secret values read |
| EVD-008 | 2026-08-15 17:54 CDT | repo root | Re-opened exact source lines for admitted findings | 0 | Cited line-level evidence below | Read-only |
| EVD-009 | 2026-08-15 17:54 CDT | repo root | Safe Git history check on commit `dbcc133` | 0 | Guard against published bearer secrets landed on 2026-08-12 after an in-world report | Read-only |

## Findings

### UNS-001: Local operator secrets and backup exports are readable by sandbox identities on this workstation

- **Severity:** BLOCKER
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Local operator secrets, provider exports, and database backups must not be readable by unrelated local sandbox identities.
- **Location:** `docs/runbooks/ENVIRONMENT.md:3-29`, `docs/runbooks/BACKUP_RESTORE.md:32-42`
- **User or business harm:** Any Codex sandbox process on this machine can read active local database settings, a project-scoped Neon admin key, legacy provider credentials, preview and production export artifacts, and backup snapshots containing credential hashes and private operational records. From there the blast radius reaches resident identities, production data, and provider control.
- **Evidence:** The environment runbook says `.env.local` contains working database settings and a project-scoped Neon CLI key, `.env.deploy` is an active fallback, and the other root files are provider export artifacts. The backup runbook says local exports contain the complete database, including credential hashes and private operational records, and explicitly warns that Windows inherits the parent folder ACL. A fresh metadata-only ACL check at `2026-08-15T17:53:11-05:00` showed inherited `ReadAndExecute, Synchronize` for `DESKTOP-GDDDN71\CodexSandboxUsers` on `.env.local`, `.env.deploy`, `env.txt`, `.tmp-preview.env`, `.tmp-prod-env`, `.tmp-production.env`, `.vercel`, `.release-backups`, and `backups`. `Get-LocalGroupMember` showed `CodexSandboxOffline` and `CodexSandboxOnline` inside that group.
- **Safe reproduction:** Run `Get-Acl` on the listed paths and `Get-LocalGroupMember -Group 'CodexSandboxUsers'`. Do not open file contents.
- **Connection traced:** Repo-local secret files and exports -> inherited Windows ACL -> sandbox identities -> database/provider access and sensitive local backups.
- **Root cause:** The runbooks assume these files live inside an owner-private profile, but the actual Windows ACL on this workstation grants sandbox-group read access.
- **Connections and similar locations checked:** Root env files, `.vercel`, `backups/`, and `.release-backups/`. I did not inspect secret values or credential-manager contents.
- **Durable fix:** Move active secrets out of repo-local files into an approved secret store, remove `CodexSandboxUsers` access from all secret-bearing paths, relocate backups to an owner-only location, and rotate every secret that ever lived in those paths.
- **Why this is not a band-aid:** Removing read access without rotation leaves already-readable secrets live. Rotation without ACL repair leaves the next secret exposed the same way.
- **Pre-fix proof:** After ACL changes, rerun the metadata-only checks and confirm no secret-bearing path grants sandbox-group read rights. Then prove rotated secrets are the only ones accepted.
- **Verification:** Metadata-only ACL check, a controlled local tool run that still works for the owner account, and a secret-rotation record that avoids printing values.
- **Regression and rollback risk:** Tightening ACLs can break local scripts if they implicitly depend on inherited access. Rollback must stay limited to access policy, not restore exposed secrets.
- **Unknowns:** I did not read the files, so I did not confirm which exact secrets are still valid today.

### UNS-002: Concurrent root-key rotation can hand back two new secrets while only one survives

- **Severity:** BLOCKER
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Root-key rotation must be single-winner and must never acknowledge a new secret that cannot authenticate afterward.
- **Location:** `src/core.ts:61-95`, `src/index.ts:269-299`
- **User or business harm:** Two simultaneous `POST /api/rotate` requests using the same valid root key can both return `200`, but only the last written secret remains valid. One caller walks away believing it successfully rotated and saved the only key, yet the returned key is already dead. That is an account lockout bug on the identity boundary itself.
- **Evidence:** `authRootKey()` authenticates by current `secret_hash` in `src/core.ts:61-95`. `POST /api/rotate` then counts events and unconditionally updates `residents.secret_hash` by `resident.id` in `src/index.ts:269-299`; it does not compare against the authenticated old hash in the update. A deterministic in-memory proof returned two `200` responses, two distinct secrets, two database writes, and only one final surviving hash.
- **Safe reproduction:** Use a fake SQL responder that barriers both auth lookups and both rotation count queries, then lets both requests proceed to the unconditional `UPDATE residents SET secret_hash = ... WHERE id = ...`. No live DB is needed.
- **Connection traced:** One valid root key -> two concurrent rotations -> two success responses -> last write wins -> one returned key is invalid immediately.
- **Root cause:** Authentication and mutation are separated by multiple statements, and the mutation does not compare-and-swap on the authenticated hash.
- **Connections and similar locations checked:** Public rotation route, auth resolver, event counting, and local tests. I did not find a concurrency test for this path.
- **Durable fix:** Make rotation a single compare-and-swap write on the authenticated hash inside one statement or transaction, return success only from the winning write, and revoke dependent OAuth families in the same lifecycle change.
- **Why this is not a band-aid:** Rate limiting or UI retries do not remove the race. Only a single-winner storage update does.
- **Pre-fix proof:** Add a failing concurrent test that issues two rotate requests against the same starting secret and asserts that at most one request can return `200`.
- **Verification:** New race test passes, ordinary single-rotate test still passes, and no returned secret can fail immediate auth after a `200`.
- **Regression and rollback risk:** Tightening rotation semantics can break clients that assume duplicate retries are harmless success. That contract change should be explicit.
- **Unknowns:** I did not send concurrent requests to production, so I did not measure how often real traffic hits this race.

### UNS-003: A buyer can pay during the direct-sale window, then lose the asset when proof arrives after expiry

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** The product claim says failed or uncertain payment evidence fails closed, and a settled but unproven payment stays locked and retryable until canonical evidence resolves it.
- **Location:** `docs/PRD.md:72-73`, `docs/DECISIONS.md:36-39`, `src/society.ts:732-747`, `src/society.ts:811-894`, `src/society.ts:915-960`
- **User or business harm:** A named buyer can pay inside the five-minute direct-sale reservation, then lose the asset anyway if the proof reaches the city after the reservation expires. The seller may then cancel and keep both the payment and the property until a human intervenes off-system.
- **Evidence:** `activeReservation` is defined strictly by `reserved_until > now()` in `src/society.ts:735-739`. If the reservation is no longer active, a claim carrying `X-PAYMENT` or `tx_hash` is rejected at `src/society.ts:741-747`. Direct-payment verification also requires the payment to verify inside the still-active reservation window at `src/society.ts:811-826`, and the final ownership move requires `reserved_until > clock_timestamp()` at `src/society.ts:830-894`. Once expired, the seller may cancel at `src/society.ts:915-960`. That behavior conflicts with the fail-closed, locked-and-retryable payment claim in `docs/PRD.md:72-73` and `docs/DECISIONS.md:39`.
- **Safe reproduction:** Use a fake clock and fake payment verifier in a test: pay within the reservation window, advance the clock past expiry before proof submission, then observe that the claim rejects and cancellation becomes available.
- **Connection traced:** Reservation window -> real external payment -> proof arrives after expiry -> claim rejected -> seller cancellation reopens control to seller.
- **Root cause:** The direct-sale path treats expiry as terminal even after money may already have left the buyer wallet, unlike `world-market.ts`, which keeps a pending evidence state.
- **Connections and similar locations checked:** Direct resident-to-resident sales in `src/society.ts`, world-market pending evidence in `src/world-market.ts`, and product claims in `docs/PRD.md` and `docs/DECISIONS.md`.
- **Durable fix:** Introduce a pending-payment state for direct sales that preserves the lock after a potentially settled payment until canonical evidence resolves or invalidates it, and block seller cancellation while that state exists.
- **Why this is not a band-aid:** Extending the timer only changes odds. The defect is the lack of a durable paid-but-unresolved state.
- **Pre-fix proof:** Add a failing test for paid-in-window / proof-after-expiry and a second test showing seller cancellation is blocked while payment status is unresolved.
- **Verification:** Those new tests pass, and direct-sale behavior matches the documented fail-closed semantics already used in world-market recovery.
- **Regression and rollback risk:** A new pending state changes seller expectations and requires clear recovery/admin flows for genuinely invalid receipts.
- **Unknowns:** I did not inspect live sale rows or send live payments, so current production incidence is unknown.

### UNS-004: Root-key rotation leaves hosted OAuth token families alive

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Rotating the permanent resident root key should also terminate delegated hosted access unless the product clearly promises otherwise.
- **Location:** `src/index.ts:269-299`, `src/oauth.ts:623-664`, `src/oauth-store.ts:479-538`, `db/schema.sql:134-177`
- **User or business harm:** If a resident rotates its root key because it suspects compromise, existing hosted OAuth access and refresh credentials can continue working until expiry or explicit client revocation. That leaves delegated access alive for up to the 30-day token-family window after the resident believes the key rotation contained the incident.
- **Evidence:** `POST /api/rotate` only updates `residents.secret_hash` and records a `rotate` event in `src/index.ts:283-299`. The OAuth revoke route only revokes a family when the client presents one of that family's tokens in `src/oauth.ts:623-642`. Access-token resolution depends on token-family state, not the resident secret, in `src/oauth.ts:648-659` and `src/oauth-store.ts:505-538`. The schema gives token families up to 30 days in `db/schema.sql:134-177`.
- **Safe reproduction:** Static code-path proof: re-open rotate, revoke, and access-token resolution. No live token exercise is required.
- **Connection traced:** Suspected root-key leak -> resident rotates key -> old root secret dies -> existing hosted token family still authorizes requests.
- **Root cause:** Root-key lifecycle and hosted delegated-session lifecycle are implemented as separate systems with no resident-wide revocation on rotation.
- **Connections and similar locations checked:** Root auth, hosted chat auth, token-family storage, refresh rotation, and client-driven revoke.
- **Durable fix:** Add resident-wide token-family revocation on root rotation, or provide an equally strong resident-controlled incident action that is automatically invoked by rotation.
- **Why this is not a band-aid:** Asking users to remember a second manual revoke step is not reliable incident containment.
- **Pre-fix proof:** Add a failing test that issues a hosted token family, rotates the resident key, then proves the old access token can no longer resolve a resident.
- **Verification:** New lifecycle test passes, ordinary OAuth refresh/revoke flows still pass, and rotation remains idempotent for the winner request.
- **Regression and rollback risk:** Existing hosted sessions will be terminated on rotation, which is the point; UX copy and client retry behavior need to match.
- **Unknowns:** I did not enumerate live token families or clients.

### UNS-005: Historical credential-bearing public text can still leak through raw public readers

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Resident keys and hosted OAuth credentials must never be returned through public output.
- **Location:** `src/input.ts:11-23`, `src/world.ts:98-152`, `src/world.ts:168-182`, `src/society.ts:163-175`, `src/society.ts:474-508`, `src/moderation-store.ts:113-124`, `src/mcp.ts:646-686`, Git commit `dbcc133`
- **User or business harm:** If any public note, agreement, place, or thing body created before the 2026-08-12 credential-write guard still contains a live or not-yet-revoked credential, anonymous raw readers can receive it. That is direct identity takeover material.
- **Evidence:** `src/input.ts:11-23` now rejects credential-shaped public text. Git commit `dbcc133` shows that guard landed on 2026-08-12 after an in-world report. `src/mcp.ts:646-686` explicitly says historical notes can predate the guard and adds a hosted-only response safeguard. Raw public readers in `src/world.ts` and `src/society.ts` return stored `body` fields and only pass them through `moderatePublicRows`, which in `src/moderation-store.ts:113-124` applies remove/restore overlays only; it does not scan for credentials. I did not perform a production row scan, so the live count is unknown, but the unsafe read path is real if historical rows remain.
- **Safe reproduction:** On a disposable local copy, seed a historical note body containing a synthetic credential pattern, then compare raw public reads with hosted MCP reads. Do not use a real credential or production row.
- **Connection traced:** Historical public text row -> raw public JSON reader -> no credential redaction -> anonymous caller receives authority material.
- **Root cause:** The write-side credential guard was added after initial production traffic, but the common raw public-read boundary was never given the hosted connector's credential safeguard.
- **Connections and similar locations checked:** Public note reads, place embedded notes, public agreements, single thing reads, moderation overlays, hosted MCP safeguard, and Git history for the guard introduction.
- **Durable fix:** Add credential scanning/redaction or fail-closed withholding to the shared raw public-read boundary, then run a privileged ID-only production scan and rotate or revoke every affected credential family.
- **Why this is not a band-aid:** Blocking only new writes leaves old rows live; fixing only hosted MCP leaves raw HTTP and other public readers exposed.
- **Pre-fix proof:** Add failing synthetic fixtures for raw public readers and show hosted and raw surfaces both withhold or redact the token-shaped body.
- **Verification:** New tests pass, a safe production scan reports zero live credential-bearing public rows or a completed rotation/revocation set, and no public serializer can emit matching patterns.
- **Regression and rollback risk:** Overbroad pattern matching can redact benign explanatory text; tests need explicit safe/unsafe examples.
- **Unknowns:** I did not query production rows, so I cannot say whether any live credential-bearing historical rows still exist today.

### UNS-006: The operator restore path can replace any resident key without a resident-controlled audit trail

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Recovery that changes resident identity authority should be auditable, narrowly authorized, and should not create raw replacement secrets inside broadly accessible local folders.
- **Location:** `scripts/restore-key.mjs:90-145`, `scripts/restore-key.mjs:161-236`
- **User or business harm:** Anyone with the local operator database path can replace any resident's root key, write a plaintext replacement key into the repo backup area, and leave no public city event or explicit second-party approval trail. In practice that is a silent identity takeover tool.
- **Evidence:** `restoreResidentKey()` selects a resident, generates a new secret, writes it through `createUniqueSecretFile()` under the backups directory, then updates `residents.secret_hash` with a compare-and-swap on the old hash in `scripts/restore-key.mjs:161-236`. It logs operator instructions to deliver the raw secret and tell the resident to rotate afterward. No city event, signed approval record, or resident-facing audit artifact is created. Combined with UNS-001, the replacement key file lands in a folder whose parent ACL currently grants sandbox-group read access.
- **Safe reproduction:** Static code-path proof. Read the script and its file-writing path; do not run it with real credentials.
- **Connection traced:** Operator DB access -> raw replacement secret file -> resident secret replaced -> resident authority changes with no resident-controlled audit trail.
- **Root cause:** Recovery is implemented as an operator-side script, not a first-class audited identity flow, and it relies on repo-local secret file handling.
- **Connections and similar locations checked:** Public registration warning, root rotation route, backup runbook, and local ACL state.
- **Durable fix:** Replace the script with a first-class recovery flow that records an auditable event, uses short-lived one-time material from an approved secret channel, and never stages plaintext replacement keys in repo-local backup folders.
- **Why this is not a band-aid:** Hiding the script or renaming the folder does not change the authority model. The issue is the unaudited power path itself.
- **Pre-fix proof:** Add tests around a new recovery ledger or event path and prove that no plaintext secret touches repo-local storage.
- **Verification:** Recovery requires explicit authorization, emits a durable audit record, stores no plaintext local key, and still preserves compare-and-swap safety against stale replacements.
- **Regression and rollback risk:** Recovery becomes more operationally complex; emergency procedures must still work when the resident cannot sign in.
- **Unknowns:** I did not inspect provider-side access control or who currently holds local operator credentials.

### UNS-007: Registration throttling is count-then-insert and can be overrun concurrently

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Anti-abuse registration limits should hold under ordinary concurrent traffic.
- **Location:** `src/index.ts:188-267`
- **User or business harm:** Bursty concurrent registration can overrun the stated per-IP and global limits, allowing more new identities than the front door claims in the protected interval.
- **Evidence:** `POST /api/register` deletes old log rows, counts the last hour in one statement, then inserts the new resident and `reg_log` entry later in a separate statement sequence. A deterministic fake-Neon barrier proof returned four `201` responses from the same IP against the configured per-IP limit of `3`.
- **Safe reproduction:** Barrier the count queries for four concurrent requests and return zero counts to each before letting inserts proceed. No live DB is needed.
- **Connection traced:** Concurrent registration burst -> each request reads the same pre-insert count -> all pass the limit gate -> all insert.
- **Root cause:** The throttle is enforced as a read-then-write race, not an atomic reservation or counter update.
- **Connections and similar locations checked:** Registration route, trusted-IP hashing tests, and event logging.
- **Durable fix:** Move throttling into one atomic insert/admit step, or use a dedicated counter table or advisory lock that reserves capacity before resident creation.
- **Why this is not a band-aid:** Faster queries or stricter nominal limits still race under concurrency.
- **Pre-fix proof:** Add a failing concurrent test that proves only three same-IP requests can succeed in one burst.
- **Verification:** New race test passes, and normal registration still returns a secret exactly once.
- **Regression and rollback risk:** Stronger throttling can reject borderline legitimate bursts; operator visibility into throttle reasons should improve with it.
- **Unknowns:** I did not measure production traffic volume or proxy fan-in.

## Questions Needing Human Review

| Question | Why it matters | Available evidence | Missing evidence | Safest next check | Should release wait? |
|---|---|---|---|---|---|
| Do any historical public rows still contain live or still-usable credentials? | If yes, UNS-005 becomes a live takeover path, not just a code-path risk. | The code explicitly anticipates historical rows and only hosted MCP redacts them. | Production row count and any prior rotations/revocations. | Restore a disposable local copy from a safe snapshot and run an ID-only credential-pattern scan without printing bodies. | Yes, if any live rows are found. |
| Who currently has provider or operator access capable of running `restore-key.mjs` or reading the local secret-bearing paths? | The actual blast radius of UNS-001 and UNS-006 depends on that set. | Source shows the paths and powers; it does not show current human access. | Host OS account policy, provider RBAC, and operator process. | Human review of workstation account policy and provider RBAC, without exposing credentials. | Yes for access expansion; not needed to admit the findings. |
| Should owner-authored effect-driven remote moves of owned things be legal, or should all destructive/mutating effect targets be forced local by scope checks? | I found a scope asymmetry in `src/engine-effects.ts`, but existing owner-only APIs already allow some remote property actions. | `requireCallerTargetScope()` exists, but destroy/move/transfer branches bypass it for owned targets. | Product intent for owner-locality across effects. | Decide intent first, then add tests either for explicit allowance or explicit denial. | No. I did not admit this as a defect. |
| Is long-lived hashed OAuth request/code/token retention acceptable for operations and privacy? | The tables are append-heavy and only rate-limit buckets are actively deleted. | The schema stores only hashes and expiry timestamps. | Retention policy, data-growth expectations, and privacy requirements. | Human review of retention policy before changing storage. | No. I did not admit this as a defect. |

## Ordered Repair Plan

1. Contain local secret exposure: fix ACLs, move secret-bearing artifacts out of repo-local storage, inventory every secret that touched those paths, and rotate them.
2. Repair root-key lifecycle: make rotate single-winner, revoke resident OAuth families on rotation, and add direct lifecycle tests.
3. Repair paid direct-sale closure: introduce a pending paid state, block cancellation while evidence is unresolved, and add paid-before-expiry / proof-after-expiry tests.
4. Close historical publication gaps: put credential scanning at the shared public-read boundary, then run a safe production scan and rotate/revoke any affected credentials.
5. Replace operator recovery with an audited flow that does not stage plaintext keys in repo-local backup space.
6. Make registration throttling atomic and add concurrency tests.

## Verification and Release Gates

1. ACL gate: metadata-only checks show no sandbox-group read access on secret-bearing paths.
2. Rotation gate: concurrent rotate test proves at most one `200`, and root rotation invalidates all hosted token families for that resident.
3. Direct-sale gate: a paid-in-window / proof-after-expiry test leaves the asset locked pending evidence and blocks seller cancellation.
4. Publication gate: synthetic historical credential fixtures are withheld or redacted on raw public HTTP and hosted MCP alike.
5. Recovery gate: replacement-key flow emits an audit trail and never writes plaintext keys into repo-local storage.
6. Throttle gate: concurrent registration test cannot exceed the configured per-IP or global limit.

## Overseer Record

**Independent skeptic:** COMPLETED
**Reviewer separation:** CONFIRMED

- I ran the audit as read-only and did not use findings from other audit reports.
- Existing parallel work created other files under `docs/audits/`; I did not read them for this report and intentionally wrote a distinct filename.
- One repository-wide grep unexpectedly returned matches under `docs/audits/` before exclusion was tightened. I excluded that output from the findings and from every citation above.

## Honest Limitations

- This audit proves local ACL state, source behavior, and deterministic in-memory races. It does not prove the current contents of production databases, provider settings, or credential stores.
- I did not read any secret-file contents, backup contents, credential-manager contents, or provider dashboards.
- I did not send live requests to `1f3d9.com`, perform real OAuth sign-ins, submit real Base payments, or mutate production state.
- The concurrent rotate and register findings are based on deterministic local harnesses, not live traffic.
