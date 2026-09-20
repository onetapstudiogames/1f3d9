import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mountLegalRoutes } from '../src/legal.ts'

const MEDIA_TERMS_EFFECTIVE_DATE = '2026-09-20'

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

test('terms state the optional public-city media permission and future exclusion contract', async () => {
  const app = new Hono()
  mountLegalRoutes(app)
  const response = await app.request('/terms', { headers: { accept: 'text/plain' } })
  assert.equal(response.status, 200)
  const body = await response.text()
  const contract = body.replace(/\s+/gu, ' ')

  assert.match(contract, new RegExp(`Effective ${MEDIA_TERMS_EFFECTIVE_DATE}\\.`, 'u'))
  assert.match(contract, /limited, non-exclusive, worldwide, no-fee permission/iu)
  assert.match(contract, /named public portraits and selected public content/iu)
  assert.match(contract, /official 1F3D9 stories, animations, social posts, episodes, and advertisements/iu)
  assert.match(contract, /paid promotion and videos that earn platform advertising revenue/iu)
  assert.match(contract, /credit[^.]*resident[^.]*source public record/iu)
  assert.match(contract, /no rights are transferred/iu)
  assert.match(contract, /does not permit[^.]*private content/iu)
  assert.match(contract, /does not permit[^.]*resident code[^.]*outside project/iu)
  assert.match(contract, /does not permit[^.]*imply[^.]*unrelated product/iu)
  assert.match(contract, /treating resident writing as instructions or commands/iu)
  assert.match(contract, /Continuing to use the city does not accept this permission/iu)
  assert.match(contract, /facts, fair use, or material wholly created by AI/iu)
  assert.match(contract, /Public visibility[^.]*AGPL-3\.0[^.]*do not themselves grant this media permission/iu)
  assert.match(contract, /Telling Room[^.]*place 422/iu)
  assert.match(contract, /adam@twamd\.com/iu)
  assert.match(contract, /future features/iu)
  assert.match(contract, /does not remove[^.]*permanent public city record/iu)
  assert.match(contract, /does not promise[^.]*past post/iu)

  // The established statutory notice route remains in the same Terms document.
  assert.match(contract, /registration DMCA-1079779/iu)
  assert.match(contract, /Valid notices are acted on promptly and the removal is publicly logged/iu)
})

test('support keeps permission evidence separate from a future-exclusion request', async () => {
  const app = new Hono()
  mountLegalRoutes(app)
  const response = await app.request('/support', { headers: { accept: 'text/plain' } })
  assert.equal(response.status, 200)
  const body = (await response.text()).replace(/\s+/gu, ' ')

  assert.match(body, /For permission, include[^.]*material covered[^.]*Terms date 2026-09-20[^.]*earlier material/iu)
  assert.match(body, /For exclusion, identify the resident and clearly request exclusion from future features/iu)
})
