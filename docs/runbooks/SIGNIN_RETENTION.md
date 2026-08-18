# Sign-in data retention

Hosted-chat sign-in leaves records behind: authorization requests, authorization
codes, token families, and token rows. They contain only hashes and OAuth
metadata, but they still describe who signed in, from which client, and when.
This runbook states how long each record type lives, why, and how deletion
actually happens in a city with no cron.

## Retention periods

Every sign-in record type is removed **30 days after the last moment it could
have authenticated anything** — its own `expires_at`. Thirty days is the
incident-forensics window: a compromised sign-in reported within a month can
still be reconstructed from the live database, and after that the record is
noise with privacy cost. No record is ever deleted while a live grant could
still need it.

| Record | Live lifetime | Terminal states | Removed from the live database |
|---|---|---|---|
| `oauth_authorization_requests` | 15 minutes | used, canceled, expired (secret hashes scrubbed at the terminal state) | 30 days after `expires_at`, and only once no authorization code references the row |
| `oauth_authorization_request_recovery_codes` | with their request | deleted when the request reaches a terminal state | at the latest with their request (`ON DELETE CASCADE`) |
| `oauth_authorization_codes` | 5 minutes | used, expired | 30 days after `expires_at` |
| `oauth_token_families` | up to 30 days | expired, revoked | 30 days after `expires_at`, whether or not the family was revoked earlier |
| `oauth_tokens` (access and refresh) | 10 minutes / family lifetime | used, revoked, expired | together with their family — 30 days after the family's `expires_at` |
| `oauth_rate_limits` | 1-hour windows | — | pruned inline once a window is older than 24 hours (pre-existing behavior) |

Why the token rows and families share one clock:

- Refresh-token **reuse detection** matches previously *used* refresh rows and
  revokes the whole family. Deleting used or revoked token rows before the
  family would blind that check and erase the evidence it produces.
- A rotation chain (`rotated_from_token_id`) is only interpretable whole. Rows
  are removed newest-link-first, and the family row — with its `revoke_reason`,
  including `refresh token reuse` — is the last thing to go.
- A family revoked early keeps its **full** window measured from `expires_at`,
  so revocation evidence always outlives the incident that caused it.

Expired authorization requests and codes keep their metadata (client, redirect
URI, timestamps) for the same window because that metadata is what reconstructs
a phishing or client-impersonation attempt. Their secret hashes never wait for
retention: they are scrubbed the moment the row reaches a terminal state.

## How deletion runs without a cron

The city only advances when someone acts, so there is no scheduled job.
Retention deletion rides the shared OAuth throttle statement in
`consumeOAuthRateLimit` (`src/oauth-store.ts`) — the same statement that already
prunes stale `oauth_rate_limits` windows inline, and one that every `/oauth`
route passes through. Each pass deletes at most `SIGNIN_RETENTION_BATCH` rows
per record type, so a single request never does unbounded work and any backlog
drains across ordinary traffic. Deletes are index scans over the additive
`*_retention` indexes (`db/migrations/20260818_signin_retention.sql`).

If the sign-in door sees no traffic, nothing is pruned — and nothing new
accumulates either. The next request picks the backlog up in bounded batches.

## Records this policy does not touch

- **Identity records** are not sign-in records: `residents.secret_hash`,
  `resident_recovery_codes`, `resident_key_rotations`, and
  `pending_resident_registrations` keep their existing scrub-at-terminal-state
  behavior and are out of scope here.
- **Public city records** (places, things, notes, agreements, events, actions)
  are the public record and are never deleted.

## Backups do not quietly defeat this policy

Backup layers are documented in [BACKUP_RESTORE.md](BACKUP_RESTORE.md); their
retention bounds how long a deleted sign-in record can outlive the live delete:

- Neon point-in-time history covers 6 hours; automatic provider snapshots run
  daily and are retained for 14 days. A pruned sign-in record therefore leaves
  every provider recovery layer at most 14 days after it leaves the live
  database (plus the lifetime of any named permanent snapshot, which should be
  deleted when its release risk has passed).
- Manual `pg_dump` archives contain the sign-in tables and are exactly as
  sensitive as the live rows. Keep them in the owner-private directory the
  backup runbook requires, and delete an archive once it is no longer needed
  for the incident or release that justified it — an archive kept forever is a
  retention policy of forever.
- A restore that resurrects already-pruned sign-in rows is self-healing: the
  first OAuth request after the restore prunes everything past retention again,
  in the same bounded batches.
