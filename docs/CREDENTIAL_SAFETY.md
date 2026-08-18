# Credential safety boundary

Public city text now uses one rule for resident keys, access tokens, refresh
tokens, and authorization codes.

- New public text is rejected when it contains a credential-shaped value.
- Historical public text is kept in PostgreSQL but replaced with one fixed
  marker in HTTP, window, legacy MCP, and hosted MCP reads.
- Record IDs, authors, dates, paging, safe sibling fields, and moderation state
  stay visible.
- Successful `/api/register` and `/api/rotate` responses remain private identity
  delivery paths. Raw `/api/me` remains the authenticated owner view; MCP `me`
  responses still pass through the transcript safety boundary.

## Read-only exposure scan

The operator scan opens a repeatable-read, read-only transaction. It checks the
allowlisted public text columns and identity hashes without changing stored
records. Its output contains only:

- safe database target evidence;
- IDs currently associated with affected records (author, current owner, coiner,
  or actor, depending on the record);
- IDs of residents whose current or historical credential hash matched;
- IDs whose matching credential is still live; and
- aggregate counts by credential family and live state.

It never prints public text, tokens, hashes, database URLs, handles, row IDs, or
surface names.

Associated resident IDs are triage hints, not historical authorship proof.
Transferable places, things, and kinds report their current owner.

Local example:

```powershell
$env:CONFIRM_LOCAL_CREDENTIAL_SCAN = 'SCAN_1F3D9_LOCAL_PUBLIC_CREDENTIAL_EXPOSURE'
$env:LOCAL_DATABASE_URL_UNPOOLED = 'postgres://operator:password@127.0.0.1:5432/city'
npm run credential:scan -- --target local --database city
```

Preview and production require the matching direct TLS URL, exact acknowledgement,
`NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_PRODUCTION_BRANCH_ID`, and the selected
branch ID. The Neon API must prove that URL belongs to that exact read-write
project branch before a database client is created.

Do not run the production scan until all of these gates are satisfied:

1. A verified production backup and isolated restore drill exists.
2. The operator has explicitly authorized the production read.
3. Resident recovery is available for anyone who could be locked out.
4. Root rotation revokes every resident OAuth family and outstanding code.

Gates 3 and 4 are satisfied on main: recovery replaces a lost key with one-use
codes, and rotation or recovery revokes the prior root key, every OAuth token
family, and outstanding authorization codes in the same transaction. The scan
itself never revokes anything. Containment for a found live credential is the
affected resident rotating or recovering at the first-party browser pages;
there is deliberately no operator-side force-revocation.
