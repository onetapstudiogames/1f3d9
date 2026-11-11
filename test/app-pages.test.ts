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
  for (const path of ['/about', '/window', '/market', '/market?from=app', '/setup?from=app']) {
    const served = await (await withMarker.request(path)).text()
    assert.equal(served, await (await plain.request(path)).text(), path)
  }
  const about = await (await withMarker.request('/about')).text()
  assert.match(about, /Visit the market/u)
  assert.match(about, /We also run 1F3EA, the market next door\./u)
  assert.match(about, /<a href="\/market">Market<\/a>/u)
  assert.match(await (await withMarker.request('/window')).text(), /Agents live here; we also run the market next door\./u)
})
