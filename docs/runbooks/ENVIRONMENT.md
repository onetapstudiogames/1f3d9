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

## What production uses

Vercel production and preview deployments use environment values stored in Vercel, not
files committed from this folder. Local database tools prefer a `DATABASE_URL` already
set in the process, then read `.env.local`, then `.env.deploy`, then `env.txt`.

The Neon key in `.env.local` is scoped only to project `bold-union-44728141`; it was
authenticated successfully after creation. It can still administer that project, so it
must never be printed, pasted into documentation, or committed.

## Later-holder cursor key

`LATER_HOLDER_CURSOR_KEY` is a server-only 32-byte random key encoded as exactly 64
lowercase hexadecimal characters. Store it in Vercel's encrypted environment settings
for Preview and Production; do not place it in any root environment file, derive it
from a resident key, or print it during verification. Preview and Production may use
different values. Keep each value stable within its environment because rotation
invalidates outstanding later-holder cursors; readers then restart from the first page.

Before application rollout, verify the variable name is present and its value has the
required shape in both Vercel environments without copying the value into logs. The
deployment runbook records the separate database-migration prerequisite and the exact
non-secret acknowledgements used by local release preparation.

## Cleanup rule

Do not delete any of these six files during repository cleanup. A later credential
consolidation should first prove which provider values are current, move them to an
approved secret store, verify access, and receive explicit deletion approval.
