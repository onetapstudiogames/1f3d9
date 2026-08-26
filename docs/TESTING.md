# How the test harness works

Four layers, each catching what the previous one cannot. A maintainer adding a
feature should know which layers their change needs before writing it.

## Layer 1 — unit suites (`npm test`, ~1,050 tests)

No live database, wallet, payment, or network service is touched. Each suite
replaces `globalThis.fetch` with ONE fake that routes by URL to the three
external services the server talks to:

1. **Neon serverless HTTP** — any `/sql` URL. Single queries and batched
   `queries` arrays both answered. Responses are built by `neonEncode()`
   (see `test/routes.test.ts`), which reproduces Neon's wire shape exactly:
   `fields` with `dataTypeID`s, string-encoded row values, `t`/`f` booleans,
   `\x` bytea, Postgres array literals. Getting this shape right is what lets
   the real `src/db.ts` client run unmodified against the fake.
2. **Base JSON-RPC** — the fake `BASE_RPC_URL` host. Per-method canned
   answers (`eth_getTransactionReceipt`, `eth_getBlockByNumber` incl. the
   `finalized` tag, `eth_call`, `eth_getLogs`) driven by the suite's mutable
   `state` so a test can flip finality, transfer direction, or amounts.
3. **x402 facilitator** — `/verify` and `/settle`, toggled by state flags to
   exercise accept, refuse, and ambiguous-settlement paths.

The pattern inside a suite: a `state` object (replaced immutably, never
mutated) records every call for assertions, and a `dbRespond(query, params)`
dispatcher answers SQL by matching query text. Environment is pinned at the
top of the file — fake `DATABASE_URL`, fake RPC and facilitator hosts, the
real treasury constant, a fixed later-holder cursor key.

The fake is currently copied per suite rather than shared. When adding a new
suite, copy from `test/routes.test.ts` and delete what you don't need;
consolidating the copies into one helper is tracked cleanup, not yet done.

**What this layer cannot catch: SQL correctness.** The fake answers whatever
`dbRespond` says, so a query referencing a wrong column passes unit tests and
fails in production. This is not hypothetical — the events table's clock
column is `at`, not `created_at`, and only the next layer caught it.

## Layer 2 — Postgres integration (`npm run test:postgres`)

The suites run sequentially against disposable PostgreSQL 17 containers
(Docker required). Real schema, real migrations, real triggers, real
constraint validation. Any change that adds or edits SQL, schema, or
migrations needs coverage here, not only in layer 1. The backup/restore drill
lives here too. Sequential execution is deliberate: PR #69 proved concurrent
containers were resource-sensitive on hosted runners.

## Layer 3 — end-to-end (`npm run test:e2e`)

Playwright against the built app: the human window, setup pages, identity
doors. UI changes need a check here — the suites-green-but-owner-notices
regression class lives exactly in this gap.

## Layer 4 — CI and the release gate

CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, `door:check`
(generated front-door mirrors must match their sources), the sequential
PostgreSQL integration suite, and the e2e suite on every PR. Release
candidates additionally run `bash scripts/deploy.sh --prepare` — read its
explicit `GATE_EXIT` line; piping can mask a failure. The working standard in
[AGENTS.md](../AGENTS.md) adds the production-runtime and adversarial-review
bar for payment-path changes.

## Gotchas that have bitten before

- `/api/window` keeps a 30-second module cache. A test that warms it must
  backdate `Date.now` or every later test in the process reads poisoned data.
- Fakes don't validate SQL (see layer 1). Postgres suites are the authority.
- Public text assertions: many suites assert exact sentences from the front
  door and tool descriptions on purpose — contract wording is part of the
  product. Expect copy edits to require test edits; that friction is the
  drift guard working.
