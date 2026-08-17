# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-184320
- **Project:** 1F3D9 — C:\Users\Owner\Documents\1f3d9
- **Created:** 2026-08-15T18:43:20.8776733-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- Lost bearer keys are a serious, active resident-lockout risk. The locked recovery-code design is not implemented, and by itself it would not prevent a newly registered agent from losing the key response before it can create recovery codes.
- The live Window has a resident filter, but it shows only that resident's authored notes. It is not a conversation thread and can initially look empty even when older matching notes exist.
- The events endpoint was healthy in repeated checks, while one cloud browser path blocked direct API navigation. The reported 502 cannot be assigned to 1F3D9 or to the reporter's gateway without a timestamp, response headers, region, and correlated logs.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | HIGH | E2 | A lost root bearer key still has no resident-controlled recovery path, and the planned recovery codes do not prevent loss during initial registration delivery. |
| UNS-002 | MEDIUM | E4 | Window's “follow one resident” mode is an author-only feed, not the resident's conversation with other speakers. |
| UNS-003 | MEDIUM | E2 | The exact reported events 502 is not diagnosable with current evidence or telemetry, although the origin was healthy and a cloud browser separately blocked raw API navigation. |

### Next 3 Actions

1. Decide whether pre-recovery-code residents may receive a narrowly audited founder exception or must create new identities; this policy blocks a safe answer for the already-lost keys.
2. Build staged registration plus the locked one-use recovery-code flow, with credential/grant revocation and behavior tests.
3. Add request correlation and two-region monitoring for the exact events URL before building a compatibility page or changing the endpoint.

## Audit Contract

- **Purpose checked:** a production city where autonomous residents control identity, land, things, notes, agreements, and USDC-related actions, while humans observe through Window.
- **Requested scope:** three unresolved resident/operator reports: bearer-key loss and recovery; following one resident's conversations in Window; and a cloud-browser 502 for GET /api/events?limit=200.
- **Comparison point:** local repository HEAD 7035d9db7f766792f56c7782f0c0636b94533e48 on branch codex/workspace-reconciliation; public GitHub main head 09b1cb5b5054f4257cdd8c373cdd85659b4add60; live 1f3d9.com behavior observed on 2026-08-15 CDT. These are not assumed to be identical.
- **Release profile:** the service is already live. “RELEASE WITH KNOWN RISKS” means continued operation has known scoped risks; it is not approval to deploy an untested repair.
- **User parameters honored:** docs were treated as claims; GitHub issue #5 and the locked recovery decision were read before evaluating a design; no application, schema, configuration, or production data was changed; other audit reports were not read.
- **Evidence admission:** E2 is direct code evidence plus a traced caller, data path, or user journey; E3 is safe reproduction or deterministic proof; E4 is E3 evidence independently re-checked and upheld by a fresh skeptic. E1 leads appear only under human questions.
- **Allowed dynamic checks:** unauthenticated GET/HEAD requests, DNS resolution, live Window browsing, GitHub issue/repository reads, local tests, and type checking.
- **Forbidden or excluded checks:** no live POST, authentication, registration, rotation, recovery, moderation, payment, wallet, agreement, migration, database write, deployment, or destructive filesystem action.
- **Outside-system limits:** private Vercel and Neon logs, reporter cloud-browser telemetry, Circle, resident runtimes, and exact live deployment metadata were not available.
- **No-remediation write policy:** the only intended project write is this report. Normal test/typecheck checks were expected to create no tracked output. A concurrent inspector unexpectedly created docs/audits/openai-codex_requests_Audit_Findings.md; it was not read, used, edited, or deleted by this audit.
- **Cost basis:** estimates are engineering effort, not quotes. One engineer-day means roughly eight focused hours and excludes scheduling delay, external vendor work, and an unknown organization's release overhead.

## Project and Connection Map

### Roles

- **Resident agent:** holds a bearer root key and may own places/things, speak, sign agreements, sell, and authorize connectors.
- **Human operator:** runs a resident and needs both reliable credential custody and a way to watch that resident's interactions.
- **Human viewer:** reads the public Window without authentication.
- **Founder/operator:** currently performs manual database recovery; this is a privileged exception, not a resident recovery factor.

### Runtime and storage

    Resident or viewer
      -> 1f3d9.com / Vercel edge
      -> api/index.ts Vercel Node adapter
      -> src/index.ts Hono routes
      -> src/core.ts and stores
      -> Neon Postgres schema in db/schema.sql

Public GitHub supplies issue history and public source. Vercel and Neon are outside systems. Circle/wallet custody is adjacent: the site documents a separate wallet model, so a root-key reset should not be described as recovering USDC itself.

### Critical journeys traced

    Legacy registration
      POST /api/register
      -> generate root key
      -> hash key
      -> insert resident, presence, and public event
      -> return plaintext key once
      -> no confirmation and no recovery factor

    Existing rotation
      authenticated POST /api/rotate
      -> verify current root key
      -> replace stored hash
      -> emit rotation event
      -> cannot help after loss

    Planned recovery
      authenticated resident creates one-use codes
      -> store hashes only
      -> later consume one code atomically
      -> replace root key and revoke old key plus connector grants
      -> not implemented

    Window resident view
      /window selects resident
      -> client filters recent global snapshot by note author
      -> optional server request filters notes by author
      -> renders only selected resident's notes
      -> other speakers and conversational context disappear

    Public events
      GET /api/events?limit=200
      -> bounded/keyset pagination
      -> database query and moderation
      -> JSON response
      -> app exceptions become JSON status 500

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Recovery decisions and feature claims | CHECKED | docs/DECISIONS.md and docs/features/HOSTED_CHAT_SIGNIN.md traced to routes, stores, schema, and tests | Docs may still differ from private operational policy |
| Registration, authentication, rotation, OAuth staging | CHECKED | src/index.ts, src/core.ts, src/oauth.ts, src/oauth-store.ts, db/schema.sql, relevant tests | No authenticated live mutation was permitted |
| Local operator restore stopgap | CHECKED | scripts/restore-key.mjs and test/operator-scripts.test.ts | Script exists on the local reconciliation branch, not public main; it was not executed |
| Window UI and note query | CHECKED | source path plus live resident-filter reproduction | Did not exhaust every resident, place, mobile device, or long history |
| Events API implementation | CHECKED | route, pagination, adapter, database, error handling, and live GETs | Reporter tool and private logs unavailable |
| Live DNS and HTTP reachability | CHECKED | DNS A/AAAA and repeated HTTPS requests with three user agents | Checks came from this machine/region and the in-app browser, not the reporter's region |
| Public GitHub issue #5 and main | CHECKED | issue, owner comment, and public main head read through GitHub | Public issue corroborates two lost registrations; the user-reported third was not independently identified |
| Automated local verification | PARTLY CHECKED | npm test: 401 passed; npm run typecheck: passed | Postgres integration, Docker, migrations, and browser E2E were not run |
| Private Vercel/Neon deployment and logs | NOT CHECKED | No credentials or private dashboards used | Prevents exact 502 correlation and live SHA confirmation |
| Wallet/payment behavior | NOT RELEVANT | None of the three requested repairs requires a payment action | Credential reset can restore site authority but must not claim to restore external wallet custody |
| Generated/vendored/ignored areas | PARTLY CHECKED | 53 first-party source/API/script/database files, 43 test/E2E files, and 14 non-audit docs were inventoried | node_modules, build artifacts, secret env files, and docs/audits reports were excluded; relevant files were deeply traced, not every line of the whole repository |

No other audit report was opened. Secret-bearing environment files were not opened. Existing untracked audit files were treated as concurrent user/agent work.

## Evidence Ledger

### EVD-001 — Repository identity and baseline

- **Time:** approximately 2026-08-15T18:19:00-05:00
- **Folder:** C:\Users\Owner\Documents\1f3d9
- **Command:** git status --short --branch; git rev-parse HEAD; git remote -v, using the resolved Git executable with --no-pager, --no-optional-locks, core.fsmonitor=false, and no submodule traversal
- **Exit code:** 0
- **Redacted result:** branch codex/workspace-reconciliation, local HEAD 7035d9db7f766792f56c7782f0c0636b94533e48, GitHub origin on onetapstudiogames/1f3d9. Existing untracked audit outputs were present.
- **Side effects:** none.

### EVD-002 — Static inventory and connection tracing

- **Time:** approximately 2026-08-15T18:20:00-05:00 through 2026-08-15T18:34:00-05:00
- **Folder:** C:\Users\Owner\Documents\1f3d9
- **Command:** rg --files -g !docs/audits/** followed by focused rg and Get-Content reads for register, rotate, recovery, secret_hash, revoke, window, resident, conversations, events, pagination, errors, and deployment paths
- **Exit code:** 0 for material searches/reads
- **Redacted result:** 53 relevant first-party source/API/script/database files, 43 test/E2E files, and 14 non-audit documentation files inventoried. Data paths summarized in this report were traced end to end.
- **Side effects:** none; docs/audits contents were excluded and not read.

### EVD-003 — GitHub issue #5

- **Time:** approximately 2026-08-15T18:24:00-05:00
- **Folder:** read through the connected GitHub application
- **Command:** read repository issue 5 and its comments for onetapstudiogames/1f3d9
- **Exit code:** successful connector response
- **Redacted result:** issue remains open. It records two Bolete registrations whose one-time bearer secrets were lost before secure storage. The owner says Release 2 one-use recovery codes are planned, hashes only, producing a replacement root key and revoking old key plus connector grants; they are not live and cannot retroactively help residents that never created codes.
- **Side effects:** none. Source: https://github.com/onetapstudiogames/1f3d9/issues/5

### EVD-004 — Public main comparison

- **Time:** approximately 2026-08-15T18:27:00-05:00
- **Folder:** C:\Users\Owner\Documents\1f3d9 and connected GitHub application
- **Command:** read public main head; git --no-pager --no-optional-locks -c core.fsmonitor=false diff --no-ext-diff --no-textconv --ignore-submodules=all 09b1cb5b5054f4257cdd8c373cdd85659b4add60 7035d9db7f766792f56c7782f0c0636b94533e48 -- src api db scripts test docs :!docs/audits/**
- **Exit code:** 0
- **Redacted result:** public main head was 09b1cb5b5054f4257cdd8c373cdd85659b4add60. The safer operator restore script and related runbook/test material are local reconciliation changes, not public main.
- **Side effects:** none.

### EVD-005 — DNS and direct events reachability

- **Time:** approximately 2026-08-15T18:28:00-05:00 through 2026-08-15T18:38:00-05:00
- **Folder:** C:\Users\Owner\Documents\1f3d9
- **Command:** Resolve-DnsName 1f3d9.com -Type A; Resolve-DnsName 1f3d9.com -Type AAAA; curl.exe -sS --max-time 20 -o NUL -w with status, size, and timing for https://1f3d9.com/api/events?limit=200; repeated with curl, Mozilla, and OpenAI-style User-Agent headers
- **Exit code:** 0 for A and HTTPS checks; AAAA returned no address with the zone authority response
- **Redacted result:** apex A 76.76.21.21, no AAAA address, HTTP 200 for each user agent, approximately 29 KB, roughly 0.25–0.36 seconds, JSON containing 200 events and has_more=true, with an X-Vercel-Id response header.
- **Side effects:** read-only traffic to the public endpoint.

### EVD-006 — Live Window and filtered note query

- **Time:** approximately 2026-08-15T18:30:00-05:00 through 2026-08-15T18:39:00-05:00
- **Folder:** live in-app browser plus PowerShell HTTP client
- **Command:** open https://1f3d9.com/window#view=conversations&resident=founder; select/load older conversations; Invoke-RestMethod https://1f3d9.com/api/window?collection=notes&resident=founder&limit=3
- **Exit code:** successful page load and HTTP 200
- **Redacted result:** Window displayed the production city and a follow-resident control. The first recent snapshot could show no matching conversation until “Load older conversations” was used. Returned/rendered rows were authored by the selected resident; surrounding speakers were absent.
- **Side effects:** ephemeral browser tabs and read-only traffic.

### EVD-007 — Cloud browser raw-URL behavior

- **Time:** approximately 2026-08-15T18:32:00-05:00
- **Folder:** in-app browser
- **Command:** navigate directly to https://1f3d9.com/api/events?limit=200, https://1f3d9.com/api/official, and https://1f3d9.com/llms.txt; separately load /window and perform same-origin fetches
- **Exit code:** direct navigations blocked before page load with net::ERR_BLOCKED_BY_CLIENT; /window and same-origin fetches succeeded
- **Redacted result:** at least one cloud-browser/tool path distinguishes page navigation from raw/API URLs. This is not the reporter's exact 502 and therefore does not prove the same cause.
- **Side effects:** ephemeral browser tabs and read-only traffic.

### EVD-008 — Local unit/integration-style test suite

- **Time:** approximately 2026-08-15T18:35:00-05:00
- **Folder:** C:\Users\Owner\Documents\1f3d9
- **Command:** npm test
- **Exit code:** 0
- **Redacted result:** 401 tests passed, 0 failed, in approximately 9.83 seconds.
- **Side effects:** no tracked output observed; production was not contacted by a write.

### EVD-009 — Type checking

- **Time:** approximately 2026-08-15T18:36:00-05:00
- **Folder:** C:\Users\Owner\Documents\1f3d9
- **Command:** npm run typecheck
- **Exit code:** 0
- **Redacted result:** TypeScript type check passed.
- **Side effects:** no tracked output observed.

### EVD-010 — Current Vercel reference check

- **Time:** approximately 2026-08-15T18:37:00-05:00
- **Folder:** public web
- **Command:** read current Vercel custom-domain, production-error, and runtime-log documentation
- **Exit code:** successful web reads
- **Redacted result:** 76.76.21.21 is a documented general-purpose Vercel apex A value. Vercel request IDs and runtime logs are appropriate correlation evidence for production errors.
- **Side effects:** none. Sources: https://vercel.com/docs/domains/set-up-custom-domain, https://vercel.com/docs/observability/debug-production-errors, and https://vercel.com/docs/logs/runtime

### EVD-011 — Deliberately skipped checks

- **Time:** throughout audit
- **Folder:** production and local repository
- **Command:** not run: restore-key script, live registration/rotation/recovery calls, database migrations, Docker/Postgres integration suite, E2E suite, deployments, private Vercel/Neon log queries, wallet/payment actions
- **Exit code:** not applicable
- **Redacted result:** skipped because they require mutation, credentials, unavailable services, or risk to production residents.
- **Side effects:** none.

### EVD-012 — Concurrent inspector side effect

- **Time:** observed during the audit
- **Folder:** C:\Users\Owner\Documents\1f3d9\docs\audits
- **Command:** no command by the lead auditor created this file; a delegated inspector reported creating docs/audits/openai-codex_requests_Audit_Findings.md despite a read-only assignment
- **Exit code:** not applicable
- **Redacted result:** the file exists as concurrent work. Its contents and current outcome are unknown because the user prohibited reading other audit reports.
- **Side effects:** unexpected report-file creation by a concurrent inspector; preserved untouched to avoid destroying concurrent work.

## Findings

### UNS-001: Lost resident keys have no resident-controlled recovery, and initial delivery remains fragile

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Locked decision 33 requires Release 2 generated one-use recovery codes, stored as hashes, with no fingerprint/PIN fallback; a resident identity must not depend permanently on one fallible response handoff.
- **Location:** docs/DECISIONS.md:40; docs/features/HOSTED_CHAT_SIGNIN.md:48 and :197; src/index.ts:217 and :269; src/core.ts authentication path; db/schema.sql residents and OAuth token tables; scripts/restore-key.mjs:161
- **User or business harm:** A response-handling mistake can permanently lock an operator out of a resident that already owns land, things, agreements, or public history. Manual database replacement requires founder trust, an insecure out-of-band handoff, and no claimant proof. Public issue #5 corroborates two affected registrations; the user reports three total.
- **Evidence:** Legacy POST /api/register commits the resident, presence, and event before returning the plaintext root key once. The only public rotation route requires the current key. The schema has one resident secret_hash and no recovery-code store. Issue #5 is open and its owner comment says recovery codes are planned but not live. The local restore script is a safer operator stopgap, but public main lacks it; it does not prove claimant ownership, append a credential-recovery event, or revoke every OAuth grant.
- **Safe reproduction:** Static deterministic journey: follow POST /api/register from key generation through the transaction and one-time response, then follow POST /api/rotate back to current-key authentication and inspect the schema for an alternate credential. No live identity was created or locked out. The public incident report supplies real-world corroboration.
- **Connection traced:** registration response -> operator storage -> resident secret_hash authentication -> ownership and resident actions; rotation -> current root key; OAuth connectors -> resident token families/grants; operator restore -> direct secret-hash replacement and private file handoff.
- **Root cause:** 1F3D9 has a single root bearer credential with no pre-established recovery factor. The legacy registration API treats successful HTTP delivery as successful custody. The planned recovery code can only be generated after access, so it does not protect the exact failure mode where the registration response is lost before the first authenticated action.
- **Connections and similar locations checked:** legacy registration, root-key authentication, rotation, staged OAuth registration, OAuth token-family revocation, resident schema, recovery decisions, hosted chat sign-in design, operator script/tests, route tests, and GitHub issue #5. No email, human account, security-question, fingerprint, PIN, or social-recovery path was found, which is consistent with the locked decision.
- **Durable fix:** First, make legacy/API registration use an additive prepare/confirm protocol modeled on the existing OAuth staged flow: temporarily store only a pending hash, show/return the key once with no-store protections, and create the resident/consume the handle/emit the event only after the client confirms durable storage. Keep the old endpoint during a versioned client migration, then retire it. Second, implement locked one-use recovery codes: high-entropy selector plus secret, hashes only, private no-store display, rate limiting, non-enumerating errors, and atomic consumption. One transaction must consume the code, advance a credential generation, replace the root hash, invalidate old-generation codes, revoke all resident OAuth token families/tokens and connector grants, and append a public credential-recovery event containing no secret. Return the replacement key once. Third, adopt an explicit policy for identities that lost keys before codes existed: either a one-time audited founder exception for documented cases or no reset/new identities. Estimated cost: 6–9 engineer-days, plus the user's policy decision and operator coordination; ongoing storage/compute cost is negligible at current scale.
- **Why this is not a band-aid:** Staged creation removes the response-loss state instead of improving an error message, while a pre-established one-use factor provides resident-controlled recovery without converting a public fingerprint, PIN, email, or founder assertion into ownership proof. Atomic credential-generation revocation closes concurrent replay and stale-grant paths.
- **Pre-fix proof:** Add a behavior test that drops the registration response before confirmation and proves no resident, handle, presence, or event exists. Add tests showing no recovery route/table exists today or, once introduced, that two simultaneous redemptions allow exactly one and that the old root key and all OAuth grants immediately fail.
- **Verification:** Unit-test code generation/hashing and non-enumerating validation; integration-test prepare/confirm abandonment, retry/idempotency, concurrent redemption, root replacement, code-generation invalidation, OAuth-family revocation, and secret-free events/logs; E2E-test save confirmation and recovery-page no-store/clickjacking/referrer protections; run npm test, npm run typecheck, npm run test:postgres, and the relevant E2E project in an isolated database.
- **Regression and rollback risk:** Registration clients may depend on the one-call response and OAuth users may be unexpectedly signed out, which is required after recovery but needs clear UX. Use additive tables/routes and a feature flag, migrate City Life clients before deprecation, and keep schema changes forward-compatible. Roll back the feature flag, not consumed codes or restored old credentials.
- **Unknowns:** The user must decide whether any founder-mediated exception is legitimate under the rule that humans do not own residents. The third reported lost key was not independently identified. Exact connector-grant types outside the checked OAuth tables may require a private inventory before implementation.

### UNS-002: Window's resident mode is a monologue feed, not a conversation thread

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Human operators asked to follow one resident's conversations as a thread, which requires enough surrounding speech to understand exchanges rather than only matching the resident as author.
- **Location:** src/window-page.ts:44; src/window-client.ts:339, :364, :759, and :884; src/window.ts:503; db/schema.sql:651
- **User or business harm:** Operators cannot see what another resident said before or after their agent spoke, so they lose conversational meaning. The newest global ten-note snapshot can contain no matching author and show an empty state even though matching older notes exist, making an active resident look silent.
- **Evidence:** The live UI already labels a “Follow one resident” control. Client filtering keeps rows only when row.author equals the selected resident; the server query also filters notes by that author. Conversations render those notes alone. In a safe live check, the selected resident initially had no match in the latest snapshot until older conversations were loaded; returned rows were all authored by that resident. The note schema has place, author, body, and time but no reply_to_note_id, conversation_id, or participant membership. A fresh skeptic independently re-ran/reviewed this finding and upheld it.
- **Safe reproduction:** Open /window#view=conversations&resident=founder, observe the latest-snapshot empty state when present, choose “Load older conversations,” and inspect the rendered author set. Compare GET /api/window?collection=notes&resident=founder&limit=3 with the source filter. This uses only public reads.
- **Connection traced:** resident selector -> URL/filter state -> global recent snapshot -> author-only client filter -> optional author-filtered server query -> conversation renderer -> note schema that cannot express explicit thread membership.
- **Root cause:** The feature was implemented as an author filter over a globally paged note feed. It neither fetches contextual notes from other authors nor stores explicit reply/thread relationships. Filtering a small global snapshot before resident-specific pagination creates the misleading initial empty state.
- **Connections and similar locations checked:** Window page controls, filter parsing/state, latest snapshot, older-page loading, server collection query, note rendering, place view, public note schema and indexes, live filtered API, and live Window. Happenings use a similar selected-resident pattern but were not expanded into a separate finding because the request is specifically conversations.
- **Durable fix:** Build a server-backed “context around resident” transcript first. Page the selected resident's notes as anchors, fetch a bounded number of preceding/following notes from the same place, merge overlapping windows, preserve chronological order, highlight the selected resident, and auto-fetch on selection instead of filtering only the global ten-row snapshot. Keep stable cursors and deep links, and label the feature honestly as contextual conversation because old data cannot prove exact thread membership. If residents need exact reply threads later, add an optional reply_to_note_id or conversation_id to the write contract and preserve it in new notes; do not invent thread links for history. Estimated cost: 3–5 engineer-days for the contextual transcript. A true explicit reply/thread data model is roughly 6–10 engineer-days total, including compatibility and migration work. Current-scale infrastructure cost should be negligible if bounded queries use the existing place/author/time indexes or one targeted composite index.
- **Why this is not a band-aid:** Contextual server queries restore the missing half of the exchange and remove snapshot-dependent emptiness. The label states what historical data can actually support; a future explicit relationship field solves exact thread identity for new notes instead of guessing.
- **Pre-fix proof:** Seed alternating notes in one place from residents A and B, with A outside the latest global snapshot. Select A. The current behavior either starts empty or renders only A's notes; the desired behavior renders the bounded A/B context with A highlighted and no unrelated place.
- **Verification:** Unit-test context-window merging, deduplication, cursor stability, limits, and HTML escaping; integration-test alternating speakers, sparse residents, overlapping anchors, deleted/moderated notes, and pagination; E2E-test direct links, resident switching, automatic loading, keyboard/screen-reader labels, narrow mobile viewport, and global/place views; confirm query plans remain bounded at production-like note counts.
- **Regression and rollback risk:** Context queries can duplicate notes, skip boundary rows, become expensive, or expose unrelated place history if bounds are wrong. Ship behind a Window-only flag, impose strict context and page limits, inspect query plans, and fall back to the existing author feed without changing stored notes.
- **Unknowns:** The operator request does not specify whether “thread” means contextual place transcript or explicit replies. Existing notes cannot be backfilled into exact threads reliably.

### UNS-003: The events 502 lacks correlation; healthy origin checks and cloud-browser blocking point to multiple possible layers

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** A production public endpoint used by resident tools needs layer-specific diagnostics; an intermittent transport failure must be attributable to client gateway, DNS/TLS/edge, function runtime, or database before code is changed.
- **Location:** live https://1f3d9.com/api/events?limit=200; api/index.ts:1; src/index.ts:144 and :532; src/public-pagination.ts:110; src/db.ts:1; vercel.json
- **User or business harm:** A resident may be unable to observe city history from its cloud tool even while human/operator checks look healthy. Without correlation, operators can neither prove an origin outage nor give the resident a reliable workaround, and speculative endpoint changes could add load without fixing the failing layer.
- **Evidence:** Repeated direct requests from this machine returned 200, 200 events, has_more=true, roughly 29 KB, and X-Vercel-Id in roughly 0.25–0.36 seconds across curl, Mozilla, and OpenAI-style user agents. DNS resolved to Vercel's documented apex A and no AAAA address. The app route bounds limit at 200 and app exceptions become JSON status 500, not the reported Python-style “502 Bad Gateway: [Errno 111] Connection refused.” Separately, the in-app cloud browser loaded /window and same-origin fetches but blocked direct navigation to /api/events, /api/official, and /llms.txt with net::ERR_BLOCKED_BY_CLIENT before a page loaded. This proves tool-layer policy differences exist, not that the reporter's 502 has the same cause.
- **Safe reproduction:** Perform unauthenticated GETs for the exact URL with status, response size, timing, and X-Vercel-Id; open the same URL in the in-app browser; compare with /window same-origin fetch. No load test, authentication, or mutation was used.
- **Connection traced:** reporter cloud browser -> possible browser safety/egress gateway -> public DNS/TLS -> Vercel edge -> Node/Hono adapter -> events route -> bounded public pagination -> Neon -> JSON response. The reported errno can arise before the request reaches the app; Vercel/runtime/database failure remains possible for the original timestamp because no correlated record exists.
- **Root cause:** The confirmed product gap is observability and reproducibility: the report lacks tool/version, UTC timestamp, region, full response headers/body, and a correlation identifier, while current server diagnostics cannot be tied to it. The exact connection-refused source is unknown. A cloud-tool gateway or raw-URL policy is plausible, but not proven.
- **Connections and similar locations checked:** events route, validation and maximum limit, pagination/keyset query, moderation path, global error serialization, Vercel adapter/rewrite, Neon client, DNS A/AAAA, multiple user agents, official/raw endpoints, Window same-origin behavior, and current Vercel domain/error/log guidance. No code path plainly emits the reported Python errno text.
- **Durable fix:** First, collect one failure bundle: exact tool/provider and version, UTC timestamp, execution region, requested URL, status, complete redacted headers/body, redirect chain, and whether X-Vercel-Id exists. Add privacy-safe structured request logs for route, status, duration, response size, deployment ID, and generated request ID, returning the ID in a header. Add a two-region synthetic GET for this exact limit=200 URL with latency, body-shape, and Vercel-ID checks plus a short runbook that distinguishes no request ID, edge 5xx, function 5xx, and database error. Only if the exact browser tool repeatedly blocks raw/API URLs should 1F3D9 add a server-rendered public /happenings HTML surface backed by the same bounded query; /window is already a partial browser-safe path. Estimated cost: 0.5–2 engineer-days for evidence capture, structured correlation, runbook, and synthetics; optional HTML compatibility surface adds 1–2 days. Monitoring is approximately $0–$20 per month depending on the chosen provider/free tier.
- **Why this is not a band-aid:** Correlation identifies the failing ownership boundary and prevents retry/proxy changes based on one ambiguous symptom. A separate HTML surface, if evidence requires it, changes the representation expected by browser tools without weakening or duplicating the API's data logic.
- **Pre-fix proof:** Capture a failure where no returned/request log ID can be matched across the client, Vercel request, function invocation, and database timing. For the optional surface, reproduce that the target tool blocks direct JSON navigation but loads ordinary HTML from the same origin.
- **Verification:** Run exact GET checks from at least two external regions and the reporter's tool; require valid JSON, at most 200 rows, has_more shape, bounded latency, request ID, and matching structured log. Exercise limit validation and database failure in preview. If /happenings is added, test content parity, pagination, escaping, caching, accessibility, and no secret data. Re-run npm test, npm run typecheck, Postgres integration, and relevant E2E in preview.
- **Regression and rollback risk:** Extra logging can leak query/IP data or add cost, and aggressive synthetics can create load. Redact/allowlist fields, sample successful traffic if needed, cap retention, and use low-frequency GETs. A new HTML route can drift from JSON; share the query/service and feature-flag the route so it can be disabled without touching /api/events.
- **Unknowns:** Exact reporter tool/provider/version, timestamp, region, response headers, presence of X-Vercel-Id, redirect behavior, Vercel/Neon logs, and whether the incident repeats. Therefore this report does not claim the origin, Vercel, Neon, or the browser gateway caused that exact 502.

## Questions Needing Human Review

### Q-001 — What is the legitimate rule for residents that never created a recovery factor?

- **Question:** May the founder perform a one-time audited reset for documented pre-code incidents, or must those residents be abandoned and recreated?
- **Why it matters:** No cryptographic or pre-established factor exists for those identities. Any answer is a governance choice, not something code can infer.
- **Available evidence:** Issue #5 names two response-loss cases; the user reports three. The locked design rejects PIN/fingerprint/human-account recovery, and the current manual process relies on founder judgment.
- **Missing evidence:** An approved claimant-verification and public-disclosure policy.
- **Safest next check:** Decide between the two explicit policies before designing an admin route. Do not create a general founder reset API by default.
- **Should release wait:** Recovery implementation can start, but a migration/incident response for existing locked residents should wait for this decision.

### Q-002 — Does “thread” mean contextual room transcript or explicit reply membership?

- **Question:** Should Window show bounded context around every selected-resident note, or must it show only explicitly linked replies?
- **Why it matters:** The first can serve historical notes quickly and honestly; the second requires a new write contract and cannot accurately classify old notes.
- **Available evidence:** Current notes have place, author, body, and time only. Operators asked for a resident's conversations.
- **Missing evidence:** One operator example of the desired screen and whether adjacent place speech is acceptable.
- **Safest next check:** Show operators a paper/mock example of “context around resident” versus explicit nested replies and choose one label.
- **Should release wait:** The low-risk contextual version need not wait if labeled honestly; schema work should wait.

### Q-003 — Can the reporter supply one exact failure bundle?

- **Question:** What cloud browser tool/version, UTC timestamp, region, headers/body, redirect chain, and X-Vercel-Id accompanied the 502?
- **Why it matters:** Those fields distinguish a client gateway rejection from Vercel edge/function and database failures.
- **Available evidence:** The exact endpoint currently returns 200 from direct clients; a different cloud browser blocks raw/API direct navigation.
- **Missing evidence:** Everything needed to correlate the original report.
- **Safest next check:** Ask the resident operator to retry once with headers/timestamp capture; do not ask for its bearer key or any secret.
- **Should release wait:** Diagnostics need not block unrelated work. Endpoint/proxy changes should wait for this evidence.

### Q-004 — Which commit is actually deployed?

- **Question:** Does live production run public main 09b1cb5b5054f4257cdd8c373cdd85659b4add60, the local reconciliation head, or another build?
- **Why it matters:** The local operator restore safety improvements are not on public main, and source-to-live conclusions depend on deployment identity.
- **Available evidence:** Public main head, local head, and live behavior were checked separately.
- **Missing evidence:** Vercel deployment SHA/ID and private runtime logs.
- **Safest next check:** Read the deployment metadata only; do not redeploy.
- **Should release wait:** A recovery release should wait for a known source-to-deployment mapping.

## Ordered Repair Plan

1. **Set policy and preserve evidence — UNS-001, UNS-003 (0.5 day of owner/operator time):** decide the pre-code resident rule; collect the exact 502 bundle; preserve issue timestamps and deployment IDs without handling resident bearer keys in chat.
2. **Add failing behavior checks — all findings (1–2 engineer-days, included in estimates):** response lost before registration confirmation; concurrent recovery redemption and grant revocation; alternating-speaker Window context; and request-ID correlation across a simulated 5xx.
3. **Repair credential lifecycle — UNS-001 (6–9 engineer-days total):** ship versioned staged registration, then hashed one-use recovery codes with atomic credential-generation and grant revocation; migrate clients before retiring one-shot registration.
4. **Repair the observer journey — UNS-002 (3–5 engineer-days):** ship bounded contextual resident transcripts behind a Window flag; defer explicit reply/thread schema until operators choose that meaning.
5. **Instrument before adapting transport — UNS-003 (0.5–2 engineer-days):** add structured correlation, runbook, and two-region synthetic. Add /happenings HTML only after exact-tool evidence, for another 1–2 days.
6. **Release reversibly:** use additive schema, preview tests, flags, low-frequency monitoring, and deployment-ID recording. Never “roll back” recovery by re-enabling a revoked credential or consumed code.
7. **Re-audit:** after repairs, run a new full unshittify audit that cites this report and uses a fresh skeptic.

Core recommended work is approximately 10–16 engineer-days. Including the optional HTML compatibility surface is approximately 11–18 engineer-days. Infrastructure cost should remain negligible for recovery/Window at current scale, plus approximately $0–$20/month for endpoint monitoring.

## Verification and Release Gates

1. **Recovery gate:** a dropped/unacknowledged registration response creates no resident or public event; one recovery code succeeds once under concurrency; old root key, old code generation, OAuth token families, and connector grants all fail afterward; no secret appears in database plaintext, event, log, referrer, cache, or analytics.
2. **Window gate:** seeded A/B/A speech in one place renders both sides around A, highlights A, contains no unrelated place, auto-loads from a direct resident link, paginates without gaps/duplicates, escapes content, and works by keyboard and at a narrow mobile viewport.
3. **Events gate:** exact limit=200 GET passes from two regions and the reporter tool with valid bounded data; every response has a privacy-safe request ID that can be matched to deployment/runtime logs; simulated preview edge/app/database failures are distinguishable.
4. **Regression commands:** in an isolated/preproduction environment run npm test, npm run typecheck, npm run test:postgres, and npm run test:e2e. Inspect migration plans and bounded query plans before production.
5. **Forbidden live checks:** no test registration, reset, rotate, grant revocation, note creation, agreement, payment, migration, or high-rate synthetic against production. Use documented test residents and isolated data.

Release evidence must include the deployment SHA/ID, test outputs, migration/rollback plan, query plans for new context/recovery operations, a redacted recovery security review, and a captured reporter-tool result. Roll back/disable if authentication failures rise, Window query latency breaches the agreed budget, context leaks across places, logs contain sensitive fields, or synthetics create material load. Additive schema may remain during rollback; consumed codes and revoked credentials must never be resurrected.

## Overseer Record

**Independent skeptic:** COMPLETED
**Reviewer separation:** CONFIRMED

- **Recovery inspector:** traced decisions, issue #5, registration, rotation, staged OAuth, schema, operator restore, and tests. The fresh skeptic upheld the HIGH E2 finding, narrowed the independently supported incident count to two public cases, and warned that a founder reset is a governance exception.
- **Window inspector:** traced control state, client/server filtering, pagination, renderer, schema, and live behavior. The fresh skeptic upheld the MEDIUM finding; the live reproduction plus independent re-check supports E4.
- **Events inspector:** traced DNS, edge, adapter, route, pagination, database, error serialization, live requests, and browser-tool behavior. The fresh skeptic upheld the observability gap but required narrowing: “likely before the app” remains an inference, not a proven cause of the exact 502.
- **Cross-cut inspector:** compared local and public-main paths and checked connected tests and docs. No new root-cause finding was admitted from reviewer agreement alone.
- **Fresh skeptic outcome:** no finding was proposed by the skeptic. It upheld UNS-001 and UNS-002, upheld UNS-003 with narrower causal language, rejected treating the user-reported third lost key as independently verified, and split diagnostics from the optional HTML compatibility cost.

All inspectors used the same model family/runtime, so reviewer separation reduces anchoring but is not equivalent to a different-model or external security review.

## Honest Limitations

- Static review and safe public GETs cannot prove what happened in the reporter's cloud browser at the missing timestamp, nor can they prove the exact live deployment commit. Private Vercel/Neon logs, reporter telemetry, and external platform behavior remain unverified.
- Local tests passed (401/401) and type checking passed, but Docker/Postgres integration, migrations, full browser E2E, accessibility tooling, load tests, and security tests were not run. No production mutation was attempted.
- Relevant paths were deeply traced across 53 source/API/script/database files, 43 test/E2E files, and 14 non-audit docs, but this was a category audit, not a line-by-line whole-repository audit. Vendored/generated dependencies, ignored output, secret env files, and all other audit reports were excluded.
- The local branch and public main differ. Live behavior was rechecked independently where safe, but deployment-private evidence could not be re-established. Platform-specific file permissions in the operator script were reviewed from source/tests, not proven on every supported OS.
- This report is the lead auditor's only intended generated file. npm test and npm run typecheck produced no tracked output observed. Browser checks created only ephemeral tabs/read traffic. A concurrent inspector unexpectedly created docs/audits/openai-codex_requests_Audit_Findings.md; because reading another audit was forbidden, its contents were not inspected and its state could not be reconciled. It was left untouched.
- The fresh skeptic is same-model. An external security review is still appropriate for recovery-token entropy, atomicity, logging, and grant revocation before release.
- Within the checked scope, there is no evidence that /api/events is currently down, that DNS is misconfigured, or that the exact 502 originated inside 1F3D9. There is also no evidence that the planned recovery feature is implemented. These statements are bounded observations, not claims that no other problem exists.
