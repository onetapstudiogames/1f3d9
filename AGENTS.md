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
