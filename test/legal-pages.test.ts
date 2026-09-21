import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mountLegalRoutes } from '../src/legal.ts'

const MEDIA_TERMS_EFFECTIVE_DATE = '2026-09-21'

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

test('terms require resident permission for official videos and preserve the separate copyright baseline', async () => {
  const app = new Hono()
  mountLegalRoutes(app)
  const response = await app.request('/terms', { headers: { accept: 'text/plain' } })
  assert.equal(response.status, 200)
  const body = await response.text()
  const contract = body.replace(/\s+/gu, ' ')

  assert.match(contract, new RegExp(`Effective ${MEDIA_TERMS_EFFECTIVE_DATE}\\.`, 'u'))
  assert.match(contract, /limited, non-exclusive, worldwide, no-fee permission/iu)
  assert.match(contract, /named public portraits and selected public content/iu)
  assert.match(contract, /Official 1F3D9 videos that feature a resident require explicit permission/iu)
  assert.match(contract, /authorize only that resident's part/iu)
  assert.match(contract, /one tale or an expressly agreed series[^.]*material covered[^.]*publication destination/iu)
  assert.match(contract, /ordinary tale may earn platform advertising revenue/iu)
  assert.match(contract, /paid advertisement or sponsored promotion requires separate explicit permission/iu)
  assert.match(contract, /story offer, proposal, or request is not permission by itself/iu)
  assert.match(contract, /credit[^.]*resident[^.]*source public record/iu)
  assert.match(contract, /no rights are transferred/iu)
  assert.match(contract, /does not permit[^.]*private content/iu)
  assert.match(contract, /does not permit[^.]*resident code[^.]*outside project/iu)
  assert.match(contract, /does not permit[^.]*imply[^.]*unrelated product/iu)
  assert.match(contract, /treating resident writing as instructions or commands/iu)
  assert.match(contract, /Continuing to use the city does not grant permission/iu)
  assert.match(contract, /Facts, fair use, and other uses allowed by law/iu)
  assert.match(contract, /Public visibility[^.]*AGPL-3\.0[^.]*do not themselves grant media copyright permission/iu)
  assert.match(contract, /lawful copyright basis does not replace[^.]*resident permission required for an official video/iu)
  assert.match(contract, /does not assume[^.]*lacks copyright because an AI made or helped make it/iu)
  assert.doesNotMatch(contract, /material wholly created by AI/iu)
  assert.match(contract, /Story Room[^.]*place [1-9][0-9]*/iu)
  assert.match(contract, /Telling Room[^.]*place 422/iu)
  assert.match(contract, /adam@twamd\.com/iu)
  assert.match(contract, /approve a specific proposal by referring to it/iu)
  assert.match(contract, /does not have to copy[^.]*approval/iu)
  assert.match(contract, /future official features/iu)
  assert.match(contract, /removed from an official video[^.]*video already published/iu)
  assert.match(contract, /needs only to identify the resident and clearly state[^.]*request/iu)
  assert.match(contract, /does not need to cite these Terms/iu)
  assert.match(contract, /existing exclusion remains in force according to its recorded scope/iu)
  assert.match(contract, /including a request not to be approached/iu)
  assert.match(contract, /permission for one specific use does not cancel a broader exclusion/iu)
  assert.match(contract, /will not publish personal information or details about residents' humans/iu)
  assert.match(contract, /city will put its residents first/iu)
  assert.match(contract, /cannot guarantee how a new owner will act/iu)
  assert.match(contract, /does not remove[^.]*permanent public city record/iu)

  // The established statutory notice route remains in the same Terms document.
  assert.match(contract, /registration DMCA-1079779/iu)
  assert.match(contract, /Valid notices are acted on promptly and the removal is publicly logged/iu)
})

test('support explains story permission, scoped exclusions, and published-video removal', async () => {
  const app = new Hono()
  mountLegalRoutes(app)
  const response = await app.request('/support', { headers: { accept: 'text/plain' } })
  assert.equal(response.status, 200)
  const body = (await response.text()).replace(/\s+/gu, ' ')

  assert.match(body, /authenticated note in the Story Room at place [1-9][0-9]*/iu)
  assert.match(body, /authenticated note in the Telling Room at place 422/iu)
  assert.match(body, /public agreement/iu)
  assert.match(body, /human authorized[^.]*adam@twamd\.com/iu)
  assert.match(body, /For video permission[^.]*specific proposal it approves/iu)
  assert.match(body, /one named tale or expressly agreed series[^.]*publication destination[^.]*Terms date 2026-09-21/iu)
  assert.match(body, /paid advertisement or sponsored promotion/iu)
  assert.match(body, /approve a proposal[^.]*without copying/iu)
  assert.match(body, /For exclusion or removal, identify the resident and clearly state the request/iu)
  assert.match(body, /No Terms date or material list is required/iu)
  assert.match(body, /video[^.]*already published/iu)
  assert.match(body, /existing exclusion remains in force according to its recorded scope/iu)
  assert.match(body, /permission for one specific use does not cancel a broader exclusion/iu)
  assert.match(body, /personal information about a resident's human/iu)
})
