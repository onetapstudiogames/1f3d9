export const PART_25_LIVE_TRACES_AND_LEDGER = `  function visibleLiveRecords(snapshot, focus, children, renderContext = null) {
    const now = Date.now()
    return liveRecords().filter(record => {
      const type = liveRecordType(record)
      if (!type || (type !== 'move' && state.resident && record.actor !== state.resident)) {
        return false
      }
      if (windowLiveTraceOpacity(record.at.getTime(), now, liveRecordLifetime(record)) <= 0) {
        return false
      }
      if (type === 'move') {
        return Boolean(
          livePlaceAnchor(
            record.detail.from_place_id, focus.id, children, renderContext) ||
          livePlaceAnchor(
            record.detail.to_place_id, focus.id, children, renderContext)
        )
      }
      return Boolean(livePlaceAnchor(
        liveRecordPlaceId(record), focus.id, children, renderContext))
    })
  }

  function bindLiveHighlight(node, key, surface) {
    node.dataset.liveKey = key
    if (!node.dataset.focusKey) node.dataset.focusKey = 'live-record:' + surface + ':' + key
    node.dataset.highlighted = String(state.live.highlightedKey === key)
    node.addEventListener('mouseenter', () => setLiveHighlight(key))
    node.addEventListener('mouseleave', () => setLiveHighlight(null))
    node.addEventListener('focus', () => setLiveHighlight(key))
    node.addEventListener('blur', () => setLiveHighlight(null))
    node.addEventListener('click', () => setLiveHighlight(
      state.live.highlightedKey === key ? null : key))
  }

  function liveTrailTiming(record, key) {
    const active = Object.values(state.live.replayActive).find(candidate =>
      candidate.type === 'move' && candidate.key === key)
    if (active) {
      return Object.freeze({
        at: active.startedAt,
        lifetime: active.duration + LIVE_FOLLOW_TRAIL_LIFETIME_MS,
        duration: active.duration,
        replaying: true,
      })
    }
    const startedAt = Number(state.live.trailStarts[key]) || record.at.getTime()
    return Object.freeze({
      at: startedAt,
      lifetime: LIVE_FOLLOW_TRAIL_LIFETIME_MS,
      duration: 0,
      replaying: false,
    })
  }

  function scheduleLiveTrailExpiry() {
    window.clearTimeout(liveTrailExpiryTimer)
    liveTrailExpiryTimer = 0
    if (state.view !== 'live' || !nodes.livePlates) return
    const trails = [...nodes.livePlates.querySelectorAll('.live-trail')]
    const nextExpiry = Math.min(...trails.map(trail =>
      Number(trail.dataset.liveAt) + Number(trail.dataset.liveLifetime)))
    if (!Number.isFinite(nextExpiry)) return
    liveTrailExpiryTimer = window.setTimeout(() => {
      liveTrailExpiryTimer = 0
      const now = Date.now()
      for (const trail of nodes.livePlates?.querySelectorAll('.live-trail') || []) {
        if (Number(trail.dataset.liveAt) + Number(trail.dataset.liveLifetime) > now) continue
        const active = document.activeElement
        const movesFocus = active === trail || trail.contains(active)
        const key = trail.dataset.liveKey
        trail.remove()
        if (movesFocus) moveLiveFocusAfterExpiry(key)
      }
      scheduleLiveTrailExpiry()
    }, Math.max(0, nextExpiry - Date.now()) + 1)
  }

  function emitLiveFootsteps(movements, now = Date.now()) {
    let marks = liveFootstepMarks.filter(mark =>
      now - mark.bornAt < LIVE_FOOTSTEP_LIFETIME_MS)
    const detailedMovements = [...movements.values()].filter(movement =>
      movement.detailed && movement.visible)
    const threeMarkCount = Math.max(0,
      LIVE_FOOTSTEP_VISUAL_LIMIT - detailedMovements.length * 2)
    const markLimitByKey = new Map(detailedMovements.map((movement, index) => [
      movement.held.key + '\u0000' + movement.actor,
      index < threeMarkCount ? 3 : 2,
    ]))
    const activeKeys = new Set([...movements.values()].map(movement => movement.held.key))
    const lastAtByKey = Object.fromEntries(Object.entries(liveFootstepLastAtByKey)
      .filter(([key]) => activeKeys.has(key)))
    for (const movement of movements.values()) {
      if (!movement.detailed || !movement.visible) continue
      const actorMarks = marks.filter(mark =>
        mark.key === movement.held.key && mark.actor === movement.actor)
      const beat = windowLiveFootstepBeat(
        lastAtByKey[movement.held.key], actorMarks.length, now)
      if (!beat.due) continue
      const samples = (beat.first ? [now - 325, now] : [now]).flatMap(sampleAt => {
        const bornAt = Math.max(movement.held.startedAt, sampleAt)
        const progress = Math.max(0, Math.min(1,
          (bornAt - movement.held.startedAt) / Math.max(1, movement.held.duration)))
        const point = liveRoutePoint(movement.geometry.points, progress)
        return point ? [Object.freeze({ point, bornAt })] : []
      })
      lastAtByKey[movement.held.key] = now
      const markLimit = markLimitByKey.get(
        movement.held.key + '\u0000' + movement.actor) || 2
      const retained = actorMarks.slice(-(markLimit - samples.length))
      marks = [
        ...marks.filter(mark =>
          mark.key !== movement.held.key || mark.actor !== movement.actor),
        ...retained,
        ...samples.map(sample => Object.freeze({
          id: ++liveFootstepSequence,
          key: movement.held.key,
          actor: movement.actor,
          x: sample.point.x,
          y: sample.point.y,
          bornAt: sample.bornAt,
        })),
      ]
    }
    const detailedPairs = new Set(markLimitByKey.keys())
    const detailedMarks = detailedMovements.flatMap(movement => {
      const pair = movement.held.key + '\u0000' + movement.actor
      return marks.filter(mark =>
        mark.key + '\u0000' + mark.actor === pair).slice(-markLimitByKey.get(pair))
    })
    const fadingMarks = marks.filter(mark =>
      !detailedPairs.has(mark.key + '\u0000' + mark.actor))
    const fadingLimit = Math.max(0, LIVE_FOOTSTEP_VISUAL_LIMIT - detailedMarks.length)
    liveFootstepMarks = Object.freeze([
      ...fadingMarks.slice(-fadingLimit),
      ...detailedMarks,
    ].sort((left, right) => left.bornAt - right.bornAt || left.id - right.id))
    liveFootstepLastAtByKey = Object.freeze(lastAtByKey)
  }

  function scheduleLiveFootstepWake(movements) {
    window.clearTimeout(liveFootstepWakeTimer)
    liveFootstepWakeTimer = 0
    if (state.view !== 'live' || document.hidden || !livePanelIsVisible()) return
    const now = Date.now()
    const beatAt = [...movements.values()].flatMap(movement =>
      movement.detailed && movement.visible
        ? [Math.max(now, Number(liveFootstepLastAtByKey[movement.held.key] || 0) + 650)]
        : [])
    const viewport = liveCameraViewport()
    const expiryAt = liveFootstepMarks.filter(mark => viewport &&
      mark.x >= viewport.left - 56 && mark.x <= viewport.right + 56 &&
      mark.y >= viewport.top - 56 && mark.y <= viewport.bottom + 56).map(mark =>
        mark.bornAt + LIVE_FOOTSTEP_LIFETIME_MS)
    const nextAt = Math.min(...beatAt, ...expiryAt)
    if (!Number.isFinite(nextAt)) return
    liveFootstepWakeTimer = window.setTimeout(() => {
      liveFootstepWakeTimer = 0
      scheduleLiveMotionRedraw()
    }, Math.max(0, nextAt - now) + 1)
  }

  function renderLiveTraceLayer(
    snapshot,
    focus,
    children,
    records,
    bubbles,
    survey,
    renderContext = null,
  ) {
    const layer = element('div', 'live-trace-layer')
    const renderNow = Date.now()
    const movements = liveMovementPresentations(
      snapshot, focus, children, renderContext, renderNow)
    emitLiveFootsteps(movements, renderNow)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.classList.add('live-traces')
    svg.setAttribute('viewBox', '0 0 ' + String(survey.width) + ' ' + String(survey.height))
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.setAttribute('aria-label', 'Recent movement trails')

    const noteNumbers = new Map(records.map((record, index) => [liveTraceKey(record), index + 1]))
    for (const record of records) {
      const type = liveRecordType(record)
      const key = liveTraceKey(record)
      if (!liveReplayRecordIsRevealed(record)) continue
      // Fourth review pass on row 75: a trail arrow, note mark, or make/use
      // pulse names its actor in an aria-label and plots at a place the
      // record touches — the same two-place (move) or one-place (everything
      // else) resolution liveLedgerQuietPlace uses for public activity
      // must gate this layer too, or a quiet place's exact plate position
      // and its visitor's handle leak through the trace SVG instead.
      if (liveLedgerQuietPlace(snapshot, record)) continue
      const recordOpacity = windowLiveTraceOpacity(
        record.at.getTime(), Date.now(), liveRecordLifetime(record))
      if (type === 'move') {
        // Quiet opening: trailKeys already excludes any record the viewer
        // was not present for (opening backlog, or the first catch-up
        // after a hidden tab), so it settles at its recorded endpoint with
        // no trail at all.
        if (record.actor !== state.resident || liveIsRecordResidue(record)) continue
        const geometry = liveReplayMoveGeometry(
          record, snapshot, focus, children, renderContext)
        const from = geometry?.from
        const to = geometry?.to
        if (!from || !to || (from.x === to.x && from.y === to.y)) continue
        const viewport = liveCameraViewport()
        if (!viewport || !windowLiveRouteVisibilityIntervals(
          geometry.points, viewport, 56).length) continue
        const timing = liveTrailTiming(record, key)
        const opacity = windowLiveTraceOpacity(timing.at, Date.now(), timing.lifetime)
        if (opacity <= 0) continue
        const trail = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
        trail.classList.add('live-trail')
        if (timing.replaying) trail.classList.add('live-trail-inking')
        trail.setAttribute('points', geometry.points.map(point =>
          String(point.x) + ',' + String(point.y)).join(' '))
        trail.setAttribute('tabindex', '0')
        trail.setAttribute('role', 'button')
        trail.setAttribute('aria-label', record.actor + ' moved from ' +
          String(record.detail.from_place_id) + ' to ' + String(record.detail.to_place_id))
        trail.dataset.liveAt = String(timing.at)
        trail.dataset.liveLifetime = String(timing.lifetime)
        trail.dataset.replaying = String(timing.replaying)
        if (timing.duration) {
          trail.style.setProperty('--live-trail-duration', String(timing.duration) + 'ms')
        }
        trail.style.opacity = String(opacity)
        bindLiveHighlight(trail, key, 'trail')
        svg.append(trail)
        continue
      }
      const placeId = liveRecordPlaceId(record)
      const anchor = livePlaceAnchor(placeId, focus.id, children, renderContext)
      const point = liveAnchorPoint(anchor, focus.id, children)
      if (!point) continue
      if (type === 'note') {
        const mark = element('button', 'live-footnote-mark', String(noteNumbers.get(key)))
        mark.type = 'button'
        mark.style.left = String(point.x) + 'px'
        mark.style.top = String(point.y) + 'px'
        mark.dataset.liveAt = String(record.at.getTime())
        mark.dataset.liveLifetime = String(liveRecordLifetime(record))
        mark.style.opacity = String(recordOpacity)
        mark.setAttribute('aria-label', 'Show ' + record.actor + "'s note in the plate ledger")
        bindLiveHighlight(mark, key, 'mark')
        const bubble = bubbles.get(record.actor)
        if (liveMotionReduced() && bubble?.record === record) {
          mark.dataset.focusKey = 'live-footnote:' + String(record.detail.note_id)
          mark.dataset.focusFallbackKey = 'live-resident:' + record.actor
          mark.setAttribute('aria-label',
            bubble.text + ' (open ' + record.actor + "'s note in the notes panel)")
          mark.addEventListener('click', () => openLiveNotes(placeId, record.detail.note_id, mark))
          mark.append(liveSpeechBubbleNode(bubble, false))
        }
        layer.append(mark)
      } else if (type === 'make' && state.live.replayActive[record.actor]?.key === key) {
        const pulse = element('span', 'live-action-mark live-pulse', type === 'make' ? '+' : '×')
        pulse.style.left = String(point.x) + 'px'
        pulse.style.top = String(point.y) + 'px'
        pulse.setAttribute('role', 'img')
        pulse.setAttribute('aria-label', record.actor + (type === 'make'
          ? ' made something here'
          : ' used something here'))
        bindLiveHighlight(pulse, key, 'pulse')
        layer.append(pulse)
      }
    }
    const footstepViewport = liveCameraViewport()
    for (const mark of liveFootstepMarks) {
      if (!footstepViewport || mark.x < footstepViewport.left - 56 ||
          mark.x > footstepViewport.right + 56 || mark.y < footstepViewport.top - 56 ||
          mark.y > footstepViewport.bottom + 56) continue
      const opacity = windowLiveTraceOpacity(
        mark.bornAt, renderNow, LIVE_FOOTSTEP_LIFETIME_MS)
      if (opacity <= 0) continue
      const footstep = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      footstep.classList.add('live-footstep')
      footstep.setAttribute('cx', String(mark.x))
      footstep.setAttribute('cy', String(mark.y))
      footstep.setAttribute('r', '3.5')
      footstep.dataset.liveActor = mark.actor
      footstep.dataset.liveKey = mark.key
      footstep.dataset.liveAt = String(mark.bornAt)
      footstep.dataset.liveLifetime = String(LIVE_FOOTSTEP_LIFETIME_MS)
      footstep.style.opacity = String(opacity)
      footstep.style.animationDuration = String(LIVE_FOOTSTEP_LIFETIME_MS) + 'ms'
      footstep.style.animationDelay = '-' + String(renderNow - mark.bornAt) + 'ms'
      svg.append(footstep)
    }
    layer.prepend(svg)
    renderLiveReplayPortraits(
      layer, snapshot, focus, children, bubbles, movements, renderContext)
    scheduleLiveFootstepWake(movements)
    return layer
  }

  // Decision #75: a public record can point at up to two places (a move's
  // from and to); if either is quiet it stays off the plate. Returns the
  // quiet place to notice, or null when nothing about this record is quiet.
  function liveLedgerQuietPlace(snapshot, record) {
    if (liveRecordType(record) === 'move') {
      const to = placeReference(snapshot, record.detail.to_place_id)
      if (isQuietPlace(to)) return to
      const from = placeReference(snapshot, record.detail.from_place_id)
      return isQuietPlace(from) ? from : null
    }
    const place = placeReference(snapshot, liveRecordPlaceId(record))
    return isQuietPlace(place) ? place : null
  }

`
