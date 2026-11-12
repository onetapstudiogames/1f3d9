# Cost monitoring and incidents

Status: current.

The city's provider bill is an operating signal. The bill is one Vercel invoice in two
parts: Vercel itself, and the Neon databases, which Vercel bills because Neon was added
through Vercel's marketplace. The daily `Cost tripwire` workflow reads both parts,
projects them to the end of the billing cycle, compares the total with one budget, and
watches the slow growers (manual database snapshots with no end date and leftover
`preview/*` database branches). When a limit is crossed, or any provider read fails,
times out, or comes back incomplete, the run ends red, so GitHub emails a failed-run
notice, and it opens a new issue titled with the UTC date. Configuration and response
steps live in [ENVIRONMENT.md](ENVIRONMENT.md); the limits and why each was chosen live
in [`config/cost-tripwire.json`](../../config/cost-tripwire.json). No resident sees any of it.

## Reference incident: 2026-11 (the alarm that stayed green)

Charges of about $100 a month went unnoticed because the weekly tripwire of September to
November read no Neon money, had a $5-a-day Vercel limit ($150 a month), compared no
monthly total, stayed green when a provider read failed, and only commented on one old
issue. From 2026-11-09 its Vercel read failed every time (seven days of charges passed its
5 MB response cap) and the run still finished green. Vercel had also renamed Edge
Requests to CDN Requests, so its request count read zero. The investigation is in
city-ops `fixes/running-costs-2026-11-11.md`; its section 9 is the checked version. The
rebuilt tripwire asks for one charge day per request, reads Neon spending, uses Vercel's
`EffectiveCost` (the `BilledCost` column changes with the request window and does not
reproduce), and turns every unreadable answer red.

## Reference incident: 2026-08-26 through 2026-09-01

On 2026-08-26, Vercel traffic rose from about 60,000 requests per day to about
2.5 million. Nobody noticed until a manual billing investigation five days later.
The cause was a recursive log drain:

1. Vercel delivered logs to
   `https://1f3d9.com/api/internal/log-drain?verification=<fixed value>`.
2. That delivery was itself a Vercel request and created an eligible log.
3. The drain's zero-rate sampling rule named only `/api/internal/log-drain`, so it did
   not match the delivery URL carrying the verification query.
4. Vercel shipped the new delivery log back to the receiver and repeated the cycle.

The structural fix was an ordered zero-rate rule for the exact delivery path including
the fixed `?verification=...` query, before the full-rate rule. Never publish the real
verification value. After any drain edit, verify the stored rule and delivery URL are
identical apart from the redacted value; do not infer success from the receiver's 2xx
response alone. Vercel documents that log-drain sampling rules run in order and match
request paths, while the log schema's proxy path includes query parameters in the
[Log Drains reference](https://vercel.com/docs/drains/reference/logs).

The same investigation found a separate Neon leak: 78 `preview/*` branches, generally
one per pull request, had never been deleted. Beyond the first ten included branches,
each accrued about $1.50 per branch-month. Integration cleanup was not an immediate
PR-close guarantee: Vercel-managed cleanup waits for associated deployment deletion,
and Neon-managed cleanup notices deleted Git branches on later preview activity. The
exact-name PR-close workflow now provides immediate cleanup; the daily tripwire's branch
count and its check for `preview/*` branches with no open pull request are its backstop.
See Neon's [official cleanup behavior](https://neon.com/docs/guides/vercel-branch-cleanup).

The follow-up billing feed named `1f3d9`, `1f3ea`, `eo-web`, `snapshot`, `soti`,
`soti-w3-debug-35d07e2fc1a1`, and `sweetpspeech`. This incident recorded a normal-week request and
invocation baseline only for `1f3d9`: about 60,000 of each per day. On 2026-11-12 the
baseline was re-read from the 30 charge days of 2026-10-12 to 2026-11-10: a median of
about 180,000 CDN requests and 180,000 function invocations a day (highest 239,680,
lowest 81,377), so the config now says 180,000 of each. The other projects, now also
`1f3d9-live`, are explicitly unmonitored in the project config because no reviewed record
establishes their normal request levels. Their presence still satisfies project
completeness, and their cost still counts in the cycle budget and the one-day limit.

The [2026-09-14 cost-tripwire report](https://github.com/onetapstudiogames/1f3d9/issues/282#issuecomment-5669545906) measured `1f3d9-live` effective cost from $0.00 to $0.71 per complete UTC day from 2026-09-06 through 2026-09-12; use that observed range as the starting baseline for comparison, not as a promise or alert threshold, while `1f3d9-live` has no request baseline of its own (its config entry is unmonitored).

## When the tripwire goes red

1. Read the "What went red" list first. A FAILED or SKIPPED read means that part of the
   bill is not being watched; fix the read before trusting the totals.
2. Preserve the issue's dates, project names, quantities, costs, snapshot and branch
   counts, and read statuses as the investigation starting point.
3. Contain a confirmed feedback loop or runaway deployment first; do not raise the
   checked-in limit to make the alarm quiet.
4. For branch growth, protect `main` and `preview/shared-vercel-testing`, identify any
   other deliberate shared branch, then remove only branches whose owners and PR state
   are known. For snapshots, the alarm never deletes anything; removing a backup is the
   owner's call.
5. Record the provider-side change and a fresh dry-run report in the issue. A code-only
   assertion is not live verification. Close the dated issue when the cause is handled.
6. Change a request baseline only after at least seven normal complete days show a
   durable new level, and review that limit change like code. The budget is the owner's
   number to set.

The Vercel feed is newline-delimited FOCUS v1.3 data in Pacific charge days (each starts
at 07:00 or 08:00 UTC). Vercel's cycle runs from the charge day of the 12th to the charge
day of the 11th. The tripwire asks for one charge day per request (about 0.8 MB each in
November 2026, inside the 5 MB response cap), checks that each answer is the day asked
for and already over, uses `ConsumedQuantity` for CDN Requests (formerly Edge Requests)
and Function Invocations, and sums `EffectiveCost` for the cycle total and the one-day
limit. Effective cost includes the $20 Pro seat and usage the plan's included credit
covers, so it can run up to about $20 above the card charge (estimated; only the invoices give the card
amount). The [Vercel billing API reference](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges)
is the provider contract; a schema or API mismatch is an incident signal, never zero.

Neon spending comes from Vercel's `GET /v1/integrations/configurations?view=account`
answer: the Neon entry's `billingData.spending` gives the month to date for every Neon
database billed through Vercel (city and market), with line items. The tripwire refuses
it when it is missing, more than 48 hours old, or its line items do not add up to the
total. It projects both parts to the end of their own periods (Neon's is the calendar
month) and compares the sum with the one budget.
