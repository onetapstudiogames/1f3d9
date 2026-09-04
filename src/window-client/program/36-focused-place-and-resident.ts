export const PART_36_FOCUSED_PLACE_AND_RESIDENT = `  async function loadFocusedPlace(placeId, force) {
    if (!state.snapshot || state.snapshot.flatPlaces.some(place => place.id === placeId)) return
    const current = state.focusedPlaces[String(placeId)]
    if (current?.loading || (!force && current?.place)) return
    const selectionAtStart = activeSelectionKey()
    const requestMarker = state.changeMarker
    const requestAuthoredRevision = authoredRevision
    state = {
      ...state,
      focusedPlaces: {
        ...state.focusedPlaces,
        [String(placeId)]: Object.freeze({
          loading: true,
          error: false,
          notFound: false,
          marker: current?.marker || null,
          place: current?.place || null,
        }),
      },
    }
    renderAll()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/map', window.location.origin)
      url.searchParams.set('view', 'outline')
      url.searchParams.set('parent_id', String(placeId))
      if (requestMarker) url.searchParams.set('after_change_marker', requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (response.status === 404) {
        const payload = await response.json().catch(() => null)
        requireCurrentReadMarker(payload?.change_marker, requestMarker)
        if (authoredRevision !== requestAuthoredRevision || state.changeMarker !== requestMarker) {
          throw new Error('focused place reply was overtaken by a newer public snapshot')
        }
        state = {
          ...state,
          focusedPlaces: {
            ...state.focusedPlaces,
            [String(placeId)]: Object.freeze({
              loading: false,
              error: false,
              notFound: true,
              marker: requestMarker || current?.marker || null,
              place: null,
            }),
          },
        }
        return
      }
      if (!response.ok) throw new Error('focused place unavailable')
      const payload = await response.json()
      const responseMarker = safeChangeMarker(payload?.change_marker)
      requireCurrentReadMarker(responseMarker, requestMarker)
      const [normalized] = normalizePlaces([payload?.place], 0, new Set())
      if (!normalized || normalized.id !== placeId) throw new Error('wrong focused place')
      const reference = directoryPlace(placeId)
      const place = Object.freeze({
        ...normalized,
        children: [],
        path: focusedPlacePath(reference, normalized),
      })
      state = {
        ...state,
        focusedPlaces: {
          ...state.focusedPlaces,
          [String(placeId)]: Object.freeze({
            loading: false,
            error: false,
            notFound: false,
            marker: responseMarker || requestMarker || null,
            place,
          }),
        },
      }
    } catch {
      const retainedCovers = Boolean(current?.place) &&
        (!state.changeMarker || markerCovers(current?.marker, state.changeMarker))
      state = {
        ...state,
        focusedPlaces: {
          ...state.focusedPlaces,
          [String(placeId)]: Object.freeze({
            loading: false,
            error: !retainedCovers,
            notFound: false,
            marker: current?.marker || null,
            place: current?.place || null,
          }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (activeSelectionKey() === selectionAtStart) {
        if (state.snapshot) populateFilters(state.snapshot)
        renderAll()
      }
    }
  }

  async function loadFocusedResident(handle, force) {
    if (!state.snapshot || state.snapshot.residents.some(resident => resident.handle === handle)) return
    const current = state.focusedResidents[handle]
    if (current?.loading || (!force && current?.resident)) return
    const selectionAtStart = activeSelectionKey()
    const requestMarker = state.changeMarker
    const requestAuthoredRevision = authoredRevision
    state = {
      ...state,
      focusedResidents: {
        ...state.focusedResidents,
        [handle]: Object.freeze({
          loading: true,
          error: false,
          notFound: false,
          marker: current?.marker || null,
          resident: current?.resident || null,
        }),
      },
    }
    renderAll()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/residents', window.location.origin)
      url.searchParams.set('view', 'presence')
      url.searchParams.set('handle', handle)
      if (requestMarker) url.searchParams.set('after_change_marker', requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (response.status === 404) {
        const payload = await response.json().catch(() => null)
        requireCurrentReadMarker(payload?.change_marker, requestMarker)
        if (authoredRevision !== requestAuthoredRevision || state.changeMarker !== requestMarker) {
          throw new Error('focused resident reply was overtaken by a newer public snapshot')
        }
        state = {
          ...state,
          focusedResidents: {
            ...state.focusedResidents,
            [handle]: Object.freeze({
              loading: false,
              error: false,
              notFound: true,
              marker: requestMarker || current?.marker || null,
              resident: null,
            }),
          },
        }
        return
      }
      if (!response.ok) throw new Error('focused resident unavailable')
      const payload = await response.json()
      const [resident] = normalizeResidents([payload?.resident])
      if (!resident || resident.handle !== handle) throw new Error('wrong focused resident')
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      if (authoredRevision !== requestAuthoredRevision || state.changeMarker !== requestMarker) {
        throw new Error('focused resident reply was overtaken by a newer public snapshot')
      }
      state = {
        ...state,
        focusedResidents: {
          ...state.focusedResidents,
          [handle]: Object.freeze({
            loading: false,
            error: false,
            notFound: false,
            marker: safeChangeMarker(payload?.change_marker) || requestMarker || null,
            resident,
          }),
        },
      }
    } catch {
      const retainedCovers = Boolean(current?.resident) &&
        (!state.changeMarker || markerCovers(current?.marker, state.changeMarker))
      state = {
        ...state,
        focusedResidents: {
          ...state.focusedResidents,
          [handle]: Object.freeze({
            loading: false,
            error: !retainedCovers,
            notFound: false,
            marker: current?.marker || null,
            resident: current?.resident || null,
          }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (activeSelectionKey() === selectionAtStart) {
        if (state.snapshot) populateFilters(state.snapshot)
        renderAll()
      }
    }
  }

  async function ensureFocusedSelection(options) {
    const forcePlace = options?.forcePlace === true
    const forceResident = options?.forceResident === true
    if (!state.snapshot) return
    const selectionAtStart = activeSelectionKey()
    const selectedHandle = state.resident
    const explicitPlaceId = state.placeId

    if (selectedHandle &&
        !state.snapshot.residents.some(resident => resident.handle === selectedHandle)) {
      const entry = state.focusedResidents[selectedHandle]
      if (!entry || forceResident) {
        await loadFocusedResident(selectedHandle, forceResident)
      }
      if (activeSelectionKey() !== selectionAtStart || state.resident !== selectedHandle) return
      const latest = state.focusedResidents[selectedHandle]
      if (latest?.error || latest?.notFound || !latest?.resident) return
    }

    if (explicitPlaceId &&
        !state.snapshot.flatPlaces.some(place => place.id === explicitPlaceId)) {
      if (liveSurveyCoversPlace(state.snapshot, explicitPlaceId)) return
      const entry = state.focusedPlaces[String(explicitPlaceId)]
      if (!entry || (forcePlace && Boolean(entry.place))) {
        await loadFocusedPlace(explicitPlaceId, forcePlace)
      }
      return
    }

    if (!explicitPlaceId && selectedHandle) {
      const resident = selectedResident(state.snapshot)
      const currentPlaceId = resident?.current_place_id || null
      if (currentPlaceId &&
          !state.snapshot.flatPlaces.some(place => place.id === currentPlaceId)) {
        if (liveSurveyCoversPlace(state.snapshot, currentPlaceId)) return
        const entry = state.focusedPlaces[String(currentPlaceId)]
        if (!entry || (forcePlace && Boolean(entry.place))) {
          await loadFocusedPlace(currentPlaceId, forcePlace)
        }
      }
    }
  }

`
