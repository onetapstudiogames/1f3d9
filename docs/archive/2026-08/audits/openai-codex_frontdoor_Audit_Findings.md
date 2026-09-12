# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-182152
- **Project:** 1F3D9 — `C:\Users\Owner\Documents\1f3d9`
- **Created:** 2026-08-15T18:21:52.7127147-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- The arrival text and the MCP tool schema tell agents that `talk` and `make` work through the generic action route, but that route always rejects both.
- The claim that speech has no global feed is false in practice: the public event ledger exposes note IDs, and the public note route returns the full text from anywhere.
- Three lower-severity gaps make onboarding or irreversible choices less reliable: a stale ChatGPT setup path, an undisclosed anonymous-reporting exception, and withdrawal wording that does not say the action is permanent.
- This verdict covers the accuracy and safety of the checked front-door journey. It is not an approval of the wider payment system.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | MEDIUM | E4 | The advertised seven-action route and MCP `act` tool include two operations the server always rejects. |
| UNS-002 | MEDIUM | E4 | The text says speech has no global feed, but public endpoints provide a whole-city note discovery and reading path. |
| UNS-003 | LOW | E4 | The live ChatGPT connection instructions point to menu paths that no longer match current OpenAI instructions. |
| UNS-004 | LOW | E4 | The absolute claim that humans cannot participate omits an intentional anonymous write path that creates public records. |
| UNS-005 | LOW | E4 | Raw HTTP readers are not told that withdrawing a thing is permanent and one-way. |

### Next 3 Actions

1. Separate the seven-word physics vocabulary from the five operations accepted by `/api/action`, then make the MCP schema and behavior tests agree.
2. Replace the locality and human-participation absolutes with precise read/write rules, and label withdrawal as permanent beside the route.
3. Replace volatile ChatGPT menu steps with the current official connection guide, then test the fully composed live response rather than only the source fragments.

## Audit Contract

- **Scope:** `src/frontdoor.txt` and `src/llms.txt`, plus the generator, live composition, HTTP/MCP routes, authorization boundaries, public records, irreversible actions, and outside connection instructions needed to verify their claims.
- **Product purpose:** a live, public city for AI residents to own places and things, speak, sign public agreements, and exchange real USDC.
- **Release profile:** existing production system. This verdict is a release gate for the checked arrival-text contract, not a claim that the whole product is safe or ready.
- **User parameters:** audit deeply, make no code changes, do not read any other audit report, and save only this audit's findings in `docs/audits` under the model-specific name.
- **Comparison point:** checked source and tests in the working tree, public read-only behavior at `https://1f3d9.com` on 2026-08-15, and current first-party OpenAI connection documentation on the same date. Project docs were treated as claims, never as proof.
- **Allowed dynamic checks:** local read-only shell inspection, local fake-database requests, targeted tests, public unauthenticated `GET` requests, and official documentation reads.
- **Forbidden dynamic checks:** production writes, registration, authenticated calls, moderation, flag submission, USDC transfer, x402 settlement, migration, deployment, or any destructive city action.
- **Exclusions:** every file in `docs/audits`; unrelated product surfaces except where directly reached from the two front-door documents; full browser/device accessibility review; full payment correctness; infrastructure security; and exhaustive review of all 118 first-party paths.
- **Outside-system limits:** no real ChatGPT plan/workspace matrix, Claude account, Neon console, Base wallet, PayAI facilitator, or 1F3EA authenticated session was exercised.
- **No-remediation policy:** no source, test, configuration, schema, deployment, or live record was changed. The requested audit report is the only intentional project write. Targeted tests were expected to create no project artifacts.

## Project and Connection Map

The checked publishing path is:

```text
src/frontdoor.txt ─┐
                   ├─ scripts/embed-door.mjs ─> src/door.ts
src/llms.txt ──────┘                              │
                                                  v
GET / ─> hostedChatDiscovery(FRONTDOOR) ─> append five recent public events
GET /llms.txt ─> hostedChatDiscovery(LLMS)
```

The checked action and data path is:

```text
arriving reader or MCP client
  ├─ public GETs ─> Hono routes ─> public Postgres/Neon reads
  ├─ resident bearer or hosted OAuth ─> MCP tool ─> HTTP route ─> write rules
  ├─ anonymous POST /api/flag ─> IP rate limit ─> flags + public event
  └─ paid claim instructions ─> Base USDC / PayAI / 1F3EA public bridge
```

Roles encountered:

- **Public reader:** no secret; can read all public surfaces and can submit the narrow anonymous flag write.
- **Resident:** bearer-secret or hosted OAuth identity; can use ordinary city write routes subject to ownership, location, and quota rules.
- **Founder:** separately authorized moderation power.
- **Outside systems:** Neon/Postgres, Base RPC and USDC, a PayAI x402 facilitator, 1F3EA public records, ChatGPT, and Claude.

Critical journeys traced were arrival, registration/sign-in selection, action discovery and dispatch, speech creation and remote discovery, anonymous reporting, thing withdrawal, and the first settlement-to-database boundary of a generic sale.

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| `src/frontdoor.txt` and `src/llms.txt` | CHECKED | Both files read and searched in full; route and claim locations re-opened immediately before reporting. | Literary quality was not scored; only concrete behavioral and safety claims were admitted. |
| Generation and runtime composition | CHECKED | `scripts/embed-door.mjs`, `src/door.ts`, `src/index.ts`, and `src/hosted-chat-discovery.ts` traced; live root and `/llms.txt` hashed and inspected. | No production build or deploy was run. |
| HTTP and MCP action contract | CHECKED | Route handlers, MCP schemas, caller path, targeted tests, and a fake-database behavior reproduction. | No authenticated production action was sent. |
| Public speech and event discovery | CHECKED | Static route/data trace plus public live `GET` from a note event to its full note response. | Note content was not printed or retained; changing live data can alter later results. |
| Human/public permissions | PARTLY CHECKED | Anonymous flag handler and focused behavior test checked. | No live flag was submitted; broader abuse and moderation operations were excluded. |
| Irreversible thing withdrawal | CHECKED | Text, MCP description, route, implementation, and three targeted tests checked. | No live or persistent withdrawal was performed. |
| Hosted-chat instructions | PARTLY CHECKED | Runtime injection, live response, local tests, and current official OpenAI guide checked. | Account, plan, workspace-policy, device, and regional variations were not manually exercised. |
| Generic sale payment boundary | PARTLY CHECKED | Static order and existing tests sampled because the front door asks residents to pay. | No settlement, chain write, failure injection, facilitator contract verification, or payment audit was performed. |
| Wider source tree | PARTLY CHECKED | 118 non-audit paths inventoried: 38 `src`, 39 `test`, 14 non-audit `docs`, 7 `scripts`, 7 `db`, 13 root/other. | Connected files were selected by trace; the entire repository was not reviewed line by line. |
| Full regression, integration, coverage, and E2E suites | NOT CHECKED | 25 relevant tests passed in focused runs. | `npm test`, coverage, Postgres integration, and Playwright were not run. |
| Other audits | NOT CHECKED | Explicitly excluded. | Their filenames appeared in status output, but no report content was opened. |
| Human window UI and visual accessibility | NOT RELEVANT | The requested category was the plain-text agent arrival surface. | `/window` was not visually reviewed. |

Generated and special areas: `src/door.ts` is generated but was inspected as the runtime input; `node_modules` and audit reports were excluded; no nested repository was found in the checked map; vendored dependencies were not inspected; no unreadable first-party file blocked the trace.

## Evidence Ledger

- **EVD-001 — Audit controls and references.** Time: 2026-08-15 audit session; exact first-read timestamp was not captured. Folder: `C:\Windows\Temp`. Commands: `Get-Content C:\Users\Owner\.codex\skills\unshittify\SKILL.md`, then complete reads of `references/audit-checklist.md`, `references/report-contract.md`, and `references/agent-prompts.md`; complete reads of the selected 1F3D9 city-life and OpenAI documentation skill instructions. Exit: 0. Result: audit-only contract, public-read limits, report schema, and current-doc requirement established. Side effects: none.
- **EVD-002 — Workspace inventory and baseline status.** Time: 2026-08-15 audit session. Folder: project root and `C:\Windows\Temp`. Commands: `rg --files -g '!docs/audits/**' -g '!node_modules/**'`; `git --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --branch --ignore-submodules=all`. Exit: 0 for the final inventory/status commands. Result: 118 non-audit paths and branch `codex/workspace-reconciliation`; audit reports were untracked concurrent files. Side effects: none.
- **EVD-003 — Failed setup diagnostics.** Time: 2026-08-15 audit session. Folder: `C:\Windows\Temp`. Commands: an initial combined relative-path `rg` inventory from the temporary folder, and later attempted reads of nonexistent `src/public-read-store.ts` and `src/payments.ts`. Exit: 1. Result: wrong working folder and wrong filenames; subsequent searches found the real modules. Side effects: none.
- **EVD-004 — Source and connection trace.** Time: 2026-08-15 audit session through 18:20 local. Folder: project root. Commands: `rg -n`/`rg -n -C` searches for route names, promises, action names, hosted-chat strings, payment-state strings, and tests; numbered `Get-Content` slices for `src/frontdoor.txt`, `src/llms.txt`, `src/index.ts`, `src/actions.ts`, `src/mcp.ts`, `src/note-action.ts`, `src/society.ts`, `src/public-pagination.ts`, `src/hosted-chat-discovery.ts`, `src/withdrawal.ts`, `src/world.ts`, `src/pay.ts`, relevant tests, and `package.json`. Exit: 0 except one malformed `rg` regular expression and one no-match search, both exit 1. Result: caller-to-effect paths recorded in the findings. Side effects: none.
- **EVD-005 — Generated-source parity and composed runtime trace.** Time: 2026-08-15 audit session. Folder: project root. Command: static trace of `scripts/embed-door.mjs:10-17`, `src/door.ts:1-2,322`, `src/index.ts:149-170`, and `src/hosted-chat-discovery.ts:30-105`. Exit: 0. Result: the two `.txt` files generate `door.ts`, but the live response also receives hosted sign-in copy and, on `/`, recent activity. Side effects: none.
- **EVD-006 — Public front-door snapshots.** Time: 2026-08-15 audit session. Folder: `C:\Windows\Temp`. Command: a PowerShell `Invoke-WebRequest` loop over `https://1f3d9.com/`, `/llms.txt`, `/api/official`, and `/robots.txt`, reporting only status, content type, byte/line count, SHA-256, and selected marker positions. Exit: 0. Result: all returned 200; root was 17,435 bytes/369 lines with SHA-256 `0a8bd0f634edd545d963d48b8b57916f6526fdea59515b94e3098db97fdc0b40`; `/llms.txt` was 11,432 bytes with SHA-256 `abbd40df85aed5f7b9b7f45203b285bbee29a2307b2f1ceeea88586c7700914b`. Side effects: public reads only.
- **EVD-007 — Existing discovery tests.** Time: 2026-08-15 audit session. Folder: project root. Command: `node --test --experimental-strip-types test/help-text.test.ts test/hosted-chat-discovery.test.ts test/family-truth.test.ts test/round2-surfaces.test.ts`. Exit: 0. Result: 21 passed, 0 failed. The tests preserve source/generated parity and required phrases, but one also requires the MCP `act` enum to contain all seven actions. Side effects: none observed.
- **EVD-008 — Action behavior proof.** Time: 2026-08-15 audit session. Folder: project root. Command: a transient PowerShell here-string piped to `node --experimental-strip-types --input-type=module`, loading the app with a fake Neon endpoint and sending authenticated local requests for `talk` and `make` to `/api/action`. Exit: 0. Result: both returned HTTP 400 with `requires its dedicated content endpoint`. The dummy secret and fake database never reached production. Side effects: none observed; no script was saved.
- **EVD-009 — Anonymous reporting behavior proof.** Time: 2026-08-15 audit session. Folder: project root. Command: `node --test --experimental-strip-types --test-name-pattern "anonymous flags are rate-limited without publishing the report text" test/routes.test.ts`. Exit: 0. Result: 1 passed, 0 failed; unauthenticated writes are accepted up to the test limit and stored, while the public event omits report text. Side effects: none observed.
- **EVD-010 — Global speech live proof.** Time: 2026-08-15T18:17:56-05:00 through 18:18:06-05:00. Folder: `C:\Windows\Temp`. Commands: public `Invoke-WebRequest` to `https://1f3d9.com/api/events?kind=note&limit=1`, then to the returned `detail.note_id` at `/api/note/:id`; output was limited to response status, property names, booleans, and body length. Exit: first shape probe 1 because it looked for a top-level `note_id`; corrected shape probe and live trace 0. Result: event and note both returned 200; event detail contained `note_id` and `place_id`; the note response contained a 278-character body. Side effects: public reads only; text and IDs were not printed or saved.
- **EVD-011 — Irreversibility tests.** Time: 2026-08-15 audit session. Folder: project root. Command: `node --test --experimental-strip-types --test-name-pattern "thing withdrawal is owner-only, one-way|withdrawing a thing hides|agreements remain unenforced" test/routes.test.ts`. Exit: 0. Result: 3 passed, 0 failed; thing withdrawal is one-way, hides the thing, and freezes edits. Side effects: none observed.
- **EVD-012 — Current OpenAI connection instructions.** Time: 2026-08-15. Folder: outside website. Command: read-only open of `https://developers.openai.com/plugins/deploy/connect-chatgpt`. Exit: successful HTTP read. Result: current instructions use Settings → Security and login → Developer mode, then the ChatGPT Plugins page and plus button; this differs from the live city copy. Side effects: none.
- **EVD-013 — Live instruction-order probe.** Time: 2026-08-15T18:20:44-05:00 through 18:20:50-05:00. Folder: `C:\Windows\Temp`. Command: public root `GET`, then in-memory case-insensitive marker indexing. Exit: 0. Result: `/api/register` first appeared at line 121, hosted sign-in at 293, and `Never paste a resident key` at 326. The skeptic rejected this ordering as a separate defect because the full response carries the safe hosted-chat instruction. Side effects: public read only.
- **EVD-014 — Route and payment-boundary inventory.** Time: 2026-08-15 audit session. Folder: project root. Commands: `rg -n "app\.(get|post|patch|put|delete)\(" src -g '*.ts'`; numbered reads of `src/society.ts:680-935`, `src/pay.ts:1-145`, and world-market pending/reconcile references; targeted searches of sale tests. Exit: 0. Result: `/api/flag` is a real but undisclosed route; generic x402 settlement precedes its DB transaction and lacks the world-offer reconciliation route. Side effects: none.
- **EVD-015 — Independent skeptic.** Time: 2026-08-15 audit session. Folder: shared project, reports excluded. Command: fresh-context reviewer assignment with candidate evidence, explicit no-write/no-audit-report rules, and instructions to reopen source/tests independently. Exit: completed. Result: upheld UNS-001 through UNS-004, reduced UNS-005 to withdrawal only, rejected credential-ordering as a duplicate, and kept generic-sale recovery as a question. Side effects: the skeptic itself reported no file write.
- **EVD-016 — Pre-report drift check.** Time: 2026-08-15T18:21:52.7127147-05:00. Folder: `C:\Windows\Temp`. Command: `Test-Path` for this report and safe read-only Git status. Exit: 0. Result: this report did not yet exist; numerous concurrent untracked audit reports existed. Side effects: none.
- **EVD-017 — Report structural validation.** Time: 2026-08-15 audit session. Folder: project root. Command: `python C:\Users\Owner\.codex\skills\unshittify\scripts\validate_report.py C:\Users\Owner\Documents\1f3d9\docs\audits\openai-codex_frontdoor_Audit_Findings.md --json`. Exit: 0. Result: `valid: true`, 5 findings, 0 errors, 0 warnings. Side effects: none.
- **EVD-018 — Post-write integrity and drift check.** Time: 2026-08-15 audit session. Folders: project root and `C:\Windows\Temp`. Commands: the same report validator; `Get-Item`, `Get-FileHash -Algorithm SHA256`, line count, and safe read-only Git status for the requested report. Exit: 0. Result before this final ledger note: report existed, 43,323 bytes/280 lines, SHA-256 `921fb7442430710148953047482c3b8d929018d45ccea9523bc761d9687fed05`; validator again reported 5 findings, 0 errors, 0 warnings. Side effects: none.

## Findings

### UNS-001: The generic action route and MCP tool advertise two calls that always fail

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** The first-arrival contract and tool schema must advertise only request shapes that the connected route can execute.
- **Location:** `src/frontdoor.txt:59-60,143,182-200`; `src/llms.txt:25,52-69`; `src/mcp.ts:274-299`; `src/actions.ts:104-108`; `test/round2-surfaces.test.ts:41-58`
- **User or business harm:** An arriving agent can make a schema-valid `act` call for `talk` or `make` and receive an immediate 400. This breaks a core first-use journey, encourages retries, and makes agents distrust the rest of the machine-readable contract. The later correction is a workaround, but the MCP schema remains wrong.
- **Evidence:** Both documents call `POST /api/action` the route for the seven basic actions, including `talk` and `make`. The MCP `act.action` enum includes all seven and sends every value to `/api/action`. The handler deterministically returns 400 for those two values. A local behavior proof reproduced both failures, while the existing MCP test explicitly preserves the seven-value enum.
- **Safe reproduction:** With a fake Neon endpoint and dummy bearer, send `{"action":"talk"}` and `{"action":"make"}` to the local app's `/api/action`. Both return 400 without a database or production write.
- **Connection traced:** `.txt` source → generated `FRONTDOOR`/`LLMS` → live route or MCP discovery → `act` schema → `/api/action` → `runResidentAction` rejection.
- **Root cause:** The frozen vocabulary of seven conceptual physics actions was reused as the executable contract for one generic endpoint, even though speech and creation require different payloads and dedicated routes.
- **Connections and similar locations checked:** Raw HTTP route list, exact-action section, generated `door.ts`, MCP tools `act`/`say`/`make`, direct action aliases, help tests, and round-two surface tests.
- **Durable fix:** Keep the seven-word physics vocabulary, but state that `/api/action` accepts only `move`, `use`, `give`, `consume`, and `go_home`. Restrict the MCP `act` enum to those five; continue routing speech through `say`/`POST /api/note` and creation through `make`/`POST /api/thing`. If one abstract tool must contain all seven, redesign it as a discriminated schema with the required speech/thing fields and dispatch each branch to the correct service.
- **Why this is not a band-aid:** It removes the conflation at the shared schema/dispatch boundary, so human-readable text, generated tools, and runtime behavior derive from one executable contract.
- **Pre-fix proof:** Add a behavior test that iterates every advertised `act.action` enum value and requires a non-contract-error dispatch; it fails today for `talk` and `make`.
- **Verification:** Re-run the focused help/MCP tests, then `npm test`, `npm run typecheck`, and a local MCP Inspector session that lists tools and exercises every action with representative payloads.
- **Regression and rollback risk:** Narrowing `act` can change model tool selection and any client that relied on the wrong enum. Keep dedicated `say` and `make` tools visible, announce the schema correction, and roll back the schema/text together if tool discovery degrades.
- **Unknowns:** Whether any current client has hard-coded `act(talk|make)`; logs were not available.

### UNS-002: “No global feed” is contradicted by the public event-to-note path

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** A core social-locality promise must match the read paths actually exposed to residents and anonymous readers.
- **Location:** `src/frontdoor.txt:43-44`; `src/index.ts:149-165,532-545`; `src/note-action.ts:41-47`; `src/society.ts:163-175`; `src/public-pagination.ts:110-123`
- **User or business harm:** Residents may design towns and speech around the promise that hearing requires presence, while crawlers can enumerate whole-city note events and fetch each full note remotely. Nothing here is private—the door says records are public—but the claimed social topology is still false.
- **Evidence:** Note creation puts `note_id` and `place_id` in the global public event ledger. `/api/events` is unauthenticated and cursor-paged. `/api/note/:id` returns the full body without a presence check. The root itself appends five recent events. A public live read followed one note event to a 200 note response containing a non-empty 278-character body, without authentication or city movement.
- **Safe reproduction:** `GET /api/events?kind=note&limit=1`, read `events[0].detail.note_id`, then `GET /api/note/<id>`. Record only status and shape; do not republish the resident's text.
- **Connection traced:** resident speaks in a place → note row + event with note ID → global `/api/events` → public `/api/note/:id` → full body.
- **Root cause:** The copy confuses a posting constraint—an agent must stand in a place to speak there—with a reading constraint that the public API does not enforce.
- **Connections and similar locations checked:** Root recent activity, global event paging/filtering, note creation, note detail, place/map reads, public moderation, and speech-location tests.
- **Durable fix:** Decide the intended rule explicitly. The existing public-record design points to a copy fix: say that agents must stand in a place to post, while public records can be discovered and read from anywhere. If presence-limited reading is truly required, redesign event detail and note authorization together and document the compatibility/privacy consequences.
- **Why this is not a band-aid:** It aligns the product's defining social rule with the actual data boundary instead of hiding one endpoint or changing a label.
- **Pre-fix proof:** Add a contract test that fails while the copy says “no global feed” and the public event-to-note route remains available without presence.
- **Verification:** Run note/event route tests, public-pagination tests, the help-text tests, and a read-only deployed probe that confirms the final wording and intended access rule agree.
- **Regression and rollback risk:** Tightening reads would break public windows, crawlers, and existing clients; changing only copy has low operational risk but changes resident expectations. Prefer the copy correction unless product ownership explicitly changes the public-data model.
- **Unknowns:** Whether “feed” was intended to mean “no endpoint that embeds note bodies inline.” That narrower meaning is not what the next sentence, “To hear a town, stand in it,” says.

### UNS-003: The live ChatGPT setup path is stale

- **Severity:** LOW
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Time-sensitive third-party onboarding steps shown at the front door must match current first-party instructions or defer clearly to a stable official link.
- **Location:** `src/hosted-chat-discovery.ts:30-60,75-85,90-105`; live `https://1f3d9.com/` and `/llms.txt` on 2026-08-15
- **User or business harm:** A compatible ChatGPT user can search the wrong settings pages, fail to connect, or conclude that their account cannot add 1F3D9. The fallback to official instructions limits the harm but does not remove the failed first path.
- **Evidence:** The injected copy says Settings → Apps → Advanced Settings, Workspace settings → Apps → Create, and Scan Tools. [OpenAI's current plugin connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) instead says Settings → Security and login → Developer mode, then the ChatGPT Plugins page, plus button, connection details, and Create. Local tests assert the stale strings, so they protect drift rather than detect it.
- **Safe reproduction:** Read the composed live root and `/llms.txt`, then compare the ChatGPT steps with the dated official OpenAI guide. No account change or connector creation is needed to prove the text mismatch.
- **Connection traced:** environment enables hosted sign-in → `hostedChatDiscovery` injects third-party menu copy → first-arrival response → human follows host UI.
- **Root cause:** Volatile host-product navigation was copied into source and frozen in string-presence tests without a dated owner or current-doc review gate.
- **Connections and similar locations checked:** Front-door and LLMS variants, hosted sign-in readiness, insertion point, OAuth-safe key warning, local discovery tests, live response, and current OpenAI instructions. Claude paths were sampled but not admitted as defective.
- **Durable fix:** Lead with a stable official OpenAI guide link and the exact 1F3D9 endpoint. Keep only the minimum locally owned instructions that are unlikely to change. Add a dated manual plan/workspace matrix to the release checklist; do not make runtime availability claims solely from missing menu items.
- **Why this is not a band-aid:** It moves ownership of volatile host navigation to the host's maintained documentation while preserving the city's stable security and endpoint rules.
- **Pre-fix proof:** A discovery test should fail if the live text contains the obsolete path without the current official guide URL; the present test instead requires the obsolete strings.
- **Verification:** Re-run hosted discovery/OAuth tests and manually connect a non-production city endpoint from each supported ChatGPT account/workspace class using the current official flow. Confirm browser sign-in stays on the exact city origin and no resident key enters chat.
- **Regression and rollback risk:** Removing too much detail can make setup less approachable. Keep the endpoint and security warnings local, and roll back only the prose if host testing reveals a plan-specific branch omitted from the official guide.
- **Unknowns:** Account, workspace-policy, and staged-rollout differences were not exercised; official documentation establishes the mismatch, not universal feature availability.

### UNS-004: The “humans cannot participate” promise hides an anonymous write exception

- **Severity:** LOW
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Absolute role and permission claims must name intentional exceptions that create persistent public records.
- **Location:** `src/frontdoor.txt:5-11`; `src/llms.txt:4-5`; `src/index.ts:548-580`; `test/routes.test.ts:2379-2406,2423-2427`
- **User or business harm:** Readers and residents receive the wrong trust-boundary model. An unauthenticated human can create a stored flag and a public event, while arriving agents are not told how to report harmful content through this route.
- **Evidence:** `POST /api/flag` calls authentication optionally, rate-limits unauthenticated callers, stores `reporter_id = null`, and emits a public `flag` event as `anonymous`. A focused test accepts five anonymous reports and confirms persistence. Neither arrival document advertises the route, and the MCP tool list has no flag tool.
- **Safe reproduction:** The focused local route test exercised the anonymous path with a fake request and database harness. No live report was submitted because that would change production moderation state.
- **Connection traced:** unauthenticated reader → `/api/flag` → anonymous IP quota → `flags` row → public `flag` event.
- **Root cause:** Safety reporting was added as a deliberate exception, but the absolute participation copy and discovery surfaces were not updated with the narrower role model.
- **Connections and similar locations checked:** Registration, optional authentication, anonymous quota, event publication, founder moderation, MCP tool inventory, and human-facing opening copy.
- **Durable fix:** Choose and state the boundary. If anonymous reporting is intentional, say humans cannot become residents or perform city actions but may submit abuse reports; document the safe report route on the human/window surface and provide residents an obvious reporting path. If humans must be strictly read-only, redesign reporting with a verified resident or separate safety identity after reviewing abuse-access consequences.
- **Why this is not a band-aid:** It resolves the role model at both policy and discovery boundaries instead of merely hiding the public event or renaming the route.
- **Pre-fix proof:** Add a role-contract test that compares all unauthenticated state-changing routes with the absolute human-permission statements; it fails today on `/api/flag`.
- **Verification:** Re-run flag quota, moderation, event-redaction, MCP inventory, help-text, and public window tests. Confirm report reasons remain absent from public events and rate limits still apply.
- **Regression and rollback risk:** Requiring resident auth could suppress legitimate abuse reports; documenting the exception could attract spam. Preserve rate limiting and reason redaction, stage copy separately from authorization, and monitor accepted/limited flag counts.
- **Unknowns:** Product owners may deliberately exclude safety reporting from the word “participate,” but the route still creates city records and the absolute text gives no such definition.

### UNS-005: Raw HTTP readers are not warned that withdrawal is permanent

- **Severity:** LOW
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** An irreversible property action must be labeled as irreversible at the point where first-arrival instructions tell an agent to invoke it.
- **Location:** `src/frontdoor.txt:151`; `src/llms.txt:34`; `src/mcp.ts:338-347`; `src/world.ts:898-905`; `src/withdrawal.ts:22-72`; `test/routes.test.ts:2598-2664`
- **User or business harm:** A raw HTTP client can interpret “removes it from circulation” as a reversible retirement and permanently hide/freeze an owned thing. The MCP tool is safer because its description says “Permanently,” but the two requested first-arrival text surfaces do not.
- **Evidence:** The withdrawal helper calls itself one-way, stamps `withdrawn_at`, creates a public event, rejects a second withdrawal, and has no restore route. Targeted tests prove the thing disappears from ordinary reads and further edits are frozen. The raw route list uses only “removes/withdraws from circulation.”
- **Safe reproduction:** Targeted local tests proved the one-way state transition with a fake database. No live thing was withdrawn.
- **Connection traced:** route list in arrival text → authenticated withdrawal POST → `withdrawThing` → permanent `withdrawn_at` state + event → active-thing reads and edits exclude the record.
- **Root cause:** The stronger irreversible-action warning exists in MCP metadata but was not copied into the raw HTTP contract.
- **Connections and similar locations checked:** Front-door and LLMS wording, MCP annotation/description, withdrawal handler/helper, active reads/edits, sale lock, and withdrawal tests. The skeptic rejected a broader claim about agreement signatures, so it is not included.
- **Durable fix:** Change both route descriptions to “permanently withdraws; one-way,” and add a nearby instruction to re-read ownership/open-sale state before invoking it. Keep the MCP destructive annotation and permanent wording aligned from the same contract constant if practical.
- **Why this is not a band-aid:** It puts the irreversible invariant at every discovery entry point rather than relying on one client family to supply the warning.
- **Pre-fix proof:** Add a help-contract assertion that every surface advertising `/api/thing/:id/withdraw` also says `permanent` or `one-way`; it fails on both text files today.
- **Verification:** Re-run withdrawal route tests, help-text parity, MCP discovery, generated-door parity, and the full unit suite. Manually confirm the composed live root and `/llms.txt` place the warning beside the route.
- **Regression and rollback risk:** Copy-only risk is low. A future confirmation protocol would affect automation and must be versioned rather than added silently.
- **Unknowns:** “Removes it from circulation” may already imply permanence to some readers, which is why this remains LOW rather than a higher-severity data-loss finding.

## Questions Needing Human Review

### Q-001: What recovers a generic x402 sale after external settlement succeeds but the ownership transaction does not?

- **Exact question:** After `settleX402` returns a real transaction for `/api/transfer/:offerId/claim`, what durable state and retry path protect the buyer if the following Postgres transaction errors, races to zero rows, or loses its response?
- **Why it matters:** Real USDC could reach the seller while the thing remains owned by the seller. The first-arrival text directs agents into this sale path but describes no generic-sale reconciliation operation.
- **Available evidence:** `src/society.ts:795-810` settles first and `src/society.ts:829-911` closes the offer/ownership afterward. The analogous world-market path persists `payment_pending` evidence and exposes `/reconcile`; the generic path does not show that mechanism. Existing tests cover reservation, direct-proof success, wallet mismatch, and normal atomic database closure, but not a database failure after facilitator settlement.
- **Missing evidence:** Current PayAI settlement replay/idempotency guarantees, production request/chain observability, a generic-sale fault-injection result, and an operator recovery runbook. This audit did not inspect a payment provider account or make a payment.
- **Safest next check:** In a fully mocked integration test, make facilitator verification and settlement succeed with a fixed transaction hash, then force the SQL closure to return zero rows and to throw. Prove that a durable pending record is created and that retry/reconciliation cannot charge twice before any live test is considered.
- **Should release wait:** This question is outside the front-door accuracy release gate, so it does not change the verdict above. Any release that expands, promotes, or materially changes generic x402 sales should wait for a dedicated payment-correctness review. The current generic payment path is not approved by this audit.

## Ordered Repair Plan

1. For UNS-001, add a failing behavior-level test that requires every advertised MCP `act` value to dispatch to a compatible successful route rather than a contract 400.
2. Repair the shared action contract: retain seven physics terms, restrict the generic HTTP/MCP operation set to the five executable shapes, and update both arrival documents and generated output together.
3. For UNS-002 and UNS-004, have product ownership choose precise read/write language, then add contract tests that enumerate public speech reads and unauthenticated writes before changing prose.
4. For UNS-003, replace stale ChatGPT navigation with the official guide and stable endpoint/security instructions; verify supported account/workspace branches manually.
5. For UNS-005, place “permanent” and “one-way” beside every raw withdrawal route and add the matching cross-surface assertion.
6. Regenerate `src/door.ts`, run targeted tests, `npm run typecheck`, `npm test`, coverage, Postgres integration, and deployed read-only probes; release text and schema corrections in a reversible deployment while monitoring action 400s and connector failures.
7. Run a new full `$unshittify` audit after repair, cite this report, and use a fresh skeptic that has not proposed the fixes or read the earlier conclusions first.

Q-001 should be assigned to a separate payment owner in parallel; no repair should be inferred until the mocked post-settlement failure is reproduced.

## Verification and Release Gates

- **Action gate:** `tools/list` must not advertise an `act` value that the tool dispatches to a guaranteed 400. Dedicated `say` and `make` tools must remain discoverable and pass representative local calls.
- **Truth gate:** the composed root and `/llms.txt` must state the same executable route rules, distinguish “stand there to post” from public remote reading, name the anonymous-reporting exception precisely, and call withdrawal permanent/one-way.
- **Hosted-chat gate:** the response must link the current official OpenAI guide, preserve exact-origin browser sign-in and no-key-in-chat warnings, and be manually exercised on each claimed supported ChatGPT account/workspace class.
- **Regression commands:** `node scripts/embed-door.mjs`; `npm run typecheck`; `node --test --experimental-strip-types test/help-text.test.ts test/hosted-chat-discovery.test.ts test/family-truth.test.ts test/round2-surfaces.test.ts test/routes.test.ts`; `npm test`; `npm run test:coverage`; `npm run test:postgres`; and `npm run test:e2e` where the configured environment is non-production and disposable.
- **Test data:** fake resident keys, fake Neon/Postgres fixtures, fixed public note/event fixtures, and mocked facilitator/chain responses only. Never use a resident's live note body in snapshots.
- **Forbidden verification:** no production registration, note, flag, moderation, withdrawal, offer claim, x402 header, transaction proof, Base transfer, migration, or deployment merely to validate this report.
- **Rollback conditions:** roll back the text/schema deployment together if MCP tool discovery loses `say`/`make`, action contract errors rise, OAuth discovery fails, or supported hosts can no longer connect. Copy-only rollback must not restore the false action schema.
- **Evidence required before release:** failing pre-fix tests, passing targeted and full suites, generated/source parity, dated screenshots or operator notes for supported host connection flows, deployed read-only hashes/markers, and an independent reviewer that rechecks the final behavior rather than only the wording.

## Overseer Record

**Independent skeptic:** COMPLETED
**Reviewer separation:** CONFIRMED

Inspector roles were source/publish mapper, protocol-contract checker, arrival-order/UX checker, safety/payment boundary checker, test-drift checker, primary normalizer, and fresh skeptic. The fresh skeptic received candidate evidence in a new context, was forbidden to read reports or write files, and proposed none of the candidates it judged.

- **Upheld:** action-contract contradiction (MEDIUM), global speech-discovery contradiction (MEDIUM), stale ChatGPT path (LOW), and anonymous-reporting exception (LOW).
- **Changed:** reduced the irreversible-action candidate to withdrawal wording only (LOW); agreement append-only wording was not strong enough to admit.
- **Rejected:** raw registration appearing before hosted sign-in was rejected as a separate finding because the full response contains the safer hosted instruction; its ordering is retained only as evidence.
- **Separated:** generic x402 post-settlement recovery remained a payment-review question, not a front-door defect.
- **Verdict disagreement:** the skeptic wrote “BLOCK” while rating every admitted item MEDIUM or LOW and the payment issue out of this gate. The report contract reserves `DO NOT RELEASE` for a blocker or an in-scope unresolved high-impact question, so the primary used `RELEASE WITH KNOWN RISKS` and recorded the disagreement rather than silently adopting an unsupported verdict label.
- **Evidence effect:** the skeptic independently re-opened the connected code/tests and upheld the E3 proofs, raising the five admitted items to E4.

All inspectors used the same model family and shared filesystem, so agreement cannot remove correlated blind spots.

## Honest Limitations

- No other audit report was opened. Concurrent report filenames appeared in Git status only. Evidence cited in this report was re-opened directly from source after parallel review and the public live claims were re-established with read-only requests.
- Parallel inspectors were explicitly told not to write files, but earlier non-skeptic inspectors unexpectedly created or overwrote the untracked `docs/audits/GPT-5_frontdoor_Audit_Findings.md`. This report never opened that file. It was left untouched to avoid destroying an untracked artifact without permission. No source code was changed by the primary audit.
- Many other untracked audit files and an untracked root `audit-backup.json` appeared while this work ran. Their contents and ownership are unknown and were not opened; they could make future workspace-wide status evidence look different, but they did not overlap the source files cited here.
- The two requested text files were checked fully; connected implementation/tests were traced selectively. The 118-path inventory is a scope measure, not a claim that every path was audited.
- The focused runs passed 25 relevant tests. The full unit, coverage, Postgres integration, typecheck, and Playwright suites were not run, so no whole-product quality or 80% coverage claim is made.
- Local behavior tests use fakes. They prove deterministic handler contracts, not production database, OAuth, chain, facilitator, concurrency, timeout, or retry behavior.
- Live checks were unauthenticated public reads at one point in time. No production write, secret, wallet, USDC, or irreversible action was used. Live public data and third-party menus can change after the recorded time.
- OpenAI's official documentation was current when checked, but real plan, workspace, staged-rollout, device, and regional behavior was not exercised. Claude instructions received only a limited source/docs comparison and no live account test.
- Q-001 is intentionally not a defect claim. Static ordering is concerning, but provider idempotency, operational recovery, and a fault-injection reproduction are missing.
- Outside systems, infrastructure, secrets, backups, observability, and platform-specific file permissions were not fully covered. Same-model reviewers may share assumptions. A human product owner and a separate payment/security reviewer should validate the remaining decisions.
- Structural validation of this Markdown will prove only report shape, not the conclusions. The evidence supports “no additional issue found in the checked scope,” never “there is no problem.”
