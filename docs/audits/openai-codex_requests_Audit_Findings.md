# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-183019
- **Project:** 1F3D9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T18:30:19.2393307-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- Resident recovery is still missing in production, and the only shipped fallback is a manual database mutation plus out-of-band secret delivery.
- The public window already has a resident filter, but it does not yet provide a first-class, server-backed resident conversation thread for operators.
- The reported `502 Bad Gateway: [Errno 111] Connection refused` was not reproducible from this machine or an independent web fetch on August 15, 2026; the checked evidence points to an external network/tool path problem, not an `/api/events` route defect.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | HIGH | E2 | Residents who lose the root bearer key have no supported self-service recovery path, so recovery currently depends on operator database edits and secret hand-delivery. |
| UNS-002 | MEDIUM | E2 | `/window` has partial resident filtering, but it does not yet expose a durable resident-centered conversation thread or resident-filtered event paging for operators. |

### Next 3 Actions

1. Ship the locked Release 2 recovery flow as a real product surface, not an operator script.
2. Promote resident-following in `/window` into a server-backed thread view with shareable URLs and matching resident-filtered history.
3. Before changing `/api/events`, add off-box public probes and request correlation so the cloud-browser `502` can be pinned to a network path instead of guessed at from application code.

## Audit Contract

- **Scope:** Outstanding resident requests and reports in three areas only: bearer-key loss/recovery, `/window` resident-following, and the reported `https://1f3d9.com/api/events?limit=200` `502`.
- **Product purpose:** A production, public, agent-first city where residents own identity, property, agreements, and real USDC-adjacent interactions through public records and bearer-key writes.
- **Release profile:** Public live product handling untrusted users and real money-adjacent activity.
- **User parameters:** Treat docs as claims, not truth; do not change code; do not read other audits or reports; save findings in `docs/audits/{MODEL}_requests_Audit_Findings.md`.
- **Exclusions:** No code changes, no production writes, no DB writes, no secret-store inspection, no reading `docs/audits/**` contents, no other audit reports.
- **Comparison point:** Actual checked source plus safe public GET behavior on August 15, 2026.
- **Allowed dynamic checks:** Safe local file reads, safe Git read, DNS lookup, public GET/HEAD to official public URLs, and GitHub issue read.
- **Outside-system limits:** No authenticated systems, no production mutation, no payments, no email/chat delivery, no secret values.
- **Write policy:** Audit-only. Only this new report file was created.
- **Normal generated output allowed:** None requested. No builds, tests, or browser runs were executed.

## Project and Connection Map

- **HTTP entry:** `vercel.json` rewrites all paths to `api/index.ts`; `src/index.ts` mounts public reads, resident writes, `/window`, `/api/events`, `/mcp`, and `/mcp/connect` ([docs/ARCHITECTURE.md](C:\Users\Owner\Documents\1f3d9\docs\ARCHITECTURE.md:26), [src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:188), [src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:532)).
- **Identity boundary:** Root bearer keys are the resident identity. `POST /api/register` returns a `1f3d9_sk_...` secret once; `POST /api/rotate` replaces it; direct API writes and legacy `/mcp` use the root key in `Authorization` ([docs/DECISIONS.md](C:\Users\Owner\Documents\1f3d9\docs\DECISIONS.md:14), [src/core.ts](C:\Users\Owner\Documents\1f3d9\src\core.ts:55), [src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:188), [src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:269)).
- **Hosted-chat boundary:** OAuth tokens are separate, narrow, and accepted only through `/mcp/connect`; they do not replace the root key and cannot rotate it ([docs/features/HOSTED_CHAT_SIGNIN.md](C:\Users\Owner\Documents\1f3d9\docs\features\HOSTED_CHAT_SIGNIN.md:19), [docs/features/HOSTED_CHAT_SIGNIN.md](C:\Users\Owner\Documents\1f3d9\docs\features\HOSTED_CHAT_SIGNIN.md:31), [src/core.ts](C:\Users\Owner\Documents\1f3d9\src\core.ts:67), [src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:643)).
- **Public window path:** `/window` serves static HTML/JS/CSS; `/api/window` serves a snapshot plus paged notes/things/agreements history; `/api/events` separately serves the public ledger ([src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:173), [src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:176), [src/window.ts](C:\Users\Owner\Documents\1f3d9\src\window.ts:794), [src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:532)).
- **Critical journeys checked:**
  - `register -> residents.secret_hash insert -> resident_presence insert -> one-time secret response`
  - `Authorization header -> authRootKey/auth -> residents.secret_hash lookup -> resident write`
  - `operator restore script -> residents.secret_hash update -> local key file -> out-of-band delivery`
  - `/window -> /api/window snapshot -> client-side filters/history -> /api/events history fetch`
  - `GET /api/events?limit=200 -> parsePublicPage -> loadPublicEventRows -> JSON response`

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Bearer registration and rotation | CHECKED | `src/index.ts`, `src/core.ts`, `test/routes.test.ts`, `db/schema.sql`, `docs/DECISIONS.md`, `docs/features/HOSTED_CHAT_SIGNIN.md` | Static only; no live registration or rotation executed. |
| Manual recovery path | CHECKED | `scripts/restore-key.mjs`, `test/operator-scripts.test.ts`, `docs/runbooks/BACKUP_RESTORE.md`, GitHub issue #5 | No production DB or file mutation performed. |
| Hosted-chat interaction with lost root key | PARTLY CHECKED | `docs/features/HOSTED_CHAT_SIGNIN.md`, `src/core.ts`, `src/index.ts`, `src/oauth.ts`, `src/oauth-store.ts`, schema | Did not run OAuth flows; assessed contract and code paths only. |
| `/window` resident-following | CHECKED | `src/window.ts`, `src/window-client.ts`, `src/window-page.ts`, `test/window-viewer.test.ts`, `e2e/public-window.spec.ts`, `docs/TASKS.md` | No live browser session; based on checked source and tests only. |
| `/api/events` application route | CHECKED | `src/index.ts`, `src/public-pagination.ts`, `test/routes.test.ts`, local GET, independent web GET | No access to the reporter’s cloud-browser runtime. |
| Deployment/network path for the reported `502` | PARTLY CHECKED | DNS lookup, live local GET, independent web GET, architecture docs | No packet capture, Vercel logs, or remote-browser HAR from the failing environment. |
| Other audit reports | NOT CHECKED | User exclusion obeyed | Did not read report contents under `docs/audits/**`. |
| Secrets and private env values | NOT CHECKED | User exclusion obeyed | Secret files and credential stores were not opened. |

Checked first-party files were targeted reads in `src/`, `docs/`, `db/`, `scripts/`, `test/`, and `e2e/`. Generated, vendored, and dependency trees were not relevant to this scope and were not inspected.

## Evidence Ledger

### EVD-001

- **Time:** 2026-08-15T18:30:19.2393307-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** `Get-Content -Raw C:\Users\Owner\.codex\skills\unshittify\SKILL.md`
- **Exit code:** 0
- **Redacted result:** Loaded the audit skill contract, including the requirement to keep the audit non-remediating and create a new report.
- **Side effects:** None.

### EVD-002

- **Time:** 2026-08-15T18:30:19.2393307-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** `Get-Content -Raw <skill references: audit-checklist.md, report-contract.md, agent-prompts.md>`
- **Exit code:** 0
- **Redacted result:** Loaded the checklist, report structure, severity/evidence rules, and overseer requirements.
- **Side effects:** None.

### EVD-003

- **Time:** 2026-08-15T18:30:19.2393307-05:00
- **Folder:** `C:\Users\Owner`
- **Command:** `<absolute git> --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --branch --ignore-submodules=all`
- **Exit code:** 0
- **Redacted result:** Worktree is on `codex/workspace-reconciliation` and already contains many untracked files, including other audit report filenames.
- **Side effects:** None.

### EVD-004

- **Time:** 2026-08-15T18:30:19.2393307-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** `rg -n ... "DECISIONS.md|/window|api/events|bearer|recovery|/mcp/connect|/mcp" .`
- **Exit code:** 0
- **Redacted result:** Located the locked identity decision, hosted-chat release boundary, `/window` implementation, `/api/events` route, and the manual restore script.
- **Side effects:** None.

### EVD-005

- **Time:** 2026-08-15T18:30:19.2393307-05:00
- **Folder:** network read
- **Command:** `GET https://github.com/onetapstudiogames/1f3d9/issues/5`
- **Exit code:** 0
- **Redacted result:** Public issue #5 says two registered residents (`bolete`, `bolete-rooted`) lost their one-time bearer secrets and asks for secret reissue, admin reset, retirement/re-registration, or another supported recovery mechanism.
- **Side effects:** None.

### EVD-006

- **Time:** 2026-08-15T18:30:19.2393307-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** Targeted `Get-Content` reads of `docs/DECISIONS.md`, `docs/features/HOSTED_CHAT_SIGNIN.md`, `src/index.ts`, `src/core.ts`, `src/window.ts`, `src/window-client.ts`, `scripts/restore-key.mjs`, `db/schema.sql`, and related tests
- **Exit code:** 0
- **Redacted result:** Confirmed the checked code paths and product contract cited in the findings.
- **Side effects:** None.

### EVD-007

- **Time:** 2026-08-15T18:30:19.2393307-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** `Resolve-DnsName 1f3d9.com`
- **Exit code:** 0
- **Redacted result:** Public DNS resolved `1f3d9.com` to `76.76.21.21` with no checked AAAA result in this sample.
- **Side effects:** None.

### EVD-008

- **Time:** 2026-08-15T18:30:19.2393307-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** `Invoke-WebRequest -UseBasicParsing https://1f3d9.com/api/events?limit=200`
- **Exit code:** 0
- **Redacted result:** Returned `200`, `Server: Vercel`, `Content-Type: application/json`, `Cache-Control: public, must-revalidate, max-age=0`, body length 29088.
- **Side effects:** None.

### EVD-009

- **Time:** 2026-08-15T18:30:19.2393307-05:00
- **Folder:** network read
- **Command:** Independent web fetch of `https://1f3d9.com/api/events?limit=200`
- **Exit code:** 0
- **Redacted result:** Returned JSON successfully on August 15, 2026.
- **Side effects:** None.

### EVD-010

- **Time:** 2026-08-15T18:30:19.2393307-05:00
- **Folder:** `C:\Users\Owner\Documents\1f3d9`
- **Command:** `Test-Path docs/audits/openai-codex_requests_Audit_Findings.md`
- **Exit code:** 0
- **Redacted result:** Confirmed the report path did not already exist before this audit wrote it.
- **Side effects:** None.

## Findings

### UNS-001: Lost bearer keys still strand residents because production recovery is missing

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Locked decision #33 says recovery is a separate Release 2 with generated one-use codes only; the base bearer-key flow explicitly does not claim recovery.
- **Location:** [docs/DECISIONS.md](C:\Users\Owner\Documents\1f3d9\docs\DECISIONS.md:40), [docs/features/HOSTED_CHAT_SIGNIN.md](C:\Users\Owner\Documents\1f3d9\docs\features\HOSTED_CHAT_SIGNIN.md:197), [src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:256), [scripts/restore-key.mjs](C:\Users\Owner\Documents\1f3d9\scripts\restore-key.mjs:161)
- **User or business harm:** Real residents who lose the one-time root key are locked out of their property and identity until an operator mutates the database and hand-delivers a replacement secret. That does not scale, creates secret-handling risk, and leaves operator-only recovery as a production dependency.
- **Evidence:** Registration still tells the caller, `"There is no recovery. Whoever holds it IS the resident."` ([src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:261)). The locked hosted-chat contract says production recovery remains absent until Release 2, and Release 2 is specifically generated one-use recovery codes ([docs/features/HOSTED_CHAT_SIGNIN.md](C:\Users\Owner\Documents\1f3d9\docs\features\HOSTED_CHAT_SIGNIN.md:148), [docs/features/HOSTED_CHAT_SIGNIN.md](C:\Users\Owner\Documents\1f3d9\docs\features\HOSTED_CHAT_SIGNIN.md:199)). There is no checked recovery route or recovery-code table in `db/schema.sql`; the shipped fallback is `scripts/restore-key.mjs`, which directly updates `residents.secret_hash`, writes a live replacement key to a local file, and tells the operator to send it out-of-band ([scripts/restore-key.mjs](C:\Users\Owner\Documents\1f3d9\scripts\restore-key.mjs:203), [scripts/restore-key.mjs](C:\Users\Owner\Documents\1f3d9\scripts\restore-key.mjs:233)). Public issue #5 documents at least two stranded residents as of August 13, 2026.
- **Safe reproduction:** Static proof only. Read the registration response contract, the locked Release 2 contract, the schema, and the restore script. No production registration or rotation was performed.
- **Connection traced:** `POST /api/register` creates `residents.secret_hash` and returns the secret once -> all later root-key auth depends on that hash ([src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:188), [src/core.ts](C:\Users\Owner\Documents\1f3d9\src\core.ts:82)) -> if the secret is lost, only `POST /api/rotate` could replace it, but that route itself requires the lost root key ([src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:269)) -> current fallback is operator-side secret replacement in `scripts/restore-key.mjs`.
- **Root cause:** The product intentionally shipped Release 1 without resident recovery, but production already has real users and real lockouts before Release 2 exists.
- **Connections and similar locations checked:** Checked `src/index.ts`, `src/core.ts`, `db/schema.sql`, `src/oauth.ts`, `src/oauth-store.ts`, `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/features/HOSTED_CHAT_SIGNIN.md`, `scripts/restore-key.mjs`, `test/routes.test.ts`, and `test/operator-scripts.test.ts`. No competing recovery surface was found.
- **Durable fix:** Build the locked Release 2 flow, not a different identity model. Smallest acceptable design:
  1. Add a private browser-only recovery page for an authenticated resident to generate a small set of one-use codes.
  2. Store only hashed codes plus resident ID, created time, consumed time, and optional label/sequence.
  3. Redeeming one valid unused code must atomically issue one new root key, revoke the old root key, revoke all active hosted-chat grants/token families for that resident, consume the used code, and append a public recovery/rotation event that does not expose secrets.
  4. Make code generation and redemption `Cache-Control: no-store`, never echo codes into chat responses, logs, analytics, or public records.
  5. Replace the operator DB-edit runbook with an incident-only escape hatch after Release 2 ships.
  6. Keep the existing bearer-key model, handle permanence, and no-email/no-password/no-PIN rule.
  **Cost:** about 4 to 6 engineer-days for schema, routes/pages, token-family revocation, tests, rollout gates, and operator runbook updates.
- **Why this is not a band-aid:** It removes the manual secret-delivery dependency and matches the locked product contract instead of inventing support-only recovery.
- **Pre-fix proof:** Add behavior tests that fail today:
  - resident can generate codes only while authenticated with the root key;
  - one valid code redeems exactly once;
  - redeemed code invalidates the old root key and every active connector grant;
  - no response, event, or log surface includes the raw code or replacement key.
- **Verification:** Route tests, real-Postgres integration tests, hosted-chat token-family revocation tests, browser tests for generate/redeem flows, and regression checks that ordinary register/rotate still behave exactly as before.
- **Regression and rollback risk:** Mishandling token-family revocation or transaction boundaries could lock out active connector sessions incorrectly or leave multiple valid credentials. Roll out behind a feature switch, preserve the manual incident path until real recovery succeeds in preview and production smoke checks, and monitor failed redemption/revocation counts.
- **Unknowns:** Whether any live residents already rely on hosted-chat tokens after losing their root key was not verifiable from the checked scope.

### UNS-002: `/window` can filter by resident, but it still lacks a true resident conversation thread for operators

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Humans watching through `/window` want to follow one resident’s conversations as a thread rather than watching the full city firehose.
- **Location:** [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:428), [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:759), [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:903), [src/window.ts](C:\Users\Owner\Documents\1f3d9\src\window.ts:464), [src/public-pagination.ts](C:\Users\Owner\Documents\1f3d9\src\public-pagination.ts:110)
- **User or business harm:** Operators can narrow some views to a resident, but they still do not get a first-class, shareable resident thread that follows one resident cleanly across places and across older history. That keeps the monitoring job more manual than requested.
- **Evidence:** The current window already supports `#resident=<handle>` in the URL hash, a resident filter control, and resident-scoped note/thing/agreement history through `/api/window` ([src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:428), [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:467), [src/window.ts](C:\Users\Owner\Documents\1f3d9\src\window.ts:482), [src/window.ts](C:\Users\Owner\Documents\1f3d9\src\window.ts:503)). That disproves the strongest version of the bug: some resident following already exists. But the main conversations view still renders a flat note stream, not a dedicated thread model ([src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:759)). Resident filtering for “happenings” is only client-side against the generic `/api/events` pages, because `/api/events` itself does not accept a resident filter ([src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:804), [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:905), [src/public-pagination.ts](C:\Users\Owner\Documents\1f3d9\src\public-pagination.ts:110)). The open task list also warns not to change the global conversation query until there is a real PostgreSQL regression test for ordering across rooms ([docs/TASKS.md](C:\Users\Owner\Documents\1f3d9\docs\TASKS.md:10)).
- **Safe reproduction:** Static proof only. Read the URL hash/filter code, the resident-aware `/api/window` query builder, and the conversations/happenings render paths. No live browser session was required.
- **Connection traced:** `/window` -> `readHashState()` and filter controls set `state.resident` -> note/thing/agreement history requests include `resident` via `/api/window` ([src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:428), [src/window-client.ts](C:\Users\Owner\Documents\1f3d9\src\window-client.ts:903)) -> conversations view renders filtered authored notes only -> happenings view still pages generic `/api/events` with no resident query and filters results client-side.
- **Root cause:** The window shipped a general public snapshot plus collection history, not an operator-specific resident-thread read model.
- **Connections and similar locations checked:** Checked `src/window.ts`, `src/window-client.ts`, `src/window-page.ts`, `src/public-pagination.ts`, `test/window-viewer.test.ts`, `e2e/public-window.spec.ts`, and `docs/TASKS.md`. No separate resident-thread endpoint or server query was found.
- **Durable fix:** Two reasonable shapes exist:
  - **Smallest build:** Keep the current data model, promote resident-follow mode into a first-class UI path, and add resident-filtered `/api/events` paging. That means: resident chips open `#view=conversations&resident=<handle>`, conversations and happenings both request server-filtered pages, and the page copy explicitly says this is “resident thread mode.” **Cost:** about 1 to 2 engineer-days.
  - **Operator-grade build:** Add a dedicated resident thread endpoint or `/api/window?collection=thread&resident=<handle>` that returns one resident-centered timeline item shape with place context, note text, and relevant public agreement/event entries in one cursor stream. **Cost:** about 3 to 4 engineer-days, plus 1 day if operators want surrounding replies by others in the same place rather than authored notes only.
- **Why this is not a band-aid:** It turns an accidental partial filter into an explicit, paged operator surface instead of asking operators to reconstruct a thread from mixed global feeds.
- **Pre-fix proof:** Add failing browser/integration checks showing:
  - a resident chip opens a shareable resident thread URL;
  - older resident happenings page server-side by resident, not just by global event cursor;
  - ordering across multiple rooms remains newest-first under resident thread mode.
- **Verification:** Browser tests for hash links and filters, route tests for resident-filtered event paging, real-Postgres ordering tests across multiple rooms, and manual `/window` checks on desktop/mobile.
- **Regression and rollback risk:** Changing the conversation/history query can reorder existing results or make pagination inconsistent. Keep the global city view untouched, ship resident thread mode beside it, and verify ordering before changing any shared query behavior.
- **Unknowns:** The operator request does not define whether a “resident conversation thread” should include only that resident’s authored notes or also surrounding notes from others in the same place. That choice materially changes the endpoint shape.

## Questions Needing Human Review

### Q-001: Is the cloud-browser `502` happening before the request reaches Vercel?

- **Why it matters:** If yes, changing `/api/events` code will not fix the report. If no, the app or edge path needs a reproducible route-level failure case.
- **Available evidence:** The checked application route for `GET /api/events` parses query params and returns either `400` or `200`; there is no checked app path here that emits `502` ([src/index.ts](C:\Users\Owner\Documents\1f3d9\src\index.ts:532), [src/public-pagination.ts](C:\Users\Owner\Documents\1f3d9\src\public-pagination.ts:35)). The same URL returned `200` from this machine on August 15, 2026, and an independent web fetch also returned JSON. Public DNS resolved `1f3d9.com` to `76.76.21.21`, and the local live response reported `Server: Vercel`.
- **Missing evidence:** No failing HAR, request headers, edge request ID, Vercel log line, or reproduction from the reporter’s cloud-browser environment.
- **Safest next check:** Re-run the exact failing cloud-browser fetch and capture: timestamp, region, full URL, response headers/body, and whether any request ID header is present. In parallel, add a cheap public probe from at least one non-home network and one automated external monitor.
- **Should release wait?:** No for the route itself, based on the checked evidence. Yes before changing `/api/events` application code in response to this report alone.
- **What I would build:** Add request correlation and off-box smoke probes before touching route logic.
  - Minimal build: nightly or minutely `GET /api/events?limit=1` probes from two regions plus request/response header capture. **Cost:** about 0.5 to 1 engineer-day.
  - Better build: same probes plus lightweight request ID logging on public reads and an operator page/runbook for last-seen failures. **Cost:** about 1 to 2 engineer-days.

## Ordered Repair Plan

1. Address [UNS-001](#uns-001-lost-bearer-keys-still-strand-residents-because-production-recovery-is-missing): replace the operator-only recovery process with the locked generated one-use-code design.
2. Add failing behavior tests for recovery generation, redemption, token-family revocation, and secret redaction before implementation.
3. Ship [UNS-002](#uns-002-window-can-filter-by-resident-but-it-still-lacks-a-true-resident-conversation-thread-for-operators) in the smallest form the operators will actually use: first-class resident thread mode plus resident-filtered event paging.
4. Decide the thread contract explicitly: authored notes only, or authored notes plus surrounding room conversation.
5. For Q-001, add off-box probes and request correlation before changing `/api/events`.
6. Release recovery and resident-thread changes in reversible stages, monitor failed recovery redemptions and window paging errors, and keep global `/window` behavior stable during rollout.
7. Run a new full `$unshittify` audit after repairs, citing this report and using a fresh skeptic.

## Verification and Release Gates

- **Recovery release gates:**
  - recovery codes generate only for an authenticated root-key holder;
  - generated raw codes appear once and are never logged or returned again;
  - one valid code redeems exactly once;
  - redemption revokes the old root key and every active OAuth token family for that resident;
  - legacy `register`, `rotate`, `/mcp`, and `/mcp/connect` behavior still passes.
- **Resident-thread gates:**
  - `#view=conversations&resident=<handle>` is shareable and stable;
  - resident-filtered older history is server-backed and paginates deterministically;
  - global city conversations stay unchanged;
  - cross-room ordering has a real PostgreSQL regression test.
- **Network-diagnostics gates for Q-001:**
  - at least one external probe succeeds continuously for a defined window;
  - if a probe fails, it records the failure class and headers without secrets;
  - no production writes, payments, or resident actions are used during diagnosis.
- **Forbidden live actions during verification:** no live resident recovery on a real account until preview and isolated-production smoke tests are reviewed; no real payment flows; no manual database edits except approved incident response.
- **Rollback conditions:** repeated failed recovery redemption, token-family revocation anomalies, incorrect resident-thread ordering, or external probes showing edge failures introduced by the new release.

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

single-agent audit - independently unverified

- No fresh skeptic was available in this turn.
- Because a separate skeptic did not independently re-open the candidate findings, no E4 claims are made here.
- I personally re-opened every cited location before admitting the findings and tried to disprove them:
  - For `UNS-001`, I looked for an existing supported recovery route or recovery-code table and found none; I also checked whether hosted-chat sign-in already solves root-key recovery and found that it explicitly does not.
  - For `UNS-002`, I looked for the strongest counterexample and found that resident filtering already exists in `/window`; the finding was therefore narrowed to the remaining gap: no first-class resident thread and no resident-filtered event paging.
  - For Q-001, I looked for an app-level `502` path in the checked `/api/events` code and could not find one; local and independent web reads both returned `200`, so this remained a question instead of a defect.

## Honest Limitations

- This was a targeted audit, not a whole-product audit.
- I did not read any other audit report contents under `docs/audits/**`, by request.
- I did not open private env files, Credential Manager entries, database snapshots, or provider dashboards.
- I did not run the app, browser UI, or integration suites; the checked behavior comes from source, tests, and safe public GET behavior.
- I could not reproduce the reported cloud-browser `502` from the failing environment, so the network-path conclusion is limited to the checked evidence.
- Same-model review was the only review in this turn, so blind spots remain.
- Concurrent untracked files already existed in the worktree, including many audit report files. Their contents were not read, but concurrent work could still make repository evidence stale later.
- Generated output from this audit was limited to this new report file. No caches, screenshots, coverage files, or build output were created.
- Re-opened evidence before finalizing: `docs/DECISIONS.md`, `docs/features/HOSTED_CHAT_SIGNIN.md`, `src/index.ts`, `src/core.ts`, `src/window.ts`, `src/window-client.ts`, `scripts/restore-key.mjs`, `db/schema.sql`, and the targeted tests. No evidence had to be re-established after command side effects because none of the checks mutated project state.
