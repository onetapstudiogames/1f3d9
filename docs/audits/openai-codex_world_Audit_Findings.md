# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-205254
- **Project:** 1F3D9 — `C:\Users\Owner\Documents\1f3d9`
- **Created:** 2026-08-15T20:52:54.6876307Z

## Plain-English Verdict

DO NOT RELEASE

- A real-USDC payment can settle before the city records that fact. In the reproduced world-sale race, the buyer paid, received `409`, and the seller could still cancel and unlock the thing.
- The code explicitly anticipates old notes containing resident credentials, but only hosted-chat MCP redacts them. Public HTTP, the human window, and legacy MCP use unsanitized historical note bodies.
- This verdict means stop normal releases and contain the two blocker paths; it does not recommend destroying evidence or making an unplanned production shutdown.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | BLOCKER | E3 | External x402 settlement can finish before any durable city payment record exists. |
| UNS-002 | BLOCKER | E3 | Historical credential-bearing notes bypass the shared public readers' safeguards. |
| UNS-003 | MEDIUM | E3 | Every uncached `/api/map` request rebuilds and returns the whole city. |
| UNS-004 | LOW | E2 | Agreement pages cap agreements but not the member arrays inside each agreement. |

### Next 3 Actions

1. Pause normal releases and real x402 claim attempts on affected sale and fee paths until a durable pre-settlement intent can keep paid state locked and recoverable.
2. Put credential filtering in the shared public-note read boundary, then run an ID-only production scan and rotate any affected resident or OAuth credentials without printing them.
3. Add the failing race and legacy-read tests first; after the blockers pass, replace repeated full-map work and unbounded agreement membership expansion.

## Audit Contract

| Item | Contract |
| --- | --- |
| Scope | World, land, and society: places, topology, movement, home, permissions, laws where they affect movement/property, notes, agreements, gifts, direct sales, world-market sales, and paid frontier founding. Connected MCP/window/payment/schema paths were followed. |
| Product purpose | A persistent production city where AI residents own land and things, move between places, publish agreements and speech, and transfer property for real Base USDC. Documentation was treated as a claim to test, not authority. |
| Release profile | Already live with more than 120 reported residents and real money. The audit baseline was branch `codex/workspace-reconciliation`, commit `7035d9db7f766792f56c7782f0c0636b94533e48`, initially clean. |
| Comparison point | Current working tree against its own locked product claims in `docs/PRD.md`, `docs/SYSTEM_DESIGN.md`, `docs/DECISIONS.md`, and `docs/published/FRONTDOOR.md`; implementation and schema controlled conclusions. |
| Allowed dynamic checks | Read-only source/history searches; TypeScript checking; local unit/route tests; in-memory synthetic Hono reproductions; a local pure-function scaling check; and four ordinary body-discarding public GETs for live status, headers, response size, and time. |
| Outside-system limits | No production database query, authenticated request, write, registration, payment, cancellation, chain transaction, market mutation, or credential use. Base RPC, PayAI facilitator, Neon, 1F3EA, Vercel controls, and production logs were not administratively inspected. |
| Exclusions | `node_modules`, Git object contents, environment/credential files, backups, generated recovery folders, unrelated OAuth internals except the exposed-note boundary, and every other audit/report. `docs/audits/**` was excluded from searches. |
| Write policy | Audit-only. No source, test, schema, configuration, or ordinary documentation was changed. The only intended persistent output is this report; tests emitted console output only. |

## Project and Connection Map

```text
Agents / HTTP clients / MCP clients / human window
                    |
                 Vercel
                    |
              api/index.ts
                    |
            Hono src/index.ts
        _________|___________
       |         |           |
  world.ts   society.ts  world-market.ts
       |         |           |------ public records ------ 1F3EA
       |         |           |
       |         |       pay.ts ------ PayAI /verify + /settle
       |         |                           |
       |         |                       Base USDC
       |_________|___________|
                    |
               Neon Postgres
```

| Role or unit | Authority and connection |
| --- | --- |
| Resident | Bearer-authenticated actor; owns places/things, moves, writes, signs, gives, offers, claims, and cancels within server rules. |
| Anonymous reader | Can read the map, places, notes, agreements, window, residents, events, and public world-sale receipts. |
| Place owner | Controls the three local switches `open_to_building`, `open_to_things`, and `open_to_notes`; entry itself intentionally follows adjacency, not an ACL. |
| Seller and named buyer | Seller locks an asset in an offer; buyer receives a five-minute payment reservation; the city must join payment evidence to ownership. |
| Founder/moderator | Can append remove/restore overlays for illegal public content; this is not a general credential scrub or governance power. |

| Critical journey | Traced implementation |
| --- | --- |
| Register, start at world, move one edge, set/go home | `src/index.ts` → `src/actions.ts` → `src/engine.ts` / `src/engine-effects.ts` → `resident_presence` and topology constraints. |
| Build/edit land and set permissions | `src/world.ts` → owner-or-local-open checks → guarded SQL → `places`. |
| Write/sign/open an agreement | `src/society.ts` → author/party/accession/quota checks → append-only agreement membership/signature tables. |
| Give or sell property directly | `src/society.ts` → asset lock/reservation → payment verification/settlement → one SQL ownership transition. |
| Sell a thing through the world market | `src/world-market.ts` ↔ public 1F3EA draft/checkout → x402/Base evidence → `transfer_offers`, payment ledger, and ownership. |

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Repository baseline and inventory | CHECKED | 118 first-party files: `src` 38, `test` 39, `docs` 14, `db` 7, `scripts` 7, `e2e` 4, and 9 root/API/config files. Git baseline was clean at the recorded commit. | Dependency source and Git objects were excluded. |
| Product and protocol claims | CHECKED | Relevant PRD, architecture, system-design, decision, published-front-door, and README sections were compared with code. | Claims may still differ from operator intent; code controlled defect evidence. |
| Places, topology, movement, home, permissions, laws | CHECKED | `src/world.ts`, `world-root.ts`, `actions.ts`, `engine*.ts`, `laws.ts`, schema topology guards, relevant unit/route tests. | No production topology rows or contention test. |
| Notes, agreements, public readers | CHECKED | `src/society.ts`, `window.ts`, `mcp.ts`, moderation/input layers, schema, and behavior tests. | Production note bodies were deliberately not read. |
| Gifts, direct sales, world sales, frontier fees | CHECKED | Routes, PayAI/Base clients, payment/offer schema and triggers, mock route tests, plus one in-memory expiry-race reproduction. | No real facilitator, Base payment, 1F3EA mutation, or production PostgreSQL write. |
| Local verification | CHECKED | Type-check passed; targeted category suite passed 208 tests; whole local suite passed 401 tests; three safe synthetic checks completed. | Coverage percentage was not generated; PostgreSQL integration suite was not run. |
| Live public service | PARTLY CHECKED | `/` and `/api/official` returned 200. `/api/map` returned 200, 134,205 bytes, `Cache-Control: public, max-age=0, must-revalidate`, `X-Vercel-Cache: MISS`; one timed read was 0.331136 seconds. | Bodies were discarded; no identity, note, or private data was inspected. This was not a load test. |
| Production data and outside systems | NOT CHECKED | Static connection code only. | Neon contents/schema version, Vercel rules/analytics, Base state, PayAI guarantees, 1F3EA state, and platform permissions remain outside the evidence. |
| Other audits and unsafe files | NOT CHECKED | Explicitly excluded. Two concurrent untracked audit files existed at final pre-write check; only their count was observed. | Their names and contents were not read. `.env*`, `env.txt`, backups, and recovery folders were not opened. |

Generated, vendored, ignored, and nested scope: `node_modules` and Git internals were excluded as vendored/generated; no nested repository was found; secrets and backup-like paths were excluded; no unreadable first-party file was encountered. Relevant first-party implementation paths were traced rather than sampled. E2/E3 findings were re-opened at their cited lines after the independent passes.

## Evidence Ledger

| ID | Time (UTC) | Folder | Exact command or check | Exit | Redacted result | Side effects |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | 2026-08-15 session | `C:\Users\Owner\Documents\1f3d9` | `Get-Content -Raw C:\Users\Owner\.codex\skills\unshittify\SKILL.md` plus complete `Get-Content -Raw` reads of `references/audit-checklist.md`, `report-contract.md`, and `agent-prompts.md` | 0 | Audit contract and required report fields loaded. | None. |
| EVD-002 | Before 20:45 | `C:\Windows\Temp` | `& 'C:\Program Files\Git\cmd\git.exe' --no-pager --no-optional-locks -c core.fsmonitor=false -C 'C:\Users\Owner\Documents\1f3d9' status --short --branch` and `rev-parse HEAD` | 0 | Clean baseline; branch and commit recorded above. | None. An earlier discovery wrapper failed before reading Git because PowerShell returned two Git paths; retry used the explicit executable. |
| EVD-003 | Before 20:45 | Project root | `rg --files -g '!node_modules/**' -g '!.git/**' -g '!docs/audits/**' -g '!.release-backups/**' -g '!.resident-read-fixes/**' -g '!*.env*' -g '!env.txt' -g '!npm-shrinkwrap.json'` followed by an immutable PowerShell group/count | 0 | 118 files; top-level counts recorded in Coverage. | None. |
| EVD-004 | Before 20:45 | Project root | Repeated exact-path `rg -n -C` searches and numbered `Get-Content -LiteralPath ... | Select-Object -Skip ... -First ...` reads over the files cited in this report; every search excluded `docs/audits/**` | 0 or 1 | Routes, SQL, schema constraints, tests, and doc claims traced. Three searches returned 1 because Windows treated literal `src/*.ts` as an invalid path after other exact files had already produced matches. | None. |
| EVD-005 | Before 20:45 | `C:\Windows\Temp` | `& 'C:\Program Files\Git\cmd\git.exe' --no-pager --no-optional-locks -c core.fsmonitor=false -C 'C:\Users\Owner\Documents\1f3d9' log --date=iso-strict --format='%H%x09%ad%x09%s' -- src/input.ts src/mcp.ts test/mcp-auth.test.ts` | 0 | Write guard commit dated 2026-08-12; hosted response hardening dated 2026-08-14. No secret values read. | None. |
| EVD-006 | Before 20:45 | Project root | `npm run typecheck --silent` | 0 | TypeScript check passed with no output. | None observed. |
| EVD-007 | Before 20:45 | Project root | `node --test --experimental-strip-types test/world-root.test.ts test/world-market.test.ts test/engine-scope.test.ts test/engine.test.ts test/routes.test.ts test/mcp-auth.test.ts test/window-viewer.test.ts test/backend-correctness.test.ts` | 0 | 208 passed, 0 failed. | Console output only. |
| EVD-008 | About 20:43 | Project root | PowerShell here-string piped to `node --experimental-strip-types --input-type=module -`; imported `Hono` and `mountWorldMarketRoutes`, returned a valid reserved offer, made `settleX402` advance time past expiry, forced `world-market:pending-x402` to return no row, then called seller cancel | 0 | `settlements=1`, claim `409`, no durable pending hash, cancel `200`, owner stayed seller, lock cleared, offer canceled. | In-memory objects only; no filesystem, DB, network, or real payment. A first harness omitted required market-draft display fields and got cancel `502`; the corrected harness produced the stated proof. |
| EVD-009 | About 20:44 | Project root | PowerShell here-string piped to `node --experimental-strip-types --input-type=module -`; mounted legacy `mcp()` over a synthetic `GET /api/place/:id` payload containing a fake credential-pattern note, then called anonymous `look` | 0 | HTTP 200, MCP success, synthetic credential returned `true`, redaction marker `false`. | In-memory only. The token-shaped value was synthetic and was not printed. |
| EVD-010 | About 20:44 | Project root | PowerShell here-string piped to `node --experimental-strip-types --input-type=module -`; imported `buildPlaceTree` and measured star-shaped maps at 1,000, 2,000, and 4,000 rows | 0 | 7 ms, 24 ms, and 99 ms respectively; doubling approached fourfold CPU. | In-memory only. Timing is environmental, not a service SLO. |
| EVD-011 | 20:45–20:49 | `C:\Windows\Temp` | `curl.exe -sS --max-time 10 -D - -o NUL https://1f3d9.com/`; same for `/api/official`; `curl.exe -sS --max-time 15 -o NUL -w '{"http_code":%{http_code},"bytes":%{size_download},"total_seconds":%{time_total}}' https://1f3d9.com/api/map`; then one header-only-body-discarding map GET | 0 | Root and official 200; map 200, 134,205 bytes, 0.331136 seconds, Vercel MISS and must-revalidate. | Four ordinary production reads; bodies discarded. Possible access-log entries and cache activity only. |
| EVD-012 | About 20:48 | Project root | `npm test --silent` | 0 | 401 passed, 0 failed, 8.73-second test duration. | Console output and test-managed temporary activity only; no project change observed. |
| EVD-013 | Session | N/A | `npm run test:postgres --silent` | NOT RUN | Skipped because it requires an isolated configured PostgreSQL target and could mutate outside state. | None. |
| EVD-014 | Session | Internet browser service | Direct safe opens for `https://1f3d9.com/` and `/api/official`, then `site:1f3d9.com 1F3D9 city AI agents` search | Tool rejected / empty | Browser service rejected the direct URL as unsafe-to-open and search returned no result; read-only curl checks then established reachability. | No site request was established by the browser service. |
| EVD-015 | Session | Shared project | Four separated proposer passes, followed by a fresh reviewer that had proposed none of the candidate findings | N/A | Reviewer upheld UNS-001/002/003, reduced UNS-004 to LOW, and rejected public receipt fields and missing entry ACL as intentional. | Proposers used static reads only. The reviewer unexpectedly wrote a premature report despite a no-write instruction; root did not read it, verified only its exact path, and deleted only that new file before creating this report. |
| EVD-016 | 20:52:54 | `C:\Windows\Temp` | Safe Git porcelain count filtered in memory, plus `Test-Path` for the requested target | 0 | Target absent; zero non-audit changes; two other concurrent untracked audit files counted without reading names/content. | None. |
| EVD-017 | 20:57 | Project root | `python C:\Users\Owner\.codex\skills\unshittify\scripts\validate_report.py docs\audits\openai-codex_world_Audit_Findings.md --json` | 0 | `valid: true`, `finding_count: 4`, no errors or warnings. | Validator was read-only. |
| EVD-018 | Final handoff | `C:\Windows\Temp` | The same validator command, then safe Git porcelain filtering, `Get-Item`, and `Get-FileHash` for this report only | 0 | Validator remained valid with four findings; this report was the only new target file, non-audit changes were zero, and three other concurrent audit files were counted without reading them. | Read-only after this report's final text update. |

Long command output was summarized rather than pasted. No command read a real bearer secret, environment file, production response body, or another audit report.

## Findings

### UNS-001: A buyer can pay before the city has any durable payment record

- **Severity:** BLOCKER
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** An irreversible external USDC settlement must have a durable, idempotent, fail-closed local intent before settlement begins; the product claims settled-but-unfinished world payments remain locked and retryable (`docs/SYSTEM_DESIGN.md:307`, `docs/SYSTEM_DESIGN.md:311`, `docs/DECISIONS.md:39`).
- **Location:** `src/world-market.ts:983`, `src/world-market.ts:992`, `src/world-market.ts:1004`, `src/world-market.ts:1033`, `src/world-market.ts:1292`, `src/society.ts:801`, `src/society.ts:829`, `src/society.ts:838`, `src/world-support.ts:135`, `src/world.ts:281`, `db/schema.sql:793`, `db/schema.sql:1251`
- **User or business harm:** A buyer can lose real USDC while receiving no asset or frontier claim, and the seller can regain an unlocked asset because the city never recorded that settlement. Direct/world sales permit prices up to $10,000 USDC in their validators, so this is not limited to the $1 frontier fee.
- **Evidence:** World-market calls the external facilitator at `983` and only afterward tries to write `pending_x402_*`; that update still requires `reserved_until > clock_timestamp()` at `1004`, and a miss returns `409` at `1033-1038`. The safe harness advanced time during settlement: one settlement completed, the pending write missed, claim returned `409`, then seller cancel returned `200` and cleared the lock while ownership stayed with the seller. Direct sales have the same ordering at `society.ts:801` then `829`, with an active-window guard at `838`, and the schema permits pending x402 evidence only for `channel='world'` at `schema.sql:793-817`. Paid frontier founding settles in `world-support.ts:135-145` before its first local payment/place CTE in `world.ts:281-339`.
- **Safe reproduction:** An in-memory Hono harness used synthetic wallets, transaction hash, offer, checkout, and market draft. `settleX402` succeeded and moved the fake clock 200 ms beyond the reservation; the conditional pending update returned no row; the route answered `409`; the terminal market draft then allowed seller cancellation. Output: `{"settlements":1,"claim_status":409,"claim_error":"offer or reservation changed while the payment settled","durable_pending_hash":null,"cancel_status":200,"thing_owner":7,"thing_locked":false,"offer_status":"canceled"}`. No network, database, or money was used.
- **Connection traced:** Buyer `POST /api/world/offer/:id/claim` → `settleX402` `/verify` then `/settle` → conditional `transfer_offers.pending_x402_*` write → missing row → `409` → seller `POST .../cancel` → market terminal check → asset unlock. Connected traces also covered direct buyer claim → facilitator → active-window claim CTE, and frontier request → `treasuryFee` → local payment/place CTE.
- **Root cause:** Irreversible provider settlement is executed inside the request before a durable local `settling` intent exists. The world bridge added a good pending/reconcile state, but only after settlement and only if an expiring conditional update succeeds; direct sales and treasury fees have no equivalent state. The direct x402 path also stores `block_time = null`, while only world sales receive the schema's block-time backstop.
- **Connections and similar locations checked:** All `treasuryFee` callers (`world.ts:281`, `481`, `574`), PayAI verify/settle (`pay.ts:60-111`), direct claim/cancel (`society.ts:691-960`), world claim/reconcile/cancel (`world-market.ts:918-1370`), pending-state constraints and payment triggers (`schema.sql:760-817`, `1251-1308`), and route tests including `test/routes.test.ts:1952-1966` and `test/world-market.test.ts:582-641`.
- **Durable fix:** First persist an immutable payment intent and mark the offer/fee `settling` in a short transaction before calling `/settle`; bind it to actor, asset/purpose, amount, payee, reservation, and an idempotency fingerprint. Never let expiry/cancel/unlock clear a `settling` or settled intent. Persist returned transaction evidence in a separate update that is allowed after reservation expiry, confirm Base payer/payee/amount/block time, then atomically finalize payment use plus ownership/resource creation. Make retries/reconciliation call the same idempotent intent, generalize the DB backstop to direct sales, and provide a recoverable terminal invalid state only for canonical final mismatch/failure.
- **Why this is not a band-aid:** It moves the recovery boundary before the irreversible effect and gives every payment route one durable state machine; adding another catch, longer timeout, or post-settlement retry would leave the crash/expiry gap intact.
- **Pre-fix proof:** Add PostgreSQL-backed tests that pause settlement across `reserved_until`, inject zero-row and thrown DB results after successful settlement, and simulate process death between provider success and evidence persistence. Current behavior must show paid-without-record; the fixed behavior must leave a durable locked intent that exactly one retry can finish without another payment.
- **Verification:** Run direct, world, and frontier behavior tests; the real isolated PostgreSQL trigger/constraint suite; duplicate/replay and cancellation concurrency tests; Base confirmation inside the original window; facilitator idempotency tests; and the whole `npm test`. Verify one transaction hash cannot satisfy two intents and any `settling`/pending record blocks cancellation regardless of wall-clock expiry.
- **Regression and rollback risk:** High: this changes payment and lock transitions. Use additive schema states, deploy read/recognition code before writers, preserve every new intent on rollback, and never roll back by deleting evidence or unlocking ambiguous paid assets. Roll back application traffic if duplicate settlement, ownership mismatch, or unreconcilable intents appear.
- **Unknowns:** PayAI's exact idempotency/replay guarantees, whether the original authorization can be safely retried without storage, the number of in-flight production reservations, and whether any prior orphan settlement exists were not inspected.

### UNS-002: Historical resident credentials can escape through public note readers

- **Severity:** BLOCKER
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Resident root keys and OAuth credentials must never be published or returned through public output; current input code calls publication an unwitting transfer of authority (`src/input.ts:11-23`).
- **Location:** `src/mcp.ts:646`, `src/mcp.ts:855`, `src/society.ts:163`, `src/world.ts:141`, `src/window.ts:503`, `src/window.ts:740`, `src/moderation-store.ts:97`, `test/mcp-auth.test.ts:403`
- **User or business harm:** If even one pre-guard note contains an unrotated resident root key, any anonymous reader can impersonate that resident and act on its land, things, agreements, and transfers. Exposed access/refresh credentials can also grant or extend hosted access. Actual production presence is unknown, but the read-layer behavior is confirmed and the source explicitly anticipates historical rows.
- **Evidence:** New writes reject credential-shaped text at `society.ts:184`, but `mcp.ts:646-650` says historical notes may predate that guard. Its redactor runs only when `hostedChat` is true at `mcp.ts:855-862`. Public note, place-note, and window queries select stored `note.body` and pass it through moderation; `moderatePublicRows` changes content only when an explicit latest moderation action is `remove`. The repository fixture at `test/mcp-auth.test.ts:403-501` verifies hosted redaction for pre-guard root/access-token-shaped notes. A synthetic legacy-MCP reproduction returned the fake credential-shaped body unchanged.
- **Safe reproduction:** A local Hono app mounted `mcp()` in legacy mode over a synthetic public place response containing `1f3d9_sk_` plus generated fake hex. Anonymous `look` returned status 200 and success; `synthetic_credential_returned` was `true` and `redaction_marker_present` was `false`. No production note or real credential was read, stored, or printed.
- **Connection traced:** Historical `notes.body` → `GET /api/note/:id`, embedded `GET /api/place/:id`, or window collection query → moderation overlay only → anonymous JSON/window output; legacy MCP `look` simply forwards that raw route response because the hosted-only safeguard is skipped.
- **Root cause:** Legacy-secret handling was added as a hosted-MCP response wrapper instead of at the shared public-note shaping boundary. Current write rejection prevents new rows but does not protect older stored rows or every read surface.
- **Connections and similar locations checked:** Direct note read, place embedded notes, window snapshot/history, hosted MCP, legacy MCP, shared input validation, moderation overlays, credential patterns, and Git history for the guard/redactor. No scrub/backfill/runbook was found in the checked first-party scope.
- **Durable fix:** Add one shared immutable public-note sanitizer used by HTTP, place reads, window/history, legacy MCP, and hosted MCP; keep the hosted final-response scan as defense in depth. Preserve original rows as restricted forensic evidence or append a public moderation/redaction projection rather than destructively rewriting history. Run a privileged production scan that returns only affected IDs/types/counts, immediately rotate affected resident root keys and revoke affected OAuth token families, clear cached public snapshots, and inspect access logs without copying secret values.
- **Why this is not a band-aid:** The fix closes the common publication boundary and handles already-stored data and credential revocation; changing only one route or only blocking future writes leaves the other readers and old authority live.
- **Pre-fix proof:** Add synthetic credential-bearing historical rows to behavior fixtures for `GET /api/note/:id`, `GET /api/place/:id`, window snapshot/history, legacy MCP, and hosted MCP. Today at least the legacy MCP fixture returns the pattern; every fixed surface must redact/withhold it while preserving safe note metadata and ordinary explanatory text.
- **Verification:** Re-run new cross-surface tests and `test/mcp-auth.test.ts`; scan all public JSON/text serializers for credential patterns; verify window cache refresh; run the privileged production ID-only scan; prove every affected key/token family is rotated/revoked; and confirm no raw value appears in response, error, analytics, or application logs.
- **Regression and rollback risk:** Medium: broad patterns can redact legitimate prose and response-shape changes can affect clients. Roll out shared shaping behind additive tests, preserve metadata, and fail closed on uncertain matches. Do not roll back to raw output; if rendering breaks, temporarily withhold affected bodies.
- **Unknowns:** Whether production contains a matching historical note, whether any exposed key has already been rotated, whether moderation has covered every affected row, and whether downstream caches/logs retain prior output are unknown because production content and controls were not inspected.

### UNS-003: The public map recomputes and returns the entire city per request

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** A public production read must not make the shared database and application rebuild work proportional to the entire persistent world for every anonymous request; completeness can be preserved through a versioned cached projection.
- **Location:** `src/world.ts:66`, `src/world.ts:68`, `src/world.ts:85`, `src/world.ts:91`, `src/world-support.ts:182`, `src/window.ts:685`, `src/window.ts:779`
- **User or business harm:** Crawlers or polling agents can repeatedly force a recursive full-place read, three count lookups per place, a full sort, an in-memory tree rebuild, and a growing response on the same database/service used for movement and ownership. At higher city size or traffic this can raise latency/cost or contribute to outage; callers have no smaller map option.
- **Evidence:** `/api/map` has no cursor, subtree bound, or in-repo route cache. Its recursive CTE visits every reachable place, runs child-place/thing/note counts for each, orders the full path, then `buildPlaceTree` recursively filters the complete row array for every parent. The live endpoint was already 134,205 bytes and returned `must-revalidate`, `X-Vercel-Cache: MISS`. A pure synthetic star map took 7 ms at 1,000 rows, 24 ms at 2,000, and 99 ms at 4,000, consistent with the current quadratic assembly shape.
- **Safe reproduction:** Two ordinary live map GETs discarded the body: one measured status/bytes/time, one captured headers. A separate local pure-function check passed synthetic public rows to `buildPlaceTree`; it used no DB or network. This was not a load test and makes no claim that 0.331136 seconds is presently unacceptable.
- **Connection traced:** Anonymous `GET /api/map` → recursive `places` CTE → three correlated counts per place → full ordered row set → moderation query → `buildPlaceTree` → full JSON response. The human window performs similar full topology work but at least has a 30-second process-local snapshot cache at `window.ts:779-789`.
- **Root cause:** The canonical map payload doubles as the on-demand read model. Counts are recomputed and tree structure is rebuilt from a flat array with repeated full-array filtering; no versioned/materialized snapshot or shared cache separates city writes from anonymous reads.
- **Connections and similar locations checked:** `/api/place/:id` uses bounded independent collections; the window's map is complete but process-cached and depth-bounded; schema indexes for parent/place foreign keys were considered. No `/api/map` cache header, memoization, rate limit, or bounded alternative was found in source, and the live response was a Vercel miss.
- **Durable fix:** Preserve the complete public map contract but maintain a versioned topology/count projection on relevant writes, assemble it in O(n) with an ID-to-children map, and serve a serialized snapshot through shared/edge caching with explicit invalidation or short staleness. Add a bounded subtree/summary option for agents that do not need everything, and apply anonymous read-rate protection as defense in depth.
- **Why this is not a band-aid:** The database and application stop repeating whole-world work per caller while the full map remains available; a timeout increase or single extra index would not remove unbounded response and O(n²) assembly growth.
- **Pre-fix proof:** Build a production-shaped fixture at 1k/2k/4k/8k places with things/notes, capture `EXPLAIN (ANALYZE, BUFFERS)`, response bytes, and application CPU. Assert the current request work grows with every place and the current builder approaches fourfold CPU when rows double.
- **Verification:** Fixed builder CPU should remain approximately linear (doubling rows no worse than 2.5x in a stable benchmark); count work should be grouped/materialized rather than three per-row subqueries; repeat anonymous reads should hit the documented cache; invalidation should publish new places/ownership/counts within the chosen staleness contract; movement/property tests and response-shape consumers must still pass.
- **Regression and rollback risk:** Medium: clients and the window expect one complete tree, while stale ownership/counts are misleading. Keep the old response schema, version cache keys, canary against live-shaped fixtures, and fall back to a bounded database rebuild only if the projection is unavailable.
- **Unknowns:** Actual place/thing/note cardinalities, Neon query plans/cache hit ratios, production request rate, Vercel/WAF controls, acceptable freshness, and whether another deployment layer caches despite the observed miss are unknown.

### UNS-004: One agreement can make a bounded page grow without a member bound

- **Severity:** LOW
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Public pagination must bound nested collection expansion as well as top-level row count; the window already documents that later signers are unbounded and uses a 32-member preview (`src/window.ts:58-61`).
- **Location:** `src/society.ts:460`, `src/society.ts:476`, `src/society.ts:480`, `src/society.ts:482`, `src/society.ts:484`, `src/society.ts:500`, `src/window.ts:538`
- **User or business harm:** As open agreements accrue residents, a request for even one agreement can require and return every party, acceded resident, and signature. Public polling can increase query/serialization cost and clients cannot request membership separately; current scale makes near-term harm limited.
- **Evidence:** `/api/agreements` limits agreement rows at `society.ts:500`, but each selected row contains complete `parties`, `acceded`, and `signatures` arrays built at `480-485`. Accession allows later residents without a fixed lifetime member cap. The human window explicitly recognizes this and caps each preview to 32 with a count at `window.ts:538-563`, while the API does not.
- **Safe reproduction:** Static trace only. A production-shaped large-membership fixture was not created because current practical impact was not established and no isolated PostgreSQL target was configured.
- **Connection traced:** Anonymous `GET /api/agreements` → `public_agreements` read model → three member/signature subqueries per returned agreement → filter/order/top-level limit → full arrays serialized to the caller.
- **Root cause:** The top-level page bound is treated as a complete response bound even though open accession makes nested membership a separate growing collection. The window and API use different read-model safety rules.
- **Connections and similar locations checked:** Agreement creation caps named parties at 32; signing uses a daily per-resident action quota; open accession can still grow for the life of the agreement. Window previews/counts, `/api/me` agreement lists, schema membership uniqueness, and public filtering were reviewed.
- **Durable fix:** Reuse the window's bounded preview-plus-count shape for list responses and add a stable cursor-paged agreement-membership/signature endpoint for the complete public record. Preserve explicit named/acceded/signed distinctions and filtering semantics.
- **Why this is not a band-aid:** Membership becomes its own bounded public collection rather than hiding a few fields or lowering only the agreement-row limit.
- **Pre-fix proof:** In an isolated PostgreSQL fixture, create one open agreement with increasing membership and measure default/max list response bytes and query time. Assert the current response grows with all signers despite `limit=1`; fixed list size stays bounded and pagination returns every member exactly once.
- **Verification:** Test preview counts, named-before-acceded ordering, completion/open state, party filters, no cursor duplicates, full membership reachability, window parity, and backward-compatible response versioning; run whole agreement and PostgreSQL integration suites.
- **Regression and rollback risk:** Medium relative to LOW harm because clients may rely on complete arrays. Add new count/page metadata first, version or deprecate the old full arrays, and retain a reversible compatibility period with strict server-side maximums.
- **Unknowns:** Largest live agreement, client dependence on complete arrays, expected maximum resident population, query plans, and product willingness to add a nested pagination contract are unknown.

## Questions Needing Human Review

| Question | Why it matters | Available evidence | Missing evidence | Safest next check | Release wait? |
| --- | --- | --- | --- | --- | --- |
| Do any production notes contain a pre-2026-08-12 resident/OAuth credential pattern? | A single active root key can enable account takeover. | Source acknowledges historical notes; hosted-only redaction was added later; public bypass reproduced synthetically. | Production rows, rotations, moderation coverage, logs/caches. | Privileged ID/type/count-only scan; never print bodies or tokens; rotate/revoke matches. | Yes. This is the unresolved live-impact part of UNS-002. |
| What idempotency and replay contract does PayAI `/settle` provide, and what stable operation identifier can be stored before settlement? | The durable intent/reconcile design must not trigger a second transfer. | Client sends the same payment payload to `/verify` and `/settle`; no local pre-settlement intent or provider operation ID is stored. | Current facilitator contract and observed retry behavior. | Obtain current provider contract and test synthetic/testnet retries against one stored intent. | Yes for re-enabling affected x402 writes, not for immediate containment. |
| Are map requests protected by a Vercel/WAF rule or shared cache not represented in the repository? | This changes current exploitability and capacity, though not the unbounded design. | Live map was `must-revalidate`, age 0, and `X-Vercel-Cache: MISS`. | Dashboard rules, request volume, Neon slow-query data. | Read-only operator review of Vercel analytics/config and Neon query statistics. | No; MEDIUM finding can follow blocker containment. |
| Is public wallet/transaction linkability an explicitly accepted privacy policy? | Public records join resident/market identity to Base transfers. | Product decisions and front door intentionally call the world offer/receipt public; no bearer material is included. | A formal privacy statement and user expectation. | Product/legal review of existing public fields; do not silently change the protocol. | No defect was admitted; wait only if policy says those fields were not meant to be public. |

## Ordered Repair Plan

1. Contain UNS-001 and UNS-002 without destroying evidence: stop affected x402 writes or fail them before `/settle`; do not cancel/unlock ambiguous offers; withhold credential-bearing public note bodies and preserve originals under restricted access.
2. Add failing behavior-level checks: expiry/process-failure payment races across world/direct/frontier paths, plus synthetic historical credential reads across HTTP, window, legacy MCP, and hosted MCP.
3. Repair shared root causes: one pre-settlement durable intent/reconcile state machine for all x402 uses, and one public-note sanitizer for every reader.
4. Handle existing state safely: migrate in-flight offers/fees additively, reconcile possible orphan settlements, scan note IDs without outputting secrets, rotate/revoke affected credentials, and invalidate public caches.
5. Run targeted, connected, and whole-product checks: isolated PostgreSQL concurrency/trigger tests, facilitator idempotency tests, category tests, type-check, all 401+ local tests, and response-security scans.
6. Release reversibly: additive schema first, recognition before writers, canary x402 traffic and public readers, monitor payment-without-record, stuck intent, credential-withheld, map latency/cache, and agreement-size signals; never roll back by deleting evidence.
7. Run a new full `$unshittify` audit after deployment, cite `UNS-AUDIT-20260815-205254`, and use a fresh skeptic that did not propose the repaired findings.

## Verification and Release Gates

| Gate | Required proof before release |
| --- | --- |
| Payment safety | A real PostgreSQL test advances DB time through expiry and injects failure/process interruption after synthetic settlement; every route retains one durable locked intent, cancellation fails, and one idempotent retry finalizes without a second settlement. Direct x402 also stores and DB-enforces verified payer/payee/amount/block time. |
| Credential safety | Synthetic root/access/refresh/auth-code patterns are redacted or withheld on note detail, place notes, window snapshot/history, legacy MCP, and hosted MCP. An authorized production scan returns zero publicly exposed matches after rotation/revocation, and raw values are absent from logs/analytics. |
| Map reliability | Production-shaped 1k–8k fixtures show linear assembly, grouped/materialized count work, cache hits on repeat reads, bounded database work per cache refresh, correct invalidation, and unchanged complete-tree schema. |
| Agreement bounds | List entries have a documented member preview/count bound; a cursor endpoint returns all named/acceded/signed members once; filters and completion state remain correct. |
| Regression | `npm run typecheck --silent`, `npm test --silent`, and `npm run test:postgres --silent` pass against an explicitly isolated loopback/preview database. Relevant MCP/window and ownership journeys pass in a mainstream desktop and mobile-width browser view. |

Test data required: synthetic token-shaped notes, reservations expiring during settlement, duplicate/replayed authorizations, injected zero-row/exception/process-death points, canonical pending/failed/mismatched Base receipts, 1k–8k place trees, and large open-agreement membership. Forbidden live actions: real test payments, real credential publication, production mutation/load testing, destructive note rewriting, unlocking ambiguous paid offers, or migration without a verified snapshot and rollback plan.

Rollback immediately if a canary shows duplicate settlement, payment without durable intent, ownership/payment mismatch, a credential pattern in any public response/log, loss of complete map data, or membership cursor duplication. Required release evidence is the failing-before/passing-after test record, isolated PostgreSQL final rows, sanitized production scan summary, provider idempotency proof, canary metrics, migration snapshot ID, and operator sign-off.

## Overseer Record

**Independent skeptic:** COMPLETED
**Reviewer separation:** CONFIRMED

The fresh skeptic proposed none of the candidates it reviewed. It re-opened raw source/tests/schema, did not rely on another audit report, and returned these decisions:

| Item | Decision | Result |
| --- | --- | --- |
| UNS-001 | UPHELD | BLOCKER/E3; the narrow race and later pending design do not close the pre-record settlement gap. |
| UNS-002 | UPHELD | BLOCKER/E2 on static evidence; the root auditor's separate synthetic legacy-MCP reproduction raises the admitted behavior to E3, not E4. |
| UNS-003 | UPHELD | MEDIUM/E2 on static evidence; the root auditor's separate live-size and pure scaling checks raise it to E3, not E4. |
| UNS-004 | CHANGED | Reduced from proposed MEDIUM to LOW/E2 because current impact is growth pressure, not a present release-level failure. |
| Public receipt fields / missing entry ACL | REJECTED | Public wallet/transaction receipts and adjacency-only entry match the checked product contract; they were not admitted as defects. |

Inspector roles were separated into world architecture, contract/UX, correctness, security, and the fresh skeptic. Agent agreement was not used to raise evidence levels. All agents were from the same model family and share possible blind spots; the root auditor independently re-opened admitted BLOCKER/HIGH evidence and attempted disproof before admission.

## Honest Limitations

- This audit proves code paths and synthetic behavior, not the contents or exact deployed schema of Neon production. No live note body, bearer credential, authenticated route, payment, cancellation, or marketplace write was touched.
- Base, PayAI, 1F3EA, Vercel controls/analytics, Neon plans/metrics, and platform-specific permissions were not fully covered. Browser search could not index/open the domain; curl established only public status, headers, size, and time with bodies discarded.
- The configured PostgreSQL integration suite, E2E browser suite, coverage report, dependency audit, and live load test were not run. Full local tests passing does not test the reproduced expiry gap or prove production correctness.
- Other audits were concurrent. Their reports were excluded and not read; two untracked audit files existed at the pre-write check and three at the final check. A skeptic unexpectedly created a premature file at this report path; root did not read it, deleted only that new file, then authored this report from raw evidence. No source/config/test change or unexpected non-audit change was present.
- Generated artifacts: this Markdown report only. No coverage file, screenshot, build output, database row, cache file, or secret file was created. Local tests produced console output; four public GETs may have produced normal server access logs/cache activity. Findings cite evidence re-opened after parallel review; external behavior and same-model blind spots still require human/different-model review.

The conclusion is limited to the checked scope: no evidence was found that movement adjacency, `go_home`, local permission enforcement, agreement signing authority, gifts, or atomic local ownership CTEs are defective outside the admitted connected findings. This does not mean those areas are bug-free.
