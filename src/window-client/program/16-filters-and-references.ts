export const PART_16_FILTERS_AND_REFERENCES = `  function populateFilters(snapshot) {
    const places = displayedDirectoryPlaces(snapshot)
    if (nodes.placeFilter) {
      const choices = listWindowDirectoryPlaces(places)
      const visiblePlaceIds = new Set(choices.map(option => option.id))
      const placeholder = element('option', '', 'All places')
      placeholder.value = ''
      const options = [placeholder, ...choices.map(choice => {
        const option = element('option', '', '\u00a0\u00a0'.repeat(choice.depth) + choice.label)
        option.value = String(choice.id)
        return option
      })]
      if (state.placeId && !visiblePlaceIds.has(state.placeId)) {
        const selected = focusedPlace(state.placeId) ||
          places.find(place => place.id === state.placeId)
        const focusedRead = state.focusedPlaces[String(state.placeId)]
        const option = element('option', '', selected
          ? selected.name + ' · Place #' + String(selected.id)
          : focusedRead?.notFound
            ? 'Place #' + String(state.placeId) + ' · no public place was found'
            : focusedRead?.error
              ? 'Place #' + String(state.placeId) + ' · public place could not be loaded'
              : 'Place #' + String(state.placeId) + ' · loading public place…')
        option.value = String(state.placeId)
        options.push(option)
      }
      nodes.placeFilter.replaceChildren(...options)
      nodes.placeFilter.value = state.placeId ? String(state.placeId) : ''
    }
    if (nodes.residentFilter) {
      const residents = state.directory.loaded ? state.directory.residents : snapshot.residents
      const focusedRead = state.resident ? state.focusedResidents[state.resident] : null
      const missingResident = state.resident && !residents.some(resident => resident.handle === state.resident)
        ? [element('option', '', focusedRead?.notFound
          ? state.resident + ' · no public resident was found'
          : focusedRead?.error
            ? state.resident + ' · public resident could not be loaded'
            : state.resident + ' · loading public resident…')]
        : []
      if (missingResident[0]) missingResident[0].value = state.resident
      const options = [element('option', '', 'All residents'), ...residents.map(resident => {
        const option = element('option', '', resident.handle + ' · Resident #' + String(resident.id))
        option.value = resident.handle
        return option
      }), ...missingResident]
      options[0].value = ''
      nodes.residentFilter.replaceChildren(...options)
      nodes.residentFilter.value = state.resident || ''
    }
    renderDirectorySearch(snapshot)
  }

  function selectedResident(snapshot) {
    return state.resident
      ? focusedResident(state.resident) ||
        snapshot.residents.find(resident => resident.handle === state.resident)
      : null
  }

  function residentPresentationKey(snapshot) {
    return JSON.stringify(snapshot?.residents || [])
  }

  function directoryResident(handle) {
    return handle
      ? state.directory.residents.find(resident => resident.handle === handle) || null
      : null
  }

  function residentReference(snapshot, handle) {
    if (!handle) return null
    return focusedResident(handle) ||
      snapshot.residents.find(resident => resident.handle === handle) || directoryResident(handle)
  }

  function directoryPlace(placeId) {
    return placeId
      ? state.directory.places.find(place => place.id === placeId) || null
      : null
  }

  function placeScopeSet(placeId, snapshot) {
    const places = state.directory.loaded
      ? state.directory.places
      : snapshot?.flatPlaces || []
    return new Set(windowDirectoryPlaceScopeIds(places, placeId))
  }

  function placeReference(snapshot, placeId) {
    if (!placeId) return null
    return focusedPlace(placeId) ||
      snapshot.flatPlaces.find(place => place.id === placeId) || directoryPlace(placeId)
  }

  // Decision #75, the single answer every listing path must use: is the row
  // at this place_id inside a quiet room? The complete names directory
  // covers every place in the city, not only whatever a given render has
  // separately loaded through map navigation, so resolving through
  // placeReference — instead of each call site trusting whatever partial
  // place data it happens to hold — is what keeps a quiet descendant from
  // leaking through a path that never itself loaded that descendant's own
  // place record. Every place source (a focused read, the current
  // snapshot's loaded places, or the directory itself) reports quiet as a
  // definite boolean once loaded; unresolved is read as not-quiet only for
  // the brief window before the directory loads, matching every other
  // directory-dependent view in this client.
  //
  // isQuietPlace is the one predicate every render below calls on a place
  // resolved at that row's own place_id (never at whatever place a list
  // happens to be scoped to). Never write place.quiet, or place &&
  // place.quiet, directly at a call site — route it through here so there
  // is exactly one place that answers "is this quiet" for the whole
  // client to agree on.
  function isQuietPlace(place) {
    return Boolean(place && place.quiet === true)
  }

  function focusedPlacePath(reference, place) {
    if (!reference) return place.name + ' · Place #' + String(place.id)
    const fallbackSuffix = ' · Place #' + String(place.id)
    if (reference.path.endsWith(fallbackSuffix)) return place.name + fallbackSuffix
    const names = reference.path.split(' / ')
    return [...names.slice(0, -1), place.name].join(' / ')
  }

  function focusedPlace(placeId) {
    if (!placeId) return null
    const entry = state.focusedPlaces[String(placeId)]
    const place = entry?.place || null
    if (place && state.changeMarker && !markerCovers(entry?.marker, state.changeMarker)) return null
    const reference = directoryPlace(placeId)
    return place
      ? Object.freeze({ ...place, path: focusedPlacePath(reference, place) })
      : null
  }

  function focusedResident(handle) {
    if (!handle) return null
    const entry = state.focusedResidents[handle]
    if (entry?.resident && state.changeMarker && !markerCovers(entry.marker, state.changeMarker)) {
      return null
    }
    return entry?.resident || null
  }

  function selectedPlace(snapshot) {
    const followed = selectedResident(snapshot)
    const id = state.placeId || (followed && followed.current_place_id) || null
    return id
      ? focusedPlace(id) || snapshot.flatPlaces.find(place => place.id === id)
      : null
  }

  function liveSurveyCoversPlace(snapshot, placeId) {
    return Boolean(
      placeId &&
      state.view === 'live' &&
      state.directory.loaded &&
      liveSurveyIsComplete(snapshot) &&
      snapshot.liveSurvey.some(place => place.id === placeId),
    )
  }

  function displayedResidents(snapshot) {
    const residents = snapshot.residents.map(resident =>
      focusedResident(resident.handle) || resident)
    const followed = selectedResident(snapshot)
    return followed && !residents.some(resident => resident.handle === followed.handle)
      ? [...residents, followed]
      : residents
  }

  function residentsAt(snapshot, placeId) {
    const placeIds = placeScopeSet(placeId, snapshot)
    return displayedResidents(snapshot).filter(resident => placeIds.has(resident.current_place_id) &&
      (!state.resident || resident.handle === state.resident))
  }

  // Decision #75, third review pass: residentsAt stays raw and
  // quiet-inclusive on purpose — occupantLine (the Map tab's place cards)
  // needs the un-filtered list to notice a hidden descendant and render its
  // own quietRoomNotice. Every OTHER recursive Live consumer that renders a
  // resident by name (a detailed ancestor plot's portrait grid, the direct
  // ground's expanded height) must never receive a resident whose own
  // place — resolved at that resident's row, never at whatever place the
  // card being built happens to be — is quiet, no matter how many levels
  // below the plotted place that quiet place sits. Route every such
  // consumer through here instead of calling residentsAt directly.
  function liveVisibleResidentsAt(snapshot, placeId) {
    return residentsAt(snapshot, placeId).filter(resident =>
      !isQuietPlace(placeReference(snapshot, resident.current_place_id)))
  }

  function selectionIssue(snapshot, includeCurrentPlace) {
    const resident = selectedResident(snapshot)
    if (state.resident && !resident) {
      const entry = state.focusedResidents[state.resident]
      return Object.freeze({
        kind: 'resident', value: state.resident,
        status: entry?.notFound ? 'not-found' : entry?.error ? 'error' : 'loading',
      })
    }
    const placeId = state.placeId ||
      (includeCurrentPlace && resident ? resident.current_place_id : null)
    const place = placeId
      ? snapshot.flatPlaces.find(candidate => candidate.id === placeId) || focusedPlace(placeId)
      : null
    if (placeId && !place) {
      const entry = state.focusedPlaces[String(placeId)]
      return Object.freeze({
        kind: 'place', value: placeId,
        status: entry?.notFound ? 'not-found' : entry?.error ? 'error' : 'loading',
      })
    }
    return null
  }

  function renderSelectionIssue(target, issue, itemTag, focusFallbackId) {
    if (!target || !issue) return false
    const loadingMessage = issue.kind === 'resident'
      ? 'Loading public resident ' + String(issue.value) + '…'
      : 'Loading public place #' + String(issue.value) + '…'
    const notFoundMessage = issue.kind === 'resident'
      ? 'No public resident was found for ' + String(issue.value) + '.'
      : 'No public place was found for #' + String(issue.value) + '.'
    const failureMessage = issue.kind === 'resident'
      ? 'Public resident ' + String(issue.value) + ' could not be loaded.'
      : 'Public place #' + String(issue.value) + ' could not be loaded.'
    const row = element(itemTag || 'div', issue.status === 'error' ? 'error-row' :
      issue.status === 'not-found' ? 'empty-row' : 'loading-row')
    if (issue.status === 'loading') {
      row.textContent = loadingMessage
    } else if (issue.status === 'not-found') {
      row.textContent = notFoundMessage
    } else {
      row.setAttribute('role', 'alert')
      row.append(element('p', '', failureMessage))
      const retry = element('button', 'selection-retry', issue.kind === 'resident'
        ? 'Retry loading this resident'
        : 'Retry loading this place')
      retry.type = 'button'
      retry.dataset.focusKey = 'selection-retry:' + issue.kind + ':' + String(issue.value)
      retry.dataset.focusFallbackId = focusFallbackId || target.id
      retry.addEventListener('click', () => {
        if (issue.kind === 'resident') void ensureFocusedSelection({ forceResident: true })
        else void loadFocusedPlace(Number(issue.value), true)
      })
      row.append(retry)
    }
    target.replaceChildren(row)
    return true
  }

  function occupantChip(resident) {
    const chip = element('button', resident.asleep ? 'occupant-chip asleep' : 'occupant-chip')
    chip.type = 'button'
    chip.dataset.focusKey = 'occupant:' + resident.handle
    if (resident.asleep) chip.title = 'dimmed by a two-week public-activity display heuristic · not proof they are offline'
    chip.addEventListener('click', () => chooseResident(resident.handle))
    chip.append(
      portraitNode('resident', resident.id, resident.handle, resident.has_drawing, 'occupant-portrait'),
      document.createTextNode(resident.handle),
    )
    return chip
  }

  function toggleSleepers(placeId) {
    const sleeperPlaceIds = state.sleeperPlaceIds.includes(placeId)
      ? state.sleeperPlaceIds.filter(id => id !== placeId)
      : [...state.sleeperPlaceIds, placeId]
    state = { ...state, sleeperPlaceIds }
    writeLocation(true)
    if (state.snapshot) renderAll()
  }

  // Decision #75: this line recurses through every descendant of place
  // (residentsAt includes the whole scope), so a resident's own place —
  // never the place card this line belongs to — decides whether their
  // chip renders. Hidden quiet residents collapse behind one shared
  // notice per distinct quiet place instead of a chip per name.
  function occupantLine(place, occupants, placeOf) {
    const line = element('div', 'occupant-line')
    const quietPlaces = new Map()
    const visible = occupants.filter(resident => {
      const residentPlace = placeOf ? placeOf(resident.current_place_id) : null
      if (!isQuietPlace(residentPlace)) return true
      quietPlaces.set(residentPlace.id, residentPlace)
      return false
    })
    const awake = visible.filter(resident => !resident.asleep)
    const asleep = visible.filter(resident => resident.asleep)
    line.append(...awake.map(occupantChip))
    if (asleep.length) {
      const shown = state.sleeperPlaceIds.includes(place.id)
      const toggle = element('button', 'sleeper-toggle',
        shown ? 'hide the asleep' : String(asleep.length) + ' asleep')
      toggle.type = 'button'
      toggle.dataset.focusKey = 'sleepers:' + String(place.id)
      toggle.setAttribute('aria-expanded', String(shown))
      toggle.setAttribute('aria-label', (shown ? 'Hide' : 'Show') +
        ' residents asleep in ' + place.name)
      toggle.addEventListener('click', () => toggleSleepers(place.id))
      line.append(toggle)
      if (shown) line.append(...asleep.map(occupantChip))
    }
    for (const quietPlace of quietPlaces.values()) line.append(quietRoomNotice(quietPlace))
    return line
  }

  function branchEntry(place) {
    const stored = state.branches[String(place.id)]
    if (stored) return stored
    const loaded = place.children.length > 0 || place.places === 0
    const hasMore = place.places > place.children.length
    return Object.freeze({
      rows: place.children,
      loaded,
      initialized: loaded,
      hasMore,
      nextBeforeSubplaceId: loaded && hasMore ? safeId(place.children.at(-1)?.id) : null,
      seenBeforeSubplaceIds: [],
      loading: false,
      error: false,
    })
  }

`
