import { WINDOW_CLIENT_SAFETY_JS } from './window-client-safety.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'
import { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS } from './public-events.ts'

export { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS }

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
        label: `${place.name} · #${place.id}`,
      })
      continue
    }

    const continent = continentFor(place)
    if (!continent) {
      ensureGroup('other', null).options.push({
        id: place.id,
        depth: 0,
        label: `${place.name} · #${place.id}`,
      })
      continue
    }
    const parent = placesById.get(place.parent_id)
    const depth = Math.max(0, parts.length - 2)
    const shortLabel = `${place.name}${depth > 1 && parent ? ` — in ${parent.name}` : ''} · #${place.id}`
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
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []
  const safeLimit = Math.max(0, Math.floor(limit))
  const score = (primary: string, searchText: string, id: number): number | null => {
    const normalizedPrimary = primary.toLowerCase()
    if (
      normalizedQuery === normalizedPrimary || normalizedQuery === String(id) ||
      normalizedQuery === `#${id}` || normalizedQuery === `place #${id}` ||
      normalizedQuery === `resident #${id}`
    ) return 0
    if (normalizedPrimary.startsWith(normalizedQuery)) return 1
    return searchText.toLowerCase().includes(normalizedQuery) ? 2 : null
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
          label: `${place.name} · #${place.id}`,
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
          label: `${resident.handle} · #${resident.id}`,
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

const PUBLIC_EVENT_LABELS_JSON = JSON.stringify(PUBLIC_EVENT_LABELS)
const WORLD_ROOT_NAME_JSON = JSON.stringify(WORLD_ROOT_NAME)
const MERGE_WINDOW_ROWS_JS = mergeWindowRows.toString()
const MERGE_RESIDENT_ROWS_JS = mergeResidentRows.toString()
const WINDOW_PLACE_LABEL_JS = windowPlaceLabel.toString()
const DERIVE_WINDOW_DIRECTORY_PLACES_JS = deriveWindowDirectoryPlaces.toString()
const LIST_WINDOW_DIRECTORY_PLACES_JS = listWindowDirectoryPlaces.toString()
const SEARCH_WINDOW_DIRECTORY_JS = searchWindowDirectory.toString()
const WINDOW_DIRECTORY_PLACE_SCOPE_IDS_JS = windowDirectoryPlaceScopeIds.toString()

export const WINDOW_JS = `(() => {
  'use strict'

  const BASE_REFRESH_MS = 60000
  const MAX_REFRESH_MS = 300000
  const REQUEST_TIMEOUT_MS = 10000
  const MAX_FORWARD_RECONCILE_PAGES = 8
  const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/
  const SAFE_WORLD_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
  const MODERATED_TEXT = '[removed by maintainer]'
  const WORLD_ROOT_NAME = ${WORLD_ROOT_NAME_JSON}
  const VIEWS = Object.freeze(['map', 'place', 'conversations', 'happenings', 'agreements', 'archive'])
  const SAFE_EVENT_KINDS = new Map(Object.entries(${PUBLIC_EVENT_LABELS_JSON}))
  const mergeWindowRows = ${MERGE_WINDOW_ROWS_JS}
  const mergeResidentRows = ${MERGE_RESIDENT_ROWS_JS}
  const windowPlaceLabel = ${WINDOW_PLACE_LABEL_JS}
  const deriveWindowDirectoryPlaces = ${DERIVE_WINDOW_DIRECTORY_PLACES_JS}
  const listWindowDirectoryPlaces = ${LIST_WINDOW_DIRECTORY_PLACES_JS}
  const searchWindowDirectory = ${SEARCH_WINDOW_DIRECTORY_JS}
  const windowDirectoryPlaceScopeIds = ${WINDOW_DIRECTORY_PLACE_SCOPE_IDS_JS}

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
    share: document.getElementById('share-view'),
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
  }
  const tabs = [...document.querySelectorAll('[role="tab"][data-view]')]
  const panels = [...document.querySelectorAll('[role="tabpanel"]')]
  let bodyIdSequence = 0
  let branchRefreshOffset = 0
  let navigationRevision = 0
  let authoredRevision = 0
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
    archive: {
      query: '', mode: 'words', type: 'all', results: [], totalItems: 0,
      totalTextBytes: 0, nextBefore: null, hasMore: false, loading: false,
      initialized: false, error: null,
    },
    view: 'map',
    directorySearch: '',
    directorySearchIndex: -1,
    placeId: null,
    resident: null,
  }

  function element(tagName, className, text) {
    const node = document.createElement(tagName)
    if (className) node.className = className
    if (text !== undefined) node.textContent = String(text)
    return node
  }
${WINDOW_CLIENT_SAFETY_JS}

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
    nodes.status.textContent = message
    nodes.status.dataset.tone = tone
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
      href: '/api/' + type + '/' + String(id),
    })
  }

  function normalizeArchivePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid archive response')
    const rawResults = Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.items) ? payload.items : []
    const results = rawResults.map(normalizeArchiveResult).filter(Boolean).slice(0, 25)
    const nextBefore = safeArchiveCursor(payload.next_before ?? payload.nextBefore)
    return Object.freeze({
      results,
      totalItems: safeCount(payload.total_items ?? payload.totalItems),
      totalTextBytes: safeCount(
        payload.total_text_bytes ?? payload.total_body_bytes ??
          payload.totalTextBytes ?? payload.totalBodyBytes,
      ),
      hasMore: payload.has_more === true || payload.hasMore === true,
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
    const link = element('a', 'archive-open', 'Open original')
    link.href = result.href
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

  async function loadArchive(reset) {
    if (state.archive.loading) return
    const requestAuthoredRevision = authoredRevision
    const formQuery = reset
      ? safeText(nodes.archiveQuery?.value, '', 256, false)
      : state.archive.query
    const mode = reset
      ? safeArchiveChoice(nodes.archiveMode?.value, ['words', 'phrase'], 'words')
      : state.archive.mode
    const type = reset
      ? safeArchiveChoice(nodes.archiveType?.value, ['all', 'note', 'thing'], 'all')
      : state.archive.type
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
      if (authoredRevision !== requestAuthoredRevision) return
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
      if (authoredRevision !== requestAuthoredRevision) return
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
      const actor = safeHandle(raw.actor)
      const verb = SAFE_EVENT_KINDS.get(raw.kind)
      const at = safeDate(raw.at)
      if (!id || !actor || !verb || !at) return []
      const source = raw.detail && typeof raw.detail === 'object' ? raw.detail : {}
      const detail = Object.fromEntries([
        'resident_id', 'place_id', 'thing_id', 'kind_id', 'trait_id', 'agreement_id',
        'note_id', 'transfer_id', 'offer_id', 'target_id', 'asset_id', 'parent_id',
      ].flatMap(key => {
        const value = safeId(source[key])
        return value ? [[key, value]] : []
      }))
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

  async function fetchBranchForwardPage(placeId, beforeId, signal) {
    const url = branchRequestUrl(placeId, {
      initialized: Boolean(beforeId), nextBeforeSubplaceId: beforeId,
    })
    const response = await fetch(url.pathname + url.search, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public map branch unavailable')
    return branchPageFromPayload(await response.json(), placeId)
  }

  async function forwardReconcileBranch(placeId, current, firstPage, signal, takeBudget) {
    const oldIds = new Set(current.rows.map(row => row.id))
    let seen = []
    let beforeId = null
    let collected = []
    let pageResult = firstPage
    let lastParent = firstPage?.parent || null
    for (let pageCount = 0; pageCount < MAX_FORWARD_RECONCILE_PAGES; pageCount += 1) {
      if (!pageResult && !takeBudget()) break
      const result = pageResult || await fetchBranchForwardPage(placeId, beforeId, signal)
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

  async function fetchResidentForwardPage(beforeId, signal) {
    const url = residentRequestUrl({ initialized: Boolean(beforeId), nextBeforeId: beforeId })
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
      const next = await fetchResidentForwardPage(beforeId, signal)
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
        const reconciled = await forwardReconcileBranch(root.id, current, Object.freeze({
          parent: root, rows: root.children, page,
        }), signal, takeReconcileBudget)
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
          placeId, current, null, signal, takeReconcileBudget)
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

  function readHashState() {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const view = params.get('view')
    return {
      view: VIEWS.includes(view) ? view : 'map',
      placeId: safeId(params.get('place')),
      resident: safeHandle(params.get('resident')),
    }
  }

  function viewHash() {
    const params = new URLSearchParams()
    params.set('view', state.view)
    if (state.placeId) params.set('place', String(state.placeId))
    if (state.resident) params.set('resident', state.resident)
    return '#' + params.toString()
  }

  function writeHash(push) {
    const hash = viewHash()
    if (nodes.share) nodes.share.href = hash
    if (window.location.hash === hash) return
    if (push) history.pushState(null, '', hash)
    else history.replaceState(null, '', hash)
  }

  // Deliberate navigation — tabs, choosing a place or resident, filters —
  // creates a real back/forward entry. Background refresh never touches
  // history because renderAll only replaces when the hash is unchanged.
  // Arrow-key roving between tabs updates the address without pushing, so
  // walking the tab list never floods the back button.
  let rovingTabActivation = false
  function navigate(next) {
    state = { ...state, ...next }
    writeHash(!rovingTabActivation)
    renderAll()
    void ensureFocusedSelection()
  }

  function directorySearchSources(snapshot) {
    return state.directory.loaded
      ? { places: state.directory.places, residents: state.directory.residents }
      : { places: snapshot.flatPlaces, residents: snapshot.residents }
  }

  function directorySearchRows(snapshot) {
    const sources = directorySearchSources(snapshot)
    return searchWindowDirectory(
      sources.places,
      sources.residents,
      state.directorySearch,
    )
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
    const results = directorySearchRows(snapshot)
    const placeCount = results.filter(result => result.kind === 'place').length
    const residentCount = results.length - placeCount
    if (!query) {
      nodes.directorySearchStatus.textContent = String(sources.places.length) +
        (sources.places.length === 1 ? ' place and ' : ' places and ') +
        String(sources.residents.length) +
        (sources.residents.length === 1 ? ' resident available.' : ' residents available.')
      nodes.directorySearchResults.replaceChildren()
      closeDirectorySearchResults()
      return
    }

    nodes.directorySearchStatus.textContent = String(results.length) +
      (results.length === 1 ? ' result: ' : ' results: ') +
      String(placeCount) + (placeCount === 1 ? ' place and ' : ' places and ') +
      String(residentCount) + (residentCount === 1 ? ' resident.' : ' residents.')
    if (!results.length) {
      const empty = element('div', 'directory-search-empty', 'No places or residents match this search.')
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
    const places = state.directory.loaded ? state.directory.places : snapshot.flatPlaces
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
        const selected = places.find(place => place.id === state.placeId)
        const option = element('option', '', selected
          ? selected.name + ' · #' + String(selected.id)
          : 'Place #' + String(state.placeId) + ' · not currently loaded')
        option.value = String(state.placeId)
        options.push(option)
      }
      nodes.placeFilter.replaceChildren(...options)
      nodes.placeFilter.value = state.placeId ? String(state.placeId) : ''
    }
    if (nodes.residentFilter) {
      const residents = state.directory.loaded ? state.directory.residents : snapshot.residents
      const missingResident = state.resident && !residents.some(resident => resident.handle === state.resident)
        ? [element('option', '', state.resident + ' · not currently loaded')]
        : []
      if (missingResident[0]) missingResident[0].value = state.resident
      const options = [element('option', '', 'All residents'), ...residents.map(resident => {
        const option = element('option', '', resident.handle + ' · #' + String(resident.id))
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
      ? snapshot.residents.find(resident => resident.handle === state.resident) || null
      : null
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
    return directoryPlace(placeId) ||
      snapshot.flatPlaces.find(place => place.id === placeId) || null
  }

  function focusedPlace(placeId) {
    if (!placeId) return null
    const place = state.focusedPlaces[String(placeId)]?.place || null
    const reference = directoryPlace(placeId)
    return place && reference
      ? Object.freeze({ ...place, path: reference.path })
      : place
  }

  function focusedResident(handle) {
    return handle ? state.focusedResidents[handle]?.resident || null : null
  }

  function selectedPlace(snapshot) {
    const followed = selectedResident(snapshot)
    const id = state.placeId || (followed && followed.current_place_id) || null
    return id ? snapshot.flatPlaces.find(place => place.id === id) || null : null
  }

  function residentsAt(snapshot, placeId) {
    const placeIds = placeScopeSet(placeId, snapshot)
    return snapshot.residents.filter(resident => placeIds.has(resident.current_place_id) &&
      (!state.resident || resident.handle === state.resident))
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
      if (requestMarker && !markerCovers(payload?.change_marker, requestMarker)) {
        throw new Error('public map branch does not cover the current change marker')
      }
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
      item.append(element('p', '', 'No more places are currently loaded inside ' + place.name + '.'))
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
      card.append(
        watch,
        element('span', 'place-owner', place.owner
          ? 'kept by ' + place.owner
          : 'unowned · transit only'),
        element('span', 'place-facts', String(place.places) + ' inside · ' +
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
      const occupants = residentsAt(snapshot, place.id)
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
    const roots = mapRoots(snapshot)
    if (!roots.length) {
      const missing = state.placeId
        ? 'Place #' + String(state.placeId) + ' is not currently loaded in this bounded view.'
        : state.resident
          ? 'Resident ' + state.resident + ' is not currently loaded in this bounded view.'
          : 'No public place in the currently loaded view matches this filter.'
      renderEmpty(nodes.map, 'empty-row', missing)
      return
    }
    nodes.map.replaceChildren(placeList(roots, snapshot, 0))
  }

  function residentRequestUrl(entry) {
    const url = new URL('/api/residents', window.location.origin)
    url.searchParams.set('view', 'presence')
    url.searchParams.set('limit', '25')
    if (entry.initialized && entry.nextBeforeId) {
      url.searchParams.set('before_id', String(entry.nextBeforeId))
    }
    return url
  }

  async function loadResidents() {
    const current = state.residentPaging
    if (!state.snapshot || current.loading || (!current.hasMore && !current.error)) return
    const requestAuthoredRevision = authoredRevision
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
      const url = residentRequestUrl(requestEntry)
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
    const selectedPlaceIds = state.placeId ? placeScopeSet(state.placeId, snapshot) : null
    const selectedFocusedResident = state.resident && !selectedResident(snapshot)
      ? focusedResident(state.resident)
      : null
    const availableResidents = selectedFocusedResident
      ? [...snapshot.residents, selectedFocusedResident]
      : snapshot.residents
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
          ? 'Place #' + String(placeId) + ' · not currently loaded'
          : 'Between places'))
      const standing = visible.filter(candidate => candidate.current_place_id === placeId)
      for (const resident of [...standing.filter(r => !r.asleep), ...standing.filter(r => r.asleep)]) {
        const row = element('div', resident.asleep ? 'resident-row asleep' : 'resident-row')
        const follow = element('button', 'resident-follow', resident.handle)
        follow.type = 'button'
        follow.dataset.focusKey = 'roster:' + resident.handle
        follow.addEventListener('click', () => chooseResident(resident.handle))
        row.append(follow, element('span', 'resident-number',
          '#' + String(resident.id) + (resident.asleep ? ' · asleep' : '')))
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

  // A handle earns a button only when the roster can resolve it: chooseResident
  // ignores an unknown handle, and a control that does nothing is worse than
  // plain text.
  function residentNode(handle, className, focusKey) {
    const known = state.snapshot &&
      state.snapshot.residents.some(candidate => candidate.handle === handle)
    if (!known) return element('span', className, handle)
    const follow = element('button', className + ' resident-follow-inline', handle)
    follow.type = 'button'
    follow.dataset.focusKey = focusKey
    follow.title = 'Follow ' + handle
    follow.addEventListener('click', () => chooseResident(handle))
    return follow
  }

  function renderExpandableBody(kind, id, body, truncated) {
    const block = element('div', 'body-block')
    const bodyNode = element('p', kind + '-body public-body', body + (truncated ? '…' : ''))
    const bodyId = 'public-body-' + kind + '-' + String(id) + '-' + String(++bodyIdSequence)
    const bodyKey = kind + ':' + String(id)
    const startExpanded = state.expandedBodies.includes(bodyKey)
    bodyNode.id = bodyId
    bodyNode.dataset.expanded = String(startExpanded)
    bodyNode.dataset.bodyKey = bodyKey
    block.append(bodyNode)

    let availability = null
    if (truncated) {
      // The bounded view caps every body: Excerpt only — this bounded view carries only the first part.
      // "Show more" can only reveal the excerpt it was handed. Point at the endpoint that serves the whole
      // text instead of inflating every default read to carry it.
      const fullPath = kind === 'note' || kind === 'thing'
        ? '/api/' + kind + '/' + String(id)
        : null
      availability = element('p', 'body-availability')
      availability.append(document.createTextNode(
        'Excerpt only — the full text is not included in this bounded view. '))
      if (fullPath) {
        const link = element('a', 'body-full-link', 'Read the whole ' + kind + ' →')
        link.href = fullPath
        link.rel = 'nofollow'
        availability.append(link)
      } else {
        availability.append(document.createTextNode(
          'The full text is not served through the glass.'))
      }
      availability.id = bodyId + '-availability'
      block.append(availability)
    }

    // The browser decides whether the five-line clamp actually hides text.
    // Keep the control hidden until the connected element can be measured.
    const disclosure = element('button', 'body-disclosure',
      startExpanded ? 'Show less' : 'Show more')
    disclosure.type = 'button'
    disclosure.hidden = true
    disclosure.setAttribute('aria-expanded', String(startExpanded))
    disclosure.setAttribute('aria-controls', bodyId)
    disclosure.dataset.focusKey = 'body:' + bodyKey
    if (availability) disclosure.setAttribute('aria-describedby', availability.id)
    disclosure.addEventListener('click', () => {
      const expanded = !state.expandedBodies.includes(bodyKey)
      state = {
        ...state,
        expandedBodies: expanded
          ? [...state.expandedBodies, bodyKey]
          : state.expandedBodies.filter(key => key !== bodyKey),
      }
      bodyNode.dataset.expanded = String(expanded)
      disclosure.setAttribute('aria-expanded', String(expanded))
      disclosure.textContent = expanded ? 'Show less' : 'Show more'
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
      if (!bodyNode || !disclosure || !bodyKey) continue
      bodyNode.dataset.expanded = 'false'
      entries.push({ bodyNode, disclosure, bodyKey })
    }

    const collapsedHeights = entries.map(entry => entry.bodyNode.getBoundingClientRect().height)
    for (const entry of entries) entry.bodyNode.dataset.expanded = 'true'
    const expandedHeights = entries.map(entry => entry.bodyNode.getBoundingClientRect().height)

    entries.forEach((entry, index) => {
      const collapsible = expandedHeights[index] > collapsedHeights[index] + 1
      const expanded = collapsible && state.expandedBodies.includes(entry.bodyKey)
      entry.bodyNode.dataset.expanded = String(!collapsible || expanded)
      entry.disclosure.hidden = !collapsible
      entry.disclosure.setAttribute('aria-expanded', String(expanded))
      entry.disclosure.textContent = expanded ? 'Show less' : 'Show more'
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
      renderEmpty(target, 'empty-row', 'No visible thing in the current bounded public view matches this selection.')
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
      item.append(element('h4', '', thing.name), thingMeta)
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
        'No owner-chosen front matter is currently available.',
      )
      return
    }
    const list = element('ol', 'front-matter-list')
    list.setAttribute('aria-labelledby', 'place-front-matter-title')
    list.append(...place.front_matter.map(heading => {
      const item = element('li', 'front-matter-heading')
      const link = element('a', 'front-matter-link', heading.name)
      link.href = '/api/thing/' + String(heading.id)
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
      (state.placeId ? focusedPlace(state.placeId) : null) ||
      (!state.resident && !state.placeId ? snapshot.flatPlaces[0] || null : null)
    if (!place) {
      const residentMetadata = followed || focusedResident(state.resident)
      const focused = focusedPlace(state.placeId)
      const betweenPlaces = residentMetadata && residentMetadata.current_place_id === null
      const unloadedPlaceId = state.placeId || residentMetadata?.current_place_id || null
      const unloadedResident = state.resident && !residentMetadata ? state.resident : null
      const reference = directoryPlace(unloadedPlaceId)
      const placeRead = unloadedPlaceId ? state.focusedPlaces[String(unloadedPlaceId)] : null
      const residentRead = unloadedResident ? state.focusedResidents[unloadedResident] : null
      if (nodes.placeTitle) nodes.placeTitle.textContent = unloadedPlaceId
        ? focused?.name || reference?.name || 'Place #' + String(unloadedPlaceId) + ' is not currently loaded'
        : unloadedResident
          ? 'Resident ' + unloadedResident + ' is not currently loaded'
          : residentMetadata?.handle + ' is between places'
      if (nodes.placeSummary) nodes.placeSummary.textContent = unloadedPlaceId
        ? (focused?.path || reference?.path || 'Place #' + String(unloadedPlaceId)) +
          (focused
            ? ' · focused metadata loaded; contents are not currently loaded.'
            : placeRead?.loading
              ? ' · loading focused metadata…'
              : ' · metadata and content are not currently loaded in this bounded view.')
        : unloadedResident
          ? residentRead?.loading
            ? 'Loading their current public presence…'
            : 'Their metadata and current place are not currently loaded in this bounded view.'
          : 'This resident is not currently standing in a public place.'
      renderPlaceOrientation(focused)
      if (placeRead?.error && nodes.placePurpose) {
        const alert = element('div', 'selection-error')
        alert.setAttribute('role', 'alert')
        alert.append(element('p', '', 'Could not load focused metadata for this place.'))
        const retry = element('button', 'selection-retry', 'Retry loading this place')
        retry.type = 'button'
        retry.dataset.focusKey = 'focused-place-retry:' + String(unloadedPlaceId)
        retry.dataset.focusFallbackId = 'place-focus-title'
        retry.addEventListener('click', () => void loadFocusedPlace(unloadedPlaceId))
        alert.append(retry)
        nodes.placePurpose.replaceChildren(alert)
      }
      if (residentRead?.error && nodes.placePurpose) {
        const alert = element('div', 'selection-error')
        alert.setAttribute('role', 'alert')
        alert.append(element('p', '', 'Could not load focused presence for this resident.'))
        const retry = element('button', 'selection-retry', 'Retry loading this resident')
        retry.type = 'button'
        retry.dataset.focusKey = 'focused-resident-retry:' + unloadedResident
        retry.dataset.focusFallbackId = 'place-focus-title'
        retry.addEventListener('click', () => void loadFocusedResident(unloadedResident))
        alert.append(retry)
        nodes.placePurpose.replaceChildren(alert)
      }
      renderEmpty(nodes.occupants, 'empty-row', betweenPlaces
        ? 'There is no doorway around this resident right now.'
        : 'Presence at this unloaded address is not shown.')
      renderEmpty(nodes.placeThings, 'empty-row', unloadedPlaceId
        ? 'Things at this address are not currently loaded.'
        : 'No loaded place is selected for visible things.')
      renderEmpty(nodes.placeConversation, 'empty-row', unloadedPlaceId || unloadedResident
        ? 'Conversation content for this selection is not currently loaded.'
        : 'No loaded place is selected for conversation.')
      if (nodes.placeThingsPage) nodes.placeThingsPage.hidden = true
      if (nodes.placeNotesPage) nodes.placeNotesPage.hidden = true
      return
    }
    if (nodes.placeTitle) nodes.placeTitle.textContent = place.name
    if (nodes.placeSummary) nodes.placeSummary.textContent = place.path + (place.owner
      ? ' · kept by ' + place.owner
      : ' · nobody owns it · transit only') +
      (state.placeId ? ' · showing this place and everything inside it' : '')
    renderPlaceOrientation(place)
    renderPeople(
      nodes.occupants,
      residentsAt(snapshot, place.id),
      placeId => placeReference(snapshot, placeId),
    )
    const filters = Object.freeze({ placeId: place.id, resident: state.resident })
    autoLoadFilteredHistory('things', filters, historyEntry('things', filters))
    autoLoadFilteredHistory('notes', filters, historyEntry('notes', filters))
    renderThings(
      nodes.placeThings,
      historyEntry('things', filters).rows,
      placeId => placeReference(snapshot, placeId),
    )
    renderNotes(nodes.placeConversation, historyEntry('notes', filters).rows,
      'No conversation in the current bounded public view matches here.',
      placeId => placeReference(snapshot, placeId))
    renderHistoryControl(nodes.placeThingsPage, 'things', 'things', filters)
    renderHistoryControl(nodes.placeNotesPage, 'notes', 'notes', filters)
  }

  function renderConversations(snapshot) {
    if (!nodes.conversations) return
    // Following one resident fetches their bounded server-side slice plus
    // same-place context, so an active resident never looks falsely silent
    // just because the newest city-wide page missed them.
    const filters = Object.freeze({
      placeId: state.placeId,
      resident: state.resident,
      context: Boolean(state.resident),
    })
    const followed = selectedResident(snapshot)
    const place = state.placeId
      ? placeReference(snapshot, state.placeId)
      : null
    if (state.placeId && !place) {
      const reference = placeReference(snapshot, state.placeId)
      renderEmpty(nodes.conversations, 'empty-row', (reference?.path || 'Place #' + String(state.placeId)) +
        ' · metadata and conversation are not currently loaded in this bounded view.')
      if (nodes.conversationPage) {
        nodes.conversationPage.hidden = true
        nodes.conversationPage.replaceChildren()
      }
      return
    }
    if (state.resident && !followed) {
      renderEmpty(nodes.conversations, 'empty-row', 'Resident ' + state.resident +
        ' metadata and conversation are not currently loaded in this bounded view.')
      if (nodes.conversationPage) {
        nodes.conversationPage.hidden = true
        nodes.conversationPage.replaceChildren()
      }
      return
    }
    autoLoadFilteredHistory('notes', filters, historyEntry('notes', filters))
    const entry = historyEntry('notes', filters)
    const notes = entry.rows
    const placeOf = placeId => placeReference(snapshot, placeId)
    if (!notes.length || (state.placeId && !place)) {
      renderEmpty(nodes.conversations, 'empty-row', entry.loading
        ? 'Fetching this conversation…'
        : 'No conversation in the current bounded public view matches this selection.')
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
      // Every room at once. The server pages notes newest first, so retain that
      // order and name each room without regrouping the stream by place. When
      // following a resident, what others said in the same room stays visible
      // as marked context — a contextual view, not a reply thread.
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
        if (state.resident && note.author !== state.resident) {
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

  function renderActivity(snapshot) {
    if (!nodes.activity) return
    const filters = Object.freeze({ placeId: state.placeId, resident: state.resident })
    // Kick the auto-load before reading the entry: loadHistory stores
    // loading:true synchronously, so this render already says "fetching"
    // instead of falsely reporting an empty view.
    autoLoadFilteredHistory('events', filters, historyEntry('events', filters))
    const entry = historyEntry('events', filters)
    const events = entry.rows
    if (!events.length) {
      nodes.activity.replaceChildren(element('li', 'empty-row',
        entry.loading
          ? 'Fetching happenings that match this view…'
          : 'No happening in the current bounded public view matches this selection.'))
      renderHistoryControl(nodes.happeningsPage, 'events', 'happenings', filters)
      return
    }
    const rows = events.map(event => {
      const row = element('li', 'activity-row')
      const copy = element('p', 'activity-copy')
      copy.append(
        residentNode(event.actor, 'activity-actor', 'activity-actor:' + String(event.id)),
        element('span', '', ' ' + event.verb + '.'),
      )
      row.append(copy, timeNode(event.at, 'activity-time'))
      const placeId = eventPlaceId(event, snapshot)
      const place = placeReference(snapshot, placeId)
      const location = windowPlaceLabel(placeId, place)
      if (location) row.append(element('span', 'activity-context', 'Observed at ' + location))
      return row
    })
    nodes.activity.replaceChildren(...rows)
    renderHistoryControl(nodes.happeningsPage, 'events', 'happenings', filters)
  }

  function renderAgreements(snapshot) {
    if (!nodes.agreements) return
    const filters = Object.freeze({ placeId: null, resident: state.resident })
    const agreements = historyEntry('agreements', filters).rows
    if (!agreements.length) {
      renderEmpty(nodes.agreements, 'empty-row', 'No agreement in the current bounded public view matches this resident selection.')
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
    if (!entry.hasMore && !entry.loading && !entry.error) {
      target.hidden = true
      target.replaceChildren()
      return
    }
    // While the first filtered slice is being fetched nothing "older" is
    // involved yet; every click-driven state keeps the familiar wording.
    const older = entry.loading && !entry.initialized ? '' : 'older '
    const text = entry.loading
      ? 'Loading ' + older + label + '…'
      : entry.error ? 'Retry loading ' + older + label : 'Load ' + older + label
    const button = element('button', 'history-load', text)
    button.type = 'button'
    // Never disabled: a disabled control cannot take restored focus, and
    // loadHistory already ignores clicks while a fetch is in flight.
    button.setAttribute('aria-busy', String(entry.loading))
    button.dataset.focusKey = 'load:' + collection + ':' + historyKey(collection, filters)
    button.addEventListener('click', () => void loadHistory(collection, filters))
    target.hidden = false
    target.replaceChildren(button)
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
      if (!response.ok) return
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision) return
      if (requestMarker && !markerCovers(payload?.change_marker, requestMarker)) return
      const incoming = normalizeHistoryRows(collection, payload)
      const latest = historyEntry(collection, filters)
      setHistoryEntry(collection, filters, {
        ...latest,
        rows: mergeWindowRows(latest.rows, incoming),
      })
      renderAll()
    } catch {
      // A failed silent refresh loses nothing; the next snapshot tries again.
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
        placeId: state.placeId, resident: state.resident, context: true,
      })
      const entry = historyEntry('notes', filters)
      if (!entry.initialized || entry.loading) return
      void forwardRefreshHistory('notes', filters)
    }
  }

  async function loadHistory(collection, filters) {
    const current = historyEntry(collection, filters)
    if (current.loading || (current.initialized && !current.hasMore && !current.error)) return
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    setHistoryEntry(collection, filters, { ...current, loading: true, error: false })
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
      if (requestMarker && !markerCovers(payload?.change_marker, requestMarker)) {
        throw new Error('public history does not cover the current change marker')
      }
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

  function renderCounts(snapshot) {
    if (!nodes.counts) return
    nodes.counts.textContent = String(snapshot.totals.places) + ' places · ' +
      String(snapshot.totals.residents) + ' residents · ' + String(snapshot.totals.things) +
      ' things · ' + String(snapshot.totals.conversations) + ' notes · public and read only'
  }

  function renderScope(snapshot) {
    if (!nodes.scope) return
    const labels = {
      places: 'places', residents: 'residents', conversations: 'conversations',
      things: 'things', agreements: 'agreements', events: 'happenings',
    }
    const partial = Object.keys(labels).filter(key => snapshot.totals[key] > snapshot.shown[key])
      .map(key => (key === 'places' || key === 'residents' ? 'currently loaded ' : '') +
        String(snapshot.shown[key]) + ' of ' + String(snapshot.totals[key]) + ' ' + labels[key])
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
    // Following a resident fetches conversations beyond the initial bounded
    // view, so its initial counts describe a different set than the list on screen.
    // Report what the reader is actually looking at rather than leaving the
    // two numbers to be read as one.
    const followedRows = state.resident
      ? historyEntry('notes', Object.freeze({
        placeId: state.placeId, resident: state.resident, context: true,
      })).rows
      : []
    const ownRows = followedRows.filter(note => note.author === state.resident).length
    const followNotice = state.resident && followedRows.length
      ? ' Conversations below include separately fetched context beyond the initial bounded view: ' +
        String(ownRows) + (ownRows === 1 ? ' note' : ' notes') + ' by ' + state.resident +
        ' plus ' + String(followedRows.length - ownRows) + ' from the same rooms.'
      : ''
    const directoryNotice = state.directory.loaded
      ? ' Selectors use the complete city directory; map, presence, and authored content remain currently loaded views.'
      : ' Selectors currently use the loaded fallback while the complete city directory is unavailable.'
    nodes.scope.textContent = (partial.length
      ? 'Current bounded public view shows ' + partial.join(' · ') + '.'
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
    for (const tab of tabs) {
      const active = tab.dataset.view === state.view
      tab.setAttribute('aria-selected', String(active))
      tab.tabIndex = active ? 0 : -1
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
    writeHash()
    if (state.view === 'archive') renderArchive()
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
    navigate({ resident: handle, directorySearch: '', directorySearchIndex: -1 })
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
    state = {
      ...state,
      focusedPlaces: {
        ...state.focusedPlaces,
        [String(placeId)]: Object.freeze({
          loading: true,
          error: false,
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
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('focused place unavailable')
      const payload = await response.json()
      const [normalized] = normalizePlaces([payload?.place], 0, new Set())
      if (!normalized || normalized.id !== placeId) throw new Error('wrong focused place')
      const reference = directoryPlace(placeId)
      const place = Object.freeze({
        ...normalized,
        children: [],
        path: reference?.path || normalized.name + ' · Place #' + String(placeId),
      })
      state = {
        ...state,
        focusedPlaces: {
          ...state.focusedPlaces,
          [String(placeId)]: Object.freeze({
            loading: false,
            error: false,
            marker: state.changeMarker || null,
            place,
          }),
        },
      }
    } catch {
      state = {
        ...state,
        focusedPlaces: {
          ...state.focusedPlaces,
          [String(placeId)]: Object.freeze({
            loading: false,
            error: !current?.place,
            marker: current?.marker || null,
            place: current?.place || null,
          }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      renderAll()
    }
  }

  async function loadFocusedResident(handle, force) {
    if (!state.snapshot || state.snapshot.residents.some(resident => resident.handle === handle)) return
    const current = state.focusedResidents[handle]
    if (current?.loading || (!force && current?.resident)) return
    state = {
      ...state,
      focusedResidents: {
        ...state.focusedResidents,
        [handle]: Object.freeze({
          loading: true,
          error: false,
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
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('focused resident unavailable')
      const payload = await response.json()
      const [resident] = normalizeResidents([payload?.resident])
      if (!resident || resident.handle !== handle) throw new Error('wrong focused resident')
      state = {
        ...state,
        focusedResidents: {
          ...state.focusedResidents,
          [handle]: Object.freeze({
            loading: false,
            error: false,
            marker: state.changeMarker || null,
            resident,
          }),
        },
      }
    } catch {
      state = {
        ...state,
        focusedResidents: {
          ...state.focusedResidents,
          [handle]: Object.freeze({
            loading: false,
            error: !current?.resident,
            marker: current?.marker || null,
            resident: current?.resident || null,
          }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      renderAll()
    }
  }

  async function ensureFocusedSelection(options) {
    const forcePlace = options?.forcePlace === true
    const forceResident = options?.forceResident === true
    if (!state.snapshot) return
    if (state.placeId && !state.snapshot.flatPlaces.some(place => place.id === state.placeId)) {
      const entry = state.focusedPlaces[String(state.placeId)]
      if (!entry || forcePlace) await loadFocusedPlace(state.placeId, forcePlace)
    }
    if (state.resident && !state.snapshot.residents.some(resident => resident.handle === state.resident)) {
      const entry = state.focusedResidents[state.resident]
      if (!entry || forceResident) await loadFocusedResident(state.resident, forceResident)
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

  async function refreshUnchangedPresence(signal) {
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

  async function refreshCity() {
    if (state.refreshing) return
    const hadSnapshot = state.hasSnapshot
    const navigationRevisionAtStart = navigationRevision
    state = { ...state, refreshing: true }
    setStatus(state.hasSnapshot ? 'Checking the streets…' : 'Opening the shutters…', 'working')
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
          const residents = await refreshUnchangedPresence(controller.signal)
          if (navigationRevision !== navigationRevisionAtStart) {
            setStatus('Watching the public streets', 'live')
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
          setStatus('Watching · no persisted changes', 'live')
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
        setStatus('Watching the public streets', 'live')
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
        changeMarker: freshSnapshot.changeMarker || requiredMarker,
        hasSnapshot: true,
        failures: 0,
      }
      populateFilters(snapshot)
      renderAll()
      if (hadSnapshot && replaceAuthored &&
          (state.directory.loaded || state.directory.error) && !state.directory.loading) {
        void loadDirectory(true)
      }
      void ensureFocusedSelection({ forcePlace: replaceAuthored, forceResident: true })
      refreshFilteredViews()
      setStatus(snapshot.refreshedAt ? 'Watching · checked ' + snapshot.refreshedAt.toLocaleTimeString([], {
        hour: 'numeric', minute: '2-digit',
      }) : 'Watching the public streets', 'live')
    } catch {
      const failures = state.failures + 1
      state = { ...state, failures }
      nextDelay = Math.min(BASE_REFRESH_MS * Math.pow(2, failures), MAX_REFRESH_MS)
      if (state.hasSnapshot) {
        setStatus('Watching an older view · trying again soon', 'stale')
      } else {
        setStatus('The glass fogged up', 'error')
        for (const target of [nodes.map, nodes.roster, nodes.placePurpose, nodes.placeFrontMatter,
          nodes.occupants, nodes.placeThings, nodes.placeConversation, nodes.conversations,
          nodes.agreements]) {
          renderEmpty(target, 'error-row', 'The current public city view could not be read. Try again in one minute.')
        }
        if (nodes.activity) nodes.activity.replaceChildren(element('li', 'error-row', 'The public ledger could not be read.'))
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
      let placeId = state.placeId
      if (view === 'place' && !state.resident && !state.placeId &&
        !selectedPlace(state.snapshot || { residents: [], flatPlaces: [] })) {
        placeId = state.snapshot?.flatPlaces[0]?.id || null
      }
      navigate({ view, placeId })
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

  nodes.directorySearch?.addEventListener('input', () => {
    state = {
      ...state,
      directorySearch: String(nodes.directorySearch.value || '').slice(0, 100),
      directorySearchIndex: 0,
    }
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
    })
    if (state.snapshot) populateFilters(state.snapshot)
  })
  nodes.residentFilter?.addEventListener('change', () => {
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      resident: safeHandle(nodes.residentFilter.value),
      directorySearch: '',
      directorySearchIndex: -1,
    })
  })
  nodes.archiveSearch?.addEventListener('click', () => void loadArchive(true))
  nodes.archiveQuery?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void loadArchive(true)
  })
  function syncStateFromLocation() {
    state = { ...state, ...readHashState() }
    renderAll()
    void ensureFocusedSelection()
  }
  window.addEventListener('hashchange', syncStateFromLocation)
  window.addEventListener('popstate', syncStateFromLocation)
  window.addEventListener('resize', scheduleBodyDisclosureSync)
  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(state.pollTimer)
    if (!document.hidden) void refreshCity()
  })

  state = { ...state, ...readHashState() }
  renderView()
  writeHash()
  void loadDirectory(false)
  void refreshCity()
})()
`
