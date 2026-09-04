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

  function liveRoutePoints(points) {
    return Object.freeze(points.filter(point => point &&
      [point.x, point.y].every(Number.isFinite)).filter((point, index, held) =>
      index === 0 || point.x !== held[index - 1].x || point.y !== held[index - 1].y))
  }

  function liveRouteLength(points) {
    return points.slice(1).reduce((total, point, index) =>
      total + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0)
  }

  function liveRoutePoint(points, requestedProgress) {
    if (!points.length) return null
    if (points.length === 1) return points[0]
    const progress = Math.max(0, Math.min(1, Number(requestedProgress) || 0))
    const length = liveRouteLength(points)
    if (!(length > 0)) return points.at(-1)
    const target = length * progress
    let covered = 0
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]
      const to = points[index]
      const segment = Math.hypot(to.x - from.x, to.y - from.y)
      if (covered + segment >= target || index === points.length - 1) {
        const local = segment > 0 ? (target - covered) / segment : 1
        return Object.freeze({
          x: from.x + (to.x - from.x) * Math.max(0, Math.min(1, local)),
          y: from.y + (to.y - from.y) * Math.max(0, Math.min(1, local)),
        })
      }
      covered += segment
    }
    return points.at(-1)
  }

  function liveRouteSlice(points, requestedStart, requestedEnd) {
    if (points.length < 2) return liveRoutePoints(points)
    const start = Math.max(0, Math.min(1, Number(requestedStart) || 0))
    const end = Math.max(start, Math.min(1, Number(requestedEnd) || 0))
    const length = liveRouteLength(points)
    if (!(length > 0)) return liveRoutePoints([points[0], points.at(-1)])
    const sliced = [liveRoutePoint(points, start)]
    let covered = 0
    for (let index = 1; index < points.length - 1; index += 1) {
      covered += Math.hypot(
        points[index].x - points[index - 1].x,
        points[index].y - points[index - 1].y,
      )
      const progress = covered / length
      if (progress > start && progress < end) sliced.push(points[index])
    }
    sliced.push(liveRoutePoint(points, end))
    return liveRoutePoints(sliced)
  }

  function livePlateBoundaryPoint(point, survey) {
    if (!point) return null
    const inset = 12
    const choices = Object.freeze([
      Object.freeze({ distance: Math.abs(point.x), x: inset, y: point.y }),
      Object.freeze({ distance: Math.abs(survey.width - point.x),
        x: survey.width - inset, y: point.y }),
      Object.freeze({ distance: Math.abs(point.y), x: point.x, y: inset }),
      Object.freeze({ distance: Math.abs(survey.height - point.y),
        x: point.x, y: survey.height - inset }),
    ])
    const closest = [...choices].sort((left, right) => left.distance - right.distance)[0]
    return Object.freeze({
      x: Math.max(inset, Math.min(survey.width - inset, closest.x)),
      y: Math.max(inset, Math.min(survey.height - inset, closest.y)),
    })
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
    const recordedFrom = liveResidentReplayPoint(
      snapshot,
      record.detail.from_place_id,
      record.actor,
      focus,
      children,
      renderContext,
    )
    const recordedTo = liveResidentReplayPoint(
      snapshot,
      record.detail.to_place_id,
      record.actor,
      focus,
      children,
      renderContext,
    )
    if (!recordedFrom && !recordedTo) return null
    const survey = renderContext?.survey || liveStageSurvey(livePlaceRows(snapshot), focus.id)
    const from = recordedFrom || livePlateBoundaryPoint(recordedTo, survey)
    const to = recordedTo || livePlateBoundaryPoint(recordedFrom, survey)
    if (!from || !to || (from.x === to.x && from.y === to.y)) return null
    const fromDoor = recordedFrom
      ? liveReplayPoint(record.detail.from_place_id, focus, children, renderContext)
      : from
    const toDoor = recordedTo
      ? liveReplayPoint(record.detail.to_place_id, focus, children, renderContext)
      : to
    const points = liveRoutePoints([from, fromDoor, toDoor, to])
    return Object.freeze({ from, to, points, distance: liveRouteLength(points) })
  }

  function liveRenderedReplayPoint(actor) {
    const portrait = nodes.livePlates?.querySelector(
      '.live-replay-portrait [data-live-resident-handle="' + CSS.escape(actor) + '"]')
    const shell = portrait?.closest('.live-replay-portrait')
    if (!shell || !nodes.liveStage) return null
    const stageBox = nodes.liveStage.getBoundingClientRect()
    const shellBox = shell.getBoundingClientRect()
    const stageWidth = Number(nodes.liveStage.dataset.liveStageWidth)
    const scale = stageWidth > 0 ? stageBox.width / stageWidth : 0
    if (!(scale > 0)) return null
    return Object.freeze({
      x: (shellBox.left + shellBox.width / 2 - stageBox.left) / scale,
      y: (shellBox.bottom - stageBox.top) / scale,
    })
  }

  function liveMovementPresentations(snapshot, focus, children, renderContext, now) {
    const base = Object.entries(state.live.replayActive).flatMap(([actor, held], order) => {
      if (held.type !== 'move') return []
      const geometry = liveReplayMoveGeometry(
        held.record, snapshot, focus, children, renderContext)
      if (!geometry) return []
      const progress = Math.max(0, Math.min(1,
        (now - held.startedAt) / Math.max(1, held.duration)))
      const point = liveRoutePoint(geometry.points, progress)
      return point ? [Object.freeze({ actor, held, geometry, progress, point, order })] : []
    })
    const viewport = liveCameraViewport()
    const center = viewport ? Object.freeze({
      x: (viewport.left + viewport.right) / 2,
      y: (viewport.top + viewport.bottom) / 2,
    }) : Object.freeze({ x: 0, y: 0 })
    const hovered = [...(nodes.livePlates?.querySelectorAll(
      '.live-portrait:hover, .live-portrait:focus') || [])].flatMap(node =>
      node.dataset.liveResidentHandle ? [node.dataset.liveResidentHandle] : [])
    const selected = windowLiveDetailMoverSelection(
      base.map(movement => Object.freeze({
        actor: movement.actor, x: movement.point.x, y: movement.point.y,
        order: movement.order,
      })),
      Object.freeze([state.resident, ...hovered].filter(Boolean)),
      center,
      LIVE_DETAIL_MOVER_LIMIT,
    )
    liveDetailedMoveActors = new Set(selected.detailed)
    const result = new Map()
    for (const movement of base) {
      const detailed = liveDetailedMoveActors.has(movement.actor)
      const canonical = detailed
        ? movement.geometry.points
        : Object.freeze([movement.geometry.from, movement.geometry.to])
      const canonicalPoint = liveRoutePoint(canonical, movement.progress)
      const renderedPoint = liveRenderedReplayPoint(movement.actor)
      const remainder = liveRouteSlice(canonical, movement.progress, 1)
      const points = liveRoutePoints([
        renderedPoint || canonicalPoint,
        ...remainder.slice(1),
      ])
      const visibleIntervals = viewport
        ? windowLiveRouteVisibilityIntervals(canonical, viewport, 56)
        : Object.freeze([])
      const visible = visibleIntervals.some(interval =>
        movement.progress >= interval.start && movement.progress <= interval.end)
      result.set(movement.actor, Object.freeze({
        ...movement, detailed, points, visible, visibleIntervals,
        remaining: Math.max(0,
          movement.held.startedAt + movement.held.duration - now),
      }))
    }
    return result
  }

  function scheduleLiveReplayVisibility(movements) {
    window.clearTimeout(liveReplayVisibilityTimer)
    liveReplayVisibilityTimer = 0
    if (document.hidden || !livePanelIsVisible()) return
    const now = Date.now()
    const waits = [...movements.values()].flatMap(movement =>
      movement.visibleIntervals.flatMap(interval => [interval.start, interval.end])
        .filter(progress => progress > movement.progress)
        .map(progress => movement.held.startedAt + movement.held.duration * progress - now))
      .filter(wait => wait >= 0)
    const wait = Math.min(...waits)
    if (!Number.isFinite(wait)) return
    liveReplayVisibilityTimer = window.setTimeout(() => {
      liveReplayVisibilityTimer = 0
      scheduleLiveMotionRedraw()
    }, Math.max(0, wait) + 16)
  }

  function armLiveReplayCompletionTimer() {
    window.clearTimeout(liveReplayCompletionTimer)
    liveReplayCompletionTimer = 0
    const nextDeadline = Math.min(...liveReplayCompletionDeadlines.map(entry => entry.at))
    if (!Number.isFinite(nextDeadline) || document.hidden || !livePanelIsVisible()) return
    liveReplayCompletionTimer = window.setTimeout(
      flushScheduledLiveReplayCompletions,
      Math.max(0, nextDeadline + LIVE_REPLAY_COMPLETION_BATCH_MS - Date.now()) + 1,
    )
  }

  function scheduleLiveReplayCompletions(starts) {
    if (!starts.length) return
    const actors = new Set(starts.map(start => start.actor))
    liveReplayCompletionDeadlines = Object.freeze([
      ...liveReplayCompletionDeadlines.filter(entry => !actors.has(entry.actor)),
      ...starts.map(start => Object.freeze({
        actor: start.actor,
        key: start.key,
        at: Number(state.live.replayActive[start.actor]?.startedAt || Date.now()) +
          start.duration,
      })),
    ])
    armLiveReplayCompletionTimer()
  }

  function flushScheduledLiveReplayCompletions() {
    liveReplayCompletionTimer = 0
    const now = Date.now()
    const completions = liveReplayCompletionDeadlines.filter(entry => entry.at <= now)
    liveReplayCompletionDeadlines = Object.freeze(
      liveReplayCompletionDeadlines.filter(entry => entry.at > now))
    flushLiveReplayCompletions(completions)
    armLiveReplayCompletionTimer()
  }

  function flushLiveReplayCompletions(completions) {
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
    if (state.view === 'live' && state.snapshot) markLiveDirty()
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
        if (state.view === 'live' && state.snapshot) markLiveDirty()
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
        markLiveDirty()
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
    markLiveDirty()
    scheduleLiveReplayCompletions(starts)
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
    movements,
    renderContext = null,
  ) {
    const residentIndex = liveRenderResidentIndex(snapshot, renderContext)
    for (const [actor, placeId] of Object.entries(state.live.replayPositions)) {
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
      let movement = null
      if (held?.type === 'move') {
        movement = movements.get(actor)
        if (!movement?.visible) continue
        point = movement.points[0]
        destination = movement.points.at(-1)
        remaining = movement.remaining
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
        movement && !movement.detailed ? null : bubbles.get(actor),
        'live-portrait-wrap live-replay-portrait',
      )
      shell.dataset.liveReplayKey = held?.key || ''
      // Round-1 review finding #2: this walking portrait was never wired
      // to bindLiveItemPopover, so a resident's facts went unreachable for
      // the whole 3.2-8s walk. The item key matches the settled
      // .live-walker's own key ('resident:<handle>', set in
      // 21-live-pinning-and-portrait-grid.ts), so the popover binds once
      // on open/focus and needs no per-frame work: positionLiveItemPopover
      // only reruns on the already-rAF-batched camera commit, and when the
      // walk ends the next render swaps this replay portrait for the
      // settled walker under the identical key, so syncLiveItemPopoverAnchor
      // (27-live-render.ts) re-binds the same open popover to it rather
      // than closing it -- and closes it as usual (C5) if the resident
      // instead leaves the plate entirely.
      const itemKey = 'resident:' + actor
      shell.dataset.liveItemKey = itemKey
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
        shell.dataset.liveMovement = movement.detailed ? 'detail' : 'simple'
        if (movement.detailed) {
          const path = movement.points.map((routePoint, index) =>
            (index ? 'L ' : 'M ') + String(routePoint.x) + ' ' + String(routePoint.y)).join(' ')
          shell.style.left = '0px'
          shell.style.top = '0px'
          shell.style.offsetPath = 'path("' + path + '")'
          shell.style.offsetDistance = '0%'
          shell.style.offsetAnchor = '50% 100%'
          shell.style.offsetRotate = '0deg'
          shell.style.transform = 'none'
          shell.style.animationName = 'live-recorded-route'
          shell.dataset.liveRoutePointCount = String(movement.geometry.points.length)
        } else {
          shell.style.setProperty(
            '--live-replay-delta-x', String(destination.x - point.x) + 'px')
          shell.style.setProperty(
            '--live-replay-delta-y', String(destination.y - point.y) + 'px')
        }
        shell.style.animationDuration = String(remaining) + 'ms'
        shell.dataset.fromPlaceId = String(held.fromPlaceId)
        shell.dataset.toPlaceId = String(held.toPlaceId)
        shell.dataset.replayDuration = String(held.duration)
      }
      portrait.addEventListener('click', () => toggleLiveFocusResident(actor))
      bindLiveItemPopover(portrait, itemKey, 'resident', () => resident)
      portrait.append(liveSpriteNode(
        'resident', resident.id, actor, resident.has_drawing,
      ))
      layer.append(shell)
    }
    scheduleLiveReplayVisibility(movements)
  }

`
