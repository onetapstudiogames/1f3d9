# Unshittify Audit

**Audit ID:** UNS-1F3D9-MONEY-20260815
**Project:** 1F3D9 market bridge and money — world aisle, chain verification, and payments
**Created:** 2026-08-15T23:33:51Z

## Plain-English Verdict

DO NOT RELEASE

The checked money paths can say “paid” before Base says “finalized,” and several x402 paths can move real USDC before the city or market has saved enough information to finish or recover the purchase. Those are production money-loss and property-integrity risks. I found no evidence that a resident has already lost money, but the current source permits it.

The live public contract promises that unfinalized evidence stays pending, that paid property is recoverable, and that market withdrawal and city ownership stay in agreement. The implementation breaks those promises in specific interleavings.

### Findings at a Glance

| ID | Severity | What fails | Plain-English impact |
|---|---|---|---|
| UNS-001 | BLOCKER | Both services accept successful but unfinalized Base receipts | A reorg can erase payment after an irreversible fee action or ownership move |
| UNS-002 | BLOCKER | x402 can settle before a durable recovery record or effect | A buyer can be charged and receive a 409/500 with no item, claim, or reliable retry |
| UNS-003 | HIGH | Market withdrawal races the city reservation | A withdrawn listing can still transfer in the city while the market refuses to record the sale |
| UNS-004 | HIGH | A pending world payment hash is not globally reserved | Another sale can consume it and leave the world thing permanently locked |
| UNS-005 | MEDIUM | Database time and Base block time use different precision | Valid edge payments can be rejected, and sub-second-late payments can be accepted |

### Next 3 Actions

1. Put paid writes and world-aisle checkout into maintenance or queue-only mode until UNS-001 and UNS-002 are fixed.
2. Take a read-only production snapshot of payment uses, fees, sale payments, pending world offers, and recent Base receipts; look for paid-without-effect and unfinalized-at-acceptance cases.
3. Build the fixes behind failing tests first, including real PostgreSQL and two-service race tests, then canary them without using production money.

## Audit Contract

This audit followed the requested category wherever money or ownership crossed a boundary. The acceptance standard was not “the happy-path tests pass.” It was: no real USDC can be counted before the declared chain finality rule; every externally settled payment has a durable, idempotent recovery path; one payment cannot fund two effects; withdrawal, reservation, payment, ownership, and market receipt cannot disagree.

Scope included the local 1F3D9 source, schema, tests, current public 1F3D9 contract, current public 1F3EA contract, and the exact current public 1F3EA source commit used for bridge analysis. Documentation was treated as a claim and checked against source and live public responses.

The audit was read-only except for this report. It did not authenticate, reserve property, POST to either production service, send USDC, read secret-bearing files, inspect production environment values, or read any other audit report. No application code was changed.

## Project and Connection Map

```text
Resident or market buyer
├─ direct tx-hash proof ──> Base RPC ──> city/market verifier
├─ X-PAYMENT ─────────────> PayAI facilitator ──> Base USDC transfer
│                                           └─> later Neon write/effect
├─ direct city sale ──────> reservation ──> payment_uses/sale_payments
│                                           └─> ownership + transfer + event
└─ 1F3EA world aisle
   ├─ market draft + checkout (public records)
   ├─ 1F3D9 five-minute reservation
   ├─ payment + city ownership move
   └─ 1F3EA sync of the public city receipt
```

The highest-risk seam is between an irreversible Base settlement and the next PostgreSQL statement. The second seam is between two independently mutable databases that coordinate only through public GETs.

Primary local components:

- `src/chain.ts` and `src/pay.ts`: Base receipt classification, direct proofs, x402 verify/settle.
- `src/world-support.ts` and `src/world.ts`: treasury-paid frontier and kind actions.
- `src/society.ts`: direct city sale reservation, claim, ownership, and payment history.
- `src/world-market.ts` and `db/schema.sql`: 1F3EA bridge, pending evidence, reconciliation, global payment use, and history locks.
- Current 1F3EA `src/chain.ts`, `src/pay.ts`, `src/world-routes.ts`, and `src/index.ts`: world listing fee, public checkout/draft records, withdrawal, and sync.

## Coverage and Limits

The local snapshot was commit `7035d9db7f766792f56c7782f0c0636b94533e48` on `codex/workspace-reconciliation`. It is six commits ahead of public 1F3D9 `main` (`09b1cb5b5054f4257cdd8c373cdd85659b4add60`), but Git blob IDs proved that `src/chain.ts`, `src/pay.ts`, `src/world-market.ts`, `src/world-support.ts`, `src/society.ts`, `src/world.ts`, and `db/schema.sql` are byte-for-byte identical to that public `main` commit. Current public 1F3EA `main` was `8bf670840c6d43427079532aa7ad86e022b13502`.

The tracked project inventory contained 124 files: 38 under `src`, 39 under `test`, 7 under `db`, and 14 non-audit docs. The audit concentrated on every money/ownership entry point and its schema/test connections, not unrelated city physics or OAuth internals.

`npm test`, typecheck, and coverage passed. Coverage was 91.03% lines, 74.49% branches, and 87.16% functions overall. The risky files still had important branch gaps: `pay.ts` 48.28% branch coverage and `world-market.ts` 69.81%. The world-market route tests use a fake query interpreter; schema tests mostly match SQL text. No real-PostgreSQL test executes the reservation → pending → reconcile → payment trigger sequence.

Public GET checks reached both live front doors and `/api/official`. At the check time, the 1F3EA world shelf contained zero listings and 1F3D9 returned zero `world_listed`, `world_sale`, and `world_cancel` events. That prevented a safe public trace of a real production bridge record. The live deployment SHA, production RPC/facilitator settings, database contents, and historical receipts were not observable without operator access.

## Evidence Ledger

| ID | Check | Result | Side effects |
|---|---|---|---|
| EVD-001 | Trusted Git inventory, branch, commit, status, and tracked-file counts from `C:\Users\Owner\Documents\1f3d9` | Exit 0; local commit and 124-file inventory recorded | None |
| EVD-002 | Fresh reads of every cited local source, schema, and test path with numbered lines | Exit 0; end-to-end money/ownership connections traced | None |
| EVD-003 | Deterministic inline Node proof with a mocked canonical receipt at block `0x100` and finalized head `0xff` | Exit 0; `{"raw":{"state":"matched","finalized":false},"direct":"matched","legacyAccepted":true}` | No files, network, database, or funds |
| EVD-004 | `npm test` | Exit 0; 401 passed, 0 failed | Test-owned temporary data only; cleaned by tests |
| EVD-005 | `npm run typecheck` | Exit 0 | None |
| EVD-006 | `npm run test:coverage` | Exit 0; 401 passed; 91.03% line, 74.49% branch, 87.16% function coverage | No project artifact written |
| EVD-007 | Unauthenticated GETs to both front doors, both `/api/official` routes, world shelf, resident lookup, bridge misses, and city event filters | HTTP success/expected 404s; live contract captured; world shelf/events empty | No auth, writes, reservation, or payment |
| EVD-008 | GitHub API comparison and exact raw reads for current 1F3D9/1F3EA public commits | Exit 0; critical local/public city blobs identical; market bridge source pinned | Network reads only |
| EVD-009 | Fresh reviewer reopened source and challenged candidates A–F | A–F upheld; A/B BLOCKER, C/D HIGH, E/F MEDIUM; reviewer made no file changes | Read-only review |
| EVD-010 | `validate_report.py ... --json` | Exit 0; `valid: true`, 5 findings, no errors, no warnings | Report file only |

Not run: production writes, authenticated requests, real USDC, a live world checkout, production database queries, the PostgreSQL integration suite, or Playwright. A disposable PostgreSQL target was not established, and using an unknown configured target would have violated the read-only audit boundary.

## Findings

### UNS-001: Successful unfinalized Base receipts are accepted as paid

- **Severity:** BLOCKER
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** A payment may trigger a fee effect or ownership transfer only after its receipt is canonical and at or below the Base finalized head; the live contract explicitly says unfinalized evidence remains pending.
- **Location:** Local `src/chain.ts:111-178`, `src/pay.ts:124-170`, `src/world-support.ts:126-175`, `src/world.ts:281-330,481-513,574-610`, `src/society.ts:812-894`, and `src/world-market.ts:510-534,1056-1164,1234-1255`; current 1F3EA `src/chain.ts:53-78`, `src/pay.ts:113-124`, and `src/world-routes.ts:329-343` at commit `8bf670840c6d43427079532aa7ad86e022b13502`.
- **User or business harm:** A normal newly mined transfer can be treated as complete before finality. If Base later reorgs it away, the buyer can retain continent/kind/property ownership or a recorded market fee while the seller or treasury never receives final money; append-only histories then preserve a false paid state.
- **Evidence:** The city classifier computes `finalized` but returns `state: 'matched'` even when false; both direct-payment helpers convert any `matched` result into success. The world x402 reread also accepts that `matched` result. The deterministic proof produced `matched/finalized:false`, then `direct:matched` and `legacyAccepted:true`. The market-side verifier is weaker: it accepts any status-`0x1` receipt and never asks for canonical block or finalized head. The public city/market copy says missing, ambiguous, or unfinalized evidence stays `payment_pending`.
- **Safe reproduction:** Run the inline mocked-RPC proof from EVD-003: return a successful exact USDC transfer in block `0x100`, return that block as canonical, and return finalized head `0xff`; call `classifyUsdcTransfer`, `classifyDirectPayment`, and `verifyDirectPayment`. It is deterministic, uses no chain/network/database, and shows the accepted unfinalized result.
- **Connection traced:** Base receipt → `classifyUsdcTransfer` → finality Boolean discarded → treasury fee or direct/world claim → `payment_uses`/`fees`/`sale_payments` → place/kind creation or ownership update → append-only transfer/event history. The same invariant failure reaches the current 1F3EA world-listing direct-fee path.
- **Root cause:** “Matched” and “finalized” are modeled as separate facts, while every caller treats “matched” as terminal success. Finality is used to delay failed/mismatched receipts but not successful matching receipts. The sibling market implementation has no finality state at all.
- **Connections and similar locations checked:** Direct city fees, frontier founding, kind invention/revision, generic sales, world direct claims, world x402 confirm/reconcile, global one-use tables, current market world-listing fees, local chain-classification tests, and live public finality wording were checked. Existing tests cover unfinalized mismatch/out-of-window cases, not a matching unfinalized transfer.
- **Durable fix:** Make the shared type impossible to misuse: only return terminal `matched` after canonical finality, and return `pending` for every unfinalized receipt regardless of whether its logs match. Port the same classifier to 1F3EA. Require the finalized invariant again at every effect boundary and retain payer, payee, exact amount, block number/hash, and block time in the durable receipt.
- **Why this is not a band-aid:** Adding one `if (finalized)` in the world route leaves fee, generic sale, legacy helper, and market listing paths unsafe. The invariant belongs in the shared classifier/type and must be reasserted where money becomes durable city or market state.
- **Pre-fix proof:** Add failing unit tests for exact matching-but-unfinalized receipts through both city helpers and the market helper; add route tests proving frontier, kind, direct sale, and world claim create no effect until the finalized head reaches the receipt block.
- **Verification:** Run unit tests against matching, failed, mismatched, reorged, missing, malformed, and finalized receipts; then run a controlled Base test-network flow where the first read remains pending and a later finalized read commits exactly once. Confirm no ownership/payment row exists before finality.
- **Regression and rollback risk:** Users will wait longer and more requests will return `payment_pending`; clients must retry without paying again. Never roll back by restoring pre-finality acceptance. A rollback must preserve pending evidence and disable paid effects instead.
- **Unknowns:** The exact live Vercel SHA and historical receipt-finality state were not available. A read-only production reconciliation is needed to learn whether any already-recorded payment was unfinalized when accepted or later disappeared.

### UNS-002: x402 can move USDC before a durable recovery record or paid effect exists

- **Severity:** BLOCKER
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** An irreversible external settlement must be preceded by a durable idempotency/payment-intent record, and every successful or ambiguous settlement must be recoverable even after reservation expiry, database failure, timeout, or business-state conflict.
- **Location:** Local `src/pay.ts:60-112`, `src/world-support.ts:126-145`, `src/world.ts:281-330,481-513,574-610`, `src/society.ts:795-912`, and `src/world-market.ts:983-1068`; current 1F3EA `src/pay.ts:66-100` and `src/world-routes.ts:301-423` at commit `8bf670840c6d43427079532aa7ad86e022b13502`.
- **User or business harm:** The facilitator can successfully move USDC, then the route can return 409/500 or time out before saving the transaction or delivering the item/action. Generic city sales, city fees, and market world-listing fees have no dedicated reconciliation path, so a payer can lose money or be told to pay again.
- **Evidence:** In direct city sales, `/settle` completes at `society.ts:801` before a claim CTE that still requires `reserved_until > clock_timestamp()` at line 838. Fee settlement returns at `world-support.ts:136` before later mutable DB predicates and writes. In the world route, settlement completes at `world-market.ts:983` before the pending hash update at lines 992-1046, and that update also requires the reservation still be active. The market performs the same ordering for the paid world-listing fee. Neither service gives facilitator fetches an abort timeout or response-size bound. The x402 standard's successful settlement response confirms blockchain execution; it does not atomically commit either Neon database.
- **Safe reproduction:** In a no-money route harness, make `settleX402` return a fixed successful tx while advancing the test clock past `reserved_until` before the next query, then assert that the route was externally settled but produced no pending row, payment use, ownership change, or recovery token. Repeat with a thrown DB error after settle and with the 1F3EA draft expiring before listing SQL.
- **Connection traced:** Signed x402 authorization → facilitator `/verify` → facilitator `/settle` and Base transfer → active-reservation/draft SQL predicate → payment/effect row. The irreversible step is outside and before the local atomic boundary; HTTP errors can also omit the computed `X-PAYMENT-RESPONSE` header.
- **Root cause:** The design has a two-phase distributed transaction but no durable first phase, idempotent payment-intent key, outbox/saga, or lookup path for an ambiguous facilitator result. Reservation lifetime is incorrectly used as both purchase authorization and post-payment recovery authority.
- **Connections and similar locations checked:** City frontier/kind fees, generic direct sale, world pending/reconcile, world direct proof, current market world-listing activation, facilitator helper, reservation predicates, duplicate handling, and public “no pay-first limbo” claims were checked. The world path mitigates failures only after its pending update succeeds; the settle-to-update gap remains.
- **Durable fix:** Before `/settle`, atomically persist a bounded payment attempt keyed by authorization nonce/digest, route purpose, actor, payee, amount, and reservation/draft. After any response or timeout, reconcile that attempt by transaction hash/on-chain authorization and allow exact-once completion after the original window if payment was authorized within it. Apply one shared pattern to fees, direct sales, world sales, and market listing fees. Add short request timeouts and bounded responses, but keep ambiguous attempts recoverable.
- **Why this is not a band-aid:** Extending the five-minute window, retrying fetch, or rereading Base once only narrows the race. Database outages, route termination, late facilitator responses, and permanent business conflicts still occur after money moves unless a pre-settlement durable intent owns recovery.
- **Pre-fix proof:** Add failing fault-injection tests for expiry between settle and SQL, DB rejection after settle, facilitator timeout followed by later on-chain success, duplicate retry with the same authorization, and permanent name/ownership conflict after a fee settles.
- **Verification:** Execute those tests against real PostgreSQL plus a deterministic facilitator/chain stub; prove each settled authorization reaches exactly one terminal state: delivered, durably pending/reconcilable, or refunded/operationally escalated. Assert no second payment is requested for an existing attempt.
- **Regression and rollback risk:** New intent rows and recovery states change retry semantics and need cleanup/monitoring. A rollback must leave intent/evidence rows readable and paid attempts finishable; never delete ambiguous evidence or revert to settle-first-without-record behavior.
- **Unknowns:** The production facilitator URL, its exact timeout/idempotency behavior, platform function timeout, and any historical paid-without-effect complaints were not checked. Those need operator evidence, not assumptions from protocol prose.

### UNS-003: Market withdrawal can race city reservation and split the two ledgers

- **Severity:** HIGH
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** A checkout must have one explicit lease/cancellation rule that both services enforce; a seller withdrawal cannot be terminal in the market while a later city reservation/payment remains valid.
- **Location:** Local `src/world-market.ts:254-267,845-925,1097-1164`; current 1F3EA `src/world-routes.ts:292-298,489-495,594-648` and `src/index.ts:517-576` at commit `8bf670840c6d43427079532aa7ad86e022b13502`.
- **User or business harm:** A seller can withdraw a listing after the city has read it but before the city reservation starts. The buyer can then pay and receive city ownership, while 1F3EA refuses to record the purchase because `reserved_at` is after `withdrawn_at`. The seller experiences a sale after withdrawal and the public market and city permanently disagree.
- **Evidence:** The city GETs an active checkout, then an active draft, then opens its own reservation in a separate database with no market-side compare-and-set. The market withdrawal transaction marks the listing/draft withdrawn and expires active checkouts. Later market sync rejects a claimed city record when `reservedAt > withdrawnAt`. Public draft responses permit 10 seconds of shared caching and checkout responses 5 seconds, widening but not creating the underlying time-of-check/time-of-use race.
- **Safe reproduction:** In two local service instances, pause the city after its final market GET; withdraw the listing in the market; resume the city's reservation, use a mocked finalized payment, and then call market sync. Expected current result: city ownership is claimed, market sync returns 409 for withdrawal-before-reservation, and the records diverge.
- **Connection traced:** 1F3EA checkout/draft GET → city validation → seller withdrawal in market DB → city reservation/payment/ownership in city DB → market sync compares city `reserved_at` with market `withdrawn_at` → rejected receipt.
- **Root cause:** A mutable public read is treated like an atomic lease across two databases. Neither the checkout nor the withdrawal defines a shared, immutable precedence rule that survives network delay and caching.
- **Connections and similar locations checked:** Checkout/draft validation, city reservation, local ownership guards, market cache headers, market withdrawal transaction, removal checks, market sync SQL, and live cancellation wording were checked. A second GET would still leave a race after the second GET.
- **Durable fix:** Turn checkout into an immutable lease with a published version, issued-at, expiry, and explicit precedence: either market withdrawal must honor already-issued leases until expiry, or the city must atomically claim a one-use market reservation before it can accept payment. Both sync and withdrawal must apply the same rule. Use no-store/versioned reads for mutable authority records as defense in depth.
- **Why this is not a band-aid:** Removing cache headers or rereading immediately before SQL only shortens the gap. The databases still cannot atomically observe each other; only a shared lease/precedence invariant makes every interleaving converge.
- **Pre-fix proof:** Add a failing deterministic interleaving test for read → withdraw → reserve → finalized pay → sync, plus the inverse reserve-before-withdraw case. State the desired winner for both cases before implementation.
- **Verification:** Run a two-service concurrency matrix across withdrawal/removal, checkout expiry, reservation, payment, and sync; assert one terminal outcome and matching public records in both services. Include stale-cache responses and retries.
- **Regression and rollback risk:** Honoring existing checkout leases means withdrawal may not be immediate; immediate-revocation semantics require a new atomic acknowledgment. UI/API copy must show the chosen rule. Rollback during an active lease can reintroduce split decisions, so deploy both services compatibly.
- **Unknowns:** No live world listing existed for a production record trace. The intended product choice—honor already-issued checkouts or guarantee immediate withdrawal—requires human confirmation.

### UNS-004: A valid pending world payment can be consumed elsewhere and lock the thing forever

- **Severity:** HIGH
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** The global one-payment/one-effect reservation must begin when any route first durably accepts a transaction as pending, not later when that route reaches final claim.
- **Location:** `db/schema.sql:1040-1048,1123-1206,1221-1265`; `src/world-market.ts:575-668,992-1051,1097-1164,1213-1308`; and `src/society.ts:829-910`.
- **User or business harm:** With overlapping offers from the same buyer to the same seller wallet for the same amount/window, one real transaction can first become a pending world payment and then be consumed by a direct sale. World reconciliation hits the global duplicate key, but the valid pending evidence cannot be invalidated or canceled, so the original thing stays locked with no in-product exit.
- **Evidence:** `transfer_offers_pending_x402_tx` makes the hash unique only among pending offer columns. The global `payment_uses(tx_hash primary key)` row is inserted only during final claim/reconcile. Generic direct sale can insert that global row first. World reconcile catches SQLSTATE 23505 and returns “already used,” while cancel rejects `payment_pending`; schema triggers make pending evidence/reservation immutable and allow pending→invalid only for a conclusively failed or mismatched chain receipt. This receipt is valid, so that transition is unavailable.
- **Safe reproduction:** In disposable PostgreSQL, create a world offer and direct offer with the same seller wallet, buyer wallet, amount, and overlapping window; persist the same valid tx as world pending; claim the direct offer first; reconcile world. Assert current behavior is duplicate 409 plus an open, uncancelable `payment_pending` world offer and locked thing.
- **Connection traced:** World pending hash → no global payment reservation → generic direct claim inserts `payment_uses` → world reconcile tries same primary key → 23505 → pending evidence remains valid/immutable → cancel blocked → asset mutex remains.
- **Root cause:** The system has two uniqueness domains with different lifecycle start points. “Pending but economically committed” is represented on the offer but omitted from the global payment-use authority.
- **Connections and similar locations checked:** Pending hash index, global payment primary key, direct and world claim CTEs, reconcile duplicate handling, invalidation rules, cancellation route, history-protection trigger, same-asset mutex, and plausible matching preconditions were checked. The preconditions reduce frequency but do not provide recovery.
- **Durable fix:** Reserve the transaction hash in the global payment authority in the same transaction that writes pending evidence, with a lifecycle state and owning payment-attempt/offer ID. Reconciliation must promote that same row instead of inserting again. Add a migration and operator repair path for existing pending offers whose hash is already consumed.
- **Why this is not a band-aid:** Allowing duplicate hashes, automatically canceling valid pending evidence, or manually clearing the offer breaks either one-payment/one-effect or append-only audit truth. The lifecycle ownership of the global hash must be corrected.
- **Pre-fix proof:** Add the disposable-PostgreSQL interleaving above as a failing integration test, plus retries where the same owning offer reuses its reservation idempotently and a different offer is rejected before it can claim.
- **Verification:** Prove the hash is globally reserved at pending-write time, only its owning attempt can finalize it, valid reconciliation succeeds after reservation expiry, conflicting routes fail before changing ownership, and operator repair retains all history.
- **Regression and rollback risk:** Schema migration can collide with existing pending/used hashes. Inventory and classify them before adding constraints. Rollback must retain ownership metadata for reserved hashes; dropping it can recreate permanent locks or double effects.
- **Unknowns:** Production counts of pending world offers and overlapping direct offers were not available. The route is publicly present but no current public world event demonstrated the state in production.

### UNS-005: Reservation checks mix PostgreSQL fractional time with whole-second Base time

- **Severity:** MEDIUM
- **Evidence level:** E4
- **Status:** Confirmed - independently checked
- **Rule or parameter:** A payment window must use one documented clock domain and precision, with explicit inclusive/exclusive boundaries that both application and database enforce identically.
- **Location:** `src/chain.ts:153-167`, `src/pay.ts:124-151`, `src/world-market.ts:881-882,955-977,1056-1090,1107-1115,1234-1245`, and `db/schema.sql:1182-1196,1271-1301`.
- **User or business harm:** A payment included in the same second just after a reservation opens can be represented as `SS.000` and rejected as earlier than `reserved_at=SS.mmm`. Conversely, a real payment just after an expiry within that same second can compare as no later than the fractional deadline. The payer can be charged yet fail the claim at either boundary.
- **Evidence:** PostgreSQL creates reservation bounds with `clock_timestamp()` and retains fractional precision. Base exposes block timestamp seconds, which the code multiplies by 1000 into a Date ending `.000`. Application and trigger logic compare those values directly with inclusive exact bounds. The representation cannot establish sub-second ordering.
- **Safe reproduction:** Use `reserved_at=00:00:10.500`, `reserved_until=00:05:10.100`, and Base-representable block times `00:00:10.000`/`00:05:10.000`; evaluate the existing comparisons. The first is rejected even if the real transaction arrived after `.500`; the second is accepted even if real arrival was after `.100` because the chain record cannot express that fraction.
- **Connection traced:** Database reservation clock → JSON timestamp → Base block timestamp → JavaScript Date comparisons → SQL claim parameters → `sale_payments_match_world_offer` trigger. The same logical window is enforced with incompatible precision at several layers.
- **Root cause:** The reservation contract was defined in wall-clock timestamps without normalizing to the chain's observable precision or defining how ambiguous boundary seconds are handled.
- **Connections and similar locations checked:** Direct/world comparisons, pending confirmation, reconciliation, SQL claim predicate, validation trigger, five-minute schema trigger, and 1F3EA sync receipt-window checks were checked.
- **Durable fix:** Persist explicit integer chain-second bounds and choose a conservative policy, such as a start rounded up and an end rounded down, or bind a signed authorization nonce to the reservation so boundary order does not depend on sub-second inference. Use the same half-open interval in code, SQL, public challenges, and market sync.
- **Why this is not a band-aid:** Adding a one-second grace merely moves the ambiguity and can authorize late payments. The system must declare which observable seconds are valid and bind the payment to that rule.
- **Pre-fix proof:** Add table-driven tests for `.001`, `.500`, and `.999` reservation starts/ends, clock skew, exact boundary seconds, and application-vs-trigger agreement; make the desired policy explicit before changing code.
- **Verification:** Run the boundary matrix through the classifier, route, and real PostgreSQL trigger; assert all three return the same result and public payment instructions expose the exact usable interval.
- **Regression and rollback risk:** A conservative normalized window slightly shortens the usable period and may surprise clients. Version the challenge semantics and avoid rolling back one service independently while active reservations use the new rule.
- **Unknowns:** Actual production database/RPC clock skew and the number of boundary-time claims were not measured. The precision mismatch itself is deterministic; incident frequency is unknown.

## Questions Needing Human Review

1. Which exact Vercel deployment SHAs, Base RPC provider, and PayAI endpoint are live for both services?
2. Should an already-issued market checkout remain valid through its expiry after seller withdrawal, or must withdrawal be immediate and explicitly acknowledged by the city?
3. Are there support reports, transaction hashes, or 409/500 logs showing payment without effect, repeat payment prompts, or stuck `payment_pending` offers?
4. Can an operator run the proposed read-only production reconciliation and provide redacted counts/results without exposing credentials?
5. What finality policy is intended for money: Base `finalized`, a named confirmation depth, or another explicit business threshold?

## Ordered Repair Plan

1. **Contain and inventory:** pause/queue affected paid writes; snapshot payment and ownership evidence; identify ambiguous/unfinalized/stuck records before migrations.
2. **Enforce finality everywhere:** repair the shared city classifier/type, port it to 1F3EA, and make every paid effect reject `matched` without the declared finality threshold.
3. **Make settlement recoverable:** add durable pre-settlement payment attempts, global hash ownership from pending time, idempotent promotion, bounded facilitator calls, and operator reconciliation for every paid route.
4. **Unify the bridge contract:** choose checkout lease/withdrawal precedence, normalize chain-second windows, and deploy compatible city/market versions with versioned public records.
5. **Prove and release:** run unit, real-PostgreSQL, fault-injection, two-service concurrency, and controlled-chain tests; reconcile existing production data; canary with monitoring and a fail-closed rollback.

## Verification and Release Gates

1. **Finality gate:** matching unfinalized receipts remain pending through all city and market routes; only the declared finality threshold permits one durable effect.
2. **Money atomicity gate:** for every injected timeout, expiry, DB error, route termination, and retry, a settled authorization is durably recoverable and produces at most one effect without another payment.
3. **Database gate:** a disposable real PostgreSQL instance executes pending, invalid, claim, duplicate, cancel, trigger, and migration cases; critical money branches reach at least 80% coverage.
4. **Bridge gate:** exhaustive read/withdraw/reserve/pay/sync interleavings converge to matching city and market terminal states, including cached/stale reads and active deployments at mixed versions.
5. **Release gate:** read-only production reconciliation is clean or repaired; staged Base/facilitator checks pass; monitoring alerts on settled-without-terminal-state, unfinalized acceptance, duplicate pending hash, and prolonged pending lock; rollback preserves all evidence and disables effects.

## Overseer Record

**Independent skeptic:** COMPLETED
**Reviewer separation:** CONFIRMED

The fresh reviewer was given candidate cards only after the evidence pass, was told not to read or write audit reports, reopened the cited local source/schema/tests, independently fetched the pinned public 1F3EA source where needed, and tried to disprove each candidate. It upheld UNS-001 through UNS-005, downgraded none, and identified the missing facilitator timeout as part of UNS-002. A test-coverage concern was upheld but kept in Coverage and Release Gates rather than inflated into a sixth product defect.

## Honest Limitations

- No authenticated production route, reservation, checkout, database query, or real payment was executed; this avoided changing live state but leaves historical impact unknown.
- The live deployment SHAs and environment values were not observable. Critical city files match current public `main`, and live public wording matches those flows, but exact deployment parity remains unproven.
- The live world aisle had zero listings/events during the check, so cross-service findings are source- and interleaving-confirmed rather than reproduced on a resident's production asset.
- The PostgreSQL integration suite was not run because no verified disposable target was established; existing route tests fake the critical SQL/trigger behavior.
- Other audit reports and secret-bearing files were never read. Delegated agents mistakenly created draft money reports; those drafts were deleted without being opened, and only this final report is retained.
