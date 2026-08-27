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
| `PAYPAL_CLIENT_ID` | Server-only client ID for the PayPal REST app in the environment selected by `PAYPAL_ENV`. Required for every PayPal credit route. |
| `PAYPAL_CLIENT_SECRET` | Server-only secret for that same PayPal REST app. Never expose it to the browser, logs, source, or a command line. |
| `PAYPAL_ENV` | Exact value `sandbox` or `live`. Activation always starts with `sandbox`; use `live` only after the complete sandbox order, capture, webhook, gift, and allowance checks pass. |
| `PAYPAL_WEBHOOK_ID` | PayPal's ID for the webhook registered to this deployment and the same sandbox/live app. It is not the webhook URL or secret. |
| `CRON_SECRET` | Bearer secret protecting `/api/internal/payment-recovery`, the five-minute Vercel cron. 32–512 printable characters. |
| `LOG_DRAIN_SECRET` | HMAC secret protecting `POST /api/internal/log-drain`. It must exactly match the Vercel drain delivery secret and be 64 lowercase hexadecimal characters (32 random bytes). Until this is set and the drain is created, the receiver is dormant. |
| `LATER_HOLDER_CURSOR_KEY` | Server-only 64-hex key deriving per-resident later-holder cursor tokens. Absent or malformed, that index answers 503. Rotation invalidates outstanding cursors; readers restart from the first page. Preview and production may differ; keep each stable. |
| `HOSTED_CHAT_SIGNIN_ENABLED` | Staged rollout gate for hosted-chat sign-in. |
| `IDENTITY_ROTATION_ENABLED` | Staged rollout gate for the rotation door. |
| `IDENTITY_RECOVERY_ENABLED` | Staged rollout gate for the recovery door. |
| `HOSTED_CHAT_OAUTH_CLIENTS` | Approved hosted-chat OAuth client registrations. |
| `HOSTED_CHAT_CIMD_ORIGINS` | Allowed client-ID-metadata-document origins. |
| `VERCEL`, `VERCEL_ENV`, `VERCEL_BRANCH_URL`, `VERCEL_URL`, `NODE_ENV` | Platform and environment detection. `VERCEL_ENV` selects the preview database path above. When the configured public origin is a Vercel Preview alias, share metadata uses only this project's injected branch URL, then its exact deployment URL; malformed or foreign values fall back to the configured origin. |

## PayPal prepaid-credit activation (dormant until all four values are set)

The server-side PayPal integration uses Orders v2 for one-time purchases and
Subscriptions for the weekly self allowance. PayPal hosts payment approval; the city
never asks for or stores card data. Missing or invalid PayPal configuration is a valid
dormant state: `/buy`, its assets, and every PayPal lookup, create, capture, subscription,
and webhook route answer an operation-specific `503`. The page, lookup, order creation,
and allowance creation say that no payment was started only for a fresh operation. A valid
saved return or cancel URL may follow an approval, so dormant mode says to keep that exact
URL and purchase ID, reconnect PayPal, and reload without starting another approval.
Capture likewise retries the same purchase and order without paying again. Webhook delivery
asks PayPal to retry that exact event. Do not advertise the buy door until the complete
configuration is active. The separate `/gift-redirect` recovery door remains available
because it starts no PayPal operation.

Activate in this order:

1. In the PayPal Developer Dashboard, create a **Sandbox** REST app for 1F3D9 under a
   sandbox business account. Keep its client ID and client secret in the approved secret
   manager. Do not paste either value into source, a prompt, shell history, or a public
   issue. Leave production untouched.
2. Add a sandbox webhook for the exact Vercel preview origin plus
   `/api/city-credit/paypal/webhook`. Subscribe to exactly the implemented credit-delivery
   and dispute-lifecycle events: `PAYMENT.CAPTURE.COMPLETED` for one-time Orders,
   `PAYMENT.SALE.COMPLETED` for Subscription renewals, and
   `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, and
   `CUSTOMER.DISPUTE.RESOLVED`. Save the PayPal-generated webhook ID separately from the
   client secret.
3. Apply `db/migrations/20260826_prepaid_city_credit.sql` to the isolated preview database.
   Pre-set `NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_PREVIEW_BRANCH_ID`,
   `NEON_PRODUCTION_BRANCH_ID`, and `PREVIEW_DATABASE_URL_UNPOOLED`; the migrator proves
   that the direct database URL belongs to the named non-production branch. Then run:

   ```sh
   CONFIRM_PREPAID_CITY_CREDIT=INSTALL_PREPAID_CITY_CREDIT_AND_PAYPAL_CUSTODY \
   CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW \
   npm run migrate:preview:prepaid-city-credit
   ```

   Set the preview-only
   `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox`, and
   `PAYPAL_WEBHOOK_ID` in Vercel. Redeploy the same reviewed commit; environment changes do
   not alter an already-running deployment.
4. In sandbox, complete one self order before testing anything live. Confirm the page
   echoes the intended resident number and handle before leaving for PayPal, capture adds
   the exact whole-dollar credit once, `/api/me` shows its private receipt, and a repeated
   capture plus a replayed verified webhook adds nothing. Then test gift accept, refusal,
   claim-token redirect (including another redirect while still pending or refused), and
   one weekly allowance payment. Confirm no purchaser identity appears to either resident
   or on a public surface. Record the real PayPal sandbox evidence; fake-backed tests are
   not activation evidence.
5. Only after step 4 passes, switch Apps & Credentials to **Live** and create or select
   the production REST app, with its separate live client ID and secret. Register
   `https://1f3d9.com/api/city-credit/paypal/webhook` with
   `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.SALE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED`,
   `CUSTOMER.DISPUTE.UPDATED`, and `CUSTOMER.DISPUTE.RESOLVED`, and copy that live webhook
   ID.
   Before enabling routes, pre-set `NEON_API_KEY`, `NEON_PROJECT_ID`,
   `NEON_PRODUCTION_BRANCH_ID`, `PRODUCTION_DATABASE_URL_UNPOOLED`, and a fresh safe
   `PRODUCTION_SNAPSHOT_NAME`. The migrator proves the target, creates and verifies that
   named snapshot, and then applies the production migration only through:

   ```sh
   CONFIRM_PREPAID_CITY_CREDIT=INSTALL_PREPAID_CITY_CREDIT_AND_PAYPAL_CUSTODY \
   CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
   npm run migrate:production:prepaid-city-credit
   ```

   Set the production
   values from the live app with `PAYPAL_ENV=live`; never reuse a sandbox secret or webhook
   ID. Redeploy the exact merged commit, verify an unconfigured-to-configured transition,
   then use the smallest supported real order and a read-only or self-cleaning production
   probe. Record what PayPal and `/api/me` actually returned.

If any app, environment, webhook URL, webhook ID, event, amount, currency, resident
number/handle, order ID, capture ID, or subscription ID is uncertain, stop before payment.
Restore the complete matching configuration or return to the dormant `503` state; never
mix sandbox and live identifiers. PayPal application approval, live settlement, card
behavior, and live webhook delivery cannot be verified from repository tests alone.

Provider references: [REST authentication](https://developer.paypal.com/api/rest/authentication/),
[sandbox-to-production switch](https://developer.paypal.com/api/rest/production/),
[webhook registration and Webhook ID](https://developer.paypal.com/api/rest/webhooks/rest/),
and [event names](https://developer.paypal.com/api/rest/webhooks/event-names/).

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
| `CONFIRM_LOCAL_SCHEMA`, `CONFIRM_WORLD_ROOT_TOPOLOGY`, `CONFIRM_CITY_CREDIT`, `CONFIRM_PREPAID_CITY_CREDIT`, `CONFIRM_PAYPAL_CREDIT_DISPUTES`, `CONFIRM_PREVIEW_MIGRATION`, `CONFIRM_PRODUCTION_MIGRATION` | Migration acknowledgements; prepaid credit requires `CONFIRM_PREPAID_CITY_CREDIT=INSTALL_PREPAID_CITY_CREDIT_AND_PAYPAL_CUSTODY`, PayPal dispute custody requires `CONFIRM_PAYPAL_CREDIT_DISPUTES=INSTALL_PAYPAL_CREDIT_DISPUTE_CUSTODY`, and each remote target also requires the Neon identity proofs above. |
| `PRODUCTION_SNAPSHOT_NAME` | Name of the verified pre-migration Neon snapshot; production migrations refuse to run without it. |
| `SNAPSHOT_DATABASE_URL` | Source database for the public-snapshot exporter. |
| `GITHUB_TOKEN`, `GITHUB_REPOSITORY` | Publishing public snapshots as GitHub releases. |
| `CONFIRM_LATER_HOLDER_PROVIDER_KEY`, `CONFIRM_THING_MAKER_MIGRATION`, `CONFIRM_LATER_HOLDER_MIGRATION`, `CONFIRM_RESUMABLE_REGISTRATION_MIGRATION`, `CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION` | Acknowledgements `scripts/deploy.sh --prepare` requires (exact values in [DEPLOYMENT.md](DEPLOYMENT.md)). |

Names constructed dynamically in code (for example `${TARGET}_DATABASE_URL_UNPOOLED`)
will not appear in a plain grep for the literal name; this table is the authority.

## Cleanup rule

A later credential consolidation should first prove which provider values are
current, move them to an approved secret store, verify access, and receive explicit
deletion approval before any local secret file is destroyed.
