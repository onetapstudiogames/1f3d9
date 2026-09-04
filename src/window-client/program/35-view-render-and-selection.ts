export const PART_35_VIEW_RENDER_AND_SELECTION = `  function renderView() {
    const gazetteView = state.view === 'gazette'
    if (nodes.directorySearchField) nodes.directorySearchField.hidden = gazetteView
    if (nodes.viewFilters) nodes.viewFilters.hidden = gazetteView
    for (const tab of tabs) {
      const active = tab.dataset.view === state.view
      tab.setAttribute('aria-selected', String(active))
      tab.tabIndex = active ? 0 : -1
      if (active && tab.parentElement) {
        const tabList = tab.parentElement
        const tabBox = tab.getBoundingClientRect()
        const tabListBox = tabList.getBoundingClientRect()
        if (tabBox.left < tabListBox.left) {
          tabList.scrollLeft -= Math.ceil(tabListBox.left - tabBox.left)
        } else if (tabBox.right > tabListBox.right) {
          tabList.scrollLeft += Math.ceil(tabBox.right - tabListBox.right)
        }
      }
    }
    for (const panel of panels) panel.hidden = panel.id !== state.view + '-panel'
    const live = state.view === 'live'
    if (nodes.liveAlpha) nodes.liveAlpha.hidden = !live
    if (nodes.liveAlphaNote) nodes.liveAlphaNote.hidden = !live
    scheduleLiveClock()
  }

  // A refresh rebuilds the DOM, which would silently drop the reader's
  // keyboard position. Every rebuilt interactive control carries a stable
  // data-focus-key so focus can land back on its replacement.
  function restoreFocus(focusKey, focusFallbackKey, focusFallbackId) {
    if (!focusKey || document.activeElement !== document.body) return
    // Hidden panels keep their previous DOM, so the same key can exist in a
    // stale copy; only a visible replacement can actually take focus.
    const replacements = document.querySelectorAll(
      '[data-focus-key="' + CSS.escape(focusKey) + '"]')
    for (const replacement of replacements) {
      if (replacement.closest('[hidden]')) continue
      replacement.focus({ preventScroll: true })
      return
    }
    const fallback = focusFallbackKey
      ? document.querySelector('[data-focus-key="' + CSS.escape(focusFallbackKey) + '"]')
      : null
    if (fallback && !fallback.closest('[hidden]')) {
      fallback.focus({ preventScroll: true })
      return
    }
    const fallbackTarget = focusFallbackId ? document.getElementById(focusFallbackId) : null
    if (fallbackTarget && !fallbackTarget.closest('[hidden]')) {
      fallbackTarget.tabIndex = -1
      fallbackTarget.focus({ preventScroll: true })
    }
  }

  function renderAll() {
    resetPortraitImages()
    const snapshot = state.snapshot
    const active = document.activeElement
    const focusKey = active && active.dataset ? active.dataset.focusKey || null : null
    const focusFallbackKey = active && active.dataset
      ? active.dataset.focusFallbackKey || null
      : null
    const focusFallbackId = active && active.dataset
      ? active.dataset.focusFallbackId || null
      : null
    renderView()
    renderDirectoryStatus()
    writeLocation(false)
    renderDetail()
    if (state.view === 'archive') renderArchive()
    if (state.view === 'gazette') renderGazette()
    if (!snapshot) return
    renderCounts(snapshot)
    renderScope(snapshot)
    if (state.view === 'map') {
      renderMap(snapshot)
      renderRoster(snapshot)
    } else if (state.view === 'live') {
      renderLive(snapshot)
    } else if (state.view === 'things') {
      renderThingIndex(snapshot)
    } else if (state.view === 'place') {
      renderPlace(snapshot)
    } else if (state.view === 'conversations') {
      renderConversations(snapshot)
    } else if (state.view === 'happenings') {
      renderActivity(snapshot)
    } else if (state.view === 'agreements') {
      renderAgreements(snapshot)
    }
    syncBodyDisclosures()
    if (nodes.placeFilter) nodes.placeFilter.value = state.placeId ? String(state.placeId) : ''
    renderDirectorySearch(snapshot)
    if (nodes.residentFilter) nodes.residentFilter.value = state.resident || ''
    restoreFocus(focusKey, focusFallbackKey, focusFallbackId)
  }

  function choosePlace(id, openPlace) {
    const place = state.snapshot?.flatPlaces.find(candidate => candidate.id === id) ||
      directoryPlace(id) || focusedPlace(id)
    if (!place) return
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      placeId: id,
      directorySearch: '',
      directorySearchIndex: -1,
      view: openPlace ? 'place' : state.view,
      detail: null,
    })
    if (state.snapshot) populateFilters(state.snapshot)
  }

  function chooseResident(handle) {
    const resident = state.snapshot?.residents.find(candidate => candidate.handle === handle) ||
      state.directory.residents.find(candidate => candidate.handle === handle) ||
      focusedResident(handle)
    if (!resident) return
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      resident: handle,
      conversationContext: false,
      directorySearch: '',
      directorySearchIndex: -1,
      detail: null,
    })
  }

  async function loadDirectory(force, scheduleRecheck = true) {
    if (state.directory.loading) return
    if (force) window.clearTimeout(state.directory.recheckTimer)
    state = {
      ...state,
      directory: Object.freeze({ ...state.directory, loading: true, error: false }),
    }
    renderDirectoryStatus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/window', window.location.origin)
      url.searchParams.set('view', 'directory')
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        cache: force ? 'reload' : 'default',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('public directory unavailable')
      const directory = normalizeDirectory(await response.json())
      state = {
        ...state,
        directory: Object.freeze({
          ...directory,
          loaded: true,
          loading: false,
          error: false,
          marker: state.changeMarker || null,
          recheckTimer: 0,
        }),
      }
      if (state.snapshot) populateFilters(state.snapshot)
      renderAll()
      void ensureFocusedSelection()
    } catch {
      state = {
        ...state,
        directory: Object.freeze({ ...state.directory, loading: false, error: true }),
      }
      if (state.snapshot) populateFilters(state.snapshot)
      renderAll()
    } finally {
      window.clearTimeout(timeout)
      if (force && scheduleRecheck) {
        const recheckTimer = window.setTimeout(() => void loadDirectory(true, false), 31_000)
        state = {
          ...state,
          directory: Object.freeze({ ...state.directory, recheckTimer }),
        }
      }
    }
  }

`
