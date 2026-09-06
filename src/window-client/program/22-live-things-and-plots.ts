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
    if (!things.length && (exactTotal === null || exactTotal === 0)) {
      clearStageRoomCellKind(place.id, 'thing')
      return null
    }
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
    const surfaceWidth = isRoot
      ? windowLiveDirectGroundWidth(survey.width, LIVE_DIRECT_GROUND_WIDTH)
      : childPlot?.width || 440
    const heldResidents = Object.values(
      liveStageOccupantsByPlaceId[String(place.id)] || Object.freeze({}),
    ).filter(occupant => occupant.kind === 'resident').length
    const minimumHeight = isRoot ? STAGE_PARENT_ROOM_HEIGHT : expanded ? 320 : childPlot?.height || 280
    const surfaceHeight = rootExpanded
      ? liveDirectGroundHeight(place.id, surfaceWidth)
      : stageCellRoomHeight(
          surfaceWidth, selection.visible.length + heldResidents, minimumHeight)
    const separated = stageRoomCellPoints(
      place.id,
      'thing',
      selection.visible,
      Object.freeze({ x: 0, y: 0, width: surfaceWidth, height: surfaceHeight }),
    )
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
      const itemKey = 'thing:' + String(thing.id)
      const specimen = ensureStageNode('thing', thing.id, () => {
        const created = element('a', 'live-thing-specimen')
        bindLiveActivation(created, created, itemKey, null)
        bindLiveItemPopover(created, itemKey, 'thing', () => created._liveStageRecord)
        return created
      })
      specimen._liveStageRecord = thing
      specimen.className = 'live-thing-specimen'
      delete specimen.dataset.liveFocusThing
      delete specimen.dataset.livePulseFor
      delete specimen.dataset.liveRaised
      delete specimen.dataset.liveKey
      delete specimen.dataset.highlighted
      specimen.href = '/api/thing/' + String(thing.id)
      specimen.setAttribute('aria-label', 'Read ' + thing.name)
      specimen.dataset.focusKey = 'live-thing:' + String(thing.id)
      specimen.dataset.liveThingId = String(thing.id)
      specimen.dataset.liveThingPlaceId = String(thing.place_id)
      specimen.style.width = '32px'
      specimen.style.height = '32px'
      specimen.style.minWidth = '32px'
      specimen.style.minHeight = '32px'
      const point = separated[String(thing.id)]
      setStageTransform(specimen, Object.freeze({ x: point.x, y: point.y, facing: 1 }))
      specimen.dataset.stageCellKey = point.cellKey
      specimen.dataset.stageRoomId = String(place.id)
      specimen.dataset.stageCellRow = String(point.row)
      specimen.dataset.stageCellColumn = String(point.column)
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
      const hasDrawing = String(Boolean(thing.has_drawing))
      const oldSprite = specimen.querySelector(':scope > .live-entity-portrait')
      const drawingRevision = String(state.changeMarker || state.snapshot?.changeMarker || '')
      if (specimen.dataset.liveHasDrawing !== hasDrawing) {
        if (oldSprite) {
          portraitObserver?.unobserve(oldSprite)
          observedPortraitShells.delete(oldSprite)
          pendingPortraitShells.delete(oldSprite)
          oldSprite.remove()
        }
        const sprite = liveSpriteNode('thing', thing.id, thing.name, thing.has_drawing)
        sprite.dataset.liveDrawingRevision = drawingRevision
        specimen.prepend(sprite)
        specimen.dataset.liveHasDrawing = hasDrawing
      } else if (hasDrawing === 'true' &&
          oldSprite?.dataset.liveDrawingRevision !== drawingRevision) {
        portraitObserver?.unobserve(oldSprite)
        observedPortraitShells.delete(oldSprite)
        pendingPortraitShells.delete(oldSprite)
        oldSprite.querySelector(':scope > .entity-portrait-image')?.remove()
        delete oldSprite.dataset.loaded
        delete oldSprite.dataset.portraitState
        oldSprite.dataset.liveDrawingRevision = drawingRevision
        schedulePortraitShell(oldSprite)
      }
      let name = specimen.querySelector(':scope > .live-thing-name')
      if (!name) {
        name = element('span', 'live-thing-name live-item-name')
        specimen.append(name)
      }
      name.textContent = thing.name
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
    if (state.snapshot) markLiveDirty()
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
    drawingDetail.style.left = String(STAGE_ROOM_DRAWING_CONTROL_RECT.x) + 'px'
    drawingDetail.style.top = String(STAGE_ROOM_DRAWING_CONTROL_RECT.y) + 'px'
    drawingDetail.style.width = String(STAGE_ROOM_DRAWING_CONTROL_RECT.width) + 'px'
    drawingDetail.style.height = String(STAGE_ROOM_DRAWING_CONTROL_RECT.height) + 'px'
    card.append(drawingDetail)
    // Decision #75: a detailed child plot honours its own quiet mark exactly
    // like the main plate does for the focused place — name, owner, and
    // terrain stay visible above, but its residents and things do not,
    // whether the viewer is standing at the world root, a continent, or a
    // town looking down into this one quiet plot.
    if (isQuietPlace(place)) {
      clearStageRoomCells(place.id)
      const room = renderContext.survey.plots.find(plot => plot.id === place.id)
      const residentCount = displayedResidents(snapshot).filter(resident =>
        resident.current_place_id === place.id).length
      const thingCount = liveSurveyThingTotal(snapshot, place.id, false)
      const quietGround = room && thingCount !== null ? stageQuietRoom(Object.freeze({
        name: place.name,
        owner: place.owner || null,
        quiet: true,
        counts: Object.freeze({ residents: residentCount, things: thingCount }),
      }), room) : null
      if (quietGround) {
        card.dataset.stageQuietRoom = 'true'
        card.append(element('p', 'quiet-plate-facts',
          (quietGround.owner ? 'Kept by ' + quietGround.owner : 'Nobody owns it') +
          ' · ' + String(quietGround.counts.residents) + ' residents' +
          ' · ' + String(quietGround.counts.things) + ' things'))
      }
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
    } else clearStageRoomCellKind(place.id, 'resident')
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
    const itemKey = 'place:' + String(place.id)
    const card = ensureStageNode('place', place.id, () => {
      const created = element('article', 'live-plot')
      const open = element('button', 'live-plot-open')
      open.type = 'button'
      open.dataset.focusKey = 'live-place:' + String(place.id)
      bindLiveActivation(open, created, itemKey,
        () => navigate({ view: 'live', placeId: place.id }))
      bindLiveItemPopover(open, itemKey, 'place', () => created._liveStageRecord)
      created.append(open)
      return created
    })
    card._liveStageRecord = place
    unmountLivePlaceDetail(card)
    const open = card.querySelector(':scope > .live-plot-open')
    for (const child of [...card.children]) {
      if (child !== open) child.remove()
    }
    card.className = 'live-plot'
    delete card.dataset.liveRaised
    card.dataset.placeId = String(place.id)
    card.dataset.livePlotX = String(plot.x)
    card.dataset.livePlotY = String(plot.y)
    card.dataset.livePlotWidth = String(plot.width)
    card.dataset.livePlotHeight = String(plot.height)
    card.dataset.liveFocusPlot = String(Boolean(focused))
    card.dataset.liveDetail = String(Boolean(detailed || focused))
    card.dataset.liveDetailMounted = 'false'
    card.dataset.liveItemKey = itemKey
    if (state.live.raisedItemKey === itemKey) card.dataset.liveRaised = 'true'
    card.style.left = String(plot.x) + 'px'
    card.style.top = String(plot.y) + 'px'
    card.style.width = String(plot.width) + 'px'
    card.style.height = String(plot.height) + 'px'
    open.setAttribute('aria-label', 'Open the live plate for ' + place.name)
    open.replaceChildren(element('span', 'live-plot-name', place.name),
      element('span', 'live-plot-number', '#' + String(place.id)))
    const notesControl = liveNotesControl(snapshot, place)
    card.dataset.undrawn = 'false'
    card.dataset.placeKind = focus.parent_id === null ? 'continent' : 'place'
    card.append(open)
    if (notesControl) card.append(notesControl)
    if (detailed || focused || isQuietPlace(place)) mountLivePlaceDetail(card, renderContext, place)
    return card
  }

  function liveStageSurvey(places, parentId) {
    return stageRoomSurvey(places, parentId)
  }

`
