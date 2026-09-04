export const PART_19_THING_INDEX = `  function livePlaceRows(snapshot) {
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

  function liveSurveyNotesAreComplete(snapshot) {
    if (!state.directory.loaded || !snapshot.liveSurvey?.length ||
        snapshot.liveSurvey.length !== state.directory.places.length) return false
    const directoryById = new Map(state.directory.places.map(place => [place.id, place]))
    const topologyMatches = snapshot.liveSurvey.every(place => {
      const directoryPlace = directoryById.get(place.id)
      return directoryPlace && directoryPlace.parent_id === place.parent_id
    })
    const surveyedNotes = snapshot.liveSurvey.reduce((total, place) => total + place.notes, 0)
    return topologyMatches && Number.isSafeInteger(surveyedNotes) &&
      surveyedNotes === snapshot.totals.conversations
  }

  function liveSurveyNoteTotal(snapshot, placeId) {
    if (!liveSurveyNotesAreComplete(snapshot)) return null
    const place = snapshot.liveSurvey.find(candidate => candidate.id === placeId)
    return place ? place.notes : null
  }

  function liveExactThingTotal(snapshot, placeId, loadedCount, includeDescendants) {
    const surveyedTotal = liveSurveyThingTotal(snapshot, placeId, includeDescendants)
    return surveyedTotal !== null && surveyedTotal >= loadedCount ? surveyedTotal : null
  }

  function thingIndexScopeKey() {
    return state.placeId ? 'inside:' + String(state.placeId) : 'city'
  }

  function exactThingIndexTotal(snapshot) {
    if (!liveSurveyIsComplete(snapshot)) return null
    if (state.placeId) return liveSurveyThingTotal(snapshot, state.placeId, true)
    return snapshot.liveSurvey.reduce((total, place) => total + place.things, 0)
  }

  function thingHeadingPath(snapshot, thing) {
    return windowPlaceLabel(thing.place_id, placeReference(snapshot, thing.place_id)) ||
      'Place #' + String(thing.place_id)
  }

  function renderThingIndexPage() {
    if (!nodes.thingsPage) return
    const index = state.thingIndex
    const parts = []
    if (index.error && index.rows.length) {
      const message = element('p', 'navigation-error', 'More thing headings could not be loaded.')
      message.setAttribute('role', 'alert')
      parts.push(message)
    }
    if (index.hasMore && index.nextBeforeId) {
      const button = element('button', 'history-load', index.loading
        ? 'Loading more things…'
        : index.error ? 'Retry continuing things' : 'Continue things')
      button.type = 'button'
      button.disabled = index.loading
      button.setAttribute('aria-busy', String(index.loading))
      button.dataset.focusKey = 'things-continue'
      button.dataset.focusFallbackId = 'things-list'
      button.addEventListener('click', () => void loadThingIndex(false))
      parts.push(button)
    }
    nodes.thingsPage.hidden = parts.length === 0
    nodes.thingsPage.replaceChildren(...parts)
  }

  function renderThingIndex(snapshot) {
    if (!nodes.thingsList || !nodes.thingsSummary) return
    const scopedPlace = state.placeId ? placeReference(snapshot, state.placeId) : null
    if (scopedPlace && scopedPlace.quiet) {
      nodes.thingsSummary.textContent = scopedPlace.name + ' asked the window to stay quiet.'
      renderQuietRoom(nodes.thingsList, scopedPlace)
      if (nodes.thingsPage) nodes.thingsPage.hidden = true
      return
    }
    const expectedScopeKey = thingIndexScopeKey()
    const index = state.thingIndex.scopeKey === expectedScopeKey
      ? state.thingIndex
      : { ...state.thingIndex, rows: [], initialized: false, loading: false, error: false }
    if (!index.initialized && !index.loading) {
      void loadThingIndex(true)
      return
    }
    const exactTotal = exactThingIndexTotal(snapshot)
    if (exactTotal === null) {
      nodes.thingsSummary.textContent = 'The exact public thing count is unavailable. ' +
        'The completed headings below remain newest first.'
    } else {
      nodes.thingsSummary.textContent = String(index.rows.length) + ' of ' + String(exactTotal) +
        (exactTotal === 1 ? ' public thing shown. ' : ' public things shown. ') +
        'Bodies stay closed until you choose one.'
    }
    if (index.loading && !index.rows.length) {
      renderEmpty(nodes.thingsList, 'loading-row', 'Reading the newest public thing headings…')
      renderThingIndexPage()
      return
    }
    if (index.error && !index.rows.length) {
      const retry = element('button', 'history-load', 'Retry loading things')
      retry.type = 'button'
      retry.addEventListener('click', () => void loadThingIndex(true))
      nodes.thingsList.replaceChildren(
        element('p', 'error-row', 'Public thing headings could not be loaded.'),
        retry,
      )
      renderThingIndexPage()
      return
    }
    if (!index.rows.length) {
      renderEmpty(nodes.thingsList, 'empty-row', 'No public thing matches this place selection.')
      renderThingIndexPage()
      return
    }
    const list = element('ul', 'thing-index-list')
    list.append(...index.rows.map(thing => {
      const row = element('li', 'thing-index-row')
      row.dataset.thingId = String(thing.id)
      const resolvedPlace = placeReference(snapshot, thing.place_id)
      if (isQuietPlace(resolvedPlace)) {
        row.classList.add('thing-index-row-quiet')
        row.append(quietRoomNotice(resolvedPlace))
        return row
      }
      const title = element('h3', 'thing-index-title')
      title.append(
        portraitNode('thing', thing.id, thing.name, thing.has_drawing),
        openDetailLink('thing', thing.id, thing.name, 'detail-link thing-index-link'),
      )
      const kind = thing.kind ? thing.kind : 'one of a kind'
      const meta = element('p', 'thing-index-meta')
      meta.append(
        document.createTextNode('kind: ' + kind + ' · at ' + thingHeadingPath(snapshot, thing) +
          ' · made by '),
        residentNode(thing.made_by, 'thing-maker', 'things-maker:' + String(thing.id)),
        document.createTextNode(' · currently owned by '),
        residentNode(
          thing.current_owner,
          'thing-owner',
          'things-owner:' + String(thing.id),
        ),
        document.createTextNode(' · ' + String(thing.body_text_bytes) + ' UTF-8 body bytes'),
      )
      row.append(title, meta)
      return row
    }))
    nodes.thingsList.replaceChildren(list)
    renderThingIndexPage()
  }

  async function loadThingIndex(reset) {
    if (!state.snapshot) return
    const scopeKey = thingIndexScopeKey()
    if (state.thingIndex.loading && state.thingIndex.scopeKey === scopeKey) return
    const previous = state.thingIndex.scopeKey === scopeKey
      ? state.thingIndex
      : { ...state.thingIndex, scopeKey, rows: [], nextBeforeId: null, hasMore: false,
          initialized: false, error: false }
    if (!reset && (!previous.hasMore || !previous.nextBeforeId)) return
    const requestMarker = state.changeMarker
    const requestAuthoredRevision = authoredRevision
    state = {
      ...state,
      thingIndex: {
        ...(reset ? { ...previous, rows: [], nextBeforeId: null, hasMore: false } : previous),
        scopeKey, loading: true, initialized: true, error: false,
      },
    }
    renderAll()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/window', window.location.origin)
      url.searchParams.set('collection', 'things')
      url.searchParams.set('presentation', 'headings')
      url.searchParams.set('limit', '25')
      if (state.placeId) url.searchParams.set('within_place_id', String(state.placeId))
      if (!reset && previous.nextBeforeId) {
        url.searchParams.set('before_id', String(previous.nextBeforeId))
      }
      if (requestMarker) url.searchParams.set('after_change_marker', requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!response.ok) throw new Error('public things unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision || thingIndexScopeKey() !== scopeKey) return
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      const rows = normalizeThingHeadings(payload.things)
      const hasMore = payload.has_more === true
      const nextBeforeId = safeId(payload.next_before_id)
      if (hasMore !== Boolean(nextBeforeId)) throw new Error('invalid public thing page')
      state = {
        ...state,
        thingIndex: {
          scopeKey,
          rows: reset ? rows : mergeWindowRows(previous.rows, rows),
          nextBeforeId: hasMore ? nextBeforeId : null,
          hasMore,
          loading: false,
          initialized: true,
          error: false,
        },
      }
    } catch {
      if (authoredRevision === requestAuthoredRevision && thingIndexScopeKey() === scopeKey) {
        state = {
          ...state,
          thingIndex: { ...state.thingIndex, loading: false, initialized: true, error: true },
        }
      }
    } finally {
      window.clearTimeout(timeout)
      renderAll()
    }
  }

`
