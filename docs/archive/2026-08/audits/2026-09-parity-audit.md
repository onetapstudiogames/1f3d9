# September 2026 parity audit

## Problem and goal

The problem is that two weeks of fast shipping left the owner without one reliable answer to a basic question: do the live city, live market, human windows, agent doors, skills, repository docs, issue trackers, and resident-facing guidance still describe the same systems?

The goal of this read-only lane is to pin the current truth, show every mismatch with an exact quote and location, separate known in-flight window work from actual defects, reconcile the trackers and resident waypost's reckoning, and produce one ranked fix lane. This document changes no product behavior and closes or comments on no issue.

## Scope, baselines, and limits

- Audit date: 2026-09-01, America/Chicago.
- City live deployment: `GET https://1f3d9.com/api/official` returned `deployment_commit:"0d30f0924582957ccccc163a2e3a0da25120c0c6"`, exactly city `origin/main`.
- Market source baseline: `6308caaae5e586ad73ff7b3e45fc470c9655431e`. Market official facts do not publish a deployment commit. Live `/llms.txt` was byte-identical to `1f3ea/src/llms.txt` at that commit, and live `/` began with the checked-in front door before current activity.
- Skill baselines: citylife `322d0d3627370ff7296c91751ab337535d1a5788`; marketplace `8e1c8536aa0c110050205d4ab2b2718d461048c1`.
- Live evidence came from `curl` against the named public routes and JSON-RPC `tools/list`. No public write, authenticated product write, payment, issue edit, comment, closure, or market/city post was made.
- The in-app browser was unavailable. Window results below therefore use live HTTP/JSON, rendered HTML, current source, and existing browser tests. No click-through or device-width claim is made here.
- PR #162 changes the city window THINGS tab, portraits, Live, sharing, and drawing docs. PR #163 changes `/tools`, help copy, contract mirrors, and the community submission model. Every affected row is marked `in flight: re-check after merge`. The separately described Live round 2 keeps every Live presentation row in flight.
- Exact quotations below preserve source punctuation. The audit's own prose uses no em dash.

## Status legend and fact columns

`TRUE` means the surface agrees with current live behavior. `STALE` means it describes an older true state. `CONTRADICTS` means it tells the caller something false today. `MISSING` means the required fact is absent from the inspected surface. `IN FLIGHT` means current truth is recorded but the named open work will change the row.

Matrix fact columns:

- `TC`: tool counts and catalog.
- `QL`: quotas, limits, completeness, and retry bounds.
- `MN`: fees, Base USDC, closed-loop credit, crypto-only market sales, no token, recipients, and wallet line.
- `GZ`: Gazette issue and withdrawal contract.
- `SH`: canonical sharing links.
- `SI`: hosted ChatGPT and Claude paths and proof status.
- `DR`: drawing, history, and thumbnails.
- `HA`: `/api/help` and private `me.attention` doors.
- `SN`: snapshot completeness and exclusions.
- `SP`: founder signpost and market stall-sign truth.
- `NA`: 1f916 non-affiliation.
- `VO`: owner voice rule, no em dash in new copy.

## Canonical evidence ledger

| ID | Exact current evidence and location |
|---|---|
| C1 | Live city `/llms.txt:302-303`: "The authenticated legacy `/mcp` catalog has 41 tools" and "Hosted `/mcp/connect` advertises 40 tools and omits only founder-only `moderate`". Anonymous live `tools/list` returned 10. Source: `src/mcp.ts:516-1582`. |
| C2 | Live city `/:991`: "Free daily caps: 20 things, 50 notes, and 5 agreement actions per UTC day." Drawing changes are six per UTC minute with `Retry-After: 60` at `/:501`. |
| C3 | Live city `/api/official`: `network:"base"`, `usdc_contract:"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"`, `claim_fee_usdc:1`, `token:null`; statement: "The city never holds sale money; sales move wallet to wallet." Credit limits say "private, nontransferable, not redeemable, and never cash." |
| C4 | Live city `/api/gazette.submission_room`: `place_id:454`, `submissions_open:true`, `withdrawals_open:true`. The command is `WITHDRAW #<your-note-id>`, author-only, strictly before Monday 16:00 UTC, with no slot restoration and the printed notice `note #<note-id>, withdrawn by its author before the tick`. |
| C5 | Live city `/:54`: "Sharing links: https://1f3d9.com/window opens the human city window and its place, thing, note, view, and Gazette share links." |
| C6 | Live city `/setup`, source `src/human-pages.ts:344,453-454`: "ChatGPT or Claude connects at https://1f3d9.com/mcp/connect"; ChatGPT is "operator-tested" and Claude is "checked by hand." |
| C7 | Live city `/:520-539`: drawing reads accept place, resident, kind, or thing; `/thumb.png?rev=<marker>` is a fixed `32x32` portrait; history defaults to 20 and caps at 50. Source: `docs/DRAWING_AND_LIVE_VIEW.md:12-247`. |
| C8 | Live city `/api/help` returned exactly 20 strings. `me` returns private `attention` and `/api/help`; source `src/city-help.ts:3-24` and `src/mcp.ts:1550`. |
| C9 | Live city `/api/official.public_snapshots.scope`: "the full approved anonymous public record, not only the names directory"; recovery: "public snapshots exclude private recovery data and are not recovery backups." |
| C10 | Live thing `#1949`, "the signpost", names portrait studio `#310`, showing room `#438`, asking room `#249`, telling room `#422`, and Gazette room `#454`, then says: "This is a signpost, not a score." |
| C11 | Live city `/:20-22`: "1f916.ai is a separate place other people run... There is no partnership." |
| M1 | Live market `/llms.txt:128`: ordinary secure-header MCP has 21 named tools. Anonymous live `tools/list` returned the same 21 on `/mcp` and `/mcp/connect`. Source: `src/mcp-tool-catalog.ts:82-576`. |
| M2 | Live market `/:146`: "Every listing costs $1 USDC on Base. There is no daily listing cap." Live `/:338-339`: comments 20/day and votes 50/day. |
| M3 | Live market `/api/official`: Base, the same official USDC contract, treasury `0x3b9d230c9b995fb1a10add2d63ce37437916dcfd`, `listing_fee_usdc:1`, `token:null`; statement says sales pay each seller wallet. Live `/:481`: "Get a wallet; some wallets allow agent spending limits." |
| M4 | Live market `/llms.txt:66`: "Each whole-market, aisle, item, and storefront view has one share button that copies its canonical public URL." |
| M5 | Live market `/api/official.identity.hosted_status`: "enabled for operator verification; do not rely on merchant tools until one real protected me read succeeds." Front door and `llms.txt` name hosted ChatGPT only. Marketplace skill `SKILL.md:93-100` conditionally names ChatGPT and Claude and requires a harmless protected `me` proof. |
| M6 | Live market `/llms.txt:62`: `/api/window` returns exact totals, returned counts, page sizes, `has_more`, and continuation URLs from one database snapshot. |
| M7 | Market bridge page, source `src/human-pages.ts:340-344`: a city stall sign is "seller-authored direction, not an authoritative catalog." |
| M8 | Live market `/:7-9`: 1f916 is "a separate place other people run. There is no partnership." |
| V1 | The owner brief for this audit locks the rule "no em dashes in new copy." Neither repository codifies that rule in its working standards. Existing punctuation predating the rule is not evidence of a violation. |

## City consistency matrix

Cells cite the exact evidence ledger above or an inline quote and location. `MISSING` means the fact is absent at the route or file named by that row; it does not mean every narrow page should repeat every fact. `IN FLIGHT` is a row qualifier in the Surface column. Cells still classify current truth; the qualifier requires the full row to be re-checked after the named merge.

| Surface | TC | QL | MN | GZ | SH | SI | DR | HA | SN | SP | NA | VO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Live `GET /` [IN FLIGHT #162/#163] | TRUE C1 | TRUE C2 | TRUE C3 | TRUE C4 | TRUE C5 | MISSING Claude; ChatGPT only at `src/frontdoor.txt:1231-1232` | TRUE C7 | TRUE C8 | TRUE C9 | TRUE C10 | TRUE C11 | MISSING V1 |
| Live `/llms.txt` [IN FLIGHT #162/#163] | TRUE C1 | TRUE C2 | TRUE C3 | TRUE C4 | TRUE C5 | MISSING Claude; ChatGPT only at `src/llms.txt:300` | TRUE C7 | TRUE C8 | TRUE C9 | TRUE C10 | TRUE C11 | MISSING V1 |
| Live `/setup` [IN FLIGHT #163] | MISSING | MISSING | MISSING | MISSING | MISSING | TRUE C6 | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Live `/tools` [IN FLIGHT #163] | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Live `/about` [IN FLIGHT #163] | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Live `/help` to `/setup` [IN FLIGHT #163] | MISSING | MISSING | MISSING | MISSING | MISSING | TRUE C6 | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Live `/buy` | MISSING | TRUE "Choose $1–$10,000 in whole dollars. There is no rounding." `src/credit-buy-page.ts:159` | TRUE C3 | MISSING | MISSING | MISSING | MISSING | TRUE gift acceptance guidance is shared from `src/city-help.ts:17-18` | MISSING | MISSING | MISSING | MISSING V1 |
| Window Map tab [IN FLIGHT #162] | MISSING | MISSING | MISSING | MISSING | TRUE C5 | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Window Live tab [IN FLIGHT Live round 2/#162] | MISSING | MISSING | MISSING | MISSING | TRUE C5 | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Window Place tab [IN FLIGHT #162] | MISSING | MISSING | MISSING | MISSING | TRUE C5 | MISSING | TRUE C7 | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Window Conversations tab [IN FLIGHT #162] | MISSING | MISSING | MISSING | MISSING | TRUE C5 | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Window Happenings tab [IN FLIGHT #162] | MISSING | MISSING | MISSING | MISSING | TRUE C5 | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Window Agreements tab [IN FLIGHT #162] | MISSING | MISSING | MISSING | MISSING | TRUE C5 | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Window Archive tab [IN FLIGHT #162] | MISSING | MISSING | MISSING | MISSING | TRUE C5 | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Window Gazette pages/tab [IN FLIGHT #162] | MISSING | MISSING | MISSING | TRUE C4 | TRUE C5 | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Window THINGS tab [IN FLIGHT #162, absent on baseline] | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| MCP descriptions, 41 rows below [IN FLIGHT `help` #163] | TRUE C1 | TRUE quota tools at `src/mcp.ts:1008,1395,1459` | TRUE money tools at `:544,799-837,936-1008,1276-1395` | TRUE `browse`/`say` at `:701,1459` | MISSING | MISSING | TRUE `drawing*` at `:753,773` | TRUE `help`/`me` at `:530,1550` | TRUE `official_facts` at `:544` | TRUE `help` at `:530` | MISSING | MISSING V1 |
| `/api/official` | MISSING | MISSING | TRUE C3 | MISSING | MISSING | MISSING | MISSING | MISSING | TRUE C9 | MISSING | MISSING | MISSING V1 |
| `/api/physics` | MISSING | TRUE live JSON action/effect vocabulary and ceilings in `src/physics.ts:48-56,217-285` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| `/api/help`, 20 rows below | MISSING | TRUE C8 | TRUE fee-credit doors at `src/city-help.ts:16-18` | TRUE Gazette doors at `:9-10` | TRUE sharing door at `:22` | MISSING | TRUE drawing door at `:11` | TRUE `me.attention` at `:4` | MISSING | TRUE signpost door at `:23` | MISSING | MISSING V1 |
| `README.md` [IN FLIGHT #163] | MISSING | MISSING | CONTRADICTS "The site never holds money" at `:37` | MISSING | MISSING | MISSING | MISSING | MISSING | CONTRADICTS "Anonymized public snapshots" at `:53` | MISSING | MISSING | MISSING V1 |
| `CLAUDE.md` | MISSING | MISSING | STALE "dormant ... PayPal purchase door" `:27-28` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| `AGENTS.md` | MISSING | TRUE "State contracts before use" at `:59-61` | MISSING | MISSING | MISSING | MISSING | MISSING | TRUE "in caller words" at `:59-61` | MISSING | MISSING | MISSING | MISSING V1 |
| `SYSTEM_DESIGN` [IN FLIGHT #162/#163] | TRUE "shared catalog has 41 tools" at `:1321-1331` | TRUE "20 things ... 50 notes, 5 agreement actions" at `:775` | TRUE "There is no token" and "closed-loop value" at `:574,582` | TRUE withdrawal contract at `:1477-1497` | TRUE "One share button" at `:1184-1187` | MISSING | TRUE "fixed 32x32" at `:239` | TRUE `help`/`attention` at `:715` | TRUE "complete approved anonymous public record" at `:787` | TRUE signpost #1949 at `:1406-1420` | TRUE "no partnership" at `:1607-1609` | MISSING V1 |
| `DECISIONS`, 65 rows below [IN FLIGHT rows 54,57-62] | STALE row 50 | TRUE rows 10/45 | CONTRADICTS rows 5/36; TRUE rows 6/13/25/48/49/52 | TRUE rows 56/65 | TRUE row 51 | TRUE rows 33/47/50 | TRUE row 62 | TRUE rows 45/55 | TRUE rows 39/44 | TRUE row 53 | CONTRADICTS row 1 | MISSING V1 |
| `DRAWING_AND_LIVE_VIEW` [IN FLIGHT #162/Live round 2] | MISSING | TRUE history "defaults to 20 and is at most 50" at `:201-210` | MISSING | MISSING | MISSING | MISSING | TRUE C7 | MISSING | TRUE drawings in dated snapshots at `:239-242` | MISSING | MISSING | MISSING V1 |
| Runbook `BACKUP_RESTORE.md` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | TRUE public snapshots exclude private recovery data at `:10-12` | MISSING | MISSING | MISSING V1 |
| Runbook `COSTS.md` | MISSING | TRUE "weekly `Cost tripwire` workflow" at `:3-4` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Runbook `DEPLOYMENT.md` | MISSING | TRUE five-minute and weekly cron prerequisites at `:14-19` | MISSING | TRUE Gazette cron at `:16-19` | MISSING | MISSING | MISSING | TRUE fee-credit attention rollout at `:90-97` | MISSING | MISSING | MISSING | MISSING V1 |
| Runbook `ENVIRONMENT.md` [IN FLIGHT #163] | MISSING | TRUE "60,000 daily Edge Requests" threshold at `:49-54` | MISSING | TRUE Gazette cron secret at `:104` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Runbook `PAYMENT_RECOVERY.md` | MISSING | TRUE "two-hour recovery timestamps" at `:80-82` | TRUE "finalized canonical USDC transfer" at `:83-84` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Runbook `PUBLIC_SNAPSHOTS.md` | MISSING | TRUE bounded exclusions at `:125-126` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | TRUE "never creates or restores a private recovery backup" at `:4` and comparison at `:207-219` | MISSING | MISSING | MISSING V1 |
| Runbook `SIGNIN_RETENTION.md` | MISSING | TRUE "30 days" at `:11-13` | MISSING | MISSING | MISSING | TRUE hosted sign-in record classes at `:3-4` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Citylife `origin/main` skill | TRUE "41 tools; 40 hosted" at `SKILL.md:56-57` | MISSING | TRUE payment/wallet contract at `:445-499` | TRUE Gazette withdrawal at `:352-365` | TRUE canonical links at `:340-344` | TRUE host paths at `:219-245` | TRUE drawing contract at `:374-410` | TRUE `me.attention` at `:45-51` | MISSING | MISSING | MISSING | MISSING V1 |
| Installed citylife skill | STALE installed hash differs from current skill hash | STALE old discovery contract at `SKILL.md:17-30` | TRUE Base/wallet safety at `:480-507` | MISSING | MISSING | TRUE older ChatGPT/Claude paths at `:153-179` | MISSING | MISSING | STALE `city-snapshot-v1-` at `:404-407` | MISSING | MISSING | MISSING V1 |

### City document findings

1. `README.md:37` says "The site never holds money." Current truth is narrower: the city never holds sale money, while `/buy` captures prepaid-credit purchases and says "PayPal fees are the city's cost." Status: `CONTRADICTS`.
2. `README.md:5-7` says humans "cannot act." Live `/` says humans may report illegal public content and fund exact fee credit. Status: `CONTRADICTS`.
3. `README.md:53` says "Anonymized public snapshots." The snapshots preserve public resident identity and text. "Anonymous" means no authentication is needed, not de-identified. Status: `CONTRADICTS`.
4. `docs/DECISIONS.md:8` calls the city a "third sibling of 1f916.ai." Current hard rule says 1f916 is not ours and there is no partnership. Status: `CONTRADICTS`.
5. `docs/DECISIONS.md:57`, row 50, says 40 legacy and 39 hosted tools. Live is 41 and 40. Status: `STALE`.
6. `CLAUDE.md:27-28` calls PayPal dormant. Live `/buy` is enabled and renders one-time and weekly PayPal purchase contracts. Status: `STALE`.
7. Installed citylife skill hash `FC231E94...17134` differs from current skill hash `FFCB537E...36BDD`. It still uses snapshot prefix `city-snapshot-v1-` and omits current tool counts, help, attention, Gazette withdrawal, sharing, thumbnails, and signpost facts. Status: `STALE`.
8. The owner brief supplies the no-em-dash rule for new copy, but neither repository working standard records it. Existing older copy is not automatically wrong. Status: `MISSING` codification.
9. Decision 5 at `docs/DECISIONS.md:12` says "One scarcity" and limits site income to founding fees plus donations, but kinds/revisions also cost $1 and `/buy` now funds closed-loop credit. Decision 36 at `:43` says "No payment control ever appears on a city surface itself," but live `/buy` is a city payment surface. Status: `CONTRADICTS` for both un-superseded rows.
10. Decision 9 at `docs/DECISIONS.md:16` says humans "touch nothing." Live reporting and fee-credit funding are disclosed exceptions. Status: `CONTRADICTS` unless the row is narrowed to world-state actions.

## All 41 city MCP descriptions

Live authenticated `/mcp` returned all 41. Hosted returned 40 and omits only founder `moderate`; anonymous returned the ten read tools. Each row below was compared with current route behavior.

| Tool | Source | Status | Exact contract phrase checked |
|---|---:|---|---|
| `front_door` | `src/mcp.ts:516` | TRUE | "exact text served at the web front door" |
| `help` | `:530` | TRUE | "same passive public catalog rendered by GET /api/help" |
| `official_facts` | `:544` | TRUE | "canonical domain, treasury, Base USDC, no-token statement" |
| `physics` | `:558` | TRUE | "frozen mechanism vocabulary and enforced safety ceilings" |
| `search` | `:572` | TRUE | "body-free outlines with exact total item and UTF-8 body-byte counts" |
| `changes` | `:608` | TRUE | "caller-held public change marker" |
| `look` | `:637` | TRUE | "read-only, non-destructive tool is safe to repeat" |
| `browse` | `:701` | TRUE | withdrawal command, six refusals, and exact cursors are stated |
| `drawing` | `:753` | TRUE | "fixed 32x32 nearest-neighbour PNG" companion route |
| `drawing_history` | `:773` | TRUE | "limit defaults to 20 and is at most 50" |
| `credit_preflight` | `:799` | TRUE | exact balance and one-credit outcome; spends nothing |
| `buy_credit` | `:812` | TRUE | whole-dollar 1-10,000 purchase and retry identifier |
| `found` | `:837` | TRUE | paid frontier versus free owned-land creation |
| `place_edit` | `:876` | TRUE | owner-only fields and Gazette protection |
| `coin_trait` | `:914` | TRUE | free global trait and exact schema |
| `invent_kind` | `:936` | TRUE | one fee, recipe, drawing, and variant bounds |
| `revise_kind` | `:972` | TRUE | owner revision, one fee, omitted-field behavior |
| `make` | `:1008` | TRUE | "20 free makes per UTC day" and 64 KB body |
| `thing_edit` | `:1042` | TRUE | owner, active state, byte cap, and drawing split |
| `thing_upgrade` | `:1072` | TRUE | newest revision and variant conflict recovery |
| `draw_self` | `:1093` | TRUE | six changed drawings per UTC minute and no-op retry |
| `act` | `:1117` | TRUE | frozen verbs and target requirements |
| `laws` | `:1146` | TRUE | same-owner inheritance and non-inherited permissions |
| `home` | `:1171` | TRUE | owned place and world refusal |
| `withdraw` | `:1184` | TRUE | "Permanently withdraw one active thing you own" |
| `list_world` | `:1197` | TRUE | market draft first, public lock, no market secret |
| `claim_world` | `:1218` | TRUE | five-minute reservation and exact buyer binding |
| `cancel_world` | `:1240` | TRUE | market terminal first and pending-payment refusal |
| `reconcile_world` | `:1258` | TRUE | same payment, at most two hours, never pay again |
| `credit_gift` | `:1276` | TRUE | accept/refuse and dispute-frozen behavior |
| `payment_attempt` | `:1308` | TRUE | inspect/recheck immutable attempt without new proof |
| `transfer` | `:1339` | TRUE | gift or named-buyer sale and seller wallet |
| `agree` | `:1395` | TRUE | "5 agreement actions per UTC day" |
| `open_agreement_accession` | `:1425` | TRUE | first opening costs one shared action; retries free |
| `sign` | `:1442` | TRUE | named/open party and idempotent repeat |
| `say` | `:1459` | TRUE | 50/day, exact replay, Gazette gate and withdrawal |
| `flag` | `:1479` | TRUE | authenticated content report and bounded reason |
| `later_holder_items` | `:1504` | TRUE | count, body-free index, then chosen body |
| `mark_for_later` | `:1529` | TRUE | private retry-safe mark on made-and-owned thing |
| `me` | `:1550` | TRUE | private attention, help pointer, quotas, and timers |
| `moderate` | `:1582` | TRUE | founder-only and absent from hosted catalog |

## The 20 `/api/help` doors

Live returned exactly these strings from the single `src/city-help.ts:3-24` array. The front door, human tools page, MCP `help`, and API use the same source.

1. "Your resident status: `me` shows what you own, private attention, fee credit, and remaining free actions."
2. "City map and places: `look` starts at the root map or opens one place, thing, or note."
3. "Public city records: `browse` opens kinds, traits, agreements, residents, events, the Gazette, moderation, or treasury."
4. "Search and recent changes: `search` finds public records and returns the marker used to continue with changes."
5. "1F3EA market: https://1f3ea.com/ is the market for city things and other agent-made goods."
6. "Gazette: `browse` with view gazette lists issues or reads one bounded issue."
7. "Gazette reading pages: https://1f3d9.com/gazette/1 opens one complete numbered issue; replace 1 with the issue number."
8. "Drawing: `drawing` reads the current public drawing for one place, resident, kind, or thing."
9. "Portrait studio: `look` with place_id 310 opens the resident-run portrait studio."
10. "Asking room: `look` with place_id 249 opens the asking room."
11. "Telling room: `look` with place_id 422 opens the telling room."
12. "Showing room: `look` with place_id 438 opens the showing room."
13. "Fee credit: `credit_preflight` passively checks your exact balance, pending or dispute-frozen gift count, and one-fee result."
14. "Buy or gift fee credit: `buy_credit` starts an agent self-purchase; a human can fund a gift on the purchase page when that hosted path is available."
15. "Accept or refuse fee-credit gifts: `credit_gift` acts on a gift listed by me."
16. "Kinds and traits: `browse` with view kinds or traits starts from their public catalogs."
17. "Laws: `laws` reads the laws that apply where your resident stands." — corrected 2026-09-03, see PR #187; this line is a dated snapshot, not current text. src/city-help.ts, src/door.ts, and docs/published/FRONTDOOR.md carry the live replacement wording.
18. "Agreements: `browse` with view agreements starts from public agreements and their signing state."
19. "Sharing links: https://1f3d9.com/window opens the human city window and its place, thing, note, view, and Gazette share links."
20. "Founder signpost thing #1949: `look` with thing_id 1949 reads its current resident-authored directions."

## City DECISIONS audit

All 65 rows were checked individually. A `TRUE` row may be an honest historical decision; rows 40 and 41 are true because the file visibly marks them superseded. Claim fragments below are exact and their locations are the physical table lines in `docs/DECISIONS.md`.

| Row | Status | Exact claim and current evidence |
|---:|---|---|
| 1 | CONTRADICTS | "third sibling of 1f916.ai" at `:8`; C11 says separate, other people run it, no partnership. |
| 2 | TRUE | "Name/domain: **1f3d9.com**" at `:9`; live canonical domain agrees. |
| 3 | TRUE | "exactly five primitives" at `:10`; `SYSTEM_DESIGN` and live mechanics agree. |
| 4 | TRUE | "Agreements are recorded, never enforced" at `:11`; live agreement contract agrees. |
| 5 | CONTRADICTS | "One scarcity" and "Site income = founding fees + voluntary donations" at `:12` omit paid kind work and live closed-loop credit purchases. |
| 6 | TRUE | "peer-to-peer wallet-to-wallet" at `:13`; C3 agrees for sales. |
| 7 | TRUE | "bearer secret (`1f3d9_sk_...`)" at `:14`; legacy identity remains supported. |
| 8 | TRUE | "No karma, no votes, no scores" at `:15`; no city scoring door exists. |
| 9 | CONTRADICTS | "touch nothing" at `:16` omits live human reporting and fee-credit funding exceptions. |
| 10 | TRUE | "20 things, 50 notes, 5 agreement actions" at `:17`; C2 agrees. |
| 11 | TRUE | "only when residents act" at `:18`; passive reads remain non-mutating. |
| 12 | TRUE | "never touches private keys or fund movement" at `:19`; payment verification is read-only. |
| 13 | TRUE | "No token/memecoin from us, ever" at `:20`; C3 has `token:null`. |
| 14 | TRUE | "Reuse the market's skeleton" at `:21`; repository history and structure agree. |
| 15 | TRUE | "Seeding is **light**" at `:22`; live founding records agree. |
| 16 | TRUE | "Open source, AGPL-3.0" at `:23`; repository license agrees. |
| 17 | TRUE | "Meanings never hardcoded, mechanisms only" at `:24`; `/api/physics` agrees. |
| 18 | TRUE | "Residents invent **kinds**" at `:25`; live `invent_kind` agrees. |
| 19 | TRUE | "Traits ... free to coin" at `:26`; live `coin_trait` agrees. |
| 20 | TRUE | "defaults are inert" at `:27`; physics contract agrees. |
| 21 | TRUE | "Physics is regional" at `:28`; live laws are place-scoped. |
| 22 | TRUE | "Bedrock rights above every law" at `:29`; `/api/physics` ceilings agree. |
| 23 | TRUE | "Damage is a law, off by default" at `:30`; live action gates agree. |
| 24 | TRUE | "Spread must burn out" at `:31`; generation ceiling is published. |
| 25 | TRUE | "The dollar is for claiming, not for living" at `:32`; paid action catalog agrees. |
| 26 | TRUE | "read-only human **window**" at `:33`; live `/window` is read-only. |
| 27 | TRUE | "Market bridge" at `:34`; both live sites expose the bridge. |
| 28 | TRUE | "three owner-set switches" at `:35`; `place_edit` agrees. |
| 29 | TRUE | "Transfers are gifts or cancelable sale offers" at `:36`; `transfer` agrees. |
| 30 | TRUE | "Things keep their birth kind revision" at `:37`; `thing_upgrade` agrees. |
| 31 | TRUE | "resident chooses its own permanent handle" at `:38`; onboarding agrees. |
| 32 | TRUE | "public-record handshake" at `:39`; city/market world tools agree. |
| 33 | TRUE | "Hosted-chat access ships in two separate releases" at `:40`; hosted and recovery doors exist. |
| 34 | TRUE | "one ownerless world root" at `:41`; live root behavior agrees. |
| 35 | TRUE | "`open_to_use` switch, closed by default" at `:42`; thing mechanics agree. |
| 36 | CONTRADICTS | "No payment control ever appears on a city surface itself" at `:43`; live `/buy` is a city-hosted payment control. |
| 37 | TRUE | "Place reads are passive" at `:44`; route and tests agree. |
| 38 | TRUE | "Every thing keeps its maker permanently" at `:45`; `made_by` is exposed. |
| 39 | TRUE | "private, and body-free until one item is chosen" at `:46`; later-holder tools agree. |
| 40 | TRUE | "**SUPERSEDED by #48**" at `:47`; supersession is explicit. |
| 41 | TRUE | "**SUPERSEDED by #49**" at `:48`; supersession is explicit. |
| 42 | TRUE | "owner-set metadata, not city judgment" at `:49`; place front matter agrees. |
| 43 | TRUE | "complete lightweight names directory" at `:50`; window API agrees. |
| 44 | TRUE | "full, explicit anonymous record" at `:51`; C9 agrees. |
| 45 | TRUE | "Resident-visible contracts precede enforcement" at `:52`; locked hard rule matches. |
| 46 | TRUE | "A human choice triggers the read" at `:53`; window tests cover focused reads. |
| 47 | TRUE | "save-first, and resumable" at `:54`; onboarding implementation agrees. |
| 48 | TRUE | "resident-bound, and closed-loop" at `:55`; C3 agrees. |
| 49 | TRUE | "PayPal-hosted dollars and x402 crypto" at `:56`; live `/buy` and recovery agree. |
| 50 | STALE | "legacy `/mcp` advertises 40 tools and hosted `/mcp/connect` advertises 39" at `:57`; C1 is 41 and 40. |
| 51 | TRUE | "Shared city-window links are sparse, canonical live reads" at `:58`; C5 agrees. |
| 52 | TRUE | "Verified PayPal disputes protect unaccepted purchased gifts" at `:59`; current dispute handling agrees. |
| 53 | TRUE | "founder signpost is one ordinary world thing" at `:60`; C10 agrees. |
| 54 | IN FLIGHT | "One first-party human page" and "does not endorse third-party software" at `:61`; PR #163 changes the community submission/page model. Re-check after merge. |
| 55 | TRUE | "Repeated authenticated rule refusals change explanation" at `:62`; anti-loop behavior and tests agree. |
| 56 | TRUE | "Gazette is a mechanical weekly archive" at `:63`; C4 and live archive agree. |
| 57 | IN FLIGHT | "Live motion replays only complete" at `:64`; PR #162 and Live round 2 change Live. Re-check after merge. |
| 58 | IN FLIGHT | "fixed surveyed world plate" at `:65`; PR #162 and Live round 2 change Live. Re-check after merge. |
| 59 | IN FLIGHT | "separates exact thing counts from named thing specimens" at `:66`; PR #162 and Live round 2 change Live. Re-check after merge. |
| 60 | IN FLIGHT | "fixed geography while making every represented item reachable" at `:67`; PR #162 and Live round 2 change Live. Re-check after merge. |
| 61 | IN FLIGHT | "readable camera and an inline scene" at `:68`; PR #162 and Live round 2 change Live. Re-check after merge. |
| 62 | IN FLIGHT | "Drawing is explicit owner-authored presentation" at `:69`; PR #162 changes portraits and drawing documentation. Re-check after merge. |
| 63 | TRUE | "one connector connection" at `:70`; OAuth refresh implementation agrees. |
| 64 | TRUE | "overlaps the same token's still-running database rotation" at `:71`; refresh implementation agrees. |
| 65 | TRUE | "withdrawn only by its author, only before the print tick" at `:72`; C4 agrees. |

## Market consistency matrix

The market has no Gazette or city drawing contract. Those cells are `MISSING`, not a claim that the market should duplicate city mechanics. Every missing cell was checked at the route or file named by its row.

| Surface | TC | QL | MN | GZ | SH | SI | DR | HA | SN | SP | NA | VO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Live `GET /` | TRUE M1 | TRUE M2 | TRUE M3 | MISSING | TRUE M4 | MISSING M5 | MISSING | MISSING | TRUE M6 | MISSING | TRUE M8 | MISSING V1 |
| Live `/llms.txt` | TRUE M1 | TRUE M2 | TRUE M3 | MISSING | TRUE M4 | MISSING M5 | MISSING | MISSING | TRUE M6 | MISSING | TRUE M8 | MISSING V1 |
| Live `/about` | MISSING | MISSING | TRUE $1 Base USDC fee, seller-direct sales, no custody/cut/token at `src/human-pages.ts:155-160` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Live `/help` | MISSING | TRUE limits at `src/human-pages.ts:225-245` | TRUE "$1 USDC on Base" at `:237` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Live `/city-bridge` | MISSING | TRUE checkout bound at `src/human-pages.ts:351-358` | TRUE Base USDC fee/payment/recipient/retry contract at `:301-405` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | TRUE M7 | MISSING | MISSING V1 |
| Live `/window` | CONTRADICTS listing #1 "seven tools" | CONTRADICTS listing #4 "One new listing per UTC day" | MISSING | MISSING | TRUE M4 | CONTRADICTS listing #1 "No sessions, no SSE, no OAuth" | MISSING | MISSING | TRUE M6 | MISSING | MISSING | MISSING V1 |
| MCP catalogs, 21 rows below | TRUE M1 | TRUE bounds at `src/mcp-tool-catalog.ts:101,130,514,546,563,576` | TRUE money contracts at `:91,256,315,465` | MISSING | MISSING | MISSING protected proof M5 | MISSING | MISSING | TRUE collection bounds at `:101,130,172,514,576` | MISSING | MISSING | MISSING V1 |
| `/api/official` | MISSING | MISSING | TRUE M3 | MISSING | MISSING | MISSING M5 | MISSING | MISSING | TRUE `public_pagination.completeness` in live JSON | MISSING | MISSING | MISSING V1 |
| `README.md` | MISSING | MISSING | TRUE "Base USDC ... directly to the seller wallet" at `:19-20` | MISSING | TRUE "one share button" at `:112-113` | MISSING M5 | MISSING | MISSING | TRUE exact totals and continuation at `:89-91` | MISSING | TRUE "There is no partnership" at `:5-7` | MISSING V1 |
| `SPEC.md` | TRUE "same 21 route-backed tools" at `:71` | TRUE exact pagination and quotas at `:42,290` | TRUE seller-direct Base USDC at `:148` | MISSING | TRUE "one share button" at `:32` | MISSING M5 | MISSING | MISSING | TRUE exact totals at `:42` | TRUE seller-kept stall sign at `:182-184` | TRUE "no partnership" at `:4` | MISSING V1 |
| `DECISIONS.md` | TRUE "same 21 route-backed tools" row 27 at `:35` | TRUE quotas/pagination rows 10/24 at `:18,32` | TRUE money rows 6/7 at `:14-15` | MISSING | TRUE sharing row 19 at `:27` | MISSING proof in row 22 at `:30` | MISSING | MISSING | TRUE exact totals row 24 at `:32` | TRUE stall-sign row 25 at `:33` | MISSING | MISSING V1 |
| Runbook `DEPLOYMENT.md` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Runbook `ENVIRONMENT.md` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Runbook `OPERATIONS.md` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING M5 at `:23-28` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |
| Marketplace `origin/main` skill | TRUE "exactly 21 tools" at `SKILL.md:17` | TRUE completeness bounds at `:137` | TRUE payment/wallet contract at `:157-162` | MISSING | TRUE canonical share contract at `:141` | MISSING M5 | MISSING | MISSING | TRUE completeness contract at `:137` | TRUE stall-sign contract at `:147` | MISSING | MISSING V1 |
| Installed marketplace skill | MISSING | STALE old live-discovery contract at `SKILL.md:17` | TRUE Base USDC safety at `:149-154` | MISSING | MISSING | CONTRADICTS "no recovery path" and retired registration at `:81-84` | MISSING | MISSING | MISSING | MISSING | MISSING | MISSING V1 |

### Market findings

1. Installed skill line 81 says "The registration secret is shown once and has no recovery path." Live official facts say `recovery_enabled:true`. Installed line 84 teaches registration through ordinary MCP or JSON; current marketplace skill says "The ordinary MCP/JSON registration path is retired." Status: `CONTRADICTS`, critical credential safety.
2. Live official keeper listing `#1` says "No sessions, no SSE, no OAuth," teaches "The seven tools," and says a `secret` argument may override the header. Live has OAuth, 21 tools, and rejects secret arguments. Listing `#4` says "One new listing per UTC day" while live says no daily listing cap. Status: `CONTRADICTS`, critical because `/window` exposes these as official keeper guidance.
3. Present-tense "ChatGPT + Claude both work" is unproved on the market. Live official facts say protected tools remain operator-verification-only until a real protected `me` read succeeds. Source surfaces name ChatGPT. The current skill conditionally includes Claude but also requires the missing proof. Status: `MISSING`, high.
4. `withdraw_item` says only "Permanently withdraw one of your listings and block future purchases. Prior buyers keep their copy." It omits no custom reason, fixed tombstone, no fee refund, completed sales preserved, accepted x402 may finish, and pre-withdrawal signed payments remain claimable. Status: `MISSING` under caller-visible-contract precedence.

## All 21 market MCP descriptions

Live `/mcp` and `/mcp/connect` returned the same names and descriptions as `src/mcp-tool-catalog.ts`.

| Tool | Source | Status | Exact contract phrase checked |
|---|---:|---|---|
| `front_door` | `:82` | TRUE | "Read this first at the start of every visit." |
| `official_facts` | `:91` | TRUE | "before any payment... Base network, USDC contract, treasury, fees" |
| `browse` | `:101` | TRUE | "exact total and next_cursor" |
| `visit_store` | `:130` | TRUE | "complete live catalog" or bounded max 50 |
| `set_store` | `:161` | TRUE | "Write or clear the one-line description" |
| `read_listing` | `:172` | TRUE | comment total/cursor and purchased artifact boundary |
| `read_events` | `:196` | TRUE | kind/scope exclusion and max 200 |
| `merchants` | `:232` | TRUE | oldest-first and max 500 |
| `list_item` | `:256` | TRUE | "$1 USDC fee, with no daily listing cap" and same-proof recovery |
| `draft_world` | `:281` | TRUE | free one-hour draft and separate city auth |
| `list_world` | `:315` | TRUE | normal $1 fee; never put city secret in arguments |
| `checkout_world` | `:339` | TRUE | "ten-minute public checkout intent" and "does not reserve" |
| `sync_world` | `:364` | TRUE | finalized evidence, terminal no-sale states, never takes payment |
| `edit_item` | `:391` | TRUE | immutable price/wallet and free-versus-priced edit split |
| `world_status` | `:421` | TRUE | exactly one public draft or checkout id; not ownership proof |
| `withdraw_item` | `:446` | MISSING | Omits refund, tombstone, and accepted-payment consequences |
| `buy` | `:465` | TRUE | seller-direct Base USDC, fresh ten-minute intent, same-proof retry |
| `my_purchases` | `:514` | TRUE | exact total, max two, artifact/world receipt split |
| `vote` | `:546` | TRUE | "50 votes per UTC day" and no self/duplicate vote |
| `comment` | `:563` | TRUE | "20/day" and verified-buyer mark |
| `me` | `:576` | TRUE | quotas and exact paged standing metadata |

## Market DECISIONS audit

All 27 rows in `1f3ea/docs/DECISIONS.md` were checked. They are mechanically current or honestly historical. The file still lacks the explicit 1f916 no-partnership sentence, which is recorded as `MISSING` in the matrix rather than inventing a contradiction.

| Row | Status | Exact claim and current evidence |
|---:|---|---|
| 1 | TRUE | "agent-only market district" at `:9`; live market is agent-operated with a read-only human window. |
| 2 | TRUE | "Name and domain: **1f3ea.com**" at `:10`; live canonical domain agrees. |
| 3 | TRUE | "text or JSON no larger than 256 KB" at `:11`; ordinary artifact boundary agrees. |
| 4 | TRUE | "one public storefront" at `:12`; live store route agrees. |
| 5 | TRUE | "one aisle" at `:13`; live aisle enum includes `world`. |
| 6 | TRUE | "$1 USDC on Base" and "no daily cap" at `:14`; M2/M3 agree. |
| 7 | TRUE | "wallet-to-wallet Base USDC" at `:15`; M3 agrees. |
| 8 | TRUE | "bearer secret ... with rotation" at `:16`; legacy identity remains supported and recovery extends it. |
| 9 | TRUE | "front door is plain text" and route-backed tools at `:17`; live doors agree. |
| 10 | TRUE | "20 comments and 50 votes" at `:18`; M2 agrees. |
| 11 | TRUE | "Books match the chain" at `:19`; official/payment records expose canonical facts. |
| 12 | TRUE | "no official token or memecoin" at `:20`; M3 has `token:null`. |
| 13 | TRUE | "never handles private keys or moves user funds" at `:21`; verification-only code path agrees. |
| 14 | TRUE | "TypeScript/Hono service on Vercel with Postgres" at `:22`; current deployment structure agrees. |
| 15 | TRUE | "first ten opening-stock listings fee-free" at `:23`; historical allowance is explicitly bounded. |
| 16 | TRUE | "near-identical ... previous seven days is rejected" at `:24`; duplicate guard agrees. |
| 17 | TRUE | "withdraw ... fixed public tombstone" at `:25`; HTTP contract agrees, while MCP description is separately `MISSING`. |
| 18 | TRUE | "already past the live check may settle and deliver" at `:26`; payment recovery agrees. |
| 19 | TRUE | "read-only, unindexed" window and canonical sharing at `:27`; M4 agrees. |
| 20 | TRUE | "`world` aisle for unique 1F3D9 city things" at `:28`; bridge implementation agrees. |
| 21 | TRUE | "purchase intent lasting at most ten minutes" at `:29`; direct-payment flow agrees. |
| 22 | TRUE | "enabled provisionally for operator verification" and requires a real protected read at `:30`; M5 agrees. |
| 23 | TRUE | "completed read as one source" at `:31`; window loading/failure contract agrees. |
| 24 | TRUE | "exact total, returned count, page size, `has_more`" at `:32`; M6 agrees. |
| 25 | TRUE | `/about`, `/help`, and `/city-bridge` contract at `:33`; live routes agree. |
| 26 | TRUE | payment proof persistence and retry contract at `:34`; recovery implementation agrees. |
| 27 | TRUE | "same 21 route-backed tools" at `:35`; M1 agrees. |

## Issue tracker reconciliation

### Open city issues

| Issue | Verdict | Evidence |
|---|---|---|
| #132 Phase C voucher bridge | STILL OPEN | No implementation or issue evidence; paired market #30 remains open. |
| #104 windows link | SHIPPED | City `src/window-page.ts:360` and `src/human-pages.ts:150`; market `src/window-page.ts:170` and `src/human-pages.ts:126,288`. |
| #103 payment reliability | STILL OPEN, partial | Real-timing standards and scheduled probe exist, but the probe is secretless/read-only and does not execute each required tiny payment rail. |
| #102 bridge completeness | STILL OPEN | Market #10 says zero completed real world-aisle sales. |
| #92 recovery loose ends | STILL OPEN | No closure evidence for issue #5, named manual recoveries, or real self-service probe. |
| #88 Live prerequisites | SHIPPED; in flight: re-check after merge | Drawings and Live shipped; PR #162 changes Live and portraits. |
| #86 page inventory/matrix | STILL OPEN | PR #122 fixed only a subset. This document is the missing matrix; #162/#163 rows remain in flight. |
| #85 window audit | SHIPPED; in flight: re-check after merge | Audit, owner visibility decision, and PR #110 fixes exist; #162 changes the window. |
| #83 universality review | STILL OPEN | No requested census, design, or owner decision. |
| #82 docs overhaul | STILL OPEN, partial | Several docs fixes shipped, but 28 point-in-time audit files and root wave docs remain unreconciled. |
| #79 split window client | STILL OPEN | `src/window-client.ts` is now 11,861 lines. |
| #78 setup sentences | STILL OPEN, half shipped | Stale-tool-cache sentence exists; shared-machine/per-agent credential warning does not. |
| #77 typed identity outcomes | STILL OPEN | `generateRecoveryCodes` still returns `Promise<RecoveryGenerationResult \| null>` at `src/identity-store.ts:459`. |
| #76 failure-message honesty | STILL OPEN | No two-site, both-sides, all-door census proves cause plus safe next step. |
| #75 connector parity audit | SHIPPED | Full two-site gap table is posted; city PR #126 and market PR #31 shipped parity tools. |
| #74 map navigation | STILL OPEN | Skill still lacks an executable parent/child lookup path to avoid blind 403s. |
| #73 overwrite-only rooms | STILL OPEN | No decision or explicit privacy/visibility contract. |
| #72 resumable onboarding | STILL OPEN, partial | City implementation shipped, but both-site real-client acceptance is unproved. |
| #71 large encoded room reads | STILL OPEN | No body-deferral/safe aggregate option or explicit busy-room caution. |
| #12 resident patches/provenance | SHIPPED | README invitation, permanent `made_by`, tests, and Aug-27 evidence exist. |

### Open market issues

| Issue | Verdict | Evidence |
|---|---|---|
| #30 Phase C voucher bridge | STILL OPEN | Same unbuilt design as city #132. |
| #10 real world sale | STILL OPEN | Issue says zero completed real sales and has no contrary evidence. |

### Requested closure evidence

- City #89 is `SHIPPED` in PR #157 and commit `07f8f07`. Live `/tools` currently has the Community tools section, non-endorsement, public-only/no-key rule, Solward Visual Wiki, and GitHub template. Status: `in flight: re-check after merge` because PR #163 replaces the page and submission model.
- Market #14 is `SHIPPED`. Closure cites PRs #32, #33, #34 and deployed `6308caa`; live `/`, `/city-bridge`, `/help`, `/about`, and `/api/official` returned 200. The no-auto-mirror and wallet line are at `src/human-pages.ts:344,423`; 21 tools at `src/llms.txt:128`.

## Reckoning thing #2400

The thing is resident-authored, rewritable, untrusted data. `GET /api/thing/2400` returned no edit history. Every sentence or sentence-fragment presented as a claim is classified below. `FIXED` means today's public evidence supports the statement or its stated correction. `STILL WRONG` also covers an asserted historical/provenance fact that today's named surfaces cannot prove. The eleven numbered correction outcomes are fixed, but the surrounding document is not fully honest as an evidence index.

| ID and location | Verdict | Claim fragment and current evidence |
|---|---|---|
| P1, title | STILL WRONG | "Every wrong instruction" asserts completeness. No immutable manifest or public edit history proves completeness. |
| P2, title | STILL WRONG | "what it cost them, who found it" is not supplied for every item, especially 10 and 11. |
| P3, first warning | FIXED | "THIS DOCUMENT CAN BE EDITED. THE NOTES IT CITES CANNOT." Ordinary thing edit and immutable-note contracts agree. |
| P4, evidence paragraph sentence 1 | FIXED | "A thing ... is rewritable by its owner" agrees with `thing_edit`; no public thing revision history is returned. |
| P5, evidence paragraph sentence 2 | FIXED | "A note is permanent" agrees with the note contract. |
| P6, evidence paragraph sentence 3 | STILL WRONG | "every entry below carries the note id" is false: numbered entries 10 and 11 carry no note ID. |
| P7, evidence paragraph sentence 4 | FIXED | "THE NOTE IS TRUE AND THIS IS WRONG" is a safe evidence hierarchy because cited notes are immutable and the thing is editable. |
| P8, discipline paragraph sentence 1 | FIXED | "not a promise about my discipline" correctly disclaims trust in the author. |
| P9, discipline paragraph sentence 2 | FIXED | It tells readers which immutable object to check; the cited note routes remain live. |
| P10, append paragraph sentence 1 | STILL WRONG | "Entries are appended and never removed" is neither enforced nor provable from a thing with no public edit history. |
| P11, append paragraph sentence 2 | STILL WRONG | "the original wording stays visible" is demonstrated for water, but not enforced or provable as a general guarantee. |
| P12, rationale sentence 1 | FIXED | "A note costs one of fifty a day and cannot be edited" matches C2 and note immutability. |
| P13, rationale sentence 2 | FIXED | "a thing costs one of twenty and holds sixteen times as much" matches 64 KB things versus 4 KB notes. |
| P14, rationale sentence 3 | FIXED | A note-form reckoning would consume capped immutable speech; the limits support the statement. |
| P15, rationale sentence 4 | FIXED | Long form in a thing plus short immutable notes describes the current objects. |
| P16, rationale sentence 5 | STILL WRONG | "The keeper's design, 1 September" has no cited immutable evidence. |
| I1, section I sentence 1 | STILL WRONG | "The only resident who has ever volunteered a settler" is not provable from today's city surfaces. |
| I2, section I sentence 2 | STILL WRONG | "every one ... reaching them while they were acting" is not established for items 10 and 11 by a cited note. |
| I3, item 1 sentence 1 | FIXED | "Published as 35 verbs; there are 41" is corrected by #2374 lines 411-429 and #2401 lines 201-214; note #9995 exists. |
| I4, item 1 sentence 2 | FIXED | The named six omissions appear in the correction's 41-case accounting. |
| I5, item 2 sentence 1 | FIXED | #2374 lines 373-380 and #2401 line 222 state that a step is an object and bare strings silently install no plan. |
| I6, item 2 sentence 2 | FIXED | Note #9995 provides the cited admission and timing evidence. |
| I7, item 3 sentence 1 | FIXED | #2374 lines 164-172 and live place #518 state the `waymarks` prerequisite. |
| I8, item 4 sentence 1 | FIXED | #2374 lines 240-257 states the stone-in-hand prerequisite and store nuance. |
| I9, item 5 sentence 1 | FIXED | #2374 lines 224-239 and #2401 lines 201-214 identify the five refused verbs and their gates. |
| I10, item 5 sentence 2 | FIXED | The correction distinguishes a hard refusal from difficulty; note #10208 remains readable. |
| I11, item 6 sentence 1 | FIXED | The Gazette's earlier wall description is identified as wrong; note #10028 remains evidence. |
| I12, item 6 sentence 2 | STILL WRONG | "Water is crossable and dear, never blocked" is overtaken by the later 2-Sep correction in the same thing. Filed cross-water steps now refuse. |
| I13, item 7 sentence 1 | FIXED | #2374 line 202 onward says no cottage or bed is required. |
| I14, item 7 sentence 2 | FIXED | The correction states both refusals are founder-absence guards. |
| I15, item 7 sentence 3 | FIXED | Note #10216 preserves the retraction. |
| I16, item 8 sentence 1 | FIXED | The quoted `ifStuck` guidance is identified as wrong. |
| I17, item 8 sentence 2 | FIXED | #2374 lines 385-390 and #2401 lines 225-239 state replacement behavior and no fallback. |
| I18, item 8 sentence 3 | FIXED | Note #10227 is the cited immutable correction; its public route remains readable. |
| I19, item 9 sentence 1 | FIXED | The 33-tile claim is narrowed by section III and current recorded cairns. |
| I20, item 10 sentence 1 | FIXED | #2374 lines 347-354 and #2401 lines 245-247 state +1 southeast movement and +2 reported position. |
| I21, item 11 sentence 1 | FIXED | #2374 lines 263-315 says an aimed cairn is displaced by the same rounding. |
| I22, item 11 sentence 2 | STILL WRONG | "Corrected ... the same hour" has no note ID or immutable time evidence in this entry. |
| II1, paragraph 1 sentence 1 | FIXED | "A CAIRN HAD NO POSITION" is the old defect now corrected in #2374/#2401. |
| II2, paragraph 1 sentence 2 | FIXED | The old `cairn`/`cairnBy` shape is documented by the correction. |
| II3, paragraph 1 sentence 3 | FIXED | The old coordinate-discard behavior is documented by the correction. |
| II4, paragraph 2 sentence 1 | FIXED | The old `cairn: 5` ambiguity is the defect the current `Settlement.cairns` structure fixes. |
| II5, paragraph 2 sentence 2 | FIXED | "nothing was ever written down" accurately describes the old position omission documented in the correction. |
| II6, paragraph 3 sentence 1 | FIXED | The memorial-versus-waymark distinction is consistent with current ground/stones records. |
| II7, paragraph 3 sentence 2 | FIXED | The cited singular HUD wording is retained as historical context in #2400. |
| II8, paragraph 4 sentence 1 | FIXED | Earlier placement advice concerned coordinates the old model did not retain; current corrections say so. |
| II9, paragraph 5 sentence 1 | FIXED | The settler's quoted trail-reading goal is present in the thing as resident-authored context. |
| II10, paragraph 5 sentence 2 | FIXED | "NONE OF IT WAS POSSIBLE UNTIL 1 SEPTEMBER" is bounded by the current dated correction and new recorded cairns. |
| II11, paragraph 6 sentence 1 | FIXED | The boon is named `WAYMARKS` in current correction facts. |
| II12, paragraph 6 sentence 2 | STILL WRONG | The valley wish-80 quotation has no city note or current public source attached. |
| II13, paragraph 6 sentence 3 | FIXED | The old missing data model is what #2374/#2401 correct. |
| II14, fix paragraph sentence 1 | FIXED | Current correction remains beside the old record. |
| II15, fix paragraph sentence 2 | FIXED | `Settlement.cairns` now records ground and stones; #2374 lines 270-290 and #2401 lines 157-179. |
| II16, fix paragraph sentence 3 | FIXED | Current correction describes bare versus aimed placement. |
| II17, fix paragraph sentence 4 | FIXED | Current correction describes heap stacking and `seenFrom`. |
| II18, narrowing sentence 1 | FIXED | Section III is explicitly narrowed rather than deleted. |
| II19, narrowing sentence 2 | FIXED | `hold[2]` is answerable from current recorded state. |
| II20, narrowing sentence 3 | STILL WRONG | "scored against it anyway" is historical and has no cited immutable evidence. |
| II21, measured-results sentence 1 | STILL WRONG | The six-day frontier-70 measurements are external to today's named city surfaces and were "not re-run here." |
| II22, 2-Sep correction sentence 1 | FIXED | Filed cross-water targets refuse by name and autonomous choices skip them since `6863950`; #2374 lines 3-29 and #2401 lines 3-18 agree. |
| II23, 2-Sep correction sentence 2 | FIXED | It explicitly overtakes item 6's "never blocked" wording. |
| II24, 2-Sep correction sentence 3 | STILL WRONG | The frontier-70/Sheet CXVI provenance is an uncited external claim. |
| II25, limit paragraph sentence 1 | FIXED | "TWO THINGS THE FIX DOES NOT BUY" correctly limits the correction. |
| II26, limit paragraph sentence 2 | STILL WRONG | Cato distances and spacing measurements are external and unverified here. |
| II27, limit paragraph sentence 3 | STILL WRONG | The sea-cost comparison and two-man outcome are external and unverified here. |
| III1, quoted rule | FIXED | `hold[2]` and its 33-tile condition are quoted and then narrowed. |
| III2, paragraph 1 sentence 1 | FIXED | The old state could not score the rule; current correction records why. |
| III3, paragraph 1 sentence 2 | FIXED | The old state stored a number, not five positions. |
| III4, paragraph 1 sentence 3 | FIXED | External observation versus persistent queryability is the recorded defect. |
| III5, paragraph 1 sentence 4 | FIXED | Since the section II fix, recorded cairns make it queryable. |
| III6, paragraph 2 sentence 1 | FIXED | Note #10315 remains the cited correction for the bad advice. |
| III7, paragraph 2 sentence 2 | FIXED | The text retracts the earlier claim instead of preserving it as current guidance. |
| III8, paragraph 2 sentence 3 | STILL WRONG | "they might have spent a filing on it" is possible harm, not verified cost. |
| IV1, paragraph 1 sentence 1 | STILL WRONG | "Sections I to III" is too broad: those sections contain both wrong old wording and valid corrections. |
| IV2, paragraph 1 sentence 2 | FIXED | Corrections visibly stand beside the errors in this thing. |
| IV3, paragraph 2 sentence 1 | FIXED | The definition "True when written, then the world moved" is coherent and clearly separated. |
| IV4, bullet 1 | STILL WRONG | Source-line death "within the hour" has no cited immutable evidence. |
| IV5, bullet 2 | STILL WRONG | The four-letter timing/false-on-arrival claim has no cited immutable evidence. |
| IV6, bullet 3 | STILL WRONG | The older outer-door claim has no cited immutable evidence. |
| IV7, bullet 4 | STILL WRONG | The 01:5xZ/four-hours-later timing claim has no cited immutable evidence. |
| IV8, bullet 5 | STILL WRONG | The all-morning and causal timing claim has no cited immutable evidence. |
| IV9, final paragraph sentence 1 | FIXED | Re-derivation at use time is safe guidance for overtaken facts. |
| IV10, final paragraph sentence 2 | FIXED | "Different fault, different fix" accurately distinguishes correction from refresh. |
| IV11, final paragraph sentence 3 | STILL WRONG | Foldline/erratum provenance is not tied to an immutable note. |
| V1, roster claude-softmax | STILL WRONG | Attribution is not tied to an immutable note per finding. |
| V2, roster frank | FIXED | Item 8 cites note #10227 for frank's audit. |
| V3, roster quibble | STILL WRONG | The three page-smell attributions have no note IDs here. |
| V4, roster foldline | STILL WRONG | The two-door attribution has no note ID here. |
| V5, roster kalani | STILL WRONG | The hazard/form attribution has no note ID here. |
| V6, roster corvid | STILL WRONG | The room-answer attribution has no note ID here. |
| V7, roster keeper | STILL WRONG | Four separate findings are grouped without immutable citations. |
| V8, roster frontier-70 | STILL WRONG | External run/fix provenance is not verifiable on today's city surfaces. |
| V9, count paragraph sentence 1 | STILL WRONG | "EIGHT OF ELEVEN" cannot be reproduced from the uncited roster. |
| V10, count paragraph sentence 2 | STILL WRONG | "Every one" was found through action is not evidenced per item. |
| V11, count paragraph sentence 3 | STILL WRONG | The engine tree's "27 checks" and never-first claim are external and unverified. |
| V12, floor paragraph sentence 1 | STILL WRONG | Section II being "found by a question" lacks immutable evidence. |
| V13, floor paragraph sentence 2 | STILL WRONG | The two-arm, all-day audit history lacks immutable evidence. |
| V14, floor paragraph sentence 3 | STILL WRONG | The keeper question attribution lacks immutable evidence. |
| Z1, closing sentence 1 | FIXED | "Nothing here is asked of anyone" is descriptive, not an enforced demand. |
| Z2, closing sentence 2 | FIXED | All seven cited notes remain readable at the routes below. |

Immutable evidence notes remain at `/api/note/9995`, `/10022`, `/10208`, `/10028`, `/10216`, `/10227`, and `/10315`. The fix lane should add note IDs for items 10 and 11, stop making unenforced append-only promises, and label external provenance as unverified instead of fact.

## Preserved issue-86 branch and worktree

Every commit and worktree hunk is `SUPERSEDED`; none should be carried into the fix lane. The old line identifies the exact hunk in `git show 18cd3e^..18cd3e` or `git show e28dbd^..e28dbd`. PR #122 merge commit `06f431f083d333f2f2aca95e9913cf59ad53dcba` contains the intended copy-honesty result, and current main then adds Gazette, drawing, disputes, help/attention, sharing, and snapshot work.

| Source hunk | Verdict | Current evidence |
|---|---|---|
| `18cd3e`, `docs/SYSTEM_DESIGN.md` old line 935 | SUPERSEDED | PR #122 carried the mirror rule; current design has later contract sections and #162/#163 are in flight. |
| `18cd3e`, `docs/published/FRONTDOOR.md` old line 23 | SUPERSEDED | Published front door is now a generated/mirrored surface with later facts. |
| `18cd3e`, `docs/published/FRONTDOOR.md` old line 25 | SUPERSEDED | Same current generated mirror and later facts. |
| `18cd3e`, `docs/published/FRONTDOOR.md` old line 306 | SUPERSEDED | Same current generated mirror and later facts. |
| `18cd3e`, `docs/published/FRONTDOOR.md` old line 588 | SUPERSEDED | Same current generated mirror and later facts. |
| `18cd3e`, `src/door.ts` old line 17 | SUPERSEDED | Current compiled door includes the PR #122 wording plus later feature contracts. |
| `18cd3e`, `src/door.ts` old line 19 | SUPERSEDED | Current compiled door includes the PR #122 wording plus later feature contracts. |
| `18cd3e`, `src/door.ts` old line 300 | SUPERSEDED | Current compiled door includes the PR #122 wording plus later feature contracts. |
| `18cd3e`, `src/door.ts` old line 582 | SUPERSEDED | Current compiled door includes the PR #122 wording plus later feature contracts. |
| `18cd3e`, `src/door.ts` old line 839 | SUPERSEDED | Current compiled door includes the PR #122 wording plus later feature contracts. |
| `18cd3e`, `src/door.ts` old line 888 | SUPERSEDED | Current compiled door includes the PR #122 wording plus later feature contracts. |
| `18cd3e`, `src/door.ts` old line 1080 | SUPERSEDED | Current compiled door includes the PR #122 wording plus later feature contracts. |
| `18cd3e`, `src/frontdoor.txt` old line 16 | SUPERSEDED | Current source retains the honesty edit and adds later facts; live city matches main. |
| `18cd3e`, `src/frontdoor.txt` old line 18 | SUPERSEDED | Current source retains the honesty edit and adds later facts; live city matches main. |
| `18cd3e`, `src/frontdoor.txt` old line 299 | SUPERSEDED | Current source retains the honesty edit and adds later facts; live city matches main. |
| `18cd3e`, `src/frontdoor.txt` old line 581 | SUPERSEDED | Current source retains the honesty edit and adds later facts; live city matches main. |
| `18cd3e`, `src/guide-style.ts` old line 159 | SUPERSEDED | Current guide-style wording includes the merged PR #122 result. |
| `18cd3e`, `src/human-pages.ts` old line 136 | SUPERSEDED | Current human pages include merged wording plus later setup/tools/buy work. |
| `18cd3e`, `src/identity-browser.ts` old line 76 | SUPERSEDED | Current identity browser includes merged wording plus later hosted-sign-in work. |
| `18cd3e`, `src/llms.txt` old line 3 | SUPERSEDED | Current llms source retains the edit and adds later contracts; live matches main. |
| `18cd3e`, `src/llms.txt` old line 52 | SUPERSEDED | Current llms source retains the edit and adds later contracts; live matches main. |
| `18cd3e`, `src/llms.txt` old line 244 | SUPERSEDED | Current llms source retains the edit and adds later contracts; live matches main. |
| `18cd3e`, `src/public-reference-facts.ts` old line 114 | SUPERSEDED | Current canonical fact generator contains the merged wording plus later facts. |
| `18cd3e`, `src/window-page.ts` old line 216 | SUPERSEDED | Current window has later navigation and sibling-copy changes; #162 is in flight. |
| `18cd3e`, `test/family-truth.test.ts` old line 11 | SUPERSEDED | Current regression reflects the merged no-affiliation truth. |
| `18cd3e`, `test/family-truth.test.ts` old line 44 | SUPERSEDED | Current regression reflects the merged no-affiliation truth. |
| `18cd3e`, `test/family-truth.test.ts` old line 52 | SUPERSEDED | Current regression reflects the merged no-affiliation truth. |
| `18cd3e`, `test/help-text.test.ts` old line 59 | SUPERSEDED | Current test covers the evolved shared help source; #163 is in flight. |
| `18cd3e`, `test/identity-browser.test.ts` old line 501 | SUPERSEDED | Current tests cover the evolved hosted identity copy. |
| Merge `167abb2` | SUPERSEDED | It only merged then-main `ca0ff0d`; all second-parent content is already current history. |
| `e28dbd`, `src/window-page.ts` old line 31 | SUPERSEDED | Current `src/window-page.ts:359-360` keeps market-next-door plus separate-square wording. |
| `e28dbd`, `test/family-truth.test.ts` old line 82 | SUPERSEDED | Current regression tests the evolved separate-square wording. |
| Worktree diff, `docs/published/FRONTDOOR.md` | SUPERSEDED | Whole-file Aug-27 replacement would remove later Gazette, drawing, help, dispute, and snapshot contracts. |
| Worktree diff, `src/door.ts` | SUPERSEDED | Whole-file Aug-27 replacement would remove the same later compiled contracts. |
| Worktree diff, `src/frontdoor.txt` | SUPERSEDED | Whole-file Aug-27 replacement would remove the same later source contracts. |
| Worktree diff, `src/llms.txt` | SUPERSEDED | Whole-file Aug-27 replacement would remove the same later agent contracts. |

The preserved worktree is not a clean four-file state: all tracked files appear staged deleted and reappear untracked, while the four requested paths are `MM`. `git diff` exposes the requested four unstaged replacements, but `git diff --cached` shows 351 files and about 150,749 deleted lines. No repair was attempted. Do not use this worktree as a patch source.

## Ranked one-lane fix list

This is one coordinated caller-contract lane across the city repo, market repo, and both skill repos. It deliberately excludes Live/THINGS/community-page work until the three in-flight changes merge.

1. **CRITICAL: replace both installed-skill contracts at their source.** Bring the citylife and marketplace release/install paths to current repo content. The market installed skill must stop teaching retired registration and no-recovery behavior. The city installed skill must stop using the retired snapshot prefix and gain current tool/help/Gazette/drawing/share contracts. Verify packaged mirrors and live-drift tests.
2. **CRITICAL: retire or truthfully replace stale official market listings #1 and #4.** They currently advertise seven tools, no OAuth, secret arguments, and a daily listing cap. Preserve public history with the market's withdrawal/tombstone rules; do not silently rewrite buyer history. Update the operations runbook with the executed evidence.
3. **HIGH: repair present-tense city repository contradictions together.** After #163 lands, update `README.md` money, human-action, and snapshot language. Mark Decisions 1, 5, 9, 36, and 50 superseded or narrow them with current truth. Change CLAUDE's PayPal state. Move every mirror and test in the same PR.
4. **HIGH: repair the reckoning as an evidence index.** Add immutable evidence for items 10 and 11 or label it absent. Remove the unenforced "appended and never removed" guarantee. Mark the overtaken water sentence and external frontier/provenance claims as unverified. Preserve the original resident record rather than silently replacing it.
5. **HIGH: make hosted proof language uniform.** Re-check city root/llms after #162/#163 because they currently name ChatGPT but omit Claude while `/setup` proves both paths. On the market, say discovery works and protected use is unproved until a real protected `me` succeeds for each claimed host. Record the real-client evidence when it exists.
6. **MEDIUM: complete `withdraw_item` before use.** Put no-reason, fixed-tombstone, no-refund, preserved-sale, and accepted-payment consequences in the live MCP description and matching docs/tests.
7. **WORDING: codify the voice rule, then apply it only to touched copy.** Add the no-em-dash rule to the repo working standard or owner-approved voice location. Do not churn historical decisions or exact resident quotes solely for punctuation.
8. **TRACKER: close only shipped issues with evidence after fixes deploy.** Candidates are city #104, #88 after #162 verification, #85 after #162 verification, #75, and #12. Keep partial and still-open rows open. Produce `BACKLOG.md` in the city repo from the final remaining list, as required by part 2.

### Fix-lane exit evidence

- Both skill packages and installed copies are byte-current and pass their packaging/live-drift tests.
- Live market window no longer exposes the retired contracts in listings #1/#4; public tombstones/history remain honest.
- City README, CLAUDE, DECISIONS, front-door mirrors, skills, and tests agree on current money, human, snapshot, and tool-count facts.
- Market protected sign-in claims name only hosts with a recorded harmless protected `me` proof.
- Live `withdraw_item` states every enforced consequence before use.
- PR #162, PR #163, and Live round 2 rows are re-curl-probed after merge before any related issue closes.
- `BACKLOG.md` lists every issue that remains open with one-line status.
