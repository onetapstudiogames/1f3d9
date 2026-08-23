# Backup and restore

The recovery backup is a PostgreSQL custom archive made by `pg_dump`. It captures
one database snapshot, includes schema and data, and can be checked and restored
with `pg_restore`.

JSON table exports are diagnostic files. Do not use or describe them as recovery
backups.

Dated public snapshots are also not recovery backups. They contain only the explicit
anonymous public projection, omit private state and schema needed for recovery, and are
published as split NDJSON files with a verification manifest. Use
[`PUBLIC_SNAPSHOTS.md`](PUBLIC_SNAPSHOTS.md) for that public artifact and this document
only for private recovery.

## 1. Create a backup

Time: usually 1–15 minutes, depending on database size and network speed.

Before running the command:

1. Start Docker Desktop.
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

Local default output is under ignored `backups/`. A successful run publishes two
files together:

- `*.dump` — sensitive schema and data.
- `*.dump.manifest.json` — safe target identity, byte size, SHA-256, and tool evidence.

Do not sync the archive to a public service. On Windows, use a folder accessible
only to the owner account.

The SHA-256 sidecar detects archive corruption. It is not a digital signature:
someone who can replace both files can also relabel the target metadata. Keep both
files in the protected directory and cross-check the safe project and branch IDs
against the operator record.

## 2. Run the isolated restore drill

Time: usually 1–5 minutes.

```powershell
npm run restore:drill -- --archive C:\Users\Owner\Backups\1f3d9-production.dump
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

## 3. Recovery policy

Provider snapshots and point-in-time recovery remain the production-first recovery
path until a production custom archive has completed this local drill. A real
incident restore into production requires a reviewed incident plan; this repository
deliberately has no general “restore over production” command.

Do not record URLs, passwords, API keys, archive contents, or private row values in
drill evidence. Record the date, safe target IDs, archive checksum, elapsed time,
table count, constraint result, and whether cleanup succeeded.

## Automated local verification (not production acceptance)

On 2026-08-16, the automated PostgreSQL 17 test completed in about 16 seconds. It
blocked `pg_dump` at a controlled lock, committed a two-table change, and restored
the archive twice. The source was new/new; both restores were old/old, proving one
coherent snapshot rather than mixed moments. Both drills passed the schema,
constraint, index, trigger, count, and write checks and removed their exact
containers. The temporary local archive was deleted after the test, so this is
reproducible engineering verification, not a retained recovery artifact.

## Production acceptance gate — not run

Wave 2 item 5 remains open until an authorized operator creates one production
archive and restores that exact archive locally. The evidence record must include
the date, safe project and branch IDs, archive SHA-256, elapsed time, exact table
count, zero-invalid constraint/index result, and confirmed container cleanup. It
must not include URLs, credentials, archive contents, or private row values.

The implementation follows the official PostgreSQL guidance for
[`pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html) and
[`pg_restore`](https://www.postgresql.org/docs/current/app-pgrestore.html), plus
Neon's requirement to use a
[direct connection for backup and restore](https://neon.com/docs/manage/backup-pg-dump).
