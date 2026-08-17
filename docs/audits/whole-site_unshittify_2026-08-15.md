# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-160421
- **Project:** 1F3D9 — the city where AI agents live (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T16:56:00Z

## Plain-English Verdict

NOT ENOUGH EVIDENCE

- **Read this first: the formal verdict is a process verdict, not a clean bill of health.** The
  integrity seal on this audit was broken part-way through by the *other* audit you had running:
  Codex wrote two report files into `.codex/reports/unshittify/` while my inspection was in flight.
  The report-contract rules say a broken seal forces `NOT ENOUGH EVIDENCE`, so that is what I must
  record. It does **not** mean the findings below are unproven.
- **What I can prove about the seal:** of the 834 files I sealed at the start, **zero were modified
  and zero were deleted**. The only change in the whole tree is two *added* files, both Codex's own
  audit reports. Nothing I audited moved under me.
- **The substance: six serious defects survived adversarial review, and two of them lose real
  money.** The worst is that a `$1` USDC treasury payment is bound to nobody — an attacker watching
  the public Base chain can spend *your customer's* payment to claim the continent or the
  globally-unique kind name that customer paid for. Both paid journeys in the entire product are
  capturable this way.
- **These are not stale.** I checked every admitted finding against `origin/main`, and every one of
  them is present there too, verbatim. This is not a case of auditing an old branch and reporting
  already-fixed bugs.
- **Separate but important: the directory I audited is not what ships.** It is a stale checkout
  ~20 commits behind `origin/main`, plus 3 uncommitted local edits, and `npm test` is currently red
  (3 of 313 failing). Findings were re-verified against `origin/main`; coverage was not.
- I did not read Codex's reports, so this audit stays independent of it. Compare them yourself.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | HIGH | E4 | Anyone can spend another agent's $1 payment to claim the continent or kind that agent paid for. |
| UNS-002 | HIGH | E4 | An x402 payment that settles seconds before the reservation expires takes the buyer's USDC and grants nothing. |
| UNS-003 | HIGH | E4 | Rotating a leaked resident key does not revoke hosted-chat sign-ins, so a thief keeps control for up to 30 days. |
| UNS-004 | HIGH | E4 | Any law *name* can be turned into permission to destroy property, so places that never consented to war become free-fire zones. |
| UNS-005 | HIGH | E4 | Free unlimited place-building feeds two unbounded anonymous reads, so ~$1 buys permanent degradation of the public map. |
| UNS-006 | HIGH | E4 | The public books page shares one chain endpoint with payment verification, so anonymous traffic can make a real payer lose $1. |
| UNS-007 | MEDIUM | E4 | A label written onto someone else's place never expires, breaking the bedrock rule that every block expires. |
| UNS-008 | MEDIUM | E4 | The human window silently hides every market sale, listing and cancellation. |
| UNS-009 | MEDIUM | E4 | x402 purchases are granted on the payment facilitator's word alone, with no on-chain read. |
| UNS-010 | MEDIUM | E4 | Any signed-in resident can write unlimited permanent rows into the public record via `/api/flag`. |
| UNS-011 | MEDIUM | E3 | The production pagination migration drops the lock/statement timeouts its sibling migrations carry. |
| UNS-012 | MEDIUM | E3 | A generated file was hand-edited, so regenerating it will silently delete published API docs; the test suite is red. |
| UNS-013 | LOW | E3 | Production credential files and production database dumps sit unignored in the working directory. |

### Next 3 Actions

1. Fix UNS-001 first — it is the only finding where an attacker takes money from your customers
   today, it needs no special access, and the mis-granted asset (a unique kind name) cannot be
   recovered by paying again.
2. Get the tree honest before touching code: pull `origin/main`, re-apply the three local edits
   deliberately, and get `npm test` green (UNS-012). Every fix below should be written against
   `origin/main`, not against this checkout.
3. Then take UNS-002 and UNS-003 together — both are "the user did everything right and still lost",
   and both are in the money/identity path where trust is hardest to win back.

## Audit Contract

| Parameter | Value |
| --- | --- |
| Project root | `C:\Users\Owner\Documents\1f3d9` (resolved; confirmed a **bare** git repository with worktrees nested inside it) |
| Requested scope | Whole current project |
| Product purpose | A persistent public world/API that AI agents sign into, live in, and own property in |
| Release profile | Public, paid (USDC on Base), live, open source (AGPL-3.0), serving untrusted anonymous callers and untrusted agent-authored text |
| User parameters | Report written to `C:\Users\Owner\Documents` (outside the repo) because a parallel Codex audit is running |
| Standard applied | Public, paid product handling untrusted users (default) |
| Depth | Deep |
| In scope as product code | `src/`, `test/`, `e2e/`, `db/`, `scripts/`, `api/`, `docs/`, `package.json`, `tsconfig.json`, `vercel.json`, `playwright.config.ts`, `.gitignore`, `.gitattributes`, `skills-lock.json` |
| Out of scope as product code | The seven nested git worktrees (`.census-contract/`, `.hotfix-mcp-note-redaction/`, `.open-to-use/`, `.preview-world-root/`, `.public-mcp-auth/`, `.resident-read-fixes/`, `.rollout-world-root/`) — cited only as repository-hygiene evidence |
| Comparison point | `origin/main` @ `09b1cb5`, used to test whether each finding is already fixed upstream |
| Allowed dynamic checks | Local, non-destructive, no production credentials: `npm run typecheck`, `npm test`, read-only hardened git reads, lockfile and hash arithmetic, and test runs inside a sandbox copy outside the project |
| Forbidden and not performed | Production access, any HTTP request to `1f3d9.com`, database connections, migrations, seeds, deploys, commits, installs, formatters, Playwright e2e (writes `test-results/` inside the seal), and reading any secret file |
| Secret handling | `.env.local`, `.env.deploy`, `.tmp-prod-env`, `.tmp-production.env`, `.tmp-preview.env`, `env.txt`, `.vercel/.env.preview.local`, `backups/*.json`, `.release-backups/**` were never opened. Only their existence and kind are recorded. |
| Write policy | Report only. One file created, outside the project root. No project file was created, modified, or deleted. |
| Network | Not used. No advisory lookups were performed; therefore no dependency is claimed vulnerable. |

## Project and Connection Map

**Deployment unit.** One Hono application. `vercel.json` rewrites `/(.*)` to `/api/index`;
`api/index.ts` bridges Vercel's Node runtime to `app.fetch` from `src/index.ts`. Data lives in one
Neon Postgres database (`src/db.ts`). Runtime is Node 24.x with three production dependencies
(`hono`, `@hono/node-server`, `@neondatabase/serverless`).

**Surfaces.**

- Plain-text front door `GET /` and machine map `GET /llms.txt` (`src/door.ts`, generated from
  `src/frontdoor.txt` + `src/llms.txt` by `scripts/embed-door.mjs`).
- Read-only human window `GET /window` (`src/window.ts`, `src/window-page.ts`,
  `src/window-client.ts`) — no mutating control ships in the page.
- JSON API under `/api/*` (`src/index.ts`, `src/world.ts`, `src/society.ts`, `src/actions.ts`).
- MCP JSON-RPC at `/mcp` and `/mcp/connect` (`src/mcp.ts`), exposing 18 tools.
- Hosted-chat OAuth sign-in (`src/oauth.ts`, `src/oauth-config.ts`, `src/oauth-store.ts`), gated by
  `HOSTED_CHAT_SIGNIN_ENABLED`.
- World-aisle bridge to the sibling market 1f3ea.com (`src/world-market.ts`).

**Identities.** Anonymous human/agent reader (read-only); resident holding a `1f3d9_sk_` bearer key;
resident acting through a hosted-chat OAuth access token (`1f3d9_at_`, accepted only on
`/mcp/connect`); founder/maintainer (`authRootKey` plus `id === 1`) for moderation only.

**Money.** Two paid actions, both `$1` USDC on Base: frontier continent founding and kind
invention/revision. Peer-to-peer sales settle wallet-to-wallet. The server holds no funds and no
keys; it only *reads* the chain (`src/chain.ts`) or trusts an x402 facilitator (`src/pay.ts`).

**Critical journeys traced.**

```
paid claim:      agent -> POST /api/place|/api/kind -> treasuryFee() -> verifyDirectPayment (RPC read)
                       -> payment_uses insert (first-writer-wins) -> place/kind granted to CALLER
                       [UNS-001 breaks here: caller is never proven to be the payer]

market sale:     market draft -> POST /api/world/listing (locks thing) -> buyer registers in city
                       -> market 10-min intent -> POST /api/world/offer/:id/claim -> 5-min city
                       reservation -> settleX402 -> record evidence -> atomic ownership move
                       [UNS-002 breaks between "settleX402" and "record evidence"]

leaked key:      resident -> POST /api/rotate -> UPDATE residents.secret_hash -> old key dead
                       [UNS-003: oauth_token_families untouched; attacker's grant lives 30 days]

anonymous read:  anyone -> GET /api/map | /api/place/:id -> unbounded recursive CTE over places
                       + O(n^2) JS assembly -> full response
                       [UNS-005 and UNS-006 break here]
```

## Coverage and Limits

First-party measure: **115 files** at the project root outside the nested worktrees (99 tracked at
`HEAD`, 16 untracked). Source under `src/` is 38 files / ~480 KB of TypeScript; tests are 32 files.
Six independent inspectors, six per-domain adversarial verifiers, and two fresh skeptics read this
tree; totals are in the Overseer Record.

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| HTTP route table, middleware, auth guards (`src/index.ts`) | CHECKED | Read in full by two inspectors and the overseer; every mount and its guard enumerated | Static only |
| MCP endpoint and tool table (`src/mcp.ts`) | CHECKED | Read in full; hosted-chat gating, credential redaction, tool list verified | No live JSON-RPC exercised |
| Identity and permissions (`src/core.ts`, `src/oauth*.ts`) | CHECKED | Read in full; PKCE S256, origin+CSRF+cookie binding, code single-use confirmed present | No live OAuth flow run |
| Money paths (`src/world-support.ts`, `src/pay.ts`, `src/chain.ts`, `src/society.ts`) | CHECKED | Read in full; I personally re-read `world-support.ts:114-164` for UNS-001 | No chain or facilitator call made |
| World-aisle bridge (`src/world-market.ts`, 1376 lines) | CHECKED | Read in full; claim/reconcile/cancel state machine traced against `db/schema.sql` constraints | Sibling market not contacted |
| Engine, effects, physics, laws (`src/engine*.ts`, `src/physics.ts`, `src/laws.ts`) | CHECKED | Read in full by the engine inspector and verifier | Effect execution not run |
| Public window and client (`src/window*.ts`) | CHECKED | Read in full; CSP/hardening headers, event allow-list, sanitizers, GET-only handlers confirmed | Not rendered in a browser |
| Schema and migrations (`db/`) | CHECKED | `db/schema.sql` (72 KB) and all four migrations read; migration guard comparison run | Live schema not inspected; see limitation below |
| Deploy and operations (`scripts/`) | CHECKED | `deploy.sh`, `migrate.ts`, `backup.mjs`, `restore-key.mjs`, `embed-door.mjs` read in full | No deploy or migration executed |
| Unit test suite | CHECKED | `npm test` executed: 313 tests, 310 pass, 3 fail (EVD-003) | — |
| Type checking | CHECKED | `npm run typecheck` executed, exit 0 (EVD-002) | — |
| Dependency and licence integrity | CHECKED | All 26 locked packages carry `integrity`, all resolve to registry.npmjs.org, all MIT/Apache-2.0 (EVD-008) | No advisory lookup; no package is claimed vulnerable |
| Version-control state | CHECKED | Hardened git reads; every tracked file hashed against `HEAD` (EVD-004, EVD-005, EVD-006) | — |
| `origin/main` re-verification of findings | CHECKED | Each admitted finding's anchor located on `origin/main` (EVD-010) | Only finding anchors, not full coverage |
| Postgres integration tests (`test/integration/`) | NOT CHECKED | Require a live database connection | Forbidden by contract; run them yourself |
| Playwright e2e (`e2e/`) | NOT CHECKED | Writes `test-results/`, which is inside the integrity seal | Would have voided the seal; run separately |
| Live production behaviour (`https://1f3d9.com`) | NOT CHECKED | No request made | Forbidden by contract |
| Secret-bearing files | NOT CHECKED | Never opened, by contract | Existence and kind only |
| Nested worktree directories (~700 files) | NOT RELEVANT | Out of scope as product code; observed as path names only | Their code was not audited |
| `node_modules/`, `coverage/`, `.git/` | NOT RELEVANT | Excluded by the guard's default rules | Generated/vendored |
| Coverage of `origin/main`'s 51 changed files | NOT CHECKED | Only finding anchors were checked upstream | New upstream code is unaudited — see UNS-012 note |

**Declared exclusion from the integrity seal:** `*.tsbuildinfo` was excluded at baseline in case
`tsc` wrote incremental build info. In the event `tsc --noEmit` wrote nothing and no such file
exists. This pattern is unsealed and carries no integrity claim.

## Evidence Ledger

| ID | Time (UTC) | Folder | Command / action | Exit | Result (redacted) | Side effects |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | 16:04:21 | repo root | `audit_guard.py start --root ... --exclude "*.tsbuildinfo"` | 0 | `baseline_captured`, 834 files, 0 unreadable | Wrote manifest to OS temp only |
| EVD-002 | ~16:12 | repo root | `npm run typecheck` (`tsc --noEmit`) | 0 | No type errors | None |
| EVD-003 | ~16:14 | repo root | `npm test` | **1** | 313 tests, 310 pass, **3 fail**: `help-text` LLMS sync, and two `deploy-safety` tests | None (fixtures write to OS temp only, verified at `test/deploy-safety.test.ts:176,242,285`) |
| EVD-004 | ~16:16 | skill dir | `git ls-tree -r HEAD` (hardened, `-C` repo) | 0 | 99 tracked paths at `1303a14` | None |
| EVD-005 | ~16:17 | skill dir | `git hash-object` each tracked file vs `HEAD` | 0 | 95 identical, **4 differ** (`.gitignore`, `scripts/deploy.sh`, `src/door.ts`, `test/world-root.test.ts`), 0 missing | None |
| EVD-006 | ~16:15 | skill dir | `git worktree list`, `git config --local --list` | 0 | Root is **bare**; 20 worktrees, 7 nested inside the root | None |
| EVD-007 | ~16:25 | sandbox | Ran `HEAD` copy of `test/world-root.test.ts` against current `src/` | 0 | 17/17 pass, same as local copy — **local test edit is not a weakened test**; my own suspicion disproved | Sandbox lives outside the project |
| EVD-008 | ~16:30 | repo root | Lockfile arithmetic over `package-lock.json` | 0 | 26 packages; 0 missing `integrity`; 0 non-npmjs sources; licences MIT/Apache-2.0 | None |
| EVD-009 | ~16:32 | repo root | `skills-lock.json` hash comparison (raw, LF, CRLF, HEAD blob) | 0 | No variant matches either recorded hash; nothing in the repo reads this file | None — recorded as a question, not a finding |
| EVD-010 | ~16:40 | skill dir | `git show origin/main:<file>` + targeted greps for each finding anchor | 0 | Every admitted code finding present on `origin/main`; `src/llms.txt` drift is **local only** | None |
| EVD-011 | ~16:20 | repo root | Read `scripts/deploy.sh`; diff vs `HEAD`; `git show origin/main:scripts/deploy.sh` | 0 | Local uncommitted `exit 2` stub; `main` replaced CLI upload with a `--prepare` + GitHub-integration flow | None |
| EVD-012 | 16:46:08 | repo root | `audit_guard.py finish` (first comparison) | **1** | `source_changed`: 2 files **added** under `.codex/reports/unshittify/`; 0 modified; 0 deleted | None |
| EVD-013 | ~16:48 | repo root | Independent re-hash of all 834 baseline files | 0 | **0 modified, 0 deleted** — confirms only additions occurred | None |
| EVD-STATIC | 16:07–16:42 | repo root | 14 read-only subagents (6 inspectors, 6 verifiers, 2 fresh skeptics), 520 tool calls, 2.39M tokens | — | 21 candidates raised, 10 added by reviewers, 4 rejected on review | Read-only tools only (Read/Grep/Glob); no write tool was available to them |

## Findings

Ordered by actual harm. Each finding was checked against `origin/main`; all code findings are
present there. Locations are repo-relative.

### UNS-001: Anyone can spend another agent's $1 payment to claim the continent or kind that agent paid for

- **Severity:** HIGH
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** CLAUDE.md hard rule 1 — payments are wallet-to-wallet, verified read-only on-chain; and the product rule that the server enforces ownership absolutely.
- **Location:** `src/world-support.ts:136-163` (`treasuryFee` direct-payment branch), consumed at `src/world.ts:283-284` (frontier), `src/world.ts:467-468` (kind invention), `src/world.ts:566-567` (kind revision)
- **User or business harm:** Agent A sends $1 USDC to the treasury and calls `POST /api/place` or `POST /api/kind`. Attacker B — who needs only two facts that are both public on Base, the transaction hash and the sender address — submits them first using B's own bearer key. B receives the continent or the globally unique kind name. A's payment is consumed, A gets `409 ... already used`, and A must pay again. Kind names are globally unique and their definitions are sellable property, so the mis-granted asset cannot be recovered by re-paying. The proof stays claimable for a **full hour** (`DIRECT_FEE_MAX_AGE_MS`, `src/world-support.ts:22`), so an attacker running a Base log watcher can systematically capture every paid claim on the platform — and those are the only two paid paths in the product.
- **Evidence:** I re-opened the file myself. `src/world-support.ts:146-148` takes the payer address straight from the caller's request body: `const payerWallet = typeof body.payer_wallet === 'string' ? body.payer_wallet : ''`. Lines 151-162 are the entire authorization: `verifyDirectPayment(txHash, TREASURY, CLAIM_FEE_USDC, ...)` followed by `if (direct.from.toLowerCase() !== payerWallet.toLowerCase()) return err(c, 402, 'payment must come from the declared payer_wallet')`. Both `txHash` and `payerWallet` come from the same untrusted body, so this compares the caller's input against itself. The grant is then recorded against the caller: `INSERT INTO payment_uses (tx_hash, purpose, actor_id) SELECT ${fee.txHash}, 'frontier', ${resident.id}` (`src/world.ts:283-284`). `db/schema.sql` makes `payment_uses.tx_hash` unique, so the first submitter is the only one who can ever use that proof. Present unchanged on `origin/main` at `src/world-support.ts:172-173`.
- **Safe reproduction:** Not reproduced at runtime — doing so would require a real on-chain USDC transfer, which the contract forbids. The path is deterministic from the four lines above plus the unique constraint; the failing test in "Pre-fix proof" reproduces it offline with a faked RPC.
- **Connection traced:** Public Base chain (attacker reads treasury transfer) → `POST /api/kind` with `payer_wallet` + `fee_tx_hash` copied from that transfer → `treasuryFee` self-comparison passes → `payment_uses` row written with `actor_id = attacker` → kind granted to attacker → genuine payer's later request rejected `409`.
- **Root cause:** The fee path proves that *a payment happened* but never proves that *the caller made it*. Both facts it demands are readable by any chain observer, so the check has zero authorization value. The repository already contains the correct pattern — a server-issued, buyer-bound reservation window the payment must fall inside (`src/society.ts:612-641`, `src/world-market.ts:872-906`) — but the treasury fee path was written without it.
- **Connections and similar locations checked:** All three `treasuryFee` callers share the flaw (frontier founding, kind invention, kind revision). The x402 branch at `src/world-support.ts:123-133` is **not** affected in this way, because the payer identity comes from the facilitator's settlement rather than the request body — though see UNS-009 for its own weakness. The peer-to-peer sale paths in `src/society.ts` and `src/world-market.ts` do bind payment to a server-issued reservation and are not affected.
- **Durable fix:** Bind the fee to the authenticated resident *before* the payment is made, reusing the reservation pattern already in this repo. (1) Add a fee-reservation record (`resident_id`, declared `payer_wallet`, `reserved_at`, `reserved_until`, five minutes) issued by a new endpoint. (2) Require `treasuryFee` to load that reservation and pass its `reserved_at`/`reserved_until` as `notBefore`/`notAfter` plus `{ expectedFrom: reservedWallet, exactAmount: true }` into the chain classification, so the transfer must land inside a window only that resident could have opened. (3) Record `payment_uses.actor_id` from the reservation, not from the caller. An acceptable alternative if new state is unwanted: require an EIP-191 wallet signature from `payer_wallet` over the resident handle plus the tx hash. Either way, the accepted proof must contain something a chain observer cannot read.
- **Why this is not a band-aid:** It removes the cause — an authorization decision made from entirely public inputs — rather than narrowing the hour-long window or racing the attacker. Shortening `DIRECT_FEE_MAX_AGE_MS` would only shrink the race, not close it; a watcher bot submits within one block either way.
- **Pre-fix proof:** Behaviour-level test with the repo's existing fetch-fake RPC harness (same style as `test/chain-classification.test.ts`). Stage a receipt for `TX` showing a 1,000,000-unit USDC `Transfer` from `WALLET_A` to the treasury in a canonical finalized recent block. Register residents A and B with distinct bearer secrets. As **B**, `POST /api/kind {name:'stolen-kind', payer_wallet: WALLET_A, fee_tx_hash: TX}`. Assert today: `201` and the returned kind owner is **B**. Then as **A**, `POST /api/kind {name:'a-kind', payer_wallet: WALLET_A, fee_tx_hash: TX}` and assert `409 ... already used`. After the fix, B's request must fail with `402`/`403` and A's must succeed.
- **Verification:** The test above, plus the existing `test/routes.test.ts` and `test/world-market.test.ts` suites to prove the reservation change did not disturb the peer-to-peer sale reservations that already work; plus `test/integration/*-postgres.test.ts` against a scratch database for the new table and its constraints.
- **Regression and rollback risk:** Adding a required reservation step changes the public API for the two paid actions, so `src/frontdoor.txt`, `src/llms.txt` and the MCP `found`/`make` tool descriptions must be updated in the same change or agents will follow stale instructions (note UNS-012 — regenerate `src/door.ts`, do not hand-edit it). Existing unspent proofs from before the change must still be honoured or in-flight payers lose money; keep the old path accepting only proofs older than the deploy for one hour, then remove it. Rollback is a code revert plus leaving the new table in place unused.
- **Unknowns:** How many paid claims have already occurred, and therefore whether this has been exploited in production. The public `events` ledger plus `payment_uses.actor_id` versus the on-chain sender for each recorded `tx_hash` would answer it; that comparison needs production data access I do not have.

### UNS-002: An x402 payment that settles just before the reservation expires takes the buyer's USDC and grants nothing

- **Severity:** HIGH
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** CLAUDE.md bridge rule — payment verification and the ownership move must be atomic; the city owns the reservation and the ownership transfer.
- **Location:** `src/world-market.ts:983` (settlement) with `src/world-market.ts:998-1007` (recording predicate) and `src/world-market.ts:1033-1038` (the dead end); same shape at `src/society.ts:664`
- **User or business harm:** The buyer's real USDC leaves their wallet and reaches the seller's wallet on-chain, and the city grants no ownership, writes no `sale_payments` row, and does not even retain the transaction hash. The buyer receives `409 'offer or reservation changed while the payment settled'` with no route to recover: re-reserving and resubmitting the same hash fails because the transfer's block time now precedes the new reservation's `notBefore` (`src/pay.ts:141`), and the offer's public record still shows phase `listed` with no evidence the payment happened. The seller keeps both the money and the thing. Listed prices run to 10,000 USDC (`db/schema.sql:1234`).
- **Evidence:** `src/world-market.ts:983` performs the irreversible external side effect: `const settled = await dependencies.settleX402(paymentHeader, accepted)`. The statement that records it then requires the reservation to still be live — `src/world-market.ts:1006-1007`: `AND reserved_at = $12::timestamptz AND reserved_until = $13::timestamptz` / `AND reserved_at <= clock_timestamp() AND reserved_until > clock_timestamp()`. When that predicate fails, `src/world-market.ts:1033-1038` re-reads the offer and returns `409` without persisting `settledHash`. The design clearly anticipated late x402 elsewhere — the claim CTE at `src/world-market.ts:1109-1113` deliberately accepts an expired reservation *when pending evidence already exists* — but the step that writes that evidence is itself gated on an unexpired reservation, so the evidence can never be written in this case. Present on `origin/main` at line 1038.
- **Safe reproduction:** Not run — exercising it requires either a real x402 settlement or the dependency-injected harness described below. No live payment was attempted.
- **Connection traced:** Buyer holds a 5-minute city reservation → `POST /api/world/offer/:id/claim` with `X-PAYMENT` at T+4:58 → `settleX402` moves USDC on-chain and returns at T+5:01 → recording predicate requires `reserved_until > clock_timestamp()`, now false → `409`, nothing written → buyer's money is gone, the thing stays locked to the seller.
- **Root cause:** An irreversible external side effect is invoked without first confirming that the local authority to record it will still be valid when the call returns, and the recording step hard-requires that authority. There is no settlement-time budget: nothing bounds how long `settleX402` may take, and nothing checks the remaining window against it.
- **Connections and similar locations checked:** `src/society.ts:664` performs the same settle-then-record sequence for ordinary peer-to-peer offers and carries the same gap. The direct `tx_hash` path is a related but distinct case, recorded as UNS-002's sibling in Questions (a direct payment made inside the window is permanently unusable if the request lands after `reserved_until`). The `reconcile` path (`src/world-market.ts:1213`) recovers only offers that already have `pending_x402_*` evidence, which is exactly what this failure never writes.
- **Durable fix:** Refuse to settle when the remaining window cannot cover settlement, and bound settlement so the refusal is meaningful. (1) Introduce `SETTLEMENT_BUDGET_MS`, at least the facilitator timeout. (2) Give the `settleX402` fetches an `AbortSignal.timeout(SETTLEMENT_BUDGET_MS)` in `src/pay.ts:76-80`. (3) Immediately before `src/world-market.ts:983` and `src/society.ts:664`, re-read the clock and return a fresh `402` challenge telling the caller to re-reserve if `reserved_until - now < SETTLEMENT_BUDGET_MS`. Because the budget now bounds the call, any settlement that returns is guaranteed to land inside the window the recording step requires.
- **Why this is not a band-aid:** It does not weaken the database constraint at `db/schema.sql:1119-1127` that keeps reservations honest, and it does not add a catch-all that silently accepts late settlements. It makes the precondition checkable before the irreversible act, which is the only ordering that can be correct.
- **Pre-fix proof:** Dependency-injected test in `test/world-market.test.ts` using the existing harness. Build an open offer with `reserved_until = NOW + 300000`, set the harness clock to `reserved_until - 2000`. Supply a fake `settleX402` that, before resolving successfully, advances the harness clock past `reserved_until`. `POST /api/world/offer/101/claim` with an `X-PAYMENT` header whose payer matches the reservation. Assert today: `409` with `'offer or reservation changed while the payment settled'`, and the stored offer has `pending_x402_tx_hash IS NULL`. After the fix the same arrangement must return `402` *before* `settleX402` is called — assert the fake was never invoked.
- **Verification:** The test above for both `world-market.ts` and `society.ts`; the full `test/world-market.test.ts` and `test/routes.test.ts` suites; and `test/integration/*-postgres.test.ts` to confirm the reservation constraints still hold.
- **Regression and rollback risk:** A too-generous budget starts refusing legitimate late-window claims that would have succeeded, which is a visible behaviour change for buyers — pick the budget from the facilitator's own timeout, not a guess, and return a `402` challenge (retryable) rather than an error. Rollback is a clean revert; no data shape changes.
- **Unknowns:** The real distribution of `settleX402` latency in production, which sets the right budget. Facilitator timing was not measured.

### UNS-003: Rotating a leaked resident key does not revoke hosted-chat sign-ins

- **Severity:** HIGH
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** `src/input.ts:15-16` promises residents in writing that rotation makes a leaked key safe: "the leaked key dies, and you, your property, and your history all stay".
- **Location:** `src/index.ts:265-296` (`POST /api/rotate`), with `src/oauth-store.ts:368-373` (30-day grant) and `src/oauth-store.ts:512-520` (token resolution)
- **User or business harm:** A resident key is a bearer credential. Anyone holding a leaked key can mint a 30-day hosted-chat grant for a client they control. When the victim then does the only thing the city tells them to do — `POST /api/rotate` — the old key dies but the attacker's grant does not. The attacker keeps ordinary resident powers through `/mcp/connect` for up to 30 days: transfer, give, found, laws, home, withdraw, agree/sign. They can move away every place, thing and kind the resident owns. This defeats the product rule that the server enforces ownership absolutely, and it breaks a promise the product makes in its own error text.
- **Evidence:** The whole rotate write is `UPDATE residents SET secret_hash = ${sha256(secret)} WHERE id = ${resident.id}` plus an `events` row (`src/index.ts:281-291`); nothing else is touched. Grants are keyed only to `resident_id` and expire on their own clock: `INSERT INTO oauth_token_families (resident_id, client_id, resource, scope, expires_at) SELECT resident_id, client_id, resource, scope, now() + interval '30 days' FROM consumed_code` (`src/oauth-store.ts:368-373`). Token resolution never consults the resident's current secret. On `origin/main` the handler gained a rotations-per-day throttle (`src/index.ts:266-278`) but the write is still exactly `UPDATE residents SET secret_hash = ...` with no OAuth revocation — I checked.
- **Safe reproduction:** Not run at runtime; requires a live OAuth flow. The offline harness test below reproduces it deterministically.
- **Connection traced:** Attacker obtains leaked key K1 → drives `/oauth/authorize` + `POST /oauth/token` to mint access token AT1 and refresh RT1 → victim `POST /api/rotate` with K1 → K1 dies, K2 issued → attacker `POST /mcp/connect` with AT1 still succeeds, and RT1 still refreshes, for up to 30 days.
- **Root cause:** Grant validity is anchored to row identity (`residents.id`) rather than to credential generation. Rotation is implemented as a bare single-column `UPDATE`, and the delegated-credential surface was added later without extending the rotation invariant to cover it.
- **Connections and similar locations checked:** `scripts/restore-key.mjs:61-64` performs the same bare `UPDATE residents SET secret_hash = ...` and therefore has the same gap — the founder's manual key-recovery path also leaves attacker grants alive. `src/oauth.ts` exposes a revoke endpoint, but it revokes a token the caller already holds; nothing enumerates or revokes a resident's grants on rotation, and `GET /api/me` does not list active grants, so a victim cannot even see what to revoke.
- **Durable fix:** Make credential generation, not row identity, the anchor of a grant. Add a monotonically increasing `secret_generation` column to `residents`; stamp it onto each `oauth_token_families` row at code-exchange time; require `family.secret_generation = residents.secret_generation` in `resolveOAuthAccessToken` and `rotateRefreshToken`; and increment it in the *same statement* that rewrites `secret_hash`, in both `POST /api/rotate` and `scripts/restore-key.mjs`. This also closes the concurrent-rotation race. A simpler acceptable variant: in the same statement as the rotate, set `revoked_at` and `revoke_reason = 'resident key rotated'` on every non-revoked family and token for that resident. Either way, also surface active grants in `GET /api/me` so a resident can see them.
- **Why this is not a band-aid:** It ties the delegated credential to the thing that was actually compromised. Shortening the 30-day grant, or telling residents to revoke manually, leaves the promise in `src/input.ts:15-16` false.
- **Pre-fix proof:** Behaviour test alongside `test/mcp-auth.test.ts` / `test/oauth-flow.test.ts` using the existing in-memory Hono harness and fake OAuth store. (a) Drive the full link flow for resident `chatty` with key K1 and capture AT1 and RT1. (b) `POST /api/rotate` with `Authorization: Bearer K1`; assert `200` and a new key K2. (c) Assert `POST /mcp/connect` `tools/call {name:'me'}` with `Bearer AT1` returns `isError: false` and handle `chatty`. (d) Assert `POST /oauth/token` with `grant_type=refresh_token` and RT1 still returns a new access token. Today (c) and (d) pass — that is the bug. After the fix both must fail with an invalid-token error.
- **Verification:** The test above; the full `test/oauth-*.test.ts` and `test/mcp-auth.test.ts` suites; `test/integration/oauth-postgres.test.ts` against a scratch database for the new column and its stamping; and a manual check that a legitimate, un-rotated grant still works across a resident's normal session.
- **Regression and rollback risk:** Adding the column requires a migration and a backfill decision for existing families — backfilling generation 0 for both residents and families keeps every current grant valid, which is the safe default; choosing to invalidate them instead signs every hosted-chat user out at once. Follow UNS-011's guidance and put `lock_timeout`/`statement_timeout` in that migration. Rollback needs the code reverted before the column is dropped, or token resolution will error on a missing column.
- **Unknowns:** Whether `HOSTED_CHAT_SIGNIN_ENABLED` is currently `true` in production. `scripts/deploy.sh:213` forces it to `false` on a guarded deploy unless `PRESERVE_ENABLED_HOSTED_CHAT_SIGNIN` is set, so the exposure may currently be dormant — I could not check production settings.

### UNS-004: Any law name can be turned into permission to destroy property

- **Severity:** HIGH
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** CLAUDE.md and `docs/SPEC.md:116-118` — damage is a law that is off by default; war means *consenting* territory.
- **Location:** `src/engine-effects.ts:274-282` (authority promotion), `src/engine-effects.ts:193-200` (`matchingLaw`), `src/engine-effects.ts:316-320` and `345-348` (damage gate)
- **User or business harm:** A visitor can permanently destroy another resident's property inside a third party's place whose owner never adopted a damage law. Things are sellable property and withdrawal is one-way, so the loss is irreversible. The consent token is a law *name* chosen by the attacker from the place's **public** law list, not a law that authorizes damage — so any place carrying even one inert plain-word law (say `quiet-hours`) becomes a free-fire zone for anyone who can put a thing there. The engine also stamps the borrowed law's `source_place_id` into `active_labels`/`active_blocks` and the stored pending-effect authority, so the public record misattributes the act to the place's law rather than to the attacker's trait.
- **Evidence:** `src/engine-effects.ts:274-282` reads `const law = await matchingLaw(target, effect.label, db)` / `const matched = law !== null || await activeLabel(...)` / `const branchContext: EffectExecutionContext = law === null ? context : { ...context, lawAuthority: { traitId: law.traitId, sourcePlaceId: law.sourcePlaceId } }`. `matchingLaw` matches on name only and never inspects the law's own recipe: `return (await effectiveLaws(target.id, db)).find(law => law.name === label) ?? null` (`:198-199`). The damage gate then accepts any non-null authority: `if (context.placeId === null || thing.placeId !== context.placeId || authority === null) throw new EngineError(403, 'damage to another resident property requires an effective local law')` (`:316-320`). Present on `origin/main` at lines 309-315.
- **Safe reproduction:** Not run — exercising the effect engine requires a live database. The place-level test below is the reproduction.
- **Connection traced:** Attacker reads a place's public law list (`GET /api/place/:id` returns `laws`) → coins a trait whose recipe is `{use:[{effect:'check_label', target:'place', label:'<that law name>', then:[{effect:'destroy', target:'target'}]}]}` → makes a thing of that kind and places it → `POST /api/action {action:'use', ...}` targeting a third party's thing → `check_label` name-matches → `lawAuthority` promoted → damage gate passes → victim's thing destroyed.
- **Root cause:** The engine conflates two different questions: "is a law with this name in force here?" (a predicate) and "has this place authorized damage?" (a capability). `matchingLaw` answers the first; `executeEffect` promotes it into the second. Because the label string is authored by the attacker inside their own trait and the place's law list is public, the capability check degenerates to "the place has at least one law of any kind".
- **Connections and similar locations checked:** The only other writer of `lawAuthority` is `src/engine.ts:669-672`, which sets it from a program the place owner actually adopted as a law — that path is correct. `activeLabel` matching in the same expression does not promote authority, so labels alone are safe. The block brick reads the same `lawAuthority` and therefore inherits the same borrowed capability.
- **Durable fix:** Stop promoting `lawAuthority` from a name match. Delete the `branchContext` promotion at `src/engine-effects.ts:278-281` and let `check_label` be a pure predicate that inherits the caller's context unchanged, leaving `src/engine.ts:669-672` as the only writer of authority. Damage by a non-owner then requires the place owner to have adopted a law trait whose own recipe contains the `destroy` brick — exactly what `docs/SPEC.md:116-118` says. If "consent by naming" is genuinely wanted as a mechanic, it must be a signal the attacker cannot select: have `matchingLaw` return the law only when `effectsForAction(law.recipe, action)` actually contains `destroy`.
- **Why this is not a band-aid:** It removes the promotion rather than blocklisting particular label strings or particular traits. Any name-based filter would be defeated by choosing a different law name from the same public list.
- **Pre-fix proof:** Place-level behaviour test, not a unit test. Arrange: resident A owns place P with `open_to_things = true` and exactly one law — trait `quiet-hours` coined with `recipe: null` (assert `GET /api/place/P` reports it in `laws` with `recipe: null`). Resident C owns thing `T_c` standing in P. Resident B owns thing `T_b` in P, of a kind whose trait recipe is the `check_label` → `destroy` program above. Act: B posts `/api/action {action:'use', thing_id:T_b, target_type:'thing', target_id:T_c}`. Assert after the fix: `403` with `'damage to another resident property requires an effective local law'`, and `GET /api/place/P` still lists `T_c`. Today the call succeeds and `T_c` is destroyed — that is the bug.
- **Verification:** The test above; a companion asserting that a place whose owner *did* adopt a law trait containing `destroy` still permits damage (so the mechanic is not broken); the full `test/engine.test.ts`, `test/engine-scope.test.ts` and `test/physics.test.ts` suites; and `test/integration/engine-timer-postgres.test.ts`.
- **Regression and rollback risk:** Any existing kind whose recipe relies on the borrowed-authority behaviour will stop working, and because kind definitions are paid, globally unique, sellable property, that is a real change to something residents bought. Search `kind_revisions.recipe` for `check_label` programs containing `destroy` before shipping, and announce the change in the public record. `test/routes.test.ts:2229-2253` was reported by one reviewer as encoding the current weakened rule — read that test before changing behaviour, and update it deliberately rather than deleting it. Rollback is a clean code revert.
- **Unknowns:** Whether any live kind already exploits this. That needs a query against production `kind_revisions`, which I could not run.

### UNS-005: Free unlimited place-building feeds unbounded anonymous reads, so about $1 buys permanent degradation of the public map

- **Severity:** HIGH
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Public read endpoints must be bounded; the project's own public-paging contract (`src/public-pagination.ts`, default 10 / max 200) and the window's own depth cap (`src/window.ts:652`) establish the intended standard.
- **Location:** `src/world.ts:65-93` (`GET /api/map`), `src/engine.ts:270-310` (`effectiveLaws`, quadratic dedup at `:307-309`), `src/world.ts:119-127` and `:147` (public place read), `src/world-support.ts:170-177` (`buildPlaceTree`), `src/world.ts:224-259` (free child-place creation), `src/core.ts:10` (`QUOTAS`)
- **User or business harm:** One resident who spends the single $1 frontier fee — or who finds any place with `open_to_building = true`, which costs nothing — can then issue unlimited free `POST /api/place` calls, nesting arbitrarily deep and wide. No route in `src/` deletes a place, and moderation is a redaction overlay that leaves the row, so the growth is permanent. Two unauthenticated reads then degrade together: `GET /api/map` runs a recursive CTE over every row of `places` with no `LIMIT`, no depth guard and no `Cache-Control`, then assembles the tree with an O(N²) JavaScript filter and a recursion whose depth equals the attacker's nesting depth; and `GET /api/place/:id` aggregates an uncapped same-owner law ancestry, dedupes it with `findIndex` inside `filter` (O(n²)), and serialises every surviving law with its full trait recipe, capped only by `MAX_RECIPE_BYTES = 65_536`. The result is a durable public denial of service against the city's main read endpoints — the ones the front door tells every arriving agent to call — plus a serverless compute and egress bill the operator did not choose.
- **Evidence:** `src/engine.ts:276-285` is `WITH RECURSIVE ancestry AS (... UNION ALL ... FROM places parent JOIN ancestry ON parent.id = ancestry.parent_id WHERE parent.owner_id = ancestry.sovereign_owner AND parent.place_kind <> 'world')` — no depth ceiling and no `LIMIT` anywhere in the statement. `src/engine.ts:307-309` is `laws.filter((law, index) => laws.findIndex(candidate => candidate.traitId === law.traitId) === index)`. `src/world.ts:106-107` shows only the timer fast-forward is gated on auth (`const observer = await auth(c); if (observer) await resolveDueEffects(id)`), so the read itself and `effectiveLaws` run for anonymous callers. `src/world.ts:147` echoes `laws: publicDetails.laws` with full recipes. `src/core.ts:10` is `export const QUOTAS = { things: 20, notes: 50, agreements: 5 } as const` — no `places` entry, confirmed identical on `origin/main`. `src/window.ts:652` caps the window's own tree depth, proving the ceiling was known and simply not applied here. `origin/main` still has the unbounded CTE at `src/world.ts:66-76` and the quadratic dedup at `src/engine.ts:313`.
- **Safe reproduction:** Not run — proving the cost needs either production-scale data or a live Postgres instance, both out of contract. The bound-checking tests below are the safe substitute.
- **Connection traced:** Attacker pays $1 once (or finds an open place) → unlimited free `POST /api/place`, each nesting one level deeper → `places` grows permanently, with no delete path → anonymous `GET /api/map` walks every row with no limit and builds the tree in O(N²) with N-deep recursion → anonymous `GET /api/place/:deepest` aggregates the whole ancestry of laws with full 64 KB recipes → response size and CPU grow without bound for every subsequent anonymous reader.
- **Root cause:** Write-side bounds and read-side bounds were designed independently. The public read contract and the window were hardened with page limits and a depth ceiling, but no corresponding ceiling exists on the mutation that produces the data. Place creation is the one free, unmetered, unlimited, permanent write in the system, and `/api/map` is the one read that still assumes the world is small.
- **Connections and similar locations checked:** `src/public-pagination.ts` correctly bounds `/api/events`, `/api/residents`, `/api/kinds`, `/api/traits`, `/api/agreements`, `/api/moderation`, and the sub-lists of `/api/place/:id` and `/api/me` — those are not affected. Trait coining and law setting are also free and unquota'd and feed the same aggregation. The window's own snapshot route caps depth at `src/window.ts:652` and is not affected. Two reviewers filed the `/api/map` symptom separately; the overseer rejected the duplicates and they are merged here as one root cause.
- **Durable fix:** Bound both sides. **Reads:** (1) add a depth ceiling to the recursive CTE at `src/engine.ts:276-285` using the `depth` value it already computes; (2) replace the JavaScript dedup at `src/engine.ts:307-309` with `DISTINCT ON (trait.id)` plus an explicit `LIMIT` in the same statement, so the result set is bounded before it reaches Node; (3) drop or truncate `recipe` in the public place response at `src/world.ts:147`, since full recipes are already reachable through the paginated `/api/traits`; (4) give `GET /api/map` a depth bound and a page bound matching `src/window.ts:652`, and a short `Cache-Control` s-maxage. **Writes:** (5) add a `places` entry to `QUOTAS` in `src/core.ts` and spend it in the place-creation statement, following the existing note/thing pattern. Put the new ceilings next to the other hard limits in `src/physics.ts:47-56` so they are part of the frozen physics rather than ad-hoc guards.
- **Why this is not a band-aid:** Caching or paging alone would leave the underlying quadratic aggregation and the unlimited free write in place; quota alone would leave today's tree expensive forever. Bounding both sides removes the asymmetry that is the actual cause.
- **Pre-fix proof:** Two tests. (a) Against the real Postgres harness in `test/integration/`: seed one continent and a chain of 200 nested places owned by one resident, adopt 32 distinct traits per level each with a 60 KB recipe, then issue an unauthenticated `GET /api/place/<deepest id>`; assert the response body is under a stated ceiling (say 1 MB) and `place.laws.length` is under a stated ceiling. Today both fail. (b) Pure unit companion: call `effectiveLaws` with a fake tagged-SQL layer returning 32,000 synthetic rows with distinct trait ids and assert it returns within a time budget; today the dedup is quadratic. (c) Route test: register one resident and `POST /api/place` past the intended daily allowance; assert `429`. Today every call returns `201`.
- **Verification:** The tests above; the full `test/routes.test.ts`, `test/world-root.test.ts` and `test/window-viewer.test.ts` suites to confirm the map shape and window still render; and `EXPLAIN (ANALYZE, BUFFERS)` on the new bounded queries against a seeded scratch database to confirm the plan no longer reads the whole relation.
- **Regression and rollback risk:** Adding a depth bound to `/api/map` changes a public response shape — deep places will need a documented continuation mechanism, or agents that rely on the full tree will silently see less; document it in `src/frontdoor.txt`/`src/llms.txt` and regenerate `src/door.ts` (see UNS-012). A places quota is a visible new limit for residents and must be announced. Removing `recipe` from the place response is a breaking change for any client reading it — check `src/window-client.ts` first. Rollback is a code revert; no data changes.
- **Unknowns:** The current size of `places`, and therefore whether these reads are already slow in production. I had no production access.

### UNS-006: The public books endpoint shares one chain endpoint with payment verification, so anonymous traffic can make a real payer lose $1

- **Severity:** HIGH
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** CLAUDE.md hard rule 1 — payments are verified read-only on-chain; a payer who has paid must be able to prove it.
- **Location:** `src/index.ts:579-605` (`GET /treasury`), `src/chain.ts:6` and `:11-25` (the single RPC client), `src/world-support.ts:151-159` (the paid path that fails closed)
- **User or business harm:** `/treasury` is unauthenticated, has no rate limit, and sets no `Cache-Control`, so every hit reaches the origin. Each hit calls `usdcBalance(TREASURY)` against the **same** module-level RPC endpoint that `verifyDirectPayment` uses to confirm a paying agent's USDC actually landed. An anonymous flood therefore competes directly with paying customers for the RPC budget and the provider's rate limit. When the RPC stops answering, `rpc()` returns `null` (`src/chain.ts:19-24`), `verifyDirectPayment` returns `null`, and `src/world-support.ts:157-159` answers a genuine payer with `402 'payment did not verify'`. Because the direct-fee proof is only accepted within one hour, a long enough disruption turns a real, confirmed $1 USDC transfer into a total loss — the site holds no money and has no refund path. Separately, each request also aggregates the whole `fees` table: the window functions at `src/index.ts:584` are computed before the `LIMIT 50` applies.
- **Evidence:** The handler body at `src/index.ts:579-605` contains no `c.header('Cache-Control', ...)` call — compare `src/index.ts:149`, where the front door explicitly sets one — and there is no limiter middleware on the route. `src/chain.ts:6` is `const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'`, module-level, and is the only endpoint used by the single `rpc()` helper at `:11-25`, which `usdcBalance` (`:181-188`) and the payment classifiers both go through. PostgreSQL evaluates window functions after `WHERE`/`JOIN` but before `ORDER BY ... LIMIT`, so `sum(f.amount_usdc) OVER ()` forces the whole `fees` join to be materialised on every anonymous request. On `origin/main`, `GET /treasury` is at `src/index.ts:608` and the file still contains exactly one `Cache-Control` (the front door's).
- **Safe reproduction:** Not run — flooding the live endpoint is forbidden and would be the attack itself. The offline test below is the safe substitute.
- **Connection traced:** Anonymous client → `GET /treasury` (no auth, no limit, no cache) → `usdcBalance` → shared `rpc()` → provider rate limit consumed → paying agent → `POST /api/kind` → `treasuryFee` → `verifyDirectPayment` → same throttled `rpc()` returns `null` → `402 'payment did not verify'` → after one hour the payer's real on-chain $1 is unusable.
- **Root cause:** A public convenience endpoint was given no cost budget, and the read-only chain client was written as a single global endpoint with no separation between best-effort display reads and money-critical verification reads. Nothing in the code distinguishes the two classes of call, so the cheapest anonymous request in the product shares a failure domain with the most valuable one.
- **Connections and similar locations checked:** `GET /oauth/authorize` also triggers an outbound client-metadata fetch before any rate limit is charged (recorded separately in Questions as a lower-impact instance of the same "anonymous request causes outbound network work" pattern). `src/window.ts:730-741` already memoises the window snapshot behind a TTL, which is the pattern this endpoint should follow. No other route calls `usdcBalance`.
- **Durable fix:** (1) Memoise the treasury balance behind a short server-side TTL and a public `Cache-Control` s-maxage, exactly as `src/window.ts:730-741` already does — the on-chain balance does not need to be fresher than 30-60 seconds, and the endpoint's own text already tells readers to verify on-chain themselves. (2) Rewrite the fees query so the totals come from a separate scalar aggregate or a maintained counter instead of window functions over an unbounded join, and index accordingly. (3) Split the chain client: give display reads their own endpoint or key, or a strict concurrency budget, so they can never starve verification reads, and let the display path fail silently rather than sharing the verification budget. (4) Add a small per-IP limiter to the unauthenticated read routes that trigger outbound network calls.
- **Why this is not a band-aid:** Caching alone reduces the frequency but leaves the shared failure domain, so any other burst still starves verification. Splitting the client removes the coupling itself.
- **Pre-fix proof:** Using the repository's existing fetch-fake RPC harness, install a fake that counts outbound `eth_call` requests, then issue 25 anonymous `GET /treasury` requests through `app.fetch`. Assert (a) at most one outbound RPC call and (b) the response carries a `Cache-Control` header with a non-zero s-maxage. Today the count is 25 and (b) fails. Pair it with a SQL test in the Postgres harness: seed 50,000 `fees` rows, run the exact query text from `src/index.ts:582-589` under `EXPLAIN (ANALYZE, BUFFERS)`, and assert the plan does not read the whole `fees` relation; today it must.
- **Verification:** The tests above; `test/routes.test.ts` for the `/treasury` response shape; and a manual check that the books page still shows a correct balance and total after memoisation.
- **Regression and rollback risk:** A cached balance is by definition slightly stale, which matters for a page whose whole purpose is public trust — state the cache age in the response so readers know. Splitting the RPC endpoint needs a second `BASE_RPC_URL`-style setting added in every environment before the code ships, or display reads will fail; ship the setting first, the code second. Rollback is a code revert.
- **Unknowns:** Which provider `BASE_RPC_URL` points at and what its throttling policy is — the environment files are out of contract, so the *magnitude* of the payment disruption is reasoned, not measured. The coupling, the missing cache and the per-request full-table aggregate are all certain from the code.

### UNS-007: A label written onto someone else's place never expires

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** CLAUDE.md bedrock right — "every block expires"; `docs/SPEC.md` requires spreading and imposed effects to burn out.
- **Location:** `src/engine-effects.ts` label brick (`INSERT INTO active_labels`, `origin/main:249-257`), against `db/schema.sql` `active_labels`
- **User or business harm:** Any visitor who can act in a place can write a permanent word onto another resident's property, and the owner has no route to remove it. The bedrock rights are the product's core promise — they are the four things that sit above every local law — so a permanent imposed label is a direct violation of the world's own constitution, not merely an annoyance. Labels are also read by `check_label`, so a permanent label can permanently alter how other agents' programs behave in that place (and see UNS-004 for how that authority is obtained).
- **Evidence:** The insert lists exactly `target_type, target_id, label, actor_id, source_trait_id, source_place_id, source_thing_id` and supplies no `expires_at` value, while the sibling `active_blocks` path does carry an expiry. Nothing else in `src/engine-effects.ts` sets `expires_at` on a label, and no route deletes an `active_labels` row. Present unchanged on `origin/main`.
- **Safe reproduction:** Not run — requires a live database. The test below reproduces it offline against the schema.
- **Connection traced:** Visitor B uses a thing whose recipe contains the `label` brick, targeting resident A's place → row inserted into `active_labels` with no expiry → `GET /api/place/:id` reports the label indefinitely → A has no endpoint that removes it.
- **Root cause:** The expiry invariant was implemented per-brick rather than enforced by the storage layer, so a brick that simply omits the column silently opts out of a bedrock right.
- **Connections and similar locations checked:** `active_blocks` does set an expiry, which is why the `block` brick complies. I checked for a delete or expiry-sweep path for `active_labels` in `src/engine*.ts`, `src/world.ts` and `src/laws.ts` and found none; moderation (`src/moderation-store.ts`) is a redaction overlay and does not remove the row.
- **Durable fix:** Make the storage layer enforce the right rather than each brick. Add `expires_at TIMESTAMPTZ NOT NULL` to `active_labels` with a `CHECK (expires_at > created_at)` and a maximum duration, so any brick that omits it fails at insert time instead of silently creating a permanent effect; then set it from the same bounded duration the `block` brick uses. Have every reader filter on `expires_at > now()`, matching the block path.
- **Why this is not a band-aid:** A `NOT NULL` column makes the invariant structural — a future brick cannot reintroduce the same omission — whereas adding an expiry only at this one call site leaves the pattern repeatable.
- **Pre-fix proof:** Engine test: have B apply a label to A's place, then advance the harness clock past the maximum effect duration and assert `GET /api/place/A` no longer reports the label, and that `check_label` for it evaluates false. Today the label persists forever. Add a schema test in the style of `test/migrate.test.ts` asserting that an `active_labels` insert without `expires_at` is rejected.
- **Verification:** The tests above; `test/engine.test.ts` and `test/engine-scope.test.ts` in full; and `test/integration/engine-timer-postgres.test.ts` for the expiry sweep.
- **Regression and rollback risk:** Existing `active_labels` rows have no expiry and the column is `NOT NULL`, so the migration must backfill a value — backfilling `created_at + max_duration` quietly expires old labels, which changes live world state and may break agent programs that depend on them; announce it in the public record first. Follow UNS-011 and include `lock_timeout`/`statement_timeout`. Rollback after backfill cannot restore permanence, so treat the backfill as one-way.
- **Unknowns:** How many permanent labels already exist in production and whose places they sit on. That needs a production query.

### UNS-008: The human window silently hides every market sale, listing and cancellation

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** CLAUDE.md hard rules 4 and 6 — humans watch through the glass; public books and an honest public record.
- **Location:** `src/window-client.ts:14-41` (`PUBLIC_EVENT_LABELS`) with the unknown-kind drop at `src/window-client.ts:240-242`; event writers at `src/world-market.ts:756-762`, `:1164-1172`, `:1360-1367`
- **User or business harm:** The world-aisle bridge writes `world_listed`, `world_sale` and `world_cancel` events into the public ledger, but the window's client-side label map does not contain them and the client drops any event kind it does not recognise. So the one surface humans are given to watch the city shows every other kind of activity while silently omitting exactly the events where money changed hands and ownership moved. The bridge is the newest and most consequential surface in the product; a watcher cannot see it work or fail. This also undercuts the design's central claim that reputation and the public record substitute for enforcement — the record exists, but the window does not show it.
- **Evidence:** I grepped `src/window-client.ts` for `world_listed`, `world_sale` and `world_cancel` and found **no matches**; the same grep against `origin/main:src/window-client.ts` also returns zero. The events are definitely written — `src/world-market.ts` inserts all three kinds at the lines above. `src/window-client.ts:240-242` drops unlabelled kinds rather than rendering a fallback.
- **Safe reproduction:** Not run in a browser — no live page was loaded, by contract. The absence is deterministic from the grep plus the drop behaviour.
- **Connection traced:** Seller lists a thing → `world_listed` event written → window client receives the event → kind is absent from `PUBLIC_EVENT_LABELS` → `src/window-client.ts:240-242` drops it → human watcher sees nothing. Identical for `world_sale` (money moved, ownership transferred) and `world_cancel`.
- **Root cause:** The event label map is a hand-maintained allow-list in the browser client, decoupled from the server-side list of event kinds, so any new event kind is invisible by default and nothing fails when the two drift.
- **Connections and similar locations checked:** `src/window.ts:39` and `:355-358` define `SAFE_EVENT_KINDS` on the server, and `SAFE_DETAIL_IDS` at `:52-70` projects details — the server side does handle these kinds; the gap is purely client-side. I checked the other recently added kinds against the label map for the same drift.
- **Durable fix:** Remove the possibility of silent drift rather than just adding three strings. Derive the client's label map from the server's `SAFE_EVENT_KINDS` (ship it in the page payload or generate the client constant from the same source), and make an unknown kind render a plain generic line rather than disappear. Add a test that asserts every kind in the server's list has a client label.
- **Why this is not a band-aid:** Adding the three missing labels fixes today's symptom; the next event kind added would vanish the same way. Making the drift impossible, and making the failure visible rather than silent, removes the cause.
- **Pre-fix proof:** Test in the style of `test/window-viewer.test.ts`: enumerate the server's `SAFE_EVENT_KINDS` and assert every one has an entry in the client's label map. Today it fails naming `world_listed`, `world_sale`, `world_cancel`. Companion: feed the client an event of an unknown kind and assert a generic line is rendered rather than the event being dropped.
- **Verification:** The tests above; the full `test/window-viewer.test.ts` and `test/round2-surfaces.test.ts`; and `e2e/public-window-interactions.spec.ts` run separately (it writes `test-results/`, so run it outside any sealed audit).
- **Regression and rollback risk:** Rendering previously dropped kinds means new text reaches the human page — that text is agent-authored and untrusted, so it must go through the same escaping and moderation projection as existing events; verify against `src/window-client-safety.ts` before shipping. Rollback is a code revert.
- **Unknowns:** None material.

### UNS-009: x402 purchases are granted on the payment facilitator's word alone, with no on-chain read

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** CLAUDE.md hard rule 1 — "All payments wallet-to-wallet, verified **read-only on-chain**."
- **Location:** `src/world-support.ts:123-133` (fee x402 branch), `src/pay.ts` (`settleX402`), against the direct branch at `src/world-support.ts:151-163` which does read the chain
- **User or business harm:** For the x402 path the server grants the continent, the kind, or the sale purely on the facilitator's settlement response; `src/chain.ts` is never consulted. If the facilitator is wrong, compromised, or impersonated, the city grants paid, irreversible, globally unique property for a payment that never settled — and the product's own stated rule, published on the front door and in `docs/`, says the opposite is true. The gap is between what the product promises publicly and what the code does, which is a trust and arguably a representation problem as much as a technical one.
- **Evidence:** `src/world-support.ts:123-133` is the whole x402 acceptance: `const settled = await settleX402(paymentHeader, accepted)` / `if ('error' in settled) return challenge402(...)` / `if (!WALLET_RE.test(settled.payer)) return challenge402(...)` / `return { txHash: settled.transaction, payerWallet: settled.payer.toLowerCase(), settled }`. There is no call into `src/chain.ts` on this branch — contrast lines 151-156, where the direct branch calls `verifyDirectPayment` against the RPC. Present unchanged on `origin/main`.
- **Safe reproduction:** Not run — would require a real x402 settlement. The absence of any chain call on this branch is deterministic from the code.
- **Connection traced:** Caller supplies `X-PAYMENT` → `settleX402` → facilitator returns a settlement claim → server accepts `settled.transaction` and `settled.payer` verbatim → `payment_uses` row written → paid property granted. No RPC read occurs anywhere on this path.
- **Root cause:** Two payment rails were implemented with two different trust models, and only one of them matches the published rule. The x402 rail treats the facilitator as authoritative because that is what the protocol makes easy, and nothing reconciles its claim against the chain afterwards.
- **Connections and similar locations checked:** `src/world-market.ts` has a genuine reconciliation path for pending x402 (`:1213`) that does consult evidence, showing the pattern exists in the codebase; the treasury fee path has no equivalent. The direct `fee_tx_hash` branch does read the chain (though see UNS-001 for its separate authorization flaw).
- **Durable fix:** Reconcile every x402 settlement against the chain before the grant is final. Either (a) verify `settled.transaction` with the same `classifyDirectPayment` call the direct branch uses — requiring correct recipient, amount and finality — before writing `payment_uses`, or (b) if the latency is unacceptable, grant provisionally, record the grant as `payment_pending`, and run the existing reconciliation to confirm or reverse it, mirroring `src/world-market.ts:1213`. Whichever is chosen, update `src/frontdoor.txt`, `src/llms.txt` and `docs/` so the published rule matches the code.
- **Why this is not a band-aid:** It closes the gap between the stated guarantee and the implementation, rather than restating the guarantee. Option (b) is explicitly the pattern the repository already uses elsewhere for exactly this problem.
- **Pre-fix proof:** Dependency-injected test: supply a fake `settleX402` that returns a well-formed successful settlement for a transaction the fake RPC does **not** show on chain, then `POST /api/kind` with an `X-PAYMENT` header. Assert after the fix that no kind is created and the response is `402`; today the kind is created. Companion: a settlement whose on-chain transfer went to the wrong recipient must also be refused.
- **Verification:** The tests above; `test/chain-classification.test.ts` and `test/world-market.test.ts` in full; and a manual end-to-end x402 purchase on a testnet before production.
- **Regression and rollback risk:** Adding a chain read to the x402 path increases latency for every paid action and couples it to the same RPC discussed in UNS-006 — fix UNS-006's client split first, or this change makes the starvation worse. Option (b) introduces a new pending state that the sibling market must understand; coordinate with 1f3ea before shipping. Rollback is a code revert.
- **Unknowns:** Whether the facilitator in use provides its own on-chain attestation that would satisfy the published rule. That depends on the configured facilitator, which lives in environment settings I did not read.

### UNS-010: Any signed-in resident can write unlimited permanent rows into the public record

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** Daily action quotas are the mechanism that gives the world its days (CLAUDE.md hard rule 5); the public record is the product's substitute for enforcement.
- **Location:** `src/index.ts:516-548`, guard at `:528`; `src/core.ts:10` (`QUOTAS`); `db/schema.sql:1312-1321` and `:1373-1376` (append-only triggers)
- **User or business harm:** `POST /api/flag` is the only mutating route whose limiter is conditional on being anonymous: `if (!resident && !(await takeAnonymousFlagSlot(c)))`. Because of the short-circuit, an authenticated caller never touches the 5-per-IP-per-hour bucket, and `QUOTAS` has no flag entry, so no daily counter applies either. Registration costs nothing beyond a 3-per-IP-per-hour throttle. Each call writes a `flags` row carrying up to 4000 bytes and an `events` row; both tables are append-only by trigger, so nothing — including the founder's moderation powers — can remove them. The five-line RECENT ACTIVITY block the front door renders (`src/index.ts:152-164`), the first thing an arriving agent reads about the city, can be pinned to one attacker's flags indefinitely, and `GET /api/events` becomes dominated by them.
- **Evidence:** `src/index.ts:528` is `if (!resident && !(await takeAnonymousFlagSlot(c)))` — I confirmed the identical guard on `origin/main` at `src/index.ts:557`, with the limiter defined at `:94`. `src/core.ts:10` is `export const QUOTAS = { things: 20, notes: 50, agreements: 5 } as const`, identical on `origin/main`. `src/index.ts:532-544` inserts the flag row and the public event unconditionally. `db/schema.sql:1373-1376` attaches `deny_history_mutation` to both `flags` and `events`. A reviewer grepped `src/index.ts` for every `app.use` and every limiter symbol: the only middlewares are two `cors()` calls and a header setter.
- **Safe reproduction:** Not run against a live server. The route test below reproduces it offline.
- **Connection traced:** Attacker registers (free) → `POST /api/flag` in a loop with a valid target → each call writes a permanent `flags` row and a permanent `events` row → front door RECENT ACTIVITY and `GET /api/events` fill with the attacker's entries → no route can remove them.
- **Root cause:** The limiter answers "who is this anonymous caller?" rather than "how much may any caller write?". Authentication was treated as sufficient accountability, but a resident key is free and effectively unlimited in supply, so authentication carries no cost and therefore no restraint. The three routes with quotas (notes, things, agreements) show the intended pattern; flags were left out of it.
- **Connections and similar locations checked:** Place creation and trait coining are also free and unquota'd — merged into UNS-005, which shares the same root cause on the read side. Notes, things and agreements are correctly quota'd. This is the only route whose limiter is *conditional on being unauthenticated*, which is why it is filed separately.
- **Durable fix:** Charge every flag against a bound regardless of authentication. Add a `flags` entry to `QUOTAS` in `src/core.ts` with a matching `flags_today` column refreshed alongside the others in `residentBySecret`, and spend it inside the same statement that inserts the flag, following the note pattern in `src/note-action.ts:35-39`. Keep the anonymous IP bucket as an *additional* bound for unauthenticated callers rather than the only bound. Separately, consider not emitting a public event for every flag: the route already declines to publish the report text, and a per-target deduplicated event would serve the same transparency purpose without handing one caller a megaphone.
- **Why this is not a band-aid:** It removes the assumption that authentication implies restraint, which is the actual defect, rather than tightening the anonymous bucket that authenticated callers never reach.
- **Pre-fix proof:** Route test with the existing harness: register one resident, then `POST /api/flag` 12 times with a valid target and distinct reasons. Assert that calls beyond the allowance return `429` with a quota message; today all 12 return `201`. Then `GET /api/events?kind=flag` and assert at most the allowance appears; today 12 do. Add a front-door assertion: after those posts, `GET /` and assert the RECENT ACTIVITY block is not composed solely of that one actor's flag lines.
- **Verification:** The tests above; `test/routes.test.ts` and `test/moderation.test.ts` in full; and a check that anonymous flagging still works within its existing bucket.
- **Regression and rollback risk:** A daily flag quota could suppress legitimate bulk reporting during a real abuse incident — pick the allowance with that in mind and give the founder an unquota'd path. Adding `flags_today` needs a migration; follow UNS-011. Rollback is a code revert plus leaving the column unused.
- **Unknowns:** How many flag rows already exist and whether the front door is currently affected. That needs production data.

### UNS-011: The production pagination migration drops the lock and statement timeouts its sibling migrations carry

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** The project's own established migration pattern — its two sibling migrations from the same day both set `lock_timeout` and `statement_timeout` inside a transaction.
- **Location:** `db/migrations/20260814_public_pagination.sql:1-26`, against `db/migrations/20260814_world_root_expand.sql:1-6` and `db/migrations/20260814_world_root_topology.sql:1-7`
- **User or business harm:** The migration issues ten non-concurrent `CREATE INDEX` statements against `places`, `things`, `kinds`, `notes`, `events` and `transfer_offers` — the busiest tables in the product — with no transaction wrapper, no `lock_timeout` and no `statement_timeout`. A non-concurrent `CREATE INDEX` blocks all writes to its table for the duration. Against a live production database with a large `events` or `notes` table, that is an unbounded write outage on the whole city with no automatic bail-out, and there are `npm run migrate:production:public-pagination` scripts wired to run it.
- **Evidence:** I read all four migration files and grepped each for `lock_timeout`, `statement_timeout`, `CONCURRENTLY`, `BEGIN;` and `COMMIT;`. `20260814_world_root_expand.sql` has `BEGIN;` at line 1, `SET LOCAL lock_timeout = '2s'` at line 5, `SET LOCAL statement_timeout = '30s'` at line 6, `COMMIT;` at line 37. `20260814_world_root_topology.sql` has the same at lines 1, 6, 7 and 278. `20260814_public_pagination.sql` contains **none** of those five tokens — it is ten bare `CREATE INDEX IF NOT EXISTS` statements, the first at line 3 and the last at line 24, with no `CONCURRENTLY`.
- **Safe reproduction:** Not run — executing a migration is forbidden. The absence is deterministic from reading the four files; the comparison command and its output are recorded above.
- **Connection traced:** Operator runs `npm run migrate:production:public-pagination` → `scripts/migrate.ts` applies the file → `CREATE INDEX` on `events` takes a lock that blocks writes → every agent action that appends an event stalls → no `lock_timeout` fires, so the stall lasts as long as the build takes.
- **Root cause:** The safety preamble is copied per-file by hand rather than applied by the runner, so a new migration silently opts out of the protection by omission.
- **Connections and similar locations checked:** `20260813_hosted_chat_signin.sql` also lacks the preamble, but it is additive table creation rather than indexing existing hot tables, so its exposure is much smaller — the same fix covers it. I read `scripts/migrate.ts` and it does not inject timeouts itself.
- **Durable fix:** Move the guarantee into the runner instead of the file. Have `scripts/migrate.ts` apply `SET LOCAL lock_timeout` and `statement_timeout` around every migration it runs, so no future file can omit them, and add a check that refuses a production migration containing a non-concurrent `CREATE INDEX` unless it is explicitly acknowledged. Then rewrite this migration to use `CREATE INDEX CONCURRENTLY` (which cannot run inside a transaction and must be applied statement-by-statement with its own retry, so the runner needs to understand that mode).
- **Why this is not a band-aid:** Adding the preamble to this one file fixes this migration; putting it in the runner makes the class of mistake impossible, which is what the two sibling files show was intended all along.
- **Pre-fix proof:** Extend `test/deploy-safety.test.ts`, which already asserts properties of migration files (see "public pagination indexes are an explicitly selected additive release"). Add an assertion that every file in `db/migrations/` either sets both `lock_timeout` and `statement_timeout`, or uses `CREATE INDEX CONCURRENTLY` exclusively. Today it fails, naming `20260814_public_pagination.sql`.
- **Verification:** The test above; the full `test/migrate.test.ts` and `test/deploy-safety.test.ts`; and a rehearsal of the migration against a seeded scratch database with concurrent writers, measuring the write stall.
- **Regression and rollback risk:** `CREATE INDEX CONCURRENTLY` can leave an invalid index behind if it fails, which then needs a manual drop — the runner must detect and report that rather than continuing. If this migration has already been applied to production, do not re-run it; fix the runner and the file for the next one and verify the existing indexes are valid.
- **Unknowns:** Whether this migration has already been run against production, and the current row counts of `events` and `notes`, which set the real outage length. Both need production access.

### UNS-012: A generated file was hand-edited, so regenerating it will silently delete published API documentation

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** `src/door.ts:1` — "GENERATED by scripts/embed-door.mjs — edit src/frontdoor.txt / src/llms.txt instead."
- **Location:** `src/door.ts:312` and `src/door.ts:333` (hand-edited generated content) versus `src/llms.txt:22` and `src/llms.txt:43` (the source of truth); test at `test/help-text.test.ts:65`
- **User or business harm:** `src/door.ts` is generated from `src/frontdoor.txt` and `src/llms.txt`, and its `LLMS` constant is served verbatim at `GET /llms.txt` — the compact machine map every arriving agent is told to read. Someone edited the generated file directly to document the new pagination behaviour instead of editing the source. The next time anyone runs `node scripts/embed-door.mjs`, `door.ts` is rebuilt from the stale `llms.txt` and that documentation vanishes from what agents read, with no error. Meanwhile the repository's own test suite is red on this exact drift, which means `npm test` fails — and `scripts/deploy.sh:160` gates the release on `npm test`, so the drift also blocks the deploy path.
- **Evidence:** `npm test` (EVD-003) fails `canonical and generated discovery text stays synchronized` at `test/help-text.test.ts:65`, whose assertion is `assert.equal(normalizeLines(LLMS), normalizeLines(llms))`. The diff shows two lines present in `door.ts` and absent from `llms.txt`: the `` `limit` applies to every list `` clause and the `truncated responses also say so plainly` clause. `git hash-object` (EVD-005) confirms `src/door.ts` differs from `HEAD` while `src/llms.txt` does not, so the edit is local and uncommitted. `scripts/embed-door.mjs` reads `src/frontdoor.txt` and `src/llms.txt` and overwrites `src/door.ts` wholesale. **This one is local only:** on `origin/main` neither `door.ts` nor `llms.txt` contains those lines, so `main` is self-consistent (EVD-010).
- **Safe reproduction:** Reproduced by running the existing suite: `npm test` fails deterministically at `test/help-text.test.ts:65`. I did not run `scripts/embed-door.mjs`, because doing so would have written to a sealed project file.
- **Connection traced:** Hand edit to `src/door.ts` → `LLMS` constant now contains pagination text → `src/index.ts:169` serves it at `GET /llms.txt` → `src/llms.txt` still lacks it → `test/help-text.test.ts:65` fails → `npm test` exits 1 → `scripts/deploy.sh:160` gate fails. And later: anyone runs `embed-door.mjs` → `door.ts` regenerated from stale source → the pagination documentation silently disappears from `/llms.txt`.
- **Root cause:** A generated artifact is committed and editable, and nothing prevents editing it. The generator is manual, and the only thing catching the drift is a test that is currently just failing rather than blocking anything.
- **Connections and similar locations checked:** `FRONTDOOR` is generated the same way and is currently **in sync** — `src/frontdoor.txt` matches, so only the `LLMS` half drifted. `package.json` has no script that regenerates `src/door.ts`, and no hook runs `embed-door.mjs`, so nothing enforces the relationship except the test.
- **Durable fix:** Decide which file is the artifact and stop shipping the other by hand. Preferred: stop committing `src/door.ts`; generate it in the build (add a `prebuild`/`pretest` step running `scripts/embed-door.mjs`) so the source text is the only editable copy. If it must stay committed, add a `pretest` step that regenerates it and fails if the working copy differs, so the drift is caught at the moment it is introduced rather than by a test that reports a confusing text diff. Then port the two pagination sentences into `src/llms.txt` and regenerate.
- **Why this is not a band-aid:** Copying the two lines into `llms.txt` makes today's test pass and leaves the generated file hand-editable, so the same drift recurs. Removing the hand-editable copy removes the cause.
- **Pre-fix proof:** Already failing: `npm test` → `canonical and generated discovery text stays synchronized` at `test/help-text.test.ts:65`. That is the pre-fix proof; it must pass after the fix, and a new assertion should confirm that running `embed-door.mjs` produces no change to the working tree.
- **Verification:** `npm test` green (all 313), `npm run typecheck` green, and a manual diff of `GET /llms.txt` output against `src/llms.txt` after regeneration.
- **Regression and rollback risk:** Regenerating from the stale source **deletes** the pagination documentation, so port the two sentences into `src/llms.txt` *before* running the generator, not after. If `src/door.ts` stops being committed, the Vercel build must run the generator or the deployment ships without a front door — verify the build step before removing the file.
- **Unknowns:** Whether the two pagination sentences were intended for `main` at all, or were a local experiment. `main` has neither, so someone must decide; noted in Questions.

### UNS-013: Production credential files and production database dumps sit unignored in the working directory

- **Severity:** LOW
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Secrets must never be committable to a public repository or uploadable to a deployment (project security rules; the repo is public and AGPL-3.0).
- **Location:** `.gitignore:1-16` versus the root working directory: `.tmp-prod-env`, `.tmp-production.env`, `.tmp-preview.env`, `.release-backups/20260814-world-root/prod-pre-world-root.dump`, `.release-backups/20260814-world-root/pre-world-root.sql`, and the absence of any `.vercelignore`
- **User or business harm:** Three files whose names indicate production and preview environment settings, plus a 1.4 MB production database dump and a 4.7 MB production SQL snapshot, sit in the working directory of a **public** repository and are matched by no `.gitignore` pattern. If they were ever added to a normal (non-bare) checkout of this project and pushed, production credentials and a production data snapshot would be published irreversibly. There is also no `.vercelignore`, so a manual `npx vercel deploy` from this directory would upload them into a deployment bundle along with roughly 700 files from seven nested worktrees.
- **Evidence:** `.gitignore` contains `env.txt`, `.env`, `.env.*`, `.env*`, `.vercel`, `node_modules/`, `coverage/`, `playwright-report/`, `test-results/` and (locally) `backups/`. The patterns `.env*` and `.env.*` match on the basename, and `.tmp-prod-env`, `.tmp-production.env` and `.tmp-preview.env` all begin with `.tmp`, so none of them is matched; `.release-backups/` is matched by nothing. A directory listing of the root confirms no `.vercelignore` exists. I did not open any of these files. **Two things materially reduce this, and both are why it is LOW rather than HIGH:** (1) the project root is a **bare** git repository (`core.bare=true`, EVD-006), so `git add` cannot be run there at all and the nested worktrees cannot reach files in their parent — the accidental-commit path is effectively closed today; (2) on `origin/main`, `scripts/deploy.sh` has been rewritten so releases go through a GitHub pull request and Vercel's GitHub integration, and it states explicitly that the helper "never uploads a local folder" (EVD-011) — so the upload path is closed upstream too.
- **Safe reproduction:** Not applicable — reproducing the harm would mean committing or uploading secrets. Verified statically by pattern analysis against a directory listing; no file contents were read.
- **Connection traced:** Secret-bearing file in repo root → matched by no `.gitignore` pattern → would be staged by `git add -A` in any *non-bare* clone or checkout of this working directory, or uploaded by a bare `npx vercel deploy` run here → published to a public repository or into a deployment bundle.
- **Root cause:** Ad-hoc temporary files were created with names outside the established ignore conventions, and the ignore file enumerates specific names rather than expressing the intent "nothing that holds an environment or a database dump leaves this machine".
- **Connections and similar locations checked:** `env.txt`, `.env.local`, `.env.deploy`, `backups/` and `.vercel/` **are** correctly ignored. `.tmp_1f3d9_home.txt`, `.tmp_citylife_readme.md`, `.tmp_citylife_skill.md` and a zero-byte file literally named `=` are also unignored but do not appear to hold secrets. The local `.gitignore` differs from `HEAD` only by the addition of `backups/` (EVD-005), which is a good change that is not yet committed.
- **Durable fix:** Broaden the ignore rules to express intent, then remove the files. Add `.tmp*`, `*.env`, `.release-backups/`, `*.dump` and `*.sql.gz` to `.gitignore`, and commit the `backups/` line that is currently only local. Add a `.vercelignore` that allow-lists what a deployment actually needs (`api/`, `src/`, `package.json`, `vercel.json`) rather than denying what it does not, so a manual deploy can never sweep up an unanticipated file. Then delete the temporary environment files and move the production dumps off this machine to wherever backups are meant to live.
- **Why this is not a band-aid:** Naming these five files in `.gitignore` protects against exactly these five files. Broadening to the pattern, plus an allow-list `.vercelignore`, covers the next temporary file too — and the next one is the one that will get committed.
- **Pre-fix proof:** Deterministic check rather than a test, because a failing test would require staging a secret. Run `git check-ignore -v` (from a non-bare worktree) against each of the five paths and assert every one is ignored; today `.tmp-prod-env`, `.tmp-production.env`, `.tmp-preview.env` and both `.release-backups/` files report no matching pattern. Add a repository test that asserts `.gitignore` matches a list of sensitive-name patterns.
- **Verification:** Re-run the check above for all five paths; confirm `.vercelignore` exists and that `npx vercel deploy --prebuilt` in dry-run lists only the intended files; confirm the production dumps have been relocated and the temporary env files deleted.
- **Regression and rollback risk:** An over-broad `.tmp*` rule could hide a file someone intends to track — check nothing currently tracked matches before committing. An allow-list `.vercelignore` risks omitting a file the build needs; verify a preview deployment before relying on it in production. Deleting the production dumps is irreversible, so confirm a copy exists elsewhere first.
- **Unknowns:** Whether any of these files was ever pushed from a different, non-bare clone on this or another machine. Checking that means scanning the public repository's history, which needs network access I did not use.

## Questions Needing Human Review

These are E1 leads and open decisions. **They are not defects.** Each names the missing evidence.

1. **Is the audited directory the thing you actually care about?** This working tree is
   `codex/hosted-chat-signin` @ `1303a14`, which is ~20 commits behind `origin/main` @ `09b1cb5`;
   `git diff HEAD origin/main -- src test db scripts docs api` reports **51 files, +3652/-717**. I
   re-verified every admitted finding against `origin/main` and all are present, so nothing here is
   a stale report. But the reverse is untested: roughly 3,600 lines of newer upstream code —
   including `test/runtime-db-url.test.ts`, `test/schema.test.ts`,
   `test/reconciliation-contract.test.ts` and `test/integration/world-postgres.test.ts`, none of
   which exist here — were **not audited at all**. *Missing evidence:* an audit of `origin/main`
   itself. *Safest next check:* re-run this audit against a clean `origin/main` checkout.
   *Should release wait?* Yes for the findings above; the upstream gap is a coverage question, not a
   defect.
2. **Was the `--prepare` deploy stub meant to be permanent here?** `scripts/deploy.sh` has an
   uncommitted `exit 2` prepended at lines 2-3 telling the operator to "Pull GitHub main and use
   `scripts/deploy.sh --prepare`" — but *this* file rejects all arguments at line 133, so the
   instruction cannot be followed with the file it is printed by. `--prepare` exists only on `main`.
   Two `deploy-safety` tests still assert the behaviour of the now-unreachable script body and fail
   (EVD-003, EVD-011). *Missing evidence:* your intent. *Safest next check:* pull `main`, where the
   script and its tests agree. *Should release wait?* No, but `npm test` stays red until this and
   UNS-012 are resolved.
3. **Do the two pagination sentences belong on `main`?** UNS-012's fix depends on the answer:
   `main` has them in neither `door.ts` nor `llms.txt`. *Missing evidence:* whether the local edit
   was an experiment or a real intent. *Safest next check:* ask whoever made the edit; the file
   mtime is 2026-08-15 08:01. *Should release wait?* No.
4. **Is `skills-lock.json` enforced by anything?** Its two `computedHash` values match neither the
   working files, nor an LF-normalised version, nor the committed blobs (EVD-009), and **no file in
   the repository reads `skills-lock.json`** — I grepped all sources. So either the hash is produced
   by a scheme I do not know, or the lock has silently drifted. Either way it currently provides no
   protection for two vendored third-party skill files. *Missing evidence:* which tool wrote those
   hashes. *Safest next check:* re-run that tool and diff. *Should release wait?* No.
5. **Does `scripts/restore-key.mjs` leave a live bearer secret on disk indefinitely?** It writes a
   new resident secret to `backups/key-<handle>.txt` (`:69-71`) and only *tells* the operator to
   delete it afterwards; the pruner in `scripts/backup.mjs:80` matches `1f3d9-*.json` and so never
   removes it, and the `mode: 0o600` it sets has little effect on Windows. It also rotates a
   resident's key with no public event, unlike `POST /api/rotate`. Both scripts are **untracked** —
   they exist only on this machine and are in no commit. *Missing evidence:* whether stale key files
   are currently sitting in `backups/`, which I did not list by contract. *Safest next check:* list
   `backups/key-*.txt` yourself and delete any found. *Should release wait?* No, but commit both
   scripts — losing this disk currently loses your backup and key-recovery tooling.
6. **A direct `tx_hash` payment made inside a reservation is permanently unusable if the request
   lands after `reserved_until`.** This is the sibling of UNS-002 on the non-x402 rail; reviewers
   rated it E2 because the exact race window depends on runtime timing I could not measure.
   *Missing evidence:* observed request timings. *Safest next check:* the same harness test as
   UNS-002, with a direct payment. *Should release wait?* Fix it with UNS-002.
7. **`GET /oauth/authorize` performs an outbound 4-second client-metadata fetch before any rate
   limit is charged**, and the metadata body read escapes both the documented time and size budgets
   when the response is chunked. Reviewers rated both E2/LOW. *Missing evidence:* whether
   `HOSTED_CHAT_SIGNIN_ENABLED` is `true` in production, which decides whether the route is live at
   all. *Safest next check:* check the production setting. *Should release wait?* No.
8. **Reviewer disagreements left open.** The final overseer rated UNS-001 HIGH; I considered
   BLOCKER, since it causes direct financial loss to customers and irreversibly mis-grants unique
   paid property. I kept the overseer's HIGH rather than override an independent reviewer, and
   record the disagreement here — treat UNS-001 as release-stopping in practice regardless of the
   label. The overseer also rated UNS-011 E2 where I recorded E3, because I personally read all four
   migration files and the absence is deterministic; the *magnitude* of the outage remains unknown.
9. **`src/engine.ts:53-86` transaction handling was flagged but never reached E2.** The `ROLLBACK`
   at `:81` is itself unguarded and `client.release()` at `:84` is called without an error argument,
   so a client left in an aborted transaction may return to the pool (max 5 per instance, never
   closed). *Missing evidence:* runtime behaviour under a failing transaction. *Safest next check:*
   a test that forces an error mid-transaction and then asserts the next pooled query succeeds.
   *Should release wait?* No, but it deserves its own investigation.
10. **The Postgres integration tests apply `db/schema.sql` and never the migration files**, so every
    schema-derived conclusion in this report — including my own citations of the append-only
    triggers — describes the *intended* schema, not necessarily the live one. *Missing evidence:* a
    diff of production's actual schema against `db/schema.sql`. *Safest next check:* dump the
    production schema and compare. *Should release wait?* No, but do it before UNS-003's, UNS-007's
    or UNS-010's migrations.

## Ordered Repair Plan

Do these in order. Steps 1-2 are prerequisites for everything else.

1. **Get the tree honest first.** Pull `origin/main`. Decide deliberately what to do with the three
   uncommitted edits (`.gitignore` — keep, it is an improvement; `scripts/deploy.sh` — drop, `main`
   supersedes it; `src/door.ts` — do not keep, see UNS-012). Commit the untracked
   `scripts/backup.mjs` and `scripts/restore-key.mjs`. Write every fix below against `origin/main`,
   not against this checkout.
2. **Get `npm test` green (UNS-012).** Port the two pagination sentences into `src/llms.txt` if they
   are wanted, regenerate `src/door.ts` with `scripts/embed-door.mjs`, and move generation into the
   build. Until this passes, no release gate can tell you anything.
3. **Contain the active money exposure (UNS-001)** without destroying evidence. Before changing
   code, query the public `events` ledger and `payment_uses` against the on-chain sender for each
   recorded `tx_hash` to find out whether this has already been exploited. Then add the failing test
   from UNS-001, then add the server-issued fee reservation. Update the front door, `llms.txt` and
   the MCP tool descriptions in the same change, and keep the old path alive for one hour after
   deploy so in-flight payers do not lose money.
4. **Close the other two "did everything right and still lost" paths: UNS-002 and UNS-003.** Take
   them together — both are money/identity trust failures. UNS-002 needs the settlement budget in
   `src/pay.ts` plus the pre-settlement window check in both `world-market.ts` and `society.ts`;
   UNS-003 needs the `secret_generation` column, applied to `scripts/restore-key.mjs` as well as the
   route. Question 10 above (schema drift) should be answered before UNS-003's migration runs.
5. **Fix the migration runner (UNS-011) before running any migration from step 4 or 6.** Put
   `lock_timeout`/`statement_timeout` in `scripts/migrate.ts` so no future file can omit them.
6. **Restore the world's own rules: UNS-004 then UNS-007.** UNS-004 first — it is the one that
   destroys property. Search `kind_revisions.recipe` for affected programs before shipping, and
   announce the change in the public record. UNS-007's backfill is one-way; announce it too.
7. **Bound the unbounded: UNS-005, UNS-006, UNS-010.** Fix UNS-006's RPC client split before
   UNS-009, or adding a chain read makes starvation worse. Do the read-side bounds and the write-side
   quotas in one change so the asymmetry does not reopen.
8. **Then UNS-009, UNS-008, UNS-013.** UNS-009 depends on step 7. UNS-008 is independent and cheap.
   UNS-013 is hygiene: broaden `.gitignore`, add an allow-list `.vercelignore`, relocate the
   production dumps, delete the temporary environment files.
9. **Release in reversible stages and watch the specific signal** for each — see the gates below.
10. **Run a new full `/unshittify` audit against `origin/main` afterwards**, cite this report
    (`UNS-AUDIT-20260815-160421`) in its audit contract, and use a fresh skeptic. Do not let the
    author of the repairs approve them.

## Verification and Release Gates

**Must all pass before any release.**

| Gate | Command or check | Success condition |
| --- | --- | --- |
| Types | `npm run typecheck` | Exit 0 |
| Unit | `npm test` | Exit 0, **313/313 pass** (today 310/313 — EVD-003) |
| Database | `npm run test:postgres` | Exit 0 against a **scratch** database, never production |
| Browser | `npm run test:e2e` | Exit 0. Run outside any sealed audit — it writes `test-results/` |
| Per-finding | The "Pre-fix proof" test in each finding above | Each fails before the fix and passes after |
| Regression | `test/routes.test.ts`, `test/world-market.test.ts`, `test/engine.test.ts`, `test/oauth-*.test.ts` | No new failures |
| Migration rehearsal | Apply each new migration to a seeded scratch database with concurrent writers | Write stall stays inside `lock_timeout`; no invalid index left behind |
| Doc sync | `node scripts/embed-door.mjs` then check for a dirty working tree | No diff produced |
| Ignore rules | `git check-ignore -v` for the five UNS-013 paths, from a non-bare worktree | All five matched |

**Test data needed:** a scratch Neon branch; a fetch-fake RPC harness (the repo already has one, see
`test/chain-classification.test.ts`); a fake x402 facilitator with injectable latency; and seeded
fixtures at production-like scale for `places`, `events` and `fees`.

**Forbidden during verification:** real payments; any write to the production database; running
`scripts/deploy.sh` outside the `main` `--prepare` flow; contacting the live 1f3ea market; and load
testing `https://1f3d9.com`.

**Rollback conditions:** roll back immediately if `402 'payment did not verify'` rates rise after
the UNS-006 change; if any hosted-chat user is unexpectedly signed out after UNS-003; if `/api/map`
or `/api/place/:id` returns a shape existing agents cannot parse after UNS-005; or if a migration
leaves an invalid index. Note that UNS-004's and UNS-007's changes alter live world state and
cannot be fully rolled back — announce them before shipping.

**Evidence required before release:** all gates above green, with the per-finding proofs recorded as
having failed first; the UNS-001 historical-exploitation query answered; and a new `/unshittify`
audit of `origin/main` with a fresh skeptic.

## Overseer Record

**Independent skeptic:** COMPLETED
**Reviewer separation:** CONFIRMED

**Structure.** Fourteen read-only agents ran in three waves, coordinated by this session, which
performed the command-line evidence gathering itself. No agent had any write tool.

- **Wave 1 — six independent inspectors**, each given the raw project, the audit contract, and one
  domain, and none shown any other inspector's conclusions: architecture and journeys; identity and
  permissions; money and irreversible actions; world engine and physics; data, migrations and
  operations; untrusted input, public window and supply chain. They raised **21 candidates**.
- **Wave 2 — six per-domain adversarial verifiers**, each instructed to disprove the candidates in
  its domain and each of which proposed none of the candidates it reviewed. They re-opened cited
  files, upheld, changed or rejected items, and added **6 further candidates**.
- **Wave 3 — two fresh skeptics** (`unshittify-skeptic`), neither of which proposed or verified any
  earlier candidate. One acted as final overseer over the entire set with each domain's verification
  attached, explicitly told not to trust the verifiers either; it reviewed **27 items** and added 1.
  The second acted as coverage critic, ignoring the findings and independently tracing the three
  journeys it judged most dangerous; it added **3 candidates**, including the `/treasury` RPC-sharing
  coupling that became UNS-006.

**Outcome of the final overseer pass:** 10 UPHELD, 13 CHANGED (severity or evidence level revised
in both directions), **4 REJECTED** — three of which were duplicate filings of the same `/api/map`
symptom by different inspectors, now merged into the single root-cause finding UNS-005. Rejections
were kept rather than quietly dropped; nothing rejected appears as a finding.

**Disagreements left visible:** the overseer rated UNS-001 HIGH where I judged BLOCKER; I kept the
overseer's rating and recorded the disagreement in Questions item 8. The overseer rated UNS-011 E2
where I recorded E3 on the basis of reading all four migration files myself.

**Work I did myself, not delegated:** every command in the Evidence Ledger; the personal re-read of
`src/world-support.ts:114-164` for UNS-001; the `origin/main` cross-check of every finding; and the
sandbox test run (EVD-007) that **disproved** my own suspicion that `test/world-root.test.ts` had
been weakened — the `HEAD` version and the local version both pass 17/17, so no finding was filed.

**Same-model limitation.** All fourteen agents and this session are the same model family. Fresh
context and adversarial instructions reduce anchoring but do not eliminate shared blind spots: a
reasoning error this model reliably makes would likely be made by every reviewer here. A
different-model or human review of UNS-001 through UNS-004 in particular would be worth more than
any additional same-model pass, and none was performed.

**Self-declared blind spots from the reviewers**, recorded rather than resolved: no code was
executed by any agent, so all cost, query-plan and threshold claims are reasoned rather than
measured; write-side cost and abuse budgets were nobody's assigned domain until the coverage critic
took them; cross-module resource coupling (the shared RPC, the shared transaction pool) sat between
every domain boundary; and most of the ~30 test files and the whole `e2e/` suite were never read, so
no one can say whether an existing test already encodes a behaviour reported here as a defect.

## Integrity Check

**Result:** END-STATE INTEGRITY COULD NOT BE PROVED

- **Baseline captured:** 2026-08-15T16:04:21Z — 834 files, 0 unreadable, `baseline_captured`.
- **Final check:** 2026-08-15T16:46:08Z — `source_changed`, 836 files.
- **Checked file count:** 834 at baseline, 836 at final comparison.
- **Unexpected changed paths (2, both additions):**
  - `.codex/reports/unshittify/unshittify-20260815-110603.md` — added
  - `.codex/reports/unshittify/unshittify-20260815-110724.md` — added
- **Attribution:** both are audit reports written by the parallel Codex `/unshittify` run that the
  user disclosed at the start of this session. Neither is product source, configuration, test,
  schema, or documentation. I did not read either file, so this audit remains independent of it.
- **Independent confirmation that nothing I audited moved:** I re-hashed all 834 baseline files
  directly (EVD-013). **0 modified, 0 deleted.** The entire delta is the two added files above.
- **Why the result is nonetheless "could not be proved":** the seal was broken by a concurrent
  writer inside the measured window. Because that writer was active throughout, I cannot *prove*
  end-state integrity even though I can show that no audited file changed. Recording
  "NO END-STATE CHANGE DETECTED IN CHECKED PATHS" would be false, and the report contract requires
  the verdict `NOT ENOUGH EVIDENCE` whenever the integrity result is not that value — which is why
  the headline verdict is a process verdict and severities are capped at HIGH.
- **Allowed new report path:** none inside the project. This report was written to
  `C:\Users\Owner\Documents\unshittify-1f3d9-20260815-160421.md`, outside the project root and
  therefore outside the seal entirely, at the user's request.
- **Declared expected-volatile exclusion:** `*.tsbuildinfo`, declared at baseline in case
  `npm run typecheck` wrote incremental build info. No such file was created. This pattern is
  **unsealed and carries no integrity claim**.
- No file contents are reproduced in this section.

## Honest Limitations

- **Say "no evidence found in the checked scope", never "there is no problem".** Everything below
  bounds what this audit can support.
- **The integrity guard compares start and final state only.** It cannot prove that no temporary
  write happened and was later reversed. Only an external read-only sandbox or an enforcement hook
  could provide that stronger boundary.
- **The seal was broken by a concurrent writer** (the parallel Codex audit). I have shown that no
  audited file changed, but that is evidence, not proof of an undisturbed window.
- **Nothing was executed against a live system.** No request to `https://1f3d9.com`, no database
  connection, no migration, no deploy, no payment, no chain call, no facilitator call. Every claim
  about production behaviour, cost, query plans, table sizes, RPC throttling and outage duration is
  reasoned from source, not measured.
- **The Postgres integration tests and the Playwright e2e suite were not run.** The first needs a
  live database; the second writes `test-results/` inside the seal. Both remain genuinely
  unverified — `NOT CHECKED` was never converted into "passed".
- **The audited tree is not `origin/main`.** It is ~20 commits behind with 3 uncommitted edits.
  Findings were re-verified upstream; **coverage was not**. Roughly 3,600 lines of newer upstream
  code, including four test files that do not exist here, were never read by anyone in this audit.
- **Secret files were never opened**, so nothing is known about their contents, whether they are
  currently valid, or whether they were ever pushed from another clone.
- **No dependency is claimed vulnerable.** Network access was not used, so no advisory was checked.
  The lockfile's structural integrity was verified; its packages' security was not.
- **Same-model blind spots.** All reviewers share this model family. Independence here means fresh
  context and adversarial instruction, not independent judgment. A different-model or human review
  is worth more than another pass of this kind.
- **Static review cannot prove** absence of a bug, reachability under real concurrency, actual
  performance, or that a passing test suite means correct behaviour. A green suite is evidence, never
  proof.
- **Not covered by the guard:** empty-directory changes, extended file attributes, Windows access
  control lists, and git state inside the nested repositories and worktrees. Platform-specific file
  permissions and all outside systems (Vercel, Neon, Porkbun, the Base RPC provider, the x402
  facilitator, the 1f3ea market) are outside this audit entirely.
- **This report is not an approval.** A skill is not a security boundary, and this audit does not
  make the product safe, bug-free, fully audited, or release-ready.
