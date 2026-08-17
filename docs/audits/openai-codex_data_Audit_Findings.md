# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-180958
- **Project:** 1f3d9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T18:09:58.2912150-05:00

## Plain-English Verdict

DO NOT RELEASE

- The only full-database backup path writes a table-by-table JSON dump with no transaction or snapshot boundary, so concurrent city activity can produce a logically inconsistent backup.
- The repo contains a snapshot backup writer, but no matching full restore implementation or restore test, so disaster recovery is not proven.
- Several production migrations for live tables run inside one implicit transaction with no lock timeout or `CONCURRENTLY`, so normal write traffic can be stalled by routine release DDL.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | BLOCKER | E2 | Snapshot backups read each table at a different point in time, so a busy production city can produce self-contradictory backup files. |
| UNS-002 | HIGH | E2 | The repo can create full JSON backups, but it has no full restore path or restore verification for those backups. |
| UNS-003 | HIGH | E2 | Three production migrations for live tables run in one transaction with no lock timeout and no concurrent index build, so release DDL can block normal city writes. |

### Next 3 Actions

1. Treat `scripts/backup.mjs` output as untrusted for disaster recovery until the backup is made transactionally consistent and a matching restore path is proven.
2. Add a behavior-level restore proof for full snapshots before relying on repo-local `backups/` for recovery.
3. Rework the `public-pagination`, `agreement-accession`, and `open-to-use` production migration path so lock behavior is bounded and verified on an upgraded database shape.

## Audit Contract

- Scope: data layer only: database access, schema, migrations, backup, and restore; followed into runtime callers and tests where needed.
- Product purpose: public production city where AI agents live, own persistent assets, sign agreements, and record real USDC-backed payments.
- Release profile: public production service with untrusted users and core persistent state that must survive concurrency and incidents.
- User parameters:
  - docs are claims, not truth
  - do not change code
  - do not read other audit reports
  - save findings as `docs/audits/openai-codex_data_Audit_Findings.md`
- Exclusions honored:
  - no `docs/audits` reads
  - no `.env` value reads
  - no secret-store reads
  - no backup dump reads
  - no live systems
- Allowed checks used:
  - static file inspection
  - local unit tests
  - local Docker-backed Postgres integration tests
- Outside-system limits:
  - no production access
  - no authenticated cloud access
  - no real payments
- No-remediation write policy:
  - no first-party code or config changes
  - one new report file only
- Normal generated output from approved checks:
  - Docker containers for local Postgres integration tests
  - temporary OS temp-directory files from Node tests
  - this audit report file

## Project and Connection Map

- Runtime DB access:
  - `src/db.ts` exports a process-wide Neon SQL client chosen by `runtimeDatabaseUrl()`.
  - App modules (`src/index.ts`, `src/world.ts`, `src/oauth-store.ts`, `src/engine.ts`, others) call SQL directly rather than through a repository layer.
- Schema source of truth:
  - `db/schema.sql` is the loopback full-schema upgrade path and fresh-install schema.
  - `db/migrations/*.sql` are named remote release migrations.
- Migration path:
  - `scripts/migrate.ts` resolves a target, verifies Neon branch identity for preview/production, optionally snapshots production, splits SQL statements, and executes them via `sql.transaction(...)`.
- Backup and restore path:
  - `scripts/backup.mjs` enumerates every `public` base table, runs `SELECT *` per table, serializes all rows to JSON, and writes into repo-local `backups/` by default.
  - `scripts/restore-key.mjs` is not a full restore tool; it rotates one resident secret and writes the new raw secret to a file under `backups/`.
- Critical data journeys checked:
  - resident identity and OAuth storage
  - world-root topology migration
  - public pagination index release
  - operator backup and resident-key recovery
  - production migration execution wrapper

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Runtime DB entrypoint and environment selection | CHECKED | `src/db.ts`, `test/runtime-db-url.test.ts` | Static plus unit tests only; no live envs |
| Core schema invariants and append-only/history tables | CHECKED | `db/schema.sql`, `test/migrate.test.ts`, `test/schema.test.ts`, `test/integration/world-root-postgres.test.ts`, `test/integration/oauth-postgres.test.ts` | Integration coverage is strong for world-root and OAuth, thinner elsewhere |
| Remote migration runner safety | CHECKED | `scripts/migrate.ts`, `db/migrations/*.sql`, `test/deploy-safety.test.ts`, `test/migrate.test.ts` | No preview/production Neon calls were executed |
| Backup implementation | CHECKED | `scripts/backup.mjs`, `test/operator-scripts.test.ts` | No real backup file contents inspected |
| Full snapshot restore | CHECKED | searched `scripts`, `package.json`, `test` | Negative proof only: no restore implementation present |
| Resident-key restore helper | CHECKED | `scripts/restore-key.mjs`, `test/operator-scripts.test.ts` | Focused helper only, not full database restore |
| Production data/backups/secrets | NOT CHECKED | excluded by contract | No live or secret material inspection |
| Other audit reports | NOT CHECKED | excluded by contract | intentionally unread |

First-party scope sampled directly:

- `db/schema.sql`
- 6 remote migration files in `db/migrations/`
- `src/db.ts`
- `scripts/backup.mjs`
- `scripts/restore-key.mjs`
- `scripts/migrate.ts`
- 8 relevant test files

Generated, vendored, ignored, or excluded areas:

- `node_modules/`: not audited
- `backups/` and `.release-backups/`: existence noted, contents not read
- `.env*`, `env.txt`, temp env files: names observed, values not read
- `docs/audits/`: excluded from inspection

## Evidence Ledger

- **EVD-001**
  - Time: 2026-08-15T18:02:00-05:00
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `Get-Content -Raw C:\Users\Owner\.codex\skills\unshittify\SKILL.md`
  - Exit code: 0
  - Result: Loaded audit-only workflow and reporting contract.
  - Side effects: none

- **EVD-002**
  - Time: 2026-08-15T18:02:00-05:00
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `rg --files db src ... | rg "(schema|migrations|postgres|db|database|sql|backup|restore)"`
  - Exit code: 1
  - Result: Located the data-layer file set despite harmless missing-directory noise from optional search roots.
  - Side effects: none

- **EVD-003**
  - Time: 2026-08-15T18:03:00-05:00
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `Get-Content -Raw src\db.ts`, `Get-Content -Raw db\schema.sql`, `Get-Content -Raw scripts\backup.mjs`, `Get-Content -Raw scripts\restore-key.mjs`, `Get-Content -Raw scripts\migrate.ts`
  - Exit code: 0
  - Result: Traced runtime DB access, full schema, backup writer, key-rotation helper, and migration executor.
  - Side effects: none

- **EVD-004**
  - Time: 2026-08-15T18:04:00-05:00
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `Get-Content -Raw db\migrations\*.sql`
  - Exit code: 0
  - Result: Read all six named release migrations.
  - Side effects: none

- **EVD-005**
  - Time: 2026-08-15T18:05:00-05:00
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `rg -n ... src api scripts test db`
  - Exit code: 0
  - Result: Confirmed direct SQL callers and located tests that exercise migrations and operator scripts.
  - Side effects: none

- **EVD-006**
  - Time: 2026-08-15T18:07:00-05:00
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `node --test --experimental-strip-types test/operator-scripts.test.ts test/migrate.test.ts test/schema.test.ts test/runtime-db-url.test.ts`
  - Exit code: 0
  - Result: 37 tests passed in 634.7 ms. Coverage proved parser and unit-level assumptions, but not full snapshot restore.
  - Side effects: OS temp files from tests; no project-file changes observed

- **EVD-007**
  - Time: 2026-08-15T18:07:30-05:00
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `node --test --experimental-strip-types --experimental-test-module-mocks test/integration/world-root-postgres.test.ts test/integration/oauth-postgres.test.ts`
  - Exit code: 0
  - Result: 17 Docker-backed Postgres integration tests passed in 17.0 s, proving world-root and OAuth transactional behavior on local Postgres.
  - Side effects: temporary Docker containers and temp directories; no project-file changes observed

- **EVD-008**
  - Time: 2026-08-15T18:08:30-05:00
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: targeted `rg -n` and numbered `Get-Content` refreshes for `scripts/backup.mjs`, `scripts/restore-key.mjs`, `scripts/migrate.ts`, migration files, and relevant tests
  - Exit code: 0
  - Result: Refreshed exact line citations immediately before admitting findings.
  - Side effects: none

## Findings

### UNS-001: Full-database backups are not transactionally consistent

- **Severity:** BLOCKER
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Production persistent state needs a recoverable backup path under concurrent users.
- **Location:** `scripts/backup.mjs:159`, `scripts/backup.mjs:170`, `scripts/backup.mjs:183`, `scripts/backup.mjs:194`
- **User or business harm:** A backup taken while agents are registering, moving, paying, or writing history can contain rows from different moments in time. Recovery can then replay impossible cross-table state, fail on restore, or silently lose consistency between ownership, payments, offers, history, and resident presence.
- **Evidence:** `runBackup()` opens one DB client, lists all public tables, then loops `SELECT *` table-by-table into one JSON object. There is no `BEGIN`, no repeatable-read snapshot, no exported snapshot token, and no lock strategy in the backup path. The city is explicitly concurrent and production.
- **Safe reproduction:** Deterministic static proof: inspect `scripts/backup.mjs:168-199`. The backup code performs one metadata query plus one independent read per table, then serializes the collected rows.
- **Connection traced:** operator invokes `scripts/backup.mjs` -> `runBackup()` -> `information_schema.tables` enumeration -> repeated `SELECT *` per table -> `backups/1f3d9-*.json` snapshot file.
- **Root cause:** The backup path was implemented as a convenience exporter rather than as a transactionally bounded database snapshot.
- **Connections and similar locations checked:** Checked `scripts/migrate.ts` and `src/engine.ts`; both do use explicit transaction handling for write paths. No comparable transaction wrapper exists in `scripts/backup.mjs`.
- **Durable fix:** Run the full snapshot inside one transaction with an explicit isolation level suitable for a consistent snapshot, keep all table reads on that snapshot, and prove the restored data shape on a live-shaped local database.
- **Why this is not a band-aid:** It removes the snapshot race at the source instead of documenting operator caution or hoping for a quiet period.
- **Pre-fix proof:** A safe local test should write related rows across multiple tables during backup and show the current exporter can capture a mixed-time state that the fixed version cannot.
- **Verification:** Add a behavior-level backup consistency test, then run targeted restore verification and the existing Postgres integration suite.
- **Regression and rollback risk:** Backup transaction changes can increase backup duration or DB load; rollback is to keep the old exporter only until the new path is proven, not to trust both equally.
- **Unknowns:** Static review cannot measure current production table sizes or actual backup runtime.

### UNS-002: The repository can create full JSON backups but cannot restore them

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Backup and restore must both be operable and proven for incident recovery.
- **Location:** `scripts/backup.mjs:159-225`, `scripts/restore-key.mjs:161-255`, `package.json`, `test/operator-scripts.test.ts:1`, `scripts/restore-key.mjs:233`
- **User or business harm:** In a real corruption or operator mistake, the repo supplies a way to create JSON snapshots but no repo-local mechanism to load them back into a clean database. Recovery time and data correctness are therefore unproven until an outage is already happening.
- **Evidence:** The only backup writer is `scripts/backup.mjs`. The only restore-named operator tool is `scripts/restore-key.mjs`, which rotates one resident secret, writes the new raw secret into `backups/`, and tells the operator to post to `/api/rotate`; it does not ingest a snapshot. Search hits across `scripts`, `package.json`, and `test` found no full snapshot restore command or restore test.
- **Safe reproduction:** Deterministic repo search: `rg -n 'backupMain|restoreKeyMain|runBackup|restoreResidentKey' ...` finds snapshot creation and key rotation only. No code reads `1f3d9-*.json` back into Postgres.
- **Connection traced:** operator backup path -> repo-local JSON snapshot -> incident recovery expectation -> no matching restore runner, no restore test, no release gate.
- **Root cause:** Backup was treated as the deliverable; restore was not implemented as a first-class, tested workflow.
- **Connections and similar locations checked:** Checked `scripts`, `package.json`, and `test` for snapshot importers, restore commands, and restore verification. None found beyond resident secret rotation.
- **Durable fix:** Add one supported full-restore path for the snapshot format, make it idempotent or explicitly one-shot, and prove it against a database seeded with representative relational state.
- **Why this is not a band-aid:** It turns the current write-only backup artifact into an actual disaster-recovery workflow instead of relying on manual improvisation.
- **Pre-fix proof:** A safe failing check is a test that creates a snapshot, provisions an empty local Postgres database, and currently cannot restore the snapshot because no restore entrypoint exists.
- **Verification:** Add restore integration tests, include them in the explicit release/test gates, and verify round-trip equivalence for key tables and constrained relationships.
- **Regression and rollback risk:** Restore tooling is inherently high risk because it writes critical state; verification must stay local and reversible before any operator use.
- **Unknowns:** There may be an out-of-repo manual restore runbook, but none exists in the checked source.

### UNS-003: Routine production migrations can block live writes for unbounded time

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Production schema changes should fail cleanly or use bounded locking under concurrent public traffic.
- **Location:** `scripts/migrate.ts:511-531`, `db/migrations/20260814_public_pagination.sql:3`, `db/migrations/20260814_agreement_accession.sql:5`, `db/migrations/20260815_open_to_use.sql:1`, `db/migrations/20260814_world_root_topology.sql:6`, `test/deploy-safety.test.ts:534`, `test/deploy-safety.test.ts:591`, `test/deploy-safety.test.ts:646`
- **User or business harm:** Running these production migrations during traffic can hold live-table DDL locks long enough to stall agent writes, creating user-visible outages or release aborts at unpredictable points.
- **Evidence:** `applyMigration()` wraps any migration lacking explicit `BEGIN/COMMIT` in one `sql.transaction(...)`. The `public-pagination` migration creates 10 indexes on busy live tables; `agreement-accession` alters `agreement_parties` and creates indexes/triggers; `open-to-use` alters `things`. None of those files set `lock_timeout`, `statement_timeout`, or use concurrent index creation. By contrast, the destructive `world-root-topology` migration explicitly sets short lock and statement timeouts before touching live topology.
- **Safe reproduction:** Deterministic static proof from the cited files. Supporting test coverage is mostly shape/selection checks: the checked tests assert additive text and drift, but only `world-root-postgres` and `oauth-postgres` execute real upgraded-database migrations in Postgres.
- **Connection traced:** release operator -> `scripts/migrate.ts` -> implicit transaction wrapper -> live-table DDL in named production migration -> lock acquisition during normal city traffic.
- **Root cause:** The migration runner provides transactional convenience, but the named live-table migrations were not all designed with bounded lock behavior like the explicitly guarded world-root migration.
- **Connections and similar locations checked:** Compared all named migrations. `world-root-topology` is the only reviewed remote migration in this set with explicit lock bounds; `public-pagination`, `agreement-accession`, and `open-to-use` lack them.
- **Durable fix:** Separate lock-sensitive migration classes, add bounded lock behavior appropriate to each DDL, and prove upgraded-database execution on local Postgres for every production migration that touches existing hot tables.
- **Why this is not a band-aid:** It changes the migration execution model for the risky class of DDL instead of relying on off-hours timing or operator caution.
- **Pre-fix proof:** A safe local proof is a Docker-backed upgraded-database test that holds a write transaction open on affected tables and demonstrates the current migration either blocks or fails late rather than failing quickly by design.
- **Verification:** Add execution tests for `public-pagination`, `agreement-accession`, and `open-to-use` on upgraded schemas, then run the current unit/integration suites.
- **Regression and rollback risk:** Migration sequencing changes can alter release steps and rollback expectations; each migration needs an explicit operator plan before production use.
- **Unknowns:** Static review cannot measure the exact lock duration on current production data volume.

## Questions Needing Human Review

- **Q-001:** Is there an external, human-run restore procedure for `backups/1f3d9-*.json` that is intentionally kept out of this repo?
  - Why it matters: if yes, the repo still lacks executable proof, but the operational gap is narrower than a total absence of restore knowledge.
  - Available evidence: no restore implementation or restore tests were found in `scripts`, `package.json`, or `test`.
  - Missing evidence: any out-of-band runbook or exercised restore drill result.
  - Safest next check: have a human provide the runbook and a dated restore-drill record without exposing live credentials or backup contents.
  - Should release wait: yes, if this backup path is currently part of production recovery expectations.

## Ordered Repair Plan

1. Contain active backup risk from `UNS-001` and `UNS-002` by treating current snapshot files as operator convenience exports, not disaster-recovery proof.
2. Add a failing behavior-level local test for `UNS-001` showing mixed-time backup state under concurrent writes.
3. Implement and verify the shared root cause repair for `UNS-001`: one consistent snapshot boundary across the whole backup.
4. Implement and verify the missing restore path for `UNS-002`, including existing-data handling and failure rollback on a local Postgres database.
5. Add failing upgraded-database execution tests for `UNS-003` on `public-pagination`, `agreement-accession`, and `open-to-use`.
6. Repair `UNS-003` by introducing bounded lock behavior and migration-class-specific execution semantics, then rerun targeted Postgres tests plus release-gate tests.
7. Run a new full `$unshittify` audit against the repaired data layer and cite this report.

## Verification and Release Gates

- Required success conditions before release:
  - a full backup is transactionally consistent under concurrent local writes
  - a full backup can be restored into empty local Postgres and match expected relational state
  - every production migration touching existing hot tables has an upgraded-database execution test
- Safe commands used or recommended:
  - `node --test --experimental-strip-types test/operator-scripts.test.ts test/migrate.test.ts test/schema.test.ts test/runtime-db-url.test.ts`
  - `node --test --experimental-strip-types --experimental-test-module-mocks test/integration/world-root-postgres.test.ts test/integration/oauth-postgres.test.ts`
- Manual checks still needed:
  - local-only backup/restore drill on representative seeded data
  - lock-behavior drill for named production migrations on a local upgraded schema
- Forbidden actions during verification:
  - no production Neon migrations
  - no live database backup/restore
  - no real payments
  - no secret-file or backup-dump inspection in chat
- Rollback conditions:
  - any restore mismatch across core ownership, payment, or history tables
  - any migration path that can block normal writes longer than its designed bound

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

single-agent audit - independently unverified

- No fresh skeptic reviewed the candidate set.
- E4 certainty was not used.
- The verdict is based on direct code evidence, targeted tests, and traced runtime connections only.

## Honest Limitations

- Static review cannot prove actual production table sizes, runtime lock durations, or current operator practice.
- No live systems, production backups, or secret material were inspected.
- `docs/` was treated as secondary and no `docs/audits/` content was read by contract.
- Checked integration coverage is materially stronger for world-root and OAuth than for the newer `agreement-accession`, `open-to-use`, and `public-pagination` upgrade paths.
- Docker-backed tests prove local PostgreSQL behavior, not Neon operational characteristics.
- Same-model blind spots remain because no fresh skeptic completed review.
- Generated side effects from approved checks were limited to:
  - temporary Docker containers for local Postgres tests
  - OS temp files/directories from Node tests
  - this report file
- Evidence for admitted findings was re-opened immediately before drafting. No cited source changed during the audit.
