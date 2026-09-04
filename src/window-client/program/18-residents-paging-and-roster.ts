export const PART_18_RESIDENTS_PAGING_AND_ROSTER = `  function residentRequestUrl(entry, minimumMarker) {
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

  // Fourth review pass on row 75: unlike renderPeople, renderThings, and
  // occupantLine — every one of which already resolves quiet at each row's
  // own place before naming it — this Map-tab roster read every loaded
  // resident's handle and full place path with no quiet check at all. Each
  // resident's own current_place_id (never the scope this roster happens to
  // be filtered to) decides whether their row renders; a quiet place
  // collapses every resident standing there behind one shared notice, the
  // same shape occupantLine already uses for the Map tab's place cards.
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
    const matching = availableResidents.filter(resident =>
      (!state.resident || resident.handle === state.resident) &&
      (!selectedPlaceIds || selectedPlaceIds.has(resident.current_place_id)))
    const quietPlaces = new Map()
    const visible = matching.filter(resident => {
      const residentPlace = placeReference(snapshot, resident.current_place_id)
      if (!isQuietPlace(residentPlace)) return true
      quietPlaces.set(residentPlace.id, residentPlace)
      return false
    })
    if (!visible.length && !quietPlaces.size) {
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
        row.prepend(portraitNode('resident', resident.id, resident.handle, resident.has_drawing))
        group.append(row)
      }
      fragment.append(group)
    }
    for (const quietPlace of quietPlaces.values()) {
      const group = element('section', 'roster-group roster-group-quiet')
      group.append(quietRoomNotice(quietPlace))
      fragment.append(group)
    }
    nodes.roster.replaceChildren(fragment)
  }

`
