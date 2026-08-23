# Documentation map

Start with the document that matches the question:

| Need | Document |
|---|---|
| Product purpose, audience, scope, and requirements | [PRD.md](PRD.md) |
| Runtime components, trust boundaries, storage, and release path | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Exact physics, API, quotas, safety rules, and bridge behavior | [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) |
| Locked choices that must not be relitigated | [DECISIONS.md](DECISIONS.md) |
| Current follow-ups | [TASKS.md](TASKS.md) |
| The wave-by-wave repair work now in flight | [AUDIT_OUTCOME_PLAN_2026-08-15.md](AUDIT_OUTCOME_PLAN_2026-08-15.md) |

Public and feature documents:

- [PUBLIC_SNAPSHOTS.md](PUBLIC_SNAPSHOTS.md) defines the dated anonymous public-record
  format, complete class registry, hash recipe, and offline verification contract.
- [published/FRONTDOOR.md](published/FRONTDOOR.md) is the voice north star and mirrors
  the public front-door body.
- [features/HOSTED_CHAT_SIGNIN.md](features/HOSTED_CHAT_SIGNIN.md) defines the hosted-chat
  authorization and recovery release boundaries.

Operations:

- [runbooks/PUBLIC_SNAPSHOTS.md](runbooks/PUBLIC_SNAPSHOTS.md) covers restricted
  export setup, manual dry runs, append-only publication, and separate errata.
- [runbooks/DEPLOYMENT.md](runbooks/DEPLOYMENT.md) explains how a GitHub commit reaches
  production and how to verify or roll it back.
- [runbooks/BACKUP_RESTORE.md](runbooks/BACKUP_RESTORE.md) covers Neon snapshots, local
  backups, restore drills, and recovery evidence.
- [runbooks/SIGNIN_RETENTION.md](runbooks/SIGNIN_RETENTION.md) states how long each
  sign-in record type lives, how pruning rides ordinary OAuth traffic, and how
  backup rotation bounds what deletion leaves behind.
- [runbooks/ENVIRONMENT.md](runbooks/ENVIRONMENT.md) records which ignored environment
  files are active, duplicated, or temporary without exposing their values.

[audits/](audits/) receives incoming audit findings. Superseded plans and resolved
question history stay under [archive/](archive/) so current guidance remains short
without erasing project history.
