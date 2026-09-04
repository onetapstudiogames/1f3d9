export const PART_24_LIVE_REPLAY_MOTION = `  function liveAnchorPoint(anchorId, focusId, children) {
    if (anchorId === focusId) return Object.freeze({ x: 72, y: 58 })
    const plot = windowLiveSurveyedPlots(children, focusId)
      .find(candidate => candidate.id === anchorId)
    return plot ? Object.freeze({
      x: plot.x + plot.width / 2,
      y: plot.y + plot.height - 18,
    }) : null
  }

  function liveReplayPoint(placeId, focus, children, renderContext = null) {
    const anchor = livePlaceAnchor(placeId, focus.id, children, renderContext)
    return liveAnchorPoint(anchor, focus.id, children)
  }

  function liveReplayMoveGeometry(
    record,
    snapshot,
    focus,
    children,
    renderContext = null,
    cacheable = true,
  ) {
    if (renderContext && cacheable) {
      return renderContext.remember(
        'move-geometry:' + liveTraceKey(record),
        () => liveReplayMoveGeometry(
          record, snapshot, focus, children, renderContext, false),
      )
    }
    const from = liveResidentReplayPoint(
      snapshot,
      record.detail.from_place_id,
      record.actor,
      focus,
      children,
      renderContext,
    )
    const to = liveResidentReplayPoint(
      snapshot,
      record.detail.to_place_id,
      record.actor,
      focus,
      children,
      renderContext,
    )
    if (!from || !to || (from.x === to.x && from.y === to.y)) return null
    return Object.freeze({ from, to })
  }

  function queueLiveReplayCompletion(actor, key) {
    const held = state.live.replayActive[actor]
    if (!held || held.key !== key || liveReplayCompletions.some(completion =>
      completion.actor === actor && completion.key === key)) return
    liveReplayCompletions = Object.freeze([
      ...liveReplayCompletions,
      Object.freeze({ actor, key }),
    ])
    if (!liveReplayCompletionFrame) {
      liveReplayCompletionFrame = window.requestAnimationFrame(flushLiveReplayCompletions)
    }
  }

  function flushLiveReplayCompletions() {
    liveReplayCompletionFrame = 0
    const completions = liveReplayCompletions
    liveReplayCompletions = Object.freeze([])
    if (!completions.length) return
    const active = { ...state.live.replayActive }
    const positions = { ...state.live.replayPositions }
    const trailStarts = { ...state.live.trailStarts }
    const absorptionEndsAtByPlaceId = { ...state.live.absorptionEndsAtByPlaceId }
    const replayReadyAtByActor = { ...state.live.replayReadyAtByActor }
    const focus = state.snapshot ? liveFocusPlace(state.snapshot) : null
    const children = focus && state.snapshot ? liveChildren(state.snapshot, focus) : []
    const renderContext = livePlotDetailContext?.snapshot === state.snapshot &&
      livePlotDetailContext.focus.id === focus?.id
      ? livePlotDetailContext
      : null
    const now = Date.now()
    const absorptionDeadlines = new Map()
    let changed = false
    for (const completion of completions) {
      const held = active[completion.actor]
      if (!held || held.key !== completion.key) continue
      const absorbingPlaceId = held.type === 'move' && focus
        ? livePlaceAnchor(held.toPlaceId, focus.id, children, renderContext)
        : null
      delete active[completion.actor]
      if (held.type === 'move') {
        positions[completion.actor] = held.toPlaceId
        trailStarts[completion.key] = now
        if (absorbingPlaceId) {
          const deadline = now + LIVE_ABSORPTION_MS
          absorptionEndsAtByPlaceId[String(absorbingPlaceId)] = deadline
          absorptionDeadlines.set(String(absorbingPlaceId), deadline)
        }
      }
      if (!state.live.replayQueues[completion.actor]?.length) {
        if (!absorbingPlaceId) delete positions[completion.actor]
        delete replayReadyAtByActor[completion.actor]
      } else {
        const pendingCount = Object.values(state.live.replayQueues)
          .reduce((total, queue) => total + queue.length, 0)
        const pace = windowLiveReplayPace(
          pendingCount,
          Math.max(1, (state.live.nextReadAt || now + 25_000) - now),
        )
        replayReadyAtByActor[completion.actor] = now + Math.max(
          0,
          pace.startGapMs - Math.max(0, Number(held.duration) || 0),
        )
      }
      changed = true
    }
    if (!changed) return
    state = { ...state, live: {
      ...state.live,
      replayActive: Object.freeze(active),
      replayPositions: Object.freeze(positions),
      trailStarts: Object.freeze(trailStarts),
      absorptionEndsAtByPlaceId: Object.freeze(absorptionEndsAtByPlaceId),
      replayReadyAtByActor: Object.freeze(replayReadyAtByActor),
    } }
    if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
    for (const [placeId, absorptionEndsAt] of absorptionDeadlines) {
      const absorbedActors = Object.entries(positions)
        .filter(([actor, placeIdAtRest]) =>
          !active[actor] &&
          !state.live.replayQueues[actor]?.length &&
          livePlaceAnchor(
            placeIdAtRest, focus.id, children, renderContext) === Number(placeId))
        .map(([actor]) => actor)
      window.setTimeout(() => {
        if (state.live.absorptionEndsAtByPlaceId[placeId] !== absorptionEndsAt) return
        const remaining = { ...state.live.absorptionEndsAtByPlaceId }
        const remainingPositions = { ...state.live.replayPositions }
        delete remaining[placeId]
        for (const actor of absorbedActors) {
          if (!state.live.replayActive[actor] &&
              !state.live.replayQueues[actor]?.length) delete remainingPositions[actor]
        }
        state = { ...state, live: {
          ...state.live,
          absorptionEndsAtByPlaceId: Object.freeze(remaining),
          replayPositions: Object.freeze(remainingPositions),
        } }
        if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
      }, LIVE_ABSORPTION_MS)
    }
  }

  function liveReplayThingIsDisplayed(
    record,
    snapshot,
    focus,
    children,
    renderContext = null,
  ) {
    if (liveRecordType(record) !== 'use') return false
    const placeId = record.detail.place_id
    const anchorId = livePlaceAnchor(placeId, focus.id, children, renderContext)
    if (!anchorId) return false
    const includeDescendants = anchorId !== focus.id
    const records = renderContext?.records || visibleLiveRecords(
      snapshot, focus, children, renderContext)
    const interactionThings = renderContext?.interactionThings ||
      liveFocusInteractionThings(snapshot, focus, records)
    const presentation = liveThingPresentation(
      snapshot,
      anchorId,
      records,
      focus.id,
      includeDescendants,
      interactionThings,
      renderContext,
    )
    const matches = thing => thing.id === record.detail.source_thing_id &&
      (thing.place_id === placeId || thing.recorded_place_id === placeId)
    return presentation.selection.visible.some(matches) ||
      interactionThings.some(matches)
  }

  function startLiveReplays() {
    window.clearTimeout(liveReplayStartTimer)
    liveReplayStartTimer = 0
    if (state.view !== 'live' || document.hidden || !state.snapshot || state.live.paused) return
    if (state.live.streamMarker && !markerCovers(state.changeMarker, state.live.streamMarker)) return
    if (liveMotionReduced()) {
      if (liveReplayHeldKeys().size) {
        settleLiveReplays()
        renderLive(state.snapshot)
      }
      return
    }
    const focus = liveFocusPlace(state.snapshot)
    if (!focus) return
    const children = liveChildren(state.snapshot, focus)
    const renderContext = livePlotDetailContext?.snapshot === state.snapshot &&
      livePlotDetailContext.focus.id === focus.id
      ? livePlotDetailContext
      : null
    const residentIndex = liveRenderResidentIndex(state.snapshot, renderContext)
    const now = Date.now()
    const queues = Object.fromEntries(Object.entries(state.live.replayQueues)
      .map(([actor, queue]) => [actor, [...queue]]))
    const active = { ...state.live.replayActive }
    const positions = { ...state.live.replayPositions }
    const trailStarts = { ...state.live.trailStarts }
    const replayReadyAtByActor = { ...state.live.replayReadyAtByActor }
    const revealed = new Set(state.live.replayRevealedKeys)
    const starts = []
    let nextReadyAt = Number.POSITIVE_INFINITY
    let changed = false

    const queuedCount = Object.values(queues).reduce((total, queue) => total + queue.length, 0)
    const longestActorQueue = Math.max(
      0,
      ...Object.values(queues).map(queue => queue.length),
    )
    const busyReplay = queuedCount + Object.keys(active).length > 12
    const pace = windowLiveReplayPace(
      queuedCount + Object.keys(active).length,
      Math.max(1, (state.live.nextReadAt || now + 25_000) - now),
    )
    const busyDurationCap = Object.keys(queues).length * 2 >= Math.max(1, queuedCount)
      ? Math.max(1_200, pace.actionDurationMs)
      : pace.actionDurationMs

    const unscheduledActors = Object.keys(queues).filter(actor =>
      !active[actor] && !Object.hasOwn(replayReadyAtByActor, actor))
    if (unscheduledActors.length) {
      const unscheduled = new Set(unscheduledActors)
      const offsets = windowLiveReplayStartOffsets(
        Object.entries(queues).flatMap(([actor, queue]) =>
          unscheduled.has(actor) ? queue : []),
        Math.max(1, (state.live.nextReadAt || now + 25_000) - now),
      )
      for (const actor of unscheduledActors) {
        replayReadyAtByActor[actor] = now + (offsets[actor] || 0)
      }
      changed = true
    }

    for (const actor of Object.keys(queues)) {
      if (active[actor]) continue
      const readyAt = Number(replayReadyAtByActor[actor]) || 0
      if (readyAt > now) {
        nextReadyAt = Math.min(nextReadyAt, readyAt)
        continue
      }
      if (state.resident && actor !== state.resident) {
        for (const record of queues[actor]) revealed.add(liveTraceKey(record))
        delete queues[actor]
        delete positions[actor]
        delete replayReadyAtByActor[actor]
        changed = true
        continue
      }
      let queue = windowLiveReplayOrder(queues[actor], Number.NEGATIVE_INFINITY)
        .filter(record => liveRecordIsRecent(record, now))
      if (queue.length !== queues[actor].length) changed = true
      while (queue.length) {
        const record = queue[0]
        const type = liveRecordType(record)
        const key = liveTraceKey(record)
        const point = liveReplayPoint(
          liveRecordPlaceId(record), focus, children, renderContext)
        if (type === 'note' && point) {
          const noteId = record.detail.note_id
          const entry = state.live.noteBodies[String(noteId)]
          if (!entry) {
            if (noteId) void loadLiveNote(noteId)
            break
          }
          if (entry.loading) break
        }

        if (type === 'move') {
          const resident = residentIndex.residentByHandle(actor)
          const geometry = resident
            ? liveReplayMoveGeometry(
                record, state.snapshot, focus, children, renderContext)
            : null
          if (!geometry) {
            queue = queue.slice(1)
            changed = true
            revealed.add(key)
            continue
          }
          const fromPlaceId = record.detail.from_place_id
          const distance = Math.hypot(
            geometry.to.x - geometry.from.x,
            geometry.to.y - geometry.from.y,
          )
          const remainingLifetime = record.at.getTime() + liveRecordLifetime(record) - now
          const naturalDuration = windowLiveReplayDuration(distance, remainingLifetime)
          const pacedDurationCap = longestActorQueue > 1
            ? Math.max(3_200, pace.actionDurationMs)
            : Number.POSITIVE_INFINITY
          const duration = Math.min(
            naturalDuration,
            busyReplay ? busyDurationCap || Number.POSITIVE_INFINITY : pacedDurationCap,
          )
          if (!duration) {
            queue = queue.slice(1)
            changed = true
            revealed.add(key)
            continue
          }
          queue = queue.slice(1)
          changed = true
          revealed.add(key)
          positions[actor] = fromPlaceId
          trailStarts[key] = Date.now()
          active[actor] = Object.freeze({
            key, record, type,
            fromPlaceId,
            toPlaceId: record.detail.to_place_id,
            startedAt: Date.now(), duration,
          })
          starts.push(Object.freeze({ actor, key, duration }))
          break
        }

        queue = queue.slice(1)
        changed = true
        revealed.add(key)
        const canReplayHere = point && (type !== 'use' ||
          liveReplayThingIsDisplayed(
            record, state.snapshot, focus, children, renderContext))
        if (!canReplayHere) continue
        const naturalDuration = type === 'note' ? LIVE_NOTE_REPLAY_MS : LIVE_PULSE_MS
        const ordinaryDurationCap = longestActorQueue > 1
          ? Math.max(LIVE_PULSE_MS, pace.actionDurationMs)
          : Number.POSITIVE_INFINITY
        const duration = Math.min(
          naturalDuration,
          busyReplay ? busyDurationCap || Number.POSITIVE_INFINITY : ordinaryDurationCap,
        )
        const remainingLifetime = record.at.getTime() + liveRecordLifetime(record) - now
        if (remainingLifetime < duration) continue
        active[actor] = Object.freeze({
          key, record, type, placeId: liveRecordPlaceId(record),
          startedAt: Date.now(), duration,
        })
        starts.push(Object.freeze({ actor, key, duration }))
        break
      }
      if (queue.length) queues[actor] = Object.freeze(queue)
      else delete queues[actor]
      if (!active[actor] && !queue.length) {
        delete positions[actor]
        delete replayReadyAtByActor[actor]
      }
    }
    if (!changed) {
      if (Number.isFinite(nextReadyAt)) {
        liveReplayStartTimer = window.setTimeout(
          startLiveReplays,
          Math.max(0, nextReadyAt - Date.now()) + 1,
        )
      }
      return
    }
    state = { ...state, live: {
      ...state.live,
      replayQueues: Object.freeze(queues),
      replayActive: Object.freeze(active),
      replayPositions: Object.freeze(positions),
      replayReadyAtByActor: Object.freeze(replayReadyAtByActor),
      trailStarts: Object.freeze(trailStarts),
      replayRevealedKeys: Object.freeze([...revealed]),
    } }
    renderLive(state.snapshot)
    for (const start of starts) {
      window.setTimeout(() => queueLiveReplayCompletion(start.actor, start.key), start.duration)
    }
    if (Number.isFinite(nextReadyAt)) {
      liveReplayStartTimer = window.setTimeout(
        startLiveReplays,
        Math.max(0, nextReadyAt - Date.now()) + 1,
      )
    }
  }

  function renderLiveReplayPortraits(
    layer,
    snapshot,
    focus,
    children,
    bubbles,
    renderContext = null,
  ) {
    const residentIndex = liveRenderResidentIndex(snapshot, renderContext)
    for (const [actor, placeId] of Object.entries(state.live.replayPositions)) {
      if (state.resident && actor !== state.resident) continue
      const resident = residentIndex.residentByHandle(actor)
      if (!resident) continue
      const held = state.live.replayActive[actor]
      // Fourth review pass on row 75: a replaying portrait names its actor
      // in dataset/title/aria-label and animates them across the plate —
      // skip it whenever their tracked position, or the destination of an
      // in-progress move, is quiet, the same way liveVisibleResidentsAt
      // withholds a quiet resident from every other Live surface.
      if (isQuietPlace(placeReference(snapshot, placeId))) continue
      if (held?.type === 'move' &&
        isQuietPlace(placeReference(snapshot, held.record.detail.to_place_id))) continue
      let point = liveResidentReplayPoint(
        snapshot, placeId, actor, focus, children, renderContext)
      let destination = null
      let remaining = 0
      if (held?.type === 'move') {
        const geometry = liveReplayMoveGeometry(
          held.record, snapshot, focus, children, renderContext)
        if (!geometry) continue
        const progress = Math.max(0, Math.min(1,
          (Date.now() - held.startedAt) / held.duration))
        point = Object.freeze({
          x: geometry.from.x + (geometry.to.x - geometry.from.x) * progress,
          y: geometry.from.y + (geometry.to.y - geometry.from.y) * progress,
        })
        destination = geometry.to
        remaining = Math.max(0, held.duration - (Date.now() - held.startedAt))
      }
      if (!point) continue
      const portrait = element('button', resident.asleep
        ? 'live-portrait asleep'
        : 'live-portrait')
      portrait.type = 'button'
      portrait.dataset.focusKey = 'live-resident:' + actor
      portrait.dataset.liveResidentHandle = actor
      portrait.title = state.live.focusResident === actor
        ? 'Clear focus from ' + actor
        : 'Focus on ' + actor
      portrait.setAttribute('aria-label', portrait.title)
      portrait.setAttribute('aria-pressed', String(state.live.focusResident === actor))
      const shell = livePortraitShell(
        portrait,
        bubbles.get(actor),
        'live-portrait-wrap live-replay-portrait',
      )
      shell.dataset.liveReplayKey = held?.key || ''
      if (state.live.focusResident === actor) {
        shell.setAttribute('data-live-focus-resident', actor)
      }
      if (held) {
        shell.dataset.liveAt = String(held.record.at.getTime())
        shell.dataset.liveLifetime = String(liveRecordLifetime(held.record))
      }
      shell.style.left = String(point.x) + 'px'
      shell.style.top = String(point.y) + 'px'
      if (destination && remaining > 0) {
        shell.style.setProperty('--live-replay-delta-x', String(destination.x - point.x) + 'px')
        shell.style.setProperty('--live-replay-delta-y', String(destination.y - point.y) + 'px')
        shell.style.animationDuration = String(remaining) + 'ms'
        shell.dataset.fromPlaceId = String(held.fromPlaceId)
        shell.dataset.toPlaceId = String(held.toPlaceId)
        shell.dataset.replayDuration = String(held.duration)
      }
      portrait.addEventListener('click', () => toggleLiveFocusResident(actor))
      portrait.append(portraitNode(
        'resident', resident.id, actor, resident.has_drawing, 'live-entity-portrait',
      ))
      layer.append(shell)
    }
  }

`
