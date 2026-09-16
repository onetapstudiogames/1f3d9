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

  // The reader keeps what they scrolled to. Past the keep bound the oldest rows
  // go first, and a row the reader is holding open is never one of them.
  function keptHistoryRows(rows, heldKeys, kind) {
    if (rows.length <= WINDOW_HISTORY_KEEP_ROWS) return rows
    const kept = rows.slice(0, WINDOW_HISTORY_KEEP_ROWS)
    const heldBelow = rows.slice(WINDOW_HISTORY_KEEP_ROWS)
      .filter(row => heldKeys.has(kind + ':' + String(row.id)))
    return heldBelow.length ? kept.concat(heldBelow) : kept
  }

  // Load older always continues from the lowest connected row: the lowest
  // loaded row above the highest gap still waiting to be filled.
  function connectedHistoryCursor(rows, waitingRows, fallbackId) {
    const highestWaitingId = waitingRows.reduce(
      (highest, row) => Math.max(highest, row.id), 0)
    const connected = rows.filter(row => row.id > highestWaitingId)
    return connected.length ? connected[connected.length - 1].id : fallbackId ?? null
  }

  // One list across a changed refresh: every row the reader already loaded
  // stays, the newest page merges in, and the top row of any block the newest
  // page does not reach is recorded so the fill below can close that gap.
  function retainedHistoryEntry(
    collection, entry, freshRows, newestRows, heldKeys, invalidatedKeys,
  ) {
    const kind = historyViewerRecordKind(collection)
    const freshIds = new Set(freshRows.map(row => row.id))
    // The snapshot rows are the city's own newest page for the whole city, so a
    // loaded row above its oldest row and missing from it has left the city or
    // this list, rather than been paged out of sight.
    const removalFloorId = newestRows.length ? newestRows[newestRows.length - 1].id : 0
    const retainedRows = entry.rows.filter(row => !freshIds.has(row.id) &&
      row.id < removalFloorId &&
      !invalidatedKeys.has(kind + ':' + String(row.id)))
    if (!retainedRows.length) return null
    const merged = mergeWindowRows(retainedRows, freshRows)
    const rows = keptHistoryRows(merged, heldKeys, kind)
    const trimmed = rows.length < merged.length
    const keptIds = new Set(rows.map(row => row.id))
    // A newest page that still reaches the reader's own top row proves there is
    // nothing unloaded between them.
    const gapAboveKeptRows = removalFloorId > entry.rows[0].id
    // Trimming at the keep bound leaves a hole above any row the reader is
    // holding open below it. That row is named too, so the two sides of the hole
    // never join in silence.
    const heldBelowBound = rows.length > WINDOW_HISTORY_KEEP_ROWS
      ? [rows[WINDOW_HISTORY_KEEP_ROWS]]
      : []
    const waitingRows = mergeWindowRows(
      (entry.deferredRows || []).filter(row => keptIds.has(row.id)),
      (gapAboveKeptRows ? [retainedRows[0]] : []).concat(heldBelowBound))
    return Object.freeze({
      ...entry,
      rows,
      deferredRows: waitingRows,
      hasMore: waitingRows.length || trimmed ? true : entry.hasMore === true,
      nextBeforeId: entry.initialized === true
        ? connectedHistoryCursor(rows, waitingRows, entry.nextBeforeId)
        : entry.nextBeforeId ?? null,
      loading: false,
      error: false,
      refreshing: false,
      refreshError: false,
    })
  }

  // Keeping older rows is only honest while the window can still see what the
  // city changed. When the changes read could not be completed, a record the
  // city moderated or removed below the newest page cannot be named, and the
  // next read starts after it, so that refresh keeps nothing and shows the
  // city's own newest page. A null changes list says exactly that.
  function freshSnapshotHistories(snapshot, changes = null) {
    let histories = {}
    const changesKnown = Array.isArray(changes)
    const heldKeys = viewerHeldRecordKeys()
    const invalidatedKeys = changedViewerRecordKeys(changes || [])
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      const page = snapshot.pages[collection]
      const previousEntries = changesKnown ? state.histories[collection] || {} : {}
      const entries = Object.fromEntries(Object.entries(previousEntries).flatMap(([key, entry]) => {
        if (!entry?.rows?.length || key === 'all') return []
        const freshRows = entry.filters
          ? filterHistoryRows(collection, snapshot[collection], entry.filters, snapshot)
          : snapshot[collection]
        const retained = retainedHistoryEntry(
          collection, entry, freshRows, snapshot[collection], heldKeys, invalidatedKeys)
        return retained ? [[key, retained]] : []
      }))
      const previousAll = previousEntries.all
      const retainedAll = previousAll?.rows?.length
        ? retainedHistoryEntry(collection, previousAll, snapshot[collection],
            snapshot[collection], heldKeys, invalidatedKeys)
        : null
      histories = {
        ...histories,
        [collection]: {
          ...entries,
          all: retainedAll || Object.freeze({
            rows: snapshot[collection],
            deferredRows: [],
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

  // The window closes a gap on its own before it asks the reader to. It pages
  // from the newest until it reaches the rows already loaded, and stops at the
  // fill bound so a browser waking after a long sleep never pulls the whole
  // sleep from the city in one burst.
  async function fillHistoryGap(
    collection, entry, filters, joinIds, marker, signal,
  ) {
    let collected = []
    let beforeId = null
    const seenCursors = new Set()
    try {
      while (collected.length < WINDOW_HISTORY_FILL_ROWS) {
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
        if (!response.ok) throw new Error('older public history unavailable')
        const payload = await response.json()
        requireExactReadMarker(payload?.change_marker, marker)
        const incoming = normalizeHistoryRows(collection, payload)
        collected = mergeWindowRows(collected, incoming)
        const hasMore = payload.has_more === true
        const nextBeforeId = hasMore ? safeId(payload.next_before_id) : null
        if (hasMore && (!nextBeforeId || seenCursors.has(nextBeforeId) ||
            (beforeId && nextBeforeId >= beforeId) ||
            !incoming.some(row => row.id === nextBeforeId))) {
          throw new Error('older public history cursor did not progress')
        }
        const joined = [...joinIds].every(id => collected.some(row => row.id === id))
        if (joined || !hasMore) {
          const rows = mergeWindowRows(entry.rows, collected)
          return Object.freeze({
            ...entry,
            rows,
            deferredRows: [],
            hasMore: entry.hasMore === true,
            nextBeforeId: connectedHistoryCursor(rows, [], entry.nextBeforeId),
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
    } catch {
      return seamHistoryEntry(entry, joinIds, collected, true)
    }
    return seamHistoryEntry(entry, joinIds, collected, false)
  }

  // A page closes only the part of a seam it actually covered. A reader holding
  // two rows open at different depths has a gap above each one, so the rows the
  // page reached join the list while the rows still below it keep waiting.
  function seamRowsAfterPage(deferredRows, incoming, hasMore) {
    if (!deferredRows.length || !hasMore) return []
    const lowestReadId = incoming.reduce(
      (lowest, row) => Math.min(lowest, row.id), Infinity)
    return deferredRows.filter(row => row.id < lowestReadId)
  }

  // A gap the automatic fill could not close stays named. The loaded rows stay,
  // the top row of each block still waiting is recorded so the list's own
  // control can close it, and the older-history cursor resumes at the lowest row
  // still connected to the newest page rather than under the gap.
  function seamHistoryEntry(entry, joinIds, collected, readFailed) {
    const rows = mergeWindowRows(entry.rows, collected)
    const joinedIds = new Set(collected.filter(row => joinIds.has(row.id)).map(row => row.id))
    const waitingIds = new Set([...joinIds].filter(id => !joinedIds.has(id)))
    const waitingRows = rows.filter(row => waitingIds.has(row.id))
    return Object.freeze({
      ...entry,
      rows,
      deferredRows: waitingRows,
      // Only an unjoined block promises that something older is still out there.
      // A read that failed after joining every waiting block must not offer a
      // page that would add nothing.
      hasMore: waitingRows.length > 0 ? true : entry.hasMore === true,
      nextBeforeId: connectedHistoryCursor(rows, waitingRows, entry.nextBeforeId),
      initialized: true,
      loading: false,
      error: false,
      refreshing: false,
      refreshError: readFailed,
    })
  }

  // Every list the window pages rejoins itself after a changed refresh, whether
  // or not the reader is holding one of its records open.
  async function rejoinSnapshotHistories(histories, snapshot, marker, signal) {
    const reads = []
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      for (const [key, entry] of Object.entries(histories[collection] || {})) {
        const joinIds = new Set((entry.deferredRows || []).map(row => row.id))
        if (!joinIds.size) continue
        const filters = entry.filters || Object.freeze({
          placeId: null, resident: null, context: false,
        })
        reads.push((async () => Object.freeze({
          collection,
          key,
          entry: await fillHistoryGap(
            collection, entry, filters, joinIds, marker, signal),
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
