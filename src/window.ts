import type { Context } from 'hono'
import { HANDLE_RE } from './core.ts'
import { sql } from './db.ts'
import { moderatePublicEvents } from './moderation-store.ts'
import { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS, WINDOW_JS } from './window-client.ts'
import { WINDOW_HTML } from './window-page.ts'
import { WINDOW_CSS } from './window-style.ts'

const WINDOW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'none'",
  "font-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join('; ')

const SAFE_EVENT_KINDS = new Set(PUBLIC_EVENT_KINDS)

export { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS }

const SAFE_DETAIL_IDS = [
  'resident_id',
  'place_id',
  'thing_id',
  'kind_id',
  'trait_id',
  'agreement_id',
  'note_id',
  'transfer_id',
  'offer_id',
  'flag_id',
  'target_id',
  'asset_id',
  'parent_id',
  'action_id',
  'effect_id',
  'pending_effect_id',
  'moderation_id',
] as const

interface PublicPlace {
  id: number
  parent_id: number | null
  name: string
  owner: string
  places: number
  things: number
  notes: number
  moderated: boolean
  children: PublicPlace[]
}

const MODERATED_PLACE_NAME = '[removed by maintainer]'

function harden(c: Context) {
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Resource-Policy', 'same-origin')
  c.header(
    'Permissions-Policy',
    'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), ' +
      'fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), ' +
      'payment=(), picture-in-picture=(), publickey-credentials-get=(), usb=()',
  )
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
}

const positiveInteger = (value: unknown) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

const count = (value: unknown) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function publicPlaceRow(value: unknown): Omit<PublicPlace, 'children'> | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = positiveInteger(row.id)
  const parentId = row.parent_id == null ? null : positiveInteger(row.parent_id)
  const moderated = row.moderated === true
  const name = moderated
    ? MODERATED_PLACE_NAME
    : (typeof row.name === 'string' ? row.name.slice(0, 120) : '')
  const owner = typeof row.owner === 'string' && HANDLE_RE.test(row.owner) ? row.owner : ''
  if (!id || !name || !owner || (row.parent_id != null && !parentId)) return null
  return {
    id,
    parent_id: parentId,
    name,
    owner,
    places: count(row.places),
    things: count(row.things),
    notes: count(row.notes),
    moderated,
  }
}

export function publicPlaceTree(values: unknown[]): PublicPlace[] {
  const rows = values.map(publicPlaceRow).filter(row => row !== null)
  const ids = new Set(rows.map(row => row.id))
  const build = (
    parentId: number | null,
    ancestors: ReadonlySet<number>,
    depth: number,
  ): PublicPlace[] => {
    if (depth >= 32) return []
    return rows
      .filter(row => row.parent_id === parentId && !ancestors.has(row.id))
      .map(row => ({
        ...row,
        children: build(row.id, new Set([...ancestors, row.id]), depth + 1),
      }))
  }
  const rootIds = rows
    .filter(row => row.parent_id === null || !ids.has(row.parent_id))
    .map(row => row.id)
  return rootIds.flatMap(id => {
    const row = rows.find(candidate => candidate.id === id)
    return row ? [{ ...row, children: build(row.id, new Set([row.id]), 1) }] : []
  })
}

function publicWindowEvent(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = positiveInteger(row.id)
  const kind = typeof row.kind === 'string' && SAFE_EVENT_KINDS.has(row.kind) ? row.kind : null
  const actor = typeof row.actor === 'string' && HANDLE_RE.test(row.actor) ? row.actor : null
  const at = typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) ? row.at : null
  if (!id || !kind || !actor || !at) return null

  const rawDetail = row.detail && typeof row.detail === 'object'
    ? row.detail as Record<string, unknown>
    : {}
  const detail: Record<string, number | string> = Object.fromEntries(SAFE_DETAIL_IDS.flatMap(key => {
    const safe = positiveInteger(rawDetail[key])
    return safe ? [[key, safe] as const] : []
  }))
  if (
    kind === 'moderation' &&
    ['remove', 'restore'].includes(String(rawDetail.action))
  ) {
    detail.action = String(rawDetail.action)
  }
  return { id, at, kind, actor, detail }
}

async function readWindowSnapshot() {
  const [placeRows, eventRows] = await Promise.all([
    sql.query(`
      WITH RECURSIVE world AS (
        SELECT id, parent_id, name, owner_id, ARRAY[id] AS path
        FROM places WHERE parent_id IS NULL
        UNION ALL
        SELECT child.id, child.parent_id, child.name, child.owner_id, world.path || child.id
        FROM places child JOIN world ON child.parent_id = world.id
        WHERE NOT child.id = ANY(world.path) AND cardinality(world.path) < 32
      )
      SELECT world.id, world.parent_id, world.name, residents.handle AS owner,
        (SELECT count(*)::int FROM places child WHERE child.parent_id = world.id) AS places,
        (SELECT count(*)::int FROM things thing
          WHERE thing.place_id = world.id AND thing.withdrawn_at IS NULL) AS things,
        (SELECT count(*)::int FROM notes note WHERE note.place_id = world.id) AS notes,
        coalesce(moderation.action = 'remove', false) AS moderated
      FROM world JOIN residents ON residents.id = world.owner_id
      LEFT JOIN LATERAL (
        SELECT action
        FROM moderation_actions
        WHERE target_type = 'place' AND target_id = world.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) moderation ON true
      ORDER BY world.path
      LIMIT 1000
    `),
    sql`
      SELECT id, at, kind, actor, detail
      FROM events
      WHERE kind = ANY(${PUBLIC_EVENT_KINDS}::text[])
      ORDER BY id DESC
      LIMIT 100
    `,
  ])
  const places = publicPlaceTree(placeRows as unknown[])
  const publicEvents = await moderatePublicEvents(eventRows as Record<string, unknown>[])
  const events = publicEvents.map(publicWindowEvent).filter(event => event !== null)
  return {
    places,
    events,
    totals: { places: (placeRows as unknown[]).length, events: events.length },
    refreshed_at: new Date().toISOString(),
  }
}

type WindowSnapshot = Awaited<ReturnType<typeof readWindowSnapshot>>
let snapshotCache: { expiresAt: number; pending: Promise<WindowSnapshot> } | null = null

async function cachedWindowSnapshot() {
  const now = Date.now()
  if (snapshotCache && snapshotCache.expiresAt > now) return snapshotCache.pending
  const pending = readWindowSnapshot()
  snapshotCache = { expiresAt: now + 30_000, pending }
  try {
    return await pending
  } catch (error) {
    if (snapshotCache?.pending === pending) snapshotCache = null
    throw error
  }
}

export async function windowSnapshot(c: Context) {
  const url = new URL(c.req.url)
  const hasCredentials = [
    'authorization',
    'proxy-authorization',
    'cookie',
    'x-payment',
    'x-api-key',
  ].some(name => Boolean(c.req.header(name)))
  if (url.search || hasCredentials) {
    return c.json({ error: 'the public city window accepts no query or credential data' }, 400)
  }
  const snapshot = await cachedWindowSnapshot()
  harden(c)
  c.header('Cache-Control', 'public, max-age=15, s-maxage=60, stale-while-revalidate=300')
  return c.json(snapshot)
}

export function windowPage(c: Context) {
  harden(c)
  c.header('Content-Security-Policy', WINDOW_CSP)
  c.header('Cache-Control', 'public, max-age=0, must-revalidate')
  return c.html(WINDOW_HTML)
}

export function windowStyle(c: Context) {
  harden(c)
  c.header('Cache-Control', 'public, max-age=0, must-revalidate')
  return c.body(WINDOW_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' })
}

export function windowScript(c: Context) {
  harden(c)
  c.header('Cache-Control', 'public, max-age=0, must-revalidate')
  return c.body(WINDOW_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
}
