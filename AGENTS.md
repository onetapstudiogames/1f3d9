# The working standard

Read this before changing anything. It applies to every agent — Claude, Codex,
or anything else — and to every change, however small. CLAUDE.md holds the
project charter; this file holds the bar your work must clear.

## Definition of done

A change is done when ALL of these are true, and not before:

1. **The root cause is fixed, not the symptom site.** If the fix lives where
   the error appeared rather than where the fault is, it is not done.
2. **Tests prove the fix**, and the full local suite passes: `npm run
   typecheck`, `npm test`, and for release candidates the gate —
   `bash scripts/deploy.sh --prepare` on a clean pushed branch, reading its
   explicit `GATE_EXIT` line (piping can mask a failure; never trust the
   process exit alone).
3. **A feature touching an external service has one real run recorded.** A
   green suite against fakes has repeatedly failed here on first contact with
   the live service. Until a real run happened, say so plainly.
4. **A closed issue carries live verification evidence** — what was probed on
   the deployed site and what it returned — not an assertion that the code
   changed.
5. **Docs moved with the code, in the same PR.** Contract-visible changes touch
   up to eight mirror surfaces (front door, door.ts, llms.txt, published
   mirror, SYSTEM_DESIGN, DECISIONS, MCP descriptions, the skill). A PR that
   changes behavior and not the surfaces that describe it is not done.
6. **Nothing new is dead or duplicated.** No unused exports, no logic remade
   that existed elsewhere, no abstraction with one caller, no option nothing
   varies. The simplest shape that fully works is the deliverable.
7. **On the request path, read the body only through `c.req.text()`/
   `json()`/`arrayBuffer()`, never touch `c.req.raw.body`, `.clone()`,
   `.formData()`, or `c.req.parseBody()`** — even a presence check (`c.req.raw.body
   == null`) makes @hono/node-server build a real Request whose body is
   `Readable.toWeb(incoming)`, which never delivers on Vercel's Node runtime
   and cannot be reproduced against a local Node server (the gift
   accept/refuse hang; same root cause as market repo 1f3ea issue #39 / PR #40).

## Payment reliability

Every payment-path change requires:

- real-timing tests against real PostgreSQL, including chain finality later than
  the intent or operation window;
- adversarial refuter review before merge; and
- a read-only or self-cleaning post-deploy production probe of the changed
  surface.

Use city PR #107 as the test model. City issue #103, market PRs #13/#20, and
city PRs #115/#116 record why: mocks missed chain timing and SQL preparation,
while non-production runtimes missed live-only failures.

The scheduled `live-probe` workflow is the standing form of that probe: it
exercises production every 30 minutes (credit doors, window links, the
edge-stripped Content-Length canary) because Vercel's production edge behaves
differently from previews — PR #123 records the incident. A payment-surface
change is not done while that workflow is red, and its checks must grow with
any new payment surface in the same PR.

## How work runs here

- **PRs only.** Production ships by merging to main; Vercel builds that exact
  commit. Nothing deploys from a local folder. CI must be green.
- **Split by what a change touches, never by how long it takes.** A reviewer
  must never find security changes buried behind cosmetic ones.
- **State contracts before use** (locked Decision 45): every accepted shape,
  precondition, default, limit, and refusal reason is written where the caller
  reads, in caller words. A rule learned only by rejection is a defect.
- **Report honestly.** Failed means failed, partial means partial, skipped
  means skipped. Do not narrate confidence you have not earned; do not quote
  day-estimates (size by review cycles and blast radius).
- **Voice.** New copy uses no em dashes; do not churn historical decisions or quoted resident text solely for punctuation.
- **Fix the class, never just the instance.** A reported defect is one
  specimen. The fix is not done until the class is swept: every other tool,
  route, message, or page that could carry the same defect — on this site, the
  sibling site, and both skills — and BOTH SIDES OF THE GLASS: a change to
  what agents read must be checked against what humans see, and the reverse.
  A missing tool means asking what else is missing. A dishonest error means
  sweeping every error. A fix here means asking where else it applies, and a
  page added here means asking whether the sibling needs it too. Scoping to
  the reported instance is exactly how this project rotted once.
- **Adjacent problems are reported, not fixed.** Scope creep is how this
  project got the mess this file exists to prevent.
- **When work is prompted** (to Codex or a subagent): give the problem and the
  goal, never a list of hard rules; require a read-back before any edit; name
  the non-goals. Dense conclusions in reports — cite ids and path:line, no
  long verbatim excerpts.

## The ways work has failed here before

Check your change against each: a contract enforced but stated nowhere; a
green fake-backed suite meeting the real service; a fix carrying a second
defect only adversarial review caught; an unrelated branch contaminating a
release; a cleanup deleting what something live still pointed at; the same fix
shipped twice because the live symptom was never re-verified; a big rewrite
built on one wrong premise; seven patches chasing one root cause; a UI
regression every suite missed and only a human noticed. If your change smells
like any of these, stop and say so.

Quality gates live in CI and the release gate; there are no repo-local agent hooks, by design (owner decision, 2026-08-26).
