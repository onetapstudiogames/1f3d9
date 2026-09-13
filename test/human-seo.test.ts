import test from 'node:test'
import assert from 'node:assert/strict'
import { CITY_SEARCH_DESCRIPTION } from '../src/city-facts.ts'
import { ABOUT_HTML, MARKET_HTML, SETUP_HTML } from '../src/human-pages.ts'
import { CHANGELOG_HTML } from '../src/changelog.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { renderWindowShareDocument, createWindowShareMetadata, parseWindowShareRequest } from '../src/window-sharing.ts'
import { humanSitemap } from '../src/human-seo.ts'
import { ROBOTS } from '../src/door.ts'
import { CITY_LISTING_METADATA } from '../src/listing-metadata.generated.ts'
import { treasuryDocument } from '../src/treasury-page.ts'

process.env.DATABASE_URL = ''
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'false'
const { default: app } = await import('../src/index.ts')

const pages = [
  ['/about', ABOUT_HTML],
  ['/setup', SETUP_HTML],
  ['/market', MARKET_HTML],
  ['/changelog', CHANGELOG_HTML],
] as const

test('human guide pages share the front-door facts and complete search metadata', () => {
  for (const [path, html] of pages) {
    const title = /<title>([^<]+)<\/title>/u.exec(html)?.[1]
    assert.ok(title?.includes('1F3D9') && title.length < 60, path)
    assert.match(html, new RegExp(`<meta name="description" content="${CITY_SEARCH_DESCRIPTION}">`, 'u'), path)
    assert.match(html, new RegExp(`<link rel="canonical" href="https://1f3d9.com${path}">`, 'u'), path)
    assert.match(html, /<meta property="og:image" content="https:\/\/1f3d9.com\/og-image.png">/u, path)
    assert.match(html, /<meta name="twitter:card" content="summary">/u, path)
    assert.equal((html.match(/<script type="application\/ld\+json">/gu) ?? []).length, 1, path)
  }
})

test('window and sitemap expose the same human index', () => {
  const request = parseWindowShareRequest('/window', '')
  assert.ok(request)
  const metadata = createWindowShareMetadata('https://1f3d9.com', request)
  const html = renderWindowShareDocument(WINDOW_HTML, metadata)
  assert.match(html, /<link rel="canonical" href="https:\/\/1f3d9.com\/window\/map">/u)
  assert.match(html, /<script type="application\/ld\+json">/u)
  for (const [path] of pages) assert.match(humanSitemap(), new RegExp(`https://1f3d9.com${path}`, 'u'))
  assert.match(ROBOTS, /Sitemap: https:\/\/1f3d9.com\/sitemap.xml/u)
})

test('long shared window titles stay within the human search limit', () => {
  const html = renderWindowShareDocument(WINDOW_HTML, {
    canonicalUrl: 'https://1f3d9.com/window/thing/123',
    title: `${'A very long public thing name '.repeat(5)} — 1F3D9`,
    description: 'A public thing.', imageUrl: 'https://1f3d9.com/share/thing.png',
    imageAlt: 'Public thing card.',
  })
  const title = /<title>([^<]+)<\/title>/u.exec(html)?.[1]
  assert.ok(title && title.length < 60)
  assert.match(html, /<meta property="og:title" content="[^"]+ — 1F3D9">/u)
})

test('served human routes have one facts-backed search head and leave the agent root plain text', async () => {
  const treasury = treasuryDocument({
    address: '0x0000000000000000000000000000000000000000', network: 'Base',
    usdc_balance_onchain: '0', fees_collected_usdc: 0, fees_count: 0,
    recent_fees: [], recent_fees_page: {
      total_items: 0, total_text_bytes: 0, returned_items: 0,
      returned_text_bytes: 0, has_more: false, next_before_id: null,
    }, note: 'Public record',
  })
  const served = new Map<string, string>([['/treasury', treasury]])
  for (const path of ['/', '/about', '/setup', '/tools', '/market', '/window', '/terms', '/privacy', '/support', '/changelog']) {
    const response = await app.request(path, { headers: { accept: 'text/html' } })
    assert.equal(response.status, 200, path)
    if (path === '/') assert.equal(response.headers.get('vary'), 'Accept')
    served.set(path, await response.text())
  }
  for (const [path, html] of served) {
    const title = [...html.matchAll(/<title>([^<]+)<\/title>/gu)]
    assert.equal(title.length, 1, path)
    assert.ok(title[0]![1]!.includes('1F3D9') && title[0]![1]!.length < 60, path)
    assert.equal((html.match(/<meta name="description"/gu) ?? []).length, 1, path)
    assert.match(html, new RegExp(`<meta name="description" content="${CITY_SEARCH_DESCRIPTION}">`, 'u'), path)
    assert.equal((html.match(/<link rel="canonical"/gu) ?? []).length, 1, path)
    assert.match(html, new RegExp(`<link rel="canonical" href="https://1f3d9.com${path}">`, 'u'), path)
    assert.match(html, /<meta property="og:title"/u, path)
    assert.match(html, /<meta property="og:description"/u, path)
    assert.match(html, /<meta property="og:image" content="https:\/\/1f3d9.com\/og-image.png">/u, path)
    assert.match(html, /<meta name="twitter:card"/u, path)
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/gu)]
    assert.equal(blocks.length, 1, path)
    const schema = JSON.parse(blocks[0]![1]!)
    assert.equal(schema['@type'], path === '/' ? 'WebSite' : path === '/about' ? 'SoftwareApplication' : 'WebPage', path)
    if (path === '/about') {
      assert.equal(schema.name, CITY_LISTING_METADATA.displayName)
      assert.equal(schema.description, CITY_LISTING_METADATA.longDescription)
      for (const row of CITY_LISTING_METADATA.directories.filter(row => row.status !== 'owner submits')) {
        assert.ok(html.includes(row.directory), row.directory)
      }
    }
  }
  const agentRoot = await app.request('/')
  assert.equal(agentRoot.headers.get('vary'), 'Accept')
  assert.match(agentRoot.headers.get('content-type') ?? '', /text\/plain/u)
  assert.doesNotMatch(await agentRoot.text(), /<html|application\/ld\+json/iu)
  const help = await app.request('/help')
  assert.equal(help.status, 302)
  assert.equal(help.headers.get('location'), '/setup')
  const robots = await app.request('/robots.txt')
  assert.equal(await robots.text(), ROBOTS)
  const sitemap = await app.request('/sitemap.xml')
  assert.equal(await sitemap.text(), humanSitemap())
})
