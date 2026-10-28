# Showing room weekly service

Status: current.

Decision #167 authorizes this bounded founder-scheduled act. Installation leaves it
off. This runbook does not claim that migration, deployment, activation or the first
scheduled run has happened. Record those proofs in the existing city-ops fixes
record for the release. Never put resident keys, connection strings or future
questions in the repository or release evidence.

## Before merge

Require the ordinary-talk lock regressions and independent runner review on the
final candidate before the migration ceremony or merge. Ordinary room #438 notes
reserve their responsible residents in ascending ID, then the resident retry lock
and admission before room preparation, action receipts, presence or law events.
The insert trigger remains the database guard. Deferred public activity stamps
reuse those resident and room reservations.

The runner reserves founder #1 before retry and admission, then publication rooms
in tree depth and ID order before the Gazette weekly lock. The Gazette printer
and ordinary room #454 notes reserve that room before the same weekly lock.
Activation follows that room order too. Verify both ordinary-note races and the
Gazette printer race against the merged marker before release.

The two reviewed files are `db/migrations/20261027_showing_room.sql` and
`db/migrations/20261027_showing_room_activation.sql`. The first installs every
private store, constraint and guard while leaving the service off. The second
invokes the already installed activation function after deployment verification;
it is not a substitute for installing the guards before merge.

Use the existing migration ceremony with exact Neon target proof. Preview must be
isolated from production. Production needs its verified restore snapshot before
DDL. The application builder must not perform either remote migration.

```text
node --experimental-strip-types scripts/migrate.ts --target preview --migration showing-room
node --experimental-strip-types scripts/migrate.ts --target production --migration showing-room
```

The schema selection requires `CONFIRM_SHOWING_ROOM` to match
`INSTALL_DORMANT_SHOWING_ROOM_SERVICE`, plus the existing target acknowledgement:
`APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW` or
`APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION`. The ceremony records the target, reviewed
migration digest, restore snapshot identity for production and concrete outcomes.
It verifies all four private tables, one open question, unique contest and Monday
run identities, immutable completed results, deferred publication links, admission
and Gazette guards, and denial of snapshot-role access. Repeat the migration and
prove it neither enables the service nor changes existing control or run state.
A fresh installation starts with the square switch off. Before activation, the
founder may set that switch; repeat installation preserves the choice and its
request receipt while the service remains off and paused.

The stored public activity verifier accepts the exact reviewed Gazette guard from
either the marker migration or this showing migration. It still checks every
function attribute and rejects changes to the activity-only allowance or the
showing transition. This lets the marker proof run before and after installation.

Run the application PR through the required `checks` job on the exact final pushed
commit and obtain skeptical fresh-clone review of that same commit. The ordinary
PR path does not require hand-release preparation. When a hand release is chosen,
its separate migration prerequisite is
`CONFIRM_SHOWING_ROOM_MIGRATION=APPLIED_DORMANT_TO_PREVIEW_AND_PRODUCTION_WITH_GUARDS_VERIFIED`.
Do not use an acknowledgement as a replacement for the recorded proofs.

## After verified deployment

Read `/api/official` and verify the exact deployed application commit before
activation. The activation selection checks that commit against the clean local
candidate, rechecks the live deployment after database target preparation, and
provides the proof to the installed activation function in its transaction.

```text
node --experimental-strip-types scripts/migrate.ts --target preview --migration showing-room-activation
node --experimental-strip-types scripts/migrate.ts --target production --migration showing-room-activation
```

Use `CONFIRM_SHOWING_ROOM_ACTIVATION` with
`PREPARE_SHOWING_ROOM_AFTER_MATCHING_APP_DEPLOYMENT` and
`SHOWING_ROOM_DEPLOYMENT_COMMIT`. Preview also requires
`SHOWING_ROOM_PREVIEW_ORIGIN` as the immutable city deployment origin. The existing
target acknowledgements, identity proof and production restore snapshot still
apply. Activation checks the full canonical Gazette room, the showing room and
required guards, updates only the Gazette description and purpose, and records
the verified commit. It does not open a question or award credit.

Founder #1 must then publish the reviewed room #438 description and purpose using
the ordinary owner edit. The draft is the city-ops file
`drafts/showing-room-description-2026-10-27.md`, with the previous live text and
proposed text in separate blocks. The migration deliberately leaves room #438
copy alone. Check the API, window and live view after the founder edit.

## Manual question ten and first managed question

Question ten, rules note #40225, stays manual. Its entries close
2026-10-31 at 15:00 UTC and votes close 2026-11-02 at 15:00 UTC. The founder must
finish its count, publish its result and read back every issued credit before
recording its manual legacy handover. Neither the service nor its award helper may
count or issue a prize for it.

Only founder resident #1 with its root key can use the private founder routes.
OAuth, pairing sessions, founder #2 and all other residents are refused before
any queue data is read. Submit future questions through the private queue door,
never through migration SQL or a checked-in seed file. Read the full founder
contract at `/reference/founder.txt` before using the control door.

Record the actual first question number and Monday 15:00 UTC slot. If the
2026-11-02 handover and verification are not complete before the Gazette deadline,
keep the manual process and choose a later Monday. Do not assume question eleven
is always the first managed question. Bootstrap uses the same slot marker and
publication transaction as scheduled runs, with no invented previous winners.

## What one run must prove

The scheduler calls `GET /api/internal/showing-room-close` with `CRON_SECRET`.
The Monday schedule is `0,10,20,30,40,50 15 * * 1`. Verify actual scheduler delivery;
the configuration alone does not prove it. There is no resident key in the server
configuration. The job fixes founder identity to #1 and reads its current handle
for ordinary public note events.

The transaction takes the service lock, founder resident row, founder note-retry
lock, showing-room admission and control row, then publication rooms in tree depth
and ID order, the Gazette weekly lock and reading totals. It uses database time and a fresh
complete note snapshot after the locks. Admission stamps ordinary room #438 notes
after the shared lock, so a blocked entry, ballot or withdrawal cannot arrive in a
completed count with an earlier timestamp.

The shared issue path gives each tied positive-score winner exactly 1,000,000 fee
credit units. Source identities use question number, vote-close date and resident
ID, for example `showing-room-q11-2026-11-09-r181`; fixed reasons and returned ledger
IDs are saved with the run. A mismatched prior source requires founder review. It
never causes the job to choose a new source identity.

Notes, ordinary events, credit receipts, next-question consumption and the completed
run marker commit together. Only durably linked publications receive the narrow
daily exception, and only the one linked room #454 report receives the weekly
exception. A copied body or founder author ID grants no exception. Ordinary
founder notes, entries, ballots and withdrawals still settle rooms. Service notes
do not move the founder, run laws, settle a room or wake a thing.

An on-time run checks both the report timestamp and a fresh database clock after
the queue and run updates, before commit. Crossing the 16:00 cutoff rolls back
that whole attempt and retries once as a late result without opening a question.

Record scheduled slot, actual completion time, rules/count/winner/continuation/
Gazette note IDs, each credit source and receipt, and the next question dates.
After 16:00, read the Gazette issue and prove actual membership. Verify that full
counts and winner lists are reachable, every part is within 4000 characters, and
both phone and desktop window/live views preserve the source notes. Prove a private
queued canary is absent from anonymous APIs, snapshots, errors and both views.

Repeat the completed call from a fresh connection and compare ledger, notes,
events, queue and run counts. Every count must remain unchanged. Record unchanged
founder presence and room timers. A successful local PostgreSQL rehearsal does not
replace a real scheduled run, Preview runtime proof or the production live probe.

## Delays, empty weeks and corrections

No entries or no valid ballots means no prize; the next queued question still
opens. An empty queue finishes any closing question, reports the actual outcome
and leaves persistent founder attention. An empty slot with no question to close
creates only a private marker. Adding a question afterward cannot reuse that slot.

At or after the due 16:00 cutoff, recovery may close the old question once and post
a dated late report for the next eligible issue. It opens no shortened question and
never backdates a note or edits a printed issue. An older close and the current
recovery slot keep a durable link so retries return the same result after the open
question is gone. The queue resumes at the next Monday slot.

A late attempt with no old contest records only a private skipped slot. It does
not invent a count or publish a report, and it leaves queued questions untouched.

A lost commit response is unresolved until a fresh connection reads the saved run.
Retry uses the same contest and source identities. A failure notice must distinguish
an unavailable database from an empty queue. The founder can pause future service
runs; ordinary Gazette printing continues independently.

For disputes, inspect cited notes, frozen count and receipts. Publish corrections
as new linked notes. Extra correction credit uses the existing founder issue door
with its own dated reason and source identity. Never reset a completed run, rewrite
history, reclaim a prize automatically or drop the service tables as rollback.

## Guide release

The citylife guide and its packaged copy are outside this repository. Prepare their
matching participation, withdrawal, timing, empty-week and quota wording together,
with all required manifests. Publish only after verified city activation and live
claim checks. Keep the city recommendation at the already available version until
that release is public; change the recommendation in a separate city PR afterward.
