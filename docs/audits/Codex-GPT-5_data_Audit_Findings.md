# Unshittify Audit

**Audit ID:** 1F3D9-DATA-CODEX-GPT5-20260815  
**Project:** 1F3D9  
**Created:** 2026-08-15 18:29:48 CDT (UTC-05:00)  
**Category:** Data layer — database access, schema, migrations, backup, and restore  
**Source revision:** `7035d9db7f766792f56c7782f0c0636b94533e48` on `codex/workspace-reconciliation`  
**Audit mode:** Read-only source audit plus safe local tests; this file is the only intentional root-agent write

## Plain-English Verdict

DO NOT RELEASE

The data layer has strong SQL constraints, broad local tests, and generally atomic in-database writes. It still has two stop-ship failure paths:

1. Several real-USDC flows settle x402 before the city has a durable intent, result, or reconciliation record.
2. A Vercel preview can fall back to the general `DATABASE_URL`, so one environment-scope mistake can turn a public preview into a production writer.

The public map also has a persistent, resident-creatable denial-of-service path. Backup targeting, backup consistency, recovery proof, migration observability, and private-data retention need hardening.

For the already-live site, this verdict is not proof that money has been lost or production data has been corrupted. It means the unsafe windows are present now and should block further releases until the two blockers have release-gate proof.

### Findings at a Glance

| ID | Severity | Evidence | Status | Finding |
|---|---|---:|---|---|
| UNS-001 | BLOCKER | E3 | Confirmed | x402 settlement can succeed before any durable city record exists |
| UNS-002 | BLOCKER | E3 | Confirmed | Ordinary previews can select the general database URL |
| UNS-003 | HIGH | E3 | Confirmed | The complete public map can be driven into stack exhaustion and quadratic work |
| UNS-004 | HIGH | E2 | Likely | Backup and key-recovery tools infer their target without proving database identity |
| UNS-005 | HIGH | E2 | Likely | The JSON export is not one point-in-time PostgreSQL snapshot |
| UNS-006 | MEDIUM | E2 | Likely | The repo-produced JSON artifact has no repo-tested restore path |
| UNS-007 | MEDIUM | E2 | Likely | Applied migrations are not durably recorded and some live DDL has no wait bound |
| UNS-008 | MEDIUM | E2 | Likely | Expired OAuth records are retained indefinitely and copied into later exports |
| UNS-009 | LOW | E2 | Likely | Fixed-prefix IP hashes are described as salted but remain enumerable after disclosure |

### Next 3 Actions

1. Gate the affected paid routes until every settlement has a durable, idempotent intent and a tested reconciliation path.
2. Make every preview fail closed without a dedicated preview URL, then replace the recursive map builder with a bounded iterative implementation.
3. Run a guarded recovery rehearsal while adding explicit operator targets, a consistent export/dump, migration state checks, and a retention job.

## Audit Contract

- **Goal:** Find production-relevant data risks by tracing routes and operator commands through database clients, SQL, schema constraints, migrations, exports, and recovery claims.
- **Allowed:** Read first-party source, tests, configuration, and non-audit documentation; run local unit, coverage, browser-fixture, and disposable-PostgreSQL tests; consult official Neon documentation.
- **Prohibited:** Change application code; read any file under `docs/audits` or `.codex/reports`; inspect environment files, credentials, backup contents, or live database/provider state; call paid endpoints or create a real payment.
- **Evidence rule:** E2 is deterministic source proof with an unexecuted or configuration-dependent harm path. E3 is a safe local reproduction. E4 would require an independent reproduction of the complete harm path; no finding is labeled E4 here.
- **Severity rule:** BLOCKER can lose money or write to the wrong production database. HIGH can make the public city unavailable or invalidate operational recovery. MEDIUM materially weakens operability, integrity, or data minimization. LOW is contained defense-in-depth debt.

## Project and Connection Map

```text
Public request / MCP / browser
              |
              v
Vercel rewrite -> api/index.ts -> Hono routes in src/
                                      |             |
                                      |             +-> engine Pool (max 5)
                                      |                    -> interactive PostgreSQL transactions
                                      v
                              src/db.ts Neon HTTP client
                                      |
                                      v
                              Neon PostgreSQL / Lakebase

Operator -> scripts/migrate.ts ----> target proof -> Neon snapshot -> migration transaction
         -> scripts/backup.mjs ----> implicit URL resolver -> independent table reads -> JSON
         -> scripts/restore-key.mjs -> implicit URL resolver -> residents.secret_hash UPDATE
```

Runtime SQL is mostly parameterized through the Neon tagged-template client. Raw-query sites use parameters and validated table whitelists. High-value city mutations commonly use one data-modifying CTE, while physics actions that need multiple statements use the pooled interactive transaction in `src/engine.ts:46-90`. The schema adds extensive checks, foreign keys, uniqueness, topology triggers, and append-only history triggers. Those controls are real strengths; the findings below sit at system boundaries the database transaction cannot cover by itself.

## Coverage and Limits

| Area | Status | Evidence | Limit |
|---|---|---|---|
| Runtime database access and money/property writes | CHECKED | `src/db.ts`, `src/engine.ts`, route SQL, x402 tests, world-market reconciliation | No live request or real settlement was attempted |
| Schema and constraints | CHECKED | Full `db/schema.sql`, all six migration files, disposable PostgreSQL tests | Live schema version and row counts were not queried |
| Migration execution and release gates | CHECKED | `scripts/migrate.ts`, `scripts/deploy.sh`, package commands, migration tests | Neon API/project state and actual applied history were not inspected |
| Backup, key recovery, and restore claims | CHECKED | Scripts, operator tests, runbook, official Neon docs | No environment file, generated backup, provider console, or restore target was opened |
| Tests and failure reproductions | CHECKED | 401 unit tests, 33 PostgreSQL tests, 12 browser tests, focused reproductions | Browser tests use fixtures; no production load or disaster was simulated |

The reviewed first-party source/doc/test universe contained 118 files after excluding audit outputs, report directories, environment files, and backup directories. Broad route coverage was supplemented by focused tracing of every path named in a BLOCKER or HIGH finding.

## Evidence Ledger

| Start time (CDT) | Folder | Exact command or action | Exit | Result | Side effects |
|---|---|---|---:|---|---|
| 2026-08-15 18:18 | repo root | `rg --files -g '!docs/audits/**' -g '!.codex/reports/**' -g '!backup/**' -g '!backups/**' -g '!.env*'` plus safe Git revision/status commands | 0 | 118 in-scope files; commit and branch recorded | None |
| 2026-08-15 18:19 | repo root | `rg -n` searches scoped to `src`, `db`, `scripts`, `test`, and non-audit `docs` for clients, raw queries, transactions, migrations, restore commands, and cleanup SQL | 0/1 | Connection map built; absence searches treated exit 1 as “no match” | None |
| 2026-08-15 18:22:01 | repo root | `npm test` and `npm run typecheck` | 0 | 401/401 tests passed; TypeScript passed | Tests used temporary files and cleaned them |
| 2026-08-15 18:19 | repo root | `npm run test:coverage` | 0 | 401/401 passed; 91.03% lines, 74.54% branches, 87.16% functions; `backup.mjs` 38.15% lines | Coverage collection only |
| 2026-08-15 18:22:29 | repo root | `node --test --experimental-strip-types test/runtime-db-url.test.ts` | 0 | 4/4 passed, including preview-to-general-URL fallback | None |
| 2026-08-15 18:22:29 | repo root | `node --test --experimental-strip-types --test-name-pattern='frontier x402 settles before creation|x402 payer must match' test/routes.test.ts` | 0 | 2/2 passed; settlement precedes insert and a settled mismatch leaves no payment row | Mock facilitator only; no network/payment |
| 2026-08-15 18:22:29 | repo root | In-memory Node script importing `buildPlaceTree` with a 20,000-row parent chain | expected 1 | `RangeError: Maximum call stack size exceeded` | No file or database access |
| 2026-08-15 18:22:36 | repo root | `npm run test:postgres` | 0 | 33/33 passed against disposable PostgreSQL | Disposable local Docker containers created and removed by the harness |
| 2026-08-15 18:20 | repo root | `npm run test:e2e` | 0 | 12/12 Playwright tests passed against a local fixture server | Local HTTPS fixture server; ignored Playwright result metadata |
| 2026-08-15 18:21 | internet, read-only | Opened official Neon database-versioning, create-snapshot API, and serverless-driver documentation | 0 | Current provider behavior compared with the runbook and migration client | None |
| 2026-08-15 18:28:00 | `C:\` by mistake | A combined inventory command ran `rg --files` from `C:\` instead of the repo | 124 | Timed out after 20 seconds with access-denied/path errors; no file contents were returned or used | Read-only broad filename scan; no writes |
| 2026-08-15 18:29 | repo root | Independent skeptic review of raw source and focused local reproductions | 0 | All proposed BLOCKER/HIGH findings upheld; three lower findings narrowed | Reviewer separately created an unwanted draft report; it was not opened or used |
| 2026-08-15 18:34 | repo root | `python C:\Users\Owner\.codex\skills\unshittify\scripts\validate_report.py docs\audits\Codex-GPT-5_data_Audit_Findings.md --json` | 0 | Valid; 9 findings; 0 errors; 0 warnings | None |

## Findings

### UNS-001: x402 settlement can succeed before any durable city record exists

- **Severity:** BLOCKER
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** An irreversible external payment must have a durable idempotency/reconciliation record before the application can lose control of execution.
- **Location:** `src/world-support.ts:126-175`; `src/world.ts:281-340`, `481-524`, `574-615`; `src/society.ts:795-912`; contrast in `src/world-market.ts:978-1069`, `1213-1289`; `test/routes.test.ts:1927-1966`.
- **User or business harm:** A resident can pay real USDC and receive neither the land, kind, revision, nor purchased property. The city can also lack the `payment_uses`, fee/sale receipt, transfer, and event needed to prove or reconcile what happened.
- **Evidence:** `treasuryFee` calls `settleX402` at `src/world-support.ts:135-145` and only then returns to callers that start their database CTEs. Direct sale settlement occurs at `src/society.ts:801`, while the reservation-sensitive claim begins at line 829 and can legitimately return no row at line 894. The focused test proves `/settle` occurs before the first place insert. Another test proves a settle call can occur while no `sale_payments` row is inserted. The world-market flow has durable pending fields and a reconcile endpoint after settlement, but it still has a smaller settle-to-pending-write crash window.
- **Safe reproduction:** `node --test --experimental-strip-types --test-name-pattern='frontier x402 settles before creation|x402 payer must match' test/routes.test.ts` passes two mock-facilitator tests without sending money. The assertion at `test/routes.test.ts:1963-1966` orders verify, settle, then insert.
- **Connection traced:** Authenticated paid route -> request validation -> x402 facilitator verify/settle -> transaction hash returned -> database CTE attempts one-use receipt and city mutation -> success, conflict, timeout, or process loss. The unprotected boundary is between facilitator settlement and the first durable database write.
- **Root cause:** External settlement and internal state are treated as a linear request instead of a recoverable state machine. PostgreSQL atomicity starts too late to cover the chain-side effect.
- **Connections and similar locations checked:** Frontier founding, kind invention, kind revision, direct transfer claim, payment one-use constraints, fees, sale receipts, transfers, and world-market pending reconciliation. Direct on-chain proof paths have different timing but still need one-use receipt checks; the x402 paths are the confirmed gap.
- **Durable fix:** Create a durable payment intent with a unique request/idempotency key before settlement; bind the returned transaction proof to that intent; make settlement retries/querying idempotent; complete the city mutation from a recoverable pending state; and reconcile ambiguous results by checking finalized chain evidence. Return `202 pending` when completion is uncertain. Extend the pattern to every paid route, including the remaining world-market settle-to-pending window.
- **Why this is not a band-aid:** It makes crash, timeout, retry, and reservation-race outcomes recoverable instead of merely changing error text or retry timing.
- **Pre-fix proof:** Add fault-injection tests that stop after successful settlement, force zero-row/throwing database writes, expire a reservation during settlement, and replay the same payment. Today those tests cannot find a preexisting durable intent for the treasury/direct-sale paths.
- **Verification:** Run unit state-machine tests, disposable-PostgreSQL integration tests, and a fake-facilitator process-kill matrix. Prove exactly one final outcome: completed action, durable pending reconciliation, or explicit invalid evidence—never an untracked settlement. Use test tokens only.
- **Regression and rollback risk:** HIGH. A partial rollout can double-settle or strand old proofs. Migrate state additively, keep unique transaction constraints, deploy readers/reconcilers before writers, and preserve a rollback path that leaves pending records readable.
- **Unknowns:** No live loss was sought or observed. Facilitator idempotency, query, and refund behavior was not verified; those facts affect implementation but do not remove the current unrecorded window.

### UNS-002: Ordinary previews can select the general database URL

- **Severity:** BLOCKER
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Every public preview must fail closed unless it has a proven isolated database target.
- **Location:** `src/db.ts:9-24`; `src/engine.ts:46-55`; `test/runtime-db-url.test.ts:8-57`; `vercel.json:1-4`; `docs/features/HOSTED_CHAT_SIGNIN.md:154-158`.
- **User or business harm:** A preview branch can run public write routes against production, allowing test registrations, property changes, moderation, agreements, or payment receipts to alter the live city.
- **Evidence:** For `VERCEL_ENV='preview'`, `runtimeDatabaseUrl` returns the preview override if present, but only throws when hosted-chat sign-in is enabled. Otherwise it falls through to `DATABASE_URL`. The test explicitly names this “legacy behavior” and expects the value called `live`. Vercel rewrites every route to the same write-capable application; there is no preview-wide read-only gate. The engine pool uses the same resolver.
- **Safe reproduction:** `node --test --experimental-strip-types test/runtime-db-url.test.ts` passes 4/4. Lines 45-49 deterministically return the general URL for an ordinary preview with no override.
- **Connection traced:** Public Vercel preview URL -> `api/index.ts` -> Hono write route -> global Neon client or engine pool -> `runtimeDatabaseUrl` -> general `DATABASE_URL` -> whichever database the provider scoped there.
- **Root cause:** Database isolation is conditional on one feature flag instead of on the deployment environment itself.
- **Connections and similar locations checked:** Runtime tagged SQL, engine interactive transactions, Vercel rewrite configuration, hosted-chat deployment guidance, migration preview target verification, and all uses of `VERCEL_ENV`. Migration tooling is stricter; runtime access is the weak link.
- **Durable fix:** For every preview, require `HOSTED_CHAT_PREVIEW_DATABASE_URL` (or one canonical preview variable) and fail closed when absent. Independently scope the production URL to Production only, verify the Neon branch/endpoint at startup without exposing credentials, and consider a database role that cannot mutate production from preview deployments.
- **Why this is not a band-aid:** It removes the fallback path; provider variable scoping remains a second control rather than the only control.
- **Pre-fix proof:** Change the existing “legacy behavior” test to require an unavailable-database error. Add tests showing every preview feature-flag combination refuses the general URL.
- **Verification:** Create a disposable preview with both URLs deliberately present, run a harmless write, and prove only the isolated branch changes. Then remove the preview URL and prove all database work fails closed. Do not use production rows as test markers.
- **Regression and rollback risk:** MEDIUM. Existing previews that relied on the fallback will lose database access until configured. Roll out the isolated variable first, then enforce the resolver.
- **Unknowns:** Actual Vercel environment scoping was not inspected. If `DATABASE_URL` is already Production-only, present exploitability is lower, but the code-level stop-ship fallback remains.

### UNS-003: The complete public map can be driven into stack exhaustion and quadratic work

- **Severity:** HIGH
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** An unauthenticated read must have bounded database, CPU, memory, response-size, and recursion cost; persistent user data must not be able to crash its serializer.
- **Location:** `src/world.ts:65-95`, `185-278`; `src/world-support.ts:182-189`; `db/schema.sql:200-220`, `1406-1480`; small-shape tests in `test/world-root.test.ts:101` and `test/routes.test.ts:1366`.
- **User or business harm:** One resident can create a deep or broad place tree that makes `/api/map` throw, consume excessive CPU, and repeatedly force a full-tree database read for every anonymous visitor. Because the shape is stored, the failure persists across process restarts.
- **Evidence:** `/api/map` recursively selects all places and runs three per-row counts, then `buildPlaceTree` recursively calls `rows.filter(...)` for every node. That is quadratic scanning plus JavaScript call-stack depth. Nested place creation has no depth or total-place quota. The topology trigger rejects cycles and invalid world/continent shapes but has no depth ceiling.
- **Safe reproduction:** An in-memory 20,000-node parent chain passed to `buildPlaceTree` exits with `RangeError: Maximum call stack size exceeded`. No database or route was touched.
- **Connection traced:** Authenticated resident repeatedly creates nested places -> rows persist in `places` -> anonymous visitor calls `/api/map` -> recursive SQL returns complete tree -> moderation -> recursive quadratic builder -> stack/CPU/response failure.
- **Root cause:** A completeness requirement was implemented with unbounded recursive materialization and no write-side complexity budget.
- **Connections and similar locations checked:** Per-place paginated reads are bounded; the public map and window deliberately remain complete. Physics recipes have explicit depth/effect ceilings, showing a reusable safety pattern that the place tree lacks.
- **Durable fix:** Build the tree iteratively in O(n) using an ID-to-node map; set an explicit maximum depth and total-place budget at both application and database boundaries; bound response size; and cache or version the public map. If completeness is mandatory, publish a stable paged/streamed representation instead of one recursive JSON response.
- **Why this is not a band-aid:** It prevents unsafe shapes from entering and removes recursion/quadratic work for existing valid data.
- **Pre-fix proof:** Add wide, deep, orphan, and near-limit fixtures. Assert bounded runtime, no `RangeError`, deterministic ordering, and a clear rejection at the first disallowed write.
- **Verification:** Benchmark the helper and endpoint at the maximum allowed shape; inspect the SQL plan; run concurrency tests for anonymous map traffic; and verify ordinary current maps remain byte/semantics compatible where promised.
- **Regression and rollback risk:** MEDIUM. Caps can reject previously permitted construction and pagination can change the public contract. Inventory current depth/count before enforcement and grandfather only shapes that remain safe.
- **Unknowns:** Live tree size and endpoint latency were not measured. The local reproduction proves the algorithmic failure, not the present production threshold.

### UNS-004: Backup and key-recovery tools infer their target without proving database identity

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Any operator command that reads all data or changes identity credentials must require an explicit target and prove it before connecting or mutating.
- **Location:** `scripts/backup.mjs:85-95`, `159-201`; `scripts/restore-key.mjs:190-255`; `test/operator-scripts.test.ts:26-85`; stronger contrast in `scripts/migrate.ts:300-387`, `536-550`.
- **User or business harm:** An operator can export the wrong environment’s complete database or rotate a resident’s production secret while intending to work elsewhere. The export includes credential hashes and private operational records.
- **Evidence:** Both scripts prefer `process.env.DATABASE_URL`, then silently search `.env.local`, `.env.deploy`, and `env.txt`. They connect immediately. `restore-key --confirm` writes `residents.secret_hash` but accepts no environment/branch target. Tests validate argument shapes and safe key files, not database identity. Migration tooling already has exact acknowledgements, endpoint checks, and branch checks that these tools lack.
- **Safe reproduction:** Static trace only. The mutating command was deliberately not run, and ignored environment files were not opened.
- **Connection traced:** Operator command -> convenience URL resolver -> first matching secret source -> Neon client -> full-table export or resident credential update.
- **Root cause:** Development convenience resolution is reused for sensitive operator work instead of the project’s guarded migration target model.
- **Connections and similar locations checked:** Backup, key recovery, migration runner, package commands, operator tests, logging redaction, atomic file creation, and failure cleanup. File hygiene is good; target identity is missing.
- **Durable fix:** Require `--target local|preview|production`, environment-specific URL variables, and an exact destructive acknowledgement for credential rotation. Resolve and verify a non-secret endpoint/project/branch/database identity before work; print only a safe fingerprint. Reuse the migration verifier where possible.
- **Why this is not a band-aid:** It removes ambiguous selection rather than relying on shell state, filenames, or operator memory.
- **Pre-fix proof:** Unit tests should show ambiguous sources, wrong hosts, wrong branches, and a missing acknowledgement fail before `connect`. The current scripts cannot pass those tests.
- **Verification:** Use fake clients for unit tests and two disposable local databases for an end-to-end wrong-target drill. Prove the rejected database remains unchanged and logs contain no URL or credential.
- **Regression and rollback risk:** LOW to MEDIUM. Existing one-line commands will become more explicit. Document the replacement before enforcing it.
- **Unknowns:** An external wrapper may already inject and verify the correct URL. No such wrapper was found in the repo, and external operator practice was not inspected.

### UNS-005: The JSON export is not one point-in-time PostgreSQL snapshot

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** A full-database recovery or forensic export must represent one transactionally consistent point in time.
- **Location:** `scripts/backup.mjs:159-201`; cross-table sale transaction in `src/society.ts:829-887`; world-market claim transaction in `src/world-market.ts:1098-1165`; runbook wording at `docs/runbooks/BACKUP_RESTORE.md:26-49`.
- **User or business harm:** An export taken during normal city activity can combine old ownership with new payment/transfer/event rows, or the reverse. It can be internally contradictory even though every individual query succeeded.
- **Evidence:** The script first reads the table list and then issues an independent `SELECT *` for each table. It does not acquire one connection-level `REPEATABLE READ` read-only transaction, exported snapshot, or `pg_dump` snapshot. City operations intentionally change several related tables atomically; a commit between two export queries splits that atomic fact across two statement snapshots.
- **Safe reproduction:** Deterministic source proof. No real export was run. A safe future reproduction is a disposable database where a controlled multi-table commit occurs between two exporter reads.
- **Connection traced:** Operator starts export -> table A read under snapshot A -> city transaction commits payment/ownership/event -> table B read under snapshot B -> JSON combines both -> counts and atomic rename make the file look complete.
- **Root cause:** “Every table was read” is treated as equivalent to “the database was snapshotted,” but PostgreSQL consistency is scoped to a transaction snapshot.
- **Connections and similar locations checked:** All-table discovery, identifier quoting, atomic JSON file write, retention pruning, direct-sale/world-sale CTEs, payment receipts, ownership, and event history. The file write is atomic; the data capture is not.
- **Durable fix:** Prefer a supported `pg_dump` custom archive or provider snapshot. If JSON is retained, use one dedicated direct/pooled connection in a read-only `REPEATABLE READ` transaction and document the consistency/RPO contract. The official Neon serverless-driver docs describe `Pool` support for interactive transactions: [Neon serverless driver](https://neon.com/docs/serverless/serverless-driver).
- **Why this is not a band-aid:** It establishes a database snapshot boundary; adding timestamps or recounting rows would not.
- **Pre-fix proof:** Add an integration test that pauses after table A, commits a sale, resumes table B, and demonstrates a broken cross-table invariant with the current exporter.
- **Verification:** Restore the resulting artifact into disposable PostgreSQL and assert constraints plus application invariants across offers, payment uses, sale payments, transfers, ownership, events, OAuth relations, and sequences.
- **Regression and rollback risk:** MEDIUM. Long snapshots can retain MVCC versions and increase load; use direct connections, timeouts, metrics, and a provider-native dump/snapshot for large data.
- **Unknowns:** The runbook calls JSON an inspection layer, which reduces recovery reliance but not forensic inconsistency. Actual export cadence and operator use are unknown.

### UNS-006: The repo-produced JSON artifact has no repo-tested restore path

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Every artifact called a backup must either have a rehearsed restore path or be explicitly excluded from recovery objectives.
- **Location:** `scripts/backup.mjs`; `docs/runbooks/BACKUP_RESTORE.md:26-111`; `test/operator-scripts.test.ts`; repository search for `pg_dump` and `pg_restore`.
- **User or business harm:** During a provider outage or recovery emergency, operators can discover that the local “full JSON snapshot” cannot recreate schema, sequences, constraints, triggers, or rows. Recovery time becomes improvisation.
- **Evidence:** The runbook explicitly says automated JSON restore is not implemented. No JSON importer or current `pg_dump`/`pg_restore` command is source-controlled. Operator tests do not execute `runBackup` or perform a round trip; coverage reports only 38.15% line coverage for `backup.mjs`. The runbook also records provider snapshot and older dump drills, so this is not evidence that all recovery is absent.
- **Safe reproduction:** Read-only source/command search. No backup content or provider snapshot was opened.
- **Connection traced:** Local export produced -> disaster selects recovery artifact -> no matching restore command/test -> operator must fall back to provider history or undocumented external tooling.
- **Root cause:** The local artifact’s purpose sits between inspection and recovery, while recovery proof lives mainly as dated prose and provider state outside the repository.
- **Connections and similar locations checked:** Backup producer, key-recovery script, operator tests, migration snapshots, runbook restore drill, and official Neon snapshot documentation. Neon describes database versioning/snapshots as a provider workflow: [Neon database versioning](https://neon.com/docs/ai/ai-database-versioning).
- **Durable fix:** Choose one explicit contract. Either rename/demote JSON to a diagnostic export and make provider snapshots plus versioned `pg_dump` archives the recovery system, or implement a validated importer. Automate a scheduled disposable restore drill with recorded non-secret invariant results, RPO, RTO, and ownership.
- **Why this is not a band-aid:** It proves recoverability rather than proving only that a file can be written and parsed.
- **Pre-fix proof:** A release-gate test should request the documented restore command for the newest artifact and fail because no repo command can perform it.
- **Verification:** Restore the chosen artifact into an isolated target, run schema and business-invariant checks, verify sequence advancement, run read/write smoke tests, record elapsed time, and delete only the drill target.
- **Regression and rollback risk:** MEDIUM. Restore automation is destructive by nature; enforce isolated target proof and never permit `main`/production finalization in drills.
- **Unknowns:** Live snapshot schedule, point-in-time window, dump cadence, storage separation, and the runbook’s dated successful drill were not independently verified.

### UNS-007: Applied migrations are not durably recorded and some live DDL has no wait bound

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Production must durably record ordered migration IDs/checksums, gate incompatible application code, and bound lock/statement waits for live DDL.
- **Location:** `scripts/migrate.ts:511-533`; `package.json:18-30`; `scripts/deploy.sh:77-95`; `db/migrations/20260814_public_pagination.sql:1-25`; timeout contrast in `db/migrations/20260814_world_root_expand.sql:5-6` and `20260814_world_root_topology.sql:6-7`.
- **User or business harm:** A skipped or out-of-order named migration can ship application reads/writes for a missing column and cause 500s. Plain index builds can wait on locks or block writers during a live release without a bounded failure.
- **Evidence:** Repository search finds no schema-migration ledger. Remote package commands select individual migrations manually. The runner wraps statements in a transaction but records no ID/checksum after commit. Deployment tests code but does not query schema compatibility. The pagination migration builds ten indexes with plain `CREATE INDEX IF NOT EXISTS` and no local lock/statement timeout; some topology migrations demonstrate that timeouts are possible but inconsistently applied.
- **Safe reproduction:** Static source proof plus passing migration/PostgreSQL tests. No production DDL was run.
- **Connection traced:** Operator selects named package command -> runner verifies target/snapshot -> executes file transaction -> no durable applied record -> Vercel later serves code that assumes the schema. For plain index DDL, transaction -> lock wait/build -> live writers contend.
- **Root cause:** Migrations are treated as guarded one-off commands, not an ordered, checksummed schema state machine with compatibility gates and per-migration execution policy.
- **Connections and similar locations checked:** All six migrations, fresh schema parity tests, target verification, snapshot creation/polling, package scripts, deploy preparation, and runtime uses of `open_to_use`. Existing target proof is strong and should be preserved.
- **Durable fix:** Add a database-side migration ledger with ID, checksum, dependency/order, start/end, and result. Make deploy/startup compare required vs applied versions. Add lock and statement timeouts to live DDL. Teach the runner to support an explicitly reviewed nontransactional mode for `CREATE INDEX CONCURRENTLY`, which PostgreSQL cannot run inside the current transaction wrapper.
- **Why this is not a band-aid:** It makes schema state observable and enforceable while addressing the actual lock behavior, rather than adding another manual checklist.
- **Pre-fix proof:** Test an intentionally skipped predecessor, a checksum change, and a held table lock. Today the runner cannot report the first two from database state and the pagination migration has no bounded lock failure.
- **Verification:** Apply every migration from a legacy fixture and a fresh schema, reapply idempotently, test rollback/forward-fix behavior, inspect locks, and prove incompatible code refuses readiness before serving traffic.
- **Regression and rollback risk:** MEDIUM. Introducing a ledger around already-applied migrations requires a reviewed baseline. Concurrent indexes need special failure cleanup and retry handling.
- **Unknowns:** Current live schema and table sizes were not inspected. Small tables reduce lock duration but do not supply durable migration history.

### UNS-008: Expired OAuth records are retained indefinitely and copied into later exports

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Authentication metadata and credential hashes need an explicit retention period and reliable purge mechanism after expiry/revocation.
- **Location:** `db/schema.sql:50-177`; `src/oauth-store.ts:75-103`, `480-563`; `scripts/backup.mjs:170-199`.
- **User or business harm:** Authorization requests, codes, token families, and token hashes grow without bound and remain available to anyone who later obtains a database/export copy. Stored client IDs, redirects, state, resident linkage, and credential hashes outlive their operational need.
- **Evidence:** The schema provides expiry, used, and revoked timestamps. Application code clears staged new-resident secret fields on expired pending requests, but leaves the row. Repository search finds no delete for the four OAuth tables; the only OAuth cleanup delete targets rate-limit buckets. The all-public-table exporter copies every retained row.
- **Safe reproduction:** Read-only source search for cleanup SQL and foreign-key relationships. Live row counts were not queried.
- **Connection traced:** OAuth request/token issuance -> row marked used/expired/revoked -> no scheduled purge -> row remains -> future all-table JSON export duplicates it into another retention domain.
- **Root cause:** Expiry is enforced for authorization but treated as equivalent to data deletion. There is no retention owner or FK-ordered cleanup job.
- **Connections and similar locations checked:** Requests, codes, token families, tokens, rate limits, new-resident staging cleanup, revocation, schema foreign keys, and backup scope. Rate-limit cleanup proves a request-triggered cleanup pattern exists, but it does not cover auth records.
- **Durable fix:** Define retention by record class, then run an observable scheduled purge in safe child-to-parent order with a grace period. Keep only necessary aggregate/audit data, and expire derived exports under the same policy.
- **Why this is not a band-aid:** It controls both table growth and data lifetime rather than merely adding another expiry predicate to reads.
- **Pre-fix proof:** Seed expired/used/revoked rows across the FK graph and assert the purge removes only records beyond policy while preserving active families and required audit evidence.
- **Verification:** Run integration tests, monitor rows/bytes and purge lag, test interrupted batches, verify no active session breaks, and confirm restored/exported data follows the declared retention boundary.
- **Regression and rollback risk:** MEDIUM. Deletion order and policy mistakes can invalidate active tokens or erase required incident evidence. Start with reporting/dry-run counts and conservative grace periods.
- **Unknowns:** Live table sizes, legal/business retention requirements, and expected OAuth traffic are unknown.

### UNS-009: Fixed-prefix IP hashes are described as salted but remain enumerable after disclosure

- **Severity:** LOW
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Pseudonymous network identifiers should use a secret-keyed transform and short reliable retention when protection against offline guessing is claimed.
- **Location:** claims at `db/schema.sql:37-38`, `179-180`; implementation at `src/core.ts:47-49`, `src/index.ts:80-95`, `188-191`; `src/oauth.ts:266-277`; request-triggered cleanup at `src/index.ts:99-107`, `191` and `src/oauth-store.ts:549-551`.
- **User or business harm:** After a database or JSON-export disclosure, an attacker can enumerate IPv4 candidates under the known prefixes and recover/correlate likely addresses. Cleanup pauses when the triggering traffic stops, and old exports retain prior values.
- **Evidence:** The implementation is ordinary SHA-256 over public fixed strings such as `reg:`, `flag:`, and `oauth:<kind>:`. Those prefixes provide domain separation, not a secret salt/pepper. The application does avoid raw IP storage, which limits severity.
- **Safe reproduction:** Compute SHA-256 for a known test IP and compare it to the same fixed-prefix computation; no database is needed. Exhaustive guessing was not performed.
- **Connection traced:** Trusted forwarding header -> normalized address -> fixed-prefix SHA-256 -> rate-limit table -> all-table export -> possible offline dictionary after disclosure.
- **Root cause:** A deterministic public namespace prefix is documented as a salt, and retention relies on request-triggered cleanup rather than a scheduled lifecycle.
- **Connections and similar locations checked:** Registration, anonymous flags, OAuth rate buckets, client buckets, cleanup queries, schema comments, and backup scope. Resident/token secret hashes have high-entropy inputs and are not subject to the same small-domain guessing issue.
- **Durable fix:** Use a versioned HMAC with a secret pepper stored outside PostgreSQL, rotate with overlap, and run scheduled short-retention cleanup. Update the comments and threat model to state the exact guarantee.
- **Why this is not a band-aid:** It makes database-only disclosure insufficient for offline enumeration and gives the data a reliable end of life.
- **Pre-fix proof:** A test with the public algorithm should recover a small candidate set today; the same test without the HMAC key must fail after the fix.
- **Verification:** Prove stable bucketing during a key version, safe overlap/rotation, bounded retention, no raw addresses in logs/exports, and unchanged rate-limit behavior.
- **Regression and rollback risk:** LOW to MEDIUM. Immediate key rotation resets buckets and can weaken/over-tighten limits; use versioned overlap and short TTLs.
- **Unknowns:** Proxy normalization and live address mix were not inspected. IPv6 has a larger search space, and some non-Vercel traffic collapses to `unknown`, reducing exposure there.

## Questions Needing Human Review

1. Is `DATABASE_URL` scoped to Production only in Vercel today, and does every active preview have a separate Neon branch plus least-privilege role?
2. What idempotency, lookup, replay, and refund guarantees does the x402 facilitator provide, and are there any past payments without matching `payment_uses`/fee/sale records?
3. What are the approved RPO/RTO, current Neon snapshot/PITR schedule, most recent independently witnessed restore time, and off-provider recovery path? Neon’s create-snapshot API can be asynchronous ([official API](https://api-docs.neon.tech/reference/createsnapshot)); also confirm whether `scripts/migrate.ts:351` may safely accept a response with no `operations` to poll.
4. Do external operator wrappers prove the target for backup/key rotation or create tested `pg_dump` archives outside this repository?
5. What retention period is approved for OAuth metadata, token hashes, rate-limit identifiers, local exports, and recovery-key files?

## Ordered Repair Plan

1. **P0 — Make paid flows recoverable.** Add durable pre-settlement intent, idempotency, finalized evidence, and reconciliation across every x402 path. Exit proof: process-kill/failure tests show no untracked successful settlement.
2. **P0 — Enforce preview isolation.** Configure isolated preview URLs/roles, then remove the general-URL fallback. Exit proof: every feature-flag combination fails closed and a disposable preview can mutate only its branch.
3. **P1 — Bound the public map.** Add write-side depth/size limits and an iterative O(n) builder with bounded delivery. Exit proof: wide/deep adversarial fixtures remain within measured CPU, memory, query, and response budgets.
4. **P1 — Establish operational recovery.** Add explicit targets, consistent dump/snapshot capture, and a scheduled isolated restore rehearsal with RPO/RTO evidence. Exit proof: the newest official artifact restores from a documented command and passes invariants.
5. **P2 — Make schema/data lifecycle observable.** Add migration ledger/compatibility gates, bounded DDL, OAuth purge policy, and keyed short-lived rate identifiers. Exit proof: drift/lock/retention drills fail safely and emit actionable metrics.

## Verification and Release Gates

1. **Money gate:** No paid route may release until successful-settle/DB-fail, timeout, retry, duplicate, reservation-expiry, and process-loss cases end in one durable recoverable state.
2. **Isolation gate:** A preview with the general URL present but no preview URL must refuse database work; production must ignore preview credentials; provider branch identity must be independently checked.
3. **Load gate:** `/api/map` must pass maximum-depth, maximum-width, malformed-tree, concurrent-read, and response-size tests without recursion or superlinear construction.
4. **Recovery gate:** A fresh official artifact must restore into a disposable target within the agreed RTO and satisfy schema, constraints, sequences, payment/ownership, OAuth, and write-smoke invariants.
5. **Release gate:** Migration status/checksums must match the application requirement; lock waits must be bounded; unit, type-check, coverage, PostgreSQL, and browser suites must pass; no BLOCKER/HIGH overseer dispute may remain unresolved.

## Overseer Record

**Independent skeptic:** COMPLETED  
**Reviewer separation:** CONFIRMED

The skeptic was a fresh reviewer agent that did not originate the candidate findings. It was instructed to use raw source/tests only, avoid all audit/report directories and live state, try to disprove every serious claim, rerun safe reproductions, and report limiting conditions separately from severity.

| Candidate | Overseer result | Severity / evidence | Strongest limit applied |
|---|---|---|---|
| Preview fallback | UPHELD | BLOCKER / E3 | Current Vercel variable scoping unknown |
| Settle before durable state | UPHELD | BLOCKER / E3 | Ordering reproduced; no live loss event sought |
| Recursive complete map | UPHELD | HIGH / E3 | Helper crash reproduced; live endpoint load not measured |
| Ambiguous operator target | UPHELD | HIGH / E2 | External wrappers unknown |
| Cross-table export inconsistency | UPHELD | HIGH / E2 | Interleaved commit not executed |
| Repo-local restore gap | CHANGED | MEDIUM / E2 | Provider recovery may exist and is documented |
| Migration observability/DDL waits | CHANGED | MEDIUM / E2 | Strong guards exist for some migrations |
| OAuth retention | UPHELD | MEDIUM / E2 | Live growth rate unknown |
| Fixed-prefix IP hashing | CHANGED | LOW / E2 | Raw IPs are avoided; harm needs later disclosure |

No proposed BLOCKER or HIGH finding was rejected or downgraded. The reviewer’s unwanted draft output was not opened, quoted, or used; only its direct raw-source challenge matrix is recorded here.

## Honest Limitations

1. No live database, Vercel/Neon configuration, provider backup, generated backup content, credential, row count, or real USDC transaction was inspected. Current exposure and any historical harm therefore remain unknown.
2. Documentation was treated as a claim. Official Neon documentation was checked, but the runbook’s project IDs, schedule, 6-hour history, dated counts, and successful restore evidence were not verified against provider state.
3. An early broad search accidentally surfaced snippets from `.codex/reports`; that path was immediately excluded and none of that material was reopened or used. A later inventory command mistakenly ran from `C:\`, returned filenames/access errors only, timed out, and contributed no evidence.
4. Despite explicit no-write/no-report instructions, three inspector/reviewer agents created data-audit drafts at `GPT-5_data_Audit_Findings.md`, `openai-codex_data_Audit_Findings.md`, and `Codex_data_Audit_Findings.md`. They were not opened or overwritten. This `Codex-GPT-5_data_Audit_Findings.md` file is the only authoritative report from the root audit.
5. An untracked 177-byte root file named `audit-backup.json` appeared at 18:23:19 CDT. Every audit agent denied creating it. Its content was not opened, modified, or deleted, so its provenance and sensitivity remain unresolved. Test runs also produced only ignored local fixture/result metadata; application code was not changed.
