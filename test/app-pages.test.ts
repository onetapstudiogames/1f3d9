import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mountAppPages, appPagePurchaseLinks } from '../src/app-pages.ts'
import { mountLegalRoutes, TERMS_TEXT } from '../src/legal.ts'
import { windowPage } from '../src/window.ts'
import { mountHumanPages } from '../src/human-pages.ts'

test('public app verification files stay absent until valid public values are filled', async () => {
  const missing = new Hono()
  mountAppPages(missing, { signingFingerprint: '<PLAY_APP_SIGNING_SHA256>', publisherId: '<ADMOB_PUBLISHER_ID>' })
  for (const path of ['/.well-known/assetlinks.json', '/app-ads.txt']) {
    assert.equal((await missing.request(path)).status, 404)
  }
  const ready = new Hono()
  const fingerprint = Array(32).fill('AB').join(':')
  mountAppPages(ready, { signingFingerprint: fingerprint, publisherId: 'pub-0000000000000000' })
  const links = await ready.request('/.well-known/assetlinks.json')
  assert.equal(links.status, 200)
  assert.match(links.headers.get('content-type') ?? '', /application\/json/u)
  assert.deepEqual(await links.json(), [{ relation: ['delegate_permission/common.handle_all_urls'], target: {
    namespace: 'android_app', package_name: 'com.twamd.city_observatory', sha256_cert_fingerprints: [fingerprint],
  } }])
  const ads = await ready.request('/app-ads.txt')
  assert.equal(ads.status, 200)
  assert.match(ads.headers.get('content-type') ?? '', /text\/plain/u)
  assert.equal(await ads.text(), 'google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0\n')
})

test('app pages hide purchase links and sentences, preserve legal text, and cannot share a cached web response', async () => {
  const app = new Hono()
  app.use('*', appPagePurchaseLinks)
  mountLegalRoutes(app)
  app.get('/window', c => windowPage(c, true))
  app.get('/window/:view', c => windowPage(c, true))
  for (const path of ['/', '/about', '/gazette', '/tools', '/treasury', '/changelog']) {
    app.get(path, c => c.html('<p>Read the city.</p><p>Fund a resident at <a href="/buy">Buy</a>.</p>'))
  }
  app.get('/reference.txt', c => c.text('Read the city.\n\nFund a resident at /buy.\n'))
  for (const path of ['/', '/window', '/window/map', '/about', '/gazette', '/tools', '/treasury', '/changelog', '/reference.txt']) {
    const normal = await app.request(path)
    assert.match(await normal.text(), /\/buy/u, path)
    const embedded = await app.request(`${path}?from=app`)
    assert.equal(embedded.status, 200, path)
    assert.doesNotMatch(await embedded.text(), /\/buy/u, path)
    assert.equal(embedded.headers.get('cache-control'), 'no-store')
  }
  const terms = await app.request('/terms?from=app', { headers: { accept: 'text/plain' } })
  assert.equal(await terms.text(), TERMS_TEXT)
})


// Each case is [what it covers, the plain text page, the same page opened from the app].
const APP_TEXT_CASES: readonly (readonly [string, string, string])[] = [
  ['a list whose lines end in full stops and name no buy page',
    'Steps.\n- One.\n- Two.\n  - Two and a half.\n- Three.\n\nAfter the list.\n',
    'Steps.\n- One.\n- Two.\n  - Two and a half.\n- Three.\n\nAfter the list.\n'],
  ['a buy sentence in the middle of a line',
    'Intro.\nRead the city. Fund one at /buy now. Then walk.\nEnd.\n',
    'Intro.\nRead the city. Then walk.\nEnd.\n'],
  ['a buy sentence at the start of a line',
    'Intro.\nFund one at /buy. Then walk.\nEnd.\n',
    'Intro.\nThen walk.\nEnd.\n'],
  ['a buy sentence at the end of a line',
    'Intro.\nRead the city. Fund one at /buy.\nEnd.\n',
    'Intro.\nRead the city.\nEnd.\n'],
  ['a buy sentence alone on its line in an indented list',
    'Steps:\n  - First.\n  - Fund one at /buy.\n  - Last.\n',
    'Steps:\n  - First.\n  - Last.\n'],
  ['a whole paragraph of buy sentences',
    'First paragraph.\n\nFund one at /buy.\nGift one at /buy too.\n\nLast paragraph.\n',
    'First paragraph.\n\nLast paragraph.\n'],
  ['two buy sentences in a row',
    'Read. Fund one at /buy. Gift one at /buy. Walk.\n',
    'Read. Walk.\n'],
  ['buy sentences at the very start of the page',
    'Fund one at /buy. Read the city.\nWalk.\n',
    'Read the city.\nWalk.\n'],
  ['a buy line at the very start of the page',
    'Fund one at /buy.\nRead.\n',
    'Read.\n'],
  ['a buy paragraph at the very start of the page',
    'Fund one at /buy.\n\nRead.\n',
    'Read.\n'],
  ['a buy line at the very end of the page, with a final line break',
    'Read.\nFund one at /buy.\n',
    'Read.\n'],
  ['a buy line at the very end of the page, without a final line break',
    'Read.\nFund one at /buy.',
    'Read.'],
  ['a buy sentence ending the page mid-line, without a final line break',
    'Read. Fund one at /buy.',
    'Read.'],
  ['a buy paragraph at the very end of the page',
    'Read.\n\nFund one at /buy.\n',
    'Read.\n'],
  ['a sentence naming the buy page with other words goes whole, as before',
    'Questions go to POST /api/flag; fee credit is at /buy. Walk on.\n',
    'Walk on.\n'],
  ['a buy sentence that starts on one line and ends on the next keeps the line break between the kept words',
    'Agents speak in places. Humans may watch and fund\nfee credit when /buy is open. Funding grants no rights.\n',
    'Agents speak in places.\nFunding grants no rights.\n'],
  ['a buy sentence that starts mid-line and ends a later line takes the lines it fills',
    'Intro.\nYour agent can. Humans have two\nacts: report content and fund a\nresident at /buy when it is open.\nFunding grants nothing.\n',
    'Intro.\nYour agent can.\nFunding grants nothing.\n'],
  ['a buy sentence that starts an indented line and ends partway through the next takes its first line whole',
    '  - Fund at /buy when\nit is open. Walk.\n',
    'Walk.\n'],
  ['a buy sentence that starts the page and ends partway through a later indented line keeps that line\'s own indent',
    'Steps:\n- Fund one at /buy when it\n  is open. Then walk.\n- Next.\n',
    '  Then walk.\n- Next.\n'],
  ['a buy sentence that starts a list line and ends partway through the next keeps the line before and the next line\'s indent',
    'Steps.\n- Fund one at /buy when it\n  is open. Then walk.\n- Next.\n',
    'Steps.\n  Then walk.\n- Next.\n'],
  ['a buy sentence that starts mid-line and ends partway through an indented later line keeps that line\'s own indent',
    'Read. Fund at /buy when\nnote\n  more at it. Walk.\n',
    'Read.\n  Walk.\n'],
  ['a buy sentence that starts a line and ends partway through a later line, with Windows line endings',
    'Intro.\r\nFund one at /buy when\r\n  it is open. Walk.\r\n',
    'Intro.\r\n  Walk.\r\n'],
  ['Windows line endings stay as served',
    'Intro.\r\nFund one at /buy.\r\nRead. Gift one at /buy. Walk.\r\n\r\nGift one at /buy.\r\n\r\nEnd.\r\n',
    'Intro.\r\nRead. Walk.\r\n\r\nEnd.\r\n'],
]

test('app text pages lose only the sentences naming the buy page and keep every line break', async () => {
  for (const [label, plain, expected] of APP_TEXT_CASES) {
    const app = new Hono()
    app.use('*', appPagePurchaseLinks)
    app.get('/reference.txt', c => c.text(plain))
    assert.equal(await (await app.request('/reference.txt')).text(), plain, label)
    const embedded = await app.request('/reference.txt?from=app')
    assert.equal(await embedded.text(), expected, label)
    assert.equal(embedded.headers.get('cache-control'), 'no-store', label)
  }
})

type LeftOutRun = Readonly<{ lines: readonly string[], besideCutLine: boolean }>

/** Plain lines the app version left out, in order, or null when an app line is not a plain line or one with a buy sentence cut out. */
function linesLeftOut(plain: readonly string[], embedded: readonly string[]): LeftOutRun[] | null {
  const runs: LeftOutRun[] = []
  let next = 0
  let previousCut = false
  for (const line of embedded) {
    const skipped: string[] = []
    while (next < plain.length && !isPlainOrCutLine(plain[next] ?? '', line)) skipped.push(plain[next++] ?? '')
    if (next === plain.length) return null
    const cutLine = plain[next] !== line
    if (skipped.length > 0) runs.push({ lines: skipped, besideCutLine: previousCut || cutLine })
    previousCut = cutLine
    next += 1
  }
  return plain.length > next ? [...runs, { lines: plain.slice(next), besideCutLine: previousCut }] : runs
}

/** A buy sentence is cut from inside one line, or it crosses lines and takes the end or start of this one. */
function isPlainOrCutLine(plainLine: string, line: string): boolean {
  if (plainLine === line) return true
  if (line.trim() === '') return false
  let prefix = 0
  while (prefix < line.length && plainLine[prefix] === line[prefix]) prefix += 1
  const suffix = line.length - prefix
  if (!plainLine.endsWith(line.slice(prefix))) return false
  const removed = plainLine.slice(prefix, plainLine.length - suffix)
  return removed.includes('/buy') || prefix === 0 || suffix === 0
}

test('the real text pages opened from the app keep every line that names no buy page', async () => {
  process.env.REVENUECAT_SECRET_KEY = ''
  process.env.DATABASE_URL = ''
  process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
  // The site module loads once per file, so this test sets the same web buy settings as the one below.
  process.env.PAYPAL_ENV = 'sandbox'
  process.env.PAYPAL_CLIENT_ID = 'test-client-id'
  process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret'
  process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id'
  const { default: site } = await import('../src/index.ts')
  const { REFERENCE_SECTIONS } = await import('../src/door.ts')
  const paths = ['/', '/llms.txt', '/reference.txt', ...Object.keys(REFERENCE_SECTIONS).map(slug => `/reference/${slug}.txt`)]
  assert.ok(paths.includes('/reference/money.txt') && paths.includes('/reference/mcp.txt'))
  let pagesNamingBuy = 0
  for (const path of paths) {
    const plain = await (await site.request(path)).text()
    const embedded = await (await site.request(`${path}?from=app`)).text()
    assert.doesNotMatch(embedded, /\/buy/u, path)
    if (!plain.includes('/buy')) {
      assert.equal(embedded, plain, path)
      continue
    }
    pagesNamingBuy += 1
    const leftOut = linesLeftOut(plain.split('\n'), embedded.split('\n'))
    assert.ok(leftOut, `${path}: an app line is neither a plain line nor one with a buy sentence cut out`)
    for (const { lines, besideCutLine } of leftOut) {
      if (lines.every(line => line.trim() === '') || besideCutLine) continue
      assert.match(lines.join('\n'), /\/buy/u, `${path}: ${lines.join(' / ')}`)
    }
    const removedWhole = leftOut.reduce((count, { lines }) => count + lines.length, 0)
    assert.ok(plain.split('\n').length - embedded.split('\n').length <= removedWhole, path)
  }
  assert.ok(pagesNamingBuy >= 2, 'the front door and the mcp section name the buy page')
})

test('mounted site accepts app windows and applies hiding to its real guide and reference responses', async () => {
  process.env.REVENUECAT_SECRET_KEY = ''
  process.env.DATABASE_URL = ''
  process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
  process.env.PAYPAL_ENV = 'sandbox'
  process.env.PAYPAL_CLIENT_ID = 'test-client-id'
  process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret'
  process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id'
  const { default: site } = await import('../src/index.ts')
  const normal = await site.request('/window')
  assert.match(await normal.text(), /href="\/buy"/u)
  for (const path of ['/window', '/window/map', '/about', '/tools', '/changelog', '/reference.txt', '/reference/money.txt']) {
    const response = await site.request(`${path}?from=app`, { headers: { accept: 'text/html' } })
    assert.equal(response.status, 200, path)
    assert.doesNotMatch(await response.text(), /\/buy/u, path)
    assert.equal(response.headers.get('cache-control'), 'no-store', path)
  }
  for (const path of ['/terms', '/privacy', '/delete']) {
    const response = await site.request(`${path}?from=app`, { headers: { accept: 'text/html' } })
    assert.equal(response.status, 200)
  }
  assert.equal((await site.request('/.well-known/assetlinks.json')).status, 200)
  assert.equal((await site.request('/app-ads.txt')).status, 200)
  const play = await site.request('/api/city-credit/play/residents/by-handle/test-resident')
  assert.equal(play.status, 503)
  assert.match(await play.text(), /not configured/u)
})

test('app pages drop PayPal tip and market window links with their words, and leave the normal window unchanged', async () => {
  const app = new Hono()
  app.use('*', appPagePurchaseLinks)
  app.get('/window', c => windowPage(c, true))
  const plain = new Hono()
  plain.get('/window', c => windowPage(c, true))
  const normal = await (await app.request('/window')).text()
  assert.equal(normal, await (await plain.request('/window')).text())
  assert.match(normal, /href="https:\/\/www\.paypal\.com\/donate\//u)
  assert.match(normal, /href="https:\/\/1f3ea\.com\/window"/u)
  assert.match(normal, /href="\/buy"/u)
  const embedded = await (await app.request('/window?from=app')).text()
  assert.doesNotMatch(embedded, /paypal\.com\/donate/u)
  assert.doesNotMatch(embedded, /1f3ea\.com\/window/u)
  assert.doesNotMatch(embedded, /tip the builder|humans only, buys nothing|The market window/iu)
  assert.doesNotMatch(embedded, /\/buy/u)
  assert.match(embedded, /AGPL-3\.0<\/a><\/p>/u)
  assert.match(embedded, /href="https:\/\/1f916\.ai\/"/u)
})

test('legal app pages keep every word of a tip or market link as plain text', async () => {
  const app = new Hono()
  app.use('*', appPagePurchaseLinks)
  const page = '<p>Questions go to support · <a href="https://www.paypal.com/donate/?hosted_button_id=X" rel="external">tip the builder</a> (humans only, buys nothing). See <a href="https://1f3ea.com/window">The market window</a>.</p>'
  app.get('/support', c => c.html(page))
  assert.equal(await (await app.request('/support')).text(), page)
  assert.equal(await (await app.request('/support?from=app')).text(),
    '<p>Questions go to support · tip the builder (humans only, buys nothing). See The market window.</p>')
})

test('the treasury page accepts the app marker and still refuses other options', async () => {
  process.env.REVENUECAT_SECRET_KEY = ''
  process.env.DATABASE_URL = ''
  process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
  const { default: site } = await import('../src/index.ts')
  const html = { headers: { accept: 'text/html' } }
  const normal = await site.request('/treasury', html)
  const embedded = await site.request('/treasury?from=app', html)
  assert.equal(embedded.status, normal.status)
  assert.doesNotMatch(await embedded.text(), /unsupported query option/u)
  for (const query of ['?from=web', '?from=app&from=app', '?from=app&colour=blue', '?colour=blue']) {
    const refused = await site.request(`/treasury${query}`, html)
    assert.equal(refused.status, 400, query)
    assert.match(await refused.text(), /unsupported query option/u, query)
  }
  const api = await site.request('/api/treasury?from=app')
  assert.equal(api.status, 400)
})

const MARKET_HREF = /href=["'](?:https?:\/\/(?:www\.)?1f3ea\.com(?:[/?#][^"']*)?|(?:https:\/\/1f3d9\.com)?\/market(?:[?#][^"']*)?)["']/iu

test('app pages carry no market link, entry or mention, and the about and window prose still reads', async () => {
  process.env.REVENUECAT_SECRET_KEY = ''
  process.env.DATABASE_URL = ''
  process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
  const { default: site } = await import('../src/index.ts')
  const html = { headers: { accept: 'text/html' } }
  for (const path of ['/about', '/window', '/window/map', '/tools', '/changelog', '/terms', '/privacy', '/delete', '/support']) {
    const page = await (await site.request(`${path}?from=app`, html)).text()
    assert.doesNotMatch(page, MARKET_HREF, path)
    // The changelog keeps its older history lines as they are.
    if (path !== '/changelog') assert.doesNotMatch(page, /Visit the market|market next door|1f3ea\.com · The market/iu, path)
    assert.doesNotMatch(page, /<nav class="guide-nav"[^>]*>[\s\S]*?>Market<\/a>[\s\S]*?<\/nav>/u, path)
  }
  const about = await (await site.request('/about?from=app', html)).text()
  assert.match(about, /<p class="section-intro">1F3D9 is the city\. 1F916 is a separate square where agents talk\. Other people run it, but we point to it because a newcomer may still find it useful\.<\/p>/u)
  assert.doesNotMatch(about, /1F3EA/u)
  assert.match(about, /<h3>1f3d9\.com · The city<\/h3>/u)
  assert.match(about, /href="https:\/\/1f916\.ai\/"/u)
  const window = await (await site.request('/window?from=app', html)).text()
  assert.match(window, /neither grants city rights\. Agents live here\. Humans talk about this place at <a href="https:\/\/www\.reddit\.com\/r\/TheAiCity"/u)
  assert.match(window, /claude plugin marketplace add/u)
  const privacy = await (await site.request('/privacy?from=app', html)).text()
  assert.match(privacy, /for this city and 1f3ea\.com/u)
})

test('legal app pages unwrap market links to plain words, and other pages drop them', async () => {
  const app = new Hono()
  app.use('*', appPagePurchaseLinks)
  const page = '<p>The market is at <a href="https://1f3ea.com/" rel="external">1f3ea.com</a>; read <a href="/market">the market guide</a>.</p>'
  for (const path of ['/support', '/about']) app.get(path, c => c.html(page))
  assert.equal(await (await app.request('/support?from=app')).text(),
    '<p>The market is at 1f3ea.com; read the market guide.</p>')
  assert.equal(await (await app.request('/about?from=app')).text(), '<p>The market is at ; read .</p>')
})

test('pages without the app marker, and paths it does not cover, stay byte for byte the same', async () => {
  const withMarker = new Hono()
  withMarker.use('*', appPagePurchaseLinks)
  mountHumanPages(withMarker)
  withMarker.get('/window', c => windowPage(c, true))
  const plain = new Hono()
  mountHumanPages(plain)
  plain.get('/window', c => windowPage(c, true))
  for (const path of ['/about', '/window', '/market', '/market?from=app', '/setup', '/setup.js?from=app']) {
    const served = await withMarker.request(path)
    const expected = await plain.request(path)
    assert.equal(await served.text(), await expected.text(), path)
    assert.deepEqual([...served.headers], [...expected.headers], path)
  }
  const about = await (await withMarker.request('/about')).text()
  assert.match(about, /Visit the market/u)
  assert.match(about, /We also run 1F3EA, the market next door\./u)
  assert.match(about, /<a href="\/market">Market<\/a>/u)
  assert.match(await (await withMarker.request('/window')).text(), /Agents live here; we also run the market next door\./u)
})

const SETUP_MARKET_NAV_ITEM = /\n\s*<a href="\/market">Market<\/a>/u
const SETUP_HELP_SECTION = /<details class="help-sec"[\s\S]*?<\/details>/gu

test('the setup page opened from the app drops only the header Market item, keeps every help section, and is not cached', async () => {
  for (const hostedChatSigninReady of [true, false]) {
    const withMarker = new Hono()
    withMarker.use('*', appPagePurchaseLinks)
    mountHumanPages(withMarker, { hostedChatSigninReady: () => hostedChatSigninReady })
    const plain = new Hono()
    mountHumanPages(plain, { hostedChatSigninReady: () => hostedChatSigninReady })
    const label = `hosted chat sign-in ${hostedChatSigninReady ? 'ready' : 'unavailable'}`
    const normal = await (await plain.request('/setup')).text()
    assert.match(normal, SETUP_MARKET_NAV_ITEM, label)
    const embedded = await withMarker.request('/setup?from=app')
    assert.equal(embedded.status, 200, label)
    assert.equal(embedded.headers.get('cache-control'), 'no-store', label)
    const page = await embedded.text()
    assert.equal(page, normal.replace(SETUP_MARKET_NAV_ITEM, ''), label)
    assert.doesNotMatch(page, MARKET_HREF, label)
    assert.doesNotMatch(page, /<nav class="guide-nav"[^>]*>[\s\S]*?>Market<\/a>[\s\S]*?<\/nav>/u, label)
    const sections = normal.match(SETUP_HELP_SECTION) ?? []
    assert.ok(sections.some(section => section.includes('id="weekly-payment"')), label)
    assert.ok(sections.some(section => section.includes('id="retirement"')), label)
    for (const section of sections) assert.ok(page.includes(section), `${label}: ${section.slice(0, 60)}`)
  }
})

// Anyone who adds market or payment content to these pages must cover them first.
const IDENTITY_PAGE_FORBIDDEN = [
  MARKET_HREF,
  />Market<\/a>/u,
  /1f3ea\.com/iu,
  /href=["'](?:https:\/\/1f3d9\.com)?\/buy(?:[?#][^"']*)?["']/iu,
  /paypal\.com/iu,
] as const

test('the join, recovery and rotate pages carry nothing the app marker removes, so they stay uncovered', async () => {
  const { memoryStore } = await import('./helpers/identity-browser-fixtures/memory-store.ts')
  const { mountIdentityRoutes } = await import('../src/identity-browser.ts')
  for (const hostedChatSigninReady of [true, false]) {
    const app = new Hono()
    mountIdentityRoutes(app, {
      environment: {
        PUBLIC_ORIGIN: 'https://1f3d9.com',
        VERCEL: '1',
        IDENTITY_RECOVERY_ENABLED: 'true',
        IDENTITY_ROTATION_ENABLED: 'true',
      },
      store: memoryStore().store,
      hostedChatSigninReady,
    })
    for (const path of ['/join', '/join?new=1', '/recovery', '/rotate']) {
      const label = `${path} with hosted chat sign-in ${hostedChatSigninReady ? 'ready' : 'unavailable'}`
      const response = await app.request(path, { headers: { accept: 'text/html' } })
      assert.equal(response.status, 200, label)
      const page = await response.text()
      for (const pattern of IDENTITY_PAGE_FORBIDDEN) assert.doesNotMatch(page, pattern, label)
    }
  }
})

test('the join, recovery and rotate pages opened from the app go through the app marker untouched', async () => {
  // Markup a covered page would lose, so any coverage of these paths shows up as a changed body or headers.
  const page = '<nav class="guide-nav"><a href="/about">About</a> <a href="/market">Market</a></nav><p>Fund a resident at <a href="/buy">Buy</a>.</p>'
  const headers = { 'Cache-Control': 'public, max-age=300', 'Content-Length': String(Buffer.byteLength(page)) }
  const withMarker = new Hono()
  withMarker.use('*', appPagePurchaseLinks)
  const plain = new Hono()
  for (const path of ['/join', '/recovery', '/rotate', '/setup']) {
    for (const app of [withMarker, plain]) app.get(path, c => c.html(page, 200, headers))
  }
  const covered = await withMarker.request('/setup?from=app')
  assert.notEqual(await covered.text(), page)
  assert.equal(covered.headers.get('cache-control'), 'no-store')
  for (const path of ['/join', '/recovery', '/rotate']) {
    const served = await withMarker.request(`${path}?from=app`)
    const expected = await plain.request(`${path}?from=app`)
    assert.equal(await served.text(), page, path)
    assert.deepEqual([...served.headers], [...expected.headers], path)
    assert.equal(served.headers.get('cache-control'), headers['Cache-Control'], path)
    assert.equal(served.headers.get('content-length'), headers['Content-Length'], path)
  }
})

test('the architecture doc states the decision 191 app rule no wider than the code', async () => {
  const { readFileSync } = await import('node:fs')
  const architecture = readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8').replace(/\s+/gu, ' ')
  assert.doesNotMatch(architecture, /every market link and mention/u)
  assert.match(architecture, /every market link and the words saying we run the market \(decision 191; legal words, changelog history and the text pages stay\)/u)
})
