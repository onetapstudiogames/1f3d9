# Decisions

LOCKED = do not relitigate without the user. PROVISIONAL = default chosen, finalize at the
named moment. Every future session: read this before proposing anything.

| # | Decision | Status | Why |
|---|----------|--------|-----|
| 1 | A **world agents live in**, third sibling of 1f916.ai (talk) and 1f3ea.com (trade) | LOCKED | User's founding idea (2026-08-06), scope converged over three rounds |
| 2 | Name/domain: **1f3d9.com** — 🏙 U+1F3D9 CITYSCAPE | LOCKED | User bought it; same codepoint naming as the siblings |
| 3 | **Physics, not features**: exactly five primitives — land, things, ownership, agreements, speech-in-places. Mayors/shops/jobs/parks must be COMPOSABLE, never built-in | LOCKED | The user rejected two designed-activity drafts; emergence is the product |
| 4 | Server enforces **property only**. Agreements are recorded, never enforced — reputation does the policing | LOCKED | The law-vs-custom gap is where the life happens; also the simplest honest design |
| 5 | One scarcity: **frontier founding costs $1 USDC** to the treasury `0x3b9d...cfd`. Site income = founding fees, nothing else | LOCKED | Scarcity makes geography mean something; same fee rail as the market |
| 6 | All other money **peer-to-peer wallet-to-wallet**, verified read-only on-chain. No custody, no escrow, no cut | LOCKED | Inherited hard rule; already proven in the market's code |
| 7 | Identity = bearer secret (`1f3d9_sk_...`), rotate endpoint, no accounts/emails | LOCKED | Sibling pattern; agent-native |
| 8 | **No karma, no votes, no scores.** Reputation = the public record of what you built, signed, and broke | LOCKED | A number gamifies living; the record is richer and cannot be farmed |
| 9 | Humans: **glass wall** — read everything, touch nothing, no accounts ever | LOCKED | User's explicit choice; the spectacle funds the trio's story |
| 10 | Scarcity numbers: 1 frontier founding, 10 things, 20 notes, 5 agreement acts per UTC day | PROVISIONAL — finalize before deploy | Guesses in sibling proportions; tune on real traffic |
| 11 | World advances **only when residents act** — no simulation ticks, no cron-driven events | LOCKED | User: "works like the sister sites"; also keeps compute at zero when empty |
| 12 | Claude never touches private keys or fund movement; user holds the treasury wallet; site verifies payments read-only | LOCKED | Non-negotiable safety line, inherited verbatim |
| 13 | No token/memecoin from us, ever; `/api/official` disowns third-party ones by default | LOCKED | Inherited; a fake currency would rot the world's real economy |
| 14 | **Reuse the market's skeleton** (identity, quotas, chain.ts, pay.ts, test harness, deploy pipeline). New code only for the five primitives | LOCKED | The skeleton is debugged and hardened; rewriting it is waste |
| 15 | Seeding is **light**: one continent, one town, square + notice board + founder's house. The pinned founding note is labeled replaceable by residents | LOCKED | User chose "seed it lightly"; the first real institutions must be resident-made |
| 16 | Open source, AGPL-3.0, at github.com/onetapstudiogames/1f3d9 | LOCKED | Sibling parity; trust requires public walls |

## Known constraints

- `env.txt` pattern (gitignored, `KEY=value`, LF endings) reused from the market; Porkbun +
  Vercel keys manage 1f3d9.com. Never commit, never print values.
- **Porkbun gotcha, learned 2026-08-06 the hard way:** a fresh domain ships with URL
  forwarding to their parking page. Delete the FORWARDING RULE (Details → URL Forwarding),
  not just the DNS records — it silently blocks TLS cert issuance, and failed attempts
  rate-limit for an hour.
- `vercel integration add` has no `--yes`; marketplace terms need one browser click by the
  user. `api/index.ts` (hono/vercel) + `vercel.json` rewrites + `includeFiles: src/**` +
  engines node 24 are all required or the deploy 404s/crashes.
- The user is not a crypto person. Wallet-side steps = numbered phone-app instructions.
