import type { Context } from 'hono'

export function trustedBrowserForm(c: Context, publicOrigin: string): boolean {
  const requestOrigin = c.req.header('origin')
  if (requestOrigin && requestOrigin !== 'null') return requestOrigin === publicOrigin

  const referer = c.req.header('referer')
  if (!referer) return trustedFetchMetadata(c)
  try {
    return new URL(referer).origin === publicOrigin
  } catch {
    return false
  }
}

function trustedFetchMetadata(c: Context): boolean {
  return c.req.header('sec-fetch-site') === 'same-origin'
    && c.req.header('sec-fetch-mode') === 'navigate'
    && c.req.header('sec-fetch-dest') === 'document'
}
