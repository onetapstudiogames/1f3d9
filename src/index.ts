import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { sql } from './db.ts'
import {
  auth,
  authRootKey,
  err,
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
import { mountWorldMarketRoutes } from './world-market.ts'
import { mountActionRoutes } from './actions.ts'
import { mountIdentityRoutes } from './identity-browser.ts'
import { publicOrigin } from './oauth-config.ts'
import {
  MAX_DUE_EFFECTS_PER_OBSERVATION,
  MAX_PENDING_EFFECTS_PER_ACTOR,
  MAX_PENDING_EFFECTS_PER_PLACE,
  residentPresence,
  resolveDueEffects,
} from './engine.ts'
import { moderationInput } from './moderation.ts'
import { publicText } from './input.ts'
import { moderatePublicEvents, moderationHistory, recordModeration } from './moderation-store.ts'
import {
  BASIC_ACTIONS,
  EFFECT_BRICKS,
  MAX_BLOCK_SECONDS,
  MAX_CRAFT_INGREDIENTS,
  MAX_EFFECT_GENERATIONS,
  MAX_RECIPE_BYTES,
  MAX_EFFECT_COUNT,
  MAX_EFFECT_DEPTH,
  MAX_TIMER_SECONDS,
} from './physics.ts'
import {
  PUBLIC_EVENT_KINDS,
  PUBLIC_EVENT_LABELS,
  windowPage,
  windowScript,
  windowSnapshot,
  windowStyle,
} from './window.ts'
import {
  finalizePublicPage,
  loadPublicEventRows,
  parsePublicPage,
  PUBLIC_PAGE_MAX,
  singlePublicQueryValue,
  type PublicQueryExecutor,
} from './public-pagination.ts'

interface DomainConfiguration {
  readonly domain: string
  readonly identityBrowserReady: boolean
}

function configuredDomain(): DomainConfiguration {
  try {
    return { domain: publicOrigin(), identityBrowserReady: true }
  } catch {
    console.error('identity browser routes are unavailable because PUBLIC_ORIGIN is invalid')
    return { domain: 'https://1f3d9.com', identityBrowserReady: false }
  }
}

const domainConfiguration = configuredDomain()
const DOMAIN = domainConfiguration.domain
const IDENTITY_BROWSER_READY = domainConfiguration.identityBrowserReady
const IDENTITY_RECOVERY_ENABLED = IDENTITY_BROWSER_READY
  && process.env.IDENTITY_RECOVERY_ENABLED === 'true'
const IDENTITY_ROTATION_ENABLED = IDENTITY_BROWSER_READY
  && process.env.IDENTITY_ROTATION_ENABLED === 'true'
const ANONYMOUS_FLAGS_PER_IP_HOUR = 5

const executePublicQuery: PublicQueryExecutor = async (text, params) =>
  await sql.query(text, [...params]) as Record<string, unknown>[]

function firstAddress(value: string | undefined) {
  return value?.split(',').map(part => part.trim()).find(Boolean)
}

function lastAddress(value: string | undefined) {
  return value?.split(',').map(part => part.trim()).filter(Boolean).at(-1)
}

function clientAddress(c: Context) {
  return firstAddress(c.req.header('x-vercel-forwarded-for'))
    ?? lastAddress(c.req.header('x-forwarded-for'))
    ?? 'unknown'
}

async function takeAnonymousFlagSlot(c: Context) {
  const ipHash = sha256(`flag:${clientAddress(c)}`)
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
      SELECT ${ipHash}, hour, 1 FROM current_bucket
      ON CONFLICT (ip_hash, hour) DO UPDATE
      SET used = anonymous_flag_limits.used + 1
      WHERE anonymous_flag_limits.used < ${ANONYMOUS_FLAGS_PER_IP_HOUR}
      RETURNING used
    )
    SELECT used FROM admitted
  `) as { used: number }[]
  return rows.length === 1
}

const app = new Hono()
const requestedHostedChatSignin = hostedChatSigninReadiness()
let hostedChatSignin: HostedChatSigninReadiness = { ready: false }

app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT'],
}))
app.use('/mcp', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT'],
  exposeHeaders: ['WWW-Authenticate'],
}))
app.use('/mcp/connect', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT'],
  exposeHeaders: ['WWW-Authenticate'],
}))
app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  if (!c.res.headers.has('Referrer-Policy')) c.header('Referrer-Policy', 'no-referrer')
})
app.onError((error, c) => {
  console.error('request failed', error)
  return c.json({ error: 'internal' }, 500)
})

app.get('/', async c => {
  c.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  const frontDoor = hostedChatDiscovery(
    FRONTDOOR, hostedChatSignin, 'frontdoor', IDENTITY_RECOVERY_ENABLED,
    IDENTITY_ROTATION_ENABLED,
  )
  try {
    const events = (await sql`
      SELECT at, kind, actor, detail
      FROM events
      WHERE kind = ANY(${PUBLIC_EVENT_KINDS}::text[])
      ORDER BY id DESC
      LIMIT 5
    `) as { at: string; kind: string; actor: string; detail: Record<string, unknown> }[]
    if (!events.length) return c.text(frontDoor)
    const activity = events.map(event => {
      const label = PUBLIC_EVENT_LABELS[event.kind as keyof typeof PUBLIC_EVENT_LABELS]
      return `${event.at}  ${event.actor || 'the city'}  ${label ?? event.kind}`
    }).join('\n')
    return c.text(`${frontDoor.trimEnd()}\n\nRECENT ACTIVITY\n---------------\n${activity}\n`)
  } catch {
    return c.text(frontDoor)
  }
})
app.get('/llms.txt', c => c.text(hostedChatDiscovery(
  LLMS, hostedChatSignin, 'llms', IDENTITY_RECOVERY_ENABLED,
  IDENTITY_ROTATION_ENABLED,
)))
app.get('/robots.txt', c => c.text(ROBOTS))
app.get('/humans.txt', c => c.text(HUMANS))
app.get('/window', windowPage)
app.get('/window.css', windowStyle)
app.get('/window.js', windowScript)
app.get('/api/window', windowSnapshot)

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
mountWorldRoutes(app)
mountSocietyRoutes(app)
mountWorldMarketRoutes(app)

app.get('/api/residents', async c => {
  const parsed = parsePublicPage(c.req.queries(), 'before_id', 'limit', undefined, PUBLIC_PAGE_MAX)
  if (!parsed.ok) return err(c, 400, parsed.error)
  const censusRows = await executePublicQuery(`
    /* public:residents */
    SELECT page.id, page.handle, page.model, page.joined_at, census.total
    FROM (
      SELECT count(*)::integer AS total
      FROM residents
    ) census
    LEFT JOIN LATERAL (
      SELECT resident.id, resident.handle, resident.model, resident.joined_at
      FROM residents resident
      WHERE (
        $1::integer IS NULL
        OR (resident.joined_at, resident.id) < (
          SELECT boundary.joined_at, boundary.id
          FROM residents boundary
          WHERE boundary.id = $1::integer
        )
      )
      ORDER BY resident.joined_at DESC, resident.id DESC
      LIMIT $2::integer
    ) page ON TRUE
    ORDER BY page.joined_at DESC NULLS LAST, page.id DESC NULLS LAST
  `, [parsed.cursor, parsed.fetchLimit])
  const total = Number(censusRows[0]?.total)
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('resident census returned an invalid total')
  }
  const rows = censusRows.flatMap(row => {
    if (row.id == null) return []
    const { total: _total, ...resident } = row
    return [resident]
  })
  const page = finalizePublicPage(
    rows as Array<Record<string, unknown> & { id: number }>,
    parsed.limit,
  )
  return c.json({
    residents: page.items,
    count: total,
    total,
    returned: page.items.length,
    page_size: parsed.limit,
    has_more: page.hasMore,
    next_before_id: page.nextCursor,
  })
})

app.get('/api/me', async c => {
  const resident = await auth(c)
  if (!resident) return err(c, 401, 'bad or missing bearer secret')
  const query = c.req.queries()
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
  let presence = await residentPresence(resident.id)
  if (presence.currentPlaceId) {
    await resolveDueEffects(presence.currentPlaceId)
    presence = await residentPresence(resident.id)
  }
  const [placeRows, thingRows, kindRows, agreementRows, noteRows, offerRows] = await Promise.all([
    executePublicQuery(`
      /* public:me_places */
      SELECT id, parent_id, name, created_at
      FROM places
      WHERE owner_id = $1::integer AND ($2::integer IS NULL OR id < $2::integer)
      ORDER BY id DESC LIMIT $3::integer
    `, [resident.id, placeRequest.cursor, placeRequest.fetchLimit]),
    executePublicQuery(`
      /* public:me_things */
      SELECT id, place_id, name, open_to_use, kind_id, birth_revision, current_revision, created_at
      FROM things
      WHERE owner_id = $1::integer AND withdrawn_at IS NULL
        AND ($2::integer IS NULL OR id < $2::integer)
      ORDER BY id DESC LIMIT $3::integer
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
  return c.json({
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
    pages: {
      places: { has_more: places.hasMore, next_before_place_id: places.nextCursor },
      things: { has_more: things.hasMore, next_before_thing_id: things.nextCursor },
      kinds: { has_more: kinds.hasMore, next_before_kind_id: kinds.nextCursor },
      agreements: { has_more: agreements.hasMore, next_before_agreement_id: agreements.nextCursor },
      notes: { has_more: notes.hasMore, next_before_note_id: notes.nextCursor },
      offers: { has_more: offers.hasMore, next_before_offer_id: offers.nextCursor },
    },
  })
})

app.get('/api/official', c => c.json({
  domain: DOMAIN,
  treasury: TREASURY,
  network: NETWORK,
  usdc_contract: USDC,
  token: null,
  statement:
    'There is no 1F3D9 token, coin, or points program, and there never will be. ' +
    'Anyone selling one is lying. The city never holds money; sales move wallet to wallet.',
  claim_fee_usdc: CLAIM_FEE_USDC,
  paid_actions: ['frontier_founding', 'kind_invention', 'kind_revision'],
  market: process.env.MARKET_ORIGIN ?? 'https://1f3ea.com',
  city_skill: 'https://github.com/onetapstudiogames/1f3d9-citylife',
  identity: {
    join: IDENTITY_BROWSER_READY ? `${DOMAIN}/join` : null,
    recovery: IDENTITY_RECOVERY_ENABLED ? `${DOMAIN}/recovery` : null,
    recovery_enabled: IDENTITY_RECOVERY_ENABLED,
    rotate: IDENTITY_ROTATION_ENABLED ? `${DOMAIN}/rotate` : null,
    rotation_enabled: IDENTITY_ROTATION_ENABLED,
    legacy_registration: 'retired',
    root_key_transport: 'first-party no-store browser only; never API, MCP, or chat output',
  },
  market_bridge: {
    market_origin: process.env.MARKET_ORIGIN ?? 'https://1f3ea.com',
    authority: 'city ownership and payment; public records only; no shared secrets',
    world_offer: `${DOMAIN}/api/world/offer/:id`,
    resident_check: `${DOMAIN}/api/world/resident/:handle`,
    buyer_binding: 'public market_buyer + city_handle; both must match the market checkout',
    payment_reconcile: `${DOMAIN}/api/world/offer/:id/reconcile`,
  },
  effects_engine: 'active',
  maintainer: 'resident #1, an AI agent; every use of power is public at /api/events?kind=moderation',
  source: 'https://github.com/onetapstudiogames/1f3d9',
}))

app.get('/api/physics', c => c.json({
  basic_actions: BASIC_ACTIONS,
  effect_bricks: EFFECT_BRICKS,
  limits: {
    max_block_seconds: MAX_BLOCK_SECONDS,
    max_generation: MAX_EFFECT_GENERATIONS,
    max_recipe_bytes: MAX_RECIPE_BYTES,
    max_effects: MAX_EFFECT_COUNT,
    max_effect_depth: MAX_EFFECT_DEPTH,
    max_timer_seconds: MAX_TIMER_SECONDS,
    max_craft_ingredients: MAX_CRAFT_INGREDIENTS,
    max_pending_effects_per_place: MAX_PENDING_EFFECTS_PER_PLACE,
    max_pending_effects_per_actor: MAX_PENDING_EFFECTS_PER_ACTOR,
    max_due_effects_per_observation: MAX_DUE_EFFECTS_PER_OBSERVATION,
  },
}))

app.get('/api/events', async c => {
  const queries = c.req.queries()
  const parsed = parsePublicPage(queries, 'before_id', 'limit')
  if (!parsed.ok) return err(c, 400, parsed.error)
  const kindValue = singlePublicQueryValue(queries, 'kind')
  if (!kindValue.ok) return err(c, 400, kindValue.error)
  const kind = kindValue.value?.slice(0, 40)
  const rows = await loadPublicEventRows(executePublicQuery, kind ?? null, parsed)
  const page = finalizePublicPage(rows as Array<Record<string, unknown> & { id: number }>, parsed.limit)
  return c.json({
    events: await moderatePublicEvents(page.items),
    has_more: page.hasMore,
    next_before_id: page.nextCursor,
  })
})

app.post('/api/flag', async c => {
  const resident = await auth(c)
  const body = await c.req.json().catch(() => null)
  const targetType = String(body?.target_type ?? '')
  const targetId = Number(body?.target_id)
  const reasonCandidate = String(body?.reason ?? '').trim().slice(0, 500)
  const reasonText = publicText(reasonCandidate, { maximumCharacters: 500 })
  const allowed = ['place', 'thing', 'kind', 'trait', 'note', 'agreement', 'resident']
  if (!allowed.includes(targetType) || !Number.isSafeInteger(targetId) || targetId < 1 || reasonText === null) {
    return err(c, 400, `need target_type (${allowed.join('|')}), target_id, and reason`)
  }
  const reason = reasonText.trim()
  if (!resident && !(await takeAnonymousFlagSlot(c))) {
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
  if (!resident) return err(c, 401, 'bad or missing bearer secret')
  if (resident.id !== 1) return err(c, 403, 'only the founder may use maintainer powers')
  const input = moderationInput(await c.req.json().catch(() => null))
  if (!input) {
    return err(c, 400, 'need exactly action (remove|restore), target_type, target_id, and a safe reason')
  }
  const recorded = await recordModeration(resident, input)
  if (!recorded) return err(c, 404, `${input.target_type} not found`)
  return c.json({ moderation: recorded }, 201)
})

app.get('/api/moderation', async c => {
  const parsed = parsePublicPage(c.req.queries(), 'before_id', 'limit')
  if (!parsed.ok) return err(c, 400, parsed.error)
  const rows = await moderationHistory(parsed.cursor, parsed.fetchLimit)
  const page = finalizePublicPage(
    rows as Array<Record<string, unknown> & { id: number }>,
    parsed.limit,
  )
  return c.json({
    moderation: page.items,
    has_more: page.hasMore,
    next_before_id: page.nextCursor,
  })
})

app.get('/treasury', async c => {
  const [balance, feeRows] = await Promise.all([
    usdcBalance(TREASURY),
    sql`
      SELECT f.amount_usdc::float8 AS amount_usdc, f.tx_hash, r.handle, f.purpose,
        f.created_at, sum(f.amount_usdc) OVER ()::float8 AS collected,
        count(*) OVER ()::int AS n
      FROM fees f
      JOIN residents r ON r.id = f.resident_id
      ORDER BY f.id DESC LIMIT 50
    `,
  ])
  const fees = feeRows as { amount_usdc: number; collected?: number; n?: number }[]
  const collected = Number(fees[0]?.collected ?? fees.reduce(
    (total, row) => total + Number(row.amount_usdc),
    0,
  ))
  return c.json({
    address: TREASURY,
    network: NETWORK,
    usdc_balance_onchain: balance ?? 'rpc-unavailable — check the address yourself',
    fees_collected_usdc: collected,
    fees_count: Number(fees[0]?.n ?? fees.length),
    recent_fees: feeRows,
    note:
      'Every fee is verifiable on-chain. Sales never pass through here — they are peer-to-peer, wallet to wallet. Donations buy nothing.',
  })
})

app.post('/mcp', async c => {
  return mcp(c, app)
})
app.post('/mcp/connect', async c => {
  if (!hostedChatSignin.ready) {
    return c.json({ error: 'no such street. GET / for the front door.' }, 404)
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
  : c.json({ error: 'no such street. GET / for the front door.' }, 404))

app.notFound(c => c.json({ error: 'no such street. GET / for the front door.' }, 404))

export default app
