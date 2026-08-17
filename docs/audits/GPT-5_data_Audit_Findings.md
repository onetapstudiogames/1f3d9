# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-181037
- **Project:** 1F3D9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T18:10:37.5117825-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- The repo can generate full local database exports, but the checked first-party code does not include a matching restore path or round-trip restore proof.
- Hosted-chat OAuth state is retained indefinitely after expiry or revocation, so dead auth history keeps growing and every later backup/export carries it forward.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | MEDIUM | E2 | Expired and revoked OAuth rows accumulate indefinitely, growing auth tables and every later backup/export. |
| UNS-002 | MEDIUM | E2 | The local JSON backup path has no first-party restore implementation or round-trip recovery proof in the checked code. |
| UNS-003 | LOW | E2 | The local backup tool exports every public table, including hashed auth credentials and payment history, into one plaintext JSON artifact. |

### Next 3 Actions

1. Decide which backup path is actually authoritative in production: Neon snapshot, PostgreSQL dump, or local JSON export.
2. Add one tested recovery path that can restore a disposable copy from the chosen authoritative backup and verify core table counts and constraints.
3. Add retention handling for expired OAuth codes, token families, and tokens before hosted sign-in traffic makes backups and restores steadily heavier.

## Audit Contract

- Scope: the data layer only: database access, schema, migrations, backup, and restore.
- Product purpose: a live public AI-agent city where residents register, build, sign agreements, and record real USDC-linked transfers.
- Release profile: production public service with persistent user data and payment records.
- User parameters: audit only; no first-party code changes except a new findings file in `docs/audits`; treat docs as claims to verify; do not read other audit reports; no live systems.
- Exclusions: authenticated external systems, real production databases, secrets file contents, backup payload contents, and live provider consoles.
- Allowed checks: static inspection plus local non-destructive tests already in the repo.
- Outside-system limits: no production access, no migrations against real databases, no real payments, no authenticated Neon/API calls.
- Write policy: no remediation; one new report file only.
- Normal generated output allowed by checks: Node test output to stdout only. No first-party source or schema files changed during checked commands.

## Project and Connection Map

- Runtime database access:
  `src/db.ts` -> `@neondatabase/serverless` tagged client -> route modules and stores.
- Main DB-facing modules checked:
  `src/index.ts`, `src/world.ts`, `src/society.ts`, `src/world-market.ts`, `src/oauth-store.ts`, `src/engine.ts`, `src/moderation-store.ts`.
- Schema authority:
  `db/schema.sql` for fresh installs, plus named additive release migrations in `db/migrations/*.sql`.
- Migration control path:
  operator -> `scripts/migrate.ts` -> explicit `--target` + named migration -> preview/production Neon endpoint verification -> optional production snapshot -> transactional statement apply.
- Local backup path:
  operator -> `scripts/backup.mjs` -> discover all `public` base tables -> `SELECT *` each table -> atomic JSON write under `backups/` or custom `--out`.
- Local recovery path found in code:
  operator -> `scripts/restore-key.mjs` -> inspect one resident -> optionally rotate `residents.secret_hash` and write a one-time replacement key file.
- Critical data journeys checked:
  `Authorization request -> code -> token family -> access/refresh tokens -> revocation/reuse`
  `Register resident -> residents + resident_presence + events`
  `Offer/claim sale -> transfer_offers + payment_uses + sale_payments + transfers + events`
  `Migration target selection -> Neon branch verification -> additive SQL apply`
  `Backup export -> JSON snapshot on local disk`

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Database client selection and runtime access | CHECKED | `src/db.ts`, `src/core.ts`, `src/engine.ts`, route/store callers, `test/runtime-db-url.test.ts` | Static review only; no real Neon connection opened. |
| Fresh schema and additive migrations | CHECKED | `db/schema.sql`, `db/migrations/*.sql`, `scripts/migrate.ts`, `test/migrate.test.ts`, `test/deploy-safety.test.ts`, `test/schema.test.ts` | Local tests prove control logic, not production branch state. |
| OAuth/auth data model and retention | CHECKED | `db/schema.sql`, `src/oauth-store.ts`, `test/integration/oauth-postgres.test.ts` | No production row counts available. |
| Payment and transfer storage backstops | PARTLY CHECKED | `db/schema.sql`, `src/society.ts`, `src/world-market.ts`, `test/migrate.test.ts` | Did not run live payment verification or full world-market integration suite. |
| Local backup path | CHECKED | `scripts/backup.mjs`, `test/operator-scripts.test.ts`, `docs/runbooks/BACKUP_RESTORE.md` | I did not create or inspect a real backup payload. |
| Local restore/recovery path | PARTLY CHECKED | `scripts/restore-key.mjs`, `test/operator-scripts.test.ts`, `scripts/migrate.ts`, `docs/runbooks/BACKUP_RESTORE.md` | No authenticated Neon restore drill or `pg_restore` run was allowed. |
| Data-layer integration honesty | CHECKED | `test/integration/oauth-postgres.test.ts`, `test/integration/write-sql-postgres.test.ts`, `package.json` | Integration suite coverage is sampled, not exhaustive across every route. |
| Outside provider backups and snapshots | NOT CHECKED | Runbook references only | External state and provider retention were out of scope. |

Checked scope measure: 118 first-party files excluding `.git`, `node_modules`, and `docs/audits`.

Generated, vendored, ignored, unreadable, nested, and sampled areas:
- Vendored/generated excluded: `.git/**`, `node_modules/**`.
- Ignored sensitive payloads not opened: real `.env*`, `env.txt`, `backups/**`, `.release-backups/**`.
- Nested repositories: none found in the checked scope.
- Sampled rather than exhaustive tests: PostgreSQL integration files and operator-script tests most relevant to data-layer claims.

## Evidence Ledger

| ID | Time | Folder | Command | Exit | Redacted result | Side effects |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | 18:00 | project root | `Get-Content -Raw C:\Users\Owner\.codex\skills\unshittify\SKILL.md` plus required references | 0 | Loaded audit rules, report contract, and skeptic requirements. | None. |
| EVD-002 | 18:01 | project root | `Get-ChildItem -Name docs\audits` | 0 | Existing audit filenames showed `GPT-5_*_Audit_Findings.md` naming in this repo. | None. |
| EVD-003 | 18:02 | project root | `rg -n --hidden ... "(postgres|migration|backup|restore|DATABASE_URL|neon)"` and `rg --files ...` | 0 | Mapped concrete data-layer files: `src/db.ts`, `db/schema.sql`, `db/migrations/*.sql`, `scripts/backup.mjs`, `scripts/restore-key.mjs`, `scripts/migrate.ts`, and integration tests. | None. |
| EVD-004 | 18:03-18:06 | project root | `Get-Content -Raw` on `src/db.ts`, `scripts/backup.mjs`, `scripts/restore-key.mjs`, `scripts/migrate.ts`, `src/index.ts`, `src/world.ts`, `src/society.ts`, `src/core.ts`, `src/oauth-store.ts`, `src/engine.ts` | 0 | Traced runtime DB client selection, route/store callers, backup export path, key restore path, and migration gate logic. | None. |
| EVD-005 | 18:06-18:08 | project root | `rg -n` and numbered reads on `db/schema.sql`, `test/schema.test.ts`, `test/deploy-safety.test.ts`, `test/operator-scripts.test.ts`, `test/integration/oauth-postgres.test.ts`, `test/integration/write-sql-postgres.test.ts` | 0 | Verified schema backstops, migration safety checks, and what tests do and do not exercise. | None. |
| EVD-006 | 18:08 | project root | `node --test --experimental-strip-types test/operator-scripts.test.ts test/deploy-safety.test.ts test/schema.test.ts test/runtime-db-url.test.ts` | 0 | 37/37 tests passed. Operator-script tests cover argument validation, path containment, exclusive file writes, and failure cleanup. Migration safety tests cover explicit target selection and snapshot verification. | Stdout test output only. |
| EVD-007 | 18:08 | project root | `node --test --experimental-strip-types test/migrate.test.ts` | 0 | 23/23 tests passed. Schema/migration tests validate append-only and additive migration expectations. | Stdout test output only. |
| EVD-008 | 18:09-18:10 | project root | Numbered re-open of `src/oauth-store.ts`, `scripts/backup.mjs`, `scripts/restore-key.mjs`, `db/schema.sql`, `docs/runbooks/BACKUP_RESTORE.md` | 0 | Reconfirmed cited locations immediately before admitting findings. | None. |

## Findings

### UNS-001: Expired and revoked OAuth state is retained indefinitely

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Hosted sign-in storage must have bounded retention and operationally safe backup growth.
- **Location:** `src/oauth-store.ts:75-103`, `src/oauth-store.ts:360-503`, `src/oauth-store.ts:541-560`, `db/schema.sql:109-177`, `scripts/backup.mjs:170-199`
- **User or business harm:** As hosted sign-in traffic grows, expired codes and revoked token families keep accumulating in the primary database and in every later local export. That increases backup size, restore time, table/index bloat, and auth-incident cleanup cost without improving live behavior.
- **Evidence:** `oauth_authorization_codes`, `oauth_token_families`, and `oauth_tokens` are created with expiry/revocation fields in `db/schema.sql:109-177`. In the checked application code, expired pending authorization requests are partially cleaned in `createAuthorizationRequest()` (`src/oauth-store.ts:75-103`), and `oauth_rate_limits` are pruned in `consumeOAuthRateLimit()` (`src/oauth-store.ts:541-560`), but code exchange, token rotation, and revocation only mark `used_at` or `revoked_at` (`src/oauth-store.ts:360-503`). The backup path exports every public base table with no exclusions (`scripts/backup.mjs:170-199`). The integration suite explicitly ages and revokes tokens, then continues asserting against those retained rows instead of a purge path (`test/integration/oauth-postgres.test.ts:691-799`).
- **Safe reproduction:** Static trace only. Re-running the checked OAuth integration suite proves revocation and expiry behavior, but no first-party cleanup path exists to exercise.
- **Connection traced:** OAuth sign-in -> authorization code row -> token family + token rows -> expiry or revocation updates metadata only -> stale rows stay in primary tables -> `scripts/backup.mjs` exports them on every snapshot.
- **Root cause:** The schema models lifecycle state with timestamps, but the app implements no retention job or purge routine for expired authorization codes, expired token families, or revoked tokens.
- **Connections and similar locations checked:** `oauth_authorization_requests`, `oauth_authorization_codes`, `oauth_token_families`, `oauth_tokens`, `oauth_rate_limits`, backup export path, and OAuth PostgreSQL integration tests.
- **Durable fix:** Define a retention policy for dead OAuth rows, implement one bounded cleanup path for codes/families/tokens, and prove it on a disposable database with row-count assertions before and after cleanup. Apply the same retention rule to backup/export expectations.
- **Why this is not a band-aid:** It removes the source of monotonically growing dead auth history instead of just tolerating larger tables and exports.
- **Pre-fix proof:** Add a failing integration test that seeds expired codes, expired families, revoked tokens, and used refresh tokens, runs the cleanup path, and asserts that only live grants remain while active auth still works.
- **Verification:** Re-run `test/integration/oauth-postgres.test.ts`, targeted cleanup tests, and a backup/export smoke check that compares OAuth row counts before and after cleanup.
- **Regression and rollback risk:** Cleanup can revoke or delete rows still needed for active sessions if the retention boundary is wrong. Rollback must restore from a disposable copy first, then widen the retention window rather than reintroducing unbounded growth.
- **Unknowns:** Current production row counts and current auth traffic were not available.

### UNS-002: The local JSON backup path has no first-party restore implementation or round-trip recovery proof

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Backup tooling must have a proven recovery path; export-only artifacts are not enough for outage recovery.
- **Location:** `scripts/backup.mjs:159-219`, `scripts/restore-key.mjs:161-255`, `test/operator-scripts.test.ts:1-220`, `docs/runbooks/BACKUP_RESTORE.md:26-49`
- **User or business harm:** In a real incident, an operator can produce a full local JSON database export, but the checked repo provides no matching restore tool or round-trip restore test for that artifact. Recovery confidence therefore depends on external/manual provider paths rather than the backup mechanism shipped beside the code.
- **Evidence:** `runBackup()` enumerates all public tables and writes one JSON snapshot (`scripts/backup.mjs:159-219`). The only repo-local recovery script I found is `restoreResidentKey()`, which rotates one resident key and writes a replacement file; it is not a database restore path (`scripts/restore-key.mjs:161-255`). The operator-script suite covers argument parsing, path containment, and failure cleanup, but does not call `runBackup()` or restore a backup artifact (`test/operator-scripts.test.ts:1-220`). The runbook itself states that the JSON snapshot is an export/inspection layer and that automated JSON restore is not implemented (`docs/runbooks/BACKUP_RESTORE.md:47-49`).
- **Safe reproduction:** Static trace plus passing local operator-script tests. No live restore drill or privileged provider command was allowed.
- **Connection traced:** operator runs local backup -> JSON snapshot created -> incident requires recovery -> checked repo offers no reciprocal restore path for that snapshot -> recovery falls back to unverified-outside-code manual systems.
- **Root cause:** The repo implements export generation but not the reverse transformation back into a disposable database, and it has no round-trip recovery test for the export it produces.
- **Connections and similar locations checked:** `scripts/backup.mjs`, `scripts/restore-key.mjs`, `scripts/migrate.ts`, `test/operator-scripts.test.ts`, `test/deploy-safety.test.ts`, `docs/runbooks/BACKUP_RESTORE.md`.
- **Durable fix:** Pick one authoritative recovery path, encode it as a repeatable drill, and add a disposable restore verification step that proves core table counts, constraints, and key journeys after restoration.
- **Why this is not a band-aid:** It proves actual recovery instead of only proving export creation.
- **Pre-fix proof:** Add a failing recovery test or documented manual drill record that starts from a fresh disposable database, restores from the chosen authoritative backup, and checks `residents`, `places`, `events`, `notes`, and constraint validation.
- **Verification:** Run the recovery drill on a disposable target, capture non-secret counts and constraint status, then re-run `test:postgres` against the restored copy.
- **Regression and rollback risk:** Restore automation can damage operator confidence if it silently diverges from production backup reality. Rollback is to keep the current manual-only process while the drill is corrected; do not delete existing backups.
- **Unknowns:** External Neon snapshot and `pg_dump`/`pg_restore` workflows were not executed in this audit.

### UNS-003: Local exports bundle all public tables, including auth hashes and payment records, into one plaintext snapshot

- **Severity:** LOW
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Operator backup artifacts should minimize accidental exposure of credential material and private operational history.
- **Location:** `db/schema.sql:4-10`, `db/schema.sql:50-177`, `db/schema.sql:1223-1267`, `scripts/backup.mjs:170-219`, `docs/runbooks/BACKUP_RESTORE.md:38-45`
- **User or business harm:** A single local export contains resident secret hashes, OAuth request/code/token hashes, wallet/payment records, and operational history together. If an operator chooses an unsafe destination or syncs the file elsewhere, one mistake leaks the whole auth-and-payments history instead of a narrower backup set.
- **Evidence:** The schema keeps sensitive-but-hashed identity and auth fields in `residents.secret_hash` and the OAuth tables (`db/schema.sql:4-10`, `db/schema.sql:50-177`), plus payment and wallet records in `payment_uses`, `fees`, and `sale_payments` (`db/schema.sql:1223-1267`). `runBackup()` queries every public base table and serializes full row contents into one JSON object (`scripts/backup.mjs:170-199`). A custom `--out` path is allowed and bypasses managed pruning (`scripts/backup.mjs:191-219`). The runbook warns that the export contains credential hashes and private operational records (`docs/runbooks/BACKUP_RESTORE.md:38-45`), which matches the checked code and schema.
- **Safe reproduction:** Static trace only. I did not generate or inspect a real backup payload.
- **Connection traced:** full-table export logic -> one plaintext JSON file -> any operator storage mistake affects resident auth material, OAuth history, and payment records together.
- **Root cause:** The local export path has no table allowlist, field minimization, or backup-class separation; it snapshots the whole public schema as-is.
- **Connections and similar locations checked:** Auth tables, payment tables, backup export code, runbook guidance, and operator-script tests.
- **Durable fix:** Separate inspection exports from recovery backups, minimize fields where possible, and enforce safer destination/retention handling for sensitive local artifacts.
- **Why this is not a band-aid:** It changes the backup shape and handling rules instead of relying on operators to remember that one large plaintext file is sensitive.
- **Pre-fix proof:** Add a deterministic test that asserts which tables and fields enter each backup class, plus a recovery drill that proves the minimized recovery artifact is still sufficient.
- **Verification:** Re-run operator-script tests, backup/export tests, and the chosen restore drill. Confirm non-secret table counts still match expectations.
- **Regression and rollback risk:** Over-minimizing fields can make backups useless for recovery or forensics. Rollback must preserve an authoritative full-fidelity recovery path.
- **Unknowns:** I did not inspect current operator storage destinations or ACLs in this audit.

## Questions Needing Human Review

| Question | Why it matters | Available evidence | Missing evidence | Safest next check | Should release wait? |
| --- | --- | --- | --- | --- | --- |
| Are Neon snapshots or PostgreSQL dumps currently being exercised on a regular, successful restore drill cadence? | If not, UNS-002 is more than a repo-local gap; it becomes a live recovery risk. | `docs/runbooks/BACKUP_RESTORE.md` claims successful drills and provider snapshots, but this audit did not verify those external systems. | Current provider-side snapshot schedule, most recent successful drill evidence, and actual dump archives. | On a human-operated disposable environment, run the documented restore drill and record only non-secret table/constraint counts. | No for repo-only release judgment, yes before relying on recovery promises operationally. |
| How large are `oauth_authorization_codes`, `oauth_token_families`, and `oauth_tokens` in production today? | That decides whether UNS-001 is still early technical debt or already a noticeable operational drag. | The checked code proves indefinite retention behavior. | Current row counts, index sizes, and backup contribution in production. | Run a read-only row-count/size check on a disposable clone or provider metrics view. | No. |

## Ordered Repair Plan

1. For `UNS-002`, name the authoritative recovery source and stop treating the local JSON export as an implied restore path if it is not one.
2. For `UNS-002`, add a failing disposable recovery proof that restores from that source and checks core table counts plus zero unvalidated constraints.
3. For `UNS-001`, add a failing retention test covering expired codes, expired families, revoked tokens, and used refresh tokens.
4. Repair the shared root causes:
   implement one bounded OAuth cleanup path for `UNS-001`;
   implement or explicitly demote the local JSON path for `UNS-002`;
   split or minimize local export classes for `UNS-003` if the JSON path remains.
5. Handle existing stored data safely:
   decide retention windows for historical OAuth rows;
   measure current table sizes before deleting anything;
   preserve a safe forensic recovery route.
6. Re-run targeted checks:
   `node --test --experimental-strip-types test/operator-scripts.test.ts test/deploy-safety.test.ts test/schema.test.ts test/runtime-db-url.test.ts`
   and `node --test --experimental-strip-types test/migrate.test.ts`
   plus any new restore and cleanup tests.
7. Release in reversible stages, monitor auth-table growth and backup artifact size specifically, then run a new full `$unshittify` audit against the repaired state.

## Verification and Release Gates

- Success conditions:
  one recovery path is proven on a disposable target;
  OAuth dead-row retention is bounded and tested;
  backup/export expectations are explicit rather than implied.
- Safe commands already proven local:
  `node --test --experimental-strip-types test/operator-scripts.test.ts test/deploy-safety.test.ts test/schema.test.ts test/runtime-db-url.test.ts`
  `node --test --experimental-strip-types test/migrate.test.ts`
- Manual checks still needed:
  disposable restore drill from the chosen authoritative backup source;
  non-secret counts for `residents`, `places`, `events`, `notes`;
  `SELECT count(*) FROM pg_constraint WHERE NOT convalidated`.
- Test data needed:
  expired authorization codes;
  expired token families;
  revoked token families;
  one disposable restore snapshot or dump.
- Forbidden live actions during verification:
  production migrations, provider snapshot finalize operations, real payment flows, and printing secret-bearing connection material.
- Rollback conditions:
  any cleanup deleting active auth grants;
  any restore drill that cannot recreate core counts or leaves unvalidated constraints;
  any backup change that removes the only recoverable dataset.
- Required evidence before calling the repair complete:
  failing-before/passing-after cleanup proof,
  restore drill record on a disposable target,
  and fresh non-secret row-count evidence.

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

single-agent audit - independently unverified

- No fresh skeptic was available in this harness turn.
- Because there was no independent skeptic, I did not issue `NO RELEASE-BLOCKING ISSUE FOUND IN CHECKED AREAS` and I did not promote any finding above E2.
- Findings were re-opened at their cited files and lines immediately before finalizing the report.

## Honest Limitations

- This was a static-plus-local-test audit only. It cannot prove current production data volume, provider snapshot health, or real restore readiness.
- I did not inspect secret-file contents, backup payload contents, or external Neon state.
- I did not run `test:postgres`, the full Playwright suite, or any authenticated provider command.
- The checked repo contains evidence that external restore drills may exist, but that evidence lives in docs/runbooks rather than executable first-party recovery code.
- Same-model single-agent review can miss correlated blind spots.
- Local checks created only stdout test output. No generated first-party source, schema, coverage, screenshot, or backup artifact was intentionally created.
- Outside systems and platform-specific file permissions are not fully covered here.
- No evidence found in the checked scope that contradicted the migration safety gates; the risks admitted here are retention and recoverability gaps, not a claim that the whole data layer is unsafe.
