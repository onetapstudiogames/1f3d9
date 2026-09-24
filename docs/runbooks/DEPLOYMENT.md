# Deployment runbook

Status: current.

Production is deployed from the GitHub repository
[`onetapstudiogames/1f3d9`](https://github.com/onetapstudiogames/1f3d9).
The linked Vercel project is `1f3d9`, and its production branch is `main`.
Vercel's Git integration builds and deploys the exact commit merged into that
branch.

Do not run `vercel --prod` from a local folder. A folder upload can bypass the
reviewed Git commit and make production impossible to reproduce from `main`.

After a merge, check the latest production probe with `gh run list --workflow live-probe.yml --limit 1`.
If GitHub has delayed its scheduled run, use `gh workflow run live-probe.yml --ref main` and confirm that run succeeds before calling the release verified.

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

### Resident-awareness prerequisite

Before the first application rollout that returns fee-credit attention from `GET /api/me`,
apply `npm run migrate:preview:resident-awareness` to the isolated Preview database.
Verify `city_credit_last_me_reads` has one cascading resident primary key, required
nonnegative `last_credit_entry_id`, optional nonnegative `previous_credit_entry_id`, and
`read_at`, then apply the migration a second time to prove it is safe to repeat. Take the
required Production snapshot, apply `npm run migrate:production:resident-awareness`, and
record the same checks before merging the application. The rollout does not apply this
migration. The table remains private reader state and must not enter snapshots or events.

### Me public-checkpoint prerequisite

After resident-awareness and before the first application rollout that reports public
activity since a resident's prior `GET /api/me`, apply
`npm run migrate:preview:me-public-checkpoint` to the isolated Preview database. Verify
`city_credit_last_me_reads.last_public_change_id` is a nullable bigint with no default
and the validated `city_credit_last_me_reads_public_change_nonnegative` check rejects
negative values. Verify existing marker rows remain null, then apply the migration a
second time to prove it is safe to repeat. Take the required Production snapshot, apply
`npm run migrate:production:me-public-checkpoint`, and record the same checks before
merging the application. The rollout does not apply this migration, and `--prepare`
does not query either database.

### Flag-review prerequisite

Before the first application rollout that reads flags at `GET /api/founder/flags`, answers
one at `POST /api/founder/flags/:id/handle`, or counts unhandled reports in `GET /api/me`,
apply `npm run migrate:preview:flag-review` to the isolated Preview database. Verify
`flag_reviews` has a unique `flag_id` referencing `flags`, a required `reviewer_id`
referencing `residents`, a nullable `moderation_id` referencing `moderation_actions`, a
nullable one-line `note` of 1 to 200 characters, the check that requires a moderation id or
a note, and the validated `flag_reviews_append_only` trigger. Verify the table is empty,
then apply the migration a second time to prove it is safe to repeat. Take the required
Production snapshot, apply `npm run migrate:production:flag-review`, and record the same
checks before merging the application. The rollout does not apply this migration, and
`--prepare` does not query either database.

```sql
SELECT column_name, is_nullable, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'flag_reviews';
SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'flag_reviews'::regclass;
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'flag_reviews'::regclass AND tgname = 'flag_reviews_append_only';
SELECT count(*) AS answers_before_rollout FROM flag_reviews;
```

An answer is append-only and one flag keeps one answer, so a wrong answer is corrected by a
new moderation act, never by editing the row.

### Shared-use destroy prerequisite

Before the first application rollout that lets a visitor's `use` destroy an open thing,
apply `npm run migrate:preview:shared-use-may-destroy` to the isolated Preview database.
Verify `things.shared_use_may_destroy` is a `boolean`, `NOT NULL`, with default `false`,
and that every existing thing reads false, so no thing changes behavior on the day the
column lands. Then apply the migration a second time to prove it is safe to repeat. Take
the required Production snapshot, apply
`npm run migrate:production:shared-use-may-destroy`, and record the same checks before
merging the application. The rollout does not apply this migration, and `--prepare` does
not query either database.

```sql
SELECT column_name, is_nullable, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'things'
  AND column_name = 'shared_use_may_destroy';
SELECT count(*) FILTER (WHERE shared_use_may_destroy) AS open_to_shared_destroy,
  count(*) AS things
FROM things;
```

The column is additive and defaults closed, so the old application keeps working against
the new column and the rollback is to merge the previous application, never to drop it.

### Walk-to-read note prerequisite

Before the first application rollout that writes or withholds walk-to-read notes
(decision #102), apply `npm run migrate:preview:note-walk-to-read` to the isolated Preview
database. Verify `notes.walk_to_read` is a `boolean`, `NOT NULL`, with default `false`, and
that every existing note reads false, so no note changes on the day the column lands.
Then apply the migration a second time to prove it is safe to repeat. Take the required
Production snapshot, apply `npm run migrate:production:note-walk-to-read`, and record the
same checks before merging the application. The rollout does not apply this migration,
and `--prepare` does not query either database.

```sql
SELECT column_name, is_nullable, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'notes'
  AND column_name = 'walk_to_read';
SELECT count(*) FILTER (WHERE walk_to_read) AS walk_to_read_notes,
  count(*) AS notes
FROM notes;
```

The column is additive and defaults to ordinary notes, so the old application keeps
working against it and the rollback is to merge the previous application, never to drop
the column.

### Public snapshot walk-to-read mark prerequisite

Before merging the change that states the dated snapshots mark walk-to-read notes
(decision #103), and only after the note-walk-to-read migration above, apply
`npm run migrate:preview:public-snapshot-walk-to-read` to the isolated Preview database,
then apply it a second time to prove it is safe to repeat. It replaces only
`city_snapshot.public_records_without_drawing_contract` with the reviewed view plus
`walk_to_read` on each exported note, and adds the small `notes_walk_to_read` index
that search uses to find walk-to-read notes by their first line. Take the required
Production snapshot, apply
`npm run migrate:production:public-snapshot-walk-to-read`, and record the check below
before merging. Every exported note must carry the mark, and the true count must equal
the stored walk-to-read notes that are not hidden. The rollout does not apply this
migration, and `--prepare` does not query either database.

```sql
SELECT payload->>'walk_to_read' AS walk_to_read, count(*) AS notes
FROM city_snapshot.public_records_v2
WHERE class_name = 'notes' AND payload->>'status' = 'exported'
GROUP BY 1 ORDER BY 1;
```

The index must also be present:

```sql
SELECT indexdef FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'notes_walk_to_read';
```

The rollback is to reapply `npm run migrate:production:public-snapshot-quiet`, which
restores the earlier view without the mark. The index can stay; the earlier
application never reads it.

### Public snapshot thing labels prerequisite

Before merging the change that states the dated snapshots carry each thing's current
labels, and only after the public-snapshot-walk-to-read migration above, apply
`npm run migrate:preview:public-snapshot-thing-labels` to the isolated Preview database,
then apply it a second time to prove it is safe to repeat. It replaces only
`city_snapshot.public_records_without_drawing_contract` with the reviewed view plus
`labels` and `labels_total` on each exported thing, in the shape the public thing read
gives them. It adds no table, column, or index. Take the required Production snapshot,
apply `npm run migrate:production:public-snapshot-thing-labels`, and record the check
below before merging. Every exported thing must carry both fields, and the labelled count
must equal the active, unhidden things that hold at least one current label. The rollout
does not apply this migration, and `--prepare` does not query either database.

```sql
SELECT count(*) AS things,
  count(*) FILTER (WHERE payload ? 'labels' AND payload ? 'labels_total') AS carrying,
  count(*) FILTER (WHERE (payload->>'labels_total')::int > 0) AS labelled
FROM city_snapshot.public_records_v2
WHERE class_name = 'things' AND payload->>'status' = 'exported';
```

The rollback is to reapply `npm run migrate:production:public-snapshot-walk-to-read`,
which restores the earlier view without the labels.

### Abilities (wake, chance, write) prerequisite

Before merging the application that wakes things, rolls chance, and writes state boxes
(decisions #104 to #110), apply `npm run migrate:preview:abilities-wake-chance-write` to
the isolated Preview database, then apply it a second time to prove it is safe to
repeat. It adds `things.wake_enabled` (default false), `things.state` (default `{}`),
`things.state_version` (default 0), the places' wake dials and `rough_room` (default
false), `places.rough_since` (null) and `resident_presence.arrived_at` (default the
migration time), the `things_sleep_on_owner_change`, `places_mark_rough_since`, and
`resident_presence_mark_arrival` triggers, and the append-only
`wake_settles`, `wake_tries`, `chance_days`, `chance_rolls`, and
`thing_state_changes` tables plus the mutable `thing_wake_state` anchors. It backfills
nothing: every existing thing starts asleep with an empty box, and every place keeps
the default dials. Take the required Production snapshot (for example
`PRODUCTION_SNAPSHOT_NAME=pre-abilities-20260922`), apply
`npm run migrate:production:abilities-wake-chance-write` from a fresh clone of the
reviewed head, and record the checks below before merging, never chained with the
merge. The rollout does not apply this migration, and `--prepare` does not query
either database.

```sql
SELECT table_name, column_name, is_nullable, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'things' AND column_name IN ('wake_enabled', 'state', 'state_version'))
    OR (table_name = 'places' AND column_name IN ('wake_visitors', 'wake_pins',
      'wake_block_thing_ids', 'wake_block_resident_ids', 'wake_random_cap', 'rough_room',
      'rough_since'))
    OR (table_name = 'resident_presence' AND column_name = 'arrived_at'))
ORDER BY table_name, column_name;
SELECT tgname FROM pg_trigger
WHERE tgname IN ('things_sleep_on_owner_change', 'places_mark_rough_since',
  'resident_presence_mark_arrival', 'wake_settles_append_only',
  'wake_tries_append_only', 'chance_days_append_only', 'chance_rolls_append_only',
  'thing_state_changes_append_only')
ORDER BY tgname;
SELECT count(*) FILTER (WHERE wake_enabled) AS awake_things,
  count(*) FILTER (WHERE state_version <> 0) AS written_boxes,
  count(*) AS things
FROM things;
SELECT count(*) FILTER (WHERE rough_room OR rough_since IS NOT NULL) AS rough_places
FROM places;
SELECT (SELECT count(*) FROM wake_settles) AS settles,
  (SELECT count(*) FROM chance_rolls) AS rolls,
  (SELECT count(*) FROM thing_state_changes) AS state_changes;
```

Before rollout the awake, written, rough, settle, roll, and state-change counts are all
zero.
The columns are additive and default to asleep and empty, so the old application
keeps working against them. The rollback is to merge the previous application, never
to drop anything. On the old application, `loadTraitRecipe` refuses the unknown
`chance` and `write` bricks and the `wake` key, so every trait that uses one loads
entirely empty, older keys in the same trait included: things of those kinds do
nothing on use, consume, or give, and laws carrying chance do nothing, until the new
application returns. Nothing wakes on the old application, state boxes stay stored
but unread, and returning to the new application restores all of it with no data lost.

On the first UTC day after rollout, `physics` shows `committed_before_day` false for
that day's rolls, because its secret row is made during the day by the first settle;
from then on each day's row is made a day ahead, so a live check of that field uses a
roll from the second day or later.

### Abilities (copy, reach, convert) prerequisite

Apply this after the wake, chance, and write migration above. Before merging the
application that copies, reaches, and converts things (decisions #111 to #115), apply
`npm run migrate:preview:abilities-copy-reach-convert` to the isolated Preview database,
then apply it a second time to prove it is safe to repeat. It adds `things.generation`
(default 0), `things.parent_thing_id`, `things.family_id`, `things.copies_made` (default
0), `things.open_to_reach` and `things.open_to_convert` (default false),
`things.as_kind_id` and `things.as_revision` with the `things_as_kind_revision_fkey` and
`things_as_kind_contract` constraints, the places' `growth_cap_per_day` (default 10),
`growth_share_per_family` (default 5), and `allow_arriving_copies` (default false), the
append-only `thing_conversions` table, and the mutable `place_copy_counts` and
`family_growth_marks` tables. Its `things_close_consent_on_owner_change` trigger turns
`open_to_reach` and `open_to_convert` off whenever a thing changes owner. It also widens
four checks the previous migration added:
`chance_rolls.purpose` gains `copy_place`, `chance_rolls.outcome` gains `member_refused`,
`thing_state_changes.op` gains `inherit`, and `thing_state_changes.trigger` gains `copy`;
each wider check is added before the narrower one is dropped, inside one transaction. It
backfills nothing. Take the required Production snapshot (for example
`PRODUCTION_SNAPSHOT_NAME=pre-abilities-copy-reach-convert-20260922`), apply
`npm run migrate:production:abilities-copy-reach-convert` from a fresh clone of the
reviewed head, and record the checks below before merging, never chained with the merge.

```sql
SELECT table_name, column_name, is_nullable, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'things' AND column_name IN ('generation', 'parent_thing_id', 'family_id',
      'copies_made', 'open_to_reach', 'open_to_convert', 'as_kind_id', 'as_revision'))
    OR (table_name = 'places' AND column_name IN ('growth_cap_per_day',
      'growth_share_per_family', 'allow_arriving_copies')))
ORDER BY table_name, column_name;
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname IN ('things_as_kind_revision_fkey', 'things_as_kind_contract',
  'chance_rolls_purpose_known', 'chance_rolls_outcome_known',
  'chance_rolls_copy_place_contract', 'thing_state_changes_op_known',
  'thing_state_changes_trigger_known')
ORDER BY conname;
SELECT tgname FROM pg_trigger
WHERE tgname IN ('thing_conversions_append_only', 'things_close_consent_on_owner_change')
ORDER BY tgname;
SELECT count(*) FILTER (WHERE generation <> 0) AS descendants,
  count(*) FILTER (WHERE as_kind_id IS NOT NULL) AS converted,
  count(*) FILTER (WHERE open_to_reach OR open_to_convert) AS open_things
FROM things;
SELECT (SELECT count(*) FROM thing_conversions) AS conversions,
  (SELECT count(*) FROM place_copy_counts) AS copy_counts,
  (SELECT count(*) FROM family_growth_marks) AS marks;
```

Before rollout every count is zero. The columns are additive with safe defaults, so the
old application keeps working against them. The rollback is to merge the previous
application, never to drop anything. On the old application `loadTraitRecipe` refuses the
unknown `copy`, `reach`, and `convert` bricks, so every trait that uses one loads entirely
empty, older keys in the same trait included: things of those kinds do nothing on use,
consume, give, or wake, and laws carrying reach or convert do nothing, until the new
application returns. Converted things show their birth kind again, because the old
application never reads the overlay. The owner-change trigger stays and keeps closing
both switches on a gift or sale, which the old application never reads. No data is lost,
and returning to the new application restores all of it.

### Same-room talk prerequisite

Before merging the change that installs the talk tables and snapshot format v3
(decisions #119 to #123), apply `npm run migrate:preview:same-room-talk` to the
PR's Preview database branch and to the shared Preview branch the Vercel preview
reads. Apply it a second time to each branch to prove it is safe to repeat. For
each Preview branch, run Q0, Q1, and Q4 before the first pass and after each pass.
Run Q7, Q9, and Q10 only after each pass. Record the results for both Preview
branches.

Take the required Production snapshot, for example
`PRODUCTION_SNAPSHOT_NAME=pre-same-room-talk-20260925`, then apply
`npm run migrate:production:same-room-talk` from a fresh clone of the reviewed
head. Record the checks before merging. Never chain the migration with the merge.
The rollout does not apply this migration, and `--prepare` does not query either
database.

Rollback is forward only: merge the previous application; the tables, wider
checks, and v3 view stay unused and harmless.

The following checks are read-only. On Preview, Q0, Q1, and Q4 run before the
first pass and after each pass; Q7, Q9, and Q10 run only after each pass. On
Production, run Q0, Q1, and Q4 before the migration, then run all six checks
after it.

Q0, the talk objects (before: every column NULL; after: none NULL):

```sql
SELECT to_regclass('public.room_lines') AS room_lines,
  to_regclass('public.line_quota') AS line_quota,
  to_regclass('public.line_minute_quota') AS line_minute_quota,
  to_regclass('public.pings') AS pings,
  to_regclass('public.ping_receipts') AS ping_receipts,
  to_regclass('public.ping_operations') AS ping_operations,
  to_regclass('public.wait_leases') AS wait_leases,
  to_regclass('city_snapshot.public_records_v3') AS v3_view,
  to_regprocedure('public.pings_answer_once()') AS pings_answer_once,
  to_regprocedure('public.ping_receipts_mark_once()') AS ping_receipts_mark_once;
```

Q1, the seven tables (before: no rows; after: seven rows):

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('room_lines', 'line_quota',
  'line_minute_quota', 'pings', 'ping_receipts', 'ping_operations', 'wait_leases')
ORDER BY table_name;
```

Q4, the target checks (before: the existing checks naming seven types, recorded
as found; after: exactly two rows, `flags_target_type_check` and
`moderation_actions_target_type_allowed`, each naming nine types including line
and ping):

```sql
SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN ('moderation_actions'::regclass, 'flags'::regclass) AND contype = 'c'
  AND pg_get_constraintdef(oid) LIKE '%target_type%'
ORDER BY 1, 2;
```

Q7, empty talk tables (after only; all zero):

```sql
SELECT (SELECT count(*) FROM room_lines) AS lines, (SELECT count(*) FROM pings) AS pings,
  (SELECT count(*) FROM ping_receipts) AS receipts, (SELECT count(*) FROM ping_operations) AS operations,
  (SELECT count(*) FROM line_quota) AS day_counters,
  (SELECT count(*) FROM line_minute_quota) AS minute_counters,
  (SELECT count(*) FROM wait_leases) AS leases;
```

Q9, the export boundary (after only; expect true, true, false, false, false,
false, false, and the four columns `class_name`, `record_id`, `sort_key`,
`payload`):

```sql
SELECT has_table_privilege('city_snapshot_export', 'city_snapshot.public_records_v3', 'SELECT') AS reads_v3,
  has_table_privilege('city_snapshot_export', 'city_snapshot.public_records_v2', 'SELECT') AS reads_v2,
  has_table_privilege('city_snapshot_export', 'public.room_lines', 'SELECT') AS reads_lines_table,
  has_table_privilege('city_snapshot_export', 'public.pings', 'SELECT') AS reads_pings_table,
  has_table_privilege('city_snapshot_export', 'public.ping_receipts', 'SELECT') AS reads_receipts,
  has_table_privilege('city_snapshot_export', 'public.ping_operations', 'SELECT') AS reads_ledger,
  has_table_privilege('city_snapshot_export', 'public.wait_leases', 'SELECT') AS reads_leases,
  (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
   WHERE table_schema = 'city_snapshot' AND table_name = 'public_records_v3') AS v3_columns;
```

Q10, class counts (after only; every v2 class equal in v3; no `lines` or
`pings` rows while both tables are empty):

```sql
WITH v2 AS (SELECT class_name, count(*) AS records FROM city_snapshot.public_records_v2 GROUP BY 1),
v3 AS (SELECT class_name, count(*) AS records FROM city_snapshot.public_records_v3 GROUP BY 1)
SELECT class_name, v2.records AS v2_records, v3.records AS v3_records
FROM v2 FULL JOIN v3 USING (class_name) ORDER BY class_name;
```

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
3. Push the candidate commit, open the pull request, and wait for required CI and its
   Vercel Preview deployment. While room #454 remains closed in both databases, run the
   acknowledgement-prefixed release preparation command in the next section. It verifies
   the successful required CI run for that exact commit. Record its explicit
   `GATE_EXIT=0` line.
4. Request `GET /api/official` from the exact Preview
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
`gazette-withdrawal` migration installs the ledger, activation-gated guards and command
exclusion, and public projection while leaving `submission_room.withdrawals_open: false`.
It must be
installed before the withdrawal-capable application can roll out. The separate
`gazette-withdrawal-activation` migration changes the protected room contract and opens
withdrawals only after the exact withdrawal-capable commit is live. Neither migration
runs as part of application deployment.

Once `submission_room.withdrawals_open` is true, a Room #454 body
whose opening is exact uppercase `WITHDRAW`, optional whitespace, then `#` is reserved.
An exact `WITHDRAW #<your-note-id>` may become a command; a command-shaped near-miss is
refused in caller words. Every other opening remains an ordinary submission. The public
`withdrawal_contract.refusals` contains all six active refusal statuses and messages.

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
   `submission_room.withdrawals_open: false`. While
   `submission_room.withdrawals_open` is false, the dormant schema intercepts no Room #454
   body. `WITHDRAW #<digits>`, `WITHDRAW #12x`, and
   `WITHDRAW my nomination for mayor, a poem` are ordinary submissions. Those ordinary
   submissions use a weekly submission slot, can print, and create no withdrawal ledger
   row and no withdrawal refusal. This is the behavior-identical old-application window;
   it introduces no new error the old application would need to map. While withdrawals
   remain closed, those reserved-opening shapes also keep normal same-body replay. After
   activation, an unledgered reserved opening is interpreted under the active rule instead
   of replaying its dormant note; ordinary prose and ledgered withdrawal commands retain
   normal replay.
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

   Record the snapshot ID and the same inert dormant postconditions. Production
   submissions and printing must remain live, every Room #454 body must remain an ordinary
   submission, withdrawals must remain closed, and the ledger must remain empty. After
   the staged real-PostgreSQL suite passes, set this non-secret
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

### Held-luggage prerequisite

Before code that writes `things.held_by` ships, apply the held-luggage migration
to an isolated Preview database, verify it, then apply and verify it in
Production. The migration changes the world and Gazette guards as well as the
thing schema. Review the real PostgreSQL tests for held transit, ordinary
things, the owner-only rule, world transit, Gazette room #454, and release when
a place opens or changes owner. The known Gazette-less Preview cannot prove the
Gazette case; use an isolated Preview branch with the current base schema.

1. With the required Neon Preview target settings, apply the named migration:

   ```sh
   CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW \
   npm run migrate:preview:held-luggage
   ```

2. In Preview, run the read-only checks below. Require `held_by` to be nullable,
   the `things_held_owner_active` check and `held_by` foreign key to be valid,
   `things_one_held_per_resident` to be valid and unique, and the
   `places_release_held_luggage` trigger to report `tgenabled = 'O'`. Read the four function
   definitions returned by the second query against the reviewed migration;
   all four must include the held case. Require zero held rows before the new
   application writes any.

   ```sql
   SELECT column_name, is_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'things' AND column_name = 'held_by';
   SELECT conname, convalidated FROM pg_constraint
   WHERE conrelid = 'things'::regclass AND conname IN ('things_held_owner_active', 'things_held_by_fkey');
   SELECT indexrelid::regclass AS index_name, indisunique, indisvalid FROM pg_index
   WHERE indexrelid = to_regclass('things_one_held_per_resident');
   SELECT tgname, tgenabled FROM pg_trigger
   WHERE tgrelid = 'places'::regclass AND tgname = 'places_release_held_luggage';
   SELECT proname, pg_get_functiondef(oid) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN
     ('reject_world_place_content', 'gazette_submission_room_has_no_forbidden_contents',
      'protect_gazette_submission_room_dependents', 'release_held_luggage_on_place_access');
   SELECT count(*) AS held_rows_before_rollout FROM things WHERE held_by IS NOT NULL;
   SELECT gazette_submission_room_has_no_forbidden_contents() AS gazette_guard_still_holds;
   ```

3. Take a fresh required Production snapshot, then apply the same reviewed
   migration before merging the application:

   ```sh
   CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
   PRODUCTION_SNAPSHOT_NAME=<fresh-held-luggage-snapshot-name> \
   npm run migrate:production:held-luggage
   ```

4. Run the same read-only checks in Production. Record the snapshot name and
   results without credentials. Stop if a column, constraint, index, trigger,
   or function differs, if any held row exists before rollout, or if the
   Gazette guard reports false. Do not infer schema success from a green deploy.

Only after Preview and Production evidence is recorded, set this non-secret
release-preparation acknowledgement:

```sh
CONFIRM_HELD_LUGGAGE_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION_WITH_WORLD_AND_GAZETTE_CHECKS
```

`--prepare` checks that acknowledgement but does not query either database.
After held things exist, old application code can strand them. Use a reviewed
forward fix, or resolve held rows through an authorized owner-safe procedure
and verify none remain before downgrade. Do not improvise a destructive down
migration or clear markers without preserving owner access.

For the first rollout and every later release preparation, re-confirm that the required
provider keys remain configured, the maker and later-holder migrations remain applied in
that order, and the resumable-registration, PayPal credit-disputes, resident refusal-state,
and dormant Gazette schema and held-luggage migrations remain applied. For the first Gazette rollout, run
this while room #454 is still closed in both databases. Then run preparation with these
non-secret acknowledgements in the process environment:

```sh
CONFIRM_LATER_HOLDER_PROVIDER_KEY=VERIFIED_IN_VERCEL_PREVIEW_AND_PRODUCTION \
CONFIRM_THING_MAKER_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_LATER_HOLDER_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_RESUMABLE_REGISTRATION_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_RESIDENT_AWARENESS_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_ME_PUBLIC_CHECKPOINT_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION \
CONFIRM_GAZETTE_SCHEMA_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION_WITH_ROOM_CLOSED \
CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION=APPLIED_TO_PRODUCTION_WITH_WITHDRAWALS_CLOSED_AND_REAL_POSTGRES_PROVEN \
CONFIRM_PRODUCTION_DRAWING_RELEASE=DRAWING_CONTRACT_THEN_WORLD_ROOT_DRAWING_APPLIED_WITH_DOCUMENTED_DRAWING_GAZETTE_WORLD_POSTCONDITIONS_RECORDED \
CONFIRM_HELD_LUGGAGE_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION_WITH_WORLD_AND_GAZETTE_CHECKS \
scripts/deploy.sh --prepare
```

The Gazette acknowledgement records the historical safe installation state. After
activation, it does not claim that room #454 is still closed. The separate withdrawal
acknowledgement records that its Production schema was installed while withdrawals were
still closed and that the staged upgrade passed against real PostgreSQL; it never claims
the known schema-less Preview is Gazette-capable or authorizes activation.

These acknowledgements contain no key material. The preparation script never reads an
environment file, queries or changes Vercel, or applies a migration; it only blocks the
release until the operator confirms those separate prerequisites and required CI proves
the exact candidate.

1. Put the change on a review branch, push it, and leave the worktree clean.
2. Open a pull request and wait for its required `checks` job to finish successfully.
3. Run the acknowledgement-prefixed `scripts/deploy.sh --prepare` command above. This is
   a read-only release check: it proves the branch is pushed at the tested commit, proves
   the newest relevant required CI run completed successfully for that exact commit,
   checks the separate release prerequisites, and proves the commit did not move. It does
   not repeat the test, type-check, PostgreSQL integration, or browser suites. It does not
   upload or deploy anything.
4. Check the Vercel preview, including the changed user
   paths and any expected API behavior. The first Gazette rollout must complete its
   exact-commit Preview activation and probes above before this step.
5. Merge the reviewed pull request into `main`. Vercel then deploys that exact
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
