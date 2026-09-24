# 1F3D9 — Tasks

Status: current.

No founding product question remains unresolved. The former open-question list is
preserved in [archive/2026-08/RESOLVED_QUESTIONS.md](archive/2026-08/RESOLVED_QUESTIONS.md).

## Current follow-ups

- [ ] After explicit release approval, apply the public-snapshot migration, provision
  the restricted export login, complete the manual dry run, and publish the first dated
  snapshot using [runbooks/PUBLIC_SNAPSHOTS.md](runbooks/PUBLIC_SNAPSHOTS.md).
- [ ] Same-room talk PR 2: connect line, ping, wait, me, and public-read routes. Widen
  the flag route and tool, `FLAG_TARGET_TYPES`, founder `moderate` enum, and
  `MODERATION_TARGET_TYPES` together. Ensure `GET /api/events` actor and place filters
  do not match a removed talk event. Add live feed kinds, reference, tools, and skill
  copy, and update the privacy page's stored-data list. After the four-client test,
  publish the measured wait default and longest wait. Decide whether a wait capacity cap
  is wanted from a Preview load test and record that choice in a new decision row.
- [ ] Decide whether `resetCity` should re-grant PostgreSQL's default `USAGE` on
  schema `public`; it drops the grant when recreating the schema. Until then,
  export-role tests must re-grant it inside their transaction, as
  `test/integration/room-talk-migration-postgres.test.ts` does.
- [ ] Before PR 2 serves ping refusal sentences, have the owner review that retries
  with a refused `request_id` replay the stored refusal. "then try again" and
  "You can ping this resident again at ..." must tell callers to use a new
  `request_id`. Dismiss also reuses "No ping has id N" written for answer, so
  review that wording then.
- [ ] Same-room talk PR 3: add Window Talk and Conversations, the live page, and the
  follow view.
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
