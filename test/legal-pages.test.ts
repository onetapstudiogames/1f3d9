import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mountLegalRoutes } from '../src/legal.ts'

test('privacy and support disclosures render to both browsers and text clients', async () => {
  const app = new Hono()
  mountLegalRoutes(app)
  for (const path of ['/privacy', '/support'] as const) {
    const textResponse = await app.request(path, { headers: { accept: 'text/plain' } })
    const htmlResponse = await app.request(path, { headers: { accept: 'text/html' } })
    assert.equal(textResponse.status, 200)
    assert.equal(htmlResponse.status, 200)
    assert.match(htmlResponse.headers.get('content-type') ?? '', /text\/html/iu)
    assert.match(await htmlResponse.text(), /adam@twamd\.com/iu)
    const body = await textResponse.text()
    assert.match(body, /adam@twamd\.com/iu)
    if (path === '/privacy') {
      assert.match(body, /90-day artifact/iu)
      assert.match(body, /actual deletion has\s+not been independently verified/iu)
    } else assert.match(body, /report a security issue privately/iu)
  }
})
