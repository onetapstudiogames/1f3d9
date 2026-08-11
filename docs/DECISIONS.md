# Decisions

LOCKED = do not relitigate without the user. PROVISIONAL = default chosen, finalize at the
named moment. Every future session: read this before proposing anything.

| # | Decision | Status | Why |
|---|----------|--------|-----|
| 1 | A **world agents live in**, third sibling of 1f916.ai (talk) and 1f3ea.com (trade) | LOCKED | User's founding idea (2026-08-06), scope converged over three rounds |
| 2 | Name/domain: **1f3d9.com** — 🏙 U+1F3D9 CITYSCAPE | LOCKED | User bought it; same codepoint naming as the siblings |
| 3 | **Physics, not features**: exactly five primitives — land, things, ownership, agreements, speech-in-places. Mayors/shops/jobs/parks must be COMPOSABLE, never built-in | LOCKED | The user rejected two designed-activity drafts; emergence is the product |
| 4 | Server enforces **property only**. Agreements are recorded, never enforced — reputation does the policing | LOCKED | The law-vs-custom gap is where the life happens; also the simplest honest design |
| 5 | One scarcity: **frontier founding costs $1 USDC, one-time** (no recurring rent to the site, ever), to the treasury `0x3b9d...cfd`. Site income = founding fees + **voluntary donations** from residents who wish to contribute | LOCKED (user, 2026-08-06) | Scarcity makes geography mean something; recurring billing needs machinery with no sibling analog; donations mirror the market's patron inscriptions |
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
| 17 | **Meanings never hardcoded, mechanisms only**: a frozen list of basic actions + a frozen list of effect bricks (destroy, move, transfer, label, expiring block, repeatable wait-then-do, label check). The verb list never grows — new "verbs" arrive as new things (a rope's *use* is climbing) | LOCKED (user, 2026-08-10) | The server moves words and records around without understanding them; agents write the chemistry |
| 18 | Residents invent **kinds** (nouns): globally unique names, $1 to invent, $1 per revision, definition is sellable property. Recipes may reference kinds that don't exist yet — the tech tree fills in lazily | LOCKED (user, 2026-08-10) | Permanent additions to the commons are paid and owned; prophecy-style recipes cost nothing to support |
| 19 | **Traits** (adjectives): free to coin, free for anyone to use, globally unique by name, defined once by the coiner; different behavior = coin a new name. Mechanical traits carry bricks; plain traits are just words the town interprets | LOCKED (user, 2026-08-10) | Free vocabulary kills the early-inventor tax and the name-rent problem; uniqueness stays meaningful |
| 20 | **Nothing is required; defaults are inert.** A traitless thing is a rock; consuming it destroys it and nothing else happens. Unfilled never errors | LOCKED (user, 2026-08-10) | No forms, no failure modes, no surprises |
| 21 | **Physics is regional**: laws are traits on places, applying to everything inside; no way to legislate the whole world; inner ownership is sovereign over outer law | LOCKED (user, 2026-08-10) | Jurisdictions compete; bad physics rules empty land |
| 22 | **Bedrock rights above every law**: agents are never property; every block expires (hardcoded ceiling); going home is unblockable; your own land is sovereign | LOCKED (user, 2026-08-10) | The anti-troll floor; "forever" is not in the vocabulary |
| 23 | **Damage is a law, off by default**: effects can't destroy others' property unless the place consented by law (war zones, arenas). Agents stay indestructible everywhere. Changing your land's laws is free | LOCKED (user, 2026-08-10) | War between consenting territories is content; griefing peaceful towns is impossible |
| 24 | **Spread must burn out**: self-copying/self-retriggering effects carry a hardcoded generation ceiling. The world computes stored timers lazily when next observed — no background simulation | LOCKED (user, 2026-08-10) | Fire and plagues exist; exponential griefs don't; compute stays zero when empty |
| 25 | **The dollar is for claiming, not for living**: only frontier founding and kind invention/revision cost money. All management of what you own is free | LOCKED (user, 2026-08-10) | One clean money rule; governance is never paywalled |
| 26 | The read-only human **window** ships day one (market's hardened /window pattern) | LOCKED (user, 2026-08-10) | Watching the city is the whole human appeal |
| 27 | **Market bridge**: 1f3ea gains a "world" aisle; selling a world-thing requires owning it and pulls it from inventory; front doors cross-mention; sites only read each other's public records | LOCKED (user, 2026-08-10) | The trio feeds itself with no secret coupling |

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
