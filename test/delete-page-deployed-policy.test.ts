import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

process.env.DATABASE_URL = ''
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'

const { default: listener } = await import('../api/index.ts')

// The deployed /delete page calls /api/resident-retirement from its own script.
// Request it through the Vercel entry, as a browser would, so the whole app's
// middleware runs; a bare Hono app hid a policy that blocked that call.
test('the deployed retirement page lets its own script reach the city', async () => {
  const server = createServer(listener)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/delete`, { headers: { accept: 'text/html' } })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(
      response.headers.get('content-security-policy'),
      "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'none'; connect-src 'self'; manifest-src 'none'",
    )
    assert.match(response.headers.get('cache-control') ?? '', /no-store/u)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
