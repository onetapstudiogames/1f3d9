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
      gapAfterIds: [],
      beyondFillIds: [],
      hasMore: historyTotal(collection, filters) > rows.length,
      nextBeforeId: null,
      automaticPageCount: 0,
      automaticPaused: false,
      initialized: false,
      loading: false,
      error: false,
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

  // A named gap is one range of records this list has not loaded. It is named
  // by the id of the record directly below it, so the record directly above it
  // is the lowest loaded record with a higher id: one fact, read off the rows
  // themselves, never a cursor kept beside them.
  function gapUpperBound(rows, afterId) {
    let bound = null
    for (const row of rows) if (row.id > afterId) bound = row.id
    return bound
  }

  function namedHistoryGap(entry) {
    const afterId = (entry.gapAfterIds || [])[0]
    if (afterId === undefined) return null
    return Object.freeze({ afterId, beforeId: gapUpperBound(entry.rows || [], afterId) })
  }

  // The records a changed refresh keeps: everything already loaded and
  // everything the newest page carries, minus what the city took down, minus
  // the oldest past the keep bound, and never one the reader is holding open.
  function keptHistoryRows(rows, freshRows, kind, heldKeys, invalidatedKeys) {
    const freshIds = new Set(freshRows.map(row => row.id))
    const freshOldestId = freshRows.length ? freshRows[freshRows.length - 1].id : null
    const survivors = rows.filter(row => {
      if (invalidatedKeys.has(kind + ':' + String(row.id))) return false
      // The newest page is the city's own newest block for this list, so a
      // record inside it that the page no longer carries is gone from the city
      // rather than merely paged out of sight.
      return freshOldestId === null || row.id < freshOldestId || freshIds.has(row.id)
    })
    const merged = mergeWindowRows(survivors, freshRows)
    const kept = merged.filter((row, index) =>
      index < WINDOW_HISTORY_KEEP_ROWS || heldKeys.has(kind + ':' + String(row.id)))
    return Object.freeze({
      merged,
      kept,
      freshOldestId,
      topSurvivorId: survivors.length ? survivors[0].id : null,
    })
  }

  function keptGapAfterIds(previousAfterIds, held) {
    const keptIds = held.kept.map(row => row.id)
    const keptIdSet = new Set(keptIds)
    const mergedIndex = new Map(held.merged.map((row, index) => [row.id, index]))
    const named = new Set()
    // Every hole the keep bound leaves is named, not only the first.
    for (let index = 1; index < keptIds.length; index += 1) {
      if (mergedIndex.get(keptIds[index]) !== mergedIndex.get(keptIds[index - 1]) + 1) {
        named.add(keptIds[index])
      }
    }
    // A gap this list already named keeps its name. When the record that named
    // it is gone, the next record still below it takes that place.
    for (const afterId of previousAfterIds || []) {
      const marker = keptIdSet.has(afterId) ? afterId : keptIds.find(id => id < afterId)
      if (marker !== undefined) named.add(marker)
    }
    // Nothing proves the newest page joins the records this list already had
    // unless it carries one of them, or unless the two ends are neighbouring
    // ids: record ids are whole numbers, so no record of any list can sit
    // between them. Otherwise the top of that block stays named until a read
    // shows what is between them.
    if (held.topSurvivorId !== null && keptIdSet.has(held.topSurvivorId) &&
        (held.freshOldestId === null || held.topSurvivorId < held.freshOldestId - 1)) {
      named.add(held.topSurvivorId)
    }
    return [...named].sort((left, right) => right - left)
  }

  function freshHistoryEntry(entry, rows, page) {
    return Object.freeze({
      ...entry,
      rows,
      gapAfterIds: [],
      beyondFillIds: [],
      hasMore: page ? page.hasMore : entry.hasMore === true,
      nextBeforeId: page ? page.nextBeforeId : null,
      initialized: true,
      loading: false,
      error: false,
      refreshError: false,
    })
  }

  function retainedHistoryEntry(entry, freshRows, kind, heldKeys, invalidatedKeys, page) {
    const held = keptHistoryRows(entry.rows, freshRows, kind, heldKeys, invalidatedKeys)
    const rows = held.kept
    const gapAfterIds = keptGapAfterIds(entry.gapAfterIds, held)
    const oldestMerged = held.merged[held.merged.length - 1]
    const oldestKept = rows[rows.length - 1]
    const bottomTrimmed = Boolean(oldestMerged) && oldestMerged.id !== oldestKept?.id
    return Object.freeze({
      ...entry,
      rows,
      gapAfterIds,
      beyondFillIds: (entry.beyondFillIds || []).filter(id => gapAfterIds.includes(id)),
      hasMore: rows.length
        ? entry.hasMore === true || bottomTrimmed
        : Boolean(page && page.hasMore),
      nextBeforeId: rows.length
        ? rows[rows.length - 1].id
        : page ? page.nextBeforeId : null,
      initialized: true,
      loading: false,
      error: false,
      refreshError: false,
    })
  }

  function freshSnapshotHistories(snapshot, changes = null) {
    let histories = {}
    // Keeping older records is only honest while the window can still see what
    // the city changed. When that check could not be completed it keeps none.
    const keepLoadedRows = Array.isArray(changes)
    const heldKeys = keepLoadedRows ? viewerHeldRecordKeys() : new Set()
    const invalidatedKeys = changedViewerRecordKeys(changes || [])
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      const page = snapshot.pages[collection]
      const previousEntries = state.histories[collection] || {}
      const kind = historyViewerRecordKind(collection)
      let entries = {}
      if (keepLoadedRows) {
        entries = Object.fromEntries(Object.entries(previousEntries).flatMap(([key, entry]) => {
          if (!entry || !entry.rows) return []
          const freshRows = key === 'all' || !entry.filters
            ? snapshot[collection]
            : filterHistoryRows(collection, snapshot[collection], entry.filters, snapshot)
          return [[key, retainedHistoryEntry(
            entry, freshRows, kind, heldKeys, invalidatedKeys, key === 'all' ? page : null)]]
        }))
      }
      if (!entries.all) {
        entries = {
          ...entries,
          all: freshHistoryEntry(previousEntries.all || {}, snapshot[collection], page),
        }
      }
      histories = { ...histories, [collection]: entries }
    }
    return histories
  }

  function filledHistoryEntry(entry, rows, afterId, options) {
    const closed = options.closed === true
    const gapAfterIds = closed
      ? (entry.gapAfterIds || []).filter(id => id !== afterId)
      : entry.gapAfterIds || []
    const beyondFillIds = closed
      ? (entry.beyondFillIds || []).filter(id => id !== afterId)
      : options.beyondFill === true
        ? [...new Set([...(entry.beyondFillIds || []), afterId])]
        : entry.beyondFillIds || []
    return Object.freeze({
      ...entry,
      rows,
      gapAfterIds,
      beyondFillIds,
      nextBeforeId: rows.length ? rows[rows.length - 1].id : entry.nextBeforeId ?? null,
      initialized: true,
      loading: false,
      error: false,
      refreshError: options.readFailed === true,
    })
  }

  // Read exactly the named gap, page by page, up to the fill bound. The read
  // answers one range, so its own has_more says whether the gap is closed; no
  // particular record has to come back for it to close, which is why a record
  // the city took down inside the gap cannot leave the list stuck.
  async function fillHistoryGap(collection, entry, filters, marker, signal) {
    const gap = namedHistoryGap(entry)
    if (!gap) return entry
    let rows = entry.rows
    let readMarker = marker
    let spent = 0
    let markerRetries = 0
    try {
      while (spent < WINDOW_HISTORY_FILL_ROWS) {
        const url = historyRequestUrl(
          collection,
          { initialized: true, nextBeforeId: gapUpperBound(rows, gap.afterId) },
          filters,
          readMarker,
          Object.freeze({ afterId: gap.afterId }),
        )
        const response = await fetch(url.pathname + url.search, {
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          mode: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal,
        })
        if (!response.ok) throw new Error('public gap read unavailable')
        const payload = await response.json()
        const pageMarker = safeChangeMarker(payload && payload.change_marker)
        if (readMarker && !markerCovers(pageMarker, readMarker)) {
          throw new Error('public gap read marker does not cover its rows')
        }
        if (readMarker && pageMarker !== readMarker) {
          // The city changed while the gap was being read. Read it again under
          // the newer marker instead of joining two different cities.
          markerRetries += 1
          if (markerRetries > 3) throw new Error('public gap read never settled')
          readMarker = pageMarker
          continue
        }
        const incoming = normalizeHistoryRows(collection, payload)
        rows = mergeWindowRows(rows, incoming)
        spent += incoming.length
        if (payload.has_more !== true) {
          return filledHistoryEntry(entry, rows, gap.afterId, { closed: true })
        }
        if (!incoming.length) throw new Error('public gap read did not progress')
        markerRetries = 0
      }
    } catch {
      return filledHistoryEntry(entry, rows, gap.afterId, { readFailed: true })
    }
    return filledHistoryEntry(entry, rows, gap.afterId, { beyondFill: true })
  }

  async function rejoinSnapshotHistories(histories, marker, signal) {
    const reads = []
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      for (const [key, entry] of Object.entries(histories[collection] || {})) {
        const gap = namedHistoryGap(entry)
        if (!gap || (entry.beyondFillIds || []).includes(gap.afterId)) continue
        const filters = entry.filters || Object.freeze({
          placeId: null, resident: null, context: false,
        })
        reads.push((async () => Object.freeze({
          collection,
          key,
          entry: await fillHistoryGap(collection, entry, filters, marker, signal),
        }))())
      }
    }
    const completed = await Promise.allSettled(reads)
    let rejoined = histories
    for (const completedRead of completed) {
      if (completedRead.status !== 'fulfilled') continue
      const result = completedRead.value
      rejoined = {
        ...rejoined,
        [result.collection]: {
          ...rejoined[result.collection],
          [result.key]: result.entry,
        },
      }
    }
    return rejoined
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
            gapAfterIds: [],
            beyondFillIds: [],
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
