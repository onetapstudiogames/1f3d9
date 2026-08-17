# Unshittify Audit

- **Audit ID:** CODEx-DATA-20260815
- **Project:** 1f3d9.com data layer
- **Created:** 2026-08-15T18:21:02.7811616-05:00

## Plain-English Verdict

DO NOT RELEASE

Why:
- Preview deployments can still use the general `DATABASE_URL`, so one preview configuration mistake can point public preview writes at the live database.
- Real USDC settlement happens before the app records durable payment intent or result in several write paths, so a crash or race can take money without completing the city action.
- The current backup and recovery surface is not operator-safe end to end: the local JSON export is not a tested restore path, and the emergency key-restore script can mutate whichever database URL it finds first.

### Findings at a Glance

| ID | Severity | Evidence | Status | Finding |
| --- | --- | --- | --- | --- |
| UNS-001 | BLOCKER | E3 | Confirmed | Preview runtime falls back to the general database URL instead of always failing closed to an isolated preview branch |
| UNS-002 | BLOCKER | E3 | Confirmed | Paid x402 flows settle real money before any durable database claim or reconciliation record exists |
| UNS-003 | HIGH | E3 | Confirmed | The public map endpoint can be driven into stack exhaustion and quadratic work by persistent deep place trees |
| UNS-004 | HIGH | E2 | Likely | Backup and key-restore scripts can select and mutate the wrong database without proving target identity |
| UNS-005 | HIGH | E2 | Likely | The repo does not contain a full, tested restore path from the backup format it produces |
| UNS-006 | MEDIUM | E2 | Likely | Migration safety depends on manual sequencing; some live DDL is not online-safe and there is no schema ledger/gate |
| UNS-007 | MEDIUM | E2 | Likely | OAuth rows are retained indefinitely, so auth metadata and token hashes accumulate and spread into full backups |

### Next 3 Actions

1. Change preview runtime selection so every `VERCEL_ENV=preview` request fails closed unless an explicit isolated preview URL is present.
2. Rework every x402 write path to persist pending payment evidence before settlement or to use the existing world-market reconciliation pattern.
3. Add a target-proving restore/backup workflow and a repeatable restore drill that proves the same artifact you create can be restored.

## Audit Contract

- Requested category: data layer only.
- Included surface: runtime database access, transactional write paths that touch payment durability, schema, migrations, backup and restore tooling, and retention in auth tables.
- Excluded on purpose: live production inspection, environment files, credentials, backup payload contents, and any report under `docs/audits` or `.codex/reports`.
- No code was changed.
- Docs under `docs/` were treated as claims and checked against source.

## Project and Connection Map

| Layer | Current implementation | Main files |
| --- | --- | --- |
| Runtime read/write SQL | Neon serverless HTTP client behind global `sql` | `src/db.ts`, `src/index.ts`, `src/world.ts`, `src/society.ts` |
| Interactive / transactional SQL | Pooled Postgres client for explicit transactions and integration tests | `src/write-sql.ts`, `test/integration/*postgres.test.ts` |
| Canonical schema | Full idempotent schema plus triggers, checks, indexes | `db/schema.sql` |
| Incremental remote migrations | Six named SQL files applied by guarded script | `db/migrations/*.sql`, `scripts/migrate.ts`, `package.json` |
| Backup / restore tooling | Local JSON export, resident-key restore helper, runbook for provider drill | `scripts/backup.mjs`, `scripts/restore-key.mjs`, `docs/runbooks/BACKUP_RESTORE.md` |
| Payment durability touchpoints | Treasury fee flows, direct sale claim flow, and world-market reconciliation contrast | `src/world-support.ts`, `src/world.ts`, `src/society.ts`, `src/world-market.ts` |

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Runtime DB URL selection | Covered | Source review plus `test/runtime-db-url.test.ts` replay | No access to actual Vercel environment scoping |
| Paid world / sale writes | Covered | Source review plus focused `test/routes.test.ts` replay | Did not force a live facilitator or real chain failure |
| Schema and migrations | Covered | Full schema review, migration review, `npm run test:postgres` | No live row-count or live lock-duration measurement |
| Backup / restore scripts | Covered | Script review plus runbook comparison | Did not open any real backup artifact or env file |
| Public map scaling | Covered | Source review plus synthetic `buildPlaceTree` stress reproduction | Local process only, not a live traffic test |
| OAuth retention | Covered | Schema and store review, Postgres suite results | No live table cardinality inspection |
| Provider recovery claims | Partially covered | Runbook review only | No live Neon project access in this audit |

## Evidence Ledger

| Time (-05:00) | Folder | Exact command | Exit | Result | Side effects |
| --- | --- | --- | --- | --- | --- |
| 18:03 | `C:\Users\Owner\Documents\1f3d9` | `& 'C:\Program Files\Git\cmd\git.exe' --no-pager --no-optional-locks -c core.fsmonitor=false -C 'C:\Users\Owner\Documents\1f3d9' status --short` | 0 | Confirmed a dirty worktree with multiple other audit artifacts already present | None |
| 18:04 | `C:\Users\Owner\Documents\1f3d9` | `docker version --format '{{.Server.Version}}'` | 0 | Confirmed disposable local Postgres was available for safe test work | None |
| 18:05 | `C:\Users\Owner\Documents\1f3d9` | `node --test --experimental-strip-types test/runtime-db-url.test.ts` | 0 | Replayed 4 runtime DB URL tests; preview fallback to `DATABASE_URL` is intentional and passing | None |
| 18:06 | `C:\Users\Owner\Documents\1f3d9` | `node --test --experimental-strip-types --test-name-pattern="frontier x402 settles before creation|x402 payer must match" test/routes.test.ts` | 0 | Replayed 2 focused x402 route tests; settlement occurs before insert and mismatched payer leaves no `sale_payments` row | None |
| 18:07 | `C:\Users\Owner\Documents\1f3d9` | `npm test` | 0 | Full Node test suite passed `401/401` | None |
| 18:09 | `C:\Users\Owner\Documents\1f3d9` | `npm run typecheck` | 0 | Typecheck passed | None |
| 18:11 | `C:\Users\Owner\Documents\1f3d9` | `npm run test:postgres` | 0 | Postgres integration suite passed `33/33` | Disposable local Postgres container usage only |
| 18:13 | `C:\Users\Owner\Documents\1f3d9` | `@' ... buildPlaceTree 20000-row synthetic chain ... '@ | node --input-type=module --experimental-strip-types -` | 1 | Deterministic `RangeError: Maximum call stack size exceeded` from `src/world-support.ts:187-188` | None |
| 18:14 | `C:\Users\Owner\Documents\1f3d9` | `rg -n "resolveDatabaseUrl|HOSTED_CHAT_PREVIEW_DATABASE_URL|keeps legacy behavior|preview uses explicit override|preview without override" src/db.ts test/runtime-db-url.test.ts` | 0 | Captured exact preview-routing and test lines | None |
| 18:15 | `C:\Users\Owner\Documents\1f3d9` | `rg -n "treasuryFee|settleX402|/settle|frontier x402 settles before creation|x402 payer must match|pending_x402" src/world-support.ts src/world.ts src/society.ts src/world-market.ts test/routes.test.ts` | 0 | Captured exact settlement ordering and world-market reconciliation contrast | None |
| 18:16 | `C:\Users\Owner\Documents\1f3d9` | `rg -n "buildPlaceTree|/api/map|createPlace|parent_place_id|root_id" src/world-support.ts src/world.ts db/schema.sql` | 0 | Captured public map and recursive tree lines | None |
| 18:17 | `C:\Users\Owner\Documents\1f3d9` | `rg -n "DATABASE_URL|env.txt|\.env\.local|\.env\.deploy|restoreResidentKey|--confirm|connect" scripts/backup.mjs scripts/restore-key.mjs scripts/migrate.ts` | 0 | Captured operator-target selection paths across scripts | None |
| 18:18 | `C:\Users\Owner\Documents\1f3d9` | `rg -n "BEGIN TRANSACTION|REPEATABLE READ|SELECT \* FROM|information_schema|JSON restore is not implemented|provider snapshot|PITR|pg_dump|pg_restore|restore drill" scripts/backup.mjs docs/runbooks/BACKUP_RESTORE.md` | 0 | Confirmed JSON export reads tables one by one and runbook admits JSON restore is not implemented | None |
| 18:19 | `C:\Users\Owner\Documents\1f3d9` | `rg -n "CREATE INDEX|lock_timeout|statement_timeout|schema_migrations|migration|open_to_use|public_pagination|migrate|deploy" db/migrations scripts/migrate.ts scripts/deploy.sh package.json src/index.ts src/world.ts` | 0 | Captured migration inventory, guarded script controls, and unguarded public pagination index DDL | None |
| 18:20 | `C:\Users\Owner\Documents\1f3d9` | `rg -n "authorization_requests|authorization_codes|token_families|access_tokens|refresh_tokens|DELETE FROM|expired|revoked|used_at|rate limit|oauth" src/oauth-store.ts db/schema.sql` | 0 | Captured auth-retention behavior and the lone cleanup path for rate-limit rows | None |
| 18:21 | `C:\Users\Owner\Documents\1f3d9` | `Get-Date -Format o` | 0 | Captured report timestamp | None |

## Findings

### UNS-001: Preview runtime can still point public preview traffic at the general database

- **Severity:** BLOCKER
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Preview environments must fail closed to an isolated database branch.
- **Location:** `src/db.ts:9-19`, `test/runtime-db-url.test.ts:38-50`, `docs/features/HOSTED_CHAT_SIGNIN.md:154-158`
- **User or business harm:** A public preview deployment can write resident, land, payment, and agreement data into the live database if `DATABASE_URL` is scoped into Preview and `HOSTED_CHAT_PREVIEW_DATABASE_URL` is absent. That is a production integrity and financial-risk boundary failure.
- **Evidence:** `runtimeDatabaseUrl()` returns `HOSTED_CHAT_PREVIEW_DATABASE_URL` only when present. In `VERCEL_ENV === 'preview'`, hosted-chat-enabled previews fail closed, but ordinary previews fall through to `DATABASE_URL`. The repo test explicitly asserts that fallback and labels it legacy behavior.
- **Safe reproduction:** Run `node --test --experimental-strip-types test/runtime-db-url.test.ts`. The passing test `an ordinary preview uses the isolated override when present and otherwise keeps legacy behavior` proves the fallback path.
- **Connection traced:** `src/db.ts` is the global runtime SQL entry point used by public route modules such as `src/world.ts` and `src/index.ts`.
- **Root cause:** Preview isolation is conditional on hosted-chat signin, not on being a preview at all.
- **Connections and similar locations checked:** `scripts/migrate.ts` does the opposite: it forces explicit target choice and refuses to infer preview versus production.
- **Durable fix:** Make every preview request require an explicit preview database URL and fail closed otherwise. Separate runtime env names for local, preview, and production instead of reusing a shared `DATABASE_URL`.
- **Why this is not a band-aid:** It removes the dangerous implicit fallback instead of trying to document around it.
- **Pre-fix proof:** `test/runtime-db-url.test.ts:45-49` currently expects preview-without-override to return `live`.
- **Verification:** Add a failing test first that preview without explicit override throws, then update `src/db.ts` and rerun the 4 runtime URL tests plus smoke tests for preview-only startup.
- **Regression and rollback risk:** Low code-change risk, medium deployment risk because preview jobs that currently depend on the fallback will stop until configured correctly.
- **Unknowns:** This audit did not inspect the actual Vercel variable scopes, so current exploitability depends on live deployment configuration.

### UNS-002: Real-money x402 settlement happens before any durable database claim in direct paid flows

- **Severity:** BLOCKER
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Money acceptance must be atomic with durable application intent or durable reconciliation.
- **Location:** `src/world-support.ts:126-145`, `src/world.ts:281-303`, `src/world.ts:481-489`, `src/world.ts:574-589`, `src/society.ts:795-894`, `src/world-market.ts:983-1008`, `src/world-market.ts:1228-1288`, `test/routes.test.ts:1927-1966`
- **User or business harm:** A resident can pay real USDC and still lose the frontier founding, kind creation, kind revision, or direct sale claim if the app crashes, times out, or loses the reservation before the first SQL write succeeds. Those paths also lack a durable pending record for later reconciliation.
- **Evidence:** `treasuryFee()` settles immediately and returns the tx hash before callers run any SQL. Frontier, kind, and revision flows all call it before their first `INSERT`. Direct sale claim in `src/society.ts` settles first, then only later updates the offer and writes `payment_uses` and `sale_payments`. By contrast, world-market x402 writes `pending_x402_*` to `transfer_offers` immediately after settlement and includes an explicit reconciliation path.
- **Safe reproduction:** Run `node --test --experimental-strip-types --test-name-pattern="frontier x402 settles before creation|x402 payer must match" test/routes.test.ts`. The first test asserts `/verify` then `/settle` then `INSERT INTO places`; the second shows `/settle` can happen while `sale_payments` remains empty when the payer mismatch is detected afterward.
- **Connection traced:** Treasury fee helper feeds frontier land, kind invention, and kind revision. Direct sale claim uses the same settle-first pattern. World-market demonstrates the missing durability pattern already exists elsewhere in the codebase.
- **Root cause:** Payment settlement is treated as a prerequisite check instead of as data that must be durably recorded before or at the same time as state change.
- **Connections and similar locations checked:** `src/world-market.ts` was reviewed as the internal contrast and already implements durable pending evidence plus reconciliation.
- **Durable fix:** Persist a pending payment record before settlement where possible, or immediately after settlement in the same narrow path that only records evidence, then finalize through a dedicated reconciliation step. Reuse the world-market pattern instead of duplicating settle-first flows.
- **Why this is not a band-aid:** It changes the payment model from "hope the next write works" to "every settled payment has durable evidence and a recovery path."
- **Pre-fix proof:** `test/routes.test.ts:1963-1966` confirms settlement precedes the first insert.
- **Verification:** Add tests that simulate DB failure or reservation expiry after settlement and assert the payment is recoverable from a pending record instead of disappearing into a 409 or 500.
- **Regression and rollback risk:** Medium. Payment flow changes touch money, duplicate-payment prevention, and reservation timing.
- **Unknowns:** This audit did not invoke the real facilitator or force a live crash between settlement and write; the confirmed defect is the ordering and the lack of durable recovery state.

### UNS-003: The public map endpoint can be used for persistent data-driven denial of service

- **Severity:** HIGH
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Public endpoints must have bounded cost and must not recurse unboundedly over attacker-shaped persistent data.
- **Location:** `src/world.ts:66-94`, `src/world-support.ts:182-188`, `src/world.ts:186-278`, `db/schema.sql:1406-1480`
- **User or business harm:** One resident can create an arbitrarily deep place chain and turn unauthenticated `/api/map` reads into expensive full-tree work. At sufficient depth, the process throws `RangeError: Maximum call stack size exceeded`.
- **Evidence:** `/api/map` loads the full place tree, includes per-row correlated counts, then calls `buildPlaceTree()`, which recursively filters the entire row set at each level. The free nested place path has no depth or count cap. The topology trigger prevents cycles but not extreme depth.
- **Safe reproduction:** Run the inline Node command from the evidence ledger that imports `buildPlaceTree()` and passes a 20,000-row single-child chain. It exits `1` with `RangeError: Maximum call stack size exceeded` at `src/world-support.ts:187-188`.
- **Connection traced:** A resident writes the deep data through `POST /api/place`; every anonymous visitor can trigger the expensive read via `GET /api/map`.
- **Root cause:** Tree assembly is recursive and quadratic over an unbounded dataset, and the write path allows unbounded hierarchy depth.
- **Connections and similar locations checked:** Schema topology checks stop self-ancestor loops but do not impose depth or subtree quotas.
- **Durable fix:** Replace recursive filter-per-level tree building with an iterative parent-to-children map, bound `/api/map` output or paginate it, and enforce place-depth or subtree quotas at write time.
- **Why this is not a band-aid:** It bounds both the stored shape and the read algorithm.
- **Pre-fix proof:** The synthetic chain reproduction deterministically crashes the helper in-process.
- **Verification:** Add a stress test for a deep chain and a wide tree, then confirm `/api/map` remains bounded and stack-safe.
- **Regression and rollback risk:** Medium, because clients may rely on the current full-tree response shape.
- **Unknowns:** Live depth and place counts were not inspected.

### UNS-004: Backup and key-restore scripts can hit the wrong database without proving target identity

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Destructive or sensitive operator tooling must prove its target before connecting or mutating.
- **Location:** `scripts/backup.mjs:85-95`, `scripts/backup.mjs:168-205`, `scripts/restore-key.mjs:215-221`, `scripts/restore-key.mjs:244-255`, `scripts/migrate.ts:111-203`
- **User or business harm:** An operator can export private production data from the wrong database or rotate a resident secret in the wrong environment because the scripts quietly take the first `DATABASE_URL` they find.
- **Evidence:** `resolveDatabaseUrl()` in `scripts/backup.mjs` checks process env first, then `.env.local`, `.env.deploy`, then `env.txt`. `restore-key.mjs` reuses that selection and, with `--confirm`, updates `residents.secret_hash` after connecting. Neither script prints or verifies server identity before acting. `scripts/migrate.ts` is the internal contrast: it requires explicit `--target`, guarded acknowledgements, direct URLs, and production host proof.
- **Safe reproduction:** Static review only. Read the cited lines; the selection order and mutation path are explicit.
- **Connection traced:** `restore-key.mjs` directly depends on `backup.mjs` URL resolution and then mutates the `residents` table.
- **Root cause:** Operational convenience won over explicit environment targeting in scripts that should behave like migrations, not like local utilities.
- **Connections and similar locations checked:** `scripts/migrate.ts` demonstrates a safer model already used elsewhere in the repo.
- **Durable fix:** Require an explicit target flag, print and require acknowledgement of project/branch/host identity before any sensitive action, and refuse to read implicit env files for destructive operations.
- **Why this is not a band-aid:** It removes silent inference rather than adding more warnings around it.
- **Pre-fix proof:** `backup.mjs` and `restore-key.mjs` both call the same implicit URL resolver before connecting.
- **Verification:** Add tests that reject ambiguous environments and require target acknowledgements before backup or restore-key execution.
- **Regression and rollback risk:** Low code risk, low operational risk; operators will need to be more explicit.
- **Unknowns:** This audit did not inspect the ignored env files or execute the destructive `--confirm` path.

### UNS-005: The repo does not prove recovery from the backup format it creates

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Every produced backup artifact should have a tested, current restore path.
- **Location:** `scripts/backup.mjs:168-201`, `docs/runbooks/BACKUP_RESTORE.md:32-49`, `docs/runbooks/BACKUP_RESTORE.md:51-110`
- **User or business harm:** In an incident, the fastest artifact the repo can create is a full JSON export, but the repo does not contain an automated way to restore that artifact. Operators may discover too late that the available backup is useful for inspection only, not recovery.
- **Evidence:** The backup script exports every public base table to JSON. The runbook states: "The JSON snapshot is currently an export and inspection layer; automated JSON restore is not implemented. Provider snapshots and PostgreSQL dump archives are the proven restore paths." The repo itself does not include a current JSON restore, `pg_dump`, or `pg_restore` workflow tied to the produced artifact.
- **Safe reproduction:** Static review only. Read the cited runbook lines and backup script.
- **Connection traced:** The backup script is the only repo-local full export mechanism, but the recovery instructions point somewhere else.
- **Root cause:** Backup creation and restore validation were built as separate stories, and only the export half was implemented in source.
- **Connections and similar locations checked:** `docs/runbooks/BACKUP_RESTORE.md` contains a provider restore drill claim, but this audit did not use live Neon access to confirm current schedule or availability.
- **Durable fix:** Either implement and test JSON round-trip restore for a disposable database, or replace the JSON export with a repo-owned backup artifact that has a scripted restore drill and verification gate.
- **Why this is not a band-aid:** It aligns the generated artifact with the practiced recovery procedure.
- **Pre-fix proof:** The runbook explicitly says JSON restore is not implemented.
- **Verification:** A CI-safe restore drill should load a fresh disposable Postgres instance from the chosen backup artifact and verify table counts, constraints, and a few business-critical records.
- **Regression and rollback risk:** Medium operational risk because changing the backup format changes incident playbooks.
- **Unknowns:** There may be out-of-repo operational procedures; they were out of scope for this source-backed audit.

### UNS-006: Migration safety is partly manual and some live DDL is not online-safe

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Production schema change paths need observability, compatibility gates, and online-safe DDL where possible.
- **Location:** `scripts/migrate.ts:19-56`, `scripts/migrate.ts:122-203`, `scripts/deploy.sh:2-4`, `package.json:18-30`, `db/migrations/20260814_public_pagination.sql:1-25`, `src/index.ts:388`, `src/world.ts:710-820`
- **User or business harm:** If a named migration is skipped or applied out of order, runtime code can call columns that do not exist yet and return `500`s. Large index builds from the public pagination migration can also block writers because they are plain `CREATE INDEX` statements without `CONCURRENTLY`, `lock_timeout`, or `statement_timeout`.
- **Evidence:** Remote migrations are invoked as separate named commands with no schema ledger table or runtime compatibility gate. `deploy.sh` explicitly does not deploy or run migrations. The new `open_to_use` column is already read and written by runtime routes. The public pagination migration creates ten indexes with plain `CREATE INDEX IF NOT EXISTS`.
- **Safe reproduction:** Static review only. Read the cited migration and runtime references.
- **Connection traced:** App code depends on migration state, but deploy and runtime do not verify that state.
- **Root cause:** Migration safety is enforced by operator discipline and naming conventions rather than by a database-visible version ledger plus compatibility checks.
- **Connections and similar locations checked:** Some other migrations do set local timeouts (`world_root_expand`, `world_root_topology`), so the unsafe pattern is not universal.
- **Durable fix:** Add a schema version ledger, enforce minimum schema compatibility at startup or deploy time, and use online-safe index creation or guarded maintenance windows for heavy live DDL.
- **Why this is not a band-aid:** It upgrades migration safety from tribal process to machine-checked state.
- **Pre-fix proof:** `20260814_public_pagination.sql` contains only plain `CREATE INDEX IF NOT EXISTS` statements.
- **Verification:** Add migration-state tests, a deploy gate that checks required migration versions, and a staged rehearsal for live index creation.
- **Regression and rollback risk:** Medium, because startup or deploy may begin failing until the process is tightened.
- **Unknowns:** Live table sizes were not inspected, so actual lock duration is unknown.

### UNS-007: OAuth tables retain auth metadata and token hashes indefinitely

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Security-sensitive records should have bounded retention and cleanup paths.
- **Location:** `db/schema.sql:50-177`, `src/oauth-store.ts:75-101`, `src/oauth-store.ts:404-500`, `src/oauth-store.ts:549-563`, `docs/runbooks/BACKUP_RESTORE.md:38-42`
- **User or business harm:** Expired or revoked authorization requests, codes, families, and token hashes stay in the database and therefore land in every full backup. That increases backup sensitivity, storage growth, and the blast radius of any operator mistake.
- **Evidence:** The schema defines expiry and revocation fields for OAuth rows, but the only explicit cleanup path in `src/oauth-store.ts` deletes old `oauth_rate_limits`. Authorization requests are merely marked `used_at`; tokens and families are revoked, not purged.
- **Safe reproduction:** Static review only. Read the cited store paths and schema.
- **Connection traced:** The full JSON backup exports all public tables, so retained auth rows propagate directly into backup artifacts.
- **Root cause:** The OAuth implementation prioritizes auditability and single-use semantics but omits a retention job for old auth rows.
- **Connections and similar locations checked:** Rate-limit buckets already have bounded cleanup, showing the codebase accepts scheduled auth-adjacent deletion where implemented.
- **Durable fix:** Define retention windows per auth table, add purge jobs or migrations for old rows, and document which records must be retained for audit.
- **Why this is not a band-aid:** It makes retention an explicit policy instead of indefinite accumulation.
- **Pre-fix proof:** `src/oauth-store.ts:550-551` deletes only `oauth_rate_limits`.
- **Verification:** Add retention tests that create expired/revoked rows, run cleanup, and confirm the right rows remain.
- **Regression and rollback risk:** Low to medium; deleting old rows affects support/debug history and must be policy-backed.
- **Unknowns:** Live auth-table sizes were not inspected.

## Questions Needing Human Review

1. Are Vercel preview variables currently scoped so that ordinary previews do or do not receive the general `DATABASE_URL`? That decides whether UNS-001 is immediately exploitable or only one config change away.
2. Outside this repo, is there a current, practiced `pg_dump` or equivalent full-restore procedure with successful recent evidence? If yes, it should be linked from the runbook and exercised from CI-safe drills.
3. Is indefinite OAuth record retention intentional for compliance or support reasons? If yes, define the policy and backup handling explicitly.

## Ordered Repair Plan

1. Fix UNS-001 first. Make preview database selection fail closed and add a startup/test gate that proves previews cannot use the general runtime URL.
2. Fix UNS-002 next. Move treasury and direct-sale x402 flows onto a pending-payment record plus reconciliation path, then add failure-in-the-middle tests.
3. Fix UNS-004 and UNS-005 together. Unify backup, restore, and key-rotation tooling around explicit targets and a restore-tested artifact.
4. Fix UNS-003. Replace recursive map assembly, add depth/subtree limits, and bound public map output cost.
5. Fix UNS-006 and UNS-007. Add schema version tracking, deployment compatibility gates, and OAuth retention cleanup.

## Verification and Release Gates

| Gate | Pass condition |
| --- | --- |
| Preview isolation gate | A preview-without-override test fails closed, and deployment config review confirms previews cannot read the general runtime URL |
| Payment durability gate | Every x402 flow has a durable pending record before any non-recoverable step, with tests for crash/race scenarios |
| Recovery gate | A disposable restore drill succeeds from the exact backup artifact the repo produces and verifies schema plus critical row counts |
| Migration gate | Deploy or startup checks required schema version, and heavy indexes use an online-safe plan |
| Public map gate | Deep-tree stress tests complete without stack overflow and with bounded runtime |

## Overseer Record

- **Independent skeptic:** COMPLETED
- Separate skepticism passes re-checked each blocker/high item from raw source and reran focused tests where a safe deterministic replay existed.
- One earlier suspected trigger-order issue was disproved in disposable local Postgres and was excluded from the report.
- No blocker/high candidate was disproved; weaker backup and migration claims were kept at E2 because they rest on source evidence rather than forced failure.
- **Reviewer separation:** CONFIRMED
- Final severity and certainty were assigned only after a separate skepticism pass and a second raw-source read of every cited location.
- Audit-output folders were not used as evidence.

## Honest Limitations

- I did not inspect live databases, provider control planes, environment-variable scopes, or any ignored secret files.
- I did not read any file under `docs/audits` or `.codex/reports`; those were treated as out of scope because other audits are running in parallel.
- Other concurrent audit work created extra files in `docs/audits` during this session. I did not open or rely on them.
- Recovery claims that depend on Neon snapshots or external dump archives were evaluated only from repo source and runbooks, not from live provider state.
