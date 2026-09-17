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

  // What the city says a list holds, or null when the window cannot say. A
  // citywide count is one of the city's own totals. A place count is the sum
  // over the bounded outline, and it is a count at all only while that outline
  // carries every place in the scope: a place the reader chose from the
  // complete directory is deliberately outside the outline, so the honest
  // answer for it is that the window does not know, never zero.
  function historyTotal(collection, filters, fromSnapshot) {
    const snapshot = fromSnapshot || state.snapshot
    if (!snapshot) return null
    const citywide = collection === 'notes' ? snapshot.totals.conversations
      : collection === 'things' ? snapshot.totals.things
        : collection === 'agreements' ? snapshot.totals.agreements
          : snapshot.totals.events
    if (!filters.placeId || collection === 'agreements' || collection === 'events') {
      return citywide
    }
    const loaded = new Map(snapshot.flatPlaces.map(place => [place.id, place]))
    let total = 0
    for (const id of placeScopeSet(filters.placeId, snapshot)) {
      const place = loaded.get(id)
      if (!place) return null
      total += collection === 'notes' ? place.notes : place.things
    }
    return total
  }

  // A list drawn from the citywide list inherits the citywide holes. Each gap
  // the citywide list named takes the highest drawn record at or below the
  // record that named it, so the drawn list says what it has not loaded
  // instead of quietly joining across the same hole. A gap with no drawn
  // record below it is no hole in this list: its own oldest record is above
  // the range, and reading older simply continues past it.
  function inheritedHistoryGaps(citywide, rows) {
    const named = []
    const beyond = []
    for (const afterId of citywide?.gapAfterIds || []) {
      const marker = rows.find(row => row.id <= afterId)?.id
      if (marker === undefined) continue
      if (!named.includes(marker)) named.push(marker)
      if ((citywide.beyondFillIds || []).includes(afterId) && !beyond.includes(marker)) {
        beyond.push(marker)
      }
    }
    const descending = (left, right) => right - left
    return Object.freeze({
      gapAfterIds: [...named].sort(descending),
      beyondFillIds: [...beyond].sort(descending),
    })
  }

  function historyEntry(collection, filters) {
    const key = historyKey(collection, filters)
    const stored = state.histories[collection]?.[key]
    if (stored) return stored
    const global = state.histories[collection]?.all
    const snapshotRows = state.snapshot?.[collection] || []
    const rows = filterHistoryRows(collection, global?.rows || snapshotRows, filters, state.snapshot)
    const inherited = inheritedHistoryGaps(global, rows)
    // A count the window cannot prove for this list never says the list is
    // finished: it offers the older records and lets the read answer.
    const total = historyTotal(collection, filters)
    return Object.freeze({
      rows,
      gapAfterIds: inherited.gapAfterIds,
      beyondFillIds: inherited.beyondFillIds,
      hasMore: total === null || total > rows.length,
      nextBeforeId: null,
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

  // The cursor a list pages by is the lowest record of that list's own
  // ordering. A followed resident's conversation pages over that resident's own
  // notes, and same-room notes by other residents ride along below them, so one
  // of those is never the cursor: asking below it would skip the resident's own
  // older notes and never offer them again.
  function historyPagingCursor(rows, filters, fallback) {
    const ordered = filters && filters.context === true && filters.resident
      ? (rows || []).filter(row => row.author === filters.resident)
      : rows || []
    if (ordered.length) return ordered[ordered.length - 1].id
    return fallback === undefined ? null : fallback
  }

  function namedHistoryGap(entry) {
    const afterId = (entry.gapAfterIds || [])[0]
    if (afterId === undefined) return null
    return Object.freeze({ afterId, beforeId: gapUpperBound(entry.rows || [], afterId) })
  }

  // The records a changed refresh keeps: everything already loaded and
  // everything the newest page carries, minus what the city no longer has,
  // minus the oldest past the keep bound, and never one the reader is holding
  // open. A record the city merely changed is neither shown with its old text
  // nor thrown away: it leaves the rows and is named as a range to read again.
  function keptHistoryRows(rows, freshRows, kind, keys) {
    const freshIds = new Set(freshRows.map(row => row.id))
    const freshOldestId = freshRows.length ? freshRows[freshRows.length - 1].id : null
    const staleIds = []
    const survivors = rows.filter(row => {
      const key = kind + ':' + String(row.id)
      if (keys.gone.has(key)) return false
      // The newest page is the city's own newest block for this list, so a
      // record inside it that the page no longer carries is gone from the city
      // rather than merely paged out of sight, and one the page still carries
      // arrives with the city's own current text.
      if (freshOldestId !== null && row.id >= freshOldestId) return freshIds.has(row.id)
      if (keys.stale.has(key)) {
        staleIds.push(row.id)
        return false
      }
      return true
    })
    const merged = mergeWindowRows(survivors, freshRows)
    const kept = merged.filter((row, index) =>
      index < WINDOW_HISTORY_KEEP_ROWS || keys.held.has(kind + ':' + String(row.id)))
    return Object.freeze({
      merged,
      kept,
      staleIds,
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
    // A record the city changed left the rows carrying text this list knows is
    // old, so the record still below it names the range it sat in and the
    // bounded range read brings it back with the city's current text.
    for (const staleId of held.staleIds || []) {
      const marker = keptIds.find(id => id < staleId)
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

  function retainedHistoryEntry(entry, freshRows, kind, filters, keys, page, total) {
    // The city's own count says this list has no records at all, so there is
    // nothing to keep and no range worth naming. A count the window could not
    // prove for this list is not that answer, and keeps what the reader loaded.
    if (total === 0) return freshHistoryEntry(entry, freshRows, page)
    const held = keptHistoryRows(entry.rows, freshRows, kind, keys)
    const rows = held.kept
    const gapAfterIds = keptGapAfterIds(entry.gapAfterIds, held)
    const oldestMerged = held.merged[held.merged.length - 1]
    const oldestKept = rows[rows.length - 1]
    const bottomTrimmed = Boolean(oldestMerged) && oldestMerged.id !== oldestKept?.id
    // A changed record below every record still kept comes back by simply
    // reading older, so the list must still offer that.
    const staleBelowAll = held.staleIds.some(id => !rows.some(row => row.id < id))
    return Object.freeze({
      ...entry,
      rows,
      gapAfterIds,
      beyondFillIds: (entry.beyondFillIds || []).filter(id => gapAfterIds.includes(id)),
      hasMore: rows.length
        ? entry.hasMore === true || bottomTrimmed || staleBelowAll
        : Boolean(page && page.hasMore),
      nextBeforeId: rows.length
        ? historyPagingCursor(rows, filters, entry.nextBeforeId ?? null)
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
    // What the city no longer has leaves a list for good; what it merely
    // changed leaves the rows and is named as a range to read again.
    const keys = Object.freeze({
      held: keepLoadedRows ? viewerHeldRecordKeys() : new Set(),
      gone: removedViewerRecordKeys(changes || []),
      stale: changedViewerRecordKeys(changes || []),
    })
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      const page = snapshot.pages[collection]
      const previousEntries = state.histories[collection] || {}
      const kind = historyViewerRecordKind(collection)
      // What the city says this collection holds: the whole-city count bounds
      // every list of it, and a list's own scope can only be smaller.
      const cityTotal = historyTotal(collection, Object.freeze({
        placeId: null, resident: null, context: false,
      }), snapshot)
      let entries = {}
      if (keepLoadedRows) {
        entries = Object.fromEntries(Object.entries(previousEntries).flatMap(([key, entry]) => {
          if (!entry || !entry.rows) return []
          const freshRows = key === 'all' || !entry.filters
            ? snapshot[collection]
            : filterHistoryRows(collection, snapshot[collection], entry.filters, snapshot)
          const filters = entry.filters || Object.freeze({
            placeId: null, resident: null, context: false,
          })
          const scopeTotal = historyTotal(collection, filters, snapshot)
          return [[key, retainedHistoryEntry(
            entry, freshRows, kind, filters, keys, key === 'all' ? page : null,
            scopeTotal === null ? cityTotal : Math.min(cityTotal, scopeTotal))]]
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

  function filledHistoryEntry(entry, rows, afterId, filters, options) {
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
      nextBeforeId: historyPagingCursor(rows, filters, entry.nextBeforeId ?? null),
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
          // The city changed while the gap was being read. Take this page again
          // under the newer marker; pages already merged stay, and the window's
          // own marker moves to the snapshot's, so the next change check still
          // covers them.
          markerRetries += 1
          if (markerRetries > 3) throw new Error('public gap read never settled')
          readMarker = pageMarker
          continue
        }
        const incoming = normalizeHistoryRows(collection, payload)
        rows = mergeWindowRows(rows, incoming)
        spent += incoming.length
        if (payload.has_more !== true) {
          return filledHistoryEntry(entry, rows, gap.afterId, filters, { closed: true })
        }
        if (!incoming.length) throw new Error('public gap read did not progress')
        markerRetries = 0
      }
    } catch {
      // A fill the refresh budget cut short read nothing and failed at nothing,
      // so the range keeps its name without telling the reader a read failed.
      if (signal && signal.aborted) {
        return filledHistoryEntry(entry, rows, gap.afterId, filters, {})
      }
      return filledHistoryEntry(entry, rows, gap.afterId, filters, { readFailed: true })
    }
    return filledHistoryEntry(entry, rows, gap.afterId, filters, { beyondFill: true })
  }

  // One gap read at a time. A reader who has used many filters keeps one list
  // per filter, and a refresh can name a gap in several of them at once;
  // reading them together would aim a burst of reads at the city for one
  // refresh. Anything the shared read budget does not reach keeps its name and
  // its own control, which is a waiting state the reader can finish by hand.
  async function rejoinSnapshotHistories(histories, marker, signal) {
    let rejoined = histories
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      for (const [key, entry] of Object.entries(rejoined[collection] || {})) {
        const gap = namedHistoryGap(entry)
        if (!gap || (entry.beyondFillIds || []).includes(gap.afterId)) continue
        if (signal && signal.aborted) return rejoined
        const filters = entry.filters || Object.freeze({
          placeId: null, resident: null, context: false,
        })
        const filled = await fillHistoryGap(collection, entry, filters, marker, signal)
        rejoined = {
          ...rejoined,
          [collection]: { ...rejoined[collection], [key]: filled },
        }
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
