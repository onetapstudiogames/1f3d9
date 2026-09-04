export const PART_21_LIVE_PINNING_AND_PORTRAIT_GRID = `  function livePinnedResidentIds(snapshot, records, placeId) {
    const handle = state.live.focusResident
    if (!handle) return []
    const residents = displayedResidents(snapshot)
    const focused = residents.find(resident => resident.handle === handle)
    if (!focused) return []
    const placeIds = placeScopeSet(placeId, snapshot)
    const plate = liveFocusPlace(snapshot)
    const plateIds = plate ? placeScopeSet(plate.id, snapshot) : new Set()
    const pins = new Set(placeIds.has(focused.current_place_id) ? [focused.id] : [])
    const focusRecords = new Map([...records, ...liveInteractionRecords()]
      .map(record => [liveTraceKey(record), record]))
    for (const record of focusRecords.values()) {
      if (!plateIds.has(liveRecordPlaceId(record))) continue
      if (record.actor === handle && record.detail.resident_id) {
        const partner = residents.find(resident => resident.id === record.detail.resident_id)
        if (partner && placeIds.has(partner.current_place_id)) pins.add(partner.id)
      }
      if (record.detail.resident_id === focused.id) {
        const partner = residents.find(resident => resident.handle === record.actor)
        if (partner && placeIds.has(partner.current_place_id)) pins.add(partner.id)
      }
    }
    return Object.freeze([...pins])
  }

  function livePinnedThingIds(snapshot, records, placeId, interactionThings = null) {
    const focus = liveFocusPlace(snapshot)
    if (!focus) return []
    const placeIds = placeScopeSet(placeId, snapshot)
    const things = interactionThings || liveFocusInteractionThings(snapshot, focus, records)
    return Object.freeze(things
      .filter(thing => placeIds.has(thing.place_id))
      .map(thing => thing.id))
  }

  function liveFocusedPlotIds(
    snapshot,
    focus,
    children,
    records,
    interactionThings,
    renderContext = null,
  ) {
    if (state.live.proofScene) return Object.freeze(children.map(place => place.id))
    const focused = new Set()
    const pinnedResidents = new Set(livePinnedResidentIds(snapshot, records, focus.id))
    for (const resident of displayedResidents(snapshot)) {
      if (!pinnedResidents.has(resident.id)) continue
      const anchorId = livePlaceAnchor(
        resident.current_place_id, focus.id, children, renderContext)
      if (anchorId && anchorId !== focus.id) focused.add(anchorId)
    }
    const pinnedThings = new Set(livePinnedThingIds(
      snapshot, records, focus.id, interactionThings))
    for (const thing of interactionThings) {
      if (!pinnedThings.has(thing.id)) continue
      const anchorId = livePlaceAnchor(thing.place_id, focus.id, children, renderContext)
      if (anchorId && anchorId !== focus.id) focused.add(anchorId)
    }
    return Object.freeze([...focused])
  }

  function liveResidentReplayPoint(
    snapshot,
    placeId,
    actor,
    focus,
    children,
    renderContext = null,
    cacheable = true,
  ) {
    const anchorId = livePlaceAnchor(placeId, focus.id, children, renderContext)
    if (!anchorId) return null
    if (renderContext && cacheable) {
      return renderContext.remember(
        'resident-point:' + String(anchorId) + ':' + actor,
        () => liveResidentReplayPoint(
          snapshot, placeId, actor, focus, children, renderContext, false),
      )
    }
    const residentIndex = liveRenderResidentIndex(snapshot, renderContext)
    const resident = residentIndex.residentByHandle(actor)
    if (!resident) return null
    const buildAnchoredResidents = () => {
      const placeIds = anchorId === focus.id
        ? new Set([focus.id])
        : placeScopeSet(anchorId, snapshot)
      return Object.freeze(residentIndex.residents.filter(candidate =>
        placeIds.has(candidate.current_place_id) &&
        (!state.resident || candidate.handle === state.resident)))
    }
    const anchoredResidents = renderContext
      ? renderContext.remember(
          'resident-replay-rows:' + String(anchorId),
          buildAnchoredResidents,
        )
      : buildAnchoredResidents()
    const buildAnchoredResidentIds = () =>
      new Set(anchoredResidents.map(candidate => candidate.id))
    const anchoredResidentIds = renderContext
      ? renderContext.remember(
          'resident-replay-ids:' + String(anchorId),
          buildAnchoredResidentIds,
        )
      : buildAnchoredResidentIds()
    const records = renderContext?.records || visibleLiveRecords(
      snapshot, focus, children, renderContext)
    const buildPinnedIds = () => livePinnedResidentIds(snapshot, records, anchorId)
    const pinnedIds = renderContext
      ? renderContext.remember(
          'resident-replay-pins:' + String(anchorId),
          buildPinnedIds,
        )
      : buildPinnedIds()
    const buildBaseLayout = () => liveResidentLayout(
      anchoredResidents,
      anchorId,
      focus,
      children,
      pinnedIds,
      renderContext,
      true,
      true,
      true,
    )
    const baseLayout = renderContext
      ? renderContext.remember(
          'resident-replay-base:' + String(anchorId),
          buildBaseLayout,
        )
      : buildBaseLayout()
    const basePoint = baseLayout.visible
      .find(entry => entry.resident.id === resident.id)?.stagePoint
    if (basePoint) return basePoint

    const totalWithActor = baseLayout.visible.length + baseLayout.overflowCount +
      (anchoredResidentIds.has(resident.id) ? 0 : 1)
    const layerCapacity = baseLayout.expanded
      ? Math.min(LIVE_PORTRAIT_LIMIT, totalWithActor)
      : totalWithActor > LIVE_PORTRAIT_LIMIT
        ? Math.max(1, LIVE_PORTRAIT_LIMIT - 2)
        : Math.min(LIVE_PORTRAIT_LIMIT, totalWithActor)
    const layerIds = []
    for (const id of [
      resident.id,
      ...pinnedIds,
      ...baseLayout.visible.map(entry => entry.resident.id),
    ]) {
      if (layerIds.length >= layerCapacity) break
      if (!layerIds.includes(id)) layerIds.push(id)
    }
    const layerResidents = Object.freeze(layerIds.flatMap(id => {
      const candidate = residentIndex.residentById(id)
      return candidate ? [candidate] : []
    }))
    const layout = liveResidentLayout(
      layerResidents,
      anchorId,
      focus,
      children,
      Object.freeze([resident.id, ...pinnedIds.filter(id => id !== resident.id)]),
      renderContext,
      false,
      false,
      false,
      baseLayout,
    )
    return layout.visible.find(entry => entry.resident.handle === actor)?.stagePoint ||
      layout.badgePoint
  }

  function positionLiveRootOverflowControl(control, slot, width, height) {
    const rail = windowLiveRootReservations(width, height)[0]
    if (!rail) return
    const inset = 6
    const gap = 8
    const controlWidth = rail.width - inset * 2
    const controlHeight = (rail.height - inset * 2 - gap) / 2
    if (controlWidth < 44 || controlHeight < 44) return
    const slotIndex = slot === 'thing' ? 1 : 0
    control.dataset.liveRootControl = slot
    control.style.inset = 'auto'
    control.style.left = String(rail.x + inset) + 'px'
    control.style.top = String(
      rail.y + inset + slotIndex * (controlHeight + gap)
    ) + 'px'
    control.style.width = String(controlWidth) + 'px'
    control.style.height = String(controlHeight) + 'px'
    control.style.minWidth = '0'
  }

  function livePortraitGrid(
    residents,
    label,
    bubbles,
    placeId,
    pinnedIds,
    className = 'live-portrait-grid',
    renderContext = null,
  ) {
    const grid = element('div', className)
    grid.setAttribute('aria-label', label)
    const focus = renderContext?.focus || (state.snapshot ? liveFocusPlace(state.snapshot) : null)
    const children = renderContext?.children ||
      (focus && state.snapshot ? liveChildren(state.snapshot, focus) : [])
    if (!focus) return grid
    const layout = liveResidentLayout(
      residents, placeId, focus, children, pinnedIds, renderContext)
    if (placeId === focus.id) {
      grid.style.width = String(layout.surfaceWidth) + 'px'
      grid.style.height = String(layout.surfaceHeight) + 'px'
      grid.style.inset = '0 auto auto 0'
    }
    if (layout.expanded) {
      grid.dataset.liveExpanded = 'true'
      if (placeId !== focus.id) {
        grid.style.width = String(layout.surfaceWidth) + 'px'
        grid.style.height = String(layout.surfaceHeight) + 'px'
        grid.style.inset = 'auto'
        grid.style.left = '0'
        grid.style.top = String(layout.inlineOffsetY) + 'px'
      }
    }
    const pinned = new Set(pinnedIds || [])
    const overlayHandles = state.live.proofScene
      ? new Set()
      : new Set(Object.keys(state.live.replayPositions))
    layout.visible.forEach(entry => {
      const resident = entry.resident
      if (overlayHandles.has(resident.handle)) return
      const portrait = element('button', resident.asleep
        ? 'live-portrait asleep'
        : 'live-portrait')
      portrait.type = 'button'
      portrait.dataset.focusKey = 'live-resident:' + resident.handle
      portrait.dataset.liveResidentHandle = resident.handle
      portrait.setAttribute('aria-label', state.live.focusResident === resident.handle
        ? 'Clear focus from ' + resident.handle
        : 'Focus on ' + resident.handle)
      portrait.setAttribute('aria-pressed', String(state.live.focusResident === resident.handle))
      portrait.append(liveSpriteNode(
        'resident', resident.id, resident.handle, resident.has_drawing,
      ))
      const shell = livePortraitShell(
        portrait,
        bubbles?.get(resident.handle),
        'live-portrait-wrap live-walker',
      )
      shell.style.left = String(entry.localPoint.x) + 'px'
      shell.style.top = String(entry.localPoint.y) + 'px'
      const itemKey = 'resident:' + resident.handle
      shell.dataset.liveItemKey = itemKey
      if (state.live.raisedItemKey === itemKey) shell.dataset.liveRaised = 'true'
      if (state.live.focusResident === resident.handle) {
        shell.setAttribute('data-live-focus-resident', resident.handle)
      } else if (pinned.has(resident.id)) {
        shell.setAttribute('data-live-focus-partner', resident.handle)
      }
      bindLiveActivation(portrait, shell, itemKey,
        () => toggleLiveFocusResident(resident.handle))
      bindLiveItemPopover(portrait, itemKey, 'resident', () => resident)
      grid.append(shell)
    })
    const visibleOverflowActors = layout.hidden.filter(resident =>
      overlayHandles.has(resident.handle)).length
    const overflowCount = Math.max(0, layout.overflowCount - visibleOverflowActors)
    if (overflowCount) {
      const badge = element('button', 'live-overflow-badge live-resident-more',
        '+' + String(overflowCount) + ' more')
      badge.type = 'button'
      badge.dataset.focusKey = 'live-resident-overflow:' + String(placeId)
      badge.dataset.liveOverflowPlaceId = String(placeId)
      badge.setAttribute('aria-label', 'Show ' + String(overflowCount) + ' more residents')
      badge.setAttribute('data-live-overflow-count', String(overflowCount))
      badge.title = String(residents.length) + ' residents here; showing ' +
        String(residents.length - overflowCount)
      if (Number(state.live.absorptionEndsAtByPlaceId[String(placeId)]) > Date.now()) {
        badge.classList.add('live-overflow-absorbing')
      }
      if (placeId === focus.id) {
        positionLiveRootOverflowControl(
          badge, 'resident', layout.surfaceWidth, layout.surfaceHeight)
      }
      badge.addEventListener('click', () => {
        requestLiveFocusRestore(
          badge.dataset.focusKey || '', 'live-plates', placeId)
        state = { ...state, live: { ...state.live,
          expandedResidentPlaceIds: Object.freeze([
            ...new Set([...state.live.expandedResidentPlaceIds, placeId]),
          ]),
        } }
        if (state.snapshot) renderLive(state.snapshot)
      })
      grid.append(badge)
    }
    return grid
  }

  // Step 3 ruling: a place's own drawing tiles its floor across the whole
  // plot at reduced opacity ('--live-floor-opacity', applied in CSS) so
  // sprites read clearly on top; an undrawn place gets plain paper ground.
  // Ordinary operation reads the same cacheable 32x32 alpha PNG the thumb
  // route already serves for resident and thing sprites ('portraitUrl'),
  // repeated by the compositor via CSS 'background-repeat' -- a plate with
  // 40 plots costs 40 cached image requests, never a JSON read plus a
  // canvas paint. The thumb route 404s only for Undrawn, Refused, missing,
  // withdrawn, or moderated presentations (a Blank Complete drawing is a
  // real, if fully transparent, PNG), so a failed probe is what marks
  // 'undrawnTarget' (usually the '.live-plot' card) as undrawn for CSS. The
  // one exception is the deterministic preview proof scene: its synthetic
  // place ids have no real backend record for the thumb route to serve, so
  // it paints the same fixture pixels it always has via the existing
  // canvas path instead of probing the network.
  //
  // Round-1 review finding 2: an unresolved floor must lean paper, never
  // the dark plot card, until the probe's own 'load' event actually fires
  // -- a moderated place, a slow connection, or a cold cache must never
  // paint the dark card for even one round trip while a real thumbnail is
  // still in flight. setUndrawn(true) runs before the probe's src is even
  // set, and only 'load' flips it to false; 'error' (including a 404)
  // leaves it exactly where it already leaned.
  function liveTiledDrawing(
    place, className, pixelBox = null, undrawnTarget = null, tileSize = LIVE_FLOOR_TILE_SIZE,
  ) {
    const terrain = element('div', className)
    terrain.setAttribute('role', 'img')
    const proofKey = liveDrawingKey('place', place.id)
    const proofEntry = state.live.proofScene ? state.live.drawings[proofKey] : undefined
    // Round-1 review finding 1: the JSON drawing node's role="img" +
    // name/state/source accessible name went away with the JSON fetch it
    // was built from. Rebuild the same shape from data already in hand on
    // each path -- never a new fetch -- so a screen-reader user still
    // hears the place name, its drawn/undrawn state, and its drawing
    // source; the click-through drawing-detail button remains the exact
    // reachable path for everything else the deleted node carried.
    const setUndrawn = value => {
      terrain.dataset.undrawn = String(value)
      if (undrawnTarget) undrawnTarget.dataset.undrawn = String(value)
      terrain.setAttribute(
        'aria-label',
        windowLiveFloorAccessibleLabel(place.name, value, proofEntry ?? null),
      )
    }
    const sizeToBox = () => {
      if (!pixelBox) return
      const { columns, rows } = windowLiveFloorTiling(pixelBox.width, pixelBox.height, tileSize)
      terrain.style.width = String(columns * tileSize) + 'px'
      terrain.style.height = String(rows * tileSize) + 'px'
    }
    if (proofEntry !== undefined) {
      const undrawn = !proofEntry?.loaded || !proofEntry.drawing
      setUndrawn(undrawn)
      if (!undrawn) {
        // A plot has no real pixel geometry to derive a tile count from
        // here (unlike the world ground's pixelBox), so the proof canvas
        // uses the same fixed density the shipped view always painted --
        // enough repeats to read as tiled once CSS stretches it to fill
        // the plot. The terrain's own role="img" + aria-label above already
        // carries the accessible name, so this painted canvas is purely
        // decorative to assistive tech.
        const { columns, rows } = pixelBox
          ? windowLiveFloorTiling(pixelBox.width, pixelBox.height, tileSize)
          : Object.freeze({ columns: 8, rows: 5 })
        const tile = paintedDrawingNode(proofEntry.drawing, columns, rows)
        if (tile) {
          tile.classList.add('live-tiled-drawing')
          tile.setAttribute('aria-hidden', 'true')
          tile.style.width = '100%'
          tile.style.height = '100%'
          terrain.append(tile)
        }
        sizeToBox()
      }
      return terrain
    }
    setUndrawn(true)
    const url = portraitUrl('place', place.id)
    terrain.style.backgroundImage = 'url(' + url + ')'
    terrain.style.backgroundRepeat = 'repeat'
    terrain.style.backgroundSize = String(tileSize) + 'px ' + String(tileSize) + 'px'
    sizeToBox()
    const probe = new Image()
    probe.decoding = 'async'
    probe.addEventListener('load', () => setUndrawn(false))
    probe.addEventListener('error', () => setUndrawn(true))
    probe.src = url
    return terrain
  }

`
