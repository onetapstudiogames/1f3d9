# Unshittify Audit

- **Audit ID:** GPT-5-infra-2026-08-15
- **Project:** 1F3D9
- **Created:** 2026-08-15T18:33:00-05:00
- **Date:** 2026-08-15
- **Auditor:** GPT-5 Codex
- **Repository:** onetapstudiogames/1f3d9
- **Reviewed worktree:** C:\Users\Owner\Documents\1f3d9
- **Reviewed commit:** 7035d9db7f766792f56c7782f0c0636b94533e48 on codex/workspace-reconciliation
- **Public production main during the audit:** 09b1cb5b5054f4257cdd8c373cdd85659b4add60
- **Scope:** Infrastructure and operations: deploy, DNS, environment selection, CI/release controls, backup/recovery tooling, and the test harness
- **Mode:** Deep, read-only audit. No application or infrastructure code was changed.

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

The public site was healthy in the sampled checks, authoritative DNS answers agreed, TLS was valid, all available local test suites passed, and the sampled public preview used a different resident dataset from production. I found no evidence of an active outage, DNS split, leaked tracked environment file, or current preview-to-production data crossover.

The release path is still too dependent on a careful human. GitHub main was publicly reported as unprotected, had no Actions workflows or repository rulesets, and did not require the repository's test or migration checks before Vercel deployed it. Separately, the backup and key-recovery tools can choose a database from ambient shell state without proving which Neon target they reached. Those are the two high-severity findings.

Three medium risks make future mistakes harder to detect: previews are allowed to fall back to the generic database URL in one supported mode, the JSON backup is not a point-in-time snapshot, and the green coverage command omits integration/E2E coverage while reported branch coverage is below the project's 80% rule.

### Findings at a Glance

| ID | Severity | Evidence | Finding | Current observation |
|---|---|---|---|---|
| UNS-001 | HIGH | E3 | The deployed main commit has no enforced code-and-schema release gate | Public GitHub metadata showed main unprotected, zero workflows, zero rulesets |
| UNS-002 | HIGH | E3 | Recovery scripts trust an ambient database target | Synthetic proof selected an arbitrary DATABASE_URL without target validation |
| UNS-003 | MEDIUM | E3 | Preview database selection fails open when hosted sign-in is off | The sampled preview was isolated today; the unsafe fallback remains in code and tests |
| UNS-004 | MEDIUM | E3 | The JSON backup is not a coherent point-in-time snapshot | Tables are read sequentially without a transaction |
| UNS-005 | MEDIUM | E3 | Coverage can pass below policy and excludes separate Postgres/E2E suites | Command exited 0 at 74.54% branch coverage |

### Next 3 Actions

1. Protect main and require one release check on the exact commit Vercel will deploy. That check should include unit, type, Postgres, E2E, coverage, and schema-compatibility gates.
2. Make backup and key recovery require an explicit target and verify the expected Neon project, branch, and host before connecting.
3. Make every Vercel preview require its dedicated preview database URL, then add an isolated-dataset canary test.

## Audit Contract

- **Authority:** Inspection and report writing only. No deployment, DNS, provider setting, database, wallet, authentication, secret, or application-code mutation was authorized.
- **Truth policy:** Files under docs/ were treated as claims to compare with code, tests, public provider metadata, and safe runtime observations.
- **Production safety:** Public anonymous GET/HEAD requests, DNS queries, and TLS negotiation were allowed. Production writes, authenticated sessions, payments, migrations, backup execution, restore execution, and destructive fault injection were not.
- **Secret safety:** Secret-bearing local files were identified by filename and ignore status only. Their contents were not opened, printed, copied, or sent to a tool.
- **Audit isolation:** No other audit report was opened or used as evidence. Concurrent audit outputs were excluded from file inventory and substantive review.
- **Evidence levels:** E1 is a question or unverified claim; E2 is static evidence; E3 is static evidence plus a safe runtime or independent public check; E4 requires independent confirmation with a materially different method or reviewer. Findings are capped at E3 because all reviewers used the same model family and authenticated provider state was unavailable.
- **Mutation accounting:** Test commands could create normal ignored test output and temporary Docker containers. The E2E run updated ignored test-results metadata. The Postgres suite removed the six containers it created. Inspectors unexpectedly created same-audit draft reports and one untracked audit-backup.json; they were not used as evidence. This final report replaces only the same-audit target draft.

## Project and Connection Map

1. **Public request path:** Porkbun authoritative DNS servers answer 1f3d9.com and www.1f3d9.com with Vercel's 76.76.21.21 address. HTTPS terminates at Vercel, which runs the API adapter and application routes. Application data is stored in Postgres/Neon; payment verification also reaches Base and the configured payment services.
2. **Release path:** A developer runs scripts/deploy.sh on a pushed review branch. The helper runs local gates, then asks the developer to open and merge a pull request. Vercel deploys GitHub main. Database migrations are separate, explicitly named operator commands.
3. **Environment path:** Vercel variables enter runtimeDatabaseUrl() in src/db.ts. Production/development use DATABASE_URL. Preview prefers HOSTED_CHAT_PREVIEW_DATABASE_URL, but one feature-off path falls back to DATABASE_URL.
4. **Recovery path:** scripts/backup.mjs resolves a URL from the shell or ignored local files and reads all public tables. scripts/restore-key.mjs imports the same resolver, reads a resident, and can update its stored secret hash after --confirm.
5. **Test path:** Top-level Node tests cover most code with mocks; Docker-backed integration tests exercise real Postgres; Playwright exercises the browser/OAuth harness; typecheck is separate. The coverage command measures only the top-level Node-test glob.

## Coverage and Limits

| Area | Reviewed | Safe runtime evidence | Deliberate limit |
|---|---:|---|---|
| Repository/config inventory | 123 tracked non-audit files | Git status, tracked/ignored checks, targeted searches | Other audit reports not opened |
| Deployment and release scripts | Yes | Helper tests and public GitHub metadata | No merge, push, Vercel mutation, or production deploy |
| DNS, HTTP, and TLS | Yes | Four authoritative DNS checks, apex/www requests, certificate inspection | No registrar login or DNS change |
| Environment selection | Yes | Four focused unit tests and public preview/production comparison | No environment-file contents or provider-secret inspection |
| Backup and recovery | Yes | Synthetic resolver proof and static call-chain inspection | No real backup, key rotation, restore, or live DB connection |
| Unit/type checks | Yes | 401 tests passed; typecheck passed | No production traffic replay |
| Postgres integration | Yes | 33 tests passed using six temporary postgres:17-alpine containers | Local disposable database only |
| Browser/E2E | Yes | 12 Playwright tests passed | Harness is not the complete Vercel/Neon production stack |
| Coverage | Yes | 401 tests passed; 91.03% lines, 74.54% branches, 87.16% functions | Postgres and E2E runs are not included in that coverage result |
| Provider operations | Public metadata only | GitHub public API and public Vercel endpoints | No authenticated GitHub, Vercel, Neon, Porkbun, Circle, or Base console |

The public sample at 2026-08-15T23:32Z showed production with 130 residents and the reviewed preview with 82. The preview OAuth metadata endpoint returned 200. This is strong evidence that the sampled preview was isolated at that moment, not proof that every preview or future environment assignment is isolated.

## Evidence Ledger

| ID | Time (CDT, 2026-08-15) | Exact check or command | Result | Side effect / confidence impact |
|---|---|---|---|---|
| EVD-001 | 17:00-17:10 | Read the unshittify skill, audit checklist, report contract, and agent prompts | Scope and admission rules fixed before findings | Read-only |
| EVD-002 | 17:10-17:20 | rg --files; git ls-files; git status --short --branch; git rev-parse HEAD | 124 tracked files including one audit path; 123 tracked non-audit files; reviewed branch/SHA recorded | Read-only |
| EVD-003 | 17:20-18:25 | Targeted rg and numbered source reads across package.json, vercel.json, scripts/, src/db.ts, test/, e2e/, docs/runbooks/, and database migrations | Deployment, environment, recovery, and harness call paths traced | Read-only; docs treated as claims |
| EVD-004 | 17:25 | git check-ignore -v and git ls-files for .env*, .tmp-*, env.txt, .vercel, backups, release backups, and test-results | Secret-like/local artifacts were ignored and none of the named secret files were tracked | Contents were not opened |
| EVD-005 | 17:30 | npm test | 401/401 passed | Read-only except normal temporary test state |
| EVD-006 | 17:35 | npm run typecheck | Passed | Read-only |
| EVD-007 | 17:40 | npm run test:e2e | 12/12 passed | Updated ignored test-results/.last-run.json |
| EVD-008 | 17:45 | docker version; docker image inspect postgres:17-alpine | Docker available; required image already local | No image pull |
| EVD-009 | 17:46 | npm run test:postgres, followed by docker ps -a | 33/33 passed; six test containers cleaned up | Temporary local containers only |
| EVD-010 | 18:31 | npm run test:coverage | 401/401 passed; 91.03% lines, 74.54% branches, 87.16% functions; exit 0 | No configured threshold stopped the command |
| EVD-011 | 18:31 | Public GitHub REST GETs for repository, workflows, main branch, rulesets, main status, and main check-runs | main SHA 09b1cb5...; protected false; 0 workflows; 0 rulesets; Vercel status success; Socket Security check success | Public, read-only metadata |
| EVD-012 | 17:50 | Resolve-DnsName for apex/www NS, A, AAAA, SOA; direct queries to each authoritative server | Four Porkbun authorities agreed; apex/www A was 76.76.21.21 with TTL 600; no apex AAAA observed | Point-in-time public DNS sample |
| EVD-013 | 17:55 | Public HTTP HEAD/GET to apex, www, /api/official, and /api/residents?limit=1 | HTTP redirected to HTTPS; HTTPS returned 200; HSTS and nosniff present; production API healthy | Anonymous read-only requests |
| EVD-014 | 18:00 | TLS handshake/certificate inspection for 1f3d9.com | TLS 1.3 negotiated; Let's Encrypt certificate covered apex/www and was valid 2026-08-12 through 2026-11-10 | Point-in-time public check |
| EVD-015 | 18:31 | GET production and reviewed public preview /api/residents?limit=1, preview OAuth metadata, and preview /api/official | Totals 130 vs 82; latest IDs 131 vs 82; preview OAuth 200; preview official domain identified its hosted-chat preview alias | Anonymous read-only requests |
| EVD-016 | 18:31 | node --test --experimental-strip-types test/runtime-db-url.test.ts | 4/4 passed, including the intentional feature-off preview fallback | Read-only |
| EVD-017 | 18:31 | node --input-type=module -e using resolveDatabaseUrl() with a synthetic DATABASE_URL | Printed ambient.example.test, proving generic shell state wins without validation | No network or database connection |
| EVD-018 | 18:30 | rg for schema_migrations, migration_history, migration ledger, and migrations table across source/scripts/db/tests/package | No migration-ledger reference found | Static absence check; cannot rule out provider-side process |
| EVD-019 | 18:05-18:28 | Parallel deploy, CI, environment, DNS, and test-harness review passes | Candidates cross-checked across connections | Same model family; evidence level not raised above E3 |
| EVD-020 | 18:25-18:31 | Fresh adversarial skeptic pass | Upheld UNS-001, UNS-002, UNS-004, UNS-005; lowered UNS-003; rejected fixed-port candidate | Reviewer did not independently access authenticated provider state |
| EVD-021 | 18:32 | Final source/public-evidence refresh | High-risk evidence remained unchanged | Read-only |

Failed exploratory checks were retained as negative evidence, not silently converted into findings: the web opener refused direct GitHub API URLs, one first-pass response parser assumed the wrong public API envelope, Resolve-DnsName did not support the attempted CAA query form, and some Windows glob/regex probes returned no match or syntax errors. They had no external side effects. Equivalent successful checks are listed above.

## Findings

### UNS-001: The deployed main commit has no enforced code-and-schema release gate

**Severity:** HIGH

**Evidence level:** E3

**Status:** Confirmed

**Rule or parameter:** Every production commit must prove required application and schema checks on the exact immutable SHA before Vercel can deploy it. A local helper is not an enforcement boundary.

**Location:** scripts/deploy.sh:3-15 and 24-95; package.json:14-30; docs/runbooks/DEPLOYMENT.md:14-26; repository root (no .github directory); public GitHub settings for main

**User or business harm:** A direct push, an incorrectly merged pull request, or a commit changed after local testing can ship without unit, type, real-Postgres, browser, coverage, or schema-compatibility proof. Because this is a live economy, an application/schema mismatch could block residents, corrupt an operation, or require an emergency restore.

**Evidence:** The helper is thoughtfully fail-closed for its own invocation: it refuses main, checks that the branch is pushed and clean, runs npm test, npm run typecheck, npm run test:postgres, and npm run test:e2e, then rechecks the commit. It does not deploy. It tells the operator to merge into main, after which Vercel deploys. Public GitHub metadata refreshed at 2026-08-15T23:31:54Z reported main as protected=false, zero Actions workflows, and zero repository rulesets. The shipped SHA had a successful Vercel status and a successful Socket Security check, but no repository test gate. Migrations are separate named commands, and no source-controlled migration ledger or compatibility gate was found.

**Safe reproduction:** Read package.json and scripts/deploy.sh. Then issue anonymous GETs to:

- https://api.github.com/repos/onetapstudiogames/1f3d9/actions/workflows
- https://api.github.com/repos/onetapstudiogames/1f3d9/branches/main
- https://api.github.com/repos/onetapstudiogames/1f3d9/rulesets
- https://api.github.com/repos/onetapstudiogames/1f3d9/commits/main/status
- https://api.github.com/repos/onetapstudiogames/1f3d9/commits/main/check-runs

No write token is needed. Compare the returned required controls with the checks in scripts/deploy.sh.

**Connection traced:** Developer worktree -> pushed review branch -> local deploy helper -> pull request/main -> Vercel production deployment -> application startup/query assumptions -> separately operated Neon migrations.

**Root cause:** Release safety lives in a voluntary workstation script and prose runbook, while the actual deployment boundary is GitHub main. Code and schema readiness do not share one machine-enforced decision on the commit that ships.

**Connections and similar locations checked:** package scripts; deploy helper tests; Vercel configuration; migration selector and target-verification code; deployment and backup runbooks; public GitHub workflows, main protection, rulesets, status, and checks. The migration script itself has strong target acknowledgements and snapshot checks; the missing piece is release orchestration and enforcement.

**Durable fix:** Add a required GitHub workflow that runs unit tests, typecheck, disposable-Postgres integration tests, Playwright, coverage thresholds, migration-plan validation, and an application/schema compatibility test against an isolated preview database. Protect main with pull-request review, disallow direct pushes, require those checks on the head SHA, and make Vercel wait for them. Record applied migrations in the database with immutable IDs/checksums and have the release check compare expected versus applied state. Prefer backward-compatible expand/deploy/contract sequencing.

**Why this is not a band-aid:** Asking operators to remember scripts, adding another checklist, or trusting a green Vercel build does not bind evidence to the deployed SHA and does not prove database compatibility.

**Pre-fix proof:** Add a read-only policy test that queries the public/repository settings and fails unless main is protected and the exact required check names exist. Add a disposable preview test where the application expects a new column but the migration is absent; the release gate must fail before deployment. Both proofs fail under the audited controls.

**Verification:** A pull request cannot merge when any unit, type, Postgres, E2E, coverage, or schema check fails. A direct push to main is rejected. The Vercel deployment SHA exactly matches the checked GitHub SHA. The migration ledger reports expected checksums, and a rollback rehearsal demonstrates an application version compatible with both sides of each staged schema change.

**Regression and rollback risk:** Stricter gates can slow emergency changes or become flaky. Keep a documented, audited break-glass path; make tests deterministic; cache dependencies; and test rollback against backward-compatible schema states. Do not make bypass permission routine.

**Unknowns:** Authenticated organization policies, Vercel deployment protection, and private checks were not visible. Public metadata is conclusive for the repository controls it exposes, but an external deployment orchestrator could exist outside the repo.

### UNS-002: Backup and key recovery trust an ambient database target

**Severity:** HIGH

**Evidence level:** E3

**Status:** Confirmed

**Rule or parameter:** An operator command that reads all tables or mutates authentication state must require an explicit named target and verify the expected provider project, branch, and host before connection.

**Location:** scripts/backup.mjs:85-95 and 168-201; scripts/restore-key.mjs:20-41, 161-254; docs/runbooks/BACKUP_RESTORE.md:26-49

**User or business harm:** A stale shell variable or local file can make an operator back up the wrong database, believe production is protected when only preview was exported, or rotate a resident key in the wrong environment. During an incident, that wastes the recovery window and can lock out the wrong resident.

**Evidence:** resolveDatabaseUrl() accepts process.env.DATABASE_URL first, then the first DATABASE_URL found in .env.local, .env.deploy, or env.txt. It performs no target, hostname, project, branch, role, or database-name check. runBackup() immediately connects through that value and enumerates every public table. restore-key imports the same resolver, and --confirm can update residents.secret_hash. A synthetic, offline invocation passed DATABASE_URL=postgres://ambient.example.test/city and the resolver returned ambient.example.test successfully. The migration tool shows the stronger available pattern: explicit target, exact acknowledgement, direct endpoint checks, provider branch/project verification, and a production snapshot.

**Safe reproduction:** Run this offline resolver proof from the repository root:

    node --input-type=module -e "import { resolveDatabaseUrl } from './scripts/backup.mjs'; const chosen=resolveDatabaseUrl('C:/path-that-does-not-exist',{DATABASE_URL:'postgres://ambient.example.test/city'}); console.log(new URL(chosen).hostname)"

It prints ambient.example.test without opening a socket. Do not run backup or restore-key against a real URL for this proof.

**Connection traced:** Operator shell/ignored env files -> resolveDatabaseUrl() -> Postgres client -> information_schema and every public table for backup, or resident lookup -> secret_hash update for confirmed key recovery.

**Root cause:** A convenience resolver designed for local setup became the shared trust boundary for production-sensitive operator commands. The scripts confirm the action, but not the identity of the target.

**Connections and similar locations checked:** Backup command, key-recovery parser/dry-run/update path, local secret ignore rules, backup runbook, migration target verification, snapshot logic, and package migration commands. --confirm, dry-run by default, and compare-and-set behavior reduce accidental mutation but do not establish target identity.

**Durable fix:** Require --target preview or --target production and use dedicated variables for each. Resolve and compare the non-secret Neon project ID, branch ID, exact read-write endpoint hostname, database name, and role. Print a redacted target fingerprint, query an environment marker from the database, and require a typed acknowledgement that includes that fingerprint before any production mutation. Keep key recovery dry-run-first and atomic. Never let a generic DATABASE_URL silently select a remote recovery target.

**Why this is not a band-aid:** Reordering .env files, renaming one variable, or adding a warning still lets ambient state select the wrong system. --confirm only proves intent to rotate a key, not intent to touch this database.

**Pre-fix proof:** Add unit tests with fake connectors for: generic DATABASE_URL only; preview credentials while --target production is requested; production hostname with the wrong Neon branch ID; pooled/unknown endpoints; and a correct explicit target. All mismatches must fail before the connector is called. The current generic-variable case fails that desired contract.

**Verification:** Both scripts refuse to connect without --target. Their logs show only a non-secret expected/actual fingerprint. Wrong project, branch, host, database, or role stops before query execution. A disposable two-database drill proves backup and key recovery can affect only the named target. Production key recovery remains atomic and auditable.

**Regression and rollback risk:** Strict identification can reject legitimate endpoint changes, and provider API dependence can impair emergency recovery. Store stable expected IDs in reviewed non-secret configuration, support an audited offline fingerprint path, and retain the previous scripts only as versioned artifacts—not as an executable bypass.

**Unknowns:** The current contents, permissions, age, and target of ignored environment files were not inspected. No evidence shows an actual wrong-target incident. Neon may provide additional identity controls not visible in the repository.

### UNS-003: Preview database selection is fail-open in feature-off mode

**Severity:** MEDIUM

**Evidence level:** E3

**Status:** Confirmed

**Rule or parameter:** Every VERCEL_ENV=preview process must use an explicitly configured preview database or fail before serving, regardless of feature flags.

**Location:** src/db.ts:9-19; test/runtime-db-url.test.ts:38-49; Vercel preview environment configuration

**User or business harm:** A preview created without HOSTED_CHAT_PREVIEW_DATABASE_URL can silently use the generic DATABASE_URL while hosted sign-in is off. If that generic value is production, preview code and public preview traffic can read or write the live city. The result could include resident-data crossover or unreviewed behavior against production.

**Evidence:** runtimeDatabaseUrl() prefers HOSTED_CHAT_PREVIEW_DATABASE_URL. For preview plus HOSTED_CHAT_SIGNIN_ENABLED=true, it throws if the override is absent. For the supported feature-off case, it falls through to DATABASE_URL. The focused test explicitly expects that legacy fallback and passed. Counterevidence matters: the sampled public preview had OAuth enabled and returned 82 residents while production returned 130, with different latest IDs. It was isolated at 2026-08-15T23:32Z. This is a confirmed fail-open code path and drift risk, not proof of current exposure.

**Safe reproduction:** Run:

    node --test --experimental-strip-types test/runtime-db-url.test.ts

The test named “an ordinary preview uses the isolated override when present and otherwise keeps legacy behavior” demonstrates the fallback without a network connection. For a safe live comparison, issue anonymous, limit-one resident GETs to production and a known public preview and compare totals/IDs; do not write canaries to production.

**Connection traced:** Vercel preview variables -> runtimeDatabaseUrl() -> shared database client -> all API and MCP reads/writes that use Postgres.

**Root cause:** Preview isolation is conditional on an application feature flag instead of being an invariant of the deployment environment.

**Connections and similar locations checked:** Resolver implementation and focused tests; hosted-chat discovery/config; public production and preview resident endpoints; preview OAuth metadata; public GitHub/Vercel deployment association. Secret variable assignments were not inspected.

**Durable fix:** In VERCEL_ENV=preview, require a nonempty HOSTED_CHAT_PREVIEW_DATABASE_URL and reject DATABASE_URL fallback before the first query. Validate that the preview and production hosts/project/branch IDs differ. Provision the preview variable automatically and add a non-sensitive environment marker or isolated sentinel assertion to preview smoke tests.

**Why this is not a band-aid:** Keeping the feature flag on, checking one preview manually, or documenting the variable leaves future previews, rollbacks, and feature-off deployments exposed to configuration drift.

**Pre-fix proof:** Change the focused contract test so every preview without the override must throw, including hosted sign-in off. Add a fake-target test asserting preview and production fingerprints differ. The first test fails against the audited implementation.

**Verification:** All preview permutations without the dedicated URL fail at startup. Production and development ignore the preview override. A newly created preview automatically reaches only its isolated dataset, and the smoke check fails if its non-secret fingerprint matches production.

**Regression and rollback risk:** Preview creation will fail until provisioning is complete, and older previews may stop on redeploy. Inventory active previews first, add the variable through managed configuration, then enable fail-closed behavior. Roll back by restoring the prior application version only after confirming no preview can inherit production.

**Unknowns:** Authenticated Vercel variable scopes and all active preview deployments were not inspected. Only one current public preview was sampled.

### UNS-004: The JSON backup is not a coherent point-in-time snapshot

**Severity:** MEDIUM

**Evidence level:** E3

**Status:** Confirmed

**Rule or parameter:** Any artifact described or relied on as a database snapshot must represent one consistent database point, include integrity metadata, and have a tested restore path.

**Location:** scripts/backup.mjs:168-201; docs/runbooks/BACKUP_RESTORE.md:1-76

**User or business harm:** Residents can act while the script reads tables one by one. A transfer, agreement, offer, or key-related transaction committed between reads can leave mutually related tables from different moments. The export may look complete but be unsuitable for reliable recovery or forensic reconstruction.

**Evidence:** runBackup() queries information_schema.tables and then issues one SELECT * per table sequentially. No BEGIN, isolation level, exported snapshot, pg_dump, or provider snapshot binds those reads together. The runbook correctly limits this JSON artifact to export/inspection and says provider snapshots or pg_dump are the proven restore options; that honest boundary lowers severity. The script's shape still makes the filename/“full JSON snapshot” language easy to over-trust.

**Safe reproduction:** Use a mocked database in a unit test. Return related rows for table A, inject a simulated committed transfer before table B is read, then return the new table-B state. Assert that the current output combines two logical moments. Do not run a production backup merely to prove this.

**Connection traced:** Operator command -> table discovery -> sequential full-table reads -> local timestamped JSON file -> runbook inspection/recovery decision.

**Root cause:** A convenient diagnostic export and a disaster-recovery snapshot are not separated strongly enough in implementation and naming.

**Connections and similar locations checked:** Backup URL resolution, output-path handling, redaction/error handling, ignored backup directories, backup/restore runbook, migration production snapshots, and restore-key. No JSON import/restore implementation exists, which supports the runbook's limitation.

**Durable fix:** Rename and document the JSON output as a diagnostic export unless consistency is added. For a coherent logical artifact, use pg_dump with an appropriate snapshot or a read-only REPEATABLE READ transaction that covers all queries, plus a manifest containing schema version, source fingerprint, transaction/snapshot identity, row counts, checksums, start/end time, and tool version. Keep provider snapshots as the primary physical recovery control and schedule restore drills.

**Why this is not a band-aid:** Faster loops, timestamps, or row counts do not make separately committed reads atomic. A “completed successfully” message does not prove restorability.

**Pre-fix proof:** Add the mocked concurrent-write test above and a manifest/restore validation test. The coherence assertion fails with the current sequential query design.

**Verification:** The artifact is either explicitly labeled non-restorable diagnostic export, or a concurrency test proves one snapshot across tables. Checksums and schema identity validate. A disposable database restore drill completes, application invariants pass, and recovery-point/recovery-time measurements are recorded without using production writes.

**Regression and rollback risk:** A long database transaction can retain WAL and add load; serverless clients may not keep one session. Prefer pg_dump/provider-native snapshots for production, bound export duration, and cancel safely. Keep the diagnostic exporter separate if it remains useful.

**Unknowns:** Authenticated Neon snapshot schedule, retention, success alerts, and the runbook's claimed restore-drill evidence were not independently verified. No real backup artifact was opened.

### UNS-005: Coverage passes below policy and omits separate Postgres/E2E suites

**Severity:** MEDIUM

**Evidence level:** E3

**Status:** Confirmed

**Rule or parameter:** Coverage must fail below the project's 80% minimum and must account for the critical integration and browser paths it claims to protect.

**Location:** package.json:14-17; test/integration/; e2e/; src/oauth-store.ts; coverage command output

**User or business harm:** A green coverage command can approve a change while important database/authentication branches are unmeasured. This weakens the only local release evidence for regressions in sign-in, recovery, persistence, and other production paths.

**Evidence:** npm run test:coverage expands only test/*.test.ts. It passed 401 tests and exited 0 with 91.03% line, 74.54% branch, and 87.16% function coverage. The project rule is at least 80%; branch coverage is below it. src/oauth-store.ts reported 19.52% lines and 0% functions in this command. The real Postgres tests and Playwright tests exist and passed separately—33/33 and 12/12—but their execution/coverage is not merged into the green coverage result. No threshold flag or coverage service gate was found.

**Safe reproduction:** Run npm run test:coverage and inspect both the exit code and final all-files row. Then compare the script's test/*.test.ts glob with package.json's separate test:postgres and test:e2e commands. This is local and does not contact production.

**Connection traced:** package coverage script -> top-level Node test glob -> imported source only -> green exit code -> manual deploy helper/reviewer confidence. Separate Docker and browser suites do not feed the metric.

**Root cause:** Tests are divided sensibly by runtime, but coverage collection and enforcement were never made a release-level aggregate.

**Connections and similar locations checked:** All package test scripts, top-level tests, six integration test files, three Playwright specs plus harness, TypeScript configuration, deploy helper gates, and source-level coverage output. Existing suites are substantial; the finding concerns measurement and enforcement, not an assertion that the application is broadly untested.

**Durable fix:** Collect compatible coverage from unit and disposable-Postgres runs and report browser coverage for application code where meaningful. Merge artifacts before enforcing thresholds. Fail below 80% for lines, branches, and functions at the aggregate level, and set higher or explicit per-file expectations for critical authentication/recovery modules. Keep E2E assertions as required behavioral gates even where browser/server coverage cannot be merged cleanly.

**Why this is not a band-aid:** Raising the displayed percentage through exclusions, lowering the branch target, or adding shallow tests preserves the false green. Running suites separately without combining policy evidence still leaves the release decision ambiguous.

**Pre-fix proof:** Configure the existing coverage command to fail at 80% branch coverage without changing tests. It must exit nonzero at the current 74.54%. Add a critical-module assertion that fails for oauth-store.ts until its real persistence paths are counted and tested.

**Verification:** The aggregate job runs all required suites, produces auditable artifacts tied to one SHA, and fails below each 80% threshold. Critical modules meet their declared targets. A deliberately uncovered branch makes the job fail; restoring the test makes it pass.

**Regression and rollback risk:** Instrumentation can slow integration/E2E tests and produce misleading cross-process merges. Introduce thresholds in measured stages, preserve raw artifacts, and separate “not instrumentable” browser behavior from server coverage instead of excluding it silently.

**Unknowns:** A private coverage service or organization-level threshold may exist outside the repository. It was not visible in public checks on the deployed main SHA.

## Questions Needing Human Review

1. Do GitHub, Vercel, or an external service enforce private release checks that are not visible through the public repository API? If yes, show the required check names and a recent deployed SHA's evidence.
2. In Neon, are automated snapshots actually running at the documented schedule/retention, and is there a dated successful restore drill with measured recovery time and point?
3. Are Vercel/Neon error-rate, latency, saturation, failed-deploy, database-capacity, and backup-failure alerts configured with a human on-call destination? The repository mainly exposes console logging and manual log checks.
4. Are the ignored .env/.tmp production/preview artifacts still needed, protected by appropriate local ACLs, and known not to contain stale valid credentials? Review them locally without copying values into an audit or chat; rotate any credential whose handling is uncertain.

## Ordered Repair Plan

1. **Restrict the release boundary:** Protect main, require reviewed pull requests, prevent direct pushes, and make Vercel consume only checked commits.
2. **Add failing release checks:** Run unit, type, Postgres, E2E, security/dependency, coverage, and schema-plan checks on one SHA.
3. **Repair shared operational roots:** Add explicit verified target selection to backup/key recovery and unconditional preview isolation.
4. **Make schema/data state observable:** Add a checksummed migration ledger, non-secret environment fingerprints, coherent backup manifests, and provider snapshot evidence.
5. **Run targeted and full regression:** Prove wrong targets fail before connect, missing preview config fails at startup, concurrent backup behavior is coherent or clearly diagnostic-only, and coverage thresholds fail correctly.
6. **Stage and monitor:** Exercise a disposable preview/Neon branch, then ship controls in reversible stages with alerting and a documented break-glass path.
7. **Re-audit the shipped controls:** Query the deployed SHA's required checks, compare preview/production fingerprints, and observe a restore drill without exposing secrets.

## Verification and Release Gates

- GitHub main is protected; direct push is rejected; required checks are visible and tied to the exact Vercel deployment SHA.
- npm test, npm run typecheck, npm run test:postgres, and npm run test:e2e all pass in CI, not only on a developer workstation.
- Aggregate line, branch, and function coverage each meet or exceed 80%, with explicit critical-module expectations.
- Every Vercel preview without the dedicated preview database fails before serving; an isolated fingerprint/sentinel check proves preview and production differ.
- Backup and key-recovery commands reject missing, generic, mismatched, pooled, or wrong-branch targets before connection; a disposable two-database drill proves containment.
- A migration ledger/checksum check and application/schema compatibility test pass before deploy; rollback remains compatible with the staged schema.
- A coherent backup/restore drill passes integrity and application-invariant checks. No production write, payment, key rotation, or migration is used merely to test the gate.

## Overseer Record

**Independent skeptic:** COMPLETED

**Reviewer separation:** CONFIRMED

- Separate review passes covered deploy/operations, CI/release, environment configuration, DNS/live transport, and the test harness.
- The final fresh skeptic upheld the release-gate, recovery-target, backup-coherence, and coverage findings.
- The skeptic changed preview fallback from HIGH to MEDIUM because the sampled live preview was demonstrably isolated and the evidence proves a risky path, not a current production crossover.
- The skeptic rejected a fixed-default E2E-port candidate: E2E_PORT already provides an override, the normal suite passed, and one audit-time collision did not establish meaningful user or production harm.
- No finding was raised to E4. Reviewers used the same model family, and the skeptic did not inspect authenticated provider state.
- Inspectors were told not to write files but unexpectedly created draft audit outputs and audit-backup.json. Those drafts were not read as evidence. The primary auditor independently reopened source/public evidence and replaced only this audit's target report.

## Honest Limitations

- This audit did not log into GitHub organization settings, Vercel, Neon, Porkbun, Circle, a wallet, or any monitoring provider.
- It did not read secret-bearing environment files, backup contents, resident credentials, or other audit reports.
- It did not run production writes, real payments, key rotation, migrations, failover, restore, load, or destructive chaos tests.
- DNS, TLS, GitHub, production, and preview observations are point-in-time evidence from 2026-08-15 and can change after this report.
- The E2E harness imports production modules but is not the complete Vercel adapter, provider network, or production database. Passing local tests is not proof of production correctness.
- A same-model multi-agent process can share blind spots. Findings remain E3 even when the skeptic upheld them.
- The worktree contained concurrent untracked audit outputs. They were excluded. Normal ignored test metadata was updated, and an inspector created untracked audit-backup.json despite the read-only instruction; it was left untouched to avoid deleting another process's artifact.
- The requested report is the only intentional deliverable. No application, infrastructure, test, workflow, DNS, or environment code was changed.
