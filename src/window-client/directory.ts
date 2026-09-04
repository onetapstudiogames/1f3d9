export type WindowDirectoryPlace = Readonly<{
  id: number
  parent_id: number | null
  name: string
  // Optional so every existing directory-shaped fixture in tests keeps
  // compiling; normalizeDirectory always sets a definite boolean from the
  // live API, so this is only ever missing on synthetic/test place rows.
  quiet?: boolean
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
  has_drawing?: boolean
}>

export type WindowDirectorySearchResult = Readonly<{
  kind: 'place' | 'resident'
  id: number
  value: string
  label: string
  detail: string
  hasDrawing?: boolean
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
          hasDrawing: resident.has_drawing === true,
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
