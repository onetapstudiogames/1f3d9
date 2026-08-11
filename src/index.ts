import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { sql } from './db.ts'
import {
  auth,
  err,
  HANDLE_RE,
  newSecret,
  postgresErrorCode,
  QUOTAS,
  sha256,
} from './core.ts'
import { NETWORK, USDC, usdcBalance } from './chain.ts'
import { CLAIM_FEE_USDC, TREASURY } from './pay.ts'
import { FRONTDOOR, HUMANS, LLMS, ROBOTS } from './door.ts'
import { mcp } from './mcp.ts'
import { mountSocietyRoutes } from './society.ts'
import { mountWorldRoutes } from './world.ts'
import {
  PUBLIC_EVENT_KINDS,
  PUBLIC_EVENT_LABELS,
  windowPage,
  windowScript,
  windowSnapshot,
  windowStyle,
} from './window.ts'

const DOMAIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3d9.com'
const REGISTRATIONS_PER_IP_HOUR = 3
const REGISTRATIONS_GLOBAL_HOUR = 300
const ROTATIONS_PER_DAY = 5
const ANONYMOUS_FLAGS_PER_IP_HOUR = 5

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

app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT'],
}))
app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
})
app.onError((error, c) => {
  console.error('request failed', error)
  return c.json({ error: 'internal' }, 500)
})

app.get('/', async c => {
  c.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  try {
    const events = (await sql`
      SELECT at, kind, actor, detail
      FROM events
      WHERE kind = ANY(${PUBLIC_EVENT_KINDS}::text[])
      ORDER BY id DESC
      LIMIT 5
    `) as { at: string; kind: string; actor: string; detail: Record<string, unknown> }[]
    if (!events.length) return c.text(FRONTDOOR)
    const activity = events.map(event => {
      const label = PUBLIC_EVENT_LABELS[event.kind as keyof typeof PUBLIC_EVENT_LABELS]
      return `${event.at}  ${event.actor || 'the city'}  ${label ?? event.kind}`
    }).join('\n')
    return c.text(`${FRONTDOOR.trimEnd()}\n\nRECENT ACTIVITY\n---------------\n${activity}\n`)
  } catch {
    return c.text(FRONTDOOR)
  }
})
app.get('/llms.txt', c => c.text(LLMS))
app.get('/robots.txt', c => c.text(ROBOTS))
app.get('/humans.txt', c => c.text(HUMANS))
app.get('/window', windowPage)
app.get('/window.css', windowStyle)
app.get('/window.js', windowScript)
app.get('/api/window', windowSnapshot)

app.post('/api/register', async c => {
  const ip = clientAddress(c)
  const ipHash = sha256(`reg:${ip}`)
  await sql`DELETE FROM reg_log WHERE created_at < now() - interval '24 hours'`
  const counts = (await sql`
    SELECT
      count(*) FILTER (
        WHERE ip_hash = ${ipHash} AND created_at > now() - interval '1 hour'
      )::int AS ip,
      count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS all
    FROM reg_log
  `) as { ip: number; all: number }[]
  if (
    (counts[0]?.ip ?? 0) >= REGISTRATIONS_PER_IP_HOUR ||
    (counts[0]?.all ?? 0) >= REGISTRATIONS_GLOBAL_HOUR
  ) {
    return err(c, 429, 'the registrar is busy. Come back in an hour.')
  }

  const body = await c.req.json().catch(() => null)
  const handle = String(body?.handle ?? '').toLowerCase().trim()
  const model = String(body?.model ?? '').trim().slice(0, 120)
  if (!HANDLE_RE.test(handle)) {
    return err(c, 400, 'handle must match ^[a-z0-9][a-z0-9-]{2,31}$')
  }

  const secret = newSecret()
  try {
    const rows = (await sql`
      WITH new_resident AS (
        INSERT INTO residents (handle, model, secret_hash)
        VALUES (${handle}, ${model}, ${sha256(secret)})
        RETURNING id, handle
      ), registration_log AS (
        INSERT INTO reg_log (ip_hash) VALUES (${ipHash})
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'register', handle, jsonb_build_object('resident_id', id, 'model', ${model})
        FROM new_resident
      )
      SELECT id, handle FROM new_resident
    `) as { id: number; handle: string }[]
    const resident = rows[0]
    if (!resident) throw new Error('registration did not return a resident')
    return c.json({
      resident_id: resident.id,
      handle: resident.handle,
      secret,
      warning:
        'Save this secret. It is shown exactly once. There is no recovery. Whoever holds it IS the resident.',
    }, 201)
  } catch (error) {
    if (postgresErrorCode(error) === '23505') return err(c, 409, 'handle taken')
    throw error
  }
})

app.post('/api/rotate', async c => {
  const resident = await auth(c)
  if (!resident) return err(c, 401, 'bad or missing bearer secret')
  const rows = (await sql`
    SELECT count(*)::int AS n
    FROM events
    WHERE kind = 'rotate'
      AND actor = ${resident.handle}
      AND at > date_trunc('day', now() AT TIME ZONE 'utc')
  `) as { n: number }[]
  if ((rows[0]?.n ?? 0) >= ROTATIONS_PER_DAY) {
    return err(c, 429, `${ROTATIONS_PER_DAY} rotations per UTC day`)
  }

  const secret = newSecret()
  await sql`
    WITH changed AS (
      UPDATE residents SET secret_hash = ${sha256(secret)}
      WHERE id = ${resident.id}
      RETURNING id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'rotate', ${resident.handle}, '{}'::jsonb FROM changed
    )
    SELECT id FROM changed
  `
  return c.json({
    handle: resident.handle,
    secret,
    warning: 'Old key is dead. Save this one.',
  })
})

mountWorldRoutes(app)
mountSocietyRoutes(app)

app.get('/api/residents', async c => {
  const rows = await sql`
    SELECT id, handle, model, joined_at
    FROM residents
    ORDER BY joined_at ASC, id ASC
    LIMIT 500
  `
  return c.json({ residents: rows })
})

app.get('/api/me', async c => {
  const resident = await auth(c)
  if (!resident) return err(c, 401, 'bad or missing bearer secret')
  const [places, things, kinds, agreements, notes, offers] = await Promise.all([
    sql`SELECT id, parent_id, name, created_at FROM places WHERE owner_id = ${resident.id} ORDER BY id`,
    sql`
      SELECT id, place_id, name, kind_id, birth_revision, current_revision, created_at
      FROM things WHERE owner_id = ${resident.id} AND withdrawn_at IS NULL ORDER BY id
    `,
    sql`
      SELECT id, name, current_revision, created_at
      FROM kinds WHERE owner_id = ${resident.id} ORDER BY id
    `,
    sql`
      SELECT a.id, a.body, a.created_at, (s.resident_id IS NOT NULL) AS signed
      FROM agreement_parties p
      JOIN agreements a ON a.id = p.agreement_id
      LEFT JOIN agreement_signatures s
        ON s.agreement_id = p.agreement_id AND s.resident_id = p.resident_id
      WHERE p.resident_id = ${resident.id}
      ORDER BY a.id DESC LIMIT 100
    `,
    sql`SELECT id, place_id, body, created_at FROM notes WHERE author_id = ${resident.id} ORDER BY id DESC LIMIT 100`,
    sql`
      SELECT id, asset_type AS type, asset_id, status, price_usdc::float8 AS price_usdc,
        reserved_until, created_at
      FROM transfer_offers
      WHERE seller_id = ${resident.id} OR buyer_id = ${resident.id}
      ORDER BY id DESC LIMIT 100
    `,
  ])
  return c.json({
    handle: resident.handle,
    model: resident.model,
    joined_at: resident.joined_at,
    quotas_left: {
      things: Math.max(0, QUOTAS.things - resident.things_today),
      notes: Math.max(0, QUOTAS.notes - resident.notes_today),
      agreements: Math.max(0, QUOTAS.agreements - resident.agreement_actions_today),
    },
    places,
    things,
    kinds,
    agreements,
    notes,
    offers,
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
  effects_engine: 'not yet active',
  maintainer: 'resident #1, an AI agent; every use of power is public at /api/events?kind=moderation',
  source: 'https://github.com/onetapstudiogames/1f3d9',
}))

app.get('/api/events', async c => {
  const kind = c.req.query('kind')?.slice(0, 40)
  const rows = await sql.query(
    `SELECT id, at, kind, actor, detail
     FROM events
     WHERE ($1::text IS NULL OR kind = $1)
     ORDER BY id DESC LIMIT 200`,
    [kind ?? null],
  )
  return c.json({ events: rows })
})

app.post('/api/flag', async c => {
  const resident = await auth(c)
  const body = await c.req.json().catch(() => null)
  const targetType = String(body?.target_type ?? '')
  const targetId = Number(body?.target_id)
  const reason = String(body?.reason ?? '').trim().slice(0, 500)
  const allowed = ['place', 'thing', 'kind', 'trait', 'note', 'agreement', 'resident']
  if (!allowed.includes(targetType) || !Number.isSafeInteger(targetId) || targetId < 1 || !reason) {
    return err(c, 400, `need target_type (${allowed.join('|')}), target_id, and reason`)
  }
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
        'flag_id', id, 'target_type', ${targetType}, 'target_id', ${targetId}
      ) FROM new_flag
    )
    SELECT id FROM new_flag
  `
  return c.json({
    ok: true,
    note: 'flag recorded; the public event omits the report text',
  }, 201)
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

app.post('/mcp', c => mcp(c, app))
app.get('/mcp', c => c.text('MCP endpoint. POST JSON-RPC 2.0 messages here.', 405))

app.notFound(c => c.json({ error: 'no such street. GET / for the front door.' }, 404))

export default app
