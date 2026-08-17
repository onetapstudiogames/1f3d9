# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-181043
- **Project:** 1F3D9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T18:10:43.0261687-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- The HTTP API surface is broadly implemented and locally well-tested, but the MCP contract misstates behavior in ways that can mislead hosts into mutating or retrying the wrong calls.
- The hosted and legacy MCP doors also hide most downstream HTTP status meanings, so callers lose the contract the HTTP API actually exposes.
- One world-market route pair requires an empty JSON object even though the human-facing contract describes them like bodyless POSTs.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | MEDIUM | E3 | The `me` MCP tool is advertised as read-only and idempotent even though its underlying `GET /api/me` resolves due effects and can change city state. |
| UNS-002 | MEDIUM | E2 | Both MCP doors collapse most downstream HTTP failure statuses into `200` JSON-RPC tool results, erasing the public status-code contract for callers. |
| UNS-003 | LOW | E2 | `POST /api/world/offer/:id/reconcile` and `POST /api/world/offer/:id/cancel` require `{}` JSON bodies even though the published route contract reads like bodyless POSTs. |

### Next 3 Actions

1. Fix the MCP metadata and docs for mutation-on-read so hosts stop treating `me` as a safe cached read.
2. Decide how MCP should carry downstream HTTP status, then make both doors expose that contract explicitly and test it.
3. Either remove the mandatory `{}` body requirement from world-market `reconcile` and `cancel`, or document it everywhere and add coverage that proves it.

## Audit Contract

- Scope: the public API contract, including every implemented public route, every reachable status code found in code and tests, and both MCP doors.
- Product purpose: `1f3d9.com` is a production public world where AI agents register, read, build, trade, sign agreements, and pay in real USDC.
- Release profile: public paid product handling untrusted callers.
- User parameters: treat `docs/` as claims, not truth; do not change code; save findings in `docs/audits/{MODEL}_api_Audit_Findings.md`; do not read any other audit report.
- Exclusions: no remediation, no installs, no migrations, no deployment, no production credentials, no live writes, no payment actions, no cloud writes.
- Allowed dynamic checks: local static inspection and project-native local tests proven to use fake Neon/Base/OAuth fixtures only.
- Outside-system limits: no production HTTP probing was performed; no authenticated or state-changing outside access was used.
- Write policy: audit-only; only this new report file was created intentionally.
- Expected generated output from approved checks: none observed from the Node test runs.

## Project and Connection Map

Applications and entrypoints:

- Vercel rewrites every request to [api/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/api/index.ts:1), which forwards to the single Hono app in [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:1).
- Public route families are mounted from [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:1), [src/actions.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/actions.ts:1), [src/world.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/world.ts:1), [src/society.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/society.ts:1), [src/world-market.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/world-market.ts:1), [src/window.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window.ts:1), and [src/oauth.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/oauth.ts:1).
- Both MCP doors are implemented by [src/mcp.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/mcp.ts:1) and dispatched from [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:640).

Critical journeys traced:

- Resident HTTP read/write: caller -> Hono route -> `auth`/`authRootKey` in [src/core.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/core.ts:49) -> DB/business rule -> JSON response.
- MCP legacy door: caller -> `POST /mcp` -> `mcp()` -> tool route mapping -> `app.request()` back into the HTTP API -> raw HTTP response text wrapped as JSON-RPC tool result.
- MCP hosted door: caller -> `POST /mcp/connect` -> `mcp(..., { hostedChat: true })` -> in-process marked request via `allowOAuthForHostedConnectorRequest()` -> HTTP API auth path accepts OAuth only on that marked request.
- OAuth hosted sign-in: public metadata/well-known -> `/oauth/authorize` -> `/oauth/token` -> hosted `/mcp/connect`.
- World market bridge: city resident -> `/api/world/listing|claim|reconcile|cancel` -> public 1F3EA record checks + payment verification -> city ownership/payment state.

Route inventory checked:

- Text/discovery: `GET /`, `/llms.txt`, `/robots.txt`, `/humans.txt`, `/window`, `/window.css`, `/window.js`, `/api/window`.
- OAuth/public metadata: `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-protected-resource/mcp/connect`, `GET /.well-known/oauth-authorization-server`, `GET|POST /oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke`.
- Core API: `POST /api/register`, `POST /api/rotate`, `GET /api/residents`, `GET /api/me`, `GET /api/official`, `GET /api/physics`, `GET /api/events`, `POST /api/flag`, `POST|GET /api/moderation`, `GET /treasury`.
- World/actions: `POST /api/action`, `/api/go-home`, `/api/thing/:id/use`, `/api/thing/:id/consume`, `/api/me/home`, `GET /api/map`, `GET|PATCH /api/place/:id`, `PUT /api/place/:id/laws`, `GET|PATCH /api/thing/:id`, `POST /api/place`, `/api/kind`, `/api/kind/:id/revise`, `/api/trait`, `/api/thing`, `/api/thing/:id/upgrade`, `/api/thing/:id/withdraw`, `GET /api/kinds`, `GET /api/traits`.
- Society/trading: `GET /api/note/:id`, `POST /api/note`, `POST /api/agreement`, `POST /api/agreement/:id/open-accession`, `POST /api/agreement/:id/sign`, `GET /api/agreements`, `POST /api/transfer`, `/api/transfer/offer`, `/api/transfer/:offerId/claim`, `/api/transfer/:offerId/cancel`.
- World-market bridge: `GET /api/world/resident/:handle`, `GET /api/world/offer/:offerId`, `POST /api/world/listing`, `/api/world/offer/:offerId/claim`, `/api/world/offer/:offerId/reconcile`, `/api/world/offer/:offerId/cancel`.
- MCP transport: `POST|GET /mcp`, `POST|GET /mcp/connect`, plus `404` not-found fallback.

Status-code contract summary from source and tests:

- Common route-local statuses seen repeatedly: `200`, `201`, `202`, `400`, `401`, `402`, `403`, `404`, `409`, `429`, `500`, `502`, `503`, plus `405` for `GET /mcp` and `GET /mcp/connect`.
- Uncaught exceptions are normalized by [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:144) to `500 {"error":"internal"}`.
- Hosted unauthorized MCP is the one special case that forwards `401` plus `WWW-Authenticate`; other MCP tool failures are wrapped back into JSON-RPC `200` responses.

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| HTTP route inventory in first-party source | CHECKED | All route definitions in `src/index.ts`, `src/actions.ts`, `src/world.ts`, `src/society.ts`, `src/world-market.ts`, `src/oauth.ts`, `src/window.ts` | Static inspection only; no live production probe |
| HTTP status-code branches | CHECKED | Fresh source reads plus local harness tests in `test/routes.test.ts`, `test/world-market.test.ts`, `test/oauth-routes.test.ts`, `test/oauth-disabled-routes.test.ts`, `test/mcp-auth.test.ts` | Some generic `500/502/503` fallback paths were inferred from source because tests do not hit every upstream failure |
| MCP legacy door `/mcp` | CHECKED | `src/index.ts`, `src/mcp.ts`, `test/round2-surfaces.test.ts`, `test/mcp-auth.test.ts` | No live client probe |
| MCP hosted door `/mcp/connect` and OAuth metadata | CHECKED | `src/index.ts`, `src/mcp.ts`, `src/oauth.ts`, `test/oauth-routes.test.ts`, `test/mcp-auth.test.ts`, `test/oauth-disabled-routes.test.ts` | No live client probe |
| Public docs as claims | PARTLY CHECKED | `src/door.ts`, `docs/SYSTEM_DESIGN.md`, `docs/ARCHITECTURE.md`, `docs/features/HOSTED_CHAT_SIGNIN.md` compared against code | I did not treat docs as authority and did not read `docs/audits` |
| Local dynamic verification | CHECKED | 123 route/auth/contract tests passed under local fakes; no generated output observed | Did not run Playwright or production-facing scripts |
| Production behavior | NOT CHECKED | Deliberately skipped | Audit contract stayed off production and off real credentials |
| Other audit reports | NOT CHECKED | Deliberately skipped | User explicitly prohibited reading them |

Honest scope measure:

- First-party paths sampled or read: 89 files under `src`, `api`, `test`, `e2e`, and `db`.
- `docs/audits/` was intentionally excluded.
- `node_modules/` and Vercel build output were treated as vendored/generated and not audited.

## Evidence Ledger

| ID | Time | Folder | Command or source | Exit | Result | Side effects |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | 2026-08-15 17:53 CDT | `C:\Users\Owner\Documents\1f3d9` | Read `C:\Users\Owner\.codex\skills\unshittify\SKILL.md` plus `references/audit-checklist.md`, `report-contract.md`, `agent-prompts.md` | 0 | Loaded audit contract and reporting rules | None |
| EVD-002 | 2026-08-15 17:55 CDT | `C:\Users\Owner\Documents\1f3d9` | `rg` route and MCP searches across `src api test e2e` | 0 | Built route inventory and identified route modules | None |
| EVD-003 | 2026-08-15 17:56-18:09 CDT | `C:\Users\Owner\Documents\1f3d9` | Read `api/index.ts`, `src/index.ts`, `src/mcp.ts`, `src/core.ts`, `src/actions.ts`, `src/world.ts`, `src/society.ts`, `src/world-market.ts`, `src/window.ts`, route-focused docs | 0 | Traced caller-to-effect paths and status branches | None |
| EVD-004 | 2026-08-15 18:05 CDT | `C:\Users\Owner\Documents\1f3d9` | `node --test --experimental-strip-types test/routes.test.ts test/oauth-routes.test.ts test/oauth-disabled-routes.test.ts test/round2-surfaces.test.ts` | 0 | 89/89 passed; tests explicitly use fake Neon/Base/OAuth fixtures only | No generated files observed |
| EVD-005 | 2026-08-15 18:07 CDT | `C:\Users\Owner\Documents\1f3d9` | `node --test --experimental-strip-types test/world-market.test.ts test/mcp-auth.test.ts test/backend-correctness.test.ts` | 0 | 34/34 passed; verified world-market and MCP auth contract coverage | No generated files observed |
| EVD-006 | 2026-08-15 18:08 CDT | `C:\Users\Owner\Documents` | Safe git read: `git --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --branch --ignore-submodules=all` | 0 | Worktree clean except other agents’ untracked `docs/audits/*.md` reports | None |
| EVD-007 | 2026-08-15 17:59 CDT | `C:\Users\Owner\Documents\1f3d9` | `Get-Content -Raw test\oauth-signin.spec.ts` | 1 | Wrong path; file lives under `e2e\`, not `test\` | None |

## Findings

### UNS-001: The MCP `me` tool advertises a safe read, but calling it can mutate city state

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Public API contract accuracy; MCP metadata must not describe mutating behavior as read-only/idempotent.
- **Location:** [src/mcp.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/mcp.ts:574), [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:357), [test/routes.test.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/test/routes.test.ts:3173), [src/door.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/door.ts:229)
- **User or business harm:** MCP hosts can legally cache, prefetch, auto-retry, or parallelize `me` as a harmless read even though it can resolve timers and change labels/history. That creates hard-to-explain gameplay changes and duplicate side effects for signed-in callers.
- **Evidence:** `me` is advertised with `readOnlyHint: true` and `idempotentHint: true` in `src/mcp.ts:574`. The actual `GET /api/me` path loads presence and then calls `resolveDueEffects` before returning in `src/index.ts:374-376`. The local route suite explicitly proves this refresh path in `test/routes.test.ts:3173`.
- **Safe reproduction:** Local only: the passing test `node --test --experimental-strip-types test/routes.test.ts` includes `/api/me refreshes presence...`, which proves mutation-on-read without touching production.
- **Connection traced:** MCP `tools/list` -> advertised `me` metadata -> MCP host chooses execution policy -> `tools/call` -> route mapping in `src/mcp.ts` -> `GET /api/me` -> `resolveDueEffects()` -> changed resident/place state -> JSON response.
- **Root cause:** The MCP tool metadata was authored from the human-facing intent of "read your holdings" instead of from the actual server-side effect path.
- **Connections and similar locations checked:** `look` was checked and is explicitly marked non-read-only in `src/mcp.ts:204` because its description admits timer resolution for authenticated observers; `me` is the inconsistent surface. `/api/place/:id` and `/api/me` are the authenticated read routes that resolve due effects; only `me` is misadvertised this way.
- **Durable fix:** Make the MCP contract match execution reality. Either mark `me` non-read-only/non-idempotent everywhere it is advertised, or split the state-refresh side effect away from `GET /api/me` so the safe read contract becomes true.
- **Why this is not a band-aid:** It corrects the shared contract mismatch instead of teaching each client to memorize a hidden exception.
- **Pre-fix proof:** A behavior-level proof already exists in `test/routes.test.ts:3173`; add an MCP-facing assertion that `tools/list` does not mark `me` read-only while `/api/me` still calls `resolveDueEffects`.
- **Verification:** Re-run `test/routes.test.ts`, `test/mcp-auth.test.ts`, and add a direct `tools/list` assertion for `me` annotations.
- **Regression and rollback risk:** Changing metadata may alter host scheduling/caching behavior. If the implementation is changed instead, watch for stale timer resolution or lost presence refreshes; rollback should restore the prior metadata/route pair together.
- **Unknowns:** I did not probe any real hosted client to see whether it already caches or parallelizes `me`.

### UNS-002: Both MCP doors erase most downstream HTTP status semantics

- **Severity:** MEDIUM
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Public API contract accuracy; both MCP doors are part of the public contract and should preserve or explicitly encode failure semantics for callers.
- **Location:** [src/mcp.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/mcp.ts:704), [src/mcp.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/mcp.ts:870), [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:640)
- **User or business harm:** Callers using MCP cannot reliably distinguish validation (`400`), auth (`401`), payment-needed (`402`), forbidden (`403`), missing (`404`), conflict (`409`), quota (`429`), and upstream (`502/503`) failures unless they parse ad hoc text payloads. That weakens retry logic, tool orchestration, and payment/error handling precisely where agents need status codes most.
- **Evidence:** `toolResult()` always returns a JSON-RPC `result` wrapper and, except for the hosted unauthorized branch, emits HTTP `200` regardless of downstream failure. After `app.request()`, the code only sets `isError` from `response.status >= 400` and forwards raw response text, dropping the original numeric status in `src/mcp.ts:704-726` and `src/mcp.ts:860-870`.
- **Safe reproduction:** Static reproduction from shared code path was sufficient because both `/mcp` and `/mcp/connect` call the same helper. The local auth tests prove the one exception: hosted unauthorized is forwarded as `401`, which confirms the rest of the failures are intentionally treated differently.
- **Connection traced:** Caller -> `/mcp` or `/mcp/connect` -> `mcp()` -> mapped HTTP route -> downstream route returns its real HTTP status -> `toolResult()` wraps it as JSON-RPC `result` -> caller sees `200` plus free-text body for most failures.
- **Root cause:** The MCP adapter is treating downstream HTTP status as presentation detail instead of as part of the contract, with a narrow special case for hosted OAuth `401`.
- **Connections and similar locations checked:** Checked legacy and hosted door dispatch in `src/index.ts:640-656`; checked the hosted unauthorized branch in `src/mcp.ts:862-867`; checked tests in `test/mcp-auth.test.ts` and `test/round2-surfaces.test.ts`. I did not find a structured numeric status field in MCP results for any non-401 failure.
- **Durable fix:** Choose one stable MCP contract: either surface downstream status in a structured field for every tool call failure, or map failures to JSON-RPC errors in a way that preserves machine-readable retry/permission/payment semantics.
- **Why this is not a band-aid:** It fixes the adapter layer once for every tool instead of teaching each caller to reverse-engineer raw JSON text from `content[0].text`.
- **Pre-fix proof:** Add a harness test that forces one tool path each to return `400`, `402`, `409`, and `429`, then assert the MCP response preserves that status in a machine-readable form.
- **Verification:** Re-run `test/mcp-auth.test.ts` and add route-status-preservation cases for both `/mcp` and `/mcp/connect`.
- **Regression and rollback risk:** Changing MCP error shape may break clients that already parse the current raw-text wrapper. Roll out with compatibility coverage for existing hosted/legacy clients.
- **Unknowns:** I did not inspect external client code, so I cannot prove how much existing automation already depends on the current wrapper.

### UNS-003: Two world-market POST routes silently require `{}` even though the published contract reads as bodyless

- **Severity:** LOW
- **Evidence level:** E2
- **Status:** Likely
- **Rule or parameter:** Public route contract must match published docs and human-facing route descriptions.
- **Location:** [src/world-market.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/world-market.ts:1213), [src/world-market.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/world-market.ts:1292), [src/door.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/door.ts:280), [docs/SYSTEM_DESIGN.md](/abs/path/C:/Users/Owner/Documents/1f3d9/docs/SYSTEM_DESIGN.md:208)
- **User or business harm:** A caller following the published route descriptions can send a plain POST with no body and get `400 reconcile body must be empty` or `400 cancel body must be empty`. That is an avoidable integration trap at the exact routes used to recover or unlock paid world-market transfers.
- **Evidence:** `POST /api/world/offer/:offerId/reconcile` and `POST /api/world/offer/:offerId/cancel` both parse JSON and reject anything except an explicit empty object in `src/world-market.ts:1219` and `src/world-market.ts:1298`. The human-facing route contract in `src/door.ts:280-281` and `docs/SYSTEM_DESIGN.md:208` describes the routes and their semantics but does not state that callers must send `{}`.
- **Safe reproduction:** Static proof from route code and docs was enough; I did not run a custom local harness for these exact bodyless POSTs because the mismatch is direct and unambiguous in source.
- **Connection traced:** Human or agent reads route docs -> sends bodyless POST -> handler calls `jsonObject()` -> `null` body fails `hasOnly(body, [])` -> `400` before business logic.
- **Root cause:** The handler reuses a strict JSON-object gate for routes whose semantics do not actually need request bodies, and the docs were written as if they were empty-body actions.
- **Connections and similar locations checked:** Direct `transfer/:offerId/cancel` does not require a body; `agreement/:id/open-accession` also works bodylessly. This strict-empty-object requirement appears specific to these two world-market endpoints.
- **Durable fix:** Either accept an absent body the same way other bodyless POST actions do, or explicitly document `Content-Type: application/json` with `{}` in every route description and MCP/tool wrapper that reaches these routes.
- **Why this is not a band-aid:** It aligns the route contract itself instead of papering over the issue in one client.
- **Pre-fix proof:** Add bodyless local request cases for both routes and assert current `400`, then flip the expected result once the contract decision is made.
- **Verification:** Re-run `test/world-market.test.ts` with new bodyless `reconcile` and `cancel` cases.
- **Regression and rollback risk:** Accepting missing bodies is low risk because the handlers use only path params and auth. If documentation is changed instead, verify every client wrapper follows it.
- **Unknowns:** I did not inspect any external world-market client to see whether it already sends `{}`.

## Questions Needing Human Review

- No E1-only questions were kept. The main remaining unknown is external client dependence on the current MCP wrapper shape, but the repository alone cannot answer that.

## Ordered Repair Plan

1. Address UNS-001 and UNS-002 together at the MCP adapter boundary so the hosted and legacy doors stop advertising or hiding the wrong semantics.
2. Add a failing MCP contract test for `me` metadata and for preserved downstream failure status.
3. Decide the world-market empty-body contract for UNS-003, then align both implementation and docs.
4. Re-run route, MCP auth, and world-market harness tests after any change.
5. Roll out with reversible client monitoring focused on MCP tool retries, auth failures, and world-market reconciliation/cancel calls.
6. Run a new full `$unshittify` audit that cites this report.

## Verification and Release Gates

- Success conditions:
  - `me` is no longer advertised as a safe read unless the underlying route stops mutating state.
  - MCP callers can machine-read downstream failure semantics instead of receiving only a generic `isError` wrapper.
  - World-market `reconcile` and `cancel` body requirements match the published route contract and tests.
- Safe commands:
  - `node --test --experimental-strip-types test/routes.test.ts test/oauth-routes.test.ts test/oauth-disabled-routes.test.ts test/round2-surfaces.test.ts`
  - `node --test --experimental-strip-types test/world-market.test.ts test/mcp-auth.test.ts test/backend-correctness.test.ts`
- Manual checks:
  - Compare `tools/list` metadata for `me` against the actual effect path in `GET /api/me`.
  - Confirm hosted and legacy MCP callers can distinguish at least `400`, `401`, `402`, `409`, and `429`.
- Forbidden live actions:
  - No production `POST` calls, no real OAuth sign-in, no Base payment submission, no world-market live checkout.
- Rollback conditions:
  - Any client breakage caused by changed MCP error shape, or any loss of due-effect resolution promised by the current product behavior.
- Required evidence before release:
  - Updated local tests covering the repaired contract points and no regression in existing route suites.

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

single-agent audit - independently unverified

- No fresh skeptic agent reviewed these findings.
- Because the audit stayed single-agent, I did not issue E4 claims and did not use the strongest possible verdict.

## Honest Limitations

- This audit was source-first and local-harness-backed. It did not probe production routes, real OAuth providers, live Base RPC, or live 1F3EA records.
- Local tests prove many contracts but not every uncaught `500/502/503` path, and they do not prove how external MCP clients currently consume the adapter’s wrapper shape.
- `docs/audits/` was intentionally excluded because the user prohibited reading other audit reports.
- Worktree concurrency existed: other agents had already created untracked audit files under `docs/audits/`. I did not open them.
- No generated files, caches, coverage reports, screenshots, or build outputs were observed from the approved checks.
- Evidence re-opened before finalizing: `src/index.ts`, `src/mcp.ts`, `src/world-market.ts`, `src/door.ts`, `docs/SYSTEM_DESIGN.md`, `test/routes.test.ts`.
- Outside systems and platform-specific deployment behavior remain only partially covered. This report means no evidence found beyond these findings in the checked scope, not that the API contract is problem-free.

## Appendix: Route Status Inventory

Global notes:

- Any route can still end in global `500 {"error":"internal"}` through [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:144) if an exception escapes.
- `404 {"error":"no such street. GET / for the front door."}` is the global not-found response.

Top-level and window routes:

- `GET /` -> `200`
- `GET /llms.txt` -> `200`
- `GET /robots.txt` -> `200`
- `GET /humans.txt` -> `200`
- `GET /window` -> `200`
- `GET /window.css` -> `200`
- `GET /window.js` -> `200`
- `GET /api/window` -> `200`, `400`

OAuth and hosted sign-in routes:

- `GET /.well-known/oauth-protected-resource` -> `200` when hosted sign-in enabled, `404` when disabled
- `GET /.well-known/oauth-protected-resource/mcp/connect` -> `200` enabled, `404` disabled
- `GET /.well-known/oauth-authorization-server` -> `200` enabled, `404` disabled
- `GET /oauth/authorize` -> `200`, `400`, `404`
- `POST /oauth/authorize` -> `200`, `400`, `403`, `409`, `429`, `404`
- `POST /oauth/token` -> `200`, `400`, `401`, `404`
- `POST /oauth/revoke` -> `200`, `400`, `404`

Core API:

- `POST /api/register` -> `201`, `400`, `409`, `429`, `503`
- `POST /api/rotate` -> `200`, `401`, `429`
- `GET /api/residents` -> `200`, `400`
- `GET /api/me` -> `200`, `400`, `401`
- `GET /api/official` -> `200`
- `GET /api/physics` -> `200`
- `GET /api/events` -> `200`, `400`
- `POST /api/flag` -> `201`, `400`, `429`
- `POST /api/moderation` -> `201`, `400`, `401`, `403`, `404`
- `GET /api/moderation` -> `200`, `400`
- `GET /treasury` -> `200`

Actions and world routes:

- `POST /api/action` -> `200`, `400`, `401`, `403`, `404`, `409`, `429`
- `POST /api/go-home` -> `200`, `400`, `401`, `403`, `404`, `409`, `429`
- `POST /api/thing/:id/use` -> `200`, `400`, `401`, `403`, `404`, `409`, `429`
- `POST /api/thing/:id/consume` -> `200`, `400`, `401`, `403`, `404`, `409`, `429`
- `POST /api/me/home` -> `200`, `400`, `401`, `403`, `404`, `409`
- `GET /api/map` -> `200`
- `GET /api/place/:id` -> `200`, `400`, `404`
- `POST /api/place` -> `201`, `400`, `401`, `403`, `404`, `409`, `402`
- `PATCH /api/place/:id` -> `200`, `400`, `401`, `403`, `404`, `409`
- `PUT /api/place/:id/laws` -> `200`, `400`, `401`, `403`, `404`, `409`
- `GET /api/thing/:id` -> `200`, `400`, `404`
- `GET /api/kinds` -> `200`, `400`
- `POST /api/kind` -> `201`, `400`, `401`, `402`, `409`
- `POST /api/kind/:id/revise` -> `200`, `400`, `401`, `403`, `404`, `402`, `409`
- `GET /api/traits` -> `200`, `400`
- `POST /api/trait` -> `201`, `400`, `401`, `409`
- `POST /api/thing` -> `201`, `400`, `401`, `403`, `404`, `409`, `429`
- `PATCH /api/thing/:id` -> `200`, `400`, `401`, `403`, `404`, `409`
- `POST /api/thing/:id/upgrade` -> `200`, `400`, `401`, `403`, `404`, `409`
- `POST /api/thing/:id/withdraw` -> `200`, `400`, `401`, `403`, `404`, `409`

Society and direct transfers:

- `GET /api/note/:id` -> `200`, `400`, `404`
- `POST /api/note` -> `201`, `400`, `401`, `403`, `404`, `429`
- `POST /api/agreement` -> `201`, `400`, `401`, `404`, `429`
- `POST /api/agreement/:id/open-accession` -> `200`, `201`, `400`, `401`, `403`, `404`, `429`
- `POST /api/agreement/:id/sign` -> `200`, `400`, `401`, `403`, `404`, `409`, `429`
- `GET /api/agreements` -> `200`, `400`
- `POST /api/transfer` -> `200`, `400`, `401`, `403`, `404`, `409`, `500`
- `POST /api/transfer/offer` -> `201`, `400`, `401`, `403`, `404`, `409`, `500`
- `POST /api/transfer/:offerId/claim` -> `200`, `400`, `401`, `402`, `403`, `404`, `409`
- `POST /api/transfer/:offerId/cancel` -> `200`, `400`, `401`, `403`, `404`, `409`

World-market bridge:

- `GET /api/world/resident/:handle` -> `200`, `404`
- `GET /api/world/offer/:offerId` -> `200`, `400`, `404`
- `POST /api/world/listing` -> `201`, `400`, `401`, `403`, `404`, `409`, `502`, `503`
- `POST /api/world/offer/:offerId/claim` -> `200`, `202`, `400`, `401`, `402`, `403`, `404`, `409`, `502`, `503`
- `POST /api/world/offer/:offerId/reconcile` -> `200`, `202`, `400`, `401`, `403`, `404`, `409`, `500`
- `POST /api/world/offer/:offerId/cancel` -> `200`, `400`, `401`, `403`, `404`, `409`, `500`, `502`, `503`

MCP doors:

- `POST /mcp` -> `200` for `initialize`, `ping`, `tools/list`, `tools/call`, and most tool failures; JSON-RPC parse/method errors also return `200`; hosted OAuth `401` is not used here
- `GET /mcp` -> `405`
- `POST /mcp/connect` -> `404` when hosted sign-in disabled; otherwise `200` for most JSON-RPC operations and tool failures, plus `401` with `WWW-Authenticate` for hosted unauthorized tool calls
- `GET /mcp/connect` -> `405` when hosted sign-in enabled, `404` when disabled
