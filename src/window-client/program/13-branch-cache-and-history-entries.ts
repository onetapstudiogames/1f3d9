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
    historyRevision += 1
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

  function historyOrderedRows(rows, filters) {
    return filters && filters.context === true && filters.resident
      ? (rows || []).filter(row => row.author === filters.resident)
      : rows || []
  }

  // A context conversation pages over the followed resident's own notes.
  // Neighbor notes ride along for context, but never set a range boundary or
  // prove two pages overlap.
  function gapUpperBound(rows, afterId, filters) {
    let bound = null
    for (const row of historyOrderedRows(rows, filters)) {
      if (afterId === null || row.id > afterId) bound = row.id
    }
    return bound
  }

  // The cursor a list pages by is the lowest record of that list's own
  // ordering. A followed resident's conversation pages over that resident's own
  // notes, and same-room notes by other residents ride along below them, so one
  // of those is never the cursor: asking below it would skip the resident's own
  // older notes and never offer them again.
  function historyPagingCursor(rows, filters, fallback) {
    const ordered = historyOrderedRows(rows, filters)
    if (ordered.length) return ordered[ordered.length - 1].id
    return fallback === undefined ? null : fallback
  }

  function namedHistoryGap(entry) {
    const explicit = (entry.gapRanges || [])[0]
    if (explicit) return explicit
    const afterId = (entry.gapAfterIds || [])[0]
    if (afterId === undefined) return null
    return Object.freeze({
      afterId,
      beforeId: gapUpperBound(entry.rows || [], afterId, entry.filters),
    })
  }

  // The records a changed refresh keeps: everything already loaded and
  // everything the newest page carries, minus what the city no longer has,
  // minus the oldest past the keep bound, and never one the reader is holding
  // open. A record the city merely changed is neither shown with its old text
  // nor thrown away: it leaves the rows and is named as a range to read again.
  function keptHistoryRows(rows, freshRows, kind, filters, keys) {
    const freshIds = new Set(freshRows.map(row => row.id))
    const freshOrdered = historyOrderedRows(freshRows, filters)
    const freshOldestId = freshOrdered.length ? freshOrdered[freshOrdered.length - 1].id : null
    const staleIds = []
    const survivors = rows.filter(row => {
      const key = kind + ':' + String(row.id)
      if (keys.gone.has(key)) return false
      // The newest page is the city's own newest block for this list, so a
      // record inside it that the page no longer carries is gone from the city
      // rather than merely paged out of sight, and one the page still carries
      // arrives with the city's own current text.
      const primary = historyOrderedRows([row], filters).length > 0
      if (primary && freshOldestId !== null && row.id >= freshOldestId) {
        return freshIds.has(row.id)
      }
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
      topSurvivorId: historyOrderedRows(survivors, filters)[0]?.id ?? null,
    })
  }

  function keptGapAfterIds(previousAfterIds, held, filters) {
    const keptIds = historyOrderedRows(held.kept, filters).map(row => row.id)
    const keptIdSet = new Set(keptIds)
    const mergedIndex = new Map(
      historyOrderedRows(held.merged, filters).map((row, index) => [row.id, index]),
    )
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

  function gapRangeKey(gap) {
    return String(gap.beforeId ?? '') + ':' + String(gap.afterId ?? '')
  }

  // A stale row may be the last row this list had. Keep the numeric range even
  // when no surviving row can name it; both server boundaries are exclusive,
  // so one less than the stale id includes that row in the retry.
  function staleHistoryGapRanges(previousRanges, held, filters) {
    const ranges = [...(previousRanges || [])]
    const ordered = historyOrderedRows(held.kept, filters)
    const uncovered = []
    for (const staleId of held.staleIds || []) {
      if (ordered.some(row => row.id < staleId)) continue
      uncovered.push(staleId)
    }
    if (uncovered.length) {
      const highest = Math.max(...uncovered)
      const lowest = Math.min(...uncovered)
      const above = ordered.filter(row => row.id > highest)
      const gap = Object.freeze({
        beforeId: above.length ? above[above.length - 1].id : null,
        afterId: lowest > 1 ? lowest - 1 : null,
      })
      if (!ranges.some(candidate => gapRangeKey(candidate) === gapRangeKey(gap))) {
        ranges.push(gap)
      }
    }
    return ranges
  }

  function freshHistoryEntry(entry, rows, page) {
    return Object.freeze({
      ...entry,
      rows,
      gapAfterIds: [],
      gapRanges: [],
      beyondFillIds: [],
      beyondFillRanges: [],
      hasMore: page ? page.hasMore : entry.hasMore === true,
      nextBeforeId: page ? page.nextBeforeId : null,
      initialized: true,
      loading: false,
      error: false,
      refreshError: false,
      newestReadFailed: false,
    })
  }

  function retainedHistoryEntry(entry, freshRows, kind, filters, keys, page) {
    // Only this list's own completed newest read can prove it is empty.
    if (page && page.hasMore === false && freshRows.length === 0) {
      return freshHistoryEntry(entry, freshRows, page)
    }
    const held = keptHistoryRows(entry.rows, freshRows, kind, filters, keys)
    const rows = held.kept
    const gapAfterIds = keptGapAfterIds(entry.gapAfterIds, held, filters)
    const gapRanges = staleHistoryGapRanges(entry.gapRanges, held, filters)
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
      gapRanges,
      beyondFillIds: (entry.beyondFillIds || []).filter(id => gapAfterIds.includes(id)),
      beyondFillRanges: (entry.beyondFillRanges || []).filter(key =>
        gapRanges.some(gap => gapRangeKey(gap) === key)),
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
      newestReadFailed: false,
    })
  }

  function failedOwnNewestEntry(entry, kind, filters, keys) {
    const staleIds = []
    const rows = entry.rows.filter(row => {
      const key = kind + ':' + String(row.id)
      if (keys.gone.has(key)) return false
      if (keys.stale.has(key)) {
        staleIds.push(row.id)
        return false
      }
      return true
    })
    const held = Object.freeze({ kept: rows, staleIds })
    const orderedIds = historyOrderedRows(rows, filters).map(row => row.id)
    const gapAfterIds = new Set()
    for (const afterId of entry.gapAfterIds || []) {
      const marker = orderedIds.includes(afterId) ? afterId : orderedIds.find(id => id < afterId)
      if (marker !== undefined) gapAfterIds.add(marker)
    }
    // A failed newest read still knows which loaded text the change feed made
    // unsafe. Keep the missing internal row named by the next primary row below
    // it, while an explicit numeric range handles the no-survivor case.
    for (const staleId of staleIds) {
      const marker = orderedIds.find(id => id < staleId)
      if (marker !== undefined) gapAfterIds.add(marker)
    }
    const namedAfterIds = [...gapAfterIds].sort((left, right) => right - left)
    return Object.freeze({
      ...entry,
      rows,
      gapAfterIds: namedAfterIds,
      gapRanges: staleHistoryGapRanges(entry.gapRanges, held, filters),
      beyondFillIds: (entry.beyondFillIds || []).filter(id => namedAfterIds.includes(id)),
      hasMore: true,
      initialized: true,
      loading: false,
      error: false,
      refreshError: true,
      newestReadFailed: true,
    })
  }

  function freshSnapshotHistories(
    snapshot, changes = null, ownNewestPages = {}, previousHistories = state.histories,
  ) {
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
      const previousEntries = previousHistories[collection] || {}
      const kind = historyViewerRecordKind(collection)
      let entries = {}
      entries = Object.fromEntries(Object.entries(previousEntries).flatMap(([key, entry]) => {
        if (!entry || !entry.rows) return []
        const filters = entry.filters || Object.freeze({
          placeId: null, resident: null, context: false,
        })
        if (key === 'all' || !entry.filters) {
          return [[key, keepLoadedRows
            ? retainedHistoryEntry(entry, snapshot[collection], kind, filters, keys, page)
            : freshHistoryEntry(entry, snapshot[collection], page)]]
        }
        const ownPage = ownNewestPages[collection]?.[key]
        if (!ownPage || ownPage.failed === true) {
          return [[key, keepLoadedRows
            ? failedOwnNewestEntry(entry, kind, filters, keys)
            : Object.freeze({ ...freshHistoryEntry(entry, [], null),
                hasMore: true, refreshError: true, newestReadFailed: true })]]
        }
        return [[key, keepLoadedRows
          ? retainedHistoryEntry(entry, ownPage.rows, kind, filters, keys, ownPage.page)
          : freshHistoryEntry(entry, ownPage.rows, ownPage.page)]]
      }))
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

  function activeHistoryIdentities() {
    if (state.view === 'things') return new Set(['things|all'])
    if (state.view === 'place') {
      const place = selectedPlace(state.snapshot) ||
        (!state.resident && !state.placeId ? state.snapshot?.flatPlaces[0] || null : null)
      if (!place) return new Set()
      const filters = Object.freeze({ placeId: place.id, resident: state.resident })
      return new Set([
        'notes|' + historyKey('notes', filters),
        'things|' + historyKey('things', filters),
      ])
    }
    if (state.view === 'happenings') {
      const filters = Object.freeze({ placeId: state.placeId, resident: state.resident })
      return new Set(['events|' + historyKey('events', filters)])
    }
    if (state.view === 'conversations') {
      const filters = Object.freeze({
        placeId: state.placeId,
        resident: state.resident,
        context: Boolean(state.resident && state.conversationContext),
      })
      return new Set(['notes|' + historyKey('notes', filters)])
    }
    if (state.view === 'agreements') {
      const filters = Object.freeze({ placeId: null, resident: state.resident })
      return new Set(['agreements|' + historyKey('agreements', filters)])
    }
    return new Set()
  }

  // Each filtered list starts from its own newest page. Reads are sequential,
  // active first, under the refresh's one shared abort budget; an unvisited or
  // timed-out cached list is marked unchecked rather than called current.
  async function readOwnNewestHistoryPages(histories, marker, signal) {
    const active = activeHistoryIdentities()
    const requests = []
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      for (const [key, entry] of Object.entries(histories[collection] || {})) {
        if (key === 'all' || !entry?.filters) continue
        requests.push(Object.freeze({ collection, key, entry,
          priority: active.has(collection + '|' + key) ? 0 : 1 }))
      }
    }
    requests.sort((left, right) => left.priority - right.priority)
    let pages = {}
    for (const request of requests) {
      if (signal && signal.aborted) break
      let result = Object.freeze({ failed: true })
      try {
        const url = historyRequestUrl(
          request.collection,
          { initialized: false, nextBeforeId: null },
          request.entry.filters,
          marker,
          null,
        )
        const response = await fetch(url.pathname + url.search, {
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          mode: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal,
        })
        if (!response.ok) throw new Error('newest public history unavailable')
        const payload = await response.json()
        requireExactReadMarker(payload?.change_marker, marker)
        const rows = normalizeHistoryRows(request.collection, payload)
        const hasMore = payload.has_more === true
        const nextBeforeId = hasMore ? safeId(payload.next_before_id) : null
        if (hasMore && (!nextBeforeId || !historyOrderedRows(rows, request.entry.filters)
          .some(row => row.id === nextBeforeId))) {
          throw new Error('newest public history cursor did not match its own ordering')
        }
        result = Object.freeze({
          failed: false,
          rows,
          page: Object.freeze({ hasMore, nextBeforeId }),
        })
      } catch {
        result = Object.freeze({ failed: true })
      }
      pages = {
        ...pages,
        [request.collection]: {
          ...pages[request.collection],
          [request.key]: result,
        },
      }
    }
    return pages
  }

  async function reconcileChangedSnapshotHistories(
    snapshot, changes, ownNewestPages, marker, signal,
  ) {
    // A Load older read may finish while this refresh awaits a gap fill. Start
    // the whole reconciliation again from the latest list state; once a pass
    // reaches its final check without another write, its synchronous return
    // and the caller's state assignment cannot lose a page.
    while (true) {
      const revisionAtPass = historyRevision
      let histories = freshSnapshotHistories(
        snapshot, changes, ownNewestPages, state.histories,
      )
      histories = await rejoinSnapshotHistories(histories, marker, signal)
      if (signal && signal.aborted) throw new Error('window refresh timed out')
      if (revisionAtPass === historyRevision) return histories
    }
  }

  function filledHistoryEntry(entry, rows, gap, filters, options) {
    const closed = options.closed === true
    const rangeKey = gapRangeKey(gap)
    const gapAfterIds = closed
      ? (entry.gapAfterIds || []).filter(id => id !== gap.afterId)
      : entry.gapAfterIds || []
    const gapRanges = closed
      ? (entry.gapRanges || []).filter(candidate => gapRangeKey(candidate) !== rangeKey)
      : entry.gapRanges || []
    const beyondFillIds = closed
      ? (entry.beyondFillIds || []).filter(id => id !== gap.afterId)
      : options.beyondFill === true
        ? gap.afterId === null ? entry.beyondFillIds || []
          : [...new Set([...(entry.beyondFillIds || []), gap.afterId])]
        : entry.beyondFillIds || []
    const beyondFillRanges = closed
      ? (entry.beyondFillRanges || []).filter(key => key !== rangeKey)
      : options.beyondFill === true
        ? [...new Set([...(entry.beyondFillRanges || []), rangeKey])]
        : entry.beyondFillRanges || []
    return Object.freeze({
      ...entry,
      rows,
      gapAfterIds,
      gapRanges,
      beyondFillIds,
      beyondFillRanges,
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
  async function fillHistoryGap(collection, entry, filters, marker, signal, budget) {
    const gap = namedHistoryGap(entry)
    if (!gap) return entry
    let rows = entry.rows
    let readMarker = marker
    const startingBudget = budget.remaining
    let provedBeyondBudget = false
    let markerRetries = 0
    let beforeId = gap.beforeId
    try {
      while (budget.remaining > 0) {
        // A context response can carry four neighboring notes beside each
        // primary note. Reserve for all five so returned rows cannot make the
        // one-refresh budget exceed its public bound.
        const maximumRows = filters.context
          ? Math.min(25, Math.floor(budget.remaining / 5))
          : Math.min(50, budget.remaining)
        if (maximumRows < 1) break
        const url = historyRequestUrl(
          collection,
          { initialized: beforeId !== null, nextBeforeId: beforeId },
          filters,
          readMarker,
          gap,
          maximumRows,
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
        const incoming = normalizeHistoryRows(collection, payload)
        if (incoming.length > budget.remaining) {
          throw new Error('public gap read exceeded the refresh row budget')
        }
        budget.remaining -= incoming.length
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
        rows = mergeWindowRows(rows, incoming)
        if (payload.has_more !== true) {
          return filledHistoryEntry(entry, rows, gap, filters, { closed: true })
        }
        if (!incoming.length) throw new Error('public gap read did not progress')
        const nextBeforeId = safeId(payload.next_before_id)
        if (!nextBeforeId || !historyOrderedRows(incoming, filters)
          .some(row => row.id === nextBeforeId) ||
          (beforeId !== null && nextBeforeId >= beforeId)) {
          throw new Error('public gap read cursor did not match its own ordering')
        }
        beforeId = nextBeforeId
        markerRetries = 0
        if (budget.remaining === 0 && startingBudget === WINDOW_HISTORY_FILL_ROWS) {
          provedBeyondBudget = true
        }
      }
    } catch {
      // A fill the refresh budget cut short read nothing and failed at nothing,
      // so the range keeps its name without telling the reader a read failed.
      if (signal && signal.aborted) {
        return filledHistoryEntry(entry, rows, gap, filters, {})
      }
      return filledHistoryEntry(entry, rows, gap, filters, { readFailed: true })
    }
    return filledHistoryEntry(entry, rows, gap, filters,
      provedBeyondBudget ? { beyondFill: true } : {})
  }

  // One gap read at a time. A reader who has used many filters keeps one list
  // per filter, and a refresh can name a gap in several of them at once;
  // reading them together would aim a burst of reads at the city for one
  // refresh. Anything the shared read budget does not reach keeps its name and
  // its own control, which is a waiting state the reader can finish by hand.
  async function rejoinSnapshotHistories(histories, marker, signal) {
    let rejoined = histories
    const active = activeHistoryIdentities()
    const requests = []
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      for (const [key] of Object.entries(rejoined[collection] || {})) {
        requests.push(Object.freeze({
          collection,
          key,
          priority: active.has(collection + '|' + key) ? 0 : 1,
        }))
      }
    }
    requests.sort((left, right) => left.priority - right.priority)
    const budget = { remaining: WINDOW_HISTORY_FILL_ROWS }
    for (const request of requests) {
        const { collection, key } = request
        const entry = rejoined[collection][key]
        const gap = namedHistoryGap(entry)
        if (!gap || (entry.beyondFillRanges || []).includes(gapRangeKey(gap)) ||
            (gap.afterId !== null && (entry.beyondFillIds || []).includes(gap.afterId))) continue
        if (budget.remaining === 0 || (signal && signal.aborted)) return rejoined
        const filters = entry.filters || Object.freeze({
          placeId: null, resident: null, context: false,
        })
        const filled = await fillHistoryGap(collection, entry, filters, marker, signal, budget)
        rejoined = {
          ...rejoined,
          [collection]: { ...rejoined[collection], [key]: filled },
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
