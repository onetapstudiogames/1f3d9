import { readFileSync } from 'node:fs'
import type { Context } from 'hono'
import { HANDLE_RE, WORLD_NAME_RE, sha256 } from './core.ts'
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
  singlePublicQueryValue,
  type PublicQueryExecutor,
} from './public-pagination.ts'
import { WINDOW_JS } from './window-client.ts'
import {
  PUBLIC_EVENT_DETAIL_ID_FIELDS,
  PUBLIC_EVENT_KINDS,
  PUBLIC_EVENT_LABELS,
  isPublicSystemEventActor,
} from './public-events.ts'
import { WINDOW_HTML } from './window-page.ts'
import { WINDOW_CSS } from './window-style.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'
import { isBasicAction } from './physics.ts'
import {
  PUBLIC_CREDENTIAL_PATTERN_SOURCE,
  PUBLIC_CREDENTIAL_REDACTION,
  containsPublicCredential,
} from './credential-safety.ts'
import { readPublicMapOutline } from './public-map.ts'
import {
  PUBLIC_RESIDENT_ASLEEP_AFTER_DAYS,
  readPublicResidentPage,
} from './public-residents.ts'
import { executeBudgetedExactQuery } from './public-exact-query.ts'
import { takePublicSearchToken } from './public-search-rate-limit.ts'
import {
  PublicChangeFutureError,
  PublicChangeReadConflictError,
  loadPublicChangeCheckpoint,
  parsePublicChangeMarker,
  readAtStablePublicChangeCheckpoint,
} from './public-changes.ts'
import {
  loadPublicPlaceFrontMatter,
  type PublicFrontMatterHeading,
} from './room-orientation.ts'
import { cachedPublicDirectory } from './public-directory.ts'
import {
  PUBLIC_THING_HAS_DRAWING_SQL,
  PUBLIC_EVENT_THING_DRAWING_JOIN_SQL,
} from './public-drawing-presence.ts'
import { readPublicLiveSurvey } from './public-live-survey.ts'
import {
  loadPublicNoteRecord,
  loadPublicPlaceRecord,
  loadPublicThingRecord,
} from './public-records.ts'
import { configuredPublicDomain } from './public-reference-facts.ts'
import {
  createWindowShareMetadata,
  parseWindowShareRequest,
  renderWindowShareDocument,
  windowShareMetadataOrigin,
  type WindowShareDetail,
} from './window-sharing.ts'

const WINDOW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "font-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join('; ')

const SAFE_EVENT_KINDS = new Set(PUBLIC_EVENT_KINDS)
const UNSAFE_PUBLIC_OUTPUT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u
const FULL_WINDOW_LIMITS = Object.freeze({
  places: null,
  residents: null,
  conversations: PUBLIC_PAGE_DEFAULT,
  things: PUBLIC_PAGE_DEFAULT,
  agreements: PUBLIC_PAGE_DEFAULT,
  events: PUBLIC_PAGE_DEFAULT,
})

const OUTLINE_WINDOW_LIMITS = Object.freeze({
  places: PUBLIC_PAGE_DEFAULT,
  residents: 25,
  conversations: PUBLIC_PAGE_DEFAULT,
  things: PUBLIC_PAGE_DEFAULT,
  agreements: PUBLIC_PAGE_DEFAULT,
  events: PUBLIC_PAGE_DEFAULT,
})

const OUTLINE_WINDOW_TOTALS_SQL = `
  /* public:window-outline-totals */
  SELECT 0::integer AS id,
    (SELECT count(*)::integer FROM places) AS places,
    $1::integer AS residents,
    (SELECT count(*)::integer FROM notes) AS conversations,
    (SELECT count(*)::integer FROM things WHERE withdrawn_at IS NULL) AS things,
    (SELECT count(*)::integer FROM agreements) AS agreements,
    (SELECT count(*)::integer FROM events
      WHERE kind = ANY($2::text[])) AS events
`

// How many characters of a body survive the glass. WINDOW_LIMITS counts items;
// these count characters, and the two used to share names without saying so.
const WINDOW_BODY_LIMITS = Object.freeze({
  notes: 2_000,
  things: 1_000,
  agreements: 4_000,
})
const WINDOW_EVENT_ERROR_LIMIT = 500
const WINDOW_UNSAFE_EVENT_ERROR = 'the recorded cause could not be shown safely'

// An agreement may collect an unbounded number of later signers. The glass
// keeps a small, safe preview and says explicitly when the public API holds
// more parties than it is showing here.
const AGREEMENT_PARTY_PREVIEW_LIMIT = 32

const WINDOW_SHARE_IMAGES = Object.freeze({
  view: Uint8Array.from(readFileSync(new URL('./assets/share-view.png', import.meta.url))),
  place: Uint8Array.from(readFileSync(new URL('./assets/share-place.png', import.meta.url))),
  thing: Uint8Array.from(readFileSync(new URL('./assets/share-thing.png', import.meta.url))),
  note: Uint8Array.from(readFileSync(new URL('./assets/share-note.png', import.meta.url))),
})

export type WindowShareImageKind = keyof typeof WINDOW_SHARE_IMAGES
export type WindowShareRecordReader = (detail: WindowShareDetail) => Promise<unknown | null>
export type WindowShareGazetteIssueReader = (issueNumber: number) => Promise<boolean>

export { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS }

const SAFE_DETAIL_IDS = PUBLIC_EVENT_DETAIL_ID_FIELDS
const SAFE_ACTION_STATUSES: ReadonlySet<string> = new Set([
  'applied',
  'blocked',
  'noop',
  'failed',
])
const SAFE_EFFECT_STATUSES: ReadonlySet<string> = new Set([
  'applied',
  'skipped',
  'failed',
])

interface PublicPlace {
  id: number
  parent_id: number | null
  name: string
  purpose: string
  front_matter: readonly PublicFrontMatterHeading[]
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
  has_drawing: boolean
}

/** A resident with no public act for this long renders dimmed on the window. */
export const WINDOW_ASLEEP_AFTER_DAYS = PUBLIC_RESIDENT_ASLEEP_AFTER_DAYS

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
  maker_id: number
  made_by: string
  owner_id: number
  current_owner_id: number
  current_owner: string
  owner: string
  open_to_use: boolean
  kind: string | null
  traits: string[]
  created_at: string
  moderated: boolean
  kind_moderated: boolean
  has_drawing: boolean
  truncated?: true
}

export interface PublicThingHeading {
  id: number
  place_id: number
  name: string
  kind_id: number | null
  kind: string | null
  maker_id: number
  made_by: string
  current_owner_id: number
  current_owner: string
  body_text_bytes: number
  created_at: string
  has_drawing: boolean
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
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : null
}

const nonnegativeInteger = (value: unknown) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2_147_483_647 ? parsed : null
}

const count = (value: unknown) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

export function publicWindowTotals(
  value: Readonly<Record<string, unknown>>,
  shown: Readonly<Record<keyof typeof FULL_WINDOW_LIMITS, number>>,
): Record<keyof typeof FULL_WINDOW_LIMITS, number> {
  return Object.fromEntries(Object.keys(FULL_WINDOW_LIMITS).map(key => {
    const name = key as keyof typeof FULL_WINDOW_LIMITS
    return [name, Math.max(count(value[name]), shown[name])]
  })) as Record<keyof typeof FULL_WINDOW_LIMITS, number>
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

function safePlacePurpose(value: unknown): string {
  const purpose = safePublicText(value, 1_000, true)?.text ?? ''
  return /[\r\n\u2028\u2029]/u.test(purpose) || [...purpose].length > 280 ? '' : purpose
}

function safeFrontMatterHeading(value: unknown): PublicFrontMatterHeading | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = positiveInteger(row.id)
  const name = safePublicText(row.name, 120)?.text ?? null
  const bodyTextBytes = Number(row.body_text_bytes)
  const makerId = positiveInteger(row.maker_id)
  const madeBy = typeof row.made_by === 'string' && HANDLE_RE.test(row.made_by)
    ? row.made_by
    : null
  const currentOwnerId = positiveInteger(row.current_owner_id)
  const ownerId = positiveInteger(row.owner_id)
  const currentOwnerValue = row.current_owner
  const currentOwner = typeof currentOwnerValue === 'string' && HANDLE_RE.test(currentOwnerValue)
    ? currentOwnerValue
    : null
  const owner = typeof row.owner === 'string' && HANDLE_RE.test(row.owner) ? row.owner : null
  if (
    row.type !== 'thing' || !id || !name ||
    !Number.isSafeInteger(bodyTextBytes) || bodyTextBytes < 0 ||
    !makerId || !madeBy || !currentOwnerId || !currentOwner ||
    ownerId !== currentOwnerId || owner !== currentOwner
  ) return null
  return Object.freeze({
    id,
    type: 'thing' as const,
    name,
    body_text_bytes: bodyTextBytes,
    maker_id: makerId,
    made_by: madeBy,
    current_owner_id: currentOwnerId,
    current_owner: currentOwner,
    owner_id: ownerId,
    owner,
    has_drawing: row.has_drawing === true,
  })
}

function safeFrontMatter(value: unknown): readonly PublicFrontMatterHeading[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const seen = new Set<number>()
  const headings = value.slice(0, 3).flatMap(item => {
    const heading = safeFrontMatterHeading(item)
    if (!heading || seen.has(heading.id)) return []
    seen.add(heading.id)
    return [heading]
  })
  return Object.freeze(headings)
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
    purpose: moderated ? '' : safePlacePurpose(row.purpose),
    front_matter: moderated ? Object.freeze([]) : safeFrontMatter(row.front_matter),
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
      has_drawing: row.has_drawing === true,
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
    const makerId = positiveInteger(row.maker_id)
    const madeBy = typeof row.made_by === 'string' && HANDLE_RE.test(row.made_by)
      ? row.made_by
      : null
    const ownerId = positiveInteger(row.owner_id)
    const currentOwnerId = positiveInteger(row.current_owner_id)
    const currentOwner = typeof row.current_owner === 'string' && HANDLE_RE.test(row.current_owner)
      ? row.current_owner
      : null
    const owner = typeof row.owner === 'string' && HANDLE_RE.test(row.owner) ? row.owner : null
    const kind = row.kind == null ? null : safeWorldName(row.kind)
    const createdAt = safeDate(row.created_at)
    if (
      !id || !placeId || !name || !body || !makerId || !madeBy ||
      !ownerId || !currentOwnerId || ownerId !== currentOwnerId ||
      !currentOwner || !owner || owner !== currentOwner ||
      !createdAt || (row.kind != null && !kind)
    ) return []
    const traits = Array.isArray(row.traits)
      ? [...new Set(row.traits.flatMap(trait => safeWorldName(trait) ?? []))].slice(0, 32)
      : []
    return [{
      id,
      place_id: placeId,
      name: name.text,
      body: body.text,
      maker_id: makerId,
      made_by: madeBy,
      owner_id: ownerId,
      current_owner_id: currentOwnerId,
      current_owner: currentOwner,
      owner,
      open_to_use: row.open_to_use === true,
      kind,
      traits,
      created_at: createdAt,
      moderated: row.moderated === true,
      kind_moderated: row.kind_moderated === true,
      has_drawing: row.has_drawing === true,
      ...(body.truncated ? { truncated: true as const } : {}),
    }]
  }).slice(0, PUBLIC_PAGE_MAX)
}

export function publicWindowThingHeadings(values: unknown[]): PublicThingHeading[] {
  return values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const id = positiveInteger(row.id)
    const placeId = positiveInteger(row.place_id)
    const name = safePublicText(row.name, 120)?.text ?? null
    const kindId = row.kind_id === null ? null : positiveInteger(row.kind_id)
    const kind = row.kind === null ? null : safePublicText(row.kind, 120)?.text ?? null
    const makerId = positiveInteger(row.maker_id)
    const madeBy = typeof row.made_by === 'string' && HANDLE_RE.test(row.made_by)
      ? row.made_by
      : null
    const currentOwnerId = positiveInteger(row.current_owner_id)
    const currentOwner = typeof row.current_owner === 'string' && HANDLE_RE.test(row.current_owner)
      ? row.current_owner
      : null
    const bodyTextBytes = Number(row.body_text_bytes)
    const createdAt = safeDate(row.created_at)
    if (
      !id || !placeId || !name || !makerId || !madeBy || !currentOwnerId || !currentOwner ||
      !Number.isSafeInteger(bodyTextBytes) || bodyTextBytes < 0 || !createdAt ||
      (kindId === null) !== (kind === null)
    ) return []
    return [Object.freeze({
      id,
      place_id: placeId,
      name,
      kind_id: kindId,
      kind,
      maker_id: makerId,
      made_by: madeBy,
      current_owner_id: currentOwnerId,
      current_owner: currentOwner,
      body_text_bytes: bodyTextBytes,
      created_at: createdAt,
      has_drawing: row.has_drawing === true,
    })]
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
  const actor = typeof row.actor === 'string' && (
    HANDLE_RE.test(row.actor) || isPublicSystemEventActor(row.actor)
  ) ? row.actor : null
  const at = safeDate(row.at)
  if (!id || !kind || !actor || !at) return null

  const rawDetail = row.detail && typeof row.detail === 'object'
    ? row.detail as Record<string, unknown>
    : {}
  const creditDisputeDecision = kind === 'payment_repair'
    && ['credit_dispute_seller_favour', 'credit_dispute_buyer_favour']
      .includes(String(rawDetail.action))
  const detail: Record<string, number | string | boolean> = Object.fromEntries((
    creditDisputeDecision ? [] : SAFE_DETAIL_IDS
  ).flatMap(key => {
    const safe = positiveInteger(rawDetail[key])
    return safe ? [[key, safe] as const] : []
  }))
  if (kind === 'gazette_printed') {
    const issueNumber = positiveInteger(rawDetail.issue_number)
    const entryCount = nonnegativeInteger(rawDetail.entry_count)
    if (!issueNumber || entryCount === null || detail.place_id !== 454) return null
    detail.issue_number = issueNumber
    detail.entry_count = entryCount
  }
  let carriesFailureCause = false
  if (kind === 'action' && isBasicAction(rawDetail.action)) {
    detail.action = rawDetail.action
    if (typeof rawDetail.status === 'string' && SAFE_ACTION_STATUSES.has(rawDetail.status)) {
      detail.status = rawDetail.status
      carriesFailureCause = rawDetail.status === 'blocked' || rawDetail.status === 'failed'
    }
  } else if (
    kind === 'effect_resolved' &&
    typeof rawDetail.status === 'string' &&
    SAFE_EFFECT_STATUSES.has(rawDetail.status)
  ) {
    detail.status = rawDetail.status
    carriesFailureCause = rawDetail.status === 'skipped' || rawDetail.status === 'failed'
  } else if (kind === 'moderation' && ['remove', 'restore'].includes(String(rawDetail.action))) {
    detail.action = String(rawDetail.action)
  } else if (creditDisputeDecision) {
    detail.action = String(rawDetail.action)
  }
  if (carriesFailureCause && Object.hasOwn(rawDetail, 'error')) {
    const error = safePublicText(rawDetail.error, WINDOW_EVENT_ERROR_LIMIT + 1)
    if (error) {
      const truncated = error.truncated || error.text.length > WINDOW_EVENT_ERROR_LIMIT
      detail.error = truncated
        ? `${error.text.slice(0, WINDOW_EVENT_ERROR_LIMIT - 1)}…`
        : error.text
      if (truncated) detail.error_truncated = true
    } else {
      detail.error = WINDOW_UNSAFE_EVENT_ERROR
    }
  }
  return {
    id, at, kind, actor, detail,
    ...(typeof row.thing_has_drawing === 'boolean'
      ? { thing_has_drawing: row.thing_has_drawing }
      : {}),
  }
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
  'collection', 'before_id', 'limit', 'place_id', 'within_place_id', 'resident', 'context',
  'presentation', 'find',
])
const WINDOW_HISTORY_COLLECTIONS = new Set(['notes', 'things', 'agreements'])

// How many same-place neighbors ride along with each of a followed
// resident's notes when the caller asks for conversational context.
export const NOTE_CONTEXT_NEIGHBORS = 2

// A context page carries one lookahead own note plus up to 2*NEIGHBORS
// neighbors per kept own note. Bound its page size so the whole page always
// fits inside the public row cap; otherwise the shaper's slice would silently
// drop own notes the cursor has already stepped past.
export const NOTE_CONTEXT_PAGE_MAX = Math.floor(
  (PUBLIC_PAGE_MAX - 1) / (1 + 2 * NOTE_CONTEXT_NEIGHBORS),
)

export interface WindowHistoryQuery {
  readonly collection: 'notes' | 'things' | 'agreements'
  readonly beforeId: number | null
  readonly limit: number
  readonly placeId: number | null
  readonly includeDescendants?: boolean
  readonly resident: string | null
  readonly context: boolean
  readonly presentation?: 'headings'
  readonly find?: string | null
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

  const exactPlaceValue = oneWindowQueryValue(queries, 'place_id')
  const insidePlaceValue = oneWindowQueryValue(queries, 'within_place_id')
  if (exactPlaceValue !== undefined && insidePlaceValue !== undefined) return null
  const placeValue = insidePlaceValue === undefined ? exactPlaceValue : insidePlaceValue
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
  const includeDescendants = insidePlaceValue !== undefined

  // context=place asks for the same-place notes around a followed
  // resident's own notes. It has exactly one value and only makes sense
  // for notes with a resident to follow.
  const contextValue = oneWindowQueryValue(queries, 'context')
  if (contextValue !== undefined &&
      (contextValue !== 'place' || collection !== 'notes' || resident === null)) return null

  const context = contextValue === 'place'
  const presentationValue = oneWindowQueryValue(queries, 'presentation')
  const findValue = oneWindowQueryValue(queries, 'find')
  if (
    presentationValue !== undefined &&
    (collection !== 'things' || presentationValue !== 'headings')
  ) return null
  if (findValue !== undefined && presentationValue !== 'headings') return null

  let find: string | null = null
  if (findValue !== undefined) {
    if (typeof findValue !== 'string') return null
    try {
      find = findValue.normalize('NFC').trim()
    } catch {
      return null
    }
    if (
      !find || /[\r\n\u2028\u2029]/u.test(find) ||
      publicText(find, { maximumCharacters: 120 }) === null
    ) return null
    if (/^#\d+$/u.test(find) && !/^#[1-9]\d{0,9}$/u.test(find)) return null
    if (/^#[1-9]\d{0,9}$/u.test(find) && positiveInteger(find.slice(1)) === null) return null
  }

  const headingOptions = presentationValue === 'headings'
    ? { presentation: 'headings' as const, find }
    : {}
  return Object.freeze({
    collection: collection as WindowHistoryQuery['collection'],
    beforeId: page.cursor,
    limit: context ? Math.min(page.limit, NOTE_CONTEXT_PAGE_MAX) : page.limit,
    placeId,
    includeDescendants,
    resident,
    context,
    ...headingOptions,
  })
}

export interface WindowCollectionStatement {
  readonly text: string
  readonly values: readonly unknown[]
}

export function windowCollectionStatement(options: WindowHistoryQuery): WindowCollectionStatement {
  const fetchLimit = options.limit + 1
  const includeDescendants = options.includeDescendants === true
  const selectedPlacesCte = `selected_places AS (
      SELECT place.id FROM places place WHERE place.id = $2::integer
      UNION
      SELECT child.id FROM places child
      JOIN selected_places selected ON child.parent_id = selected.id
    )`
  const placePredicate = (field: string): string => includeDescendants
    ? `($2::integer IS NULL OR ${field} IN (SELECT id FROM selected_places))`
    : `($2::integer IS NULL OR ${field} = $2::integer)`
  if (options.collection === 'notes' && options.context) {
    // The followed resident's own notes drive the page; each own note brings
    // along up to NOTE_CONTEXT_NEIGHBORS same-place notes on either side so
    // what others said back is visible. Neighbors shared between adjacent own
    // notes collapse via DISTINCT ON, and the page cursor advances over the
    // resident's notes alone.
    //
    // Two invariants keep that cursor honest. Context excludes the followed
    // resident, so an own note from an earlier page can never return disguised
    // as context and be counted again — that would freeze the cursor and hide
    // the note underneath it. And context anchors only to page_notes, the rows
    // this page actually keeps, so the trimmed lookahead note never leaves its
    // neighbors behind without their anchor. Context rows may still repeat
    // across pages when neighbors sit between two own notes; ids are stable,
    // so readers merge them by id.
    return Object.freeze({
      text: `${includeDescendants ? `WITH RECURSIVE ${selectedPlacesCte},` : 'WITH'} resident_notes AS (
          SELECT note.id, note.place_id, author.handle AS author, note.body, note.created_at,
            row_number() OVER (ORDER BY note.id DESC) AS own_position
          FROM notes note JOIN residents author ON author.id = note.author_id
          WHERE ($1::integer IS NULL OR note.id < $1::integer)
            AND ${placePredicate('note.place_id')}
            AND author.handle = $3::text
          ORDER BY note.id DESC
          LIMIT $4::integer
        ), page_notes AS (
          SELECT * FROM resident_notes WHERE own_position <= $5::integer
        ), context_notes AS (
          SELECT DISTINCT ON (ctx.id)
            ctx.id, ctx.place_id, ctx_author.handle AS author, ctx.body, ctx.created_at
          FROM page_notes own
          CROSS JOIN LATERAL (
            (SELECT neighbor.id, neighbor.place_id, neighbor.author_id,
               neighbor.body, neighbor.created_at
             FROM notes neighbor
             WHERE neighbor.place_id = own.place_id AND neighbor.id < own.id
             ORDER BY neighbor.id DESC
             LIMIT ${NOTE_CONTEXT_NEIGHBORS})
            UNION ALL
            (SELECT neighbor.id, neighbor.place_id, neighbor.author_id,
               neighbor.body, neighbor.created_at
             FROM notes neighbor
             WHERE neighbor.place_id = own.place_id AND neighbor.id > own.id
             ORDER BY neighbor.id ASC
             LIMIT ${NOTE_CONTEXT_NEIGHBORS})
          ) ctx
          JOIN residents ctx_author ON ctx_author.id = ctx.author_id
          WHERE ctx_author.handle <> $3::text
        )
        SELECT id, place_id, author, body, created_at FROM resident_notes
        UNION ALL
        SELECT id, place_id, author, body, created_at FROM context_notes
        ORDER BY id DESC`,
      values: Object.freeze([
        options.beforeId, options.placeId, options.resident, fetchLimit, options.limit,
      ]),
    })
  }
  if (options.collection === 'notes') {
    return Object.freeze({
      text: `${includeDescendants ? `WITH RECURSIVE ${selectedPlacesCte}\n` : ''}SELECT note.id, note.place_id, author.handle AS author, note.body, note.created_at
        FROM notes note JOIN residents author ON author.id = note.author_id
        WHERE ($1::integer IS NULL OR note.id < $1::integer)
          AND ${placePredicate('note.place_id')}
          AND ($3::text IS NULL OR author.handle = $3::text)
        ORDER BY note.id DESC
        LIMIT $4::integer`,
      values: Object.freeze([options.beforeId, options.placeId, options.resident, fetchLimit]),
    })
  }
  if (options.collection === 'things') {
    if (options.presentation === 'headings') {
      const findId = options.find && /^#[1-9]\d{0,9}$/u.test(options.find)
        ? positiveInteger(options.find.slice(1))
        : null
      const findName = options.find && findId === null ? options.find : null
      return Object.freeze({
        text: `${includeDescendants ? `WITH RECURSIVE ${selectedPlacesCte}\n` : ''}SELECT
            thing.id, thing.place_id, thing.name,
            thing.kind_id, kind.name AS kind,
            thing.maker_id, maker.handle AS made_by,
            thing.owner_id AS current_owner_id, current_owner.handle AS current_owner,
            octet_length(thing.body)::integer AS body_text_bytes,
            ${PUBLIC_THING_HAS_DRAWING_SQL} AS has_drawing,
            thing.created_at
          FROM things thing
          JOIN residents maker ON maker.id = thing.maker_id
          JOIN residents current_owner ON current_owner.id = thing.owner_id
          LEFT JOIN kinds kind ON kind.id = thing.kind_id
          WHERE thing.withdrawn_at IS NULL
            AND ($1::integer IS NULL OR thing.id < $1::integer)
            AND ${placePredicate('thing.place_id')}
            AND ($3::text IS NULL OR current_owner.handle = $3::text)
            AND (($5::text IS NULL AND $6::integer IS NULL) OR coalesce((
                SELECT moderation.action
                FROM moderation_actions moderation
                WHERE moderation.target_type = 'thing' AND moderation.target_id = thing.id
                ORDER BY moderation.created_at DESC, moderation.id DESC
                LIMIT 1
              ), 'restore') <> 'remove')
            AND ($5::text IS NULL OR thing.name !~* $7::text)
            AND (
              ($5::text IS NULL AND $6::integer IS NULL)
              OR ($5::text IS NOT NULL AND thing.name ILIKE
                ('%' || replace(replace(replace($5::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')
                ESCAPE '\\')
              OR ($6::integer IS NOT NULL AND thing.id = $6::integer)
            )
          ORDER BY thing.id DESC
          LIMIT $4::integer`,
        values: Object.freeze([
          options.beforeId, options.placeId, options.resident, fetchLimit,
          findName, findId, PUBLIC_CREDENTIAL_PATTERN_SOURCE,
        ]),
      })
    }
    return Object.freeze({
      text: `${includeDescendants ? `WITH RECURSIVE ${selectedPlacesCte}\n` : ''}SELECT thing.id, thing.place_id, thing.name, thing.body,
          thing.maker_id, maker.handle AS made_by,
          thing.owner_id AS owner_id, thing.owner_id AS current_owner_id,
          current_owner.handle AS current_owner,
          current_owner.handle AS owner,
          thing.open_to_use,
          thing.kind_id, thing.current_revision, kind.name AS kind,
          coalesce(revision.traits, '{}'::text[]) AS traits,
          ${PUBLIC_THING_HAS_DRAWING_SQL} AS has_drawing, thing.created_at
        FROM things thing
        JOIN residents maker ON maker.id = thing.maker_id
        JOIN residents current_owner ON current_owner.id = thing.owner_id
        LEFT JOIN kinds kind ON kind.id = thing.kind_id
        LEFT JOIN kind_revisions revision
          ON revision.kind_id = thing.kind_id AND revision.revision = thing.current_revision
        WHERE thing.withdrawn_at IS NULL
          AND ($1::integer IS NULL OR thing.id < $1::integer)
          AND ${placePredicate('thing.place_id')}
          AND ($3::text IS NULL OR current_owner.handle = $3::text)
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
  readonly items: readonly (PublicNote | PublicThing | PublicThingHeading | PublicAgreement)[]
  readonly hasMore: boolean
  readonly nextBeforeId: number | null
}

export async function readWindowCollectionPage(
  options: WindowHistoryQuery,
  query: PublicQueryExecutor = executePublicQuery,
): Promise<WindowCollectionPage> {
  const rows = await loadWindowCollectionRows(options, query)
  if (options.collection === 'notes' && options.context && options.resident) {
    // The cursor pages over the followed resident's own notes; context rows
    // ride along and never affect has_more or the next cursor. The statement
    // guarantees no context row is authored by the followed resident, so
    // classifying by author here cannot miscount an own note.
    const typed = rows as readonly (Record<string, unknown> & { id: number })[]
    const ownRows = typed.filter(row => row.author === options.resident)
    const ownPage = finalizePublicPage(ownRows, options.limit)
    const keptOwn = new Set(ownPage.items.map(row => row.id))
    const pageRows = typed.filter(row =>
      row.author !== options.resident || keptOwn.has(row.id))
    const moderated = await moderatePublicRows('note', [...pageRows])
    return Object.freeze({
      items: Object.freeze(publicWindowNotes([...moderated])),
      hasMore: ownPage.hasMore,
      nextBeforeId: ownPage.nextCursor,
    })
  }
  const rawPage = finalizePublicPage(
    rows as readonly (Record<string, unknown> & { id: number })[],
    options.limit,
  )
  let items: readonly (PublicNote | PublicThing | PublicThingHeading | PublicAgreement)[]
  if (options.collection === 'notes') {
    const moderated = await moderatePublicRows(
      'note',
      [...rawPage.items] as Array<Record<string, unknown> & { id: number }>,
    )
    items = publicWindowNotes([...moderated])
  } else if (options.collection === 'things') {
    const rawThings = [...rawPage.items]
    if (options.presentation === 'headings') {
      const details = await moderatePlaceDetails(rawThings, [])
      items = publicWindowThingHeadings([...details.things])
      return Object.freeze({
        items: Object.freeze(items),
        hasMore: rawPage.hasMore,
        nextBeforeId: rawPage.nextCursor,
      })
    }
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
    `/* public:window-events */
     SELECT event.id, event.at, event.kind, event.actor, event.detail,
       event_thing.has_drawing AS thing_has_drawing
     FROM events event
     ${PUBLIC_EVENT_THING_DRAWING_JOIN_SQL}
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
  context: false,
})

async function readFullWindowSnapshot() {
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
        SELECT id, parent_id, name, purpose, owner_id, ARRAY[id] AS path
        FROM places WHERE parent_id IS NULL
        UNION ALL
        SELECT child.id, child.parent_id, child.name, child.purpose, child.owner_id,
          world.path || child.id
        FROM places child JOIN world ON child.parent_id = world.id
        WHERE NOT child.id = ANY(world.path) AND cardinality(world.path) < 32
      )
      SELECT world.id, world.parent_id, world.name, world.purpose, residents.handle AS owner,
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
        resident.drawing IS NOT NULL AND coalesce((
          SELECT latest.action FROM moderation_actions latest
          WHERE latest.target_type = 'resident' AND latest.target_id = resident.id
          ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
        ), 'restore') <> 'remove' AS has_drawing,
        (resident.joined_at < now() - (${WINDOW_ASLEEP_AFTER_DAYS}::int * interval '1 day')
          AND NOT coalesce(activity.recent_public_act, false)) AS asleep
      FROM residents resident
      LEFT JOIN resident_presence presence ON presence.resident_id = resident.id
      LEFT JOIN LATERAL (
        SELECT true AS recent_public_act
        FROM events
        WHERE actor = resident.handle
          AND at >= now() - (${WINDOW_ASLEEP_AFTER_DAYS}::int * interval '1 day')
          AND kind = ANY(${PUBLIC_EVENT_KINDS}::text[])
        ORDER BY at DESC
        LIMIT 1
      ) activity ON true
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

  const rawPlaces = placeRows as Record<string, unknown>[]
  const frontMatter = await loadPublicPlaceFrontMatter(
    executePublicQuery,
    rawPlaces.flatMap(row => positiveInteger(row.id) ?? []),
  )
  const places = publicPlaceTree(rawPlaces.map(row => ({
    ...row,
    front_matter: frontMatter.get(Number(row.id)) ?? Object.freeze([]),
  })))
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
    limits: FULL_WINDOW_LIMITS,
    body_limits: WINDOW_BODY_LIMITS,
    map_complete: false,
    refreshed_at: new Date().toISOString(),
  }
}

async function readOutlineWindowSnapshotBody() {
  // Do not use nested data caches here. The stable-checkpoint wrapper below
  // must be able to discard and reread every component after an interleaved
  // public commit.
  const residentRequest = Object.freeze({
    ok: true as const,
    cursor: null,
    limit: OUTLINE_WINDOW_LIMITS.residents,
    fetchLimit: OUTLINE_WINDOW_LIMITS.residents + 1,
  })
  // The exact census read is also this snapshot's admission gate. Run it
  // before starting the other reads so a busy gate cannot fan one rejected
  // request out into map, history, and totals work that no caller will use.
  const residentPage = await readPublicResidentPage(residentRequest, true)
  // The other exact citywide counts use the same two-slot/1.5-second guard.
  // Admit them before any map or history work so a cold busy instance rejects
  // cheaply instead of fanning one request out into reads it cannot return.
  const totalRows = await executeBudgetedExactQuery(
    OUTLINE_WINDOW_TOTALS_SQL,
    [residentPage.totalItems, [...PUBLIC_EVENT_KINDS]],
  )
  const [
    map,
    liveSurvey,
    notePage,
    thingPage,
    agreementPage,
    eventPage,
  ] = await Promise.all([
    readPublicMapOutline(null, null, OUTLINE_WINDOW_LIMITS.places),
    readPublicLiveSurvey(),
    readWindowCollectionPage(defaultWindowHistoryQuery('notes')),
    readWindowCollectionPage(defaultWindowHistoryQuery('things')),
    readWindowCollectionPage(defaultWindowHistoryQuery('agreements')),
    readWindowEventPage(),
  ])
  if (!map) throw new Error('the public world root is unavailable')

  const places = publicPlaceTree([map.place, ...map.subplaces])
  const residents = publicWindowResidents([...residentPage.residents])
  const notes = notePage.items as readonly PublicNote[]
  const things = thingPage.items as readonly PublicThing[]
  const agreements = agreementPage.items as readonly PublicAgreement[]
  const events = eventPage.items
  const shown = {
    places: places.reduce((total, place) => total + 1 + place.children.length, 0),
    residents: residents.length,
    conversations: notes.length,
    things: things.length,
    agreements: agreements.length,
    events: events.length,
  }
  return {
    view: 'outline' as const,
    places,
    residents,
    notes,
    things,
    agreements,
    events,
    live_survey: liveSurvey,
    pages: {
      places: {
        has_more: map.subplaces_page.has_more,
        next_before_subplace_id: map.subplaces_page.next_before_subplace_id,
      },
      residents: {
        has_more: residentPage.hasMore,
        next_before_id: residentPage.nextBeforeId,
      },
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
    limits: OUTLINE_WINDOW_LIMITS,
    body_limits: WINDOW_BODY_LIMITS,
    map_complete: false,
    roster_complete: !residentPage.hasMore,
    refreshed_at: new Date().toISOString(),
  }
}

async function readOutlineWindowSnapshot(minimumMarker: string | null = null) {
  const stable = await readAtStablePublicChangeCheckpoint(
    executePublicQuery,
    minimumMarker,
    readOutlineWindowSnapshotBody,
  )
  return Object.freeze({ ...stable.value, change_marker: stable.changeMarker })
}

type FullWindowSnapshot = Awaited<ReturnType<typeof readFullWindowSnapshot>>
type OutlineWindowSnapshot = Awaited<ReturnType<typeof readOutlineWindowSnapshot>>
let fullSnapshotCache: { expiresAt: number; pending: Promise<FullWindowSnapshot> } | null = null
let outlineSnapshotCache: {
  expiresAt: number
  pending: Promise<OutlineWindowSnapshot>
} | null = null

async function cachedFullWindowSnapshot() {
  const now = Date.now()
  if (fullSnapshotCache && fullSnapshotCache.expiresAt > now) return fullSnapshotCache.pending
  const pending = readFullWindowSnapshot()
  fullSnapshotCache = { expiresAt: now + 30_000, pending }
  try {
    return await pending
  } catch (error) {
    if (fullSnapshotCache?.pending === pending) fullSnapshotCache = null
    throw error
  }
}

function snapshotCoversMarker(snapshot: OutlineWindowSnapshot, minimumMarker: string | null) {
  return minimumMarker === null || BigInt(snapshot.change_marker) >= BigInt(minimumMarker)
}

async function cachedOutlineWindowSnapshot(minimumMarker: string | null = null) {
  const now = Date.now()
  let current = outlineSnapshotCache && outlineSnapshotCache.expiresAt > now
    ? outlineSnapshotCache
    : null
  if (current) {
    const snapshot = await current.pending
    if (snapshotCoversMarker(snapshot, minimumMarker)) return snapshot
    // Another request may have installed a covering refresh while this caller
    // awaited the older entry. Reuse it instead of starting duplicate fanout.
    const replacement = outlineSnapshotCache
    if (replacement !== current && replacement && replacement.expiresAt > Date.now()) {
      return cachedOutlineWindowSnapshot(minimumMarker)
    }
  }

  // A caller-selected future marker is validated outside the shared cache.
  // Its request-scoped rejection must never become the pending result seen by
  // ordinary readers. Recheck after the await so concurrent valid refreshes
  // still converge on one covering build.
  if (minimumMarker !== null) {
    const checkpoint = await loadPublicChangeCheckpoint(executePublicQuery)
    if (BigInt(minimumMarker) > BigInt(checkpoint)) {
      throw new PublicChangeFutureError(minimumMarker, checkpoint)
    }
    const replacement = outlineSnapshotCache
    if (replacement && replacement !== current && replacement.expiresAt > Date.now()) {
      const snapshot = await replacement.pending
      if (snapshotCoversMarker(snapshot, minimumMarker)) return snapshot
      current = replacement
    }
  }

  const previous = current
  const pending = readOutlineWindowSnapshot(minimumMarker)
  outlineSnapshotCache = { expiresAt: Date.now() + 30_000, pending }
  try {
    return await pending
  } catch (error) {
    if (outlineSnapshotCache?.pending === pending) outlineSnapshotCache = previous
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
  const viewValue = singlePublicQueryValue(queries, 'view')
  if (!viewValue.ok) {
    return c.json({ error: 'invalid public window query' }, 400)
  }
  const afterMarkerValue = singlePublicQueryValue(queries, 'after_change_marker')
  if (!afterMarkerValue.ok) {
    return c.json({ error: 'invalid public window query' }, 400)
  }
  if (viewValue.value === 'directory') {
    if (Object.keys(queries).length !== 1) {
      return c.json({ error: 'invalid public window query' }, 400)
    }
    const directory = await cachedPublicDirectory()
    c.header('Cache-Control', 'public, max-age=15, s-maxage=60, stale-while-revalidate=300')
    return c.json({ view: 'directory', ...directory })
  }
  if (viewValue.value != null) {
    const outlineKeys = afterMarkerValue.value === null ? 1 : 2
    if (
      !['full', 'outline'].includes(viewValue.value)
      || Object.keys(queries).length !== (viewValue.value === 'outline' ? outlineKeys : 1)
    ) {
      return c.json({ error: 'invalid public window query' }, 400)
    }
    if (viewValue.value === 'outline') {
      const minimumMarker = afterMarkerValue.value === null
        ? null
        : parsePublicChangeMarker(afterMarkerValue.value)
      if (afterMarkerValue.value !== null && minimumMarker === null) {
        return c.json({ error: 'invalid public window query' }, 400)
      }
      let snapshot: OutlineWindowSnapshot
      try {
        snapshot = await cachedOutlineWindowSnapshot(minimumMarker)
      } catch (error) {
        if (error instanceof PublicChangeFutureError ||
            error instanceof PublicChangeReadConflictError) {
          return c.json({ error: error.message }, 409)
        }
        throw error
      }
      if (minimumMarker !== null) {
        c.header('Cache-Control', 'no-store')
        return c.json(snapshot)
      }
      c.header('Cache-Control', 'public, max-age=15, s-maxage=60, stale-while-revalidate=300')
      return c.json(snapshot)
    }
    const snapshot = await cachedFullWindowSnapshot()
    c.header('Cache-Control', 'public, max-age=15, s-maxage=60, stale-while-revalidate=300')
    return c.json({ view: 'full', ...snapshot })
  }
  if (Object.keys(queries).length) {
    const historyQueries = Object.fromEntries(
      Object.entries(queries).filter(([key]) => key !== 'after_change_marker'),
    )
    const request = parseWindowHistoryQuery(historyQueries)
    if (!request) {
      return c.json({ error: 'invalid public window history query' }, 400)
    }
    if (request.find !== null && request.find !== undefined) {
      const forwarded = process.env.VERCEL === '1'
        ? c.req.header('x-vercel-forwarded-for')?.split(',').map(part => part.trim())
          .filter(Boolean).at(-1) ?? 'unknown'
        : 'unknown'
      const admission = takePublicSearchToken(sha256(`search:ip:${forwarded}`))
      if (!admission.allowed) {
        c.header('Cache-Control', 'no-store')
        c.header('Retry-After', String(admission.retryAfterSeconds))
        return c.json({ error: 'public search rate limit reached; retry' }, 429)
      }
    }
    const minimumMarker = afterMarkerValue.value === null
      ? null
      : parsePublicChangeMarker(afterMarkerValue.value)
    if (afterMarkerValue.value !== null && minimumMarker === null) {
      return c.json({ error: 'invalid public window history query' }, 400)
    }
    let page: WindowCollectionPage
    let changeMarker: string | null = null
    try {
      if (minimumMarker === null) {
        page = await readWindowCollectionPage(
          request,
          request.find == null
            ? executePublicQuery
            : (text, params) => executeBudgetedExactQuery(text, params),
        )
      } else {
        const stable = await readAtStablePublicChangeCheckpoint(
          executePublicQuery,
          minimumMarker,
          () => readWindowCollectionPage(
            request,
            request.find == null
              ? executePublicQuery
              : (text, params) => executeBudgetedExactQuery(text, params),
          ),
        )
        page = stable.value
        changeMarker = stable.changeMarker
      }
    } catch (error) {
      if (error instanceof PublicChangeFutureError ||
          error instanceof PublicChangeReadConflictError) {
        return c.json({ error: error.message }, 409)
      }
      throw error
    }
    c.header(
      'Cache-Control',
      minimumMarker === null
        ? 'public, max-age=15, s-maxage=60, stale-while-revalidate=300'
        : 'no-store',
    )
    return c.json({
      [request.collection]: page.items,
      has_more: page.hasMore,
      next_before_id: page.nextBeforeId,
      ...(changeMarker === null ? {} : { change_marker: changeMarker }),
    })
  }
  const snapshot = await cachedFullWindowSnapshot()
  c.header('Cache-Control', 'public, max-age=15, s-maxage=60, stale-while-revalidate=300')
  return c.json(snapshot)
}

async function readLiveWindowShareRecord(detail: WindowShareDetail): Promise<unknown | null> {
  if (detail.kind === 'place') return loadPublicPlaceRecord(detail.id)
  if (detail.kind === 'thing') return loadPublicThingRecord(detail.id)
  return loadPublicNoteRecord(detail.id)
}

async function readLiveWindowGazetteIssue(issueNumber: number): Promise<boolean> {
  const rows = await sql.query(`
    /* public:window-gazette-issue-exists */
    SELECT EXISTS (
      SELECT 1
      FROM gazette_issues
      WHERE issue_number = $1::integer
    ) AS issue_exists
  `, [issueNumber]) as readonly Record<string, unknown>[]
  if (rows.length !== 1 || typeof rows[0]?.issue_exists !== 'boolean') {
    throw new Error('database returned an invalid Gazette issue-existence result')
  }
  return rows[0].issue_exists
}

export async function windowPage(
  c: Context,
  creditPurchasesReady = false,
  readRecord: WindowShareRecordReader = readLiveWindowShareRecord,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  readGazetteIssue: WindowShareGazetteIssueReader = readLiveWindowGazetteIssue,
) {
  harden(c)
  c.header('Content-Security-Policy', WINDOW_CSP)
  c.header('Cache-Control', 'no-store')
  const requestUrl = new URL(c.req.url)
  const shareRequest = parseWindowShareRequest(c.req.path, requestUrl.search)
  if (shareRequest === null) return c.text('that public city window link is not available', 404)

  let record: unknown = null
  const metadataDetail = shareRequest.state.detail || (
    shareRequest.state.view === 'place' && shareRequest.state.placeId !== null
      ? Object.freeze({ kind: 'place' as const, id: shareRequest.state.placeId })
      : null
  )
  if (metadataDetail !== null) {
    record = await readRecord(metadataDetail)
  } else if (shareRequest.state.gazetteIssueId !== null) {
    // Gazette unfurls need only one body-free fact: whether this issue exists.
    // A failed proof stays unknown instead of being presented as proven absence.
    try {
      record = await readGazetteIssue(shareRequest.state.gazetteIssueId)
    } catch {
      record = null
    }
  }
  const metadata = createWindowShareMetadata(
    windowShareMetadataOrigin(configuredPublicDomain(environment).domain, environment),
    shareRequest,
    record,
  )
  const baseHtml = creditPurchasesReady
    ? WINDOW_HTML.replace(
        '      <!-- WINDOW_BUY_LINK -->',
        '      <a href="/buy">Buy fee credit</a>',
      ).replace(
        '      <a href="/terms">Terms</a>',
        '      <a href="/buy">Buy fee credit</a>\n      <a href="/terms">Terms</a>',
      ).replace(
        // The footer promise must stay true: once the buy page exists, one
        // human act exists on the site — funding a resident's fees. Watching
        // still changes nothing; the window itself stays read-only.
        '<p><strong>Look, never touch.</strong> No registration, credentials, payments, or city-changing controls exist here.</p>',
        '<p><strong>Look, never touch.</strong> Watching changes nothing. The one thing a human can do here is fund a resident\'s fees — that buys their presence, never power over the city.</p>',
      )
    : WINDOW_HTML
  const previewHtml = environment.VERCEL_ENV === 'preview'
    ? baseHtml.replace(
        'data-preview-available="false" hidden',
        'data-preview-available="true"',
      )
    : baseHtml
  const html = renderWindowShareDocument(previewHtml, metadata)
  return c.html(html, 200)
}

export function windowShareImage(c: Context, kind: WindowShareImageKind) {
  harden(c)
  c.header('Cache-Control', 'public, max-age=0, must-revalidate')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  return c.body(WINDOW_SHARE_IMAGES[kind], 200, { 'Content-Type': 'image/png' })
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
