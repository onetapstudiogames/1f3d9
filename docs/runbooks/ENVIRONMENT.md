# Environment files

The repository is public. Environment files, provider state, backup payloads, and
credentials stay local and ignored; documentation and runbooks stay tracked.

## The six root environment files

| File | Current use | Duplicate status |
|---|---|---|
| `.env.local` | Active local operator configuration. It contains the working database settings and the project-scoped Neon CLI key added on 2026-08-15. | Unique among the six. |
| `.env.deploy` | Active fallback for local database operator scripts when `DATABASE_URL` is not already in the process. | Unique among the six; byte-identical to the old `.rollout-world-root/env.txt` copy. |
| `env.txt` | Legacy manual provider credentials. The current `scripts/deploy.sh --prepare` does not load or deploy from it, and it has no database URL. | Unique among the six. |
| `.tmp-preview.env` | Inactive preview export artifact. | Not an exact duplicate. It has the same key shape and size as `.vercel/.env.preview.local`, but different values. |
| `.tmp-prod-env` | Inactive production export artifact. | Near-duplicate of `.tmp-production.env`: same key set and size, different bytes. |
| `.tmp-production.env` | Inactive production export artifact. | Near-duplicate of `.tmp-prod-env`: same key set and size, different bytes. |

There are no byte-for-byte duplicates within the six root files. Similar key names do
not prove that values are current, so none of the temporary files should be used as a
source of truth.

## What each runtime uses

Vercel deployments use environment values stored in Vercel, not files committed from
this folder. Scope the general `DATABASE_URL` to Production only. Every Preview must
instead receive a Preview-only sensitive `HOSTED_CHAT_PREVIEW_DATABASE_URL` pointing to
its isolated database branch. Preview runtime code ignores `DATABASE_URL`; when the
dedicated value is missing or blank, database work fails closed with a generic
unavailable response.

Local development and operator tools continue to use their explicitly selected local
settings. Local database tools prefer a `DATABASE_URL` already set in the process, then
read `.env.local`, then `.env.deploy`, then `env.txt`.

The Neon key in `.env.local` is scoped only to project `bold-union-44728141`; it was
authenticated successfully after creation. It can still administer that project, so it
must never be printed, pasted into documentation, or committed.

## Cleanup rule

Do not delete any of these six files during repository cleanup. A later credential
consolidation should first prove which provider values are current, move them to an
approved secret store, verify access, and receive explicit deletion approval.
