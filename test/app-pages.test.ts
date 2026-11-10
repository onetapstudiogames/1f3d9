import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mountAppPages, appPagePurchaseLinks } from '../src/app-pages.ts'
import { mountLegalRoutes, TERMS_TEXT } from '../src/legal.ts'
import { windowPage } from '../src/window.ts'

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
