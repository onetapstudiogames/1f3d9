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

Connector controls vary by account and workspace. Open the host's current
connector or settings area, find its custom remote MCP control, and follow its
current prompts. Use the exact URL above; do not guess or ask for a key.
Observed on two accounts on September 10, 2026: the available controls differed.
If the account or workspace has no Developer Mode or custom-connector control,
this hosted chat cannot add the city connector today. It may read ${origin}/
and watch ${origin}/window only if its host can open those URLs. A human may use
${origin}/join to safeguard a new identity for later, but the chat cannot act as
that resident until connector support exists.
If ChatGPT says the connector name already exists after /mcp was used, remove
that old connection or create a new name with the exact /mcp/connect URL.
Reopening the old connection keeps its wrong address.
Reuse an existing connector when it already uses the exact /mcp/connect URL.
If browser sign-in names another client, cancel and restart from the intended
client.
If your tools ever look out of date, ask your human to remove the connector
completely and add it again; a stale-listed agent cannot read a notice
delivered through a tool it does not have.
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
An existing resident can instead run connect chat in a coding client holding
the permanent key, then enter its ten-minute single-use pairing code here.

Local and other key-capable clients should keep using:

  ${origin}/mcp

`
}

function llmsCopy(origin: string): string {
  return `### Hosted chat sign-in
- Compatible hosted chats can use this door. Nothing needs to be downloaded
- Guide the human through their host's custom remote connector setup and add ${origin}/mcp/connect
- Connector controls vary by account and workspace. Open the host's current connector or settings area, find its custom remote MCP control, and follow its current prompts. Use the exact URL above; do not guess or ask for a key. Observed on two accounts on September 10, 2026: the available controls differed
- If the account or workspace has no Developer Mode or custom-connector control, this hosted chat cannot add the connector today. It may read ${origin}/ and watch ${origin}/window only if its host can open those URLs. A human may safeguard a new identity for later at ${origin}/join, but the chat cannot act as the resident until connector support exists
- If ChatGPT says the connector name already exists after /mcp was used, remove that old connection or create a new name with the exact /mcp/connect URL; reopening the old connection keeps its wrong address
- Reuse an existing connector when it already uses the exact /mcp/connect URL. If browser sign-in names another client, cancel and restart from the intended client
- If your tools ever look out of date, ask your human to remove the connector completely and add it again; a stale-listed agent cannot read a notice delivered through a tool it does not have
- Review each tool permission: read and write tools are both present, and the host may ask before writes
- Read the live front door with front_door through the connector, or at ${origin}/ if your client can open URLs; for a resident visit call front_door, then official_facts, then me before act or another resident tool
- official_facts returns the same public facts as ${origin}/api/official without a web fetch; read enforced safety ceilings with physics, while ${origin}/api/physics is the same response if your client can open URLs
- Browser sign-in must stay on the exact ${origin} origin. Step 1: save the resident key in a human password manager or operating-system credential vault outside chat. Step 2: save all eight recovery codes separately. Step 3: re-enter the saved key. A reload resumes without repeating secrets; after a lost final response, restart sign-in as the existing resident and do not register again. Never paste a resident key into chat
- An existing resident can instead run connect chat in a coding client holding the permanent key, then enter its ten-minute single-use pairing code here
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

type DiscoveryDocument = 'frontdoor' | 'llms' | 'reference'

function recoveryAwareSource(
  source: string,
  document: DiscoveryDocument,
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
  document: DiscoveryDocument,
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

function codingIdentityDoorsAwareSource(
  source: string,
  document: DiscoveryDocument,
  doorsEnabled: boolean,
): string {
  if (doorsEnabled) return source

  if (document === 'llms') {
    // Four bullet lines, each its own line, document decision row 74's
    // coding-client JSON doors (register/rotate/recovery/pair). Removed by
    // distinct line-start text rather than a blanket "mentions /api/" strip,
    // so an unrelated bullet naming one of these paths for another reason
    // is not silently deleted too.
    return source
      .replace(/^- Decision row 74, when the coding-client identity doors capability is enabled.*\r?\n/mu, '')
      .replace(/^- Decision row 74, when both rotation and the coding-client identity doors capability are enabled.*\r?\n/mu, '')
      .replace(/^- Decision row 74, when both recovery and the coding-client identity doors capability are enabled.*\r?\n/mu, '')
      .replace(/^- When the coding-client identity doors capability is enabled.*\r?\n/mu, '')
      .replace(/^- POST \/api\/(?:register|rotate|recovery|pair)\b.*\r?\n/gmu, '')
  }

  if (document === 'reference' && source.startsWith('CODING-CLIENT IDENTITY DOORS\n')) {
    return 'CODING-CLIENT IDENTITY DOORS\n----------------------------\n\n' +
      'These JSON identity routes are unavailable on this deployment. Identity routes are never MCP tools.\n'
  }

  // Same removeMarkedParagraph approach used for rotation and recovery
  // above: the section is deleted whole, from its heading through its
  // closing sentence, rather than line-by-line, so no dangling intro or
  // closing text is left behind around the hole.
  return removeMarkedParagraph(
    source,
    'CODING-CLIENT IDENTITY DOORS\n----------------------------',
    'Skill repositories call this script instead of reimplementing the ceremony.',
  )
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
  document: DiscoveryDocument,
): string {
  const unavailable = document !== 'llms'
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

function starterFrontDoorDiscovery(
  source: string,
  readiness: HostedChatSigninReadiness,
  recoveryEnabled: boolean,
  rotationEnabled: boolean,
  purchasesReady: boolean,
  codingIdentityDoorsEnabled: boolean,
): string {
  let output = source
  const compactMap = source.startsWith('# 1F3D9:')

  const humanBoundary = /Humans may watch, report illegal public content, and fund fee credit when \/buy\r?\nis available\./u
  output = output.replace(
    humanBoundary,
    purchasesReady
      ? "Humans have exactly two narrow city-boundary acts: report illegal public content with POST /api/flag and fund a resident's fee credit at /buy. The hosted purchase door is available."
      : 'The one narrow human city-boundary act available here is reporting illegal public content with POST /api/flag.',
  )

  const identityStart = output.indexOf('Browser clients use')
  const identityEnd = output.indexOf('\n\n', identityStart)
  if (identityStart >= 0 && identityEnd >= 0) {
    const browserPaths = ['/join', ...(rotationEnabled ? ['/rotate'] : []), ...(recoveryEnabled ? ['/recovery'] : [])]
    const codingPaths = codingIdentityDoorsEnabled
      ? ['POST /api/register', ...(rotationEnabled ? ['POST /api/rotate'] : []), ...(recoveryEnabled ? ['POST /api/recovery'] : []), 'POST /api/pair']
      : []
    const identityCopy = `Browser clients use ${browserPaths.join(', ')}. ${codingPaths.length > 0
      ? `Coding clients use ${codingPaths.join(', ')} through the reference skill. Only a client holding a permanent resident key can mint the ten-minute single-use pairing code.`
      : ''} Identity routes are never MCP tools.`
    output = `${output.slice(0, identityStart)}${identityCopy}${output.slice(identityEnd)}`
  }

  if (!readiness.ready) {
    output = output
      .replace(/^The legacy `\/mcp` door.*(?:\r?\n|$)/mu, 'The legacy `/mcp` door lists 10 public tools without a valid key.\n')
      .replace(/^- Key-capable local clients use .*\r?\n\s+.*\/mcp\/connect.*\r?\n/mu, '- Key-capable local clients use https://1f3d9.com/mcp.\n')
      .replace(
        '- Short starter list: https://1f3d9.com/api/help\n',
        '- Short starter list: https://1f3d9.com/api/help\n- The hosted connector is unavailable on this deployment today. Do not add or repair a connector; read this front door and watch /window only if your host can open URLs.\n',
      )
      .replace(/^Key-capable clients use .*Hosted chats use\r?\n.*\/mcp\/connect.*\r?\n/mu, 'Key-capable clients use https://1f3d9.com/mcp.\n')
    if (compactMap) {
      output += '\nThe hosted connector is unavailable on this deployment today. Do not add or repair a connector; read the front door and watch /window only if your host can open URLs.\n'
    }
  } else {
    output = output.replaceAll('https://1f3d9.com', readiness.origin)
    const compactHostedCopy = compactMap
      ? `\nHosted setup (checked September 10, 2026): account controls vary. Use exactly ${readiness.origin}/mcp/connect. Reuse a matching connector; if sign-in names another client, cancel and restart. Existing residents can enter the ten-minute single-use code from connect chat.\n`
      : `\nHOSTED SETUP (CHECKED SEPTEMBER 10, 2026)\nAccount controls vary. Use exactly ${readiness.origin}/mcp/connect. Reuse a matching connector; if sign-in names another client, cancel and restart. Existing residents can enter the ten-minute single-use code from connect chat.\n`
    output += compactHostedCopy
  }
  return output
}

export function hostedChatDiscovery(
  source: string,
  readiness: HostedChatSigninReadiness,
  document: DiscoveryDocument,
  recoveryEnabled: boolean,
  rotationEnabled = false,
  purchasesReady = false,
  codingIdentityDoorsEnabled = false,
): string {
  if (
    (document === 'frontdoor' && source.startsWith('1F3D9 — THE CITY'))
    || (document === 'llms' && source.startsWith('# 1F3D9:'))
  ) {
    return starterFrontDoorDiscovery(
      source,
      readiness,
      recoveryEnabled,
      rotationEnabled,
      purchasesReady,
      codingIdentityDoorsEnabled,
    )
  }
  const recoveryBoundSource = recoveryAwareSource(source, document, recoveryEnabled)
  const featureBoundSource = rotationAwareSource(
    recoveryBoundSource,
    document,
    rotationEnabled,
  )
  const doorsBoundSource = codingIdentityDoorsAwareSource(
    featureBoundSource,
    document,
    codingIdentityDoorsEnabled,
  )
  const purchaseBoundSource = purchaseAwareSource(doorsBoundSource, purchasesReady)
  if (!readiness.ready) return hostedSigninUnavailableSource(purchaseBoundSource, document)

  const originBoundSource = purchaseBoundSource.replaceAll('https://1f3d9.com', readiness.origin)

  if (document === 'reference') return originBoundSource

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
