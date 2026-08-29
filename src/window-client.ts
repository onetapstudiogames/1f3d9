import { WINDOW_CLIENT_SAFETY_JS } from './window-client-safety.ts'
import { containsMalformedPublicText } from './input.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'
import { BASIC_ACTIONS } from './physics.ts'
import {
  PUBLIC_EVENT_DETAIL_ID_FIELDS,
  PUBLIC_EVENT_KINDS,
  PUBLIC_EVENT_LABELS,
  PUBLIC_SYSTEM_EVENT_ACTORS,
} from './public-events.ts'
import {
  validateWindowArchiveQuery,
  validateWindowDirectorySearch,
  windowSharePath,
} from './window-sharing.ts'

export { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS }

export function parseWindowSleeperPlaceIds(
  value: string | null,
  maximumLength = 8_192,
): number[] {
  if (typeof value !== 'string' || !value || value.length > maximumLength) return []
  const ids: number[] = []
  const seen = new Set<number>()
  for (const token of value.split(',')) {
    if (!/^[1-9]\d*$/u.test(token)) return []
    const id = Number(token)
    if (!Number.isSafeInteger(id) || id > 2_147_483_647) return []
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

export function mergeWindowRows<T extends Readonly<{ id: number }>>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const rows = new Map<number, T>()
  for (const row of current) rows.set(row.id, row)
  for (const row of incoming) rows.set(row.id, row)
  return [...rows.values()].sort((left, right) => right.id - left.id)
}

export function mergeResidentRows<
  T extends Readonly<{ id: number, joined_at: Date }>,
>(
  currentResidents: readonly T[],
  incomingResidents: readonly T[],
): T[] {
  const residents = mergeWindowRows(currentResidents, incomingResidents)
  return [...residents].sort((left, right) => {
    const joinedDifference = right.joined_at.getTime() - left.joined_at.getTime()
    return joinedDifference || right.id - left.id
  })
}

export function windowPlaceLabel(
  placeId: number | null,
  place: Readonly<{ path: string }> | null,
): string | null {
  if (!placeId) return null
  return place?.path ?? `Place #${placeId} · not currently loaded`
}

export type WindowDirectoryPlace = Readonly<{
  id: number
  parent_id: number | null
  name: string
}>

export type WindowDirectoryPlaceWithPath = WindowDirectoryPlace & Readonly<{
  path: string
}>

export type WindowDirectoryPlaceOption = Readonly<{
  id: number
  depth: number
  label: string
}>

export type WindowDirectoryResident = Readonly<{
  id: number
  handle: string
}>

export type WindowDirectorySearchResult = Readonly<{
  kind: 'place' | 'resident'
  id: number
  value: string
  label: string
  detail: string
}>

export type WindowDirectorySearchPage = Readonly<{
  results: readonly WindowDirectorySearchResult[]
  total: number
  placeCount: number
  residentCount: number
  hasMore: boolean
}>

export function windowDirectoryPlaceScopeIds(
  values: readonly WindowDirectoryPlace[],
  placeId: number,
): number[] {
  const children = new Map<number, number[]>()
  for (const value of values) {
    if (value.parent_id === null) continue
    const siblings = children.get(value.parent_id) ?? []
    if (!siblings.includes(value.id)) children.set(value.parent_id, [...siblings, value.id])
  }

  const found: number[] = []
  const seen = new Set<number>()
  const queue = [placeId]
  while (queue.length) {
    const id = queue.shift()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    found.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return found
}

export function deriveWindowDirectoryPlaces(
  values: readonly WindowDirectoryPlace[],
): WindowDirectoryPlaceWithPath[] {
  const maximumPathDepth = 32
  const counts = new Map<number, number>()
  for (const value of values) counts.set(value.id, (counts.get(value.id) ?? 0) + 1)

  const unique = new Map<number, WindowDirectoryPlace>()
  for (const value of values) {
    if (!unique.has(value.id)) unique.set(value.id, value)
  }

  const fallback = (value: WindowDirectoryPlace): string =>
    `${value.name} · Place #${value.id}`
  const pathFor = (value: WindowDirectoryPlace): string => {
    if ((counts.get(value.id) ?? 0) !== 1) return fallback(value)
    const names: string[] = []
    const seen = new Set<number>()
    let current: WindowDirectoryPlace | undefined = value
    while (current) {
      if (
        names.length >= maximumPathDepth || seen.has(current.id) ||
        (counts.get(current.id) ?? 0) !== 1
      ) return fallback(value)
      names.push(current.name)
      seen.add(current.id)
      if (current.parent_id === null) return names.reverse().join(' / ')
      current = unique.get(current.parent_id)
      if (!current) return fallback(value)
    }
    return fallback(value)
  }

  return [...unique.values()].map(value => ({ ...value, path: pathFor(value) }))
}

export function listWindowDirectoryPlaces(
  values: readonly WindowDirectoryPlaceWithPath[],
): WindowDirectoryPlaceOption[] {
  const placesById = new Map(values.map(place => [place.id, place]))
  const rootIds = new Set(values.filter(place => place.parent_id === null).map(place => place.id))
  const continentFor = (place: WindowDirectoryPlaceWithPath) => {
    if (place.parent_id === null) return null
    const seen = new Set<number>()
    let current: WindowDirectoryPlaceWithPath | undefined = place
    while (current && current.parent_id !== null) {
      if (seen.has(current.id)) return undefined
      seen.add(current.id)
      const parent = placesById.get(current.parent_id)
      if (!parent) return undefined
      if (rootIds.has(parent.id)) return current
      current = parent
    }
    return undefined
  }
  type MutableGroup = {
    wholePlaceId: number | null
    options: Array<{ id: number, depth: number, label: string }>
  }
  const groups = new Map<string, MutableGroup>()
  const ensureGroup = (key: string, wholePlaceId: number | null) => {
    const existing = groups.get(key)
    if (existing) return existing
    const created: MutableGroup = { wholePlaceId, options: [] }
    groups.set(key, created)
    return created
  }

  for (const place of values) {
    const parts = place.path.split(' / ').filter(Boolean)
    if (place.parent_id === null) {
      ensureGroup('root', null).options.push({
        id: place.id,
        depth: 0,
        label: `${place.name} · Place #${place.id}`,
      })
      continue
    }

    const continent = continentFor(place)
    if (!continent) {
      ensureGroup('other', null).options.push({
        id: place.id,
        depth: 0,
        label: `${place.name} · Place #${place.id}`,
      })
      continue
    }
    const parent = placesById.get(place.parent_id)
    const depth = Math.max(0, parts.length - 2)
    const shortLabel = `${place.name}${depth > 1 && parent ? ` — in ${parent.name}` : ''} · Place #${place.id}`
    ensureGroup(`continent:${continent.id}`, continent.id).options.push({
      id: place.id,
      depth,
      label: shortLabel,
    })
  }

  return [...groups.values()].flatMap(group => [...group.options]
    .sort((left, right) =>
      Number(right.id === group.wholePlaceId) - Number(left.id === group.wholePlaceId))
    .map(option => Object.freeze(option)))
}

export function searchWindowDirectory(
  places: readonly WindowDirectoryPlaceWithPath[],
  residents: readonly WindowDirectoryResident[],
  query: string,
  limit = 20,
): WindowDirectorySearchResult[] {
  const normalizedSearchText = (value: string): string => value.normalize('NFC').toLowerCase()
  const normalizedQuery = normalizedSearchText(query.trim())
  if (!normalizedQuery) return []
  const safeLimit = Math.max(0, Math.floor(limit))
  const score = (primary: string, searchText: string, id: number): number | null => {
    const normalizedPrimary = normalizedSearchText(primary)
    if (
      normalizedQuery === normalizedPrimary || normalizedQuery === String(id) ||
      normalizedQuery === `#${id}` || normalizedQuery === `place #${id}` ||
      normalizedQuery === `resident #${id}`
    ) return 0
    if (normalizedPrimary.startsWith(normalizedQuery)) return 1
    return normalizedSearchText(searchText).includes(normalizedQuery) ? 2 : null
  }
  const candidates = [
    ...places.flatMap((place, order) => {
      const matchScore = score(
        place.name,
        `${place.name}\n${place.path}\nplace #${place.id}\n#${place.id}`,
        place.id,
      )
      return matchScore === null ? [] : [{
        score: matchScore,
        order,
        result: Object.freeze({
          kind: 'place' as const,
          id: place.id,
          value: String(place.id),
          label: `${place.name} · Place #${place.id}`,
          detail: place.path,
        }),
      }]
    }),
    ...residents.flatMap((resident, index) => {
      const matchScore = score(
        resident.handle,
        `${resident.handle}\nresident #${resident.id}\n#${resident.id}`,
        resident.id,
      )
      return matchScore === null ? [] : [{
        score: matchScore,
        order: places.length + index,
        result: Object.freeze({
          kind: 'resident' as const,
          id: resident.id,
          value: resident.handle,
          label: `${resident.handle} · Resident #${resident.id}`,
          detail: 'Resident',
        }),
      }]
    }),
  ]
  return candidates
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, safeLimit)
    .map(candidate => candidate.result)
}

export function pageWindowDirectorySearch(
  places: readonly WindowDirectoryPlaceWithPath[],
  residents: readonly WindowDirectoryResident[],
  query: string,
  limit = 20,
): WindowDirectorySearchPage {
  const matches = searchWindowDirectory(places, residents, query, Number.MAX_SAFE_INTEGER)
  const safeLimit = Math.max(0, Math.floor(limit))
  const placeCount = matches.filter(result => result.kind === 'place').length
  return Object.freeze({
    results: Object.freeze(matches.slice(0, safeLimit)),
    total: matches.length,
    placeCount,
    residentCount: matches.length - placeCount,
    hasMore: matches.length > safeLimit,
  })
}

const PUBLIC_EVENT_LABELS_JSON = JSON.stringify(PUBLIC_EVENT_LABELS)
const PUBLIC_EVENT_DETAIL_ID_FIELDS_JSON = JSON.stringify(PUBLIC_EVENT_DETAIL_ID_FIELDS)
const PUBLIC_SYSTEM_EVENT_ACTORS_JSON = JSON.stringify(Object.values(PUBLIC_SYSTEM_EVENT_ACTORS))
const BASIC_ACTIONS_JSON = JSON.stringify(BASIC_ACTIONS)
const WORLD_ROOT_NAME_JSON = JSON.stringify(WORLD_ROOT_NAME)
const MERGE_WINDOW_ROWS_JS = mergeWindowRows.toString()
const MERGE_RESIDENT_ROWS_JS = mergeResidentRows.toString()
const WINDOW_PLACE_LABEL_JS = windowPlaceLabel.toString()
const DERIVE_WINDOW_DIRECTORY_PLACES_JS = deriveWindowDirectoryPlaces.toString()
const LIST_WINDOW_DIRECTORY_PLACES_JS = listWindowDirectoryPlaces.toString()
const SEARCH_WINDOW_DIRECTORY_JS = searchWindowDirectory.toString()
const PAGE_WINDOW_DIRECTORY_SEARCH_JS = pageWindowDirectorySearch.toString()
const WINDOW_DIRECTORY_PLACE_SCOPE_IDS_JS = windowDirectoryPlaceScopeIds.toString()
const PARSE_WINDOW_SLEEPER_PLACE_IDS_JS = parseWindowSleeperPlaceIds.toString()
const CONTAINS_MALFORMED_PUBLIC_TEXT_JS = containsMalformedPublicText.toString()
const VALIDATE_WINDOW_ARCHIVE_QUERY_JS = validateWindowArchiveQuery.toString()
const VALIDATE_WINDOW_DIRECTORY_SEARCH_JS = validateWindowDirectorySearch.toString()
const WINDOW_SHARE_PATH_JS = windowSharePath.toString()

export const WINDOW_JS = `(() => {
  'use strict'

  const BASE_REFRESH_MS = 60000
  const MAX_REFRESH_MS = 300000
  const REQUEST_TIMEOUT_MS = 10000
  const MAX_FORWARD_RECONCILE_PAGES = 8
  const GAZETTE_ISSUE_PAGE_LIMIT = 10
  const GAZETTE_ENTRY_PAGE_LIMIT = 25
  const GAZETTE_FIRST_PRINT_AT = '2026-08-31T16:00:00.000Z'
  const GAZETTE_FIRST_PRINT_EMPTY_STATE = 'No Gazette issues have printed yet. The first print is scheduled for Monday, 31 August 2026 at 16:00 UTC.'
  const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/
  const SAFE_WORLD_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
  const MODERATED_TEXT = '[removed by maintainer]'
  const WORLD_ROOT_NAME = ${WORLD_ROOT_NAME_JSON}
  const VIEWS = Object.freeze([
    'map', 'place', 'conversations', 'happenings', 'agreements', 'archive', 'gazette',
  ])
  const SAFE_EVENT_KINDS = new Map(Object.entries(${PUBLIC_EVENT_LABELS_JSON}))
  const SAFE_EVENT_DETAIL_IDS = Object.freeze(${PUBLIC_EVENT_DETAIL_ID_FIELDS_JSON})
  const SAFE_SYSTEM_EVENT_ACTORS = new Set(${PUBLIC_SYSTEM_EVENT_ACTORS_JSON})
  const SAFE_ACTIONS = new Set(${BASIC_ACTIONS_JSON})
  const SAFE_ACTION_STATUSES = new Set(['applied', 'blocked', 'noop', 'failed'])
  const SAFE_EFFECT_STATUSES = new Set(['applied', 'skipped', 'failed'])
  const EVENT_ERROR_LIMIT = 500
  const UNSAFE_EVENT_ERROR = 'the recorded cause could not be shown safely'
  const mergeWindowRows = ${MERGE_WINDOW_ROWS_JS}
  const mergeResidentRows = ${MERGE_RESIDENT_ROWS_JS}
  const windowPlaceLabel = ${WINDOW_PLACE_LABEL_JS}
  const deriveWindowDirectoryPlaces = ${DERIVE_WINDOW_DIRECTORY_PLACES_JS}
  const listWindowDirectoryPlaces = ${LIST_WINDOW_DIRECTORY_PLACES_JS}
  const searchWindowDirectory = ${SEARCH_WINDOW_DIRECTORY_JS}
  const pageWindowDirectorySearch = ${PAGE_WINDOW_DIRECTORY_SEARCH_JS}
  const windowDirectoryPlaceScopeIds = ${WINDOW_DIRECTORY_PLACE_SCOPE_IDS_JS}
  const parseWindowSleeperPlaceIds = ${PARSE_WINDOW_SLEEPER_PLACE_IDS_JS}
  const containsMalformedPublicText = ${CONTAINS_MALFORMED_PUBLIC_TEXT_JS}
  const validateWindowArchiveQuery = ${VALIDATE_WINDOW_ARCHIVE_QUERY_JS}
  const validateWindowDirectorySearch = ${VALIDATE_WINDOW_DIRECTORY_SEARCH_JS}
  const windowSharePath = ${WINDOW_SHARE_PATH_JS}

  const nodes = {
    status: document.getElementById('window-status'),
    counts: document.getElementById('city-counts'),
    scope: document.getElementById('view-scope'),
    map: document.getElementById('place-map'),
    roster: document.getElementById('resident-roster'),
    residentPage: document.getElementById('resident-page'),
    directorySearch: document.getElementById('directory-search'),
    directorySearchResults: document.getElementById('directory-search-results'),
    directorySearchStatus: document.getElementById('directory-search-status'),
    placeFilter: document.getElementById('place-filter'),
    residentFilter: document.getElementById('resident-filter'),
    directoryStatus: document.getElementById('directory-status'),
    shareStatus: document.getElementById('share-status'),
    detailShareStatus: document.getElementById('record-detail-share-status'),
    detail: document.getElementById('record-detail'),
    detailKind: document.getElementById('record-detail-kind'),
    detailTitle: document.getElementById('record-detail-title'),
    detailBody: document.getElementById('record-detail-body'),
    detailClose: document.getElementById('record-detail-close'),
    placeTitle: document.getElementById('place-focus-title'),
    placeSummary: document.getElementById('place-focus-summary'),
    placePurposeLabel: document.getElementById('place-purpose-title'),
    placePurpose: document.getElementById('place-purpose'),
    placeFrontMatterLabel: document.getElementById('place-front-matter-title'),
    placeFrontMatter: document.getElementById('place-front-matter'),
    occupants: document.getElementById('place-occupants'),
    placeThings: document.getElementById('place-things'),
    placeThingsPage: document.getElementById('place-things-page'),
    placeConversation: document.getElementById('place-conversation'),
    placeNotesPage: document.getElementById('place-notes-page'),
    conversationMode: document.getElementById('conversation-mode'),
    conversations: document.getElementById('conversation-stream'),
    conversationPage: document.getElementById('conversation-page'),
    activity: document.getElementById('activity-list'),
    happeningsPage: document.getElementById('happenings-page'),
    agreements: document.getElementById('agreement-list'),
    agreementsPage: document.getElementById('agreements-page'),
    archiveForm: document.getElementById('archive-form'),
    archiveQuery: document.getElementById('archive-query'),
    archiveMode: document.getElementById('archive-mode'),
    archiveType: document.getElementById('archive-type'),
    archiveSearch: document.getElementById('archive-search'),
    archiveResults: document.getElementById('archive-results'),
    archivePage: document.getElementById('archive-page'),
    gazetteShare: document.getElementById('gazette-share'),
    gazetteSubmissionStatus: document.getElementById('gazette-submission-status'),
    gazetteIssueList: document.getElementById('gazette-issue-list'),
    gazetteIssuesPage: document.getElementById('gazette-issues-page'),
    gazetteIssue: document.getElementById('gazette-issue'),
    gazetteEntriesPage: document.getElementById('gazette-entries-page'),
    directorySearchField: document.querySelector('.directory-search-field'),
    viewFilters: document.querySelector('.view-filters'),
  }
  const tabs = [...document.querySelectorAll('[role="tab"][data-view]')]
  const panels = [...document.querySelectorAll('[role="tabpanel"]')]
  const viewShareButtons = [...document.querySelectorAll('[data-share-scope="view"]')]
  const detailShareButton = document.querySelector('[data-share-scope="detail"]')
  let bodyIdSequence = 0
  let branchRefreshOffset = 0
  let navigationRevision = 0
  let authoredRevision = 0
  let archiveRequestRevision = 0
  let gazetteListRequestRevision = 0
  let gazetteListRequestPromise = null
  let gazetteDetailRequestRevision = 0
  let detailRequestRevision = 0
  let shareFeedbackRevision = 0
  let state = {
    failures: 0,
    refreshing: false,
    hasSnapshot: false,
    pollTimer: 0,
    changeMarker: null,
    snapshot: null,
    directory: {
      places: [], residents: [], loaded: false, loading: false, error: false, marker: null,
    },
    focusedPlaces: {},
    focusedResidents: {},
    histories: { notes: {}, things: {}, agreements: {}, events: {} },
    branches: {},
    residentPaging: {
      initialized: false, hasMore: false, nextBeforeId: null, loading: false, error: false,
      seenBeforeIds: [],
    },
    collapsedPlaceIds: [],
    sleeperPlaceIds: [],
    expandedBodies: [],
    fullBodies: {},
    detail: null,
    details: {},
    archive: {
      query: '', mode: 'words', type: 'all', results: [], totalItems: 0,
      totalTextBytes: 0, nextBefore: null, hasMore: false, loading: false,
      initialized: false, error: null,
    },
    gazette: {
      firstPrintAt: null,
      submissionsOpen: null,
      issues: [],
      nextBeforeIssueNumber: null,
      hasMoreIssues: false,
      listLoading: false,
      listInitialized: false,
      listError: null,
      listRetryMode: 'initial',
      issue: null,
      entries: [],
      nextAfterOrdinal: null,
      hasMoreEntries: false,
      detailLoading: false,
      detailInitialized: false,
      detailError: null,
    },
    gazetteIssueId: null,
    view: 'map',
    directorySearch: '',
    directorySearchIndex: -1,
    placeId: null,
    resident: null,
    conversationContext: false,
  }

  function element(tagName, className, text) {
    const node = document.createElement(tagName)
    if (className) node.className = className
    if (text !== undefined) node.textContent = String(text)
    return node
  }
${WINDOW_CLIENT_SAFETY_JS}

  function resetShareFeedback() {
    shareFeedbackRevision += 1
    for (const status of [nodes.shareStatus, nodes.detailShareStatus]) {
      if (!status) continue
      status.textContent = ''
      delete status.dataset.tone
    }
    for (const button of [...viewShareButtons, detailShareButton].filter(Boolean)) {
      button.textContent = button.dataset.shareLabel || (button.dataset.shareScope === 'detail'
        ? 'Share this detail'
        : 'Share this view')
    }
  }

  function setShareStatus(message, tone, button) {
    const status = button?.dataset.shareScope === 'detail'
      ? nodes.detailShareStatus
      : nodes.shareStatus
    if (!status) return
    status.textContent = message
    status.dataset.tone = tone
  }

  async function copyCurrentShareLink(button) {
    const requestShareFeedbackRevision = ++shareFeedbackRevision
    const path = windowSharePath(viewShareState())
    if (!path) {
      const values = [state.directorySearch, state.archive.query]
      const credentialPresent = values.some(value => (
        typeof value === 'string' && /1f3d9_(?:sk|at|rt|ac|rc)_[0-9a-f]{8,}/iu.test(value)
      ))
      setShareStatus(credentialPresent
        ? 'That looks like a credential. Never put it in a public URL. If it is a resident key, replace it now; if it is a recovery code, create a fresh recovery set.'
        : 'This view contains a filter that is not safe for a public URL. Clear that filter, then try sharing again.',
      'error', button)
      return
    }
    const absoluteUrl = new URL(path, window.location.origin).href
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(absoluteUrl)
      if (
        shareFeedbackRevision !== requestShareFeedbackRevision ||
        windowSharePath(viewShareState()) !== path
      ) return
      setShareStatus('Link copied: ' + absoluteUrl, 'success', button)
      if (button) button.textContent = button.dataset.shareScope === 'detail'
        ? 'Detail link copied'
        : button === nodes.gazetteShare
          ? state.gazetteIssueId ? 'Issue link copied' : 'Gazette link copied'
          : 'View link copied'
    } catch {
      if (
        shareFeedbackRevision !== requestShareFeedbackRevision ||
        windowSharePath(viewShareState()) !== path
      ) return
      setShareStatus('The link could not copy. Copy this URL: ' + absoluteUrl, 'error', button)
    }
  }

  function safePlacePurpose(value) {
    const purpose = safeText(value, '', 1000, true)
    return /[\\r\\n\\u2028\\u2029]/u.test(purpose) || Array.from(purpose).length > 280
      ? ''
      : purpose
  }

  function normalizeFrontMatterHeading(rawHeading) {
    if (!rawHeading || typeof rawHeading !== 'object' || rawHeading.type !== 'thing') return null
    const id = safeId(rawHeading.id)
    const name = safeText(rawHeading.name, '', 120, false)
    const bodyTextBytes = Number(rawHeading.body_text_bytes)
    const makerId = safeId(rawHeading.maker_id)
    const madeBy = safeHandle(rawHeading.made_by)
    const currentOwnerId = safeId(rawHeading.current_owner_id)
    const currentOwner = safeHandle(rawHeading.current_owner)
    const ownerId = safeId(rawHeading.owner_id)
    const owner = safeHandle(rawHeading.owner)
    if (
      !id || !name || !Number.isSafeInteger(bodyTextBytes) || bodyTextBytes < 0 ||
      !makerId || !madeBy || !currentOwnerId || !currentOwner ||
      ownerId !== currentOwnerId || owner !== currentOwner
    ) return null
    return Object.freeze({
      id,
      type: 'thing',
      name,
      body_text_bytes: bodyTextBytes,
      maker_id: makerId,
      made_by: madeBy,
      current_owner_id: currentOwnerId,
      current_owner: currentOwner,
      owner_id: ownerId,
      owner,
    })
  }

  function normalizeFrontMatter(values) {
    if (!Array.isArray(values)) return []
    const seen = new Set()
    return values.slice(0, 3).flatMap(rawHeading => {
      const heading = normalizeFrontMatterHeading(rawHeading)
      if (!heading || seen.has(heading.id)) return []
      seen.add(heading.id)
      return [heading]
    })
  }

  function setStatus(message, tone) {
    if (!nodes.status) return
    if (nodes.status.textContent !== message) nodes.status.textContent = message
    if (nodes.status.dataset.tone !== tone) nodes.status.dataset.tone = tone
    if (nodes.status.dataset.statusMessage) delete nodes.status.dataset.statusMessage
  }

  function renderGlobalReadRetry(message, tone) {
    if (nodes.status) {
      if (
        nodes.status.dataset.statusMessage === message &&
        nodes.status.dataset.tone === tone &&
        nodes.status.querySelector('.global-read-retry')
      ) return
      const retry = element('button', 'global-read-retry', 'Retry reading the public city view')
      retry.type = 'button'
      retry.dataset.focusKey = 'global-read-retry'
      retry.addEventListener('click', () => void refreshCity())
      nodes.status.dataset.tone = tone
      nodes.status.dataset.statusMessage = message
      nodes.status.replaceChildren(document.createTextNode(message + ' '), retry)
    }
  }

  function renderGlobalReadFailure() {
    const message = 'The current public city view could not be read.'
    renderGlobalReadRetry(message, 'error')
    if (nodes.counts) nodes.counts.textContent = message
    if (nodes.scope) nodes.scope.textContent = message
    for (const target of [nodes.map, nodes.roster, nodes.placePurpose, nodes.placeFrontMatter,
      nodes.occupants, nodes.placeThings, nodes.placeConversation, nodes.conversations,
      nodes.agreements]) {
      renderEmpty(target, 'error-row', message)
    }
    if (nodes.activity) {
      nodes.activity.replaceChildren(element('li', 'error-row', message))
    }
  }

  function renderEmpty(target, className, message) {
    if (!target) return
    target.replaceChildren(element('p', className, message))
  }

  function safeArchiveChoice(value, choices, fallback) {
    return typeof value === 'string' && choices.includes(value) ? value : fallback
  }

  function safeArchiveCursor(value) {
    return safeText(value, null, 2048, false)
  }

  function safeChangeMarker(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) return null
    try {
      return BigInt(value) <= 9223372036854775807n ? value : null
    } catch {
      return null
    }
  }

  function markerCovers(actual, minimum) {
    const safeActual = safeChangeMarker(actual)
    const safeMinimum = safeChangeMarker(minimum)
    return Boolean(safeActual && safeMinimum && BigInt(safeActual) >= BigInt(safeMinimum))
  }

  function requireExactReadMarker(actual, requested) {
    if (!requested) return
    const responseMarker = safeChangeMarker(actual)
    if (responseMarker === requested) return
    throw new Error('public read marker does not match its accepted rows')
  }

  function requireCurrentReadMarker(actual, requested) {
    if (!requested) return
    const responseMarker = safeChangeMarker(actual)
    if (responseMarker === requested && state.changeMarker === requested) return
    if (responseMarker && state.changeMarker &&
        BigInt(responseMarker) > BigInt(state.changeMarker)) void refreshCity()
    throw new Error('public read marker does not match the neighboring snapshot totals')
  }

  function normalizeArchiveResult(rawResult) {
    if (!rawResult || typeof rawResult !== 'object') return null
    const type = safeArchiveChoice(rawResult.type, ['note', 'thing'], null)
    const id = safeId(rawResult.id)
    const createdAt = safeDate(rawResult.created_at)
    if (!type || !id || !createdAt) return null
    const placeId = rawResult.place_id === null || rawResult.place_id === undefined
      ? null
      : safeId(rawResult.place_id)
    if (rawResult.place_id !== null && rawResult.place_id !== undefined && !placeId) return null
    const madeBy = type === 'thing' ? safeHandle(rawResult.made_by) : null
    const currentOwner = type === 'thing'
      ? safeHandle(rawResult.current_owner ?? rawResult.owner)
      : null
    const makerId = type === 'thing' ? safeId(rawResult.maker_id) : null
    const currentOwnerId = type === 'thing' ? safeId(rawResult.current_owner_id) : null
    const hasThingProvenance = type === 'thing' && [
      rawResult.maker_id, rawResult.made_by,
      rawResult.current_owner_id, rawResult.current_owner,
    ].some(value => value !== null && value !== undefined)
    if (hasThingProvenance && (!makerId || !madeBy || !currentOwnerId || !currentOwner)) return null
    const actor = type === 'note' ? safeHandle(rawResult.author) : currentOwner
    const name = type === 'thing'
      ? safeText(rawResult.name, '', 160, false)
      : ''
    return Object.freeze({
      type,
      id,
      createdAt,
      placeId,
      actor,
      makerId,
      madeBy,
      currentOwnerId,
      currentOwner,
      name,
      textBytes: safeCount(rawResult.body_text_bytes ?? rawResult.text_bytes),
      href: '/window/' + type + '/' + String(id),
    })
  }

  function normalizeArchivePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid archive response')
    const rawResults = Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.items) ? payload.items : []
    if (rawResults.length > 25) throw new Error('invalid archive response')
    const results = rawResults.map(normalizeArchiveResult)
    if (results.some(result => !result)) throw new Error('invalid archive response')
    const totalItems = safeCount(payload.total_items ?? payload.totalItems)
    if (payload.returned_items !== results.length || totalItems < results.length) {
      throw new Error('invalid archive response')
    }
    const hasMore = payload.has_more === true || payload.hasMore === true
    const nextBefore = safeArchiveCursor(payload.next_before ?? payload.nextBefore)
    if (hasMore !== Boolean(nextBefore)) throw new Error('invalid archive response')
    return Object.freeze({
      results,
      totalItems,
      totalTextBytes: safeCount(
        payload.total_text_bytes ?? payload.total_body_bytes ??
          payload.totalTextBytes ?? payload.totalBodyBytes,
      ),
      hasMore,
      nextBefore,
    })
  }

  function archiveResultCard(result) {
    const card = element('li', 'archive-card')
    const heading = element('h3', 'archive-result-title', result.type === 'thing' && result.name
      ? result.name
      : 'Public note #' + String(result.id))
    const recordLabel = result.type === 'thing'
      ? 'Thing #' + String(result.id)
      : 'Note #' + String(result.id)
    const details = [
      recordLabel,
      result.type === 'note' && result.actor ? 'by ' + result.actor : '',
      result.type === 'thing' && result.madeBy ? 'made by ' + result.madeBy : '',
      result.type === 'thing' && result.currentOwner
        ? 'currently owned by ' + result.currentOwner
        : '',
      result.placeId ? 'place #' + String(result.placeId) : '',
      dateLabel(result.createdAt),
      String(result.textBytes) + ' public text bytes',
    ].filter(Boolean)
    const meta = element('p', 'archive-result-meta', details.join(' · '))
    const link = openDetailLink(result.type, result.id, 'Open detail', 'archive-open')
    card.append(heading, meta, link)
    return card
  }

  function archiveRetryButton() {
    const retry = element('button', 'archive-retry', 'Retry search')
    retry.type = 'button'
    retry.addEventListener('click', () => void loadArchive(!state.archive.query))
    return retry
  }

  function renderArchivePage(archive) {
    if (!nodes.archivePage) return
    nodes.archivePage.hidden = true
    nodes.archivePage.replaceChildren()
    if (archive.loading && archive.results.length) {
      nodes.archivePage.hidden = false
      nodes.archivePage.replaceChildren(element('p', 'loading-row', 'Searching the archive for older matches…'))
      return
    }
    if (archive.error && archive.results.length) {
      nodes.archivePage.hidden = false
      nodes.archivePage.replaceChildren(
        element('p', 'error-row', archive.error),
        archiveRetryButton(),
      )
      return
    }
    if (!archive.hasMore || !archive.nextBefore) return
    const load = element('button', 'archive-load', 'Load older matches')
    load.type = 'button'
    load.addEventListener('click', () => void loadArchive(false))
    nodes.archivePage.hidden = false
    nodes.archivePage.replaceChildren(load)
  }

  function renderArchive() {
    if (!nodes.archiveResults) return
    const archive = state.archive
    if (nodes.archiveSearch) {
      nodes.archiveSearch.disabled = archive.loading
      nodes.archiveSearch.setAttribute('aria-busy', String(archive.loading))
    }
    nodes.archiveResults.setAttribute('aria-busy', String(archive.loading))
    if (archive.loading && !archive.results.length) {
      renderEmpty(nodes.archiveResults, 'loading-row', 'Searching the archive…')
      renderArchivePage(archive)
      return
    }
    if (archive.error && !archive.results.length) {
      const message = element('p', 'error-row', archive.error)
      nodes.archiveResults.replaceChildren(message, archiveRetryButton())
      renderArchivePage(archive)
      return
    }
    if (!archive.initialized) {
      renderEmpty(nodes.archiveResults, 'empty-row', 'Enter public words or an exact phrase to search.')
      renderArchivePage(archive)
      return
    }
    if (!archive.results.length) {
      renderEmpty(nodes.archiveResults, 'empty-row', 'No public notes or things matched this search.')
      renderArchivePage(archive)
      return
    }
    const summary = element(
      'p',
      'archive-summary',
      String(archive.totalItems) + (archive.totalItems === 1 ? ' exact match · ' : ' exact matches · ') +
        String(archive.totalTextBytes) + ' public text bytes total · bodies stay on their original records',
    )
    const list = element('ol', 'archive-list')
    list.append(...archive.results.map(archiveResultCard))
    nodes.archiveResults.replaceChildren(summary, list)
    renderArchivePage(archive)
  }

  async function loadArchive(reset, fromLocation = false) {
    if (state.archive.loading) return
    const requestAuthoredRevision = authoredRevision
    const mode = reset
      ? safeArchiveChoice(nodes.archiveMode?.value, ['words', 'phrase'], 'words')
      : state.archive.mode
    const type = reset
      ? safeArchiveChoice(nodes.archiveType?.value, ['all', 'note', 'thing'], 'all')
      : state.archive.type
    const candidateQuery = reset ? nodes.archiveQuery?.value : state.archive.query
    const validatedQuery = validateWindowArchiveQuery(candidateQuery, mode)
    if (!validatedQuery.ok) {
      const error = validatedQuery.reason === 'credential'
        ? 'That looks like a credential. Never put it in a public URL. If it is a resident key, replace it now; if it is a recovery code, create a fresh recovery set.'
        : validatedQuery.reason === 'word_count'
          ? 'Words mode needs 1 to 16 word lexemes.'
          : 'Search must be one safe line of 1 to 256 UTF-8 bytes.'
      state = {
        ...state,
        archive: { ...state.archive, initialized: true, loading: false, error },
      }
      renderArchive()
      nodes.archiveQuery?.focus()
      return
    }
    const formQuery = validatedQuery.value
    if (!formQuery) {
      state = {
        ...state,
        archive: { ...state.archive, initialized: true, loading: false,
          error: 'Enter words or an exact phrase before searching.' },
      }
      renderArchive()
      nodes.archiveQuery?.focus()
      return
    }
    if (reset && nodes.archiveQuery) nodes.archiveQuery.value = formQuery
    const requestArchiveRevision = ++archiveRequestRevision
    const previous = state.archive
    state = {
      ...state,
      archive: {
        ...previous,
        query: formQuery,
        mode,
        type,
        results: reset ? [] : previous.results,
        loading: true,
        initialized: true,
        error: null,
      },
    }
    if (reset) writeLocation(!fromLocation)
    renderArchive()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/search', window.location.origin)
      url.searchParams.set('q', formQuery)
      url.searchParams.set('mode', mode)
      url.searchParams.set('type', type)
      url.searchParams.set('limit', '25')
      if (!reset && previous.nextBefore) url.searchParams.set('before', previous.nextBefore)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) {
        const error = new Error('archive unavailable')
        error.isBusy = response.status === 503
        throw error
      }
      const page = normalizeArchivePayload(await response.json())
      if (
        authoredRevision !== requestAuthoredRevision ||
        archiveRequestRevision !== requestArchiveRevision
      ) return
      const combined = new Map()
      for (const result of reset ? [] : previous.results) {
        combined.set(result.type + ':' + String(result.id), result)
      }
      for (const result of page.results) {
        combined.set(result.type + ':' + String(result.id), result)
      }
      state = {
        ...state,
        archive: {
          ...state.archive,
          results: [...combined.values()],
          totalItems: page.totalItems,
          totalTextBytes: page.totalTextBytes,
          nextBefore: page.nextBefore,
          hasMore: page.hasMore && Boolean(page.nextBefore),
          loading: false,
          error: null,
        },
      }
    } catch (error) {
      if (
        authoredRevision !== requestAuthoredRevision ||
        archiveRequestRevision !== requestArchiveRevision
      ) return
      state = {
        ...state,
        archive: {
          ...state.archive,
          loading: false,
          error: error && error.isBusy
            ? 'Search could not be loaded within the public reading limit.'
            : 'Search could not be loaded. Check the connection and try again.',
        },
      }
    } finally {
      window.clearTimeout(timeout)
      renderArchive()
    }
  }

  function safeGazetteCount(value) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  }

  function safeGazetteStoredText(value, maximum, allowEmpty = false) {
    if (
      typeof value !== 'string' || containsMalformedPublicText(value) || hasUnsafeText(value) ||
      /1f3d9_(?:sk|at|rt|ac|rc)_[0-9a-f]{8,}/iu.test(value)
    ) return null
    const characters = Array.from(value)
    if (characters.length > maximum || (!allowEmpty && !value.trim())) return null
    return value
  }

  function normalizeGazetteIssueSummary(rawIssue) {
    if (!rawIssue || typeof rawIssue !== 'object') return null
    const issueNumber = safeId(rawIssue.issue_number)
    const scheduledFor = safeDate(rawIssue.scheduled_for)
    const printedAt = safeDate(rawIssue.printed_at)
    const entryCount = safeGazetteCount(rawIssue.entry_count)
    if (!issueNumber || !scheduledFor || !printedAt || entryCount === null) return null
    if (printedAt.getTime() < scheduledFor.getTime()) return null
    return Object.freeze({ issueNumber, scheduledFor, printedAt, entryCount })
  }

  function normalizeGazetteListPayload(payload, requestedBeforeIssueNumber) {
    if (!payload || typeof payload !== 'object' ||
        !payload.submission_room || Array.isArray(payload.submission_room) ||
        payload.submission_room.place_id !== 454 ||
        typeof payload.submission_room.submissions_open !== 'boolean' ||
        payload.first_print_at !== GAZETTE_FIRST_PRINT_AT || !Array.isArray(payload.issues) ||
        payload.issues.length > GAZETTE_ISSUE_PAGE_LIMIT) {
      throw new Error('invalid Gazette issue page')
    }
    const firstPrintAt = safeDate(payload.first_print_at)
    const issues = payload.issues.map(normalizeGazetteIssueSummary)
    if (!firstPrintAt || issues.some(issue => !issue)) {
      throw new Error('invalid Gazette issue page')
    }
    for (let index = 1; index < issues.length; index += 1) {
      if (issues[index - 1].issueNumber <= issues[index].issueNumber) {
        throw new Error('invalid Gazette issue order')
      }
    }
    if (
      requestedBeforeIssueNumber &&
      issues.some(issue => issue.issueNumber >= requestedBeforeIssueNumber)
    ) throw new Error('invalid Gazette issue cursor page')
    const hasMore = payload.has_more === true
    const nextBeforeIssueNumber = payload.next_before_issue_number === null ||
      payload.next_before_issue_number === undefined
      ? null
      : safeId(payload.next_before_issue_number)
    if (hasMore !== Boolean(nextBeforeIssueNumber)) {
      throw new Error('invalid Gazette issue continuation')
    }
    if (hasMore && (
      !issues.length || nextBeforeIssueNumber !== issues.at(-1).issueNumber ||
      (requestedBeforeIssueNumber && nextBeforeIssueNumber >= requestedBeforeIssueNumber)
    )) throw new Error('stalled Gazette issue continuation')
    return Object.freeze({
      firstPrintAt,
      submissionsOpen: payload.submission_room.submissions_open,
      issues,
      hasMore,
      nextBeforeIssueNumber,
    })
  }

  function normalizeGazetteEntry(rawEntry, scheduledFor) {
    if (!rawEntry || typeof rawEntry !== 'object') return null
    const ordinal = safeId(rawEntry.ordinal)
    const noteId = safeId(rawEntry.note_id)
    const author = safeHandle(rawEntry.author)
    const body = safeGazetteStoredText(rawEntry.body, 65536)
    const createdAt = safeDate(rawEntry.created_at)
    if (!ordinal || !noteId || !author || body === null || !createdAt ||
        createdAt.getTime() >= scheduledFor.getTime()) return null
    return Object.freeze({ ordinal, noteId, author, body, createdAt })
  }

  function sameGazetteIssue(left, right) {
    return Boolean(left && right &&
      left.issueNumber === right.issueNumber &&
      left.scheduledFor.getTime() === right.scheduledFor.getTime() &&
      left.printedAt.getTime() === right.printedAt.getTime() &&
      left.entryCount === right.entryCount && left.header === right.header)
  }

  function normalizeGazetteDetailPayload(
    payload,
    expectedIssueNumber,
    requestedAfterOrdinal,
    acceptedIssue,
  ) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid Gazette issue')
    const summary = normalizeGazetteIssueSummary(payload.issue)
    const header = safeGazetteStoredText(payload.issue?.header, 4000)
    if (!summary || summary.issueNumber !== expectedIssueNumber || header === null ||
        !Array.isArray(payload.entries) || payload.entries.length > GAZETTE_ENTRY_PAGE_LIMIT) {
      throw new Error('invalid Gazette issue')
    }
    const entries = payload.entries.map(entry => normalizeGazetteEntry(entry, summary.scheduledFor))
    if (entries.some(entry => !entry)) throw new Error('invalid Gazette entries')
    let expectedOrdinal = (requestedAfterOrdinal || 0) + 1
    for (const entry of entries) {
      if (entry.ordinal !== expectedOrdinal) {
        throw new Error('invalid Gazette entry order')
      }
      expectedOrdinal += 1
    }
    const issue = Object.freeze({ ...summary, header })
    if (acceptedIssue && !sameGazetteIssue(issue, acceptedIssue)) {
      throw new Error('Gazette issue metadata changed between pages')
    }
    const hasMore = payload.has_more === true
    const nextAfterOrdinal = payload.next_after_ordinal === null ||
      payload.next_after_ordinal === undefined
      ? null
      : safeId(payload.next_after_ordinal)
    const lastOrdinal = entries.at(-1)?.ordinal ?? (requestedAfterOrdinal || 0)
    if (
      hasMore !== Boolean(nextAfterOrdinal) || summary.entryCount < entries.length ||
      (hasMore && (
        !entries.length || nextAfterOrdinal !== lastOrdinal ||
        nextAfterOrdinal >= summary.entryCount
      )) ||
      (!hasMore && lastOrdinal !== summary.entryCount)
    ) {
      throw new Error('invalid Gazette entry continuation')
    }
    return Object.freeze({
      issue,
      entries,
      hasMore,
      nextAfterOrdinal,
    })
  }

  function gazetteDateLabel(date, includeWeekday = false) {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ]
    const weekday = includeWeekday ? weekdays[date.getUTCDay()] + ', ' : ''
    return weekday + String(date.getUTCDate()) + ' ' + months[date.getUTCMonth()] + ' ' +
      String(date.getUTCFullYear()) + ' at ' + String(date.getUTCHours()).padStart(2, '0') +
      ':' + String(date.getUTCMinutes()).padStart(2, '0') + ' UTC'
  }

  function selectGazetteIssue(issueNumber, push) {
    if (!issueNumber || state.gazetteIssueId === issueNumber) return
    gazetteDetailRequestRevision += 1
    resetShareFeedback()
    state = {
      ...state,
      gazetteIssueId: issueNumber,
      gazette: {
        ...state.gazette,
        issue: null,
        entries: [],
        nextAfterOrdinal: null,
        hasMoreEntries: false,
        detailLoading: false,
        detailInitialized: false,
        detailError: null,
      },
    }
    writeLocation(push)
    renderGazettePreservingFocus()
    void loadGazetteIssue(issueNumber, true)
  }

  function gazetteIssueLink(issue) {
    const item = element('li', 'gazette-issue-summary')
    const link = element('a', 'gazette-issue-link', 'Issue ' + String(issue.issueNumber))
    link.href = '/window/gazette?issue=' + String(issue.issueNumber)
    link.dataset.focusKey = 'gazette-issue-' + String(issue.issueNumber)
    if (issue.issueNumber === state.gazetteIssueId) link.setAttribute('aria-current', 'page')
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      selectGazetteIssue(issue.issueNumber, true)
    })
    const count = String(issue.entryCount) + (issue.entryCount === 1 ? ' submission' : ' submissions')
    const meta = element(
      'p',
      'gazette-issue-summary-meta',
      gazetteDateLabel(issue.scheduledFor, true) + ' · ' + count,
    )
    item.append(link, meta)
    return item
  }

  function gazetteListRetryButton() {
    const retry = element('button', 'gazette-retry', 'Retry loading Gazette issues')
    retry.type = 'button'
    retry.dataset.focusKey = 'gazette-retry-issues'
    retry.dataset.focusFallbackId = 'gazette-issue-list'
    retry.addEventListener('click', () => void loadGazetteIssues(state.gazette.listRetryMode))
    return retry
  }

  function gazetteDetailRetryButton() {
    const retry = element('button', 'gazette-retry', 'Retry loading this Gazette issue')
    retry.type = 'button'
    retry.dataset.focusKey = 'gazette-retry-detail'
    retry.dataset.focusFallbackId = 'gazette-issue'
    retry.addEventListener('click', () => {
      if (state.gazetteIssueId) void loadGazetteIssue(state.gazetteIssueId, state.gazette.entries.length === 0)
    })
    return retry
  }

  function renderGazetteIssuesPage(gazette) {
    if (!nodes.gazetteIssuesPage) return
    nodes.gazetteIssuesPage.hidden = true
    nodes.gazetteIssuesPage.replaceChildren()
    if (gazette.listLoading && gazette.issues.length) {
      nodes.gazetteIssuesPage.hidden = false
      nodes.gazetteIssuesPage.replaceChildren(
        element('p', 'loading-row', 'Checking the Gazette archive…'),
      )
      return
    }
    if (gazette.listError && gazette.issues.length) {
      nodes.gazetteIssuesPage.hidden = false
      nodes.gazetteIssuesPage.replaceChildren(
        element('p', 'error-row', gazette.listError),
        gazetteListRetryButton(),
      )
      return
    }
    if (!gazette.hasMoreIssues || !gazette.nextBeforeIssueNumber) return
    const load = element('button', 'gazette-load', 'Load older issues')
    load.type = 'button'
    load.dataset.focusKey = 'gazette-load-issues'
    load.dataset.focusFallbackId = 'gazette-issue-list'
    load.addEventListener('click', () => void loadGazetteIssues('older'))
    nodes.gazetteIssuesPage.hidden = false
    nodes.gazetteIssuesPage.replaceChildren(load)
  }

  function gazetteEntryCard(entry) {
    const item = element('li', 'gazette-entry')
    const body = element('p', 'gazette-entry-body')
    body.textContent = entry.body
    const attribution = element('p', 'gazette-entry-attribution')
    const source = element('a', 'gazette-source-note', 'Note #' + String(entry.noteId))
    source.href = '/window/note/' + String(entry.noteId)
    attribution.append(
      document.createTextNode('by ' + entry.author + ' · '),
      source,
      document.createTextNode(' · ' + gazetteDateLabel(entry.createdAt)),
    )
    item.append(body, attribution)
    return item
  }

  function renderGazetteEntriesPage(gazette) {
    if (!nodes.gazetteEntriesPage) return
    nodes.gazetteEntriesPage.hidden = true
    nodes.gazetteEntriesPage.replaceChildren()
    if (gazette.detailLoading && gazette.entries.length) {
      nodes.gazetteEntriesPage.hidden = false
      nodes.gazetteEntriesPage.replaceChildren(
        element('p', 'loading-row', 'Reading more entries in this issue…'),
      )
      return
    }
    if (gazette.detailError && gazette.entries.length) {
      nodes.gazetteEntriesPage.hidden = false
      nodes.gazetteEntriesPage.replaceChildren(
        element('p', 'error-row', gazette.detailError),
        gazetteDetailRetryButton(),
      )
      return
    }
    if (!gazette.hasMoreEntries || !gazette.nextAfterOrdinal) return
    const load = element('button', 'gazette-load', 'Load more entries')
    load.type = 'button'
    load.dataset.focusKey = 'gazette-load-entries'
    load.dataset.focusFallbackId = 'gazette-issue'
    load.addEventListener('click', () => {
      if (state.gazetteIssueId) void loadGazetteIssue(state.gazetteIssueId, false)
    })
    nodes.gazetteEntriesPage.hidden = false
    nodes.gazetteEntriesPage.replaceChildren(load)
  }

  function renderGazetteIssue(gazette) {
    if (!nodes.gazetteIssue) return
    nodes.gazetteIssue.setAttribute('aria-busy', String(gazette.detailLoading))
    if (!state.gazetteIssueId) {
      renderEmpty(
        nodes.gazetteIssue,
        'empty-row',
        gazette.issues.length
          ? 'Choose a permanent Gazette issue.'
          : 'The first permanent issue will appear here after its scheduled print.',
      )
      renderGazetteEntriesPage(gazette)
      return
    }
    if (gazette.detailLoading && !gazette.issue) {
      renderEmpty(nodes.gazetteIssue, 'loading-row', 'Reading Gazette issue ' + String(state.gazetteIssueId) + '…')
      renderGazetteEntriesPage(gazette)
      return
    }
    if (gazette.detailError && !gazette.issue) {
      nodes.gazetteIssue.replaceChildren(
        element('p', 'error-row', gazette.detailError),
        gazetteDetailRetryButton(),
      )
      renderGazetteEntriesPage(gazette)
      return
    }
    if (!gazette.issue) {
      renderEmpty(nodes.gazetteIssue, 'loading-row', 'Opening this permanent issue…')
      renderGazetteEntriesPage(gazette)
      return
    }
    const heading = element('h3', 'gazette-issue-title', 'Issue ' + String(gazette.issue.issueNumber))
    const printTime = element(
      'p',
      'gazette-print-time',
      'Weekly print for ' + gazetteDateLabel(gazette.issue.scheduledFor, true),
    )
    const provenance = element('p', 'gazette-provenance', gazette.issue.header)
    const entries = element('ol', 'gazette-entries')
    if (gazette.entries.length) {
      entries.append(...gazette.entries.map(gazetteEntryCard))
      nodes.gazetteIssue.replaceChildren(heading, printTime, provenance, entries)
    } else {
      nodes.gazetteIssue.replaceChildren(
        heading,
        printTime,
        provenance,
        element('p', 'empty-row', 'This permanent issue printed with no submissions.'),
      )
    }
    renderGazetteEntriesPage(gazette)
  }

  function renderGazette() {
    if (!nodes.gazetteIssueList) return
    const gazette = state.gazette
    if (nodes.gazetteSubmissionStatus) {
      if (gazette.submissionsOpen === true) {
        nodes.gazetteSubmissionStatus.dataset.state = 'open'
        nodes.gazetteSubmissionStatus.textContent = 'Room #454 is open for Gazette submissions.'
      } else if (gazette.submissionsOpen === false) {
        nodes.gazetteSubmissionStatus.dataset.state = 'closed'
        nodes.gazetteSubmissionStatus.textContent = 'Room #454 is closed for Gazette submissions. Wait until this notice says open before submitting.'
      } else {
        nodes.gazetteSubmissionStatus.dataset.state = gazette.listError ? 'unavailable' : 'checking'
        nodes.gazetteSubmissionStatus.textContent = gazette.listError
          ? 'Gazette submission status is unavailable. Check again before submitting.'
          : 'Checking whether Room #454 is open for submissions…'
      }
    }
    if (nodes.gazetteShare) {
      const label = state.gazetteIssueId
        ? 'Share issue ' + String(state.gazetteIssueId)
        : 'Share this Gazette'
      nodes.gazetteShare.dataset.shareLabel = label
      nodes.gazetteShare.textContent = label
    }
    nodes.gazetteIssueList.setAttribute('aria-busy', String(gazette.listLoading))
    if (gazette.listLoading && !gazette.issues.length) {
      renderEmpty(nodes.gazetteIssueList, 'loading-row', 'Opening the Gazette archive…')
    } else if (gazette.listError && !gazette.issues.length) {
      nodes.gazetteIssueList.replaceChildren(
        element('p', 'error-row', gazette.listError),
        gazetteListRetryButton(),
      )
    } else if (gazette.listInitialized && !gazette.issues.length) {
      renderEmpty(nodes.gazetteIssueList, 'empty-row', GAZETTE_FIRST_PRINT_EMPTY_STATE)
    } else if (gazette.issues.length) {
      const list = element('ol', 'gazette-issue-list-items')
      list.append(...gazette.issues.map(gazetteIssueLink))
      nodes.gazetteIssueList.replaceChildren(list)
    }
    renderGazetteIssuesPage(gazette)
    renderGazetteIssue(gazette)
  }

  function renderGazettePreservingFocus() {
    const active = document.activeElement
    const focusKey = active?.dataset?.focusKey || null
    const focusFallbackKey = active?.dataset?.focusFallbackKey || null
    const focusFallbackId = active?.dataset?.focusFallbackId || null
    renderGazette()
    restoreFocus(focusKey, focusFallbackKey, focusFallbackId)
  }

  async function loadGazetteIssues(mode) {
    if (gazetteListRequestPromise) return gazetteListRequestPromise
    const previous = state.gazette
    const initial = mode === 'initial'
    const older = mode === 'older'
    const requestRevision = ++gazetteListRequestRevision
    state = {
      ...state,
      gazette: {
        ...previous,
        submissionsOpen: older ? previous.submissionsOpen : null,
        issues: initial ? [] : previous.issues,
        nextBeforeIssueNumber: initial ? null : previous.nextBeforeIssueNumber,
        hasMoreIssues: initial ? false : previous.hasMoreIssues,
        listLoading: true,
        listInitialized: true,
        listError: null,
        listRetryMode: mode,
      },
    }
    renderGazettePreservingFocus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const request = (async () => {
      try {
        const url = new URL('/api/gazette', window.location.origin)
        url.searchParams.set('limit', String(GAZETTE_ISSUE_PAGE_LIMIT))
        if (older && previous.nextBeforeIssueNumber) {
          url.searchParams.set('before_issue_number', String(previous.nextBeforeIssueNumber))
        }
        const response = await fetch(url.pathname + url.search, {
          cache: 'no-store',
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          mode: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Gazette archive unavailable')
        const requestedBeforeIssueNumber = older ? previous.nextBeforeIssueNumber : null
        const page = normalizeGazetteListPayload(
          await response.json(),
          requestedBeforeIssueNumber,
        )
        if (gazetteListRequestRevision !== requestRevision) return false
        const combined = new Map()
        for (const issue of initial ? [] : previous.issues) {
          combined.set(issue.issueNumber, issue)
        }
        for (const issue of page.issues) combined.set(issue.issueNumber, issue)
        const issues = [...combined.values()]
          .sort((left, right) => right.issueNumber - left.issueNumber)
        const shouldSelectLatest = state.view === 'gazette' && !state.gazetteIssueId && issues.length
        const selectedIssueNumber = shouldSelectLatest ? issues[0].issueNumber : state.gazetteIssueId
        const preserveLoadedPagination = mode === 'refresh' && previous.issues.length > 0
        const nextBeforeIssueNumber = preserveLoadedPagination
          ? previous.nextBeforeIssueNumber
          : page.nextBeforeIssueNumber
        const hasMoreIssues = preserveLoadedPagination
          ? previous.hasMoreIssues
          : page.hasMore && Boolean(page.nextBeforeIssueNumber)
        if (shouldSelectLatest) resetShareFeedback()
        state = {
          ...state,
          gazetteIssueId: selectedIssueNumber,
          gazette: {
            ...state.gazette,
            firstPrintAt: page.firstPrintAt,
            submissionsOpen: page.submissionsOpen,
            issues,
            nextBeforeIssueNumber,
            hasMoreIssues,
            listLoading: false,
            listError: null,
          },
        }
        if (shouldSelectLatest) writeLocation(false)
        if (shouldSelectLatest) void loadGazetteIssue(selectedIssueNumber, true)
        return true
      } catch {
        if (gazetteListRequestRevision !== requestRevision) return false
        state = {
          ...state,
          gazette: {
            ...state.gazette,
            listLoading: false,
            listError: 'Gazette issues could not be loaded. Check the connection and try again.',
          },
        }
        return false
      } finally {
        window.clearTimeout(timeout)
        renderGazettePreservingFocus()
      }
    })()
    gazetteListRequestPromise = request
    try {
      return await request
    } finally {
      if (gazetteListRequestPromise === request) gazetteListRequestPromise = null
    }
  }

  async function loadGazetteIssue(issueNumber, reset) {
    const previous = state.gazette
    if (previous.detailLoading || !safeId(issueNumber)) return
    const sameIssue = previous.issue?.issueNumber === issueNumber
    const requestRevision = ++gazetteDetailRequestRevision
    state = {
      ...state,
      gazette: {
        ...previous,
        issue: reset || !sameIssue ? null : previous.issue,
        entries: reset || !sameIssue ? [] : previous.entries,
        nextAfterOrdinal: reset || !sameIssue ? null : previous.nextAfterOrdinal,
        hasMoreEntries: reset || !sameIssue ? false : previous.hasMoreEntries,
        detailLoading: true,
        detailInitialized: true,
        detailError: null,
      },
    }
    renderGazettePreservingFocus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/gazette/' + String(issueNumber), window.location.origin)
      url.searchParams.set('limit', String(GAZETTE_ENTRY_PAGE_LIMIT))
      if (!reset && previous.nextAfterOrdinal) {
        url.searchParams.set('after_ordinal', String(previous.nextAfterOrdinal))
      }
      const response = await fetch(url.pathname + url.search, {
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('Gazette issue unavailable')
      const requestedAfterOrdinal = reset || !sameIssue ? null : previous.nextAfterOrdinal
      const acceptedIssue = reset || !sameIssue ? null : previous.issue
      const page = normalizeGazetteDetailPayload(
        await response.json(),
        issueNumber,
        requestedAfterOrdinal,
        acceptedIssue,
      )
      if (gazetteDetailRequestRevision !== requestRevision || state.gazetteIssueId !== issueNumber) return
      const combined = new Map()
      for (const entry of reset || !sameIssue ? [] : previous.entries) {
        combined.set(entry.ordinal, entry)
      }
      for (const entry of page.entries) combined.set(entry.ordinal, entry)
      state = {
        ...state,
        gazette: {
          ...state.gazette,
          issue: page.issue,
          entries: [...combined.values()].sort((left, right) => left.ordinal - right.ordinal),
          nextAfterOrdinal: page.nextAfterOrdinal,
          hasMoreEntries: page.hasMore && Boolean(page.nextAfterOrdinal),
          detailLoading: false,
          detailError: null,
        },
      }
    } catch {
      if (gazetteDetailRequestRevision !== requestRevision || state.gazetteIssueId !== issueNumber) return
      state = {
        ...state,
        gazette: {
          ...state.gazette,
          detailLoading: false,
          detailError: 'This Gazette issue could not be loaded. Check the connection and try again.',
        },
      }
    } finally {
      window.clearTimeout(timeout)
      renderGazettePreservingFocus()
    }
  }

  function loadSharedGazette() {
    if (state.view !== 'gazette') return
    if (!state.gazette.listInitialized && !state.gazette.listLoading) {
      void loadGazetteIssues('initial')
    }
    if (
      state.gazetteIssueId && !state.gazette.detailLoading &&
      (!state.gazette.detailInitialized || state.gazette.issue?.issueNumber !== state.gazetteIssueId)
    ) {
      void loadGazetteIssue(state.gazetteIssueId, true)
    }
  }

  function dateLabel(date) {
    return date.toLocaleString([], {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  }

  function timeNode(date, className) {
    const time = element('time', className, dateLabel(date))
    time.dateTime = date.toISOString()
    return time
  }

  function normalizePlaces(values, depth, seen) {
    if (!Array.isArray(values) || depth >= 32) return []
    return values.flatMap(rawPlace => {
      if (!rawPlace || typeof rawPlace !== 'object') return []
      const id = safeId(rawPlace.id)
      const parentId = rawPlace.parent_id === null ? null : safeId(rawPlace.parent_id)
      const owner = rawPlace.owner === null ? null : safeHandle(rawPlace.owner)
      const name = safeText(rawPlace.name, '', 120, false)
      const isOwnerlessWorld = rawPlace.owner === null && parentId === null && name === WORLD_ROOT_NAME
      if (
        !id || !name || seen.has(id) ||
        (!owner && !isOwnerlessWorld) ||
        (rawPlace.parent_id !== null && !parentId)
      ) return []
      const nextSeen = new Set([...seen, id])
      const moderated = rawPlace.moderated === true
      return [{
        id,
        parent_id: parentId,
        name,
        purpose: moderated ? '' : safePlacePurpose(rawPlace.purpose),
        front_matter: moderated ? [] : normalizeFrontMatter(rawPlace.front_matter),
        owner,
        places: safeCount(rawPlace.places),
        things: safeCount(rawPlace.things),
        notes: safeCount(rawPlace.notes),
        moderated,
        children: normalizePlaces(rawPlace.children, depth + 1, nextSeen),
      }]
    })
  }

  function normalizeResidents(values) {
    if (!Array.isArray(values)) return []
    return values.flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const handle = safeHandle(raw.handle)
      const joinedAt = safeDate(raw.joined_at)
      const currentPlaceId = raw.current_place_id == null ? null : safeId(raw.current_place_id)
      return id && handle && joinedAt && (raw.current_place_id == null || currentPlaceId)
        ? [{ id, handle, current_place_id: currentPlaceId, joined_at: joinedAt, asleep: raw.asleep === true }]
        : []
    })
  }

  function normalizeDirectory(payload) {
    if (!payload || typeof payload !== 'object' || payload.view !== 'directory') {
      throw new Error('invalid public directory')
    }
    const rawPlaces = Array.isArray(payload.places) ? payload.places : []
    const places = deriveWindowDirectoryPlaces(rawPlaces.flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const parentId = raw.parent_id === null ? null : safeId(raw.parent_id)
      const name = safeText(raw.name, '', 120, false)
      return id && name && (raw.parent_id === null || parentId)
        ? [{ id, parent_id: parentId, name }]
        : []
    }))
    const residentsByHandle = new Map()
    if (Array.isArray(payload.residents)) {
      for (const raw of payload.residents) {
        if (!raw || typeof raw !== 'object') continue
        const id = safeId(raw.id)
        const handle = safeHandle(raw.handle)
        if (id && handle && !residentsByHandle.has(handle)) {
          residentsByHandle.set(handle, Object.freeze({ id, handle }))
        }
      }
    }
    return Object.freeze({
      places: Object.freeze(places.map(place => Object.freeze(place))),
      residents: Object.freeze([...residentsByHandle.values()]),
    })
  }

  function normalizeNotes(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 200).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const placeId = safeId(raw.place_id)
      const author = safeHandle(raw.author)
      const body = safeText(raw.body, '', 2000, false)
      const createdAt = safeDate(raw.created_at)
      return id && placeId && author && body && createdAt
        ? [{ id, place_id: placeId, author, body, created_at: createdAt,
          moderated: raw.moderated === true, truncated: raw.truncated === true }]
        : []
    })
  }

  function normalizeThings(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 200).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const placeId = safeId(raw.place_id)
      const name = safeText(raw.name, '', 120, false)
      const body = safeText(raw.body, null, 1000, true)
      const makerId = raw.maker_id == null ? null : safeId(raw.maker_id)
      const madeBy = raw.made_by == null ? null : safeHandle(raw.made_by)
      const currentOwnerId = raw.current_owner_id == null ? null : safeId(raw.current_owner_id)
      const currentOwner = safeHandle(raw.current_owner ?? raw.owner)
      const owner = safeHandle(raw.owner ?? raw.current_owner)
      const hasProvenance = [raw.maker_id, raw.made_by, raw.current_owner_id, raw.current_owner]
        .some(value => value !== null && value !== undefined)
      const kind = raw.kind == null ? null : safeWorldName(raw.kind)
      const createdAt = safeDate(raw.created_at)
      if (
        !id || !placeId || !name || body === null || !currentOwner || !owner ||
        owner !== currentOwner || !createdAt || (raw.kind != null && !kind) ||
        (hasProvenance && (!makerId || !madeBy || !currentOwnerId))
      ) return []
      const traits = Array.isArray(raw.traits)
        ? [...new Set(raw.traits.map(safeWorldName).filter(Boolean))].slice(0, 32)
        : []
      return [{ id, place_id: placeId, name, body,
        maker_id: makerId, made_by: madeBy,
        current_owner_id: currentOwnerId, current_owner: currentOwner,
        owner, open_to_use: raw.open_to_use === true, kind, traits,
        created_at: createdAt, moderated: raw.moderated === true,
        kind_moderated: raw.kind_moderated === true, truncated: raw.truncated === true }]
    })
  }

  function normalizeAgreements(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 200).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const body = safeText(raw.body, '', 4000, false)
      const createdBy = safeHandle(raw.created_by)
      const parties = safeHandles(raw.parties)
      const acceded = safeHandles(raw.acceded).filter(handle => parties.includes(handle))
      const signatures = safeHandles(raw.signatures).filter(handle => parties.includes(handle))
      const partyCount = Math.max(safeCount(raw.party_count), parties.length)
      const createdAt = safeDate(raw.created_at)
      return id && body && createdBy && parties.length && createdAt
        ? [{ id, body, created_by: createdBy, parties, acceded, signatures,
          open: typeof raw.open === 'boolean' ? raw.open : signatures.length < parties.length,
          accession_open: raw.accession_open === true,
          party_count: partyCount,
          parties_truncated: raw.parties_truncated === true && partyCount > parties.length,
          created_at: createdAt, moderated: raw.moderated === true,
          truncated: raw.truncated === true }]
        : []
    })
  }

  function normalizeEvents(values, maximum = 100) {
    if (!Array.isArray(values)) return []
    return values.slice(0, maximum).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const actor = safeHandle(raw.actor) || (
        SAFE_SYSTEM_EVENT_ACTORS.has(raw.actor) ? raw.actor : null
      )
      const verb = SAFE_EVENT_KINDS.get(raw.kind)
      const at = safeDate(raw.at)
      if (!id || !actor || !verb || !at) return []
      const source = raw.detail && typeof raw.detail === 'object' ? raw.detail : {}
      const detail = Object.fromEntries(SAFE_EVENT_DETAIL_IDS.flatMap(key => {
        const value = safeId(source[key])
        return value ? [[key, value]] : []
      }))
      if (raw.kind === 'gazette_printed') {
        const issueNumber = safeId(source.issue_number)
        const entryCount = safeGazetteCount(source.entry_count)
        if (!issueNumber || entryCount === null || detail.place_id !== 454) return []
        detail.issue_number = issueNumber
        detail.entry_count = entryCount
      }
      let carriesFailureCause = false
      if (raw.kind === 'action' && SAFE_ACTIONS.has(source.action)) {
        detail.action = source.action
        if (SAFE_ACTION_STATUSES.has(source.status)) {
          detail.status = source.status
          carriesFailureCause = source.status === 'blocked' || source.status === 'failed'
        }
      } else if (raw.kind === 'effect_resolved' && SAFE_EFFECT_STATUSES.has(source.status)) {
        detail.status = source.status
        carriesFailureCause = source.status === 'skipped' || source.status === 'failed'
      }
      if (carriesFailureCause && Object.hasOwn(source, 'error')) {
        const error = safeText(source.error, null, EVENT_ERROR_LIMIT + 1, false)
        if (error) {
          const truncated = source.error_truncated === true || error.length > EVENT_ERROR_LIMIT
          detail.error = error.length > EVENT_ERROR_LIMIT
            ? error.slice(0, EVENT_ERROR_LIMIT - 1) + '…'
            : error
          if (truncated) detail.error_truncated = true
        } else {
          detail.error = UNSAFE_EVENT_ERROR
        }
      }
      return [{ id, actor, kind: raw.kind, verb, at, detail }]
    })
  }

  function flattenPlaces(values, ancestors) {
    return values.flatMap(place => {
      const path = [...ancestors, place.name]
      const flat = [{ ...place, path: path.join(' / ') }]
      return [...flat, ...flattenPlaces(place.children, path)]
    })
  }

  function normalizePage(raw, rows, total) {
    const source = raw && typeof raw === 'object' ? raw : null
    const hasMore = source ? source.has_more === true : total > rows.length
    const cursor = safeId(source?.next_before_id) || safeId(rows.at(-1)?.id)
    return Object.freeze({
      hasMore: Boolean(hasMore && cursor),
      nextBeforeId: hasMore && cursor ? cursor : null,
    })
  }

  function normalizeSubplacePage(raw, rows, total) {
    const source = raw && typeof raw === 'object' ? raw : null
    const hasMore = source ? source.has_more === true : total > rows.length
    const cursor = safeId(source?.next_before_subplace_id) || safeId(rows.at(-1)?.id)
    return Object.freeze({
      hasMore: Boolean(hasMore && cursor),
      nextBeforeSubplaceId: hasMore && cursor ? cursor : null,
    })
  }

  function normalizeSnapshot(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid public snapshot')
    const places = normalizePlaces(payload.places, 0, new Set())
    const residents = normalizeResidents(payload.residents)
    const notes = normalizeNotes(payload.notes)
    const things = normalizeThings(payload.things)
    const agreements = normalizeAgreements(payload.agreements)
    const events = normalizeEvents(payload.events)
    const shown = {
      places: flattenPlaces(places, []).length,
      residents: residents.length,
      conversations: notes.length,
      things: things.length,
      agreements: agreements.length,
      events: events.length,
    }
    const rawTotals = payload.totals && typeof payload.totals === 'object' ? payload.totals : {}
    const totals = Object.fromEntries(Object.entries(shown).map(([key, visible]) => [
      key,
      Math.max(safeCount(rawTotals[key]), visible),
    ]))
    const rawPages = payload.pages && typeof payload.pages === 'object' ? payload.pages : {}
    const pages = Object.freeze({
      places: normalizeSubplacePage(rawPages.places, places[0]?.children || [], totals.places),
      residents: normalizePage(rawPages.residents, residents, totals.residents),
      notes: normalizePage(rawPages.notes, notes, totals.conversations),
      things: normalizePage(rawPages.things, things, totals.things),
      agreements: normalizePage(rawPages.agreements, agreements, totals.agreements),
      events: normalizePage(rawPages.events, events, totals.events),
    })
    const rawBodyLimits = payload.body_limits && typeof payload.body_limits === 'object'
      ? payload.body_limits
      : {}
    const bodyLimits = Object.freeze({
      notes: safeId(rawBodyLimits.notes),
      things: safeId(rawBodyLimits.things),
      agreements: safeId(rawBodyLimits.agreements),
    })
    const hasBodyLimits = bodyLimits.notes && bodyLimits.things && bodyLimits.agreements
    return Object.freeze({
      places,
      flatPlaces: flattenPlaces(places, []),
      residents,
      notes,
      things,
      agreements,
      events,
      shown,
      totals,
      pages,
      bodyLimits: hasBodyLimits ? bodyLimits : null,
      view: payload.view === 'outline' ? 'outline' : 'full',
      changeMarker: safeChangeMarker(payload.change_marker),
      refreshedAt: safeDate(payload.refreshed_at),
    })
  }

  function mergePlaceRows(currentChildren, incomingChildren) {
    const currentById = new Map(currentChildren.map(place => [place.id, place]))
    const incomingById = new Map(incomingChildren.map(place => [place.id, place]))
    return mergeWindowRows(currentChildren, incomingChildren).map(place => {
      const current = currentById.get(place.id)
      const incoming = incomingById.get(place.id)
      return Object.freeze({
        ...(current || {}),
        ...(incoming || place),
        children: mergePlaceRows(current?.children || [], incoming?.children || []),
      })
    })
  }

  function mergePlaceMetadata(values, incoming) {
    return values.map(place => Object.freeze({
      ...(place.id === incoming.id
        ? { ...place, ...incoming, children: place.children }
        : place),
      children: mergePlaceMetadata(place.children, incoming),
    }))
  }

  function mergeParentIntoBranches(branches, parent) {
    return Object.fromEntries(Object.entries(branches).map(([key, entry]) => [
      key,
      Object.freeze({ ...entry, rows: mergePlaceMetadata(entry.rows, parent) }),
    ]))
  }

  function materializePlaces(values, branches, depth, seen) {
    if (!Array.isArray(values) || depth >= 32) return []
    return values.flatMap(place => {
      if (!place || seen.has(place.id)) return []
      const entry = branches[String(place.id)]
      const source = entry?.loaded ? entry.rows : place.children
      return [Object.freeze({
        ...place,
        children: materializePlaces(source, branches, depth + 1, new Set([...seen, place.id])),
      })]
    })
  }

  function withNavigation(snapshot, branches, residents) {
    const places = materializePlaces(snapshot.places, branches, 0, new Set())
    const flatPlaces = flattenPlaces(places, [])
    return Object.freeze({
      ...snapshot,
      places,
      flatPlaces,
      residents,
      shown: Object.freeze({
        ...snapshot.shown,
        places: flatPlaces.length,
        residents: residents.length,
      }),
      totals: Object.freeze({
        ...snapshot.totals,
        places: Math.max(snapshot.totals.places, flatPlaces.length),
        residents: Math.max(snapshot.totals.residents, residents.length),
      }),
    })
  }

  function branchPageFromPayload(payload, placeId) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid public map branch')
    const [parent] = normalizePlaces([payload.place], 0, new Set())
    if (!parent || parent.id !== placeId) throw new Error('wrong public map branch')
    const rows = normalizePlaces(payload.subplaces, 0, new Set([placeId]))
      .filter(child => child.parent_id === placeId)
    const page = normalizeSubplacePage(payload.subplaces_page, rows, parent.places)
    if (payload.subplaces_page?.has_more === true &&
        (!page.nextBeforeSubplaceId || !rows.some(row => row.id === page.nextBeforeSubplaceId))) {
      throw new Error('invalid public map cursor')
    }
    return Object.freeze({ parent, rows, page })
  }

  function branchCursorProgressed(requested, next, seen, rows) {
    return Boolean(next && rows.some(row => row.id === next) &&
      (!requested || next < requested) && !seen.includes(next))
  }

  function residentComesBefore(candidate, boundary) {
    const timeDifference = candidate.joined_at.getTime() - boundary.joined_at.getTime()
    return timeDifference < 0 || (timeDifference === 0 && candidate.id < boundary.id)
  }

  function residentCursorProgressed(requested, next, seen, rows, knownRows) {
    if (!next || seen.includes(next)) return false
    const nextResident = rows.find(row => row.id === next)
    if (!nextResident) return false
    if (!requested) return true
    const boundary = knownRows.find(row => row.id === requested)
    return requested !== next && Boolean(boundary && residentComesBefore(nextResident, boundary))
  }

  async function fetchBranchForwardPage(placeId, beforeId, minimumMarker, signal) {
    const url = branchRequestUrl(placeId, {
      initialized: Boolean(beforeId), nextBeforeSubplaceId: beforeId,
    }, minimumMarker)
    const response = await fetch(url.pathname + url.search, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public map branch unavailable')
    const payload = await response.json()
    requireExactReadMarker(payload?.change_marker, minimumMarker)
    return branchPageFromPayload(payload, placeId)
  }

  async function forwardReconcileBranch(
    placeId, current, firstPage, minimumMarker, signal, takeBudget,
  ) {
    const oldIds = new Set(current.rows.map(row => row.id))
    let seen = []
    let beforeId = null
    let collected = []
    let pageResult = firstPage
    let lastParent = firstPage?.parent || null
    for (let pageCount = 0; pageCount < MAX_FORWARD_RECONCILE_PAGES; pageCount += 1) {
      if (!pageResult && !takeBudget()) break
      const result = pageResult || await fetchBranchForwardPage(
        placeId, beforeId, minimumMarker, signal)
      pageResult = null
      lastParent = result.parent
      const next = result.page.nextBeforeSubplaceId
      if (result.page.hasMore &&
          !branchCursorProgressed(beforeId, next, seen, result.rows)) {
        throw new Error('public map cursor did not progress')
      }
      collected = mergePlaceRows(collected, result.rows)
      const overlap = result.rows.some(row => oldIds.has(row.id))
      if (overlap || !result.page.hasMore) {
        return Object.freeze({
          parent: result.parent,
          rows: mergePlaceRows(current.rows, collected),
          complete: true,
        })
      }
      seen = [...seen, next]
      beforeId = next
    }
    if (lastParent && collected.length && beforeId) {
      return Object.freeze({
        parent: lastParent,
        rows: collected,
        complete: false,
        nextBeforeSubplaceId: beforeId,
        seenBeforeSubplaceIds: seen,
        deferredRows: current.rows,
      })
    }
    throw new Error('public map reconciliation limit reached')
  }

  async function fetchResidentForwardPage(beforeId, minimumMarker, signal) {
    const url = residentRequestUrl(
      { initialized: Boolean(beforeId), nextBeforeId: beforeId },
      minimumMarker,
    )
    const response = await fetch(url.pathname + url.search, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public resident page unavailable')
    const payload = await response.json()
    if (!payload || typeof payload !== 'object') throw new Error('invalid public resident page')
    requireExactReadMarker(payload.change_marker, minimumMarker)
    const rows = normalizeResidents(payload.residents)
    const page = Object.freeze({
      hasMore: payload.has_more === true,
      nextBeforeId: payload.has_more === true ? safeId(payload.next_before_id) : null,
    })
    return Object.freeze({ rows, page })
  }

  async function forwardReconcileResidents(snapshot, previousRows, signal, takeBudget) {
    if (!previousRows.length) return Object.freeze({ rows: snapshot.residents, complete: true })
    const oldIds = new Set(previousRows.map(row => row.id))
    let seen = []
    let beforeId = null
    let collected = snapshot.residents
    let rows = snapshot.residents
    let page = snapshot.pages.residents
    for (let pageCount = 0; pageCount < MAX_FORWARD_RECONCILE_PAGES; pageCount += 1) {
      const knownRows = mergeResidentRows(previousRows, collected)
      if (page.hasMore &&
          !residentCursorProgressed(beforeId, page.nextBeforeId, seen, rows, knownRows)) {
        throw new Error('public resident cursor did not progress')
      }
      const overlap = rows.some(row => oldIds.has(row.id))
      if (overlap || !page.hasMore) {
        return Object.freeze({ rows: mergeResidentRows(previousRows, collected), complete: true })
      }
      seen = [...seen, page.nextBeforeId]
      beforeId = page.nextBeforeId
      if (!takeBudget()) break
      const next = await fetchResidentForwardPage(beforeId, snapshot.changeMarker, signal)
      rows = next.rows
      page = next.page
      collected = mergeResidentRows(collected, rows)
    }
    if (collected.length && beforeId) {
      return Object.freeze({
        rows: collected,
        complete: false,
        nextBeforeId: beforeId,
        seenBeforeIds: seen,
        deferredResidents: previousRows,
      })
    }
    throw new Error('public resident reconciliation limit reached')
  }

  async function mergeFreshNavigation(snapshot, signal) {
    const previousBranches = state.branches
    let remainingReconcilePages = MAX_FORWARD_RECONCILE_PAGES
    const takeReconcileBudget = () => {
      if (remainingReconcilePages <= 0) return false
      remainingReconcilePages -= 1
      return true
    }
    let branches = { ...previousBranches }
    let refreshedPlaces = snapshot.places
    const rootIds = new Set(snapshot.places.map(root => root.id))

    for (const [index, root] of snapshot.places.entries()) {
      const current = previousBranches[String(root.id)]
      const page = index === 0
        ? snapshot.pages.places
        : normalizeSubplacePage(null, root.children, root.places)
      if (!current) {
        branches = {
          ...branches,
          [String(root.id)]: Object.freeze({
            rows: root.children,
            loaded: true,
            initialized: true,
            hasMore: page.hasMore,
            nextBeforeSubplaceId: page.nextBeforeSubplaceId,
            seenBeforeSubplaceIds: [],
            loading: false,
            error: false,
          }),
        }
        continue
      }
      if (current.loading || (current.deferredRows || []).length) continue
      try {
        const reconciled = await forwardReconcileBranch(
          root.id,
          current,
          Object.freeze({ parent: root, rows: root.children, page }),
          snapshot.changeMarker,
          signal,
          takeReconcileBudget,
        )
        branches = {
          ...branches,
          [String(root.id)]: Object.freeze({
            ...current,
            rows: reconciled.rows,
            ...(reconciled.complete
              ? { deferredRows: [] }
              : {
                  deferredRows: reconciled.deferredRows,
                  hasMore: true,
                  nextBeforeSubplaceId: reconciled.nextBeforeSubplaceId,
                  seenBeforeSubplaceIds: reconciled.seenBeforeSubplaceIds,
                }),
            loading: false,
            error: false,
          }),
        }
      } catch {
        // Keep the last contiguous root page; the next bounded refresh retries.
      }
    }

    const nestedBranches = Object.entries(previousBranches).filter(([key, current]) => {
      const placeId = safeId(key)
      return placeId && !rootIds.has(placeId) && current.loaded && current.initialized &&
        !current.loading && !(current.deferredRows || []).length
    })
    const branchCount = Math.min(2, nestedBranches.length)
    const selectedBranches = Array.from({ length: branchCount }, (_, index) =>
      nestedBranches[(branchRefreshOffset + index) % nestedBranches.length])
    if (nestedBranches.length) branchRefreshOffset = (branchRefreshOffset + branchCount) % nestedBranches.length
    for (const [key, current] of selectedBranches) {
      const placeId = safeId(key)
      if (!placeId) continue
      try {
        const reconciled = await forwardReconcileBranch(
          placeId, current, null, snapshot.changeMarker, signal, takeReconcileBudget)
        branches = mergeParentIntoBranches(branches, reconciled.parent)
        branches = {
          ...branches,
          [key]: Object.freeze({
            ...current,
            rows: reconciled.rows,
            ...(reconciled.complete
              ? { deferredRows: [] }
              : {
                  deferredRows: reconciled.deferredRows,
                  hasMore: true,
                  nextBeforeSubplaceId: reconciled.nextBeforeSubplaceId,
                  seenBeforeSubplaceIds: reconciled.seenBeforeSubplaceIds,
                }),
            loading: false,
            error: false,
          }),
        }
        refreshedPlaces = mergePlaceMetadata(refreshedPlaces, reconciled.parent)
      } catch {
        // Silent revalidation never discards an already contiguous branch.
      }
    }

    let residents = snapshot.residents
    let residentPaging = state.residentPaging.initialized
      ? state.residentPaging
      : Object.freeze({
          initialized: true,
          hasMore: snapshot.pages.residents.hasMore,
          nextBeforeId: snapshot.pages.residents.nextBeforeId,
          seenBeforeIds: [],
          loading: false,
          error: false,
        })
    if ((state.residentPaging.deferredResidents || []).length) {
      residents = state.snapshot?.residents || snapshot.residents
    } else {
      try {
        const reconciled = await forwardReconcileResidents(
          snapshot, state.snapshot?.residents || [], signal, takeReconcileBudget)
        residents = reconciled.rows
        if (!reconciled.complete) {
          residentPaging = Object.freeze({
            ...residentPaging,
            hasMore: true,
            nextBeforeId: reconciled.nextBeforeId,
            seenBeforeIds: reconciled.seenBeforeIds,
            deferredResidents: reconciled.deferredResidents,
            error: false,
          })
        } else if (residentPaging.deferredResidents) {
          residentPaging = Object.freeze({ ...residentPaging, deferredResidents: [] })
        }
      } catch {
        residents = state.snapshot?.residents || snapshot.residents
      }
    }
    const refreshedSnapshot = Object.freeze({ ...snapshot, places: refreshedPlaces })
    return Object.freeze({
      branches,
      residentPaging,
      snapshot: withNavigation(refreshedSnapshot, branches, residents),
    })
  }

  function freshSnapshotNavigation(snapshot) {
    const branches = Object.fromEntries(snapshot.places.map((root, index) => {
      const page = index === 0
        ? snapshot.pages.places
        : normalizeSubplacePage(null, root.children, root.places)
      return [String(root.id), Object.freeze({
        rows: root.children,
        loaded: true,
        initialized: true,
        hasMore: page.hasMore,
        nextBeforeSubplaceId: page.nextBeforeSubplaceId,
        seenBeforeSubplaceIds: [],
        loading: false,
        error: false,
      })]
    }))
    const residentPaging = Object.freeze({
      initialized: true,
      hasMore: snapshot.pages.residents.hasMore,
      nextBeforeId: snapshot.pages.residents.nextBeforeId,
      seenBeforeIds: [],
      loading: false,
      error: false,
    })
    return Object.freeze({
      branches,
      residentPaging,
      snapshot: withNavigation(snapshot, branches, snapshot.residents),
    })
  }

  function replaceBranch(placeId, entry) {
    const branches = { ...state.branches, [String(placeId)]: Object.freeze(entry) }
    const snapshot = state.snapshot
      ? withNavigation(state.snapshot, branches, state.snapshot.residents)
      : null
    state = { ...state, branches, snapshot }
  }

  function replaceBranchWithParent(placeId, entry, parent) {
    let branches = mergeParentIntoBranches(state.branches, parent)
    branches = { ...branches, [String(placeId)]: Object.freeze(entry) }
    const base = state.snapshot
      ? Object.freeze({
          ...state.snapshot,
          places: mergePlaceMetadata(state.snapshot.places, parent),
        })
      : null
    const snapshot = base ? withNavigation(base, branches, base.residents) : null
    state = { ...state, branches, snapshot }
  }

  function historyKey(collection, filters) {
    const place = collection === 'agreements' ? '' : String(filters.placeId || '')
    if (!place && !filters.resident) return 'all'
    return (filters.context ? 'context|' : '') +
      'place:' + place + '|resident:' + String(filters.resident || '')
  }

  function filterHistoryRows(collection, rows, filters, snapshot) {
    const placeIds = filters.placeId ? placeScopeSet(filters.placeId, snapshot) : null
    if (collection === 'notes') return rows.filter(row =>
      (!placeIds || placeIds.has(row.place_id)) &&
      (!filters.resident || row.author === filters.resident))
    if (collection === 'things') return rows.filter(row =>
      (!placeIds || placeIds.has(row.place_id)) &&
      (!filters.resident || row.owner === filters.resident))
    if (collection === 'agreements') return rows.filter(row => !filters.resident ||
      row.created_by === filters.resident || row.parties.includes(filters.resident) ||
      row.parties_truncated)
    return rows.filter(row =>
      (!filters.resident || row.actor === filters.resident) &&
      (!placeIds || placeIds.has(eventPlaceId(row, snapshot))))
  }

  function historyTotal(collection, filters) {
    const snapshot = state.snapshot
    if (!snapshot) return 0
    const placeIds = filters.placeId ? placeScopeSet(filters.placeId, snapshot) : null
    const places = placeIds
      ? snapshot.flatPlaces.filter(candidate => placeIds.has(candidate.id))
      : []
    if (collection === 'notes') return placeIds
      ? places.reduce((total, place) => total + place.notes, 0)
      : snapshot.totals.conversations
    if (collection === 'things') return placeIds
      ? places.reduce((total, place) => total + place.things, 0)
      : snapshot.totals.things
    if (collection === 'agreements') return snapshot.totals.agreements
    return snapshot.totals.events
  }

  function historyEntry(collection, filters) {
    const key = historyKey(collection, filters)
    const stored = state.histories[collection]?.[key]
    if (stored) return stored
    const global = state.histories[collection]?.all
    const snapshotRows = state.snapshot?.[collection] || []
    const rows = filterHistoryRows(collection, global?.rows || snapshotRows, filters, state.snapshot)
    return Object.freeze({
      rows,
      hasMore: historyTotal(collection, filters) > rows.length,
      nextBeforeId: null,
      initialized: false,
      loading: false,
      error: false,
      refreshing: false,
      refreshError: false,
    })
  }

  function setHistoryEntry(collection, filters, entry) {
    const key = historyKey(collection, filters)
    state = {
      ...state,
      histories: {
        ...state.histories,
        [collection]: {
          ...state.histories[collection],
          [key]: Object.freeze({
            ...entry,
            filters: Object.freeze({
              placeId: filters.placeId,
              resident: filters.resident,
              context: filters.context === true,
            }),
          }),
        },
      },
    }
  }

  function freshSnapshotHistories(snapshot) {
    let histories = {}
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      const page = snapshot.pages[collection]
      histories = {
        ...histories,
        [collection]: {
          all: Object.freeze({
            rows: snapshot[collection],
            hasMore: page.hasMore,
            nextBeforeId: page.nextBeforeId,
            initialized: true,
            loading: false,
            error: false,
            refreshing: false,
            refreshError: false,
          }),
        },
      }
    }
    return histories
  }

  function mergeUnchangedSnapshotHistories(snapshot) {
    let histories = state.histories
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      const existing = histories[collection] || {}
      const refreshed = Object.fromEntries(Object.entries(existing).map(([key, entry]) => {
        if (key === 'all' || !entry?.filters) return [key, entry]
        const freshRows = filterHistoryRows(collection, snapshot[collection], entry.filters, snapshot)
        return [key, Object.freeze({ ...entry, rows: mergeWindowRows(entry.rows, freshRows) })]
      }))
      const current = existing.all
      const rows = mergeWindowRows(current?.rows || [], snapshot[collection])
      const page = snapshot.pages[collection]
      const entry = current
        ? { ...current, rows }
        : {
            rows,
            hasMore: page.hasMore,
            nextBeforeId: page.nextBeforeId,
            initialized: true,
            loading: false,
            error: false,
          }
      histories = {
        ...histories,
        [collection]: { ...refreshed, all: Object.freeze(entry) },
      }
    }
    return histories
  }

  function readLocationState() {
    const legacyHash = window.location.hash.slice(1)
    const params = new URLSearchParams(legacyHash || window.location.search)
    const parts = window.location.pathname.split('/').filter(Boolean)
    const pathKind = parts[0] === 'window' ? parts[1] || null : null
    const pathId = safeId(parts[2])
    const pathView = legacyHash
      ? null
      : VIEWS.includes(pathKind) ? pathKind
        : pathKind === 'thing' || pathKind === 'note' ? 'map' : null
    const view = legacyHash ? params.get('view') : pathView
    const resident = safeHandle(params.get('resident'))
    const mode = safeArchiveChoice(params.get('mode'), ['words', 'phrase'], 'words')
    const type = safeArchiveChoice(params.get('type'), ['all', 'note', 'thing'], 'all')
    const archiveQuery = validateWindowArchiveQuery(params.get('q') || '', mode)
    const query = archiveQuery.ok ? archiveQuery.value : ''
    const sharedDirectorySearch = validateWindowDirectorySearch(params.get('find') || '')
    const directorySearch = sharedDirectorySearch.ok ? sharedDirectorySearch.value : ''
    const sleeperPlaceIds = parseWindowSleeperPlaceIds(params.get('sleepers'))
    const archiveChanged = query !== state.archive.query || mode !== state.archive.mode ||
      type !== state.archive.type
    const selectedView = VIEWS.includes(view) ? view : 'map'
    const gazetteIssueId = selectedView === 'gazette' ? safeId(params.get('issue')) : null
    const gazetteChanged = gazetteIssueId !== state.gazetteIssueId
    const detail = !legacyHash && pathId && ['place', 'thing', 'note'].includes(pathKind)
      ? Object.freeze({ kind: pathKind, id: pathId })
      : null
    const pathPlaceId = detail?.kind === 'place' ? detail.id : null
    return {
      view: selectedView,
      placeId: pathPlaceId || safeId(params.get('place')),
      resident,
      conversationContext: Boolean(resident && params.get('context') === 'place'),
      directorySearch,
      directorySearchIndex: directorySearch ? 0 : -1,
      sleeperPlaceIds,
      archive: archiveChanged
        ? {
            ...state.archive,
            query,
            mode,
            type,
            results: [],
            totalItems: 0,
            totalTextBytes: 0,
            nextBefore: null,
            hasMore: false,
            loading: false,
            initialized: false,
            error: null,
          }
        : state.archive,
      gazette: gazetteChanged
        ? {
            ...state.gazette,
            issue: null,
            entries: [],
            nextAfterOrdinal: null,
            hasMoreEntries: false,
            detailLoading: false,
            detailInitialized: false,
            detailError: null,
          }
        : state.gazette,
      gazetteIssueId,
      detail,
    }
  }

  function viewShareState() {
    return Object.freeze({
      view: state.view,
      placeId: state.placeId,
      resident: state.resident,
      conversationContext: state.conversationContext,
      directorySearch: state.directorySearch,
      sleeperPlaceIds: state.sleeperPlaceIds,
      archive: Object.freeze({
        query: state.archive.query,
        mode: state.archive.mode,
        type: state.archive.type,
      }),
      gazetteIssueId: state.gazetteIssueId,
      detail: state.detail,
    })
  }

  function writeLocation(push, entryState = null) {
    const path = windowSharePath(viewShareState())
    if (!path) {
      resetShareFeedback()
      return false
    }
    const current = window.location.pathname + window.location.search
    if (current === path && !window.location.hash) return true
    resetShareFeedback()
    if (push) history.pushState(entryState, '', path)
    else history.replaceState(entryState, '', path)
    return true
  }

  // Deliberate navigation — tabs, choosing a place or resident, filters —
  // creates a real back/forward entry. Background refresh never touches
  // history because renderAll only replaces when the hash is unchanged.
  // Arrow-key roving between tabs updates the address without pushing, so
  // walking the tab list never floods the back button.
  let rovingTabActivation = false
  function navigate(next) {
    const openingDetail = Boolean(next?.detail && (
      state.detail?.kind !== next.detail.kind || state.detail?.id !== next.detail.id
    ))
    if (openingDetail || (Object.hasOwn(next, 'detail') && next.detail === null)) {
      detailRequestRevision += 1
    }
    resetShareFeedback()
    state = { ...state, ...next }
    writeLocation(!rovingTabActivation, openingDetail ? { windowDetailEntry: true } : null)
    renderAll()
    void ensureFocusedSelection()
    void ensureDetail()
    loadSharedGazette()
  }

  function closeDetail() {
    if (!state.detail) return
    detailRequestRevision += 1
    resetShareFeedback()
    if (nodes.detail?.open) nodes.detail.close()
    if (history.state?.windowDetailEntry === true) {
      history.back()
      return
    }
    state = { ...state, detail: null }
    writeLocation(false)
    renderAll()
    void ensureFocusedSelection()
  }

  function syncArchiveControls() {
    if (nodes.archiveQuery) nodes.archiveQuery.value = state.archive.query
    if (nodes.archiveMode) nodes.archiveMode.value = state.archive.mode
    if (nodes.archiveType) nodes.archiveType.value = state.archive.type
  }

  function loadSharedArchiveQuestion() {
    if (
      state.view === 'archive' && state.archive.query &&
      !state.archive.initialized && !state.archive.loading
    ) void loadArchive(true, true)
  }

  function activeSelectionKey() {
    return String(state.placeId || '') + '|resident:' + String(state.resident || '')
  }

  function activeFocusedPlaceIds(snapshot) {
    const followed = selectedResident(snapshot)
    const placeId = state.placeId || followed?.current_place_id || null
    return placeId ? [placeId] : []
  }

  function displayedDirectoryPlaces(snapshot) {
    const base = state.directory.loaded ? state.directory.places : snapshot.flatPlaces
    const replaced = base.map(place => focusedPlace(place.id) || place)
    const known = new Set(replaced.map(place => place.id))
    const additions = activeFocusedPlaceIds(snapshot).flatMap(placeId => {
      const place = known.has(placeId) ? null : focusedPlace(placeId)
      return place ? [place] : []
    })
    return [...replaced, ...additions]
  }

  function directorySearchSources(snapshot) {
    return {
      places: displayedDirectoryPlaces(snapshot),
      residents: state.directory.loaded ? state.directory.residents : snapshot.residents,
      complete: state.directory.loaded,
    }
  }

  function directorySearchPage(snapshot) {
    const sources = directorySearchSources(snapshot)
    return pageWindowDirectorySearch(
      sources.places,
      sources.residents,
      state.directorySearch,
    )
  }

  function directorySearchRows(snapshot) {
    return directorySearchPage(snapshot).results
  }

  function closeDirectorySearchResults() {
    if (nodes.directorySearchResults) nodes.directorySearchResults.hidden = true
    if (nodes.directorySearch) {
      nodes.directorySearch.setAttribute('aria-expanded', 'false')
      nodes.directorySearch.removeAttribute('aria-activedescendant')
    }
  }

  function selectDirectorySearchResult(index) {
    if (!state.snapshot) return
    const result = directorySearchRows(state.snapshot)[index]
    if (!result) return
    state = { ...state, directorySearch: '', directorySearchIndex: -1 }
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    if (result.kind === 'place') choosePlace(result.id, false)
    else chooseResident(result.value)
  }

  function renderDirectorySearch(snapshot, open = document.activeElement === nodes.directorySearch) {
    if (!nodes.directorySearch || !nodes.directorySearchResults || !nodes.directorySearchStatus) return
    if (nodes.directorySearch.value !== state.directorySearch) {
      nodes.directorySearch.value = state.directorySearch
    }
    const sources = directorySearchSources(snapshot)
    const query = state.directorySearch.trim()
    const page = directorySearchPage(snapshot)
    const results = page.results
    const fallbackNotice = state.directory.error
      ? ' The complete city directory is unavailable, so more citywide matches may exist.'
      : ' The complete city directory is still loading, so more citywide matches may exist.'
    if (!query) {
      nodes.directorySearchStatus.textContent = (sources.complete ? '' : 'Currently loaded fallback: ') +
        String(sources.places.length) +
        (sources.places.length === 1 ? ' place and ' : ' places and ') +
        String(sources.residents.length) +
        (sources.residents.length === 1 ? ' resident available.' : ' residents available.') +
        (sources.complete ? '' : fallbackNotice)
      nodes.directorySearchResults.replaceChildren()
      closeDirectorySearchResults()
      return
    }

    nodes.directorySearchStatus.textContent = sources.complete
      ? page.hasMore
        ? 'Showing the first ' + String(results.length) + ' of ' + String(page.total) +
          ' exact matches: ' + String(page.placeCount) +
          (page.placeCount === 1 ? ' place and ' : ' places and ') +
          String(page.residentCount) +
          (page.residentCount === 1 ? ' resident. ' : ' residents. ') +
          'Narrow this search or use the complete selectors to reach every match.'
        : String(page.total) + (page.total === 1 ? ' result: ' : ' results: ') +
          String(page.placeCount) + (page.placeCount === 1 ? ' place and ' : ' places and ') +
          String(page.residentCount) +
          (page.residentCount === 1 ? ' resident.' : ' residents.')
      : (page.hasMore
          ? 'Showing the first ' + String(results.length) + ' of ' + String(page.total) +
            ' matches in the currently loaded fallback: '
          : String(page.total) + (page.total === 1
              ? ' result in the currently loaded fallback: '
              : ' results in the currently loaded fallback: ')) +
        String(page.placeCount) + (page.placeCount === 1 ? ' place and ' : ' places and ') +
        String(page.residentCount) +
        (page.residentCount === 1 ? ' resident.' : ' residents.') + fallbackNotice
    if (!results.length) {
      const empty = element('div', 'directory-search-empty', sources.complete
        ? 'No places or residents match this search.'
        : 'No places or residents in the currently loaded fallback match this search.' + fallbackNotice)
      empty.setAttribute('role', 'option')
      empty.setAttribute('aria-disabled', 'true')
      nodes.directorySearchResults.replaceChildren(empty)
      nodes.directorySearch.removeAttribute('aria-activedescendant')
      state = { ...state, directorySearchIndex: -1 }
    } else {
      const activeIndex = Math.min(Math.max(state.directorySearchIndex, 0), results.length - 1)
      if (activeIndex !== state.directorySearchIndex) {
        state = { ...state, directorySearchIndex: activeIndex }
      }
      const options = results.map((result, index) => {
        const option = element('div', 'directory-search-option')
        option.id = 'directory-search-option-' + String(index)
        option.setAttribute('role', 'option')
        option.setAttribute('aria-selected', String(index === activeIndex))
        option.append(
          element('strong', '', result.label),
          element('small', '', result.kind === 'place' ? 'Place · ' + result.detail : result.detail),
        )
        option.addEventListener('mousedown', event => event.preventDefault())
        option.addEventListener('mouseenter', () => {
          if (state.directorySearchIndex === index) return
          state = { ...state, directorySearchIndex: index }
          for (const [optionIndex, searchOption] of [...nodes.directorySearchResults.children].entries()) {
            searchOption.setAttribute('aria-selected', String(optionIndex === index))
          }
          nodes.directorySearch.setAttribute('aria-activedescendant', option.id)
        })
        option.addEventListener('click', () => selectDirectorySearchResult(index))
        return option
      })
      nodes.directorySearchResults.replaceChildren(...options)
      nodes.directorySearch.setAttribute('aria-activedescendant', 'directory-search-option-' + String(activeIndex))
    }
    nodes.directorySearchResults.hidden = !open
    nodes.directorySearch.setAttribute('aria-expanded', String(open))
  }

  function populateFilters(snapshot) {
    const places = displayedDirectoryPlaces(snapshot)
    if (nodes.placeFilter) {
      const choices = listWindowDirectoryPlaces(places)
      const visiblePlaceIds = new Set(choices.map(option => option.id))
      const placeholder = element('option', '', 'All places')
      placeholder.value = ''
      const options = [placeholder, ...choices.map(choice => {
        const option = element('option', '', '\u00a0\u00a0'.repeat(choice.depth) + choice.label)
        option.value = String(choice.id)
        return option
      })]
      if (state.placeId && !visiblePlaceIds.has(state.placeId)) {
        const selected = focusedPlace(state.placeId) ||
          places.find(place => place.id === state.placeId)
        const focusedRead = state.focusedPlaces[String(state.placeId)]
        const option = element('option', '', selected
          ? selected.name + ' · Place #' + String(selected.id)
          : focusedRead?.notFound
            ? 'Place #' + String(state.placeId) + ' · no public place was found'
            : focusedRead?.error
              ? 'Place #' + String(state.placeId) + ' · public place could not be loaded'
              : 'Place #' + String(state.placeId) + ' · loading public place…')
        option.value = String(state.placeId)
        options.push(option)
      }
      nodes.placeFilter.replaceChildren(...options)
      nodes.placeFilter.value = state.placeId ? String(state.placeId) : ''
    }
    if (nodes.residentFilter) {
      const residents = state.directory.loaded ? state.directory.residents : snapshot.residents
      const focusedRead = state.resident ? state.focusedResidents[state.resident] : null
      const missingResident = state.resident && !residents.some(resident => resident.handle === state.resident)
        ? [element('option', '', focusedRead?.notFound
          ? state.resident + ' · no public resident was found'
          : focusedRead?.error
            ? state.resident + ' · public resident could not be loaded'
            : state.resident + ' · loading public resident…')]
        : []
      if (missingResident[0]) missingResident[0].value = state.resident
      const options = [element('option', '', 'All residents'), ...residents.map(resident => {
        const option = element('option', '', resident.handle + ' · Resident #' + String(resident.id))
        option.value = resident.handle
        return option
      }), ...missingResident]
      options[0].value = ''
      nodes.residentFilter.replaceChildren(...options)
      nodes.residentFilter.value = state.resident || ''
    }
    renderDirectorySearch(snapshot)
  }

  function selectedResident(snapshot) {
    return state.resident
      ? focusedResident(state.resident) ||
        snapshot.residents.find(resident => resident.handle === state.resident)
      : null
  }

  function residentPresentationKey(snapshot) {
    return JSON.stringify(snapshot?.residents || [])
  }

  function directoryResident(handle) {
    return handle
      ? state.directory.residents.find(resident => resident.handle === handle) || null
      : null
  }

  function residentReference(snapshot, handle) {
    if (!handle) return null
    return focusedResident(handle) ||
      snapshot.residents.find(resident => resident.handle === handle) || directoryResident(handle)
  }

  function directoryPlace(placeId) {
    return placeId
      ? state.directory.places.find(place => place.id === placeId) || null
      : null
  }

  function placeScopeSet(placeId, snapshot) {
    const places = state.directory.loaded
      ? state.directory.places
      : snapshot?.flatPlaces || []
    return new Set(windowDirectoryPlaceScopeIds(places, placeId))
  }

  function placeReference(snapshot, placeId) {
    if (!placeId) return null
    return focusedPlace(placeId) ||
      snapshot.flatPlaces.find(place => place.id === placeId) || directoryPlace(placeId)
  }

  function focusedPlacePath(reference, place) {
    if (!reference) return place.name + ' · Place #' + String(place.id)
    const fallbackSuffix = ' · Place #' + String(place.id)
    if (reference.path.endsWith(fallbackSuffix)) return place.name + fallbackSuffix
    const names = reference.path.split(' / ')
    return [...names.slice(0, -1), place.name].join(' / ')
  }

  function focusedPlace(placeId) {
    if (!placeId) return null
    const entry = state.focusedPlaces[String(placeId)]
    const place = entry?.place || null
    if (place && state.changeMarker && !markerCovers(entry?.marker, state.changeMarker)) return null
    const reference = directoryPlace(placeId)
    return place
      ? Object.freeze({ ...place, path: focusedPlacePath(reference, place) })
      : null
  }

  function focusedResident(handle) {
    if (!handle) return null
    const entry = state.focusedResidents[handle]
    if (entry?.resident && state.changeMarker && !markerCovers(entry.marker, state.changeMarker)) {
      return null
    }
    return entry?.resident || null
  }

  function selectedPlace(snapshot) {
    const followed = selectedResident(snapshot)
    const id = state.placeId || (followed && followed.current_place_id) || null
    return id
      ? focusedPlace(id) || snapshot.flatPlaces.find(place => place.id === id)
      : null
  }

  function displayedResidents(snapshot) {
    const residents = snapshot.residents.map(resident =>
      focusedResident(resident.handle) || resident)
    const followed = selectedResident(snapshot)
    return followed && !residents.some(resident => resident.handle === followed.handle)
      ? [...residents, followed]
      : residents
  }

  function residentsAt(snapshot, placeId) {
    const placeIds = placeScopeSet(placeId, snapshot)
    return displayedResidents(snapshot).filter(resident => placeIds.has(resident.current_place_id) &&
      (!state.resident || resident.handle === state.resident))
  }

  function selectionIssue(snapshot, includeCurrentPlace) {
    const resident = selectedResident(snapshot)
    if (state.resident && !resident) {
      const entry = state.focusedResidents[state.resident]
      return Object.freeze({
        kind: 'resident', value: state.resident,
        status: entry?.notFound ? 'not-found' : entry?.error ? 'error' : 'loading',
      })
    }
    const placeId = state.placeId ||
      (includeCurrentPlace && resident ? resident.current_place_id : null)
    const place = placeId
      ? snapshot.flatPlaces.find(candidate => candidate.id === placeId) || focusedPlace(placeId)
      : null
    if (placeId && !place) {
      const entry = state.focusedPlaces[String(placeId)]
      return Object.freeze({
        kind: 'place', value: placeId,
        status: entry?.notFound ? 'not-found' : entry?.error ? 'error' : 'loading',
      })
    }
    return null
  }

  function renderSelectionIssue(target, issue, itemTag, focusFallbackId) {
    if (!target || !issue) return false
    const loadingMessage = issue.kind === 'resident'
      ? 'Loading public resident ' + String(issue.value) + '…'
      : 'Loading public place #' + String(issue.value) + '…'
    const notFoundMessage = issue.kind === 'resident'
      ? 'No public resident was found for ' + String(issue.value) + '.'
      : 'No public place was found for #' + String(issue.value) + '.'
    const failureMessage = issue.kind === 'resident'
      ? 'Public resident ' + String(issue.value) + ' could not be loaded.'
      : 'Public place #' + String(issue.value) + ' could not be loaded.'
    const row = element(itemTag || 'div', issue.status === 'error' ? 'error-row' :
      issue.status === 'not-found' ? 'empty-row' : 'loading-row')
    if (issue.status === 'loading') {
      row.textContent = loadingMessage
    } else if (issue.status === 'not-found') {
      row.textContent = notFoundMessage
    } else {
      row.setAttribute('role', 'alert')
      row.append(element('p', '', failureMessage))
      const retry = element('button', 'selection-retry', issue.kind === 'resident'
        ? 'Retry loading this resident'
        : 'Retry loading this place')
      retry.type = 'button'
      retry.dataset.focusKey = 'selection-retry:' + issue.kind + ':' + String(issue.value)
      retry.dataset.focusFallbackId = focusFallbackId || target.id
      retry.addEventListener('click', () => {
        if (issue.kind === 'resident') void ensureFocusedSelection({ forceResident: true })
        else void loadFocusedPlace(Number(issue.value), true)
      })
      row.append(retry)
    }
    target.replaceChildren(row)
    return true
  }

  function occupantChip(resident) {
    const chip = element('button', resident.asleep ? 'occupant-chip asleep' : 'occupant-chip', resident.handle)
    chip.type = 'button'
    chip.dataset.focusKey = 'occupant:' + resident.handle
    if (resident.asleep) chip.title = 'dimmed by a two-week public-activity display heuristic · not proof they are offline'
    chip.addEventListener('click', () => chooseResident(resident.handle))
    return chip
  }

  function toggleSleepers(placeId) {
    const sleeperPlaceIds = state.sleeperPlaceIds.includes(placeId)
      ? state.sleeperPlaceIds.filter(id => id !== placeId)
      : [...state.sleeperPlaceIds, placeId]
    state = { ...state, sleeperPlaceIds }
    writeLocation(true)
    if (state.snapshot) renderAll()
  }

  function occupantLine(place, occupants) {
    const line = element('div', 'occupant-line')
    const awake = occupants.filter(resident => !resident.asleep)
    const asleep = occupants.filter(resident => resident.asleep)
    line.append(...awake.map(occupantChip))
    if (asleep.length) {
      const shown = state.sleeperPlaceIds.includes(place.id)
      const toggle = element('button', 'sleeper-toggle',
        shown ? 'hide the asleep' : String(asleep.length) + ' asleep')
      toggle.type = 'button'
      toggle.dataset.focusKey = 'sleepers:' + String(place.id)
      toggle.setAttribute('aria-expanded', String(shown))
      toggle.setAttribute('aria-label', (shown ? 'Hide' : 'Show') +
        ' residents asleep in ' + place.name)
      toggle.addEventListener('click', () => toggleSleepers(place.id))
      line.append(toggle)
      if (shown) line.append(...asleep.map(occupantChip))
    }
    return line
  }

  function branchEntry(place) {
    const stored = state.branches[String(place.id)]
    if (stored) return stored
    const loaded = place.children.length > 0 || place.places === 0
    const hasMore = place.places > place.children.length
    return Object.freeze({
      rows: place.children,
      loaded,
      initialized: loaded,
      hasMore,
      nextBeforeSubplaceId: loaded && hasMore ? safeId(place.children.at(-1)?.id) : null,
      seenBeforeSubplaceIds: [],
      loading: false,
      error: false,
    })
  }

  function togglePlaceBranch(placeId) {
    const place = state.snapshot?.flatPlaces.find(candidate => candidate.id === placeId)
    if (!place) return
    const entry = branchEntry(place)
    if (!entry.loaded) {
      if (!entry.loading) void loadPlaceBranch(placeId)
      return
    }
    const collapsedPlaceIds = state.collapsedPlaceIds.includes(placeId)
      ? state.collapsedPlaceIds.filter(id => id !== placeId)
      : [...state.collapsedPlaceIds, placeId]
    state = { ...state, collapsedPlaceIds }
    if (state.snapshot) renderAll()
  }

  function branchRequestUrl(placeId, entry, minimumMarker) {
    const url = new URL('/api/map', window.location.origin)
    url.searchParams.set('view', 'outline')
    url.searchParams.set('parent_id', String(placeId))
    if (entry.initialized && entry.nextBeforeSubplaceId) {
      url.searchParams.set('before_subplace_id', String(entry.nextBeforeSubplaceId))
    }
    url.searchParams.set('subplace_limit', '25')
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    return url
  }

  async function loadPlaceBranch(placeId) {
    const place = state.snapshot?.flatPlaces.find(candidate => candidate.id === placeId)
    if (!place) return
    const current = branchEntry(place)
    if (current.loading || (current.initialized && !current.hasMore && !current.error)) return
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    navigationRevision += 1
    const collapsedPlaceIds = state.collapsedPlaceIds.filter(id => id !== placeId)
    state = { ...state, collapsedPlaceIds }
    replaceBranch(placeId, { ...current, loading: true, error: false })
    renderAll()

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const requestEntry = state.branches[String(placeId)] || current
      const url = branchRequestUrl(placeId, requestEntry, requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('public map branch unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision) return
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      const result = branchPageFromPayload(payload, placeId)
      const requestedCursor = requestEntry.initialized
        ? requestEntry.nextBeforeSubplaceId
        : null
      const seenBeforeSubplaceIds = requestEntry.seenBeforeSubplaceIds || []
      if (result.page.hasMore && !branchCursorProgressed(
        requestedCursor,
        result.page.nextBeforeSubplaceId,
        seenBeforeSubplaceIds,
        result.rows,
      )) throw new Error('public map cursor did not progress')
      const latest = state.branches[String(placeId)] || current
      const deferredRows = latest.deferredRows || []
      const reachedDeferred = result.rows.some(row =>
        deferredRows.some(deferred => deferred.id === row.id))
      const visibleRows = mergePlaceRows(latest.rows, result.rows)
      const reconcileComplete = reachedDeferred || !result.page.hasMore
      replaceBranchWithParent(placeId, {
        rows: reconcileComplete ? mergePlaceRows(deferredRows, visibleRows) : visibleRows,
        deferredRows: reconcileComplete ? [] : deferredRows,
        loaded: true,
        initialized: true,
        hasMore: result.page.hasMore,
        nextBeforeSubplaceId: result.page.nextBeforeSubplaceId,
        seenBeforeSubplaceIds: requestedCursor
          ? [...new Set([...seenBeforeSubplaceIds, requestedCursor])]
          : seenBeforeSubplaceIds,
        loading: false,
        error: false,
      }, result.parent)
      if (state.snapshot) populateFilters(state.snapshot)
    } catch {
      if (authoredRevision !== requestAuthoredRevision) return
      const latest = state.branches[String(placeId)] || current
      replaceBranch(placeId, { ...latest, loading: false, error: true })
    } finally {
      window.clearTimeout(timeout)
      navigationRevision += 1
      renderAll()
    }
  }

  function branchPage(place, entry, childrenId) {
    const item = element('li', 'branch-page')
    if (entry.error) {
      item.setAttribute('role', 'alert')
      item.append(element('p', '', 'Could not load places inside ' + place.name + '.'))
      const retry = element('button', 'branch-load', 'Retry loading places inside ' + place.name)
      retry.type = 'button'
      retry.dataset.focusKey = 'branch-page:' + String(place.id)
      retry.dataset.focusFallbackKey = 'branch:' + String(place.id)
      retry.setAttribute('aria-busy', 'false')
      retry.setAttribute('aria-controls', childrenId)
      retry.addEventListener('click', () => void loadPlaceBranch(place.id))
      item.append(retry)
      return item
    }
    if (entry.loading && !entry.loaded) {
      item.setAttribute('role', 'status')
      item.append(element('p', '', 'Loading places inside ' + place.name + '…'))
      return item
    }
    if (entry.loaded && entry.hasMore) {
      const load = element('button', 'branch-load', entry.loading
        ? 'Loading more places inside ' + place.name + '…'
        : 'Load more places inside ' + place.name)
      load.type = 'button'
      load.dataset.focusKey = 'branch-page:' + String(place.id)
      load.dataset.focusFallbackKey = 'branch:' + String(place.id)
      load.setAttribute('aria-busy', String(entry.loading))
      load.setAttribute('aria-controls', childrenId)
      load.addEventListener('click', () => void loadPlaceBranch(place.id))
      item.append(load)
      return item
    }
    if (entry.loaded && !entry.rows.length) {
      item.setAttribute('role', 'status')
      item.append(element('p', '', 'No more public places were found inside ' + place.name + '.'))
    }
    return item
  }

  function placeList(values, snapshot, depth) {
    const list = element('ul', 'place-tree')
    if (!Array.isArray(values) || depth >= 32) return list
    for (const place of values) {
      const node = element('li', 'place-node')
      const card = element('article', 'place-card')
      card.dataset.watched = String(state.placeId === place.id)
      const hasChildren = place.places > 0
      const branch = branchEntry(place)
      const expanded = hasChildren && (branch.loaded || branch.loading || branch.error) &&
        !state.collapsedPlaceIds.includes(place.id)
      const watch = element('button', 'place-watch place-name', place.name)
      watch.type = 'button'
      watch.dataset.focusKey = 'watch:' + String(place.id)
      watch.addEventListener('click', () => choosePlace(place.id, true))
      const occupants = residentsAt(snapshot, place.id)
      card.append(
        watch,
        element('span', 'place-owner', place.owner
          ? 'kept by ' + place.owner
          : 'unowned · transit only'),
        element('span', 'place-facts', String(place.places) +
          (place.places === 1 ? ' place inside · ' : ' places inside · ') +
          String(occupants.length) +
          (occupants.length === 1 ? ' resident shown inside · ' : ' residents shown inside · ') +
          String(place.things) + ' things · ' + String(place.notes) + ' notes'),
      )
      if (hasChildren) {
        const childrenId = 'place-children-' + String(place.id)
        const disclosure = element('button', 'place-disclosure', expanded ? 'Collapse inside' : 'Show inside')
        disclosure.type = 'button'
        disclosure.dataset.focusKey = 'branch:' + String(place.id)
        disclosure.setAttribute('aria-expanded', String(expanded))
        disclosure.setAttribute('aria-busy', String(branch.loading && !branch.loaded))
        disclosure.setAttribute('aria-controls', childrenId)
        disclosure.setAttribute('aria-label', (expanded ? 'Collapse' : 'Show') + ' places inside ' + place.name)
        disclosure.addEventListener('click', () => togglePlaceBranch(place.id))
        card.append(disclosure)
      }
      if (occupants.length) card.append(occupantLine(place, occupants))
      node.append(card)
      if (hasChildren) {
        const children = placeList(branch.rows, snapshot, depth + 1)
        children.id = 'place-children-' + String(place.id)
        children.hidden = !expanded
        if (expanded) {
          const page = branchPage(place, branch, children.id)
          if (page.childNodes.length) children.append(page)
        }
        node.append(children)
      }
      list.append(node)
    }
    return list
  }

  function mapRoots(snapshot) {
    const focus = selectedPlace(snapshot)
    if (focus) return [focus]
    const focused = focusedPlace(state.placeId)
    if (focused) return [focused]
    return state.placeId || state.resident ? [] : snapshot.places
  }

  function renderMap(snapshot) {
    if (!nodes.map) return
    const issue = selectionIssue(snapshot, true)
    if (issue) {
      renderSelectionIssue(nodes.map, issue)
      return
    }
    const roots = mapRoots(snapshot)
    if (!roots.length) {
      const missing = state.resident
        ? state.resident + ' is not currently standing in a public place.'
        : 'No public place in the currently loaded view matches this filter.'
      renderEmpty(nodes.map, 'empty-row', missing)
      return
    }
    nodes.map.replaceChildren(placeList(roots, snapshot, 0))
  }

  function residentRequestUrl(entry, minimumMarker) {
    const url = new URL('/api/residents', window.location.origin)
    url.searchParams.set('view', 'presence')
    url.searchParams.set('limit', '25')
    if (entry.initialized && entry.nextBeforeId) {
      url.searchParams.set('before_id', String(entry.nextBeforeId))
    }
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    return url
  }

  async function loadResidents() {
    const current = state.residentPaging
    if (!state.snapshot || current.loading || (!current.hasMore && !current.error)) return
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    navigationRevision += 1
    state = {
      ...state,
      residentPaging: Object.freeze({ ...current, loading: true, error: false }),
    }
    renderAll()

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const requestEntry = state.residentPaging
      const url = residentRequestUrl(requestEntry, requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('public resident page unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision) return
      if (!payload || typeof payload !== 'object') throw new Error('invalid public resident page')
      requireCurrentReadMarker(payload.change_marker, requestMarker)
      const incoming = normalizeResidents(payload.residents)
      const hasMore = payload.has_more === true
      const nextBeforeId = hasMore ? safeId(payload.next_before_id) : null
      const requestedCursor = requestEntry.initialized ? requestEntry.nextBeforeId : null
      const seenBeforeIds = requestEntry.seenBeforeIds || []
      if (hasMore && !residentCursorProgressed(
        requestedCursor,
        nextBeforeId,
        seenBeforeIds,
        incoming,
        state.snapshot.residents,
      )) throw new Error('public resident cursor did not progress')
      const deferredResidents = requestEntry.deferredResidents || []
      const reachedDeferred = incoming.some(row =>
        deferredResidents.some(deferred => deferred.id === row.id))
      const visibleResidents = mergeResidentRows(state.snapshot.residents, incoming)
      const reconcileComplete = reachedDeferred || !hasMore
      const residents = reconcileComplete
        ? mergeResidentRows(deferredResidents, visibleResidents)
        : visibleResidents
      const advertisedTotal = safeCount(payload.total)
      const base = Object.freeze({
        ...state.snapshot,
        totals: Object.freeze({
          ...state.snapshot.totals,
          residents: Math.max(state.snapshot.totals.residents, advertisedTotal, residents.length),
        }),
      })
      const snapshot = withNavigation(base, state.branches, residents)
      state = {
        ...state,
        snapshot,
        residentPaging: Object.freeze({
          initialized: true,
          hasMore,
          nextBeforeId,
          deferredResidents: reconcileComplete ? [] : deferredResidents,
          seenBeforeIds: requestedCursor
            ? [...new Set([...seenBeforeIds, requestedCursor])]
            : seenBeforeIds,
          loading: false,
          error: false,
        }),
      }
      populateFilters(snapshot)
    } catch {
      if (authoredRevision !== requestAuthoredRevision) return
      state = {
        ...state,
        residentPaging: Object.freeze({ ...state.residentPaging, loading: false, error: true }),
      }
    } finally {
      window.clearTimeout(timeout)
      navigationRevision += 1
      renderAll()
    }
  }

  function renderResidentPage() {
    if (!nodes.residentPage) return
    const entry = state.residentPaging
    if (!entry.hasMore && !entry.loading && !entry.error) {
      nodes.residentPage.hidden = true
      nodes.residentPage.replaceChildren()
      return
    }
    const parts = []
    if (entry.error) {
      const message = element('p', 'navigation-error', 'Could not load more residents.')
      message.setAttribute('role', 'alert')
      parts.push(message)
    }
    const text = entry.loading
      ? 'Loading more residents…'
      : entry.error ? 'Retry loading residents' : 'Load more residents'
    const button = element('button', 'resident-load', text)
    button.type = 'button'
    button.dataset.focusKey = 'resident-page'
    button.dataset.focusFallbackKey = state.snapshot?.residents[0]
      ? 'roster:' + state.snapshot.residents[0].handle
      : ''
    button.dataset.focusFallbackId = 'resident-roster'
    button.setAttribute('aria-busy', String(entry.loading))
    button.setAttribute('aria-controls', 'resident-roster')
    button.addEventListener('click', () => void loadResidents())
    parts.push(button)
    nodes.residentPage.hidden = false
    nodes.residentPage.replaceChildren(...parts)
  }

  function renderRoster(snapshot) {
    if (!nodes.roster) return
    renderResidentPage()
    const issue = state.resident ? selectionIssue(snapshot, false) : null
    if (issue?.kind === 'resident') {
      renderSelectionIssue(nodes.roster, issue)
      return
    }
    const selectedPlaceIds = state.placeId ? placeScopeSet(state.placeId, snapshot) : null
    const availableResidents = displayedResidents(snapshot)
    const visible = availableResidents.filter(resident =>
      (!state.resident || resident.handle === state.resident) &&
      (!selectedPlaceIds || selectedPlaceIds.has(resident.current_place_id)))
    if (!visible.length) {
      const empty = element('p', 'empty-row', snapshot.residents.length
        ? 'Watching. No currently loaded resident matches this view.'
        : 'Watching. No residents are loaded in this view.')
      empty.setAttribute('role', 'status')
      nodes.roster.replaceChildren(empty)
      return
    }
    const groups = [...new Set(visible.map(resident => resident.current_place_id))]
    const fragment = document.createDocumentFragment()
    for (const placeId of groups) {
      const group = element('section', 'roster-group')
      const place = placeReference(snapshot, placeId)
      group.append(element('p', 'roster-place', place
        ? place.path
        : placeId
          ? state.focusedPlaces[String(placeId)]?.notFound
            ? 'Place #' + String(placeId) + ' · no public place was found'
            : state.focusedPlaces[String(placeId)]?.error
              ? 'Place #' + String(placeId) + ' · public place could not be loaded'
              : 'Place #' + String(placeId) + ' · loading public place…'
          : 'Between places'))
      const standing = visible.filter(candidate => candidate.current_place_id === placeId)
      for (const resident of [...standing.filter(r => !r.asleep), ...standing.filter(r => r.asleep)]) {
        const row = element('div', resident.asleep ? 'resident-row asleep' : 'resident-row')
        const follow = element('button', 'resident-follow', resident.handle)
        follow.type = 'button'
        follow.dataset.focusKey = 'roster:' + resident.handle
        follow.addEventListener('click', () => chooseResident(resident.handle))
        row.append(follow, element('span', 'resident-number',
          'resident #' + String(resident.id) + (resident.asleep ? ' · asleep' : '')))
        group.append(row)
      }
      fragment.append(group)
    }
    nodes.roster.replaceChildren(fragment)
  }

  function renderPeople(target, residents, placeOf) {
    if (!target) return
    if (!residents.length) {
      renderEmpty(target, 'empty-row', 'No included resident matching this view is standing inside this place.')
      return
    }
    const list = element('ul', 'person-list')
    list.append(...[...residents.filter(r => !r.asleep), ...residents.filter(r => r.asleep)].map(resident => {
      const item = element('li', resident.asleep ? 'person-card asleep' : 'person-card')
      const follow = element('button', 'resident-follow', resident.handle)
      follow.type = 'button'
      follow.dataset.focusKey = 'person:' + resident.handle
      follow.addEventListener('click', () => chooseResident(resident.handle))
      const location = windowPlaceLabel(
        resident.current_place_id,
        placeOf ? placeOf(resident.current_place_id) : null,
      )
      item.append(follow, element('span', 'resident-number',
        'resident #' + String(resident.id) + (resident.asleep ? ' · asleep' : '') +
        (location ? ' · at ' + location : '')))
      return item
    }))
    target.replaceChildren(list)
  }

  // Context neighbours are picked by position in the room, never by clock, so
  // a quiet room can put a day between a note and the one before it. Say the
  // real distance rather than implying a closeness the rule never promised.
  function relativeGap(fromIso, toIso) {
    const difference = new Date(fromIso).getTime() - new Date(toIso).getTime()
    if (!Number.isFinite(difference)) return 'same room'
    const direction = difference < 0 ? ' earlier' : ' later'
    const minutes = Math.round(Math.abs(difference) / 60000)
    if (minutes < 1) return 'same room · moments apart'
    if (minutes < 60) return 'same room · ' + String(minutes) + 'm' + direction
    const hours = Math.round(minutes / 60)
    if (hours < 48) return 'same room · ' + String(hours) + 'h' + direction
    return 'same room · ' + String(Math.round(hours / 24)) + 'd' + direction
  }

  // A handle earns a button when any public source can resolve it. The complete
  // directory deliberately knows more names than the bounded presence page.
  function residentNode(handle, className, focusKey) {
    const known = state.snapshot && residentReference(state.snapshot, handle)
    if (!known) return element('span', className, handle)
    const follow = element('button', className + ' resident-follow-inline', handle)
    follow.type = 'button'
    follow.dataset.focusKey = focusKey
    follow.title = 'Follow ' + handle
    follow.addEventListener('click', () => chooseResident(handle))
    return follow
  }

  function openDetailLink(kind, id, label, className) {
    const link = element('a', className || 'detail-link', label)
    link.href = '/window/' + kind + '/' + String(id)
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigate({ detail: Object.freeze({ kind, id }) })
    })
    return link
  }

  function normalizeDetailRecord(kind, id, payload) {
    const raw = payload && typeof payload === 'object' ? payload[kind] : null
    if (!raw || typeof raw !== 'object' || safeId(raw.id) !== id) return null
    const placeId = safeId(raw.place_id)
    const body = safeText(raw.body, null, kind === 'note' ? 4000 : 65536, kind === 'thing')
    if (!placeId || body === null) return null
    if (kind === 'note') {
      const author = safeHandle(raw.author)
      const createdAt = safeDate(raw.created_at)
      return author && createdAt ? Object.freeze({
        kind, id, placeId, author, body, createdAt, moderated: raw.moderated === true,
      }) : null
    }
    const name = safeText(raw.name, '', 120, false)
    const madeBy = safeHandle(raw.made_by)
    const currentOwner = safeHandle(raw.current_owner)
    return name && madeBy && currentOwner ? Object.freeze({
      kind, id, placeId, name, madeBy, currentOwner, body,
      moderated: raw.moderated === true,
    }) : null
  }

  async function ensureDetail(force) {
    const target = state.detail
    if (!target || target.kind === 'place') return
    const key = target.kind + ':' + String(target.id)
    const current = state.details[key]
    if (current?.loading || (!force && (current?.record || current?.notFound))) return
    const requestAuthoredRevision = authoredRevision
    const requestDetailRevision = ++detailRequestRevision
    const requestIsCurrent = () => (
      authoredRevision === requestAuthoredRevision &&
      detailRequestRevision === requestDetailRevision &&
      state.detail?.kind === target.kind &&
      state.detail?.id === target.id
    )
    state = {
      ...state,
      details: {
        ...state.details,
        [key]: Object.freeze({ loading: true, error: false, notFound: false, record: null }),
      },
    }
    renderDetail()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/' + target.kind + '/' + String(target.id), window.location.origin)
      const response = await fetch(url.pathname, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!requestIsCurrent()) return
      if (response.status === 404) {
        state = {
          ...state,
          details: {
            ...state.details,
            [key]: Object.freeze({ loading: false, error: false, notFound: true, record: null }),
          },
        }
        return
      }
      if (!response.ok) throw new Error('public detail unavailable')
      const record = normalizeDetailRecord(target.kind, target.id, await response.json())
      if (!requestIsCurrent()) return
      if (!record) throw new Error('invalid public detail')
      state = {
        ...state,
        details: {
          ...state.details,
          [key]: Object.freeze({ loading: false, error: false, notFound: false, record }),
        },
      }
    } catch {
      if (!requestIsCurrent()) return
      state = {
        ...state,
        details: {
          ...state.details,
          [key]: Object.freeze({ loading: false, error: true, notFound: false, record: null }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (requestIsCurrent()) renderDetail()
    }
  }

  function renderDetail() {
    const target = state.detail
    if (!nodes.detail) return
    if (!target || target.kind === 'place') {
      if (nodes.detail.open) nodes.detail.close()
      return
    }
    const key = target.kind + ':' + String(target.id)
    const entry = state.details[key]
    if (nodes.detailKind) nodes.detailKind.textContent = target.kind === 'thing'
      ? 'Public thing · live current record'
      : 'Public note · live current record'
    if (nodes.detailTitle) nodes.detailTitle.textContent = target.kind === 'thing'
      ? entry?.record?.name || 'Thing #' + String(target.id)
      : 'Public note #' + String(target.id)
    if (nodes.detailBody) {
      if (!entry || entry.loading) {
        nodes.detailBody.replaceChildren(element('p', 'loading-row', 'Reading the live public record…'))
      } else if (entry.notFound) {
        nodes.detailBody.replaceChildren(element(
          'p', 'empty-row', 'This public ' + target.kind + ' is not available now.',
        ))
      } else if (entry.error || !entry.record) {
        const message = element('p', 'error-row', 'This public detail could not be read.')
        const retry = element('button', 'detail-retry', 'Retry reading this detail')
        retry.type = 'button'
        retry.addEventListener('click', () => void ensureDetail(true))
        nodes.detailBody.replaceChildren(message, retry)
      } else {
        const record = entry.record
        const meta = record.kind === 'thing'
          ? 'made by ' + record.madeBy + ' · currently owned by ' + record.currentOwner +
            ' · place #' + String(record.placeId)
          : 'by ' + record.author + ' · place #' + String(record.placeId) + ' · ' +
            new Date(record.createdAt).toLocaleString()
        const body = element('p', 'record-detail-text public-body', record.body)
        nodes.detailBody.replaceChildren(element('p', 'record-detail-meta', meta), body)
        if (record.moderated) {
          nodes.detailBody.append(element(
            'p', 'moderated-mark', 'Maintainer removal is shown as a current tombstone.',
          ))
        }
      }
    }
    if (!nodes.detail.open) nodes.detail.showModal()
  }

  async function loadFullBody(kind, id) {
    if (kind !== 'note' && kind !== 'thing') return
    const bodyKey = kind + ':' + String(id)
    const current = state.fullBodies[bodyKey] || Object.freeze({
      body: null, loading: false, error: false,
    })
    if (current.loading || current.body !== null) return
    const requestAuthoredRevision = authoredRevision
    state = {
      ...state,
      fullBodies: {
        ...state.fullBodies,
        [bodyKey]: Object.freeze({ ...current, loading: true, error: false }),
      },
    }
    renderAll()

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/' + kind + '/' + String(id), window.location.origin)
      const response = await fetch(url.pathname, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('complete public body unavailable')
      const payload = await response.json()
      const record = payload && typeof payload === 'object' ? payload[kind] : null
      const recordId = record && typeof record === 'object' ? safeId(record.id) : null
      const fullBody = record && typeof record === 'object'
        ? safeText(record.body, null, kind === 'note' ? 4000 : 65536, kind === 'thing')
        : null
      if (recordId !== id || fullBody === null) throw new Error('invalid complete public body')
      if (authoredRevision !== requestAuthoredRevision) return
      state = {
        ...state,
        expandedBodies: state.expandedBodies.includes(bodyKey)
          ? state.expandedBodies
          : [...state.expandedBodies, bodyKey],
        fullBodies: {
          ...state.fullBodies,
          [bodyKey]: Object.freeze({ body: fullBody, loading: false, error: false }),
        },
      }
    } catch {
      if (authoredRevision !== requestAuthoredRevision) return
      state = {
        ...state,
        fullBodies: {
          ...state.fullBodies,
          [bodyKey]: Object.freeze({ body: null, loading: false, error: true }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      renderAll()
    }
  }

  function bodyDisclosureLabel(kind, truncated, expanded, hasFullBody, fullEntry) {
    const canComplete = truncated && !hasFullBody && (kind === 'note' || kind === 'thing')
    if (canComplete && expanded) {
      if (fullEntry?.loading) return 'Loading the whole ' + kind + '…'
      if (fullEntry?.error) return 'Retry reading the whole ' + kind
      return 'Read the whole ' + kind
    }
    return expanded ? 'Show less' : 'Show more'
  }

  function renderExpandableBody(kind, id, body, truncated) {
    const block = element('div', 'body-block')
    const bodyKey = kind + ':' + String(id)
    const fullEntry = state.fullBodies[bodyKey] || null
    const hasFullBody = typeof fullEntry?.body === 'string'
    const bodyNode = element('p', kind + '-body public-body',
      hasFullBody ? fullEntry.body : body + (truncated ? '…' : ''))
    const bodyId = 'public-body-' + kind + '-' + String(id) + '-' + String(++bodyIdSequence)
    const startExpanded = state.expandedBodies.includes(bodyKey)
    bodyNode.id = bodyId
    bodyNode.dataset.expanded = String(startExpanded)
    bodyNode.dataset.bodyKey = bodyKey
    bodyNode.dataset.bodyKind = kind
    bodyNode.dataset.truncated = String(truncated)
    block.append(bodyNode)

    let availability = null
    if (truncated && !hasFullBody) {
      // The bounded view caps every body: Excerpt only — this bounded view carries only the first part.
      // "Show more" first reveals that excerpt. The existing single-record endpoint is then one deliberate,
      // anonymous read whose result survives re-rendering in this browser session.
      availability = element('p', 'body-availability')
      const availabilityText = fullEntry?.loading
        ? 'Loading the complete public ' + kind + '… '
        : fullEntry?.error
          ? 'The complete public ' + kind + ' could not be read. '
          : 'Excerpt only — the full text is not included in this bounded view. '
      availability.append(document.createTextNode(availabilityText))
      if (kind === 'agreement') {
        availability.append(document.createTextNode(
          'The full text is not served through the glass.'))
      }
      availability.id = bodyId + '-availability'
      block.append(availability)
    }

    // The browser decides whether the five-line clamp actually hides text.
    // Keep the control hidden until the connected element can be measured.
    const disclosure = element('button', truncated && (kind === 'note' || kind === 'thing')
      ? 'body-disclosure body-full-link'
      : 'body-disclosure',
      bodyDisclosureLabel(kind, truncated, startExpanded, hasFullBody, fullEntry))
    disclosure.type = 'button'
    disclosure.hidden = true
    disclosure.setAttribute('aria-expanded', String(startExpanded))
    disclosure.setAttribute('aria-busy', String(fullEntry?.loading === true))
    disclosure.setAttribute('aria-controls', bodyId)
    disclosure.dataset.focusKey = 'body:' + bodyKey
    if (availability) disclosure.setAttribute('aria-describedby', availability.id)
    disclosure.addEventListener('click', () => {
      const expanded = state.expandedBodies.includes(bodyKey)
      const canComplete = truncated && !hasFullBody &&
        (kind === 'note' || kind === 'thing') && expanded
      if (canComplete) {
        void loadFullBody(kind, id)
        return
      }
      const nextExpanded = !expanded
      state = {
        ...state,
        expandedBodies: nextExpanded
          ? [...state.expandedBodies, bodyKey]
          : state.expandedBodies.filter(key => key !== bodyKey),
      }
      bodyNode.dataset.expanded = String(nextExpanded)
      disclosure.setAttribute('aria-expanded', String(nextExpanded))
      disclosure.textContent = bodyDisclosureLabel(
        kind, truncated, nextExpanded, hasFullBody, fullEntry)
    })
    block.append(disclosure)
    return block
  }

  function syncBodyDisclosures() {
    const entries = []
    for (const block of document.querySelectorAll('.body-block')) {
      if (block.closest('[hidden]')) continue
      const bodyNode = block.querySelector('.public-body')
      const disclosure = block.querySelector('.body-disclosure')
      const bodyKey = bodyNode?.dataset.bodyKey
      const kind = bodyNode?.dataset.bodyKind
      if (!bodyNode || !disclosure || !bodyKey || !kind) continue
      bodyNode.dataset.expanded = 'false'
      entries.push({
        bodyNode,
        disclosure,
        bodyKey,
        kind,
        truncated: bodyNode.dataset.truncated === 'true',
      })
    }

    const collapsedHeights = entries.map(entry => entry.bodyNode.getBoundingClientRect().height)
    for (const entry of entries) entry.bodyNode.dataset.expanded = 'true'
    const expandedHeights = entries.map(entry => entry.bodyNode.getBoundingClientRect().height)

    entries.forEach((entry, index) => {
      const collapsible = expandedHeights[index] > collapsedHeights[index] + 1
      const fullEntry = state.fullBodies[entry.bodyKey] || null
      const hasFullBody = typeof fullEntry?.body === 'string'
      const requiresCompletion = entry.truncated && !hasFullBody &&
        (entry.kind === 'note' || entry.kind === 'thing')
      const expanded = (collapsible || requiresCompletion) &&
        state.expandedBodies.includes(entry.bodyKey)
      entry.bodyNode.dataset.expanded = String(!collapsible || expanded)
      entry.disclosure.hidden = !collapsible && !requiresCompletion
      entry.disclosure.setAttribute('aria-expanded', String(expanded))
      entry.disclosure.setAttribute('aria-busy', String(fullEntry?.loading === true))
      entry.disclosure.textContent = bodyDisclosureLabel(
        entry.kind, entry.truncated, expanded, hasFullBody, fullEntry)
    })
  }

  let bodyDisclosureFrame = 0
  function scheduleBodyDisclosureSync() {
    if (bodyDisclosureFrame) return
    bodyDisclosureFrame = window.requestAnimationFrame(() => {
      bodyDisclosureFrame = 0
      syncBodyDisclosures()
    })
  }

  function renderThings(target, things, placeOf) {
    if (!target) return
    if (!things.length) {
      renderEmpty(target, 'empty-row', 'No public thing matches this selection.')
      return
    }
    const list = element('ul', 'thing-list')
    list.append(...things.map(thing => {
      const item = element('li', 'thing-card')
      const thingMeta = element('p', 'thing-meta')
      thingMeta.append(document.createTextNode('made by '))
      thingMeta.append(thing.made_by
        ? residentNode(thing.made_by, 'thing-maker', 'thing-maker:' + String(thing.id))
        : document.createTextNode('maker unavailable'))
      thingMeta.append(
        document.createTextNode(' · currently owned by '),
        residentNode(thing.current_owner, 'thing-owner', 'thing-owner:' + String(thing.id)),
        document.createTextNode(
          (thing.kind ? ' · kind: ' + thing.kind : ' · one of a kind') +
          (thing.open_to_use ? ' · open to shared use' : ' · owner use only')),
      )
      const location = windowPlaceLabel(
        thing.place_id,
        placeOf ? placeOf(thing.place_id) : null,
      )
      if (location) {
        thingMeta.append(
          document.createTextNode(' · at '),
          element('span', 'thing-location', location),
        )
      }
      const heading = element('h4', '')
      heading.append(openDetailLink(
        'thing', thing.id, thing.name, 'detail-link thing-detail-link',
      ))
      item.append(heading, thingMeta)
      if (thing.body) item.append(renderExpandableBody('thing', thing.id, thing.body, thing.truncated))
      const traits = element('div', 'trait-list')
      if (thing.traits.length) {
        traits.append(...thing.traits.map(trait => {
          const chip = element('span', 'trait-chip', trait)
          chip.dataset.moderated = String(trait === MODERATED_TEXT)
          return chip
        }))
      } else {
        traits.append(element('span', 'thing-meta', 'no public traits'))
      }
      item.append(traits)
      if (thing.moderated || thing.kind_moderated) {
        item.append(element('span', 'moderated-mark', 'Maintainer removal shown as a tombstone'))
      }
      return item
    }))
    target.replaceChildren(list)
  }

  function noteCard(note, place) {
    const card = element('article', 'note-card')
    const meta = element('p', 'note-meta')
    meta.append(
      residentNode(note.author, 'note-author', 'note-author:' + String(note.id)),
      document.createTextNode(' · '),
      timeNode(note.created_at, ''),
    )
    const location = windowPlaceLabel(note.place_id, place)
    if (location) {
      meta.append(
        document.createTextNode(' · '),
        element('span', 'note-location', location),
      )
    }
    meta.append(
      document.createTextNode(' · '),
      openDetailLink(
        'note', note.id, 'Open note #' + String(note.id), 'detail-link note-detail-link',
      ),
    )
    card.append(meta, renderExpandableBody('note', note.id, note.body, note.truncated))
    if (note.moderated) card.append(element('span', 'moderated-mark', 'Removed text retained as a tombstone'))
    return card
  }

  function renderNotes(target, notes, emptyMessage, placeOf) {
    if (!target) return
    if (!notes.length) {
      renderEmpty(target, 'empty-row', emptyMessage)
      return
    }
    const list = element('div', 'note-list')
    list.append(...notes.map(note => noteCard(
      note,
      typeof placeOf === 'function' ? placeOf(note.place_id) : placeOf,
    )))
    target.replaceChildren(list)
  }

  function renderHistoryOutcome(target, entry, messages, itemTag) {
    if (!target || entry.rows.length) return false
    const waiting = entry.loading || entry.refreshing ||
      (!entry.initialized && !entry.error && !entry.refreshError)
    const failed = entry.error || entry.refreshError
    const message = waiting
      ? messages.loading
      : failed
        ? messages.failure
        : messages.empty
    const className = failed ? 'error-row' : waiting ? 'loading-row' : 'empty-row'
    target.replaceChildren(element(itemTag || 'p', className, message))
    return true
  }

  function hideHistoryControl(target) {
    if (!target) return
    target.hidden = true
    target.replaceChildren()
  }

  function renderOccupants(snapshot, place) {
    const occupants = residentsAt(snapshot, place.id)
    const completePresence = displayedResidents(snapshot).length >= snapshot.totals.residents
    if (occupants.length) {
      renderPeople(nodes.occupants, occupants,
        placeId => placeReference(snapshot, placeId))
    } else {
      renderEmpty(nodes.occupants, 'empty-row', completePresence
        ? 'No public resident is standing inside this place.'
        : 'No resident from the bounded presence view is shown inside this place.')
    }
    if (!completePresence && nodes.occupants) {
      nodes.occupants.append(element('p', 'presence-boundary',
        'Other occupants may be omitted: no narrow place-specific presence read exists yet.'))
    }
  }

  function renderPlaceOrientation(place) {
    if (nodes.placePurposeLabel) nodes.placePurposeLabel.textContent = 'Owner-written purpose'
    if (nodes.placeFrontMatterLabel) {
      nodes.placeFrontMatterLabel.textContent = 'Owner-chosen front matter'
    }
    if (!place) {
      renderEmpty(nodes.placePurpose, 'empty-row', 'No loaded place purpose is available.')
      renderEmpty(nodes.placeFrontMatter, 'empty-row', 'No loaded front matter is available.')
      return
    }
    if (nodes.placePurpose) {
      nodes.placePurpose.replaceChildren(element(
        'p',
        place.purpose ? 'place-purpose-text' : 'empty-row',
        place.purpose || 'No owner-written purpose is set for this place.',
      ))
    }
    if (!nodes.placeFrontMatter) return
    if (!place.front_matter.length) {
      renderEmpty(
        nodes.placeFrontMatter,
        'empty-row',
        'No owner-chosen front matter is available.',
      )
      return
    }
    const list = element('ol', 'front-matter-list')
    list.setAttribute('aria-labelledby', 'place-front-matter-title')
    list.append(...place.front_matter.map(heading => {
      const item = element('li', 'front-matter-heading')
      const link = openDetailLink(
        'thing', heading.id, heading.name, 'front-matter-link detail-link',
      )
      const meta = element('p', 'front-matter-meta thing-meta')
      meta.append(
        document.createTextNode('made by '),
        residentNode(heading.made_by, 'thing-maker', 'front-matter-maker:' + String(heading.id)),
        document.createTextNode(' · currently owned by '),
        residentNode(
          heading.current_owner,
          'thing-owner',
          'front-matter-owner:' + String(heading.id),
        ),
        document.createTextNode(' · ' + String(heading.body_text_bytes) + ' UTF-8 bytes'),
      )
      item.append(link, meta)
      return item
    }))
    nodes.placeFrontMatter.replaceChildren(list)
  }

  function renderPlace(snapshot) {
    const followed = selectedResident(snapshot)
    const place = selectedPlace(snapshot) ||
      (!state.resident && !state.placeId ? snapshot.flatPlaces[0] || null : null)
    if (!place) {
      const issue = selectionIssue(snapshot, true)
      if (issue) {
        const issueTitle = issue.status === 'not-found'
          ? issue.kind === 'resident' ? 'No public resident was found' : 'No public place was found'
          : issue.status === 'error'
            ? issue.kind === 'resident' ? 'Public resident could not be loaded' : 'Public place could not be loaded'
            : issue.kind === 'resident' ? 'Loading public resident…' : 'Loading public place…'
        if (nodes.placeTitle) nodes.placeTitle.textContent = issueTitle
        if (nodes.placeSummary) nodes.placeSummary.textContent = issue.status === 'not-found'
          ? issueTitle + ' for this selection.'
          : issue.status === 'error'
            ? issueTitle + '. Use Retry to try the focused read again.'
            : issueTitle + ' The requested content will follow that focused read.'
        if (nodes.placePurpose) {
          renderSelectionIssue(nodes.placePurpose, issue, null, 'place-focus-title')
        }
        renderEmpty(nodes.placeFrontMatter, issue.status === 'error' ? 'error-row' :
          issue.status === 'not-found' ? 'empty-row' : 'loading-row',
        issue.status === 'not-found'
          ? issueTitle + ' for this selection.'
          : issue.status === 'error'
            ? 'Front matter is unavailable until the focused read succeeds.'
            : 'Loading public front matter…')
        for (const target of [nodes.occupants, nodes.placeThings, nodes.placeConversation]) {
          renderEmpty(target, issue.status === 'error' ? 'error-row' :
            issue.status === 'not-found' ? 'empty-row' : 'loading-row',
          issue.status === 'not-found'
            ? issueTitle + ' for this selection.'
            : issue.status === 'error'
              ? 'This section is unavailable until the focused read succeeds.'
              : 'Waiting for the focused read…')
        }
        hideHistoryControl(nodes.placeThingsPage)
        hideHistoryControl(nodes.placeNotesPage)
        return
      }
      if (followed?.current_place_id === null) {
        if (nodes.placeTitle) nodes.placeTitle.textContent = followed.handle + ' is between places'
        if (nodes.placeSummary) {
          nodes.placeSummary.textContent = 'This resident is not currently standing in a public place.'
        }
        renderPlaceOrientation(null)
        renderEmpty(nodes.occupants, 'empty-row', 'There is no doorway around this resident right now.')
        renderEmpty(nodes.placeThings, 'empty-row', 'No current public place is available for visible things.')
        renderEmpty(nodes.placeConversation, 'empty-row', 'No current public place is available for conversation.')
        hideHistoryControl(nodes.placeThingsPage)
        hideHistoryControl(nodes.placeNotesPage)
        return
      }
      if (nodes.placeTitle) nodes.placeTitle.textContent = 'No public place is selected'
      if (nodes.placeSummary) nodes.placeSummary.textContent = 'Choose a public place to inspect it.'
      renderPlaceOrientation(null)
      renderEmpty(nodes.occupants, 'empty-row', 'No public place is selected for occupants.')
      renderEmpty(nodes.placeThings, 'empty-row', 'No public place is selected for visible things.')
      renderEmpty(nodes.placeConversation, 'empty-row', 'No public place is selected for conversation.')
      hideHistoryControl(nodes.placeThingsPage)
      hideHistoryControl(nodes.placeNotesPage)
      return
    }
    if (nodes.placeTitle) nodes.placeTitle.textContent = place.name
    if (nodes.placeSummary) nodes.placeSummary.textContent = place.path + (place.owner
      ? ' · kept by ' + place.owner
      : ' · nobody owns it · transit only') +
      (state.placeId ? ' · showing this place and everything inside it' : '')
    renderPlaceOrientation(place)
    renderOccupants(snapshot, place)
    const filters = Object.freeze({ placeId: place.id, resident: state.resident })
    autoLoadFilteredHistory('things', filters, historyEntry('things', filters))
    autoLoadFilteredHistory('notes', filters, historyEntry('notes', filters))
    const thingsEntry = historyEntry('things', filters)
    const notesEntry = historyEntry('notes', filters)
    if (!renderHistoryOutcome(nodes.placeThings, thingsEntry, Object.freeze({
      loading: 'Fetching things that match this place…',
      failure: 'Things could not be loaded. Retry below.',
      empty: 'No public thing matches this selection.',
    }))) {
      renderThings(nodes.placeThings, thingsEntry.rows,
        placeId => placeReference(snapshot, placeId))
    }
    if (!renderHistoryOutcome(nodes.placeConversation, notesEntry, Object.freeze({
      loading: 'Fetching conversation that matches this place…',
      failure: 'Conversation could not be loaded. Retry below.',
      empty: 'No public conversation matches this place selection.',
    }))) {
      renderNotes(nodes.placeConversation, notesEntry.rows,
        'No public conversation matches this place selection.',
        placeId => placeReference(snapshot, placeId))
    }
    renderHistoryControl(nodes.placeThingsPage, 'things', 'things', filters)
    renderHistoryControl(nodes.placeNotesPage, 'notes', 'notes', filters)
  }

  function renderConversationMode() {
    if (!nodes.conversationMode) return
    if (!state.resident) {
      nodes.conversationMode.hidden = true
      nodes.conversationMode.replaceChildren()
      return
    }
    const question = element('p', 'conversation-question', state.conversationContext
      ? 'Question: What was said around ' + state.resident + '?'
      : 'Question: What did ' + state.resident + ' say?')
    const choices = element('div', 'conversation-choices')
    const residentOnly = element('button', 'conversation-mode-button',
      'What ' + state.resident + ' said')
    residentOnly.type = 'button'
    residentOnly.setAttribute('aria-pressed', String(!state.conversationContext))
    residentOnly.dataset.focusKey = 'conversation-mode:resident'
    residentOnly.addEventListener('click', () => navigate({ conversationContext: false }))
    const roomContext = element('button', 'conversation-mode-button',
      'What was said around ' + state.resident)
    roomContext.type = 'button'
    roomContext.setAttribute('aria-pressed', String(state.conversationContext))
    roomContext.dataset.focusKey = 'conversation-mode:context'
    roomContext.addEventListener('click', () => navigate({ conversationContext: true }))
    choices.append(residentOnly, roomContext)
    nodes.conversationMode.hidden = false
    nodes.conversationMode.replaceChildren(question, choices)
  }

  function renderConversations(snapshot) {
    if (!nodes.conversations) return
    renderConversationMode()
    // Following one resident defaults to only their authored notes. Room
    // context remains a separate, labelled question with its own cache key.
    const filters = Object.freeze({
      placeId: state.placeId,
      resident: state.resident,
      context: Boolean(state.resident && state.conversationContext),
    })
    const issue = selectionIssue(snapshot, false)
    if (issue) {
      renderSelectionIssue(nodes.conversations, issue)
      hideHistoryControl(nodes.conversationPage)
      return
    }
    const place = state.placeId
      ? placeReference(snapshot, state.placeId)
      : null
    autoLoadFilteredHistory('notes', filters, historyEntry('notes', filters))
    const entry = historyEntry('notes', filters)
    const notes = entry.rows
    const placeOf = placeId => placeReference(snapshot, placeId)
    if (renderHistoryOutcome(nodes.conversations, entry, Object.freeze({
      loading: 'Fetching this conversation…',
      failure: 'Conversation could not be loaded. Retry below.',
      empty: 'No public conversation matches this selection.',
    }))) {
      renderHistoryControl(nodes.conversationPage, 'notes', 'conversations', filters)
      return
    }
    if (place && !state.resident) {
      const group = element('section', 'conversation-group')
      const heading = element('header', '')
      heading.append(
        element('h3', '', 'Inside ' + place.name),
        element('span', 'place-facts', place.path + ' · ' + String(notes.length) + ' shown'),
      )
      const list = element('div', 'note-list')
      list.append(...notes.map(note => noteCard(note, placeReference(snapshot, note.place_id))))
      group.append(heading, list)
      nodes.conversations.replaceChildren(group)
    } else {
      // The server pages notes newest first, so retain that order and name each
      // room without regrouping. Only the explicit room-context question marks
      // neighbours; the resident-only default contains authored notes alone.
      const ownNotes = notes.filter(note => note.author === state.resident)
      const nearestOwn = note => ownNotes.reduce((closest, own) => {
        if (own.place_id !== note.place_id) return closest
        if (!closest) return own
        const candidate = Math.abs(new Date(own.created_at).getTime() - new Date(note.created_at).getTime())
        const held = Math.abs(new Date(closest.created_at).getTime() - new Date(note.created_at).getTime())
        return candidate < held ? own : closest
      }, null)
      const list = element('div', 'note-list')
      list.append(...notes.map(note => {
        const card = noteCard(note, placeOf(note.place_id))
        if (filters.context && note.author !== state.resident) {
          const anchor = nearestOwn(note)
          card.classList.add('context-note')
          card.append(element('span', 'context-mark', anchor
            ? relativeGap(note.created_at, anchor.created_at)
            : 'same room'))
        }
        return card
      }))
      nodes.conversations.replaceChildren(list)
    }
    renderHistoryControl(nodes.conversationPage, 'notes', 'conversations', filters)
  }

  function eventPlaceId(event, snapshot) {
    if (event.detail.to_place_id) return event.detail.to_place_id
    if (event.detail.place_id) return event.detail.place_id
    if (!snapshot) return null
    if (event.detail.thing_id) {
      return snapshot.things.find(thing => thing.id === event.detail.thing_id)?.place_id || null
    }
    if (event.detail.note_id) {
      return snapshot.notes.find(note => note.id === event.detail.note_id)?.place_id || null
    }
    return null
  }

  function actionVerb(action) {
    return {
      talk: 'talked',
      move: 'moved',
      use: 'used',
      give: 'gave',
      consume: 'consumed',
      make: 'made',
      go_home: 'went home',
    }[action] || action
  }

  function actionAttempt(action) {
    return action === 'go_home' ? 'go home' : action
  }

  function activitySemantics(event, snapshot) {
    const placeId = eventPlaceId(event, snapshot)
    const place = placeReference(snapshot, placeId)
    const location = windowPlaceLabel(placeId, place)
    let description = event.verb
    if (event.kind === 'action' && event.detail.action) {
      const applied = !event.detail.status || event.detail.status === 'applied'
      description = applied
        ? actionVerb(event.detail.action)
        : 'tried to ' + actionAttempt(event.detail.action)
      if ((event.detail.action === 'move' || event.detail.action === 'go_home') &&
          event.detail.from_place_id && event.detail.to_place_id) {
        const from = windowPlaceLabel(
          event.detail.from_place_id,
          placeReference(snapshot, event.detail.from_place_id),
        )
        const to = windowPlaceLabel(
          event.detail.to_place_id,
          placeReference(snapshot, event.detail.to_place_id),
        )
        if (from && to) description += ' from ' + from + ' to ' + to
      }
      if (event.detail.status) {
        description += ' · ' + (event.detail.status === 'noop'
          ? 'no change'
          : event.detail.status)
      }
      if (event.detail.status === 'blocked' || event.detail.status === 'failed') {
        description += ' — ' + eventCause(event.detail)
      }
    } else if (event.kind === 'effect_resolved' && event.detail.status) {
      description += ' · ' + event.detail.status
      if (event.detail.status === 'skipped' || event.detail.status === 'failed') {
        description += ' — ' + eventCause(event.detail)
      }
    } else if (event.kind === 'gazette_printed') {
      const submissions = event.detail.entry_count === 1 ? 'submission' : 'submissions'
      description += ' · Issue ' + String(event.detail.issue_number) +
        ' · ' + String(event.detail.entry_count) + ' ' + submissions + ' from Room #454'
    }
    return Object.freeze({
      description,
      location,
      key: event.actor + '|' + description + '|' + String(location || ''),
    })
  }

  function eventCause(detail) {
    const cause = detail.error || 'no cause was recorded'
    return detail.error_truncated
      ? cause + ' (cause excerpt; the rest is not shown in this window)'
      : cause
  }

  function collapseActivity(events, snapshot) {
    return events.reduce((groups, event) => {
      const semantics = activitySemantics(event, snapshot)
      const previous = groups.at(-1)
      if (previous?.semantics.key === semantics.key) {
        return [
          ...groups.slice(0, -1),
          Object.freeze({ ...previous, count: previous.count + 1 }),
        ]
      }
      return [...groups, Object.freeze({ event, semantics, count: 1 })]
    }, [])
  }

  function renderActivity(snapshot) {
    if (!nodes.activity) return
    const filters = Object.freeze({ placeId: state.placeId, resident: state.resident })
    const issue = selectionIssue(snapshot, false)
    if (issue) {
      renderSelectionIssue(nodes.activity, issue, 'li')
      hideHistoryControl(nodes.happeningsPage)
      return
    }
    // Kick the auto-load before reading the entry: loadHistory stores
    // loading:true synchronously, so this render already says "fetching"
    // instead of falsely reporting an empty view.
    autoLoadFilteredHistory('events', filters, historyEntry('events', filters))
    const entry = historyEntry('events', filters)
    const events = entry.rows
    if (renderHistoryOutcome(nodes.activity, entry, Object.freeze({
      loading: 'Fetching happenings that match this view…',
      failure: 'Happenings could not be loaded. Retry below.',
      empty: 'No public happening matches this selection.',
    }), 'li')) {
      renderHistoryControl(nodes.happeningsPage, 'events', 'happenings', filters)
      return
    }
    const rows = collapseActivity(events, snapshot).map(group => {
      const event = group.event
      const row = element('li', 'activity-row')
      const copy = element('p', 'activity-copy')
      const description = element('span', '', ' ' + group.semantics.description)
      if (group.count > 1) {
        description.append(
          element('span', 'activity-count', ' · ' + String(group.count) + ' times'),
        )
      }
      description.append('.')
      copy.append(
        SAFE_SYSTEM_EVENT_ACTORS.has(event.actor)
          ? element('span', 'activity-actor activity-system-actor', event.actor)
          : residentNode(event.actor, 'activity-actor', 'activity-actor:' + String(event.id)),
        description,
      )
      row.append(copy, timeNode(event.at, 'activity-time'))
      if (group.semantics.location) {
        row.append(element('span', 'activity-context',
          'Observed at ' + group.semantics.location))
      }
      return row
    })
    nodes.activity.replaceChildren(...rows)
    renderHistoryControl(nodes.happeningsPage, 'events', 'happenings', filters)
  }

  function renderAgreements(snapshot) {
    if (!nodes.agreements) return
    const filters = Object.freeze({ placeId: null, resident: state.resident })
    const issue = state.resident ? selectionIssue(snapshot, false) : null
    if (issue?.kind === 'resident') {
      renderSelectionIssue(nodes.agreements, issue)
      hideHistoryControl(nodes.agreementsPage)
      return
    }
    autoLoadFilteredHistory('agreements', filters, historyEntry('agreements', filters))
    const entry = historyEntry('agreements', filters)
    const agreements = entry.rows
    if (renderHistoryOutcome(nodes.agreements, entry, Object.freeze({
      loading: 'Fetching agreements that match this resident…',
      failure: 'Agreements could not be loaded. Retry below.',
      empty: 'No public agreement matches this resident selection.',
    }))) {
      renderHistoryControl(nodes.agreementsPage, 'agreements', 'agreements', filters)
      return
    }
    nodes.agreements.replaceChildren(...agreements.map(agreement => {
      const card = element('article', 'agreement-card')
      const copy = element('div', '')
      const agreementMeta = element('p', 'agreement-meta')
      agreementMeta.append(
        document.createTextNode('agreement #' + String(agreement.id) + ' · written by '),
        residentNode(agreement.created_by, 'agreement-author',
          'agreement-author:' + String(agreement.id)),
      )
      copy.append(
        agreementMeta,
        renderExpandableBody('agreement', agreement.id, agreement.body, agreement.truncated),
        timeNode(agreement.created_at, 'agreement-meta'),
      )
      if (state.resident && agreement.parties_truncated &&
          agreement.created_by !== state.resident && !agreement.parties.includes(state.resident)) {
        copy.append(element('p', 'agreement-filter-note',
          'Party preview is incomplete; this agreement stays visible in filtered views.'))
      }
      if (agreement.moderated) copy.append(element('span', 'moderated-mark', 'Removed text retained as a tombstone'))
      const side = element('aside', 'agreement-side')
      side.append(element('h3', '', 'Parties & signatures'))
      const signatures = element('div', 'signature-list')
      // Named parties first, then whoever acceded later. An acceded party has
      // always signed -- joining is the signing -- so it gets its own mark
      // rather than a tick that would read as an invitation the author wrote.
      const named = agreement.parties.filter(party => !agreement.acceded.includes(party))
      signatures.append(...named.concat(agreement.acceded).map(party => {
        const acceded = agreement.acceded.includes(party)
        const signed = agreement.signatures.includes(party)
        const chip = element('span', 'signature-chip',
          (acceded ? '+ ' : signed ? '✓ ' : '○ ') + party)
        chip.dataset.signed = String(signed)
        if (acceded) {
          chip.dataset.acceded = 'true'
          chip.title = 'acceded after the agreement was written'
        }
        return chip
      }))
      const hiddenPartyCount = Math.max(0, agreement.party_count - agreement.parties.length)
      if (agreement.parties_truncated && hiddenPartyCount) {
        signatures.append(element('span', 'signature-overflow',
          '+' + String(hiddenPartyCount) + ' more not shown here'))
      }
      side.append(signatures, element('span', agreement.open ? 'badge badge-open' : 'badge badge-complete',
        agreement.open ? 'Awaiting signatures' : 'Fully signed'))
      side.append(element('span', agreement.accession_open ? 'badge badge-open' : 'badge badge-complete',
        agreement.accession_open ? 'Open to later signers' : 'Closed to later signers'))
      card.append(copy, side)
      return card
    }))
    renderHistoryControl(nodes.agreementsPage, 'agreements', 'agreements', filters)
  }

  // A filtered view whose slice has never been fetched from the server only
  // holds whatever happened to sit in the newest city-wide page. Fetch the
  // real filtered slice once instead of leaving the view falsely quiet.
  function autoLoadFilteredHistory(collection, filters, entry) {
    if (!filters.placeId && !filters.resident) return
    if (entry.initialized || entry.loading || entry.error) return
    void loadHistory(collection, filters)
  }

  function renderHistoryControl(target, collection, label, filters) {
    if (!target) return
    const entry = historyEntry(collection, filters)
    const hasRefreshState = entry.refreshing || entry.refreshError
    const hasPagingState = entry.hasMore || entry.loading || entry.error
    if (!hasRefreshState && !hasPagingState) {
      target.hidden = true
      target.replaceChildren()
      return
    }
    const parts = []
    if (entry.refreshing) {
      parts.push(element('p', 'loading-row', 'Loading updated ' + label + '…'))
    } else if (entry.refreshError) {
      const message = element('p', 'navigation-error',
        'Updated ' + label + ' could not be loaded. Showing the previous completed results.')
      message.setAttribute('role', 'alert')
      const retry = element('button', 'history-load', 'Retry refreshing ' + label)
      retry.type = 'button'
      retry.dataset.focusKey = 'refresh:' + collection + ':' + historyKey(collection, filters)
      retry.addEventListener('click', () => void forwardRefreshHistory(collection, filters))
      parts.push(message, retry)
    }
    if (!hasPagingState) {
      target.hidden = false
      target.replaceChildren(...parts)
      return
    }
    // While the first filtered slice is being fetched nothing "older" is
    // involved yet; every click-driven state keeps the familiar wording.
    const older = entry.initialized ? 'older ' : ''
    const text = entry.loading
      ? 'Loading ' + older + label + '…'
      : entry.error ? 'Retry loading ' + older + label : 'Load ' + older + label
    const button = element('button', 'history-load', text)
    button.type = 'button'
    // Never disabled: a disabled control cannot take restored focus, and
    // loadHistory already ignores clicks while a fetch is in flight.
    button.setAttribute('aria-busy', String(entry.loading))
    button.dataset.focusKey = 'load:' + collection + ':' + historyKey(collection, filters)
    button.dataset.focusFallbackId = collection === 'events'
      ? 'activity-list'
      : collection === 'agreements'
        ? 'agreement-list'
        : collection === 'things'
          ? 'place-things'
          : label === 'conversations' ? 'conversation-stream' : 'place-conversation'
    button.addEventListener('click', () => void loadHistory(collection, filters))
    if (entry.error && entry.rows.length) {
      const message = element('p', 'navigation-error',
        (older ? 'Older ' : '') + label + ' could not be loaded.')
      message.setAttribute('role', 'alert')
      parts.push(message)
    }
    parts.push(button)
    target.hidden = false
    target.replaceChildren(...parts)
  }

  function historyRequestUrl(collection, entry, filters, minimumMarker) {
    const url = new URL(
      collection === 'events' ? '/api/events' : '/api/window',
      window.location.origin,
    )
    // Context pages carry up to four neighbors per own note, so they use a
    // smaller page to stay well inside the client's 200-row safety cap.
    url.searchParams.set('limit', filters.context ? '25' : '50')
    if (collection === 'events') {
      if (filters.placeId) url.searchParams.set('within_place_id', String(filters.placeId))
      if (filters.resident) url.searchParams.set('actor', filters.resident)
    } else {
      url.searchParams.set('collection', collection)
      if (filters.placeId) url.searchParams.set('within_place_id', String(filters.placeId))
      if (filters.resident) url.searchParams.set('resident', filters.resident)
      if (filters.context) url.searchParams.set('context', 'place')
    }
    if (entry.initialized && entry.nextBeforeId) {
      url.searchParams.set('before_id', String(entry.nextBeforeId))
    }
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    return url
  }

  function normalizeHistoryRows(collection, payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid public history page')
    if (collection === 'notes') return normalizeNotes(payload.notes)
    if (collection === 'things') return normalizeThings(payload.things)
    if (collection === 'agreements') return normalizeAgreements(payload.agreements)
    return normalizeEvents(payload.events)
  }

  // A filtered entry only pages backward once initialized, and the snapshot
  // merge can only place-match events it can resolve client-side. Refetching
  // the newest filtered page after each snapshot refresh keeps an open
  // filtered view complete without touching its backward cursor.
  const forwardRefreshKeys = new Set()
  async function forwardRefreshHistory(collection, filters) {
    const key = collection + '|' + historyKey(collection, filters)
    if (forwardRefreshKeys.has(key)) return
    forwardRefreshKeys.add(key)
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    const current = historyEntry(collection, filters)
    setHistoryEntry(collection, filters, {
      ...current,
      refreshing: true,
      refreshError: false,
    })
    renderAll()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = historyRequestUrl(
        collection, { initialized: false, nextBeforeId: null }, filters, requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('updated public history unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision) return
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      const incoming = normalizeHistoryRows(collection, payload)
      const latest = historyEntry(collection, filters)
      setHistoryEntry(collection, filters, {
        ...latest,
        rows: mergeWindowRows(latest.rows, incoming),
        refreshing: false,
        refreshError: false,
      })
      renderAll()
    } catch {
      if (authoredRevision === requestAuthoredRevision) {
        const latest = historyEntry(collection, filters)
        setHistoryEntry(collection, filters, {
          ...latest,
          refreshing: false,
          refreshError: true,
        })
        renderAll()
      }
    } finally {
      window.clearTimeout(timeout)
      forwardRefreshKeys.delete(key)
    }
  }

  function refreshFilteredViews() {
    if (state.view === 'happenings') {
      const filters = Object.freeze({ placeId: state.placeId, resident: state.resident })
      if (!filters.placeId && !filters.resident) return
      const entry = historyEntry('events', filters)
      if (!entry.initialized || entry.loading) return
      void forwardRefreshHistory('events', filters)
    } else if (state.view === 'conversations' && state.resident) {
      const filters = Object.freeze({
        placeId: state.placeId,
        resident: state.resident,
        context: Boolean(state.conversationContext),
      })
      const entry = historyEntry('notes', filters)
      if (!entry.initialized || entry.loading) return
      void forwardRefreshHistory('notes', filters)
    } else if (state.view === 'agreements' && state.resident) {
      const filters = Object.freeze({ placeId: null, resident: state.resident })
      const entry = historyEntry('agreements', filters)
      if (!entry.initialized || entry.loading) return
      void forwardRefreshHistory('agreements', filters)
    }
  }

  async function loadHistory(collection, filters) {
    const current = historyEntry(collection, filters)
    if (current.loading || (current.initialized && !current.hasMore && !current.error)) return
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    setHistoryEntry(collection, filters, {
      ...current,
      loading: true,
      error: false,
      refreshing: false,
      refreshError: false,
    })
    renderAll()

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const requestEntry = historyEntry(collection, filters)
      const url = historyRequestUrl(collection, requestEntry, filters, requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('public history unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision) return
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      const incoming = normalizeHistoryRows(collection, payload)
      const hasMore = payload.has_more === true
      const nextBeforeId = hasMore ? safeId(payload.next_before_id) : null
      if (hasMore && !nextBeforeId) throw new Error('invalid public history cursor')
      const latest = historyEntry(collection, filters)
      setHistoryEntry(collection, filters, {
        rows: mergeWindowRows(latest.rows, incoming),
        hasMore,
        nextBeforeId,
        initialized: true,
        loading: false,
        error: false,
      })
    } catch {
      if (authoredRevision !== requestAuthoredRevision) return
      const latest = historyEntry(collection, filters)
      setHistoryEntry(collection, filters, { ...latest, loading: false, error: true })
    } finally {
      window.clearTimeout(timeout)
      renderAll()
    }
  }

  function loadedHistoryRows(collection, snapshot) {
    if (state.view === 'place' && (collection === 'notes' || collection === 'things')) {
      const place = selectedPlace(snapshot) ||
        (!state.resident && !state.placeId ? snapshot.flatPlaces[0] || null : null)
      if (!place || selectionIssue(snapshot, true)) return []
      return historyEntry(collection, { placeId: place.id, resident: state.resident }).rows
    }
    if (state.view === 'conversations' && collection === 'notes') {
      if (selectionIssue(snapshot, false)) return []
      return historyEntry('notes', {
        placeId: state.placeId,
        resident: state.resident,
        context: Boolean(state.resident && state.conversationContext),
      }).rows
    }
    if (state.view === 'happenings' && collection === 'events') {
      if (selectionIssue(snapshot, false)) return []
      return historyEntry('events', {
        placeId: state.placeId,
        resident: state.resident,
      }).rows
    }
    if (state.view === 'agreements' && collection === 'agreements') {
      if (state.resident && selectionIssue(snapshot, false)?.kind === 'resident') return []
      return historyEntry('agreements', { placeId: null, resident: state.resident }).rows
    }
    return snapshot[collection]
  }

  function loadedShown(snapshot) {
    const places = new Map(snapshot.flatPlaces.map(place => [place.id, place]))
    for (const placeId of activeFocusedPlaceIds(snapshot)) {
      const place = focusedPlace(placeId)
      if (place) places.set(place.id, place)
    }
    const residents = new Map(displayedResidents(snapshot).map(resident => [resident.id, resident]))
    return Object.freeze({
      places: places.size,
      residents: residents.size,
      conversations: loadedHistoryRows('notes', snapshot).length,
      things: loadedHistoryRows('things', snapshot).length,
      agreements: loadedHistoryRows('agreements', snapshot).length,
      events: loadedHistoryRows('events', snapshot).length,
    })
  }

  function renderCounts(snapshot) {
    if (!nodes.counts) return
    nodes.counts.textContent = String(snapshot.totals.places) + ' places · ' +
      String(snapshot.totals.residents) + ' residents · ' + String(snapshot.totals.things) +
      ' things · ' + String(snapshot.totals.conversations) + ' notes · public and read only'
  }

  function activeFilteredScopeKeys(snapshot) {
    const keys = new Set()
    if (state.view === 'place' && selectedPlace(snapshot)) {
      keys.add('conversations')
      keys.add('things')
    }
    if (state.view === 'conversations' && (state.placeId || state.resident)) {
      keys.add('conversations')
    }
    if (state.view === 'happenings' && (state.placeId || state.resident)) {
      keys.add('events')
    }
    if (state.view === 'agreements' && state.resident) keys.add('agreements')
    return keys
  }

  function renderScope(snapshot) {
    if (!nodes.scope) return
    const shown = loadedShown(snapshot)
    const labels = {
      places: 'places', residents: 'residents', conversations: 'conversations',
      things: 'things', agreements: 'agreements', events: 'happenings',
    }
    const filteredKeys = activeFilteredScopeKeys(snapshot)
    const partial = Object.keys(labels).filter(key =>
      !filteredKeys.has(key) && snapshot.totals[key] > shown[key])
      .map(key => (key === 'places' || key === 'residents' ? 'currently loaded ' : '') +
        String(shown[key]) + ' of ' + String(snapshot.totals[key]) + ' ' + labels[key])
    const filters = [
      state.placeId ? 'place #' + String(state.placeId) : '',
      state.resident ? 'resident ' + state.resident : '',
    ].filter(Boolean)
    const hasExcerpts = snapshot.notes.some(note => note.truncated) ||
      snapshot.things.some(thing => thing.truncated) ||
      snapshot.agreements.some(agreement => agreement.truncated)
    const excerptNotice = !hasExcerpts
      ? ''
      : snapshot.bodyLimits
        ? ' Excerpt limits are ' + snapshot.bodyLimits.notes.toLocaleString() +
          ' characters for notes, ' + snapshot.bodyLimits.things.toLocaleString() +
          ' for things, and ' + snapshot.bodyLimits.agreements.toLocaleString() +
          ' for agreements.'
        : ' Long text may appear as an excerpt.'
    // Following a resident fetches a separately paged answer beyond the initial
    // bounded view. Name the exact question instead of asking scope disclosure
    // to compensate for an ambiguous default.
    const followedFilters = state.resident && state.view === 'conversations' ? Object.freeze({
      placeId: state.placeId,
      resident: state.resident,
      context: Boolean(state.conversationContext),
    }) : null
    const followedEntry = followedFilters ? historyEntry('notes', followedFilters) : null
    const followedRows = followedEntry?.rows || []
    const ownRows = followedRows.filter(note => note.author === state.resident).length
    const followedQuestion = followedFilters
      ? state.conversationContext
        ? 'what was said around ' + state.resident
        : 'what ' + state.resident + ' said'
      : ''
    const followedWaiting = followedEntry && (
      followedEntry.loading || followedEntry.refreshing ||
      (!followedEntry.initialized && !followedEntry.error && !followedEntry.refreshError)
    )
    const followedFailed = followedEntry && (followedEntry.error || followedEntry.refreshError)
    const followNotice = !followedFilters
      ? ''
      : followedWaiting
        ? ' Conversation question: ' + followedQuestion + '. Loading that public read.'
        : followedFailed
          ? ' Conversation question: ' + followedQuestion +
            '. That public read failed; retry is available in the conversation panel.'
          : followedRows.length === 0
            ? ' Conversation question: ' + followedQuestion + '. Nothing was found.'
            : state.conversationContext
              ? ' Conversation question: ' + followedQuestion + '. Showing ' +
                String(ownRows) + (ownRows === 1 ? ' note' : ' notes') + ' by ' + state.resident +
                ' plus ' + String(followedRows.length - ownRows) + ' fetched from the same rooms' +
                (followedEntry?.hasMore ? '; older pages remain.' : '.')
              : ' Conversation question: ' + followedQuestion + '. Showing ' +
                String(followedRows.length) + ' fetched ' +
                (followedRows.length === 1 ? 'note' : 'notes') +
                (followedEntry?.hasMore ? '; older pages remain.' : '.')
    const directoryNotice = state.directory.loaded
      ? ' Selectors use the complete city directory; map, presence, and authored content remain currently loaded views.'
      : ' Selectors currently use the loaded fallback while the complete city directory is unavailable.'
    nodes.scope.textContent = (partial.length
      ? 'Current bounded public view shows ' + partial.join(' · ') + '.'
      : filteredKeys.size
        ? 'The other currently loaded public rows are within their display limits.'
        : 'The currently loaded public view is within every display limit.') +
      directoryNotice +
      excerptNotice +
      (filters.length ? ' Active filter: ' + filters.join(' + ') + '.' : '') +
      followNotice
  }

  function renderDirectoryStatus() {
    if (!nodes.directoryStatus) return
    nodes.directoryStatus.removeAttribute('role')
    if (state.directory.error) {
      nodes.directoryStatus.setAttribute('role', 'alert')
      const message = element('span', '',
        'The complete city directory could not be loaded. Selectors show the currently loaded fallback. ')
      const retry = element('button', 'directory-retry', 'Retry loading the complete directory')
      retry.type = 'button'
      retry.dataset.focusKey = 'directory-retry'
      retry.addEventListener('click', () => void loadDirectory())
      nodes.directoryStatus.replaceChildren(message, retry)
      return
    }
    if (state.directory.loading || !state.directory.loaded) {
      nodes.directoryStatus.textContent =
        'Loading the complete city directory. Map and content below are currently loaded separately.'
      return
    }
    nodes.directoryStatus.textContent = 'Complete city directory: ' +
      String(state.directory.places.length) + ' places and ' +
      String(state.directory.residents.length) +
      ' residents. Map, presence, and content below are currently loaded separately.'
  }

  function renderView() {
    const gazetteView = state.view === 'gazette'
    if (nodes.directorySearchField) nodes.directorySearchField.hidden = gazetteView
    if (nodes.viewFilters) nodes.viewFilters.hidden = gazetteView
    for (const tab of tabs) {
      const active = tab.dataset.view === state.view
      tab.setAttribute('aria-selected', String(active))
      tab.tabIndex = active ? 0 : -1
      if (active && tab.parentElement) {
        const tabList = tab.parentElement
        const tabBox = tab.getBoundingClientRect()
        const tabListBox = tabList.getBoundingClientRect()
        if (tabBox.left < tabListBox.left) {
          tabList.scrollLeft -= Math.ceil(tabListBox.left - tabBox.left)
        } else if (tabBox.right > tabListBox.right) {
          tabList.scrollLeft += Math.ceil(tabBox.right - tabListBox.right)
        }
      }
    }
    for (const panel of panels) panel.hidden = panel.id !== state.view + '-panel'
  }

  // A refresh rebuilds the DOM, which would silently drop the reader's
  // keyboard position. Every rebuilt interactive control carries a stable
  // data-focus-key so focus can land back on its replacement.
  function restoreFocus(focusKey, focusFallbackKey, focusFallbackId) {
    if (!focusKey || document.activeElement !== document.body) return
    // Hidden panels keep their previous DOM, so the same key can exist in a
    // stale copy; only a visible replacement can actually take focus.
    const replacements = document.querySelectorAll(
      '[data-focus-key="' + CSS.escape(focusKey) + '"]')
    for (const replacement of replacements) {
      if (replacement.closest('[hidden]')) continue
      replacement.focus({ preventScroll: true })
      return
    }
    const fallback = focusFallbackKey
      ? document.querySelector('[data-focus-key="' + CSS.escape(focusFallbackKey) + '"]')
      : null
    if (fallback && !fallback.closest('[hidden]')) {
      fallback.focus({ preventScroll: true })
      return
    }
    const fallbackTarget = focusFallbackId ? document.getElementById(focusFallbackId) : null
    if (fallbackTarget && !fallbackTarget.closest('[hidden]')) {
      fallbackTarget.tabIndex = -1
      fallbackTarget.focus({ preventScroll: true })
    }
  }

  function renderAll() {
    const snapshot = state.snapshot
    const active = document.activeElement
    const focusKey = active && active.dataset ? active.dataset.focusKey || null : null
    const focusFallbackKey = active && active.dataset
      ? active.dataset.focusFallbackKey || null
      : null
    const focusFallbackId = active && active.dataset
      ? active.dataset.focusFallbackId || null
      : null
    renderView()
    renderDirectoryStatus()
    writeLocation(false)
    renderDetail()
    if (state.view === 'archive') renderArchive()
    if (state.view === 'gazette') renderGazette()
    if (!snapshot) return
    renderCounts(snapshot)
    renderScope(snapshot)
    if (state.view === 'map') {
      renderMap(snapshot)
      renderRoster(snapshot)
    } else if (state.view === 'place') {
      renderPlace(snapshot)
    } else if (state.view === 'conversations') {
      renderConversations(snapshot)
    } else if (state.view === 'happenings') {
      renderActivity(snapshot)
    } else if (state.view === 'agreements') {
      renderAgreements(snapshot)
    }
    syncBodyDisclosures()
    if (nodes.placeFilter) nodes.placeFilter.value = state.placeId ? String(state.placeId) : ''
    renderDirectorySearch(snapshot)
    if (nodes.residentFilter) nodes.residentFilter.value = state.resident || ''
    restoreFocus(focusKey, focusFallbackKey, focusFallbackId)
  }

  function choosePlace(id, openPlace) {
    const place = state.snapshot?.flatPlaces.find(candidate => candidate.id === id) ||
      directoryPlace(id) || focusedPlace(id)
    if (!place) return
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      placeId: id,
      directorySearch: '',
      directorySearchIndex: -1,
      view: openPlace ? 'place' : state.view,
      detail: null,
    })
    if (state.snapshot) populateFilters(state.snapshot)
  }

  function chooseResident(handle) {
    const resident = state.snapshot?.residents.find(candidate => candidate.handle === handle) ||
      state.directory.residents.find(candidate => candidate.handle === handle) ||
      focusedResident(handle)
    if (!resident) return
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      resident: handle,
      conversationContext: false,
      directorySearch: '',
      directorySearchIndex: -1,
      detail: null,
    })
  }

  async function loadDirectory(force) {
    if (state.directory.loading) return
    state = {
      ...state,
      directory: Object.freeze({ ...state.directory, loading: true, error: false }),
    }
    renderDirectoryStatus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/window', window.location.origin)
      url.searchParams.set('view', 'directory')
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('public directory unavailable')
      const directory = normalizeDirectory(await response.json())
      state = {
        ...state,
        directory: Object.freeze({
          ...directory,
          loaded: true,
          loading: false,
          error: false,
          marker: state.changeMarker || null,
        }),
      }
      if (state.snapshot) populateFilters(state.snapshot)
      renderAll()
      void ensureFocusedSelection()
    } catch {
      state = {
        ...state,
        directory: Object.freeze({ ...state.directory, loading: false, error: true }),
      }
      if (state.snapshot) populateFilters(state.snapshot)
      renderAll()
    } finally {
      window.clearTimeout(timeout)
    }
  }

  async function loadFocusedPlace(placeId, force) {
    if (!state.snapshot || state.snapshot.flatPlaces.some(place => place.id === placeId)) return
    const current = state.focusedPlaces[String(placeId)]
    if (current?.loading || (!force && current?.place)) return
    const selectionAtStart = activeSelectionKey()
    const requestMarker = state.changeMarker
    const requestAuthoredRevision = authoredRevision
    state = {
      ...state,
      focusedPlaces: {
        ...state.focusedPlaces,
        [String(placeId)]: Object.freeze({
          loading: true,
          error: false,
          notFound: false,
          marker: current?.marker || null,
          place: current?.place || null,
        }),
      },
    }
    renderAll()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/map', window.location.origin)
      url.searchParams.set('view', 'outline')
      url.searchParams.set('parent_id', String(placeId))
      if (requestMarker) url.searchParams.set('after_change_marker', requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (response.status === 404) {
        const payload = await response.json().catch(() => null)
        requireCurrentReadMarker(payload?.change_marker, requestMarker)
        if (authoredRevision !== requestAuthoredRevision || state.changeMarker !== requestMarker) {
          throw new Error('focused place reply was overtaken by a newer public snapshot')
        }
        state = {
          ...state,
          focusedPlaces: {
            ...state.focusedPlaces,
            [String(placeId)]: Object.freeze({
              loading: false,
              error: false,
              notFound: true,
              marker: requestMarker || current?.marker || null,
              place: null,
            }),
          },
        }
        return
      }
      if (!response.ok) throw new Error('focused place unavailable')
      const payload = await response.json()
      const responseMarker = safeChangeMarker(payload?.change_marker)
      requireCurrentReadMarker(responseMarker, requestMarker)
      const [normalized] = normalizePlaces([payload?.place], 0, new Set())
      if (!normalized || normalized.id !== placeId) throw new Error('wrong focused place')
      const reference = directoryPlace(placeId)
      const place = Object.freeze({
        ...normalized,
        children: [],
        path: focusedPlacePath(reference, normalized),
      })
      state = {
        ...state,
        focusedPlaces: {
          ...state.focusedPlaces,
          [String(placeId)]: Object.freeze({
            loading: false,
            error: false,
            notFound: false,
            marker: responseMarker || requestMarker || null,
            place,
          }),
        },
      }
    } catch {
      const retainedCovers = Boolean(current?.place) &&
        (!state.changeMarker || markerCovers(current?.marker, state.changeMarker))
      state = {
        ...state,
        focusedPlaces: {
          ...state.focusedPlaces,
          [String(placeId)]: Object.freeze({
            loading: false,
            error: !retainedCovers,
            notFound: false,
            marker: current?.marker || null,
            place: current?.place || null,
          }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (activeSelectionKey() === selectionAtStart) {
        if (state.snapshot) populateFilters(state.snapshot)
        renderAll()
      }
    }
  }

  async function loadFocusedResident(handle, force) {
    if (!state.snapshot || state.snapshot.residents.some(resident => resident.handle === handle)) return
    const current = state.focusedResidents[handle]
    if (current?.loading || (!force && current?.resident)) return
    const selectionAtStart = activeSelectionKey()
    const requestMarker = state.changeMarker
    const requestAuthoredRevision = authoredRevision
    state = {
      ...state,
      focusedResidents: {
        ...state.focusedResidents,
        [handle]: Object.freeze({
          loading: true,
          error: false,
          notFound: false,
          marker: current?.marker || null,
          resident: current?.resident || null,
        }),
      },
    }
    renderAll()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/residents', window.location.origin)
      url.searchParams.set('view', 'presence')
      url.searchParams.set('handle', handle)
      if (requestMarker) url.searchParams.set('after_change_marker', requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (response.status === 404) {
        const payload = await response.json().catch(() => null)
        requireCurrentReadMarker(payload?.change_marker, requestMarker)
        if (authoredRevision !== requestAuthoredRevision || state.changeMarker !== requestMarker) {
          throw new Error('focused resident reply was overtaken by a newer public snapshot')
        }
        state = {
          ...state,
          focusedResidents: {
            ...state.focusedResidents,
            [handle]: Object.freeze({
              loading: false,
              error: false,
              notFound: true,
              marker: requestMarker || current?.marker || null,
              resident: null,
            }),
          },
        }
        return
      }
      if (!response.ok) throw new Error('focused resident unavailable')
      const payload = await response.json()
      const [resident] = normalizeResidents([payload?.resident])
      if (!resident || resident.handle !== handle) throw new Error('wrong focused resident')
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      if (authoredRevision !== requestAuthoredRevision || state.changeMarker !== requestMarker) {
        throw new Error('focused resident reply was overtaken by a newer public snapshot')
      }
      state = {
        ...state,
        focusedResidents: {
          ...state.focusedResidents,
          [handle]: Object.freeze({
            loading: false,
            error: false,
            notFound: false,
            marker: safeChangeMarker(payload?.change_marker) || requestMarker || null,
            resident,
          }),
        },
      }
    } catch {
      const retainedCovers = Boolean(current?.resident) &&
        (!state.changeMarker || markerCovers(current?.marker, state.changeMarker))
      state = {
        ...state,
        focusedResidents: {
          ...state.focusedResidents,
          [handle]: Object.freeze({
            loading: false,
            error: !retainedCovers,
            notFound: false,
            marker: current?.marker || null,
            resident: current?.resident || null,
          }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (activeSelectionKey() === selectionAtStart) {
        if (state.snapshot) populateFilters(state.snapshot)
        renderAll()
      }
    }
  }

  async function ensureFocusedSelection(options) {
    const forcePlace = options?.forcePlace === true
    const forceResident = options?.forceResident === true
    if (!state.snapshot) return
    const selectionAtStart = activeSelectionKey()
    const selectedHandle = state.resident
    const explicitPlaceId = state.placeId

    if (selectedHandle &&
        !state.snapshot.residents.some(resident => resident.handle === selectedHandle)) {
      const entry = state.focusedResidents[selectedHandle]
      if (!entry || forceResident) {
        await loadFocusedResident(selectedHandle, forceResident)
      }
      if (activeSelectionKey() !== selectionAtStart || state.resident !== selectedHandle) return
      const latest = state.focusedResidents[selectedHandle]
      if (latest?.error || latest?.notFound || !latest?.resident) return
    }

    if (explicitPlaceId &&
        !state.snapshot.flatPlaces.some(place => place.id === explicitPlaceId)) {
      const entry = state.focusedPlaces[String(explicitPlaceId)]
      if (!entry || forcePlace) await loadFocusedPlace(explicitPlaceId, forcePlace)
      return
    }

    if (!explicitPlaceId && selectedHandle) {
      const resident = selectedResident(state.snapshot)
      const currentPlaceId = resident?.current_place_id || null
      if (currentPlaceId &&
          !state.snapshot.flatPlaces.some(place => place.id === currentPlaceId)) {
        const entry = state.focusedPlaces[String(currentPlaceId)]
        if (!entry || forcePlace) {
          await loadFocusedPlace(currentPlaceId, forcePlace)
        }
      }
    }
  }

  async function getSnapshot(signal, minimumMarker) {
    const url = new URL('/api/window', window.location.origin)
    url.searchParams.set('view', 'outline')
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    const response = await fetch(url.pathname + url.search, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public snapshot unavailable')
    return response.json()
  }

  async function checkPublicChanges() {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/changes', window.location.origin)
      if (state.changeMarker) url.searchParams.set('since', state.changeMarker)
      url.searchParams.set('limit', '200')
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) return Object.freeze({ status: 'unavailable', marker: null })
      const payload = await response.json()
      if (!payload || typeof payload !== 'object') {
        return Object.freeze({ status: 'unavailable', marker: null })
      }
      const nextMarker = safeChangeMarker(payload.change_marker ?? payload.checkpoint)
      if (!nextMarker || (state.changeMarker && !markerCovers(nextMarker, state.changeMarker))) {
        return Object.freeze({ status: 'unavailable', marker: null })
      }
      if (payload.unchanged === true) {
        return Object.freeze({ status: 'unchanged', marker: nextMarker })
      }
      return Object.freeze({ status: 'changed', marker: nextMarker })
    } catch {
      return Object.freeze({ status: 'unavailable', marker: null })
    } finally {
      window.clearTimeout(timeout)
    }
  }

  async function refreshUnchangedPresence(signal, minimumMarker) {
    const targetCount = state.snapshot?.residents.length || 0
    if (!targetCount) return []
    let residents = []
    let beforeId = null
    const seenCursors = new Set()
    while (residents.length < targetCount) {
      const url = new URL('/api/residents', window.location.origin)
      url.searchParams.set('view', 'presence')
      url.searchParams.set('limit', String(Math.min(200, targetCount - residents.length)))
      if (beforeId) url.searchParams.set('before_id', String(beforeId))
      if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      })
      if (!response.ok) throw new Error('public presence unavailable')
      const payload = await response.json()
      if (!payload || typeof payload !== 'object') throw new Error('invalid public presence')
      requireExactReadMarker(payload.change_marker, minimumMarker)
      const incoming = normalizeResidents(payload.residents)
      const merged = mergeResidentRows(residents, incoming)
      if (merged.length === residents.length && residents.length < targetCount) {
        throw new Error('public presence did not advance')
      }
      residents = merged
      if (residents.length >= targetCount) break
      if (payload.has_more !== true) throw new Error('public presence ended early')
      const nextBeforeId = safeId(payload.next_before_id)
      if (!nextBeforeId || seenCursors.has(nextBeforeId)) {
        throw new Error('invalid public presence cursor')
      }
      seenCursors.add(nextBeforeId)
      beforeId = nextBeforeId
    }
    return residents.slice(0, targetCount)
  }

  function scheduleRefresh(delay) {
    window.clearTimeout(state.pollTimer)
    const pollTimer = window.setTimeout(() => {
      if (document.hidden) {
        scheduleRefresh(BASE_REFRESH_MS)
        return
      }
      void refreshCity()
    }, delay)
    state = { ...state, pollTimer }
  }

  async function finishWatchingPublicStreets() {
    const gazetteFresh = state.view !== 'gazette' || await loadGazetteIssues(
      state.gazette.listInitialized ? 'refresh' : 'initial',
    )
    if (state.view === 'gazette' && !gazetteFresh) {
      setStatus('The public streets are current. The Gazette could not be refreshed.', 'stale')
      return
    }
    setStatus('Watching the public streets', 'live')
  }

  async function refreshCity() {
    if (state.refreshing) return
    const hadSnapshot = state.hasSnapshot
    const navigationRevisionAtStart = navigationRevision
    state = { ...state, refreshing: true }
    if (!state.hasSnapshot) setStatus('Loading the current public city view…', 'working')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let nextDelay = BASE_REFRESH_MS
    try {
      // A confirmed unchanged marker lets the window avoid downloading the
      // same authored text. Presence is refreshed separately because asleep is
      // time-derived and can change without a database event. If the marker or
      // presence read is unavailable, the complete bounded snapshot remains the
      // safe fallback.
      const changeState = await checkPublicChanges()
      if (state.hasSnapshot && changeState.status === 'unchanged') {
        try {
          const residents = await refreshUnchangedPresence(
            controller.signal,
            changeState.marker,
          )
          if (navigationRevision !== navigationRevisionAtStart) {
            await finishWatchingPublicStreets()
            return
          }
          const residentPresentationChanged =
            residentPresentationKey({ residents }) !== residentPresentationKey(state.snapshot)
          if (!residentPresentationChanged) {
            state = {
              ...state,
              changeMarker: changeState.marker,
              failures: 0,
            }
            await finishWatchingPublicStreets()
            return
          }
          const snapshot = Object.freeze({
            ...state.snapshot,
            residents,
            shown: Object.freeze({ ...state.snapshot.shown, residents: residents.length }),
            refreshedAt: new Date(),
          })
          state = {
            ...state,
            snapshot,
            changeMarker: changeState.marker,
            failures: 0,
          }
          populateFilters(snapshot)
          renderAll()
          void ensureFocusedSelection({ forceResident: true })
          await finishWatchingPublicStreets()
          return
        } catch {
          // Presence is time-derived. If its small read fails, continue into a
          // marker-covered authored snapshot instead of retaining an unproven
          // mixed refresh.
        }
      }
      const requiredMarker = changeState.marker || state.changeMarker
      const payload = await getSnapshot(controller.signal, requiredMarker)
      const freshSnapshot = normalizeSnapshot(payload)
      if (requiredMarker && !markerCovers(freshSnapshot.changeMarker, requiredMarker)) {
        throw new Error('public snapshot does not cover the requested change marker')
      }
      const replaceAuthored = !state.hasSnapshot || !state.changeMarker ||
        changeState.status === 'changed' || freshSnapshot.changeMarker !== state.changeMarker
      const navigation = replaceAuthored
        ? freshSnapshotNavigation(freshSnapshot)
        : await mergeFreshNavigation(freshSnapshot, controller.signal)
      if (navigationRevision !== navigationRevisionAtStart) {
        await finishWatchingPublicStreets()
        return
      }
      const snapshot = navigation.snapshot
      const histories = replaceAuthored
        ? freshSnapshotHistories(snapshot)
        : mergeUnchangedSnapshotHistories(snapshot)
      const archive = replaceAuthored
        ? {
            ...state.archive,
            results: [], totalItems: 0, totalTextBytes: 0, nextBefore: null,
            hasMore: false, loading: false, initialized: false, error: null,
          }
        : state.archive
      if (replaceAuthored) authoredRevision += 1
      state = {
        ...state,
        snapshot,
        branches: navigation.branches,
        residentPaging: navigation.residentPaging,
        histories,
        archive,
        fullBodies: replaceAuthored ? {} : state.fullBodies,
        details: replaceAuthored ? {} : state.details,
        changeMarker: freshSnapshot.changeMarker || requiredMarker,
        hasSnapshot: true,
        failures: 0,
      }
      populateFilters(snapshot)
      renderAll()
      void ensureDetail(replaceAuthored)
      loadSharedArchiveQuestion()
      if (hadSnapshot && replaceAuthored &&
          (state.directory.loaded || state.directory.error) && !state.directory.loading) {
        void loadDirectory(true)
      }
      void ensureFocusedSelection({ forcePlace: replaceAuthored, forceResident: true })
      refreshFilteredViews()
      await finishWatchingPublicStreets()
    } catch {
      const failures = state.failures + 1
      state = { ...state, failures }
      nextDelay = Math.min(BASE_REFRESH_MS * Math.pow(2, failures), MAX_REFRESH_MS)
      if (state.hasSnapshot) {
        renderGlobalReadRetry(
          'The updated public city view could not be read. Showing the previous completed view.',
          'stale',
        )
      } else {
        renderGlobalReadFailure()
      }
    } finally {
      window.clearTimeout(timeout)
      state = { ...state, refreshing: false }
      scheduleRefresh(nextDelay)
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view
      if (!VIEWS.includes(view)) return
      const openingGazette = view === 'gazette'
      let placeId = state.placeId
      if (view === 'place' && !state.resident && !state.placeId &&
        !selectedPlace(state.snapshot || { residents: [], flatPlaces: [] })) {
        placeId = state.snapshot?.flatPlaces[0]?.id || null
      }
      if (!openingGazette && state.view !== 'gazette') {
        navigate({ view, placeId, detail: null })
        return
      }
      if (openingGazette && nodes.directorySearch) nodes.directorySearch.value = ''
      navigate({
        view,
        placeId: openingGazette ? null : placeId,
        resident: openingGazette ? null : state.resident,
        conversationContext: openingGazette ? false : state.conversationContext,
        directorySearch: openingGazette ? '' : state.directorySearch,
        directorySearchIndex: openingGazette ? -1 : state.directorySearchIndex,
        sleeperPlaceIds: openingGazette ? [] : state.sleeperPlaceIds,
        gazetteIssueId: openingGazette
          ? state.view === 'gazette' ? state.gazetteIssueId : null
          : null,
        detail: null,
      })
    })
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const current = tabs.indexOf(tab)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
        (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      tabs[index]?.focus()
      rovingTabActivation = true
      try {
        tabs[index]?.click()
      } finally {
        rovingTabActivation = false
      }
    })
  }

  for (const button of viewShareButtons) {
    button.addEventListener('click', () => void copyCurrentShareLink(button))
  }
  detailShareButton?.addEventListener('click', () => void copyCurrentShareLink(detailShareButton))
  nodes.detailClose?.addEventListener('click', closeDetail)
  nodes.detail?.addEventListener('cancel', event => {
    event.preventDefault()
    closeDetail()
  })

  nodes.directorySearch?.addEventListener('input', () => {
    state = {
      ...state,
      directorySearch: String(nodes.directorySearch.value || '').slice(0, 100),
      directorySearchIndex: 0,
    }
    writeLocation(false)
    if (state.snapshot) renderDirectorySearch(state.snapshot, true)
  })
  nodes.directorySearch?.addEventListener('focus', () => {
    if (state.snapshot && state.directorySearch) renderDirectorySearch(state.snapshot, true)
  })
  nodes.directorySearch?.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (document.activeElement !== nodes.directorySearch) closeDirectorySearchResults()
    }, 0)
  })
  nodes.directorySearch?.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.directorySearch) {
      event.preventDefault()
      nodes.directorySearch.value = ''
      state = { ...state, directorySearch: '', directorySearchIndex: -1 }
      writeLocation(false)
      if (state.snapshot) renderDirectorySearch(state.snapshot, false)
      return
    }
    if (!state.snapshot || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
    const results = directorySearchRows(state.snapshot)
    if (!results.length) return
    event.preventDefault()
    if (event.key === 'Enter') {
      selectDirectorySearchResult(Math.max(0, state.directorySearchIndex))
      return
    }
    const offset = event.key === 'ArrowDown' ? 1 : -1
    const current = Math.max(0, state.directorySearchIndex)
    state = {
      ...state,
      directorySearchIndex: (current + offset + results.length) % results.length,
    }
    renderDirectorySearch(state.snapshot, true)
  })
  nodes.placeFilter?.addEventListener('change', () => {
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      placeId: safeId(nodes.placeFilter.value),
      directorySearch: '',
      directorySearchIndex: -1,
      detail: null,
    })
    if (state.snapshot) populateFilters(state.snapshot)
  })
  nodes.residentFilter?.addEventListener('change', () => {
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      resident: safeHandle(nodes.residentFilter.value),
      conversationContext: false,
      directorySearch: '',
      directorySearchIndex: -1,
      detail: null,
    })
  })
  nodes.archiveSearch?.addEventListener('click', () => void loadArchive(true))
  nodes.archiveQuery?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void loadArchive(true)
  })
  function syncStateFromLocation() {
    const nextLocationState = readLocationState()
    if (nextLocationState.archive !== state.archive) archiveRequestRevision += 1
    if (
      nextLocationState.gazetteIssueId !== state.gazetteIssueId ||
      nextLocationState.view !== state.view
    ) gazetteDetailRequestRevision += 1
    if (
      nextLocationState.detail?.kind !== state.detail?.kind ||
      nextLocationState.detail?.id !== state.detail?.id
    ) detailRequestRevision += 1
    resetShareFeedback()
    state = { ...state, ...nextLocationState }
    syncArchiveControls()
    renderAll()
    void ensureFocusedSelection()
    void ensureDetail()
    loadSharedArchiveQuestion()
    loadSharedGazette()
  }
  window.addEventListener('hashchange', syncStateFromLocation)
  window.addEventListener('popstate', syncStateFromLocation)
  window.addEventListener('resize', scheduleBodyDisclosureSync)
  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(state.pollTimer)
    if (!document.hidden) void refreshCity()
  })

  state = { ...state, ...readLocationState() }
  syncArchiveControls()
  renderView()
  writeLocation(false)
  void ensureDetail()
  loadSharedGazette()
  void loadDirectory(false)
  void refreshCity()
})()
`
