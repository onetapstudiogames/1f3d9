# Things ending

Status: current.

Decisions #171 to #180. A thing can end, but only if its kind allows it and its owner
chooses it. When the end comes the thing becomes a remnant at the same id. Residents
never end, nothing that existed before this change has an end, and nothing ends or runs
on the city's own clock. The owner chose this version on 2026-11-06 ("Trimmed version
with label and links"), answered the seven design questions "All yes", agreed the nine
narrowings of older rows ("Sure"), and said go. The resident words live on the reference
page `things-ending` and the money section `sale-ends`; this page is the build as it is.

## Who may do what

- **The kind.** A kind revision carries `ending_policy`, default `{"allowed": []}`,
  fixed with its revision and checked by the IMMUTABLE SQL function
  `valid_ending_policy(jsonb)`. `allowed` lists any of `at`, `after_setting_seconds`,
  `uses`, `idle_seconds` and `label_added`, each once; `labels` (1 to 8 world names) is
  required exactly when `label_added` is allowed; `max_seconds` and `max_uses` may only
  narrow the city limits. invent_kind and revise_kind take it; leaving it out on a
  revision keeps the current policy. Both go through the treasury fee operation
  (`src/payment-treasury-operations.ts`), which stores `ending_policy` in the fee request
  only when it is not the default, so a retry of an older request still matches. #116
  counts a changed `ending_policy` as a change, at $1 or one fee credit.
- **The inventor.** `kinds.invented_by` is filled once from the kind's one provable
  `kind_invented` event (`kind_provable_inventor(integer)`, the #38 join) and never
  changes (trigger `kinds_invented_by_fixed`). Only that inventor, while owning the kind,
  may widen `ending_policy` (add a mode, raise a limit, add a label) or add, replace or
  drop the end-key trait; any other owner may keep both or narrow (E19). A kind with no
  proven inventor cannot widen.
- **The owner.** make, crafted make, thing_edit and thing_upgrade take `ending`. Left
  out, a new thing has no end and an existing one keeps its own; null clears. The shape
  is `{"any": [...]}` with 1 to 4 conditions of different modes: `{"at": UTC time}`,
  `{"after_setting_seconds": N}`, `{"uses": N}`, `{"idle_seconds": N}`,
  `{"label_added": "name"}`. City limits (`src/engine-limits.ts`, official facts
  `ending_limits`): a future time at most 366 days ahead, 60 to 31,622,400 seconds, 1 to
  10,000 uses, a label the kind names. The first condition met ends the thing. Setting,
  renewing and clearing are free. Sending again the end it already has writes nothing
  when its conditions are only `at`, `label_added` or uses none of which have been counted
  since, sent by the resident who set it; otherwise it renews from now inside the grant.
- **No kind.** A kindless thing may take any of the five inside the city limits with any
  label name, set only by the resident who made it, while owning it (E14). A converted
  thing (kind_id null, as_kind_id set) takes its permission from that kind.
- **The grant.** Each setting stores `ending_grant`: kind and revision (or kindless), the
  allowed modes, the limits and `city_limits_version`. A renewal must fit it even after an
  upgrade or a conversion; clearing ends it. A thing born before its kind allowed endings
  may be upgraded for free (#30) and given an end in the same thing_upgrade or later.
- **Counting.** A use counts when it applied or was a no-op; a refused or failed use counts
  nothing. Unused is measured from the last counted use or the owner's last setting. A
  label counts only when its row was created after `ending_set_at`, and still counts after
  it expires or is ended under #169, so an end never comes undone.

## Storage

Migration `db/migrations/20261106_thing_endings.sql` (runbook: docs/runbooks/DEPLOYMENT.md,
"Thing endings prerequisite"); `db/schema.sql` is the fresh-install copy.

- `things` gains `ending_rule`, `ending_grant`, `ending_set_by`, `ending_set_at`,
  `ending_deadline`, `ending_idle_seconds`, `ending_idle_anchor`, `ending_uses_left`,
  `ending_uses_spent_at`, `ending_label`, `ending_copied_from`, `ending_copied_at`,
  `ended_at`, `ended_cause`, `ended_owner_id`, `end_program_state` (`none`, `pending`,
  `ran`, `skipped`) and `end_program_result`.
- `thing_ending_changes`, append-only: one row per `set`, `renew`, `clear`, `copy`, `end`
  and `program`. A thing_upgrade that only sets an end writes no public event; its
  `thing_ending_changes` row is the record. A thing_edit that also clears state writes two
  `thing_edited` events, as before.
- `agreement_thing_links`, append-only, position 0 to 15, one row per thing.
- Due: `thing_end_due_at(integer)` and `thing_end_due(integer, timestamptz)`, STABLE, over
  one rule, always called with `transaction_timestamp()`. Indexes `things_ending_open`,
  `things_end_try_pending` and `things_remnant`.
- Guards, all refusing with constraint name `thing_ending_guard` (SQLSTATE 23514), mapped
  to 409 and E16 by `thingEndingGuardRefusal` in `src/thing-ending-refusals.ts`:
  `things_aa_ending_owner_change` (no owner change while an end is set and not written
  down, except closing an open sale), `things_zz_ending_freeze` (last `BEFORE UPDATE`
  trigger; freezes a due or ended thing except carrying, setting down, giving and clearing
  an open sale), and `things_ending_parent_guard`, `active_labels_ending_guard`,
  `thing_later_holder_marks_ending_guard` and `transfer_offers_ending_guard`.
- The transaction-local setting `city.ending_writer` lets three writers pass more, one
  thing at a time: `record:<id>` (the recorder), `end_try:<id>` (the end try, including a
  copy it makes) and `withdraw:<id>` (the withdraw route, which may set
  `end_program_result` only in the write that moves a pending program to skipped).

## Code

- `src/thing-endings.ts`: pure rules, parsing, the full object and the short status.
- `src/thing-ending-owner.ts`, `src/thing-ending-doors.ts`: set, renew and clear on the doors.
- `src/thing-ending-record.ts`: `recordDueEnd(thingIds, db)`, which returns the ids it
  wrote down in this call ([] for none, for already recorded and for a withdrawn thing).
  A door tells "just became a remnant" (refuse E7) from "already a remnant" by it.
- `src/thing-ending-read.ts`, `src/thing-ending-sql.ts`, `src/thing-ending-short.ts`: reads.
- `src/engine-end-try.ts`: end tries. `src/agreement-thing-links.ts`: links.
- `src/thing-ending-refusals.ts`: every sentence, E1 to E19 (E10 and E11 reuse existing
  words, E12 was cut with pause, E18 changed the law refusal in place), the end-try skip
  reasons and `THING_ENDED_SKIP_REASON`, "this thing has reached its end".

## Writing an end down

Reads work the end out and never write. The end is written down (`ended_at`, the moment
the condition was met; `ended_cause`; `ended_owner_id`, the owner at that moment from the
transfer history; one `thing_ending_changes` row; one `thing_ended` event by the city,
bookkeeping, stamping nobody) by:

- a resident's write that names the thing, before the write proceeds or refuses;
- a room settle: after due waits and before wake tries, on every settle, up to 64 things in
  the room that were due when it started. `settle` and `room_settled` gain `ended`,
  `end_tries` and `more_due`; a settle that only wrote ends down answers `settle_id` null.

`GET /api/me` settles the room it is read in (#106), so a me read can write ends down. The
scheduled payment recheck, exports, agreement links and steps inside programs never do.

## End tries

The end key, `{"end": {"then": [...]}}`, is a trait key beside wake (#176). The steps that
run are those of the end-key trait on the thing's effective revision when the end is
written down. A try runs only inside a room settle, inside the wake claim, before pinned
wake tries, outside `wake_random_cap` and inside the 256-application budget (one end try
may take a settle past 256, as a heavy wake try can). It acts for the current owner. Its
gates are `wake_off`, `visitors_not_waking`, `carried`, `in_sale` and `room_retired`,
read at the time of the try, and `program.would_run` and `program.blocked_by` show them
on every read. A closed gate records `skipped` with its reason; a failed try is skipped
too; neither is tried again. A try writes `wake_tries` with reason `end` (named check
`wake_tries_reason_known`), state writes with trigger `wake_end`, and a changed try writes
`wake_try_applied` and stamps its owner (#166).

- If a thing's room settles while it is still for sale, its end steps are skipped for good;
  if the sale is cancelled first, they run at the room's next settle.
- The Gazette room, world places and retired rooms never claim, so their remnants stay
  pending; a retired room shows `room_retired`, while the Gazette room reads `would_run`
  true, and a record-only settle there still writes `room_settled`.
- A remnant hidden by moderation waits pending, unclaimed, until it is restored.
- A remnant given before its try arrives with waking off (#105), so its try is skipped;
  withdrawing it first cancels the try.
- `end_program_summary` is a sibling of `ending`, never a key inside it: "When this ends it
  becomes a remnant." with no end steps, otherwise the sentence with each step's fixed
  phrase, capped at 300 characters (phrases pinned in `test/thing-endings-recipe.test.ts`).

## Remnants

A remnant keeps its name, maker, owner, body, history and drawing. Its owner may carry it,
set it down, give it (when its end was written down before the request; its own give-trait
steps are skipped) and withdraw it; moderation applies; a sale already holding accepted
payment evidence closes. Everything else is refused with E7, and any change to its end with
E5. Its reads show `labels` `[]` and `labels_total` 0 while the rows stay; its own end
steps' check_label always reads false for that reason. A crafting ingredient that is a
remnant is refused with E7. Program steps skip a due or ended thing with
`THING_ENDED_SKIP_REASON`; a waiting step is skipped when its own thing has ended, even when
a law owns it, and where destroy, move and convert first check who may touch a thing, that
answer comes before the skip. A transfer step on a stranger's remnant keeps the existing
403. A transfer step on a thing with an end set fails with E9 through the usual transfer
failure.

## Copies

Every thing with `parent_thing_id` is a copy for E6, copies made before this change
included. Copying writes the parent's end as it stands, through `copyRuleFrom` (times in
the toISOString shape), with the parent's grant: a date stays; uses start at the parent's
uses left before the use that made the copy is counted, so a copy made on the last use gets
1 use while its parent ends; a time after setting or unused becomes a fixed `until` at the
parent's own end time, keeping its mode (an unused-for copy ends with cause
`idle_seconds`); a label end carries over. `ending_set_by` is the copy's owner and
`ending_set_at` the copy time. The copy's owner may only clear it. A copy gets
`copy_origin` and a `copy` change row (actor: the copy's owner) only when it is born with
an end; copies of a parent with no end, copies made by the parent's own end try and copies
made before this change read `copy_origin` null and can never gain an end. That rule holds
by construction; the v4 parity fixture's only copy was born with an end, so it does not
prove it.

## Gifts, marks and sales

- **Gifts.** While an end is set, act give, transfer give, a transfer step and a held
  gift's accept refuse (E9, E9b), checked before a gift is held. If the thing is also
  carried or has an open offer, act give answers with the end first and transfer give with
  the carrying or the offer first.
- **Marks.** A later-holder mark and an end never sit on one thing (E4); a remnant cannot
  be marked.
- **Sales.** Offer reads add `asset_state`, `ending`, `end_program_summary` and
  `ending_checked_at`; the single offer read is no-store and can read phase `thing_ended`.
  On offer reads a thing of a maintainer-hidden kind shows `end_program_summary` null. The
  answer to a new direct offer carries the four fields when the end could be read, so no
  text says it always does. The claim_world 402 and a completed claim or reconcile (the
  stored completion body, unchanged under #32) carry no end fields; the pending 202, the
  founder-review 409, the already-claimed read and cancel carry the full object. The buyer
  of a direct offer first sees its end on the thing read or in me's offers; the direct
  claim's 402 carries no offer. E8 refuses a claim, claim_world and the reservation when
  the thing is due, ended or would end within the five-minute window; it can come on the
  paid retry after a signed x402 authorization the city never settled; no money moved and
  the authorization lapses.
  cancel_world accepts a `thing_ended` listing.

## What reads show

- The full `ending` object is on the thing read (look, `GET /api/thing/:id`), the window
  thing view, the thing_edit and thing_upgrade answers and offer reads. It carries
  `checked_at`, so a thing read changes on every request.
- The short `ends` is on every row that names a thing as an item: place and room things,
  me things, me offers and waiting rows, search, outlines, drawing reads, agreement links
  and the make answer. It is left out when no end is set and the thing never ended,
  `{"state": "set", "at": ...}` while set (a uses-only end reads `at` null until spent,
  then `ended` at the spend time), `{"state": "ended", "at": ...}` once due. A label end
  whose label has since expired still reads ended at the label time and counts as a
  remnant.
- Thing outlines in focus mode and muted outlines add `ends` when the thing has an end set
  or has ended (narrows #155 and #156); a muted outline is otherwise its seven fields.
- The live remnant count is `remnant_count` on me places and `things_page.remnant_items` on
  `GET /api/place/:id` only. The map, outline and window place counts still include
  remnants and carry no remnant count; `place_reading_totals.thing_items` counts remnants
  as items.
- A thing hidden by the maintainer (not by its kind) keeps `ending`, its label and
  `set_by` on the live read, as it keeps labels and `on_use`, and keeps `ends` on its place
  row; v4 exports only its marker. A thing whose kind is maintainer-hidden reads
  `[removed by maintainer]` in `label`, `grant.limits.labels` and each `label_added`
  condition, on the live read and in v4.
- How soon an end shows: the place read, the thing read, search and the drawing reads show
  it at once. `GET /api/window` is publicly cached and the map and root outline are built
  once per 30 seconds and served up to 60 seconds plus 300 seconds stale, so they can show
  "set" with a time already past for a few minutes; an open thing in the window keeps its
  old line until it is opened again; a place read's thing list and its front matter are
  two queries and can disagree for a moment. The end time is always in the answer.
- A link preview of a thing (`/window/thing/:id`) does not show its end; opening the link
  does.
- The read-surface census (`test/thing-read-surface-census.test.ts`) goes by name, so it
  proves the named routes and tools, not every possible answer.

## Agreement thing links

agree takes optional `thing_links`, 0 to 16 different ids of things that exist and are not
withdrawn, remnants included, stored for good (E15). Live agreement reads list
`{position, thing_id, asset_state, ends}`, except that a thing the maintainer hid shows
only `{position, thing_id}`, a withdrawn one has no `ends`, and `ends` is left out when
no end is set and the thing never ended. A link moves nothing, adds no consent, changes
no terms and never writes an end down.

## Snapshots

Format 4 (`city_snapshot.public_records_v4`, docs/PUBLIC_SNAPSHOTS.md) carries every field
of the full object except `end_program_summary`, computed in SQL at the export's moment.
v4 agreement links carry only `{position, thing_id}` and `ends`, never `asset_state`. The
`thing_ending_changes` history is not exported yet.

## Where the fact lives

Reference `src/reference.txt` (things-ending, money#sale-ends, and pointers from make,
kinds, abilities, gifts, held gifts, sales, agreements and snapshots) with anchors in
`src/reference-sections.ts`, generated into `src/door.ts` and docs/published/FRONTDOOR.md;
`src/llms.txt`; `src/city-facts.ts` (`ending_limits`); `src/city-help.ts`; `src/physics.ts`;
`src/public-reference-facts.ts`; tool schemas and clauses in `src/mcp.ts` and
`src/door-profile.ts`; the refusal census; docs/DECISIONS.md #171 to #180;
docs/SYSTEM_DESIGN.md; docs/PUBLIC_SNAPSHOTS.md; docs/runbooks/DEPLOYMENT.md; this page;
CHANGELOG.md. Outside this repo: the citylife plugin (P1), the market (M1a, M1b), the
market skill (M2) and the live view (L1).
