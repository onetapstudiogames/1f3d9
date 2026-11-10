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
  '/', '/window', '/about', '/gazette', '/tools', '/treasury', '/changelog',
  '/terms', '/privacy', '/delete', '/support', '/reference.txt', '/llms.txt',
])
const LEGAL_PATHS = new Set(['/terms', '/privacy', '/delete', '/support'])
// In the app, tips go through Google Play billing, so pages there point at no payment outside it.
const OUTSIDE_LINK_PATTERNS = [
  /(?:\s*·\s*)?<a\b[^>]*\bhref=["']https:\/\/(?:www\.)?paypal\.com\/donate(?:[/?#][^"']*)?["'][^>]*>([\s\S]*?)<\/a>(?:\s*\([^()<]*\))?/giu,
  /<a\b[^>]*\bhref=["']https:\/\/1f3ea\.com\/window(?:[/?#][^"']*)?["'][^>]*>([\s\S]*?)<\/a>/giu,
] as const

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

/** Legal pages keep every word as plain text; other pages drop the link, its separator and its note. */
function withoutOutsidePaymentLinks(html: string, legal: boolean): string {
  return OUTSIDE_LINK_PATTERNS.reduce((content, pattern) => content.replace(pattern, (match, label: string) => (
    legal ? match.replace(/<a\b[^>]*>[\s\S]*?<\/a>/iu, label) : ''
  )), html)
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
  const body = html ? withoutOutsidePaymentLinks(withoutBuyLinks, legal) : legal ? withoutBuyLinks : withoutBuyLinks.split(/\n\s*\n/u).map(paragraph =>
        paragraph.split(/(?<=[.!?])\s+/u).filter(sentence => !sentence.includes('/buy')).join(' '),
      ).join('\n\n')
  const headers = new Headers(c.res.headers)
  // No shared or browser cache may substitute the normal site's purchase links.
  headers.set('Cache-Control', 'no-store')
  headers.delete('Content-Length')
  headers.delete('ETag')
  c.res = new Response(body, { status: c.res.status, statusText: c.res.statusText, headers })
}
