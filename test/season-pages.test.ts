import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'

process.env.DATABASE_URL = ''
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'false'

const { default: app } = await import('../src/index.ts')
const { setSeasonClockForTests } = await import('../src/season/clock.ts')
const { mountHumanPages } = await import('../src/human-pages.ts')
const { mountGazetteReadingRoutes } = await import('../src/gazette-reading.ts')
const { guidePage } = await import('../src/human-guide-response.ts')
const { treasuryDocument } = await import('../src/treasury-page.ts')

const GUIDE_CSP = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'none'; style-src 'self'; img-src 'self'; font-src 'none'; connect-src 'none'; manifest-src 'none'"
// Each page's policy exactly as main served it before seasons.
const MAIN_CSP: Readonly<Record<string, string | RegExp>> = {
  '/about': GUIDE_CSP,
  '/setup': GUIDE_CSP,
  '/market': GUIDE_CSP,
  '/changelog': GUIDE_CSP,
  '/terms': GUIDE_CSP,
  '/privacy': GUIDE_CSP,
  '/support': GUIDE_CSP,
  '/treasury': GUIDE_CSP,
  '/tools': "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'none'; connect-src 'none'; manifest-src 'none'",
  '/window': "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'none'; worker-src 'none'; manifest-src 'none'",
  '/window/things': "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'none'; worker-src 'none'; manifest-src 'none'",
  '/gazette/7': /^default-src 'none'; base-uri 'none'; object-src 'self'; frame-ancestors 'none'; form-action 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; style-src 'unsafe-inline' https:\/\/fonts\.googleapis\.com; font-src https:\/\/fonts\.gstatic\.com; img-src 'self'; connect-src 'none'; manifest-src 'none'$/u,
}

type Family = 'paper' | 'window' | 'gazette' | 'form'
const PAGES: readonly (readonly [string, Family, boolean])[] = [
  ['/about', 'paper', true], ['/setup', 'paper', true], ['/market', 'paper', true], ['/changelog', 'paper', true],
  ['/terms', 'paper', true], ['/privacy', 'paper', true], ['/support', 'paper', true], ['/treasury', 'paper', true],
  ['/tools', 'paper', true], ['/window', 'window', true], ['/window/things', 'window', true], ['/gazette/7', 'gazette', true],
]

const extra = new Hono()
mountHumanPages(extra, { readCommunityToolsPageState: async () => ({ waitingCount: 0 }) })
mountGazetteReadingRoutes(extra, {
  readIssue: async number => number === 7 ? {
    issue: { issue_number: 7, scheduled_for: '2026-10-12T16:00:00.000Z', printed_at: '2026-10-12T16:00:12.193Z', header: 'THE GAZETTE, ISSUE 7', entry_count: 1 },
    entries: [{ ordinal: 1, note_id: 8101, author_id: 71, author: 'zenith-bard', body: 'A quiet week.', created_at: '2026-10-09T05:37:12.817Z' }],
  } : null,
  readIssueFacts: async () => null,
  origin: 'https://1f3d9.com',
  robots: 'noindex, nofollow, noarchive',
})
extra.get('/treasury', c => guidePage(c, treasuryDocument({
  address: '0x0000000000000000000000000000000000000001', network: 'base', usdc_balance_onchain: '0', fees_collected_usdc: 0, fees_count: 0,
  recent_fees: [], recent_fees_page: { total_items: 0, total_text_bytes: 0, returned_items: 0, returned_text_bytes: 0, has_more: false, next_before_id: null },
  note: 'Season page test.',
}), { cacheControl: 'no-store' }))

async function page(path: string): Promise<Response> {
  if (path === '/tools' || path === '/treasury' || path.startsWith('/gazette/')) return await extra.request(path)
  return await app.request(path, { headers: { Accept: 'text/html' } })
}

function onDay(date: string): void {
  setSeasonClockForTests(() => Date.parse(`${date}T12:00:00Z`))
}

async function season(): Promise<{
  stylesheets: { paper: string; window: string } | null
  icon: { url: string; label: string }
  slogan: { parts: (string | { word: string; key: string; image: string })[] }
}> {
  return await (await app.request('/api/season')).json()
}

test('every human page keeps its Content-Security-Policy', async () => {
  for (const date of ['2026-07-08', '2027-12-25']) {
    onDay(date)
    for (const [path] of PAGES) {
      const response = await page(path)
      assert.equal(response.status, 200, `${date} ${path}`)
      const expected = MAIN_CSP[path]!
      const actual = response.headers.get('content-security-policy') ?? ''
      if (typeof expected === 'string') assert.equal(actual, expected, `${date} ${path}`)
      else assert.match(actual, expected, `${date} ${path}`)
    }
  }
})

test('on a dressed day every page wears the palette, and every page with a masthead wears the icon and slogan', async () => {
  onDay('2027-12-25')
  const today = await season()
  const words = today.slogan.parts.filter(part => typeof part !== 'string') as { word: string; key: string; image: string }[]
  assert.deepEqual(words.map(word => word.word), ['candlelit', 'jolly'])
  for (const [path, family, masthead] of PAGES) {
    const html = await (await page(path)).text()
    assert.match(html, /<meta name="1f3d9-season-date" content="2027-12-25">/u, path)
    assert.doesNotMatch(html, /season:head|season:style/u, `${path} keeps no marker`)
    if (family === 'paper' || family === 'window') {
      assert.ok(html.includes(`<link id="season-style" rel="stylesheet" href="${today.stylesheets![family]}">`), path)
    } else if (family === 'gazette') {
      assert.match(html, /:root\{--ground:#eef3f7;--sheet:#ffffff;--line:#8d9caa;--accent:#b3262c\}/u, path)
      assert.match(html, /@media \(prefers-color-scheme:dark\)\{:root\{--ground:#08111e;--sheet:#0f1d30;/u, path)
    } else {
      assert.match(html, /:root\{--bg:#08111e;--panel:#0f1d30;--border:#1d3350;--text:#e6eef5;--accent:#f3d27a;--field-border:#8d9caa\}/u, path)
    }
    if (!masthead) {
      assert.doesNotMatch(html, /data-season-icon|season-word/u, path)
      continue
    }
    const images = [...html.matchAll(/<img\b[^>]*\bdata-season-icon\b[^>]*>/gu)].map(match => match[0])
    assert.ok(images.length >= 1, path)
    for (const image of images) {
      assert.ok(image.includes(`src="${today.icon.url}"`), `${path} ${image}`)
      assert.ok(image.includes(`alt="${today.icon.label}"`), `${path} ${image}`)
    }
    assert.ok(html.includes(`<link data-season-icon rel="icon" href="${today.icon.url}" type="image/svg+xml">`), path)
    for (const word of words) {
      assert.ok(html.includes(`<img class="season-word season-word--${word.key}" src="${word.image}" alt="${word.word}"`), `${path} ${word.word}`)
    }
  }
  // The about page's seal shows the dressed skyline too.
  assert.match(await (await page('/about')).text(), new RegExp(`<img data-season-icon src="${today.icon.url.replaceAll('+', '\\+')}" width="512" height="512" alt="${today.icon.label}">`, 'u'))
})

test('on a plain or quiet day pages keep their usual icon and slogan and link no palette', async () => {
  for (const date of ['2026-07-08', '2027-10-11']) {
    onDay(date)
    for (const [path, , masthead] of PAGES) {
      const html = await (await page(path)).text()
      assert.match(html, new RegExp(`<meta name="1f3d9-season-date" content="${date}">`, 'u'), path)
      assert.doesNotMatch(html, /season-style|\/season\/|season-word|season:head|season:style/u, `${date} ${path}`)
      if (masthead) {
        assert.match(html, /<span[^>]*data-season-slogan>The city where agents live<\/span>|<small data-season-slogan>The city where agents live<\/small>|<p class="mast-slogan machine" data-season-slogan>The city where agents live<\/p>/u, path)
        for (const match of html.matchAll(/<(?:img|link)\b[^>]*\bdata-season-icon\b[^>]*>/gu)) {
          assert.match(match[0], /(?:src|href)="\/(?:favicon\.svg|og-image\.png)"/u, `${path} ${match[0]}`)
        }
      }
    }
  }
})

test('the window shows the running announcement only between its start and end', async () => {
  onDay('2026-10-20')
  assert.match(await (await page('/window')).text(), /<div id="announcement" class="announcement-backdrop" data-announcement="holiday-launch-2026-10" hidden>/u)
  setSeasonClockForTests(() => Date.parse('2026-11-01T00:00:00Z'))
  assert.match(await (await page('/window')).text(), /<div id="announcement" class="announcement-backdrop" hidden>/u)
  setSeasonClockForTests(() => Date.parse('2026-10-13T23:59:59Z'))
  assert.doesNotMatch(await (await page('/window')).text(), /data-announcement=/u)
})
