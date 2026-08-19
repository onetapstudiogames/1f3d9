# Audit outcome plan — 2026-08-15

This plan is based on all 26 category audits and all three whole-site audits.
It preserves the original item numbers below; `A` is the one additional outcome
that survived review.

## Delivery rules

1. Work from the top down. Investigate each problem before choosing the smallest
   durable change that makes the outcome true.
2. Prove the failure, cover the connected paths, review the result independently,
   and deploy that fix as soon as it is verified. Do not hold fixes for one large
   release.
3. Any change to public behavior or an API ships with the matching front-door,
   MCP, skill, and documentation changes. Item 11 is one coordinated truth
   release; item 3 ships with the identity behavior and its truth surfaces.
4. If an outcome would require a meaningfully harder product or system, stop and
   bring back the tradeoff. New state is justified for payment custody, identity
   recovery, and real backups; it is not permission for a wider redesign.
5. Cleanup is part of done. The next wave does not start until the current wave's
   cleanup gate passes.

## Cleanup gate used after every wave

**Problem:** Agent work can leave scratch files, test output, local services,
containers, helper processes, temporary worktrees, branches, and provider previews
behind after the verified change has shipped.

**Outcome:** At the end of each wave, only intended durable changes and pre-existing
user work remain. Everything created for completed work is removed or has a named
owner, purpose, and expiry. The cleanup record includes a clean process check,
workspace status, temporary-file check, and provider-preview check. Unknown user
work is never deleted, and no process or shared resource is stopped without proven
ownership. If a repeatable test or script created the residue, its own cleanup is
fixed before the gate passes; manually sweeping the same leak after every run is
not a durable cleanup.

## Baseline cleanup before Wave 1

**Problem:** The audits left a fake backup file, Playwright output, and thousands
of `1f3d9-deploy-*` fixture directories in Windows Temp. The deployment-safety
tests create these directories without removing them.

**Outcome:** Remove only the proven generated residue, make the repeating fixture
clean itself up, and verify that no audit-owned helper process or worktree remains.
Keep all audit reports and any pre-existing or ambiguously owned user files.

## Facts checked before ordering the work

| Question | Verified answer on 2026-08-15 |
|---|---|
| What Neon plan are we on? | `neon-cyclamen-school` is on Neon's **Launch** plan, not Free. Launch is usage-based and currently includes 10 concurrent branches. |
| What is keeping Neon active? | Production traffic is the main continuing driver: the live app made about 155,000 Neon `/sql` calls in the trailing 12 hours. In Neon's accumulated branch metrics, `main` and the shipped world-root preview account for 89.8% of active time. Frequent queries keep resetting scale-to-zero. |
| Are all 10 Neon branches needed? | No. `main` and the current working preview are the only clear current needs. The other eight are cleanup candidates after one final check for unmerged work or restore dependencies; several already have expiry dates. |
| What is driving Vercel observability cost? | The current cycle shows 2.05 million observability events and $2.43 of observability usage. `1f3d9` produced 87.9% of the events, and external API requests produced 70.1% of its events. The dominant external destination is Neon SQL, so database request volume is driving both providers. |
| Is `1f3d9-world-root-preview` still needed? | No current dependency was found. It has no Git connection, no custom domain, only rollout-era deployments, and no current code or docs reference it. World root is live in the main production project, so item 19 can remove it after recording the final project identity. |

## Wave 1 — prevent irreversible loss

### A. Preview isolation — added from the audits

**Problem:** A Vercel preview without its own database setting can fall back to
the production database, so testing a later fix could change the live city.

**Outcome:** Every non-production environment uses an explicitly assigned
non-production database or fails closed. It must never read, write, or advertise
production through a fallback, without adding a new environment framework.

### 1. Payment ownership and completion

**Problem:** Money can settle before the city has a durable claim to finish, a
payment can be claimed by the wrong actor or purpose, and successful but
unfinalized chain evidence can be accepted.

**Outcome:** Every paid operation across frontier, kind, direct, and world sales
has one durable result. A payment is final, globally single-use, and bound to the
right resident, purpose, asset, amount, and recipient; an ambiguous completion is
reconciled to its canonical result and is never presented as a safe retry.

### 2. Two-step signup and later recovery

**Problem:** Signup creates a resident before the caller proves the permanent key
was safely kept, and a key lost later has no resident-controlled recovery path.

**Outcome:** A resident exists only after the caller confirms possession of the
new key. One-use recovery codes can later replace a lost key, with only protected
proofs stored by the city. Existing locked-out residents remain a manual case.

### 3. Keep permanent keys out of agent transcripts

**Problem:** The local skill sends agents through MCP registration, which returns
the permanent key as ordinary model-visible tool output and routine log material.

**Outcome:** Registration and recovery capture permanent keys outside model
output, transcripts, and ordinary logs. The canonical external `1f3d9-citylife`
skill and every shipped copy stop directing agents to the unsafe route and ship
with item 2 and its matching docs.

### 6. Rotation ends every old sign-in

**Problem:** Rotating the permanent key leaves hosted-chat access alive, and two
simultaneous rotations can both appear successful even though only one key works.

**Outcome:** Rotation or recovery has one winner and one replacement identity.
The prior root key, delegated sessions, refresh access, and superseded recovery
material all stop working together, while unrelated residents remain untouched.

### Wave 1 cleanup gate

Meet the shared cleanup outcome above before Wave 2 begins.

## Wave 2 — make recovery and live changes dependable

### 5. One real backup and a proven restore

**Problem:** The current export can mix different moments and there is no restore
path proven to rebuild a usable city.

**Outcome:** A backup represents one coherent point in time, has a named target
and integrity evidence, and restores successfully into an isolated target during
a repeatable drill. Diagnostic JSON may remain, but it is not called a backup.

### 14. One credential-safety boundary for public text

**Problem:** Historical notes with key-shaped text can escape through plain-text
readers, while some other public names and recipe-like fields bypass newer guards.

**Outcome:** The same secret-safe rule covers every public HTTP, window, place,
and MCP read and every public text write. A safe production check identifies any
affected residents without printing the text, and any still-live exposed key is
revoked through the identity lifecycle rather than copied into incident records.

### 15. Time-bounded migrations

**Problem:** A migration can wait on or hold a live database lock indefinitely,
freezing ordinary city writes during a bad deploy.

**Outcome:** Every migration path has short, enforced wait and work limits and
fails safely when the city is busy. Deployment and recovery guidance must make a
timeout diagnosable without encouraging an unsafe blind retry.

### 16. Sign-in data retention

**Problem:** Authorization requests, codes, token families, and session records
are kept forever and copied into every backup.

**Outcome:** Each sign-in record type has a short, documented retention period
based on expiry and real incident needs. Expired, used, and revoked records are
removed on schedule, and backup retention does not quietly defeat that policy.

### 9. Honest collision and ambiguous-result responses

**Problem:** Ordinary concurrent collisions surface as server failures, while a
rarer engine failure can be reported after the action already succeeded.

**Outcome:** A real collision is a plain retryable conflict. A result whose commit
is uncertain resolves to the one canonical outcome and never tells the caller to
repeat an action that may already have happened. This does not expand into the
other deliberately deferred physics races.

### Wave 2 cleanup gate

Meet the shared cleanup outcome above before Wave 3 begins.

**Record — passed 2026-08-18.** All five Wave 2 items shipped through reviewed
pull requests #31–#35; production verified healthy after each deploy.

- *Workspace:* clean tree on `main`; every wave-2 branch verified
  byte-identical to its shipped squash commit, then deleted locally and on
  origin (5 ship branches, 2 codex source branches). Both agent worktrees
  removed and pruned. Local branches merged during Wave 1 deleted (8).
- *Stashes:* all six wave-1 stashes exported as patches to
  `C:\Users\Owner\Documents\1f3d9-archive\stashes-20260818\` (owner: founder;
  purpose: recovery copies; delete after 2026-09-18), then cleared.
- *Temporary files:* all `1f3d9-*` residue in Windows Temp removed (audit-era
  diagnostics plus two leaked deploy-fixture clusters). Root cause of the new
  leak: review agents ran the old codex branches, whose test script predates
  the isolated runner on `main`; a passing run of the current suite was
  verified to leave zero residue, and the leaking branches no longer exist,
  so no code change was needed.
- *Processes and containers:* the dead `1f3d9-oauth-gate-20260813` container
  was removed; no container with a `com.1f3d9` label remains. No running
  process references 1f3d9; the other node processes on the machine belong to
  unrelated sessions and were not touched.
- *Providers:* no Neon branch was created during this wave. Vercel PR preview
  deployments follow Vercel's own retention.
- *Kept with owner and expiry:* six unmerged wave-1 archaeology branches
  (`archive/initial-recovery-codes-*`, `codex/initial-recovery-codes-chatgpt`,
  `codex/wave1-byte-replay`, `codex/wave1-main-20260816`,
  `codex/wave1-production-repair`) — owner: founder; review or delete by
  2026-09-18. Locally excluded operator files (`scripts/backup.mjs`,
  `scripts/restore-key.mjs`, `backups/`, `.tmp-*` env files,
  `.release-backups/`) are pre-existing user work, untouched.
- *Wave 1 gate:* never separately recorded; its residue (stashes, merged
  branches, temp diagnostics, dead container) was inventoried and resolved as
  part of this record.

**Operator actions — completed 2026-08-18.** The production backup and
isolated restore drill ran and passed (evidence in
`docs/runbooks/BACKUP_RESTORE.md`), closing item 5. The
`signin-retention` migration was applied to production after its verified
pre-snapshot `snap-falling-feather-avmgu9mn` (no preview branch existed to
rehearse on; the change was three additive indexes under enforced time
limits). Wave 2 is closed in full.

## Wave 3 — make the public and agent contract truthful

### 11. One coordinated truth release

**Problem:** The front door misstates global notes, anonymous flags, permanent
withdrawal, and current ChatGPT setup. `/api/action` omits the correct endpoint
for talk and make, while MCP advertises them in the wrong menu; malformed
destructive MCP actions can also fall through to a different action.

**Outcome:** The front door, `/llms.txt`, generated and injected copies, API errors,
MCP schemas, every shipped copy of the external skill, docs, and tests all
describe the same live city in one release. Talk names `/api/note`, make names
`/api/thing`, neither appears in the MCP act menu, invalid actions reject plainly,
and ChatGPT setup leads with the
[current official OpenAI plugin guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
instead of fragile local menu instructions.

### 12. Tell agents that `me` can change state

**Problem:** MCP marks checking your own status as safe and read-only even though
the call can resolve due city effects.

**Outcome:** MCP metadata and docs describe `me` as state-changing. Do not split
out a second read-only status system unless later evidence shows enough value to
justify that extra concept.

### 13. Useful MCP errors without sensitive detail

**Problem:** MCP flattens caller mistakes, conflicts, payment needs, limits, and
city failures into nearly indistinguishable tool errors.

**Outcome:** Both MCP doors expose a small, stable set of machine-readable failure
classes so an agent knows whether to correct, authenticate, wait, reconcile, or
report a city fault. Raw downstream bodies, secrets, database details, and other
private operational facts never become error metadata.

### 10. A resident flag limit

**Problem:** Signed-in residents can create unlimited flag rows even though other
write surfaces and anonymous flagging are bounded.

**Outcome:** Resident flagging has a consistent, deliberately generous limit that
blocks abuse without changing normal reporting. The existing anonymous boundary
and moderation meaning stay intact.

### 4. Briefly cache the map, then measure

**Problem:** Every `/api/map` request rebuilds the whole city and repeats many
database reads even when nothing relevant changed.

**Outcome:** The existing map response receives a short public cache first. Keep
its shape and city model simple; measure the result before considering deeper
query, pagination, or invalidation work.

Other public-read findings from the live check:

- `/api/place/:id` is uncached, busy, and performs several reads. Its signed-in
  form can change state, so only a proven anonymous cache boundary should be
  considered later.
- `/treasury` is uncached and makes an external Base request, but current traffic
  is low; it is a measurement candidate, not an added project.
- `/api/window` already has a short cache. `/api/events` is uncached and busy but
  bounded; it remains unchanged as requested.

### Wave 3 cleanup gate

Meet the shared cleanup outcome above before Wave 4 begins.

**Record — passed 2026-08-18.** All five Wave 3 items shipped through reviewed
pull requests #40–#44, each independently adversarially reviewed, gated with
`deploy.sh --prepare`, verified on its Vercel preview, squash-merged, and
verified live in production after deploy:

- *Item 11* (#40) — the coordinated truth release, plus the matching external
  skill release (onetapstudiogames/1f3d9-citylife#2) merged immediately after
  the city deploy.
- *Item 12* (#41) — `me` (and `look`) advertise honest annotations; a resolved
  timer can run any effect brick, so both carry `destructiveHint: true`.
- *Item 13* (#42) — stable machine-readable MCP `error_class` set on both
  doors, derived only from HTTP status or transport state.
- *Item 10* (#43) — resident flags bounded at 20/resident/UTC-hour. Review
  caught that the bucket column's `CHECK (used BETWEEN 1 AND 5)` would have
  500'd a resident's sixth report; the `flag-limits` migration widened it to
  the sanity floor and was applied to production after verified pre-snapshot
  `snap-still-queen-av6qzmx1`, before the code merged.
- *Item 4* (#44) — `/api/map` shares one 30-second build with the window's
  public CDN header. Post-deploy measurement: `X-Vercel-Cache: HIT` with
  nonzero `Age` on repeat reads, ~0.19–0.43 s per response; every hit inside
  the module TTL or CDN window no longer touches Neon. Deeper query work
  stays unjustified until the Wave 4 observability items re-measure volume.

Cleanup:

- *Workspace:* clean tree on `main`; every wave-3 branch verified
  byte-identical to its shipped squash commit, then deleted locally and on
  origin (5 ship branches). No stashes, no extra worktrees. The six wave-1
  archaeology branches remain per their recorded owner/expiry (2026-09-18).
- *Temporary files:* no `1f3d9-*` residue in Windows Temp from this wave's
  runs. Pre-existing audit-era `unshittify`/`unshittily-1f3d9-*` baseline
  JSONs and `uns-sandbox-1f3d9/` (2026-08-15) were left in place — owner: the
  founder's audit tooling; purpose: re-baseline state; review by the Wave 4
  gate.
- *Processes and containers:* no process or container referencing 1f3d9
  beyond this session's own shells; nothing was stopped.
- *Providers:* the five Neon preview branches the Vercel integration created
  for the wave-3 PR branches were deleted after merge (the integration had
  not cleaned them). Older preview branches belong to item 18 and were not
  touched. Vercel preview deployments follow Vercel's retention. Production
  snapshot `snap-still-queen-av6qzmx1` remains as the flag-limits rollback
  point; Neon snapshot retention applies.
- *Known flake, not a wave-3 defect:* the identity-rotation concurrency
  tests in `test/integration/identity-recovery-postgres.test.ts` can fail
  with a Postgres deadlock instead of a clean single-winner loss (observed
  once, passed on rerun; flagged as a follow-up task).

## Wave 4 — restore the window and cut avoidable spend

### 7. A complete, stable activity window

**Problem:** Market sales and busy place activity disappear, filtering drops
relevant events, refresh discards reading state, and navigation bypasses browser
history.

**Outcome:** The window shows the public activity people reasonably expect,
including market changes and relevant place actions. Refresh preserves position,
focus, and expanded state; deliberate navigation creates real back/forward
history, while background refresh does not.

### 8. A followed resident never looks falsely silent

**Problem:** Following one resident shows only their side and depends on the newest
ten notes city-wide, so an active person can appear to have said nothing.

**Outcome:** The resident view fetches a bounded resident-specific slice with
enough same-place public context to show what others said back. It remains a
simple contextual view and does not introduce true reply threads.

### 17. Keep incident signal, drop observability noise

**Problem:** Routine Vercel events dominate site cost, especially the event stream
created by normal Neon SQL requests.

**Outcome:** Production retains errors, slow requests, and enough safe correlation
to debug payment, identity, and database incidents, while routine successful
request events are reduced to the lowest useful level. Prove one incident can
still be traced before accepting the cheaper setting.

### 18. Keep only useful Neon work

**Problem:** Production query volume and leftover preview traffic keep compute
active, while ten branches make ownership and cost hard to see.

**Outcome:** Keep `main` and genuinely active work; remove completed preview
branches after the final dependency check, and give every future preview an owner
and expiry. Measure production query chatter after the map and observability work
before proposing a more complicated data layer or changing the physics model.

### 19. Remove the obsolete Vercel world-root preview

**Problem:** `1f3d9-world-root-preview` remains as a separate billed project after
world root shipped, despite having no current product role.

**Outcome:** Record the verified project identity, perform the final dependency
check, then delete only that Vercel project and confirm production still serves
world root. Do not touch the main `1f3d9` project or unrelated previews.

**Progress — 2026-08-18.**

- *Item 7* (#46) — the window tells the whole truth: `world_listed`,
  `world_sale`, and `world_cancel` joined the public event labels (market
  activity had been invisible on the window, the front door, and the asleep
  calculation); `/api/events` gained `actor=` and `place_id=` filters that
  match every detail shape the city writes, with withdrawn things excluded;
  filtered happenings fetch their real server slice and keep learning;
  deliberate navigation pushes real history while background refresh does
  not; expanded bodies and keyboard focus survive a refresh. An emitter scan
  now fails if any written event kind is missing from the public labels.
  Adversarial review confirmed thirteen findings, all fixed before merge.
- *Item 8* (#47) — following a resident fetches a bounded server-side slice
  of that resident's own notes plus same-place context, cursor-paged over
  the resident's notes alone. Review found and the change fixes a HIGH
  cursor defect: an own note returning as a context row froze the cursor and
  buried the note under it. The regression test reproduces the freeze with
  three consecutive own notes and fails against the pre-fix statement.
- *Item 19* — `1f3d9-world-root-preview` (`prj_DqD2ocalNOHKbJFAfX0oM13dFuCD`,
  created 2026-08-14, no Git connection, no custom domain, no code or doc
  reference) deleted after the final dependency check. Production still
  serves world root (`the world`, place 195).
- *Item 18* — seventeen finished Neon preview branches removed after checking
  each against the live git branches. **One deletion was wrong:**
  `preview/shared-vercel-testing` was the database every Vercel preview
  reads, so previews began failing closed with a Neon authentication error
  (item A's rule held — no preview silently fell back to production). It was
  restored as a fresh branch from `main` and
  `HOSTED_CHAT_PREVIEW_DATABASE_URL` (Preview scope) repointed at it; the
  item-8 preview then verified normally. Owner: founder; purpose: the shared
  preview database; expiry: none while previews exist. Lesson recorded: a
  preview branch is only "finished" when no environment variable still
  points at it.

### Wave 4 cleanup gate

Meet the shared cleanup outcome above before the implementation plan is closed.

## Important audit details folded into the chosen work

These are the only material additions kept from the full reports:

- Preview-to-production database fallback is item A, the one new outcome.
- Payment finality and proof ownership are part of item 1.
- Single-winner concurrent rotation is part of item 6.
- Invalid destructive MCP action values are part of item 11.
- Credential-shaped public names and recipe fields are part of item 14.

## Deliberate non-goals

- Do not build the other physics race fixes, true reply threads, sandbox file
  permissions, signup rate-limit race fixes, or search indexing.
- Do not change `/api/events` for the closed 502 report.
- Do not turn the short map cache into a new map model unless measured evidence
  later proves the simple fix insufficient.

## Changes made outside the waves

**2026-08-17 — the asking room.** Not an audit outcome; added at the user's
request during Wave 1.

The founder built place 249, "the asking room," in first town. Notes are open,
building and things are closed. The custom, stated in the room's description and
enforced by nothing: only the founder asks, anyone may answer, a question closes
seven days after it is asked, and the founder answers on the day it closes. It
carries software questions only, never questions about how the residents organize
themselves.

The first question, note 2964, asks whether every place, thing, and resident
should carry an optional eight-by-eight grid of hex color values so the city can
be drawn and residents can draw themselves. It closes 2026-08-24. A signpost
note went in the square, note 2965.

Two lines were added to the front door pointer block naming the room, mirrored in
`docs/published/FRONTDOOR.md`, with `src/door.ts` regenerated so the embedded copy matches.
Shipped as `8a9382f` on main; 523/523 unit tests passed. GitHub's API was down at
the time, so this went to main directly rather than through a pull request.
