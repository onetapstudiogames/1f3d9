export const PART_25_LIVE_TRACES_AND_LEDGER = `  function visibleLiveRecords(snapshot, focus, children, renderContext = null) {
    const now = Date.now()
    return liveRecords().filter(record => {
      const type = liveRecordType(record)
      if (!type || (state.resident && record.actor !== state.resident)) return false
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
        lifetime: active.duration + LIVE_TRAIL_LIFETIME_MS,
        duration: active.duration,
        replaying: true,
      })
    }
    const startedAt = Number(state.live.trailStarts[key]) || record.at.getTime()
    return Object.freeze({
      at: startedAt,
      lifetime: LIVE_TRAIL_LIFETIME_MS,
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
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.classList.add('live-traces')
    svg.setAttribute('viewBox', '0 0 ' + String(survey.width) + ' ' + String(survey.height))
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.setAttribute('aria-label', 'Recent movement trails')

    const noteNumbers = new Map(records.map((record, index) => [liveTraceKey(record), index + 1]))
    const trailKeys = new Set(windowLiveSelectTrailKeys(
      records.filter(record => liveRecordType(record) === 'move' &&
        liveReplayRecordIsRevealed(record) && !liveIsRecordResidue(record)).map(liveTraceKey),
      LIVE_TRAIL_DOM_LIMIT,
      [...liveReplayHeldKeys()],
    ))
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
        if (!trailKeys.has(key)) continue
        const geometry = liveReplayMoveGeometry(
          record, snapshot, focus, children, renderContext)
        const from = geometry?.from
        const to = geometry?.to
        if (!from || !to || (from.x === to.x && from.y === to.y)) continue
        const timing = liveTrailTiming(record, key)
        const opacity = windowLiveTraceOpacity(timing.at, Date.now(), timing.lifetime)
        if (opacity <= 0) continue
        const trail = document.createElementNS('http://www.w3.org/2000/svg', 'line')
        trail.classList.add('live-trail')
        if (timing.replaying) trail.classList.add('live-trail-inking')
        trail.setAttribute('x1', String(from.x))
        trail.setAttribute('y1', String(from.y))
        trail.setAttribute('x2', String(to.x))
        trail.setAttribute('y2', String(to.y))
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
          mark.setAttribute('aria-label', 'Open ' + record.actor + "'s note in the notes panel")
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
    layer.prepend(svg)
    renderLiveReplayPortraits(
      layer, snapshot, focus, children, bubbles, renderContext)
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
