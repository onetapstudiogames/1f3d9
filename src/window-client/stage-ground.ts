export type StageGroundPlace = Readonly<{
  id: string | number
  parent_id: string | number | null
  name?: string
}>

export type StageRoomBox = Readonly<{
  id: string | number
  parentId: string | number
  x: number
  y: number
  width: number
  height: number
  door: Readonly<{ x: number; y: number; side: 'left' | 'right' }>
}>

export type StageStandingEntry = Readonly<{
  key: string
  kind: 'resident' | 'thing'
}>

export type StageStandingSpot = Readonly<{
  key: string
  kind: 'resident' | 'thing'
  x: number
  y: number
  width: number
  height: number
}>

export type StageGroundRect = Readonly<{
  x: number
  y: number
  width: number
  height: number
}>

export type StageExpandedGroundRegion = StageGroundRect & Readonly<{
  kind: 'resident' | 'thing'
}>

export type StageExpandedGround = Readonly<{
  x: number
  residentTop: number | null
  thingTop: number | null
  residentHeight: number
  thingHeight: number
  width: number
  bottom: number
  regions: readonly StageExpandedGroundRegion[]
}>

export type StageCorridorNode = Readonly<{
  id: string
  kind: 'door' | 'corner'
  roomId: string | null
  x: number
  y: number
}>

export type StageCorridorGraph = Readonly<{
  nodes: Readonly<Record<string, StageCorridorNode>>
  edges: readonly Readonly<{ from: string; to: string; distance: number }>[]
  roomDoors: Readonly<Record<string, string>>
}>

export const STAGE_ROOM_DRAWING_CONTROL_RECT = Object.freeze({
  x: 6,
  y: 286,
  width: 100,
  height: 44,
})
export const STAGE_PARENT_ROOM_HEIGHT = 680

export function stageChildPlaces<T extends Readonly<{
  id: string | number
  parent_id: string | number | null
}>>(places: readonly T[], parentId: string | number): readonly T[] {
  const parentKey = String(parentId)
  return Object.freeze(places.filter(place => String(place.parent_id) === parentKey)
    .sort((left, right) => {
      const leftNumber = Number(left.id)
      const rightNumber = Number(right.id)
      if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
        return leftNumber - rightNumber
      }
      return String(left.id).localeCompare(String(right.id))
    }))
}

export function stageRoomLayout(
  places: readonly StageGroundPlace[],
  parentId: string | number,
  reservedGround: readonly StageGroundRect[] = [],
  previousRooms: Readonly<Record<string, StageRoomBox>> = {},
): Readonly<{
  rooms: Readonly<Record<string, StageRoomBox>>
  width: number
  height: number
}> {
  const roomWidth = 440
  const roomHeight = 280
  const parentWidth = 1_100
  const corridorWidth = 80
  const roomGap = 80
  const top = 48
  const rooms: Record<string, StageRoomBox> = {}
  const children = stageChildPlaces(places, parentId)
  const parentKey = String(parentId)
  const retainedRooms = Object.freeze(Object.fromEntries(Object.entries(previousRooms)
    .filter(([id, room]) => id === String(room.id) &&
      String(room.parentId) === parentKey &&
      [room.x, room.y, room.width, room.height, room.door.x, room.door.y]
        .every(Number.isFinite) &&
      room.width > 0 && room.height > 0)))
  const obstacles = reservedGround.filter(area =>
    [area.x, area.y, area.width, area.height].every(Number.isFinite) &&
      area.width > 0 && area.height > 0)
  let nextFreshY = Math.max(top, ...Object.values(retainedRooms)
    .map(room => room.y + room.height + roomGap))
  for (const place of children) {
    const id = String(place.id)
    const retained = retainedRooms[id]
    if (retained) {
      rooms[id] = retained
      continue
    }
    const x = parentWidth + corridorWidth
    let y = nextFreshY
    while (true) {
      const overlapping = obstacles.filter(area =>
        x < area.x + area.width + roomGap &&
        x + roomWidth + roomGap > area.x &&
        y < area.y + area.height + roomGap &&
        y + roomHeight + roomGap > area.y)
      if (!overlapping.length) break
      y = Math.max(...overlapping.map(area => area.y + area.height + roomGap))
    }
    rooms[id] = Object.freeze({
      id: place.id,
      parentId,
      x,
      y,
      width: roomWidth,
      height: roomHeight,
      door: Object.freeze({ x, y: y + roomHeight / 2, side: 'left' as const }),
    })
    nextFreshY = y + roomHeight + roomGap
  }
  return Object.freeze({
    rooms: Object.freeze(rooms),
    width: children.length ? parentWidth + corridorWidth + roomWidth + 64 : parentWidth,
    height: Math.max(STAGE_PARENT_ROOM_HEIGHT,
      ...Object.values(rooms).map(room => room.y + room.height + roomGap)),
  })
}

export function stageFindFreeSpots(
  entries: readonly StageStandingEntry[],
  room: StageGroundRect,
  previous: Readonly<Record<string, StageStandingSpot>> = {},
  extraGround: readonly StageGroundRect[] = [],
): Readonly<Record<string, StageStandingSpot>> {
  if (![room.x, room.y, room.width, room.height].every(Number.isFinite) ||
      room.width <= 0 || room.height <= 0) return Object.freeze({})
  const spriteSize = 32
  const clearance = spriteSize / 2
  const searchAreas = [room, ...extraGround].flatMap(area => {
    if (![area.x, area.y, area.width, area.height].every(Number.isFinite) ||
        area.width <= 0 || area.height <= 0) return []
    const minimumX = Math.ceil(area.x + clearance)
    const minimumY = Math.ceil(area.y + clearance)
    const maximumX = Math.floor(area.x + area.width - clearance - spriteSize)
    const maximumY = Math.floor(area.y + area.height - clearance - spriteSize)
    const xSpan = maximumX - minimumX + 1
    const ySpan = maximumY - minimumY + 1
    if (xSpan <= 0 || ySpan <= 0) return []
    return [Object.freeze({
      minimumX, minimumY, maximumX, maximumY, xSpan, ySpan,
      candidateCount: xSpan * ySpan,
    })]
  })
  if (!searchAreas.length) return Object.freeze({})
  const hash = (value: string): number => {
    let result = 2166136261
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index)
      result = Math.imul(result, 16777619)
    }
    return result >>> 0
  }
  const ordered = [...new Map(entries.filter(entry =>
    (entry.kind === 'resident' || entry.kind === 'thing') &&
      typeof entry.key === 'string' && entry.key.length > 0)
    .map(entry => [entry.key, entry])).values()]
    .sort((left, right) => left.key.localeCompare(right.key))
  const overlaps = (
    left: Readonly<{ x: number; y: number; width: number; height: number }>,
    right: Readonly<{ x: number; y: number; width: number; height: number }>,
  ): boolean => left.x < right.x + right.width + clearance &&
    left.x + left.width + clearance > right.x &&
    left.y < right.y + right.height + clearance &&
    left.y + left.height + clearance > right.y
  const bucketSize = spriteSize + clearance
  const occupiedByBucket = new Map<number, Map<number, StageStandingSpot[]>>()
  const bucketCoordinate = (value: number): number => Math.floor(value / bucketSize)
  const addOccupied = (spot: StageStandingSpot): void => {
    const x = bucketCoordinate(spot.x)
    const y = bucketCoordinate(spot.y)
    const bucketColumn = occupiedByBucket.get(x) || new Map<number, StageStandingSpot[]>()
    bucketColumn.set(y, [...(bucketColumn.get(y) || []), spot])
    occupiedByBucket.set(x, bucketColumn)
  }
  const collides = (
    area: Readonly<{ x: number; y: number; width: number; height: number }>,
  ): boolean => {
    const centerX = bucketCoordinate(area.x)
    const centerY = bucketCoordinate(area.y)
    for (let x = centerX - 1; x <= centerX + 1; x += 1) {
      const bucketColumn = occupiedByBucket.get(x)
      if (!bucketColumn) continue
      for (let y = centerY - 1; y <= centerY + 1; y += 1) {
        if ((bucketColumn.get(y) || [])
          .some(occupied => overlaps(area, occupied))) return true
      }
    }
    return false
  }
  const result: Record<string, StageStandingSpot> = {}
  for (const entry of ordered) {
    const spot = previous[entry.key]
    if (!spot || spot.kind !== entry.kind ||
        ![spot.x, spot.y, spot.width, spot.height].every(Number.isFinite) ||
        spot.width !== spriteSize || spot.height !== spriteSize ||
        !searchAreas.some(area => spot.x >= area.minimumX && spot.y >= area.minimumY &&
          spot.x <= area.maximumX && spot.y <= area.maximumY) ||
        collides(spot)) continue
    const retained = Object.freeze({
      key: entry.key,
      kind: entry.kind,
      x: spot.x,
      y: spot.y,
      width: spriteSize,
      height: spriteSize,
    })
    result[entry.key] = retained
    addOccupied(retained)
  }
  for (const entry of ordered) {
    if (result[entry.key]) continue
    const candidateCount = searchAreas.reduce((sum, area) => sum + area.candidateCount, 0)
    const firstCandidate = hash(entry.key) % candidateCount
    const candidateRectAt = (candidateIndex: number): StageGroundRect => {
      let candidate = candidateIndex
      let searchArea = searchAreas[0]!
      for (const candidateArea of searchAreas) {
        searchArea = candidateArea
        if (candidate < candidateArea.candidateCount) break
        candidate -= candidateArea.candidateCount
      }
      return Object.freeze({
        x: searchArea.minimumX + candidate % searchArea.xSpan,
        y: searchArea.minimumY + Math.floor(candidate / searchArea.xSpan),
        width: spriteSize,
        height: spriteSize,
      })
    }
    let chosen: Readonly<{ x: number; y: number }> | null = null
    let probe = hash('free:' + entry.key)
    for (let attempt = 0; attempt < 64; attempt += 1) {
      probe = (Math.imul(probe, 1664525) + 1013904223) >>> 0
      const candidateRect = candidateRectAt(probe % candidateCount)
      if (!collides(candidateRect)) {
        chosen = candidateRect
        break
      }
    }
    for (let offset = 0; offset < candidateCount; offset += 1) {
      if (chosen) break
      const candidateRect = candidateRectAt((firstCandidate + offset) % candidateCount)
      if (!collides(candidateRect)) {
        chosen = candidateRect
        break
      }
    }
    if (!chosen) continue
    const placed = Object.freeze({
      key: entry.key,
      kind: entry.kind,
      x: chosen.x,
      y: chosen.y,
      width: spriteSize,
      height: spriteSize,
    })
    result[entry.key] = placed
    addOccupied(placed)
  }
  return Object.freeze(result)
}

export function stageStandingRoomHeight(
  width: number,
  count: number,
  minimumHeight = 280,
): number {
  if (![width, count, minimumHeight].every(Number.isFinite) ||
      width <= 0 || count < 0 || minimumHeight <= 0) return 0
  const spriteSize = 32
  const clearance = spriteSize / 2
  const minimumGap = spriteSize + clearance
  const xSpan = Math.floor(width - clearance * 2 - spriteSize)
  if (xSpan < 0) return 0
  const standingAcross = Math.floor(xSpan / minimumGap) + 1
  const depth = Math.ceil(Math.floor(count) / standingAcross)
  // Free positions do not pack like grid rows. Reserve slack for retained,
  // off-grid occupants; the caller first probes the actual existing ground
  // and adds a strip only when an occupant cannot fit there.
  const requiredHeight = depth > 0
    ? clearance * 2 + spriteSize + (depth - 1) * minimumGap * 2
    : clearance * 2 + spriteSize
  return Math.max(Math.ceil(minimumHeight), requiredHeight)
}

export function stageExpandedGroundLayout(
  rooms: readonly Readonly<{
    id: string | number
    x: number
    y: number
    width: number
    height: number
  }>[],
  expansions: readonly Readonly<{
    id: string | number
    residentHeight: number
    thingHeight: number
  }>[],
  previousGrounds: Readonly<Record<string, StageExpandedGround>> = {},
  groundWidth = 440,
  gap = 16,
  controlRailDepth = 64,
): Readonly<{
  grounds: Readonly<Record<string, StageExpandedGround>>
  width: number
  height: number
}> {
  const safeGroundWidth = Number.isFinite(groundWidth) && groundWidth > 0
    ? groundWidth
    : 440
  const safeGap = Number.isFinite(gap) && gap >= 0 ? gap : 16
  const safeRailDepth = Number.isFinite(controlRailDepth) && controlRailDepth >= 0
    ? controlRailDepth
    : 64
  const roomById = new Map(rooms.filter(room =>
    [room.x, room.y, room.width, room.height].every(Number.isFinite) &&
      room.width > 0 && room.height > 0)
    .map(room => [String(room.id), room]))
  const fixed = [...roomById.values()].map(room => Object.freeze({
    x: room.x,
    y: room.y,
    width: room.width,
    height: room.height + safeRailDepth,
  }))
  const regionsByRoom = new Map<string, StageExpandedGroundRegion[]>()
  for (const [id, ground] of Object.entries(previousGrounds)) {
    if (!Array.isArray(ground?.regions)) continue
    const regions = ground.regions.filter(region =>
      (region.kind === 'resident' || region.kind === 'thing') &&
        [region.x, region.y, region.width, region.height].every(Number.isFinite) &&
        region.width > 0 && region.height > 0)
      .map(region => Object.freeze({
        kind: region.kind,
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      }))
    if (regions.length) regionsByRoom.set(id, regions)
  }
  const obstacles = [...fixed, ...[...regionsByRoom.values()].flat()]
  const ordered = expansions.filter(expansion =>
    roomById.has(String(expansion.id)) &&
      [expansion.residentHeight, expansion.thingHeight].every(Number.isFinite) &&
      expansion.residentHeight >= 0 && expansion.thingHeight >= 0 &&
      (expansion.residentHeight > 0 || expansion.thingHeight > 0))
    .sort((left, right) => {
      const leftRoom = roomById.get(String(left.id))!
      const rightRoom = roomById.get(String(right.id))!
      return leftRoom.y - rightRoom.y || leftRoom.x - rightRoom.x ||
        String(left.id).localeCompare(String(right.id))
    })
  for (const expansion of ordered) {
    const room = roomById.get(String(expansion.id))!
    const id = String(expansion.id)
    const regions = [...(regionsByRoom.get(id) || [])]
    for (const kind of ['resident', 'thing'] as const) {
      const requestedHeight = kind === 'resident'
        ? expansion.residentHeight
        : expansion.thingHeight
      const heldHeight = regions.filter(region => region.kind === kind)
        .reduce((sum, region) => sum + region.height, 0)
      const missingHeight = Math.max(0, requestedHeight - heldHeight)
      if (!missingHeight) continue
      let top = room.y + room.height + safeRailDepth + safeGap
      while (true) {
        const overlapping = obstacles.filter(obstacle =>
          room.x < obstacle.x + obstacle.width + safeGap &&
          room.x + safeGroundWidth + safeGap > obstacle.x &&
          top < obstacle.y + obstacle.height + safeGap &&
          top + missingHeight + safeGap > obstacle.y)
        if (!overlapping.length) break
        top = Math.max(...overlapping.map(obstacle =>
          obstacle.y + obstacle.height + safeGap))
      }
      const region = Object.freeze({
        kind,
        x: room.x,
        y: top,
        width: safeGroundWidth,
        height: missingHeight,
      })
      regions.push(region)
      obstacles.push(region)
    }
    if (regions.length) regionsByRoom.set(id, regions)
  }
  const grounds: Record<string, StageExpandedGround> = {}
  for (const [id, mutableRegions] of regionsByRoom) {
    const regions = Object.freeze(mutableRegions.map(region => Object.freeze({ ...region })))
    const residentRegions = regions.filter(region => region.kind === 'resident')
    const thingRegions = regions.filter(region => region.kind === 'thing')
    const left = Math.min(...regions.map(region => region.x))
    const right = Math.max(...regions.map(region => region.x + region.width))
    grounds[id] = Object.freeze({
      x: left,
      residentTop: residentRegions[0]?.y ?? null,
      thingTop: thingRegions[0]?.y ?? null,
      residentHeight: residentRegions.reduce((sum, region) => sum + region.height, 0),
      thingHeight: thingRegions.reduce((sum, region) => sum + region.height, 0),
      width: right - left,
      bottom: Math.max(...regions.map(region => region.y + region.height)),
      regions,
    })
  }
  return Object.freeze({
    grounds: Object.freeze(grounds),
    width: Math.max(0, ...fixed.map(area => area.x + area.width),
      ...Object.values(grounds).map(ground => ground.x + ground.width)),
    height: Math.max(0, ...fixed.map(area => area.y + area.height),
      ...Object.values(grounds).map(ground => ground.bottom)),
  })
}

export function stageBuildCorridorGraph(
  rooms: readonly StageRoomBox[],
): StageCorridorGraph {
  const validRooms = rooms.filter(room =>
    [room.x, room.y, room.width, room.height, room.door.x, room.door.y]
      .every(Number.isFinite) && room.width > 0 && room.height > 0)
    .sort((left, right) => left.door.y - right.door.y ||
      String(left.id).localeCompare(String(right.id)))
  const nodes: Record<string, StageCorridorNode> = {}
  const roomDoors: Record<string, string> = {}
  const edges: Array<Readonly<{ from: string; to: string; distance: number }>> = []
  const railX = validRooms.length ? Math.max(...validRooms.map(room => room.door.x)) - 40 : 0
  const corners: string[] = []
  for (const room of validRooms) {
    const roomId = String(room.id)
    const doorId = 'door:' + roomId
    const cornerId = 'corner:' + roomId
    nodes[doorId] = Object.freeze({
      id: doorId, kind: 'door', roomId, x: room.door.x, y: room.door.y,
    })
    nodes[cornerId] = Object.freeze({
      id: cornerId, kind: 'corner', roomId: null, x: railX, y: room.door.y,
    })
    roomDoors[roomId] = doorId
    corners.push(cornerId)
    edges.push(Object.freeze({
      from: doorId,
      to: cornerId,
      distance: Math.abs(room.door.x - railX),
    }))
  }
  for (let index = 1; index < corners.length; index += 1) {
    const from = nodes[corners[index - 1]!]
    const to = nodes[corners[index]!]
    if (!from || !to) continue
    edges.push(Object.freeze({ from: from.id, to: to.id, distance: Math.abs(to.y - from.y) }))
  }
  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    roomDoors: Object.freeze(roomDoors),
  })
}

export function stageShortestPath(
  graph: StageCorridorGraph,
  fromRoomId: string | number,
  toRoomId: string | number,
): readonly StageCorridorNode[] {
  const start = graph.roomDoors[String(fromRoomId)]
  const finish = graph.roomDoors[String(toRoomId)]
  if (!start || !finish || !graph.nodes[start] || !graph.nodes[finish]) return Object.freeze([])
  if (start === finish) return Object.freeze([graph.nodes[start]!])
  const neighbours = new Map<string, Array<Readonly<{ id: string; distance: number }>>>()
  for (const edge of graph.edges) {
    neighbours.set(edge.from, [...(neighbours.get(edge.from) || []),
      Object.freeze({ id: edge.to, distance: edge.distance })])
    neighbours.set(edge.to, [...(neighbours.get(edge.to) || []),
      Object.freeze({ id: edge.from, distance: edge.distance })])
  }
  const distance = new Map<string, number>([[start, 0]])
  const previous = new Map<string, string>()
  const remaining = new Set(Object.keys(graph.nodes))
  while (remaining.size) {
    const current = [...remaining].sort((left, right) =>
      (distance.get(left) ?? Number.POSITIVE_INFINITY) -
        (distance.get(right) ?? Number.POSITIVE_INFINITY) || left.localeCompare(right))[0]
    if (!current || !Number.isFinite(distance.get(current))) break
    remaining.delete(current)
    if (current === finish) break
    for (const neighbour of neighbours.get(current) || []) {
      if (!remaining.has(neighbour.id)) continue
      const nextDistance = distance.get(current)! + neighbour.distance
      const heldDistance = distance.get(neighbour.id) ?? Number.POSITIVE_INFINITY
      if (nextDistance < heldDistance ||
          (nextDistance === heldDistance && current < (previous.get(neighbour.id) || ''))) {
        distance.set(neighbour.id, nextDistance)
        previous.set(neighbour.id, current)
      }
    }
  }
  if (!previous.has(finish)) return Object.freeze([])
  const ids = [finish]
  while (ids[0] !== start) {
    const prior = previous.get(ids[0]!)
    if (!prior) return Object.freeze([])
    ids.unshift(prior)
  }
  return Object.freeze(ids.map(id => graph.nodes[id]!))
}

export function stageAttachedCorridorPath(
  graph: StageCorridorGraph,
  fromRoomId: string | number,
  fromPoint: Readonly<{ x: number; y: number }> | null,
  fromRegions: readonly StageGroundRect[],
  toRoomId: string | number,
  toPoint: Readonly<{ x: number; y: number }> | null,
  toRegions: readonly StageGroundRect[],
): readonly StageCorridorNode[] {
  let nodes: Readonly<Record<string, StageCorridorNode>> = graph.nodes
  let edges = graph.edges
  let roomDoors = graph.roomDoors
  const attach = (
    side: 'from' | 'to',
    roomId: string | number,
    point: Readonly<{ x: number; y: number }> | null,
    regions: readonly StageGroundRect[],
  ): string => {
    const roomKey = String(roomId)
    const roomDoorId = graph.roomDoors[roomKey]
    const roomDoor = roomDoorId ? graph.nodes[roomDoorId] : null
    if (!roomDoor || !point || ![point.x, point.y].every(Number.isFinite)) return roomKey
    const roomCorner = graph.edges.flatMap(edge => {
      if (edge.from === roomDoorId && graph.nodes[edge.to]?.kind === 'corner') {
        return [graph.nodes[edge.to]!]
      }
      if (edge.to === roomDoorId && graph.nodes[edge.from]?.kind === 'corner') {
        return [graph.nodes[edge.from]!]
      }
      return []
    })[0]
    if (!roomCorner) return roomKey
    const region = regions.find(area =>
      [area.x, area.y, area.width, area.height].every(Number.isFinite) &&
      area.width > 0 && area.height > 0 &&
      point.x >= area.x && point.x <= area.x + area.width &&
      point.y >= area.y && point.y <= area.y + area.height)
    if (!region) return roomKey
    const routeRoomId = '__stage_attachment_' + side + '__'
    const doorId = 'door:' + routeRoomId
    const cornerId = 'corner:' + routeRoomId
    const nearEdge = Math.abs(region.x - roomCorner.x) <=
      Math.abs(region.x + region.width - roomCorner.x)
      ? region.x
      : region.x + region.width
    const door = Object.freeze({
      id: doorId,
      kind: 'door' as const,
      roomId: roomKey,
      x: nearEdge,
      y: point.y,
    })
    const corner = Object.freeze({
      id: cornerId,
      kind: 'corner' as const,
      roomId: null,
      x: roomCorner.x,
      y: point.y,
    })
    nodes = Object.freeze({ ...nodes, [doorId]: door, [cornerId]: corner })
    edges = Object.freeze([...edges, Object.freeze({
      from: doorId,
      to: cornerId,
      distance: Math.abs(corner.x - door.x),
    })])
    roomDoors = Object.freeze({ ...roomDoors, [routeRoomId]: doorId })
    return routeRoomId
  }
  const fromRouteRoomId = attach('from', fromRoomId, fromPoint, fromRegions)
  const toRouteRoomId = attach('to', toRoomId, toPoint, toRegions)
  if (nodes === graph.nodes) return stageShortestPath(graph, fromRoomId, toRoomId)

  const doorEdges = edges.filter(edge =>
    nodes[edge.from]?.kind !== 'corner' || nodes[edge.to]?.kind !== 'corner')
  const corners = Object.values(nodes).filter(node => node.kind === 'corner')
    .sort((left, right) => left.y - right.y || left.x - right.x ||
      left.id.localeCompare(right.id))
  const railEdges = corners.slice(1).map((corner, index) => Object.freeze({
    from: corners[index]!.id,
    to: corner.id,
    distance: Math.hypot(
      corner.x - corners[index]!.x,
      corner.y - corners[index]!.y,
    ),
  }))
  return stageShortestPath(Object.freeze({
    nodes,
    edges: Object.freeze([...doorEdges, ...railEdges]),
    roomDoors,
  }), fromRouteRoomId, toRouteRoomId)
}

export function stageQuietRoom(
  place: Readonly<{
    name: string
    owner: string | null
    quiet: boolean
    counts: Readonly<{ residents: number; things: number }>
  }>,
  box: StageRoomBox,
): Readonly<{
  box: StageRoomBox
  name: string
  owner: string | null
  counts: Readonly<{ residents: number; things: number }>
  spots: readonly never[]
}> | null {
  if (place.quiet !== true || typeof place.name !== 'string' ||
      (place.owner !== null && typeof place.owner !== 'string') ||
      !Number.isSafeInteger(place.counts.residents) || place.counts.residents < 0 ||
      !Number.isSafeInteger(place.counts.things) || place.counts.things < 0) return null
  return Object.freeze({
    box,
    name: place.name,
    owner: place.owner,
    counts: Object.freeze({
      residents: place.counts.residents,
      things: place.counts.things,
    }),
    spots: Object.freeze([]),
  })
}
