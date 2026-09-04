# Backlog

This is the local mirror of every issue currently open on the city and market
trackers. Status and evidence come from the tracker reconciliation in
[`docs/audits/2026-09-parity-audit.md`](docs/audits/2026-09-parity-audit.md).
`SHIPPED` does not mean the issue was closed. No issue was changed while making
this file.

## Open tracker issues

| Issue | Status | Evidence |
|---|---|---|
| City #132: Phase C voucher bridge | STILL OPEN | No implementation or issue evidence; paired market #30 remains open. Audit: `Issue tracker reconciliation > Open city issues`. |
| City #104: The two windows must link to each other | SHIPPED | City `src/window-page.ts:375`; market `src/window-page.ts:170` and `src/human-pages.ts:126,288`. Audit: `Open city issues`. |
| City #103: Payment reliability standard | STILL OPEN | Partial: standards and the scheduled probe exist, but the probe does not execute every required tiny payment rail. Audit: `Open city issues`. |
| City #102: Bridge completeness | STILL OPEN | Market #10 still records zero completed real world-aisle sales. Audit: `Open city issues`. |
| City #92: Recovery loose ends | STILL OPEN | No closure evidence for issue #5, the named manual recoveries, or a real self-service probe. Audit: `Open city issues`. |
| City #88: Live prerequisites | SHIPPED | Drawings and Live shipped; re-check after PR #162 merges before closing. Audit: `Open city issues`. |
| City #86: Page inventory and matrix | STILL OPEN | PR #122 fixed a subset; the parity audit supplies the matrix, but PR #162 rows remain in flight. Audit: `Open city issues` and `Preserved issue-86 branch and worktree`. |
| City #85: Window audit | SHIPPED | The audit, owner visibility decision, and PR #110 fixes exist; re-check after PR #162 merges before closing. Audit: `Open city issues`. |
| City #83: Universality review | STILL OPEN | No requested census, design, or owner decision exists. Audit: `Open city issues`. |
| City #82: Documentation overhaul | STILL OPEN | Partial: several fixes shipped, but 28 point-in-time audit files and root wave docs remain unreconciled. Audit: `Open city issues`. |
| City #79: Split the window client | STILL OPEN | Phase 1 (mechanical split into `src/window-client/**.ts`; `WINDOW_JS` byte-identical, sha256 `8388f3b9b32ccb8b0c4c5c97ca9bd40a9d24e895c2abaaebbc69d0a60845f178`) shipped; see `docs/DRAWING_AND_LIVE_VIEW.md#9-client-source-layout-issue-79-phase-1`. Phase 2, the typed accessor layer over `state` that stops a renderer reading the raw caches, remains open. |
| City #78: Setup sentences | STILL OPEN | Half shipped: the stale-tool-cache sentence exists; the shared-machine per-agent credential warning does not. Audit: `Open city issues`. |
| City #77: Typed identity outcomes | STILL OPEN | `generateRecoveryCodes` still returned `Promise<RecoveryGenerationResult | null>` at `src/identity-store.ts:459`. Audit: `Open city issues`. |
| City #76: Failure-message honesty | STILL OPEN | No two-site, both-sides, all-door census proves cause plus safe next step. Audit: `Open city issues`. |
| City #75: Connector parity audit | SHIPPED | The full two-site gap table is posted; city PR #126 and market PR #31 shipped parity tools. Audit: `Open city issues`. |
| City #74: Map navigation | STILL OPEN | The skill still lacks an executable parent-child lookup path that avoids blind 403 responses. Audit: `Open city issues`. |
| City #73: Overwrite-only rooms | STILL OPEN | No decision or explicit privacy and visibility contract exists. Audit: `Open city issues`. |
| City #72: Resumable onboarding | STILL OPEN | Partial: city implementation shipped, but both-site real-client acceptance remains unproved. Audit: `Open city issues`. |
| City #71: Large encoded room reads | STILL OPEN | No body-deferral or safe aggregate option and no explicit busy-room caution exist. Audit: `Open city issues`. |
| City #12: Resident patches and provenance | SHIPPED | README invitation, permanent `made_by`, tests, and Aug. 27 evidence exist. Audit: `Open city issues`. |
| Market #30: Phase C voucher bridge | STILL OPEN | The paired city #132 design remains unbuilt. Audit: `Issue tracker reconciliation > Open market issues`. |
| Market #10: Real world sale | STILL OPEN | The issue says zero completed real sales and has no contrary evidence. Audit: `Open market issues`. |

No audit row assigns `DECIDED` or `PARKED` to an issue that is currently open.

## Shipped issues the maintainer should close

Paste these evidence lines only after the named live re-check or deployment condition
is satisfied.

### City #104

`SHIPPED. The city window links to the market at src/window-page.ts:375; the market links back at src/window-page.ts:170 and src/human-pages.ts:126,288.`

### City #88

`SHIPPED, pending final live verification after PR #162. Drawings and Live are present; verify the merged Live and portrait paths on the deployed window before closing.`

### City #85

`SHIPPED, pending final live verification after PR #162. The window audit, owner visibility decision, and PR #110 fixes exist; re-check every changed window tab on the deployed site before closing.`

### City #75

`SHIPPED. The full two-site connector gap table is posted; city PR #126 and market PR #31 shipped the parity tools.`

### City #12

`SHIPPED. The README invites resident patches, permanent made_by provenance is implemented, tests cover it, and the Aug. 27 evidence is recorded.`

## Preserved issue-86 branch disposition

`STILL VALID`: none.

`SUPERSEDED`: every preserved hunk. This includes all `18cd3e` hunks in
`docs/SYSTEM_DESIGN.md`, the three front-door mirrors, `src/guide-style.ts`,
`src/human-pages.ts`, `src/identity-browser.ts`, `src/llms.txt`,
`src/public-reference-facts.ts`, `src/window-page.ts`, and the named tests; merge
`167abb2`; both `e28dbd` window and test hunks; and all four worktree replacements.
The exact hunk-by-hunk evidence is in the audit section `Preserved issue-86 branch
and worktree`. None was applied here.
