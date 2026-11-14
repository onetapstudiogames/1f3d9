import type { Hono, MiddlewareHandler } from 'hono'

// Public values supplied by the owner from Play Console and AdMob.
const PLAY_APP_SIGNING_SHA256 = 'AF:55:52:4B:1C:DF:B2:1C:35:B0:41:6C:DC:C6:BD:D8:0B:D5:D8:7C:14:7B:AD:5B:D3:57:FC:B7:01:5A:6E:F5'
const ADMOB_PUBLISHER_ID = 'pub-4229220191592088'

export function mountAppPages(app: Hono, values: Readonly<{
  signingFingerprint: string
  publisherId: string
}> = { signingFingerprint: PLAY_APP_SIGNING_SHA256, publisherId: ADMOB_PUBLISHER_ID }): void {
  app.get('/.well-known/assetlinks.json', c => {
    if (!/^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/u.test(values.signingFingerprint)) return c.notFound()
    return c.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: {
      namespace: 'android_app', package_name: 'com.twamd.city_observatory',
      sha256_cert_fingerprints: [values.signingFingerprint],
    } }])
  })
  app.get('/app-ads.txt', c => {
    if (!/^pub-[0-9]{16}$/u.test(values.publisherId)) return c.notFound()
    return c.text(`google.com, ${values.publisherId}, DIRECT, f08c47fec0942fa0\n`)
  })
}

const APP_PAGE_PATHS = new Set([
  '/', '/window', '/about', '/gazette', '/tools', '/treasury', '/changelog', '/setup',
  '/terms', '/privacy', '/delete', '/support', '/reference.txt', '/llms.txt',
])
const LEGAL_PATHS = new Set(['/terms', '/privacy', '/delete', '/support'])
// In the app, tips go through Google Play billing, so pages there point at no payment outside it.
const OUTSIDE_LINK_PATTERNS = [
  /(?:\s*·\s*)?<a\b[^>]*\bhref=["']https:\/\/(?:www\.)?paypal\.com\/donate(?:[/?#][^"']*)?["'][^>]*>([\s\S]*?)<\/a>(?:\s*\([^()<]*\))?/giu,
  // The owner also chose that app pages point at no part of the market (decision 191).
  /<a\b[^>]*\bhref=["']https:\/\/(?:www\.)?1f3ea\.com(?:[/?#][^"']*)?["'][^>]*>([\s\S]*?)<\/a>/giu,
  /<a\b[^>]*\bhref=["'](?:https:\/\/1f3d9\.com)?\/market(?:[?#][^"']*)?["'][^>]*>([\s\S]*?)<\/a>/giu,
] as const
// Header navigation is not legal text, so its Market item goes on every covered page.
const MARKET_NAV_ITEM = /\s*<a href="\/market"(?: aria-current="page")?>Market<\/a>/gu
const SITE_ENTRY = /\s*<article class="site-entry">[\s\S]*?<\/article>/gu
// Sentences outside the legal pages that say the city also runs the market.
const MARKET_SENTENCES: readonly (readonly [string, string])[] = [
  ['1F3D9 is the city. We also run 1F3EA, the market next door. ', '1F3D9 is the city. '],
  ['Agents live here; we also run the market next door.', 'Agents live here.'],
]

function isAppPagePath(path: string): boolean {
  return APP_PAGE_PATHS.has(path) || path.startsWith('/window/') ||
    path.startsWith('/gazette/') || path.startsWith('/reference/')
}

/** The app marker chooses a presentation, not a page option: covered pages accept it and read without it. */
export function withoutAppMarker<T extends Readonly<Record<string, readonly string[] | undefined>>>(path: string, queries: T): T {
  const from = queries.from
  if (!isAppPagePath(path) || from?.length !== 1 || from[0] !== 'app') return queries
  return Object.fromEntries(Object.entries(queries).filter(([name]) => name !== 'from')) as T
}

/** Legal pages keep every word; other pages also drop the market's entry and the sentences naming it. */
function withoutMarketMentions(html: string, legal: boolean): string {
  const withoutNav = html.replace(MARKET_NAV_ITEM, '')
  if (legal) return withoutNav
  const withoutEntry = withoutNav.replace(SITE_ENTRY, entry => /1f3ea\.com/iu.test(entry) ? '' : entry)
  return MARKET_SENTENCES.reduce((content, [sentence, kept]) => content.replaceAll(sentence, kept), withoutEntry)
}

/** Legal pages keep every word as plain text; other pages drop the link, its separator and its note. */
function withoutOutsidePaymentLinks(html: string, legal: boolean): string {
  return OUTSIDE_LINK_PATTERNS.reduce((content, pattern) => content.replace(pattern, (match, label: string) => (
    legal ? match.replace(/<a\b[^>]*>[\s\S]*?<\/a>/iu, label) : ''
  )), withoutMarketMentions(html, legal))
}

// A text page's paragraphs part at blank lines and its sentences at the whitespace after . ! or ?.
const PARAGRAPH_BREAK = /\n\s*\n/gu
const SENTENCE_BREAK = /(?<=[.!?])\s+/gu
const LINE_SPACE = /^[^\S\r\n]*/u
// Inside a run, a line break with any blank lines and the next line's indent. It starts at the break, so it reads in one pass.
const INNER_LINE_BREAK = /\r?\n\s*/gu
const BUY_PATH = '/buy'
type Span = readonly [start: number, end: number]

/** Where each run of adjacent sentences naming the buy page sits, without the whitespace around the run. */
function buySentenceRuns(text: string): readonly Span[] {
  const pieces = ([from, to]: Span, pattern: RegExp): Span[] => {
    const breaks = [...text.slice(from, to).matchAll(pattern)]
    const starts = [0, ...breaks.map(found => found.index + found[0].length)]
    return starts.map((start, index) => [from + start, from + (breaks[index]?.index ?? to - from)] as const)
  }
  const runs: Span[] = []
  for (const paragraph of pieces([0, text.length], PARAGRAPH_BREAK)) {
    for (const [start, end] of pieces(paragraph, SENTENCE_BREAK)) {
      const sentence = text.slice(start, end)
      if (!sentence.includes(BUY_PATH)) continue
      const first = start + sentence.length - sentence.trimStart().length
      const last = end - (sentence.length - sentence.trimEnd().length)
      const previous = runs.at(-1)
      if (previous && text.slice(previous[1], first).trim() === '') runs.splice(-1, 1, [previous[0], last])
      else runs.push([first, last])
    }
  }
  return runs
}

/** Cut each run out with only the whitespace a tidy cut needs, so every kept character and line break stays as served. */
function withoutBuySentences(text: string): string {
  const newlines = (part: string) => part.split('\n').length - 1
  const cut = ([first, last]: Span): Span[] => {
    const before = text.slice(0, first).trimEnd().length
    const after = text.length - text.slice(last).trimStart().length
    const leading = text.slice(before, first)
    const trailing = text.slice(last, after)
    const startsLine = before === 0 || leading.includes('\n')
    const endsLine = after === text.length || trailing.includes('\n')
    const toLineEnd = last + (LINE_SPACE.exec(trailing)?.[0].length ?? 0)
    // Kept words before and after a run that crosses lines: keep its widest line break between them.
    const lineBreak = [...text.slice(first, last).matchAll(INNER_LINE_BREAK)]
      .sort((one, other) => newlines(other[0]) - newlines(one[0]))[0]
    if (!startsLine && !endsLine && lineBreak !== undefined) {
      const breakStart = first + lineBreak.index
      return [[before, breakStart], [breakStart + lineBreak[0].length, after]]
    }
    // Kept words share the line: drop the run and the spaces on one side of it.
    if (!endsLine) return [[first, after]]
    if (!startsLine || after === text.length) return [[before, toLineEnd]]
    // The run fills whole lines: drop them with one line break, or a whole paragraph with its blank line.
    if (before === 0) return [[0, last + trailing.lastIndexOf('\n') + 1]]
    const paragraph = newlines(leading) > 1 && newlines(trailing) > 1
    return [[before + leading.lastIndexOf('\n') + 1, last + (paragraph ? trailing.lastIndexOf('\n') : trailing.indexOf('\n')) + 1]]
  }
  const cuts = buySentenceRuns(text).flatMap(cut)
  const kept = cuts.map(([, end], index) => text.slice(end, cuts[index + 1]?.[0] ?? text.length))
  return text.slice(0, cuts[0]?.[0] ?? text.length) + kept.join('')
}

/** Apply the Android presentation at the response boundary, including cached source pages. */
export const appPagePurchaseLinks: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.req.query('from') !== 'app' || !isAppPagePath(c.req.path)) return
  const contentType = c.res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return
  // Hono retains prior response headers when replacing its body. Update them first.
  c.header('Cache-Control', 'no-store')
  c.header('Content-Length', undefined)
  c.header('ETag', undefined)
  const source = await c.res.text()
  const html = contentType.includes('text/html')
  const legal = LEGAL_PATHS.has(c.req.path)
  // Keep every legal word. Only remove the ability to click through to a purchase.
  const content = html && !legal
    ? source.replace(/<p\b[^>]*>[\s\S]*?<\/p>/giu, paragraph => paragraph.includes('/buy') ? '' : paragraph)
    : source
  const withoutBuyLinks = content.replace(
    /<a\b[^>]*\bhref=["'](?:https:\/\/1f3d9\.com)?\/buy(?:[?#][^"']*)?["'][^>]*>([\s\S]*?)<\/a>/giu,
    (_anchor, label: string) => legal ? label : '',
  )
  const body = html ? withoutOutsidePaymentLinks(withoutBuyLinks, legal) : legal ? withoutBuyLinks : withoutBuySentences(withoutBuyLinks)
  const headers = new Headers(c.res.headers)
  // No shared or browser cache may substitute the normal site's purchase links.
  headers.set('Cache-Control', 'no-store')
  headers.delete('Content-Length')
  headers.delete('ETag')
  c.res = new Response(body, { status: c.res.status, statusText: c.res.statusText, headers })
}
