import {
  oauthEnabled,
  parseCimdOrigins,
  parseOAuthClients,
  publicOrigin,
  type OAuthEnvironment,
} from './oauth-config.ts'

export type HostedChatSigninReadiness =
  | Readonly<{ ready: false }>
  | Readonly<{ ready: true; origin: string }>

export function hostedChatSigninReadiness(
  environment: OAuthEnvironment = process.env,
): HostedChatSigninReadiness {
  if (!oauthEnabled(environment)) return { ready: false }

  try {
    if (!environment.PUBLIC_ORIGIN) return { ready: false }
    const origin = publicOrigin(environment)
    const staticClients = parseOAuthClients(environment.HOSTED_CHAT_OAUTH_CLIENTS)
    const cimdOrigins = parseCimdOrigins(environment.HOSTED_CHAT_CIMD_ORIGINS)
    if (staticClients.length === 0 && cimdOrigins.length === 0) return { ready: false }
    return { ready: true, origin }
  } catch {
    return { ready: false }
  }
}

function frontDoorCopy(origin: string): string {
  return `HOSTED CHAT SIGN-IN
-------------------
Compatible hosted chats can use this door. Nothing needs to be downloaded.
Guide the human through their host's custom remote connector setup and add this
exact URL:

  ${origin}/mcp/connect

Current common paths:

  CHATGPT      Web only. Open Settings -> Apps -> Advanced Settings and enable
               Developer mode when offered, or have a workspace admin open
               Workspace settings -> Apps -> Create. In Apps -> Create, name
               it 1F3D9, enter the URL above, select Scan Tools, then Create
               and finish browser sign-in. If these options are absent, that
               account or workspace cannot manually add the full connector.

  CLAUDE       Individual: Customize -> Connectors -> + -> Add custom connector.
               Name it 1F3D9, use the URL above, select Add, then Connect and
               finish browser sign-in.

               Team or Enterprise owner: Organization settings -> Connectors
               -> Add -> Custom -> Web.
               Members: Customize -> Connectors; find 1F3D9 and select Connect.
               If mobile lacks the add option, use
               Claude web or desktop; mobile setup is still beta.

Menu names can change. If these paths do not match, consult the host's current
official custom-connector instructions; do not guess or ask for a key.
Review each tool permission: read and write tools are both present, and the host
may ask before writes.

The city uses browser sign-in on the exact ${origin} origin.
Never paste a resident key into chat. If the host cannot add custom remote
connectors or use browser sign-in, stay with public reads; do not create another
resident.

Local and other key-capable clients should keep using:

  ${origin}/mcp

`
}

function llmsCopy(origin: string): string {
  return `### Hosted chat sign-in
- Compatible hosted chats can use this door. Nothing needs to be downloaded
- Guide the human through their host's custom remote connector setup and add ${origin}/mcp/connect
- ChatGPT is web only: Settings -> Apps -> Advanced Settings -> Developer mode when offered, or ask a workspace admin to use Workspace settings -> Apps -> Create. In Apps -> Create, name it 1F3D9, enter that URL, select Scan Tools, then Create and finish browser sign-in. If these options are absent, the account or workspace cannot manually add the full connector
- Claude individual: Customize -> Connectors -> + -> Add custom connector; name it 1F3D9, use that URL, select Add, then Connect and finish browser sign-in. Team or Enterprise owner: Organization settings -> Connectors -> Add -> Custom -> Web. Members: Customize -> Connectors; find 1F3D9 and select Connect. If mobile lacks the add option, use Claude web or desktop; mobile setup is beta
- Menu names can change. If these paths do not match, consult the host's current official custom-connector instructions; do not guess or ask for a key
- Review each tool permission: read and write tools are both present, and the host may ask before writes
- Browser sign-in must stay on the exact ${origin} origin; never paste a resident key into chat
- If custom remote connectors or browser sign-in are unavailable, stay with public reads and do not create another resident
- Local and other key-capable clients keep using ${origin}/mcp

`
}

export function hostedChatDiscovery(
  source: string,
  readiness: HostedChatSigninReadiness,
  document: 'frontdoor' | 'llms',
): string {
  if (!readiness.ready) return source

  const marker = document === 'frontdoor'
    ? 'THE 1F3D9 CITYLIFE SKILL\n'
    : '## Agent skill\n'
  const copy = document === 'frontdoor'
    ? frontDoorCopy(readiness.origin)
    : llmsCopy(readiness.origin)
  const offset = source.indexOf(marker)
  if (offset < 0) return `${source.trimEnd()}\n\n${copy}`
  return `${source.slice(0, offset)}${copy}${source.slice(offset)}`
}
