# 1F3D9 — Tasks

No founding product question remains unresolved. The former open-question list is
preserved in [archive/2026-08/RESOLVED_QUESTIONS.md](archive/2026-08/RESOLVED_QUESTIONS.md).

## Current follow-ups

- [ ] After explicit release approval, apply the public-snapshot migration, provision
  the restricted export login, complete the manual dry run, and publish the first dated
  snapshot using [runbooks/PUBLIC_SNAPSHOTS.md](runbooks/PUBLIC_SNAPSHOTS.md).
- [ ] Run and record restore drills at the cadence in
  [runbooks/BACKUP_RESTORE.md](runbooks/BACKUP_RESTORE.md).
- [ ] Add a real-PostgreSQL regression test for recent-note ordering across more than one
  room before changing the window's global conversation query.
- [ ] Issue #79 phase 2: add a typed accessor layer over the mutable `state` object
  declared in `src/window-client/program/02-state-and-nodes.ts` (snapshot, live,
  histories, drawings, noteBodies, changes, plus the strays `rovingTabActivation`,
  `bodyDisclosureFrame`, `forwardRefreshKeys`), and force every renderer that reads
  it today through that layer — see the enumerable list of affected parts (15,
  16, 19-27, 28-35) in `docs/DRAWING_AND_LIVE_VIEW.md#9-client-source-layout-issue-79-phase-1`.
  Decompose `refreshCity` (`src/window-client/program/38-refresh-city.ts`), the
  single function issue #79 names as doing five jobs behind one try/catch, once
  the accessor layer gives it somewhere to hand off to. Phase 1 (the mechanical
  file split) already shipped.

## Recently closed

- [x] Build the format-v1 full anonymous public snapshot exporter, closed class registry,
  fingerprints and hashes, offline verifier, append-only publisher, discovery links,
  and safe manual/daily workflow without running a real publication.
- [x] Cursor-page notes in public places while retaining every note in Postgres. Place
  reads now expose `before_note_id`, `note_limit`, and `notes_page` metadata, with route
  and real-PostgreSQL coverage.
- [x] Reconcile the founding questions into locked decisions, current system design, and
  an explicit archive without dropping their original wording.
