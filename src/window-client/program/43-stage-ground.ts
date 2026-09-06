export const PART_43_STAGE_GROUND = `  function stageRoomSurvey(places, parentId) {
    const parentKey = String(parentId)
    const previousRooms = liveStageRoomsByParentId[parentKey] || Object.freeze({})
    const previousExpandedGrounds =
      liveStageExpandedGroundsByParentId[parentKey] || Object.freeze({})
    const reservedGround = Object.values(previousExpandedGrounds)
      .flatMap(ground => Array.isArray(ground?.regions)
        ? ground.regions
        : Object.freeze([]))
    const layout = stageRoomLayout(
      places, parentId, Object.freeze(reservedGround), previousRooms)
    const plots = Object.freeze(Object.values(layout.rooms))
    const roomHistory = Object.freeze({ ...previousRooms, ...layout.rooms })
    liveStageRoomsByParentId = Object.freeze({
      ...liveStageRoomsByParentId,
      [parentKey]: roomHistory,
    })
    let width = layout.width
    let height = layout.height
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
        const held = Object.values(
          liveStageOccupantsByPlaceId[String(plot.id)] || Object.freeze({}))
        const residentEntries = residentsExpanded
          ? liveVisibleResidentsAt(state.snapshot, plot.id).map(row => Object.freeze({
              key: 'resident:' + String(row.id),
              kind: 'resident',
            }))
          : held.filter(entry => entry.kind === 'resident')
        const thingEntries = thingsExpanded
          ? liveDisplayedThings(state.snapshot, plot.id, parentId, true)
            .map(row => Object.freeze({
              key: 'thing:' + String(row.id),
              kind: 'thing',
            }))
          : held.filter(entry => entry.kind === 'thing')
        const entries = Object.freeze([...residentEntries, ...thingEntries])
        const previous = previousExpandedGrounds[String(plot.id)] || Object.freeze({
          residentHeight: 0,
          thingHeight: 0,
          regions: Object.freeze([]),
        })
        const extraGround = Object.freeze((previous.regions || []).map(region =>
          Object.freeze({
            x: region.x - plot.x,
            y: region.y - plot.y,
            width: region.width,
            height: region.height,
          })))
        const available = stageFindFreeSpots(
          entries,
          Object.freeze({ x: 0, y: 0, width: plot.width, height: plot.height }),
          liveStageSpotsByPlaceId[String(plot.id)] || Object.freeze({}),
          extraGround,
        )
        const missingCount = Math.max(0, entries.length - Object.keys(available).length)
        const neededHeight = missingCount
          ? stageStandingRoomHeight(plot.width, missingCount, 64) + 64
          : 0
        const addedHeight = neededHeight
        const residentHeight = previous.residentHeight +
          (residentsExpanded ? addedHeight : 0)
        const thingHeight = previous.thingHeight +
          (!residentsExpanded && thingsExpanded ? addedHeight : 0)
        return [Object.freeze({ id: plot.id, residentHeight, thingHeight })]
      })
      const expanded = stageExpandedGroundLayout(
        Object.values(roomHistory), expansions, previousExpandedGrounds)
      expandedGrounds = expanded.grounds
      liveStageExpandedGroundsByParentId = Object.freeze({
        ...liveStageExpandedGroundsByParentId,
        [parentKey]: expandedGrounds,
      })
      width = Math.max(width, expanded.width + 64)
      height = Math.max(height, expanded.height + 96)
    }
    const parentRoom = Object.freeze({
      id: parentId,
      parentId: parentId,
      x: 0,
      y: 0,
      width: 1100,
      height: STAGE_PARENT_ROOM_HEIGHT,
      door: Object.freeze({ x: 1100, y: STAGE_PARENT_ROOM_HEIGHT / 2, side: 'right' }),
    })
    const corridor = stageBuildCorridorGraph(Object.freeze([parentRoom, ...plots]))
    liveStageCorridorsByParentId = Object.freeze({
      ...liveStageCorridorsByParentId,
      [parentKey]: corridor,
    })
    return Object.freeze({
      plots,
      width,
      height,
      expandedGrounds,
      corridor,
    })
  }

  function stageRoomStandingPoints(
    placeId,
    kind,
    rows,
    room,
    persist = true,
    extraGround = Object.freeze([]),
  ) {
    const placeKey = String(placeId)
    const prefix = kind + ':'
    const priorOccupants = liveStageOccupantsByPlaceId[placeKey] || Object.freeze({})
    const retained = Object.values(priorOccupants).filter(entry =>
      !persist || !entry.key.startsWith(prefix))
    const incoming = rows.map(row => Object.freeze({
      key: prefix + String(row.id),
      kind,
    }))
    const occupants = Object.freeze(Object.fromEntries(
      [...retained, ...incoming].map(entry => [entry.key, entry])))
    const spots = stageFindFreeSpots(
      Object.values(occupants),
      room,
      liveStageSpotsByPlaceId[placeKey] || Object.freeze({}),
      extraGround,
    )
    if (persist) {
      liveStageOccupantsByPlaceId = Object.freeze({
        ...liveStageOccupantsByPlaceId,
        [placeKey]: occupants,
      })
      liveStageSpotsByPlaceId = Object.freeze({
        ...liveStageSpotsByPlaceId,
        [placeKey]: spots,
      })
    }
    return Object.freeze(Object.fromEntries(rows.flatMap(row => {
      const spot = spots[prefix + String(row.id)]
      if (!spot) return []
      return [[String(row.id), Object.freeze({
        x: spot.x + spot.width / 2,
        y: spot.y + (kind === 'resident' ? spot.height : spot.height / 2),
        spotKey: spot.key,
      })]]
    })))
  }

  function clearStageRoomSpots(placeId) {
    const placeKey = String(placeId)
    liveStageSpotsByPlaceId = Object.freeze(Object.fromEntries(
      Object.entries(liveStageSpotsByPlaceId).filter(([key]) => key !== placeKey)))
    liveStageOccupantsByPlaceId = Object.freeze(Object.fromEntries(
      Object.entries(liveStageOccupantsByPlaceId).filter(([key]) => key !== placeKey)))
  }

  function clearStageRoomSpotKind(placeId, kind) {
    const placeKey = String(placeId)
    const prefix = kind + ':'
    const occupants = Object.freeze(Object.fromEntries(Object.entries(
      liveStageOccupantsByPlaceId[placeKey] || Object.freeze({}),
    ).filter(([key]) => !key.startsWith(prefix))))
    const spots = Object.freeze(Object.fromEntries(Object.entries(
      liveStageSpotsByPlaceId[placeKey] || Object.freeze({}),
    ).filter(([key]) => !key.startsWith(prefix))))
    liveStageOccupantsByPlaceId = Object.freeze({
      ...liveStageOccupantsByPlaceId,
      [placeKey]: occupants,
    })
    liveStageSpotsByPlaceId = Object.freeze({
      ...liveStageSpotsByPlaceId,
      [placeKey]: spots,
    })
  }

  function stageCorridorRoute(parentId, fromPlaceId, toPlaceId) {
    const graph = liveStageCorridorsByParentId[String(parentId)]
    return graph ? stageShortestPath(graph, fromPlaceId, toPlaceId) : Object.freeze([])
  }

`
