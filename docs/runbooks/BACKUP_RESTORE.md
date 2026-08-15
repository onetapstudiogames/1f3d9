# Backup and restore runbook

The production database is Neon PostgreSQL 17:

- project: `neon-cyclamen-school` (`bold-union-44728141`)
- main branch: `br-lively-sunset-avksnwos`
- point-in-time history: 6 hours
- automatic snapshots: daily at 08:00 UTC, retained for 14 days

Four permanent manual snapshots also existed on 2026-08-15. Permanent snapshots
are useful release anchors, but they do not replace the recurring schedule.

## Check backups

Run these checks at least monthly and before a risky production migration:

```sh
neon snapshots schedule get --project-id bold-union-44728141 --branch br-lively-sunset-avksnwos
neon snapshots list --project-id bold-union-44728141
```

Confirm that the schedule still says daily at 08:00 UTC with 14-day retention,
that recent snapshots exist, and that the oldest required recovery point has not
expired. Create a named permanent snapshot before a high-risk release.

For an additional local export, run:

```sh
node scripts/backup.mjs
```

The script reads `DATABASE_URL` from the process or an ignored local environment
file, discovers every public base table, and writes a full JSON snapshot under
the ignored `backups/` directory. Use `--out <path>` to choose the destination or
`--keep <positive-number>` to change the default retention of 30 local snapshots.
Review the reported table and row counts after every run.

The JSON snapshot is currently an export and inspection layer; automated JSON
restore is not implemented. Provider snapshots and PostgreSQL dump archives are
the proven restore paths.

## Run a safe Neon restore drill

Use a snapshot that is safe to inspect. A drill must restore to a temporary,
unfinalized branch; it must not replace `main`.

1. List the snapshots and copy the chosen snapshot ID:

   ```sh
   neon snapshots list --project-id bold-union-44728141
   ```

2. Restore it to a clearly named temporary branch. Do not add `--finalize`:

   ```sh
   neon snapshots restore <snapshot-id> --project-id bold-union-44728141 --name restore-drill-YYYYMMDD
   ```

3. Connect without printing or copying the URL:

   ```sh
   neon connection-string restore-drill-YYYYMMDD --project-id bold-union-44728141 --psql
   ```

4. In `psql`, verify table count, critical row counts, and constraints:

   ```sql
   SELECT count(*) AS public_tables
   FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

   SELECT (SELECT count(*) FROM residents) AS residents,
          (SELECT count(*) FROM places) AS places,
          (SELECT count(*) FROM events) AS events,
          (SELECT count(*) FROM notes) AS notes;

   SELECT count(*) AS unvalidated_constraints
   FROM pg_constraint
   WHERE NOT convalidated;
   ```

5. Record the non-secret results, disconnect, then delete only the drill branch:

   ```sh
   neon branches delete restore-drill-YYYYMMDD --project-id bold-union-44728141
   ```

Never use `--finalize` during a drill. Finalizing swaps the restored branch into
the target and is a production recovery action requiring a reviewed incident
plan.

## Verified recovery evidence

Evidence recorded on 2026-08-15:

- A local full-schema JSON backup was structurally readable.
- An older PostgreSQL dump archive restored into disposable PostgreSQL 17 with
  36 public tables and zero unvalidated constraints.
- A Neon snapshot restored unfinalized to temporary branch
  `restore-drill-20260815` and was queried successfully: 36 public tables, 117
  residents, 207 places, 12,799 events, 1,758 notes, and zero unvalidated
  constraints. The temporary branch was then deleted.

Environment files must remain ignored. Never print, paste, or commit connection
URLs, Neon API keys, passwords, or other environment-file contents.
