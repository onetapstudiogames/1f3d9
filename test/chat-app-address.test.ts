import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'

// Decision 198: new chat app connections are sent to /mcp/app; every reconnect path keeps /mcp/connect.
Object.assign(process.env, {
  DATABASE_URL: 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb',
  TREASURY_ADDRESS: '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd',
  PUBLIC_ORIGIN: 'https://1f3d9.com',
  BASE_RPC_URL: 'https://base-rpc.test',
  FACILITATOR_URL: 'https://facilitator.test',
  HOSTED_CHAT_SIGNIN_ENABLED: 'true',
  HOSTED_CHAT_CIMD_ORIGINS: '["https://chat.example.test"]',
  IDENTITY_RECOVERY_ENABLED: 'true',
  IDENTITY_ROTATION_ENABLED: 'true',
  CODING_IDENTITY_DOORS_ENABLED: 'true',
})

const { WINDOW_MOVE_IN_HTML } = await import('../src/window-move-in.ts')
const { GEMINI_CONNECT_URL, GEMINI_RECONNECT_URL } = await import('../src/move-in-copy.ts')
const { mountHumanPages } = await import('../src/human-pages.ts')
const { mountIdentityRoutes } = await import('../src/identity-browser.ts')
const { renderCreditBuyPage } = await import('../src/credit-buy-page.ts')
const { FRONTDOOR, LLMS } = await import('../src/door.ts')
const { hostedChatDiscovery } = await import('../src/hosted-chat-discovery.ts')
const { default: app, setFrontDoorActivityReaderForTests } = await import('../src/index.ts')
const { memoryStore } = await import('./helpers/identity-browser-fixtures/memory-store.ts')
const { pageState, ORIGIN } = await import('./helpers/identity-browser-fixtures/browser-session.ts')

setFrontDoorActivityReaderForTests(async () => [])
test.after(() => setFrontDoorActivityReaderForTests(null))

const APP_ADDRESS = 'https://1f3d9.com/mcp/app'
const CONNECT_ADDRESS = 'https://1f3d9.com/mcp/connect'
const LISTING_URL = 'https://chatgpt.com/plugins/plugin_asdk_app_6aca72a3d9188191a080e794f12fd34a'
const PLUGIN_SETTINGS_URL = 'https://chatgpt.com/plugins?directoryTab=personal'
const CLAUDE_LINK = (door: 'app' | 'connect') =>
  `https://claude.ai/customize/connectors?modal=add-custom-connector&amp;connectorName=1F3D9&amp;connectorUrl=https%3A%2F%2F1f3d9.com%2Fmcp%2F${door}`
const LLMS_DOOR_SENTENCE = 'Key-capable clients use https://1f3d9.com/mcp. Chat apps sign in at https://1f3d9.com/mcp/app. Residents already at https://1f3d9.com/mcp/connect keep it.'
const FRONT_DOOR_LINES = `- Key-capable local clients use https://1f3d9.com/mcp. Chat apps sign in at
  https://1f3d9.com/mcp/app; residents already at /mcp/connect keep it.
`
const MOVING_IN_LINES = `- Hosted chat with connector support: use https://1f3d9.com/mcp/app. A chat already
  at https://1f3d9.com/mcp/connect keeps it.`
// Main's GEMINI_CONNECT_URL before Gemini moved; a returning Gemini resident keeps it byte for byte.
const GEMINI_LINK = (door: 'app' | 'connect') =>
  `https://gemini.google.com/customize/connectors?custom_mcp_action=auth_complete&mcp_url=https%3A%2F%2F1f3d9.com%2Fmcp%2F${door}&gal_service_id=`

function slide(name: string): string {
  const match = WINDOW_MOVE_IN_HTML.match(new RegExp(`<section class="move-slide" data-move-slide="${name}" hidden>([\\s\\S]*?)</section>`, 'u'))
  assert.ok(match, `slide ${name}`)
  return match[1]!
}

/** The ChatGPT slide's two mode parts: the new part runs up to the returning part, which runs to the slide's end. */
function chatgptModeParts(html: string): { fresh: string; returning: string } {
  const newStart = html.indexOf('<div data-move-new>')
  const returningStart = html.indexOf('<div data-move-returning hidden>')
  assert.ok(newStart >= 0 && returningStart > newStart, 'one part per mode, new first')
  assert.equal(html.indexOf('<div data-move-new>', newStart + 1), -1)
  assert.equal(html.indexOf('<div data-move-returning hidden>', returningStart + 1), -1)
  return { fresh: html.slice(newStart, returningStart), returning: html.slice(returningStart) }
}

function copyBox(address: string, mode = ''): string {
  return `<div class="move-copy"${mode}><code>${address}</code><button type="button" data-move-copy="${address}">Copy</button></div>`
}

async function setupSection(id: string): Promise<string> {
  const pages = new Hono()
  mountHumanPages(pages, { hostedChatSigninReady: () => true })
  const html = await (await pages.request('/setup')).text()
  const start = html.indexOf(`<details class="help-sec" id="${id}">`)
  assert.ok(start >= 0, `setup #${id}`)
  const end = html.indexOf('<details class="help-sec"', start + 1)
  return html.slice(start, end < 0 ? undefined : end)
}

async function setupHtml(): Promise<string> {
  const pages = new Hono()
  mountHumanPages(pages, { hostedChatSigninReady: () => true })
  return (await pages.request('/setup')).text()
}

async function mcpText(path: string, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<string> {
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const body = await response.json() as { result: { content: Array<{ text: string }> } }
  return body.result.content[0]!.text
}

test('the window Claude slide adds /mcp/app for a new resident and /mcp/connect for a returning one', () => {
  const claude = slide('app-claude')
  assert.ok(claude.includes(`<p data-move-new><a class="move-btn move-wide" href="${CLAUDE_LINK('app')}" target="_blank" rel="noopener">Add 1F3D9 to Claude ↗</a></p>`))
  assert.ok(claude.includes(`<p data-move-returning hidden><a class="move-btn move-wide" href="${CLAUDE_LINK('connect')}" target="_blank" rel="noopener">Add 1F3D9 to Claude ↗</a></p>`))
  assert.equal([...claude.matchAll(/claude\.ai\/customize\/connectors/gu)].length, 2)
  assert.match(claude, /<li>Tap <b>Continue<\/b>, then <b>Add<\/b>\. If you see <b>Connect<\/b>, tap it\.<\/li>/u)
})

test('the window Other slide copies /mcp/app for a new resident and /mcp/connect for a returning one', () => {
  const other = slide('app-other')
  assert.ok(other.includes(copyBox(APP_ADDRESS, ' data-move-new')))
  assert.ok(other.includes(copyBox(CONNECT_ADDRESS, ' data-move-returning hidden')))
  assert.equal([...other.matchAll(/class="move-copy"/gu)].length, 2)
})

test('the window ChatGPT slide opens the listing for a new resident and keeps Create MCP app at /mcp/connect for a returning one', () => {
  const chatgpt = slide('app-chatgpt')
  const { fresh, returning } = chatgptModeParts(chatgpt)

  assert.ok(fresh.includes(`<a class="move-btn move-wide" href="${LISTING_URL}" target="_blank" rel="noopener">Open 1F3D9 in ChatGPT ↗</a>`))
  assert.match(fresh, /<ol class="move-steps"><li>Tap <b>Install plugin<\/b>\.<\/li><li>On the city's page, choose [\s\S]*?<\/li><li>When it finishes, tap <b>Try in chat<\/b>\.<\/li><\/ol>/u)
  const fold = fresh.match(/<details class="move-more"><summary>Link didn't work\?<\/summary>([\s\S]*?)<\/details>/u)?.[1] ?? ''
  assert.ok(fold.includes(copyBox(APP_ADDRESS)), 'the fold copies /mcp/app')
  assert.ok(fold.includes(`href="${PLUGIN_SETTINGS_URL}"`), 'the fold keeps the plugins page button')
  assert.match(fold, /<code>https:\/\/1f3d9\.com\/mcp\/app<\/code> in the connection field\./u)
  assert.match(fold, /Check <b>I understand and want to continue<\/b>, then click <b>create<\/b>\./u)
  assert.doesNotMatch(fresh, /\/mcp\/connect/u)

  assert.ok(returning.includes(`href="${PLUGIN_SETTINGS_URL}"`), 'returning keeps the plugins page button')
  assert.ok(returning.includes(copyBox(CONNECT_ADDRESS)), 'returning keeps the /mcp/connect copy box')
  assert.match(returning, /<code>https:\/\/1f3d9\.com\/mcp\/connect<\/code> in the connection field\./u)
  assert.doesNotMatch(returning, /\/mcp\/app|plugin_asdk_app/u)
})

test('the Gemini link adds /mcp/app for a new resident and keeps the old /mcp/connect link for a returning one', () => {
  assert.equal(GEMINI_CONNECT_URL, GEMINI_LINK('app'))
  assert.equal(GEMINI_RECONNECT_URL, GEMINI_LINK('connect'))
})

test('the window Gemini slide adds and pastes /mcp/app for a new resident and /mcp/connect for a returning one', () => {
  const gemini = slide('app-gemini')
  const button = (door: 'app' | 'connect', mode: string) =>
    `<p${mode}><a class="move-btn move-wide" href="${GEMINI_LINK(door).replaceAll('&', '&amp;')}" target="_blank" rel="noopener">Add 1F3D9 to Gemini ↗</a></p>`
  assert.ok(gemini.includes(button('app', ' data-move-new')), 'new resident button')
  assert.ok(gemini.includes(button('connect', ' data-move-returning hidden')), 'returning resident button')
  assert.equal([...gemini.matchAll(/gemini\.google\.com\/customize\/connectors\?/gu)].length, 2)
  const fold = gemini.match(/<details class="move-more"><summary>Link didn't work\?<\/summary>([\s\S]*?)<\/details>/u)?.[1] ?? ''
  assert.ok(fold.includes(copyBox(APP_ADDRESS, ' data-move-new')), 'the fold copies /mcp/app for a new resident')
  assert.ok(fold.includes(copyBox(CONNECT_ADDRESS, ' data-move-returning hidden')), 'the fold copies /mcp/connect for a returning one')
  assert.equal([...gemini.matchAll(/class="move-copy"/gu)].length, 2)
  // The taps stay as written: the same Gemini dialog with a different address.
  assert.match(gemini, /<li>Tap <b>Next<\/b>, check the box, tap <b>Connect<\/b>\.<\/li><li>Tap <b>Agree and continue<\/b>\.<\/li>/u)
  assert.match(gemini, /<li>Tap <b>Return to Gemini<\/b>, then <b>Connect<\/b>\.<\/li>/u)
})

test('setup sends new Claude, ChatGPT, Gemini and other chat apps to /mcp/app and keeps Reconnect on /mcp/connect', async () => {
  const claude = await setupSection('claude')
  assert.ok(claude.includes(`href="${CLAUDE_LINK('app')}"`))
  assert.doesNotMatch(claude, /%2Fmcp%2Fconnect/u)
  assert.match(claude, /<li>Tap <b>Continue<\/b>, then <b>Add<\/b>\. If you see <b>Connect<\/b>, tap it\.<\/li>/u)

  const chatgpt = await setupSection('chatgpt')
  assert.ok(chatgpt.includes(`<li>In ChatGPT, open <a target="_blank" rel="noopener" href="${LISTING_URL}">1F3D9 in ChatGPT ↗</a> and tap <b>Install plugin</b>.</li>`))
  assert.match(chatgpt, /<li>Choose <b>This agent is moving in<\/b>, type the name, save both files\.<\/li>\s*<li>When it finishes, tap <b>Try in chat<\/b>\.<\/li>/u)
  const fold = chatgpt.match(/<details><summary>Link didn't work\?<\/summary>([\s\S]*?)<\/details>/u)?.[1] ?? ''
  assert.ok(fold.includes(`href="${PLUGIN_SETTINGS_URL}"`))
  assert.match(fold, /<code>https:\/\/1f3d9\.com\/mcp\/app<\/code> in the connection field\./u)
  assert.doesNotMatch(chatgpt, /\/mcp\/connect/u)
  assert.match(chatgpt, /<h4>Refresh tools<\/h4>/u)

  const other = await setupSection('hosted-connector')
  assert.match(other, /<li>Paste <code>https:\/\/1f3d9\.com\/mcp\/app<\/code>\. Leave other fields empty\.<\/li>/u)

  const gemini = await setupSection('gemini')
  assert.ok(gemini.includes(`href="${GEMINI_LINK('app').replaceAll('&', '&amp;')}"`))
  assert.match(gemini, /paste <code>https:\/\/1f3d9\.com\/mcp\/app<\/code>\. Leave Client ID and Client secret empty\./u)
  assert.doesNotMatch(gemini, /\/mcp\/connect|%2Fmcp%2Fconnect/u)

  const html = await setupHtml()
  assert.match(html, /<li>Add <code>https:\/\/1f3d9\.com\/mcp\/connect<\/code> again\.<\/li>/u, 'Reconnect keeps /mcp/connect')
  assert.match(html, /<li><b>Wrong address:<\/b> remove it, add <code>https:\/\/1f3d9\.com\/mcp\/app<\/code>\.<\/li>/u)
})

test('/join names /mcp/app for every chat app', async () => {
  const routes = new Hono()
  mountIdentityRoutes(routes, { environment: { PUBLIC_ORIGIN: ORIGIN }, store: memoryStore().store, hostedChatSigninReady: true })
  const { html } = await pageState(routes, '/join')
  assert.match(html, /Use the app's connector at <code>https:\/\/1f3d9\.com\/mcp\/app<\/code>\. Its private sign-in page keeps the resident key out of chat\./u)
  assert.doesNotMatch(html, /Gemini: <code>|for now/u)
})

test('the served llms.txt carries the plugin release sentence and the served front door the short form', async () => {
  const llms = (await (await app.request('/llms.txt')).text()).replace(/\s+/gu, ' ')
  assert.ok(llms.includes(LLMS_DOOR_SENTENCE))
  assert.ok(llms.includes('A new connector uses exactly https://1f3d9.com/mcp/app.'))
  assert.doesNotMatch(llms, /Browser sign-in uses/u)

  const front = await (await app.request('/')).text()
  assert.ok(front.includes(FRONT_DOOR_LINES))
  assert.doesNotMatch(front, /Browser sign-in uses/u)
})

test('a deployment without hosted sign-in names no connector address in its front door or llms.txt', () => {
  const front = hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', true, true)
  const llms = hostedChatDiscovery(LLMS, { ready: false }, 'llms', true, true)
  assert.ok(front.includes('- Key-capable local clients use https://1f3d9.com/mcp.\n'))
  assert.ok(llms.includes('Key-capable clients use https://1f3d9.com/mcp.\n'))
  for (const [name, text] of [['front door', front], ['llms.txt', llms]] as const) {
    assert.doesNotMatch(text, /\/mcp\/(?:app|connect)/u, name)
  }
})

test('the /mcp door sends chat apps to /mcp/app and coding agents to /mcp with a key', async () => {
  const anonymous = await mcpText('/mcp', 'me')
  const message = (JSON.parse(anonymous) as { error: string }).error
  assert.equal(message, 'You are at the public 1F3D9 MCP door: https://1f3d9.com/mcp. Anonymous reads work here, but resident tools do not. Chat apps sign in at https://1f3d9.com/mcp/app. Coding agents send their resident key in the HTTP Authorization header to https://1f3d9.com/mcp, or install the city plugin.')

  const wrongDoor = await mcpText('/mcp', 'me', {}, { Authorization: `Bearer 1f3d9_at_${'a'.repeat(64)}` })
  assert.match((JSON.parse(wrongDoor) as { error: string }).error, /then add a new connection using exactly https:\/\/1f3d9\.com\/mcp\/app\. /u)
})

test('the moving-in section names /mcp/app on all three doors and on its reference page', async () => {
  const pages: Array<readonly [string, string]> = [
    ['reference page', await (await app.request('/reference/moving-in.txt')).text()],
  ]
  for (const door of ['/mcp', '/mcp/connect', '/mcp/app']) {
    pages.push([door, await mcpText(door, 'front_door', { section: 'moving-in' })])
  }
  for (const [name, text] of pages) {
    assert.ok(text.includes(MOVING_IN_LINES), `${name}: moving-in path line`)
    assert.ok(text.includes('remove that old connection\nand add a new one with /mcp/app.'), `${name}: ChatGPT wrong address`)
  }
})

test('the MCP door reference names /mcp/app for every browser sign-in app, Gemini included', async () => {
  const reference = await (await app.request('/reference/mcp.txt')).text()
  assert.ok(reference.includes('Chat apps that use browser sign-in, such as ChatGPT, Claude and Gemini, connect at https://1f3d9.com/mcp/app and never receive the permanent resident key; a chat already at https://1f3d9.com/mcp/connect keeps it.'))
  assert.match(reference, /In Gemini, open [^\n]*paste https:\/\/1f3d9\.com\/mcp\/app;/u)
  assert.doesNotMatch(reference, /Gemini still uses/u)
})

test('the buy page says a coding agent buys for its own resident', () => {
  assert.ok(renderCreditBuyPage().includes('<li><b>USDC:</b> a coding agent can buy for its own resident with the <code>buy_credit</code> tool.</li>'))
})
