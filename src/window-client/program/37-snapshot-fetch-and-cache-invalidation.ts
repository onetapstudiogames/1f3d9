export const PART_37_SNAPSHOT_FETCH_AND_CACHE_INVALIDATION = `  async function getSnapshot(signal, minimumMarker) {
    const url = new URL('/api/window', window.location.origin)
    url.searchParams.set('view', 'outline')
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    const response = await fetch(url.pathname + url.search, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public snapshot unavailable')
    return response.json()
  }

  async function checkPublicChanges() {
    const visibilityRevision = liveVisibilityRevision
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const startingMarker = state.live.streamMarker || state.changeMarker
      let cursor = startingMarker
      let marker = startingMarker
      let heldMarker = null
      let changes = []
      let unchanged = true
      const seenCursors = new Set()
      while (true) {
        const url = new URL('/api/changes', window.location.origin)
        if (state.live.streamMarker && cursor === state.live.streamMarker) {
          url.searchParams.set('since', state.live.streamMarker)
        } else if (state.changeMarker && cursor === state.changeMarker) {
          url.searchParams.set('since', state.changeMarker)
        } else if (cursor) {
          url.searchParams.set('since', cursor)
        }
        url.searchParams.set('limit', String(LIVE_OPENING_PAGE_LIMIT))
        const response = await fetch(url.pathname + url.search, {
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          mode: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('public changes unavailable')
        const payload = await response.json()
        if (!payload || typeof payload !== 'object') throw new Error('invalid public changes')
        const nextMarker = safeChangeMarker(payload.change_marker ?? payload.checkpoint)
        if (!nextMarker || (cursor && !markerCovers(nextMarker, cursor)) ||
            (startingMarker && !markerCovers(nextMarker, startingMarker))) {
          throw new Error('public change marker did not cover its page')
        }
        heldMarker = heldMarker || nextMarker
        if (!markerCovers(nextMarker, heldMarker)) {
          throw new Error('public change marker moved behind the held page')
        }
        marker = heldMarker
        unchanged = unchanged && payload.unchanged === true
        if (!startingMarker) {
          return Object.freeze({
            status: 'unchanged', marker, changes: Object.freeze([]), visibilityRevision,
          })
        }
        const incoming = normalizeLiveChanges(payload.changes)
        if (incoming.some(change =>
          (cursor && BigInt(change.change_id) <= BigInt(cursor)) ||
          BigInt(change.change_id) > BigInt(nextMarker))) {
          throw new Error('public change page crossed its cursor')
        }
        changes = mergeLiveChanges(changes, incoming.filter(change =>
          BigInt(change.change_id) <= BigInt(heldMarker)))
        if (payload.has_more !== true) break
        const nextSince = safeChangeMarker(payload.next_since)
        if (!nextSince || !cursor || BigInt(nextSince) <= BigInt(cursor) ||
            BigInt(nextSince) > BigInt(nextMarker) || seenCursors.has(nextSince)) {
          throw new Error('public change cursor did not progress')
        }
        if (BigInt(nextSince) >= BigInt(heldMarker)) break
        seenCursors.add(nextSince)
        cursor = nextSince
      }
      return Object.freeze({
        status: changes.length || marker !== startingMarker || !unchanged ? 'changed' : 'unchanged',
        marker,
        changes,
        visibilityRevision,
      })
    } catch {
      return Object.freeze({
        status: 'unavailable', marker: null, changes: Object.freeze([]), visibilityRevision,
      })
    } finally {
      window.clearTimeout(timeout)
    }
  }

  function invalidateLiveCaches(drawings, noteBodies, changes) {
    const drawingKeys = new Set()
    let clearAll = false
    for (const change of changes) {
      if (change.kind === 'resident_edited' && change.detail.resident_id) {
        drawingKeys.add('resident:' + String(change.detail.resident_id))
      } else if (change.kind === 'place_edited' && change.detail.place_id) {
        drawingKeys.add('place:' + String(change.detail.place_id))
      } else if (
        (change.kind === 'thing_edited' || change.kind === 'thing_upgraded') &&
        change.detail.thing_id
      ) {
        drawingKeys.add('thing:' + String(change.detail.thing_id))
      } else if (change.kind === 'kind_revised' && change.detail.kind_id) {
        drawingKeys.add('kind:' + String(change.detail.kind_id))
      } else if (change.kind === 'moderation') {
        clearAll = true
      }
    }
    const filteredDrawings = clearAll
      ? {}
      : Object.fromEntries(Object.entries(drawings).filter(([key]) => !drawingKeys.has(key)))
    if (clearAll) {
      liveFloorTiles.clear()
      liveProofFloorTiles.clear()
      liveFloorTileLoads.clear()
    } else {
      for (const drawingKey of drawingKeys) {
        if (!drawingKey.startsWith('place:')) continue
        const placeId = drawingKey.slice('place:'.length)
        for (const key of new Set([
          ...liveFloorTiles.keys(),
          ...liveProofFloorTiles.keys(),
          ...liveFloorTileLoads.keys(),
        ])) {
          if (!key.startsWith(placeId + ':')) continue
          liveFloorTiles.delete(key)
          liveProofFloorTiles.delete(key)
          liveFloorTileLoads.delete(key)
        }
      }
    }
    return Object.freeze({
      drawings: clearAll || drawingKeys.size ? filteredDrawings : drawings,
      noteBodies: clearAll ? {} : noteBodies,
    })
  }

  function commitLiveChangeRead(changeState) {
    const visibilityInterrupted = Number.isSafeInteger(changeState.visibilityRevision) &&
      changeState.visibilityRevision !== liveVisibilityRevision
    if (changeState.status === 'unavailable') {
      state = { ...state, live: { ...state.live, streamError: true } }
      return visibilityInterrupted ? 0 : BASE_REFRESH_MS
    }
    const incoming = changeState.changes || []
    const hadStreamError = state.live.streamError
    const openingMarker = state.live.openingMarker
    const streamIncoming = openingMarker
      ? incoming.filter(change => BigInt(change.change_id) > BigInt(openingMarker))
      : incoming
    const known = new Set(state.live.changes.map(change => change.change_id))
    const suppressReplay = state.live.suppressReplayOnNextRead || document.hidden ||
      visibilityInterrupted
    const replayIncoming = state.live.openingLoaded && !suppressReplay
      ? streamIncoming.filter(change => !known.has(change.change_id))
      : []
    const cutoff = Date.now() - LIVE_MOVE_LIFETIME_MS
    const merged = Object.freeze(mergeLiveChanges(state.live.changes, streamIncoming)
      .filter(change => change.at.getTime() >= cutoff &&
        (!openingMarker || BigInt(change.change_id) > BigInt(openingMarker))))
    const latestAt = streamIncoming.length
      ? Math.max(...streamIncoming.map(change => change.at.getTime()), state.live.lastChangeAt || 0)
      : state.live.lastChangeAt
    const hadEvents = incoming.length > 0
    const invalidatedCaches = invalidateLiveCaches(
      state.live.drawings,
      state.live.noteBodies,
      incoming,
    )
    const quietReadsBefore = state.live.quietReads
    const nextDelay = visibilityInterrupted
      ? 0
      : state.view === 'live'
      ? windowLivePollDelay(hadEvents, quietReadsBefore)
      : BASE_REFRESH_MS
    state = {
      ...state,
      live: {
        ...state.live,
        changes: merged,
        drawings: invalidatedCaches.drawings,
        noteBodies: invalidatedCaches.noteBodies,
        streamError: false,
        streamMarker: changeState.marker || state.live.streamMarker,
        quietReads: state.view === 'live'
          ? hadEvents ? 0 : quietReadsBefore + 1
          : 0,
        lastChangeAt: latestAt || null,
        nextReadAt: document.hidden ? null : Date.now() + nextDelay,
        suppressReplayOnNextRead: document.hidden || visibilityInterrupted,
      },
    }
    if (suppressReplay && streamIncoming.length) {
      queueLiveReplays(streamIncoming, false)
    } else if (replayIncoming.length) {
      queueLiveReplays(replayIncoming)
    }
    if ((incoming.length || hadStreamError) && state.view === 'live' && state.snapshot) {
      markLiveDirty()
    }
    return nextDelay
  }

  async function refreshUnchangedPresence(signal, minimumMarker) {
    const targetCount = state.snapshot?.residents.length || 0
    if (!targetCount) return []
    let residents = []
    let beforeId = null
    const seenCursors = new Set()
    while (residents.length < targetCount) {
      const url = new URL('/api/residents', window.location.origin)
      url.searchParams.set('view', 'presence')
      url.searchParams.set('limit', String(Math.min(200, targetCount - residents.length)))
      if (beforeId) url.searchParams.set('before_id', String(beforeId))
      if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      })
      if (!response.ok) throw new Error('public presence unavailable')
      const payload = await response.json()
      if (!payload || typeof payload !== 'object') throw new Error('invalid public presence')
      requireExactReadMarker(payload.change_marker, minimumMarker)
      const incoming = normalizeResidents(payload.residents)
      const merged = mergeResidentRows(residents, incoming)
      if (merged.length === residents.length && residents.length < targetCount) {
        throw new Error('public presence did not advance')
      }
      residents = merged
      if (residents.length >= targetCount) break
      if (payload.has_more !== true) throw new Error('public presence ended early')
      const nextBeforeId = safeId(payload.next_before_id)
      if (!nextBeforeId || seenCursors.has(nextBeforeId)) {
        throw new Error('invalid public presence cursor')
      }
      seenCursors.add(nextBeforeId)
      beforeId = nextBeforeId
    }
    return residents.slice(0, targetCount)
  }

  function scheduleRefresh(delay) {
    window.clearTimeout(state.pollTimer)
    if (state.live.proofScene) {
      state = { ...state, pollTimer: 0, live: { ...state.live, nextReadAt: null } }
      renderLiveClock()
      return
    }
    const pollTimer = window.setTimeout(() => {
      if (document.hidden) {
        scheduleRefresh(BASE_REFRESH_MS)
        return
      }
      void refreshCity()
    }, delay)
    state = {
      ...state,
      pollTimer,
      live: { ...state.live, nextReadAt: document.hidden ? null : Date.now() + delay },
    }
    if (state.view === 'live') renderLiveClock()
  }

  async function finishWatchingPublicStreets() {
    const gazetteFresh = state.view !== 'gazette' || await loadGazetteIssues(
      state.gazette.listInitialized ? 'refresh' : 'initial',
    )
    if (state.view === 'gazette' && !gazetteFresh) {
      setStatus('The public streets are current. The Gazette could not be refreshed.', 'stale')
      return
    }
    setStatus('Watching the public streets', 'live')
  }

`
