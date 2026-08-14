import type { Context } from 'hono'
import { HANDLE_RE, WORLD_NAME_RE } from './core.ts'
import { sql } from './db.ts'
import { publicText } from './input.ts'
import { MODERATED_TEXT } from './moderation.ts'
import {
  moderatePlaceDetails,
  moderatePublicEvents,
  moderatePublicKinds,
  moderatePublicRows,
} from './moderation-store.ts'
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
const UNSAFE_PUBLIC_OUTPUT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u
const WINDOW_LIMITS = Object.freeze({
  places: 1_000,
  residents: 2_000,
  conversations: 1_000,
  things: 1_000,
  agreements: 100,
  events: 100,
})

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
  description: string
  owner: string
  places: number
  things: number
  notes: number
  moderated: boolean
  children: PublicPlace[]
}

interface PublicResident {
  id: number
  handle: string
  current_place_id: number | null
  joined_at: string
}

interface PublicNote {
  id: number
  place_id: number
  author: string
  body: string
  created_at: string
  moderated: boolean
  truncated?: true
}

interface PublicThing {
  id: number
  place_id: number
  name: string
  body: string
  owner: string
  kind: string | null
  traits: string[]
  created_at: string
  moderated: boolean
  kind_moderated: boolean
  truncated?: true
}

interface PublicAgreement {
  id: number
  body: string
  created_by: string
  parties: string[]
  signatures: string[]
  open: boolean
  created_at: string
  moderated: boolean
  truncated?: true
}

const MODERATED_PLACE_NAME = MODERATED_TEXT

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

export function publicWindowTotals(
  value: Readonly<Record<string, unknown>>,
  shown: Readonly<Record<keyof typeof WINDOW_LIMITS, number>>,
): Record<keyof typeof WINDOW_LIMITS, number> {
  return Object.fromEntries(Object.keys(WINDOW_LIMITS).map(key => {
    const name = key as keyof typeof WINDOW_LIMITS
    return [name, Math.max(count(value[name]), shown[name])]
  })) as Record<keyof typeof WINDOW_LIMITS, number>
}

function safeDate(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function safePublicText(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): { text: string; truncated: boolean } | null {
  if (typeof value !== 'string') return null
  let normalized: string
  try {
    normalized = value.normalize('NFC').trim()
  } catch {
    return null
  }
  if (
    (!allowEmpty && !normalized) ||
    UNSAFE_PUBLIC_OUTPUT.test(normalized) ||
    publicText(normalized, { allowEmpty }) === null
  ) return null
  return { text: normalized.slice(0, maximum), truncated: normalized.length > maximum }
}

function safeWorldName(value: unknown): string | null {
  return typeof value === 'string' && (WORLD_NAME_RE.test(value) || value === MODERATED_TEXT)
    ? value
    : null
}

function safeHandles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(item => typeof item === 'string' && HANDLE_RE.test(item)))].slice(0, 32)
}

function publicPlaceRow(value: unknown): Omit<PublicPlace, 'children'> | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = positiveInteger(row.id)
  const parentId = row.parent_id == null ? null : positiveInteger(row.parent_id)
  const moderated = row.moderated === true
  const name = moderated
    ? MODERATED_PLACE_NAME
    : safePublicText(row.name, 120)?.text ?? ''
  const description = moderated
    ? ''
    : safePublicText(row.description, 4_000, true)?.text ?? ''
  const owner = typeof row.owner === 'string' && HANDLE_RE.test(row.owner) ? row.owner : ''
  if (!id || !name || !owner || (row.parent_id != null && !parentId)) return null
  return {
    id,
    parent_id: parentId,
    name,
    description,
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

export function publicWindowResidents(values: unknown[]): PublicResident[] {
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const id = positiveInteger(row.id)
    const handle = typeof row.handle === 'string' && HANDLE_RE.test(row.handle) ? row.handle : null
    const joinedAt = safeDate(row.joined_at)
    const currentPlaceId = row.current_place_id == null ? null : positiveInteger(row.current_place_id)
    if (!id || !handle || !joinedAt || (row.current_place_id != null && !currentPlaceId)) return []
    return [{ id, handle, current_place_id: currentPlaceId, joined_at: joinedAt }]
  }).slice(0, 2_000)
}

export function publicWindowNotes(values: unknown[]): PublicNote[] {
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const id = positiveInteger(row.id)
    const placeId = positiveInteger(row.place_id)
    const author = typeof row.author === 'string' && HANDLE_RE.test(row.author) ? row.author : null
    const body = safePublicText(row.body, 2_000)
    const createdAt = safeDate(row.created_at)
    if (!id || !placeId || !author || !body || !createdAt) return []
    return [{
      id,
      place_id: placeId,
      author,
      body: body.text,
      created_at: createdAt,
      moderated: row.moderated === true,
      ...(body.truncated ? { truncated: true as const } : {}),
    }]
  }).slice(0, 1_000)
}

export function publicWindowThings(values: unknown[]): PublicThing[] {
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const id = positiveInteger(row.id)
    const placeId = positiveInteger(row.place_id)
    const name = safePublicText(row.name, 120)
    const body = safePublicText(row.body, 1_000, true)
    const owner = typeof row.owner === 'string' && HANDLE_RE.test(row.owner) ? row.owner : null
    const kind = row.kind == null ? null : safeWorldName(row.kind)
    const createdAt = safeDate(row.created_at)
    if (!id || !placeId || !name || !body || !owner || !createdAt || (row.kind != null && !kind)) return []
    const traits = Array.isArray(row.traits)
      ? [...new Set(row.traits.flatMap(trait => safeWorldName(trait) ?? []))].slice(0, 32)
      : []
    return [{
      id,
      place_id: placeId,
      name: name.text,
      body: body.text,
      owner,
      kind,
      traits,
      created_at: createdAt,
      moderated: row.moderated === true,
      kind_moderated: row.kind_moderated === true,
      ...(body.truncated ? { truncated: true as const } : {}),
    }]
  }).slice(0, 1_000)
}

export function publicWindowAgreements(values: unknown[]): PublicAgreement[] {
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const id = positiveInteger(row.id)
    const body = safePublicText(row.body, 4_000)
    const createdBy = typeof row.created_by === 'string' && HANDLE_RE.test(row.created_by)
      ? row.created_by
      : null
    const parties = safeHandles(row.parties)
    const signatures = safeHandles(row.signatures).filter(handle => parties.includes(handle))
    const createdAt = safeDate(row.created_at)
    if (!id || !body || !createdBy || !parties.length || !createdAt) return []
    return [{
      id,
      body: body.text,
      created_by: createdBy,
      parties,
      signatures,
      open: typeof row.open === 'boolean' ? row.open : signatures.length < parties.length,
      created_at: createdAt,
      moderated: row.moderated === true,
      ...(body.truncated ? { truncated: true as const } : {}),
    }]
  }).slice(0, 100)
}

function publicWindowEvent(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = positiveInteger(row.id)
  const kind = typeof row.kind === 'string' && SAFE_EVENT_KINDS.has(row.kind) ? row.kind : null
  const actor = typeof row.actor === 'string' && HANDLE_RE.test(row.actor) ? row.actor : null
  const at = safeDate(row.at)
  if (!id || !kind || !actor || !at) return null

  const rawDetail = row.detail && typeof row.detail === 'object'
    ? row.detail as Record<string, unknown>
    : {}
  const detail: Record<string, number | string> = Object.fromEntries(SAFE_DETAIL_IDS.flatMap(key => {
    const safe = positiveInteger(rawDetail[key])
    return safe ? [[key, safe] as const] : []
  }))
  if (kind === 'moderation' && ['remove', 'restore'].includes(String(rawDetail.action))) {
    detail.action = String(rawDetail.action)
  }
  return { id, at, kind, actor, detail }
}

function kindRevisionKey(value: Readonly<Record<string, unknown>>): string | null {
  const kindId = positiveInteger(value.kind_id ?? value.id)
  const revision = positiveInteger(value.current_revision ?? value.revision)
  return kindId && revision ? `${kindId}:${revision}` : null
}

function kindFacets(values: readonly Record<string, unknown>[]) {
  const facets = new Map<string, {
    id: number
    revision: number
    traits: unknown
    recipe: never[]
  }>()
  for (const row of values) {
    const id = positiveInteger(row.kind_id)
    const revision = positiveInteger(row.current_revision)
    const key = kindRevisionKey(row)
    if (id && revision && key && !facets.has(key)) {
      facets.set(key, { id, revision, traits: row.traits, recipe: [] })
    }
  }
  return [...facets.values()]
}

export function mergeWindowThingTraits(
  values: readonly Record<string, unknown>[],
  facets: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const traitsByRevision = new Map(facets.flatMap(facet => {
    const key = kindRevisionKey(facet)
    return key ? [[key, facet.traits] as const] : []
  }))
  return values.map(value => {
    const key = kindRevisionKey(value)
    return { ...value, traits: key ? traitsByRevision.get(key) ?? [] : [] }
  })
}

async function readWindowSnapshot() {
  const [placeRows, residentRows, thingRows, noteRows, agreementRows, eventRows, totalRows] = await Promise.all([
    sql.query(`
      WITH RECURSIVE world AS (
        SELECT id, parent_id, name, description, owner_id, ARRAY[id] AS path
        FROM places WHERE parent_id IS NULL
        UNION ALL
        SELECT child.id, child.parent_id, child.name, child.description,
          child.owner_id, world.path || child.id
        FROM places child JOIN world ON child.parent_id = world.id
        WHERE NOT child.id = ANY(world.path) AND cardinality(world.path) < 32
      )
      SELECT world.id, world.parent_id, world.name, world.description, residents.handle AS owner,
        (SELECT count(*)::int FROM places child WHERE child.parent_id = world.id) AS places,
        (SELECT count(*)::int FROM things thing
          WHERE thing.place_id = world.id AND thing.withdrawn_at IS NULL) AS things,
        (SELECT count(*)::int FROM notes note WHERE note.place_id = world.id) AS notes,
        coalesce(moderation.action = 'remove', false) AS moderated
      FROM world JOIN residents ON residents.id = world.owner_id
      LEFT JOIN LATERAL (
        SELECT action FROM moderation_actions
        WHERE target_type = 'place' AND target_id = world.id
        ORDER BY created_at DESC, id DESC LIMIT 1
      ) moderation ON true
      ORDER BY world.path LIMIT 1000
    `),
    sql`
      SELECT resident.id, resident.handle, presence.current_place_id, resident.joined_at
      FROM residents resident
      LEFT JOIN resident_presence presence ON presence.resident_id = resident.id
      ORDER BY resident.joined_at, resident.id
      LIMIT 2000
    `,
    sql`
      SELECT thing.id, thing.place_id, thing.name, thing.body, owner.handle AS owner,
        thing.kind_id, thing.current_revision, kind.name AS kind,
        coalesce(revision.traits, '{}'::text[]) AS traits,
        thing.created_at
      FROM things thing
      JOIN residents owner ON owner.id = thing.owner_id
      LEFT JOIN kinds kind ON kind.id = thing.kind_id
      LEFT JOIN kind_revisions revision
        ON revision.kind_id = thing.kind_id AND revision.revision = thing.current_revision
      WHERE thing.withdrawn_at IS NULL
      ORDER BY thing.created_at DESC, thing.id DESC
      LIMIT 1000
    `,
    sql`
      WITH ranked_notes AS (
        SELECT note.id, note.place_id, author.handle AS author, note.body, note.created_at,
          row_number() OVER (PARTITION BY note.place_id ORDER BY note.created_at DESC, note.id DESC) AS place_rank
        FROM notes note JOIN residents author ON author.id = note.author_id
      )
      SELECT id, place_id, author, body, created_at
      FROM ranked_notes WHERE place_rank <= 100
      ORDER BY created_at DESC, id DESC LIMIT 1000
    `,
    sql`
      WITH public_agreements AS (
        SELECT agreement.id, agreement.body, creator.handle AS created_by,
          ARRAY(SELECT party.handle FROM agreement_parties membership
            JOIN residents party ON party.id = membership.resident_id
            WHERE membership.agreement_id = agreement.id ORDER BY party.handle) AS parties,
          ARRAY(SELECT signer.handle FROM agreement_signatures signature
            JOIN residents signer ON signer.id = signature.resident_id
            WHERE signature.agreement_id = agreement.id
            ORDER BY signature.signed_at, signer.handle) AS signatures,
          NOT EXISTS (
            SELECT 1 FROM agreement_parties membership
            WHERE membership.agreement_id = agreement.id AND NOT EXISTS (
              SELECT 1 FROM agreement_signatures signature
              WHERE signature.agreement_id = agreement.id
                AND signature.resident_id = membership.resident_id
            )
          ) AS complete,
          agreement.created_at
        FROM agreements agreement
        JOIN residents creator ON creator.id = agreement.created_by_id
      )
      SELECT id, body, created_by, parties, signatures, NOT complete AS open, created_at
      FROM public_agreements ORDER BY created_at DESC, id DESC LIMIT 100
    `,
    sql`
      SELECT id, at, kind, actor, detail
      FROM events WHERE kind = ANY(${PUBLIC_EVENT_KINDS}::text[])
      ORDER BY id DESC LIMIT 100
    `,
    sql`
      SELECT
        (SELECT count(*)::int FROM places) AS places,
        (SELECT count(*)::int FROM residents) AS residents,
        (SELECT count(*)::int FROM notes) AS conversations,
        (SELECT count(*)::int FROM things WHERE withdrawn_at IS NULL) AS things,
        (SELECT count(*)::int FROM agreements) AS agreements,
        (SELECT count(*)::int FROM events
          WHERE kind = ANY(${PUBLIC_EVENT_KINDS}::text[])) AS events
    `,
  ])

  const rawThings = thingRows as Record<string, unknown>[]
  const [publicEvents, publicNotes, publicAgreements, publicThingDetails, publicFacets] = await Promise.all([
    moderatePublicEvents(eventRows as Record<string, unknown>[]),
    moderatePublicRows('note', noteRows as Array<Record<string, unknown> & { id: number }>),
    moderatePublicRows('agreement', agreementRows as Array<Record<string, unknown> & { id: number }>),
    moderatePlaceDetails(rawThings, []),
    moderatePublicKinds(kindFacets(rawThings)),
  ])
  const thingsWithSafeTraits = mergeWindowThingTraits(
    publicThingDetails.things as readonly Record<string, unknown>[],
    publicFacets as readonly Record<string, unknown>[],
  )

  const places = publicPlaceTree(placeRows as unknown[])
  const residents = publicWindowResidents(residentRows as unknown[])
  const notes = publicWindowNotes([...publicNotes])
  const things = publicWindowThings(thingsWithSafeTraits)
  const agreements = publicWindowAgreements([...publicAgreements])
  const events = publicEvents.map(publicWindowEvent).filter(event => event !== null)
  const shown = {
    places: (placeRows as unknown[]).length,
    residents: residents.length,
    conversations: notes.length,
    things: things.length,
    agreements: agreements.length,
    events: events.length,
  }
  return {
    places,
    residents,
    notes,
    things,
    agreements,
    events,
    totals: publicWindowTotals(
      (totalRows as Record<string, unknown>[])[0] ?? {},
      shown,
    ),
    shown,
    limits: WINDOW_LIMITS,
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
