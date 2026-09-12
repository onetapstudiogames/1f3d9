import { randomUUID } from 'node:crypto'
import { createServer } from 'node:https'
import { getRequestListener } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { auth, setOAuthResidentResolver } from '../src/core.ts'
import { mcp } from '../src/mcp.ts'
import { mountIdentityRoutes } from '../src/identity-browser.ts'
import { mountOAuthRoutes, oauthChallenge, residentByOAuthAccessToken } from '../src/oauth.ts'
import { mountHumanPages } from '../src/human-pages.ts'
import {
  CREDIT_BUY_CSS,
  CREDIT_BUY_JS,
  renderCreditBuyPage,
} from '../src/credit-buy-page.ts'
import {
  CREDIT_GIFT_REDIRECT_PAGE_CSS,
  CREDIT_GIFT_REDIRECT_PAGE_JS,
  renderCreditGiftRedirectPage,
} from '../src/credit-gift-redirect.ts'
import { mountGazetteReadingRoutes } from '../src/gazette-reading.ts'
import { windowPage, windowScript, windowShareImage, windowStyle } from '../src/window.ts'
import type { WindowShareDetail } from '../src/window-sharing.ts'
import { makeMemoryStore } from './helpers/oauth-test-server/memory-store.ts'
import { makeIdentityStore } from './helpers/oauth-test-server/identity-store.ts'
import { makeCertificate } from './helpers/oauth-test-server/certificate.ts'
import { publicPlaceShareRecord, publicThingShareRecord, publicNoteShareRecord, publicWindowFixture, transparentDrawingThumbnail, followedResidentContextNotes, olderPublicEvents } from './helpers/oauth-test-server/public-window-fixtures.ts'
import { gazetteReadingIssue, gazetteReadingEntries, gazetteReadingFacts } from './helpers/oauth-test-server/gazette-fixtures.ts'
import { creditPurchaseId, creditGiftId, creditClaimToken } from './helpers/oauth-test-server/credit-fixtures.ts'

const port = Number(process.env.E2E_PORT ?? 41_739)
const origin = `https://127.0.0.1:${port}`
const callbackUri = `https://localhost:${port}/oauth/callback`

interface PublicWindowObservationState {
  readonly write_requests: ReadonlyArray<{ readonly method: string; readonly path: string }>
  readonly detail_requests: ReadonlyArray<{
    readonly path: string
    readonly has_authorization: boolean
    readonly has_cookie: boolean
  }>
  readonly event_queries: ReadonlyArray<{
    readonly before_id: number | null
    readonly limit: number
    readonly within_place_id: number | null
  }>
}

let publicWindowObservations: PublicWindowObservationState = {
  write_requests: [],
  detail_requests: [],
  event_queries: [],
}

const environment = {
  COMMUNITY_TOOL_IP_HASH_KEY: '12'.repeat(32),
  HOSTED_CHAT_SIGNIN_ENABLED: 'true',
  IDENTITY_RECOVERY_ENABLED: 'true',
  IDENTITY_ROTATION_ENABLED: 'true',
  PUBLIC_ORIGIN: origin,
  VERCEL: '1',
  VERCEL_ENV: 'preview',
  HOSTED_CHAT_OAUTH_CLIENTS: JSON.stringify([{
    client_id: 'browser-e2e-client',
    client_name: 'Hosted Chat Browser Test',
    redirect_uris: [callbackUri],
  }]),
}

process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
process.env.PUBLIC_ORIGIN = origin

const app = new Hono()

function readPublicWindowShareRecord(detail: WindowShareDetail): Promise<unknown | null> {
  const record = detail.kind === 'place' && detail.id === publicPlaceShareRecord.id
    ? publicPlaceShareRecord
    : detail.kind === 'thing' && detail.id === publicThingShareRecord.id
      ? publicThingShareRecord
      : detail.kind === 'note' && detail.id === publicNoteShareRecord.id
        ? publicNoteShareRecord
        : null
  return Promise.resolve(record)
}

function renderPublicWindowPage(c: Context): Promise<Response> {
  return windowPage(c, c.req.header('X-E2E-Credit-Ready') === 'true', readPublicWindowShareRecord, environment)
}
const store = makeMemoryStore()

mountIdentityRoutes(app, {
  environment,
  hostedChatSigninReady: true,
  store: makeIdentityStore(),
})
app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    publicWindowObservations = {
      ...publicWindowObservations,
      write_requests: [...publicWindowObservations.write_requests, {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
      }],
    }
  }
  await next()
})
mountOAuthRoutes(app, { environment, store })
setOAuthResidentResolver(token => residentByOAuthAccessToken(token, environment, store))

let communityToolWaitingCount = 7
let communityToolAttempts = new Map<string, number>()
const communityToolsPageState = async () => ({
  waitingCount: communityToolWaitingCount,
  residents: Object.freeze([
    Object.freeze({ id: 46, handle: 'solward' }),
    Object.freeze({ id: 49, handle: 'browser-resident' }),
  ]),
})
const submitCommunityToolForBrowserTest = async (
  submission: { residentHandle: string | null; operator: string },
  ipHash: string,
) => {
  if (submission.operator === 'Force storage refusal') throw new Error('e2e storage refusal')
  if (submission.residentHandle !== null && !['solward', 'browser-resident'].includes(submission.residentHandle)) {
    return { outcome: 'resident_not_found' as const }
  }
  const used = communityToolAttempts.get(ipHash) ?? 0
  if (used >= 3) return { outcome: 'rate_limited' as const }
  communityToolAttempts = new Map(communityToolAttempts).set(ipHash, used + 1)
  communityToolWaitingCount += 1
  return { outcome: 'queued' as const }
}

const featureOffHumanPages = new Hono()
mountHumanPages(featureOffHumanPages, {
  environment,
  hostedChatSigninReady: () => false,
  publicOrigin: origin,
  readCommunityToolsPageState: communityToolsPageState,
  submitCommunityTool: submitCommunityToolForBrowserTest,
})
app.route('/feature-off', featureOffHumanPages)
mountHumanPages(app, {
  environment,
  hostedChatSigninReady: () => true,
  publicOrigin: origin,
  readCommunityToolsPageState: communityToolsPageState,
  submitCommunityTool: submitCommunityToolForBrowserTest,
})
mountGazetteReadingRoutes(app, {
  readIssue: async issueNumber => issueNumber === gazetteReadingIssue.issue_number
    ? { issue: gazetteReadingIssue, entries: gazetteReadingEntries }
    : null,
  readIssueFacts: async issueNumber => issueNumber === gazetteReadingIssue.issue_number
    ? gazetteReadingFacts
    : null,
  origin,
  robots: 'noindex, nofollow, noarchive',
})
app.get('/buy', c => {
  c.header('Cache-Control', 'no-store')
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
  return c.html(renderCreditBuyPage({ weeklyAllowanceEnabled: true }))
})
app.get('/buy.css', c => {
  c.header('Cache-Control', 'no-store')
  return c.body(CREDIT_BUY_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' })
})
app.get('/buy.js', c => {
  c.header('Cache-Control', 'no-store')
  return c.body(CREDIT_BUY_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
})
app.get('/gift-redirect', c => {
  c.header('Cache-Control', 'no-store')
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
  return c.html(renderCreditGiftRedirectPage())
})
app.get('/gift-redirect.css', c => {
  c.header('Cache-Control', 'no-store')
  return c.body(CREDIT_GIFT_REDIRECT_PAGE_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' })
})
app.get('/gift-redirect.js', c => {
  c.header('Cache-Control', 'no-store')
  return c.body(CREDIT_GIFT_REDIRECT_PAGE_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
})
app.get('/window', renderPublicWindowPage)
app.get('/window/:view', renderPublicWindowPage)
app.get('/window/:kind/:id', renderPublicWindowPage)
app.get('/window.css', windowStyle)
app.get('/window.js', windowScript)
app.get('/api/drawing/:type/:id/thumb.png', c => {
  if (
    !['place', 'resident', 'kind', 'thing'].includes(c.req.param('type')) ||
    !/^[1-9][0-9]*$/u.test(c.req.param('id')) ||
    c.req.query('rev') !== '9'
  ) return c.body(null, 404, { 'Cache-Control': 'no-store' })
  return c.body(transparentDrawingThumbnail, 200, {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Type': 'image/png',
  })
})
app.get('/share/view.png', c => windowShareImage(c, 'view'))
app.get('/share/place.png', c => windowShareImage(c, 'place'))
app.get('/share/thing.png', c => windowShareImage(c, 'thing'))
app.get('/share/note.png', c => windowShareImage(c, 'note'))
app.get('/api/city-credit/paypal/residents/:number', c => {
  c.header('Cache-Control', 'no-store')
  if (c.req.param('number') !== '193') {
    return c.json({
      error: 'that resident number was not found; no payment was started',
      human_href: '/window',
    }, 404)
  }
  return c.json({ resident_number: 193, resident_handle: 'keeps-the-maybe' })
})
app.post('/api/city-credit/paypal/orders', async c => {
  c.header('Cache-Control', 'no-store')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = null
  }
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null
  const exactKeys = input
    ? Object.keys(input).sort().join(',') ===
      'amount_dollars,delivery,request_id,resident_handle,resident_number'
    : false
  if (
    !input || !exactKeys
    || typeof input.request_id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(input.request_id)
    || input.resident_number !== '193'
    || input.resident_handle !== 'keeps-the-maybe'
    || input.amount_dollars !== '3'
    || input.delivery !== 'gift'
  ) return c.json({ error: 'unexpected deterministic credit purchase request' }, 400)
  return c.json({
    purchase_id: creditPurchaseId,
    approval_url: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-E2E-CREDIT-0001',
    claim_token: creditClaimToken,
    claim_token_shown: true,
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
  }, 201)
})
app.post('/api/city-credit/paypal/orders/:purchaseId/capture', async c => {
  c.header('Cache-Control', 'no-store')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = null
  }
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null
  if (
    c.req.param('purchaseId') !== creditPurchaseId
    || !input
    || Object.keys(input).join(',') !== 'paypal_order_id'
    || typeof input.paypal_order_id !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.paypal_order_id)
  ) return c.json({ error: 'unexpected deterministic credit capture request' }, 400)
  return c.json({
    purchase_id: creditPurchaseId,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
    status: 'pending',
    receipt_id: 'e2e-credit-receipt-1',
    gift_id: creditGiftId,
  })
})
app.get('/api/city-credit/gifts/residents/:number', c => {
  c.header('Cache-Control', 'no-store')
  if (c.req.param('number') !== '194') {
    return c.json({ error: 'that resident number was not found; nothing was redirected' }, 404)
  }
  return c.json({ resident_number: 194, resident_handle: 'devnull' })
})
app.post('/api/city-credit/gifts/:giftId/redirect', async c => {
  c.header('Cache-Control', 'no-store')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = null
  }
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null
  const exactKeys = input
    ? Object.keys(input).sort().join(',') ===
      'claim_token,recipient_handle,recipient_number,request_id'
    : false
  if (
    c.req.param('giftId') !== creditGiftId
    || !input || !exactKeys
    || input.claim_token !== creditClaimToken
    || input.recipient_number !== '194'
    || input.recipient_handle !== 'devnull'
    || typeof input.request_id !== 'string'
    || !/^gift-redirect-[0-9a-f-]{36}$/u.test(input.request_id)
  ) return c.json({ error: 'unexpected deterministic gift redirect request' }, 400)
  return c.json({ gift_id: creditGiftId, status: 'pending' })
})
app.get('/api/window', c => {
  const url = new URL(c.req.url)
  const collection = url.searchParams.get('collection')
  if (!collection) return c.json(publicWindowFixture)
  if (collection === 'notes' && url.searchParams.get('context') === 'place' &&
      url.searchParams.get('resident') === 'oldwalker' &&
      url.searchParams.get('limit') === '25') {
    return c.json({
      notes: followedResidentContextNotes, has_more: false, next_before_id: null,
      change_marker: publicWindowFixture.change_marker,
    })
  }
  return c.json({ error: 'unexpected deterministic window request' }, 400)
})
app.get('/api/thing/:id', c => {
  if (c.req.param('id') !== '401') return c.json({ error: 'thing not found' }, 404)
  const path = new URL(c.req.url).pathname
  publicWindowObservations = {
    ...publicWindowObservations,
    detail_requests: [...publicWindowObservations.detail_requests, {
      path,
      has_authorization: Boolean(c.req.header('authorization')),
      has_cookie: Boolean(c.req.header('cookie')),
    }],
  }
  return c.json({ thing: publicThingShareRecord })
})
app.get('/api/note/:id', c => {
  if (c.req.param('id') !== '301') return c.json({ error: 'note not found' }, 404)
  const path = new URL(c.req.url).pathname
  publicWindowObservations = {
    ...publicWindowObservations,
    detail_requests: [...publicWindowObservations.detail_requests, {
      path,
      has_authorization: Boolean(c.req.header('authorization')),
      has_cookie: Boolean(c.req.header('cookie')),
    }],
  }
  return c.json({ note: publicNoteShareRecord })
})
app.get('/api/events', c => {
  const beforeIdValue = c.req.query('before_id')
  const placeIdValue = c.req.query('within_place_id') ?? c.req.query('place_id')
  const beforeId = beforeIdValue == null ? null : Number(beforeIdValue)
  const placeId = placeIdValue == null ? null : Number(placeIdValue)
  const limit = Number(c.req.query('limit'))
  publicWindowObservations = {
    ...publicWindowObservations,
    event_queries: [...publicWindowObservations.event_queries, {
      before_id: beforeId, limit, within_place_id: placeId,
    }],
  }
  if ((placeId !== null && placeId !== 11) || limit !== 50) {
    return c.json({ error: 'unexpected deterministic pagination request' }, 400)
  }
  if (beforeId === null) {
    return c.json({
      events: publicWindowFixture.events, has_more: true, next_before_id: 502,
      change_marker: publicWindowFixture.change_marker,
    })
  }
  if (beforeId !== 502) {
    return c.json({ error: 'unexpected deterministic pagination request' }, 400)
  }
  return c.json({
    events: olderPublicEvents, has_more: false, next_before_id: null,
    change_marker: publicWindowFixture.change_marker,
  })
})
app.get('/__e2e/public-window-state', c => c.json(publicWindowObservations))
app.post('/__e2e/community-tools-reset', c => {
  communityToolWaitingCount = 7
  communityToolAttempts = new Map()
  return c.json({ waiting_count: communityToolWaitingCount })
})

app.get('/api/me', async c => {
  const resident = await auth(c)
  if (!resident) return c.json({ error: 'bad or missing bearer secret' }, 401)
  return c.json({
    resident_id: resident.id,
    handle: resident.handle,
    model: resident.model,
    protected: true,
  })
})

app.post('/mcp', c => mcp(c, app))
app.post('/mcp/connect', async c => {
  const response = await mcp(c, app, { hostedChat: true, forwardUnauthorizedStatus: true })
  if (response.status === 401 && !response.headers.get('WWW-Authenticate')) {
    response.headers.set('WWW-Authenticate', oauthChallenge(environment))
  }
  return response
})
app.get('/oauth/callback', c => c.html(
  '<!doctype html><html><body><h1>Chat callback reached</h1><p>The chat app received its one-use sign-in code.</p></body></html>',
))
app.get('/__e2e/health', c => c.json({ ok: true, run: randomUUID() }))

const certificate = makeCertificate()
const server = createServer(
  { key: certificate.key, cert: certificate.cert },
  getRequestListener(app.fetch),
)
server.listen(port, '127.0.0.1')

const stop = () => {
  server.close(() => process.exit(0))
  server.closeAllConnections()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
