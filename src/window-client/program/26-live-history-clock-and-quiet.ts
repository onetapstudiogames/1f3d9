export const PART_26_LIVE_HISTORY_CLOCK_AND_QUIET = `  function renderLiveHistoryStatus() {
    if (!nodes.liveHistoryStatus) return
    if (state.live.proofScene) {
      const exit = element('button', 'live-history-retry', 'Exit preview proof scene')
      exit.type = 'button'
      exit.dataset.focusKey = 'live-proof-exit'
      exit.dataset.focusFallbackId = 'live-proof'
      exit.addEventListener('click', exitLiveProofScene)
      nodes.liveHistoryStatus.replaceChildren(
        document.createTextNode(
          'Preview proof: movement, speech, use, concurrency, crowding, inline Show more, failure, and Retry are repeatable here. '
        ),
        exit,
      )
      return
    }
    const parts = []
    if (state.live.openingLoading) {
      parts.push(document.createTextNode('Reading backward to the 30-minute trace edge…'))
    } else if (state.live.openingPaused) {
      parts.push(document.createTextNode(
        'Automatic recent-history reading pauses after 1,600 public events. Continue recent history to read the next pages; this viewer will not call the history complete while pages remain. '
      ))
      const continueButton = element('button', 'live-history-retry', 'Continue recent history')
      continueButton.type = 'button'
      continueButton.dataset.focusKey = 'live-history-opening-continue'
      continueButton.addEventListener('click', () => {
        if (state.snapshot) void loadLiveOpeningHistory(state.snapshot, true)
      })
      parts.push(continueButton)
    } else if (state.live.openingError) {
      parts.push(document.createTextNode(
        'Recent history is incomplete before the 30-minute edge. The plate shows only records it could verify. '
      ))
      const retry = element('button', 'live-history-retry', 'Retry recent history')
      retry.type = 'button'
      retry.dataset.focusKey = 'live-history-opening-retry'
      retry.addEventListener('click', () => {
        if (state.snapshot) void loadLiveOpeningHistory(state.snapshot, true)
      })
      parts.push(retry)
    } else if (state.live.openingComplete) {
      parts.push(document.createTextNode('Recent history is complete through the 30-minute trace edge.'))
    } else {
      parts.push(document.createTextNode('Preparing the recent public record…'))
    }
    if (state.live.streamError) {
      parts.push(document.createTextNode(
        ' The latest change pages could not be completed; this plate is holding its last verified cursor. '
      ))
      const retry = element('button', 'live-history-retry', 'Retry the latest read')
      retry.type = 'button'
      retry.dataset.focusKey = 'live-history-stream-retry'
      retry.addEventListener('click', () => void refreshCity())
      parts.push(retry)
    }
    const snapshot = state.snapshot
    const focus = snapshot ? liveFocusPlace(snapshot) : null
    if (snapshot && focus) {
      const thingFilters = liveThingFilters(focus.id)
      const thingsPage = historyEntry('things', thingFilters)
      const namedThingCount = liveDisplayedThings(
        snapshot, focus.id, focus.id, true).length
      const exactThingTotal = liveExactThingTotal(
        snapshot, focus.id, namedThingCount, true)
      if (exactThingTotal === null) {
        parts.push(document.createTextNode(
          ' Exact +N thing counts are unavailable because the fixed survey is incomplete or disagrees with the named cards.'
        ))
      } else if (thingsPage.error) {
        parts.push(document.createTextNode(
          ' Exact +N thing counts stay verified, but newest named thing cards could not be read. '
        ))
        const retry = element('button', 'live-history-retry', 'Retry named thing cards')
        retry.type = 'button'
        retry.dataset.focusKey = 'live-things-retry'
        retry.addEventListener('click', () => void loadHistory('things', thingFilters))
        parts.push(retry)
      } else if (thingsPage.loading || !thingsPage.initialized) {
        parts.push(document.createTextNode(
          ' Exact +N thing counts come from the fixed survey while newest named cards load. ' +
          'The named-card sample stops after one page of at most 50 public things.'
        ))
      } else if (thingsPage.hasMore) {
        parts.push(document.createTextNode(
          ' Showing the newest ' + String(thingsPage.rows.length) +
          ' named thing cards, from a one-page limit of 50; exact +N includes every other public thing in this plate.'
        ))
      }
    }
    nodes.liveHistoryStatus.replaceChildren(...parts)
  }

  async function loadLiveOpeningHistory(snapshot, force) {
    if (state.view !== 'live' || document.hidden || state.live.openingLoading ||
        (state.live.openingLoaded && !force)) return
    const visibilityRevisionAtStart = liveVisibilityRevision
    const requestMarker = state.live.openingMarker || snapshot.changeMarker || state.changeMarker
    if (!requestMarker) return
    const startingEvents = force ? state.live.openingEvents : []
    const startingBeforeId = force ? state.live.openingNextBeforeId : null
    state = {
      ...state,
      live: {
        ...state.live,
        openingMarker: requestMarker,
        openingEvents: startingEvents,
        openingLoaded: false,
        openingLoading: true,
        openingComplete: false,
        openingPaused: false,
        openingError: false,
        openingReplaySuppressed: force ? state.live.openingReplaySuppressed : false,
        openingNextBeforeId: startingBeforeId,
        changes: state.live.openingMarker ? state.live.changes : [],
        streamMarker: state.live.openingMarker ? state.live.streamMarker : requestMarker,
      },
    }
    renderLiveHistoryStatus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let events = startingEvents
    let beforeId = startingBeforeId
    let heldMarker = startingBeforeId ? requestMarker : null
    const seenCursors = new Set()
    let complete = false
    let automaticPaused = false
    let visibilityPaused = false
    let pageCount = 0
    try {
      while (!complete) {
        if (state.view !== 'live' || document.hidden) {
          visibilityPaused = true
          break
        }
        const url = new URL('/api/events', window.location.origin)
        url.searchParams.set('limit', String(LIVE_OPENING_PAGE_LIMIT))
        url.searchParams.set('within_seconds', String(LIVE_MOVE_LIFETIME_MS / 1000))
        url.searchParams.set('after_change_marker', heldMarker || requestMarker)
        if (beforeId) url.searchParams.set('before_id', String(beforeId))
        const response = await fetch(url.pathname + url.search, {
          credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
          redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
        })
        if (!response.ok) throw new Error('recent public events unavailable')
        const payload = await response.json()
        if (!payload || typeof payload !== 'object') throw new Error('invalid recent public events')
        const pageMarker = safeChangeMarker(payload.change_marker)
        if (!pageMarker || !markerCovers(pageMarker, heldMarker || requestMarker)) {
          throw new Error('recent public event marker did not cover its page')
        }
        if (!heldMarker) heldMarker = pageMarker
        const incoming = normalizeEvents(payload.events, LIVE_OPENING_PAGE_LIMIT)
        const covered = incoming.filter(event => event.change_id &&
          BigInt(event.change_id) <= BigInt(heldMarker))
        const previousLength = events.length
        events = mergeWindowRows(events, covered)
        pageCount += 1
        if (payload.has_more !== true) {
          complete = true
          beforeId = null
          break
        }
        const nextBeforeId = safeId(payload.next_before_id)
        if (!incoming.length || !nextBeforeId || seenCursors.has(nextBeforeId) ||
            !incoming.some(event => event.id === nextBeforeId) ||
            (beforeId && nextBeforeId >= beforeId) || events.length <= previousLength) {
          throw new Error('recent public event cursor did not progress')
        }
        seenCursors.add(nextBeforeId)
        beforeId = nextBeforeId
        if (pageCount >= MAX_AUTO_HISTORY_PAGES) {
          automaticPaused = true
          break
        }
      }
      const latestAt = events.length
        ? Math.max(...events.map(event => event.at.getTime()))
        : state.live.lastChangeAt
      const streamBase = heldMarker || requestMarker
      const changes = Object.freeze(state.live.changes.filter(change =>
        BigInt(change.change_id) > BigInt(streamBase)))
      const streamMarker = markerCovers(state.live.streamMarker, streamBase)
        ? state.live.streamMarker
        : streamBase
      state = {
        ...state,
        live: {
          ...state.live,
          openingEvents: Object.freeze(events),
          openingMarker: streamBase,
          openingLoaded: !visibilityPaused,
          openingLoading: false,
          openingComplete: complete,
          openingPaused: automaticPaused,
          openingError: false,
          openingReplaySuppressed: state.live.openingReplaySuppressed ||
            visibilityRevisionAtStart !== liveVisibilityRevision,
          openingNextBeforeId: beforeId,
          changes,
          streamMarker,
          lastChangeAt: latestAt || null,
        },
      }
    } catch {
      const streamBase = heldMarker || requestMarker
      const changes = Object.freeze(state.live.changes.filter(change =>
        BigInt(change.change_id) > BigInt(streamBase)))
      state = {
        ...state,
        live: {
          ...state.live,
          openingEvents: Object.freeze(events),
          openingMarker: streamBase,
          openingLoaded: true,
          openingLoading: false,
          openingComplete: false,
          openingPaused: false,
          openingError: true,
          openingReplaySuppressed: state.live.openingReplaySuppressed ||
            visibilityRevisionAtStart !== liveVisibilityRevision,
          openingNextBeforeId: beforeId,
          changes,
          streamMarker: markerCovers(state.live.streamMarker, streamBase)
            ? state.live.streamMarker
            : streamBase,
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (state.live.openingComplete && !state.live.openingError) {
        // Opening history is context, not a burst of actions happening now.
        // Paint its final residue immediately, then animate only changes
        // learned after that completed baseline.
        queueLiveReplays(state.live.openingEvents, false)
        queueLiveReplays(
          state.live.changes,
          !document.hidden && !state.live.suppressReplayOnNextRead &&
            !state.live.openingReplaySuppressed &&
            visibilityRevisionAtStart === liveVisibilityRevision,
        )
      }
      if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
      if (state.view === 'live' && !document.hidden && heldMarker &&
          !markerCovers(state.changeMarker, heldMarker)) void refreshCity()
    }
  }

  function liveAgeLabel(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000))
    if (seconds < 60) return String(seconds) + 's'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return String(minutes) + (minutes === 1 ? ' minute' : ' minutes')
    const hours = Math.floor(minutes / 60)
    return String(hours) + (hours === 1 ? ' hour' : ' hours')
  }

  function renderLiveClock() {
    if (!nodes.liveClock) return
    if (document.hidden) {
      nodes.liveClock.textContent = 'Reads pause while this tab is hidden. The last completed plate stays visible.'
      return
    }
    const now = Date.now()
    const next = state.live.nextReadAt
      ? ' · next read in ' + String(Math.max(0, Math.ceil((state.live.nextReadAt - now) / 1000))) + 's'
      : ' · next read pending'
    if (!state.live.lastChangeAt) {
      nodes.liveClock.textContent =
        'The city has been still for longer than this plate can show. It moves only when residents act.' + next
      return
    }
    const elapsed = Math.max(0, now - state.live.lastChangeAt)
    nodes.liveClock.textContent = elapsed >= 60000
      ? 'The city has been still for ' + liveAgeLabel(elapsed) +
        '. It moves only when residents act.' + next
      : 'last change ' + liveAgeLabel(elapsed) + ' ago' + next
  }

  function moveLiveFocusAfterExpiry(key) {
    const candidates = [...(nodes.livePlates?.querySelectorAll('[data-live-key]') || [])]
    const paired = candidates.find(candidate =>
      candidate.isConnected && candidate.dataset.liveKey === key)
    const fallback = paired || nodes.liveViewport || nodes.livePause
    if (typeof fallback?.focus === 'function') fallback.focus()
  }

  function renderLiveAging() {
    if (state.view !== 'live' || document.hidden) return
    const now = Date.now()
    const trailStarts = windowLivePruneTrailStarts(
      state.live.trailStarts,
      now,
      LIVE_TRAIL_LIFETIME_MS,
      [...liveReplayHeldKeys()],
    )
    if (trailStarts !== state.live.trailStarts) {
      state = { ...state, live: { ...state.live, trailStarts } }
    }
    pruneLiveNoteBodies(now)
    const agedNodes = [
      ...(nodes.livePlates?.querySelectorAll('[data-live-at][data-live-lifetime]') || []),
    ]
    for (const node of agedNodes) {
      const opacity = windowLiveTraceOpacity(
        Number(node.dataset.liveAt), now, Number(node.dataset.liveLifetime))
      if (opacity <= 0) {
        const active = document.activeElement
        const movesFocus = active === node || node.contains(active)
        const key = node.dataset.liveKey
        node.remove()
        if (movesFocus) moveLiveFocusAfterExpiry(key)
      } else {
        node.style.opacity = String(opacity)
      }
    }
  }

  function scheduleLiveClock() {
    window.clearTimeout(state.live.clockTimer)
    if (state.view !== 'live') {
      if (state.live.clockTimer) {
        state = { ...state, live: { ...state.live, clockTimer: 0 } }
      }
      return
    }
    renderLiveClock()
    renderLiveAging()
    const clockTimer = window.setTimeout(scheduleLiveClock, 1000)
    state = { ...state, live: { ...state.live, clockTimer } }
  }

  function renderLivePopulationGate(message, retryLabel, retry) {
    clearLiveScopeSurfaces('Waiting for this plate to finish loading…')
    if (nodes.liveMapCaption) nodes.liveMapCaption.hidden = true
    const row = element('div', retry ? 'error-row' : 'loading-row')
    row.append(element('p', '', message))
    if (retry) {
      const button = element('button', 'selection-retry', retryLabel)
      button.type = 'button'
      button.dataset.focusKey = 'live-population-retry'
      button.addEventListener('click', retry)
      row.append(button)
    }
    nodes.livePlates.replaceChildren(row)
    renderLiveHistoryStatus()
    scheduleLiveClock()
  }

  function clearLiveScopeSurfaces(message) {
    if (nodes.liveWorldGround) nodes.liveWorldGround.replaceChildren()
    if (nodes.liveNotesPanel) nodes.liveNotesPanel.hidden = true
    if (nodes.liveRoster) {
      nodes.liveRoster.replaceChildren(element('p', 'loading-row', message))
    }
    if (nodes.liveResidentPage) {
      nodes.liveResidentPage.hidden = true
      nodes.liveResidentPage.replaceChildren()
    }
  }

  // Decision #75: the Live tab's main plate must honour quiet exactly like
  // every other tab — name, owner, and counts stay visible, but walker
  // portraits, thing specimens, the trace layer, and the ledger (which would
  // otherwise name residents and things through recorded actions) are all
  // replaced by the one honest sentence. Nothing else renders.
  function renderLiveQuietPlate(snapshot, focus) {
    if (nodes.liveWorldGround) nodes.liveWorldGround.replaceChildren()
    if (nodes.liveStage) {
      nodes.liveStage.style.setProperty('--live-stage-width', '1100px')
      nodes.liveStage.style.setProperty('--live-stage-height', '680px')
      nodes.liveStage.dataset.liveStageWidth = '1100'
      nodes.liveStage.dataset.liveStageHeight = '680'
      nodes.liveStage.setAttribute('aria-label', 'Live surveyed plate for ' + focus.name)
    }
    renderLiveBreadcrumbs(snapshot, focus)
    const residentCount = displayedResidents(snapshot).filter(resident =>
      resident.current_place_id === focus.id).length
    const thingCount = liveSurveyThingTotal(snapshot, focus.id, false)
    const summary = element('div', 'quiet-plate-summary')
    summary.append(
      element('h3', 'live-plate-title', focus.name),
      element('p', 'quiet-plate-facts', (focus.owner ? 'Kept by ' + focus.owner : 'Nobody owns it') +
        ' · ' + String(residentCount) + (residentCount === 1 ? ' resident' : ' residents') +
        ' · ' + (thingCount === null
          ? 'thing count unavailable'
          : String(thingCount) + (thingCount === 1 ? ' thing' : ' things'))),
      quietRoomNotice(focus),
    )
    const notesControl = liveNotesControl(snapshot, focus, 'live-root-notes')
    if (notesControl) summary.append(notesControl)
    if (nodes.livePlates) nodes.livePlates.replaceChildren(summary)
    if (nodes.liveMapCaption) nodes.liveMapCaption.hidden = true
    renderLiveRoster(snapshot, focus, [], [])
    if (nodes.liveResidentPage) {
      nodes.liveResidentPage.hidden = true
      nodes.liveResidentPage.replaceChildren()
    }
  }

`
