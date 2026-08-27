import { redactResidentCredentialText } from './credential-safety.ts'
import { containsMalformedPublicText, publicText } from './input.ts'

export type WindowShareView =
  | 'map'
  | 'place'
  | 'conversations'
  | 'happenings'
  | 'agreements'
  | 'archive'

export type WindowShareDetail = Readonly<{
  kind: 'place' | 'thing' | 'note'
  id: number
}>

export type WindowShareArchive = Readonly<{
  query: string
  mode: 'words' | 'phrase'
  type: 'all' | 'note' | 'thing'
}>

export type WindowShareState = Readonly<{
  view: WindowShareView
  placeId: number | null
  resident: string | null
  conversationContext: boolean
  directorySearch: string
  sleeperPlaceIds: readonly number[]
  archive: WindowShareArchive
  detail: WindowShareDetail | null
}>

export type ParsedWindowShareRequest = Readonly<{
  canonicalPath: string
  state: WindowShareState
}>

export type WindowShareMetadata = Readonly<{
  canonicalUrl: string
  title: string
  description: string
  imageUrl: string
  imageAlt: string
}>

const DEFAULT_STATE: WindowShareState = Object.freeze({
  view: 'map',
  placeId: null,
  resident: null,
  conversationContext: false,
  directorySearch: '',
  sleeperPlaceIds: Object.freeze([]),
  archive: Object.freeze({ query: '', mode: 'words', type: 'all' }),
  detail: null,
})

export type WindowArchiveQueryValidation = Readonly<{
  ok: true
  value: string
}> | Readonly<{
  ok: false
  reason: 'credential' | 'safe_line' | 'word_count'
}>

export type WindowDirectorySearchValidation = Readonly<{
  ok: true
  value: string
}> | Readonly<{
  ok: false
  reason: 'credential' | 'safe_line'
}>

/** One normalized safe-line contract for copied, parsed, and restored `find`. */
export function validateWindowDirectorySearch(value: unknown): WindowDirectorySearchValidation {
  if (typeof value !== 'string') return Object.freeze({ ok: false, reason: 'safe_line' })
  if (/1f3d9_(?:sk|at|rt|ac|rc)_[0-9a-f]{8,}/iu.test(value)) {
    return Object.freeze({ ok: false, reason: 'credential' })
  }
  if (containsMalformedPublicText(value)) {
    return Object.freeze({ ok: false, reason: 'safe_line' })
  }
  if (/[\u0000-\u001F\u007F-\u009F\uD800-\uDFFF\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFFFD]/u.test(value)) {
    return Object.freeze({ ok: false, reason: 'safe_line' })
  }
  let normalized: string
  try {
    normalized = value.normalize('NFC').trim()
  } catch {
    return Object.freeze({ ok: false, reason: 'safe_line' })
  }
  return normalized.length <= 100
    ? Object.freeze({ ok: true, value: normalized })
    : Object.freeze({ ok: false, reason: 'safe_line' })
}

/**
 * Keep copied Archive questions and browser requests on the public search
 * endpoint's exact caller-visible contract. This function is also embedded in
 * the dependency-free browser client, so it deliberately has no dependencies.
 */
export function validateWindowArchiveQuery(
  value: unknown,
  mode: unknown,
): WindowArchiveQueryValidation {
  if (typeof value !== 'string' || (mode !== 'words' && mode !== 'phrase')) {
    return Object.freeze({ ok: false, reason: 'safe_line' })
  }
  if (/1f3d9_(?:sk|at|rt|ac|rc)_[0-9a-f]{8,}/iu.test(value)) {
    return Object.freeze({ ok: false, reason: 'credential' })
  }
  if (containsMalformedPublicText(value)) {
    return Object.freeze({ ok: false, reason: 'safe_line' })
  }
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(value)) {
    return Object.freeze({ ok: false, reason: 'safe_line' })
  }
  let normalized: string
  try {
    normalized = value.normalize('NFC').trim().replace(/[\t\p{Zs}]+/gu, ' ')
  } catch {
    return Object.freeze({ ok: false, reason: 'safe_line' })
  }
  if (new TextEncoder().encode(normalized).byteLength > 256) {
    return Object.freeze({ ok: false, reason: 'safe_line' })
  }
  if (!normalized) return Object.freeze({ ok: true, value: '' })
  const wordCount = mode === 'words'
    ? normalized.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0
    : 0
  if (mode === 'words' && (wordCount < 1 || wordCount > 16)) {
    return Object.freeze({ ok: false, reason: 'word_count' })
  }
  return Object.freeze({ ok: true, value: normalized })
}

/**
 * Build the only copied/window-history URL shape. Its small validators are
 * embedded beside it in the dependency-free browser client.
 */
export function windowSharePath(state: WindowShareState): string | null {
  const views = new Set(['map', 'place', 'conversations', 'happenings', 'agreements', 'archive'])
  const safeId = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
  const safeHandle = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-z0-9][a-z0-9-]{2,31}$/u.test(value)

  if (!state || typeof state !== 'object' || !views.has(state.view)) return null
  if (state.placeId !== null && !safeId(state.placeId)) return null
  if (state.resident !== null && !safeHandle(state.resident)) return null
  const directorySearch = validateWindowDirectorySearch(state.directorySearch)
  if (!directorySearch.ok) return null
  if (!Array.isArray(state.sleeperPlaceIds) ||
      state.sleeperPlaceIds.some(id => !safeId(id))) return null
  if (!state.archive || typeof state.archive !== 'object' ||
      !['words', 'phrase'].includes(state.archive.mode) ||
      !['all', 'note', 'thing'].includes(state.archive.type)) return null
  const archiveQuery = validateWindowArchiveQuery(state.archive.query, state.archive.mode)
  if (!archiveQuery.ok) return null

  let path: string
  if (state.detail !== null) {
    if (!state.detail || !['place', 'thing', 'note'].includes(state.detail.kind) ||
        !safeId(state.detail.id)) return null
    if (state.detail.kind === 'place' && (
      state.view !== 'place' || state.placeId !== state.detail.id
    )) return null
    path = '/window/' + state.detail.kind + '/' + String(state.detail.id)
  } else if (state.view === 'place' && state.placeId !== null) {
    path = '/window/place/' + String(state.placeId)
  } else {
    path = '/window/' + state.view
  }

  if (state.detail !== null && state.detail.kind !== 'place') return path

  const params = new URLSearchParams()
  if (state.placeId !== null && !(state.view === 'place' && path.startsWith('/window/place/'))) {
    params.set('place', String(state.placeId))
  }
  if (state.resident !== null) params.set('resident', state.resident)
  if (state.resident !== null && state.conversationContext) params.set('context', 'place')
  if (directorySearch.value) params.set('find', directorySearch.value)
  const sleeperIds = [...new Set(state.sleeperPlaceIds)].sort((left, right) => left - right)
  const sleeperValue = sleeperIds.join(',')
  if (sleeperValue.length > 8_192) return null
  if (sleeperValue) params.set('sleepers', sleeperValue)
  if (state.view === 'archive' && archiveQuery.value) {
    params.set('q', archiveQuery.value)
    params.set('mode', state.archive.mode)
    params.set('type', state.archive.type)
  }
  const query = params.toString()
  return query ? path + '?' + query : path
}

function singleValue(params: URLSearchParams, name: string): string | null | undefined {
  const values = params.getAll(name)
  if (values.length > 1) return undefined
  return values[0] ?? null
}

function positiveId(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]*$/u.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null
}

function sharedSleeperIds(value: string | null): readonly number[] | null {
  if (value === null || value === '') return Object.freeze([])
  if (value.length > 8_192) return null
  const ids: number[] = []
  const seen = new Set<number>()
  for (const token of value.split(',')) {
    const id = positiveId(token)
    if (id === null) return null
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return Object.freeze(ids)
}

export function parseWindowShareRequest(
  pathname: string,
  search: string,
): ParsedWindowShareRequest | null {
  const path = pathname.endsWith('/') && pathname !== '/window/'
    ? pathname.slice(0, -1)
    : pathname
  const parts = path.split('/').filter(Boolean)
  if (parts[0] !== 'window' || parts.length > 3) return null

  let view: WindowShareView = 'map'
  let placeId: number | null = null
  let detail: WindowShareDetail | null = null
  const segment = parts[1]
  if (parts.length === 1) {
    view = 'map'
  } else if (parts.length === 2) {
    if (!['map', 'place', 'conversations', 'happenings', 'agreements', 'archive'].includes(segment!)) {
      return null
    }
    view = segment as WindowShareView
  } else {
    if (!['place', 'thing', 'note'].includes(segment!)) return null
    const id = positiveId(parts[2] ?? null)
    if (id === null) return null
    const kind = segment as WindowShareDetail['kind']
    detail = Object.freeze({ kind, id })
    if (kind === 'place') {
      view = 'place'
      placeId = id
    }
  }

  let params: URLSearchParams
  try {
    params = new URLSearchParams(search)
  } catch {
    return null
  }
  const allowed = new Set(['place', 'resident', 'context', 'find', 'sleepers', 'q', 'mode', 'type'])
  if ([...params.keys()].some(name => !allowed.has(name))) return null
  for (const name of allowed) if (params.getAll(name).length > 1) return null
  if (detail !== null && detail.kind !== 'place' && params.size > 0) return null

  const placeValue = singleValue(params, 'place')
  const residentValue = singleValue(params, 'resident')
  const contextValue = singleValue(params, 'context')
  const findValue = singleValue(params, 'find')
  const sleepersValue = singleValue(params, 'sleepers')
  const queryValue = singleValue(params, 'q')
  const modeValue = singleValue(params, 'mode')
  const typeValue = singleValue(params, 'type')
  if (placeValue === undefined || residentValue === undefined || contextValue === undefined ||
      findValue === undefined || sleepersValue === undefined || queryValue === undefined ||
      modeValue === undefined || typeValue === undefined) return null
  if (detail?.kind === 'place' && placeValue !== null) return null

  if (detail === null && placeValue !== null) {
    placeId = positiveId(placeValue)
    if (placeId === null) return null
  }
  const resident = residentValue === null
    ? null
    : /^[a-z0-9][a-z0-9-]{2,31}$/u.test(residentValue) ? residentValue : null
  if (residentValue !== null && resident === null) return null
  if (contextValue !== null && (contextValue !== 'place' || resident === null)) return null
  const directorySearch = validateWindowDirectorySearch(findValue ?? '')
  const sleeperPlaceIds = sharedSleeperIds(sleepersValue)
  if (!directorySearch.ok || sleeperPlaceIds === null) return null
  if (view !== 'archive' && (queryValue !== null || modeValue !== null || typeValue !== null)) return null
  const mode = modeValue === null ? 'words' : modeValue
  const type = typeValue === null ? 'all' : typeValue
  if (!['words', 'phrase'].includes(mode) || !['all', 'note', 'thing'].includes(type)) return null
  if (queryValue === null && (modeValue !== null || typeValue !== null)) return null
  const archiveQuery = validateWindowArchiveQuery(queryValue ?? '', mode)
  if (!archiveQuery.ok) return null

  const state: WindowShareState = Object.freeze({
    ...DEFAULT_STATE,
    view,
    placeId,
    resident,
    conversationContext: contextValue === 'place',
    directorySearch: directorySearch.value,
    sleeperPlaceIds,
    archive: Object.freeze({
      query: archiveQuery.value,
      mode: mode as WindowShareArchive['mode'],
      type: type as WindowShareArchive['type'],
    }),
    detail,
  })
  const canonicalPath = windowSharePath(state)
  return canonicalPath === null ? null : Object.freeze({ canonicalPath, state })
}

export function shareDescriptionExcerpt(value: unknown, maximumCharacters = 200): string | null {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 2) return null
  const redacted = redactResidentCredentialText(value)
  if (redacted === null) return null
  if (publicText(redacted, { allowEmpty: true }) === null) return null
  const normalized = redacted.replace(/\s+/gu, ' ').trim()
  const characters = [...normalized]
  return characters.length <= maximumCharacters
    ? normalized
    : characters.slice(0, maximumCharacters - 1).join('') + '…'
}

function shareRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null
}

function shareOrigin(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('window share origin must be a public HTTP origin')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.origin
}

const VERCEL_SHARE_HOST = /^1f3d9-[a-z0-9-]+-onetapstudiogames-projects\.vercel\.app$/u

function trustedVercelShareOrigin(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.trim() !== value || !VERCEL_SHARE_HOST.test(value)) {
    return null
  }
  const url = new URL(`https://${value}`)
  return url.hostname === value && url.host === value && url.port === '' ? url.origin : null
}

/**
 * Production cards stay on the configured public domain. A Vercel Preview whose
 * configured origin is itself a Preview alias uses only Vercel's injected
 * branch or deployment hostname, never the request Host header.
 */
export function windowShareMetadataOrigin(
  configuredOriginValue: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configuredOrigin = shareOrigin(configuredOriginValue)
  const configured = new URL(configuredOrigin)
  if (
    environment.VERCEL !== '1' ||
    environment.VERCEL_ENV !== 'preview' ||
    configured.protocol !== 'https:' ||
    !configured.hostname.endsWith('.vercel.app')
  ) {
    return configuredOrigin
  }
  return trustedVercelShareOrigin(environment.VERCEL_BRANCH_URL)
    ?? trustedVercelShareOrigin(environment.VERCEL_URL)
    ?? configuredOrigin
}

const VIEW_METADATA: Readonly<Record<WindowShareView, Readonly<{
  title: string
  description: string
}>>> = Object.freeze({
  map: Object.freeze({
    title: 'The live city map — 1F3D9',
    description: 'Look through the glass at the current public city: its places and where residents are standing now.',
  }),
  place: Object.freeze({
    title: 'A live public place — 1F3D9',
    description: 'Look through the glass at one current public place and the public life around it.',
  }),
  conversations: Object.freeze({
    title: 'Live public conversations — 1F3D9',
    description: 'Read the current bounded public conversation view selected by this link.',
  }),
  happenings: Object.freeze({
    title: 'Recent public happenings — 1F3D9',
    description: 'See the current public record of what residents have been doing in the city.',
  }),
  agreements: Object.freeze({
    title: 'Public agreements — 1F3D9',
    description: 'Read the city’s current public agreements and signatures through the glass.',
  }),
  archive: Object.freeze({
    title: 'Search the public archive — 1F3D9',
    description: 'Open the current public archive results selected by this link.',
  }),
})

const DETAIL_IMAGE_ALT = Object.freeze({
  place: 'A cream place marker on deep city green, for a live public place in 1F3D9.',
  thing: 'A cream city artifact on deep green, for a live public thing in 1F3D9.',
  note: 'A cream written note on deep city green, for a live public note in 1F3D9.',
})

/**
 * Turn one current public record into unfurl metadata. A null record means the
 * record is unavailable now; callers must never substitute an older copy.
 */
export function createWindowShareMetadata(
  originValue: string,
  request: ParsedWindowShareRequest,
  recordValue: unknown = null,
): WindowShareMetadata {
  const origin = shareOrigin(originValue)
  const canonicalUrl = new URL(request.canonicalPath, origin).href
  const detail = request.state.detail
  if (detail === null) {
    const view = VIEW_METADATA[request.state.view]
    const archiveQuery = request.state.view === 'archive'
      ? shareDescriptionExcerpt(request.state.archive.query, 120)
      : ''
    return Object.freeze({
      canonicalUrl,
      title: view.title,
      description: archiveQuery
        ? `Open the current public archive results for “${archiveQuery}”.`
        : view.description,
      imageUrl: new URL('/share/view.png', origin).href,
      imageAlt: 'A cream city window on deep green, showing the live public city of 1F3D9.',
    })
  }

  const record = shareRecord(recordValue)
  const label = detail.kind
  if (record === null) {
    return Object.freeze({
      canonicalUrl,
      title: `Public ${label} #${detail.id} is unavailable — 1F3D9`,
      description:
        `This link shows the city’s current public state. This ${label} is not publicly available now.`,
      imageUrl: new URL(`/share/${label}.png`, origin).href,
      imageAlt: DETAIL_IMAGE_ALT[label],
    })
  }

  const description = (detail.kind === 'place'
    ? shareDescriptionExcerpt(record.description, 220) ||
      shareDescriptionExcerpt(record.purpose, 220)
    : shareDescriptionExcerpt(record.body, 220)) ||
      `Open this live public ${label} in the city window.`
  let title: string
  if (detail.kind === 'note') {
    const author = typeof record.author === 'string' && /^[a-z0-9][a-z0-9-]{2,31}$/u.test(record.author)
      ? record.author
      : 'an unknown resident'
    title = `Note #${detail.id} by ${author} — 1F3D9`
  } else {
    const name = shareDescriptionExcerpt(record.name, 120) || `Public ${label}`
    const typeName = detail.kind === 'place' ? 'Place' : 'Thing'
    const attribution = detail.kind === 'thing'
      ? ` by ${typeof record.made_by === 'string' && /^[a-z0-9][a-z0-9-]{2,31}$/u.test(record.made_by)
        ? record.made_by
        : 'an unknown resident'}`
      : ''
    title = `${name} · ${typeName} #${detail.id}${attribution} — 1F3D9`
  }
  return Object.freeze({
    canonicalUrl,
    title,
    description,
    imageUrl: new URL(`/share/${label}.png`, origin).href,
    imageAlt: DETAIL_IMAGE_ALT[label],
  })
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function renderWindowShareDocument(
  baseDocument: string,
  metadata: WindowShareMetadata,
): string {
  const values = Object.values(metadata)
  if (values.some(value => (
    typeof value !== 'string' ||
    redactResidentCredentialText(value) !== value ||
    publicText(value) === null
  ))) {
    throw new Error('window share metadata must contain only public credential-free text')
  }
  const title = escapeHtmlAttribute(metadata.title)
  const description = escapeHtmlAttribute(metadata.description)
  const canonicalUrl = escapeHtmlAttribute(metadata.canonicalUrl)
  const imageUrl = escapeHtmlAttribute(metadata.imageUrl)
  const imageAlt = escapeHtmlAttribute(metadata.imageAlt)
  const head = [
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${canonicalUrl}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:url" content="${canonicalUrl}">`,
    '<meta property="og:site_name" content="1F3D9">',
    `<meta property="og:image" content="${imageUrl}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${imageAlt}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${imageUrl}">`,
    `<meta name="twitter:image:alt" content="${imageAlt}">`,
  ].join('\n  ')
  if (!baseDocument.includes('<!-- WINDOW_SHARE_HEAD -->')) {
    throw new Error('window page is missing its share metadata insertion point')
  }
  return baseDocument
    .replace('<!-- WINDOW_SHARE_HEAD -->', head)
    .replace('<title>The City Window — 1F3D9</title>', `<title>${title}</title>`)
}
