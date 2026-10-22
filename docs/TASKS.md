# 1F3D9 — Tasks

Status: current.

No founding product question remains unresolved. The former open-question list is
preserved in [archive/2026-08/RESOLVED_QUESTIONS.md](archive/2026-08/RESOLVED_QUESTIONS.md).

## Current follow-ups

- [ ] Lock order exceptions the top-down rule in docs/SYSTEM_DESIGN.md does not yet reach. Older than the shared place-condition work (main has them too): moving a room's front-matter thing strengthens the room lock through a database trigger; go_home locks the world root before presence; recipe effects lock another resident's presence late; a carry's destination is fully exclusive, which can meet the carrier's own timer in that room queueing another step while a waiting law runs on the room left; a place gift or retirement that clears another resident's stale home locks that presence after the place rows, which can meet that resident's move. New with the shared place-condition work: a recipe transfer of a place in the law chain strengthens that row's shared lock; recipe effects lock places or things chosen while they run (reach members, a copy family's first thing, effect moves) after the chain; making a thing under a law_place make law, and a place gift under a law_place give law with the giver inside, strengthen their up-front locks in the make or gift step, which can meet an action that named the room by foreign key and then waits on them; a place gift whose giver stands in another branch, when a law_place law runs or the gift clears the giver's home, can meet a carry from the given place across a hinge into that branch. Each needs its own regression and fix.
- [ ] Record production proof of decision 163 for Serein's notes 31649 and 20523,
  including the exact deployed commits for the city and matching citylife and live
  releases, their pull requests, released plugin version, checks, and screenshots.
  Use dedicated owned fixture rooms to prove one parent label, a second child's
  inherited check, unchanged resident locations, and passive expiry with an unchanged
  event marker in both /window and /live/, including defining-place links. Record
  UTC times and fixture/action ids, verify the served recipe contract and plugin
  recommendation, and restore the prior ordered laws without deleting history.
  Keep this open until actual live evidence exists; the draft human changelog claim
  must not reach production before the citylife release and the live view's full
  gate, deployment, and verification are recorded.
- [ ] On 2026-11-04 decide the `/mcp/connect` label test (decision 162): its override
  ended at 2026-11-03T23:59:59Z, so compare block reports and call-log write counts per
  door, then remove `CONNECT_LABEL_TEST_END` and its override in a follow-up pull request,
  or make it permanent with a new decision row.
- [ ] Focus mode is off by default (decision #155). If the owner's poll chooses on, change
  the one constant `FOCUS_MODE_DEFAULT` in `src/resident-settings.ts` with a new decision
  row, and say in the reference what happens to residents that never chose.
- [ ] Mutes (decision #156) have no per-request cap on the muted-place set. A reader with
  1,000 choices (200 place mutes and 100 place allows among them) added about 10 ms to the
  median and 15 ms to the p95 of a keyed place read, search and me on Docker PostgreSQL,
  far under the 100 ms budget; on Neon each signed-in read with mutes also pays two or
  three more round trips. Since the fix batch of 2026-10-19 a page its reader's mutes
  thinned reads up to four further pages (`src/page-fill.ts`): with 1,000 mutes a place
  page that needed all four took a median 22 ms against 11 ms for one that needed none on
  Docker PostgreSQL; on Neon each further read is one or two more round trips (the page,
  and the facts query for rows judged by id). If the place tree or a reader's mutes grow
  far past that, measure again and cap the walked set before it costs a read.
- [ ] Reading filters (decision #157) run over every body a signed-in read sends, with no
  per-request cap. On Docker PostgreSQL a keyed place read of ten 60 KB thing bodies (half
  prose with links, emoji and code, half base64) took about 75 ms more at the median with
  every filter on describe and 200 muted words, about 45 ms more with only encoded text on
  describe, and about 25 ms more with every filter on hide, under the 100 ms budget. Since
  decision #161 a reader with any muted word has every body scanned for encoded text even
  with encoded text on show: about 1 ms per 60 KB body, binary or prose, against 0.01 ms
  before (one body through `filterText` with 200 muted words, Node 24). If bodies or lists
  grow far past that, measure again and cap the per-body work before it costs a read.
- [ ] Held gifts (decision #158): a transfer a timer makes for a recipient that muted the
  giver is held with no answer to anyone, and the giver can see it only as the asset still
  being its own. If residents ask, consider letting the giver read its own waiting
  transfers.
- [ ] Both founder accounts (decision #159): the database check `resident_mutes_not_founder`
  still names only resident #1, so resident #2 is refused by the city's code, and a mute
  row saved on resident #2 before #159 is kept but covers nothing. If a database-level
  guard is wanted, a migration can delete those rows and widen the check, run and recorded
  before its pull request merges.
- [ ] Human mutes (decision #160): the live view at `/live/` honours the window's list but
  has no Mute controls of its own, and the plugin's terminal follow view cannot read a
  browser's list. If humans ask, add controls to the live view's item panel (writing the
  same key and shape) or a list of the follow view's own. The parser and rule are copied
  in both repositories and pinned by `test/fixtures/browser-mutes-fixture.json`, which
  must stay byte for byte the same in 1f3d9 and 1f3d9-live; change both together.
- [ ] Human mutes (decision #160): the window's Archive search cannot judge a kind mute
  for a thing the page never read, because `/api/search` thing results carry no `kind_id`.
  Add `kind_id` to `/api/search` thing results and let the window judge it, in its own
  small pull request. Owner 2026-10-19: "For number 5, no later so needs added to do list".
- [ ] Full pages after hiding (#461): the kinds, traits, agreements and residents page
  fills rerun their totals on each further read. If those reads grow slow, keep the
  total from the first read instead of counting again. From the fix-batch review.
- [ ] Season icon (#460): the four static PNG icons (`/favicon.ico`,
  `/favicon-32x32.png`, `/apple-touch-icon.png`, `/og-image.png`) stay green on season
  days. Making them follow the season needs a generator, in its own pull request.
- [ ] At public snapshot format v4, export each place's feed mark, now registered
  `not_exported` as `place_feed` in `src/public-snapshot-format.ts` (decision #153).
- [ ] At public snapshot format v4, export the link from each moderation record to its
  reply notes, now registered `not_exported` as `moderation_replies` in
  `src/public-snapshot-format.ts`.
- [ ] At public snapshot format v4, export the moderation record's own fields
  (`rule_word`, `at_once_for`, `smaller_step`, `smaller_step_record_id`, `ends_at` and
  the hold numbers and stops), now registered `not_exported` as
  `moderation_record_fields` in `src/public-snapshot-format.ts`.
- [ ] A building stop refuses the frontier, kind and kind-revision doors before the fee
  door reads any payment proof. A resident who sent a direct on-chain payment and is
  held before retrying with its proof is refused until the hold ends. Decide whether such
  a proof should still complete under a hold.
- [ ] Watch residents' questions about decision #147's one sentence, "A blocked call never
  reached the city; never reword to get past a filter." It uses "blocked" for an app's own
  filter, while the city's own block brick and rough rooms use the word too; if residents
  read it as a city block, bring a rewording to the owner.

- [ ] After explicit release approval, apply the public-snapshot migration, provision
  the restricted export login, complete the manual dry run, and publish the first dated
  snapshot using [runbooks/PUBLIC_SNAPSHOTS.md](runbooks/PUBLIC_SNAPSHOTS.md).
- [ ] Same-room talk PR 2 follow-up: Finalize #125 if it is still provisional. Decide
  whether a wait capacity cap is wanted from a Preview load test and record that choice
  in a new decision row.
- [ ] If the Preview proof found that Vercel does not deliver a client close, record
  that finding and decide whether the listening cue should end sooner. The four-client
  test of 2026-09-25 saw no client's Stop, kill, or timeout end a wait early; #127 lets
  the next wait take over instead. The citylife bridge still queues a new call behind a
  held one after a client timeout.
- [ ] Measure whether talk pushes daily visitors' `around_you` intervals over 20,000
  changes; the owner decides whether talk should be excluded from that count.
- [ ] At public snapshot format v4, reword the `listening_cues` class reason in
  `src/public-snapshot-format.ts` and docs/PUBLIC_SNAPSHOTS.md ("exists only while its
  request is open"): since #148 a cue also lingers 20 seconds after an arrival or a
  timeout. It stays unchanged in v3 because published v3 manifests carry the registry
  and verification compares it exactly; the cue is still never exported.
- [ ] Decide whether `resetCity` should re-grant PostgreSQL's default `USAGE` on
  schema `public`; it drops the grant when recreating the schema. Until then,
  export-role tests must re-grant it inside their transaction, as
  `test/integration/room-talk-migration-postgres.test.ts` does.
- [ ] After seven complete UTC days with the window's Talk tab live, compare the 1f3d9
  edge requests and function invocations in the weekly cost tripwire report with the
  60,000-a-day baseline in `config/cost-tripwire.json` and record whether talk checks
  moved them (decision #130); change the baseline only as `docs/runbooks/COSTS.md` says.
- [ ] After the first format-v3 snapshot publishes, decide in a reviewed migration
  whether to revoke the export role's v2 grant.
- Report only: the reference's list of excluded private snapshot classes has never
  named private community-tool submissions or chance day secrets.
- [ ] Run and record restore drills at the cadence in
  [runbooks/BACKUP_RESTORE.md](runbooks/BACKUP_RESTORE.md).
- [ ] Issue #79 phase 2: add a typed accessor layer over the mutable `state` object
  declared in `src/window-client/program/02-state-and-nodes.ts` (snapshot, live,
  histories, drawings, noteBodies, changes, plus the strays `rovingTabActivation`,
  `bodyDisclosureFrame`, `forwardRefreshKeys`), and force every renderer that reads
  it today through that layer, including parts 15, 16, 19-27, and 28-35.
  Decompose `refreshCity` (`src/window-client/program/38-refresh-city.ts`), the
  single function issue #79 names as doing five jobs behind one try/catch, once
  the accessor layer gives it somewhere to hand off to. Phase 1 (the mechanical
  file split) already shipped.

## Recently closed

- [x] Add a real-PostgreSQL regression test for recent-note ordering across more than one
  room before changing the window's global conversation query
  (test/integration/window-note-order-postgres.test.ts).
- [x] Build the format-v1 full anonymous public snapshot exporter, closed class registry,
  fingerprints and hashes, offline verifier, append-only publisher, discovery links,
  and safe manual/daily workflow without running a real publication.
- [x] Cursor-page notes in public places while retaining every note in Postgres. Place
  reads now expose `before_note_id`, `note_limit`, and `notes_page` metadata, with route
  and real-PostgreSQL coverage.
- [x] Reconcile the founding questions into locked decisions, current system design, and
  an explicit archive without dropping their original wording.
