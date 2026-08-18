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
import {
  PUBLIC_PAGE_DEFAULT,
  PUBLIC_PAGE_MAX,
  finalizePublicPage,
  parsePublicPage,
  type PublicQueryExecutor,
} from './public-pagination.ts'
import { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS, WINDOW_JS } from './window-client.ts'
import { WINDOW_HTML } from './window-page.ts'
import { WINDOW_CSS } from './window-style.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'
import {
  PUBLIC_CREDENTIAL_REDACTION,
  containsPublicCredential,
} from './credential-safety.ts'

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
  places: null,
  residents: null,
  conversations: PUBLIC_PAGE_DEFAULT,
  things: PUBLIC_PAGE_DEFAULT,
  agreements: PUBLIC_PAGE_DEFAULT,
  events: PUBLIC_PAGE_DEFAULT,
})

// How many characters of a body survive the glass. WINDOW_LIMITS counts items;
// these count characters, and the two used to share names without saying so.
const WINDOW_BODY_LIMITS = Object.freeze({
  notes: 2_000,
  things: 1_000,
  agreements: 4_000,
})

// An agreement may collect an unbounded number of later signers. The glass
// keeps a small, safe preview and says explicitly when the public API holds
// more parties than it is showing here.
const AGREEMENT_PARTY_PREVIEW_LIMIT = 32

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
  owner: string | null
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
  asleep: boolean
}

/** A resident with no public act for this long renders dimmed on the window. */
export const WINDOW_ASLEEP_AFTER_DAYS = 14

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
  open_to_use: boolean
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
  acceded: string[]
  signatures: string[]
  open: boolean
  accession_open: boolean
  party_count?: number
  parties_truncated?: true
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
  if (containsPublicCredential(value)) {
    return { text: PUBLIC_CREDENTIAL_REDACTION, truncated: false }
  }
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
  if (containsPublicCredential(value)) return PUBLIC_CREDENTIAL_REDACTION
  return typeof value === 'string' && (WORLD_NAME_RE.test(value) || value === MODERATED_TEXT)
    ? value
    : null
}

function safeHandles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(item => typeof item === 'string' && HANDLE_RE.test(item)))]
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
  const owner = row.owner === null
    ? null
    : typeof row.owner === 'string' && HANDLE_RE.test(row.owner)
      ? row.owner
      : undefined
  const isOwnerlessWorld = owner === null && row.parent_id === null && name === WORLD_ROOT_NAME
  if (
    !id || !name || owner === undefined ||
    (owner === null && !isOwnerlessWorld) ||
    (row.parent_id != null && !parentId)
  ) return null
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

export function publicWindowResidents(values: unknown[]): PublicResident[] {
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const id = positiveInteger(row.id)
    const handle = typeof row.handle === 'string' && HANDLE_RE.test(row.handle) ? row.handle : null
    const joinedAt = safeDate(row.joined_at)
    const currentPlaceId = row.current_place_id == null ? null : positiveInteger(row.current_place_id)
    if (!id || !handle || !joinedAt || (row.current_place_id != null && !currentPlaceId)) return []
    return [{
      id,
      handle,
      current_place_id: currentPlaceId,
      joined_at: joinedAt,
      asleep: row.asleep === true,
    }]
  })
}

export function publicWindowNotes(values: unknown[]): PublicNote[] {
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const id = positiveInteger(row.id)
    const placeId = positiveInteger(row.place_id)
    const author = typeof row.author === 'string' && HANDLE_RE.test(row.author) ? row.author : null
    const body = safePublicText(row.body, WINDOW_BODY_LIMITS.notes)
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
  }).slice(0, PUBLIC_PAGE_MAX)
}

export function publicWindowThings(values: unknown[]): PublicThing[] {
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const id = positiveInteger(row.id)
    const placeId = positiveInteger(row.place_id)
    const name = safePublicText(row.name, 120)
    const body = safePublicText(row.body, WINDOW_BODY_LIMITS.things, true)
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
      open_to_use: row.open_to_use === true,
      kind,
      traits,
      created_at: createdAt,
      moderated: row.moderated === true,
      kind_moderated: row.kind_moderated === true,
      ...(body.truncated ? { truncated: true as const } : {}),
    }]
  }).slice(0, PUBLIC_PAGE_MAX)
}

export function publicWindowAgreements(values: unknown[]): PublicAgreement[] {
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const id = positiveInteger(row.id)
    const body = safePublicText(row.body, WINDOW_BODY_LIMITS.agreements)
    const createdBy = typeof row.created_by === 'string' && HANDLE_RE.test(row.created_by)
      ? row.created_by
      : null
    const allParties = safeHandles(row.parties)
    const allPartySet = new Set(allParties)
    const accededSet = new Set(safeHandles(row.acceded).filter(handle => allPartySet.has(handle)))
    const orderedParties = allParties.filter(handle => !accededSet.has(handle))
      .concat(allParties.filter(handle => accededSet.has(handle)))
    const parties = orderedParties.slice(0, AGREEMENT_PARTY_PREVIEW_LIMIT)
    const partyCount = Math.max(count(row.party_count), allParties.length)
    const signatureSet = new Set(safeHandles(row.signatures).filter(handle => allPartySet.has(handle)))
    const acceded = parties.filter(handle => accededSet.has(handle))
    const signatures = parties.filter(handle => signatureSet.has(handle))
    const createdAt = safeDate(row.created_at)
    if (!id || !body || !createdBy || !parties.length || !createdAt) return []
    const partiesTruncated = partyCount > parties.length
    return [{
      id,
      body: body.text,
      created_by: createdBy,
      parties,
      acceded,
      signatures,
      open: typeof row.open === 'boolean' ? row.open : signatures.length < parties.length,
      accession_open: row.accession_open === true,
      ...(partiesTruncated ? { party_count: partyCount, parties_truncated: true as const } : {}),
      created_at: createdAt,
      moderated: row.moderated === true,
      ...(body.truncated ? { truncated: true as const } : {}),
    }]
  }).slice(0, PUBLIC_PAGE_MAX)
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

const WINDOW_HISTORY_KEYS = new Set([
  'collection', 'before_id', 'limit', 'place_id', 'resident',
])
const WINDOW_HISTORY_COLLECTIONS = new Set(['notes', 'things', 'agreements'])

export interface WindowHistoryQuery {
  readonly collection: 'notes' | 'things' | 'agreements'
  readonly beforeId: number | null
  readonly limit: number
  readonly placeId: number | null
  readonly resident: string | null
}

function oneWindowQueryValue(
  queries: Readonly<Record<string, readonly string[]>>,
  name: string,
): string | null | undefined {
  const values = queries[name]
  if (values === undefined) return undefined
  return values.length === 1 ? values[0] ?? null : null
}

export function parseWindowHistoryQuery(
  queries: Readonly<Record<string, readonly string[]>>,
): WindowHistoryQuery | null {
  if (Object.keys(queries).some(key => !WINDOW_HISTORY_KEYS.has(key))) return null
  if (Object.values(queries).some(values => values.length !== 1)) return null

  const collection = oneWindowQueryValue(queries, 'collection')
  if (!collection || !WINDOW_HISTORY_COLLECTIONS.has(collection)) return null
  const page = parsePublicPage(queries, 'before_id', 'limit')
  if (!page.ok) return null

  const placeValue = oneWindowQueryValue(queries, 'place_id')
  const parsedPlaceId = /^\d+$/.test(placeValue ?? '') ? positiveInteger(placeValue) : null
  const placeId = placeValue === undefined
    ? null
    : parsedPlaceId !== null && parsedPlaceId <= 2_147_483_647 ? parsedPlaceId : null
  if (placeValue !== undefined && placeId === null) return null

  const residentValue = oneWindowQueryValue(queries, 'resident')
  const resident = residentValue === undefined
    ? null
    : typeof residentValue === 'string' && HANDLE_RE.test(residentValue) ? residentValue : null
  if (residentValue !== undefined && resident === null) return null
  if (collection === 'agreements' && placeId !== null) return null

  return Object.freeze({
    collection: collection as WindowHistoryQuery['collection'],
    beforeId: page.cursor,
    limit: page.limit,
    placeId,
    resident,
  })
}

export interface WindowCollectionStatement {
  readonly text: string
  readonly values: readonly unknown[]
}

export function windowCollectionStatement(options: WindowHistoryQuery): WindowCollectionStatement {
  const fetchLimit = options.limit + 1
  if (options.collection === 'notes') {
    return Object.freeze({
      text: `SELECT note.id, note.place_id, author.handle AS author, note.body, note.created_at
        FROM notes note JOIN residents author ON author.id = note.author_id
        WHERE ($1::integer IS NULL OR note.id < $1::integer)
          AND ($2::integer IS NULL OR note.place_id = $2::integer)
          AND ($3::text IS NULL OR author.handle = $3::text)
        ORDER BY note.id DESC
        LIMIT $4::integer`,
      values: Object.freeze([options.beforeId, options.placeId, options.resident, fetchLimit]),
    })
  }
  if (options.collection === 'things') {
    return Object.freeze({
      text: `SELECT thing.id, thing.place_id, thing.name, thing.body, owner.handle AS owner,
          thing.open_to_use,
          thing.kind_id, thing.current_revision, kind.name AS kind,
          coalesce(revision.traits, '{}'::text[]) AS traits, thing.created_at
        FROM things thing
        JOIN residents owner ON owner.id = thing.owner_id
        LEFT JOIN kinds kind ON kind.id = thing.kind_id
        LEFT JOIN kind_revisions revision
          ON revision.kind_id = thing.kind_id AND revision.revision = thing.current_revision
        WHERE thing.withdrawn_at IS NULL
          AND ($1::integer IS NULL OR thing.id < $1::integer)
          AND ($2::integer IS NULL OR thing.place_id = $2::integer)
          AND ($3::text IS NULL OR owner.handle = $3::text)
        ORDER BY thing.id DESC
        LIMIT $4::integer`,
      values: Object.freeze([options.beforeId, options.placeId, options.resident, fetchLimit]),
    })
  }
  return Object.freeze({
    text: `WITH public_agreements AS (
        SELECT agreement.id, agreement.body, creator.handle AS created_by,
          EXISTS (
            SELECT 1 FROM agreement_accession_openings opening
            WHERE opening.agreement_id = agreement.id
          ) AS accession_open,
          ARRAY(SELECT party.handle FROM agreement_parties membership
            JOIN residents party ON party.id = membership.resident_id
            WHERE membership.agreement_id = agreement.id
            ORDER BY membership.named DESC, party.handle
            LIMIT ${AGREEMENT_PARTY_PREVIEW_LIMIT}) AS parties,
          (SELECT count(*)::int FROM agreement_parties membership
            WHERE membership.agreement_id = agreement.id) AS party_count,
          ARRAY(SELECT party.handle FROM agreement_parties membership
            JOIN residents party ON party.id = membership.resident_id
            WHERE membership.agreement_id = agreement.id AND NOT membership.named
            ORDER BY party.handle
            LIMIT ${AGREEMENT_PARTY_PREVIEW_LIMIT}) AS acceded,
          ARRAY(SELECT signer.handle FROM agreement_signatures signature
            JOIN residents signer ON signer.id = signature.resident_id
            JOIN agreement_parties membership
              ON membership.agreement_id = signature.agreement_id
              AND membership.resident_id = signature.resident_id
            WHERE signature.agreement_id = agreement.id
            ORDER BY membership.named DESC, signer.handle
            LIMIT ${AGREEMENT_PARTY_PREVIEW_LIMIT}) AS signatures,
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
        WHERE ($1::integer IS NULL OR agreement.id < $1::integer)
          AND ($2::text IS NULL OR creator.handle = $2::text OR EXISTS (
            SELECT 1 FROM agreement_parties membership
            JOIN residents party ON party.id = membership.resident_id
            WHERE membership.agreement_id = agreement.id AND party.handle = $2::text
          ))
      )
      SELECT id, body, created_by, parties, party_count, acceded, signatures, accession_open,
        NOT complete AS open, created_at
      FROM public_agreements ORDER BY id DESC LIMIT $3::integer`,
    values: Object.freeze([options.beforeId, options.resident, fetchLimit]),
  })
}

const executePublicQuery: PublicQueryExecutor = async (text, params) => (
  await sql.query(text, [...params]) as readonly Record<string, unknown>[]
)

export async function loadWindowCollectionRows(
  options: WindowHistoryQuery,
  query: PublicQueryExecutor = executePublicQuery,
): Promise<readonly Record<string, unknown>[]> {
  const statement = windowCollectionStatement(options)
  return query(statement.text, statement.values)
}

interface WindowCollectionPage {
  readonly items: readonly (PublicNote | PublicThing | PublicAgreement)[]
  readonly hasMore: boolean
  readonly nextBeforeId: number | null
}

export async function readWindowCollectionPage(
  options: WindowHistoryQuery,
  query: PublicQueryExecutor = executePublicQuery,
): Promise<WindowCollectionPage> {
  const rows = await loadWindowCollectionRows(options, query)
  const rawPage = finalizePublicPage(
    rows as readonly (Record<string, unknown> & { id: number })[],
    options.limit,
  )
  let items: readonly (PublicNote | PublicThing | PublicAgreement)[]
  if (options.collection === 'notes') {
    const moderated = await moderatePublicRows(
      'note',
      [...rawPage.items] as Array<Record<string, unknown> & { id: number }>,
    )
    items = publicWindowNotes([...moderated])
  } else if (options.collection === 'things') {
    const rawThings = [...rawPage.items]
    const [details, facets] = await Promise.all([
      moderatePlaceDetails(rawThings, []),
      moderatePublicKinds(kindFacets(rawThings)),
    ])
    items = publicWindowThings(mergeWindowThingTraits(
      details.things as readonly Record<string, unknown>[],
      facets as readonly Record<string, unknown>[],
    ))
  } else {
    const moderated = await moderatePublicRows(
      'agreement',
      [...rawPage.items] as Array<Record<string, unknown> & { id: number }>,
    )
    items = publicWindowAgreements([...moderated])
  }
  return Object.freeze({
    items: Object.freeze(items),
    hasMore: rawPage.hasMore,
    nextBeforeId: rawPage.nextCursor,
  })
}

async function readWindowEventPage(
  query: PublicQueryExecutor = executePublicQuery,
) {
  const pageRequest = Object.freeze({
    cursor: null,
    limit: PUBLIC_PAGE_DEFAULT,
    fetchLimit: PUBLIC_PAGE_DEFAULT + 1,
  })
  const rows = await query(
    `SELECT id, at, kind, actor, detail
     FROM events
     WHERE kind = ANY($1::text[])
     ORDER BY id DESC
     LIMIT $2::integer`,
    [PUBLIC_EVENT_KINDS, pageRequest.fetchLimit],
  )
  const rawPage = finalizePublicPage(
    rows as readonly (Record<string, unknown> & { id: number })[],
    pageRequest.limit,
  )
  const moderated = await moderatePublicEvents([...rawPage.items])
  return Object.freeze({
    items: Object.freeze(moderated.map(publicWindowEvent).filter(event => event !== null)),
    hasMore: rawPage.hasMore,
    nextBeforeId: rawPage.nextCursor,
  })
}

const defaultWindowHistoryQuery = (
  collection: WindowHistoryQuery['collection'],
): WindowHistoryQuery => Object.freeze({
  collection,
  beforeId: null,
  limit: PUBLIC_PAGE_DEFAULT,
  placeId: null,
  resident: null,
})

async function readWindowSnapshot() {
  const [
    placeRows,
    residentRows,
    notePage,
    thingPage,
    agreementPage,
    eventPage,
    totalRows,
  ] = await Promise.all([
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
      FROM world LEFT JOIN residents ON residents.id = world.owner_id
      LEFT JOIN LATERAL (
        SELECT action FROM moderation_actions
        WHERE target_type = 'place' AND target_id = world.id
        ORDER BY created_at DESC, id DESC LIMIT 1
      ) moderation ON true
      ORDER BY world.path
    `),
    sql`
      SELECT resident.id, resident.handle, presence.current_place_id, resident.joined_at,
        (resident.joined_at < now() - make_interval(days => ${WINDOW_ASLEEP_AFTER_DAYS})
          AND coalesce(activity.last_public_at, resident.joined_at)
            < now() - make_interval(days => ${WINDOW_ASLEEP_AFTER_DAYS})) AS asleep
      FROM residents resident
      LEFT JOIN resident_presence presence ON presence.resident_id = resident.id
      LEFT JOIN (
        SELECT actor, max(created_at) AS last_public_at
        FROM events
        WHERE kind = ANY(${PUBLIC_EVENT_KINDS}::text[])
        GROUP BY actor
      ) activity ON activity.actor = resident.handle
      ORDER BY resident.joined_at, resident.id
    `,
    readWindowCollectionPage(defaultWindowHistoryQuery('notes')),
    readWindowCollectionPage(defaultWindowHistoryQuery('things')),
    readWindowCollectionPage(defaultWindowHistoryQuery('agreements')),
    readWindowEventPage(),
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

  const places = publicPlaceTree(placeRows as unknown[])
  const residents = publicWindowResidents(residentRows as unknown[])
  const notes = notePage.items as readonly PublicNote[]
  const things = thingPage.items as readonly PublicThing[]
  const agreements = agreementPage.items as readonly PublicAgreement[]
  const events = eventPage.items
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
    pages: {
      notes: { has_more: notePage.hasMore, next_before_id: notePage.nextBeforeId },
      things: { has_more: thingPage.hasMore, next_before_id: thingPage.nextBeforeId },
      agreements: { has_more: agreementPage.hasMore, next_before_id: agreementPage.nextBeforeId },
      events: { has_more: eventPage.hasMore, next_before_id: eventPage.nextBeforeId },
    },
    totals: publicWindowTotals(
      (totalRows as Record<string, unknown>[])[0] ?? {},
      shown,
    ),
    shown,
    limits: WINDOW_LIMITS,
    body_limits: WINDOW_BODY_LIMITS,
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
  const hasCredentials = [
    'authorization',
    'proxy-authorization',
    'cookie',
    'x-payment',
    'x-api-key',
  ].some(name => Boolean(c.req.header(name)))
  const queries = c.req.queries()
  harden(c)
  if (hasCredentials) {
    return c.json({ error: 'the public city window accepts no credential data' }, 400)
  }
  if (Object.keys(queries).length) {
    const request = parseWindowHistoryQuery(queries)
    if (!request) {
      return c.json({ error: 'invalid public window history query' }, 400)
    }
    const page = await readWindowCollectionPage(request)
    c.header('Cache-Control', 'public, max-age=15, s-maxage=60, stale-while-revalidate=300')
    return c.json({
      [request.collection]: page.items,
      has_more: page.hasMore,
      next_before_id: page.nextBeforeId,
    })
  }
  const snapshot = await cachedWindowSnapshot()
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
