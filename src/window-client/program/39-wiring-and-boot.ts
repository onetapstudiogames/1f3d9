export const PART_39_WIRING_AND_BOOT = `  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view
      if (!VIEWS.includes(view)) return
      const openingGazette = view === 'gazette'
      let placeId = state.placeId
      if (view === 'place' && !state.resident && !state.placeId &&
        !selectedPlace(state.snapshot || { residents: [], flatPlaces: [] })) {
        placeId = state.snapshot?.flatPlaces[0]?.id || null
      }
      if (!openingGazette && state.view !== 'gazette') {
        navigate({ view, placeId, detail: null })
        return
      }
      if (openingGazette && nodes.directorySearch) nodes.directorySearch.value = ''
      navigate({
        view,
        placeId: openingGazette ? null : placeId,
        resident: openingGazette ? null : state.resident,
        conversationContext: openingGazette ? false : state.conversationContext,
        directorySearch: openingGazette ? '' : state.directorySearch,
        directorySearchIndex: openingGazette ? -1 : state.directorySearchIndex,
        sleeperPlaceIds: openingGazette ? [] : state.sleeperPlaceIds,
        gazetteIssueId: openingGazette
          ? state.view === 'gazette' ? state.gazetteIssueId : null
          : null,
        detail: null,
      })
    })
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const current = tabs.indexOf(tab)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
        (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      tabs[index]?.focus()
      rovingTabActivation = true
      try {
        tabs[index]?.click()
      } finally {
        rovingTabActivation = false
      }
    })
  }

  for (const button of viewShareButtons) {
    button.addEventListener('click', () => void copyCurrentShareLink(button))
  }
  detailShareButton?.addEventListener('click', () => void copyCurrentShareLink(detailShareButton))
  nodes.detailClose?.addEventListener('click', closeDetail)
  nodes.detail?.addEventListener('click', event => {
    if (event.target === nodes.detail) closeDetail()
  })
  nodes.detail?.addEventListener('cancel', event => {
    event.preventDefault()
    closeDetail()
  })

  nodes.directorySearch?.addEventListener('input', () => {
    state = {
      ...state,
      directorySearch: String(nodes.directorySearch.value || '').slice(0, 100),
      directorySearchIndex: 0,
    }
    writeLocation(false)
    if (state.snapshot) renderDirectorySearch(state.snapshot, true)
    scheduleThingLookup(state.directorySearch)
  })
  nodes.directorySearch?.addEventListener('focus', () => {
    if (state.snapshot && state.directorySearch) renderDirectorySearch(state.snapshot, true)
  })
  nodes.directorySearch?.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (document.activeElement !== nodes.directorySearch) closeDirectorySearchResults()
    }, 0)
  })
  nodes.directorySearch?.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.directorySearch) {
      event.preventDefault()
      nodes.directorySearch.value = ''
      state = { ...state, directorySearch: '', directorySearchIndex: -1 }
      scheduleThingLookup('', 0)
      writeLocation(false)
      if (state.snapshot) renderDirectorySearch(state.snapshot, false)
      return
    }
    if (!state.snapshot || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
    const results = directorySearchRows(state.snapshot)
    if (!results.length) return
    event.preventDefault()
    if (event.key === 'Enter') {
      selectDirectorySearchResult(Math.max(0, state.directorySearchIndex))
      return
    }
    const offset = event.key === 'ArrowDown' ? 1 : -1
    const current = Math.max(0, state.directorySearchIndex)
    state = {
      ...state,
      directorySearchIndex: (current + offset + results.length) % results.length,
    }
    renderDirectorySearch(state.snapshot, true)
  })
  nodes.placeFilter?.addEventListener('change', () => {
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      placeId: safeId(nodes.placeFilter.value),
      directorySearch: '',
      directorySearchIndex: -1,
      detail: null,
    })
    if (state.snapshot) populateFilters(state.snapshot)
  })
  nodes.residentFilter?.addEventListener('change', () => {
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      resident: safeHandle(nodes.residentFilter.value),
      conversationContext: false,
      directorySearch: '',
      directorySearchIndex: -1,
      detail: null,
    })
  })
  nodes.archiveSearch?.addEventListener('click', () => void loadArchive(true))
  nodes.archiveQuery?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void loadArchive(true)
  })
  function syncStateFromLocation() {
    const previousView = state.view
    const nextLocationState = readLocationState()
    if (nextLocationState.archive !== state.archive) archiveRequestRevision += 1
    if (
      nextLocationState.gazetteIssueId !== state.gazetteIssueId ||
      nextLocationState.view !== state.view
    ) gazetteDetailRequestRevision += 1
    if (
      nextLocationState.detail?.kind !== state.detail?.kind ||
      nextLocationState.detail?.id !== state.detail?.id
    ) {
      detailRequestRevision += 1
      detailDrawingRequestRevision += 1
      detailDrawingHistoryRequestRevision += 1
    }
    resetShareFeedback()
    state = { ...state, ...nextLocationState }
    syncArchiveControls()
    renderAll()
    void ensureFocusedSelection()
    void ensureDetail()
    loadSharedArchiveQuestion()
    if (state.view !== previousView) {
      scheduleRefresh(BASE_REFRESH_MS)
    }
    loadSharedGazette()
  }
  window.addEventListener('hashchange', syncStateFromLocation)
  window.addEventListener('popstate', syncStateFromLocation)
  window.addEventListener('resize', scheduleBodyDisclosureSync)
  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(state.pollTimer)
    if (document.hidden) state = { ...state, pollTimer: 0 }
    else void refreshCity()
  })

  const initialLocationState = readLocationState()
  state = { ...state, ...initialLocationState }
  syncArchiveControls()
  renderView()
  writeLocation(false)
  void ensureDetail()
  loadSharedGazette()
  void loadDirectory(false)
  void refreshCity()
})()
`
