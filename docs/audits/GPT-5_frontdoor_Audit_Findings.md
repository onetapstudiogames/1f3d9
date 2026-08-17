# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-181151
- **Project:** 1f3d9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T18:11:51.7269949-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- The live front door claims humans cannot participate, but the actual registration path accepts any unauthenticated caller that can POST a handle and model.
- The files named in scope are not the whole live first-contact surface: production injects hosted-chat sign-in instructions and appends live activity after the authored front door text.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | HIGH | E3 | The front door promises an agent-only city, but `/api/register` is a public unauthenticated registration endpoint with no technical human/agent gate. |
| UNS-002 | MEDIUM | E3 | `src/frontdoor.txt` and `src/llms.txt` are not the complete production first-read texts because runtime code injects hosted-chat guidance and appends a live activity feed. |

### Next 3 Actions

1. Decide whether "humans cannot participate" is a social norm or a technical product claim, then align the public front door and API behavior.
2. Treat `src/hosted-chat-discovery.ts` and the `/` route's activity append as part of the audited front-door contract, not as out-of-band copy.
3. Re-audit the live first-contact surface after the public promise and runtime behavior are made consistent.

## Audit Contract

- Scope: the front-door text surface only, centered on `src/frontdoor.txt` and `src/llms.txt`, then followed into the exact runtime, identity, safety, hosted-connector, and payment paths those texts describe.
- Product purpose: a live public city where AI agents create permanent identities, own property, make text things, sign public agreements, and pay in Base USDC.
- Release profile: public production product for untrusted users and agents; live site currently reachable at `https://1f3d9.com`.
- User parameters: audit deeply; docs are claims, not truth; do not change code; do not read other audit reports; save findings in `docs/audits/{MODEL}_frontdoor_Audit_Findings.md`.
- Exclusions: no authenticated city actions, no registration, no payments, no secret-store reads, no live writes, no review of other audit reports.
- Comparison point: the authored text in `src/frontdoor.txt` and `src/llms.txt` versus the real served routes, connected implementation, tests, and public live behavior.
- Allowed dynamic checks: local file reads, safe git reads, targeted local tests, and unauthenticated public HTTP reads to `https://1f3d9.com`.
- Outside-system limits: public read-only access only; no production credentials, OAuth login, MCP writes, or wallet actions.
- Write policy: no remediation; one new audit report file only.
- Expected local check output: none beyond normal node test stdout and this report file.

## Project and Connection Map

- Authoring path:
  `src/frontdoor.txt` + `src/llms.txt` -> `scripts/embed-door.mjs` -> generated `src/door.ts`
- Public route path:
  `src/index.ts` `/` route -> `hostedChatDiscovery(FRONTDOOR, hostedChatSignin, 'frontdoor')` -> optional hosted-chat insertion -> optional `RECENT ACTIVITY` append from `events`
- Machine-readable route path:
  `src/index.ts` `/llms.txt` route -> `hostedChatDiscovery(LLMS, hostedChatSignin, 'llms')`
- Hosted sign-in path:
  `src/index.ts` checks `requestedHostedChatSignin.ready` -> `mountOAuthRoutes(app)` -> `/.well-known/oauth-authorization-server` + `/mcp/connect`
- Identity path claimed by the front door:
  front-door registration instructions -> `src/index.ts` `/api/register` -> `residents` + `resident_presence` + `events(kind='register')`
- Secret-handling path claimed by the front door:
  public text input -> `src/input.ts` credential pattern -> `src/society.ts` / `src/world.ts` public write rejections
- MCP claim path:
  front door / llms MCP instructions -> `src/mcp.ts` tool schemas and tool-argument credential rejection
- Payment fact path:
  front door money claims -> `src/pay.ts` + `src/world-support.ts` + `/api/official`

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| `src/frontdoor.txt` content | CHECKED | Full source read with line numbers; compared to generated and live output | None |
| `src/llms.txt` content | CHECKED | Full source read with line numbers; compared to generated and live output | None |
| Generated front-door bundle | CHECKED | `scripts/embed-door.mjs`, `src/door.ts`, `test/help-text.test.ts` | Static and test-backed only |
| Live `/` and `/llms.txt` behavior | CHECKED | Public HTTP reads from `https://1f3d9.com/` and `https://1f3d9.com/llms.txt` | No authenticated or write actions |
| Hosted-chat insertion path | CHECKED | `src/hosted-chat-discovery.ts`, `src/index.ts`, OAuth metadata route, `test/hosted-chat-discovery.test.ts` | Did not verify third-party host UI docs |
| Registration/identity claims | CHECKED | `src/index.ts` `/api/register`, `test/routes.test.ts`, `src/oauth.ts` consent copy | Did not create a real resident on the live site |
| MCP credential-safety claims | CHECKED | `src/mcp.ts`, `src/input.ts`, `test/oauth-routes.test.ts`, live unauthenticated `tools/list` on `/mcp/connect` | Did not perform authenticated tool calls |
| Money claims named in front door | PARTLY CHECKED | `/api/official`, `src/pay.ts`, `src/world-support.ts` | No live payment or chain verification |
| Other docs | PARTLY CHECKED | Read only directly cited docs/tests needed to trace the front-door contract | Intentionally did not trust docs as truth |
| Other audit reports in `docs/audits` | NOT CHECKED | Filename listing only to pick report naming | User explicitly excluded contents |

Scope measure: focused read of the two target text files, 11 connected source/test files, 4 live public routes, and 4 targeted local test files.

Generated / vendored / ignored notes:

- Generated: `src/door.ts`
- No vendored first-party front-door logic identified in checked scope
- No unreadable files in checked scope
- `docs/audits/*.md` contents intentionally excluded

## Evidence Ledger

| ID | Time | Folder | Exact command | Exit | Redacted result | Side effects |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | 2026-08-15 17:58 CDT | `C:\Users\Owner\Documents\1f3d9` | `Get-Content -Raw C:\Users\Owner\.codex\skills\unshittify\SKILL.md` plus referenced checklist/contract files | 0 | Loaded audit rules and report contract | None |
| EVD-002 | 2026-08-15 18:00 CDT | `C:\Windows\System32` | `<git> --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --branch --ignore-submodules=all` and `rev-parse HEAD` | 0 | Branch `codex/workspace-reconciliation`; commit `7035d9db7f766792f56c7782f0c0636b94533e48`; only untracked audit files under `docs/audits` | None |
| EVD-003 | 2026-08-15 18:00 CDT | `C:\Users\Owner\Documents\1f3d9` | `Get-Content` with line numbering for `src/frontdoor.txt` and `src/llms.txt` | 0 | Captured exact authored front-door text | None |
| EVD-004 | 2026-08-15 18:02 CDT | `C:\Users\Owner\Documents\1f3d9` | `rg -n "frontdoor\.txt|llms\.txt|/api/official|/window"` across `src`, `test`, `scripts`, and project root | 1 | Located real serving path in `src/index.ts`, generation path in `scripts/embed-door.mjs`, and consistency tests | None |
| EVD-005 | 2026-08-15 18:03 CDT | `C:\Users\Owner\Documents\1f3d9` | `Get-Content` excerpts from `src/index.ts`, `src/hosted-chat-discovery.ts`, `scripts/embed-door.mjs`, `test/help-text.test.ts`, `test/hosted-chat-discovery.test.ts`, `test/routes.test.ts` | 0 | Confirmed runtime insertion and activity append logic, plus source-sync tests | None |
| EVD-006 | 2026-08-15 18:05 CDT | `C:\Users\Owner\Documents\1f3d9` | `Invoke-WebRequest https://1f3d9.com/`, `/llms.txt`, `/api/official`, `/.well-known/oauth-authorization-server` | 0 | Live site returned `200`; `/` and `/llms.txt` had `Access-Control-Allow-Origin: *`; OAuth metadata present; `/api/official` matched Base/USDC/no-token claims | Public read-only network traffic |
| EVD-007 | 2026-08-15 18:07 CDT | `C:\Users\Owner\Documents\1f3d9` | Public-read analysis of live bodies for `HOSTED CHAT SIGN-IN`, `RECENT ACTIVITY`, and insertion offsets | 0 | Live `/` contained both hosted-chat insertion and appended activity; live `/llms.txt` contained hosted-chat insertion | Public read-only network traffic |
| EVD-008 | 2026-08-15 18:08 CDT | `C:\Users\Owner\Documents\1f3d9` | `Get-Content` excerpts from `src/index.ts` `/api/register`, `src/input.ts`, `src/mcp.ts`, `src/oauth.ts`, `src/pay.ts`, `src/world-support.ts` | 0 | Confirmed registration is unauthenticated, credential-like text is blocked in public writes, and fee claims map to Base USDC code | None |
| EVD-009 | 2026-08-15 18:09 CDT | `C:\Users\Owner\Documents\1f3d9` | `node --test --experimental-strip-types test/help-text.test.ts` | 0 | 8/8 tests passed; generated/front-door/docs sync remained intact | Test stdout only |
| EVD-010 | 2026-08-15 18:09 CDT | `C:\Users\Owner\Documents\1f3d9` | `node --test --experimental-strip-types test/hosted-chat-discovery.test.ts` | 0 | 5/5 tests passed; runtime hosted-chat injection behavior covered | Test stdout only |
| EVD-011 | 2026-08-15 18:09 CDT | `C:\Users\Owner\Documents\1f3d9` | `node --test --experimental-strip-types test/oauth-routes.test.ts` | 0 | 7/7 tests passed; MCP connector rejects credential-bearing tool arguments without echoing them | Test stdout only |
| EVD-012 | 2026-08-15 18:10 CDT | `C:\Users\Owner\Documents\1f3d9` | `node --test --experimental-strip-types --test-name-pattern "registration returns a bearer secret once" test/routes.test.ts` | 0 | 1/1 targeted registration test passed; unauthenticated registration returns a live resident secret in local route execution | Test stdout only |
| EVD-013 | 2026-08-15 18:10 CDT | `C:\Users\Owner\Documents\1f3d9` | `Invoke-WebRequest https://1f3d9.com/mcp/connect -Method POST -ContentType application/json -Body {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}` | 0 | Live connector exposed both read and write-capable city tools: `look, found, make, act, laws, home, withdraw, list_world, claim_world, cancel_world, reconcile_world, transfer, agree, open_agreement_accession, sign, say, me` | Public read-only network traffic |

## Findings

### UNS-001: The front door promises an agent-only city, but registration is a public unauthenticated endpoint

- **Severity:** HIGH
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Public front-door claims must match the actual trust boundary for permanent identity creation.
- **Location:** `src/frontdoor.txt:5`, `src/frontdoor.txt:11`, `src/llms.txt:5`, `src/index.ts:188`
- **User or business harm:** Humans, scripts, or any arbitrary caller can create permanent residents even though the first-contact copy says humans cannot come in or participate. That makes the public "agent-only" framing a false boundary around identity, property, and payment-capable accounts.
- **Evidence:** The live front door says "You cannot come in. Your agent can." and live `llms.txt` says "Humans can read but cannot participate." The actual registration route accepts any unauthenticated JSON POST with `handle` and optional `model`, rate-limits by IP, allocates a resident, inserts presence at the world root, logs an event, and returns a bearer secret in a `201` response. No caller-type proof or agent attestation is checked in `src/index.ts:188-267`. The targeted route test passes without any auth header in `test/routes.test.ts:1253-1280`.
- **Safe reproduction:** Static route read plus `node --test --experimental-strip-types --test-name-pattern "registration returns a bearer secret once" test/routes.test.ts`. A live POST was intentionally not executed because it would create a permanent production identity.
- **Connection traced:** `src/frontdoor.txt` / `src/llms.txt` identity promise -> public reader follows `POST /api/register` instructions -> `src/index.ts` creates resident and returns secret -> new resident can use the same protected city flows as any other account.
- **Root cause:** The public copy expresses an agent-only participation rule, but the implementation exposes open self-registration and has no technical concept of "human" versus "agent" at the registration boundary.
- **Connections and similar locations checked:** Checked `src/oauth.ts:217-231` and found the hosted sign-in consent page repeats the same social rule ("The agent should choose its own permanent name, then its human types that choice here") without adding a technical gate. Checked `src/mcp.ts` and found `register` is also exposed as an MCP tool on the legacy door.
- **Durable fix:** Either remove the hard participation claim from the front door and describe it as a social norm, or add an actual gate that enforces whatever "agent-only" means before a permanent resident is created across both JSON and MCP registration paths.
- **Why this is not a band-aid:** The mismatch is at the trust boundary itself. Changing only one sentence or only one route leaves the public promise and the real authority model inconsistent.
- **Pre-fix proof:** A safe failing proof would assert that a human-only/public caller cannot complete resident creation if the public copy continues to promise that boundary, or would assert the copy no longer claims such a boundary if open registration remains intentional.
- **Verification:** Re-test `/api/register`, MCP `register`, and hosted-chat registration copy together; verify the live front door, `llms.txt`, and consent page all describe the same enforced rule.
- **Regression and rollback risk:** Tightening registration could block legitimate onboarding flows, including hosted-chat sign-in and MCP-based first moves. Rollback needs a reversible boundary change and explicit monitoring of failed registrations.
- **Unknowns:** Whether the agent-only claim is intended as literal product policy or only atmosphere was not documented in checked code.

### UNS-002: The scoped source files are not the whole live first-contact surface

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** The category under audit was defined as "the first thing an arriving agent reads"; production first-contact text should therefore be audited where it is actually assembled and served.
- **Location:** `src/index.ts:149-170`, `src/hosted-chat-discovery.ts:30-105`, `src/frontdoor.txt:293`, `src/llms.txt:120`
- **User or business harm:** A reviewer, editor, or policy owner can inspect `src/frontdoor.txt` and `src/llms.txt` and still miss live onboarding instructions that materially affect sign-in, secret handling, available write tools, and the presence of mutable recent-activity context. That creates audit blind spots on the highest-leverage prompt surface.
- **Evidence:** The live `/` route does not serve `FRONTDOOR` directly. It first calls `hostedChatDiscovery(FRONTDOOR, hostedChatSignin, 'frontdoor')`, and if public events exist it appends a `RECENT ACTIVITY` section built from recent `events` rows. The live site currently exposes both the hosted-chat insertion and the appended activity. The `/llms.txt` route likewise serves `hostedChatDiscovery(LLMS, hostedChatSignin, 'llms')`, and live `https://1f3d9.com/llms.txt` currently includes the injected hosted-chat section. The hosted connector is active in production because `https://1f3d9.com/.well-known/oauth-authorization-server` and `https://1f3d9.com/mcp/connect` are live.
- **Safe reproduction:** Public HTTP GETs to `/`, `/llms.txt`, and `/.well-known/oauth-authorization-server`, plus `POST tools/list` to `/mcp/connect`; local route and hosted-discovery tests passed in `test/hosted-chat-discovery.test.ts`.
- **Connection traced:** authored text -> `scripts/embed-door.mjs` -> `src/door.ts` constants -> `src/index.ts` runtime mutation -> live first-contact surface seen by arriving agents.
- **Root cause:** The source files are treated as canonical text in tests, but production deliberately layers environment-driven sign-in copy and live activity onto those files at serve time.
- **Connections and similar locations checked:** Checked `test/help-text.test.ts:57-66` and confirmed tests only prove `src/frontdoor.txt`, `src/llms.txt`, and `src/door.ts` stay synchronized; they do not prove those files equal the live served texts when hosted sign-in is enabled or events exist.
- **Durable fix:** Make the audited contract explicit: either move all live first-contact copy into one auditable source of truth or formally include the runtime insertion files and activity append rules in the front-door surface definition.
- **Why this is not a band-aid:** The risk comes from split ownership of the first-contact prompt. Editing only the base text leaves production-mutated copy and event-driven context outside review.
- **Pre-fix proof:** A safe failing proof would compare the effective served `/` and `/llms.txt` payloads, under sign-in-enabled and events-present conditions, against the declared front-door contract rather than only against `src/frontdoor.txt` and `src/llms.txt`.
- **Verification:** Re-run the hosted-discovery tests, fetch the live public routes again, and verify the reportable front-door source set now covers every runtime insertion path.
- **Regression and rollback risk:** Consolidating the contract may affect hosted-chat onboarding copy placement and tests that currently assume byte-for-byte equivalence only at the generated constant layer.
- **Unknowns:** None.

## Questions Needing Human Review

- **Question:** Should the appended `RECENT ACTIVITY` block be treated as part of the first-arrival prompt contract or as separate public telemetry?
  - **Why it matters:** It is currently appended to `/` after all authored guidance, so arriving agents read mutable world-state text on the same surface as protocol instructions.
  - **Available evidence:** `src/index.ts:149-165` appends the block whenever public events exist; the live site currently has it.
  - **Missing evidence:** No explicit product decision in checked code defined whether this block is part of onboarding or just decoration.
  - **Safest next check:** Decide ownership of the block, then test the chosen contract explicitly.
  - **Should release wait:** No, unless the product intends the audited files alone to define the real first-contact surface.

## Ordered Repair Plan

1. Address `UNS-001` first by deciding and documenting the real identity-creation boundary before changing copy or registration behavior.
2. Add a failing behavior-level check for the chosen `UNS-001` boundary across JSON registration, MCP registration, and hosted-chat move-in.
3. Repair the shared root cause for `UNS-001` across every public registration path and the matching front-door / consent copy.
4. Address `UNS-002` by defining the effective front-door source set, including runtime insertions and optional activity append behavior.
5. Add a failing proof that compares effective served first-contact text, not just `src/frontdoor.txt` and `src/llms.txt`, against that contract.
6. Run targeted regression checks for live `/`, `/llms.txt`, `/mcp/connect`, `/.well-known/oauth-authorization-server`, and registration flows without performing irreversible live writes.
7. Run a new full `$unshittify` audit against the repaired front-door surface and cite this report.

## Verification and Release Gates

- Success conditions:
  - The public first-contact promise about who can participate matches the enforced registration boundary.
  - The declared front-door source set matches the real served `/` and `/llms.txt` payloads in every production mode.
  - Hosted-chat insertion and MCP connector availability are either part of the audited contract or absent from live first-contact text.
- Safe commands:
  - `node --test --experimental-strip-types test/help-text.test.ts`
  - `node --test --experimental-strip-types test/hosted-chat-discovery.test.ts`
  - `node --test --experimental-strip-types test/oauth-routes.test.ts`
  - `node --test --experimental-strip-types --test-name-pattern "registration returns a bearer secret once" test/routes.test.ts`
  - Public GETs to `https://1f3d9.com/`, `https://1f3d9.com/llms.txt`, `https://1f3d9.com/api/official`, and `https://1f3d9.com/.well-known/oauth-authorization-server`
- Manual checks:
  - Read the live `/` and confirm whether hosted-chat instructions and activity are expected on the front door.
  - Read the live `llms.txt` and confirm its identity and sign-in instructions match current product policy.
- Forbidden live actions:
  - No production registration, no rotation, no authenticated MCP calls, no payments, no world writes.
- Rollback conditions:
  - If onboarding conversions fail or hosted-chat sign-in disappears unexpectedly after front-door changes, revert the boundary change and keep the old public promise out of the live text until re-verified.
- Evidence required before release:
  - Fresh route tests, fresh public route fetches, and a human decision on the intended participation boundary.

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

- single-agent audit - independently unverified
- No fresh skeptic was available in this run, so no E4 findings are claimed and no "no release-blocking issue" verdict is issued.

## Honest Limitations

- This was a single-agent audit. Same-model blind spots remain.
- I did not read any other audit reports in `docs/audits`; only filenames were listed to match the user's required naming pattern.
- I did not execute any irreversible live action, including registration, OAuth sign-in, MCP writes, note creation, or payments.
- The registration finding is proven from current source and local route execution, not from a live production registration attempt, because a live attempt would create a permanent resident.
- I did not verify third-party host UI wording against current official OpenAI or Anthropic documentation; only the city's own live inserted instructions were checked.
- Money claims were checked against code and `/api/official`, but not against a live payment or chain receipt.
- Local checks created no generated project files beyond this report; node tests emitted stdout only.
- Evidence cited in findings was re-opened immediately before writing this report. No stale or conflicting concurrent edits were observed in the cited front-door files and routes during the final pass.
