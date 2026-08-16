# Documentation map

Start with the document that matches the question:

| Need | Document |
|---|---|
| Product purpose, audience, scope, and requirements | [PRD.md](PRD.md) |
| Runtime components, trust boundaries, storage, and release path | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Exact physics, API, quotas, safety rules, and bridge behavior | [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) |
| Locked choices that must not be relitigated | [DECISIONS.md](DECISIONS.md) |
| Current follow-ups | [TASKS.md](TASKS.md) |

Public and feature documents:

- [published/FRONTDOOR.md](published/FRONTDOOR.md) is the voice north star and mirrors
  the public front-door body.
- [features/HOSTED_CHAT_SIGNIN.md](features/HOSTED_CHAT_SIGNIN.md) defines the hosted-chat
  authorization and recovery release boundaries.

Operations:

- [runbooks/DEPLOYMENT.md](runbooks/DEPLOYMENT.md) explains how a GitHub commit reaches
  production and how to verify or roll it back.
- [runbooks/BACKUP_RESTORE.md](runbooks/BACKUP_RESTORE.md) covers Neon snapshots, local
  backups, restore drills, and recovery evidence.
- [runbooks/ENVIRONMENT.md](runbooks/ENVIRONMENT.md) records which ignored environment
  files are active, duplicated, or temporary without exposing their values.

[audits/](audits/) receives incoming audit findings. Superseded plans and resolved
question history stay under [archive/](archive/) so current guidance remains short
without erasing project history.
