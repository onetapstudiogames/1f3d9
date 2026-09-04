export const PART_06_LIVE_CAMERA_AND_POINTERS = `  function liveCameraViewport() {
    if (!nodes.liveViewport || !(liveCamera.scale > 0)) return null
    return Object.freeze({
      left: -liveCamera.offsetX / liveCamera.scale,
      top: -liveCamera.offsetY / liveCamera.scale,
      right: (nodes.liveViewport.clientWidth - liveCamera.offsetX) / liveCamera.scale,
      bottom: (nodes.liveViewport.clientHeight - liveCamera.offsetY) / liveCamera.scale,
    })
  }

  function liveDetailedPlotIds(plots, expandedGrounds = Object.freeze({})) {
    const viewport = liveCameraViewport()
    return new Set(viewport ? windowLiveVisiblePlotIds(
      plots, expandedGrounds, viewport, LIVE_PLOT_OVERSCAN,
    ) : [])
  }

  function livePlotHasFocusedDetail(node) {
    return node.dataset.liveFocusPlot === 'true' || node.dataset.liveRaised === 'true' ||
      Boolean(node.querySelector(
      '[data-live-focus-resident], [data-live-focus-partner], [data-live-focus-thing], ' +
      '[data-live-raised="true"]',
    ))
  }

  function syncLivePlotVisibility() {
    if (!nodes.liveViewport || !nodes.livePlates || !(liveCamera.scale > 0)) return
    const plots = [...nodes.livePlates.querySelectorAll('.live-plot')].flatMap(node => {
      const plot = {
        id: safeId(node.dataset.placeId),
        x: Number(node.dataset.livePlotX),
        y: Number(node.dataset.livePlotY),
        width: Number(node.dataset.livePlotWidth),
        height: Number(node.dataset.livePlotHeight),
      }
      return plot.id ? [plot] : []
    })
    const visibleIds = liveDetailedPlotIds(
      plots,
      livePlotDetailContext?.expandedGrounds || Object.freeze({}),
    )
    for (const node of nodes.livePlates.querySelectorAll('.live-plot')) {
      const placeId = safeId(node.dataset.placeId)
      const detailed = visibleIds.has(placeId) ||
        livePlotHasFocusedDetail(node)
      node.dataset.liveDetail = String(detailed)
      if (detailed && placeId && livePlotDetailContext) {
        const place = livePlotDetailContext.children.find(candidate => candidate.id === placeId)
        if (place) mountLivePlaceDetail(node, livePlotDetailContext, place)
      } else if (!detailed) {
        unmountLivePlaceDetail(node)
      }
    }
  }

  function commitLiveCamera() {
    liveCameraFrame = 0
    if (!nodes.liveStage) return
    const previousLabelMode = nodes.liveStage.dataset.liveLabelMode
    nodes.liveStage.style.transform = 'translate3d(' + String(liveCamera.offsetX) + 'px, ' +
      String(liveCamera.offsetY) + 'px, 0) scale(' + String(liveCamera.scale) + ')'
    nodes.liveStage.dataset.liveScale = String(liveCamera.scale)
    nodes.liveStage.dataset.liveOffsetX = String(liveCamera.offsetX)
    nodes.liveStage.dataset.liveOffsetY = String(liveCamera.offsetY)
    const labelMode = windowLiveResidentLabelMode(liveCamera.scale, LIVE_LABEL_READABLE_SCALE)
    nodes.liveStage.dataset.liveLabelMode = labelMode
    syncLivePlotVisibility()
    scheduleLiveResidentLabels(previousLabelMode !== labelMode)
  }

  function applyLiveCamera(next) {
    liveCamera = Object.freeze({ ...liveCamera, ...next })
    if (!nodes.liveStage || liveCameraFrame) return
    liveCameraFrame = window.requestAnimationFrame(commitLiveCamera)
  }

  function liveCameraForStageTarget(target, center = false) {
    if (!nodes.liveViewport || !target) return null
    const base = center
      ? windowLiveCenterCamera(
          nodes.liveViewport.clientWidth,
          nodes.liveViewport.clientHeight,
          target.x,
          target.y,
          LIVE_CAMERA_CENTER_SCALE,
          LIVE_CAMERA_MIN_SCALE,
          LIVE_CAMERA_MAX_SCALE,
        )
      : liveCamera
    if (!base) return null
    return windowLiveRevealCamera(
      nodes.liveViewport.clientWidth,
      nodes.liveViewport.clientHeight,
      target.x,
      target.y,
      Number(target.width) || 0,
      Number(target.height) || 0,
      base.scale,
      base.offsetX,
      base.offsetY,
      LIVE_CAMERA_SAFE_INSET,
    )
  }

  function revealLiveStageTarget(target, center = false) {
    const next = liveCameraForStageTarget(target, center)
    if (!next) return false
    applyLiveCamera({ ...next, panStart: null, pinchStart: null })
    return true
  }

  function liveStageTargetForElements(elements) {
    if (!nodes.liveViewport || !nodes.liveStage || !(liveCamera.scale > 0)) return null
    if (liveCameraFrame) {
      window.cancelAnimationFrame(liveCameraFrame)
      liveCameraFrame = 0
      commitLiveCamera()
    }
    const rects = [...elements].flatMap(node => {
      if (!(node instanceof Element) || node.closest('[hidden]')) return []
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? [rect] : []
    })
    if (!rects.length) return null
    const viewportRect = nodes.liveViewport.getBoundingClientRect()
    const left = Math.min(...rects.map(rect => rect.left))
    const right = Math.max(...rects.map(rect => rect.right))
    const top = Math.min(...rects.map(rect => rect.top))
    const bottom = Math.max(...rects.map(rect => rect.bottom))
    return Object.freeze({
      x: ((left + right) / 2 - viewportRect.left - liveCamera.offsetX) /
        liveCamera.scale,
      y: ((top + bottom) / 2 - viewportRect.top - liveCamera.offsetY) /
        liveCamera.scale,
      width: (right - left) / liveCamera.scale,
      height: (bottom - top) / liveCamera.scale,
    })
  }

  function revealLiveElements(elements, center = false) {
    const target = liveStageTargetForElements(elements)
    return target ? revealLiveStageTarget(target, center) : false
  }

  function liveDefaultCenterTarget(snapshot, focus, survey, renderContext = null) {
    const focusedResident = state.live.focusResident
      ? displayedResidents(snapshot).find(resident =>
          resident.handle === state.live.focusResident)
      : null
    if (focusedResident) {
      const focusedPoint = liveResidentReplayPoint(
        snapshot,
        focusedResident.current_place_id,
        focusedResident.handle,
        focus,
        liveChildren(snapshot, focus),
        renderContext,
      )
      if (focusedPoint) return focusedPoint
    }
    const hasDirectResident = displayedResidents(snapshot).some(resident =>
      resident.current_place_id === focus.id &&
      (!state.resident || resident.handle === state.resident))
    const firstChild = survey.plots[0] || null
    const proofRetry = state.live.proofScene && focus.id === LIVE_PROOF_ROOT_ID
      ? survey.plots.find(plot => plot.id === LIVE_PROOF_RETRY_ROOM_ID) || null
      : null
    if (firstChild && proofRetry) {
      return Object.freeze({
        x: (firstChild.x + firstChild.width / 2 +
          proofRetry.x + proofRetry.width / 2) / 2,
        y: (firstChild.y + firstChild.height / 2 +
          proofRetry.y + proofRetry.height / 2) / 2,
      })
    }
    if (!hasDirectResident && Number(focus.things) <= 0 && firstChild) {
      return Object.freeze({
        x: firstChild.x + firstChild.width / 2,
        y: firstChild.y + firstChild.height / 2,
      })
    }
    const ordinaryTarget = Object.freeze({
      x: Math.min(survey.width, LIVE_DIRECT_GROUND_WIDTH) / 2,
      y: Math.min(survey.height, WINDOW_LIVE_DIRECT_COMMONS_HEIGHT) / 2,
    })
    if (!firstChild || !nodes.liveViewport) return ordinaryTarget
    const ordinaryCamera = liveCameraForStageTarget(ordinaryTarget, true)
    if (!ordinaryCamera) return ordinaryTarget
    const ordinaryViewport = Object.freeze({
      left: -ordinaryCamera.offsetX / ordinaryCamera.scale,
      top: -ordinaryCamera.offsetY / ordinaryCamera.scale,
      right: (nodes.liveViewport.clientWidth - ordinaryCamera.offsetX) /
        ordinaryCamera.scale,
      bottom: (nodes.liveViewport.clientHeight - ordinaryCamera.offsetY) /
        ordinaryCamera.scale,
    })
    if (windowLiveVisiblePlotIds(
      survey.plots,
      survey.expandedGrounds,
      ordinaryViewport,
      LIVE_PLOT_OVERSCAN,
    ).length) return ordinaryTarget
    return Object.freeze({
      x: firstChild.x + firstChild.width / 2,
      y: firstChild.y + firstChild.height / 2,
      preservesChildDetail: true,
      childDetailPlaceId: firstChild.id,
    })
  }

  function liveChildDetailRevealTargets(target) {
    const placeId = safeId(target?.childDetailPlaceId)
    if (!target?.preservesChildDetail || !placeId || !nodes.livePlates) return []
    return [
      ...nodes.livePlates.querySelectorAll(
        '.live-plot[data-place-id="' + String(placeId) + '"] .live-plot-open',
      ),
      ...nodes.livePlates.querySelectorAll('.live-root-walkers .live-speech-bubble'),
    ]
  }

  function liveCenterTarget() {
    if (!nodes.liveViewport || !nodes.liveStage) return null
    const preferredKey = state.live.focusResident
      ? 'resident:' + state.live.focusResident
      : state.live.raisedItemKey
    const target = preferredKey
      ? nodes.livePlates?.querySelector('[data-live-item-key="' + CSS.escape(preferredKey) + '"]')
      : null
    if (target) {
      const viewportRect = nodes.liveViewport.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      if (targetRect.width > 0 && targetRect.height > 0) {
        return Object.freeze({
          x: (targetRect.left + targetRect.width / 2 - viewportRect.left -
            liveCamera.offsetX) / liveCamera.scale,
          y: (targetRect.top + targetRect.height / 2 - viewportRect.top -
            liveCamera.offsetY) / liveCamera.scale,
        })
      }
    }
    if (state.live.focusResident && state.snapshot) {
      const focus = liveFocusPlace(state.snapshot)
      const resident = displayedResidents(state.snapshot).find(candidate =>
        candidate.handle === state.live.focusResident)
      const renderContext = livePlotDetailContext?.snapshot === state.snapshot &&
        focus && livePlotDetailContext.focus.id === focus.id
        ? livePlotDetailContext
        : null
      if (focus && resident) {
        const point = liveResidentReplayPoint(
          state.snapshot,
          resident.current_place_id,
          resident.handle,
          focus,
          liveChildren(state.snapshot, focus),
          renderContext,
        )
        if (point) return point
      }
    }
    if (state.snapshot) {
      const focus = liveFocusPlace(state.snapshot)
      if (focus) {
        const renderContext = livePlotDetailContext?.snapshot === state.snapshot &&
          livePlotDetailContext.focus.id === focus.id
          ? livePlotDetailContext
          : null
        return liveDefaultCenterTarget(
          state.snapshot,
          focus,
          renderContext?.survey || liveStageSurvey(livePlaceRows(state.snapshot), focus.id),
          renderContext,
        )
      }
    }
    const width = Number(nodes.liveStage.dataset.liveStageWidth) || nodes.liveStage.offsetWidth
    const height = Number(nodes.liveStage.dataset.liveStageHeight) || nodes.liveStage.offsetHeight
    return Object.freeze({
      x: Math.min(width, LIVE_DIRECT_GROUND_WIDTH) / 2,
      y: Math.min(height, WINDOW_LIVE_DIRECT_COMMONS_HEIGHT) / 2,
    })
  }

  function centerLivePlate() {
    if (!nodes.liveViewport) return
    if (liveCameraFrame) {
      window.cancelAnimationFrame(liveCameraFrame)
      liveCameraFrame = 0
      commitLiveCamera()
    }
    const target = liveCenterTarget()
    if (!target) return
    const centered = liveCameraForStageTarget(target, true)
    if (!centered) return
    applyLiveCamera({ ...centered, panStart: null, pinchStart: null })
    if (liveCameraFrame) {
      window.cancelAnimationFrame(liveCameraFrame)
      liveCameraFrame = 0
      commitLiveCamera()
    }
    if (revealLiveElements(liveChildDetailRevealTargets(target)) && liveCameraFrame) {
      window.cancelAnimationFrame(liveCameraFrame)
      liveCameraFrame = 0
      commitLiveCamera()
    }
  }

  function renderLiveFullscreen(active) {
    const panel = document.getElementById('live-panel')
    if (!panel || !nodes.liveFullscreen) return
    if (active) panel.dataset.liveFullscreen = 'true'
    else delete panel.dataset.liveFullscreen
    nodes.liveFullscreen.setAttribute('aria-pressed', String(active))
    nodes.liveFullscreen.setAttribute('aria-label', active
      ? 'Exit full-screen Live'
      : 'Enter full-screen Live')
    nodes.liveFullscreen.textContent = active ? 'Exit full screen' : 'Full screen'
    if (active) window.requestAnimationFrame(centerLivePlate)
  }

  function enterLiveFullscreen() {
    if (document.getElementById('live-panel')?.dataset.liveFullscreen === 'true') return
    const nextHistory = { ...(window.history.state || {}), windowLiveFullscreen: true }
    window.history.pushState(nextHistory, '', window.location.href)
    liveFullscreenHistoryEntry = true
    renderLiveFullscreen(true)
  }

  function exitLiveFullscreen() {
    if (document.getElementById('live-panel')?.dataset.liveFullscreen !== 'true') return
    if (liveFullscreenHistoryEntry && window.history.state?.windowLiveFullscreen === true) {
      window.history.back()
      return
    }
    liveFullscreenHistoryEntry = false
    renderLiveFullscreen(false)
  }

  function syncLiveFullscreenFromHistory() {
    const active = window.history.state?.windowLiveFullscreen === true && state.view === 'live'
    liveFullscreenHistoryEntry = active
    renderLiveFullscreen(active)
  }

  function zoomLivePlateAt(clientX, clientY, requestedScale) {
    if (!nodes.liveViewport) return
    const scale = clampLiveScale(requestedScale)
    const rect = nodes.liveViewport.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const worldX = (x - liveCamera.offsetX) / liveCamera.scale
    const worldY = (y - liveCamera.offsetY) / liveCamera.scale
    applyLiveCamera({
      scale,
      offsetX: x - worldX * scale,
      offsetY: y - worldY * scale,
    })
  }

  function livePointerValues(pointers = livePointers) {
    return Object.values(pointers)
  }

  function livePinchStart(pointers) {
    const values = livePointerValues(pointers)
    if (values.length < 2 || !nodes.liveViewport) return null
    const [first, second] = values
    const midpointX = (first.x + second.x) / 2
    const midpointY = (first.y + second.y) / 2
    const rect = nodes.liveViewport.getBoundingClientRect()
    return Object.freeze({
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      scale: liveCamera.scale,
      worldX: (midpointX - rect.left - liveCamera.offsetX) / liveCamera.scale,
      worldY: (midpointY - rect.top - liveCamera.offsetY) / liveCamera.scale,
    })
  }

  function beginLivePointer(event) {
    if (!nodes.liveViewport) return
    livePointers = Object.freeze({
      ...livePointers,
      [String(event.pointerId)]: Object.freeze({
        id: event.pointerId, x: event.clientX, y: event.clientY,
      }),
    })
    const values = livePointerValues()
    if (values.length === 1) {
      liveCamera = Object.freeze({ ...liveCamera,
        panStart: Object.freeze({
          id: event.pointerId, x: event.clientX, y: event.clientY,
          offsetX: liveCamera.offsetX, offsetY: liveCamera.offsetY,
        }),
        pinchStart: null,
      })
    } else if (values.length === 2) {
      liveCamera = Object.freeze({ ...liveCamera, panStart: null, pinchStart: livePinchStart(livePointers) })
    }
    try { nodes.liveViewport.setPointerCapture(event.pointerId) } catch {}
  }

  function moveLivePointer(event) {
    const key = String(event.pointerId)
    if (!Object.hasOwn(livePointers, key) || !nodes.liveViewport) return
    livePointers = Object.freeze({
      ...livePointers,
      [key]: Object.freeze({ id: event.pointerId, x: event.clientX, y: event.clientY }),
    })
    const values = livePointerValues()
    if (values.length >= 2 && liveCamera.pinchStart) {
      const [first, second] = values
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y))
      const scale = clampLiveScale(liveCamera.pinchStart.scale *
        (distance / liveCamera.pinchStart.distance))
      const rect = nodes.liveViewport.getBoundingClientRect()
      const midpointX = (first.x + second.x) / 2 - rect.left
      const midpointY = (first.y + second.y) / 2 - rect.top
      applyLiveCamera({
        scale,
        offsetX: midpointX - liveCamera.pinchStart.worldX * scale,
        offsetY: midpointY - liveCamera.pinchStart.worldY * scale,
      })
      return
    }
    const start = liveCamera.panStart
    if (values.length === 1 && start?.id === event.pointerId) {
      applyLiveCamera({
        offsetX: start.offsetX + event.clientX - start.x,
        offsetY: start.offsetY + event.clientY - start.y,
      })
    }
  }

  function endLivePointer(event) {
    const remaining = Object.fromEntries(Object.entries(livePointers)
      .filter(([key]) => key !== String(event.pointerId)))
    livePointers = Object.freeze(remaining)
    const values = livePointerValues()
    liveCamera = Object.freeze({
      ...liveCamera,
      pinchStart: values.length >= 2 ? livePinchStart(livePointers) : null,
      panStart: values.length === 1 ? Object.freeze({
        id: values[0].id, x: values[0].x, y: values[0].y,
        offsetX: liveCamera.offsetX, offsetY: liveCamera.offsetY,
      }) : null,
    })
  }

`
