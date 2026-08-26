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
| `LOG_DRAIN_SECRET` | HMAC secret protecting `POST /api/internal/log-drain`. It must exactly match the Vercel drain delivery secret and be 64 lowercase hexadecimal characters (32 random bytes). Until this is set and the drain is created, the receiver is dormant. |
| `LATER_HOLDER_CURSOR_KEY` | Server-only 64-hex key deriving per-resident later-holder cursor tokens. Absent or malformed, that index answers 503. Rotation invalidates outstanding cursors; readers restart from the first page. Preview and production may differ; keep each stable. |
| `HOSTED_CHAT_SIGNIN_ENABLED` | Staged rollout gate for hosted-chat sign-in. |
| `IDENTITY_ROTATION_ENABLED` | Staged rollout gate for the rotation door. |
| `IDENTITY_RECOVERY_ENABLED` | Staged rollout gate for the recovery door. |
| `HOSTED_CHAT_OAUTH_CLIENTS` | Approved hosted-chat OAuth client registrations. |
| `HOSTED_CHAT_CIMD_ORIGINS` | Allowed client-ID-metadata-document origins. |
| `VERCEL`, `VERCEL_ENV`, `NODE_ENV` | Platform and environment detection. `VERCEL_ENV` is what selects the preview database path above. |

## Runtime log drain (dormant until the operator creates it)

`POST /api/internal/log-drain` is the operator-only receiving half of a Vercel
NDJSON log drain. It accepts at most 4 MiB and 10,000 nonblank lines per
delivery, writes valid rows in chunks of 500, stores only the reviewed
runtime-log fields, strips request query strings, and truncates text before
writing it to `runtime_logs`. The required Vercel `projectId` is the stable
value stored in `project`; optional project names cannot split the index.
Vercel delivery retries are deduplicated by log ID. A durable database claim
lets only one of the first five-minute cron ticks in each UTC hour delete at
most 1,000 rows received more than 30 days ago; a purge failure cannot turn a
successful payment-recovery cron run into a failure. The additive migration is
a pre-deploy prerequisite; until the drain is created, retention sees an empty
table and has nothing to delete.

The route fails closed with 503 when `LOG_DRAIN_SECRET` is absent or malformed.
Normal deliveries require Vercel's lowercase hexadecimal HMAC-SHA1 of the exact
raw body in `x-vercel-signature`. During drain creation, the endpoint URL carries
the team's bounded fixed verification code as `?verification=...`; the route
echoes it in `x-vercel-verify`. It also supports an incoming bounded
`x-vercel-verify` challenge defensively. A supplied signature must always pass,
and signed deliveries that retain the fixed verification query are still
ingested. The route never stores headers, cookies, IP addresses, query strings,
or unreviewed payload fields.

After this change is reviewed, activate it in this order:

1. Set the same new `LOG_DRAIN_SECRET` in both Vercel projects (or their shared
   team environment). Generate 32 random bytes as exactly 64 lowercase hex
   characters in a secret manager; do not reuse `CRON_SECRET`. This fixed shape
   is safe to place in Vercel's JSON request without hand-escaping. Vercel
   environment changes apply only to new deployments, so setting it does not
   activate the currently deployed receiver.
2. Run `npm run migrate:production:runtime-logs` with the normal production
   migration identity proofs, acknowledgement, and snapshot settings.
3. Merge the reviewed PR, or redeploy the city production deployment if the PR
   was already merged. The city production deployment must be newer than the
   environment change and must not start until the migration in step 2 passed.
4. Load the same secret and a Vercel access token into local shell variables
   through a password manager or the hidden prompts below. Never paste either
   value into a command or shell history. Replace the three non-secret ID
   placeholders when prompted:

```bash
read -rsp 'Vercel access credential> ' VERCEL_ACCESS_TOKEN; printf '\n'
read -rsp 'Drain HMAC credential> ' LOG_DRAIN_SECRET; printf '\n'
read -rp 'Vercel team ID (<VERCEL_TEAM_ID>): ' VERCEL_TEAM_ID
read -rp '1f3d9 project ID (<1F3D9_PROJECT_ID>): ' ONEF3D9_PROJECT_ID
read -rp '1f3ea project ID (<1F3EA_PROJECT_ID>): ' ONEF3EA_PROJECT_ID

curl --silent --show-error --fail-with-body \
  --request GET \
  --config <(printf 'url = "%s"\nheader = "Authorization: Bearer %s"\n' \
    "https://api.vercel.com/v1/verify-endpoint?teamId=${VERCEL_TEAM_ID}" \
    "${VERCEL_ACCESS_TOKEN}")

read -rsp 'verificationCode from that response: ' VERCEL_ENDPOINT_VERIFICATION_CODE
printf '\n'
```

Then make exactly this one drain-creation `POST`. Bash expands the secrets into
standard input and a private header pipe, not the command line or shell history:

```bash
curl --silent --show-error --fail-with-body \
  --request POST \
  --config <(printf 'url = "%s"\nheader = "Authorization: Bearer %s"\n' \
    "https://api.vercel.com/v1/drains?teamId=${VERCEL_TEAM_ID}" \
    "${VERCEL_ACCESS_TOKEN}") \
  --header "Content-Type: application/json" \
  --data-binary @- <<JSON
  {
    "name": "1f3d9-and-1f3ea-runtime-logs",
    "projects": "some",
    "projectIds": [
      "${ONEF3D9_PROJECT_ID}",
      "${ONEF3EA_PROJECT_ID}"
    ],
    "filter": {
      "version": "v2",
      "filter": {
        "type": "basic",
        "log": {
          "sources": ["lambda", "edge"]
        },
        "deployment": {
          "environments": ["production"]
        }
      }
    },
    "sampling": [
      {
        "type": "head_sampling",
        "rate": 0,
        "env": "production",
        "requestPath": "/api/internal/log-drain"
      },
      {
        "type": "head_sampling",
        "rate": 1,
        "env": "production"
      }
    ],
    "schemas": {
      "log": {
        "version": "v1"
      }
    },
    "delivery": {
      "type": "http",
      "endpoint": "https://1f3d9.com/api/internal/log-drain?verification=${VERCEL_ENDPOINT_VERIFICATION_CODE}",
      "encoding": "ndjson",
      "compression": "none",
      "headers": {},
      "secret": "${LOG_DRAIN_SECRET}"
    },
    "source": {
      "kind": "self-served"
    }
  }
JSON
unset VERCEL_ACCESS_TOKEN LOG_DRAIN_SECRET VERCEL_ENDPOINT_VERIFICATION_CODE
```

This request assumes both projects belong to the same Vercel team. It selects
production Lambda and Edge runtime logs from both projects. The first ordered
sampling rule drops the receiver's own invocation logs before the full-rate
catch-all. The drain must not be created without this exclusion: otherwise each
delivery can generate another eligible delivery and feed itself. Do not create
the drain before the migration, environment value, and newer city deployment
are live; Vercel tests the endpoint during creation and may disable a repeatedly
failing delivery target. The receiver rejects compressed deliveries, so keep
`compression` pinned to `none`.

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
