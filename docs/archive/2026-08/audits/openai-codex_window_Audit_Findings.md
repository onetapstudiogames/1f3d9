# Unshittify Audit

- **Audit ID:** UNS-AUDIT-20260815-181137
- **Project:** 1F3D9 (`C:\Users\Owner\Documents\1f3d9`)
- **Created:** 2026-08-15T18:11:37-05:00

## Plain-English Verdict

RELEASE WITH KNOWN RISKS

- The checked `/window` surface is internally consistent and its focused local tests pass.
- One confirmed product-level mismatch remains: the human-facing `/window` page tells search engines not to index it, even though the repo positions `/window` as the human appeal surface and publicly allows crawling.

### Findings at a Glance

| ID | Seriousness | Certainty | Problem |
| --- | --- | --- | --- |
| UNS-001 | MEDIUM | E3 | `/window` is presented as the public human-view surface, but the shipped HTML blocks search indexing and link following. |

### Next 3 Actions

1. Decide whether `/window` is meant to be discoverable by search engines or intentionally hidden from them.
2. If discoverable, remove the page-level indexing block and keep the rest of the window hardening intact.
3. Re-check live `/window`, `robots.txt`, and any discovery docs together after the change.

## Audit Contract

- **Scope:** CATEGORY `the human window` - everything a human sees at `/window`, plus the backend, route, data, test, and docs claims needed to judge that surface.
- **Product purpose:** Public read-only human window onto a live city where AI agents live, build, agree, and trade.
- **Release profile:** Public production website with untrusted traffic and real city data.
- **User parameters:** Treat docs as claims, not truth. Audit deeply. Do not read `docs/audits` reports. Do not change product code.
- **Exclusions:** No production writes, no authenticated private-system access, no secret-value reads, no remediation.
- **Allowed checks:** Targeted source/test/doc reads outside `docs/audits`, safe public HTTP reads, repository-native local tests, safe git reads.
- **Outside-system limits:** Public unauthenticated reads only (`https://1f3d9.com/window`, `/api/window`, `/api/events`, `/robots.txt`).
- **Write policy:** No remediation. Allowed output for this audit is this new report file only. Local checks were allowed to create normal generated output; no first-party source files were changed.

## Project and Connection Map

- **HTTP entry:** [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:171) wires `GET /window`, `GET /window.css`, `GET /window.js`, and `GET /api/window`.
- **Window document shell:** [src/window-page.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-page.ts:1) serves the human HTML with tabs for map, place, conversations, happenings, and agreements.
- **Window assets:** [src/window.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window.ts:825) serves HTML/CSS/JS with hardening headers and CSP.
- **Snapshot API:** [src/window.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window.ts:794) rejects credential-bearing requests, accepts only bounded public history filters, and serves either the cached full snapshot or a specific older history page.
- **Snapshot reads:** [src/window.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window.ts:685) pulls places, residents, recent notes, recent things, recent agreements, recent events, totals, and body limits from Postgres.
- **Older history reads:** [src/window.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window.ts:503) pages notes/things/agreements through `/api/window`; [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:532) pages older events through `/api/events`.
- **Client execution path:** [src/window-client.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-client.ts:1054) fetches `/api/window` on load, [src/window-client.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-client.ts:928) fetches older slices on demand, and [src/window-client.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-client.ts:1080) refreshes the snapshot on a timer.
- **Published product claims checked:** [docs/DECISIONS.md](/abs/path/C:/Users/Owner/Documents/1f3d9/docs/DECISIONS.md:33), [docs/SYSTEM_DESIGN.md](/abs/path/C:/Users/Owner/Documents/1f3d9/docs/SYSTEM_DESIGN.md:293), [docs/ARCHITECTURE.md](/abs/path/C:/Users/Owner/Documents/1f3d9/docs/ARCHITECTURE.md:27), [src/door.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/door.ts:452).

Critical checked journeys:

- Human opens `/window` -> HTML shell loads `/window.css` and `/window.js` -> client fetches `/api/window` without credentials -> page renders map, roster, place, conversations, happenings, and agreements.
- Human loads older notes/things/agreements -> client requests `/api/window?collection=...` with bounded filters -> server validates the filter set -> Postgres returns one bounded page -> client merges rows immutably.
- Human loads older happenings -> client requests `/api/events?before_id=...&limit=50` -> server returns one bounded public event page -> client appends it to the visible list.
- Search engine visits `/window` -> `robots.txt` allows crawling, but the HTML itself declares `noindex, nofollow, noarchive`.

## Coverage and Limits

| Area | Status | Evidence | Limit |
| --- | --- | --- | --- |
| `/window` route wiring and hardening | CHECKED | [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:171), [src/window.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window.ts:794), live `GET /window` headers | Static and public-read only; no authenticated variants checked |
| Window HTML, controls, and copy | CHECKED | [src/window-page.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-page.ts:1), live `GET /window`, Playwright window specs | Visual review was source plus HTTP HTML, not manual cross-browser exploration beyond local Playwright |
| Snapshot and history data path | CHECKED | [src/window.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window.ts:464), [src/window.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window.ts:685), [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:532), focused tests | No direct production database access |
| Client fetch/merge/filter logic | CHECKED | [src/window-client.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-client.ts:332), [src/window-client.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-client.ts:903), [src/window-client.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-client.ts:1080) | Static review plus repo tests only |
| Docs vs shipped discovery posture | CHECKED | [docs/DECISIONS.md](/abs/path/C:/Users/Owner/Documents/1f3d9/docs/DECISIONS.md:33), [docs/ARCHITECTURE.md](/abs/path/C:/Users/Owner/Documents/1f3d9/docs/ARCHITECTURE.md:27), [src/window-page.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-page.ts:6), live `GET /window`, live `GET /robots.txt` | Search-engine behavior inferred from standard crawler handling of `robots` meta and robots.txt |
| Local window-focused automated tests | CHECKED | `node --test --experimental-strip-types test/window-viewer.test.ts`, `node --test --experimental-strip-types test/routes.test.ts`, `npx playwright test e2e/public-window.spec.ts e2e/public-window-interactions.spec.ts` | Focused subsets only; full product test matrix not re-run |
| Production user analytics, SEO console, and external search indexing state | NOT CHECKED | No connector or safe public signal for private search-console state | Would require private service access |
| Other audit reports in `docs/audits` | NOT CHECKED | Intentionally excluded by user instruction | Not read |

## Evidence Ledger

- **EVD-001**
  - **Time:** 2026-08-15T17:53:00-05:00
  - **Folder:** `C:\Users\Owner\Documents\1f3d9`
  - **Command:** `rg -n --hidden --glob '!docs/audits/**' "(/window|window)" .`
  - **Exit code:** 0
  - **Redacted result:** Located `/window`, `/window.js`, `/window.css`, `/api/window`, focused tests, and docs claims.
  - **Side effects:** None.
- **EVD-002**
  - **Time:** 2026-08-15T17:58:00-05:00
  - **Folder:** `C:\Users\Owner\Documents\1f3d9`
  - **Command:** `Invoke-WebRequest -UseBasicParsing 'https://1f3d9.com/window'` and `Invoke-WebRequest -UseBasicParsing 'https://1f3d9.com/api/window'`
  - **Exit code:** 0
  - **Redacted result:** Live `/window` and `/api/window` both returned `200`; `/api/window` served public JSON with place/resident/history payload.
  - **Side effects:** None.
- **EVD-003**
  - **Time:** 2026-08-15T18:01:00-05:00
  - **Folder:** `C:\Users\Owner\Documents\1f3d9`
  - **Command:** Targeted line reads from `src/window.ts`, `src/window-client.ts`, `src/window-page.ts`, `src/index.ts`
  - **Exit code:** 0
  - **Redacted result:** Confirmed exact route wiring, query parsing, client fetch path, page-level `robots` meta, and `/api/events` split.
  - **Side effects:** None.
- **EVD-004**
  - **Time:** 2026-08-15T18:04:00-05:00
  - **Folder:** `C:\Users\Owner\Documents\1f3d9`
  - **Command:** `node --test --experimental-strip-types test/window-viewer.test.ts`
  - **Exit code:** 0
  - **Redacted result:** 15/15 focused window unit-style tests passed.
  - **Side effects:** None observed.
- **EVD-005**
  - **Time:** 2026-08-15T18:05:00-05:00
  - **Folder:** `C:\Users\Owner\Documents\1f3d9`
  - **Command:** `node --test --experimental-strip-types test/routes.test.ts`
  - **Exit code:** 0
  - **Redacted result:** 74/74 route tests passed, including `/api/window` hardening and public event coverage checks.
  - **Side effects:** None observed.
- **EVD-006**
  - **Time:** 2026-08-15T18:06:00-05:00
  - **Folder:** `C:\Users\Owner\Documents\1f3d9`
  - **Command:** `npx playwright test e2e/public-window.spec.ts e2e/public-window-interactions.spec.ts`
  - **Exit code:** 0
  - **Redacted result:** 7/7 Playwright window specs passed, covering real asset loads, read-only behavior, and older-history loading.
  - **Side effects:** Normal Playwright result output may have touched `test-results/`.
- **EVD-007**
  - **Time:** 2026-08-15T18:08:00-05:00
  - **Folder:** `C:\Users\Owner\Documents\1f3d9`
  - **Command:** `Invoke-WebRequest -UseBasicParsing 'https://1f3d9.com/api/events?limit=5'`
  - **Exit code:** 0
  - **Redacted result:** Live public event paging is active and separate from `/api/window`.
  - **Side effects:** None.
- **EVD-008**
  - **Time:** 2026-08-15T18:10:00-05:00
  - **Folder:** `C:\Users\Owner\Documents\1f3d9`
  - **Command:** `Invoke-WebRequest -UseBasicParsing 'https://1f3d9.com/robots.txt'`
  - **Exit code:** 0
  - **Redacted result:** Live robots policy is `User-agent: *` and `Allow: /`.
  - **Side effects:** None.
- **EVD-009**
  - **Time:** 2026-08-15T18:11:00-05:00
  - **Folder:** `C:\Users\Owner`
  - **Command:** `<absolute-git> --no-pager --no-optional-locks -c core.fsmonitor=false -C C:\Users\Owner\Documents\1f3d9 status --short --ignore-submodules=all`
  - **Exit code:** 0
  - **Redacted result:** Concurrent untracked audit files existed before this report; no first-party source changes from audit checks were observed.
  - **Side effects:** None.

## Findings

### UNS-001: `/window` blocks indexing even though the product positions it as the human-facing public surface

- **Severity:** MEDIUM
- **Evidence level:** E3
- **Status:** Confirmed
- **Rule or parameter:** Public human-facing appeal surface should not silently opt out of public discovery when repo-level product decisions and discovery docs position it as a public read.
- **Location:** [src/window-page.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-page.ts:6), [docs/DECISIONS.md](/abs/path/C:/Users/Owner/Documents/1f3d9/docs/DECISIONS.md:33), [docs/ARCHITECTURE.md](/abs/path/C:/Users/Owner/Documents/1f3d9/docs/ARCHITECTURE.md:27), [src/door.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/door.ts:452)
- **User or business harm:** People can visit `/window` if they already know the URL, but standard crawlers are told not to index or follow it. That suppresses organic discovery of the one surface the product itself calls "the whole human appeal," reducing reach and making the public window harder to find than the surrounding docs imply.
- **Evidence:** The shipped HTML sets `<meta name="robots" content="noindex, nofollow, noarchive">` in [src/window-page.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-page.ts:6). The live page currently serves that HTML. At the same time, [docs/DECISIONS.md](/abs/path/C:/Users/Owner/Documents/1f3d9/docs/DECISIONS.md:33) says "Watching the city is the whole human appeal," [docs/SYSTEM_DESIGN.md](/abs/path/C:/Users/Owner/Documents/1f3d9/docs/SYSTEM_DESIGN.md:295) says the window "ships day one," [docs/ARCHITECTURE.md](/abs/path/C:/Users/Owner/Documents/1f3d9/docs/ARCHITECTURE.md:27) says discovery metadata expose public city state, and the live [robots.txt](https://1f3d9.com/robots.txt) allows crawling.
- **Safe reproduction:** Read [src/window-page.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-page.ts:6) and fetch `https://1f3d9.com/window` plus `https://1f3d9.com/robots.txt`. The page advertises `noindex, nofollow, noarchive`; robots.txt allows `/`.
- **Connection traced:** Product claim -> [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:173) serves `/window` -> [src/window-page.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/window-page.ts:6) emits crawler-blocking meta -> crawlers obey the page-level block even though site-level robots allow crawling.
- **Root cause:** The window shell appears to have inherited a hardened "do not index" posture from the reused market `/window` pattern, but the 1F3D9 product docs now position `/window` as a public destination rather than a hidden support surface.
- **Connections and similar locations checked:** Checked [src/door.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/door.ts:452) and live `/robots.txt` for the published discovery posture; checked [src/index.ts](/abs/path/C:/Users/Owner/Documents/1f3d9/src/index.ts:171) to confirm `/window` is a first-class route; checked live `/window` to confirm the block is currently shipped.
- **Durable fix:** Align one source of truth for discovery. Either keep `/window` intentionally private and update the product/docs/discovery language to match, or remove the page-level indexing block from the live window shell so the public human surface is actually discoverable.
- **Why this is not a band-aid:** It resolves the source-of-truth mismatch between product intent and shipped crawler instructions instead of layering more links or marketing copy on top of a blocked page.
- **Pre-fix proof:** Deterministic source and live-HTTP proof already exists: page-level `robots` meta conflicts with the public-discovery product posture.
- **Verification:** Re-fetch live `/window` and `/robots.txt`; confirm the intended crawler directives are aligned; manually inspect page HTML; verify no other page shell or generated wrapper reintroduces the block.
- **Regression and rollback risk:** Low technical risk if the intent is public discovery; the main risk is accidental indexing of a page the team meant to keep semi-private. Rollback is to restore the current meta directive.
- **Unknowns:** Private search-console state, current external index status, and whether the noindex directive was an intentional business choice made after the referenced docs. No private search tooling was accessed.

## Questions Needing Human Review

No E1 questions were recorded.

## Ordered Repair Plan

1. Resolve intent for finding `UNS-001`: public destination vs intentionally hidden support page.
2. Add a small behavior-level check that asserts the intended crawler directive for `/window`.
3. Change the page shell or the surrounding product/docs contract so the public-discovery posture is consistent in one place.
4. Re-check live `/window`, `/robots.txt`, and any published discovery copy together.
5. Re-run the window-focused route, unit, and Playwright checks.
6. Roll out reversibly and watch search indexing / discovery signals if the page is meant to be public.
7. Run a fresh full window audit and cite this report.

## Verification and Release Gates

- Intended `/window` discovery posture is explicitly decided.
- Live `GET /window` HTML and live `GET /robots.txt` agree with that decision.
- Safe commands:
  - `node --test --experimental-strip-types test/window-viewer.test.ts`
  - `node --test --experimental-strip-types test/routes.test.ts`
  - `npx playwright test e2e/public-window.spec.ts e2e/public-window-interactions.spec.ts`
  - `Invoke-WebRequest -UseBasicParsing 'https://1f3d9.com/window'`
  - `Invoke-WebRequest -UseBasicParsing 'https://1f3d9.com/robots.txt'`
- Forbidden live actions: no production writes, no authenticated endpoints, no secret access.
- Rollback condition: if indexing `/window` causes an intentional privacy/discovery conflict, restore the previous page-level directive and update the published product language to match.

## Overseer Record

**Independent skeptic:** NOT COMPLETED
**Reviewer separation:** NOT CONFIRMED

single-agent audit - independently unverified

## Honest Limitations

- This was a single-agent audit. No fresh skeptic independently re-checked findings, so no E4 findings are claimed.
- I did not read `docs/audits` or any other audit report, per instruction.
- I did not access private analytics, search-console, CDN, or database state.
- I did not inspect secrets or authenticated production flows.
- Static review and passing focused tests cannot prove absence of other `/window` defects.
- Normal Playwright output may have touched `test-results/`; no first-party source changes were made by the audit.
- Concurrent audit files already existed in `docs/audits`; those files were not opened.
