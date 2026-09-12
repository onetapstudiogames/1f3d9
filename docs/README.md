# Documentation map

Status: current.

Start with the document that matches the question:

| Need | Document |
|---|---|
| Product purpose, audience, scope, and requirements | [PRD.md](PRD.md) |
| Runtime components, trust boundaries, storage, and release path | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Exact physics, API, quotas, safety rules, and bridge behavior | [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) |
| Locked choices that must not be relitigated | [DECISIONS.md](DECISIONS.md) |
| Current follow-ups | [TASKS.md](TASKS.md) |

Public and feature documents:

- [CREDENTIAL_SAFETY.md](CREDENTIAL_SAFETY.md) defines the credential boundary for public text.
- [DRAWING_AND_LIVE_VIEW.md](DRAWING_AND_LIVE_VIEW.md) records drawing and live-view behavior.
- [PUBLIC_SNAPSHOTS.md](PUBLIC_SNAPSHOTS.md) defines the dated public-record format.
- [features/HOSTED_CHAT_SIGNIN.md](features/HOSTED_CHAT_SIGNIN.md) defines hosted-chat sign-in.

Operations:

- [runbooks/COSTS.md](runbooks/COSTS.md) covers cost monitoring and incidents.
- [runbooks/PAYMENT_RECOVERY.md](runbooks/PAYMENT_RECOVERY.md) covers payment recovery.
- [runbooks/DEPLOYMENT.md](runbooks/DEPLOYMENT.md) covers deployment and rollback.
- [runbooks/BACKUP_RESTORE.md](runbooks/BACKUP_RESTORE.md) covers backup and restore.
- [runbooks/PUBLIC_SNAPSHOTS.md](runbooks/PUBLIC_SNAPSHOTS.md), [runbooks/SIGNIN_RETENTION.md](runbooks/SIGNIN_RETENTION.md), and [runbooks/ENVIRONMENT.md](runbooks/ENVIRONMENT.md) cover their named operations.

[audits/README.md](audits/README.md) tells which audit sets are fixed, open, or still unverified. Historical audits, waves, drafts, plans, and work receipts are under [archive/](archive/). The current Reckoning reply remains in [drafts/](drafts/).


## Complete index

Every project Markdown document appears here once. Workflow templates and generated test, browser, dependency, coverage, and deployment artifacts are excluded. The build fails if a document or status is missing.

| Document | Status |
|---|---|
| [../AGENTS.md](../AGENTS.md) | current |
| [../BACKLOG.md](../BACKLOG.md) | current |
| [../CHANGELOG.md](../CHANGELOG.md) | current |
| [../CLAUDE.md](../CLAUDE.md) | current |
| [../README.md](../README.md) | current |
| [ARCHITECTURE.md](ARCHITECTURE.md) | current |
| [CREDENTIAL_SAFETY.md](CREDENTIAL_SAFETY.md) | current |
| [DECISIONS.md](DECISIONS.md) | current |
| [DRAWING_AND_LIVE_VIEW.md](DRAWING_AND_LIVE_VIEW.md) | current |
| [INVARIANTS.md](INVARIANTS.md) | current |
| [PRD.md](PRD.md) | current |
| [PUBLIC_SNAPSHOTS.md](PUBLIC_SNAPSHOTS.md) | current |
| [README.md](README.md) | current |
| [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) | current |
| [TASKS.md](TASKS.md) | current |
| [TESTING.md](TESTING.md) | current |
| [archive/2026-08/AUDIT_OUTCOME_PLAN_2026-08-15.md](archive/2026-08/AUDIT_OUTCOME_PLAN_2026-08-15.md) | historical, 2026-09-12 |
| [archive/2026-08/PUBLIC_BUG_FIX_PLAN_2026-08-13.md](archive/2026-08/PUBLIC_BUG_FIX_PLAN_2026-08-13.md) | archived, 2026-09-12 |
| [archive/2026-08/RESOLVED_QUESTIONS.md](archive/2026-08/RESOLVED_QUESTIONS.md) | archived, 2026-09-12 |
| [archive/2026-08/WORKTREE_RECONCILIATION.md](archive/2026-08/WORKTREE_RECONCILIATION.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/2026-09-parity-audit.md](archive/2026-08/audits/2026-09-parity-audit.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/2026-09-refusal-census.md](archive/2026-08/audits/2026-09-refusal-census.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/Codex-GPT-5_data_Audit_Findings.md](archive/2026-08/audits/Codex-GPT-5_data_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/Codex_api_Audit_Findings.md](archive/2026-08/audits/Codex_api_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/Codex_data_Audit_Findings.md](archive/2026-08/audits/Codex_data_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/Codex_identity_Audit_Findings.md](archive/2026-08/audits/Codex_identity_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/Codex_window_Audit_Findings.md](archive/2026-08/audits/Codex_window_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5-Codex_window_Audit_Findings.md](archive/2026-08/audits/GPT-5-Codex_window_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5_api_Audit_Findings.md](archive/2026-08/audits/GPT-5_api_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5_data_Audit_Findings.md](archive/2026-08/audits/GPT-5_data_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5_frontdoor_Audit_Findings.md](archive/2026-08/audits/GPT-5_frontdoor_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5_identity_Audit_Findings.md](archive/2026-08/audits/GPT-5_identity_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5_identity_Audit_Findings_20260815-154344.md](archive/2026-08/audits/GPT-5_identity_Audit_Findings_20260815-154344.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5_infra_Audit_Findings.md](archive/2026-08/audits/GPT-5_infra_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5_infra_Audit_Findings_20260815-182504.md](archive/2026-08/audits/GPT-5_infra_Audit_Findings_20260815-182504.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5_physics_Audit_Findings.md](archive/2026-08/audits/GPT-5_physics_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5_requests_Audit_Findings.md](archive/2026-08/audits/GPT-5_requests_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5_skill_Audit_Findings.md](archive/2026-08/audits/GPT-5_skill_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/GPT-5_window_Audit_Findings.md](archive/2026-08/audits/GPT-5_window_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/README-original.md](archive/2026-08/audits/README-original.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/openai-codex_data_Audit_Findings.md](archive/2026-08/audits/openai-codex_data_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/openai-codex_frontdoor_Audit_Findings.md](archive/2026-08/audits/openai-codex_frontdoor_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/openai-codex_identity_Audit_Findings.md](archive/2026-08/audits/openai-codex_identity_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/openai-codex_infra_Audit_Findings.md](archive/2026-08/audits/openai-codex_infra_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/openai-codex_money_Audit_Findings.md](archive/2026-08/audits/openai-codex_money_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/openai-codex_requests_Audit_Findings.md](archive/2026-08/audits/openai-codex_requests_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/openai-codex_window_Audit_Findings.md](archive/2026-08/audits/openai-codex_window_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/openai-codex_window_Audit_Findings_20260815-181557.md](archive/2026-08/audits/openai-codex_window_Audit_Findings_20260815-181557.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/openai-codex_world_Audit_Findings.md](archive/2026-08/audits/openai-codex_world_Audit_Findings.md) | archived, 2026-09-12 |
| [archive/2026-08/audits/whole-site_unshittify_2026-08-15.md](archive/2026-08/audits/whole-site_unshittify_2026-08-15.md) | archived, 2026-09-12 |
| [archive/2026-08/drafts/live-stage-README.md](archive/2026-08/drafts/live-stage-README.md) | historical, 2026-09-12 |
| [archive/2026-08/drafts/live-stage-blueprint.md](archive/2026-08/drafts/live-stage-blueprint.md) | historical, 2026-09-12 |
| [archive/2026-08/drafts/live-stage-borrow-list.md](archive/2026-08/drafts/live-stage-borrow-list.md) | historical, 2026-09-12 |
| [archive/2026-08/drafts/live-stage-mock-brief.md](archive/2026-08/drafts/live-stage-mock-brief.md) | historical, 2026-09-12 |
| [archive/2026-08/drafts/live-stage-round-five-set-pieces.md](archive/2026-08/drafts/live-stage-round-five-set-pieces.md) | historical, 2026-09-12 |
| [archive/2026-08/drafts/live-stage-round-four-defects.md](archive/2026-08/drafts/live-stage-round-four-defects.md) | historical, 2026-09-12 |
| [archive/2026-08/drafts/live-stage-round-six-long-notes.md](archive/2026-08/drafts/live-stage-round-six-long-notes.md) | historical, 2026-09-12 |
| [archive/2026-08/waves/WAVE_10_READING_AND_RECORD_FOLLOW_UPS_2026-08-22.md](archive/2026-08/waves/WAVE_10_READING_AND_RECORD_FOLLOW_UPS_2026-08-22.md) | archived, 2026-09-12 |
| [archive/2026-08/waves/WAVE_11_CHATGPT_SIGNIN_2026-08-22.md](archive/2026-08/waves/WAVE_11_CHATGPT_SIGNIN_2026-08-22.md) | archived, 2026-09-12 |
| [archive/2026-08/waves/WAVE_1_AFFORDABLE_READING_2026-08-20.md](archive/2026-08/waves/WAVE_1_AFFORDABLE_READING_2026-08-20.md) | archived, 2026-09-12 |
| [archive/2026-08/waves/WAVE_2_THING_HEAVY_ROOMS_2026-08-21.md](archive/2026-08/waves/WAVE_2_THING_HEAVY_ROOMS_2026-08-21.md) | archived, 2026-09-12 |
| [archive/2026-08/waves/WAVE_3_BOUNDED_ROOM_READING_2026-08-21.md](archive/2026-08/waves/WAVE_3_BOUNDED_ROOM_READING_2026-08-21.md) | archived, 2026-09-12 |
| [archive/2026-08/waves/WAVE_4_BOUNDED_CITY_NAVIGATION_2026-08-21.md](archive/2026-08/waves/WAVE_4_BOUNDED_CITY_NAVIGATION_2026-08-21.md) | archived, 2026-09-12 |
| [archive/2026-08/waves/WAVE_5_SEARCH_AND_CHANGE_MARKERS_2026-08-21.md](archive/2026-08/waves/WAVE_5_SEARCH_AND_CHANGE_MARKERS_2026-08-21.md) | archived, 2026-09-12 |
| [archive/2026-08/window-calm-plan.md](archive/2026-08/window-calm-plan.md) | historical, 2026-09-12 |
| [archive/2026-08/work-receipts/oauth-duplicate-renewal-20260829.md](archive/2026-08/work-receipts/oauth-duplicate-renewal-20260829.md) | archived, 2026-09-12 |
| [archive/2026-08/work-receipts/oauth-refresh-bucket-20260829.md](archive/2026-08/work-receipts/oauth-refresh-bucket-20260829.md) | archived, 2026-09-12 |
| [archive/2026-08/work-receipts/oauth-refresh-bucket-e2e-followup-20260829.md](archive/2026-08/work-receipts/oauth-refresh-bucket-e2e-followup-20260829.md) | archived, 2026-09-12 |
| [archive/2026-08/work-receipts/unshittily-20260828-155900.md](archive/2026-08/work-receipts/unshittily-20260828-155900.md) | archived, 2026-09-12 |
| [audits/README.md](audits/README.md) | current |
| [drafts/reckoning-reply.md](drafts/reckoning-reply.md) | current |
| [features/HOSTED_CHAT_SIGNIN.md](features/HOSTED_CHAT_SIGNIN.md) | current |
| [published/FRONTDOOR.md](published/FRONTDOOR.md) | current |
| [runbooks/BACKUP_RESTORE.md](runbooks/BACKUP_RESTORE.md) | current |
| [runbooks/COSTS.md](runbooks/COSTS.md) | current |
| [runbooks/DEPLOYMENT.md](runbooks/DEPLOYMENT.md) | current |
| [runbooks/ENVIRONMENT.md](runbooks/ENVIRONMENT.md) | current |
| [runbooks/PAYMENT_RECOVERY.md](runbooks/PAYMENT_RECOVERY.md) | current |
| [runbooks/PUBLIC_SNAPSHOTS.md](runbooks/PUBLIC_SNAPSHOTS.md) | current |
| [runbooks/SIGNIN_RETENTION.md](runbooks/SIGNIN_RETENTION.md) | current |
