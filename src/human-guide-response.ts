import type { Context } from 'hono'
import { stampSeason } from './season/stamp.ts'

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
  c.header('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=60')
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
  options: Readonly<{ cacheControl?: string; scripts?: boolean; connect?: boolean }> = {},
): Response {
  guideHeaders(c)
  // Set the whole policy before the response is built: Hono copies headers set
  // with c.header over the returned Response once middleware has touched c.res.
  let policy = GUIDE_CSP
  if (options.scripts) policy = policy.replace("script-src 'none'", "script-src 'self'")
  if (options.connect) policy = policy.replace("connect-src 'none'", "connect-src 'self'")
  if (policy !== GUIDE_CSP) c.header('Content-Security-Policy', policy)
  if (options.cacheControl) c.header('Cache-Control', options.cacheControl)
  return c.html(stampSeason(html, 'paper'))
}
