# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-183500
- **Project:** 1F3D9 — `C:\Users\Owner\Documents\1f3d9`
- **Created:** 2026-08-15T18:35:00-05:00

## Plain-English Verdict

DO NOT RELEASE

- Real USDC can settle before the city has a durable record or recovery path for the matching land, kind, revision, or direct-sale action.
- Both MCP doors can turn an invalid transfer action into a real gift, and one supposedly read-only tool can execute destructive delayed effects.
- The site is already live. Here, “do not release” means do not promote this API contract unchanged and contain the paid/MCP paths while they are repaired.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | BLOCKER | E3 | x402 can move USDC before durable city state exists, without a general reconciliation path or independent Base recheck. |
| UNS-002 | HIGH | E3 | An invalid MCP `transfer.action` silently falls through to a permanent gift on both doors. |
| UNS-003 | HIGH | E3 | MCP `me` is labeled read-only and idempotent although it can mutate quotas and execute destroy, move, or transfer effects. |
| UNS-004 | HIGH | E4 | Both MCP doors falsely negotiate unsupported versions and violate the 2025-11-25 transport/lifecycle rules they otherwise implement. |
| UNS-005 | MEDIUM | E3 | Public and MCP discovery contradict the handler and omit part of the live route/status surface. |
| UNS-006 | MEDIUM | E3 | Authenticated residents can create unlimited flags for IDs that need not exist. |
| UNS-007 | LOW | E3 | Any `Authorization` header expands the legacy MCP catalog, even when the token is invalid. |
| UNS-008 | MEDIUM | E3 | Method and empty-body behavior is inconsistent and under-documented, including invalid 405 responses. |

### Next 3 Actions

1. Gate new x402 settlement on the affected city/direct-sale routes and preserve all payment evidence until durable recovery exists.
2. Reject invalid MCP inputs, correct `me` annotations or split observation from reading, and repair protocol negotiation on both doors.
3. Generate one authoritative route/status/schema contract and test all 66 registrations against it.

## Audit Contract

- **Scope:** Every explicit public route registration, every reachable HTTP status, implicit `OPTIONS`/`HEAD`/not-found behavior, authentication, request/response shape, payment state, published discovery, and both MCP doors.
- **Purpose and release profile:** A production persistent city for AI residents, with property and real Base USDC. Anonymous live census returned 130 residents during this audit.
- **Comparison point:** Current source at branch `codex/workspace-reconciliation`, commit `7035d9db7f766792f56c7782f0c0636b94533e48`; current live `https://1f3d9.com`; current official MCP material plus the implementation’s apparent 2025-11-25 baseline.
- **User parameters:** Treat documentation as claims; do not change code; do not read other audit reports; follow connections into data, auth, payment, OAuth, and the 1F3EA bridge.
- **Dynamic checks allowed:** Anonymous read-only live HTTP probes and local fake/in-memory tests only. No resident secret, production write, OAuth login, payment, wallet action, moderation action, or database mutation was allowed.
- **Exclusions:** Other audits and their reports, a full UI/accessibility review, private production logs/database contents, facilitator internals, full Base node correctness, and the internal 1F3EA implementation.
- **No-remediation policy:** No application, schema, configuration, or test code was changed. The approved generated output is this Markdown report.

## Project and Connection Map

### Runtime map

```text
Internet client
  -> Vercel rewrite: every path -> api/index.ts
  -> Hono app: src/index.ts
     -> identity/actions/world/society/world-market route modules
     -> Neon Postgres
     -> Base JSON-RPC and USDC contract
     -> PayAI x402 facilitator
     -> 1F3EA public market records

Legacy MCP /mcp
  -> hand-written JSON-RPC adapter
  -> internal app.request(...) into the same HTTP routes

Hosted MCP /mcp/connect
  -> OAuth discovery/authorize/token/revoke
  -> connector-only OAuth request marker
  -> same MCP adapter and same HTTP routes
```

Roles are anonymous reader, permanent resident-key holder, hosted OAuth resident, founder resident `#1`, 1F3EA buyer/seller, and outside payment/market services. Neon is authoritative for residents, property, events, offers, receipts, quotas, and OAuth state; Base is authoritative for USDC movement.

### Complete implemented route and status inventory

There are **66 explicit method/path registrations**: 59 unconditional and 7 mounted only when hosted OAuth startup succeeds. The table groups routes only to keep it readable; every registration appears once.

`500*` means the global uncaught-exception fallback at `src/index.ts:144-146` can answer any matched route. Rows that deliberately return `500` are also marked by the same code. `404†` means the hosted/OAuth feature is unavailable and the route falls through or explicitly hides itself.

This is the complete application-level status surface found in the repository. Vercel, its edge, or another outside dependency can still generate platform statuses before/after Hono; those were not available as a stable first-party contract and are called out under limitations.

| Implemented route(s) | HTTP statuses from the code |
| --- | --- |
| `GET /`; `GET /llms.txt`; `GET /robots.txt`; `GET /humans.txt`; `GET /window`; `GET /window.css`; `GET /window.js`; `GET /api/map`; `GET /api/official`; `GET /api/physics`; `GET /treasury` | `200`, `500*` |
| `GET /api/window`; `GET /api/residents`; `GET /api/events`; `GET /api/moderation`; `GET /api/kinds`; `GET /api/traits`; `GET /api/agreements` | `200`, `400`, `500*` |
| `GET /api/place/:id`; `GET /api/thing/:id`; `GET /api/note/:id`; `GET /api/world/offer/:offerId` | `200`, `400`, `404`, `500*` |
| `GET /api/world/resident/:handle` | `200`, `404`, `500*` |
| `POST /api/register` | `201`, `400`, `409`, `429`, `500*`, `503` |
| `POST /api/rotate` | `200`, `401`, `429`, `500*` |
| `GET /api/me` | `200`, `400`, `401`, `500*` |
| `POST /api/flag` | `201`, `400`, `429`, `500*` |
| `POST /api/moderation` | `201`, `400`, `401`, `403`, `404`, `500*` |
| `POST /api/action`; `POST /api/go-home`; `POST /api/thing/:id/use`; `POST /api/thing/:id/consume` | `200`, `400`, `401`, `403`, `404`, `409`, `429`, `500*` |
| `POST /api/me/home` | `200`, `400`, `401`, `403`, `500*` |
| `PATCH /api/place/:id`; `PUT /api/place/:id/laws`; `PATCH /api/thing/:id`; `POST /api/thing/:id/upgrade`; `POST /api/thing/:id/withdraw` | `200`, `400`, `401`, `403`, `404`, `409`, `500*` |
| `POST /api/place` | `201`, `400`, `401`, `402`, `403`, `404`, `409`, `500*` |
| `POST /api/kind` | `201`, `400`, `401`, `402`, `409`, `500*` |
| `POST /api/kind/:id/revise` | `200`, `400`, `401`, `402`, `403`, `404`, `409`, `500*` |
| `POST /api/trait` | `201`, `400`, `401`, `409`, `500*` |
| `POST /api/thing` | `201`, `400`, `401`, `403`, `404`, `409`, `429`, `500*` |
| `POST /api/note` | `201`, `400`, `401`, `403`, `404`, `409`, `429`, `500*` |
| `POST /api/agreement` | `201`, `400`, `401`, `404`, `429`, `500*` |
| `POST /api/agreement/:id/open-accession` | `200`, `201`, `400`, `401`, `403`, `404`, `429`, `500*` |
| `POST /api/agreement/:id/sign` | `200`, `400`, `401`, `403`, `404`, `409`, `429`, `500*` |
| `POST /api/transfer` | `200`, `400`, `401`, `403`, `404`, `409`, `429`, `500*` |
| `POST /api/transfer/offer` | `201`, `400`, `401`, `403`, `404`, `409`, `429`, `500*` |
| `POST /api/transfer/:offerId/claim` | `200`, `400`, `401`, `402`, `403`, `404`, `409`, `500*` |
| `POST /api/transfer/:offerId/cancel` | `200`, `400`, `401`, `403`, `404`, `409`, `500*` |
| `POST /api/world/listing` | `201`, `400`, `401`, `403`, `404`, `409`, `500*`, `502`, `503` |
| `POST /api/world/offer/:offerId/claim` | `200`, `202`, `400`, `401`, `402`, `403`, `404`, `409`, `500*`, `502`, `503` |
| `POST /api/world/offer/:offerId/reconcile` | `200`, `202`, `400`, `401`, `403`, `404`, `409`, `500*` |
| `POST /api/world/offer/:offerId/cancel` | `200`, `400`, `401`, `403`, `404`, `409`, `500*`, `502`, `503` |
| `POST /mcp` | `200`, `202`, `500*` |
| `POST /mcp/connect` | feature on: `200`, `202`, `401`, `500*`; feature off: `404†` |
| `GET /mcp` | `405`, `500*` |
| `GET /mcp/connect` | feature on: `405`, `500*`; feature off: `404†` |
| `GET /.well-known/oauth-protected-resource`; `GET /.well-known/oauth-protected-resource/mcp/connect`; `GET /.well-known/oauth-authorization-server` | feature on: `200`, `500*`; feature off: `404†` |
| `GET /oauth/authorize` | feature on: `200`, `400`, `429`, `500*`; feature off: `404†` |
| `POST /oauth/authorize` | feature on: `200`, `303`, `400`, `403`, `409`, `429`, `500*`; feature off: `404†` |
| `POST /oauth/token` | feature on: `200`, `400`, `500*`; feature off: `404†` |
| `POST /oauth/revoke` | feature on: `200`, `500*`; feature off: `404†` |

Implicit behavior is also public contract:

| Request shape | Implemented result |
| --- | --- |
| `OPTIONS` to any tested path, including an unknown path | `204` from global CORS middleware |
| `HEAD` for a GET route | GET status with no body; live examples: `/api/official` `200`, `/mcp` `405` |
| Wrong method without another matching registration | generic `404`, not `405`; live `POST /api/official` returned `404` |
| Unknown path | `404 {"error":"no such street. GET / for the front door."}` |
| Uncaught matched-route error | `500 {"error":"internal"}` |

The implementation uses 16 HTTP status numbers:

| Status | Meaning here |
| --- | --- |
| `200` | Read/update success; most MCP JSON-RPC errors and tool failures also remain HTTP 200 |
| `201` | Created |
| `202` | MCP initialized notification accepted, or world payment still pending |
| `204` | CORS preflight |
| `303` | OAuth browser approval/denial redirect |
| `400` | Validation, token-protocol error, or malformed direct API request |
| `401` | Missing/bad resident auth or hosted MCP OAuth challenge |
| `402` | x402 challenge or rejected payment proof |
| `403` | Authenticated but not permitted |
| `404` | Missing resource, disabled feature, unknown path, and most wrong methods |
| `405` | GET/HEAD on the two MCP paths only |
| `409` | Ownership, reservation, replay, or concurrent-state conflict |
| `429` | Quota or rate limit |
| `500` | Deliberate unavailable-result response or global internal fallback |
| `502` | Invalid 1F3EA public record |
| `503` | Dependency/unavailable durable record or registrar state |

### Both MCP doors

| Contract point | `/mcp` | `/mcp/connect` |
| --- | --- | --- |
| Purpose | Permanent resident-key door | Hosted-chat OAuth door |
| Live availability | `POST 200/202`; `GET 405` | Enabled during audit; `POST 200/202/401`; `GET 405` |
| Anonymous catalog | `register`, `look` | 17 tools, each with security schemes; excludes `register` and `moderate` |
| Authenticated catalog | 19 tools when any auth header is present | Same 17 hosted tools after OAuth; also accepts hosted namespace aliases |
| Execution auth | Downstream route verifies the permanent bearer key | OAuth token is accepted only on marked internal connector requests |
| RPC methods | `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call` | Same |
| RPC error transport | Usually HTTP `200`; JSON-RPC error or `result.isError=true` | Same, except OAuth challenge can be HTTP `401` |

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Route registrations and status branches | CHECKED | All 38 `src` files searched; all 66 registrations traced into helpers | Dynamic reachability of every error branch was not forced |
| Auth, input, storage, and engine connections | CHECKED | `index`, `core`, action/world/society/market, OAuth, MCP, engine, schema | No production secret or database |
| Both MCP doors | CHECKED | Source, targeted tests, anonymous live protocol probes, official MCP references | No authenticated live connector session |
| Real-USDC paths | CHECKED | All x402/direct-proof callers traced; safe fake tests exercised ordering | No live payment, refund, facilitator log, or wallet action |
| OAuth route cluster | CHECKED | Source and local enabled/disabled tests; live metadata/door presence | No browser approval or token issuance against production |
| Public documentation | CHECKED | Runtime front door, `llms.txt`, generated door source, published front door, relevant design/features | Archived docs and other audits excluded |
| Outside Base, PayAI, Vercel, Neon, and 1F3EA systems | PARTLY CHECKED | Call sites and public responses only | Their internals, SLAs, logs, and permissions were unavailable |
| Full integration, E2E, coverage, load, and fault injection | NOT CHECKED | Targeted unit/route suites only | Docker/Postgres suites, Playwright, load tests, and coverage were not run |

First-party scope measure: 38 source files, 39 test files, 14 non-audit docs, and 7 database files were inventoried. Relevant route/auth/payment/schema files were read directly; unrelated implementation details were sampled. Generated `src/door.ts` was checked against its source claims, but vendored dependencies and ignored files were not audited.

## Evidence Ledger

| ID | Time and folder | Command/check | Exit/result | Side effects |
| --- | --- | --- | --- | --- |
| EVD-001 | 2026-08-15, project root | PowerShell capture of `rg -n "app\.(get\|post\|put\|patch\|delete)\(" src` and `Measure-Object` | Exit `0`; 66 registrations and 66 distinct method/path pairs | None |
| EVD-002 | 2026-08-15, project root | Repeated scoped `rg -n` and line-numbered `Get-Content -LiteralPath` over `src`, `db`, `test`, `api/index.ts`, `vercel.json`, and relevant non-audit docs | Exit `0` except one Windows wildcard misuse recorded below | None |
| EVD-003 | 2026-08-15, project root | Git branch, HEAD, and status using absolute Git executable with optional locks/file monitor disabled | Exit `0`; branch and commit recorded above; concurrent untracked audit reports observed | Read-only |
| EVD-004 | 2026-08-15, project root | `node --test --experimental-strip-types test/routes.test.ts test/mcp-auth.test.ts test/oauth-routes.test.ts test/oauth-disabled-routes.test.ts test/world-market.test.ts` | Exit `0`; 112 passed, 0 failed | In-memory fakes only |
| EVD-005 | 2026-08-15, project root | `node --test --experimental-strip-types --test-name-pattern="frontier x402 settles before creation\|x402 payer must match" test/routes.test.ts` | Exit `0`; 2 passed; proved settle-before-write and settle-before-late-402 order | In-memory fakes only |
| EVD-006 | 2026-08-15, project root | `node --test --experimental-strip-types --test-name-pattern="/api/me refreshes presence" test/routes.test.ts`; repeated with `--test-name-pattern="anonymous flags are rate-limited"` | Exit `0`; 1 passed in each run | In-memory fakes only |
| EVD-007 | 2026-08-15, project root | `npm run typecheck` | Exit `0`; `tsc --noEmit` | No emitted files |
| EVD-008 | 2026-08-15, `https://1f3d9.com` | Anonymous GET/HEAD/OPTIONS/wrong-method probes for official, residents, MCP, hosted MCP, OAuth metadata, and world routes | Live: official/residents `200`; MCP GETs `405`; OPTIONS `204`; wrong method `404`; hosted feature enabled | Read-only network requests |
| EVD-009 | 2026-08-15, both live MCP doors | Anonymous JSON-RPC initialize, tools/list, notification, malformed JSON, unsupported protocol header, and invalid media/origin probes | Arbitrary version echoed; unsupported version accepted `200`; notification answered `200`; malformed JSON `-32600`; invalid headers/origin accepted | No tool call and no state change |
| EVD-010 | 2026-08-15, live `/mcp` | `Invoke-RestMethod` tools/list with no header and with `Authorization: Bearer definitely-not-a-resident` | `anonymous=2`, `arbitrary_auth=19`, `includes_transfer=True` | Read-only discovery |
| EVD-011 | 2026-08-15, local Hono fake | In-memory JSON-RPC `tools/call` with `transfer`, `action:"bogus"`, valid gift fields, on each MCP door | Both dispatched `POST /api/transfer` and returned `isError=false` | Fake app only; no DB/network |
| EVD-012 | 2026-08-15, official web sources | Read current MCP release/migration and 2025-11-25 lifecycle/transport/schema pages | Confirmed current transition and older transport requirements | Read-only web access |
| EVD-013 | 2026-08-15, project root | Fresh reviewer independently reopened candidate source/evidence and returned A-H verdicts | All eight real; E and G impact wording refined; no new blocker/high; `DO NOT RELEASE` | No files by the counted reviewer |
| EVD-014 | 2026-08-15, project root | Structural validator after report creation | Recorded in Verification section | Report read only |

Skipped or failed checks:

- One broad audit-exclusion glob did not exclude Windows-prefixed paths and printed a few snippets from other audit reports. They were discarded; every admitted claim was re-established from source, tests, live probes, or official specifications.
- One combined curl-capture command was rejected before execution by tool policy; individual safe probes already supplied the evidence.
- One `rg` command used Unix-style wildcard paths on Windows and exited `1`; it was rerun with `--glob`/directory scope and succeeded.
- No full test, coverage, Postgres integration, Playwright E2E, live write, authenticated live call, payment, or destructive request was run.

Official protocol references used:

- [MCP 2025-11-25 Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP 2025-11-25 schema and lifecycle types](https://modelcontextprotocol.io/specification/2025-11-25/schema)
- [MCP 2026-07-28 release note](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [Official TypeScript SDK migration guidance](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

## Findings

### UNS-001: A payment can settle before the city can record or recover what it bought

- **Severity:** BLOCKER
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** A real-money side effect must have a durable, idempotent intent and recovery path before the external settlement is initiated; payment authority must be independently verified before property/state finalization.
- **Location:** `src/pay.ts:60-113`; `src/world-support.ts:126-180`; `src/world.ts:281-339,481-526,574-627`; `src/society.ts:691-913`; comparison `src/world-market.ts:978-1068,1213-1289`; `test/routes.test.ts:1927-1966`
- **User or business harm:** A resident can lose real USDC yet receive no land, kind, revision, or purchased asset if reservation/state changes or the database fails after settlement. A false or incomplete facilitator result can also finalize city state without the city independently confirming amount, payee, payer, finality, and payment time on Base.
- **Evidence:** `settleX402()` calls facilitator `/verify` then `/settle` at `src/pay.ts:82-109`. Fee routes accept that result at `src/world-support.ts:135-145` and only then attempt their SQL write. Direct sale claim settles at `src/society.ts:795-810`, then rechecks a still-active reservation and ownership in SQL at `829-894`; a late conflict returns `409` after money moved. Existing tests explicitly assert facilitator settle precedes the place INSERT, and another settles before a payer mismatch returns `402` with no sale record. The direct city flows have no pending-payment/reconcile endpoint. The world-market path has a partial pending/reconcile design and re-reads Base, demonstrating the missing state machine, although it still has a narrow settle-before-persist gap.
- **Safe reproduction:** `node --test --experimental-strip-types --test-name-pattern="frontier x402 settles before creation|x402 payer must match" test/routes.test.ts` passed two fake-only tests. No real payment occurred.
- **Connection traced:** Paid API request -> `treasuryFee()` or direct offer claim -> PayAI verify/settle -> irreversible Base transfer -> later Neon insert/update/conflict. World-market was traced separately through pending x402 fields, public Base classification, and reconcile.
- **Root cause:** Payment is handled as transient request metadata rather than a durable saga/outbox with a pre-settlement intent, idempotency key, independently verified receipt, and terminal reconciliation states.
- **Connections and similar locations checked:** All `settleX402` callers, direct `tx_hash` proof paths, `payment_uses`, `fees`, `sale_payments`, direct offers, world offers, payment response headers, Base classifiers, and 1F3EA reconciliation were checked.
- **Durable fix:** First persist an immutable payment intent containing actor, asset/action, amount, payer/payee, reservation window, and idempotency key. Then settle. Persist the settlement result idempotently even when finalization cannot proceed; independently classify the Base transfer; finalize city state and receipt in one DB transaction; expose pending/failed/reconcile/refund operations; add monitoring for paid intents without terminal city state.
- **Why this is not a band-aid:** It acknowledges that Base and Neon cannot share one transaction and replaces the unsafe gap with an explicit recoverable state machine across every paid route.
- **Pre-fix proof:** Add fault-injection tests requiring a durable intent before `/settle`, then force post-settlement DB failure, reservation expiry, payer mismatch, and process interruption. Each must leave one recoverable payment record and must never double-settle or silently return only `402/409/500`.
- **Verification:** Run the new payment-state tests, `test/routes.test.ts`, `test/world-market.test.ts`, Postgres integration tests, and a preview-only test-wallet exercise that reconciles after a forced failure.
- **Regression and rollback risk:** Changing payment order can strand legitimate in-flight payments or double-process retries. Migrate existing offers/intents first, make settlement idempotent, deploy readers before writers, and retain a feature flag that stops new settlements without deleting evidence.
- **Unknowns:** Production facilitator guarantees, historical stranded transfers, current refund practice, and live unmatched on-chain transfers were unavailable. The independent reviewer upheld the defect but retained E3 because it did not repeat a payment simulation.

### UNS-002: Invalid MCP transfer actions silently become permanent gifts

- **Severity:** HIGH
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Destructive tool input must be validated against its advertised schema and rejected fail-closed; an unknown enum value must never select a default destructive operation.
- **Location:** `src/mcp.ts:426-476,634-639,813-829,845-870`
- **User or business harm:** A typo, buggy client, or maliciously altered tool call with valid asset/recipient fields can transfer ownership permanently even though `action` is outside the advertised enum.
- **Evidence:** The schema advertises `give|offer|claim|cancel`. Runtime validation checks only whether argument names exist in `properties`; it does not validate types, required fields, or enum values. The dispatcher handles three exact strings and sends every other value to `POST /api/transfer`. A fake Hono harness sent `action:"bogus"` with a thing and recipient to both `/mcp` and `/mcp/connect`; each dispatched the gift route and returned JSON-RPC `isError=false`.
- **Safe reproduction:** Use an in-memory app whose `/api/transfer` records requests, then call each MCP door with the redacted JSON-RPC shape `{name:"transfer", arguments:{action:"bogus", type:"thing", id:41, to_handle:"neighbor"}}`. No property or production system is touched.
- **Connection traced:** MCP `tools/call` -> name-only argument check -> `tool.route(args)` -> default branch -> internal authenticated `POST /api/transfer` -> engine give -> ownership update.
- **Root cause:** The MCP adapter publishes JSON Schema but does not execute it, and a non-exhaustive branch treats “unknown” as the destructive default.
- **Connections and similar locations checked:** All tool definitions share the shallow validator; transfer was the proven destructive fallthrough. Both catalogs, namespace handling, auth forwarding, secret rejection, and downstream error wrapping were checked.
- **Durable fix:** Compile and run full JSON Schema validation for every tool call. For transfer, require an explicit valid action and use an exhaustive switch whose default returns invalid params without dispatch. Keep defaults only after validation and only for non-destructive behavior.
- **Why this is not a band-aid:** It closes the shared schema/runtime gap and makes every future tool definition enforce what it advertises.
- **Pre-fix proof:** Add table-driven tests for missing, wrong-type, out-of-range, extra, and out-of-enum values on all tools; specifically assert `bogus` never reaches any internal route.
- **Verification:** Run MCP auth/dispatch tests, route tests for gift/offer/claim/cancel, hosted namespace tests, and a property-based corpus of malformed arguments.
- **Regression and rollback risk:** Clients relying on omitted `action` defaulting to `give` will break. Announce the requirement and version the schema before removing compatibility if such clients exist.
- **Unknowns:** No production MCP call history was available to measure malformed or omitted action use.

### UNS-003: MCP calls a state-changing observation “read-only” and “idempotent”

- **Severity:** HIGH
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** MCP tool annotations must describe actual side effects, especially when clients use them for approval and safety decisions.
- **Location:** `src/mcp.ts:553-575`; `src/index.ts:357-377`; `src/core.ts:67-95`; `src/engine-effects.ts:225-306,319-606,821-857`
- **User or business harm:** A client or human can auto-approve `me` as a harmless read, but the call can roll quota state and execute delayed effects that destroy, move, or transfer things/property.
- **Evidence:** `me` advertises `readOnlyHint:true`, `destructiveHint:false`, and `idempotentHint:true`. It dispatches `GET /api/me`. Authentication updates quota-day fields, and the handler calls `resolveDueEffects()` before returning holdings. The effect executor includes destroy, move, and transfer. The targeted route test confirms `/api/me` resolves a due timer; the live catalog confirms the false annotation.
- **Safe reproduction:** The fake route test `node --test --experimental-strip-types --test-name-pattern="/api/me refreshes presence" test/routes.test.ts` passed and records timer resolution. Static tracing proves the destructive effect variants; no destructive variant was run live.
- **Connection traced:** MCP `me` -> internal GET `/api/me` -> auth update -> current place -> due-effect transaction -> effect primitive -> changed ownership/location/existence -> response.
- **Root cause:** The product intentionally treats authenticated observation as a simulation tick, but the HTTP verb and MCP metadata model it as a pure snapshot.
- **Connections and similar locations checked:** Authenticated `GET /api/place/:id` also resolves due effects but MCP `look` is already marked non-read-only. Other MCP annotations and auth mutations were sampled.
- **Durable fix:** Split pure snapshot reads from an explicit `observe/resolve` mutation. Make `me` use read-only auth lookup and no effect resolution; advertise the observation tool as non-read-only, non-idempotent, open-world, and potentially destructive. If the split is rejected, immediately correct `me` annotations and GET semantics.
- **Why this is not a band-aid:** It aligns the permission boundary, verb, client prompt, and actual transaction instead of merely changing descriptive text.
- **Pre-fix proof:** Add a test that a read-only `me` call performs no INSERT/UPDATE/effect resolution and a separate test that the explicit observer tool performs and reports the mutation.
- **Verification:** Re-run engine timer/effect tests, route tests, MCP catalog snapshots, hosted approval behavior, and client manual review prompts.
- **Regression and rollback risk:** Timers may stop advancing for clients that only call `me`. Release the explicit observation path first, migrate callers, then make snapshot pure.
- **Unknowns:** The audit did not inspect which MCP hosts currently auto-approve based on annotations.

### UNS-004: Both MCP doors falsely negotiate protocol support

- **Severity:** HIGH
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** MCP 2025-11-25 lifecycle and Streamable HTTP requirements, JSON-RPC 2.0 parse/notification semantics, and origin/version validation.
- **Location:** `src/mcp.ts:14,600-602,764-807`; `src/index.ts:125-138,640-656`
- **User or business harm:** A client can be told an unsupported protocol was negotiated, then fail later or mis-handle messages. Notifications receive illegal responses, unsupported version headers are accepted, and unrestricted Origin handling defeats a required transport defense.
- **Evidence:** `initialize` echoes any string from `params.protocolVersion`. Neither door reads `MCP-Protocol-Version`, `Accept`, `Content-Type`, or `Origin`; CORS permits `*`. Only `notifications/initialized` gets `202`, while another notification gets an HTTP `200` JSON-RPC error response. Malformed JSON becomes `-32600` rather than parse error `-32700`. Anonymous live probes reproduced all of these on production, including arbitrary future-version echo and acceptance of an unsupported protocol header on both doors. The fresh skeptic independently checked the source against the official 2025-11-25 transport.
- **Safe reproduction:** Send only initialize, tools/list, a notification without `id`, and malformed JSON; do not call a tool. Repeat on both paths with an unsupported `MCP-Protocol-Version` and a foreign Origin. These are handshake/discovery probes only.
- **Connection traced:** Vercel POST -> Hono CORS -> MCP JSON parse -> hand-written method switch -> response. No session or negotiated-version state is stored.
- **Root cause:** A partial hand-written JSON-RPC dispatcher is standing in for a versioned MCP transport/lifecycle implementation.
- **Connections and similar locations checked:** Both doors, GET fallback, hosted OAuth challenge, current 2026 migration behavior, 2025-11-25 lifecycle/transport/schema, existing MCP/OAuth tests, and CORS middleware.
- **Durable fix:** Adopt the official MCP SDK transport or implement an equivalent conformance layer: explicit supported-version set; honest fallback; required protocol-header validation; Origin allowlist; media negotiation; correct parse/invalid-request codes; no response body for any accepted notification; and conformance tests. Add 2026 `server/discover` only under the official compatibility/migration plan rather than claiming latest support prematurely.
- **Why this is not a band-aid:** It replaces scattered method special cases with one protocol boundary that owns negotiation, headers, lifecycle, and JSON-RPC semantics.
- **Pre-fix proof:** Add a shared conformance table run against both doors: arbitrary initialize version must not be echoed, unsupported protocol header must be `400`, foreign Origin must be rejected, notifications must have no JSON-RPC response, malformed JSON must be `-32700`, and invalid Accept/media types must fail as specified.
- **Verification:** Run official SDK client compatibility for supported versions, the shared conformance suite, existing MCP/OAuth tests, and live preview handshake probes through Vercel.
- **Regression and rollback risk:** Strict negotiation can break clients that currently rely on permissive behavior. Measure current headers/versions, publish supported versions, and stage warning/compatibility telemetry before enforcement.
- **Unknowns:** The current 2026-07-28 protocol is only weeks old and has a compatibility transition. Failure to implement it immediately was not treated as the defect; false claims and violations of the older implemented contract were.

### UNS-005: Discovery is internally contradictory and cannot reconstruct the live API

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Public discovery and machine schemas must describe the callable routes, valid inputs, auth, statuses, and door-specific behavior.
- **Location:** `src/door.ts:139-201,274-291,330-360,430-439`; `src/frontdoor.txt`; `src/llms.txt:115-119`; `docs/published/FRONTDOOR.md`; `src/mcp.ts:274-299`; `src/actions.ts:104-108`; route mounts in `src/index.ts`, `src/oauth.ts`, `src/actions.ts`
- **User or business harm:** Agents following compact discovery or MCP schema send “valid” `talk`/`make` actions and get `400`. They cannot reliably discover helper actions, the hosted door/OAuth cluster, feature-off `404`, OAuth `303`, payment `402/202`, market `502/503`, or method/body rules.
- **Evidence:** The detailed action section correctly says talk/make use dedicated endpoints, but the compact public section says `/api/action` performs all seven and MCP `act` includes both in its enum. A local fake proves both return `400`. Source contains 66 registrations; the public route lists omit live helpers such as `/api/go-home`, `/api/thing/:id/use`, `/api/thing/:id/consume`, `/api/flag`, window assets/API, `/mcp/connect`, and OAuth endpoints. No OpenAPI or equivalent route/status contract exists.
- **Safe reproduction:** Mount the real action routes with fake storage and POST `{"action":"talk"}` or `{"action":"make"}`; both return `400`. Compare the 66-source inventory above with public discovery.
- **Connection traced:** Manual front-door/LLMS claims and MCP schema -> agent request generation -> `/api/action` validator -> `400`; omitted route/status claims -> client retry/auth/payment logic.
- **Root cause:** “Frozen action vocabulary” was conflated with “inputs accepted by this endpoint,” while public docs and MCP schemas are maintained separately from route validators/status definitions.
- **Connections and similar locations checked:** Runtime `/`, `/llms.txt`, source text, generated `door.ts`, published front door, physics response, MCP tools, both door catalogs, helper aliases, OAuth, world market, and route tests.
- **Durable fix:** Define request/response/status/auth metadata beside shared validators, generate OpenAPI plus human discovery and MCP input schemas from it, and add a build test that every route registration appears exactly once with its feature flag and statuses. Keep basic vocabulary separate from endpoint-specific accepted actions.
- **Why this is not a band-aid:** One executable contract removes the drift source instead of fixing today’s prose copies one by one.
- **Pre-fix proof:** Add a contract test that enumerates all 66 registrations and compares generated docs/schemas; add tests that every advertised enum value reaches a non-validation result or is documented as a dedicated endpoint.
- **Verification:** Regenerate artifacts, run route/MCP/help-text tests, validate OpenAPI, and exercise generated examples against a preview deployment.
- **Regression and rollback risk:** Publishing previously omitted endpoints can make them de facto supported. Mark internal-only routes explicitly or commit to compatibility before generation.
- **Unknowns:** Product intent for treating helper aliases and the hosted feature as stable public API was not documented; they are publicly reachable today.

### UNS-006: Authenticated residents have an unlimited dangling flag write path

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Public writes need abuse limits, valid referential targets, and bounded amplification into the public event stream.
- **Location:** `src/index.ts:94-119,548-580`; `db/schema.sql:1335-1344`; `test/routes.test.ts:2379-2406`
- **User or business harm:** Any free resident can create unlimited flag rows and public flag events, including against nonexistent IDs, causing moderation noise, feed spam, database growth, and operational cost.
- **Evidence:** Only callers without a resident are sent through `takeAnonymousFlagSlot()`. Authenticated callers skip it entirely. The route accepts any allowed type plus positive integer ID and inserts immediately. The polymorphic schema has no target foreign key. An existing test explicitly asserts authenticated flagging never touches the anonymous limit table.
- **Safe reproduction:** The targeted fake test `node --test --experimental-strip-types --test-name-pattern="anonymous flags are rate-limited" test/routes.test.ts` passes and proves the bypass without writing production.
- **Connection traced:** Resident bearer -> `/api/flag` -> no limiter -> `flags` INSERT -> `events(kind='flag')` INSERT -> public `/api/events`.
- **Root cause:** Abuse control was designed only for anonymous callers, and polymorphic target integrity was left entirely to the request without an existence check.
- **Connections and similar locations checked:** Anonymous bucket cleanup/admission, notes and agreement quotas, moderation lookup, flags schema/indexes, events, and public moderation history.
- **Durable fix:** Add a per-resident transactional rate/quota bucket, target-type-specific existence validation in the same transaction, duplicate suppression/cooldown, and a separate explicit privileged bypass if maintainers need one.
- **Why this is not a band-aid:** It closes both unbounded write amplification and invalid references at the authoritative boundary.
- **Pre-fix proof:** Tests should show repeated authenticated flags reach a limit and a nonexistent target is rejected without either a flag or event row.
- **Verification:** Run route, concurrency, quota rollover, moderation, and event pagination tests; inspect metrics for rejected/accepted flags after staged release.
- **Regression and rollback risk:** Legitimate high-volume reporting can be throttled. Publish limits and provide a reviewed maintainer path rather than silently exempting all residents.
- **Unknowns:** Production flag volume, moderation staffing, and whether an unlimited founder-only path is desired were not available.

### UNS-007: A junk auth header changes the legacy MCP capability contract

- **Severity:** LOW
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Capability discovery should be either intentionally public or gated by successful authentication, not by header presence.
- **Location:** `src/mcp.ts:730-755,793-805`
- **User or business harm:** A client with an expired or malformed key is told it has 19 tools, including protected/destructive ones, then fails during execution. This creates misleading capability state and retry loops. Confidentiality harm is small because tool names are already public.
- **Evidence:** Legacy `tools/list` uses `c.req.header('authorization') || allowsAnonymous(tool.name)`. Live anonymous discovery returned 2 tools; the same request with a junk bearer returned 19 and included transfer. Downstream execution still authenticates, so this is not an auth bypass.
- **Safe reproduction:** The EVD-010 live tools/list comparison uses no valid credential and invokes no tool.
- **Connection traced:** `/mcp` tools/list -> header-presence filter -> expanded metadata -> client plan -> protected call -> downstream auth failure.
- **Root cause:** Discovery uses a cheap syntactic proxy for identity while execution uses real identity.
- **Connections and similar locations checked:** Hosted discovery intentionally publishes protected tools with OAuth security schemes; legacy public docs already name tools; execution and secret-argument guards were checked.
- **Durable fix:** Choose one coherent model: authenticate before showing protected legacy tools, or advertise them to everyone with explicit security schemes. Never let junk header presence change truth.
- **Why this is not a band-aid:** It aligns catalog semantics with the chosen auth model rather than recognizing more bearer string shapes.
- **Pre-fix proof:** Add tools/list tests for absent, malformed, expired, root-key, and hosted tokens with one declared expected catalog policy.
- **Verification:** Run MCP auth/catalog tests and verify client behavior for key rotation/expiry.
- **Regression and rollback risk:** Some clients may rely on optimistic discovery before their key is verified.
- **Unknowns:** No client telemetry showed whether this behavior is relied upon.

### UNS-008: Method and empty-body behavior is inconsistent with the public contract

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** HTTP 405 responses must include `Allow`; documented bodyless operations must accept no body or document the required representation; method behavior should be consistent.
- **Location:** `src/index.ts:653-658`; `src/world-market.ts:1213-1219,1292-1298`; route claims in `src/door.ts:274-281`
- **User or business harm:** Generic clients cannot learn the allowed MCP method from a standards-compliant header, and direct callers following the bare POST instructions for reconcile/cancel receive `400` unless they know to send JSON `{}`.
- **Evidence:** Live GET/HEAD `/mcp` returned `405` without `Allow`; other known-path wrong methods returned the generic `404`. Both world handlers call JSON parsing and reject a missing body even though the only accepted object has zero fields. MCP wrappers hide this by always sending `{}`, while public discovery lists only a bare POST route.
- **Safe reproduction:** Anonymous live GET/HEAD and wrong-method requests are read-only. A local authenticated fake can POST each world handler with no body and observe `400`, then repeat with `{}` and reach the state checks.
- **Connection traced:** HTTP client -> Hono exact method router or handler JSON parser -> `404/405/400`; MCP internal wrapper -> automatic `{}` -> route works, creating door-specific behavior.
- **Root cause:** Method, body, and documentation rules are hand-coded per handler without a shared HTTP contract layer.
- **Connections and similar locations checked:** Both MCP GETs, global not-found, CORS preflight, HEAD behavior, direct/world cancel/reconcile handlers, MCP route builders, and public route text.
- **Durable fix:** Add correct `Allow: POST` to MCP 405 responses; define a consistent wrong-method policy; treat absent content as `{}` for truly bodyless operations or publish `Content-Type` plus `{}` explicitly; generate these rules from the contract.
- **Why this is not a band-aid:** It aligns direct HTTP, MCP-mediated HTTP, and documentation around one request model.
- **Pre-fix proof:** Add matrix tests for GET/HEAD/PUT/OPTIONS and `Allow` on both MCP paths, plus no-body, `{}`, wrong media, and unknown-field cases for world reconcile/cancel.
- **Verification:** Run HTTP contract tests locally and through preview Vercel, checking status, `Allow`, content type, CORS, and body.
- **Regression and rollback risk:** Clients may currently interpret `404` as feature absence or always send `{}`. Preserve compatibility during a documented transition.
- **Unknowns:** The intended policy for concealing known routes with `404` was not recorded.

## Questions Needing Human Review

### Q1: Are there already paid transfers without matching city state?

- **Why it matters:** This decides whether containment alone is enough or a recovery/refund incident is active.
- **Available evidence:** The code and tests prove a loss window, but no production history was read.
- **Missing evidence:** Facilitator settlement logs, finalized Base USDC transfers, `payment_uses`, `fees`, `sale_payments`, offers, and application errors correlated by transaction hash.
- **Safest next check:** Run a read-only reconciliation query/tool that compares every expected payee transfer with one terminal city receipt, without printing resident secrets.
- **Release should wait:** Yes; do not keep adding unmatched payments while the historical set is unknown.

### Q2: Which MCP versions and Origins are officially supported in production?

- **Why it matters:** Strict fixes can break current clients, while permissive behavior falsely claims compatibility and weakens Origin protection.
- **Available evidence:** Code defaults to 2025-11-25 behavior but accepts arbitrary versions; current official protocol is in a 2026 transition.
- **Missing evidence:** Client/version/header telemetry and an approved Origin list for both doors.
- **Safest next check:** Read-only edge logs aggregated by protocol header/client identity, with credential values excluded.
- **Release should wait:** The MCP repair should wait for the compatibility list, but false version echo and unrestricted Origin should not ship unchanged.

### Q3: Should raw registration/rotation secret responses explicitly use `Cache-Control: no-store`?

- **Why it matters:** These responses contain permanent bearer credentials shown once.
- **Available evidence:** OAuth key pages apply private/no-store headers; raw `POST /api/register` and `/api/rotate` do not set them.
- **Missing evidence:** Vercel/CDN and client cache behavior for these POST responses.
- **Safest next check:** Inspect response headers and Vercel cache policy in preview; do not use a real resident key.
- **Release should wait:** No, not on this E1 question alone; add defense-in-depth if no downside is found.

### Q4: Are forwarded client-address headers edge-sanitized?

- **Why it matters:** Registration, anonymous flags, and OAuth rate limits depend on forwarded addresses.
- **Available evidence:** The code selects Vercel/forwarded header positions and unit-tests one spoof pattern.
- **Missing evidence:** Live Vercel header overwrite/trust configuration.
- **Safest next check:** Preview-only requests with controlled forwarding headers and edge logs.
- **Release should wait:** Only if the edge permits clients to choose the trusted value.

### Q5: Is hosted OAuth availability a stable contract or an optional deployment capability?

- **Why it matters:** Seven routes disappear as `404` and `/mcp/connect` changes behavior when startup configuration is absent or invalid.
- **Available evidence:** Conditional mounting and enabled live metadata were confirmed.
- **Missing evidence:** Production SLO, alerting, and intended compatibility promise.
- **Safest next check:** Review deployment configuration/health telemetry and document feature-off behavior.
- **Release should wait:** Not by itself, but the generated contract must say whether these routes are conditional.

## Ordered Repair Plan

1. **Contain and reconcile money risk (`UNS-001`):** stop new affected x402 settlement or put it behind a kill switch, retain evidence, and audit historical Base/facilitator receipts against city records.
2. **Write failing safety tests (`UNS-001`–`UNS-004`):** payment fault injection, invalid destructive tool enums, pure-read assertions, and a shared two-door MCP conformance table.
3. **Repair shared roots (`UNS-001`–`UNS-004`):** durable payment saga plus independent Base proof; full MCP schema validation; explicit read/observe split; versioned transport/lifecycle boundary.
4. **Make the contract executable (`UNS-005`–`UNS-008`):** generate route/status/auth/body docs and MCP schemas, add resident flag controls/integrity, and normalize HTTP method/body behavior.
5. **Release reversibly:** migrate/read historical state first, deploy readers before writers, canary preview and a small production slice, monitor unmatched payments/MCP errors/flag rates, keep rollback switches, then run a fresh full audit with a new skeptic.

## Verification and Release Gates

| Gate | Required proof before release |
| --- | --- |
| Money | Zero new settlements without a pre-existing durable intent; every simulated interruption reconciles exactly once; read-only historical comparison has no unexplained transfer, or each one has an owned recovery/refund case |
| Destructive MCP | Full schema validation on both doors; malformed/out-of-enum transfer never dispatches; `me` performs no write or is honestly separated/labeled |
| Protocol | Both doors pass the same supported-version, Origin, header, notification, parse-error, GET/405, and OAuth challenge conformance suite |
| Public contract | Generated inventory contains all 66 registrations, conditional routes, auth/body/schema, all 16 statuses, error envelopes, and examples verified against preview |
| Abuse/regression | Per-resident flag limit and target integrity tests pass; targeted 112-test set, full unit suite, 80%+ coverage, Postgres integration, Playwright OAuth/MCP flow, typecheck, and security review pass |

Safe commands include `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run test:postgres` with an isolated disposable database, and `npm run test:e2e` against preview. Payment fault tests must use fake/test dependencies and test wallets only.

Forbidden verification actions are production payments, production property transfers, live resident registration/rotation, live flags/moderation, printing tokens, or destructive database edits. Roll back/disable new settlement if unmatched-payment count rises above zero, duplicate finalization appears, MCP auth widens, or error rates materially exceed the pre-release baseline.

Required release evidence is timestamped CI output, preview protocol transcripts with no secrets, payment-intent/reconcile invariants, read-only production reconciliation summary, migration/rollback plan, and a new independent audit.

## Overseer Record

**Independent skeptic:** COMPLETED
**Reviewer separation:** CONFIRMED

The counted skeptic was a fresh reviewer that proposed none of the candidate findings, was instructed not to read `docs/audits`, independently reopened source/evidence, made no file changes, and returned this record:

| Candidate | Result | Reviewer judgment |
| --- | --- | --- |
| A — payment settlement/recovery | UPHELD | BLOCKER; E3; both settle-before-durable-state and missing independent recheck are real |
| B — `me` annotation | UPHELD | HIGH; E3 |
| C — MCP transport/lifecycle | UPHELD | HIGH; E4 after independent source/spec check |
| D — discovery drift | UPHELD | MEDIUM; E3 |
| E — flags | CHANGED | MEDIUM; E3; wording broadened to unthrottled authenticated writes plus dangling targets |
| F — invalid transfer fallthrough | UPHELD | HIGH; E3 |
| G — junk-header catalog | CHANGED | LOW; E3; impact reduced because names are already public |
| H — method/empty body | UPHELD | MEDIUM; E3 |

The skeptic found no new BLOCKER/HIGH and agreed with `DO NOT RELEASE`. Inspector roles were primary API tracer, route/status mapper, security/payment reviewer, documentation/discovery reviewer, MCP reviewer, destructive-dispatch verifier, and fresh skeptic. These were separate agent contexts but from the same model family, not independent vendors or human reviewers.

An earlier would-be skeptic incorrectly wrote a draft instead of returning an oversight record and was not counted. Only the later fresh, read-only reviewer supports the two exact declarations above.

## Honest Limitations

- No production authentication, database, logs, OAuth session, payment, wallet, mutation, load test, or outside-system internals were available. Static review cannot prove historical exploitation or current operational frequency; platform-specific permissions were not fully covered.
- The targeted 112 tests and typecheck passed, but the full unit suite, coverage, disposable-Postgres integrations, Playwright E2E, dependency audit, load/fault testing, and real-client MCP compatibility matrix were not run.
- Other audit reports were intentionally not opened. One failed Windows exclusion printed a few snippets before the mistake was noticed; they were discarded, and all admitted evidence was re-opened from source/tests/live/official references. No finding relies on those snippets.
- Collaborating agents unexpectedly created `Codex_api_Audit_Findings.md` and transient drafts at the requested path. The separate file was not read or removed. This final file replaced only this audit’s transient draft. Other concurrent audit files remained untracked and could make repository status noisy.
- Generated output is this report only. Tests were fake/in-memory, `tsc` emitted nothing, and no coverage, screenshot, build, cache, or database artifact was intentionally created. Live evidence is a 2026-08-15 snapshot; no evidence found in the checked scope should be read as proof that no other problem exists.
