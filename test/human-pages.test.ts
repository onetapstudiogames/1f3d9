import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { CITY_HELP_DOORS } from '../src/city-help.ts'

process.env.DATABASE_URL = ''
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'false'
process.env.IDENTITY_RECOVERY_ENABLED = 'false'
process.env.IDENTITY_ROTATION_ENABLED = 'false'

const { default: app } = await import('../src/index.ts')
// These checks describe the plain pages; season days are covered in test/season-pages.test.ts.
const { setSeasonClockForTests } = await import('../src/season/clock.ts')
setSeasonClockForTests(() => Date.parse('2026-07-08T12:00:00Z'))
const { FRONTDOOR } = await import('../src/door.ts')
const { hostedChatDiscovery } = await import('../src/hosted-chat-discovery.ts')
const { mountHumanPages } = await import('../src/human-pages.ts')
const {
  COMMUNITY_TOOLS,
  renderCommunityToolEntry,
  renderCommunityToolLink,
} = await import('../src/community-tools.ts')

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function visibleText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(?:amp|#38);/giu, '&')
    .replace(/&(?:apos|#39|#x27);/giu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
}

function section(html: string, id: string): string {
  const match = html.match(new RegExp(`<section[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/section>`, 'iu'))
  assert.ok(match, `missing #${id}`)
  return match[1]!
}

function assertIndexablePage(
  response: Response,
  html: string,
    path: '/about' | '/setup' | '/tools' | '/market',
): void {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/iu)
  assert.equal(response.headers.get('x-robots-tag'), 'index, follow')
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u)
  if (path === '/tools') {
    assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'self'/u)
    assert.match(response.headers.get('content-security-policy') ?? '', /form-action 'self'/u)
  } else {
    assert.match(response.headers.get('content-security-policy') ?? '', path === '/setup' ? /script-src 'self'/u : /script-src 'none'/u)
  }
  assert.match(html, /^<!doctype html>/iu)
  assert.match(html, /<meta name="robots" content="index, follow">/iu)
  assert.doesNotMatch(html, /\b(?:noindex|nofollow|noarchive)\b/iu)
  assert.match(html, /<meta name="description" content="[^"]{40,}">/iu)
  assert.match(html, new RegExp(`<link rel="canonical" href="https:\\/\\/1f3d9\\.com${path}">`, 'iu'))
  assert.match(html, /<meta property="og:title" content="[^"]+">/iu)
  assert.match(html, /<meta property="og:description" content="[^"]{40,}">/iu)
  assert.match(html, /<meta property="og:type" content="website">/iu)
  assert.match(html, new RegExp(`<meta property="og:url" content="https:\\/\\/1f3d9\\.com${path}">`, 'iu'))
  assert.match(html, /<meta property="og:image" content="https:\/\/1f3d9\.com\/og-image\.png">/iu)
  assert.match(html, /<meta property="og:image:alt" content="[^"]+">/iu)
  assert.match(html, /href="\/favicon\.svg"/iu)
  assert.match(html, /href="\/favicon-32x32\.png"/iu)
  assert.match(html, /href="\/apple-touch-icon\.png"/iu)
  assert.match(html, /href="\/guide\.css"/iu)
  assert.match(html, /Run by TWAMD LLC · <a href="mailto:adam@twamd\.com">adam@twamd\.com<\/a>/iu)
  assert.doesNotMatch(html, /Gentry,\s*Arkansas/iu)
  if (path === '/tools') assert.match(html, /<script src="\/tools\.js" defer><\/script>/u)
  else if (path === '/setup') assert.match(html, /<script src="\/setup\.js" defer><\/script>/u)
  else assert.doesNotMatch(html, /<script\b/iu)
}

async function pngDimensions(path: string): Promise<readonly [number, number]> {
  const response = await app.request(path)
  assert.equal(response.status, 200, path)
  assert.equal(response.headers.get('content-type'), 'image/png', path)
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.deepEqual([...bytes.slice(0, PNG_SIGNATURE.length)], PNG_SIGNATURE, path)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return [view.getUint32(16), view.getUint32(20)]
}

async function readyHumanPage(path: '/about' | '/setup' | '/tools' | '/market' | '/help'): Promise<Response> {
  const humanPages = new Hono()
  mountHumanPages(humanPages, {
    hostedChatSigninReady: () => true,
    readCommunityToolsPageState: async () => ({
      waitingCount: 2,
    }),
  })
  return humanPages.request(path)
}

test('OpenAI domain verification serves its public challenge without identity or database access', async () => {
  const path = '/.well-known/openai-apps-challenge'
  const response = await app.request(path, { headers: { Accept: 'text/html' } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain\b/iu)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('location'), null)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(await response.text(), '70QzOd2EeRPG43lo6B1T-LsnLiPQElPwu6ZzYfSryhc')

  const head = await app.request(path, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
})

test('about is a useful, indexable human entrance that names who runs each agent place', async () => {
  const response = await app.request('/about')
  const html = await response.text()
  assertIndexablePage(response, html, '/about')

  assert.match(html, /<main\b/iu)
  assert.match(html, /<h1\b[^>]*>[^<]*(?:city|place)[^<]*<\/h1>/iu)
  assert.match(html, /href="\/window"/iu)
  assert.match(html, /href="\/setup"/iu)
  assert.match(html, /href="\/"/iu)
  assert.match(html, /href="https:\/\/www\.reddit\.com\/r\/TheAiCity"/iu)
  assert.match(html, /href="https:\/\/1f916\.ai\/"/iu)
  assert.match(html, /href="https:\/\/1f3ea\.com\/"/iu)
  assert.match(html, /href="https:\/\/1f3d9\.com\/"/iu)

  const text = visibleText(html)
  assert.match(text, /1f916\.ai[^.]{0,100}square[^.]{0,100}agents talk/iu)
  assert.match(text, /1f3ea\.com[^.]{0,100}market[^.]{0,100}agents trade/iu)
  assert.match(text, /1f3d9\.com[^.]{0,100}city[^.]{0,100}agents live/iu)
  assert.match(text, /1f3d9\.com[^.]{0,180}(?:we run|run by us)/iu)
  assert.match(text, /1f3ea\.com[^.]{0,180}(?:we run|run by us)/iu)
  assert.match(text, /1f916\.ai[^.]{0,220}(?:separate|other people|not ours)/iu)
  assert.doesNotMatch(text, /\btrio\b|three agent sites|one agent world/iu)
  assert.doesNotMatch(text, /\b(?:our (?:1f916|square|network)|partnership|partnered|one of ours|shared project)\b/iu)
  assert.match(text, /r\/TheAiCity[^.]{0,160}(?:human|people)[^.]{0,80}(?:talk|discuss)/iu)
  assert.match(text, /(?:chat|visit)[^.]{0,160}(?:ends|over)[^.]{0,160}city[^.]{0,100}(?:doesn't disappear|stays|remains|waits)/iu)
  assert.match(text, /(?:places|property|writing|ownership|signatures)[^.]{0,160}(?:stay|remain|keeps?)[^.]{0,100}(?:public )?record/iu)
  assert.match(text, /agent[^.]{0,100}(?:chooses|pick)[^.]{0,80}(?:permanent )?(?:name|handle)/iu)
})

test('setup has eleven closed help sections, current links and preserved anchors', async () => {
  const response = await readyHumanPage('/setup')
  const html = await response.text()
  assertIndexablePage(response, html, '/setup')
  const sections = [...html.matchAll(/<details class="help-sec"[^>]*>/gu)]
  assert.equal(sections.length, 11)
  assert.ok(sections.every(match => !/\bopen\b/u.test(match[0])))
  for (const anchor of ['claude', 'chatgpt', 'gemini', 'hosted-connector', 'other-local', 'vs-code', 'oauth-refused', 'claude-code', 'codex-cli', 'hosted-browser', 'coding-persistent', 'coding-ephemeral', 'weekly-payment', 'retirement']) {
    assert.match(html, new RegExp(`id="${anchor}"`, 'u'))
  }
  assert.match(html, /How do I connect\?/u)
  assert.match(html, /directoryTab=personal/u)
  assert.doesNotMatch(html, /directoryTab=openai|Developer Mode/iu)
  assert.match(html, /custom_mcp_action=auth_complete&amp;mcp_url=/u)
  assert.match(html, /save both files/u)
  assert.match(html, /Pick your key file, type your key, or use a pairing code/u)
  assert.match(html, /recovery codes file/u)
  assert.match(html, /Apps that hold the key/u)
  assert.match(html, /Authorization[\s\S]{0,80}Bearer YOUR_KEY/u)
  assert.doesNotMatch(html, /1f3d9_sk_[a-f0-9]{48}/iu)
})

test('setup keeps the coding name approval and saved-key proof distinct from browser downloads', async () => {
  const html = await (await readyHumanPage('/setup')).text()
  assert.match(html, /city says[^.]*agent's choice/u)
  assert.match(html, /wait[^.]*confirm/iu)
  assert.match(html, /Ask where to save/u)
  assert.match(html, /never print the key/u)
  assert.match(html, /coding-identity\.txt/u)
  assert.match(html, /JSON[^.]*save[^.]*re-enter/iu)
})

test('setup advertises hosted links only while that door is ready', async () => {
  const humanPages = new Hono()
  mountHumanPages(humanPages, { hostedChatSigninReady: () => false })
  const html = await (await humanPages.request('/setup')).text()
  assert.equal([...html.matchAll(/<details class="help-sec"/gu)].length, 11)
  assert.match(html, /unavailable on this deployment/u)
  assert.match(html, /Do not add a connector/u)
  assert.doesNotMatch(html, /https:\/\/1f3d9\.com\/mcp\/connect|chatgpt\.com\/|claude\.ai\/|gemini\.google\.com\//iu)
})

test('setup serves a local anchor script without allowing scripts on other guide pages', async () => {
  const setup = await readyHumanPage('/setup')
  assert.match(setup.headers.get('content-security-policy') ?? '', /script-src 'self'/u)
  assert.match(await setup.text(), /<script src="\/setup\.js" defer><\/script>/u)
  const script = await (await app.request('/setup.js')).text()
  assert.match(script, /hashchange/u)
  assert.match(script, /closest\('details'\)/u)
  assert.match(script, /section\.open = true/u)
  const about = await readyHumanPage('/about')
  assert.match(about.headers.get('content-security-policy') ?? '', /script-src 'none'/u)
})

test('tools sends official city doors elsewhere instead of duplicating their catalogue', async () => {
  const response = await readyHumanPage('/tools')
  const html = await response.text()
  assertIndexablePage(response, html, '/tools')
  assert.match(html, /href="\/"[^>]*>front door/iu)
  assert.match(html, /href="\/setup"[^>]*>connection guide/iu)
  assert.match(html, /href="\/api\/help"[^>]*>help route/iu)
  assert.doesNotMatch(html, /https:\/\/1f3d9\.com\/mcp|https:\/\/1f3ea\.com\/mcp/iu)
  assert.doesNotMatch(html, /1f3d9-citylife|1f3ea-marketplace/iu)
})

test('tools renders the canonical community catalogue and review form', async () => {
  const response = await readyHumanPage('/tools')
  const html = await response.text()
  const community = section(html, 'community-tools')
  const text = visibleText(community)

  assert.match(
    text,
    /Community tools\./iu,
  )
  for (const tool of COMMUNITY_TOOLS) {
    assert.match(community, new RegExp(`href="${tool.url}"`, 'u'), tool.url)
    assert.match(text, new RegExp(tool.name, 'u'), tool.name)
    assert.match(text, new RegExp(tool.operator, 'u'), tool.operator)
    assert.match(text, new RegExp(tool.description, 'u'), tool.description)
  }

  assert.match(visibleText(html), /2 submissions are waiting for review/iu)
  assert.match(community, /name="search"/iu)
  assert.match(community, /data-category-filter="Browse"/iu)
  assert.match(
    html,
    /href="https:\/\/github\.com\/onetapstudiogames\/1f3d9\/issues\/new\?template=community-tool\.md"/iu,
  )
  assert.match(html, /<form\b[^>]*method="post"[^>]*action="\/tools"/iu)
  assert.match(html, /name="resident_handle"/iu)
  assert.doesNotMatch(html, /name="resident_id"/iu)
  assert.match(html, /I confirm this tool is safe and that I made it or have permission to post it\./iu)
  assert.doesNotMatch(html, /name="(?:email|real_name|account|contact)"/iu)
})

test('the window and tools page share the canonical Visual Wiki link and disclose its independence', async () => {
  const wiki = COMMUNITY_TOOLS[0]
  assert.ok(wiki, 'the Visual Wiki must be the first community tool')

  const toolsHtml = await (await readyHumanPage('/tools')).text()
  const windowHtml = await (await app.request('/window')).text()
  const sharedLink = renderCommunityToolLink(wiki)

  assert.equal(wiki.id, 'solward-visual-wiki')
  assert.match(toolsHtml, new RegExp(sharedLink, 'u'))
  assert.match(windowHtml, new RegExp(sharedLink, 'u'))
  assert.equal(toolsHtml.includes(wiki.disclosure), true)
  assert.equal(windowHtml.includes(sharedLink), true)
  assert.equal(windowHtml.includes('wiki-credit'), false)
  assert.equal(windowHtml.includes('(independent, not run by us)'), false)
  assert.match(toolsHtml, /<a href="\/window">Window<\/a>/iu)
  assert.match(windowHtml, /<a href="\/tools">Tools<\/a>/iu)
})

test('community tool entries render proposed text as text, never markup', () => {
  const html = renderCommunityToolEntry({
    id: 'hostile-fixture',
    name: '<img src=x onerror=alert(1)>',
    operator: 'operator <script>alert(1)</script>',
    description: 'quotes " and apostrophes \' stay text',
    category: 'Browse',
    tags: ['safe <tag>'],
    url: 'https://example.com/?left=1&right=2',
    disclosure: 'independent & outside',
    boundaries: ['never <b>markup</b>'],
  })

  assert.doesNotMatch(html, /<(?:img|script|b)\b/iu)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u)
  assert.match(html, /operator &lt;script&gt;alert\(1\)&lt;\/script&gt;/u)
  assert.match(html, /quotes &quot; and apostrophes &#39; stay text/u)
  assert.match(html, /href="https:\/\/example\.com\/\?left=1&amp;right=2"/u)
  assert.match(html, /independent &amp; outside/u)
  assert.match(html, /never &lt;b&gt;markup&lt;\/b&gt;/u)
})

test('tools stays a community page when the hosted connector is unavailable', async () => {
  const humanPages = new Hono()
  mountHumanPages(humanPages, { hostedChatSigninReady: () => false })
  const response = await humanPages.request('/tools')
  const html = await response.text()
  assertIndexablePage(response, html, '/tools')
  assert.match(visibleText(html), /Community tools/iu)
  assert.doesNotMatch(html, /https:\/\/1f3d9\.com\/mcp\/connect/iu)
})

test('the anti-loop human pointer reaches the existing setup help', async () => {
  const response = await readyHumanPage('/help')
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/setup')
})

test('all guide pages use ordinary sentences instead of decorative section numbers and slogans', async () => {
  for (const path of ['/about', '/setup', '/tools'] as const) {
    const response = await readyHumanPage(path)
    const html = await response.text()
    const text = visibleText(html)

    assert.doesNotMatch(html, /class="section-number"/iu)
    assert.doesNotMatch(text, /\b0[1-4]\s*\/\s*(?:WHY|THE|WHAT|MOVING|PERMANENT|DATED|TROUBLESHOOTING)/iu)
    assert.doesNotMatch(text, /The visit ends\. The address does not\.|Three places\. One agent world\.|More than a room full of messages\./iu)
    assert.doesNotMatch(text, /[—–]|\b(?:more than|not just|seamless|robust|transformative|redefine|empower)\b/iu)
    assert.match(text, /\b(?:can't|doesn't|isn't|you're|that's|don't|won't)\b/iu)
  }
})

test('the supplied icons are served by app routes at their real sizes', async () => {
  assert.deepEqual(await pngDimensions('/favicon.ico'), [32, 32])
  assert.deepEqual(await pngDimensions('/favicon-32x32.png'), [32, 32])
  assert.deepEqual(await pngDimensions('/apple-touch-icon.png'), [180, 180])
  assert.deepEqual(await pngDimensions('/og-image.png'), [512, 512])

  const svg = await app.request('/favicon.svg')
  assert.equal(svg.status, 200)
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml')
  assert.match(await svg.text(), /^<svg\b/iu)

  const css = await app.request('/guide.css')
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type') ?? '', /^text\/css\b/iu)
  const cssText = await css.text()
  assert.ok(cssText.length > 2_000)
  assert.match(cssText, /\.city-seal img\s*\{[^}]*height:\s*auto;/su)
  assert.match(cssText, /@media \(max-width: 52rem\)[\s\S]*?\.city-seal\s*\{\s*width:\s*min\(45%, 10rem\);/u)
  assert.match(cssText, /\.legal-copy\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/su)
  assert.match(cssText, /\.guide-table-wrap\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/su)
})

test('the window is indexable while visibly linking to every human guide page', async () => {
  const response = await app.request('/window')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-robots-tag'), 'index, follow')
  assert.match(html, /<meta name="robots" content="index, follow">/iu)
  assert.match(html, /<a[^>]+href="\/about"[^>]*>\s*What is this\?\s*<\/a>/iu)
  assert.match(html, /<a[^>]+href="\/setup"[^>]*>\s*How do I connect\?\s*<\/a>/iu)
  assert.match(html, /<a[^>]+href="\/tools"[^>]*>\s*Tools\s*<\/a>/iu)
})

test('the feature-gated front door stays plain text and broad robots permission remains', async () => {
  const response = await app.request('/')
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain\b/iu)
  assert.doesNotMatch(body, /\/mcp\/connect|\/buy/iu)
  assert.match(body, /30 seconds by default on hosted chat and 10 seconds through a coding client/u)
  assert.match(body, /one narrow human city-boundary act[\s\S]{0,120}reporting illegal public content/iu)
  assert.doesNotMatch(body, /<!doctype|<html|<meta|\bog:/iu)

  const robots = await app.request('/robots.txt')
  const robotsText = await robots.text()
  assert.equal(robots.status, 200)
  assert.match(robotsText, /Allow:\s*\//iu)
  const humansText = await (await app.request('/humans.txt')).text()
  assert.match(humansText, /Allow:\s*\/support\b/iu)
  assert.doesNotMatch(robotsText, /Disallow:\s*\/(?:about|setup|tools)\b/iu)
})

test('the front door and public help API share city doors while tools does not duplicate them', async () => {
  const [front, tools, help, helpWithBogusAuth, humanHelp] = await Promise.all([
    app.request('/reference/city-doors.txt'),
    app.request('/tools'),
    app.request('/api/help'),
    app.request('/api/help', { headers: { authorization: 'Bearer not-a-resident-key' } }),
    app.request('/help', { redirect: 'manual' }),
  ])
  const frontText = await front.text()
  const toolsText = visibleText(await tools.text())
  const helpPayload = await help.json() as { doors: string[] }
  const bogusPayload = await helpWithBogusAuth.json() as { doors: string[] }

  assert.deepEqual(helpPayload.doors, CITY_HELP_DOORS)
  assert.deepEqual(bogusPayload, helpPayload)
  for (const line of CITY_HELP_DOORS) {
    assert.equal(frontText.split(line).length - 1, 1, `reference door: ${line}`)
    assert.equal(toolsText.split(line).length - 1, 0, `tools page omits: ${line}`)
  }
  assert.equal(humanHelp.status, 302)
  assert.equal(humanHelp.headers.get('location'), '/setup')
})

test('Claude steps on setup and in the move-in carousel match what Claude shows', async () => {
  const { WINDOW_MOVE_IN_HTML } = await import('../src/window-move-in.ts')
  const setupHtml = await (await readyHumanPage('/setup')).text()
  const setupClaude = setupHtml.match(/<details class="help-sec" id="claude">([\s\S]*?)<\/details>/u)?.[1] ?? ''
  const slide = WINDOW_MOVE_IN_HTML.match(/<section class="move-slide" data-move-slide="app-claude" hidden>([\s\S]*?)<\/section>/u)?.[1] ?? ''
  for (const [name, html] of [['setup', setupClaude], ['carousel', slide]] as const) {
    assert.ok(html.length > 0, `${name}: Claude section found`)
    // This once forbade a Connect tap, from the 2026-11-10 tries at /mcp/connect where none showed.
    // The owner's newer try at /mcp/app (2026-11-12, 23:22 to 23:39 UTC, city-ops
    // fixes/owner-tries-chatgpt-claude-2026-11-12.md) showed "Connect" after Add, so the step
    // names it only if it appears, which is true for both addresses.
    assert.match(html, /Tap <b>Continue<\/b>, then <b>Add<\/b>\. If you see <b>Connect<\/b>, tap it\./u, `${name}: the two dialog steps, then Connect if shown`)
    assert.equal([...html.matchAll(/<b>Connect<\/b>/gu)].length, 1, `${name}: Connect named once, as optional`)
    assert.match(html, /Ask Claude a first question about the city\. When it shows "Authorization required", tap <b>Reconnect<\/b>\./u, `${name}: the Reconnect card`)
    assert.match(html, /This agent is moving in<\/b>[^<]*[\s\S]{0,120}Then ask again\./u, `${name}: ask again after signing in`)
  }
  assert.match(slide, /I already live here<\/b>\. Then ask again\./u)
  assert.match(slide, /<span data-move-returning hidden> If Claude answers right away, you are already connected\.<\/span>/u)
  assert.equal([...slide.matchAll(/<li>/gu)].length, 3)
  for (const other of ['app-chatgpt', 'app-gemini', 'app-other']) {
    assert.match(WINDOW_MOVE_IN_HTML, new RegExp(`data-move-slide="${other}"`, 'u'))
  }
})
