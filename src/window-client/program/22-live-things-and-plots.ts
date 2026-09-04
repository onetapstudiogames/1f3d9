export const PART_22_LIVE_THINGS_AND_PLOTS = `  function liveThingFilters(focusId) {
    return Object.freeze({ placeId: focusId, resident: null })
  }

  // Decision #75, third review pass: unlike residentsAt, nothing downstream
  // of this collector needs the quiet-inclusive raw list — the Live thing
  // shelf has no equivalent to occupantLine's hidden-descendant notice, so
  // filtering here is the whole fix, not just the "includeDescendants=true"
  // half of it. A thing whose own place — resolved at the thing's own row,
  // never at whatever place is being rendered — is quiet must never reach a
  // caller, no matter how many levels below the requested place it sits.
  function liveDisplayedThings(snapshot, placeId, focusId, includeDescendants = false) {
    const placeIds = includeDescendants ? placeScopeSet(placeId, snapshot) : new Set([placeId])
    return historyEntry('things', liveThingFilters(focusId)).rows
      .filter(thing => placeIds.has(thing.place_id) &&
        !isQuietPlace(placeReference(snapshot, thing.place_id)))
  }

  function liveThingSelection(things, pinnedIds, exactTotal, placeId) {
    const total = exactTotal === null ? things.length : exactTotal
    const expanded = state.live.expandedThingPlaceIds.includes(placeId)
    const capacity = expanded
      ? things.length
      : total > LIVE_THING_LIMIT ? LIVE_THING_LIMIT - 1 : LIVE_THING_LIMIT
    const preferredIds = Array.isArray(liveThingVisibleIdsByPlaceId[String(placeId)])
      ? liveThingVisibleIdsByPlaceId[String(placeId)]
      : []
    const selection = windowLiveCapacitySelection(things, capacity, pinnedIds, total, preferredIds)
    liveThingVisibleIdsByPlaceId = Object.freeze({
      ...liveThingVisibleIdsByPlaceId,
      [String(placeId)]: Object.freeze(selection.visible.map(thing => thing.id)),
    })
    return selection
  }

  function liveThingPresentation(
    snapshot,
    placeId,
    records,
    focusId,
    includeDescendants = false,
    interactionThings = null,
    renderContext = null,
    cacheable = true,
  ) {
    if (renderContext && cacheable) {
      const key = 'thing-presentation:' + String(placeId) + ':' +
        String(focusId) + ':' + String(includeDescendants)
      return renderContext.remember(key, () => liveThingPresentation(
        snapshot,
        placeId,
        records,
        focusId,
        includeDescendants,
        interactionThings,
        renderContext,
        false,
      ))
    }
    const things = liveDisplayedThings(snapshot, placeId, focusId, includeDescendants)
    const pinnedIds = livePinnedThingIds(snapshot, records, placeId, interactionThings)
    const exactTotal = liveExactThingTotal(
      snapshot, placeId, things.length, includeDescendants)
    return Object.freeze({
      things,
      pinnedIds,
      exactTotal,
      selection: liveThingSelection(things, pinnedIds, exactTotal, placeId),
    })
  }

  function liveFocusInteractionThings(snapshot, focus, records) {
    const handle = state.live.focusResident
    if (!handle) return Object.freeze([])
    const focused = displayedResidents(snapshot).find(resident => resident.handle === handle)
    const focusScope = placeScopeSet(focus.id, snapshot)
    const things = historyEntry('things', liveThingFilters(focus.id)).rows
    const thingsById = new Map(things.map(thing => [thing.id, thing]))
    const references = new Map()
    const addReference = (id, recordedPlaceId) => {
      if (!id || references.has(id)) return
      const thing = thingsById.get(id)
      const interactionPlaceId = recordedPlaceId || thing?.place_id || null
      if (!interactionPlaceId || !focusScope.has(interactionPlaceId)) return
      references.set(id, Object.freeze({
        id,
        place_id: thing?.place_id || interactionPlaceId,
        recorded_place_id: interactionPlaceId,
        name: thing?.name || null,
        loaded: Boolean(thing),
        has_drawing: thing?.has_drawing === true,
      }))
    }
    const focusRecords = [...new Map([...records, ...liveInteractionRecords()]
      .map(record => [liveTraceKey(record), record])).values()]
      .sort((left, right) => {
        const timeOrder = right.at.getTime() - left.at.getTime()
        if (timeOrder) return timeOrder
        const leftKey = liveTraceKey(left)
        const rightKey = liveTraceKey(right)
        return leftKey < rightKey ? 1 : leftKey > rightKey ? -1 : 0
      })
    for (const record of focusRecords) {
      if (record.kind === 'transfer' && record.detail.asset_type === 'thing') {
        const involvesFocus = record.actor === handle ||
          (focused && record.detail.resident_id === focused.id)
        if (involvesFocus) addReference(record.detail.asset_id, record.detail.place_id)
        continue
      }
      if (record.actor !== handle) continue
      const recordedPlaceId = liveRecordPlaceId(record)
      addReference(record.detail.source_thing_id, recordedPlaceId)
      addReference(record.detail.thing_id, recordedPlaceId)
    }
    return Object.freeze([...references.values()])
  }

  function liveThingShelf(
    snapshot,
    place,
    records,
    focusId,
    includeDescendants = false,
    interactionThings = null,
    renderContext = null,
  ) {
    const presentation = liveThingPresentation(
      snapshot,
      place.id,
      records,
      focusId,
      includeDescendants,
      interactionThings,
      renderContext,
    )
    const { things, pinnedIds, exactTotal, selection } = presentation
    if (!things.length && exactTotal !== null && exactTotal === 0) return null
    if (!things.length && exactTotal === null) return null
    const pinned = new Set(pinnedIds)
    const shelf = element('section', 'live-thing-shelf')
    const expanded = state.live.expandedThingPlaceIds.includes(place.id)
    const entry = historyEntry('things', liveThingFilters(focusId))
    const isRoot = place.id === focusId
    const rootExpanded = isRoot && (
      state.live.expandedResidentPlaceIds.includes(place.id) ||
      state.live.expandedThingPlaceIds.includes(place.id)
    )
    const survey = renderContext?.survey || liveStageSurvey(livePlaceRows(snapshot), focusId)
    const childPlot = isRoot ? null : survey.plots.find(candidate => candidate.id === place.id)
    const itemWidth = isRoot ? 144 : 94
    const itemHeight = 56
    const surfaceWidth = isRoot
      ? windowLiveDirectGroundWidth(survey.width, LIVE_DIRECT_GROUND_WIDTH)
      : expanded ? 480 : childPlot?.width || 440
    const margin = isRoot ? 12 : 6
    const hasOverflow = exactTotal === null
      ? things.length > selection.visible.length
      : selection.overflowCount > 0
    const surfaceHeight = isRoot
      ? rootExpanded ? liveDirectGroundHeight(place.id, surfaceWidth) : 680
      : !expanded
        ? childPlot?.height || 280
        : Math.max(
            320,
            windowLiveScatterSurfaceHeight(
              0,
              surfaceWidth,
              selection.visible.length,
              itemWidth,
              itemHeight,
              margin,
              hasOverflow,
            ),
          )
    const reserved = isRoot
      ? windowLiveRootReservations(surfaceWidth, surfaceHeight)
      : Object.freeze([])
    const thingKeys = new Set(things.map(thing => String(thing.id)))
    const previous = Object.fromEntries(Object.entries(
      liveThingPointsByPlaceId[String(place.id)] || {},
    ).filter(([key]) => thingKeys.has(key)))
    const selectedThingIds = new Set(selection.visible.map(thing => thing.id))
    const placementIds = Object.freeze([
      ...pinnedIds.filter(id => selectedThingIds.has(id)),
      ...selection.visible.map(thing => thing.id).filter(id => !pinned.has(id)),
    ])
    const separated = windowLiveThingPointsAroundResidents(
      placementIds,
      surfaceWidth,
      surfaceHeight,
      place.id * 29 + 11,
      itemWidth,
      itemHeight,
      margin,
      liveResidentPointsByPlaceId[String(place.id)] || Object.freeze({}),
      reserved,
      previous,
      isRoot || (
        !expanded && !state.live.expandedResidentPlaceIds.includes(place.id)
      ),
    )
    liveThingPointsByPlaceId = Object.freeze({
      ...liveThingPointsByPlaceId,
      [String(place.id)]: separated,
    })
    const expandedGround = !isRoot && expanded
      ? survey.expandedGrounds[String(place.id)] || null
      : null
    const inlineOffsetY = expandedGround?.thingTop
      ? expandedGround.thingTop - (childPlot?.y || 0)
      : 0
    if (expanded) shelf.dataset.liveExpanded = 'true'
    shelf.style.width = String(surfaceWidth) + 'px'
    shelf.style.height = String(surfaceHeight) + 'px'
    if (isRoot) {
      shelf.style.inset = '0 auto auto 0'
    } else if (inlineOffsetY) {
      shelf.style.inset = 'auto'
      shelf.style.left = '0'
      shelf.style.top = String(inlineOffsetY) + 'px'
    }
    shelf.setAttribute('aria-label', 'Things shown inside ' + place.name)
    const visibleThings = selection.visible.filter(thing => Boolean(separated[String(thing.id)]))
    liveThingVisibleIdsByPlaceId = Object.freeze({
      ...liveThingVisibleIdsByPlaceId,
      [String(place.id)]: Object.freeze(visibleThings.map(thing => thing.id)),
    })
    for (const thing of visibleThings) {
      const specimen = element('a', 'live-thing-specimen')
      specimen.href = '/api/thing/' + String(thing.id)
      specimen.setAttribute('aria-label', 'Read ' + thing.name)
      specimen.dataset.focusKey = 'live-thing:' + String(thing.id)
      specimen.dataset.liveThingId = String(thing.id)
      specimen.dataset.liveThingPlaceId = String(thing.place_id)
      const point = separated[String(thing.id)]
      specimen.style.left = String(point.x) + 'px'
      specimen.style.top = String(point.y) + 'px'
      const itemKey = 'thing:' + String(thing.id)
      specimen.dataset.liveItemKey = itemKey
      if (state.live.raisedItemKey === itemKey) specimen.dataset.liveRaised = 'true'
      if (pinned.has(thing.id)) specimen.dataset.liveFocusThing = String(thing.id)
      const pulse = Object.values(state.live.replayActive).find(active =>
        active.type === 'use' && active.record.detail.source_thing_id === thing.id &&
        active.record.detail.place_id === thing.place_id)
      if (pulse) {
        specimen.classList.add('live-pulse')
        specimen.dataset.livePulseFor = pulse.key
        bindLiveHighlight(specimen, pulse.key, 'pulse')
      }
      specimen.append(
        liveSpriteNode('thing', thing.id, thing.name, thing.has_drawing),
        element('span', 'live-thing-name live-item-name', thing.name),
      )
      bindLiveActivation(specimen, specimen, itemKey, null)
      bindLiveItemPopover(specimen, itemKey, 'thing', () => thing)
      shelf.append(specimen)
    }
    const overflowCount = selection.overflowCount + selection.visible.length - visibleThings.length
    if (exactTotal === null && (things.length > visibleThings.length || entry.hasMore)) {
      const badge = element('button', 'live-overflow-badge live-thing-more',
        'more · count unavailable')
      badge.type = 'button'
      badge.dataset.focusKey = 'live-thing-overflow:' + String(place.id)
      badge.dataset.liveOverflowPlaceId = String(place.id)
      badge.setAttribute('aria-label', 'Show more things; exact count unavailable')
      badge.setAttribute('aria-busy', String(entry.loading))
      badge.title = 'Some named things are folded here; the exact count is unavailable.'
      if (isRoot) {
        positionLiveRootOverflowControl(badge, 'thing', surfaceWidth, surfaceHeight)
      }
      badge.addEventListener('click', () => {
        requestLiveFocusRestore(
          badge.dataset.focusKey || '', 'live-plates', place.id)
        void expandLiveThings(place.id, focusId)
      })
      shelf.append(badge)
    } else if (overflowCount) {
      const badge = element('button', 'live-overflow-badge live-thing-more',
        '+' + String(overflowCount) + ' more')
      badge.type = 'button'
      badge.dataset.focusKey = 'live-thing-overflow:' + String(place.id)
      badge.dataset.liveOverflowPlaceId = String(place.id)
      badge.setAttribute('aria-label', 'Show ' + String(overflowCount) + ' more things')
      badge.setAttribute('aria-busy', String(entry.loading))
      badge.setAttribute('data-live-overflow-count', String(overflowCount))
      badge.title = String(exactTotal) + ' things here; showing ' +
        String(visibleThings.length)
      if (Object.values(state.live.replayActive).some(active =>
        active.type === 'make' && liveRecordPlaceId(active.record) === place.id)) {
        badge.classList.add('live-overflow-absorbing')
      }
      if (isRoot) {
        positionLiveRootOverflowControl(badge, 'thing', surfaceWidth, surfaceHeight)
      }
      badge.addEventListener('click', () => {
        requestLiveFocusRestore(
          badge.dataset.focusKey || '', 'live-plates', place.id)
        void expandLiveThings(place.id, focusId)
      })
      shelf.append(badge)
    }
    return shelf
  }

  async function expandLiveThings(placeId, focusId) {
    state = { ...state, live: { ...state.live,
      expandedThingPlaceIds: Object.freeze([
        ...new Set([...state.live.expandedThingPlaceIds, placeId]),
      ]),
    } }
    if (state.snapshot) renderLive(state.snapshot)
    const filters = liveThingFilters(focusId)
    const entry = historyEntry('things', filters)
    if (entry.hasMore && !entry.loading) await loadHistory('things', filters)
  }

  function mountLivePlaceDetail(card, renderContext, place) {
    if (card.dataset.liveDetailMounted === 'true') return
    const { snapshot, focus, bubbles, records, interactionThings } = renderContext
    const open = card.querySelector(':scope > .live-plot-open')
    if (!open) return
    const terrain = liveTiledDrawing(place, 'live-plot-terrain', null, card)
    card.prepend(terrain)
    const drawingDetail = openDrawingDetailButton(
      'place',
      place.id,
      place.name,
      'live-plot-drawing-detail drawing-detail-open',
    )
    drawingDetail.style.left = String(LIVE_PLOT_DRAWING_DETAIL_RECT.x) + 'px'
    drawingDetail.style.top = String(LIVE_PLOT_DRAWING_DETAIL_RECT.y) + 'px'
    drawingDetail.style.width = String(LIVE_PLOT_DRAWING_DETAIL_RECT.width) + 'px'
    drawingDetail.style.height = String(LIVE_PLOT_DRAWING_DETAIL_RECT.height) + 'px'
    card.append(drawingDetail)
    // Decision #75: a detailed child plot honours its own quiet mark exactly
    // like the main plate does for the focused place — name, owner, and
    // terrain stay visible above, but its residents and things do not,
    // whether the viewer is standing at the world root, a continent, or a
    // town looking down into this one quiet plot.
    if (isQuietPlace(place)) {
      card.append(quietRoomNotice(place))
      card.dataset.liveDetailMounted = 'true'
      return
    }
    // Third review pass: place itself is clear, but residentsAt/liveThingShelf
    // below still recurse through every descendant of place — a quiet place
    // nested two or more levels down (this plot's grandchild or deeper) must
    // not leak by name just because this exact plot is not the quiet one.
    const residents = liveVisibleResidentsAt(snapshot, place.id)
    if (residents.length) {
      card.append(livePortraitGrid(
        residents,
        'Residents inside ' + place.name,
        bubbles,
        place.id,
        livePinnedResidentIds(snapshot, records, place.id),
        'live-portrait-grid',
        renderContext,
      ))
    }
    const shelf = liveThingShelf(
      snapshot, place, records, focus.id, true, interactionThings, renderContext)
    if (shelf) card.append(shelf)
    card.dataset.liveDetailMounted = 'true'
  }

  function unmountLivePlaceDetail(card) {
    if (card.dataset.liveDetailMounted !== 'true') return
    const open = card.querySelector(':scope > .live-plot-open')
    if (open) card.replaceChildren(open)
    card.dataset.liveDetailMounted = 'false'
  }

  function livePlacePlot(renderContext, place, plot, detailed, focused) {
    const { snapshot, focus } = renderContext
    const card = element('article', 'live-plot')
    card.dataset.placeId = String(place.id)
    card.dataset.livePlotX = String(plot.x)
    card.dataset.livePlotY = String(plot.y)
    card.dataset.livePlotWidth = String(plot.width)
    card.dataset.livePlotHeight = String(plot.height)
    card.dataset.liveFocusPlot = String(Boolean(focused))
    card.dataset.liveDetail = String(Boolean(detailed || focused))
    card.dataset.liveDetailMounted = 'false'
    const itemKey = 'place:' + String(place.id)
    card.dataset.liveItemKey = itemKey
    if (state.live.raisedItemKey === itemKey) card.dataset.liveRaised = 'true'
    card.style.left = String(plot.x) + 'px'
    card.style.top = String(plot.y) + 'px'
    card.style.width = String(plot.width) + 'px'
    card.style.height = String(plot.height) + 'px'
    const open = element('button', 'live-plot-open')
    open.type = 'button'
    open.dataset.focusKey = 'live-place:' + String(place.id)
    open.setAttribute('aria-label', 'Open the live plate for ' + place.name)
    bindLiveActivation(open, card, itemKey,
      () => navigate({ view: 'live', placeId: place.id }))
    bindLiveItemPopover(open, itemKey, 'place', () => place)
    open.append(element('span', 'live-plot-name', place.name),
      element('span', 'live-plot-number', '#' + String(place.id)))
    const notesControl = liveNotesControl(snapshot, place)
    card.dataset.undrawn = 'false'
    card.dataset.placeKind = focus.parent_id === null ? 'continent' : 'place'
    card.append(open)
    if (notesControl) card.append(notesControl)
    if (detailed || focused) mountLivePlaceDetail(card, renderContext, place)
    return card
  }

  function liveStageSurvey(places, parentId) {
    const plots = windowLiveSurveyedPlots(places, parentId)
    let width = Math.max(1_100, ...plots.map(plot => plot.x + plot.width + 64))
    const occupiedHeight = Math.max(680, ...plots.map(plot => plot.y + plot.height + 96))
    let height = occupiedHeight
    let expandedGrounds = Object.freeze({})
    if (state.snapshot && (state.live.expandedResidentPlaceIds.includes(parentId) ||
        state.live.expandedThingPlaceIds.includes(parentId))) {
      const directWidth = windowLiveDirectGroundWidth(width, LIVE_DIRECT_GROUND_WIDTH)
      height = Math.max(height, liveDirectGroundHeight(parentId, directWidth))
    }
    if (state.snapshot) {
      const expansions = plots.flatMap(plot => {
        const residentsExpanded = state.live.expandedResidentPlaceIds.includes(plot.id)
        const thingsExpanded = state.live.expandedThingPlaceIds.includes(plot.id)
        if (!residentsExpanded && !thingsExpanded) return []
        const residentHeight = residentsExpanded
          ? Math.max(320, windowLiveScatterSurfaceHeight(
              0,
              480,
              liveVisibleResidentsAt(state.snapshot, plot.id).length + Math.min(
                LIVE_PORTRAIT_LIMIT,
                Object.keys(liveResidentPointsByPlaceId[String(plot.id)] || {}).length,
              ),
              56,
              56,
              6,
            ))
          : 0
        const things = thingsExpanded
          ? liveDisplayedThings(state.snapshot, plot.id, parentId, true)
          : []
        const thingHeight = thingsExpanded
          ? Math.max(320, windowLiveScatterSurfaceHeight(
              0, 480, things.length, 94, 56, 6, true))
          : 0
        return [Object.freeze({ id: plot.id, residentHeight, thingHeight })]
      })
      const expandedLayout = windowLiveExpandedGroundLayout(plots, expansions)
      expandedGrounds = expandedLayout.grounds
      width = Math.max(width, expandedLayout.width + 64)
      height = Math.max(height, expandedLayout.height + 96)
    }
    return Object.freeze({ plots, width, height, expandedGrounds })
  }

`
