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

## Repository cost automation

The public repository's weekly `Cost tripwire` workflow reads provider metadata but
never receives application or database credentials. Configure these values under
**GitHub repository Settings → Secrets and variables → Actions**:

Before adding `NEON_API_KEY` to GitHub, set it and `NEON_PROJECT_ID` in your shell and
rehearse once with a real closed PR's head ref: `node --experimental-strip-types
scripts/neon-preview-cleanup.ts --dry-run --head-ref "feature/cost-safe"`. The rehearsal
lists and re-proves the exact Neon branch but makes no delete call.

| Kind | Name | Purpose |
|---|---|---|
| Secret | `VERCEL_TOKEN` | Vercel access token allowed to read the team's FOCUS billing charges. |
| Secret | `NEON_API_KEY` | Project-scoped Neon API key allowed to list branches and delete the exact branch selected by the PR-close guard. |
| Variable | `VERCEL_TEAM_ID` | Non-secret Vercel team ID supplied to the billing endpoint. |
| Variable | `NEON_PROJECT_ID` | Non-secret city Neon project ID supplied to branch list/delete endpoints. |

GitHub supplies the issue-writing token itself. Provider secrets exist only in the
step that needs them and must never be copied into workflow arguments, logs, issue
text, or job summaries. A missing secret or variable skips that provider check and
opens or updates the issue with `SKIPPED`; an API or response-shape failure is
`FAILED`. Neither state is reported as zero usage.

[`config/cost-tripwire.json`](../../config/cost-tripwire.json) is the reviewed source
for thresholds. Its initial values are 60,000 daily Edge Requests and 60,000 daily
Function Invocations for `1f3d9`, $5 maximum effective team cost in one UTC day, and
eight `preview/*` Neon branches. Eight leaves two places inside Neon's first ten for
`main` and the protected `preview/shared-vercel-testing`. Usage alerts only when it is
greater than three times a daily project baseline; exact equality is not an alert.
Every project name returned by Vercel must have a baseline. An unknown project makes
the report incomplete and keeps the issue loud until its reviewed baseline is added.

The workflow reads the previous seven complete UTC days every Monday and can be run
manually. Manual runs default to dry-run: provider reads happen, the full proposed
issue text is printed, and GitHub is not changed. A normal alert reuses the one open
issue titled `Cost tripwire` and appends a dated, run-marked comment; a healthy run
adds no issue noise. When the issue appears:

1. Check `FAILED`, `SKIPPED`, and unconfigured-project lines before trusting totals.
2. Find the first UTC day and project above its displayed limit; compare Vercel paths,
   deployments, drains, and recent releases for that window.
3. If Neon is high, identify owners before deleting anything; `main` and
   `preview/shared-vercel-testing` are protected.
4. Contain the cost source, run the workflow in dry-run, then run it normally to append
   the verified numbers to the existing issue.

Check that the Neon–Vercel integration's own cleanup is enabled as defense in depth.
In the Neon-managed integration, select **Automatically delete obsolete Neon branches**;
that cleanup detects a deleted Git branch only on later preview activity. In the
Vercel-managed integration, cleanup follows deletion of the last associated Vercel
deployment, which is governed by Vercel's pre-production deployment retention.
Neither path promises deletion at PR close. The separate PR-close workflow therefore
lists all active branches, derives only `preview/<closed PR head>`, re-reads the exact
matching branch ID, and deletes only when the name still matches. The
`pull_request_target` workflow definition and checked-out script both come from the
reviewed default branch, and a job-level repository identity check skips every fork
before secrets are available. Provider cleanup and the weekly branch cap remain the
fork backstop. Missing configuration, absent branches, and every action are written
to the job summary.
See Neon's [branch cleanup guide](https://neon.com/docs/guides/vercel-branch-cleanup)
and Vercel's [deployment retention guide](https://vercel.com/docs/deployment-retention).

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
| `CRON_SECRET` | Bearer secret protecting the five-minute `/api/internal/payment-recovery` cron and Monday 16:00 UTC `/api/internal/gazette-print` cron. 32–512 printable characters. |
| `LOG_DRAIN_SECRET` | HMAC secret protecting `POST /api/internal/log-drain`. It must exactly match the Vercel drain delivery secret and be 64 lowercase hexadecimal characters (32 random bytes). Until this is set and the drain is created, the receiver is dormant. |
| `LATER_HOLDER_CURSOR_KEY` | Server-only 64-hex key deriving per-resident later-holder cursor tokens. Absent or malformed, that index answers 503. Rotation invalidates outstanding cursors; readers restart from the first page. Preview and production may differ; keep each stable. |
| `COMMUNITY_TOOL_IP_HASH_KEY` | Server-only 64-lowercase-hex key for HMAC-SHA256 community-tool address limits. Generate 32 random bytes in the approved secret store; never expose the key to browsers, logs, source, prompts, or command lines. Missing or malformed, form submission fails closed with 503 before database work. Preview and production may differ; keep each stable because rotation starts fresh address buckets while old keyed hashes age out. |
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
asks PayPal to retry that exact event only when PayPal verification is temporarily
unavailable. Missing or malformed PayPal signature headers must be refused as `401
unverified`, without creating city state and without asking PayPal to retry a caller-built
unsigned event. Do not advertise the buy door until the complete configuration is active.
The separate `/gift-redirect` recovery door remains available because it starts no PayPal
operation.

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

## Place lifecycle rollout

The place lifecycle migration is a pre-deploy prerequisite. Apply it before code that
renames, retires, or restores places can receive traffic. Then rerun the guarded public
search index migration so former place names get the same recoverable concurrent index
build as notes and things. Do not reverse this order.

For an isolated Preview database:

```sh
CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW \
npm run migrate:preview:place-lifecycle
CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW \
npm run migrate:preview:public-search-indexes
```

For Production, create and name the required Neon snapshot first, then run:

```sh
CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
npm run migrate:production:place-lifecycle
CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
npm run migrate:production:public-search-indexes
```

Both pairs also require the matching direct database URL and Neon identity variables
listed below. Deploy only after both commands succeed.

## Community tool review queue

The queue is additive database state. Do not run its migrations from an ordinary
development lane. The operator applies `db/migrations/20260901_community_tool_submissions.sql`
and then `db/migrations/20260901_community_tool_submission_privacy.sql` through the same
guarded Preview-then-Production ceremony used by other additive migrations:

```sh
CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW \
npm run migrate:preview:community-tool-submissions

CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW \
npm run migrate:preview:community-tool-submission-privacy

CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
PRODUCTION_SNAPSHOT_NAME=<verified-snapshot-name> \
npm run migrate:production:community-tool-submissions

CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION \
PRODUCTION_SNAPSHOT_NAME=<verified-snapshot-name> \
npm run migrate:production:community-tool-submission-privacy
```

All four commands also require the matching direct database URL, Neon project key, project
ID, and branch IDs from the operator variables below. The migrator proves those targets;
never substitute a pooled URL or omit the verified Production snapshot.
On its first run, the privacy migration refuses any existing submission or limit row so
an old reversible address hash cannot survive. The form is not live yet, so both tables
must be empty. If that guard fires, stop and investigate; do not delete rows to force it.

Founder resident #1 reads the pending queue through the no-store operator route. Keep
the root key in the approved secret store and inject it only into the operator shell:

```sh
curl --fail-with-body --no-progress-meter \
  -H "Authorization: Bearer $ONEF3D9_FOUNDER_ROOT_KEY" \
  https://1f3d9.com/api/founder/community-tool-submissions
```

For approval, copy the reviewed fields into `src/community-tools.ts`, open and merge the
ordinary logged code change, and verify that exact entry is deployed. A chosen resident
is a self-reported claim that the maintainer checks before listing. Only then mark the
queue row listed. A rejection uses `declined` instead:

```sh
curl --fail-with-body --no-progress-meter -X POST \
  -H "Authorization: Bearer $ONEF3D9_FOUNDER_ROOT_KEY" \
  -H "Content-Type: application/json" \
  --data '{"outcome":"listed"}' \
  https://1f3d9.com/api/founder/community-tool-submissions/QUEUE_ID/review
```

The public `/tools` page reads only the unreviewed count. A pending submission keeps its
submitted fields and keyed address hash until review. Recording either review outcome
clears that submission-row hash in the same transaction; the submitted fields, resident
claim, creation and review timestamps, reviewer, and outcome remain as the maintainer's
review record with no automatic expiry. The separate limits table keeps only the keyed
hash, UTC day, and count; a later submission deletes limit rows more than 30 days old.
Never paste the operator JSON, pending links, address hashes, or founder key into an
issue, commit, prompt, or chat.

The form's public-host check is storage admission, not permission for a future server
fetch. Any future fetcher must resolve and pin only globally routable addresses, repeat
that check for every redirect, and refuse DNS changes before reading response bytes.

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
        "requestPath": "/api/internal/log-drain?verification=${VERCEL_ENDPOINT_VERIFICATION_CODE}"
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
sampling rule drops the receiver's exact delivery path, including its fixed
verification query, before the full-rate catch-all. A bare-path rule does not match
that delivery URL. The drain must not be created without this exclusion; it must be
the exact delivery path including the fixed query. Otherwise each delivery can
generate another eligible delivery and feed itself. Do not create
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
| `CONFIRM_LOCAL_SCHEMA`, `CONFIRM_WORLD_ROOT_TOPOLOGY`, `CONFIRM_CITY_CREDIT`, `CONFIRM_PREPAID_CITY_CREDIT`, `CONFIRM_PAYPAL_CREDIT_DISPUTES`, `CONFIRM_GAZETTE`, `CONFIRM_GAZETTE_ROOM_ACTIVATION`, `CONFIRM_GAZETTE_WITHDRAWAL`, `CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION`, `CONFIRM_PREVIEW_MIGRATION`, `CONFIRM_PRODUCTION_MIGRATION` | Migration acknowledgements. The dormant Gazette schema requires `CONFIRM_GAZETTE=INSTALL_GAZETTE_ARCHIVE_AND_SUBMISSION_LIMIT`; its separate room-opening migration requires `CONFIRM_GAZETTE_ROOM_ACTIVATION=OPEN_GAZETTE_ROOM_AFTER_MATCHING_APP_DEPLOYMENT`. The dormant withdrawal ledger requires `CONFIRM_GAZETTE_WITHDRAWAL=INSTALL_DORMANT_GAZETTE_WITHDRAWAL_LEDGER`; its separate activation requires `CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION=OPEN_GAZETTE_WITHDRAWALS_AFTER_MATCHING_APP_DEPLOYMENT`. Prepaid credit and PayPal dispute values remain documented in their runbooks. Each remote target also requires the Neon identity proofs above. |
| `GAZETTE_DEPLOYMENT_COMMIT`, `GAZETTE_PREVIEW_ORIGIN` | Exact source-and-live-application proof for Gazette room and withdrawal activations. `GAZETTE_DEPLOYMENT_COMMIT` is the 40-character lowercase hexadecimal commit that must equal the full Git `HEAD` of a clean local checkout (tracked and untracked changes are refused) before any live request or database work. `/api/official` must then report it before database preparation and again immediately before activation DDL. Preview also requires the immutable HTTPS deployment origin `https://1f3d9-<deployment-id>-onetapstudiogames-projects.vercel.app`, with an exact 9 lowercase alphanumeric deployment ID and no path; branch aliases and other Vercel projects are refused. Production is fixed to `https://1f3d9.com`. These are operator inputs, not Vercel variables. |
| `PRODUCTION_SNAPSHOT_NAME` | Name of the verified pre-migration Neon snapshot; production migrations refuse to run without it. |
| `SNAPSHOT_DATABASE_URL` | Source database for the public-snapshot exporter. |
| `GITHUB_TOKEN`, `GITHUB_REPOSITORY` | Publishing public snapshots as GitHub releases. |
| `CONFIRM_LATER_HOLDER_PROVIDER_KEY`, `CONFIRM_THING_MAKER_MIGRATION`, `CONFIRM_LATER_HOLDER_MIGRATION`, `CONFIRM_RESUMABLE_REGISTRATION_MIGRATION`, `CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION`, `CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION`, `CONFIRM_RESIDENT_AWARENESS_MIGRATION`, `CONFIRM_GAZETTE_SCHEMA_MIGRATION`, `CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION`, `CONFIRM_PRODUCTION_DRAWING_RELEASE` | Acknowledgements `scripts/deploy.sh --prepare` requires (exact values in [DEPLOYMENT.md](DEPLOYMENT.md)). Gazette uses `CONFIRM_GAZETTE_SCHEMA_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION_WITH_ROOM_CLOSED` during first-release preparation; this acknowledges only the dormant schema and never authorizes either room activation. Withdrawal uses `CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION=APPLIED_TO_PRODUCTION_WITH_WITHDRAWALS_CLOSED_AND_REAL_POSTGRES_PROVEN`; it records the dormant Production state and local staged real-PostgreSQL proof without claiming the known schema-less Preview is Gazette-capable or authorizing withdrawal activation. `CONFIRM_PRODUCTION_DRAWING_RELEASE` is an operator attestation that both Production drawing migrations ran in documented order and every drawing/Gazette/world postcondition was recorded; `--prepare` does not query Production or prove those postconditions. |

Names constructed dynamically in code (for example `${TARGET}_DATABASE_URL_UNPOOLED`)
will not appear in a plain grep for the literal name; this table is the authority.

## Cleanup rule

A later credential consolidation should first prove which provider values are
current, move them to an approved secret store, verify access, and receive explicit
deletion approval before any local secret file is destroyed.
