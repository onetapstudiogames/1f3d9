export const PART_27_LIVE_RENDER = `  function renderLive(snapshot) {
    resetPortraitImages()
    if (!nodes.livePlates || !nodes.liveStage) return
    livePlotDetailContext = null
    if (nodes.liveMapCaption) nodes.liveMapCaption.hidden = true
    const active = document.activeElement
    const focusKey = active?.closest?.('#live-panel') && active.dataset
      ? active.dataset.focusKey || null
      : null
    const residentCensusComplete = !state.residentPaging.loading &&
      !state.residentPaging.hasMore && !state.residentPaging.error
    if (state.live.focusResident && state.directory.loaded && residentCensusComplete &&
        !state.directory.residents.some(resident =>
          resident.handle === state.live.focusResident) &&
        !displayedResidents(snapshot).some(resident =>
          resident.handle === state.live.focusResident)) {
      storeLiveFocusResident(null)
      state = { ...state, live: { ...state.live, focusResident: null } }
    }
    renderLiveFocusStatus()
    if (nodes.livePause) {
      nodes.livePause.setAttribute('aria-pressed', String(state.live.paused))
      nodes.livePause.textContent = state.live.paused ? 'Resume walks' : 'Pause walks'
    }
    const selectedIssue = selectionIssue(snapshot, true)
    const issue = selectedIssue?.kind === 'place' &&
      liveSurveyCoversPlace(snapshot, Number(selectedIssue.value))
      ? null
      : selectedIssue
    if (issue) {
      clearLiveScopeSurfaces('Waiting for a valid current plate…')
      renderSelectionIssue(nodes.livePlates, issue)
      renderLiveHistoryStatus()
      scheduleLiveClock()
      restoreFocus(focusKey, null, null)
      return
    }
    if (!state.directory.loaded) {
      clearLiveScopeSurfaces('Waiting for the fixed public survey…')
      const message = element('div', state.directory.error ? 'error-row' : 'loading-row')
      message.append(element('p', '', state.directory.error
        ? 'The complete public place list could not be read, so this viewer will not guess where fixed plots belong.'
        : 'Reading the complete public place list before fixing every plot to its ground…'))
      if (state.directory.error) {
        const retry = element('button', 'selection-retry', 'Retry the fixed survey')
        retry.type = 'button'
        retry.dataset.focusKey = 'live-directory-retry'
        retry.addEventListener('click', () => void loadDirectory(true))
        message.append(retry)
      }
      nodes.livePlates.replaceChildren(message)
      renderLiveHistoryStatus()
      scheduleLiveClock()
      restoreFocus(focusKey, null, null)
      return
    }
    const residentPage = state.residentPaging
    if (residentPage.loading || residentPage.hasMore || residentPage.error ||
        residentPage.automaticPaused) {
      renderLivePopulationGate(
        residentPage.automaticPaused
          ? 'Automatic census reading pauses after 1,600 public residents. Continue the exact census to read the next pages; this viewer will not guess while pages remain.'
          : residentPage.error
          ? 'The complete public resident census could not be read, so this viewer will not print a guessed crowd count.'
          : 'Reading the complete public resident census before printing exact crowd counts…',
        residentPage.automaticPaused
          ? 'Continue the exact resident census'
          : 'Retry the complete resident census',
        residentPage.error || residentPage.automaticPaused
          ? () => void loadResidents()
          : null,
      )
      if (!residentPage.loading && residentPage.hasMore && !residentPage.error &&
          !residentPage.automaticPaused && !document.hidden) {
        window.queueMicrotask(() => {
          if (state.view === 'live' && !document.hidden) void loadResidents(true)
        })
      }
      restoreFocus(focusKey, null, null)
      return
    }
    const focus = liveFocusPlace(snapshot)
    if (!focus) {
      clearLiveScopeSurfaces('No public plate is available.')
      renderEmpty(nodes.livePlates, 'empty-row', 'No public plate is available.')
      renderLiveHistoryStatus()
      scheduleLiveClock()
      restoreFocus(focusKey, null, null)
      return
    }
    if (focus.quiet) {
      renderLiveQuietPlate(snapshot, focus)
      renderLiveNotesPanel(snapshot)
      renderLiveHistoryStatus()
      scheduleLiveClock()
      restoreFocus(focusKey, null, null)
      return
    }
    const thingFilters = liveThingFilters(focus.id)
    const thingsPage = historyEntry('things', thingFilters)
    const children = liveChildren(snapshot, focus)
    const survey = liveStageSurvey(livePlaceRows(snapshot), focus.id)
    const renderContextBase = liveCreateRenderContext(snapshot, focus, children, survey)
    const records = visibleLiveRecords(snapshot, focus, children, renderContextBase)
    const interactionThings = liveFocusInteractionThings(snapshot, focus, records)
    const bubbles = liveSpeechBubbles(records)
    const directResidents = displayedResidents(snapshot).filter(resident =>
      resident.current_place_id === focus.id &&
      (!state.resident || resident.handle === state.resident))
    const renderContext = Object.freeze({
      ...renderContextBase,
      records,
      interactionThings,
      bubbles,
    })
    livePlotDetailContext = renderContext
    const stageId = String(focus.id)
    const stageChanged = liveCamera.stageId !== stageId
    let defaultCenterTarget = null
    if (stageChanged && nodes.liveViewport) {
      defaultCenterTarget = liveDefaultCenterTarget(snapshot, focus, survey, renderContext)
      const centered = liveCameraForStageTarget(defaultCenterTarget, true)
      if (centered) {
        liveCamera = Object.freeze({
          ...liveCamera,
          ...centered,
          stageId,
          panStart: null,
          pinchStart: null,
        })
      }
    }
    const detailedPlotIds = liveDetailedPlotIds(survey.plots, survey.expandedGrounds)
    const focusedPlotIds = liveFocusedPlotIds(
      snapshot, focus, children, records, interactionThings, renderContext)
    renderLiveBreadcrumbs(snapshot, focus)

    nodes.liveStage.style.setProperty('--live-stage-width', String(survey.width) + 'px')
    nodes.liveStage.style.setProperty('--live-stage-height', String(survey.height) + 'px')
    nodes.liveStage.dataset.liveStageWidth = String(survey.width)
    nodes.liveStage.dataset.liveStageHeight = String(survey.height)
    nodes.liveStage.setAttribute('aria-label', 'Live surveyed plate for ' + focus.name)

    if (nodes.liveMapCaption) {
      nodes.liveMapCaption.hidden = false
      nodes.liveMapCaption.replaceChildren(
        element('p', 'block-number', 'LIVE PLATE / PLACE #' + String(focus.id)),
        element('h3', 'live-plate-title', focus.name),
        element('p', 'live-plate-legend',
          'footsteps = detailed movement · a followed resident keeps a fading route · brick pulse on a thing = recorded use · walkers move above fixed plots · +N more = an exact hidden crowd · click a resident to focus'),
        openDrawingDetailButton(
          'place',
          focus.id,
          focus.name,
          'live-map-caption-drawing-detail drawing-detail-open',
        ),
      )
      const rootNotesControl = liveNotesControl(snapshot, focus, 'live-root-notes')
      if (rootNotesControl) nodes.liveMapCaption.append(rootNotesControl)
      if (state.live.proofScene) {
        nodes.liveMapCaption.append(element(
          'p', 'live-proof-frame-time',
          'crowd proof · 152 residents · 64 movers · frame time · sampling…'))
        scheduleLiveProofFrameReadout()
      }
    }

    if (nodes.liveWorldGround) {
      const tiled = liveTiledDrawing(
        focus,
        'live-world-ground-tiles',
        Object.freeze({ width: survey.width, height: survey.height }),
        null,
        56,
      )
      nodes.liveWorldGround.replaceChildren(tiled)
      nodes.liveWorldGround.title = focus.name + ' authored ground'
    }

    const plateParts = []
    for (const plot of survey.plots) {
      const place = children.find(candidate => candidate.id === plot.id)
      if (place) {
        plateParts.push(livePlacePlot(
          renderContext,
          place,
          plot,
          detailedPlotIds.has(plot.id),
          focusedPlotIds.includes(plot.id),
        ))
      }
    }
    const proofLoad = liveProofLoadNode(focus, survey)
    if (proofLoad) plateParts.push(proofLoad)
    if (directResidents.length) {
      plateParts.push(livePortraitGrid(
        directResidents,
        'Residents standing directly in ' + focus.name,
        bubbles,
        focus.id,
        livePinnedResidentIds(snapshot, records, focus.id),
        'live-walker-layer live-root-walkers',
        renderContext,
      ))
    }
    const focusShelf = liveThingShelf(
      snapshot, focus, records, focus.id, false, interactionThings, renderContext)
    if (focusShelf) {
      focusShelf.classList.add('live-focus-thing-shelf', 'live-root-thing-shelf')
      plateParts.push(focusShelf)
    }
    if (!children.length && !directResidents.length && !focusShelf) {
      plateParts.push(element('p', 'live-room-empty live-stage-empty',
        directResidents.length
          ? 'No smaller public places are drawn inside this room.'
          : 'Nobody is here right now. The room keeps its things.'))
    }
    liveTraceRenderContext = Object.freeze({
      snapshot, focus, children, records, bubbles, survey, renderContext,
    })
    plateParts.push(renderLiveTraceLayer(
      snapshot, focus, children, records, bubbles, survey, renderContext))
    nodes.livePlates.replaceChildren(...plateParts)
    syncLiveItemPopoverAnchor()
    scheduleLiveResidentLabels(true)
    scheduleLiveTrailExpiry()

    applyLiveCamera({ stageId })
    if (stageChanged) {
      const preferredKey = state.live.focusResident
        ? 'resident:' + state.live.focusResident
        : state.live.raisedItemKey
      const preferredTargets = preferredKey
        ? [...nodes.livePlates.querySelectorAll(
            '[data-live-item-key="' + CSS.escape(preferredKey) + '"]')]
        : []
      const firstPaintTargets = state.live.proofScene && state.live.proofFailure
        ? [...nodes.livePlates.querySelectorAll('[data-focus-key="live-proof-retry"]')]
        : preferredTargets.length
          ? preferredTargets
          : defaultCenterTarget?.preservesChildDetail
            ? liveChildDetailRevealTargets(defaultCenterTarget)
            : liveRevealTargetsForPlace(focus.id)
      revealLiveElements(firstPaintTargets)
    }
    renderLiveNotesPanel(snapshot)
    renderLiveRoster(snapshot, focus, records, interactionThings)
    renderLiveHistoryStatus()
    scheduleLiveClock()
    restoreFocus(focusKey, null, null)
    flushLiveFocusRestore()
    if (!state.live.proofScene && !state.live.openingLoaded && !state.live.openingLoading) {
      void loadLiveOpeningHistory(snapshot, Boolean(
        state.live.openingNextBeforeId || state.live.openingEvents.length))
    }
    if (!state.live.proofScene && !thingsPage.loading && !thingsPage.initialized && !thingsPage.error &&
        !document.hidden) {
      window.queueMicrotask(() => {
        const latest = historyEntry('things', thingFilters)
        if (state.view === 'live' && !document.hidden && !latest.loading &&
            !latest.initialized && !latest.error) {
          void loadHistory('things', thingFilters)
        }
      })
    }
    if (Object.keys(state.live.replayQueues).length) {
      window.queueMicrotask(startLiveReplays)
    }
  }

`
