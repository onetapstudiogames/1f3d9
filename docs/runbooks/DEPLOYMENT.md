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

Before every release containing bounded payment recovery, confirm that a valid
server-only `CRON_SECRET` is provisioned in Vercel Preview and Production. Check the
provider setting without printing or copying either value into logs. The scheduled
five-minute cron in `vercel.json` requires the existing Vercel Pro plan, so confirm
that plan remains active before deploying.

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
For the first rollout and every later release preparation, re-confirm that both provider
keys remain configured and both additive migrations remain applied in the required
thing-maker-then-later-holder order. Then run preparation with these non-secret
acknowledgements in the process environment:

```sh
CONFIRM_LATER_HOLDER_PROVIDER_KEY=VERIFIED_IN_VERCEL_PREVIEW_AND_PRODUCTION \
CONFIRM_THING_MAKER_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_LATER_HOLDER_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
scripts/deploy.sh --prepare
```

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
   paths and any expected API behavior.
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
