# Deployment runbook

Production is deployed from the GitHub repository
[`onetapstudiogames/1f3d9`](https://github.com/onetapstudiogames/1f3d9).
The linked Vercel project is `1f3d9`, and its production branch is `main`.
Vercel's Git integration builds and deploys the exact commit merged into that
branch.

Do not run `vercel --prod` from a local folder. A folder upload can bypass the
reviewed Git commit and make production impossible to reproduce from `main`.

## Release a change

### Payment-recovery prerequisite

Before every release containing bounded payment recovery or the Gazette printer, confirm that a valid
server-only `CRON_SECRET` is provisioned in Vercel Preview and Production. Check the
provider setting without printing or copying either value into logs. The scheduled
five-minute cron for recovery and Monday 16:00 UTC Gazette cron in `vercel.json` require the
existing Vercel Pro plan, so confirm that plan remains active before deploying.

### Later-holder prerequisite

Before the first application rollout containing deliberate later-holder discovery,
complete these one-time setup steps:

1. Provision the server-only `LATER_HOLDER_CURSOR_KEY` in both Vercel Preview and
   Production. Verify each value is exactly 64 lowercase hexadecimal characters without
   printing or copying it into logs.
2. Apply `npm run migrate:preview:thing-maker` to the isolated Preview database and
   verify the maker backfill, foreign key, `NOT NULL` column, insert trigger, and history
   trigger. Only then apply `npm run migrate:preview:later-holder-marks` and verify its
   table, constraints, index, and lifecycle triggers.
3. Take a separate required Production snapshot for each migration. Apply
   `npm run migrate:production:thing-maker`, verify its maker postconditions, and only
   then apply `npm run migrate:production:later-holder-marks` and verify its
   postconditions before merging the application.
4. Exercise the signed notice and index in Preview. A missing or malformed cursor key
   must return the documented no-store 503 rather than accepting an unusable index.

### Resumable-registration prerequisite

Before the first application rollout that records a join's client path, apply
`npm run migrate:preview:resumable-registration` to the isolated Preview database.
Verify that `pending_resident_registrations.client_class` exists, the
`pending_resident_registrations_client_class_valid` constraint is validated, and an
old staged row resumes with generic outside-client custody guidance. Then take the
required Production snapshot, apply
`npm run migrate:production:resumable-registration`, and verify the same postconditions
before merging the application. The migration remains a separate operator action; the
application rollout does not apply it.

### PayPal credit-dispute prerequisite

Before the first application rollout that handles verified PayPal dispute webhooks,
apply the guarded additive migration to the isolated Preview database:

```sh
CONFIRM_PAYPAL_CREDIT_DISPUTES=INSTALL_PAYPAL_CREDIT_DISPUTE_CUSTODY \
CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW \
npm run migrate:preview:paypal-credit-disputes
```

Verify the dispute tables, frozen-gift constraints, append-only receipts, and operator
notes there. Then take the required Production snapshot and apply the same reviewed
migration to Production:

```sh
CONFIRM_PAYPAL_CREDIT_DISPUTES=INSTALL_PAYPAL_CREDIT_DISPUTE_CUSTODY \
CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
npm run migrate:production:paypal-credit-disputes
```

Verify the same postconditions before merging the application. The application rollout
does not apply this migration.

### Resident refusal-state prerequisite

Before the first application rollout that varies repeated rule-refusal wording, apply
`npm run migrate:preview:resident-refusal-state` to the isolated Preview database. Verify
that one private row keyed by resident ID stores only the covered HTTP status, a
64-character method/path/status/cause fingerprint, a count from 1 through 10, and its
update time. Then take the required
Production snapshot, apply `npm run migrate:production:resident-refusal-state`, and verify
the same postconditions before merging the application. The application rollout does not
apply this migration.

### Drawing-contract and world-root drawing prerequisite

Before the first application rollout containing public drawing states, history,
or named kind variants, apply the two drawing migrations to Production in this
exact order. The application rollout never applies either migration.

1. In an operator shell, provision `NEON_API_KEY`, `NEON_PROJECT_ID`,
   `NEON_PRODUCTION_BRANCH_ID`, and `PRODUCTION_DATABASE_URL_UNPOOLED` without
   printing their values. Choose a fresh `PRODUCTION_SNAPSHOT_NAME` for each production drawing command.
2. Apply the drawing contract first. The runner verifies the exact production
   branch and direct database target, then creates and verifies the named Neon
   snapshot before starting the transactional migration:

   ```sh
   CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
   PRODUCTION_SNAPSHOT_NAME=<fresh-drawing-contract-snapshot-name> \
   npm run migrate:production:drawing-contract
   ```

3. Before continuing, verify that `drawing_revisions` exists, its
   `drawing_revisions_append_only` trigger is enabled, and the validated
   constraints are named `residents_drawing_contract`,
   `places_drawing_contract`, `kind_revisions_drawing_contract`, and
   `things_drawing_contract`. Also verify that a typed thing which previously
   stored direct legacy pixels has one legacy history row and is normalized to
   `drawing_state = 'undrawn'` with no direct drawing.

   If `city_snapshot.public_records_v2` exists, it predates this drawing
   migration and must now read the new drawing-aware v1 rather than the renamed
   pre-contract base. Run this read-only definition check; every returned
   boolean must be `true`:

   ```sql
   WITH definitions AS (
     SELECT
       pg_get_viewdef('city_snapshot.public_records'::regclass, TRUE) AS v1,
       pg_get_viewdef(to_regclass('city_snapshot.public_records_v2'), TRUE) AS v2
     WHERE to_regclass('city_snapshot.public_records_v2') IS NOT NULL
   )
   SELECT
     position('city_snapshot.public_records base_record' IN v2) > 0
       AS v2_reads_drawing_aware_v1,
     position('public_records_without_drawing_contract' IN v2) = 0
       AS v2_avoids_pre_contract_v1,
     position('resident_edited' IN v2) > 0 AS v2_allows_resident_edited,
     position('drawing_revisions' IN v1) > 0 AS v2_can_export_drawing_revisions,
     position('drawing_state' IN v1) > 0 AS v2_can_export_current_drawings,
     position('gazette_issues' IN v2) > 0 AS v2_keeps_gazette_issues,
     position('gazette_issue_entries' IN v2) > 0 AS v2_keeps_gazette_issue_entries,
     position('{detail,error}' IN v2) > 0 AS v2_redacts_event_errors
   FROM definitions;
   ```

   No row is correct only when Gazette is not installed. When a row is
   returned, all eight values must be `true`; otherwise block the rollout.
   Then run the read-only grant check:

   ```sql
   WITH views AS (
     SELECT to_regclass('city_snapshot.public_records_v2') AS v2
   ), grants AS (
     SELECT v2,
       has_table_privilege(
         'city_snapshot_export',
         to_regclass('city_snapshot.public_records'),
         'SELECT'
       ) AS v1_select,
       coalesce(has_table_privilege(
         'city_snapshot_export', v2, 'SELECT'
       ), FALSE) AS v2_select
     FROM views
   )
   SELECT CASE
       WHEN v2 IS NULL THEN 'no_gazette'
       WHEN v1_select THEN 'dormant'
       ELSE 'activated'
     END AS gazette_phase,
     v1_select,
     v2_select
   FROM grants;
   ```

   The only valid rows are `no_gazette | true | false`,
   `dormant | true | true`, or `activated | false | true`. Confirm that the
   reported dormant/activated phase matches the room #454 submission state.
   Any other grant combination blocks the application rollout.
4. Choose a second fresh snapshot name, then apply the guarded world-root
   drawing only after step 3 passes:

   ```sh
   CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
   PRODUCTION_SNAPSHOT_NAME=<fresh-world-root-drawing-snapshot-name> \
   npm run migrate:production:world-root-drawing
   ```

5. Before merging the application, verify exactly one `place_kind = 'world'`
   row carries the founder drawing, `places_world_shape` and
   `places_world_drawing_exact` are validated, and the
   `places_protect_topology_write` trigger is enabled. Record both snapshot
   names and the successful read-only postcondition checks with the release
   evidence; never record a database URL or credential.

Only after both Production migrations ran in that order and every documented
drawing, Gazette grant, and world-root postcondition check above was recorded,
set this exact non-secret release-preparation acknowledgement:

```sh
CONFIRM_PRODUCTION_DRAWING_RELEASE=DRAWING_CONTRACT_THEN_WORLD_ROOT_DRAWING_APPLIED_WITH_DOCUMENTED_DRAWING_GAZETTE_WORLD_POSTCONDITIONS_RECORDED
```

This is an operator attestation to separately recorded evidence. The
`--prepare` script does not query Production and the value by itself does not
prove a database postcondition.

Each file is one transaction, so a failed command commits none of that
command. If the drawing-contract command commits and the world-root command
fails, the drawing contract remains applied: block the application rollout,
diagnose the second command, and use a reviewed forward repair or the verified
snapshot recovery path. Application rollback does not revert database changes.
A destructive down migration is not an incident-time action.

### Gazette two-phase prerequisite

The first Gazette rollout has two separate database changes. The `gazette` migration
installs a dormant archive, quota trigger, printer ledger, and snapshot projection. It
does not open room #454. The `gazette-room-activation` migration opens that room only
after the target site proves it is serving the exact Gazette-capable commit named by the
operator and the local activation source is that same clean Git commit. This local proof
applies only to activation; the dormant `gazette` migration is unchanged. Neither
migration runs as part of application deployment.

1. Apply the dormant schema to the isolated Preview database:

   ```sh
   CONFIRM_GAZETTE=INSTALL_GAZETTE_ARCHIVE_AND_SUBMISSION_LIMIT \
   CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW \
   npm run migrate:preview:gazette
   ```

   Verify the cycle function, three-submission trigger, protected two-state room lifecycle,
   immutable issue and membership tables, and restricted snapshot-v2 view. During this dormant phase the export role
   must retain `SELECT` on snapshot v1 for the still-deployed exporter and also gain
   `SELECT` on v2. Room #454 must still be the exact closed founder shell, contain zero
   notes, and have no Gazette opening `place_edited` event.
2. Take the required Production snapshot and install the same dormant schema in
   Production:

   ```sh
   CONFIRM_GAZETTE=INSTALL_GAZETTE_ARCHIVE_AND_SUBMISSION_LIMIT \
   CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
   npm run migrate:production:gazette
   ```

   Verify the same dual-view schema postconditions. Production room #454 must remain
   the exact protected closed shell, contain zero notes, and have no Gazette opening event.
3. Push the candidate commit and wait for its Vercel Preview deployment. While room #454
   remains closed in both databases, run the acknowledgement-prefixed release preparation
   command in the next section. Record its explicit `GATE_EXIT=0` line.
4. Before opening the pull request, request `GET /api/official` from the exact Preview
   origin. Its `deployment_commit` must equal the exact PR head commit. Also verify
   `GET /api/gazette` reports `submission_room.submissions_open: false` and a new
   submission is refused without creating a note, consuming quota, or emitting an event.
   Activation refuses any room #454 that already contains a note; verify the zero-note
   precondition directly before running it.
   Then run the guarded Preview activation with that same commit and origin:

   ```sh
   CONFIRM_GAZETTE_ROOM_ACTIVATION=OPEN_GAZETTE_ROOM_AFTER_MATCHING_APP_DEPLOYMENT \
   GAZETTE_PREVIEW_ORIGIN=https://1f3d9-a1b2c3d4e-onetapstudiogames-projects.vercel.app \
   GAZETTE_DEPLOYMENT_COMMIT=<40-lowercase-hex-preview-commit> \
   CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW \
   npm run migrate:preview:gazette-room-activation
   ```

   Replace the sample nine-character lowercase alphanumeric deployment ID with the
   immutable hostname Vercel assigned to this deployment of the exact `1f3d9` project.
   Branch aliases, extra project-name segments, and another project's `vercel.app`
   hostname are refused. Run activation from a clean checkout of the candidate commit:
   tracked and untracked changes are both refused. Before any live request or database
   work, the migrator checks that cleanliness, resolves the full local Git `HEAD`, and
   requires it to equal `GAZETTE_DEPLOYMENT_COMMIT`. It then proves the deployed commit,
   proves the Preview database target, then proves the deployed commit again immediately before activation DDL.
   Any refusal leaves room #454 closed. The successful activation
   transaction also revokes snapshot
   v1 from the export role while preserving v2 access. After activation, verify that
   privilege cutover, verify room #454 is the exact protected notes-only open state and the archive reports submissions open, make one real Preview submission, and make one
   authorized printer call. Confirm the resulting permanent archive membership. Repeat
   the printer call and confirm it adds nothing. An unauthorized printer call must also
   add no issue, membership, or event.
5. The activation is transactionally safe to rerun with the same target and exact-commit
   guards: it leaves the open room unchanged and preserves exactly one Gazette opening event.
   Rerun only after rechecking all target identity inputs; a Production rerun also needs a
   fresh verified snapshot name.
6. Open the Gazette pull request only after the Preview evidence above is recorded. Keep
   Production room #454 closed while the pull request is open. Do not run the Production
   activation command for a branch or Preview deployment.
7. After a human merges the pull request and Vercel deploys that exact `main` commit,
   request Production `GET /api/official`. Its `deployment_commit` must equal the exact
   merged commit now serving at `https://1f3d9.com`. The guarded command proves that
   the local checkout is clean and its full Git `HEAD` equals that commit before any live
   request or database work. It then proves the live commit, verifies the Production
   database target and creates the required fresh snapshot, proves the same live commit
   again, and only then starts activation DDL:

   ```sh
   CONFIRM_GAZETTE_ROOM_ACTIVATION=OPEN_GAZETTE_ROOM_AFTER_MATCHING_APP_DEPLOYMENT \
   GAZETTE_DEPLOYMENT_COMMIT=<40-lowercase-hex-production-commit> \
   CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
   npm run migrate:production:gazette-room-activation
   ```

   Verify Production now reports submissions open and the export role can read v2 but not
   v1. Record one deliberate real submission
   intended to remain in the permanent archive, authorized printer and archive evidence,
   a harmless authorized retry, and an unauthorized call that changes nothing. Record
   the exact deployed commit and returned public state without recording any secret.

Once either database has room #454 open, it must not roll back below the Gazette-capable
application that enforces the room gate, quota, archive, and printer contract. Correct a
bad rollout with a forward Gazette-capable deployment; do not place an older application
in front of the open room.

### Gazette withdrawal two-phase prerequisite

Gazette withdrawal is another two-phase database change. The
`gazette-withdrawal` migration installs the ledger, guards, command exclusion, and
public projection while leaving `submission_room.withdrawals_open: false`. It must be
installed before the withdrawal-capable application can roll out. The separate
`gazette-withdrawal-activation` migration changes the protected room contract and opens
withdrawals only after the exact withdrawal-capable commit is live. Neither migration
runs as part of application deployment.

The current Preview database lacks the Gazette base schema, so Gazette routes there
return the already-recorded 500 response. That is expected and is not part of this
withdrawal rollout. Do not install the base Gazette feature or treat the Preview 500 as
withdrawal verification in this change. Prove the complete dormant-to-active upgrade in
the real PostgreSQL Gazette suite instead. The Preview commands below are retained for a
future isolated Preview branch that has the base Gazette schema.

1. On a Preview database that has the base Gazette schema, install the dormant migration:

   ```sh
   CONFIRM_GAZETTE_WITHDRAWAL=INSTALL_DORMANT_GAZETTE_WITHDRAWAL_LEDGER \
   CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW \
   npm run migrate:preview:gazette-withdrawal
   ```

   Verify ordinary submissions and printing still work, the withdrawal ledger is empty,
   the protected room retains its pre-withdrawal contract, and `GET /api/gazette` reports
   `submission_room.withdrawals_open: false`. A withdrawal command must be refused without
   creating a note, event, ledger row, or quota change.
2. After that exact candidate is serving from its immutable Preview origin, use
   exact-commit proof through `GET /api/official`, then activate with the same clean local
   commit:

   ```sh
   CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION=OPEN_GAZETTE_WITHDRAWALS_AFTER_MATCHING_APP_DEPLOYMENT \
   GAZETTE_PREVIEW_ORIGIN=https://1f3d9-a1b2c3d4e-onetapstudiogames-projects.vercel.app \
   GAZETTE_DEPLOYMENT_COMMIT=<40-lowercase-hex-preview-commit> \
   CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW \
   npm run migrate:preview:gazette-withdrawal-activation
   ```

   The migrator proves the clean local commit, exact deployment, isolated database target,
   and exact deployment again immediately before activation DDL. Afterward,
   `submission_room.withdrawals_open` must be `true`. Record one authorized withdrawal,
   its exclusion from source commands, its one-line printed notice, and refusal of a
   different author without recording a bearer secret.
3. Before merging the application change, take the required Production snapshot and
   install only the dormant migration from the reviewed clean candidate:

   ```sh
   CONFIRM_GAZETTE_WITHDRAWAL=INSTALL_DORMANT_GAZETTE_WITHDRAWAL_LEDGER \
   CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
   npm run migrate:production:gazette-withdrawal
   ```

   Record the snapshot ID and the same dormant postconditions. Production submissions
   and printing must remain live, withdrawals must remain closed, and the ledger must
   remain empty. After the staged real-PostgreSQL suite passes, set this non-secret
   release-preparation acknowledgement:

   ```sh
   CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION=APPLIED_TO_PRODUCTION_WITH_WITHDRAWALS_CLOSED_AND_REAL_POSTGRES_PROVEN
   ```
4. Merge only after the dormant Production state and release gates are recorded. Wait for
   Vercel to serve the exact merged `main` commit, verify it through Production
   `GET /api/official`, choose a fresh Production snapshot name, and activate:

   ```sh
   CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION=OPEN_GAZETTE_WITHDRAWALS_AFTER_MATCHING_APP_DEPLOYMENT \
   GAZETTE_DEPLOYMENT_COMMIT=<40-lowercase-hex-production-commit> \
   CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
   npm run migrate:production:gazette-withdrawal-activation
   ```

   Verify `submission_room.withdrawals_open: true`, one authorized withdrawal and printed
   notice, every caller-worded refusal, and the scheduled `live-probe` workflow. The
   activation is transactionally safe to rerun after rechecking the target and using a
   fresh Production snapshot name. Once active, do not roll back below a
   withdrawal-capable application; repair with a forward deployment.

For the first rollout and every later release preparation, re-confirm that the required
provider keys remain configured, the maker and later-holder migrations remain applied in
that order, and the resumable-registration, PayPal credit-disputes, resident refusal-state,
and dormant Gazette schema migrations remain applied. For the first Gazette rollout, run
this while room #454 is still closed in both databases. Then run preparation with these
non-secret acknowledgements in the process environment:

```sh
CONFIRM_LATER_HOLDER_PROVIDER_KEY=VERIFIED_IN_VERCEL_PREVIEW_AND_PRODUCTION \
CONFIRM_THING_MAKER_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_LATER_HOLDER_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_RESUMABLE_REGISTRATION_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_GAZETTE_SCHEMA_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION_WITH_ROOM_CLOSED \
CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION=APPLIED_TO_PRODUCTION_WITH_WITHDRAWALS_CLOSED_AND_REAL_POSTGRES_PROVEN \
CONFIRM_PRODUCTION_DRAWING_RELEASE=DRAWING_CONTRACT_THEN_WORLD_ROOT_DRAWING_APPLIED_WITH_DOCUMENTED_DRAWING_GAZETTE_WORLD_POSTCONDITIONS_RECORDED \
scripts/deploy.sh --prepare
```

The Gazette acknowledgement records the historical safe installation state. After
activation, it does not claim that room #454 is still closed. The separate withdrawal
acknowledgement records that its Production schema was installed while withdrawals were
still closed and that the staged upgrade passed against real PostgreSQL; it never claims
the known schema-less Preview is Gazette-capable or authorizes activation.

These acknowledgements contain no key material. The preparation script never reads an
environment file, queries or changes Vercel, or applies a migration; it only blocks the
release gates until the operator confirms those separate prerequisites.

1. Put the change on a review branch, push it, and leave the worktree clean.
2. Run the acknowledgement-prefixed `scripts/deploy.sh --prepare` command above. This is
   a read-only release check: it
   proves the branch is pushed at the tested commit and runs the test,
   type-check, PostgreSQL integration, and browser suites. It does not upload or
   deploy anything.
3. Open a pull request and check its Vercel preview, including the changed user
   paths and any expected API behavior. The first Gazette rollout must complete its
   exact-commit Preview activation and probes above before this step.
4. Merge the reviewed pull request into `main`. Vercel then deploys that exact
   GitHub commit.

Database migrations are separate operations. Run only the explicitly named
`npm run migrate:*` command appropriate to the migration and environment. A
deployment must never apply a migration as a side effect.

### When a migration times out

Normal migrations run inside one transaction that the runner starts with
`SET LOCAL lock_timeout = '5s'` and `SET LOCAL statement_timeout = '120s'`
(a migration file may override either with its own `SET LOCAL`). A timeout
aborts that whole transaction, so nothing partial commits: the database is
exactly as it was before the command.

The explicitly named concurrent-index migrations are the exception. They use the same
limits at session level because PostgreSQL cannot build a concurrent index inside one
transaction. The guarded runner checks every reviewed definition, keeps a valid index,
and removes and retries only an invalid index left by an interrupted build. If one of
these commands fails, inspect the named index state before one deliberate retry; do not
assume the whole file rolled back.

If the command fails with `lock_not_available` (SQLSTATE `55P03`), something
was holding a lock on a table the migration needs — usually ordinary city
traffic or another operator session. If it fails with
`canceling statement due to statement timeout` (SQLSTATE `57014`), one
statement did more work than expected.

Diagnose before rerunning; do not retry in a loop:

1. In the Neon console, check `pg_stat_activity` for long-running queries and
   who holds locks on the named table.
2. For a lock wait, rerun the same named `migrate:*` command once the holder
   is gone or during a quieter moment.
3. For a statement timeout, measure the data volume the statement touches. For
   a normal transactional migration, the file may set its own explicit
   `SET LOCAL statement_timeout` with a reviewed justification. A concurrent-index
   file cannot use `SET LOCAL` and cannot add unreviewed SQL; change its guarded
   session limit in the runner with matching tests and review before retrying.

## Verify production

1. Record the full GitHub `main` SHA:

   ```sh
   git ls-remote origin refs/heads/main
   ```

2. In Vercel, open the current Production deployment and confirm that it is
   `READY`, belongs to project `1f3d9`, and shows that same source commit.
   `vercel inspect <production-deployment-url>` can provide the same deployment
   metadata when the CLI is authenticated.
3. Open the production aliases, including `https://1f3d9.com`, and exercise the
   release's critical path. Check logs for new errors.
4. If a migration was run, verify its named postconditions separately. Do not
   infer database success from a green website deployment.

Evidence recorded on 2026-08-15: the production deployment was `READY`, and its
source SHA matched GitHub `main` at
`09b1cb5b5054f4257cdd8c373cdd85659b4add60`.

## Roll back

1. Decide whether the failure is application-only or also involves a database
   migration. Vercel rollback does not undo database changes.
2. For the durable Git rollback, revert the bad commit on a review branch, run
   the release checks, review its preview, and merge the revert into `main`.
3. For an urgent application-only incident, use Vercel's project UI or
   `vercel rollback <known-good-deployment-url>` to restore a previously verified
   `READY` deployment. Then make the matching Git revert so `main` and
   production converge again.
4. Re-run the production verification checklist and record the deployed SHA. If
   the database changed, follow the separately reviewed recovery plan; never
   improvise a destructive migration during an incident.

Never paste or commit Vercel tokens, deployment credentials, database URLs, or
environment-file contents.
