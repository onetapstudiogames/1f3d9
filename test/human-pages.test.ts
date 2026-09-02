import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { CITY_HELP_DOORS } from '../src/city-help.ts'

process.env.DATABASE_URL = ''
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'false'
process.env.IDENTITY_RECOVERY_ENABLED = 'false'
process.env.IDENTITY_ROTATION_ENABLED = 'false'

const { default: app } = await import('../src/index.ts')
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
  path: '/about' | '/setup' | '/tools',
): void {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/iu)
  assert.equal(response.headers.get('x-robots-tag'), 'index, follow')
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u)
  if (path === '/tools') {
    assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'self'/u)
    assert.match(response.headers.get('content-security-policy') ?? '', /form-action 'self'/u)
  } else {
    assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'none'/u)
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

async function readyHumanPage(path: '/about' | '/setup' | '/tools' | '/help'): Promise<Response> {
  const humanPages = new Hono()
  mountHumanPages(humanPages, {
    hostedChatSigninReady: () => true,
    readCommunityToolsPageState: async () => ({
      waitingCount: 2,
      residents: [{ id: 46, handle: 'solward' }],
    }),
  })
  return humanPages.request(path)
}

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

test('setup keeps permanent rules separate from dated menu paths and explains both doors', async () => {
  const response = await readyHumanPage('/setup')
  const html = await response.text()
  assertIndexablePage(response, html, '/setup')

  const permanent = section(html, 'permanent-facts')
  const dated = section(html, 'dated-steps')
  assert.ok(html.indexOf(permanent) < html.indexOf(dated))
  assert.doesNotMatch(visibleText(permanent), /profile icon|security and login|plugins tab|browse plugins|settings > connectors/iu)

  const permanentText = visibleText(permanent)
  assert.match(permanentText, /ChatGPT[\s\S]{0,120}Claude[\s\S]{0,240}https:\/\/1f3d9\.com\/mcp\/connect/iu)
  assert.match(permanentText, /(?:Claude Code|Codex CLI)[\s\S]{0,240}https:\/\/1f3d9\.com\/mcp/iu)
  assert.match(permanentText, /(?:not interchangeable|(?:can't|cannot|do not) swap|different doors)/iu)
  const keyWarning = permanent.match(/<aside class="key-warning">([\s\S]*?)<\/aside>/iu)
  assert.ok(keyWarning, 'missing key warning')
  const keyWarningText = visibleText(keyWarning[1]!)
  assert.match(
    keyWarningText,
    /key[\s\S]{0,240}(?:1F3D9's own|1F3D9’s own)[\s\S]{0,240}(?:private key setting|local settings)[\s\S]{0,160}never[\s\S]{0,80}chat/iu,
  )

  const text = visibleText(html)
  assert.match(text, /Authorization:\s*Bearer\s+1f3d9_sk_\.\.\./iu)
  assert.doesNotMatch(text, /1f3d9_sk_[a-f0-9]{48}/iu)
  assert.doesNotMatch(
    text,
    /(?:^|[.!?]\s+)(?:paste|put|save|store|send) (?:the |your )?(?:real )?key (?:in|into|through) (?:a )?(?:chat|\.mcp\.json|config\.toml)/iu,
  )
  assert.match(html, /<time datetime="2026-08-23">/iu)
  assert.match(text, /ChatGPT\s*\(operator-tested\)[^.]{0,180}checked by hand[^.]{0,160}mobile[^.]{0,80}desktop/iu)
  assert.match(text, /Claude Code[^.]{0,240}Codex CLI[^.]{0,240}(?:checked|confirmed)[^.]{0,120}(?:locally|on this machine)[^.]{0,160}(?:vendor|documentation|docs)/iu)
  assert.match(text, /VS Code[\s\S]{0,260}(?:documentation|docs)[\s\S]{0,140}(?:not tested|not run|not confirmed|weren't run|wasn't tested)/iu)
  assert.doesNotMatch(text, /\bCursor\b/iu)

  assert.match(html, /claude mcp list/iu)
  assert.match(html, /codex mcp add 1f3d9 --url https:\/\/1f3d9\.com\/mcp --bearer-token-env-var ONEF3D9_AGENT_SECRET/iu)
  assert.match(html, /bearer_token_env_var\s*=\s*"ONEF3D9_AGENT_SECRET"/iu)
  assert.match(text, /(?:Use|run|call)[^.]{0,80}\bme\b[^.]{0,160}(?:handle|city name|resident name)/iu)
})

test('ready connected setup opens a visit through connector tools before acting', async () => {
  const response = await readyHumanPage('/setup')
  const html = await response.text()
  assert.equal(response.status, 200)

  for (const id of ['chatgpt', 'claude', 'claude-code', 'codex-cli', 'vs-code'] as const) {
    const guide = html.match(
      new RegExp(`<article id="${id}"[^>]*>([\\s\\S]*?)<\\/article>`, 'u'),
    )?.[1]
    assert.ok(guide, `missing #${id} setup guide`)

    const positions = ['front_door', 'official_facts', 'me', 'act'].map(tool => {
      const position = guide.indexOf(`<code>${tool}</code>`)
      assert.ok(position >= 0, `#${id}: missing ${tool}`)
      return position
    })
    assert.ok(
      positions.every((position, index) => index === 0 || positions[index - 1]! < position),
      `#${id}: front_door -> official_facts -> me -> act order`,
    )
  }
})

test('setup gives each client an honest path and keeps the safe ceremony to three steps', async () => {
  const response = await readyHumanPage('/setup')
  const html = await response.text()
  const text = visibleText(html)

  for (const id of [
    'hosted-connector',
    'hosted-browser',
    'coding-persistent',
    'coding-ephemeral',
    'oauth-refused',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`, 'u'), id)
  }
  assert.match(text, /without Developer Mode[^.]{0,220}(?:cannot|can't)[^.]{0,120}(?:add|install|connect)[^.]{0,100}connector/iu)
  assert.match(html, /id="hosted-browser"[\s\S]{0,520}href="\/window"[\s\S]{0,220}href="\/join"/iu)
  assert.match(text, /persistent coding[\s\S]{0,420}(?:password manager|operating-system credential vault|secret manager)/iu)
  assert.match(text, /ephemeral coding[\s\S]{0,520}(?:never|do not|don't)[^.]{0,180}(?:workspace|container|context|session)[\s\S]{0,220}(?:password manager|credential vault|secret manager)/iu)
  assert.match(text, /app not approved[\s\S]{0,420}\/join[\s\S]{0,220}Authorization[\s\S]{0,100}Bearer/iu)
  assert.match(
    text,
    /cannot send that header[\s\S]{0,140}cannot add a connector[\s\S]{0,180}watch[\s\S]{0,100}only if (?:its|the) host can open (?:those )?URLs/iu,
  )
  assert.match(
    html,
    /data-ceremony-path="hosted-connector"[\s\S]{0,520}\/mcp\/connect[\s\S]{0,320}(?:stored request|where you stopped)/iu,
  )
  assert.match(
    html,
    /data-ceremony-path="browser-join"[\s\S]{0,420}href="\/join"[\s\S]{0,280}same private cookie/iu,
  )

  const stepOne = html.indexOf('data-ceremony-step="1"')
  const stepTwo = html.indexOf('data-ceremony-step="2"')
  const stepThree = html.indexOf('data-ceremony-step="3"')
  assert.ok(stepOne >= 0 && stepOne < stepTwo && stepTwo < stepThree)
  assert.match(html.slice(stepOne, stepTwo), /resident key/iu)
  assert.match(html.slice(stepTwo, stepThree), /eight recovery codes/iu)
  assert.match(html.slice(stepThree), /re-enter/iu)
})

test('setup advertises the hosted connector only while that door is ready', async () => {
  for (const ready of [false, true]) {
    const humanPages = new Hono()
    mountHumanPages(humanPages, { hostedChatSigninReady: () => ready })
    const response = await humanPages.request('/setup')
    const html = await response.text()
    const hostedPath = html.match(
      /<article id="hosted-connector"[^>]*>([\s\S]*?)<\/article>/u,
    )?.[1]
    const chatGptGuide = html.match(
      /<article id="chatgpt"[^>]*>([\s\S]*?)<\/article>/u,
    )?.[1]
    const claudeGuide = html.match(
      /<article id="claude"[^>]*>([\s\S]*?)<\/article>/u,
    )?.[1]

    assert.equal(response.status, 200)
    assert.ok(hostedPath)
    assert.ok(chatGptGuide)
    assert.ok(claudeGuide)
    if (ready) {
      assert.match(html, /https:\/\/1f3d9\.com\/mcp\/connect/u)
      assert.doesNotMatch(hostedPath, /unavailable on this deployment/iu)
    } else {
      assert.doesNotMatch(html, /(?:https:\/\/1f3d9\.com)?\/mcp\/connect/iu)
      assert.match(hostedPath, /unavailable on this deployment/iu)
      assert.match(hostedPath, /href="\/"[\s\S]*href="\/window"/u)
      assert.match(hostedPath, /do not add a connector/iu)
      assert.doesNotMatch(chatGptGuide, /turn on <strong>Developer mode<\/strong>|Open the <strong>Plugins<\/strong>/iu)
      assert.doesNotMatch(claudeGuide, /Click <strong>Connectors<\/strong>|Add custom connector/iu)
      for (const guide of [chatGptGuide, claudeGuide]) {
        assert.match(guide, /unavailable on this deployment/iu)
        assert.match(guide, /href="#hosted-browser"/u)
        assert.match(guide, /href="\/"[\s\S]*href="\/window"[\s\S]*href="\/join"/u)
      }
    }
  }
})

test('setup names the likely failures, including the public look trap', async () => {
  const response = await readyHumanPage('/setup')
  const text = visibleText(await response.text())

  assert.match(text, /\blook\b[^.]{0,120}(?:is public|public)[^.]{0,160}(?:does not|doesn't|won't|never)[^.]{0,100}prove[^.]{0,100}key/iu)
  assert.match(text, /\bme\b[^.]{0,140}(?:real|actual)[^.]{0,100}(?:check|proof)/iu)
  assert.match(text, /ChatGPT[^.]{0,220}\/mcp[^.]{0,180}(?:remove|delete)[^.]{0,180}(?:new|again|recreate)[^.]{0,120}\/mcp\/connect/iu)
  assert.match(text, /connector name already exists[^.]{0,180}(?:remove|delete)[^.]{0,100}(?:old|connection)[^.]{0,120}(?:new name|another name|choose a new)/iu)
  assert.match(text, /bad or missing bearer secret/iu)
  assert.match(text, /bad or missing bearer secret[^.]{0,220}(?:\/mcp|Authorization|Bearer|key)/iu)
  assert.match(text, /\/recovery[^.]{0,180}(?:lost|recover)/iu)
  assert.match(text, /\/rotate[^.]{0,180}(?:exposed|leaked|shared|seen)/iu)
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
  assert.match(html, /name="resident_id"[\s\S]*solward \(resident #46\)/iu)
  assert.match(html, /I confirm this tool is safe and that I made it or have permission to post it\./iu)
  assert.doesNotMatch(html, /name="(?:email|real_name|account|contact)"/iu)
})

test('the window and tools page render the same canonical Visual Wiki link and disclosure', async () => {
  const wiki = COMMUNITY_TOOLS[0]
  assert.ok(wiki, 'the Visual Wiki must be the first community tool')

  const toolsHtml = await (await readyHumanPage('/tools')).text()
  const windowHtml = await (await app.request('/window')).text()
  const sharedLink = renderCommunityToolLink(wiki)

  assert.equal(wiki.id, 'solward-visual-wiki')
  assert.match(toolsHtml, new RegExp(sharedLink, 'u'))
  assert.match(windowHtml, new RegExp(sharedLink, 'u'))
  assert.equal(toolsHtml.includes(wiki.disclosure), true)
  assert.equal(windowHtml.includes(wiki.disclosure), true)
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
})

test('the window stays sealed from search while visibly linking to every human guide page', async () => {
  const response = await app.request('/window')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/iu)
  assert.match(html, /<a[^>]+href="\/about"[^>]*>\s*What is this\?\s*<\/a>/iu)
  assert.match(html, /<a[^>]+href="\/setup"[^>]*>\s*How do I connect\?\s*<\/a>/iu)
  assert.match(html, /<a[^>]+href="\/tools"[^>]*>\s*Tools\s*<\/a>/iu)
})

test('the plain-text front door and broad robots permission remain unchanged', async () => {
  const response = await app.request('/')
  const body = await response.text()
  const expected = hostedChatDiscovery(FRONTDOOR, { ready: false }, 'frontdoor', false, false)

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain\b/iu)
  assert.equal(body, expected)
  assert.doesNotMatch(body, /<!doctype|<html|<meta|\bog:/iu)

  const robots = await app.request('/robots.txt')
  const robotsText = await robots.text()
  assert.equal(robots.status, 200)
  assert.match(robotsText, /Allow:\s*\//iu)
  assert.doesNotMatch(robotsText, /Disallow:\s*\/(?:about|setup|tools)\b/iu)
})

test('the front door and public help API share city doors while tools does not duplicate them', async () => {
  const [front, tools, help, helpWithBogusAuth, humanHelp] = await Promise.all([
    app.request('/'),
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
    assert.equal(frontText.split(line).length - 1, 1, `front door: ${line}`)
    assert.equal(toolsText.split(line).length - 1, 0, `tools page omits: ${line}`)
  }
  assert.equal(humanHelp.status, 302)
  assert.equal(humanHelp.headers.get('location'), '/setup')
})
