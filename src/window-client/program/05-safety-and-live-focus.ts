import { WINDOW_CLIENT_SAFETY_JS } from '../../window-client-safety.ts'

export const PART_05_SAFETY_AND_LIVE_FOCUS = `${WINDOW_CLIENT_SAFETY_JS}

  function readLiveFocusResident() {
    try {
      const value = localStorage.getItem(LIVE_FOCUS_STORAGE_KEY)
      if (typeof value === 'string' && SAFE_HANDLE.test(value)) return value
      if (value !== null) localStorage.removeItem(LIVE_FOCUS_STORAGE_KEY)
    } catch {
      // Focus is optional per-viewer presentation; storage refusal leaves it unset.
    }
    return null
  }

  function storeLiveFocusResident(handle) {
    try {
      if (handle) localStorage.setItem(LIVE_FOCUS_STORAGE_KEY, handle)
      else localStorage.removeItem(LIVE_FOCUS_STORAGE_KEY)
    } catch {
      // The in-memory focus still works for this page when storage is unavailable.
    }
  }

  function setLiveFocusResident(handle) {
    const next = typeof handle === 'string' && SAFE_HANDLE.test(handle) ? handle : null
    storeLiveFocusResident(next)
    state = { ...state, live: { ...state.live, focusResident: next } }
    if (next && state.view === 'live' && state.resident) {
      navigate({ resident: null, conversationContext: false })
      return
    }
    if (state.view === 'live' && state.snapshot) markLiveDirty()
  }

  function toggleLiveFocusResident(handle) {
    setLiveFocusResident(state.live.focusResident === handle ? null : handle)
  }

  function setLiveRaisedItem(key) {
    state = { ...state, live: { ...state.live, raisedItemKey: key } }
    for (const node of nodes.livePlates?.querySelectorAll('[data-live-item-key]') || []) {
      if (node.dataset.liveItemKey === key) node.setAttribute('data-live-raised', 'true')
      else node.removeAttribute('data-live-raised')
    }
    syncLivePlotVisibility()
    scheduleLiveResidentLabels(true)
  }

  function bindLiveActivation(control, raiseTarget, key, open) {
    control.addEventListener('pointerdown', event => {
      control.dataset.livePointerType = event.pointerType || ''
    })
    control.addEventListener('pointercancel', () => {
      delete control.dataset.livePointerType
    })
    control.addEventListener('click', event => {
      const pointerType = event.pointerType || control.dataset.livePointerType || ''
      delete control.dataset.livePointerType
      if (windowLiveTouchActivation(pointerType, state.live.raisedItemKey, key) ===
          'bring-forward') {
        event.preventDefault()
        event.stopPropagation()
        raiseTarget.dataset.liveItemKey = key
        setLiveRaisedItem(key)
        control.focus({ preventScroll: true })
        return
      }
      setLiveRaisedItem(key)
      if (open) {
        event.preventDefault()
        open()
      }
    })
  }

  function requestLiveFocusRestore(
    focusKey,
    fallbackId = 'live-plates',
    revealPlaceId = null,
  ) {
    livePendingRevealPlaceId = safeId(revealPlaceId)
    livePendingRevealTarget = liveStageTargetForElements(
      document.querySelectorAll('[data-focus-key="' + CSS.escape(focusKey) + '"]'),
    )
    state = {
      ...state,
      live: {
        ...state.live,
        focusRestoreKey: focusKey,
        focusRestoreFallbackId: fallbackId,
      },
    }
  }

  function liveRevealTargetsForPlace(placeId) {
    const safePlaceId = safeId(placeId)
    if (!safePlaceId || !nodes.livePlates) return []
    return [...nodes.livePlates.querySelectorAll(
      '[data-live-overflow-place-id="' + String(safePlaceId) + '"]',
    )]
  }

  function flushLiveFocusRestore() {
    const focusKey = state.live.focusRestoreKey
    const fallbackId = state.live.focusRestoreFallbackId
    if (!focusKey) return
    const revealPlaceId = livePendingRevealPlaceId
    const revealTarget = livePendingRevealTarget
    livePendingRevealPlaceId = null
    livePendingRevealTarget = null
    state = {
      ...state,
      live: {
        ...state.live,
        focusRestoreKey: null,
        focusRestoreFallbackId: null,
      },
    }
    window.queueMicrotask(() => {
      const focusTargets = [...document.querySelectorAll(
        '[data-focus-key="' + CSS.escape(focusKey) + '"]',
      )].filter(target => !target.closest('[hidden]'))
      const placeTargets = liveRevealTargetsForPlace(revealPlaceId)
      if (!revealLiveElements(focusTargets.length ? focusTargets : placeTargets) &&
          revealTarget) revealLiveStageTarget(revealTarget)
      restoreFocus(focusKey, null, fallbackId || null)
    })
  }

  function renderLiveFocusStatus() {
    if (!nodes.liveFocusStatus) return
    const handle = state.live.focusResident
    nodes.liveFocusStatus.dataset.focused = String(Boolean(handle))
    if (!handle) {
      nodes.liveFocusStatus.replaceChildren(document.createTextNode(
        'No resident focused. Click a resident to keep them and their visible interaction partners in view.'
      ))
      return
    }
    const message = element('span', '', 'Focused on ' + handle +
      '. Finite plate slots prioritize them while they are on this plate; if they leave, the Focus / Interactions board names their actual location. The complete roster and board keep every safely identified partner visible. ')
    const clear = element('button', 'live-focus-clear', 'Clear focus')
    clear.type = 'button'
    clear.setAttribute('aria-label', 'Clear resident focus')
    clear.dataset.focusKey = 'live-focus-clear'
    clear.addEventListener('click', () => setLiveFocusResident(null))
    nodes.liveFocusStatus.replaceChildren(message, clear)
  }

  function clampLiveScale(value) {
    return windowLiveClampZoomScale(
      value, LIVE_CAMERA_MIN_SCALE, LIVE_CAMERA_MAX_SCALE)
  }

  function liveScreenRectsOverlap(left, right, gap = 3) {
    return left.left < right.right + gap && left.right + gap > right.left &&
      left.top < right.bottom + gap && left.bottom + gap > right.top
  }

  function renderLiveResidentLabels(frameTime) {
    liveLabelFrame = 0
    if (!nodes.liveLabelLayer || !nodes.liveStage || !nodes.livePlates ||
        state.view !== 'live') return
    const fullRefresh = liveLabelNeedsFullRefresh ||
      frameTime - liveLabelLastFullRefresh >= LIVE_LABEL_FULL_REFRESH_MS
    liveLabelNeedsFullRefresh = false
    if (fullRefresh) {
      liveLabelLastFullRefresh = frameTime
      if (liveLabelRefreshTimer) {
        window.clearTimeout(liveLabelRefreshTimer)
        liveLabelRefreshTimer = 0
      }
    }
    const readable = nodes.liveStage.dataset.liveLabelMode === 'readable'
    const activeElement = document.activeElement
    const layerRect = nodes.liveLabelLayer.getBoundingClientRect()
    const existingTags = new Map([...nodes.liveLabelLayer.querySelectorAll(
      '[data-live-resident-tag]')].map(tag => [tag.dataset.liveResidentTag, tag]))
    const residents = [...nodes.livePlates.querySelectorAll(
      '.live-walker .live-portrait[data-live-resident-handle], ' +
      '.live-replay-portrait .live-portrait[data-live-resident-handle]')]
      .flatMap(portrait => {
        const shell = portrait.closest('.live-walker, .live-replay-portrait')
        if (!shell) return []
        const focused = shell.hasAttribute('data-live-focus-resident')
        const intent = shell.matches(':hover') || portrait === activeElement ||
          portrait.contains(activeElement)
        const handle = portrait.dataset.liveResidentHandle
        if (!handle) return []
        const raised = state.live.raisedItemKey === 'resident:' + handle
        if (!readable && !focused && !intent && !raised) return []
        const existingTag = existingTags.get(handle)
        const priority = raised ? 0 : focused ? 1 : intent ? 2 : 3
        const moving = shell.classList.contains('live-replay-portrait') &&
          shell.hasAttribute('data-replay-duration')
        if (!fullRefresh && priority === 3 && existingTag?.dataset.livePacked !== 'true') {
          return [{ existingTag, focused, handle, intent, measured: false, moving,
            portraitRect: null, priority, raised }]
        }
        const portraitRect = portrait.getBoundingClientRect()
        const visible = portraitRect.width > 0 && portraitRect.height > 0 &&
          portraitRect.right > layerRect.left && portraitRect.left < layerRect.right &&
          portraitRect.bottom > layerRect.top && portraitRect.top < layerRect.bottom
        const tag = existingTag || element('span', 'live-resident-tag live-item-name', handle)
        return [{
          existingTag: tag,
          focused,
          handle,
          intent,
          measured: true,
          tag,
          portraitRect: visible ? portraitRect : null,
          moving,
          priority,
          raised,
        }]
      })
    const candidates = residents.filter(candidate => candidate.portraitRect && candidate.tag)
      .sort((left, right) => left.priority - right.priority ||
        left.portraitRect.top - right.portraitRect.top ||
        left.portraitRect.left - right.portraitRect.left)
    const movingResidents = residents.some(resident => resident.moving)
    const occupied = [...nodes.livePlates.querySelectorAll('.live-speech-bubble')]
      .flatMap(bubble => {
        const rect = bubble.getBoundingClientRect()
        if (!(rect.width > 0 && rect.height > 0)) return []
        return [{
          left: rect.left - layerRect.left,
          right: rect.right - layerRect.left,
          top: rect.top - layerRect.top,
          bottom: rect.bottom - layerRect.top,
        }]
      })
    // Step 4: while the single Live item popover is open, its rect joins
    // the packer's occupied ground so a resident tag is never stacked
    // underneath it. One extra measurement, only while a popover is open.
    if (nodes.liveItemPopover && !nodes.liveItemPopover.hidden) {
      const popoverRect = nodes.liveItemPopover.getBoundingClientRect()
      if (popoverRect.width > 0 && popoverRect.height > 0) {
        occupied.push({
          left: popoverRect.left - layerRect.left,
          right: popoverRect.right - layerRect.left,
          top: popoverRect.top - layerRect.top,
          bottom: popoverRect.bottom - layerRect.top,
        })
      }
    }
    for (const resident of residents) {
      if (resident.measured && resident.existingTag) {
        resident.existingTag.dataset.livePacked = 'false'
      }
    }
    for (const candidate of candidates) {
      if (!candidate.tag.dataset.liveResidentTag) {
        candidate.tag.dataset.liveResidentTag = candidate.handle
      }
      if (candidate.focused) candidate.tag.dataset.liveFocusResident = candidate.handle
      else delete candidate.tag.dataset.liveFocusResident
      if (candidate.intent) candidate.tag.dataset.liveIntent = 'true'
      else delete candidate.tag.dataset.liveIntent
      if (candidate.raised) candidate.tag.dataset.liveRaised = 'true'
      else delete candidate.tag.dataset.liveRaised
    }
    if (fullRefresh) {
      const labels = candidates.map(candidate => candidate.tag)
      const heldLabels = [...nodes.liveLabelLayer.children]
      if (labels.length !== heldLabels.length ||
          labels.some((label, index) => label !== heldLabels[index])) {
        nodes.liveLabelLayer.replaceChildren(...labels)
      }
    }
    if (!candidates.length) {
      if (movingResidents || !fullRefresh) scheduleLiveResidentLabelRefresh()
      return
    }

    const margin = 4
    const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))
    for (const candidate of candidates) {
      if (!liveLabelDimensions.has(candidate.tag)) {
        const tagRect = candidate.tag.getBoundingClientRect()
        liveLabelDimensions.set(candidate.tag, Object.freeze({
          width: tagRect.width,
          height: tagRect.height,
        }))
      }
    }
    for (const candidate of candidates) {
      const { width, height } = liveLabelDimensions.get(candidate.tag)
      const maximumLeft = Math.max(margin, layerRect.width - margin - width)
      const maximumTop = Math.max(margin, layerRect.height - margin - height)
      const anchorLeft = candidate.portraitRect.left - layerRect.left +
        (candidate.portraitRect.width - width) / 2
      const aboveTop = candidate.portraitRect.top - layerRect.top - height - 5
      const belowTop = candidate.portraitRect.bottom - layerRect.top + 5
      const stepY = height + 5
      const stepX = Math.max(36, width * 0.55)
      const positions = []
      const seen = new Set()
      const offer = (left, top) => {
        const held = Object.freeze({
          left: clamp(left, margin, maximumLeft),
          top: clamp(top, margin, maximumTop),
        })
        const key = held.left.toFixed(2) + ':' + held.top.toFixed(2)
        if (seen.has(key)) return
        seen.add(key)
        positions.push(held)
      }
      const laneLimit = candidate.priority < 3 ? 20 : 8
      for (let lane = 0; lane < laneLimit; lane += 1) {
        for (const horizontal of [0, -stepX, stepX]) {
          offer(anchorLeft + horizontal, aboveTop - lane * stepY)
          offer(anchorLeft + horizontal, belowTop + lane * stepY)
        }
      }
      let chosen = positions.find(position => {
        const rect = {
          left: position.left,
          right: position.left + width,
          top: position.top,
          bottom: position.top + height,
        }
        return !occupied.some(other => liveScreenRectsOverlap(rect, other))
      })
      if (!chosen && candidate.priority < 3) {
        const verticalStep = height + 5
        for (let top = margin; top <= maximumTop && !chosen; top += verticalStep) {
          for (let left = margin; left <= maximumLeft; left += 8) {
            const rect = { left, right: left + width, top, bottom: top + height }
            if (!occupied.some(other => liveScreenRectsOverlap(rect, other))) {
              chosen = Object.freeze({ left, top })
              break
            }
          }
        }
      }
      if (!chosen) continue
      candidate.tag.style.left = String(chosen.left) + 'px'
      candidate.tag.style.top = String(chosen.top) + 'px'
      candidate.tag.dataset.livePacked = 'true'
      occupied.push(Object.freeze({
        left: chosen.left,
        right: chosen.left + width,
        top: chosen.top,
        bottom: chosen.top + height,
      }))
    }
    const movingResidentCount = residents.filter(resident => resident.moving).length
    if (movingResidentCount <= LIVE_LABEL_CONTINUOUS_LIMIT &&
        candidates.some(candidate => candidate.moving &&
          candidate.tag.dataset.livePacked === 'true')) {
      scheduleLiveResidentLabels()
    } else if (movingResidents || !fullRefresh) {
      scheduleLiveResidentLabelRefresh()
    }
  }

  function scheduleLiveResidentLabelRefresh() {
    if (liveLabelRefreshTimer || state.view !== 'live' || document.hidden) return
    liveLabelRefreshTimer = window.setTimeout(() => {
      liveLabelRefreshTimer = 0
      scheduleLiveResidentLabels(true)
    }, LIVE_LABEL_FULL_REFRESH_MS)
  }

  function scheduleLiveResidentLabels(fullRefresh = false) {
    if (fullRefresh) {
      liveLabelNeedsFullRefresh = true
      if (liveLabelRefreshTimer) {
        window.clearTimeout(liveLabelRefreshTimer)
        liveLabelRefreshTimer = 0
      }
    }
    if (!nodes.liveLabelLayer || liveLabelFrame) return
    liveLabelFrame = window.requestAnimationFrame(renderLiveResidentLabels)
  }

`
