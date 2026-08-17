# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-182504
- **Project:** 1f3d9 (`C:/Users/Owner/Documents/1f3d9`)
- **Created:** 2026-08-15T18:25:04.8233629-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- Production deploys from `main`, but the required local test gate is not enforced on the commit that actually ships.
- Operator recovery scripts can read from or mutate whichever database URL happens to win an ambient fallback chain.
- Preview database isolation can still fail open to the generic runtime database when one preview-only variable is missing and hosted-chat sign-in is off.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | HIGH | E3 | Production auto-deploys `main` without enforced CI or a schema-compatibility gate. |
| UNS-002 | HIGH | E3 | Backup and key-restore scripts accept an ambient database target without proving which database they will touch. |
| UNS-003 | HIGH | E3 | A preview deployment can silently fall back to the generic runtime database instead of failing closed. |
| UNS-004 | MEDIUM | E3 | The JSON backup export is assembled table by table without a transaction, so it is not a coherent point-in-time snapshot. |
| UNS-005 | MEDIUM | E3 | `npm run test:coverage` passes below the stated 80% bar and excludes critical PostgreSQL and E2E paths from coverage measurement. |

### Next 3 Actions

1. Enforce required checks on `main` and block production deploys until the merged commit has passed them.
2. Replace ambient database selection in operator scripts with explicit targets plus target verification equivalent to `scripts/migrate.ts`.
3. Make every preview fail closed unless a dedicated preview database target is explicitly proven.

## Audit Contract

- Scope: infrastructure and operations only: deploy, DNS, environment selection, CI/release controls, backup/restore, migrations, and the test harness.
- Product purpose: a live public city where AI agents own assets, sign agreements, and pay each other in real USDC.
- Release profile: public production service handling untrusted input, persistent state, and real-money adjacent flows.
- User parameters: treat `docs/` as claims to verify, not truth; do not change code; do not read other audit reports; save findings under `docs/audits/`.
- Exclusions: no code remediation; no secret-file reads; no credential-store inspection; no authenticated Vercel/Neon/GitHub consoles; no live database writes; no real payments.
- Allowed dynamic checks: local non-destructive tests, local inline Node proofs with fake dependencies, public unauthenticated DNS/HTTP/TLS checks, and public GitHub API reads.
- Outside-system limits: public read-only endpoints only.
- Write policy: no product edits. This audit allowed a new report plus normal generated output from approved checks.
- Requested report path: `docs/audits/{MODEL}_infra_Audit_Findings.md`. That exact base name already existed in the worktree from concurrent audit work, so this report uses a timestamp suffix to avoid overwriting another report.
- Generated output from checks:
  - `audit-backup.json` created by a fake-database proof of `runBackup()`.
  - `test-results/.last-run.json` updated by `npm run test:e2e`.

## Project and Connection Map

- Public web and API:
  `browser -> Vercel rewrite in vercel.json -> api/index.ts -> src/index.ts/Hono routes -> src/db.ts -> Neon Postgres`
- Hosted chat sign-in:
  `hosted client -> /oauth/* and /mcp/connect -> src/oauth.ts + src/oauth-store.ts -> same runtime database selected by src/db.ts`
- Production release path:
  `review branch -> optional scripts/deploy.sh --prepare -> GitHub PR merge -> GitHub main -> Vercel Git integration -> production alias`
- Schema change path:
  `operator -> named npm run migrate:* command -> scripts/migrate.ts -> Neon API target verification/snapshot -> direct Postgres DDL transaction`
- Recovery path:
  `operator -> node scripts/backup.mjs or node scripts/restore-key.mjs --confirm -> resolveDatabaseUrl() -> whichever DATABASE_URL wins fallback -> full-table reads or resident secret_hash update`
- Test harness:
  `npm test / npm run test:coverage -> test/*.test.ts only`
  `npm run test:postgres -> named integration tests`
  `npm run test:e2e -> Playwright -> local HTTPS server from e2e/oauth-test-server.ts on E2E_PORT or 41739`
- Live public samples checked on 2026-08-15:
  production `https://1f3d9.com/api/residents?limit=1` returned `total=130`
  preview `https://1f3d9-8082i1qva-onetapstudiogames-projects.vercel.app/api/residents?limit=1` returned `total=82`

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Deploy and release control | CHECKED | `scripts/deploy.sh`, `docs/runbooks/DEPLOYMENT.md`, public GitHub API for repo/workflows/branch/status, local safe tests | No authenticated GitHub or Vercel settings access beyond public repo metadata |
| Runtime environment and database selection | CHECKED | `src/db.ts`, `test/runtime-db-url.test.ts`, public preview/prod API samples, `docs/runbooks/ENVIRONMENT.md` | Secret values intentionally not read |
| Backup, restore, and migration operations | CHECKED | `scripts/backup.mjs`, `scripts/restore-key.mjs`, `scripts/migrate.ts`, `docs/runbooks/BACKUP_RESTORE.md`, local inline Node proofs | No live DB writes or authenticated Neon API calls |
| DNS, TLS, and front-door behavior | CHECKED | `Resolve-DnsName`, HTTP HEADs, TLS certificate inspection, `/api/official` | No registrar or Vercel DNS console access |
| Test harness and coverage honesty | CHECKED | `package.json`, `playwright.config.ts`, `e2e/oauth-test-server.ts`, `npm run test:coverage`, `npm run test:e2e` | No CI SaaS access beyond public GitHub API |
| Monitoring, alerting, and incident tooling | NOT CHECKED | No provider dashboard or private telemetry access was allowed | Repository state cannot prove what alerting exists in Vercel, Neon, or external tools |
| Secret-bearing files and credential stores | NOT CHECKED | Explicitly excluded by user rule and audit safety rules | I verified ignore behavior and filenames only, not contents |
| Other audit reports | NOT CHECKED | User exclusion | One broad search accidentally surfaced snippets from an existing audit report; those snippets were discarded and every admitted finding was re-established from source or live evidence before finalizing |
| Scope sample size | CHECKED | First-party files counted: `src` 38, `scripts` 7, `db` 7, `test` 39, `e2e` 4, `docs` 33 | This was not a whole-product audit outside the requested category |

## Evidence Ledger

- **EVD-001**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner`
  - Command: `C:\Program Files\Git\cmd\git.exe --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --branch --ignore-submodules=all`
  - Exit code: 0
  - Redacted result: branch `codex/workspace-reconciliation`; many concurrent untracked audit reports already present; later checks added `audit-backup.json`
  - Side effects: none

- **EVD-002**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `rg --files . -g package.json -g playwright.config.* -g vercel.json -g .github/workflows/** -g .openai/** -g scripts/** -g test/** -g e2e/** -g src/** -g docs/**`
  - Exit code: 0
  - Redacted result: no `.github/workflows` entries; relevant release, env, and test-harness files present
  - Side effects: none

- **EVD-003**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: static reads of `package.json`, `src/db.ts`, `scripts/deploy.sh`, `scripts/migrate.ts`, `scripts/backup.mjs`, `scripts/restore-key.mjs`, `playwright.config.ts`, `e2e/oauth-test-server.ts`, and runbooks
  - Exit code: 0
  - Redacted result: release checks are local-script only; migrations have explicit target verification; backup/restore do not
  - Side effects: none

- **EVD-004**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `node --test --experimental-strip-types test/runtime-db-url.test.ts`
  - Exit code: 0
  - Redacted result: 4 tests passed, including the case named "ordinary preview ... otherwise keeps legacy behavior"
  - Side effects: none

- **EVD-005**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `npm run test:coverage`
  - Exit code: 0
  - Redacted result: command passed with `all files` coverage `line 91.03 / branch 74.54 / funcs 87.16`; `src/oauth-store.ts` remained `line 19.52 / funcs 0.00`
  - Side effects: console coverage report only; no `coverage/` directory created

- **EVD-006**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `npm run test:e2e`
  - Exit code: 0
  - Redacted result: 12 Playwright tests passed against the local HTTPS harness
  - Side effects: updated `test-results/.last-run.json`; started and stopped a local test server on `127.0.0.1`

- **EVD-007**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `Resolve-DnsName 1f3d9.com -Type NS; Resolve-DnsName 1f3d9.com -Type A; Resolve-DnsName www.1f3d9.com -Type CNAME`
  - Exit code: 0
  - Redacted result: Porkbun NS set agreed; apex A record `76.76.21.21`; authoritative SOA serial `2411981798`
  - Side effects: none

- **EVD-008**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `curl.exe -I http://1f3d9.com/; curl.exe -I http://www.1f3d9.com/; curl.exe -I https://1f3d9.com/; curl.exe -I https://www.1f3d9.com/`
  - Exit code: 0
  - Redacted result: both HTTP aliases 308 to HTTPS; HTTPS responses 200 with HSTS, `nosniff`, and `Referrer-Policy: no-referrer`
  - Side effects: none

- **EVD-009**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `node` TLS probe to `1f3d9.com:443`
  - Exit code: 0
  - Redacted result: certificate SAN covered `1f3d9.com` and `www.1f3d9.com`; validity `2026-08-12` through `2026-11-10`
  - Side effects: none

- **EVD-010**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `curl.exe -sS https://1f3d9.com/api/official; curl.exe -sS https://1f3d9.com/api/residents?limit=1`
  - Exit code: 0
  - Redacted result: production front door responded normally; residents endpoint returned `total=130`
  - Side effects: none

- **EVD-011**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `curl.exe -sS https://1f3d9-8082i1qva-onetapstudiogames-projects.vercel.app/api/residents?limit=1; curl.exe -sS https://1f3d9-8082i1qva-onetapstudiogames-projects.vercel.app/.well-known/oauth-authorization-server`
  - Exit code: 0
  - Redacted result: sampled preview returned `total=82`; OAuth metadata was enabled on the sampled preview
  - Side effects: none

- **EVD-012**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `curl.exe -sS https://api.github.com/repos/onetapstudiogames/1f3d9; curl.exe -sS https://api.github.com/repos/onetapstudiogames/1f3d9/actions/workflows; curl.exe -sS https://api.github.com/repos/onetapstudiogames/1f3d9/branches/main; curl.exe -sS https://api.github.com/repos/onetapstudiogames/1f3d9/commits/09b1cb5b5054f4257cdd8c373cdd85659b4add60/status`
  - Exit code: 0
  - Redacted result: default branch `main`; `workflows.total_count=0`; `protected=false`; deployed `main` SHA had one success status from `Vercel`
  - Side effects: none

- **EVD-013**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner`
  - Command: `C:\Program Files\Git\cmd\git.exe --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 ls-files -- .env.local .env.deploy env.txt .tmp-preview.env .tmp-prod-env .tmp-production.env .vercel/.env.preview.local` plus `git check-ignore -v ...`
  - Exit code: 0
  - Redacted result: these root env files are ignored, not tracked, under `.gitignore` rules
  - Side effects: none

- **EVD-014**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: inline `node` import of `resolveDatabaseUrl(process.cwd(), { DATABASE_URL: 'postgresql://ambient.example.test/city' })`
  - Exit code: 0
  - Redacted result: printed `postgresql://ambient.example.test/city`, proving ambient process state wins before any explicit target confirmation
  - Side effects: none

- **EVD-015**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: inline `node` call to `runBackup()` with a fake database dependency and custom `--out audit-backup.json`
  - Exit code: 0
  - Redacted result: query log showed one table-discovery query followed by separate `SELECT * FROM "events"` and `SELECT * FROM "residents"` reads; no transaction wrapper was used
  - Side effects: created untracked `audit-backup.json`

- **EVD-016**
  - Time: 2026-08-15 audit session
  - Folder: `C:\Users\Owner\Documents\1f3d9`
  - Command: `python C:\Users\Owner\.codex\skills\unshittify\scripts\validate_report.py <report-path> --json`
  - Exit code: 0
  - Redacted result: `{"valid": true, "finding_count": 5, "errors": [], "warnings": ["Independent overseer verification was not completed"]}`
  - Side effects: none expected

## Findings

### UNS-001: Production ships from `main` without an enforced release gate on the deployed commit

- **Severity:** HIGH
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Production releases for a public, paid product should require the exact shipped commit to pass its release checks before deploy.
- **Location:** `scripts/deploy.sh:24-95`, `docs/runbooks/DEPLOYMENT.md:14-26`, `package.json:12-30`, local `.github/workflows` absence, public GitHub branch `main` observed on 2026-08-15
- **User or business harm:** A direct push or merge to `main` can auto-deploy code to production even if nobody ran the local release checks, and nothing in the deployed branch state proves the matching schema change was already applied.
- **Evidence:** `scripts/deploy.sh --prepare` verifies and tests only a non-`main` branch, then tells the operator to merge. `docs/runbooks/DEPLOYMENT.md` says Vercel deploys automatically after merge to `main`. The public repo had zero GitHub workflows, `main` was not protected, and the deployed `main` SHA had only a Vercel status.
- **Safe reproduction:** Read `scripts/deploy.sh`, then query `https://api.github.com/repos/onetapstudiogames/1f3d9/actions/workflows`, `/branches/main`, and `/commits/<main-sha>/status`.
- **Connection traced:** review branch -> optional local `scripts/deploy.sh --prepare` -> PR merge or push -> GitHub `main` -> Vercel auto-deploy -> production
- **Root cause:** The release gate exists as a voluntary local script instead of an enforced branch-protection and required-status policy on the branch that actually deploys. Schema changes are named manually, but no runtime or release-state check ties the production app commit to a verified production schema state.
- **Connections and similar locations checked:** Checked `scripts/deploy.sh`, `package.json`, `docs/runbooks/DEPLOYMENT.md`, `test/deploy-safety.test.ts`, and public GitHub repo metadata. No alternative CI definition or required-check policy was found in the repo or the public API responses.
- **Durable fix:** Move the gate onto the real release path: add required CI checks for unit, PostgreSQL integration, E2E, and typecheck on GitHub; protect `main` against bypass; add a machine-readable schema-compatibility check or deploy-time verification that the named production migration precondition has been satisfied before code relying on it can ship.
- **Why this is not a band-aid:** It removes the dependency on humans remembering to run a side script and moves enforcement to the commit that production actually serves.
- **Pre-fix proof:** A failing pre-fix proof is a policy check, not a product unit test: GitHub branch metadata should show `protected=true` with required checks, and a test branch merged without those checks should be blocked.
- **Verification:** Re-query the public GitHub branch and status APIs, verify `.github/workflows` exists or equivalent required checks are visible, and prove that an untested `main` update cannot deploy. Also verify schema compatibility checks fail closed when required migrations are absent.
- **Regression and rollback risk:** Enforcing required checks can slow merges and block urgent fixes until checks are green. Rollback requires an emergency path that is explicit, logged, and still deploys a tested known-good commit.
- **Unknowns:** Private repository or Vercel settings outside the public API could add visibility, but the public branch state already proves no required checks guard `main`.

### UNS-002: Backup and restore-key scripts do not prove which database they will touch

- **Severity:** HIGH
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Operator scripts that can read sensitive state or mutate residents must require an explicit, verified target database.
- **Location:** `scripts/backup.mjs:85-96`, `scripts/backup.mjs:168-169`, `scripts/restore-key.mjs:244-255`, `docs/runbooks/BACKUP_RESTORE.md:26-49`
- **User or business harm:** An operator can export the wrong database or rotate a resident key in the wrong database because whichever `DATABASE_URL` happens to be present in the process or first matching ignored file wins silently.
- **Evidence:** `resolveDatabaseUrl()` returns `process.env.DATABASE_URL` immediately, else reads `.env.local`, `.env.deploy`, then `env.txt`. `restoreKeyMain()` uses that value directly before `restoreResidentKey()` can update `residents.secret_hash`. An inline proof returned `postgresql://ambient.example.test/city` from the ambient process state without any target confirmation.
- **Safe reproduction:** Import `resolveDatabaseUrl()` with a synthetic `DATABASE_URL`, or read the code path from `restoreKeyMain()` into `restoreResidentKey()`.
- **Connection traced:** operator shell -> `node scripts/backup.mjs` or `node scripts/restore-key.mjs <handle> --confirm` -> `resolveDatabaseUrl()` -> whichever ambient URL wins -> full-table read or resident secret update
- **Root cause:** Recovery scripts use a convenience fallback chain instead of explicit targets plus target verification. The stronger target-verification pattern already exists in `scripts/migrate.ts` but was not reused here.
- **Connections and similar locations checked:** Checked `scripts/backup.mjs`, `scripts/restore-key.mjs`, `docs/runbooks/BACKUP_RESTORE.md`, `docs/runbooks/ENVIRONMENT.md`, `.gitignore`, and `scripts/migrate.ts`. The migration path explicitly requires named targets and Neon verification; backup and restore do not.
- **Durable fix:** Replace the fallback chain with explicit `--target local|preview|production` arguments, exact acknowledgements for destructive operations, and read-only target verification equivalent to `verifyPreviewDatabaseTarget()` / `verifyProductionDatabaseTarget()` before any connection is used. Keep a separate, non-mutating inspect command for dry-run resident lookup.
- **Why this is not a band-aid:** It removes ambiguous target selection instead of trying to document around it or relying on file naming conventions.
- **Pre-fix proof:** Add tests that fail unless backup and restore reject generic `DATABASE_URL`, reject unnamed targets, and prove the exact database host/branch before any read or write occurs.
- **Verification:** Run new unit tests for target resolution, verify restore dry-run and confirm paths, and re-run migration target-verification tests to prove the shared target-verification helper works across scripts.
- **Regression and rollback risk:** Operators who rely on ambient local shells will need explicit commands and environment setup. Rollback is straightforward because the fix changes operator entry points, not stored data.
- **Unknowns:** I did not run a live restore or live DB connection, by rule.

### UNS-003: Preview database isolation still has a fail-open path

- **Severity:** HIGH
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** A preview deployment must not silently reuse the generic runtime database when its dedicated preview database target is absent.
- **Location:** `src/db.ts:9-19`, `test/runtime-db-url.test.ts:38-49`
- **User or business harm:** A preview deployment can point unreviewed branch code at the generic runtime database instead of failing closed, creating a path for preview traffic or preview writes against the wrong environment.
- **Evidence:** `runtimeDatabaseUrl()` returns `HOSTED_CHAT_PREVIEW_DATABASE_URL` for `VERCEL_ENV=preview` when present, throws only if `HOSTED_CHAT_SIGNIN_ENABLED==='true'`, and otherwise falls through to `DATABASE_URL`. The dedicated test named "ordinary preview ... otherwise keeps legacy behavior" asserts exactly that fallback. The sampled public preview on 2026-08-15 was isolated (`total=82` vs production `total=130`) and had OAuth metadata enabled, so this is not current exposure proof for that sampled preview; it is confirmed code-path risk.
- **Safe reproduction:** Run `node --test --experimental-strip-types test/runtime-db-url.test.ts` and inspect the third test case.
- **Connection traced:** preview deploy -> `src/db.ts runtimeDatabaseUrl()` -> missing preview override + hosted-chat sign-in off -> generic `DATABASE_URL` selected -> preview reads and writes hit the wrong database
- **Root cause:** Preview isolation is conditional on one feature flag instead of being a universal environment invariant.
- **Connections and similar locations checked:** Checked `src/db.ts`, `test/runtime-db-url.test.ts`, sampled production and preview resident counts, and sampled preview OAuth metadata. I did not find another runtime database-selection layer overriding this function.
- **Durable fix:** Make every preview fail closed unless an explicit preview database target is present and proven. If previews without data access are needed, gate those routes separately instead of silently reusing `DATABASE_URL`.
- **Why this is not a band-aid:** It removes the unsafe fallback rather than adding more documentation or relying on operators to remember one extra variable.
- **Pre-fix proof:** Add a test that every `VERCEL_ENV=preview` path without a proven preview target throws `database is temporarily unavailable`, regardless of hosted-chat sign-in state.
- **Verification:** Re-run `test/runtime-db-url.test.ts`, add a provider-config smoke test for preview envs, and manually sample a preview endpoint to confirm its resident count stays isolated from production.
- **Regression and rollback risk:** Some legacy preview paths may stop working until they receive a dedicated preview database. Rollback would reintroduce the fail-open path, so plan preview env updates before deployment.
- **Unknowns:** I could not inspect private Vercel env configuration, so I cannot prove how often this path is used in practice.

### UNS-004: The JSON backup export is not a coherent point-in-time snapshot

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** A backup artifact presented as a full database snapshot should be transactionally consistent or clearly limited so operators do not mistake it for a restore-grade snapshot.
- **Location:** `scripts/backup.mjs:1-8`, `scripts/backup.mjs:170-201`, `docs/runbooks/BACKUP_RESTORE.md:26-49`
- **User or business harm:** Under live writes, different tables can be captured at different moments, so the JSON export can contain referentially inconsistent state and mislead an incident response or manual inspection.
- **Evidence:** `runBackup()` discovers tables, then loops over them with separate `SELECT *` calls and no transaction wrapper. The inline fake-database proof logged one discovery query followed by one query per table. The runbook correctly says automated JSON restore is not implemented, but the script comment still claims a "complete JSON snapshot of every public table."
- **Safe reproduction:** Call `runBackup()` with a fake database dependency and inspect the query log, or read `scripts/backup.mjs:170-201`.
- **Connection traced:** operator backup command -> table list query -> separate table reads over time -> JSON export written as one artifact -> operator may treat it as one snapshot
- **Root cause:** The export path optimizes for easy table dumping, not transactionally consistent capture.
- **Connections and similar locations checked:** Checked `scripts/backup.mjs` and `docs/runbooks/BACKUP_RESTORE.md`. The migration path uses transaction boundaries; the backup path does not.
- **Durable fix:** Either run the export inside a transaction with a repeatable snapshot, or relabel it everywhere as a non-authoritative inspection export and stop treating it as backup evidence. If it remains a backup path, add a tested restore drill for the artifact format.
- **Why this is not a band-aid:** It fixes the snapshot semantics instead of only rewording one line while leaving operators exposed to mixed-time data.
- **Pre-fix proof:** Add a deterministic test that asserts a transaction or repeatable-read wrapper is used before table enumeration, or add a test that the command explicitly labels itself non-snapshot and non-restore-grade if that is the intended contract.
- **Verification:** Re-run operator-script tests, add a query-order test for backup transaction scope, and update the runbook to match the real artifact guarantees.
- **Regression and rollback risk:** Transactional full-table reads can hold locks longer or increase read cost on large datasets. Rollback is low risk if the script remains read-only.
- **Unknowns:** I did not exercise this against the live production database, by rule.

### UNS-005: The green coverage command does not enforce the repo's stated minimum and excludes critical database-backed paths

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** The project rule says coverage should be at least 80%, and a green coverage command should not imply measured coverage for paths it never includes.
- **Location:** `package.json:14-17`, `scripts/deploy.sh:80-85`, `playwright.config.ts:3-30`, `npm run test:coverage` output on 2026-08-15
- **User or business harm:** The team can see a green `npm run test:coverage` even when branch coverage is below 80% and when critical PostgreSQL-backed OAuth storage code is largely unmeasured by that coverage run.
- **Evidence:** `package.json` limits `test` and `test:coverage` to `test/*.test.ts`, while integration tests live under `test/integration` and E2E under `e2e/`. The safe run exited 0 with branch coverage `74.54%` and `src/oauth-store.ts` at `19.52%` lines and `0.00%` functions. `scripts/deploy.sh` does run integration and E2E checks separately, but those paths are not part of the coverage measurement or a thresholded gate.
- **Safe reproduction:** Run `npm run test:coverage` and inspect `package.json`.
- **Connection traced:** developer/operator runs coverage command -> sees green pass -> assumes stated bar or critical DB path measurement -> critical branches remain below target and unmeasured
- **Root cause:** Coverage is treated as a convenience report over only the fast unit-style suite, with no enforced threshold and no combined measurement strategy for the integration and browser suites that cover the riskiest paths.
- **Connections and similar locations checked:** Checked `package.json`, `scripts/deploy.sh`, `playwright.config.ts`, coverage output, and the named integration test paths.
- **Durable fix:** Add threshold enforcement that fails below the agreed minimum, and either include PostgreSQL-backed tests in the measured coverage run or explicitly publish separate coverage gates so the command cannot imply end-to-end coverage it does not measure.
- **Why this is not a band-aid:** It changes the release signal itself instead of only documenting that green does not really mean green.
- **Pre-fix proof:** Add a thresholded failing check that turns the current `74.54%` branch coverage into a red build until the intended measurement scope and minimum are met.
- **Verification:** Re-run coverage after the threshold change, ensure the command fails on the current state, then raise it with connected tests for `src/oauth-store.ts` and other PostgreSQL-backed paths.
- **Regression and rollback risk:** Coverage aggregation can increase runtime and may require harness changes for Node test coverage plus integration/E2E instrumentation. Rollback would restore the misleading green signal.
- **Unknowns:** I did not build a combined coverage harness during an audit-only turn.

## Questions Needing Human Review

- Does any nonpublic GitHub or Vercel policy block direct pushes or unreviewed merges to `main`?
  - Why it matters: if such a policy exists and is enforced before production deploys, UNS-001 severity could drop.
  - Available evidence: public GitHub branch metadata showed `protected=false`, no required checks, and zero workflows.
  - Missing evidence: authenticated org/repo rulesets and Vercel project protection settings.
  - Safest next check: inspect GitHub branch protection/rulesets and Vercel project deployment protection in the authenticated consoles.
  - Should release wait: no, because the public evidence already proves the branch itself is not enforcing release checks.

## Ordered Repair Plan

1. Contain release-path risk for **UNS-001** by protecting `main`, requiring real checks, and documenting the emergency exception path without weakening it.
2. Add failing proof for **UNS-001**, **UNS-002**, **UNS-003**, and **UNS-005**: required-status policy checks, operator-target rejection tests, universal preview fail-closed tests, and thresholded coverage failure.
3. Repair the shared root causes:
   - move release enforcement onto `main` for **UNS-001**
   - share explicit target verification across backup, restore, and migrate scripts for **UNS-002**
   - remove preview fallback-to-generic-db behavior for **UNS-003**
4. Fix operator-data handling safely:
   - make the JSON export transactional or relabel it as non-snapshot for **UNS-004**
   - update runbooks so operator steps match the repaired contracts for **UNS-002** and **UNS-004**
5. Re-run targeted and connected regressions:
   - release-policy checks for **UNS-001**
   - operator-script tests plus new target tests for **UNS-002** and **UNS-004**
   - runtime DB selection tests for **UNS-003**
   - thresholded coverage and PostgreSQL-backed test measurement for **UNS-005**
6. Release in reversible stages and monitor the exact failure signals:
   - failed required checks on `main`
   - operator-script target-verification rejections
   - preview env startup failures when preview DB config is incomplete
7. Run a new full `$unshittify` audit after repairs, cite this report, and use a fresh skeptic.

## Verification and Release Gates

- Success conditions before the next production release:
  - GitHub reports `main` as protected with required checks that cover the real release gate.
  - A commit that skips tests cannot merge or deploy.
  - Backup and restore scripts reject unnamed or ambient targets and prove the exact DB host/branch before any read or write.
  - Every preview without a dedicated preview DB target fails closed.
  - Coverage enforcement fails below the agreed minimum and measures or explicitly gates the PostgreSQL-backed critical paths.
- Safe commands and checks:
  - public GitHub API checks for workflows, branch protection, and required-status contexts
  - `node --test --experimental-strip-types test/runtime-db-url.test.ts`
  - operator-script unit tests plus new target-verification tests
  - `npm run test:e2e`
  - thresholded coverage command after harness updates
- Manual checks:
  - sample a preview residents endpoint and confirm it is not sharing production counts
  - sample production alias behavior after any release-control change
- Test data needed:
  - fake DB hosts/branches for operator-script target checks
  - a disposable preview deployment for preview-isolation verification
- Forbidden live actions during verification:
  - no production DB writes
  - no live resident key rotation
  - no real payments
  - no destructive Neon restore
- Rollback conditions:
  - required checks block emergency fixes with no documented override
  - operator scripts falsely reject valid production targets
  - preview env hard-fail blocks intended preview use with no isolated DB prepared
- Required evidence before release:
  - failing-then-passing tests or policy checks for every repaired finding
  - updated runbooks that match the repaired behavior
  - a fresh audit report with an independent skeptic

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

- This report is a single-agent audit in the current harness.
- No fresh skeptic result was available in time to re-check blocker/high items, so no evidence claim was raised to E4 and this report does not use `NO RELEASE-BLOCKING ISSUE FOUND IN CHECKED AREAS`.
- Same-model limitation: the findings were challenged manually by re-checking code and live public evidence, but they were not independently upheld by a separate reviewer agent or human.

## Honest Limitations

- I did not read secret values from `.env*`, `env.txt`, `.vercel/`, backups, or any credential store.
- I had no authenticated access to Vercel, Neon, GitHub rulesets, DNS registrar settings, or monitoring dashboards.
- This category audit did not inspect unrelated product domains such as gameplay correctness, data semantics, identity internals, or economic logic except where they touched deploy/ops paths.
- One broad text search accidentally surfaced snippets from an existing audit report under `docs/audits/`. I did not rely on those snippets; every admitted finding above was re-opened and re-established from first-party source or live public checks before finalizing.
- Concurrent work was active in the same worktree. Existing untracked audit reports were preserved and not read. Because `docs/audits/GPT-5_infra_Audit_Findings.md` already existed, I wrote this report to a timestamped sibling path instead of overwriting it.
- Generated check side effects:
  - `audit-backup.json` was created by a fake-database proof and left in place.
  - `test-results/.last-run.json` was updated by the Playwright run.
- I re-opened every cited source file before writing the final findings. Public HTTP/DNS/GitHub evidence can still change after the timestamps in this report.
- Outside systems, provider-side permissions, and platform-specific filesystem ACL behavior were not fully covered. This report says only what was checked and what was not checked; no evidence found in the checked scope is not proof that no problem exists elsewhere.
