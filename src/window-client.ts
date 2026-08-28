import { WINDOW_CLIENT_SAFETY_JS } from './window-client-safety.ts'
import { containsMalformedPublicText } from './input.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'
import { BASIC_ACTIONS } from './physics.ts'
import {
  PUBLIC_EVENT_DETAIL_ID_FIELDS,
  PUBLIC_EVENT_KINDS,
  PUBLIC_EVENT_LABELS,
} from './public-events.ts'
import {
  validateWindowArchiveQuery,
  validateWindowDirectorySearch,
  windowSharePath,
} from './window-sharing.ts'

export { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS }

export type WindowDrawing = Readonly<{
  palette: readonly string[]
  indices: readonly (number | null)[]
}>

export function normalizeWindowDrawing(value: unknown): WindowDrawing | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const fields = Object.keys(candidate).sort()
  if (fields.length !== 2 || fields[0] !== 'indices' || fields[1] !== 'palette') return null
  if (!Array.isArray(candidate.palette) || candidate.palette.length > 64 ||
      !candidate.palette.every(colour => typeof colour === 'string' && /^#[0-9a-f]{6}$/u.test(colour))) {
    return null
  }
  if (!Array.isArray(candidate.indices) || candidate.indices.length !== 64 ||
      !candidate.indices.every(index => index === null || (
        typeof index === 'number' && Number.isInteger(index) && index >= 0 &&
        index < (candidate.palette as unknown[]).length
      ))) return null
  try {
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > 2_048) return null
  } catch {
    return null
  }
  return Object.freeze({
    palette: Object.freeze([...(candidate.palette as string[])]),
    indices: Object.freeze([...(candidate.indices as Array<number | null>)]),
  })
}

export function windowLivePlateChildren<T extends Readonly<{
  id: number
  parent_id: number | null
}>>(values: readonly T[], parentId: number): T[] {
  return values.filter(value => value.parent_id === parentId)
    .sort((left, right) => left.id - right.id)
}

export function windowLiveSurveyedPlots<T extends Readonly<{
  id: number
  parent_id: number | null
}>>(values: readonly T[], parentId: number): ReadonlyArray<Readonly<{
  id: number
  x: number
  y: number
  width: number
  height: number
}>> {
  const columns = 4
  const width = 210
  const height = 140
  const horizontalGap = 34
  const verticalGap = 46
  const left = 64
  const top = 184
  return Object.freeze(windowLivePlateChildren(values, parentId).map((place, index) =>
    Object.freeze({
      id: place.id,
      x: left + (index % columns) * (width + horizontalGap),
      y: top + Math.floor(index / columns) * (height + verticalGap),
      width,
      height,
    })))
}

export function windowLiveCapacitySelection<T extends Readonly<{ id: number }>>(
  rows: readonly T[],
  capacity: number,
  pinnedIds: readonly number[],
  exactTotal = rows.length,
): Readonly<{ visible: readonly T[]; overflowCount: number }> {
  const limit = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0
  const total = Number.isSafeInteger(exactTotal) && exactTotal >= rows.length
    ? exactTotal
    : rows.length
  const availableIds = new Set(rows.map(row => row.id))
  const selected = new Set<number>()
  for (const id of pinnedIds) {
    if (selected.size >= limit) break
    if (availableIds.has(id)) selected.add(id)
  }
  for (const row of rows) {
    if (selected.size >= limit) break
    selected.add(row.id)
  }
  const visible = Object.freeze(rows.filter(row => selected.has(row.id)))
  return Object.freeze({ visible, overflowCount: Math.max(0, total - visible.length) })
}

export function windowLivePollDelay(hadEvents: boolean, quietReads: number): number {
  if (hadEvents) return 25000
  return [60000, 120000, 240000, 300000][Math.min(3, Math.max(0, quietReads))]!
}

export function windowLiveTraceOpacity(at: number, now: number, lifetime: number): number {
  if (!Number.isFinite(at) || !Number.isFinite(now) || !Number.isFinite(lifetime) || lifetime <= 0) {
    return 0
  }
  return Math.max(0, Math.min(1, 1 - Math.max(0, now - at) / lifetime))
}

export function windowLiveFitScale(
  viewportWidth: number,
  viewportHeight: number,
  stageWidth: number,
  stageHeight: number,
  maximumScale: number,
  padding = 24,
): number | null {
  if (![viewportWidth, viewportHeight, stageWidth, stageHeight, maximumScale, padding]
    .every(Number.isFinite) || stageWidth <= 0 || stageHeight <= 0 || maximumScale <= 0 ||
      padding < 0) return null
  return Math.min(
    maximumScale,
    Math.max(1, viewportWidth - padding) / stageWidth,
    Math.max(1, viewportHeight - padding) / stageHeight,
  )
}

export function windowLiveClampZoomScale(
  requestedScale: number,
  currentScale: number,
  fullSurveyScale: number,
  maximumScale: number,
): number {
  if (![requestedScale, currentScale, fullSurveyScale, maximumScale].every(Number.isFinite) ||
      currentScale <= 0 || fullSurveyScale <= 0 || maximumScale <= 0) return currentScale
  return Math.max(
    Math.min(currentScale, fullSurveyScale),
    Math.min(maximumScale, requestedScale),
  )
}

export function windowLivePruneTrailStarts(
  starts: Readonly<Record<string, number>>,
  now: number,
  lifetime: number,
  protectedKeys: readonly string[] = [],
): Readonly<Record<string, number>> {
  if (!Number.isFinite(now) || !Number.isFinite(lifetime) || lifetime <= 0) return starts
  const protectedSet = new Set(protectedKeys)
  const entries = Object.entries(starts).filter(([key, at]) =>
    protectedSet.has(key) || windowLiveTraceOpacity(at, now, lifetime) > 0)
  return entries.length === Object.keys(starts).length
    ? starts
    : Object.freeze(Object.fromEntries(entries))
}

export function windowLiveReplayDuration(
  distance: number,
  remainingLifetime = Number.POSITIVE_INFINITY,
): number {
  const duration = !Number.isFinite(distance)
    ? 3_200
    : Math.round(Math.min(8_000, Math.max(3_200, 3_200 + Math.max(0, distance) * 42)))
  if (Number.isNaN(remainingLifetime) || remainingLifetime < 3_200) return 0
  return Math.min(duration, Math.floor(remainingLifetime))
}

export function windowLiveReplayOrder<T extends Readonly<{
  change_id?: string
  id?: number
  at: Date
}>>(values: readonly T[], cutoff: number): T[] {
  return values.filter(value => value.at.getTime() >= cutoff).sort((left, right) => {
    const leftIsChange = left.change_id !== undefined
    const rightIsChange = right.change_id !== undefined
    if (leftIsChange !== rightIsChange) return leftIsChange ? 1 : -1
    if (left.change_id !== undefined && right.change_id !== undefined) {
      const leftMarker = BigInt(left.change_id)
      const rightMarker = BigInt(right.change_id)
      return leftMarker < rightMarker ? -1 : leftMarker > rightMarker ? 1 : 0
    }
    if (left.id !== undefined && right.id !== undefined) return left.id - right.id
    return left.at.getTime() - right.at.getTime()
  })
}

export function windowLiveSpeechLine(value: string, maximum = 60): string {
  const [firstLine = ''] = value.split(/\r\n?|\n/u, 1)
  const characters = Array.from(firstLine)
  if (characters.length <= maximum) return firstLine
  return characters.slice(0, Math.max(0, maximum - 1)).join('') + '…'
}

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
const NORMALIZE_WINDOW_DRAWING_JS = normalizeWindowDrawing.toString()
const WINDOW_LIVE_PLATE_CHILDREN_JS = windowLivePlateChildren.toString()
const WINDOW_LIVE_SURVEYED_PLOTS_JS = windowLiveSurveyedPlots.toString()
const WINDOW_LIVE_CAPACITY_SELECTION_JS = windowLiveCapacitySelection.toString()
const WINDOW_LIVE_POLL_DELAY_JS = windowLivePollDelay.toString()
const WINDOW_LIVE_TRACE_OPACITY_JS = windowLiveTraceOpacity.toString()
const WINDOW_LIVE_FIT_SCALE_JS = windowLiveFitScale.toString()
const WINDOW_LIVE_CLAMP_ZOOM_SCALE_JS = windowLiveClampZoomScale.toString()
const WINDOW_LIVE_PRUNE_TRAIL_STARTS_JS = windowLivePruneTrailStarts.toString()
const WINDOW_LIVE_REPLAY_DURATION_JS = windowLiveReplayDuration.toString()
const WINDOW_LIVE_REPLAY_ORDER_JS = windowLiveReplayOrder.toString()
const WINDOW_LIVE_SPEECH_LINE_JS = windowLiveSpeechLine.toString()

export const WINDOW_JS = `(() => {
  'use strict'

  const BASE_REFRESH_MS = 60000
  const MAX_REFRESH_MS = 300000
  const LIVE_MOVE_LIFETIME_MS = 1800000
  const LIVE_NOTE_LIFETIME_MS = 600000
  const LIVE_TRAIL_LIFETIME_MS = 4_500
  const LIVE_ABSORPTION_MS = 900
  const LIVE_PULSE_MS = 600
  const LIVE_NOTE_REPLAY_MS = 650
  const LIVE_NOTE_FETCH_CONCURRENCY = 4
  const LIVE_NOTE_QUEUE_LIMIT = 16
  const LIVE_DRAWING_FETCH_CONCURRENCY = 4
  const LIVE_DRAWING_QUEUE_LIMIT = 32
  const LIVE_OPENING_PAGE_LIMIT = 200
  const LIVE_PORTRAIT_LIMIT = 6
  const LIVE_THING_LIMIT = 6
  const LIVE_FOCUS_STORAGE_KEY = '1f3d9:window:live-focus'
  const LIVE_CAMERA_MAX_SCALE = 2.2
  const REQUEST_TIMEOUT_MS = 10000
  const MAX_FORWARD_RECONCILE_PAGES = 8
  const MAX_AUTO_HISTORY_PAGES = 8
  const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/
  const SAFE_WORLD_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
  const MODERATED_TEXT = '[removed by maintainer]'
  const WORLD_ROOT_NAME = ${WORLD_ROOT_NAME_JSON}
  const VIEWS = Object.freeze(['map', 'live', 'place', 'conversations', 'happenings', 'agreements', 'archive'])
  const SAFE_EVENT_KINDS = new Map(Object.entries(${PUBLIC_EVENT_LABELS_JSON}))
  const SAFE_EVENT_DETAIL_IDS = Object.freeze(${PUBLIC_EVENT_DETAIL_ID_FIELDS_JSON})
  const SAFE_ACTIONS = new Set(${BASIC_ACTIONS_JSON})
  const SAFE_ACTION_STATUSES = new Set(['applied', 'blocked', 'noop', 'failed'])
  const SAFE_EFFECT_STATUSES = new Set(['applied', 'skipped', 'failed'])
  const EVENT_ERROR_LIMIT = 500
  const UNSAFE_EVENT_ERROR = 'the recorded cause could not be shown safely'
  const LIVE_MOTION_PREFERENCE = window.matchMedia('(prefers-reduced-motion: reduce)')
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
  const normalizeWindowDrawing = ${NORMALIZE_WINDOW_DRAWING_JS}
  const windowLivePlateChildren = ${WINDOW_LIVE_PLATE_CHILDREN_JS}
  const windowLiveSurveyedPlots = ${WINDOW_LIVE_SURVEYED_PLOTS_JS}
  const windowLiveCapacitySelection = ${WINDOW_LIVE_CAPACITY_SELECTION_JS}
  const windowLivePollDelay = ${WINDOW_LIVE_POLL_DELAY_JS}
  const windowLiveTraceOpacity = ${WINDOW_LIVE_TRACE_OPACITY_JS}
  const windowLiveFitScale = ${WINDOW_LIVE_FIT_SCALE_JS}
  const windowLiveClampZoomScale = ${WINDOW_LIVE_CLAMP_ZOOM_SCALE_JS}
  const windowLivePruneTrailStarts = ${WINDOW_LIVE_PRUNE_TRAIL_STARTS_JS}
  const windowLiveReplayDuration = ${WINDOW_LIVE_REPLAY_DURATION_JS}
  const windowLiveReplayOrder = ${WINDOW_LIVE_REPLAY_ORDER_JS}
  const windowLiveSpeechLine = ${WINDOW_LIVE_SPEECH_LINE_JS}

  const nodes = {
    status: document.getElementById('window-status'),
    counts: document.getElementById('city-counts'),
    scope: document.getElementById('view-scope'),
    liveBeta: document.getElementById('live-beta'),
    liveBetaNote: document.getElementById('live-beta-note'),
    liveClock: document.getElementById('live-clock'),
    liveBreadcrumbs: document.getElementById('live-breadcrumbs'),
    liveHistoryStatus: document.getElementById('live-history-status'),
    liveViewport: document.getElementById('live-viewport'),
    liveStage: document.getElementById('live-stage'),
    liveWorldGround: document.querySelector('#live-stage > .live-world-ground'),
    liveFit: document.getElementById('live-fit'),
    livePause: document.getElementById('live-pause'),
    liveFocusStatus: document.getElementById('live-focus-status'),
    liveMapCaption: document.getElementById('live-map-caption'),
    livePlates: document.getElementById('live-plates'),
    liveLedger: document.getElementById('live-ledger'),
    liveRoster: document.getElementById('live-roster'),
    liveResidentPage: document.getElementById('live-resident-page'),
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
      places: [], residents: [], loaded: false, loading: false, error: false,
      marker: null, recheckTimer: 0,
    },
    focusedPlaces: {},
    focusedResidents: {},
    histories: { notes: {}, things: {}, agreements: {}, events: {} },
    branches: {},
    residentPaging: {
      initialized: false, hasMore: false, nextBeforeId: null, loading: false, error: false,
      seenBeforeIds: [], automaticPageCount: 0, automaticPaused: false,
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
    view: 'map',
    directorySearch: '',
    directorySearchIndex: -1,
    placeId: null,
    resident: null,
    conversationContext: false,
    live: {
      openingMarker: null, openingEvents: [], openingLoaded: false, openingLoading: false,
      openingComplete: false, openingPaused: false, openingError: false,
      openingNextBeforeId: null, streamError: false, streamMarker: null,
      changes: [], drawings: {}, noteBodies: {},
      highlightedKey: null, quietReads: 0, nextReadAt: null,
      lastChangeAt: null, clockTimer: 0,
      replayQueues: {}, replayActive: {}, replayPositions: {},
      replaySeenKeys: [], replayRevealedKeys: [],
      focusResident: null, paused: false, absorptionEndsAtByPlaceId: {}, trailStarts: {},
    },
  }
  let liveCamera = Object.freeze({
    scale: 1, offsetX: 0, offsetY: 0, stageId: null, fitted: false,
    panStart: null, pinchStart: null,
  })
  let livePointers = Object.freeze({})
  let liveNoteQueue = Object.freeze([])
  let liveNoteFetches = 0
  let liveDrawingQueue = Object.freeze([])
  let liveDrawingFetches = 0

  function element(tagName, className, text) {
    const node = document.createElement(tagName)
    if (className) node.className = className
    if (text !== undefined) node.textContent = String(text)
    return node
  }
${WINDOW_CLIENT_SAFETY_JS}

  function readLiveFocusResident() {
    try {
      const value = localStorage.getItem(LIVE_FOCUS_STORAGE_KEY)
      if (typeof value === 'string' && SAFE_HANDLE.test(value)) return value
      if (value !== null) localStorage.removeItem(LIVE_FOCUS_STORAGE_KEY)
    } catch {
      // Focus is optional per-viewer presentation; storage refusal leaves it unset.
    }
    return null
  }

  function storeLiveFocusResident(handle) {
    try {
      if (handle) localStorage.setItem(LIVE_FOCUS_STORAGE_KEY, handle)
      else localStorage.removeItem(LIVE_FOCUS_STORAGE_KEY)
    } catch {
      // The in-memory focus still works for this page when storage is unavailable.
    }
  }

  function setLiveFocusResident(handle) {
    const next = typeof handle === 'string' && SAFE_HANDLE.test(handle) ? handle : null
    storeLiveFocusResident(next)
    state = { ...state, live: { ...state.live, focusResident: next } }
    if (next && state.view === 'live' && state.resident) {
      navigate({ resident: null, conversationContext: false })
      return
    }
    if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
  }

  function toggleLiveFocusResident(handle) {
    setLiveFocusResident(state.live.focusResident === handle ? null : handle)
  }

  function renderLiveFocusStatus() {
    if (!nodes.liveFocusStatus) return
    const handle = state.live.focusResident
    nodes.liveFocusStatus.dataset.focused = String(Boolean(handle))
    if (!handle) {
      nodes.liveFocusStatus.replaceChildren(document.createTextNode(
        'No resident focused. Click a resident to keep them and their visible interaction partners in view.'
      ))
      return
    }
    const message = element('span', '', 'Focused on ' + handle +
      '. Finite plate slots prioritize them while they are on this plate; if they leave, the Focus / Interactions board names their actual location. The complete roster and board keep every safely identified partner visible. ')
    const clear = element('button', 'live-focus-clear', 'Clear focus')
    clear.type = 'button'
    clear.setAttribute('aria-label', 'Clear resident focus')
    clear.dataset.focusKey = 'live-focus-clear'
    clear.addEventListener('click', () => setLiveFocusResident(null))
    nodes.liveFocusStatus.replaceChildren(message, clear)
  }

  function liveFullSurveyScale() {
    if (!nodes.liveViewport || !nodes.liveStage) return null
    const width = Number(nodes.liveStage.dataset.liveStageWidth) || nodes.liveStage.offsetWidth
    const height = Number(nodes.liveStage.dataset.liveStageHeight) || nodes.liveStage.offsetHeight
    return windowLiveFitScale(
      nodes.liveViewport.clientWidth,
      nodes.liveViewport.clientHeight,
      width,
      height,
      LIVE_CAMERA_MAX_SCALE,
    )
  }

  function clampLiveScale(value) {
    const fullSurveyScale = liveFullSurveyScale()
    return fullSurveyScale === null
      ? liveCamera.scale
      : windowLiveClampZoomScale(
          value, liveCamera.scale, fullSurveyScale, LIVE_CAMERA_MAX_SCALE)
  }

  function applyLiveCamera(next) {
    liveCamera = Object.freeze({ ...liveCamera, ...next })
    if (!nodes.liveStage) return
    nodes.liveStage.style.transform = 'translate(' + String(liveCamera.offsetX) + 'px, ' +
      String(liveCamera.offsetY) + 'px) scale(' + String(liveCamera.scale) + ')'
    nodes.liveStage.dataset.liveScale = String(liveCamera.scale)
    nodes.liveStage.dataset.liveOffsetX = String(liveCamera.offsetX)
    nodes.liveStage.dataset.liveOffsetY = String(liveCamera.offsetY)
  }

  function fitLivePlate() {
    if (!nodes.liveViewport || !nodes.liveStage) return
    const width = Number(nodes.liveStage.dataset.liveStageWidth) || nodes.liveStage.offsetWidth
    const height = Number(nodes.liveStage.dataset.liveStageHeight) || nodes.liveStage.offsetHeight
    const scale = liveFullSurveyScale()
    if (!(width > 0 && height > 0) || scale === null) return
    applyLiveCamera({
      scale,
      offsetX: (nodes.liveViewport.clientWidth - width * scale) / 2,
      offsetY: (nodes.liveViewport.clientHeight - height * scale) / 2,
      fitted: true,
      panStart: null,
      pinchStart: null,
    })
  }

  function zoomLivePlateAt(clientX, clientY, requestedScale) {
    if (!nodes.liveViewport) return
    const scale = clampLiveScale(requestedScale)
    const rect = nodes.liveViewport.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const worldX = (x - liveCamera.offsetX) / liveCamera.scale
    const worldY = (y - liveCamera.offsetY) / liveCamera.scale
    applyLiveCamera({
      scale,
      offsetX: x - worldX * scale,
      offsetY: y - worldY * scale,
      fitted: false,
    })
  }

  function livePointerValues(pointers = livePointers) {
    return Object.values(pointers)
  }

  function livePinchStart(pointers) {
    const values = livePointerValues(pointers)
    if (values.length < 2 || !nodes.liveViewport) return null
    const [first, second] = values
    const midpointX = (first.x + second.x) / 2
    const midpointY = (first.y + second.y) / 2
    const rect = nodes.liveViewport.getBoundingClientRect()
    return Object.freeze({
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      scale: liveCamera.scale,
      worldX: (midpointX - rect.left - liveCamera.offsetX) / liveCamera.scale,
      worldY: (midpointY - rect.top - liveCamera.offsetY) / liveCamera.scale,
    })
  }

  function beginLivePointer(event) {
    if (!nodes.liveViewport) return
    livePointers = Object.freeze({
      ...livePointers,
      [String(event.pointerId)]: Object.freeze({
        id: event.pointerId, x: event.clientX, y: event.clientY,
      }),
    })
    const values = livePointerValues()
    if (values.length === 1) {
      liveCamera = Object.freeze({ ...liveCamera,
        panStart: Object.freeze({
          id: event.pointerId, x: event.clientX, y: event.clientY,
          offsetX: liveCamera.offsetX, offsetY: liveCamera.offsetY,
        }),
        pinchStart: null,
      })
    } else if (values.length === 2) {
      liveCamera = Object.freeze({ ...liveCamera, panStart: null, pinchStart: livePinchStart(livePointers) })
    }
    try { nodes.liveViewport.setPointerCapture(event.pointerId) } catch {}
  }

  function moveLivePointer(event) {
    const key = String(event.pointerId)
    if (!Object.hasOwn(livePointers, key) || !nodes.liveViewport) return
    livePointers = Object.freeze({
      ...livePointers,
      [key]: Object.freeze({ id: event.pointerId, x: event.clientX, y: event.clientY }),
    })
    const values = livePointerValues()
    if (values.length >= 2 && liveCamera.pinchStart) {
      const [first, second] = values
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y))
      const scale = clampLiveScale(liveCamera.pinchStart.scale *
        (distance / liveCamera.pinchStart.distance))
      const rect = nodes.liveViewport.getBoundingClientRect()
      const midpointX = (first.x + second.x) / 2 - rect.left
      const midpointY = (first.y + second.y) / 2 - rect.top
      applyLiveCamera({
        scale,
        offsetX: midpointX - liveCamera.pinchStart.worldX * scale,
        offsetY: midpointY - liveCamera.pinchStart.worldY * scale,
        fitted: false,
      })
      return
    }
    const start = liveCamera.panStart
    if (values.length === 1 && start?.id === event.pointerId) {
      applyLiveCamera({
        offsetX: start.offsetX + event.clientX - start.x,
        offsetY: start.offsetY + event.clientY - start.y,
        fitted: false,
      })
    }
  }

  function endLivePointer(event) {
    const remaining = Object.fromEntries(Object.entries(livePointers)
      .filter(([key]) => key !== String(event.pointerId)))
    livePointers = Object.freeze(remaining)
    const values = livePointerValues()
    liveCamera = Object.freeze({
      ...liveCamera,
      pinchStart: values.length >= 2 ? livePinchStart(livePointers) : null,
      panStart: values.length === 1 ? Object.freeze({
        id: values[0].id, x: values[0].x, y: values[0].y,
        offsetX: liveCamera.offsetX, offsetY: liveCamera.offsetY,
      }) : null,
    })
  }

  function resetShareFeedback() {
    shareFeedbackRevision += 1
    for (const status of [nodes.shareStatus, nodes.detailShareStatus]) {
      if (!status) continue
      status.textContent = ''
      delete status.dataset.tone
    }
    for (const button of [...viewShareButtons, detailShareButton].filter(Boolean)) {
      button.textContent = button.dataset.shareScope === 'detail'
        ? 'Share this detail'
        : 'Share this view'
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
    for (const target of [nodes.map, nodes.roster, nodes.livePlates, nodes.liveRoster,
      nodes.placePurpose, nodes.placeFrontMatter,
      nodes.occupants, nodes.placeThings, nodes.placeConversation, nodes.conversations,
      nodes.agreements]) {
      renderEmpty(target, 'error-row', message)
    }
    if (nodes.liveLedger) {
      nodes.liveLedger.replaceChildren(element('li', 'error-row', message))
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

  function normalizeLiveSurvey(values) {
    if (values === undefined) return Object.freeze([])
    if (!Array.isArray(values)) throw new Error('invalid public live survey')
    const seen = new Set()
    const rows = values.map(raw => {
      if (!raw || typeof raw !== 'object') throw new Error('invalid public live survey')
      const id = safeId(raw.id)
      const parentId = raw.parent_id === null ? null : safeId(raw.parent_id)
      const things = raw.things
      if (!id || (raw.parent_id !== null && !parentId) || parentId === id || seen.has(id) ||
          typeof things !== 'number' || !Number.isSafeInteger(things) || things < 0) {
        throw new Error('invalid public live survey')
      }
      seen.add(id)
      return Object.freeze({ id, parent_id: parentId, things })
    })
    return Object.freeze(rows)
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
      const changeId = raw.change_id == null ? null : safeChangeMarker(raw.change_id)
      const actor = safeHandle(raw.actor)
      const verb = SAFE_EVENT_KINDS.get(raw.kind)
      const at = safeDate(raw.at)
      if (!id || (raw.change_id != null && !changeId) || !actor || !verb || !at) return []
      const source = raw.detail && typeof raw.detail === 'object' ? raw.detail : {}
      let detail = Object.fromEntries(SAFE_EVENT_DETAIL_IDS.flatMap(key => {
        const value = safeId(source[key])
        return value ? [[key, value]] : []
      }))
      detail = normalizeLiveTransferDetail(raw.kind, source, detail)
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
      return [{ id, ...(changeId ? { change_id: changeId } : {}),
        actor, kind: raw.kind, verb, at, detail }]
    })
  }

  function normalizeLiveChanges(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, LIVE_OPENING_PAGE_LIMIT).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const changeId = safeChangeMarker(raw.change_id)
      const actor = safeHandle(raw.actor)
      const verb = SAFE_EVENT_KINDS.get(raw.kind)
      const at = safeDate(raw.created_at)
      if (!changeId || !actor || !verb || !at) return []
      const source = raw.detail && typeof raw.detail === 'object' ? raw.detail : {}
      let detail = Object.fromEntries(SAFE_EVENT_DETAIL_IDS.flatMap(key => {
        const value = safeId(source[key])
        return value ? [[key, value]] : []
      }))
      detail = normalizeLiveTransferDetail(raw.kind, source, detail)
      if (raw.kind === 'action' && SAFE_ACTIONS.has(source.action)) {
        detail.action = source.action
        if (SAFE_ACTION_STATUSES.has(source.status)) detail.status = source.status
      }
      return [Object.freeze({ change_id: changeId, actor, kind: raw.kind, verb, at, detail })]
    })
  }

  function normalizeLiveTransferDetail(kind, source, detail) {
    if (kind !== 'transfer') return detail
    const assetType = ['place', 'thing', 'kind'].includes(source.asset_type)
      ? source.asset_type
      : ['place', 'thing', 'kind'].includes(source.type) ? source.type : null
    const assetId = safeId(source.asset_id ?? source.id)
    return assetType && assetId
      ? { ...detail, asset_type: assetType, asset_id: assetId }
      : detail
  }

  function mergeLiveChanges(current, incoming) {
    const rows = new Map(current.map(row => [row.change_id, row]))
    for (const row of incoming) rows.set(row.change_id, row)
    return Object.freeze([...rows.values()].sort((left, right) =>
      Number(BigInt(right.change_id) - BigInt(left.change_id))))
  }

  function liveTraceKey(record) {
    return record.change_id ? 'change:' + record.change_id : 'event:' + String(record.id)
  }

  function liveRecordType(record) {
    if (record.kind === 'note' && record.detail.note_id && record.detail.place_id) return 'note'
    if ((record.kind === 'thing_created' || record.kind === 'thing_crafted') &&
        record.detail.place_id) return 'make'
    if (record.kind !== 'action' || record.detail.status !== 'applied') {
      return null
    }
    if ((record.detail.action === 'move' || record.detail.action === 'go_home') &&
        record.detail.from_place_id && record.detail.to_place_id) return 'move'
    if (record.detail.action === 'use' && record.detail.source_thing_id &&
        record.detail.place_id) return 'use'
    if (record.detail.action === 'make' && record.detail.place_id) return 'make'
    return null
  }

  function liveRecords() {
    const records = new Map()
    for (const record of [...state.live.changes, ...state.live.openingEvents]) {
      records.set(liveTraceKey(record), record)
    }
    return windowLiveReplayOrder([...records.values()], Number.NEGATIVE_INFINITY).reverse()
  }

  function liveInteractionRecords() {
    return liveRecords().filter(record =>
      record.kind === 'transfer' &&
      record.detail.resident_id && record.detail.place_id && liveRecordIsRecent(record))
  }

  function liveRecordLifetime(record) {
    return liveRecordType(record) === 'note' ? LIVE_NOTE_LIFETIME_MS : LIVE_MOVE_LIFETIME_MS
  }

  function liveRecordIsRecent(record, now = Date.now()) {
    return windowLiveTraceOpacity(record.at.getTime(), now, liveRecordLifetime(record)) > 0
  }

  function liveRecordPlaceId(record) {
    const type = liveRecordType(record)
    if (type === 'move') return record.detail.to_place_id || null
    if (record.detail.place_id) return record.detail.place_id
    return null
  }

  function liveMotionReduced() {
    return LIVE_MOTION_PREFERENCE.matches
  }

  function liveReplayRecordIsRevealed(record) {
    if (record.change_id && !state.live.openingLoaded) return false
    const key = liveTraceKey(record)
    return !state.live.replaySeenKeys.includes(key) ||
      state.live.replayRevealedKeys.includes(key)
  }

  function liveReplayHeldKeys() {
    return new Set([
      ...Object.values(state.live.replayQueues).flat().map(liveTraceKey),
      ...Object.values(state.live.replayActive).map(active => active.key),
    ])
  }

  function queueLiveReplays(records) {
    const now = Date.now()
    const recentKeys = new Set(liveRecords().filter(record =>
      liveRecordIsRecent(record, now)).map(liveTraceKey))
    const heldKeys = liveReplayHeldKeys()
    const seen = new Set(state.live.replaySeenKeys.filter(key =>
      recentKeys.has(key) || heldKeys.has(key)))
    const revealed = new Set(state.live.replayRevealedKeys.filter(key =>
      recentKeys.has(key) || heldKeys.has(key)))
    const additions = windowLiveReplayOrder(records, Number.NEGATIVE_INFINITY).filter(record => {
      const key = liveTraceKey(record)
      if (!record.change_id || !liveRecordType(record) || !liveRecordIsRecent(record, now) ||
          seen.has(key)) return false
      seen.add(key)
      if (state.resident && record.actor !== state.resident) {
        revealed.add(key)
        return false
      }
      return true
    })
    if (!additions.length &&
        seen.size === state.live.replaySeenKeys.length &&
        revealed.size === state.live.replayRevealedKeys.length) return

    if (liveMotionReduced()) {
      const trailStarts = { ...state.live.trailStarts }
      for (const record of additions) {
        if (liveRecordType(record) === 'move') trailStarts[liveTraceKey(record)] = now
      }
      for (const record of additions) revealed.add(liveTraceKey(record))
      state = { ...state, live: {
        ...state.live,
        replaySeenKeys: Object.freeze([...seen]),
        replayRevealedKeys: Object.freeze([...revealed]),
        trailStarts: Object.freeze(trailStarts),
      } }
      return
    }

    const queues = Object.fromEntries(Object.entries(state.live.replayQueues)
      .map(([actor, queue]) => [actor, [...queue]]))
    const positions = { ...state.live.replayPositions }
    for (const record of additions) {
      queues[record.actor] = Object.freeze([...(queues[record.actor] || []), record])
      if (!Object.hasOwn(positions, record.actor) && liveRecordType(record) === 'move') {
        positions[record.actor] = record.detail.from_place_id
      }
    }
    state = { ...state, live: {
      ...state.live,
      replayQueues: Object.freeze(queues),
      replayPositions: Object.freeze(positions),
      replaySeenKeys: Object.freeze([...seen]),
      replayRevealedKeys: Object.freeze([...revealed]),
    } }
  }

  function settleLiveReplays() {
    const heldRecords = [
      ...Object.values(state.live.replayQueues).flat(),
      ...Object.values(state.live.replayActive).map(active => active.record),
    ]
    const keys = new Set([
      ...state.live.replaySeenKeys,
      ...liveReplayHeldKeys(),
    ])
    const trailStarts = { ...state.live.trailStarts }
    const settledAt = Date.now()
    for (const record of heldRecords) {
      if (liveRecordType(record) === 'move') trailStarts[liveTraceKey(record)] = settledAt
    }
    state = { ...state, live: {
      ...state.live,
      replayQueues: {}, replayActive: {}, replayPositions: {},
      replaySeenKeys: Object.freeze([...keys]),
      replayRevealedKeys: Object.freeze([...keys]),
      trailStarts: Object.freeze(trailStarts),
    } }
  }

  function livePlaceAnchor(placeId, focusId, children) {
    if (!placeId) return null
    if (placeId === focusId) return focusId
    const places = state.snapshot
      ? livePlaceRows(state.snapshot)
      : state.directory.loaded ? state.directory.places : []
    const byId = new Map(places.map(place => [place.id, place]))
    const childIds = new Set(children.map(place => place.id))
    const seen = new Set()
    let current = byId.get(placeId)
    while (current && !seen.has(current.id)) {
      if (childIds.has(current.id)) return current.id
      if (current.parent_id === focusId) return current.id
      seen.add(current.id)
      current = current.parent_id ? byId.get(current.parent_id) : null
    }
    return null
  }

  function liveDrawingKey(type, id) {
    return type + ':' + String(id)
  }

  async function fetchLiveDrawing(type, id) {
    const key = liveDrawingKey(type, id)
    const held = state.live.drawings[key]
    if (held?.loading || held?.loaded) return
    const loading = Object.freeze({ loading: true, loaded: false, error: false })
    state = {
      ...state,
      live: {
        ...state.live,
        drawings: { ...state.live.drawings, [key]: loading },
      },
    }
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let settled = false
    try {
      const url = new URL('/api/drawing/' + type + '/' + String(id), window.location.origin)
      const response = await fetch(url.pathname, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!response.ok) throw new Error('drawing unavailable')
      const payload = await response.json()
      if (!payload || payload.type !== type || safeId(payload.id) !== id) throw new Error('invalid drawing')
      const drawing = payload.drawing === null ? null : normalizeWindowDrawing(payload.drawing)
      if (payload.drawing !== null && !drawing) throw new Error('invalid drawing')
      if (![null, 'place', 'resident', 'thing', 'kind_revision'].includes(payload.source)) {
        throw new Error('invalid drawing source')
      }
      const source = payload.source
      if (state.live.drawings[key] !== loading) return
      state = {
        ...state,
        live: {
          ...state.live,
          drawings: {
            ...state.live.drawings,
            [key]: Object.freeze({ loading: false, loaded: true, error: false, drawing, source }),
          },
        },
      }
      settled = true
    } catch {
      if (state.live.drawings[key] !== loading) return
      state = {
        ...state,
        live: {
          ...state.live,
          drawings: {
            ...state.live.drawings,
            [key]: Object.freeze({ loading: false, loaded: false, error: true }),
          },
        },
      }
      settled = true
    } finally {
      window.clearTimeout(timeout)
      if (settled && state.view === 'live' && state.snapshot) renderLive(state.snapshot)
    }
  }

  function drainLiveDrawingQueue() {
    if (state.view !== 'live' || document.hidden ||
        liveDrawingFetches >= LIVE_DRAWING_FETCH_CONCURRENCY || !liveDrawingQueue.length) return
    const [request, ...remaining] = liveDrawingQueue
    liveDrawingQueue = Object.freeze(remaining)
    if (state.live.drawings[request.key]) {
      drainLiveDrawingQueue()
      return
    }
    liveDrawingFetches += 1
    void fetchLiveDrawing(request.type, request.id).finally(() => {
      liveDrawingFetches = Math.max(0, liveDrawingFetches - 1)
      drainLiveDrawingQueue()
    })
    drainLiveDrawingQueue()
  }

  function loadLiveDrawing(type, id) {
    const key = liveDrawingKey(type, id)
    if (state.live.drawings[key] || liveDrawingQueue.some(request => request.key === key)) return
    if (liveDrawingQueue.length < LIVE_DRAWING_QUEUE_LIMIT) {
      liveDrawingQueue = Object.freeze([
        ...liveDrawingQueue,
        Object.freeze({ type, id, key }),
      ])
    }
    drainLiveDrawingQueue()
  }

  function drawingNode(type, id, label) {
    const entry = state.live.drawings[liveDrawingKey(type, id)]
    if (!entry) void loadLiveDrawing(type, id)
    if (entry?.error) {
      const unavailable = element('span', 'drawing-grid drawing-undrawn drawing-unavailable')
      unavailable.setAttribute('role', 'img')
      unavailable.setAttribute('aria-label', label + ' drawing could not be read')
      unavailable.append(element('span', 'drawing-undrawn-label', 'drawing unavailable'))
      return unavailable
    }
    if (!entry?.loaded) {
      const loading = element('span', 'drawing-grid drawing-undrawn drawing-loading')
      loading.setAttribute('role', 'img')
      loading.setAttribute('aria-label', 'Reading ' + label + ' drawing')
      loading.append(element('span', 'drawing-undrawn-label', 'reading drawing'))
      return loading
    }
    if (entry.drawing === null) {
      const standIn = element('span', 'drawing-grid drawing-undrawn')
      standIn.setAttribute('role', 'img')
      standIn.setAttribute('aria-label', label + ' is undrawn')
      standIn.append(element('span', 'drawing-undrawn-label', 'undrawn'))
      return standIn
    }
    const drawing = entry.drawing
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.classList.add('drawing-grid', 'drawing-authored')
    svg.setAttribute('viewBox', '0 0 8 8')
    svg.setAttribute('role', 'img')
    const blank = drawing.indices.every(index => index === null)
    svg.setAttribute('aria-label', label + (blank ? ' is deliberately blank' : ' has an authored drawing'))
    svg.setAttribute('shape-rendering', 'crispEdges')
    drawing.indices.forEach((paletteIndex, index) => {
      if (paletteIndex === null) return
      const square = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      square.setAttribute('x', String(index % 8))
      square.setAttribute('y', String(Math.floor(index / 8)))
      square.setAttribute('width', '1')
      square.setAttribute('height', '1')
      square.setAttribute('fill', drawing.palette[paletteIndex])
      svg.append(square)
    })
    return svg
  }

  async function fetchLiveNote(noteId) {
    const key = String(noteId)
    const held = state.live.noteBodies[key]
    if (held) return
    const loading = Object.freeze({ loading: true, error: false, body: null })
    state = {
      ...state,
      live: { ...state.live, noteBodies: {
        ...state.live.noteBodies, [key]: loading,
      } },
    }
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let settled = false
    try {
      const response = await fetch('/api/note/' + key, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!response.ok) throw new Error('note unavailable')
      const payload = await response.json()
      const body = safeExactText(payload?.note?.body, null, 4000, false)
      if (!body || safeId(payload?.note?.id) !== noteId) throw new Error('invalid note')
      if (state.live.noteBodies[key] !== loading) return
      state = { ...state, live: { ...state.live, noteBodies: {
        ...state.live.noteBodies, [key]: Object.freeze({ loading: false, error: false, body }),
      } } }
      settled = true
    } catch {
      if (state.live.noteBodies[key] !== loading) return
      state = { ...state, live: { ...state.live, noteBodies: {
        ...state.live.noteBodies, [key]: Object.freeze({ loading: false, error: true, body: null }),
      } } }
      settled = true
    } finally {
      window.clearTimeout(timeout)
      if (settled && state.view === 'live' && state.snapshot) renderLive(state.snapshot)
    }
  }

  function drainLiveNoteQueue() {
    if (state.view !== 'live' || document.hidden ||
        liveNoteFetches >= LIVE_NOTE_FETCH_CONCURRENCY || !liveNoteQueue.length) return
    const [noteId, ...remaining] = liveNoteQueue
    liveNoteQueue = Object.freeze(remaining)
    if (state.live.noteBodies[String(noteId)]) {
      drainLiveNoteQueue()
      return
    }
    liveNoteFetches += 1
    void fetchLiveNote(noteId).finally(() => {
      liveNoteFetches = Math.max(0, liveNoteFetches - 1)
      drainLiveNoteQueue()
    })
    drainLiveNoteQueue()
  }

  function loadLiveNote(noteId) {
    if (state.live.noteBodies[String(noteId)]) return
    if (!liveNoteQueue.includes(noteId) && liveNoteQueue.length < LIVE_NOTE_QUEUE_LIMIT) {
      liveNoteQueue = Object.freeze([...liveNoteQueue, noteId])
    }
    drainLiveNoteQueue()
  }

  function pruneLiveNoteBodies(now = Date.now()) {
    const retainedNoteIds = new Set(liveRecords()
      .filter(record => liveRecordType(record) === 'note' && liveRecordIsRecent(record, now))
      .map(record => record.detail.note_id))
    liveNoteQueue = Object.freeze(liveNoteQueue.filter(noteId => retainedNoteIds.has(noteId)))
    const entries = Object.entries(state.live.noteBodies)
      .filter(([key]) => retainedNoteIds.has(Number(key)))
    if (entries.length === Object.keys(state.live.noteBodies).length) return
    state = { ...state, live: { ...state.live, noteBodies: Object.fromEntries(entries) } }
  }

  function setLiveHighlight(key) {
    state = { ...state, live: { ...state.live, highlightedKey: key } }
    for (const node of document.querySelectorAll('[data-live-key]')) {
      node.dataset.highlighted = String(node.dataset.liveKey === key)
    }
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
    const liveSurvey = normalizeLiveSurvey(payload.live_survey)
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
      liveSurvey,
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
          automaticPageCount: 0,
          automaticPaused: false,
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
      automaticPageCount: 0,
      automaticPaused: false,
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
      automaticPageCount: 0,
      automaticPaused: false,
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
    const detail = !legacyHash && pathId && ['place', 'thing', 'note'].includes(pathKind)
      ? Object.freeze({ kind: pathKind, id: pathId })
      : null
    const pathPlaceId = detail?.kind === 'place' ? detail.id : null
    return {
      view: VIEWS.includes(view) ? view : 'map',
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
    const previousView = state.view
    const nextView = Object.hasOwn(next, 'view') ? next.view : state.view
    const nextResident = Object.hasOwn(next, 'resident') ? next.resident : state.resident
    const clearsLiveFocus = nextView === 'live' && Boolean(nextResident)
    const openingDetail = Boolean(next?.detail && (
      state.detail?.kind !== next.detail.kind || state.detail?.id !== next.detail.id
    ))
    if (openingDetail || (Object.hasOwn(next, 'detail') && next.detail === null)) {
      detailRequestRevision += 1
    }
    resetShareFeedback()
    const leavesReplayPlate = previousView === 'live' && (
      (Object.hasOwn(next, 'view') && next.view !== 'live') ||
      (Object.hasOwn(next, 'placeId') && next.placeId !== state.placeId) ||
      (Object.hasOwn(next, 'resident') && next.resident !== state.resident)
    )
    if (leavesReplayPlate && liveReplayHeldKeys().size) settleLiveReplays()
    if (clearsLiveFocus && state.live.focusResident) storeLiveFocusResident(null)
    state = {
      ...state,
      ...next,
      live: clearsLiveFocus ? { ...state.live, focusResident: null } : state.live,
    }
    writeLocation(!rovingTabActivation, openingDetail ? { windowDetailEntry: true } : null)
    renderAll()
    void ensureFocusedSelection()
    void ensureDetail()
    if (state.view !== previousView) {
      scheduleRefresh(state.view === 'live' && !document.hidden ? 0 : BASE_REFRESH_MS)
    }
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
    url.searchParams.set('limit', state.view === 'live' ? '200' : '25')
    if (entry.initialized && entry.nextBeforeId) {
      url.searchParams.set('before_id', String(entry.nextBeforeId))
    }
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    return url
  }

  async function loadResidents(automatic = false) {
    if (automatic && (state.view !== 'live' || document.hidden)) return
    const current = state.residentPaging
    if (!state.snapshot || current.loading || (!current.hasMore && !current.error)) return
    if (automatic && (current.automaticPageCount || 0) >= MAX_AUTO_HISTORY_PAGES) {
      state = {
        ...state,
        residentPaging: Object.freeze({
          ...current, loading: false, error: false, automaticPaused: true,
        }),
      }
      renderAll()
      return
    }
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    navigationRevision += 1
    state = {
      ...state,
      residentPaging: Object.freeze({
        ...current, loading: true, error: false, automaticPaused: false,
      }),
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
      const automaticPageCount = automatic
        ? (state.residentPaging.automaticPageCount || 0) + 1
        : 0
      const automaticPaused = automatic && hasMore &&
        automaticPageCount >= MAX_AUTO_HISTORY_PAGES
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
          automaticPageCount,
          automaticPaused,
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

  function livePlaceRows(snapshot) {
    if (!state.directory.loaded) return snapshot.flatPlaces
    const rows = new Map(state.directory.places.map(place => [place.id, place]))
    for (const place of snapshot.flatPlaces) {
      rows.set(place.id, Object.freeze({ ...(rows.get(place.id) || {}), ...place }))
    }
    return Object.freeze([...rows.values()])
  }

  function liveSurveyIsComplete(snapshot) {
    if (!state.directory.loaded || !snapshot.liveSurvey?.length ||
        snapshot.liveSurvey.length !== state.directory.places.length) return false
    const directoryById = new Map(state.directory.places.map(place => [place.id, place]))
    const topologyMatches = snapshot.liveSurvey.every(place => {
      const directoryPlace = directoryById.get(place.id)
      return directoryPlace && directoryPlace.parent_id === place.parent_id
    })
    const surveyedThings = snapshot.liveSurvey.reduce((total, place) => total + place.things, 0)
    return topologyMatches && Number.isSafeInteger(surveyedThings) &&
      surveyedThings === snapshot.totals.things
  }

  function liveSurveyThingTotal(snapshot, placeId, includeDescendants) {
    if (!liveSurveyIsComplete(snapshot)) return null
    const placeIds = includeDescendants ? placeScopeSet(placeId, snapshot) : new Set([placeId])
    return snapshot.liveSurvey.reduce((total, place) =>
      placeIds.has(place.id) ? total + place.things : total, 0)
  }

  function liveExactThingTotal(snapshot, placeId, loadedCount, includeDescendants) {
    const surveyedTotal = liveSurveyThingTotal(snapshot, placeId, includeDescendants)
    return surveyedTotal !== null && surveyedTotal >= loadedCount ? surveyedTotal : null
  }

  function liveFocusPlace(snapshot) {
    const chosen = selectedPlace(snapshot)
    if (chosen) return chosen
    const places = livePlaceRows(snapshot)
    const world = places.find(place => place.parent_id === null && place.name === WORLD_ROOT_NAME)
    return world || places.find(place => place.parent_id === null) || snapshot.places[0] || null
  }

  function liveChildren(snapshot, focus) {
    return windowLivePlateChildren(livePlaceRows(snapshot), focus.id).map(place =>
      placeReference(snapshot, place.id) || place)
  }

  function livePath(snapshot, focus) {
    const places = livePlaceRows(snapshot)
    const byId = new Map(places.map(place => [place.id, place]))
    const path = []
    const seen = new Set()
    let current = focus
    while (current && !seen.has(current.id) && path.length < 32) {
      path.push(placeReference(snapshot, current.id) || current)
      seen.add(current.id)
      current = current.parent_id ? byId.get(current.parent_id) || null : null
    }
    return path.reverse()
  }

  function renderLiveBreadcrumbs(snapshot, focus) {
    if (!nodes.liveBreadcrumbs) return
    const parts = []
    livePath(snapshot, focus).forEach((place, index, path) => {
      const button = element('button', 'live-breadcrumb', place.name)
      button.type = 'button'
      button.dataset.focusKey = 'live-breadcrumb:' + String(place.id)
      button.setAttribute('aria-current', index === path.length - 1 ? 'location' : 'false')
      button.addEventListener('click', () => navigate({ view: 'live', placeId: place.id }))
      parts.push(button)
      if (index < path.length - 1) parts.push(element('span', 'live-breadcrumb-separator', '/'))
    })
    nodes.liveBreadcrumbs.replaceChildren(...parts)
  }

  function liveSpeechBubbles(records) {
    const bubbles = new Map()
    const claimedActors = new Set()
    for (const record of records) {
      if (liveRecordType(record) !== 'note' || !liveReplayRecordIsRevealed(record) ||
          claimedActors.has(record.actor)) continue
      claimedActors.add(record.actor)
      const noteId = record.detail.note_id
      const entry = state.live.noteBodies[String(noteId)]
      if (!entry && noteId) void loadLiveNote(noteId)
      if (!entry?.body) continue
      bubbles.set(record.actor, Object.freeze({
        record,
        text: windowLiveSpeechLine(entry.body),
      }))
    }
    return bubbles
  }

  function liveSpeechBubbleNode(bubble) {
    const node = element('span', 'live-speech-bubble', bubble.text)
    node.setAttribute('aria-hidden', 'true')
    node.dataset.liveAt = String(bubble.record.at.getTime())
    node.dataset.liveLifetime = String(LIVE_NOTE_LIFETIME_MS)
    node.style.opacity = String(windowLiveTraceOpacity(
      bubble.record.at.getTime(), Date.now(), LIVE_NOTE_LIFETIME_MS))
    return node
  }

  function livePortraitShell(portrait, bubble, className = 'live-portrait-wrap') {
    const shell = element('span', className)
    shell.append(portrait)
    if (bubble) shell.append(liveSpeechBubbleNode(bubble))
    return shell
  }

  function liveResidentLayout(residents, placeId, focus, children, pinnedIds) {
    const ordered = [...residents.filter(resident => !resident.asleep),
      ...residents.filter(resident => resident.asleep)]
    const isRoot = placeId === focus.id
    const plot = isRoot ? null : windowLiveSurveyedPlots(children, focus.id)
      .find(candidate => candidate.id === placeId)
    if (!isRoot && !plot) {
      return Object.freeze({ visible: [], hidden: ordered, overflowCount: ordered.length,
        badgePoint: null })
    }
    const overflowing = ordered.length > LIVE_PORTRAIT_LIMIT
    const capacity = overflowing
      ? Math.max(0, LIVE_PORTRAIT_LIMIT - 2)
      : LIVE_PORTRAIT_LIMIT
    const selection = windowLiveCapacitySelection(ordered, capacity, pinnedIds || [])
    const visibleIds = new Set(selection.visible.map(resident => resident.id))
    const border = focus.parent_id === null ? 4 : 3
    const bottom = plot ? plot.height - 12 - border : 0
    const plotSlots = !plot ? [] : overflowing ? [
      Object.freeze({ x: 28, y: 60 }),
      Object.freeze({ x: 88, y: 60 }),
      Object.freeze({ x: 28, y: bottom }),
      Object.freeze({ x: 88, y: bottom }),
    ] : [
      Object.freeze({ x: 28, y: 60 }),
      Object.freeze({ x: 88, y: 60 }),
      Object.freeze({ x: 148, y: 60 }),
      Object.freeze({ x: 28, y: bottom }),
      Object.freeze({ x: 88, y: bottom }),
      Object.freeze({ x: 148, y: bottom }),
    ]
    const rootSlots = Array.from({ length: LIVE_PORTRAIT_LIMIT }, (_, index) =>
      Object.freeze({ x: 110 + index * 60, y: 142 }))
    const visible = Object.freeze(selection.visible.map((resident, index) => {
      const localPoint = isRoot
        ? rootSlots[index]
        : plotSlots[index]
      const stagePoint = isRoot
        ? localPoint
        : Object.freeze({
            x: plot.x + border + localPoint.x,
            y: plot.y + border + localPoint.y,
          })
      return Object.freeze({ resident, localPoint, stagePoint })
    }))
    return Object.freeze({
      visible,
      hidden: Object.freeze(ordered.filter(resident => !visibleIds.has(resident.id))),
      overflowCount: selection.overflowCount,
      badgePoint: isRoot
        ? Object.freeze({ x: 384, y: 112 })
        : Object.freeze({ x: plot.x + plot.width - 28, y: plot.y + plot.height - 10 }),
    })
  }

  function livePinnedResidentIds(snapshot, records, placeId) {
    const handle = state.live.focusResident
    if (!handle) return []
    const residents = displayedResidents(snapshot)
    const focused = residents.find(resident => resident.handle === handle)
    if (!focused) return []
    const placeIds = placeScopeSet(placeId, snapshot)
    const plate = liveFocusPlace(snapshot)
    const plateIds = plate ? placeScopeSet(plate.id, snapshot) : new Set()
    const pins = new Set(placeIds.has(focused.current_place_id) ? [focused.id] : [])
    const focusRecords = new Map([...records, ...liveInteractionRecords()]
      .map(record => [liveTraceKey(record), record]))
    for (const record of focusRecords.values()) {
      if (!plateIds.has(liveRecordPlaceId(record))) continue
      if (record.actor === handle && record.detail.resident_id) {
        const partner = residents.find(resident => resident.id === record.detail.resident_id)
        if (partner && placeIds.has(partner.current_place_id)) pins.add(partner.id)
      }
      if (record.detail.resident_id === focused.id) {
        const partner = residents.find(resident => resident.handle === record.actor)
        if (partner && placeIds.has(partner.current_place_id)) pins.add(partner.id)
      }
    }
    return Object.freeze([...pins])
  }

  function livePinnedThingIds(snapshot, records, placeId, interactionThings = null) {
    const focus = liveFocusPlace(snapshot)
    if (!focus) return []
    const placeIds = placeScopeSet(placeId, snapshot)
    const things = interactionThings || liveFocusInteractionThings(snapshot, focus, records)
    return Object.freeze(things
      .filter(thing => placeIds.has(thing.place_id))
      .map(thing => thing.id))
  }

  function liveResidentReplayPoint(snapshot, placeId, actor, focus, children) {
    const anchorId = livePlaceAnchor(placeId, focus.id, children)
    if (!anchorId) return null
    const resident = displayedResidents(snapshot).find(candidate => candidate.handle === actor)
    if (!resident) return null
    const anchoredResidents = anchorId === focus.id
      ? displayedResidents(snapshot).filter(candidate =>
          candidate.current_place_id === focus.id &&
          (!state.resident || candidate.handle === state.resident))
      : residentsAt(snapshot, anchorId)
    const residents = anchoredResidents.some(candidate => candidate.handle === actor)
      ? anchoredResidents
      : [...anchoredResidents, resident]
    const records = visibleLiveRecords(snapshot, focus, children)
    const layout = liveResidentLayout(
      residents,
      anchorId,
      focus,
      children,
      livePinnedResidentIds(snapshot, records, anchorId),
    )
    return layout.visible.find(entry => entry.resident.handle === actor)?.stagePoint ||
      layout.badgePoint
  }

  function livePortraitGrid(residents, label, bubbles, placeId, pinnedIds, className = 'live-portrait-grid') {
    const grid = element('div', className)
    grid.setAttribute('aria-label', label)
    const focus = state.snapshot ? liveFocusPlace(state.snapshot) : null
    const children = focus && state.snapshot ? liveChildren(state.snapshot, focus) : []
    if (!focus) return grid
    const layout = liveResidentLayout(residents, placeId, focus, children, pinnedIds)
    const pinned = new Set(pinnedIds || [])
    const overlayHandles = new Set(Object.keys(state.live.replayPositions))
    layout.visible.forEach(entry => {
      const resident = entry.resident
      if (overlayHandles.has(resident.handle)) return
      const portrait = element('button', resident.asleep
        ? 'live-portrait asleep'
        : 'live-portrait')
      portrait.type = 'button'
      portrait.dataset.focusKey = 'live-resident:' + resident.handle
      portrait.dataset.liveResidentHandle = resident.handle
      portrait.title = state.live.focusResident === resident.handle
        ? 'Clear focus from ' + resident.handle
        : 'Focus on ' + resident.handle
      portrait.setAttribute('aria-pressed', String(state.live.focusResident === resident.handle))
      portrait.addEventListener('click', () => toggleLiveFocusResident(resident.handle))
      portrait.append(
        drawingNode('resident', resident.id, resident.handle),
        element('span', 'live-portrait-name', resident.handle),
      )
      const shell = livePortraitShell(
        portrait,
        bubbles?.get(resident.handle),
        'live-portrait-wrap live-walker',
      )
      shell.style.left = String(entry.localPoint.x) + 'px'
      shell.style.top = String(entry.localPoint.y) + 'px'
      if (state.live.focusResident === resident.handle) {
        shell.setAttribute('data-live-focus-resident', resident.handle)
      } else if (pinned.has(resident.id)) {
        shell.setAttribute('data-live-focus-partner', resident.handle)
      }
      grid.append(shell)
    })
    const visibleOverflowActors = layout.hidden.filter(resident =>
      overlayHandles.has(resident.handle)).length
    const overflowCount = Math.max(0, layout.overflowCount - visibleOverflowActors)
    if (overflowCount) {
      const badge = element('span', 'live-overflow-badge live-resident-more', '+' +
        String(overflowCount) + ' more')
      badge.setAttribute('data-live-overflow-count', String(overflowCount))
      badge.title = String(residents.length) + ' residents here; showing ' +
        String(residents.length - overflowCount)
      if (Number(state.live.absorptionEndsAtByPlaceId[String(placeId)]) > Date.now()) {
        badge.classList.add('live-overflow-absorbing')
      }
      grid.append(badge)
    }
    return grid
  }

  function liveTiledDrawing(place, className, count) {
    const terrain = element('div', className)
    terrain.setAttribute('aria-label', 'Drawing tiled inside ' + place.name)
    for (let index = 0; index < count; index += 1) {
      const tile = drawingNode('place', place.id, place.name)
      tile.setAttribute('aria-hidden', index === 0 ? 'false' : 'true')
      terrain.append(tile)
    }
    return terrain
  }

  function liveThingFilters(focusId) {
    return Object.freeze({ placeId: focusId, resident: null })
  }

  function liveDisplayedThings(snapshot, placeId, focusId, includeDescendants = false) {
    const placeIds = includeDescendants ? placeScopeSet(placeId, snapshot) : new Set([placeId])
    return historyEntry('things', liveThingFilters(focusId)).rows
      .filter(thing => placeIds.has(thing.place_id))
  }

  function liveThingSelection(things, pinnedIds, exactTotal) {
    const total = exactTotal === null ? things.length : exactTotal
    const capacity = total > LIVE_THING_LIMIT ? LIVE_THING_LIMIT - 1 : LIVE_THING_LIMIT
    return windowLiveCapacitySelection(things, capacity, pinnedIds, total)
  }

  function liveThingPresentation(
    snapshot,
    placeId,
    records,
    focusId,
    includeDescendants = false,
    interactionThings = null,
  ) {
    const things = liveDisplayedThings(snapshot, placeId, focusId, includeDescendants)
    const pinnedIds = livePinnedThingIds(snapshot, records, placeId, interactionThings)
    const exactTotal = liveExactThingTotal(
      snapshot, placeId, things.length, includeDescendants)
    return Object.freeze({
      things,
      pinnedIds,
      exactTotal,
      selection: liveThingSelection(things, pinnedIds, exactTotal),
    })
  }

  function liveFocusInteractionThings(snapshot, focus, records) {
    const handle = state.live.focusResident
    if (!handle) return Object.freeze([])
    const focused = displayedResidents(snapshot).find(resident => resident.handle === handle)
    const focusScope = placeScopeSet(focus.id, snapshot)
    const things = historyEntry('things', liveThingFilters(focus.id)).rows
    const thingsById = new Map(things.map(thing => [thing.id, thing]))
    const references = new Map()
    const addReference = (id, recordedPlaceId) => {
      if (!id || references.has(id)) return
      const thing = thingsById.get(id)
      const interactionPlaceId = recordedPlaceId || thing?.place_id || null
      if (!interactionPlaceId || !focusScope.has(interactionPlaceId)) return
      references.set(id, Object.freeze({
        id,
        place_id: thing?.place_id || interactionPlaceId,
        recorded_place_id: interactionPlaceId,
        name: thing?.name || null,
        loaded: Boolean(thing),
      }))
    }
    const focusRecords = [...new Map([...records, ...liveInteractionRecords()]
      .map(record => [liveTraceKey(record), record])).values()]
      .sort((left, right) => {
        const timeOrder = right.at.getTime() - left.at.getTime()
        if (timeOrder) return timeOrder
        const leftKey = liveTraceKey(left)
        const rightKey = liveTraceKey(right)
        return leftKey < rightKey ? 1 : leftKey > rightKey ? -1 : 0
      })
    for (const record of focusRecords) {
      if (record.kind === 'transfer' && record.detail.asset_type === 'thing') {
        const involvesFocus = record.actor === handle ||
          (focused && record.detail.resident_id === focused.id)
        if (involvesFocus) addReference(record.detail.asset_id, record.detail.place_id)
        continue
      }
      if (record.actor !== handle) continue
      const recordedPlaceId = liveRecordPlaceId(record)
      addReference(record.detail.source_thing_id, recordedPlaceId)
      addReference(record.detail.thing_id, recordedPlaceId)
    }
    return Object.freeze([...references.values()])
  }

  function liveThingShelf(
    snapshot,
    place,
    records,
    focusId,
    includeDescendants = false,
    interactionThings = null,
  ) {
    const presentation = liveThingPresentation(
      snapshot, place.id, records, focusId, includeDescendants, interactionThings)
    const { things, pinnedIds, exactTotal, selection } = presentation
    if (!things.length && exactTotal !== null && exactTotal === 0) return null
    if (!things.length && exactTotal === null) return null
    const pinned = new Set(pinnedIds)
    const shelf = element('section', 'live-thing-shelf')
    shelf.setAttribute('aria-label', 'Things shown inside ' + place.name)
    for (const thing of selection.visible) {
      const specimen = element('a', 'live-thing-specimen')
      specimen.href = '/api/thing/' + String(thing.id)
      specimen.title = 'Read ' + thing.name
      specimen.dataset.focusKey = 'live-thing:' + String(thing.id)
      specimen.dataset.liveThingId = String(thing.id)
      specimen.dataset.liveThingPlaceId = String(thing.place_id)
      if (pinned.has(thing.id)) specimen.dataset.liveFocusThing = String(thing.id)
      const pulse = Object.values(state.live.replayActive).find(active =>
        active.type === 'use' && active.record.detail.source_thing_id === thing.id &&
        active.record.detail.place_id === thing.place_id)
      if (pulse) {
        specimen.classList.add('live-pulse')
        specimen.dataset.livePulseFor = pulse.key
        bindLiveHighlight(specimen, pulse.key, 'pulse')
      }
      specimen.append(
        drawingNode('thing', thing.id, thing.name),
        element('span', 'live-thing-name', thing.name),
      )
      shelf.append(specimen)
    }
    if (exactTotal === null && things.length > selection.visible.length) {
      const badge = element('span', 'live-overflow-badge live-thing-more', 'more · count unavailable')
      badge.title = 'Some named things are folded here; the exact count is unavailable.'
      shelf.append(badge)
    } else if (selection.overflowCount) {
      const badge = element('span', 'live-overflow-badge live-thing-more', '+' +
        String(selection.overflowCount) + ' more')
      badge.setAttribute('data-live-overflow-count', String(selection.overflowCount))
      badge.title = String(exactTotal) + ' things here; showing ' +
        String(selection.visible.length)
      if (Object.values(state.live.replayActive).some(active =>
        active.type === 'make' && liveRecordPlaceId(active.record) === place.id)) {
        badge.classList.add('live-overflow-absorbing')
      }
      shelf.append(badge)
    }
    return shelf
  }

  function livePlacePlot(snapshot, focus, place, plot, bubbles, records, interactionThings) {
    const card = element('article', 'live-plot')
    card.dataset.placeId = String(place.id)
    card.style.left = String(plot.x) + 'px'
    card.style.top = String(plot.y) + 'px'
    card.style.width = String(plot.width) + 'px'
    card.style.height = String(plot.height) + 'px'
    const terrain = liveTiledDrawing(place, 'live-plot-terrain', 40)
    const open = element('button', 'live-plot-open')
    open.type = 'button'
    open.dataset.focusKey = 'live-place:' + String(place.id)
    open.title = 'Open the live plate for ' + place.name
    open.addEventListener('click', () => navigate({ view: 'live', placeId: place.id }))
    open.append(element('span', 'live-plot-name', place.name),
      element('span', 'live-plot-number', '#' + String(place.id)))
    const drawing = state.live.drawings[liveDrawingKey('place', place.id)]
    const undrawn = drawing?.loaded && drawing.drawing === null
    card.dataset.undrawn = String(Boolean(undrawn))
    card.dataset.placeKind = focus.parent_id === null ? 'continent' : 'place'
    const owner = Object.hasOwn(place, 'owner')
      ? place.owner ? (undrawn ? 'undrawn · ' : '') + 'kept by ' + place.owner : 'ownerless world ground'
      : 'Place #' + String(place.id)
    card.append(terrain, open, element('p', 'live-plot-owner', owner))
    const residents = residentsAt(snapshot, place.id)
    if (residents.length) {
      card.append(livePortraitGrid(
        residents,
        'Residents inside ' + place.name,
        bubbles,
        place.id,
        livePinnedResidentIds(snapshot, records, place.id),
      ))
    }
    const shelf = liveThingShelf(snapshot, place, records, focus.id, true, interactionThings)
    if (shelf) card.append(shelf)
    return card
  }

  function liveStageSurvey(places, parentId) {
    const plots = windowLiveSurveyedPlots(places, parentId)
    const width = Math.max(1_100, ...plots.map(plot => plot.x + plot.width + 64))
    const height = Math.max(680, ...plots.map(plot => plot.y + plot.height + 96))
    return Object.freeze({ plots, width, height })
  }

  function renderLiveResidentPage() {
    if (!nodes.liveResidentPage) return
    const entry = state.residentPaging
    if (!entry.hasMore && !entry.loading && !entry.error) {
      nodes.liveResidentPage.hidden = true
      nodes.liveResidentPage.replaceChildren()
      return
    }
    const parts = []
    if (entry.error) {
      const message = element('p', 'navigation-error', 'Could not load more residents.')
      message.setAttribute('role', 'alert')
      parts.push(message)
    }
    const button = element('button', 'resident-load', entry.loading
      ? 'Loading more residents…'
      : entry.error ? 'Retry loading residents' : 'Load more residents')
    button.type = 'button'
    button.dataset.focusKey = 'live-resident-page'
    button.dataset.focusFallbackId = 'live-roster'
    button.setAttribute('aria-busy', String(entry.loading))
    button.setAttribute('aria-controls', 'live-roster')
    button.addEventListener('click', () => void loadResidents())
    parts.push(button)
    nodes.liveResidentPage.hidden = false
    nodes.liveResidentPage.replaceChildren(...parts)
  }

  function liveFocusInteractionsPanel(snapshot, focus, records, interactionThings) {
    const handle = state.live.focusResident
    if (!handle) return null
    const partnerIds = new Set(livePinnedResidentIds(snapshot, records, focus.id))
    const focused = displayedResidents(snapshot).find(resident => resident.handle === handle)
    if (focused) partnerIds.delete(focused.id)
    const things = interactionThings || liveFocusInteractionThings(snapshot, focus, records)
    const panel = element('section', 'live-focus-interactions')
    panel.id = 'live-focus-interactions'
    panel.append(
      element('p', 'block-number', 'FOCUS / INTERACTIONS'),
      element('h3', '', handle),
      element('p', 'live-focus-interactions-copy',
        String(partnerIds.size) + ' resident ' + (partnerIds.size === 1 ? 'partner stays' : 'partners stay') +
        ' marked in the complete roster. Every safely identified thing stays listed here.'),
    )
    const focusScope = placeScopeSet(focus.id, snapshot)
    if (focused && !focusScope.has(focused.current_place_id)) {
      const currentPlace = focused.current_place_id
        ? placeReference(snapshot, focused.current_place_id)
        : null
      const location = currentPlace
        ? currentPlace.name
        : focused.current_place_id ? 'Place #' + String(focused.current_place_id) : 'Between places'
      const card = element('div', 'live-focus-resident-card')
      card.dataset.liveFocusResident = focused.handle
      card.dataset.liveResidentHandle = focused.handle
      card.dataset.liveResidentScope = 'outside'
      card.setAttribute('aria-label', focused.handle + ' is outside this plate at ' + location)
      const copy = element('span', 'live-focus-resident-card-copy')
      copy.append(
        element('strong', 'live-focus-resident-card-name', focused.handle),
        element('span', 'live-focus-resident-card-location', 'Outside this plate · ' + location),
      )
      card.append(drawingNode('resident', focused.id, focused.handle), copy)
      panel.append(card)
    }
    if (!things.length) {
      panel.append(element('p', 'empty-row', 'No exact thing interaction is on this plate.'))
      return panel
    }
    const list = element('div', 'live-focus-thing-list')
    for (const thing of things) {
      const place = placeReference(snapshot, thing.place_id)
      const recordedPlace = placeReference(snapshot, thing.recorded_place_id)
      const location = place ? place.name : 'place #' + String(thing.place_id)
      const recordedLocation = recordedPlace
        ? recordedPlace.name
        : 'place #' + String(thing.recorded_place_id)
      const movedSinceInteraction = thing.loaded && thing.place_id !== thing.recorded_place_id
      const label = thing.loaded
        ? thing.name + (movedSinceInteraction
          ? ' · now in ' + location + ' · recorded in ' + recordedLocation
          : ' · ' + location)
        : 'Thing #' + String(thing.id) + ' · recorded in ' + recordedLocation
      const link = element('a', 'live-focus-thing-card', label)
      link.href = '/api/thing/' + String(thing.id)
      link.title = thing.loaded ? 'Read ' + thing.name : 'Read Thing #' + String(thing.id)
      link.dataset.focusKey = 'live-focus-thing:' + String(thing.id)
      link.dataset.liveFocusThing = String(thing.id)
      const pulse = Object.values(state.live.replayActive).find(active =>
        active.type === 'use' && active.record.detail.source_thing_id === thing.id &&
        active.record.detail.place_id === thing.recorded_place_id)
      if (pulse) {
        link.classList.add('live-pulse')
        link.dataset.livePulseFor = pulse.key
        bindLiveHighlight(link, pulse.key, 'pulse')
      }
      list.append(link)
    }
    panel.append(list)
    return panel
  }

  function renderLiveRoster(snapshot, focus, records, interactionThings) {
    if (!nodes.liveRoster) return
    renderLiveResidentPage()
    const scope = placeScopeSet(focus.id, snapshot)
    const residents = displayedResidents(snapshot).filter(resident =>
      scope.has(resident.current_place_id) &&
      (!state.resident || resident.handle === state.resident))
    const pinned = new Set(livePinnedResidentIds(snapshot, records, focus.id))
    const parts = []
    const focusPanel = liveFocusInteractionsPanel(snapshot, focus, records, interactionThings)
    if (focusPanel) parts.push(focusPanel)
    if (!residents.length) {
      const empty = element('p', 'empty-row', 'Nobody is here right now. The room keeps its things.')
      empty.setAttribute('role', 'status')
      nodes.liveRoster.replaceChildren(...parts, empty)
      return
    }
    const list = element('div', 'live-roster-list')
    for (const resident of [...residents.filter(row => !row.asleep),
      ...residents.filter(row => row.asleep)]) {
      const row = element('div', resident.asleep ? 'resident-row asleep' : 'resident-row')
      if (state.live.focusResident === resident.handle) {
        row.dataset.liveFocusResident = resident.handle
      } else if (pinned.has(resident.id)) {
        row.dataset.liveFocusPartner = resident.handle
      }
      const follow = element('button', 'resident-follow', resident.handle)
      follow.type = 'button'
      follow.dataset.focusKey = 'live-roster:' + resident.handle
      follow.dataset.liveResidentHandle = resident.handle
      follow.setAttribute('aria-pressed', String(state.live.focusResident === resident.handle))
      follow.addEventListener('click', () => toggleLiveFocusResident(resident.handle))
      const place = placeReference(snapshot, resident.current_place_id)
      const location = place ? place.name : resident.current_place_id
        ? 'Place #' + String(resident.current_place_id)
        : 'Between places'
      row.append(
        drawingNode('resident', resident.id, resident.handle),
        follow,
        element('span', 'resident-number', location + (resident.asleep ? ' · asleep' : '')),
      )
      list.append(row)
    }
    nodes.liveRoster.replaceChildren(...parts, list)
  }

  function liveAnchorPoint(anchorId, focusId, children) {
    if (anchorId === focusId) return Object.freeze({ x: 72, y: 58 })
    const plot = windowLiveSurveyedPlots(children, focusId)
      .find(candidate => candidate.id === anchorId)
    return plot ? Object.freeze({
      x: plot.x + plot.width / 2,
      y: plot.y + plot.height - 18,
    }) : null
  }

  function liveReplayPoint(placeId, focus, children) {
    const anchor = livePlaceAnchor(placeId, focus.id, children)
    return liveAnchorPoint(anchor, focus.id, children)
  }

  function liveReplayMoveGeometry(record, snapshot, focus, children) {
    const from = liveResidentReplayPoint(
      snapshot, record.detail.from_place_id, record.actor, focus, children)
    const to = liveResidentReplayPoint(
      snapshot, record.detail.to_place_id, record.actor, focus, children)
    if (!from || !to || (from.x === to.x && from.y === to.y)) return null
    return Object.freeze({ from, to })
  }

  function completeLiveReplay(actor, key) {
    const held = state.live.replayActive[actor]
    if (!held || held.key !== key) return
    const active = { ...state.live.replayActive }
    const positions = { ...state.live.replayPositions }
    const trailStarts = { ...state.live.trailStarts }
    const absorptionEndsAtByPlaceId = { ...state.live.absorptionEndsAtByPlaceId }
    const focus = state.snapshot ? liveFocusPlace(state.snapshot) : null
    const children = focus && state.snapshot ? liveChildren(state.snapshot, focus) : []
    const absorbingPlaceId = held.type === 'move' && focus
      ? livePlaceAnchor(held.toPlaceId, focus.id, children)
      : null
    delete active[actor]
    if (held.type === 'move') {
      positions[actor] = held.toPlaceId
      trailStarts[key] = Date.now()
      if (absorbingPlaceId) {
        absorptionEndsAtByPlaceId[String(absorbingPlaceId)] = Date.now() + LIVE_ABSORPTION_MS
      }
    }
    if (!state.live.replayQueues[actor]?.length) delete positions[actor]
    state = { ...state, live: {
      ...state.live,
      replayActive: Object.freeze(active),
      replayPositions: Object.freeze(positions),
      trailStarts: Object.freeze(trailStarts),
      absorptionEndsAtByPlaceId: Object.freeze(absorptionEndsAtByPlaceId),
    } }
    if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
    const absorptionEndsAt = absorbingPlaceId
      ? absorptionEndsAtByPlaceId[String(absorbingPlaceId)]
      : null
    if (absorptionEndsAt) {
      window.setTimeout(() => {
        if (!absorbingPlaceId ||
            state.live.absorptionEndsAtByPlaceId[String(absorbingPlaceId)] !== absorptionEndsAt) return
        const remaining = { ...state.live.absorptionEndsAtByPlaceId }
        delete remaining[String(absorbingPlaceId)]
        state = { ...state, live: {
          ...state.live,
          absorptionEndsAtByPlaceId: Object.freeze(remaining),
        } }
        if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
      }, LIVE_ABSORPTION_MS)
    }
  }

  function liveReplayThingIsDisplayed(record, snapshot, focus, children) {
    if (liveRecordType(record) !== 'use') return false
    const placeId = record.detail.place_id
    const anchorId = livePlaceAnchor(placeId, focus.id, children)
    if (!anchorId) return false
    const includeDescendants = anchorId !== focus.id
    const records = visibleLiveRecords(snapshot, focus, children)
    const interactionThings = liveFocusInteractionThings(snapshot, focus, records)
    const presentation = liveThingPresentation(
      snapshot, anchorId, records, focus.id, includeDescendants, interactionThings)
    const matches = thing => thing.id === record.detail.source_thing_id &&
      (thing.place_id === placeId || thing.recorded_place_id === placeId)
    return presentation.selection.visible.some(matches) ||
      interactionThings.some(matches)
  }

  function startLiveReplays() {
    if (state.view !== 'live' || document.hidden || !state.snapshot || state.live.paused) return
    if (state.live.streamMarker && !markerCovers(state.changeMarker, state.live.streamMarker)) return
    if (liveMotionReduced()) {
      if (liveReplayHeldKeys().size) {
        settleLiveReplays()
        renderLive(state.snapshot)
      }
      return
    }
    const focus = liveFocusPlace(state.snapshot)
    if (!focus) return
    const children = liveChildren(state.snapshot, focus)
    const now = Date.now()
    const queues = Object.fromEntries(Object.entries(state.live.replayQueues)
      .map(([actor, queue]) => [actor, [...queue]]))
    const active = { ...state.live.replayActive }
    const positions = { ...state.live.replayPositions }
    const trailStarts = { ...state.live.trailStarts }
    const revealed = new Set(state.live.replayRevealedKeys)
    const starts = []
    let changed = false

    for (const actor of Object.keys(queues)) {
      if (active[actor]) continue
      if (state.resident && actor !== state.resident) {
        for (const record of queues[actor]) revealed.add(liveTraceKey(record))
        delete queues[actor]
        delete positions[actor]
        changed = true
        continue
      }
      let queue = windowLiveReplayOrder(queues[actor], Number.NEGATIVE_INFINITY)
        .filter(record => liveRecordIsRecent(record, now))
      if (queue.length !== queues[actor].length) changed = true
      while (queue.length) {
        const record = queue[0]
        const type = liveRecordType(record)
        const key = liveTraceKey(record)
        const point = liveReplayPoint(liveRecordPlaceId(record), focus, children)
        if (type === 'note' && point) {
          const noteId = record.detail.note_id
          const entry = state.live.noteBodies[String(noteId)]
          if (!entry) {
            if (noteId) void loadLiveNote(noteId)
            break
          }
          if (entry.loading) break
        }

        if (type === 'move') {
          const resident = displayedResidents(state.snapshot)
            .find(candidate => candidate.handle === actor)
          const geometry = resident
            ? liveReplayMoveGeometry(record, state.snapshot, focus, children)
            : null
          if (!geometry) {
            queue = queue.slice(1)
            changed = true
            revealed.add(key)
            continue
          }
          const fromPlaceId = record.detail.from_place_id
          const distance = Math.hypot(
            geometry.to.x - geometry.from.x,
            geometry.to.y - geometry.from.y,
          )
          const remainingLifetime = record.at.getTime() + liveRecordLifetime(record) - now
          const duration = windowLiveReplayDuration(distance, remainingLifetime)
          if (!duration) {
            queue = queue.slice(1)
            changed = true
            revealed.add(key)
            continue
          }
          queue = queue.slice(1)
          changed = true
          revealed.add(key)
          positions[actor] = fromPlaceId
          trailStarts[key] = Date.now()
          active[actor] = Object.freeze({
            key, record, type,
            fromPlaceId,
            toPlaceId: record.detail.to_place_id,
            startedAt: Date.now(), duration,
          })
          starts.push(Object.freeze({ actor, key, duration }))
          break
        }

        queue = queue.slice(1)
        changed = true
        revealed.add(key)
        const canReplayHere = point && (type !== 'use' ||
          liveReplayThingIsDisplayed(record, state.snapshot, focus, children))
        if (!canReplayHere) continue
        const duration = type === 'note' ? LIVE_NOTE_REPLAY_MS : LIVE_PULSE_MS
        const remainingLifetime = record.at.getTime() + liveRecordLifetime(record) - now
        if (remainingLifetime < duration) continue
        active[actor] = Object.freeze({
          key, record, type, placeId: liveRecordPlaceId(record),
          startedAt: Date.now(), duration,
        })
        starts.push(Object.freeze({ actor, key, duration }))
        break
      }
      if (queue.length) queues[actor] = Object.freeze(queue)
      else delete queues[actor]
      if (!active[actor] && !queue.length) delete positions[actor]
    }
    if (!changed) return
    state = { ...state, live: {
      ...state.live,
      replayQueues: Object.freeze(queues),
      replayActive: Object.freeze(active),
      replayPositions: Object.freeze(positions),
      trailStarts: Object.freeze(trailStarts),
      replayRevealedKeys: Object.freeze([...revealed]),
    } }
    renderLive(state.snapshot)
    for (const start of starts) {
      window.setTimeout(() => completeLiveReplay(start.actor, start.key), start.duration)
    }
  }

  function renderLiveReplayPortraits(layer, snapshot, focus, children, bubbles) {
    for (const [actor, placeId] of Object.entries(state.live.replayPositions)) {
      if (state.resident && actor !== state.resident) continue
      const resident = displayedResidents(snapshot).find(candidate => candidate.handle === actor)
      if (!resident) continue
      const held = state.live.replayActive[actor]
      let point = liveResidentReplayPoint(snapshot, placeId, actor, focus, children)
      let destination = null
      let remaining = 0
      if (held?.type === 'move') {
        const geometry = liveReplayMoveGeometry(held.record, snapshot, focus, children)
        if (!geometry) continue
        const progress = Math.max(0, Math.min(1,
          (Date.now() - held.startedAt) / held.duration))
        point = Object.freeze({
          x: geometry.from.x + (geometry.to.x - geometry.from.x) * progress,
          y: geometry.from.y + (geometry.to.y - geometry.from.y) * progress,
        })
        destination = geometry.to
        remaining = Math.max(0, held.duration - (Date.now() - held.startedAt))
      }
      if (!point) continue
      const portrait = element('button', resident.asleep
        ? 'live-portrait asleep'
        : 'live-portrait')
      portrait.type = 'button'
      portrait.dataset.focusKey = 'live-resident:' + actor
      portrait.dataset.liveResidentHandle = actor
      portrait.title = state.live.focusResident === actor
        ? 'Clear focus from ' + actor
        : 'Focus on ' + actor
      portrait.setAttribute('aria-pressed', String(state.live.focusResident === actor))
      const shell = livePortraitShell(
        portrait,
        bubbles.get(actor),
        'live-portrait-wrap live-replay-portrait',
      )
      shell.dataset.liveReplayKey = held?.key || ''
      if (state.live.focusResident === actor) {
        shell.setAttribute('data-live-focus-resident', actor)
      }
      if (held) {
        shell.dataset.liveAt = String(held.record.at.getTime())
        shell.dataset.liveLifetime = String(liveRecordLifetime(held.record))
      }
      shell.style.left = String(point.x) + 'px'
      shell.style.top = String(point.y) + 'px'
      if (destination && remaining > 0) {
        shell.style.setProperty('--live-replay-to-x', String(destination.x) + 'px')
        shell.style.setProperty('--live-replay-to-y', String(destination.y) + 'px')
        shell.style.animationDuration = String(remaining) + 'ms'
        shell.dataset.fromPlaceId = String(held.fromPlaceId)
        shell.dataset.toPlaceId = String(held.toPlaceId)
        shell.dataset.replayDuration = String(held.duration)
      }
      portrait.addEventListener('click', () => toggleLiveFocusResident(actor))
      portrait.append(
        drawingNode('resident', resident.id, actor),
        element('span', 'live-portrait-name', actor),
      )
      layer.append(shell)
    }
  }

  function visibleLiveRecords(snapshot, focus, children) {
    const now = Date.now()
    return liveRecords().filter(record => {
      const type = liveRecordType(record)
      if (!type || (state.resident && record.actor !== state.resident)) return false
      if (windowLiveTraceOpacity(record.at.getTime(), now, liveRecordLifetime(record)) <= 0) {
        return false
      }
      if (type === 'move') {
        return Boolean(
          livePlaceAnchor(record.detail.from_place_id, focus.id, children) ||
          livePlaceAnchor(record.detail.to_place_id, focus.id, children)
        )
      }
      return Boolean(livePlaceAnchor(liveRecordPlaceId(record), focus.id, children))
    })
  }

  function bindLiveHighlight(node, key, surface) {
    node.dataset.liveKey = key
    if (!node.dataset.focusKey) node.dataset.focusKey = 'live-record:' + surface + ':' + key
    node.dataset.highlighted = String(state.live.highlightedKey === key)
    node.addEventListener('mouseenter', () => setLiveHighlight(key))
    node.addEventListener('mouseleave', () => setLiveHighlight(null))
    node.addEventListener('focus', () => setLiveHighlight(key))
    node.addEventListener('blur', () => setLiveHighlight(null))
    node.addEventListener('click', () => setLiveHighlight(
      state.live.highlightedKey === key ? null : key))
  }

  function liveTrailTiming(record, key) {
    const active = Object.values(state.live.replayActive).find(candidate =>
      candidate.type === 'move' && candidate.key === key)
    if (active) {
      return Object.freeze({
        at: active.startedAt,
        lifetime: active.duration + LIVE_TRAIL_LIFETIME_MS,
        duration: active.duration,
        replaying: true,
      })
    }
    const startedAt = Number(state.live.trailStarts[key]) || record.at.getTime()
    return Object.freeze({
      at: startedAt,
      lifetime: LIVE_TRAIL_LIFETIME_MS,
      duration: 0,
      replaying: false,
    })
  }

  function renderLiveTraceLayer(snapshot, focus, children, records, bubbles, survey) {
    const layer = element('div', 'live-trace-layer')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.classList.add('live-traces')
    svg.setAttribute('viewBox', '0 0 ' + String(survey.width) + ' ' + String(survey.height))
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.setAttribute('aria-label', 'Recent movement trails')
    const definitions = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker')
    marker.setAttribute('id', 'live-trace-arrow')
    marker.setAttribute('markerWidth', '6')
    marker.setAttribute('markerHeight', '6')
    marker.setAttribute('refX', '5')
    marker.setAttribute('refY', '3')
    marker.setAttribute('orient', 'auto')
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    arrow.setAttribute('d', 'M0,0 L6,3 L0,6 Z')
    arrow.classList.add('live-trace-arrowhead')
    marker.append(arrow)
    definitions.append(marker)
    svg.append(definitions)

    const noteNumbers = new Map(records.map((record, index) => [liveTraceKey(record), index + 1]))
    for (const record of records) {
      const type = liveRecordType(record)
      const key = liveTraceKey(record)
      if (!liveReplayRecordIsRevealed(record)) continue
      const recordOpacity = windowLiveTraceOpacity(
        record.at.getTime(), Date.now(), liveRecordLifetime(record))
      if (type === 'move') {
        const geometry = liveReplayMoveGeometry(record, snapshot, focus, children)
        const from = geometry?.from
        const to = geometry?.to
        if (!from || !to || (from.x === to.x && from.y === to.y)) continue
        const timing = liveTrailTiming(record, key)
        const opacity = windowLiveTraceOpacity(timing.at, Date.now(), timing.lifetime)
        if (opacity <= 0) continue
        const trail = document.createElementNS('http://www.w3.org/2000/svg', 'line')
        trail.classList.add('live-trail')
        if (timing.replaying) trail.classList.add('live-trail-inking')
        trail.setAttribute('x1', String(from.x))
        trail.setAttribute('y1', String(from.y))
        trail.setAttribute('x2', String(to.x))
        trail.setAttribute('y2', String(to.y))
        trail.setAttribute('marker-end', 'url(#live-trace-arrow)')
        trail.setAttribute('tabindex', '0')
        trail.setAttribute('role', 'button')
        trail.setAttribute('aria-label', record.actor + ' moved from ' +
          String(record.detail.from_place_id) + ' to ' + String(record.detail.to_place_id))
        trail.dataset.liveAt = String(timing.at)
        trail.dataset.liveLifetime = String(timing.lifetime)
        trail.dataset.replaying = String(timing.replaying)
        if (timing.duration) {
          trail.style.setProperty('--live-trail-duration', String(timing.duration) + 'ms')
        }
        trail.style.opacity = String(opacity)
        bindLiveHighlight(trail, key, 'trail')
        svg.append(trail)
        continue
      }
      const placeId = liveRecordPlaceId(record)
      const anchor = livePlaceAnchor(placeId, focus.id, children)
      const point = liveAnchorPoint(anchor, focus.id, children)
      if (!point) continue
      if (type === 'note') {
        const mark = element('button', 'live-footnote-mark', String(noteNumbers.get(key)))
        mark.type = 'button'
        mark.style.left = String(point.x) + 'px'
        mark.style.top = String(point.y) + 'px'
        mark.dataset.liveAt = String(record.at.getTime())
        mark.dataset.liveLifetime = String(liveRecordLifetime(record))
        mark.style.opacity = String(recordOpacity)
        mark.setAttribute('aria-label', 'Show ' + record.actor + "'s note in the plate ledger")
        bindLiveHighlight(mark, key, 'mark')
        layer.append(mark)
      } else if (type === 'make' && state.live.replayActive[record.actor]?.key === key) {
        const pulse = element('span', 'live-action-mark live-pulse', type === 'make' ? '+' : '×')
        pulse.style.left = String(point.x) + 'px'
        pulse.style.top = String(point.y) + 'px'
        pulse.setAttribute('role', 'img')
        pulse.setAttribute('aria-label', record.actor + (type === 'make'
          ? ' made something here'
          : ' used something here'))
        bindLiveHighlight(pulse, key, 'pulse')
        layer.append(pulse)
      }
    }
    layer.prepend(svg)
    renderLiveReplayPortraits(layer, snapshot, focus, children, bubbles)
    return layer
  }

  function livePlaceName(snapshot, id) {
    const place = placeReference(snapshot, id)
    return place ? place.name : id ? 'Place #' + String(id) : 'between places'
  }

  function liveLedgerText(snapshot, record) {
    const type = liveRecordType(record)
    if (type === 'move') {
      return record.actor + ' moved: ' + livePlaceName(snapshot, record.detail.from_place_id) +
        ' → ' + livePlaceName(snapshot, record.detail.to_place_id)
    }
    if (type === 'note') {
      const noteId = record.detail.note_id
      const entry = state.live.noteBodies[String(noteId)]
      if (!entry && noteId) void loadLiveNote(noteId)
      if (entry?.body) {
        return record.actor + ': ' + entry.body
      }
      if (entry?.error) return record.actor + "'s note #" + String(noteId) + ' could not be read.'
      return 'Reading ' + record.actor + "'s note #" + String(noteId) + '…'
    }
    const placeId = liveRecordPlaceId(record)
    if (type === 'make') {
      return record.actor + ' made thing #' + String(record.detail.thing_id || '?') +
        ' in ' + livePlaceName(snapshot, placeId)
    }
    return record.actor + ' used thing #' + String(record.detail.source_thing_id || '?') +
      ' in ' + livePlaceName(snapshot, placeId)
  }

  function renderLiveLedger(snapshot, focus, children, suppliedRecords) {
    if (!nodes.liveLedger) return
    const liveFocus = focus || liveFocusPlace(snapshot)
    if (!liveFocus) {
      nodes.liveLedger.replaceChildren(element('li', 'empty-row', 'No public plate is available.'))
      return
    }
    const liveChildrenRows = children || liveChildren(snapshot, liveFocus)
    const records = suppliedRecords || visibleLiveRecords(snapshot, liveFocus, liveChildrenRows)
    if (!records.length) {
      nodes.liveLedger.replaceChildren(element('li', 'empty-row',
        'No recent marks reach this plate. The city moves only when residents act.'))
      return
    }
    nodes.liveLedger.replaceChildren(...records.map((record, index) => {
      const row = element('li', 'live-ledger-row')
      const key = liveTraceKey(record)
      const number = element('span', 'live-ledger-number', String(index + 1).padStart(2, '0'))
      const copy = element('p', 'live-ledger-copy', liveLedgerText(snapshot, record))
      const age = windowLiveTraceOpacity(record.at.getTime(), Date.now(), liveRecordLifetime(record))
      row.dataset.liveAt = String(record.at.getTime())
      row.dataset.liveLifetime = String(liveRecordLifetime(record))
      row.style.opacity = String(Math.max(0.25, age))
      row.append(number, copy, timeNode(record.at, 'live-ledger-time'))
      row.tabIndex = 0
      bindLiveHighlight(row, key, 'ledger')
      return row
    }))
  }

  function renderLiveHistoryStatus() {
    if (!nodes.liveHistoryStatus) return
    const parts = []
    if (state.live.openingLoading) {
      parts.push(document.createTextNode('Reading backward to the 30-minute trace edge…'))
    } else if (state.live.openingPaused) {
      parts.push(document.createTextNode(
        'Automatic recent-history reading pauses after 1,600 public events. Continue recent history to read the next pages; this viewer will not call the history complete while pages remain. '
      ))
      const continueButton = element('button', 'live-history-retry', 'Continue recent history')
      continueButton.type = 'button'
      continueButton.dataset.focusKey = 'live-history-opening-continue'
      continueButton.addEventListener('click', () => {
        if (state.snapshot) void loadLiveOpeningHistory(state.snapshot, true)
      })
      parts.push(continueButton)
    } else if (state.live.openingError) {
      parts.push(document.createTextNode(
        'Recent history is incomplete before the 30-minute edge. The plate shows only records it could verify. '
      ))
      const retry = element('button', 'live-history-retry', 'Retry recent history')
      retry.type = 'button'
      retry.dataset.focusKey = 'live-history-opening-retry'
      retry.addEventListener('click', () => {
        if (state.snapshot) void loadLiveOpeningHistory(state.snapshot, true)
      })
      parts.push(retry)
    } else if (state.live.openingComplete) {
      parts.push(document.createTextNode('Recent history is complete through the 30-minute trace edge.'))
    } else {
      parts.push(document.createTextNode('Preparing the recent public record…'))
    }
    if (state.live.streamError) {
      parts.push(document.createTextNode(
        ' The latest change pages could not be completed; this plate is holding its last verified cursor. '
      ))
      const retry = element('button', 'live-history-retry', 'Retry the latest read')
      retry.type = 'button'
      retry.dataset.focusKey = 'live-history-stream-retry'
      retry.addEventListener('click', () => void refreshCity())
      parts.push(retry)
    }
    const snapshot = state.snapshot
    const focus = snapshot ? liveFocusPlace(snapshot) : null
    if (snapshot && focus) {
      const thingFilters = liveThingFilters(focus.id)
      const thingsPage = historyEntry('things', thingFilters)
      const namedThingCount = liveDisplayedThings(
        snapshot, focus.id, focus.id, true).length
      const exactThingTotal = liveExactThingTotal(
        snapshot, focus.id, namedThingCount, true)
      if (exactThingTotal === null) {
        parts.push(document.createTextNode(
          ' Exact +N thing counts are unavailable because the fixed survey is incomplete or disagrees with the named cards.'
        ))
      } else if (thingsPage.error) {
        parts.push(document.createTextNode(
          ' Exact +N thing counts stay verified, but newest named thing cards could not be read. '
        ))
        const retry = element('button', 'live-history-retry', 'Retry named thing cards')
        retry.type = 'button'
        retry.dataset.focusKey = 'live-things-retry'
        retry.addEventListener('click', () => void loadHistory('things', thingFilters))
        parts.push(retry)
      } else if (thingsPage.loading || !thingsPage.initialized) {
        parts.push(document.createTextNode(
          ' Exact +N thing counts come from the fixed survey while newest named cards load. ' +
          'The named-card sample stops after one page of at most 50 public things.'
        ))
      } else if (thingsPage.hasMore) {
        parts.push(document.createTextNode(
          ' Showing the newest ' + String(thingsPage.rows.length) +
          ' named thing cards, from a one-page limit of 50; exact +N includes every other public thing in this plate.'
        ))
      }
    }
    nodes.liveHistoryStatus.replaceChildren(...parts)
  }

  async function loadLiveOpeningHistory(snapshot, force) {
    if (state.view !== 'live' || document.hidden || state.live.openingLoading ||
        (state.live.openingLoaded && !force)) return
    const requestMarker = state.live.openingMarker || snapshot.changeMarker || state.changeMarker
    if (!requestMarker) return
    const startingEvents = force ? state.live.openingEvents : []
    const startingBeforeId = force ? state.live.openingNextBeforeId : null
    state = {
      ...state,
      live: {
        ...state.live,
        openingMarker: requestMarker,
        openingEvents: startingEvents,
        openingLoaded: false,
        openingLoading: true,
        openingComplete: false,
        openingPaused: false,
        openingError: false,
        openingNextBeforeId: startingBeforeId,
        changes: state.live.openingMarker ? state.live.changes : [],
        streamMarker: state.live.openingMarker ? state.live.streamMarker : requestMarker,
      },
    }
    renderLiveHistoryStatus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let events = startingEvents
    let beforeId = startingBeforeId
    let heldMarker = startingBeforeId ? requestMarker : null
    const seenCursors = new Set()
    let complete = false
    let automaticPaused = false
    let visibilityPaused = false
    let pageCount = 0
    try {
      while (!complete) {
        if (state.view !== 'live' || document.hidden) {
          visibilityPaused = true
          break
        }
        const url = new URL('/api/events', window.location.origin)
        url.searchParams.set('limit', String(LIVE_OPENING_PAGE_LIMIT))
        url.searchParams.set('within_seconds', String(LIVE_MOVE_LIFETIME_MS / 1000))
        url.searchParams.set('after_change_marker', heldMarker || requestMarker)
        if (beforeId) url.searchParams.set('before_id', String(beforeId))
        const response = await fetch(url.pathname + url.search, {
          credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
          redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
        })
        if (!response.ok) throw new Error('recent public events unavailable')
        const payload = await response.json()
        if (!payload || typeof payload !== 'object') throw new Error('invalid recent public events')
        const pageMarker = safeChangeMarker(payload.change_marker)
        if (!pageMarker || !markerCovers(pageMarker, heldMarker || requestMarker)) {
          throw new Error('recent public event marker did not cover its page')
        }
        if (!heldMarker) heldMarker = pageMarker
        const incoming = normalizeEvents(payload.events, LIVE_OPENING_PAGE_LIMIT)
        const covered = incoming.filter(event => event.change_id &&
          BigInt(event.change_id) <= BigInt(heldMarker))
        const previousLength = events.length
        events = mergeWindowRows(events, covered)
        pageCount += 1
        if (payload.has_more !== true) {
          complete = true
          beforeId = null
          break
        }
        const nextBeforeId = safeId(payload.next_before_id)
        if (!incoming.length || !nextBeforeId || seenCursors.has(nextBeforeId) ||
            !incoming.some(event => event.id === nextBeforeId) ||
            (beforeId && nextBeforeId >= beforeId) || events.length <= previousLength) {
          throw new Error('recent public event cursor did not progress')
        }
        seenCursors.add(nextBeforeId)
        beforeId = nextBeforeId
        if (pageCount >= MAX_AUTO_HISTORY_PAGES) {
          automaticPaused = true
          break
        }
      }
      const latestAt = events.length
        ? Math.max(...events.map(event => event.at.getTime()))
        : state.live.lastChangeAt
      const streamBase = heldMarker || requestMarker
      const changes = Object.freeze(state.live.changes.filter(change =>
        BigInt(change.change_id) > BigInt(streamBase)))
      const streamMarker = markerCovers(state.live.streamMarker, streamBase)
        ? state.live.streamMarker
        : streamBase
      state = {
        ...state,
        live: {
          ...state.live,
          openingEvents: Object.freeze(events),
          openingMarker: streamBase,
          openingLoaded: !visibilityPaused,
          openingLoading: false,
          openingComplete: complete,
          openingPaused: automaticPaused,
          openingError: false,
          openingNextBeforeId: beforeId,
          changes,
          streamMarker,
          lastChangeAt: latestAt || null,
        },
      }
    } catch {
      const streamBase = heldMarker || requestMarker
      const changes = Object.freeze(state.live.changes.filter(change =>
        BigInt(change.change_id) > BigInt(streamBase)))
      state = {
        ...state,
        live: {
          ...state.live,
          openingEvents: Object.freeze(events),
          openingMarker: streamBase,
          openingLoaded: true,
          openingLoading: false,
          openingComplete: false,
          openingPaused: false,
          openingError: true,
          openingNextBeforeId: beforeId,
          changes,
          streamMarker: markerCovers(state.live.streamMarker, streamBase)
            ? state.live.streamMarker
            : streamBase,
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (state.live.openingComplete && !state.live.openingError) {
        queueLiveReplays([...state.live.openingEvents, ...state.live.changes])
      }
      if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
      if (state.view === 'live' && !document.hidden && heldMarker &&
          !markerCovers(state.changeMarker, heldMarker)) void refreshCity()
    }
  }

  function liveAgeLabel(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000))
    if (seconds < 60) return String(seconds) + 's'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return String(minutes) + (minutes === 1 ? ' minute' : ' minutes')
    const hours = Math.floor(minutes / 60)
    return String(hours) + (hours === 1 ? ' hour' : ' hours')
  }

  function renderLiveClock() {
    if (!nodes.liveClock) return
    if (document.hidden) {
      nodes.liveClock.textContent = 'Reads pause while this tab is hidden. The last completed plate stays visible.'
      return
    }
    const now = Date.now()
    const next = state.live.nextReadAt
      ? ' · next read in ' + String(Math.max(0, Math.ceil((state.live.nextReadAt - now) / 1000))) + 's'
      : ' · next read pending'
    if (!state.live.lastChangeAt) {
      nodes.liveClock.textContent =
        'The city has been still for longer than this plate can show. It moves only when residents act.' + next
      return
    }
    const elapsed = Math.max(0, now - state.live.lastChangeAt)
    nodes.liveClock.textContent = elapsed >= 60000
      ? 'The city has been still for ' + liveAgeLabel(elapsed) +
        '. It moves only when residents act.' + next
      : 'last change ' + liveAgeLabel(elapsed) + ' ago' + next
  }

  function moveLiveFocusAfterExpiry(key) {
    const candidates = [
      ...(nodes.livePlates?.querySelectorAll('[data-live-key]') || []),
      ...(nodes.liveLedger?.querySelectorAll('[data-live-key]') || []),
    ]
    const paired = candidates.find(candidate =>
      candidate.isConnected && candidate.dataset.liveKey === key)
    const fallback = paired || nodes.liveViewport || nodes.livePause
    if (typeof fallback?.focus === 'function') fallback.focus()
  }

  function renderLiveAging() {
    if (state.view !== 'live' || document.hidden) return
    const now = Date.now()
    const trailStarts = windowLivePruneTrailStarts(
      state.live.trailStarts,
      now,
      LIVE_TRAIL_LIFETIME_MS,
      [...liveReplayHeldKeys()],
    )
    if (trailStarts !== state.live.trailStarts) {
      state = { ...state, live: { ...state.live, trailStarts } }
    }
    pruneLiveNoteBodies(now)
    const agedNodes = [
      ...(nodes.livePlates?.querySelectorAll('[data-live-at][data-live-lifetime]') || []),
      ...(nodes.liveLedger?.querySelectorAll('[data-live-at][data-live-lifetime]') || []),
    ]
    let expiredLedgerRow = false
    for (const node of agedNodes) {
      const opacity = windowLiveTraceOpacity(
        Number(node.dataset.liveAt), now, Number(node.dataset.liveLifetime))
      if (opacity <= 0) {
        expiredLedgerRow ||= node.classList.contains('live-ledger-row')
        const active = document.activeElement
        const movesFocus = active === node || node.contains(active)
        const key = node.dataset.liveKey
        node.remove()
        if (movesFocus) moveLiveFocusAfterExpiry(key)
      } else {
        node.style.opacity = String(node.classList.contains('live-ledger-row')
          ? Math.max(0.25, opacity)
          : opacity)
      }
    }
    if (expiredLedgerRow && nodes.liveLedger &&
        !nodes.liveLedger.querySelector('.live-ledger-row')) {
      nodes.liveLedger.replaceChildren(element('li', 'empty-row',
        'No recent marks reach this plate. The city moves only when residents act.'))
    }
  }

  function scheduleLiveClock() {
    window.clearTimeout(state.live.clockTimer)
    if (state.view !== 'live') {
      if (state.live.clockTimer) {
        state = { ...state, live: { ...state.live, clockTimer: 0 } }
      }
      return
    }
    renderLiveClock()
    renderLiveAging()
    const clockTimer = window.setTimeout(scheduleLiveClock, 1000)
    state = { ...state, live: { ...state.live, clockTimer } }
  }

  function renderLivePopulationGate(message, retryLabel, retry) {
    clearLiveScopeSurfaces('Waiting for this plate to finish loading…')
    if (nodes.liveMapCaption) nodes.liveMapCaption.hidden = true
    const row = element('div', retry ? 'error-row' : 'loading-row')
    row.append(element('p', '', message))
    if (retry) {
      const button = element('button', 'selection-retry', retryLabel)
      button.type = 'button'
      button.dataset.focusKey = 'live-population-retry'
      button.addEventListener('click', retry)
      row.append(button)
    }
    nodes.livePlates.replaceChildren(row)
    renderLiveHistoryStatus()
    scheduleLiveClock()
  }

  function clearLiveScopeSurfaces(message) {
    if (nodes.liveWorldGround) nodes.liveWorldGround.replaceChildren()
    if (nodes.liveLedger) {
      nodes.liveLedger.replaceChildren(element('li', 'loading-row', message))
    }
    if (nodes.liveRoster) {
      nodes.liveRoster.replaceChildren(element('p', 'loading-row', message))
    }
    if (nodes.liveResidentPage) {
      nodes.liveResidentPage.hidden = true
      nodes.liveResidentPage.replaceChildren()
    }
  }

  function renderLive(snapshot) {
    if (!nodes.livePlates || !nodes.liveStage) return
    if (nodes.liveMapCaption) nodes.liveMapCaption.hidden = true
    const active = document.activeElement
    const focusKey = active?.closest?.('#live-panel') && active.dataset
      ? active.dataset.focusKey || null
      : null
    const residentCensusComplete = !state.residentPaging.loading &&
      !state.residentPaging.hasMore && !state.residentPaging.error
    if (state.live.focusResident && state.directory.loaded && residentCensusComplete &&
        !state.directory.residents.some(resident =>
          resident.handle === state.live.focusResident) &&
        !displayedResidents(snapshot).some(resident =>
          resident.handle === state.live.focusResident)) {
      storeLiveFocusResident(null)
      state = { ...state, live: { ...state.live, focusResident: null } }
    }
    renderLiveFocusStatus()
    if (nodes.livePause) {
      nodes.livePause.setAttribute('aria-pressed', String(state.live.paused))
      nodes.livePause.textContent = state.live.paused ? 'Resume walks' : 'Pause walks'
    }
    const issue = selectionIssue(snapshot, true)
    if (issue) {
      clearLiveScopeSurfaces('Waiting for a valid current plate…')
      renderSelectionIssue(nodes.livePlates, issue)
      renderLiveHistoryStatus()
      scheduleLiveClock()
      restoreFocus(focusKey, null, null)
      return
    }
    if (!state.directory.loaded) {
      clearLiveScopeSurfaces('Waiting for the fixed public survey…')
      const message = element('div', state.directory.error ? 'error-row' : 'loading-row')
      message.append(element('p', '', state.directory.error
        ? 'The complete public place list could not be read, so this viewer will not guess where fixed plots belong.'
        : 'Reading the complete public place list before fixing every plot to its ground…'))
      if (state.directory.error) {
        const retry = element('button', 'selection-retry', 'Retry the fixed survey')
        retry.type = 'button'
        retry.dataset.focusKey = 'live-directory-retry'
        retry.addEventListener('click', () => void loadDirectory(true))
        message.append(retry)
      }
      nodes.livePlates.replaceChildren(message)
      renderLiveHistoryStatus()
      scheduleLiveClock()
      restoreFocus(focusKey, null, null)
      return
    }
    const residentPage = state.residentPaging
    if (residentPage.loading || residentPage.hasMore || residentPage.error ||
        residentPage.automaticPaused) {
      renderLivePopulationGate(
        residentPage.automaticPaused
          ? 'Automatic census reading pauses after 1,600 public residents. Continue the exact census to read the next pages; this viewer will not guess while pages remain.'
          : residentPage.error
          ? 'The complete public resident census could not be read, so this viewer will not print a guessed crowd count.'
          : 'Reading the complete public resident census before printing exact crowd counts…',
        residentPage.automaticPaused
          ? 'Continue the exact resident census'
          : 'Retry the complete resident census',
        residentPage.error || residentPage.automaticPaused
          ? () => void loadResidents()
          : null,
      )
      if (!residentPage.loading && residentPage.hasMore && !residentPage.error &&
          !residentPage.automaticPaused && !document.hidden) {
        window.queueMicrotask(() => {
          if (state.view === 'live' && !document.hidden) void loadResidents(true)
        })
      }
      restoreFocus(focusKey, null, null)
      return
    }
    const focus = liveFocusPlace(snapshot)
    if (!focus) {
      clearLiveScopeSurfaces('No public plate is available.')
      renderEmpty(nodes.livePlates, 'empty-row', 'No public plate is available.')
      renderLiveHistoryStatus()
      scheduleLiveClock()
      restoreFocus(focusKey, null, null)
      return
    }
    const thingFilters = liveThingFilters(focus.id)
    const thingsPage = historyEntry('things', thingFilters)
    const children = liveChildren(snapshot, focus)
    const records = visibleLiveRecords(snapshot, focus, children)
    const interactionThings = liveFocusInteractionThings(snapshot, focus, records)
    const bubbles = liveSpeechBubbles(records)
    const survey = liveStageSurvey(livePlaceRows(snapshot), focus.id)
    const stageId = String(focus.id)
    const stageChanged = liveCamera.stageId !== stageId
    renderLiveBreadcrumbs(snapshot, focus)

    nodes.liveStage.style.setProperty('--live-stage-width', String(survey.width) + 'px')
    nodes.liveStage.style.setProperty('--live-stage-height', String(survey.height) + 'px')
    nodes.liveStage.dataset.liveStageWidth = String(survey.width)
    nodes.liveStage.dataset.liveStageHeight = String(survey.height)
    nodes.liveStage.setAttribute('aria-label', 'Live surveyed plate for ' + focus.name)

    if (nodes.liveMapCaption) {
      nodes.liveMapCaption.hidden = false
      nodes.liveMapCaption.replaceChildren(
        element('p', 'block-number', 'LIVE PLATE / PLACE #' + String(focus.id)),
        element('h3', 'live-plate-title', focus.name),
        element('p', 'live-plate-legend',
          'brick dash = recorded endpoints + drawn-in glide · brick pulse on a thing = recorded use · walkers move above fixed plots · +N more = an exact hidden crowd · click a resident to focus'),
      )
    }

    if (nodes.liveWorldGround) {
      const tileSize = 56
      const tileCount = Math.ceil(survey.width / tileSize) * Math.ceil(survey.height / tileSize)
      const tiled = liveTiledDrawing(focus, 'live-world-ground-tiles', tileCount)
      nodes.liveWorldGround.replaceChildren(...tiled.children)
      nodes.liveWorldGround.title = focus.name + ' authored ground'
    }

    const plateParts = []
    for (const plot of survey.plots) {
      const place = children.find(candidate => candidate.id === plot.id)
      if (place) {
        plateParts.push(livePlacePlot(
          snapshot, focus, place, plot, bubbles, records, interactionThings))
      }
    }
    const directResidents = displayedResidents(snapshot).filter(resident =>
      resident.current_place_id === focus.id &&
      (!state.resident || resident.handle === state.resident))
    if (directResidents.length) {
      plateParts.push(livePortraitGrid(
        directResidents,
        'Residents standing directly in ' + focus.name,
        bubbles,
        focus.id,
        livePinnedResidentIds(snapshot, records, focus.id),
        'live-walker-layer live-root-walkers',
      ))
    }
    const focusShelf = liveThingShelf(
      snapshot, focus, records, focus.id, false, interactionThings)
    if (focusShelf) {
      focusShelf.classList.add('live-focus-thing-shelf')
      plateParts.push(focusShelf)
    }
    if (!children.length && !directResidents.length && !focusShelf) {
      plateParts.push(element('p', 'live-room-empty live-stage-empty',
        directResidents.length
          ? 'No smaller public places are drawn inside this room.'
          : 'Nobody is here right now. The fixed ground stays ready.'))
    }
    plateParts.push(renderLiveTraceLayer(snapshot, focus, children, records, bubbles, survey))
    nodes.livePlates.replaceChildren(...plateParts)

    if (stageChanged) {
      applyLiveCamera({
        scale: 1, offsetX: 0, offsetY: 0, stageId, fitted: false,
        panStart: null, pinchStart: null,
      })
      window.requestAnimationFrame(() => {
        if (liveCamera.stageId === stageId && !liveCamera.fitted) fitLivePlate()
      })
    } else {
      applyLiveCamera({ stageId })
    }
    renderLiveLedger(snapshot, focus, children, records)
    renderLiveRoster(snapshot, focus, records, interactionThings)
    renderLiveHistoryStatus()
    scheduleLiveClock()
    restoreFocus(focusKey, null, null)
    if (!state.live.openingLoaded && !state.live.openingLoading) {
      void loadLiveOpeningHistory(snapshot, Boolean(
        state.live.openingNextBeforeId || state.live.openingEvents.length))
    }
    if (!thingsPage.loading && !thingsPage.initialized && !thingsPage.error &&
        !document.hidden) {
      window.queueMicrotask(() => {
        const latest = historyEntry('things', thingFilters)
        if (state.view === 'live' && !document.hidden && !latest.loading &&
            !latest.initialized && !latest.error) {
          void loadHistory('things', thingFilters)
        }
      })
    }
    if (Object.keys(state.live.replayQueues).length) {
      window.queueMicrotask(startLiveReplays)
    }
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
        residentNode(event.actor, 'activity-actor', 'activity-actor:' + String(event.id)),
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

  async function loadHistory(collection, filters, automatic = false) {
    if (automatic && (state.view !== 'live' || document.hidden)) return
    const current = historyEntry(collection, filters)
    if (current.loading || (current.initialized && !current.hasMore && !current.error)) return
    if (automatic && (current.automaticPageCount || 0) >= MAX_AUTO_HISTORY_PAGES) {
      setHistoryEntry(collection, filters, {
        ...current, loading: false, error: false, automaticPaused: true,
      })
      renderAll()
      return
    }
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    setHistoryEntry(collection, filters, {
      ...current,
      loading: true,
      error: false,
      automaticPaused: false,
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
      const requestedBeforeId = requestEntry.initialized ? requestEntry.nextBeforeId : null
      const latest = historyEntry(collection, filters)
      const rows = mergeWindowRows(latest.rows, incoming)
      if (hasMore && (!nextBeforeId ||
          !incoming.some(row => row.id === nextBeforeId) ||
          (requestedBeforeId && nextBeforeId >= requestedBeforeId))) {
        throw new Error('public history cursor did not progress')
      }
      if (hasMore && requestEntry.initialized && rows.length <= latest.rows.length) {
        throw new Error('public history page did not add a row')
      }
      const automaticPageCount = automatic
        ? (latest.automaticPageCount || 0) + 1
        : 0
      const automaticLimitReached = automatic && hasMore &&
        automaticPageCount >= MAX_AUTO_HISTORY_PAGES
      setHistoryEntry(collection, filters, {
        rows,
        hasMore,
        nextBeforeId,
        automaticPageCount,
        automaticPaused: automaticLimitReached,
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
    for (const tab of tabs) {
      const active = tab.dataset.view === state.view
      tab.setAttribute('aria-selected', String(active))
      tab.tabIndex = active ? 0 : -1
    }
    for (const panel of panels) panel.hidden = panel.id !== state.view + '-panel'
    const live = state.view === 'live'
    if (nodes.liveBeta) nodes.liveBeta.hidden = !live
    if (nodes.liveBetaNote) nodes.liveBetaNote.hidden = !live
    scheduleLiveClock()
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
    if (!snapshot) return
    renderCounts(snapshot)
    renderScope(snapshot)
    if (state.view === 'map') {
      renderMap(snapshot)
      renderRoster(snapshot)
    } else if (state.view === 'live') {
      renderLive(snapshot)
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

  async function loadDirectory(force, scheduleRecheck = true) {
    if (state.directory.loading) return
    if (force) window.clearTimeout(state.directory.recheckTimer)
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
        cache: force ? 'reload' : 'default',
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
          recheckTimer: 0,
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
      if (force && scheduleRecheck) {
        const recheckTimer = window.setTimeout(() => void loadDirectory(true, false), 31_000)
        state = {
          ...state,
          directory: Object.freeze({ ...state.directory, recheckTimer }),
        }
      }
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
      const startingMarker = state.live.streamMarker || state.changeMarker
      let cursor = startingMarker
      let marker = startingMarker
      let heldMarker = null
      let changes = []
      let unchanged = true
      const seenCursors = new Set()
      while (true) {
        const url = new URL('/api/changes', window.location.origin)
        if (state.live.streamMarker && cursor === state.live.streamMarker) {
          url.searchParams.set('since', state.live.streamMarker)
        } else if (state.changeMarker && cursor === state.changeMarker) {
          url.searchParams.set('since', state.changeMarker)
        } else if (cursor) {
          url.searchParams.set('since', cursor)
        }
        url.searchParams.set('limit', String(LIVE_OPENING_PAGE_LIMIT))
        const response = await fetch(url.pathname + url.search, {
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          mode: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('public changes unavailable')
        const payload = await response.json()
        if (!payload || typeof payload !== 'object') throw new Error('invalid public changes')
        const nextMarker = safeChangeMarker(payload.change_marker ?? payload.checkpoint)
        if (!nextMarker || (cursor && !markerCovers(nextMarker, cursor)) ||
            (startingMarker && !markerCovers(nextMarker, startingMarker))) {
          throw new Error('public change marker did not cover its page')
        }
        heldMarker = heldMarker || nextMarker
        if (!markerCovers(nextMarker, heldMarker)) {
          throw new Error('public change marker moved behind the held page')
        }
        marker = heldMarker
        unchanged = unchanged && payload.unchanged === true
        if (!startingMarker) {
          return Object.freeze({ status: 'unchanged', marker, changes: Object.freeze([]) })
        }
        const incoming = normalizeLiveChanges(payload.changes)
        if (incoming.some(change =>
          (cursor && BigInt(change.change_id) <= BigInt(cursor)) ||
          BigInt(change.change_id) > BigInt(nextMarker))) {
          throw new Error('public change page crossed its cursor')
        }
        changes = mergeLiveChanges(changes, incoming.filter(change =>
          BigInt(change.change_id) <= BigInt(heldMarker)))
        if (payload.has_more !== true) break
        const nextSince = safeChangeMarker(payload.next_since)
        if (!nextSince || !cursor || BigInt(nextSince) <= BigInt(cursor) ||
            BigInt(nextSince) > BigInt(nextMarker) || seenCursors.has(nextSince)) {
          throw new Error('public change cursor did not progress')
        }
        if (BigInt(nextSince) >= BigInt(heldMarker)) break
        seenCursors.add(nextSince)
        cursor = nextSince
      }
      return Object.freeze({
        status: changes.length || marker !== startingMarker || !unchanged ? 'changed' : 'unchanged',
        marker,
        changes,
      })
    } catch {
      return Object.freeze({ status: 'unavailable', marker: null, changes: Object.freeze([]) })
    } finally {
      window.clearTimeout(timeout)
    }
  }

  function invalidateLiveCaches(drawings, noteBodies, changes) {
    const drawingKeys = new Set()
    let clearAll = false
    for (const change of changes) {
      if (change.kind === 'resident_edited' && change.detail.resident_id) {
        drawingKeys.add('resident:' + String(change.detail.resident_id))
      } else if (change.kind === 'place_edited' && change.detail.place_id) {
        drawingKeys.add('place:' + String(change.detail.place_id))
      } else if (
        (change.kind === 'thing_edited' || change.kind === 'thing_upgraded') &&
        change.detail.thing_id
      ) {
        drawingKeys.add('thing:' + String(change.detail.thing_id))
      } else if (change.kind === 'kind_revised' && change.detail.kind_id) {
        drawingKeys.add('kind:' + String(change.detail.kind_id))
      } else if (change.kind === 'moderation') {
        clearAll = true
      }
    }
    const filteredDrawings = clearAll
      ? {}
      : Object.fromEntries(Object.entries(drawings).filter(([key]) => !drawingKeys.has(key)))
    return Object.freeze({
      drawings: clearAll || drawingKeys.size ? filteredDrawings : drawings,
      noteBodies: clearAll ? {} : noteBodies,
    })
  }

  function commitLiveChangeRead(changeState) {
    if (changeState.status === 'unavailable') {
      state = { ...state, live: { ...state.live, streamError: true } }
      return BASE_REFRESH_MS
    }
    const incoming = changeState.changes || []
    const hadStreamError = state.live.streamError
    const openingMarker = state.live.openingMarker
    const streamIncoming = openingMarker
      ? incoming.filter(change => BigInt(change.change_id) > BigInt(openingMarker))
      : incoming
    const known = new Set(state.live.changes.map(change => change.change_id))
    const replayIncoming = state.live.openingLoaded
      ? streamIncoming.filter(change => !known.has(change.change_id))
      : []
    const cutoff = Date.now() - LIVE_MOVE_LIFETIME_MS
    const merged = Object.freeze(mergeLiveChanges(state.live.changes, streamIncoming)
      .filter(change => change.at.getTime() >= cutoff &&
        (!openingMarker || BigInt(change.change_id) > BigInt(openingMarker))))
    const latestAt = streamIncoming.length
      ? Math.max(...streamIncoming.map(change => change.at.getTime()), state.live.lastChangeAt || 0)
      : state.live.lastChangeAt
    const hadEvents = incoming.length > 0
    const invalidatedCaches = invalidateLiveCaches(
      state.live.drawings,
      state.live.noteBodies,
      incoming,
    )
    const quietReadsBefore = state.live.quietReads
    state = {
      ...state,
      live: {
        ...state.live,
        changes: merged,
        drawings: invalidatedCaches.drawings,
        noteBodies: invalidatedCaches.noteBodies,
        streamError: false,
        streamMarker: changeState.marker || state.live.streamMarker,
        quietReads: state.view === 'live'
          ? hadEvents ? 0 : quietReadsBefore + 1
          : 0,
        lastChangeAt: latestAt || null,
      },
    }
    if (replayIncoming.length) queueLiveReplays(replayIncoming)
    if ((incoming.length || hadStreamError) && state.view === 'live' && state.snapshot) {
      renderLive(state.snapshot)
    }
    return state.view === 'live'
      ? windowLivePollDelay(hadEvents, quietReadsBefore)
      : BASE_REFRESH_MS
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
    state = {
      ...state,
      pollTimer,
      live: { ...state.live, nextReadAt: document.hidden ? null : Date.now() + delay },
    }
    if (state.view === 'live') renderLiveClock()
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
      nextDelay = commitLiveChangeRead(changeState)
      if (state.hasSnapshot && changeState.status === 'unchanged' &&
          state.changeMarker === changeState.marker) {
        try {
          const residents = await refreshUnchangedPresence(
            controller.signal,
            changeState.marker,
          )
          if (navigationRevision !== navigationRevisionAtStart) {
            setStatus('Watching the public streets', 'live')
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
          setStatus('Watching the public streets', 'live')
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
      const invalidateSnapshotCaches = hadSnapshot && replaceAuthored &&
        changeState.status !== 'changed'
      if (replaceAuthored) authoredRevision += 1
      state = {
        ...state,
        snapshot,
        branches: navigation.branches,
        residentPaging: navigation.residentPaging,
        histories,
        archive,
        live: invalidateSnapshotCaches
          ? {
              ...state.live,
              drawings: {},
              noteBodies: {},
            }
          : state.live,
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
      setStatus('Watching the public streets', 'live')
    } catch {
      const failures = state.failures + 1
      state = {
        ...state,
        failures,
        live: {
          ...state.live,
          // A failed snapshot did not prove the new rows belong to a completed
          // view. Re-read them from the last completed marker; queued keys stay
          // held and cannot replay twice when the covering snapshot succeeds.
          streamMarker: state.changeMarker,
        },
      }
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
      let placeId = state.placeId
      if (view === 'place' && !state.resident && !state.placeId &&
        !selectedPlace(state.snapshot || { residents: [], flatPlaces: [] })) {
        placeId = state.snapshot?.flatPlaces[0]?.id || null
      }
      navigate({ view, placeId, detail: null })
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
    const previousView = state.view
    const previousReplayScope = [state.view, state.placeId, state.resident].join(':')
    const nextLocationState = readLocationState()
    const clearsLiveFocus = nextLocationState.view === 'live' &&
      Boolean(nextLocationState.resident)
    const nextReplayScope = [
      nextLocationState.view, nextLocationState.placeId, nextLocationState.resident,
    ].join(':')
    if (previousReplayScope !== nextReplayScope && liveReplayHeldKeys().size) {
      settleLiveReplays()
    }
    if (nextLocationState.archive !== state.archive) archiveRequestRevision += 1
    if (
      nextLocationState.detail?.kind !== state.detail?.kind ||
      nextLocationState.detail?.id !== state.detail?.id
    ) detailRequestRevision += 1
    resetShareFeedback()
    if (clearsLiveFocus && state.live.focusResident) storeLiveFocusResident(null)
    state = {
      ...state,
      ...nextLocationState,
      live: clearsLiveFocus ? { ...state.live, focusResident: null } : state.live,
    }
    syncArchiveControls()
    renderAll()
    void ensureFocusedSelection()
    void ensureDetail()
    loadSharedArchiveQuestion()
    if (state.view !== previousView) {
      scheduleRefresh(state.view === 'live' && !document.hidden ? 0 : BASE_REFRESH_MS)
    }
  }
  nodes.liveViewport?.addEventListener('wheel', event => {
    event.preventDefault()
    const factor = Math.exp(-event.deltaY * 0.0015)
    zoomLivePlateAt(event.clientX, event.clientY, liveCamera.scale * factor)
  }, { passive: false })
  nodes.liveViewport?.addEventListener('keydown', event => {
    if (event.target !== nodes.liveViewport) return
    const pan = 48
    if (event.key === '0') {
      event.preventDefault()
      fitLivePlate()
      return
    }
    if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault()
      const rect = nodes.liveViewport.getBoundingClientRect()
      const factor = event.key === '-' ? 1 / 1.2 : 1.2
      zoomLivePlateAt(rect.left + rect.width / 2, rect.top + rect.height / 2,
        liveCamera.scale * factor)
      return
    }
    const offset = {
      ArrowLeft: [pan, 0], ArrowRight: [-pan, 0],
      ArrowUp: [0, pan], ArrowDown: [0, -pan],
    }[event.key]
    if (!offset) return
    event.preventDefault()
    applyLiveCamera({
      offsetX: liveCamera.offsetX + offset[0],
      offsetY: liveCamera.offsetY + offset[1],
      fitted: false,
    })
  })
  nodes.liveViewport?.addEventListener('pointerdown', event => {
    if (event.target instanceof Element &&
        event.target.closest('button, a, input, select, textarea, [role="button"]')) return
    event.preventDefault()
    nodes.liveViewport.dataset.liveDragging = 'true'
    beginLivePointer(event)
  })
  nodes.liveViewport?.addEventListener('pointermove', event => {
    if (!Object.hasOwn(livePointers, String(event.pointerId))) return
    event.preventDefault()
    moveLivePointer(event)
  })
  for (const eventName of ['pointerup', 'pointercancel']) {
    nodes.liveViewport?.addEventListener(eventName, event => {
      endLivePointer(event)
      if (!livePointerValues().length && nodes.liveViewport) {
        nodes.liveViewport.dataset.liveDragging = 'false'
      }
    })
  }
  nodes.liveFit?.addEventListener('click', fitLivePlate)
  nodes.livePause?.addEventListener('click', () => {
    const paused = !state.live.paused
    state = { ...state, live: { ...state.live, paused } }
    nodes.livePause.setAttribute('aria-pressed', String(paused))
    nodes.livePause.textContent = paused ? 'Resume walks' : 'Pause walks'
    if (!paused) window.queueMicrotask(startLiveReplays)
  })
  window.addEventListener('hashchange', syncStateFromLocation)
  window.addEventListener('popstate', syncStateFromLocation)
  window.addEventListener('resize', () => {
    scheduleBodyDisclosureSync()
    if (state.view === 'live' && state.snapshot) {
      const refit = liveCamera.fitted
      renderLive(state.snapshot)
      if (refit) window.requestAnimationFrame(fitLivePlate)
    }
  })
  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(state.pollTimer)
    if (document.hidden) {
      if (liveReplayHeldKeys().size) settleLiveReplays()
      state = { ...state, pollTimer: 0, live: { ...state.live, nextReadAt: null } }
      renderLiveClock()
    } else {
      drainLiveDrawingQueue()
      drainLiveNoteQueue()
      if (state.view === 'live' && state.snapshot) {
        renderLive(state.snapshot)
        if (!state.live.openingLoaded && !state.live.openingLoading) {
          void loadLiveOpeningHistory(state.snapshot, Boolean(
            state.live.openingNextBeforeId || state.live.openingEvents.length))
        }
      }
      void refreshCity()
    }
  })
  LIVE_MOTION_PREFERENCE.addEventListener?.('change', () => {
    if (LIVE_MOTION_PREFERENCE.matches) settleLiveReplays()
    if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
  })

  const initialLocationState = readLocationState()
  let initialFocusResident = readLiveFocusResident()
  if (initialLocationState.view === 'live' && initialLocationState.resident) {
    if (initialFocusResident) storeLiveFocusResident(null)
    initialFocusResident = null
  }
  state = {
    ...state,
    ...initialLocationState,
    live: { ...state.live, focusResident: initialFocusResident },
  }
  syncArchiveControls()
  renderView()
  writeLocation(false)
  void ensureDetail()
  void loadDirectory(false)
  void refreshCity()
})()
`
