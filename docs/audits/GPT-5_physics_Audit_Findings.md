# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-155154
- **Project:** 1F3D9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T15:51:54.8266719-05:00
- **Continued:** 2026-08-15T18:48:07.1184372-05:00
- **Source commit:** `7035d9db7f766792f56c7782f0c0636b94533e48`

## Plain-English Verdict

DO NOT RELEASE

- A real resident or connector credential can pass through name-like physics fields and become public. That is a credible account-takeover path.
- Paid kind and frontier requests can settle x402 before database-only rejection, without the durable recovery flow used by the market bridge.
- One accepted action can execute 8,192 immediate effects, and one observation can execute 65,024 delayed label writes.
- Local-law blocks escape their place, and paid kind revisions can overwrite a concurrent paid change.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | BLOCKER | E4 | Credential-shaped values are accepted in public physics identifiers and recipes. |
| UNS-002 | HIGH | E2 | x402 can settle before a paid kind or frontier write is known to be fulfillable. |
| UNS-003 | HIGH | E4 | Per-recipe and per-queue limits multiply into extreme single-request database work. |
| UNS-004 | HIGH | E3 | Local-law blocks apply globally, and delayed label/block authority survives repeal or transfer. |
| UNS-005 | HIGH | E2 | Concurrent partial paid kind revisions can revert one another. |
| UNS-006 | MEDIUM | E4 | A lost commit acknowledgement can return `failed` after an action is already applied. |
| UNS-007 | MEDIUM | E4 | Concurrent exact law replacements can merge into an unintended union. |
| UNS-008 | MEDIUM | E2 | A seller can change a place's laws while its paid sale is open. |
| UNS-009 | MEDIUM | E2 | Any timer exception can become a terminal failed resolution with no transient retry. |
| UNS-010 | MEDIUM | E4 | An overdue delayed block starts a fresh full duration when observed. |
| UNS-011 | MEDIUM | E2 | Opposite source/target thing actions can deadlock through reversed row-lock order. |
| UNS-012 | MEDIUM | E2 | A delayed thing move can validate adjacency against a stale origin. |
| UNS-013 | MEDIUM | E4 | Destructive caller-selected targets bypass the locality check used by other target effects. |
| UNS-014 | MEDIUM | E2 | Traits are described as defined once, but the database permits retroactive recipe changes. |
| UNS-015 | LOW | E2 | The public physics and MCP contracts drift from the executable contract. |

### Next 3 Actions

1. Stop credential-shaped identifiers and make paid x402 writes recoverable before accepting more affected production writes.
2. Add failing tests for the proven fan-out, payment, law, revision, timer, and concurrency cases before changing implementation.
3. Repair shared validators, budgets, idempotency, authority scope, and lock/version rules; then run every release gate in this report.

## Audit Contract

- Scope: the physics and rules engine: actions, effects, timers, traits, kinds, crafting, local laws, and the directly connected payment, transfer, API, MCP, and PostgreSQL paths.
- Product purpose: a persistent public city where autonomous agents act, make and own property, compose regional physics, and sometimes pay real USDC.
- Release profile: live, public, untrusted resident input, persistent history, and real-value transactions. The public census returned 130 residents during this continuation.
- User parameters: audit only; do not repair product code; treat documentation as claims; do not read other audit reports; save this report at `docs/audits/GPT-5_physics_Audit_Findings.md`.
- Exclusions: no authenticated production action, payment, moderation, sale, or other mutation; no credential store or secret-bearing environment file; no other file under `docs/audits`; no `audit-backup.json`.
- Same-audit continuation: the only audit report opened was the unfinished draft at this exact path from the referenced prior chat. It was replaced with the completed evidence record below.
- Comparison point: checked source and schema at commit `7035d9db7f766792f56c7782f0c0636b94533e48`; docs were used only as requirements to test.
- Allowed dynamic checks: local unit/type checks, disposable local PostgreSQL, stdin-only deterministic harnesses, safe Git reads, and anonymous public GET requests.
- Outside-system limits: the live x402 facilitator, Base settlement, Neon production settings, Vercel settings, GitHub protections, and authenticated MCP were not exercised.
- Write policy: no remediation. The only intended project write is this report. Normal test output included the ignored `test-results/` directory from Playwright.

## Project and Connection Map

- Application: Hono HTTP routes in `src/index.ts`, `src/world.ts`, `src/actions.ts`, and `src/society.ts`.
- Agent surface: MCP declarations and routing in `src/mcp.ts`.
- Rules engine: parsing in `src/physics.ts`; orchestration in `src/engine.ts`; mutations and timers in `src/engine-effects.ts` and `src/engine-timer-store.ts`.
- Data store: PostgreSQL/Neon schema in `db/schema.sql`; immutable action/effect history and mutable world state.
- Outside systems: x402 facilitator and Base for fees; Vercel for the public deployment; 1F3EA for world-market listings.
- Roles: anonymous readers, authenticated residents, property owners, buyers/sellers, and founder-only content moderation.

Critical journeys traced:

- Action: resident request -> `/api/action` or dedicated wrapper -> immutable `action_runs` -> transaction -> source/law programs -> effects -> `action_resolutions` -> response.
- Timer: `wait` brick -> `pending_effects` -> later authenticated observation -> `resolveDueEffects` -> effect mutations -> `effect_resolutions`.
- Local law: owner replacement -> append-only `place_law_changes` -> `effectiveLaws` ancestry -> action-time program -> immediate or delayed authority.
- Paid definition: x402/direct proof -> `treasuryFee` -> kind/frontier SQL -> payment use, revision/property, fee, and event.
- Sale: seller locks asset in `transfer_offers` -> buyer reservation/payment -> atomic ownership transfer.

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Public identifier and credential filtering | CHECKED | `src/input.ts`, `src/physics.ts`, write routes, deterministic parser proof | No production data scan |
| Actions, target scope, locks, and outcomes | CHECKED | `src/engine.ts`, `src/engine-target-scope.ts`, `src/actions.ts`, tests and harnesses | No production fault injection |
| Immediate and delayed effects | CHECKED | `src/engine-effects.ts`, `src/engine-timer-store.ts`, unit and PostgreSQL tests | No production load benchmark |
| Traits, kinds, revisions, crafting | CHECKED | `src/world.ts`, `src/crafting.ts`, schema and matching tests | No live paid request |
| Local laws and property transfers | CHECKED | `src/laws.ts`, `src/society.ts`, schema, disposable PostgreSQL | No live sale |
| x402 and direct fee sequencing | CHECKED | `src/pay.ts`, `src/world-support.ts`, paid route callers | Facilitator/Base not called |
| Public API and MCP contracts | CHECKED | live anonymous `/api/physics`, `src/index.ts`, `src/mcp.ts`, route guards | No authenticated MCP session |
| Test and release surface | PARTLY CHECKED | 401 default tests, 33 PostgreSQL tests, 12 E2E tests, typecheck | External CI/branch protections unavailable |
| Live deployment | PARTLY CHECKED | anonymous census and physics GETs returned 200 | No deployment commit identifier |
| Other audit artifacts | NOT CHECKED | exclusion obeyed | Concurrent reports were not opened |

Scope measure:

- 98 first-party files under `src/`, `test/`, `docs/`, and `db/` after excluding `docs/audits`; 38 were under `src/` and 39 under `test/`.
- Direct review covered all first-party physics/action/effect/timer/law/trait/kind/crafting/payment/transfer files and their connected tests and schema sections.
- `node_modules/`, `.vercel/`, ignored caches, secret-bearing files, nested repositories, and other audit outputs were excluded.

## Evidence Ledger

| ID | Time | Folder | Exact command | Exit code | Redacted result | Side effects |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | 2026-08-15, start | repo root | `Get-Content -Raw C:\Users\Owner\.codex\skills\unshittify\SKILL.md` and its three required reference files | 0 | Loaded audit, evidence, skeptic, and report rules | None |
| EVD-002 | 2026-08-15, restore | `C:\Users\Owner` | `git --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --branch --ignore-submodules=all` and `rev-parse HEAD` | 0 | Branch `codex/workspace-reconciliation`; source commit matched; no tracked source edits | None |
| EVD-003 | 2026-08-15, mapping | repo root | `rg --files src test docs db -g '!docs/audits/**'` plus targeted `rg -n` and numbered `Get-Content` reads listed by location in findings | 0 | 98 first-party files; direct caller/data paths re-opened | None |
| EVD-004 | 2026-08-15, continuation | repo root | `node --test --experimental-strip-types test/physics.test.ts test/engine.test.ts test/engine-scope.test.ts test/crafting.test.ts test/backend-correctness.test.ts` | 0 | 100 passed, 0 failed, 0 skipped | None |
| EVD-005 | 2026-08-15, same audit | repo root | `npm test`; `npm run test:postgres`; `npm run test:e2e`; `npm run typecheck` | 0 | 401 unit-style, 33 PostgreSQL, and 12 E2E tests passed; typecheck passed | Playwright refreshed ignored `test-results/` |
| EVD-006 | 2026-08-15 18:37 local | repo root | `Invoke-WebRequest -UseBasicParsing -Method Get -Uri https://1f3d9.com/api/residents?limit=1`; same for `/api/physics` | 0 | Both 200; census `total=130`; live physics payload matched the checked narrow contract | Anonymous public reads only |
| EVD-007 | 2026-08-15, continuation | repo root | PowerShell stdin Node proof importing `containsBearerSecret`, `worldName`, `parseTraitRecipe`, and `parseKindRecipe` | 0 | Same inert placeholder was recognized as a credential and accepted in all three name-like parsers | None |
| EVD-008 | 2026-08-15, continuation | repo root | PowerShell stdin Node fake-DB harness calling real `runAction` with 32 thing traits + 32 laws, 128 labels each | 0 | `effects=8192`, `labels=8192`, `queries=16393` | None |
| EVD-009 | 2026-08-15, continuation | repo root | PowerShell stdin Node fake-DB harness calling real `resolveDueEffects` for 512 rows with 127 labels each | 0 | `resolved=512`, `label_writes=65024`, `queries=130568`, `capped=true` | None |
| EVD-010 | 2026-08-15, continuation | repo root | PowerShell stdin Node harness using `setEngineTransactionRunnerForTests` to lose acknowledgement after work | 0 | Returned `failed`; canonical stored state was `applied`; attempts were `applied,failed` | None |
| EVD-011 | 2026-08-15, same audit | disposable local PostgreSQL | Two exact-replacement statements, both started behind a held place-row lock, then released concurrently | 0 | Requests `[alpha-law]` and `[beta-law]` left both laws active | Temporary container removed |
| EVD-012 | 2026-08-15, same audit | disposable local PostgreSQL | Resolve a block whose logical due time was several minutes old with a 60-second duration | 0 | Newly stored block still had about 60 seconds remaining | Temporary container removed |
| EVD-013 | 2026-08-15, same audit | disposable local PostgreSQL | Schedule a law-backed label, repeal the law, then resolve the due row | 0 | The repealed law's delayed label still applied | Temporary container removed |
| EVD-014 | 2026-08-15, review | repo root | Five scoped inspector passes plus three fresh skeptic passes using read-only `rg`, `Get-Content`, Git reads, and isolated proofs | 0 | Findings were upheld, narrowed, disputed, or rejected as recorded below | No edits by reviewers |
| EVD-015 | 2026-08-15, final checks | repo root | `docker ps --filter name=audit-`; safe Git status; `Get-Item playwright-report,test-results` | 0/1 | No audit container running; no tracked source edits; `test-results/` exists; Playwright report absent | None |
| EVD-016 | 2026-08-15, final validation | repo root | `python C:\Users\Owner\.codex\skills\unshittify\scripts\validate_report.py docs\audits\GPT-5_physics_Audit_Findings.md --json` | 0 | `{"valid":true,"finding_count":15,"errors":[],"warnings":[]}` | None |

Long multiline stdin bodies were executed directly and were not written into the repository. Their inputs, outputs, and the production functions they called are stated in EVD-007 through EVD-010; exact shell transcript timing was not retained across the resumed chat.

## Findings

### UNS-001: Credential-shaped secrets can become permanent public physics identifiers

- **Severity:** BLOCKER
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Every public write must reject resident and connector credentials; the source explicitly declares this policy.
- **Location:** `src/input.ts:11-24`, `src/input.ts:45-48`, `src/physics.ts:199-202`, `src/physics.ts:264-299`, `src/physics.ts:357-380`, `src/world.ts:456-523`, `src/world.ts:631-699`
- **User or business harm:** A resident that accidentally uses a live key as a kind name, trait name, label, law name, or ingredient reference publishes authentication authority. Another party can take over that resident and its property until the key is rotated.
- **Evidence:** `BEARER_SECRET_RE` recognizes the exact resident-key shape and protects `publicText`/`publicLabel`, but `worldName` and the physics-local `canonicalName` only apply the name regex. EVD-007 proved the same inert key-shaped placeholder is recognized as a credential and accepted by the affected parsers. Kind and trait list endpoints expose these fields publicly.
- **Safe reproduction:** Run EVD-007 with an inert placeholder, never a real credential. The independent skeptic repeated the proof and upheld the path.
- **Connection traced:** authenticated public write -> `worldName` or recipe `canonicalName` -> PostgreSQL kind/trait/law state and event -> anonymous `/api/kinds`, `/api/traits`, place reads, and moderated nested references.
- **Root cause:** Public identifier validation was duplicated and omitted the centralized credential check.
- **Connections and similar locations checked:** Free-text things, notes, agreements, and MCP argument/response guards do reject credential-shaped text. The gap is concentrated in world-style identifiers and recipe label/ingredient names.
- **Durable fix:** Create one safe public-identifier validator that includes credential rejection; use it in every world name, law name, kind/trait name, label, and ingredient parser; scan existing public identifiers without logging values; rotate any confirmed live credential before redacting or migrating stored rows.
- **Why this is not a band-aid:** One validator closes the shared trust-boundary gap instead of adding route-by-route string checks.
- **Pre-fix proof:** EVD-007 returned `recognized_as_secret=true`, `accepted_as_world_name=true`, `accepted_as_label=true`, and `accepted_as_kind_ingredient=true`.
- **Verification:** Add route and parser tests for all four credential families and every affected field; assert error bodies never reflect the value; test the existing migration/redaction decision on synthetic rows.
- **Regression and rollback risk:** Existing secret-looking but harmless identifiers may be rejected or require migration. Never include suspected values in logs, reports, or rollback artifacts.
- **Unknowns:** Production was not scanned, so this audit does not claim that a live credential has already been published.

### UNS-002: Paid writes can settle x402 before the city knows it can deliver

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** A real-money write must either validate before settlement or persist a stable, replay-safe recovery state for every post-settlement failure.
- **Location:** `src/pay.ts:60-112`, `src/world-support.ts:126-179`, `src/world.ts:281-339`, `src/world.ts:456-524`, `src/world.ts:528-627`, `db/schema.sql:424-440`
- **User or business harm:** The facilitator can settle $1 USDC and the route can then return `400` or `409` for an unknown trait, uniqueness conflict, stale owner/sale state, or another database-time rejection. The error response omits `X-PAYMENT-RESPONSE`, and these fee routes have no durable `payment_pending`/reconcile journey.
- **Evidence:** `settleX402` performs `/verify` then `/settle`; only afterward do kind/frontier routes execute their database transaction. Unknown trait validation is an `AFTER INSERT` trigger, and conflict/open-sale checks can race after settlement. `setPaymentHeader` runs only on successful route completion. The official [x402 reference flow](https://github.com/x402-foundation/x402) typically performs the requested work before settlement, while its [payment-identifier guidance](https://docs.x402.org/extensions/payment-identifier) makes safe retry response caching explicit server work rather than an automatic guarantee.
- **Safe reproduction:** Static trace only. No live payment or facilitator request was allowed. The skeptic independently broadened the affected path from kinds to frontier founding.
- **Connection traced:** paid client -> `X-PAYMENT` -> facilitator verify/settle -> `treasuryFee` returns settled proof -> route SQL rejects -> ordinary error without durable recovery token.
- **Root cause:** Fee settlement is treated as a prerequisite rather than a stateful part of the write transaction, while the route's last rejectable checks happen afterward.
- **Connections and similar locations checked:** Direct `fee_tx_hash` proofs can be retried manually; world-market sales already have explicit `payment_pending` reconciliation. Kind and frontier claims do not.
- **Durable fix:** Prevalidate all stable conditions; bind a request/idempotency record before settlement; persist the settled transaction in a recoverable pending state; return a stable reconciliation handle on ambiguous or post-settlement failures; make replay consume the same proof exactly once.
- **Why this is not a band-aid:** It makes payment and fulfillment one recoverable state machine rather than relying on facilitator behavior or client guesswork.
- **Pre-fix proof:** Add a facilitator stub that returns successful settlement, then make the kind trait-link trigger or frontier uniqueness check fail; assert the response carries a recoverable payment state and a replay completes without another charge. That test fails against the current flow.
- **Verification:** Test invention, revision, and frontier claims across validation failure, unique conflict, lost response, retry, and concurrent replay; verify exactly one fee/payment-use record and one fulfilled resource.
- **Regression and rollback risk:** This changes money-state sequencing. Roll out behind a route-level flag, preserve raw transaction evidence, and never unlock or discard an ambiguous settled payment during rollback.
- **Unknowns:** Facilitator replay semantics and the number of existing post-settlement failures were not available.

### UNS-003: Separate safety limits multiply into extreme work in one request

- **Severity:** HIGH
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Public untrusted execution needs a hard aggregate work budget per action and observation, not only per recipe, trait list, queue, or generation.
- **Location:** `src/physics.ts:47-56`, `src/physics.ts:215-234`, `src/input.ts:71-75`, `src/engine.ts:275-315`, `src/engine.ts:619-739`, `src/engine-effects.ts:225-232`, `src/engine-effects.ts:821-857`, `src/engine-timer-store.ts:3-69`
- **User or business harm:** A single action can issue thousands of sequential reads/writes, and one later observation can issue more than 130,000 database calls in the proven worst accepted timer batch. This can cause high latency, cost spikes, transaction failure, or availability loss for other residents.
- **Evidence:** A recipe permits 128 effects, a kind permits 32 traits, a place permits 32 laws, and same-owner law ancestry adds programs without an aggregate ceiling. EVD-008 applied 8,192 labels. EVD-009 resolved 512 accepted timers containing 127 labels each: 65,024 writes and 130,568 calls. Both completed instead of tripping a budget.
- **Safe reproduction:** EVD-008 and EVD-009 use real orchestration/effect functions with an in-memory tagged SQL adapter. A fresh skeptic independently repeated the action proof and verified the timer multiplication.
- **Connection traced:** `/api/action` or authenticated observation -> program/timer loading -> `executeEffects` loop -> per-effect scope read and mutation/event work.
- **Root cause:** Limits exist at individual authoring and queue layers, but there is no orchestration-level total for loaded programs, executed bricks, emitted writes, or queries.
- **Connections and similar locations checked:** Pending queue caps and generation depth prevent infinite backlog; they do not bound the work released by one request. `talk` and `make` share the action engine.
- **Durable fix:** Define deterministic total budgets for loaded programs, immediate bricks, due rows, and database-emitting work; calculate or reserve the budget before side effects; paginate catch-up; reject over-budget actions with a stable 4xx and no partial mutation.
- **Why this is not a band-aid:** It closes the multiplication point where individually legal inputs combine, covering every brick instead of one expensive effect.
- **Pre-fix proof:** EVD-008 and EVD-009 are passing-behavior proofs of unsafe accepted work.
- **Verification:** Add failing boundary tests for 32 traits + 32 laws, deep same-owner ancestry, 512 due timers, nested branches, and mixed immediate/delayed effects; assert the first over-budget request makes zero world writes.
- **Regression and rollback risk:** Existing heavy recipes may stop executing. Publish the new limit, return exact budget errors, and monitor rejection and latency before tightening it further.
- **Unknowns:** No production latency, statement timeout, or cost measurement was available, so an exact outage threshold is not claimed.

### UNS-004: Local-law blocks escape their region and delayed authority outlives the law

- **Severity:** HIGH
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** The product says physics and laws are regional; law-derived authority must not silently govern unrelated places or survive a lost sovereignty basis without an explicit rule.
- **Location:** `docs/SYSTEM_DESIGN.md:121-147`, `src/engine.ts:275-331`, `src/engine.ts:729-738`, `src/engine-effects.ts:240-273`, `src/engine-effects.ts:610-647`, `src/engine-effects.ts:773-805`, `db/schema.sql:517-531`
- **User or business harm:** A resident blocked by one place's law stays blocked after leaving that place. A queued label or block can also fire after the law is repealed or the place changes owner, letting stale authority continue affecting residents and property.
- **Evidence:** `active_blocks` stores `source_place_id`, but `isActionBlocked` checks only resident, action, and expiry. Timer payloads freeze `law_authority`; replay restores it without checking current effective laws for label/block. EVD-013 proved a repealed law's delayed label still applied. Foreign-property destroy is a narrow exception that does revalidate authority.
- **Safe reproduction:** Use disposable PostgreSQL to schedule a law-backed label/block, repeal or transfer before due time, resolve it, then move the resident elsewhere and query `isActionBlocked`. EVD-013 safely proved the repeal half.
- **Connection traced:** local law -> action program -> immediate block or stored wait payload -> `active_blocks`/`active_labels` -> later action anywhere.
- **Root cause:** Law provenance is recorded as audit metadata, but enforcement does not treat place, ownership, or current effective-law state as authorization conditions.
- **Connections and similar locations checked:** Damage revalidation in `destroyThing` shows the intended fail-closed pattern; labels and blocks lack it. `go_home` remains correctly unblockable.
- **Durable fix:** Centralize current law-authority validation for all law-backed effects; scope active blocks to the applicable region or define an explicit portable sanction type; decide and migrate existing pending effects/blocks under one documented rule.
- **Why this is not a band-aid:** It makes authority a live invariant shared by immediate, delayed, and enforcement paths.
- **Pre-fix proof:** EVD-013 plus the direct query mismatch between stored `source_place_id` and enforcement.
- **Verification:** Test immediate and delayed block/label across movement, repeal, transfer, ownership-boundary changes, expiry, and `go_home`; include a real PostgreSQL timer case.
- **Regression and rollback risk:** Existing law effects may stop applying outside their source or after repeal. Preserve history and stage the semantic migration so pending rows are neither silently duplicated nor discarded.
- **Unknowns:** Product intent for already-armed effects was not explicit; the global enforcement conflict with documented regional physics is explicit.

### UNS-005: Concurrent partial paid kind revisions can undo another successful revision

- **Severity:** HIGH
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** A paid partial revision must merge against the locked current revision or reject a stale precondition; an unchanged revision must not require another charge.
- **Location:** `src/world.ts:528-575`, `src/world.ts:577-627`, `src/world-support.ts:126-179`
- **User or business harm:** Two owner requests can both pay and succeed, yet the later request can restore an omitted description, trait list, or recipe from its stale pre-lock read. An identical/no-field retry can also charge and increment the revision without changing the definition.
- **Evidence:** The route reads the current revision without a lock, fills omitted fields in application memory, settles/verifies the fee, and only then locks `kinds`. The SQL uses the locked revision number but inserts the stale precomputed field values. No normalized equality or client revision precondition exists.
- **Safe reproduction:** Static concurrency trace. Hold the kind lock, start two partial revisions from revision N that change different fields, release them, and compare revision N+2: one field can revert. A fee-only body follows the same insert path unchanged.
- **Connection traced:** `/api/kind/:id/revise` -> unlocked current read -> partial merge -> fee -> locked `current_revision + 1` insert -> downstream kind listing, upgrade, and engine execution.
- **Root cause:** Version allocation is serialized, but content merge and equality decisions occur before that serialization point.
- **Connections and similar locations checked:** Full-body revisions avoid stale omitted fields but not no-op charging. Existing things stay pinned to their selected revision, limiting retroactive harm but not paid owner data loss.
- **Durable fix:** Merge inside the locked SQL from the locked current revision, or require a full body plus `If-Match`/current revision; reject stale patches; canonicalize and return idempotent success or 409 for no-op/replayed content before charging.
- **Why this is not a band-aid:** It aligns the content snapshot, version number, and payment decision under one concurrency contract.
- **Pre-fix proof:** Add a two-client PostgreSQL test for disjoint partial fields and a fee-stub test for an identical body. Both expected invariants are absent now.
- **Verification:** Assert concurrent revisions either preserve both changes or one receives a stale conflict; assert no-op/retry uses zero additional settlement and creates no new revision.
- **Regression and rollback risk:** Partial-update clients may need to send a version or full body. Keep old reads compatible while introducing explicit preconditions.
- **Unknowns:** Production client retry and partial-update behavior was not available.

### UNS-006: The engine can report failure after an action is already committed

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Destructive or quota-consuming actions need an authoritative result that remains discoverable after an unknown commit outcome.
- **Location:** `src/engine.ts:73-91`, `src/engine.ts:532-564`, `src/engine.ts:673-760`, `src/actions.ts:135-164`, `db/schema.sql:533-560`
- **User or business harm:** A caller can receive `failed` even though the world mutation and canonical `applied` resolution committed. Retrying can duplicate labels, transfers, notes, things, or quota spend, and there is no public result lookup or caller-supplied idempotency key.
- **Evidence:** The transaction wrapper calls `COMMIT`, then treats any thrown acknowledgement error as a rollback/failure. The outer catch attempts a `failed` resolution without first reading the unique existing resolution. EVD-010 returned `failed` while the simulated canonical stored result remained `applied`.
- **Safe reproduction:** EVD-010 uses the engine's own transaction-runner test seam to throw after `work` completed. A fresh skeptic independently repeated the deterministic proof.
- **Connection traced:** public action or `talk`/`make` wrapper -> `action_runs` -> transactional primitive/effects and `applied` resolution -> lost commit response -> outer `failed` response -> unsafe client retry.
- **Root cause:** Durable intent exists, but requests have no stable client key and the ambiguous error path does not reread the durable outcome.
- **Connections and similar locations checked:** The unique `action_resolutions.action_run_id` prevents the database row from flipping from applied to failed; it does not correct the caller response. MCP marks actions non-idempotent.
- **Durable fix:** Add an actor-scoped request key or sequence, persist it with intent, expose/reuse the canonical result, and reread by that key on any commit/transport ambiguity before returning failure.
- **Why this is not a band-aid:** It establishes one durable authority for first attempts, retries, wrappers, and lost responses.
- **Pre-fix proof:** EVD-010 returned `{returned:"failed", canonical:"applied", attempted:["applied","failed"]}`.
- **Verification:** Inject before-commit, during-commit, post-commit, and response-loss failures for `use`, `give`, `talk`, and `make`; retry the same key and assert one intent, one resolution, and one set of mutations.
- **Regression and rollback risk:** Incorrect idempotency scope could collapse legitimate repeated actions. Introduce an explicit key/version and retain the old response fields during staged rollout.
- **Unknowns:** The live Neon driver's exact ambiguous-error frequency was not measured.

### UNS-007: Concurrent law replacements can leave an unintended union active

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** A full replacement must converge to one complete requested list or reject a stale writer; it must not merge two lists accidentally.
- **Location:** `src/laws.ts:24-120`, `src/engine.ts:275-315`, `db/schema.sql:481-497`
- **User or business harm:** Two owner clients replacing the same place's laws can both report success while the place ends with both sets active. An old destructive or blocking law can remain enabled after the owner believes it was replaced.
- **Evidence:** The single CTE statement waits on `locked_place`, but PostgreSQL keeps the statement snapshot created before that wait. Its later `latest` CTE therefore cannot see the first writer's newly committed rows. EVD-011 ended with both laws active, while each response described only its own list. The official [PostgreSQL Read Committed documentation](https://www.postgresql.org/docs/current/transaction-iso.html) describes command-start snapshots and warns that a command can see a changed locked target row without seeing related rows from the same concurrent update.
- **Safe reproduction:** EVD-011 used disposable PostgreSQL and the checked statement shape. A fresh skeptic independently repeated and upheld the proof.
- **Connection traced:** `PUT /api/place/:id/laws` -> initial owner/trait reads -> one replacement CTE -> append-only change rows -> `effectiveLaws` executes the unintended union.
- **Root cause:** Lock acquisition and current-state derivation occur in one statement snapshot, and the response is assembled from `requested` rather than rereading canonical state.
- **Connections and similar locations checked:** The row lock prevents arbitrary simultaneous writes and duplicate identical replacement is effectively harmless; different lists trigger the stale-snapshot defect.
- **Durable fix:** Lock the place first inside an explicit transaction, then read current laws in a fresh statement before appending changes; alternatively require a law-set version and reject a stale replacement. Return the canonical post-write set.
- **Why this is not a band-aid:** It makes serialization cover the state used to compute the replacement, not merely the final insert.
- **Pre-fix proof:** EVD-011: `[alpha-law]` plus `[beta-law]` produced `['alpha-law','beta-law']`.
- **Verification:** Run real PostgreSQL tests for opposite, identical, empty, and overlapping lists; assert final state equals exactly one complete request and every response matches canonical state.
- **Regression and rollback risk:** Changing append-only change ordering can alter history/event presentation. Preserve prior rows and verify `effectiveLaws` against migrated histories.
- **Unknowns:** No production concurrency frequency was available.

### UNS-008: A seller can change a place's laws while its paid sale is open

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** A listed asset's material state must either be frozen or bound into the buyer's inspected/paid offer.
- **Location:** `src/society.ts:594-689`, `src/society.ts:829-908`, `src/world.ts:343-410`, `src/world.ts:414-429`, `src/laws.ts:29-64`
- **User or business harm:** A buyer can inspect or reserve a place, then receive different local physics because the seller changes its law set before claim. The buyer may already have paid when ownership transfers.
- **Evidence:** Opening a place offer sets `active_offer_id`; ordinary description and permission edits explicitly reject that state. `replacePlaceLaws` checks ownership and world-root status but not `active_offer_id` or an open offer. Claim transfers ownership without a law version/snapshot condition.
- **Safe reproduction:** In a local test, open a place offer, replace laws as the seller, then complete claim as the named buyer. Static route/SQL evidence shows all three operations can succeed.
- **Connection traced:** offer creation -> asset lock -> seller `PUT /api/place/:id/laws` -> buyer payment/claim -> changed place ownership.
- **Root cause:** Law mutation is outside the asset-sale mutex and offer contract even though other place mutations join it.
- **Connections and similar locations checked:** The gap is specific to laws; ordinary place fields are correctly frozen. Kind and thing mutation routes also check open offers.
- **Durable fix:** Block law replacement while a place offer is open, or store a law-set version/hash in the offer and require the same value at reservation and claim.
- **Why this is not a band-aid:** It binds all material state, including executable regional rules, to the sale state machine.
- **Pre-fix proof:** Add a route/integration test for offer -> law change -> claim; the law-change step should fail or the claim should reject a changed version.
- **Verification:** Cover open, reserved, payment-pending, claimed, canceled, and expired offer states; verify the buyer cannot receive an unbound law set.
- **Regression and rollback risk:** Sellers may need to cancel before legislating. Return a clear conflict and avoid changing already-open offers silently during rollout.
- **Unknowns:** Product docs do not explicitly list laws among frozen fields, but the existing place-edit freeze and paid buyer reliance make the inconsistency concrete.

### UNS-009: A transient timer error is recorded as permanent failure

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Lazy world simulation must distinguish deterministic invalid work from retryable database/transport failure.
- **Location:** `src/engine-effects.ts:709-719`, `src/engine-effects.ts:742-761`, `src/engine-effects.ts:773-857`, `db/schema.sql:620-632`
- **User or business harm:** A deadlock, serialization failure, or brief database/network problem can permanently consume a scheduled effect as `failed`. The authored world event never occurs, even though retry could have succeeded.
- **Evidence:** `resolveDueEffects` catches every exception from `resolveOne`, then calls `recordFailedEffect`. That writes the unique terminal resolution without SQLSTATE or transient classification. Future due scans exclude every resolved row, including `failed`.
- **Safe reproduction:** Inject one retryable-looking exception during `executeEffects`, allow the follow-up resolution write to succeed, then observe again. The row is excluded and never retried.
- **Connection traced:** authenticated observation -> due scan -> transaction/effect -> transient exception -> second transaction writes terminal `failed` -> future observation skips row.
- **Root cause:** The resolution model has only terminal statuses and the catch-all path equates infrastructure failure with invalid authored work.
- **Connections and similar locations checked:** Advisory locks and unique resolutions prevent duplicate concurrent execution. If the failure-record transaction also fails, the row remains retryable accidentally; there is no deliberate policy.
- **Durable fix:** Classify deterministic effect errors versus transient SQL/transport failures; keep transient rows unresolved or record retry metadata with bounded backoff/attempts; make the terminal decision atomic and observable.
- **Why this is not a band-aid:** It gives the timer state machine an explicit retry state rather than special-casing one error code.
- **Pre-fix proof:** Add a transaction-runner test that throws SQLSTATE `40001` once and succeeds next time; current behavior records `failed` after the first attempt.
- **Verification:** Test deadlock, serialization, timeout, connection loss, invalid payload, and permanent permission failure; assert exactly-once terminal resolution and bounded retries.
- **Regression and rollback risk:** Retries can duplicate effects if commit ambiguity is not handled with the same resolution/idempotency design. Ship this with authoritative outcome checks.
- **Unknowns:** Production retry middleware and database error rates were not available.

### UNS-010: Overdue delayed blocks restart their full punishment window

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Lazy timer catch-up should honor stored logical time for time-bounded effects.
- **Location:** `src/engine-effects.ts:260-271`, `src/engine-effects.ts:610-647`, `src/engine-effects.ts:773-805`, `test/engine.test.ts:1283-1320`
- **User or business harm:** A block that should already have expired becomes freshly active when someone eventually observes the place, extending a local punishment beyond its authored duration.
- **Evidence:** The timer preserves `logical_due_at` and restores it as `context.logicalAt`, but the block brick ignores that value and always stores `expires_at = now() + seconds`. EVD-012 resolved a timer several minutes late and still created about 60 seconds of new block time.
- **Safe reproduction:** EVD-012 used disposable PostgreSQL. A fresh skeptic independently repeated the proof.
- **Connection traced:** law/trait wait -> stored logical due time -> late observation -> `resolveOne` -> block insert using wall-clock observation time.
- **Root cause:** Logical time is carried through the timer model but not used by the terminal block effect.
- **Connections and similar locations checked:** Repeat scheduling correctly advances from the original logical clock. The defect is specific to block expiry materialization.
- **Durable fix:** Compute expiry from `context.logicalAt + duration`; if already expired, record a skipped/elapsed result instead of a fresh block. Document whether partial remaining duration applies.
- **Why this is not a band-aid:** It makes the block effect consume the timer's authoritative clock.
- **Pre-fix proof:** EVD-012 returned approximately 60 seconds remaining after a several-minutes-overdue 60-second block.
- **Verification:** Test on-time, partly overdue, fully overdue, repeated, and immediate blocks with controlled clocks in unit and PostgreSQL suites.
- **Regression and rollback risk:** Existing late-observed traps will become shorter or inert. No historical row should be deleted; change only future materialization behavior.
- **Unknowns:** None in the checked path; the desired behavior for partly overdue duration needs a documented choice.

### UNS-011: Opposite source/target actions can deadlock on thing rows

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Transactions that can touch multiple shared rows must acquire them in one stable global order.
- **Location:** `src/engine.ts:567-582`, `src/engine.ts:688-709`, `src/engine-effects.ts:151-180`, `src/engine-target-scope.ts:35-62`
- **User or business harm:** Two ordinary co-located actions can deadlock, causing PostgreSQL to abort one action and the API to return failure. Repeated opposite actions can create recurring reliability and latency harm.
- **Evidence:** Each transaction locks its actor presence, then its source thing. A later `label` or `check_label` on symbolic `target` locks the caller-selected target thing. Actor A can therefore hold thing 41 and wait for 42 while actor B holds 42 and waits for 41; their distinct presence locks do not serialize them.
- **Safe reproduction:** The local lock-trace harness produced `presence -> source_41 -> target_42` and the reverse order. A real two-connection PostgreSQL test was not run for this exact cycle.
- **Connection traced:** two `/api/action` requests -> `runAction` -> `sourceReady(...FOR UPDATE)` -> effect target scope -> second thing `FOR UPDATE` -> database deadlock detector.
- **Root cause:** Rows are discovered and locked incrementally in request order instead of gathered and sorted before program execution.
- **Connections and similar locations checked:** The cycle is narrow: it needs distinct source and target things and a brick using `requireScopedBrickTarget('target')`. Single-row actions and non-thing targets do not form this exact cycle.
- **Durable fix:** Resolve every row that may be locked, sort by stable type/id, and pre-lock in that order; add bounded retry only after canonical ordering removes known cycles.
- **Why this is not a band-aid:** Canonical ordering removes the wait cycle rather than hiding aborted transactions behind generic retries.
- **Pre-fix proof:** Add a two-client test with opposite source/target label actions and a short deadlock timeout; current ordering permits one deadlock victim.
- **Verification:** Run the opposite-direction case repeatedly on PostgreSQL and assert no deadlock, one valid result per request, and unchanged authorization checks.
- **Regression and rollback risk:** Wider up-front locks can reduce concurrency. Measure action latency and lock wait time, and keep the old path reversible until contention is understood.
- **Unknowns:** Production `deadlock_timeout`, retry policy, and occurrence rate were unavailable.

### UNS-012: A delayed thing move can use a stale origin to approve adjacency

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** A move's adjacency decision and its location update must be based on the same locked origin row.
- **Location:** `src/engine-effects.ts:440-494`, `src/engine-effects.ts:610-647`, `src/engine-effects.ts:773-805`
- **User or business harm:** Concurrent movement can make an owned thing jump from its new location to a destination that is not adjacent to that new location, breaking the city's movement topology.
- **Evidence:** `moveThing` reads the thing without `FOR UPDATE`, checks adjacency using that returned `placeId`, then updates by id/owner/offer/destination permission. The `UPDATE` does not require `moving.place_id` to equal the origin used for adjacency. Another transaction can move the thing between the read and update.
- **Safe reproduction:** Use two PostgreSQL connections: pause one after its origin read, move the thing through the other, then let the first continue. Its update can succeed without rechecking adjacency from the current origin.
- **Connection traced:** delayed or immediate move effect -> unlocked `thingState` -> place adjacency read -> concurrent move -> conditional update missing original-place predicate.
- **Root cause:** Validation and write are separate, and the write revalidates owner, sale state, and destination permission but not the origin-dependent invariant.
- **Connections and similar locations checked:** Resident-target delayed moves recheck the resident at the action place. The defect is the thing path. Destination permission and active-offer checks remain guarded.
- **Durable fix:** Lock the thing before reading its origin and keep that lock through adjacency/update, or include the exact original place and adjacency relation in one atomic update with a conflict on change.
- **Why this is not a band-aid:** It makes the location used for authorization identical to the row version being mutated.
- **Pre-fix proof:** Add the paused two-connection test described above; assert the stale mover receives a conflict and the thing remains on a legal edge.
- **Verification:** Test two concurrent moves, move plus sale, move plus withdrawal, delayed move after earlier movement, and destination permission changes.
- **Regression and rollback risk:** More locking can increase contention on popular movable things. Return a retryable conflict rather than silently widening allowed movement.
- **Unknowns:** No production concurrent-move telemetry was available.

### UNS-013: Destructive caller-selected targets bypass the engine's locality gate

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Caller-selected action targets are described and tested as local; destructive bricks must use the same scope check unless remote management is an explicit separate capability.
- **Location:** `src/actions.ts:113-145`, `src/engine-target-scope.ts:35-72`, `src/engine-effects.ts:151-159`, `src/engine-effects.ts:275-303`, `src/engine-effects.ts:331-349`, `src/engine-effects.ts:458-568`
- **User or business harm:** An action in place 2 can destroy, move, or transfer an actor-owned target thing in a remote place. That bypasses the action-place boundary and can make remote property mutations look like local physics.
- **Evidence:** `label`, `block`, and `check_label` route symbolic `target` through `requireScopedBrickTarget`; destructive target branches resolve existence and ownership directly. A local harness destroyed an actor-owned target at remote place 77 from action place 2 and reached the real withdrawal update.
- **Safe reproduction:** Use inert local rows and a caller-owned remote thing as symbolic `target`; run a trait program with `destroy target`. A fresh skeptic independently repeated the proof.
- **Connection traced:** `/api/action` arbitrary target id -> stored source/law recipe -> destructive target resolution -> ownership-only mutation without action-place validation.
- **Root cause:** Target scope is implemented per brick, and destructive helpers bypass the shared caller-target gate.
- **Connections and similar locations checked:** Foreign remote assets remain protected by ownership/local-law rules, so this is not a theft path. The affected behavior is remote mutation of actor-owned property and kind/place transfers.
- **Durable fix:** Apply caller-target scope before every destructive target brick, then introduce a separate named remote-management operation only if the product intentionally needs it.
- **Why this is not a band-aid:** It restores one target authorization rule across all bricks instead of patching destroy alone.
- **Pre-fix proof:** The independent proof returned `status=applied` and executed `UPDATE things SET withdrawn_at` for the remote target.
- **Verification:** Add a matrix for source/target, local/remote, owned/foreign, immediate/delayed, and shared-use destructive effects; assert only documented combinations succeed.
- **Regression and rollback risk:** Existing automation may rely on remote self-management. If that behavior is intentional, migrate it to an explicit endpoint before enforcing local action scope.
- **Unknowns:** The public product text does not explicitly promise remote self-management; no production dependency inventory was available.

### UNS-014: Trait recipes are not immutable at the database boundary

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Traits are documented as globally unique and defined once; stored things and laws must not change behavior through an in-place trait update.
- **Location:** `docs/DECISIONS.md:26`, `docs/SYSTEM_DESIGN.md:107-111`, `db/schema.sql:377-389`, `db/schema.sql:1357-1379`, `src/engine.ts:470-505`, `test/integration/engine-timer-postgres.test.ts:204-223`
- **User or business harm:** A privileged script, migration mistake, or compromised application role can update one trait row and retroactively change every thing and law that references it, without a revision, ownership decision, or corresponding immutable history.
- **Evidence:** The `traits` table has no update/delete denial trigger, while adjacent history and `kind_revisions` tables do. Engine program loading joins the current live `traits.recipe`. A checked PostgreSQL integration test explicitly updates a trait recipe and relies on later behavior changing.
- **Safe reproduction:** In disposable PostgreSQL, create a trait attached to a kind/law, run it, `UPDATE traits SET recipe=...`, and run the same pinned thing/law again. The checked test source already exercises the database permission.
- **Connection traced:** privileged/application DB write -> mutable `traits.recipe` -> `thingProgramsForAction` or `effectiveLaws` -> changed mechanics for existing world objects.
- **Root cause:** The application omits a public update route but the schema does not enforce the documented invariant, and execution dereferences mutable trait content live.
- **Connections and similar locations checked:** Kind definitions use append-only revisions and pinned thing revisions. No public trait-update API was found, which limits reachability but does not restore the data invariant.
- **Durable fix:** Deny trait update/delete at the database layer, represent any operational correction as an explicit append-only moderation/migration procedure, and ensure tests seed alternate traits instead of mutating live definitions.
- **Why this is not a band-aid:** The invariant is enforced where every application, script, and migration must obey it.
- **Pre-fix proof:** `test/integration/engine-timer-postgres.test.ts:204-223` performs a successful in-place update that changes subsequent mechanics.
- **Verification:** Assert ordinary application and migration roles cannot update/delete traits; verify existing kind/law behavior remains stable; add an audited exceptional migration test if one is required.
- **Regression and rollback risk:** Current tests or maintenance scripts that mutate traits will fail. Replace them before enabling the trigger and inventory existing operational procedures.
- **Unknowns:** Production database roles and audit logs were unavailable; no unauthorized production update is claimed.

### UNS-015: Published physics contracts do not exactly match executable behavior

- **Severity:** LOW
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Agent-facing schemas and the canonical physics endpoint must expose the same accepted actions, grammar, and limits as the server.
- **Location:** `src/physics.ts:37-56`, `src/index.ts:515-530`, `src/mcp.ts:242-299`, `src/actions.ts:99-109`, `test/routes.test.ts:2534-2556`
- **User or business harm:** Third-party agents cannot fully prevalidate target/destination/recipient values or lower/ingredient bounds from `/api/physics`, and MCP callers can invoke `act` with `talk` or `make` only to receive a 400. This causes avoidable failed automation and retry loops.
- **Evidence:** `/api/physics` omits `SYMBOLIC_TARGETS`, move destinations, transfer recipients, minimum timer, max kind ingredient entries, and max per-kind quantity. MCP `act` includes `talk` and `make` but posts to `/api/action`, which rejects both in favor of dedicated endpoints.
- **Safe reproduction:** Compare exported constants with the live anonymous `/api/physics` response from EVD-006; compare the MCP enum with the route guard. No mutation is needed.
- **Connection traced:** agent discovery -> public physics/MCP schema -> locally generated request -> recipe parser or `/api/action` -> preventable 400.
- **Root cause:** Multiple hand-maintained contract surfaces serialize subsets of the executable source of truth.
- **Connections and similar locations checked:** Dedicated `make` and `say` MCP tools exist, so functionality is not absent. `/api/physics` already exposes several maximums, including craft ingredients.
- **Durable fix:** Generate the public physics response and MCP action schema from the same typed constants/parser schema; keep dedicated content actions out of `act` unless the route supports them.
- **Why this is not a band-aid:** One source of truth prevents future enum/limit drift across all agent surfaces.
- **Pre-fix proof:** EVD-006's 200 response lacks the listed values, and static MCP/route comparison proves the impossible enum members.
- **Verification:** Add a contract test that every MCP `act` enum member succeeds at route validation and every enforced public recipe constant is present in the machine contract.
- **Regression and rollback risk:** Adding response keys is low risk; removing MCP enum values can affect callers that already fail and must move to dedicated tools.
- **Unknowns:** No production MCP telemetry or external client inventory was available.

## Questions Needing Human Review

- **Question:** Should founder moderation disable a removed trait's mechanics, or only hide illegal authored content?
  **Why it matters:** Public reads redact a removed trait/law recipe, but engine loaders still execute the raw stored recipe. Residents can therefore face mechanics they cannot inspect.
  **Available evidence:** `src/moderation-store.ts:113-210`, `src/engine.ts:470-505`, and `test/routes.test.ts:3010-3042`; docs say moderation removes illegal public content and cannot change laws.
  **Missing evidence:** An explicit decision covering executable mechanics attached to moderated traits.
  **Safest next check:** Record the policy decision, then add a behavior test proving the chosen visibility/execution relationship.
  **Should release wait:** Not for this question alone; admitted findings already require waiting.

- **Question:** What are current production counts, growth rates, retention plans, rate limits, and database timeouts for traits, actions, labels, blocks, and timer histories?
  **Why it matters:** Traits are free/global and several hot effect tables are append-only; queue caps do not cap historical rows or name squatting.
  **Available evidence:** `src/world.ts:659-699`, `db/schema.sql:377-389`, `db/schema.sql:499-632`, and append-only triggers at `db/schema.sql:1357-1379`.
  **Missing evidence:** Neon table/index sizes, query latency, gateway limits, autovacuum/partitioning, and production traffic.
  **Safest next check:** Run read-only aggregate/table-size queries and review deployment rate-limit/timeout configuration without exporting row contents.
  **Should release wait:** No; treat it as capacity evidence needed before choosing retention controls.

- **Question:** Do external GitHub/Vercel controls require PostgreSQL and E2E suites before main deploys?
  **Why it matters:** `npm test` and `test:coverage` run only `test/*.test.ts`; PostgreSQL and E2E are separate scripts, and no `.github` workflow exists in the checked tree.
  **Available evidence:** `package.json:12-17`, `scripts/deploy.sh:77-83`, and the absence of a checked-in `.github` directory.
  **Missing evidence:** Branch protections, required checks, and Vercel deployment settings.
  **Safest next check:** Read those settings and require an explicit combined release gate if they do not already enforce it.
  **Should release wait:** No for this question alone; it changes confidence in the release process, not the admitted source defects.

- **Question:** On repeal or property transfer, should already-queued law effects be canceled, grandfathered, or revalidated under the new owner?
  **Why it matters:** UNS-004 proves current authority persists, but migrating existing pending effects needs a non-destructive semantic choice.
  **Available evidence:** Stored `law_authority`, current destroy revalidation, and the documented regional-law model.
  **Missing evidence:** A product decision for already-armed effects and law inheritance on sale/gift.
  **Safest next check:** Decide this before changing pending rows; preserve immutable history and test the chosen transition.
  **Should release wait:** Yes for the final UNS-004 repair design, though temporary containment can proceed first.

## Ordered Repair Plan

1. Contain UNS-001 and UNS-002 first: reject credential-shaped identifiers at every affected boundary, temporarily gate unrecoverable x402 writes if needed, and preserve suspected identifiers/payment evidence without printing it.
2. Add failing behavior tests for UNS-001 through UNS-005, including facilitator-stub payment failures, aggregate budgets, regional blocks, and concurrent partial revisions.
3. Repair the shared identifier validator and paid-write state machine; inventory existing stored identifiers and unsettled/failed fee outcomes with redacted, read-only checks.
4. Add aggregate execution budgets and authoritative action request/outcome idempotency for UNS-003 and UNS-006 before changing timer retry behavior.
5. Repair law scope/versioning and sale binding for UNS-004, UNS-007, and UNS-008; migrate pending authority only after the human semantic decision.
6. Repair timer failure/time semantics and movement locking for UNS-009 through UNS-013; use real PostgreSQL concurrency and fault-injection tests.
7. Enforce trait immutability and generate public contracts from one source for UNS-014 and UNS-015; update maintenance tests/scripts before enabling the invariant.
8. Run targeted, connected, PostgreSQL, E2E, type, and security gates; stage release with payment, action latency, timer failure, deadlock, and law-state monitoring plus an explicit rollback path.
9. Run a new full `$unshittify` audit, cite this report, and use a fresh skeptic that did not propose or repair the findings.

## Verification and Release Gates

- Success conditions: all 15 pre-fix proofs have regression tests; credentials are rejected without reflection; paid retries fulfill once; actions/timers stop before aggregate budgets; local authority remains regional; concurrent revisions/replacements cannot silently merge or revert; timer and movement conflicts are retry-safe.
- Safe commands: `npm run typecheck`; `npm test`; `npm run test:postgres`; `npm run test:e2e`; then `python C:\Users\Owner\.codex\skills\unshittify\scripts\validate_report.py docs\audits\GPT-5_physics_Audit_Findings.md --json` for the follow-up report.
- Required new tests: facilitator-stub integration, credential-field matrix, action/timer work budgets, commit ambiguity, two-connection law/kind/action/move races, sale-law freeze, transient timer retry, overdue block, remote target scope, trait immutability, and generated contract parity.
- Manual/sandbox checks: use only inert credential placeholders and a non-production payment facilitator/Base environment; inspect public error/settlement headers and stable outcome lookup; verify existing historical rows remain readable.
- Test data: two residents, two co-located owned things, a remote owned thing, a place with two mechanical laws, an open place offer, one paid kind at revision N, due/overdue timers, and synthetic payment proofs.
- Forbidden live actions: no production credential test, payment, kind/frontier claim, law change, timer trigger, sale, property mutation, moderation, or load test.
- Rollback conditions: duplicate payment/resource creation, ambiguous pending money, partial action writes, new deadlocks, changed law scope without migration, or ordinary actions exceeding expected latency/error budgets.
- Evidence required before release: passing full gates, exact before/after proofs for every finding, read-only reconciliation counts for existing risky state, explicit payment and queued-law migration decisions, monitoring dashboards/alerts, and fresh independent skeptic approval.

## Overseer Record

**Independent skeptic:** COMPLETED
**Reviewer separation:** CONFIRMED

- Inspector roles were split across actions, effects/timers, traits/kinds, local laws, and public contracts/test gates. None of the three skeptic reviewers proposed the candidate set they assessed.
- The core skeptic independently reran credential, fan-out, ambiguous-commit, remote-target, law-race, and overdue-block proofs. That supports E4 for UNS-001, UNS-003, UNS-006, UNS-007, UNS-010, and UNS-013.
- Upheld: every admitted finding. The final overseer explicitly upheld all normalized items and judged release should wait for UNS-001, UNS-002, UNS-004, and UNS-005.
- Changed/narrowed: fan-out was reduced from BLOCKER to HIGH; action ambiguity and law replacement were reduced to MEDIUM; sale-law mutation was reduced to MEDIUM; target deadlock was narrowed to opposite source/target thing locks; move race was narrowed to stale origin adjacency; contract drift was reduced to LOW.
- Disputed/rejected: broad place/presence lock-order and unmeasured outage claims were rejected. Moderation-as-execution-disable, unlimited trait/name growth, off-repo CI enforcement, and exact queued-law migration semantics remain questions rather than asserted defects.
- Newly connected: the payment finding also reaches paid frontier founding; mutable traits retroactively alter pinned thing/law execution; remote destructive targets bypass locality but do not permit foreign-asset theft.
- Continuation challenge: four additional fresh review contexts upheld the release verdict and the credential, fan-out, payment, action-outcome, law, timer, kind-race, and contract paths. Some rated payment and concurrency findings more severely; one treated trait immutability and remote self-management as product-policy questions. The report keeps the earlier normalized severities and records the uncertainty instead of inflating them.
- Same-model limitation: reviewers used separate fresh contexts and did not read this report, but they were still models from the same provider family. Agreement does not replace a human payment/security review or production evidence.

## Honest Limitations

- The checked source commit is known, but the public deployment exposes no commit identifier; matching `/api/physics` is not proof that every live route ran this exact commit.
- Live checks were anonymous GETs only. No production credential, write, timer, payment, sale, moderation, MCP mutation, or load test was performed.
- The x402/Base finding is a direct source trace, not a real-money reproduction. Facilitator replay behavior, payment history, and existing recovery cases remain unknown.
- Disposable PostgreSQL and deterministic adapters prove reachable behavior, not production frequency, latency, gateway controls, or Neon failure modes.
- All checked suites passed, but they do not contain the failing cases this report calls for. The default test and coverage scripts also exclude PostgreSQL and E2E unless run separately.
- The resumed harness did not preserve exact wall-clock timestamps or full multiline shell transcripts for every prior read-only command. The ledger groups repeated searches/reads honestly and records exact dynamic inputs/results without inventing timestamps.
- `test-results/` was refreshed by Playwright. No Playwright report was present at final inspection, and no audit Docker container remained running.
- Other audit agents created many untracked files under `docs/audits` plus `audit-backup.json` during this work. None were opened or modified; only this same-audit draft was read and completed.
- Safe Git status showed no tracked source changes. The only intended project edit from this audit is `docs/audits/GPT-5_physics_Audit_Findings.md`.
- Secret-bearing files, credential stores, ignored dependency/build directories, external CI/deployment settings, database roles, production row contents, and other audit reports were excluded.
- Every admitted HIGH/BLOCKER location was re-opened after concurrent work, and tracked source remained at the recorded commit. Concurrent untracked audit artifacts could not be attributed or validated.
- Outside systems and platform-specific file permissions are not fully covered. The verdict means concrete release-stopping evidence exists in the checked scope; it does not claim the rest of the product is problem-free.
