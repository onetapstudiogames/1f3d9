# Public snapshot runbook

This runbook exports and verifies the city's approved anonymous public record.
It never creates or restores a private recovery backup. Read the format and
class registry in [`../PUBLIC_SNAPSHOTS.md`](../PUBLIC_SNAPSHOTS.md) before
enabling publication.

No snapshot publication was run while this workflow was built. The first real
release is a separate, explicitly approved release operation.

## 1. Install the restricted database projection

Time: usually 2–10 minutes for preview, plus the normal production migration
review window.

1. Review `db/migrations/20260823_public_snapshots.sql`. Confirm it has explicit
   columns, one `city_snapshot.public_records` view, base-table revocations, and
   grants only to `city_snapshot_export`.
2. Apply preview first with the normal target proof:

   ```sh
   npm run migrate:preview:public-snapshots
   ```

3. Provision a strong password for `city_snapshot_export` through the database
   provider's protected SQL/operator channel. The migration deliberately creates
   the login with no password. Do not put the password in SQL files, shell history,
   logs, documentation, or Git.
4. Build a direct, non-pooled PostgreSQL URL whose username is exactly
   `city_snapshot_export`, then store the complete value only as
   `SNAPSHOT_DATABASE_URL` in the target's protected environment or GitHub Actions
   secret.
5. Export and verify preview into a new empty candidate directory before doing any
   Production work:

   ```sh
   npm run snapshot:export -- --out /path/to/empty-preview-candidate
   npm run snapshot:verify -- --dir /path/to/empty-preview-candidate
   ```

6. After preview export and verification pass, and only with separate approval, apply
   the Production migration:

   ```sh
   npm run migrate:production:public-snapshots
   ```

The migration runner's existing production safeguards still apply. The snapshot
exporter refuses a pooler, a missing host/database/password, another username,
and any fallback to `DATABASE_URL`.

## 2. Prepare a local candidate

Time: usually 2–10 minutes, depending on database size and network speed.

Use a new empty temporary directory outside the checkout. The exporter refuses a
nonempty directory and creates files with exclusive writes.

PowerShell example:

```powershell
$snapshotDir = Join-Path ([System.IO.Path]::GetTempPath()) "1f3d9-public-snapshot-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $snapshotDir
npm run snapshot:export -- --out $snapshotDir
npm run snapshot:verify -- --dir $snapshotDir
```

The export proves all of these before it reads the four-column view:

- Current login is `city_snapshot_export`.
- The transaction is read-only and has one repeatable-read moment.
- The account cannot read or write any base relation in `public`.
- The account cannot read private tables such as OAuth, flags, payments, fee credit, or later-holder marks.
- The view columns are exactly `class_name`, `record_id`, `sort_key`, `payload`.

Stop on any failure. Do not broaden the role to make an export pass. Fix the
view, grants, or target secret, then create a new empty candidate directory.

## 3. Inspect and dry-run publication

Time: usually 2–5 minutes.

1. Read `manifest.json` without editing it. Confirm the intended frozen UTC time,
   full source commit, all class counts, complete class registry, and one entry for
   every NDJSON file.
2. Compare the verifier's city root with a separately computed SHA-256 of the exact
   `manifest.json` bytes.
3. Scan filenames and sample all marker types, including the two approved
   `body_not_exported` legacy-note markers. Confirm there are no extra files,
   private classes, hidden/withdrawn bodies, private direct offers, flag reports,
   payment attempts, fee-credit facts, credentials, OAuth records, or later-holder
   marks.
4. Set a short-lived GitHub token with read access for duplicate checks, then run:

   ```sh
   npm run snapshot:publish -- --dir /path/to/candidate --dry-run
   ```

5. Confirm the JSON result says `published: false` and reports the same tag, asset
   count, and city root as the offline verifier.

Dry run performs only authenticated GitHub `GET` requests after local verification.
It refuses to continue unless it can prove that both the timestamped tag and release
are absent. It creates no tag, release, or asset.

## 4. GitHub workflow

`.github/workflows/public-snapshot.yml` has two entry paths:

- `workflow_dispatch` defaults to `dry-run`. An operator must deliberately choose
  `publish` for a real release.
- The `17 8 * * *` schedule prepares, verifies, and publishes one new append-only
  release daily at 08:17 UTC after the reviewed workflow reaches the default branch
  with the required secret and permissions.

The workflow needs the protected `SNAPSHOT_DATABASE_URL`. GitHub's job token needs
`contents: write` only for the publication job. Do not add `DATABASE_URL`, a privileged
database URL, a recovery-backup URL, or a reusable personal token as a fallback.

Before enabling the daily path, run the manual dry run from the exact reviewed commit
and inspect its logs for safe metadata only. GitHub may disable scheduled workflows
after 60 days without repository activity. Check the schedule if a day is missed;
already published Releases and the public verification recipe do not depend on the
schedule continuing.

## 5. Publish or handle a failure

Time: usually 2–10 minutes.

For an explicitly approved release, either select `publish` in the manual workflow or
run the reviewed command with a token allowed to create Releases:

```sh
npm run snapshot:publish -- --dir /path/to/candidate --publish
```

The publisher verifies local bytes again, proves the tag and release are absent,
creates a draft release, uploads every file, and publishes only the complete draft.
It never replaces an existing release or asset.

If upload or final publication fails, stop. The draft is intentionally left
unpublished. Record its safe release ID, expected tag, uploaded filenames, source
commit, and city root. Inspect the draft before any cleanup or retry; never delete or
replace a published original.

If a published original is wrong:

1. Leave its tag, assets, hashes, and release notes unchanged.
2. Publish a separate erratum naming the original tag and city root.
3. Name each affected class/file and record ID, with its original fingerprint or hash.
4. State the explanation and correction without merging it into the original record.
5. If corrected data is required, export a later frozen moment under a new tag and link
   the two releases.

A legal or provider-forced removal is the narrow exception. Publish a visible
withdrawal notice and preserve the original hashes whenever law permits. Never make a
silent replacement.

## Evidence record

Keep only non-secret evidence:

- Date, workflow run, source commit, and frozen export time.
- Timestamped release tag and GitHub release link.
- Offline-verifier result, class counts, asset count, and 64-character city root.
- Confirmation that every exclusion and safety marker was sampled.
- Any separate erratum or withdrawal notice.

Never record the database URL, password, GitHub token, private row, private report,
payment request, recovery material, or credential-shaped resident text.

## Recovery backups are different

| Public snapshot | Private recovery backup |
|---|---|
| Approved anonymous projection only | Full schema and private database state |
| Split NDJSON plus canonical manifest | PostgreSQL custom archive plus sidecar |
| Public GitHub Release | Owner-private protected storage |
| Independently verifies public history | Restores service after data loss |
| Cannot rebuild private accounts or operations | Must never be published |

Use [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) for provider snapshots, `pg_dump`
archives, restore drills, and incident recovery. Never pass a recovery archive to the
public exporter or upload it to a public snapshot release.
