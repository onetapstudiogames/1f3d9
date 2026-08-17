# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-181022
- **Project:** 1f3d9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T18:10:22.4841600-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- Production is live on Vercel and the checked deploy path is coherent.
- Two operator paths remain materially brittle: database-target selection for backup/key-restore, and the one-way local backup format.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | HIGH | E2 | Backup and resident-key recovery scripts can silently act on whichever database URL happens to be present in ignored local files. |
| UNS-002 | MEDIUM | E2 | The repository-native JSON backup format has no implemented restore path, so the local export cannot be used directly in an incident. |

### Next 3 Actions

1. Put explicit target proof on `scripts/backup.mjs` and `scripts/restore-key.mjs`, not just on migrations.
2. Add a tested restore path for the JSON backup format or remove it from the implied recovery toolchain.
3. Confirm whether production merges are protected by server-side required checks and record that evidence outside local runbooks.

## Audit Contract

- Scope: infrastructure and operations only: deploy, DNS, environment, CI, and the test harness, plus touched backup/restore and scheduled-work surfaces.
- Product purpose: public production website where AI agents live, transact, and hold real-value assets.
- Release profile: public, paid, production service with live users and money-adjacent behavior.
- User parameters: docs treated as claims to verify; do not change code; do not read other audit reports.
- Exclusions: no reads of `docs/audits/**`; no secret-file contents; no authenticated provider access; no state-changing production access.
- Allowed dynamic checks: read-only filesystem inspection, safe Git reads, read-only HTTPS requests to public production endpoints, public DNS resolution.
- Outside-system limits: no Vercel, Neon, GitHub, or secret-store authentication; no deploys, migrations, seeds, payments, or writes.
- Write policy: no remediation; one new audit report only.
- Normal generated output allowed by contract: none were intentionally created during this audit.

## Project and Connection Map

- HTTP entry: [`vercel.json`](C:/Users/Owner/Documents/1f3d9/vercel.json) rewrites every path to [`api/index.ts`](C:/Users/Owner/Documents/1f3d9/api/index.ts), which forwards to [`src/index.ts`](C:/Users/Owner/Documents/1f3d9/src/index.ts).
- Runtime database selection: [`src/db.ts`](C:/Users/Owner/Documents/1f3d9/src/db.ts) chooses `HOSTED_CHAT_PREVIEW_DATABASE_URL` only for Vercel preview, otherwise `DATABASE_URL`.
- Release path:
  `review branch -> scripts/deploy.sh --prepare -> PR preview -> merge to main -> Vercel Git deploy`
- Migration path:
  `named npm script -> scripts/migrate.ts -> optional Neon endpoint verification -> optional production snapshot -> direct Neon SQL transaction`
- Backup/recovery path:
  `node scripts/backup.mjs -> resolveDatabaseUrl() -> live DB read -> JSON snapshot in backups/`
  `node scripts/restore-key.mjs <handle> --confirm -> resolveDatabaseUrl() -> UPDATE residents.secret_hash`
- Test harness:
  `npm test` covers `test/*.test.ts`
  `npm run test:postgres` runs Docker-backed PostgreSQL integration tests
  `npm run test:e2e` runs Playwright against [`e2e/oauth-test-server.ts`](C:/Users/Owner/Documents/1f3d9/e2e/oauth-test-server.ts)
- Live production checks performed:
  `https://1f3d9.com/` returned `200`
  `https://1f3d9.com/api/official` returned live JSON
  `1f3d9.com` and `www.1f3d9.com` both resolved to `76.76.21.21` with Vercel response headers

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Vercel entry and deploy topology | CHECKED | `vercel.json`, `api/index.ts`, `src/index.ts`, deployment runbook, live headers/DNS | No authenticated Vercel project inspection |
| Database environment selection | CHECKED | `src/db.ts`, `scripts/migrate.ts`, `scripts/backup.mjs`, `scripts/restore-key.mjs`, `test/runtime-db-url.test.ts` | Secret values intentionally not read |
| Migration safety | CHECKED | `scripts/migrate.ts`, `package.json`, `test/deploy-safety.test.ts`, `docs/runbooks/DEPLOYMENT.md` | No live Neon API or SQL calls |
| Backup and restore | CHECKED | `scripts/backup.mjs`, `scripts/restore-key.mjs`, `test/operator-scripts.test.ts`, `docs/runbooks/BACKUP_RESTORE.md` | Did not read backup payloads or run destructive recovery |
| CI and release gating | PARTLY CHECKED | repo root inventory, absence of `.github`, `scripts/deploy.sh`, deploy tests, deployment runbook | Could not inspect GitHub branch protection or required checks |
| Playwright and integration harness | CHECKED | `playwright.config.ts`, `e2e/oauth-test-server.ts`, package scripts, integration tests | Did not execute Docker or browser suites |
| Monitoring and health checks | PARTLY CHECKED | source search, live root/API responses, runbooks | No provider-level alerting, logs, or tracing access |
| Secret files and provider exports | PARTLY CHECKED | root file inventory and environment runbook only | File contents intentionally not read |
| `docs/audits/**` | NOT CHECKED | user exclusion honored | Deliberately excluded |
| Nested/generated/vendor areas | PARTLY CHECKED | `node_modules/`, `.vercel/`, `test-results/`, `backups/`, `.release-backups/` present | Generated or secret-bearing areas not inspected |

First-party scope measure used in this audit: 1 Vercel config, 1 package manifest, 4 runbooks/features docs read, 6 operator/runtime files, 6 deploy/runtime/test files, targeted live DNS/HTTP checks.

## Evidence Ledger

- **EVD-001**
  - Time: 2026-08-15 17:58 America/Chicago
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Exact command: `rg --files -g "!*docs/audits/**" -g "!docs/audits/**"`
  - Exit code: 0
  - Redacted result: repo inventory confirmed `vercel.json`, `scripts/`, `db/migrations/`, `test/`, `e2e/`, and runbooks
  - Side effects: none

- **EVD-002**
  - Time: 2026-08-15 17:58 America/Chicago
  - Folder: `C:\Users\Owner\Documents`
  - Exact command: `C:\Program Files\Git\cmd\git.exe --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --branch --ignore-submodules=all`
  - Exit code: 0
  - Redacted result: branch `codex/workspace-reconciliation`; unrelated untracked audit files already existed under `docs/audits/`
  - Side effects: none

- **EVD-003**
  - Time: 2026-08-15 18:00 America/Chicago
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Exact command: `Get-Content -Raw vercel.json`, `Get-Content -Raw api\index.ts`, `Get-Content -Raw src\index.ts`, `Get-Content -Raw src\db.ts`
  - Exit code: 0
  - Redacted result: one Vercel function receives all routes; runtime DB choice is env-driven
  - Side effects: none

- **EVD-004**
  - Time: 2026-08-15 18:01 America/Chicago
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Exact command: `Get-Content -Raw scripts\migrate.ts`, `Get-Content -Raw scripts\deploy.sh`, `Get-Content -Raw test\deploy-safety.test.ts`, `Get-Content -Raw test\deployment-pipeline-reconciliation.test.ts`
  - Exit code: 0
  - Redacted result: migrations prove preview/production target identity before DDL; deploy helper is preparation-only and local
  - Side effects: none

- **EVD-005**
  - Time: 2026-08-15 18:03 America/Chicago
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Exact command: `Get-Content -Raw scripts\backup.mjs`, `Get-Content -Raw scripts\restore-key.mjs`, `Get-Content -Raw test\operator-scripts.test.ts`
  - Exit code: 0
  - Redacted result: backup and restore-key share a permissive `resolveDatabaseUrl()` fallback chain with no target proof
  - Side effects: none

- **EVD-006**
  - Time: 2026-08-15 18:05 America/Chicago
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Exact command: `Invoke-WebRequest https://1f3d9.com/api/official`, `Invoke-WebRequest https://1f3d9.com/`, `Resolve-DnsName 1f3d9.com`, `Resolve-DnsName www.1f3d9.com`
  - Exit code: 0
  - Redacted result: live production site returned `200`; `api/official` returned production JSON; apex and `www` both resolved to `76.76.21.21`
  - Side effects: public read-only HTTP and DNS traffic only

- **EVD-007**
  - Time: 2026-08-15 18:06 America/Chicago
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Exact command: `Get-Content -Raw docs\runbooks\DEPLOYMENT.md`, `Get-Content -Raw docs\runbooks\BACKUP_RESTORE.md`, `Get-Content -Raw docs\runbooks\ENVIRONMENT.md`
  - Exit code: 0
  - Redacted result: runbooks claim GitHub-to-Vercel deploy, manual recovery evidence, and six ignored root env/provider-export files
  - Side effects: none

- **EVD-008**
  - Time: 2026-08-15 18:07 America/Chicago
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Exact command: `Test-Path .github`
  - Exit code: 0
  - Redacted result: repository contains no `.github` directory
  - Side effects: none

## Findings

### UNS-001: Backup and key-recovery scripts can hit the wrong database with no target proof

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Compare local/test/preview/live behavior by name and verify operational targets before touching production-like data.
- **Location:** [`scripts/backup.mjs:85`](C:/Users/Owner/Documents/1f3d9/scripts/backup.mjs:85), [`scripts/backup.mjs:168`](C:/Users/Owner/Documents/1f3d9/scripts/backup.mjs:168), [`scripts/restore-key.mjs:244`](C:/Users/Owner/Documents/1f3d9/scripts/restore-key.mjs:244), [`scripts/restore-key.mjs:247`](C:/Users/Owner/Documents/1f3d9/scripts/restore-key.mjs:247), [`scripts/restore-key.mjs:216`](C:/Users/Owner/Documents/1f3d9/scripts/restore-key.mjs:216), [`docs/runbooks/ENVIRONMENT.md:12`](C:/Users/Owner/Documents/1f3d9/docs/runbooks/ENVIRONMENT.md:12), [`docs/runbooks/ENVIRONMENT.md:23`](C:/Users/Owner/Documents/1f3d9/docs/runbooks/ENVIRONMENT.md:23)
- **User or business harm:** An operator can export the wrong database or rotate a resident secret in the wrong database, causing avoidable data exposure, broken recovery evidence, or resident lockout during an incident.
- **Evidence:** `resolveDatabaseUrl()` takes the first `DATABASE_URL` it finds from the process, `.env.local`, `.env.deploy`, or `env.txt`. `restoreKeyMain()` uses that value directly, then `restoreResidentKey()` executes `UPDATE residents SET secret_hash = ...`. The environment runbook explicitly says `env.txt` is legacy provider material and the root also contains inactive preview/production export artifacts.
- **Safe reproduction:** Static inspection only. Read `scripts/migrate.ts` beside these files: migrations prove exact Neon branch identity before mutating, but backup and restore-key do not.
- **Connection traced:** operator shell -> `node scripts/restore-key.mjs <handle> --confirm` -> `resolveDatabaseUrl()` -> arbitrary ignored local file/process env -> direct SQL `UPDATE residents` against whichever database URL won the fallback race.
- **Root cause:** Recovery tooling shares a convenience URL resolver meant for local operation, but it never proves project, branch, host, or environment identity before sensitive read/write work.
- **Connections and similar locations checked:** Checked `scripts/migrate.ts`, `src/db.ts`, `package.json`, `docs/runbooks/ENVIRONMENT.md`, and `docs/runbooks/DEPLOYMENT.md`. The stronger target-proofing exists only in migration tooling.
- **Durable fix:** Make backup and restore-key require an explicit target mode and apply the same proof pattern already used in `scripts/migrate.ts`: direct non-pooled URL validation, project/branch verification where applicable, and a fail-closed refusal when the target cannot be proven. Remove legacy fallback files from the resolver path after the verified source of truth is established.
- **Why this is not a band-aid:** It removes the ambiguous target-selection mechanism instead of adding more operator warnings around it.
- **Pre-fix proof:** Add failing behavior tests showing that backup and restore-key reject stale/legacy file-only inputs and reject URLs whose host or branch cannot be proven.
- **Verification:** Targeted tests for `resolveDatabaseUrl()` replacement, restore-key dry run and confirm paths, backup target selection, and a wider rerun of `test/deploy-safety.test.ts`, `test/operator-scripts.test.ts`, and migration target-verification tests.
- **Regression and rollback risk:** Tightening target selection can block emergency operator workflows until their environment is updated. Rollback should preserve the old script on a separate emergency branch only if the new gate is itself proven wrong.
- **Unknowns:** I could not inspect the live Vercel or Neon configuration, so I could not measure how often operators currently rely on these fallbacks.

### UNS-002: The repository-native JSON backup format cannot be restored by the repository

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Backups must have a practiced restore path, not just an export path.
- **Location:** [`scripts/backup.mjs:159`](C:/Users/Owner/Documents/1f3d9/scripts/backup.mjs:159), [`scripts/backup.mjs:190`](C:/Users/Owner/Documents/1f3d9/scripts/backup.mjs:190), [`docs/runbooks/BACKUP_RESTORE.md:29`](C:/Users/Owner/Documents/1f3d9/docs/runbooks/BACKUP_RESTORE.md:29), [`docs/runbooks/BACKUP_RESTORE.md:48`](C:/Users/Owner/Documents/1f3d9/docs/runbooks/BACKUP_RESTORE.md:48), [`docs/runbooks/BACKUP_RESTORE.md:105`](C:/Users/Owner/Documents/1f3d9/docs/runbooks/BACKUP_RESTORE.md:105)
- **User or business harm:** During an incident, the local export that the repo itself can produce cannot be used directly to restore service. That increases recovery time and manual error pressure exactly when operators need the simplest path.
- **Evidence:** `scripts/backup.mjs` creates a full JSON snapshot under `backups/`. The backup runbook explicitly states: “The JSON snapshot is currently an export and inspection layer; automated JSON restore is not implemented.” The same runbook’s “verified recovery evidence” section proves only structural readability for that JSON artifact, while real recovery evidence comes from Neon snapshots and an older PostgreSQL dump archive.
- **Safe reproduction:** Static inspection only. No restore was run because recovery actions are state changing by definition.
- **Connection traced:** operator shell -> `node scripts/backup.mjs` -> JSON snapshot written locally -> incident occurs -> repo offers no matching restore command for that format -> operator must switch to external/manual recovery paths.
- **Root cause:** Backup tooling was implemented as a one-way export layer without an in-repo import/rebuild path or a paired restore verification loop.
- **Connections and similar locations checked:** Checked `scripts/backup.mjs`, `scripts/restore-key.mjs`, `docs/runbooks/BACKUP_RESTORE.md`, and operator-script tests. No general restore script exists in the repo.
- **Durable fix:** Either implement a tested restore path for the JSON format and drill it, or demote the JSON artifact to clearly non-recovery diagnostics and rely only on a separately tested provider/database backup chain.
- **Why this is not a band-aid:** It aligns the backup artifact with an actual recovery path instead of keeping a recovery-looking artifact that cannot restore service.
- **Pre-fix proof:** Add a failing recovery test or documented disposable-environment drill that imports the JSON artifact and proves table counts, critical rows, and constraints match the source snapshot.
- **Verification:** Re-run the restore drill on disposable infrastructure using the chosen recovery path, verify counts/constraints, and rerun `test/operator-scripts.test.ts` plus any new restore tests.
- **Regression and rollback risk:** A new restore path can damage data if it is not fenced to disposable targets first. Rollback requires keeping the old snapshot/recovery process untouched until the new path is proven on throwaway infrastructure.
- **Unknowns:** The runbook references an “older PostgreSQL dump archive,” but that archive and its automation were intentionally not inspected here.

## Questions Needing Human Review

- **Q-001: Are production merges protected by any server-side required checks?**
  - Why it matters: The source tree contains no `.github` workflow directory, and the checked release gate is the local-only `scripts/deploy.sh --prepare` path. If GitHub allows merges to `main` without required remote checks, production deploy safety depends entirely on operator discipline.
  - Available evidence: [`scripts/deploy.sh:82`](C:/Users/Owner/Documents/1f3d9/scripts/deploy.sh:82), [`scripts/deploy.sh:94`](C:/Users/Owner/Documents/1f3d9/scripts/deploy.sh:94), [`docs/runbooks/DEPLOYMENT.md:15`](C:/Users/Owner/Documents/1f3d9/docs/runbooks/DEPLOYMENT.md:15), repo root `.github` absent.
  - Missing evidence: GitHub branch protection rules, required status checks, Vercel required-deployment settings.
  - Safest next check: Read GitHub branch protection and required-check configuration out of band; do not infer it from the repo.
  - Whether release should wait: No, if those remote controls already exist and are enforced; yes, if `main` can merge without them.

- **Q-002: What production alerting exists outside the repo?**
  - Why it matters: I found no in-repo health endpoint, tracing config, or Sentry/alerting integration, but provider-side alerts could still exist.
  - Available evidence: targeted source search found request logging and live responses, but no in-repo monitoring wiring.
  - Missing evidence: Vercel alarms, uptime checks, log drains, error tracker configuration, on-call routing.
  - Safest next check: Inspect provider dashboards and incident-routing documentation without changing state.
  - Whether release should wait: No for this audit’s current verdict, but the gap remains operationally important.

## Ordered Repair Plan

1. Contain active exposure or data-loss risk without destroying evidence.
   Reference: `UNS-001`, `UNS-002`
2. Add a failing behavior-level check.
   Reference: `UNS-001` target-proof tests for backup/restore-key; `UNS-002` restore-drill proof for the JSON path or explicit de-scoping proof.
3. Repair the shared root cause and all proven connected paths.
   Reference: `UNS-001` by removing ambiguous DB target selection from operator tooling.
4. Handle existing stored data or environment differences safely.
   Reference: `UNS-001` legacy root env/provider-export files and operator procedures.
5. Run targeted, connected, and whole-product regression checks.
   Reference: `UNS-001`, `UNS-002`; rerun deploy safety, operator-script, migration-target, Postgres integration, and E2E suites as relevant.
6. Release in reversible stages and monitor the specific failure signal.
   Reference: `UNS-001` operator refusal logs and dry-run behavior; `UNS-002` successful disposable restore evidence.
7. Run a new full `$unshittify` audit, cite this report, and use a fresh skeptic.
   Reference: all findings and questions.

## Verification and Release Gates

- Success conditions:
  - Backup and restore-key refuse unproven targets.
  - Recovery evidence proves the chosen local backup path can restore or is explicitly removed from recovery claims.
  - Production release gates are evidenced server-side, not only in a local shell script.
- Safe commands:
  - `node --test --experimental-strip-types test/deploy-safety.test.ts`
  - `node --test --experimental-strip-types test/operator-scripts.test.ts`
  - `node --test --experimental-strip-types test/runtime-db-url.test.ts`
  - `node --test --experimental-strip-types --experimental-test-module-mocks test/integration/engine-timer-postgres.test.ts`
  - `playwright test`
- Manual checks:
  - Disposable restore drill only; never restore into live branches during verification.
  - Confirm GitHub branch protection / required checks outside the repo.
  - Confirm production deployment SHA still matches `main` after release.
- Browsers/devices where relevant:
  - Chromium desktop for the current Playwright suite.
- Test data needed:
  - Disposable PostgreSQL or Neon target only.
  - Non-production resident fixture for any restore-key rehearsal.
- Forbidden live actions:
  - No production migrations, no production restore finalization, no production secret rotation, no real payment flows.
- Rollback conditions:
  - New operator gates block a known-good workflow without providing a correct explicit target path.
  - New restore tooling cannot prove equivalence on disposable infrastructure.
- Evidence required before release:
  - Passing targeted tests, disposable restore proof, and remote branch-protection evidence for `main`.

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

single-agent audit - independently unverified

- No fresh skeptic was available inside this audit turn.
- Because independent review was not completed, no E4 claims are made and the verdict is limited to checked areas only.
- Same-model limitation: findings may share blind spots around operational assumptions that require authenticated provider inspection.

## Honest Limitations

- This was a static-plus-read-only audit. It cannot prove live Neon branch wiring, GitHub branch protection, Vercel project settings, provider alarms, or secret correctness.
- I intentionally did not read `.env*`, `env.txt`, `.vercel/`, `backups/`, `.release-backups/`, or any audit report contents.
- I did not execute Docker-backed integration tests, Playwright, backup creation, restore-key rotation, migrations, or any provider-authenticated command.
- The repo is actively being edited by other auditors. I re-opened every cited file immediately before writing findings, but concurrent external-provider changes could still make some operational evidence stale.
- Generated areas present but not inspected: `node_modules/`, `.vercel/`, `test-results/`, `backups/`, `.release-backups/`.
- Command side effects from this audit were limited to public read-only HTTP/DNS traffic and filesystem reads; no intended project-generated output was created.
- Outside systems and platform-specific file permissions are not fully covered. This report found evidence of risk in the checked scope; it does not claim the unchecked scope is safe.
