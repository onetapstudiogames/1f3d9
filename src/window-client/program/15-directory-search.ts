export const PART_15_DIRECTORY_SEARCH = `  function activeSelectionKey() {
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

  // Fourth review pass on row 75: the always-visible directory search box
  // resolves a matching thing's place through the same snapshot every other
  // thing surface uses, and drops a thing whose place is quiet before it
  // ever becomes a result — never after, and never just for display, since
  // a suppressed row would still leak the thing's name and full room path
  // through its option markup.
  function thingLookupSearchResults(snapshot) {
    return state.thingLookup.rows
      .filter(thing => !isQuietPlace(placeReference(snapshot, thing.place_id)))
      .map(thing => Object.freeze({
        kind: 'thing',
        id: thing.id,
        value: String(thing.id),
        label: thing.name + ' · Thing #' + String(thing.id),
        detail: thingHeadingPath(snapshot, thing),
        hasDrawing: thing.has_drawing === true,
      }))
  }

  function directorySearchPage(snapshot) {
    const sources = directorySearchSources(snapshot)
    const directoryPage = pageWindowDirectorySearch(
      sources.places,
      sources.residents,
      state.directorySearch,
    )
    const thingResults = state.thingLookup.query === state.directorySearch.trim()
      ? thingLookupSearchResults(snapshot)
      : []
    const reservedThingCount = Math.min(5, thingResults.length)
    const directoryResults = directoryPage.results.slice(0, 20 - reservedThingCount)
    const combined = [
      ...directoryResults,
      ...thingResults.slice(0, 20 - directoryResults.length),
    ]
    const total = directoryPage.total + thingResults.length
    return Object.freeze({
      ...directoryPage,
      results: Object.freeze(combined.slice(0, 20)),
      total,
      thingCount: thingResults.length,
      hasMore: total > combined.length || state.thingLookup.hasMore,
      thingHasMore: state.thingLookup.hasMore,
    })
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
    else if (result.kind === 'thing') navigate({ detail: Object.freeze({ kind: 'thing', id: result.id }) })
    else chooseResident(result.value)
  }

  function renderDirectorySearch(snapshot, open = document.activeElement === nodes.directorySearch) {
    if (!nodes.directorySearch || !nodes.directorySearchResults || !nodes.directorySearchStatus) return
    if (nodes.directorySearch.value !== state.directorySearch) {
      nodes.directorySearch.value = state.directorySearch
    }
    const sources = directorySearchSources(snapshot)
    const query = state.directorySearch.trim()
    if (query && state.thingLookup.query !== query) scheduleThingLookup(query)
    const page = directorySearchPage(snapshot)
    const results = page.results
    const fallbackNotice = state.directory.error
      ? ' The complete city directory is unavailable, so more citywide matches may exist.'
      : ' The complete city directory is still loading, so more citywide matches may exist.'
    const thingNotice = state.thingLookup.loading
      ? ' Looking for matching public things…'
      : state.thingLookup.error
        ? ' Public thing lookup failed; places and residents remain available.'
        : page.thingHasMore
          ? ' Showing the newest matching things; narrow the name or use the Things tab to continue.'
          : ''
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
          'Narrow this search or use the complete selectors and Things tab to reach more.'
        : String(page.total) + (page.total === 1 ? ' result: ' : ' results: ') +
          String(page.placeCount) + (page.placeCount === 1 ? ' place and ' : ' places and ') +
          String(page.residentCount) +
          (page.residentCount === 1 ? ' resident.' : ' residents.') +
          (page.thingCount ? ' ' + String(page.thingCount) +
            (page.thingCount === 1 ? ' matching thing.' : ' matching things.') : '') + thingNotice
      : (page.hasMore
          ? 'Showing the first ' + String(results.length) + ' of ' + String(page.total) +
            ' matches in the currently loaded fallback: '
          : String(page.total) + (page.total === 1
              ? ' result in the currently loaded fallback: '
              : ' results in the currently loaded fallback: ')) +
        String(page.placeCount) + (page.placeCount === 1 ? ' place and ' : ' places and ') +
        String(page.residentCount) +
        (page.residentCount === 1 ? ' resident.' : ' residents.') + fallbackNotice + thingNotice
    if (!results.length) {
      const empty = element('div', 'directory-search-empty', sources.complete
        ? 'No places, residents, or things match this search.' + thingNotice
        : 'No places, residents, or things in the currently loaded fallback match this search.' +
          fallbackNotice + thingNotice)
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
        const copy = element('span', 'directory-search-option-copy')
        copy.append(
          element('strong', '', result.label),
          element('small', '', result.kind === 'place' ? 'Place · ' + result.detail :
            result.kind === 'thing' ? 'Thing · ' + result.detail : result.detail),
        )
        option.append(portraitNode(
          result.kind,
          result.id,
          result.label,
          result.kind === 'place' || result.hasDrawing === true,
        ), copy)
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

  async function loadThingLookup(rawQuery) {
    const validated = validateWindowDirectorySearch(rawQuery)
    const query = validated.ok ? validated.value : ''
    const requestRevision = ++thingLookupRequestRevision
    if (!query) {
      state = {
        ...state,
        thingLookup: { query: '', rows: [], hasMore: false, loading: false, error: false },
      }
      if (state.snapshot) renderDirectorySearch(state.snapshot, false)
      return
    }
    state = {
      ...state,
      thingLookup: { query, rows: [], hasMore: false, loading: true, error: false },
    }
    if (state.snapshot) renderDirectorySearch(state.snapshot, true)
    const controller = new AbortController()
    thingLookupController = controller
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/window', window.location.origin)
      url.searchParams.set('collection', 'things')
      url.searchParams.set('presentation', 'headings')
      url.searchParams.set('find', query)
      url.searchParams.set('limit', '20')
      if (state.changeMarker) url.searchParams.set('after_change_marker', state.changeMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!response.ok) throw new Error('public thing lookup unavailable')
      const payload = await response.json()
      if (requestRevision !== thingLookupRequestRevision || state.directorySearch.trim() !== query) return
      requireCurrentReadMarker(payload?.change_marker, state.changeMarker)
      const rows = normalizeThingHeadings(payload.things)
      const hasMore = payload.has_more === true
      if (hasMore !== Boolean(safeId(payload.next_before_id))) {
        throw new Error('invalid public thing lookup')
      }
      state = {
        ...state,
        thingLookup: { query, rows, hasMore, loading: false, error: false },
      }
    } catch {
      if (requestRevision === thingLookupRequestRevision && state.directorySearch.trim() === query) {
        state = {
          ...state,
          thingLookup: { query, rows: [], hasMore: false, loading: false, error: true },
        }
      }
    } finally {
      window.clearTimeout(timeout)
      if (thingLookupController === controller) thingLookupController = null
      if (state.snapshot) renderDirectorySearch(state.snapshot, true)
    }
  }

  function scheduleThingLookup(rawQuery, delay = 180) {
    const validated = validateWindowDirectorySearch(rawQuery)
    const query = validated.ok ? validated.value : ''
    if (
      query === scheduledThingLookupQuery &&
      (thingLookupTimer !== null || state.thingLookup.query === query)
    ) return
    scheduledThingLookupQuery = query
    if (thingLookupTimer !== null) window.clearTimeout(thingLookupTimer)
    thingLookupTimer = null
    if (thingLookupController) thingLookupController.abort()
    thingLookupController = null
    thingLookupRequestRevision += 1
    if (!query) {
      state = {
        ...state,
        thingLookup: { query: '', rows: [], hasMore: false, loading: false, error: false },
      }
      return
    }
    state = {
      ...state,
      thingLookup: { query, rows: [], hasMore: false, loading: true, error: false },
    }
    thingLookupTimer = window.setTimeout(() => {
      thingLookupTimer = null
      if (scheduledThingLookupQuery === query) void loadThingLookup(query)
    }, delay)
  }

`
