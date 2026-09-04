export const PART_14_LOCATION_AND_NAVIGATION = `  function readLocationState() {
    const legacyHash = window.location.hash.slice(1)
    const params = new URLSearchParams(legacyHash || window.location.search)
    const parts = window.location.pathname.split('/').filter(Boolean)
    const pathKind = parts[0] === 'window' ? parts[1] || null : null
    const pathId = safeId(parts[2])
    const pathView = legacyHash
      ? null
      : VIEWS.includes(pathKind) ? pathKind
        : pathKind === 'thing' || pathKind === 'note' ? 'map' : null
    const view = legacyHash ? params.get('view') : pathView
    const resident = safeHandle(params.get('resident'))
    const mode = safeArchiveChoice(params.get('mode'), ['words', 'phrase'], 'words')
    const type = safeArchiveChoice(params.get('type'), ['all', 'note', 'thing'], 'all')
    const archiveQuery = validateWindowArchiveQuery(params.get('q') || '', mode)
    const query = archiveQuery.ok ? archiveQuery.value : ''
    const sharedDirectorySearch = validateWindowDirectorySearch(params.get('find') || '')
    const directorySearch = sharedDirectorySearch.ok ? sharedDirectorySearch.value : ''
    const sleeperPlaceIds = parseWindowSleeperPlaceIds(params.get('sleepers'))
    const archiveChanged = query !== state.archive.query || mode !== state.archive.mode ||
      type !== state.archive.type
    const selectedView = VIEWS.includes(view) ? view : 'map'
    const gazetteIssueId = selectedView === 'gazette' ? safeId(params.get('issue')) : null
    const gazetteChanged = gazetteIssueId !== state.gazetteIssueId
    const detail = !legacyHash && pathId && ['thing', 'note'].includes(pathKind)
      ? Object.freeze({ kind: pathKind, id: pathId })
      : null
    const pathPlaceId = pathKind === 'place' ? pathId : null
    return {
      view: selectedView,
      placeId: pathPlaceId || safeId(params.get('place')),
      resident,
      conversationContext: Boolean(resident && params.get('context') === 'place'),
      directorySearch,
      directorySearchIndex: directorySearch ? 0 : -1,
      sleeperPlaceIds,
      archive: archiveChanged
        ? {
            ...state.archive,
            query,
            mode,
            type,
            results: [],
            totalItems: 0,
            totalTextBytes: 0,
            nextBefore: null,
            hasMore: false,
            loading: false,
            initialized: false,
            error: null,
          }
        : state.archive,
      gazette: gazetteChanged
        ? {
            ...state.gazette,
            issue: null,
            entries: [],
            nextAfterOrdinal: null,
            hasMoreEntries: false,
            detailBudgetCut: null,
            detailLoading: false,
            detailInitialized: false,
            detailError: null,
          }
        : state.gazette,
      gazetteIssueId,
      detail,
    }
  }

  function viewShareState() {
    return Object.freeze({
      view: state.view,
      placeId: state.placeId,
      resident: state.resident,
      conversationContext: state.conversationContext,
      directorySearch: state.directorySearch,
      sleeperPlaceIds: state.sleeperPlaceIds,
      archive: Object.freeze({
        query: state.archive.query,
        mode: state.archive.mode,
        type: state.archive.type,
      }),
      gazetteIssueId: state.gazetteIssueId,
      detail: state.detail,
    })
  }

  function writeLocation(push, entryState = null) {
    const path = windowSharePath(viewShareState())
    if (!path) {
      resetShareFeedback()
      return false
    }
    const current = window.location.pathname + window.location.search
    if (current === path && !window.location.hash) return true
    resetShareFeedback()
    if (push) history.pushState(entryState, '', path)
    else history.replaceState(entryState, '', path)
    return true
  }

  // Deliberate navigation — tabs, choosing a place or resident, filters —
  // creates a real back/forward entry. Background refresh never touches
  // history because renderAll only replaces when the hash is unchanged.
  // Arrow-key roving between tabs updates the address without pushing, so
  // walking the tab list never floods the back button.
  let rovingTabActivation = false
  function navigate(next) {
    const previousView = state.view
    const nextView = Object.hasOwn(next, 'view') ? next.view : state.view
    const nextResident = Object.hasOwn(next, 'resident') ? next.resident : state.resident
    const clearsLiveFocus = nextView === 'live' && Boolean(nextResident)
    const openingDetail = Boolean(next?.detail && (
      state.detail?.kind !== next.detail.kind || state.detail?.id !== next.detail.id
    ))
    if (openingDetail || (Object.hasOwn(next, 'detail') && next.detail === null)) {
      detailRequestRevision += 1
      detailDrawingRequestRevision += 1
      detailDrawingHistoryRequestRevision += 1
    }
    resetShareFeedback()
    const leavesReplayPlate = previousView === 'live' && (
      (Object.hasOwn(next, 'view') && next.view !== 'live') ||
      (Object.hasOwn(next, 'placeId') && next.placeId !== state.placeId) ||
      (Object.hasOwn(next, 'resident') && next.resident !== state.resident)
    )
    if (leavesReplayPlate && liveReplayHeldKeys().size) settleLiveReplays()
    if (clearsLiveFocus && state.live.focusResident) storeLiveFocusResident(null)
    state = {
      ...state,
      ...next,
      live: clearsLiveFocus ? { ...state.live, focusResident: null } : state.live,
    }
    writeLocation(!rovingTabActivation, openingDetail ? { windowDetailEntry: true } : null)
    renderAll()
    void ensureFocusedSelection()
    void ensureDetail()
    if (state.view !== previousView) {
      scheduleRefresh(state.view === 'live' && !document.hidden ? 0 : BASE_REFRESH_MS)
    }
    loadSharedGazette()
  }

  function closeDetail() {
    if (!state.detail) return
    detailRequestRevision += 1
    detailDrawingRequestRevision += 1
    detailDrawingHistoryRequestRevision += 1
    resetShareFeedback()
    if (nodes.detail?.open) nodes.detail.close()
    const historyBackClosesDetail = history.state?.windowDetailEntry === true
    state = { ...state, detail: null }
    if (historyBackClosesDetail) {
      renderDetail()
      void ensureFocusedSelection()
      history.back()
      return
    }
    writeLocation(false)
    renderAll()
    void ensureFocusedSelection()
  }

  function syncArchiveControls() {
    if (nodes.archiveQuery) nodes.archiveQuery.value = state.archive.query
    if (nodes.archiveMode) nodes.archiveMode.value = state.archive.mode
    if (nodes.archiveType) nodes.archiveType.value = state.archive.type
  }

  function loadSharedArchiveQuestion() {
    if (
      state.view === 'archive' && state.archive.query &&
      !state.archive.initialized && !state.archive.loading
    ) void loadArchive(true, true)
  }

`
