export const PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES = `  function replaceBranch(placeId, entry) {
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

  function historyViewerRecordKind(collection) {
    return collection === 'notes' ? 'note'
      : collection === 'things' ? 'thing'
        : collection === 'agreements' ? 'agreement' : 'event'
  }

  function freshSnapshotHistories(snapshot, changes = null) {
    let histories = {}
    const retainViewerRows = Array.isArray(changes)
    const heldKeys = retainViewerRows ? viewerHeldRecordKeys() : new Set()
    const invalidatedKeys = changedViewerRecordKeys(changes || [])
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      const page = snapshot.pages[collection]
      const previousEntries = state.histories[collection] || {}
      const entries = Object.fromEntries(Object.entries(previousEntries).flatMap(([key, entry]) => {
        if (!entry?.rows) return []
        const freshRows = key === 'all' || !entry.filters
          ? snapshot[collection]
          : filterHistoryRows(collection, snapshot[collection], entry.filters, snapshot)
        const freshIds = new Set(freshRows.map(row => row.id))
        const kind = historyViewerRecordKind(collection)
        const retainedRows = entry.rows.filter(row => {
          const recordKey = kind + ':' + String(row.id)
          return !freshIds.has(row.id) && heldKeys.has(recordKey) &&
            !invalidatedKeys.has(recordKey)
        })
        if (!retainedRows.length || key === 'all') return []
        return [[key, Object.freeze({
          ...entry,
          rows: mergeWindowRows(retainedRows, freshRows),
          loading: false,
          error: false,
          refreshing: false,
          refreshError: false,
        })]]
      }))
      const previousAll = previousEntries.all
      const freshIds = new Set(snapshot[collection].map(row => row.id))
      const kind = historyViewerRecordKind(collection)
      const retainedAllRows = (previousAll?.rows || []).filter(row => {
        const recordKey = kind + ':' + String(row.id)
        return !freshIds.has(row.id) && heldKeys.has(recordKey) &&
          !invalidatedKeys.has(recordKey)
      })
      histories = {
        ...histories,
        [collection]: {
          ...entries,
          all: Object.freeze({
            rows: retainedAllRows.length
              ? mergeWindowRows(retainedAllRows, snapshot[collection])
              : snapshot[collection],
            hasMore: retainedAllRows.length && previousAll
              ? previousAll.hasMore : page.hasMore,
            nextBeforeId: retainedAllRows.length && previousAll
              ? previousAll.nextBeforeId : page.nextBeforeId,
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

  async function rereadHeldHistoryEntry(
    collection, entry, filters, heldIds, marker, signal,
  ) {
    let rows = []
    let beforeId = null
    const seenCursors = new Set()
    for (let pageCount = 0; pageCount < MAX_FORWARD_RECONCILE_PAGES; pageCount += 1) {
      const url = historyRequestUrl(collection, {
        initialized: Boolean(beforeId), nextBeforeId: beforeId,
      }, filters, marker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      })
      if (!response.ok) throw new Error('held public history unavailable')
      const payload = await response.json()
      requireExactReadMarker(payload?.change_marker, marker)
      const incoming = normalizeHistoryRows(collection, payload)
      rows = mergeWindowRows(rows, incoming)
      const hasMore = payload.has_more === true
      const nextBeforeId = hasMore ? safeId(payload.next_before_id) : null
      if (hasMore && (!nextBeforeId || seenCursors.has(nextBeforeId) ||
          (beforeId && nextBeforeId >= beforeId) ||
          !incoming.some(row => row.id === nextBeforeId))) {
        throw new Error('held public history cursor did not progress')
      }
      const foundHeldRows = [...heldIds].every(id => rows.some(row => row.id === id))
      if (foundHeldRows || !hasMore) {
        return Object.freeze({
          ...entry,
          rows,
          hasMore,
          nextBeforeId,
          initialized: true,
          loading: false,
          error: false,
          refreshing: false,
          refreshError: false,
        })
      }
      seenCursors.add(nextBeforeId)
      beforeId = nextBeforeId
    }
    throw new Error('held public history reconciliation limit reached')
  }

  async function rereadHeldSnapshotHistories(histories, snapshot, marker, signal) {
    const heldKeys = viewerHeldRecordKeys()
    const reads = []
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      const kind = historyViewerRecordKind(collection)
      for (const [key, entry] of Object.entries(histories[collection] || {})) {
        const filters = entry.filters || Object.freeze({
          placeId: null, resident: null, context: false,
        })
        const freshRows = key === 'all'
          ? snapshot[collection]
          : filterHistoryRows(collection, snapshot[collection], filters, snapshot)
        const freshIds = new Set(freshRows.map(row => row.id))
        const heldIds = new Set(entry.rows.filter(row =>
          !freshIds.has(row.id) && heldKeys.has(kind + ':' + String(row.id)))
          .map(row => row.id))
        if (!heldIds.size) continue
        reads.push((async () => Object.freeze({
          collection,
          key,
          entry: await rereadHeldHistoryEntry(
            collection, entry, filters, heldIds, marker, signal),
        }))())
      }
    }
    const completed = await Promise.allSettled(reads)
    let reconciled = histories
    for (const completedRead of completed) {
      if (completedRead.status !== 'fulfilled') continue
      const result = completedRead.value
      reconciled = {
        ...reconciled,
        [result.collection]: {
          ...reconciled[result.collection],
          [result.key]: result.entry,
        },
      }
    }
    return reconciled
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

`
