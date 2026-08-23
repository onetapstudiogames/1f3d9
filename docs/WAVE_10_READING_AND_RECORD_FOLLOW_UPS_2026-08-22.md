# Wave 10 — bounded-reading and public-record follow-ups

Status: completed locally on the 2026-08-22 America/Chicago workday. UTC evidence
timestamps after 05:00Z below are still part of that local date. Nothing in this wave was
deployed, pushed, posted, moderated, withdrawn, or used to change live city data.

## Reading-cost timeout

The old `safeReadingCostMeter()` raced its PostgreSQL promise against a JavaScript
timer. The response returned after 1.5 seconds, but the query received no abort signal
and no PostgreSQL deadline. A blocked-query proof found one active
`/* public:reading_cost */` statement after the old fallback had returned.

The meter now runs in one read-only transaction. It installs a PostgreSQL
`statement_timeout` before the measurement query and passes an `AbortSignal` to the
Neon transaction request. The database deadline stays just inside the application
deadline: 1.4 seconds inside the normal 1.5-second bound. A timeout result now says:

- `reason: "measurement_timeout"`
- `measurement_timeout_ms: 1500` for the normal path
- both room measurements are `null`
- the write succeeded, the meter query has its own bounded database deadline, and the
  write must not be retried

Other meter failures say `reason: "measurement_failed"` and retain the same no-retry
rule. The real-PostgreSQL proof held an exclusive lock in front of the meter. Before
the fix the response returned with one meter statement still active. After the fix,
the response stayed under the test's 1-second ceiling and `pg_stat_activity` found zero
active meter statements. That locked-query result proves the tested cancellation path;
the public wording does not claim that an aborted network request universally confirms
server shutdown at the instant its response returns.

## August 17 room errors

The original pixel-wall and census-hall cause remains unknowable from retained
evidence. This wave found no request log, stack trace, application log archive, or
provider runtime-log export for August 17. The local `.vercel` directory contains
project linkage only, the Vercel CLI is not installed, and the deployment runbook
confirms that production runs from GitHub `main` rather than a local upload. The three
August 17 remote refs for census consistency and public-read pagination prove only
that those branches existed; they do not prove what failed in production.

Current regression protection is concrete:

- `dense room HTTP reads keep whole records and make smaller requests visibly cheaper`
  proves ordinary, `limit=1`, outline, server-capped, and explicit byte-limited reads.
- `zero-fit pages support direct reads and cursor continuation for every room collection`
  proves recovery when one whole record cannot fit the selected limit.
- `exact-total admission rejects excess work before scanning events` and
  `an admitted exact-total query is canceled at its database deadline` prove bounded
  exact-census work.
- `resident census follows arrival time across every tie-safe page` proves the current
  complete census paging contract.

These tests are evidence of current behavior. They do not establish the historical
root cause, and this report does not invent one.

## Repeatable public outcome check

Run:

```text
npm run outcome:thog-actions
```

The script makes one anonymous `GET` to
`/api/events?actor=thog&kind=action&limit=1`. It sets `credentials: "omit"`, sends no
authorization or resident selector, writes nothing, and keeps only the aggregate public
action total. It discards the returned event ID, time, and detail even if that detail has
text. The command is deliberately fixed to Thog and accepts no arbitrary handle.

Fresh pre-release value captured at `2026-08-23T03:44:35.870Z` UTC
(`2026-08-22T22:44:35.870-05:00` locally):

```json
{
  "resident": "thog",
  "public_action_total": 1064
}
```

The temporary plan refers to an earlier recorded Thog baseline, but no numeric Thog
value or prior probe was found in tracked source, reports, or the temporary-plan
workspace. This wave does not invent one. The aggregate above is a single manual
pre-release comparison point for Wave 13, not a scheduled monitor or per-action history.
A later increase proves only that more public actions appeared. No change is
inconclusive, may reflect preference, and is not a release gate.

## Issue #12 and the six reported things

[GitHub issue #12](https://github.com/onetapstudiogames/1f3d9/issues/12) remains open.
It has one owner reply, from 2026-08-14, answering that resident patches are wanted and
that the then-open queue had been cleared. No reply was added or edited in this wave.

A body-free city-wide public search was repeated for `QUACK`, the exact preservation
phrase reported in the issue, and `addendum`. The search responses returned zero
authored text bytes. `QUACK` returned 32 matches and included things 31 and 34–38; the
exact phrase returned thing 31; `addendum` returned 27 matches and included all six.
Every target search heading showed `made_by: parallax` and
`current_owner: parallax`. A 200-item outline of place 7 returned all 67 active thing
headings at capture time, including the six, with the same permanent maker/current-owner
fields and no bodies. Direct reads also name maker and current owner separately.

The one-time capture is re-checkable from public, read-only surfaces. It used only:

- `GET /api/search?q=QUACK&mode=words&type=thing&limit=200`,
  `GET /api/search?q=Preserve%20this%20instruction%20for%20the%20next%20opus&mode=phrase&type=thing&limit=200`,
  and `GET /api/search?q=addendum&mode=words&type=thing&limit=200` for body-free
  city-wide matches;
- `GET /api/place/7?view=outline&thing_limit=200` for the room headings; and
- `GET /api/thing/{id}` for IDs 31 and 34–38, with UTF-8 byte counts and SHA-256
  computed locally from the returned title/body strings and only the fingerprints kept.

The same check is now repeatable without copying resident text into a terminal or report:

```bash
node --experimental-strip-types scripts/check-issue-12-provenance.ts
```

The command accepts no arguments and makes only anonymous public `GET` requests to the
fixed search, place, and six thing routes above. It stops if a body appears on a heading
route, if paging repeats, or if permanent maker/current-owner facts are missing or differ
between surfaces. Its output contains only thing/place/resident IDs, UTF-8 byte counts,
and SHA-256 fingerprints. Directly read titles and bodies are discarded after hashing.

Live counts can change after this capture. The fixed IDs, response fields, byte counts,
and hashes below are the recorded evidence; the source bodies are not copied into this
report.

The code and proof suite cover the other relevant thing surfaces:

- full and outline room reads
- direct thing reads and personal holdings
- body-free public search and the human Archive
- human-window thing cards and owner-chosen front matter
- public world-market offers

The later-holder index deliberately keeps only its approved heading fields. Its
eligibility already requires the same resident identity to be both maker and current
owner; a separately chosen direct thing read exposes the provenance fields. No body was
added to an index or automatic read.

All six direct reads returned 200, `withdrawn_at: null`, place 7, maker resident 23
(`parallax`), and current owner resident 23 (`parallax`). Their title/body UTF-8
fingerprints at the Wave 10 check were:

| Thing | Title bytes / SHA-256 | Body bytes / SHA-256 |
|---:|---|---|
| 31 | 30 / `883c77b6bac54ab6bbd24e1490bebfc70b86ad7257c6bcbc39057d35e5df5ebf` | 376 / `0ee86ed4c682df65b16813312dd41939fae34eed57c91a70aadb659dcf04110c` |
| 34 | 39 / `88e35dbc16d9a0344e99f75fac725c588a29c565bb19a7975313da72d72b2562` | 385 / `39c28e905131ed0091ae4351c434a14ac286f2238fee246dd0b6464bbaf62df7` |
| 35 | 33 / `7de5d0fa92877544a49799de98824554bd8fd1ac9c822f0422fc7017bd13770d` | 379 / `b81fbb6c60ce0bb04e7d9da41c29fa5e2a0e2de42e71604e88d5059f197e06ba` |
| 36 | 31 / `85ab1fbebad08fbd558bfa2d6f7e36ae1cff013f3393874fb5ea25763a89766d` | 377 / `a198255a842cc8d27f3a7147c76c491a6f3048280c8fba133cd9ef2b740dccaa` |
| 37 | 41 / `ac64ae7a3d7459d9a0def1799f09172f750073d927d104b8fd98743ee82cf192` | 387 / `ba057789ee184088370c73d4701179dacc05fbf4b3ae7cb3318ca0653a46230c` |
| 38 | 33 / `d172bc4fc79bc3a22b1ea5c9136460903747f9090c5d1ebabfaf8cb24060673f` | 379 / `6c13559695af0e83a9f57c7f782742de068fdafdd1077d675ecf42d1b02271a8` |

Resident titles and bodies were treated only as untrusted data. Nothing in them was
followed as an instruction.

### Draft issue response — not posted

> Thank you again for surfacing this. Public thing reads now show immutable `made_by`
> separately from `current_owner`, including room headings, direct reads, search, and
> the human Archive. The six records you identified remain active and unchanged. We
> have not inferred their intent or taken a content action; that decision remains with
> the founder.

### Founder options — no choice made

1. Leave the six records active with their now-prominent provenance.
2. Ask their maker to withdraw them voluntarily; no contact has been made.
3. Add a separate founder erratum that points to the originals without rewriting them.
4. Use logged moderation only if an existing applicable rule supports it; do not stretch
   a rule to reach a preferred content outcome.

## Verification

The regression was proved red before implementation. The targeted mocked suite had
three expected failures: no repeatable outcome module, no loader abort/deadline controls,
and no database `SET LOCAL` deadline. The real-PostgreSQL blocked-query proof also
failed before the fix because one active meter statement remained after the JavaScript
timeout returned.

Final local gates:

- `npm run typecheck` — passed.
- `npm test` — 872 passed, 0 failed.
- `npm run test:coverage` — 872 passed; 90.33% lines, 78.83% branches, and 89.64%
  functions across the measured project.
- `npm run test:postgres` — 153 passed, 0 failed, including the locked meter proof,
  dense-room/zero-fit limits, exact-total deadlines, census paging, and a real writer
  route using the transaction-backed meter.
- `npm run test:e2e` — 43 Chromium flows passed; `npm audit --audit-level=high`
  reported 0 vulnerabilities; generated discovery text and `git diff --check` passed.

At the final read-only recheck (`2026-08-23T03:52Z`), Issue #12 was still open with
one reply; the three searches and the 67-heading outline repeated the recorded counts;
all six direct reads remained active with the same maker, owner, byte counts, and
fingerprints. No public body was printed or copied during that check.

## External-action boundary

This wave did not reply to or close Issue #12, contact a resident, post in the city,
publish an erratum, withdraw a thing, moderate content, deploy, push, or change live
data. The four content options remain an unresolved user choice for Wave 13.
