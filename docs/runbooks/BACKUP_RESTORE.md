# Backup and restore runbook

A recovery backup of the city is a PostgreSQL custom archive made by `pg_dump`.
It captures one database snapshot, includes schema and data, and can be checked
and restored with `pg_restore`. Neon provider snapshots are the second recovery
layer. Nothing else is a backup: JSON table exports and other diagnostic files
must never be used or described as recovery backups.

The dated public-record releases are not provider snapshots despite the shared word
“snapshot.” They intentionally exclude credentials, private reports, payment attempts,
fee-credit state, later-holder marks, private offers, and other recovery-critical data.
Never restore from them or upload a recovery archive beside them. Their separate
operator path is [`PUBLIC_SNAPSHOTS.md`](PUBLIC_SNAPSHOTS.md).

The production database is Neon PostgreSQL 17:

- project: `neon-cyclamen-school` (`bold-union-44728141`)
- main branch: `br-lively-sunset-avksnwos`
- point-in-time history: 6 hours
- automatic snapshots: daily at 08:00 UTC, retained for 14 days

## 1. Create an archive backup

Time: usually 1–15 minutes, depending on database size and network speed.

Before running the command:

1. Start Docker Desktop, or Docker Engine on native Linux.
2. Put the direct, non-pooled database URL in the target-specific environment
   variable. Never paste it into the command itself.
3. Set the exact confirmation variable below.
4. Name the expected database with `--database`.

| Target | URL variable | Confirmation variable and exact value |
|---|---|---|
| Local | `LOCAL_DATABASE_URL_UNPOOLED` | `CONFIRM_LOCAL_BACKUP=CREATE_1F3D9_LOCAL_RECOVERY_ARCHIVE` |
| Preview | `PREVIEW_DATABASE_URL_UNPOOLED` | `CONFIRM_PREVIEW_BACKUP=CREATE_1F3D9_PREVIEW_RECOVERY_ARCHIVE` |
| Production | `PRODUCTION_DATABASE_URL_UNPOOLED` | `CONFIRM_PRODUCTION_BACKUP=CREATE_1F3D9_PRODUCTION_RECOVERY_ARCHIVE` |

Local example:

```powershell
npm run backup -- --target local --database city
```

Keep local PostgreSQL bound to loopback. The backup first proves the exact
authenticated database through `host.docker.internal`; on Linux it tries host
networking only when that route is unavailable. A public database bind is not
needed. The host reserves the private temporary archive before `pg_dump` fills
it, so verified publication keeps host ownership and never overwrites an
existing archive.

Preview and production also require `NEON_API_KEY`, `NEON_PROJECT_ID`,
`NEON_PRODUCTION_BRANCH_ID`, and the matching branch ID. They require an explicit
owner-private output path. The direct URL must use port `5432` and
`sslmode=require`, `verify-ca`, or `verify-full`.

The remote output directory must already exist. On Windows, create a dedicated
directory whose ACL grants access only to the current user, SYSTEM, and
Administrators:

```powershell
$backupDir = Join-Path $env:USERPROFILE 'Private\1f3d9-backups'
New-Item -ItemType Directory -Force -Path $backupDir
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $backupDir /inheritance:r
icacls $backupDir /grant:r "*$($currentSid):(OI)(CI)F"
icacls $backupDir /grant "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
```

Then choose a new archive name for each run:

```powershell
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ssZ')
npm run backup -- --target production --database neondb --out "$backupDir\1f3d9-production-neondb-$stamp.dump"
```

The script proves the named Neon endpoint before starting `pg_dump`. It refuses
pooled URLs, insecure remote transport, a nonstandard remote port, a preview
branch equal to production, a database-name mismatch, an unproven private output
directory, and ambient `DATABASE_URL` fallback. On Linux and macOS, the remote
directory must be owned by the current user with mode `0700`.

Local default output is under ignored `backups/`. A successful run leaves two
files; the manifest is the completion marker:

- `*.dump` — sensitive schema and data.
- `*.dump.manifest.json` — safe target identity, byte size, SHA-256, and tool evidence.

After a hard stop, an archive without its manifest is incomplete and must not be
used as a recovery backup.

Do not sync the archive to a public service. On Windows, use a folder accessible
only to the owner account.

The SHA-256 sidecar detects archive corruption. It is not a digital signature:
someone who can replace both files can also relabel the target metadata. Keep both
files in the protected directory and cross-check the safe project and branch IDs
against the operator record.

## 2. Run the isolated restore drill

Time: usually 1–5 minutes.

```powershell
npm run restore:drill -- --archive C:\Users\Owner\Private\1f3d9-backups\1f3d9-production.dump
```

The drill first checks the manifest, byte size, and SHA-256. Only then does it
start one uniquely named PostgreSQL 17 container, restore inside one transaction,
and check:

1. Required city tables and restored row counts.
2. Zero unvalidated constraints and zero invalid indexes.
3. Public triggers are present.
4. The resident ID allocator can complete a rolled-back write.

The exact owned container is removed in `finally`, whether the drill passes or
fails. The drill never connects to or changes the source database.

After a hard process or machine stop, inspect only labeled drill containers:

```powershell
docker ps -a --filter label=com.1f3d9.role=restore-drill
```

Verify the exact name belongs to the interrupted drill before removing it.

## 3. Check provider snapshots

Run these checks at least monthly and before a risky production migration:

```sh
neon snapshots schedule get --project-id bold-union-44728141 --branch br-lively-sunset-avksnwos
neon snapshots list --project-id bold-union-44728141
```

Confirm that the schedule still says daily at 08:00 UTC with 14-day retention,
that recent snapshots exist, and that the oldest required recovery point has not
expired. Create a named permanent snapshot before a high-risk release.

## 4. Run a safe Neon snapshot drill

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

## 5. After any restore: re-apply takedowns

A restored archive or provider snapshot resurrects whatever was later removed
by moderation. Content removed for someone's safety must never come back
through a recovery, so after ANY restore into a serving database:

1. List every takedown recorded after the restored moment. Three sources,
   cross-checked: the takedown ledger below, the public moderation log
   (`GET /api/moderation` on the pre-incident record if reachable), and the
   withdrawal notices on public snapshot releases.
2. Re-apply each removal through `POST /api/moderation` (founder resident #1),
   with the original reason wording.
3. Verify each target is tombstoned before the restored database serves the
   public.

This step is part of the restore, not an afterthought; a restore is incomplete
until it runs.

### Takedown ledger

Append-only. One line per removal, oldest first. The facts here are already
public (moderation log, release notices) — this table exists so a recovery
can never miss one.

| Date (UTC) | Target | Scope beyond the live record |
|---|---|---|
| 2026-08-25 | note 6282 | notes.ndjson withdrawn from snapshot releases 20260824T090642Z and 20260825T090155Z (visible notices; manifest hashes preserved) |

## 6. Recovery policy

Provider snapshots and point-in-time recovery remain the production-first recovery
path until a production custom archive has completed this local drill. A real
incident restore into production requires a reviewed incident plan; this repository
deliberately has no general "restore over production" command.

Do not record URLs, passwords, API keys, archive contents, or private row values in
drill evidence. Record the date, safe target IDs, archive checksum, elapsed time,
table count, constraint result, and whether cleanup succeeded.

## Verified recovery evidence

Evidence recorded on 2026-08-15 (provider path):

- An older PostgreSQL dump archive restored into disposable PostgreSQL 17 with
  36 public tables and zero unvalidated constraints.
- A Neon snapshot restored unfinalized to temporary branch
  `restore-drill-20260815` and was queried successfully: 36 public tables, 117
  residents, 207 places, 12,799 events, 1,758 notes, and zero unvalidated
  constraints. The temporary branch was then deleted.

Automated local verification recorded on 2026-08-16 (archive path, not
production acceptance): the PostgreSQL 17 integration test blocked `pg_dump` at a
controlled lock, committed a two-table change, and restored the archive twice.
The source was new/new; both restores were old/old, proving one coherent snapshot
rather than mixed moments. Both drills passed the schema, constraint, index,
trigger, count, and write checks and removed their exact containers. The
temporary local archive was deleted after the test, so this is reproducible
engineering verification, not a retained recovery artifact.

## Production acceptance gate — passed 2026-08-18

An authorized operator created one production archive and restored that exact
archive locally, closing Wave 2 item 5.

- Target: project `bold-union-44728141`, branch `br-lively-sunset-avksnwos`,
  database `neondb`, endpoint proven against the Neon API before dumping.
- Archive: `1f3d9-production-neondb-2026-08-18T13-44-43Z.dump`, 3,688,280
  bytes, SHA-256
  `1aa25dfa06f5450244ec0a78f70275266932b48d66cd8ed25d1d75b344003c98`, stored
  with its manifest in the owner-private backup directory. Backup completed in
  about three minutes; the drill in about one.
- Drill result: 43 public tables restored, 0 unvalidated constraints, 0
  invalid indexes, triggers present, rolled-back write check passed. The
  drill container was removed; zero `com.1f3d9.role=restore-drill` containers
  remained afterwards.
- Operator note: run the backup from a shell whose PowerShell module path is
  the Windows default. A PowerShell 7 parent used to break the directory
  ACL probe; the script now strips the inherited module path itself.

Future archives repeat this procedure; the record must always include the
date, safe project and branch IDs, archive SHA-256, elapsed time, exact table
count, zero-invalid constraint/index result, and confirmed container cleanup,
and must never include URLs, credentials, archive contents, or private row
values.

The implementation follows the official PostgreSQL guidance for
[`pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html) and
[`pg_restore`](https://www.postgresql.org/docs/current/app-pgrestore.html), plus
Neon's requirement to use a
[direct connection for backup and restore](https://neon.com/docs/manage/backup-pg-dump).

Environment files must remain ignored. Never print, paste, or commit connection
URLs, Neon API keys, passwords, or other environment-file contents.
