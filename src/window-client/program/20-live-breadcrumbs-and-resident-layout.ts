export const PART_20_LIVE_BREADCRUMBS_AND_RESIDENT_LAYOUT = `  function liveFocusPlace(snapshot) {
    const chosen = selectedPlace(snapshot)
    if (chosen) return chosen
    const places = livePlaceRows(snapshot)
    if (state.placeId) {
      const surveyed = places.find(place => place.id === state.placeId)
      if (surveyed) return placeReference(snapshot, surveyed.id) || surveyed
    }
    const resident = selectedResident(snapshot)
    if (!state.placeId && resident?.current_place_id) {
      const surveyed = places.find(place => place.id === resident.current_place_id)
      if (surveyed) return placeReference(snapshot, surveyed.id) || surveyed
    }
    const world = places.find(place => place.parent_id === null && place.name === WORLD_ROOT_NAME)
    return world || places.find(place => place.parent_id === null) || snapshot.places[0] || null
  }

  function liveChildren(snapshot, focus) {
    return windowLivePlateChildren(livePlaceRows(snapshot), focus.id).map(place =>
      placeReference(snapshot, place.id) || place)
  }

  function livePath(snapshot, focus) {
    const places = livePlaceRows(snapshot)
    const byId = new Map(places.map(place => [place.id, place]))
    const path = []
    const seen = new Set()
    let current = focus
    while (current && !seen.has(current.id) && path.length < 32) {
      path.push(placeReference(snapshot, current.id) || current)
      seen.add(current.id)
      current = current.parent_id ? byId.get(current.parent_id) || null : null
    }
    return path.reverse()
  }

  function renderLiveBreadcrumbs(snapshot, focus) {
    if (!nodes.liveBreadcrumbs) return
    const parts = []
    livePath(snapshot, focus).forEach((place, index, path) => {
      const button = element('button', 'live-breadcrumb', place.name)
      button.type = 'button'
      button.dataset.focusKey = 'live-breadcrumb:' + String(place.id)
      button.setAttribute('aria-current', index === path.length - 1 ? 'location' : 'false')
      button.addEventListener('click', () => navigate({ view: 'live', placeId: place.id }))
      parts.push(button)
      if (index < path.length - 1) parts.push(element('span', 'live-breadcrumb-separator', '/'))
    })
    nodes.liveBreadcrumbs.replaceChildren(...parts)
  }

  function liveSpeechBubbles(records) {
    const bubbles = new Map()
    const claimedActors = new Set()
    for (const record of records) {
      if (liveRecordType(record) !== 'note' || !liveReplayRecordIsRevealed(record) ||
          liveIsRecordResidue(record) || claimedActors.has(record.actor)) continue
      claimedActors.add(record.actor)
      const noteId = record.detail.note_id
      const entry = state.live.noteBodies[String(noteId)]
      if (!entry && noteId) void loadLiveNote(noteId)
      if (!entry?.body) continue
      bubbles.set(record.actor, Object.freeze({
        record,
        text: windowLiveSpeechLine(entry.body),
      }))
    }
    return bubbles
  }

  function liveSpeechBubbleNode(bubble) {
    const node = element('span', 'live-speech-bubble', bubble.text)
    node.setAttribute('aria-hidden', 'true')
    node.dataset.liveAt = String(bubble.record.at.getTime())
    node.dataset.liveLifetime = String(LIVE_NOTE_LIFETIME_MS)
    node.style.opacity = String(windowLiveTraceOpacity(
      bubble.record.at.getTime(), Date.now(), LIVE_NOTE_LIFETIME_MS))
    return node
  }

  function livePortraitShell(portrait, bubble, className = 'live-portrait-wrap') {
    const shell = element('span', className)
    shell.append(portrait)
    if (bubble && !liveMotionReduced()) shell.append(liveSpeechBubbleNode(bubble))
    return shell
  }

  function liveDirectGroundHeight(placeId, width) {
    let height = 680
    if (!state.snapshot) return height
    if (state.live.expandedResidentPlaceIds.includes(placeId)) {
      const residents = displayedResidents(state.snapshot).filter(resident =>
        resident.current_place_id === placeId &&
        (!state.resident || resident.handle === state.resident))
      height = windowLiveScatterSurfaceHeight(
        height, width, residents.length, 56, 56, 12)
    }
    if (state.live.expandedThingPlaceIds.includes(placeId)) {
      const things = historyEntry('things', liveThingFilters(placeId)).rows
        .filter(thing => thing.place_id === placeId)
      height = windowLiveScatterSurfaceHeight(
        height, width, things.length, 144, 56, 12, true)
    }
    return Math.max(680, height)
  }

  function liveCreateRenderContext(
    snapshot,
    focus,
    children,
    survey,
  ) {
    const values = new Map()
    return Object.freeze({
      snapshot,
      focus,
      children,
      survey,
      expandedGrounds: survey.expandedGrounds,
      remember(key, build) {
        if (values.has(key)) return values.get(key)
        const value = build()
        values.set(key, value)
        return value
      },
    })
  }

  function liveRenderResidentIndex(snapshot, renderContext = null) {
    const build = () => {
      const residents = Object.freeze(displayedResidents(snapshot))
      const byHandle = new Map(residents.map(resident => [resident.handle, resident]))
      const byId = new Map(residents.map(resident => [resident.id, resident]))
      return Object.freeze({
        residents,
        residentByHandle: handle => byHandle.get(handle) || null,
        residentById: id => byId.get(id) || null,
      })
    }
    return renderContext
      ? renderContext.remember('resident-index', build)
      : build()
  }

  function liveResidentLayout(
    residents,
    placeId,
    focus,
    children,
    pinnedIds,
    renderContext = null,
    cacheable = true,
    persistPoints = true,
    persistVisibleIds = persistPoints,
    surfaceLayout = null,
  ) {
    if (renderContext && cacheable) {
      const key = 'resident-layout:' + String(persistPoints) + ':' +
        String(persistVisibleIds) + ':' +
        String(placeId) + ':' +
        residents.map(resident => resident.id).join(',') + ':' +
        (pinnedIds || []).join(',') + ':' +
        (surfaceLayout
          ? [surfaceLayout.surfaceWidth, surfaceLayout.surfaceHeight,
              surfaceLayout.inlineOffsetY].join(',')
          : '')
      return renderContext.remember(key, () => liveResidentLayout(
        residents,
        placeId,
        focus,
        children,
        pinnedIds,
        renderContext,
        false,
        persistPoints,
        persistVisibleIds,
        surfaceLayout,
      ))
    }
    const ordered = [...residents.filter(resident => !resident.asleep),
      ...residents.filter(resident => resident.asleep)]
    const isRoot = placeId === focus.id
    const plot = isRoot ? null : windowLiveSurveyedPlots(children, focus.id)
      .find(candidate => candidate.id === placeId)
    if (!isRoot && !plot) {
      return Object.freeze({ visible: [], hidden: ordered, overflowCount: ordered.length,
        badgePoint: null })
    }
    const expanded = state.live.expandedResidentPlaceIds.includes(placeId)
    const rootExpanded = isRoot && (
      state.live.expandedResidentPlaceIds.includes(placeId) ||
      state.live.expandedThingPlaceIds.includes(placeId)
    )
    const overflowing = !expanded && ordered.length > LIVE_PORTRAIT_LIMIT
    const capacity = overflowing
      ? Math.max(0, LIVE_PORTRAIT_LIMIT - 2)
      : expanded ? ordered.length : LIVE_PORTRAIT_LIMIT
    const preferredIds = Array.isArray(liveResidentVisibleIdsByPlaceId[String(placeId)])
      ? liveResidentVisibleIdsByPlaceId[String(placeId)]
      : []
    const selection = windowLiveCapacitySelection(
      ordered,
      capacity,
      pinnedIds || [],
      ordered.length,
      preferredIds,
    )
    const visibleResidents = selection.visible
    const border = focus.parent_id === null ? 4 : 3
    const survey = renderContext?.survey ||
      liveStageSurvey(livePlaceRows(state.snapshot), focus.id)
    const surfaceWidth = surfaceLayout
      ? surfaceLayout.surfaceWidth
      : isRoot
        ? windowLiveDirectGroundWidth(survey.width, LIVE_DIRECT_GROUND_WIDTH)
        : expanded ? 480 : plot.width
    const minimumHeight = isRoot ? 680 : expanded ? 320 : plot.height
    const itemWidth = 56
    const itemHeight = 56
    const thingItemWidth = isRoot ? 144 : 94
    const margin = isRoot ? 12 : 6
    const stablePointHeadroom = expanded && !isRoot
      ? Math.min(
          LIVE_PORTRAIT_LIMIT,
          Object.keys(liveResidentPointsByPlaceId[String(placeId)] || {}).length,
        )
      : 0
    const surfaceHeight = surfaceLayout
      ? surfaceLayout.surfaceHeight
      : isRoot
        ? rootExpanded ? liveDirectGroundHeight(placeId, surfaceWidth) : minimumHeight
        : !expanded
          ? minimumHeight
          : Math.max(
              minimumHeight,
              windowLiveScatterSurfaceHeight(
                0,
                surfaceWidth,
                visibleResidents.length + stablePointHeadroom,
                itemWidth,
                itemHeight,
                margin,
                selection.overflowCount > 0,
              ),
            )
    const reserved = isRoot
      ? windowLiveRootReservations(surfaceWidth, surfaceHeight)
      : Object.freeze([])
    const residentKeys = new Set(ordered.map(resident => String(resident.id)))
    const previous = Object.fromEntries(Object.entries(
      liveResidentPointsByPlaceId[String(placeId)] || {},
    ).filter(([key]) => residentKeys.has(key)))
    const selectedResidentIds = new Set(visibleResidents.map(resident => resident.id))
    const placementIds = Object.freeze([
      ...(pinnedIds || []).filter(id => selectedResidentIds.has(id)),
      ...visibleResidents.map(resident => resident.id)
        .filter(id => !(pinnedIds || []).includes(id)),
    ])
    const separated = windowLiveResidentPointsAroundThings(
      placementIds,
      surfaceWidth,
      surfaceHeight,
      placeId * 17 + 3,
      itemWidth,
      itemHeight,
      margin,
      liveThingPointsByPlaceId[String(placeId)] || Object.freeze({}),
      thingItemWidth,
      reserved,
      previous,
      isRoot || (
        !expanded && !state.live.expandedThingPlaceIds.includes(placeId)
      ),
    )
    if (persistPoints) {
      liveResidentPointsByPlaceId = Object.freeze({
        ...liveResidentPointsByPlaceId,
        [String(placeId)]: separated,
      })
    }
    const expandedGround = !isRoot && expanded
      ? survey.expandedGrounds[String(placeId)] || null
      : null
    const inlineOffsetY = surfaceLayout
      ? surfaceLayout.inlineOffsetY
      : expandedGround?.residentTop
        ? expandedGround.residentTop - plot.y
        : 0
    const visible = Object.freeze(visibleResidents.flatMap(resident => {
      const localPoint = separated[String(resident.id)]
      if (!localPoint) return []
      const stagePoint = isRoot
        ? localPoint
        : Object.freeze({
            x: plot.x + border + localPoint.x,
            y: plot.y + border + inlineOffsetY + localPoint.y,
          })
      return [Object.freeze({ resident, localPoint, stagePoint })]
    }))
    const visibleIds = new Set(visible.map(entry => entry.resident.id))
    if (persistVisibleIds) {
      liveResidentVisibleIdsByPlaceId = Object.freeze({
        ...liveResidentVisibleIdsByPlaceId,
        [String(placeId)]: Object.freeze(visible.map(entry => entry.resident.id)),
      })
    }
    const layout = Object.freeze({
      visible,
      hidden: Object.freeze(ordered.filter(resident => !visibleIds.has(resident.id))),
      overflowCount: Math.max(0, ordered.length - visible.length),
      expanded,
      surfaceWidth,
      surfaceHeight,
      inlineOffsetY,
      badgePoint: isRoot
        ? Object.freeze({ x: surfaceWidth - 58, y: surfaceHeight - 18 })
        : Object.freeze({ x: plot.x + plot.width - 28, y: plot.y + plot.height - 10 }),
    })
    if (renderContext) {
      for (const entry of visible) {
        renderContext.remember(
          'resident-point:' + String(placeId) + ':' + entry.resident.handle,
          () => entry.stagePoint,
        )
      }
    }
    return layout
  }

`
