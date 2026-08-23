# Wave 11 ChatGPT sign-in investigation — 2026-08-22

## Outcome

The 1F3D9 OAuth flow did not fail for `lyric-sol`. The retained city records show one
authorization request for that resident on 2026-08-21. It reached approval, issued an
authorization code, and exchanged that code for OAuth tokens.

The strongest explanation for the reported generic ChatGPT page is stale connector
state: the first connection used the wrong `/mcp` address; creating the corrected
`/mcp/connect` connection then hit an existing-name collision; reopening or continuing
the old connection kept the original wrong address. The screenshots and city records
support this explanation, but it remains an inference because current ChatGPT provider
logs and the reporter's signed-in ChatGPT connection were not available in this local
environment.

## Safe evidence checked

- The reported screenshots show the original `https://1f3d9.com/mcp` setup, the generic
  application error, the later corrected `/mcp/connect` attempt, and the existing-name
  collision. The attachment directory was read only and was not added to Git.
- In a read-only production transaction, August 20–22 contained 93 ChatGPT CIMD
  authorization requests, 53 approved requests, 56 finished requests, 70 issued codes,
  and 64 exchanged codes. These are counts only; no credential or form body was read or
  recorded in this report.
- The single request associated with `lyric-sol` was approved and finished, and its
  authorization code was issued and exchanged at `2026-08-21T08:05:15.666Z`.
- Anonymous live checks showed normal `/mcp/connect` initialization, tool discovery,
  protected-resource metadata, authorization-server metadata, and current ChatGPT CIMD.
- Current provider/application logs could not be inspected: there was no signed-in
  browser runtime, Vercel CLI session, or Vercel token. No live setting was changed.

## Current OpenAI contract checked

The implementation was compared with OpenAI's current
[authentication requirements](https://developers.openai.com/plugins/build/auth) and
[ChatGPT connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
The checked flow preserves:

- exact callback matching, exact `resource`, `city:resident` scope, state, and PKCE S256;
- protected-resource and authorization-server discovery;
- callback-specific ChatGPT CIMD when issuer response protection is not advertised;
- public token-endpoint authentication (`none`), which intersects with ChatGPT's current
  advertised `none` and `private_key_jwt` choices; and
- no dynamic registration endpoint and no false issuer-response claim.

OpenAI documents developer-mode connection creation on ChatGPT web. The checked official
documentation does not document creating that connection in the mobile app or a mobile
browser's desktop-site mode. Existing plugins may be usable on mobile; that is separate
from creating a developer-mode connection.

## Changes made

- `/mcp` now recognizes an OAuth access token as a wrong-door request and returns safe,
  actionable guidance to remove the stale ChatGPT connection and use `/mcp/connect`.
- Front-door, compact machine, generated, setup-guide, MCP, and system-design wording now
  distinguish the local key-capable door from the hosted ChatGPT door and explain name
  collisions and stale connections.
- OAuth failures now receive an `X-Request-ID` and emit one bounded diagnostic record with
  only stage, request ID, safe client origin, error class, status, and elapsed time.
  Unexpected storage failures return private `503` retry responses instead of a raw `500`.
- OAuth preflights no longer inherit the site's public wildcard CORS policy.
- The isolated browser proof now exchanges a code, rotates the refresh token, performs a
  harmless signed-in `me` read, verifies wrong-door guidance, and checks narrow layout.

No production resident was registered, rotated, revoked, or edited. No resident key,
authorization code, access token, refresh token, raw browser form, payment value, or
sensitive query value was printed, logged, committed, or placed in a test artifact.
