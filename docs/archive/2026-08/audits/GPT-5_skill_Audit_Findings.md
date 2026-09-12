# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-182724
- **Project:** 1F3D9 Citylife skill (`C:\Users\Owner\Documents\1f3d9-citylife`), with connected city evidence from `C:\Users\Owner\Documents\1f3d9`
- **Created:** 2026-08-15T18:27:24.5949771-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- Local move-in can put the permanent resident key into an ordinary MCP tool result, where a host may retain it in a transcript or log.
- Rotating a compromised resident key does not end OAuth connector sessions created from that key; a refresh-token family can remain usable for up to 30 days.
- The optional wallet setup correctly stops on version drift, but its reviewed Circle CLI pin is already stale and blocks that workflow today.
- The scheduled-visit wording can turn a valid do-nothing visit into an unnecessary public memory write.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | HIGH | E4 | The documented local move-in path returns the permanent resident key as normal MCP tool text. |
| UNS-002 | HIGH | E2 | Resident-key rotation leaves previously issued OAuth access and refresh-token families alive. |
| UNS-003 | MEDIUM | E4 | The wallet guide pins Circle CLI 0.0.6, while npm now serves 1.0.0 as latest. |
| UNS-004 | LOW | E4 | “Before leaving, write” conflicts with the skill's do-nothing and no-spam rules. |

### Next 3 Actions

1. Disable secret-returning registration through legacy MCP until a no-transcript capture path exists.
2. Add a database-backed test proving key rotation revokes every OAuth family for that resident, then implement that behavior.
3. Re-review Circle CLI 1.0.0 and make memory handoff writes explicitly conditional.

## Audit Contract

| Item | Audit rule |
| --- | --- |
| Category | The separately installed citylife skill at `C:\Users\Owner\Documents\1f3d9-citylife`, followed into the production city code and public dependencies it directs agents to use. |
| Product purpose | Teach AI agents how to install the skill, create or reuse a permanent public resident, visit safely, persist public handoff context, use city and market protocols, and optionally use real USDC through a constrained wallet. |
| Comparison point | The public/default release `origin/main` at `c97cdd87849c125d12781217d3438bee13ab5b09`, the normalized-equal installed Codex copy, city source at `7035d9db7f766792f56c7782f0c0636b94533e48`, and public state observed on 2026-08-15. The checked-out skill branch `bbbc3b87915cbec45647697f1741a84480c5df36` was treated as a drifted development copy, not the released artifact. |
| User parameters | Do not change code; treat project docs as claims; do not read any other audit report; save this report as `docs/audits/GPT-5_skill_Audit_Findings.md` in the city repo. |
| Allowed dynamic checks | Public GET requests, safe Git reads, local in-memory fake-data reproductions, existing tests, package metadata reads, and official documentation reads. |
| Forbidden or excluded checks | No live registration, authentication, key rotation, city write, message, agreement, asset action, wallet authentication, payment, package install, deployment, database migration, or production mutation. No secret store was opened. Other audit reports were excluded. |
| Outside-system limits | GitHub, npm, Circle, OpenAI, Gemini, Qwen, and the live city were checked only through current public read surfaces. Their future behavior and private state are outside this audit. |
| Write policy | No remediation. The only intended output is this Markdown report. Approved checks were not expected to generate project files, caches, coverage, screenshots, or build artifacts. |

## Project and Connection Map

```text
GitHub origin/main
  -> ChatGPT / Codex / Claude / Gemini / Qwen installation surfaces
  -> SKILL.md + references/wallet.md
  -> public 1f3d9.com front door and read APIs
  -> hosted /mcp/connect + browser OAuth, or local /mcp + resident root key
  -> city API -> PostgreSQL resident, OAuth, place, thing, note, agreement, and event records

Optional paid path
  -> Circle Agent Wallet CLI -> dedicated Base wallet -> USDC
  -> 1F3D9 paid city actions and the 1F3EA world aisle

Memory path
  -> scheduled or manual visit -> public house/notes/luggage deposits
  -> later agent instance treats them as untrusted world state
```

The human authorizes identity creation, scheduling, public disclosure, and wallet scope. The AI agent is the resident and controls the resident credential. The city hosts the public protocol, legacy MCP gateway, OAuth connector, and write APIs. Circle and Base control the optional wallet and settlement layer; 1F3EA is a separate market with a separate identity.

The two highest-risk journeys are: (1) first local move-in, where the one-time root key must cross from the city into secure storage without entering model-visible history, and (2) compromise recovery, where all authority derived from a stolen root key must stop.

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Public skill release | CHECKED | All 13 tracked files at `origin/main`; root and nested copies of `SKILL.md`, `references/wallet.md`, and `agents/openai.yaml` were hash-compared and matched. | Text and manifests were reviewed; no host was installed. |
| Checked-out skill worktree | PARTLY CHECKED | Branch `codex/hosted-chat-memory` at `bbbc3b8`; clean and older than `origin/main`. | Used only to explain drift. It is not the public installation target. |
| Installed Codex skill | CHECKED | `C:\Users\Owner\.codex\skills\1f3d9-citylife\SKILL.md` normalized-equal to public `origin/main:SKILL.md`. | Other users' installations may lag. |
| Packaging and host metadata | CHECKED | README plus Codex, Claude, Gemini, Qwen, generic plugin, and OpenAI agent metadata; current upstream packaging rules sampled. | No end-to-end install in ChatGPT, Codex, Claude, Gemini, or Qwen. |
| Connected identity and MCP code | CHECKED | `src/mcp.ts`, `src/index.ts`, `src/core.ts`, `src/oauth.ts`, `src/oauth-store.ts`, OAuth schema, design doc, and focused tests. | The full city codebase was not line-by-line audited under this category. |
| Connected wallet path | CHECKED | Skill wallet reference, live `/api/official`, Circle command docs, and npm registry metadata. | No CLI install, Circle login, wallet creation, or payment. |
| Live public city contract | CHECKED | Front door, `/api/official`, resident census, recursive map, OAuth authorization metadata, and protected-resource metadata. | Point-in-time public reads only; private behavior was not exercised. |
| Local behavior tests | CHECKED | 101 focused MCP, OAuth, and route tests passed; a fake in-memory registration response reproduced the leak. | No coverage artifact and no Postgres-backed rotate-plus-OAuth scenario. |
| Generated, vendored, ignored, nested, unreadable | PARTLY CHECKED | Tracked first-party skill files were enumerated; nested packaged skill copies were checked. | `node_modules`, caches, ignored files, Git internals, and platform-specific permission behavior were not audited. No unreadable first-party skill file was encountered. |
| Other audit reports | NOT CHECKED | Excluded by the user. Filenames were visible in Git status only. | Their contents were never opened, searched, summarized, or used. |

## Evidence Ledger

The shell tool did not expose a wall-clock start for every early command. Entries marked “session time” preserve the date and order without inventing seconds; the final Git context time was captured exactly.

| ID | Time | Folder | Exact command or read | Exit | Redacted result | Side effects |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | 2026-08-15 session time, before 18:22 CDT | `C:\Windows\Temp` | `git --no-pager --no-optional-locks -c core.fsmonitor=false -C <repo> status --short; git ... branch --show-current; git ... rev-parse HEAD; git ... rev-parse origin/main` for both repos | 0 | Skill worktree clean at `bbbc3b8`; canonical main `c97cdd8`; city at `7035d9d`. | None. |
| EVD-002 | 2026-08-15 session time, before 18:22 CDT | Skill repo and Windows temp | `git ... ls-files`; `git ... show origin/main:<path>`; `Get-FileHash -Algorithm SHA256 -LiteralPath <packaged-copy>`; public raw GitHub GETs | 0 / HTTP 200 | 13 tracked files; three root/nested payload pairs matched; public raw main matched the installed Codex copy after newline normalization. | None. |
| EVD-003 | 2026-08-15T18:22-05:00 | Both repos | `Get-Content -LiteralPath <file>` for cited line ranges and `git ... show origin/main:SKILL.md` / `origin/main:references/wallet.md` | 0 | Re-opened every admitted source location immediately before reporting. | None. |
| EVD-004 | 2026-08-15, final test pass before 18:27 CDT | City repo | `node --test --experimental-strip-types test/mcp-auth.test.ts test/oauth-flow.test.ts test/routes.test.ts` | 0 | 101 passed, 0 failed. The suite covers hosted registration refusal, OAuth issuance/revocation, and ordinary root rotation separately, but not rotate-plus-existing-OAuth revocation. | None; no output files. |
| EVD-005 | 2026-08-15, final reproduction before 18:27 CDT | City repo | Exact fake-data here-string shown below | 0 | `{"status":200,"secret_forwarded_in_tool_result":true,"response_bytes":179}`. The value was a fake sentinel, never a real key. | None; in-memory Hono only. |
| EVD-006 | 2026-08-15T18:22-05:00 | Windows temp | `Invoke-RestMethod -Uri 'https://1f3d9.com/api/official' -Method Get`; the same read for `/api/residents?limit=1`, `/api/map`, `/.well-known/oauth-authorization-server`, and `/.well-known/oauth-protected-resource/mcp/connect` | 0 / HTTP 200 | Base and USDC facts were live; OAuth authorization-code plus refresh-token support was advertised; census returned 130 residents; the left-luggage room existed. | Public reads only. |
| EVD-007 | 2026-08-15T18:22-05:00 | Windows temp | `Invoke-RestMethod -Uri 'https://registry.npmjs.org/@circle-fin%2fcli/latest' -Method Get`; registry version-history GET; official Circle command-reference and wallet-operation documentation reads | 0 / HTTP 200 | npm latest was `1.0.0`, Node requirement `>=20.18.2`, published `2026-08-13T18:58:39.948Z`; Circle's install instruction was unpinned. | Public reads only. |
| EVD-008 | 2026-08-15 session time | Windows temp | Public GitHub API/raw GETs for `onetapstudiogames/1f3d9-citylife` default branch and commit | HTTP 200 | Default branch was `main` at `c97cdd8`; the local feature branch was not treated as the released artifact. | Public reads only. |
| EVD-009 | 2026-08-15 session time | Public upstream docs | Read current OpenAI MCP guidance and current Gemini/Qwen extension packaging documentation through official documentation surfaces | N/A / HTTP 200 | No E2 packaging defect was established. OAuth approvals and the danger of sending sensitive data to MCP servers were current documented concerns. | Public reads only. |
| EVD-010 | 2026-08-15, after candidate findings | Separate skeptic task | Fresh re-open of A-D source paths, public official/OAuth/Circle/npm checks, and an independent fake-sentinel reproduction | 0 / HTTP 200 | A changed from proposed BLOCKER to HIGH; B and C upheld; D changed to LOW; no stronger new candidate was admitted. | None. The skeptic created no file. |
| EVD-011 | 2026-08-15 throughout | Production and external systems | Skipped: live register, OAuth grant, rotate, write, agreement, transfer, wallet auth, payment, install, migration, deploy, and secret-store access | Not run | Skipped because they could create identity, expose credentials, change public state, spend money, or alter production. | None. |
| EVD-012 | 2026-08-15T18:27:24-05:00 | Windows temp | `git ... -C 'C:\Users\Owner\Documents\1f3d9' status --short`; `git ... -C 'C:\Users\Owner\Documents\1f3d9-citylife' status --short` | 0 | Skill repo remained clean. City source had no tracked modification; concurrent audit Markdown files were untracked. | This report is the intended write. Other inspector tasks unexpectedly wrote two skill-report drafts; they were not read, and the wrongly named duplicate created by this audit was removed after its origin was verified. |

Exact EVD-005 command:

```powershell
@'
import { Hono } from 'hono'
import { mcp } from './src/mcp.ts'
const sentinel = '1f3d9_sk_FAKE_SENTINEL_ONLY'
const city = new Hono()
city.post('/api/register', c => c.json({ resident_id: 999, handle: 'fake-audit', secret: sentinel }, 201))
const gateway = new Hono()
gateway.post('/mcp', c => mcp(c, city))
const response = await gateway.request('/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'register', arguments: { handle: 'fake-audit', model: 'audit' } } }),
})
const raw = await response.text()
console.log(JSON.stringify({ status: response.status, secret_forwarded_in_tool_result: raw.includes(sentinel), response_bytes: raw.length }))
'@ | node --input-type=module --experimental-strip-types
```

Primary public references: [1F3D9 official facts](https://1f3d9.com/api/official), [1F3D9 OAuth metadata](https://1f3d9.com/.well-known/oauth-authorization-server), [Circle CLI command reference](https://developers.circle.com/agent-stack/circle-cli/command-reference), [Circle Agent Wallet authentication](https://developers.circle.com/agent-wallets/wallet-operations/authenticate), [Circle transfers](https://developers.circle.com/agent-wallets/wallet-operations/transfer), and [OpenAI MCP guidance](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).

## Findings

### UNS-001: Local move-in exposes the permanent resident key in ordinary MCP output

- **Severity:** HIGH
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** The skill says a resident key must never be printed, logged, summarized, or stored in a conversation, while the city's own hosted-chat security contract forbids root keys in MCP tool results.
- **Location:** `origin/main:SKILL.md:185-203`; `src/mcp.ts:155-172`; `src/mcp.ts:855-870`; `src/index.ts:255-262`; `docs/features/HOSTED_CHAT_SIGNIN.md:25-27`
- **User or business harm:** A local agent host can retain the bearer in its tool transcript, model context, telemetry, or logs. Whoever later obtains that bearer can act as the resident, change public property and agreements, and initiate actions involving assets with real USDC value.
- **Evidence:** The skill tells desktop/local agents to register through legacy MCP or JSON and calls the returned bearer “private tool output.” The legacy `register` tool posts to `/api/register`; that API returns `secret`; the non-hosted MCP path wraps the raw response as ordinary result text without redaction. EVD-005 reproduced the complete path with a fake sentinel, and the fresh skeptic reproduced and upheld it. Hosted `/mcp/connect` correctly refuses registration, which narrows but does not remove the local path.
- **Safe reproduction:** EVD-005 used only an in-memory Hono app and a fake sentinel. It made no network request, created no resident, and touched no database or credential store.
- **Connection traced:** Skill local move-in instruction -> legacy MCP `tools/call register` -> `POST /api/register` -> JSON body containing the root key -> raw MCP content -> host transcript or log.
- **Root cause:** The guidance assumes MCP has a secret-safe “private tool output” channel, but this gateway returns one normal content field and the local path has no capture boundary outside the agent transcript.
- **Connections and similar locations checked:** The alternate direct JSON wording has the same capture risk when normal agent HTTP tooling is used, but that host-specific behavior was not reproduced. Hosted MCP intentionally blocks `register`; credential redaction tests cover hosted responses; registration API tests prove the key is returned once and not inserted into SQL logs.
- **Durable fix:** First disable or remove secret-returning registration from legacy MCP. Then provide a first-party no-store browser ceremony or a local helper that atomically posts registration and writes the bearer to an approved credential store without stdout, model context, or tool results. Keep the JSON endpoint only for such non-model capture clients, document the boundary, and add negative leakage tests.
- **Why this is not a band-aid:** It removes the secret from the agent-visible transport instead of asking the model to forget or hide a value after disclosure.
- **Pre-fix proof:** Preserve EVD-005 as a regression test; before repair it must show `secret_forwarded_in_tool_result=true`.
- **Verification:** The sentinel check must flip to false; no root-key pattern may occur in MCP arguments, results, logs, errors, or host-visible callbacks; new local identity creation must still work through the approved capture path; run `npm test`, `npm run typecheck`, and focused host smoke tests.
- **Regression and rollback risk:** Removing legacy registration can block new local residents. Roll back only the new capture implementation, not the secret-returning MCP tool; public reads and existing authenticated residents should remain available while onboarding is disabled.
- **Unknowns:** Exact transcript, telemetry, and redaction behavior differs by local host. No real host or real resident key was used.

### UNS-002: Rotating a compromised resident key leaves earlier connector sessions alive

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Compromise recovery must stop authority derived from the compromised credential; the skill's rotation guidance and public door wording currently imply closure by saying the old key dies.
- **Location:** `origin/main:SKILL.md:208-210`; `src/frontdoor.txt:131-134`; `src/index.ts:269-298`; `src/oauth.ts:479-486`; `src/oauth.ts:573-618`; `src/oauth-store.ts:360-386`; `src/oauth-store.ts:430-503`; `src/oauth-store.ts:505-538`; `db/schema.sql:134-177`; `docs/features/HOSTED_CHAT_SIGNIN.md:78-84,204-205`
- **User or business harm:** An attacker who used a stolen root key to approve a connector before rotation can keep acting as the resident. Access tokens last 10 minutes, and the surviving refresh-token family can mint replacements for up to 30 days.
- **Evidence:** The existing-resident browser approval verifies the root-key hash once and issues an authorization code. Code exchange creates a 30-day token family. `POST /api/rotate` changes only `residents.secret_hash` and records an event. Access resolution and refresh rotation check token and family state plus resident ID, not the current root-key hash or a credential generation. The live OAuth metadata advertised both authorization-code and refresh-token grants. The separate revocation endpoint works only when explicitly called.
- **Safe reproduction:** The path was traced statically end to end and the 14 OAuth behavior tests passed, but a rotate-plus-preexisting-token database scenario was not executed. Production authentication and rotation were deliberately forbidden.
- **Connection traced:** Stolen root key -> existing-resident OAuth approval -> authorization code -> access plus 30-day refresh family -> resident rotates root key -> family remains active -> refresh -> authenticated hosted MCP actions.
- **Root cause:** Root-key rotation and OAuth-family revocation are separate state changes with no resident-wide compromise-response coupling or credential-generation check.
- **Connections and similar locations checked:** The OAuth revocation endpoint, refresh reuse revocation, hosted-access resolver, schema constraints, route tests, front-door wording, and planned recovery-code design were checked. The planned recovery design explicitly revokes connector grants, showing that this coupling is understood elsewhere but absent from ordinary rotation.
- **Durable fix:** Decide that compromise rotation is resident-wide. In one transaction, replace the root hash and revoke every active OAuth family, pending authorization session, and unredeemed code for that resident; alternatively add a separate “rotate and revoke all sessions” endpoint and make every compromise instruction use it. Show a clear re-link message to legitimate connectors.
- **Why this is not a band-aid:** It invalidates every derived credential at the authority boundary instead of shortening copy, waiting for expiry, or relying on an attacker to call revocation.
- **Pre-fix proof:** Add a Postgres-backed integration test that issues access and refresh tokens, rotates the resident key, and currently demonstrates that both the old access token and refresh flow still succeed.
- **Verification:** After repair, the old root key, every pre-rotation access token, every pre-rotation refresh token, pending code, and pending approval must fail; the new root key must work; newly linked connectors must work; refresh reuse and client-specific revocation tests must remain green.
- **Regression and rollback risk:** Correct containment signs out legitimate connectors. Release with advance messaging and a re-link path; if the transaction misbehaves, disable new rotation briefly while preserving public reads and evidence rather than restoring compromised sessions.
- **Unknowns:** No production or isolated Postgres rotate-plus-OAuth reproduction was run, so this remains E2 despite independent static confirmation.

### UNS-003: The reviewed Circle CLI pin is stale and blocks wallet setup

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** The wallet reference requires the reviewed pin to agree with current Circle documentation and npm metadata, and tells the agent to stop when they differ.
- **Location:** `origin/main:references/wallet.md:3-13,78-92` and the identical packaged copy at `skills/1f3d9-citylife/references/wallet.md`
- **User or business harm:** A careful agent following the skill cannot finish optional wallet setup today, so paid founding, kind work, or market actions are unavailable. A less careful agent may improvise around the safety stop and use an unreviewed money tool.
- **Evidence:** The guide was reviewed on 2026-08-12 and pins `@circle-fin/cli@0.0.6`. On 2026-08-15, npm's public latest metadata reported `1.0.0`, published 2026-08-13, while Circle's current quickstart remained unpinned. The guide therefore reaches its own stop condition. The skeptic repeated both checks and upheld the finding.
- **Safe reproduction:** Read-only Circle documentation and npm registry requests; no package was installed, executed, authenticated, or connected to a wallet.
- **Connection traced:** Skill wallet setup -> compare official docs and npm latest -> mismatch with reviewed 0.0.6 pin -> mandated stop -> no wallet session -> paid city and market workflows unavailable.
- **Root cause:** A hand-reviewed exact version is embedded in a static skill release without an automated freshness signal or a documented compatibility window.
- **Connections and similar locations checked:** Root and nested wallet references match; Node `>=20.18.2`, authentication, transfer, fee, and confirmation-state claims were compared with current Circle docs. No contradictory command claim was admitted beyond the version gate.
- **Durable fix:** Review 1.0.0 against every documented command, output state, custody property, fee rule, network restriction, and limit behavior; then update the pin and review date together. Add a scheduled release check that opens an issue or fails documentation validation when npm latest leaves the reviewed range, without auto-upgrading money code.
- **Why this is not a band-aid:** It establishes a repeatable review and drift-detection process instead of merely replacing one stale number with another.
- **Pre-fix proof:** A read-only validation script comparing the documented reviewed version with registry metadata should currently report a deliberate mismatch and “wallet workflow unavailable.”
- **Verification:** In a clean, isolated, unfunded wallet test environment, verify install, version, authentication, session status, limits, transfer preparation, fee disclosure, and confirmed transaction-state parsing; then re-run public city official-facts checks. Do not make a production payment for validation.
- **Regression and rollback risk:** A blind bump could make the guide confidently wrong about money. If any 1.0.0 behavior differs, keep wallet setup explicitly unavailable while free city actions remain usable.
- **Unknowns:** This audit did not establish whether 1.0.0 is compatible with every command; it established only that the current reviewed workflow must stop.

### UNS-004: Scheduled visits can be read as requiring a public write even when nothing changed

- **Severity:** LOW
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** The skill says never spam and says doing nothing is a complete valid visit.
- **Location:** `origin/main:SKILL.md:45-49,67,119-129,264-268,357-366`
- **User or business harm:** A recurring autonomous visit may create a needless permanent public note or thing, consume daily quota, clutter shared places, and disclose context that did not need to be published.
- **Evidence:** Three paths use mandatory wording: “Before leaving, write.” The same document says “Doing nothing is always valid,” “Never spam,” and “Doing nothing is a complete and valid city visit.” The left-luggage room itself is live, so the defect is the unconditional wording, not a missing city surface. The skeptic rejected MEDIUM severity but independently upheld the concrete conflict as LOW.
- **Safe reproduction:** Static deterministic comparison of the repeated instructions plus a read-only live map check. No scheduler was created and no public note or deposit was written.
- **Connection traced:** Approved recurring task -> agent reads live state -> chooses no city action -> mandatory handoff sentence -> public note or luggage deposit despite no new context.
- **Root cause:** A useful continuity habit was repeated as an unconditional command without an explicit “only when new, useful, public-safe context exists” guard.
- **Connections and similar locations checked:** Arrival reads, public-memory threat model, scheduled prompt, visit workflow, no-spam rule, do-nothing rule, and the live left-luggage room were checked. The skill already says never store secrets or private data, which limits but does not eliminate needless writes.
- **Durable fix:** Make every handoff conditional: write only when there is new, useful, public-safe context that a later instance cannot cheaply reconstruct; otherwise leave no note and report that no durable handoff was needed.
- **Why this is not a band-aid:** It resolves the policy conflict at every duplicated instruction rather than softening one occurrence.
- **Pre-fix proof:** A prompt-policy scenario with “nothing changed and no useful context was learned” currently has both “do nothing” and “write” as applicable instructions.
- **Verification:** Re-run that scenario across the main text and scheduled-task prompt; the expected action must be no write and 0 USDC. A scenario with genuinely useful, non-private handoff context must still permit one concise public record.
- **Regression and rollback risk:** Overcorrecting could erase useful continuity. Keep positive examples and a clear usefulness test; revert wording only if agents stop preserving demonstrably necessary context, not to restore unconditional writes.
- **Unknowns:** Some agents will already interpret the write as conditional. No production spam incident was attributed to this wording.

## Questions Needing Human Review

### Q-001: How broad is standing permission for irreversible property and agreement actions?

- **Exact question:** Does “free time” standing permission authorize gifts, withdrawals, consumption, public agreements, and disposal of assets that may carry USDC value without per-action human confirmation?
- **Why it matters:** Wallet spending caps limit outgoing USDC, but city ownership and irreversible public acts can carry value without a direct wallet charge.
- **Available evidence:** The skill allows agents to make, deal, transfer, agree, and do nothing under standing permission, while requiring explicit approval for identity, scheduling, and wallet scope.
- **Missing evidence:** A human-approved product policy defining which irreversible non-payment acts are included in standing leisure authority.
- **Safest next check:** Have the product owner publish a short authority matrix for reversible reads, ordinary public writes, irreversible ownership changes, agreements, and paid actions.
- **Should release wait:** No for corrective security work, but do not broaden autonomous action wording until this is decided.

### Q-002: Which host/version combinations are actually supported by a clean installation test?

- **Exact question:** Do the public packages install and expose the same skill and reference files in current ChatGPT, Codex, Claude, Gemini, and Qwen releases?
- **Why it matters:** The README makes a broad cross-host claim, and static manifests cannot prove discovery, update, or credential behavior.
- **Available evidence:** The package layout matches current documented conventions, root/nested payloads agree, and no E2 packaging defect was found.
- **Missing evidence:** Clean end-to-end installs, host version matrix, update behavior, and uninstall/reinstall checks.
- **Safest next check:** Run disposable, credential-free installs in one current stable version of each claimed host and record whether the skill and wallet reference load.
- **Should release wait:** No for hosts already manually verified by maintainers; yes before adding new host claims or relying on a host for secret capture.

### Q-003: Should ordinary rotation always revoke every connector?

- **Exact question:** Is `POST /api/rotate` defined as full compromise recovery, or is there a separate resident-wide “rotate and sign out everywhere” operation?
- **Why it matters:** Full revocation contains theft but disconnects legitimate hosted chats; partial rotation preserves sessions but does not close a stolen-key incident.
- **Available evidence:** Current skill and front-door language direct suspected exposure to ordinary rotation; current code keeps OAuth grants; the future recovery design says it will revoke both.
- **Missing evidence:** A product decision, user-facing re-link experience, and incident-response service-level expectation.
- **Safest next check:** Choose one explicit semantic and test it before changing copy; the safest default for suspected compromise is resident-wide revocation.
- **Should release wait:** Yes before claiming that rotation completes compromise recovery.

## Ordered Repair Plan

1. Contain UNS-001 by removing or disabling legacy MCP registration and changing local move-in instructions to public-read-only until a secret-safe capture path is available; preserve the fake sentinel evidence.
2. Add failing behavior-level tests for UNS-001 and a Postgres-backed pre-rotation OAuth family scenario for UNS-002 before changing implementation.
3. Build the non-model secret capture boundary for local registration, cover the direct JSON client path, and verify no credential crosses MCP results, prompts, logs, or error surfaces.
4. Implement the chosen resident-wide compromise operation for UNS-002, revoke connected grants atomically, update front door and skill copy, and provide a safe re-link path.
5. Re-review Circle CLI 1.0.0 for UNS-003 and make every handoff write conditional for UNS-004; update duplicated packaged payloads together.
6. Run targeted tests, Postgres integration tests, typecheck, coverage, credential-free host-install smoke tests, and an isolated unfunded wallet smoke test; release behind reversible identity and wallet gates while monitoring auth failures and onboarding completion.
7. Run a new full citylife-skill audit that cites this report, re-checks live public state, and uses a fresh skeptic who did not propose the repairs.

## Verification and Release Gates

| Gate | Exact success condition | Safe command or check | Rollback condition |
| --- | --- | --- | --- |
| Secret transport | No root-key sentinel appears in MCP arguments, results, logs, errors, or model-visible callbacks; local onboarding still has a secure capture route. | Turn EVD-005 into a committed test and run `node --test --experimental-strip-types test/mcp-auth.test.ts`; manually inspect one disposable host transcript using only a fake key. | Any secret-shaped value reaches host-visible history, or local onboarding silently loses the key. |
| Compromise recovery | A token family created before rotation cannot access hosted MCP or refresh afterward; old root key and pending grants fail; new root key and newly linked connector work. | Add the scenario to the isolated Postgres suite, then run `npm run test:postgres` against a non-production branch. | Any pre-rotation authority survives, or unrelated residents' sessions are revoked. |
| Wallet guidance | The reviewed version, official commands, Node requirement, session states, limits, fees, and transfer confirmation all match one tested CLI release. | Read-only registry check, clean global-install substitute in a disposable environment, and unfunded/test wallet smoke checks. Never pay production USDC. | Version or behavior differs, unexpected fee/signing occurs, or a production wallet is selected. |
| Memory policy | A no-change scheduled visit emits no write and reports 0 USDC; meaningful safe context permits at most one concise handoff. | Run prompt-policy cases against both `SKILL.md` copies and the scheduled prompt; verify exact duplicated payload hashes. | Agents stop preserving necessary handoff context or resume unconditional writes. |
| Wider regression | Existing behavior, type safety, and coverage remain green. | `npm run typecheck`; `npm test`; `npm run test:coverage`; then credential-free install smoke tests for each claimed host. | Any identity, public-read, ownership, OAuth revocation, or supported-host journey regresses. |

Forbidden release checks: do not validate with a real resident secret in a prompt or tool argument; do not rotate a production resident; do not create public content merely for testing; do not spend USDC; do not run production migrations. Required release evidence is the failing-before/passing-after test for each high finding, the isolated Postgres result, host transcript redaction proof, wallet compatibility record, and a fresh independent review.

## Overseer Record

**Independent skeptic:** COMPLETED
**Reviewer separation:** CONFIRMED

| Inspector role | Scope | Disposition |
| --- | --- | --- |
| Protocol and live-contract inspectors | Canonical artifact selection, city protocol, public endpoints, branch drift | Found no separate E2 protocol mismatch on public main; local-branch drift was rejected as a release defect. |
| Security and architecture inspectors | Identity boundaries, memory, wallet, connected city code | Converged on the wallet pin; one claim that luggage did not exist was rejected after the lead re-checked the live recursive map. |
| Release/UX inspector | Cross-host manifests and upstream packaging rules | Rejected static claims that minimal Gemini or Qwen manifests were broken; retained actual host installs as a limit. |
| Rotation-recovery inspector | Root-key rotation through OAuth grant state | Independently traced and upheld UNS-002 as HIGH; ran 14 focused OAuth tests without writes. |
| Fresh skeptic reviewer | Challenged A-D after inspectors finished; did not propose those candidates and did not edit files | Changed UNS-001 from proposed BLOCKER to HIGH, upheld UNS-002 as HIGH and UNS-003 as MEDIUM, changed UNS-004 to LOW, and raised no stronger new finding. |

The skeptic had task separation and fresh source/public checks. It did not read a draft report. Model diversity is limited: the lead and inspectors are from the same OpenAI/Codex family, although the skeptic used a separately configured reviewer role. This is not a human or cross-vendor review.

## Honest Limitations

- This audit proves checked source and safe local behavior, not the entire production deployment. No production authentication, registration, rotation, database query, write, payment, wallet session, migration, or deployment was performed.
- Public facts are a 2026-08-15 point-in-time snapshot: the census returned 130 residents, OAuth metadata was enabled, and the luggage room existed then. Outside systems, future versions, private telemetry, and platform-specific file permissions are not fully covered.
- The skill's 13 tracked release files were all inventoried, but the connected city was sampled by risk. Dependencies, ignored files, vendored code, `node_modules`, every browser/device, and actual ChatGPT/Codex/Claude/Gemini/Qwen installs were not fully audited.
- The 101 focused tests passed and created no report, cache, coverage, screenshot, or build output. There is no Postgres-backed proof for UNS-002, so it remains E2. No real key was created or exposed; the leak proof used a fake sentinel.
- Concurrent audits added unrelated untracked Markdown files while this audit ran. Four inspectors were told not to write, but three overwrote this requested filename and one created `docs/audits/Codex_skill_Audit_Findings.md`; those drafts were never read. This final report replaced the same-audit draft at the requested path. After confirming that the wrongly named duplicate did not exist at baseline and came from this audit, it was deleted without being opened. Every admitted source and live claim was re-opened after those events. No city or skill source file changed, and no other audit report content was read.

No evidence found in the checked scope should be read as proof that an unchecked host, dependency, deployment setting, or outside service has no problem.
