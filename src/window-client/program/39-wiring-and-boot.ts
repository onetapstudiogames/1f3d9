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
    const previousReplayScope = [state.view, state.placeId, state.resident].join(':')
    const nextLocationState = readLocationState()
    const clearsLiveFocus = nextLocationState.view === 'live' &&
      Boolean(nextLocationState.resident)
    const nextReplayScope = [
      nextLocationState.view, nextLocationState.placeId, nextLocationState.resident,
    ].join(':')
    if (previousReplayScope !== nextReplayScope && liveReplayHeldKeys().size) {
      settleLiveReplays()
    }
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
    if (clearsLiveFocus && state.live.focusResident) storeLiveFocusResident(null)
    state = {
      ...state,
      ...nextLocationState,
      live: clearsLiveFocus ? { ...state.live, focusResident: null } : state.live,
    }
    syncLiveFullscreenFromHistory()
    syncArchiveControls()
    renderAll()
    void ensureFocusedSelection()
    void ensureDetail()
    loadSharedArchiveQuestion()
    if (state.view !== previousView) {
      scheduleRefresh(state.view === 'live' && !document.hidden ? 0 : BASE_REFRESH_MS)
    }
    loadSharedGazette()
  }
  nodes.liveViewport?.addEventListener('wheel', event => {
    event.preventDefault()
    const factor = Math.exp(-event.deltaY * 0.0015)
    zoomLivePlateAt(event.clientX, event.clientY, liveCamera.scale * factor)
  }, { passive: false })
  nodes.liveViewport?.addEventListener('keydown', event => {
    if (event.target !== nodes.liveViewport) return
    const pan = 48
    if (event.key === '0') {
      event.preventDefault()
      centerLivePlate()
      return
    }
    if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault()
      const rect = nodes.liveViewport.getBoundingClientRect()
      const factor = event.key === '-' ? 1 / 1.2 : 1.2
      zoomLivePlateAt(rect.left + rect.width / 2, rect.top + rect.height / 2,
        liveCamera.scale * factor)
      return
    }
    const offset = {
      ArrowLeft: [pan, 0], ArrowRight: [-pan, 0],
      ArrowUp: [0, pan], ArrowDown: [0, -pan],
    }[event.key]
    if (!offset) return
    event.preventDefault()
    applyLiveCamera({
      offsetX: liveCamera.offsetX + offset[0],
      offsetY: liveCamera.offsetY + offset[1],
    })
  })
  nodes.liveViewport?.addEventListener('pointerdown', event => {
    if (event.target instanceof Element &&
        event.target.closest('button, a, input, select, textarea, [role="button"]')) return
    event.preventDefault()
    nodes.liveViewport.dataset.liveDragging = 'true'
    beginLivePointer(event)
  })
  nodes.liveViewport?.addEventListener('pointermove', event => {
    if (!Object.hasOwn(livePointers, String(event.pointerId))) return
    event.preventDefault()
    moveLivePointer(event)
  })
  for (const eventName of ['pointerup', 'pointercancel']) {
    nodes.liveViewport?.addEventListener(eventName, event => {
      endLivePointer(event)
      if (!livePointerValues().length && nodes.liveViewport) {
        nodes.liveViewport.dataset.liveDragging = 'false'
      }
    })
  }
  for (const eventName of ['pointerover', 'pointerout', 'focusin', 'focusout']) {
    nodes.livePlates?.addEventListener(eventName, event => {
      if (event.target?.closest?.('.live-walker, .live-replay-portrait')) {
        scheduleLiveResidentLabels(true)
      }
    })
  }
  nodes.liveZoomIn?.addEventListener('click', () => {
    const rect = nodes.liveViewport?.getBoundingClientRect()
    if (rect) zoomLivePlateAt(rect.left + rect.width / 2, rect.top + rect.height / 2,
      liveCamera.scale * 1.2)
  })
  nodes.liveZoomOut?.addEventListener('click', () => {
    const rect = nodes.liveViewport?.getBoundingClientRect()
    if (rect) zoomLivePlateAt(rect.left + rect.width / 2, rect.top + rect.height / 2,
      liveCamera.scale / 1.2)
  })
  nodes.liveCenter?.addEventListener('click', centerLivePlate)
  nodes.liveProof?.addEventListener('click', startLiveProofScene)
  nodes.liveFullscreen?.addEventListener('click', () => {
    if (document.getElementById('live-panel')?.dataset.liveFullscreen === 'true') {
      exitLiveFullscreen()
    } else {
      enterLiveFullscreen()
    }
  })
  nodes.livePause?.addEventListener('click', () => {
    const paused = !state.live.paused
    state = { ...state, live: { ...state.live, paused } }
    nodes.livePause.setAttribute('aria-pressed', String(paused))
    nodes.livePause.textContent = paused ? 'Resume walks' : 'Pause walks'
    if (!paused) window.queueMicrotask(startLiveReplays)
  })
  window.addEventListener('hashchange', syncStateFromLocation)
  window.addEventListener('popstate', syncStateFromLocation)
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' ||
        document.getElementById('live-panel')?.dataset.liveFullscreen !== 'true') return
    event.preventDefault()
    exitLiveFullscreen()
  })
  window.addEventListener('resize', () => {
    scheduleBodyDisclosureSync()
    if (state.view === 'live' && state.snapshot) {
      renderLive(state.snapshot)
    }
  })
  document.addEventListener('visibilitychange', () => {
    const hidden = document.hidden
    if (hidden !== liveWasHidden) {
      liveWasHidden = hidden
      liveVisibilityRevision += 1
    }
    window.clearTimeout(state.pollTimer)
    if (hidden) {
      if (liveReplayHeldKeys().size) settleLiveReplays()
      state = { ...state, pollTimer: 0, live: {
        ...state.live,
        nextReadAt: null,
        openingReplaySuppressed: true,
        suppressReplayOnNextRead: true,
      } }
      renderLiveClock()
    } else {
      drainLiveNoteQueue()
      if (state.view === 'live' && state.snapshot) {
        renderLive(state.snapshot)
        if (!state.live.openingLoaded && !state.live.openingLoading) {
          void loadLiveOpeningHistory(state.snapshot, Boolean(
            state.live.openingNextBeforeId || state.live.openingEvents.length))
        }
      }
      void refreshCity()
    }
  })
  LIVE_MOTION_PREFERENCE.addEventListener?.('change', () => {
    if (LIVE_MOTION_PREFERENCE.matches) settleLiveReplays()
    if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
  })

  const initialLocationState = readLocationState()
  let initialFocusResident = readLiveFocusResident()
  if (initialLocationState.view === 'live' && initialLocationState.resident) {
    if (initialFocusResident) storeLiveFocusResident(null)
    initialFocusResident = null
  }
  state = {
    ...state,
    ...initialLocationState,
    live: { ...state.live, focusResident: initialFocusResident },
  }
  syncArchiveControls()
  renderView()
  writeLocation(false)
  syncLiveFullscreenFromHistory()
  void ensureDetail()
  loadSharedGazette()
  void loadDirectory(false)
  void refreshCity()
})()
`
