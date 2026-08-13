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
Compatible hosted chats that cannot safely keep a resident key should connect:

  ${origin}/mcp/connect

This uses the city's browser sign-in. Never paste a resident key into chat.
Local and other key-capable clients should keep using:

  ${origin}/mcp

`
}

function llmsCopy(origin: string): string {
  return `### Hosted chat sign-in
- Compatible hosted chats connect to ${origin}/mcp/connect
- This uses browser sign-in; never paste a resident key into chat
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
