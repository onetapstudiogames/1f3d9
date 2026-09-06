export const PART_43_STAGE_GROUND = `  function stageRoomSurvey(places, parentId) {
    const layout = stageRoomLayout(places, parentId)
    const plots = Object.freeze(Object.values(layout.rooms))
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
        const residentCount = residentsExpanded
          ? liveVisibleResidentsAt(state.snapshot, plot.id).length
          : 0
        const thingCount = thingsExpanded
          ? liveDisplayedThings(state.snapshot, plot.id, parentId, true).length
          : 0
        const residentHeight = residentsExpanded
          ? stageCellRoomHeight(
              plot.width,
              residentCount + held.filter(entry => entry.kind === 'thing').length,
              320,
            )
          : 0
        const thingHeight = thingsExpanded
          ? stageCellRoomHeight(
              plot.width,
              thingCount + held.filter(entry => entry.kind === 'resident').length,
              320,
            )
          : 0
        return [Object.freeze({ id: plot.id, residentHeight, thingHeight })]
      })
      const expanded = stageExpandedGroundLayout(plots, expansions)
      expandedGrounds = expanded.grounds
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
      [String(parentId)]: corridor,
    })
    return Object.freeze({
      plots,
      width,
      height,
      expandedGrounds,
      corridor,
    })
  }

  function stageRoomCellPoints(placeId, kind, rows, room, persist = true) {
    const placeKey = String(placeId)
    const prefix = kind + ':'
    const priorOccupants = liveStageOccupantsByPlaceId[placeKey] || Object.freeze({})
    const retained = Object.values(priorOccupants).filter(entry =>
      !persist || !entry.key.startsWith(prefix))
    const incoming = rows.map(row => Object.freeze({
      key: prefix + String(row.id),
      kind,
      label: kind === 'resident' ? String(row.handle) : String(row.name),
    }))
    const occupants = Object.freeze(Object.fromEntries(
      [...retained, ...incoming].map(entry => [entry.key, entry])))
    const cells = stageAssignCells(
      Object.values(occupants),
      room,
      liveStageCellsByPlaceId[placeKey] || Object.freeze({}),
    )
    if (persist) {
      liveStageOccupantsByPlaceId = Object.freeze({
        ...liveStageOccupantsByPlaceId,
        [placeKey]: occupants,
      })
      liveStageCellsByPlaceId = Object.freeze({
        ...liveStageCellsByPlaceId,
        [placeKey]: cells,
      })
    }
    return Object.freeze(Object.fromEntries(rows.flatMap(row => {
      const cell = cells[prefix + String(row.id)]
      if (!cell) return []
      return [[String(row.id), Object.freeze({
        x: cell.x + cell.width / 2,
        y: cell.y + (kind === 'resident' ? cell.height : cell.height / 2),
        row: cell.row,
        column: cell.column,
        cellKey: cell.key,
      })]]
    })))
  }

  function clearStageRoomCells(placeId) {
    const placeKey = String(placeId)
    liveStageCellsByPlaceId = Object.freeze(Object.fromEntries(
      Object.entries(liveStageCellsByPlaceId).filter(([key]) => key !== placeKey)))
    liveStageOccupantsByPlaceId = Object.freeze(Object.fromEntries(
      Object.entries(liveStageOccupantsByPlaceId).filter(([key]) => key !== placeKey)))
  }

  function clearStageRoomCellKind(placeId, kind) {
    const placeKey = String(placeId)
    const prefix = kind + ':'
    const occupants = Object.freeze(Object.fromEntries(Object.entries(
      liveStageOccupantsByPlaceId[placeKey] || Object.freeze({}),
    ).filter(([key]) => !key.startsWith(prefix))))
    const cells = Object.freeze(Object.fromEntries(Object.entries(
      liveStageCellsByPlaceId[placeKey] || Object.freeze({}),
    ).filter(([key]) => !key.startsWith(prefix))))
    liveStageOccupantsByPlaceId = Object.freeze({
      ...liveStageOccupantsByPlaceId,
      [placeKey]: occupants,
    })
    liveStageCellsByPlaceId = Object.freeze({
      ...liveStageCellsByPlaceId,
      [placeKey]: cells,
    })
  }

  function stageCorridorRoute(parentId, fromPlaceId, toPlaceId) {
    const graph = liveStageCorridorsByParentId[String(parentId)]
    return graph ? stageShortestPath(graph, fromPlaceId, toPlaceId) : Object.freeze([])
  }

`
