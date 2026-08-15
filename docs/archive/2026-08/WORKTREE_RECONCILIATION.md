# Worktree reconciliation — 2026-08-15

Baseline: GitHub `main` at `09b1cb5b5054f4257cdd8c373cdd85659b4add60`.
Every attached copy was compared by commit ancestry, patch, dirty files, and current
behavior. Dirty and conflicted copies are preserved in the dated recovery archive before
their registration is removed.

| Working copy | State | Content not safely represented by `main` | Reconciliation |
|---|---|---|---|
| `.census-contract` | Clean, older | None | Archive metadata only. |
| `.hotfix-mcp-note-redaction` | Clean, divergent history | No current behavior; its redaction/sign-in intent is already on `main`. | Archive history only. |
| `.open-to-use` | Clean, merged | None | No port. |
| `.preview-world-root` | Five dirty tracked files | Registration and OAuth confirmation must allocate/write nothing until the world root exists. | Ported two source changes and three regression tests. |
| `.public-mcp-auth` | Clean, old release stack | None beyond behavior already on `main`. | Archive metadata only. |
| `.resident-read-fixes` | Clean, patch-equivalent | None; shared place read limits are on `main`. | No port. |
| `.rollout-world-root` | Clean, divergent history | Real-PostgreSQL coverage for production law/withdrawal SQL types. | Ported `test/integration/write-sql-postgres.test.ts` and added it to `test:postgres`. |
| `1f3d9-connector-guidance-site` | Clean, older | None | Archive metadata only. |
| `1f3d9-contributor-fixes` | Clean, older | None | Archive metadata only. |
| `1f3d9-hosted-chat-release` | Source-clean; local env/cache artifacts | No code behavior; hosted-chat changes are superseded. Its env file is preserved, while caches are disposable. | Archive local-only files; no code port. |
| `1f3d9-hotfix-circle-empty-logs` | Clean, older | None | Archive metadata only. |
| `1f3d9-pr4-review` | Clean, older review | None | Archive metadata only. |
| `1f3d9-pr6-review` | Clean, older review | None | Archive metadata only. |
| `1f3d9-pr8-review` | Clean, older review | None | Archive metadata only. |
| `1f3d9-public-bugfix-publish` | Clean, older | None | Archive metadata only. |
| `1f3d9-public-bugfix-release` | Five dirty paths | A stale release experiment, including older MCP behavior and a README deletion; applying it would regress `main`. | Preserve exact dirty copy; no port. |
| `1f3d9-reconcile-preview` | 33 staged paths | Older reconciliation stack; it removes newer `open_to_use`, paging, and census behavior. | Preserve exact staged copy; no port. |
| `1f3d9-red-tests` | Three dirty test/E2E paths | No missing behavior; the cross-room newest-first test already exists on `main`. | Preserve patch; no port. |
| `1f3d9-release-1303a14` | Clean, one divergent artifact commit | Only a production test-result artifact. | Archive artifact; no product port. |
| `1f3d9-release-6738591` | Clean, older release | None | Archive metadata only. |
| `1f3d9-review-main-1786702255` | Five unresolved conflicts | Older bounded-note approach conflicts with the shipped cursor contract. | Preserve conflict state; no port. |
| `1f3d9-review-main-1786702453-pr4` | One conflict plus one staged file | Older note-card rendering would remove current expandable bodies. | Preserve conflict state; no port. |
| `1f3d9-root-canonical` | Accidentally created during this reconciliation | An alternate docs/operations attempt; the guarded canonical staging repo contains the reconciled equivalents. | Preserve before removing this accidental 23rd attached copy. |

## Loose root state

The old bare-repository root also held files outside a normal checkout. The required
`scripts/backup.mjs`, `scripts/restore-key.mjs`, `backups/` ignore rule, and
`docs/audits/` placeholder were ported. Its modified deploy stub and old generated-doc
assertions were superseded by `main`; its dated bug-plan wording and all remaining loose
state are retained in the recovery archive.

## Safety result

Only the two world-availability source fixes, their three tests, the production SQL
integration test, and the loose backup/audit tooling entered the reconciliation branch.
Everything else is either already represented by `main` or preserved as historical
recovery material rather than merged backward.

## Other non-code items from the old root

| Disposition | Items |
|---|---|
| Keep locally at the canonical path, ignored by Git | The six root environment files, `.vercel/`, `backups/`, and `.release-backups/`. |
| Keep tracked | The standardized `docs/` tree, `docs/audits/`, and the project-local `.agents/` Neon guidance already on `main`. |
| Recovery archive only | `.codex/reports/`, `.codex-remote-attachments/`, `.tmp_1f3d9_home.txt`, `.tmp_citylife_readme.md`, `.tmp_citylife_skill.md`, the stray zero-byte `=` file, old `test-results/`, and the old dependency install. |
| Recreate when needed | `node_modules/`, test output, and other generated caches from the canonical lockfile and test commands. |

No environment or backup file is deleted by this cleanup. Archive-only means it leaves
the live project root but remains recoverable in the dated legacy folder.
