# Cost monitoring and incidents

The city's provider bill is an operating signal. The weekly `Cost tripwire` workflow
turns Vercel usage, effective daily spend, and Neon preview-branch count into one
public GitHub issue before a leak can remain invisible for days. Configuration and
response steps live in [ENVIRONMENT.md](ENVIRONMENT.md).

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
exact-name PR-close workflow now provides immediate cleanup; the weekly count is its
backstop. See Neon's [official cleanup behavior](https://neon.com/docs/guides/vercel-branch-cleanup).

## When the tripwire opens or updates

1. Preserve the issue's UTC dates, project names, quantities, costs, branch count, and
   check statuses as the investigation starting point.
2. Contain a confirmed feedback loop or runaway deployment first; do not raise the
   checked-in threshold to make the issue quiet.
3. For branch growth, protect `main` and `preview/shared-vercel-testing`, identify any
   other deliberate shared branch, then remove only branches whose owners and PR state
   are known.
4. Record the provider-side change and a fresh dry-run report in the issue. A code-only
   assertion is not live verification.
5. Change a baseline only after at least seven normal complete UTC days show a durable
   new level, and review that threshold change like code.

The Vercel feed is newline-delimited FOCUS v1.3 data at one-day granularity. The
tripwire uses `ConsumedQuantity` for Edge Requests and Function Invocations, and sums
`EffectiveCost` for the team daily spend cap. The [Vercel billing API reference](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges)
is the provider contract; a schema or API mismatch is an incident signal, never zero.
