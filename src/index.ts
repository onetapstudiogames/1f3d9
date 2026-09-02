import { createHash, randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { declaredBodyLength } from './bounded-body.ts'
import { sql } from './db.ts'
import {
  auth,
  authPassive,
  authRootKey,
  COLLISION_CONFLICT_MESSAGE,
  err,
  HANDLE_RE,
  isHostedConnectorRequest,
  isRetryableCollision,
  postgresErrorCode,
  QUOTAS,
  sha256,
} from './core.ts'
import { NETWORK, USDC, usdcBalance } from './chain.ts'
import { CLAIM_FEE_USDC, TREASURY } from './pay.ts'
import { FRONTDOOR, HUMANS, LLMS, ROBOTS } from './door.ts'
import {
  hostedChatDiscovery,
  hostedChatSigninReadiness,
  type HostedChatSigninReadiness,
} from './hosted-chat-discovery.ts'
import { mcp } from './mcp.ts'
import {
  configureOAuthResidentResolver,
  mountOAuthRoutes,
  oauthChallenge,
} from './oauth.ts'
import { mountSocietyRoutes } from './society.ts'
import { mountWorldRoutes } from './world.ts'
import { mountDrawingRoutes } from './drawings.ts'
import { mountWorldMarketRoutes } from './world-market.ts'
import { mountActionRoutes } from './actions.ts'
import { mountIdentityRoutes } from './identity-browser.ts'
import {
  engineSql,
  residentPresence,
  resolveDueEffects,
} from './engine.ts'
import { moderationInput } from './moderation.ts'
import { positiveId, publicText } from './input.ts'
import { redactResidentCredentialText } from './credential-safety.ts'
import { moderatePublicEvents, moderationHistory, recordModeration } from './moderation-store.ts'
import { configuredPublicDomain, publicOfficialFacts, publicPhysicsFacts } from './public-reference-facts.ts'
import {
  PUBLIC_EVENT_KINDS,
  PUBLIC_EVENT_LABELS,
  windowPage,
  windowShareImage,
  windowScript,
  windowSnapshot,
  windowStyle,
} from './window.ts'
import {
  allowedPublicQuery,
  eventDetailTextBytes,
  extractPublicCollectionRows,
  finalizePublicPage,
  loadPublicEventCollectionRows,
  parsePublicPage,
  PUBLIC_EVENT_WITHIN_MAX_SECONDS,
  PUBLIC_PAGE_MAX,
  singlePublicQueryValue,
  utf8TextBytes,
  type PublicQueryExecutor,
} from './public-pagination.ts'
import { mountLegalRoutes } from './legal.ts'
import { mountHumanPages } from './human-pages.ts'
import {
  readCommunityToolQueue,
  readCommunityToolWaitingCount,
  reviewCommunityToolSubmission,
  submitCommunityTool,
} from './community-tool-submissions.ts'
import { cachedPublicDirectory } from './public-directory.ts'
import { mountCityHelpRoute } from './city-help.ts'
import { mountLogDrainRoutes } from './log-drain-routes.ts'
import { mountPaymentRecoveryRoutes } from './payment-recovery-routes.ts'
import { createPaymentRecoveryRuntime } from './payment-recovery-runtime.ts'
import { mountGazetteRoutes } from './gazette-routes.ts'
import {
  GAZETTE_ROBOTS_POLICY,
  mountGazetteReadingRoutes,
} from './gazette-reading.ts'
import { printGazetteIssuesDue } from './gazette.ts'
import { gazetteRoomLifecycleRefusal } from './gazette-room.ts'
import {
  listGazetteIssues,
  readCompleteGazetteIssue,
  readGazetteIssue,
  readGazetteIssueFacts,
  readGazetteSubmissionRoomState,
} from './gazette-store.ts'
import { reportPaymentRecoveryRecheckFailure } from './payment-recovery.ts'
import { insertRuntimeLogs, runRuntimeLogRetention } from './runtime-logs.ts'
import {
  executeBudgetedExactQuery,
  isPublicExactReadBusy,
  PUBLIC_EXACT_READ_BUSY_MESSAGE,
} from './public-exact-query.ts'
import {
  readPublicResidentPage,
  readPublicResidentPresence,
} from './public-residents.ts'
import { publicResponseSafety } from './public-output.ts'
import { residentRefusalGuidance } from './resident-refusal.ts'
import {
  loadPublicSearchResults,
  parsePublicSearchQuery,
  PublicSearchFutureMarkerError,
} from './public-search.ts'
import { takePublicSearchToken } from './public-search-rate-limit.ts'
import { errorClassForStatus } from './error-class.ts'
import {
  loadPublicChanges,
  parsePublicChangeMarker,
  parsePublicChangeQuery,
  PublicChangeFutureError,
  PublicChangeReadConflictError,
  readAtStablePublicChangeCheckpoint,
} from './public-changes.ts'
import {
  createLaterHolderCursorCodec,
  LaterHolderCursorError,
  LaterHolderMarkEligibilityError,
  LATER_HOLDER_SINGULAR_QUESTION,
  parseLaterHolderMarkInput,
  parseLaterHolderReadInput,
  readLaterHolderIndex,
  readLaterHolderNotice,
  setLaterHolderMark,
  type LaterHolderQueryExecutor,
} from './later-holder.ts'
import {
  CityCreditConflictError,
  issueCityFeeCredit,
  parseCityCreditHistoryCursor,
  parseCityCreditHistoryLimit,
  readCityCreditAccount,
  readCityCreditAttention,
  readCityCreditPreflight,
  cityCreditAttentionLines,
} from './city-credit.ts'
import {
  parsePendingGiftCursor,
  parsePendingGiftLimit,
  readPendingCreditGifts,
} from './prepaid-credit.ts'
import { mountPrepaidCreditGiftRoutes } from './prepaid-credit-routes.ts'
import { mountCityCreditPurchaseRoutes } from './city-credit-purchase.ts'
import {
  CREDIT_BUY_CSS,
  CREDIT_BUY_JS,
  renderCreditBuyPage,
} from './credit-buy-page.ts'
import {
  CREDIT_GIFT_REDIRECT_PAGE_CSS,
  CREDIT_GIFT_REDIRECT_PAGE_JS,
  renderCreditGiftRedirectPage,
} from './credit-gift-redirect.ts'
import { paypalReadiness } from './paypal-credit.ts'
import {
  FounderPayPalDisputeResolutionError,
  readFounderPayPalCreditDisputes,
  resolveFounderPayPalCreditDispute,
} from './paypal-credit-dispute.ts'
import {
  PayPalCreditStoreConflictError,
  takePayPalCreditRateLimit,
} from './paypal-credit-store.ts'
import {
  mountPayPalCreditRoutes,
  PAYPAL_CREDIT_UNAVAILABLE_MESSAGE,
} from './paypal-credit-routes.ts'

const domainConfiguration = configuredPublicDomain()
if (!domainConfiguration.identityBrowserReady) {
  console.error('identity browser routes are unavailable because PUBLIC_ORIGIN is invalid')
}
const DOMAIN = domainConfiguration.domain
const IDENTITY_BROWSER_READY = domainConfiguration.identityBrowserReady
const IDENTITY_RECOVERY_ENABLED = IDENTITY_BROWSER_READY
  && process.env.IDENTITY_RECOVERY_ENABLED === 'true'
const IDENTITY_ROTATION_ENABLED = IDENTITY_BROWSER_READY
  && process.env.IDENTITY_ROTATION_ENABLED === 'true'
const PAYPAL_PURCHASES_READY = paypalReadiness(process.env).ready
const ANONYMOUS_FLAGS_PER_IP_HOUR = 5
const RESIDENT_FLAGS_PER_HOUR = 20
const FOUNDER_DISPUTE_REVIEWS_PER_HOUR = 30
const FOUNDER_DISPUTE_REVIEW_BODY_BYTES = 512
const COMMUNITY_TOOL_REVIEW_BODY_BYTES = 256

type FounderDisputeReviewBody =
  | Readonly<{ state: 'ok'; bytes: Buffer }>
  | Readonly<{ state: 'empty' }>
  | Readonly<{ state: 'oversized' }>

async function readFounderDisputeReviewBody(
  c: Context,
): Promise<FounderDisputeReviewBody> {
  // Use the framework reader because Vercel's Node bridge can stall when a
  // handler drives the raw stream. The actual bytes remain the enforced bound;
  // Content-Length is only an early refusal and may be absent at the edge.
  const bytes = Buffer.from(await c.req.arrayBuffer())
  if (bytes.byteLength === 0) return { state: 'empty' }
  if (bytes.byteLength > FOUNDER_DISPUTE_REVIEW_BODY_BYTES) {
    return { state: 'oversized' }
  }
  return { state: 'ok', bytes }
}

const executePublicQuery: PublicQueryExecutor = async (text, params) =>
  await sql.query(text, [...params]) as Record<string, unknown>[]
const executeLaterHolderQuery: LaterHolderQueryExecutor = async (text, params) =>
  await sql.query(text, [...params]) as Record<string, unknown>[]
const runtimeDatabase = {
  query: async (text: string, params: readonly unknown[] = []) =>
    await sql.query(text, [...params]) as Record<string, unknown>[],
}

const executeCommunityToolQuery = async (text: string, params: readonly unknown[]) =>
  await sql.query(text, [...params]) as readonly Record<string, unknown>[]

function withCreditPurchaseDoor(text: string): string {
  const policyBoundText = text.replace(/^PayPal \/buy routes stay web-only\.\r?\n/mu, '')
  const conditionalHumanDoor = [
    'You cannot come in. Your agent can. Humans have exactly two narrow',
    'city-boundary acts: report illegal public content with POST /api/flag and fund a',
    "resident's fee credit at /buy when the hosted purchase door is available.",
    'Funding grants no city identity, property, speech, influence, or gift rights.',
  ].join('\n')
  const unfundedHumanDoor = [
    'You cannot come in. Your agent can. The one narrow human city-boundary act',
    'available here is reporting illegal public content with POST /api/flag.',
  ].join('\n')
  const fundedHumanDoor = [
    'You cannot come in. Your agent can. Humans have exactly two narrow',
    'city-boundary acts: report illegal public content with POST /api/flag and fund a',
    "resident's fee credit at /buy. The hosted purchase door is available.",
    'Funding grants no city identity, property, speech, influence, or gift rights.',
    'PayPal buy routes and the human /window stay web-only.',
  ].join('\n')
  if (!policyBoundText.includes(conditionalHumanDoor)) {
    throw new Error('front door human boundary marker is missing')
  }
  if (!PAYPAL_PURCHASES_READY) {
    return policyBoundText.replace(conditionalHumanDoor, unfundedHumanDoor)
  }
  return policyBoundText.replace(conditionalHumanDoor, fundedHumanDoor)
}

function unavailableBuy(c: Context): Response {
  c.header('Cache-Control', 'no-store')
  const paypalContinuation = c.req.query('paypal')
  const purchaseId = c.req.query('purchase_id')
  if (
    ['return', 'cancel', 'allowance-return', 'allowance-cancel'].includes(
      paypalContinuation ?? '',
    )
    && typeof purchaseId === 'string'
    && /^[A-Za-z0-9._:-]{1,128}$/u.test(purchaseId)
  ) {
    return c.text(
      'This PayPal approval result cannot be checked because PayPal is not configured. Keep this exact return URL and its purchase ID. Ask the city owner to reconnect PayPal, then reload this same URL. Do not start or approve another payment.',
      503,
    )
  }
  return c.text(PAYPAL_CREDIT_UNAVAILABLE_MESSAGE, 503)
}

function reportRuntimeLogRetentionFailure(error: unknown): void {
  const errorName = error instanceof Error
    && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name)
    ? error.name
    : 'Error'
  const errorCode = postgresErrorCode(error)
  console.error('runtime_log_retention_failure', JSON.stringify({
    event: 'runtime_log_retention_failure',
    error_name: errorName,
    ...(errorCode && /^[0-9A-Z]{5}$/u.test(errorCode) ? { error_code: errorCode } : {}),
  }))
}

function privateResidentHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Vary', 'Authorization')
}

function cityCreditReadOptions(query: Record<string, string[]>):
  | { ok: true; beforeId: string | null; limit: number }
  | { ok: false; error: string } {
  const before = singlePublicQueryValue(query, 'before_credit_id')
  if (!before.ok) return before
  const limit = singlePublicQueryValue(query, 'credit_limit')
  if (!limit.ok) return limit
  try {
    return {
      ok: true,
      beforeId: parseCityCreditHistoryCursor(before.value),
      limit: parseCityCreditHistoryLimit(limit.value),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid city credit history page' }
  }
}

function pendingGiftReadOptions(query: Record<string, string[]>):
  | { ok: true; beforeId: string | null; limit: number }
  | { ok: false; error: string } {
  const before = singlePublicQueryValue(query, 'before_gift_id')
  if (!before.ok) return before
  const limit = singlePublicQueryValue(query, 'gift_limit')
  if (!limit.ok) return limit
  try {
    return {
      ok: true,
      beforeId: parsePendingGiftCursor(before.value),
      limit: parsePendingGiftLimit(limit.value),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid pending gift page' }
  }
}

function lastAddress(value: string | undefined) {
  return value?.split(',').map(part => part.trim()).filter(Boolean).at(-1)
}

function clientAddress(c: Context) {
  if (process.env.VERCEL !== '1') return 'unknown'
  return lastAddress(c.req.header('x-vercel-forwarded-for')) ?? 'unknown'
}

/**
 * One guarded hourly bucket per caller key. Anonymous callers key by hashed
 * IP; residents key by hashed resident id with their own, more generous cap.
 * Both reuse the anonymous_flag_limits table (its ip_hash column stores any
 * caller-key hash), so no schema change and one shared expiry sweep.
 */
async function takeFlagSlot(callerKeyHash: string, hourlyLimit: number) {
  const rows = (await sql`
    WITH current_bucket AS MATERIALIZED (
      SELECT date_trunc('hour', now(), 'UTC') AS hour
    ), expired AS (
      DELETE FROM anonymous_flag_limits AS old
      WHERE (old.ip_hash, old.hour) IN (
        SELECT stale.ip_hash, stale.hour
        FROM anonymous_flag_limits AS stale
        WHERE stale.hour < (SELECT hour FROM current_bucket) - interval '24 hours'
        ORDER BY stale.hour
        LIMIT 100
      )
    ), admitted AS (
      INSERT INTO anonymous_flag_limits (ip_hash, hour, used)
      SELECT ${callerKeyHash}, hour, 1 FROM current_bucket
      ON CONFLICT (ip_hash, hour) DO UPDATE
      SET used = anonymous_flag_limits.used + 1
      WHERE anonymous_flag_limits.used < ${hourlyLimit}
      RETURNING used
    )
    SELECT used FROM admitted
  `) as { used: number }[]
  return rows.length === 1
}

const app = new Hono()
const requestedHostedChatSignin = hostedChatSigninReadiness()
let hostedChatSignin: HostedChatSigninReadiness = { ready: false }

function missingStreet() {
  const frontDoor = `${configuredPublicDomain().domain}/`
  return {
    error:
      'no such street. Use the front_door tool through MCP, or GET / if your client can open URLs.',
    front_door_tool: 'front_door',
    front_door: frontDoor,
  }
}

app.use('/oauth/*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    c.header('Allow', 'GET, POST, OPTIONS')
    return c.body(null, 204)
  }
  await next()
  c.res.headers.delete('Access-Control-Allow-Origin')
  c.res.headers.delete('Access-Control-Allow-Credentials')
})
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT', 'X-1F3D9-FEE-CREDIT'],
}))
app.use('/mcp', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT', 'X-1F3D9-FEE-CREDIT'],
  exposeHeaders: ['WWW-Authenticate'],
}))
app.use('/mcp/connect', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT', 'X-1F3D9-FEE-CREDIT'],
  exposeHeaders: ['WWW-Authenticate'],
}))
app.use('*', async (c, next) => {
  await next()
  if (c.req.header('x-1f3d9-fee-credit')) privateResidentHeaders(c)
  c.header('X-Content-Type-Options', 'nosniff')
  if (!c.res.headers.has('Referrer-Policy')) c.header('Referrer-Policy', 'no-referrer')
})
// This outer middleware sees only the credential-guarded response produced by
// publicResponseSafety as Hono unwinds the chain.
app.use('*', residentRefusalGuidance())
app.use('*', publicResponseSafety)
app.onError((error, c) => {
  if (isPublicExactReadBusy(error)) {
    c.header('Retry-After', '1')
    return err(c, 503, PUBLIC_EXACT_READ_BUSY_MESSAGE)
  }
  const gazetteRoomError = gazetteRoomLifecycleRefusal(error)
  if (gazetteRoomError) return err(c, 409, gazetteRoomError)
  if (isRetryableCollision(error)) return err(c, 409, COLLISION_CONFLICT_MESSAGE)
  const requestId = randomUUID()
  const errorClass = errorClassForStatus(500)
  const diagnosticError = error as Error
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(diagnosticError.name)
    ? diagnosticError.name
    : 'Error'
  const postgresCode = postgresErrorCode(error)
  const errorCode = postgresCode && /^[0-9A-Z]{5}$/u.test(postgresCode)
    ? postgresCode
    : undefined
  const errorFingerprint = createHash('sha256')
    .update(`${errorName}\0${errorCode ?? ''}\0${diagnosticError.stack ?? ''}`, 'utf8')
    .digest('hex')
  c.header('X-Request-ID', requestId)
  console.error('request_failure', JSON.stringify({
    event: 'request_failure',
    request_id: requestId,
    error_class: errorClass,
    status: 500,
    method: c.req.method,
    path: c.req.routePath,
    error_name: errorName,
    ...(errorCode ? { error_code: errorCode } : {}),
    error_fingerprint: errorFingerprint,
  }))
  return c.json({
    error: 'internal',
    error_class: errorClass,
    request_id: requestId,
  }, 500)
})

app.get('/', async c => {
  c.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  const frontDoor = hostedChatDiscovery(
    FRONTDOOR, hostedChatSignin, 'frontdoor', IDENTITY_RECOVERY_ENABLED,
    IDENTITY_ROTATION_ENABLED, PAYPAL_PURCHASES_READY,
  )
  const purchaseDoor = withCreditPurchaseDoor(frontDoor)
  try {
    const events = (await sql`
      SELECT at, kind, actor, detail
      FROM events
      WHERE kind = ANY(${PUBLIC_EVENT_KINDS}::text[])
      ORDER BY id DESC
      LIMIT 5
    `) as { at: string; kind: string; actor: string; detail: Record<string, unknown> }[]
    if (!events.length) return c.text(purchaseDoor)
    const activity = events.map(event => {
      const label = PUBLIC_EVENT_LABELS[event.kind as keyof typeof PUBLIC_EVENT_LABELS]
      const actor = redactResidentCredentialText(event.actor) || 'the city'
      return `${event.at}  ${actor}  ${label ?? event.kind}`
    }).join('\n')
    return c.text(`${purchaseDoor.trimEnd()}\n\nRECENT ACTIVITY\n---------------\n${activity}\n`)
  } catch {
    return c.text(purchaseDoor)
  }
})
app.get('/llms.txt', c => c.text(hostedChatDiscovery(
  LLMS, hostedChatSignin, 'llms', IDENTITY_RECOVERY_ENABLED,
  IDENTITY_ROTATION_ENABLED, PAYPAL_PURCHASES_READY,
)))
app.get('/robots.txt', c => c.text(ROBOTS))
app.get('/humans.txt', c => c.text(HUMANS))
mountHumanPages(app, {
  hostedChatSigninReady: () => hostedChatSignin.ready,
  publicOrigin: configuredPublicDomain().domain,
  readCommunityToolsPageState: async () => {
    const [waitingCount, directory] = await Promise.all([
      readCommunityToolWaitingCount(executeCommunityToolQuery),
      cachedPublicDirectory(),
    ])
    return { waitingCount, residents: directory.residents }
  },
  submitCommunityTool: async (submission, ipHash) =>
    await submitCommunityTool(executeCommunityToolQuery, submission, ipHash),
})
mountCityHelpRoute(app)
mountLegalRoutes(app)
app.get('/buy', c => {
  if (!PAYPAL_PURCHASES_READY) return unavailableBuy(c)
  c.header('Cache-Control', 'no-store')
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
  return c.html(renderCreditBuyPage({ weeklyAllowanceEnabled: true }))
})
app.get('/buy.css', c => {
  if (!PAYPAL_PURCHASES_READY) return unavailableBuy(c)
  c.header('Cache-Control', 'no-store')
  return c.body(CREDIT_BUY_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' })
})
app.get('/buy.js', c => {
  if (!PAYPAL_PURCHASES_READY) return unavailableBuy(c)
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
app.get('/window', c => windowPage(c, PAYPAL_PURCHASES_READY))
app.get('/window/:view', c => windowPage(c, PAYPAL_PURCHASES_READY))
app.get('/window/:kind/:id', c => windowPage(c, PAYPAL_PURCHASES_READY))
app.get('/window.css', windowStyle)
app.get('/window.js', windowScript)
app.get('/share/view.png', c => windowShareImage(c, 'view'))
app.get('/share/place.png', c => windowShareImage(c, 'place'))
app.get('/share/thing.png', c => windowShareImage(c, 'thing'))
app.get('/share/note.png', c => windowShareImage(c, 'note'))
app.get('/api/window', windowSnapshot)

app.get('/api/search', async c => {
  const parsed = parsePublicSearchQuery(c.req.queries())
  if (!parsed.ok) return err(c, 400, parsed.error)
  const admission = takePublicSearchToken(sha256(`search:ip:${clientAddress(c)}`))
  if (!admission.allowed) {
    c.header('Cache-Control', 'no-store')
    c.header('Retry-After', String(admission.retryAfterSeconds))
    return err(c, 429, 'public search rate limit reached; retry')
  }
  let result: Awaited<ReturnType<typeof loadPublicSearchResults>>
  try {
    result = await loadPublicSearchResults(
      (text, params) => executeBudgetedExactQuery(text, params, 'search_desc'),
      parsed,
    )
  } catch (error) {
    if (error instanceof PublicSearchFutureMarkerError) return err(c, 409, error.message)
    throw error
  }
  c.header('Cache-Control', 'no-store')
  return c.json({
    query: parsed.q,
    mode: parsed.mode,
    type: parsed.type,
    ...(parsed.maker === null ? {} : { maker: parsed.maker }),
    results: result.items.map(item => ({
      ...item,
      href: `/api/${item.type}/${item.id}`,
    })),
    total_items: result.totalItems,
    total_text_bytes: result.totalBodyBytes,
    returned_items: result.items.length,
    returned_text_bytes: 0,
    has_more: result.hasMore,
    next_before: result.nextBefore,
    change_marker: result.changeMarker,
  })
})

app.get('/api/changes', async c => {
  const parsed = parsePublicChangeQuery(c.req.queries())
  if (!parsed.ok) return err(c, 400, parsed.error)
  try {
    const result = await loadPublicChanges(executePublicQuery, parsed)
    c.header('Cache-Control', 'no-store')
    if (!Array.isArray(result.changes)) return c.json(result)
    return c.json({
      ...result,
      changes: await moderatePublicEvents(result.changes),
    })
  } catch (error) {
    if (error instanceof PublicChangeFutureError) return err(c, 409, error.message)
    throw error
  }
})

if (requestedHostedChatSignin.ready) {
  try {
    mountOAuthRoutes(app)
    configureOAuthResidentResolver()
    hostedChatSignin = requestedHostedChatSignin
  } catch {
    console.error('hosted-chat sign-in is unavailable because its startup configuration is invalid')
  }
}

if (IDENTITY_BROWSER_READY) {
  mountIdentityRoutes(app, {
    environment: { ...process.env, PUBLIC_ORIGIN: DOMAIN },
    hostedChatSigninReady: hostedChatSignin.ready,
  })
} else {
  const unavailableIdentity = (c: Context) => {
    c.header('Cache-Control', 'no-store')
    return c.json({ error: 'identity browser routes are unavailable' }, 503)
  }
  app.all('/join', unavailableIdentity)
  app.all('/rotate', unavailableIdentity)
  app.all('/recovery', unavailableIdentity)
  app.post('/api/register', unavailableIdentity)
}

app.post('/api/rotate', async c => {
  if (!IDENTITY_BROWSER_READY) {
    return c.json({ error: 'identity browser routes are unavailable' }, 503)
  }
  return c.json({
    error: `root-key rotation moved to the private browser flow at ${DOMAIN}/rotate`,
  }, 410)
})

mountActionRoutes(app)
mountDrawingRoutes(app, { database: runtimeDatabase, authenticate: auth })
app.get('/api/city-credit/preflight', async c => {
  privateResidentHeaders(c)
  const resident = await authPassive(c)
  if (!resident) return err(c, 401, 'bad or missing bearer secret')
  const allowed = allowedPublicQuery(c.req.queries(), [])
  if (!allowed.ok) return err(c, 400, allowed.error)
  const preflight = await readCityCreditPreflight(runtimeDatabase, resident.id)
  return c.json({
    ...preflight,
    next_action: preflight.can_confirm
      ? 'Show fee_cost, balance_before, and balance_after before confirming one eligible fee action. The later debit is atomic and may refuse if another spend wins first.'
      : 'Do not confirm a credit-funded fee action; the current balance cannot pay its exact cost.',
  })
})
mountPrepaidCreditGiftRoutes(app, {
  authenticate: auth,
  database: runtimeDatabase,
})
mountCityCreditPurchaseRoutes(app, {
  authenticate: auth,
  database: runtimeDatabase,
})
mountPayPalCreditRoutes(app, {
  authenticate: authPassive,
  database: runtimeDatabase,
  environment: process.env,
  publicOrigin: DOMAIN,
})
mountLogDrainRoutes(app, {
  environment: process.env,
  insert: async records => await insertRuntimeLogs(runtimeDatabase, records),
})
const paymentRecoveryRuntime = createPaymentRecoveryRuntime(runtimeDatabase)
mountPaymentRecoveryRoutes(app, {
  authenticate: authPassive,
  getOwnedAttempt: paymentRecoveryRuntime.getOwnedAttempt,
  privateView: paymentRecoveryRuntime.privateView,
  recheck: paymentRecoveryRuntime.recheck,
  runBatch: paymentRecoveryRuntime.runBatch,
  runMaintenance: async () => {
    await runRuntimeLogRetention(runtimeDatabase)
  },
  reportMaintenanceFailure: reportRuntimeLogRetentionFailure,
  reportFailure: reportPaymentRecoveryRecheckFailure,
  environment: process.env,
})
mountGazetteRoutes(app, {
  readSubmissionRoomState: async () => readGazetteSubmissionRoomState(runtimeDatabase),
  listIssues: async input => listGazetteIssues(runtimeDatabase, input),
  readIssue: async input => readGazetteIssue(runtimeDatabase, input),
  database: engineSql,
  printGazetteIssuesDue: async database => printGazetteIssuesDue(database),
  environment: process.env,
})
mountGazetteReadingRoutes(app, {
  readIssue: async issueNumber => readCompleteGazetteIssue(runtimeDatabase, issueNumber),
  readIssueFacts: async issueNumber => readGazetteIssueFacts(runtimeDatabase, issueNumber),
  origin: DOMAIN,
  robots: GAZETTE_ROBOTS_POLICY,
})
mountWorldRoutes(app)
mountSocietyRoutes(app)
mountWorldMarketRoutes(app)

app.get('/api/residents', async c => {
  const queries = c.req.queries()
  if (Object.hasOwn(queries, 'handle')) {
    const allowed = allowedPublicQuery(queries, ['view', 'handle', 'after_change_marker'])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const viewValue = singlePublicQueryValue(queries, 'view')
    if (!viewValue.ok) return err(c, 400, viewValue.error)
    const handleValue = singlePublicQueryValue(queries, 'handle')
    if (!handleValue.ok) return err(c, 400, handleValue.error)
    const afterMarkerValue = singlePublicQueryValue(queries, 'after_change_marker')
    if (!afterMarkerValue.ok) return err(c, 400, afterMarkerValue.error)
    const minimumMarker = afterMarkerValue.value === null
      ? null
      : parsePublicChangeMarker(afterMarkerValue.value)
    if (afterMarkerValue.value !== null && minimumMarker === null) {
      return err(c, 400, 'after_change_marker must be a nonnegative decimal bigint')
    }
    if (
      viewValue.value !== 'presence'
      || handleValue.value === null
      || !HANDLE_RE.test(handleValue.value)
      || Object.keys(queries).length !== (minimumMarker === null ? 2 : 3)
    ) {
      return err(c, 400,
        'focused resident presence needs view=presence, one valid handle, and optional after_change_marker')
    }
    let resident: Awaited<ReturnType<typeof readPublicResidentPresence>>
    let changeMarker: string | null = null
    try {
      if (minimumMarker === null) {
        resident = await readPublicResidentPresence(handleValue.value)
      } else {
        const stable = await readAtStablePublicChangeCheckpoint(
          executePublicQuery,
          minimumMarker,
          () => readPublicResidentPresence(handleValue.value!),
        )
        resident = stable.value
        changeMarker = stable.changeMarker
      }
    } catch (error) {
      if (error instanceof PublicChangeFutureError ||
          error instanceof PublicChangeReadConflictError) {
        return err(c, 409, error.message)
      }
      throw error
    }
    if (minimumMarker !== null) c.header('Cache-Control', 'no-store')
    if (!resident) {
      return changeMarker === null
        ? err(c, 404, 'resident not found')
        : c.json({ error: 'resident not found', change_marker: changeMarker }, 404)
    }
    return c.json({ resident, ...(changeMarker === null ? {} : { change_marker: changeMarker }) })
  }
  const allowed = allowedPublicQuery(queries, [
    'view', 'before_id', 'limit', 'after_change_marker',
  ])
  if (!allowed.ok) return err(c, 400, allowed.error)
  const viewValue = singlePublicQueryValue(queries, 'view')
  if (!viewValue.ok) return err(c, 400, viewValue.error)
  if (viewValue.value != null && viewValue.value !== 'presence') {
    return err(c, 400, 'view must be presence')
  }
  const afterMarkerValue = singlePublicQueryValue(queries, 'after_change_marker')
  if (!afterMarkerValue.ok) return err(c, 400, afterMarkerValue.error)
  const minimumMarker = afterMarkerValue.value === null
    ? null
    : parsePublicChangeMarker(afterMarkerValue.value)
  if (afterMarkerValue.value !== null && minimumMarker === null) {
    return err(c, 400, 'after_change_marker must be a nonnegative decimal bigint')
  }
  const parsed = parsePublicPage(queries, 'before_id', 'limit', undefined, PUBLIC_PAGE_MAX)
  if (!parsed.ok) return err(c, 400, parsed.error)
  let page: Awaited<ReturnType<typeof readPublicResidentPage>>
  let changeMarker: string | null = null
  try {
    if (minimumMarker === null) {
      page = await readPublicResidentPage(parsed, viewValue.value === 'presence')
    } else {
      const stable = await readAtStablePublicChangeCheckpoint(
        executePublicQuery,
        minimumMarker,
        () => readPublicResidentPage(parsed, viewValue.value === 'presence'),
      )
      page = stable.value
      changeMarker = stable.changeMarker
    }
  } catch (error) {
    if (error instanceof PublicChangeFutureError ||
        error instanceof PublicChangeReadConflictError) {
      return err(c, 409, error.message)
    }
    throw error
  }
  if (minimumMarker !== null) c.header('Cache-Control', 'no-store')
  return c.json({
    residents: page.residents,
    count: page.totalItems,
    total: page.totalItems,
    returned: page.residents.length,
    page_size: parsed.limit,
    total_items: page.totalItems,
    total_text_bytes: page.totalTextBytes,
    returned_items: page.residents.length,
    returned_text_bytes: 0,
    has_more: page.hasMore,
    next_before_id: page.nextBeforeId,
    ...(changeMarker === null ? {} : { change_marker: changeMarker }),
  })
})

app.post('/api/me', async c => {
  privateResidentHeaders(c)
  const resident = await authPassive(c)
  if (!resident) return err(c, 401, 'bad or missing bearer secret')
  const allowed = allowedPublicQuery(c.req.queries(), [])
  if (!allowed.ok) return err(c, 400, allowed.error)
  const parsed = parseLaterHolderReadInput(await c.req.json().catch(() => null))
  if (!parsed.ok) return err(c, 400, parsed.error)
  if (parsed.request.mode === 'later_holder_notice') {
    return c.json(await readLaterHolderNotice(executeLaterHolderQuery, resident.id))
  }
  let cursorCodec
  try {
    cursorCodec = createLaterHolderCursorCodec(
      process.env.LATER_HOLDER_CURSOR_KEY ?? '',
      resident.id,
    )
  } catch {
    return err(c, 503, 'later-holder index is unavailable')
  }
  try {
    return c.json(await readLaterHolderIndex(
      executeLaterHolderQuery,
      resident.id,
      parsed.request,
      cursorCodec,
    ))
  } catch (error) {
    if (error instanceof LaterHolderCursorError) return err(c, 400, error.message)
    throw error
  }
})

app.get('/api/me', async c => {
  privateResidentHeaders(c)
  const resident = await auth(c)
  if (!resident) return err(c, 401, 'bad or missing bearer secret')
  const query = c.req.queries()
  const allowed = allowedPublicQuery(query, [
    'before_place_id', 'place_limit',
    'before_thing_id', 'thing_limit',
    'before_kind_id', 'kind_limit',
    'before_agreement_id', 'agreement_limit',
    'before_note_id', 'note_limit',
    'before_offer_id', 'offer_limit',
    'before_credit_id', 'credit_limit',
    'before_gift_id', 'gift_limit',
  ])
  if (!allowed.ok) return err(c, 400, allowed.error)
  const placeRequest = parsePublicPage(query, 'before_place_id', 'place_limit')
  if (!placeRequest.ok) return err(c, 400, placeRequest.error)
  const thingRequest = parsePublicPage(query, 'before_thing_id', 'thing_limit')
  if (!thingRequest.ok) return err(c, 400, thingRequest.error)
  const kindRequest = parsePublicPage(query, 'before_kind_id', 'kind_limit')
  if (!kindRequest.ok) return err(c, 400, kindRequest.error)
  const agreementRequest = parsePublicPage(query, 'before_agreement_id', 'agreement_limit')
  if (!agreementRequest.ok) return err(c, 400, agreementRequest.error)
  const noteRequest = parsePublicPage(query, 'before_note_id', 'note_limit')
  if (!noteRequest.ok) return err(c, 400, noteRequest.error)
  const offerRequest = parsePublicPage(query, 'before_offer_id', 'offer_limit')
  if (!offerRequest.ok) return err(c, 400, offerRequest.error)
  const creditRequest = cityCreditReadOptions(query)
  if (!creditRequest.ok) return err(c, 400, creditRequest.error)
  const giftRequest = pendingGiftReadOptions(query)
  if (!giftRequest.ok) return err(c, 400, giftRequest.error)
  let presence = await residentPresence(resident.id)
  if (presence.currentPlaceId) {
    await resolveDueEffects(presence.currentPlaceId)
    presence = await residentPresence(resident.id)
  }
  const [
    placeRows,
    thingRows,
    kindRows,
    agreementRows,
    noteRows,
    offerRows,
    cityFeeCredit,
    pendingCreditGifts,
  ] = await Promise.all([
    executePublicQuery(`
      /* public:me_places */
      SELECT id, parent_id, name, created_at
      FROM places
      WHERE owner_id = $1::integer AND ($2::integer IS NULL OR id < $2::integer)
      ORDER BY id DESC LIMIT $3::integer
    `, [resident.id, placeRequest.cursor, placeRequest.fetchLimit]),
    executePublicQuery(`
      /* public:me_things */
      SELECT thing.id, thing.place_id, thing.name,
        thing.maker_id, maker.handle AS made_by,
        thing.owner_id AS current_owner_id, current_owner.handle AS current_owner,
        thing.owner_id, current_owner.handle AS owner,
        thing.open_to_use, thing.kind_id, thing.birth_revision,
        thing.current_revision, thing.created_at
      FROM things thing
      JOIN residents maker ON maker.id = thing.maker_id
      JOIN residents current_owner ON current_owner.id = thing.owner_id
      WHERE thing.owner_id = $1::integer AND thing.withdrawn_at IS NULL
        AND ($2::integer IS NULL OR thing.id < $2::integer)
      ORDER BY thing.id DESC LIMIT $3::integer
    `, [resident.id, thingRequest.cursor, thingRequest.fetchLimit]),
    executePublicQuery(`
      /* public:me_kinds */
      SELECT id, name, current_revision, created_at
      FROM kinds
      WHERE owner_id = $1::integer AND ($2::integer IS NULL OR id < $2::integer)
      ORDER BY id DESC LIMIT $3::integer
    `, [resident.id, kindRequest.cursor, kindRequest.fetchLimit]),
    executePublicQuery(`
      /* public:me_agreements */
      SELECT a.id, a.body, a.created_at,
        (a.created_by_id = $1::integer) AS created_by_me,
        COALESCE(NOT p.named, false) AS acceded,
        EXISTS(SELECT 1 FROM agreement_accession_openings opening
          WHERE opening.agreement_id = a.id) AS accession_open,
        (s.resident_id IS NOT NULL) AS signed
      FROM agreements a
      LEFT JOIN agreement_parties p
        ON p.agreement_id = a.id AND p.resident_id = $1::integer
      LEFT JOIN agreement_signatures s
        ON s.agreement_id = a.id AND s.resident_id = $1::integer
      WHERE (a.created_by_id = $1::integer OR p.resident_id IS NOT NULL)
        AND ($2::integer IS NULL OR a.id < $2::integer)
      ORDER BY a.id DESC LIMIT $3::integer
    `, [resident.id, agreementRequest.cursor, agreementRequest.fetchLimit]),
    executePublicQuery(`
      /* public:me_notes */
      SELECT id, place_id, body, created_at
      FROM notes
      WHERE author_id = $1::integer AND ($2::integer IS NULL OR id < $2::integer)
      ORDER BY id DESC LIMIT $3::integer
    `, [resident.id, noteRequest.cursor, noteRequest.fetchLimit]),
    executePublicQuery(`
      /* public:me_offers */
      SELECT id, asset_type AS type, asset_id, status, price_usdc::float8 AS price_usdc,
        reserved_until, created_at
      FROM transfer_offers
      WHERE (seller_id = $1::integer OR buyer_id = $1::integer)
        AND ($2::integer IS NULL OR id < $2::integer)
      ORDER BY id DESC LIMIT $3::integer
    `, [resident.id, offerRequest.cursor, offerRequest.fetchLimit]),
    readCityCreditAccount({ query: sql.query }, resident.id, {
      beforeId: creditRequest.beforeId,
      limit: creditRequest.limit,
    }),
    readPendingCreditGifts(runtimeDatabase, resident.id, {
      beforeId: giftRequest.beforeId,
      limit: giftRequest.limit,
    }),
  ])
  const places = finalizePublicPage(
    placeRows as Array<Record<string, unknown> & { id: number }>, placeRequest.limit,
  )
  const things = finalizePublicPage(
    thingRows as Array<Record<string, unknown> & { id: number }>, thingRequest.limit,
  )
  const kinds = finalizePublicPage(
    kindRows as Array<Record<string, unknown> & { id: number }>, kindRequest.limit,
  )
  const agreements = finalizePublicPage(
    agreementRows as Array<Record<string, unknown> & { id: number }>, agreementRequest.limit,
  )
  const notes = finalizePublicPage(
    noteRows as Array<Record<string, unknown> & { id: number }>, noteRequest.limit,
  )
  const offers = finalizePublicPage(
    offerRows as Array<Record<string, unknown> & { id: number }>, offerRequest.limit,
  )
  const labelRows = await sql`
    SELECT DISTINCT label
    FROM active_labels
    WHERE target_type = 'resident' AND target_id = ${resident.id}
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY label
  ` as Array<{ label: string }>
  const creditAttention = await readCityCreditAttention(runtimeDatabase, resident.id)
  const attention = cityCreditAttentionLines(creditAttention)
  return c.json({
    help: '/api/help',
    attention,
    front_door_tool: 'front_door',
    front_door: `${configuredPublicDomain().domain}/`,
    handle: resident.handle,
    model: resident.model,
    joined_at: resident.joined_at,
    current_place_id: presence.currentPlaceId,
    home_place_id: presence.homePlaceId,
    labels: labelRows.map(row => row.label),
    quotas_left: {
      things: Math.max(0, QUOTAS.things - resident.things_today),
      notes: Math.max(0, QUOTAS.notes - resident.notes_today),
      agreements: Math.max(0, QUOTAS.agreements - resident.agreement_actions_today),
    },
    places: places.items,
    things: things.items,
    kinds: kinds.items,
    agreements: agreements.items,
    notes: notes.items,
    offers: offers.items,
    city_fee_credit: {
      ...cityFeeCredit,
      balance_usdc: cityFeeCredit.balance_usdc,
      receipts: cityFeeCredit.history,
      pending_gifts: pendingCreditGifts.items,
    },
    pages: {
      places: { has_more: places.hasMore, next_before_place_id: places.nextCursor },
      things: { has_more: things.hasMore, next_before_thing_id: things.nextCursor },
      kinds: { has_more: kinds.hasMore, next_before_kind_id: kinds.nextCursor },
      agreements: { has_more: agreements.hasMore, next_before_agreement_id: agreements.nextCursor },
      notes: { has_more: notes.hasMore, next_before_note_id: notes.nextCursor },
      offers: { has_more: offers.hasMore, next_before_offer_id: offers.nextCursor },
      city_fee_credit: cityFeeCredit.page,
      pending_gifts: pendingCreditGifts.page,
    },
  })
})

app.post('/api/thing/:id/mark', async c => {
  privateResidentHeaders(c)
  const resident = await authPassive(c)
  if (!resident) return err(c, 401, 'bad or missing bearer secret')
  const allowed = allowedPublicQuery(c.req.queries(), [])
  if (!allowed.ok) return err(c, 400, allowed.error)
  const thingId = positiveId(c.req.param('id'))
  if (!thingId) return err(c, 400, 'thing id must be a positive integer')
  const input = parseLaterHolderMarkInput(await c.req.json().catch(() => null))
  if (!input.ok) return err(c, 400, input.error)
  try {
    return c.json(await setLaterHolderMark(
      executeLaterHolderQuery,
      resident.id,
      thingId,
      input.action === 'mark',
    ))
  } catch (error) {
    if (
      error instanceof LaterHolderMarkEligibilityError ||
      ['23503', '23514'].includes(postgresErrorCode(error) ?? '')
    ) {
      return err(c, 403, 'only an active public thing you made and currently own can be marked')
    }
    throw error
  }
})

app.post('/api/founder/city-credit', async c => {
  privateResidentHeaders(c)
  const founder = await authRootKey(c)
  if (!founder) return err(c, 401, 'founder root key required')
  if (founder.id !== 1) return err(c, 403, 'only founder resident #1 may issue city fee credit')
  const body = await c.req.json().catch(() => null) as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return err(c, 400, 'body must be a JSON object')
  }
  const input = body as Record<string, unknown>
  if (
    !Object.keys(input).every(key => ['resident_handle', 'source_key', 'reason'].includes(key))
    || Object.keys(input).length !== 3
  ) return err(c, 400, 'city credit body contains an unsupported field')
  const residentHandle = typeof input.resident_handle === 'string' ? input.resident_handle : ''
  if (!HANDLE_RE.test(residentHandle)) return err(c, 400, 'resident_handle must be a resident handle')
  const residents = await sql`
    SELECT id FROM residents WHERE handle = ${residentHandle} LIMIT 1
  ` as Array<{ id: number }>
  const target = residents[0]
  if (!target) return err(c, 404, 'resident not found')
  try {
    const issued = await issueCityFeeCredit({ query: sql.query }, {
      founderId: founder.id,
      residentId: target.id,
      sourceKey: input.source_key as string,
      reason: input.reason as string,
    })
    return c.json({ resident_handle: residentHandle, city_fee_credit: issued },
      issued.disposition === 'created' ? 201 : 200)
  } catch (error) {
    if (error instanceof TypeError) return err(c, 400, error.message)
    if (error instanceof CityCreditConflictError) return err(c, 409, error.message)
    throw error
  }
})

app.post('/api/founder/city-credit/disputes/:disputeId/resolve', async c => {
  privateResidentHeaders(c)
  const founder = await authRootKey(c)
  if (!founder) return err(c, 401, 'founder root key required')
  if (founder.id !== 1) {
    return err(c, 403,
      'only founder resident #1 may resolve an ambiguous PayPal credit dispute')
  }
  if (Object.keys(c.req.queries()).length !== 0) {
    return err(c, 400, 'this founder PayPal dispute route accepts no query options')
  }
  const disputeId = c.req.param('disputeId')
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,254}$/u.test(disputeId)) {
    return err(c, 400, 'PayPal dispute id must be 1 to 255 letters, numbers, or hyphens')
  }
  if (declaredBodyLength(
    c.req.header('content-length'),
    FOUNDER_DISPUTE_REVIEW_BODY_BYTES,
  ) === 'unusable') {
    return err(c, 400,
      `The founder PayPal dispute body declared an unusable Content-Length. Declare one decimal byte count no larger than ${FOUNDER_DISPUTE_REVIEW_BODY_BYTES} bytes, or omit the header.`)
  }
  if (!await takePayPalCreditRateLimit(
    runtimeDatabase,
    sha256(`paypal-credit:founder-dispute-review:resident:${founder.id}`),
    FOUNDER_DISPUTE_REVIEWS_PER_HOUR,
  )) {
    c.header('Retry-After', '3600')
    return err(c, 429,
      'Too many founder PayPal dispute review requests were received. Retry in one hour.')
  }
  const bodyRead = await readFounderDisputeReviewBody(c)
  const mediaType = (c.req.header('content-type') ?? '')
    .split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return err(c, 400, 'send one application/json founder PayPal dispute body')
  }
  if (bodyRead.state === 'empty') {
    return err(c, 400, 'founder PayPal dispute body is empty; nothing changed')
  }
  if (bodyRead.state === 'oversized') {
    return err(c, 400,
      `founder PayPal dispute body is larger than ${FOUNDER_DISPUTE_REVIEW_BODY_BYTES} bytes; nothing changed`)
  }
  let body: unknown
  try {
    body = JSON.parse(bodyRead.bytes.toString('utf8')) as unknown
  } catch {
    return err(c, 400, 'founder PayPal dispute body must be valid JSON; nothing changed')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return err(c, 400, 'founder PayPal dispute body must be one JSON object')
  }
  const input = body as Record<string, unknown>
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'decision')) {
    return err(c, 400,
      'founder PayPal dispute body must contain exactly decision and no unsupported field')
  }
  if (input.decision !== 'seller_favour' && input.decision !== 'buyer_favour') {
    return err(c, 400, 'decision must be seller_favour or buyer_favour')
  }
  try {
    const resolution = await resolveFounderPayPalCreditDispute(runtimeDatabase, {
      founderId: founder.id,
      disputeId,
      decision: input.decision,
    })
    return c.json({
      paypal_dispute_resolution: {
        dispute_id: resolution.disputeId,
        decision: resolution.decision,
        state: resolution.state,
        disposition: resolution.disposition,
        application_outcome: resolution.applicationOutcome,
        local_purchase_count: resolution.localPurchaseCount,
        receipts_created: resolution.receiptsCreated,
      },
    }, resolution.disposition === 'created' ? 201 : 200)
  } catch (error) {
    if (error instanceof FounderPayPalDisputeResolutionError) {
      if (error.kind === 'not_found') return err(c, 404, error.message)
      if (error.kind === 'not_reviewable') {
        return err(c, 409,
          'This PayPal dispute is not in resolution_review and is not awaiting founder review. Nothing changed.')
      }
      return err(c, 409, error.message)
    }
    if (error instanceof PayPalCreditStoreConflictError) {
      return err(c, 409,
        'Durable PayPal dispute history rejected this founder decision. Nothing changed.')
    }
    if (error instanceof TypeError) return err(c, 400, error.message)
    throw error
  }
})

app.get('/api/founder/city-credit/:handle', async c => {
  privateResidentHeaders(c)
  const founder = await authRootKey(c)
  if (!founder) return err(c, 401, 'founder root key required')
  if (!(founder.id === 1)) return err(c, 403, 'only founder resident #1 may inspect city fee credit')
  const query = c.req.queries()
  const allowed = allowedPublicQuery(query, ['before_credit_id', 'credit_limit'])
  if (!allowed.ok) return err(c, 400, allowed.error)
  const creditRequest = cityCreditReadOptions(query)
  if (!creditRequest.ok) return err(c, 400, creditRequest.error)
  const residentHandle = c.req.param('handle')
  if (!HANDLE_RE.test(residentHandle)) return err(c, 400, 'handle must be a resident handle')
  const residents = await sql`
    SELECT id FROM residents WHERE handle = ${residentHandle} LIMIT 1
  ` as Array<{ id: number }>
  const target = residents[0]
  if (!target) return err(c, 404, 'resident not found')
  const [account, paypalDisputes] = await Promise.all([
    readCityCreditAccount({ query: sql.query }, target.id, {
      beforeId: creditRequest.beforeId,
      limit: creditRequest.limit,
    }),
    readFounderPayPalCreditDisputes({ query: sql.query }, target.id),
  ])
  return c.json({
    resident_handle: residentHandle,
    city_fee_credit: account,
    paypal_disputes: paypalDisputes,
  })
})

app.get('/api/founder/community-tool-submissions', async c => {
  privateResidentHeaders(c)
  const founder = await authRootKey(c)
  if (!founder) return err(c, 401, 'founder root key required')
  if (founder.id !== 1) {
    return err(c, 403, 'only founder resident #1 may read community tool submissions')
  }
  if (Object.keys(c.req.queries()).length !== 0) {
    return err(c, 400, 'the community tool queue accepts no query options')
  }
  const queue = await readCommunityToolQueue(executeCommunityToolQuery)
  return c.json({
    waiting_count: queue.waitingCount,
    submissions: queue.submissions,
  })
})

app.post('/api/founder/community-tool-submissions/:id/review', async c => {
  privateResidentHeaders(c)
  const founder = await authRootKey(c)
  if (!founder) return err(c, 401, 'founder root key required')
  if (founder.id !== 1) {
    return err(c, 403, 'only founder resident #1 may finish community tool review')
  }
  if (Object.keys(c.req.queries()).length !== 0) {
    return err(c, 400, 'the community tool review route accepts no query options')
  }
  const submissionId = positiveId(c.req.param('id'))
  if (submissionId === null) return err(c, 400, 'submission id must be a positive integer')
  if (declaredBodyLength(
    c.req.header('content-length'),
    COMMUNITY_TOOL_REVIEW_BODY_BYTES,
  ) === 'unusable') {
    return err(c, 400, `community tool review Content-Length must be one decimal byte count no larger than ${COMMUNITY_TOOL_REVIEW_BODY_BYTES}, or be omitted`)
  }
  const mediaType = (c.req.header('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return err(c, 400, 'send one application/json community tool review body')
  }
  const bodyBytes = Buffer.from(await c.req.arrayBuffer())
  if (bodyBytes.byteLength === 0 || bodyBytes.byteLength > COMMUNITY_TOOL_REVIEW_BODY_BYTES) {
    return err(c, 400, `community tool review body must be 1 to ${COMMUNITY_TOOL_REVIEW_BODY_BYTES} bytes`)
  }
  let body: unknown
  try {
    body = JSON.parse(bodyBytes.toString('utf8')) as unknown
  } catch {
    return err(c, 400, 'community tool review body must be valid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return err(c, 400, 'community tool review body must be one JSON object')
  }
  const input = body as Record<string, unknown>
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'outcome')) {
    return err(c, 400, 'community tool review body must contain exactly outcome')
  }
  if (input.outcome !== 'listed' && input.outcome !== 'declined') {
    return err(c, 400, 'community tool review outcome must be listed or declined')
  }
  const result = await reviewCommunityToolSubmission(
    executeCommunityToolQuery,
    submissionId,
    founder.id,
    input.outcome,
  )
  if (result.outcome === 'not_found') return err(c, 404, 'community tool submission not found')
  return c.json({
    submission_id: submissionId,
    outcome: result.reviewOutcome,
    disposition: result.outcome,
  })
})

app.get('/api/official', c => {
  const allowed = allowedPublicQuery(c.req.queries(), [])
  if (!allowed.ok) return err(c, 400, allowed.error)
  c.header('Cache-Control', 'no-store')
  return c.json(publicOfficialFacts({
    domain: DOMAIN,
    marketOrigin: process.env.MARKET_ORIGIN,
    deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA,
    identityBrowserReady: IDENTITY_BROWSER_READY,
    identityRecoveryEnabled: IDENTITY_RECOVERY_ENABLED,
    identityRotationEnabled: IDENTITY_ROTATION_ENABLED,
  }))
})

app.get('/api/physics', c => {
  const allowed = allowedPublicQuery(c.req.queries(), [])
  if (!allowed.ok) return err(c, 400, allowed.error)
  return c.json(publicPhysicsFacts())
})

app.get('/api/events', async c => {
  const queries = c.req.queries()
  const allowed = allowedPublicQuery(queries, [
    'kind', 'actor', 'place_id', 'within_place_id', 'before_id', 'limit',
    'after_change_marker', 'within_seconds',
  ])
  if (!allowed.ok) return err(c, 400, allowed.error)
  const parsed = parsePublicPage(queries, 'before_id', 'limit')
  if (!parsed.ok) return err(c, 400, parsed.error)
  const kindValue = singlePublicQueryValue(queries, 'kind')
  if (!kindValue.ok) return err(c, 400, kindValue.error)
  const kind = kindValue.value
  if (kind != null && !/^[a-z][a-z0-9_]{0,63}$/u.test(kind)) {
    return err(c, 400, 'kind must match a stored event kind')
  }
  const actorValue = singlePublicQueryValue(queries, 'actor')
  if (!actorValue.ok) return err(c, 400, actorValue.error)
  if (actorValue.value != null && !HANDLE_RE.test(actorValue.value)) {
    return err(c, 400, 'actor must be a resident handle')
  }
  const exactPlaceValue = singlePublicQueryValue(queries, 'place_id')
  if (!exactPlaceValue.ok) return err(c, 400, exactPlaceValue.error)
  const insidePlaceValue = singlePublicQueryValue(queries, 'within_place_id')
  if (!insidePlaceValue.ok) return err(c, 400, insidePlaceValue.error)
  if (exactPlaceValue.value !== null && insidePlaceValue.value !== null) {
    return err(c, 400, 'choose place_id or within_place_id, not both')
  }
  const placeValue = insidePlaceValue.value ?? exactPlaceValue.value
  const placeId = placeValue == null
    ? null
    : /^[0-9]+$/.test(placeValue) ? Number(placeValue) : null
  if (placeValue != null &&
      (placeId == null || placeId < 1 || placeId > 2_147_483_647)) {
    const field = insidePlaceValue.value !== null ? 'within_place_id' : 'place_id'
    return err(c, 400, `${field} must be a positive integer`)
  }
  const withinValue = singlePublicQueryValue(queries, 'within_seconds')
  if (!withinValue.ok) return err(c, 400, withinValue.error)
  const withinSeconds = withinValue.value === null || !/^[1-9][0-9]{0,3}$/u.test(withinValue.value)
    ? null
    : Number(withinValue.value)
  if (withinValue.value !== null &&
      (withinSeconds === null || withinSeconds > PUBLIC_EVENT_WITHIN_MAX_SECONDS)) {
    return err(c, 400,
      `within_seconds must be between 1 and ${PUBLIC_EVENT_WITHIN_MAX_SECONDS}`)
  }
  const afterMarkerValue = singlePublicQueryValue(queries, 'after_change_marker')
  if (!afterMarkerValue.ok) return err(c, 400, afterMarkerValue.error)
  const minimumMarker = afterMarkerValue.value === null
    ? null
    : parsePublicChangeMarker(afterMarkerValue.value)
  if (afterMarkerValue.value !== null && minimumMarker === null) {
    return err(c, 400, 'after_change_marker must be a nonnegative decimal bigint')
  }
  const readEvents = async () => {
    const collection = await loadPublicEventCollectionRows(
      executeBudgetedExactQuery,
      {
        kind: kind ?? null,
        actor: actorValue.value,
        placeId,
        includeDescendants: insidePlaceValue.value !== null,
        withinSeconds,
      },
      parsed,
    )
    const page = finalizePublicPage(
      collection.rows as Array<Record<string, unknown> & { id: number }>,
      parsed.limit,
    )
    return Object.freeze({
      events: await moderatePublicEvents(page.items),
      total_items: collection.total.items,
      total_text_bytes: collection.total.textBytes,
      returned_items: page.items.length,
      returned_text_bytes: eventDetailTextBytes(page.items),
      has_more: page.hasMore,
      next_before_id: page.nextCursor,
    })
  }
  let payload: Awaited<ReturnType<typeof readEvents>>
  let changeMarker: string | null = null
  try {
    if (minimumMarker === null) {
      payload = await readEvents()
    } else {
      const stable = await readAtStablePublicChangeCheckpoint(
        executePublicQuery,
        minimumMarker,
        readEvents,
      )
      payload = stable.value
      changeMarker = stable.changeMarker
    }
  } catch (error) {
    if (error instanceof PublicChangeFutureError ||
        error instanceof PublicChangeReadConflictError) {
      return err(c, 409, error.message)
    }
    throw error
  }
  if (minimumMarker !== null) c.header('Cache-Control', 'no-store')
  return c.json({
    ...payload,
    ...(changeMarker === null ? {} : { change_marker: changeMarker }),
  })
})

app.post('/api/flag', async c => {
  const resident = await auth(c)
  if ((c.req.header('authorization') || isHostedConnectorRequest(c.req.raw)) && !resident) {
    return err(c, 401, 'bad or missing bearer secret')
  }
  const body = await c.req.json().catch(() => null)
  const targetType = String(body?.target_type ?? '')
  const targetId = Number(body?.target_id)
  const reasonCandidate = String(body?.reason ?? '').trim()
  const reasonText = publicText(reasonCandidate, { maximumCharacters: 500 })
  const allowed = ['place', 'thing', 'kind', 'trait', 'note', 'agreement', 'resident']
  if (!allowed.includes(targetType) || !Number.isSafeInteger(targetId) || targetId < 1 || reasonText === null) {
    return err(c, 400, `need target_type (${allowed.join('|')}), target_id, and reason at most 500 characters of safe text`)
  }
  const reason = reasonText.trim()
  if (resident) {
    if (!(await takeFlagSlot(sha256(`flag:resident:${resident.id}`), RESIDENT_FLAGS_PER_HOUR))) {
      return err(c, 429, `${RESIDENT_FLAGS_PER_HOUR} resident flags per UTC hour`)
    }
  } else if (!(await takeFlagSlot(sha256(`flag:ip:${clientAddress(c)}`), ANONYMOUS_FLAGS_PER_IP_HOUR))) {
    return err(c, 429, `${ANONYMOUS_FLAGS_PER_IP_HOUR} anonymous flags per IP per UTC hour`)
  }
  const actor = resident?.handle ?? 'anonymous'
  await sql`
    WITH new_flag AS (
      INSERT INTO flags (reporter_id, target_type, target_id, reason)
      VALUES (${resident?.id ?? null}, ${targetType}, ${targetId}, ${reason})
      RETURNING id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'flag', ${actor}, jsonb_build_object(
        'flag_id', id, 'target_type', ${targetType}::text, 'target_id', ${targetId}::integer
      ) FROM new_flag
    )
    SELECT id FROM new_flag
  `
  return c.json({
    ok: true,
    note: 'flag recorded; the public event omits the report text',
  }, 201)
})

app.post('/api/moderation', async c => {
  const resident = await authRootKey(c)
  if (!resident) return err(c, 401, 'founder root key required')
  if (resident.id !== 1) {
    return err(c, 403, 'only founder resident #1 may remove or restore illegal public content')
  }
  const input = moderationInput(await c.req.json().catch(() => null))
  if (!input) {
    return err(c, 400, 'need exactly action (remove|restore), target_type, target_id, and a safe reason')
  }
  const recorded = await recordModeration(resident, input)
  if (!recorded) return err(c, 404, `${input.target_type} not found`)
  return c.json({ moderation: recorded }, 201)
})

app.get('/api/moderation', async c => {
  const queries = c.req.queries()
  const allowed = allowedPublicQuery(queries, ['before_id', 'limit'])
  if (!allowed.ok) return err(c, 400, allowed.error)
  const parsed = parsePublicPage(queries, 'before_id', 'limit')
  if (!parsed.ok) return err(c, 400, parsed.error)
  const rows = await moderationHistory(parsed.cursor, parsed.fetchLimit)
  const collection = extractPublicCollectionRows(rows)
  const page = finalizePublicPage(
    collection.rows as Array<Record<string, unknown> & { id: number }>,
    parsed.limit,
  )
  return c.json({
    moderation: page.items,
    total_items: collection.total.items,
    total_text_bytes: collection.total.textBytes,
    returned_items: page.items.length,
    returned_text_bytes: utf8TextBytes(page.items, 'reason'),
    has_more: page.hasMore,
    next_before_id: page.nextCursor,
  })
})

app.get('/treasury', async c => {
  const queries = c.req.queries()
  const allowed = allowedPublicQuery(queries, ['before_id', 'limit'])
  if (!allowed.ok) return err(c, 400, allowed.error)
  const parsed = parsePublicPage(queries, 'before_id', 'limit', undefined, 50)
  if (!parsed.ok) return err(c, 400, parsed.error)
  const rawFeeRows = await executeBudgetedExactQuery(`
      /* public:treasury-fees */
      WITH totals AS (
        SELECT count(*)::integer AS total_items,
          coalesce(sum(octet_length(purpose)), 0)::bigint AS total_text_bytes,
          coalesce(sum(amount_usdc), 0)::float8 AS collected
        FROM fees
      )
      SELECT page.id, page.amount_usdc, page.tx_hash, page.handle, page.purpose,
        page.created_at, totals.collected, totals.total_items AS n,
        totals.total_items, totals.total_text_bytes
      FROM totals
      LEFT JOIN LATERAL (
        SELECT f.id, f.amount_usdc::float8 AS amount_usdc, f.tx_hash,
          resident.handle, f.purpose, f.created_at
        FROM fees f
        JOIN residents resident ON resident.id = f.resident_id
        WHERE ($1::integer IS NULL OR f.id < $1::integer)
        ORDER BY f.id DESC
        LIMIT $2::integer
      ) page ON TRUE
      ORDER BY page.id DESC NULLS LAST
    `, [parsed.cursor, parsed.fetchLimit])
  const balance = await usdcBalance(TREASURY)
  const collection = extractPublicCollectionRows(rawFeeRows)
  const page = finalizePublicPage(
    collection.rows as Array<Record<string, unknown> & { id: number }>,
    parsed.limit,
  )
  const collected = Number(rawFeeRows[0]?.collected ?? 0)
  if (!Number.isFinite(collected) || collected < 0) throw new Error('treasury total is invalid')
  return c.json({
    address: TREASURY,
    network: NETWORK,
    usdc_balance_onchain: balance ?? 'rpc-unavailable — check the address yourself',
    fees_collected_usdc: collected,
    fees_count: collection.total.items,
    recent_fees: page.items,
    recent_fees_page: {
      total_items: collection.total.items,
      total_text_bytes: collection.total.textBytes,
      returned_items: page.items.length,
      returned_text_bytes: utf8TextBytes(page.items, 'purpose'),
      has_more: page.hasMore,
      next_before_id: page.nextCursor,
    },
    note:
      'Every fee is verifiable on-chain. Sales never pass through here — they are peer-to-peer, wallet to wallet. Donations buy nothing.',
  })
})

app.post('/mcp', async c => {
  return mcp(c, app)
})
app.post('/mcp/connect', async c => {
  if (!hostedChatSignin.ready) {
    return c.json(missingStreet(), 404)
  }
  const response = await mcp(c, app, { hostedChat: true, forwardUnauthorizedStatus: true })
  if (response.status === 401 && !response.headers.get('WWW-Authenticate')) {
    response.headers.set('WWW-Authenticate', oauthChallenge())
  }
  return response
})
app.get('/mcp', c => c.text('MCP endpoint. POST JSON-RPC 2.0 messages here.', 405))
app.get('/mcp/connect', c => hostedChatSignin.ready
  ? c.text('Hosted-chat MCP connector. POST JSON-RPC 2.0 messages here.', 405)
  : c.json(missingStreet(), 404))

app.notFound(c => c.json(missingStreet(), 404))

export default app
