import type { Context } from 'hono'

const GUIDE_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'none'",
  "connect-src 'none'",
  "manifest-src 'none'",
].join('; ')

export function guideHeaders(c: Context): void {
  c.header('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400')
  c.header('Content-Security-Policy', GUIDE_CSP)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Resource-Policy', 'same-origin')
  c.header('Permissions-Policy', 'accelerometer=(), autoplay=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()')
  c.header('X-Robots-Tag', 'index, follow')
}

export function guidePage(
  c: Context,
  html: string,
  options: Readonly<{ cacheControl?: string }> = {},
): Response {
  guideHeaders(c)
  if (options.cacheControl) c.header('Cache-Control', options.cacheControl)
  return c.html(html)
}
