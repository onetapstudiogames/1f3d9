# Environment

The repository is public. Environment files, provider state, backup payloads, and
credentials stay local and ignored; documentation and runbooks stay tracked. This
runbook records which ignored files exist, and names every environment variable the
code reads, so nothing about configuration has to be learned by rejection.

## Root environment files

| File | Current use |
|---|---|
| `.env.local` | Active local operator configuration: working database settings and a project-scoped Neon CLI key. The key can administer the Neon project, so it is never printed or committed. |
| `.env.deploy` | Fallback for local database operator scripts when `DATABASE_URL` is not already in the process. |
| `env.txt` | Local operator secrets, hand-maintained. Never loaded by deploy tooling; scripts that need one of its values receive it through the shell. |

Three inactive `.tmp-*` export artifacts from 2026-08-14 were retired from the repo
root on 2026-08-25 during the cleanup; the operator holds copies privately pending the
credential consolidation described at the end of this runbook. Local database tools
prefer a `DATABASE_URL` already set in the process, then read `.env.local`, then
`.env.deploy`.

Production and preview deployments read environment values stored in Vercel, never
files from this folder.

## Runtime variables (set in Vercel; read by the deployed application)

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Pooled Postgres connection for the running site. |
| `HOSTED_CHAT_PREVIEW_DATABASE_URL` | On preview deployments this is the only database URL the server accepts — there is no fallback to `DATABASE_URL`. A preview without it does not work. |
| `PUBLIC_ORIGIN` | The site's own canonical origin. |
| `MARKET_ORIGIN` | Origin of the sibling market, used by the world-aisle bridge's public reads. |
| `BASE_RPC_URL` | Base chain RPC endpoint. Defaults to `https://mainnet.base.org`. |
| `FACILITATOR_URL` | x402 payment facilitator. Defaults to `https://facilitator.payai.network`. |
| `TREASURY_ADDRESS` | Treasury recipient for city fees. |
| `PAYMENT_CUSTODY_READY` | Must be exactly `1` before hosted payment custody operates. This gates money movement. |
| `CRON_SECRET` | Bearer secret protecting `/api/internal/payment-recovery`, the five-minute Vercel cron. 32–512 printable characters. |
| `LATER_HOLDER_CURSOR_KEY` | Server-only 64-hex key deriving per-resident later-holder cursor tokens. Absent or malformed, that index answers 503. Rotation invalidates outstanding cursors; readers restart from the first page. Preview and production may differ; keep each stable. |
| `HOSTED_CHAT_SIGNIN_ENABLED` | Staged rollout gate for hosted-chat sign-in. |
| `IDENTITY_ROTATION_ENABLED` | Staged rollout gate for the rotation door. |
| `IDENTITY_RECOVERY_ENABLED` | Staged rollout gate for the recovery door. |
| `HOSTED_CHAT_OAUTH_CLIENTS` | Approved hosted-chat OAuth client registrations. |
| `HOSTED_CHAT_CIMD_ORIGINS` | Allowed client-ID-metadata-document origins. |
| `VERCEL`, `VERCEL_ENV`, `NODE_ENV` | Platform and environment detection. `VERCEL_ENV` is what selects the preview database path above. |

## Operator variables (never in Vercel; set in the shell when running scripts)

| Name | Purpose |
|---|---|
| `NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_PREVIEW_BRANCH_ID`, `NEON_PRODUCTION_BRANCH_ID` | Identity proofs: remote backup and migration scripts verify the named Neon endpoint before connecting. |
| `LOCAL_DATABASE_URL_UNPOOLED`, `PREVIEW_DATABASE_URL_UNPOOLED`, `PRODUCTION_DATABASE_URL_UNPOOLED` | Direct port-5432 URLs for `pg_dump` and migrations. Pooled URLs are refused. |
| `CONFIRM_LOCAL_BACKUP`, `CONFIRM_PREVIEW_BACKUP`, `CONFIRM_PRODUCTION_BACKUP` | Exact-value acknowledgements required by the backup script (values in [BACKUP_RESTORE.md](BACKUP_RESTORE.md)). |
| `CONFIRM_LOCAL_CREDENTIAL_SCAN`, `CONFIRM_PREVIEW_CREDENTIAL_SCAN`, `CONFIRM_PRODUCTION_CREDENTIAL_SCAN` | Same pattern for the credential scanner. |
| `CONFIRM_LOCAL_SCHEMA`, `CONFIRM_WORLD_ROOT_TOPOLOGY`, `CONFIRM_CITY_CREDIT`, `CONFIRM_PREVIEW_MIGRATION`, `CONFIRM_PRODUCTION_MIGRATION` | Migration acknowledgements; each remote target also requires the Neon identity proofs above. |
| `PRODUCTION_SNAPSHOT_NAME` | Name of the verified pre-migration Neon snapshot; production migrations refuse to run without it. |
| `SNAPSHOT_DATABASE_URL` | Source database for the public-snapshot exporter. |
| `GITHUB_TOKEN`, `GITHUB_REPOSITORY` | Publishing public snapshots as GitHub releases. |
| `CONFIRM_LATER_HOLDER_PROVIDER_KEY`, `CONFIRM_THING_MAKER_MIGRATION`, `CONFIRM_LATER_HOLDER_MIGRATION` | Acknowledgements `scripts/deploy.sh --prepare` requires (exact values in [DEPLOYMENT.md](DEPLOYMENT.md)). |

Names constructed dynamically in code (for example `${TARGET}_DATABASE_URL_UNPOOLED`)
will not appear in a plain grep for the literal name; this table is the authority.

## Cleanup rule

A later credential consolidation should first prove which provider values are
current, move them to an approved secret store, verify access, and receive explicit
deletion approval before any local secret file is destroyed.
