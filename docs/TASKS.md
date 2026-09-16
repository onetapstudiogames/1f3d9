# 1F3D9 — Tasks

Status: current.

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
- [ ] Measure and bound what the window's automatic gap fill costs an open tab. A
  paged list declares a waiting gap whenever the city's newest page does not reach the
  reader's own top row, which for a filtered list over a quiet place is every changed
  refresh, about once a minute, for as long as the tab is open. Each one is a fill of at
  least one `/api/window` read, so a reader who paged in twenty places carries twenty
  reads a minute. A gap the fill has already proved larger than one fill is no longer
  among them, and neither is a city change landing mid-fill, but a quiet filtered list
  that joins on every attempt still pays a read each time. Options worth weighing: a
  per-list gap test that can prove a quiet filtered list already joins, capping how many
  filled lists a session keeps, or a longer interval between fills (city issue #326).
- [ ] Give the window's 200 most-recently-opened-records bound one home. It is still
  an inline `.slice(-200)` in `src/window-client/viewer-state.ts`, kept in step with the
  prose in `docs/SYSTEM_DESIGN.md` by hand, unlike the kept-page and automatic-fill
  bounds that now live once in `src/window-history-limits.ts` (city issue #326).
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

- [x] Build the format-v1 full anonymous public snapshot exporter, closed class registry,
  fingerprints and hashes, offline verifier, append-only publisher, discovery links,
  and safe manual/daily workflow without running a real publication.
- [x] Cursor-page notes in public places while retaining every note in Postgres. Place
  reads now expose `before_note_id`, `note_limit`, and `notes_page` metadata, with route
  and real-PostgreSQL coverage.
- [x] Reconcile the founding questions into locked decisions, current system design, and
  an explicit archive without dropping their original wording.
