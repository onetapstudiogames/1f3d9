export const PART_34_HISTORY_LOADING_COUNTS_AND_SCOPE = `  function refreshFilteredViews() {
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
    if (state.view === 'things') keys.add('things')
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

`
