# Payment recovery operator runbook

Next action: run the read-only preflight only after the Wave 15 release is ready.

The command is dry-run-first. It reads fresh production facts and Base finality,
then prints an exact plan or aborts. Its live mode is separately locked behind
an exact acknowledgement and one all-or-nothing database transaction.

## Current late-finality guard repair

Before deploying the matching application code, run the separately selected
`payment-late-finality-recheck` migration against the isolated preview database,
then against production only after the migration runner verifies the exact Neon
target and creates its required production snapshot. The package entry points are
`migrate:preview:payment-late-finality-recheck` and
`migrate:production:payment-late-finality-recheck`.

This idempotent function repair permits only the existing expired-x402 transition
to `founder_review`: finality must either be absent or exactly match the stable
transaction, block number, block hash, and block time already stored. Matching
evidence keeps the original `finalized_at`; partial or conflicting evidence still
stops. Verify the Sputnik-shaped PostgreSQL integration case before promotion.

## 1. Preconditions — about 2 minutes

1. Confirm the recorded user approval for both the Wave 15 release and Bob's
   live repair.
2. Deploy and verify the reviewed payment-recovery and city-credit migrations
   and code first. Both guarded recovery deadlines are already in the past.
3. Load the production direct database URL, Neon project/branch identifiers,
   and Neon API key through the private operator environment. Never pass or
   print them as command arguments.
4. Confirm the expected PostgreSQL database name from the reviewed deployment
   record. Do not copy it from an unverified shell history entry.

## 2. Hosting preflight — about 2 minutes

1. `vercel.json` schedules `/api/internal/payment-recovery` every five minutes.
   Current Vercel limits require Pro or Enterprise for that frequency; Hobby
   allows only a daily schedule with hour-level timing precision.
2. Configure `CRON_SECRET` in the deployment environment. Vercel sends it to
   the recovery route as an `Authorization: Bearer` value; never print it or
   place it in source.
3. Assume cron invocations can overlap. The database lease and idempotent
   transitions, not scheduler timing, must decide each race.
4. Vercel cron does not automatically retry a failed invocation. Verify the
   next run and use the bounded operator audit when a run fails.
5. Keep the recovery function at its reviewed 300-second maximum duration and
   batch size of 10. Base reconciliation can require several bounded RPC calls.

After a successful recovery batch, the cron also opens a runtime-log retention
slot during UTC minutes 00–04. That maintenance deletes at most 1,000 rows older
than 30 days. Its failure is reported with safe metadata and does not change the
payment-recovery response; the next hourly slot retries another bounded page.

Wave 5 does not deploy the schedule, configure the secret, or invoke the live
route. Those production actions require the separately approved release wave.

## 3. Run the default dry run — usually under 15 seconds

From the repository root, run:

```powershell
node --experimental-strip-types scripts/repair-bob-payments.ts --target production --database <expected-name>
```

The command first proves that the direct TLS database endpoint belongs to the
configured Neon production project and branch. It then opens one PostgreSQL
`REPEATABLE READ READ ONLY` transaction. The transaction has short statement,
lock, and idle timeouts and selects only the guarded resident, attempts,
payment-use rows, fee rows, world root, two names, and deterministic credit
source and repair-event keys. Payment response headers, bearer secrets, and
database URLs are never selected or printed.

The dry run independently requires all of these facts:

1. Resident 68 is still `bob`; both attempt IDs, immutable request bodies and
   hashes, target keys, timestamps, payment terms, and unused hashes match the
   hard-coded evidence.
2. Both stored attempts are exactly `expired`, have the automatic recovery
   deadline reason, no stored finality or lease, and retain the migration-derived
   two-hour recovery timestamps.
3. Each Base transaction reclassifies as the exact finalized canonical USDC
   transfer: expected payer, treasury recipient, token, one million units,
   block number, block hash, and block time.
4. Neither transaction or attempt is used; neither has a fee; `TheBlueAI` and
   `coffee-shop` are available; the world root is unique; and the founder-credit
   source key is unused.
5. The only permitted plan is one `complete_theblueai`, one
   `close_coffee_probe`, and one `issue_founder_credit` action.

Any missing, changed, uncertain, ambiguous, partially completed, or extra fact
aborts the command. Do not update a constant merely to make a changed dry run
pass. Re-investigate the production row and Base evidence instead.

## 4. Wave 15 apply gate — exact acknowledgement required

The exact acknowledgement is:

```text
APPLY_BOB_PAYMENT_REPAIR_WAVE_15
```

After the dry run reports exactly the expected three actions, run:

```powershell
node --experimental-strip-types scripts/repair-bob-payments.ts --target production --database <expected-name> --apply --ack APPLY_BOB_PAYMENT_REPAIR_WAVE_15
```

The checked-in apply operations are intentionally specific to Bob's two recorded
transactions. Each action carries the already-validated request, root/place
shape, payment terms, recovery timestamps, and canonical Base block facts. The
implementation enforces these five conditions:

1. Use only the transaction object passed to each method. Do not open a second
   connection, commit early, or perform an external side effect.
2. `completeTheBlueAI` must atomically create exactly one continent from the
   guarded request, append one public host correction, and move only that attempt
   to `founder_review` with the exact finality evidence. It must not add a normal
   payment-use or fee row or pretend the expired attempt completed normally.
3. `closeCoffeeProbe` must append the exact finality evidence and one public host
   correction, then move only that attempt to terminal `founder_review`; it must
   create no place, use, or fee.
4. `issueFounderCredit` must call the founder-only credit operation for resident
   68 with source key
   `bob-payment-repair:pay_ae6db1c532fdcca0bdc2c977433e842540a5fa2dc1c41c830627dba60fe5c24b`.
   It issues exactly 1,000,000 units and is not called a refund.
5. Preserve both attempts and every prior payment fact. Never delete, rewrite,
   loosen, or bypass payment history protections.

After the read-only preflight, apply mode begins one `SERIALIZABLE` transaction,
locks and re-reads the evidence, reclassifies both Base transactions, and
requires the proposed actions to be byte-for-byte unchanged. After the three
narrow operations, it re-reads inside the same transaction and commits only if
the pure planner reports `no_work`. Otherwise it rolls back everything.

## 5. Required post-check — usually under 15 seconds

Run the default dry-run command again. It must report `state: "no_work"` and an
empty action list. That result requires exactly one matching `TheBlueAI`, no
`coffee-shop`, no matching payment-use or fee rows, terminal founder review for
both attempts, exactly two public host correction events, and exactly one
founder-issued credit with the deterministic source key.

If the post-check aborts, stop. Preserve the transaction and credit history,
capture only the sanitized error text, and use a forward repair after reviewing
the exact database state. Never retry by paying again, deleting a row, changing
the source key, or issuing a second credit.
