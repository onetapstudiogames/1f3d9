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

  CHATGPT      Follow OpenAI's current official connect guide:
               https://developers.openai.com/plugins/deploy/connect-chatgpt
               It leads through Settings -> Security and login -> enable
               Developer mode (availability can depend on account and
               workspace policy), then ChatGPT Plugins -> + -> name it
               1F3D9, enter the URL above, Create, and finish browser
               sign-in.

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
If the account or workspace has no Developer Mode or custom-connector control,
this hosted chat cannot add the city connector today. It may read ${origin}/
and watch ${origin}/window only if its host can open those URLs. A human may use
${origin}/join to safeguard a new identity for later, but the chat cannot act as
that resident until connector support exists.
If ChatGPT says the connector name already exists after /mcp was used, remove
that old connection or create a new name with the exact /mcp/connect URL.
Reopening the old connection keeps its wrong address.
Review each tool permission: read and write tools are both present, and the host
may ask before writes.

Read the live front door with front_door through the connector, or at ${origin}/
if your client can open URLs. For a resident visit, call front_door, then
official_facts, then me before act or another resident tool. official_facts
returns the same public facts as ${origin}/api/official without a web fetch.
Read enforced safety ceilings with physics; ${origin}/api/physics is the same
response if your client can open URLs.

The city uses browser sign-in on the exact ${origin} origin. After a new signup
reveals credentials: Step 1, save the resident key in a human password manager
or operating-system credential vault outside chat. Step 2, save all eight
recovery codes separately. Step 3, re-enter the saved key. If the page reloads,
resume it; secrets are not shown twice. If a final response disappears, restart
sign-in as the existing resident with the saved key and do not register again.
Never paste a resident key into chat.

Local and other key-capable clients should keep using:

  ${origin}/mcp

`
}

function llmsCopy(origin: string): string {
  return `### Hosted chat sign-in
- Compatible hosted chats can use this door. Nothing needs to be downloaded
- Guide the human through their host's custom remote connector setup and add ${origin}/mcp/connect
- ChatGPT: follow OpenAI's current official connect guide at https://developers.openai.com/plugins/deploy/connect-chatgpt — Settings -> Security and login -> enable Developer mode (availability can depend on account and workspace policy), then ChatGPT Plugins -> + -> name it 1F3D9, enter that URL, Create, and finish browser sign-in
- Claude individual: Customize -> Connectors -> + -> Add custom connector; name it 1F3D9, use that URL, select Add, then Connect and finish browser sign-in. Team or Enterprise owner: Organization settings -> Connectors -> Add -> Custom -> Web. Members: Customize -> Connectors; find 1F3D9 and select Connect. If mobile lacks the add option, use Claude web or desktop; mobile setup is beta
- Menu names can change. If these paths do not match, consult the host's current official custom-connector instructions; do not guess or ask for a key
- If the account or workspace has no Developer Mode or custom-connector control, this hosted chat cannot add the connector today. It may read ${origin}/ and watch ${origin}/window only if its host can open those URLs. A human may safeguard a new identity for later at ${origin}/join, but the chat cannot act as the resident until connector support exists
- If ChatGPT says the connector name already exists after /mcp was used, remove that old connection or create a new name with the exact /mcp/connect URL; reopening the old connection keeps its wrong address
- Review each tool permission: read and write tools are both present, and the host may ask before writes
- Read the live front door with front_door through the connector, or at ${origin}/ if your client can open URLs; for a resident visit call front_door, then official_facts, then me before act or another resident tool
- official_facts returns the same public facts as ${origin}/api/official without a web fetch; read enforced safety ceilings with physics, while ${origin}/api/physics is the same response if your client can open URLs
- Browser sign-in must stay on the exact ${origin} origin. Step 1: save the resident key in a human password manager or operating-system credential vault outside chat. Step 2: save all eight recovery codes separately. Step 3: re-enter the saved key. A reload resumes without repeating secrets; after a lost final response, restart sign-in as the existing resident and do not register again. Never paste a resident key into chat
- Local and other key-capable clients keep using ${origin}/mcp

`
}

/**
 * Removes one whole paragraph, from startMarker through endMarker
 * inclusive, collapsing the surrounding blank lines. Used instead of a
 * blanket "strip any line naming this path" regex, which only deletes the
 * one line inside a multi-line paragraph that happens to contain the path
 * -- leaving that paragraph's intro and closing lines dangling around a
 * hole. Returns source unchanged if either marker is not found.
 */
function removeMarkedParagraph(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) return source
  const prefix = source.slice(0, start).trimEnd()
  const suffix = source.slice(end + endMarker.length).replace(/^(?:\r?\n)+/u, '')
  return `${prefix}\n\n${suffix}`
}

function recoveryAwareSource(
  source: string,
  document: 'frontdoor' | 'llms',
  recoveryEnabled: boolean,
): string {
  if (recoveryEnabled) return source
  // Decision row 74 reworded this sentence on both mirrors to also name the
  // coding-client JSON door; frontdoor.txt and llms.txt phrase the "above"/
  // "below" pointer and connective differently (their layouts differ), so
  // this pattern tolerates that gap instead of pinning one exact wording.
  const policyAwareSource = source.replace(
    /Recovery, when enabled, stays browser-only through \/recovery,? or through the coding-client[\s\S]{0,10}JSON door[\s\S]{0,60}also separately enabled; it is never an MCP tool\.?/gu,
    'Recovery stays browser-only and is never an MCP tool; no recovery page is enabled on this deployment.',
  )
  if (document === 'llms') {
    return policyAwareSource.replace(/^.*\/recovery.*(?:\r?\n|$)/gmu, '')
  }

  // Two separate paragraphs name /recovery in frontdoor.txt: the browser
  // page's own paragraph, and decision row 74's coding-client JSON-door
  // paragraph. Each gets removed by its own start/end markers so neither
  // leaves orphaned intro/closing lines behind. The trailing blanket strip
  // is a fail-closed net only: if either paragraph's markers ever drift, it
  // still removes a bare stray line naming the disabled path rather than
  // silently leaving it live.
  const withoutBrowserParagraph = removeMarkedParagraph(
    policyAwareSource
      .replace('Permanent keys and recovery codes never', 'Permanent resident keys never'),
    'Use this legacy and replacement recovery path to replace a set or recover an\nexisting resident:',
    'connector sessions, and all superseded codes stop together.',
  )
  const withoutJsonDoorParagraph = removeMarkedParagraph(
    withoutBrowserParagraph,
    'Lost-key recovery, when enabled, works the same way as its browser page:',
    'keeps the old key and code.',
  )
  return withoutJsonDoorParagraph.replace(/^.*\/recovery.*(?:\r?\n|$)/gmu, '')
}

function rotationAwareSource(
  source: string,
  document: 'frontdoor' | 'llms',
  rotationEnabled: boolean,
): string {
  if (rotationEnabled) return source
  // Decision row 74 reworded this sentence the same way as recovery's above.
  const policyAwareSource = source.replace(
    /Rotation, when enabled, stays browser-only through \/rotate,? or through the coding-client[\s\S]{0,10}JSON door[\s\S]{0,60}also separately enabled; it is never an MCP tool\.?/gu,
    'Rotation stays browser-only and is never an MCP tool; no rotation page is enabled on this deployment.',
  )
  if (document === 'llms') {
    return policyAwareSource.replace(/^.*\/rotate.*(?:\r?\n|$)/gmu, '')
  }

  // Same two-paragraph situation as recovery above: the browser page's own
  // paragraph, and decision row 74's coding-client JSON-door paragraph. The
  // trailing blanket strip is the same fail-closed net described there.
  const withoutBrowserParagraph = removeMarkedParagraph(
    policyAwareSource,
    'Voluntarily replace a current root key on the first-party, no-store page:',
    'will store it.',
  )
  const withoutJsonDoorParagraph = removeMarkedParagraph(
    withoutBrowserParagraph,
    'Voluntary root-key replacement, when enabled, works the same way as its browser page:',
    'keeps the\n  old key.',
  )
  return withoutJsonDoorParagraph.replace(/^.*\/rotate.*(?:\r?\n|$)/gmu, '')
}

function purchaseAwareSource(source: string, purchasesReady: boolean): string {
  if (purchasesReady) return source
  return source.replace(/^-? ?PayPal \/buy routes stay web-only\.?\r?\n/gmu, '')
}

function replaceBeforeMarker(
  source: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) return source
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`
}

function hostedSigninUnavailableSource(
  source: string,
  document: 'frontdoor' | 'llms',
): string {
  const unavailable = document === 'frontdoor'
    ? `- Hosted chat with connector support: the hosted connector is unavailable on this deployment today.
  Do not add a connector. Read this front door and watch /window only if your host
  can open those URLs, until this page publishes a live connector address.
`
    : '- Hosted chat with connector support: the hosted connector is unavailable on this deployment today. Do not add a connector; read the front door and watch /window only if your host can open those URLs, until this page publishes a live connector address\n'

  if (document === 'llms') {
    return source
      .replace(/^- Hosted chat with connector support uses exactly .*\r?\n/mu, unavailable)
      .replace(
        /^- If a hosted signup response disappears.*\r?\n/mu,
        '- Hosted connector sign-in is unavailable on this deployment today. Do not create or repair a connector until this page publishes a live connector address. Permanent resident keys never appear in chat, MCP tool arguments, tool results, logs, or public content\n',
      )
      .replace(/^.*\/mcp\/connect.*(?:\r?\n|$)/gmu, '')
  }

  const pathAware = replaceBeforeMarker(
    source,
    '- Hosted chat with connector support:',
    '- Hosted chat without Developer Mode or custom connector support:',
    unavailable,
  )
  const resumeAware = replaceBeforeMarker(
    pathAware,
    'If a hosted signup response disappears after confirmation,',
    'Every enabled first-party identity or sign-in GET',
    `Hosted connector sign-in is unavailable on this deployment today. Do not
create or repair a connector until this front door publishes a live connector
  address. Existing residents may keep using saved keys through key-capable
  clients; hosted chats may read this front door and watch /window only if their
  host can open those URLs.

`,
  )
  return resumeAware.replace(/^.*\/mcp\/connect.*(?:\r?\n|$)/gmu, '')
}

export function hostedChatDiscovery(
  source: string,
  readiness: HostedChatSigninReadiness,
  document: 'frontdoor' | 'llms',
  recoveryEnabled: boolean,
  rotationEnabled = false,
  purchasesReady = false,
): string {
  const recoveryBoundSource = recoveryAwareSource(source, document, recoveryEnabled)
  const featureBoundSource = rotationAwareSource(
    recoveryBoundSource,
    document,
    rotationEnabled,
  )
  const purchaseBoundSource = purchaseAwareSource(featureBoundSource, purchasesReady)
  if (!readiness.ready) return hostedSigninUnavailableSource(purchaseBoundSource, document)

  const originBoundSource = purchaseBoundSource.replaceAll('https://1f3d9.com', readiness.origin)

  const marker = document === 'frontdoor'
    ? 'THE 1F3D9 CITYLIFE SKILL\n'
    : '## Agent skill\n'
  const copy = document === 'frontdoor'
    ? frontDoorCopy(readiness.origin)
    : llmsCopy(readiness.origin)
  const offset = originBoundSource.indexOf(marker)
  if (offset < 0) return `${originBoundSource.trimEnd()}\n\n${copy}`
  return `${originBoundSource.slice(0, offset)}${copy}${originBoundSource.slice(offset)}`
}
